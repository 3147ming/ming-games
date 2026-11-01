/* =============================================================================
 * 赵云与阿斗 · 音效 (audio.js)
 * 纯 WebAudio 程序合成，零素材零请求；可静音（存 localStorage）
 * ========================================================================== */
(function (ZY) {
  'use strict';

  let ctx = null;
  let muted = false;
  let lastAt = {};

  function ensure() {
    if (muted) return null;
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC(); } catch (e) { return null; }
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  /** 单音：freq 频率、dur 时长、type 波形、gain 音量、slide 终止频率 */
  function tone(freq, dur, type, gain, slide) {
    const ac = ensure();
    if (!ac) return;
    const t0 = ac.currentTime;
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, slide), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain || 0.12, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(ac.destination);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  }

  /** 噪声（用于打击/受击的“沙”声）
   *  第四批 P0-3/P1-5：补淡入 + 淡出包络 —— 原实现只有恒定增益，
   *  缓冲到尾就硬切，听感上有一声「咔哒」；与 tone() 同风格做 12ms 淡入、dur 内线性归零。 */
  function noise(dur, gain, freq) {
    const ac = ensure();
    if (!ac) return;
    const t0 = ac.currentTime;
    const len = Math.floor(ac.sampleRate * dur);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ac.createBufferSource(); src.buffer = buf;
    const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq || 900;
    const g = ac.createGain();
    const lvl = gain || 0.06;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(lvl, t0 + Math.min(0.012, dur * 0.4));
    g.gain.linearRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp); bp.connect(g); g.connect(ac.destination);
    src.start(t0); src.stop(t0 + dur + 0.01);
  }

  /** 节流：同一音效在 ms 毫秒内只响一次 */
  function throttled(name, ms) {
    const now = Date.now();
    if (lastAt[name] && now - lastAt[name] < ms) return false;
    lastAt[name] = now;
    return true;
  }

  const SFX = {
    recruit: function () { tone(520, 0.10, 'triangle', 0.10, 780); },
    merge:   function () { tone(660, 0.10, 'triangle', 0.11, 990); setTimeout(function () { tone(990, 0.12, 'triangle', 0.09, 1320); }, 70); },
    hero:    function () { tone(392, 0.16, 'sawtooth', 0.10, 784); setTimeout(function () { tone(784, 0.22, 'triangle', 0.10, 1175); }, 120); },
    place:   function () { tone(300, 0.07, 'sine', 0.08, 220); },
    attack:  function () { if (throttled('atk', 110)) noise(0.05, 0.035, 1600); },
    /* 第四批 P1-5：受击更沉更闷（320Hz），与我方攻击的 1600Hz 脆响区分开 */
    hurt:    function () { if (throttled('hurt', 160)) noise(0.10, 0.06, 320); },
    /* 第四批 P0-3/P1-5：我方单位被砸 —— 闷噪声 + 短下滑低频，比 hurt 更有「重物砸下来」的分量 */
    hurtPlayer: function () {
      if (!throttled('hurtp', 160)) return;
      noise(0.09, 0.055, 360);
      tone(180, 0.08, 'sine', 0.04, 120);
    },
    /* 第四批 P0-3：击杀 = 两拍轻击 + 碎尾音，90ms 节流防连击刺耳 */
    kill:    function () {
      if (!throttled('kill', 90)) return;
      tone(360, 0.06, 'square', 0.06, 180);
      setTimeout(function () { tone(240, 0.09, 'square', 0.05, 140); noise(0.06, 0.03, 800); }, 60);
    },
    adou:    function () { tone(180, 0.28, 'sawtooth', 0.14, 90); noise(0.2, 0.05, 300); },
    skill:   function () { tone(880, 0.14, 'triangle', 0.10, 1320); setTimeout(function () { tone(660, 0.20, 'triangle', 0.09, 990); }, 90); },
    item:    function () { tone(740, 0.10, 'sine', 0.10, 980); },
    boom:    function () { noise(0.32, 0.10, 320); tone(120, 0.30, 'sawtooth', 0.12, 55); setTimeout(function () { noise(0.18, 0.05, 900); }, 60); },
    win:     function () { [523, 659, 784, 1046].forEach(function (f, i) { setTimeout(function () { tone(f, 0.22, 'triangle', 0.11); }, i * 130); }); },
    lose:    function () { [440, 370, 294, 220].forEach(function (f, i) { setTimeout(function () { tone(f, 0.28, 'sine', 0.11); }, i * 160); }); },
    tap:     function () { tone(600, 0.04, 'sine', 0.05); },
  };

  ZY.Audio = {
    play: function (name) { if (muted) return; const f = SFX[name]; if (f) { try { f(); } catch (e) { /* 忽略音频异常 */ } } },
    setMuted: function (v) { muted = !!v; },
    isMuted: function () { return muted; },
    unlock: function () { ensure(); },
  };
})(window.ZY);
