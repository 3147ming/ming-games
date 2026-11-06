// 合成音效层（第四批 P1-5）
// 口径：零音频文件、零 <audio> 标签、零依赖 —— 全部用 Web Audio 的 OscillatorNode + GainNode 现合成。
//
// 为什么不用素材：本仓一直是「零资源、静态秒开」，一个 mp3 会让首屏多一次请求，
// 也要多一份许可/体积/格式兼容的负担。6 个短音的信息量用合成完全够（≤120ms，不循环）。
//
// 三条硬约束（与 fx.js 同源）：
//   1. Node 下跑测试不能炸 —— 所有浏览器 API 都走 typeof 守卫，没有 AudioContext 就静默降级。
//   2. iOS 要求用户手势里解锁 —— unlock() 只挂 pointerdown/keydown，且只做一次。
//   3. prefers-reduced-motion: reduce 一律不播 —— 与「reduce = 关视觉噪声」的口径一致，
//      动效敏感的人通常也受不了突兀的提示音。

// ---------------------------------------------------------------------------
// 主音量 + 静音（与静音开关共用一条总线）
// ---------------------------------------------------------------------------
//
// ★ 为什么音量和静音必须拆成两个存储键：
//   它们是两个概念。静音是「现在别出声」的临时闸门，音量是「我愿意听多响」的长期偏好。
//   合成一个键（或让静音把音量写成 0）会带来两个可预期的投诉：
//   ① 静音再打开，音量回不来了（玩家上次调好的 30% 被吞了）；
//   ② 音量拖到 0 再拖回来，静音状态莫名其妙被改掉。
//   所以：静音仍在旧键 `one-card:sfx:mute`（'1'/'0'，老存档继续有效），
//   音量用新键 `one-card:sfx:volume`（带版本号的 JSON），两者互不覆盖。
//
// ★ 唯一的音量计算点：computeGain(volume, muted, base)。
//   总线增益 = muted ? 0 : volume × base，其中 base = 0.5 是改版前 master.gain 的那一半余量
//   （合成音很容易盖过一切）。默认音量 1.0，于是默认听感与改版前逐样本一致。
//
// ★ 为什么静音是「覆盖」音量，而不是再乘一个 0/1 系数：
//   如果写成 volume × (muted ? 0 : 1) × base，看起来等价，但它把静音降级成了「另一个音量系数」，
//   于是音量与静音有了两套可以互相打架的逻辑：
//     · 任何一处忘了乘静音系数，就会出现「已静音但还有声」；
//     · 任何一处把音量也乘了两次（比如每颗音再乘一次 volume），滑杆拖到 50% 实际只剩 25%，
//       波形完全正常、听感只是「怎么调都很小声」，这种 bug 极难定位。
//   静音是布尔闸门，直接 return 0 最不容易错：音量只在这里乘一次，且只乘给 base。
//   UI 的静音键也不去改音量 —— 它只翻 muted，音量原样保留（见 setMuted）。

/** 静音开关的存储键（旧版就有，格式 '1' / '0'，不迁移、不改格式）。 */
export const MUTE_KEY = 'one-card:sfx:mute';
/** 主音量的存储键 —— 与静音键刻意分开：两者是不同概念。 */
export const VOLUME_KEY = 'one-card:sfx:volume';
/** 音量存档结构版本：将来改结构时能识别老档，而不是把老档当损坏丢掉。 */
export const VOLUME_VERSION = 1;

/** 默认音量 100%：保证升级到这一版时，听感与改版前完全一致（0.5 基准 × 1.0）。 */
export const DEFAULT_VOLUME = 1;
/** 音效基准增益 = 改版前写死的 master.gain 0.5。 */
export const SFX_BASE = 0.5;

/** 内部：取默认存储；隐私模式 / Node 环境下访问 localStorage 本身都可能抛错。 */
function defaultStore() {
  try {
    return typeof globalThis !== 'undefined' ? globalThis.localStorage || null : null;
  } catch {
    return null;
  }
}

/**
 * 把任意输入夹到 [0,1]。
 * - 负数 → 0，>1 → 1（手改存档、旧版本存过 0~100 的整数，都得能救回来）
 * - NaN / Infinity / 'abc' / null / undefined / 布尔 / 对象 → fallback（默认音量或「当前值」）
 * - 数字字符串 '0.25' → 0.25：滑杆的 value 天生是字符串，这里统一接住，
 *   免得 UI 层到处写 Number() 再判一次 NaN（漏一处就是「拖到一半突然炸回默认」）。
 * - 对象/数组一律拒绝：Number([]) 是 0、Number(['0.5']) 是 0.5，
 *   存档里一个 [] 把玩家音量清零，比「回落默认」难排查得多。
 */
export function clampVolume(v, fallback = DEFAULT_VOLUME) {
  const fb = Number.isFinite(fallback) ? Math.min(1, Math.max(0, fallback)) : DEFAULT_VOLUME;
  if (v === null || v === undefined || typeof v === 'boolean') return fb;
  if (typeof v === 'object' || typeof v === 'function' || typeof v === 'symbol') return fb;
  if (typeof v === 'string' && v.trim() === '') return fb;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fb;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * 把任意 JSON 解析结果归一成 0..1 的音量。
 * 认三种形态：对象 { volume }、裸数字、裸数字字符串（老档/手改档的兜底）。
 */
export function normalizeVolume(raw, fallback = DEFAULT_VOLUME) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return clampVolume(raw.volume, fallback);
  }
  return clampVolume(raw, fallback);
}

/** JSON 文本 → 音量；解析失败一律回默认，绝不 throw（localStorage 里的东西不可信）。 */
export function parseVolume(text, fallback = DEFAULT_VOLUME) {
  if (typeof text !== 'string' || text.trim() === '') return clampVolume(fallback);
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return clampVolume(fallback);
  }
  return normalizeVolume(raw, fallback);
}

/** 音量 → JSON 文本（先夹取，保证写进去的东西永远合法）。 */
export function serializeVolume(volume) {
  return JSON.stringify({ v: VOLUME_VERSION, volume: clampVolume(volume) });
}

/** 从存储读音量。读不到 / 抛错（隐私模式）→ 默认音量。 */
export function loadVolume(store = defaultStore()) {
  let text = null;
  try {
    text = store && typeof store.getItem === 'function' ? store.getItem(VOLUME_KEY) : null;
  } catch {
    text = null;
  }
  return parseVolume(text);
}

/**
 * 写音量。写失败（配额满 / 隐私模式 / 无存储）只静默跳过：
 * 音量存不进去是小事，让整局游戏因为一次 setItem 抛错而白屏是大事。
 */
export function saveVolume(volume, store = defaultStore()) {
  const v = clampVolume(volume);
  try {
    if (store && typeof store.setItem === 'function') store.setItem(VOLUME_KEY, serializeVolume(v));
  } catch {
    /* 忽略：见函数注释 */
  }
  return v;
}

/**
 * ★ 全游戏唯一的音量计算点。
 * @param {number|string} volume 0..1（越界/脏值会被夹取或回落默认）
 * @param {boolean} muted 静音闸门
 * @param {number} base 这一路的固定基准增益（音效为 SFX_BASE = 0.5）
 * @returns {number} 0..base；静音时恒为 0
 *
 * 静音在这一行直接 return 0 —— 它覆盖音量，而不是跟音量相乘两次。
 * 因此「音量 100% + 静音」的增益是 0，「音量 50% + 静音」的增益也是 0，两者不打架。
 */
export function computeGain(volume, muted, base = SFX_BASE) {
  // 先判静音：静音时连音量是多少都不关心（音量留给"取消静音"后恢复）。
  if (muted) return 0;
  const b = Number.isFinite(base) ? Math.max(0, base) : SFX_BASE;
  return clampVolume(volume) * b;
}

/** 0..1 → 0..100 的整数百分比（UI 显示 / 滑杆取值）。 */
export function toPercent(volume) {
  return Math.round(clampVolume(volume) * 100);
}

/** 0..100 → 0..1（滑杆 input 的 value 天生是字符串，这里一并接住）。 */
export function fromPercent(percent) {
  const n = typeof percent === 'number' ? percent : Number(percent);
  if (!Number.isFinite(n)) return DEFAULT_VOLUME;
  return clampVolume(n / 100);
}

export class Sfx {
  /**
   * @param {{store?: object}} [opts] store 只给单测注入用（Node 里没有 localStorage）；
   *   不传时走 globalThis.localStorage，与旧版行为一致。
   */
  constructor(opts = {}) {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    // 存储抽成可注入的：AudioContext 在 Node 里不存在，但「读档 / 夹取 / 持久化」这些逻辑
    // 必须在无头环境里也能逐条断言（见 tests/audio-volume.test.mjs）。
    this._store = opts.store !== undefined ? opts.store : defaultStore();
    try {
      this.muted = !!(this._store && this._store.getItem(MUTE_KEY) === '1');
    } catch {
      /* 隐私模式读不到 localStorage：按默认（开）处理 */
    }
    // 音量与静音分开读：一个坏掉不该连累另一个。
    this._volume = loadVolume(this._store);
    this._reduced = false;
    try {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      this._reduced = !!mq.matches;
      mq.addEventListener?.('change', (e) => {
        this._reduced = !!e.matches;
      });
    } catch {
      /* 旧浏览器无 matchMedia */
    }
  }

  get reduced() {
    return this._reduced;
  }

  /** 是否真的会发声（UI 静音钮的状态就用这个） */
  get enabled() {
    return !this.muted && !this._reduced;
  }

  /** 当前主音量（0..1）。UI 初始化滑杆 / 百分比显示用。 */
  getVolume() {
    return this._volume;
  }

  /** 只读别名（写代码时 `sfx.volume` 比 `sfx.getVolume()` 顺手）。 */
  get volume() {
    return this._volume;
  }

  /** 当前总线增益的「应有值」（调试/探针用；设备的真值以 master.gain.value 为准）。 */
  get gain() {
    return computeGain(this._volume, this.muted);
  }

  /** 首次用户手势里调用：建 AudioContext 并 resume（iOS 只在手势里允许出声）。 */
  unlock() {
    if (this._reduced || this.muted) return;
    const AC = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;
    if (!AC) return;
    try {
      if (!this.ctx) {
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        // 0.5 基准 × 主音量（静音时 computeGain 直接给 0）。
        // 不能在这里再乘一次音量 —— 每颗音已经不再各乘音量，总线是唯一乘点。
        this.master.gain.value = computeGain(this._volume, this.muted);
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    } catch {
      this.ctx = null;
    }
  }

  /**
   * 设主音量（0..1，越界夹取）。
   * 非法值保持「当前音量」而不是跳回默认 —— 滑杆拖到一半时任何一次脏事件
   * 都不该让音量"跳"一下（那会让玩家以为是滑杆坏了）。
   */
  setVolume(v) {
    const next = clampVolume(v, this._volume);
    // 值没变就直接返回：拖动时同一个像素会重复触发 input，
    // 一秒钟几十次写 localStorage + 写总线纯属浪费（个别浏览器还会因此卡顿）。
    if (next === this._volume) return next;
    this._volume = next;
    saveVolume(this._volume, this._store);
    this._syncGain();
    return this._volume;
  }

  /** 把「音量 × 静音」写进总线。★ 唯一写 master.gain 的地方，别在别处再乘一次。 */
  _syncGain() {
    if (!this.master) return;
    try {
      this.master.gain.value = computeGain(this._volume, this.muted);
    } catch {
      /* 节点已断开（极少见）：一次音量调整不该把整局游戏搞崩 */
    }
  }

  setMuted(v) {
    this.muted = !!v;
    try {
      if (this._store) this._store.setItem(MUTE_KEY, this.muted ? '1' : '0');
    } catch {
      /* 写不进去就算了，本次会话内仍然生效 */
    }
    // 立刻同步总线：否则"点静音"要等下一次 unlock 才生效，已经建好的 AudioContext 还在响。
    this._syncGain();
    if (!this.muted) this.unlock();
  }

  toggle() {
    this.setMuted(!this.muted);
    return this.muted;
  }

  /** 单个音：attack 5ms → 指数衰减到 dur。f1 != f0 时做频率滑音。 */
  _tone({ f0, f1, dur, type = 'sine', gain = 0.08, delay = 0 }) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    if (f1 && f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    // 不能直接 ramp 到 0（exponential 要求正值），用 -80dB 的极小值代替
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  play(name) {
    if (!this.enabled || !this.ctx) return;
    switch (name) {
      // 出牌：短促的「咔」—— 高频、极短，连打不会糊成一片
      case 'card':
        this._tone({ f0: 760, f1: 520, dur: 0.06, type: 'triangle', gain: 0.07 });
        break;
      // 命中：低频下坠，带一点方波的毛刺
      case 'hit':
        this._tone({ f0: 240, f1: 110, dur: 0.09, type: 'square', gain: 0.055 });
        this._tone({ f0: 420, f1: 200, dur: 0.06, type: 'triangle', gain: 0.04 });
        break;
      // 受击：比命中更闷、更低
      case 'hurt':
        this._tone({ f0: 150, f1: 62, dur: 0.12, type: 'sawtooth', gain: 0.06 });
        break;
      // 格挡：金属感的短促上行
      case 'block':
        this._tone({ f0: 520, f1: 760, dur: 0.09, type: 'sine', gain: 0.06 });
        this._tone({ f0: 1040, f1: 1200, dur: 0.07, type: 'sine', gain: 0.028 });
        break;
      // 回血：柔和上行
      case 'heal':
        this._tone({ f0: 660, f1: 990, dur: 0.11, type: 'sine', gain: 0.05 });
        break;
      // 胜利：三音上行（大三和弦的骨架），总长 0.3s，正好卡在本批的时长上限
      case 'win':
        this._tone({ f0: 523, dur: 0.1, type: 'triangle', gain: 0.06, delay: 0 });
        this._tone({ f0: 659, dur: 0.1, type: 'triangle', gain: 0.055, delay: 0.09 });
        this._tone({ f0: 784, dur: 0.14, type: 'triangle', gain: 0.06, delay: 0.18 });
        break;
      // 死亡：两音下行，尾音拖长一点让"结束"落地
      case 'lose':
        this._tone({ f0: 330, f1: 300, dur: 0.14, type: 'sine', gain: 0.06, delay: 0 });
        this._tone({ f0: 196, f1: 150, dur: 0.22, type: 'sine', gain: 0.055, delay: 0.13 });
        break;
      default:
        break;
    }
  }
}
