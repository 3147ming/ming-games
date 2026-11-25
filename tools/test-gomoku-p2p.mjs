/* tools/test-gomoku-p2p.mjs —— 五子棋纯 P2P 联机端到端测试
 *
 * 用法：node tools/test-gomoku-p2p.mjs
 *
 * 两个页面（房主 / 加入方）通过手动交换连接码建立 WebRTC 通道，
 * 然后各落一子，验证：
 *   1. 房主码 / 加入码能生成、能互换
 *   2. 通道建立后状态条变「已连接」
 *   3. 房主落子 → 加入方棋盘同步出现该子
 *   4. 加入方落子 → 房主棋盘同步出现该子
 *   5. 双方手数一致
 *   6. 终局判定一致（白棋五连后双方都显示白棋胜）
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/root/.nvm/versions/node/v22.13.1/lib/node_modules/playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra !== undefined ? '  ' + extra : ''}`);
  cond ? pass++ : fail++;
};

/* ---------- 静态服务：把 gomoku 与 src/net 直接喂给浏览器 ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  /* 页面挂在 /gomoku/ 下，这样它自己的相对路径（./src/main.mjs）
     和跨目录的 ../../src/net/p2p.js 都能按真实目录结构解析。 */
  let file;
  if (url === '/' || url === '') {
    file = path.join(ROOT, 'gomoku', 'index.html');
  } else {
    file = path.join(ROOT, url);
    /* 结尾是 / 的补 index.html；拼出来是目录也补。 */
    if (url.endsWith('/') || (fs.existsSync(file) && fs.statSync(file).isDirectory())) {
      file = path.join(file, 'index.html');
    }
  }
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('404 ' + url); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/gomoku/`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });

try {
  const ctx = await browser.newContext();
  const host = await ctx.newPage();
  const guest = await ctx.newPage();
  const errs = [];
  host.on('pageerror', (e) => errs.push('host: ' + e.message));
  guest.on('pageerror', (e) => errs.push('guest: ' + e.message));

  await host.goto(BASE, { waitUntil: 'domcontentloaded' });
  await guest.goto(BASE, { waitUntil: 'domcontentloaded' });
  await host.waitForTimeout(1200);

  console.log('\n=== 1. 切到 P2P 模式 ===');
  for (const p of [host, guest]) {
    await p.selectOption('#mode', 'p2p');
    await p.waitForTimeout(300);
  }
  const panelVisible = await host.isVisible('#p2p');
  ok('联机面板显示', panelVisible);

  console.log('\n=== 2. 房主生成房主码 ===');
  await host.click('#btn-host');
  await host.waitForTimeout(200);
  await host.click('#btn-gen-host');
  await host.waitForTimeout(2500);
  const hostCode = await host.inputValue('#host-code');
  ok('房主码已生成', hostCode.length > 20, '长度 ' + hostCode.length);
  ok('房主码以 M/P 开头', /^M|^P/.test(hostCode), hostCode.slice(0, 1));

  console.log('\n=== 3. 加入方用房主码生成加入码 ===');
  await guest.click('#btn-join');
  await guest.waitForTimeout(200);
  await guest.fill('#host-in', hostCode);
  await guest.click('#btn-gen-guest');
  await guest.waitForTimeout(2500);
  const guestCode = await guest.inputValue('#guest-code');
  ok('加入码已生成', guestCode.length > 20, '长度 ' + guestCode.length);

  console.log('\n=== 4. 房主接受加入码 → 建立通道 ===');
  await host.fill('#join-in', guestCode);
  await host.click('#btn-accept');
  /* 等通道打开 */
  const opened = await Promise.all([host, guest].map((p) => p.waitForFunction(
    () => document.getElementById('p2p-state').className.includes('ok'),
    null, { timeout: 20000 }
  ).then(() => true).catch(() => false)));
  ok('房主侧显示已连接', opened[0]);
  ok('加入方侧显示已连接', opened[1]);

  console.log('\n=== 5. 房主落子 → 加入方同步 ===');
  const info = await host.evaluate(() => {
    const cv = document.getElementById('cv'); const rect = cv.getBoundingClientRect();
    return { left: rect.left, top: rect.top, scale: rect.width / cv.width };
  });
  const PAD = 22, SIZE = 15, CELL = (600 - PAD * 2) / (SIZE - 1);
  const clickAt = async (p, gx, gy) => {
    /* 联机面板展开后页面很长，Playwright 的操作会把页面滚到下面 ——
       直接按视口坐标点会点到屏幕外（甚至负数坐标），必须先把棋盘滚进视野。 */
    await p.evaluate(() => {
      const cv = document.getElementById('cv');
      cv.scrollIntoView({ block: 'center', inline: 'center' });
    });
    await p.waitForTimeout(120);
    const inf = await p.evaluate(() => {
      const cv = document.getElementById('cv'); const rect = cv.getBoundingClientRect();
      return { left: rect.left, top: rect.top, scale: rect.width / cv.width };
    });
    await p.mouse.click(inf.left + (PAD + gx * CELL) * inf.scale, inf.top + (PAD + gy * CELL) * inf.scale);
    await p.waitForTimeout(500);
  };

  await clickAt(host, 7, 7);
  await host.waitForTimeout(700);
  const guestMoves1 = await guest.evaluate(() => document.getElementById('moves').textContent);
  ok('加入方收到房主的落子', guestMoves1 === '1', '加入方手数=' + guestMoves1);

  console.log('\n=== 6. 加入方落子 → 房主同步 ===');
  await clickAt(guest, 8, 8);
  await guest.waitForTimeout(800);
  const hostMoves2 = await host.evaluate(() => document.getElementById('moves').textContent);
  const guestMoves2 = await guest.evaluate(() => document.getElementById('moves').textContent);
  ok('房主收到加入方的落子', hostMoves2 === '2', '房主手数=' + hostMoves2);
  ok('双方手数一致', hostMoves2 === guestMoves2, hostMoves2 + ' vs ' + guestMoves2);

  console.log('\n=== 7. 终局判定一致（白棋五连）===');
  /* 房主黑，加入方白。严格交替下白棋落在第 2,4,6,8,10 手。
     第 5、6 步已经用过 (7,7) 和 (8,8)，所以这局改在另一行（第 9 行）做五连，
     避免和前面的落子互相干扰。 */
  const plan = [
    ['host', 2, 9], ['guest', 6, 9],
    ['host', 3, 9], ['guest', 7, 9],
    ['host', 4, 9], ['guest', 8, 9],
    ['host', 5, 9], ['guest', 9, 9],
    ['host', 12, 9], ['guest', 10, 9],
  ];
  for (const [who, x, y] of plan) {
    await clickAt(who === 'host' ? host : guest, x, y);
    await host.waitForTimeout(250);
  }
  await host.waitForTimeout(1200);
  const hEnd = await host.evaluate(() => ({
    over: document.getElementById('end').classList.contains('show'),
    title: document.getElementById('endtitle').textContent,
    moves: document.getElementById('moves').textContent,
  }));
  const gEnd = await guest.evaluate(() => ({
    over: document.getElementById('end').classList.contains('show'),
    title: document.getElementById('endtitle').textContent,
    moves: document.getElementById('moves').textContent,
  }));
  ok('房主判定白棋胜', hEnd.over && hEnd.title === '白棋胜', JSON.stringify(hEnd));
  ok('加入方判定白棋胜', gEnd.over && gEnd.title === '白棋胜', JSON.stringify(gEnd));
  ok('双方手数一致', hEnd.moves === gEnd.moves, hEnd.moves + ' vs ' + gEnd.moves);

  console.log('\n=== 8. 页面零报错 ===');
  ok('无未捕获错误', errs.length === 0, errs.slice(0, 3).join(' | '));

  await host.screenshot({ path: '/tmp/gomoku-p2p-host.png' });
  await guest.screenshot({ path: '/tmp/gomoku-p2p-guest.png' });
  await ctx.close();
} catch (e) {
  console.error('测试执行异常：', e);
  fail++;
} finally {
  await browser.close();
  server.close();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
