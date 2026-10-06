// 元进度：localStorage 持久化的「灵魂」货币 + 长期成长（属性树 / 职业线 / 转生）。
//
// 这个模块**只管存读与灵魂账本**，不碰 ArenaCore、不碰 DOM 渲染。所有副作用都在函数里，
// 顶层不访问 localStorage —— 所以在 Node 测试里只要给 globalThis.localStorage 一个
// 最小 shim，就能无头验证整套 souls/成长逻辑（见 tests/meta.test.mjs）。
//
// 状态形状（阶段 5 起）：
//   { souls: number, levels: {[lineId]: number}, heroes: string[], hero: string, rebirth: number, title: string }
//   · souls   —— 结算发放，买属性等级 / 解锁英雄
//   · levels  —— 每条属性/职业/特殊线的当前等级（无限属性树靠 cost 指数增长自我封顶）
//   · heroes / hero —— 已用灵魂解锁的英雄 id 集合 / 当前选中英雄
//   · rebirth —— 转生次数（全局倍率 = 1 + 10% × rebirth）
//   · title   —— 由 rebirth 推出来的称号（仅展示用，可重算）
const DEFAULT_HEROES = ['wanderer'];
const DEFAULT_HERO = 'wanderer';

import { GROWTH_LINES, growthLineOf, GENERIC_LINES, SPECIAL_LINES, HEROES, heroById, tierOf, nextTierGap, TIERS, GROWTH_LVL_CAP } from './content.js';
import { SKINS, DEFAULT_SKIN } from './skins.js';
import { loadAccount } from './account.js';
import { DEFAULT_LOADOUT, normalizeLoadout, loadoutItemById, loadoutBuffs, LOADOUT_SLOTS, LOADOUT_ITEMS, isItemUnlocked, unlockText } from './loadout.js';

const KEY = 'wild.meta.v2';   // ★ 阶段 5 换 key：旧 v1 的 {unlocked,enabled} 已废弃，不做兼容迁移

/**
 * 第 n 次属性购买 → 灵魂花费。**n 是"全局第几次买"，不是"这条线的第几级"。**
 *
 * ★★ 阶段 7 最重要的一次口径修正 —— 记在这里，因为踩过一整轮：
 *
 *   原实现把 n 当成"单条线的等级"，于是"8 条线各买 6 级"和"1 条线买 50 级"
 *   的**总成本完全相同**（都是买 50 次）。但玩家实际看到的价格是"这条线现在几级"，
 *   于是所有人都去买每条线的第 1~6 级（最便宜的那几档）——
 *   实测总 50 级只要 **898 灵魂 ≈ 0.2 局**，属性树第一局就被点满，50 级上限形同虚设。
 *   尾部倍率改成 1.14 / 1.35 都救不回来：**在"分摊到 8 条线"的玩法下，
 *   50 次购买里只有 8 次落在尾部区间，倍率对总成本的影响不到 5%。**
 *
 *   ⟹ 正确口径：**花费只看"已经买了几级"（总等级），与买了哪条线无关。**
 *     这一下就把 50 级重新变贵，而且天然带出spec 的阶段晋升节奏：
 *       总 10 级 ≈ 260  灵魂（0.1 局）—— 第一局结束前就能摸到二阶
 *       总 25 级 ≈ 2.7k  灵魂（0.7 局）—— 二阶→三阶约 1 局
 *       总 50 级 ≈ 74k  灵魂（20 局满局）—— 四阶是真正的长期目标
 *     并且它让"先点满一条线还是雨露均沾"变成一个**有代价的决策**：
 *     均分 8 条线时每次都是当前最便宜的一档，专精则更早吃到高价档。
 *
 * ★ 前 12 档是显式数组（spec「10→12→15→...」的递增感）：
 *   等比公式在前几级给出的差额（10 → 11.4 → 13）玩家读不出差别；
 *   "10→12→15→18→22→26→31→36→42→48→55→63"是可感知的递增。
 *   之后按 ×1.14 续上（实测让总 50 级落在 20 局满局量级，不遥不可及也不随手满级）。
 */
const COST_STEPS = [10, 12, 15, 18, 22, 26, 31, 36, 42, 48, 55, 63];
const COST_TAIL_MUL = 1.14;

/**
 * @param totalLv **当前总属性等级**（0 表示还没买过），返回"买下一级"要多少灵魂。
 * ★ 参数名是 totalLv 而不是 level —— 传错的话会静默算出一个便宜 10 倍的价格，
 *   所以调用点一律用 totalLevels(m) 而不是 m.levels[id]。
 */
export function attrCost(totalLv) {
  const n = Math.max(0, Math.floor(Number(totalLv) || 0)) + 1;
  if (n <= COST_STEPS.length) return COST_STEPS[n - 1];
  return Math.round(COST_STEPS[COST_STEPS.length - 1] * Math.pow(COST_TAIL_MUL, n - COST_STEPS.length));
}

/** 由 levels 对象算总等级（不读存档——供 loadMeta 内部在组装返回值时调用，避免循环 loadMeta）。 */
function sumLevels(levels) {
  return Object.values(levels || {}).reduce((s, n) => s + (Number(n) || 0), 0);
}

/**
 * 按当前解锁规则过滤一个已归一的 loadout：未解锁的槽位清空。
 * ★ 设计为**读时过滤**而非"存时校验"：解锁条件全是单调递增的累计量
 *   （击杀/存活/灵魂/总等级），所以当前不满足 ⟹ 将来更不会满足，
 *   存下来也没有意义。读时过滤还能顺带修好"旧存档里存着现已锁住的 id"。
 */
function normalizeUnlocked(loadout, levels) {
  const stats = { totalLevels: sumLevels(levels) };
  const a = loadAccount();
  stats.kills = a.kills || 0;
  stats.survival = a.survival || 0;
  const tier = tierOf(stats.totalLevels);
  const out = { weapon: null, charm: null, sigil: null };
  for (const slot of LOADOUT_SLOTS) {
    const id = loadout[slot.id];
    const it = loadoutItemById(id);
    if (it && isItemUnlocked(it, { ...stats, souls: 0 }, tier)) out[slot.id] = it.id;
  }
  return out;
}

/** 读状态；任何异常（隐私模式 / 损坏 JSON）都回退到空状态，绝不抛。 */
export function loadMeta() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const o = JSON.parse(raw);
      const rebirth = Number(o.rebirth) || 0;
      const levels = (o.levels && typeof o.levels === 'object') ? { ...o.levels } : {};
      return {
        souls: Number(o.souls) || 0,
        levels,
        heroes: Array.isArray(o.heroes) && o.heroes.length ? o.heroes.slice() : DEFAULT_HEROES.slice(),
        hero: typeof o.hero === 'string' && heroById(o.hero) ? o.hero : DEFAULT_HERO,
        skin: typeof o.skin === 'string' && SKINS.some((s) => s.id === o.skin) ? o.skin : DEFAULT_SKIN,
        // ★ 阶段 7：读入时**按当前解锁规则过滤**。为什么必须在这里做：
        //   selectLoadout 已经拒绝未解锁件，但**旧存档**里可能存着当时的合法 id
        //   （例如某件装备的门槛后来被调高，或玩家在别的设备上配过）。
        //   若不在读入处过滤，core 的 applyLoadout 只看meta.loadout 认 id、不校验解锁，
        //   于是玩家会带着一件"其实没解锁"的装备进局—— 属于静默生效，不该留。
        loadout: normalizeUnlocked(normalizeLoadout(o.loadout), levels),
        rebirth,
        title: typeof o.title === 'string' ? o.title : titleOf(rebirth),
      };
    }
  } catch { /* 忽略，走默认 */ }
  // ★ 兜底分支也必须带 heroes / hero —— 否则全新设备（localStorage 为空）拿到的 m.heroes
  //   是 undefined，heroCatalog() 里 `m.heroes.includes(...)` 直接抛，标题页英雄选择在模块顶层崩溃。
  return { souls: 0, levels: {}, heroes: DEFAULT_HEROES.slice(), hero: DEFAULT_HERO, skin: DEFAULT_SKIN, loadout: { ...DEFAULT_LOADOUT }, rebirth: 0, title: titleOf(0) };
}

export function saveMeta(meta) {
  try { localStorage.setItem(KEY, JSON.stringify(meta)); } catch { /* 忽略 */ }
  return meta;
}

/** 结算发放灵魂（spec 阶段 7：击杀数 × 0.5 + 存活秒数 × 0.2）。
 *  ★ 口径从 `level + kills/10` 改成"**时长 + 击杀**"双因子，理由与数值见 README 阶段 7 段：
 *   旧公式只按等级+击杀给，一局跑满（Lv40 / 7000 杀）只给 40 + 700 = 740 灵魂，
 *   而属性树一级就要10~48 灵魂 ⟹ 攒满 50 级需要几十局，且"活得久"完全没有回报
 *   （存活时间是本作唯一真正的难度轴，却不进入货币口径）。
 *   新公式按实测中位局（7000 杀 / 600 秒）给 3500 + 120 = **3620**，一局约能推进 60~100 级购买力，
 *   与「属性树 50 级上限 + 阶梯花费」的总量（约 4.5 万灵魂 ≈ 13 局）匹配。
 *  · 击杀项按 0.5 取整到分（用 floor 落到整数，避免存档里出现小数灵魂）。
 *  · 存活项按 0.2/秒 —— 600 秒 = 120 灵魂，相对击杀项是零头，但它是"不杀也能拿"的兜底。 */
export function awardSouls(level, kills, survivalSec = 0) {
  const k = Math.max(0, Math.floor(Number(kills) || 0));
  const sec = Math.max(0, Number(survivalSec) || 0);
  const gained = Math.floor(k * 0.5 + sec * 0.2);
  const m = loadMeta();
  m.souls += gained;
  saveMeta(m);
  return { gained, souls: m.souls };
}

/** 某条线的**有效等级上限**：min(全局 50, 该线自己的 max)。
 *  阶段 7 新增 per-line max —— 狂怒 34 级恰好 100% 暴击率（见 content.js 的裁决③）。 */
export function lineCap(L) {
  if (!L) return 0;
  return Math.min(GROWTH_LVL_CAP, Number(L.max) || GROWTH_LVL_CAP);
}

/** 买一条成长线的下一级；灵魂不够 / 线不存在 / 已达等级上限则原样返回。 */
export function buyGrowth(id) {
  const m = loadMeta();
  const L = growthLineOf(id);
  if (!L) return m;
  const cur = Number(m.levels[id]) || 0;
  // ★ 阶段 7：等级硬上限 min(全局 50 / 该线自己的 max)。原来是"无上限、靠指数花费自我封顶"——
  //   显式上限让玩家看得见还剩几级，也让"总等级 10/25/50 晋升"这条规则有确定的终点。
  if (cur >= lineCap(L)) return m;
  // ★ 计价用**总等级**（全局第几次买），不是 cur+1（这条线的第几级）——见 attrCost 的注释块
  const cost = attrCost(totalLevels(m));
  if (m.souls < cost) return m; // 钱不够，no-op
  m.souls -= cost;
  m.levels[id] = cur + 1;
  saveMeta(m);
  return m;
}

/** 转生全局倍率（1 + 10% × 转生次数）。 */
export function rebirthMul(meta) {
  return 1 + 0.10 * (Number(meta && meta.rebirth) || 0);
}

/** 转生称号：0→一阶·荒野猎手 / 1→二阶·荒野霸主 / 2→三阶·荒野之神 / ≥3 沿用三阶封号。 */
export function titleOf(rebirth) {
  const r = Number(rebirth) || 0;
  if (r <= 0) return '一阶·荒野猎手';
  if (r === 1) return '二阶·荒野霸主';
  return '三阶·荒野之神';
}

/** 能否转生：任意 3 条属性线 ≥ Lv.25，且两条特殊线都已解锁（等级 ≥ 1）。 */
export function canRebirth(meta) {
  const levels = (meta && meta.levels) || {};
  const gen25 = GENERIC_LINES.filter((L) => (Number(levels[L.id]) || 0) >= 25).length;
  const bothSpecial = SPECIAL_LINES.every((L) => (Number(levels[L.id]) || 0) >= 1);
  return gen25 >= 3 && bothSpecial;
}

/** 执行转生：重置全部属性等级、转生次数 +1、刷新称号。返回新状态（不满足门槛则原样返回）。 */
export function doRebirth(meta) {
  const m = meta || loadMeta();
  if (!canRebirth(m)) return m; // 不满足门槛，no-op
  m.levels = {};
  m.rebirth = (Number(m.rebirth) || 0) + 1;
  m.title = titleOf(m.rebirth);
  saveMeta(m);
  return m;
}

/** 属性等级总和（首页进度条用）。 */
export function totalLevels(meta) {
  const levels = (meta && meta.levels) || {};
  return Object.values(levels).reduce((s, n) => s + (Number(n) || 0), 0);
}

// ───────── 阶段 4-5：英雄解锁 / 选择（与成长线同一套灵魂账本）─────────

/** 花灵魂解锁一个英雄（默认角色 cost=0，已恒在 heroes 里，无需解锁）。 */
export function unlockHero(id) {
  const m = loadMeta();
  const h = heroById(id);
  if (!h || h.cost === 0 || m.heroes.includes(id)) return m;
  if (m.souls < h.cost) return m; // 钱不够，no-op
  m.souls -= h.cost;
  m.heroes.push(id);
  saveMeta(m);
  return m;
}

/** 选中一个已解锁的英雄（未解锁则 no-op）。 */
export function selectHero(id) {
  const m = loadMeta();
  if (!m.heroes.includes(id)) return m;
  m.hero = id;
  saveMeta(m);
  return m;
}

/** 标题页渲染英雄卡用：把 HEROES 映射成带「已解锁/已选/买得起」标记的列表。 */
export function heroCatalog() {
  const m = loadMeta();
  return HEROES.map((h) => ({
    ...h,
    unlocked: m.heroes.includes(h.id) || h.cost === 0,
    selected: m.hero === h.id,
    affordable: m.souls >= h.cost,
  }));
}

// ───────── 阶段 6-2：皮肤选择（纯外观，无解锁花费，全部恒可选）─────────

/** 选中一个皮肤（未知 id 归一到默认，不开局崩）。 */
export function selectSkin(id) {
  const m = loadMeta();
  if (!SKINS.some((s) => s.id === id)) id = DEFAULT_SKIN;
  m.skin = id;
  saveMeta(m);
  return m;
}

/** 标题页渲染皮肤卡用：把 SKINS 映射成带「已选」标记的列表（皮肤无解锁门槛）。 */
export function skinCatalog() {
  const m = loadMeta();
  return SKINS.map((s) => ({ ...s, selected: m.skin === s.id }));
}

// ───────── 阶段 6-3：装备 / 局外配装（3 槽各选 1 件，纯数值加成，无解锁花费）─────────

/** 解锁判定用的统计快照（解锁门槛跨了 meta 与 account 两本账，这里合成一处）。 */
function unlockStats(m) {
  const a = loadAccount();
  return { kills: a.kills || 0, survival: a.survival || 0, souls: m.souls || 0, totalLevels: totalLevels(m) };
}

/** 当前阶段序号（总属性等级 10/25/50 → 0/1/2/3）。 */
export function currentTier(meta) {
  const m = meta || loadMeta();
  return tierOf(totalLevels(m));
}

/** 阶段信息：当前阶段名 + 距下一阶还差几级（已到顶 gap=null）。 */
export function tierInfo(meta) {
  const m = meta || loadMeta();
  const t = currentTier(m);
  const now = TIERS.find((x) => x.tier === t) || TIERS[0];
  return { tier: t, name: now.label, perk: now.perk, next: nextTierGap(totalLevels(m)) };
}

/**
 * 选中某槽的一件装备（id=null 表示清空该槽；未知 id / 串槽归一到 null，不开局崩）。
 * ★ 阶段 7：**未解锁的装备不可选**。这不是洁癖 —— 允许选一个没解锁的件，
 *   玩家会在标题页看到它"已装备"，进游戏却发现属性没变（applyLoadout 只读 meta.loadout，
 *   不校验解锁），这是最难查的一类"选了没反应"。
 */
export function selectLoadout(slot, id) {
  const m = loadMeta();
  if (!DEFAULT_LOADOUT.hasOwnProperty(slot)) return m; // 非法的槽名，no-op
  if (id == null) { m.loadout[slot] = null; saveMeta(m); return m; }
  const it = loadoutItemById(id);
  if (!it || it.slot !== slot) { m.loadout[slot] = null; } // 串槽 / 未知 id → 清空
  else if (!isItemUnlocked(it, unlockStats(m), currentTier(m))) { m.loadout[slot] = null; } // 未解锁 → 清空
  else { m.loadout[slot] = it.id; }
  saveMeta(m);
  return m;
}

/** 标题页渲染装备用：按槽分组，每件带「已选/已解锁/门槛」标记 + 一个「空」选项。 */
export function loadoutCatalog() {
  const m = loadMeta();
  const stats = unlockStats(m);
  const tier = currentTier(m);
  return LOADOUT_SLOTS.map((slot) => ({
    slot: slot.id,
    name: slot.name,
    items: [
      { id: null, name: '空', desc: '不装备', selected: !m.loadout[slot.id], unlocked: true, unlockText: '' },
      ...LOADOUT_ITEMS.filter((i) => i.slot === slot.id).map((i) => ({
        ...i,
        selected: m.loadout[slot.id] === i.id,
        unlocked: isItemUnlocked(i, stats, tier),
        unlockText: unlockText(i),
      })),
    ],
  }));
}

/** 标题页渲染成长面板用：把 GROWTH_LINES 映射成带等级/下一级花费/买得起标记的列表。 */
export function growthCatalog() {
  const m = loadMeta();
  return GROWTH_LINES.map((L) => {
    const lv = Number(m.levels[L.id]) || 0;
    // ★ 阶段 7：已达上限时 cost 报 null（而不是下一级的价钱）——面板据此把这一行
    //   标成"已满"，而不是让玩家看着一个买不动的数字发呆。
    const cap = lineCap(L);
    const maxed = lv >= cap;
    // ★ 与 buyGrowth 同一个口径：按总等级计价（这里 lv 只用来判"本行是否已满"）
    const cost = maxed ? null : attrCost(totalLevels(m));
    return {
      ...L,
      level: lv,
      cost,
      maxed,
      max: cap,
      affordable: !maxed && m.souls >= cost,
      unlocked: L.kind === 'special' ? lv >= 1 : lv > 0,
    };
  });
}
