/**
 * 霓虹律动 NEON RHYTHM · 局内状态机
 * ============================================================
 * 这一层**只管"什么时候该发生什么"**：
 *   · 不碰 DOM、不碰 AudioContext、不读系统时钟 —— 时间一律由调用方传进来；
 *   · 时间来源是 `engine.time() * 1000`（音频时钟），不是帧计数；
 *   · 因此本文件可以在 node 里用"假时钟"把一整局跑完（tests/game.test.mjs 就是这么干的）。
 *
 * 阶段：
 *   idle → countdown（起播预留，engine 返回负时间）→ playing →（paused ⇄ playing）→ result
 */
import {
  createScoreState, applyVerdict, pickNote, findMissed, judgeHold,
  summarize, verdictFor, WINDOW_MS, VERDICTS,
} from './judge.mjs';

/** 结算前的收尾时间（毫秒）：最后一颗音符之后再等这么久才弹结算。 */
export const RESULT_TAIL_MS = 1600;
/** 连击里程碑（触发画面上的一次性特效）。 */
export const COMBO_MILESTONES = [10, 25, 50, 100, 200, 400];

/**
 * @param {object} o
 * @param {object} o.chart             generateChart 的产出
 * @param {number} [o.offsetMs]        判定校准偏移
 * @param {boolean} [o.practice]       练习模式（不记分，UI 负责不写存档）
 * @param {number} [o.leadInMs]        起播预留（与 engine.LEAD_IN 对齐）
 * @param {number} [o.windows]         判定窗口覆盖（调试用）
 */
export function createGame(o = {}) {
  const chart = o.chart;
  if (!chart || !Array.isArray(chart.notes)) throw new Error('createGame: 需要 chart');
  const notes = chart.notes;
  const offsetMs = Number(o.offsetMs) || 0;
  const windows = o.windows || WINDOW_MS;
  const leadInMs = Number.isFinite(Number(o.leadInMs)) ? Number(o.leadInMs) : 1200;
  const practice = o.practice === true;

  let phase = 'idle';
  let timeMs = -leadInMs;
  let score = createScoreState(notes.length);
  const consumed = new Set();               // 已结算的音符下标（打中或漏掉）
  const hitInfo = new Map();                // 下标 → { verdict, deltaMs, atMs }
  const activeHolds = new Map();            // lane → { note, pressMs }
  const history = [];                       // 本局判定流水（结算时间轴用）
  const comboEvents = [];                   // 连击里程碑
  let lastVerdict = null;
  let lastVerdictAt = -1e9;
  let missedCount = 0;
  let startedAtMs = 0;
  let endedAtMs = 0;

  /** 结算收尾是否已到：所有音符都结算过，或时间超过最后一颗 + 尾巴。 */
  function shouldEnd(t) {
    if (consumed.size >= notes.length) return t >= (notes.length ? notes[notes.length - 1].endTime * 1000 : 0) + 400;
    return t > (notes.length ? notes[notes.length - 1].endTime * 1000 : 0) + RESULT_TAIL_MS;
  }

  function commit(note, verdict, deltaMs, atMs) {
    consumed.add(note.i);
    hitInfo.set(note.i, { verdict, deltaMs, atMs });
    score = applyVerdict(score, verdict);
    history.push({ i: note.i, lane: note.lane, verdict, deltaMs: Math.round(deltaMs), atMs: Math.round(atMs) });
    lastVerdict = { verdict, lane: note.lane, deltaMs: Math.round(deltaMs), combo: score.combo };
    lastVerdictAt = atMs;
    if (verdict === 'miss') missedCount += 1;
    for (const m of COMBO_MILESTONES) {
      if (score.combo === m) comboEvents.push({ combo: m, atMs: Math.round(atMs) });
    }
    return lastVerdict;
  }

  const api = {
    chart,
    notes,
    practice,
    offsetMs,
    windows,

    get phase() { return phase; },
    get timeMs() { return timeMs; },
    get score() { return score; },
    get combo() { return score.combo; },
    get maxCombo() { return score.maxCombo; },
    get consumed() { return consumed; },
    get hitInfo() { return hitInfo; },
    get history() { return history; },
    get comboEvents() { return comboEvents; },
    get lastVerdict() { return lastVerdict; },
    get lastVerdictAt() { return lastVerdictAt; },
    get activeHolds() { return activeHolds; },
    get missedCount() { return missedCount; },
    get remaining() { return notes.length - consumed.size; },

    /** 这颗音符是否已经结算（渲染器据此决定还画不画）。 */
    isConsumed(i) { return consumed.has(i); },

    /** 长按已按住的比例 0..1（渲染长条用）。 */
    holdProgress(lane, now) {
      const h = activeHolds.get(lane);
      if (!h) return 0;
      const start = h.note.timeMs;
      const end = start + (h.note.holdMs || 0);
      if (end <= start) return 1;
      return Math.max(0, Math.min(1, (now - start) / (end - start)));
    },

    /** 开始（由 UI 在用户手势里调用，与 engine.start() 同一时刻）。 */
    begin(atMs = 0) {
      if (phase !== 'idle' && phase !== 'ready') return api;
      phase = 'countdown';
      startedAtMs = atMs;
      timeMs = -leadInMs;
      return api;
    },

    /** 每帧推进。返回本帧新增的 miss 列表（UI 拿来放 miss 音/震动）。 */
    tick(nowMs) {
      if (phase === 'idle' || phase === 'ready' || phase === 'paused' || phase === 'result') return [];
      timeMs = Number(nowMs) || 0;
      if (phase === 'countdown' && timeMs >= 0) phase = 'playing';

      const newlyMissed = [];
      if (phase === 'playing') {
        // ① 普通音符自动 miss
        for (const n of findMissed(notes, timeMs, consumed, { offsetMs, windows })) {
          if (n.kind === 'hold' && activeHolds.has(n.lane)) continue; // 正按着，等松手/尾判
          commit(n, 'miss', timeMs - n.timeMs, timeMs);
          newlyMissed.push(n);
        }
        // ② 长按：按过头还没松手 → 到尾部 +HOLD_LATE 之后自动结算（按"一直按住了"算）
        for (const [lane, h] of [...activeHolds]) {
          const tail = h.note.timeMs + (h.note.holdMs || 0);
          if (timeMs > tail + 400) {
            const v = judgeHold(h.pressMs, tail, h.note, offsetMs, windows);
            commit(h.note, v, h.pressMs - h.note.timeMs, timeMs);
            activeHolds.delete(lane);
          }
        }
        // ③ 收尾
        if (shouldEnd(timeMs)) {
          phase = 'result';
          endedAtMs = timeMs;
        }
      }
      return newlyMissed;
    },

    /**
     * 按键/触摸按下。
     * @returns {{verdict:string, note:object, pending:boolean, deltaMs:number}|null}
     */
    press(lane, atMs) {
      if (phase !== 'playing') return null;
      const hit = pickNote(notes, lane, atMs, { offsetMs, consumed, windows });
      if (!hit) {
        lastVerdict = { verdict: 'empty', lane, deltaMs: 0, combo: score.combo };
        lastVerdictAt = atMs;
        return null;
      }
      const { note, deltaMs, verdict } = hit;
      if (note.kind === 'hold') {
        activeHolds.set(lane, { note, pressMs: atMs });
        lastVerdict = { verdict, lane, deltaMs: Math.round(deltaMs), combo: score.combo, pending: true };
        lastVerdictAt = atMs;
        return { verdict, note, pending: true, deltaMs: Math.round(deltaMs) };
      }
      commit(note, verdict, deltaMs, atMs);
      return { verdict, note, pending: false, deltaMs: Math.round(deltaMs) };
    },

    /**
     * 松手（长按尾判）。
     * @returns {{verdict:string, note:object}|null}
     */
    release(lane, atMs) {
      const h = activeHolds.get(lane);
      if (!h) return null;
      activeHolds.delete(lane);
      const v = judgeHold(h.pressMs, atMs, h.note, offsetMs, windows);
      commit(h.note, v, h.pressMs - h.note.timeMs, atMs);
      return { verdict: v, note: h.note };
    },

    pause(atMs) {
      if (phase !== 'playing' && phase !== 'countdown') return api;
      api._resumePhase = phase;
      phase = 'paused';
      activeHolds.clear();
      timeMs = Number.isFinite(Number(atMs)) ? Number(atMs) : timeMs;
      return api;
    },

    resume() {
      if (phase !== 'paused') return api;
      phase = api._resumePhase || 'playing';
      return api;
    },

    /** 提前收尾（用户点"结束"）。 */
    finish(atMs) {
      if (phase === 'result' || phase === 'idle') return api;
      for (const n of notes) if (!consumed.has(n.i)) commit(n, 'miss', 0, Number(atMs) || timeMs);
      activeHolds.clear();
      endedAtMs = Number(atMs) || timeMs;
      phase = 'result';
      return api;
    },

    /** 本局实时读数（HUD 每帧用，不做对象拷贝的话 GC 会抖）。 */
    liveStats() {
      const judged = score.judged;
      const acc = judged > 0 ? VERDICTS.reduce((s, v) => s + score.counts[v] * (v === 'perfect' ? 1 : v === 'great' ? 0.7 : v === 'good' ? 0.4 : 0), 0) / judged : 0;
      return {
        phase, timeMs, judged, total: notes.length,
        combo: score.combo, maxCombo: score.maxCombo,
        accuracy: acc, counts: score.counts,
        progress: notes.length ? judged / notes.length : 0,
      };
    },

    /** 结算（纯函数 summarize 的出口）。 */
    result() {
      const s = summarize(score);
      return {
        ...s,
        chartKey: chart.key,
        songId: chart.songId,
        difficulty: chart.difficulty,
        practice,
        durationMs: Math.max(0, Math.round(endedAtMs - startedAtMs)),
        history,
        comboEvents,
        offsetMs,
      };
    },

    /** 判定一次"裸输入"（校准页用：不消费音符，只报这一下的偏差档位）。 */
    probe(deltaMs) {
      return verdictFor(deltaMs - offsetMs, windows);
    },
  };

  return api;
}

export default createGame;
