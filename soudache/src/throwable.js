/**
 * 战术投掷物（P5-C1）：破片 / 烟幕 / 震撼 / 燃烧。
 *
 * 设计约束：
 * 1. **不消耗 world.rng**。那条流同时喂给敌人 AI、散布与掉落；投掷物多抽一次，
 *    同 seed 的整局行为就会漂移。这里所有"随机感"都来自位置与时间的确定性函数。
 * 2. 物理与效果都是纯函数 + 一个显式的 update 入口，node 里能直接用假世界单测。
 * 3. 效果不伪造：烟幕真的进 enemy.canSee 的视线判定，震撼真的冻结敌人的状态机，
 *    燃烧真的按秒结算伤害 —— 三条都要能被探针在真浏览器里读到读数。
 */

import {
  THROWABLE, ABILITY, VIEW3D, CELL,
} from './config.js';
import { elevationAt, solidAt, wallHeightAt } from './mapgen.js';
import { applyDamage } from './combat.js';

const U = VIEW3D.metersToUnits;

/**
 * 四种投掷物的静态档案。数值单位一律是**米 / 秒**，进入世界前才乘 U。
 *
 * `trigger` 决定引信语义：
 * - `fuse`：出手后固定秒数引爆（破片、震撼）
 * - `land`：落地即生效（烟幕、燃烧），没有"捏着等两秒"的操作空间
 */
export const THROWABLE_TYPES = {
  frag: {
    id: 'frag',
    name: '破片手雷',
    short: 'FRAG',
    trigger: 'fuse',
    fuse: 2.2,
    radius: 6.5,
    damage: 100,
    selfMul: 0.35,
    maxBounce: 1,
    color: '#FF6A3D',
    hudColor: '#E2574C',
  },
  smoke: {
    id: 'smoke',
    name: '烟幕弹',
    short: 'SMK',
    trigger: 'land',
    fuse: 0.35,
    radius: 4.8,
    duration: 13,
    expand: 1.2,
    maxBounce: 2,
    color: '#9FB4C8',
    hudColor: '#4FB3C8',
  },
  flash: {
    id: 'flash',
    name: '震撼弹',
    short: 'FLS',
    trigger: 'fuse',
    fuse: 1.5,
    radius: 8,
    stun: 3.5,
    maxBounce: 2,
    color: '#FFE9A8',
    hudColor: '#5DCAA5',
  },
  incendiary: {
    id: 'incendiary',
    name: '燃烧弹',
    short: 'INC',
    trigger: 'land',
    fuse: 0.25,
    radius: 4.5,
    duration: 8,
    dps: 16,
    maxBounce: 1,
    color: '#FF9B3D',
    hudColor: '#D9822B',
  },
};

/** 未知类型的兜底，避免手改存档导致开局崩。 */
export const DEFAULT_THROWABLE = 'frag';

/**
 * 取投掷物定义。
 * @param {string} id 类型 id
 * @returns {object} 定义
 */
export function throwableDef(id) {
  return THROWABLE_TYPES[id] || THROWABLE_TYPES[DEFAULT_THROWABLE];
}

/**
 * 出手点：眼睛前方 0.35 米、略高于眼高。
 * @param {object} player 玩家
 * @returns {{x:number, y:number, h:number}} 出手点（逻辑单位 / 世界高度）
 */
export function throwOrigin(player) {
  const a = player.yaw || 0;
  const reach = U * 0.35;
  return {
    x: player.x + Math.cos(a) * reach,
    y: player.y + Math.sin(a) * reach,
    h: U * (VIEW3D.eyeStand + 0.05),
  };
}

/**
 * 创建一枚在飞的投掷物。
 *
 * 速度按俯仰分解：抬头扔得远，低头扔在脚下。相机 pitch 同时驱动弹道，
 * 与子弹共用一套"准星指哪打哪"的直觉，不需要额外学一套抛物线预瞄。
 *
 * @param {string} typeId 类型
 * @param {number} x 出手 x
 * @param {number} y 出手 y
 * @param {number} h 出手高度
 * @param {number} yaw 水平朝向（弧度）
 * @param {number} pitch 俯仰（弧度，正为抬头）
 * @returns {object} 投掷物实例
 */
export function createGrenade(typeId, x, y, h, yaw, pitch) {
  const def = throwableDef(typeId);
  const speed = THROWABLE.speed * U;
  const cp = Math.cos(pitch || 0);
  const sp = Math.sin(pitch || 0);
  return {
    kind: def.id,
    x, y, h,
    vx: Math.cos(yaw) * speed * cp,
    vy: Math.sin(yaw) * speed * cp,
    vh: sp * speed + U * 0.6, // 一点上抛补偿，避免平视时直接砸在脚面
    fuse: def.fuse,
    landed: false,
    bounces: 0,
    t: 0,
    dead: false,
    // 渲染用：旋转相位与"已起烟/已引燃"标记
    spin: 0,
    armed: false,
  };
}

/**
 * 推进一帧物理。返回是否刚刚落地（供音效触发，不重复播）。
 * @param {object} g 投掷物
 * @param {number} dt 步长（秒）
 * @param {object} map 地图
 * @param {object} def 类型定义
 * @returns {boolean} 本帧是否刚落地
 */
export function stepGrenade(g, dt, map, def) {
  g.t += dt;
  // 引信类在出手瞬间就开始走；落地类必须落地后才开始走，
  // 否则一枚被扔到高处的烟弹会在空中"提前起烟"。
  if (def.trigger === 'fuse' || g.landed) g.fuse -= dt;
  g.spin += dt * 12;
  if (g.landed) {
    // 落地后的短距离滑行：摩擦在两个轴上各自衰减，滑到很慢就完全停住
    const damp = Math.exp(-6 * dt);
    g.vx *= damp;
    g.vy *= damp;
    const nx = g.x + g.vx * dt;
    const ny = g.y + g.vy * dt;
    if (!solidAt(map, nx, ny)) { g.x = nx; g.y = ny; }
    else { g.vx = 0; g.vy = 0; }
    return false;
  }

  g.vh -= THROWABLE.gravity * U * dt;
  let nx = g.x + g.vx * dt;
  let ny = g.y + g.vy * dt;
  let nh = g.h + g.vh * dt;
  // 逐格墙高：楼有 1~3 层，手雷不能穿楼而过得按落点那面墙的高度判
  const wallTop = wallHeightAt(map, nx, ny) * U;

  // 墙面反弹：按轴分离探测，才能判断是撞到 x 向的墙还是 y 向的墙
  if (nh < wallTop && solidAt(map, nx, ny)) {
    const hitX = solidAt(map, nx, g.y);
    const hitY = solidAt(map, g.x, ny);
    if (g.bounces < def.maxBounce) {
      const k = THROWABLE.bounce;
      if (hitX && !hitY) { g.vx = -g.vx * k; ny = g.y + g.vy * dt; }
      else if (hitY && !hitX) { g.vy = -g.vy * k; nx = g.x + g.vx * dt; }
      else { g.vx = -g.vx * k; g.vy = -g.vy * k; }
      g.bounces += 1;
      g.vh *= 0.8;
    } else {
      g.vx = 0; g.vy = 0;
      nx = g.x; ny = g.y;
    }
  }

  const ground = elevationAt(map, nx, ny) * U;
  if (nh <= ground) {
    nh = ground;
    if (Math.abs(g.vh) > U * 2.2 && g.bounces < def.maxBounce) {
      g.vh = -g.vh * THROWABLE.bounce;
      g.bounces += 1;
      g.vx *= 0.7; g.vy *= 0.7;
    } else {
      g.vh = 0;
      g.landed = true;
      g.vx *= 0.35; g.vy *= 0.35;
      g.x = nx; g.y = ny; g.h = nh;
      return true;
    }
  }
  g.x = nx; g.y = ny; g.h = nh;
  return false;
}

/**
 * 爆炸距离衰减：中心 1，边缘 0，幂次让"贴身"与"擦边"的差距更明显。
 * @param {number} dist 距离（米）
 * @param {number} radius 半径（米）
 * @returns {number} 0~1
 */
export function blastAttenuation(dist, radius) {
  if (!(radius > 0)) return 0;
  if (dist <= 0) return 1;
  if (dist >= radius) return 0;
  return Math.pow(1 - dist / radius, 0.85);
}

/**
 * 点到线段的最短距离（纯几何，2D）。
 * @param {number} px 点 x
 * @param {number} py 点 y
 * @param {number} x1 线段起点 x
 * @param {number} y1 线段起点 y
 * @param {number} x2 线段终点 x
 * @param {number} y2 线段终点 y
 * @returns {number} 距离
 */
export function pointSegmentDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 1e-6) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + dx * t), py - (y1 + dy * t));
}

/**
 * 视线是否被烟幕切断。
 *
 * 判据是"视线段与烟球相交"，而不是"目标在烟里"：站在烟后、烟里的人看不见外面，
 * 站在烟里的人也被烟包住 —— 这才符合玩家对烟幕的直觉。
 * 极近距离（< 0.6 米）不遮，避免贴脸时被自己的烟完全致盲。
 *
 * @param {Array} smokes 烟幕列表 [{x,y,r}]
 * @param {number} x1 起点 x
 * @param {number} y1 起点 y
 * @param {number} x2 终点 x
 * @param {number} y2 终点 y
 * @returns {boolean} 是否被遮挡
 */
export function smokeBlocks(smokes, x1, y1, x2, y2) {
  if (!smokes || !smokes.length) return false;
  if (Math.hypot(x2 - x1, y2 - y1) < U * 0.6) return false;
  for (const s of smokes) {
    if (pointSegmentDist(s.x, s.y, x1, y1, x2, y2) <= s.r) return true;
  }
  return false;
}

/**
 * 区域伤害的每帧结算：站在火里才扣血，走出去立刻停。
 * 用 `zone.acc` 累积小数伤害，避免每帧取整导致 60fps 下伤害被吃掉。
 * @param {object} world 世界
 * @param {object} zone 区域
 * @param {number} dt 步长
 * @returns {void}
 */
function tickZone(world, zone, dt) {
  if (zone.kind !== 'fire') return;
  const r = zone.r;
  const victims = [];
  for (const e of world.enemies || []) {
    if (e.dead) continue;
    if (Math.hypot(e.x - zone.x, e.y - zone.y) <= r) victims.push(e);
  }
  const p = world.player;
  const playerIn = p && !p.dead && Math.hypot(p.x - zone.x, p.y - zone.y) <= r;
  if (!victims.length && !playerIn) { zone.acc = 0; return; }
  zone.acc = (zone.acc || 0) + zone.dps * dt;
  const dmg = Math.floor(zone.acc);
  if (dmg <= 0) return;
  zone.acc -= dmg;
  const src = { x: zone.x, y: zone.y, isPlayer: true, faction: 'player' };
  for (const e of victims) {
    applyDamage(world, e, dmg, src, e.x, e.y, U * 1.0);
    if (world.onPlayerHit) world.onPlayerHit(e, dmg, 'fire');
  }
  if (playerIn && zone.owner !== 'player-safe') {
    // 自己站火里也烧（0.6 倍），但不触发"被击中"的方向提示
    applyDamage(world, p, dmg * 0.6, src, p.x, p.y, U * 1.0);
  }
}

/**
 * 引爆一枚投掷物，生成对应的世界效果。
 * @param {object} world 世界
 * @param {object} g 投掷物
 * @param {object} def 类型定义
 * @returns {void}
 */
function detonate(world, g, def) {
  const rUnits = def.radius * U;
  if (def.id === 'frag') {
    const src = { x: g.x, y: g.y, isPlayer: true, faction: 'player' };
    for (const e of world.enemies || []) {
      if (e.dead) continue;
      const d = Math.hypot(e.x - g.x, e.y - g.y);
      const atten = blastAttenuation(d, rUnits);
      if (atten <= 0) continue;
      if (!hasBlastLine(world.map, g, e)) continue;
      const dealt = applyDamage(world, e, def.damage * atten, src, e.x, e.y, U * 1.0);
      if (world.onPlayerHit) world.onPlayerHit(e, dealt, 'frag');
    }
    const p = world.player;
    if (p && !p.dead) {
      const d = Math.hypot(p.x - g.x, p.y - g.y);
      const atten = blastAttenuation(d, rUnits);
      if (atten > 0 && hasBlastLine(world.map, g, p)) {
        applyDamage(world, p, def.damage * atten * def.selfMul, src, p.x, p.y, U * 1.0);
      }
    }
    if (world.shakeCamera) world.shakeCamera(1.6 * blastAttenuation(
      Math.hypot((world.player.x || 0) - g.x, (world.player.y || 0) - g.y), rUnits * 2.2,
    ) + 0.15);
    if (world.audio) world.audio.explosion(blastDistanceToPlayer(world, g));
    if (world.spawnExplosion) world.spawnExplosion(g.x, g.y, g.h, def.radius, def.color);
  } else if (def.id === 'smoke') {
    world.smokes.push({
      x: g.x, y: g.y, r: 0, maxR: rUnits, h: g.h,
      t: 0, life: def.duration, expand: def.expand, kind: 'smoke',
    });
    if (world.audio) world.audio.smokePop(blastDistanceToPlayer(world, g));
    if (world.spawnExplosion) world.spawnExplosion(g.x, g.y, g.h, def.radius * 0.6, def.color, true);
  } else if (def.id === 'flash') {
    const src = { x: g.x, y: g.y, isPlayer: true, faction: 'player' };
    for (const e of world.enemies || []) {
      if (e.dead) continue;
      const d = Math.hypot(e.x - g.x, e.y - g.y);
      const atten = blastAttenuation(d, rUnits);
      if (atten <= 0) continue;
      if (!hasBlastLine(world.map, g, e)) continue;
      e.stun = Math.max(e.stun || 0, def.stun * (0.45 + 0.55 * atten));
      e.fireLocked = true;
      // 被闪的敌人丢失目标、转入搜索（字面量与 EnemyState.SEARCH 一致，
      // 直接 import EnemyState 会让 enemy→combat→throwable 形成环）
      if (e.setState && e.state === 'COMBAT') e.setState('SEARCH');
    }
    const p = world.player;
    if (p && !p.dead) {
      const d = Math.hypot(p.x - g.x, p.y - g.y);
      const atten = blastAttenuation(d, rUnits);
      if (atten > 0 && hasBlastLine(world.map, g, p) && facingBlast(p, g, atten)) {
        world.flashT = ABILITY.flashScreen * (0.5 + 0.5 * atten);
        if (world.audio) world.audio.flashPop(0.1);
      }
    } else if (world.audio) {
      world.audio.flashPop(blastDistanceToPlayer(world, g));
    }
    if (world.spawnExplosion) world.spawnExplosion(g.x, g.y, g.h, def.radius * 0.8, '#FFF6D0', true);
    void src;
  } else if (def.id === 'incendiary') {
    world.zones.push({
      x: g.x, y: g.y, r: rUnits, dps: def.dps,
      t: 0, life: def.duration, kind: 'fire', acc: 0,
    });
    if (world.audio) world.audio.combust(blastDistanceToPlayer(world, g));
    if (world.spawnExplosion) world.spawnExplosion(g.x, g.y, g.h, def.radius, '#FF7A2F', true);
  }
}

/**
 * 爆点到玩家的距离（米），用于音量衰减。
 * @param {object} world 世界
 * @param {object} g 投掷物
 * @returns {number} 米
 */
function blastDistanceToPlayer(world, g) {
  const p = world.player;
  if (!p) return 99;
  return Math.hypot(p.x - g.x, p.y - g.y) / U;
}

/**
 * 爆炸是否被墙挡住。掩体箱不挡（半身掩体挡不住破片）。
 * @param {object} map 地图
 * @param {object} g 投掷物
 * @param {object} target 目标
 * @returns {boolean} 是否直达
 */
function hasBlastLine(map, g, target) {
  const dx = target.x - g.x;
  const dy = target.y - g.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return true;
  const steps = Math.ceil(dist / (map.tile * 0.4));
  for (let i = 1; i < steps; i += 1) {
    const t = i / steps;
    const x = g.x + dx * t;
    const y = g.y + dy * t;
    const tx = Math.floor(x / map.tile);
    const ty = Math.floor(y / map.tile);
    if (tx < 0 || ty < 0 || tx >= map.cols || ty >= map.rows) return false;
    // 只被墙挡：crate 是半身掩体，破片照样过顶
    if (map.grid[ty * map.cols + tx] === CELL.WALL) return false;
  }
  return true;
}

/**
 * 玩家是否面向爆点（决定要不要白屏）。
 * @param {object} p 玩家
 * @param {object} g 投掷物
 * @param {number} atten 衰减
 * @returns {boolean} 是否被闪到
 */
function facingBlast(p, g, atten) {
  const toBlast = Math.atan2(g.y - p.y, g.x - p.x);
  let off = toBlast - (p.yaw || 0);
  while (off > Math.PI) off -= Math.PI * 2;
  while (off < -Math.PI) off += Math.PI * 2;
  return Math.abs(off) < Math.PI * (0.35 + 0.25 * atten);
}

/**
 * 每帧推进全部投掷物、烟幕与燃烧区。
 *
 * 顺序很关键：先推进飞行（可能引爆），再结算区域伤害，最后清理过期对象。
 * 这样"这一帧刚落地的燃烧弹"在同一帧就开始烧，玩家不会看到 1 帧的空档。
 *
 * @param {object} world 世界
 * @param {number} dt 步长（秒）
 * @param {Array} events 可选：收集本帧事件（探针 / 音效用）
 * @returns {void}
 */
export function updateThrowables(world, dt, events) {
  const map = world.map;
  const list = world.grenades || (world.grenades = []);

  for (let i = list.length - 1; i >= 0; i -= 1) {
    const g = list[i];
    if (g.dead) { list.splice(i, 1); continue; }
    const def = throwableDef(g.kind);
    const justLanded = stepGrenade(g, dt, map, def);
    if (justLanded && world.audio && world.audio.grenadeLand) {
      world.audio.grenadeLand(blastDistanceToPlayer(world, g));
    }
    if (g.fuse <= 0) {
      detonate(world, g, def);
      g.dead = true;
      list.splice(i, 1);
      if (events) events.push({ type: 'detonate', kind: g.kind, x: g.x, y: g.y });
    }
  }

  // 烟幕：先膨胀再维持，末段 1.5s 收缩淡出
  for (let i = (world.smokes || []).length - 1; i >= 0; i -= 1) {
    const s = world.smokes[i];
    s.t += dt;
    const grow = Math.min(1, s.t / Math.max(0.01, s.expand));
    const fade = Math.min(1, Math.max(0, (s.life - s.t) / 1.5));
    s.r = s.maxR * Math.min(grow, fade);
    if (s.t >= s.life) world.smokes.splice(i, 1);
  }

  // 燃烧区：按秒结算
  for (let i = (world.zones || []).length - 1; i >= 0; i -= 1) {
    const z = world.zones[i];
    z.t += dt;
    tickZone(world, z, dt);
    if (z.t >= z.life) world.zones.splice(i, 1);
  }
}

/**
 * 给 HUD / 探针用的只读快照：当前有几团烟、几片火、几枚在飞。
 * @param {object} world 世界
 * @returns {{grenades:number, smokes:number, fires:number, smokeR:number}} 快照
 */
export function throwableSnapshot(world) {
  const smokes = world.smokes || [];
  return {
    grenades: (world.grenades || []).length,
    smokes: smokes.length,
    fires: (world.zones || []).filter((z) => z.kind === 'fire').length,
    smokeR: smokes.length ? Math.max(...smokes.map((s) => s.r)) : 0,
  };
}
