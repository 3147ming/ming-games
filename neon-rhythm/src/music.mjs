/**
 * 霓虹律动 NEON RHYTHM · 程序化音乐引擎
 * ============================================================
 * 设计原点（整个游戏最重要的一条口径）：**谱面与音乐同源**。
 *
 *   本文件里 `buildTimeline(song)` 是**唯一的事实来源**：
 *     · 音频调度器照着它把每个事件排进 Web Audio 的绝对时间轴；
 *     · 谱面生成器 chart.mjs 也从**同一个数组**里取 `kind === 'lane'` 的事件。
 *   两边用的是同一串 `event.time`（秒），所以"听到的"和"要打的"在数学上
 *   是同一个数 —— 误差恒等于 0，不存在"音画对齐"这个调参项。
 *
 *   反例（大多数音游的做法）：mp3 时间轴 + 手打谱面 + `offset` 硬凑。
 *   那种做法一旦换码率/换解码器就会漂，且漂多少无法在单测里断言。
 *
 * 结构：
 *   一、纯函数区 —— 无 AudioContext / 无 document / 无 Date.now / 无 Math.random。
 *       （噪声用 mulberry32 种子 PRNG 现算，所以连随机都是可复现的。）
 *   二、Web Audio 后端 —— 只做"发声"这一件事，AudioContext 由宿主在用户手势里建。
 *   三、引擎本体 —— 前瞻调度 + 暂停/恢复 + 校准偏移所需的音频时钟。
 *
 * 作曲记谱约定（16 分音符网格，一小节 16 格）：
 *   '.'  空
 *   'X'  重音   → Easy / Normal / Hard 都出（Easy 的全部内容）
 *   'x'  常规   → Normal / Hard 出
 *   'o'  细碎   → 仅 Hard 出
 *   'H'  长按起点（长度 song.holdLen 格）→ Normal / Hard
 *   'h'  长按起点                        → 仅 Hard
 * 三档难度因此**只做过滤、不做重排**：同一首歌的三张谱面共享全部时间戳，
 * 难度差 = 密度差 + 长按差，这既省事又保证了"同源"这条性质在三档上都成立。
 */

/* ============================================================
 *  一、纯函数区（node --test 直接可跑）
 * ========================================================== */

/** 三档难度（顺序即"由易到难"，chart/judge 都依赖这个顺序）。 */
export const DIFFICULTIES = ['easy', 'normal', 'hard'];

/** 难度中文名（UI 与报告共用，避免两处写死不同文案）。 */
export const DIFFICULTY_LABEL = { easy: 'EASY', normal: 'NORMAL', hard: 'HARD' };

/** 难度 → 层级号。字符层级 ≤ 该值即出现在这张谱面里。 */
export const DIFF_TIER = { easy: 0, normal: 1, hard: 2 };

/** 记谱字符 → 层级。未列出的字符（含 '.'）视为空。 */
export const TIER_OF_CHAR = { X: 0, x: 1, o: 2, H: 1, h: 2 };

/** 长按字符集合。 */
export const HOLD_CHARS = ['H', 'h'];

/** 一个小节多少格（16 分音符）。整个引擎只有这一个网格常量。 */
export const STEPS_PER_BAR = 16;

/** 十二平均律 → 频率。 */
export function midiToHz(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/* ---------- 确定性伪随机（禁用 Math.random 之后仍需要噪声） ---------- */

/** 字符串 → 32 位种子（FNV-1a）。 */
export function hashSeed(input) {
  let h = 2166136261 >>> 0;
  const s = String(input);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32：小而均匀的确定性 PRNG，返回 () => [0,1)。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ============================================================
 *  曲库：4 首，风格/速度/调性各不相同
 * ------------------------------------------------------------
 *  lanes[i] 固定绑定和弦的第 i 个音（lane2/lane3 高八度），
 *  所以四个轨同时响时天然是"和弦音堆叠"而不是随机音高 —— 这是
 *  "四轨乱按也不难听"的全部秘密，也是音游必须的容错。
 * ========================================================== */

export const SONGS = [
  {
    id: 'neon-dash',
    title: '霓虹疾走',
    titleEn: 'NEON DASH',
    style: '轻快',
    bpm: 128,
    bars: 24,
    holdLen: 4,
    accent: '#00e5ff',
    accent2: '#ff2fd0',
    progression: [
      { name: 'Am', bass: 45, tones: [57, 60, 64, 67] },
      { name: 'F', bass: 41, tones: [53, 57, 60, 65] },
      { name: 'C', bass: 48, tones: [55, 60, 64, 67] },
      { name: 'G', bass: 43, tones: [55, 59, 62, 67] },
    ],
    lanes: [
      { wave: 'square', gain: 0.042, cutoff: 2600, dur: 0.15, pattern: 'X..o....X.......' },
      { wave: 'square', gain: 0.038, cutoff: 2200, dur: 0.15, pattern: '....x.......X...' },
      { wave: 'triangle', gain: 0.040, cutoff: 3000, dur: 0.15, pattern: '........X...x..o' },
      { wave: 'triangle', gain: 0.034, cutoff: 3400, dur: 0.15, pattern: '......o...x....X' },
    ],
    bassVoice: { wave: 'square', gain: 0.055, cutoff: 900, dur: 0.16, pattern: 'X...x...X...x...' },
    pad: { wave: 'triangle', gain: 0.014, cutoff: 1600 },
    drums: {
      kick: 'X...x...X...x...', kickGain: 0.075,
      snare: '....X.......X...', snareGain: 0.045,
      hat: '..x...x...x...x.', hatGain: 0.016,
    },
  },

  {
    id: 'pulse-drive',
    title: '脉冲驱动',
    titleEn: 'PULSE DRIVE',
    style: '电音',
    bpm: 152,
    bars: 20,
    holdLen: 4,
    accent: '#7c4dff',
    accent2: '#00ffa3',
    progression: [
      { name: 'Em', bass: 40, tones: [55, 59, 62, 66] },
      { name: 'C', bass: 36, tones: [55, 60, 64, 67] },
      { name: 'G', bass: 43, tones: [55, 59, 62, 67] },
      { name: 'D', bass: 38, tones: [57, 62, 66, 69] },
    ],
    lanes: [
      { wave: 'sawtooth', gain: 0.034, cutoff: 2400, dur: 0.11, pattern: 'X...o......o....X...o......o....' },
      { wave: 'square', gain: 0.032, cutoff: 2000, dur: 0.11, pattern: '..x..o.....o...X..X..o.....o....' },
      { wave: 'square', gain: 0.030, cutoff: 2600, dur: 0.11, pattern: '....x...o..X........x...o..X....' },
      { wave: 'triangle', gain: 0.030, cutoff: 3200, dur: 0.11, pattern: 'o..X.....x.....o.o..X.....x.....' },
    ],
    bassVoice: { wave: 'sawtooth', gain: 0.050, cutoff: 1000, dur: 0.10, pattern: 'X.x.X.x.X.x.X.x.' },
    pad: { wave: 'sawtooth', gain: 0.010, cutoff: 1200 },
    drums: {
      kick: 'X...X...X...X...', kickGain: 0.080,
      snare: '....X.......X..x', snareGain: 0.042,
      hat: '..x...x...x...x.', hatGain: 0.014,
    },
  },

  {
    id: 'overload',
    title: '过载警戒',
    titleEn: 'OVERLOAD',
    style: '紧张',
    bpm: 172,
    bars: 20,
    holdLen: 3,
    accent: '#ff3b3b',
    accent2: '#ffd400',
    progression: [
      { name: 'Dm', bass: 38, tones: [57, 62, 65, 69] },
      { name: 'Bb', bass: 34, tones: [58, 62, 65, 70] },
      { name: 'Gm', bass: 31, tones: [55, 58, 62, 67] },
      { name: 'A', bass: 33, tones: [57, 61, 64, 69] },
    ],
    lanes: [
      { wave: 'sawtooth', gain: 0.032, cutoff: 2200, dur: 0.09, pattern: 'X..o............X..o............' },
      { wave: 'sawtooth', gain: 0.030, cutoff: 2000, dur: 0.09, pattern: '..X..o............X..o..........' },
      { wave: 'square', gain: 0.028, cutoff: 1800, dur: 0.09, pattern: '....o..x..X.........o..x..X.....' },
      { wave: 'square', gain: 0.028, cutoff: 2000, dur: 0.09, pattern: 'o.....X..x......o.....X..x......' },
    ],
    bassVoice: { wave: 'sawtooth', gain: 0.052, cutoff: 800, dur: 0.09, pattern: 'X.x.X.x.X.x.X.xx' },
    pad: { wave: 'sawtooth', gain: 0.012, cutoff: 900 },
    drums: {
      kick: 'X..X..X...X..X..', kickGain: 0.078,
      snare: '....X.......X...', snareGain: 0.046,
      hat: 'x.x.x.x.x.x.x.x.', hatGain: 0.012,
    },
  },

  {
    id: 'glass-rain',
    title: '玻璃雨',
    titleEn: 'GLASS RAIN',
    style: '抒情',
    bpm: 96,
    bars: 16,
    holdLen: 6,
    accent: '#5ce1e6',
    accent2: '#c9a7ff',
    progression: [
      { name: 'Fmaj7', bass: 41, tones: [53, 57, 60, 65] },
      { name: 'Am7', bass: 45, tones: [52, 57, 60, 64] },
      { name: 'Dm7', bass: 38, tones: [53, 57, 60, 65] },
      { name: 'Bb6', bass: 34, tones: [53, 58, 62, 65] },
    ],
    lanes: [
      { wave: 'sine', gain: 0.048, cutoff: 1800, dur: 0.35, pattern: 'X.......H.......X.......x.......' },
      { wave: 'triangle', gain: 0.042, cutoff: 2400, dur: 0.30, pattern: '....x...o...x...o...x.......X...' },
      { wave: 'sine', gain: 0.044, cutoff: 2600, dur: 0.30, pattern: '..X.....x..o....X....o..x.......' },
      { wave: 'triangle', gain: 0.038, cutoff: 3000, dur: 0.30, pattern: '........h.......H.......x...X...' },
    ],
    bassVoice: { wave: 'sine', gain: 0.052, cutoff: 700, dur: 0.6, pattern: 'X.......x.......' },
    pad: { wave: 'triangle', gain: 0.018, cutoff: 2000 },
    drums: {
      kick: 'X.......x.......', kickGain: 0.055,
      snare: '........X.......', snareGain: 0.030,
      hat: '....x.......x...', hatGain: 0.010,
    },
  },
];

/** 按 id 取歌；未知 id 返回 null（调用方必须显式处理，不要静默回落到第一首）。 */
export function songById(id) {
  return SONGS.find((s) => s.id === id) || null;
}

/** 一个 16 分音符多少秒。 */
export function stepSeconds(song) {
  return 60 / Math.max(40, song.bpm) / 4;
}

/** 一小节多少秒。 */
export function barSeconds(song) {
  return stepSeconds(song) * STEPS_PER_BAR;
}

/** 整首歌多少格。 */
export function songSteps(song) {
  return song.bars * STEPS_PER_BAR;
}

/** 整首歌多少秒（**不含**尾部混响时间）。 */
export function songDuration(song) {
  return songSteps(song) * stepSeconds(song);
}

/** 取某格上的和弦（自动对进行取模）。 */
export function chordAtStep(song, step) {
  const bar = Math.floor(Math.max(0, step) / STEPS_PER_BAR);
  return song.progression[bar % song.progression.length];
}

/**
 * 取模式串在第 step 格的字符。
 *
 * ★ 周期 = `pattern.length`，而不是写死 16：16 格 = 一小节一句，
 *   32 格 = 两小节一句。长句子是"听起来不像循环机"的关键，
 *   而它仍然是**纯数据**，不影响"谱面与音乐同源"这条性质。
 */
export function charAt(pattern, step) {
  if (typeof pattern !== 'string' || !pattern.length) return '.';
  const n = pattern.length;
  const i = ((Math.floor(step) % n) + n) % n;
  return pattern[i] || '.';
}

/** 该字符属于哪一层级；空字符返回 -1。 */
export function tierOfChar(ch) {
  const t = TIER_OF_CHAR[ch];
  return t === undefined ? -1 : t;
}

/** 该字符是否是长按起点。 */
export function isHoldChar(ch) {
  return HOLD_CHARS.includes(ch);
}

/** 四轨固定音高角色：lane0 根音 / lane1 三音 / lane2 五音(+12) / lane3 七音(+12)。 */
export function laneMidi(song, lane, step) {
  const chord = chordAtStep(song, step);
  const idx = Math.min(lane, chord.tones.length - 1);
  const oct = lane >= 2 ? 12 : 0;
  return chord.tones[idx] + oct;
}

/**
 * ★ 唯一事实来源：把一首歌展开成**按时间严格递增**的事件数组。
 *
 * 返回的事件分四类（只有 lane 是可打的）：
 *   { kind:'lane' } 四轨音符（可 tap / 可 hold）
 *   { kind:'drum', role:'kick'|'snare'|'hat' }
 *   { kind:'bass' } 低音线
 *   { kind:'pad' }  小节头铺底和弦（一次四个音，用 midis 数组）
 *
 * **长按冲突消解也在这一步做**（而不是留给谱面）：发生冲突时同一 lane 落在
 * 长按窗口内的音符会被**从源头删掉**，音频与谱面都不再看到它 —— 这样"同源"
 * 在任何数据下都成立，而不是靠作曲时小心别写错。
 *
 * @param {object} song
 * @returns {{songId:string, bpm:number, stepSeconds:number, steps:number, duration:number,
 *            events:Array, laneEvents:Array, counts:object}}
 */
export function buildTimeline(song) {
  if (!song || !song.lanes || !song.progression || !song.progression.length) {
    throw new Error('buildTimeline: 曲目数据不完整');
  }
  const sps = stepSeconds(song);
  const total = songSteps(song);
  const raw = [];

  for (let step = 0; step < total; step++) {
    const inBar = step % STEPS_PER_BAR;
    const bar = Math.floor(step / STEPS_PER_BAR);
    const chord = chordAtStep(song, step);

    /* ── 四轨：可打音符 ── */
    for (let lane = 0; lane < song.lanes.length; lane++) {
      const L = song.lanes[lane];
      const ch = charAt(L.pattern, step);
      const tier = tierOfChar(ch);
      if (tier < 0) continue;
      const hold = isHoldChar(ch);
      const holdSteps = hold ? Math.max(1, song.holdLen || 4) : 0;
      raw.push({
        kind: 'lane', lane, step, tier, chord: chord.name,
        midi: laneMidi(song, lane, step),
        wave: L.wave, gain: L.gain, cutoff: L.cutoff,
        holdSteps,
        dur: hold ? holdSteps * sps * 0.96 : L.dur,
        holdMs: hold ? holdSteps * sps * 1000 : 0,
      });
    }

    /* ── 低音 ── */
    const bch = charAt(song.bassVoice && song.bassVoice.pattern, step);
    if (tierOfChar(bch) >= 0) {
      const b = song.bassVoice;
      raw.push({
        kind: 'bass', lane: -1, step, tier: -1,
        midi: chord.bass, wave: b.wave, gain: b.gain, cutoff: b.cutoff, dur: b.dur,
      });
    }

    /* ── 铺底和弦：只在每小节头，一次性给全部和弦音 ── */
    if (inBar === 0 && song.pad) {
      raw.push({
        kind: 'pad', lane: -1, step, tier: -1,
        midis: chord.tones.slice(), wave: song.pad.wave, gain: song.pad.gain,
        cutoff: song.pad.cutoff, dur: barSeconds(song) * 0.95,
      });
    }

    /* ── 鼓组 ── */
    const d = song.drums;
    if (charAt(d.kick, step) !== '.') {
      raw.push({ kind: 'drum', role: 'kick', lane: -1, step, tier: -1, freq: 120, slide: 46, gain: d.kickGain, cutoff: 0, dur: 0.13 });
    }
    if (charAt(d.snare, step) !== '.') {
      raw.push({ kind: 'drum', role: 'snare', lane: -1, step, tier: -1, gain: d.snareGain, hp: 900, lp: 6000, dur: 0.1 });
    }
    if (charAt(d.hat, step) !== '.') {
      raw.push({ kind: 'drum', role: 'hat', lane: -1, step, tier: -1, gain: d.hatGain, hp: 5200, lp: 0, dur: 0.028 });
    }
  }

  /* ── 排序：先按时间；同一格上长按优先（长按赢），再按 lane，最后按 kind 名 ── */
  raw.sort((a, b) => (
    a.step - b.step
    || (a.kind === 'lane' && a.holdSteps ? 0 : 1) - (b.kind === 'lane' && b.holdSteps ? 0 : 1)
    || a.lane - b.lane
    || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0)
  ));

  /* ── 长按冲突消解 + 落时间 ── */
  const holdUntil = new Array(song.lanes.length).fill(-1);
  const events = [];
  let dropped = 0;
  for (const e of raw) {
    if (e.kind === 'lane') {
      if (e.step < holdUntil[e.lane]) { dropped += 1; continue; }      // 落在同轨长按窗口内 → 丢弃
      if (e.holdSteps > 0) holdUntil[e.lane] = e.step + e.holdSteps;
    }
    e.time = e.step * sps;
    e.index = events.length;
    events.push(e);
  }

  const laneEvents = events.filter((e) => e.kind === 'lane');
  const counts = { total: events.length, lane: laneEvents.length, droppedByHold: dropped, byTier: [0, 0, 0] };
  for (const e of laneEvents) counts.byTier[e.tier] += 1;

  return {
    songId: song.id, bpm: song.bpm, stepSeconds: sps,
    steps: total, duration: total * sps,
    events, laneEvents, counts,
  };
}

/** 取 [from, to) 时间内的事件（调度器每帧用；纯函数，方便单测窗口逻辑）。 */
export function eventsInRange(events, from, to) {
  return events.filter((e) => e.time >= from && e.time < to);
}

/** 二分：第一条 time >= t 的事件下标（返回 events.length 表示没有）。 */
export function lowerBoundByTime(events, t) {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].time < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/* ============================================================
 *  二、Web Audio 后端（唯一碰 AudioContext 的地方）
 * ------------------------------------------------------------
 *  后端不认识"歌曲/谱面/难度"，只会发声。AudioContext 由宿主注入
 *  （浏览器要求用户手势后才能出声，这条策略归宿主，不归引擎）。
 * ========================================================== */

const ATTACK = 0.008;
const SILENT = 0.0001; // exponentialRamp 不接受 0

/**
 * @param {{ctxRef: () => any, noiseSeed?: number}} deps
 */
export function createWebAudioBackend({ ctxRef, noiseSeed = 0x9e3779b9 } = {}) {
  const live = new Set();
  let buses = new Map();
  let rnd = mulberry32(noiseSeed);
  let errors = 0;
  let lastError = '';
  let noiseBuf = null; // 噪声缓冲只造一次（每次 hit 现造 buffer 会把 GC 打爆）

  const ctx = () => {
    try { return ctxRef ? ctxRef() : null; } catch { return null; }
  };

  function ensureBus(key) {
    const c = ctx();
    if (!c) return null;
    const got = buses.get(key);
    if (got) return got;
    const g = c.createGain();
    g.gain.value = key === 'master' ? 0.9 : 1;
    g.connect(c.destination);
    buses.set(key, g);
    return g;
  }

  function noiseBuffer(c) {
    if (noiseBuf && noiseBuf.sampleRate === c.sampleRate) return noiseBuf;
    const len = Math.floor(c.sampleRate * 0.4);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (rnd() * 2 - 1) * (1 - i / len);
    noiseBuf = buf;
    return buf;
  }

  return {
    kind: 'webaudio',
    available() { const c = ctx(); return !!c; },
    now() { const c = ctx(); return c ? c.currentTime : 0; },
    state() { const c = ctx(); return c ? c.state : null; },

    setGain(key, v, at, dur) {
      const g = ensureBus(key);
      if (!g) return;
      try {
        g.gain.cancelScheduledValues(at);
        g.gain.setValueAtTime(Math.max(SILENT, g.gain.value), at);
        g.gain.linearRampToValueAtTime(Math.max(0, v), at + Math.max(0.01, dur));
      } catch (e) { errors += 1; lastError = String(e); }
    },

    note({ freq = 440, dur = 0.12, at = 0, type = 'triangle', gain = 0.05, cutoff = 0, slide = 0, bus = 'master' } = {}) {
      const c = ctx();
      const b = ensureBus(bus);
      if (!c || !b) return;
      try {
        const t0 = Math.max(c.currentTime, at);
        const osc = c.createOscillator();
        const g = c.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(Math.max(20, freq), t0);
        if (slide > 0) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slide), t0 + Math.max(0.03, dur));
        const hold = Math.max(ATTACK + 0.02, dur);
        g.gain.setValueAtTime(SILENT, t0);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + ATTACK);
        g.gain.exponentialRampToValueAtTime(SILENT, t0 + hold);
        osc.connect(g);
        let tail = g;
        if (cutoff > 0) {
          const f = c.createBiquadFilter();
          f.type = 'lowpass';
          f.frequency.value = cutoff;
          g.connect(f);
          tail = f;
        }
        tail.connect(b);
        osc.start(t0);
        osc.stop(t0 + hold + 0.02);
        live.add(osc);
        osc.onended = () => live.delete(osc);
      } catch (e) { errors += 1; lastError = String(e); }
    },

    noiseAt({ at = 0, dur = 0.05, gain = 0.03, hp = 0, lp = 0, bus = 'master' } = {}) {
      const c = ctx();
      const b = ensureBus(bus);
      if (!c || !b) return;
      try {
        const t0 = Math.max(c.currentTime, at);
        const src = c.createBufferSource();
        src.buffer = noiseBuffer(c);
        let node = src;
        if (lp > 0) {
          const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp;
          node.connect(f); node = f;
        }
        if (hp > 0) {
          const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp;
          node.connect(f); node = f;
        }
        const g = c.createGain();
        g.gain.setValueAtTime(gain, t0);
        g.gain.exponentialRampToValueAtTime(SILENT, t0 + Math.max(0.02, dur));
        node.connect(g);
        g.connect(b);
        src.start(t0);
        src.stop(t0 + Math.max(0.03, dur) + 0.02);
        live.add(src);
        src.onended = () => live.delete(src);
      } catch (e) { errors += 1; lastError = String(e); }
    },

    /** 打中反馈音：短促上滑，0 文件体积。 */
    blip({ at = 0, freq = 1320, gain = 0.05, type = 'triangle' } = {}) {
      const c = ctx();
      if (!c) return;
      this.note({ at, freq, slide: freq * 1.6, dur: 0.07, type, gain, cutoff: 0 });
    },

    /** 立刻停掉全部发声体（暂停/停止/静音都走这里，不留空转振荡器）。 */
    panic() {
      const c = ctx();
      const t = c ? c.currentTime : 0;
      for (const n of live) {
        try { n.stop(t); } catch { /* 已停过 */ }
        try { n.disconnect(); } catch { /* 忽略 */ }
      }
      live.clear();
    },

    stats() { return { kind: 'webaudio', live: live.size, errors, lastError }; },
  };
}

/* ============================================================
 *  三、引擎本体
 * ========================================================== */

/** 调度前瞻（秒）。远大于一帧，帧率抖动不会漏拍。 */
export const LOOKAHEAD = 0.35;
/** 心跳（毫秒）。 */
export const TICK_MS = 50;
/** 起播预留（秒）：按下开始到第一个音之间的空档，给 UI 做倒计时。 */
export const LEAD_IN = 1.2;

/**
 * 建立音乐引擎。
 *
 * 时间口径（**整个游戏只认这一个时钟**）：
 *   `engine.now()` = 距"歌曲第 0 秒"的秒数，负值表示还在起播预留里。
 *   game.mjs 的判定、ui.mjs 的下落位置全部由它换算，绝不用帧计数。
 *
 * @param {object} opts
 * @param {object} [opts.backend]      注入后端（默认按 bus 建 Web Audio 后端）
 * @param {{ctxRef?:Function}} [opts.bus]
 * @param {() => number} [opts.wallClock] 无音频时的兜底时钟（毫秒）
 * @param {() => boolean} [opts.isMuted]
 * @param {() => number}  [opts.getVolume]
 * @param {boolean} [opts.autoTick]
 * @param {object}  [opts.timer]
 */
export function createMusicEngine(opts = {}) {
  const {
    bus = null,
    backend = null,
    wallClock = () => (typeof performance !== 'undefined' ? performance.now() : 0),
    isMuted = () => false,
    getVolume = () => 0.8,
    autoTick = true,
    timer = { set: (fn, ms) => setInterval(fn, ms), clear: (id) => clearInterval(id) },
  } = opts;

  const be = backend || (bus ? createWebAudioBackend(bus) : null);

  let timeline = null;
  let cursor = 0;        // 下一条待排程事件的下标
  let startAt = 0;       // 音频时钟上的"第 0 秒"绝对时刻
  let wallStart = 0;     // 兜底时钟上的"第 0 秒"
  let running = false;   // 是否真的在出声
  let started = false;   // 是否"想播"（暂停/静音期间仍为 true）
  let paused = false;
  let pausedAtSong = 0;
  let timerId = null;
  let scheduledNotes = 0;
  let errors = 0;
  let lastError = '';
  let useFallbackClock = false;

  function startTimer() {
    if (!autoTick || timerId != null) return;
    try { timerId = timer.set(tick, TICK_MS); } catch { timerId = null; }
  }
  function stopTimer() {
    if (timerId == null) return;
    try { timer.clear(timerId); } catch { /* 忽略 */ }
    timerId = null;
  }

  /** 当前歌曲时间（秒，可为负）。 */
  function now() {
    if (!timeline) return 0;
    if (paused) return pausedAtSong;
    if (useFallbackClock || !be || !be.available()) {
      const t = (wallClock() - wallStart) / 1000;
      return started && running ? t : pausedAtSong;
    }
    return be.now() - startAt;
  }

  function emit(e, at) {
    if (!be || !be.available()) return;
    const vol = Math.max(0, Math.min(1, Number(getVolume()) || 0));
    if (vol <= 0 || isMuted()) return;
    const gain = e.gain * vol;
    if (e.kind === 'drum') {
      if (e.role === 'kick') be.note({ at, freq: e.freq, slide: e.slide, dur: e.dur, type: 'sine', gain, cutoff: 0 });
      else be.noiseAt({ at, dur: e.dur, gain, hp: e.hp || 0, lp: e.lp || 0 });
      scheduledNotes += 1;
      return;
    }
    if (e.kind === 'pad') {
      for (const m of e.midis) be.note({ at, freq: midiToHz(m), dur: e.dur, type: e.wave, gain, cutoff: e.cutoff });
      scheduledNotes += e.midis.length;
      return;
    }
    be.note({ at, freq: midiToHz(e.midi), dur: e.dur, type: e.wave, gain, cutoff: e.cutoff });
    scheduledNotes += 1;
  }

  function tick() {
    if (!timeline || !running || paused) return;
    const t = now();
    const until = t + LOOKAHEAD;
    let guard = 0;
    while (cursor < timeline.events.length && timeline.events[cursor].time < until && guard++ < 256) {
      const e = timeline.events[cursor++];
      emit(e, startAt + e.time);
    }
  }

  const api = {
    /** 装载曲目（不发声）。重复装载同一首会重置进度。 */
    load(song) {
      timeline = buildTimeline(song);
      cursor = 0;
      pausedAtSong = -LEAD_IN;
      return timeline;
    },

    get timeline() { return timeline; },

    /** 起播。必须在用户手势里调用（浏览器自动播放策略）。 */
    start() {
      if (!timeline) throw new Error('engine.start: 先 load(song)');
      started = true;
      paused = false;
      const hasAudio = !!(be && be.available());
      useFallbackClock = !hasAudio;
      if (hasAudio) {
        startAt = be.now() + LEAD_IN;
        cursor = 0;
        running = true;
      } else {
        wallStart = wallClock() - (-LEAD_IN) * 1000;
        running = true;
      }
      startTimer();
      tick();
      return api;
    },

    pause() {
      if (!started) return api;
      pausedAtSong = now();
      paused = true;
      running = false;
      stopTimer();
      if (be) be.panic();
      return api;
    },

    /** 继续：把"第 0 秒"整体后移，使歌曲时间从 pausedAtSong 接上。 */
    resume() {
      if (!started || !paused) return api;
      if (useFallbackClock || !be || !be.available()) {
        wallStart = wallClock() - pausedAtSong * 1000;
      } else {
        startAt = be.now() - pausedAtSong;
      }
      cursor = lowerBoundByTime(timeline ? timeline.events : [], Math.max(0, pausedAtSong));
      paused = false;
      running = true;
      startTimer();
      tick();
      return api;
    },

    stop() {
      started = false;
      running = false;
      paused = false;
      pausedAtSong = 0;
      stopTimer();
      if (be) be.panic();
      return api;
    },

    /** 立即静音（硬停，不是把音量拧到 0）。 */
    mute() { stopTimer(); running = false; if (be) be.panic(); return api; },

    /** 打中反馈音（由 ui/judge 在命中时调用，属于音效不属于乐曲）。 */
    hitSound(verdict) {
      if (!be || !be.available() || isMuted() || (Number(getVolume()) || 0) <= 0) return;
      const map = { perfect: 1560, great: 1240, good: 980, miss: 220 };
      const at = be.now() + 0.005;
      if (verdict === 'miss') be.note({ at, freq: 200, slide: 120, dur: 0.10, type: 'sawtooth', gain: 0.03 });
      else be.blip({ at, freq: map[verdict] || 1200, gain: verdict === 'perfect' ? 0.055 : 0.04 });
    },

    /** 手动推进（autoTick:false 的宿主 / 单测）。 */
    tick,

    /** 音频时钟（秒）。UI 每帧问它。 */
    time() { return now(); },

    get playing() { return running && started && !paused; },
    get started() { return started; },
    get paused() { return paused; },
    get fallbackClock() { return useFallbackClock; },

    stats() {
      return {
        loaded: !!timeline,
        songId: timeline ? timeline.songId : null,
        started, running, paused,
        fallbackClock: useFallbackClock,
        ctxState: be && be.state ? be.state() : null,
        songTime: Number(now().toFixed(3)),
        cursor,
        scheduledNotes,
        errors,
        lastError,
        backend: be ? (be.kind || 'custom') : null,
      };
    },

    _internals: {
      get backend() { return be; },
      emit,
      dispose() { stopTimer(); },
    },
  };

  return api;
}

export default createMusicEngine;
