/**
 * 《山海拾遗 · 棋艺》规则回归（node --test）
 * ---------------------------------------------------------------------------
 * 只管"规则对不对"，不管画面。每条用例对应一个真实踩过的坑：
 *   · 将/帅走出九宫           （2026-11-16 反馈"规则不自洽"）
 *   · 暗棋把帥当车、炮无需炮架
 *   · 跳棋仍是西洋跳棋、且凭空加了"有跳必跳"
 * 运行：node --test shanhai/tests/*.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(resolve(here, '../src/chess-core.mjs')).href);
const Core = globalThis.ShanhaiChessCore;
const CC = Core.CC;

test('跳棋：六角星 121 孔、双方各 10 子', () => {
  assert.equal(CC.HOLES.length, 121);
  assert.equal(CC.ZONE.r.length, 10);
  assert.equal(CC.ZONE.b.length, 10);
  const s = Core.createGame('checkers');
  assert.equal(s.board.length, 121);
  assert.equal(Core.countPieces(s, 'r'), 10);
  assert.equal(Core.countPieces(s, 'b'), 10);
});

test('跳棋：一步与跳跃同时可选（没有"有跳必跳"）', () => {
  const s = Core.createGame('checkers');
  const acts = Core.allActions(s, 'r');
  assert.ok(acts.some((a) => !a.jump), '开局应有一步走法');
  assert.ok(acts.some((a) => a.jump), '开局应有跳跃');
});

test('跳棋：跳跃不吞子、走子后换手', () => {
  const s = Core.createGame('checkers');
  const jump = Core.allActions(s, 'r').find((a) => a.jump);
  const ns = Core.applyAction(s, jump);
  assert.equal(Core.countPieces(ns, 'r'), 10);
  assert.equal(Core.countPieces(ns, 'b'), 10);
  assert.equal(ns.turn, 'b');
});

test('跳棋：十子全部进入对面三角才算胜', () => {
  const s = Core.createGame('checkers');
  const win = Core.cloneState(s);
  win.board = new Array(121).fill(null);
  for (const i of CC.ZONE.b) win.board[i] = { side: 'r' };
  for (const i of CC.ZONE.r) win.board[i] = { side: 'b' };
  assert.equal(CC.hasWon(win, 'r'), true);
  win.board[CC.ZONE.b[0]] = null;
  assert.equal(CC.hasWon(win, 'r'), false);
});

test('象棋：将/帅不能走出九宫', () => {
  const s = Core.createGame('xiangqi');
  const t = Core._internal.xiangqiTargets(s, 4, 9);
  assert.ok(t.length > 0);
  for (const p of t) {
    assert.ok(p.x >= 3 && p.x <= 5 && p.y >= 7 && p.y <= 9, `越界：${p.x},${p.y}`);
  }
});

test('暗棋：帥只走一步（不再是车）', () => {
  const s = Core.createGame('banqi', { seed: 7 });
  const b = Core.cloneState(s);
  b.board = Array.from({ length: 4 }, () => new Array(8).fill(null));
  b.board[0][0] = { side: 'r', kind: 'general', faceUp: true };
  const t = Core._internal.banqiTargets(b, 0, 0);
  assert.ok(t.length > 0);
  for (const p of t) assert.equal(Math.abs(p.x) + Math.abs(p.y), 1);
});

test('暗棋：吃子层级（兵吃帥、帥不吃兵、炮不打兵）', () => {
  const can = Core._internal.banqiCanCapture;
  assert.equal(can({ side: 'b', kind: 'soldier' }, { side: 'r', kind: 'general' }), true);
  assert.equal(can({ side: 'r', kind: 'general' }, { side: 'b', kind: 'soldier' }), false);
  assert.equal(can({ side: 'r', kind: 'cannon' }, { side: 'b', kind: 'soldier' }), false);
  assert.equal(can({ side: 'r', kind: 'cannon' }, { side: 'b', kind: 'chariot' }), true);
  assert.equal(can({ side: 'b', kind: 'chariot' }, { side: 'r', kind: 'general' }), false);
});

test('五子棋：落子落在交叉点坐标上', () => {
  const s = Core.createGame('gomoku');
  const ns = Core.applyAction(s, { to: [7, 7] });
  assert.equal(ns.board[7][7], 'r');
});
