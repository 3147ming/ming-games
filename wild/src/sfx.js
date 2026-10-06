// 阶段 3 音效：WebAudio 程序化合成，零音频素材。
//
// 设计要点（都为了让它"即插即用、不污染逻辑层"）：
//   · 纯合成 —— 振荡器 + 增益包络，不依赖任何 .mp3 / .wav。
//   · 懒初始化 —— AudioContext 必须在用户手势后才能出声，所以第一次 resume() 由
//     main.js 的「进入荒野」点击 / arena 的输入手势触发；构造时不碰音频设备。
//   · 静音持久化 —— 开关写 localStorage('wild.muted')，刷新后记得上次的选择。
//   · 节流 —— 射击/命中/受伤这类高频事件内部自带最小间隔，避免一帧几十声叠成爆音。
//   · 不参与任何玩法判定，不在 ArenaCore 里（保持 core 能无头测试）。
//     触发全部发生在 Arena 包装层，它每帧比对 core 的状态增量来"听声辨事"。

const MUTE_KEY = 'wild.muted';

// 高频事件的节流间隔（秒）：低于它则丢弃，避免同帧叠音。
const THROTTLE = { shoot: 0.07, hit: 0.06, hurt: 0.18, death: 0.12 };

export const Sfx = {
  _ctx: null,
  _master: null,
  _muted: false,
  _last: {},        // 各高频声的最后播放时刻（性能时钟，秒）
  _ready: false,

  /** 读静音偏好（同步，模块加载即可用）。 */
  isMuted() { return this._muted; },

  /** 懒建 AudioContext + 主增益。必须在用户手势里调用（浏览器自动播放策略）。 */
  _ensure() {
    if (this._ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false; // 环境不支持音频 —— 静默降级，不报错
    try {
      this._ctx = new AC();
      this._master = this._ctx.createGain();
      this._master.gain.value = this._muted ? 0 : 0.5;
      this._master.connect(this._ctx.destination);
      this._ready = true;
    } catch { this._ctx = null; }
    return this._ready;
  },

  /** 用户手势里调用：建上下文（若还没建）并 resume（若被浏览器挂起）。 */
  resume() {
    if (!this._ensure()) return;
    if (this._ctx.state === 'suspended') this._ctx.resume().catch(() => {});
  },

  /** 切换静音；写回 localStorage。返回切换后的状态。 */
  setMuted(m) {
    this._muted = !!m;
    try { localStorage.setItem(MUTE_KEY, this._muted ? '1' : '0'); } catch { /* 忽略 */ }
    if (this._master) this._master.gain.value = this._muted ? 0 : 0.5;
    return this._muted;
  },

  /** 启动期读一次持久化的静音偏好。 */
  loadMuted() {
    try {
      const v = localStorage.getItem(MUTE_KEY);
      this._muted = v === '1';
    } catch { /* 忽略 */ }
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
  skill() { this._blip({ type: 'sawtooth', f0: 380, f1: 760, dur: 0.16, gain: 0.26 }); },
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
