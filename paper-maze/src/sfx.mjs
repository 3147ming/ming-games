// 《纸上迷城》— 程序化音效（Web Audio，零素材）
// 规则：浏览器要求用户手势后才能出声，因此 unlock() 必须由真实手势触发。
// 没有 AudioContext 的环境（node / 老浏览器）自动降级为静音，不抛异常。

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
  let muted = !!opts.muted;
  const Ctor = () => globalThis.AudioContext || globalThis.webkitAudioContext || null;

  function ensure() {
    if (muted) return null;
    if (ctx) return ctx;
    const C = Ctor();
    if (!C) return null;
    try {
      ctx = new C({ latencyHint: 'interactive' });
    } catch {
      ctx = null;
    }
    return ctx;
  }

  function tone(spec, at, detune = 0) {
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime + at;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = spec.type || 'sine';
    osc.frequency.setValueAtTime(spec.freq + detune, t0);
    if (spec.slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, spec.slide + detune), t0 + spec.dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(spec.gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + spec.dur);
    osc.connect(g).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + spec.dur + 0.02);
  }

  return {
    get muted() {
      return muted;
    },
    setMuted(v) {
      muted = !!v;
      if (muted && ctx) {
        try {
          ctx.close();
        } catch {
          /* ignore */
        }
        ctx = null;
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
      if (muted) return false;
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
      }
    },
  };
}

export const SFX_NAMES = Object.keys(NOTES);
