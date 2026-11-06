/**
 * 像素跑酷 PIXEL RUNNER · 存档（纯函数 + 可注入 storage）
 * ============================================================================
 * 键：
 *   pixelrunner.save.v1      最好成绩 / 统计 / 成就
 *   pixelrunner.settings.v1  音量 / 特效 / 操作方式
 *
 * 口径：**损坏一律回落默认值**，绝不抛错——跑酷启动崩溃比丢一次记录严重得多。
 * ============================================================================
 */

export const SAVE_KEY = 'pixelrunner.save.v1';
export const SETTINGS_KEY = 'pixelrunner.settings.v1';
export const SCHEMA_VERSION = 1;

/* ------------------------------ 默认值 ------------------------------ */

export function defaultSave() {
  return {
    version: SCHEMA_VERSION,
    best: { score: 0, distance: 0, coins: 0, nearMiss: 0 },
    totals: { runs: 0, distance: 0, coins: 0, nearMiss: 0, seconds: 0 },
    achievements: {},        // id → 解锁时间戳（0 = 未解锁）
    dailyBest: {},           // 'YYYY-MM-DD' → { score, distance }
  };
}

export function defaultSettings() {
  return {
    version: SCHEMA_VERSION,
    volume: 0.7,
    muted: false,
    music: true,
    sfx: true,
    fx: true,               // 粒子 / 拖尾 / 震屏
    vibrate: true,
    control: 'both',        // 'tap' | 'slide' | 'both'
  };
}

/* ------------------------------ 成就定义 ------------------------------ */

/**
 * 12 条成就，全部可由 summarize 的结果一次性判定（不进主循环）。
 * check(save, run) → boolean
 */
export const ACHIEVEMENTS = [
  { id: 'first-run', name: '初次起跑', desc: '完成第一局', check: (s) => s.totals.runs >= 1 },
  { id: 'dist-100', name: '一百米', desc: '单局跑出 100 米', check: (s) => s.best.distance >= 100 },
  { id: 'dist-500', name: '五百米', desc: '单局跑出 500 米', check: (s) => s.best.distance >= 500 },
  { id: 'dist-1000', name: '一千米', desc: '单局跑出 1000 米', check: (s) => s.best.distance >= 1000 },
  { id: 'coin-50', name: '拾荒者', desc: '单局收集 50 枚', check: (s) => s.best.coins >= 50 },
  { id: 'coin-200', name: '守财奴', desc: '累计收集 200 枚', check: (s) => s.totals.coins >= 200 },
  { id: 'near-20', name: '擦身而过', desc: '单局 20 次近失', check: (s) => s.best.nearMiss >= 20 },
  { id: 'runs-10', name: '常客', desc: '完成 10 局', check: (s) => s.totals.runs >= 10 },
  { id: 'runs-50', name: '老跑者', desc: '完成 50 局', check: (s) => s.totals.runs >= 50 },
  { id: 'total-10k', name: '万里长征', desc: '累计跑 10,000 米', check: (s) => s.totals.distance >= 10000 },
  { id: 'minute-5', name: '五分钟', desc: '单局存活 5 分钟', check: (s) => s.totals.seconds >= 300 },
  { id: 'score-5k', name: '五千分', desc: '单局得分 5000', check: (s) => s.best.score >= 5000 },
];

/* ------------------------------ 规范化 ------------------------------ */

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const nonneg = (v, d = 0) => Math.max(0, num(v, d));
const intNonneg = (v, d = 0) => Math.max(0, Math.round(num(v, d)));

function normalizeBest(raw) {
  const b = raw && typeof raw === 'object' ? raw : {};
  return {
    score: intNonneg(b.score),
    distance: intNonneg(b.distance),
    coins: intNonneg(b.coins),
    nearMiss: intNonneg(b.nearMiss),
  };
}

function normalizeTotals(raw) {
  const t = raw && typeof raw === 'object' ? raw : {};
  return {
    runs: intNonneg(t.runs),
    distance: intNonneg(t.distance),
    coins: intNonneg(t.coins),
    nearMiss: intNonneg(t.nearMiss),
    seconds: nonneg(t.seconds),
  };
}

function normalizeAchievements(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k !== 'string' || !k) continue;
    out[k] = intNonneg(v);
  }
  return out;
}

function normalizeDaily(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
    const d = v && typeof v === 'object' ? v : {};
    out[k] = { score: intNonneg(d.score), distance: intNonneg(d.distance) };
  }
  return out;
}

export function normalizeSave(raw) {
  let data = raw;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { return defaultSave(); }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return defaultSave();
  return {
    version: SCHEMA_VERSION,
    best: normalizeBest(data.best),
    totals: normalizeTotals(data.totals),
    achievements: normalizeAchievements(data.achievements),
    dailyBest: normalizeDaily(data.dailyBest),
  };
}

export function normalizeSettings(raw) {
  let data = raw;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { return defaultSettings(); }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return defaultSettings();
  const d = defaultSettings();
  const vol = num(data.volume, d.volume);
  return {
    version: SCHEMA_VERSION,
    volume: Math.max(0, Math.min(1, vol)),
    muted: data.muted === true,
    music: data.music !== false,
    sfx: data.sfx !== false,
    fx: data.fx !== false,
    vibrate: data.vibrate !== false,
    control: ['tap', 'slide', 'both'].includes(data.control) ? data.control : d.control,
  };
}

/* ------------------------------ 合并一局结果 ------------------------------ */

/**
 * 把一局的结果合并进存档（纯函数，不改原对象）。
 * @param {object} save   当前存档（可为原始 JSON）
 * @param {object} run    summarize() 的产出
 * @param {{now?: number, dateKey?: string}} [opts]
 * @returns {{save:object, isBest:boolean, unlocked:string[]}}
 */
export function mergeRun(save, run, opts = {}) {
  const base = normalizeSave(save);
  const now = Number(opts.now) || 0;
  const dateKey = typeof opts.dateKey === 'string' ? opts.dateKey : '';

  const r = {
    score: intNonneg(run && run.score),
    distance: intNonneg(run && (run.distance ?? run.meters)),
    coins: intNonneg(run && run.coins),
    nearMiss: intNonneg(run && run.nearMiss),
    seconds: nonneg(run && run.seconds),
  };

  const isBest = r.score > base.best.score
    || (r.score === base.best.score && r.distance > base.best.distance);

  const best = isBest
    ? { score: r.score, distance: r.distance, coins: r.coins, nearMiss: r.nearMiss }
    : { ...base.best };

  const totals = {
    runs: base.totals.runs + 1,
    distance: base.totals.distance + r.distance,
    coins: base.totals.coins + r.coins,
    nearMiss: base.totals.nearMiss + r.nearMiss,
    seconds: base.totals.seconds + r.seconds,
  };

  let dailyBest = { ...base.dailyBest };
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    const prev = dailyBest[dateKey] || { score: 0, distance: 0 };
    if (r.score > prev.score) {
      dailyBest[dateKey] = { score: r.score, distance: r.distance };
    }
    // 只留最近 60 天
    const keys = Object.keys(dailyBest).sort();
    if (keys.length > 60) {
      const drop = keys.slice(0, keys.length - 60);
      for (const k of drop) delete dailyBest[k];
    }
  }

  const achievements = { ...base.achievements };
  const next = { version: SCHEMA_VERSION, best, totals, achievements, dailyBest };
  const unlocked = [];
  for (const a of ACHIEVEMENTS) {
    /* 用 hasOwn 而不是真值判断：`now` 可能是 0（测试或系统时钟为 0），
       真值判断会把 "已解锁但时间戳为 0" 当成未解锁，导致重复发奖。 */
    if (Object.prototype.hasOwnProperty.call(achievements, a.id)) continue;
    try {
      if (a.check(next)) {
        achievements[a.id] = now || 1;   // 0 也存成 1，保证"已解锁"语义成立
        unlocked.push(a.id);
      }
    } catch { /* 单条成就坏了不影响别的 */ }
  }

  return { save: next, isBest, unlocked };
}

/* ------------------------------ 统计导出 ------------------------------ */

export function summarizeSave(save) {
  const s = normalizeSave(save);
  const total = ACHIEVEMENTS.length;
  const got = ACHIEVEMENTS.filter((a) => Object.prototype.hasOwnProperty.call(s.achievements, a.id)).length;
  return {
    best: s.best,
    totals: s.totals,
    achievements: got,
    achievementsTotal: total,
    achievementRate: total ? got / total : 0,
    dailyCount: Object.keys(s.dailyBest).length,
  };
}

/* ------------------------------ IO（storage 可注入） ------------------------------ */

export function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
  };
}

export function resolveStorage(injected) {
  if (injected && typeof injected.getItem === 'function') return injected;
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  } catch { /* 隐私模式 */ }
  return createMemoryStorage();
}

export function loadSave(storage) {
  const s = resolveStorage(storage);
  try { return normalizeSave(s.getItem(SAVE_KEY)); } catch { return defaultSave(); }
}

export function saveSave(storage, save) {
  const s = resolveStorage(storage);
  try {
    s.setItem(SAVE_KEY, JSON.stringify(normalizeSave(save)));
    return true;
  } catch { return false; }
}

export function loadSettings(storage) {
  const s = resolveStorage(storage);
  try { return normalizeSettings(s.getItem(SETTINGS_KEY)); } catch { return defaultSettings(); }
}

export function saveSettings(storage, settings) {
  const s = resolveStorage(storage);
  try {
    s.setItem(SETTINGS_KEY, JSON.stringify(normalizeSettings(settings)));
    return true;
  } catch { return false; }
}

export function clearAll(storage) {
  const s = resolveStorage(storage);
  try {
    s.removeItem(SAVE_KEY);
    s.removeItem(SETTINGS_KEY);
    return true;
  } catch { return false; }
}

/** 本地日期键（YYYY-MM-DD）。 */
export function todayKey(d = new Date()) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export default {
  ACHIEVEMENTS, defaultSave, defaultSettings, normalizeSave, normalizeSettings,
  mergeRun, summarizeSave, loadSave, saveSave, loadSettings, saveSettings, clearAll, todayKey,
};
