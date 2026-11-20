/**
 * 流派羁绊系统单测（node --test）
 * 覆盖：tag 计数、流派激活条件（含珍卡锚点）、新激活检测、加成幂等与键安全。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CARD_TAGS, SYNERGIES, countTags, isUnlocked, newlyUnlocked, applyTo, activeSynergies,
} from './synergy.js';

const byId = (arr, id) => arr.find((s) => s.id === id);

test('countTags：同 tag 多张卡累加，无关卡忽略', () => {
  const c = countTags(['quick_s', 'quick_m', 'wind_l', 'blade_l']);
  assert.equal(c.swift, 3);
  assert.equal(c.heavy, 1);
  assert.equal(c.qi, undefined);
});

test('疾风剑意：3 张 swift 卡即觉醒', () => {
  const syn = byId(SYNERGIES, 'swift');
  assert.equal(isUnlocked(syn, ['quick_s', 'quick_m', 'long_s']), true);
  assert.equal(isUnlocked(syn, ['quick_s', 'quick_m']), false);
});

test('气吞山河：需 3 张 qi 卡 + 珍卡「觉醒」锚点', () => {
  const syn = byId(SYNERGIES, 'qi');
  // 3 qi 但没有 musou_l → 不解锁
  assert.equal(isUnlocked(syn, ['breath_s', 'focus_s', 'surge_s']), false);
  // 补上锚点 → 解锁
  assert.equal(isUnlocked(syn, ['breath_s', 'focus_s', 'surge_m', 'musou_l']), true);
});

test('newlyUnlocked：只报本次新激活，不重复报已激活的', () => {
  const first = newlyUnlocked(['quick_s', 'quick_m', 'long_s'], []);
  assert.deepEqual(first.map((s) => s.id), ['swift']);
  const again = newlyUnlocked(['quick_s', 'quick_m', 'long_s'], ['swift']);
  assert.deepEqual(again, []);
});

test('applyTo：只叠加 mods 中已存在的键，绝不新增键', () => {
  const mods = { damage: 1, attackSpeed: 1, reach: 1, lifesteal: 0, maxHpBonus: 0 };
  const fake = { bonus: { damage: 0.4, attackSpeed: 0.25, bogusKey: 999 } };
  applyTo(mods, fake);
  assert.equal(mods.damage, 1.4);
  assert.equal(mods.attackSpeed, 1.25);
  assert.equal('bogusKey' in mods, false, '未知键不得写入');
});

test('activeSynergies：多流派并存时全部列出', () => {
  const taken = [
    'quick_s', 'quick_m', 'long_s',          // swift
    'blade_s', 'blade_m', 'blade_l',          // heavy
  ];
  const ids = activeSynergies(taken).map((s) => s.id);
  assert.ok(ids.includes('swift'));
  assert.ok(ids.includes('heavy'));
  assert.ok(!ids.includes('qi'));
});

test('所有流派 bonus 的键都必须在 CARD_TAGS 体系里可生效（用标准 mods 校验）', () => {
  const standardMods = {
    damage: 1, kiRegen: 1, musouGain: 1, lifesteal: 0, maxHpBonus: 0,
    attackSpeed: 1, reach: 1, kiMaxBonus: 0,
  };
  for (const syn of SYNERGIES) {
    for (const k of Object.keys(syn.bonus)) {
      assert.ok(k in standardMods, `${syn.id} 的加成键 ${k} 不是有效 mods 键`);
    }
  }
});
