/* build.mjs — 一条构建链产出三形态产物
 *
 *   node tools/build.mjs --target=web       -> dist/     (pages.dev + 本地服务)
 *   node tools/build.mjs --target=offline   -> offline/  (file:// 双击、断网可玩)
 *   node tools/build.mjs --target=all
 *   node tools/build.mjs --game=paper-maze --target=all
 *   node tools/build.mjs --no-openall       (P3 起生效：生成原版行为产物作为回退对照)
 *
 * 纪律：产物目录整体重建；游戏业务源码零改动；产物由模板 + 数据生成。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { bundle } from './esm-to-classic.mjs';
import { renderGameHtml, renderHubHtml, copyAssets, copyDir } from './build-offline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const targetArg = arg('target', 'all');
const gameFilter = arg('game', '');
const noOpenall = process.argv.includes('--no-openall');
const targets = targetArg === 'all' ? ['web', 'offline'] : [targetArg];
if (!targets.every((t) => t === 'web' || t === 'offline')) {
  console.error('[build] --target 只接受 web / offline / all');
  process.exit(2);
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function cleanDir(dir) {
  const safe = path.resolve(dir);
  if (!safe.startsWith(ROOT + path.sep)) throw new Error(`[build] 拒绝清理 ROOT 之外的目录: ${safe}`);
  if (!['dist', 'offline'].includes(path.basename(safe))) throw new Error(`[build] 拒绝清理非产物目录: ${safe}`);
  fs.rmSync(safe, { recursive: true, force: true });
  fs.mkdirSync(safe, { recursive: true });
}
function writeManifest(outDir, name, target, extra) {
  const files = {};
  (function walk(d, rel) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, ent.name);
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) walk(abs, r);
      else files[r] = { bytes: fs.statSync(abs).size, sha256: sha256(fs.readFileSync(abs)) };
    }
  })(outDir, '');
  const payload = Object.assign({
    version: 1, target: target, artifact: name, generatedAt: new Date().toISOString(),
    noOpenall: noOpenall, fileCount: Object.keys(files).length, files
  }, extra || {});
  fs.writeFileSync(path.join(ROOT, name + '.manifest.json'), JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'games.json'), 'utf8'));
const bridgeCode = fs.readFileSync(path.join(ROOT, 'src', 'hub', 'hub-bridge.js'), 'utf8');
const ready = cfg.games.filter((g) => g.status === 'ready' && (!gameFilter || g.id === gameFilter));
if (!ready.length) {
  console.error(`[build] 没有 status=ready 的游戏${gameFilter ? '（--game=' + gameFilter + '）' : ''}`);
  process.exit(2);
}

const listed = cfg.games.filter((g) => g.listed !== false);
const hubGames = listed.map((g) => Object.assign({}, g, { playUrl: 'games/' + g.id + '/index.html' }));
const meta = {
  subtitle: '同页切换 · 完全离线 · 本地服务 · 线上访问',
  footnote: '当前为 P0 地基版：大厅收录 ' + hubGames.length + ' 款，已接入 ' + ready.length +
    ' 款可玩，其余由 P1/P2 构建链接入；另有 ' + (cfg.games.length - listed.length) +
    ' 个新项目在 P1 连同封面一起上。Q 版成品视觉在 P4。',
  build: { date: new Date().toISOString(), noOpenall: noOpenall }
};

let totalBytes = 0;
for (const target of targets) {
  const outDir = path.join(ROOT, target === 'web' ? 'dist' : 'offline');
  cleanDir(outDir);
  const covers = copyDir(path.join(ROOT, 'covers'), path.join(outDir, 'covers'));
  const built = [];

  for (const g of ready) {
    const srcDir = path.join(ROOT, g.dir);
    if (!fs.existsSync(path.join(srcDir, 'index.html'))) {
      throw new Error(`[build] ${g.id}: 源入口不存在 ${srcDir}/index.html`);
    }
    const dstDir = path.join(outDir, 'games', g.id);
    fs.mkdirSync(dstDir, { recursive: true });

    let bundleCode = '';
    let modules = [];
    let warnings = [];
    if (g.renderer === 'esm') {
      const r = bundle(path.join(srcDir, g.entry));
      bundleCode = r.code;
      modules = r.modules;
      warnings = r.warnings;
    }
    const html = renderGameHtml({
      gameDir: srcDir, gameId: g.id, entryRel: g.entry || '', renderer: g.renderer,
      bundleCode, bridgeCode, label: `${target}:${g.id}`
    });
    fs.writeFileSync(path.join(dstDir, 'index.html'), html, 'utf8');
    const assets = copyAssets(srcDir, dstDir, {
      allowExt: g.renderer === 'classic' ? ['.js', '.mjs'] : []
    });
    totalBytes += Buffer.byteLength(html, 'utf8');
    built.push({ id: g.id, modules: modules.length, bytes: Buffer.byteLength(html, 'utf8'), assets, warnings });
  }

  const hubHtml = renderHubHtml({ root: ROOT, games: hubGames, meta });
  fs.writeFileSync(path.join(outDir, 'index.html'), hubHtml, 'utf8');
  const manifest = writeManifest(outDir, target === 'web' ? 'dist' : 'offline', target, { built, covers });

  console.log(`=== ${target} 构建完成 -> ${outDir} ===`);
  console.log(`大厅: ${Buffer.byteLength(hubHtml, 'utf8')} B | 卡片 ${hubGames.length} 张 | 封面 ${covers} 张 | 文件 ${manifest.fileCount} 个`);
  for (const b of built) {
    console.log(`  ${b.id.padEnd(18)} ${String(b.bytes).padStart(7)} B  ${b.modules} 模块  ${b.assets} 资源`);
    for (const w of b.warnings) console.log(`    WARN ${w}`);
  }
}
console.log(`=== 全部完成（${targets.join(', ')}），产物 HTML 合计 ${totalBytes} B ===`);
