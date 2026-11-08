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
const CDP_PORT = 9334;
const PROFILE = path.join(os.tmpdir(), 'mg-covers-cdp-' + Date.now());
const IDS = ['future-light', 'warehouse-strike', 'lab-sandbox', 'enlisten'];

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
  const files = fs.readdirSync(RAW).filter((f) => /\.png$/i.test(f)).sort();
  if (files.length !== IDS.length) {
    console.error(`[covers] 期望 ${IDS.length} 张原图，实际 ${files.length} 张：${files.join(', ')}`);
    process.exit(2);
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

  for (let i = 0; i < files.length; i++) {
    const src = path.join(RAW, files[i]);
    const rawBuf = fs.readFileSync(src);
    const b64 = rawBuf.toString('base64');
    const expr = `(async () => {
      const img = new Image();
      img.src = 'data:image/png;base64,${b64}';
      await img.decode();
      const c = document.createElement('canvas');
      c.width = ${W}; c.height = ${H};
      const x = c.getContext('2d');
      x.imageSmoothingEnabled = true;
      x.imageSmoothingQuality = 'high';
      // 生成模型会在右下角强制叠加「AI生成」水印，源图底部裁掉 5% 可完整去除，
      // 且这一带只有地面/投影，不影响主体构图。
      const trim = Math.round(img.height * 0.05);
      const sh = img.height - trim;
      const s = Math.max(${W} / img.width, ${H} / sh);
      const w = img.width * s, h = sh * s;
      x.drawImage(img, 0, 0, img.width, sh, (${W} - w) / 2, (${H} - h) / 2, w, h);
      return c.toDataURL('image/webp', ${QUALITY});
    })()`;
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(IDS[i] + ': ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    const url = r.result && r.result.value;
    if (!url || !url.startsWith('data:image/webp')) throw new Error(IDS[i] + ': 浏览器未返回 webp');
    const outBuf = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
    const dest = path.join(OUT, IDS[i] + '.webp');
    fs.writeFileSync(dest, outBuf);
    const ratio = ((1 - outBuf.length / rawBuf.length) * 100).toFixed(1);
    console.log(`${IDS[i].padEnd(20)} ${W}x${H}  ${(rawBuf.length / 1024).toFixed(0)}KB -> ${(outBuf.length / 1024).toFixed(0)}KB  (-${ratio}%)`);
  }
  ws.close();
  console.log(`\n=== 封面处理完成：${files.length} 张 WebP，输出 ${OUT} ===`);
} finally {
  if (edge) edge.kill();
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* noop */ }
}
