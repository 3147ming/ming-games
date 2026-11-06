/**
 * 音频设置 —— 主音量 + 静音（纯逻辑层）
 * ============================================================
 * 为什么单独拆一个文件，而不是把读写塞进 sfx.js / main.js：
 *   ① 设置要能**无头单测**。AudioContext 在 Node 里不存在，但"读档 / 校验 / 夹取 / 静音乘 0"
 *      全是纯函数，可以在 node 里逐条断言 —— 这类 bug（存档里一个字符串音量让整局没声）
 *      只有单测抓得住，浏览器里手点是撞不上的。
 *   ② 音量必须只有**一个**事实来源。旧版把静音写在 sfx.js 里、BGM 音量写死在 main.js 里，
 *      于是"静音了但音效还在响"这种故障天然可能发生。现在两边都从同一份 settings 算增益。
 *
 * ★ 最关键的决策：BGM 与音效共用同一个总音量，且**只乘一次**。
 *   - 共用：玩家心里的"音量"是一个旋钮，不是两个。做成两套滑杆，玩家把 BGM 静音了却发现
 *     音效还在响，就会认定"静音失灵" —— 这是最招骂的那类缺陷。
 *   - 只乘一次：两路各有一套基准增益（SFX_BASE / BGM_BASE，用来保持改版前的听感配比）。
 *     如果总音量在音效总线与 BGM 引擎主总线上各乘一遍，实际就是 volume²：
 *     滑杆拉到 50% 只有 25% 响度，玩家会觉得"怎么调都很小声"，而且这种平方衰减
 *     在波形上完全正常，排查起来极难（sfx.js 里那条旧注释就是在讲这个坑）。
 *     所以：**总音量由 channelGain() 统一算，每路只在自己的最终增益点上乘一次。**
 *
 * 存档口径：
 *   - 新键 `wild.audio.v1`：JSON，形如 `{"v":1,"volume":0.8,"muted":false}`。
 *   - 旧键 `wild.muted`（'1'/'0'）：只在**新键不存在**时读一次做迁移，迁移后删掉旧键。
 *     老玩家刷新后不会突然被"重置成默认音量"。
 */

/** 新存档键（带版本号：将来改结构时能识别老档，而不是把老档当损坏丢掉）。 */
export const AUDIO_KEY = 'wild.audio.v1';
/** 旧版只存静音的键 —— 仅用于一次性迁移。 */
export const LEGACY_MUTE_KEY = 'wild.muted';
/** 存档结构版本。 */
export const AUDIO_VERSION = 1;

/** 默认音量 100%：刻意选满档，保证"升级到这一版"时听感与改版前完全一致（见下面的基准增益）。 */
export const DEFAULT_VOLUME = 1;
/** 默认不静音。 */
export const DEFAULT_MUTED = false;

/** 默认设置（冻结，避免调用方顺手改到全局默认值）。 */
export const DEFAULT_AUDIO_SETTINGS = Object.freeze({
  volume: DEFAULT_VOLUME,
  muted: DEFAULT_MUTED,
});

/**
 * 音效基准增益 = 0.5。
 * 改版前 sfx.js 的 _master.gain 就是 0.5；把它搬到这里当"这一路的固定配比"，
 * 总音量再乘上去 ⟹ 100% 时音效响度与旧版逐样本一致。
 */
export const SFX_BASE = 0.5;

/**
 * BGM 基准增益 = 0.275。
 * 改版前的实际 BGM 增益 = 旧音效总线 0.5 × 旧 BGM 主总线 0.55 = 0.275；
 * 现在 BGM 总线直连 destination（见 sfx.js），所以把这两档合成一个常数，
 * 保证 100% 时 BGM 与旧版一模一样，同时只受总音量一次控制。
 */
export const BGM_BASE = 0.275;

/** 内部：取默认存储；隐私模式 / Node 环境下访问 localStorage 本身都可能抛错。 */
function defaultStore() {
  try {
    return typeof globalThis !== 'undefined' ? globalThis.localStorage || null : null;
  } catch {
    return null;
  }
}

/**
 * 把任意输入夹到 [0,1]。
 * - 负数 → 0，>1 → 1（滑杆外的手改存档、旧版本存了 0~100 的整数，都要能救回来）
 * - NaN / Infinity / 'abc' / null / undefined / 布尔 / 空串 → fallback（默认音量或"当前值"）
 * - 数字字符串 '0.25' → 0.25：滑杆的 value 天生是字符串，这里统一接住，
 *   免得 UI 层到处写 Number() 再判一次 NaN（漏一处就是"拖到一半突然炸回默认"）。
 */
export function clampVolume(v, fallback = DEFAULT_VOLUME) {
  const fb = Number.isFinite(fallback) ? Math.min(1, Math.max(0, fallback)) : DEFAULT_VOLUME;
  if (v === null || v === undefined || typeof v === 'boolean') return fb;
  if (typeof v === 'string' && v.trim() === '') return fb;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fb;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** 静音字段的真值判定：只认明确的"开"，别的一律当"关"（损坏存档不该把玩家静音了）。 */
function asMuted(v) {
  return v === true || v === 1 || v === '1' || v === 'true';
}

/**
 * 把任意结构（JSON 解析结果 / 旧档 / 半个对象 / 垃圾）归一成 { volume, muted }。
 * 缺字段回落默认，多余字段直接忽略 —— 这样加字段、删字段都不会让老档变"损坏"。
 */
export function normalizeSettings(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const hasMuted = Object.prototype.hasOwnProperty.call(o, 'muted');
  return {
    volume: clampVolume(o.volume, DEFAULT_VOLUME),
    muted: hasMuted ? asMuted(o.muted) : DEFAULT_MUTED,
  };
}

/** JSON 文本 → 设置；解析失败一律回默认，绝不 throw（localStorage 里的东西不可信）。 */
export function parseAudioSettings(text) {
  if (typeof text !== 'string' || text.trim() === '') return { ...DEFAULT_AUDIO_SETTINGS };
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ...DEFAULT_AUDIO_SETTINGS };
  }
  return normalizeSettings(raw);
}

/** 设置 → JSON 文本（先归一，保证存进去的东西永远合法）。 */
export function serializeAudioSettings(settings) {
  const s = normalizeSettings(settings);
  return JSON.stringify({ v: AUDIO_VERSION, volume: s.volume, muted: s.muted });
}

/** 读旧键的静音偏好（只在没有新键时用来迁移）。 */
function readLegacyMuted(store) {
  try {
    const v = store && typeof store.getItem === 'function' ? store.getItem(LEGACY_MUTE_KEY) : null;
    return v === '1' || v === 'true';
  } catch {
    return false;
  }
}

/**
 * 从存储读设置。
 * 逻辑顺序很重要：
 *   有 wild.audio.v1（哪怕内容是坏的）→ 以它为准，坏档回默认；
 *   没有 wild.audio.v1 → 读旧键 wild.muted 做迁移。
 * 反过来（坏档也去读旧键）会让"用户清过档"的场景重新冒出静音，属于惊喜。
 */
export function loadAudioSettings(store = defaultStore()) {
  let text = null;
  try {
    text = store && typeof store.getItem === 'function' ? store.getItem(AUDIO_KEY) : null;
  } catch {
    text = null;
  }
  if (text === null || text === undefined) {
    return { ...DEFAULT_AUDIO_SETTINGS, muted: readLegacyMuted(store) };
  }
  return parseAudioSettings(text);
}

/**
 * 写设置。写失败（配额满 / 隐私模式 / 无存储）只静默跳过：
 * 音频设置写不进去是小事，让整个游戏因为一次 setItem 抛错而白屏是大事。
 * 同时删掉旧键：迁移完成后旧键必须消失，否则将来新键被清掉时旧静音值会"诈尸"。
 */
export function saveAudioSettings(settings, store = defaultStore()) {
  const s = normalizeSettings(settings);
  try {
    if (store && typeof store.setItem === 'function') {
      store.setItem(AUDIO_KEY, serializeAudioSettings(s));
      if (typeof store.removeItem === 'function') store.removeItem(LEGACY_MUTE_KEY);
    }
  } catch {
    /* 忽略：见函数注释 */
  }
  return s;
}

/**
 * ★ 全游戏唯一的音量计算点。
 * @param {object} settings { volume, muted }
 * @param {number} base 该路的固定基准增益（SFX_BASE / BGM_BASE）
 * @returns {number} 0..base
 *
 * 静音在这一行直接返回 0 —— 不是"慢慢淡出"，也不是"只关 BGM"。
 * 音效与 BGM 都必须从这里取增益，测试也断言这一行为：
 *   sfxGain({muted:true}) === 0 && bgmGain({muted:true}) === 0。
 */
export function channelGain(settings, base = 1) {
  const s = normalizeSettings(settings);
  const b = Number.isFinite(base) ? Math.max(0, base) : 1;
  if (s.muted) return 0;
  return s.volume * b;
}

/** 音效总线增益（sfx.js 的 _master 用）。 */
export function sfxGain(settings) {
  return channelGain(settings, SFX_BASE);
}

/** BGM 总线增益（bgm.js 引擎的 getVolume 用）。 */
export function bgmGain(settings) {
  return channelGain(settings, BGM_BASE);
}

/** 0..1 → 0..100 的整数百分比（UI 显示 / 滑杆取值）。 */
export function toPercent(volume) {
  return Math.round(clampVolume(volume) * 100);
}

/** 0..100 → 0..1（滑杆 input 的 value 天生是字符串，这里一并接住）。 */
export function fromPercent(percent) {
  const n = typeof percent === 'number' ? percent : Number(percent);
  if (!Number.isFinite(n)) return DEFAULT_VOLUME;
  return clampVolume(n / 100);
}

/**
 * 运行期设置对象（有状态，但**不碰音频设备**）。
 *
 * 分层原因：本文件只管"值该是多少、存到哪"；把值变成声音是 sfx.js / bgm.js 的事。
 * 这样单测不需要伪造 AudioContext，UI 也能订阅同一份状态（局内的静音键与标题页滑杆
 * 因此永远显示同一个值，不会各说各话）。
 *
 * @param {{store?: object, initial?: object}} [opts]
 */
export function createAudioSettings(opts = {}) {
  const { store, initial = null } = opts;
  const listeners = new Set();
  let current = initial ? normalizeSettings(initial) : loadAudioSettings(store);

  function emit() {
    for (const fn of listeners) {
      try {
        fn({ ...current });
      } catch {
        /* 单个订阅者出错不该影响其它订阅者（更不该让滑杆卡住） */
      }
    }
  }

  /**
   * 统一提交：值没变就当没发生（这条很重要 —— 局内静音键与设置面板会互相回调，
   * 没有这层幂等保护就会变成 A→B→A 的无限循环）。
   */
  function commit(next) {
    if (next.volume === current.volume && next.muted === current.muted) return { ...current };
    current = normalizeSettings(next);
    saveAudioSettings(current, store);
    emit();
    return { ...current };
  }

  return {
    /** 读当前设置（返回副本，防止调用方改到内部状态）。 */
    get() {
      return { ...current };
    },
    get volume() {
      return current.volume;
    },
    get muted() {
      return current.muted;
    },

    /**
     * 设音量。非法值保持当前音量（而不是跳回默认）——
     * 滑杆拖到一半时任何一次脏事件都不该让音量"跳"一下。
     */
    setVolume(v) {
      return commit({ volume: clampVolume(v, current.volume), muted: current.muted });
    },

    /** 设静音。这是持久化的唯一入口，arena 的静音键也要绕回这里（经 main.js 的钩子）。 */
    setMuted(m) {
      return commit({ volume: current.volume, muted: !!m });
    },

    toggleMuted() {
      return commit({ volume: current.volume, muted: !current.muted });
    },

    /** 订阅变化（返回退订函数）。UI 与播放层各订阅一次即可，不必互相知道对方存在。 */
    subscribe(fn) {
      if (typeof fn !== 'function') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** 从存储重新读（多标签页 / 手改 localStorage 后同步用；当前 UI 没用到，留给测试与探针）。 */
    reload() {
      current = loadAudioSettings(store);
      emit();
      return { ...current };
    },
  };
}
