/* build-offline.mjs — 产物渲染器（web 与 offline 共用）
 *
 * 产物由「模板 + 数据」全新生成，不做「读原文局部改写再写回」的半途写入。
 * 对源 HTML 的每一处替换都经 anchor.mjs 的锚点唯一性校验。
 */
import fs from 'node:fs';
import path from 'node:path';
import { replaceOnceText, replaceLastText } from './anchor.mjs';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'tests', 'tools', '.workbuddy', '.tmp']);
const SKIP_FILES = new Set(['sw.js', 'manifest.json', 'package.json', 'server.mjs', 'README.md', 'index.html']);
const SKIP_EXT = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.md', '.map', '.ts']);

/* 同一标签在源 HTML 里可能出现多次（例：quiz 引了两遍 shared/tokens.css）。
   逐个替换并每次校验剩余计数，既守住「不静默丢写」，又避免重复内联同一份 CSS。 */
function replaceFirstVerified(text, anchor, replacement, label) {
  const before = text.split(anchor).length - 1;
  if (before < 1) throw new Error(`[build] ${label}: 锚点在替换前消失`);
  const out = text.replace(anchor, () => replacement);
  const after = out.split(anchor).length - 1;
  if (after !== before - 1) throw new Error(`[build] ${label}: 替换后计数异常 ${before} -> ${after}`);
  return out;
}

export function inlineStylesheets(html, gameDir, label) {
  const re = /<link[^>]*\brel=["']stylesheet["'][^>]*>/gi;
  const tags = [...html.matchAll(re)].map((m) => m[0]);
  const seen = new Set();
  for (const tag of tags) {
    const href = (tag.match(/\bhref=["']([^"']+)["']/) || [])[1];
    if (!href || href.startsWith('data:')) continue;
    const abs = path.resolve(gameDir, href);
    const dup = seen.has(abs);
    seen.add(abs);
    if (dup) {
      html = replaceFirstVerified(html, tag, '', `${label}:css-dup:${href}`);
      continue;
    }
    if (!fs.existsSync(abs)) throw new Error(`[build] ${label}: 样式表不存在 ${href} -> ${abs}`);
    const css = fs.readFileSync(abs, 'utf8');
    html = replaceFirstVerified(html, tag, `<style>\n/* inlined: ${href} */\n${css}\n</style>`, `${label}:css:${href}`);
  }
  return html;
}

/* P2b：产物里删掉 importmap，但构建器必须能读到它的映射，才能把裸 'three'
   与 'three/xxx' 前缀解析成本地 vendor。只读不改源文件。 */
export function readImportMap(html) {
  const re = /<script[^>]*\btype=["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi;
  const imports = {};
  for (const m of html.matchAll(re)) {
    const raw = (m[1] || '').trim();
    if (!raw) continue;
    try {
      const j = JSON.parse(raw);
      if (j && j.imports && typeof j.imports === 'object') Object.assign(imports, j.imports);
    } catch (e) {
      throw new Error(`[build] importmap 不是合法 JSON: ${e.message}`);
    }
  }
  return imports;
}

/* 产物不需要旧 SW 注册 / importmap / manifest（由统一 gen-sw 与构建器负责） */
export function stripLegacyTags(html) {
  /* modulepreload 在 file:// 下会以「跨源模块请求」被 CORS 拦下并报错；
     产物已把依赖图内联成 classic bundle，这个预加载标签必须删掉。 */
  html = html.replace(/<link[^>]*\brel=["'](?:manifest|modulepreload)["'][^>]*>\s*/gi, '');
  html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, function (block) {
    if (/serviceWorker\.register/.test(block)) return '';
    if (/\btype=["']importmap["']/.test(block)) return '';
    return block;
  });
  return html;
}

/* HTML 解析器见到 </script 就会结束内联脚本，哪怕它出现在 JS 字符串或注释里。
   打包后的游戏代码常含这类字面量，统一转义成 <\/script（JS 语义完全等价）。 */
function safeInlineScript(code) {
  return String(code).replace(/<\/script/gi, '<\\/script');
}

export function renderGameHtml(opts) {
  const { gameDir, gameId, entryRel, renderer, bundleCode, bridgeCode, label,
    vendorScripts = [], preludeCode = '' } = opts;
  let html = fs.readFileSync(path.join(gameDir, 'index.html'), 'utf8');
  html = inlineStylesheets(html, gameDir, label || gameId);
  html = stripLegacyTags(html);

  if (renderer === 'esm') {
    const re = /<script[^>]*\btype=["']module["'][^>]*>[\s\S]*?<\/script>/gi;
    const matches = [...html.matchAll(re)];
    if (matches.length !== 1) {
      throw new Error(`[build] ${gameId}: 期望恰好 1 个 module script，实际 ${matches.length} 个（P2 需扩展多入口处理）`);
    }
    const tag = matches[0][0];
    const src = (tag.match(/\bsrc=["']([^"']+)["']/) || [])[1];
    if (!src) throw new Error(`[build] ${gameId}: module script 缺少 src`);
    const expected = entryRel.replace(/^\.\//, '');
    if (!src.replace(/^\.\//, '').endsWith(expected.split('/').pop())) {
      throw new Error(`[build] ${gameId}: 入口不一致，HTML=${src} games.json=${entryRel}`);
    }
    /* 源 HTML 的 module 标签体内常塞一段 classic JS（可见性暂停 / pagehide 清理 /
       全局错误日志）。浏览器因 src 存在会忽略它，P2b 把它迁移成独立 script 保留下来。 */
    const inner = (tag.match(/<script[^>]*>([\s\S]*?)<\/script>/i) || [])[1] || '';
    const legacyInline = inner.trim();
    let replacement = `<script>\n${safeInlineScript(bundleCode)}\n</script>`;
    let prefix = vendorScripts.map((s) => `<script src="${s}"></script>`).join('\n');
    /* 资源本地化 shim 必须在 three.classic.js 与资源表之后、游戏 bundle 之前执行 */
    if (preludeCode) prefix += `${prefix ? '\n' : ''}<script>\n${safeInlineScript(preludeCode)}\n</script>`;
    if (prefix) replacement = prefix + '\n' + replacement;
    if (legacyInline) {
      replacement += `\n<script>\n/* migrated from module tag body */\n${safeInlineScript(legacyInline)}\n</script>`;
    }
    html = replaceOnceText(html, tag, replacement, `${gameId}:module-script`);
  }

  const child = `${bridgeCode}\nHubBridge.createChild({ gameId: ${JSON.stringify(gameId)}, caps: [] });`;
  // 用末次命中：内联 bundle 里可能含 '</body>' 字面量，文档真正的闭合标签在最后。
  html = replaceLastText(html, '</body>', `<script>\n${safeInlineScript(child)}\n</script>\n</body>`, `${gameId}:body-close`);
  return html;
}

export function renderHubHtml(opts) {
  const { root, games, meta } = opts;
  let html = fs.readFileSync(path.join(root, 'src', 'hub', 'hub.html'), 'utf8');
  const read = (f) => fs.readFileSync(path.join(root, 'src', 'hub', f), 'utf8');
  const data =
    `globalThis.__HUB_GAMES__ = ${JSON.stringify(games, null, 2)};\n` +
    `globalThis.__HUB_META__ = ${JSON.stringify(meta, null, 2)};`;
  const parts = {
    '/*__HUB_CSS__*/': read('hub.css'),
    '/*__HUB_DATA__*/': data,
    '/*__HUB_BRIDGE__*/': read('hub-bridge.js'),
    '/*__HUB_ROUTER__*/': read('router.js'),
    '/*__HUB_UI__*/': read('hub-ui.js')
  };
  for (const [anchor, content] of Object.entries(parts)) {
    html = replaceOnceText(html, anchor, content, `hub.html:${anchor}`);
  }
  return html;
}

export function copyAssets(srcDir, dstDir, opts = {}) {
  if (!fs.existsSync(srcDir)) return 0;
  const allow = new Set(opts.allowExt || []);
  let count = 0;
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name) || ent.name.startsWith('.')) continue;
    const from = path.join(srcDir, ent.name);
    const to = path.join(dstDir, ent.name);
    if (ent.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      count += copyAssets(from, to, opts);
    } else {
      if (SKIP_FILES.has(ent.name)) continue;
      const ext = path.extname(ent.name).toLowerCase();
      // classic 游戏用 <script src="./src/*.js|mjs"> 加载，这些脚本必须随产物一起复制；
      // esm 游戏已把依赖图内联成 bundle，源码脚本不进产物。
      if (SKIP_EXT.has(ext) && !allow.has(ext)) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      count++;
    }
  }
  return count;
}

export function copyDir(srcDir, dstDir) {
  if (!fs.existsSync(srcDir)) return 0;
  let count = 0;
  fs.mkdirSync(dstDir, { recursive: true });
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const from = path.join(srcDir, ent.name);
    const to = path.join(dstDir, ent.name);
    if (ent.isDirectory()) count += copyDir(from, to);
    else { fs.copyFileSync(from, to); count++; }
  }
  return count;
}
