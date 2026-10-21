/**
 * 程序化音效（WebAudio API 合成，零外部音频文件）
 *
 * 全部音色由振荡器 + 噪声缓冲 + 滤波器 + 增益包络实时合成：
 * 枪声=噪声爆音+低频冲击，换弹=两声机械咔哒，命中=短促金属声，撤离成功=上行三音。
 */

/**
 * 创建音频控制器。首次用户交互后调用 ensure() 初始化 AudioContext。
 * @returns {object} 音频控制器
 */
export function createAudio() {
  let ctx = null;
  let master = null;
  let noiseBuffer = null;
  let volume = 0.6;
  let muted = false;
  let reverbSend = null; // 混响总线（send 端），不支持 ConvolverNode 时为 null
  let ambientWind = null; // 持续风声节点组
  let tension = null; // 战斗紧张层节点组

  /**
   * 程序化生成一段衰减噪声当作脉冲响应，用于室内 / 远场混响（零外部音频文件）。
   * @returns {object|null} send 增益节点
   */
  function buildReverb() {
    try {
      const dur = 1.6;
      const len = Math.floor(ctx.sampleRate * dur);
      const ir = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch += 1) {
        const d = ir.getChannelData(ch);
        for (let i = 0; i < len; i += 1) {
          d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2.6;
        }
      }
      const conv = ctx.createConvolver();
      conv.buffer = ir;
      const send = ctx.createGain();
      send.gain.value = 0.9;
      send.connect(conv);
      conv.connect(master);
      return send;
    } catch (e) {
      return null; // 某些环境没有 ConvolverNode，静默降级为无混响
    }
  }

  function ensure() {
    if (typeof window === 'undefined') return null; // Node 无头环境：直接降级，不碰 window
    if (!ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : volume;
      master.connect(ctx.destination);
      // 1 秒白噪声，重复使用
      const len = Math.floor(ctx.sampleRate);
      noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;
      reverbSend = buildReverb();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function ready() {
    if (!ctx) return false;
    if (ctx.state === 'suspended') ctx.resume();
    return true;
  }

  /**
   * 播放一段振荡器音调。
   * @param {object} o 参数 { type, freq, freq2, dur, gain, delay, attack }
   * @returns {void}
   */
  function tone(o) {
    if (!ready()) return;
    const t0 = ctx.currentTime + (o.delay || 0);
    const dur = o.dur || 0.15;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(Math.max(20, o.freq || 440), t0);
    if (o.freq2) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.freq2), t0 + dur);
    const peak = (o.gain == null ? 0.3 : o.gain);
    const attack = o.attack == null ? 0.005 : o.attack;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /**
   * 播放一段滤波噪声。
   * @param {object} o 参数 { dur, gain, type, freq, freq2, q, delay }
   * @returns {void}
   */
  function noise(o) {
    if (!ready()) return;
    const t0 = ctx.currentTime + (o.delay || 0);
    const dur = o.dur || 0.1;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = o.type || 'lowpass';
    filter.frequency.setValueAtTime(Math.max(40, o.freq || 1200), t0);
    if (o.freq2) filter.frequency.exponentialRampToValueAtTime(Math.max(40, o.freq2), t0 + dur);
    filter.Q.value = o.q == null ? 1 : o.q;
    const g = ctx.createGain();
    const peak = o.gain == null ? 0.3 : o.gain;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter);
    filter.connect(g);
    g.connect(master);
    // 可选混响支路：远处枪声之类需要空间感的音源才挂上去
    if (o.send && reverbSend) {
      const s = ctx.createGain();
      s.gain.value = o.send;
      g.connect(s);
      s.connect(reverbSend);
    }
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  const SHOT_PROFILE = {
    rifle: { dur: 0.16, freq: 2400, freq2: 500, body: 120, gain: 0.5 },
    smg: { dur: 0.11, freq: 2800, freq2: 700, body: 150, gain: 0.4 },
    pistol: { dur: 0.13, freq: 3000, freq2: 800, body: 165, gain: 0.42 },
    enemy_ar: { dur: 0.15, freq: 2000, freq2: 420, body: 105, gain: 0.4 },
    enemy_mdr: { dur: 0.17, freq: 1800, freq2: 380, body: 95, gain: 0.42 },
  };

  return {
    ensure,

    /**
     * 设置音量。
     * @param {number} v 0~1
     * @returns {void}
     */
    setVolume(v) {
      volume = Math.max(0, Math.min(1, v));
      if (master) master.gain.value = muted ? 0 : volume;
    },

    /** 获取当前音量 */
    getVolume() {
      return volume;
    },

    /**
     * 切换静音。
     * @returns {boolean} 静音状态
     */
    toggleMute() {
      muted = !muted;
      if (master) master.gain.value = muted ? 0 : volume;
      return muted;
    },

    /** 是否静音 */
    isMuted() {
      return muted;
    },

    /**
     * 枪声。
     * @param {string} weaponId 武器 id
     * @param {number} volScale 音量缩放（按距离衰减）
     * @returns {void}
     */
    shot(weaponId, volScale = 1) {
      const p = SHOT_PROFILE[weaponId] || SHOT_PROFILE.rifle;
      const v = Math.max(0, Math.min(1, volScale));
      noise({ dur: p.dur, freq: p.freq, freq2: p.freq2, gain: 0.5 * p.gain * v, type: 'lowpass' });
      noise({ dur: 0.05, freq: 5200, gain: 0.16 * p.gain * v, type: 'highpass' });
      tone({ type: 'sine', freq: p.body, freq2: p.body * 0.45, dur: 0.13, gain: 0.4 * p.gain * v });
    },

    /** 换弹开始：两声机械咔哒 */
    reload() {
      noise({ dur: 0.05, freq: 2600, gain: 0.2, type: 'bandpass', q: 3 });
      noise({ dur: 0.06, freq: 1800, gain: 0.22, type: 'bandpass', q: 4, delay: 0.16 });
    },

    /** 换弹完成：上膛 */
    reloadDone() {
      noise({ dur: 0.05, freq: 3200, gain: 0.24, type: 'bandpass', q: 5 });
      tone({ type: 'square', freq: 220, freq2: 140, dur: 0.06, gain: 0.1 });
    },

    /**
     * 空仓咔哒。
     * @param {number} volScale 音量
     * @returns {void}
     */
    empty(volScale = 1) {
      noise({ dur: 0.035, freq: 4200, gain: 0.3 * volScale, type: 'bandpass', q: 6 });
      tone({ type: 'square', freq: 900, freq2: 400, dur: 0.04, gain: 0.06 * volScale });
    },

    /** 命中反馈 */
    hit() {
      noise({ dur: 0.05, freq: 1500, freq2: 700, gain: 0.22, type: 'bandpass', q: 2 });
      tone({ type: 'triangle', freq: 320, freq2: 180, dur: 0.06, gain: 0.14 });
    },

    /** 玩家受伤 */
    hurt() {
      tone({ type: 'sawtooth', freq: 200, freq2: 90, dur: 0.25, gain: 0.22 });
      noise({ dur: 0.18, freq: 700, freq2: 200, gain: 0.2, type: 'lowpass' });
    },

    /** 击中墙面的碎屑声 */
    impact() {
      noise({ dur: 0.06, freq: 2600, freq2: 900, gain: 0.1, type: 'bandpass', q: 1.5 });
    },

    /** 子弹命中掩体箱的闷响（木箱被弹） */
    crateHit() {
      noise({ dur: 0.05, freq: 1900, freq2: 700, gain: 0.16, type: 'bandpass', q: 1.8 });
      tone({ type: 'triangle', freq: 260, freq2: 150, dur: 0.05, gain: 0.08 });
    },

    /** 掩体箱碎裂：低频爆裂 + 木质碎裂噪声（走一点混响更有空间感） */
    crateBreak() {
      noise({ dur: 0.18, freq: 1400, freq2: 240, gain: 0.22, type: 'lowpass' });
      noise({ dur: 0.1, freq: 3200, freq2: 900, gain: 0.1, type: 'highpass', send: 0.4 });
      tone({ type: 'sawtooth', freq: 160, freq2: 60, dur: 0.14, gain: 0.12 });
    },

    /** 上车：车门闷响 + 点火 */
    vehicleEnter() {
      noise({ dur: 0.16, freq: 500, freq2: 140, gain: 0.22, type: 'lowpass' });
      tone({ type: 'sawtooth', freq: 90, freq2: 160, dur: 0.22, gain: 0.1 });
    },

    /** 下车：熄火 + 关门 */
    vehicleExit() {
      noise({ dur: 0.14, freq: 420, freq2: 120, gain: 0.2, type: 'lowpass' });
      tone({ type: 'sawtooth', freq: 150, freq2: 60, dur: 0.2, gain: 0.09 });
    },

    /** 引擎：随车速变化的一次性轰鸣（0~1 的速度比） */
    engine(speedRatio = 0) {
      const f = 60 + speedRatio * 120;
      noise({ dur: 0.3, freq: 300 + speedRatio * 500, freq2: 200, gain: 0.05 + speedRatio * 0.06, type: 'lowpass' });
      tone({ type: 'sawtooth', freq: f, freq2: f * 1.15, dur: 0.3, gain: 0.03 + speedRatio * 0.04 });
    },

    /** 抛绳速降：绳索放出的摩擦声 + 一声下滑的呼啸 */
    rope() {
      noise({ dur: 0.5, freq: 900, freq2: 2600, gain: 0.1, type: 'bandpass', q: 1.2 });
      tone({ type: 'sine', freq: 420, freq2: 900, dur: 0.35, gain: 0.05 });
    },

    /** 速降落地：闷实的落地声 */
    ropeLand() {
      noise({ dur: 0.14, freq: 700, freq2: 120, gain: 0.26, type: 'lowpass', send: 0.25 });
      tone({ type: 'sine', freq: 110, freq2: 55, dur: 0.16, gain: 0.18 });
    },

    /** 开始搜索 */
    searchStart() {
      noise({ dur: 0.45, freq: 600, freq2: 1100, gain: 0.12, type: 'bandpass', q: 0.8 });
    },

    /** 搜索完成 */
    searchDone() {
      tone({ type: 'triangle', freq: 620, dur: 0.09, gain: 0.16 });
      tone({ type: 'triangle', freq: 820, dur: 0.12, gain: 0.16, delay: 0.08 });
    },

    /** 拾取物品 */
    pickup() {
      tone({ type: 'square', freq: 700, freq2: 1000, dur: 0.07, gain: 0.1 });
    },

    /** 开始撤离读条 */
    extractStart() {
      tone({ type: 'sawtooth', freq: 160, freq2: 420, dur: 0.6, gain: 0.12 });
    },

    /** 撤离成功 */
    extract() {
      const notes = [523, 659, 784, 1046];
      notes.forEach((f, i) => tone({ type: 'triangle', freq: f, dur: 0.28, gain: 0.18, delay: i * 0.11 }));
    },

    /** 阵亡 */
    death() {
      tone({ type: 'sawtooth', freq: 240, freq2: 60, dur: 0.9, gain: 0.24 });
      noise({ dur: 0.8, freq: 400, freq2: 90, gain: 0.16, type: 'lowpass', delay: 0.05 });
    },

    /** 使用医疗物资 */
    heal() {
      tone({ type: 'sine', freq: 440, freq2: 700, dur: 0.22, gain: 0.16 });
      tone({ type: 'sine', freq: 700, dur: 0.16, gain: 0.1, delay: 0.18 });
    },

    /**
     * 敌人发现玩家的提示音。
     * @param {number} distance 距离玩家距离
     * @returns {void}
     */
    enemyAlert(distance = 300) {
      const v = Math.max(0.15, 1 - distance / 800);
      tone({ type: 'square', freq: 880, dur: 0.07, gain: 0.1 * v });
      tone({ type: 'square', freq: 1180, dur: 0.09, gain: 0.1 * v, delay: 0.09 });
    },

    /**
     * UI 点击音。
     * @param {number} gain 音量
     * @returns {void}
     */
    ui(gain = 0.3) {
      tone({ type: 'square', freq: 660, freq2: 880, dur: 0.06, gain: 0.12 * gain });
    },

    /**
     * 脚步声（低频闷响 + 短噪声），音量按姿态：蹲行最轻、冲刺最响。
     * @param {number} volScale 0~1
     * @returns {void}
     */
    step(volScale = 1) {
      const v = Math.max(0, Math.min(1, volScale));
      noise({ dur: 0.07, freq: 900, freq2: 260, gain: 0.16 * v, type: 'lowpass' });
      tone({ type: 'sine', freq: 90, freq2: 55, dur: 0.06, gain: 0.08 * v });
    },

    /** 倒计时警告（撤离点即将关闭） */
    warn() {
      tone({ type: 'square', freq: 880, dur: 0.12, gain: 0.14 });
      tone({ type: 'square', freq: 660, dur: 0.16, gain: 0.14, delay: 0.16 });
    },

    /** 空投着陆：下行呼啸 + 落地闷响 */
    airdrop() {
      tone({ type: 'sine', freq: 1200, freq2: 260, dur: 0.55, gain: 0.14 });
      noise({ dur: 0.32, freq: 500, freq2: 120, gain: 0.2, type: 'lowpass', delay: 0.5 });
    },

    /** 错误提示音 */
    error() {
      tone({ type: 'square', freq: 300, freq2: 180, dur: 0.14, gain: 0.14 });
    },

    /** 购买 / 出售结算 */
    cash() {
      tone({ type: 'triangle', freq: 900, dur: 0.08, gain: 0.14 });
      tone({ type: 'triangle', freq: 1300, dur: 0.1, gain: 0.12, delay: 0.07 });
    },

    /* ================= 环境氛围（持续层） ================= */

    /**
     * 进场：启动风声底噪。
     * 持续 loop 噪声过低通，再叠一个极慢 LFO 让强弱起伏 —— 否则底噪听起来是"死"的。
     * @returns {void}
     */
    startAmbient() {
      if (!ensure() || ambientWind) return;
      try {
        const src = ctx.createBufferSource();
        src.buffer = noiseBuffer;
        src.loop = true;
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 420;
        const g = ctx.createGain();
        g.gain.value = 0.05;
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 0.08;
        const lfoGain = ctx.createGain();
        lfoGain.gain.value = 0.028;
        lfo.connect(lfoGain);
        lfoGain.connect(g.gain);
        src.connect(filter);
        filter.connect(g);
        g.connect(master);
        src.start();
        lfo.start();
        ambientWind = { src, filter, g, lfo, lfoGain };
      } catch (e) {
        ambientWind = null;
      }
    },

    /** 离场 / 回菜单：停掉风声与紧张层，避免常驻节点泄漏 */
    stopAmbient() {
      if (ambientWind) {
        try { ambientWind.src.stop(); ambientWind.lfo.stop(); } catch (e) { /* 已停止 */ }
        ambientWind = null;
      }
      if (tension) {
        try { tension.osc.stop(); } catch (e) { /* 已停止 */ }
        tension = null;
      }
    },

    /**
     * 战斗紧张层：交战中的敌人越多，低频 drone 越明显。
     * 懒创建 —— 没打起来（level<=0）时完全不建节点。
     * @param {number} v 0~1 强度
     * @returns {void}
     */
    setCombatIntensity(v) {
      if (!ready()) return;
      const level = Math.max(0, Math.min(1, v || 0));
      if (!tension) {
        if (level <= 0) return;
        try {
          const osc = ctx.createOscillator();
          osc.type = 'sawtooth';
          osc.frequency.value = 55;
          const filter = ctx.createBiquadFilter();
          filter.type = 'lowpass';
          filter.frequency.value = 180;
          const g = ctx.createGain();
          g.gain.value = 0;
          osc.connect(filter);
          filter.connect(g);
          g.connect(master);
          osc.start();
          tension = { osc, filter, g };
        } catch (e) {
          return;
        }
      }
      try {
        // setTargetAtTime 做平滑过渡，避免强度跳变时"咔"一声
        tension.g.gain.setTargetAtTime(level * 0.075, ctx.currentTime, 0.35);
        tension.filter.frequency.setTargetAtTime(150 + level * 220, ctx.currentTime, 0.35);
      } catch (e) { /* 忽略参数自动化失败 */ }
    },

    /** 远处传来的枪声：走混响支路、音量很低，营造"别处正在交火"的氛围 */
    distantShot() {
      if (!ready()) return;
      noise({ dur: 0.22, freq: 900, freq2: 180, gain: 0.05, type: 'lowpass', send: 0.6 });
      noise({ dur: 0.16, freq: 520, freq2: 140, gain: 0.028, type: 'lowpass', delay: 0.14, send: 0.5 });
    },
  };
}
