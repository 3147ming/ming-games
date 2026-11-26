/* shared/poker.test.mjs — 扑克牌桌底座的纯逻辑自测
 *
 * mount() 需要 DOM，这里不做假 DOM，只用最小 stub 覆盖结构性约束：
 *   1) faceOf / cardName 对三种花色表示（数字索引、Unicode 字符、大小王）都给出正确牌名
 *   2) sortCards 的点数与花色次序符合 斗地主/510K 的惯例
 *   3) 四款游戏实际用到的牌堆（54 张含王 / 52 张 / 三张牌的 52 张）张数与去重
 *   4) mount 在没有 document 的环境下抛出可诊断的错误（说明它是浏览器侧模块，不能被 node 误用）
 */
import assert from 'node:assert/strict';
import { faceOf, cardName, sortCards, mount } from './poker.js';

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };

console.log('poker.js 纯逻辑：');

t('faceOf 数字花色索引', () => {
  assert.deepEqual(faceOf({ r: 'A', s: 0, v: 14 }), { rank: 'A', suit: '♠', red: false, joker: '' });
  assert.deepEqual(faceOf({ r: 'K', s: 1, v: 13 }), { rank: 'K', suit: '♥', red: true, joker: '' });
  assert.deepEqual(faceOf({ r: '7', s: 3, v: 7 }), { rank: '7', suit: '♣', red: false, joker: '' });
});

t('faceOf Unicode 花色字符', () => {
  assert.equal(faceOf({ r: '10', s: '♦', v: 10 }).red, true);
  assert.equal(faceOf({ r: '10', s: '♠', v: 10 }).red, false);
  assert.equal(faceOf({ r: '10', s: '♦', v: 10 }).suit, '♦');
});

t('faceOf 大小王', () => {
  const big = faceOf({ r: 'BJ', s: '', v: 17 });
  const small = faceOf({ r: 'wj', s: '', v: 16 });
  assert.deepEqual([big.rank, big.joker, big.red], ['大', 'big', true]);
  assert.deepEqual([small.rank, small.joker, small.red], ['小', 'small', false]);
});

t('cardName 中文牌名', () => {
  assert.equal(cardName({ r: 'Q', s: '♠', v: 12 }), '黑桃Q');
  assert.equal(cardName({ r: '9', s: 2, v: 9 }), '方块9');
  assert.equal(cardName({ r: 'BJ', s: '', v: 17 }), '大王');
  assert.equal(cardName({ r: 'wj', s: '', v: 16 }), '小王');
  assert.equal(cardName(null), '');
});

t('sortCards 点数降序、同点按 ♠♥♦♣', () => {
  const h = [
    { r: '3', s: '♣', v: 3 }, { r: 'A', s: '♦', v: 14 },
    { r: 'A', s: '♠', v: 14 }, { r: '5', s: '♥', v: 5 }
  ];
  const got = sortCards(h).map((c) => c.s + c.r);
  assert.deepEqual(got, ['♠A', '♦A', '♥5', '♣3']);
});

t('54 张牌堆（斗地主）唯一且含双王', () => {
  const d = [];
  ['♠', '♥', '♦', '♣'].forEach((s) => ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'].forEach((r) => d.push({ r, s })));
  d.push({ r: 'wj', s: '' }, { r: 'BJ', s: '' });
  assert.equal(d.length, 54);
  assert.equal(new Set(d.map(cardName)).size, 54);
});

t('52 张牌堆（510K / 同心 / 三张牌）唯一', () => {
  const d = [];
  for (let s = 0; s < 4; s++) for (let r = 0; r < 13; r++) d.push({ s, r, v: r });
  assert.equal(d.length, 52);
  assert.equal(new Set(d.map(cardName)).size, 52);
  assert.equal(d.filter((c) => cardName(c).startsWith('黑桃')).length, 13);
});

t('mount 在无 DOM 环境明确失败', () => {
  assert.throws(() => mount({}, {}), /document|classList|Cannot read/i);
});

console.log(`\npoker.js：${pass} 项通过`);
