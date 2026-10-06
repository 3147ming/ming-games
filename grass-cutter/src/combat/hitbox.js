/**
 * 命中判定（模块 3）—— **纯几何**，不 import three / 不碰 DOM。
 * ---------------------------------------------------------------------------
 * 无双类游戏的攻击判定不是"矩形碰撞盒"，而是**扇形**：
 *   · reach  —— 从扇形圆心往前够多远
 *   · arcDeg —— 张角（360° 就是回旋斩/裂地斩那类环身技）
 *   · offset —— 扇形圆心沿前向偏移多少（突刺偏移大、回旋为 0）
 *
 * 判定用"目标圆心"而不是"目标包围盒"，理由和玩家碰撞那边一样：
 * 用盒会把判定变成"擦到衣角就算中"，而割草游戏要的是**一刀砍中一片**的爽快，
 * 宁可略宽也不能略窄 —— 所以半径是 reach + target.radius。
 *
 * 高度差也判：跳起来的敌人（模块 4 的远程精英可能悬空）不该被地面斩扫到。
 */
import { COMBAT, DEG } from '../core/config.js';

/** 方向角：yaw = 0 → 面向 -Z */
export function facingDir(facing) {
  return { x: -Math.sin(facing), z: -Math.cos(facing) };
}

/**
 * 单个目标是否落在扇形内。
 * @param origin  {x,z} 攻击者位置
 * @param facing  攻击者朝向（弧度）
 * @param move    动作定义（reach / arcDeg / offset / height）
 * @param target  {x,z,radius,height,feetY?}
 * @param contact 贴身必中半径（米）；传 0 关闭这条规则
 *
 * ⚠ 两个量量的**不是同一个原点**，这是刻意的：
 *   · 距离：以「攻击者 + forward×offset」为圆心（offset 让突刺够得更远、回旋更贴脸）
 *   · 夹角：以**攻击者本身**为顶点
 * 为什么夹角不能用扇形圆心：圆心被 offset 推到敌人**身后**时，贴在脸上的敌人
 * 相对圆心是"正后方 180°"，会被自己的大招漏掉 —— 蓄力斩（offset 1.4 / arc 220°）
 * 就正好踩这个坑，敌人一多贴脸就砍空。夹角以攻击者为顶点则永远从"我看着哪边"量起。
 *
 * ⚠ 还有第三条规则：**重叠必中**。目标圆心离攻击者 <= contact 时，无视张角与扇形圆心。
 *   为什么必须要有：前冲会把玩家推进敌人身体里，那一刻敌人相对玩家可能在正后方
 *   （玩家已经越过它了）—— 按张角算就是 180° 落空。而"贴身砍空"是割草游戏里
 *   最劝退的手感 bug，宁可多打一下也不能漏。
 */
export function sectorHits(origin, facing, move, target, contact = 0) {
  const reach = move.reach ?? 0;
  const arc = (move.arcDeg ?? 0) * DEG;
  const offset = move.offset ?? 0;
  const tr = target.radius ?? 0.5;

  const f = facingDir(facing);
  const tx = (target.x ?? 0) - origin.x;
  const tz = (target.z ?? 0) - origin.z;

  const dFromUser = Math.hypot(tx, tz);
  const overlapping = contact > 0 && dFromUser <= contact;

  if (!overlapping) {
    // ── 夹角：从攻击者量
    if (arc < Math.PI * 2 - 1e-9) {
      if (dFromUser < 1e-6) {
        return true; // 敌人正好压在身上：无条件命中（否则夹角是 NaN）
      }
      const cos = (tx * f.x + tz * f.z) / dFromUser;
      if (Math.acos(Math.max(-1, Math.min(1, cos))) > arc / 2) return false;
    }

    // ── 距离：从扇形圆心量（外侧留出目标半径的余量 → "擦边也算中"）
    const dx = tx - f.x * offset;
    const dz = tz - f.z * offset;
    if (Math.hypot(dx, dz) > reach + tr) return false;
  }

  // 高度：攻击作用的竖直范围。move.height 是"判定中心高度"，允许 ±半径 的余量。
  // 高度是"这一招够不够得着"，和贴身与否无关 —— 所以重叠也要服从它。
  const targetFeet = target.feetY ?? 0;
  const targetTop = targetFeet + (target.height ?? 1.8);
  const lo = (move.height ?? 1.0) - 1.1;
  const hi = (move.height ?? 1.0) + 1.1;
  if (targetTop < lo || targetFeet > hi) return false;

  return true;
}

/**
 * 收集一次挥击命中的目标。
 * @param alreadyHit Set/数组：本次挥击已命中过的 id（**同一次挥击每个目标只吃一次伤害**，
 *                   否则 360° 回旋斩会在 active 的每一帧都打一次，伤害直接翻几倍）
 * @param max 单次挥击的命中上限（防止"一刀清屏"）
 */
export function collectHits({ origin, facing, move, targets, alreadyHit, max = 10, contact = COMBAT.CONTACT_HIT_RADIUS }) {
  const hitSet = alreadyHit instanceof Set ? alreadyHit : new Set(alreadyHit || []);
  const out = [];
  for (const t of targets) {
    if (out.length >= max) break;
    if (!t || t.alive === false) continue;
    // 脏数据防线（这里的 targets 可能是外部塞进来的列表）：
    // 缺坐标的目标必须显式跳过 —— 否则 x/z 会退化成 (0,0)，正好和攻击者重合，
    // 一头撞进"贴身必中"的判定里，凭空多打一个不存在的敌人。
    if (!Number.isFinite(t.x) || !Number.isFinite(t.z)) continue;
    if (hitSet.has(t.id)) continue;
    if (!sectorHits(origin, facing, move, t, contact)) continue;
    out.push(t);
  }
  return out;
}

/**
 * 结算伤害。
 * @returns {{damage:number, killed:boolean, overkill:number, remaining:number, hitPoint:{x,y,z}, knock:{x,z}}}
 */
export function applyDamage(target, move, origin, opts = {}) {
  const mult = opts.damageMultiplier ?? 1;
  const damage = Math.round((move.damage ?? 0) * mult);
  const before = Number.isFinite(target.hp) ? target.hp : 0;
  const remaining = Math.max(0, before - damage);
  target.hp = remaining;

  // 击退方向：从攻击者指向目标（不是从扇形圆心 —— 圆心偏移会让击退方向歪掉）
  const dx = (target.x ?? 0) - origin.x;
  const dz = (target.z ?? 0) - origin.z;
  const len = Math.hypot(dx, dz);
  const knock = len > 1e-6 ? { x: dx / len, z: dz / len } : { x: 0, z: 1 };

  const killed = remaining <= 0 && before > 0;
  if (killed) target.alive = false;
  target.hitFlash = opts.flash ?? 0.14;

  return {
    damage,
    killed,
    overkill: killed ? damage - before : 0,
    remaining,
    hitPoint: { x: target.x ?? 0, y: (target.y ?? 0) + (move.height ?? 1) * 0.5, z: target.z ?? 0 },
    knock,
  };
}
