/**
 * 长期进度：每日突袭 / 军械商声望 / 图鉴 / 商店特价 / 成就
 *
 * 纯逻辑模块 —— 不碰 DOM / localStorage / 音频，可在 Node 下直接单测。
 * 与 contracts.js 的分工一致：这里只回答"该给什么"，发钱发存档由 main.js 负责，
 * 于是"规则"能被 seed 复现、被断言，而不依赖浏览器。
 */

import {
  ITEM_IDS, ITEMS, RARITY_ORDER, REP, SHOP, ACHIEVEMENTS,
} from './config.js';
import { createRng, hashSeed } from './rng.js';

/* ============================ 每日突袭 ============================ */

/**
 * 当日每日突袭的种子（同一天必然相同，跨天必然不同）。
 *
 * 用 `YYYYMMDD` 拼成字符串再哈希，而不是 `Date.now()`：
 *   · 同一天无论几点进来都是同一张图 —— 玩家可以"记住这张图"，
 *     这正是每日挑战的意义（信息可积累）；
 *   · 跨时区也不会撞车，因为日期串来自本地日历。
 * @param {Date} [now] 当前时间
 * @returns {number} 32 位种子
 */
export function dailySeed(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return hashSeed(`soudache-daily-${y}${m}${day}`);
}

/**
 * 本地日期的 `YYYY-MM-DD` 串（存档里用来判断"今天打过没有"）。
 * @param {Date} [now] 当前时间
 * @returns {string} 日期串
 */
export function todayKey(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 今日每日突袭的完成状态（读存档，不改存档）。
 * @param {object} save 存档
 * @param {Date} [now] 当前时间
 * @returns {{key: string, played: boolean, extracted: boolean, bestScore: number}} 状态
 */
export function dailyStatus(save, now = new Date()) {
  const key = todayKey(now);
  const rec = (save && save.daily) || {};
  const sameDay = rec.date === key;
  return {
    key,
    played: sameDay,
    extracted: sameDay ? Boolean(rec.extracted) : false,
    bestScore: sameDay ? (rec.bestScore || 0) : 0,
  };
}

/* ============================ 军械商声望 ============================ */

/**
 * 声望经验 → 等级（1..maxLevel）。
 * @param {number} xp 声望经验
 * @returns {{lv: number, name: string, xp: number, nextXp: number, isMax: boolean}} 等级信息
 *   nextXp 为进入下一级所需经验（已满级时等于本级门槛），isMax 表示已顶级。
 */
export function repLevel(xp) {
  const total = Math.max(0, Number(xp) || 0);
  const table = REP.levels;
  let idx = 0;
  for (let i = 0; i < table.length; i += 1) {
    if (total >= table[i].xp) idx = i;
  }
  const cur = table[idx];
  const maxed = idx >= table.length - 1;
  return {
    lv: cur.lv,
    name: cur.name,
    xp: cur.xp,
    nextXp: maxed ? cur.xp : table[idx + 1].xp,
    isMax: maxed,
  };
}

/**
 * 一局结束后该获得多少声望经验。
 * @param {object} opts
 * @param {number} opts.lootValue 本局带出估值（阵亡为 0）
 * @param {boolean} opts.success 是否撤离成功
 * @returns {number} 经验
 */
export function repGain({ lootValue = 0, success = false } = {}) {
  const base = success ? REP.extractXp : REP.deathXp;
  return Math.max(0, Math.round(base + Math.max(0, lootValue) * REP.xpPerValue));
}

/**
 * 商店某件商品需要的声望等级。
 * @param {string} id 物品 id
 * @param {object} tier 门槛表（默认 config.SHOP_TIER）
 * @returns {number} 需要的等级（1 = 无门槛）
 */
export function requiredRep(id, tier) {
  const t = tier || {};
  return Math.max(1, Number(t[id]) || 1);
}

/**
 * 该商品当前是否处于"声望解锁"状态。
 * @param {string} id 物品 id
 * @param {number} lv 当前声望等级
 * @param {object} tier 门槛表
 * @returns {boolean} 是否可买
 */
export function repUnlocked(id, lv, tier) {
  return lv >= requiredRep(id, tier);
}

/* ============================ 商店每日特价 ============================ */

/**
 * 掷当天的特价清单。纯函数：同一 (shopIds, dateKey) 必然同一结果，
 * 所以刷新页面不会"重新抽一次"，玩家也没法靠刷新刷出想要的折扣。
 * @param {Array<string>} ids 在售物品 id
 * @param {string} dateKey 日期串（todayKey）
 * @param {object} [cfg] SHOP.daily 配置
 * @returns {Array<string>} 特价物品 id
 */
export function rollShopDaily(ids, dateKey, cfg = SHOP.daily) {
  const pool = (ids || []).slice();
  if (!pool.length) return [];
  const rng = createRng(hashSeed(`soudache-shop-${dateKey}`));
  const out = [];
  const count = Math.min(cfg.dealCount || 0, pool.length);
  for (let i = 0; i < count; i += 1) {
    const idx = Math.max(0, Math.min(pool.length - 1, Math.floor(rng.float(0, pool.length))));
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

/**
 * 商品当前实际售价（含特价折扣）。
 * @param {string} id 物品 id
 * @param {object} save 存档（读 save.shop.deals）
 * @param {object} def 物品定义
 * @returns {{price: number, discounted: boolean}} 价格
 */
export function shopPrice(id, save, def) {
  const base = Math.max(0, Number(def && def.value) || 0);
  const deals = (save && save.shop && save.shop.deals) || [];
  if (deals.includes(id)) {
    return { price: Math.round(base * (SHOP.daily.dealDiscount || 1)), discounted: true };
  }
  return { price: base, discounted: false };
}

/**
 * 今日该商品还剩几件可以买（限购只管特价商品，普通商品不限）。
 * @param {string} id 物品 id
 * @param {object} save 存档
 * @returns {number} 剩余可购件数（非特价商品返回 Infinity）
 */
export function shopRemain(id, save) {
  const deals = (save && save.shop && save.shop.deals) || [];
  if (!deals.includes(id)) return Infinity;
  const sold = (save.shop.sold && save.shop.sold[id]) || 0;
  return Math.max(0, (SHOP.daily.limitPerDay || 0) - sold);
}

/**
 * 把存档里的特价记录对齐到"今天"。返回是否发生了变更（调用方决定要不要存盘）。
 * @param {object} save 存档（会被就地修改）
 * @param {Date} [now] 当前时间
 * @returns {boolean} 是否变更
 */
export function refreshShopDaily(save, now = new Date()) {
  if (!save.shop) save.shop = { date: '', deals: [], sold: {} };
  const key = todayKey(now);
  if (save.shop.date === key) return false;
  save.shop.date = key;
  save.shop.deals = rollShopDaily(SHOP.items, key);
  save.shop.sold = {};
  return true;
}

/* ============================ 图鉴 ============================ */

/**
 * 图鉴总条目数（全部物品定义数，而不是硬编码 17 —— 加一件新物品就该自动 +1）。
 * @returns {number} 条目数
 */
export function codexTotal() {
  return ITEM_IDS.length;
}

/**
 * 记录一次"看见"（容器里翻到 / 地上捡到）。
 * @param {object} save 存档（就地修改）
 * @param {string} id 物品 id
 * @returns {boolean} 是否是新发现
 */
export function markCodexSeen(save, id) {
  if (!ITEMS[id]) return false;
  if (!save.codex) save.codex = { seen: {}, brought: {} };
  if (!save.codex.seen) save.codex.seen = {};
  if (save.codex.seen[id]) return false;
  save.codex.seen[id] = 1;
  return true;
}

/**
 * 记录一次"带出"（成功撤离时对背包内每件物品调用）。
 * @param {object} save 存档（就地修改）
 * @param {string} id 物品 id
 * @returns {boolean} 是否是首次带出
 */
export function markCodexBrought(save, id) {
  if (!ITEMS[id]) return false;
  if (!save.codex) save.codex = { seen: {}, brought: {} };
  if (!save.codex.brought) save.codex.brought = {};
  const first = !save.codex.brought[id];
  save.codex.brought[id] = (save.codex.brought[id] || 0) + 1;
  return first;
}

/**
 * 图鉴进度统计。
 * @param {object} save 存档
 * @returns {{seen: number, brought: number, total: number}} 进度
 */
export function codexStats(save) {
  const seen = Object.keys((save && save.codex && save.codex.seen) || {}).length;
  const brought = Object.keys((save && save.codex && save.codex.brought) || {}).length;
  return { seen, brought, total: codexTotal() };
}

/**
 * 图鉴条目列表（按稀有度、再按价值降序，供 UI 直接渲染）。
 * @param {object} save 存档
 * @returns {Array<{id: string, def: object, seen: boolean, brought: number}>} 条目
 */
export function codexEntries(save) {
  const seenMap = (save && save.codex && save.codex.seen) || {};
  const broughtMap = (save && save.codex && save.codex.brought) || {};
  return ITEM_IDS
    .map((id) => ({
      id,
      def: ITEMS[id],
      seen: Boolean(seenMap[id]),
      brought: broughtMap[id] || 0,
      rarityRank: RARITY_ORDER.indexOf(ITEMS[id].rarity),
    }))
    .sort((a, b) => (b.rarityRank - a.rarityRank)
      || ((b.def.value || 0) - (a.def.value || 0))
      || a.id.localeCompare(b.id));
}

/* ============================ 成就 ============================ */

/**
 * 从存档里取某项成就统计的当前值。
 * @param {object} save 存档
 * @param {string} stat 统计口径
 * @returns {number} 当前值
 */
export function achievementValue(save, stat) {
  const stats = (save && save.stats) || {};
  if (stat === 'codexSeen') return codexStats(save).seen;
  if (stat === 'currency') return Math.max(0, Number(save.currency) || 0);
  if (stat === 'streak') return Math.max(0, Number(stats.streak) || 0);
  if (stat === 'dailyCount') return Math.max(0, Number(stats.dailyCount) || 0);
  return Math.max(0, Number(stats[stat]) || 0);
}

/**
 * 把成就门槛里的 `'allItems'` 解析成实际数字。
 * @param {string|number} need 门槛
 * @returns {number} 数字门槛
 */
function needOf(need) {
  if (need === 'allItems') return codexTotal();
  return Math.max(0, Number(need) || 0);
}

/**
 * 检查成就，返回**本次新达成**的成就列表（调用方负责发钱与存档）。
 *
 * 幂等：达成过的成就在 save.achievements[id] 里留了时间戳，永远不会重复返回，
 * 因此这个函数可以每帧调用（实际只在结算时调一次）。
 * @param {object} save 存档（就地标记）
 * @param {number} [nowMs] 达成时间戳
 * @returns {Array<object>} 新达成的成就定义
 */
export function checkAchievements(save, nowMs = Date.now()) {
  if (!save.achievements) save.achievements = {};
  const out = [];
  for (const a of ACHIEVEMENTS) {
    if (save.achievements[a.id]) continue;
    if (achievementValue(save, a.stat) < needOf(a.need)) continue;
    save.achievements[a.id] = nowMs;
    out.push(a);
  }
  return out;
}

/**
 * 成就进度快照（供 UI 渲染进度条）。
 * @param {object} save 存档
 * @returns {Array<{def: object, value: number, need: number, done: boolean}>} 列表
 */
export function achievementProgress(save) {
  const done = (save && save.achievements) || {};
  return ACHIEVEMENTS.map((def) => {
    const need = needOf(def.need);
    return {
      def,
      value: Math.min(need, achievementValue(save, def.stat)),
      need,
      done: Boolean(done[def.id]),
    };
  });
}
