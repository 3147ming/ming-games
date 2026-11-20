/**
 * P22 玩家压制（纯逻辑：零 three / 零 DOM / 零随机 / 零存档）
 *
 * 为什么要单独一层：AI 的压制在 `perception.js` 里（`addSuppression` / `suppressionAccuracyMul`），
 * 那套是「AI 被打 → 打不准、找掩体」，服务于敌方决策；玩家这边要的是**感受**而不是决策 ——
 * 屏幕边缘收紧、准星发飘、枪口不听话。两者共用一套数值会互相污染，所以分开。
 *
 * 三条硬约束：
 * - 压制**不提供任何敌方坐标**，只是"我正被火力覆盖"的强度值，杜绝变相透视。
 * - 抖动用 sin 曲线而不是 rng：世界主随机流要喂散布 / 掉落 / AI，这里多抽一次会让同 seed 整局漂移。
 * - 压制值为 0 时所有函数都返回恒等值（乘数 1、透明度 0、位移 0），旧局与旧测试逐位不变。
 *
 * 数值全部来自 `config.js` 的 `COMBAT.playerSuppression`。
 */

import { COMBAT } from './config.js';

/** 读配置（允许缺省：老存档 / 老配置下退化为"无压制"） */
function cfg() {
  return COMBAT.playerSuppression || {};
}

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 累加压制值。
 * @param {number} current 当前压制值 0~1
 * @param {'nearMiss'|'hit'} source 来源
 * @returns {number} 新值 0~1
 */
export function addPlayerSuppression(current, source) {
  const c = cfg();
  if (c.enabled === false) return clamp01(current);
  const cur = clamp01(current);
  const add = source === 'hit'
    ? (c.onHit != null ? c.onHit : 0.46)
    : (c.onNearMiss != null ? c.onNearMiss : 0.32);
  return clamp01(cur + add);
}

/**
 * 压制值自然衰减。
 * @param {number} current 当前值 0~1
 * @param {number} dt 帧间隔秒
 * @returns {number} 新值 0~1
 */
export function decayPlayerSuppression(current, dt) {
  const c = cfg();
  const cur = clamp01(current);
  const rate = c.decay != null ? c.decay : 0.52;
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  return clamp01(cur - rate * step);
}

/**
 * 压制对玩家扩散的放大倍率：0 压制 = 1（恒等），满压制 = `spreadMulAtMax`。
 * 只放大散布，不动后坐 —— 后坐是"可以练会"的，散布才是"被压住"。
 * @param {number} suppression 压制值
 * @returns {number} 倍率 ≥ 1
 */
export function suppressionSpreadMul(suppression) {
  const c = cfg();
  const max = c.spreadMulAtMax != null ? c.spreadMulAtMax : 1.45;
  const v = clamp01(suppression);
  return 1 + (max - 1) * v;
}

/**
 * HUD 边缘血色强度：0 压制 = 0（不画），满压制 = `vignetteAtMax`。
 * @param {number} suppression 压制值
 * @returns {number} 0~1
 */
export function suppressionVignette(suppression) {
  const c = cfg();
  const max = c.vignetteAtMax != null ? c.vignetteAtMax : 0.55;
  return clamp01(clamp01(suppression) * max);
}

/**
 * 确定性"呼吸"位移，供 HUD 层做轻微晃动（准星 / 边缘）。
 *
 * 两路不同频率的正弦相加，避免机械的单一周期；`phase` 用世界时间即可，
 * 同一帧所有调用点得到同一个值（不会各自抖）。
 *
 * @param {number} suppression 压制值 0~1
 * @param {number} t 时间（秒），通常传 world.time
 * @param {object} [out] 复用的输出对象，避免每帧新建
 * @returns {{x:number, y:number}} 像素级位移建议值（0 压制时恒为 0,0）
 */
export function suppressionSway(suppression, t, out) {
  const o = out || { x: 0, y: 0 };
  const v = clamp01(suppression);
  if (v <= 0) {
    o.x = 0;
    o.y = 0;
    return o;
  }
  const c = cfg();
  const hz = c.breatheHz != null ? c.breatheHz : 1.7;
  const time = Number.isFinite(t) ? t : 0;
  const amp = v * v; // 平方：轻度压制几乎不晃，重度才明显
  const a = time * hz * Math.PI * 2;
  o.x = Math.sin(a) * 2.4 * amp;
  o.y = Math.sin(a * 1.618 + 0.9) * 1.7 * amp;
  return o;
}

/**
 * 是否已经"被压住"（给 UI / 音频做阈值判断，避免每处各写一个魔数）。
 * @param {number} suppression 压制值
 * @returns {boolean}
 */
export function isPinned(suppression) {
  return clamp01(suppression) >= 0.5;
}
