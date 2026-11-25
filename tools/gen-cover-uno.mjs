/* tools/gen-cover-uno.mjs —— 用浏览器 canvas 画 UNO 彩牌大厅封面
 *
 * 用法：node tools/gen-cover-uno.mjs
 *
 * 为什么自己画而不用 AI 生成：
 *   仓库的 build-covers.mjs 依赖 Windows 上的 Edge + ImageMagick 链路，在本机跑不了；
 *   封面只是大厅列表里的一张 1280×800 缩略图，canvas 画一张 Q 版图完全够用。
 *
 * 输出：covers/uno.png（1280×800）
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

  /* ---- 底：深紫渐变 ---- */
  const bg = ctx.createRadialGradient(W * 0.5, H * 0.34, 40, W * 0.5, H * 0.5, W * 0.78);
  bg.addColorStop(0, '#3a2a68');
  bg.addColorStop(0.55, '#241a44');
  bg.addColorStop(1, '#0e0a1c');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  /* ---- 牌 ---- */
  const CW = 116, CH = 164;
  const COLORS = ['#e0483c', '#f5c542', '#3fb96b', '#3d8bd8'];

  /* 画一张 UNO 牌（x,y 是中心，rot 弧度） */
  function card(cx, cy, color, label, rot, sub) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    /* 投影 */
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.5)';
    ctx.shadowBlur = 26;
    ctx.shadowOffsetY = 10;
    ctx.fillStyle = color;
    roundRect(ctx, -CW / 2, -CH / 2, CW, CH, 14);
    ctx.fill();
    ctx.restore();
    /* 白色内框 */
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.lineWidth = 4;
    roundRect(ctx, -CW / 2 + 9, -CH / 2 + 9, CW - 18, CH - 18, 9);
    ctx.stroke();
    /* 中央数字/符号 */
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '800 74px system-ui,"PingFang SC",sans-serif';
    ctx.fillText(label, 0, 2);
    /* 四角小椭圆（UNO 牌的经典元素） */
    ctx.fillStyle = 'rgba(255,255,255,.9)';
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sy]) => {
      ctx.beginPath();
      ctx.ellipse(sx * (CW / 2 - 22), sy * (CH / 2 - 22), 13, 20, 0, 0, Math.PI * 2);
      ctx.fill();
    });
    if (sub) {
      ctx.font = '700 17px system-ui,"PingFang SC",sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,.9)';
      ctx.fillText(sub, 0, CH / 2 - 26);
    }
    ctx.restore();
  }

  /* 右侧扇形散牌 */
  const fan = [
    [560, 470, -0.30, COLORS[0], '7'],
    [700, 430, -0.13, COLORS[1], '3'],
    [845, 415, 0.05, COLORS[2], '9'],
    [985, 440, 0.22, COLORS[3], '1'],
  ];
  fan.forEach(([x, y, r, c, l]) => card(x, y, c, l, r));

  /* 万能牌（斜压在最上层） */
  ctx.save();
  ctx.translate(760, 250);
  ctx.rotate(-0.08);
  ctx.shadowColor = 'rgba(0,0,0,.55)';
  ctx.shadowBlur = 34;
  ctx.shadowOffsetY = 14;
  ctx.fillStyle = '#241a44';
  roundRect(ctx, -CW / 2 - 6, -CH / 2 - 6, CW + 12, CH + 12, 18);
  ctx.fill();
  ctx.restore();
  /* 万能牌的彩虹斜条 */
  ctx.save();
  ctx.translate(760, 250);
  ctx.rotate(-0.08);
  ctx.save();
  ctx.beginPath();
  ctx.rect(-CW / 2, -CH / 2, CW, CH);
  ctx.clip();
  const bands = 7;
  for (let i = 0; i < bands; i++) {
    ctx.fillStyle = COLORS[i % 4];
    ctx.save();
    ctx.rotate(-0.5);
    ctx.fillRect(-140 + i * 40, -200, 40, 400);
    ctx.restore();
  }
  ctx.restore();
  ctx.strokeStyle = 'rgba(255,255,255,.9)';
  ctx.lineWidth = 5;
  roundRect(ctx, -CW / 2 + 12, -CH / 2 + 12, CW - 24, CH - 24, 11);
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '800 60px system-ui,"PingFang SC",sans-serif';
  ctx.fillText('W', 0, 2);
  ctx.restore();

  /* 小卡片（+2 / 跳过） */
  card(1010, 620, '#241a44', '+2', 0.16);
  card(1140, 660, '#241a44', '⊘', -0.10);

  /* ---- 左侧标题区 ---- */
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  ctx.font = '700 96px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
  const grad = ctx.createLinearGradient(86, 0, 86, 110);
  grad.addColorStop(0, '#fff3c9');
  grad.addColorStop(1, '#f5c542');
  ctx.fillStyle = grad;
  ctx.fillText('UNO 彩牌', 82, 320);

  ctx.font = '500 34px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
  ctx.fillStyle = 'rgba(245,197,66,.86)';
  ctx.fillText('四色数字牌 · 万能牌 · 手牌出完即胜', 88, 376);

  const tags = ['人机对弈', '同屏双人', '纯 P2P 联机'];
  ctx.font = '600 24px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
  let ty = 414;
  tags.forEach((t) => {
    const tw = ctx.measureText(t).width;
    ctx.beginPath();
    roundRect(ctx, 88, ty, tw + 34, 44, 22);
    ctx.fillStyle = 'rgba(245,197,66,.14)'; ctx.fill();
    ctx.strokeStyle = 'rgba(245,197,66,.45)'; ctx.lineWidth = 1.6; ctx.stroke();
    ctx.fillStyle = '#f0d68d';
    ctx.fillText(t, 88 + 17, ty + 29);
    ty += 54;
  });

  ctx.font = '500 24px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
  ctx.fillStyle = 'rgba(214,205,240,.6)';
  ctx.fillText('联机不经过任何服务器 · 不花钱 · 不用改 IP', 88, 700);

  ctx.restore();

  /* ---- 顶部装饰光 ---- */
  const glow = ctx.createRadialGradient(W * 0.22, H * 0.18, 10, W * 0.22, H * 0.18, 320);
  glow.addColorStop(0, 'rgba(200,180,255,.14)');
  glow.addColorStop(1, 'rgba(200,180,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  return cv.toDataURL('image/png');
}, { W, H });

await browser.close();
server.close();

const outPath = path.join(ROOT, 'covers', 'uno.png');
const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
fs.writeFileSync(outPath, buf);
console.log('[gen-cover-uno] 已生成 covers/uno.png  ' + buf.length + ' B  ' + W + '×' + H);
