/* tools/test-drawguess.mjs —— 你画我猜 单机 UI + 纯 P2P 联机端到端测试
 *
 * 用法：node tools/test-drawguess.mjs
 *
 * 验证：
 *   1. 三种模式可选，联机面板只在 p2p 模式显示
 *   2. 人机模式：AI 会猜，笔画会累积，画师不能自己猜
 *   3. 同屏模式：传手机看词，词默认遮挡，画完能传给下一位
 *   4. P2P：房主码 / 加入码能生成、能互换，通道建立
 *   5. P2P：笔迹能同步（走独立通道，不进动作序列）
 *   6. P2P：**私密信息隔离** —— 猜的人拿不到画师手上的词
 *   7. P2P：猜测由房主判定，两端状态收敛
 *   8. 页面零报错
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
  if (url === '/' || url === '') file = path.join(ROOT, 'drawguess', 'index.html');
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
const BASE = `http://127.0.0.1:${server.address().port}/drawguess/`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext();
const errs = [];

const snap = (page) => page.evaluate(() => {
  const p = globalThis.__DG__.pub;
  return {
    phase: p.phase,
    round: p.round,
    total: p.totalRounds,
    drawer: p.drawer,
    n: p.n,
    scores: (p.scores || []).slice(),
    hits: (p.hits || []).slice(),
    guessCount: p.guessCount,
    word: p.word || '',
    actionCount: globalThis.__DG__.actionCount,
    mySeat: globalThis.__DG__.mySeat,
    myWord: globalThis.__DG__.myWord,
    strokes: globalThis.__DG__.strokes,
    chatLen: globalThis.__DG__.chat.length,
  };
});

async function waitConverged(a, b, timeout) {
  const deadline = Date.now() + (timeout || 10000);
  const key = (s) => JSON.stringify([s.phase, s.round, s.drawer, s.scores, s.hits, s.guessCount]);
  while (Date.now() < deadline) {
    const [da, db] = [await snap(a), await snap(b)];
    if (key(da) === key(db)) return { a: da, b: db, ok: true };
    await new Promise((r) => setTimeout(r, 120));
  }
  return { a: await snap(a), b: await snap(b), ok: false };
}

/* 在画板上画一笔（模拟 pointer 事件）
 *
 * 注意：P2P 面板展开后页面很长，boundingBox() 给的是**文档坐标**，
 * 直接用鼠标点会点到视口外（y 可能是负数），画笔就落不下来。
 * 所以先 scrollIntoView 把画板滚进视口，再取坐标。 */
async function drawStroke(page, from, to) {
  await page.locator('#cv').scrollIntoViewIfNeeded();
  await page.waitForTimeout(120);
  const box = await page.locator('#cv').boundingBox();
  const pt = (x, y) => ({ x: box.x + (x / 900) * box.width, y: box.y + (y / 600) * box.height });
  const a = pt(from[0], from[1]);
  const b = pt(to[0], to[1]);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

/* =============================================================================
 * 一、单机 UI
 * ========================================================================== */
console.log('\n=== 1. 单机：模式与基础 ===');
const solo = await ctx.newPage();
solo.on('pageerror', (e) => errs.push('solo: ' + e.message));
solo.on('console', (m) => { if (m.type() === 'error') errs.push('solo console: ' + m.text()); });
await solo.goto(BASE);
await solo.waitForTimeout(600);

{
  ok('三种模式都在', (await solo.$$eval('#mode option', (o) => o.map((x) => x.value))).join(',') === 'ai,hotseat,p2p');
  ok('联机面板默认隐藏', await solo.locator('#p2p').isHidden());
  const s = await snap(solo);
  ok('人机模式开局进入 draw', s.phase === 'draw', s.phase);
  ok('人机模式画师是 0 号', s.drawer === 0);
  ok('人机模式画师拿到了词', !!s.myWord, s.myWord);
  ok('人机模式 3 个回合', s.total === 3, String(s.total));
  ok('画师看得到自己的词', !(await solo.locator('#myword').isHidden()));
}

/* =============================================================================
 * 二、人机模式：AI 会猜
 * ========================================================================== */
console.log('\n=== 2. 人机：AI 猜词 ===');
{
  /* 画几笔，给 AI 更多猜中机会 */
  await solo.evaluate(() => globalThis.__DG__.pauseAI());
  await drawStroke(solo, [100, 100], [300, 300]);
  await drawStroke(solo, [150, 400], [400, 450]);
  await drawStroke(solo, [500, 200], [700, 350]);
  await solo.evaluate(() => globalThis.__DG__.resumeAI());
  await solo.waitForTimeout(500);
  const s = await snap(solo);
  ok('笔画被记录', s.strokes >= 3, String(s.strokes));

  /* 画师不能自己猜 */
  const rejected = await solo.evaluate(() => globalThis.__DG__.guess('随便猜一个'));
  ok('画师自己猜会被拒绝', rejected === false);

  /* 等 AI 猜 —— AI 猜中后会揭晓 */
  await solo.waitForFunction(() => globalThis.__DG__.chat.length > 0, null, { timeout: 15000 }).catch(() => {});
  const chat = await solo.evaluate(() => globalThis.__DG__.chat);
  ok('AI 产生了猜测', chat.length > 0, JSON.stringify(chat.slice(-2)));
  const hasAI = chat.some((c) => c.html.indexOf('AI') >= 0);
  ok('聊天里有 AI 的发言', hasAI);

  /* 多等一会儿，AI 应该至少猜中一次（概率会随笔画上升） */
  await solo.waitForFunction(() => globalThis.__DG__.pub.phase !== 'draw', null, { timeout: 25000 }).catch(() => {});
  const s2 = await snap(solo);
  ok('AI 猜中后进入揭晓', s2.phase === 'reveal', s2.phase);
  ok('揭晓后答案公开', !!s2.word, s2.word);
  /* AI 猜中 → AI 名下得分。注意不能断言「画师至少一分」——
     AI 有概率第一猜就中，那时画师就是 0 分（那是随机性，不是 bug）。
     「画师守住一分」这条规则由 rules.test.mjs 单独覆盖。 */
  ok('AI 猜中记在 AI 名下', (s2.scores[1] || 0) >= 1, JSON.stringify(s2.scores));
  ok('本回合确实有得分', (s2.scores[0] || 0) + (s2.scores[1] || 0) >= 1, JSON.stringify(s2.scores));
}

/* =============================================================================
 * 三、同屏模式
 * ========================================================================== */
console.log('\n=== 3. 同屏：传手机 ===');
{
  await solo.selectOption('#mode', 'hotseat');
  await solo.waitForTimeout(400);
  ok('同屏模式联机面板仍隐藏', await solo.locator('#p2p').isHidden());
  ok('同屏模式显示传手机面板', !(await solo.locator('#handout').isHidden()));
  const hiddenWord = await solo.locator('#handout-word').innerText();
  ok('词默认遮挡', hiddenWord.indexOf('·') >= 0, hiddenWord);

  await solo.click('#btn-handout');
  await solo.waitForTimeout(200);
  const shown = await solo.locator('#handout-word').innerText();
  ok('点「看看」后显示词', shown.length > 0 && shown.indexOf('·') < 0, shown);
  ok('画完按钮出现', !(await solo.locator('#btn-pass').isHidden()));

  await solo.click('#btn-pass');
  await solo.waitForTimeout(300);
  const st = await solo.evaluate(() => globalThis.__DG__.hotStage);
  ok('进入猜词阶段', st === 'guess', st);
  ok('猜词输入框可用', !(await solo.locator('#guessin').isDisabled()));
}

/* =============================================================================
 * 四、P2P：通道建立
 * ========================================================================== */
console.log('\n=== 4. P2P：通道建立 ===');
const host = await ctx.newPage();
const guest = await ctx.newPage();
host.on('pageerror', (e) => errs.push('host: ' + e.message));
guest.on('pageerror', (e) => errs.push('guest: ' + e.message));
host.on('console', (m) => { if (m.type() === 'error') errs.push('host console: ' + m.text()); });
guest.on('console', (m) => { if (m.type() === 'error') errs.push('guest console: ' + m.text()); });
await host.goto(BASE);
await guest.goto(BASE);
await host.selectOption('#mode', 'p2p');
await guest.selectOption('#mode', 'p2p');
await host.waitForTimeout(300);
{
  ok('联机模式显示联机面板', !(await host.locator('#p2p').isHidden()));

  await host.click('#btn-host');
  await host.waitForTimeout(150);
  await host.click('#btn-gen-host');
  await host.waitForTimeout(2500);
  const hostCode = await host.inputValue('#host-code');
  ok('房主码已生成', hostCode.length > 20, '长度 ' + hostCode.length);

  await guest.click('#btn-join');
  await guest.waitForTimeout(150);
  await guest.fill('#host-in', hostCode);
  await guest.click('#btn-gen-guest');
  await guest.waitForTimeout(2500);
  const guestCode = await guest.inputValue('#guest-code');
  ok('加入码已生成', guestCode.length > 20, '长度 ' + guestCode.length);

  await host.fill('#join-in', guestCode);
  await host.click('#btn-accept');
  const opened = await Promise.all([host, guest].map((p) => p.waitForFunction(
    () => document.getElementById('p2p-state').className.includes('ok'),
    null, { timeout: 20000 }
  ).then(() => true).catch(() => false)));
  ok('房主侧显示已连接', opened[0]);
  ok('加入方侧显示已连接', opened[1]);
}

/* =============================================================================
 * 五、P2P：私密信息隔离（这一款游戏的核心）
 * ========================================================================== */
console.log('\n=== 5. P2P：私密信息隔离 ===');
{
  const h = await snap(host);
  const g = await snap(guest);
  ok('房主是 0 号位', h.mySeat === 0);
  ok('加入方是 1 号位', g.mySeat === 1);
  ok('第一回合房主来画', h.drawer === 0, String(h.drawer));
  ok('房主拿到了词', !!h.myWord, h.myWord);
  ok('加入方拿不到词（他是猜的人）', !g.myWord, g.myWord);
  ok('加入方页面不显示「我的词」', await guest.locator('#myword').isHidden());

  /* 房主的词绝不能出现在加入方的任何可见内容里 */
  const guestText = await guest.evaluate(() => document.body.innerText);
  ok('加入方页面看不到房主的词', guestText.indexOf(h.myWord) < 0, '词：' + h.myWord);

  /* 加入方的内部状态里也不该有 */
  const guestInternal = await guest.evaluate(() => JSON.stringify(globalThis.__DG__.pub));
  ok('加入方状态里也没有房主的词', guestInternal.indexOf(h.myWord) < 0);

  /* 广播出去的 pub 里也不该有 */
  ok('广播状态里没有词', (await snap(guest)).word === '');

  /* 加入方也不能从聊天记录里看到词 */
  ok('加入方聊天里没有词', guestText.indexOf('答案揭晓') < 0 || guestText.indexOf(h.myWord) < 0);
}

/* =============================================================================
 * 六、P2P：笔迹同步（走独立通道）
 * ========================================================================== */
console.log('\n=== 6. P2P：笔迹同步 ===');
{
  const before = await snap(guest);
  await drawStroke(host, [200, 200], [600, 400]);
  await host.waitForTimeout(600);
  const after = await snap(guest);
  ok('加入方收到了笔迹', after.strokes === before.strokes + 1, `${before.strokes} -> ${after.strokes}`);

  /* 笔迹不进动作序列 —— 这是这个游戏的关键设计 */
  const h = await snap(host);
  ok('笔迹没有进权威动作序列', h.actionCount <= 2, '动作数 ' + h.actionCount);
}

/* =============================================================================
 * 七、P2P：猜测判定与状态收敛
 * ========================================================================== */
console.log('\n=== 7. P2P：猜测与状态收敛 ===');
{
  const { a: h0, b: g0, ok: conv0 } = await waitConverged(host, guest, 10000);
  ok('初始状态收敛', conv0);
  ok('双方回合一致', h0.round === g0.round, h0.round + ' vs ' + g0.round);
  ok('双方画师一致', h0.drawer === g0.drawer, h0.drawer + ' vs ' + g0.drawer);

  /* 加入方猜一个错的 —— 房主判定为未命中 */
  await guest.fill('#guessin', '完全不对的词');
  await guest.click('#btn-guess');
  await guest.waitForTimeout(600);
  const { ok: conv1 } = await waitConverged(host, guest, 8000);
  ok('猜错后两端收敛', conv1);
  const h1 = await snap(host);
  ok('猜错不记分', (h1.scores[1] || 0) === 0, JSON.stringify(h1.scores));
  ok('猜错累计了猜测次数', h1.guessCount >= 1, String(h1.guessCount));

  /* 加入方猜中 —— 但加入方不知道词，所以只能靠房主发词后知道。
     这里直接用测试钩子让加入方「猜」房主的词，验证房主判定链路。 */
  const word = h1.myWord;
  const hit = await guest.evaluate((w) => globalThis.__DG__.guess(w), word);
  ok('加入方能提交猜测', hit === true);
  await guest.waitForTimeout(800);
  const { ok: conv2 } = await waitConverged(host, guest, 8000);
  ok('猜中后两端收敛', conv2);
  const h2 = await snap(host);
  ok('猜中记了一分', (h2.scores[1] || 0) === 1, JSON.stringify(h2.scores));
  ok('猜中后进入揭晓', h2.phase === 'reveal', h2.phase);
  ok('揭晓后答案公开', !!h2.word, h2.word);

  /* 揭晓之后词应该公开给双方（这不算泄漏 —— 已经公布了） */
  await host.waitForTimeout(300);
  const g2 = await snap(guest);
  ok('揭晓后加入方也能看到答案', g2.word === h2.word, `${g2.word} vs ${h2.word}`);
}

/* =============================================================================
 * 八、页面零报错
 * ========================================================================== */
console.log('\n=== 8. 页面零报错 ===');
{
  ok('无未捕获错误', errs.length === 0, errs.slice(0, 3).join(' | '));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
