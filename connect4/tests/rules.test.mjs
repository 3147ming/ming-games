/* 四子棋规则引擎单测：node --test connect4/tests/rules.test.mjs */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COLS, ROWS, EMPTY, RED, BLACK, CONNECT,
  emptyBoard, idx, inBounds, canDrop, dropRow, place, checkWin,
  countFilled, aiMove, hashBoard, replay, evaluate,
} from '../src/rules.mjs';

/* 造一个盘：rows 数组从最上面一行到最下面一行，每行是长度 7 的数组。
   用 0 表示空格，1 红，2 黑。 */
function boardFrom(rows) {
  const b = emptyBoard();
  rows.forEach((row, y) => {
    row.forEach((v, x) => { b[idx(x, y)] = v; });
  });
  return b;
}

test('棋盘尺寸：7 列 6 行，共 42 格', () => {
  assert.equal(COLS, 7);
  assert.equal(ROWS, 6);
  assert.equal(CONNECT, 4);
  assert.equal(emptyBoard().length, 42);
});

test('坐标换算与越界判断', () => {
  assert.equal(idx(0, 0), 0);
  assert.equal(idx(6, 5), 41);
  assert.ok(inBounds(0, 0));
  assert.ok(inBounds(6, 5));
  assert.ok(!inBounds(7, 0));
  assert.ok(!inBounds(0, 6));
  assert.ok(!inBounds(-1, 0));
  assert.ok(!inBounds(1.5, 2));
});

test('重力下落：空列落到最底行', () => {
  const b = emptyBoard();
  assert.equal(dropRow(b, 3), 5);
  assert.ok(canDrop(b, 3));
});

test('重力下落：已有棋子时落到上面一格', () => {
  /* 第 3 列底部已有 1 颗，再落应到第 4 行（0-based，y=5 是最底行）。 */
  const b = boardFrom([
    [0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 1, 0, 0, 0],
  ]);
  assert.equal(dropRow(b, 3), 4);
  assert.ok(canDrop(b, 3), '列没满就应该还能落');
});

test('重力下落：列满后不能落子', () => {
  const rows = [];
  for (let y = 0; y < ROWS; y++) rows.push([0, 0, 0, 1, 0, 0, 0]);
  const b = boardFrom(rows);
  assert.equal(dropRow(b, 3), -1);
  assert.ok(!canDrop(b, 3));
  assert.ok(canDrop(b, 2));
});

test('落子成功：棋子落到列底，棋盘不变（不改传入的 board）', () => {
  const b = emptyBoard();
  const r = place(b, 2, RED);
  assert.ok(r.ok);
  assert.equal(r.x, 2);
  assert.equal(r.y, 5);
  assert.equal(r.board[idx(2, 5)], RED);
  assert.equal(b[idx(2, 5)], EMPTY, '传入的 board 不该被修改');
});

test('落子失败：列已满', () => {
  const rows = [];
  for (let y = 0; y < ROWS; y++) rows.push([0, 0, 0, 1, 0, 0, 0]);
  const b = boardFrom(rows);
  const r = place(b, 3, RED);
  assert.ok(!r.ok);
  assert.match(r.reason, /满/);
});

test('落子失败：列越界', () => {
  const r = place(emptyBoard(), 9, RED);
  assert.ok(!r.ok);
  assert.match(r.reason, /超出/);
});

test('落子失败：颜色非法', () => {
  const r = place(emptyBoard(), 0, 7);
  assert.ok(!r.ok);
});

test('横向连成 4 即胜', () => {
  const b = boardFrom([
    [0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0],
    [1, 1, 1, 0, 0, 0, 0],
  ]);
  const r = place(b, 3, RED);
  assert.ok(r.ok);
  assert.equal(r.winner, RED);
  assert.equal(r.line.length, 4);
});

test('纵向连成 4 即胜', () => {
  /* 第 0 列底部已有 3 颗红（y=3,4,5），再落 1 颗到 y=2 即成竖向四连。
     注意竖盘是重力下落，棋子只能落在该列最下面的空格 —— 所以支撑子必须垫在下面。 */
  const b = boardFrom([
    [0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0],
    [1, 0, 0, 0, 0, 0, 0],
    [1, 0, 0, 0, 0, 0, 0],
    [1, 0, 0, 0, 0, 0, 0],
  ]);
  const r = place(b, 0, RED);
  assert.ok(r.ok);
  assert.equal(r.y, 2, '第 4 颗应落在 y=2');
  assert.equal(r.winner, RED);
});

test('斜向连成 4 即胜（右下方向）', () => {
  const b = boardFrom([
    [0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0],
    [1, 0, 0, 0, 0, 0, 0],
    [0, 1, 0, 0, 0, 0, 0],
    [0, 0, 1, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0],
  ]);
  const r = place(b, 3, RED);
  assert.ok(r.ok);
  assert.equal(r.winner, RED);
});

test('斜向连成 4 即胜（左下方向）', () => {
  /* 已在 (4,1)(3,2)(2,3) 摆好 3 颗红，第 1 列底部有支撑，
     再往第 1 列落 1 颗到 (1,4) 即成左下斜向四连。
     盘面由脚本生成并校验：重力合法、落子前无人连四、落子后红方仅此一条四连（纯斜向）。 */
  const b = boardFrom([
    [0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 1, 0, 0],
    [0, 0, 0, 1, 2, 0, 0],
    [0, 0, 1, 1, 2, 0, 0],
    [0, 0, 2, 2, 1, 0, 0],
    [0, 1, 2, 2, 1, 0, 0],
  ]);
  const r = place(b, 1, RED);
  assert.ok(r.ok);
  assert.equal(r.y, 4);
  assert.equal(r.winner, RED);
  /* 连珠线必须正好是那 4 颗，且是斜的 */
  assert.equal(r.line.length, 4);
  const s = r.line.map(([x, y]) => x + ',' + y).sort().join(' ');
  assert.equal(s, '1,4 2,3 3,2 4,1');
});

test('连 3 子不算赢', () => {
  const b = boardFrom([
    [0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0],
    [1, 1, 1, 0, 0, 0, 0],
  ]);
  const r = place(b, 5, BLACK);
  assert.ok(r.ok);
  assert.equal(r.winner, EMPTY);
});

test('棋盘落满为和棋', () => {
  /* 这是一张「落满但没人连成 4」的盘（脚本随机搜索得到并校验过：
     重力合法、横竖斜均无四连）。第 0 列顶部空着，
     往里补最后一颗即满盘 → 和棋。 */
  const b = boardFrom([
    [0, 2, 2, 1, 1, 2, 1],
    [2, 1, 1, 2, 2, 1, 2],
    [1, 2, 2, 1, 1, 1, 2],
    [1, 1, 1, 2, 2, 2, 1],
    [2, 2, 2, 1, 1, 2, 1],
    [1, 2, 2, 2, 1, 2, 1],
  ]);
  /* 落子前先确认这张盘确实没有四连 */
  assert.equal(evaluate(b).winner, EMPTY, '测试用的满盘不该有人获胜');
  assert.equal(countFilled(b), COLS * ROWS - 1);
  const r = place(b, 0, RED);
  assert.ok(r.ok);
  assert.equal(r.y, 0);
  assert.equal(r.winner, EMPTY);
  assert.equal(r.draw, true);
  assert.equal(countFilled(r.board), COLS * ROWS);
});

test('countFilled 统计已落子数', () => {
  const b = emptyBoard();
  assert.equal(countFilled(b), 0);
  b[idx(0, 5)] = RED;
  b[idx(1, 5)] = BLACK;
  assert.equal(countFilled(b), 2);
});

test('checkWin 直接判定给定盘面', () => {
  const b = boardFrom([
    [0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0],
    [2, 2, 2, 2, 0, 0, 0],
  ]);
  const res = checkWin(b, 0, 5, BLACK);
  assert.equal(res.winner, BLACK);
  assert.equal(res.line.length, 4);
});

test('AI 能找到立刻获胜的一手', () => {
  const b = boardFrom([
    [0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0],
    [1, 1, 1, 0, 0, 0, 0],
  ]);
  const mv = aiMove(b, RED);
  assert.equal(mv.x, 3, 'AI 应该补在第 4 列直接连成 4');
});

test('AI 会去堵对手的必胜手', () => {
  /* 黑棋已有 1,1,1 三个，第 3 列再落就四连；红方必须堵第 3 列 */
  const b = boardFrom([
    [0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0],
    [2, 2, 2, 0, 0, 0, 0],
  ]);
  const mv = aiMove(b, RED);
  assert.equal(mv.x, 3, 'AI 应该堵住第 3 列');
});

test('AI 只在可落子的列里选', () => {
  const b = emptyBoard();
  const mv = aiMove(b, RED);
  assert.ok(canDrop(b, mv.x));
  assert.equal(mv.y, dropRow(b, mv.x));
});

test('AI 在列满时不会选那一列', () => {
  const b = emptyBoard();
  for (let y = ROWS - 1; y >= 0; y--) b[idx(0, y)] = (y % 2 ? RED : BLACK);
  const mv = aiMove(b, RED);
  assert.notEqual(mv.x, 0);
});

test('hashBoard 对同样棋盘给出同样摘要', () => {
  const a = emptyBoard(); a[idx(0, 5)] = RED;
  const b = emptyBoard(); b[idx(0, 5)] = RED;
  assert.equal(hashBoard(a), hashBoard(b));
  b[idx(1, 5)] = BLACK;
  assert.notEqual(hashBoard(a), hashBoard(b));
});

test('replay 重放出与逐手落子一致的棋盘', () => {
  const actions = [
    { x: 0, stone: RED }, { x: 1, stone: BLACK },
    { x: 0, stone: RED }, { x: 1, stone: BLACK },
  ];
  const r = replay(actions);
  let b = emptyBoard();
  for (const a of actions) b = place(b, a.x, a.stone).board;
  assert.equal(hashBoard(r.board), hashBoard(b));
  assert.equal(r.winner, EMPTY);
  assert.equal(r.actions.length, 4);
});

test('replay 遇到非法动作时停下', () => {
  const r = replay([{ x: 0, stone: RED }, { x: 99, stone: BLACK }]);
  assert.equal(r.actions.length, 2);
  assert.equal(countFilled(r.board), 1);
});

test('replay 能重放出胜局与连珠线', () => {
  /* 红方在第 0/1/2/3 列底部各下一颗，第 4 颗落下即横向四连；
     黑方在第 4/5/6 列底部轮流下，凑够轮次且不干扰红方。 */
  const actions = [
    { x: 0, stone: RED }, { x: 4, stone: BLACK },
    { x: 1, stone: RED }, { x: 5, stone: BLACK },
    { x: 2, stone: RED }, { x: 6, stone: BLACK },
    { x: 3, stone: RED },
  ];
  const r = replay(actions);
  assert.equal(r.winner, RED);
  assert.ok(r.line.length >= 4);
  /* 横向四连：同一行、x 连续 */
  const ys = new Set(r.line.map(([, y]) => y));
  assert.equal(ys.size, 1, '连珠应在同一行');
  const xs = r.line.map(([x]) => x).sort((a, b) => a - b);
  assert.deepEqual(xs, [0, 1, 2, 3]);
});

test('evaluate 判满盘为终局', () => {
  /* 同一张「无四连满盘」：填满后判定为终局且无胜者。 */
  const b = boardFrom([
    [1, 2, 2, 1, 1, 2, 1],
    [2, 1, 1, 2, 2, 1, 2],
    [1, 2, 2, 1, 1, 1, 2],
    [1, 1, 1, 2, 2, 2, 1],
    [2, 2, 2, 1, 1, 2, 1],
    [1, 2, 2, 2, 1, 2, 1],
  ]);
  const e = evaluate(b);
  assert.equal(e.over, true);
  assert.equal(e.winner, EMPTY);
  assert.equal(e.draw, true);
});

test('evaluate 判未满盘为进行中', () => {
  const e = evaluate(emptyBoard());
  assert.equal(e.over, false);
});
