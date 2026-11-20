/**
 * 射击 / 命中判定 / 伤害结算
 *
 * 采用瞬时射线（hit-scan）而非子弹实体：开火瞬间沿射线做墙体步进 + 实体圆求交，
 * 命中即结算。表现层用枪口火光、弹道 tracer、弹壳、屏幕震动与飘字补足射击手感。
 */

import { COMBAT, AI, PLAYER, CELL, VIEW3D, HITDIR, RECOIL, ITEMS } from './config.js';
import { recoilStep, spreadAt } from './recoil.js';
import { reloadDuration, reloadProgress, reloadStage } from './reload.js';
import { cellAt, crateRectIndexAt, damageCrateRect, elevationAt } from './mapgen.js';
import {
  armorMitigation, helmetMitigation, zoneFromHeight, zoneMultiplier,
  armorDurabilityLoss, helmetDurabilityLoss, armorWasHit,
  armorMitigationDiscrete, helmetMitigationDiscrete, armorDamageSplit,
} from './ballistics.js';
import { bossDamageMul, isWeakspot, checkArmorBreak } from './boss.js';
// P19：开火闸门与动作状态同源（切枪/抬枪/换弹任一未完成都打不出子弹）。
import { canFire } from './combatstate.js';
// P22：玩家压制（与 AI 压制分开：那套服务敌方决策，这套服务玩家感受）。
import { addPlayerSuppression, suppressionSpreadMul } from './suppression.js';

/**
 * 创建一个武器运行时状态。
 * @param {object} def 武器定义（WEAPONS 或敌人武器）
 * @returns {object} 武器状态
 */
export function createWeaponState(def) {
  return {
    def,
    ammo: def.magSize,
    // P7：弹匣里装的是哪一型弹。玩家由战前配置写入，敌人沿用武器自带的标准弹。
    ammoId: def.ammoItem || null,
    cooldown: 0,
    reloading: false,
    reloadTimer: 0,
    reloadTotal: def.reloadTime,
    reloadAmount: 0,
    // P4-C3：换弹已播报到哪一段（'mag-out'/'mag-in'/'charge'）。用于在跨界的那一帧
    // 触发对应机械音，而不是开局一口气把三段音效全塞出去。
    reloadStage: '',
    spread: 0,
    // P4 枪感：弹道序号（本轮扫射的第几发）与"距上一发经过多久"。
    // sinceShot 初始给大值，保证第一次开火一定从曲线第一发起算。
    aimIndex: 0,
    sinceShot: 99,
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
  // P4-C2：扩散恢复速率按武器给（收枪时也要快），不再用全局 0.6/s 的"发黏"手感。
  w.spread = Math.max(0, w.spread - dt * (w.def.spreadRecover ?? COMBAT.spreadRecover));
  // 停火计时：弹道序号在 fireWeapon 里按「距上一发多久」决定是否归零
  w.sinceShot = Math.min(99, (w.sinceShot || 0) + dt);
  if (w.reloading) {
    w.reloadTimer -= dt;
    // P4-C3：换弹分三段推进。每跨过一个段边界播一次对应机械音，
    // 让 2~3 秒的换弹过程在听觉上也有"弹匣落 → 弹匣入 → 拉机柄"的节奏。
    const stage = reloadStage(reloadProgress(w.reloadTimer, w.reloadTotal));
    if (stage.key !== w.reloadStage) {
      w.reloadStage = stage.key;
      if (entity.isPlayer && world.audio && typeof world.audio.reloadStage === 'function') {
        world.audio.reloadStage(stage.key, w.reloadTotal);
      }
    }
    if (w.reloadTimer <= 0) {
      w.reloading = false;
      w.reloadStage = '';
      const amount = w.reloadAmount;
      w.reloadAmount = 0;
      if (entity.isPlayer && typeof entity.consumeReserve === 'function') {
        // P7：按弹匣实际装填的弹种扣备用弹（不是武器默认弹）
        entity.consumeReserve(w.ammoId || w.def.ammoItem, amount);
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
  const ammoId = w.ammoId || w.def.ammoItem;
  const available = entity.isPlayer && typeof entity.reserveAmmo === 'function'
    ? entity.reserveAmmo(ammoId)
    : need;
  if (available <= 0) {
    if (entity.isPlayer) {
      if (world.audio) world.audio.empty();
      const grade = ITEMS[ammoId];
      if (world.toast) world.toast(grade ? `没有备用 ${grade.name} 了` : '没有备用弹药了');
    }
    return false;
  }
  w.reloading = true;
  w.reloadAmount = Math.min(need, available);
  // 打空换弹比战术换弹慢一档（RELOADFX.emptyPenalty）—— 让"贪几发"真的付代价，
  // 但只在计时器上体现，不改弹匣容量或备用弹数量，旧存档读进来不会出现数值错位。
  // 干员被动「快速换弹」乘在最后：它应该同时缩短战术换弹与打空换弹，
  // 而不是只对其中一种生效（那会让被动在实战里时灵时不灵）。
  w.reloadTimer = reloadDuration(w.def, w.ammo) * (entity.reloadMul || 1);
  w.reloadTotal = w.reloadTimer;
  // 段名留空：第一帧 updateWeapon 检测到 '' → 'mag-out' 才播第一声，
  // 避免「开始换弹」和「第一段音效」在同一瞬间各响一次。
  w.reloadStage = '';
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
 * 命中候选目标（阵营感知）：
 * - 玩家或队友开火 → 只打敌人（不误伤友军）。
 * - 敌人开火 → 打「玩家 + 存活队友」（队友也会挨枪，符合搜打撤"队友可被击倒"）。
 * 与 hitscan / hitscan3D / fireWeapon 解耦：它们都从这里取候选集，单一口径。
 * @param {object} world 战局上下文
 * @param {object} shooter 射击者（带 faction 字段）
 * @returns {Array<object>} 候选实体（含 player / enemies / squad，未过滤 dead）
 */
export function combatTargets(world, shooter) {
  if (shooter && shooter.faction === 'enemy') {
    const list = [world.player];
    for (const a of (world.squad || [])) if (a && !a.isPlayer) list.push(a);
    return list;
  }
  return world.enemies || [];
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
  const candidates = combatTargets(world, shooter).filter((e) => e && !e.dead);
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

  // 枪口前移的水平量保留（与旧 hitscan / 敌人 AI 路径的距离基准一致），
  // 但**必须补偿高度**：只平移 XZ 而不抬升，等于把视线平移成一条平行线，
  // 弹着点会偏低 muzzle·tan(pitch)（近距离仰射 / 打高台时明显，平地≈0）。
  // 补上 muzzle·tan(pitch) 后，射线起点正好落在相机视线上 —— 两条射线重合成同一条，
  // 于是「准星指哪，子弹打到哪」严格成立；距离约定不变，旧回归护栏继续等价。
  const muzzle = shooter.radius + 10;
  const ox = shooter.x + dx * muzzle;
  const oy = shooter.y + dy * muzzle;
  // tan(pitch) 在接近 ±90° 时发散（pitchLimit 85°，这里再夹一层保险）
  const tanPitch = Math.tan(Math.max(-1.5, Math.min(1.5, pitch)));
  const Oy = eyeY + muzzle * tanPitch;
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
  let bestZone = null;
  const candidates = combatTargets(world, shooter).filter((e) => e && !e.dead);
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
          bestZone = zoneFromHeight(h, baseY, topY);
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
    // P7 部位：命中点落在目标身体的比例位置（未命中为 null，调用方按胸部处理）
    zone: bestZone,
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
export function applyDamage(world, target, raw, source, hx, hy, hitHeight, hit) {
  if (!target || target.dead) return 0;
  // P22：玩家中弹 → 压制再加一档（擦过只加一点，真挨枪加得更多）。
  // 压制只影响扩散与 HUD，不改伤害数值，所以放在伤害结算之前不会有副作用。
  if (target.isPlayer && source && source.faction === 'enemy') {
    target.suppression = addPlayerSuppression(target.suppression, 'hit');
  }
  // P21：敌人中弹 → 落血迹痕迹（供 AI 循迹调查）；玩家/队友中弹不落痕。
  if (target.faction === 'enemy' && world.leaveTrace) {
    world.leaveTrace('blood', hx, hy, { strength: 0.85 });
  }
  // 缺省即旧行为：不传 hit → 胸部、无弹种穿透信息，减伤公式与 P1~P6 逐位一致。
  const zone = (hit && hit.zone) || 'chest';
  const ammo = (hit && hit.ammo) || null;
  const zmul = zoneMultiplier(zone);
  const vestBefore = Math.max(0, target.armor || 0);
  const helmetBefore = Math.max(0, target.helmet || 0);
  const vestLevel = target.armorLevel != null ? target.armorLevel
    : (target.armorDef && target.armorDef.level != null ? target.armorDef.level : null);
  const helmetLevel = target.helmetLevel != null ? target.helmetLevel
    : (target.helmetDef && target.helmetDef.level != null ? target.helmetDef.level : null);
  const pen = ammo && ammo.pen != null ? ammo.pen : null;
  const hasPen = pen != null && Number.isFinite(Number(pen));
  const hasLevel = (v) => v != null && Number.isFinite(Number(v));

  let mitigation = 0;
  // G-02：只有「弹种穿透等级 + 护甲等级」同时存在时才走离散表；缺一即回退旧连续公式。
  // 敌人开火时 ammo=null，因此玩家/队友受击的旧数值完全不变。
  let penRatio = null;
  let durabilityBefore = 0;
  let durabilityLoss = 0;
  let armorAbsorbed = false;
  let helmetAbsorbed = false;

  if (zone === 'head') {
    // 爆头只吃头盔；没有头盔就完全裸奔（爆头倍率全额生效）
    if (helmetBefore > 0) {
      const level = helmetLevel != null ? helmetLevel : vestLevel;
      const discrete = hasPen && hasLevel(level);
      durabilityBefore = helmetBefore;
      durabilityLoss = helmetDurabilityLoss(raw, ammo);
      if (discrete) {
        const res = helmetMitigationDiscrete({ armor: helmetBefore, level, pen });
        mitigation = res.mitigation;
        penRatio = res.ratio;
      } else {
        mitigation = helmetMitigation({ armor: helmetBefore, level, pen });
      }
      target.helmet = Math.max(0, helmetBefore - durabilityLoss);
      helmetAbsorbed = armorWasHit(helmetBefore, target.helmet);
    }
  } else if (zone === 'chest') {
    // 胸腹由防弹衣覆盖；四肢没有护甲
    if (vestBefore > 0) {
      const discrete = hasPen && hasLevel(vestLevel);
      durabilityBefore = vestBefore;
      durabilityLoss = armorDurabilityLoss(raw, ammo, zone);
      if (discrete) {
        const res = armorMitigationDiscrete({ armor: vestBefore, level: vestLevel, pen });
        mitigation = res.mitigation;
        penRatio = res.ratio;
      } else {
        mitigation = armorMitigation({ armor: vestBefore, level: vestLevel, pen });
      }
      target.armor = Math.max(0, vestBefore - durabilityLoss);
      armorAbsorbed = armorWasHit(vestBefore, target.armor);
    }
  }
  // P16 Boss 战：弱点（头部）与破甲是**额外**倍率，叠在既有部位/穿透计算之上。
  // 只对 isBoss 生效，普通敌人 P7 的数值逐位不变（单测锁）。
  const bossMul = bossDamageMul(target, zone);
  const armorBrokeNow = checkArmorBreak(target, vestBefore);
  // V-02：穿透结果真值。离散路径按穿透比分级；旧路径退回减伤阈值。
  // - blocked：完全没进肉（穿透比 0）
  // - partial：进了一部分肉（0 < 穿透比 < 1）
  // - penetrated：完全穿透（穿透比 1）；无甲/旧路径按 mitigation < 0.5 近似
  const blockedHit = penRatio != null ? penRatio <= 0 : mitigation >= 0.5;
  const partialHit = penRatio != null ? penRatio > 0 && penRatio < 1 : false;
  const penetratedHit = penRatio != null ? penRatio >= 1 : mitigation < 0.5;

  // G-02：离散路径按「剩余耐久挡住的比例 × 减伤 + 溢出比例」拆分；
  // 旧路径保持原来的 raw × (1 - mitigation)，逐位不变。
  let dmg;
  if (penRatio != null && durabilityBefore > 0 && durabilityLoss > 0) {
    dmg = armorDamageSplit({
      raw, zoneMul: zmul, mitigation, durabilityBefore, loss: durabilityLoss, bossMul,
    }).dmg;
  } else {
    dmg = raw * zmul * (1 - mitigation) * bossMul;
  }
  dmg = Math.max(1, dmg);
  const hpBefore = target.hp;
  target.hp -= dmg;
  target.hurtFlash = 0.25;
  // 命中分级/表现层读这一份结算结果：谁被部位倍率放大、谁被护甲吃掉、打的是头还是腿。
  world.lastDamage = {
    zone,
    dmg,
    mitigation,
    penetrationRatio: penRatio,
    armorAbsorbed,
    helmetAbsorbed,
    ammoId: ammo ? ammo.id : null,
    // V-02：穿透结果（HUD/音频反馈用）。无甲命中恒为完整穿透。
    penetrated: penetratedHit,
    blocked: blockedHit,
    partial: partialHit,
    // P16：Boss 战的三个表现开关。普通敌人恒为 false，HUD 不需要分支判断是否 Boss。
    weakspot: isWeakspot(target, zone),
    armorBroke: armorBrokeNow,
    bossPhase: target.isBoss ? target.bossPhase : null,
  };
  if (typeof target.onHit === 'function') {
    target.onHit({
      raw, zone, ammo, hpBefore, hpAfter: target.hp, world,
    });
  }
  const px = typeof hx === 'number' ? hx : target.x;
  const py = typeof hy === 'number' ? hy : target.y;
  const angle = Math.atan2(py - (source ? source.y : py - 1), px - (source ? source.x : px));
  // P1-6 受击方向提示：记下「玩家 → 伤害来源」的方位角，供 HUD 在对应屏幕边缘闪红。
  // 注意不能直接复用上面的 angle —— 那是「来源 → 命中点」，正好差 180°，
  // 直接用会把背后来的枪显示成正面来的（比没有提示更误导）。
  if (target.isPlayer && source) {
    world.hitDir = Math.atan2(source.y - target.y, source.x - target.x);
    world.hitDirT = HITDIR.life;
  }
  // 爆头血更多、打腿更少；这是纯表现，不改任何数值
  const bloodMul = zone === 'head' ? 1.8 : (zone === 'limb' ? 0.7 : 1);
  const bloodAmt = Math.max(1, Math.round((target.isPlayer ? 5 : COMBAT.bloodPerHit) * bloodMul));
  if (world.spawnBlood) world.spawnBlood(px, py, angle, bloodAmt, hitHeight);
  if (world.addDamageNumber) {
    // V-02：飘字颜色也带穿透信息。打甲被弹开=冷灰，半穿=琥珀，全穿=亮橙；
    // 打头/玩家受伤保持原有高优先级色，不让穿透色盖掉更重要的信息。
    let numColor = '#ffd166';
    if (target.isPlayer) numColor = '#ff5c5c';
    else if (zone === 'head') numColor = '#ff9f1c';
    else if (blockedHit) numColor = '#9fb3c8';
    else if (partialHit) numColor = '#ffc04d';
    else if (penetratedHit && (armorAbsorbed || helmetAbsorbed)) numColor = '#ff8a3d';
    world.addDamageNumber(px, py, Math.round(dmg), numColor, hitHeight);
  }
  // 打到硬质护甲/头盔：溅一簇金属火花，和"打肉体"的 blood 区分开
  if ((armorAbsorbed || helmetAbsorbed) && world.spawnSpark) {
    world.spawnSpark(px, py, angle, hitHeight);
  }
  // P16 破甲瞬间：额外三簇火花，配合 armorBreak 音效让「甲碎了」有物理感。
  // 只在这一击打空最后一点护甲时触发一次，不是每发都炸。
  if (armorBrokeNow && world.spawnSpark) {
    for (let i = 0; i < 3; i += 1) {
      world.spawnSpark(px + (i - 1) * 7, py, angle + (i - 1) * 0.55, hitHeight + (i - 1) * 4);
    }
  }
  if (world.audio) {
    if (target.isPlayer) world.audio.hurt();
    // 玩家打出的命中音由 player.fire 按分级（普通/护甲/爆头/击杀）播放，
    // 这里只负责"非玩家来源"的普通命中音，避免同一发响两次。
    else if (!(source && source.isPlayer)) world.audio.hit();
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

/**
 * P21：点到线段距离（用于近失检测，避免逐敌解析射线-圆求交的高成本）。
 * @param {number} px 点 x
 * @param {number} py 点 y
 * @param {number} ax 线段起点 x
 * @param {number} ay 线段起点 y
 * @param {number} bx 线段终点 x
 * @param {number} by 线段终点 y
 * @returns {number} 最短距离
 */
function pointSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-6) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/**
 * P21 / P22：近失检测。子弹没打中，但擦过目标（落点附近一定距离内）。
 *
 * 两个方向，各自一套数值，互不干扰：
 * - 玩家开火 → 擦过敌人：触发敌人 `onNearMiss()`（AI 压制：降精度、找掩体）。
 * - 敌人开火 → 擦过玩家：累加**玩家**压制值（P22：只是"被火力钉住"的紧张感，
 *   不给任何敌方坐标，也不回填 lastKnown）。
 *
 * @param {object} world 战局
 * @param {object} shooter 开火者
 * @param {number} ax 射线起点 x
 * @param {number} ay 射线起点 y
 * @param {number} bx 射线终点 x
 * @param {number} by 射线终点 y
 */
function markNearMiss(world, shooter, ax, ay, bx, by) {
  // P22：敌方火力擦过玩家 → 玩家压制。队友不在此列（没有 HUD，加了也没人看得见）。
  if (shooter && !shooter.isPlayer) {
    const p = world.player;
    const pc = COMBAT.playerSuppression || {};
    const nearPlayer = pc.nearMissRadius != null ? pc.nearMissRadius : 96;
    if (p && !p.dead && pointSegDist(p.x, p.y, ax, ay, bx, by) <= nearPlayer) {
      p.suppression = addPlayerSuppression(p.suppression, 'nearMiss');
    }
    return;
  }
  // P21：用配置的「擦过」判定半径（压制火力手感），不再是孤立的硬编码值。
  const near = AI.suppression.nearMissRadius;
  for (const e of combatTargets(world, shooter)) {
    if (!e || e.dead || e.isPlayer) continue;
    if (typeof e.onNearMiss !== 'function') continue; // 仅敌人有压制机制
    if (pointSegDist(e.x, e.y, ax, ay, bx, by) <= near) e.onNearMiss();
  }
}

export function fireWeapon(world, shooter, opts = {}) {
  const w = shooter.currentWeapon;
  if (!w || shooter.dead) return { fired: false, reason: 'unavailable' };
  // 玩家走统一状态机；敌人/队友没有这套字段，行为与旧版逐位一致。
  if (shooter.isPlayer && !canFire(shooter)) return { fired: false, reason: 'state-locked' };
  if (w.reloading || w.cooldown > 0 || shooter.fireLocked) return { fired: false, reason: 'not-ready' };
  const def = w.def;
  // P7：玩家按弹匣里实际装填的弹种修正伤害与枪声；敌人保持原有数值（ammo 为 null）。
  const ammo = shooter.isPlayer ? (ITEMS[w.ammoId] || ITEMS[def.ammoItem] || null) : null;
  const ammoDmgMul = ammo && Number.isFinite(ammo.damageMul) ? ammo.damageMul : 1;
  const ammoNoiseMul = ammo && Number.isFinite(ammo.noiseMul) ? ammo.noiseMul : 1;
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

  // 弹道序号先算：扩散要按「是否本轮第一发」给首发精度奖励，后坐也要用同一序号。
  const step = shooter.isPlayer ? recoilStep(def.id, w.aimIndex || 0, w.sinceShot ?? 99) : null;

  // ---- 扩散模型（P4-C2）----
  // 四个因子全部收在 spreadAt 纯函数里（基础/开镜/移动/首发），这里只负责喂状态。
  const adsT = Math.max(0, Math.min(1,
    shooter.adsT != null ? shooter.adsT : (shooter.ads ? 1 : 0)));
  // 终结技增益（P5 火力全开）：三个乘数统一由 shooter.combatMods 提供，
  // 缺省即 1 —— 敌人没有这个字段，行为与 P4 完全一致。
  const mods = shooter.combatMods;
  const spreadMul = mods && Number.isFinite(mods.spreadMul) ? mods.spreadMul : 1;
  const recoilMul = mods && Number.isFinite(mods.recoilMul) ? mods.recoilMul : 1;
  const dmgMul = mods && Number.isFinite(mods.damageMul) ? mods.damageMul : 1;
  // P19：抬枪进度归一成 0~1（1 = 还没抬起来），蹲伏与探头各自给稳定性修正。
  const raiseT = shooter.isPlayer && shooter.sprintLock > 0
    ? Math.min(1, shooter.sprintLock / Math.max(0.01, COMBAT.sprintRaise
      ? (COMBAT.sprintRaise[shooter.combatState && shooter.combatState.weaponClass] || 0.27) : 0.27))
    : 0;
  let spreadNow = spreadAt(def, w.spread, {
    adsT,
    moveMag: shooter.moveMag,
    sprinting: shooter.sprinting,
    firstShot: !!step && step.index === 0,
    isPlayer: !!shooter.isPlayer,
    crouching: !!shooter.crouching,
    // 卧倒（比蹲更稳）与滞空（必须打不准）——两个新姿态因子，
    // 缺字段时 spreadAt 里是恒等乘数 1，旧局与敌人逐位不变。
    prone: !!shooter.prone,
    airborne: !!shooter.airborne,
    raiseT,
    leaning: Math.abs(Number(shooter.leanT) || 0) > 0.02,
  }) * spreadMul;
  // P22：被压制时枪口发飘。压制值缺省 0 → 乘数恒等 1，旧局逐位不变。
  if (shooter.isPlayer) spreadNow *= suppressionSpreadMul(shooter.suppression);
  w.spread = Math.min(def.spreadMax, w.spread + def.spreadPerShot);
  const accuracyPenalty = opts.accuracy != null ? (1 - Math.max(0, Math.min(1, opts.accuracy))) * 0.38 : 0;
  const jitter = world.rng.float(-1, 1) * (spreadNow + accuracyPenalty);
  let angle = shooter.angle + jitter + (shooter.recoilOffset || 0);
  // 水平后坐：玩家走 recoil.js 的固定曲线（可学习、可压枪），敌人保持随机游走（不改 PVE 难度）。
  // 仍然照常抽一次 rng —— 既作为曲线之上的微量噪声，也保证同 seed 的随机流长度不变。
  const recoilRand = world.rng.float(-1, 1);
  // 蹲伏降低后坐（指令书 5%~15%）：只作用于玩家，敌人数值完全不变。
  // 卧倒在蹲伏之后再乘一档（架枪最稳），同样只作用于玩家。
  let stanceRecoil = shooter.isPlayer
    ? (shooter.crouching ? (COMBAT.crouchRecoilMul != null ? COMBAT.crouchRecoilMul : 1) : 1) : 1;
  if (shooter.isPlayer && shooter.prone) stanceRecoil *= COMBAT.proneRecoilMul != null ? COMBAT.proneRecoilMul : 1;
  shooter.recoilOffset = (shooter.recoilOffset || 0)
    + (step
      ? def.recoil * (step.yawMul + recoilRand * RECOIL.noise) * recoilMul * stanceRecoil
      : def.recoil * recoilRand);
  if (step) {
    w.aimIndex = step.index + 1;
    w.sinceShot = 0;
  }
  // 轻度辅助瞄准：把这一发的偏航角小幅拉向瞄准锥内最近的敌人（只改当发，不动 shooter.angle）
  if (shooter.isPlayer && COMBAT.aimAssist && COMBAT.aimAssist.enabled) {
    const adjusted = applyAimAssist(world, shooter, angle, COMBAT.aimAssist);
    if (Number.isFinite(adjusted)) angle = adjusted;
  }
  shooter.muzzleFlash = 0.06;

  const muzzle = shooter.radius + 10;
  const ox = shooter.x + Math.cos(shooter.angle) * muzzle;
  const oy = shooter.y + Math.sin(shooter.angle) * muzzle;

  // ---- 多弹丸（霰弹枪）：单发喷出数枚独立弹丸，每枚独立散布与命中 ----
  // 独头弹（ammo.singleProjectile）退化为单弹丸；其余武器 pellets 默认 1，行为与原版逐位等价。
  const pellets = (ammo && ammo.singleProjectile) ? 1
    : (def.pellets && def.pellets > 1 ? def.pellets : 1);
  const baseAngle = shooter.angle + (shooter.recoilOffset || 0);
  let shot; // 仅用于函数返回值（取最后一颗弹丸的命中）
  let eyeY = 0;
  let lastX = ox, lastY = oy, lastH = 0, lastEntity = null, lastDist = 0;

  for (let pi = 0; pi < pellets; pi++) {
    // 水平散布：首发沿用外侧已算好的 jitter（recoilStep / aimAssist 只对首发生效），其余弹丸独立抽
    angle = (pi === 0) ? (baseAngle + jitter) : (baseAngle + world.rng.float(-1, 1) * (spreadNow + accuracyPenalty));
    let pitch = 0;
    if (shooter.isPlayer) {
      // 关键：在「加入本次抬枪」之前快照俯仰，否则第一发就会被自己的 recoilPitch 抬高而偏高。
      const aimPitch = (shooter.pitch || 0) + (shooter.recoilPitch || 0);
      // 开火抬枪（aim punch）：仅抬俯仰不改 yaw —— 视觉后坐，不影响水平朝向。
      // 幅度同样走曲线：首发最猛、随后递减到平台（step 为空表示非玩家，保持旧行为）。
      if (pi === 0) {
        const pitchMul = step ? step.pitchMul : 1;
        shooter.recoilPitch = Math.min(
          COMBAT.recoilPitchMax,
          (shooter.recoilPitch || 0) + def.recoil * COMBAT.recoilPitchMul * pitchMul * stanceRecoil,
        );
      }
      eyeY = VIEW3D.metersToUnits * (
        (shooter.crouching ? VIEW3D.eyeCrouch : VIEW3D.eyeStand) + (shooter.elevation || 0)
      );
      // 竖直散布：比水平散布小，且以准星为中心（不影响 yaw）。
      const jitterV = world.rng.float(-1, 1) * (spreadNow + accuracyPenalty) * 0.6;
      pitch = aimPitch + jitterV;
    } else {
      // 非玩家开火者（敌人 / 队友）走 hitscan3D（竖直感知），与玩家同源正确命中高地/低地目标。
      // 关键：从 combatTargets 候选集里挑"最近的存活目标"做俯仰瞄准，与 hitscan 命中口径一致。
      const groundElev = world.map ? elevationAt(world.map, shooter.x, shooter.y) : 0;
      eyeY = VIEW3D.metersToUnits * (groundElev + VIEW3D.eyeStand);
      let tgt = null, bestD = Infinity;
      for (const c of combatTargets(world, shooter)) {
        if (!c || c.dead) continue;
        const d = Math.hypot(c.x - shooter.x, c.y - shooter.y);
        if (d < bestD) { bestD = d; tgt = c; }
      }
      if (tgt) {
        const tBaseY = VIEW3D.metersToUnits * (world.map ? elevationAt(world.map, tgt.x, tgt.y) : 0);
        const tCenterY = tBaseY + VIEW3D.metersToUnits * VIEW3D.playerCenterM;
        const horiz = Math.max(1, Math.hypot(tgt.x - shooter.x, tgt.y - shooter.y));
        pitch = Math.atan2(tCenterY - eyeY, horiz);
      }
      // 竖直散布：与玩家对称，比水平散布小，以玩家身体中心为基准
      const jitterV = world.rng.float(-1, 1) * (spreadNow + accuracyPenalty) * 0.6;
      pitch += jitterV;
    }
    // 首发轻度辅助瞄准（玩家）：整发只做一次，避免每弹丸把 yaw 拉偏
    if (pi === 0 && shooter.isPlayer && COMBAT.aimAssist && COMBAT.aimAssist.enabled) {
      const adjusted = applyAimAssist(world, shooter, angle, COMBAT.aimAssist);
      if (Number.isFinite(adjusted)) angle = adjusted;
    }
    shot = hitscan3D(world, shooter, { angle, pitch, eyeY, maxDist: def.range, damage: def.damage * ammoDmgMul });
    lastX = shot.x; lastY = shot.y; lastH = shot.height; lastEntity = shot.entity; lastDist = shot.dist;
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
    if (shot.entity) {
      applyDamage(world, shot.entity, def.damage * dmgMul * ammoDmgMul, shooter, shot.x, shot.y, shot.height, { zone: shot.zone, ammo });
    } else if (world.spawnSpark) {
      world.spawnSpark(shot.x, shot.y, angle, shot.height);
    }
    // P21：子弹擦过未命中的敌人 → 只累加压制（绝不回填射手坐标，守住"不透视"边界）。
    // 近失检测只对玩家开火生效：压制是敌人 AI 的应激机制，玩家本身没有压制条。
    if (!shot.entity) markNearMiss(world, shooter, ox, oy, shot.x, shot.y);
  }
  if (world.shells) {
    const side = shooter.angle + Math.PI / 2;
    const rot0 = world.rng.float(0, Math.PI * 2);
    world.shells.push({
      x: ox, y: oy,
      vx: Math.cos(side) * world.rng.float(30, 70) + Math.cos(shooter.angle) * -20,
      vy: Math.sin(side) * world.rng.float(30, 70) + Math.sin(shooter.angle) * -20,
      rot: rot0,
      vr: world.rng.float(-12, 12),
      // 竖直初速（m/s）：抛壳要有"弹出→落回地面"的弧线（P0-1 渲染用）。
      // 由已抽到的 rot0 推导，**绝不额外消耗 world.rng** —— 那是玩法主随机流，
      // 多抽一次会让同 seed 下的散布 / AI / 掉落全部错位，破坏可复现性。
      vh: 0.55 + (rot0 / (Math.PI * 2)) * 1.25,
      t: 0, life: COMBAT.shellLife,
    });
  }
  // P21：弹壳落痕 —— 巡逻 AI 循着弹壳调查（只标记"有人来过"，不泄露射手坐标）。
  if (world.leaveTrace) world.leaveTrace('shell', ox, oy, { strength: 0.7 });
  if (world.emitNoise) {
    world.emitNoise(shooter.x, shooter.y, def.noiseRadius * ammoNoiseMul, shooter.faction);
  }
  if (world.audio) {
    const distToPlayer = Math.hypot(shooter.x - world.player.x, shooter.y - world.player.y);
    const vol = shooter.isPlayer ? 1 : Math.max(0, 1 - distToPlayer / 900);
    world.audio.shot(def.id, vol);
  }
  if (world.shakeCamera) {
    world.shakeCamera(shooter.isPlayer ? COMBAT.playerShake : 1.1 * Math.max(0, 1 - Math.hypot(shooter.x - world.player.x, shooter.y - world.player.y) / 900));
  }

  // 命中伤害与火花已在多弹丸循环内逐弹丸结算（近距多弹丸叠加高伤、远距单弹丸低伤）

  return { fired: true, entity: lastEntity, x: lastX, y: lastY, dist: lastDist, height: lastH };
}

/**
 * 近战挥击（W2）。
 *
 * 与 `fireWeapon` **完全独立**的一条链路，共用底层的 `hitscan3D` / `applyDamage`：
 * - 不消耗弹药、不产生弹壳、不进 `world.tracers`（刀没有曳光弹）；
 * - **不调 `emitNoise`**：静默处决是匕首存在的理由，捅一刀惊动半张图就没人用了；
 * - 只跑一次命中判定（不做多弹丸），距离由 `def.rangeM` 换算成逻辑单位。
 *
 * 冷却与挥击动画写在调用者（Player.meleeAttack）上：本函数是纯结算，
 * 不碰 CD 之外的任何状态，单测可以反复调用同一个 world 验证伤害与命中部位。
 *
 * @param {object} world 战局上下文
 * @param {object} attacker 攻击者（玩家；敌人不走近战，避免改动 PVE 数值）
 * @returns {{hit:boolean, entity:object|null, dist:number, zone:string|null, damage:number}}
 */
export function meleeAttack(world, attacker) {
  const def = attacker && attacker.meleeDef;
  const empty = { hit: false, entity: null, dist: 0, zone: null, damage: 0 };
  if (!world || !attacker || attacker.dead || !def) return empty;

  // 距离真值只在这里换算一次：def.rangeM 是米，hitscan3D 要逻辑单位。
  // ⚠ hitscan3D 会把射线起点沿朝向**前移** `muzzle = radius + 10`（枪口在身前），
  // 那段前移要扣掉，否则「2.1 米的刀」实际能砍到 3 米开外 —— 面板上的数字必须是玩家体感的数字。
  const reach = VIEW3D.metersToUnits * (def.rangeM || 2);
  const muzzle = (attacker.radius || 9) + 10;
  const maxDist = Math.max(10, reach - muzzle);
  // 眼高与开火路径同源（蹲下/站立的差值必须一致，否则"砍得到/砍不到"会随姿势漂移）。
  const groundElev = world.map ? elevationAt(world.map, attacker.x, attacker.y) : 0;
  const eyeY = VIEW3D.metersToUnits * (
    (attacker.crouching ? VIEW3D.eyeCrouch : VIEW3D.eyeStand) + groundElev
  );
  const shot = hitscan3D(world, attacker, {
    angle: attacker.angle,
    pitch: attacker.pitch || 0,
    eyeY,
    maxDist,
    damage: def.damage,
  });

  let damage = 0;
  if (shot.entity) {
    // `pen` 复用弹药那套 1~6 的穿透等级，让近战也走 applyDamage 的离散减伤表；
    // 不传 armorDamageMul → 耐久损耗按默认 1 倍（刀砍甲本来就该磨甲）。
    damage = applyDamage(
      world, shot.entity, def.damage, attacker, shot.x, shot.y, shot.height,
      { zone: shot.zone, ammo: { pen: def.pen } },
    );
  } else if (world.spawnSpark) {
    // 砍到墙/箱子也给个金属火星：这是"挥空了 vs 砍到硬物"的唯一区分
    world.spawnSpark(shot.x, shot.y, attacker.angle, shot.height);
  }

  if (world.audio && typeof world.audio.melee === 'function') world.audio.melee(!!shot.entity);
  // 挥击动画进度：只写时间戳，具体怎么甩由渲染层读它决定（逻辑层不碰 three）。
  attacker.meleeSwing = 1;
  attacker.meleeCd = Math.max(0.2, def.cooldown || 0.85);
  // 近战也留下一处轻响动（脚步级，不是枪声级），供贴脸 AI 警觉。
  if (world.emitNoise) world.emitNoise(attacker.x, attacker.y, PLAYER.noiseWalk * 0.5, attacker.faction);

  return {
    hit: !!shot.entity,
    entity: shot.entity || null,
    dist: shot.dist,
    zone: shot.zone || null,
    damage,
  };
}
