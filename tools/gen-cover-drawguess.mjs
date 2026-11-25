/* tools/gen-cover-drawguess.mjs —— 用浏览器 canvas 画「你画我猜」大厅封面
 *
 * 用法：node tools/gen-cover-drawguess.mjs
 *
 * 为什么自己画而不用 AI 生成：
 *   仓库的 build-covers.mjs 依赖 Windows 上的 Edge + ImageMagick 链路，在本机跑不了；
 *   封面只是大厅列表里的一张 1280×800 缩略图，canvas 画一张 Q 版图完全够用。
 *
 * 输出：covers/drawguess.png（1280×800）
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
  const bg = ctx.createRadialGradient(W * 0.5, H * 0.3, 40, W * 0.5, H * 0.55, W * 0.8);
  bg.addColorStop(0, '#1d4266');
  bg.addColorStop(0.55, '#132a44');
  bg.addColorStop(1, '#070d16');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  /* ---- 右侧：画板 ---- */
  const BX = 560, BY = 150, BW = 620, BH = 470;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.55)';
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 16;
  ctx.fillStyle = '#fdfdff';
  roundRect(ctx, BX, BY, BW, BH, 22);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = 'rgba(56,189,248,.55)';
  ctx.lineWidth = 3;
  roundRect(ctx, BX, BY, BW, BH, 22);
  ctx.stroke();

  /* 画板上的涂鸦：一只猫（几笔勾出来） */
  ctx.save();
  ctx.translate(BX + BW / 2, BY + BH / 2 - 20);
  ctx.strokeStyle = '#111827';
  ctx.lineWidth = 11;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  /* 身体 */
  ctx.beginPath();
  ctx.ellipse(0, 55, 95, 78, 0, 0, Math.PI * 2);
  ctx.stroke();
  /* 头 */
  ctx.beginPath();
  ctx.arc(0, -58, 62, 0, Math.PI * 2);
  ctx.stroke();
  /* 耳朵 */
  ctx.beginPath();
  ctx.moveTo(-52, -98); ctx.lineTo(-42, -136); ctx.lineTo(-14, -108);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(52, -98); ctx.lineTo(42, -136); ctx.lineTo(14, -108);
  ctx.stroke();
  /* 眼睛 */
  ctx.fillStyle = '#111827';
  ctx.beginPath(); ctx.arc(-22, -66, 8, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(22, -66, 8, 0, Math.PI * 2); ctx.fill();
  /* 鼻子与嘴 */
  ctx.beginPath();
  ctx.moveTo(-8, -44); ctx.lineTo(0, -36); ctx.lineTo(8, -44);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(-16, -26, 14, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(16, -26, 14, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();
  /* 胡须 */
  ctx.lineWidth = 5;
  [-1, 1].forEach((s) => {
    ctx.beginPath();
    ctx.moveTo(s * 28, -40); ctx.lineTo(s * 82, -50);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s * 28, -30); ctx.lineTo(s * 80, -26);
    ctx.stroke();
  });
  /* 尾巴 */
  ctx.lineWidth = 11;
  ctx.beginPath();
  ctx.moveTo(92, 90);
  ctx.bezierCurveTo(160, 96, 168, 20, 132, 6);
  ctx.stroke();
  ctx.restore();

  /* 画板上的调色盘 */
  const PAL = ['#111827', '#dc2626', '#2563eb', '#16a34a', '#f59e0b', '#a855f7'];
  PAL.forEach((c, i) => {
    ctx.beginPath();
    ctx.arc(BX + 52 + i * 40, BY + BH - 40, 15, 0, Math.PI * 2);
    ctx.fillStyle = c;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.18)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });
  /* 橡皮 */
  ctx.save();
  ctx.translate(BX + BW - 60, BY + BH - 40);
  ctx.rotate(-0.5);
  ctx.fillStyle = '#f8fafc';
  roundRect(ctx, -20, -12, 40, 24, 5);
  ctx.fill();
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#f472b6';
  ctx.fillRect(8, -12, 12, 24);
  ctx.restore();

  /* ---- 左侧标题区 ---- */
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  ctx.font = '700 96px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
  const grad = ctx.createLinearGradient(86, 0, 86, 110);
  grad.addColorStop(0, '#d9f2ff');
  grad.addColorStop(1, '#38bdf8');
  ctx.fillStyle = grad;
  ctx.fillText('你画我猜', 82, 320);

  ctx.font = '500 34px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
  ctx.fillStyle = 'rgba(56,189,248,.88)';
  ctx.fillText('一个人画，其余的人猜', 88, 376);

  const tags = ['人机对练', '同屏派对', '纯 P2P 联机'];
  ctx.font = '600 24px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
  let ty = 414;
  tags.forEach((t) => {
    const tw = ctx.measureText(t).width;
    ctx.beginPath();
    roundRect(ctx, 88, ty, tw + 34, 44, 22);
    ctx.fillStyle = 'rgba(56,189,248,.14)'; ctx.fill();
    ctx.strokeStyle = 'rgba(56,189,248,.45)'; ctx.lineWidth = 1.6; ctx.stroke();
    ctx.fillStyle = '#a9dcf5';
    ctx.fillText(t, 88 + 17, ty + 29);
    ty += 54;
  });

  ctx.font = '500 24px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
  ctx.fillStyle = 'rgba(188,211,232,.6)';
  ctx.fillText('联机不经过任何服务器 · 不花钱 · 不用改 IP', 88, 700);

  ctx.restore();

  /* ---- 顶部装饰光 ---- */
  const glow = ctx.createRadialGradient(W * 0.2, H * 0.16, 10, W * 0.2, H * 0.16, 320);
  glow.addColorStop(0, 'rgba(120,200,255,.16)');
  glow.addColorStop(1, 'rgba(120,200,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  return cv.toDataURL('image/png');
}, { W, H });

await browser.close();
server.close();

const outPath = path.join(ROOT, 'covers', 'drawguess.png');
const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
fs.writeFileSync(outPath, buf);
console.log('[gen-cover-drawguess] 已生成 covers/drawguess.png  ' + buf.length + ' B  ' + W + '×' + H);
