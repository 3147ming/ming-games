/**
 * 龙凤棋 · 龙棋 规则单测（第三批任务块 I）
 * 重点覆盖指令第 2/3/4/7/8 条，每条 ≥2 用例。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  POINTS, EDGES, DRAGON_LINES, createGame, clone, place, move, capture,
  dragonsNow, captureChoices, isDragonPiece, legalMoves, allMoves, cannonMoves,
  isSkyMode, checkEnd, undo, aiDecision, aiPlay, selfPlay, countPieces,
} from '../src/rules.mjs';

/* ---------- 拓扑 ---------- */
test('24 点 / 40 连线 / 龙线组无重复且不含斜线', () => {
  assert.equal(POINTS.length, 24);
  assert.equal(new Set(POINTS.map((p) => p.id)).size, 24);
  assert.equal(EDGES.length, 40);
  assert.equal(new Set(DRAGON_LINES.map((l) => l.key)).size, DRAGON_LINES.length);
  const diag = DRAGON_LINES.find((l) =>
    l.ids.includes('outer-tl') && l.ids.includes('mid-tl') && l.ids.includes('inner-tl'));
  assert.equal(diag, undefined, '斜线不构成龙线');
});

/* ---------- 第 2 条：成龙 ---------- */
test('第2条①：同一横线三子成一龙', () => {
  const s = createGame();
  s.board['outer-tl'] = 'r'; s.board['outer-tm'] = 'r'; s.board['mid-tr'] = 'r';
  assert.equal(dragonsNow(s, 'r').length, 0);
  s.board['outer-tr'] = 'r';
  const ds = dragonsNow(s, 'r');
  assert.equal(ds.length, 1);
  assert.deepEqual(ds[0].ids.slice(), ['outer-tl', 'outer-tm', 'outer-tr']);
});

test('第2条②：同一竖线三子成一龙，斜线三子不成龙', () => {
  const s = createGame();
  s.board['outer-tl'] = 'b'; s.board['outer-ml'] = 'b'; s.board['outer-bl'] = 'b';
  assert.equal(dragonsNow(s, 'b').length, 1);
  const t = createGame();
  t.board['outer-tl'] = 'r'; t.board['mid-tl'] = 'r'; t.board['inner-tl'] = 'r';
  assert.equal(dragonsNow(t, 'r').length, 0, '斜线只走不吃，不成龙');
});

/* ---------- 第 3 条：成龙吃子，不能吃已成龙的子 ---------- */
test('第3条①：成龙后可吃对方任意非成龙子', () => {
  const s = createGame();
  s.board['outer-tl'] = 'r'; s.board['outer-tm'] = 'r'; s.board['outer-tr'] = 'r';
  s.board['inner-bl'] = 'b';
  s.pendingCapture = { owner: 'r', reason: 'dragon', choices: captureChoices(s, 'r') };
  assert.deepEqual(s.pendingCapture.choices, ['inner-bl']);
  const r = capture(s, 'inner-bl');
  assert.equal(r.ok, true);
  assert.equal(s.board['inner-bl'], undefined);
  assert.equal(s.winner, 'r', '吃光对方即胜');
});

test('第3条②：对方已成龙的子受保护', () => {
  const s = createGame();
  s.board['outer-tl'] = 'r'; s.board['outer-tm'] = 'r'; s.board['outer-tr'] = 'r';
  s.board['outer-bl'] = 'b'; s.board['outer-bm'] = 'b'; s.board['outer-br'] = 'b';
  assert.equal(isDragonPiece(s, 'outer-bm'), true);
  s.pendingCapture = { owner: 'r', reason: 'dragon', choices: captureChoices(s, 'r') };
  const r = capture(s, 'outer-bm');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'dragon-protected');
  assert.ok(!s.pendingCapture.choices.includes('outer-bm'));
});

/* ---------- 第 4 条：始龙只成一次 ---------- */
test('第4条①：同一组合登记后不再触发成龙吃子', () => {
  const s = createGame();
  s.board['outer-tl'] = 'r'; s.board['outer-tm'] = 'r';
  const line = DRAGON_LINES.find((l) =>
    l.ids.includes('outer-tl') && l.ids.includes('outer-tm') && l.ids.includes('outer-tr'));
  s.dragons = [`r:${line.key}`];
  s.board['inner-bl'] = 'b';
  const r = place(s, 'outer-tr');
  assert.equal(r.dragons.length, 0, '已登记的始龙不重复');
  assert.equal(r.needCapture, false);
});

test('第4条②：未登记的另一组合仍可成龙', () => {
  const s = createGame();
  s.board['outer-tl'] = 'r'; s.board['outer-tm'] = 'r';
  const first = DRAGON_LINES.find((l) =>
    l.ids.includes('outer-tl') && l.ids.includes('outer-tm') && l.ids.includes('outer-tr'));
  s.dragons = [`r:${first.key}`];
  s.board['mid-tl'] = 'r'; s.board['mid-tm'] = 'r';
  s.board['inner-bl'] = 'b';
  const r = place(s, 'mid-tr');
  assert.equal(r.dragons.length, 1);
  assert.equal(r.needCapture, true);
});

/* ---------- 第 5/6 条：走子与满天飞 ---------- */
test('第5条：每步沿连线走一格到空点，不能跳格', () => {
  const s = createGame();
  s.phase = 'move';
  s.board['outer-tl'] = 'r';
  s.board['inner-tm'] = 'b'; s.board['inner-tr'] = 'b'; s.board['mid-bl'] = 'b';
  s.board['mid-tm'] = 'b'; s.board['inner-bm'] = 'b';
  const ms = legalMoves(s, 'outer-tl');
  const tos = ms.map((m) => m.to);
  assert.ok(tos.includes('outer-tm'), '可走到相邻空点');
  assert.ok(!tos.includes('inner-tl'), '不能沿径向跳两格');
  assert.equal(move(s, 'outer-tl', 'inner-tl').ok, false);
});

test('第6条：盘面只剩 3 子进入满天飞，任意空点可落', () => {
  const s = createGame();
  s.phase = 'move'; s.turn = 'r';
  s.board['outer-tl'] = 'r'; s.board['inner-tm'] = 'b'; s.board['inner-tr'] = 'b';
  assert.equal(isSkyMode(s), true);
  const ms = legalMoves(s, 'outer-tl');
  assert.ok(ms.length > 10);
  assert.ok(ms.some((m) => m.sky && m.to === 'outer-br'));
});

/* ---------- 第 7 条：打炮 ---------- */
test('第7条①：对方在直线一端、己方一子居中且等距时可打炮吃子', () => {
  const s = createGame();
  s.phase = 'move'; s.turn = 'r';
  s.board['outer-tm'] = 'b';   // (0,3) 对方
  s.board['inner-tm'] = 'r';   // (0,1) 己方居中
  s.board['outer-tl'] = 'r';   // 另一己方子从别处飞来
  const ms = cannonMoves(s, 'r');
  assert.ok(ms.some((m) => m.to === 'inner-bm' && m.eaten === 'outer-tm'));
  const r = move(s, 'outer-tl', 'inner-bm');
  assert.equal(r.ok, true);
  assert.equal(r.move.cannon, true);
  assert.equal(s.board['outer-tm'], undefined, '对方该子被吃掉');
  assert.equal(s.board['inner-bm'], 'r');
});

test('第7条②：目标为对方已成龙的子时不能打炮', () => {
  const s = createGame();
  s.phase = 'move'; s.turn = 'r';
  s.board['outer-tm'] = 'b'; s.board['inner-tm'] = 'r'; s.board['outer-tl'] = 'r';
  s.board['outer-tl'] = 'b'; s.board['outer-tr'] = 'b'; // 蓝方 y=3 已成龙
  const ms = cannonMoves(s, 'r');
  assert.equal(ms.length, 0);
});

/* ---------- 第 8 条：胜负 ---------- */
test('第8条①：吃光对方 / 无合法走法判负', () => {
  const a = createGame();
  a.phase = 'move';
  a.board['outer-tl'] = 'r'; a.board['inner-tm'] = 'b';
  a.turn = 'r';
  a.pendingCapture = { owner: 'r', reason: 'dragon', choices: ['inner-tm'] };
  capture(a, 'inner-tm');
  assert.equal(a.winner, 'r');
  assert.equal(a.endReason, 'eliminate');

  const s = createGame();
  s.phase = 'move'; s.turn = 'r';
  s.board['outer-tl'] = 'r';
  s.board['outer-tm'] = 'b'; s.board['outer-ml'] = 'b'; s.board['mid-tl'] = 'b'; s.board['inner-tl'] = 'b';
  assert.equal(allMoves(s, 'r').length, 0);
  checkEnd(s);
  assert.equal(s.winner, 'b');
  assert.equal(s.endReason, 'immobile');
});

test('第8条②：60 回合无吃子判和；吃子重置计数', () => {
  const s = createGame();
  s.phase = 'move'; s.turn = 'b'; s.noCapture = 59;
  s.board['outer-tl'] = 'r'; s.board['inner-tm'] = 'b';
  s.board['inner-tr'] = 'b'; s.board['mid-bl'] = 'b'; s.board['mid-tr'] = 'b';
  const r = move(s, 'inner-tm', 'mid-tm');
  assert.equal(r.ok, true);
  assert.equal(s.noCapture, 60);
  assert.equal(s.winner, 'draw');
  assert.equal(s.endReason, 'no-capture');

  const t = createGame();
  t.noCapture = 55;
  t.pendingCapture = { owner: 'r', reason: 'dragon', choices: ['inner-bl'] };
  t.board['inner-bl'] = 'b'; t.board['outer-tl'] = 'r';
  capture(t, 'inner-bl');
  assert.equal(t.noCapture, 0);
});

/* ---------- AI / 悔棋 / 自对弈 ---------- */
test('AI 会堵对方成龙点，也会算自己成龙点', () => {
  const s = createGame();
  s.board['outer-tl'] = 'b'; s.board['outer-tm'] = 'b';
  s.board['inner-tm'] = 'r'; s.board['inner-tr'] = 'r';
  s.turn = 'r';
  const d = aiDecision(s, 'hard', () => 0);
  assert.equal(d.kind, 'place');
  assert.equal(d.id, 'outer-tr', '硬 AI 优先堵蓝方成龙点');
  const t = createGame();
  t.board['outer-tl'] = 'r'; t.board['outer-tm'] = 'r';
  t.board['inner-tm'] = 'b';
  t.turn = 'r';
  assert.equal(aiDecision(t, 'easy', () => 0).id, 'outer-tr', '简单 AI 优先自己成龙');
});

test('悔棋恢复落子前盘面与回合', () => {
  const s = createGame();
  place(s, 'outer-tl');
  assert.equal(s.board['outer-tl'], 'r');
  assert.equal(undo(s), true);
  assert.equal(s.board['outer-tl'], undefined);
  assert.equal(s.turn, 'r');
});

test('自对弈 20 局零异常，均能终局', () => {
  const results = [];
  for (let seed = 1; seed <= 20; seed++) {
    const r = selfPlay('easy', 'hard', seed);
    assert.ok(r.winner, `第 ${seed} 局无胜者`);
    assert.ok(r.steps > 0 && r.guard < 600, `第 ${seed} 局步数异常`);
    results.push(r);
  }
  assert.equal(results.length, 20);
});
