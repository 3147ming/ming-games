/**
 * P11「演出」纯逻辑层：零 DOM、零 Three.js、零随机、不读系统时钟。
 *
 * 所有时间量都由调用方传入（局内经过秒数 / 毫秒时间戳），同一输入永远同一输出，
 * 因此可以在 Node 单测里逐位锁定，也不会污染 world.rng 的确定性序列。
 */
export const PRESENTATION = {
  screenFadeMs: 180,
  resultStaggerMs: 55,
  resultRowDurMs: 260,
  transitionHoldMs: 420,
  transitionFadeMs: 320,
  streakWindow: 3.2,
  streakLife: 1.6,
  heartbeatHzFallback: 1.3,
};

/** 连杀档位文案；更高连击走「N 连击倒」，不为演出编造击杀者 / 伤害来源。 */
export const STREAK_LABELS = {
  2: '双杀',
  3: '三连击倒',
  4: '四连击倒',
  5: '压制连环',
};

export function streakLabel(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n < 2) return '';
  return STREAK_LABELS[n] || `${n} 连击倒`;
}

/**
 * 推进连杀计数（纯函数，返回新对象，不改入参）。
 * 距上一击超过 windowSec 就重新从 1 起算；时间倒流也按重新起算处理。
 */
export function advanceStreak(state, time, windowSec = PRESENTATION.streakWindow) {
  const prev = state && typeof state === 'object' ? state : {};
  const t = Number(time) || 0;
  const rawLast = Number(prev.lastTime);
  const last = Number.isFinite(rawLast) ? rawLast : -Infinity;
  const gap = t - last;
  const within = gap >= 0 && gap <= windowSec;
  const count = within ? Math.floor(Number(prev.count) || 0) + 1 : 1;
  return { count, lastTime: t };
}

export function easeOutCubic(t) {
  const x = Math.max(0, Math.min(1, Number(t) || 0));
  return 1 - (1 - x) ** 3;
}

/**
 * 数值滚动：把字符串里第一段数字按进度插值，前后缀与千分位格式原样保留。
 * 例：countUpText('¥3,600', 0.5) → '¥2,925'（0.5 经 easeOutCubic 后为 0.875）。
 */
export function countUpText(text, progress) {
  const src = String(text ?? '');
  const m = src.match(/-?\d[\d,]*(?:\.\d+)?/);
  if (!m) return src;
  const raw = m[0];
  const target = Number(raw.replace(/,/g, ''));
  if (!Number.isFinite(target)) return src;
  const decimals = raw.includes('.') ? raw.split('.')[1].length : 0;
  const v = target * easeOutCubic(progress);
  const num = decimals
    ? v.toFixed(decimals)
    : (raw.includes(',') ? Math.round(v).toLocaleString('en-US') : String(Math.round(v)));
  return src.slice(0, m.index) + num + src.slice(m.index + raw.length);
}

/** 结算逐条入场延迟（毫秒），封顶避免长战利品列表把尾行拖到几秒后。 */
export function staggerDelay(index, stepMs = PRESENTATION.resultStaggerMs, capMs = 900) {
  const i = Math.max(0, Math.floor(Number(index) || 0));
  return Math.min(capMs, i * Math.max(0, Number(stepMs) || 0));
}

/** 过场文案：只报结果，不做死亡回放 / 伤害来源 / 击杀者 / 存活时长的演出。 */
export const TRANSITION_COPY = {
  success: { tag: 'EXTRACTION CONFIRMED', cn: '撤离完成', tone: 'ok' },
  failure: { tag: 'MISSION FAILED', cn: '行动中止', tone: 'bad' },
};

export function transitionCopy(kind) {
  return TRANSITION_COPY[kind] || TRANSITION_COPY.failure;
}

/** 低血量心跳：给定局内时间、频率与上次触发时间，判断是否该响一下。 */
export function heartbeatDue(time, hz, lastTime) {
  const period = 1 / Math.max(0.1, Number(hz) || PRESENTATION.heartbeatHzFallback);
  const t = Number(time) || 0;
  const last = Number(lastTime);
  if (!Number.isFinite(last) || last < 0) return false;
  return t - last >= period;
}
