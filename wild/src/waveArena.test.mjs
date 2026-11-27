/**
 * 波次模式“土豆兄弟化”局部机制守护测试（node --test）
 * 覆盖：固定竞技场、边界出生、波末经济与结转率，以及旧连续局不受影响。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  WAVE_ARENA,
  waveArenaHalf,
  clampToWaveArena,
  waveEndMaterials,
  CARRY_KEEP,
  WAVE_GEM_MAGNET,
  WAVE_WEAPONS,
  weaponGoodById,
  weaponBaseOf,
  killMaterialRate,
} from './wave-config.js';
import { ArenaCore } from './arena.js';
import { Rng } from './rng.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const arenaSrc = fs.readFileSync(path.join(here, 'arena.js'), 'utf8');
const directorSrc = fs.readFileSync(path.join(here, 'wave-director.js'), 'utf8');

test('固定竞技场尺寸与边界夹紧可用', () => {
  const h = waveArenaHalf();
  assert.equal(h.x, WAVE_ARENA.W / 2 - WAVE_ARENA.WALL);
  assert.equal(h.y, WAVE_ARENA.H / 2 - WAVE_ARENA.WALL);

  assert.deepEqual(clampToWaveArena(9999, -9999, 0), { x: h.x, y: -h.y });
  const withR = clampToWaveArena(-9999, 9999, 20);
  assert.equal(withR.x, -h.x + 20);
  assert.equal(withR.y, h.y - 20);
});

test('波次模式出生点贴竞技场边缘，且不会落到墙外', () => {
  const core = Object.create(ArenaCore.prototype);
  core.waveMode = true;
  core.player = { x: 0, y: 0, r: 12 };
  const h = waveArenaHalf();

  const right = core.waveSpawnOffset(0, 360);
  assert.ok(right.dx > h.x * 0.8, `右侧出生太近中心：${right.dx}`);
  assert.ok(right.dx <= h.x, `右侧出生越界：${right.dx}`);
  assert.ok(Math.abs(right.dy) < 1);

  // 玩家贴右边、朝外刷怪时，方向应被翻回场内。
  core.player.x = h.x - 4;
  const outward = core.waveSpawnOffset(0, 360);
  assert.ok(outward.dx < -50, `贴边向外未翻面：${outward.dx}`);
  const p = clampToWaveArena(core.player.x + outward.dx, core.player.y + outward.dy, 14);
  assert.ok(Math.abs(p.x) <= h.x + 1e-6);
  assert.ok(Math.abs(p.y) <= h.y + 1e-6);
});

test('波末经济与未拾取结转率按校准值执行', () => {
  assert.equal(waveEndMaterials(1, { harvest: 0 }), 32);
  assert.equal(waveEndMaterials(20, { harvest: 0 }), 222);
  assert.equal(CARRY_KEEP, 0.5, '漏捡仍全额结转会把商店经济冲垮');
});

test('击杀材料按波分段递减，避免后期材料洪水（阶段14经济校准）', () => {
  // 前 4 波 1:1 保起步（历史教训：一刀切压低会死亡螺旋）
  assert.equal(killMaterialRate(1), 1);
  assert.equal(killMaterialRate(4), 1);
  // 中期收紧
  assert.equal(killMaterialRate(5), 0.7);
  assert.equal(killMaterialRate(8), 0.7);
  assert.equal(killMaterialRate(9), 0.5);
  assert.equal(killMaterialRate(12), 0.5);
  // 13 波后最紧
  assert.equal(killMaterialRate(13), 0.35);
  assert.equal(killMaterialRate(20), 0.35);
  // 严格单调不增
  let prev = Infinity;
  for (let w = 1; w <= 20; w++) {
    const r = killMaterialRate(w);
    assert.ok(r <= prev, `第 ${w} 波折算率反弹：${r} > ${prev}`);
    prev = r;
  }
});

test('onPickup 使用分段折算率而非硬编码 1:1', () => {
  assert.match(directorSrc, /killMaterialRate,?\s*\}?\s*from '\.\/wave-config\.js'/,
    'wave-director 未 import killMaterialRate');
  assert.match(directorSrc, /const rate = killMaterialRate\(this\.wave\)/,
    'onPickup 仍在用固定折算率，材料洪水会回来');
  assert.doesNotMatch(directorSrc, /const rate = 1;/,
    '不应残留 1:1 固定折算率');
});

test('旧连续局的无界地图逻辑保留，波次模式才启用边界', () => {
  assert.match(arenaSrc, /if \(this\.waveMode\)[\s\S]{0,220}clampToWaveArena\(/, '玩家边界夹紧未接线');
  assert.match(arenaSrc, /this\.waveMode \? this\.waveSpawnOffset\(/, '波次刷怪未走边缘出生');
  assert.match(arenaSrc, /_clampWaveCam\(/, '相机没有跟随固定竞技场');
  assert.match(arenaSrc, /_renderWaveBoundary\(ctx\)/, '竞技场边界未渲染');
  assert.match(arenaSrc, /阶段 4-1：位移\*\*不再 clamp\*\*/, '旧模式无界地图注释丢失');
});

test('波次模式起手拾取半径 90，旧连续局仍是 280', () => {
  assert.equal(WAVE_GEM_MAGNET, 90, '固定竞技场里 280 等于全场自动吸宝石');
  const core = new ArenaCore({ rng: new Rng('magnet'), wave: { mode: '20' } });
  assert.equal(core.magnet, 90, 'WaveDirector 未覆盖起手拾取半径');
  const legacy = new ArenaCore({ rng: new Rng('magnet'), wave: null });
  assert.equal(legacy.magnet, 280, '旧连续局口径被污染');
});

test('波次武器池扩到 12 把，进阶型号映射回 6 个底层机制', () => {
  assert.equal(WAVE_WEAPONS.length, 12, '货架只有 6 把武器谈不上 build 多样性');
  const ids = WAVE_WEAPONS.map((w) => w.id);
  assert.equal(new Set(ids).size, ids.length, '武器 id 有重复');
  const bases = new Set(WAVE_WEAPONS.map((w) => weaponBaseOf(w.id)));
  assert.deepEqual([...bases].sort(), ['laser', 'mist', 'orbit', 'projectile', 'sentry', 'sword']);
  for (const w of WAVE_WEAPONS) {
    assert.equal(weaponGoodById(w.id), w);
    assert.ok(w.label && w.desc && w.cost > 0, `${w.id} 缺少展示字段`);
  }
  assert.equal(weaponBaseOf('railgun'), 'laser');
  assert.equal(weaponBaseOf('smg'), 'projectile');
  assert.equal(weaponBaseOf('unknown'), 'unknown');
});

test('战斗中经验满只排队，波末倒计时结束后才弹升级，选完才进商店', () => {
  const core = new ArenaCore({ rng: new Rng('wave-upgrade'), wave: { mode: '20' } });
  assert.equal(core.waveMode, true);

  // 战斗中经验满：只排队，绝不弹窗
  core.xp = core.xpToLevel + 1;
  core.wd.queueLevelUps();
  assert.equal(core.pendingUpgrade, null, '战斗中弹窗会打断走位，必须延到波末');
  assert.equal(core.wd.pendingLevels, 1);
  assert.equal(core.level, 1, '等级应在排队时就结算，避免连升门槛错位');

  // 波末倒计时结束：先弹升级
  core.wd.endWave();
  assert.ok(core.pendingUpgrade, '波末应先弹出升级选择');
  assert.equal(core.wd.phase, 'battle', '选升级期间商店还没开');

  // 选完 → 才进商店
  assert.equal(core.chooseUpgrade(0), true);
  assert.equal(core.pendingUpgrade, null);
  assert.equal(core.wd.pendingLevels, 0);
  assert.equal(core.wd.phase, 'shop', '升级选完才允许进波间商店');
});

test('连升攒 3 级，波末逐张弹完才开商店', () => {
  const core = new ArenaCore({ rng: new Rng('wave-multi'), wave: { mode: '20' } });
  core.xp = core.xpNeed(0) + core.xpNeed(1) + core.xpNeed(2) + 1;
  core.wd.queueLevelUps();
  assert.equal(core.wd.pendingLevels, 3);
  assert.equal(core.pendingUpgrade, null);

  core.wd.endWave();
  for (let i = 3; i > 0; i--) {
    assert.ok(core.pendingUpgrade, `第 ${4 - i} 张升级牌应弹出`);
    assert.equal(core.wd.phase, 'battle');
    core.chooseUpgrade(0);
    assert.equal(core.wd.pendingLevels, i - 1);
  }
  assert.equal(core.wd.phase, 'shop');
});

test('购买/卖出进阶武器按 base 开关底层机制', () => {
  const core = new ArenaCore({ rng: new Rng('wave-buy'), wave: { mode: '20' } });
  const d = core.wd;
  d.phase = 'shop';
  d.materials = 9999;
  d.shop = [{
    kind: 'weapon', id: 'smg', label: '连弩', desc: '', tag: 'ranged',
    rarity: 'common', cost: 1, locked: false, sold: false,
  }];
  assert.equal(d.buy(0), true);
  assert.equal(core.weapons.projectile, true, '连弩应开启投射物底层机制');
  assert.equal(core.weapons.smg, undefined, '不应写入不存在的底层武器 id');
  assert.ok(core.gUpMul > 1, '进阶型号 pow 应折算进伤害乘区');

  d.shop = [];
  // 流浪者起始就带一把投射物，所以卖掉连弩后底层机制仍要开着。
  assert.ok(d.sellSlot(1) > 0, '先卖掉连弩');
  assert.equal(core.weapons.projectile, true, '还有一把投射物在，机制不能关');
  assert.ok(d.sellSlot(0) > 0, '再卖掉初始投射物');
  assert.equal(core.weapons.projectile, false, '同 base 全卖光才关闭机制');
});

test('gainXp 走排队路径，不再直接调用 openUpgrade', () => {
  assert.match(arenaSrc, /if \(this\.waveMode\) \{[\s\S]{0,240}queueLevelUps\(\)/,
    'gainXp 未把升级改为排队');
});

test('精英波奖励选完继续打，不消耗待升级次数也不误开商店', () => {
  const core = new ArenaCore({ rng: new Rng('wave-elite'), wave: { mode: '20' } });
  const d = core.wd;
  core.xp = core.xpToLevel + 1;
  d.queueLevelUps();
  assert.equal(d.pendingLevels, 1);

  core.openUpgrade({ reason: 'elite' });
  assert.equal(core.pendingUpgradeKind, 'elite');
  core.chooseUpgrade(0);
  assert.equal(core.pendingUpgrade, null);
  assert.equal(d.phase, 'battle', '波内精英奖励选完应继续战斗，不能开商店');
  assert.equal(d.pendingLevels, 1, '精英奖励不能消耗波末待升级次数');

  // 波末升级仍要正常弹出并进商店
  d.endWave();
  assert.ok(core.pendingUpgrade);
  core.chooseUpgrade(0);
  assert.equal(d.phase, 'shop');
});
