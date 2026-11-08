/* tools/vendor-map.mjs
 *
 * 把 three 的 ESM build（three.module.js / three.module.full.js）转换成
 * 「挂 globalThis.THREE 的 classic script」，供 file:// 双击可玩的主构建链使用。
 *
 * 背景：three vendor 是压缩过的超长单行 ESM（670KB / 1.27MB），末尾是
 * `export{a as B,c as D,...};`，`export{` 常不在行首，通用 esm-to-classic
 * 转换器处理不了（产物语法校验报 Unexpected token 'export'）。因此本工具
 * 单独转换 three，不把它塞进依赖图；游戏代码里的
 * `import * as THREE from 'three'` 由主构建器改写成读 globalThis.THREE。
 *
 * 写权限：本文件为新建文件，不 import / 不修改仓库其它文件。
 * 换行：读入统一为 LF，产物全部用 \n 拼接，fs.writeFileSync(...,'utf8')。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const IDENT = /^[A-Za-z_$][\w$]*$/;

/* ------------------------------------------------------------------------
 * 精简词法器（自实现，借鉴 esm-to-classic.mjs 的 lex() 思路，但不 import 它）
 * 产出 [{kind, raw, start, end}]，kind:
 *   ws | comment | str | template | regex | num | id | punc
 * 字符串 / 模板 / 正则 / 注释整段作为「不可改写」token，定位顶层 export 时跳过，
 * 保证不会误伤其中的 `export` 字样。
 * ------------------------------------------------------------------------ */
export function lex(src) {
  const toks = [];
  const n = src.length;
  let i = 0;
  let prevSig = null; // 上一个非空白/非注释 token 的 raw，用于判定正则起点
  const isIdStart = (c) => c !== undefined && /[A-Za-z_$]/.test(c);
  const isIdPart = (c) => c !== undefined && /[A-Za-z0-9_$]/.test(c);
  const emit = (kind, start, end) => {
    const raw = src.slice(start, end);
    toks.push({ kind, raw, start, end });
    if (kind !== 'ws' && kind !== 'comment') prevSig = raw;
  };
  const canRegex = (prev) => {
    if (prev === null) return true;
    if (/^[A-Za-z_$][\w$]*$/.test(prev)) {
      return ['return', 'case', 'throw', 'typeof', 'instanceof', 'in', 'of',
        'new', 'delete', 'void', 'yield', 'await', 'do', 'else'].includes(prev);
    }
    if (/^[0-9]/.test(prev)) return false;
    if (prev === ')' || prev === ']' || prev === '}') return false;
    return true;
  };
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    // 空白
    if (/\s/.test(c)) {
      let j = i + 1;
      while (j < n && /\s/.test(src[j])) j++;
      emit('ws', i, j); i = j; continue;
    }
    // 行注释 / 块注释
    if (c === '/' && c2 === '/') {
      let j = i + 2;
      while (j < n && src[j] !== '\n') j++;
      emit('comment', i, j); i = j; continue;
    }
    if (c === '/' && c2 === '*') {
      const end = src.indexOf('*/', i + 2);
      const j = end < 0 ? n : end + 2;
      emit('comment', i, j); i = j; continue;
    }
    // 普通字符串
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) { j++; break; }
        if (src[j] === '\n') break;
        j++;
      }
      emit('str', i, j); i = j; continue;
    }
    // 模板字符串：整体作为一个不可改写 token 跳过。
    // 只做「反引号配对 + 反斜杠转义」：`${...}` 插值内容也一并当字面文本跳过。
    // 理由：GLSL 模板里既有 ${...} 插值又有大量普通 {} 花括号，用 ${} 深度
    // 计数会把二者混在一起导致模板边界错位（实测会吞掉后续数百 KB 真实代码）。
    // export 语句不可能出现在模板/插值内部，整体跳过既安全又与真实解析一致。
    if (c === '`') {
      let j = i + 1;
      while (j < n) {
        const ch = src[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '`') { j++; break; }
        j++;
      }
      emit('template', i, j); i = j; continue;
    }
    // 正则字面量
    if (c === '/' && canRegex(prevSig)) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        const ch = src[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) { j++; break; }
        else if (ch === '\n') break;
        j++;
      }
      while (j < n && /[a-z]/i.test(src[j])) j++;
      emit('regex', i, j); i = j; continue;
    }
    // 标识符 / 关键字
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdPart(src[j])) j++;
      emit('id', i, j); i = j; continue;
    }
    // 数字
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9a-fA-FxXoObB._eE+-]/.test(src[j])) {
        if ((src[j] === '+' || src[j] === '-') && !/[eE]/.test(src[j - 1])) break;
        j++;
      }
      emit('num', i, j); i = j; continue;
    }
    // 多字符运算符
    if (c === '=' && c2 === '>') { emit('punc', i, i + 2); i += 2; continue; }
    // 单字符标点 / 运算符
    emit('punc', i, i + 1); i++;
  }
  return toks;
}

/* 还原「仅代码区」文本：字符串/模板/正则/注释用等长空格替换（保留换行），
   供正则兜底断言使用，避免误伤其中的 `export` 字样。 */
export function codeOnly(toks) {
  let out = '';
  for (const t of toks) {
    if (t.kind === 'str' || t.kind === 'template' || t.kind === 'regex' || t.kind === 'comment') {
      out += t.raw.replace(/[^\n]/g, ' ');
    } else {
      out += t.raw;
    }
  }
  return out;
}

/* 兜底断言：产物中不得残留 export 关键字（正则 + 代码区文本） */
function assertNoExportKeyword(code) {
  const re = /\bexport\s*(?:\{|default\b|const\b|let\b|var\b|function\b|class\b|async\b|\*)/;
  if (re.test(codeOnly(lex(code)))) {
    throw new Error('[vendor-map] 产物仍残留未处理的 export 关键字');
  }
}

/* ------------------------------------------------------------------------
 * 特性扫描：import.meta / 动态 import / 静态 import / 顶层 await
 * 基于词法 token，跳过字符串/模板/正则/注释。
 * ------------------------------------------------------------------------ */
export function analyzeFeatures(src) {
  const sig = lex(src).filter((t) => t.kind !== 'ws' && t.kind !== 'comment');
  let importMeta = 0, dynamicImport = 0, staticImport = 0, topLevelAwait = 0;
  let depth = 0;
  for (let k = 0; k < sig.length; k++) {
    const t = sig[k];
    const prev = k > 0 ? sig[k - 1] : null;
    const next = sig[k + 1];
    if (t.kind === 'punc' && (t.raw === '{' || t.raw === '[' || t.raw === '(')) depth++;
    else if (t.kind === 'punc' && (t.raw === '}' || t.raw === ']' || t.raw === ')')) depth = Math.max(0, depth - 1);
    const isMember = prev && prev.kind === 'punc' && (prev.raw === '.' || prev.raw === '?.');
    if (t.kind === 'id' && t.raw === 'import' && !isMember) {
      if (next && next.kind === 'punc' && next.raw === '.') importMeta++;
      else if (next && next.kind === 'punc' && next.raw === '(') dynamicImport++;
      else staticImport++;
    }
    if (t.kind === 'id' && t.raw === 'await' && depth === 0) topLevelAwait++;
  }
  return { importMeta, dynamicImport, staticImport, topLevelAwait };
}

/* ------------------------------------------------------------------------
 * 定位并解析所有顶层 export 语句
 *   - 返回 edits（源码字符区间替换）、bindings（local->exported）、
 *     statements（形态记录）、defaultRef（export default 的局部变量名）
 *   - 多个 export 语句全部处理并合并，不只处理最后一个
 * ------------------------------------------------------------------------ */
function extractExports(src, toks, warnings) {
  const sig = toks.filter((t) => t.kind !== 'ws' && t.kind !== 'comment');
  const edits = [];
  const bindings = [];
  const statements = [];
  let defaultRef = null;
  const brief = (s) => s.slice(0, 200).replace(/\s+/g, ' ');

  function findMatchingBrace(openIdx) {
    let d = 0;
    for (let k = openIdx; k < sig.length; k++) {
      const r = sig[k].raw;
      if (r === '{') d++;
      else if (r === '}') { d--; if (d === 0) return k; }
    }
    return -1;
  }

  /* 解析具名导出列表 { A, B as C, ... }（token 序列，不含外层 {}） */
  function parseBindings(inner) {
    let seg = [];
    const flush = () => {
      if (!seg.length) return;
      // 绑定形如 `A` 或 `A as B`。注意压缩器可能把局部变量命名为 `as`
      // （例：`as as DataUtils` 表示 local=as, exported=DataUtils），
      // 因此不能简单 find 第一个 `as` 当关键字，要看第 2 个 id 是否为 `as`。
      const ids = seg.filter((t) => t.kind === 'id').map((t) => t.raw);
      let local, exported;
      if (ids.length >= 2 && ids[1] === 'as') {
        local = ids[0];
        exported = ids[2]; // `X as "字符串名"` 时无第 3 个 id -> undefined -> warning
      } else {
        local = ids[0];
        exported = ids[0];
      }
      if (local === 'default') {
        // 无 from 的 `export { default as X }` 不合法，且会生成 `= default` 的非法代码
        warnings.push(`跳过非法绑定（local 为 default 保留字）: ${brief(seg.map((t) => t.raw).join(' '))}`);
      } else if (local && exported && IDENT.test(local) && IDENT.test(exported)) {
        bindings.push({ local, exported });
      } else {
        warnings.push(`无法解析的 export 绑定（已跳过该名）: ${brief(seg.map((t) => t.raw).join(' '))}`);
      }
      seg = [];
    };
    let d = 0;
    for (const t of inner) {
      if (t.kind === 'punc') {
        if (t.raw === '{' || t.raw === '[' || t.raw === '(') d++;
        else if (t.raw === '}' || t.raw === ']' || t.raw === ')') d = Math.max(0, d - 1);
        else if (t.raw === ',' && d === 0) { flush(); continue; }
      }
      seg.push(t);
    }
    flush();
  }

  /* export const/let/var 的绑定名（支持 a=1,b=2；解构返回空并 warning） */
  function collectVarNames(from) {
    const names = [];
    let d = 0, expectName = true;
    for (let k = from; k < sig.length; k++) {
      const t = sig[k];
      if (t.kind === 'punc') {
        if (t.raw === '{' || t.raw === '[' || t.raw === '(') { d++; continue; }
        if (t.raw === '}' || t.raw === ']' || t.raw === ')') { d = Math.max(0, d - 1); continue; }
        if (d === 0 && t.raw === ';') break;
        if (d === 0 && t.raw === ',') { expectName = true; continue; }
        if (d === 0 && t.raw === '=') { expectName = false; continue; }
        continue;
      }
      if (t.kind === 'id' && d === 0 && expectName) { names.push(t.raw); expectName = false; }
    }
    return names;
  }

  /* function / class / async function 的声明名 */
  function firstDeclName(from) {
    for (let k = from; k < sig.length; k++) {
      const t = sig[k];
      if (t.kind === 'id' && t.raw === 'function') continue; // async function
      if (t.kind === 'punc' && t.raw === '*') continue;      // function*
      if (t.kind === 'id') return t.raw;
      return null; // 匿名 class / 其它，无法确定
    }
    return null;
  }

  let i = 0;
  let depth = 0; // 顶层深度；export 语句只可能在 depth 0
  while (i < sig.length) {
    const t = sig[i];
    if (t.kind === 'punc' && (t.raw === '{' || t.raw === '[' || t.raw === '(')) depth++;
    else if (t.kind === 'punc' && (t.raw === '}' || t.raw === ']' || t.raw === ')')) depth = Math.max(0, depth - 1);

    if (t.kind === 'id' && t.raw === 'export' && depth === 0) {
      const prev = i > 0 ? sig[i - 1] : null;
      const isMember = prev && prev.kind === 'punc' && (prev.raw === '.' || prev.raw === '?.');
      const next = sig[i + 1];
      if (!isMember && next) {
        // A) export { ... }  （含 export { ... } from '...'）
        if (next.kind === 'punc' && next.raw === '{') {
          const close = findMatchingBrace(i + 1);
          if (close < 0) {
            warnings.push('export { ... } 未闭合，无法确定边界，已保留原样');
            i++; continue;
          }
          let j = close + 1;
          let isReexport = false;
          if (sig[j] && sig[j].kind === 'id' && sig[j].raw === 'from') {
            isReexport = true; j++;
            if (sig[j] && sig[j].kind === 'str') j++;
            if (sig[j] && sig[j].kind === 'punc' && sig[j].raw === ';') j++;
          } else if (sig[j] && sig[j].kind === 'punc' && sig[j].raw === ';') {
            j++;
          }
          const stmtEnd = sig[j - 1] ? sig[j - 1].end : sig[close].end;
          const rawHead = src.slice(t.start, Math.min(stmtEnd, t.start + 400));
          edits.push({ start: t.start, end: stmtEnd, text: '' });
          statements.push({ form: isReexport ? 're-export {..} from' : 'named export list', raw: brief(rawHead) });
          if (isReexport) {
            warnings.push(`re-export 需主构建器处理: ${brief(rawHead)}`);
          } else {
            parseBindings(sig.slice(i + 2, close));
          }
          i = j; continue;
        }
        // B) export * from / export * as ns from
        if (next.kind === 'punc' && next.raw === '*') {
          let j = i + 2;
          if (sig[j] && sig[j].kind === 'id' && sig[j].raw === 'as') j += 2;
          if (sig[j] && sig[j].kind === 'id' && sig[j].raw === 'from') j++;
          if (sig[j] && sig[j].kind === 'str') j++;
          if (sig[j] && sig[j].kind === 'punc' && sig[j].raw === ';') j++;
          const stmtEnd = sig[j - 1] ? sig[j - 1].end : next.end;
          const rawHead = src.slice(t.start, Math.min(stmtEnd, t.start + 400));
          edits.push({ start: t.start, end: stmtEnd, text: '' });
          statements.push({ form: 'star re-export', raw: brief(rawHead) });
          warnings.push(`re-export 需主构建器处理: ${brief(rawHead)}`);
          i = j; continue;
        }
        // C) export default <expr>
        if (next.kind === 'id' && next.raw === 'default') {
          const expr = sig[i + 2];
          if (expr) {
            edits.push({ start: t.start, end: expr.start, text: 'var __three_default = ', isDefault: true });
            defaultRef = '__three_default';
            statements.push({ form: 'export default', raw: brief(src.slice(t.start, t.start + 200)) });
            warnings.push('export default 已转为局部变量，并加入导出对象的 "default" 键');
          } else {
            edits.push({ start: t.start, end: next.end, text: '' });
            warnings.push('export default 无表达式，已删除（无法确定导出值）');
          }
          i++; continue;
        }
        // D) 声明式导出 export const|let|var|function|class|async ...
        if (next.kind === 'id' && /^(?:const|let|var|function|class|async)$/.test(next.raw)) {
          edits.push({ start: t.start, end: next.start, text: '' }); // 仅删 `export ` 关键字
          const kind = next.raw;
          const names = (kind === 'const' || kind === 'let' || kind === 'var')
            ? collectVarNames(i + 2)
            : [firstDeclName(i + 2)].filter(Boolean);
          if (!names.length) {
            warnings.push(`export ${kind} 声明含解构/匿名形式，无法确定导出名；声明已保留为普通声明`);
          }
          for (const nm of names) bindings.push({ local: nm, exported: nm });
          if (kind === 'let' || kind === 'var') {
            warnings.push(`export ${kind} ${names.join(', ')}：classic 产物为一次性赋值快照，非 live binding`);
          }
          statements.push({ form: `export ${kind} declaration`, raw: brief(src.slice(t.start, next.end + 80)) });
          i++; continue;
        }
      }
    }
    i++;
  }
  return { edits, bindings, statements, defaultRef };
}

/* 应用字符区间替换，重建 body（edits 按 start 升序、跳过重叠） */
function applyEdits(src, edits) {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  let out = '', cur = 0;
  for (const e of sorted) {
    if (e.start < cur) continue;
    out += src.slice(cur, e.start) + e.text;
    cur = e.end;
  }
  out += src.slice(cur);
  return out;
}

function freshName(base, used) {
  let n = base;
  while (used.has(n)) n += '_';
  used.add(n);
  return n;
}

/* ------------------------------------------------------------------------
 * threeToClassic(file, opts) -> { code, exports, bytes, warnings, stats }
 *   opts.globalName 默认 'THREE'
 * ------------------------------------------------------------------------ */
export function threeToClassic(file, opts = {}) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`[vendor-map] 输入文件不存在: ${abs}`);
  const warnings = [];
  const globalName = opts.globalName || 'THREE';

  // 读入统一 LF（硬性要求：产物不得含 CRLF）
  const raw = fs.readFileSync(abs, 'utf8').replace(/\r\n?/g, '\n');
  const toks = lex(raw);

  const featIn = analyzeFeatures(raw);
  if (featIn.importMeta) warnings.push(`输入含 ${featIn.importMeta} 处 import.meta；classic script 无法承载，需主构建器处理`);
  if (featIn.dynamicImport) warnings.push(`输入含 ${featIn.dynamicImport} 处动态 import()；classic script 无法承载，需主构建器处理`);
  if (featIn.staticImport) warnings.push(`输入含 ${featIn.staticImport} 处静态 import 语句；classic script 无法承载，需主构建器处理`);
  if (featIn.topLevelAwait) warnings.push(`输入疑似含顶层 await（${featIn.topLevelAwait} 处）；classic script 无法承载`);

  const { edits, bindings, statements, defaultRef } = extractExports(raw, toks, warnings);

  // 命名空间变量名：避免与 body 内的顶层标识符冲突
  const used = new Set(toks.filter((t) => t.kind === 'id').map((t) => t.raw));
  const nsName = freshName('__three_ns', used);
  const defName = defaultRef ? freshName('__three_default', used) : null;
  if (defaultRef) {
    for (const e of edits) if (e.isDefault) e.text = `var ${defName} = `;
  }

  const body = applyEdits(raw, edits);

  // 导出名：按原顺序去重
  const exportNames = [];
  const seen = new Set();
  for (const b of bindings) if (!seen.has(b.exported)) { seen.add(b.exported); exportNames.push(b.exported); }
  if (defaultRef && !seen.has('default')) { seen.add('default'); exportNames.push('default'); }

  const globalExpr = IDENT.test(globalName)
    ? `globalThis.${globalName}`
    : `globalThis[${JSON.stringify(globalName)}]`;

  const head = [
    '/* generated by tools/vendor-map.mjs — 请勿手工编辑 */',
    '(function () {',
    "  'use strict';",
  ];
  const tail = ['', `  var ${nsName} = ${globalExpr} || (${globalExpr} = {});`];
  for (const b of bindings) tail.push(`  ${nsName}[${JSON.stringify(b.exported)}] = ${b.local};`);
  if (defaultRef) tail.push(`  ${nsName}["default"] = ${defName};`);
  tail.push('})();');

  const code = head.join('\n') + '\n' + body + tail.join('\n') + '\n';

  // 1) 兜底断言：产物不得残留 export 关键字
  assertNoExportKeyword(code);
  // 2) 语法校验（只编译不执行）
  try {
    new vm.Script(code, { filename: path.basename(abs) + '.classic.js' });
  } catch (e) {
    throw new Error(`[vendor-map] 产物语法校验失败: ${e.message}`);
  }

  const bytes = Buffer.byteLength(code, 'utf8');
  // 如实记录降级：classic 命名空间是一次性快照，不是 ESM live binding
  warnings.push('classic 命名空间为执行完 body 后的一次性赋值快照（非 live binding）；three 顶层导出为常量，等价');

  return {
    code,
    exports: exportNames,
    bytes,
    warnings,
    stats: {
      globalName,
      inputBytes: Buffer.byteLength(raw, 'utf8'),
      inputFeatures: featIn,
      features: analyzeFeatures(code),
      exportStatements: statements,
    },
  };
}

/* ------------------------------------------------------------------------
 * CLI: node tools/vendor-map.mjs <three.module.js> [--out=<file>] [--check]
 * ------------------------------------------------------------------------ */
const isMain = process.argv[1] && /vendor-map\.mjs$/.test(process.argv[1]);
if (isMain) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const outArg = args.find((a) => a.startsWith('--out='));
  const check = args.includes('--check');
  const gnArg = args.find((a) => a.startsWith('--global='));
  const globalName = gnArg ? gnArg.slice('--global='.length) : 'THREE';
  if (!file) {
    console.error('用法: node tools/vendor-map.mjs <three.module.js> [--out=<file>] [--check] [--global=NAME]');
    process.exit(2);
  }
  try {
    const r = threeToClassic(file, { globalName });
    const doWrite = !!outArg && !check;
    if (doWrite) fs.writeFileSync(outArg.slice('--out='.length), r.code, 'utf8');
    const f = r.stats.features;
    console.log('=== three→classic 转换成功 ===');
    console.log(`输入路径: ${path.resolve(file)}`);
    console.log(`导出数量: ${r.exports.length}`);
    console.log(`产物字节: ${r.bytes}`);
    console.log(`产物特性: import.meta=${f.importMeta} 动态import=${f.dynamicImport} 顶层await=${f.topLevelAwait} 静态import=${f.staticImport}`);
    console.log(`export 语句数: ${r.stats.exportStatements.length}`);
    for (const s of r.stats.exportStatements) console.log(`  - [${s.form}] ${s.raw}`);
    for (const w of r.warnings) console.log(`WARN  ${w}`);
    if (doWrite) console.log(`已写出: ${path.resolve(outArg.slice('--out='.length))}`);
    else if (check) console.log('--check: 仅校验，未写文件');
    else if (!outArg) console.log('（未指定 --out，未写文件）');
  } catch (e) {
    console.error(`转换失败: ${e.message}`);
    process.exit(1);
  }
}
