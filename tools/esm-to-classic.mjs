/* esm-to-classic.mjs — 构建期把 ESM 依赖图转成单个 classic <script>
 *
 * 目的：让 <script type="module"> 的游戏在 file:// 双击时不再被 CORS 拦成白屏。
 * 源码零改动；本工具只作用于构建产物。
 *
 * P2a 能力：
 *   - export default <标识符 / 具名或匿名函数或类 / 对象字面量 / 表达式>
 *   - export { A, B as C } / export { X } from / export * / export * as ns
 *   - export const|let|var 解构导出
 *   - 默认导入 / 混合导入 / import * as ns / 别名
 *   - 多行 import 子句内的 // 与 /* *\/ 注释剥离（保留字符串里的 //）
 *   - isTopLevelAwait 词法扫描（替代 /^\s*await\s+/m 误报）
 *   - Tarjan SCC + 两阶段注入（命名空间/哨兵预建 + 按拓扑序执行 body）
 *   - live binding（let/var 与循环依赖用 getter + 局部名改写）
 *   - TDZ 哨兵 getter 抛 ReferenceError
 *   - 保留末尾 vm.Script 语法校验、warnings[]、opts.onBare
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const IDENT = /^[A-Za-z_$][\w$]*$/;

/* =========================================================================
 * 通用词法器：产出 {kind, raw} 列表，保证可无损重建源码
 *   kind: ws | comment | str | template | regex | num | id | punc
 *   字符串/模板/正则/注释整段作为「不可改写」token，供改写与 await 扫描跳过
 * ========================================================================= */
function lex(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  let prevSig = null; // 上一个非空白/非注释 token 的 raw，用于判定正则起点
  const isIdStart = (c) => c !== undefined && /[A-Za-z_$]/.test(c);
  const isIdPart = (c) => c !== undefined && /[A-Za-z0-9_$]/.test(c);
  const emit = (kind, raw) => {
    toks.push({ kind, raw });
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
      emit('ws', src.slice(i, j));
      i = j;
      continue;
    }
    // 注释
    if (c === '/' && c2 === '/') {
      let j = i + 2;
      while (j < n && src[j] !== '\n') j++;
      emit('comment', src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '/' && c2 === '*') {
      const end = src.indexOf('*/', i + 2);
      const j = end < 0 ? n : end + 2;
      emit('comment', src.slice(i, j));
      i = j;
      continue;
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
      emit('str', src.slice(i, j));
      i = j;
      continue;
    }
    // 模板字符串：字面段作为 template(跳过)，${...} 表达式递归按代码切分
    if (c === '`') {
      let j = i + 1;
      let depth = 0;
      let segStart = i; // 当前字面段起点
      while (j < n) {
        const ch = src[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '`' && depth === 0) {
          toks.push({ kind: 'template', raw: src.slice(segStart, j + 1) });
          i = j + 1;
          break;
        }
        if (ch === '$' && src[j + 1] === '{') {
          // 结束当前字面段（不含 `${`）
          if (j > segStart) toks.push({ kind: 'template', raw: src.slice(segStart, j) });
          toks.push({ kind: 'punc', raw: '${' });
          prevSig = '${';
          j += 2;
          // 找匹配的 }（处理嵌套 {} 与字符串）
          let k = j;
          let d = 1;
          while (k < n && d > 0) {
            const q = src[k];
            if (q === '"' || q === "'" || q === '`') {
              const quote = q;
              k++;
              while (k < n) {
                if (src[k] === '\\') { k += 2; continue; }
                if (src[k] === quote) { k++; break; }
                k++;
              }
              continue;
            }
            if (q === '{') d++;
            else if (q === '}') d--;
            if (d === 0) break;
            k++;
          }
          const expr = src.slice(j, k);
          for (const t of lex(expr)) toks.push(t);
          if (k < n) {
            toks.push({ kind: 'punc', raw: '}' });
            prevSig = '}';
            j = k + 1;
          } else {
            j = k;
          }
          segStart = j;
          continue;
        }
        j++;
      }
      if (i < segStart) { /* noop */ }
      continue;
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
      emit('regex', src.slice(i, j));
      i = j;
      continue;
    }
    // 标识符 / 关键字
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdPart(src[j])) j++;
      emit('id', src.slice(i, j));
      i = j;
      continue;
    }
    // 数字
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9a-fA-FxXoObB._eE+-]/.test(src[j])) {
        // 避免把 `1+2` 的 + 吞进数字
        if ((src[j] === '+' || src[j] === '-') && !/[eE]/.test(src[j - 1])) break;
        j++;
      }
      emit('num', src.slice(i, j));
      i = j;
      continue;
    }
    // 多字符运算符
    if (c === '=' && c2 === '>') { emit('punc', '=>'); i += 2; continue; }
    // 单字符标点 / 运算符
    emit('punc', c);
    i++;
  }
  return toks;
}

/* =========================================================================
 * import 解析
 * ========================================================================= */
function parseBindingList(inner, label) {
  const out = [];
  for (const seg of inner.split(',')) {
    const t = seg.trim();
    if (!t) continue;
    const parts = t.split(/\s+as\s+/);
    const left = parts[0].trim();
    const right = (parts[1] || parts[0]).trim();
    if (!IDENT.test(left) || !IDENT.test(right)) {
      throw new Error(`[esm] ${label}: 非法绑定名 ${JSON.stringify(t)}`);
    }
    out.push({ left, right });
  }
  return out;
}

function parseClause(clause, label) {
  const res = { bindings: [], star: null, sideEffect: false, default: null };
  let text = clause.trim();
  if (!text) return res;
  // 默认导入 + 其余子句，或纯默认导入
  const def = text.match(/^([A-Za-z_$][\w$]*)\s*,\s*([\s\S]+)$/);
  if (def) {
    res.default = def[1];
    text = def[2].trim();
  } else if (IDENT.test(text)) {
    res.default = text;
    return res;
  }
  if (!text) return res;
  if (text.startsWith('{')) {
    if (!text.endsWith('}')) throw new Error(`[esm] ${label}: 命名导入未闭合: ${clause}`);
    res.bindings = parseBindingList(text.slice(1, -1), label).map((p) => ({ remote: p.left, local: p.right }));
    return res;
  }
  const star = text.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
  if (star) {
    res.star = star[1];
    return res;
  }
  throw new Error(`[esm] ${label}: 无法解析的 import 子句: ${JSON.stringify(clause.slice(0, 140))}`);
}

function parseImport(raw, label) {
  const text = raw.trim();
  const m = text.match(/^import\s+([\s\S]*?)\s+from\s*(['"])([^'"]+)\2\s*;?\s*$/);
  if (m) return { spec: m[3], ...parseClause(m[1].trim(), label) };
  const b = text.match(/^import\s*(['"])([^'"]+)\1\s*;?\s*$/);
  if (b) return { spec: b[2], bindings: [], star: null, sideEffect: true, default: null };
  throw new Error(`[esm] ${label}: 无法解析 import: ${JSON.stringify(text.slice(0, 140))}`);
}

/* 字符串/正则/模板感知的注释剥离：返回与 src 行数对齐的「代码版」文本
 * （注释字符以空格替换并保留换行；字符串/模板内容原样保留其中的 //） */
function stripImportComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let mode = 'code'; // code | line | block | sq | dq | tpl
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && c2 === '/') { out += '  '; i += 2; mode = 'line'; continue; }
      if (c === '/' && c2 === '*') { out += '  '; i += 2; mode = 'block'; continue; }
      if (c === "'") { mode = 'sq'; out += c; i++; continue; }
      if (c === '"') { mode = 'dq'; out += c; i++; continue; }
      if (c === '`') { mode = 'tpl'; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (mode === 'line') {
      if (c === '\n' || c === '\r') { mode = 'code'; out += c; i++; }
      else { out += ' '; i++; }
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && c2 === '/') { mode = 'code'; out += '  '; i += 2; }
      else { out += (c === '\n' || c === '\r') ? c : ' '; i++; }
      continue;
    }
    // 字符串内部：原样保留，处理转义
    out += c;
    if (c === '\\' && c2 !== undefined) { out += c2; i += 2; continue; }
    if (mode === 'sq' && c === "'") mode = 'code';
    else if (mode === 'dq' && c === '"') mode = 'code';
    else if (mode === 'tpl' && c === '`') mode = 'code';
    i++;
  }
  return out;
}

/* 行状态机：多行 import 逐行累积直到出现 from '...'；
 * 用「代码版」行做检测与解析（剥掉注释），输出体仍保留原始行（含注释，保证 toString 一致） */
function extractImports(src, label) {
  const origLines = src.split(/\r?\n/);
  const codeLines = stripImportComments(src).split(/\r?\n/);
  const outLines = [];
  const imports = [];
  let pending = null;
  const isStart = (l) => /^[ \t]*import\b/.test(l);
  const isComplete = (t) =>
    /\bfrom\s*['"][^'"]+['"]\s*;?[ \t]*$/.test(t) ||
    /^[ \t]*import\s*['"][^'"]+['"]\s*;?[ \t]*$/.test(t);

  for (let idx = 0; idx < origLines.length; idx++) {
    const orig = origLines[idx];
    const code = codeLines[idx] !== undefined ? codeLines[idx] : '';
    if (pending !== null) {
      pending.push(code);
      outLines.push('');
      if (isComplete(pending.join('\n'))) {
        imports.push(parseImport(pending.join('\n'), label));
        pending = null;
      }
      continue;
    }
    if (isStart(code)) {
      outLines.push('');
      if (isComplete(code)) imports.push(parseImport(code, label));
      else pending = [code];
    } else {
      outLines.push(orig);
    }
  }
  if (pending !== null) throw new Error(`[esm] ${label}: import 语句未闭合:\n${pending.join('\n')}`);
  return { body: outLines.join('\n'), imports };
}

/* =========================================================================
 * export 解析
 * ========================================================================= */
function findTopLevelEquals(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === '=' && depth === 0) {
      if (text[i + 1] !== '=' && text[i - 1] !== '=' && text[i - 1] !== '!' &&
          text[i - 1] !== '<' && text[i - 1] !== '>' && text[i + 1] !== '>') return i;
    }
  }
  return -1;
}

/* 从解构模式里抽取绑定名（支持 {a,b}、{a: c}、[a,,b]、...rest、a = 默认值） */
function extractPatternNames(pattern) {
  const toks = lex(pattern).filter((t) => t.kind !== 'ws' && t.kind !== 'comment');
  const names = [];
  let skipDefault = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const r = t.raw;
    if (r === '=' && toks[i + 1] && toks[i + 1].raw !== '>') { skipDefault = true; continue; }
    if (r === ',' || r === '}' || r === ']' || r === ')') { skipDefault = false; continue; }
    if (skipDefault) continue;
    if (t.kind !== 'id') continue;
    const prev = i > 0 ? toks[i - 1].raw : '';
    const prev2 = i > 1 ? toks[i - 2].raw : '';
    const next = i + 1 < toks.length ? toks[i + 1].raw : '';
    if (next === ':') continue;                 // 对象键
    if (prev === '.') {
      // `...rest` 的 rest 是绑定；`obj.name` 的 name 不是
      if (prev2 !== '.') continue;
    }
    names.push(r);
  }
  return [...new Set(names)];
}

function transformExports(body, label) {
  const decls = [];      // [{name, mutable}]  来自 export 声明
  const named = [];      // [{local, exported}]  来自 export {A, B as C}
  const reexports = [];  // [{spec, clause|null, ns|null}]
  let defaultRef = null; // export default 的本地引用名
  let out = body;

  // 1) export * as ns from / export * from
  out = out.replace(
    /^[ \t]*export\s+\*\s+(?:as\s+([A-Za-z_$][\w$]*)\s+)?from\s*(['"])([^'"]+)\2\s*;?[ \t]*$/gm,
    (_m, ns, _q, spec) => { reexports.push({ spec, clause: null, ns: ns || null }); return ''; }
  );
  // 2) export { ... } from '...'
  out = out.replace(
    /^[ \t]*export\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2\s*;?[ \t]*$/gm,
    (_m, inner, _q, spec) => {
      reexports.push({ spec, clause: parseBindingList(inner, label).map((p) => ({ remote: p.left, exported: p.right })), ns: null });
      return '';
    }
  );
  // 3) export { ... }（本地具名导出）
  out = out.replace(
    /^[ \t]*export\s*\{([^}]*)\}\s*;?[ \t]*$/gm,
    (_m, inner) => {
      for (const p of parseBindingList(inner, label)) named.push({ local: p.left, exported: p.right });
      return '';
    }
  );
  // 4) export default：先把匿名 function/class 具名化，再整体替换为临时变量
  let anonN = 0;
  out = out.replace(/^([ \t]*export\s+default\s+(?:async\s+)?function\s*\*?\s*)\(/gm,
    (_m, p) => `${p} __mgdefault_${anonN++}(`);
  out = out.replace(/^([ \t]*export\s+default\s+class\s+)(\{|extends\b)/gm,
    (_m, p, r) => `${p}__mgdefault_${anonN++} ${r}`);
  out = out.replace(/^([ \t]*)export\s+default\s+/gm, (_m, indent) => {
    defaultRef = '__mgdefault';
    return `${indent}var __mgdefault = `;
  });
  // 5) export 声明（const/let/var/function/class/async function），含解构
  out = out.replace(
    /^([ \t]*)export\s+(async\s+function\b|function\b|class\b|const\b|let\b|var\b)[ \t]*([^\n]*)$/gm,
    (_m, indent, kind, rest) => {
      const isFn = /^(?:async\s+)?function\b|class\b/.test(kind);
      const mutable = /^(let|var)$/.test(kind);
      if (isFn) {
        const nm = rest.match(/^\*?\s*([A-Za-z_$][\w$]*)/);
        if (nm) decls.push({ name: nm[1], mutable: false });
      } else {
        const trimmed = rest.replace(/^\s+/, '');
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          const eq = findTopLevelEquals(rest);
          const pattern = eq >= 0 ? rest.slice(0, eq) : rest;
          for (const nm of extractPatternNames(pattern)) decls.push({ name: nm, mutable });
        } else {
          const nm = trimmed.match(/^([A-Za-z_$][\w$]*)/);
          if (nm) decls.push({ name: nm[1], mutable });
        }
      }
      return `${indent}${kind} ${rest}`;
    }
  );

  // 兜底：产物里不得残留 `export ` 关键字（含未覆盖形式）
  if (/(^|\n)[ \t]*export\s+(?:default|\{|\*|const\b|let\b|var\b|function\b|class\b|async\b)/.test(out)) {
    throw new Error(`[esm] ${label}: 仍残留未处理的 export 语句`);
  }
  return { body: out, decls, named, reexports, defaultRef };
}

/* =========================================================================
 * 顶层 await 检测（词法扫描：跟踪 {} 深度 + 简洁箭头上下文）
 *   只有模块顶层（深度 0）且不在箭头简洁体内的 await 才算顶层 await
 * ========================================================================= */
export function isTopLevelAwait(body) {
  const toks = lex(body);
  let brace = 0;
  let conciseArrow = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind === 'punc') {
      if (t.raw === '{') brace++;
      else if (t.raw === '}') brace = Math.max(0, brace - 1);
      else if (t.raw === '=>') {
        // 若下一个有效 token 不是 '{'，则是简洁箭头体
        let j = i + 1;
        while (j < toks.length && (toks[j].kind === 'ws' || toks[j].kind === 'comment')) j++;
        if (j < toks.length && toks[j].raw !== '{') conciseArrow = true;
      } else if (t.raw === ';') {
        conciseArrow = false;
      }
    } else if (t.kind === 'id' && t.raw === 'await') {
      if (brace === 0 && !conciseArrow) return true;
    }
  }
  return false;
}

function assertSupported(body, label) {
  const blocked = [
    [/\bimport\s*\(/, '动态 import'],
    [/\bimport\.meta\b/, 'import.meta'],
    [/\bnew\s+Worker\s*\(/, 'Web Worker'],
  ];
  for (const [re, what] of blocked) {
    if (re.test(body)) throw new Error(`[esm] ${label}: P0 暂不支持 ${what}；请在 P2 处理`);
  }
  if (isTopLevelAwait(body)) {
    throw new Error(`[esm] ${label}: 检测到模块顶层 await；classic script 无法承载，请在 P2 处理`);
  }
}

/* =========================================================================
 * live binding 局部名改写：把 import 局部名引用替换为 __MG[depId].remote
 *   跳过字符串/模板字面段/正则/注释；跳过成员访问 .name / ?.name；
 *   保留 `...name`（spread）作为引用改写
 * ========================================================================= */
function rewriteLiveRefs(body, accessors) {
  if (!accessors.size) return body;
  const toks = lex(body);
  let out = '';
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind === 'id' && accessors.has(t.raw)) {
      // 前一个有效 token
      let p = i - 1;
      while (p >= 0 && (toks[p].kind === 'ws' || toks[p].kind === 'comment')) p--;
      const prev = p >= 0 ? toks[p].raw : '';
      let p2 = p - 1;
      while (p2 >= 0 && (toks[p2].kind === 'ws' || toks[p2].kind === 'comment')) p2--;
      const prev2 = p2 >= 0 ? toks[p2].raw : '';
      const isMember = prev === '.' && prev2 !== '.'; // 单点成员访问 / ?. 成员访问
      if (isMember) { out += t.raw; continue; }
      out += accessors.get(t.raw);
      continue;
    }
    out += t.raw;
  }
  return out;
}

/* =========================================================================
 * Tarjan SCC：返回 {components, sccOf}
 *   components 按「依赖优先」弹出顺序（可直接作为两阶段的执行顺序）
 * ========================================================================= */
function tarjanSCC(modules) {
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  const sccOf = new Map();

  function strong(v) {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of modules.get(v).deps) {
      if (!modules.has(w)) continue;
      if (!idx.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), idx.get(w)));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      const ci = components.length;
      for (const k of comp) sccOf.set(k, ci);
      components.push(comp);
    }
  }
  for (const key of modules.keys()) if (!idx.has(key)) strong(key);
  return { components, sccOf };
}

/* =========================================================================
 * bundle
 * ========================================================================= */
export function bundle(entryFile, opts = {}) {
  const entry = path.resolve(entryFile);
  if (!fs.existsSync(entry)) throw new Error(`[esm] 入口不存在: ${entry}`);
  const base = path.dirname(entry);
  const idOf = (key) => path.relative(base, key).split(path.sep).join('/');
  const modules = new Map();
  const warnings = [];
  const onBare = opts.onBare || null;

  function visit(abs) {
    const key = path.resolve(abs);
    if (modules.has(key)) return;
    const src = fs.readFileSync(key, 'utf8');
    const label = idOf(key);
    const { body: noImports, imports } = extractImports(src, label);
    assertSupported(noImports, label);
    const tx = transformExports(noImports, label);
    const mod = {
      key,
      label,
      body: tx.body,
      imports,
      decls: tx.decls,
      named: tx.named,
      reexports: tx.reexports,
      defaultRef: tx.defaultRef,
      deps: [],
      depOfImport: [],
      reexportResolved: [],
      mutableLocals: new Set(tx.decls.filter((d) => d.mutable).map((d) => d.name)),
      mutableExportNames: new Set(),
      exportNames: new Set(),
      accessors: new Map(),
    };
    modules.set(key, mod);

    // import 依赖
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
      mod.depOfImport.push({ im, depKey: dep });
      visit(dep);
    }
    // re-export 依赖
    for (const rx of reexportsOf(mod)) {
      if (!rx.spec.startsWith('.')) {
        if (onBare) { onBare(rx.spec, key); continue; }
        throw new Error(`[esm] ${label}: re-export 裸说明符 ${JSON.stringify(rx.spec)} 需要 vendor 映射`);
      }
      const dep = path.resolve(path.dirname(key), rx.spec);
      if (!fs.existsSync(dep)) throw new Error(`[esm] ${label}: re-export 依赖不存在: ${dep}`);
      mod.deps.push(dep);
      rx.depKey = dep;
      mod.reexportResolved.push(rx);
      visit(dep);
    }
  }

  function reexportsOf(mod) {
    return mod.reexports;
  }

  visit(entry);

  // 计算各模块「可变导出名」（用于 importer 的 live 判定）
  for (const mod of modules.values()) {
    for (const d of mod.decls) if (d.mutable) mod.mutableExportNames.add(d.name);
    for (const nm of mod.named) if (mod.mutableLocals.has(nm.local)) mod.mutableExportNames.add(nm.exported);
    // 汇总全部导出名（供阶段一哨兵占位）
    for (const d of mod.decls) mod.exportNames.add(d.name);
    for (const nm of mod.named) mod.exportNames.add(nm.exported);
    if (mod.defaultRef) mod.exportNames.add('default');
    for (const rx of mod.reexportResolved) {
      if (rx.ns) mod.exportNames.add(rx.ns);
      else if (rx.clause) for (const p of rx.clause) mod.exportNames.add(p.exported);
      // export * 的名字运行时才能确定，阶段二转发时定义
    }
  }

  const { components, sccOf } = tarjanSCC(modules);
  const order = components.flat();
  const sameSCC = (a, b) => sccOf.get(a) === sccOf.get(b);

  // 为每个模块计算 import 绑定的 live 判定 + accessors，并改写 body
  for (const mod of modules.values()) {
    for (const { im, depKey } of mod.depOfImport) {
      if (im.sideEffect) continue;
      const depMod = modules.get(depKey);
      const cyclic = sameSCC(mod.key, depKey);
      const depIdJ = JSON.stringify(idOf(depKey));
      // 默认导入
      if (im.default) {
        im.defaultLive = cyclic; // 循环里的默认导入也走 live
        if (im.defaultLive) mod.accessors.set(im.default, `__MG[${depIdJ}].default`);
      }
      // 命名绑定
      for (const b of im.bindings) {
        const mutable = depMod && depMod.mutableExportNames.has(b.remote);
        b.live = cyclic || mutable;
        if (b.live) mod.accessors.set(b.local, `__MG[${depIdJ}][${JSON.stringify(b.remote)}]`);
      }
    }
    mod.body = rewriteLiveRefs(mod.body, mod.accessors);
  }

  // warnings：SCC 顶层读取 / export let/var
  for (const comp of components) {
    if (comp.length > 1) {
      const labels = comp.map((k) => idOf(k)).join(', ');
      for (const k of comp) {
        warnings.push(`${idOf(k)}: 处于循环依赖 SCC [${labels}]，SCC 内顶层读取依赖会触发 TDZ 哨兵（已用 live getter）`);
      }
    }
  }
  for (const mod of modules.values()) {
    for (const d of mod.decls) {
      if (d.mutable) warnings.push(`${idOf(mod.key)}: export ${d.name} 是 let/var，命名空间以 live getter 绑定`);
    }
  }

  const chunks = [
    '/* generated by tools/esm-to-classic.mjs — 请勿手工编辑 */',
    '(function () {',
    "  'use strict';",
    '  var __MG = globalThis.__MG || (globalThis.__MG = Object.create(null));',
    '  var __mgTdz = function (n, id) {',
    '    return function () { throw new ReferenceError("Cannot access \'" + n + "\' before initialization (module " + id + ")"); };',
    '  };',
    '',
    '  /* ===== 阶段一：预建命名空间 + TDZ 哨兵 getter ===== */',
  ];

  for (const key of order) {
    const mod = modules.get(key);
    const idJ = JSON.stringify(idOf(key));
    chunks.push(`  __MG[${idJ}] = {};`);
    for (const name of mod.exportNames) {
      chunks.push(`  Object.defineProperty(__MG[${idJ}], ${JSON.stringify(name)}, { configurable: true, enumerable: true, get: __mgTdz(${JSON.stringify(name)}, ${idJ}) });`);
    }
  }

  chunks.push('', '  /* ===== 阶段二：按 SCC 拓扑序执行 body + export 赋值 + import 运行时读 ===== */');

  for (const key of order) {
    const mod = modules.get(key);
    const idJ = JSON.stringify(idOf(key));
    chunks.push(`  /* ==== ${idOf(key)} ==== */`);
    chunks.push('  (function () {');
    chunks.push("    'use strict';");

    // import 绑定
    for (const { im, depKey } of mod.depOfImport) {
      if (im.sideEffect) continue;
      const depIdJ = JSON.stringify(idOf(depKey));
      if (im.default && !im.defaultLive) {
        chunks.push(`    var ${im.default} = __MG[${depIdJ}].default;`);
      }
      if (im.star) {
        chunks.push(`    var ${im.star} = __MG[${depIdJ}];`);
      }
      const eager = im.bindings.filter((b) => !b.live);
      if (eager.length) {
        const parts = eager.map((b) => (b.remote === b.local ? b.local : `${b.remote}: ${b.local}`));
        chunks.push(`    var { ${parts.join(', ')} } = __MG[${depIdJ}];`);
      }
    }

    chunks.push(mod.body);

    // export 赋值（统一 live getter，等价于原生 ESM 的 live binding）
    for (const d of mod.decls) {
      chunks.push(`    Object.defineProperty(__MG[${idJ}], ${JSON.stringify(d.name)}, { configurable: true, enumerable: true, get: function () { return ${d.name}; } });`);
    }
    for (const nm of mod.named) {
      const expr = mod.accessors.get(nm.local) || nm.local;
      chunks.push(`    Object.defineProperty(__MG[${idJ}], ${JSON.stringify(nm.exported)}, { configurable: true, enumerable: true, get: function () { return ${expr}; } });`);
    }
    if (mod.defaultRef) {
      chunks.push(`    Object.defineProperty(__MG[${idJ}], "default", { configurable: true, enumerable: true, get: function () { return ${mod.defaultRef}; } });`);
    }
    for (const rx of mod.reexportResolved) {
      const depIdJ = JSON.stringify(idOf(rx.depKey));
      if (rx.ns) {
        chunks.push(`    Object.defineProperty(__MG[${idJ}], ${JSON.stringify(rx.ns)}, { configurable: true, enumerable: true, get: function () { return __MG[${depIdJ}]; } });`);
      } else if (rx.clause === null) {
        chunks.push(`    Object.keys(__MG[${depIdJ}]).forEach(function (k) {`);
        chunks.push(`      if (k === 'default' || Object.prototype.hasOwnProperty.call(__MG[${idJ}], k)) return;`);
        chunks.push(`      Object.defineProperty(__MG[${idJ}], k, { configurable: true, enumerable: true, get: function () { return __MG[${depIdJ}][k]; } });`);
        chunks.push(`    });`);
      } else {
        for (const p of rx.clause) {
          chunks.push(`    Object.defineProperty(__MG[${idJ}], ${JSON.stringify(p.exported)}, { configurable: true, enumerable: true, get: function () { return __MG[${depIdJ}][${JSON.stringify(p.remote)}]; } });`);
        }
      }
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
    console.log('=== ESM→classic 转换成功 ===');
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
