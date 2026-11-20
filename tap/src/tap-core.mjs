/**
 * 《节奏拍打 TAP》纯逻辑核心 —— 曲谱 / 判定 / 评级 / 音频参数。
 * 不碰 DOM、不碰 AudioContext、不读 localStorage，Node 可直接单测。
 * 浏览器端以 <script type="module"> 引入；导出挂 globalThis.TapCore 供内联脚本用。
 */

/* ── 判定窗口（毫秒，绝对偏差） ─────────────────────────────────── */
export const WINDOWS = Object.freeze({ perfect: 45, great: 90, good: 140 });

/* ── 评级阈值（准度百分比） ─────────────────────────────────────── */
export const RANKS = Object.freeze([
  { rank: 'S', min: 95 }, { rank: 'A', min: 88 }, { rank: 'B', min: 75 },
  { rank: 'C', min: 60 }, { rank: 'D', min: 0 },
]);

/* ── 连击音高提升：25/50/100 连各 +2 半音，封顶 +4 ─────────────── */
export function comboPitchSemis(combo) {
  let s = 0;
  if (combo >= 25) s += 2;
  if (combo >= 50) s += 2;
  if (combo >= 100) s += 2;
  return Math.min(4, s);
}

/* ── 判定 ───────────────────────────────────────────────────────── */
/** deltaMs = 按键时间 - 音符时间（带符号）；返回判定档。 */
export function judge(deltaMs) {
  const d = Math.abs(deltaMs);
  if (d <= WINDOWS.perfect) return 'perfect';
  if (d <= WINDOWS.great) return 'great';
  if (d <= WINDOWS.good) return 'good';
  return 'miss';
}
export const JUDGE_SCORE = Object.freeze({ perfect: 100, great: 70, good: 40, miss: 0 });
export const JUDGE_ACC = Object.freeze({ perfect: 1, great: 0.7, good: 0.4, miss: 0 });

/* ── 曲谱生成器（全部纯函数，确定性） ───────────────────────────── */
const dna = (seed) => { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; }; };
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

/** 周期序列谱：pat[i] = [beat, lane, type?, dur?] */
function periodic(name, meta, seq, rep, lanes = 4, holdEvery = 0) {
  const notes = [];
  const ms = 60000 / meta.bpm;
  for (let i = 0; i < rep; i++) {
    const [beat, lane] = seq[i % seq.length];
    const t = Math.round(beat * ms);
    const hold = holdEvery && i % holdEvery === holdEvery - 1;
    const n = { t, lane: lane % lanes, type: hold ? 'hold' : 'tap' };
    if (hold) n.dur = Math.round(ms * 2);
    notes.push(n);
  }
  return buildChart(name, meta, lanes, notes);
}

/** 伪随机但确定性的谱（每日谱也走这里） */
function generated(name, meta, count, lanes = 4, seed = 1) {
  const r = dna(seed);
  const notes = [];
  const beat = 60000 / meta.bpm;
  let t = Math.round(meta.offsetMs || 1500);
  for (let i = 0; i < count; i++) {
    const step = [1, 0.5, 0.5, 1, 0.75][i % 5];
    t += Math.round(beat * step);
    const lane = Math.floor(r() * lanes);
    const hold = i % 13 === 12;
    const n = { t, lane, type: hold ? 'hold' : 'tap' };
    if (hold) n.dur = Math.round(beat * 1.5);
    notes.push(n);
  }
  return buildChart(name, meta, lanes, notes);
}

function buildChart(name, meta, lanes, notes) {
  notes.sort((a, b) => a.t - b.t);
  const last = notes.length ? notes[notes.length - 1] : { t: 0, dur: 0 };
  return {
    id: meta.id, name, bpm: meta.bpm, offsetMs: meta.offsetMs || 0,
    level: meta.level, diff: meta.diff, genre: meta.genre,
    lanes, notes,
    durationMs: last.t + (last.dur || 0) + 1400,
    noteCount: notes.length,
  };
}

/** 9 首内置曲谱：电子/鼓点/钢琴/8-bit/慢摇；≥2 首 6 键；含 hold。 */
export function buildSongs() {
  const charts = [
    periodic('星夜序曲', { id: 'star', bpm: 96, level: '简单', diff: 1, genre: '电子', offsetMs: 1500 },
      [[0,0],[1,1],[2,2],[3,3],[4,2],[5,1],[6,0],[7,2]], 48),
    periodic('霓虹心跳', { id: 'neon', bpm: 124, level: '中等', diff: 2, genre: '电子', offsetMs: 1500 },
      [[0,0],[0.5,2],[1,1],[1.5,3],[2,2],[2.5,0],[3,3],[3.5,1]], 64),
    periodic('电光风暴', { id: 'storm', bpm: 150, level: '困难', diff: 3, genre: '鼓点', offsetMs: 1400 },
      [[0,0],[0.5,1],[1,2],[1.5,3],[2,3],[2.5,2],[3,1],[3.5,0]], 80),
    periodic('月光钢琴', { id: 'moon', bpm: 88, level: '简单', diff: 2, genre: '钢琴', offsetMs: 1800 },
      [[0,0],[1,2],[2,1],[3,3],[4,0],[5,2],[6,1],[7,3]], 40, 4, 8),
    periodic('像素跃动', { id: 'pixel', bpm: 140, level: '中等', diff: 3, genre: '8-bit', offsetMs: 1400 },
      [[0,0],[0.5,2],[1,1],[1.5,3],[2,0],[2.5,3],[3,2],[3.5,1]], 72),
    periodic('慢摇时光', { id: 'slow', bpm: 72, level: '简单', diff: 1, genre: '慢摇', offsetMs: 2000 },
      [[0,0],[2,1],[4,2],[6,3]], 32, 4, 4),
    // 6 键曲
    generated('六轨霓虹', { id: 'hexneon', bpm: 132, level: '困难', diff: 4, genre: '电子', offsetMs: 1500 }, 90, 6, 3301),
    generated('六轨暴雨', { id: 'hexrain', bpm: 158, level: '专家', diff: 5, genre: '鼓点', offsetMs: 1300 }, 110, 6, 7703),
    generated('终章·山海', { id: 'finale', bpm: 118, level: '专家', diff: 5, genre: '钢琴', offsetMs: 1600 }, 96, 6, 9157),
  ];
  return charts;
}

/** 每日固定谱（种子=日期字符串哈希，跨设备同日同谱） */
export function dailyChart(dateStr, lanes = 4) {
  const meta = { id: 'daily', bpm: 108, level: '每日', diff: 3, genre: '混合', offsetMs: 1500 };
  return generated('每日谱面 ' + dateStr, meta, 72, lanes, hash('tap-' + dateStr));
}

/* ── 结算 ───────────────────────────────────────────────────────── */
/**
 * results: [{judge:'perfect'|'great'|'good'|'miss', delta:number}]
 * 返回 { rank, accuracy, counts, maxCombo, avgDelta, score, total }
 */
export function summarize(results) {
  const counts = { perfect: 0, great: 0, good: 0, miss: 0 };
  let accSum = 0, deltaSum = 0, deltaN = 0, combo = 0, maxCombo = 0, score = 0;
  for (const r of results) {
    const j = r.judge;
    if (!(j in counts)) continue;
    counts[j]++;
    accSum += JUDGE_ACC[j] || 0;
    score += JUDGE_SCORE[j] || 0;
    if (j === 'miss') { combo = 0; }
    else {
      combo++; if (combo > maxCombo) maxCombo = combo;
      score += Math.min(20, Math.floor(combo / 10)); // 连击加成封顶 +20
    }
    if (typeof r.delta === 'number' && j !== 'miss') { deltaSum += r.delta; deltaN++; }
  }
  const total = counts.perfect + counts.great + counts.good + counts.miss;
  const accuracy = total ? (accSum / total) * 100 : 0;
  const rank = (RANKS.find((x) => accuracy >= x.min) || RANKS[RANKS.length - 1]).rank;
  const avgDelta = deltaN ? deltaSum / deltaN : 0;
  return { rank, accuracy, counts, maxCombo, avgDelta, score, total };
}

/** 谱面音符数 = 四类判定总数（谱面完整性自检） */
export function chartIntegrity(chart, results) {
  const s = summarize(results);
  return { chartNotes: chart.noteCount, judged: s.total, ok: chart.noteCount === s.total };
}

/* ── 音频合成参数（浏览器据此建 oscillator/noise，不加载外部音频） ─ */
export const AUDIO = Object.freeze({
  kick: { type: 'sine', freq: 120, endFreq: 42, dur: 0.16, gain: 0.5 },
  snare: { type: 'noise', dur: 0.12, gain: 0.28, hp: 1200 },
  hat: { type: 'noise', dur: 0.05, gain: 0.16, hp: 6000 },
  lead: { type: 'triangle', dur: 0.2, gain: 0.22 },
  hitBoost: { db: 3, decayMs: 60 },
  missDuck: { gain: 0.35, freq: 90, dur: 0.2 },
});
export const LANE_TONES = Object.freeze([523.25, 659.25, 783.99, 1046.5, 1174.66, 1396.91]);

if (typeof globalThis !== 'undefined') globalThis.TapCore = {
  WINDOWS, RANKS, AUDIO, LANE_TONES,
  judge, summarize, comboPitchSemis, chartIntegrity,
  buildSongs, dailyChart,
};
