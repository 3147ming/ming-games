/**
 * 幽灵痕迹系统单测（node --test）
 * 覆盖：确定性、只读 map、类型分布、空地图兜底。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from './rng.js';
import { generateGhostTraces } from './ghostTraces.js';

const fakeMap = {
  tile: 40,
  rooms: [
    { cx: 100, cy: 100, tx: 60, ty: 60, tw: 80, th: 80 },
    { cx: 300, cy: 300, tx: 260, ty: 260, tw: 80, th: 80 },
    { cx: 500, cy: 500, tx: 460, ty: 460, tw: 80, th: 80 },
  ],
  containers: [{ id: 'c1', x: 300, y: 300 }],
};

test('确定性：同 seed 得到完全一致的痕迹', () => {
  const a = generateGhostTraces(fakeMap, mulberry32(12345));
  const b = generateGhostTraces(fakeMap, mulberry32(12345));
  assert.deepEqual(a, b);
});

test('只读 map：生成前后 map 结构与内容不变', () => {
  const snapshot = JSON.stringify(fakeMap);
  generateGhostTraces(fakeMap, mulberry32(999));
  assert.equal(JSON.stringify(fakeMap), snapshot);
});

test('数量与类型：脚印链 + 终点 scuff，数量符合配置', () => {
  const traces = generateGhostTraces(fakeMap, mulberry32(7), { groups: 3, stepsPerGroup: 5 });
  const fp = traces.filter((t) => t.type === 'footprint');
  const sc = traces.filter((t) => t.type === 'scuff');
  assert.equal(fp.length, 15); // 3 组 × 5 步
  assert.equal(sc.length, 3);  // 每组 1 处 scuff
});

test('痕迹落在房间附近（远离出生点 rooms[0]）', () => {
  const traces = generateGhostTraces(fakeMap, mulberry32(42), { groups: 1, stepsPerGroup: 3 });
  // 单组时应取最后一个房间（cx=500），痕迹 x 大致在其附近
  const avgX = traces.reduce((s, t) => s + t.x, 0) / traces.length;
  assert.ok(avgX > 400, `痕迹应靠近末房间，实际 avgX=${avgX}`);
});

test('空地图兜底：无 rooms 时返回空数组，不抛错', () => {
  assert.deepEqual(generateGhostTraces({ rooms: [] }, mulberry32(1)), []);
  assert.deepEqual(generateGhostTraces({}, mulberry32(1)), []);
});
