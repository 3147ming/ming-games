/* tools/gen-cover-quiz-party.mjs —— 用浏览器 canvas 画「快问快答派对」大厅封面
 *
 * 用法：node tools/gen-cover-quiz-party.mjs
 *
 * 为什么自己画而不用 AI 生成：
 *   仓库的 build-covers.mjs 依赖 Windows 上的 Edge + ImageMagick 链路，在本机跑不了；
 *   封面只是大厅列表里的一张 1280×800 缩略图，canvas 画一张够用。
 *
 * 输出：covers/quiz-party.png（1280×800）
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

  /* ---- 底：深紫夜色渐变 ---- */
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#2a1550');
  bg.addColorStop(0.5, '#1a0d33');
  bg.addColorStop(1, '#3d1030');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  /* ---- 右上角一抹粉光 ---- */
  const glow = ctx.createRadialGradient(1050, 150, 20, 1050, 150, 620);
  glow.addColorStop(0, 'rgba(255,77,141,.42)');
  glow.addColorStop(1, 'rgba(255,77,141,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  /* ---- 淡淡的星点 ---- */
  ctx.fillStyle = 'rgba(255,255,255,.32)';
  const stars = [[120, 90], [250, 60], [430, 110], [610, 55], [800, 120], [960, 70],
    [1180, 200], [150, 640], [330, 700], [520, 640], [900, 690], [1150, 620],
    [700, 700], [60, 380], [1240, 430]];
  for (const p of stars) {
    ctx.beginPath();
    ctx.arc(p[0], p[1], 2.2, 0, Math.PI * 2);
    ctx.fill();
  }

  /* ---- 左侧：标题 ---- */
  ctx.fillStyle = '#ff4d8d';
  ctx.fillRect(72, 172, 74, 8);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 88px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('快问快答', 72, 288);
  /* 「派对」用双色叠印：底层粉、顶层紫，略带错位做出印刷感 */
  const px = 72 + 4 * 88 + 18;
  ctx.fillStyle = '#ff4d8d';
  ctx.fillText('派对', px + 4, 292);
  ctx.fillStyle = '#a78bfa';
  ctx.fillText('派对', px, 288);

  ctx.fillStyle = '#c3b4e8';
  ctx.font = '26px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillText('15 秒限时抢答 · 答对得分 · 连对加成', 72, 348);
  ctx.fillText('每日一局全网同题 · 零服务器双人对战', 72, 390);

  /* 小标签 */
  const tags = [
    { t: '每日一局', bg: '#ff4d8d' },
    { t: '纯 P2P 联机', bg: '#8b5cf6' },
    { t: '128 题库', bg: '#3ddc97' },
  ];
  let tx = 72;
  ctx.font = '22px "PingFang SC","Microsoft YaHei",sans-serif';
  for (const tag of tags) {
    const tw = ctx.measureText(tag.t).width + 34;
    ctx.fillStyle = tag.bg;
    roundRect(ctx, tx, 428, tw, 44, 22);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(tag.t, tx + tw / 2, 452);
    tx += tw + 14;
  }

  /* ---- 右侧：题目卡片（主体视觉） ---- */
  const CX = 700, CY = 96, CW = 500, CH = 610;
  ctx.save();
  ctx.translate(CX, CY);

  /* 卡片阴影 + 本体 */
  ctx.fillStyle = 'rgba(0,0,0,.42)';
  roundRect(ctx, 14, 18, CW, CH, 26);
  ctx.fill();
  const cardGrad = ctx.createLinearGradient(0, 0, CW, CH);
  cardGrad.addColorStop(0, '#3a2263');
  cardGrad.addColorStop(1, '#241540');
  ctx.fillStyle = cardGrad;
  roundRect(ctx, 0, 0, CW, CH, 26);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.16)';
  ctx.lineWidth = 2;
  ctx.stroke();

  /* 顶部：分类标签 + 计时条 */
  ctx.fillStyle = 'rgba(255,77,141,.24)';
  roundRect(ctx, 32, 30, 132, 34, 17);
  ctx.fill();
  ctx.fillStyle = '#ff9ec4';
  ctx.font = '18px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('常识', 50, 48);

  ctx.fillStyle = 'rgba(255,255,255,.14)';
  roundRect(ctx, 300, 38, 168, 18, 9);
  ctx.fill();
  const tb = ctx.createLinearGradient(300, 0, 468, 0);
  tb.addColorStop(0, '#3ddc97');
  tb.addColorStop(1, '#ffc857');
  ctx.fillStyle = tb;
  roundRect(ctx, 300, 38, 118, 18, 9);
  ctx.fill();

  /* 题干占位条 */
  ctx.fillStyle = 'rgba(255,255,255,.9)';
  ctx.font = 'bold 30px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillText('世界上面积最大的', 32, 116);
  ctx.fillText('大洋是？', 32, 156);

  /* 四个选项按钮 */
  const opts = [
    { t: 'A  太平洋', hit: true },
    { t: 'B  大西洋', hit: false },
    { t: 'C  印度洋', hit: false },
    { t: 'D  北冰洋', hit: false },
  ];
  let oy = 200;
  for (const o of opts) {
    ctx.fillStyle = o.hit ? 'rgba(61,220,151,.26)' : 'rgba(255,255,255,.08)';
    roundRect(ctx, 32, oy, CW - 64, 68, 16);
    ctx.fill();
    ctx.strokeStyle = o.hit ? 'rgba(61,220,151,.85)' : 'rgba(255,255,255,.12)';
    ctx.lineWidth = o.hit ? 2.5 : 1.5;
    ctx.stroke();
    ctx.fillStyle = o.hit ? '#8ef0c8' : 'rgba(255,255,255,.86)';
    ctx.font = (o.hit ? 'bold ' : '') + '26px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(o.t, 58, oy + 35);
    if (o.hit) {
      /* 对勾 */
      ctx.strokeStyle = '#3ddc97';
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(CW - 82, oy + 34);
      ctx.lineTo(CW - 68, oy + 48);
      ctx.lineTo(CW - 44, oy + 18);
      ctx.stroke();
    }
    oy += 84;
  }

  /* 底部：分数条 */
  ctx.fillStyle = 'rgba(255,255,255,.08)';
  roundRect(ctx, 32, 546, CW - 64, 40, 12);
  ctx.fill();
  ctx.fillStyle = '#ffc857';
  ctx.font = 'bold 22px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillText('得分 1580', 52, 567);
  ctx.fillStyle = '#c3b4e8';
  ctx.font = '20px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('连对 5', CW - 52, 567);

  ctx.restore();

  /* ---- 左下角：两个小人抢答（Q 版剪影） ---- */
  function drawPerson(x, y, color, scale) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    /* 身体 */
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-46, 96);
    ctx.quadraticCurveTo(-46, 18, 0, 18);
    ctx.quadraticCurveTo(46, 18, 46, 96);
    ctx.closePath();
    ctx.fill();
    /* 头 */
    ctx.beginPath();
    ctx.arc(0, -12, 34, 0, Math.PI * 2);
    ctx.fill();
    /* 举起的手（抢答） */
    ctx.strokeStyle = color;
    ctx.lineWidth = 15;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(30, 52);
    ctx.lineTo(74, 8);
    ctx.stroke();
    ctx.restore();
  }
  drawPerson(180, 620, '#ff4d8d', 1.05);
  drawPerson(300, 640, '#8b5cf6', 0.92);

  /* 抢答的小气泡（放在两人右上角，别被脑袋压住） */
  ctx.fillStyle = '#ffc857';
  ctx.beginPath();
  ctx.arc(268, 520, 26, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#2a1550';
  ctx.font = 'bold 28px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('!', 268, 520);

  /* ---- 左下角小字 ---- */
  ctx.fillStyle = 'rgba(195,180,232,.72)';
  ctx.font = '19px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('答得快，分更高', 72, 748);

  return cv.toDataURL('image/png');
}, { W, H });

const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
const outPath = path.join(ROOT, 'covers', 'quiz-party.png');
fs.writeFileSync(outPath, buf);
console.log('[gen-cover-quiz-party] 已生成 covers/quiz-party.png  ' + buf.length + ' B  ' + W + '×' + H);

await browser.close();
server.close();
