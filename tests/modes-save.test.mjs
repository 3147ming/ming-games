/**
 * 模式配置 / 存档 单测（node --test）
 * modes.js 与 SaveManager 都是纯逻辑，不碰 DOM、不碰 Three。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { endlessWave, ENDLESS, BALANCE } from '../src/config/modes.js';
import { SaveManager, SAVE_KEY, defaultSave, SAVE_VERSION } from '../src/core/SaveManager.js';

class MemStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

const sumMix = (mix) => Object.values(mix).reduce((a, b) => a + b, 0);

test('无尽模式：第 1 波基础数量正确', () => {
  const w = endlessWave(1);
  assert.equal(w.total, ENDLESS.baseTotal);
  assert.equal(w.alive, ENDLESS.baseAlive);
  assert.equal(w.healthMul, 1);
  assert.equal(w.mix.walker + w.mix.swift, w.total);
});

test('无尽模式：变体配额总数等于 total（首领额外不计入）', () => {
  for (const n of [2, 5, 9, 11, 20]) {
    const w = endlessWave(n);
    const boss = w.mix.boss || 0;
    assert.equal(sumMix(w.mix) - boss, w.total, `第 ${n} 波配额不等于 total`);
  }
});

test('无尽模式：数量与血量都有硬上限', () => {
  const w = endlessWave(999);
  assert.equal(w.total, ENDLESS.maxTotal);
  assert.equal(w.alive, ENDLESS.maxAlive);
  assert.ok(w.healthMul <= ENDLESS.healthCap + 1e-9);
});

test('无尽模式：每 10 波出现首领，其余波次没有', () => {
  assert.equal(endlessWave(10).mix.boss, 1);
  assert.equal(endlessWave(20).mix.boss, 1);
  assert.equal(endlessWave(9).mix.boss, undefined);
});

test('平衡上限：伤害与移速加成有明确上限', () => {
  assert.ok(BALANCE.maxDamageBonus <= 0.6 + 1e-9);
  assert.ok(BALANCE.maxSpeedBonus <= 0.25 + 1e-9);
});

test('存档：首次读取返回默认值', () => {
  const s = new SaveManager(new MemStorage());
  assert.equal(s.data.stats.runs, 0);
  assert.equal(s.data.meta.cores, 0);
  assert.equal(s.data.unlocks.levels, 1);
  assert.deepEqual(s.data.unlocks.weapons.length > 0, true);
});

test('存档：写入后可重新读出', () => {
  const storage = new MemStorage();
  const a = new SaveManager(storage);
  a.addCores(3);
  const b = new SaveManager(storage);
  assert.equal(b.data.meta.cores, 3);
});

test('存档：损坏 JSON / 旧版本号回退到默认值', () => {
  const storage = new MemStorage();
  storage.setItem(SAVE_KEY, '{oops');
  const a = new SaveManager(storage);
  assert.equal(a.data.stats.runs, 0);

  storage.setItem(SAVE_KEY, JSON.stringify({ v: SAVE_VERSION - 1, stats: { runs: 99 } }));
  const b = new SaveManager(storage);
  assert.equal(b.data.stats.runs, 0);
});

test('存档：结算累计战绩并推进关卡解锁', () => {
  const s = new SaveManager(new MemStorage());
  s.recordRun({ kills: 12, seconds: 90, level: 1, wave: 3, win: true });
  assert.equal(s.data.stats.runs, 1);
  assert.equal(s.data.stats.kills, 12);
  assert.equal(s.data.stats.totalTime, 90);
  assert.equal(s.data.stats.bestLevel, 1);
  assert.equal(s.data.stats.bestWave, 3);
  assert.equal(s.data.unlocks.levels, 2);
});

test('存档：reset 恢复默认值', () => {
  const storage = new MemStorage();
  const s = new SaveManager(storage);
  s.recordRun({ kills: 5, seconds: 30, level: 2, win: true });
  s.reset();
  assert.deepEqual(s.data, defaultSave());
});
