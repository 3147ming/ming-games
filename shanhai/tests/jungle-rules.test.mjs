/**
 * 斗兽棋（jungle）规则逐条回归 —— 对应第三批任务块 E 第 1 条。
 * 每条用例都对应指令里的一条硬规则：
 *   象>狮>虎>豹>狼>犬>猫>鼠；鼠吃象、象不吃鼠；仅鼠入河；
 *   狮虎跳横河；不吃己方兽穴子；进敌方兽穴胜；25回合无吃子判和；
 *   陷阱内己方兽战力归零。
 * 运行：node --test shanhai/tests/jungle-rules.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(resolve(here, '../src/chess-core.mjs')).href);
const Core = globalThis.ShanhaiChessCore;
const I = Core._internal;

/** 造一个干净的空盘，仅放置指定棋子。board[y][x] = {side,kind} */
function emptyState(pieces, turn = 'r') {
  const s = I.jungleSetup();
  for (let y = 0; y < s.rows; y++) for (let x = 0; x < s.cols; x++) s.board[y][x] = null;
  for (const [x, y, side, kind] of pieces) s.board[y][x] = { side, kind };
  s.turn = turn; s.status = 'playing'; s.winner = null; s.noCapture = 0;
  return s;
}
const hasAct = (s, fx, fy, tx, ty) =>
  I.jungleActionsAt(s, fx, fy, s.board[fy][fx].side).some(
    (a) => a.to[0] === tx && a.to[1] === ty
  );

test('斗兽棋①：棋盘 7×9、两端兽穴、8 个陷阱', () => {
  const s = Core.createGame('jungle');
  assert.equal(s.cols, 7); assert.equal(s.rows, 9);
  assert.deepEqual(Core.JUNGLE.den('r'), [3, 8]);
  assert.deepEqual(Core.JUNGLE.den('b'), [3, 0]);
  const traps = [];
  for (let y = 0; y < 9; y++) for (let x = 0; x < 7; x++) {
    if (Core.JUNGLE.trapOf(x, y)) traps.push([x, y]);
  }
  assert.equal(traps.length, 8, `陷阱应为 8 个，实际 ${traps.length}`);
});

test('斗兽棋②：鼠吃象、象不吃鼠（水陆互不相吃）', () => {
  // 陆地鼠吃象
  const s1 = emptyState([[0, 0, 'r', 'rat'], [1, 0, 'b', 'elephant']]);
  assert.equal(I.jgCanCapture(s1, 0, 0, 1, 0, s1.board[0][0], s1.board[0][1]), true);
  // 象不吃鼠
  const s2 = emptyState([[0, 0, 'b', 'elephant'], [1, 0, 'r', 'rat']]);
  assert.equal(I.jgCanCapture(s2, 0, 0, 1, 0, s2.board[0][0], s2.board[0][1]), false);
  // 陆鼠 vs 水象：不能隔水吃
  const s3 = emptyState([[0, 2, 'r', 'rat'], [1, 3, 'b', 'elephant']]); // (1,3)是水
  assert.equal(I.jgCanCapture(s3, 0, 2, 1, 3, s3.board[2][0], s3.board[3][1]), false);
});

test('斗兽棋③：等级链 象>狮>虎>豹>狼>犬>猫>鼠', () => {
  const s = emptyState([[0, 0, 'r', 'elephant'], [1, 0, 'b', 'lion']]);
  assert.equal(I.jgCanCapture(s, 0, 0, 1, 0, s.board[0][0], s.board[0][1]), true);
  const s2 = emptyState([[0, 0, 'r', 'cat'], [1, 0, 'b', 'dog']]);
  assert.equal(I.jgCanCapture(s2, 0, 0, 1, 0, s2.board[0][0], s2.board[0][1]), false);
  const s3 = emptyState([[0, 0, 'r', 'dog'], [1, 0, 'b', 'cat']]);
  assert.equal(I.jgCanCapture(s3, 0, 0, 1, 0, s3.board[0][0], s3.board[0][1]), true);
  // 同类互吃
  const s4 = emptyState([[0, 0, 'r', 'tiger'], [1, 0, 'b', 'tiger']]);
  assert.equal(I.jgCanCapture(s4, 0, 0, 1, 0, s4.board[0][0], s4.board[0][1]), true);
});

test('斗兽棋④：仅鼠能入河，其他兽不可下水', () => {
  // (1,2)是陆地，(1,3)是水，正交相邻。
  const s = emptyState([[1, 2, 'r', 'lion']]);
  const rat = emptyState([[1, 2, 'r', 'rat']]);
  assert.equal(hasAct(s, 1, 2, 1, 3), false, '狮不能下水');
  assert.equal(hasAct(rat, 1, 2, 1, 3), true, '鼠能下水');
  // 河中的鼠只能被河中的鼠吃：陆虎(3,3)不能吃水中的鼠(2,3)
  const water = emptyState([[3, 3, 'r', 'tiger'], [2, 3, 'b', 'rat']]);
  assert.equal(I.jgCanCapture(water, 3, 3, 2, 3, water.board[3][3], water.board[3][2]), false);
  // 水中鼠 vs 水中鼠可互吃
  const water2 = emptyState([[1, 3, 'r', 'rat'], [2, 3, 'b', 'rat']]);
  assert.equal(I.jgCanCapture(water2, 1, 3, 2, 3, water2.board[3][1], water2.board[3][2]), true);
});

test('斗兽棋⑤：狮虎可跳纵河（河中有鼠则不可跳）', () => {
  // 狮在 (3,2) 陆地，纵跳到 (3,6)，中间 (3,3)(3,4)(3,5) —— 列3是陆路，非水！
  // 纵跳走列 1：(1,2) -> (1,6)，中间 (1,3)(1,4)(1,5) 均为河
  const clear = emptyState([[1, 2, 'r', 'lion']]);
  assert.equal(hasAct(clear, 1, 2, 1, 6), true, '河空时狮可纵跳');
  const blocked = emptyState([[1, 2, 'r', 'lion'], [1, 4, 'b', 'rat']]);
  assert.equal(hasAct(blocked, 1, 2, 1, 6), false, '河中有鼠时不可跳');
});

test('斗兽棋⑥：狮虎可跳横河', () => {
  // 虎在 (0,4) 陆路，横跳跨过水域 (1,4)(2,4) 到 (3,4)
  const clear = emptyState([[0, 4, 'r', 'tiger']]);
  assert.equal(hasAct(clear, 0, 4, 3, 4), true, '河空时虎可横跳');
  const blocked = emptyState([[0, 4, 'r', 'tiger'], [2, 4, 'b', 'rat']]);
  assert.equal(hasAct(blocked, 0, 4, 3, 4), false, '水域有鼠时不可横跳');
});

test('斗兽棋⑦：进敌方兽穴即胜（且不吃己方兽穴子）', () => {
  // 红鼠在 (3,7) 邻蓝兽穴 (3,0) 不行；改放红豹 (2,1) 邻蓝穴(3,0)? (2,1)是陷阱非穴
  // 蓝穴在 (3,0)，红子从 (3,1) 进入
  const s = emptyState([[3, 1, 'r', 'leopard']], 'r');
  assert.equal(hasAct(s, 3, 1, 3, 0), true, '可进敌方兽穴');
  const a = I.jungleActionsAt(s, 3, 1, 'r').find((x) => x.to[0] === 3 && x.to[1] === 0);
  const ns = Core.applyAction(s, a);
  assert.equal(ns.status, 'over');
  assert.equal(ns.winner, 'r');
  assert.equal(ns.endReason, 'den');
  // 己方兽穴不可进入：红穴(3,8)，红子在(3,7)不能退回
  const s2 = emptyState([[3, 7, 'r', 'cat']], 'r');
  assert.equal(hasAct(s2, 3, 7, 3, 8), false, '不能进己方兽穴');
});

test('斗兽棋⑧：陷阱内己方兽战力归零，任意敌子可吃', () => {
  // 蓝象站在"红方陷阱"(2,8)上 → 战力归零，红猫可吃。
  const s = emptyState([[1, 8, 'r', 'cat'], [2, 8, 'b', 'elephant']]);
  assert.equal(Core.JUNGLE.trapOf(2, 8), 'r');
  assert.equal(I.jgCanCapture(s, 1, 8, 2, 8, s.board[8][1], s.board[8][2]), true, '敌方陷阱内象战力归零，猫可吃');
  // 对照：蓝象站在"蓝方自己陷阱"(2,0)上，战力不归零，红猫仍吃不了
  const own = emptyState([[1, 0, 'r', 'cat'], [2, 0, 'b', 'elephant']]);
  assert.equal(I.jgCanCapture(own, 1, 0, 2, 0, own.board[0][1], own.board[0][2]), false, '己方陷阱不削弱自己');
});

test('斗兽棋⑨：25 回合无吃子判和', () => {
  const s = emptyState([[0, 0, 'r', 'cat'], [6, 8, 'b', 'cat']]);
  s.noCapture = 24;
  // 红猫走一步（无吃子）→ noCapture=25 → 判和
  const acts = I.jungleActionsAt(s, 0, 0, 'r');
  const ns = Core.applyAction(s, acts[0]);
  assert.equal(ns.status, 'over');
  assert.equal(ns.winner, 'draw');
  assert.equal(ns.endReason, 'no-capture');
});

test('斗兽棋⑩：吃子重置无吃子计数', () => {
  const s = emptyState([[0, 0, 'r', 'tiger'], [1, 0, 'b', 'cat']]);
  s.noCapture = 24;
  const a = I.jungleActionsAt(s, 0, 0, 'r').find((x) => x.capture);
  const ns = Core.applyAction(s, a);
  assert.equal(ns.noCapture, 0, '吃子后计数归零');
});

test('斗兽棋⑪：吃光对方 / 对方无子可动即胜', () => {
  const s = emptyState([[0, 0, 'r', 'lion']], 'r');
  assert.equal(I.jungleWin(s, 'r'), false);
  const s2 = emptyState([[3, 1, 'r', 'lion']], 'r');
  const a = I.jungleActionsAt(s2, 3, 1, 'r').find((x) => x.enterDen);
  const ns = Core.applyAction(s2, a);
  assert.equal(I.jungleWin(ns, 'r'), true);
});
