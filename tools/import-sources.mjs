/* import-sources.mjs — P1 受控源码导入 + SHA256 溯源清单
 *
 * 只按白名单从 D:/Projects/ 下的外部项目拷入主站根目录一级目录，
 * 不拷测试 / 构建工具 / 部署脚本 / 交付报告 / APK。
 * lab-sandbox 与 circuit-lab 同源（36/36 js 哈希一致），按计划只放一个
 * 入口 HTML + 指针说明，不重复拷第二份逻辑；构建期的路径重写在 P2 处理。
 *
 * 用法: node tools/import-sources.mjs [--check]
 *   --check 只校验现有导入文件与 SOURCES.sha256.json 是否一致，不写盘。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const EXTERNAL = 'D:/Projects';

const JOBS = [
  {
    id: 'future-light',
    from: path.join(EXTERNAL, 'FUTURE-LIGHT'),
    include: ['index.html', 'src']
  },
  {
    id: 'warehouse-strike',
    from: path.join(EXTERNAL, 'WAREHOUSE-STRIKE'),
    include: ['index.html', 'src', 'styles', 'vendor', 'public']
  }
];

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function collect(dir, base) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const abs = path.join(dir, ent.name);
    const rel = path.relative(base, abs).split(path.sep).join('/');
    if (ent.isDirectory()) out.push(...collect(abs, base));
    else if (ent.isFile()) out.push(rel);
  }
  return out.sort();
}

function copyJob(job) {
  const srcRoot = job.from;
  if (!fs.existsSync(srcRoot)) throw new Error('源目录不存在: ' + srcRoot);
  const dstRoot = path.join(ROOT, job.id);
  if (!CHECK) {
    if (fs.existsSync(dstRoot)) fs.rmSync(dstRoot, { recursive: true, force: true });
    fs.mkdirSync(dstRoot, { recursive: true });
  }
  const records = [];
  for (const item of job.include) {
    const from = path.join(srcRoot, item);
    if (!fs.existsSync(from)) throw new Error(`${job.id}: 白名单项缺失 ${item}`);
    const to = path.join(dstRoot, item);
    const isDir = fs.statSync(from).isDirectory();
    if (!CHECK) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(from, to, { recursive: isDir, force: true });
    }
    const rels = isDir ? collect(from, srcRoot) : [item];
    for (const rel of rels) {
      const p = isDir ? path.join(dstRoot, rel) : to;
      if (!fs.existsSync(p)) throw new Error(`${job.id}: 导入后缺文件 ${rel}`);
      const buf = fs.readFileSync(p);
      records.push({ file: `${job.id}/${rel}`, bytes: buf.length, sha256: sha256(buf) });
    }
  }
  return { id: job.id, from: srcRoot.replace(/\\/g, '/'), files: records.length, bytes: records.reduce((s, r) => s + r.bytes, 0), records };
}

function labSandbox() {
  const dstRoot = path.join(ROOT, 'lab-sandbox');
  const labHtml = fs.readFileSync(path.join(ROOT, 'circuit-lab/index.html'), 'utf8');
  // 源码态：与 circuit-lab 平级，直接相对引用；P2 构建产物里重写为 ../lab/
  let html = labHtml
    .replace(/(["'])\.\/(js|css|shared|examples|icons)\//g, '$1../circuit-lab/$2/')
    .replace(/(["'])\.\/(sw\.js|manifest\.json)\1/g, '$1../circuit-lab/$2$1');
  html = '<!-- P1 同源入口：逻辑复用 ../circuit-lab/，构建期由 P2 重写为 ../lab/ -->\n' + html;
  const pointer = {
    sharesLogicWith: 'circuit-lab',
    reason: 'lab-simulator/dist/js 与主站 circuit-lab/js 36/36 文件 SHA256 全量一致',
    source: 'D:/Projects/lab-simulator/dist',
    entryRewriteInBuild: '../lab/'
  };
  if (!CHECK) {
    if (fs.existsSync(dstRoot)) fs.rmSync(dstRoot, { recursive: true, force: true });
    fs.mkdirSync(dstRoot, { recursive: true });
    fs.writeFileSync(path.join(dstRoot, 'index.html'), html);
    fs.writeFileSync(path.join(dstRoot, 'SOURCE.json'), JSON.stringify(pointer, null, 2) + '\n');
  }
  const records = [];
  for (const [name, text] of [['index.html', html], ['SOURCE.json', JSON.stringify(pointer, null, 2) + '\n']]) {
    const p = path.join(dstRoot, name);
    if (CHECK && !fs.existsSync(p)) throw new Error(`lab-sandbox: 缺文件 ${name}`);
    const buf = CHECK ? fs.readFileSync(p) : Buffer.from(text);
    records.push({ file: `lab-sandbox/${name}`, bytes: buf.length, sha256: sha256(buf) });
  }
  return { id: 'lab-sandbox', from: 'D:/Projects/lab-simulator/dist (同源复用 circuit-lab)', files: records.length, bytes: records.reduce((s, r) => s + r.bytes, 0), records };
}

try {
  const groups = [...JOBS.map(copyJob), labSandbox()];
  const all = groups.flatMap((g) => g.records);
  const manifestPath = path.join(ROOT, 'SOURCES.sha256.json');
  if (CHECK) {
    const expected = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const exp = new Map(expected.files.map((r) => [r.file, r.sha256]));
    let bad = 0;
    for (const r of all) if (exp.get(r.file) !== r.sha256) { console.error('MISMATCH ' + r.file); bad++; }
    console.log(`=== 溯源校验：${all.length} 个文件，${bad} 处不一致 ===`);
    if (bad) process.exit(1);
  } else {
    const payload = {
      version: 1,
      generatedAt: new Date().toISOString(),
      note: 'P1 受控导入。warehouse-strike 来自本地快照 commit 3cea92d；lab-sandbox 与 circuit-lab 同源共用逻辑。',
      groups: groups.map(({ records, ...g }) => g),
      files: all
    };
    fs.writeFileSync(manifestPath, JSON.stringify(payload, null, 2) + '\n');
    for (const g of groups) console.log(`${g.id.padEnd(20)} ${String(g.files).padStart(4)} 文件  ${(g.bytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`\n=== 导入完成：${all.length} 个文件，清单 SOURCES.sha256.json ===`);
  }
} catch (e) {
  console.error('[import] ' + e.message);
  process.exit(1);
}
