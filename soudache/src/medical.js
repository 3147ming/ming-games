/**
 * 战地医疗状态（P7，纯逻辑 · 零 DOM · 零随机）
 *
 * 两个状态：
 *  - 流血（bleed 0~3）：按层数持续掉血；绷带/医疗包止血。
 *  - 骨折（fracture 0/1）：生命上限 ×0.75、移速下降；手术包治愈。
 *
 * 为什么不用随机：world.rng 是玩法主随机流（AI / 散布 / 掉落都吃它）。
 * 多抽一次会让同 seed 的整局漂移，且"这枪会不会流血"无法被玩家学习。
 * 所以触发条件全部写成伤害阈值 + 命中部位 + 剩余生命，确定且可预期。
 */

import { MEDICAL } from './config.js';

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 全新的医疗状态。 */
export function defaultConditions() {
  return { bleed: 0, fracture: 0 };
}

/** 归一化任意来源的 conditions（旧档 / 手改坏值都能安全读取）。 */
export function normalizeConditions(raw) {
  const out = defaultConditions();
  if (!raw || typeof raw !== 'object') return out;
  out.bleed = clamp(Math.floor(num(raw.bleed)), 0, MEDICAL.bleed.maxStacks);
  out.fracture = raw.fracture ? 1 : 0;
  return out;
}

/**
 * 一次命中后的受伤判定（就地修改 conditions）。
 * @param {object} conditions 医疗状态
 * @param {{raw:number, zone?:string, hpAfter:number, maxHpBase:number}} info
 * @returns {{bleedAdded:number, fractureAdded:boolean}}
 */
export function applyInjury(conditions, info = {}) {
  const c = conditions && typeof conditions === 'object' ? conditions : defaultConditions();
  const cfg = MEDICAL;
  const raw = Math.max(0, num(info.raw));
  const zone = info.zone || 'chest';
  let bleedAdded = 0;
  const minDmg = zone === 'limb' ? cfg.bleed.limbMinDamage : cfg.bleed.minDamage;
  if (raw >= minDmg) {
    const stacks = zone === 'limb' ? cfg.bleed.limbStacks : 1;
    const before = clamp(Math.floor(num(c.bleed)), 0, cfg.bleed.maxStacks);
    c.bleed = Math.min(cfg.bleed.maxStacks, before + stacks);
    bleedAdded = c.bleed - before;
  }
  let fractureAdded = false;
  const hpAfter = num(info.hpAfter);
  if (!c.fracture && hpAfter > 0) {
    const hpFracLine = num(info.maxHpBase) * cfg.fracture.hpFrac;
    if (raw >= cfg.fracture.heavyHit || (hpFracLine > 0 && hpAfter <= hpFracLine)) {
      c.fracture = 1;
      fractureAdded = true;
    }
  }
  return { bleedAdded, fractureAdded };
}

/** 当前流血每秒掉血。 */
export function bleedDps(conditions) {
  const stacks = clamp(Math.floor(num(conditions && conditions.bleed)), 0, MEDICAL.bleed.maxStacks);
  return stacks * MEDICAL.bleed.perStackDps;
}

/** 骨折后的生命上限（未骨折返回原值）。 */
export function fractureMaxHp(maxHpBase, conditions) {
  const base = Math.max(1, num(maxHpBase, 100));
  return conditions && conditions.fracture
    ? Math.max(20, Math.round(base * MEDICAL.fracture.maxHpMul))
    : Math.round(base);
}

/** 骨折对移速的乘数（未骨折 1）。 */
export function conditionSpeedMul(conditions) {
  return conditions && conditions.fracture ? MEDICAL.fracture.moveMul : 1;
}

/** 骨折对冲刺的额外乘数。 */
export function conditionSprintMul(conditions) {
  return conditions && conditions.fracture ? MEDICAL.fracture.sprintMul : 1;
}

/**
 * 医疗物品是否「当前用得上」。Q 键择优与点击使用共用这一份判定，
 * 避免出现「Q 说没状态、点物品却能读条」的两套口径。
 * @param {object} def 物品定义
 * @param {object} p 玩家状态快照
 * @returns {{ok:boolean, reason:string}}
 */
export function itemUsable(def, p = {}) {
  if (!def) return { ok: false, reason: '未知物品' };
  const hp = num(p.hp);
  const maxHp = Math.max(1, num(p.maxHp, 100));
  const bleed = Math.floor(num(p.bleed));
  const fracture = Boolean(p.fracture);
  const armor = num(p.armor);
  const maxArmor = num(p.maxArmor);
  const helmet = num(p.helmet);
  const maxHelmet = num(p.maxHelmet);
  if (def.cureFracture) {
    // 有骨折就直接可用，不再要求同时出血或掉血（手术本身就是一次大读条）
    return fracture
      ? { ok: true, reason: '' }
      : { ok: false, reason: '没有骨折，无需手术' };
  }
  if (def.stopBleed && bleed <= 0 && hp >= maxHp) {
    return { ok: false, reason: '没有出血，生命已满' };
  }
  if (def.repairArmor) {
    const vestNeed = maxArmor > 0 && armor < maxArmor - 0.5;
    const helmetNeed = maxHelmet > 0 && helmet < maxHelmet - 0.5;
    if (!vestNeed && !helmetNeed) return { ok: false, reason: '护甲完好，无需维修' };
  }
  const heal = num(def.heal);
  const stamina = num(def.stamina);
  if (!def.cureFracture && !def.repairArmor && !def.stopBleed
    && (heal <= 0 || hp >= maxHp) && (stamina <= 0 || num(p.stamina) >= num(p.maxStamina, 100) * 0.95)) {
    return { ok: false, reason: '状态良好，无需使用' };
  }
  return { ok: true, reason: '' };
}

/**
 * 从可用物品里挑一件最该用的（Q 键）。
 * 优先级：手术 > 止血 > 维修护甲 > 回血 > 回体力；同分时读条更快的优先。
 * @param {Array<object>} defs 物品定义数组（调用方已按 qty>0 过滤）
 * @param {object} p 玩家状态快照
 * @returns {?object} 选中的定义
 */
export function pickMedical(defs, p = {}) {
  let best = null;
  let bestScore = -Infinity;
  for (const def of defs || []) {
    if (!def || !itemUsable(def, p).ok) continue;
    const bleed = Math.floor(num(p.bleed));
    const missing = Math.max(0, num(p.maxHp, 100) - num(p.hp));
    let score = 0;
    if (def.cureFracture) score += 100;
    if (def.stopBleed && bleed > 0) score += 80 + bleed * 10;
    if (def.repairArmor) score += 60;
    if (num(def.heal) > 0 && missing > 0) {
      score += 40 + Math.min(missing, num(def.heal));
      // 过量治疗惩罚：只剩 5 点血却拿医疗包，应该让位给绷带
      score -= Math.max(0, num(def.heal) - missing) * 0.3;
    }
    if (num(def.stamina) > 0) score += 20;
    // 同分时读条更快者优先（绷带 1.6s 优于医疗包 3.0s）
    score -= num(def.useTime, 1.5) * 0.1;
    if (score > bestScore) { bestScore = score; best = def; }
  }
  return best;
}

/** 玩家状态 → 医疗判定所需的快照（只读，不产生副作用）。 */
export function medicalProfile(player) {
  const p = player || {};
  return {
    hp: num(p.hp),
    maxHp: Math.max(1, num(p.maxHp, 100)),
    stamina: num(p.stamina),
    maxStamina: Math.max(1, num(p.maxStamina, 100)),
    bleed: Math.floor(num(p.conditions && p.conditions.bleed)),
    fracture: Boolean(p.conditions && p.conditions.fracture),
    armor: num(p.armor),
    maxArmor: num(p.maxArmor),
    helmet: num(p.helmet),
    maxHelmet: num(p.maxHelmet),
  };
}
