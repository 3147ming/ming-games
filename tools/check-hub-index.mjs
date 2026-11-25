/* tools/check-hub-index.mjs — 大厅索引一致性门禁
 *
 * 校验三件事：
 *   ① games.json 里每一条的 cover 文件都真实存在（避免出现「封面 404」的空卡片）
 *   ② games.json 里每一条的 dir/index.html 都真实存在（避免出现「点了打不开」的死链）
 *   ③ 根 index.html 内联 GAMES 数组的条数与「应该上首页的条目数」一致
 *      （避免首页漏游戏 / 多游戏 —— 加了一款却忘了跑 gen-hub-index.mjs）
 *
 * 规则与 tools/gen-hub-index.mjs 保持一致：
 *   · EXCLUDE 里的三条不上首页（enlisten 未完工 / lab-sandbox 与 lab 同源 / warehouse-strike 是外部项目）
 *   · `listed: false` 的条目不上首页
 *
 * 用法：node tools/check-hub-index.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDE = new Set(['enlisten', 'lab-sandbox', 'warehouse-strike']);

const problems = [];

const db = JSON.parse(fs.readFileSync(path.join(ROOT, 'games.json'), 'utf8'));
const games = Array.isArray(db.games) ? db.games : [];
const listed = games.filter((g) => !EXCLUDE.has(g.id) && g.listed !== false);

/* ① 封面存在性 */
for (const g of games) {
  if (!g.cover) { problems.push(`[${g.id}] games.json 里没有 cover 字段`); continue; }
  if (!fs.existsSync(path.join(ROOT, g.cover))) {
    problems.push(`[${g.id}] 封面缺失：${g.cover}`);
  }
}

/* ② 目录与入口存在性 */
for (const g of games) {
  const dir = g.dir || g.id;
  if (!dir) { problems.push(`[${g.id}] games.json 里没有 dir 字段`); continue; }
  const idx = path.join(ROOT, dir, 'index.html');
  if (!fs.existsSync(idx)) {
    /* status !== 'ready' 的条目本来就还没完工（如网页版英语听力是外部项目），
       不算死链，只提示。上首页的条目必须是 ready。 */
    const onHub = listed.includes(g);
    if (onHub) problems.push(`[${g.id}] 已上首页但入口缺失：${dir}/index.html`);
    else console.log(`  · [${g.id}] 未完工（status=${g.status}），跳过入口检查`);
    continue;
  }
  /* ESM 游戏要能真的找到 entry */
  if (g.renderer === 'esm' && g.entry) {
    const entry = path.join(ROOT, dir, g.entry);
    if (!fs.existsSync(entry)) problems.push(`[${g.id}] 入口脚本缺失：${dir}/${g.entry}`);
  }
}

/* ③ 根 index.html 内联 GAMES 数组的条数 */
const idxHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const m = idxHtml.match(/const GAMES = \[([\s\S]*?)\n\];/);
if (!m) {
  problems.push('根 index.html 里找不到内联的 GAMES 数组（首页被改坏了？）');
} else {
  const n = (m[1].match(/\n\s*\{\n/g) || []).length;
  if (n !== listed.length) {
    problems.push(`根 index.html 内联 GAMES ${n} 条 ≠ 应上首页 ${listed.length} 条（请跑 node tools/gen-hub-index.mjs）`);
  }
}

if (problems.length) {
  console.log('[check-hub-index] 未通过：');
  problems.forEach((p) => console.log('  ✗ ' + p));
  process.exit(1);
}
console.log(`[check-hub-index] 通过：${games.length} 个条目（${listed.length} 个上首页），封面与入口齐备，首页清单一致`);
