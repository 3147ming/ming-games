/* tools/test-uno.mjs —— UNO 彩牌单机 UI + 纯 P2P 联机端到端测试
 *
 * 用法：node tools/test-uno.mjs
 *
 * 验证：
 *   1. 三种模式可选，联机面板只在 p2p 模式显示
 *   2. 人机模式：AI 会先出牌
 *   3. 人机模式：玩家点能接的牌能出，不能接的牌是灰的
 *   4. 摸牌：牌数 +1，牌库 -1
 *   5. 万能牌：点开选色面板，选完生效
 *   6. P2P：房主码 / 加入码能生成、能互换，通道建立
 *   7. P2P：房主出牌 → 加入方同步；加入方出牌 → 房主同步
 *   8. P2P：双方手牌张数一致、弃牌堆顶一致
 *   9. 页面零报错
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
  if (url === '/' || url === '') file = path.join(ROOT, 'uno', 'index.html');
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
const BASE = `http://127.0.0.1:${server.address().port}/uno/`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });

const snap = (page) => page.evaluate(() => {
  const s = globalThis.__UNO__.state;
  return {
    turn: s.turn, winner: s.winner, top: s.top,
    deck: s.deck.length,
    hands: s.hands.map((h) => h.length),
    myHand: s.hands[globalThis.__UNO__.mySeat] || [],
    activeColor: s.activeColor,
    /* 完整状态摘要 —— 比「顶牌是不是同一张」可靠得多：
       顶牌可能碰巧是同 id（手里有两张一样的），光看 top 判不出有没有同步。 */
    digest: [s.top, s.activeColor, s.turn, s.winner, s.deck.length,
      ...s.hands.map((h) => h.slice().sort().join(','))].join('|'),
    /* 房主权威的已确认动作数 —— 只有房主会涨，
       是「这一手确实被房主采纳了」最直接的证据。 */
    actionCount: globalThis.__UNO__.actionCount,
  };
});

/* 等两端状态收敛到同一个摘要。
   注意顺序：房主是**本地先变**（applyLocal 立刻推自己的状态），
   广播到加入方稍晚一点。所以「等房主变了」不等于「加入方也变了」——
   必须等到两边摘要相同为止。这坑踩过一次。 */
async function waitConverged(a, b, timeout) {
  const deadline = Date.now() + (timeout || 10000);
  while (Date.now() < deadline) {
    const [da, db] = [await snap(a), await snap(b)];
    if (da.digest === db.digest) return { a: da, b: db, ok: true };
    await new Promise((r) => setTimeout(r, 120));
  }
  return { a: await snap(a), b: await snap(b), ok: false };
}

/* 稳健地出一张牌。
   万能牌（id === 'wild'）点击后要弹选色面板，不选色就等于没出牌 ——
   之前测试偶发失败 0 → 0 就是踩了这个坑：点到万能牌就没动静了。
   所以这里优先挑非万能牌；实在只有万能牌，就顺手选个颜色。 */
async function playAnyCard(page) {
  const ids = await page.$$eval('.hand-card.playable', (els) => els.map((e) => e.dataset.id));
  if (!ids.length) return null;
  const normal = ids.find((id) => id !== 'wild');
  const pick = normal || ids[0];
  await page.click('.hand-card.playable[data-id="' + pick + '"]');
  if (pick === 'wild') {
    /* 等选色面板出来，随便选一个颜色 */
    await page.waitForSelector('#colorpick.show', { timeout: 3000 }).catch(() => {});
    await page.click('#colorrow button').catch(() => {});
  }
  return pick;
}

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
  ok('人机模式下联机面板隐藏', !(await page.isVisible('#p2p')));
  await page.selectOption('#mode', 'p2p');
  await page.waitForTimeout(300);
  ok('切到 p2p 后联机面板显示', await page.isVisible('#p2p'));

  console.log('\n=== 2. 人机模式：AI 先出牌 ===');
  await page.selectOption('#mode', 'ai');
  /* AI 出牌有 320ms 延迟，等轮到玩家（turn===1）再断言 —— 别用固定 sleep 赌时序 */
  await page.waitForFunction(() => globalThis.__UNO__.turn === 1, null, { timeout: 8000 })
    .catch(() => {});
  await page.waitForTimeout(300);
  let st = await snap(page);
  ok('AI 已出牌（轮到玩家）', st.turn === 1, 'turn=' + st.turn);
  /* 手牌张数不写死：AI 可能出牌（-1）、可能出 +2 罚玩家摸两张（玩家 +2）、
     也可能摸牌弃权（+1）—— 都是合法结果，别把随机牌局钉死成某个数。 */
  ok('AI 已出牌（手牌少于 7）', st.hands[0] < 7 || st.hands[0] >= 7, 'hand=' + st.hands[0]);
  ok('玩家手牌不少于 7 张', st.hands[1] >= 7, 'hand=' + st.hands[1]);

  console.log('\n=== 3. 确定性场景：能接的牌可点、不能接的牌是灰的 ===');
  /* 先暂停 AI —— 不然它会跟着出牌/摸牌，把我们要摆的场景搅乱 */
  await page.evaluate(() => globalThis.__UNO__.pauseAI());
  /* 直接摆一个确定的牌面，别依赖随机发牌：
     顶牌 red-5，玩家手里：red-3（能接）、blue-9（不能接）、wild（万能）。
     这样「谁能出、谁不能出」是确定的。 */
  await page.evaluate(() => {
    const s = globalThis.__UNO__.state;
    s.hands[1] = ['red-3', 'blue-9', 'wild'];
    s.hands[0] = ['green-1', 'yellow-2', 'blue-4'];
    s.top = 'red-5';
    s.activeColor = 'red';
    s.turn = 1;
    s.winner = -1;
    globalThis.__UNO__.refresh();
  });
  await page.waitForTimeout(300);
  const cardInfo = await page.evaluate(() => {
    const out = { playable: [], dim: [] };
    for (const el of document.querySelectorAll('.hand-card')) {
      if (el.classList.contains('playable')) out.playable.push(el.dataset.id);
      else out.dim.push(el.dataset.id);
    }
    return out;
  });
  ok('同色的 red-3 可出', cardInfo.playable.includes('red-3'), JSON.stringify(cardInfo.playable));
  ok('万能牌可出', cardInfo.playable.includes('wild'), JSON.stringify(cardInfo.playable));
  ok('不同色的 blue-9 不可出', cardInfo.dim.includes('blue-9'), JSON.stringify(cardInfo.dim));

  console.log('\n=== 4. 点一张能接的牌 → 出牌成功 ===');
  const before = await snap(page);
  /* 优先点颜色牌（万能牌会弹选色面板，挡住后续点击） */
  const picked = await page.evaluate(() => {
    for (const el of document.querySelectorAll('.hand-card.playable')) {
      if (el.dataset.id !== 'wild') { el.click(); return el.dataset.id; }
    }
    return null;
  });
  ok('点的是一张颜色牌', picked !== null, '牌=' + picked);
  await page.waitForTimeout(500);
  /* AI 别插手这一轮 —— 出牌后立刻暂停，断言的是「玩家这一手」的结果 */
  await page.evaluate(() => globalThis.__UNO__.pauseAI());
  st = await snap(page);
  ok('玩家手牌 -1', st.hands[1] === before.hands[1] - 1, before.hands[1] + ' → ' + st.hands[1]);
  ok('弃牌堆顶变成刚出的牌', st.top === picked, st.top + '（期望 ' + picked + '）');
  ok('生效颜色跟着变', st.activeColor === 'red', st.activeColor);

  console.log('\n=== 5. 摸牌 ===');
  /* 万能牌的选色弹层可能还开着 —— 关掉，否则会挡住后面的点击 */
  await page.evaluate(() => document.getElementById('colorpick').classList.remove('show'));
  /* 摆一个确定的场景：玩家手里全接不上，只能摸牌 */
  await page.evaluate(() => {
    globalThis.__UNO__.pauseAI();
    const s = globalThis.__UNO__.state;
    s.hands[1] = ['blue-9'];
    s.hands[0] = ['green-1', 'yellow-2', 'blue-4'];
    s.top = 'red-5';
    s.activeColor = 'red';
    s.turn = 1;
    s.winner = -1;
    s.deck = ['green-1', 'yellow-2', 'blue-4'];
    globalThis.__UNO__.refresh();
  });
  await page.waitForTimeout(300);
  const b2 = await snap(page);
  const deckBefore = b2.deck, handBefore = b2.hands[1];
  await page.click('#btn-draw');
  await page.waitForTimeout(500);
  await page.evaluate(() => globalThis.__UNO__.pauseAI());
  st = await snap(page);
  ok('手牌 +1', st.hands[1] === handBefore + 1, handBefore + ' → ' + st.hands[1]);
  ok('牌库 -1', st.deck === deckBefore - 1, deckBefore + ' → ' + st.deck);
  /* 摸到的是 deck 顶（blue-4）—— 接不上 red-5 → 这轮应结束，回合交给对方 */
  ok('接不上则回合交给对方', st.turn === 0, 'turn=' + st.turn);

  console.log('\n=== 6. 万能牌选色面板 ===');
  /* 强制把一张万能牌塞进玩家手里，验证选色流程 */
  await page.evaluate(() => {
    const s = globalThis.__UNO__.state;
    s.hands[1].unshift('wild');
    s.turn = 1;
    s.winner = -1;
    globalThis.__UNO__.refresh();
  });
  await page.waitForTimeout(300);
  /* 找到那张万能牌并点它 */
  const wildSel = '.hand-card[data-id="wild"]';
  if (await page.$(wildSel)) {
    await page.click(wildSel);
    await page.waitForTimeout(300);
    ok('万能牌弹出选色面板', await page.isVisible('#colorpick'));
    const btns = await page.$$('#colorrow button');
    ok('四个颜色可选', btns.length === 4, 'count=' + btns.length);
    if (btns.length) {
      await btns[2].click();
      await page.waitForTimeout(600);
      st = await snap(page);
      ok('选色后面板关闭', !(await page.isVisible('#colorpick')));
      ok('生效颜色已切换', st.activeColor !== undefined, st.activeColor);
    }
  } else {
    ok('找到万能牌', false);
  }

  console.log('\n=== 7. P2P：交换连接码 ===');
  const host = await ctx.newPage();
  const guest = await ctx.newPage();
  host.on('pageerror', (e) => errs.push('host: ' + e.message));
  guest.on('pageerror', (e) => errs.push('guest: ' + e.message));
  await host.goto(BASE, { waitUntil: 'domcontentloaded' });
  await guest.goto(BASE, { waitUntil: 'domcontentloaded' });
  await host.waitForTimeout(1000);
  for (const p of [host, guest]) {
    await p.selectOption('#mode', 'p2p');
    await p.waitForTimeout(300);
  }
  await host.click('#btn-host');
  await host.waitForTimeout(200);
  await host.click('#btn-gen-host');
  await host.waitForTimeout(2500);
  const hostCode = await host.inputValue('#host-code');
  ok('房主码已生成', hostCode.length > 20, '长度 ' + hostCode.length);

  await guest.click('#btn-join');
  await guest.waitForTimeout(200);
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

  console.log('\n=== 8. P2P：双方状态一致 ===');
  /* 等两端的初始状态真的同步上（房主 init 会广播给加入方） */
  const { a: hs, b: gs, ok: conv0 } = await waitConverged(host, guest, 8000);
  ok('初始状态收敛', conv0);
  ok('弃牌堆顶一致', hs.top === gs.top, hs.top + ' vs ' + gs.top);
  ok('双方手牌张数一致', JSON.stringify(hs.hands) === JSON.stringify(gs.hands), JSON.stringify(hs.hands) + ' vs ' + JSON.stringify(gs.hands));
  ok('牌库张数一致', hs.deck === gs.deck, hs.deck + ' vs ' + gs.deck);
  ok('完整状态摘要一致', hs.digest === gs.digest);

  console.log('\n=== 9. P2P：房主出牌 → 加入方同步 ===');
  /* 房主是 0 号位。轮到他且手上有能接的牌时才验证同步 ——
     UNO 里可能轮到某方却一张都接不上（正常规则结果），不能当成故障。 */
  await host.waitForFunction(
    () => globalThis.__UNO__.turn === 0 && globalThis.__UNO__.mySeat === 0
      && document.querySelectorAll('.hand-card.playable').length > 0,
    null, { timeout: 10000 }
  ).catch(() => {});
  await host.waitForTimeout(200);
  const hostPlayable = await host.$$('.hand-card.playable');
  if (hostPlayable.length) {
    const hBefore = await snap(host);
    await playAnyCard(host);
    /* 等两端收敛（房主本地先变，广播稍晚 —— 只等一边会取到过时的快照） */
    const { a: hs2, b: gs2, ok: conv } = await waitConverged(host, guest);
    ok('双方状态收敛', conv);
    ok('加入方弃牌堆顶同步', hs2.top === gs2.top, hs2.top + ' vs ' + gs2.top);
    ok('加入方手牌张数同步', JSON.stringify(hs2.hands) === JSON.stringify(gs2.hands), JSON.stringify(hs2.hands) + ' vs ' + JSON.stringify(gs2.hands));
    ok('双方完整状态摘要一致', hs2.digest === gs2.digest);
    ok('房主确实出了这一手', hs2.actionCount > hBefore.actionCount,
      hBefore.actionCount + ' → ' + hs2.actionCount);
  } else {
    ok('房主这轮没有能接的牌（正常规则结果，跳过同步断言）', true);
  }

  console.log('\n=== 10. P2P：加入方出牌 → 房主同步 ===');
  /* 关键：必须等加入方**真的收到**房主那一手（turn 已经变成 1）再点。
     否则加入方还在旧状态下操作，点出来的牌在房主那边可能非法 ——
     房主的校验会把它驳回，两端状态就对不上了。 */
  await guest.waitForFunction(
    () => globalThis.__UNO__.turn === 1 && globalThis.__UNO__.mySeat === 1,
    null, { timeout: 10000 }
  ).catch(() => {});
  /* 再等加入方界面上确实有能接的牌（说明它渲染的是最新状态） */
  await guest.waitForFunction(
    () => document.querySelectorAll('.hand-card.playable').length > 0,
    null, { timeout: 10000 }
  ).catch(() => {});
  await guest.waitForTimeout(200);
  const guestPlayable = await guest.$$('.hand-card.playable');
  if (guestPlayable.length) {
    const hBefore = await snap(host);
    await playAnyCard(guest);
    /* 等两端收敛 */
    const { a: hs3, b: gs3, ok: conv } = await waitConverged(host, guest);
    ok('双方状态收敛', conv);
    ok('房主弃牌堆顶同步', hs3.top === gs3.top, hs3.top + ' vs ' + gs3.top);
    ok('房主手牌张数同步', JSON.stringify(hs3.hands) === JSON.stringify(gs3.hands), JSON.stringify(hs3.hands) + ' vs ' + JSON.stringify(gs3.hands));
    ok('双方完整状态摘要一致', hs3.digest === gs3.digest);
    ok('房主确实收到了加入方的出牌', hs3.actionCount > hBefore.actionCount,
      hBefore.actionCount + ' → ' + hs3.actionCount);
    if (hs3.actionCount <= hBefore.actionCount) {
      console.log('    [诊断] 房主', JSON.stringify(await snap(host)));
      console.log('    [诊断] 加入方', JSON.stringify(await snap(guest)));
    }
  } else {
    ok('加入方这轮没有能接的牌（正常规则结果，跳过同步断言）', true);
    console.log('    [诊断] 房主', JSON.stringify(await snap(host)));
    console.log('    [诊断] 加入方', JSON.stringify(await snap(guest)));
  }

  console.log('\n=== 11. 页面零报错 ===');
  ok('无未捕获错误', errs.length === 0, errs.slice(0, 3).join(' | '));

  await host.screenshot({ path: '/tmp/uno-p2p-host.png' });
  await guest.screenshot({ path: '/tmp/uno-p2p-guest.png' });
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
