/* tools/gen-cover-gomoku.mjs —— 用浏览器 canvas 画五子棋大厅封面
 *
 * 用法：node tools/gen-cover-gomoku.mjs
 *
 * 为什么自己画而不用 AI 生成：
 *   仓库的 build-covers.mjs 依赖 Windows 上的 Edge + ImageMagick 链路，
 *   在本机跑不了；而封面只是大厅列表里的一张 1280×800 缩略图，
 *   用 canvas 画一张 Q 版棋盘图完全够用，也更符合「Q 版成品」的美术口径。
 *
 * 输出：covers/gomoku.png（1280×800）
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

/* ---- 起一个空页面（data: URI，不碰本地文件权限） ---- */
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

  /* 圆角矩形路径（Canvas2D 的 roundRect 兼容性不稳，自己画一个） */
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

  /* ---- 底：深棕木纹渐变 + 暖光 ---- */
  const bg = ctx.createRadialGradient(W * 0.5, H * 0.34, 40, W * 0.5, H * 0.5, W * 0.78);
  bg.addColorStop(0, '#3b2c1d');
  bg.addColorStop(0.55, '#241a11');
  bg.addColorStop(1, '#120d09');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  /* ---- 棋盘：暖木色圆角方块，居中偏右 ---- */
  const boardSize = 540;
  const bx = W * 0.5 - boardSize / 2 + 130;
  const by = H * 0.5 - boardSize / 2 + 6;

  ctx.save();
  /* 棋盘投影 */
  ctx.shadowColor = 'rgba(0,0,0,.55)';
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 16;
  ctx.fillStyle = '#e9dcbe';
  roundRect(ctx, bx, by, boardSize, boardSize, 22);
  ctx.fill();
  ctx.restore();

  /* 棋盘边框（木框） */
  ctx.strokeStyle = '#7a5a30';
  ctx.lineWidth = 14;
  roundRect(ctx, bx + 7, by + 7, boardSize - 14, boardSize - 14, 18);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(120,90,50,.45)';
  ctx.lineWidth = 2;
  roundRect(ctx, bx + 18, by + 18, boardSize - 36, boardSize - 36, 12);
  ctx.stroke();

  /* ---- 网格 ---- */
  const N = 11;
  const pad = 46;
  const span = boardSize - pad * 2;
  const step = span / (N - 1);
  ctx.strokeStyle = 'rgba(70,52,28,.5)';
  ctx.lineWidth = 1.6;
  for (let i = 0; i < N; i++) {
    const p = bx + pad + i * step;
    ctx.beginPath(); ctx.moveTo(bx + pad, p); ctx.lineTo(bx + pad + span, p); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(p, by + pad); ctx.lineTo(p, by + pad + span); ctx.stroke();
  }
  /* 星位 */
  ctx.fillStyle = 'rgba(70,52,28,.7)';
  for (const [gx, gy] of [[2, 2], [8, 2], [2, 8], [8, 8], [5, 5]]) {
    ctx.beginPath();
    ctx.arc(bx + pad + gx * step, by + pad + gy * step, 5.5, 0, Math.PI * 2);
    ctx.fill();
  }

  /* ---- 棋子：Q 版黑白子，带高光与表情感 ---- */
  function stone(cx, cy, r, dark) {
    const g = ctx.createRadialGradient(cx - r * 0.34, cy - r * 0.42, r * 0.12, cx, cy, r);
    if (dark) { g.addColorStop(0, '#6e675d'); g.addColorStop(0.55, '#2a2622'); g.addColorStop(1, '#100e0c'); }
    else { g.addColorStop(0, '#fffdf6'); g.addColorStop(0.6, '#efe6d2'); g.addColorStop(1, '#cfc0a3'); }
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = dark ? 'rgba(0,0,0,.5)' : 'rgba(120,100,70,.45)';
    ctx.lineWidth = 2; ctx.stroke();
    /* 高光 */
    ctx.beginPath();
    ctx.ellipse(cx - r * 0.32, cy - r * 0.42, r * 0.26, r * 0.17, -0.5, 0, Math.PI * 2);
    ctx.fillStyle = dark ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.85)';
    ctx.fill();
  }

  /* 白棋五连（斜线） */
  const whiteLine = [[2, 4], [3, 5], [4, 6], [5, 7], [6, 8]];
  whiteLine.forEach(([gx, gy]) => stone(bx + pad + gx * step, by + pad + gy * step, 22, false));

  /* 黑棋散布 */
  [[1, 1], [2, 2], [4, 3], [6, 2], [8, 4], [3, 8], [7, 8]].forEach(([gx, gy]) => {
    stone(bx + pad + gx * step, by + pad + gy * step, 22, true);
  });

  /* 最后一手：金色圈 */
  const [lx, ly] = whiteLine[whiteLine.length - 1];
  ctx.beginPath();
  ctx.arc(bx + pad + lx * step, by + pad + ly * step, 30, 0, Math.PI * 2);
  ctx.strokeStyle = '#d9a441'; ctx.lineWidth = 4; ctx.stroke();

  /* ---- 左侧标题区 ---- */
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  /* 标题「五子棋」 */
  ctx.font = '700 108px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
  const grad = ctx.createLinearGradient(90, 0, 90, 120);
  grad.addColorStop(0, '#f6e2b4');
  grad.addColorStop(1, '#c8a96b');
  ctx.fillStyle = grad;
  ctx.fillText('五子棋', 86, 330);

  /* 副标题 */
  ctx.font = '500 34px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
  ctx.fillStyle = 'rgba(232,201,138,.86)';
  ctx.fillText('五子连珠 · 一线定胜负', 92, 386);

  /* 三个小标签：竖排，避开右侧棋盘 */
  const tags = ['人机对弈', '同屏双人', '纯 P2P 联机'];
  ctx.font = '600 24px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
  let ty = 424;
  tags.forEach((t) => {
    const tw = ctx.measureText(t).width;
    ctx.beginPath();
    roundRect(ctx, 92, ty, tw + 34, 44, 22);
    ctx.fillStyle = 'rgba(200,169,107,.14)'; ctx.fill();
    ctx.strokeStyle = 'rgba(200,169,107,.45)'; ctx.lineWidth = 1.6; ctx.stroke();
    ctx.fillStyle = '#e6cf9d';
    ctx.fillText(t, 92 + 17, ty + 29);
    ty += 54;
  });

  /* 底部一行小字：零服务器 */
  ctx.font = '500 24px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
  ctx.fillStyle = 'rgba(226,214,190,.6)';
  ctx.fillText('联机不经过任何服务器 · 不花钱 · 不用改 IP', 92, 700);

  ctx.restore();

  /* ---- 顶部装饰光 ---- */
  const glow = ctx.createRadialGradient(W * 0.22, H * 0.18, 10, W * 0.22, H * 0.18, 320);
  glow.addColorStop(0, 'rgba(255,214,140,.13)');
  glow.addColorStop(1, 'rgba(255,214,140,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  return cv.toDataURL('image/png');
}, { W, H });

await browser.close();
server.close();

const outPath = path.join(ROOT, 'covers', 'gomoku.png');
const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
fs.writeFileSync(outPath, buf);
console.log('[gen-cover-gomoku] 已生成 covers/gomoku.png  ' + buf.length + ' B  ' + W + '×' + H);
