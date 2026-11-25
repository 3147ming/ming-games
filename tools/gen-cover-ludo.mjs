/* tools/gen-cover-ludo.mjs —— 用浏览器 canvas 画「飞行棋」大厅封面
 *
 * 用法：node tools/gen-cover-ludo.mjs
 *
 * 为什么自己画而不用 AI 生成：
 *   仓库的 build-covers.mjs 依赖 Windows 上的 Edge + ImageMagick 链路，在本机跑不了；
 *   封面只是大厅列表里的一张 1280×800 缩略图，canvas 画一张 Q 版图完全够用。
 *
 * 输出：covers/ludo.png（1280×800）
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

  function roundRect(c, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + rr, y);
    c.arcTo(x + w, y, x + w, y + h, rr);
    c.arcTo(x + w, y + h, x, y + h, rr);
    c.arcTo(x, y + h, x, y, rr);
    c.arcTo(x, y, x + w, y, rr);
    c.closePath();
  }

  /* ---- 底：暖米色渐变 ---- */
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#fdf8ec');
  bg.addColorStop(0.55, '#f2e8d2');
  bg.addColorStop(1, '#e2d3b4');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  /* ---- 淡淡的棋纸格纹 ---- */
  ctx.strokeStyle = 'rgba(150,120,70,.07)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y <= H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  /* ---- 左侧：标题 ---- */
  ctx.fillStyle = '#c8912f';
  ctx.fillRect(72, 168, 74, 8);
  ctx.fillStyle = '#2a2118';
  ctx.font = 'bold 92px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('飞行棋', 72, 285);

  ctx.fillStyle = '#7a6b58';
  ctx.font = '27px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillText('4 人 4 色 16 颗棋子', 72, 348);
  ctx.fillText('掷 6 起飞 · 飞跃点 · 撞机 · 终点通道', 72, 392);

  /* 小标签 */
  const tags = [
    { t: '经典玩法', bg: '#e0483c' },
    { t: '人机对局', bg: '#f5c542' },
    { t: '零服务器联机', bg: '#3fb96b' },
  ];
  let tx = 72;
  ctx.font = '22px "PingFang SC","Microsoft YaHei",sans-serif';
  for (const tag of tags) {
    const tw = ctx.measureText(tag.t).width + 34;
    ctx.fillStyle = tag.bg;
    roundRect(ctx, tx, 432, tw, 44, 22);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(tag.t, tx + tw / 2, 456);
    tx += tw + 14;
  }

  /* ---- 右侧：迷你棋盘 ---- */
  const BX = 700, BY = 70, CELL = 36, N = 15;
  const S = CELL * N;
  ctx.save();
  ctx.translate(BX, BY);

  /* 棋盘底 */
  ctx.fillStyle = '#fffaf0';
  roundRect(ctx, -14, -14, S + 28, S + 28, 18);
  ctx.fill();
  ctx.strokeStyle = '#d8cdb8';
  ctx.lineWidth = 2;
  ctx.stroke();

  const ring = [];
  for (let x = 1; x <= 14; x++) ring.push([x, 14]);
  for (let y = 13; y >= 1; y--) ring.push([14, y]);
  for (let x = 13; x >= 1; x--) ring.push([x, 1]);
  for (let y = 2; y <= 13; y++) ring.push([1, y]);

  const COL = ['#e0483c', '#f5c542', '#3d8bd8', '#3fb96b'];
  const MOUTH = [6, 20, 33, 46];
  const START = MOUTH.map((i) => (i + 1) % 52);
  const JUMP = [3, 16, 29, 42];

  function lighten(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    r = Math.round(r + (255 - r) * amt);
    g = Math.round(g + (255 - g) * amt);
    b = Math.round(b + (255 - b) * amt);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  /* 外圈 */
  for (let i = 0; i < ring.length; i++) {
    const c = ring[i];
    const x = c[0] * CELL + 2, y = c[1] * CELL + 2;
    let owner = -1;
    for (let ci = 0; ci < 4; ci++) {
      const steps = (i - START[ci] + 52) % 52;
      if (steps < 13) { owner = ci; break; }
    }
    const isJump = JUMP.indexOf(i) >= 0;
    ctx.fillStyle = isJump ? '#b9e3c8' : (owner >= 0 ? lighten(COL[owner], 0.76) : '#efe7d6');
    roundRect(ctx, x, y, CELL - 4, CELL - 4, 5);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.06)';
    ctx.lineWidth = 1;
    ctx.stroke();

    if (isJump) {
      ctx.fillStyle = '#2f8f5b';
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('飞', c[0] * CELL + CELL / 2, c[1] * CELL + CELL / 2);
    }
    const si = START.indexOf(i);
    if (si >= 0) {
      ctx.fillStyle = COL[si];
      ctx.beginPath();
      ctx.arc(c[0] * CELL + CELL / 2, c[1] * CELL + CELL / 2, CELL / 2 - 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(si + 1), c[0] * CELL + CELL / 2, c[1] * CELL + CELL / 2);
    }
  }

  /* 终点通道 */
  const LANES = [
    [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9], [7, 8]],
    [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7], [8, 7]],
    [[7, 2], [7, 3], [7, 4], [7, 5], [7, 6], [7, 7]],
    [[2, 8], [3, 8], [4, 8], [5, 8], [6, 8], [6, 7]],
  ];
  for (let ci = 0; ci < 4; ci++) {
    LANES[ci].forEach((c, k) => {
      const x = c[0] * CELL + 2, y = c[1] * CELL + 2;
      ctx.fillStyle = k === 5 ? COL[ci] : lighten(COL[ci], 0.55);
      roundRect(ctx, x, y, CELL - 4, CELL - 4, 5);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.07)';
      ctx.stroke();
      if (k === 5) {
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('终', c[0] * CELL + CELL / 2, c[1] * CELL + CELL / 2);
      }
    });
  }

  /* 棋子：放在外圈真实格子上，每色几颗错开一点 */
  const planeAt = [
    { ci: 0, ring: 11, n: 3 },
    { ci: 1, ring: 25, n: 2 },
    { ci: 2, ring: 37, n: 3 },
    { ci: 3, ring: 49, n: 2 },
  ];
  for (const pp of planeAt) {
    const c = ring[pp.ring];
    for (let k = 0; k < pp.n; k++) {
      const ox = c[0] * CELL + CELL / 2 + (k % 2 ? 8 : -8);
      const oy = c[1] * CELL + CELL / 2 + (k > 1 ? 7 : -4);
      ctx.beginPath();
      ctx.arc(ox, oy, 9.5, 0, Math.PI * 2);
      ctx.fillStyle = COL[pp.ci];
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  ctx.restore();   /* 退出棋盘坐标系 —— 下面的大骰子要用画布绝对坐标 */

  /* ---- 一个大骰子 ---- */
  const DX = 1128, DY = 700, DS = 132;
  ctx.save();
  ctx.translate(DX, DY);
  ctx.rotate(-0.16);
  ctx.fillStyle = 'rgba(0,0,0,.14)';
  roundRect(ctx, -DS / 2 + 8, -DS / 2 + 12, DS, DS, 22);
  ctx.fill();
  ctx.fillStyle = '#fff';
  roundRect(ctx, -DS / 2, -DS / 2, DS, DS, 22);
  ctx.fill();
  ctx.strokeStyle = '#2a2118';
  ctx.lineWidth = 5;
  ctx.stroke();
  /* 5 点 */
  ctx.fillStyle = '#c8281d';
  const pips = [[-26, -26], [26, -26], [0, 0], [-26, 26], [26, 26]];
  for (const p of pips) {
    ctx.beginPath();
    ctx.arc(p[0], p[1], 11, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  return cv.toDataURL('image/png');
}, { W, H });

const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
const outPath = path.join(ROOT, 'covers', 'ludo.png');
fs.writeFileSync(outPath, buf);
console.log('[gen-cover-ludo] 已生成 covers/ludo.png  ' + buf.length + ' B  ' + W + '×' + H);

await browser.close();
server.close();
