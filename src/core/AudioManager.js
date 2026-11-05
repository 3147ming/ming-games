/**
 * 音频管理器（WebAudio）
 * 使用仓库原有 WAV 音效：开火、空仓、换弹、抛壳、脚步循环。
 * 通过 AudioBuffer 缓存实现低延迟、可叠加播放。
 */
const AUDIO_DIR = './public/assets/audio/';

const FILES = {
  fire1: 'fire_01.mp3',
  fire2: 'fire_02.mp3',
  fireEmpty: 'fire_empty.mp3',
  reload: 'reload.mp3',
  reloadEmpty: 'reload_empty.mp3',
  casing1: 'casing_1.mp3',
  casing2: 'casing_2.mp3',
  casing3: 'casing_3.mp3',
  casing4: 'casing_4.mp3',
  casing5: 'casing_5.mp3',
  walkLoop: 'walk_loop.mp3',
  runLoop: 'run_loop.mp3',
  hit: 'hit.mp3',
  land: 'land.mp3',
  hurt: 'hurt.mp3',
  kill: 'kill.mp3',
};

/**
 * 同名音效最小播放间隔（秒），避免连发时同一音效叠加产生爆音
 */
const MIN_INTERVAL = {
  hit: 0.04,
  kill: 0.10,
  hurt: 0.22,
  land: 0.12,
  fire1: 0.03,
  fire2: 0.03,
  fireEmpty: 0.08,
  reload: 0.15,
};

export class AudioManager {
  constructor() {
    this.ctx = null;
    this.buffers = {};
    this.enabled = true;
    this._lastPlay = {};   // 同名音效上次播放时间，防叠加爆音
  }

  /** 初始化音频上下文并解码全部音效 */
  async init() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      console.warn('[Audio] 当前浏览器不支持 WebAudio');
      return;
    }
    this.ctx = new Ctx();
    const entries = Object.entries(FILES);
    await Promise.all(
      entries.map(async ([name, file]) => {
        try {
          const res = await fetch(AUDIO_DIR + file);
          const buf = await res.arrayBuffer();
          this.buffers[name] = await this.ctx.decodeAudioData(buf);
        } catch (err) {
          console.warn('[Audio] 音效加载失败:', name, err);
        }
      })
    );
  }

  /** 用户手势后恢复音频上下文 */
  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  /**
   * 播放一次性音效
   * @param {string} name 音效名
   * @param {{volume?:number, rate?:number}} opts
   */
  play(name, opts = {}) {
    if (!this.ctx || !this.buffers[name] || !this.enabled) return;
    // 同名音效限流，避免高速连续射击/连续受击时叠爆
    const now = this.ctx.currentTime;
    const gap = MIN_INTERVAL[name] || 0;
    if (gap && this._lastPlay[name] !== undefined && now - this._lastPlay[name] < gap) return;
    this._lastPlay[name] = now;

    const { volume = 1, rate = 1 } = opts;
    const src = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    src.buffer = this.buffers[name];
    src.playbackRate.value = rate;
    gain.gain.value = volume;
    src.connect(gain).connect(this.ctx.destination);
    src.start();
  }

  /**
   * 创建持续循环音（脚步）
   * @returns {{setVolume:Function, setRate:Function, stop:Function}}
   */
  createLoop(name, volume = 0) {
    if (!this.ctx || !this.buffers[name]) {
      return { setVolume() {}, setRate() {}, stop() {} };
    }
    const src = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    src.buffer = this.buffers[name];
    src.loop = true;
    gain.gain.value = 0;
    src.connect(gain).connect(this.ctx.destination);
    src.start();

    let stopped = false;
    return {
      setVolume: (v) => {
        if (!stopped) gain.gain.value = Math.max(0, v);
      },
      setRate: (r) => {
        if (!stopped) src.playbackRate.value = r;
      },
      stop: () => {
        if (stopped) return;
        stopped = true;
        try { src.stop(); } catch (e) { /* 已停止 */ }
      },
    };
  }

  /** 按距离衰减的音量（敌人枪声用） */
  distanceVolume(distance, maxDistance = 46) {
    return Math.max(0, 1 - distance / maxDistance) * 0.55;
  }
}
