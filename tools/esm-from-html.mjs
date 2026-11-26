/* tools/esm-from-html.mjs — 从内联 <script type="module"> 里抽出可打包的入口
 *
 * 有些单文件游戏（卡牌系列）把全部逻辑写在 index.html 的 module 标签里，
 * 只 import 仓库内的共享模块（如 ../../shared/poker.js）。
 *
 * 做法：把 module 标签里的代码落成磁盘上的「虚拟入口」<gameDir>/.build/inline-entry.mjs，
 * 相对路径不变（与 index.html 同目录），于是 bundle() 能把 import 正常解析并内联；
 * 构建结束由 build.mjs 清理 .build/，不污染源码目录的最终产物。
 */
import fs from 'node:fs';
import path from 'node:path';

export function extractInlineModule(html) {
  const re = /<script[^>]*\btype=["']module["'][^>]*>([\s\S]*?)<\/script>/i;
  const m = html.match(re);
  if (!m) return null;
  const code = m[1];
  return code.trim() ? code : null;
}

/** 把内联代码写成 <gameDir>/.build/inline-entry.mjs，返回绝对路径；无内联 module 时返回 null。 */
export function materializeInlineEntry(gameDir, html) {
  const code = extractInlineModule(html);
  if (!code) return null;
  const dir = path.join(gameDir, '.build');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'inline-entry.mjs');
  fs.writeFileSync(file, code.endsWith('\n') ? code : code + '\n', 'utf8');
  return file;
}

/** 可注入的样式侧车：<link rel="stylesheet" href="../../shared/poker.css"> 之类
 *  返回 [{ href, abs, css }]，由 build.mjs 就地内联成 <style>，保证产物自包含。 */
export function collectCssSidecars(html, gameDir) {
  const re = /<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>/gi;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    if (/^(https?:)?\/\//.test(href) || href.startsWith('data:')) continue;
    const abs = path.resolve(gameDir, href);
    if (!fs.existsSync(abs)) continue;
    out.push({ tag: m[0], href, abs, css: fs.readFileSync(abs, 'utf8') });
  }
  return out;
}
