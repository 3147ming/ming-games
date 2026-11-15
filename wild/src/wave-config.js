// 波次模式（Brotato 化）配置与内容表 —— 纯数据 + 纯函数，零 DOM / 零 localStorage / 零依赖。
//
// ★ 设计纪律：旧「600 秒连续局」的 ARENA.WAVES / OFFERS / SHOP_ITEMS / HEROES 一个字都不动。
//   本文件只服务 WaveDirector；旧模式不 import 它，因此 378 单测 / sim / probe 基线逐位不变。
//   属性 apply(c, k) 直接写 ArenaCore 已有字段，与 content.js 的 offer.apply 同一套口径，
//   写完由 director 统一调 c._refreshClassBuffs() 刷新派生值。

export const WAVE_COUNT = 20;
/** 20 波时长（秒）：20 → 90 递增，末段固定 90 秒（Brotato 口径）。 */
export const WAVE_SECS = [
  20, 25, 30, 35, 40, 45, 50, 55, 60, 65,
  70, 75, 80, 85, 90, 90, 90, 90, 90, 90,
];
export const waveSec = (w) => WAVE_SECS[Math.min(WAVE_SECS.length - 1, Math.max(0, w - 1))];
/** 无尽模式：20 波之后每波 90 秒，难度继续爬。 */
export const ENDLESS_WAVE_SEC = 90;

/** Boss 波 → WILD 已有的 Boss id（复用全部 5 只里的 4 只，机制零改动）。 */
export const WAVE_BOSS = { 5: 'boss1', 10: 'boss2', 15: 'boss3', 20: 'boss5' };
/** 精英波：第 3 波起，每 4 波一次（Boss 波不叠精英）。 */
export const isEliteWave = (w) => w >= 3 && w % 4 === 0 && !WAVE_BOSS[w];

/** 稀有度：影响属性数值、商店价格与出现权重。合成 = 两把同 id 同稀有度 → +1 阶。 */
export const RARITIES = [
  { key: 'common', label: '普通', mul: 1, cost: 1, color: '#9a938a', weight: 100 },
  { key: 'uncommon', label: '精良', mul: 1.5, cost: 1.6, color: '#7ba64a', weight: 55 },
  { key: 'rare', label: '稀有', mul: 2.2, cost: 2.4, color: '#5b93d6', weight: 26 },
  { key: 'legendary', label: '传说', mul: 3.2, cost: 3.6, color: '#d9a94a', weight: 9 },
];
export const rarityOf = (i) => RARITIES[Math.max(0, Math.min(RARITIES.length - 1, i | 0))];

/** 按波数 + 幸运值抽稀有度（Brotato：后期与幸运一起把高阶概率抬起来）。 */
export function rollRarity(rng, wave, luck = 0) {
  const late = (wave - 1) / (WAVE_COUNT - 1);
  const weights = RARITIES.map((r, i) =>
    r.weight * (1 + late * i * 1.35 + luck * i * 0.12));
  // ★ Rng.weighted(items, weightOf) 只回传 item、不回传下标（见 rng.js:76）——
  //   按 key 反查权重，别写成 (_k, i) => weights[i]，那会恒取 undefined ⟹ 退化成等概率。
  return rng.weighted(RARITIES.map((r) => r.key),
    (k) => weights[Math.max(0, RARITIES.findIndex((r) => r.key === k))]);
}

/** Danger 0-5：只放大敌人与密度，不改玩家数值（Brotato 口径）。 */
export const DANGERS = [
  { level: 0, label: '危险 0', hpMul: 1.00, dmgMul: 1.00, spawnMul: 1.00, elite: 0.00 },
  { level: 1, label: '危险 1', hpMul: 1.12, dmgMul: 1.08, spawnMul: 1.08, elite: 0.02 },
  { level: 2, label: '危险 2', hpMul: 1.25, dmgMul: 1.16, spawnMul: 1.16, elite: 0.05 },
  { level: 3, label: '危险 3', hpMul: 1.40, dmgMul: 1.26, spawnMul: 1.24, elite: 0.08 },
  { level: 4, label: '危险 4', hpMul: 1.58, dmgMul: 1.40, spawnMul: 1.34, elite: 0.12 },
  { level: 5, label: '危险 5', hpMul: 1.80, dmgMul: 1.60, spawnMul: 1.48, elite: 0.16 },
];
export const dangerOf = (n) => DANGERS[Math.max(0, Math.min(DANGERS.length - 1, n | 0))];

/** 波内刷怪权重表：按波号逐步解锁怪种（复用 ENEMY_TYPES 的 8 个 key）。 */
export function waveWeights(w) {
  const t = Math.min(1, (w - 1) / 19);
  const out = {
    normal: Math.max(20, 100 - 45 * t),
  };
  if (w >= 2) out.fast = 10 + 22 * t;
  if (w >= 4) out.tank = 8 + 18 * t;
  if (w >= 6) out.ranged = 6 + 15 * t;
  if (w >= 8) out.splitter = 4 + 11 * t;
  if (w >= 11) out.shield = 3 + 9 * t;
  if (w >= 14) out.swarm = 3 + 9 * t;
  return out;
}
/** 波内刷怪间隔（秒）：越往后越密；Danger.spawnMul 是「密度倍率」，
 *  所以要**除**（乘会变成危险越高刷得越慢，方向反了）。夹住下限防止爆屏。 */
export const waveSpawnInterval = (w, danger) =>
  Math.max(0.08, (0.55 - Math.min(w - 1, 19) * 0.022) / danger.spawnMul);

/* ─────────────── 4 选 1 属性池（20 条）───────────────
 * k = 稀有度倍率（1 / 1.5 / 2.2 / 3.2）。所有封顶沿用 ArenaCore 的硬上限，
 * 不做「选了没反应」的废牌：director 会先滤掉已达 max 的项。            */
export const WAVE_STATS = [
  { id: 'hp', name: '最大生命', unit: '+8', max: 10, apply: (c, k) => { const v = Math.round(8 * k); c.maxHp += v; c.hp += v; } },
  { id: 'regen', name: '生命回复', unit: '+0.3/s', max: 10, apply: (c, k) => { c.regenRate += 0.3 * k; } },
  { id: 'lifesteal', name: '生命偷取', unit: '+2%', max: 8, apply: (c, k) => { c.lifesteal = Math.min(1, c.lifesteal + 0.02 * k); } },
  { id: 'dmg', name: '伤害', unit: '+6%', max: 12, apply: (c, k) => { c.dmgBase += 0.06 * k; } },
  { id: 'atk', name: '攻击速度', unit: '+6%', max: 10, apply: (c, k) => { c.attackInterval = Math.max(0.2, c.attackInterval / (1 + 0.06 * k)); } },
  { id: 'crit', name: '暴击率', unit: '+3%', max: 8, apply: (c, k) => { c.critRate = Math.min(1, c.critRate + 0.03 * k); } },
  { id: 'critMul', name: '暴击伤害', unit: '+0.1x', max: 8, apply: (c, k) => { c.critMul += 0.1 * k; } },
  { id: 'armor', name: '护甲', unit: '+1', max: 10, apply: (c, k) => { c.armor += 1 * k; } },
  { id: 'dodge', name: '伤害减免', unit: '+2%', max: 8, apply: (c, k) => { c.dmgCut = Math.min(0.6, c.dmgCut + 0.02 * k); } },
  { id: 'move', name: '移动速度', unit: '+6', max: 10, apply: (c, k) => { c.moveBase += 6 * k; } },
  { id: 'magnet', name: '拾取范围', unit: '+25', max: 8, apply: (c, k) => { c.magnet += 25 * k; } },
  { id: 'luck', name: '幸运', unit: '+1', max: 8, apply: (_c, _k, d) => { d.luck += 1; } },
  { id: 'harvest', name: '收获', unit: '+4', max: 8, apply: (_c, _k, d) => { d.harvest += 4; } },
  { id: 'xp', name: '经验加成', unit: '+8%', max: 8, apply: (c, k) => { c.xpMul = Math.min(3, c.xpMul + 0.08 * k); } },
  { id: 'shots', name: '投射物', unit: '+1', max: 6, apply: (c, k) => { c.shots = Math.min(7, c.shots + Math.max(1, Math.round(k * 0.8))); } },
  { id: 'pierce', name: '穿透', unit: '+1', max: 6, apply: (c, k) => { c.projPierce += Math.max(1, Math.round(k * 0.7)); } },
  { id: 'pspd', name: '弹道速度', unit: '+8%', max: 8, apply: (c, k) => { c.projSpeed += 0.08 * k; } },
  { id: 'reach', name: '攻击范围', unit: '+8%', max: 8, apply: (c, k) => { c.projReachMul += 0.08 * k; } },
  { id: 'thorn', name: '荆棘', unit: '+2', max: 8, apply: (c, k) => { c.thorn += 2 * k; } },
  { id: 'shield', name: '护盾层', unit: '+1', max: 3, apply: (c, k) => { c.shieldLayers = Math.min(1, c.shieldLayers + 1); c.shieldEvery = Math.max(c.shieldEvery, 12 - k); } },
];
export const statById = (id) => WAVE_STATS.find((s) => s.id === id) || null;

/* ─────────────── 商店：武器与道具 ─────────────── */
/** 6 把武器直接映射 content.js 的 WEAPONS id；买下即占一个槽。 */
export const WAVE_WEAPONS = [
  { id: 'projectile', label: '投射物', desc: '自动锁定最近敌人', cost: 14, tag: 'ranged' },
  { id: 'orbit', label: '环绕刃', desc: '利刃绕身旋转', cost: 16, tag: 'melee' },
  { id: 'laser', label: '直斩', desc: '穿透光束', cost: 18, tag: 'ranged' },
  { id: 'sword', label: '剑', desc: '飞行穿透剑气', cost: 18, tag: 'melee' },
  { id: 'mist', label: '毒雾', desc: '脚下腐蚀地面', cost: 20, tag: 'element' },
  { id: 'sentry', label: '守望之瞳', desc: '自动炮台补刀', cost: 22, tag: 'engineering' },
];
export const weaponGoodById = (id) => WAVE_WEAPONS.find((w) => w.id === id) || null;

/** 道具：即时收益 / 小属性 / 功能性。apply(c, d) 里 d 是 WaveDirector。 */
export const WAVE_ITEMS = [
  { id: 'i_heal', label: '急救包', desc: '立刻回复 30 生命', cost: 10, apply: (c) => { c.healPlayer(30); } },
  { id: 'i_hp', label: '护心镜', desc: '最大生命 +12', cost: 16, apply: (c) => { c.maxHp += 12; c.hp += 12; } },
  { id: 'i_armor', label: '铁皮', desc: '护甲 +2', cost: 18, apply: (c) => { c.armor += 2; } },
  { id: 'i_dmg', label: '磨刀石', desc: '伤害 +8%', cost: 20, apply: (c) => { c.dmgBase += 0.08; } },
  { id: 'i_atk', label: '急速齿轮', desc: '攻速 +8%', cost: 20, apply: (c) => { c.attackInterval = Math.max(0.2, c.attackInterval / 1.08); } },
  { id: 'i_magnet', label: '磁石', desc: '拾取范围 +40', cost: 12, apply: (c) => { c.magnet += 40; } },
  { id: 'i_material', label: '材料箱', desc: '立刻获得 18 材料', cost: 0, apply: (_c, d) => { d.materials += 18; } },
  { id: 'i_reroll', label: '免费刷新券', desc: '本窗下次刷新免费', cost: 14, apply: (_c, d) => { d.freeRerolls += 1; } },
];
export const itemGoodById = (id) => WAVE_ITEMS.find((i) => i.id === id) || null;

/* ─────────────── 规则化角色 ───────────────
 * 与旧 HEROES 不同：这里每个角色带**正向特性 + 真实限制 + 起始武器 + 商店过滤**。
 * 倍率字段沿用 ArenaCore 构造器已有的 hero.hpMul / dmgMul / moveMul / atkMul 语义。       */
export const WAVE_CHARS = [
  {
    id: 'wanderer', label: '流浪者', desc: '没有限制，也没有特长。稳扎稳打。',
    hpMul: 1, dmgMul: 1, moveMul: 1, atkMul: 1,
    start: 'projectile', maxWeapons: 6, startMaterials: 0, luck: 0, harvest: 0,
    rerollMul: 1, shopFilter: () => true, unlock: 0,
  },
  {
    id: 'bulwark', label: '重壳', desc: '生命 +50%、伤害 -20%；商店不卖远程武器。',
    hpMul: 1.5, dmgMul: 0.8, moveMul: 0.9, atkMul: 1,
    start: 'orbit', maxWeapons: 6, startMaterials: 0, luck: 0, harvest: 0,
    rerollMul: 1, shopFilter: (g) => g.tag !== 'ranged', unlock: 0,
  },
  {
    id: 'gale', label: '疾风', desc: '生命 -30%、移速 +20%、攻速 +15%。',
    hpMul: 0.7, dmgMul: 1, moveMul: 1.2, atkMul: 1.15,
    start: 'projectile', maxWeapons: 6, startMaterials: 0, luck: 0, harvest: 0,
    rerollMul: 1, shopFilter: () => true, unlock: 0,
  },
  {
    id: 'gambler', label: '赌徒', desc: '幸运 +3、开局 20 材料、刷新半价。',
    hpMul: 1, dmgMul: 1, moveMul: 1, atkMul: 1,
    start: 'sword', maxWeapons: 6, startMaterials: 20, luck: 3, harvest: 0,
    rerollMul: 0.5, shopFilter: () => true, unlock: 0,
  },
  {
    id: 'harvester', label: '收割者', desc: '收获 +5、生命 -20%；起始毒雾。',
    hpMul: 0.8, dmgMul: 1, moveMul: 1, atkMul: 1,
    start: 'mist', maxWeapons: 6, startMaterials: 0, luck: 0, harvest: 5,
    rerollMul: 1, shopFilter: () => true, unlock: 0,
  },
  {
    id: 'onearm', label: '独臂', desc: '只能带 1 把武器，但伤害 +60%、攻速 +20%。',
    hpMul: 1, dmgMul: 1.6, moveMul: 1, atkMul: 1.2,
    start: 'laser', maxWeapons: 1, startMaterials: 10, luck: 0, harvest: 0,
    rerollMul: 1, shopFilter: () => true, unlock: 0,
  },
];
export const charById = (id) => WAVE_CHARS.find((c) => c.id === id) || WAVE_CHARS[0];

/** 商店配置：货架固定 4 格；刷新基础价随波数上涨；卖出返还 60%。 */
export const SHOP_SLOTS = 4;
export const SHOP_REROLL_BASE = 8;
export const SHOP_REROLL_GROWTH = 1.45;
export const SHOP_SELL_RATE = 0.6;
/** 波末结算：基础材料 + 波数加成 + 收获加成。 */
export const waveEndMaterials = (w, d) => Math.round((6 + w * 3 + d.harvest) * (1 + d.harvest * 0.02));
/** 未拾取材料的结转：下一波拾取时双倍发放，直到额度耗尽。 */
export const CARRY_DOUBLE = 2;
