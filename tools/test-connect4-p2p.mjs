/* tools/test-connect4-p2p.mjs —— 四子棋纯 P2P 联机端到端测试
 *
 * 用法：node tools/test-connect4-p2p.mjs
 *
 * 两个页面（房主 / 加入方）通过手动交换连接码建立 WebRTC 通道，
 * 然后各落一子，验证：
 *   1. 房主码 / 加入码能生成、能互换
 *   2. 通道建立后状态条变「已连接」
 *   3. 房主落子 → 加入方棋盘同步出现该子
 *   4. 加入方落子 → 房主棋盘同步出现该子
 *   5. 双方手数一致
 *   6. 终局判定一致（蓝棋四连后双方都显示蓝棋胜）
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

/* ---------- 静态服务：把 connect4 与 src/net 直接喂给浏览器 ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  /* 页面挂在 /connect4/ 下，这样它自己的相对路径（./src/main.mjs）
     和跨目录的 ../../src/net/p2p.js 都能按真实目录结构解析。 */
  let file;
  if (url === '/' || url === '') {
    file = path.join(ROOT, 'connect4', 'index.html');
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
const BASE = `http://127.0.0.1:${server.address().port}/connect4/`;

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
  /* 四子棋是竖盘：点某一列即可，棋子掉到该列底部。
     列 3 居中，避开了角上不好点的位置。 */
  const clickCol = async (p, col) => {
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
    const PAD_X = 26, COLS = 7, CELL = (560 - PAD_X * 2) / COLS;
    await p.mouse.click(inf.left + (PAD_X + CELL * (col + 0.5)) * inf.scale, inf.top + 100 * inf.scale);
    await p.waitForTimeout(500);
  };

  await clickCol(host, 0);
  await host.waitForTimeout(700);
  const guestMoves1 = await guest.evaluate(() => document.getElementById('moves').textContent);
  ok('加入方收到房主的落子', guestMoves1 === '1', '加入方手数=' + guestMoves1);

  console.log('\n=== 6. 加入方落子 → 房主同步 ===');
  await clickCol(guest, 6);
  await guest.waitForTimeout(800);
  const hostMoves2 = await host.evaluate(() => document.getElementById('moves').textContent);
  const guestMoves2 = await guest.evaluate(() => document.getElementById('moves').textContent);
  ok('房主收到加入方的落子', hostMoves2 === '2', '房主手数=' + hostMoves2);
  ok('双方手数一致', hostMoves2 === guestMoves2, hostMoves2 + ' vs ' + guestMoves2);

  console.log('\n=== 7. 重力下落正确（同一列叠两颗）===');
  /* 房主再往第 0 列落一颗 —— 该列已有 1 颗（y=5），新的应该落在 y=4。 */
  await clickCol(host, 0);
  await host.waitForTimeout(700);
  const stack = await guest.evaluate(() => {
    const b = globalThis.__CONNECT4__.board;
    const COLS = 7, ROWS = 6;
    /* 找出第 0 列所有非空格子的行号 */
    const rows = [];
    for (let y = 0; y < ROWS; y++) if (b[y * COLS + 0] !== 0) rows.push(y);
    return rows;
  });
  ok('第 0 列叠了两颗且在底部', stack.length === 2 && stack[0] === 4 && stack[1] === 5, JSON.stringify(stack));

  console.log('\n=== 8. 终局判定一致（蓝棋四连）===');
  /* 房主红棋，加入方蓝棋，严格交替落子（红先）。
     竖盘重力下落 —— 想让蓝棋横向四连，这 4 列的**同一行**必须都放得下蓝棋。
     已用掉的列：第 0 列被红棋占了 2 颗（y=5,4），第 6 列蓝棋 1 颗（y=5）。
     于是蓝棋的目标是第 3/4/5/6 列在 y=5 这一行：
       蓝: 6列(y5) 已有 → 再补 5列(y5)、4列(y5)、3列(y5) 即四连。
     红棋的落子必须避开第 3/4/5 列，且不能自己先连成四：
       红: 0列(y5)、0列(y4)、1列(y5)、1列(y4)、2列(y5)
     红棋只在第 0/1/2 列，且每列不超过 2 颗 → 竖向也连不成四。 */
  const plan = [
    ['host', 1], ['guest', 5],
    ['host', 1], ['guest', 4],
    ['host', 2], ['guest', 3],
  ];
  for (const [who, col] of plan) {
    await clickCol(who === 'host' ? host : guest, col);
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
  ok('房主判定蓝棋胜', hEnd.over && hEnd.title === '蓝棋胜', JSON.stringify(hEnd));
  ok('加入方判定蓝棋胜', gEnd.over && gEnd.title === '蓝棋胜', JSON.stringify(gEnd));
  ok('双方手数一致', hEnd.moves === gEnd.moves, hEnd.moves + ' vs ' + gEnd.moves);

  console.log('\n=== 9. 页面零报错 ===');
  ok('无未捕获错误', errs.length === 0, errs.slice(0, 3).join(' | '));

  await host.screenshot({ path: '/tmp/connect4-p2p-host.png' });
  await guest.screenshot({ path: '/tmp/connect4-p2p-guest.png' });
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
