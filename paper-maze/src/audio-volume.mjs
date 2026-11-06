/**
 * 主音量 —— 纯逻辑层（读档 / 校验 / 夹取 / 全游戏唯一的增益计算点）
 * ============================================================
 * 为什么单独拆一个文件，而不是把 volume 塞进 save.mjs 或 sfx.mjs：
 *   ① 这里全是纯函数，可以在 node 里直接断言。AudioContext 在无头环境里不存在，
 *      但"读档 / 类型纠错 / 越界夹取 / 静音乘 0"不需要声音就能测 —— 这类 bug
 *      （存档里一个字符串音量让整局没声）只有单测抓得住，浏览器里手点撞不上。
 *   ② 音量必须只有**一个**事实来源。sfx.mjs 只负责"把值变成增益"，
 *      UI 只负责"把值画出来"，两边都从这里取数，才不会出现滑杆显示 50%
 *      而实际增益还是 100% 的分裂。
 *
 * ★ 存储口径：音量用**独立键** `papermaze.volume.v1`，不跟静音混用。
 *   静音是游戏存档的一部分（papermaze.save.v1 → settings.muted），
 *   音量是设备偏好；两者生命周期不同：清空本局/重开时静音会被重置，
 *   但玩家调好的音量不该跟着丢。分开存也避免"写存档时顺手把音量覆盖成默认"。
 *
 * ★ 最关键的决策：静音优先，且只有一个计算点。
 *   如果 UI 层"静音时把滑杆值改成 0"、播放层再各自判断，就会变成两套逻辑：
 *   解除静音后音量回不来，或者"音量 50% + 静音"时增益算成 0.5 × 0 = 0 与
 *   "静音单独乘 0"两条路径打架。这里统一成 channelGain()：
 *       muted ? 0 : clamp01(volume) * base
 *   静音直接返回 0，而不是把音量改写成 0；音量值原样保留，解除静音即可恢复。
 */

/** 主音量独立存档键（带版本号：将来改结构时能识别老档，而不是当损坏丢掉）。 */
export const VOLUME_KEY = 'papermaze.volume.v1';
/** 存档结构版本。 */
export const VOLUME_VERSION = 1;
/** 默认音量 100%：升级到这一版时听感与改版前完全一致。 */
export const DEFAULT_VOLUME = 1;

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
 * - 负数 → 0，>1 → 1：手改存档、旧版本存了 0~100 的整数，都要能救回来。
 * - NaN / Infinity / null / undefined / 布尔 / 空串 / 对象 → fallback（默认音量或当前值）。
 * - 数字字符串 '0.25' → 0.25：range 的 value 天生是字符串，这里统一接住，
 *   免得 UI 层到处写 Number() 再判一次 NaN（漏一处就是"拖到一半突然炸回默认"）。
 */
export function clampVolume(v, fallback = DEFAULT_VOLUME) {
  const fb = Number.isFinite(fallback) ? Math.min(1, Math.max(0, fallback)) : DEFAULT_VOLUME;
  if (v === null || v === undefined || typeof v === 'boolean') return fb;
  if (typeof v === 'string' && v.trim() === '') return fb;
  // 对象/数组/函数一律视为类型不对。不能只靠 Number()：Number([]) === 0、
  // Number([0.5]) === 0.5，会把"存档里多了个数组"悄悄当成合法音量。
  if (typeof v === 'object' || typeof v === 'function') return fb;
  let n;
  try {
    n = typeof v === 'number' ? v : Number(v);
  } catch {
    // Symbol 之类 Number() 会直接抛错；存档里的东西不可信，按非法值处理。
    return fb;
  }
  if (!Number.isFinite(n)) return fb;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * JSON 文本 → 0..1 音量。
 * 解析失败、结构不认识、缺 volume 字段，一律回默认值，绝不 throw。
 * 存进去的永远是 `{"v":1,"volume":0.8}`；这里额外容忍裸数字/裸数字字符串，
 * 方便将来手工迁移或调试时直接塞一个值。
 */
export function parseVolume(text) {
  if (typeof text !== 'string' || text.trim() === '') return DEFAULT_VOLUME;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return DEFAULT_VOLUME;
  }
  if (typeof raw === 'number' || typeof raw === 'string') return clampVolume(raw, DEFAULT_VOLUME);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_VOLUME;
  if (!Object.prototype.hasOwnProperty.call(raw, 'volume')) return DEFAULT_VOLUME;
  return clampVolume(raw.volume, DEFAULT_VOLUME);
}

/** 0..1 → JSON 文本（先归一，保证存进去的东西永远合法）。 */
export function serializeVolume(volume) {
  return JSON.stringify({ v: VOLUME_VERSION, volume: clampVolume(volume) });
}

/**
 * 从存储读音量。
 * 读失败（隐私模式 / 配额 / 无存储）不是错误 —— 玩家只是这次听不到持久化，
 * 用默认音量继续玩，别让一次 getItem 抛错把整个游戏拦在启动页。
 */
export function loadVolume(store = defaultStore()) {
  let text = null;
  try {
    text = store && typeof store.getItem === 'function' ? store.getItem(VOLUME_KEY) : null;
  } catch {
    return DEFAULT_VOLUME;
  }
  if (text === null || text === undefined || text === '') return DEFAULT_VOLUME;
  return parseVolume(text);
}

/**
 * 写音量（独立键，绝不碰 papermaze.save.v1）。
 * 写失败只静默跳过：音频设置写不进去是小事，白屏是大事。
 * @returns {number} 实际写入（归一后）的值，调用方可直接拿去更新 UI。
 */
export function saveVolume(volume, store = defaultStore()) {
  const v = clampVolume(volume);
  try {
    if (store && typeof store.setItem === 'function') store.setItem(VOLUME_KEY, serializeVolume(v));
  } catch {
    /* 忽略：见函数注释 */
  }
  return v;
}

/**
 * ★ 全游戏唯一的增益计算点。
 * 公式：`muted ? 0 : clamp01(volume) * base`
 *
 * 静音必须覆盖音量，而不是"把音量写成 0"：
 *   - 玩家把音量调到 30% 后点静音，播放层必须立刻静音（不能只关一部分）；
 *   - 但 30% 这个偏好要保留，解除静音时原样恢复，玩家不用再拖一次滑杆。
 * 所以这里用 `muted ? 0` 短路，音量值保持不动。测试也锁死这条：
 *   channelGain({volume: 1, muted: true}) === 0。
 *
 * @param {{volume?: number, muted?: boolean}|null|undefined} settings
 * @param {number} [base=1] 该路的固定基准增益（音效每声自己的 spec.gain 不在这里乘）
 * @returns {number} 0..base
 */
export function channelGain(settings, base = 1) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const b = Number.isFinite(base) ? Math.max(0, base) : 1;
  // 静音是"总闸"：不看 volume，直接 0。避免 volume × 0 与别的分支产生不同结果。
  if (s.muted) return 0;
  return clampVolume(s.volume, DEFAULT_VOLUME) * b;
}

/** 0..1 → 0..100 的整数百分比（UI 显示 / 滑杆取值）。 */
export function toPercent(volume) {
  return Math.round(clampVolume(volume) * 100);
}

/** 0..100 → 0..1（range 的 value 是字符串，这里一并接住）。 */
export function fromPercent(percent) {
  const n = typeof percent === 'number' ? percent : Number(percent);
  if (!Number.isFinite(n)) return DEFAULT_VOLUME;
  return clampVolume(n / 100);
}
