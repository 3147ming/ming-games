/**
 * 特效贴图接入守护测试（node --test）
 * 覆盖：4 张特效 PNG 存在且合法、模块映射齐全、main.js 四处接线完整。
 * 说明：artSprites.js 顶部 import 浏览器专用 three vendor，Node 下无法直接加载，
 *      故按"源码白名单 + 文件存在性"核对（与其它游戏的美术接入守护口径一致）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = fs.readFileSync(path.join(here, 'artSprites.js'), 'utf8');
const main = fs.readFileSync(path.join(here, '..', 'main.js'), 'utf8');
const fxDir = path.join(here, '..', '..', 'assets', 'fx');

const FX = [
  ['swordqi', 'fx_swordqi.png'],
  ['douqi',   'fx_douqi.png'],
  ['musou',   'fx_musou.png'],
  ['crit',    'fx_crit.png'],
];

test('4 张特效贴图在模块里都有映射定义', () => {
  for (const [kind, file] of FX) {
    assert.match(mod, new RegExp(`${kind}:\\s*\\{`), `缺少 ${kind} 定义`);
    assert.ok(mod.includes(file), `缺少文件名 ${file}`);
  }
});

test('assets/fx 里 4 张 PNG 真实存在、非空且为合法 PNG', () => {
  const magic = [137, 80, 78, 71, 13, 10, 26, 10];
  for (const [, file] of FX) {
    const p = path.join(fxDir, file);
    assert.ok(fs.existsSync(p), `缺少 ${file}`);
    assert.ok(fs.statSync(p).size > 5000, `${file} 文件过小，疑似损坏`);
    assert.deepEqual([...fs.readFileSync(p).subarray(0, 8)], magic, `${file} 不是合法 PNG`);
  }
});

test('main.js 完成四处接线：import / 实例化 / handle / update', () => {
  assert.match(main, /import\s*\{\s*ArtSprites\s*\}/, '缺 import');
  assert.match(main, /new ArtSprites\s*\(/, '缺实例化');
  assert.match(main, /artSprites\.handle\s*\(/, '缺 handle 调用');
  assert.match(main, /artSprites\.update\s*\(/, '缺 update 调用');
});
