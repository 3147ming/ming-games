// 全局数值口径表（唯一真源）
// 口径原则：任何数值要么是「推导值」，要么是「设计目标值」，要么是「待校准值」，三者必须在注释里标明。
// 本表被 src/ 与 tools/ 同时 import，改这里即改全局。

export const CONST = {
  // ---- 回合结构（设计目标值）----
  HAND_SIZE: 5,            // 手牌上限，口径：竖屏一屏可完整展示 5 张卡
  MAX_ENERGY: 3,           // 每回合能量，口径：见 docs 伤害经济推导
  DRAW_PER_TURN: 5,        // 每回合抽牌数 = HAND_SIZE

  // ---- 玩家（推导值）----
  // HP_PLAYER = 10 × 普通敌人单回合输出(7~8)  →  「站着不动能挨 10 下」
  HP_PLAYER: 70,

  // ---- 伤害经济（口径：每 1 点能量的产出基准）----
  DMG_PER_ENERGY: 6,       // 基础打击 1 能量 / 6 伤害
  BLOCK_PER_ENERGY: 5,     // 基础防御 1 能量 / 5 格挡
  ATTACK_RATIO: 0.6,       // 玩家把 60% 能量用于进攻（设计目标值）

  // ---- 状态倍率（口径：先加力量，再乘虚弱，再乘易伤，最后向下取整）----
  WEAK_MULT: 0.75,         // 虚弱：造成伤害 ×0.75
  VULN_MULT: 1.5,          // 易伤：受到伤害 ×1.5
  STR_PER_STACK: 1,        // 每层力量 +1 伤害
  DEX_PER_STACK: 1,        // 每层灵巧 +1 格挡

  // ---- 奖励（设计目标值）----
  REWARD_CHOICES: 3,       // 三选一
  // 稀有度权重，口径：60/30/10 为「常见为主、稀有稀有」的经典分布
  RARITY_WEIGHT: { 1: 60, 2: 30, 3: 10 },

  // ---- 地图结构（推导值，与 docs/02 的 D_min=12 严格对齐）----
  FLOORS: 3,
  NODES_PER_FLOOR: 4,
  // 灯下回复比例。口径：1 次灯下必须覆盖约 4 场战斗的净损（4 × 7.5 ≈ 30）
  // → 30 / 70 = 43%，取 45% 留余量。由 tools/balance.mjs 的闭合方程反解确认。
  REST_HEAL_RATIO: 0.45,

  // ---- 元进度（推导值）----
  // 每局结束解锁 1 张卡 + 1 件遗物。
  // 封印卡 23 张（阶段 3 / G1 解封 x.overload 后由 24 → 23）、封印遗物 12 件，
  // 取较慢的一侧 ⟹ 全解锁局数 = 23。见 docs/05-数值校准与UI.md §T1 与 T6。
  UNLOCK_CARDS_PER_RUN: 1,
  UNLOCK_RELICS_PER_RUN: 1,

  // ---- D_min 推导的冗余系数（设计目标值）----
  // 口径：玩家不会每次都选同流派，取 2 倍保守冗余。
  // 用途：D_min = ceil(3 / p_archetype_hit × KAPPA)，见 docs/03 §2 的健壮性复核。
  KAPPA_REDUNDANCY_ASSUMED: 2,

  // ---- 存档 ----
  SAVE_KEY: 'one-card:save:v1',
};

// 玩家输出基准：DPT = 能量 × 每能量伤害 × 进攻占比
export const DPT_PLAYER = CONST.MAX_ENERGY * CONST.DMG_PER_ENERGY * CONST.ATTACK_RATIO; // 10.8

// 敌人血量由「目标回合数 × DPT」反推（口径见 docs/02）
export function hpForTurns(turns) {
  return Math.round(turns * DPT_PLAYER);
}

// 敌人输出目标（第二版，由闭合方程反解；第一版 8/12/10.8 实测缺口 1.94x 已废弃）
// 口径：静态总净损刻意高于资源总量，缺口 1.57x 交由牌组成长（后期 DPT ×1.6）承担。
export const ENEMY_TIERS = {
  normal: { turns: 4, avgDmgPerTurn: 7.5 },
  elite: { turns: 7, avgDmgPerTurn: 11 },
  boss: { turns: 12, avgDmgPerTurn: 10 },
};

/** 玩家把多少能量用于进攻（设计目标值）—— 用于反推格挡能力 */
export const BLOCK_PER_TURN = 3 * 5 * (1 - 0.6); // = 6
export const GROWTH_REQUIRED = 1.6;              // 后期 DPT 相对起始的倍数要求

export const STATUS_LIST = ['str', 'dex', 'vuln', 'weak', 'poison'];

export const STATUS_TEXT = {
  str: '力量',
  dex: '灵巧',
  vuln: '易伤',
  weak: '虚弱',
  poison: '中毒',
};
