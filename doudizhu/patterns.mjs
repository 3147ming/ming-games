/**
 * 斗地主牌型识别 —— 纯函数，Node 可单测。
 * 牌值：3..14(A) < 15(2) < 16(小王) < 17(大王)。
 * 牌以 {v:number} 传入（可带其它字段），只按 v 判定。
 * 11 类：single/pair/triple/triple1/triple2/straight/pairseq/plane/plane1/quad2/bomb/rocket
 */
'use strict';

/** 识别牌型，失败返回 null。 */
function parse(cards) {
  if (!cards || !cards.length) return null;
  const v = cards.map(c => c.v).sort((a, b) => a - b), n = v.length;
  const counts = {}; v.forEach(x => counts[x] = (counts[x] || 0) + 1);
  const ks = Object.keys(counts).map(Number).sort((a, b) => a - b);
  const cnts = ks.map(k => counts[k]);
  const countOf = c => cnts.filter(x => x === c).length;
  if (n === 2 && v[0] === 16 && v[1] === 17) return { t: 'rocket', main: 17, len: n };
  if (n === 4 && cnts[0] === 4) return { t: 'bomb', main: v[0], len: n };
  if (n === 1) return { t: 'single', main: v[0], len: n };
  if (n === 2 && cnts[0] === 2) return { t: 'pair', main: v[0], len: n };
  if (n === 3 && cnts[0] === 3) return { t: 'triple', main: v[0], len: n };
  if (n === 4 && countOf(3) === 1) return { t: 'triple1', main: ks[cnts.indexOf(3)], len: n };
  if (n === 5 && countOf(3) === 1 && countOf(2) === 1) return { t: 'triple2', main: ks[cnts.indexOf(3)], len: n };
  // 顺子：≥5 张，全单，不含 2/王（v<15），连续
  if (n >= 5 && cnts.every(c => c === 1) && v[n - 1] < 15 && v[n - 1] - v[0] === n - 1)
    return { t: 'straight', main: v[n - 1], len: n };
  // 连对：≥3 对，全对，不含 2/王，连续
  if (n >= 6 && n % 2 === 0 && cnts.every(c => c === 2) && ks[ks.length - 1] < 15 && ks[ks.length - 1] - ks[0] === ks.length - 1)
    return { t: 'pairseq', main: ks[ks.length - 1], len: n };
  // 飞机（连续三张），可带同数量单张或对子
  const triples = ks.filter(k => counts[k] === 3);
  if (triples.length >= 2 && triples[triples.length - 1] - triples[0] === triples.length - 1 && triples[triples.length - 1] < 15) {
    const tmain = triples[triples.length - 1], tn = triples.length;
    if (n === tn * 3) return { t: 'plane', main: tmain, len: n };
    if (n === tn * 4 && countOf(1) === tn) return { t: 'plane1', main: tmain, len: n };       // 飞机带单
    if (n === tn * 5 && countOf(2) === tn) return { t: 'plane2', main: tmain, len: n };       // 飞机带对
  }
  // 四带二（两张单 或 两对）
  const quad = ks.filter(k => counts[k] === 4);
  if (quad.length === 1) {
    if (n === 6 && countOf(1) === 2) return { t: 'quad2', main: quad[0], len: n };
    if (n === 8 && countOf(2) === 2) return { t: 'quad2', main: quad[0], len: n };
  }
  return null;
}

/** 压牌判定：同型同长比主牌；炸弹/王炸为通用大牌。 */
function canBeat(cur, last) {
  if (!cur) return false;
  if (!last) return true;
  if (cur.t === 'rocket') return true;
  if (last.t === 'rocket') return false;
  if (cur.t === 'bomb' && last.t !== 'bomb') return true;
  if (cur.t === 'bomb' && last.t === 'bomb') return cur.main > last.main;
  if (cur.t !== last.t || cur.len !== last.len) return false;
  return cur.main > last.main;
}

/** 是否炸弹/王炸（用于倍数）。 */
function isBomb(p) { return !!p && (p.t === 'bomb' || p.t === 'rocket'); }

const LABEL = { single:'单张', pair:'对子', triple:'三张', triple1:'三带一', triple2:'三带二',
  straight:'顺子', pairseq:'连对', plane:'飞机', plane1:'飞机带单', plane2:'飞机带对',
  quad2:'四带二', bomb:'炸弹', rocket:'王炸' };

export { parse, canBeat, isBomb, LABEL };
