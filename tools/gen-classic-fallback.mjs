/* tools/gen-classic-fallback.mjs —— 为源码目录生成「file:// 双击可玩」的 classic 兜底包
 *
 * 用法：
 *   node tools/gen-classic-fallback.mjs            # 生成所有已登记 classic 兜底的游戏
 *   node tools/gen-classic-fallback.mjs fishing    # 只生成指定游戏
 *
 * 为什么需要它：
 *   Chrome 下 file:// 协议会用 CORS 拦掉 ES 模块（ES module 走的是跨源请求），
 *   所以 `<script type="module" src="./src/main.mjs">` 在 file:// 下必然白屏。
 *   仓库里其它游戏（ludo / gomoku / liar …）靠 tools/build.mjs 产出的 offline/ 形态玩 file://；
 *   但「双击源码目录里的 index.html 就能玩」这条要求，需要源码目录里自带一份 classic 包。
 *
 * 做法：直接用仓库自带的 tools/esm-to-classic.mjs 把 ESM 依赖图打成单个 classic 脚本，
 *   源码零改动，产物与 build 产物同源同码。
 *
 * 产物：<game>/src/<game>.classic.js
 *   页面里用一个极小的 classic 兜底脚本监听 module 加载失败（file:// 才会发生），
 *   失败时再加载这个包；http/https 下根本不会触发。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from './esm-to-classic.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));

/* 需要 classic 兜底的游戏：源码目录里有 index.html 且声明了 esm 入口 */
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'games.json'), 'utf8'));
const targets = cfg.games.filter((g) => {
  if (g.status !== 'ready') return false;
  if (only.length && only.indexOf(g.id) < 0) return false;
  if (!g.entry || !/\.mjs$/.test(g.entry)) return false;
  return fs.existsSync(path.join(ROOT, g.dir, 'index.html'));
});

if (!targets.length) {
  console.error('[gen-classic-fallback] 没有需要生成的游戏');
  process.exit(1);
}

for (const g of targets) {
  const srcDir = path.join(ROOT, g.dir);
  const entry = path.join(srcDir, g.entry);
  const r = bundle(entry);
  const out = path.join(srcDir, 'src', g.id + '.classic.js');
  const header = [
    '/* ' + path.relative(ROOT, out) + ' —— 自动生成，勿手改。',
    ' * 来源：' + g.entry + '（用 tools/esm-to-classic.mjs 打的包）',
    ' * 用途：源码目录直接双击（file://）时，浏览器会 CORS 拦掉 ES 模块，',
    ' *       页面里的兜底脚本会改加载这个 classic 包。',
    ' * 重新生成：node tools/gen-classic-fallback.mjs ' + g.id,
    ' */',
    '',
  ].join('\n');
  fs.writeFileSync(out, header + r.code, 'utf8');
  console.log('[gen-classic-fallback] ' + g.id + ' → ' + path.relative(ROOT, out) +
    '  ' + fs.statSync(out).size + ' B' +
    (r.warnings && r.warnings.length ? '  ⚠ ' + r.warnings.length + ' 条警告' : ''));
}
