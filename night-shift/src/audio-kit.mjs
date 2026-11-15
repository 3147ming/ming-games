/**
 * 离线合成音频引擎（参考件「几猫3A大作」的音频做法移植）
 *
 * ── 为什么不再用"实时振荡器" ─────────────────────────────
 * src/sfx.mjs 原来的每个音效都是"临时建 2~3 个 Oscillator + Gain"：
 *   · 每次触发都要建节点、跑包络，手机上一次 5 个音就会抖；
 *   · 没有变体 —— 连续三次脚步完全同频，听感立刻"电子味"；
 *   · 没有空间 —— 所有声音干巴巴地贴在耳朵上，店内/店外没有区别；
 *   · 没有声部管理 —— 结算时 cashIn 连发 8 声 + 提示音，容易互相截断/爆音。
 *
 * 这里改成**离线合成 + 缓冲复用**（与参考件 game.js 5579 行同一路数）：
 *   1) 用确定性种子把一段波形算进 Float32Array（噪声瞬态 / 扫频正弦 / 模态谐振三层）；
 *   2) 峰值归一 + 首尾淡入淡出 + 循环缝交叉淡化；
 *   3) 播放时只建 BufferSource + Gain（可选 Panner），节点数降到 2~3 个且不含 DSP；
 *   4) 声部池 + 优先级抢占 + 同名并发上限；
 *   5) 两条合成 IR 的卷积混响（店内 / 街道），按区域交叉淡化。
 *
 * ── 为什么不引音频文件（ADR-001/ADR-004 同精神）────────────
 * 全部程序化生成：零素材、零版权、离线可跑、可单测。
 * 合成函数是纯函数（给定 sr / 种子 → 固定波形），因此能进 node:test。
 */

/* ============================================================
 *  一、DSP 原语（纯函数，可在 node 里直接测）
 * ========================================================== */

/** 确定性随机（xorshift32）：同一 seed 永远得到同一段波形 */
export function rngOf(seed) {
  let s = (seed | 0) || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** 字符串 → 32 位种子（FNV-1a），让"音名 + 变体号"决定波形 */
export function seedOf(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 分配一段单声道缓冲 */
export function alloc(sr, seconds) {
  return new Float32Array(Math.max(1, Math.round(sr * seconds)));
}

/**
 * RBJ 双二阶滤波器（原地处理）。
 * 为什么手写而不用 BiquadFilterNode：离线合成没有节点图，且需要"先滤波再混音"的顺序控制。
 */
export function biquad(buf, sr, type, freq, q = 0.707) {
  const n = buf.length;
  if (!n) return buf;
  const f = Math.min(Math.max(freq, 10), sr * 0.47);
  const w = (2 * Math.PI * f) / sr;
  const cosw = Math.cos(w);
  const alpha = Math.sin(w) / (2 * Math.max(0.05, q));
  let b0, b1, b2, a0, a1, a2;
  if (type === 'hp') {
    b0 = (1 + cosw) / 2; b1 = -(1 + cosw); b2 = b0;
  } else if (type === 'bp') {
    b0 = alpha; b1 = 0; b2 = -alpha;
  } else {
    b0 = (1 - cosw) / 2; b1 = 1 - cosw; b2 = b0;
  }
  a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha;
  b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < n; i++) {
    const x = buf[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y; buf[i] = y;
  }
  return buf;
}

/** 峰值归一：合成层之间的相对响度靠调用者给 gain，最终统一拉到 peak */
export function normalize(buf, peak = 1) {
  let max = 0;
  for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > max) max = v; }
  if (max > 1e-9) {
    const k = peak / max;
    for (let i = 0; i < buf.length; i++) buf[i] *= k;
  }
  return buf;
}

/** 首尾淡入淡出：防爆音（起音不留 0 值会"咔"一声） */
export function fadeEdges(buf, sr, inSec = 0.002, outSec = 0.01) {
  const ni = Math.min(buf.length >> 1, Math.round(inSec * sr));
  const no = Math.min(buf.length >> 1, Math.round(outSec * sr));
  for (let i = 0; i < ni; i++) buf[i] *= i / ni;
  for (let i = 0; i < no; i++) {
    const k = i / no;
    buf[buf.length - 1 - i] *= k * k;
  }
  return buf;
}

/**
 * 循环缝交叉淡化：把尾部 xfade 秒叠到头部，再裁短。
 * 为什么必须要：冰箱嗡鸣/雨声是 loop 播放的，缝上有跳变就会每秒"哒"一下 ——
 * 这是循环音频最典型的破绽，靠"淡入淡出"是修不掉的（那样会听到呼吸感）。
 */
export function loopSeam(buf, sr, xfadeSec = 0.12) {
  const x = Math.min(buf.length >> 1, Math.round(xfadeSec * sr));
  if (x < 8) return buf;
  const out = buf.slice(0, buf.length - x);
  for (let i = 0; i < x; i++) {
    const t = i / x;
    const a = Math.sin(t * Math.PI / 2);
    const b = Math.cos(t * Math.PI / 2);
    out[i] = buf[i] * a + buf[buf.length - x + i] * b;
  }
  return out;
}

/** 叠加：把 src 以 gain 混到 dst 的 at 秒处（越界自动裁剪） */
export function mixInto(dst, src, sr, atSec = 0, gain = 1) {
  const off = Math.round(atSec * sr);
  const start = Math.max(0, -off);
  const end = Math.min(src.length, dst.length - off);
  for (let i = start; i < end; i++) dst[off + i] += src[i] * gain;
  return dst;
}

/**
 * 噪声瞬态：滤波噪声 × 指数衰减包络。
 * 这是"敲击类"声音的主体（脚步、硬币、机械碰撞）。
 * @param opts { dur, decay, att, hp, lp, bp, q }
 */
export function noiseBurst(sr, rng, opts = {}) {
  const { dur = 0.05, decay = 0.015, att = 0.0008, hp = 0, lp = 0, bp = 0, q = 1 } = opts;
  const buf = alloc(sr, dur);
  const tau = Math.max(1e-4, decay);
  const atk = Math.max(1e-5, att);
  for (let i = 0; i < buf.length; i++) {
    const t = i / sr;
    const env = (1 - Math.exp(-t / atk)) * Math.exp(-t / tau);
    buf[i] = (rng() * 2 - 1) * env;
  }
  if (bp > 0) biquad(buf, sr, 'bp', bp, q);
  if (hp > 0) biquad(buf, sr, 'hp', hp, 0.707);
  if (lp > 0) biquad(buf, sr, 'lp', lp, 0.707);
  return normalize(buf, 1);
}

/**
 * 扫频正弦体：给敲击加"厚度"（脚步的闷响、落地的低音）。
 * 频率从 f0 指数滑到 f1，幅度按 ampTau 衰减。
 */
export function sweep(sr, opts = {}) {
  const { dur = 0.08, f0 = 180, f1 = 60, pitchTau = 0.02, ampTau = 0.03, att = 0.001 } = opts;
  const buf = alloc(sr, dur);
  let phase = 0;
  for (let i = 0; i < buf.length; i++) {
    const t = i / sr;
    const f = f1 + (f0 - f1) * Math.exp(-t / Math.max(1e-4, pitchTau));
    phase += (2 * Math.PI * f) / sr;
    buf[i] = Math.sin(phase) * Math.exp(-t / Math.max(1e-4, ampTau)) * (1 - Math.exp(-t / Math.max(1e-5, att)));
  }
  return normalize(buf, 1);
}

/**
 * 模态谐振：一组指数衰减的正弦叠加（金属/玻璃/木头）。
 * partials = [[频率, 衰减秒, 增益], ...]
 */
export function modal(sr, opts = {}) {
  const { dur = 0.2, partials = [] } = opts;
  const buf = alloc(sr, dur);
  for (const [freq, decay, gain = 1] of partials) {
    if (!(freq > 0) || freq > sr * 0.46) continue;
    const step = (2 * Math.PI * freq) / sr;
    const k = Math.exp(-1 / (Math.max(1e-3, decay) * sr));
    let a = gain;
    for (let i = 0; i < buf.length; i++) {
      buf[i] += Math.sin(step * i) * a;
      a *= k;
      if (a < 1e-5) break;
    }
  }
  // 起音淡入 0.4ms：模态叠加自带瞬时跳变，不淡入会"啪"
  const ni = Math.min(buf.length, Math.round(0.0004 * sr));
  for (let i = 0; i < ni; i++) buf[i] *= i / ni;
  return normalize(buf, 1);
}

/** 软削波（tanh 归一）：用来给"撞击"加质感，避免硬 clip 的刺耳 */
export function softClip(buf, drive = 1.5) {
  const k = 1 / Math.tanh(drive);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(buf[i] * drive) * k;
  return buf;
}

/* ============================================================
 *  二、音色库（每条 = 一个生成器 + 并发/总线/优先级）
 * ========================================================== */

/** 高频"咔"：所有机械/塑料接触声的共用零件 */
function clickPart(sr, rng, freq = 2600, dur = 0.012) {
  return noiseBurst(sr, rng, { dur, decay: dur * 0.25, hp: freq * 0.8, lp: freq * 2.4 });
}

const SOUNDS = {
  /** 瓷砖脚步：清脆（高频噪声 + 短低频） */
  step_tile: {
    n: 3, sr: 32000, peak: 0.42, bus: 'near', max: 3, pri: 3,
    gen(sr, rng) {
      const b = alloc(sr, 0.14);
      mixInto(b, noiseBurst(sr, rng, { dur: 0.07, decay: 0.014, hp: 1100, lp: 5200 }), sr, 0, 1.0);
      mixInto(b, sweep(sr, { dur: 0.09, f0: 170, f1: 70, ampTau: 0.028 }), sr, 0, 0.55);
      mixInto(b, noiseBurst(sr, rng, { dur: 0.02, decay: 0.004, bp: 3200, q: 1.2 }), sr, 0.002, 0.35);
      return b;
    },
  },
  /** 地毯/软地脚步：闷（低通噪声，低频更弱） */
  step_carpet: {
    n: 3, sr: 32000, peak: 0.34, bus: 'near', max: 3, pri: 3,
    gen(sr, rng) {
      const b = alloc(sr, 0.16);
      mixInto(b, noiseBurst(sr, rng, { dur: 0.10, decay: 0.026, lp: 900 }), sr, 0, 1.0);
      mixInto(b, sweep(sr, { dur: 0.07, f0: 120, f1: 60, ampTau: 0.022 }), sr, 0, 0.35);
      return b;
    },
  },
  /** 硬币"叮"：三 partial 金属 + 极短噪声 */
  coin: {
    n: 2, sr: 44100, peak: 0.5, bus: 'dry', max: 3, pri: 5,
    gen(sr, rng) {
      const b = alloc(sr, 0.26);
      mixInto(b, modal(sr, { dur: 0.24, partials: [[2093, 0.075, 1], [3136, 0.05, 0.55], [4712, 0.03, 0.35]] }), sr, 0, 1);
      mixInto(b, clickPart(sr, rng, 4200, 0.008), sr, 0, 0.5);
      return b;
    },
  },
  /** 弹珠/塑料落槽：干脆的"嗒" */
  clack: {
    n: 2, sr: 44100, peak: 0.42, bus: 'near', max: 3, pri: 4,
    gen(sr, rng) {
      const b = alloc(sr, 0.09);
      mixInto(b, noiseBurst(sr, rng, { dur: 0.03, decay: 0.006, hp: 2200, lp: 11000 }), sr, 0, 1);
      mixInto(b, modal(sr, { dur: 0.08, partials: [[1420, 0.014, 1], [2630, 0.009, 0.5]] }), sr, 0, 0.6);
      return b;
    },
  },
  /** 投币：两声金属碰撞 + 落底闷响 */
  insert_coin: {
    n: 2, sr: 44100, peak: 0.5, bus: 'near', max: 2, pri: 5,
    gen(sr, rng) {
      const b = alloc(sr, 0.42);
      mixInto(b, modal(sr, { dur: 0.18, partials: [[1980, 0.05, 1], [2650, 0.03, 0.5]] }), sr, 0, 0.7);
      mixInto(b, clickPart(sr, rng, 3200, 0.006), sr, 0, 0.6);
      mixInto(b, modal(sr, { dur: 0.16, partials: [[1560, 0.045, 1], [2210, 0.025, 0.45]] }), sr, 0.055, 0.5);
      mixInto(b, sweep(sr, { dur: 0.16, f0: 620, f1: 300, ampTau: 0.05 }), sr, 0.10, 0.45);
      return b;
    },
  },
  /** 收银机抽屉：滑轨噪声 + 铃 + 碰撞 */
  drawer: {
    n: 1, sr: 44100, peak: 0.55, bus: 'near', max: 2, pri: 6,
    gen(sr, rng) {
      const b = alloc(sr, 0.5);
      mixInto(b, noiseBurst(sr, rng, { dur: 0.12, decay: 0.035, hp: 700, lp: 4200, att: 0.004 }), sr, 0, 0.8);
      mixInto(b, modal(sr, { dur: 0.34, partials: [[1180, 0.10, 0.7], [1760, 0.06, 0.4]] }), sr, 0.14, 0.5);
      mixInto(b, sweep(sr, { dur: 0.1, f0: 260, f1: 120, ampTau: 0.03 }), sr, 0.145, 0.7);
      return b;
    },
  },
  /** 扫码枪：一声短促高频"嘀" + 按键 */
  scanner: {
    n: 1, sr: 44100, peak: 0.4, bus: 'near', max: 2, pri: 6,
    gen(sr, rng) {
      const b = alloc(sr, 0.12);
      mixInto(b, sweep(sr, { dur: 0.06, f0: 2450, f1: 2380, pitchTau: 0.3, ampTau: 0.05, att: 0.002 }), sr, 0, 0.9);
      mixInto(b, clickPart(sr, rng, 3600, 0.006), sr, 0, 0.35);
      return b;
    },
  },
  /** 便利店门铃：经典两音（上行四度），带长尾 —— 听过就忘不掉的那种 */
  door_chime: {
    n: 1, sr: 44100, peak: 0.5, bus: 'amb', max: 1, pri: 7,
    gen(sr, rng) {
      const b = alloc(sr, 1.15);
      mixInto(b, modal(sr, { dur: 0.9, partials: [[659.25, 0.42, 1], [1318.5, 0.2, 0.35], [1977.8, 0.1, 0.12]] }), sr, 0, 0.75);
      mixInto(b, modal(sr, { dur: 0.9, partials: [[880, 0.5, 1], [1760, 0.22, 0.3], [2640, 0.1, 0.1]] }), sr, 0.18, 0.85);
      mixInto(b, clickPart(sr, rng, 5200, 0.01), sr, 0, 0.12);
      return b;
    },
  },
  /** 冰箱嗡鸣（loop）：50Hz 基频 + 谐波 + 低通噪声 */
  fridge_hum: {
    n: 1, sr: 32000, peak: 0.28, bus: 'amb', loop: true, max: 1, pri: 1,
    gen(sr, rng) {
      const dur = 2.2;
      const b = alloc(sr, dur + 0.2);
      for (let i = 0; i < b.length; i++) {
        const t = i / sr;
        // 轻微频率漂移，避免"纯电子音"
        const drift = 1 + 0.004 * Math.sin(2 * Math.PI * 0.23 * t);
        b[i] = 0.5 * Math.sin(2 * Math.PI * 50 * drift * t)
          + 0.28 * Math.sin(2 * Math.PI * 100 * drift * t + 0.7)
          + 0.12 * Math.sin(2 * Math.PI * 150 * drift * t + 1.3);
      }
      mixInto(b, noiseBurst(sr, rng, { dur, decay: dur * 0.9, lp: 420, att: 0.3 }), sr, 0, 0.25);
      // 缓慢起伏（压缩机负载），周期 4.4s，落在 loop 长度上正好两拍
      for (let i = 0; i < b.length; i++) b[i] *= 0.82 + 0.18 * Math.sin((2 * Math.PI * i) / (2.2 * sr));
      return loopSeam(b, sr, 0.15);
    },
  },
  /** 夜雨（loop）：宽频噪声 + 稀疏雨滴 */
  rain: {
    n: 1, sr: 32000, peak: 0.4, bus: 'amb', loop: true, max: 1, pri: 1,
    gen(sr, rng) {
      const dur = 3.0;
      const b = alloc(sr, dur + 0.3);
      mixInto(b, noiseBurst(sr, rng, { dur, decay: dur * 0.8, hp: 900, lp: 9000, att: 0.25 }), sr, 0, 0.8);
      mixInto(b, noiseBurst(sr, rng, { dur, decay: dur * 0.9, lp: 500, att: 0.2 }), sr, 0, 0.35);
      // 稀疏雨滴：每 40-90ms 一个极短高频点
      let t = 0.02;
      while (t < dur - 0.05) {
        const len = 0.004 + rng() * 0.01;
        const amp = 0.1 + rng() * 0.25;
        mixInto(b, noiseBurst(sr, rng, { dur: len, decay: len * 0.35, hp: 4200 }), sr, t, amp);
        t += 0.04 + rng() * 0.09;
      }
      return loopSeam(b, sr, 0.2);
    },
  },
  /** 街外底噪（loop）：低频车流 + 偶发掠过 */
  street: {
    n: 1, sr: 32000, peak: 0.32, bus: 'amb', loop: true, max: 1, pri: 1,
    gen(sr, rng) {
      const dur = 4.0;
      const b = alloc(sr, dur + 0.4);
      mixInto(b, noiseBurst(sr, rng, { dur, decay: dur * 0.9, lp: 520, att: 0.3 }), sr, 0, 0.9);
      mixInto(b, noiseBurst(sr, rng, { dur, decay: dur * 0.9, bp: 240, q: 0.6, att: 0.3 }), sr, 0, 0.4);
      for (let k = 0; k < 3; k++) {
        const at = 0.4 + rng() * (dur - 1.2);
        const pass = noiseBurst(sr, rng, { dur: 0.9, decay: 0.35, bp: 900 + rng() * 700, q: 0.8, att: 0.25 });
        mixInto(b, pass, sr, at, 0.12 + rng() * 0.1);
      }
      return loopSeam(b, sr, 0.25);
    },
  },
  /** IR：便利店内部（短、密、早反射明显） */
  ir_store: {
    n: 1, sr: 44100, peak: 0.85, ir: true, gen(sr, rng) {
      const dur = 0.42;
      const b = alloc(sr, dur);
      // 早反射：6 个离散脉冲（货架/冰柜/地面的第一次反射）
      const taps = [[0.005, 0.9], [0.009, 0.6], [0.014, 0.5], [0.021, 0.35], [0.029, 0.28], [0.038, 0.2]];
      for (const [t, g] of taps) {
        const i = Math.round(t * sr);
        if (i < b.length) b[i] += g;
      }
      // 扩散尾：指数衰减噪声
      const tail = noiseBurst(sr, rng, { dur, decay: 0.09, lp: 5200, att: 0.004 });
      for (let i = 0; i < b.length; i++) b[i] += tail[i] * 0.42;
      // 低频稍微留一点（店内玻璃与货架的"厚度"）
      biquad(b, sr, 'hp', 90, 0.707);
      return fadeEdges(b, sr, 0.001, 0.05);
    },
  },
  /** IR：街道（长、暗、稀疏） */
  ir_street: {
    n: 1, sr: 44100, peak: 0.85, ir: true, gen(sr, rng) {
      const dur = 1.25;
      const b = alloc(sr, dur);
      const tail = noiseBurst(sr, rng, { dur, decay: 0.34, lp: 2200, att: 0.01 });
      for (let i = 0; i < b.length; i++) b[i] += tail[i] * 0.5;
      const taps = [[0.012, 0.5], [0.027, 0.34], [0.05, 0.22], [0.09, 0.14]];
      for (const [t, g] of taps) {
        const i = Math.round(t * sr);
        if (i < b.length) b[i] += g;
      }
      biquad(b, sr, 'hp', 120, 0.707);
      return fadeEdges(b, sr, 0.002, 0.12);
    },
  },
};

/** 供测试/诊断读取的音色表快照 */
export function soundNames() { return Object.keys(SOUNDS); }
export function soundSpec(name) {
  const d = SOUNDS[name];
  return d ? { n: d.n, sr: d.sr, peak: d.peak, bus: d.bus, loop: !!d.loop, ir: !!d.ir, max: d.max ?? 1, pri: d.pri ?? 1 } : null;
}

/**
 * 合成一条音色（纯函数，node 可直接调用）。
 * @returns { sr, ch: Float32Array[], peak, loop }
 */
export function synthesize(name, variant = 0, srOverride = 0) {
  const def = SOUNDS[name];
  if (!def) return null;
  const sr = srOverride || def.sr;
  const v = ((variant % def.n) + def.n) % def.n;
  const rng = rngOf(seedOf(`${name}#${v}`));
  let buf = def.gen(sr, rng, v);
  if (!buf || !buf.length) return null;
  if (!def.loop && !def.ir) fadeEdges(buf, sr, 0.0015, 0.02);
  normalize(buf, def.peak);
  let peak = 0;
  for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > peak) peak = a; }
  return { sr, ch: [buf], peak, loop: !!def.loop };
}

/* ============================================================
 *  三、运行时：总线 / 混响 / 声部池
 * ========================================================== */

const MAX_VOICES = 26;

/**
 * @param opts { ctx, master }  master = sfx 的主总线（GainNode）
 */
export function createAudioKit(opts = {}) {
  const ctx = opts.ctx ?? null;
  const master = opts.master ?? null;
  if (!ctx || !master) return nullKit();

  const now = () => ctx.currentTime;
  let buffers = new Map();     // name#variant → AudioBuffer
  let generated = 0;
  let genMs = 0;
  let plays = 0;
  let steals = 0;
  let dropped = 0;
  let lastErr = '';

  /* ---- 总线图 ----
   * near/world/amb/dry 四条 → kitSum → 压缩 → 软削波 → master
   * kitSum 另有一路 send → 卷积混响 → master
   * 为什么要压缩 + 软削波：cashIn 连发 8 声、结算 + 提示音叠加时，
   * 总线上会出现瞬时 >1 的峰值，直接送到 destination 就是爆音（手机尤甚）。
   */
  let kitSum = null;
  let comp = null;
  let shaper = null;
  let revSend = null;
  const buses = {};
  const convolvers = {};
  const revGains = {};
  let zone = 'store';

  function buildGraph() {
    kitSum = ctx.createGain(); kitSum.gain.value = 1;
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 8;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.18;
    shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1025);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      const a = Math.abs(x);
      curve[i] = Math.sign(x) * (a <= 0.65 ? a : 0.65 + 0.35 * Math.tanh((a - 0.65) / 0.35));
    }
    shaper.curve = curve;
    try { shaper.oversample = '2x'; } catch { /* 老浏览器忽略 */ }

    kitSum.connect(comp);
    comp.connect(shaper);
    shaper.connect(master);

    revSend = ctx.createGain();
    revSend.gain.value = 0.5;
    kitSum.connect(revSend);
    for (const z of ['store', 'street']) {
      const conv = ctx.createConvolver();
      const g = ctx.createGain();
      g.gain.value = z === 'store' ? 1 : 0;
      revSend.connect(conv);
      conv.connect(g);
      g.connect(master);
      convolvers[z] = conv;
      revGains[z] = g;
    }

    for (const [name, gain] of [['near', 0.95], ['world', 1], ['amb', 0.85], ['dry', 1]]) {
      const g = ctx.createGain();
      g.gain.value = gain;
      g.connect(kitSum);
      buses[name] = g;
    }
  }
  try { buildGraph(); } catch (e) { lastErr = String(e?.message ?? e); return nullKit(lastErr); }

  /* ---- 缓冲生成 ---- */
  function ensure(name, variant = 0) {
    const def = SOUNDS[name];
    if (!def) return null;
    const v = ((variant % def.n) + def.n) % def.n;
    const key = `${name}#${v}`;
    const hit = buffers.get(key);
    if (hit) return hit;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const spec = synthesize(name, v, ctx.sampleRate);
    if (!spec) return null;
    const ab = ctx.createBuffer(1, spec.ch[0].length, spec.sr);
    ab.getChannelData(0).set(spec.ch[0]);
    buffers.set(key, ab);
    generated++;
    genMs += (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    return ab;
  }

  /** 预热：把"短音"一次性算好（循环/IR 也一起，总量很小），避免第一次交互卡一下 */
  let warmed = false;
  function warm() {
    if (warmed) return;
    warmed = true;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    for (const name of Object.keys(SOUNDS)) {
      const def = SOUNDS[name];
      for (let v = 0; v < def.n; v++) ensure(name, v);
    }
    const irStore = buffers.get('ir_store#0');
    if (irStore && convolvers.store) convolvers.store.buffer = irStore;
    const irStreet = buffers.get('ir_street#0');
    if (irStreet && convolvers.street) convolvers.street.buffer = irStreet;
    genMs += (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  }

  /* ---- 声部池 ---- */
  const voices = [];

  function prune(t) {
    for (let i = voices.length - 1; i >= 0; i--) {
      if (voices[i].end <= t) voices.splice(i, 1);
    }
  }

  function activeOf(name, t) {
    let n = 0;
    for (const v of voices) if (v.name === name && v.end > t) n++;
    return n;
  }

  /** 找最该被抢的声部：优先级最低、结束最早的 */
  function pickVictim() {
    let victim = null;
    for (const v of voices) {
      if (!victim) { victim = v; continue; }
      if (v.pri < victim.pri || (v.pri === victim.pri && v.end < victim.end)) victim = v;
    }
    return victim;
  }

  function stopVoice(v) {
    try { v.gain.gain.cancelScheduledValues(now()); v.gain.gain.setTargetAtTime(0, now(), 0.006); } catch { /* 忽略 */ }
    try { v.src.stop(now() + 0.03); } catch { /* 已经停了 */ }
    const i = voices.indexOf(v);
    if (i >= 0) voices.splice(i, 1);
  }

  /**
   * 播放一次性音效。
   * @param name  音色名（SOUNDS 的键）
   * @param o     { gain, rate, delay, pos:{x,y,z}, pri, bus, jitter }
   * @returns boolean 是否真的发声（false = 被并发上限挡掉 / 还没生成好）
   */
  function play(name, o = {}) {
    const def = SOUNDS[name];
    if (!def || def.ir || def.loop) return false;
    const t = now();
    prune(t);
    const gain = Number.isFinite(o.gain) ? o.gain : 1;
    const pri = Number.isFinite(o.pri) ? o.pri : def.pri;
    if (activeOf(name, t) >= (def.max ?? 2)) { dropped++; return false; }
    if (voices.length >= MAX_VOICES) {
      const victim = pickVictim();
      if (!victim || victim.pri > pri) { dropped++; return false; }
      stopVoice(victim);
      steals++;
    }
    const buf = ensure(name, o.variant ?? 0);
    if (!buf) return false;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    const jitter = Number.isFinite(o.jitter) ? o.jitter : 0.03;
    src.playbackRate.value = Math.max(0.25, Math.min(4, (o.rate ?? 1) * (1 + (Math.random() * 2 - 1) * jitter)));

    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g);

    let tail = g;
    if (o.pos && ctx.createPanner) {
      try {
        const p = ctx.createPanner();
        p.panningModel = 'equalpower';
        p.distanceModel = 'inverse';
        p.refDistance = 2.5;
        p.rolloffFactor = 0.8;
        p.maxDistance = 60;
        if (p.positionX) { p.positionX.value = o.pos.x; p.positionY.value = o.pos.y; p.positionZ.value = o.pos.z; }
        else p.setPosition(o.pos.x, o.pos.y, o.pos.z);
        g.connect(p);
        tail = p;
      } catch { /* 定位不可用就退回立体声 */ }
    }

    const bus = buses[o.bus ?? def.bus] ?? buses.dry;
    tail.connect(bus);

    const delay = Math.max(0, o.delay ?? 0);
    const dur = buf.duration / src.playbackRate.value;
    const v = { name, src, gain: g, pri, end: t + delay + dur + 0.02 };
    voices.push(v);
    src.onended = () => {
      const i = voices.indexOf(v);
      if (i >= 0) voices.splice(i, 1);
      try { g.disconnect(); tail.disconnect(); } catch { /* 忽略 */ }
    };
    try {
      src.start(t + delay);
      plays++;
      return true;
    } catch (e) {
      lastErr = String(e?.message ?? e);
      return false;
    }
  }

  /* ---- 循环层 ---- */
  const loops = new Map();

  function startLoop(name, o = {}) {
    const def = SOUNDS[name];
    if (!def || !def.loop) return false;
    if (loops.has(name)) { setLoopGain(name, o.gain ?? 1); return true; }
    const buf = ensure(name, 0);
    if (!buf) return false;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    src.connect(g);
    const bus = buses[def.bus] ?? buses.amb;
    g.connect(bus);
    try { src.start(now()); } catch (e) { lastErr = String(e?.message ?? e); return false; }
    const fade = Math.max(0.05, o.fade ?? 1.2);
    g.gain.setTargetAtTime(o.gain ?? 1, now(), fade / 3);
    loops.set(name, { src, gain: g, target: o.gain ?? 1 });
    return true;
  }

  function setLoopGain(name, v) {
    const l = loops.get(name);
    if (!l) return false;
    l.target = v;
    try { l.gain.gain.setTargetAtTime(Math.max(0.0001, v), now(), 0.35); } catch { /* 忽略 */ }
    return true;
  }

  function stopLoop(name, fade = 0.8) {
    const l = loops.get(name);
    if (!l) return false;
    loops.delete(name);
    try {
      l.gain.gain.cancelScheduledValues(now());
      l.gain.gain.setTargetAtTime(0.0001, now(), Math.max(0.05, fade) / 3);
      l.src.stop(now() + Math.max(0.1, fade) * 1.5);
    } catch { /* 忽略 */ }
    return true;
  }

  /** 区域切换：店内 / 街道（混响尾巴交叉淡化） */
  function setZone(z) {
    if (z !== 'store' && z !== 'street') return;
    if (z === zone) return;
    zone = z;
    const t = now();
    for (const k of ['store', 'street']) {
      const g = revGains[k];
      if (!g) continue;
      const target = k === z ? 1 : 0;
      try {
        g.gain.cancelScheduledValues(t);
        g.gain.setTargetAtTime(target, t, 0.25);
      } catch { /* 忽略 */ }
    }
  }

  /** 听者位置/朝向（每帧喂一次即可；只在有定位声部时才真正有意义） */
  function setListener(pos, forward) {
    if (!ctx.listener || !pos) return;
    const L = ctx.listener;
    try {
      if (L.positionX) {
        L.positionX.value = pos.x; L.positionY.value = pos.y; L.positionZ.value = pos.z;
        if (forward) { L.forwardX.value = forward.x; L.forwardY.value = forward.y; L.forwardZ.value = forward.z; }
      } else {
        L.setPosition(pos.x, pos.y, pos.z);
        if (forward && L.setOrientation) L.setOrientation(forward.x, forward.y, forward.z, 0, 1, 0);
      }
    } catch { /* 忽略 */ }
  }

  function stats() {
    return {
      ready: !!kitSum,
      zone,
      voices: voices.length,
      loops: [...loops.keys()],
      buffers: buffers.size,
      generated,
      plays,
      steals,
      dropped,
      genMs: Math.round(genMs * 100) / 100,
      lastErr,
      names: Object.keys(SOUNDS).length,
    };
  }

  return {
    play, startLoop, setLoopGain, stopLoop, setZone, setListener, warm, stats,
    get ready() { return !!kitSum; },
    get zone() { return zone; },
  };
}

/** 设备不可用时的空实现（调用方无需 if 分支） */
function nullKit(err = '') {
  const noop = () => false;
  return {
    play: noop, startLoop: noop, setLoopGain: noop, stopLoop: noop,
    setZone: () => {}, setListener: () => {}, warm: () => {},
    ready: false, zone: 'store',
    stats: () => ({ ready: false, zone: 'store', voices: 0, loops: [], buffers: 0, generated: 0, plays: 0, steals: 0, dropped: 0, genMs: 0, lastErr: err, names: 0 }),
  };
}
