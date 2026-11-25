/* tools/gen-cover-party-tools.mjs —— 用浏览器 canvas 画「聚会工具箱」大厅封面
 *
 * 用法：node tools/gen-cover-party-tools.mjs
 * 输出：covers/party-tools.png（1280×800）
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

  /* 底：暖色渐变 */
  const bg = ctx.createRadialGradient(W * 0.42, H * 0.3, 40, W * 0.5, H * 0.5, W * 0.8);
  bg.addColorStop(0, '#40301f');
  bg.addColorStop(0.55, '#251a11');
  bg.addColorStop(1, '#130e0a');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  /* ---- 右侧：转盘 ---- */
  const cx = W * 0.74, cy = H * 0.52, R = 210;
  const segs = 8;
  const cols = ['#c8963e', '#7ee0c0', '#ff9f9f', '#a89ae6', '#8ff0b5', '#f0a76e', '#6fc2ef', '#e8b45a'];
  for (let i = 0; i < segs; i++) {
    const a0 = -Math.PI / 2 + i * (Math.PI * 2 / segs);
    const a1 = a0 + Math.PI * 2 / segs;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, a0, a1); ctx.closePath();
    ctx.fillStyle = cols[i]; ctx.fill();
    ctx.strokeStyle = 'rgba(20,14,8,.45)'; ctx.lineWidth = 2; ctx.stroke();
  }
  ctx.beginPath(); ctx.arc(cx, cy, 40, 0, Math.PI * 2);
  ctx.fillStyle = '#241b10'; ctx.fill();
  ctx.strokeStyle = '#c8963e'; ctx.lineWidth = 5; ctx.stroke();
  /* 指针 */
  ctx.beginPath();
  ctx.moveTo(cx, cy - R - 22); ctx.lineTo(cx - 16, cy - R - 4); ctx.lineTo(cx + 16, cy - R - 4);
  ctx.closePath(); ctx.fillStyle = '#e6cf9d'; ctx.fill();

  /* ---- 左下：骰子 ---- */
  const dx = 300, dy = 560, ds = 128;
  ctx.save();
  ctx.translate(dx, dy); ctx.rotate(-0.22);
  const dg = ctx.createLinearGradient(0, -ds / 2, 0, ds / 2);
  dg.addColorStop(0, '#fbf4e4'); dg.addColorStop(1, '#cbb894');
  roundRect(ctx, -ds / 2, -ds / 2, ds, ds, 22);
  ctx.fillStyle = dg; ctx.fill();
  ctx.strokeStyle = '#8a6a3a'; ctx.lineWidth = 5; ctx.stroke();
  /* 点点 */
  ctx.fillStyle = '#b23a2e';
  const pips = [[-1, -1], [1, 1]];
  pips.forEach(([px, py]) => {
    ctx.beginPath();
    ctx.arc(px * ds * 0.2, py * ds * 0.2, 11, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();

  /* ---- 左侧标题 ---- */
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.font = '700 96px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
  const grad = ctx.createLinearGradient(86, 0, 86, 110);
  grad.addColorStop(0, '#f6e2b4'); grad.addColorStop(1, '#c8a96b');
  ctx.fillStyle = grad;
  ctx.fillText('聚会工具箱', 86, 300);

  ctx.font = '500 34px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
  ctx.fillStyle = 'rgba(232,201,138,.86)';
  ctx.fillText('分组 · 骰子 · 转盘 · 抽签 · 计分', 92, 356);

  /* 标签 */
  const tags = ['离线可用', '不用登录', '数据只存本机'];
  ctx.font = '600 23px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
  let tx = 92;
  tags.forEach((t) => {
    const tw = ctx.measureText(t).width;
    roundRect(ctx, tx, 392, tw + 32, 42, 21);
    ctx.fillStyle = 'rgba(200,169,107,.14)'; ctx.fill();
    ctx.strokeStyle = 'rgba(200,169,107,.45)'; ctx.lineWidth = 1.6; ctx.stroke();
    ctx.fillStyle = '#e6cf9d';
    ctx.fillText(t, tx + 16, 420);
    tx += tw + 32 + 12;
  });

  /* 底部一行 */
  ctx.font = '500 24px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
  ctx.fillStyle = 'rgba(226,214,190,.6)';
  ctx.fillText('聚会前打开就能用 · 名单和分数都不上传', 92, 700);

  return cv.toDataURL('image/png');
}, { W, H });

await browser.close();
server.close();

const outPath = path.join(ROOT, 'covers', 'party-tools.png');
const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
fs.writeFileSync(outPath, buf);
console.log('[gen-cover-party-tools] 已生成 covers/party-tools.png  ' + buf.length + ' B');
