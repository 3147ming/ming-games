/**
 * 五子棋 · 规则引擎单测
 * 覆盖：落子合法性、五连判定、禁手、AI、重放一致性、状态摘要。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SIZE, EMPTY, BLACK, WHITE,
  emptyBoard, inBounds, idx, place, checkWin, checkForbidden,
  aiMove, hashBoard, replay, evaluate,
} from '../src/rules.mjs';

/* ---------- 基础 ---------- */
test('棋盘是 15×15 且初始为空', () => {
  const b = emptyBoard();
  assert.equal(b.length, SIZE * SIZE);
  assert.equal(SIZE, 15);
  assert.ok([...b].every((v) => v === EMPTY));
});

test('越界判定', () => {
  assert.equal(inBounds(0, 0), true);
  assert.equal(inBounds(14, 14), true);
  assert.equal(inBounds(-1, 0), false);
  assert.equal(inBounds(0, 15), false);
  assert.equal(inBounds(1.5, 2), false);
  assert.equal(inBounds(NaN, 0), false);
});

/* ---------- 落子 ---------- */
test('落子成功返回新棋盘且不改动原盘', () => {
  const b = emptyBoard();
  const r = place(b, 7, 7, BLACK);
  assert.equal(r.ok, true);
  assert.equal(r.board[idx(7, 7)], BLACK);
  assert.equal(b[idx(7, 7)], EMPTY, '原棋盘不应被修改');
});

test('同一格不能连落两子', () => {
  const b = place(emptyBoard(), 3, 3, BLACK).board;
  const r = place(b, 3, 3, WHITE);
  assert.equal(r.ok, false);
  assert.ok(r.reason.length > 0, '要给出原因');
});

test('越界落子被拒', () => {
  const r = place(emptyBoard(), 99, 0, BLACK);
  assert.equal(r.ok, false);
});

/* ---------- 五连判定 ---------- */
test('横向五连即胜', () => {
  let b = emptyBoard();
  for (let i = 0; i < 4; i++) b = place(b, 3 + i, 5, BLACK).board;
  const r = place(b, 7, 5, BLACK);
  assert.equal(r.winner, BLACK);
  assert.equal(r.line.length, 5);
});

test('纵向五连即胜', () => {
  let b = emptyBoard();
  for (let i = 0; i < 4; i++) b = place(b, 2, 2 + i, WHITE).board;
  const r = place(b, 2, 6, WHITE);
  assert.equal(r.winner, WHITE);
});

test('斜向五连即胜', () => {
  let b = emptyBoard();
  for (let i = 0; i < 4; i++) b = place(b, i, i, BLACK).board;
  const r = place(b, 4, 4, BLACK);
  assert.equal(r.winner, BLACK);
  assert.equal(r.line.length, 5);
});

test('反斜向五连即胜', () => {
  let b = emptyBoard();
  for (let i = 0; i < 4; i++) b = place(b, 10 - i, i, BLACK).board;
  const r = place(b, 6, 4, BLACK);
  assert.equal(r.winner, BLACK);
});

test('四连不算赢', () => {
  let b = emptyBoard();
  for (let i = 0; i < 3; i++) b = place(b, 3 + i, 5, BLACK).board;
  const r = place(b, 6, 5, BLACK);
  assert.equal(r.winner, EMPTY, '只有四子');
});

test('被对方棋子隔断不算连珠', () => {
  let b = emptyBoard();
  b = place(b, 0, 0, BLACK).board;
  b = place(b, 1, 0, WHITE).board;      /* 白子把黑子隔成两段 */
  b = place(b, 2, 0, BLACK).board;
  b = place(b, 3, 0, BLACK).board;
  b = place(b, 4, 0, BLACK).board;
  /* 此时黑子只有 2,3,4 三连（0 被白子隔开），再落一手也只到四连 */
  const r = place(b, 5, 0, BLACK);
  assert.equal(r.winner, EMPTY, '中间夹着白子，断开了');
});

/* ---------- 禁手 ---------- */
test('禁手默认对白棋不生效', () => {
  let b = emptyBoard();
  for (let i = 0; i < 4; i++) b = place(b, 5 + i, 5, WHITE).board;   /* 四连，未成五 */
  const r = place(b, 9, 5, WHITE);
  assert.equal(r.winner, WHITE, '五连就是赢，禁手只针对黑棋');
});

test('长连（黑棋六子）被判禁手', () => {
  let b = emptyBoard();
  b = place(b, 3, 7, BLACK).board;
  b = place(b, 4, 7, BLACK).board;
  b = place(b, 5, 7, BLACK).board;
  b = place(b, 7, 7, BLACK).board;
  b = place(b, 8, 7, BLACK).board;
  const bad = checkForbidden(b, 6, 7);
  assert.ok(bad.includes('长连'), '应判长连: ' + JSON.stringify(bad));
});

/* ---------- AI ---------- */
test('AI 能立即取胜', () => {
  let b = emptyBoard();
  b = place(b, 0, 0, BLACK).board;
  b = place(b, 1, 0, BLACK).board;
  b = place(b, 2, 0, BLACK).board;
  b = place(b, 3, 0, BLACK).board;
  const mv = aiMove(b, BLACK, 1);
  assert.equal(mv.x, 4);
  assert.equal(mv.y, 0);
});

test('AI 会挡住对手的活三', () => {
  let b = emptyBoard();
  b = place(b, 0, 0, WHITE).board;
  b = place(b, 1, 0, WHITE).board;
  b = place(b, 2, 0, WHITE).board;
  const mv = aiMove(b, BLACK, 1);
  assert.equal(mv.y, 0, '应该落在同一行上');
  assert.ok(mv.x >= 0 && mv.x <= 4);
});

test('AI 在空盘上落在中心附近', () => {
  const mv = aiMove(emptyBoard(), BLACK, 1);
  assert.ok(Math.abs(mv.x - 7) <= 2 && Math.abs(mv.y - 7) <= 2, JSON.stringify(mv));
});

/* ---------- 重放一致性（联机房主权威的基础） ---------- */
test('同一动作序列重放出同一棋盘', () => {
  const actions = [
    { x: 7, y: 7, stone: BLACK },
    { x: 7, y: 8, stone: WHITE },
    { x: 8, y: 7, stone: BLACK },
  ];
  const a = replay(actions);
  const b = replay(actions);
  assert.equal(hashBoard(a.board), hashBoard(b.board));
  assert.equal(a.winner, EMPTY);
  assert.equal(a.board[idx(7, 7)], BLACK);
});

test('重放到五连时给出胜者', () => {
  const actions = [
    { x: 0, y: 0, stone: BLACK },
    { x: 0, y: 1, stone: WHITE },
    { x: 1, y: 0, stone: BLACK },
    { x: 1, y: 1, stone: WHITE },
    { x: 2, y: 0, stone: BLACK },
    { x: 2, y: 1, stone: WHITE },
    { x: 3, y: 0, stone: BLACK },
    { x: 3, y: 1, stone: WHITE },
    { x: 4, y: 0, stone: BLACK },
  ];
  const r = replay(actions);
  assert.equal(r.winner, BLACK);
});

test('重放遇到非法动作就停下，不抛错', () => {
  const actions = [
    { x: 0, y: 0, stone: BLACK },
    { x: 0, y: 0, stone: WHITE },   /* 同一格，非法 */
    { x: 1, y: 0, stone: WHITE },
  ];
  const r = replay(actions);
  assert.equal(r.board[idx(0, 0)], BLACK);
  assert.equal(r.board[idx(1, 0)], EMPTY, '非法动作之后不该继续');
});

/* ---------- 状态摘要 ---------- */
test('不同棋盘摘要不同，相同棋盘摘要相同', () => {
  const a = emptyBoard();
  const b = place(a, 1, 1, BLACK).board;
  assert.notEqual(hashBoard(a), hashBoard(b));
  assert.equal(hashBoard(b), hashBoard(b));
});

/* ---------- 终局判定 ---------- */
test('evaluate 能找出五连', () => {
  let b = emptyBoard();
  for (let i = 0; i < 5; i++) b = place(b, 2 + i, 9, WHITE).board;
  const r = evaluate(b);
  assert.equal(r.over, true);
  assert.equal(r.winner, WHITE);
});

test('evaluate 在未终局时返回 over=false', () => {
  const r = evaluate(emptyBoard());
  assert.equal(r.over, false);
  assert.equal(r.winner, EMPTY);
});
