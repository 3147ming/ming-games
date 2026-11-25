/* tools/gen-cover-undercover.mjs —— 用浏览器 canvas 画「谁是卧底」大厅封面
 *
 * 用法：node tools/gen-cover-undercover.mjs
 *
 * 为什么自己画而不用 AI 生成：
 *   仓库的 build-covers.mjs 依赖 Windows 上的 Edge + ImageMagick 链路，在本机跑不了；
 *   封面只是大厅列表里的一张 1280×800 缩略图，canvas 画一张 Q 版图完全够用。
 *
 * 输出：covers/undercover.png（1280×800）
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

  /* ---- 背景：深紫夜色 ---- */
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#2a1e52');
  bg.addColorStop(1, '#0d0918');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const glow = ctx.createRadialGradient(W * 0.70, H * 0.30, 20, W * 0.70, H * 0.30, 460);
  glow.addColorStop(0, 'rgba(150,120,255,.20)');
  glow.addColorStop(1, 'rgba(150,120,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  /* ---- 右侧：三个角色剪影（其中一个是卧底，脸被遮住） ---- */
  const people = [
    { x: 760, y: 640, body: '#3d2f6e', head: '#f0c040', mask: false, scale: 1.00 },
    { x: 900, y: 660, body: '#4a3a86', head: '#e8e2f7', mask: true, scale: 1.10 },
    { x: 1040, y: 640, body: '#332768', head: '#c9bde3', mask: false, scale: 0.95 },
  ];
  for (const p of people) {
    const s = p.scale;
    /* 身体 */
    ctx.fillStyle = p.body;
    ctx.beginPath();
    ctx.moveTo(p.x - 78 * s, H);
    ctx.quadraticCurveTo(p.x - 62 * s, p.y - 60 * s, p.x, p.y - 66 * s);
    ctx.quadraticCurveTo(p.x + 62 * s, p.y - 60 * s, p.x + 78 * s, H);
    ctx.closePath();
    ctx.fill();
    /* 头 */
    ctx.fillStyle = p.head;
    ctx.beginPath();
    ctx.arc(p.x, p.y - 118 * s, 52 * s, 0, Math.PI * 2);
    ctx.fill();
    if (p.mask) {
      /* 卧底：戴面具 */
      ctx.fillStyle = '#14102a';
      ctx.beginPath();
      ctx.ellipse(p.x, p.y - 122 * s, 44 * s, 38 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      /* 面具上的两个眼孔 */
      ctx.fillStyle = '#f0c040';
      ctx.beginPath();
      ctx.ellipse(p.x - 17 * s, p.y - 126 * s, 8 * s, 5 * s, -0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(p.x + 17 * s, p.y - 126 * s, 8 * s, 5 * s, 0.2, 0, Math.PI * 2);
      ctx.fill();
      /* 面具绑带 */
      ctx.strokeStyle = 'rgba(240,192,64,.75)';
      ctx.lineWidth = 5 * s;
      ctx.beginPath();
      ctx.moveTo(p.x - 52 * s, p.y - 100 * s);
      ctx.lineTo(p.x + 52 * s, p.y - 100 * s);
      ctx.stroke();
    } else {
      /* 普通角色：眼睛 */
      ctx.fillStyle = '#2a2140';
      ctx.beginPath();
      ctx.arc(p.x - 17 * s, p.y - 122 * s, 6.5 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(p.x + 17 * s, p.y - 122 * s, 6.5 * s, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /* ---- 悬浮的词卡（背面的花纹 = 保密） ---- */
  function card(cx, cy, w, h, rot, faceUp) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.shadowColor = 'rgba(0,0,0,.5)';
    ctx.shadowBlur = 26;
    ctx.shadowOffsetY = 10;
    ctx.beginPath();
    roundRect(ctx, -w / 2, -h / 2, w, h, 16);
    if (faceUp) {
      const g = ctx.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2);
      g.addColorStop(0, '#f7e7a8');
      g.addColorStop(1, '#e0b23c');
      ctx.fillStyle = g;
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.fillStyle = '#4a3410';
      ctx.font = '800 34px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('?', 0, 2);
    } else {
      ctx.fillStyle = '#3a2b63';
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.save();
      ctx.beginPath();
      roundRect(ctx, -w / 2, -h / 2, w, h, 16);
      ctx.clip();
      ctx.strokeStyle = 'rgba(240,192,64,.28)';
      ctx.lineWidth = 9;
      for (let i = -h; i < w + h; i += 26) {
        ctx.beginPath();
        ctx.moveTo(-w / 2 + i, -h / 2);
        ctx.lineTo(-w / 2 + i + h, h / 2);
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.restore();
  }
  card(700, 250, 150, 210, -0.16, false);
  card(860, 190, 165, 232, 0.06, true);
  card(1010, 268, 145, 204, 0.20, false);

  /* ---- 左侧标题区 ---- */
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  ctx.font = '700 92px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
  const grad = ctx.createLinearGradient(86, 0, 86, 120);
  grad.addColorStop(0, '#fff3c9');
  grad.addColorStop(1, '#f0c040');
  ctx.fillStyle = grad;
  ctx.fillText('谁是卧底', 82, 300);

  ctx.font = '500 33px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
  ctx.fillStyle = 'rgba(240,192,64,.86)';
  ctx.fillText('描述 · 投票 · 揪出那个不一样的', 88, 356);

  const tags = ['人机对局', '同屏多人', '纯 P2P 联机'];
  ctx.font = '600 24px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
  let ty = 396;
  for (const t of tags) {
    const tw = ctx.measureText(t).width;
    ctx.beginPath();
    roundRect(ctx, 88, ty, tw + 34, 44, 22);
    ctx.fillStyle = 'rgba(240,192,64,.14)'; ctx.fill();
    ctx.strokeStyle = 'rgba(240,192,64,.45)'; ctx.lineWidth = 1.6; ctx.stroke();
    ctx.fillStyle = '#f0d68d';
    ctx.fillText(t, 88 + 17, ty + 29);
    ty += 54;
  }

  ctx.font = '500 23px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
  ctx.fillStyle = 'rgba(214,205,240,.6)';
  ctx.fillText('联机不经过任何服务器 · 不花钱 · 不用改 IP', 88, 706);
  ctx.fillText('你的词只有你自己看得到', 88, 740);

  ctx.restore();

  return cv.toDataURL('image/png');
}, { W, H });

await browser.close();
server.close();

const outPath = path.join(ROOT, 'covers', 'undercover.png');
const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
fs.writeFileSync(outPath, buf);
console.log('[gen-cover-undercover] 已生成 covers/undercover.png  ' + buf.length + ' B  ' + W + '×' + H);
