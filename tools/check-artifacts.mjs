/* check-artifacts.mjs — 三形态产物完整性检查（dist / offline / 源目录）
 *
 * 起因：统一构建链曾因为「整块删除含 serviceWorker.register 的脚本」，
 * 把知识问答这类单文件游戏削成 39KB 的空壳（题库 0 题），而构建本身不报错。
 * 这里在构建之后做一次静态体检，把「产物还在但应用没了」挡在发布之前。
 *
 * 用法: node tools/check-artifacts.mjs [--quiet]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUIET = process.argv.includes('--quiet');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'games.json'), 'utf8'));
const ready = cfg.games.filter((g) => g.status === 'ready');

const problems = [];
const rows = [];

function statOf(p) {
  if (!fs.existsSync(p)) return null;
  return fs.statSync(p).size;
}

for (const g of ready) {
  const srcDir = path.join(ROOT, g.dir);
  const srcBytes = statOf(path.join(srcDir, 'index.html'));
  for (const target of ['dist', 'offline']) {
    const p = path.join(ROOT, target, 'games', g.id, 'index.html');
    const bytes = statOf(p);
    const label = `${target}/${g.id}`;
    if (bytes === null) {
      problems.push(`${label}: 产物缺失（先跑 node tools/build.mjs --target=all）`);
      rows.push([label, '缺失', 0, false]);
      continue;
    }
    const html = fs.readFileSync(p, 'utf8');
    const scripts = (html.match(/<script/gi) || []).length;
    let ok = bytes > 5000 && scripts > 0;
    let why = '';
    if (!ok) why = `只剩 ${bytes} B / ${scripts} 个 script，疑似被削成外壳`;
    /* classic 游戏的应用代码内联在源码 HTML 里，产物不该比源文件小太多 */
    const renderer = g.renderer || 'classic';
    if (ok && renderer === 'classic' && srcBytes && bytes < srcBytes * 0.8) {
      ok = false;
      why = `产物 ${bytes} B < 源 ${srcBytes} B 的 80%`;
    }
    /* 知识问答的关键符号：书架 + 四组分类 */
    if (ok && g.id === 'quiz' && (html.indexOf('id="shelf"') < 0 || html.indexOf('SUBJECT_GROUPS') < 0)) {
      ok = false;
      why = '缺少书架或科目分组符号';
    }
    if (!ok) problems.push(`${label}: ${why}`);
    rows.push([label, bytes + ' B', scripts, ok]);
  }
}

if (!QUIET) {
  console.log('=== 三形态产物完整性 ===');
  rows.forEach((r) => console.log(`${r[3] ? '✓' : '✗'} ${r[0].padEnd(26)} ${String(r[1]).padStart(10)}  script=${r[2]}`));
}
if (problems.length) {
  console.log('\n[ERROR] ' + problems.length + ' 处产物不完整：');
  problems.forEach((p) => console.log('  ' + p));
  process.exit(1);
}
console.log(`\n产物完整性：${rows.length} 个目标全部通过（${ready.length} 款 ready 游戏 × 2 形态）`);
