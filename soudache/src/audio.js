/**
 * 程序化音效（WebAudio API 合成，零外部音频文件）
 *
 * 全部音色由振荡器 + 噪声缓冲 + 滤波器 + 增益包络实时合成：
 * 枪声=噪声爆音+低频冲击，换弹=两声机械咔哒，命中=短促金属声，撤离成功=上行三音。
 */

/**
 * 采样音效清单（CC0，Kenney）。路径相对 assets/audio/。
 *
 * 只补"合成做不像"的两处：界面点击的实体感、不同材质的命中声。
 * 枪声**故意不用采样**：现有的五层合成（爆音 + 近场瞬态 + 低频冲击 + 枪机往复 + 混响尾）
 * 比 CC0 包里那几条小口径（.22 手枪/马格南、黑火药）更适合本作，换了反而更差。
 * 导出是为了让 p24 护栏能在 Node 里直接核对"每个文件都真的在磁盘上"。
 */
export const SAMPLE_FILES = {
  click: 'kenney-interface-sounds/click_001.ogg',
  select: 'kenney-interface-sounds/select_001.ogg',
  open: 'kenney-interface-sounds/open_001.ogg',
  close: 'kenney-interface-sounds/close_001.ogg',
  error: 'kenney-interface-sounds/error_001.ogg',
  impactMetal: 'kenney-impact-sounds/impactMetal_medium_000.ogg',
  impactPlate: 'kenney-impact-sounds/impactPlate_heavy_000.ogg',
  impactWood: 'kenney-impact-sounds/impactGeneric_light_000.ogg',
  impactGlass: 'kenney-impact-sounds/impactGlass_heavy_000.ogg',
};

/** 采样根目录（与 SAMPLE_FILES 的相对路径拼起来就是完整 URL） */
const SAMPLE_BASE = new URL('../assets/audio/', import.meta.url);

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
  let reverb = null; // P12 双 IR 湿声节点组（室外长尾 / 室内短尾）
  let interiorMix = -1; // 上次室内比例，用于 setInterior 节流，避免每帧写参数自动化
  let ambientWind = null; // 持续风声节点组
  let tension = null; // 战斗紧张层节点组

  /**
   * 程序化生成一条脉冲响应（零外部音频文件）。
   * 噪声由整数哈希推导，同种子结果一致；bright 越低高频越少，室内反射更闷。
   * @param {number} dur 秒
   * @param {number} decay 衰减指数
   * @param {number} bright 一阶低通系数 0~1
   * @param {number} seed 种子
   * @returns {AudioBuffer}
   */
  function makeIR(dur, decay, bright, seed) {
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch += 1) {
      const d = ir.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i += 1) {
        let h = Math.imul(i + seed + ch * 8191, 0x9e3779b1);
        h ^= h >>> 16;
        h = Math.imul(h, 0x7feb352d);
        h ^= h >>> 15;
        const white = ((h >>> 0) / 4294967296) * 2 - 1;
        lp += (white - lp) * bright;
        d[i] = lp * (1 - i / len) ** decay;
      }
    }
    return ir;
  }

  /**
   * 双路混响：室外 1.6s 长尾、室内 0.55s 短闷尾，共用一个 send 输入，
   * 由 setInterior() 交叉渐变两条湿声增益。任一节点不可用时整体降级为无混响。
   * @returns {object|null} { send, outdoorWet, indoorWet }
   */
  function buildReverb() {
    try {
      const send = ctx.createGain();
      send.gain.value = 0.9;
      const outdoor = ctx.createConvolver();
      outdoor.buffer = makeIR(1.6, 2.6, 0.85, 0x51a7);
      const indoor = ctx.createConvolver();
      indoor.buffer = makeIR(0.55, 3.6, 0.45, 0x7c31);
      const outdoorWet = ctx.createGain();
      outdoorWet.gain.value = 0.9;
      const indoorWet = ctx.createGain();
      indoorWet.gain.value = 0.2;
      send.connect(outdoor);
      outdoor.connect(outdoorWet);
      outdoorWet.connect(master);
      send.connect(indoor);
      indoor.connect(indoorWet);
      indoorWet.connect(master);
      return { send, outdoorWet, indoorWet };
    } catch {
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
      // P12 主总线：压缩器 + 软削波。多声源（枪声/爆炸/环境层）叠加时
      // 直接相加会削顶破音；这一层把峰值压住，同时保留瞬态冲击感。
      // 任一节点不可用时整条链静默降级为直连，不影响静音与音量设置。
      try {
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -12;
        comp.knee.value = 8;
        comp.ratio.value = 5;
        comp.attack.value = 0.003;
        comp.release.value = 0.16;
        const shaper = ctx.createWaveShaper();
        const curve = new Float32Array(2049);
        const k = Math.tanh(1.3);
        for (let i = 0; i < curve.length; i += 1) {
          const x = (i / 2048) * 2 - 1;
          curve[i] = Math.tanh(x * 1.3) / k;
        }
        shaper.curve = curve;
        try { shaper.oversample = '2x'; } catch (e) { /* 老实现不支持过采样 */ }
        const out = ctx.createGain();
        out.gain.value = 0.92;
        master.connect(comp);
        comp.connect(shaper);
        shaper.connect(out);
        out.connect(ctx.destination);
      } catch (e) {
        master.connect(ctx.destination);
      }
      // 1 秒白噪声，重复使用
      const len = Math.floor(ctx.sampleRate);
      noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;
      reverb = buildReverb();
      reverbSend = reverb ? reverb.send : null;
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
   * P12 空间化接线：pan ∈ [-1,1] 表示声源相对听者的左右方位，0 = 正前方。
   * 只给远处枪声这类环境声用；不支持 PannerNode 时静默回落为普通单声道。
   * @param {AudioNode} g 声源增益节点
   * @param {number} pan 方位
   * @returns {void}
   */
  function connectSpatial(g, pan) {
    if (!pan) { g.connect(master); return; }
    try {
      const p = ctx.createPanner();
      p.panningModel = 'equalpower';
      p.distanceModel = 'inverse';
      p.refDistance = 6;
      p.maxDistance = 80;
      p.rolloffFactor = 0.35;
      const x = Math.max(-1, Math.min(1, pan)) * 9;
      if (p.positionX) {
        p.positionX.value = x;
        p.positionY.value = 0;
        p.positionZ.value = -6;
      } else {
        p.setPosition(x, 0, -6);
      }
      g.connect(p);
      p.connect(master);
    } catch (e) {
      g.connect(master);
    }
  }

  /**
   * 播放一段滤波噪声。
   * @param {object} o 参数 { dur, gain, type, freq, freq2, q, delay, send, pan }
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
    connectSpatial(g, o.pan);
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
    rifle: { dur: 0.16, freq: 2400, freq2: 500, body: 120, gain: 0.5, mech: 0.11, tail: 0.19 },
    smg: { dur: 0.11, freq: 2800, freq2: 700, body: 150, gain: 0.4, mech: 0.09, tail: 0.14 },
    pistol: { dur: 0.13, freq: 3000, freq2: 800, body: 165, gain: 0.42, mech: 0.13, tail: 0.12 },
    enemy_ar: { dur: 0.15, freq: 2000, freq2: 420, body: 105, gain: 0.4, mech: 0, tail: 0.2 },
    enemy_mdr: { dur: 0.17, freq: 1800, freq2: 380, body: 95, gain: 0.42, mech: 0, tail: 0.22 },
  };

  /* ---------------- 采样音效（CC0，Kenney） ----------------
   * 程序化合成已经覆盖了"功能上必须有"的声音，采样只补合成做不像的两处：
   * 界面点击的实体感、以及不同材质的命中声（金属/玻璃/木板）。
   * 全部是"有就更好"：解码失败或还没加载完就退回原来的合成音，绝不静音或抛错。
   */
  /**
   * 命中材质 → 采样键。材质由调用方传入（`impact('metal')`），没传就按"硬表面"处理；
   * 采样没就绪时一律退回原来的合成噪声，所以这条映射永远不会让游戏变安静。
   */
  const IMPACT_SAMPLE = {
    wood: 'impactWood',
    metal: 'impactMetal',
    plate: 'impactPlate',
    glass: 'impactGlass',
  };
  const sampleBuf = new Map();
  const sampleReq = new Map();
  const sampleStat = { requested: 0, loaded: 0, failed: 0 };
  let preloadStarted = false;

  /**
   * 解码一条采样（同 key 只请求一次，失败也缓存，避免反复打网络）。
   * @param {string} key SAMPLE_FILES 的键
   * @returns {Promise<AudioBuffer|null>}
   */
  function loadSample(key) {
    if (sampleBuf.has(key)) return Promise.resolve(sampleBuf.get(key));
    if (sampleReq.has(key)) return sampleReq.get(key);
    const rel = SAMPLE_FILES[key];
    if (!rel || !ctx) return Promise.resolve(null);
    sampleStat.requested += 1;
    const p = fetch(new URL(rel, SAMPLE_BASE))
      .then((r) => { if (!r.ok) throw new Error('http ' + r.status); return r.arrayBuffer(); })
      .then((ab) => ctx.decodeAudioData(ab))
      .then((buf) => { sampleBuf.set(key, buf); sampleStat.loaded += 1; return buf; })
      .catch(() => { sampleStat.failed += 1; return null; });
    sampleReq.set(key, p);
    return p;
  }

  /**
   * 播一条采样。未加载/失败/静音时返回 false，调用方据此回退到合成音。
   * @param {string} key SAMPLE_FILES 的键
   * @param {{gain?:number, rate?:number}} [opts] 增益与播放速率
   * @returns {boolean} 是否真的播放了采样
   */
  function playSample(key, opts = {}) {
    const buf = sampleBuf.get(key);
    if (!buf || !ctx || !master || muted) return false;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = Math.max(0.5, Math.min(2, opts.rate || 1));
    const g = ctx.createGain();
    g.gain.value = Math.max(0, Math.min(4, opts.gain == null ? 1 : opts.gain));
    src.connect(g);
    g.connect(master);
    src.start();
    return true;
  }

  return {
    ensure,

    /** 界面点击：有采样用采样，没有就用原来的合成短音（保证任何时刻都有反馈） */
    click() {
      if (!playSample('click', { gain: 0.32, rate: 0.98 })) {
        tone({ type: 'square', freq: 520, dur: 0.045, gain: 0.1 });
      }
    },

    /** 预加载采样（首次交互后调用一次；失败静默） */
    preloadSamples() {
      if (preloadStarted || !ctx) return Promise.resolve();
      preloadStarted = true;
      return Promise.all(Object.keys(SAMPLE_FILES).map(loadSample));
    },

    /** 采样加载状态（探针/调试只读） */
    sampleStatus() {
      return { requested: sampleStat.requested, loaded: sampleStat.loaded, failed: sampleStat.failed, ready: [...sampleBuf.keys()] };
    },

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
      // 第一层：枪口爆音主体（低通噪声，随距离衰减最明显）
      noise({ dur: p.dur, freq: p.freq, freq2: p.freq2, gain: 0.5 * p.gain * v, type: 'lowpass' });
      // 第二层：近场"啪"——极短高通瞬态。没有它，枪声在耳机里像远处拍手。
      noise({ dur: 0.03, freq: 5600, gain: 0.2 * p.gain * v, type: 'highpass' });
      noise({ dur: 0.05, freq: 5200, gain: 0.12 * p.gain * v, type: 'highpass', delay: 0.012 });
      // 第三层：低频冲击（胸腔感）。敌人武器不给，避免远处每发都"捶胸"。
      tone({ type: 'sine', freq: p.body, freq2: p.body * 0.45, dur: 0.13, gain: 0.4 * p.gain * v });
      // 第四层：机件往复（仅玩家武器）——枪机后座再复位的一声闷金属，45~60ms 后到。
      // 这是"手上这把枪在动"的唯一听觉证据，敌人枪声不需要（听不见对方枪机）。
      if (p.mech > 0) {
        noise({
          dur: 0.045,
          freq: 1500,
          freq2: 900,
          gain: p.mech * v,
          type: 'bandpass',
          q: 2.6,
          delay: 0.05,
        });
      }
      // 第五层：空间尾音（走混响支路）。室内/楼间连射时残响把单发粘成一片，密度感来自这里。
      if (reverbSend) {
        noise({
          dur: 0.3,
          freq: 700,
          freq2: 220,
          gain: p.tail * p.gain * 0.35 * v,
          type: 'lowpass',
          send: 0.45,
        });
      }
    },

    /**
     * 换弹分段音效（P4-C3）。由 combat.updateWeapon 在跨段时调用，一段一响。
     * @param {string} key 'mag-out' | 'mag-in' | 'charge'
     * @param {number} total 本次换弹总秒数（用于把"拉机柄滑轨"拉长到与动画同长）
     * @returns {void}
     */
    reloadStage(key, total = 2) {
      const span = Math.max(0.6, Math.min(4, Number(total) || 2));
      if (key === 'mag-out') {
        // 弹匣释放钮：一声干脆的金属弹片 + 弹匣脱落的低频下坠
        noise({ dur: 0.04, freq: 2600, gain: 0.24, type: 'bandpass', q: 5 });
        tone({ type: 'triangle', freq: 180, freq2: 84, dur: 0.16, gain: 0.14, delay: 0.02 });
        noise({ dur: 0.1, freq: 900, freq2: 320, gain: 0.1, type: 'lowpass', delay: 0.06 });
        return;
      }
      if (key === 'mag-in') {
        // 弹匣插入：闷实一记 + 卡榫锁死的高频"嗒"
        noise({ dur: 0.07, freq: 780, freq2: 340, gain: 0.2, type: 'lowpass' });
        tone({ type: 'square', freq: 150, freq2: 96, dur: 0.07, gain: 0.1 });
        noise({ dur: 0.04, freq: 3400, gain: 0.16, type: 'bandpass', q: 7, delay: 0.07 });
        return;
      }
      if (key === 'charge') {
        // 拉机柄：滑轨摩擦（噪声扫频）→ 到位撞击。滑轨时长跟换弹总长成比例，
        // 长枪（3.4s）听起来就是更沉的一把，短枪（1.7s）干脆利落。
        const slide = Math.min(0.22, span * 0.07);
        noise({ dur: slide, freq: 900, freq2: 2400, gain: 0.13, type: 'bandpass', q: 1.4 });
        noise({ dur: 0.05, freq: 3000, gain: 0.2, type: 'bandpass', q: 6, delay: slide });
        tone({ type: 'triangle', freq: 260, freq2: 150, dur: 0.05, gain: 0.09, delay: slide });
        return;
      }
      // 未知段：按"弹匣落"保底，绝不静音（静音会被误当成音效系统坏了）
      noise({ dur: 0.05, freq: 2000, gain: 0.16, type: 'bandpass', q: 3 });
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

    /** 命中反馈（普通档，保留旧接口名，等价 hitConfirm('normal')） */
    hit() {
      noise({ dur: 0.05, freq: 1500, freq2: 700, gain: 0.22, type: 'bandpass', q: 2 });
      tone({ type: 'triangle', freq: 320, freq2: 180, dur: 0.06, gain: 0.14 });
    },

    /* ---------------- 近战（W2） ---------------- */

    /**
     * 近战挥击（W2）。
     *
     * 不给它枪声：刀是**静默**手段（不触发 emitNoise 的远场传播）。
     * 所以这里只有"布料破风"和刀刃擦过的金属味两层，音量压得比枪声低一档 ——
     * 玩家在交火里也能靠这一点点声音确认挥空了没有。
     * @param {boolean} [hit] 是否命中（命中补一记闷钝的入肉声）
     * @returns {void}
     */
    melee(hit = false) {
      // 破风：短促的高通噪声，从 2.6k 扫到 900，听起来像"咻"
      noise({ dur: 0.14, freq: 2600, freq2: 900, gain: 0.16, type: 'bandpass', q: 1.4 });
      // 刀身振鸣：极轻的高频金属，只有挥得动才听得到
      tone({ type: 'triangle', freq: 2400, freq2: 1500, dur: 0.08, gain: 0.035 });
      if (hit) {
        // 入肉：低频闷响 + 一点点布料的哑音，不喧哗
        tone({ type: 'sine', freq: 190, freq2: 70, dur: 0.11, gain: 0.2 });
        noise({ dur: 0.07, freq: 700, freq2: 260, gain: 0.14, type: 'lowpass' });
      }
    },

    /* ---------------- 投掷物（P5） ---------------- */

    /**
     * 出手：拔销的金属脆响 + 一记很轻的布料摩擦。
     * 刻意做得很轻 —— 它是"我已经扔出去了"的确认，不该盖住枪声。
     * @returns {void}
     */
    throwPin() {
      tone({ type: 'square', freq: 1600, freq2: 1050, dur: 0.045, gain: 0.055 });
      noise({ dur: 0.07, freq: 3800, freq2: 2000, gain: 0.09, type: 'highpass' });
    },

    /**
     * 落地闷响：距离越远越轻、越低。
     * @param {number} dist 距玩家（米）
     * @returns {void}
     */
    grenadeLand(dist = 0) {
      const v = Math.max(0, 1 - dist / 28);
      if (v <= 0.03) return;
      noise({ dur: 0.07, freq: 900, freq2: 320, gain: 0.1 * v });
      tone({ type: 'sine', freq: 130, freq2: 68, dur: 0.1, gain: 0.09 * v });
    },

    /**
     * 破片爆炸：低频冲击 + 高频碎片 + 长混响尾。
     * 三层分开是因为单层噪声听起来像"远处拍手"，没有"体内被推一下"的重量。
     * @param {number} dist 距玩家（米）
     * @returns {void}
     */
    explosion(dist = 0) {
      const v = Math.max(0, 1 - dist / 45);
      if (v <= 0.02) return;
      noise({ dur: 0.42, freq: 3200, freq2: 180, gain: 0.5 * v, send: 0.45 });
      noise({ dur: 0.85, freq: 640, freq2: 85, gain: 0.3 * v, send: 0.7 });
      tone({ type: 'sine', freq: 92, freq2: 30, dur: 0.5, gain: 0.46 * v });
      for (let i = 0; i < 3; i += 1) {
        noise({
          dur: 0.055, freq: 5200, freq2: 2400, gain: 0.06 * v,
          type: 'bandpass', q: 3, delay: 0.05 + i * 0.045,
        });
      }
    },

    /**
     * 烟幕起烟：一段"膨"的低频 + 持续的白噪嘶声。
     * @param {number} dist 距玩家（米）
     * @returns {void}
     */
    smokePop(dist = 0) {
      const v = Math.max(0, 1 - dist / 35);
      if (v <= 0.02) return;
      tone({ type: 'sine', freq: 160, freq2: 60, dur: 0.3, gain: 0.16 * v });
      noise({ dur: 0.5, freq: 2200, freq2: 900, gain: 0.09 * v, send: 0.3 });
    },

    /**
     * 震撼弹爆闪：极短的高频尖啸 + 一记闷响，模拟耳鸣。
     * @param {number} dist 距玩家（米）
     * @returns {void}
     */
    flashPop(dist = 0) {
      const v = Math.max(0, 1 - dist / 30);
      if (v <= 0.02) return;
      tone({ type: 'square', freq: 3200, freq2: 2600, dur: 0.09, gain: 0.1 * v });
      noise({ dur: 0.14, freq: 6000, freq2: 3000, gain: 0.16 * v, type: 'highpass' });
      tone({ type: 'sine', freq: 110, freq2: 60, dur: 0.16, gain: 0.14 * v });
      // 耳鸣：延时的一层持续高频，是最容易被认出来的"被闪了"
      tone({ type: 'sine', freq: 4200, dur: 0.7, gain: 0.035 * v, delay: 0.06, attack: 0.05 });
    },

    /**
     * 燃烧弹落地：一声"呼"的点燃 + 持续的细碎噼啪。
     * @param {number} dist 距玩家（米）
     * @returns {void}
     */
    combust(dist = 0) {
      const v = Math.max(0, 1 - dist / 35);
      if (v <= 0.02) return;
      noise({ dur: 0.5, freq: 1400, freq2: 420, gain: 0.18 * v, send: 0.25 });
      tone({ type: 'sine', freq: 120, freq2: 55, dur: 0.3, gain: 0.14 * v });
      for (let i = 0; i < 4; i += 1) {
        noise({
          dur: 0.04, freq: 4600, freq2: 2600, gain: 0.045 * v,
          type: 'bandpass', q: 6, delay: 0.12 + i * 0.09,
        });
      }
    },

    /**
     * 终结技释放：上行三音 + 低频铺底。是全局唯一的"权力时刻"提示音，
     * 所以刻意比击杀音更高更亮，避免和击杀反馈混淆。
     * @returns {void}
     */
    ultimate() {
      tone({ type: 'sine', freq: 70, freq2: 44, dur: 0.7, gain: 0.28 });
      tone({ type: 'triangle', freq: 330, dur: 0.16, gain: 0.14 });
      tone({ type: 'triangle', freq: 495, dur: 0.18, gain: 0.13, delay: 0.09 });
      tone({ type: 'triangle', freq: 660, dur: 0.3, gain: 0.12, delay: 0.18 });
      noise({ dur: 0.55, freq: 2600, freq2: 700, gain: 0.12, send: 0.6 });
    },

    /**
     * 首领进入新阶段（P16）：低频下潜 + 金属摩擦。
     *
     * 设计意图：玩家在枪声里要能"听出它变了"，所以低频压到 50Hz 附近，
     * 并用一段快速下滑的高通噪声做出液压/伺服机构的感觉。
     * @param {number} phase 新阶段号（2 / 3），越高越沉越急
     * @returns {void}
     */
    bossPhase(phase = 2) {
      const p3 = Number(phase) >= 3;
      tone({ type: 'sine', freq: p3 ? 58 : 72, freq2: p3 ? 30 : 40, dur: 0.95, gain: 0.32 });
      tone({ type: 'square', freq: p3 ? 118 : 148, dur: 0.22, gain: 0.08 });
      noise({ dur: 0.5, freq: p3 ? 3200 : 2400, freq2: 620, gain: 0.15, type: 'bandpass', q: 1.1 });
    },

    /**
     * 破甲（P16）：短促金属碎裂，必须与"打中护甲"的闷响区分开。
     * @returns {void}
     */
    armorBreak() {
      noise({ dur: 0.16, freq: 4200, freq2: 1300, gain: 0.24, type: 'highpass' });
      tone({ type: 'square', freq: 190, freq2: 88, dur: 0.2, gain: 0.16 });
    },

    /**
     * 分级命中确认音（P4-C3 / V-02）。与准星标记一一对应，让玩家不必盯着准星也知道打成了什么。
     * @param {string} kind 'normal' | 'armor' | 'blocked' | 'partial' | 'penetrated' | 'head' | 'kill'
     * @returns {void}
     */
    hitConfirm(kind) {
      if (kind === 'kill') {
        // 击杀：低频落底 + 双音上扬。音量明显高于其他档，是"这波值了"的正反馈。
        tone({ type: 'sine', freq: 150, freq2: 70, dur: 0.14, gain: 0.2 });
        tone({ type: 'triangle', freq: 620, dur: 0.09, gain: 0.16 });
        tone({ type: 'triangle', freq: 930, dur: 0.14, gain: 0.16, delay: 0.07 });
        noise({ dur: 0.09, freq: 1800, freq2: 600, gain: 0.14, type: 'bandpass', q: 1.6 });
        return;
      }
      if (kind === 'blocked') {
        // V-02 弹开：低频闷响 + 一记很短的金属挡片声。读作"打中了，但没进去"。
        tone({ type: 'square', freq: 190, freq2: 95, dur: 0.07, gain: 0.14 });
        noise({ dur: 0.035, freq: 2200, gain: 0.09, type: 'bandpass', q: 5 });
        return;
      }
      if (kind === 'penetrated') {
        // V-02 完全击穿：高频裂响 + 低频落底。读作"甲穿了，肉进去了"。
        noise({ dur: 0.05, freq: 5200, freq2: 2400, gain: 0.16, type: 'highpass' });
        tone({ type: 'triangle', freq: 540, freq2: 260, dur: 0.08, gain: 0.13 });
        return;
      }
      if (kind === 'partial') {
        // V-02 半穿：介于护甲与肉体之间，金属声更短、低频更轻。
        tone({ type: 'triangle', freq: 1450, freq2: 760, dur: 0.06, gain: 0.11 });
        noise({ dur: 0.04, freq: 2600, gain: 0.1, type: 'bandpass', q: 6 });
        tone({ type: 'triangle', freq: 300, freq2: 190, dur: 0.05, gain: 0.08, delay: 0.02 });
        return;
      }
      if (kind === 'armor') {
        // 护甲：金属铛 + 硬质短噪。刻意"钝"，提示"这人还有壳"。
        tone({ type: 'triangle', freq: 1250, freq2: 830, dur: 0.09, gain: 0.13 });
        noise({ dur: 0.045, freq: 3400, gain: 0.13, type: 'bandpass', q: 8 });
        return;
      }
      if (kind === 'head') {
        // 爆头：清脆高频两连（P7 部位系统接入后才会有 kind='head' 写入）
        tone({ type: 'square', freq: 1750, dur: 0.05, gain: 0.1 });
        tone({ type: 'square', freq: 2400, dur: 0.07, gain: 0.08, delay: 0.04 });
        return;
      }
      // normal：短促钝响（与 hit() 同一音色；此处内联而非 this.hit()，防止被解构调用时丢 this）
      noise({ dur: 0.05, freq: 1500, freq2: 700, gain: 0.22, type: 'bandpass', q: 2 });
      tone({ type: 'triangle', freq: 320, freq2: 180, dur: 0.06, gain: 0.14 });
    },

    /** 玩家受伤 */
    hurt() {
      tone({ type: 'sawtooth', freq: 200, freq2: 90, dur: 0.25, gain: 0.22 });
      noise({ dur: 0.18, freq: 700, freq2: 200, gain: 0.2, type: 'lowpass' });
    },

    /**
     * 击中硬表面的碎屑声。
     * @param {'plate'|'metal'|'wood'|'glass'} [surface] 命中材质（默认硬表面）
     * @returns {void}
     */
    impact(surface = 'plate') {
      const key = IMPACT_SAMPLE[surface];
      // 采样每次换一点点速率：同一发连射时不会听出"复读机"
      if (key && playSample(key, { gain: 0.4, rate: 0.94 + Math.random() * 0.14 })) return;
      noise({ dur: 0.06, freq: 2600, freq2: 900, gain: 0.1, type: 'bandpass', q: 1.5 });
    },

    /** 子弹命中掩体箱的闷响（木箱被弹） */
    crateHit() {
      if (playSample('impactWood', { gain: 0.5, rate: 0.95 + Math.random() * 0.12 })) return;
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

    /** 远处传来的枪声：走混响支路 + 3D 声像、音量很低，营造"别处正在交火"的氛围 */
    distantShot(pan = 0) {
      if (!ready()) return;
      noise({ dur: 0.22, freq: 900, freq2: 180, gain: 0.05, type: 'lowpass', send: 0.6, pan });
      noise({ dur: 0.16, freq: 520, freq2: 140, gain: 0.028, type: 'lowpass', delay: 0.14, send: 0.5, pan });
    },

    /**
     * P12：按室内比例交叉渐变两条混响湿声（0 = 开阔室外长尾，1 = 封闭室内短闷尾）。
     * 只做听感，不参与任何玩法判定；变化小于 0.04 时跳过，避免每帧写参数自动化。
     * @param {number} v 0~1
     * @returns {void}
     */
    setInterior(v) {
      const x = Math.max(0, Math.min(1, Number(v) || 0));
      if (!ready() || !reverb) return;
      if (Math.abs(x - interiorMix) < 0.04) return;
      interiorMix = x;
      try {
        const t = ctx.currentTime;
        reverb.outdoorWet.gain.setTargetAtTime(0.9 * (1 - x * 0.72), t, 0.25);
        reverb.indoorWet.gain.setTargetAtTime(0.2 + x * 0.72, t, 0.25);
      } catch (e) { /* 参数自动化失败时保持当前湿声比例 */ }
    },

    /** P11：低血量心跳（lub-dub 两下低频），与 HUD 1.3Hz 视觉脉动同源节奏。 */
    heartbeat() {
      if (!ready()) return;
      tone({ type: 'sine', freq: 78, freq2: 48, dur: 0.12, gain: 0.11 });
      tone({ type: 'sine', freq: 64, freq2: 40, dur: 0.16, gain: 0.085, delay: 0.17 });
    },

    /** P11：连杀上扬音，连击数越高音高越高；只对 >= 2 连击调用。 */
    streak(n) {
      if (!ready()) return;
      const count = Math.max(2, Math.min(8, Math.floor(Number(n) || 2)));
      const base = 520 + (count - 2) * 90;
      tone({ type: 'triangle', freq: base, dur: 0.08, gain: 0.1 });
      tone({ type: 'triangle', freq: base * 1.5, dur: 0.11, gain: 0.09, delay: 0.07 });
    },
  };
}
