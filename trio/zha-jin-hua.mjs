/**
 * 炸金花（三张牌 / 3 Card Poker）核心逻辑 —— 纯函数，Node 可单测。
 * 牌型从大到小：豹子 > 同花顺 > 同花 > 顺子 > 对子 > 单张（同级先比点数，再比花色）。
 * 点数：A(14) > K(13) > Q > J > 10 > ... > 2。A23 算最小顺子。
 */
'use strict';

const SUITS = ['S', 'H', 'D', 'C'];          // 黑红梅方，大小：S>H>D>C
const SUIT_RANK = { S: 4, H: 3, D: 2, C: 1 };
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RV = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,J:11,Q:12,K:13,A:14 };

const TYPES = { HIGH:1, PAIR:2, STRAIGHT:3, FLUSH:4, STRAIGHT_FLUSH:5, TRIPS:6 };
const TYPE_NAME = ['单张','对子','顺子','同花','同花顺','豹子'];

/** 新建一副 52 张牌。 */
function makeDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ s, r, v: RV[r] });
  return d;
}
function shuffle(deck, rand) {
  const d = deck.slice();
  for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}

/** 判定三张牌牌型。返回 {type, name, kick:[依次比较的关键值]} */
function classify(cards) {
  const vals = cards.map(c => c.v).sort((a, b) => b - a);
  const suitSame = cards.every(c => c.s === cards[0].s);
  const trips = vals[0] === vals[1] && vals[1] === vals[2];
  const pair = !trips && (vals[0] === vals[1] || vals[1] === vals[2]);
  // 顺子：A23 视为最小(2,3,A→1)
  const uniq = vals.slice().sort((a, b) => a - b);
  let straight = false, straightHigh = 0;
  if (uniq[0] + 1 === uniq[1] && uniq[1] + 1 === uniq[2]) { straight = true; straightHigh = uniq[2]; }
  else if (uniq[0] === 2 && uniq[1] === 3 && uniq[2] === 14) { straight = true; straightHigh = 3; } // A23

  let type, kick;
  if (trips) { type = TYPES.TRIPS; kick = [vals[0]]; }
  else if (suitSame && straight) { type = TYPES.STRAIGHT_FLUSH; kick = [straightHigh]; }
  else if (suitSame) { type = TYPES.FLUSH; kick = vals.slice(); }
  else if (straight) { type = TYPES.STRAIGHT; kick = [straightHigh]; }
  else if (pair) {
    const pv = vals[0] === vals[1] ? vals[0] : vals[1];
    const kicker = vals[0] === vals[1] ? vals[2] : vals[0];
    type = TYPES.PAIR; kick = [pv, kicker];
  } else { type = TYPES.HIGH; kick = vals.slice(); }
  // 同点数时按花色决胜（只在完全相同点数结构时才有意义）
  const suitKick = cards.slice().sort((a,b)=>b.v-a.v).map(c => SUIT_RANK[c.s]);
  return { type, name: TYPE_NAME[type - 1], kick, suitKick };
}

/** 比较两手牌：>0 前者大，<0 后者大，0 平。 */
function compare(a, b) {
  const A = classify(a), B = classify(b);
  if (A.type !== B.type) return A.type - B.type;
  const n = Math.max(A.kick.length, B.kick.length);
  for (let i = 0; i < n; i++) { const d = (A.kick[i]||0) - (B.kick[i]||0); if (d) return d; }
  for (let i = 0; i < 3; i++) { const d = A.suitKick[i] - B.suitKick[i]; if (d) return d; }
  return 0;
}

/** 牌力估值（0..1），供 AI 决策。 */
function strength(cards) {
  const c = classify(cards);
  const base = c.type / TYPES.TRIPS;               // 0.17..1
  const top = (c.kick[0] || 8) / 14;               // 关键牌大小
  return Math.min(1, base * 0.72 + top * 0.28);
}

/**
 * AI 决策：根据自己牌力、是否看牌、当前注额、诈唬倾向，返回动作。
 * @returns {{act:'fold'|'call'|'raise', amount:number, bluff:boolean}}
 */
function aiDecide(myCards, ctx) {
  const pow = strength(myCards);
  const toCall = ctx.toCall || 0;
  const pot = ctx.pot || 10;
  const rand = ctx.rand || Math.random;
  const bluffRate = ctx.level === 'pro' ? 0.22 : 0.10;
  const bluff = rand() < bluffRate && pow < 0.55;
  // 不看牌时下注为看牌半价（信息差）
  const seen = !!ctx.seen;
  const unit = ctx.unit || 10;
  const effPow = bluff ? Math.max(pow, 0.7) : pow;
  const raiseTh = seen ? 0.62 : 0.72;             // 不看牌更保守
  if (toCall > 0 && effPow < 0.32 && !bluff) return { act: 'fold', amount: 0, bluff: false };
  if (effPow > raiseTh && rand() < 0.65) return { act: 'raise', amount: Math.round(unit * (seen ? 2 : 1)), bluff };
  return { act: 'call', amount: Math.round(toCall * (seen ? 1 : 0.5)), bluff, half: !seen };
}

/** 简化的一局自对弈：两名玩家各发 3 张，比大小返回结果，供批量验收无异常。 */
function simulateHand(rand) {
  const d = shuffle(makeDeck(), rand);
  const a = d.slice(0, 3), b = d.slice(3, 6);
  const cmp = compare(a, b);
  const pa = aiDecide(a, { toCall: 10, pot: 20, unit: 10, seen: true, rand, level: 'pro' });
  const pb = aiDecide(b, { toCall: 10, pot: 20, unit: 10, seen: true, rand, level: 'pro' });
  return { cmp, a: classify(a), b: classify(b), actA: pa.act, actB: pb.act, valid: ['fold','call','raise'].includes(pa.act) && ['fold','call','raise'].includes(pb.act) };
}

export { SUITS, RANKS, RV, TYPES, TYPE_NAME, makeDeck, shuffle, classify, compare, strength, aiDecide, simulateHand };
