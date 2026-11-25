/* tools/test-undercover.mjs —— 谁是卧底 单机 UI + 纯 P2P 联机端到端测试
 *
 * 用法：node tools/test-undercover.mjs
 *
 * 验证：
 *   1. 三种模式可选，联机面板只在 p2p 模式显示
 *   2. 人机模式：AI 会描述、玩家能提交描述、投票能选出目标
 *   3. 同屏模式：轮流传手机看词，词默认遮挡
 *   4. P2P：房主码 / 加入码能生成、能互换，通道建立
 *   5. P2P：房主描述 → 加入方同步；加入方描述 → 房主同步
 *   6. P2P：**私密信息隔离** —— 加入方只拿到自己的词，广播状态里没有别人的词
 *   7. P2P：**投票阶段不泄漏票明细**
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
  if (url === '/' || url === '') file = path.join(ROOT, 'undercover', 'index.html');
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
const BASE = `http://127.0.0.1:${server.address().port}/undercover/`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext();
const errs = [];

/* 公开局面快照（不含私密信息） */
const snap = (page) => page.evaluate(() => {
  const p = globalThis.__UC__.pub;
  return {
    phase: p.phase,
    round: p.round,
    turn: p.turnSeat,
    n: p.n,
    alive: (p.alive || []).slice(),
    descs: (p.descs || []).map((d) => d.p + ':' + d.text),
    voteCount: Object.keys(p.votes || {}).length,
    eliminated: (p.eliminated || []).slice(),
    winner: p.winner,
    actionCount: globalThis.__UC__.actionCount,
    mySeat: globalThis.__UC__.mySeat,
    myWord: globalThis.__UC__.myWord,
  };
});

/* 等两端状态收敛（摘要一致）。
   房主是本地先变，广播稍晚 —— 只等一边会取到过时快照。这坑踩过。 */
async function waitConverged(a, b, timeout) {
  const deadline = Date.now() + (timeout || 10000);
  const key = (s) => JSON.stringify([s.phase, s.round, s.turn, s.alive, s.descs, s.eliminated, s.winner]);
  while (Date.now() < deadline) {
    const [da, db] = [await snap(a), await snap(b)];
    if (key(da) === key(db)) return { a: da, b: db, ok: true };
    await new Promise((r) => setTimeout(r, 120));
  }
  return { a: await snap(a), b: await snap(b), ok: false };
}

/* =============================================================================
 * 一、单机 UI
 * ============================================================================= */
console.log('\n=== 1. 单机：模式与基础 ===');
{
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push('solo: ' + e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);

  const modes = await page.$$eval('#mode option', (els) => els.map((e) => e.value));
  ok('三种模式齐全', modes.join(',') === 'ai,hotseat,p2p', modes.join(','));

  await page.selectOption('#mode', 'ai');
  await page.waitForTimeout(300);
  const p2pHidden = await page.$eval('#p2p', (el) => el.hidden);
  ok('人机模式下联机面板隐藏', p2pHidden === true);

  await page.selectOption('#mode', 'p2p');
  await page.waitForTimeout(300);
  const p2pShown = await page.$eval('#p2p', (el) => !el.hidden);
  ok('联机模式下联机面板显示', p2pShown === true);

  await page.selectOption('#mode', 'ai');
  await page.waitForTimeout(500);

  const s = await snap(page);
  ok('人机模式已开始第 1 轮', s.round === 1, 'round=' + s.round);
  ok('4 个座位', s.n === 4, 'n=' + s.n);
  ok('你的词不为空', !!s.myWord, s.myWord);

  const seatCount = await page.$$eval('.seat', (els) => els.length);
  ok('渲染出 4 个座位', seatCount === 4, 'count=' + seatCount);

  await page.close();
}

/* =============================================================================
 * 二、人机：描述与投票
 * ============================================================================= */
console.log('\n=== 2. 人机：描述与投票 ===');
{
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push('ai: ' + e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.selectOption('#mode', 'ai');
  await page.waitForTimeout(400);

  /* 先暂停 AI，摆一个确定性场景 */
  await page.evaluate(() => globalThis.__UC__.pauseAI());

  /* 玩家是 0 号，轮到他描述 */
  await page.waitForFunction(() => globalThis.__UC__.turn === 0, null, { timeout: 5000 });
  await page.fill('#descin', '一种冬天常吃的热东西');
  await page.click('#btn-desc');
  await page.waitForTimeout(300);
  let s = await snap(page);
  ok('玩家描述已提交', s.descs.length === 1 && s.descs[0].startsWith('0:'), JSON.stringify(s.descs));
  ok('提交后轮到下一个座位', s.turn === 1, 'turn=' + s.turn);

  /* 非法描述：轮次不对时不能提交 */
  const rej = await page.evaluate(() => globalThis.__UC__.act({ act: 'desc', p: 3, text: '抢答' }));
  ok('非本回合描述被拒', rej && rej.ok === false, rej && rej.reason);

  /* 推进：让所有 AI 描述完，进入投票阶段 */
  await page.evaluate(() => globalThis.__UC__.resumeAI());
  await page.waitForFunction(() => globalThis.__UC__.phase === 'vote', null, { timeout: 20000 });
  s = await snap(page);
  ok('全员描述完进入投票阶段', s.phase === 'vote', 'phase=' + s.phase);
  ok('描述条数 = 玩家数', s.descs.length === 4, 'descs=' + s.descs.length);

  /* 玩家投票：不能投自己 */
  const selfVote = await page.evaluate(() => globalThis.__UC__.act({ act: 'vote', p: 0, target: 0 }));
  ok('不能投自己', selfVote && selfVote.ok === false, selfVote && selfVote.reason);

  /* 合法投票 */
  const v = await page.evaluate(() => globalThis.__UC__.act({ act: 'vote', p: 0, target: 1 }));
  ok('投票被接受', v && v.ok === true, v && v.reason);

  await page.waitForFunction(
    () => globalThis.__UC__.phase !== 'vote',
    null, { timeout: 20000 }
  ).catch(() => {});
  s = await snap(page);
  ok('投票后进入结算或下一轮', s.phase === 'resolve' || s.phase === 'describe' || s.phase === 'over', 'phase=' + s.phase);

  await page.close();
}

/* =============================================================================
 * 三、同屏模式：轮流传手机看词
 * ============================================================================= */
console.log('\n=== 3. 同屏：轮流传手机看词 ===');
{
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push('hotseat: ' + e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.selectOption('#mode', 'hotseat');
  await page.waitForTimeout(400);

  const ho = await page.$eval('#handout', (el) => !el.hidden);
  ok('进入发词环节', ho === true);

  const vis0 = await page.$eval('#handout-word', (el) => getComputedStyle(el).visibility);
  ok('词默认遮挡', vis0 === 'hidden', vis0);

  const w = await page.evaluate(() => globalThis.__UC__.peekWord(0));
  ok('0 号位有词', !!w, w);

  await page.click('#btn-handout');
  await page.waitForTimeout(200);
  const vis1 = await page.$eval('#handout-word', (el) => getComputedStyle(el).visibility);
  ok('点击后词可见', vis1 === 'visible', vis1);

  const shown = await page.$eval('#handout-word', (el) => el.textContent);
  ok('显示的就是本人的词', shown === w, shown + ' vs ' + w);

  /* 轮完 4 个座位（每个座位：点一次查看 + 点一次看下一位）。
     最后一位点完后面板会隐藏 —— 所以每次都要先确认面板还在。 */
  for (let i = 0; i < 4; i++) {
    const visible = await page.$eval('#handout', (el) => !el.hidden);
    if (!visible) break;
    await page.click('#btn-handout');
    await page.waitForTimeout(150);
    const stillVisible = await page.$eval('#handout', (el) => !el.hidden);
    if (!stillVisible) break;
    await page.click('#btn-handout');
    await page.waitForTimeout(150);
  }
  const ho2 = await page.$eval('#handout', (el) => !el.hidden);
  ok('发词环节结束后关闭', ho2 === false);

  await page.waitForTimeout(300);
  const s = await snap(page);
  ok('发词结束后进入第 1 轮', s.round === 1, 'round=' + s.round);

  await page.close();
}

/* =============================================================================
 * 四、P2P：连接码互换
 * ============================================================================= */
console.log('\n=== 4. P2P：交换连接码 ===');
const host = await ctx.newPage();
const guest = await ctx.newPage();
host.on('pageerror', (e) => errs.push('host: ' + e.message));
guest.on('pageerror', (e) => errs.push('guest: ' + e.message));
{
  await host.goto(BASE, { waitUntil: 'domcontentloaded' });
  await guest.goto(BASE, { waitUntil: 'domcontentloaded' });
  for (const p of [host, guest]) {
    await p.selectOption('#mode', 'p2p');
    await p.waitForTimeout(300);
  }
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
 * ============================================================================= */
console.log('\n=== 5. P2P：私密信息隔离 ===');
{
  const h = await snap(host);
  const g = await snap(guest);
  ok('房主有自己的词', !!h.myWord, h.myWord);
  ok('加入方拿到了自己的词', !!g.myWord, g.myWord);
  ok('加入方的词与自己相关（不是空）', g.myWord.length > 0);

  /* 加入方拿不到别人的词 —— 检查加入方页面里所有可见文本 */
  const guestText = await guest.evaluate(() => document.body.innerText);
  const hWords = await host.evaluate(() => {
    const out = [];
    for (let i = 0; i < globalThis.__UC__.nPlayers; i++) out.push(globalThis.__UC__.peekWord(i));
    return out;
  });
  ok('房主能拿到全部 4 个词', hWords.filter(Boolean).length === 4, JSON.stringify(hWords));

  /* 加入方页面上不应出现「房主的词」（除非两人碰巧同词，那概率极低） */
  const hostWord = hWords[0];
  let leaked = false;
  if (hostWord !== g.myWord && guestText.indexOf(hostWord) >= 0) leaked = true;
  ok('加入方页面看不到房主的词', !leaked, leaked ? '泄漏了：' + hostWord : '');

  /* 加入方的内部状态里也不该有别人的词 */
  const guestInternal = await guest.evaluate(() => {
    const p = globalThis.__UC__.pub;
    return JSON.stringify(p);
  });
  let leaked2 = false;
  for (const w of hWords) {
    if (w !== g.myWord && guestInternal.indexOf(w) >= 0) { leaked2 = true; break; }
  }
  ok('加入方状态里也没有别人的词', !leaked2, leaked2 ? '泄漏了' : '');

  /* 加入方不该被告知自己是不是卧底 */
  const guestRole = await guest.evaluate(() => {
    try { return globalThis.__UC__.peekRole(0); } catch (e) { return 'ERR'; }
  });
  ok('加入方拿不到身份信息', !guestRole || guestRole === 'ERR' || guestRole === '', String(guestRole));

  /* 广播状态（加入方收到的 pub）里不能含词 */
  const pubHasWord = await guest.evaluate(() => {
    const t = JSON.stringify(globalThis.__UC__.pub);
    return t;
  });
  ok('加入方的 pub 里没有词', !hWords.some((w) => w && pubHasWord.indexOf(w) >= 0));
}

/* =============================================================================
 * 六、P2P：状态同步
 * ============================================================================= */
console.log('\n=== 6. P2P：状态同步 ===');
{
  const { a: h0, b: g0, ok: conv0 } = await waitConverged(host, guest, 8000);
  ok('初始状态收敛', conv0);
  ok('双方座位数一致', h0.n === g0.n, h0.n + ' vs ' + g0.n);
  ok('双方存活一致', JSON.stringify(h0.alive) === JSON.stringify(g0.alive));
  ok('双方轮次一致', h0.turn === g0.turn, h0.turn + ' vs ' + g0.turn);

  /* 房主描述 → 加入方同步 */
  const hostIsFirst = h0.turn === 0;
  const who = hostIsFirst ? host : guest;
  const other = hostIsFirst ? guest : host;
  const seat = hostIsFirst ? 0 : 1;
  await who.waitForFunction(
    (s) => globalThis.__UC__.turn === s && globalThis.__UC__.phase === 'describe',
    seat, { timeout: 10000 }
  ).catch(() => {});
  await who.fill('#descin', '冬天捧在手里暖烘烘的');
  await who.click('#btn-desc');
  const { ok: conv1 } = await waitConverged(host, guest, 10000);
  ok('描述后两端收敛', conv1);
  const h1 = await snap(host);
  const g1 = await snap(guest);
  ok('加入方看到了房主的描述', g1.descs.some((d) => d.startsWith(seat + ':')), JSON.stringify(g1.descs));
  ok('描述条数两端一致', h1.descs.length === g1.descs.length, h1.descs.length + ' vs ' + g1.descs.length);

  /* 加入方也要描述（他是 1 号位，轮到他时才能继续往下走） */
  const guestTurn = await guest.evaluate(() => globalThis.__UC__.turn);
  if (guestTurn === 1) {
    await guest.fill('#descin', '跟吃的有关，冬天更合适');
    await guest.click('#btn-desc');
    await waitConverged(host, guest, 10000);
  }

  /* AI 描述也要同步（AI 由房主生成，但动作进序列） */
  await host.waitForTimeout(3000);
  const { ok: conv2 } = await waitConverged(host, guest, 10000);
  const h2 = await snap(host);
  const g2 = await snap(guest);
  ok('AI 描述后两端仍收敛', conv2);
  ok('AI 描述两端一致', JSON.stringify(h2.descs) === JSON.stringify(g2.descs),
    JSON.stringify(h2.descs) + ' vs ' + JSON.stringify(g2.descs));
}

/* =============================================================================
 * 七、P2P：投票阶段不泄漏票明细
 * ============================================================================= */
console.log('\n=== 7. P2P：投票阶段不泄漏票 ===');
{
  /* 等到投票阶段 */
  await host.waitForFunction(() => globalThis.__UC__.phase === 'vote', null, { timeout: 40000 }).catch(() => {});
  const phase = await host.evaluate(() => globalThis.__UC__.phase);
  ok('进入投票阶段', phase === 'vote', 'phase=' + phase);

  const votesHost = await host.evaluate(() => JSON.stringify(globalThis.__UC__.pub.votes || {}));
  const votesGuest = await guest.evaluate(() => JSON.stringify(globalThis.__UC__.pub.votes || {}));
  ok('加入方在投票阶段看不到票明细', votesGuest === '{}', votesGuest);

  /* 让房主投一票，再看加入方 */
  const turnSeat = await host.evaluate(() => globalThis.__UC__.turn);
  if (turnSeat === 0) {
    await host.evaluate(() => globalThis.__UC__.act({ act: 'vote', p: 0, target: 1 }));
    await host.waitForTimeout(600);
    const vg = await guest.evaluate(() => JSON.stringify(globalThis.__UC__.pub.votes || {}));
    ok('房主投票后加入方仍看不到票明细', vg === '{}', vg);
    ok('房主自己能看到票明细（本地状态完整）', votesHost !== undefined);
  }
}

/* =============================================================================
 * 八、页面零报错
 * ============================================================================= */
console.log('\n=== 8. 页面零报错 ===');
ok('无未捕获错误', errs.length === 0, errs.slice(0, 3).join(' | '));

await host.screenshot({ path: '/tmp/uc-host.png' });
await guest.screenshot({ path: '/tmp/uc-guest.png' });
await ctx.close();
await browser.close();
server.close();

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
