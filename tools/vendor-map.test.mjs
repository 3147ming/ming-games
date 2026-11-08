/* tools/vendor-map.test.mjs
 *
 * vendor-map.mjs 语义对照自测：
 *   1) 用 Node 原生 import() 加载「原始 ESM build」取导出键集合（golden）；
 *   2) 在 vm 里执行 threeToClassic 生成的 classic code 取 globalThis.THREE 键集合；
 *   3) 断言两集合相等；vm 执行失败如实列入 uncovered[]，不假装通过。
 *
 * 只新建本文件；不修改仓库其它文件。临时产物写系统 temp 目录。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { threeToClassic, analyzeFeatures } from './vendor-map.mjs';

const ROOT = 'D:/Projects/_github_pages/ming-games';
const FILES = [
  `${ROOT}/soudache/vendor/three.module.js`,
  `${ROOT}/warehouse-strike/vendor/three/three.module.js`,
  `${ROOT}/grass-cutter/vendor/three/three.module.full.js`,
];
const COMMON = ['Vector3', 'WebGLRenderer', 'Scene', 'PerspectiveCamera',
  'BufferGeometry', 'Mesh', 'Group', 'Texture', 'Color', 'MathUtils'];

const silentConsole = { log() {}, warn() {}, error() {}, info() {}, debug() {}, dir() {} };

let pass = 0;
const uncovered = [];
const details = [];

/* golden：直接 import() 原始 .js（Node 22 默认模块检测可加载 ESM）；
   若某环境按 CJS 解析失败，则复制为 temp .mjs 后 import() 作为 fallback。 */
async function golden(file) {
  try {
    const mod = await import(pathToFileURL(file).href);
    return { keys: Object.keys(mod).sort(), via: 'import() 直接加载 .js', warn: '' };
  } catch (e1) {
    const tmp = path.join(os.tmpdir(), `vmgolden_${Math.random().toString(36).slice(2)}.mjs`);
    try {
      fs.writeFileSync(tmp, fs.readFileSync(file));
      const mod = await import(pathToFileURL(tmp).href + `?t=${Date.now()}`);
      return {
        keys: Object.keys(mod).sort(),
        via: '复制为 temp .mjs 后 import()（fallback）',
        warn: String(e1.message).split('\n')[0],
      };
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }
}

/* vm 最小 stub：three 顶层用 typeof 守卫 + window.__THREE__ 赋值，
   提供浏览器全局的最小对象即可；不给足导致执行失败时如实计入 uncovered。 */
function minimalSandbox() {
  const win = {
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    devicePixelRatio: 1, innerWidth: 1024, innerHeight: 768,
  };
  const el = () => ({ style: {}, getContext: () => null, setAttribute() {}, addEventListener() {} });
  const doc = {
    createElementNS: el, createElement: el,
    addEventListener() {}, removeEventListener() {},
    documentElement: { style: {} }, body: { style: {} },
  };
  return {
    console: silentConsole,
    window: win, self: win, top: win, parent: win,
    document: doc,
    navigator: { userAgent: 'node-vm', platform: '' },
    location: { href: 'file:///' },
    URL, TextDecoder, TextEncoder, performance,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    Image: class {}, ImageData: class {}, HTMLCanvasElement: class {},
    OffscreenCanvas: class {}, WebGLRenderingContext: class {},
  };
}

function classicKeys(code) {
  const sandbox = minimalSandbox();
  const ctx = vm.createContext(sandbox);
  vm.runInContext(code, ctx, { filename: 'three.classic.js' });
  const ns = vm.runInContext('globalThis.THREE', ctx);
  if (!ns || typeof ns !== 'object') throw new Error('globalThis.THREE 未生成或不是对象');
  return Object.keys(ns).sort();
}

for (const file of FILES) {
  const label = path.relative(ROOT, file).split(path.sep).join('/');
  let g, r, ck;
  try {
    g = await golden(file);
    r = threeToClassic(file);
    ck = classicKeys(r.code);
  } catch (e) {
    const reason = String(e.message).split('\n')[0];
    uncovered.push({ file: label, reason });
    details.push({ label, error: reason });
    continue;
  }
  const setEq = g.keys.length === ck.length && g.keys.every((k, i) => k === ck[i]);
  const goldenOnly = g.keys.filter((k) => !ck.includes(k));
  const classicOnly = ck.filter((k) => !g.keys.includes(k));
  const missingCommon = COMMON.filter((k) => !ck.includes(k));
  const feat = analyzeFeatures(r.code);
  details.push({
    label,
    exportCount: r.exports.length,
    bytes: r.bytes,
    goldenCount: g.keys.length,
    classicCount: ck.length,
    setEq, goldenOnly, classicOnly, missingCommon,
    features: feat,
    hasCR: r.code.includes('\r'),
    warnings: r.warnings,
    exportStatements: r.stats.exportStatements,
    goldenVia: g.via,
    goldenWarn: g.warn,
  });
  if (setEq) pass++;
  else uncovered.push({
    file: label,
    reason: `键集合不等: golden=${g.keys.length} classic=${ck.length} ` +
      `golden-only=[${goldenOnly.slice(0, 8).join(',')}] classic-only=[${classicOnly.slice(0, 8).join(',')}]`,
  });
}

console.log('=== vendor-map 语义对照自测 ===');
for (const d of details) {
  console.log(`\n--- ${d.label} ---`);
  if (d.error) { console.log(`  失败: ${d.error}`); continue; }
  console.log(`  导出数(exports): ${d.exportCount} | 产物字节: ${d.bytes} | 含 CR: ${d.hasCR}`);
  console.log(`  golden 键数: ${d.goldenCount} | classic 键数: ${d.classicCount} | 集合相等: ${d.setEq ? '是' : '否'}`);
  console.log(`  golden 加载方式: ${d.goldenVia}${d.goldenWarn ? '（direct 失败: ' + d.goldenWarn + '）' : ''}`);
  const f = d.features;
  console.log(`  产物特性: import.meta=${f.importMeta} 动态import=${f.dynamicImport} 顶层await=${f.topLevelAwait} 静态import=${f.staticImport}`);
  console.log(`  常见键缺失: ${d.missingCommon.length ? d.missingCommon.join(', ') : '无（10/10 齐全）'}`);
  console.log(`  export 语句 (${d.exportStatements.length}): ${d.exportStatements.map((s) => '[' + s.form + ']').join(' ')}`);
  for (const w of d.warnings) console.log(`  WARN  ${w}`);
}
console.log(`\n=== 语义对照：${pass}/${FILES.length} 通过，uncovered: [${uncovered.map((u) => u.file).join(', ')}] ===`);
if (uncovered.length) {
  console.log('uncovered 原因明细:');
  for (const u of uncovered) console.log(`  - ${u.file}: ${u.reason}`);
}
