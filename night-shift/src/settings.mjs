/**
 * 玩家设置（Esc 暂停菜单 → 设置页）—— 单一真源 + localStorage 持久化
 *
 * 为什么要单独一个模块（而不是塞进 state.mjs）：
 *   1) 语义不同。state.mjs 存放的是**一局游戏**的进程数据，会随存档走、随开新局清零；
 *      而音量/亮度/灵敏度/FOV 是**玩家偏好**，属于"这台机器上的这个玩家"，
 *      跨局、跨存档、跨重启都应该沿用 —— 混进 state 会让 resetGame() 把它误清掉。
 *   2) 消费方很分散：后处理（亮度/伽马/暗角）、音频（两条总线音量）、
 *      player（灵敏度）、camera（FOV）各要一份。集中在这里 + 一个订阅回调，
 *      改一处就能全部生效，不必在每个模块里各自读 localStorage。
 *
 * 与存档的关系（需求：设置自动保存进 localStorage，读档后沿用）：
 *   设置**不入存档**，直接落 localStorage。读档只还原游戏进程，
 *   不去动玩家偏好 —— 这正是"读档后沿用"的实现方式（谁也没覆盖它）。
 *
 * 默认值刻意避开极端：
 *   · brightness 默认 > 1：直接解决"深夜太黑"（需求原话），但仍压在深色域内；
 *   · fov 默认 75：在可调区间里取偏窄的一侧，走路不剧烈晃；
 *     （范围 60–100：手机横屏视野小，触屏设备首次启动会默认拉到 85，见 main.mjs）
 *   · 音效默认高于 BGM：音效是"操作反馈"，必须听得清；BGM 是氛围，不能盖过它。
 */

export const SETTINGS_KEY = 'nightshift.settings.v1';

/**
 * 默认值。所有取值都必须落在下面 RANGES 的区间内（有测试断言）。
 */
export const DEFAULTS = {
  /** BGM 总线音量（0..1） */
  bgm: 0.42,
  /** 音效总线音量（0..1） —— 默认比 BGM 高，保证操作反馈听得清 */
  sfx: 0.78,
  /** 画面亮度倍率（线性空间）—— 默认略亮，解决深夜看不清 */
  brightness: 1.18,
  /** 伽马：<1 提亮暗部（同时压一点高光），>1 压暗 */
  gamma: 0.95,
  /** 暗角强度（0 = 关，1 = 很重） */
  vignette: 0.42,
  /** 鼠标灵敏度倍率（乘在 config.SENSITIVITY 上） */
  sensitivity: 1.0,
  /** 视场角（度） */
  fov: 75,
};

/**
 * 每项的取值范围与 UI 元信息（设置面板直接据此生成滑杆，不另写一份文案）。
 * step 用于 <input type=range>，保证拖动得到的是"人看得懂"的刻度。
 */
export const RANGES = {
  bgm:         { min: 0,    max: 1,    step: 0.01, label: '背景音乐', hint: '白天/深夜/高峰会自动变化' },
  sfx:         { min: 0,    max: 1,    step: 0.01, label: '音效',     hint: '交互 / 脚步 / 结算提示音' },
  brightness:  { min: 0.6,  max: 1.9,  step: 0.02, label: '亮度',     hint: '调高可缓解深夜过暗' },
  gamma:       { min: 0.5,  max: 2.0,  step: 0.02, label: '伽马',     hint: '>1 提亮暗部，<1 压暗' },
  vignette:    { min: 0,    max: 1,    step: 0.01, label: '暗角',     hint: '四角压暗，聚焦店铺中央' },
  sensitivity: { min: 0.3,  max: 2.5,  step: 0.05, label: '鼠标灵敏度' },
  fov:         { min: 60,   max: 100,  step: 1,    label: '视场角 FOV' },
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** 当前生效的设置（模块级单例；读取方直接 import 这个对象即可，永远是活值） */
export const settings = { ...DEFAULTS };

const listeners = new Set();

/** 订阅设置变化。返回取消订阅函数。 */
export function onSettingsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notifyChanged(changed) {
  for (const fn of listeners) {
    try { fn(settings, changed); } catch { /* 订阅方自己的异常不该影响设置生效 */ }
  }
}

/** 判别哪些 key 是合法设置项 */
export function isSettingKey(key) {
  return Object.prototype.hasOwnProperty.call(DEFAULTS, key);
}

/**
 * 归一化单项：类型不对 / 越界 / NaN 一律回落到默认值或边界值。
 * 为什么必须做：localStorage 里的内容是**用户可以手改**的，
 * 一旦被塞进 NaN，亮度会直接把画面算成黑色（与 ADR-005 的黑屏同症状，很难查）。
 */
export function normalize(key, value) {
  const r = RANGES[key];
  const def = DEFAULTS[key];
  if (!r) return def;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return def;
  return clamp(n, r.min, r.max);
}

/* ---------- 持久化 ---------- */

let storageOk = null;
function canUseStorage() {
  if (storageOk !== null) return storageOk;
  try {
    const k = '__ns_settings_probe__';
    window.localStorage.setItem(k, '1');
    window.localStorage.removeItem(k);
    storageOk = true;
  } catch { storageOk = false; }
  return storageOk;
}

/**
 * 从 localStorage 读入并合并。**不会**写回 —— 纯读取。
 * @returns {string[]} 实际发生变化的 key（供调用方决定要不要立刻 apply）
 */
export function loadSettings() {
  const changed = [];
  if (!canUseStorage()) return changed;
  let raw = null;
  try { raw = window.localStorage.getItem(SETTINGS_KEY); } catch { raw = null; }
  if (!raw) return changed;
  let data = null;
  try { data = JSON.parse(raw); } catch { return changed; }
  if (!data || typeof data !== 'object') return changed;
  for (const key of Object.keys(DEFAULTS)) {
    if (!(key in data)) continue;
    const v = normalize(key, data[key]);
    if (v !== settings[key]) { settings[key] = v; changed.push(key); }
  }
  return changed;
}

/** 写盘（失败静默 —— 无痕模式 / 配额满时不该拦住游戏） */
export function persistSettings() {
  if (!canUseStorage()) return false;
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch { return false; }
}

/**
 * 设置一项（会 clamp + 立刻持久化 + 通知订阅方）。
 * @returns 归一化后的实际值
 */
export function setSetting(key, value) {
  if (!isSettingKey(key)) return undefined;
  const v = normalize(key, value);
  if (v === settings[key]) return v;
  settings[key] = v;
  persistSettings();
  notifyChanged([key]);
  return v;
}

/** 批量设置（面板一次性应用时用；逐个 set 会触发多次通知） */
export function setSettings(patch) {
  const changed = [];
  for (const [k, raw] of Object.entries(patch ?? {})) {
    if (!isSettingKey(k)) continue;
    const v = normalize(k, raw);
    if (v === settings[k]) continue;
    settings[k] = v;
    changed.push(k);
  }
  if (changed.length) {
    persistSettings();
    notifyChanged(changed);
  }
  return changed;
}

/** 恢复默认（面板上的"恢复默认"按钮） */
export function resetSettings() {
  return setSettings({ ...DEFAULTS });
}

/** 只读快照（给 HUD / 测试用；避免调用方直接改内部对象） */
export function settingsSnapshot() {
  return { ...settings };
}
