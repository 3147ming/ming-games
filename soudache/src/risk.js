/**
 * 风险分级（P15）：把 `config.HUB.riskLevels` 的倍率落到本局实体上。
 *
 * 设计约束（与 economy.js 同一口径）：
 * - **纯逻辑**：零 DOM / 零 three / 零随机。绝不抽 `world.rng`，否则同 seed 的
 *   其它系统会跟着漂移。
 * - **不改常量**：所有倍率都写进「副本」。`ENEMY_TYPES` / `BOSSES` / `WEAPONS`
 *   是全局共享常量，直接改会让下一局继承上一局的难度。
 * - **基准档零改动**：`tier === 0` 时 `applyRiskToEnemies` 原样返回同一数组引用，
 *   保证常规局的数值与 P14 之前逐位一致（GOLDEN、旧存档、既有探针全部不受影响）。
 */

import { HUB } from './config.js';

/** 三档风险（与大厅/战前 UI 共用同一份数据，不另写文案）。 */
export const RISK_LEVELS = HUB.riskLevels;

/** 缺省风险档：旧存档、控制台 `SOUDACHE.startRaid(1)` 都落回这里。 */
export const DEFAULT_RISK_ID = 'routine';

/** 每级护甲加成折算的护甲值：与兵种原值（15~50）同量级，避免一档就变成无敌。 */
const ARMOR_PER_LEVEL = 12;

/**
 * 取风险档；未知 id 回落到基准档（不抛错，旧存档/手改 DOM 都不会白屏）。
 * @param {string} id 风险档 id
 * @returns {object} 风险档定义
 */
export function getRisk(id) {
  return RISK_LEVELS.find((r) => r.id === id) || RISK_LEVELS[0];
}

/**
 * 是否为基准档（所有倍率中性）。
 * @param {object} risk 风险档
 * @returns {boolean} true = 不需要做任何数值改写
 */
export function isNeutralRisk(risk) {
  return !risk || risk.tier === 0;
}

/**
 * 敌人属性倍率快照。放在这里而不是散落在 main/enemy，测试可逐项断言。
 * @param {object} risk 风险档
 * @returns {{hp:number,damage:number,accuracy:number,armorAdd:number,count:number}} 倍率
 */
export function riskEnemyScale(risk) {
  const r = risk || getRisk(DEFAULT_RISK_ID);
  return {
    count: Number(r.enemyCountMul) || 1,
    hp: Number(r.enemyHpMul) || 1,
    damage: Number(r.enemyDamageMul) || 1,
    accuracy: Number(r.enemyAccuracyMul) || 1,
    armorAdd: Number(r.enemyArmorAdd) || 0,
  };
}

/**
 * 把风险倍率写进敌人实例（**只改副本，不碰常量**）。
 *
 * 实现要点：
 * - `e.def` 换成浅拷贝，`weapon` 再深一层拷贝 —— AI 读的是 `e.def.accuracy`、
 *   `e.def.weapon.damage`，而 `e.hp` / `e.armor` 是构造时从 def 拷出来的独立字段，
 *   两边都要改，否则 HUD 与实际伤害会对不上。
 * - `e.weapon` 是 `createWeaponState()` 的产物，只替换 `def` 引用，保留 ammo /
 *   cooldown 等运行时字段（本函数在出生时调用，但保持这个语义更安全）。
 * - Boss 走同一条路径：`createBoss` 传的是 `BOSSES[id]` 作 overrideDef，同样是副本。
 *
 * @param {Array<object>} list 敌人列表
 * @param {object} risk 风险档
 * @returns {Array<object>} 原列表（原地改写实例，基准档直接返回）
 */
export function applyRiskToEnemies(list, risk) {
  if (!Array.isArray(list)) return list;
  const r = risk || getRisk(DEFAULT_RISK_ID);
  if (isNeutralRisk(r)) return list; // 基准档：连对象引用都不换

  const scale = riskEnemyScale(r);
  for (const e of list) {
    if (!e || !e.def) continue;
    // 幂等守卫：本函数会改写 e.def 为副本，重复调用会按副本再乘一次（数值滚雪球）。
    // 正常路径只在出生时调用一次，但调试口/未来重构可能重入，这里直接挡住。
    if (e._riskTier === r.tier) continue;
    const base = e.def;
    const baseWeapon = base.weapon || {};
    const hp = Number(base.hp) || 1;
    const armor = Number(base.armor) || 0;
    const def = {
      ...base,
      hp: hp * scale.hp,
      // 护甲加值走「等级 + 数值」两条线：等级影响弹种穿透，数值影响减伤曲线。
      armor: armor + scale.armorAdd * ARMOR_PER_LEVEL,
      armorLevel: (Number(base.armorLevel) || 0) + scale.armorAdd,
      // 精度上限 0.95：绝密档也不做"必中"，否则玩家没有任何操作空间。
      accuracy: Math.min(0.95, (Number(base.accuracy) || 0.4) * scale.accuracy),
      weapon: {
        ...baseWeapon,
        damage: (Number(baseWeapon.damage) || 8) * scale.damage,
      },
    };
    e.def = def;
    e.maxHp = def.hp;
    e.hp = def.hp;
    e.maxArmor = def.armor;
    e.armor = def.armor;
    e.armorLevel = def.armorLevel;
    if (e.weapon) e.weapon = { ...e.weapon, def: def.weapon };
    e._riskTier = r.tier;
  }
  return list;
}

/**
 * 容器战利品的稀有度权重偏移（直接喂给 `Loot.rollContainer` 的 `opts.luck`）。
 * @param {object} risk 风险档
 * @returns {number} 1 = 原概率
 */
export function riskLootLuck(risk) {
  const r = risk || getRisk(DEFAULT_RISK_ID);
  return Number(r.lootLuck) || 1;
}

/**
 * 结算评分倍率。
 * @param {number} score 原始评分
 * @param {object} risk 风险档
 * @returns {number} 取整后的最终评分
 */
export function riskScore(score, risk) {
  const r = risk || getRisk(DEFAULT_RISK_ID);
  const mul = Number(r.scoreMul) || 1;
  return Math.round((Number(score) || 0) * mul);
}

/**
 * 奖金倍率（评级奖励等固定金额）。
 * @param {number} amount 原始金额
 * @param {object} risk 风险档
 * @returns {number} 取整后的金额
 */
export function riskPayout(amount, risk) {
  const r = risk || getRisk(DEFAULT_RISK_ID);
  const mul = Number(r.payoutMul) || 1;
  return Math.round((Number(amount) || 0) * mul);
}

/**
 * 结算/战前用的一行风险摘要；基准档返回空串（结算不插多余行）。
 * @param {object} risk 风险档
 * @returns {string} 例如「机密 ×1.35 评分 · 稀有物资 ×1.6」
 */
export function riskSummary(risk) {
  const r = risk || getRisk(DEFAULT_RISK_ID);
  if (isNeutralRisk(r)) return '';
  return `${r.label} · 评分 ×${r.scoreMul} · 稀有物资 ×${r.lootLuck}`;
}
