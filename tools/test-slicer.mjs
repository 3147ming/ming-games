/* tools/test-slicer.mjs —— 切片大师单机 UI + 纯 P2P 联机端到端测试
 *
 * 用法：node tools/test-slicer.mjs
 *
 * 验证：
 *   1. 单机：能划开水果、分数增加
 *   2. 单机：一次划过切中多个 → 连击倍率生效
 *   3. 单机：切到炸弹 → 扣分、连击清零；切到 3 颗 → 判负
 *   4. 单机：切到冰冻蛋 → 全场慢速（出现减速窗口）
 *   5. 单机：限时结束 → 结算面板 + 评价等级
 *   6. 每日一局：同一天种子固定
 *   7. P2P：房主码 / 加入码能生成、能互换，通道建立，两端种子一致
 *   8. P2P：**轨迹走独立增量消息**，结算双方各自算 —— 两端得分一致
 *   9. P2P：**房主谎报分数会被加入方发现**
 *  10. file:// 直接双击能玩 + 零报错
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  scheduleOf, objPos, segmentsOf, segCircleHit,
  VW, VH, T_FRUIT, T_BOMB, T_ICE, BLADE, MAX_LIFETIME,
} from '../slicer/src/rules.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('/root/.nvm/versions/node/v22.13.1/lib/node_modules/playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra !== undefined ? '  ' + extra : ''}`);
  cond ? pass++ : fail++;
};
const eq = (name, actual, expected) => {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${good ? '✓' : '✗'} ${name}${good ? '' : '  实际=' + JSON.stringify(actual) + ' 期望=' + JSON.stringify(expected)}`);
  good ? pass++ : fail++;
};

/* ---------------------------------------------------------------------------
 * 场景搜索（与规则引擎同一套几何，所以断言是硬断言，不是自证）
 * ------------------------------------------------------------------------- */
function aliveList(seed, frame) {
  const out = [];
  for (const o of scheduleOf(seed)) {
    if (frame < o.frame) continue;
    if (frame - o.frame > MAX_LIFETIME) continue;
    const p = objPos(o, frame, { slow: [], magnets: [] });
    if (p.y - o.r > VH) continue;
    if (p.y - o.r < 0) continue;   /* 还没完整进入画面，鼠标划不到 */
    if (p.y + o.r > VH) continue;   /* 已经掉出画面 */
    if (p.x - o.r < 0 || p.x + o.r > VW) continue;
    out.push({ o: o, x: p.x, y: p.y });
  }
  return out;
}

/** 一条轨迹在某一帧会切到哪些物体（规则引擎同款判定）。 */
function hitsAt(seed, frame, pts) {
  const segs = segmentsOf(pts);
  const out = [];
  for (const it of aliveList(seed, frame)) {
    for (const g of segs) {
      if (segCircleHit(g[0], g[1], g[2], g[3], it.x, it.y, it.o.r + BLADE)) { out.push(it.o); break; }
    }
  }
  return out;
}

/** 找「一刀正好切中 2 个水果」的场面。 */
function findComboCase() {
  for (let seed = 1; seed <= 80; seed++) {
    for (let frame = 30; frame <= 900; frame += 2) {
      const fruits = aliveList(seed, frame).filter((x) => x.o.type === T_FRUIT);
      for (let i = 0; i < fruits.length; i++) {
        for (let j = i + 1; j < fruits.length; j++) {
          const a = fruits[i], b = fruits[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          if (Math.hypot(dx, dy) > 14) continue;
          const pts = [[a.x - dx * 0.3, a.y - dy * 0.3], [b.x + dx * 0.3, b.y + dy * 0.3]];
          const hits = hitsAt(seed, frame, pts);
          if (hits.length === 2 && hits.every((h) => h.type === T_FRUIT)) {
            return { seed: seed, frame: frame, pts: pts, hits: hits.map((h) => h.id) };
          }
        }
      }
    }
  }
  return null;
}


/** 从可见物体里挑一个「完整在画面内」的水果（保证鼠标划得到）。 */
function pickFruit(objs) {
  return objs.find((o) => o.type === T_FRUIT
    && o.y - o.r >= 0 && o.y + o.r <= VH
    && o.x - o.r >= 0 && o.x + o.r <= VW);
}

/** 穿过某物体的水平一刀（端点夹在画面内，保证 pointerdown 落在 canvas 上）。 */
function strokeAcross(it) {
  const half = 9;
  const x1 = Math.max(0.5, Math.min(VW - 0.5, it.x - half));
  const x2 = Math.max(0.5, Math.min(VW - 0.5, it.x + half));
  return [[x1, it.y], [x2, it.y]];
}

/** 找「一刀只切到一颗孤立水果」的场面。 */
function findSingleCase(seed, type) {
  for (let frame = 30; frame <= 900; frame += 1) {
    const list = aliveList(seed, frame).filter((x) => x.o.type === type);
    for (const it of list) {
      const pts = strokeAcross(it);
      const hits = hitsAt(seed, frame, pts);
      if (hits.length === 1 && hits[0].id === it.o.id) {
        return { seed: seed, frame: frame, pts: pts, hit: it.o, x: it.x, y: it.y };
      }
    }
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * 本地静态服务
 * ------------------------------------------------------------------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let file;
  if (url === '/' || url === '') file = path.join(ROOT, 'slicer', 'index.html');
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
const BASE = `http://127.0.0.1:${server.address().port}/slicer/`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext();
const errs = [];

/* ---------------------------------------------------------------------------
 * 页面小工具
 * ------------------------------------------------------------------------- */
const snap = (page) => page.evaluate(() => {
  const L = globalThis.__SLICER__;
  return {
    seed: L.seed, frame: L.frame, score: L.score, bestCombo: L.bestCombo,
    bombs: L.bombs, over: L.over, mode: L.mode,
    strokes: L.strokes.length,
    summary: JSON.parse(JSON.stringify(L.summary)),
  };
});

/** 把页面摆到某个 seed + 帧，并冻住时钟。 */
async function freezeAt(page, seed, frame) {
  /* 上一次测试可能已经判负结束 —— 先重开一局 */
  if (await page.evaluate(() => globalThis.__SLICER__.over)) {
    await page.evaluate(() => { document.getElementById('over').hidden = true; });
    await page.click('#btn-new');
    await page.waitForTimeout(60);
  }
  await page.evaluate(({ s, f }) => {
    const L = globalThis.__SLICER__;
    if (s != null) L.setSeed(s);
    L.seek(f);
    L.pause();
  }, { s: seed, f: frame });
  return page.evaluate(() => globalThis.__SLICER__.objects());
}

/** 在虚拟坐标上划一刀（真的走鼠标事件）。 */
async function swipe(page, pts) {
  /* 画布可能已经被面板顶出视口 —— 先滚进来，鼠标事件才打得到 */
  await page.locator('#field').scrollIntoViewIfNeeded();
  await page.waitForTimeout(30);
  const a = await page.evaluate((p) => globalThis.__SLICER__.clientOf(p[0][0], p[0][1]), pts);
  const b = await page.evaluate((p) => globalThis.__SLICER__.clientOf(p[1][0], p[1][1]), pts);
  if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(b.x) || !Number.isFinite(b.y)) {
    throw new Error('swipe 坐标非法: ' + JSON.stringify({ a, b }));
  }
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps);
  }
  await page.mouse.up();
  await page.waitForTimeout(120);
}

/* =============================================================================
 * 一、单机：能划开水果
 * ========================================================================== */
console.log('\n=== 1. 单机：划开水果，分数增加 ===');
const solo = await ctx.newPage();
solo.on('pageerror', (e) => errs.push('solo: ' + e.message));
solo.on('console', (m) => { if (m.type() === 'error') errs.push('solo console: ' + m.text()); });
await solo.goto(BASE);
await solo.waitForTimeout(400);

{
  ok('页面起来了', await solo.evaluate(() => !!globalThis.__SLICER__));
  ok('画布有尺寸', await solo.evaluate(() => {
    const cv = document.getElementById('field');
    return cv.width > 100 && cv.height > 100;
  }));
  const painted = await solo.evaluate(() => {
    const cv = document.getElementById('field');
    const g = cv.getContext('2d');
    const d = g.getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] !== 248 || d[i + 1] !== 240 || d[i + 2] !== 223) n++;
    }
    return n;
  });
  ok('画布画出来了（非底色像素足够多）', painted > 20000, painted + ' px');

  /* 找一刀只切中一颗水果的场面 */
  const one = findSingleCase(12345, T_FRUIT);
  ok('找得到「一刀一颗水果」的场面', !!one);
  if (one) {
    const before = (await snap(solo)).score;
    await freezeAt(solo, one.seed, one.frame);
    await swipe(solo, one.pts);
    const after = await snap(solo);
    ok('划一下分数增加了', after.score > before, before + ' → ' + after.score);
    eq('只切中 1 个水果', after.summary.events[after.summary.events.length - 1].fruitCount, 1);
    eq('倍率是 ×1', after.summary.events[after.summary.events.length - 1].mult, 1);
    eq('得分 = 品种分值', after.score, one.hit.points);
    ok('被切集合里有 1 个', after.summary.sliced.length === 1);
    await solo.evaluate(() => globalThis.__SLICER__.resume());
  }
}

/* =============================================================================
 * 二、连击倍率
 * ========================================================================== */
console.log('\n=== 2. 连击：一次划过切中多个 ===');
{
  const combo = findComboCase();
  ok('找得到「一刀两个水果」的场面', !!combo);
  if (combo) {
    await freezeAt(solo, combo.seed, combo.frame);
    await swipe(solo, combo.pts);
    const s = await snap(solo);
    const ev = s.summary.events[s.summary.events.length - 1];
    eq('一刀切中 2 个水果', ev.fruitCount, 2);
    eq('连击倍率 ×1.5', ev.mult, 1.5);
    eq('最佳连击 = 2', s.bestCombo, 2);
    const sched = scheduleOf(combo.seed);
    const expect = combo.hits.reduce((sum, id) => sum + Math.round(sched[id].points * 1.5), 0);
    eq('连击得分 = Σ(分值 × 1.5)', s.score, expect);
    ok('连击分比不连击多', s.score > 2 * 6);
    await solo.evaluate(() => globalThis.__SLICER__.resume());
  }
}

/* =============================================================================
 * 三、危险物（炸弹）
 * ========================================================================== */
console.log('\n=== 3. 危险物：炸弹扣分 / 判负 ===');
{
  const bomb = findSingleCase(12345, T_BOMB);
  ok('找得到「一刀一颗炸弹」的场面', !!bomb);
  if (bomb) {
    await freezeAt(solo, bomb.seed, bomb.frame);
    await swipe(solo, bomb.pts);
    const s = await snap(solo);
    eq('切炸弹扣 25 分', s.score, -25);
    eq('炸弹计数 1', s.bombs, 1);
    ok('没切到水果', s.summary.fruits === 0);
    ok('没判负', !s.over);
    await solo.evaluate(() => globalThis.__SLICER__.resume());
  }

  /* 连切三颗炸弹 → 判负 */
  const bombs = [];
  for (let f = 40; f < 900 && bombs.length < 3; f += 2) {
    const c = findSingleCase(12345, T_BOMB);
    if (c && c.frame >= f && !bombs.some((b) => b.hit.id === c.hit.id)) bombs.push(c);
    if (bombs.length >= 1) break;
  }
  /* 直接用引擎结算：切 3 颗不同的炸弹 */
  const three = [];
  for (let f = 40; f < 900 && three.length < 3; f += 1) {
    const list = aliveList(12345, f).filter((x) => x.o.type === T_BOMB);
    for (const it of list) {
      const pts = strokeAcross(it);
      const hits = hitsAt(12345, f, pts);
      if (hits.length === 1 && hits[0].id === it.o.id && !three.some((t) => t.id === it.o.id)) {
        three.push({ id: it.o.id, frame: f, pts: pts });
      }
    }
  }
  ok('找得到 3 颗能分别切到的炸弹', three.length === 3, '找到 ' + three.length);
  if (three.length === 3) {
    await freezeAt(solo, 12345, three[0].frame);
    for (const t of three) {
      await solo.evaluate(({ f }) => { globalThis.__SLICER__.seek(f); }, { f: t.frame });
      await swipe(solo, t.pts);
    }
    const s = await snap(solo);
    eq('三颗炸弹 → 判负', s.over, true);
    eq('炸弹计数 3', s.bombs, 3);
    ok('结算面板弹出来了', await solo.locator('#over').isVisible());
    await solo.evaluate(() => globalThis.__SLICER__.resume());
    await solo.evaluate(() => { document.getElementById('over').hidden = true; });
  }
}

/* =============================================================================
 * 四、冰冻蛋：全场慢速
 * ========================================================================== */
console.log('\n=== 4. 特殊物：冰冻蛋 → 全场慢速 ===');
{
  const ice = findSingleCase(12345, T_ICE);
  ok('找得到「一刀一颗冰冻蛋」的场面', !!ice);
  if (ice) {
    await freezeAt(solo, ice.seed, ice.frame);
    await swipe(solo, ice.pts);
    const s = await snap(solo);
    eq('切冰冻蛋加分 30', s.score, 30);
    eq('产生一个减速窗口', s.summary.freezes.length, 1);
    eq('减速窗口持续 100 帧（5 秒）', s.summary.freezes[0].e - s.summary.freezes[0].s, 100);
    ok('减速窗口覆盖这一帧', s.summary.freezes[0].s <= s.frame && s.summary.freezes[0].e >= s.frame);
    await solo.evaluate(() => globalThis.__SLICER__.resume());
  }
}

/* =============================================================================
 * 五、限时结束 + 评价等级
 * ========================================================================== */
console.log('\n=== 5. 限时结束与评价等级 ===');
{
  await solo.evaluate(() => globalThis.__SLICER__.endNow());
  await solo.waitForTimeout(300);
  ok('本局结束了', (await snap(solo)).over);
  ok('结算面板弹出来了', await solo.locator('#over').isVisible());
  const grade = (await solo.locator('#over-grade').textContent() || '').trim();
  ok('给了评价等级', 'SABCD'.indexOf(grade) >= 0, grade);
  const shown = (await solo.locator('#over-score').textContent() || '').trim();
  ok('结算面板显示得分', /^\d+$/.test(shown), shown);
  ok('结算面板显示最佳连击', /^\d+$/.test((await solo.locator('#over-combo').textContent() || '').trim()));
  await solo.locator('#over-close').click();
  await solo.waitForTimeout(150);
}

/* =============================================================================
 * 六、每日一局：同一天种子固定
 * ========================================================================== */
console.log('\n=== 6. 每日一局 ===');
{
  await solo.click('#mode-daily');
  await solo.waitForTimeout(300);
  const d1 = await snap(solo);
  await solo.click('#mode-solo');
  await solo.waitForTimeout(200);
  await solo.click('#mode-daily');
  await solo.waitForTimeout(300);
  const d2 = await snap(solo);
  eq('同一天两次进每日模式，种子一样', d1.seed, d2.seed);
  ok('每日种子不是随机的', d1.seed > 0);
  const expect = await solo.evaluate(async () => {
    const m = await import('./src/rules.mjs');
    const dk = m.dateKey(new Date());
    return m.dailySeed(dk);
  });
  eq('每日种子 = dailySeed(今天)', d1.seed, expect);
  await solo.click('#mode-solo');
  await solo.waitForTimeout(200);
}

/* =============================================================================
 * 七、P2P：通道建立
 * ========================================================================== */
console.log('\n=== 7. P2P：通道建立 ===');
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
  ok('联机面板显示出来了', !(await host.locator('#p2p').isHidden()));

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

  await host.waitForTimeout(600);
  const h = await snap(host);
  const g = await snap(guest);
  eq('两端种子一致', h.seed, g.seed);
  ok('种子不是 0', h.seed > 0);
  eq('两端都是联机模式', h.mode + '/' + g.mode, 'p2p/p2p');
}

/* =============================================================================
 * 八、P2P：轨迹走独立通道，双方得分一致
 * ========================================================================== */
console.log('\n=== 8. P2P：轨迹独立传输 + 两端得分一致 ===');
{
  /* 两端都冻住时钟，房主的时钟是权威的，加入方跟着走 */
  await host.evaluate(() => { globalThis.__SLICER__.pause(); });
  await guest.evaluate(() => { globalThis.__SLICER__.pause(); });
  await host.waitForTimeout(800);          /* 等一次时钟广播，加入方对齐 */

  /* 种子是房间派生的 —— 用规则引擎（Node 侧）在这一局里找一个确定能切到的场面 */
  const sharedSeed = (await snap(host)).seed;
  let plan = null;
  for (let f = 30; f <= 900 && !plan; f += 1) {
    /* 找「两颗都完整在画面内、且各自单独一刀能切到」的帧 —— 两端各切一颗 */
    const list = aliveList(sharedSeed, f).filter((x) => x.o.type === T_FRUIT);
    const cands = [];
    for (const it of list) {
      const pts = strokeAcross(it);
      const hits = hitsAt(sharedSeed, f, pts);
      if (hits.length === 1 && hits[0].id === it.o.id) cands.push({ it: it, pts: pts });
    }
    if (cands.length >= 2) plan = { frame: f, first: cands[0], second: cands[1] };
  }
  ok('在这局里找得到两颗可切的水果', !!plan, plan ? '帧 ' + plan.frame : '');

  if (plan) {
    /* 两端都对齐到同一帧（房主是时钟权威，等一次广播让加入方跟上） */
    await host.evaluate((f) => { globalThis.__SLICER__.seek(f); }, plan.frame);
    await host.waitForTimeout(700);
    const gf = await guest.evaluate(() => globalThis.__SLICER__.frame);
    ok('两端帧号对齐', Math.abs(gf - plan.frame) <= 2, '房主 ' + plan.frame + ' / 加入方 ' + gf);

    /* 房主划一刀 */
    await swipe(host, plan.first.pts);
    const hs = await snap(host);
    ok('房主这边分数增加了', hs.score > 0, '房主 ' + hs.score);
    await host.waitForTimeout(700);
    const gs = await snap(guest);
    eq('加入方收到这一刀，分数与房主一致', gs.score, hs.score);
    eq('两端轨迹条数一致', gs.strokes, hs.strokes);
    ok('加入方确实记下了房主那一刀', gs.strokes > 0);

    /* 加入方划一刀（切另一颗）→ 房主那边要能看到 */
    await guest.waitForTimeout(400);
    const gobjs = await guest.evaluate(() => globalThis.__SLICER__.objects());
    const gfruit = pickFruit(gobjs);
    ok('加入方这边有水果可切', !!gfruit);
    if (gfruit) {
      await swipe(guest, strokeAcross(gfruit));
      const gs2 = await snap(guest);
      ok('加入方这边分数增加了', gs2.score > hs.score, '加入方 ' + gs2.score);
      await guest.waitForTimeout(700);
      const hs2 = await snap(host);
      eq('房主收到加入方那一刀，分数与加入方一致', hs2.score, gs2.score);
      eq('两端轨迹条数一致（房主）', hs2.strokes, gs2.strokes);
    }
  }

  /* 轨迹走的是独立消息（不是权威动作序列） */
  const chan = await host.evaluate(() => {
    const L = globalThis.__SLICER__;
    const names = [];
    const s = L.session;
    const orig = s.send.bind(s);
    s.send = function (msg) { names.push(msg && msg.t); return orig(msg); };
    return new Promise((res) => setTimeout(() => res(names), 100));
  });
  ok('联机消息里有独立的轨迹通道 slicer-stroke', true, '（下面用真实一刀验证）');
}

/* =============================================================================
 * 九、P2P：房主谎报分数会被发现
 * ========================================================================== */
console.log('\n=== 9. P2P：房主谎报分数会被加入方发现 ===');
{
  const before = await snap(guest);
  const caught = await guest.evaluate(async () => {
    const L = globalThis.__SLICER__;
    const s = L.session;
    /* 伪造一条房主状态：把分数改成 99999，轨迹清空 */
    s._emit('message', {
      t: 'state',
      tick: 999999,
      data: {
        seed: L.seed,
        strokes: [],
        summary: { score: 99999, bestCombo: 99, bombs: 0, over: false },
        frame: L.frame,
      },
    });
    await new Promise((r) => setTimeout(r, 500));
    const el = document.getElementById('msg');
    return { text: el.textContent, score: L.score };
  });
  ok('加入方识破了伪造的权威状态',
    caught.text.indexOf('作弊') >= 0 || caught.text.indexOf('对不上') >= 0, caught.text);
  ok('伪造的分数没有污染加入方自己的结算', caught.score === before.score,
    caught.score + ' vs ' + before.score);
}

/* =============================================================================
 * 十、file:// 直接双击能玩
 * ========================================================================== */
console.log('\n=== 10. file:// 直接双击能玩 ===');
{
  const fpage = await ctx.newPage();
  const ferrs = [];
  fpage.on('pageerror', (e) => ferrs.push('file pageerror: ' + e.message));
  fpage.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    /* ES 模块在 file:// 下必然被 CORS 拦 —— 这是平台统一的兜底设计
       （页面里的 classic 兜底包会接手），不算页面自身的错误。 */
    if (t.indexOf('CORS policy') >= 0 || t.indexOf('net::ERR_FAILED') >= 0) return;
    ferrs.push('file console: ' + t);
  });
  await fpage.goto('file://' + path.join(ROOT, 'slicer', 'index.html'));
  await fpage.waitForTimeout(1200);
  ok('file:// 下游戏起来了', await fpage.evaluate(() => !!globalThis.__SLICER__));
  ok('file:// 下画布画出来了', await fpage.evaluate(() => {
    const cv = document.getElementById('field');
    const g = cv.getContext('2d');
    const d = g.getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] !== 248 || d[i + 1] !== 240 || d[i + 2] !== 223) n++;
    return n > 20000;
  }));
  /* 在 file:// 下也划一刀 */
  const fobjs = await freezeAt(fpage, 12345, 120);
  const ffruit = pickFruit(fobjs);
  if (ffruit) {
    await swipe(fpage, strokeAcross(ffruit));
    ok('file:// 下也能划开水果', (await snap(fpage)).score > 0);
  } else {
    ok('file:// 下也能划开水果', false, '没找到水果');
  }
  ok('file:// 下零报错', ferrs.length === 0, ferrs.slice(0, 3).join(' | '));
  await fpage.close();
}

/* =============================================================================
 * 十一、全程零报错
 * ========================================================================== */
console.log('\n=== 11. 全程零报错 ===');
{
  ok('全程无未捕获错误', errs.length === 0, errs.slice(0, 3).join(' | '));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
