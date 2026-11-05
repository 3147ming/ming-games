/**
 * 结算算术单测（node --test）
 * 这些函数是纯的：不碰 DOM、不碰 Three。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeAccuracy, computeScore, pickGrade } from '../src/core/scoring.js';

const GRADES = [
  { grade: 'S', min: 2000 },
  { grade: 'A', min: 1600 },
  { grade: 'B', min: 1200 },
  { grade: 'C', min: 0 },
];

test('命中率：没开枪记 0，正常取值', () => {
  assert.equal(computeAccuracy(0, 0), 0);
  assert.equal(computeAccuracy(0, 5), 0);
  assert.equal(computeAccuracy(10, 5), 0.5);
  assert.equal(computeAccuracy(10, 10), 1);
});

test('命中率：命中数不会超过开枪数（脏数据兜底）', () => {
  assert.equal(computeAccuracy(10, 99), 1);
  assert.equal(computeAccuracy(10, -3), 0);
});

test('得分：满状态三波全清可达 S', () => {
  const score = computeScore(
    { kills: 15, headshots: 5, shots: 100, hits: 80, damageTaken: 0 },
    100
  );
  assert.equal(score, 2000);
  assert.equal(pickGrade(score, GRADES), 'S');
});

test('得分：不挨打、不拖时间比挨打拖时间高', () => {
  const base = { kills: 10, headshots: 2, shots: 60, hits: 30, damageTaken: 0 };
  const fast = computeScore(base, 60);
  const slow = computeScore(base, 160);
  assert.ok(fast > slow, `${fast} 应该大于 ${slow}`);
  const hurt = computeScore({ ...base, damageTaken: 80 }, 60);
  assert.ok(fast > hurt, `${fast} 应该大于 ${hurt}`);
});

test('得分：不会出现负数', () => {
  const score = computeScore({ kills: 0, headshots: 0, shots: 0, hits: 0, damageTaken: 500 }, 999);
  assert.equal(score, 0);
});

test('得分：爆头数被约束在击杀数内', () => {
  const a = computeScore({ kills: 3, headshots: 3, shots: 10, hits: 3, damageTaken: 0 }, 10);
  const b = computeScore({ kills: 3, headshots: 99, shots: 10, hits: 3, damageTaken: 0 }, 10);
  assert.equal(a, b);
});

test('评级：阈值边界从高到低命中', () => {
  assert.equal(pickGrade(2000, GRADES), 'S');
  assert.equal(pickGrade(1999, GRADES), 'A');
  assert.equal(pickGrade(1600, GRADES), 'A');
  assert.equal(pickGrade(1599, GRADES), 'B');
  assert.equal(pickGrade(1200, GRADES), 'B');
  assert.equal(pickGrade(0, GRADES), 'C');
});

test('评级：空配置兜底不抛错', () => {
  assert.equal(pickGrade(100, []), 'C');
  assert.equal(pickGrade(100, undefined), 'C');
});
