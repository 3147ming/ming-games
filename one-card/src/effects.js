// 效果 DSL 执行器
// 这是整个战斗系统唯一的「效果计算入口」。所有卡牌、遗物、敌人意图都只产出 ops 数据，
// 由这里统一解释执行 —— 因此永远不需要 if (card.name === '火球')。

import { CONST } from '../config/constants.js';
import { drawCards } from './cards.js';

/** who 是绝对口径：'self' = 玩家，'enemy' = 敌人。对卡牌、遗物、敌人意图三处统一成立。 */
export function side(state, who) {
  return who === 'self' ? state.player : state.enemy;
}

export function other(who) {
  return who === 'self' ? 'enemy' : 'self';
}

export function makeStatuses() {
  return { str: 0, dex: 0, vuln: 0, weak: 0, poison: 0 };
}

/**
 * 伤害公式（口径，顺序不可换）：
 *   d = (基础值 + 攻击方力量) × (攻击方虚弱 ? 0.75 : 1) × (受击方易伤 ? 1.5 : 1)，向下取整
 * 先加后乘：力量不受虚弱/易伤影响，这是为了让「堆力量」有稳定的线性收益，便于做数值预算。
 */
export function computeDamage(base, attacker, defender) {
  let d = base + (attacker.statuses.str || 0) * CONST.STR_PER_STACK;
  if (attacker.statuses.weak > 0) d *= CONST.WEAK_MULT;
  if (defender.statuses.vuln > 0) d *= CONST.VULN_MULT;
  return Math.max(0, Math.floor(d));
}

/** 格挡先抵扣，溢出部分才扣血 */
export function dealDamage(state, from, to, base) {
  const atk = side(state, from);
  const def = side(state, to);
  const dmg = computeDamage(base, atk, def);
  const absorbed = Math.min(def.block, dmg);
  def.block -= absorbed;
  const hpLoss = dmg - absorbed;
  def.hp = Math.max(0, def.hp - hpLoss);
  state.log.push({ t: 'dmg', from, value: dmg, absorbed, hpLoss });
  return { dmg, absorbed, hpLoss };
}

/** 无视格挡的直伤（中毒、自伤） */
export function dealPure(state, to, amount) {
  const t = side(state, to);
  const loss = Math.min(t.hp, amount);
  t.hp -= loss;
  state.log.push({ t: 'pure', from: other(to), value: loss, absorbed: 0, hpLoss: loss });
  return loss;
}

export function gainBlock(state, who, amount) {
  const s = side(state, who);
  const v = amount + (s.statuses.dex || 0) * CONST.DEX_PER_STACK;
  s.block += v;
  state.log.push({ t: 'block', who, value: v });
  return v;
}

function condMet(state, cond) {
  switch (cond.type) {
    case 'enemyHpBelowHalf':
      return state.enemy.hp <= state.enemy.maxHp / 2;
    case 'enemyHasStatus':
      return (state.enemy.statuses[cond.status] || 0) > 0;
    case 'handEmpty':
      return state.hand.length === 0;
    default:
      return false;
  }
}

/**
 * 执行一组 ops。
 * ctx: { state, rng }
 * 容错口径：允许传入单个 op（不包数组），统一在这里归一化 —— 避免调用方各写一遍。
 */
export function resolveOps(state, ops, ctx = {}) {
  if (!ops) return;
  const list = Array.isArray(ops) ? ops : [ops];
  for (const op of list) resolveOp(state, op, ctx);
}

function resolveOp(state, op, ctx) {
  switch (op.op) {
    case 'damage': {
      const times = op.times || 1;
      for (let i = 0; i < times; i++) dealDamage(state, 'self', 'enemy', op.value);
      break;
    }
    case 'block':
      gainBlock(state, 'self', op.value);
      break;
    case 'draw':
      if (ctx.rng) drawCards(state, op.value, ctx.rng);
      break;
    case 'energy': {
      state.player.energy += op.value;
      state.log.push({ t: 'energy', value: op.value });
      break;
    }
    case 'heal': {
      const v = Math.min(op.value, state.player.maxHp - state.player.hp);
      state.player.hp += v;
      state.log.push({ t: 'heal', value: v });
      break;
    }
    case 'loseHp':
      dealPure(state, 'self', op.value);
      break;
    case 'status': {
      const s = side(state, op.who);
      s.statuses[op.status] = (s.statuses[op.status] || 0) + op.value;
      state.log.push({ t: 'status', who: op.who, status: op.status, value: op.value });
      break;
    }
    case 'if':
      if (condMet(state, op.cond)) resolveOps(state, op.then, ctx);
      else if (op.else) resolveOps(state, op.else, ctx);
      break;
    default:
      break;
  }
}

/** 回合开始结算：中毒扣血（无视格挡）后层数 -1 */
export function tickTurnStart(state, who) {
  const s = side(state, who);
  const p = s.statuses.poison || 0;
  if (p > 0) {
    dealPure(state, who, p);
    s.statuses.poison = p - 1;
    state.log.push({ t: 'poison', who, value: p });
  }
}

/** 回合结束结算：易伤 / 虚弱 层数 -1 */
export function tickTurnEnd(state, who) {
  const s = side(state, who);
  if (s.statuses.vuln > 0) s.statuses.vuln -= 1;
  if (s.statuses.weak > 0) s.statuses.weak -= 1;
}

/** 意图预告用的伤害预估（含当前状态，但不含未来可能的状态变化） */
export function previewAttack(state, base) {
  return computeDamage(base, state.enemy, state.player);
}
