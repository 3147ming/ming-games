/* verify-all.mjs — 全站验证统一入口（deploy.config.json 的 build.verify 指向这里）
 *
 * 分三层，默认只跑第一层（秒级，可进 CI）：
 *   静态门禁   部署写目标 / quiz 产物与 SW 一致性 / 三形态产物完整性
 *   --unit     Node 侧单元测试（错题本、资源层、vendor 映射）
 *   --browser  无头 Edge 三形态验收（真实浏览器，慢，需要本机浏览器）
 *   --all      三层全跑
 *
 * 用法：
 *   node tools/verify-all.mjs
 *   node tools/verify-all.mjs --unit
 *   node tools/verify-all.mjs --all
 *   node tools/verify-all.mjs --target=all --unit --report   （兼容 deploy.config.json 的旧调用）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const UNIT = has('--unit') || has('--all');
const BROWSER = has('--browser') || has('--all');
/* --target / --report 是历史调用参数：target 由构建脚本自己决定，report 恒开 */
const TARGET = (argv.find((a) => a.startsWith('--target=')) || '--target=all').split('=')[1];

const results = [];
function run(label, file, args, opts = {}) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(ROOT, file), ...args], {
    cwd: ROOT, stdio: 'inherit', timeout: opts.timeout || 600000
  });
  const ms = Date.now() - started;
  const ok = r.status === 0 && !r.error;
  results.push({ label, ok, ms, note: r.error ? String(r.error.message || r.error) : '' });
  if (!ok) console.log(`\n[FAIL] ${label}（${ms} ms）${r.error ? '：' + r.error.message : ''}\n`);
  return ok;
}

console.log(`=== 1/3 静态门禁（target=${TARGET}） ===`);
run('部署写目标门禁', 'tools/check-deploy.mjs', []);
run('quiz 产物一致性（产物/部署包/SW/dist）', 'quiz/.build/build.js', ['--check']);
run('三形态产物完整性', 'tools/check-artifacts.mjs', []);

if (UNIT) {
  console.log('\n=== 2/3 单元测试 ===');
  run('错题本 pure functions', 'quiz/tests/wrongbook.test.mjs', []);
  run('资源本地化层', 'tools/build-assets.test.mjs', []);
  run('vendor 映射', 'tools/vendor-map.test.mjs', []);
}

if (BROWSER) {
  console.log('\n=== 3/3 无头浏览器验收 ===');
  run('三形态真实浏览器验收', 'tools/verify-p0.mjs', [], { timeout: 900000 });
}

const bad = results.filter((r) => !r.ok);
console.log('\n=== 验证汇总 ===');
results.forEach((r) => console.log(`${r.ok ? '✓' : '✗'} ${r.label}  ${r.ms} ms`));
console.log(bad.length ? `\n未通过 ${bad.length}/${results.length} 项` : `\n全部通过（${results.length} 项）`);
process.exit(bad.length ? 1 : 0);
