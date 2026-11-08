/* esm-to-classic.mjs — 构建期把 ESM 依赖图转成单个 classic <script>
 *
 * 目的：让 <script type="module"> 的游戏在 file:// 双击时不再被 CORS 拦成白屏。
 * 源码零改动；本工具只作用于构建产物。
 *
 * P0 最小版覆盖：多行 import {..} from / import * as ns / 副作用 import / export 声明。
 * 明确拒绝并在报错里标注 P2 的边界：默认导入、export {}/export default/export *、
 * 动态 import、import.meta、new Worker、顶层 await、循环依赖、裸模块说明符。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const IDENT = /^[A-Za-z_$][\w$]*$/;

function parseClause(clause, label) {
  if (clause.startsWith('{')) {
    if (!clause.endsWith('}')) throw new Error(`[esm] ${label}: 命名导入未闭合: ${clause}`);
    const inner = clause.slice(1, -1).trim();
    const bindings = inner
      ? inner.split(',').map((s) => {
          const t = s.trim();
          if (!t) return null;
          const parts = t.split(/\s+as\s+/);
          const remote = parts[0].trim();
          const local = (parts[1] || parts[0]).trim();
          if (!IDENT.test(remote) || !IDENT.test(local)) {
            throw new Error(`[esm] ${label}: 非法绑定名 ${JSON.stringify(t)}`);
          }
          return { remote, local };
        }).filter(Boolean)
      : [];
    return { bindings, star: null, sideEffect: false };
  }
  const star = clause.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
  if (star) return { bindings: [], star: star[1], sideEffect: false };
  throw new Error(
    `[esm] ${label}: P0 暂不支持的 import 形式（默认导入 / 混合导入）: ${JSON.stringify(clause)}\n` +
    `      → 请在 P2 扩展 parseClause`
  );
}

function parseImport(raw, label) {
  const text = raw.trim();
  const m = text.match(/^import\s+([\s\S]*?)\s+from\s*(['"])([^'"]+)\2\s*;?\s*$/);
  if (m) return { spec: m[3], ...parseClause(m[1].trim(), label) };
  const b = text.match(/^import\s*(['"])([^'"]+)\1\s*;?\s*$/);
  if (b) return { spec: b[2], bindings: [], star: null, sideEffect: true };
  throw new Error(`[esm] ${label}: 无法解析 import: ${JSON.stringify(text.slice(0, 140))}`);
}

/* 行状态机：多行 import 逐行累积直到出现 from '...'，避免跨语句贪婪匹配 */
function extractImports(src, label) {
  const lines = src.split(/\r?\n/);
  const outLines = [];
  const imports = [];
  let pending = null;
  const isStart = (l) => /^[ \t]*import\b/.test(l);
  const isComplete = (t) =>
    /\bfrom\s*['"][^'"]+['"]\s*;?[ \t]*$/.test(t) ||
    /^[ \t]*import\s*['"][^'"]+['"]\s*;?[ \t]*$/.test(t);

  for (const line of lines) {
    if (pending !== null) {
      pending += '\n' + line;
      outLines.push('');
      if (isComplete(pending)) {
        imports.push(parseImport(pending, label));
        pending = null;
      }
      continue;
    }
    if (isStart(line)) {
      outLines.push('');
      if (isComplete(line)) imports.push(parseImport(line, label));
      else pending = line;
    } else outLines.push(line);
  }
  if (pending !== null) throw new Error(`[esm] ${label}: import 语句未闭合:\n${pending}`);
  return { body: outLines.join('\n'), imports };
}

function transformExports(body, label) {
  const unsupported = [
    [/^[ \t]*export\s+default\b/m, 'export default'],
    [/^[ \t]*export\s*\{/m, 'export { ... }'],
    [/^[ \t]*export\s*\*/m, 'export * from'],
    [/\bexport\s*\{[\s\S]*?\}\s*from\s*['"]/, 're-export'],
  ];
  for (const [re, what] of unsupported) {
    if (re.test(body)) throw new Error(`[esm] ${label}: P0 暂不支持 ${what}；请在 P2 扩展 transformExports`);
  }
  const exports = [];
  const RE = /^([ \t]*)export\s+((?:async\s+)?function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
  const out = body.replace(RE, (_m, indent, kind, name) => {
    exports.push({ name, mutable: /^(let|var)$/.test(kind) });
    return `${indent}${kind} ${name}`;
  });
  return { body: out, exports };
}

function assertSupported(body, label) {
  const blocked = [
    [/\bimport\s*\(/, '动态 import'],
    [/\bimport\.meta\b/, 'import.meta'],
    [/\bnew\s+Worker\s*\(/, 'Web Worker'],
    [/^\s*await\s+/m, '顶层 await'],
  ];
  for (const [re, what] of blocked) {
    if (re.test(body)) throw new Error(`[esm] ${label}: P0 暂不支持 ${what}；请在 P2 处理`);
  }
}

export function bundle(entryFile, opts = {}) {
  const entry = path.resolve(entryFile);
  if (!fs.existsSync(entry)) throw new Error(`[esm] 入口不存在: ${entry}`);
  const base = path.dirname(entry);
  const modules = new Map();
  const warnings = [];
  const onBare = opts.onBare || null;

  function visit(abs) {
    const key = path.resolve(abs);
    if (modules.has(key)) return;
    const src = fs.readFileSync(key, 'utf8');
    const label = path.relative(base, key).split(path.sep).join('/');
    const { body: noImports, imports } = extractImports(src, label);
    assertSupported(noImports, label);
    const { body, exports } = transformExports(noImports, label);
    const mod = { key, label, body, imports, exports, deps: [], depOfImport: [] };
    modules.set(key, mod);

    for (const im of imports) {
      if (!im.spec.startsWith('.')) {
        if (onBare) { onBare(im.spec, key); continue; }
        throw new Error(
          `[esm] ${label}: 裸模块说明符 ${JSON.stringify(im.spec)} 需要 importmap/vendor 映射（P2 vendor-map.mjs）`
        );
      }
      const dep = path.resolve(path.dirname(key), im.spec);
      if (!fs.existsSync(dep)) throw new Error(`[esm] ${label}: 依赖不存在: ${dep}`);
      mod.deps.push(dep);
      mod.depOfImport.push({ im, dep });
      visit(dep);
    }
  }
  visit(entry);

  /* 拓扑排序 + 循环依赖硬失败 */
  const order = [];
  const state = new Map(); // 0=未访问 1=访问中 2=完成
  function dfs(key, stack) {
    if (state.get(key) === 2) return;
    if (state.get(key) === 1) {
      const chain = [...stack.slice(stack.indexOf(key)), key]
        .map((k) => modules.get(k).label).join(' -> ');
      throw new Error(`[esm] 检测到循环依赖: ${chain}\n      → P2 需要 SCC 两阶段注入；P0 拒绝静默降级`);
    }
    state.set(key, 1);
    for (const d of modules.get(key).deps) dfs(d, [...stack, key]);
    state.set(key, 2);
    order.push(key);
  }
  for (const key of modules.keys()) dfs(key, []);

  const idOf = (key) => path.relative(base, key).split(path.sep).join('/');
  const chunks = [
    '/* generated by tools/esm-to-classic.mjs — 请勿手工编辑 */',
    '(function () {',
    "  'use strict';",
    '  var __MG = globalThis.__MG || (globalThis.__MG = Object.create(null));',
  ];

  for (const key of order) {
    const mod = modules.get(key);
    const id = idOf(key);
    chunks.push(`  /* ==== ${id} ==== */`);
    chunks.push(`  __MG[${JSON.stringify(id)}] = {};`);
    chunks.push('  (function () {');
    mod.depOfImport.forEach(({ im, dep }) => {
      const depId = JSON.stringify(idOf(dep));
      if (im.sideEffect) return;
      if (im.star) { chunks.push(`    var ${im.star} = __MG[${depId}];`); return; }
      if (!im.bindings.length) return;
      const parts = im.bindings.map((b) => (b.remote === b.local ? b.local : `${b.remote}: ${b.local}`));
      chunks.push(`    var { ${parts.join(', ')} } = __MG[${depId}];`);
    });
    chunks.push(mod.body);
    for (const e of mod.exports) {
      if (e.mutable) warnings.push(`${id}: export ${e.name} 是 let/var，命名空间赋值只在模块执行末尾生效`);
      chunks.push(`    __MG[${JSON.stringify(id)}][${JSON.stringify(e.name)}] = ${e.name};`);
    }
    chunks.push('  })();');
  }
  chunks.push('})();');
  const code = chunks.join('\n');

  /* 只编译不执行：立刻暴露转换产生的语法错误 */
  try { new vm.Script(code, { filename: 'bundle.classic.js' }); }
  catch (e) { throw new Error(`[esm] 产物语法校验失败: ${e.message}`); }

  return { code, modules: order.map((k) => idOf(k)), warnings, entry: idOf(entry) };
}

if (process.argv[1] && process.argv[1].endsWith('esm-to-classic.mjs')) {
  const args = process.argv.slice(2);
  const entry = args.find((a) => !a.startsWith('--'));
  const out = (args.find((a) => a.startsWith('--out=')) || '').slice(6);
  if (!entry) {
    console.error('用法: node tools/esm-to-classic.mjs <entry.mjs> [--out=<bundle.js>]');
    process.exit(2);
  }
  try {
    const r = bundle(entry);
    if (out) fs.writeFileSync(out, r.code, 'utf8');
    console.log(`=== ESM→classic 转换成功 ===`);
    console.log(`入口: ${r.entry}`);
    console.log(`模块 (${r.modules.length}): ${r.modules.join(', ')}`);
    console.log(`产物字节: ${Buffer.byteLength(r.code, 'utf8')}`);
    for (const w of r.warnings) console.log(`WARN  ${w}`);
    if (out) console.log(`已写出: ${out}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
