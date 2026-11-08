/* gen-seedream.mjs — 用火山方舟 Doubao Seedream（豆包 / 即梦同源生图模型）生成封面原图
 *
 * 为什么需要它：内置图像生成模型会强制叠加右下角水印且无法切换模型；
 * 方舟 Seedream API 支持 watermark:false，可产出干净成品图。
 *
 * 准备：到 https://ark.cn-beijing.volces.com/apikey 申请 Key，并在方舟控制台
 *       开通 doubao-seedream 系列模型，然后设置环境变量 ARK_API_KEY。
 *       Key 只从环境变量读取，绝不写进仓库、不打印到日志。
 *
 * 用法:
 *   node tools/gen-seedream.mjs --dry-run          # 只打印请求计划，不联网、不花钱
 *   ARK_API_KEY=xxx node tools/gen-seedream.mjs   # 生成 4 张到 .tmp/covers-seedream/
 *   node tools/build-covers.mjs --src=.tmp/covers-seedream   # 压成 1280x800 WebP 上墙
 *
 * 可选: --model=<id> --size=2K|4K|1K --only=<id1,id2> --watermark
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG = path.join(ROOT, 'src/art/cover-prompts.json');
const OUT = path.join(ROOT, '.tmp/covers-seedream');
const ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/images/generations';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const hit = argv.find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : d;
};
const has = (k) => argv.includes('--' + k);

const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
const model = opt('model', cfg.model);
const size = opt('size', '2K');
const only = opt('only', '');
const watermark = has('watermark');
const dryRun = has('dry-run');
const key = process.env.ARK_API_KEY || '';

let items = cfg.items;
if (only) {
  const want = new Set(only.split(',').map((s) => s.trim()).filter(Boolean));
  items = items.filter((it) => want.has(it.id));
  const missing = [...want].filter((id) => !items.some((it) => it.id === id));
  if (missing.length) { console.error('[seedream] --only 里有未知 id: ' + missing.join(',')); process.exit(2); }
}

const plan = items.map((it, i) => ({
  file: String(i + 1).padStart(2, '0') + '.png',
  id: it.id,
  prompt: `${cfg.common}\n${it.subject}`
}));

console.log(`=== Seedream 生图计划：${plan.length} 张 | model=${model} | size=${size} | watermark=${watermark} ===`);
for (const p of plan) console.log(`  ${p.file}  ${p.id}`);

if (dryRun) {
  console.log('\n--dry-run：未联网、未调用 API、未产生费用。');
  console.log('提示词预览（第一张）:\n' + plan[0].prompt.slice(0, 300) + ' ...');
  process.exit(0);
}
if (!key) {
  console.error('\n[seedream] 缺少 ARK_API_KEY。');
  console.error('  1) 到 https://ark.cn-beijing.volces.com/apikey 申请 Key 并开通 doubao-seedream 模型');
  console.error('  2) PowerShell: $env:ARK_API_KEY="你的Key"');
  console.error('  3) Git Bash:   export ARK_API_KEY=你的Key');
  console.error('  然后重跑本脚本。Key 不会被写入任何仓库文件。');
  process.exit(2);
}

fs.mkdirSync(OUT, { recursive: true });
let ok = 0;
const failures = [];
for (const p of plan) {
  const body = {
    model,
    prompt: p.prompt,
    size,
    response_format: 'url',
    output_format: 'png',
    watermark
  };
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('响应不是 JSON: ' + text.slice(0, 200)); }
    const first = data && data.data && data.data[0];
    if (!first) throw new Error('响应缺少 data[0]: ' + text.slice(0, 300));

    let buf;
    if (first.b64_json) {
      buf = Buffer.from(first.b64_json, 'base64');
    } else if (first.url) {
      const img = await fetch(first.url);
      if (!img.ok) throw new Error('图片下载失败 HTTP ' + img.status);
      buf = Buffer.from(await img.arrayBuffer());
    } else {
      throw new Error('data[0] 既无 url 也无 b64_json');
    }
    if (buf.length < 1024) throw new Error('图片过小 ' + buf.length + ' B');
    if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG（输出格式可能未生效）');
    const dest = path.join(OUT, p.file);
    fs.writeFileSync(dest, buf);
    ok++;
    console.log(`  OK  ${p.file}  ${p.id}  ${(buf.length / 1024).toFixed(0)}KB`);
  } catch (e) {
    failures.push({ id: p.id, error: String(e.message) });
    console.error(`  FAIL ${p.file} ${p.id}: ${e.message}`);
  }
}

console.log(`\n=== Seedream 生成：${ok}/${plan.length} 成功，输出 ${OUT} ===`);
if (failures.length) {
  console.error('失败明细: ' + JSON.stringify(failures, null, 2));
  process.exit(1);
}
if (items.length === cfg.items.length) {
  console.log('下一步: node tools/build-covers.mjs --src=.tmp/covers-seedream');
} else {
  console.log('注意: 用了 --only，文件数不足，暂不要跑 build-covers.mjs（它要求 4 张成套）。');
}
