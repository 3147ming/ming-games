/**
 * 局外生涯纯逻辑层（P10）：成就 / 每日任务 / 商店额度 / 声望补给 / 本地委托单。
 *
 * 设计纪律：
 *   · 零 DOM、零 three、零全局随机源，所有随机感来自「日期种子」的确定性推导；
 *     本模块不碰 world.rng，局内同 seed 的序列逐位不变。
 *   · 所有发钱动作都必须经过 claimed / repClaims 幂等标记，重复调用返回 0。
 *   · 存档读写交给 storage.js；本模块只改传进来的 save 对象，主流程负责落盘。
 *   · 委托单是玩家个人的，撮合方是本地模拟收购商：没有共享物资总数、没有跨局账本。
 */
import { CAREER, SHOP, ITEMS } from './config.js';
import {
  createItem, autoPlace, hasSpace, itemValue, removeItemByUid,
} from './inventory.js';
import { sellQuote, isOrderDue, marketIndex } from './market.js';
import {
  defaultCareer, normalizeCareer, repLevel,
} from './storage.js';

/** 老档 / 手改坏值都在这里收敛，正常存档不做多余拷贝。 */
function ensureCareer(save) {
  if (!save || typeof save !== 'object') return defaultCareer();
  const c = save.career;
  if (!c || typeof c !== 'object' || !c.achievements || !Array.isArray(c.orders)
      || !c.quests || !c.supply || !c.counters) {
    save.career = normalizeCareer(c);
  }
  return save.career;
}

/**
 * 累计型成就指标的唯一取值口。stats 里没有的项从生涯计数器读，
 * 不在 UI 里另算第二份。
 */
export function achievementMetric(save, metric) {
  const c = ensureCareer(save);
  const s = (save && save.stats) || {};
  switch (metric) {
    case 'extracts': return Number(s.extracts) || 0;
    case 'raids': return Number(s.raids) || 0;
    case 'kills': return Number(s.kills) || 0;
    case 'bestScore': return Number(s.bestScore) || 0;
    case 'bestValue': return Number(s.bestValue) || 0;
    case 'codex': return Object.keys((save.codex && save.codex.brought) || {}).length;
    case 'bossDown': return Number(c.counters && c.counters.bossDown) || 0;
    default: return 0;
  }
}

/** 成就展示数据：未达成也给进度，达成未领奖的单列出来。 */
export function achievementView(save) {
  const c = ensureCareer(save);
  return CAREER.achievements.map((a) => ({
    ...a,
    value: Math.min(a.goal, achievementMetric(save, a.metric)),
    reached: Boolean(c.achievements[a.id]),
    claimed: Boolean(c.claimed[a.id]),
  }));
}

/** 只标记「新达成」，不发钱；返回本次新达成的定义列表。 */
export function evaluateAchievements(save) {
  const c = ensureCareer(save);
  const fresh = [];
  for (const a of CAREER.achievements) {
    if (c.achievements[a.id]) continue;
    if (achievementMetric(save, a.metric) >= a.goal) {
      c.achievements[a.id] = true;
      fresh.push(a);
    }
  }
  return fresh;
}

export function claimableAchievements(save) {
  return achievementView(save).filter((a) => a.reached && !a.claimed);
}

/** 幂等领奖：未达成 / 已领过都返回 0。 */
export function claimAchievement(save, id) {
  const c = ensureCareer(save);
  const def = CAREER.achievements.find((a) => a.id === id);
  if (!def || !c.achievements[id] || c.claimed[id]) return 0;
  c.claimed[id] = true;
  save.currency += def.reward;
  return def.reward;
}

export function claimAllAchievements(save) {
  return CAREER.achievements.reduce((sum, a) => sum + claimAchievement(save, a.id), 0);
}

/* ------------------------------ 每日任务 ------------------------------ */

/** 用日期种子做确定性洗牌，保证每天恰好取满 count 条且不重复。 */
export function rollDailyQuests(seed) {
  const pool = CAREER.quests.pool;
  const order = pool.map((_, i) => i);
  let x = (Number(seed) >>> 0) || 1;
  for (let i = order.length - 1; i > 0; i -= 1) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    const j = x % (i + 1);
    const t = order[i]; order[i] = order[j]; order[j] = t;
  }
  return order.slice(0, Math.min(CAREER.quests.count, pool.length)).map((i) => pool[i].id);
}

/** 换天即重置任务、进度与领取标记；同日重复调用不动已有进度。 */
export function ensureQuests(save, today) {
  const c = ensureCareer(save);
  const date = String(today);
  if (c.quests.date !== date || !Array.isArray(c.quests.list) || !c.quests.list.length) {
    c.quests = { date, list: rollDailyQuests(Number(date) || 1), done: {}, claimed: {} };
  }
  if (!c.quests.done || typeof c.quests.done !== 'object') c.quests.done = {};
  if (!c.quests.claimed || typeof c.quests.claimed !== 'object') c.quests.claimed = {};
  return c.quests;
}

function questDelta(ctx, metric) {
  const v = (k) => Math.max(0, Number(ctx && ctx[k]) || 0);
  switch (metric) {
    case 'extract': return ctx && ctx.success ? 1 : 0;
    case 'kills': return v('kills');
    case 'searches': return v('searches');
    case 'value': return ctx && ctx.success ? v('lootValue') : 0;
    case 'terminals': return v('terminals');
    case 'survived': return Math.round(v('survived'));
    default: return 0;
  }
}

/** 一局结束后累加进度；返回本次「刚好达标」的任务定义列表。 */
export function updateQuests(save, ctx, today) {
  const q = ensureQuests(save, today);
  const done = [];
  for (const id of q.list) {
    const def = CAREER.quests.pool.find((p) => p.id === id);
    if (!def) continue;
    const before = Math.min(def.goal, Number(q.done[id]) || 0);
    if (before >= def.goal) continue;
    const after = Math.min(def.goal, before + questDelta(ctx, def.metric));
    q.done[id] = after;
    if (after >= def.goal) done.push(def);
  }
  return done;
}

export function questView(save, today) {
  const q = ensureQuests(save, today);
  return q.list.map((id) => {
    const def = CAREER.quests.pool.find((p) => p.id === id);
    if (!def) return null;
    const done = Math.min(def.goal, Number(q.done[id]) || 0);
    return { ...def, done, complete: done >= def.goal, claimed: Boolean(q.claimed[id]) };
  }).filter(Boolean);
}

/** 幂等领取：未达标 / 已领过 / 不在今日列表都返回 0。 */
export function claimQuest(save, id, today) {
  const q = ensureQuests(save, today);
  if (!q.list.includes(id) || q.claimed[id]) return 0;
  const def = CAREER.quests.pool.find((p) => p.id === id);
  if (!def || (Number(q.done[id]) || 0) < def.goal) return 0;
  q.claimed[id] = true;
  save.currency += def.reward;
  return def.reward;
}

export function claimAllQuests(save, today) {
  const q = ensureQuests(save, today);
  return q.list.slice().reduce((sum, id) => sum + claimQuest(save, id, today), 0);
}

/* ------------------------------ 商店额度 ------------------------------ */

function ensureSupply(save, today) {
  const c = ensureCareer(save);
  const date = String(today);
  if (c.supply.date !== date) c.supply = { date, bought: {} };
  else if (!c.supply.bought || typeof c.supply.bought !== 'object') c.supply.bought = {};
  return c.supply;
}

/** 未配置额度的货品返回 Infinity（保持旧行为，不影响没有额度表的物品）。 */
export function shopRemaining(save, id, today) {
  const cap = SHOP.restock[id];
  if (cap == null) return Infinity;
  const st = ensureSupply(save, today);
  return Math.max(0, Number(cap) - (Number(st.bought[id]) || 0));
}

/** 购买成功后才扣额度；返回 false 表示当日已售罄。 */
export function consumeShopStock(save, id, today) {
  if (shopRemaining(save, id, today) < 1) return false;
  const st = ensureSupply(save, today);
  st.bought[id] = (Number(st.bought[id]) || 0) + 1;
  return true;
}

/* ------------------------------ 声望补给 ------------------------------ */

export function repRewardView(save) {
  const c = ensureCareer(save);
  const lv = repLevel((save.rep && save.rep.xp) || 0);
  return CAREER.repRewards.map((r) => ({
    ...r, unlocked: lv >= r.level, claimed: Boolean(c.repClaims[r.level]),
  }));
}

/** 幂等领取：等级不够 / 已领过都返回 0。等级仍由 repLevel 现算，不落盘。 */
export function claimRepReward(save, level) {
  const c = ensureCareer(save);
  const def = CAREER.repRewards.find((r) => r.level === Number(level));
  if (!def || c.repClaims[def.level]) return 0;
  if (repLevel((save.rep && save.rep.xp) || 0) < def.level) return 0;
  c.repClaims[def.level] = true;
  save.currency += def.reward;
  return def.reward;
}

export function claimAllRepRewards(save) {
  return CAREER.repRewards.reduce((sum, r) => sum + claimRepReward(save, r.level), 0);
}

/* ------------------------------ 本地委托单 ------------------------------ */

export function orderSeed(today) {
  return (Number(today) >>> 0) || 1;
}

/** 收购指数只按本地日期变，同一天全仓库共用一口价。 */
export function todayIndex(today) {
  return marketIndex(orderSeed(today));
}

/** 对仓库里的一件物资算一口价，不改动任何对象。 */
export function quoteForStashItem(save, uid, today) {
  const items = (save.stash && save.stash.items) || [];
  const item = items.find((it) => String(it.uid) === String(uid));
  if (!item) return null;
  const def = ITEMS[item.id];
  if (!def) return null;
  return { item, def, quote: sellQuote(itemValue(item), def.rarity, orderSeed(today)) };
}

/** 挂出委托单：物资先从仓库取出，到点由 settleOrders 结算，取消可退回。 */
export function createOrder(save, uid, now, today) {
  const c = ensureCareer(save);
  if (c.orders.length >= CAREER.consign.maxOrders) return { ok: false, reason: '委托位已满' };
  const found = quoteForStashItem(save, uid, today);
  if (!found) return { ok: false, reason: '物资不存在' };
  const { item, def, quote } = found;
  removeItemByUid(save.stash, item.uid);
  const t = Number(now) || 0;
  const order = {
    key: `o-${t}-${item.uid}`,
    uid: item.uid,
    id: item.id,
    name: item.name,
    qty: item.qty,
    rarity: item.rarity || def.rarity || 'common',
    icon: item.icon || def.icon,
    price: quote.net,
    index: quote.index,
    createdAt: t,
    settleAt: t + CAREER.consign.settleMs,
  };
  c.orders.push(order);
  return { ok: true, order, quote };
}

/** 撤单：优先把物资退回仓库，仓库满了才按既有出售比例折现。 */
export function cancelOrder(save, key) {
  const c = ensureCareer(save);
  const idx = c.orders.findIndex((o) => o.key === key);
  if (idx < 0) return { ok: false, reason: '委托单不存在' };
  const [order] = c.orders.splice(idx, 1);
  const def = ITEMS[order.id];
  if (!def) return { ok: true, refund: 0, returned: false };
  const back = createItem(def, order.qty);
  if (hasSpace(save.stash, back)) {
    autoPlace(save.stash, back);
    return { ok: true, refund: 0, returned: true };
  }
  const refund = Math.round(itemValue(back) * SHOP.sellRatio);
  save.currency += refund;
  return { ok: true, refund, returned: false };
}

/** 到期结算：一次性发钱并移出列表；重复调用不会二次入账。 */
export function settleOrders(save, now) {
  const c = ensureCareer(save);
  const due = c.orders.filter((o) => isOrderDue(o, now));
  if (!due.length) return [];
  c.orders = c.orders.filter((o) => !isOrderDue(o, now));
  const total = due.reduce((sum, o) => sum + Math.max(0, Number(o.price) || 0), 0);
  save.currency += total;
  return due;
}

export function orderView(save, now) {
  const c = ensureCareer(save);
  return c.orders.map((o) => ({
    ...o, due: isOrderDue(o, now), leftMs: Math.max(0, Number(o.settleAt) - Number(now)),
  }));
}

/* ------------------------------ 结算总入口 ------------------------------ */

/**
 * endRaid 在唯一那次 saveGame 之前调用：推进计数器、任务、成就与到点委托单。
 * 奖励本身不自动发，玩家在生涯屏领取（幂等），所以这里不会重复入账。
 */
export function settleRaidCareer(save, ctx, today, now) {
  const c = ensureCareer(save);
  if (ctx && ctx.bossDown) {
    c.counters.bossDown = (Number(c.counters.bossDown) || 0) + (Number(ctx.bossDown) || 0);
  }
  ensureQuests(save, today);
  ensureSupply(save, today);
  return {
    freshAchievements: evaluateAchievements(save),
    freshQuests: updateQuests(save, ctx || {}, today),
    settled: settleOrders(save, now),
  };
}

/** 顶栏角标：还有多少笔奖励可以领。 */
export function pendingRewardCount(save, today) {
  const ach = claimableAchievements(save).length;
  const quests = questView(save, today).filter((q) => q.complete && !q.claimed).length;
  const rep = repRewardView(save).filter((r) => r.unlocked && !r.claimed).length;
  return ach + quests + rep;
}
