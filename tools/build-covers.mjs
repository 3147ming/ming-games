/* build-covers.mjs — 把 ImageGen 产出的原始大图压成大厅可用的轻量封面
 *
 * 为什么需要它：本机没有 PIL / sharp / ImageMagick / ffmpeg，但仓库已有
 * 无头 Edge + CDP 探针链路，故直接用浏览器 canvas 做高质量缩放与 WebP 编码。
 * data: URI 图片不会污染 canvas，about:blank 下也不需要任何本地文件权限。
 *
 * 用法: node tools/build-covers.mjs [--src=.tmp/covers-raw] [--out=covers]
 * 输入目录里的 PNG 按文件名时间戳排序，逐一映射到 IDS 列表（生成顺序）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : d;
};
const RAW = path.resolve(ROOT, arg('src', '.tmp/covers-raw'));
const OUT = path.resolve(ROOT, arg('out', 'covers'));
const W = 1280;
const H = 800;
const QUALITY = 0.88;
/* 豆包/内置模型生成图底部会叠加水印带，默认裁 5%；若水印位置不同可用 --trim 调。 */
const TRIM = (() => { const v = Number(arg('trim', '0.05')); return Number.isFinite(v) && v >= 0 && v < 0.3 ? v : 0.05; })();
const CDP_PORT = 9334;
const PROFILE = path.join(os.tmpdir(), 'mg-covers-cdp-' + Date.now());
/* ID 顺序从封面提示词配置派生，保证 gen-seedream.mjs 与压缩链路始终成套；
   不要再在这里硬编码一份 id 列表。 */
const IDS = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'src/art/cover-prompts.json'), 'utf8')
).items.map((it) => it.id);

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
];
const browser = BROWSERS.find((p) => fs.existsSync(p));
if (!browser) { console.error('[covers] 未找到 Edge/Chrome'); process.exit(2); }
if (!fs.existsSync(RAW)) { console.error('[covers] 原始图目录不存在: ' + RAW); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitHttp(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return true; } catch { /* noop */ }
    await sleep(200);
  }
  return false;
}

let edge = null;
try {
  /* 两种映射模式：
     1) 文件名含游戏 id（推荐，豆包回传图按 id 命名）→ 精确对应，允许分批只处理几张；
     2) 无 id 的内置模型产物 → 回退到按时间戳排序映射，数量必须齐全。 */
  const all = fs.readdirSync(RAW).filter((f) => /\.(png|jpe?g|webp)$/i.test(f));
  const norm = (s) => s.toLowerCase().replace(/\.(png|jpe?g|webp)$/i, '').replace(/[-_\s]/g, '');
  const idKeys = IDS.map((id) => [norm(id), id]);
  const matched = all.map((f) => {
    const key = norm(f);
    const hit = idKeys.find(([k]) => key === k || key.includes(k));
    return { file: f, id: hit ? hit[1] : null };
  });
  let jobs;
  if (all.length > 0 && matched.every((m) => m.id)) {
    jobs = matched.sort((a, b) => IDS.indexOf(a.id) - IDS.indexOf(b.id));
    console.log(`[covers] 按文件名匹配 id：${jobs.map((j) => j.id).join(', ')}（${jobs.length}/${IDS.length} 张）`);
  } else {
    const files = all.sort();
    if (files.length !== IDS.length) {
      console.error(`[covers] 期望 ${IDS.length} 张原图，实际 ${files.length} 张：${files.join(', ')}`);
      console.error('[covers] 提示：把原图命名为 warehouse-strike.png / lab-sandbox.png / enlisten.png 可精确对应，且允许分批只处理其中几张。');
      process.exit(2);
    }
    jobs = files.map((f, i) => ({ file: f, id: IDS[i] }));
    console.log('[covers] 未识别到 id 文件名，按时间戳顺序映射（旧链路）');
  }
  fs.mkdirSync(OUT, { recursive: true });

  edge = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + PROFILE, 'about:blank'
  ], { stdio: 'ignore' });
  if (!await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/version`)) throw new Error('CDP 端口未就绪');

  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  let page = list.find((t) => t.type === 'page');
  if (!page) page = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`)).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  let id = 0;
  const pend = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) {
      const { resolve, reject } = pend.get(m.id);
      pend.delete(m.id);
      if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    pend.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); reject(new Error('timeout ' + method)); } }, 60000);
  });

  for (const job of jobs) {
    const src = path.join(RAW, job.file);
    const rawBuf = fs.readFileSync(src);
    const b64 = rawBuf.toString('base64');
    /* 按魔数认格式，不能信扩展名：豆包导出的图常是 JPEG 数据却叫 .png。
       data: URI 的 mime 若与内容不符，部分浏览器会拒绝解码。 */
    const mime = (() => {
      const h = rawBuf.subarray(0, 12).toString('hex');
      if (h.startsWith('ffd8ff')) return 'image/jpeg';
      if (h.startsWith('89504e470d0a1a0a')) return 'image/png';
      if (h.startsWith('52494646') && rawBuf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
      if (h.startsWith('47494638')) return 'image/gif';
      return 'image/png';
    })();
    const expr = `(async () => {
      const img = new Image();
      img.src = 'data:${mime};base64,${b64}';
      await img.decode();
      const c = document.createElement('canvas');
      c.width = ${W}; c.height = ${H};
      const x = c.getContext('2d');
      x.imageSmoothingEnabled = true;
      x.imageSmoothingQuality = 'high';
      // 生成模型会在右下角强制叠加「AI生成」水印，源图底部裁掉 5% 可完整去除，
      // 且这一带只有地面/投影，不影响主体构图。
      const trim = Math.round(img.height * ${TRIM});
      const sh = img.height - trim;
      const s = Math.max(${W} / img.width, ${H} / sh);
      const w = img.width * s, h = sh * s;
      x.drawImage(img, 0, 0, img.width, sh, (${W} - w) / 2, (${H} - h) / 2, w, h);
      return c.toDataURL('image/webp', ${QUALITY});
    })()`;
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(job.id + ': ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    const url = r.result && r.result.value;
    if (!url || !url.startsWith('data:image/webp')) throw new Error(job.id + ': 浏览器未返回 webp');
    const outBuf = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
    const dest = path.join(OUT, job.id + '.webp');
    fs.writeFileSync(dest, outBuf);
    const ratio = ((1 - outBuf.length / rawBuf.length) * 100).toFixed(1);
    console.log(`${job.id.padEnd(20)} ${W}x${H}  ${(rawBuf.length / 1024).toFixed(0)}KB -> ${(outBuf.length / 1024).toFixed(0)}KB  (-${ratio}%)  src=${mime.replace('image/', '')} trim=${(TRIM * 100).toFixed(0)}%`);
  }
  ws.close();
  console.log(`\n=== 封面处理完成：${jobs.length} 张 WebP，输出 ${OUT} ===`);
} finally {
  if (edge) edge.kill();
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* noop */ }
}
