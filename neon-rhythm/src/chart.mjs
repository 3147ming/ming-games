/**
 * 霓虹律动 NEON RHYTHM · 谱面生成（**纯函数**）
 * ============================================================
 * 一句话：谱面不是"另画一遍"，而是对 `buildTimeline(song)` 的**确定性过滤**。
 *
 *   音频调度器读 events 里 kind==='lane' 的事件发声，
 *   谱面生成器读 events 里 kind==='lane' 的事件下落 ——
 *   同一个数组、同一个 `time` 字段 ⟹ 音画误差恒为 0（不需要 offset 去凑）。
 *
 * 难度只做两件事（因此三档谱面共享全部时间戳，天然对齐）：
 *   ① tier 过滤：easy 只要重音 'X'，normal 加 'x'/'H'，hard 再加大 'o'/'h'；
 *   ② 长按保留：easy 把长按降级为普通点按，normal/hard 保留原长按长度。
 *
 * 本文件禁止出现 document / localStorage / Date.now / Math.random
 * （由 tests/purity.test.mjs 直接扫源码锁死）—— 种子随机一律走 music.mjs 的 mulberry32。
 */
import {
  buildTimeline, mulberry32, hashSeed, songById, stepSeconds,
  DIFFICULTIES, DIFF_TIER, DIFFICULTY_LABEL,
} from './music.mjs';

export { DIFFICULTIES, DIFF_TIER, DIFFICULTY_LABEL };

/** 固定四轨（横屏居中四条泳道 / 竖屏满宽四条泳道，同一套轨道模型）。 */
export const LANES = 4;

/** 每张谱面至少这么多音符（单测锁这条，防止改作曲时把某张谱面写空）。 */
export const MIN_NOTES_PER_CHART = 40;

/** 各难度的默认下落时间（秒）：音符从出现到判定线要飞多久。越小越难读。 */
export const APPROACH_BY_DIFFICULTY = { easy: 1.75, normal: 1.45, hard: 1.2 };

/** 难度号（用于存档键与显示）。 */
export function difficultyRank(difficulty) {
  const i = DIFFICULTIES.indexOf(difficulty);
  return i < 0 ? -1 : i;
}

/** 谱面唯一键，例如 'neon-dash@hard'。存档与成绩墙都用它，避免两处拼字符串。 */
export function chartKey(songId, difficulty) {
  return `${songId}@${difficulty}`;
}

/** 键 → { songId, difficulty }；非法键返回 null。 */
export function parseChartKey(key) {
  if (typeof key !== 'string') return null;
  const at = key.lastIndexOf('@');
  if (at <= 0) return null;
  const songId = key.slice(0, at);
  const difficulty = key.slice(at + 1);
  if (difficultyRank(difficulty) < 0) return null;
  if (!songId) return null;
  return { songId, difficulty };
}

/**
 * 从时间轴里挑出某难度该出现的可打事件。
 * @returns {{events:Array, holdsKept:number, holdsDowngraded:number}}
 */
export function selectLaneEvents(timeline, difficulty) {
  const tier = DIFF_TIER[difficulty];
  if (tier === undefined) throw new Error(`selectLaneEvents: 未知难度 ${difficulty}`);
  const out = [];
  let holdsKept = 0;
  let holdsDowngraded = 0;
  for (const e of timeline.laneEvents) {
    if (e.tier > tier) continue;
    if (e.holdSteps > 0) {
      if (tier === 0) {
        // Easy：长按降级为点按（新手不该被"按住"这件事分心）
        holdsDowngraded += 1;
        out.push({ ...e, holdSteps: 0, holdMs: 0, dur: 0.15, downgradedFromHold: true });
      } else {
        holdsKept += 1;
        out.push(e);
      }
    } else {
      out.push(e);
    }
  }
  return { events: out, holdsKept, holdsDowngraded };
}

/**
 * ★ 生成一张谱面（纯函数；同 (songId, difficulty, seed) 必然逐字节相同）。
 *
 * @param {object|string} songOrId 曲目对象或 id
 * @param {'easy'|'normal'|'hard'} difficulty
 * @param {{seed?: string|number, timeline?: object}} [opts]
 * @returns {object} chart
 */
export function generateChart(songOrId, difficulty, opts = {}) {
  const song = typeof songOrId === 'string' ? songById(songOrId) : songOrId;
  if (!song) throw new Error(`generateChart: 找不到曲目 ${songOrId}`);
  const tier = DIFF_TIER[difficulty];
  if (tier === undefined) throw new Error(`generateChart: 未知难度 ${difficulty}`);

  const timeline = opts.timeline || buildTimeline(song);
  const seed = opts.seed === undefined ? `${song.id}:${difficulty}:v1` : opts.seed;
  const rnd = mulberry32(hashSeed(seed));

  const { events, holdsKept, holdsDowngraded } = selectLaneEvents(timeline, difficulty);

  const notes = events.map((e, i) => ({
    i,
    lane: e.lane,
    step: e.step,
    time: e.time,                 // 秒 —— 与音频**同一个数**
    timeMs: e.time * 1000,
    kind: e.holdSteps > 0 ? 'hold' : 'tap',
    holdSteps: e.holdSteps,
    holdMs: e.holdMs,
    endTime: e.time + (e.holdMs || 0) / 1000,
    midi: e.midi,
    chord: e.chord,
    tier: e.tier,
    variant: Math.floor(rnd() * 4), // 纯视觉扰动，让霓虹块不完全一样（不影响判定）
  }));

  const lastEnd = notes.reduce((m, n) => Math.max(m, n.endTime), 0);
  const approach = APPROACH_BY_DIFFICULTY[difficulty];

  return {
    key: chartKey(song.id, difficulty),
    songId: song.id,
    title: song.title,
    titleEn: song.titleEn,
    style: song.style,
    bpm: song.bpm,
    difficulty,
    tier,
    difficultyLabel: DIFFICULTY_LABEL[difficulty],
    seed: String(seed),
    stepSeconds: stepSeconds(song),
    duration: timeline.duration,       // 曲长（秒）
    lastNoteEnd: lastEnd,
    approach,                          // 默认下落时间（秒）
    lanes: song.lanes.length,
    accent: song.accent,
    accent2: song.accent2,
    notes,
    stats: {
      notes: notes.length,
      taps: notes.filter((n) => n.kind === 'tap').length,
      holds: notes.filter((n) => n.kind === 'hold').length,
      holdsKept,
      holdsDowngraded,
      density: notes.length / Math.max(1, timeline.duration),   // 音符/秒
      peakPerBar: peakNotesPerBar(notes),
      firstTimeMs: notes.length ? notes[0].timeMs : 0,
      lastTimeMs: notes.length ? notes[notes.length - 1].timeMs : 0,
      byLane: laneCounts(notes),
    },
  };
}

/** 每小节最多几个音符（"这段有没有突然糊一脸"的量化指标）。 */
export function peakNotesPerBar(notes) {
  const bars = new Map();
  for (const n of notes) {
    const bar = Math.floor(n.step / 16);
    bars.set(bar, (bars.get(bar) || 0) + 1);
  }
  let peak = 0;
  for (const v of bars.values()) if (v > peak) peak = v;
  return peak;
}

/** 四轨各自的音符数（用来判断"某条轨是不是被写空了"）。 */
export function laneCounts(notes) {
  const out = new Array(LANES).fill(0);
  for (const n of notes) if (n.lane >= 0 && n.lane < LANES) out[n.lane] += 1;
  return out;
}

/** 一次拿到一首歌的三档谱面（成绩墙/选曲页用）。 */
export function generateAllCharts(songOrId, opts = {}) {
  return DIFFICULTIES.map((d) => generateChart(songOrId, d, opts));
}

/**
 * 谱面自检（纯函数，UI 在加载时调一次，测试也调）。
 * 返回一组**问题字符串**，空数组 = 健康。不做抛错，避免一张坏谱面把游戏打死。
 */
export function validateChart(chart) {
  const problems = [];
  if (!chart || !Array.isArray(chart.notes)) return ['谱面为空'];
  if (chart.notes.length < MIN_NOTES_PER_CHART) problems.push(`音符过少：${chart.notes.length} < ${MIN_NOTES_PER_CHART}`);

  const seen = new Set();
  let prevTime = -Infinity;
  for (const n of chart.notes) {
    if (!(n.time >= prevTime)) problems.push(`时间非单调：音符 #${n.i} time=${n.time}`);
    prevTime = n.time;
    const k = `${n.lane}@${n.step}`;
    if (seen.has(k)) problems.push(`同轨同时刻双押：lane=${n.lane} step=${n.step}`);
    seen.add(k);
    if (n.lane < 0 || n.lane >= chart.lanes) problems.push(`轨号越界：${n.lane}`);
    if (n.time < 0 || n.time > chart.duration + 1e-6) problems.push(`音符越出曲长：#${n.i} time=${n.time} > ${chart.duration}`);
    if (n.kind === 'hold' && !(n.holdMs > 0)) problems.push(`长按长度非法：#${n.i}`);
  }

  // 同轨长按重叠 = 手感灾难，单列一条
  const byLane = new Map();
  for (const n of chart.notes) {
    if (!byLane.has(n.lane)) byLane.set(n.lane, []);
    byLane.get(n.lane).push(n);
  }
  for (const [lane, list] of byLane) {
    for (let i = 1; i < list.length; i++) {
      if (list[i].time < list[i - 1].endTime - 1e-9) {
        problems.push(`同轨长按重叠：lane=${lane} #${list[i - 1].i}→#${list[i].i}`);
      }
    }
  }
  return problems;
}

export default generateChart;
