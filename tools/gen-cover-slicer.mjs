/* tools/gen-cover-slicer.mjs —— 用浏览器 canvas 画「切片大师」大厅封面
 *
 * 用法：node tools/gen-cover-slicer.mjs
 *
 * 为什么自己画而不用 AI 生成：
 *   仓库的 build-covers.mjs 依赖 Windows 上的 Edge + ImageMagick 链路，在本机跑不了；
 *   封面只是大厅列表里的一张 1280×800 缩略图，canvas 画一张 Q 版图完全够用。
 *
 * 输出：covers/slicer.png（1280×800）
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

  /* ---- 底：暖米色渐变（跟 ludo 同一套羊皮纸色调） ---- */
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
  ctx.fillText('切片大师', 72, 285);

  ctx.fillStyle = '#7a6b58';
  ctx.font = '27px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillText('一笔划过 · 连击加倍 · 60 秒决胜', 72, 348);
  ctx.fillText('避开炸弹 · 冰冻减速 · 磁铁吸附', 72, 392);

  /* 小标签 */
  const tags = [
    { t: '切水果', bg: '#e0483c' },
    { t: '连击倍率', bg: '#f5c542' },
    { t: '每日一局', bg: '#3d8bd8' },
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

  /* ---- 右侧：游戏画面示意（浅色木质砧板 + 水果） ---- */
  const PX = 690, PY = 96, PW = 520, PH = 610;
  ctx.save();
  ctx.translate(PX, PY);

  /* 砧板 */
  ctx.fillStyle = 'rgba(0,0,0,.12)';
  roundRect(ctx, 8, 14, PW, PH, 26);
  ctx.fill();
  const wood = ctx.createLinearGradient(0, 0, PW, PH);
  wood.addColorStop(0, '#fdf3e0');
  wood.addColorStop(0.5, '#f6e7c9');
  wood.addColorStop(1, '#ecdcb8');
  ctx.fillStyle = wood;
  roundRect(ctx, 0, 0, PW, PH, 26);
  ctx.fill();
  ctx.strokeStyle = '#d3c09a';
  ctx.lineWidth = 3;
  ctx.stroke();
  /* 木纹 */
  ctx.strokeStyle = 'rgba(160,125,70,.10)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 7; i++) {
    ctx.beginPath();
    const y = 60 + i * 78;
    ctx.moveTo(18, y);
    ctx.bezierCurveTo(160, y - 12, 340, y + 12, PW - 18, y);
    ctx.stroke();
  }

  /* 水果绘制函数（在砧板局部坐标里） */
  function watermelon(x, y, r, rot) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot || 0);
    /* 果肉 */
    ctx.fillStyle = '#e8544b';
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    /* 白边 */
    ctx.strokeStyle = '#f7f2e4';
    ctx.lineWidth = r * 0.16;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.92, 0, Math.PI * 2);
    ctx.stroke();
    /* 籽：三排散布 */
    ctx.fillStyle = '#3a2418';
    const seeds = [
      [-0.46, -0.16], [-0.16, -0.44], [0.16, -0.40],
      [0.46, -0.12], [-0.30, 0.26], [0.06, 0.04], [0.42, 0.28],
    ];
    for (const sd of seeds) {
      ctx.beginPath();
      ctx.ellipse(sd[0] * r, sd[1] * r, r * 0.065, r * 0.095, sd[0] * 0.6, 0, Math.PI * 2);
      ctx.fill();
    }
    /* 瓜皮 */
    ctx.strokeStyle = '#4e9b48';
    ctx.lineWidth = r * 0.13;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.99, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function strawberry(x, y, r, rot) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot || 0);
    ctx.fillStyle = '#df3b52';
    ctx.beginPath();
    ctx.moveTo(0, r);
    ctx.bezierCurveTo(-r * 1.05, r * 0.15, -r * 0.95, -r * 0.95, 0, -r * 0.8);
    ctx.bezierCurveTo(r * 0.95, -r * 0.95, r * 1.05, r * 0.15, 0, r);
    ctx.fill();
    ctx.fillStyle = '#fff6e8';
    for (let i = 0; i < 7; i++) {
      const px = ((i % 3) - 1) * r * 0.46;
      const py = -r * 0.45 + Math.floor(i / 3) * r * 0.42;
      ctx.beginPath();
      ctx.ellipse(px, py, r * 0.075, r * 0.11, 0.3, 0, Math.PI * 2);
      ctx.fill();
    }
    /* 叶 */
    ctx.fillStyle = '#4e9b48';
    for (let i = -2; i <= 2; i++) {
      ctx.save();
      ctx.rotate(i * 0.32);
      ctx.beginPath();
      ctx.ellipse(0, -r * 0.88, r * 0.16, r * 0.42, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  function orange(x, y, r) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = '#f7931e';
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.22)';
    for (let i = 0; i < 7; i++) {
      const a = i / 7 * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, r, a, a + 0.24);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = '#4e9b48';
    ctx.beginPath();
    ctx.ellipse(r * 0.28, -r * 0.82, r * 0.34, r * 0.16, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function apple(x, y, r) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = '#e0393b';
    ctx.beginPath();
    ctx.arc(-r * 0.42, 0, r * 0.62, 0, Math.PI * 2);
    ctx.arc(r * 0.42, 0, r * 0.62, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#5b3a22';
    ctx.fillRect(-r * 0.07, -r * 1.02, r * 0.14, r * 0.34);
    ctx.fillStyle = '#4e9b48';
    ctx.beginPath();
    ctx.ellipse(r * 0.34, -r * 0.92, r * 0.32, r * 0.16, -0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function bomb(x, y, r) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = 'rgba(0,0,0,.15)';
    ctx.beginPath();
    ctx.ellipse(4, r * 0.9, r * 0.95, r * 0.28, 0, 0, Math.PI * 2);
    ctx.fill();
    const g = ctx.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.1, 0, 0, r);
    g.addColorStop(0, '#5c6474');
    g.addColorStop(1, '#252a36');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#8a6a3a';
    ctx.lineWidth = r * 0.16;
    ctx.beginPath();
    ctx.moveTo(r * 0.4, -r * 0.85);
    ctx.quadraticCurveTo(r * 0.95, -r * 1.3, r * 0.72, -r * 1.55);
    ctx.stroke();
    /* 火花 */
    ctx.fillStyle = '#f5c542';
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * Math.PI * 2;
      const rr = i % 2 ? r * 0.16 : r * 0.42;
      ctx.lineTo(r * 0.72 + Math.cos(a) * rr, -r * 1.55 + Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function iceEgg(x, y, r) {
    ctx.save();
    ctx.translate(x, y);
    const g = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r);
    g.addColorStop(0, '#bdeeff');
    g.addColorStop(1, '#48b8e8');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.9, r * 1.06, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.75)';
    ctx.lineWidth = r * 0.12;
    ctx.beginPath();
    ctx.moveTo(-r * 0.3, -r * 0.6);
    ctx.lineTo(-r * 0.05, -r * 0.05);
    ctx.lineTo(-r * 0.3, r * 0.55);
    ctx.moveTo(r * 0.3, -r * 0.6);
    ctx.lineTo(r * 0.05, -r * 0.05);
    ctx.lineTo(r * 0.3, r * 0.55);
    ctx.stroke();
    ctx.restore();
  }

  function star(x, y, r) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = '#f4c542';
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 5;
      const rr = i % 2 ? r * 0.44 : r;
      ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#d3a326';
    ctx.lineWidth = r * 0.12;
    ctx.stroke();
    ctx.restore();
  }

  /* 砧板上的果实 */
  watermelon(122, 132, 68, 0.1);
  orange(268, 92, 42);
  strawberry(452, 258, 40, 0.3);
  apple(148, 306, 46);
  iceEgg(420, 392, 40);
  star(206, 452, 42);
  bomb(346, 512, 42);
  orange(90, 496, 36);

  /* ---- 刀光：一道划过全场的亮痕（画在最上层） ---- */
  const blade = ctx.createLinearGradient(20, 560, PW - 20, 150);
  blade.addColorStop(0, 'rgba(255,255,255,0)');
  blade.addColorStop(0.42, 'rgba(255,255,255,.85)');
  blade.addColorStop(0.55, 'rgba(255,240,190,.95)');
  blade.addColorStop(0.72, 'rgba(255,255,255,0)');
  ctx.strokeStyle = blade;
  ctx.lineWidth = 16;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(24, 560);
  ctx.quadraticCurveTo(250, 380, PW - 26, 148);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,.95)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(24, 560);
  ctx.quadraticCurveTo(250, 380, PW - 26, 148);
  ctx.stroke();

  /* 刀光两端的小火花 */
  ctx.fillStyle = '#f5c542';
  for (const p of [[24, 560], [PW - 26, 148]]) {
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * Math.PI * 2;
      const rr = i % 2 ? 4 : 13;
      ctx.lineTo(p[0] + Math.cos(a) * rr, p[1] + Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fill();
  }

  /* ---- 右上角：连击徽标 ---- */
  ctx.save();
  ctx.translate(PW - 96, 62);
  ctx.rotate(-0.14);
  ctx.fillStyle = 'rgba(0,0,0,.10)';
  roundRect(ctx, -80, -28, 160, 62, 31);
  ctx.fill();
  ctx.fillStyle = '#e0483c';
  roundRect(ctx, -84, -34, 168, 68, 34);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 32px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('连击 ×2', 0, 2);
  ctx.restore();

  ctx.restore();   /* 退出砧板坐标系 */

  return cv.toDataURL('image/png');
}, { W, H });

const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
const outPath = path.join(ROOT, 'covers', 'slicer.png');
fs.writeFileSync(outPath, buf);
console.log('[gen-cover-slicer] 已生成 covers/slicer.png  ' + buf.length + ' B  ' + W + '×' + H);

await browser.close();
server.close();
