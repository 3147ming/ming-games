/* anchor.mjs — 唯一的大文件改写入口
 *
 * 背景：这个环境对大体量 HTML / 长 Markdown 有静默丢写风险（历史多次复现），
 * 且 Python io.open(p,'w') 会把 LF 全转 CRLF。本模块用 Node 二进制读写 utf8，
 * 不做任何换行转换，并在写入前强制校验锚点「恰好命中 1 次」。
 *
 * 纪律：任何对 index.html / 长文档 / 大 JS 的改写都必须经过 replaceOnce / replaceOnceText。
 * 锚点用稳定的文本片段，绝不用行号。
 */
import fs from 'node:fs';

export function replaceOnceText(text, anchor, replacement, label = 'anchor') {
  if (typeof text !== 'string') throw new Error('[anchor] text 必须是字符串');
  if (typeof anchor !== 'string' || anchor.length === 0) throw new Error('[anchor] 锚点不能为空');
  const count = text.split(anchor).length - 1;
  if (count !== 1) {
    throw new Error(
      `[anchor] ${label}: 锚点期望恰好命中 1 次，实际 ${count} 次。已中止，未写入任何内容。\n` +
      `锚点前 80 字符: ${JSON.stringify(anchor.slice(0, 80))}`
    );
  }
  // 用函数形式避免 replacement 里的 $& / $1 被当成特殊替换模式
  return text.replace(anchor, () => replacement);
}

export function replaceOnce(file, anchor, replacement, opts = {}) {
  const text = fs.readFileSync(file, 'utf8');
  const out = replaceOnceText(text, anchor, replacement, opts.label || file);
  if (!opts.dryRun) fs.writeFileSync(file, out, 'utf8');
  return out;
}

export function replaceMany(file, edits, opts = {}) {
  let text = fs.readFileSync(file, 'utf8');
  for (const e of edits) {
    text = replaceOnceText(text, e.anchor, e.replacement, e.label || file);
  }
  if (!opts.dryRun) fs.writeFileSync(file, text, 'utf8');
  return text;
}

/* 正则型锚点：同样要求恰好命中 1 次 */
export function replaceOnceRe(text, re, replacement, label = 'regex') {
  if (!(re instanceof RegExp)) throw new Error('[anchor] 需要 RegExp');
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
  const all = new RegExp(re.source, flags);
  const matches = [...text.matchAll(all)];
  if (matches.length !== 1) {
    throw new Error(`[anchor] ${label}: 正则期望恰好命中 1 次，实际 ${matches.length} 次。已中止。`);
  }
  const m = matches[0];
  return text.slice(0, m.index) + replacement + text.slice(m.index + m[0].length);
}

export function selftest() {
  const results = [];
  const ok = (name, fn) => {
    try { fn(); results.push({ name, pass: true }); }
    catch (e) { results.push({ name, pass: false, error: String(e.message) }); }
  };
  ok('唯一命中时正确替换', () => {
    const out = replaceOnceText('a--TARGET--b', '--TARGET--', 'X');
    if (out !== 'aXb') throw new Error('替换结果不对: ' + out);
  });
  ok('重复锚点抛错', () => {
    let threw = false;
    try { replaceOnceText('T a T b', 'T', 'X'); } catch { threw = true; }
    if (!threw) throw new Error('重复锚点未抛错');
  });
  ok('未命中抛错', () => {
    let threw = false;
    try { replaceOnceText('abc', 'ZZZ', 'X'); } catch { threw = true; }
    if (!threw) throw new Error('未命中未抛错');
  });
  ok('replacement 中的 $& 不被当特殊模式', () => {
    const out = replaceOnceText('a-T-b', 'T', '$&$$');
    if (out !== 'a-$&$$-b') throw new Error('特殊字符被误解析: ' + out);
  });
  ok('正则锚点唯一命中', () => {
    const out = replaceOnceRe('<script type="module" src="x"></script>', /<script[^>]*type="module"[\s\S]*?<\/script>/, 'OK');
    if (out !== 'OK') throw new Error('正则替换结果不对: ' + out);
  });
  ok('正则锚点重复命中抛错', () => {
    let threw = false;
    try { replaceOnceRe('<b>A</b><b>B</b>', /<b>[\s\S]*?<\/b>/, 'X'); } catch { threw = true; }
    if (!threw) throw new Error('正则重复命中未抛错');
  });
  const failed = results.filter((r) => !r.pass);
  return { total: results.length, passed: results.length - failed.length, failed, results };
}

if (process.argv[1] && process.argv[1].endsWith('anchor.mjs')) {
  const r = selftest();
  for (const x of r.results) console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.error ? ' :: ' + x.error : ''}`);
  console.log(`=== anchor 自检：${r.passed}/${r.total} 通过 ===`);
  if (r.failed.length) process.exit(1);
}
