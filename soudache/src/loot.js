/**
 * 战利品表与开箱加权随机（纯逻辑模块）
 *
 * 产出流程：先按容器的 rarityWeights 掷稀有度 → 在该稀有度池内按 categoryBias 加权掷具体物品。
 * 依赖：config.js（物品与容器定义）、rng.js、inventory.js（createItem）
 */

import {
  ITEMS, ITEMS_BY_RARITY, RARITY_ORDER, CONTAINERS, AMMO_STACK, ENEMY_TYPES,
} from './config.js';
import { createItem, itemValue, itemWeight } from './inventory.js';

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
 * 各品类对应的「保底填充物」：只挑永远有用、单价确定的东西。
 * 刻意不用随机 —— 保底这件事必须可复现，抽随机等于"保底也可能保不到"。
 */
// 每个品类给一小把填充物并按顺序轮流用 —— 三件一模一样的东西看着就像程序占位。
const FLOOR_FILLER = {
  weapon: ['ammo556', 'ammo556ap'],
  ammo: ['ammo9mm', 'ammo9mmhp'],
  medical: ['medkit', 'armorKit'],
  consumable: ['medkit', 'bandage'],
  material: ['battery', 'fuel', 'parts'],
  valuable: ['chip', 'watch'],
  gear: ['armorKit', 'parts'],
  armor: ['armorKit', 'lv2'],
};

/** 各层级的**件数下限**：核心区的箱子不该只有一件货。 */
export const TIER_MIN_ITEMS = {
  low: 1,
  medium: 1,
  high: 2,
  hotspot: 3,
};

/** 容器主品类（取 categoryBias 权重最高的那一类，无偏置时回落 material）。 */
function primaryCategory(def) {
  const bias = (def && def.categoryBias) || null;
  if (!bias) return 'material';
  let best = 'material';
  let bv = -Infinity;
  for (const [k, v] of Object.entries(bias)) {
    if (Number(v) > bv) { bv = Number(v); best = k; }
  }
  return FLOOR_FILLER[best] ? best : 'material';
}

/** 该品类的填充物轮转序列（永远非空）。 */
function fillerPool(category) {
  const pool = FLOOR_FILLER[category] || FLOOR_FILLER.material;
  return pool.filter((id) => ITEMS[id]);
}

/**
 * 区域价值保底：高价值区的容器不该出现"打开只有一根螺栓"。
 *
 * 口径是**件数下限**而不是价值目标 —— 拿便宜材料去凑一个价值数字，
 * 会得到"一个箱子里四块电池"这种既不真实也不好玩的结果。
 * 全程零随机（填充物按品类静态选），所以不会让同 seed 的掉落序列漂移。
 *
 * @param {Array<object>} items 已掷出的物品（原地追加）
 * @param {string} tier TIER.*
 * @param {object} def 容器定义
 * @returns {Array<object>} 同一个数组
 */
export function applyTierFloor(items, tier, def) {
  const list = Array.isArray(items) ? items : [];
  const minItems = TIER_MIN_ITEMS[tier] || 0;
  if (minItems <= 0 || list.length >= minItems) return list;
  const pool = fillerPool(primaryCategory(def));
  if (!pool.length) return list;
  for (let i = list.length; i < minItems; i += 1) {
    list.push(createItem(ITEMS[pool[i % pool.length]], 1));
  }
  return list;
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
  const weights = {
    common: 66 / luck,
    rare: 26,
    epic: 7 * luck,
    legendary: 1 * luck,
  };
  const count = rng.int(1, 3);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const item = rollOne(weights, { ammo: 2.5, consumable: 2 }, rng);
    if (item) out.push(item);
  }
  // 精英额外保底一份弹药
  if (type.lootBonus > 1 && rng.chance(0.6)) {
    out.push(createItem(ITEMS.ammo556, rng.int(15, AMMO_STACK)));
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
  // 口径铁律：弹药 value 是「每盒」口径，必须经 itemValue 换算，禁止裸乘 qty。
  return Math.round(items.reduce((s, it) => s + itemValue(it), 0));
}

/**
 * 计算一组物品的总重量。
 * @param {Array<object>} items 物品实例数组
 * @returns {number} 总重量
 */
export function weightOf(items) {
  if (!Array.isArray(items)) return 0;
  // 口径铁律：弹药 weight 是「每盒」口径，必须经 itemWeight 换算，禁止裸乘 qty。
  return Math.round(items.reduce((s, it) => s + itemWeight(it), 0) * 10) / 10;
}
