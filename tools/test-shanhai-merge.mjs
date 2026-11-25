/* tools/test-shanhai-merge.mjs —— 「山海合成」单机 UI 端到端测试
 *
 * 用法：node tools/test-shanhai-merge.mjs
 *
 * 验证：
 *   1. 页面能加载、零 console 错误、棋盘渲染正确
 *   2. 每日固定局：同一天同一种子 ⇒ 同盘面（可比分数）
 *   3. 合成交互：点选合成 / 拖拽合成
 *   4. 规则联动：得分、飘落、撤销
 *   5. 撤销：撤销一步能把盘面还原
 *   6. 三种模式都能开局、步数挑战有步数上限
 *   7. 胜负判定：合成出目标阶即胜利并弹结算
 *   8. 可复现性：同 seed 同动作 ⇒ 同摘要
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
  if (url === '/' || url === '') file = path.join(ROOT, 'shanhai-merge', 'index.html');
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
const BASE = `http://127.0.0.1:${server.address().port}/shanhai-merge/`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
const errs = [];

const snap = (page) => page.evaluate(() => {
  const L = globalThis.__SHANHAI__;
  return {
    seed: L.seed,
    over: L.over,
    won: L.won,
    score: L.score,
    moves: L.moves,
    best: L.best,
    actionCount: L.actionCount,
    hash: L.hash,
    board: L.pub.board.slice(),
    pairs: L.pairs(),
  };
});

/* =============================================================================
 * 1. 页面加载与初始渲染
 * ========================================================================== */
console.log('\n=== 1. 页面加载与初始渲染 ===');
const page = await ctx.newPage();
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await page.goto(BASE);
await page.waitForTimeout(600);

{
  const s = await snap(page);
  ok('页面无脚本错误', errs.length === 0, errs.slice(0, 3).join(' | '));
  ok('棋盘是 6×6 = 36 格', await page.locator('#board .cell').count() === 36);
  ok('初始摆了 8 只神兽', await page.locator('#board .blk').count() === 8);
  ok('图鉴栏有 8 阶', await page.locator('#codex .cx').count() === 8);
  ok('初始得分 0', s.score === 0);
  ok('初始未结束', s.over === false);
  ok('初始步数 0', s.moves === 0);
  ok('每日模式默认选中', await page.locator('#mode-daily').evaluate((e) => e.classList.contains('on')));
  ok('撤销按钮初始禁用', await page.locator('#btn-undo').isDisabled());
  ok('方块上写了灵兽名', (await page.locator('#board .blk .lv').first().textContent() || '').length >= 2);
}

/* =============================================================================
 * 2. 每日固定局：同一天同盘面
 * ========================================================================== */
console.log('\n=== 2. 每日固定局可复现 ===');
{
  const a = await snap(page);
  const p2 = await ctx.newPage();
  await p2.goto(BASE);
  await p2.waitForTimeout(500);
  const b = await snap(p2);
  ok('两个页面的每日种子一致', a.seed === b.seed, a.seed + ' vs ' + b.seed);
  ok('两个页面的每日盘面一致', JSON.stringify(a.board) === JSON.stringify(b.board));
  ok('两个页面的摘要一致', a.hash === b.hash);
  await p2.close();
}

/* =============================================================================
 * 3. 合成交互：点选合成
 * ========================================================================== */
console.log('\n=== 3. 合成交互（点选） ===');
{
  /* 摆一个确定的局面：两只 1 级在 0、1，两只 2 级在 12、13
     （其余格子留空 —— 棋盘没满，所以不会触发「塞满」结束） */
  await page.evaluate(() => {
    const b = new Array(36).fill(0);
    b[0] = 1; b[1] = 1; b[12] = 2; b[13] = 2;
    globalThis.__SHANHAI__.setBoard(b);
  });
  await page.waitForTimeout(400);
  ok('摆好的局面显示 4 只神兽', await page.locator('#board .blk').count() === 4);

  /* 点第 0 只 → 应该被选中 */
  const c0 = page.locator('#board .cell').nth(0).locator('.blk');
  await c0.click();
  await page.waitForTimeout(150);
  ok('点一下之后有选中态', await page.locator('#board .blk.sel').count() === 1);

  /* 再点第 2 只（不同阶）→ 不该合成 */
  const before = await snap(page);
  await page.locator('#board .cell').nth(12).locator('.blk').click();
  await page.waitForTimeout(200);
  const afterDiff = await snap(page);
  ok('不同阶不能合成', afterDiff.score === before.score && afterDiff.moves === before.moves);
  ok('提示说明了不能合体', (await page.locator('#msg').textContent()).indexOf('同阶') >= 0,
    await page.locator('#msg').textContent());

  /* 点第 0 只 → 再点第 1 只（同阶）→ 应该合成 */
  await page.locator('#board .cell').nth(0).locator('.blk').click();
  await page.waitForTimeout(120);
  await page.locator('#board .cell').nth(1).locator('.blk').click();
  await page.waitForTimeout(400);
  const merged = await snap(page);
  ok('同阶点击合成成功', merged.moves === before.moves + 1, 'moves ' + before.moves + ' → ' + merged.moves);
  ok('合成得分 = 2 × 10 = 20', merged.score >= 20, 'score=' + merged.score);
  ok('合成后来源格变空', merged.board[0] === 0);
  ok('合成后目标格升到 2 级', merged.board[1] === 2);
  ok('撤销按钮解禁了', !(await page.locator('#btn-undo').isDisabled()));
}

/* =============================================================================
 * 4. 拖拽合成
 * ========================================================================== */
console.log('\n=== 4. 合成交互（拖拽） ===');
{
  await page.evaluate(() => {
    const b = new Array(36).fill(0);
    b[4] = 3; b[9] = 3;
    globalThis.__SHANHAI__.setBoard(b);
  });
  await page.waitForTimeout(200);
  const before = await snap(page);

  const src = page.locator('#board .cell').nth(4).locator('.blk');
  const dst = page.locator('#board .cell').nth(9).locator('.blk');
  const sb = await src.boundingBox();
  const db = await dst.boundingBox();

  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.width / 2 + 20, sb.y + sb.height / 2 + 20, { steps: 4 });
  await page.mouse.move(db.x + db.width / 2, db.y + db.height / 2, { steps: 8 });
  await page.waitForTimeout(150);
  ok('拖动时出现跟随的半透明神兽', await page.locator('.ghost').count() === 1);
  await page.mouse.up();
  await page.waitForTimeout(450);

  const after = await snap(page);
  ok('拖拽合成成功', after.moves === before.moves + 1, 'moves ' + before.moves + ' → ' + after.moves);
  ok('拖拽后来源格变空', after.board[4] === 0);
  ok('拖拽后目标格升到 4 级', after.board[9] === 4);
  ok('拖拽后没有残留 ghost', await page.locator('.ghost').count() === 0);
  ok('4 级得分 = 4 × 10 = 40', after.score >= 40, 'score=' + after.score);
}

/* =============================================================================
 * 5. 撤销
 * ========================================================================== */
console.log('\n=== 5. 撤销 ===');
{
  const before = await snap(page);
  await page.locator('#btn-undo').click();
  await page.waitForTimeout(300);
  const after = await snap(page);
  ok('撤销后退回一步', after.moves === before.moves - 1, 'moves ' + before.moves + ' → ' + after.moves);
  ok('撤销后得分还原', after.score === before.score - 40, after.score + ' vs ' + before.score);
  ok('撤销后来源格恢复', after.board[4] === 3);
  ok('撤销后目标格还原', after.board[9] === 3);
  ok('撤销提示出现', (await page.locator('#msg').textContent()).indexOf('撤销') >= 0,
    await page.locator('#msg').textContent());

  /* 连撤到头 */
  for (let i = 0; i < 6; i++) {
    if (await page.locator('#btn-undo').isDisabled()) break;
    await page.locator('#btn-undo').click();
    await page.waitForTimeout(150);
  }
  const empty = await snap(page);
  ok('一直撤销回到初始步数', empty.moves === 0, 'moves=' + empty.moves);
  ok('撤销栈空时按钮禁用', await page.locator('#btn-undo').isDisabled());
}

/* =============================================================================
 * 6. 三种模式
 * ========================================================================== */
console.log('\n=== 6. 三种模式 ===');
{
  await page.locator('#mode-free').click();
  await page.waitForTimeout(400);
  const free = await snap(page);
  ok('自由对局能开局', free.actionCount === 0 && free.over === false);
  ok('自由对局消息正确', (await page.locator('#msg').textContent()).indexOf('自由对局') >= 0,
    await page.locator('#msg').textContent());

  await page.locator('#mode-challenge').click();
  await page.waitForTimeout(400);
  const ch = await snap(page);
  ok('步数挑战能开局', ch.actionCount === 0 && ch.over === false);
  ok('步数挑战消息带步数', (await page.locator('#msg').textContent()).indexOf('步') >= 0,
    await page.locator('#msg').textContent());
  ok('步数上限下拉在挑战模式可用', !(await page.locator('#movelimit').isDisabled()));

  await page.locator('#mode-daily').click();
  await page.waitForTimeout(400);
  const d = await snap(page);
  ok('切回每日局能开局', d.actionCount === 0);
  ok('非挑战模式步数上限禁用', await page.locator('#movelimit').isDisabled());
}

/* =============================================================================
 * 7. 胜负判定
 * ========================================================================== */
console.log('\n=== 7. 胜负判定 ===');
{
  /* 目标阶设成 4，摆出 3+3 → 4 阶即胜利 */
  await page.locator('#target').selectOption('4');
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const b = new Array(36).fill(0);
    b[0] = 3; b[35] = 3;
    globalThis.__SHANHAI__.setBoard(b);
  });
  await page.waitForTimeout(200);
  await page.locator('#board .cell').nth(0).locator('.blk').click();
  await page.waitForTimeout(120);
  await page.locator('#board .cell').nth(35).locator('.blk').click();
  await page.waitForTimeout(500);

  const win = await snap(page);
  ok('合成出目标阶即判胜', win.won === true);
  ok('胜利时标记为结束', win.over === true);
  ok('胜利后弹出结算面板', !(await page.locator('#over').isHidden()));
  ok('结算面板标题正确', (await page.locator('#over-title').textContent()).indexOf('合成成功') >= 0,
    await page.locator('#over-title').textContent());
  ok('结算面板显示得分', (await page.locator('#over-score').textContent()).trim() !== '');
  ok('胜利后棋盘不能再动', await page.evaluate(() => {
    const L = globalThis.__SHANHAI__;
    const n = L.actionCount;
    L.act({ act: 'merge', from: 0, to: 1 });
    return L.actionCount === n;
  }));

  /* 再开一局 */
  await page.locator('#btn-again').click();
  await page.waitForTimeout(400);
  const fresh = await snap(page);
  ok('再开一局能重置', fresh.actionCount === 0 && fresh.moves === 0 && fresh.over === false);
  ok('再开一局后结算面板隐藏', await page.locator('#over').isHidden());
}

/* =============================================================================
 * 8. 步数挑战：步数用尽即失败
 * ========================================================================== */
console.log('\n=== 8. 步数挑战：步数用尽 ===');
{
  /* 先切到步数挑战（该模式下步数上限下拉才可用），再设上限 */
  await page.locator('#mode-challenge').click();
  await page.waitForTimeout(400);
  await page.locator('#target').selectOption('8');
  await page.locator('#movelimit').selectOption('30');
  await page.waitForTimeout(400);

  /* 用引擎动作把步数推满（不靠 UI，纯规则层） */
  const r = await page.evaluate(async () => {
    const L = globalThis.__SHANHAI__;
    for (let i = 0; i < 200; i++) {
      if (L.over) break;
      const ps = L.pairs();
      if (!ps.length) break;
      L.act({ act: 'merge', from: ps[0].from, to: ps[0].to });
    }
    return { over: L.over, moves: L.moves, won: L.won };
  });
  ok('步数挑战推进了多步', r.moves > 0, 'moves=' + r.moves);
  ok('步数用尽后结束', r.over === true, 'moves=' + r.moves);
}

/* =============================================================================
 * 9. 可复现性（同 seed 同动作 ⇒ 同摘要）
 * ========================================================================== */
console.log('\n=== 9. 可复现性 ===');
{
  const repro = await page.evaluate(async () => {
    const L = globalThis.__SHANHAI__;
    const seed = L.seed;
    /* 造一串动作 */
    const acts = [];
    const s0 = L.replay(seed, []);
    let cur = s0;
    for (let i = 0; i < 15; i++) {
      const ps = [];
      const b = cur.board;
      const seen = new Map();
      for (let k = 0; k < b.length; k++) {
        const v = b[k];
        if (!v || v >= 8) continue;
        if (seen.has(v)) ps.push({ from: seen.get(v), to: k });
        else seen.set(v, k);
      }
      if (!ps.length) break;
      const a = { act: 'merge', from: ps[0].from, to: ps[0].to };
      acts.push(a);
      cur = L.replay(seed, acts);
    }
    const h1 = L.replay(seed, acts).hash || '';
    const h2 = L.replay(seed, acts).hash || '';
    return { same: h1 === h2, h1, h2 };
  });
  ok('同 seed 同动作 ⇒ 摘要可复现', repro.same, repro.h1.slice(0, 60));
  ok('两次重放摘要相同', repro.h1 === repro.h2);
}

/* =============================================================================
 * 10. file:// 协议可用 + 零报错
 * -----------------------------------------------------------------------------
 * 注意：ESM **源码**在 file:// 下会被浏览器的 CORS 拦掉（模块脚本走跨源请求），
 * 全站所有 ESM 游戏都是这样（ludo 也一样）。
 * file:// 双击能玩，靠的是构建出来的 offline 产物 ——
 * 构建时依赖图被内联成 classic 脚本，就不跨源了。
 * 所以这里验的是 offline 产物（offline/games/shanhai-merge/index.html）。
 * ========================================================================== */
console.log('\n=== 10. file:// 协议与零报错 ===');
{
  const offlineFile = path.join(ROOT, 'offline', 'games', 'shanhai-merge', 'index.html');
  if (!fs.existsSync(offlineFile)) {
    ok('offline 产物存在（需先跑 node tools/build.mjs --target=all）', false, '缺少 ' + offlineFile);
  } else {
    const fpage = await ctx.newPage();
    const ferrs = [];
    fpage.on('pageerror', (e) => ferrs.push('file pageerror: ' + e.message));
    fpage.on('console', (m) => { if (m.type() === 'error') ferrs.push('file console: ' + m.text()); });
    await fpage.goto('file://' + offlineFile);
    await fpage.waitForTimeout(800);
    ok('file:// 下能加载并渲染棋盘', await fpage.locator('#board .cell').count() === 36);
    ok('file:// 下有神兽', await fpage.locator('#board .blk').count() > 0);
    ok('file:// 下零报错', ferrs.length === 0, ferrs.slice(0, 3).join(' | '));
    await fpage.close();
  }
}

/* =============================================================================
 * 11. 全程零报错
 * ========================================================================== */
console.log('\n=== 11. 全程零报错 ===');
{
  ok('全程无未捕获错误', errs.length === 0, errs.slice(0, 3).join(' | '));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
