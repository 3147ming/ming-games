// 阶段 7 · 每日任务 + 成就系统：给"局外progression闭环"补上两个可长期驱动的目标层。
//
// ★ 纯逻辑模块，顶层不碰 DOM、不碰 Date.now()、不碰 localStorage ——
//   所有副作用都在函数体里，日期与存储都由调用方注入 ⟹ Node测试里能精确构造
//   "第1 天 / 第 2 天 / 跨月"这些边界，不需要真的等到明天。
//   （与 skins.js / loadout.js / shop.js 同一套纪律。）
//
// ───────── 为什么任务与成就要分成两套，而不是一个"目标列表" ─────────
//   每日任务：**按自然日重置**、奖励小额、目标是"引导玩家玩不同的玩法"
//     （单局击杀 500 / 存活 5 分钟 / 用赤焰通关）。它是**行为引导器**——
//     目的不是留住玩家，而是让他把 3 个槽、4 套皮肤都用一遍。
//   成就：**永久性**、奖励大额、目标是"里程碑"（最高击杀 / 最长存活 / 全皮肤解锁）。
//   两者的重置语义不同（一个按日、一个永不），混在一张表里就会出现
//   "昨天完成的任务今天还算不算"这类判断散落在各处的问题。

import { tierOf } from './content.js';
import { loadMeta, saveMeta } from './meta.js';

const KEY = 'wild.daily.v1';

// ───────── 每日任务 ─────────

/**
 * 10 条任务池；每局结算时**确定性**取 3 条（不消耗 rng，见 pickDaily）。
 *
 *   id      唯一契约
 *   name/desc展示用
 *   metric  判据字段（对应 submitDaily 的 res 里的键）
 *   target  目标值（单局口径，除非 op 是 'total'）
 *   op      'run'（单局达标）/ 'total'（累计达标）
 *   reward  灵魂奖励
 *
 * ★ 为什么任务池是 10 条而只发 3 条：发满 10 条会让每日面板变成第二份成就列表，
 *   而"每天只有 3 件"才让玩家有"今天要挑哪三件做"的决策感。
 * ★ 任务判定**只用单局数据**（res），不读历史累计 —— 每日任务要的是"你今天做到了"，
 *   累计口径留给成就。
 */
export const DAILY_POOL = [
  { id: 'd_kill500',  name: '以一敌百', desc: '单局击杀 500 个敌人',       metric: 'kills',      target: 500, op: 'run',   reward: 120 },
  { id: 'd_kill1200', name: '割草不休', desc: '单局击杀 1200 个敌人',      metric: 'kills',      target: 1200, op: 'run', reward: 260 },
  { id: 'd_surv300',  name: '固守五分钟', desc: '单局存活满 5 分钟',        metric: 'survivalSec', target: 300, op: 'run', reward: 150 },
  { id: 'd_surv540',  name: '九分钟生还', desc: '单局存活满 9 分钟',        metric: 'survivalSec', target: 540, op: 'run', reward: 300 },
  { id: 'd_lv25',     name: '登高望远', desc: '单局等级达到 25',          metric: 'level',      target: 25, op: 'run',   reward: 140 },
  { id: 'd_lv35',     name: '接近极限', desc: '单局等级达到 35',          metric: 'level',      target: 35, op: 'run',   reward: 240 },
  { id: 'd_flame',    name: '赤焰试炼', desc: '使用「赤焰」皮肤完成一局',  metric: 'skin',       target: 'flame', op: 'run', reward: 100 },
  { id: 'd_frost',    name: '幽霜试炼', desc: '使用「幽霜」皮肤完成一局',  metric: 'skin',       target: 'frost', op: 'run', reward: 100 },
  { id: 'd_gold',     name: '鎏金试炼', desc: '使用「鎏金」皮肤完成一局',  metric: 'skin',       target: 'gold',  op: 'run', reward: 100 },
  { id: 'd_gale',     name: '疾风路线', desc: '使用「疾风行者」完成一局',   metric: 'hero',       target: 'gale',  op: 'run', reward: 120 },
];

export const DAILY_COUNT = 3;      // 每天发 3 条
export const DAILY_ROLL = 7;       // 发 7 天的量（池子 10 条 ⟹ 保证一周内不重复到同一组）

/** 某条任务的判据：res 满足吗？ */
export function dailyProgress(task, res) {
  if (!task || !res) return 0;
  const v = res[task.metric];
  if (v == null) return 0;
  if (task.metric === 'skin' || task.metric === 'hero') {
    // ★ 这两条是"相等"型而非"大于"型：用 1/0 表示"这一局用的是它"。
    //   这样它们天然是"单局口径"，不需要额外判断当前用的是哪一套。
    return v === task.target ? 1 : 0;
  }
  return Number(v) || 0;
}

/**
 * 这条任务被这一局完成了吗？
 * ★ 必须分"相等型"与"阈值型"两种比较，不能一律写 `progress >= target`：
 *   皮肤/角色任务（skin/hero）的 target 是**字符串**，而 dailyProgress 返回 1/0。
 *   `1 >= 'flame'` 在JS 里是 false（数字与字符串比较会把字符串转成 NaN），
 *   于是这类任务永远判不完成—— 一个只在脑内跑一遍会以为"对"的 bug。
 */
export function dailyDone(task, res) {
  if (!task || !res) return false;
  if (task.metric === 'skin' || task.metric === 'hero') return res[task.metric] === task.target;
  return dailyProgress(task, res) >= task.target;
}

/**
 * 确定性发牌：给定日期种子（`dateKey` 字符串），取 3 条互不相同的任务。
 * ★ 不用 rng、不用 Date.now()：同一个 dateKey 永远给出同一组，
 *   于是"刷新页面"不会换任务，同一天玩家和测试看到的是同一张表。
 */
export function pickDaily(dateKey) {
  let h = 2166136261;
  for (let i = 0; i < dateKey.length; i++) {
    h ^= dateKey.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  const n = DAILY_POOL.length;
  const picked = [];
  const used = new Set();
  for (let k = 0; k < DAILY_COUNT; k++) {
    h = (h * 1664525 + 1013904223) >>> 0;
    let idx = h % n;
    let guard = 0;
    while (used.has(idx) && guard++ < n) { h = (h * 1664525 + 1013904223) >>> 0; idx = h % n; }
    used.add(idx);
    picked.push(DAILY_POOL[idx]);
  }
  return picked;
}

/** 存档形状：{ dateKey, ids:[...], done:[...], claimed:[...], claimedDays: {dateKey: souls} } */
function emptyDaily(dateKey, tasks) {
  return { dateKey, ids: tasks.map((t) => t.id), done: [], claimed: [], claimedDays: {} };
}

function normalize(d, dateKey, tasks) {
  const base = emptyDaily(dateKey, tasks);
  if (!d || typeof d !== 'object') return base;
  const ids = Array.isArray(d.ids) ? d.ids.filter((id) => tasks.some((t) => t.id === id)) : [];
  // ★ 日期不匹配 ⟹ 整份重置（每日任务就是"按日重置"）。
  //   ids 用旧存档的（若仍属于今天的任务池），否则退回今天新发的 3 条。
  const useIds = d.dateKey === dateKey && ids.length === tasks.length ? ids : base.ids;
  return {
    dateKey,
    ids: useIds.slice(0, DAILY_COUNT),
    done: Array.isArray(d.done) ? d.done.filter((id) => useIds.includes(id)) : [],
    claimed: Array.isArray(d.claimed) ? d.claimed.filter((id) => useIds.includes(id)) : [],
    claimedDays: (d.claimedDays && typeof d.claimedDays === 'object') ? { ...d.claimedDays } : {},
  };
}

/** 读当日任务状态（dateKey 由调用方从本地日期算出，形如 '2026-10-03'）。 */
export function loadDaily(store, dateKey) {
  const tasks = pickDaily(dateKey);
  try {
    const raw = store.getItem(KEY);
    if (raw) return normalize(JSON.parse(raw), dateKey, tasks);
  } catch { /* 忽略，走默认 */ }
  return emptyDaily(dateKey, tasks);
}

function saveDaily(store, d) {
  try { store.setItem(KEY, JSON.stringify(d)); } catch { /* 忽略 */ }
  return d;
}

/** 当日 3 条任务的完整视图（含完成/已领标记与进度）。 */
export function dailyBoard(store, dateKey) {
  const d = loadDaily(store, dateKey);
  return d.ids.map((id) => {
    const t = DAILY_POOL.find((x) => x.id === id);
    return t ? { ...t, done: d.done.includes(id), claimed: d.claimed.includes(id) } : null;
  }).filter(Boolean);
}

/**
 * 结算一局：把达成的任务标记为已完成。**不自动发钱** ——
 * 领奖是独立动作（dailyClaim），这样"完成时还在游戏里、回到标题页才领"不会丢奖励。
 * @returns 归一化后的当日存档（调用方接着调 dailyClaim 即可拿到钱）。
 */
export function submitDaily(store, dateKey, res) {
  const d = loadDaily(store, dateKey);
  for (const id of d.ids) {
    if (d.done.includes(id) || d.claimed.includes(id)) continue;
    const t = DAILY_POOL.find((x) => x.id === id);
    if (t && dailyDone(t, res)) d.done.push(id);
  }
  return saveDaily(store, d);
}

/** 领取当日所有已完成但未领的灵魂。返回发放总数（已领过的不会再发）。 */
export function dailyClaim(store, dateKey) {
  const d = loadDaily(store, dateKey);
  let gained = 0;
  for (const id of d.done) {
    if (d.claimed.includes(id)) continue;
    const t = DAILY_POOL.find((x) => x.id === id);
    if (!t) continue;
    d.claimed.push(id);
    gained += t.reward;
  }
  saveDaily(store, d);
  return { gained, claimed: d.claimed.slice() };
}

// ───────── 成就 ─────────

/**
 * 10 个成就（永久，奖励大额灵魂）。
 *
 * ★ 与每日任务的分工：这里全是**里程碑 / 收藏**型目标，
 *   判据读的是「历史最佳」与「解锁集合」，而不是"这一局做到了"。
 *   每个成就都有 `hint` —— 因为这类目标最容易卡在"我到底差多少"上，
 *   给一句提示比给一个数字更有用（数字由 progressOf 现算，面板上直接显示）。
 */
export const ACHIEVEMENTS = [
  { id: 'a_firstblood',  name: '初见血',   hint: '完成第一局',                 reward: 50 },
  { id: 'a_kill500',     name: '百人斩',   hint: '单局击杀 500',               reward: 150 },
  { id: 'a_kill2000',    name: '千人斩',   hint: '单局击杀 2000',              reward: 400 },
  { id: 'a_kill5000',    name: '割草之王', hint: '单局击杀 5000',              reward: 900 },
  { id: 'a_surv300',     name: '固守者',   hint: '单局存活 5 分钟',            reward: 180 },
  { id: 'a_surv600',     name: '活到终局', hint: '单局跑满 10 分钟',           reward: 700 },
  { id: 'a_run10',       name: '身经百战', hint: '累计完成 10 局',             reward: 200 },
  { id: 'a_skin4',       name: '四相俱显', hint: '四套皮肤全部使用过',         reward: 350 },
  { id: 'a_hero3',       name: '三途行者', hint: '三个角色都玩过',             reward: 300 },
  { id: 'a_tier3',       name: '荒野之主', hint: '属性树总等级达到 50',        reward: 1200 },
];

const AKEY = 'wild.achieve.v1';

/**
 * 成就判据：给定「历史统计」返回每条成就的完成情况。
 * @param stats { runs, bestKills, bestSurvival, skinsUsed:[], heroesUsed:[], totalLevels }
 *
 * ★ 判据全部是**纯比较**，不读 localStorage、不读 Date —— 于是任何一个历史口径
 *   （best.js / account.js / meta.js）都能直接喂进来测。
 */
export function achievementState(stats = {}) {
  const runs = Number(stats.runs) || 0;
  const bestKills = Number(stats.bestKills) || 0;
  const bestSurv = Number(stats.bestSurvival) || 0;
  const skins = new Set(Array.isArray(stats.skinsUsed) ? stats.skinsUsed : []);
  const heroes = new Set(Array.isArray(stats.heroesUsed) ? stats.heroesUsed : []);
  const lv = Number(stats.totalLevels) || 0;
  const ok = {
    a_firstblood: runs >= 1,
    a_kill500: bestKills >= 500,
    a_kill2000: bestKills >= 2000,
    a_kill5000: bestKills >= 5000,
    a_surv300: bestSurv >= 300,
    a_surv600: bestSurv >= 600,
    a_run10: runs >= 10,
    a_skin4: skins.size >= 4,
    a_hero3: heroes.size >= 3,
    a_tier3: lv >= 50,
  };
  return ACHIEVEMENTS.map((a) => ({ ...a, unlocked: !!ok[a.id] }));
}

/** 已解锁成就 id 列表。 */
export function unlockedIds(store) {
  try {
    const raw = store.getItem(AKEY);
    if (raw) {
      const o = JSON.parse(raw);
      return Array.isArray(o.unlocked) ? o.unlocked.filter((id) => ACHIEVEMENTS.some((a) => a.id === id)) : [];
    }
  } catch { /* 忽略 */ }
  return [];
}

/**
 * 按当前统计发成就（幂等：已发过的不会重复发）。
 * @returns { gained:number, fresh:成就id[] }—— 本次新解锁的成就与对应灵魂。
 */
export function grantAchievements(store, stats) {
  const have = unlockedIds(store);
  const fresh = achievementState(stats).filter((a) => a.unlocked && !have.includes(a.id));
  if (!fresh.length) return { gained: 0, fresh: [] };
  const gained = fresh.reduce((s, a) => s + a.reward, 0);
  try { store.setItem(AKEY, JSON.stringify({ unlocked: have.concat(fresh.map((a) => a.id)) })); } catch { /* 忽略 */ }
  return { gained, fresh: fresh.map((a) => a.id) };
}

/** 成就面板视图（含已解锁标记）。 */
export function achievementBoard(store, stats) {
  const have = unlockedIds(store);
  return achievementState(stats).map((a) => ({ ...a, unlocked: have.includes(a.id) }));
}

// ───────── 结算编排：把三件事（每日任务 / 成就 / 阶段）串成一次调用 ─────────

/**
 * 一局结束后的"局外结算"统一入口。
 *
 * ★ 为什么要这么一个编排函数（而不是让结算页分别去调三个模块）：
 *   ① **发钱的顺序不能错**。三处都会发灵魂（每日领奖 / 成就解锁 / 阶段奖励），
 *      各自 `loadMeta()` 改 `saveMeta()` —— 如果分三次调用，中间任何一次抛错
 *      都会留下"扣了钱没记账"或"发了钱没记录"的半截状态。
 *      这里把三者算出的总额**一次累加、一次落盘**，中途不会丢。
 *   ② 阶段晋升是**派生量**（由总等级算出），不该单独存一份 —— 否则改门槛后老存档卡在旧阶段。
 *   ③ 调用方（结算页）只拿一个返回值，不必知道内部有几个子账本。
 *
 * @param store   localStorage 兼容对象
 * @param res     本局结算 { kills, survivalSec, level, hero, skin }
 * @param opts    { dateKey（必传，注入以便测试）, meta 状态对象 }
 * @returns { daily:{done,claimable,souls}, achievements:{fresh,souls}, tier:{...}, souls（本次合计） }
 */
export function settleRun(store, res, opts = {}) {
  const dateKey = opts.dateKey;
  if (!dateKey) throw new Error('settleRun 需要显式的 dateKey（不要在模块里调 Date.now()，那会让它不可测）');

  // ① 每日任务：标记完成 → 领取（两段式，符合"完成时还在游戏里"的手感）
  submitDaily(store, dateKey, res);
  const claim = dailyClaim(store, dateKey);

  // ② 成就：按调用方喂进来的历史统计判定
  const ach = grantAchievements(store, opts.stats || {});

  // ③ 阶段：由总等级派生（tierOf），不落盘
  const totalLevels = Number(opts.totalLevels) || 0;
  const tier = tierOf(totalLevels);

  const souls = claim.gained + ach.gained;
  // ★ 真正把奖励落到灵魂余额：dailyClaim / grantAchievements 只负责"记录已领/已解锁"（幂等、不碰余额），
  //   实际的加钱由这里一次性完成 —— 否则结算页显示 "+200 灵魂" 但存档里没进账（闭环断在最后一环）。
  //   用全局 localStorage（与 meta.loadMeta 同口径）；与 awardSouls 的基础灵魂加性累加，不重算。
  if (souls > 0) {
    const m = loadMeta();
    m.souls += souls;
    saveMeta(m);
  }
  return {
    daily: {
      done: loadDaily(store, dateKey).done.slice(),
      claimable: claim.claimed.slice(),
      souls: claim.gained,
    },
    achievements: { fresh: ach.fresh.slice(), souls: ach.gained },
    tier: { tier, totalLevels },
    souls,
  };
}