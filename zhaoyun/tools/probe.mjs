/* 赵云与阿斗 · 无头 Edge + CDP 冒烟：控制台报错 / 布局 / 交互 / 外部请求 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
// 用法：node tools/probe.mjs   （无头 Edge + CDP）
const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
const URL = 'file:///' + INDEX.replace(/\\/g, '/');
const PORT = 9333;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--mute-audio',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=C:/Users/31474/AppData/Local/Temp/zy-probe-profile',
  '--allow-file-access-from-files',
  '--window-size=390,844',
  'about:blank',
], { stdio: 'ignore' });

async function waitPort() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/version'); if (r.ok) return await r.json(); } catch (e) { /* retry */ }
    await sleep(300);
  }
  throw new Error('Edge 未启动');
}

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  → ' + x : '')); } };

await waitPort();
// 用页面级 target（/json/version 给的是浏览器级端点，没有 Runtime.evaluate）
let target = null;
for (let i = 0; i < 40 && !target; i++) {
  const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
  target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!target) await sleep(300);
}
if (!target) throw new Error('找不到 page target');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });

let mid = 0;
const pending = new Map();
const consoleErrors = [];
const pageErrors = [];
const requests = [];

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
    consoleErrors.push(m.params.type + ': ' + (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' '));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    pageErrors.push((m.params.exceptionDetails.exception?.description) || m.params.exceptionDetails.text);
  }
  if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url);
};
const send = (method, params = {}) => {
  const id = ++mid;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((r) => pending.set(id, r));
};
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval error');
  return r.result?.result?.value;
}

await send('Runtime.enable');
await send('Page.enable');
await send('Log.enable');
await send('Network.enable');
// 竖屏 375×667（模拟移动端）
await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 667, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: URL });
await sleep(1400);

console.log('\n== 加载与控制台 ==');
const boot = await evalJs(`({
  zy: typeof window.ZY,
  mods: window.ZY ? Object.keys(window.ZY).sort().join(',') : '',
  startVisible: !document.getElementById('screen-start').hidden,
  gameHidden: document.getElementById('screen-game').hidden,
  saveText: (document.getElementById('save-info').textContent || '').replace(/\\s+/g,' ').trim().slice(0,60)
})`);
ok('脚本全部加载（ZY 命名空间）', boot.zy === 'object', boot.zy);
ok('模块齐全', ['B', 'C', 'Game', 'AI', 'Save', 'UI', 'Audio'].every((k) => boot.mods.includes(k)), boot.mods);
ok('开始界面可见、对局界面隐藏', boot.startVisible && boot.gameHidden);
console.log('   存档面板: ' + boot.saveText);

console.log('\n== 进入竞技模式 ==');
await evalJs(`document.querySelector('.mode-btn[data-mode="versus"]').click()`);
await sleep(900);
const g = await evalJs(`({
  gameVisible: !document.getElementById('screen-game').hidden,
  cells: document.querySelectorAll('.cell').length,
  locked: document.querySelectorAll('.cell.locked').length,
  slots: document.querySelectorAll('#hand .slot').length,
  adou: document.querySelectorAll('.adou').length,
  bun: document.getElementById('hud-bun').textContent,
  hearts: document.querySelectorAll('#hp-player i.on').length,
  midShown: getComputedStyle(document.getElementById('midline')).display
})`);
ok('对局界面显示', g.gameVisible);
ok('棋盘 8×12 = 96 格', g.cells === 96, g.cells + '');
ok('竞技双方各 4 个锁定格', g.locked === 8, g.locked + '');
ok('待部署栏 6 格', g.slots === 6, g.slots + '');
ok('双方阿斗都渲染', g.adou === 2, g.adou + '');
ok('开局馒头 24', parseInt(g.bun, 10) >= 24, g.bun);
ok('阿斗 3 血', g.hearts === 3, g.hearts + '');
ok('竞技模式显示中线', g.midShown === 'block', g.midShown);

console.log('\n== 棋盘自适应（375×667）==');
const box = await evalJs(`(() => {
  const b = document.getElementById('board').getBoundingClientRect();
  const doc = document.documentElement;
  return { w: Math.round(b.width), h: Math.round(b.height), top: Math.round(b.top), bottom: Math.round(b.bottom),
           vh: window.innerHeight, overflowY: doc.scrollHeight - doc.clientHeight, overflowX: doc.scrollWidth - doc.clientWidth };
})()`);
console.log('   棋盘 ' + box.w + '×' + box.h + '  视口高 ' + box.vh + '  棋盘底部 ' + box.bottom);
ok('棋盘贴合 8:12 比例', Math.abs(box.w / box.h - 8 / 12) < 0.02, (box.w / box.h).toFixed(3));
ok('棋盘完整落在视口内', box.bottom <= box.vh + 1 && box.top >= -1, 'top=' + box.top + ' bottom=' + box.bottom);
ok('无文档级滚动溢出', box.overflowY <= 0 && box.overflowX <= 0, 'y=' + box.overflowY + ' x=' + box.overflowX);

console.log('\n== 征兵 ==');
await evalJs(`document.getElementById('btn-recruit').click()`);
await sleep(300);
const afterRecruit = await evalJs(`({
  cards: document.querySelectorAll('#hand .card').length,
  bun: parseInt(document.getElementById('hud-bun').textContent, 10)
})`);
ok('征兵得到 1 张牌', afterRecruit.cards === 1, afterRecruit.cards + '');
ok('征兵扣 12 馒头（含自然收入）', afterRecruit.bun >= 11 && afterRecruit.bun <= 14, afterRecruit.bun + '');

console.log('\n== 拖拽部署（pointer 事件模拟）==');
const dragRes = await evalJs(`(async () => {
  const card = document.querySelector('#hand .card');
  const board = document.getElementById('board');
  if (!card) return { err: 'no card' };
  const br = board.getBoundingClientRect();
  const cw = br.width / 8, ch = br.height / 12;
  // 挑一个「己方半区 + 未锁定 + 没有单位」的格子
  const free = [...document.querySelectorAll('.cell')].filter((c) => {
    return +c.dataset.r === 9 && !c.classList.contains('locked');
  });
  const occupied = new Set([...document.querySelectorAll('#units .unit')].map((u) => {
    const m = /translate\\(([-\\d.]+)%,\\s*([-\\d.]+)%\\)/.exec(u.style.transform) || [];
    return m[1] + ',' + m[2];
  }));
  const pick = free.find((c) => !occupied.has(c.dataset.c * 100 + ',' + 900)) || free[0];
  if (!pick) return { err: 'no free cell' };
  const target = { row: +pick.dataset.r, col: +pick.dataset.c };
  const tx = br.left + (target.col + 0.5) * cw;
  const ty = br.top + (target.row + 0.5) * ch;
  const cr = card.getBoundingClientRect();
  const sx = cr.left + cr.width / 2, sy = cr.top + cr.height / 2;
  const mk = (type, x, y) => new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', isPrimary: true });
  card.dispatchEvent(mk('pointerdown', sx, sy));
  await new Promise(r => setTimeout(r, 60));
  window.dispatchEvent(mk('pointermove', (sx + tx) / 2, (sy + ty) / 2));
  await new Promise(r => setTimeout(r, 60));
  window.dispatchEvent(mk('pointermove', tx, ty));
  await new Promise(r => setTimeout(r, 60));
  const hl = document.querySelectorAll('.cell.hl').length;
  const ghost = document.querySelectorAll('.ghost').length;
  window.dispatchEvent(mk('pointerup', tx, ty));
  await new Promise(r => setTimeout(r, 200));
  const mine = [...document.querySelectorAll('#units .unit.p')].map((u) => u.textContent);
  return {
    hl, ghost,
    units: document.querySelectorAll('#units .unit').length,
    mineCount: mine.length,
    handCards: document.querySelectorAll('#hand .card').length,
    ghostsLeft: document.querySelectorAll('.ghost').length,
    unitText: mine.join('|'),
    toast: document.getElementById('toast').textContent
  };
})()`);
ok('拖拽时出现落点高亮', dragRes.hl === 1, 'hl=' + dragRes.hl);
ok('拖拽时出现跟随幽灵', dragRes.ghost === 1, 'ghost=' + dragRes.ghost);
ok('松手后落子成功（出现我方单位）', dragRes.mineCount >= 1, 'mine=' + dragRes.mineCount + ' toast=' + dragRes.toast);
ok('手牌被消耗', dragRes.handCards === 0, dragRes.handCards + '');
ok('幽灵元素已清理', dragRes.ghostsLeft === 0, dragRes.ghostsLeft + '');
console.log('   落子内容: ' + JSON.stringify(dragRes.unitText));

console.log('\n== 道具点击使用 ==');
// 手塞一张神兵符进手牌，模拟点击 → 应消耗该牌并挂上攻击加成
const itemRes = await evalJs(`(async () => {
  const s = ZY.UI.getState();
  // uid 必须是数字：手牌的 pointerdown 会对 dataset.uid 做 parseInt
  s.player.hand.push({ uid: 987654, kind: 'item', item: 'warcry' });
  s.player.bun = 100;
  document.getElementById('btn-recruit').click();   // 征一张牌顺便刷新手牌区
  await new Promise(r => setTimeout(r, 120));
  const before = document.querySelectorAll('#hand .card').length;
  const card = [...document.querySelectorAll('#hand .card')].find(c => /神兵符|符/.test(c.textContent));
  if (!card) return { err: '手牌里找不到神兵符', hand: document.getElementById('hand').textContent };
  // 手牌走 pointerdown / pointerup 判定（原地松手 = 点击），不是 click
  const r = card.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const mk = (type) => new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 2, pointerType: 'touch', isPrimary: true });
  card.dispatchEvent(mk('pointerdown'));
  await new Promise(r2 => setTimeout(r2, 80));
  window.dispatchEvent(mk('pointerup'));
  await new Promise(r2 => setTimeout(r2, 250));
  return {
    before,
    after: document.querySelectorAll('#hand .card').length,
    buff: ZY.UI.getState().buff.player,
    stillInHand: ZY.UI.getState().player.hand.some(x => x.item === 'warcry'),
    banner: document.getElementById('banner').textContent
  };
})()`);
if (itemRes.err) {
  ok('能点击使用道具（神兵符）', false, itemRes.err);
} else {
  ok('点击道具后被消耗', itemRes.stillInHand === false && itemRes.after === itemRes.before - 1,
    '手牌 ' + itemRes.before + ' → ' + itemRes.after);
  ok('神兵符生效（全队攻击加成已挂上）', itemRes.buff > 0, 'buff=' + itemRes.buff + 's');
}

console.log('\n== 跑 6 秒看主循环 ==');
await sleep(6000);
const runRes = await evalJs(`({
  units: document.querySelectorAll('#units .unit').length,
  bun: parseInt(document.getElementById('hud-bun').textContent, 10),
  wave: document.getElementById('hud-wave').textContent,
  pops: document.querySelectorAll('#fx .pop').length
})`);
console.log('   单位 ' + runRes.units + ' · 馒头 ' + runRes.bun + ' · HUD「' + runRes.wave + '」');
ok('主循环在跑（馒头持续增长）', runRes.bun > 15, runRes.bun + '');
ok('AI 已出兵（同屏有敌方单位）', runRes.units > 1, runRes.units + '');

console.log('\n== 外部请求检查 ==');
const external = requests.filter((u) => !u.startsWith('file://') && !u.startsWith('data:') && !u.startsWith('blob:'));
ok('无任何外部网络请求', external.length === 0, external.join(' | '));
console.log('   本次加载共 ' + requests.length + ' 条请求（全部应为本地 file://）');

console.log('\n== 控制台 ==');
ok('无 page error', pageErrors.length === 0, pageErrors.join(' | '));
ok('无 console error', consoleErrors.filter((e) => e.startsWith('error')).length === 0, consoleErrors.join(' | '));
if (consoleErrors.length) console.log('   警告: ' + consoleErrors.join(' | '));

// 截图（仅本地留存，不作为交付物）
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('C:/Users/31474/AppData/Local/Temp/zy-probe.png', Buffer.from(shot.result.data, 'base64'));
console.log('   截图: C:/Users/31474/AppData/Local/Temp/zy-probe.png');

console.log('\n──────────────────────────────');
console.log('通过 ' + pass + ' / ' + (pass + fail) + (fail ? '  ❌ 失败 ' + fail : '  ✅ 全部通过'));
ws.close();
proc.kill();
process.exit(fail ? 1 : 0);
