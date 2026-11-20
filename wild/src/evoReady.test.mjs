/**
 * 满级待进化提示单测（node --test）
 * 覆盖：满级欠被动时提示、被动已够不提示、每阶只提示一次、文案含被动名。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ArenaCore } from './arena.js';
import { Rng } from './rng.js';

const mk = () => new ArenaCore({ rng: new Rng('test'), wave: { mode: 'endless' } });

test('满级但缺被动 → 推一条待进化横幅，含被动名与进化名', () => {
  const a = mk();
  a.wLvl.projectile = 6;                 // 投射物满级
  a.evolved.projectile = 0;
  a.passiveTaken = {};                   // 没拿 multi
  a._notifyEvoReady('projectile');
  assert.equal(a.milestones.length, 1);
  const m = a.milestones[0];
  assert.equal(m.kind, 'evo');
  assert.match(m.text, /投射物已满级/);
  assert.match(m.text, /投射物 \+1/);     // multi 的中文名
  assert.match(m.text, /螺旋弹幕/);        // 进化名
});

test('被动已凑齐 → 不提示（进化会立刻发生）', () => {
  const a = mk();
  a.wLvl.projectile = 6;
  a.evolved.projectile = 0;
  a.passiveTaken.multi = 3;              // 已够
  a._notifyEvoReady('projectile');
  assert.equal(a.milestones.length, 0);
});

test('同一武器同一阶只提示一次', () => {
  const a = mk();
  a.wLvl.orbit = 5;
  a.evolved.orbit = 0;
  a.passiveTaken = {};
  a._notifyEvoReady('orbit');
  a._notifyEvoReady('orbit');
  assert.equal(a.milestones.length, 1);
});

test('已进化到顶的武器 → 无待进化线，不提示', () => {
  const a = mk();
  a.wLvl.projectile = 6;
  a.evolved.projectile = 5;              // 远超阶段上限
  a.passiveTaken = {};
  a._notifyEvoReady('projectile');       // evoOfWeapon 找不到 → 直接返回
  assert.equal(a.milestones.length, 0);
});

test('剑的一阶/二阶分别提示（key 带 stage，互不冲突）', () => {
  const a = mk();
  a.wLvl.sword = 6;
  a.evolved.sword = 0;
  a.passiveTaken = {};
  a._notifyEvoReady('sword');            // 一阶：扇形剑幕，需 multi
  a.evolved.sword = 1;
  a.wLvl.sword = 6;
  a._notifyEvoReady('sword');            // 二阶：环绕剑域，需 dmg
  assert.equal(a.milestones.length, 2);
  assert.match(a.milestones[0].text, /扇形剑幕/);
  assert.match(a.milestones[1].text, /环绕剑域/);
});
