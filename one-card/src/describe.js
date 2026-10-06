// 效果 DSL → 中文文案
// 口径：卡面描述由 ops 自动生成，不做手写。这样「配置与文案漂移」这一类 bug 在结构上不可能发生。
// 输出带 <b> 标记数字，由 CSS 负责高亮（见 styles.css 的 .card-text b）。

import { STATUS_TEXT } from '../config/constants.js';

const TYPE_TEXT = {
  attack: '攻击',
  skill: '技能',
  power: '能力',
};

export function typeText(t) {
  return TYPE_TEXT[t] || t;
}

const RARITY_TEXT = { 0: '', 1: '常见', 2: '稀有', 3: '秘藏' };

export function rarityText(r) {
  return RARITY_TEXT[r] ?? '';
}

function statusLine(status, value, who) {
  const name = STATUS_TEXT[status] || status;
  const verb = who === 'self' ? '获得' : '施加';
  return `${verb} <b>${value}</b> 层${name}`;
}

function condText(cond) {
  if (cond.type === 'enemyHpBelowHalf') return '若敌人生命低于一半';
  if (cond.type === 'enemyHasStatus') return `若敌人处于${STATUS_TEXT[cond.status] || cond.status}状态`;
  if (cond.type === 'handEmpty') return '若手牌为空';
  return '若';
}

function opText(op) {
  switch (op.op) {
    case 'damage': {
      const times = op.times || 1;
      return times > 1 ? `造成 <b>${op.value}</b> 点伤害，共 <b>${times}</b> 次` : `造成 <b>${op.value}</b> 点伤害`;
    }
    case 'block':
      return `获得 <b>${op.value}</b> 点格挡`;
    case 'draw':
      return `抽 <b>${op.value}</b> 张牌`;
    case 'energy':
      return `获得 <b>${op.value}</b> 点能量`;
    case 'heal':
      return `回复 <b>${op.value}</b> 点生命`;
    case 'loseHp':
      return `失去 <b>${op.value}</b> 点生命`;
    case 'status':
      return statusLine(op.status, op.value, op.who);
    case 'if':
      return `${condText(op.cond)}，${opsText(op.then || [])}`;
    default:
      return '';
  }
}

export function opsText(ops) {
  return (ops || [])
    .map(opText)
    .filter(Boolean)
    .join('；')
    .replace(/；若/g, '；若');
}

export function describeCard(card) {
  const parts = [];
  if (card.cost === 0) parts.push('<b>0</b> 费');
  return opsText(card.ops);
}

/** 遗物钩子的可读描述（用于牌谱页） */
export function describeRelic(relic) {
  const out = [];
  const h = relic.hooks || {};
  const who = 'self';
  const enemy = 'enemy';
  if (h.combatStart) out.push('战斗开始：' + opsText(h.combatStart.map((o) => ({ ...o, who: o.who || enemy }))));
  if (h.turnStart) out.push('每回合开始：' + opsText(h.turnStart.map((o) => ({ ...o, who: o.who || who }))));
  if (h.combatEnd) out.push('战斗结束：' + opsText(h.combatEnd.map((o) => ({ ...o, who: o.who || who }))));
  if (h.cardPlayed) {
    for (const trig of h.cardPlayed) {
      const c = trig.cond || {};
      const cond = c.cardType ? `打出${typeText(c.cardType)}牌时` : c.costZero ? '打出 0 费牌时' : '打出牌时';
      out.push(cond + '：' + opsText((trig.ops || []).map((o) => ({ ...o, who: o.who || enemy }))));
    }
  }
  return out.join('<br>');
}
