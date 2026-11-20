/**
 * 数独纯逻辑单测 —— 第三批任务块 G。
 * 运行：node --test sudoku/tests/sudoku-core.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const C = await import(pathToFileURL(resolve(here, '../src/sudoku-core.mjs')).href);
const { DIFFICULTY, generate, countSolutions, isUnique, clearPeerNotes, canPlace, boxOf, isWrong, isSolved } = C;

test('解题器：完整解恰好 1 解、残局可数多解', () => {
  const g = generate(1, DIFFICULTY.easy);
  assert.equal(countSolutions(g.solution, DIFFICULTY.easy, 3), 1, '完整解唯一');
  assert.equal(countSolutions(g.puzzle, DIFFICULTY.easy, 2), 1, '生成题唯一解');
  const empty = new Array(81).fill(0);
  assert.equal(countSolutions(empty, DIFFICULTY.easy, 2), 2, '空盘至少 2 解（数到上限即停）');
});

test('生成器：100 局解数全为 1（所有难度）', () => {
  const keys = Object.keys(DIFFICULTY);
  let n = 0;
  for (let seed = 1; seed <= 100; seed++) {
    const diff = DIFFICULTY[keys[seed % keys.length]];
    const g = generate(seed * 7919, diff);
    assert.equal(g.unique, true, `seed ${seed} 应唯一解`);
    assert.equal(countSolutions(g.puzzle, diff, 2), 1, `seed ${seed} 解数应为 1`);
    assert.equal(isSolved(g.solution, g.solution), true);
    n++;
  }
  assert.equal(n, 100);
});

test('生成器：空数达标（简单45/中等52/困难56/专家58）', () => {
  for (const k of Object.keys(DIFFICULTY)) {
    const d = DIFFICULTY[k];
    const g = generate(12345 + k.charCodeAt(0), d);
    assert.equal(g.blanks, d.blanks, `${d.label} 应挖 ${d.blanks} 空，实际 ${g.blanks}`);
    assert.equal(g.puzzle.filter((v) => v === 0).length, d.blanks);
  }
});

test('每日种子：同种子同盘面', () => {
  const a = generate(20261120, DIFFICULTY.medium);
  const b = generate(20261120, DIFFICULTY.medium);
  assert.deepEqual(a.puzzle, b.puzzle);
});

test('canPlace：同行/列/宫冲突检测', () => {
  const d = DIFFICULTY.easy, b = new Array(81).fill(0);
  b[0] = 5; // (0,0)=5
  assert.equal(canPlace(b, 0, 5, 5, d), false, '同行冲突');
  assert.equal(canPlace(b, 4, 0, 5, d), false, '同列冲突');
  assert.equal(canPlace(b, 1, 1, 5, d), false, '同宫冲突');
  assert.equal(canPlace(b, 4, 4, 5, d), true, '不同行列宫可放');
});

test('铅笔笔记：填数后同行同列同宫清除该候选', () => {
  const d = DIFFICULTY.easy;
  const notes = new Array(81).fill(null).map(() => [1, 2, 5]);
  const out = clearPeerNotes(notes, 40, 5, d); // (4,4)
  assert.deepEqual(out[40], [], '本格清空');
  assert.equal(out[4 * 9 + 0].includes(5), false, '同行清除');
  assert.equal(out[0 * 9 + 4].includes(5), false, '同列清除');
  assert.equal(out[3 * 9 + 3].includes(5), false, '同宫清除');
  assert.equal(out[8 * 9 + 8].includes(5), true, '无关格保留');
  assert.deepEqual(notes[4 * 9 + 0], [1, 2, 5], '原数组不变（纯函数）');
});

test('填错判定：不判负，仅标红', () => {
  const g = generate(7, DIFFICULTY.easy);
  const idx = g.puzzle.findIndex((v) => v === 0);
  const wrongVal = g.solution[idx] % 9 + 1;
  const b = g.puzzle.slice(); b[idx] = wrongVal;
  assert.equal(isWrong(b, idx, g.solution, DIFFICULTY.easy), true);
  assert.equal(isSolved(b, g.solution), false);
});

test('boxOf：宫序号正确', () => {
  const d = DIFFICULTY.easy;
  assert.equal(boxOf(0, 0, d), 0);
  assert.equal(boxOf(0, 3, d), 1);
  assert.equal(boxOf(3, 0, d), 3);
  assert.equal(boxOf(8, 8, d), 8);
});
