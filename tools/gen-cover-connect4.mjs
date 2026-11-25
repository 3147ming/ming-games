/* tools/gen-cover-connect4.mjs —— 用浏览器 canvas 画四子棋大厅封面
 *
 * 用法：node tools/gen-cover-connect4.mjs
 *
 * 为什么自己画而不用 AI 生成：
 *   仓库的 build-covers.mjs 依赖 Windows 上的 Edge + ImageMagick 链路，在本机跑不了；
 *   封面只是大厅列表里的一张 1280×800 缩略图，canvas 画一张 Q 版图完全够用。
 *
 * 输出：covers/connect4.png（1280×800）
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

  /* ---- 底：深蓝渐变 ---- */
  const bg = ctx.createRadialGradient(W * 0.5, H * 0.34, 40, W * 0.5, H * 0.5, W * 0.78);
  bg.addColorStop(0, '#1d3f66');
  bg.addColorStop(0.55, '#132741');
  bg.addColorStop(1, '#080f1a');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  /* ---- 竖盘：7 列 × 6 行，居中偏右 ---- */
  const COLS = 7, ROWS = 6;
  const boardW = 560, boardH = 500;
  const bx = W * 0.5 - boardW / 2 + 140;
  const by = H * 0.5 - boardH / 2 + 6;
  const cw = boardW / COLS, ch = boardH / ROWS;

  /* 盘面投影 */
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.55)';
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 16;
  ctx.fillStyle = '#1d4e89';
  roundRect(ctx, bx, by, boardW, boardH, 22);
  ctx.fill();
  ctx.restore();

  /* 盘面边框 */
  ctx.strokeStyle = '#12365f';
  ctx.lineWidth = 14;
  roundRect(ctx, bx + 7, by + 7, boardW - 14, boardH - 14, 18);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(120,170,230,.28)';
  ctx.lineWidth = 2;
  roundRect(ctx, bx + 18, by + 18, boardW - 36, boardH - 36, 12);
  ctx.stroke();

  /* 落子孔 */
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const cx = bx + cw * (c + 0.5), cy = by + ch * (r + 0.5);
      ctx.beginPath();
      ctx.arc(cx, cy, Math.min(cw, ch) * 0.42, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,.28)';
      ctx.fill();
    }
  }

  /* ---- 棋子：Q 版红/黄，带高光 ---- */
  function disc(cx, cy, r, color) {
    const g = ctx.createRadialGradient(cx - r * 0.34, cy - r * 0.42, r * 0.12, cx, cy, r);
    if (color === 'red') { g.addColorStop(0, '#ff8071'); g.addColorStop(0.6, '#e0483c'); g.addColorStop(1, '#a8281f'); }
    else { g.addColorStop(0, '#ffe489'); g.addColorStop(0.6, '#f5c542'); g.addColorStop(1, '#c2921a'); }
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(cx - r * 0.3, cy - r * 0.4, r * 0.26, r * 0.16, -0.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,.5)';
    ctx.fill();
  }

  const R = Math.min(cw, ch) * 0.40;
  const at = (c, r) => [bx + cw * (c + 0.5), by + ch * (r + 0.5)];

  /* 蓝（黄）棋：底行四连 3-6 列 + 上方一颗 */
  [[3, 5], [4, 5], [5, 5], [6, 5]].forEach(([c, r]) => disc(...at(c, r), R, 'gold'));
  /* 红棋：左侧两列堆叠 */
  [[0, 5], [1, 5], [0, 4], [1, 4], [2, 5]].forEach(([c, r]) => disc(...at(c, r), R, 'red'));
  /* 悬空的一颗（正在下落的感觉） */
  const [fx, fy] = at(5, 2);
  ctx.save();
  ctx.globalAlpha = 0.92;
  disc(fx, fy, R, 'gold');
  ctx.restore();

  /* 四连高亮线 */
  ctx.strokeStyle = 'rgba(255,255,255,.9)';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(...at(3, 5));
  ctx.lineTo(...at(6, 5));
  ctx.stroke();
  ctx.lineCap = 'butt';

  /* ---- 左侧标题区 ---- */
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  ctx.font = '700 108px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
  const grad = ctx.createLinearGradient(90, 0, 90, 120);
  grad.addColorStop(0, '#ffe9a8');
  grad.addColorStop(1, '#f5c542');
  ctx.fillStyle = grad;
  ctx.fillText('四子棋', 86, 330);

  ctx.font = '500 34px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
  ctx.fillStyle = 'rgba(245,197,66,.86)';
  ctx.fillText('重力落子 · 四连即胜', 92, 386);

  /* 三个小标签：竖排，避开右侧棋盘 */
  const tags = ['人机对弈', '同屏双人', '纯 P2P 联机'];
  ctx.font = '600 24px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
  let ty = 424;
  tags.forEach((t) => {
    const tw = ctx.measureText(t).width;
    ctx.beginPath();
    roundRect(ctx, 92, ty, tw + 34, 44, 22);
    ctx.fillStyle = 'rgba(245,197,66,.14)'; ctx.fill();
    ctx.strokeStyle = 'rgba(245,197,66,.45)'; ctx.lineWidth = 1.6; ctx.stroke();
    ctx.fillStyle = '#f0d68d';
    ctx.fillText(t, 92 + 17, ty + 29);
    ty += 54;
  });

  ctx.font = '500 24px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
  ctx.fillStyle = 'rgba(214,228,244,.6)';
  ctx.fillText('联机不经过任何服务器 · 不花钱 · 不用改 IP', 92, 700);

  ctx.restore();

  /* ---- 顶部装饰光 ---- */
  const glow = ctx.createRadialGradient(W * 0.22, H * 0.18, 10, W * 0.22, H * 0.18, 320);
  glow.addColorStop(0, 'rgba(140,200,255,.14)');
  glow.addColorStop(1, 'rgba(140,200,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  return cv.toDataURL('image/png');
}, { W, H });

await browser.close();
server.close();

const outPath = path.join(ROOT, 'covers', 'connect4.png');
const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
fs.writeFileSync(outPath, buf);
console.log('[gen-cover-connect4] 已生成 covers/connect4.png  ' + buf.length + ' B  ' + W + '×' + H);
