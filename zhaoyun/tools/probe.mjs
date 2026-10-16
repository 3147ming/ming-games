/* 赵云与阿斗 · 无头 Edge + CDP 冒烟：控制台报错 / 布局 / 塔防交互 / 外部请求 — V4
 * 用法：node tools/probe.mjs   （无头 Edge + CDP）
 * 覆盖：蛇形主路渲染（地砖/入口标记）/ 拖卡建塔 / 同字卡拖塔合成+1级（等级角标可见）/
 *      四类道具拖放（神兵符/铲子/火球/毛笔）/ 火球爆炸特效与伤害 / 拖已建塔 toast「塔已固定」/
 *      竞技双路双阿斗 / 棋盘自适应 / 征兵 / 主循环 / 无外部请求 / 无 console error
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
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

console.log('\n== 进入无尽模式 ==');
await evalJs(`document.querySelector('.mode-btn[data-mode="endless"]').click()`);
await sleep(200);
const g = await evalJs(`({
  gameVisible: !document.getElementById('screen-game').hidden,
  cells: document.querySelectorAll('.cell').length,
  path: document.querySelectorAll('.cell.path').length,
  enter: document.querySelectorAll('.cell.enter').length,
  deploy: document.querySelectorAll('.cell.deploy').length,
  obstacle: document.querySelectorAll('.cell.obstacle').length,
  wasteland: document.querySelectorAll('.cell.wasteland').length,
  slots: document.querySelectorAll('#hand .slot').length,
  adou: document.querySelectorAll('.adou').length,
  bun: document.getElementById('hud-bun').textContent,
  hearts: document.querySelectorAll('#hp-player i.on').length,
  midShown: getComputedStyle(document.getElementById('midline')).display
})`);
ok('对局界面显示', g.gameVisible);
ok('棋盘 8×12 = 96 格', g.cells === 96, g.cells + '');
ok('蛇形主路渲染（主路格 = 36，地砖路径一眼可辨）', g.path === 36, g.path + '');
ok('入口格打入口标记（1 个）', g.enter === 1, g.enter + '');
ok('开局塔位 = 8（主路两侧）', g.deploy === 8, g.deploy + '');
ok('障碍地形存在（左右山脊 24 格）', g.obstacle === 24, g.obstacle + '');
ok('荒地（可铲子开塔位）存在', g.wasteland >= 1, g.wasteland + '');
ok('待部署栏 12 格', g.slots === 12, g.slots + '');
ok('阿斗圆标渲染', g.adou === 1, g.adou + '');
ok('开局馒头 24', parseInt(g.bun, 10) >= 24, g.bun);
ok('阿斗 3 血', g.hearts === 3, g.hearts + '');
ok('无尽模式不显示中线', g.midShown === 'none', g.midShown);

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

console.log('\n== 征兵（批量 + 成本递增）==');
await evalJs(`document.getElementById('btn-recruit').click()`);
await sleep(300);
const afterRecruit = await evalJs(`({
  cards: document.querySelectorAll('#hand .card').length,
  bun: parseInt(document.getElementById('hud-bun').textContent, 10)
})`);
ok('一次征兵得到 3 张牌（批量）', afterRecruit.cards === 3, afterRecruit.cards + '');
ok('征兵扣 12 馒头（含自然收入）', afterRecruit.bun >= 11 && afterRecruit.bun <= 14, afterRecruit.bun + '');

const cost = await evalJs(`(() => {
  const s = ZY.UI.getState();
  s.player.bun = 300;
  const c1 = s.player.recruitCost;
  document.getElementById('btn-recruit').click();
  const c2 = s.player.recruitCost;
  document.getElementById('btn-recruit').click();
  const c3 = s.player.recruitCost;
  return { c1: c1, c2: c2, c3: c3 };
})()`);
ok('征兵成本每次成功 +1（12→13→14）', cost.c2 === cost.c1 + 1 && cost.c3 === cost.c1 + 2, JSON.stringify(cost));

/* ---------------------------------------- 拖拽辅助（页面内执行） */
const DRAG_HELPERS = `
window.__cellXY = (r, c) => {
  const br = document.getElementById('board').getBoundingClientRect();
  return { x: br.left + (c + 0.5) * (br.width / 8), y: br.top + (r + 0.5) * (br.height / 12) };
};
window.__dragCard = async (uid, tx, ty) => {
  const card = document.querySelector('#hand .card[data-uid="' + uid + '"]');
  if (!card) return { err: 'no card ' + uid };
  const cr = card.getBoundingClientRect();
  const sx = cr.left + cr.width / 2, sy = cr.top + cr.height / 2;
  const mk = (type, x, y) => new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', isPrimary: true });
  card.dispatchEvent(mk('pointerdown', sx, sy));
  await new Promise(r => setTimeout(r, 60));
  window.dispatchEvent(mk('pointermove', (sx + tx) / 2, (sy + ty) / 2));
  await new Promise(r => setTimeout(r, 60));
  window.dispatchEvent(mk('pointermove', tx, ty));
  await new Promise(r => setTimeout(r, 60));
  const mid = { hl: document.querySelectorAll('.cell.hl').length, ghost: document.querySelectorAll('.ghost').length };
  window.dispatchEvent(mk('pointerup', tx, ty));
  await new Promise(r => setTimeout(r, 220));
  return { mid: mid, ghostsLeft: document.querySelectorAll('.ghost').length };
};
`;

console.log('\n== 道具拖放：火球（拖到主路，3×3 爆炸 + 80 伤害）==');
await evalJs(DRAG_HELPERS);
const fb = await evalJs(`(async () => {
  ${'' /* 注入 3 个聚团敌人（主路 (4,3)(4,4)(4,5)，钉住）+ 一张火球卡 */}
  const s = ZY.UI.getState();
  s.player.bun = 300;
  const mk = (r, c) => { const u = ZY.Game.makeUnit(s, 'enemy', { cls: 'soldier', type: 'dao', level: 1, row: r, col: c, target: 'player' }); u.move = 0; u.hp = u.maxHp = 500; ZY.Game.addUnit(s, u); return u.id; };
  const ids = [mk(4, 3), mk(4, 4), mk(4, 5)];
  s.player.hand.push({ uid: 777001, kind: 'item', item: 'fireball' });
  await new Promise(r => setTimeout(r, 200));
  const p = window.__cellXY(4, 4);
  const drag = await window.__dragCard(777001, p.x, p.y);
  await new Promise(r => setTimeout(r, 120));
  const hp = ids.map((id) => { const u = s.units.find((x) => x.id === id); return u ? u.hp : -1; });
  return {
    drag: drag,
    hp: hp,
    consumed: !s.player.hand.some((x) => x.uid === 777001),
    boom: document.querySelectorAll('#fx .boom').length,
    toast: document.getElementById('toast').textContent
  };
})()`);
ok('拖拽时出现落点高亮 + 跟随幽灵', fb.drag && fb.drag.mid && fb.drag.mid.hl === 1 && fb.drag.mid.ghost === 1, JSON.stringify(fb.drag));
ok('火球拖出即消耗（无论命中）', fb.consumed === true);
ok('爆炸特效节点出现（.boom）', fb.boom >= 1, 'boom=' + fb.boom);
ok('落点 3×3 内敌人各受 80 伤害', fb.hp.length === 3 && fb.hp.every((h) => h === 420), JSON.stringify(fb.hp));
console.log('   toast: ' + fb.toast);

console.log('\n== 拖卡建塔 + 同字合成 + 等级角标 ==');
const tower = await evalJs(`(async () => {
  const s = ZY.UI.getState();
  s.player.bun = 300;
  s.player.hand.push({ uid: 555001, kind: 'unit', char: '刀', type: 'dao', level: 1 });
  s.player.hand.push({ uid: 555002, kind: 'unit', char: '刀', type: 'dao', level: 1 });
  await new Promise(r => setTimeout(r, 200));
  // 挑一个空格塔位
  const free = [...document.querySelectorAll('.cell.deploy')].find((c) => {
    const r = +c.dataset.r, col = +c.dataset.c;
    return !s.grid[r][col];
  });
  if (!free) return { err: 'no free slot' };
  const row = +free.dataset.r, col = +free.dataset.c;
  const p = window.__cellXY(row, col);
  const d1 = await window.__dragCard(555001, p.x, p.y);
  const built = s.grid[row][col];
  const unitEl = built ? document.querySelector('.unit.p[data-uid="' + built.id + '"]') : null;
  return {
    d1: d1,
    built: !!built && built.type === 'dao' && built.level === 1,
    cardGone: !s.player.hand.some((x) => x.uid === 555001),
    unitEl: !!unitEl,
    row: row, col: col,
    lvText: unitEl ? (unitEl.querySelector('.lv') || {}).textContent : null,
    lvSize: unitEl && unitEl.querySelector('.lv') ? parseFloat(getComputedStyle(unitEl.querySelector('.lv')).fontSize) : 0
  };
})()`);
ok('拖兵种卡到塔位 = 建塔（出现我方单位）', tower.built === true && tower.unitEl === true, JSON.stringify(tower).slice(0, 120));
ok('建塔后卡消失', tower.cardGone === true);
ok('等级角标 .lv 常显且字号醒目（≥14px）', tower.lvText === '1' && tower.lvSize >= 14, 'text=' + tower.lvText + ' size=' + tower.lvSize);
ok('拖拽幽灵已清理', tower.d1 && tower.d1.ghostsLeft === 0);

const merge = await evalJs(`(async () => {
  const s = ZY.UI.getState();
  const p = window.__cellXY(${tower.row}, ${tower.col});
  const d = await window.__dragCard(555002, p.x, p.y);
  const t = s.grid[${tower.row}][${tower.col}];
  const unitEl = t ? document.querySelector('.unit.p[data-uid="' + t.id + '"]') : null;
  return {
    d: d,
    level: t ? t.level : -1,
    cardGone: !s.player.hand.some((x) => x.uid === 555002),
    lvText: unitEl ? (unitEl.querySelector('.lv') || {}).textContent : null,
    toast: document.getElementById('toast').textContent
  };
})()`);
ok('同字卡拖到同字塔上 = 合成 +1 级', merge.level === 2 && merge.cardGone === true, 'level=' + merge.level);
ok('等级角标数字变为 2', merge.lvText === '2', 'lv=' + merge.lvText);

const fixed = await evalJs(`(async () => {
  const s = ZY.UI.getState();
  const t = s.grid[${tower.row}][${tower.col}];
  if (!t) return { err: 'no tower' };
  const el = document.querySelector('.unit.p[data-uid="' + t.id + '"]');
  const r = el.getBoundingClientRect();
  const mk = (type, x, y) => new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 3, pointerType: 'touch', isPrimary: true });
  el.dispatchEvent(mk('pointerdown', r.left + r.width / 2, r.top + r.height / 2));
  await new Promise(r2 => setTimeout(r2, 60));
  const p = window.__cellXY(0, 0);
  window.dispatchEvent(mk('pointermove', p.x, p.y));
  await new Promise(r2 => setTimeout(r2, 60));
  window.dispatchEvent(mk('pointerup', p.x, p.y));
  await new Promise(r2 => setTimeout(r2, 200));
  return { toast: document.getElementById('toast').textContent, still: !!s.grid[${tower.row}][${tower.col}], ghosts: document.querySelectorAll('.ghost').length };
})()`);
ok('拖已建塔 = 无操作 + toast「塔已固定」', fixed.toast.indexOf('塔已固定') >= 0 && fixed.still === true, fixed.toast);

console.log('\n== 道具拖放：神兵符 / 铲子 / 毛笔 ==');
const items = await evalJs(`(async () => {
  const s = ZY.UI.getState();
  const out = {};
  // —— 神兵符：拖到任意位置即释放（全局 buff）——
  s.player.hand.push({ uid: 777002, kind: 'item', item: 'warcry' });
  await new Promise(r => setTimeout(r, 160));
  const pw = window.__cellXY(6, 4);
  const dw = await window.__dragCard(777002, pw.x, pw.y);
  out.warcry = { consumed: !s.player.hand.some((x) => x.uid === 777002), buff: s.buff.player, toast: document.getElementById('toast').textContent };
  // —— 铲子：拖到荒地塔位 → +1 塔位 ——
  const spot = ZY.B.shovelSpots(s, 'player')[0];
  s.player.hand.push({ uid: 777003, kind: 'item', item: 'shovel' });
  await new Promise(r => setTimeout(r, 160));
  const before = Object.keys(s.deploy).length;
  const ps = window.__cellXY(spot.row, spot.col);
  const ds = await window.__dragCard(777003, ps.x, ps.y);
  const cellEl = document.querySelector('.cell[data-r="' + spot.row + '"][data-c="' + spot.col + '"]');
  out.shovel = { consumed: !s.player.hand.some((x) => x.uid === 777003), before: before, after: Object.keys(s.deploy).length, cls: cellEl.classList.contains('deploy'), toast: document.getElementById('toast').textContent };
  // —— 毛笔：拖到己方塔 → 改写兵种 ——
  s.player.hand.push({ uid: 777004, kind: 'item', item: 'brush' });
  await new Promise(r => setTimeout(r, 160));
  const t = s.grid[${tower.row}][${tower.col}];
  const charBefore = t ? t.char : null;
  const pb = window.__cellXY(${tower.row}, ${tower.col});
  const db = await window.__dragCard(777004, pb.x, pb.y);
  out.brush = { consumed: !s.player.hand.some((x) => x.uid === 777004), changed: t ? (t.char !== charBefore) : false, charBefore: charBefore, charAfter: t ? t.char : null };
  return out;
})()`);
ok('神兵符拖出即消耗 + 全队攻击 buff 挂上', items.warcry.consumed === true && items.warcry.buff > 0, JSON.stringify(items.warcry));
ok('铲子拖荒地 → 塔位 +1 且格子高亮', items.shovel.consumed === true && items.shovel.after === items.shovel.before + 1 && items.shovel.cls === true, JSON.stringify(items.shovel));
ok('毛笔拖己方塔 → 兵种被改写', items.brush.consumed === true && items.brush.changed === true, JSON.stringify(items.brush));
console.log('   神兵符 toast: ' + items.warcry.toast);

console.log('\n== 跑 20 秒看主循环（波次出兵）==');
await sleep(20000);
const runRes = await evalJs(`({
  units: document.querySelectorAll('#units .unit').length,
  enemies: document.querySelectorAll('#units .unit.e').length,
  onPath: [...document.querySelectorAll('#units .unit.e')].filter((u) => {
    const m = /translate\\(([-\\d.]+)%,\\s*([-\\d.]+)%\\)/.exec(u.style.transform) || [];
    return m.length === 3;
  }).length,
  bun: parseInt(document.getElementById('hud-bun').textContent, 10),
  wave: document.getElementById('hud-wave').textContent,
  warn: document.querySelectorAll('.cell.warn').length,
  pops: document.querySelectorAll('#fx .pop').length
})`);
console.log('   单位 ' + runRes.units + '（敌 ' + runRes.enemies + '）· 馒头 ' + runRes.bun + ' · HUD「' + runRes.wave + '」· 预警格 ' + runRes.warn);
ok('主循环在跑（馒头持续增长）', runRes.bun > 15, runRes.bun + '');
ok('波次来袭、敌人已出兵（沿主路行军）', runRes.enemies >= 1, 'enemies=' + runRes.enemies);
ok('来袭预警格显示（入口首段 ▼）', runRes.warn >= 1, 'warn=' + runRes.warn);

console.log('\n== 竞技双路双阿斗（重开竞技）==');
await send('Page.navigate', { url: URL });
await sleep(1400);
await evalJs(`document.querySelector('.mode-btn[data-mode="versus"]').click()`);
await sleep(200);
const vs = await evalJs(`({
  path: document.querySelectorAll('.cell.path').length,
  enter: document.querySelectorAll('.cell.enter').length,
  deploy: document.querySelectorAll('.cell.deploy').length,
  adou: document.querySelectorAll('.adou').length,
  heartsP: document.querySelectorAll('#hp-player i.on').length,
  heartsE: document.querySelectorAll('#hp-enemy i.on').length,
  midShown: getComputedStyle(document.getElementById('midline')).display,
  wave: document.getElementById('hud-wave').textContent
})`);
ok('竞技双蛇形主路渲染（48 格）', vs.path === 48, vs.path + '');
ok('双方入口都有入口标记（2 个）', vs.enter === 2, vs.enter + '');
ok('竞技双方塔位 = 16（各 8）', vs.deploy === 16, vs.deploy + '');
ok('双阿斗都渲染（各 3 血）', vs.adou === 2 && vs.heartsP === 3 && vs.heartsE === 3, JSON.stringify(vs));
ok('竞技模式显示中线', vs.midShown === 'block', vs.midShown);
ok('HUD 显示波次进度（/15）', vs.wave.indexOf('/15') >= 0, vs.wave);

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
