// 阶段 3 音效：WebAudio 程序化合成，零音频素材。
//
// 设计要点（都为了让它"即插即用、不污染逻辑层"）：
//   · 纯合成 —— 振荡器 + 增益包络，不依赖任何 .mp3 / .wav。
//   · 懒初始化 —— AudioContext 必须在用户手势后才能出声，所以第一次 resume() 由
//     main.js 的「进入荒野」点击 / arena 的输入手势触发；构造时不碰音频设备。
//   · 音量/静音 —— 值本身由 src/audio-settings.js 管（含存档与校验），这里只负责
//     "把值变成增益"。★ 设置值只乘一次：本文件的 _master 就是音效总线的**最终**增益，
//     BGM 不走这条总线（见 _ensure 里 bgmBus 的接法），否则总音量会被乘两遍 = volume²。
//   · 节流 —— 射击/命中/受伤这类高频事件内部自带最小间隔，避免一帧几十声叠成爆音。
//   · 不参与任何玩法判定，不在 ArenaCore 里（保持 core 能无头测试）。
//     触发全部发生在 Arena 包装层，它每帧比对 core 的状态增量来"听声辨事"。

import { clampVolume, channelGain, SFX_BASE } from './audio-settings.js';

// 高频事件的节流间隔（秒）：低于它则丢弃，避免同帧叠音。
const THROTTLE = { shoot: 0.07, hit: 0.06, hurt: 0.18, death: 0.12 };

export const Sfx = {
  _ctx: null,
  _master: null,
  _bgmBus: null,    // B 包：BGM 引擎的输出总线（直连 destination，增益恒 1 直通）
  _muted: false,
  _volume: 1,       // 总音量 0..1（不含 SFX_BASE 基准；最终增益见 _applyMasterGain）
  _last: {},        // 各高频声的最后播放时刻（性能时钟，秒）
  _ready: false,
  /** B 包：静音状态变化的通知钩子（由 main.js 挂上，用来 suspend/resume BGM 引擎 + 写存档）。 */
  onMuteChange: null,

  /** 读静音偏好（同步，模块加载即可用）。 */
  isMuted() { return this._muted; },

  /** 读总音量（0..1）。 */
  getVolume() { return this._volume; },

  /** B 包：给 BGM 引擎取上下文与输出总线（都可能是 null —— 还没在用户手势里解锁）。 */
  audioCtx() { return this._ctx; },
  bgmBus() { return this._bgmBus; },

  /**
   * 把"当前静音 × 当前音量"算成音效总线的实际增益。
   * ★ 这里必须是**唯一**碰 _master.gain 的地方（_ensure 建节点时也走它），
   *   否则总会出现"某条路径忘了乘静音"的失灵。
   */
  _applyMasterGain() {
    if (!this._master) return;
    this._master.gain.value = channelGain({ volume: this._volume, muted: this._muted }, SFX_BASE);
  },

  /** 懒建 AudioContext + 主增益。必须在用户手势里调用（浏览器自动播放策略）。 */
  _ensure() {
    if (this._ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false; // 环境不支持音频 —— 静默降级，不报错
    try {
      this._ctx = new AC();
      // ── 音效总线：增益 = 总音量 × SFX_BASE，静音时由 channelGain 直接给 0 ──
      this._master = this._ctx.createGain();
      this._applyMasterGain();
      this._master.connect(this._ctx.destination);
      // ── BGM 专线 ──
      // ★ 它**直连 destination**，不挂到 _master 下面：BGM 引擎自己有主总线（getVolume 已经
      //   乘过总音量），如果再串进 _master 就会变成 volume × volume —— 滑杆拉到一半只剩
      //   25% 响度，听感上就是"怎么调都很小声"，而且波形完全正常、极难排查。
      //   代价是 BGM 不受 _master 增益影响，所以静音必须由 channelGain 给 BGM 乘 0，
      //   并且 main.js 的 onMuteChange 会 suspend() 引擎（真的停振荡器，省电）。
      this._bgmBus = this._ctx.createGain();
      this._bgmBus.gain.value = 1;
      this._bgmBus.connect(this._ctx.destination);
      this._ready = true;
    } catch { this._ctx = null; }
    return this._ready;
  },

  /** 用户手势里调用：建上下文（若还没建）并 resume（若被浏览器挂起）。 */
  resume() {
    if (!this._ensure()) return;
    if (this._ctx.state === 'suspended') this._ctx.resume().catch(() => {});
  },

  /**
   * 设置总音量（0..1）。滑杆拖动时每帧都会调到这里 —— 只改 GainNode 的 value，
   * 不重建节点、不排队 ramp，所以拖动是**实时**的，无延迟无爆音。
   */
  setVolume(v) {
    this._volume = clampVolume(v, this._volume);
    this._applyMasterGain();
    return this._volume;
  },

  /**
   * 切换静音；**不写 localStorage**（存档由 audio-settings.js 统一负责）。
   * 变化时通知 main.js：那里会写档、刷新设置面板，并 suspend/resume BGM 引擎。
   * 值没变则连钩子都不触发 —— 设置面板与局内静音键会互相回调，这里必须幂等。
   */
  setMuted(m) {
    const next = !!m;
    const changed = next !== this._muted;
    this._muted = next;
    this._applyMasterGain();
    if (changed) {
      try { if (typeof this.onMuteChange === 'function') this.onMuteChange(this._muted); } catch { /* 忽略 */ }
    }
    return this._muted;
  },

  /** 内部：发一个带 ADSR 包络的短音。type=波形，f0→f1 频率滑音，dur 秒，gain 峰值。 */

  _blip({ type = 'square', f0 = 440, f1 = f0, dur = 0.12, gain = 0.4, delay = 0 }) {
    if (!this._ready || this._muted || !this._ctx) return;
    const t0 = this._ctx.currentTime + delay;
    const osc = this._ctx.createOscillator();
    const g = this._ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    // 快起快落的小包络：起音 4ms，尾音指数衰减，避免"啪"的爆点
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(this._master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  },

  /** 内部：高频事件节流。key 归类，now 用 performance.now()/1000。 */
  _throttle(key) {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    const gap = THROTTLE[key];
    if (gap && this._last[key] !== undefined && now - this._last[key] < gap) return false;
    this._last[key] = now;
    return true;
  },

  // ── 七个事件音 ──
  shoot() { if (this._throttle('shoot')) this._blip({ type: 'square', f0: 720, f1: 480, dur: 0.07, gain: 0.16 }); },
  hit()   { if (this._throttle('hit'))   this._blip({ type: 'triangle', f0: 320, f1: 180, dur: 0.06, gain: 0.18 }); },
  hurt()  { if (this._throttle('hurt'))  this._blip({ type: 'sawtooth', f0: 200, f1: 90, dur: 0.18, gain: 0.32 }); },
  death() { if (this._throttle('death')) this._blip({ type: 'triangle', f0: 160, f1: 60, dur: 0.14, gain: 0.22 }); },
  levelUp() { // 上行三音，明确"升级了"
    this._blip({ type: 'square', f0: 523, dur: 0.1, gain: 0.3 });
    this._blip({ type: 'square', f0: 659, dur: 0.1, gain: 0.3, delay: 0.09 });
    this._blip({ type: 'square', f0: 784, dur: 0.14, gain: 0.3, delay: 0.18 });
  },
  // 阶段 8-2：`skill()`（放技能的锯齿波音效）已删除 —— 没有任何东西会调用它了。
  //   升级 / 击杀 / 掉落 / 受伤 / 开箱 / 超武进化等音效**全部保留**。
  chest() { // 开箱：明亮的两音叮咚
    this._blip({ type: 'triangle', f0: 880, dur: 0.1, gain: 0.3 });
    this._blip({ type: 'triangle', f0: 1175, dur: 0.16, gain: 0.3, delay: 0.1 });
  },
  evolve() { // 超武进化：更华丽的上行四音琶音，明确"质变"（区别于升级的三音）
    this._blip({ type: 'square', f0: 523, dur: 0.1, gain: 0.32 });
    this._blip({ type: 'square', f0: 659, dur: 0.1, gain: 0.32, delay: 0.1 });
    this._blip({ type: 'square', f0: 784, dur: 0.1, gain: 0.32, delay: 0.2 });
    this._blip({ type: 'square', f0: 1047, dur: 0.24, gain: 0.36, delay: 0.3 });
  },
  over() { // 倒下：下行长音
    this._blip({ type: 'sawtooth', f0: 300, f1: 70, dur: 0.6, gain: 0.34 });
  },
};

// ── 阶段11·P1-6：移动端触觉反馈（navigator.vibrate 封装）──
// 与音效同一哲学：即插即用、不污染逻辑层、不在 ArenaCore（core 保持无头可测）。
//   · 命中 15ms / 拾取宝石 10ms / 升级 [20,40,20]；平台不支持或被用户关闭时静默跳过。
//   · 两个独立开关：reducedMotion（系统减弱动效偏好）与 wild.haptics（用户触觉总开关，默认开）。
//     reducedMotion 或 关闭时一律不震动。
//   · 只在用户手势之后的局内触发（Sfx 的震动也只在 gameplay 里调用），iOS 无手势时不报错、静默无震。
const HAPTIC_KEY = 'wild.haptics';

export const Haptic = {
  _on: true,
  _reduced: false,
  _patterns: { hit: 15, pick: 10, level: [20, 40, 20] },

  /** 启动期读一次持久化的触觉偏好。 */
  load() {
    try {
      const v = localStorage.getItem(HAPTIC_KEY);
      this._on = v !== '0';
    } catch { /* 忽略 */ }
    return this._on;
  },

  /** 切换触觉总开关；写回 localStorage。返回切换后状态。 */
  setOn(v) {
    this._on = !!v;
    try { localStorage.setItem(HAPTIC_KEY, this._on ? '1' : '0'); } catch { /* 忽略 */ }
    return this._on;
  },

  /** 由 main.js 注入系统「减弱动效」偏好（prefers-reduced-motion）。 */
  setReduced(v) { this._reduced = !!v; },

  _fire(p) {
    if (!this._on || this._reduced) return;
    const nav = navigator.vibrate;
    if (typeof nav === 'function') { try { nav.call(navigator, p); } catch { /* 忽略 */ } }
  },

  /** 命中敌人（15ms 短震）。 */
  onHit() { this._fire(this._patterns.hit); },
  /** 拾取宝石（10ms 极短震，强调"到手了"）。 */
  onPick() { this._fire(this._patterns.pick); },
  /** 升级（[20,40,20] 三连震，明确"成长了"）。 */
  onLevel() { this._fire(this._patterns.level); },
};
