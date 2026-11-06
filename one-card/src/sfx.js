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

const MUTE_KEY = 'one-card:sfx:mute';

export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    try {
      this.muted = localStorage.getItem(MUTE_KEY) === '1';
    } catch {
      /* 隐私模式读不到 localStorage：按默认（开）处理 */
    }
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

  /** 首次用户手势里调用：建 AudioContext 并 resume（iOS 只在手势里允许出声）。 */
  unlock() {
    if (this._reduced || this.muted) return;
    const AC = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;
    if (!AC) return;
    try {
      if (!this.ctx) {
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.5; // 整体留一半余量：合成音很容易盖过一切
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    } catch {
      this.ctx = null;
    }
  }

  setMuted(v) {
    this.muted = !!v;
    try {
      localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0');
    } catch {
      /* 写不进去就算了，本次会话内仍然生效 */
    }
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
