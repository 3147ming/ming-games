/* tools/test-quiz-party.mjs —— 快问快答派对单机 UI + 纯 P2P 联机端到端测试
 *
 * 用法：node tools/test-quiz-party.mjs
 *
 * 验证：
 *   1. 单人：能出题、点选项判对错、答对加分、答错不加分、限时结束、结算与终局
 *   2. 每日一局：同一天题目与选项顺序一致（可复算）
 *   3. P2P：房主码 / 加入码能生成、能互换，通道建立
 *   4. P2P：**双方同题同序**、种子一致、正确项一致
 *   5. P2P：**答案不泄漏** —— 广播视图里没有分数/答案/解释
 *   6. P2P：**房主谎报答案会被加入方发现**
 *   7. file:// 协议下能打开并玩
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
const eq = (name, a, b) => ok(name, a === b, a === b ? '' : `得到 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}`);

const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let file;
  if (url === '/' || url === '') file = path.join(ROOT, 'quiz-party', 'index.html');
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
const BASE = `http://127.0.0.1:${server.address().port}/quiz-party/`;
const FILE_URL = 'file://' + path.join(ROOT, 'quiz-party', 'index.html');

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext();
const errs = [];

const snap = (page) => page.evaluate(() => {
  const L = globalThis.__QUIZPARTY__;
  const p = L.pub;
  return {
    seed: p.seed,
    total: p.total,
    players: p.players,
    round: p.round,
    phase: p.phase,
    picks: p.picks,
    order: p.order.slice(),
    opts: p.opts.map((o) => o.slice()),
    score: L.grade.players[0].score,
    actionCount: L.actionCount,
  };
});

const key = (s) => JSON.stringify([s.seed, s.order, s.opts, s.round, s.phase, s.picks]);

async function waitConverged(a, b, timeout) {
  const deadline = Date.now() + (timeout || 10000);
  while (Date.now() < deadline) {
    const [da, db] = [await snap(a), await snap(b)];
    if (key(da) === key(db)) return { a: da, b: db, ok: true };
    await new Promise((r) => setTimeout(r, 120));
  }
  return { a: await snap(a), b: await snap(b), ok: false };
}

/* =============================================================================
 * 一、单机
 * ========================================================================== */
console.log('\n=== 1. 单人：出题 / 判分 / 限时 ===');
const solo = await ctx.newPage();
solo.on('pageerror', (e) => errs.push('solo: ' + e.message));
solo.on('console', (m) => { if (m.type() === 'error') errs.push('solo console: ' + m.text()); });
await solo.goto(BASE);
await solo.waitForTimeout(400);

{
  const s = await snap(solo);
  ok('开局有题', s.total === 10 && s.order.length === 10, 'total=' + s.total);
  ok('开局在第 0 题', s.round === 0);
  ok('阶段是答题中', s.phase === 'question');

  const qText = await solo.locator('#q-text').textContent();
  ok('题干渲染出来了', qText && qText.trim().length > 3, qText.trim().slice(0, 20));
  const nOpt = await solo.locator('#opts .opt').count();
  eq('渲染出 4 个选项', nOpt, 4);
  ok('题号显示了', (await solo.locator('#q-index').textContent()).indexOf('1 / 10') >= 0);

  /* 答对 → 加分 */
  const right = await solo.evaluate(() => {
    const L = globalThis.__QUIZPARTY__;
    const ci = L.correctOf(0);
    const before = L.grade.players[0].score;
    L.submit(ci, 12000);
    return { ci, before, after: L.grade.players[0].score, phase: L.phase };
  });
  ok('答对后分数增加', right.after > right.before, right.before + ' → ' + right.after);
  ok('答对后进入结算阶段', right.phase === 'review', right.phase);

  await solo.waitForTimeout(200);
  const verdict = await solo.locator('#rv-verdict').textContent();
  ok('结算显示「答对了」', verdict.indexOf('答对') >= 0, verdict);
  const exp = await solo.locator('#rv-exp').textContent();
  ok('结算显示了解释', exp && exp.trim().length > 4, exp.trim().slice(0, 20));
  const rightOpt = await solo.locator('#opts .opt.right').count();
  ok('正确项被标绿', rightOpt === 1, 'right=' + rightOpt);

  /* 下一题 */
  await solo.click('#btn-next');
  await solo.waitForTimeout(200);
  const s2 = await snap(solo);
  ok('点了「下一题」后进入第 2 题', s2.round === 1 && s2.phase === 'question', 'round=' + s2.round);

  /* 答错 → 不加分 */
  const wrong = await solo.evaluate(() => {
    const L = globalThis.__QUIZPARTY__;
    const ci = L.correctOf(1);
    const before = L.grade.players[0].score;
    L.submit((ci + 1) % 4, 10000);
    return { before, after: L.grade.players[0].score };
  });
  eq('答错不加分', wrong.after, wrong.before);
  await solo.waitForTimeout(200);
  const v2 = await solo.locator('#rv-verdict').textContent();
  ok('结算显示「答错了」', v2.indexOf('答错') >= 0, v2);
  const wrongOpt = await solo.locator('#opts .opt.wrong').count();
  ok('选错的项被标红', wrongOpt === 1, 'wrong=' + wrongOpt);

  /* 限时结束：把剩余时间压到 0，等计时器触发超时 */
  await solo.click('#btn-next');
  await solo.waitForTimeout(200);
  const timedOut = await solo.evaluate(async () => {
    const L = globalThis.__QUIZPARTY__;
    const before = L.grade.players[0].score;
    /* 直接提交 timeout 动作（等价于计时器归零） */
    L.timeout();
    await new Promise((r) => setTimeout(r, 300));
    return {
      before, after: L.grade.players[0].score,
      phase: L.phase,
      attempts: L.grade.players[0].attempts,
    };
  });
  ok('超时后进入结算', timedOut.phase === 'review', timedOut.phase);
  eq('超时不加分', timedOut.after, timedOut.before);
  ok('超时算一次尝试', timedOut.attempts >= 3, 'attempts=' + timedOut.attempts);

  /* 打完一整局，看终局 */
  await solo.evaluate(async () => {
    const L = globalThis.__QUIZPARTY__;
    for (let i = 0; i < 20 && L.phase !== 'done'; i++) {
      if (L.phase === 'review') { L.next(); }
      else if (L.phase === 'question') { L.submit(L.correctOf(L.round), 8000); }
      await new Promise((r) => setTimeout(r, 60));
    }
  });
  await solo.waitForTimeout(300);
  ok('一局打完进入终局', await solo.locator('#end').isVisible());
  const endScore = await solo.locator('#end-score').textContent();
  ok('终局显示总分', Number(endScore) > 0, endScore);
  const endAcc = await solo.locator('#end-acc').textContent();
  ok('终局显示正确率', /%$/.test(endAcc.trim()), endAcc);
  const endStreak = await solo.locator('#end-streak').textContent();
  ok('终局显示最长连对', Number(endStreak) >= 1, endStreak);
  const rate = await solo.locator('#end-rate').textContent();
  ok('终局显示评价', rate && rate.trim().length > 0, rate);

  /* 最高分进了 localStorage */
  const saved = await solo.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('mg_quizparty.v1') || '{}'); }
    catch (e) { return {}; }
  });
  ok('最高分写进了 localStorage', Number(saved.best) > 0, JSON.stringify(saved));
  ok('最长连对写进了 localStorage', Number(saved.bestStreak) >= 1);
  ok('每日成绩写进了 localStorage', !!saved.today);
}

/* =============================================================================
 * 二、每日一局
 * ========================================================================== */
console.log('\n=== 2. 每日一局：同题同序 ===');
{
  const d1 = await ctx.newPage();
  await d1.goto(BASE);
  await d1.waitForTimeout(300);
  await d1.click('#btn-daily');
  await d1.waitForTimeout(300);
  const a = await d1.evaluate(() => {
    const L = globalThis.__QUIZPARTY__;
    return { seed: L.seed, order: L.pub.order.slice(), opts: L.pub.opts.map((o) => o.slice()) };
  });
  const d2 = await ctx.newPage();
  await d2.goto(BASE);
  await d2.waitForTimeout(300);
  await d2.click('#btn-daily');
  await d2.waitForTimeout(300);
  const b = await d2.evaluate(() => {
    const L = globalThis.__QUIZPARTY__;
    return { seed: L.seed, order: L.pub.order.slice(), opts: L.pub.opts.map((o) => o.slice()) };
  });
  ok('两个页面的每日种子一致', a.seed === b.seed, String(a.seed));
  ok('两个页面的每日题目顺序一致', JSON.stringify(a.order) === JSON.stringify(b.order));
  ok('两个页面的每日选项顺序一致', JSON.stringify(a.opts) === JSON.stringify(b.opts));

  /* 换分类 → 题序不同 */
  const d3 = await ctx.newPage();
  await d3.goto(BASE);
  await d3.waitForTimeout(300);
  await d3.selectOption('#cat', 'science');
  await d3.click('#btn-daily');
  await d3.waitForTimeout(300);
  const c = await d3.evaluate(() => globalThis.__QUIZPARTY__.pub.order.slice());
  ok('换分类 → 每日题目不同', JSON.stringify(a.order) !== JSON.stringify(c));

  await d1.close(); await d2.close(); await d3.close();
}

/* =============================================================================
 * 三、P2P：通道建立
 * ========================================================================== */
console.log('\n=== 3. P2P：通道建立 ===');
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
 * 四、P2P：同题同序
 * ========================================================================== */
console.log('\n=== 4. P2P：双方同题同序 ===');
{
  await host.waitForFunction(() => globalThis.__QUIZPARTY__.pub.total > 0, null, { timeout: 8000 }).catch(() => {});
  await guest.waitForFunction(() => globalThis.__QUIZPARTY__.pub.total > 0, null, { timeout: 8000 }).catch(() => {});
  await host.waitForTimeout(600);

  const h = await snap(host);
  const g = await snap(guest);
  ok('两端种子一致', h.seed === g.seed, h.seed + ' vs ' + g.seed);
  ok('两端都是双人局', h.players === 2 && g.players === 2);
  ok('两端题目顺序一致', JSON.stringify(h.order) === JSON.stringify(g.order));
  ok('两端选项顺序一致', JSON.stringify(h.opts) === JSON.stringify(g.opts));
  ok('两端题数一致', h.total === g.total, h.total + ' vs ' + g.total);

  const probe = await Promise.all([host, guest].map((p) => p.evaluate(() => {
    const L = globalThis.__QUIZPARTY__;
    const out = [];
    for (let r = 0; r < L.pub.total; r++) out.push(L.correctOf(r));
    return out;
  })));
  ok('两端算出的正确项完全一致', JSON.stringify(probe[0]) === JSON.stringify(probe[1]),
    probe[0].join(','));
}

/* =============================================================================
 * 五、P2P：答案不泄漏
 * ========================================================================== */
console.log('\n=== 5. P2P：答案不泄漏 ===');
{
  const view = await host.evaluate(() => globalThis.__QUIZPARTY__.view);
  const keys = Object.keys(view);
  const bad = ['correct', 'correctIndex', 'answer', 'score', 'scores', 'explanation', 'grade']
    .filter((k) => keys.indexOf(k) >= 0);
  ok('公开视图里没有答案/分数字段', bad.length === 0, bad.join(','));
  ok('公开视图里有题序与选项置换', Array.isArray(view.order) && Array.isArray(view.opts));
  ok('公开视图里有作答记录', Array.isArray(view.picks));

  const actKeys = new Set();
  for (const a of await host.evaluate(() => globalThis.__QUIZPARTY__.moves)) {
    for (const k of Object.keys(a)) actKeys.add(k);
  }
  const badAct = ['ans', 'answer', 'correct', 'correctIndex', 'score', 'points', 'explanation']
    .filter((k) => actKeys.has(k));
  ok('动作序列里没有答案/分数字段', badAct.length === 0, badAct.join(','));

  /* 双方各自算出的分数一致（说明评分是纯函数推导，不靠房主下发） */
  const sc = await Promise.all([host, guest].map((p) => p.evaluate(() => globalThis.__QUIZPARTY__.grade.players.map((x) => x.score))));
  ok('两端算出的分数一致', JSON.stringify(sc[0]) === JSON.stringify(sc[1]), JSON.stringify(sc));
}

/* =============================================================================
 * 六、P2P：作答 + 状态收敛
 * ========================================================================== */
console.log('\n=== 6. P2P：作答与状态收敛 ===');
{
  /* 两边都答第一题（用同一个正确项） */
  await Promise.all([host, guest].map((p) => p.evaluate(() => {
    const L = globalThis.__QUIZPARTY__;
    L.submit(L.correctOf(L.round), 9000);
  })));
  await host.waitForTimeout(1200);

  const conv = await waitConverged(host, guest, 10000);
  ok('作答后两端状态收敛', conv.ok, conv.ok ? '' : JSON.stringify(conv.a) + ' vs ' + JSON.stringify(conv.b));
  ok('两端轮次一致', conv.a.round === conv.b.round, conv.a.round + ' vs ' + conv.b.round);
  ok('两端作答记录一致', JSON.stringify(conv.a.picks) === JSON.stringify(conv.b.picks),
    JSON.stringify(conv.a.picks) + ' vs ' + JSON.stringify(conv.b.picks));

  /* 房主结算后揭示答案，双方核对通过 */
  await host.waitForTimeout(1200);
  const rv = await host.evaluate(() => globalThis.__QUIZPARTY__.reveals);
  const gv = await guest.evaluate(() => globalThis.__QUIZPARTY__.reveals);
  ok('房主结算时揭示了答案', !!rv && rv['0'] !== undefined, JSON.stringify(rv));
  ok('揭示的答案带承诺哈希', !!(rv && rv['0'] && rv['0'].commit));
  ok('加入方也收到了揭示', !!gv && gv['0'] !== undefined);
  ok('两端揭示的答案一致', rv && gv && rv['0'] && gv['0']
    ? rv['0'].correctIndex === gv['0'].correctIndex : false);

  const gmsg = await guest.locator('#msg').textContent();
  ok('加入方没有报作弊告警', gmsg.indexOf('作弊') < 0 && gmsg.indexOf('串题') < 0, gmsg);

  /* 两端分数一致（先答对的拿抢先分） */
  const sc2 = await Promise.all([host, guest].map((p) => p.evaluate(() => globalThis.__QUIZPARTY__.grade.players.map((x) => x.score))));
  ok('结算后两端分数仍一致', JSON.stringify(sc2[0]) === JSON.stringify(sc2[1]), JSON.stringify(sc2));
}

/* =============================================================================
 * 七、P2P：房主谎报答案会被发现
 * ========================================================================== */
console.log('\n=== 7. P2P：房主谎报答案会被发现 ===');
{
  const before = await guest.evaluate(() => globalThis.__QUIZPARTY__.pub.round);
  const caught = await guest.evaluate(async () => {
    const L = globalThis.__QUIZPARTY__;
    const s = L.session;
    const real = L.correctOf(L.round);
    /* 伪造一条房主状态：把揭示的答案改成错的 */
    s._emit('message', {
      t: 'state',
      tick: 999999,
      data: {
        base: { seed: L.seed, cat: L.pub.cat, total: L.pub.total, players: 2, mode: 'p2p', daily: false },
        pub: L.view,
        moves: L.moves,
        reveals: { [L.round]: { r: L.round, qid: L.pub.order[L.round], correctIndex: (real + 1) % 4, explanation: '假的', commit: 'deadbeef' } },
        commits: [],
      },
    });
    await new Promise((r) => setTimeout(r, 400));
    return { text: document.getElementById('msg').textContent, round: L.pub.round };
  });
  ok('加入方识破了谎报的答案', caught.text.indexOf('作弊') >= 0, caught.text);
  ok('伪造状态没有污染加入方的局面', caught.round === before);
}

/* =============================================================================
 * 七之二、P2P：连打多题，两端始终收敛
 * ========================================================================== */
console.log('\n=== 7b. P2P：连打三题，两端始终收敛 ===');
{
  for (let i = 0; i < 3; i++) {
    /* 等房主把上一题结算并推进 */
    await host.waitForFunction(() => globalThis.__QUIZPARTY__.pub.phase === 'question', null, { timeout: 15000 })
      .catch(() => {});
    await guest.waitForFunction(() => globalThis.__QUIZPARTY__.pub.phase === 'question', null, { timeout: 15000 })
      .catch(() => {});
    await Promise.all([host, guest].map((p) => p.evaluate(() => {
      const L = globalThis.__QUIZPARTY__;
      if (L.phase !== 'question') return;
      L.submit(L.correctOf(L.round), 8000);
    })));
    await host.waitForTimeout(400);
    const conv = await waitConverged(host, guest, 10000);
    ok('第 ' + (i + 1) + ' 题后两端收敛', conv.ok,
      conv.ok ? '' : JSON.stringify(conv.a.round) + ' vs ' + JSON.stringify(conv.b.round));
  }
  const sc3 = await Promise.all([host, guest].map((p) => p.evaluate(() => globalThis.__QUIZPARTY__.grade.players.map((x) => x.score))));
  ok('多题之后两端分数仍一致', JSON.stringify(sc3[0]) === JSON.stringify(sc3[1]), JSON.stringify(sc3));
  const rv3 = await guest.evaluate(() => globalThis.__QUIZPARTY__.reveals);
  const nReveal = rv3 ? Object.keys(rv3).length : 0;
  ok('每题结算都有揭示', nReveal >= 2, '揭示数=' + nReveal);
}

/* =============================================================================
 * 八、file:// 协议
 * ========================================================================== */
console.log('\n=== 8. file:// 协议下能玩 ===');
{
  const fp = await ctx.newPage();
  const fileErrs = [];
  /* file:// 下 Chrome 会 CORS 拦掉 ES 模块 —— 这是预期行为，
     页面里的 classic 兜底包会顶上。这里只关心兜底之后有没有真错误。 */
  const isExpected = (t) => t.indexOf('blocked by CORS policy') >= 0
    || t.indexOf('net::ERR_FAILED') >= 0
    || t.indexOf('/src/main.mjs') >= 0;
  fp.on('pageerror', (e) => { if (!isExpected(e.message)) fileErrs.push('file: ' + e.message); });
  fp.on('console', (m) => {
    if (m.type() === 'error' && !isExpected(m.text())) fileErrs.push('file console: ' + m.text());
  });
  await fp.goto(FILE_URL);
  await fp.waitForTimeout(800);
  const q = await fp.locator('#q-text').textContent();
  ok('file:// 下题目渲染出来了', q && q.trim().length > 3, q.trim().slice(0, 20));
  const nOpt = await fp.locator('#opts .opt').count();
  eq('file:// 下有 4 个选项', nOpt, 4);
  const played = await fp.evaluate(() => {
    const L = globalThis.__QUIZPARTY__;
    const before = L.grade.players[0].score;
    L.submit(L.correctOf(L.round), 10000);
    return { before, after: L.grade.players[0].score, phase: L.phase };
  });
  ok('file:// 下能作答并计分', played.after > played.before, played.before + ' → ' + played.after);
  ok('file:// 下能结算', played.phase === 'review');
  ok('file:// 下零报错', fileErrs.length === 0, fileErrs.slice(0, 3).join(' | '));
  await fp.close();
}

/* =============================================================================
 * 九、页面零报错
 * ========================================================================== */
console.log('\n=== 9. 页面零报错 ===');
{
  ok('无未捕获错误', errs.length === 0, errs.slice(0, 4).join(' | '));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
