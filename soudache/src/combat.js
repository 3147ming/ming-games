/**
 * 射击 / 命中判定 / 伤害结算
 *
 * 采用瞬时射线（hit-scan）而非子弹实体：开火瞬间沿射线做墙体步进 + 实体圆求交，
 * 命中即结算。表现层用枪口火光、弹道 tracer、弹壳、屏幕震动与飘字补足射击手感。
 */

import { COMBAT, CELL, VIEW3D } from './config.js';
import { cellAt, crateRectIndexAt, damageCrateRect, elevationAt } from './mapgen.js';

/**
 * 创建一个武器运行时状态。
 * @param {object} def 武器定义（WEAPONS 或敌人武器）
 * @returns {object} 武器状态
 */
export function createWeaponState(def) {
  return {
    def,
    ammo: def.magSize,
    cooldown: 0,
    reloading: false,
    reloadTimer: 0,
    reloadTotal: def.reloadTime,
    reloadAmount: 0,
    spread: 0,
  };
}

/**
 * 每帧推进武器状态（冷却、扩散回复、换弹）。
 * @param {number} dt 帧间隔秒
 * @param {object} entity 持有者
 * @param {object} world 战局上下文
 * @returns {void}
 */
export function updateWeapon(dt, entity, world) {
  const w = entity.currentWeapon;
  if (!w) return;
  w.cooldown = Math.max(0, w.cooldown - dt);
  w.spread = Math.max(0, w.spread - dt * 0.6);
  if (w.reloading) {
    w.reloadTimer -= dt;
    if (w.reloadTimer <= 0) {
      w.reloading = false;
      const amount = w.reloadAmount;
      w.reloadAmount = 0;
      if (entity.isPlayer && typeof entity.consumeReserve === 'function') {
        entity.consumeReserve(w.def.ammoItem, amount);
      }
      w.ammo = Math.min(w.def.magSize, w.ammo + amount);
      if (entity.isPlayer && world.audio) world.audio.reloadDone();
    }
  }
}

/**
 * 开始换弹。
 * @param {object} entity 持有者
 * @param {object} world 战局上下文
 * @returns {boolean} 是否开始换弹
 */
export function startReload(entity, world) {
  const w = entity.currentWeapon;
  if (!w || w.reloading || w.ammo >= w.def.magSize) return false;
  const need = w.def.magSize - w.ammo;
  const available = entity.isPlayer && typeof entity.reserveAmmo === 'function'
    ? entity.reserveAmmo(w.def.ammoItem)
    : need;
  if (available <= 0) {
    if (entity.isPlayer) {
      if (world.audio) world.audio.empty();
      if (world.toast) world.toast('没有备用弹药了');
    }
    return false;
  }
  w.reloading = true;
  w.reloadAmount = Math.min(need, available);
  w.reloadTimer = w.def.reloadTime;
  w.reloadTotal = w.def.reloadTime;
  if (entity.isPlayer && world.audio) world.audio.reload();
  return true;
}

/**
 * 射线与圆求交，返回最近正向交点距离。
 * @param {number} ox 射线起点 x
 * @param {number} oy 射线起点 y
 * @param {number} dx 单位方向 x
 * @param {number} dy 单位方向 y
 * @param {number} cx 圆心 x
 * @param {number} cy 圆心 y
 * @param {number} r 半径
 * @returns {number|null} 距离或 null
 */
export function rayCircle(ox, oy, dx, dy, cx, cy, r) {
  const mx = cx - ox;
  const my = cy - oy;
  const proj = mx * dx + my * dy;
  if (proj < 0) return null;
  const px = ox + dx * proj;
  const py = oy + dy * proj;
  const d2 = (cx - px) ** 2 + (cy - py) ** 2;
  if (d2 > r * r) return null;
  const back = Math.sqrt(r * r - d2);
  return Math.max(0, proj - back);
}

/**
 * 瞬时射线检测：先求墙体距离，再在射程内找最近的敌对实体。
 * @param {object} world 战局上下文
 * @param {object} shooter 射击者
 * @param {number} ox 起点 x
 * @param {number} oy 起点 y
 * @param {number} angle 射线角度
 * @param {number} maxDist 最大距离
 * @returns {{entity: object|null, x: number, y: number, dist: number, angle: number}} 命中结果
 */
export function hitscan(world, shooter, ox, oy, angle, maxDist) {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let limit = maxDist;
  const step = 10;
  const wdef = shooter.currentWeapon ? shooter.currentWeapon.def : null;
  const dmg = wdef ? wdef.damage : 20;
  for (let d = step; d <= maxDist; d += step) {
    const wx = ox + dx * d;
    const wy = oy + dy * d;
    const cell = cellAt(world.map, wx, wy);
    if (cell === CELL.WALL) {
      limit = d;
      break;
    }
    // 掩体箱：扣血；碎了子弹穿过继续飞，没碎则挡住子弹
    if (cell === CELL.CRATE) {
      const ri = crateRectIndexAt(world.map, wx, wy);
      if (ri < 0) {
        limit = d;
        break;
      }
      const res = damageCrateRect(world.map, ri, dmg);
      if (res.destroyed) {
        if (world.cratesBroken != null) world.cratesBroken += 1; // 爆破作业合约计数
        if (world.spawnImpact) world.spawnImpact(wx, wy, angle);
        if (world.audio) world.audio.crateBreak();
        continue; // 箱子已碎，子弹穿过
      }
      if (world.audio) world.audio.crateHit();
      limit = d;
      break;
    }
  }
  let bestDist = limit;
  let bestEntity = null;
  const candidates = shooter.isPlayer ? world.enemies : [world.player];
  for (const e of candidates) {
    if (!e || e.dead) continue;
    const t = rayCircle(ox, oy, dx, dy, e.x, e.y, e.radius + 4);
    if (t === null || t > bestDist) continue;
    if (t < bestDist || bestEntity === null) {
      bestDist = t;
      bestEntity = e;
    }
  }
  return {
    entity: bestEntity,
    x: ox + dx * bestDist,
    y: oy + dy * bestDist,
    dist: bestDist,
    angle,
  };
}

/**
 * 敌人（竖直圆柱）在场景中的总身高（米）。未知 typeId 回退到 patrol。
 * 体型 = 腿 + 躯干 + 2×头半径。
 * @param {string|undefined} typeId 敌人类型
 * @returns {number} 身高（米）
 */
function enemyTotalHeightM(typeId) {
  const d = VIEW3D.enemy[typeId] || VIEW3D.enemy.patrol;
  return d.legH + d.torsoH + d.headR * 2;
}

/**
 * 命中目标的竖直包围体总高（米）。敌人作为射击者时，候选目标是玩家；
 * 玩家没有 typeId，必须走专门的受击盒高度（不随蹲伏收缩），否则会得到 undefined。
 * @param {object} target 敌人或玩家实体
 * @returns {number} 竖直总高（米）
 */
function targetTotalHeightM(target) {
  if (target.isPlayer) return VIEW3D.playerHitboxH;
  return enemyTotalHeightM(target.typeId);
}

/**
 * 带俯仰（垂直感知）的瞬时射线检测。仅供「玩家射击」使用：
 * 从眼高沿准星方向（含俯仰）做射线，与敌人的竖直包围体 + 带高度的墙/箱求交。
 *
 * 关键不变式：pitch=0 且发射点与敌人同高程时，结果与旧 hitscan 逐位等价 —— 因为
 * 此时 D=(cos a, 0, sin a) 是单位向量，参数 s 同时就是水平距离，墙体步进采样点
 * (px,pz) 与旧代码 (wx,wy) 完全一致，敌人求交退化为平面上 rayCircle 的最近正向交点。
 *
 * @param {object} world 战局上下文
 * @param {object} shooter 射击者（玩家）
 * @param {{angle:number, pitch?:number, eyeY:number, maxDist:number, damage?:number}} opts
 *   angle: 水平朝向（弧度）；pitch: 俯仰（弧度，正为抬头）；eyeY: 眼睛高度的**场景单位**；
 *   maxDist: 最大射程（场景单位）；damage: 命中箱子时造成的伤害。
 * @returns {{entity: object|null, x: number, y: number, dist: number, height: number, angle: number}} 命中结果
 */
export function hitscan3D(world, shooter, opts) {
  const angle = opts.angle;
  const pitch = opts.pitch || 0;
  const eyeY = opts.eyeY;
  const maxDist = opts.maxDist;
  const dmg = opts.damage != null ? opts.damage : 20;

  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  // 单位方向向量：x = 水平分量, y = 高度轴, z = 水平分量（场景 z == 逻辑 y）
  const D = { x: dx * cp, y: sp, z: dy * cp };

  const muzzle = shooter.radius + 10;
  const ox = shooter.x + dx * muzzle;
  const oy = shooter.y + dy * muzzle;
  const Oy = eyeY;
  const wallTop = VIEW3D.wallHeight * VIEW3D.metersToUnits;
  const crateTop = VIEW3D.crateHeight * VIEW3D.metersToUnits;

  // 1) 墙体 / 掩体箱步进（与旧 hitscan 同构：d 从 10 到 maxDist，step=10）
  let limit = maxDist;
  const step = 10;
  for (let d = step; d <= maxDist; d += step) {
    const px = ox + D.x * d;
    const py = Oy + D.y * d;
    const pz = oy + D.z * d; // 逻辑 y 对应场景 z
    const cell = cellAt(world.map, px, pz);
    if (cell === CELL.WALL) {
      // 射线在墙顶之上则飞过去（pitch 抬到足够高时越过墙体）
      if (py < wallTop) {
        limit = d;
        break;
      }
    } else if (cell === CELL.CRATE) {
      // 射线在箱顶之上则飞过去
      if (py < crateTop) {
        const ri = crateRectIndexAt(world.map, px, pz);
        if (ri < 0) {
          limit = d;
          break;
        }
        const res = damageCrateRect(world.map, ri, dmg);
        if (res.destroyed) {
          if (world.cratesBroken != null) world.cratesBroken += 1; // 爆破作业合约计数
          if (world.spawnImpact) world.spawnImpact(px, pz, angle);
          if (world.audio) world.audio.crateBreak();
          continue; // 箱子已碎，子弹穿过
        }
        if (world.audio) world.audio.crateHit();
        limit = d;
        break;
      }
      // py >= crateTop：落在箱顶之上，继续飞（不被消耗）
    }
  }

  // 2) 敌人求交：解析式 射线 vs 竖直圆柱（避免步进漏检）
  let bestDist = limit;
  let bestEntity = null;
  const candidates = shooter.isPlayer ? world.enemies : [world.player];
  const xzLen = Math.abs(cp); // |D.xz| = |cos(pitch)|
  if (xzLen > 1e-6) {
    // XZ 平面归一化方向
    const ndX = D.x / xzLen;
    const ndZ = D.z / xzLen;
    for (const e of candidates) {
      if (!e || e.dead) continue;
      const baseY = VIEW3D.metersToUnits * elevationAt(world.map, e.x, e.y);
      const topY = baseY + VIEW3D.metersToUnits * targetTotalHeightM(e);
      const r = e.radius + 4; // 沿用旧 rayCircle 的 +4 余量
      // 标准射线-圆求交（XZ 平面，归一化方向）：返回 XZ 距离 tXZ
      const tXZ = rayCircle(ox, oy, ndX, ndZ, e.x, e.y, r);
      if (tXZ === null) continue;
      // 换算回射线参数 s：XZ 距离 = xzLen * s ⇒ s = tXZ / xzLen
      const s = tXZ / xzLen;
      if (s > bestDist) continue;
      // 校验该 s 处的射线高度是否落在敌人竖直包围体内
      const h = Oy + D.y * s;
      if (h >= baseY && h <= topY) {
        if (s < bestDist || bestEntity === null) {
          bestDist = s;
          bestEntity = e;
        }
      }
    }
  }

  return {
    entity: bestEntity,
    x: ox + D.x * bestDist,
    y: oy + D.z * bestDist,
    dist: bestDist,
    height: Oy + D.y * bestDist,
    angle,
  };
}

/**
 * 结算一次伤害（含护甲减伤与耐久损耗）。
 * @param {object} world 战局上下文
 * @param {object} target 目标
 * @param {number} raw 原始伤害
 * @param {object} source 伤害来源
 * @param {number} hx 命中点 x
 * @param {number} hy 命中点 y
 * @param {number} [hitHeight] 命中点的真实场景高度（场景单位）。由 3D 命中路径
 *   （hitscan3D）产生；旧式水平命中（敌人 AI 打玩家）不传，渲染层据此回退到固定高度。
 * @returns {number} 实际造成的伤害
 */
export function applyDamage(world, target, raw, source, hx, hy, hitHeight) {
  if (!target || target.dead) return 0;
  const armor = Math.max(0, target.armor || 0);
  const mitigation = armor / (armor + COMBAT.armorK);
  const dmg = Math.max(1, raw * (1 - mitigation));
  target.armor = Math.max(0, armor - raw * COMBAT.armorDurabilityLoss);
  target.hp -= dmg;
  target.hurtFlash = 0.25;
  const px = typeof hx === 'number' ? hx : target.x;
  const py = typeof hy === 'number' ? hy : target.y;
  const angle = Math.atan2(py - (source ? source.y : py - 1), px - (source ? source.x : px));
  if (world.spawnBlood) world.spawnBlood(px, py, angle, target.isPlayer ? 5 : COMBAT.bloodPerHit, hitHeight);
  if (world.addDamageNumber) {
    world.addDamageNumber(px, py, Math.round(dmg), target.isPlayer ? '#ff5c5c' : '#ffd166', hitHeight);
  }
  if (world.audio) {
    if (target.isPlayer) world.audio.hurt();
    else world.audio.hit();
  }
  if (typeof target.onDamaged === 'function') target.onDamaged(source, world);
  if (target.hp <= 0) {
    target.hp = 0;
    target.dead = true;
    // 击杀信息流：此处同时持有 target 与 source，是推流的唯一正确位置。
    // 放在 onDeath 之前：onDeath 对玩家直接 return，玩家阵亡同样要进信息流。
    if (world.addKill) world.addKill(target, source);
    if (world.onDeath) world.onDeath(target, source);
  }
  return dmg;
}

/**
 * 开火。会处理冷却、弹药、扩散、后坐力、射线命中与全部表现层效果。
 * @param {object} world 战局上下文
 * @param {object} shooter 射击者（Player 或 Enemy）
 * @param {object} opts 可选参数 { accuracy: 0~1 }
 * @returns {{fired: boolean, reason?: string, entity?: object|null, x?: number, y?: number}} 结果
 */
/**
 * 轻度辅助瞄准（仅玩家、仅偏航轴）：在瞄准锥内找「离准星最近」的敌人，
 * 把**这一发**的偏航角小幅拉向它。只改当发方向，不修改 shooter.angle（否则角色会自己漂移）。
 * 偏航是主瞄准轴；俯仰不吸附加，保持「轻度」——避免变成全自动锁头，破坏搜打撤的瞄准博弈。
 *
 * @param {object} world 战局上下文
 * @param {object} shooter 射击者（玩家）
 * @param {number} baseAngle 当前偏航角（弧度）
 * @param {{coneDeg:number, strength:number}} cfg 配置：锥角(度) / 吸附强度(0~1)
 * @returns {number} 调整后的偏航角（弧度）
 */
export function applyAimAssist(world, shooter, baseAngle, cfg) {
  const cone = (cfg.coneDeg * Math.PI) / 180;
  let best = null;
  let bestAbs = Infinity;
  for (const e of world.enemies || []) {
    if (e.dead) continue;
    const dx = e.x - shooter.x;
    const dy = e.y - shooter.y;
    const bearing = Math.atan2(dy, dx);
    let diff = bearing - baseAngle;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    const ad = Math.abs(diff);
    // 锥内且最接近准星者优先（角度差最小 = 最该吸的那一个）
    if (ad <= cone && ad < bestAbs) {
      bestAbs = ad;
      best = diff;
    }
  }
  if (best === null) return baseAngle;
  return baseAngle + best * cfg.strength;
}

export function fireWeapon(world, shooter, opts = {}) {
  const w = shooter.currentWeapon;
  if (!w || shooter.dead) return { fired: false, reason: 'unavailable' };
  if (w.reloading || w.cooldown > 0 || shooter.fireLocked) return { fired: false, reason: 'not-ready' };
  const def = w.def;
  if (w.ammo <= 0) {
    w.cooldown = 0.35;
    // 玩家也自动换弹：玩家反馈"不要非要我自己换弹"。
    // 空匣后再按开火会自动开始换弹（有备用弹药时），符合手游习惯。
    if (shooter.isPlayer) {
      if (world.audio) world.audio.empty();
      startReload(shooter, world);
    } else if (world.audio) {
      world.audio.empty(0.25);
      startReload(shooter, world);
    }
    return { fired: false, reason: 'empty' };
  }

  w.ammo -= 1;
  w.cooldown = 60 / def.rpm;

  const spreadNow = Math.min(def.spreadMax, def.spread + w.spread);
  w.spread = Math.min(def.spreadMax, w.spread + def.spreadPerShot);
  const accuracyPenalty = opts.accuracy != null ? (1 - Math.max(0, Math.min(1, opts.accuracy))) * 0.38 : 0;
  const jitter = world.rng.float(-1, 1) * (spreadNow + accuracyPenalty);
  let angle = shooter.angle + jitter + (shooter.recoilOffset || 0);
  shooter.recoilOffset = (shooter.recoilOffset || 0) + def.recoil * world.rng.float(-1, 1);
  // 轻度辅助瞄准：把这一发的偏航角小幅拉向瞄准锥内最近的敌人（只改当发，不动 shooter.angle）
  if (shooter.isPlayer && COMBAT.aimAssist && COMBAT.aimAssist.enabled) {
    const adjusted = applyAimAssist(world, shooter, angle, COMBAT.aimAssist);
    if (Number.isFinite(adjusted)) angle = adjusted;
  }
  shooter.muzzleFlash = 0.06;

  const muzzle = shooter.radius + 10;
  const ox = shooter.x + Math.cos(shooter.angle) * muzzle;
  const oy = shooter.y + Math.sin(shooter.angle) * muzzle;

  let shot;
  let eyeY = 0; // 眼高（场景单位）：玩家/敌人分支各自计算，供曳光弹 h1 复用
  if (shooter.isPlayer) {
    // 关键：在「加入本次抬枪」之前快照俯仰，否则第一发就会被自己的 recoilPitch 抬高而偏高。
    const aimPitch = (shooter.pitch || 0) + (shooter.recoilPitch || 0);
    // 开火抬枪（aim punch）：仅抬俯仰不改 yaw —— 视觉后坐，不影响水平朝向。
    shooter.recoilPitch = Math.min(
      COMBAT.recoilPitchMax,
      (shooter.recoilPitch || 0) + def.recoil * COMBAT.recoilPitchMul,
    );
    eyeY = VIEW3D.metersToUnits * (
      (shooter.crouching ? VIEW3D.eyeCrouch : VIEW3D.eyeStand) + (shooter.elevation || 0)
    );
    // 竖直散布：比水平散布小，且以准星为中心（不影响 yaw）。
    const jitterV = world.rng.float(-1, 1) * (spreadNow + accuracyPenalty) * 0.6;
    const pitch = aimPitch + jitterV;
    shot = hitscan3D(world, shooter, { angle, pitch, eyeY, maxDist: def.range, damage: def.damage });
  } else {
    // 敌人 AI 打玩家：与玩家同源走 hitscan3D（竖直感知），正确命中高地/低地的玩家。
    // 敌人无 .elevation 字段，眼高由所在格高程 + 站立眼高推导；并俯仰瞄准玩家身体中心，
    // 使「高台上的敌人打地面玩家」「地面的敌人打高台玩家」都成立。
    // 关键：hitscan3D 的 XZ 投影与 pitch 无关（D.x·s = cos(angle)·tXZ），所以俯仰瞄准
    // 只改变命中高度、不改变水平落点——水平玩法与旧 2D 路径逐位等价。
    const groundElev = world.map ? elevationAt(world.map, shooter.x, shooter.y) : 0;
    eyeY = VIEW3D.metersToUnits * (groundElev + VIEW3D.eyeStand);
    let pitch = 0;
    const tgt = world.player;
    if (tgt && !tgt.dead) {
      const tBaseY = VIEW3D.metersToUnits * (world.map ? elevationAt(world.map, tgt.x, tgt.y) : 0);
      const tCenterY = tBaseY + VIEW3D.metersToUnits * VIEW3D.playerCenterM;
      const horiz = Math.max(1, Math.hypot(tgt.x - shooter.x, tgt.y - shooter.y));
      pitch = Math.atan2(tCenterY - eyeY, horiz);
    }
    // 竖直散布：与玩家对称，比水平散布小，以玩家身体中心为基准
    const jitterV = world.rng.float(-1, 1) * (spreadNow + accuracyPenalty) * 0.6;
    pitch += jitterV;
    shot = hitscan3D(world, shooter, { angle, pitch, eyeY, maxDist: def.range, damage: def.damage });
  }

  if (world.tracers) {
    world.tracers.push({
      x1: ox, y1: oy, x2: shot.x, y2: shot.y, t: 0, life: COMBAT.tracerLife,
      color: shooter.isPlayer ? '#ffd9a0' : '#ff9a6a',
      player: shooter.isPlayer, // 玩家自己的曳光弹从枪口世界坐标发出，与准星对齐
      // 命中真实高度（敌我同源）：曳光弹精确落在弹着点。敌人弹道起点高度取枪口眼高 h1。
      h: shot.height,
      h1: shooter.isPlayer ? undefined : eyeY,
    });
  }
  if (world.shells) {
    const side = shooter.angle + Math.PI / 2;
    world.shells.push({
      x: ox, y: oy,
      vx: Math.cos(side) * world.rng.float(30, 70) + Math.cos(shooter.angle) * -20,
      vy: Math.sin(side) * world.rng.float(30, 70) + Math.sin(shooter.angle) * -20,
      rot: world.rng.float(0, Math.PI * 2),
      vr: world.rng.float(-12, 12),
      t: 0, life: COMBAT.shellLife,
    });
  }
  if (world.emitNoise) world.emitNoise(shooter.x, shooter.y, def.noiseRadius, shooter.faction);
  if (world.audio) {
    const distToPlayer = Math.hypot(shooter.x - world.player.x, shooter.y - world.player.y);
    const vol = shooter.isPlayer ? 1 : Math.max(0, 1 - distToPlayer / 900);
    world.audio.shot(def.id, vol);
  }
  if (world.shakeCamera) {
    world.shakeCamera(shooter.isPlayer ? COMBAT.playerShake : 1.1 * Math.max(0, 1 - Math.hypot(shooter.x - world.player.x, shooter.y - world.player.y) / 900));
  }

  if (shot.entity) {
    applyDamage(world, shot.entity, def.damage, shooter, shot.x, shot.y, shot.height);
  } else if (world.spawnSpark) {
    // 子弹打在硬表面（墙 / 箱）→ 溅起跳弹火花
    world.spawnSpark(shot.x, shot.y, angle, shot.height);
  }

  return { fired: true, entity: shot.entity, x: shot.x, y: shot.y, dist: shot.dist, height: shot.height };
}
