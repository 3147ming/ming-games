/* esm-semantics.mjs — ESM → classic 产物与原生 ESM 的语义对照工具
 *
 * 用法：node tools/esm-semantics.mjs --game=<id>
 *   id ∈ { pixel-runner, neon-rhythm, circuit-lab, wild }
 *   （不带 --game 时依次跑全部 4 个）
 *
 * 做法：
 *   1) 对游戏的每个模块，用 Node 原生动态 import() 加载源 ESM 得到导出快照（golden）。
 *      源模块若有 DOM 依赖导致 import 失败 → 如实列入 uncovered[]，不假装通过。
 *   2) 在 vm 里执行 bundle() 产物，取 globalThis.__MG[*] 快照。
 *   3) 逐模块断言导出「键集合」与「值」相等（跨 realm 用 describe() 归一化）。
 *   4) 可写导出做「读 → 重新赋值 → 再读」三步对照（合成 live-binding 用例）。
 *   5) circuit-lab 的 app.js:1713 断言「不是顶层 await」。
 *
 * 输出：=== 语义对照：X/Y 通过，uncovered: [...] ===
 *   - uncovered > 0 只报告，不 exit(1)
 *   - 语法 / 值不等价 → exit(1)
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundle, isTopLevelAwait } from './esm-to-classic.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const GAMES = {
  'pixel-runner': 'pixel-runner/src/ui.mjs',
  'neon-rhythm': 'neon-rhythm/src/ui.mjs',
  'circuit-lab': 'circuit-lab/js/app.js',
  wild: 'wild/src/main.js',
};

/* -------------------------------------------------------------------------
 * 跨 realm 的值归一化：把任意值转成可比较的规范字符串
 *   函数：跨 realm 无法 ===，用 name+length（body 的 live 改写不改变这两者）
 *   对象/数组/Map/Set：结构化递归（带环检测）
 * ------------------------------------------------------------------------- */
function describe(v, seen = new Set()) {
  const t = typeof v;
  if (v === null) return 'null';
  if (t === 'undefined') return 'undefined';
  if (t === 'number') {
    if (Number.isNaN(v)) return 'number:NaN';
    if (v === Infinity) return 'number:Infinity';
    if (v === -Infinity) return 'number:-Infinity';
    if (v === 0 && 1 / v === -Infinity) return 'number:-0';
    return 'number:' + v;
  }
  if (t === 'string') return 'string:' + JSON.stringify(v);
  if (t === 'boolean') return 'boolean:' + v;
  if (t === 'bigint') return 'bigint:' + v.toString();
  if (t === 'symbol') return 'symbol:' + String(v);
  if (t === 'function') {
    let name = '';
    let len = 0;
    try { name = v.name; } catch { /* ignore */ }
    try { len = v.length; } catch { /* ignore */ }
    return `function:${name}:${len}`;
  }
  const tag = Object.prototype.toString.call(v);
  if (tag === '[object Date]') return 'Date:' + (Number.isNaN(v.getTime()) ? 'Invalid' : v.getTime());
  if (tag === '[object RegExp]') return 'RegExp:' + v.source + '/' + v.flags;
  if (seen.has(v)) return '[Circular]';
  seen.add(v);
  let s;
  if (tag === '[object Map]') {
    const parts = [];
    try { for (const [k, val] of v) parts.push(describe(k, seen) + '=>' + describe(val, seen)); } catch { /* ignore */ }
    s = 'Map{' + parts.sort().join(',') + '}';
  } else if (tag === '[object Set]') {
    const parts = [];
    try { for (const val of v) parts.push(describe(val, seen)); } catch { /* ignore */ }
    s = 'Set{' + parts.sort().join(',') + '}';
  } else {
    let keys = [];
    try { keys = Object.keys(v).sort(); } catch { /* ignore */ }
    const parts = keys.map((k) => {
      let val;
      try { val = v[k]; } catch (e) { return k + '=<' + e.name + '>'; }
      return k + '=' + describe(val, seen);
    });
    s = (Array.isArray(v) ? 'Array' : tag) +
        (Array.isArray(v) ? '[' + v.length + ']' : '') +
        '{' + parts.join(',') + '}';
  }
  seen.delete(v);
  return s;
}

/* 在 vm 里执行 bundle 产物，返回 __MG 快照（入口因 DOM 抛错会被捕获，
 * 抛错前所有依赖模块已求值，恰好与「DOM 模块 uncovered」对齐） */
function runBundleInVm(code) {
  const sandbox = {};
  for (const k of ['console', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    'queueMicrotask', 'TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams',
    'performance', 'navigator', 'structuredClone']) {
    if (globalThis[k] !== undefined) sandbox[k] = globalThis[k];
  }
  vm.createContext(sandbox);
  let execError = null;
  try {
    vm.runInContext(code, sandbox, { timeout: 30000 });
  } catch (e) {
    execError = e;
  }
  return { mg: sandbox.__MG || {}, execError };
}

async function loadGolden(absPath) {
  try {
    const ns = await import(pathToFileURL(absPath).href);
    return { ok: true, ns };
  } catch (e) {
    return { ok: false, error: e };
  }
}

/* 可写导出「读→重新赋值→再读」三步对照（合成 live-binding 用例） */
async function liveBindingCheck() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-live-'));
  const dep = path.join(dir, 'dep.mjs');
  const entry = path.join(dir, 'entry.mjs');
  fs.writeFileSync(dep,
    'export let counter = 1;\n' +
    'export function bump(v) { counter = v; }\n', 'utf8');
  fs.writeFileSync(entry,
    "import { counter, bump } from './dep.mjs';\n" +
    'export function read() { return counter; }\n' +
    'export { bump };\n', 'utf8');
  let pass = false;
  const detail = [];
  try {
    // golden：原生 ESM 的 live binding
    const gDep = await import(pathToFileURL(dep).href);
    const gEntry = await import(pathToFileURL(entry).href);
    const g1 = gEntry.read();
    gEntry.bump(2);
    const g2 = gEntry.read();
    const gDepCounter = gDep.counter;
    // bundle：vm 里的产物
    const r = bundle(entry);
    const { mg } = runBundleInVm(r.code);
    const eId = path.basename(entry);
    const dId = path.basename(dep);
    const bEntry = mg[eId];
    const bDep = mg[dId];
    const b1 = bEntry.read();
    bEntry.bump(2);
    const b2 = bEntry.read();
    const bDepCounter = bDep.counter;
    detail.push(`golden read/bump/read = ${g1}/${gDepCounter}/${g2}`);
    detail.push(`bundle read/bump/read = ${b1}/${bDepCounter}/${b2}`);
    pass = (g1 === b1 && g2 === b2 && gDepCounter === bDepCounter &&
      g1 === 1 && g2 === 2 && gDepCounter === 2 && b1 === 1 && b2 === 2 && bDepCounter === 2);
  } catch (e) {
    detail.push('异常: ' + e.message);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return { pass, detail };
}

/* circuit-lab：app.js:1713 的 await 必须被识别为「函数体内」而非顶层 */
function topLevelAwaitCheck() {
  const file = path.join(ROOT, 'circuit-lab/js/app.js');
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split(/\r?\n/);
  const line1713 = lines[1712] || '';
  const whole = isTopLevelAwait(src);
  return {
    pass: !whole && /\bawait\b/.test(line1713),
    detail: [
      `isTopLevelAwait(app.js 全文) = ${whole}（应为 false）`,
      `app.js:1713 = ${JSON.stringify(line1713.trim())}（应为含 await 的函数体内语句）`,
    ],
  };
}

async function compareGame(gameId) {
  const rel = GAMES[gameId];
  const entryAbs = path.join(ROOT, rel);
  const base = path.dirname(entryAbs);
  const lines = [];
  lines.push(`[语义对照] game=${gameId}  entry=${rel}`);

  // 1) 转换（失败即语法/转换不等价 → exit 1）
  let r;
  try {
    r = bundle(entryAbs);
  } catch (e) {
    lines.push(`转换失败: ${e.message}`);
    printAndReturn(gameId, lines, 0, 0, [], 1);
    return 1;
  }
  lines.push(`模块数 ${r.modules.length}，产物 ${Buffer.byteLength(r.code, 'utf8')} 字节，warnings ${r.warnings.length}`);

  // 2) 逐模块加载 golden（原生 import()）
  const golden = new Map();
  const uncovered = [];
  for (const id of r.modules) {
    const abs = path.resolve(base, id);
    const g = await loadGolden(abs);
    if (g.ok) golden.set(id, g.ns);
    else uncovered.push(id);
  }

  // 3) vm 执行产物
  const { mg, execError } = runBundleInVm(r.code);
  if (execError) lines.push(`vm 执行在入口处终止（DOM 依赖，符合预期）: ${execError.name}: ${execError.message.slice(0, 80)}`);

  // 4) 逐模块断言键集合 + 值
  let passed = 0;
  let failed = 0;
  const failures = [];
  for (const [id, gns] of golden) {
    const bns = mg[id];
    if (!bns) { failed++; failures.push(`${id}: 产物缺少 __MG[${id}]`); continue; }
    let gKeys, bKeys;
    try { gKeys = Object.keys(gns).sort(); } catch (e) { failed++; failures.push(`${id}: golden keys 抛错 ${e.message}`); continue; }
    try { bKeys = Object.keys(bns).sort(); } catch (e) { failed++; failures.push(`${id}: bundle keys 抛错 ${e.message}`); continue; }
    let modOk = true;
    if (gKeys.join('\u0000') !== bKeys.join('\u0000')) {
      modOk = false;
      failures.push(`${id}: 导出键集合不等 golden=[${gKeys}] bundle=[${bKeys}]`);
    }
    for (const k of gKeys) {
      let gv, bv;
      try { gv = gns[k]; } catch (e) { modOk = false; failures.push(`${id}.${k}: golden 读取抛错 ${e.name}`); continue; }
      try { bv = bns[k]; } catch (e) { modOk = false; failures.push(`${id}.${k}: bundle 读取抛错 ${e.name}`); continue; }
      const dg = describe(gv);
      const db = describe(bv);
      if (dg !== db) {
        modOk = false;
        failures.push(`${id}.${k}: 值不等 golden=${dg.slice(0, 120)} bundle=${db.slice(0, 120)}`);
      }
    }
    if (modOk) passed++;
    else failed++;
  }

  // 5) 可写导出三步对照（合成用例，验证 live binding 机制）
  const live = await liveBindingCheck();
  lines.push(`live-binding 三步对照: ${live.pass ? 'PASS' : 'FAIL'}`);
  for (const d of live.detail) lines.push('  ' + d);

  // 6) circuit-lab 专属：app.js:1713 非顶层 await
  let tla = null;
  if (gameId === 'circuit-lab') {
    tla = topLevelAwaitCheck();
    lines.push(`app.js:1713 非顶层 await 断言: ${tla.pass ? 'PASS' : 'FAIL'}`);
    for (const d of tla.detail) lines.push('  ' + d);
  }

  for (const f of failures.slice(0, 30)) lines.push('  MISMATCH ' + f);
  if (failures.length > 30) lines.push(`  ... 另有 ${failures.length - 30} 条 MISMATCH`);

  const exitCode = (failed > 0 || !live.pass || (tla && !tla.pass)) ? 1 : 0;
  printAndReturn(gameId, lines, passed, r.modules.length, uncovered, exitCode);
  return exitCode;
}

function printAndReturn(gameId, lines, passed, total, uncovered, exitCode) {
  for (const l of lines) console.log(l);
  const fmt = `[${uncovered.map((u) => "'" + u + "'").join(', ')}]`;
  console.log(`=== 语义对照：${passed}/${total} 通过，uncovered: ${fmt} ===`);
  if (exitCode) console.log(`（存在不等价项，exit 1；uncovered ${uncovered.length} 个仅报告、不判失败）`);
  else console.log(`（键集合与值全部等价；uncovered ${uncovered.length} 个仅报告、不判失败）`);
}

async function main() {
  const args = process.argv.slice(2);
  const gameArg = (args.find((a) => a.startsWith('--game=')) || '').slice(7);
  let games;
  if (gameArg) {
    if (!GAMES[gameArg]) {
      console.error(`未知 game: ${gameArg}，可选: ${Object.keys(GAMES).join(', ')}`);
      process.exit(2);
    }
    games = [gameArg];
  } else {
    games = Object.keys(GAMES);
  }
  let worst = 0;
  for (const g of games) {
    if (games.length > 1) console.log('');
    worst = Math.max(worst, await compareGame(g));
  }
  process.exit(worst);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
