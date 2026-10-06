/**
 * 本地排行榜（需求D）
 *
 * 只写 localStorage，不做任何网络请求。
 * 联机排行榜的落点在 account.mjs 的 NetBridge.fetchLeaderboard —— 本模块的
 * `submitLocal` 就是将来要被"本地写入 + 上报服务端"同时满足的位置。
 *
 * 纯逻辑（store 可注入）→ 单测可直接跑，不依赖浏览器。
 */
import { LEADERBOARD } from './config.mjs';

const memory = new Map();
let fallbackStore = null;

/** 默认 store：localStorage，不可用时退化到内存 */
function defaultStore() {
  if (fallbackStore) return fallbackStore;
  let ok = false;
  try {
    const k = '__ns_lb_probe__';
    window.localStorage.setItem(k, '1');
    window.localStorage.removeItem(k);
    ok = true;
  } catch { ok = false; }
  fallbackStore = {
    get(key) {
      try {
        if (ok) { const r = window.localStorage.getItem(key); return r ? JSON.parse(r) : null; }
        return memory.has(key) ? JSON.parse(memory.get(key)) : null;
      } catch { return null; }
    },
    set(key, val) {
      try {
        const raw = JSON.stringify(val);
        if (ok) window.localStorage.setItem(key, raw);
        else memory.set(key, raw);
        return true;
      } catch { return false; }
    },
  };
  return fallbackStore;
}

/** 从一次小游戏结算结果里取出"排行用的数值"（不同 kind 指标不同） */
export function scoreOf(kind, result) {
  if (!result) return 0;
  const payout = result.payout ?? 0;
  if (kind === 'basketball') return result.hits ?? 0; // 单局命中数
  return payout;                                       // 其余按收益
}

/**
 * 提交一条成绩。
 * @returns {{rank:number|null, isBest:boolean, entries:Array}}
 */
export function submitLocal(kind, entry, store = defaultStore()) {
  const all = store.get(LEADERBOARD.storageKey) ?? {};
  const list = Array.isArray(all[kind]) ? all[kind] : [];
  const value = entry.value ?? 0;
  const prevBest = list.length ? Math.max(...list.map((e) => e.value)) : -Infinity;

  const rec = {
    value,
    name: entry.name ?? '店员',
    night: entry.night ?? 1,
    at: entry.at ?? Date.now(),
    meta: entry.meta ?? '',
    /** 归属账号（重开时按它清除本账号条目；旧条目没有这个字段 → 视为历史遗留，不动它） */
    accountId: entry.accountId ?? null,
  };

  // 同分时更早达成的排前；分数高的排前
  const next = [...list, rec]
    .sort((a, b) => (b.value - a.value) || (a.at - b.at))
    .slice(0, LEADERBOARD.maxEntries);

  all[kind] = next;
  store.set(LEADERBOARD.storageKey, all);

  const rank = next.indexOf(rec); // -1 表示没挤进榜
  return {
    rank: rank >= 0 ? rank + 1 : null,
    isBest: value > prevBest,
    entries: next,
  };
}

/** 读某类小游戏的榜（按分数降序） */
export function readBoard(kind, store = defaultStore()) {
  const all = store.get(LEADERBOARD.storageKey) ?? {};
  return Array.isArray(all[kind]) ? all[kind] : [];
}

/** 全清（调试用） */
export function clearBoard(store = defaultStore()) {
  store.set(LEADERBOARD.storageKey, {});
}

/**
 * 清除**某个账号**在所有小游戏榜里的条目（账号重开时调用，见 reset.mjs）。
 *
 * 为什么不做成 clearBoard：三个账号共享同一份榜单数据，全清会连带删掉别人的成绩。
 * 没有 accountId 的历史条目**刻意保留** —— 那是加账号概念之前留下的，无法判断归属，
 * 宁可留着也不要错删别人的记录。
 *
 * @returns {{ removed:number }}
 */
export function clearForAccount(accountId, store = defaultStore()) {
  if (!accountId) return { removed: 0 };
  const id = String(accountId);
  const all = store.get(LEADERBOARD.storageKey) ?? {};
  let removed = 0;
  for (const kind of Object.keys(all)) {
    if (!Array.isArray(all[kind])) continue;
    const kept = all[kind].filter((e) => e && e.accountId !== id);
    removed += all[kind].length - kept.length;
    all[kind] = kept;
  }
  store.set(LEADERBOARD.storageKey, all);
  return { removed };
}
