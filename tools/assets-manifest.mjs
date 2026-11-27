/* assets-manifest.mjs — 把「assets/ 目录里真实有什么」写成一份清单
 *
 *   node tools/assets-manifest.mjs
 *
 * 为什么需要它：wild 的精灵是按规范名预留的（ranged.png / bossN.png 先写进代码，
 * 美术后补文件）。原先代码「先探测再加载」，结果每进一次页面就在控制台留一条 404 ——
 * 静态服务器的 404 由浏览器网络层记录，onerror / catch 抹不掉，唯一的解法是**不发请求**。
 * 于是改成清单式：构建时把存在性内联进产物，缺文件连 <img> 都不建。
 *
 * 产出：<game>/assets/present.json  { sprites: [id, ...] }
 * 约定：文件名 = 精灵 id + '.png'（见 wild/src/arena.js 的 SPRITE_FILE）。
 * 以后补了美术，只需再跑一次本脚本 + 重建，页面自动用上真图。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* 需要清单的游戏：dir → 从哪个源码文件读 SPRITE_FILE 的键 */
const TARGETS = [
  { dir: 'wild', src: 'src/arena.js' },
];

function spriteIds(arenaSrc) {
  // SPRITE_FILE = { hero: 'hero.png', ... } —— 只取键名，键顺序无用。
  const m = /const SPRITE_FILE = \{([\s\S]*?)\n\};/.exec(arenaSrc);
  if (!m) throw new Error('找不到 SPRITE_FILE 定义');
  const ids = [...m[1].matchAll(/(\w+)\s*:/g)].map((x) => x[1]);
  if (!ids.length) throw new Error('SPRITE_FILE 里没有解析到任何 id');
  return ids;
}

let changed = 0;
for (const t of TARGETS) {
  const gameDir = path.join(ROOT, t.dir);
  const ids = spriteIds(fs.readFileSync(path.join(gameDir, t.src), 'utf8'));
  const present = ids.filter((id) => fs.existsSync(path.join(gameDir, 'assets', id + '.png')));
  const missing = ids.filter((id) => !present.includes(id));
  const out = path.join(gameDir, 'assets', 'present.json');
  const body = JSON.stringify({ $comment: '由 tools/assets-manifest.mjs 生成，勿手改', sprites: present }, null, 2) + '\n';
  const old = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  if (old !== body) { fs.writeFileSync(out, body, 'utf8'); changed++; }
  console.log(`[assets] ${t.dir}: 有 ${present.length} 个 / 缺 ${missing.length} 个${missing.length ? '（' + missing.join(', ') + '）' : ''}`);
}
console.log(`[assets] 清单${changed ? `已更新 ${changed} 个` : '无变化'}`);
