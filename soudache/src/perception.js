/**
 * AI 感知层（纯逻辑：零 three / 零 DOM / 零随机 / 零存档依赖）
 *
 * 三个通道，各自负责一件事，互不越界：
 * - 视觉 `sightRange` / `inCone`：只算「有效视距」和「是否在锥内」。真正的可见性
 *   必须由外部传进来的视线判定（墙体 / 烟幕）拍板 —— 本模块**没有**任何能绕开
 *   LOS 的接口，这是「禁止 AI 透视」在代码层的落点。
 * - 听觉 `hearingError`：距离越近定位越准，且按兵种听觉半径缩放。噪声本身由
 *   开枪 / 脚步事件广播，AI 只负责「听糊了多少」。
 * - 痕迹 `emitTrace` / `nearestTrace`：脚印、弹壳、血迹、尸体会留在世界上并随时间
 *   失效。AI 巡逻时踩到痕迹 → 转调查。痕迹合并走整数网格，**不抽 rng**，
 *   否则同 seed 的整局随机流会被 AI 走动带偏。
 *
 * 所有数值来自 config.js 的 AI.sight / AI.perception / AI.traces / AI.suppression，
 * 改数值不用碰本文件。
 */

import { AI } from './config.js';

/** 痕迹类型（与 config.AI.traces.life 的键一一对应） */
export const TRACE = {
  FOOTPRINT: 'footprint',
  SHELL: 'shell',
  BLOOD: 'blood',
  BODY: 'body',
};

/** 痕迹中文名（HUD / 复盘文案用，避免各处各写一份） */
export const TRACE_LABEL = {
  footprint: '脚印',
  shell: '弹壳',
  blood: '血迹',
  body: '尸体',
};

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 归一化角度差到 [-PI, PI] */
function wrapAngle(d) {
  let a = d;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/* ============================== 视觉 ============================== */

/**
 * 有效视距：基础视距 × 目标隐蔽修正 × 草丛修正。
 *
 * 系数顺序无关（纯乘法），但**草丛只在超过 bushDist 后生效** —— 贴脸蹲草里
 * 仍会被发现，否则玩家可以蹲在草里等 AI 从身上踩过去。
 *
 * @param {number} base 兵种基础视距
 * @param {object} [opts]
 * @param {number} [opts.dist] 与目标的当前距离（判定草丛用）
 * @param {number} [opts.stealthMul] 干员「低可探测」倍率
 * @param {boolean} [opts.crouching] 目标是否蹲伏
 * @param {boolean} [opts.inBush] 目标是否在草丛里
 * @param {number} [opts.alertMul] 警戒态视距倍率
 * @returns {number} 有效视距
 */
export function sightRange(base, opts = {}) {
  const cfg = AI.sight || {};
  let range = Number.isFinite(base) ? base : 0;
  if (opts.alertMul > 0) range *= opts.alertMul;
  if (opts.stealthMul > 0) range *= opts.stealthMul;
  if (opts.crouching) range *= cfg.crouchMul != null ? cfg.crouchMul : 0.72;
  const bushDist = cfg.bushDist != null ? cfg.bushDist : 130;
  if (opts.inBush && (opts.dist == null || opts.dist > bushDist)) {
    range *= cfg.bushMul != null ? cfg.bushMul : 0.4;
  }
  return range;
}

/**
 * 是否落在视野锥内（贴脸不判锥角：背后也能被察觉）。
 * @param {number} dx 目标相对 x
 * @param {number} dy 目标相对 y
 * @param {number} angle 朝向（弧度）
 * @param {number} halfAngle 半锥角（弧度）
 * @param {number} dist 距离
 * @param {number} [nearRadius] 贴脸半径
 * @returns {boolean} 是否在锥内
 */
export function inCone(dx, dy, angle, halfAngle, dist, nearRadius) {
  const near = nearRadius != null ? nearRadius : (AI.sight && AI.sight.nearRadius != null ? AI.sight.nearRadius : 90);
  if (dist <= near) return true;
  const to = Math.atan2(dy, dx);
  return Math.abs(wrapAngle(to - angle)) <= halfAngle;
}

/* ============================== 听觉 ============================== */

/**
 * 听声定位误差：距离越近越准，兵种听觉半径越大越准，但永远留一点误差。
 * @param {object} opts
 * @param {number} opts.dist 声源距离
 * @param {number} opts.radius 噪音半径
 * @param {number} [opts.hearing] 兵种听觉半径
 * @returns {number} 误差半径（世界单位）
 */
export function hearingError(opts = {}) {
  const cfg = (AI.perception) || {};
  const radius = Math.max(1, opts.radius || 0);
  const dist = Number.isFinite(opts.dist) ? opts.dist : radius;
  const clarity = clamp01(1 - dist / radius);
  const ref = cfg.hearingRef != null ? cfg.hearingRef : 420;
  const hearing = opts.hearing != null && opts.hearing > 0 ? opts.hearing : ref;
  const precision = ref / Math.max(1, hearing);
  const base = cfg.noiseBaseError != null ? cfg.noiseBaseError : 60;
  const minError = cfg.minError != null ? cfg.minError : 9;
  return Math.max(minError, base * (1 - clarity) ** 2 * precision);
}

/* ============================== 痕迹 ============================== */

/** 痕迹网格键：同格重复痕迹只刷新，不新增（避免 AI 走过一路留下几百条） */
function traceKey(kind, x, y) {
  const cell = (AI.traces && AI.traces.mergeCell) || 42;
  return `${kind}:${Math.round(x / cell)}:${Math.round(y / cell)}`;
}

/**
 * 留下一条痕迹。
 *
 * @param {Array<object>} list 痕迹列表（world.traces）
 * @param {string} kind TRACE 之一
 * @param {number} x 坐标 x
 * @param {number} y 坐标 y
 * @param {object} [opts]
 * @param {number} [opts.strength] 强度 0~1（蹲走比冲刺弱）
 * @param {number} [opts.life] 存活秒数（缺省读配置）
 * @returns {?object} 痕迹记录；非法输入返回 null
 */
export function emitTrace(list, kind, x, y, opts = {}) {
  if (!Array.isArray(list) || !TRACE_LABEL[kind]) return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const cfg = AI.traces || {};
  if (cfg.enabled === false) return null;
  const lifeCfg = cfg.life || {};
  const life = Number.isFinite(opts.life) ? opts.life : (lifeCfg[kind] || 20);
  const strength = opts.strength != null ? clamp01(opts.strength) : 1;
  const key = traceKey(kind, x, y);
  for (const t of list) {
    if (t && t.key === key) {
      t.strength = Math.max(t.strength, strength);
      t.t = 0;
      t.life = life;
      t.takenBy = null;
      return t;
    }
  }
  const rec = { key, kind, x, y, strength, t: 0, life, takenBy: null };
  list.push(rec);
  const max = cfg.max || 64;
  if (list.length > max) list.splice(0, list.length - max);
  return rec;
}

/**
 * 推进痕迹时效并剔除过期项。
 * @param {Array<object>} list 痕迹列表
 * @param {number} dt 帧间隔秒
 * @returns {number} 本帧剔除的数量
 */
export function decayTraces(list, dt) {
  if (!Array.isArray(list) || !list.length) return 0;
  let removed = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const t = list[i];
    if (!t) { list.splice(i, 1); removed += 1; continue; }
    t.t += Number.isFinite(dt) ? dt : 0;
    if (t.t >= t.life) { list.splice(i, 1); removed += 1; }
  }
  return removed;
}

/**
 * 痕迹的可信度：新鲜度 × 强度 × 距离衰减。
 * @param {object} trace 痕迹
 * @param {number} dist 与观察者距离
 * @param {number} radius 侦察半径
 * @returns {number} 0~1
 */
export function traceConfidence(trace, dist, radius) {
  if (!trace || !(trace.life > 0)) return 0;
  const freshness = clamp01(1 - (trace.t || 0) / trace.life);
  const far = clamp01(1 - Math.max(0, dist) / Math.max(1, radius));
  return clamp01(freshness * (trace.strength != null ? trace.strength : 1) * far);
}

/**
 * 找一条值得过去查的痕迹。
 *
 * 只看视野锥内（半锥角 `coneHalf`）、半径内、且没被自己查过的痕迹。
 * 同一痕迹对同一敌人只查一次（`takenBy`），否则整队会围着同一个脚印转圈。
 *
 * @param {Array<object>} list 痕迹列表
 * @param {object} observer {x,y,angle,id}
 * @param {object} [opts] { radius, halfAngle, minConfidence }
 * @returns {?{trace: object, dist: number, confidence: number}} 结果
 */
export function nearestTrace(list, observer, opts = {}) {
  if (!Array.isArray(list) || !list.length || !observer) return null;
  const cfg = AI.traces || {};
  if (cfg.enabled === false) return null;
  const radius = opts.radius != null ? opts.radius : (cfg.investigateRadius || 260);
  const halfAngle = opts.halfAngle != null ? opts.halfAngle : (cfg.coneHalf || 1.15);
  const minConf = opts.minConfidence != null ? opts.minConfidence : (cfg.minConfidence || 0.22);
  let best = null;
  for (const t of list) {
    if (!t || t.takenBy != null) continue;
    const dx = t.x - observer.x;
    const dy = t.y - observer.y;
    const dist = Math.hypot(dx, dy);
    if (dist > radius) continue;
    if (!inCone(dx, dy, observer.angle, halfAngle, dist, 0)) continue;
    const confidence = traceConfidence(t, dist, radius);
    if (confidence < minConf) continue;
    if (!best || confidence > best.confidence) best = { trace: t, dist, confidence };
  }
  return best;
}

/* ============================== 压制 ============================== */

/**
 * 受压制后累加压制值（不抽 rng）。
 * @param {number} current 当前压制值
 * @param {string} source 'nearMiss' | 'hit'
 * @returns {number} 新压制值
 */
export function addSuppression(current, source) {
  const cfg = AI.suppression || {};
  const cur = clamp01(current);
  const add = source === 'hit'
    ? (cfg.onHit != null ? cfg.onHit : 0.55)
    : (cfg.onNearMiss != null ? cfg.onNearMiss : 0.42);
  return clamp01(cur + add);
}

/**
 * 压制值自然衰减。
 * @param {number} current 当前值
 * @param {number} dt 帧间隔秒
 * @returns {number} 新值
 */
export function decaySuppression(current, dt) {
  const cfg = AI.suppression || {};
  const cur = clamp01(current);
  const rate = cfg.decay != null ? cfg.decay : 0.34;
  return clamp01(cur - rate * (Number.isFinite(dt) ? dt : 0));
}

/**
 * 压制对精度的影响：满压制时乘 `spreadMulAtMax`（越低越打不准）。
 * @param {number} suppression 压制值
 * @returns {number} 精度乘数（喂给 fireWeapon 的 accuracy）
 */
export function suppressionAccuracyMul(suppression) {
  const cfg = AI.suppression || {};
  const v = clamp01(suppression);
  const floor = cfg.spreadMulAtMax != null ? cfg.spreadMulAtMax : 0.62;
  return 1 - (1 - floor) * v;
}

/**
 * 压制对射击间隔的影响：满压制时开火间隔乘 `fireDelayMulAtMax`。
 * @param {number} suppression 压制值
 * @returns {number} 间隔乘数 ≥ 1
 */
export function suppressionFireDelayMul(suppression) {
  const cfg = AI.suppression || {};
  const v = clamp01(suppression);
  const max = cfg.fireDelayMulAtMax != null ? cfg.fireDelayMulAtMax : 1.9;
  return 1 + (max - 1) * v;
}

/** 压制是否已高到该找掩体 */
export function shouldTakeCover(suppression) {
  const cfg = AI.suppression || {};
  return clamp01(suppression) >= (cfg.coverAt != null ? cfg.coverAt : 0.55);
}
