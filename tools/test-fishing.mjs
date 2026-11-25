/* tools/test-fishing.mjs —— 小铺垂钓单机 UI + 纯 P2P 联机端到端测试
 *
 * 用法：node tools/test-fishing.mjs
 *
 * 验证：
 *   1. 单机：能抛竿、浮标会等、会有鱼上钩
 *   2. 单机：**窗口判定正确** —— 正中完美区＝大鱼，偏一点＝小鱼，超时＝空钩
 *   3. 单机：卖鱼换金币、鱼竿铺能买、存档写进 localStorage
 *   4. 每日一钓：种子由日期派生、次数用完就停
 *   5. P2P：房主码 / 加入码能生成、能互换，通道建立
 *   6. P2P：**两端看到同一片湖** —— 种子一致、鱼群一致、窗口一致
 *   7. P2P：抛竿收竿后两端状态收敛
 *   8. P2P：**房主谎报局面会被加入方发现**
 *   9. file:// 直接双击源码目录也能玩（classic 兜底包）
 *  10. 页面零报错
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
  if (url === '/' || url === '') file = path.join(ROOT, 'fishing', 'index.html');
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
const BASE = `http://127.0.0.1:${server.address().port}/fishing/`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext();
const errs = [];

const snap = (page) => page.evaluate(() => {
  const F = globalThis.__FISHING__;
  const s = F.pub;
  return {
    seed: s ? s.seed : 0,
    rod: s ? s.rod : 0,
    seats: s ? s.seats : 0,
    daily: s ? s.daily : false,
    casts: s ? s.catches.map((a) => a.slice()) : [],
    totals: s ? s.totals.slice() : [],
    phase: F.phase,
    mode: F.mode,
    actionCount: F.actionCount,
    plan: F.plan,
  };
});

/** 抛一竿，等到咬钩，然后按指定的相对时机收竿（0＝完美区正中）。 */
async function castAndReel(page, mode) {
  await page.evaluate(() => globalThis.__FISHING__.cast());
  await page.waitForFunction(() => globalThis.__FISHING__.phase === 'bite', null, { timeout: 12000 });
  return page.evaluate((m) => {
    const F = globalThis.__FISHING__;
    const p = F.plan;
    let dt;
    if (m === 'perfect') dt = p.center;
    else if (m === 'good') dt = Math.max(1, p.center - p.half * 1.6);
    else if (m === 'late') dt = p.window + 200;
    else dt = p.center;
    F.reel(dt);
    return { dt: dt, window: p.window, center: p.center, half: p.half, species: p.species.id, value: p.species.value };
  }, mode);
}

/* =============================================================================
 * 一、单机：抛竿 / 上钩 / 窗口判定
 * ========================================================================== */
console.log('\n=== 1. 单机：抛竿与窗口判定 ===');
const solo = await ctx.newPage();
solo.on('pageerror', (e) => errs.push('solo: ' + e.message));
solo.on('console', (m) => { if (m.type() === 'error') errs.push('solo console: ' + m.text()); });
await solo.goto(BASE);
await solo.waitForTimeout(500);

{
  const s = await snap(solo);
  ok('游戏初始化了', s.seed > 0 && s.seats === 1, JSON.stringify(s));
  ok('初始是单人模式', s.mode === 'solo');
  ok('湖里有鱼群（可推导）', (await solo.evaluate(() => globalThis.__FISHING__.lake(20, 0).length)) === 20);

  /* 抛竿 */
  await solo.click('#btn-cast');
  await solo.waitForTimeout(300);
  ok('抛竿后进入等待', (await snap(solo)).phase === 'waiting');
  ok('等待时不能重复抛竿', await solo.evaluate(() => document.getElementById('btn-cast').disabled));

  /* 上钩 */
  await solo.waitForFunction(() => globalThis.__FISHING__.phase === 'bite', null, { timeout: 12000 });
  ok('浮标沉了 —— 有鱼上钩', (await snap(solo)).phase === 'bite');
  ok('上钩后「收竿」可点', await solo.evaluate(() => !document.getElementById('btn-reel').disabled));
  ok('完美区已画出来', await solo.evaluate(() => {
    const z = document.getElementById('meter-zone');
    return z.style.display !== 'none' && parseFloat(z.style.width) > 0;
  }));

  /* 完美收竿 */
  const r1 = await solo.evaluate(() => {
    const F = globalThis.__FISHING__;
    const p = F.plan;
    F.reel(p.center);
    return { center: p.center, value: p.species.value, id: p.species.id };
  });
  await solo.waitForTimeout(200);
  let cs = (await snap(solo)).casts[0];
  ok('正中完美区 → 判完美', cs.length === 1 && cs[0].grade === 'perfect', JSON.stringify(cs));
  ok('完美 → 该鱼种价值 ×2', cs[0].value === r1.value * 2, cs[0].value + ' vs ' + r1.value * 2);

  /* 偏一点 → 小鱼 */
  await solo.waitForTimeout(150);
  const r2 = await castAndReel(solo, 'good');
  await solo.waitForTimeout(200);
  cs = (await snap(solo)).casts[0];
  ok('偏出完美区 → 判小鱼', cs.length === 2 && cs[1].grade === 'good', JSON.stringify(cs));
  ok('小鱼 → 该鱼种价值的一半', cs[1].value === Math.round(r2.value * 0.5), cs[1].value + ' vs ' + r2.value);

  /* 错过窗口 → 空钩 */
  await solo.waitForTimeout(150);
  await castAndReel(solo, 'late');
  await solo.waitForTimeout(200);
  cs = (await snap(solo)).casts[0];
  ok('超出窗口 → 判空钩', cs.length === 3 && cs[2].grade === 'miss', JSON.stringify(cs));
  ok('空钩收益 0', cs[2].value === 0);

  /* 场景画布真的画了东西 */
  const painted = await solo.evaluate(() => {
    const cv = document.getElementById('scene');
    const g = cv.getContext('2d');
    const d = g.getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 0) n++;
    }
    return n;
  });
  ok('场景画出来了', painted > 200000, painted + ' px');
}

/* =============================================================================
 * 二、卖鱼 / 鱼竿 / 存档
 * ========================================================================== */
console.log('\n=== 2. 卖鱼、金币与存档 ===');
{
  const basket = await solo.evaluate(() => globalThis.__FISHING__.basket);
  ok('鱼篓里有鱼', basket.length >= 2, basket.length + ' 条');
  await solo.click('#btn-sell');
  await solo.waitForTimeout(200);
  const coin = await solo.evaluate(() => globalThis.__FISHING__.coin);
  ok('卖鱼后金币变多', coin > 0, coin + ' 金币');
  ok('卖完鱼篓空了', (await solo.evaluate(() => globalThis.__FISHING__.basket.length)) === 0);

  const stored = await solo.evaluate(() => localStorage.getItem('mg_fishing.v1'));
  ok('存档写进了 mg_fishing.v1', !!stored && stored.indexOf('"coin"') >= 0);
  const saved = JSON.parse(stored || '{}');
  ok('存档里有金币 / 最高单笔 / 鱼种 / 每日成绩',
    saved.coin > 0 && saved.best > 0 && Object.keys(saved.species || {}).length > 0 &&
    !!saved.daily && typeof saved.daily.date === 'string');

  /* 鱼竿铺：金币不够时按钮禁用（鱼种随机，得按金币算） */
  const shopState = await solo.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('#shop .btn'));
    return { n: btns.length, disabled: btns.map((b) => b.disabled), coin: globalThis.__FISHING__.coin };
  });
  ok('鱼竿铺列出了可买的竿', shopState.n === 1);
  ok('买不起时「买下」是禁用的', shopState.disabled[0] === (shopState.coin < 150),
    '金币 ' + shopState.coin + '，禁用=' + shopState.disabled[0]);
}

/* =============================================================================
 * 三、每日一钓
 * ========================================================================== */
console.log('\n=== 3. 每日一钓 ===');
{
  await solo.click('#mode-daily');
  await solo.waitForTimeout(300);
  const s = await snap(solo);
  ok('切到每日一钓', s.mode === 'daily' && s.daily === true);
  ok('每日局限制了次数', s.seats === 1);
  const bar = await solo.textContent('#daily-bar');
  ok('显示了今天的湖与剩余次数', /还剩 5 竿/.test(bar), bar);

  /* 同一天的种子是固定的 */
  const seed1 = await solo.evaluate(() => globalThis.__FISHING__.seed);
  await solo.click('#mode-solo');
  await solo.waitForTimeout(150);
  await solo.click('#mode-daily');
  await solo.waitForTimeout(300);
  const seed2 = await solo.evaluate(() => globalThis.__FISHING__.seed);
  ok('同一天的每日种子一致', seed1 === seed2, seed1 + ' vs ' + seed2);
  const key = await solo.evaluate(() => globalThis.__FISHING__.dailyKey());
  ok('日期键格式正确', /^\d{4}-\d{2}-\d{2}$/.test(key), key);

  /* 抛满 5 竿后不能再抛（第一竿踩中完美区，其余故意错过） */
  for (let i = 0; i < 5; i++) {
    await solo.evaluate(() => globalThis.__FISHING__.cast());
    await solo.waitForFunction(() => globalThis.__FISHING__.phase === 'bite', null, { timeout: 12000 });
    await solo.evaluate((perfect) => {
      const F = globalThis.__FISHING__;
      F.reel(perfect ? F.plan.center : F.plan.window + 200);
    }, i === 0);
    await solo.waitForTimeout(120);
  }
  await solo.waitForTimeout(300);
  const s3 = await snap(solo);
  ok('每日一钓最多 5 竿', s3.casts[0].length === 5, s3.casts[0].length + ' 条');
  ok('次数用完不能抛竿', await solo.evaluate(() => document.getElementById('btn-cast').disabled));
  const dailySaved = await solo.evaluate(() => JSON.parse(localStorage.getItem('mg_fishing.v1') || '{}').daily);
  ok('每日成绩记进了存档', dailySaved && dailySaved.best > 0, JSON.stringify(dailySaved));
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
await host.click('#mode-p2p');
await guest.click('#mode-p2p');
await host.waitForTimeout(300);

{
  ok('联机模式显示联机面板', !(await host.locator('#p2p').isHidden()));

  /* 房主勾「今日之湖」—— 同一天所有人的湖都一样 */
  await host.check('#p2p-daily');
  await host.waitForTimeout(150);

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
 * 五、P2P：同一片湖（核心防线）
 * ========================================================================== */
console.log('\n=== 5. P2P：两端看到同一片湖 ===');
{
  await host.waitForTimeout(400);
  const h = await snap(host);
  const g = await snap(guest);
  ok('两端种子一致', h.seed === g.seed && h.seed > 0, h.seed + ' vs ' + g.seed);
  ok('两端都是 2 个座位', h.seats === 2 && g.seats === 2);
  const dseed = await host.evaluate(() => globalThis.__FISHING__.dailySeed());
  ok('今日之湖的种子由日期派生（两端都认这个种子）', h.seed === dseed, h.seed + ' vs ' + dseed);
  ok('两端都按今日之湖（每人 5 竿）', h.daily === true && g.daily === true);
  ok('房主是 0 号座位', (await host.evaluate(() => globalThis.__FISHING__.mySeat)) === 0);
  ok('加入方是 1 号座位', (await guest.evaluate(() => globalThis.__FISHING__.mySeat)) === 1);

  /* 同一个种子 → 同一片鱼群（两个座位各自的序列也一致） */
  const lakes = await Promise.all([host, guest].map((p) => p.evaluate(() => ({
    s0: globalThis.__FISHING__.lake(24, 0),
    s1: globalThis.__FISHING__.lake(24, 1),
    rod: globalThis.__FISHING__.pub.rod,
  }))));
  ok('两端鱼竿等级一致', lakes[0].rod === lakes[1].rod, lakes[0].rod + ' vs ' + lakes[1].rod);
  ok('两端 0 号座位的鱼群完全一致',
    JSON.stringify(lakes[0].s0) === JSON.stringify(lakes[1].s0));
  ok('两端 1 号座位的鱼群完全一致',
    JSON.stringify(lakes[0].s1) === JSON.stringify(lakes[1].s1));
  ok('两个座位的鱼群不是同一条序列',
    JSON.stringify(lakes[0].s0) !== JSON.stringify(lakes[0].s1));

  /* 房主上报一个离谱的动作，必须被自己的 validate 拦下 */
  const rejected = await host.evaluate(() => {
    const F = globalThis.__FISHING__;
    const before = F.actionCount;
    F.act({ act: 'cast', seat: 1 });           /* 房主不能替加入方抛竿 */
    F.act({ act: 'reel', seat: 0, dt: 99999 }); /* 还没抛竿就收竿 */
    return { before, after: F.actionCount };
  });
  ok('房主替对方操作 / 非法收竿被拒（动作没进序列）',
    rejected.before === rejected.after, JSON.stringify(rejected));
}

/* =============================================================================
 * 六、P2P：抛竿收竿后两端收敛
 * ========================================================================== */
console.log('\n=== 6. P2P：收竿与状态收敛 ===');
{
  /* 房主抛一竿，完美收竿 */
  await host.evaluate(() => globalThis.__FISHING__.cast());
  await host.waitForFunction(() => globalThis.__FISHING__.phase === 'bite', null, { timeout: 12000 });
  await host.evaluate(() => {
    const F = globalThis.__FISHING__;
    F.reel(F.plan.center);
  });
  await host.waitForTimeout(500);

  const hs = (await snap(host)).casts[0];
  const gs = (await snap(guest)).casts[0];
  ok('房主钓到了一条', hs.length === 1, JSON.stringify(hs));
  ok('加入方也看到了这一条（同一片湖）', gs.length === 1, JSON.stringify(gs));
  ok('两端这条鱼完全一致', JSON.stringify(hs) === JSON.stringify(gs), JSON.stringify(hs));
  ok('两端总分一致',
    JSON.stringify((await snap(host)).totals) === JSON.stringify((await snap(guest)).totals));

  /* 加入方也抛一竿：加入方的动作要经房主裁决 */
  await guest.evaluate(() => globalThis.__FISHING__.cast());
  await guest.waitForFunction(() => globalThis.__FISHING__.phase === 'bite', null, { timeout: 12000 });
  await guest.evaluate(() => {
    const F = globalThis.__FISHING__;
    F.reel(F.plan.center);
  });
  await guest.waitForTimeout(600);
  const hs2 = (await snap(host)).casts[1];
  const gs2 = (await snap(guest)).casts[1];
  ok('加入方的鱼也进了房主的局面', hs2.length === 1, JSON.stringify(hs2));
  ok('两端这条鱼也完全一致', JSON.stringify(hs2) === JSON.stringify(gs2), JSON.stringify(hs2));
  ok('两端动作序列长度一致',
    (await snap(host)).actionCount === (await snap(guest)).actionCount);
}

/* =============================================================================
 * 七、P2P：房主谎报局面会被发现
 * ========================================================================== */
console.log('\n=== 7. P2P：房主谎报局面会被识破 ===');
{
  const before = await snap(guest);
  const caught = await guest.evaluate(async () => {
    const F = globalThis.__FISHING__;
    const s = F.session;
    /* 伪造一条「房主发来的局面」：把 0 号座位的鱼换一条 */
    const fake = JSON.parse(JSON.stringify(F.pub));
    fake.catches = fake.catches.map((a) => a.slice());
    fake.catches[0][0] = { id: 'long', grade: 'perfect', value: 9999, dt: 1 };
    s._emit('message', {
      t: 'state',
      tick: 999999,
      data: { base: F.remoteBase, pub: fake, moves: F.moves },
    });
    await new Promise((r) => setTimeout(r, 400));
    const el = document.getElementById('msg');
    return { text: el.textContent, catches: JSON.stringify(F.pub.catches) };
  });
  ok('加入方识破了伪造的局面',
    caught.text.indexOf('对不上') >= 0 || caught.text.indexOf('作弊') >= 0, caught.text);
  ok('伪造的局面没有污染加入方自己的状态',
    JSON.stringify(JSON.parse(caught.catches)[0]) === JSON.stringify(before.casts[0]),
    caught.catches);
}

/* =============================================================================
 * 八、file:// 直接双击源码目录
 * ========================================================================== */
console.log('\n=== 8. file:// 直接打开源码目录 ===');
{
  const fileErrs = [];
  const fp = await ctx.newPage();
  fp.on('pageerror', (e) => fileErrs.push('pageerror: ' + e.message));
  fp.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    /* file:// 下浏览器拦掉 ES 模块是**预期行为**（CORS），
       页面里的兜底脚本会改加载 classic 包；这条噪音不算游戏错误。 */
    if (/main\.mjs|CORS|ERR_FAILED|blocked by CORS/i.test(t)) return;
    fileErrs.push('console: ' + t);
  });
  await fp.goto('file://' + path.join(ROOT, 'fishing', 'index.html'));
  await fp.waitForTimeout(1200);
  const st = await fp.evaluate(() => {
    const F = globalThis.__FISHING__;
    return F ? { seed: F.seed, phase: F.phase } : null;
  });
  ok('file:// 下游戏能跑起来', !!st && st.seed > 0, JSON.stringify(st));

  /* 还能真的钓一竿 */
  const fileCast = await fp.evaluate(async () => {
    const F = globalThis.__FISHING__;
    F.cast();
    await new Promise((r) => setTimeout(r, 200));
    return F.phase;
  });
  ok('file:// 下能抛竿', fileCast === 'waiting', fileCast);
  const fileBite = await fp.evaluate(async () => {
    const F = globalThis.__FISHING__;
    for (let i = 0; i < 120 && F.phase !== 'bite'; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (F.phase !== 'bite') return null;
    const p = F.plan;
    F.reel(p.center);
    return p.species.id;
  });
  ok('file:// 下能上钩并收竿', !!fileBite, String(fileBite));
  await fp.waitForTimeout(200);
  const fileCatches = await fp.evaluate(() => globalThis.__FISHING__.pub.catches[0].length);
  ok('file:// 下钓到了鱼', fileCatches === 1, fileCatches + ' 条');
  ok('file:// 下没有游戏自身的报错', fileErrs.length === 0, fileErrs.slice(0, 3).join(' | '));
  await fp.close();
}

/* =============================================================================
 * 九、页面零报错
 * ========================================================================== */
console.log('\n=== 9. 页面零报错 ===');
{
  ok('无未捕获错误', errs.length === 0, errs.slice(0, 3).join(' | '));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
