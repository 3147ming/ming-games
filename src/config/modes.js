/**
 * 模式 / 关卡 / 平衡配置
 *
 * P0：把原本硬编码在 MATCH.waves 里的波次搬到这里，行为完全不变；
 * 后续 P1/P2 会在这里补上 5 关配置与无尽模式生成规则。
 *
 * 本文件只放纯数据与纯函数，不 import 任何运行时模块，避免循环依赖。
 */

/** 闯关模式第 1 关（沿用现有三波配置，P1 起会拆成 5 关） */
export const CAMPAIGN_WAVES = [
  // total：本波总数；alive：同时存活上限；mix：变体配额
  {
    total: 6, alive: 4, mix: { walker: 5, swift: 1 },
    healthMul: 1.00, damageMul: 1.00, accuracyMul: 0.85, speedMul: 1.00,
  },
  {
    total: 8, alive: 5, mix: { walker: 4, spitter: 2, swift: 1, bomber: 1 },
    healthMul: 1.10, damageMul: 1.05, accuracyMul: 1.00, speedMul: 1.05,
  },
  {
    total: 10, alive: 6, mix: { walker: 3, spitter: 2, brute: 1, swift: 2, bomber: 1, howler: 1 },
    healthMul: 1.22, damageMul: 1.15, accuracyMul: 1.10, speedMul: 1.08,
  },
];

/** 各模式的元信息（大厅卡片、存档键都要用） */
export const MODES = {
  campaign: {
    id: 'campaign',
    name: '闯关行动',
    description: '5 个区域逐关推进，最终在决斗场遭遇首领。',
    waves: CAMPAIGN_WAVES,
  },
  endless: {
    id: 'endless',
    name: '无尽生存',
    description: '波次无限循环，难度持续攀升，每 10 波出现首领。',
    waves: null,          // 由 endlessWave() 动态生成
  },
};

/** 无尽模式曲线参数（平衡上限集中在这里，便于调参） */
export const ENDLESS = {
  baseTotal: 6,           // 第 1 波总数
  totalStep: 2,           // 每波新增数量
  maxTotal: 24,           // 单波数量上限
  baseAlive: 4,           // 第 1 波同屏上限
  maxAlive: 8,            // 同屏上限
  healthStep: 1.12,       // 每波血量复利
  healthCap: 2.2,         // 血量倍率上限
  bossEvery: 10,          // 每 N 波首领
};

/** 整局通用的平衡硬上限（P3 觉醒 / P4 机甲都会受这里约束） */
export const BALANCE = {
  maxDamageBonus: 0.60,     // 觉醒伤害加成上限 +60%
  maxSpeedBonus: 0.25,      // 移速加成上限 +25%
  maxHealthBonus: 40,       // 额外生命上限 +40
  maxArmorBonus: 40,        // 额外护甲上限 +40
};

/**
 * 生成无尽模式第 n 波配置（n 从 1 开始）
 * 纯函数：同样的 n 永远得到同样的结果，方便单测与回放。
 */
export function endlessWave(n) {
  const wave = Math.max(1, Math.floor(n));
  const total = Math.min(ENDLESS.maxTotal, ENDLESS.baseTotal + ENDLESS.totalStep * (wave - 1));
  const alive = Math.min(ENDLESS.maxAlive, ENDLESS.baseAlive + Math.floor((wave - 1) / 2));
  const healthMul = Math.min(ENDLESS.healthCap, Math.pow(ENDLESS.healthStep, wave - 1));

  // 变体池按波次逐步解锁
  const pool = [];
  pool.push('swift');            // 第 1 波起
  if (wave >= 2) pool.push('spitter');
  if (wave >= 3) pool.push('bomber');
  if (wave >= 4) pool.push('howler');
  if (wave >= 5) pool.push('brute');

  // 最多 55% 的名额分给特殊变体，剩下的都是普通丧尸
  const extras = Math.min(total - 1, Math.floor(total * 0.55));
  const mix = { walker: total - extras };
  for (let i = 0; i < extras; i++) {
    const v = pool[i % pool.length];
    mix[v] = (mix[v] || 0) + 1;
  }

  // 首领波：额外追加一头首领，不计入 total
  const boss = wave % ENDLESS.bossEvery === 0;
  if (boss) mix.boss = (mix.boss || 0) + 1;

  return {
    total,
    alive,
    mix,
    healthMul,
    damageMul: Math.min(1.6, 1 + 0.05 * (wave - 1)),
    accuracyMul: Math.min(1.25, 1 + 0.02 * (wave - 1)),
    speedMul: Math.min(1.2, 1 + 0.01 * (wave - 1)),
  };
}
