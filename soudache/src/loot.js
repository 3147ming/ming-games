/**
 * 战利品表与开箱加权随机（纯逻辑模块）
 *
 * 产出流程：先按容器的 rarityWeights 掷稀有度 → 在该稀有度池内按 categoryBias 加权掷具体物品。
 * 依赖：config.js（物品与容器定义）、rng.js、inventory.js（createItem）
 */

import {
  ITEMS, ITEMS_BY_RARITY, RARITY_ORDER, CONTAINERS, AMMO_STACK, ENEMY_TYPES,
} from './config.js';
import { createItem, displayUnits } from './inventory.js';

/**
 * 掷一次稀有度。
 * @param {object} weights 形如 { common: 70, rare: 25, epic: 5, legendary: 0 }
 * @param {object} rng 随机数发生器
 * @returns {string} 稀有度 id
 */
export function rollRarity(weights, rng) {
  const entries = RARITY_ORDER.map((r) => [r, Math.max(0, (weights && weights[r]) || 0)]);
  return rng.weighted(entries);
}

/**
 * 在指定稀有度池内按品类偏置抽取一个物品定义 id。
 * @param {string} rarity 稀有度
 * @param {object} bias 品类权重倍数，如 { weapon: 4 }
 * @param {object} rng 随机数发生器
 * @returns {string|null} 物品 id
 */
export function rollItemId(rarity, bias, rng) {
  const pool = ITEMS_BY_RARITY[rarity] || [];
  if (!pool.length) return null;
  const entries = pool.map((id) => [id, 1 * (bias ? Math.max(0, bias[ITEMS[id].category] || 1) : 1)]);
  return rng.weighted(entries);
}

/**
 * 掷一次产出（返回物品实例）。
 * @param {object} weights 稀有度权重
 * @param {object} bias 品类偏置
 * @param {object} rng 随机数发生器
 * @returns {object|null} 物品实例
 */
export function rollOne(weights, bias, rng) {
  const rarity = rollRarity(weights, rng);
  const id = rollItemId(rarity, bias, rng);
  if (!id) return null;
  const def = ITEMS[id];
  const qty = def.stack ? Math.min(def.stack, rng.int(Math.ceil(def.stack * 0.3), def.stack)) : 1;
  return createItem(def, qty);
}

/**
 * 为容器产出战利品。
 * @param {string} containerType 容器类型 id
 * @param {object} rng 随机数发生器
 * @param {object} opts 可选：{ luck: 数值加成，提升稀有度权重 }
 * @returns {Array<object>} 物品实例数组
 */
export function rollContainer(containerType, rng, opts = {}) {
  const def = CONTAINERS[containerType];
  if (!def) return [];
  const luck = opts.luck || 1;
  let weights = def.rarityWeights;
  if (luck !== 1) {
    weights = {
      common: Math.max(0, def.rarityWeights.common / luck),
      rare: def.rarityWeights.rare,
      epic: def.rarityWeights.epic * luck,
      legendary: def.rarityWeights.legendary * luck,
    };
  }
  const [minRolls, maxRolls] = def.rolls;
  const count = rng.int(minRolls, maxRolls);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const item = rollOne(weights, def.categoryBias, rng);
    if (item) out.push(item);
  }
  return out;
}

/**
 * 敌人掉落：以弹药/消耗品为主，按敌人等级给稀有度加成。
 * @param {string} enemyType 敌人类型 id
 * @param {object} rng 随机数发生器
 * @returns {Array<object>} 物品实例数组
 */
export function rollEnemyLoot(enemyType, rng) {
  const type = ENEMY_TYPES[enemyType] || ENEMY_TYPES.patrol;
  const luck = 1 + (type.lootBonus - 1) * 0.8;
  // BOSS 专属偏移：在 lootBonus 之上再抬一档高稀有度，并多掉 1~2 件 ——
  // 击杀 BOSS 的风险（600 血 / 80 甲 / 重机枪）必须由掉落兑现。
  const isBoss = enemyType === 'boss';
  const weights = {
    common: 66 / luck,
    rare: 26,
    epic: 7 * luck + (isBoss ? 10 : 0),
    legendary: 1 * luck + (isBoss ? 6 : 0),
  };
  const count = isBoss ? rng.int(3, 5) : rng.int(1, 3);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const item = rollOne(weights, { ammo: 2.5, consumable: 2 }, rng);
    if (item) out.push(item);
  }
  // 精英及以上额外保底一份弹药
  if (type.lootBonus > 1 && rng.chance(0.6)) {
    out.push(createItem(ITEMS.ammo556, rng.int(15, AMMO_STACK)));
  }
  // BOSS 保底一件高稀有度收藏品（掉落明显更好，且是「猎杀者」成就的正反馈）
  if (isBoss) {
    const jackpot = ['keycard', 'gold', 'optic', 'suppressor'];
    out.push(createItem(ITEMS[rng.pick(jackpot)], 1));
  }
  return out;
}

/**
 * 计算一组物品的总价值。
 * @param {Array<object>} items 物品实例数组
 * @returns {number} 总价值
 */
export function valueOf(items) {
  if (!Array.isArray(items)) return 0;
  // 弹药按"盒"计价（qty 是发、value 是盒价），与仓库/商店/负重同一口径
  return Math.round(items.reduce((s, it) => s + (it.value || 0) * displayUnits(it), 0));
}

/**
 * 计算一组物品的总重量。
 * @param {Array<object>} items 物品实例数组
 * @returns {number} 总重量
 */
export function weightOf(items) {
  if (!Array.isArray(items)) return 0;
  // 弹药按"盒"计重（qty 是发、weight 是盒重），与负重系统同一口径
  return Math.round(items.reduce((s, it) => s + (it.weight || 0) * displayUnits(it), 0) * 10) / 10;
}
