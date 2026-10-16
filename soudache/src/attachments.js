/**
 * 武器配件（纯数据模块，可在 Node 下直接 import 测试）。
 *
 * 三个槽位：枪口 muzzle / 瞄具 sight / 握把 grip。
 * 每件配件带一组 mods 增量（如 recoil: -0.2），同一把武器三个槽的**同名项相加**得 Δ，
 * 再统一换算成乘数 mul = 1 + Δ（recoil -0.2 → recoilMul 0.8）。
 * 战斗层（combat.js）只读乘数，没装配件时全为 1 —— 敌人与未装配件时行为完全不变。
 */

import { ITEMS } from './config.js';

/** 配件槽位顺序（UI 渲染与汇总都按它走） */
export const ATTACH_SLOTS = ['muzzle', 'sight', 'grip'];

/** 槽位中文名（UI 展示用） */
export const SLOT_LABELS = { muzzle: '枪口', sight: '瞄具', grip: '握把' };

/**
 * 把战前配置的配件汇总成"武器 id → 乘数表"。
 * 主/副武器的归属按武器 id 判定：手枪走副武器槽，其余走主武器槽。
 * @param {object} attach loadout.attach（{ primary: {...}, secondary: {...} }）
 * @param {object[]} weaponDefs 本局带入的武器定义（WEAPONS 里的对象）
 * @returns {object} { [weaponId]: { damageMul, spreadMul, ... } }；无配件时为空对象
 */
export function buildPlayerMods(attach, weaponDefs) {
  const out = {};
  if (!attach || typeof attach !== 'object') return out;
  for (const def of weaponDefs || []) {
    if (!def || !def.id) continue;
    const slot = def.id === 'pistol' ? 'secondary' : 'primary';
    const slots = attach[slot] || {};
    const delta = {};
    for (const key of ATTACH_SLOTS) {
      const id = slots[key];
      const item = id ? ITEMS[id] : null;
      // 只接受真正的配件：脏存档里塞了别的 category 就静默忽略
      if (!item || item.category !== 'attachment' || !item.mods) continue;
      for (const [k, v] of Object.entries(item.mods)) {
        delta[k] = (delta[k] || 0) + v;
      }
    }
    const keys = Object.keys(delta);
    if (!keys.length) continue;
    const mods = {};
    for (const k of keys) mods[`${k}Mul`] = 1 + delta[k];
    out[def.id] = mods;
  }
  return out;
}

/**
 * 某把武器当前装配的配件 id 列表（deploy 消耗 / 死亡丢失都用它）。
 * @param {object} attach loadout.attach
 * @returns {string[]} 配件物品 id 列表（已过滤非法值）
 */
export function equippedAttachmentIds(attach) {
  const ids = [];
  if (!attach || typeof attach !== 'object') return ids;
  for (const slot of ['primary', 'secondary']) {
    const slots = attach[slot] || {};
    for (const key of ATTACH_SLOTS) {
      const id = slots[key];
      if (id && ITEMS[id] && ITEMS[id].category === 'attachment') ids.push(id);
    }
  }
  return ids;
}
