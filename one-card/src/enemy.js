// 敌人与意图系统
// 口径：意图模式是固定循环而非随机 —— 玩家必须能提前算账，这是卡牌肉鸽策略性的前提。
//      随机意图会把「规划」退化成「赌博」，直接摧毁核心循环。

import { makeStatuses, dealDamage, resolveOps, previewAttack } from './effects.js';
import { STATUS_TEXT } from '../config/constants.js';

export function makeEnemy(def, rng) {
  return {
    id: def.id,
    n: def.n,
    sub: def.sub,
    tier: def.tier,
    shape: def.shape,
    hp: def.hp,
    maxHp: def.hp,
    block: 0,
    statuses: makeStatuses(),
    pattern: def.pattern,
    intentIndex: 0,
    intent: def.pattern[0],
    // 内容批 P1-5：二阶段（Boss 蜕变）。无 pattern2 的敌人 phase2 恒为 false，行为与旧版一字不差。
    pattern2: def.pattern2 || null,
    phase2At: def.phase2At != null ? def.phase2At : 0.5,
    phase2: false,
  };
}

/**
 * 二阶段切换（P1-5）。
 * 口径：**在敌人行动结算完之后判定**，而不是在玩家回合判定。
 *      - 玩家看到并据此规划的那条意图必须被真实执行，否则「可预告」被破坏；
 *      - 切换后把 intentIndex 指到 pattern2 末位，紧接着 combat.js 的 advanceIntent
 *        自然回落到 pattern2[0]，因此无需改动战斗循环的调用顺序。
 */
export function checkPhase2(state) {
  const enemy = state.enemy;
  if (!enemy || enemy.phase2 || !enemy.pattern2 || enemy.hp <= 0) return false;
  if (enemy.hp / enemy.maxHp > enemy.phase2At) return false;
  enemy.phase2 = true;
  enemy.pattern = enemy.pattern2;
  enemy.intentIndex = enemy.pattern2.length - 1;
  enemy.intent = enemy.pattern2[0];
  state.log.push({ t: 'info', text: `${enemy.n} 撕开了自己的壳 —— 它变了。` });
  return true;
}

export function advanceIntent(enemy) {
  enemy.intentIndex = (enemy.intentIndex + 1) % enemy.pattern.length;
  enemy.intent = enemy.pattern[enemy.intentIndex];
  return enemy.intent;
}

/** 把意图翻译成 UI 需要的结构：kind 决定颜色，value 是已含状态的实数 */
export function intentView(state, enemy) {
  const it = enemy.intent;
  if (!it) return { kind: 'def', text: '——', value: '' };
  switch (it.t) {
    case 'attack':
      return { kind: 'atk', text: '攻击', value: previewAttack(state, it.value) };
    case 'block':
      return { kind: 'def', text: '格挡', value: it.value };
    case 'buff':
      return { kind: 'buf', text: '增益', value: `${STATUS_TEXT[it.status] || it.status} +${it.value}` };
    case 'debuff':
      return { kind: 'buf', text: '施加', value: `${STATUS_TEXT[it.status] || it.status} +${it.value}` };
    default:
      return { kind: 'def', text: '——', value: '' };
  }
}

/**
 * 执行敌人当前意图。
 * 注意：意图里的 buff 是「敌人自己拿」，debuff 是「施加给玩家」。
 *      因为 who 是绝对口径（self=玩家 / enemy=敌人），
 *      buff 写成 who:'enemy'，debuff 写成 who:'self'。
 */
export function runIntent(state, ctx) {
  const enemy = state.enemy;
  const it = enemy.intent;
  if (!it) return;

  switch (it.t) {
    case 'attack':
      dealDamage(state, 'enemy', 'self', it.value);
      state.log.push({ t: 'info', text: `${enemy.n} 发动攻击。` });
      break;
    case 'block':
      enemy.block += it.value;
      state.log.push({ t: 'info', text: `${enemy.n} 获得 ${it.value} 点格挡。` });
      break;
    case 'buff':
      resolveOps(state, [{ op: 'status', status: it.status, value: it.value, who: 'enemy' }], ctx);
      state.log.push({ t: 'info', text: `${enemy.n} 强化了自己。` });
      break;
    case 'debuff':
      resolveOps(state, [{ op: 'status', status: it.status, value: it.value, who: 'self' }], ctx);
      state.log.push({ t: 'info', text: `${enemy.n} 对你施加了${STATUS_TEXT[it.status] || it.status}。` });
      break;
    default:
      break;
  }

  // 行动结算之后再判定蜕变：本回合已展示的意图必须被兑现（P1-5）。
  checkPhase2(state);
}
