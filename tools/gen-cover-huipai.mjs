/* tools/gen-cover-huipai.mjs —— 用浏览器 canvas 画「回牌」大厅封面
 *
 * 用法：node tools/gen-cover-huipai.mjs
 *
 * 为什么自己画而不用 AI 生成：
 *   仓库的 build-covers.mjs 依赖 Windows 上的 Edge + ImageMagick 链路，在本机跑不了；
 *   封面只是大厅列表里的一张 1280×800 缩略图，canvas 画一张 Q 版图完全够用。
 *
 * 视觉基调对齐游戏本体：深绿毛毡牌桌 + 金色 + 扑克牌扇形。
 *
 * 输出：covers/huipai.png（1280×800）
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

  /* ---- 底：深绿毛毡径向渐变 ---- */
  const bg = ctx.createRadialGradient(W * 0.5, H * 0.42, 80, W * 0.5, H * 0.5, W * 0.78);
  bg.addColorStop(0, '#215240');
  bg.addColorStop(0.62, '#14382c');
  bg.addColorStop(1, '#0a2019');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  /* 毛毡纹理：细噪点 */
  ctx.save();
  for (let i = 0; i < 2600; i++) {
    const x = Math.random() * W, y = Math.random() * H;
    ctx.fillStyle = 'rgba(255,255,255,' + (Math.random() * 0.035) + ')';
    ctx.fillRect(x, y, 1.6, 1.6);
  }
  ctx.restore();

  /* 桌沿暗角 */
  const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.34, W / 2, H / 2, H * 0.95);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,.5)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);

  /* ---- 左侧：标题 ---- */
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  ctx.fillStyle = '#d9b66a';
  ctx.fillRect(72, 168, 74, 8);

  ctx.fillStyle = '#f4ecd8';
  ctx.font = 'bold 96px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillText('回牌', 72, 292);

  ctx.fillStyle = '#a9c2ac';
  ctx.font = '28px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillText('3 副 156 张 · 三人局', 72, 352);
  ctx.fillText('5-10-K 特殊牌型 · 炸弹牌力阶梯', 72, 396);

  /* 小标签 */
  const tags = [
    { t: '民间玩法', bg: '#b23a2e' },
    { t: '本地 AI', bg: '#9c7d3c' },
    { t: '断线续局', bg: '#2f6a52' },
  ];
  let tx = 72;
  ctx.font = '22px "PingFang SC","Microsoft YaHei",sans-serif';
  for (const tag of tags) {
    const tw = ctx.measureText(tag.t).width + 34;
    ctx.fillStyle = tag.bg;
    roundRect(ctx, tx, 436, tw, 44, 22);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(tag.t, tx + tw / 2, 460);
    tx += tw + 14;
  }

  /* ---- 右侧：一把扇开的扑克牌（绕底部中心旋转） ---- */
  /* 牌面定义：[点数文字, 花色, 颜色] */
  const CARDS = [
    ['A', '♠', '#1c1c28'],
    ['K', '♥', '#b23a2e'],
    ['Q', '♦', '#b23a2e'],
    ['J', '♣', '#1c1c28'],
    ['10', '♠', '#1c1c28'],
    ['5', '♥', '#b23a2e'],
  ];
  const CW = 118, CH = 172;
  const n = CARDS.length;
  const pivotX = 880, pivotY = 600;       /* 扇形圆弧的圆心位置 */
  const R = 360;                          /* 弧半径 */
  const SPREAD = 0.34;                    /* 每张之间的角度增量 */
  const ANG0 = -((n - 1) / 2) * SPREAD;

  CARDS.forEach((cd, i) => {
    const ang = ANG0 + i * SPREAD;
    /* 沿圆弧摆放：中间高、两侧低，每张牌的朝向跟着切线 */
    const cx = pivotX + R * Math.sin(ang);
    const cy = pivotY - R * (1 - Math.cos(ang)) - CH / 2 - 22;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang);

    const ox = -CW / 2, oy = -CH / 2;

    /* 每张牌自己的投影（跟着一起旋转，不会出现生硬的方块） */
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = '#000';
    roundRect(ctx, ox + 7, oy + 11, CW, CH, 12);
    ctx.fill();
    ctx.restore();

    /* 牌面 */
    ctx.fillStyle = '#fffdf6';
    roundRect(ctx, ox, oy, CW, CH, 12);
    ctx.fill();
    ctx.strokeStyle = '#cbb994';
    ctx.lineWidth = 2;
    ctx.stroke();

    /* 内框 */
    ctx.strokeStyle = 'rgba(150,120,70,.22)';
    ctx.lineWidth = 1;
    roundRect(ctx, ox + 8, oy + 8, CW - 16, CH - 16, 8);
    ctx.stroke();

    /* 左上角：点数 + 小花色 */
    ctx.fillStyle = cd[2];
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = 'bold 27px "PingFang SC",sans-serif';
    ctx.fillText(cd[0], ox + 13, oy + 40);
    ctx.font = '22px serif';
    ctx.fillText(cd[1], ox + 13, oy + 67);

    /* 中央大花色 */
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '60px serif';
    ctx.fillText(cd[1], ox + CW / 2, oy + CH / 2 + 4);

    /* 右下角倒过来的点数 */
    ctx.save();
    ctx.translate(ox + CW - 16, oy + CH - 16);
    ctx.rotate(Math.PI);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = 'bold 26px "PingFang SC",sans-serif';
    ctx.fillText(cd[0], 0, 0);
    ctx.restore();

    ctx.restore();
  });

  /* ---- 「特殊牌型」小牌：5 · 10 · K ---- */
  const spY = 672;
  const spW = 74, spH = 104;
  const sps = [['5', '#b23a2e'], ['10', '#1c1c28'], ['K', '#b23a2e']];
  const spTotal = sps.length * spW + (sps.length - 1) * 14;
  const spX = 700 + (560 - spTotal) / 2;
  sps.forEach((s, i) => {
    const x = spX + i * (spW + 14);
    ctx.fillStyle = '#fffdf6';
    roundRect(ctx, x, spY, spW, spH, 10);
    ctx.fill();
    ctx.strokeStyle = '#d9b66a';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.fillStyle = s[1];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 34px "PingFang SC",sans-serif';
    ctx.fillText(s[0], x + spW / 2, spY + spH / 2 - 8);
    ctx.font = '15px "PingFang SC",sans-serif';
    ctx.fillStyle = '#7a6b58';
    ctx.fillText('特殊', x + spW / 2, spY + spH / 2 + 24);
  });

  return cv.toDataURL('image/png');
}, { W, H });

const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
const outPath = path.join(ROOT, 'covers', 'huipai.png');
fs.writeFileSync(outPath, buf);
console.log('[gen-cover-huipai] 已生成 covers/huipai.png  ' + buf.length + ' B  ' + W + '×' + H);

await browser.close();
server.close();
