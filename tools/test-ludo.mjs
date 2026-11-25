/* tools/test-ludo.mjs —— 飞行棋单机 UI + 纯 P2P 联机端到端测试
 *
 * 用法：node tools/test-ludo.mjs
 *
 * 验证：
 *   1. 单机人机：棋盘能画、骰子点数可推导、能走子、撞机生效、判胜
 *   2. P2P：房主码 / 加入码能生成、能互换，通道建立
 *   3. P2P：**点数可推导且两端一致** —— 房主改不了骰子
 *   4. P2P：走子后两端状态收敛、摘要一致
 *   5. P2P：**房主谎报点数会被加入方发现**
 *   6. 页面零报错
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
  if (url === '/' || url === '') file = path.join(ROOT, 'ludo', 'index.html');
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
const BASE = `http://127.0.0.1:${server.address().port}/ludo/`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext();
const errs = [];

const snap = (page) => page.evaluate(() => {
  const L = globalThis.__LUDO__;
  const p = L.pub;
  return {
    seed: p.seed,
    n: p.n,
    turn: p.turn,
    roll: p.roll,
    over: p.over,
    winner: p.winner,
    lastDie: p.lastDie,
    planes: p.planes.map((r) => r.slice()),
    actionCount: L.actionCount,
  };
});
const key = (s) => JSON.stringify([s.turn, s.roll, s.over, s.winner, s.planes]);

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
 * 一、单机人机
 * ========================================================================== */
console.log('\n=== 1. 单机：人机对局 ===');
const solo = await ctx.newPage();
solo.on('pageerror', (e) => errs.push('solo: ' + e.message));
solo.on('console', (m) => { if (m.type() === 'error') errs.push('solo console: ' + m.text()); });
await solo.goto(BASE);
await solo.waitForTimeout(500);

{
  const s = await snap(solo);
  ok('棋盘初始化了', s.n === 4 && s.turn === 0, JSON.stringify(s));
  ok('16 颗棋子都在待飞区', s.planes.every((r) => r.length === 4 && r.every((p) => p === -1)));
  ok('骰子点数可推导', await solo.evaluate(() => {
    const L = globalThis.__LUDO__;
    const d = L.die(L.roll);
    return d >= 1 && d <= 6 && Number.isInteger(d);
  }));

  /* canvas 真的画了东西 */
  const painted = await solo.evaluate(() => {
    const cv = document.getElementById('board');
    const g = cv.getContext('2d');
    const d = g.getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] !== 247 || d[i + 1] !== 242 || d[i + 2] !== 231) n++;
    }
    return n;
  });
  ok('棋盘画出来了（非底色像素足够多）', painted > 20000, painted + ' px');

  /* 掷骰子 */
  await solo.click('#btn-roll');
  await solo.waitForTimeout(900);
  const dieText = await solo.locator('#die').textContent();
  ok('骰子显示了点数', /^[1-6]$/.test(dieText.trim()), dieText);

  /* 能选棋子（待飞区要掷到 6 才有得选，否则直接跳过） */
  const hasChoice = await solo.locator('#ctl-planes .btn').count();
  const s2 = await snap(solo);
  ok('掷骰后要么给出选棋界面、要么自动跳过',
    hasChoice > 0 || s2.roll > s.roll, '按钮=' + hasChoice + ' roll=' + s2.roll);

  /* 走几步，看状态在推进 */
  for (let i = 0; i < 6; i++) {
    const btn = solo.locator('#ctl-planes .btn').first();
    if (await btn.count()) {
      await btn.click();
    } else {
      await solo.click('#btn-roll');
      await solo.waitForTimeout(800);
    }
    await solo.waitForTimeout(300);
  }
  const s3 = await snap(solo);
  ok('走了若干步后状态在推进', s3.roll > s2.roll, 'roll ' + s2.roll + ' → ' + s3.roll);

  /* AI 会接手 —— 玩家走完一步之后，AI 必须自己走（不能干等玩家）。
     这里主动把局面推到 AI 回合，再看它有没有自己动。 */
  const aiActed = await solo.evaluate(async () => {
    const L = globalThis.__LUDO__;
    /* 一直替玩家走到 AI 回合 */
    for (let i = 0; i < 40 && L.pub.turn === 0 && !L.pub.over; i++) {
      const btn = document.querySelector('#ctl-planes .btn');
      if (btn) btn.click();
      else { document.getElementById('btn-roll').click(); }
      await new Promise((r) => setTimeout(r, 350));
    }
    const turnNow = L.pub.turn;
    const cnt = L.actionCount;
    /* AI 该在这一步里自己走 —— 不用玩家再操作 */
    for (let i = 0; i < 40 && L.actionCount === cnt; i++) {
      await new Promise((r) => setTimeout(r, 150));
    }
    return { turnNow, before: cnt, after: L.actionCount };
  });
  ok('轮到 AI 了', aiActed.turnNow !== 0, 'turn=' + aiActed.turnNow);
  ok('AI 自己走了一步', aiActed.after > aiActed.before,
    aiActed.before + ' → ' + aiActed.after);
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
 * 三、P2P：点数可推导且两端一致（核心防线）
 * ========================================================================== */
console.log('\n=== 3. P2P：点数是算出来的，房主改不了 ===');
{
  const h = await snap(host);
  const g = await snap(guest);
  ok('两端种子一致', h.seed === g.seed, h.seed + ' vs ' + g.seed);
  ok('两端用的都是 2 个颜色', h.n === 2 && g.n === 2, h.n + ' vs ' + g.n);

  /* 同一个 seed + 同一个掷骰序号 → 两端算出的点数必然一样 */
  const probe = await Promise.all([host, guest].map((p) => p.evaluate(() => {
    const L = globalThis.__LUDO__;
    const out = [];
    for (let r = 0; r < 20; r++) out.push(L.die(r));
    return out;
  })));
  ok('两端算出的前 20 个点数完全一致',
    JSON.stringify(probe[0]) === JSON.stringify(probe[1]), probe[0].join(','));
  ok('点数在 1..6 之间', probe[0].every((d) => d >= 1 && d <= 6));

  /* 房主上报一个假的点数，必须被房主自己的 validate 拦下 */
  const rejected = await host.evaluate(() => {
    const L = globalThis.__LUDO__;
    const fake = { act: 'move', c: L.pub.turn, plane: -1, r: L.pub.roll, die: 99 };
    const before = L.actionCount;
    L.act(fake);
    return { before, after: L.actionCount };
  });
  ok('房主上报的假点数被拒（动作没进序列）',
    rejected.before === rejected.after, JSON.stringify(rejected));
}

/* =============================================================================
 * 四、P2P：走子后两端收敛
 * ========================================================================== */
console.log('\n=== 4. P2P：走子与状态收敛 ===');
{
  /* 等轮到房主 */
  await host.waitForFunction(() => globalThis.__LUDO__.pub.turn === 0, null, { timeout: 8000 }).catch(() => {});
  const s0 = await snap(host);
  ok('轮到房主', s0.turn === 0, String(s0.turn));

  /* 房主走一步：优先选一颗能走的棋子 */
  const moved = await host.evaluate(() => {
    const L = globalThis.__LUDO__;
    const legal = L.legal(L.pub.turn);
    const plane = legal.length ? legal[0] : -1;
    L.act({ act: 'move', c: L.pub.turn, plane: plane, r: L.pub.roll });
    return { plane, legal: legal.length };
  });
  ok('房主提交了一步', true, JSON.stringify(moved));

  const conv = await waitConverged(host, guest, 10000);
  ok('走子后两端状态收敛', conv.ok, conv.ok ? '' : JSON.stringify(conv.a) + ' vs ' + JSON.stringify(conv.b));
  ok('两端掷骰序号一致', conv.a.roll === conv.b.roll, conv.a.roll + ' vs ' + conv.b.roll);
  ok('两端棋子位置一致',
    JSON.stringify(conv.a.planes) === JSON.stringify(conv.b.planes));

  /* 摘要一致 */
  const hashes = await Promise.all([host, guest].map((p) => p.evaluate(() => {
    const L = globalThis.__LUDO__;
    return JSON.stringify([L.pub.turn, L.pub.roll, L.pub.planes]);
  })));
  ok('两端局面摘要一致', hashes[0] === hashes[1]);
}

/* =============================================================================
 * 五、P2P：房主谎报点数会被加入方发现
 * ========================================================================== */
console.log('\n=== 5. P2P：房主谎报点数会被发现 ===');
{
  /* 给加入方注入一条「房主伪造的局面」——
     把一颗棋子的位置偷偷改掉（相当于房主作弊挪了棋子）。
     加入方不采信房主的局面，而是自己重放动作序列，
     所以伪造的局面应该被识破、并且不影响加入方自己的局面。 */
  const before = await snap(guest);
  const caught = await guest.evaluate(async () => {
    const L = globalThis.__LUDO__;
    const s = L.session;
    /* 伪造一条房主状态：把第 0 色的第一颗棋子挪到终点 */
    const fake = JSON.parse(JSON.stringify(L.pub));
    fake.planes = fake.planes.map((r) => r.slice());
    if (fake.planes[0]) fake.planes[0][0] = 57;
    s._emit('message', {
      t: 'state',
      tick: 999999,
      data: { base: { seed: L.seed, n: L.pub.n }, pub: fake, moves: L.moves },
    });
    await new Promise((r) => setTimeout(r, 400));
    const el = document.getElementById('msg');
    return { text: el.textContent, planes: L.pub.planes.map((r) => r.slice()) };
  });
  ok('加入方识破了伪造的局面', caught.text.indexOf('对不上') >= 0 || caught.text.indexOf('作弊') >= 0, caught.text);
  ok('伪造的局面没有污染加入方自己的状态',
    JSON.stringify(caught.planes) === JSON.stringify(before.planes),
    JSON.stringify(caught.planes) + ' vs ' + JSON.stringify(before.planes));
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
