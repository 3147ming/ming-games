/* tools/test-connect4-ui.mjs —— 四子棋单机模式 UI 冒烟测试
 *
 * 用法：node tools/test-connect4-ui.mjs
 *
 * 验证（不涉及联机，联机另有 test-connect4-p2p.mjs）：
 *   1. 三种模式可选，联机面板只在 p2p 模式显示
 *   2. 人机模式：AI 会先落一颗红棋
 *   3. 人机模式：玩家（蓝棋）点某一列，棋子落在该列底部
 *   4. 同屏双人：轮流落子，轮次交替
 *   5. 重力：同一列连续落两颗，第二颗叠在第一颗上面
 *   6. 悔棋：人机模式下退回到可继续落子的状态
 *   7. 页面零报错
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

const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let file;
  if (url === '/' || url === '') file = path.join(ROOT, 'connect4', 'index.html');
  else {
    file = path.join(ROOT, url);
    if (url.endsWith('/') || (fs.existsSync(file) && fs.statSync(file).isDirectory())) file = path.join(file, 'index.html');
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

/* 点某一列：把画布滚进视野，再按列号换算成屏幕坐标点下去 */
async function clickCol(page, col) {
  await page.evaluate(() => document.getElementById('cv').scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(100);
  const inf = await page.evaluate(() => {
    const cv = document.getElementById('cv'); const rect = cv.getBoundingClientRect();
    return { left: rect.left, top: rect.top, scale: rect.width / cv.width };
  });
  const PAD_X = 26, COLS = 7, CELL = (560 - PAD_X * 2) / COLS;
  await page.mouse.click(inf.left + (PAD_X + CELL * (col + 0.5)) * inf.scale, inf.top + 100 * inf.scale);
  await page.waitForTimeout(450);
}
const boardState = (page) => page.evaluate(() => {
  const b = globalThis.__CONNECT4__.board;
  const COLS = 7, ROWS = 6;
  const cells = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) cells.push(b[y * COLS + x]);
  }
  return {
    cells, turn: globalThis.__CONNECT4__.turn,
    moves: globalThis.__CONNECT4__.moves,
    over: globalThis.__CONNECT4__.over,
    turnText: document.getElementById('turn').textContent,
  };
});

try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  console.log('\n=== 1. 模式切换 ===');
  const modeOpts = await page.$$eval('#mode option', (os) => os.map((o) => o.value));
  ok('三种模式齐全', ['ai', 'hotseat', 'p2p'].every((m) => modeOpts.includes(m)), modeOpts.join(','));
  ok('默认人机模式', await page.inputValue('#mode') === 'ai');
  ok('人机模式下联机面板隐藏', !(await page.isVisible('#p2p')));
  await page.selectOption('#mode', 'p2p');
  await page.waitForTimeout(300);
  ok('切到 p2p 后联机面板显示', await page.isVisible('#p2p'));
  await page.selectOption('#mode', 'ai');
  await page.waitForTimeout(800);

  console.log('\n=== 2. 人机模式：AI 先落红棋 ===');
  let st = await boardState(page);
  ok('AI 已落 1 颗（红）', st.moves === 1 && st.cells[5 * 7 + 3] === 1, 'moves=' + st.moves);
  ok('轮到蓝棋', st.turn === 2 && st.turnText.includes('蓝棋'), st.turnText);

  console.log('\n=== 3. 人机模式：玩家点列落蓝棋 ===');
  await clickCol(page, 2);
  st = await boardState(page);
  /* AI 会立刻应手，所以玩家这一手之后手数是 3（红AI/蓝玩家/红AI）。 */
  ok('手数变成 3（玩家 1 手 + AI 2 手）', st.moves === 3, 'moves=' + st.moves);
  ok('蓝棋落在第 2 列底部', st.cells[5 * 7 + 2] === 2, 'cell=' + st.cells[5 * 7 + 2]);
  ok('轮到蓝棋（等玩家再落）', st.turn === 2, st.turnText);

  console.log('\n=== 4. 同屏双人：轮流落子 ===');
  await page.selectOption('#mode', 'hotseat');
  await page.waitForTimeout(500);
  st = await boardState(page);
  ok('新局清空', st.moves === 0, 'moves=' + st.moves);
  await clickCol(page, 0);
  st = await boardState(page);
  ok('第一手是红棋', st.cells[5 * 7 + 0] === 1 && st.turn === 2);
  await clickCol(page, 1);
  st = await boardState(page);
  ok('第二手是蓝棋', st.cells[5 * 7 + 1] === 2 && st.turn === 1);

  console.log('\n=== 5. 重力：同列第二颗叠在上面 ===');
  await clickCol(page, 0);
  st = await boardState(page);
  ok('第 0 列叠两颗', st.cells[5 * 7 + 0] === 1 && st.cells[4 * 7 + 0] === 1,
    JSON.stringify([st.cells[5 * 7 + 0], st.cells[4 * 7 + 0]]));

  console.log('\n=== 6. 悔棋 ===');
  await page.click('#undo');
  await page.waitForTimeout(300);
  st = await boardState(page);
  ok('悔棋后少一颗', st.cells[4 * 7 + 0] === 0, 'cell=' + st.cells[4 * 7 + 0]);
  ok('手数回退', st.moves === 2, 'moves=' + st.moves);

  console.log('\n=== 7. 列满后拒绝落子 ===');
  /* 往第 6 列连下 6 颗（同屏双人交替红蓝），第 7 颗应被拒绝 */
  for (let i = 0; i < 6; i++) await clickCol(page, 6);
  st = await boardState(page);
  const colFull = [0, 1, 2, 3, 4, 5].every((y) => st.cells[y * 7 + 6] !== 0);
  ok('第 6 列已满', colFull);
  const before = st.moves;
  await clickCol(page, 6);
  st = await boardState(page);
  ok('满列无法再落子', st.moves === before, before + ' → ' + st.moves);

  console.log('\n=== 8. 页面零报错 ===');
  ok('无未捕获错误', errs.length === 0, errs.slice(0, 3).join(' | '));

  await page.screenshot({ path: '/tmp/connect4-ui.png' });
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
