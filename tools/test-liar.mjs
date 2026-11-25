/* tools/test-liar.mjs —— 骗子酒馆（吹牛骰子）单机 UI + 纯 P2P 联机端到端测试
 *
 * 用法：node tools/test-liar.mjs
 *
 * 验证：
 *   1. 人机模式：能开局、AI 会叫牌、能质疑、掉骰、出局判定
 *   2. P2P：房主码 / 加入码能生成、能互换，通道建立
 *   3. P2P：**私密信息隔离** —— 双方都看不到对方的骰子点数
 *   4. P2P：**commit-reveal** —— 承诺值公开但反推不出点数
 *   5. P2P：叫牌 → 质疑 → 揭示 → 结算，两端状态收敛
 *   6. P2P：**加入方能核对房主的结算**（房主谎报 actual 会被发现）
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
  if (url === '/' || url === '') file = path.join(ROOT, 'liar', 'index.html');
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
const BASE = `http://127.0.0.1:${server.address().port}/liar/`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext();
const errs = [];

const snap = (page) => page.evaluate(() => {
  const p = globalThis.__LIAR__.pub;
  return {
    phase: p.phase,
    turn: p.turn,
    round: p.round,
    counts: (p.counts || []).slice(),
    out: (p.out || []).slice(),
    commits: (p.commits || []).slice(),
    lastBid: p.lastBid ? { n: p.lastBid.n, v: p.lastBid.v, p: p.lastBid.p } : null,
    doubter: p.doubter,
    actual: p.actual,
    liar: p.liar,
    loser: p.loser,
    winner: p.winner,
    dice: (p.dice || []).slice(),
    actionCount: globalThis.__LIAR__.actionCount,
    myDice: globalThis.__LIAR__.myDice,
    myCommit: globalThis.__LIAR__.myCommit,
    peerDice: globalThis.__LIAR__.peerDice,
  };
});

/* 核对结论单独放在 #verdict 里（不跟 #msg 抢位置） */
const verdict = (page) => page.evaluate(() => {
  const el = document.getElementById('verdict');
  return el && !el.hidden ? el.textContent : '';
});

async function waitConverged(a, b, timeout) {
  const deadline = Date.now() + (timeout || 10000);
  const key = (s) => JSON.stringify([s.phase, s.turn, s.counts, s.out, s.lastBid, s.actual, s.loser, s.winner]);
  while (Date.now() < deadline) {
    const [da, db] = [await snap(a), await snap(b)];
    if (key(da) === key(db)) return { a: da, b: db, ok: true };
    await new Promise((r) => setTimeout(r, 120));
  }
  return { a: await snap(a), b: await snap(b), ok: false };
}

/* =============================================================================
 * 一、单机人机
 * ========================================================================== */
console.log('\n=== 1. 单机：人机对局 ===');
const solo = await ctx.newPage();
solo.on('pageerror', (e) => errs.push('solo: ' + e.message));
solo.on('console', (m) => { if (m.type() === 'error') errs.push('solo console: ' + m.text()); });
await solo.goto(BASE);
await solo.waitForTimeout(600);

{
  const s = await snap(solo);
  /* 人机模式开局就把三个人的承诺都发了（AI 也要承诺），
     所以快照时通常已经在叫牌阶段 —— 断言放宽到 commit/bid 都算过。 */
  ok('开局进入 commit 或 bid 阶段', s.phase === 'commit' || s.phase === 'bid', s.phase);
  ok('3 人每人 3 颗骰', s.counts.length === 3 && s.counts[0] === 3);
  ok('我拿到了自己的骰子', s.myDice.length === 3, JSON.stringify(s.myDice));
  ok('承诺值非空', !!s.myCommit);
  ok('联机面板默认隐藏', await solo.locator('#p2p').isHidden());

  /* 承诺齐了 → 进入叫牌阶段 */
  await solo.waitForFunction(() => globalThis.__LIAR__.pub.phase === 'bid', null, { timeout: 5000 }).catch(() => {});
  const s2 = await snap(solo);
  ok('承诺齐了进入叫牌', s2.phase === 'bid', s2.phase);
  ok('承诺值都公开了', s2.commits.every((c) => !!c), JSON.stringify(s2.commits));

  /* 我能叫牌 —— 注意要**立刻**取快照：
     等 2.5 秒的话 AI 可能已经抢着叫牌甚至质疑结算，lastBid 就被清掉了。 */
  const bidRes = await solo.evaluate(() => {
    const ok = globalThis.__LIAR__.bid(1, 3);
    const lb = globalThis.__LIAR__.pub.lastBid;
    /* 叫牌必须比上一手大 —— 紧接着用同一个牌面再叫一次，应该被拒 */
    const bad = globalThis.__LIAR__.bid(lb ? lb.n : 1, lb ? lb.v : 2);
    return { ok, lb: lb ? { n: lb.n, v: lb.v, p: lb.p } : null, bad };
  });
  ok('能叫牌', bidRes.ok === true);
  ok('叫牌后有牌面记录', !!bidRes.lb, JSON.stringify(bidRes.lb));
  ok('重复的牌被拒绝', bidRes.bad === false);
}

/* =============================================================================
 * 二、P2P：通道建立
 * ========================================================================== */
console.log('\n=== 2. P2P：通道建立 ===');
const host = await ctx.newPage();
const guest = await ctx.newPage();
host.on('pageerror', (e) => errs.push('host: ' + e.message));
guest.on('pageerror', (e) => errs.push('guest: ' + e.message));
host.on('console', (m) => { if (m.type() === 'error') errs.push('host console: ' + m.text()); });
guest.on('console', (m) => { if (m.type() === 'error') errs.push('guest console: ' + m.text()); });
await host.goto(BASE);
await guest.goto(BASE);
await host.click('#mode-p2p');
await guest.click('#mode-p2p');
await host.waitForTimeout(300);

{
  ok('联机模式显示联机面板', !(await host.locator('#p2p').isHidden()));
  ok('联机局是 2 人', (await snap(host)).counts.length === 2);

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
 * 三、P2P：私密信息隔离（这个游戏的核心）
 * ========================================================================== */
console.log('\n=== 3. P2P：私密信息隔离 ===');
{
  const h = await snap(host);
  const g = await snap(guest);
  ok('房主有自己的骰子', h.myDice.length === 3, JSON.stringify(h.myDice));
  ok('加入方有自己的骰子', g.myDice.length === 3, JSON.stringify(g.myDice));
  ok('房主拿不到对方的骰子', h.peerDice === null, JSON.stringify(h.peerDice));
  ok('加入方拿不到对方的骰子', g.peerDice === null, JSON.stringify(g.peerDice));

  /* 承诺值是公开的，但绝不能反推出点数 */
  ok('房主承诺值公开', !!h.commits[0] && !!h.commits[1], JSON.stringify(h.commits));
  ok('加入方承诺值公开', !!g.commits[0] && !!g.commits[1]);

  /* 房主的骰子点数不能出现在加入方的任何状态里 */
  const guestState = await guest.evaluate(() => JSON.stringify({
    pub: globalThis.__LIAR__.pub,
    mine: globalThis.__LIAR__.myDice,
  }));
  const hDiceStr = h.myDice.join(',');
  /* 用「点数组合」这种连续串来找，比逐个数字找更准（避免误命中状态里的其他数字） */
  ok('加入方状态里没有房主的骰子点数组合', guestState.indexOf(hDiceStr) < 0, hDiceStr);

  /* 承诺值本身不等于点数 —— 换成别的骰子哈希就不同 */
  const hashProbe = await guest.evaluate(() => globalThis.__LIAR__.myCommit);
  ok('双方承诺值不同', h.myCommit !== g.myCommit);
  /* 承诺值是哈希，不该包含点数序列本身。
     （注意别用「承诺值里不含某个数字字符」来断言 —— 哈希是 hex，
       '4' 这种字符本来就会随机出现，会误判。） */
  ok('承诺值里不含点数序列', hashProbe.indexOf(g.myDice.join(',')) < 0, hashProbe);
  ok('承诺值长度是固定的哈希长度', hashProbe.length === 16, hashProbe);
}

/* =============================================================================
 * 四、P2P：叫牌 → 质疑 → 揭示 → 结算
 * ========================================================================== */
console.log('\n=== 4. P2P：完整一局 ===');
{
  /* 等双方承诺齐 → 进入叫牌 */
  await host.waitForFunction(() => globalThis.__LIAR__.pub.phase === 'bid', null, { timeout: 8000 }).catch(() => {});
  await guest.waitForFunction(() => globalThis.__LIAR__.pub.phase === 'bid', null, { timeout: 8000 }).catch(() => {});
  const { ok: conv0 } = await waitConverged(host, guest, 8000);
  ok('初始状态收敛', conv0);
  const s0 = await snap(host);
  ok('进入叫牌阶段', s0.phase === 'bid', s0.phase);
  ok('轮到我（房主）叫牌', s0.turn === 0, String(s0.turn));

  /* 房主叫牌 */
  await host.evaluate(() => globalThis.__LIAR__.bid(2, 4));
  await guest.waitForFunction(() => globalThis.__LIAR__.pub.turn === 1, null, { timeout: 8000 }).catch(() => {});
  const { ok: conv1 } = await waitConverged(host, guest, 8000);
  ok('叫牌后两端收敛', conv1);
  const s1 = await snap(host);
  ok('牌面同步了', !!s1.lastBid, JSON.stringify(s1.lastBid));
  ok('轮到加入方', s1.turn === 1, String(s1.turn));

  /* 加入方质疑 —— 这一步会触发 commit-reveal */
  await guest.evaluate(() => globalThis.__LIAR__.doubt());
  await host.waitForFunction(() => globalThis.__LIAR__.pub.actual >= 0, null, { timeout: 15000 }).catch(() => {});
  await guest.waitForFunction(() => globalThis.__LIAR__.pub.actual >= 0, null, { timeout: 15000 }).catch(() => {});
  await host.waitForTimeout(800);

  const { ok: conv2 } = await waitConverged(host, guest, 10000);
  ok('结算后两端收敛', conv2);
  const h2 = await snap(host);
  const g2 = await snap(guest);
  ok('实际点数算出来了', h2.actual >= 0, String(h2.actual));
  ok('两端实际点数一致', h2.actual === g2.actual, h2.actual + ' vs ' + g2.actual);
  ok('骰子被揭示了', h2.dice.length === 2, JSON.stringify(h2.dice));
  ok('揭示的骰子两端一致', JSON.stringify(h2.dice) === JSON.stringify(g2.dice));
  ok('有人掉了一颗骰', h2.counts[0] < 3 || h2.counts[1] < 3, JSON.stringify(h2.counts));

  /* 加入方核对房主的结算 —— 核对结论在 #verdict 里 */
  const guestVerdict = await verdict(guest);
  ok('加入方核对通过了房主的结算', guestVerdict.indexOf('核对通过') >= 0 || guestVerdict.indexOf('作弊') >= 0, guestVerdict);
  ok('加入方没有报作弊', guestVerdict.indexOf('作弊') < 0, guestVerdict);
}

/* =============================================================================
 * 五、P2P：房主谎报结算会被加入方发现
 * ========================================================================== */
console.log('\n=== 5. P2P：房主作弊会被发现 ===');
{
  /* 直接给加入方注入一条「房主谎报」的结算消息，模拟房主机被攻破 */
  const caught = await guest.evaluate(async () => {
    const s = globalThis.__LIAR__.session;
    const my = globalThis.__LIAR__.myDice;
    /* 造一条 actual 明显不对的结算（模拟房主机被攻破后乱报） */
    s._emit('message', {
      t: 'liar-resolve',
      bidN: 3, bidV: 6, bidP: 0,
      doubter: 1,
      actual: 99,          /* 谎报 */
      liar: false,
      loser: 1,
      dice: [[1, 1, 1], my.slice()],
      countsAfter: globalThis.__LIAR__.pub.counts.slice(),
      commits: globalThis.__LIAR__.pub.commits.slice(),
      saltSelf: 'x',       /* 假 salt —— 哈希验不过 */
      saltPeer: 'y',
    });
    await new Promise((r) => setTimeout(r, 300));
    const el = document.getElementById('verdict');
    return el && !el.hidden ? el.textContent : '';
  });
  ok('加入方发现了房主谎报', caught.indexOf('作弊') >= 0 || caught.indexOf('对不上') >= 0, caught);
}

/* =============================================================================
 * 五之二：房主谎报**点数**也会被发现
 *   这是这个游戏最核心的防线 —— 房主如果谎报 actual，
 *   加入方必须能用自己的骰子底稿重算出来。
 * ========================================================================== */
console.log('\n=== 5b. P2P：房主谎报点数会被发现 ===');
{
  /* 这一轮房主把 actual 改大 —— 叫牌、骰子、承诺全都对得上，
     只有 actual 是假的。这是最难发现的一种作弊。 */
  const caught = await guest.evaluate(async () => {
    const L = globalThis.__LIAR__;
    const s = L.session;
    /* 取出本地底稿：进揭示阶段时记下的承诺、颗数、叫牌 */
    const snap = L.revealSnapshot ? L.revealSnapshot() : null;
    /* 造一条「其他都对、只有 actual 被改了」的结算 ——
       这是最难发现的一种作弊：叫牌、骰子、承诺、salt 全是真的，
       只有房主报出来的点数是假的。 */
    const myDice = snap && snap.dice ? snap.dice : L.myDice;
    const pDice = snap && snap.peerDice ? snap.peerDice : [2, 2, 2];
    s._emit('message', {
      t: 'liar-resolve',
      bidN: snap ? snap.bid.n : 2, bidV: snap ? snap.bid.v : 4, bidP: snap ? snap.bid.p : 0,
      doubter: snap ? snap.doubter : 1,
      actual: 99,            /* 谎报 */
      liar: false,
      loser: 1,
      dice: [pDice, myDice],  /* 骰子是真的 */
      countsAfter: L.pub.counts.slice(),
      commits: snap ? snap.commits : L.pub.commits.slice(),
      saltSelf: snap ? snap.peerSalt : 'x',   /* 房主的 salt */
      saltPeer: snap ? snap.saltSelf : 'y',   /* 我的 salt */
    });
    await new Promise((r) => setTimeout(r, 300));
    const el = document.getElementById('verdict');
    return el && !el.hidden ? el.textContent : '';
  });
  ok('加入方发现了房主谎报点数', caught.indexOf('作弊') >= 0 || caught.indexOf('对不上') >= 0, caught);
}

/* =============================================================================
 * 六、页面零报错
 * ========================================================================== */
console.log('\n=== 6. 页面零报错 ===');
{
  ok('无未捕获错误', errs.length === 0, errs.slice(0, 3).join(' | '));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
