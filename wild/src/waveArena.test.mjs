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
} from './wave-config.js';
import { ArenaCore } from './arena.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const arenaSrc = fs.readFileSync(path.join(here, 'arena.js'), 'utf8');

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

test('旧连续局的无界地图逻辑保留，波次模式才启用边界', () => {
  assert.match(arenaSrc, /if \(this\.waveMode\)[\s\S]{0,220}clampToWaveArena\(/, '玩家边界夹紧未接线');
  assert.match(arenaSrc, /this\.waveMode \? this\.waveSpawnOffset\(/, '波次刷怪未走边缘出生');
  assert.match(arenaSrc, /_clampWaveCam\(/, '相机没有跟随固定竞技场');
  assert.match(arenaSrc, /_renderWaveBoundary\(ctx\)/, '竞技场边界未渲染');
  assert.match(arenaSrc, /阶段 4-1：位移\*\*不再 clamp\*\*/, '旧模式无界地图注释丢失');
});
