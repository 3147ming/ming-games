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
import { renderGameHtml, renderHubHtml, copyAssets, copyDir, readImportMap } from './build-offline.mjs';
import { threeToClassic } from './vendor-map.mjs';
import { buildAssetLayer } from './build-assets.mjs';

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
const byId = new Map(cfg.games.map((g) => [g.id, g]));
const bridgeCode = fs.readFileSync(path.join(ROOT, 'src', 'hub', 'hub-bridge.js'), 'utf8');

/* P2b：3D 项目的 Three.js 不进 ESM 依赖图，单独 classic 化成 globalThis.THREE。
 * 自动从 index.html 的 importmap 读取映射；没有 importmap 的项目（搜打撤）按约定路径探测。
 * 若同一目录同时有 shim（three.module.js，几 KB）与完整版（three.module.full.js，~1.27MB），
 * 一律用完整版，shim 与完整版都映射到全局 —— 彻底去掉 CDN 兜底与动态 import(blobUrl)。 */
function makeVendorPlan(srcDir, gameId) {
  const htmlPath = path.join(srcDir, 'index.html');
  const imports = fs.existsSync(htmlPath) ? readImportMap(fs.readFileSync(htmlPath, 'utf8')) : {};
  const candidates = [
    imports.three,
    'vendor/three/three.module.full.js',
    'vendor/three/three.module.js',
    'vendor/three.module.js'
  ].filter(Boolean).map((p) => path.resolve(srcDir, p.replace(/^\.\//, '')));
  const existing = [...new Set(candidates.filter((p) => fs.existsSync(p)))];
  if (!existing.length) return null;
  // 完整版优先（体积最大的那个就是完整 build；shim 只有几 KB）
  const main = existing.slice().sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
  const threeSet = new Set(existing.map((p) => path.resolve(p)));
  const jsmAbs = imports['three/'] ? path.resolve(srcDir, imports['three/'].replace(/^\.\//, '')) : null;
  const conv = threeToClassic(main);
  const resolve = (spec, fromFile) => {
    if (spec === 'three') return { type: 'global', name: 'THREE' };
    if (jsmAbs && spec.startsWith('three/')) return { type: 'file', abs: path.join(jsmAbs, spec.slice(6)) };
    if (spec.startsWith('.')) {
      const abs = path.resolve(path.dirname(fromFile), spec);
      if (threeSet.has(abs)) return { type: 'global', name: 'THREE' };
    }
    return null;
  };
  return {
    resolve, code: conv.code, exports: conv.exports.length, source: path.relative(ROOT, main),
    relPath: 'vendor/three.classic.js', warnings: conv.warnings
  };
}
const ready = cfg.games.filter((g) => g.status === 'ready' && (!gameFilter || g.id === gameFilter));
if (!ready.length) {
  console.error(`[build] 没有 status=ready 的游戏${gameFilter ? '（--game=' + gameFilter + '）' : ''}`);
  process.exit(2);
}

const listed = cfg.games.filter((g) => g.listed !== false);
const hubGames = listed.map((g) => Object.assign({}, g, { playUrl: 'games/' + g.id + '/index.html' }));
const meta = {
  subtitle: '同页切换 · 完全离线 · 本地服务 · 线上访问',
  footnote: '大厅收录 ' + hubGames.length + ' 款，已接入 ' + ready.length +
    ' 款可离线试玩；三形态由同一份源码构建。Q 版成品视觉在 P4，解除体验限制与元系统在 P3。',
  build: { date: new Date().toISOString(), noOpenall: noOpenall }
};

let totalBytes = 0;
for (const target of targets) {
  const outDir = path.join(ROOT, target === 'web' ? 'dist' : 'offline');
  cleanDir(outDir);
  const covers = copyDir(path.join(ROOT, 'covers'), path.join(outDir, 'covers'));
  const built = [];

  for (const g of ready) {
    /* logicFrom：同源游戏的第二张卡（lab-sandbox ← lab）共用一份逻辑与入口，
       不重复拷 36 个 js，只多产一份带自己 gameId 的入口 HTML。 */
    const logic = g.logicFrom ? byId.get(g.logicFrom) : g;
    if (!logic) throw new Error(`[build] ${g.id}: logicFrom=${g.logicFrom} 在 games.json 里不存在`);
    const srcDir = path.join(ROOT, logic.dir);
    const entry = logic.entry || g.entry;
    const renderer = logic.renderer || g.renderer;
    if (!fs.existsSync(path.join(srcDir, 'index.html'))) {
      throw new Error(`[build] ${g.id}: 源入口不存在 ${srcDir}/index.html`);
    }
    const dstDir = path.join(outDir, 'games', g.id);
    fs.mkdirSync(dstDir, { recursive: true });

    const plan = makeVendorPlan(srcDir, g.id);
    let bundleCode = '';
    let modules = [];
    let warnings = [];
    if (renderer === 'esm') {
      const r = bundle(path.join(srcDir, entry), plan ? { resolve: plan.resolve } : {});
      bundleCode = r.code;
      modules = r.modules;
      warnings = r.warnings;
    }
    const vendorScripts = [];
    let preludeCode = '';
    if (plan) {
      fs.mkdirSync(path.join(dstDir, 'vendor'), { recursive: true });
      fs.writeFileSync(path.join(dstDir, plan.relPath), plan.code, 'utf8');
      vendorScripts.push(plan.relPath);
      warnings.push(`three: ${plan.source} -> globalThis.THREE（${plan.exports} 个导出）`);
      for (const w of plan.warnings) warnings.push(`three: ${w}`);
      /* 3D 项目才需要资源层：图片转 data URI 供 TextureLoader，FBX/GLB/音频转按需 JS 供 fetch。
         两个 target 都生成，保证 dist 与 offline 内容一致。 */
      const layer = buildAssetLayer({ srcDir, dstDir, gameId: g.id, roots: ['public', 'assets'] });
      if (layer.fileCount) {
        vendorScripts.push(...layer.scripts);
        preludeCode = layer.inlineShim || '';
        warnings.push(`assets: ${layer.fileCount} 个资源本地化（同步 ${layer.syncBytes} B / 懒加载 ${layer.asyncCount} 个 / 共 ${layer.totalBytes} B）`);
        for (const w of layer.warnings) warnings.push(`assets: ${w}`);
      }
    }
    const html = renderGameHtml({
      gameDir: srcDir, gameId: g.id, entryRel: entry || '', renderer,
      bundleCode, bridgeCode, label: `${target}:${g.id}`, vendorScripts, preludeCode
    });
    fs.writeFileSync(path.join(dstDir, 'index.html'), html, 'utf8');
    let assets = copyAssets(srcDir, dstDir, {
      allowExt: renderer === 'classic' ? ['.js', '.mjs'] : []
    });
    if (g.logicFrom) assets += copyAssets(path.join(ROOT, g.dir), dstDir, { allowExt: [] });
    totalBytes += Buffer.byteLength(html, 'utf8');
    built.push({
      id: g.id, modules: modules.length, bytes: Buffer.byteLength(html, 'utf8'),
      assets, warnings, threeExports: plan ? plan.exports : 0
    });
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
