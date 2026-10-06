/**
 * 店员需求状态层（R1）纯逻辑 —— 不依赖 Three.js / DOM（ADR-002）
 *
 * 把「每帧按 dt 更新 clerk 四状态」「小游戏回血增益」「醉汉处置结果」抽成
 * 纯函数，便于在 Node 里单测（见 tests/clerk.test.mjs），也让 main.mjs 只负责"调用"。
 *
 * 数值锁定于 design/gdd/playability-plan.md §1.2 / §3.2 / §4.3（480s 重标定）。
 */
import { CLERK, EVENTS, MENTAL_GAIN, SEGMENTS } from './config.mjs';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** 当前夜段（S1–S4），取 gameHour 所在段（越界回退末段） */
export function segmentOf(gameHour) {
  return SEGMENTS.find((s) => gameHour >= s.from && gameHour < s.to) ?? SEGMENTS[SEGMENTS.length - 1];
}

/**
 * 每帧更新店员四状态。
 * @param {object} state 全局状态（需含 clerk / reputation / gameHour）
 * @param {number} dt 帧时长（秒）
 * @param {object} [player] 可选；暴露 { frameMove:number, touching:boolean }
 *        frameMove = 本帧水平位移（米）；touching = 是否贴着墙/货架（靠墙恢复）
 */
export function updateClerk(state, dt, player) {
  const c = state.clerk;
  if (!c) return;
  const moving = !!(player && typeof player.frameMove === 'number' && player.frameMove > 0);
  const againstWall = !!(player && player.touching);

  // 体力：移动耗 kM·距离；静止回血（靠墙更高效），饱食 <30 时恢复率减半
  if (moving) {
    c.stamina -= CLERK.kM * player.frameMove;
  } else {
    let recover = againstWall ? CLERK.wallRecover : CLERK.idleRecover;
    if (c.satiety < CLERK.thr.satiety) recover *= 0.5; // §1.3 饿得缓不过来
    c.stamina += recover * dt;
  }

  // 疲惫：基础 + 夜段加权 + 低体力附加（S<30）
  const seg = segmentOf(state.gameHour);
  let fInc = CLERK.fatigueBase + (CLERK.segRate[seg.id] ?? 0);
  if (c.stamina < 30) fInc += CLERK.lowStaminaBonus;
  c.fatigue += fInc * dt;

  // 饱食：随时间下降
  c.satiety -= CLERK.satietyDrain * dt;

  // 心理：rep<40 漂移 −0.8/s；mental<30 漂移 −0.5/s（§1.2 / §1.3）
  if (state.reputation < 40) c.mental -= 0.8 * dt;
  if (c.mental < CLERK.thr.mental) c.mental -= 0.5 * dt;

  c.stamina = clamp(c.stamina, 0, 100);
  c.fatigue = clamp(c.fatigue, 0, 100);
  c.satiety = clamp(c.satiety, 0, 100);
  c.mental = clamp(c.mental, 0, 100);
}

/* ---------- R3 娱乐 → 心理健康（§3.2） ---------- */

/**
 * 单个小游戏的回血增益（已按 perGameCap 封顶）。
 * result 字段取自各小游戏 result()（见 minigames.mjs）：
 *   pachinko  → { payout:得分 }
 *   fishing   → { item?:鱼名, payout:鱼价 }
 *   basketball→ { hits:命中数 }
 *   claw      → { item?:奖品名 }
 */
export function mentalFromResult(kind, result = {}) {
  const c = MENTAL_GAIN[kind];
  if (!c) return 0;
  let g;
  if (kind === 'pachinko') {
    g = c.base + (result.payout ?? 0) * c.k;
  } else if (kind === 'fishing') {
    g = result.item ? c.baseHit + (result.payout ?? 0) * c.k : c.base;
  } else if (kind === 'basketball') {
    g = c.base + (result.hits ?? 0) * c.k;
  } else if (kind === 'claw') {
    g = result.item ? c.baseHit : c.base;
  } else if (kind === 'dance') {
    // 星级解锁机：跳舞机按最高连击回血
    g = c.base + (result.combo ?? 0) * c.k;
  } else if (kind === 'racing') {
    g = c.base + (result.perfect ?? 0) * c.k;
  } else if (kind === 'ktv') {
    g = (result.score ?? 0) >= 18 ? c.baseHit : c.base;
  } else {
    return 0;
  }
  return Math.max(0, Math.min(c.cap, g));
}

/**
 * 把一次小游戏增益计入当夜上限（nightCap +40），并钳制 clerk.mental 0..100。
 * @returns 实际生效的增益（受剩余夜上限约束）
 */
export function applyGameMental(state, gain) {
  if (!state.clerk) return 0;
  const before = state.mentalGainFromGames;
  const room = MENTAL_GAIN.nightCap - before;
  const applied = Math.max(0, Math.min(gain, room));
  state.mentalGainFromGames = before + applied;
  state.clerk.mental = clamp(state.clerk.mental + applied, 0, 100);
  return applied;
}

/* ---------- §4.3 醉汉处置 ---------- */

/** 劝离成功率：基础 0.9，mental<30 时 ×0.7 */
export function drunkSuccessChance(mental) {
  return EVENTS.DRUNK.success * (mental < CLERK.thr.mental ? EVENTS.DRUNK.successMentalMul : 1);
}

/**
 * 应用醉汉处置结果（成功 / 超时未处理失败）。
 * @param {boolean} success 成功劝离 true；超时/失败 false
 */
export function resolveDrunkOutcome(state, success) {
  if (success) {
    state.reputation = clamp(state.reputation + EVENTS.DRUNK.repGood, 0, 100); // rep +2
    state.clerk.stamina = clamp(state.clerk.stamina - EVENTS.DRUNK.stamCost, 0, 100); // S −3
  } else {
    state.reputation = clamp(state.reputation + EVENTS.DRUNK.repBad, 0, 100); // rep −5
    state.clerk.mental = clamp(state.clerk.mental + EVENTS.DRUNK.mentalBad, 0, 100); // M −5
  }
}

/* ---------- 动作体力消耗（§1.2 / §8.1 actionCost） ---------- */

/**
 * 按动作类型扣除体力（clamp 0..100）。
 * 注意：DRUNK 的体力消耗已经由 resolveDrunkOutcome 的 stamCost 承担，
 *       这里只处理 TAKE / PLACE / CHECKOUT 三类货架/收银动作，避免重复扣减。
 * @param {string} kind 'TAKE' | 'PLACE' | 'CHECKOUT'
 */
export function applyActionCost(state, kind) {
  const c = CLERK.actionCost?.[kind];
  if (!state.clerk || typeof c !== 'number') return;
  state.clerk.stamina = clamp(state.clerk.stamina - c, 0, 100);
}
