// 波次模式（Brotato 化）配置与内容表 —— 纯数据 + 纯函数，零 DOM / 零 localStorage / 零依赖。
//
// ★ 设计纪律：旧「600 秒连续局」的 ARENA.WAVES / OFFERS / SHOP_ITEMS / HEROES 一个字都不动。
//   本文件只服务 WaveDirector；旧模式不 import 它，因此 378 单测 / sim / probe 基线逐位不变。
//   属性 apply(c, k) 直接写 ArenaCore 已有字段，与 content.js 的 offer.apply 同一套口径，
//   写完由 director 统一调 c._refreshClassBuffs() 刷新派生值。

export const WAVE_COUNT = 20;

/** 波次模式基础拾取半径（Brotato 口径：起手很小，靠「拾取范围」属性一点点扩大）。
 *  ★ 旧连续局的 ARENA.GEM_MAGNET=280 是「磁吸自动收割」口径，在固定小竞技场里
 *    等于全场宝石自动飞进兜里，走位拾取这条核心玩法直接消失。这里压到 90，
 *    玩家必须走过去捡，配合 i_magnet / WAVE_STATS.magnet 才有成长感。 */
export const WAVE_GEM_MAGNET = 90;

/** 波次模式的固定竞技场（Brotato 的核心地图口径）。
 *  旧连续局仍是无界地图；这里只给 WaveDirector 用，避免两套模式互相污染。 */
export const WAVE_ARENA = Object.freeze({
  W: 1180,
  H: 820,
  WALL: 34,
  EDGE_COLOR: 'rgba(236, 106, 84, 0.85)',
  FILL_COLOR: 'rgba(18, 20, 24, 0.92)',
});
/** 玩家/敌人可用的内圈半宽高（扣掉墙体厚度）。 */
export function waveArenaHalf() {
  return {
    x: WAVE_ARENA.W / 2 - WAVE_ARENA.WALL,
    y: WAVE_ARENA.H / 2 - WAVE_ARENA.WALL,
  };
}
/** 把坐标夹进固定竞技场内；r 是实体半径。 */
export function clampToWaveArena(x, y, r = 0) {
  const h = waveArenaHalf();
  return {
    x: Math.max(-h.x + r, Math.min(h.x - r, x)),
    y: Math.max(-h.y + r, Math.min(h.y - r, y)),
  };
}
/** 20 波时长（秒）—— **照抄 Brotato**：1-9 波每波 +5 秒，10-19 波固定 60 秒，第 20 波 90 秒。
 *  总计 1050 秒。旧实现自创成 20→90 线性递增、总计 1275 秒，比原版长 21%，节奏完全不同。 */
export const WAVE_SECS = [
  20, 25, 30, 35, 40, 45, 50, 55, 60,
  60, 60, 60, 60, 60, 60, 60, 60, 60, 60,
  90,
];
export const waveSec = (w) => WAVE_SECS[Math.min(WAVE_SECS.length - 1, Math.max(0, w - 1))];
/** 无尽模式：Brotato 20 波之后每波固定 60 秒。 */
export const ENDLESS_WAVE_SEC = 60;

/** Brotato **只有第 20 波是 Boss 波**（旧实现自创了 5/10/15/20 四个 Boss 波）。
 *  Danger 5 时双 Boss：复用 WILD 现成的 boss5 + boss4。 */
export const WAVE_BOSS = { 20: 'boss5' };
export const WAVE_BOSS_D5 = ['boss5', 'boss4'];

/** 精英/部落波：Brotato 按 Danger 决定 ——
 *  D0-1 没有；D2-3 只有 11 或 12 一波；D4-5 三波（11/12、14/15、17/18，第三波必为精英）。
 *  取区间左端（11/14/17）保证确定性，便于 sim 复现与单测。
 *  ★ 旧实现写成「第 3 波起每 4 波一次」，与 Brotato 完全无关。 */
export function eliteWavesOf(dangerLevel) {
  const d = dangerLevel | 0;
  if (d < 2) return [];
  if (d < 4) return [11];
  return [11, 14, 17];
}
export const isEliteWave = (w, dangerLevel = 0) => eliteWavesOf(dangerLevel).includes(w);

/** 稀有度（Brotato Tier 1-4）：mul 影响武器数值；价格由物品的基础价决定，
 *  不再额外乘「稀有度价格倍率」——那是旧实现自创的第二层通胀。 */
export const RARITIES = [
  { key: 'common', label: '普通', tier: 1, mul: 1, color: '#9a938a' },
  { key: 'uncommon', label: '精良', tier: 2, mul: 1.5, color: '#7ba64a' },
  { key: 'rare', label: '稀有', tier: 3, mul: 2.2, color: '#5b93d6' },
  { key: 'legendary', label: '传说', tier: 4, mul: 3.2, color: '#d9a94a' },
];
export const rarityOf = (i) => RARITIES[Math.max(0, Math.min(RARITIES.length - 1, i | 0))];

/** Brotato 原版商店稀有度表：**从 Tier 4 往下逐级判定**。
 *  Tier | 起始波 | 基础% | 每波+% | 上限%
 *   1   |   1    | 100   |   0    | 100
 *   2   |   2    |   0   |   6    |  60
 *   3   |   4    |   0   |   2    |  25
 *   4   |   8    |   0   | 0.23   |   8
 *  概率 = ((每波% × (当前波 − 起始波 − 1)) + 基础%) × (100% + 幸运)
 *  ★ 旧实现是「权重 × 波数 × 幸运」的线性乘法，Tier4 在第 1 波就能出，且没有上限。 */
const TIER_TABLE = [
  { tier: 4, minWave: 8, base: 0, perWave: 0.23, max: 8 },
  { tier: 3, minWave: 4, base: 0, perWave: 2, max: 25 },
  { tier: 2, minWave: 2, base: 0, perWave: 6, max: 60 },
  { tier: 1, minWave: 1, base: 100, perWave: 0, max: 100 },
];

export function rollRarity(rng, wave, luck = 0) {
  const lk = 1 + Math.max(0, luck) * 0.01;   // Brotato: (100% + Luck)，Luck 按百分点算
  for (const t of TIER_TABLE) {
    const p = Math.max(0, Math.min(t.max,
      (t.perWave * (wave - t.minWave - 1) + t.base) * lk));
    if (rng.next() * 100 < p) return t.tier - 1;
  }
  return 0;
}

/** Danger 0-5 —— **照抄 Brotato**：
 *  D0/D1/D2 敌人**没有任何数值加成**（区别只是新怪种与精英波）；
 *  D3 +12% HP/伤害；D4 +26%；D5 +40%，且第 20 波双 Boss（Boss 血量 ×0.75）。
 *  ★ 旧实现是 D1 +12% … D5 +80%，把「D1/D2 出新怪」错当成了数值膨胀，
 *    导致 D1 比原版难得多、D5 又远不够难。
 *  spawnMul 恒为 1：Brotato 的 Danger 不改敌人总数，只改种类与精英波。 */
export const DANGERS = [
  { level: 0, label: '危险 0', hpMul: 1.00, dmgMul: 1.00, spawnMul: 1.00, bossMul: 1.00 },
  { level: 1, label: '危险 1', hpMul: 1.00, dmgMul: 1.00, spawnMul: 1.00, bossMul: 1.00 },
  { level: 2, label: '危险 2', hpMul: 1.00, dmgMul: 1.00, spawnMul: 1.00, bossMul: 1.00 },
  { level: 3, label: '危险 3', hpMul: 1.12, dmgMul: 1.12, spawnMul: 1.00, bossMul: 1.12 },
  { level: 4, label: '危险 4', hpMul: 1.26, dmgMul: 1.26, spawnMul: 1.00, bossMul: 1.26 },
  // D5：+40%，但双 Boss 各 -25% ⟹ 单只血量系数 1.40 × 0.75 = 1.05
  { level: 5, label: '危险 5', hpMul: 1.40, dmgMul: 1.40, spawnMul: 1.00, bossMul: 1.05 },
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
/** 每波敌人总数 —— Brotato 实测曲线（1 波 5 只 / 8 波 494 只）。
 *  9 波之后原版没有公开表，按「60 秒一波、同屏 60」反推 ×1.15。 */
// ★ 原版 wave8 约 500 只（含分裂产物），但 WILD 的玩家 DPS 只有原版 1/5~1/10，
//   照抄数量会让屏幕永远清不空。这里按「同屏 60、每波 8~10 杀/秒」反推，
//   总量约为原版的一半，保证「打得动、但清不干净」的张力。
const WAVE_ENEMY_TOTAL = [
  5, 9, 16, 26, 38, 54, 74, 98,
  124, 152, 184, 220, 260, 304, 352, 404, 460, 520, 584, 800,
];
export const waveEnemyTotal = (w) => {
  const n = Math.max(1, w | 0);
  if (n <= WAVE_ENEMY_TOTAL.length) return WAVE_ENEMY_TOTAL[n - 1];
  return Math.round(WAVE_ENEMY_TOTAL[WAVE_ENEMY_TOTAL.length - 1]
    * Math.pow(1.15, n - WAVE_COUNT));
};

/** 同屏上限：Brotato 大约 30-60 只。
 *  ★ 旧实现直接沿用旧模式的 MAX_ENEMIES=220 ⟹ 同屏密度是原版 4 倍，
 *    配合「击杀掉落材料」还会把经济一起冲垮。 */
export const waveEnemyCap = (w) => Math.min(72, 22 + Math.round((w | 0) * 2.4));

/** 刷怪间隔 = 该波时长 / 该波敌人总数（Danger 不改密度，只改种类与精英波）。 */
export const waveSpawnInterval = (w) => Math.max(0.05, waveSec(w) / waveEnemyTotal(w));

/** 敌人 HP / 伤害成长 —— Brotato 是**指数**：wave1 ×1，wave20 约 ×300（HP）/ ×32（伤害）。
 *  ★ 旧实现是线性 `1 + 0.09×(w-1)`（wave20 仅 ×2.7），而玩家武器与属性是指数成长，
 *    后期必然碾压 —— 这就是「难度与自身强度失衡」的根因。 */
export const waveHpScale = (w) => Math.pow(1.2, Math.max(0, (w | 0) - 1));
// 伤害成长必须比 HP 缓得多：玩家只有 90 基础血，而 Boss 接触伤害还要 ×3。
// 1.06^19 ≈ 3.0 ⟹ wave20 普通怪 12、Boss 36，玩家能扛 2~3 次（Brotato 同量级）。
export const waveDmgScale = (w) => Math.pow(1.06, Math.max(0, (w | 0) - 1));

/* ─────────────── 4 选 1 属性池（20 条）───────────────
 * k = 稀有度倍率（1 / 1.5 / 2.2 / 3.2）。所有封顶沿用 ArenaCore 的硬上限，
 * 不做「选了没反应」的废牌：director 会先滤掉已达 max 的项。            */
export const WAVE_STATS = [
  { id: 'hp', name: '最大生命', unit: '+8', max: 10, apply: (c, k) => { const v = Math.round(8 * k); c.maxHp += v; c.hp += v; } },
  { id: 'regen', name: '生命回复', unit: '+0.3/s', max: 10, apply: (c, k) => { c.regenRate += 0.3 * k; } },
  { id: 'lifesteal', name: '生命偷取', unit: '+2%', max: 8, apply: (c, k) => { c.lifesteal = Math.min(1, c.lifesteal + 0.02 * k); } },
  // ★ 阶段12：+6% → +10%。Brotato 的伤害/攻速是按「每次升级明显有感」设计的，
  //   6% 在 20 次升级后只有 +120%，追不上敌人 HP 的指数成长。
  { id: 'dmg', name: '伤害', unit: '+10%', max: 12, apply: (c, k) => { c.dmgBase += 0.10 * k; } },
  { id: 'atk', name: '攻击速度', unit: '+8%', max: 10, apply: (c, k) => { c.attackInterval = Math.max(0.2, c.attackInterval / (1 + 0.08 * k)); } },
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
/** 12 把武器：6 把底层机制各有独立 step；另外 6 把是**同机制的进阶型号**
 *  （Brotato 同武器分 Tier / 变种的口径），用 `base` 指向底层机制、`pow` 给伤害倾向、
 *  `cd` 给攻速倾向。这样货架不再只有 6 把换来换去，凑同类合成与不同 build 有得玩。
 *  ★ 所有 weapon id 都要能被 weaponLabel 识别；base 必须是 content.js 里存在的机制 id。 */
export const WAVE_WEAPONS = [
  // ── 基础 6 把 ──
  { id: 'projectile', base: 'projectile', label: '投射物', desc: '自动锁定最近的敌人', cost: 14, tag: 'ranged' },
  { id: 'orbit', base: 'orbit', label: '环绕刃', desc: '利刃绕身旋转', cost: 16, tag: 'melee' },
  { id: 'laser', base: 'laser', label: '直斩', desc: '穿透光束', cost: 18, tag: 'ranged' },
  { id: 'sword', base: 'sword', label: '剑', desc: '飞行穿透剑气', cost: 18, tag: 'melee' },
  { id: 'mist', base: 'mist', label: '毒雾', desc: '脚下腐蚀地面', cost: 20, tag: 'element' },
  { id: 'sentry', base: 'sentry', label: '守望之瞳', desc: '自动炮台补刀', cost: 22, tag: 'engineering' },
  // ── 进阶型号 6 把（Brotato 武器池扩容：同机制、不同手感）──
  { id: 'smg', base: 'projectile', label: '连弩', desc: '高速连发，单发偏轻', cost: 22, tag: 'ranged', pow: 0.8, cd: 0.72 },
  { id: 'sniper', base: 'projectile', label: '贯穿枪', desc: '慢射速、高单发、强穿透', cost: 26, tag: 'ranged', pow: 1.9, cd: 1.5, pierce: 2 },
  { id: 'saw', base: 'orbit', label: '锯齿环', desc: '更密更快,贴身绞杀', cost: 24, tag: 'melee', pow: 1.25 },
  { id: 'flamer', base: 'mist', label: '烈焰', desc: '更频繁、更烫的地面', cost: 26, tag: 'element', pow: 1.4, cd: 0.7 },
  { id: 'railgun', base: 'laser', label: '磁轨炮', desc: '高伤瞬发光束', cost: 28, tag: 'ranged', pow: 1.7, cd: 1.35 },
  { id: 'drone', base: 'sentry', label: '蜂群无人机', desc: '部署更快、伤害略低', cost: 26, tag: 'engineering', pow: 0.85, cd: 0.68 },
];
export const weaponGoodById = (id) => WAVE_WEAPONS.find((w) => w.id === id) || null;
export const weaponBaseOf = (id) => {
  const w = weaponGoodById(id);
  return w ? (w.base || w.id) : id;
};

/** 道具：即时收益 / 小属性 / 功能性。apply(c, d) 里 d 是 WaveDirector。 */
export const WAVE_ITEMS = [
  { id: 'i_heal', label: '急救包', desc: '立刻回复 30 生命', cost: 10, apply: (c) => { c.healPlayer(30); } },
  { id: 'i_hp', label: '护心镜', desc: '最大生命 +12', cost: 16, apply: (c) => { c.maxHp += 12; c.hp += 12; } },
  { id: 'i_armor', label: '铁皮', desc: '护甲 +2', cost: 18, apply: (c) => { c.armor += 2; } },
  { id: 'i_dmg', label: '磨刀石', desc: '伤害 +8%', cost: 20, apply: (c) => { c.dmgBase += 0.08; } },
  { id: 'i_atk', label: '急速齿轮', desc: '攻速 +8%', cost: 20, apply: (c) => { c.attackInterval = Math.max(0.2, c.attackInterval / 1.08); } },
  { id: 'i_magnet', label: '磁石', desc: '拾取范围 +40', cost: 12, apply: (c) => { c.magnet += 40; } },
  // ★ 阶段12 经济校准：原来 cost 0 给 18 —— 每次刷到就等于白捡 18，直接把材料经济打穿。
  //   改成 14 买 22：净赚 8，仍是"缺钱时值得买"的选项，但不再是无脑免费。
  { id: 'i_material', label: '材料箱', desc: '立刻获得 22 材料', cost: 14, apply: (_c, d) => { d.materials += 22; } },
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
export const SHOP_SELL_RATE = 0.6;
/** Brotato：每个商店格 35% 出武器、65% 出道具。 */
export const SHOP_WEAPON_CHANCE = 0.35;
/** Brotato 保底：前两个商店各 2 把武器，接下来三个各 1 把，之后不再保底。 */
export const SHOP_GUARANTEED_WEAPONS = [2, 2, 1, 1, 1];

/** Brotato 原版价格公式：Final = (Base + Wave + Base×0.1×Wave) × Shop_Price。
 *  base 20：第 1 波 23、第 10 波 50、第 20 波 80。
 *  ★ 旧实现是 `base × 稀有度倍率 × (1 + wave×0.16)` —— 多了稀有度这一层，且没有 +Wave 项。 */
export const shopPrice = (base, wave, shopMul = 1) =>
  Math.max(1, Math.floor((base + wave + base * 0.1 * wave) * shopMul));

/** Brotato 原版刷新价：基数 Wave + 次数 × floor(max(0.5×Wave, 1))。
 *  wave1：2 / 每次 +1；wave10：15 / 每次 +5；wave20：28 / 每次 +9。
 *  ★ 旧实现是 `8 × 1.45^次数`，与波数无关 —— 前期太贵、后期太便宜。 */
export const rerollPrice = (wave, times, mul = 1) =>
  Math.max(1, Math.floor((wave + times * Math.floor(Math.max(0.5 * wave, 1))) * mul));

/** 危险等级的灵魂奖励：每级 +15%（Danger 5 = ×1.75）。
 *  只作用于结算灵魂，不改局内数值 —— 难度本身已经通过 HP/伤害/精英波体现。 */
export const DANGER_SOUL_MUL = 0.15;
/** 波末结算：基础材料 + 波数加成 + 收获加成。 */
/** 波末材料：波次模式的**主要收入**。
 *  ★ 阶段12 经济校准：原来 `6 + w*3`（第 20 波 66）只占一局收入的 2%，
 *    90% 材料来自击杀掉落 —— 而击杀数随同屏密度指数增长，收入曲线完全失控
 *    （实测 3.4 万材料、余额 3.3 万、商店只花掉 1.4 千）。
 *    改成 `22 + w*10`（第 1 波 32 / 第 20 波 222），让每波收入可预期，
 *    击杀掉落只作为"多打多拿"的零头。第 1 波必须给到 30+，否则开局
 *    连一把 16 材料的武器都买不起，会直接进入死亡螺旋（实测 4 局死 3 局）。 */
export const waveEndMaterials = (w, d) => Math.round((22 + w * 10 + d.harvest) * (1 + d.harvest * 0.02));
/** 未拾取材料的结转率：波末只把 **50%** 的经验值带进下一波（拾取时 1:1 补发）。
 *  ★ 阶段12 经济校准：原设计是「全额结转 + 双倍补发」——等于漏捡也不亏、还倒赚，
 *    实测一局光结转就能灌出 1.5 万材料，商店四格每波清空。
 *    改成 50% 后，漏捡仍然有补偿，但不再是"最优策略是别捡"。 */
export const CARRY_KEEP = 0.5;
