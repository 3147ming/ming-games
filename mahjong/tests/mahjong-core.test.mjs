/**
 * 麻将核心单测（第三批任务块 J）
 * 胡牌判定 ≥10 例，含七对 / 清一色 / 碰碰胡 / 诈胡拦截；136 张计数；4 AI 20 局自对弈。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WALL, tileCountCheck, canWin, isStandardWin, isSevenPairs, waitingTiles,
  decompose, scoreHand, payout, settle, createMatch, drawTile, discard,
  claimOptions, resolveClaim, passClaim, selfDrawWin, declareKong,
  discardAdvice, aiStep, selfPlay, counts, tileName,
} from '../src/mahjong-core.mjs';

const M123456789_123_55 = [0,1,2,3,4,5,6,7,8,9,10,11,13,13];
const SEVEN_PAIRS = [0,0,1,1,2,2,3,3,4,4,5,5,6,6];
const QINGYISE = [0,1,2,3,4,5,6,7,8,0,0,0,8,8];
const PENGPENG = [0,0,0,2,2,2,4,4,4,15,15,15,19,19];

/* ---------- 136 张计数 ---------- */
test('牌墙 136 张，34 种各 4 张，无花牌', () => {
  const c = tileCountCheck();
  assert.equal(c.total, 136);
  assert.equal(c.perTile, true);
  assert.equal(c.honors, 7);
  assert.equal(WALL.filter((t) => t >= 34).length, 0);
  assert.equal(tileName(0), '一万');
  assert.equal(tileName(9), '一条');
  assert.equal(tileName(18), '一筒');
  assert.equal(tileName(31), '中');
});

/* ---------- 胡牌判定（10+ 例） ---------- */
test('胡01：四顺一将（标准胡）成立', () => {
  assert.equal(isStandardWin(M123456789_123_55), true);
  assert.equal(canWin(M123456789_123_55), true);
});
test('胡02：七对成立', () => {
  assert.equal(isSevenPairs(SEVEN_PAIRS), true);
  assert.equal(canWin(SEVEN_PAIRS), true);
  // 七对牌型也可能同时满足四顺一将，展示时以七对优先
  assert.equal(scoreHand(SEVEN_PAIRS, 0, {}).fans.some((f) => f.key === 'qidui'), true);
});
test('胡03：清一色成立', () => {
  assert.equal(canWin(QINGYISE), true);
  const s = scoreHand(QINGYISE, 0, { selfDraw: true, melds: [] });
  assert.ok(s.fans.some((f) => f.key === 'qingyise'));
});
test('胡04：碰碰胡成立', () => {
  assert.equal(canWin(PENGPENG), true);
  const s = scoreHand(PENGPENG, 0, { selfDraw: false, melds: [] });
  assert.ok(s.fans.some((f) => f.key === 'pengpenghu'));
});
test('胡05：诈胡拦截 —— 乱牌不成立', () => {
  assert.equal(canWin([0,0,1,1,2,2,3,3,4,4,5,5,6,8]), false);
  assert.equal(canWin([0,1,2,3,4,5,6,7,8,9,10,11,13,14]), false);
  assert.equal(scoreHand([0,1,2], 0, {}).ok, false);
});
test('胡06：十三张不能胡，十四张才成立', () => {
  assert.equal(canWin(M123456789_123_55.slice(0, 13)), false);
  assert.equal(canWin(M123456789_123_55), true);
});
test('胡07：同一张超过 4 张视为不可能牌型（单张数组仍按实际张数判）', () => {
  assert.equal(canWin([0,0,0,0,0,1,2,3,4,5,6,7,8,9]), false);
});
test('胡08：带副露时按剩余面子数判定', () => {
  const hand = [0,1,2,3,4,5,9,9]; // 2 面子 + 1 将
  assert.equal(canWin(hand, 2), true);
  assert.equal(canWin(hand, 1), false);
});
test('胡09：字牌不能组成顺子', () => {
  assert.equal(isStandardWin([27,28,29,0,1,2,3,4,5,9,9,9,12,12]), false);
});
test('胡10：七对不允许副露', () => {
  assert.equal(isSevenPairs(SEVEN_PAIRS, 1), false);
});
test('胡11：分解结果给出将与面子', () => {
  const d = decompose(M123456789_123_55, 0);
  assert.equal(d.pair, 13);
  assert.equal(d.melds.length, 4);
  assert.ok(d.melds.every((m) => m.kind === 'sequence' || m.kind === 'triplet'));
});
test('胡12：听牌计算', () => {
  const waits = waitingTiles(M123456789_123_55.slice(0, 13), 0);
  assert.ok(waits.includes(13), '听条五');
});

/* ---------- 番型与结算 ---------- */
test('番型封顶 8，自摸三家付 / 点炮一家付', () => {
  const s = scoreHand(QINGYISE, 0, { selfDraw: true, melds: [] });
  assert.ok(s.total <= 8);
  assert.equal(s.fans.some((f) => f.key === 'zimo'), true);
  const zimo = settle(0, { total: 4, selfDraw: true }, 1);
  assert.deepEqual(zimo.deltas, [12, -4, -4, -4]);
  const dianpao = settle(0, { total: 2, selfDraw: false, from: 2 }, 1);
  assert.deepEqual(dianpao.deltas, [2, 0, -2, 0]);
  assert.equal(payout(8), 8);
});

/* ---------- 碰杠胡状态机 ---------- */
function seeded() { let x = 12345; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; }; }

test('发牌 136 张扣除：四家 13 张 + 庄家 1 张，牌墙剩 83', () => {
  const m = createMatch(seeded());
  assert.equal(m.wall.length, 83);
  assert.deepEqual(m.hands.map((h) => h.length), [14, 13, 13, 13]);
  assert.equal(new Set([...m.hands.flat(), ...m.wall]).size, 34);
});

test('点炮可胡、碰、杠；过牌后轮到下家摸牌', () => {
  const m = createMatch(seeded());
  m.hands[1] = [0,0,1,2,3,4,5,6,7,8,9,10,11];
  m.phase = 'claim';
  m.claim = { from: 0, tile: 0, options: [{ seat: 1, options: ['pung', 'win'] }] };
  const o = claimOptions(m, 1, 0);
  assert.ok(o.includes('pung') && o.includes('win'));
  const r = resolveClaim(m, 1, 'win');
  assert.equal(r.ok, true);
  assert.equal(m.result.type, 'win');
  assert.equal(m.result.from, 0);

  const n = createMatch(seeded());
  n.hands[1] = [0,0,1,2,3,4,5,6,7,8,9,10,11];
  n.phase = 'claim'; n.claim = { from: 0, tile: 0, options: [{ seat: 1, options: ['pung'] }] };
  assert.equal(resolveClaim(n, 1, 'pung').ok, true);
  assert.equal(n.melds[1][0].kind, 'pung');
  assert.equal(n.turn, 1);

  const p = createMatch(seeded());
  p.phase = 'claim'; p.claim = { from: 0, tile: 5, options: [] };
  assert.equal(passClaim(p).ok, true);
  assert.equal(p.turn, 1);
});

test('暗杠消耗 4 张并补岭上牌', () => {
  const m = createMatch(seeded());
  m.hands[2] = [3,3,3,3,4,5,6,7,8,9,10,11,12];
  const before = m.wall.length;
  assert.equal(declareKong(m, 2, 3, true).ok, true);
  assert.equal(m.melds[2][0].hidden, true);
  assert.equal(m.wall.length, before - 1);
  assert.equal(m.hands[2].length, 10, '暗杠后手牌减少 3 张，再补岭上牌 1 张');
});

test('自摸胡需真成牌，诈胡被拦截', () => {
  const m = createMatch(seeded());
  m.turn = 0; m.phase = 'discard';
  m.hands[0] = M123456789_123_55.slice();
  const r = selfDrawWin(m, 0);
  assert.equal(r.ok, true);
  assert.equal(m.result.selfDraw, true);
  const n = createMatch(seeded());
  n.turn = 0; n.phase = 'discard'; n.hands[0] = [0,1,3,5,7,9,11,13,15,17,19,21,23,25];
  assert.equal(selfDrawWin(n, 0).ok, false);
});

test('舍牌建议优先现物，不做纯随机', () => {
  const m = createMatch(seeded());
  m.discards[1] = [7];
  m.hands[0] = [7,7,1,2,9,10,11,18,19,20,27,28,31];
  const a = discardAdvice(m, 0);
  assert.equal(a.tile, 7, '对手已打过的现物优先打出');
  assert.ok(a.ranked.length === 13);
});

/* ---------- 自对弈 ---------- */
test('4 AI 自对弈 20 局零异常，每局都能结束', () => {
  const results = [];
  for (let i = 0; i < 20; i++) {
    const r = selfPlay(seeded());
    assert.ok(r.result, `第 ${i + 1} 局无结果`);
    assert.ok(['win', 'draw-game'].includes(r.result.type));
    assert.ok(r.steps > 0 && r.guard < 2000);
    results.push(r);
  }
  assert.equal(results.length, 20);
  assert.ok(results.every((r) => r.discardTotal > 0));
});
