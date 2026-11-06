/**
 * 战斗音效（模块 11）—— WebAudio 实时合成，无外部音频文件。
 * ---------------------------------------------------------------------------
 * ⚠ spec：音效并发上限 16、走对象池复用、主音量 0.8、打击 0.6~0.7、环境 0.2~0.3。
 *   全部用振荡器 + 噪声 + 包络合成，零素材。M 键一键静音/恢复，状态记忆（localStorage）。
 *   浏览器自动播放策略：首次用户手势后才 resume AudioContext（play() 内部惰性初始化）。
 *
 * ★ 主音量（本版新增）：base 0.8 是固定基准，玩家滑杆只乘一次。
 *   实际增益 = computeGain(volume, muted) = muted ? 0 : volume × 0.8。
 *   这里**不再**任何地方手写 `muted ? 0 : AUDIO.MASTER` —— 全部走 _applyGain/getGain，
 *   否则"UI 显示 50% 但实际 80%"这种分叉迟早出现（旧版每个 setter 各写一遍就是这个隐患）。
 *
 * 合成清单（对应 spec 各条）：
 *   挥空 笔锋刮纸 / 轻击 墨点落纸「嗒」/ 重击 大笔横扫「唰」/ 无双 泼墨「哗——」/
 *   武艺1 火焰「呼」/ 武艺2 雷电噼啪 / 敌人受击闷响 / 死亡墨烟噗+纸碎 /
 *   环境风声+旗帜 / 据点铜锣 / 士气升战鼓 / 士气降低闷鼓 /
 *   Boss 出场战鼓+号角 / 狂暴鼓点加速升调 / 通关胜利鼓点。
 */
import { AUDIO } from '../core/config.js';
import {
  computeGain,
  clampVolume,
  defaultStore,
  loadMuted,
  loadVolume,
  saveMuted,
  saveVolume,
} from './volume.js';

export class AudioManager {
  /**
   * @param {{store?: object}} [opts] 可注入存储，单测用它验证"音量写独立键、静音写旧键"。
   *   不传时走 globalThis.localStorage（Node 里没有 → 所有读写安全地变成 no-op）。
   */
  constructor(opts = {}) {
    this.ctx = null;
    this.master = null;
    this.noiseBuf = null;
    this.active = 0;
    this.store = opts.store !== undefined ? opts.store : defaultStore();
    // 静音与音量是**两个独立偏好**：分别读各自的键，互不推断。
    this.muted = loadMuted(this.store);
    this.volume = loadVolume(this.store);
    // UI 订阅：M 键静音后，滑杆旁的按钮/百分比要立刻跟着变，不能各说各话。
    this._listeners = new Set();
  }

  _ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return true;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      // 唯一的增益赋值点：创建时就按"音量 × 静音"算，不写死 AUDIO.MASTER。
      this.master.gain.value = this.getGain();
      this.master.connect(this.ctx.destination);
      // 预生成 1s 白噪声
      const len = this.ctx.sampleRate;
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
      return true;
    } catch (err) {
      console.warn('[audio] 初始化失败：', err && err.message);
      return false;
    }
  }

  /**
   * 把当前设置写到 master.gain。
   * 直接赋 value 而不是做 ramp：滑杆 input 事件本身是连续的，ramp 反而会和下一次
   * 赋值打架（旧 ramp 没走完就被覆盖，听感是"拖了没反应"）。没初始化时静默跳过，
   * 下次 _ensure 会用同一公式补上。
   */
  _applyGain() {
    const gain = this.getGain();
    if (this.master) this.master.gain.value = gain;
    return gain;
  }

  /** 当前实际增益（0..AUDIO.MASTER）。探针/单测直接读它，避免去猜 master 内部状态。 */
  getGain() {
    return computeGain(this.volume, this.muted);
  }

  /** 当前主音量（0..1，不含静音）。 */
  getVolume() {
    return this.volume;
  }

  /**
   * 设主音量。非法值保持当前音量（而不是跳回默认）——
   * 滑杆拖到一半时任何一次脏事件都不该让音量"跳"一下。
   */
  setVolume(v) {
    const next = clampVolume(v, this.volume);
    if (next === this.volume) {
      this._applyGain();
      return this.volume;
    }
    this.volume = next;
    saveVolume(this.volume, this.store);
    this._applyGain();
    this._emit();
    return this.volume;
  }

  setMuted(m) {
    const next = !!m;
    if (next === this.muted) {
      this._applyGain();
      return this.muted;
    }
    this.muted = next;
    saveMuted(this.muted, this.store);
    this._applyGain();
    this._emit();
    return this.muted;
  }

  /** 订阅设置变化（返回退订函数）。UI 只靠它刷新，不反向写状态。 */
  subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit() {
    const snapshot = { volume: this.volume, muted: this.muted, gain: this.getGain() };
    for (const fn of this._listeners) {
      // 单个订阅者出错不该影响其它订阅者，更不该让滑杆卡住。
      try { fn(snapshot); } catch (_) { /* ignore */ }
    }
  }

  /** 首次用户手势后调用，解锁/恢复 AudioContext（浏览器自动播放策略） */
  resume() {
    this._ensure();
  }

  toggleMute() { this.setMuted(!this.muted); return this.muted; }

  get isMuted() { return this.muted; }

  _noise(dur, { type = 'bandpass', freq = 1200, q = 1, gain = 0.5, attack = 0.005, release = 0.1 } = {}) {
    if (!this._ensure() || this.active >= AUDIO.MAX_CONCURRENT) return;
    const c = this.ctx, t = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const filt = c.createBiquadFilter();
    filt.type = type; filt.frequency.value = freq; filt.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filt); filt.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + dur + 0.02);
    this._track(dur);
  }

  _tone(freq, dur, { type = 'sine', gain = 0.4, attack = 0.005, release = 0.1, slideTo = null, detune = 0 } = {}) {
    if (!this._ensure() || this.active >= AUDIO.MAX_CONCURRENT) return;
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (detune) o.detune.value = detune;
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
    this._track(dur);
  }

  _track(dur) {
    this.active++;
    setTimeout(() => { this.active = Math.max(0, this.active - 1); }, (dur + 0.05) * 1000);
  }

  drum(freq = 120, dur = 0.18, gain = 0.5) {
    // 简单膜鼓：低频正弦 + 快速衰减 + 一点噪声敲击
    this._tone(freq, dur, { type: 'sine', gain, slideTo: freq * 0.5 });
    this._noise(0.05, { type: 'lowpass', freq: 400, gain: gain * 0.4 });
  }

  play(name, opt = {}) {
    // 静音/音量 0 时直接不合成：增益乘 0 已经是无声了，再分配振荡器与噪声源只是白烧 CPU
    // （160 人混战时每秒几十次命中，静音状态下这笔开销本来完全没必要付）。
    if (this.muted || this.volume <= 0) return;
    switch (name) {
      case 'swing': // 笔锋刮纸
        this._noise(0.13, { type: 'bandpass', freq: 2600, q: 0.8, gain: 0.18 });
        break;
      case 'hitLight': { // 墨点落纸「嗒」
        const f = 800 + Math.random() * 400;
        this._tone(f, 0.08, { type: 'triangle', gain: 0.45 + Math.random() * 0.1 });
        break;
      }
      case 'hitHeavy': // 大笔横扫「唰」
        this._noise(0.2, { type: 'lowpass', freq: 900, q: 0.6, gain: 0.4 });
        this._tone(160, 0.2, { type: 'sawtooth', gain: 0.2, slideTo: 90 });
        break;
      case 'musou': // 泼墨「哗——」
        this._noise(1.1, { type: 'lowpass', freq: 1400, q: 0.5, gain: 0.5, attack: 0.05, release: 0.4 });
        this._tone(70, 1.1, { type: 'sine', gain: 0.3, slideTo: 50 });
        this._tone(110, 1.1, { type: 'triangle', gain: 0.15 });
        break;
      case 'art1': // 火焰「呼」
        this._noise(0.6, { type: 'lowpass', freq: 700, q: 0.4, gain: 0.4 });
        this._tone(180, 0.6, { type: 'sawtooth', gain: 0.18, slideTo: 120 });
        break;
      case 'art2': // 雷电噼啪
        for (let i = 0; i < 5; i++) {
          setTimeout(() => this._noise(0.06, { type: 'highpass', freq: 4000, q: 1, gain: 0.3 }), i * 55);
        }
        this._tone(1200, 0.3, { type: 'square', gain: 0.12, slideTo: 2400 });
        break;
      case 'enemyHit': // 闷响
        this._tone(200 + Math.random() * 200, 0.1, { type: 'sine', gain: 0.35 });
        break;
      case 'enemyDeath': // 墨烟噗 + 纸碎
        this._noise(0.3, { type: 'lowpass', freq: 600, q: 0.5, gain: 0.35 });
        this._noise(0.12, { type: 'highpass', freq: 3000, q: 1, gain: 0.12 });
        break;
      case 'point': // 铜锣「铛」
        this._tone(520, 0.8, { type: 'sine', gain: 0.4, detune: 4 });
        this._tone(780, 0.8, { type: 'sine', gain: 0.2, detune: -6 });
        this._tone(1180, 0.6, { type: 'sine', gain: 0.1 });
        break;
      case 'moraleUp': // 战鼓连击
        for (let i = 0; i < 3; i++) setTimeout(() => this.drum(140, 0.16, 0.5), i * 120);
        break;
      case 'moraleDown': // 低闷鼓
        this.drum(80, 0.3, 0.5);
        break;
      case 'bossEnter': // 战鼓 + 号角
        for (let i = 0; i < 4; i++) setTimeout(() => this.drum(120, 0.2, 0.5), i * 300);
        this._tone(220, 2.0, { type: 'sawtooth', gain: 0.2, slideTo: 330 });
        break;
      case 'bossBerserk': // 加速升调
        for (let i = 0; i < 5; i++) setTimeout(() => this.drum(150 + i * 20, 0.12, 0.5), i * 90);
        this._tone(330, 1.0, { type: 'square', gain: 0.12, slideTo: 520 });
        break;
      case 'victory': // 胜利鼓点收束
        [0, 200, 400, 700].forEach((ms, i) => setTimeout(() => this.drum(130 + i * 20, 0.22, 0.55), ms));
        break;
      case 'paper':
        this._noise(0.1, { type: 'highpass', freq: 5000, q: 1, gain: 0.08 });
        break;
      default:
        break;
    }
  }
}
