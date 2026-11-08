/* check-deploy.mjs — 部署写目标门禁
 * 防止 ming-games.surge.sh / ming-game-gym.surge.sh 这类被多方发布的域名再次互相覆盖。
 * 唯一域名真源是 deploy.config.json；frozen / deprecated / readonly 目标禁止作为写入目标。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'deploy.config.json'), 'utf8'));
const blocked = cfg.targets.filter((t) => ['frozen', 'deprecated', 'readonly'].includes(t.status));
const blockedHosts = blocked.map((t) => t.host);
const canonical = new URL(cfg.canonical).hostname;

function listFiles(dir, exts) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) continue;
    if (exts.some((e) => ent.name.toLowerCase().endsWith(e))) out.push(abs);
  }
  return out;
}

const activeFiles = [
  ...listFiles(ROOT, ['.mjs', '.js', '.bat', '.ps1']),
  ...listFiles(path.join(ROOT, 'tools'), ['.mjs', '.js', '.ps1']),
  ...listFiles(path.join(ROOT, 'src', 'hub'), ['.js'])
].filter((f) => path.basename(f) !== 'check-deploy.mjs');

const WRITE_WORDS = /\b(surge|publish|deploy|CNAME|DOMAIN|sync-deploy|writableBy)\b/i;
const errors = [];
const warnings = [];

for (const file of activeFiles) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const host of blockedHosts) {
      if (!line.includes(host)) continue;
      if (WRITE_WORDS.test(line)) {
        errors.push({ file: path.relative(ROOT, file), line: i + 1, host, text: line.trim().slice(0, 160) });
      }
    }
    // 活跃脚本里出现未登记的其它域名，提醒（canonical 除外）
    const m = line.match(/([a-z0-9-]+\.(?:surge\.sh|pages\.dev|github\.io))/i);
    if (m && m[1] !== canonical && !cfg.targets.some((t) => t.host === m[1]) &&
        !cfg.otherHosts.some((t) => t.host === m[1])) {
      warnings.push({ file: path.relative(ROOT, file), line: i + 1, kind: 'unregistered-host', text: line.trim().slice(0, 160) });
    }
  });
}

/* 仓库外的历史发布脚本：只报告，不阻断（P1 归档/停用） */
const legacy = [
  'D:/Projects/FUTURE-LIGHT/tools/sync-deploy.mjs',
  'D:/Projects/deploy-hub.bat',
  'D:/Projects/HUB/tools/sync-deploy.mjs',
  'D:/Projects/HUB/MAINTENANCE.md',
  'D:/Projects/BRAIN-GYM/tools/check-brain-gym.mjs'
];
const legacyHits = [];
for (const file of legacy) {
  if (!fs.existsSync(file)) continue;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const host of blockedHosts) {
      if (line.includes(host)) legacyHits.push({ file, line: i + 1, host, text: line.trim().slice(0, 140) });
    }
  });
}

console.log('=== 部署写目标门禁 ===');
console.log(`域名真源: deploy.config.json (v${cfg.version})`);
console.log(`唯一线上入口: ${cfg.canonical}`);
console.log(`冻结/废弃/只读目标: ${blockedHosts.length} 个`);
console.log(`活跃构建链扫描: ${activeFiles.length} 个文件`);
console.log(`未登记域名提醒: ${warnings.length} 处 | 活跃链违规: ${errors.length} 处 | 仓库外遗留: ${legacyHits.length} 处`);
if (errors.length) {
  console.log('\n[ERROR] 活跃构建链里存在对冻结域名的写入意图：');
  for (const e of errors) console.log(`  ${e.file}:${e.line}  ${e.host}  ${e.text}`);
}
if (warnings.length) {
  console.log('\n[WARN] 未登记域名：');
  for (const w of warnings.slice(0, 20)) console.log(`  ${w.file}:${w.line}  ${w.text}`);
}
if (legacyHits.length) {
  console.log('\n[LEGACY] 仓库外历史脚本仍提及冻结域名（P0 已改 FUTURE-LIGHT 一处，其余 P1 归档时停用）：');
  for (const h of legacyHits.slice(0, 20)) console.log(`  ${h.file}:${h.line}  ${h.host}`);
}
console.log(errors.length ? '\n=== 门禁：未通过 ===' : '\n=== 门禁：通过（活跃构建链 0 违规） ===');
process.exit(errors.length ? 1 : 0);
