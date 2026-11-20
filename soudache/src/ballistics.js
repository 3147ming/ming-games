/**
 * 弹道结算的纯数值层（P7：部位 / 穿透 / 护甲与头盔）。
 *
 * 设计约束：
 *  - 不 import three / 不碰 DOM / 不掷随机 —— Node 单测与战局共用同一份公式。
 *  - **缺省即旧行为**：没有传部位时按胸部，没有传弹种时穿透因子为 1。
 *    这样 P1~P6 的旧调用（敌人 AI、队友、测试桩）数值不变，不需要改任何旧断言。
 *  - 护甲值本身既是「耐久池」也是「减伤来源」：打掉耐久，减伤自然下降。
 *    不额外引入一个隐藏的 durability 百分比，避免两套真值打架。
 */

import { COMBAT } from './config.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/**
 * 穿透因子：弹种 PEN 高于护甲等级 → 减伤下降；低于 → 减伤上升。
 * 没有弹种信息（pen/level 缺失）时恒为 1，保持旧公式逐位不变。
 * @param {number} pen 弹药穿透等级
 * @param {number} level 护甲等级
 * @returns {number} 乘在护甲减伤上的因子
 */
export function penetrationFactor(pen, level) {
  if (!Number.isFinite(Number(pen)) || !Number.isFinite(Number(level))) return 1;
  if (Number(level) <= 0) return 1;
  const per = COMBAT.penPerLevel != null ? COMBAT.penPerLevel : 0.09;
  return clamp(1 - (Number(pen) - Number(level)) * per,
    COMBAT.penFactorMin != null ? COMBAT.penFactorMin : 0.65,
    COMBAT.penFactorMax != null ? COMBAT.penFactorMax : 1.15);
}

/**
 * G-02 离散穿透比（Q-07 建议默认：离散表 + 旧路径回退）。
 *
 * 规则（对标公开口径，表达自研）：弹种 penLevel 相对护甲 protectLevel
 * - 高 2 级及以上 → 1.0 全穿
 * - 高 1 级       → 0.75
 * - 同级         → 0.5
 * - 低 1 级       → 0.25（肉伤极低，仍会掉一点血）
 * - 低 2 级及以上 → 0（完全打不穿，只掉甲不掉血）
 *
 * ⚠ 只有 `ammo.pen` 与护甲等级**同时存在**时 applyDamage 才走本表；
 * 缺任一级（旧敌人、敌人开火、测试桩）自动回退 penetrationFactor 连续公式。
 * @param {number} penLevel 弹药穿透等级（复用 ammo.pen，0~6）
 * @param {number} protectLevel 护甲防护等级（复用 armor.level，0~6）
 * @returns {number} 0 / 0.25 / 0.5 / 0.75 / 1
 */
export function penetrationRatio(penLevel, protectLevel) {
  // 缺任一等级（null/undefined/非数字）→ 视为"全穿"，让调用方回退旧公式。
  // 注意不能先 Number(null)：null 会变成 0，被误当成"0 级弹药"。
  if (penLevel == null || protectLevel == null) return 1;
  const pen = Number(penLevel);
  const protect = Number(protectLevel);
  if (!Number.isFinite(pen) || !Number.isFinite(protect)) return 1;
  if (protect <= 0) return 1; // 无甲
  const diff = pen - protect;
  if (diff >= 2) return 1;
  if (diff === 1) return 0.75;
  if (diff === 0) return 0.5;
  if (diff === -1) return 0.25;
  return 0;
}

/**
 * G-02 离散穿透下的护甲减伤 = 基础减伤 × (1 - 穿透比)。
 * 与 armorMitigation 的差异：后者用连续 penetrationFactor 乘算，本函数用离散肉伤比例。
 * @param {object} opts { armor, level, pen, k }
 * @returns {{mitigation:number, ratio:number}}
 */
export function armorMitigationDiscrete(opts = {}) {
  const armor = Math.max(0, num(opts.armor));
  if (armor <= 0) return { mitigation: 0, ratio: 1 };
  const k = Number.isFinite(Number(opts.k)) ? Number(opts.k) : COMBAT.armorK;
  const base = armor / (armor + Math.max(1, k));
  const ratio = penetrationRatio(opts.pen, opts.level);
  return { mitigation: clamp(base * (1 - ratio), 0, 0.85), ratio };
}

/** 头盔离散减伤：与胸甲同表，只换 helmetK。 */
export function helmetMitigationDiscrete(opts = {}) {
  return armorMitigationDiscrete({
    ...opts,
    k: Number.isFinite(Number(opts.k)) ? Number(opts.k) : COMBAT.helmetK,
  });
}

/**
 * G-02 破甲那发的伤害拆分。
 *
 * 一发子弹的护甲耐久损耗可能大于剩余耐久：剩余耐久挡住的比例按减伤算，
 * 溢出比例全额穿肉。等价于公开口径的
 * `基础肉伤 × (被挡比例 × 穿透系数 + 溢出比例)`。
 *
 * 不传 durabilityBefore/loss 时 blockedRatio=0，返回全额伤害，
 * 方便调用方在没有护甲时直接复用。
 * @param {object} opts { raw, zoneMul, mitigation, durabilityBefore, loss, bossMul }
 * @returns {{dmg:number, blockedRatio:number, overflowRatio:number}}
 */
export function armorDamageSplit(opts = {}) {
  const raw = Math.max(0, num(opts.raw));
  const zoneMul = Number.isFinite(Number(opts.zoneMul)) ? Number(opts.zoneMul) : 1;
  const mitigation = clamp(num(opts.mitigation), 0, 1);
  const before = Math.max(0, num(opts.durabilityBefore));
  const loss = Math.max(0, num(opts.loss));
  const bossMul = Number.isFinite(Number(opts.bossMul)) ? Number(opts.bossMul) : 1;
  const blockedRatio = loss > 0 ? clamp(before / loss, 0, 1) : 0;
  const overflowRatio = 1 - blockedRatio;
  const dmg = raw * zoneMul
    * (blockedRatio * (1 - mitigation) + overflowRatio)
    * bossMul;
  return { dmg, blockedRatio, overflowRatio };
}

/**
 * G-02 破甲溢出（独立工具函数）：这一发打穿护甲后，溢出的耐久损耗转成额外肉伤。
 * applyDamage 现在用 `armorDamageSplit` 做一次性拆分，本函数保留给数值工具/测试单独调用。
 * @param {number} durabilityBefore 命中前护甲耐久
 * @param {number} loss 这一发本应造成的耐久损耗
 * @param {number} raw 原始伤害
 * @returns {number} 溢出肉伤（>=0）
 */
export function overkillDamage(durabilityBefore, loss, raw) {
  const before = Math.max(0, num(durabilityBefore));
  const l = Math.max(0, num(loss));
  if (l <= before) return 0; // 没打穿，无溢出
  const overflowRatio = clamp((l - before) / Math.max(1e-6, l), 0, 1);
  return Math.max(0, num(raw)) * overflowRatio;
}

/**
 * 护甲减伤比例（0~上限）。
 * @param {object} opts { armor, level, pen, k }
 * @returns {number} 0~0.85
 */
export function armorMitigation(opts = {}) {
  const armor = Math.max(0, num(opts.armor));
  if (armor <= 0) return 0;
  const k = Number.isFinite(Number(opts.k)) ? Number(opts.k) : COMBAT.armorK;
  const base = armor / (armor + Math.max(1, k));
  const factor = penetrationFactor(opts.pen, opts.level);
  return clamp(base * factor, 0, 0.85);
}

/** 头盔减伤：同耐久下比胸甲更有效（helmetK 更小）。 */
export function helmetMitigation(opts = {}) {
  return armorMitigation({
    ...opts,
    k: Number.isFinite(Number(opts.k)) ? Number(opts.k) : COMBAT.helmetK,
  });
}

/**
 * 按命中高度比例切部位。
 * @param {number} height 命中点场景高度
 * @param {number} baseY 目标脚底高度
 * @param {number} topY 目标头顶高度
 * @param {object} [cfg] 部位阈值（默认 COMBAT.zones）
 * @returns {'head'|'chest'|'limb'} 部位
 */
export function zoneFromHeight(height, baseY, topY, cfg = COMBAT.zones) {
  const span = num(topY) - num(baseY);
  if (!(span > 1e-6)) return 'chest';
  const frac = clamp((num(height) - num(baseY)) / span, 0, 1);
  const headAt = cfg && Number.isFinite(cfg.headAt) ? cfg.headAt : 0.82;
  const limbAt = cfg && Number.isFinite(cfg.limbAt) ? cfg.limbAt : 0.45;
  if (frac >= headAt) return 'head';
  if (frac <= limbAt) return 'limb';
  return 'chest';
}

/** 部位伤害倍率；未知部位按胸部 1.0。 */
export function zoneMultiplier(zone, cfg = COMBAT.zones) {
  if (zone === 'head') return (cfg && cfg.headMul) || 1.9;
  if (zone === 'limb') return (cfg && cfg.limbMul) || 0.85;
  return (cfg && cfg.chestMul) || 1;
}

/**
 * 这一发打掉多少护甲耐久。
 * 弹种的 armorDamageMul 只影响耐久损耗，不直接加伤害 ——
 * 「穿甲」的体感来自更快把甲打空，而不是凭空多一段伤害。
 */
export function armorDurabilityLoss(raw, ammo, zone = 'chest') {
  if (zone === 'head' || zone === 'limb') return 0; // 头看头盔，腿无甲
  const mul = ammo && Number.isFinite(Number(ammo.armorDamageMul)) ? Number(ammo.armorDamageMul) : 1;
  return Math.max(0, num(raw)) * (COMBAT.armorDurabilityLoss || 0.55) * mul;
}

/** 爆头打掉多少头盔耐久。 */
export function helmetDurabilityLoss(raw, ammo) {
  const mul = ammo && Number.isFinite(Number(ammo.armorDamageMul)) ? Number(ammo.armorDamageMul) : 1;
  return Math.max(0, num(raw)) * (COMBAT.helmetDurabilityLoss || 0.7) * mul;
}

/**
 * 一次命中里「护甲是否真的吃到了伤害」——HUD 命中分级与火花表现共用。
 * @param {number} armorBefore 命中前耐久
 * @param {number} armorAfter 命中后耐久
 * @returns {boolean}
 */
export function armorWasHit(armorBefore, armorAfter) {
  return num(armorBefore) - num(armorAfter) > 0.01;
}
