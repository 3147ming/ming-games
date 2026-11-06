/**
 * 霓虹律动 NEON RHYTHM · 判定与计分（**纯函数**）
 * ============================================================
 * 本文件是整个游戏"手感"的数学定义，因此必须：
 *   ① 无副作用、无时钟、无 DOM —— 时间由调用方以毫秒传入；
 *   ② 边界值可断言 —— ±45 / ±90 / ±140 **闭区间**，一毫秒之差必须落到下一档。
 *
 * 判定窗口（|delta| ≤ 阈值）：
 *   perfect  ±45ms
 *   great    ±90ms
 *   good     ±140ms
 *   其余（含未打击）→ miss
 *
 * delta 的定义（全工程统一，只此一处）：
 *   delta = (输入时刻 - 音符时刻) - 校准偏移
 *   偏移为正值 = "你习惯性偏晚"，于是把判定时刻前移，抵消掉你的手癖。
 *   校准滑杆范围 ±200ms，存 localStorage。
 *
 * 本文件禁止出现 document / localStorage / Date.now / Math.random
 * （tests/purity.test.mjs 直接扫源码锁死）。
 */

/** 判定窗口（毫秒，闭区间）。 */
export const WINDOW_MS = { perfect: 45, great: 90, good: 140 };

/** 校准偏移上下限（毫秒）。 */
export const MAX_OFFSET_MS = 200;

/** 官方顺序：由好到坏。UI 配色/结算表都按这个顺序排，不要在别处另写一遍。 */
export const VERDICTS = ['perfect', 'great', 'good', 'miss'];

/** 判定中文名。 */
export const VERDICT_LABEL = { perfect: 'PERFECT', great: 'GREAT', good: 'GOOD', miss: 'MISS' };

/** 准确率权重（miss 记 0 分但**计入分母** —— 否则漏打反而拉高准确率）。 */
export const WEIGHTS = { perfect: 1, great: 0.7, good: 0.4, miss: 0 };

/** 长按尾判：提前松手超过这个毫秒数就降档。 */
export const HOLD_EARLY_MS = 120;

/** 长按尾判的宽容上限（松手晚于此时刻视为"正常松手"）。 */
export const HOLD_LATE_MS = 400;

/** 分数构成：90% 准确率 + 10% 连击（满连满准 = 1,000,000）。 */
export const SCORE_ACC_PART = 900000;
export const SCORE_COMBO_PART = 100000;

/** 评级阈值（准确率为 0..1 的加权值）。S 额外要求零 miss。 */
export const RATING_THRESHOLDS = [
  { grade: 'S', min: 0.95, noMiss: true },
  { grade: 'A', min: 0.88, noMiss: false },
  { grade: 'B', min: 0.75, noMiss: false },
  { grade: 'C', min: 0.6, noMiss: false },
  { grade: 'D', min: 0, noMiss: false },
];

/** 需要显示的评级顺序。 */
export const GRADES = RATING_THRESHOLDS.map((r) => r.grade);

/** 校准偏移夹到 ±200ms；非数字一律当 0（坏存档不该让判定崩掉）。 */
export function clampOffset(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-MAX_OFFSET_MS, Math.min(MAX_OFFSET_MS, Math.round(n)));
}

/**
 * 应用校准偏移。
 * @param {number} rawDeltaMs 原始差（输入 - 音符）
 * @param {number} offsetMs   校准偏移
 */
export function applyOffset(rawDeltaMs, offsetMs = 0) {
  const d = Number(rawDeltaMs);
  if (!Number.isFinite(d)) return Infinity;
  return d - clampOffset(offsetMs);
}

/**
 * ★ 判定核心：|delta| 落在哪一档。**闭区间**，正好 ±45 算 perfect。
 * @param {number} deltaMs 已减过校准偏移的差值
 */
export function verdictFor(deltaMs, windows = WINDOW_MS) {
  const d = Math.abs(Number(deltaMs));
  if (!Number.isFinite(d)) return 'miss';
  if (d <= windows.perfect) return 'perfect';
  if (d <= windows.great) return 'great';
  if (d <= windows.good) return 'good';
  return 'miss';
}

/** 一步到位：输入时刻 + 音符时刻 + 校准 → 判定。 */
export function judgeAt(inputMs, noteMs, offsetMs = 0, windows = WINDOW_MS) {
  return verdictFor(applyOffset(inputMs - noteMs, offsetMs), windows);
}

/**
 * 长按判定（纯函数）：头部按下 + 尾部松手一起看。
 *   · 头部没进 good 窗口 → miss（压根没接住）
 *   · 尾部提前松手超过 HOLD_EARLY_MS → 降档到 good（连击**保留**，不搞"一松手全断"）
 *   · 松得晚于 HOLD_LATE_MS → 仍按头部判定（不能靠"按住不放"骗判定）
 */
export function judgeHold(pressMs, releaseMs, note, offsetMs = 0, windows = WINDOW_MS) {
  const head = judgeAt(pressMs, note.timeMs, offsetMs, windows);
  if (head === 'miss') return 'miss';
  const tailMs = note.timeMs + (note.holdMs || 0);
  const rel = Number(releaseMs);
  if (!Number.isFinite(rel)) return 'good';           // 没松手（异常输入）→ 保守给 good
  if (rel < tailMs - HOLD_EARLY_MS) return head === 'perfect' ? 'good' : head === 'great' ? 'good' : 'good';
  return head;
}

/** 长按是否算"松手太晚"（UI 只用于给个提示，不参与计分）。 */
export function holdReleasedLate(releaseMs, note, offsetMs = 0) {
  const tailMs = note.timeMs + (note.holdMs || 0);
  return applyOffset(Number(releaseMs) - tailMs, offsetMs) > HOLD_LATE_MS;
}

/* ---------- 谱面查找（纯函数：不消费、不改动传入数组） ---------- */

/**
 * 找这条轨上"最该被打"的音符：优先最早的那颗（而不是最近的），
 * 否则玩家按早一点点就会越过一颗本该能打中的音符。
 *
 * @param {Array} notes  全部音符（需按 timeMs 非递减）
 * @param {number} lane
 * @param {number} atMs  输入时刻
 * @param {{offsetMs?:number, consumed?:Set<number>, windows?:object, maxWindowMs?:number}} o
 * @returns {{note:object, deltaMs:number, verdict:string}|null}
 */
export function pickNote(notes, lane, atMs, o = {}) {
  const offsetMs = clampOffset(o.offsetMs || 0);
  const consumed = o.consumed || new Set();
  const windows = o.windows || WINDOW_MS;
  const maxWindow = o.maxWindowMs == null ? windows.good : o.maxWindowMs;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n.lane !== lane || consumed.has(n.i)) continue;
    const delta = applyOffset(atMs - n.timeMs, offsetMs);
    if (delta < -maxWindow) return null;   // 还没进窗口，后面的更晚 → 直接结束
    if (delta <= maxWindow) return { note: n, deltaMs: delta, verdict: verdictFor(delta, windows) };
    // delta > maxWindow：这颗已经错过了，继续往后找（可能是长按尾巴之外的另一颗）
  }
  return null;
}

/**
 * 找出"已经彻底错过"的音符下标（自动 miss 用）。
 * 判据：delta > good 窗口 ⟹ 再按也救不回来。
 */
export function findMissed(notes, nowMs, consumed, o = {}) {
  const offsetMs = clampOffset(o.offsetMs || 0);
  const windows = o.windows || WINDOW_MS;
  const out = [];
  for (const n of notes) {
    if (consumed && consumed.has(n.i)) continue;
    if (applyOffset(nowMs - n.timeMs, offsetMs) > windows.good) out.push(n);
  }
  return out;
}

/* ---------- 计分状态（纯函数：apply 返回**新对象**） ---------- */

/** 初始计分状态。 */
export function createScoreState(totalNotes = 0) {
  return {
    total: Math.max(0, totalNotes | 0),
    counts: { perfect: 0, great: 0, good: 0, miss: 0 },
    judged: 0,
    combo: 0,
    maxCombo: 0,
    holdBroken: 0,
  };
}

/** 应用一次判定，返回新状态（不改原对象）。 */
export function applyVerdict(state, verdict) {
  const v = VERDICTS.includes(verdict) ? verdict : 'miss';
  const counts = { ...state.counts, [v]: state.counts[v] + 1 };
  const combo = v === 'miss' ? 0 : state.combo + 1;
  return {
    ...state,
    counts,
    judged: state.judged + 1,
    combo,
    maxCombo: Math.max(state.maxCombo, combo),
  };
}

/** 连续应用一串判定（结算回放 / 单测方便）。 */
export function applyAll(state, verdicts) {
  return verdicts.reduce((s, v) => applyVerdict(s, v), state);
}

/** 加权准确率 0..1；一个都没判过返回 0（不是 NaN —— NaN 会污染 UI 与存档）。 */
export function accuracyOf(counts) {
  const total = VERDICTS.reduce((s, v) => s + (counts[v] || 0), 0);
  if (total <= 0) return 0;
  const got = VERDICTS.reduce((s, v) => s + (counts[v] || 0) * WEIGHTS[v], 0);
  return got / total;
}

/** 是否满连（零 miss）；没有音符时不算满连。 */
export function isFullCombo(state) {
  return state.judged > 0 && state.counts.miss === 0;
}

/** 是否全 PERFECT（All Perfect）。 */
export function isAllPerfect(state) {
  return state.judged > 0 && state.judged === state.counts.perfect;
}

/**
 * 分数：900000 × 准确率 + 100000 × (最大连击 / 总音符)。
 * 满连满准 = 1,000,000；漏一个音符同时扣准确率和连击，两处都疼。
 */
export function scoreOf(state) {
  const acc = accuracyOf(state.counts);
  const total = state.total > 0 ? state.total : state.judged;
  const comboPart = total > 0 ? Math.min(1, state.maxCombo / total) : 0;
  return Math.round(SCORE_ACC_PART * acc + SCORE_COMBO_PART * comboPart);
}

/**
 * 评级。S 需要"准确率 ≥95% 且零 miss"——高准确率但有 miss 的只给 A。
 * @param {number} accuracy 0..1
 * @param {{miss?:number}} [o]
 */
export function gradeOf(accuracy, o = {}) {
  const acc = Number.isFinite(accuracy) ? Math.max(0, Math.min(1, accuracy)) : 0;
  const miss = Number(o.miss) || 0;
  for (const r of RATING_THRESHOLDS) {
    if (acc >= r.min && (!r.noMiss || miss === 0)) return r.grade;
  }
  return 'D';
}

/** 结算面板需要的全部数字（纯函数，UI 只负责排版）。 */
export function summarize(state) {
  const acc = accuracyOf(state.counts);
  const miss = state.counts.miss;
  return {
    ...state,
    accuracy: acc,
    accuracyPct: Math.round(acc * 10000) / 100,
    score: scoreOf(state),
    grade: gradeOf(acc, { miss }),
    fullCombo: isFullCombo(state),
    allPerfect: isAllPerfect(state),
    cleared: acc >= 0.6,          // 及格线 = C 线以下算"没过"
  };
}

/** verdict → 单颗音符得分（0..1），结算里画条形图用。 */
export function verdictWeight(verdict) {
  return WEIGHTS[verdict] === undefined ? 0 : WEIGHTS[verdict];
}

export default { verdictFor, judgeAt, judgeHold, createScoreState, applyVerdict, summarize };
