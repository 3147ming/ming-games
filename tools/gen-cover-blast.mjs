/* tools/gen-cover-blast.mjs —— 用浏览器 canvas 画「方块爆破」大厅封面
 * 用法：node tools/gen-cover-blast.mjs
 * 输出：covers/blast.png（1280×800）
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/root/.nvm/versions/node/v22.13.1/lib/node_modules/playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const W = 1280, H = 800;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8"><body style="margin:0"></body>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });

await page.setContent(`<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden}</style>
<canvas id="c" width="${W}" height="${H}"></canvas>`);

const dataUrl = await page.evaluate(({ W, H }) => {
  const cv = document.getElementById('c');
  const ctx = cv.getContext('2d');

  function rr(c, x, y, w, h, r) {
    const k = Math.min(r, w / 2, h / 2);
    c.beginPath(); c.moveTo(x + k, y);
    c.arcTo(x + w, y, x + w, y + h, k); c.arcTo(x + w, y + h, x, y + h, k);
    c.arcTo(x, y + h, x, y, k); c.arcTo(x, y, x + w, y, k); c.closePath();
  }

  /* 底：暖米色渐变 */
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#fdf8ec'); bg.addColorStop(0.55, '#f2e8d2'); bg.addColorStop(1, '#e2d3b4');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

  /* 淡格纹 */
  ctx.strokeStyle = 'rgba(150,120,70,.07)'; ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y <= H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  /* 左侧标题 */
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#c8912f'; ctx.fillRect(72, 168, 74, 8);
  ctx.fillStyle = '#2a2118'; ctx.font = 'bold 88px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillText('方块爆破', 72, 282);
  ctx.fillStyle = '#7a6b58'; ctx.font = '27px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillText('点一格 · 炸开一片 · 连锁翻倍', 72, 342);
  ctx.fillText('落下同色自动消除，越连分越高', 72, 386);

  const tags = [
    { t: '连锁消除', bg: '#e0483c' },
    { t: '支持撤销', bg: '#3d8bd8' },
    { t: '零服务器联机', bg: '#3fb96b' },
  ];
  let tx = 72; ctx.font = '22px "PingFang SC","Microsoft YaHei",sans-serif';
  for (const tag of tags) {
    const tw = ctx.measureText(tag.t).width + 34;
    ctx.fillStyle = tag.bg; rr(ctx, tx, 426, tw, 44, 22); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(tag.t, tx + tw / 2, 450); tx += tw + 14;
  }

  /* 右侧：棋盘特写 */
  const BX = 700, BY = 100, CELL = 54, COLS = 8, ROWS = 8;
  const S = CELL * COLS;
  ctx.save(); ctx.translate(BX, BY);

  /* 棋盘底 */
  ctx.fillStyle = '#fffaf0'; rr(ctx, -12, -12, S + 24, S + 24, 14); ctx.fill();
  ctx.strokeStyle = '#d8cdb8'; ctx.lineWidth = 2; ctx.stroke();

  const PALETTE = ['#e0483c', '#f5c542', '#3d8bd8', '#3fb96b', '#9b5de5'];
  /* 手工排一个「静止无同色相邻」的盘面 */
  const grid = [
    [0,0,0,0,0,0,0,0],
    [0,0,2,0,0,0,0,0],
    [0,0,0,0,0,0,0,0],
    [0,3,0,0,0,4,0,0],
    [0,0,0,3,0,0,0,0],
    [1,0,4,0,2,0,5,0],
    [0,3,0,1,0,4,0,2],
    [2,0,5,0,3,0,1,0],
  ];
  /* 格底 */
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    ctx.fillStyle = '#f7f2e6'; rr(ctx, x * CELL + 2, y * CELL + 2, CELL - 4, CELL - 4, 7); ctx.fill();
  }
  /* 方块 */
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    const v = grid[y][x]; if (!v) continue;
    ctx.fillStyle = PALETTE[v - 1];
    rr(ctx, x * CELL + 3, y * CELL + 3, CELL - 6, CELL - 6, 8); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.35)';
    rr(ctx, x * CELL + 7, y * CELL + 6, CELL - 14, 7, 3); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,.14)';
    rr(ctx, x * CELL + 7, y * CELL + CELL - 10, CELL - 14, 4, 2); ctx.fill();
  }

  /* 爆炸特效：中心在 (3,5)，画一圈放射线 */
  const cx = 3 * CELL + CELL / 2, cy = 5 * CELL + CELL / 2;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const r0 = 26, r1 = 58 + (i % 3) * 14;
    ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    ctx.stroke();
  }
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.arc(cx, cy, 30, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();

  ctx.restore();   /* 退出棋盘坐标系 */

  /* 连锁倍率徽章：左下角 */
  ctx.save();
  ctx.translate(760, 700);
  ctx.rotate(-0.1);
  const badges = [
    { t: '×1', bg: '#e0483c' }, { t: '×2', bg: '#f5c542' },
    { t: '×3', bg: '#3d8bd8' }, { t: '×4', bg: '#3fb96b' },
  ];
  badges.forEach((b, i) => {
    const x = i * 108;
    ctx.fillStyle = b.bg; rr(ctx, x, 0, 88, 62, 12); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = 'bold 32px "PingFang SC",sans-serif'; ctx.fillText(b.t, x + 44, 31);
  });
  ctx.restore();

  return cv.toDataURL('image/png');
}, { W, H });

const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
const outPath = path.join(ROOT, 'covers', 'blast.png');
fs.writeFileSync(outPath, buf);
console.log('[gen-cover-blast] 已生成 covers/blast.png  ' + buf.length + ' B  ' + W + '×' + H);
await browser.close();
server.close();
