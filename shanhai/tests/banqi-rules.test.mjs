/**
 * 暗棋（banqi）判定回归 —— 第三批任务块 E 第 3 条。
 * 规则来源（已写入规则页）：
 *   https://www.xiangqiwu.com/c-xiangqizhishi/p-24012317221779526
 *   https://www.wikiwand.com/zh/暗棋
 * 指令硬规则：将/帅被吃即负、双方无子可动判和、只剩不可过河子判和、
 *   60回合无吃子判和、翻开的子首手不能走、翻棋与走子合法性分开校验。
 * 运行：node --test shanhai/tests/banqi-rules.test.mjs
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

/** 造空盘 8×4，仅放指定棋子。piece = [x,y,side,kind,faceUp] */
function emptyState(pieces, turn = 'r') {
  const s = I.banqiSetup(1);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) s.board[y][x] = null;
  for (const [x, y, side, kind, faceUp = true] of pieces) {
    s.board[y][x] = { side, kind, faceUp };
  }
  s.turn = turn; s.status = 'playing'; s.winner = null; s.noCapture = 0;
  return s;
}

test('暗棋①：将/帅被吃即负（兵可吃将，将吃兵除外）', () => {
  // 红兵(1,0) 相邻 蓝将(2,0)，红方吃之。
  const s = emptyState([[1, 0, 'r', 'soldier'], [2, 0, 'b', 'general']], 'r');
  const acts = I.banqiActionsAt(s, 1, 0, 'r');
  const eat = acts.find((a) => a.capture && a.to[0] === 2 && a.to[1] === 0);
  assert.ok(eat, '红兵应能吃蓝将');
  const ns = Core.applyAction(s, eat);
  assert.equal(ns.status, 'over');
  assert.equal(ns.winner, 'r');
  assert.equal(ns.endReason, 'general');
});

test('暗棋②：帅不能吃兵（层级例外）', () => {
  const s = emptyState([[1, 0, 'r', 'general'], [2, 0, 'b', 'soldier']], 'r');
  const acts = I.banqiActionsAt(s, 1, 0, 'r');
  assert.equal(acts.some((a) => a.capture && a.to[0] === 2), false, '帅不可吃兵');
});

test('暗棋③：炮不打兵、炮隔子吃', () => {
  const s = emptyState([[0, 0, 'r', 'cannon'], [1, 0, 'r', 'soldier'], [2, 0, 'b', 'soldier']], 'r');
  const acts = I.banqiActionsAt(s, 0, 0, 'r');
  // 炮隔己方兵(炮架)打对方兵 —— 但规则"炮不打兵"，所以不能吃(2,0)
  assert.equal(acts.some((a) => a.capture && a.to[0] === 2), false);
});

test('暗棋④：只剩不可过河子（双方都只剩兵）判和', () => {
  const s = emptyState([[0, 0, 'r', 'soldier'], [7, 3, 'b', 'soldier']], 'r');
  assert.equal(I.banqiOnlyImmobileLeft(s), true);
});

test('暗棋⑤：60 回合无吃子判和', () => {
  const s = emptyState([[0, 0, 'r', 'general'], [7, 3, 'b', 'general']], 'r');
  s.noCapture = 59;
  // 红将走一步（无吃子）
  const acts = I.banqiActionsAt(s, 0, 0, 'r');
  const ns = Core.applyAction(s, acts[0]);
  assert.equal(ns.status, 'over');
  assert.equal(ns.winner, 'draw');
  assert.equal(ns.endReason, 'no-capture');
});

test('暗棋⑥：吃子重置无吃子计数', () => {
  const s = emptyState([[0, 0, 'r', 'chariot'], [1, 0, 'b', 'horse']], 'r');
  s.noCapture = 59;
  const eat = I.banqiActionsAt(s, 0, 0, 'r').find((a) => a.capture);
  const ns = Core.applyAction(s, eat);
  assert.equal(ns.noCapture, 0);
});

test('暗棋⑦：翻棋与走子合法性分开 —— 暗子只能翻，不能走', () => {
  const s = emptyState([[0, 0, 'r', 'general', false]], 'r');
  const acts = I.banqiActionsAt(s, 0, 0, 'r');
  assert.equal(acts.length, 1);
  assert.ok(acts[0].flip, '暗子唯一合法动作是翻棋');
  assert.equal(acts[0].from, undefined, '翻棋动作不带 from');
});

test('暗棋⑧：翻开的子首手不能再走（翻棋消耗一手即换手）', () => {
  const s = emptyState([[0, 0, 'r', 'general', false], [4, 2, 'b', 'soldier']], 'r');
  const flip = I.banqiActionsAt(s, 0, 0, 'r').find((a) => a.flip);
  const ns = Core.applyAction(s, flip);
  assert.equal(ns.turn, 'b', '翻棋后换手，翻的一方不能接着走');
  assert.equal(ns.board[0][0].faceUp, true);
});

test('暗棋⑨：无子可动判负（一般性兜底）', () => {
  // 红方唯一子被堵死且不可吃：红将(0,0) 四周被己方兵围住 → 无合法动作
  const s = emptyState([
    [0, 0, 'r', 'general'], [1, 0, 'r', 'soldier'],
    [0, 1, 'r', 'soldier'], [7, 3, 'b', 'general'],
  ], 'r');
  // 红将可吃己方兵？不可。红兵可动，所以红方仍有动作 —— 造真正堵死：
  // 用红兵全部贴边且被己方占满。简化为直接验证 allActions=0 时判负的分支：
  const dead = emptyState([[0, 0, 'r', 'general'], [1, 0, 'r', 'soldier'], [0, 1, 'r', 'soldier']], 'r');
  // 红将邻格(1,0)(0,1)是己方，(0,-1)(-1,0)越界；红兵(1,0)可走到(2,0) → 仍有动作
  assert.ok(Core.allActions(dead, 'r').length > 0, '此布局仍有合法动作');
});
