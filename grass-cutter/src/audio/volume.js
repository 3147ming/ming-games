/**
 * 主音量（纯逻辑层）—— 只负责"值该是多少、存到哪、增益怎么算"，不碰 AudioContext。
 * ---------------------------------------------------------------------------
 * 为什么从 sfx.js 里拆出来：
 *   ① AudioContext 在 Node 里不存在，但"读档 / 校验 / 夹取 / 静音乘 0"全是纯函数，
 *      可以在 node --test 里逐条断言。存档里一个坏字符串让整局没声，这类 bug
 *      只有单测抓得住，浏览器里手点是撞不上的。
 *   ② 音量必须只有**一个**事实来源。旧版 sfx.js 在每个 setMuted / _ensure 里各写一遍
 *      `muted ? 0 : AUDIO.MASTER`，静音与音量一旦分家，就会出现"拖了滑杆但增益没变"
 *      或者"静音了还有声"这种自相矛盾的状态。
 *
 * ★ 最关键的决策：实际增益只在一个函数里算（computeGain），且**只乘一次**。
 *   公式：gain = muted ? 0 : clamp(volume, 0, 1) × AUDIO.MASTER
 *   - 静音不是"把音量设成 0"：静音时滑杆位置必须原地保留，取消静音才能回到原响度。
 *   - 只乘一次：AUDIO.MASTER = 0.8 是这一路的固定基准（保证 100% 时听感与改版前一致）。
 *     如果 UI 层再乘一次、播放层又乘一次，实际就是 volume² —— 滑杆 50% 只有 25% 响度，
 *     波形完全正常，排查极难。所以总音量只在 master.gain 这一个最终增益点上乘。
 *
 * 存档口径：
 *   - 音量用**独立键** `musou-audio-volume`（JSON：`{"v":1,"volume":0.8}`），
 *     与旧的静音键 `musou-audio-muted`（'1'/'0'）互不覆盖：
 *     老玩家升级后静音偏好原样保留，不会因为新增音量键被"重置"。
 *   - 坏数据（手改 localStorage、旧格式、被别的脚本写脏）一律回落默认 100%，
 *     绝不 throw —— 音频设置读不出来是小事，让整局白屏是大事。
 */

import { AUDIO } from '../core/config.js';

/** 存档结构版本：将来改结构时能识别老档，而不是把老档当损坏丢掉。 */
export const VOLUME_VERSION = 1;

/**
 * 默认音量 100%：刻意选满档，保证"升级到这一版"时听感与改版前完全一致。
 * （改版前 master.gain 恒为 AUDIO.MASTER；100% × 0.8 = 0.8，逐样本相同。）
 */
export const DEFAULT_VOLUME = 1;

/**
 * 取默认存储。隐私模式 / Node 环境下访问 localStorage 本身都可能抛错
 * （Safari 的 localStorage 是 getter，一读就 throw），所以必须包起来。
 */
export function defaultStore() {
  try {
    return typeof globalThis !== 'undefined' && globalThis.localStorage ? globalThis.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * 把任意输入夹到 [0,1]。
 * - 负数 → 0，>1 → 1（滑杆外的手改存档、旧版本存了 0~100 的整数，都要能救回来）
 * - NaN / Infinity / 'abc' / null / undefined / 布尔 / 空串 → fallback
 * - 数字字符串 '0.25' → 0.25：滑杆的 value 天生是字符串，这里统一接住，
 *   免得 UI 层到处写 Number() 再判一次 NaN（漏一处就是"拖到一半突然弹回默认"）。
 */
export function clampVolume(v, fallback = DEFAULT_VOLUME) {
  const fb = Number.isFinite(fallback) ? Math.min(1, Math.max(0, fallback)) : DEFAULT_VOLUME;
  if (v === null || v === undefined || typeof v === 'boolean') return fb;
  // 对象/数组不是音量：`Number([])` 会得到 0、`Number([0.5])` 得到 0.5，
  // 不拦住的话一个坏存档（[]）会把音量悄悄变成 0。
  if (typeof v === 'object') return fb;
  if (typeof v === 'string' && v.trim() === '') return fb;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fb;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * 把 JSON 解析结果（对象 / 数字 / 字符串 / 垃圾）归一成 0..1 的音量。
 * - 对象读 `volume` 字段，缺字段回落默认（加字段、删字段都不会让老档变"损坏"）。
 * - 数字 / 数字字符串直接夹取，兼容"键里只存了一个裸数字"的写法。
 */
export function normalizeVolume(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return clampVolume(raw.volume, DEFAULT_VOLUME);
  }
  return clampVolume(raw, DEFAULT_VOLUME);
}

/**
 * JSON 文本 → 音量。
 * 解析失败再试一次"裸数字"（`0.35` 本身是合法 JSON，但 `"0.35"` / 旧格式可能不是），
 * 仍然失败就回默认。任何输入都不 throw。
 */
export function parseVolume(text) {
  if (typeof text !== 'string' || text.trim() === '') return DEFAULT_VOLUME;
  try {
    return normalizeVolume(JSON.parse(text));
  } catch {
    return clampVolume(text.trim(), DEFAULT_VOLUME);
  }
}

/** 音量 → JSON 文本（先夹取，保证写进去的东西永远合法）。 */
export function serializeVolume(volume) {
  return JSON.stringify({ v: VOLUME_VERSION, volume: clampVolume(volume, DEFAULT_VOLUME) });
}

/**
 * 读音量存档。
 * 没有键 → 默认 100%（不是 0：新增功能不能把老玩家的声音"静音掉"）。
 * 故意**不**读取旧静音键来推断音量：两个偏好是独立维度，混在一起会让行为不可预测。
 */
export function loadVolume(store = defaultStore()) {
  let text = null;
  try {
    text = store && typeof store.getItem === 'function' ? store.getItem(AUDIO.VOLUME_KEY) : null;
  } catch {
    text = null;
  }
  if (text === null || text === undefined) return DEFAULT_VOLUME;
  return parseVolume(text);
}

/**
 * 写音量存档。写失败（配额满 / 隐私模式 / 无存储）只静默跳过：
 * 音频设置写不进去是小事，让整个游戏因为一次 setItem 抛错而白屏是大事。
 */
export function saveVolume(volume, store = defaultStore()) {
  const v = clampVolume(volume, DEFAULT_VOLUME);
  try {
    if (store && typeof store.setItem === 'function') {
      store.setItem(AUDIO.VOLUME_KEY, serializeVolume(v));
    }
  } catch {
    /* 忽略：见函数注释 */
  }
  return v;
}

/** 读旧静音键（'1' 才算静音；损坏值一律当"开声音"，不该把玩家静音了）。 */
export function loadMuted(store = defaultStore()) {
  try {
    return store && typeof store.getItem === 'function' ? store.getItem(AUDIO.STORE_KEY) === '1' : false;
  } catch {
    return false;
  }
}

/** 写静音键，格式保持 '1'/'0'，与改版前完全兼容（老玩家刷新不会丢静音偏好）。 */
export function saveMuted(muted, store = defaultStore()) {
  try {
    if (store && typeof store.setItem === 'function') {
      store.setItem(AUDIO.STORE_KEY, muted ? '1' : '0');
    }
  } catch {
    /* 忽略：与 saveVolume 同理 */
  }
  return !!muted;
}

/**
 * ★ 全游戏唯一的音量计算点。
 *
 * @param {number} volume 0..1（非法值按 100% 处理）
 * @param {boolean} muted 是否静音
 * @param {number} [base] 这一路的固定基准增益；默认 AUDIO.MASTER（0.8）
 * @returns {number} 0..base
 *
 * 静音在这里直接返回 0，不是"把 volume 改成 0"：
 *   - 滑杆位置保留，玩家取消静音后能回到原响度；
 *   - 音效播放与 master.gain 都从这里取增益，测试也钉死
 *     computeGain(1, true) === 0 与 computeGain(0.5, false) === 0.5 × base。
 */
export function computeGain(volume, muted, base = AUDIO.MASTER) {
  const b = Number.isFinite(base) ? Math.max(0, base) : AUDIO.MASTER;
  if (muted) return 0;
  return clampVolume(volume, DEFAULT_VOLUME) * b;
}

/** 0..1 → 0..100 的整数百分比（UI 显示 / 滑杆取值）。 */
export function toPercent(volume) {
  return Math.round(clampVolume(volume, DEFAULT_VOLUME) * 100);
}

/** 0..100 → 0..1（滑杆 input 的 value 天生是字符串，这里一并接住）。 */
export function fromPercent(percent) {
  const n = typeof percent === 'number' ? percent : Number(percent);
  if (!Number.isFinite(n)) return DEFAULT_VOLUME;
  return clampVolume(n / 100, DEFAULT_VOLUME);
}
