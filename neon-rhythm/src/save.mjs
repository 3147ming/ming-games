/**
 * 霓虹律动 NEON RHYTHM · 存档
 * ============================================================
 * 口径：
 *   · 两个 key —— 成绩墙 `neonrhythm.scores.v1`、设置 `neonrhythm.settings.v1`。
 *   · **损坏一律回落默认值**，绝不抛错：localStorage 里可能是上个版本的 JSON、
 *     可能被用户手改、可能是 `"undefined"`。音游启动崩溃比丢一次记录严重得多。
 *   · 纯函数（normalize 系 / merge 系）与 IO（load 系 / save 系）分开：
 *     前者可单测，后者靠注入 storage 也能单测（内存假实现）。
 *   · 本文件**不调用 Date.now()**：时间戳由调用方传入（`at`），
 *     这样"合并结果"这件事在单测里是完全确定的。
 */

export const SCORES_KEY = 'neonrhythm.scores.v1';
export const SETTINGS_KEY = 'neonrhythm.settings.v1';
export const SCHEMA_VERSION = 1;

/** 设置里的下落速度档位 → 下落时间倍率（越小越快）。 */
export const SPEED_PRESETS = { slow: 1.25, normal: 1, fast: 0.78 };

/** 默认设置。 */
export function defaultSettings() {
  return {
    version: SCHEMA_VERSION,
    volume: 0.8,
    muted: false,
    offsetMs: 0,
    speed: 'normal',
    trail: true,          // 拖尾
    flash: true,          // 判定爆闪
    vibrate: true,        // navigator.vibrate（设备不支持时静默忽略）
    practice: false,      // 练习模式（不记分）
    lastSong: 'neon-dash',
    lastDifficulty: 'normal',
    reducedMotionSeen: false,
  };
}

/** 空成绩墙。 */
export function emptyScores() {
  return { version: SCHEMA_VERSION, charts: {} };
}

const clamp01 = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : d;
};

/** 单个成绩条目的规范化：任何字段坏了就用默认，不让它污染成绩墙渲染。 */
export function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const score = Number(raw.score);
  if (!Number.isFinite(score) || score < 0) return null;
  const counts = raw.counts && typeof raw.counts === 'object' ? raw.counts : {};
  return {
    score: Math.max(0, Math.min(1000000, Math.round(score))),
    maxCombo: Math.max(0, Math.round(Number(raw.maxCombo) || 0)),
    accuracy: clamp01(raw.accuracy, 0),
    grade: typeof raw.grade === 'string' && raw.grade.length <= 2 ? raw.grade : 'D',
    fullCombo: raw.fullCombo === true,
    cleared: raw.cleared === true,
    plays: Math.max(1, Math.round(Number(raw.plays) || 1)),
    at: Number.isFinite(Number(raw.at)) ? Number(raw.at) : 0,
    counts: {
      perfect: Math.max(0, Math.round(Number(counts.perfect) || 0)),
      great: Math.max(0, Math.round(Number(counts.great) || 0)),
      good: Math.max(0, Math.round(Number(counts.good) || 0)),
      miss: Math.max(0, Math.round(Number(counts.miss) || 0)),
    },
  };
}

/**
 * 规范化成绩墙（**纯函数**）。接受 JSON.parse 的结果、字符串、null、垃圾。
 * 任何异常输入 → 空成绩墙。
 */
export function normalizeScores(raw) {
  let data = raw;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { return emptyScores(); }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return emptyScores();
  const charts = data.charts && typeof data.charts === 'object' && !Array.isArray(data.charts) ? data.charts : {};
  const out = emptyScores();
  for (const [key, entry] of Object.entries(charts)) {
    if (typeof key !== 'string' || !key.includes('@')) continue;
    const norm = normalizeEntry(entry);
    if (norm) out.charts[key] = norm;
  }
  return out;
}

/** 规范化设置（纯函数）。 */
export function normalizeSettings(raw) {
  const d = defaultSettings();
  let data = raw;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { return d; }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return d;
  return {
    version: SCHEMA_VERSION,
    volume: clamp01(data.volume, d.volume),
    muted: data.muted === true,
    offsetMs: Number.isFinite(Number(data.offsetMs))
      ? Math.max(-200, Math.min(200, Math.round(Number(data.offsetMs)))) : d.offsetMs,
    speed: Object.prototype.hasOwnProperty.call(SPEED_PRESETS, data.speed) ? data.speed : d.speed,
    trail: data.trail !== false,
    flash: data.flash !== false,
    vibrate: data.vibrate !== false,
    practice: data.practice === true,
    lastSong: typeof data.lastSong === 'string' && data.lastSong ? data.lastSong : d.lastSong,
    lastDifficulty: typeof data.lastDifficulty === 'string' && data.lastDifficulty ? data.lastDifficulty : d.lastDifficulty,
    reducedMotionSeen: data.reducedMotionSeen === true,
  };
}

/**
 * 把一次结算合并进成绩墙（**纯函数**，返回新对象）。
 *
 * 规则：
 *   · 练习模式不写入（但**仍然返回 best**，方便结算页显示"本次成绩"）；
 *   · 只有更好的成绩才覆盖，并记一次 plays；
 *   · 准确率更高但分数更低时**不覆盖分数** —— 分数是唯一权威，避免"刷准确率"把墙刷乱。
 *
 * @param {object} store  normalizeScores 之后的成绩墙
 * @param {string} key    谱面键 'song@difficulty'
 * @param {{score:number, maxCombo:number, accuracy:number, grade:string, counts:object,
 *          fullCombo?:boolean, cleared?:boolean}} result
 * @param {{at?:number, practice?:boolean}} [opts]
 */
export function mergeResult(store, key, result, opts = {}) {
  const base = normalizeScores(store);
  const entry = normalizeEntry({ ...result, plays: 1, at: opts.at || 0 });
  if (!entry) return { store: base, best: null, improved: false, wrote: false };
  const prev = base.charts[key] || null;
  const best = prev && prev.score >= entry.score ? prev : entry;
  const improved = !prev || entry.score > prev.score;
  if (opts.practice) {
    return { store: base, best: { ...best, isNew: false }, improved, wrote: false };
  }
  const merged = { ...best, plays: (prev ? prev.plays : 0) + 1, at: entry.at || (prev ? prev.at : 0) };
  return {
    store: { ...base, charts: { ...base.charts, [key]: merged } },
    best: merged,
    improved,
    wrote: true,
  };
}

/** 取某张谱面的最好成绩（没有则 null）。 */
export function bestFor(store, key) {
  const s = normalizeScores(store);
  return s.charts[key] || null;
}

/** 成绩墙总览（主界面用）：已玩张数 / 总音符 / 评级分布 / 最高分。 */
export function summarizeScores(store) {
  const s = normalizeScores(store);
  const entries = Object.entries(s.charts);
  const grades = { S: 0, A: 0, B: 0, C: 0, D: 0 };
  let score = 0;
  let combo = 0;
  let notes = 0;
  let plays = 0;
  for (const [, e] of entries) {
    grades[e.grade] = (grades[e.grade] || 0) + 1;
    score = Math.max(score, e.score);
    combo = Math.max(combo, e.maxCombo);
    plays += e.plays;
    notes += e.counts.perfect + e.counts.great + e.counts.good + e.counts.miss;
  }
  return { played: entries.length, grades, bestScore: score, bestCombo: combo, notes, plays };
}

/* ---------- IO（storage 可注入，测试用内存实现；浏览器用 localStorage） ---------- */

/** 内存 storage 假实现（单测与隐私模式下 localStorage 不可用时兜底）。 */
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

/** 拿一个可用的 storage：浏览器 localStorage → 内存兜底（永不为 null）。 */
export function resolveStorage(injected) {
  if (injected && typeof injected.getItem === 'function') return injected;
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  } catch { /* 隐私模式访问 localStorage 会抛 */ }
  return createMemoryStorage();
}

/** 读成绩墙（任何损坏 → 空墙）。 */
export function loadScores(storage) {
  const st = resolveStorage(storage);
  try { return normalizeScores(st.getItem(SCORES_KEY)); } catch { return emptyScores(); }
}

/** 写成绩墙；配额满/被禁用时静默失败（返回 false 供 UI 决定是否提示）。 */
export function saveScores(storage, store) {
  const st = resolveStorage(storage);
  try { st.setItem(SCORES_KEY, JSON.stringify(normalizeScores(store))); return true; } catch { return false; }
}

/** 读设置。 */
export function loadSettings(storage) {
  const st = resolveStorage(storage);
  try { return normalizeSettings(st.getItem(SETTINGS_KEY)); } catch { return defaultSettings(); }
}

/** 写设置。 */
export function saveSettings(storage, settings) {
  const st = resolveStorage(storage);
  try { st.setItem(SETTINGS_KEY, JSON.stringify(normalizeSettings(settings))); return true; } catch { return false; }
}

/** 清空全部本地数据（设置页的"重置"）。 */
export function clearAll(storage) {
  const st = resolveStorage(storage);
  try { st.removeItem(SCORES_KEY); st.removeItem(SETTINGS_KEY); return true; } catch { return false; }
}

export default {
  SCORES_KEY, SETTINGS_KEY, loadScores, saveScores, loadSettings, saveSettings,
  normalizeScores, normalizeSettings, mergeResult, summarizeScores,
};
