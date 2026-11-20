/**
 * 枪感：可学习的后坐模式（纯函数 · 零 DOM · 零随机）
 *
 * 为什么需要它：改造前每发的水平后坐是 `recoil * rng.float(-1,1)` 的纯随机游走，
 * 玩家无法通过练习形成肌肉记忆，扫射只能"看运气"。这里把每把枪的后坐做成一条
 * **固定曲线**：垂直方向首发最猛、随后递减到平台；水平方向左右交替并逐渐加大幅度。
 * 玩家练熟后可以反向压枪，连射才有"可控的代价"。
 *
 * 设计约束：
 * - 绝不消耗 `world.rng`：模式是确定性的，玩法随机流（散布/AI/掉落）不受影响。
 * - 敌人不走路数表：AI 仍用随机后坐，避免改变既有 PVE 难度与可复现性。
 * - 所有数值以「单发基础后坐 def.recoil 的倍数」表达，改 recoil 即整条曲线等比缩放。
 */

import { RECOIL, COMBAT } from './config.js';

const clamp01 = (v) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

/**
 * 取某把武器对应的后坐曲线（未登记的武器统一回落 default）。
 * @param {string} id 武器 id
 * @returns {{pitch: number[], yaw: number[]}} 曲线（倍率数组）
 */
export function patternFor(id) {
  const p = RECOIL && RECOIL.patterns ? RECOIL.patterns : {};
  const pat = p[id];
  if (pat && Array.isArray(pat.pitch) && Array.isArray(pat.yaw) && pat.pitch.length && pat.yaw.length) {
    return pat;
  }
  return p.default || { pitch: [1], yaw: [0] };
}

/**
 * 计算「第 index 发」的后坐倍率。纯函数，不修改任何状态。
 *
 * 序号归零规则：距上一发超过 RECOIL.resetGap 秒视为新一轮扫射，从第一发重新起算——
 * 这正是"点射比泼水准"的机制来源。
 *
 * @param {string} id 武器 id
 * @param {number} index 当前弹道序号（0 = 本轮第一发）
 * @param {number} sinceShot 距上一发经过的秒数（首发出枪时给一个大值）
 * @returns {{index: number, pitchMul: number, yawMul: number}} 归一化后的序号与倍率
 */
export function recoilStep(id, index, sinceShot) {
  const reset = !(sinceShot < (RECOIL?.resetGap ?? 0.3));
  const n = reset ? 0 : Math.max(0, Math.floor(Number.isFinite(index) ? index : 0));
  const pat = patternFor(id);
  return {
    index: n,
    pitchMul: pat.pitch[n % pat.pitch.length],
    yawMul: pat.yaw[n % pat.yaw.length],
  };
}

/**
 * 计算这一发的实际扩散（弧度）。纯函数，准星读数与弹道共用同一份真值。
 *
 * 四个因子（P4-C2）：
 * 1. 基础扩散 + 连射累积（上限 spreadMax）；
 * 2. 开镜按 adsT 平滑收紧 —— 过渡中每一帧都不同，不是布尔跳变；
 * 3. 移动/冲刺放大 —— 站定点射最准；
 * 4. 本轮第一发收窄（点射奖励）。
 *
 * @param {object} def 武器定义
 * @param {number} acc 连射累积的额外扩散（w.spread）
 * @param {object} o { adsT, moveMag, sprinting, firstShot, isPlayer }
 * @returns {number} 扩散弧度
 */
export function spreadAt(def, acc, o = {}) {
  const base = Math.min(def.spreadMax, (def.spread || 0) + (acc || 0));
  const adsT = clamp01(o.adsT);
  const moveMul = 1
    + (o.isPlayer
      ? (COMBAT.moveSpreadK || 0) * clamp01(o.moveMag)
        + (o.sprinting ? (COMBAT.sprintSpreadK || 0) : 0)
      : 0);
  let s = base * (1 - (1 - (COMBAT.adsSpreadMul ?? 1)) * adsT) * moveMul;
  if (o.firstShot) s *= COMBAT.firstShotMul ?? 1;
  // P19：蹲伏有稳定性收益（0.8~0.9），但换来的移速损失已经很大，不需要再叠别的惩罚。
  if (o.crouching) s *= COMBAT.crouchSpreadMul ?? 1;
  // P19：抬枪未完成（冲刺刚结束）时枪口还在晃，按剩余比例放大扩散。
  if (o.raiseT > 0) s *= 1 + (COMBAT.raiseSpreadK ?? 0) * clamp01(o.raiseT);
  // P19：探出掩体时暴露面更大，给一点散布惩罚，避免「零成本探头对枪」。
  if (o.leaning) s *= (COMBAT.lean && COMBAT.lean.spreadMul) || 1;
  return s;
}

/**
 * 前 count 发的累计抬枪倍率（供准星/调试读数复用，保证与实战同一套曲线）。
 * 注意：实战抬枪有上限截断（COMBAT.recoilPitchMax），这里只做曲线累计，不做截断。
 * @param {string} id 武器 id
 * @param {number} count 发数
 * @returns {number} 累计倍率
 */
export function climbMul(id, count) {
  const pat = patternFor(id);
  const n = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0));
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += pat.pitch[i % pat.pitch.length];
  return sum;
}
