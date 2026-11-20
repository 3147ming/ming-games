/**
 * 一键配装 / 快捷配装的纯逻辑层（零 DOM / 零 three / 零随机）。
 *
 * 为什么单独成模块：配装是「仓库库存 × 槽位规则 × 装备评分」的纯函数，塞进 ui.js
 * 既不好测又会和渲染搅在一起。这里只产出一个新的 loadout 对象，调用方负责落盘/重绘。
 *
 * 关键约束：
 *   - 只能从仓库里**真实拥有**的物品挑，绝不凭空发装备（会破坏经济/扣仓对称）。
 *   - 8 槽的 allowed 列表是唯一真值（与 ui.js EQUIP_SLOTS 同源，见 SLOT_ALLOWED）。
 *   - 不改动传入的 save/loadout/stash，返回新对象。
 */

import { ITEMS, WEAPONS, ARMORS, BACKPACKS, RIGS, MELEE } from './config.js';

/**
 * 槽位规则：与 ui.js 的 EQUIP_SLOTS.allowed 保持一致。
 * 这里复制一份而不是 import ui.js（ui.js 依赖 DOM，纯逻辑层不能引）。
 * 源码护栏会锁住两边一致，避免漂移。
 */
export const SLOT_ALLOWED = Object.freeze({
  primary: ['rifle', 'smg', 'carbine', 'lmg', 'dmr', 'battle', 'shotgun'],
  secondary: ['smg', 'pdw', 'shotgun'],
  sidearm: ['pistol', 'pdw'],
  melee: ['knife', 'knife_heavy'],
  helmet: ['helmet_lv2', 'helmet_lv3'],
  armor: ['lv2', 'lv3'],
  backpack: ['bp_lv1', 'bp_lv2', 'bp_lv3'],
  rig: ['rig_lv1', 'rig_lv2'],
});

/** 各槽位的 def 表（评分要读 value / level 等字段） */
const DEFS = { ...WEAPONS, ...ARMORS, ...BACKPACKS, ...RIGS, ...MELEE, ...ITEMS };

/**
 * 槽位偏好排序：同类装备里"更好"的优先。用 def 的数值字段而不是字符串，
 * 这样加新装备（如 lv4）时无需改这里。
 * @param {string} id 物品 def.id
 * @returns {number} 越大越好
 */
function scoreOf(id) {
  const d = DEFS[id];
  if (!d) return -Infinity;
  // 护甲/头盔：防护值优先；背包：容量；其它：价值（价值高的通常更强）
  if (d.armor != null && d.armor > 0) return 1000 + d.armor;
  if (d.packBonus != null) return 1000 + d.packBonus;
  if (d.value != null) return d.value;
  return 0;
}

/**
 * 从仓库 inventory 里收集拥有的 def.id → 数量。
 * @param {object} stash 仓库 inventory（items: [{ id, qty }]）
 * @returns {Map<string, number>}
 */
export function ownedCounts(stash) {
  const m = new Map();
  for (const it of ((stash && stash.items) || [])) {
    if (it.qty == null || it.qty > 0) m.set(it.id, (m.get(it.id) || 0) + (it.qty || 1));
  }
  return m;
}

/**
 * 一键配装：在仓库现有装备里，为每个槽挑评分最高的一件，生成新 loadout。
 * 弹药沿用当前配置（不动弹种/盒数——那是另一个决策，不该被"一键装备"悄悄改掉）。
 *
 * @param {object} stash 仓库 inventory
 * @param {object} current 当前 loadout
 * @returns {{loadout: object, changed: string[], missing: string[]}}
 *   loadout 新配装；changed 实际换了的槽；missing 仓库里没有可选装备的槽
 */
export function autoEquip(stash, current = {}) {
  const owned = ownedCounts(stash);
  const next = { ...current, mods: { ...(current.mods || {}) }, ammo: { ...(current.ammo || {}) } };
  const changed = [];
  const missing = [];
  for (const [slot, allowed] of Object.entries(SLOT_ALLOWED)) {
    // 只从仓库里真实拥有的、且在该槽 allowed 里的挑
    const candidates = allowed.filter((id) => owned.has(id));
    if (!candidates.length) {
      missing.push(slot);
      // 槽里若已有装备且仓库也还有，保留原样；否则清空（避免引用已不拥有的装备）
      if (current[slot] && owned.has(current[slot])) next[slot] = current[slot];
      else if (!current[slot]) next[slot] = '';
      continue;
    }
    candidates.sort((a, b) => scoreOf(b) - scoreOf(a) || a.localeCompare(b));
    const pick = candidates[0];
    if (next[slot] !== pick) { next[slot] = pick; changed.push(slot); }
  }
  return { loadout: next, changed, missing };
}

/**
 * 预设方案（快捷配装）：给一组明确的 id，套用到当前 loadout。
 * 只允许放该槽 allowed 里的 id，防止预设表写错导致非法装备。
 * @param {object} current 当前 loadout
 * @param {object} preset { slot: id, ... }
 * @returns {{loadout: object, changed: string[], rejected: string[]}}
 */
export function applyPreset(current, preset = {}) {
  const next = { ...current, mods: { ...(current.mods || {}) }, ammo: { ...(current.ammo || {}) } };
  const changed = [];
  const rejected = [];
  for (const [slot, id] of Object.entries(preset)) {
    const allowed = SLOT_ALLOWED[slot];
    if (!allowed || (id && !allowed.includes(id))) { rejected.push(slot); continue; }
    if (next[slot] !== id) { next[slot] = id; changed.push(slot); }
  }
  return { loadout: next, changed, rejected };
}

/** 三套快捷方案（游戏内按钮用；都是起步仓库就有的装备，点了必有反馈） */
export const QUICK_PRESETS = Object.freeze([
  { id: 'assault', name: '突击', desc: '步枪 + 二级甲，均衡推进', gear: { primary: 'rifle', sidearm: 'pistol', armor: 'lv2', melee: 'knife', rig: 'rig_lv1' } },
  { id: 'stealth', name: '轻装', desc: '冲锋枪 + 轻甲，跑得更快', gear: { primary: 'smg', sidearm: 'pistol', armor: 'lv2', backpack: '', melee: 'knife' } },
  { id: 'heavy', name: '重装', desc: '机枪 + 高甲 + 大背包', gear: { primary: 'lmg', armor: 'lv3', helmet: 'helmet_lv3', backpack: 'bp_lv2' } },
]);
