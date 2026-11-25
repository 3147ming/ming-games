/* tools/gen-hub-index.mjs —— 从 games.json 生成根首页的 GAMES 块
 *
 * 用法：node tools/gen-hub-index.mjs [--dry]
 *
 * 背景
 * ------------------------------------------------------------
 * 改造前，首页的游戏清单存在三份：
 *   1. games.json      —— 构建链的真源（目录 / 入口 / 渲染器 / 状态）
 *   2. 根 index.html   —— 线上首页实际用的清单（name/en/desc/kw/cover/ar/url/order）
 *   3. src/hub/hub-sdk.js —— 离线产物用的精简清单
 * 加一款游戏要改三处，迟早漏 —— 这轮改造先把 1 和 2 合并：
 * games.json 增加展示字段，成为唯一真源；index.html 的 GAMES 块由本脚本生成。
 *
 * 为什么不用 fetch('/data/games.json')
 * ------------------------------------------------------------
 * 首页要支持 file:// 双击打开（DECISIONS.md D2 第 1 条）。
 * file:// 下 fetch 被同源策略挡住，所以清单必须内联在 HTML 里。
 * 「外置成 JSON」在纯静态托管下等于把构建期工作挪到运行期，与离线约束冲突。
 * 正确做法是：JSON 作为源、构建期生成内联块 —— 既单一真源，又不破坏 file://。
 *
 * 纪律（沿用 DECISIONS.md「执行纪律」）
 * ------------------------------------------------------------
 * 大文件改写必须走 tools/anchor.mjs 的锚点唯一性校验，命中数不为 1 整体中止。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replaceOnceText } from './anchor.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dry = process.argv.includes('--dry');

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'games.json'), 'utf8'));

/* 上线首页只列「已上线」的游戏。
   games.json 里还有三类不上首页的：
     · enlisten        —— status=pending，网页版还没做
     · lab-sandbox     —— 与 lab 同源共享逻辑的第二张卡，不单独占首页位
     · warehouse-strike —— 外部独立项目（另一个 Pages 站），不走本仓库构建链
   这三条由 EXCLUDE 显式列出，不用猜。 */
const EXCLUDE = new Set(['enlisten', 'lab-sandbox', 'warehouse-strike']);

/* 缺展示字段就报错 —— 宁可停下也不产出一张空卡片。
   games.json 是数据源，字段缺失说明写数据时漏了，不该在生成阶段悄悄兜底。 */
const REQUIRED = ['name', 'desc', 'cover', 'ar', 'orientation', 'channel'];

const listed = cfg.games
  .filter((g) => !EXCLUDE.has(g.id))
  .map((g) => {
    const missing = REQUIRED.filter((k) => g[k] === undefined || g[k] === null || g[k] === '');
    if (missing.length) {
      throw new Error(`[gen-hub-index] ${g.id} 缺字段：${missing.join(', ')}`);
    }
    return g;
  })
  .sort((a, b) => (a.order ?? 999) - (b.order ?? 999));

/* 单引号转义：desc / kw 里可能带撇号（如「玩家��」）。 */
function q(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/* 生成 GAMES 数组字面量。
   字段顺序与原 index.html 保持一致，方便 diff 审阅。 */
function renderGames() {
  const lines = ['const GAMES = ['];
  listed.forEach((g, idx) => {
    const f = [];
    f.push(`    id: '${q(g.id)}'`);
    f.push(`    name: '${q(g.name)}'`);
    if (g.en) f.push(`    en: '${q(g.en)}'`);
    f.push(`    desc: '${q(g.desc)}'`);
    if (g.kw) f.push(`    kw: '${q(g.kw)}'`);
    f.push(`    tag: '${q(g.tag)}'`);
    f.push(`    channel: '${q(g.channel)}'`);
    f.push(`    players: '${q(g.players || '单人')}'`);
    f.push(`    multiplayer: '${q(g.multiplayer || 'none')}'`);
    f.push(`    cover: '${q(g.cover)}'`);
    f.push(`    ar: '${q(g.ar)}'`);
    f.push(`    url: '${q(g.url || (g.dir + '/'))}'`);
    f.push(`    status: '${q(g.hubStatus || (g.status === 'ready' ? 'live' : 'dev'))}'`);
    f.push(`    order: ${g.order ?? idx + 1}`);
    f.push(`    orientation: '${q(g.orientation)}'`);
    if (g.funFact) f.push(`    funFact: '${q(g.funFact)}'`);
    lines.push('  {');
    lines.push(f.map((x) => x + ',').join('\n'));
    lines.push('  }' + (idx < listed.length - 1 ? ',' : ''));
  });
  lines.push('];');
  return lines.join('\n');
}

/* 频道 → 中文名与说明。UI 文案集中在这里，别散落在渲染逻辑里。 */
export const CHANNELS = [
  { id: 'casual', name: '休闲小游戏', desc: '点开就能玩，一局几分钟' },
  { id: 'party', name: '多人派对', desc: '热座或纯 P2P，和朋友一起' },
  { id: 'board', name: '策略棋牌', desc: '动脑子的慢局，棋与牌' },
  { id: 'tool', name: '实用工具', desc: '学习、实验、日常用得上' },
];

const htmlPath = path.join(ROOT, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

/* 锚点：GAMES 块的起止。取「const GAMES = [」到第一个独占一行的「];」——
   它是块尾，下一个「];」不属于它。用 lastIndexOf 之前的第一个即命中。 */
const startAnchor = 'const GAMES = [';
const start = html.indexOf(startAnchor);
if (start < 0) throw new Error('[gen-hub-index] 找不到 GAMES 起点锚点');
const endRel = html.indexOf('\n];', start);
if (endRel < 0) throw new Error('[gen-hub-index] 找不到 GAMES 终点锚点');
const oldBlock = html.slice(start, endRel + 3);

const newBlock = renderGames();

if (oldBlock === newBlock) {
  console.log('[gen-hub-index] GAMES 块已是最新，无需改动');
  process.exit(0);
}

/* 走锚点唯一性校验：把整块当锚点替换。 */
const out = replaceOnceText(html, oldBlock, newBlock, 'index.html:GAMES 块');

if (dry) {
  console.log('[gen-hub-index] --dry：未写盘。将生成 ' + listed.length + ' 条。');
} else {
  fs.writeFileSync(htmlPath, out, 'utf8');
  console.log('[gen-hub-index] 已更新 index.html：' + listed.length + ' 条（' +
    CHANNELS.map((c) => c.name + ' ' + listed.filter((g) => g.channel === c.id).length).join(' / ') + '）');
}
