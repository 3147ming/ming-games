/**
 * 音频系统（WebAudio 程序化合成 · 零外部资源 · ADR-004 同精神）
 *
 * 为什么不引音频文件：
 *   · ADR-001 无构建步骤 —— 不想为几个提示音引入资源加载与解码链路
 *   · 单机离线可跑 —— 不依赖任何 CDN / 素材版权
 * 所有声音都是"几个振荡器 + 增益包络"，毫秒级合成，开销可忽略。
 *
 * 浏览器的自动播放策略要求 AudioContext 必须在**用户手势**后才能真正出声，
 * 因此这里用惰性创建：第一次调用（一定发生在点击/按键之后）才建 context，
 * 之后若处于 suspended 再尝试 resume。任何异常都吞掉 —— 没声音也不能影响玩法。
 *
 * 结构（两条独立总线，对应设置页的两个滑杆）：
 *   master ──┬── bgmBus  （背景音乐，默认音量低于音效）
 *            └── sfxBus  （操作反馈音效，必须听得清）
 * 音量取自 settings.mjs，并订阅其变化 —— 拖动滑杆立即生效，无需重启。
 *
 * BGM 自 2026-11-06（B 包）起由 **通用引擎 src/bgm.mjs** 负责（不再是这里的步进音序器）：
 *   · 五个情绪预设（menu / explore / tension / boss / settle）住在 bgm.mjs 的数据表里；
 *   · 本文件只做两件事：把**昼夜/停电/高峰/打烊**翻译成情绪（storeAudioScene），
 *     以及把引擎挂到自己的 bgmBus 上（音量/静音仍然走这里的 settings）。
 *   · 情绪切换是双合成层交叉淡入（≤0.6s）且**共享同一条走时基准** ⟹ 换情绪不断拍子。
 *   · 可选 mp3 插槽见 src/bgm-manifest.mjs（空对象 = 全走合成）。
 */
import { settings, onSettingsChange } from './settings.mjs';
import { createBgm, storeAudioScene } from './bgm.mjs';
import { BGM_MANIFEST } from './bgm-manifest.mjs';

/* ---------- 基础 ---------- */

let ctx = null;
let master = null;
let bgmBus = null;
let sfxBus = null;
let muted = false;

/** 十二平均律 → 频率 */
const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

function ac() {
  if (muted) return null;
  try {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { muted = true; return null; }
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(ctx.destination);
      bgmBus = ctx.createGain();
      // ★ 2026-11-06（B 包）：bgmBus 改成**纯直通**（增益恒 1）。
      //   音量不再在这里写，而是由 bgm 引擎自己的主总线承载（getVolume → settings.bgm）。
      //   两边都乘会变成平方衰减 —— 拖动滑杆"怎么调都很小声"，是最难查的那类故障。
      bgmBus.gain.value = 1;
      bgmBus.connect(master);
      sfxBus = ctx.createGain();
      sfxBus.gain.value = settings.sfx;
      sfxBus.connect(master);
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  } catch {
    muted = true;
    return null;
  }
}

/**
 * 平滑写入增益，绝不用 0（exponentialRamp 不接受 0）。
 *
 * 注意：这里**不能**把异常彻底吞掉。曾经踩到的真实故障 —— 音量滑杆拖了没反应，
 * 而根因是某次 exponentialRamp 抛了 RangeError（start/target 非有限值）被静默捕获，
 * 于是这个 AudioParam 永远停在初始值上，肉眼与"AudioContext 没建起来"完全无法区分。
 * 现在把失败次数记下来，挂到 stats().rampErrors 上，配合 `__NS.sfx.stats()` 一眼可查。
 */
let rampErrors = 0;
let lastRampError = '';
function rampTo(param, value, at, dur) {
  const v = Math.max(1e-4, value);
  try {
    param.cancelScheduledValues(at);
    param.setValueAtTime(Math.max(1e-4, param.value), at);
    param.exponentialRampToValueAtTime(v, at + dur);
  } catch (e) {
    rampErrors += 1;
    lastRampError = `ramp target=${value} at=${at} dur=${dur}: ${e?.name ?? ''} ${e?.message ?? e}`;
  }
}

/**
 * 一个音符。所有音效都建在它之上。
 * @param freq 频率
 * @param dur  时长（秒）
 * @param opts { type, gain, at（相对现在，秒）, slide（目标频率，做滑音）, bus }
 */
function tone(freq, dur, opts = {}) {
  const c = ac();
  if (!c) return;
  const { type = 'sine', gain = 0.18, at = 0, slide = 0, bus = 'sfx', cutoff = 0 } = opts;
  const t0 = c.currentTime + at;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(Math.max(20, freq), t0);
  if (slide > 0) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slide), t0 + dur);
  // 快起慢落，避免爆音（click）；起音 8ms 是"听不见咔哒但不钝"的经验值
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g);
  if (cutoff > 0) {
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    g.connect(f);
    f.connect(bus === 'bgm' ? bgmBus : sfxBus);
  } else {
    g.connect(bus === 'bgm' ? bgmBus : sfxBus);
  }
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

/** 一段短噪声（脚步的"沙"感 / 踩镲 / 纸屑声） */
function noise(dur, { gain = 0.12, at = 0, lp = 1400, hp = 0, bus = 'sfx' } = {}) {
  const c = ac();
  if (!c) return;
  const t0 = c.currentTime + at;
  const len = Math.max(1, Math.floor(c.sampleRate * dur));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    // 尾部衰减的噪声
    data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  }
  const src = c.createBufferSource();
  src.buffer = buf;
  let node = src;
  if (lp > 0) {
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = lp;
    node.connect(f);
    node = f;
  }
  if (hp > 0) {
    const f = c.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = hp;
    node.connect(f);
    node = f;
  }
  const g = c.createGain();
  g.gain.value = gain;
  node.connect(g);
  g.connect(bus === 'bgm' ? bgmBus : sfxBus);
  src.start(t0);
}

/* ============================================================
 *  BGM：通用引擎（src/bgm.mjs）+ 本游戏的昼夜/高峰映射
 * ------------------------------------------------------------
 *  这里**只保留接线**，曲风数据与调度器全部搬去 bgm.mjs。
 *  接线做三件事：
 *    ① 把引擎挂到自己的 bgmBus 上（音量/静音复用本文件的 settings/muted）；
 *    ② 用 storeAudioScene 把 { night, blackout, rush, soft, closing } 翻成情绪；
 *    ③ 把 start/stop/update 三个旧接口原样转发 —— main.mjs 一行都不用改。
 *
 *  为什么保留 updateBgm(dt, mood) 这个"每帧喂进来"的旧签名：
 *  main.mjs 每帧都在调它，而引擎自己带了 60ms 走时心跳，两者职责不重叠 ——
 *  帧循环只负责"现在该是什么情绪"，节奏由引擎按 ctx.currentTime 推进（不受帧率影响）。
 * ========================================================== */

/** 通用引擎实例。构造时不碰音频设备：后端拿的是 ctx/bgmBus 的**取值函数**，懒取。 */
const bgm = createBgm({
  getVolume: () => settings.bgm,
  isMuted: () => muted,
  manifest: BGM_MANIFEST,
  bus: { ctxRef: () => ctx, busRef: () => bgmBus },
});

/** 记录上一次真正下达的情绪，避免每帧重复下发（引擎内部也会挡，但这里挡掉更省）。 */
let lastScene = { mood: '', gain: 1 };

/**
 * 每帧推进 BGM。
 * @param dt 墙钟秒（引擎不依赖它，节奏一律以 ctx.currentTime 为准）
 * @param mood { night, blackout, rush, soft, closing }
 */
function updateBgm(dt, mood) {
  if (!ctx || !bgm.started) return;
  const scene = storeAudioScene(mood || {});
  if (scene.mood === lastScene.mood && Math.abs(scene.gain - lastScene.gain) < 0.01) return;
  lastScene = scene;
  bgm.setMood(scene.mood, { fade: 0.5, gain: scene.gain });
}

/* ============================================================
 *  对外接口
 * ========================================================== */

export const sfx = {
  /* ---------- 通用 ---------- */
  /** 交互成功：短促上扬两点 */
  ok() { tone(660, 0.07, { type: 'triangle', gain: 0.16 }); tone(990, 0.09, { type: 'triangle', gain: 0.14, at: 0.06 }); },
  /** 交互失败：低沉下坠 */
  bad() { tone(240, 0.14, { type: 'sawtooth', gain: 0.12, slide: 150 }); },
  /** 按键拟声（按下 E 的机械感） */
  key() { noise(0.03, { gain: 0.05, lp: 2600 }); tone(320, 0.03, { type: 'square', gain: 0.06 }); },
  /** UI 轻点（设置滑杆拖动 / 菜单切换） */
  tick() { tone(1200, 0.025, { type: 'square', gain: 0.045 }); },

  /* ---------- 存档 ---------- */
  save() { tone(520, 0.08, { type: 'sine', gain: 0.15 }); tone(780, 0.12, { type: 'sine', gain: 0.13, at: 0.07 }); },
  load() { tone(440, 0.07, { type: 'sine', gain: 0.13 }); tone(330, 0.07, { type: 'sine', gain: 0.12, at: 0.06 }); tone(660, 0.12, { type: 'sine', gain: 0.14, at: 0.12 }); },

  /* ---------- 金钱 ---------- */
  /** 金币入账：清脆"叮" */
  coin() { tone(880, 0.06, { type: 'triangle', gain: 0.14 }); tone(1320, 0.1, { type: 'triangle', gain: 0.12, at: 0.05 }); },
  /**
   * 投币：硬币落进机器 —— 两三声金属碰撞后落底。
   * 用高频 + 极短包络模拟金属，最后一声低一点表示"落到底槽"。
   */
  insertCoin() {
    noise(0.02, { gain: 0.06, hp: 3000 });
    tone(1980, 0.03, { type: 'square', gain: 0.05 });
    tone(1560, 0.03, { type: 'square', gain: 0.045, at: 0.05 });
    tone(760, 0.09, { type: 'triangle', gain: 0.06, at: 0.1, slide: 420 });
  },

  /* ---------- 设备 / 经营 ---------- */
  /** 机器故障：警报"嘀嘀"两声（不刺耳：三角波 + 低通） */
  alarm() {
    tone(760, 0.1, { type: 'triangle', gain: 0.13, cutoff: 2400 });
    tone(760, 0.1, { type: 'triangle', gain: 0.13, at: 0.16, cutoff: 2400 });
  },
  /**
   * 动作完成确认音（维修 / 上货 / 清洁）。
   * 三种用不同的音高与音程区分，玩家不用看提示也能靠听分辨发生了什么。
   */
  done(kind = 'repair') {
    if (kind === 'clean') { tone(620, 0.06, { type: 'sine', gain: 0.12 }); tone(930, 0.1, { type: 'sine', gain: 0.11, at: 0.05 }); }
    else if (kind === 'stock') { tone(520, 0.06, { type: 'triangle', gain: 0.13 }); tone(780, 0.1, { type: 'triangle', gain: 0.11, at: 0.05 }); }
    else { tone(440, 0.06, { type: 'square', gain: 0.1, cutoff: 1800 }); tone(660, 0.12, { type: 'square', gain: 0.09, at: 0.055, cutoff: 1800 }); }
  },
  /* ---------- 2026-10-06 块3：经营动作的音效补齐 ----------
   * 音量纪律：全部 ≤ 既有峰值（insertCoin 的 0.06 噪声 / coin 的 0.14 三角波），
   * 且**不连发高频** —— 手机端外放刺耳的高频重复音比没音效更劝退。
   * 每条新音效都控制在 3 个振荡器以内、总时长 ≤ 0.5s。 */

  /** 撕标签（清仓卖出配货）：短促的"嘶啦"噪声，带高频撕裂感 */
  tearTag() {
    noise(0.09, { gain: 0.055, hp: 2600, lp: 9000 });
    noise(0.05, { gain: 0.04, hp: 3400, at: 0.06 });
    tone(2200, 0.03, { type: 'square', gain: 0.028, at: 0.02 });
  },

  /** 促销开启：向上扬���的"叮咚"（两声上行，明亮但不刺耳） */
  promoStart() {
    tone(660, 0.08, { type: 'triangle', gain: 0.11 });
    tone(990, 0.12, { type: 'triangle', gain: 0.1, at: 0.07 });
    tone(1320, 0.1, { type: 'sine', gain: 0.07, at: 0.15 });
  },

  /** 促销结束：与开启反向的下行小三度（"到点了"的感觉） */
  promoEnd() {
    tone(880, 0.08, { type: 'triangle', gain: 0.09 });
    tone(660, 0.14, { type: 'triangle', gain: 0.08, at: 0.07 });
  },

  /** 节日礼盒到货：开箱式的三音（低-中-高，带一点混响感） */
  giftArrived() {
    tone(392, 0.12, { type: 'sine', gain: 0.1 });
    tone(523, 0.12, { type: 'sine', gain: 0.095, at: 0.09 });
    tone(784, 0.26, { type: 'sine', gain: 0.1, at: 0.18 });
    // 缎带/纸屑的高频点缀
    noise(0.14, { gain: 0.035, hp: 5200, at: 0.16 });
  },

  /**
   * 钱入账的累积音（打烊结算，参照 insertCoin 风格）。
   * n 越大音阶走得越高 —— 让"结算金额很大"在**听觉上**也可感知，
   * 而不只是看结算面板上的数字。
   * 步数封顶 8 声：再多就变长了，而结算音应该是"收尾"不是"演奏"。
   */
  cashIn(n = 1) {
    const steps = Math.max(1, Math.min(8, Math.round(n)));
    const scale = [523, 587, 659, 698, 784, 880, 988, 1046];
    for (let i = 0; i < steps; i++) {
      const f = scale[i];
      noise(0.012, { gain: 0.022, hp: 4200, at: i * 0.055 });
      tone(f, 0.07, { type: 'triangle', gain: 0.075, at: i * 0.055 });
    }
  },

  /** 售罄提示（顾客买走最后一格）：一声短促的"叮" + 下滑，语义是"没了" */
  soldOut() {
    tone(1046, 0.06, { type: 'sine', gain: 0.1 });
    tone(784, 0.12, { type: 'sine', gain: 0.085, at: 0.05, slide: 620 });
  },

  /** 顾客满意：轻"叮咚" */
  satisfied() { tone(1046, 0.09, { type: 'sine', gain: 0.1 }); tone(784, 0.14, { type: 'sine', gain: 0.085, at: 0.08 }); },
  /** 顾客不满：低沉"嘟" */
  upset() { tone(180, 0.16, { type: 'sawtooth', gain: 0.1, slide: 130, cutoff: 700 }); },

  /**
   * 脚步。两种地面：
   *   tile   —— 瓷砖：清脆些（高通噪声 + 短促低频）
   *   carpet —— 软地：闷一些（低通噪声，低频更弱）
   */
  footstep(surface = 'tile') {
    if (surface === 'tile') {
      noise(0.055, { gain: 0.075, lp: 2600 });
      tone(150 + Math.random() * 30, 0.04, { type: 'sine', gain: 0.05 });
    } else {
      noise(0.07, { gain: 0.055, lp: 900 });
    }
  },

  /* ---------- 小游戏 ---------- */
  /** 机械运转（抓娃娃机下降 / 收杆马达）：低频锯 + 抖动噪声 */
  mech(dur = 0.6) {
    tone(86, dur, { type: 'sawtooth', gain: 0.05, cutoff: 420 });
    noise(dur, { gain: 0.02, lp: 1100 });
  },
  /** 抓住的欢呼：上行三连 + 一点噪声"掌声" */
  cheer() {
    tone(660, 0.08, { type: 'triangle', gain: 0.12 });
    tone(880, 0.08, { type: 'triangle', gain: 0.12, at: 0.07 });
    tone(1320, 0.16, { type: 'triangle', gain: 0.12, at: 0.14 });
    noise(0.3, { gain: 0.035, hp: 1800, at: 0.1 });
  },
  /** 空抓泄气：下滑的钝音 */
  deflate() { tone(420, 0.3, { type: 'sawtooth', gain: 0.09, slide: 130, cutoff: 900 }); },
  /** 弹珠落槽"嗒"：极短、干脆 */
  clack() { noise(0.018, { gain: 0.06, hp: 2200 }); tone(1400, 0.03, { type: 'square', gain: 0.05 }); },
  /** 大奖 / JACKPOT：上行琶音 + 铃音 */
  jackpot() {
    [0, 4, 7, 12, 16].forEach((s, i) => {
      tone(hz(72 + s), 0.16, { type: 'triangle', gain: 0.11, at: i * 0.06 });
    });
    noise(0.5, { gain: 0.03, hp: 2400, at: 0.1 });
  },
  /** 进球网声：短噪声 + 高频"唰" */
  net() { noise(0.16, { gain: 0.07, hp: 1500, lp: 7000 }); tone(520, 0.06, { type: 'sine', gain: 0.06 }); },
  /** 水花：中频噪声扫 */
  splash() { noise(0.28, { gain: 0.075, lp: 2600 }); tone(300, 0.14, { type: 'sine', gain: 0.05, slide: 700 }); },
  /** 咬钩提示：清脆短音 + 双击 */
  bite() { tone(1180, 0.05, { type: 'square', gain: 0.09 }); tone(1180, 0.05, { type: 'square', gain: 0.09, at: 0.09 }); },
  /** 新纪录：明亮的号角式上行 */
  record() {
    [64, 69, 71, 76].forEach((m, i) => {
      tone(hz(m), i === 3 ? 0.34 : 0.1, { type: 'triangle', gain: 0.12, at: i * 0.1 });
    });
  },

  /* ---------- BGM 控制 ---------- */
  /**
   * 开始播放背景音乐（首次用户手势后调用才有声）。
   * 起点是 **menu 情绪**（标题/开始面板），进入营业后由 updateBgm 切到 explore。
   */
  startBgm(mood = 'menu') {
    const c = ac();
    if (!c) return;
    lastScene = { mood: '', gain: 1 };   // 强制下一帧重新下发情绪
    bgm.start(mood);
  },
  /** 停止 */
  stopBgm() {
    lastScene = { mood: '', gain: 1 };
    bgm.stop();
  },
  /** 每帧推进；mood: { night, blackout, rush, soft, closing } */
  updateBgm,
  get bgmPlaying() { return bgm.playing; },

  /* ---------- 诊断 / 设置 ---------- */
  setMuted(v) {
    muted = v === true;
    if (muted && ctx) {
      // ★ 静音 = 真的把 BGM 停下来（引擎 panic 掉所有振荡器），不是把音量拧到 0。
      bgm.suspend();
      try { ctx.suspend(); } catch { /* 忽略 */ }
    } else if (ctx) {
      try { ctx.resume(); } catch { /* 忽略 */ }
      bgm.resume();
    }
  },
  get muted() { return muted; },
  /** 手动把设置里的音量贴到总线上（settings 变化时已自动处理，这里只是兜底出口） */
  applyVolumes() {
    if (!ctx) return;
    // bgmBus 恒为 1（直通）；BGM 音量由引擎主总线承载
    rampTo(sfxBus.gain, settings.sfx, ctx.currentTime, 0.05);
    bgm.refreshVolume();
  },

  /**
   * 诊断出口（与 post.stats() 同一约定）：没声音时在控制台敲 `__NS.sfx.stats()`。
   * 为什么需要：AudioContext 只有在**首次用户手势**后才能真正发声，
   * 而"没建起来（ctx=null）"/"建起来了但 suspended"/"在跑但总线增益是 0"
   * 这三种故障在耳朵里听起来完全一样，必须能一眼区分。
   */
  stats() {
    const b = bgm.stats();
    return {
      ctx: !!ctx,
      state: ctx ? ctx.state : null,
      muted,
      master: master ? master.gain.value : null,
      bgmBus: bgmBus ? bgmBus.gain.value : null,
      sfxBus: sfxBus ? sfxBus.gain.value : null,
      bgmOn: b.started,
      step: b.step,
      hum: false,   // 旧字段（低频嗡鸣）—— 现在由引擎的 tension/boss 预设自带 hum 声部
      rampErrors,
      lastRampError,
      // ★ B 包：引擎的完整诊断（情绪 / 双合成层 / mp3 槽位状态）一并透出
      bgm: b,
    };
  },
};

// 设置在设置页被拖动时立即生效：不需要重启，也不需要 main 转发
onSettingsChange((s, changed) => {
  if (!ctx) return;
  // BGM 音量由引擎主总线承载 ⟹ 通知引擎重新取一次 settings.bgm（bgmBus 恒为直通 1）
  if (changed.includes('bgm')) bgm.refreshVolume();
  if (changed.includes('sfx')) rampTo(sfxBus.gain, s.sfx, ctx.currentTime, 0.08);
});

export default sfx;
