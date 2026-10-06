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
 * BGM 是**程序化步进音序器**（不是一段循环音频）：
 *   · 4 小节和弦进行（Am–F–C–G），16 分音符步进，lookahead 调度保证不抖
 *   · 白天   → 轻快街机电子（原速、亮音区、标准音量）
 *   · 深夜   → 自动压低音量 + 叠一层低频嗡鸣（电力感 / 冷清感）
 *   · 停电   → 压得更低，只剩嗡鸣与零星音头
 *   · 高峰   → 节奏加快（bpm ×1.4）+ 加花踩镲
 * 状态由 main 每帧喂进来（本模块不读 state，保持解耦与可测）。
 */
import { settings, onSettingsChange } from './settings.mjs';

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
      bgmBus.gain.value = settings.bgm;
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
 *  BGM：程序化步进音序器
 * ========================================================== */

/** 和弦进行（4 小节循环）。bass 为低音 MIDI，tones 为琶音音级（MIDI）。 */
const PROGRESSION = [
  { bass: 45, tones: [57, 60, 64, 69] }, // Am
  { bass: 41, tones: [53, 57, 60, 65] }, // F
  { bass: 48, tones: [55, 60, 64, 67] }, // C
  { bass: 43, tones: [55, 59, 62, 67] }, // G
];

const BGM = {
  on: false,
  /** 下一颗 16 分音符的绝对时间（ctx.currentTime 坐标系） */
  nextAt: 0,
  /** 全局步进计数（用于和弦小节与加花） */
  step: 0,
  /** 目标/当前情绪参数（平滑过渡，避免切场景时"一顿"） */
  cur: { gain: 1, bpm: 112, bright: 1, hum: 0, hats: 1 },
  target: { gain: 1, bpm: 112, bright: 1, hum: 0, hats: 1 },
  /** 低频嗡鸣（深夜/停电的电力感） */
  hum: null,
};

/** 载入时把情绪参数**立即**贴到 target（避免开局第一帧从默认值滑过来） */
function bgmMood(mood = {}) {
  const night = mood.night === true;
  const blackout = mood.blackout === true;
  const rush = mood.rush === true;
  const t = {
    // 白天标准、深夜压低、停电更低；高峰略带提升
    gain: blackout ? 0.34 : night ? 0.52 : 0.95,
    bpm: rush ? 152 : night ? 96 : 112,
    // 亮音区：白天用原八度，深夜整体降八度更"闷"
    bright: night ? 0 : 1,
    hum: blackout ? 0.16 : night ? 0.085 : 0,
    hats: rush ? 1.7 : night ? 0.6 : 1,
  };
  if (rush) t.gain *= 1.15;
  // soft：暂停 / 小游戏进行中 —— 把 BGM 压一半，别盖住操作音效
  if (mood.soft) t.gain *= 0.5;
  BGM.target = t;
}

function ensureHum(c) {
  if (BGM.hum) return;
  const g = c.createGain();
  g.gain.value = 0.0001;
  g.connect(bgmBus);
  // 两个低八度叠加：55Hz 基频 + 110Hz 泛音，听感是"变压器/日光灯"的电流声
  for (const [f, amp] of [[55, 0.6], [110, 0.28]]) {
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.value = f;
    const og = c.createGain();
    og.gain.value = amp;
    o.connect(og);
    og.connect(g);
    o.start();
  }
  BGM.hum = g;
}

/** 排一颗 16 分音符上该响的东西 */
function scheduleStep(c, bar, step, at, m) {
  const stepInBar = step % 16;
  const chord = PROGRESSION[bar % PROGRESSION.length];
  const oct = m.bright >= 0.5 ? 0 : -12;

  // 低音：切分的根音（0/3/6/8/11/14）
  if ([0, 3, 6, 8, 11, 14].includes(stepInBar)) {
    tone(hz(chord.bass + oct), 0.16, { type: 'square', gain: 0.055, at: at - c.currentTime, bus: 'bgm', cutoff: 900 });
  }
  // 琶音：偶数步走和弦音，step 6/14 留白（给"呼吸"）
  if (stepInBar % 2 === 0 && stepInBar !== 6 && stepInBar !== 14) {
    const n = chord.tones[(stepInBar / 2) % chord.tones.length] + oct;
    tone(hz(n), 0.11, { type: 'triangle', gain: 0.042, at: at - c.currentTime, bus: 'bgm', cutoff: 3200 });
  }
  // 踩镲（高峰加倍）
  if (m.hats > 0.9 ? stepInBar % 2 === 1 : stepInBar % 4 === 2) {
    noise(0.028, { gain: 0.016 * m.hats, at: at - c.currentTime, hp: 5200, bus: 'bgm' });
  }
  // 底鼓：每小节 0 与 8
  if (stepInBar === 0 || stepInBar === 8) {
    tone(120, 0.13, { type: 'sine', gain: 0.075, at: at - c.currentTime, slide: 48, bus: 'bgm' });
  }
}

/**
 * 每帧推进 BGM。
 * @param dt 墙钟秒（未使用，仅为接口一致性；节奏以 ctx.currentTime 为准）
 * @param mood { night, blackout, rush }
 *
 * 为什么用 currentTime 而不是累加 dt：dt 受帧率抖动影响，
 * 用它推算音符时刻会让节奏随帧率漂移（低帧率下明显"赶拍"）。
 */
function updateBgm(dt, mood) {
  const c = ac();
  if (!c || !BGM.on) return;
  bgmMood(mood);
  ensureHum(c);

  // 情绪参数在 ~0.6s 内平滑逼近，避免昼夜切换/停电那一瞬"啪"地变速
  const k = Math.min(1, (dt || 0.016) / 0.6);
  const cur = BGM.cur;
  const tg = BGM.target;
  cur.gain += (tg.gain - cur.gain) * k;
  cur.bpm += (tg.bpm - cur.bpm) * k;
  cur.bright += (tg.bright - cur.bright) * k;
  cur.hum += (tg.hum - cur.hum) * k;
  cur.hats += (tg.hats - cur.hats) * k;
  rampTo(bgmBus.gain, settings.bgm * cur.gain, c.currentTime, 0.25);
  rampTo(BGM.hum.gain, cur.hum, c.currentTime, 0.35);

  const spb = 60 / Math.max(40, cur.bpm) / 4;  // 16 分音符时长
  const LOOKAHEAD = 0.22;
  if (BGM.nextAt < c.currentTime) BGM.nextAt = c.currentTime + 0.05;
  let guard = 0;
  while (BGM.nextAt < c.currentTime + LOOKAHEAD && guard++ < 32) {
    scheduleStep(c, Math.floor(BGM.step / 16), BGM.step, BGM.nextAt, cur);
    BGM.step += 1;
    BGM.nextAt += spb;
  }
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
  /** 开始播放背景音乐（首次用户手势后调用才有声） */
  startBgm() {
    const c = ac();
    if (!c) return;
    BGM.on = true;
    BGM.nextAt = c.currentTime + 0.1;
  },
  /** 停止 */
  stopBgm() {
    BGM.on = false;
    if (BGM.hum && ctx) rampTo(BGM.hum.gain, 0.0001, ctx.currentTime, 0.3);
  },
  /** 每帧推进；mood: { night, blackout, rush } */
  updateBgm,
  get bgmPlaying() { return BGM.on; },

  /* ---------- 诊断 / 设置 ---------- */
  setMuted(v) {
    muted = v === true;
    if (muted && ctx) {
      try { ctx.suspend(); } catch { /* 忽略 */ }
    } else if (ctx) {
      try { ctx.resume(); } catch { /* 忽略 */ }
    }
  },
  get muted() { return muted; },
  /** 手动把设置里的音量贴到总线上（settings 变化时已自动处理，这里只是兜底出口） */
  applyVolumes() {
    if (!ctx) return;
    rampTo(bgmBus.gain, settings.bgm, ctx.currentTime, 0.05);
    rampTo(sfxBus.gain, settings.sfx, ctx.currentTime, 0.05);
  },

  /**
   * 诊断出口（与 post.stats() 同一约定）：没声音时在控制台敲 `__NS.sfx.stats()`。
   * 为什么需要：AudioContext 只有在**首次用户手势**后才能真正发声，
   * 而"没建起来（ctx=null）"/"建起来了但 suspended"/"在跑但总线增益是 0"
   * 这三种故障在耳朵里听起来完全一样，必须能一眼区分。
   */
  stats() {
    return {
      ctx: !!ctx,
      state: ctx ? ctx.state : null,
      muted,
      master: master ? master.gain.value : null,
      bgmBus: bgmBus ? bgmBus.gain.value : null,
      sfxBus: sfxBus ? sfxBus.gain.value : null,
      bgmOn: BGM.on,
      step: BGM.step,
      hum: !!BGM.hum,
      rampErrors,
      lastRampError,
      target: { ...BGM.target },
      cur: { ...BGM.cur },
    };
  },
};

// 设置在设置页被拖动时立即生效：不需要重启，也不需要 main 转发
onSettingsChange((s, changed) => {
  if (!ctx) return;
  if (changed.includes('bgm')) rampTo(bgmBus.gain, s.bgm, ctx.currentTime, 0.08);
  if (changed.includes('sfx')) rampTo(sfxBus.gain, s.sfx, ctx.currentTime, 0.08);
});

export default sfx;
