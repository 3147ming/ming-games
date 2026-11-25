/* tools/gen-cover-fishing.mjs —— 用浏览器 canvas 画「小铺垂钓」大厅封面
 *
 * 用法：node tools/gen-cover-fishing.mjs
 *
 * 为什么自己画而不用 AI 生成：
 *   仓库的 build-covers.mjs 依赖 Windows 上的 Edge + ImageMagick 链路，在本机跑不了；
 *   封面只是大厅列表里的一张 1280×800 缩略图，canvas 画一张 Q 版图完全够用。
 *
 * 输出：covers/fishing.png（1280×800）
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
  bg.addColorStop(0.55, '#f3e9d3');
  bg.addColorStop(1, '#e4d5b7');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  /* ---- 淡淡的纸纹 ---- */
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
  ctx.fillText('小铺垂钓', 72, 285);

  ctx.fillStyle = '#7a6b58';
  ctx.font = '27px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillText('湖边小铺 · 抛竿等咬钩', 72, 348);
  ctx.fillText('踩准完美区 · 稀有鱼 · 每日一钓', 72, 392);

  /* 小标签 */
  const tags = [
    { t: '反应窗口', bg: '#d0483a' },
    { t: '每日一钓', bg: '#3f7f93' },
    { t: '零服务器联机', bg: '#3f8f5f' },
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

  /* ---- 右侧：湖边小景 ---- */
  const PX = 640, PY = 58, PW = 576, PH = 516;
  ctx.save();
  ctx.beginPath();
  roundRect(ctx, PX, PY, PW, PH, 22);
  ctx.clip();

  const HOR = PY + PH * 0.42;
  /* 天空 */
  const sky = ctx.createLinearGradient(0, PY, 0, HOR);
  sky.addColorStop(0, '#fdf2d8');
  sky.addColorStop(0.55, '#f7dcaa');
  sky.addColorStop(1, '#eec194');
  ctx.fillStyle = sky;
  ctx.fillRect(PX, PY, PW, HOR - PY);

  /* 落日 */
  const sunX = PX + PW * 0.72, sunY = HOR - 52;
  const glow = ctx.createRadialGradient(sunX, sunY, 10, sunX, sunY, 130);
  glow.addColorStop(0, 'rgba(255,246,214,.95)');
  glow.addColorStop(0.35, 'rgba(255,224,166,.45)');
  glow.addColorStop(1, 'rgba(255,224,166,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(sunX - 150, sunY - 150, 300, 300);
  ctx.fillStyle = '#fff6d8';
  ctx.beginPath();
  ctx.arc(sunX, sunY, 32, 0, Math.PI * 2);
  ctx.fill();

  /* 远山 */
  ctx.fillStyle = '#d8c39c';
  ctx.beginPath();
  ctx.moveTo(PX, HOR);
  ctx.quadraticCurveTo(PX + PW * 0.18, HOR - 62, PX + PW * 0.36, HOR - 12);
  ctx.quadraticCurveTo(PX + PW * 0.54, HOR - 48, PX + PW * 0.7, HOR - 6);
  ctx.quadraticCurveTo(PX + PW * 0.86, HOR - 42, PX + PW, HOR - 14);
  ctx.lineTo(PX + PW, HOR);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#bda884';
  ctx.beginPath();
  ctx.moveTo(PX, HOR);
  ctx.quadraticCurveTo(PX + PW * 0.14, HOR - 32, PX + PW * 0.3, HOR - 4);
  ctx.quadraticCurveTo(PX + PW * 0.48, HOR - 26, PX + PW * 0.64, HOR - 2);
  ctx.quadraticCurveTo(PX + PW * 0.84, HOR - 24, PX + PW, HOR - 6);
  ctx.lineTo(PX + PW, HOR);
  ctx.closePath();
  ctx.fill();

  /* 湖面 */
  const lake = ctx.createLinearGradient(0, HOR, 0, PY + PH);
  lake.addColorStop(0, '#8ec0c6');
  lake.addColorStop(0.45, '#5d95a4');
  lake.addColorStop(1, '#2f6274');
  ctx.fillStyle = lake;
  ctx.fillRect(PX, HOR, PW, PY + PH - HOR);

  /* 阳光倒影 */
  const refl = ctx.createLinearGradient(sunX - 120, 0, sunX + 120, 0);
  refl.addColorStop(0, 'rgba(255,243,205,0)');
  refl.addColorStop(0.5, 'rgba(255,243,205,.24)');
  refl.addColorStop(1, 'rgba(255,243,205,0)');
  ctx.fillStyle = refl;
  ctx.beginPath();
  ctx.moveTo(sunX - 24, HOR);
  ctx.lineTo(sunX + 24, HOR);
  ctx.lineTo(sunX + 104, PY + PH);
  ctx.lineTo(sunX - 104, PY + PH);
  ctx.closePath();
  ctx.fill();

  /* 波纹 */
  ctx.strokeStyle = 'rgba(255,255,255,.16)';
  ctx.lineWidth = 1.4;
  for (let i = 0; i < 26; i++) {
    const p = i / 26;
    const y = HOR + 14 + p * (PY + PH - HOR - 30);
    const x = PX + ((i * 71) % PW);
    ctx.beginPath();
    ctx.ellipse(x, y, 20 + p * 30, 2 + p * 1.8, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  /* 岸 */
  ctx.fillStyle = '#6b5236';
  ctx.beginPath();
  ctx.moveTo(PX, PY + PH);
  ctx.lineTo(PX, PY + PH - 52);
  ctx.quadraticCurveTo(PX + PW * 0.24, PY + PH - 74, PX + PW * 0.5, PY + PH - 44);
  ctx.quadraticCurveTo(PX + PW * 0.76, PY + PH - 20, PX + PW, PY + PH - 36);
  ctx.lineTo(PX + PW, PY + PH);
  ctx.closePath();
  ctx.fill();

  /* 小铺 */
  const sx = PX + 28, sy = PY + PH - 112;
  ctx.save();
  ctx.translate(sx, sy);
  ctx.scale(1.05, 1.05);
  ctx.fillStyle = '#8a6a44';
  ctx.fillRect(0, 26, 96, 54);
  ctx.fillStyle = '#6f5334';
  ctx.fillRect(0, 26, 96, 8);
  const win = ctx.createLinearGradient(0, 40, 0, 74);
  win.addColorStop(0, '#ffd98a');
  win.addColorStop(1, '#e79b3f');
  ctx.fillStyle = win;
  ctx.fillRect(10, 40, 30, 30);
  ctx.strokeStyle = '#5c4529';
  ctx.lineWidth = 2;
  ctx.strokeRect(10, 40, 30, 30);
  ctx.fillStyle = '#c05a44';
  ctx.beginPath();
  ctx.moveTo(-8, 26); ctx.lineTo(104, 26); ctx.lineTo(96, 4); ctx.lineTo(0, 4);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#f0e2c8';
  for (let i = 0; i < 4; i++) {
    if (i % 2 === 0) continue;
    ctx.beginPath();
    ctx.moveTo(-8 + i * 28, 26); ctx.lineTo(i * 28, 4);
    ctx.lineTo(12 + i * 28, 4); ctx.lineTo(4 + i * 28, 26);
    ctx.closePath(); ctx.fill();
  }
  ctx.fillStyle = '#fdf3df';
  ctx.fillRect(50, 34, 40, 22);
  ctx.strokeStyle = '#5c4529';
  ctx.lineWidth = 2;
  ctx.strokeRect(50, 34, 40, 22);
  ctx.fillStyle = '#8a5a2b';
  ctx.font = 'bold 15px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('小铺', 70, 46);
  ctx.restore();

  /* 灯笼 */
  const lx = PX + 176, ly = PY + PH - 128;
  ctx.save();
  ctx.strokeStyle = '#4a3826';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(lx + 22, ly + 66); ctx.lineTo(lx + 22, ly - 36); ctx.lineTo(lx - 2, ly - 36);
  ctx.stroke();
  const gl = ctx.createRadialGradient(lx, ly, 2, lx, ly, 70);
  gl.addColorStop(0, 'rgba(255,206,120,.5)');
  gl.addColorStop(1, 'rgba(255,206,120,0)');
  ctx.fillStyle = gl;
  ctx.fillRect(lx - 78, ly - 78, 156, 156);
  ctx.fillStyle = '#e8543f';
  ctx.beginPath();
  ctx.ellipse(lx, ly, 14, 17, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#f6c46a';
  ctx.fillRect(lx - 6, ly - 17, 12, 4);
  ctx.fillRect(lx - 6, ly + 13, 12, 4);
  ctx.restore();

  /* 钓竿与钓线 */
  const rbX = PX + PW - 46, rbY = PY + PH - 26;
  const rtX = PX + PW - 138, rtY = PY + PH - 212;
  ctx.strokeStyle = '#4a3826';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(rbX, rbY); ctx.lineTo(rtX, rtY);
  ctx.stroke();
  const fx = PX + PW * 0.5, fy = HOR + 92;
  ctx.strokeStyle = 'rgba(60,44,30,.72)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(rtX, rtY);
  ctx.quadraticCurveTo((rtX + fx) / 2 + 10, fy - 30, fx, fy - 7);
  ctx.stroke();

  /* 浮标 + 水花 */
  ctx.strokeStyle = 'rgba(255,255,255,.5)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(fx, fy, 26, 7, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#e0483c';
  ctx.beginPath();
  ctx.arc(fx, fy, 8, Math.PI, 0);
  ctx.fill();
  ctx.fillStyle = '#fdf6e6';
  ctx.beginPath();
  ctx.arc(fx, fy, 8, 0, Math.PI);
  ctx.fill();
  ctx.strokeStyle = 'rgba(40,30,20,.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(fx - 8, fy); ctx.lineTo(fx + 8, fy);
  ctx.stroke();

  ctx.restore();   /* 退出小景坐标系 */

  /* 小景描边 */
  ctx.strokeStyle = '#d8cdb8';
  ctx.lineWidth = 3;
  roundRect(ctx, PX, PY, PW, PH, 22);
  ctx.stroke();

  /* ---- 右下：反应窗口条（玩法一眼就懂） ---- */
  const BX = 664, BY = 616, BW = 520, BH = 32;
  ctx.fillStyle = '#e6dcc4';
  roundRect(ctx, BX, BY, BW, BH, 16);
  ctx.fill();
  ctx.strokeStyle = '#d8cdb8';
  ctx.lineWidth = 2;
  roundRect(ctx, BX, BY, BW, BH, 16);
  ctx.stroke();
  /* 完美区 */
  const zw = BW * 0.26;
  ctx.fillStyle = '#d0483a';
  roundRect(ctx, BX + BW * 0.37, BY + 3, zw, BH - 6, 13);
  ctx.fill();
  /* 游标 */
  ctx.fillStyle = '#2a2118';
  roundRect(ctx, BX + BW * 0.5 - 4, BY - 4, 8, BH + 8, 4);
  ctx.fill();
  ctx.fillStyle = '#7a6b58';
  ctx.font = '19px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('反应窗口 · 红区＝完美（双倍）', BX, BY + BH + 26);

  /* ---- 左下：三条鱼（常见 / 稀有 / 传说） ---- */
  const fishes = [
    { x: 96, y: 640, s: 1.0, body: '#8fb8c9', label: '鲫鱼', lc: '#3f8f5f' },
    { x: 250, y: 656, s: 1.25, body: '#c98b4a', label: '鳜鱼', lc: '#2f6fd0' },
    { x: 440, y: 632, s: 1.6, body: '#e0a53c', label: '龙鳞锦鲤', lc: '#c8912f' },
  ];
  for (const f of fishes) {
    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.scale(f.s, f.s);
    ctx.fillStyle = f.body;
    ctx.beginPath();
    ctx.ellipse(0, 0, 34, 17, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-30, 0); ctx.lineTo(-52, -15); ctx.lineTo(-52, 15);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#33454f';
    ctx.beginPath();
    ctx.arc(20, -3, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    /* 稀有度圆点 + 名字（放在鱼的右下方，不压到鱼身上） */
    ctx.fillStyle = f.lc;
    ctx.beginPath();
    ctx.arc(f.x - 46 * f.s, f.y + 34 * f.s, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#7a6b58';
    ctx.font = '18px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(f.label, f.x - 34 * f.s, f.y + 34 * f.s);
  }

  return cv.toDataURL('image/png');
}, { W, H });

const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
const outPath = path.join(ROOT, 'covers', 'fishing.png');
fs.writeFileSync(outPath, buf);
console.log('[gen-cover-fishing] 已生成 covers/fishing.png  ' + buf.length + ' B  ' + W + '×' + H);

await browser.close();
server.close();
