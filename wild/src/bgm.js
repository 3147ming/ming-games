/**
 * 程序化 BGM 引擎（B 包：音频升级 · 混合路线）
 * ============================================================
 * 一句话：**打底用现场合成（0 文件体积），关键场景可选挂 mp3（按需、不阻塞首屏）**。
 *
 * 为什么要抽成独立引擎，而不是继续在 sfx.mjs 里加分支：
 *   · sfx.mjs 里那套步进音序器只服务 night-shift 的"昼夜/高峰"三个档位；
 *     WILD 需要的是"菜单/局内/高波次/Boss/结算"另一套语义 —— 两者共享的**不是曲风**，
 *     而是"和弦进行 + 琶音 + 鼓点 + 走时基准 + 交叉淡入"这套机制。
 *     机制留在引擎里，曲风做成数据（MOOD_PRESETS），换游戏只换预设表。
 *   · 引擎不 import 任何东西（零依赖），因此 `node --check` 与 node 单测都能直接吃它。
 *
 * 硬性要求与实现位置的对应：
 *   1. 用户手势后才出声   —— 引擎自身**不建 AudioContext**：后端由宿主注入（宿主只在手势里建 ctx）。
 *   2. 五种情绪 + 无缝循环 —— MOOD_PRESETS（数据）+ voicesAtStep/clampToLoop（纯函数，保证音尾不越界）。
 *   3. 切换 ≤0.6s 交叉淡入 —— 双合成层 A/B：旧层淡出、新层淡入，**共享同一个 step/nextAt 走时基准**
 *                            ⟹ 换情绪不断拍子（这个走时基准是"不打断节奏"的全部秘密）。
 *   4. 省电               —— 隐藏 → suspend() 硬停；不播放 → 调度定时器清除、全量 stop 振荡器；
 *                            静音 → 同样硬停（不是把音量拧到 0）。
 *   5. 可选 mp3 槽         —— manifest 显式声明；有值才加载，8s 超时回落合成，绝不静默失声。
 *   6. 大文件友好         —— 只在"某情绪首次进入"时按需 fetch；加载期间先播合成，到货后交叉淡入接管。
 *   7. 音量/静音          —— getVolume()/isMuted() 由宿主注入，复用各游戏既有设置。
 *   8. 纯函数可测         —— 本文件上半部分完全不碰 AudioContext。
 */

/* ============================================================
 *  一、纯函数区（无 AudioContext / 无 window，node 里可直接单测）
 * ========================================================== */

/** 五种情绪，缺一不可（测试会锁这条）。 */
export const MOODS = ['menu', 'explore', 'tension', 'boss', 'settle'];

/** 交叉淡入淡出上限（秒）——需求 3 写死 ≤0.6s。 */
export const MAX_FADE = 0.6;
/** 默认交叉淡入时长（秒）。 */
export const DEFAULT_FADE = 0.5;
/** mp3 加载超时（毫秒）——超过就回落合成，绝不静默失声。 */
export const MP3_TIMEOUT_MS = 8000;
/** mp3 层交叉淡入时长（秒）。 */
export const MP3_FADE = 0.6;
/** 调度前瞻窗口（秒）。比一帧长得多，帧率抖动不会漏拍。 */
export const LOOKAHEAD = 0.32;
/** 调度心跳（毫秒）。 */
export const TICK_MS = 60;

/** 十二平均律 → 频率（与 sfx.mjs 同一把尺子）。 */
export function midiToHz(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * 五情绪预设表。每条包含：和弦进行（4 小节循环）/ 琶音 / 低音 / 鼓点 / 音色 / 低通 / 嗡鸣。
 *
 * 记谱约定：bass 与 tones 都是**绝对 MIDI 音高**（不做八度切换 —— 原 night-shift 用
 * `bright ? 0 : -12` 全局降八度，那种"一个开关管所有声部"的写法在五情绪下会互相打架，
 * 这里直接把八度写进数字，读起来也更接近谱面）。
 *
 * 音色纪律（沿用仓库既有）：只用 sine / triangle / square / sawtooth + 低通，
 * 单声部 gain ≤ 0.08 —— 与 sfx.mjs 的音效峰值（0.16）留出余量，BGM 永远不盖过操作反馈。
 */
export const MOOD_PRESETS = {
  /* ① 菜单 / 标题：梦幻稀疏，让玩家在标题页"待得住"，不催他点开始。 */
  menu: {
    label: '菜单',
    bpm: 84,
    gain: 0.72,
    progression: [
      { name: 'Cmaj7', bass: 48, tones: [60, 64, 67, 71] },
      { name: 'Am7', bass: 45, tones: [57, 60, 64, 67] },
      { name: 'Fmaj7', bass: 41, tones: [53, 57, 60, 64] },
      { name: 'G6', bass: 43, tones: [55, 59, 62, 64] },
    ],
    bass: { wave: 'sine', gain: 0.05, cutoff: 700, dur: 0.5, steps: [0, 8] },
    arp: { wave: 'triangle', gain: 0.035, cutoff: 2400, dur: 0.45, every: 4, skip: [] },
    drums: { kick: [0], kickGain: 0.05, snare: [], snareGain: 0.04, hatEvery: 8, hatOffset: 4, hatGain: 0.01 },
    hum: 0,
  },

  /* ② 局内探索 / 白天营业：轻快街机电子 —— 沿用 night-shift 原来的 Am–F–C–G 与配器。 */
  explore: {
    label: '探索',
    bpm: 112,
    gain: 0.95,
    progression: [
      { name: 'Am', bass: 45, tones: [57, 60, 64, 69] },
      { name: 'F', bass: 41, tones: [53, 57, 60, 65] },
      { name: 'C', bass: 48, tones: [55, 60, 64, 67] },
      { name: 'G', bass: 43, tones: [55, 59, 62, 67] },
    ],
    bass: { wave: 'square', gain: 0.055, cutoff: 900, dur: 0.16, steps: [0, 3, 6, 8, 11, 14] },
    arp: { wave: 'triangle', gain: 0.042, cutoff: 3200, dur: 0.11, every: 2, skip: [6, 14] },
    drums: { kick: [0, 8], kickGain: 0.075, snare: [], snareGain: 0.045, hatEvery: 2, hatOffset: 1, hatGain: 0.016 },
    hum: 0,
  },

  /* ③ 紧张 / 高波次：和声小调的导音（E 大调的 G#）制造"要出事"的推力，
   *    低音走八分、踩镲走 16 分 = 双倍密度；低通压到 1100Hz 让整体发闷。 */
  tension: {
    label: '紧张',
    bpm: 128,
    gain: 0.9,
    progression: [
      { name: 'Am', bass: 45, tones: [57, 60, 64, 69] },
      { name: 'G', bass: 43, tones: [55, 59, 62, 67] },
      { name: 'F', bass: 41, tones: [53, 57, 60, 65] },
      { name: 'E', bass: 40, tones: [56, 59, 64, 68] },
    ],
    bass: { wave: 'sawtooth', gain: 0.05, cutoff: 1100, dur: 0.12, steps: [0, 2, 4, 6, 8, 10, 12, 14] },
    arp: { wave: 'square', gain: 0.03, cutoff: 1800, dur: 0.09, every: 2, skip: [] },
    drums: { kick: [0, 6, 8, 14], kickGain: 0.07, snare: [4, 12], snareGain: 0.045, hatEvery: 1, hatOffset: 0, hatGain: 0.012 },
    hum: 0.05,
  },

  /* ④ Boss：D 小调 + 四踩底鼓 + 16 分踩镲，再叠一层 55Hz 电流嗡鸣 —— 压迫感来源是"低频占满"。 */
  boss: {
    label: 'BOSS',
    bpm: 150,
    gain: 1,
    progression: [
      { name: 'Dm', bass: 38, tones: [57, 62, 65, 69] },
      { name: 'Bb', bass: 34, tones: [58, 62, 65, 70] },
      { name: 'F', bass: 41, tones: [57, 60, 65, 69] },
      { name: 'A', bass: 33, tones: [57, 61, 64, 69] },
    ],
    bass: { wave: 'sawtooth', gain: 0.06, cutoff: 900, dur: 0.14, steps: [0, 3, 6, 8, 10, 11, 14] },
    arp: { wave: 'square', gain: 0.032, cutoff: 1400, dur: 0.1, every: 2, skip: [6, 14] },
    drums: { kick: [0, 4, 8, 12], kickGain: 0.08, snare: [4, 12], snareGain: 0.05, hatEvery: 1, hatOffset: 0, hatGain: 0.014 },
    hum: 0.075,
  },

  /* ⑤ 结算 / 收尾：F–C–G–Am 的"回家"走向，正弦低音 + 三角琶音，鼓点最疏。 */
  settle: {
    label: '结算',
    bpm: 92,
    gain: 0.78,
    progression: [
      { name: 'F6', bass: 41, tones: [57, 60, 62, 65] },
      { name: 'C', bass: 48, tones: [55, 60, 64, 67] },
      { name: 'G', bass: 43, tones: [55, 59, 62, 67] },
      { name: 'Am', bass: 45, tones: [57, 60, 64, 69] },
    ],
    bass: { wave: 'sine', gain: 0.05, cutoff: 800, dur: 0.5, steps: [0, 8] },
    arp: { wave: 'triangle', gain: 0.038, cutoff: 2600, dur: 0.2, every: 2, skip: [14] },
    drums: { kick: [0], kickGain: 0.05, snare: [], snareGain: 0.04, hatEvery: 4, hatOffset: 2, hatGain: 0.011 },
    hum: 0,
  },
};

/** 情绪名是否合法（含宿主自定义情绪）。 */
export function isMood(mood, overrides) {
  return mood === 'menu' || mood === 'explore' || mood === 'tension' || mood === 'boss' || mood === 'settle'
    || !!(overrides && overrides[mood]);
}

/**
 * 取预设。overrides 是宿主传入的 `moods`（同名即浅合并，可只覆盖 bpm/gain 这类字段）。
 * 未知情绪一律回落 explore —— "放不出歌"比"放错歌"严重得多。
 */
export function presetOf(mood, overrides) {
  const base = MOOD_PRESETS[mood] || MOOD_PRESETS.explore;
  if (overrides && overrides[mood]) return { ...base, ...overrides[mood] };
  return base;
}

/** 一个 16 分音符的时长（秒）。 */
export function stepSeconds(mood, overrides) {
  return 60 / Math.max(40, presetOf(mood, overrides).bpm) / 4;
}

/** 一小节时长（秒）= 16 个 16 分音符。 */
export function barSeconds(mood, overrides) {
  return stepSeconds(mood, overrides) * 16;
}

/** 一个完整循环有多少个 16 分音符。 */
export function loopSteps(mood, overrides) {
  return presetOf(mood, overrides).progression.length * 16;
}

/** 一个完整循环的时长（秒）—— 测试用它验证"小节长度对齐"。 */
export function loopSeconds(mood, overrides) {
  return barSeconds(mood, overrides) * presetOf(mood, overrides).progression.length;
}

/** 取第 step 个 16 分音符落在哪个和弦上（自动对循环取模，负数也安全）。 */
export function chordAt(mood, step, overrides) {
  const p = presetOf(mood, overrides);
  const n = loopSteps(mood, overrides);
  const s = ((Math.floor(step) % n) + n) % n;
  return p.progression[Math.floor(s / 16) % p.progression.length];
}

/**
 * 纯函数：第 step 个 16 分音符上该发哪些声部。
 * **不含绝对时间** —— 时间由调度器给，所以这个函数在 node 里可以逐 step 遍历整个循环做断言。
 * 返回 [{ kind:'tone'|'noise', role, dur, gain, ... }]
 */
export function voicesAtStep(mood, step, overrides) {
  const p = presetOf(mood, overrides);
  const n = loopSteps(mood, overrides);
  const s = ((Math.floor(step) % n) + n) % n;
  const inBar = s % 16;
  const chord = p.progression[Math.floor(s / 16) % p.progression.length];
  const out = [];

  // ── 低音：预设给"第几个 16 分音符上踩一脚" ──
  if (p.bass.steps.includes(inBar)) {
    out.push({
      kind: 'tone', role: 'bass', midi: chord.bass, freq: midiToHz(chord.bass),
      wave: p.bass.wave, gain: p.bass.gain, cutoff: p.bass.cutoff, dur: p.bass.dur,
    });
  }
  // ── 琶音：每 `every` 个 16 分音符走一个和弦音；skip 是留给"呼吸"的空拍 ──
  if (p.arp.every > 0 && inBar % p.arp.every === 0 && !p.arp.skip.includes(inBar)) {
    const slot = Math.floor(inBar / p.arp.every);
    const midi = chord.tones[slot % chord.tones.length];
    out.push({
      kind: 'tone', role: 'arp', midi, freq: midiToHz(midi),
      wave: p.arp.wave, gain: p.arp.gain, cutoff: p.arp.cutoff, dur: p.arp.dur,
    });
  }
  // ── 鼓点 ──
  const d = p.drums;
  if (d.kick.includes(inBar)) {
    // 底鼓：120Hz → 48Hz 的下滑，模拟"咚"的膜振动
    out.push({ kind: 'tone', role: 'kick', freq: 120, slide: 48, wave: 'sine', gain: d.kickGain, cutoff: 0, dur: 0.13 });
  }
  if (d.snare.includes(inBar)) {
    out.push({ kind: 'noise', role: 'snare', gain: d.snareGain, hp: 900, lp: 6000, dur: 0.1 });
  }
  if (d.hatEvery > 0 && inBar >= d.hatOffset && (inBar - d.hatOffset) % d.hatEvery === 0) {
    out.push({ kind: 'noise', role: 'hat', gain: d.hatGain, hp: 5200, lp: 0, dur: 0.028 });
  }
  // ── 嗡鸣：每小节头起一根长正弦（55Hz + 低通），tension/boss 的"电流感" ──
  if (p.hum > 0 && inBar === 0) {
    out.push({ kind: 'tone', role: 'hum', freq: 55, wave: 'sine', gain: p.hum, cutoff: 200, dur: barSeconds(mood, overrides) });
  }
  return out;
}

/**
 * 纯函数：把这个音的时长压到"不越过循环末尾"。
 *
 * 为什么必须压 —— 循环是**首尾相接**的：如果最后一拍上的长音拖过循环边界，
 * 下一圈的同一个音会与它叠在一起，听感上是"糊了一下"，且音量比别处高一截。
 * 压到边界内 ⟹ 每圈严格等价 ⟹ 无缝。
 *
 * ★ 下界用 `Math.min(..., left)` 而不是 `Math.max(0.04, ...)`：
 *   后者在"剩余不足 0.04s"时会**把音推过循环末尾**（正好是它要防的事）。
 *   现在真正的上界永远是 `left`，下界只在 left 够宽时才生效。
 *   又因为 left ≥ 一个 16 分音符的时长（≥ 0.16s，最慢的 menu 84bpm），
 *   而所有预设的最短音是 0.028s（踩镲）< MIN_DUR，所以这一步对现有曲风是恒等变换。
 */
export const MIN_DUR = 0.03;

export function clampToLoop(mood, step, dur, overrides) {
  const spb = stepSeconds(mood, overrides);
  const loop = loopSeconds(mood, overrides);
  const n = loopSteps(mood, overrides);
  const s = ((Math.floor(step) % n) + n) % n;
  const left = Math.max(1e-3, loop - s * spb);
  return Math.min(Math.max(dur, MIN_DUR), left);
}

/** 等功率交叉淡入曲线：t∈[0,1] → [0,1]。线性淡入在听感上会"中间塌一下"，等功率不会。 */
export function fadeGain(t) {
  const x = Math.max(0, Math.min(1, Number(t) || 0));
  return Math.sin(x * Math.PI / 2);
}

/* ---------- 情绪映射（各游戏的状态 → 五情绪之一） ---------- */

/**
 * night-shift：昼夜 / 停电 / 高峰 / 打烊 → 情绪。
 * ★ 保留原有语义：白天=轻快、深夜=压低、停电更冷、高峰最激烈；打烊走结算。
 */
export function moodFromStoreState({ night, blackout, rush, closing } = {}) {
  if (closing) return 'settle';
  if (rush) return 'boss';
  if (blackout || night) return 'tension';
  return 'explore';
}

/**
 * night-shift 的完整音频场景：情绪 + 本帧的额外增益。
 * `soft`（暂停 / 小游戏进行中）**只压音量、不换情绪** —— 与旧实现一致：
 * 旧代码就是 `if (mood.soft) t.gain *= 0.5`，别在这里偷偷改成换歌。
 */
export function storeAudioScene(m = {}) {
  return { mood: moodFromStoreState(m), gain: m.soft ? 0.5 : 1 };
}

/**
 * WILD：界面 + Boss + 波次档位 → 情绪。
 * waveTier 是 ARENA.WAVES 的下标：0~1 尚可（explore），≥2 起压力上来（tension），
 * 最后 3 分钟高潮窗口直接按 tension 顶；Boss 活着时一律 boss。
 */
export function moodFromRunState({ screen, bossAlive, waveTier, climax } = {}) {
  if (screen === 'title') return 'menu';
  if (screen === 'result') return 'settle';
  if (bossAlive) return 'boss';
  if (climax === true || (Number(waveTier) || 0) >= 2) return 'tension';
  return 'explore';
}

/* ---------- mp3 插槽：回落判定（纯函数，测试重点） ---------- */

/**
 * mp3 状态机（纯函数）：给定当前槽位状态，返回这一步该做什么。
 *
 * 状态流转：
 *   none（manifest 里没这个情绪）→ 永远走合成
 *   idle     → load        首次进入该情绪：开始按需加载
 *   loading  → wait        还没到超时，继续等（合成正在播，玩家听得到东西）
 *   loading  → fallback    超过 8s：**判定回落合成**（绝不静默失声）
 *   fallback → wait-late   仍在后台下载；到货了就接管（20MB 的大文件在慢网下也能最终播上）
 *   ready    → adopt       解码完成，交叉淡入接管
 *   playing  → playing     已在播
 *   failed   → skip        404 / 解码失败：这个情绪永远走合成，不再重试
 */
export function mp3Decision({ hasUrl, status = 'idle', waitMs = 0, timeoutMs = MP3_TIMEOUT_MS, lateAdopt = true } = {}) {
  if (!hasUrl) return 'none';
  switch (status) {
    case 'playing': return 'playing';
    case 'ready': return 'adopt';
    case 'idle': return 'load';
    case 'loading': return (Number(waitMs) || 0) >= timeoutMs ? 'fallback' : 'wait';
    case 'fallback': return lateAdopt ? 'wait-late' : 'skip';
    case 'failed': return 'skip';
    default: return 'skip';
  }
}

/** 给定 manifest 与情绪，取 mp3 地址（空/非字符串视为"没插槽"）。 */
export function mp3UrlFor(manifest, mood) {
  const url = manifest ? manifest[mood] : null;
  return typeof url === 'string' && url.length > 0 ? url : null;
}

/**
 * 解码后留在内存里的 mp3 上限（默认 2 首）。
 *
 * 为什么必须设上限 —— 这是"网页会塌"的那一类风险，而不是算力问题：
 * mp3 解码成 PCM 后体积约是压缩包的 **20 倍**。用户说单个 mp3 常超过 20MB，
 * 那就是 ~400MB 的 Float32 采样；五个情绪各留一份 ≈ 2GB，页面直接被 OOM 掉。
 * 所以这里做 LRU：超出上限就把最久没用过的那首 buffer 丢掉（状态退回 idle，
 * 下次再进这个情绪会重新按需加载 —— 已经在硬盘/HTTP 缓存里，通常很快）。
 *
 * @param entries [{ mood, buffer, lastUsedAt }]
 * @param currentMood 当前情绪（绝不淘汰它）
 * @returns 要淘汰的情绪名，或 null
 */
export function pickEviction(entries, currentMood, maxBuffers = 2) {
  const holding = entries.filter((e) => e.buffer);
  if (holding.length <= Math.max(1, maxBuffers)) return null;
  const candidates = holding.filter((e) => e.mood !== currentMood);
  if (!candidates.length) return null;
  candidates.sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0));
  return candidates[0].mood;
}

/* ============================================================
 *  二、默认后端：真 Web Audio
 * ------------------------------------------------------------
 *  后端只做"发声"这一件事：不建 AudioContext、不管情绪、不管循环。
 *  宿主（sfx.mjs / sfx.js）把**已经建好的** ctx 与 BGM 总线喂进来 ——
 *  这样"必须用户手势后才能出声"这条约束天然由宿主保证，引擎不需要知道浏览器策略。
 *
 *  总线结构（引擎自建，挂在宿主给的 BGM 总线下）：
 *      hostBus ── master ──┬── layer0
 *                          └── layer1     ← 双合成层，交叉淡入用
 *  mp3 声源也接 master。
 * ========================================================== */

/** 起音时长（秒）——8ms 是"听不到咔哒但不钝"的经验值，与 sfx.mjs 一致。 */
const ATTACK = 0.008;
const SILENT = 0.0001; // exponentialRamp 不接受 0

/**
 * @param {{ctxRef: () => any, busRef: () => any}} deps
 *   ctxRef / busRef 必须是**取值函数**而不是值：AudioContext 是懒建的，
 *   引擎构造时它还不存在。
 */
export function createWebAudioBackend({ ctxRef, busRef } = {}) {
  const live = new Set();      // 所有已 start 的发声体（oscillator / bufferSource）
  const buses = new Map();     // 'master' | 0 | 1 → GainNode
  let rampErrors = 0;
  let lastError = '';

  const ctx = () => {
    try { return ctxRef ? ctxRef() : null; } catch { return null; }
  };

  function ensureBus(key) {
    const c = ctx();
    if (!c) return null;
    const got = buses.get(key);
    if (got) return got;
    // master 必须先于层存在：层要接到 master 上
    if (key !== 'master' && !buses.has('master')) ensureBus('master');
    const g = c.createGain();
    g.gain.value = SILENT;
    const host = buses.get('master');
    let root = null;
    try { root = busRef ? busRef() : null; } catch { root = null; }
    g.connect(key === 'master' ? (root || c.destination) : (host || root || c.destination));
    buses.set(key, g);
    return g;
  }

  function ramp(getParam, value, at, dur) {
    const v = Math.max(SILENT, Number(value) || 0);
    const d = Math.max(0.01, Number(dur) || 0);
    try {
      getParam().cancelScheduledValues(at);
      getParam().setValueAtTime(Math.max(SILENT, getParam().value), at);
      getParam().exponentialRampToValueAtTime(v, at + d);
    } catch (e) {
      rampErrors += 1;
      lastError = `ramp v=${value} at=${at} dur=${dur}: ${e && e.message ? e.message : e}`;
    }
  }

  function track(node) {
    live.add(node);
    node.onended = () => { live.delete(node); };
    return node;
  }

  return {
    kind: 'webaudio',

    available() { return !!ctx(); },
    now() { const c = ctx(); return c ? c.currentTime : 0; },
    state() { const c = ctx(); return c ? c.state : null; },

    /** bus: 'master' | 0 | 1 */
    setGain(bus, v, at, dur) {
      const g = ensureBus(bus);
      if (!g) return;
      ramp(() => g.gain, v, at, dur);
    },

    note({ bus = 0, freq = 440, dur = 0.12, at = 0, type = 'triangle', gain = 0.05, cutoff = 0, slide = 0 } = {}) {
      const c = ctx();
      const b = ensureBus(bus);
      if (!c || !b) return;
      const t0 = Math.max(c.currentTime, Number(at) || 0);
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
      osc.stop(t0 + hold + 0.03);
      track(osc);
    },

    noise({ bus = 0, dur = 0.05, at = 0, gain = 0.03, hp = 0, lp = 0 } = {}) {
      const c = ctx();
      const b = ensureBus(bus);
      if (!c || !b) return;
      const t0 = Math.max(c.currentTime, Number(at) || 0);
      const len = Math.max(1, Math.floor(c.sampleRate * dur));
      const buf = c.createBuffer(1, len, c.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = c.createBufferSource();
      src.buffer = buf;
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
      g.gain.value = gain;
      node.connect(g);
      g.connect(b);
      src.start(t0);
      track(src);
    },

    /** 立刻停掉所有发声体并静音 —— stop()/suspend()/静音 走这里，不留空转振荡器。 */
    panic() {
      const c = ctx();
      const t = c ? c.currentTime : 0;
      for (const n of live) {
        try { n.stop(t); } catch { /* 已停过 / 未 start，忽略 */ }
        try { n.disconnect(); } catch { /* 忽略 */ }
      }
      live.clear();
      for (const key of ['master', 0, 1]) {
        const g = buses.get(key);
        if (!g) continue;
        try {
          g.gain.cancelScheduledValues(t);
          g.gain.setValueAtTime(SILENT, t);
        } catch { /* 忽略 */ }
      }
    },

    /** fetch + decodeAudioData。失败一律 reject，由引擎回落合成。 */
    async load(url) {
      const c = ctx();
      if (!c) throw new Error('no-ctx');
      if (typeof fetch !== 'function') throw new Error('no-fetch');
      const res = await fetch(url, { cache: 'force-cache' });
      if (!res || !res.ok) throw new Error(`http ${res ? res.status : '?'}`);
      const raw = await res.arrayBuffer();
      return await new Promise((resolve, reject) => {
        let settled = false;
        const ok = (b) => { if (!settled) { settled = true; resolve(b); } };
        const bad = (e) => { if (!settled) { settled = true; reject(e instanceof Error ? e : new Error(String(e))); } };
        try {
          const p = c.decodeAudioData(raw, ok, bad);
          if (p && typeof p.then === 'function') p.then(ok, bad);
        } catch (e) { bad(e); }
      });
    },

    playBuffer(buffer, { loop = true, gain = 1, at = 0 } = {}) {
      const c = ctx();
      const b = ensureBus('master');
      if (!c || !b || !buffer) return null;
      const t0 = Math.max(c.currentTime, Number(at) || 0);
      const src = c.createBufferSource();
      src.buffer = buffer;
      src.loop = loop === true;
      const g = c.createGain();
      g.gain.setValueAtTime(SILENT, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + MP3_FADE);
      src.connect(g);
      g.connect(b);
      src.start(t0);
      track(src);
      return { src, g };
    },

    setBufferGain(handle, { v = 1, at = 0, dur = MP3_FADE } = {}) {
      if (!handle || !handle.g) return;
      ramp(() => handle.g.gain, v, at, dur);
    },

    stopBuffer(handle, at) {
      if (!handle) return;
      try { handle.src.stop(Math.max(0, Number(at) || 0)); } catch { /* 忽略 */ }
      live.delete(handle.src);
    },

    stats() {
      return { kind: 'webaudio', live: live.size, rampErrors, lastError, buses: [...buses.keys()] };
    },
  };
}

/* ============================================================
 *  三、引擎本体
 * ========================================================== */

/**
 * 建立一台 BGM 引擎（**不建 AudioContext**，纯逻辑 + 注入后端）。
 *
 * @param {object} opts
 * @param {() => number}  [opts.getVolume]  取值 0..1（复用各游戏既有音量设置）
 * @param {() => boolean} [opts.isMuted]    静音判定（复用各游戏既有静音开关）
 * @param {object}        [opts.moods]      情绪预设覆盖表（同名浅合并，可加第六种情绪）
 * @param {object}        [opts.manifest]   mp3 插槽清单 { mood: 'assets/bgm/mood.mp3' }
 * @param {object}        [opts.backend]    注入后端（默认 createWebAudioBackend）
 * @param {object}        [opts.bus]        { ctxRef, busRef } —— 建默认后端时用
 * @param {boolean}       [opts.autoTick]   是否自带走时心跳（默认 true）；测试传 false 手动 tick
 * @param {boolean}       [opts.autoVisibility] 是否自动挂 visibilitychange（默认 true）
 * @param {object}        [opts.timer]      { set, clear } 定时器注入（测试用）
 * @param {() => number}  [opts.clock]      墙钟毫秒（mp3 超时判定用）
 * @param {number}        [opts.mp3TimeoutMs]
 * @param {boolean}       [opts.lateAdopt]  超时回落后，迟到的 mp3 是否仍接管（默认 true）
 * @param {number}        [opts.maxBuffers] 最多同时留几首**已解码**的 mp3 在内存里（默认 2，LRU）
 */
export function createBgm(opts = {}) {
  const {
    getVolume = () => 1,
    isMuted = () => false,
    moods: moodOverrides = {},
    manifest = {},
    backend = null,
    bus = null,
    autoTick = true,
    autoVisibility = true,
    timer = { set: (fn, ms) => setInterval(fn, ms), clear: (id) => clearInterval(id) },
    clock = () => Date.now(),
    mp3TimeoutMs = MP3_TIMEOUT_MS,
    lateAdopt = true,
    maxBuffers = 2,
  } = opts;

  const be = backend || (bus ? createWebAudioBackend(bus) : null);

  // ── 走时基准（**全局唯一**：换情绪只换音色/和弦，绝不动它）──
  let step = 0;
  let nextAt = 0;
  let lastTickAt = 0;
  let curBpm = MOOD_PRESETS.explore.bpm;
  let targetBpm = curBpm;

  // ── 双合成层：交叉淡入的载体 ──
  /** @type {{mood:string|null, env:number, duck:number, dead:boolean, deadAt:number}[]} */
  let layers = [
    { mood: null, env: 0, duck: 1, dead: true, deadAt: 0 },
    { mood: null, env: 0, duck: 1, dead: true, deadAt: 0 },
  ];
  let active = 0;
  let wantMood = 'explore';
  let started = false;     // 期望播放（静音/隐藏时保留，供 resume 恢复）
  let running = false;     // 调度器真的在跑
  let suspended = false;   // 被宿主 suspend()（隐藏/静音）—— 自动心跳不得自行复活

  // ── mp3 槽位 ──
  const slots = new Map(); // mood → { url, status, buffer, handle, startedMs, err }
  let mp3Busy = false;     // 有 mp3 正在播 → 合成层不再发声（省算力，position 由 step 维持）

  let timerId = null;
  let notes = 0;
  let errors = 0;
  let lastError = '';
  let lastPanicAt = null;
  let evicted = 0;

  /* ---------- 定时器 ---------- */
  function startTimer() {
    if (!autoTick || timerId != null) return;
    try { timerId = timer.set(tick, TICK_MS); } catch { timerId = null; }
  }
  function stopTimer() {
    if (timerId == null) return;
    try { timer.clear(timerId); } catch { /* 忽略 */ }
    timerId = null;
  }

  /* ---------- 层增益 ---------- */
  function layerGain(i) {
    const L = layers[i];
    return Math.max(SILENT, L.env * L.duck);
  }
  function rampLayer(i, at, dur) {
    if (!be) return;
    be.setGain(i, layerGain(i), at, dur);
  }
  function rampMaster(at, dur) {
    if (!be) return;
    be.setGain('master', Math.max(SILENT, Math.min(1, Number(getVolume()) || 0)), at, dur);
  }

  /* ---------- 硬停：所有发声体立刻停下 ---------- */
  function halt() {
    stopTimer();
    running = false;
    if (be) { try { be.panic(); } catch (e) { errors += 1; lastError = String(e); } }
    lastPanicAt = be && be.available() ? be.now() : null;
    for (const s of slots.values()) {
      s.handle = null;
      if (s.status === 'playing') s.status = s.buffer ? 'ready' : 'idle';
    }
    mp3Busy = false;
  }

  /* ---------- 起播 / 恢复 ---------- */
  function arm() {
    if (!be || !be.available()) return false;
    suspended = false;
    const t = be.now();
    const duck = layers[active] && layers[active].mood === wantMood ? layers[active].duck : 1;
    layers = [
      { mood: wantMood, env: 1, duck, dead: false, deadAt: 0 },
      { mood: null, env: 0, duck: 1, dead: true, deadAt: 0 },
    ];
    active = 0;
    rampMaster(t, 0.08);
    be.setGain(0, duck, t, 0.05);
    be.setGain(1, SILENT, t, 0.05);
    curBpm = presetOf(wantMood, moodOverrides).bpm;
    targetBpm = curBpm;
    step = 0;
    nextAt = t + 0.06;
    lastTickAt = t;
    running = true;
    startTimer();
    return true;
  }

  /* ---------- 交叉淡入（≤0.6s）---------- */
  function crossfadeTo(mood, fade, duck) {
    const t = be && be.available() ? be.now() : 0;
    const old = active;
    const nw = 1 - active;
    layers[nw] = { mood, env: 1, duck, dead: false, deadAt: 0 };
    layers[old].deadAt = t + fade + 0.05;
    active = nw;
    if (running && be && be.available()) {
      // 新层：从静音等功率淡入；旧层：同步淡出。两层共享 step/nextAt ⟹ 节奏不断。
      be.setGain(nw, SILENT, t, 0.01);
      be.setGain(nw, layerGain(nw), t, fade);
      be.setGain(old, SILENT, t, fade);
    }
    return t;
  }

  /* ---------- 发声 ---------- */
  function emitStep(at) {
    if (!be || !be.available()) return;
    for (let i = 0; i < layers.length; i++) {
      const L = layers[i];
      if (L.dead || !L.mood) continue;
      const p = presetOf(L.mood, moodOverrides);
      for (const v of voicesAtStep(L.mood, step, moodOverrides)) {
        const dur = clampToLoop(L.mood, step, v.dur, moodOverrides);
        const gain = v.gain * p.gain;
        try {
          if (v.kind === 'noise') {
            be.noise({ bus: i, at, dur, gain, hp: v.hp || 0, lp: v.lp || 0 });
          } else {
            be.note({ bus: i, at, dur, gain, freq: v.freq, slide: v.slide || 0, type: v.wave, cutoff: v.cutoff || 0 });
          }
          notes += 1;
        } catch (e) {
          errors += 1;
          lastError = String(e && e.message ? e.message : e);
        }
      }
    }
  }

  /* ---------- mp3 ---------- */
  function slotFor(mood, url) {
    let s = slots.get(mood);
    if (!s) { s = { url, status: 'idle', buffer: null, handle: null, startedMs: 0, lastUsedAt: 0, err: '' }; slots.set(mood, s); }
    if (url) s.url = url;
    return s;
  }

  /**
   * LRU 淘汰：把最久没用过的、且不是当前情绪的已解码 buffer 丢掉。
   * 见 pickEviction 的注释 —— 这是防 OOM，不是省算力。
   */
  function evictMp3(t) {
    const entries = [...slots].map(([mood, s]) => ({ mood, buffer: s.buffer, lastUsedAt: s.lastUsedAt }));
    const victim = pickEviction(entries, wantMood, maxBuffers);
    if (!victim) return;
    const s = slots.get(victim);
    if (!s) return;
    if (s.handle && be) {
      be.setBufferGain(s.handle, { v: SILENT, at: t, dur: 0.2 });
      be.stopBuffer(s.handle, t + 0.25);
    }
    s.handle = null;
    s.buffer = null;           // ← 真正释放那几百 MB
    s.status = 'idle';         // 下次进这个情绪会重新按需加载（HTTP 缓存通常已命中）
    s.lastUsedAt = 0;
    evicted += 1;
  }

  function beginLoad(s) {
    s.status = 'loading';
    s.startedMs = clock();
    if (!be || !be.available()) { s.status = 'failed'; s.err = 'no-backend'; return; }
    Promise.resolve()
      .then(() => be.load(s.url))
      .then((buf) => {
        if (!buf) throw new Error('empty-buffer');
        s.buffer = buf;
        // 超时过（fallback）也算成功 —— 迟到的 mp3 仍然接管，见 lateAdopt；
        // lateAdopt:false 时超时即永久放弃该情绪（状态停在 fallback，判定为 skip）。
        if (s.status === 'loading' || (s.status === 'fallback' && lateAdopt)) s.status = 'ready';
      })
      .catch((e) => {
        s.status = 'failed';
        s.err = String(e && e.message ? e.message : e);
      });
  }

  function adopt(s, t) {
    if (!be || !be.available() || !s.buffer) return;
    const h = be.playBuffer(s.buffer, { loop: true, gain: 1, at: t });
    if (!h) { s.status = 'failed'; s.err = 'play-failed'; return; }
    s.handle = h;
    s.status = 'playing';
    mp3Busy = true;
    // 合成层让位：交叉淡出到 0（不 panic —— 让已在途的音自然收尾，避免"啪"）
    for (let i = 0; i < layers.length; i++) if (!layers[i].dead) be.setGain(i, SILENT, t, MP3_FADE);
  }

  /** 让 mp3 让位回合成（切情绪 / 停播 / 恢复）。 */
  function releaseMp3(exceptMood, t) {
    for (const [m, s] of slots) {
      if (m === exceptMood || !s.handle) continue;
      be.setBufferGain(s.handle, { v: SILENT, at: t, dur: MP3_FADE });
      be.stopBuffer(s.handle, t + MP3_FADE + 0.05);
      s.handle = null;
      s.status = s.buffer ? 'ready' : 'idle';
    }
  }

  function pumpMp3(t) {
    const url = mp3UrlFor(manifest, wantMood);
    // 非当前情绪的 mp3 一律淡出（同时只有一个情绪在播）
    releaseMp3(wantMood, t);
    // LRU：先腾内存，再决定这一拍要不要加载
    evictMp3(t);
    if (!url) { mp3Busy = false; return; }
    const s = slotFor(wantMood, url);
    s.lastUsedAt = clock();
    const waitMs = s.status === 'loading' || s.status === 'fallback' ? clock() - s.startedMs : 0;
    const d = mp3Decision({ hasUrl: true, status: s.status, waitMs, timeoutMs: mp3TimeoutMs, lateAdopt });

    if (d === 'load') beginLoad(s);
    else if (d === 'fallback') {
      // 超时：合成继续顶着，把槽位记成 fallback（后台下载不取消）
      s.status = 'fallback';
    }
    if (s.status === 'ready') adopt(s, t);
    mp3Busy = !!s.handle;
  }

  /* ---------- 心跳 ---------- */
  function tick() {
    if (!be || !be.available()) return;
    // ① 静音 → 硬停（不是把音量拧到 0）：振荡器真的停掉，定时器也收掉
    if (isMuted()) { if (running) halt(); return; }
    // 宿主明确 suspend 过（隐藏页/静音期）：心跳不得自行 arm —— 复活只能靠 resume()
    if (suspended) return;
    if (!started) { if (running) halt(); return; }
    if (!running) arm();
    if (!running) return;

    const t = be.now();

    // ② 已有层的淡出收尾
    for (let i = 0; i < layers.length; i++) {
      const L = layers[i];
      if (!L.dead && L.deadAt && t >= L.deadAt) {
        L.dead = true;
        L.env = 0;
        try { be.setGain(i, SILENT, t, 0.05); } catch { /* 忽略 */ }
      }
    }

    // ③ 速度平滑（换情绪不"啪"地变速）
    targetBpm = presetOf(wantMood, moodOverrides).bpm;
    const dt = Math.max(0.001, Math.min(0.5, t - lastTickAt));
    lastTickAt = t;
    const kb = Math.min(1, dt / 0.45);
    curBpm += (targetBpm - curBpm) * kb;

    // ④ 音量（设置滑杆实时生效）
    rampMaster(t, 0.15);

    // ⑤ mp3 槽位
    pumpMp3(t);

    // ⑥ 走时：mp3 在播时也继续走（保持相位连续），但不发合成音
    const spb = 60 / Math.max(40, curBpm) / 4;
    if (nextAt < t) nextAt = t + 0.06;
    let guard = 0;
    while (nextAt < t + LOOKAHEAD && guard++ < 64) {
      if (!mp3Busy) emitStep(nextAt);
      step += 1;
      nextAt += spb;
    }
  }

  /* ---------- 可见性 ---------- */
  // 提成具名函数（而不是直接写在 api 里）：onVisibility 需要引用它们，
  // 而 api 对象在本行之后才构造 —— 直接写 `suspend()` 会变成自由变量，
  // tests/undefined-idents.check.mjs 会（正确地）报"未声明标识符"。
  function suspendBgm() {
    suspended = true;
    halt();
  }
  function resumeBgm() {
    if (!started || isMuted()) return;
    if (!be || !be.available()) return;
    suspended = false;
    if (!running) arm();
  }

  function onVisibility() {
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'hidden') suspendBgm();
    else resumeBgm();
  }
  if (autoVisibility && typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', onVisibility);
  }

  /* ---------- 对外接口 ---------- */
  const api = {
    /** 开始播放（宿主必须在用户手势里先建好 AudioContext）。 */
    start(mood) {
      if (mood && isMood(mood, moodOverrides)) wantMood = mood;
      started = true;
      suspended = false;
      if (isMuted() || !be || !be.available()) return api;
      if (!running) arm();
      return api;
    },

    /**
     * 切情绪。fade ≤ 0.6s；`gain` 是本状态的额外增益（night-shift 的 soft=0.5）。
     * 同情绪重复调用只是更新 gain，不会重启。
     */
    setMood(mood, o = {}) {
      const next = isMood(mood, moodOverrides) ? mood : 'explore';
      const fade = Math.max(0, Math.min(MAX_FADE, o.fade == null ? DEFAULT_FADE : Number(o.fade)));
      const duck = o.gain == null ? 1 : Math.max(0, Math.min(1, Number(o.gain)));
      const cur = layers[active];
      if (!cur || cur.mood !== next) {
        wantMood = next;
        if (started && !isMuted() && be && be.available()) {
          if (!running) arm();
          else crossfadeTo(next, fade, duck);
        } else if (cur) {
          // 还没起播（或正静音）：先记住，arm() 时会带上
          cur.mood = next;
          cur.duck = duck;
        }
      } else if (Math.abs(cur.duck - duck) > 0.01) {
        cur.duck = duck;
        if (running && be && be.available()) rampLayer(active, be.now(), Math.min(fade, 0.25));
      }
      return api;
    },

    /** 彻底停止（振荡器全停、定时器清除、mp3 停下）。 */
    stop() {
      started = false;
      suspended = false;
      halt();
      return api;
    },

    /** 隐藏 / 静音：同样硬停，但保留"想播放"的意图，resume() 能原样恢复。 */
    suspend() {
      suspendBgm();
      return api;
    },

    /** 从 suspend 恢复（若还处于静音则什么都不做）。 */
    resume() {
      resumeBgm();
      return api;
    },

    /** 音量设置变化时手动贴一次（设置页拖滑杆）。 */
    refreshVolume() {
      if (!running || !be || !be.available()) return api;
      rampMaster(be.now(), 0.08);
      return api;
    },

    /** 手动推进一拍（autoTick:false 的宿主 / 单测用）。 */
    tick,

    /* ---------- 零开销只读量（给每帧都要问一句的宿主用，不要走 stats()）---------- */
    /** 是否"想播放"（静音/隐藏期间仍为 true）。 */
    get started() { return started; },
    /** 是否真的在出声。 */
    get playing() { return running && started && !isMuted(); },
    /** 当前目标情绪。 */
    get mood() { return wantMood; },

    /** 诊断出口。 */
    stats() {
      return {
        supported: !!be,
        backend: be ? (be.kind || 'custom') : null,
        ctxState: be && be.state ? be.state() : null,
        started,
        playing: running && started && !isMuted(),
        running,
        muted: !!isMuted(),
        mood: wantMood,
        bpm: Math.round(curBpm * 10) / 10,
        volume: Number(getVolume()) || 0,
        step,
        active,
        layers: layers.map((L) => ({ mood: L.mood, env: L.env, duck: L.duck, dead: L.dead })),
        mp3: [...slots].map(([m, s]) => ({ mood: m, status: s.status, url: s.url, err: s.err, buffered: !!s.buffer })),
        mp3Playing: mp3Busy,
        mp3Evicted: evicted,
        maxBuffers,
        notes,
        errors,
        lastError,
        lastPanicAt,
      };
    },

    /** 供测试/探针读到的内部量（只读快照）。 */
    _internals: {
      get step() { return step; },
      get nextAt() { return nextAt; },
      get wantMood() { return wantMood; },
      get layers() { return layers.map((L) => ({ ...L })); },
      get mp3() { return [...slots].map(([m, s]) => ({ mood: m, ...s })); },
      get backend() { return be; },
      setMoodNow(m) { wantMood = m; if (layers[active]) layers[active].mood = m; },
      dispose() {
        stopTimer();
        if (autoVisibility && typeof document !== 'undefined' && document.removeEventListener) {
          document.removeEventListener('visibilitychange', onVisibility);
        }
      },
    },
  };

  return api;
}

export default createBgm;
