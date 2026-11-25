/* tools/gen-cover-shanhai-merge.mjs —— 用浏览器 canvas 画「山海合成」大厅封面
 *
 * 用法：node tools/gen-cover-shanhai-merge.mjs
 *
 * 为什么自己画而不用 AI 生成：
 *   仓库的 build-covers.mjs 依赖 Windows 上的 Edge + ImageMagick 链路，在本机跑不了；
 *   封面只是大厅列表里的一张 1280×800 缩略图，canvas 画一张 Q 版图完全够用。
 *
 * 输出：covers/shanhai-merge.png（1280×800）
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

/* 八阶神兽的配色 —— 跟 src/rules.mjs 里的 BEASTS 一致（冷 → 暖） */
const BEASTS = [
  { name: '山魈', color: '#2aa7a0' },
  { name: '白泽', color: '#3f6fd4' },
  { name: '玄鸟', color: '#6f57cf' },
  { name: '毕方', color: '#a847c8' },
  { name: '九尾狐', color: '#d94f7a' },
  { name: '烛龙', color: '#e0473c' },
  { name: '鲲鹏', color: '#f0872c' },
  { name: '饕餮', color: '#e8b93c' },
];

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

const dataUrl = await page.evaluate(({ W, H, BEASTS }) => {
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

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    if (amt >= 0) {
      r = Math.round(r + (255 - r) * amt);
      g = Math.round(g + (255 - g) * amt);
      b = Math.round(b + (255 - b) * amt);
    } else {
      r = Math.round(r * (1 + amt));
      g = Math.round(g * (1 + amt));
      b = Math.round(b * (1 + amt));
    }
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  /* ---- 底：深墨青渐变 + 一点点星芒 ---- */
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#16262c');
  bg.addColorStop(0.5, '#0e1a1f');
  bg.addColorStop(1, '#080f12');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  /* 右上角一团暖光（金色，像灵光） */
  const glow = ctx.createRadialGradient(980, 210, 20, 980, 210, 520);
  glow.addColorStop(0, 'rgba(232,185,60,.20)');
  glow.addColorStop(0.5, 'rgba(232,185,60,.06)');
  glow.addColorStop(1, 'rgba(232,185,60,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  /* 淡淡的星点 */
  ctx.fillStyle = 'rgba(255,255,255,.35)';
  const stars = [[130, 90, 1.6], [300, 60, 1.1], [520, 130, 1.3], [660, 45, 1.6],
    [820, 95, 1.1], [1150, 60, 1.4], [1200, 300, 1.1], [90, 420, 1.2],
    [420, 330, 1.0], [560, 250, 1.4], [1230, 620, 1.2], [70, 700, 1.5]];
  for (const [x, y, r] of stars) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  /* ---- 左侧：标题 ---- */
  /* 金色短线 */
  ctx.fillStyle = '#e8b93c';
  ctx.fillRect(72, 172, 74, 8);

  /* 标题：金色渐变字 */
  const tg = ctx.createLinearGradient(0, 200, 0, 300);
  tg.addColorStop(0, '#fbeec2');
  tg.addColorStop(1, '#d9a52c');
  ctx.fillStyle = tg;
  ctx.font = 'bold 92px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('山海合成', 72, 288);

  ctx.fillStyle = '#93aab1';
  ctx.font = '27px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillText('上古神兽 · 两两合体 · 合成饕餮即胜', 72, 350);
  ctx.fillText('8 阶灵兽图鉴 · 每日固定局比分数 · 一键撤销', 72, 392);

  /* 小标签 */
  const tags = [
    { t: '合成玩法', bg: '#2aa7a0' },
    { t: '每日固定局', bg: '#d94f7a' },
    { t: '步数挑战', bg: '#e8b93c' },
  ];
  let tx = 72;
  ctx.font = '22px "PingFang SC","Microsoft YaHei",sans-serif';
  for (const tag of tags) {
    const tw = ctx.measureText(tag.t).width + 34;
    ctx.fillStyle = tag.bg;
    roundRect(ctx, tx, 430, tw, 44, 22);
    ctx.fill();
    ctx.fillStyle = tag.bg === '#e8b93c' ? '#2a2118' : '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(tag.t, tx + tw / 2, 453);
    tx += tw + 14;
  }

  /* ---- 右侧：6×6 迷你棋盘 ---- */
  const N = 6, CELL = 78, GAP = 6;
  const S = N * CELL + (N - 1) * GAP;
  const BX = 900 - S / 2, BY = 400 - S / 2;

  /* 棋盘底板 */
  ctx.fillStyle = 'rgba(255,255,255,.045)';
  roundRect(ctx, BX - 22, BY - 22, S + 44, S + 44, 22);
  ctx.fill();
  ctx.strokeStyle = 'rgba(232,185,60,.22)';
  ctx.lineWidth = 2;
  ctx.stroke();

  /* 格子 */
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const x = BX + j * (CELL + GAP);
      const y = BY + i * (CELL + GAP);
      ctx.fillStyle = 'rgba(255,255,255,.03)';
      roundRect(ctx, x, y, CELL, CELL, 12);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.06)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  /* 灵兽方块：故意放几对同阶的，暗示「可以合体」 */
  const placed = [
    { r: 0, c: 1, lv: 0 }, { r: 0, c: 3, lv: 0 },
    { r: 1, c: 2, lv: 1 },
    { r: 2, c: 0, lv: 2 }, { r: 2, c: 4, lv: 2 },
    { r: 3, c: 2, lv: 3 },
    { r: 4, c: 1, lv: 4 }, { r: 4, c: 3, lv: 4 },
    { r: 5, c: 2, lv: 5 },
  ];

  function beast(x, y, lv, scale, alpha) {
    const b = BEASTS[lv];
    const w = CELL * scale, h = CELL * scale;
    const bx = x + (CELL - w) / 2, by = y + (CELL - h) / 2;
    /* 光晕 */
    ctx.save();
    ctx.globalAlpha = alpha * 0.5;
    ctx.fillStyle = b.color;
    roundRect(ctx, bx - 7, by - 7, w + 14, h + 14, 16);
    ctx.fill();
    ctx.restore();
    /* 本体 */
    ctx.save();
    ctx.globalAlpha = alpha;
    const g = ctx.createLinearGradient(bx, by, bx + w, by + h);
    g.addColorStop(0, b.color);
    g.addColorStop(1, shade(b.color, -0.4));
    ctx.fillStyle = g;
    roundRect(ctx, bx, by, w, h, 13);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.22)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    /* 名字 */
    ctx.fillStyle = '#fff';
    ctx.font = 'bold ' + Math.round(CELL * scale * 0.3) + 'px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,.6)';
    ctx.shadowBlur = 4;
    ctx.fillText(b.name, bx + w / 2, by + h / 2 + 1);
    ctx.shadowBlur = 0;
    ctx.restore();
  }

  /* 先画低阶，再画高阶（高阶压在上面，形成层次） */
  for (const p of placed) {
    const x = BX + p.c * (CELL + GAP);
    const y = BY + p.r * (CELL + GAP);
    /* 最上面那只是饕餮，放大一点强调 */
    const isTop = p.lv === 5;
    beast(x, y, p.lv, isTop ? 1.02 : 0.86, 1);
  }

  /* ---- 合体的箭头：两只山魈中间画个金色箭头 ---- */
  const ax = BX + 2 * (CELL + GAP) + CELL / 2;
  const ay = BY + 0 * (CELL + GAP) + CELL / 2;
  const r1 = BX + 1 * (CELL + GAP) + CELL / 2;
  const r2 = BX + 3 * (CELL + GAP) + CELL / 2;
  ctx.strokeStyle = '#e8b93c';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(r1 + CELL / 2 + 6, ay);
  ctx.lineTo(r2 - CELL / 2 - 10, ay);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(r2 - CELL / 2 - 4, ay);
  ctx.lineTo(r2 - CELL / 2 - 20, ay - 9);
  ctx.lineTo(r2 - CELL / 2 - 20, ay + 9);
  ctx.closePath();
  ctx.fillStyle = '#e8b93c';
  ctx.fill();

  /* ---- 左下角：八阶图鉴条（2 行 × 4 列，避开右侧棋盘） ---- */
  const GY = 566;
  ctx.fillStyle = '#7f949b';
  ctx.font = '19px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('八阶灵兽', 72, GY - 32);
  const gw = 124, gh = 54, ggap = 10, rgap = 10;
  BEASTS.forEach((b, i) => {
    const col = i % 4, row = Math.floor(i / 4);
    const x = 72 + col * (gw + ggap);
    const y = GY + row * (gh + rgap);
    ctx.fillStyle = 'rgba(255,255,255,.05)';
    roundRect(ctx, x, y, gw, gh, 10);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.10)';
    ctx.lineWidth = 1;
    ctx.stroke();
    /* 色块 */
    ctx.fillStyle = b.color;
    roundRect(ctx, x + 8, y + (gh - 22) / 2, 22, 22, 7);
    ctx.fill();
    /* 名字 */
    ctx.fillStyle = '#c6d5d9';
    ctx.font = '17px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(b.name, x + 40, y + gh / 2 + 1);
  });

  return cv.toDataURL('image/png');
}, { W, H, BEASTS });

const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
const outPath = path.join(ROOT, 'covers', 'shanhai-merge.png');
fs.writeFileSync(outPath, buf);
console.log('[gen-cover-shanhai-merge] 已生成 covers/shanhai-merge.png  ' + buf.length + ' B  ' + W + '×' + H);

await browser.close();
server.close();
