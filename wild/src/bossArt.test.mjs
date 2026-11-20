/**
 * Boss 专属立绘接入守护测试（node --test）
 * 覆盖：5 只 Boss 都有独立立绘映射、都在可选集（缺文件静默回退剪影）、
 *       fit 配置齐全、assets 里 PNG 真实存在且非空。
 * 为什么用源码文本断言：SPRITE_FILE / OPTIONAL_SPRITES / SPRITE_FIT 是 arena.js
 * 的模块内常量（刻意不导出，避免扩大对外契约），所以按"源码白名单"核对。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'arena.js'), 'utf8');
const assetsDir = path.join(here, '..', 'assets');

const BOSSES = ['boss1', 'boss2', 'boss3', 'boss4', 'boss5'];

test('5 只 Boss 都有独立立绘文件映射（非复用普通怪贴图）', () => {
  for (const id of BOSSES) {
    assert.match(src, new RegExp(`${id}:\\s*'${id}\\.png'`), `${id} 应映射到 ${id}.png`);
  }
});

test('5 只 Boss 都在可选精灵集里（缺文件静默回退剪影，不留 404）', () => {
  const m = src.match(/OPTIONAL_SPRITES\s*=\s*new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, '应能定位 OPTIONAL_SPRITES 定义');
  for (const id of BOSSES) assert.ok(m[1].includes(`'${id}'`), `${id} 应在 OPTIONAL_SPRITES 中`);
});

test('5 只 Boss 都有 SPRITE_FIT 尺寸配置', () => {
  for (const id of BOSSES) {
    assert.match(src, new RegExp(`${id}:\\s*\\{\\s*axis:\\s*'h'`), `${id} 应有按高度的 fit 配置`);
  }
});

test('assets 里 5 张 Boss 立绘 PNG 真实存在且非空', () => {
  for (const id of BOSSES) {
    const p = path.join(assetsDir, `${id}.png`);
    assert.ok(fs.existsSync(p), `缺少 ${id}.png`);
    assert.ok(fs.statSync(p).size > 5000, `${id}.png 文件过小，疑似损坏`);
    // PNG 魔数
    const buf = fs.readFileSync(p).subarray(0, 8);
    assert.deepEqual([...buf], [137, 80, 78, 71, 13, 10, 26, 10], `${id}.png 不是合法 PNG`);
  }
});
