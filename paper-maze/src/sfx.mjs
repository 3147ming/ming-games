// 《纸上迷城》— 程序化音效（Web Audio，零素材）
// 规则：浏览器要求用户手势后才能出声，因此 unlock() 必须由真实手势触发。
// 没有 AudioContext 的环境（node / 老浏览器）自动降级为静音，不抛异常。
//
// 音量架构：本文件只负责"把设置变成增益"，值的来源与校验在 audio-volume.mjs。
// 每一声的 spec.gain 是该音的固定配比（音色/响度基准），再乘**一次**总增益。
// 全文件只有 master.gain 这一个地方乘 volume —— 若在 tone() 里逐声再乘一遍，
// 就成了 volume²：滑杆 50% 只剩 25% 响度，波形完全正常，极难排查。

import { clampVolume, channelGain, DEFAULT_VOLUME } from './audio-volume.mjs';

const NOTES = {
  step: { type: 'triangle', freq: 196, dur: 0.07, gain: 0.05 },
  item: { type: 'sine', freq: 660, dur: 0.12, gain: 0.07, slide: 880 },
  combine: { type: 'sawtooth', freq: 300, dur: 0.16, gain: 0.05, slide: 520 },
  solve: { type: 'sine', freq: 523, dur: 0.22, gain: 0.08, chord: [659, 784] },
  wrong: { type: 'square', freq: 150, dur: 0.18, gain: 0.05, slide: 96 },
  hint: { type: 'sine', freq: 880, dur: 0.1, gain: 0.05, slide: 1180 },
  ending: { type: 'sine', freq: 392, dur: 0.7, gain: 0.09, chord: [523, 659, 784] },
  page: { type: 'triangle', freq: 420, dur: 0.05, gain: 0.04 },
};

export function createSfx(opts = {}) {
  let ctx = null;
  let master = null;
  let muted = !!opts.muted;
  // 非法初始音量回默认值，而不是让 NaN 一路传进 gain.value（Web Audio 会抛错）。
  let volume = clampVolume(opts.volume, DEFAULT_VOLUME);
  const Ctor = () => globalThis.AudioContext || globalThis.webkitAudioContext || null;

  /**
   * 当前实际总线增益。唯一公式在 audio-volume.mjs 的 channelGain() 里：
   *   静音 → 0；否则 → clamp01(volume) × 1。
   * 这里不写 `volume * (muted ? 0 : 1)` 的第二份实现，避免两处逻辑漂移。
   */
  function effectiveGain() {
    return channelGain({ volume, muted }, 1);
  }

  /** 实时改 master.gain —— 拖动滑杆时走这里，不重建节点、不排队 ramp。 */
  function applyMasterGain() {
    if (!master) return;
    try {
      master.gain.value = effectiveGain();
    } catch {
      /* 节点已被 close 的环境差异，忽略 */
    }
  }

  function ensure() {
    // 静音或音量为 0 时不建 AudioContext：省电，也避免"滑杆拖到 0 还在跑振荡器"。
    if (muted || volume <= 0) return null;
    if (ctx) return ctx;
    const C = Ctor();
    if (!C) return null;
    try {
      ctx = new C({ latencyHint: 'interactive' });
      master = ctx.createGain();
      applyMasterGain();
      master.connect(ctx.destination);
    } catch {
      try {
        ctx?.close?.();
      } catch {
        /* ignore */
      }
      ctx = null;
      master = null;
    }
    return ctx;
  }

  function tone(spec, at, detune = 0) {
    const c = ensure();
    if (!c || !master) return;
    const t0 = c.currentTime + at;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = spec.type || 'sine';
    osc.frequency.setValueAtTime(spec.freq + detune, t0);
    if (spec.slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, spec.slide + detune), t0 + spec.dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(spec.gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + spec.dur);
    // 接到总线上，而不是 destination：总音量只在这里乘一次（见文件头注释）。
    osc.connect(g).connect(master);
    osc.start(t0);
    osc.stop(t0 + spec.dur + 0.02);
  }

  return {
    get muted() {
      return muted;
    },
    /** 读当前音量（0..1，不含静音影响 —— 静音时仍保留玩家调好的值）。 */
    getVolume() {
      return volume;
    },
    /** 读当前实际总线增益（0..1，已把静音算进去）—— 供 UI/诊断确认"真的静音了"。 */
    getGain() {
      return effectiveGain();
    },
    /**
     * 设音量 0..1。
     * 非法值保持当前音量（而不是跳回默认）：滑杆拖到一半时任何一次脏事件
     * 都不该让音量"跳"一下。设完立刻改 master.gain，所以拖动是实时的。
     */
    setVolume(v) {
      volume = clampVolume(v, volume);
      applyMasterGain();
      return volume;
    },
    setMuted(v) {
      muted = !!v;
      if (muted) {
        // 先把总线拉到 0 再关 ctx：即使某些环境 close() 失败，静音也保证是 0。
        if (master) {
          try {
            master.gain.value = 0;
          } catch {
            /* ignore */
          }
        }
        if (ctx) {
          try {
            ctx.close();
          } catch {
            /* ignore */
          }
        }
        ctx = null;
        master = null;
      } else {
        // 解除静音不重建节点；等下一次 unlock/play 时 ensure() 按保留的 volume 建。
        applyMasterGain();
      }
    },
    /** 用户手势后调用；顺便把 ctx 从 suspended 拉回 running。 */
    unlock() {
      const c = ensure();
      if (c && c.state === 'suspended') c.resume().catch(() => {});
      return !!c;
    },
    play(name) {
      const spec = NOTES[name];
      if (!spec) return false;
      // 静音或音量为 0 时直接返回 false，连振荡器都不排期。
      if (muted || volume <= 0) return false;
      tone(spec, 0);
      (spec.chord || []).forEach((f, i) => tone({ ...spec, freq: f, slide: null, gain: spec.gain * 0.6 }, 0.03 * (i + 1)));
      return true;
    },
    dispose() {
      if (ctx) {
        try {
          ctx.close();
        } catch {
          /* ignore */
        }
        ctx = null;
        master = null;
      }
    },
  };
}

export const SFX_NAMES = Object.keys(NOTES);
