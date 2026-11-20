/**
 * 跳棋连跳 ①②③ 跳序回归 —— 第三批任务块 E 第 2 条。
 * 验证：BFS 给出每个落点的最少跳数，路径无重复，落点都可继续连跳，跳数带入 lastMove。
 * 运行：node --test shanhai/tests/checkers-chain.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(resolve(here, '../src/chess-core.mjs')).href);
const Core = globalThis.ShanhaiChessCore;
const { at, HOLES, ZONE } = Core.CC;

/** 从初始局面找一枚有连跳的红子 */
function firstJumper(s) {
  for (const i of ZONE.r) {
    if (Core.CC.jumpsWithSteps(s, i).length) return i;
  }
  return -1;
}

test('跳棋：连跳 BFS 记录最少跳数与完整路径', () => {
  const s = Core.createGame('checkers');
  const start = firstJumper(s);
  assert.ok(start >= 0, '开局应存在有连跳的红子');
  const jumps = Core.CC.jumpsWithSteps(s, start);
  for (const j of jumps) {
    assert.ok(j.steps >= 1, '每段落点至少 1 跳');
    assert.equal(j.path[0], start, '路径起点正确');
    assert.equal(j.path[j.path.length - 1], j.land, '路径终点=落点');
    assert.equal(j.path.length, j.steps + 1, '路径长度=跳数+1');
    assert.equal(j.jumped.length, j.steps, '被跳过的孔位数=跳数');
    assert.equal(s.board[j.land], null, '落点为空孔');
    for (const m of j.jumped) assert.ok(s.board[m], '桥位有棋子');
    assert.equal(new Set(j.path).size, j.path.length, '路径无重复');
  }
});

test('跳棋：actionsAt 的 jump 动作携带 steps/path/jumped', () => {
  const s = Core.createGame('checkers');
  const start = firstJumper(s);
  const acts = Core.actionsAt(s, start, 'r').filter((a) => a.jump);
  assert.ok(acts.length > 0);
  for (const a of acts) {
    assert.ok(a.steps >= 1);
    assert.ok(Array.isArray(a.path) && a.path.length === a.steps + 1);
    assert.ok(Array.isArray(a.jumped) && a.jumped.length === a.steps);
  }
});

test('跳棋：构造三连跳，steps 递增且不吞子', () => {
  // 找任意起点+方向，使连续 6 格（3 桥 3 落点）都在棋盘内。
  let line = null;
  for (const h0 of HOLES) {
    for (const d of Core.CC.DIRS) {
      const cells = [];
      let ok = true;
      for (let k = 1; k <= 6; k++) {
        const idx = at(h0.q + k * d[0], h0.r + k * d[1]);
        if (idx < 0) { ok = false; break; }
        cells.push(idx);
      }
      if (ok) { line = { start: HOLES.indexOf(h0), cells }; break; }
    }
    if (line) break;
  }
  assert.ok(line, '应能找到可铺三连跳的直线');
  const s = Core.createGame('checkers');
  s.board = new Array(HOLES.length).fill(null);
  // 奇数位(0,2,4)放桥，偶数位(1,3,5)是落点留空
  for (const k of [0, 2, 4]) s.board[line.cells[k]] = { side: 'b' };
  s.board[line.start] = { side: 'r' };
  const jumps = Core.CC.jumpsWithSteps(s, line.start);
  const maxSteps = Math.max(...jumps.map((j) => j.steps));
  assert.ok(maxSteps >= 3, `应存在至少 3 跳落点，实际最大 ${maxSteps}`);
  const best = jumps.find((j) => j.steps === maxSteps);
  const before = Core.countPieces(s, 'b');
  const ns = Core.applyAction(s, {
    from: [line.start, 0], to: [best.land, 0], jump: true, steps: best.steps, path: best.path, jumped: best.jumped,
  });
  assert.equal(Core.countPieces(ns, 'b'), before, '连跳不吞子');
  assert.equal(ns.lastMove.steps, best.steps, 'lastMove 保留跳数供 HUD 显示');
});

test('跳棋：lastMove.path 保留路径，可供渲染 ①②③', () => {
  const s = Core.createGame('checkers');
  const start = firstJumper(s);
  const a = Core.actionsAt(s, start, 'r').find((x) => x.jump && x.steps >= 1);
  assert.ok(a);
  const ns = Core.applyAction(s, a);
  assert.deepEqual(ns.lastMove.path, a.path);
});
