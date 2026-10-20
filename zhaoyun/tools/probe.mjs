/* 赵云与阿斗 · 无头 Edge + CDP 冒烟：控制台报错 / 布局 / 塔防交互 / 外部请求 — V5 原版对齐
 * 用法：node tools/probe.mjs   （无头 Edge + CDP）
 * 覆盖：竖屏 375×667 无溢出 / 蛇形主路 37 格 + 右入口「斗」/ 征兵 10+2n 一次 5 张进军营(5 槽) /
 *      军营→手牌拖拽 / 武将字对合成(2 格宽 + 合成武将提示) / 兵器面板装备铁剑(+3) /
 *      拖卡建塔 + 同字合成(刀²) / 拖塔换位(免费,等级/攻速计时保留) / 火球 3×3 / 神兵符 / 毛笔 / 铲子(道具栏) /
 *      波内剩余角标 / 关卡胜利结算(1-5 星) / 竞技双路双阿斗 / 无外部请求 / 无 console error
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
  waveLeft: !!document.getElementById('wave-left'),
  barracks: !!document.getElementById('barracks'),
  dockRow: !!document.querySelector('.dock-row'),
  itemShovel: !!document.getElementById('item-shovel'),
  btnWeapons: !!document.getElementById('btn-weapons'),
  weaponPanel: !!document.getElementById('weapon-panel'),
  saveText: (document.getElementById('save-info').textContent || '').replace(/\\s+/g,' ').trim().slice(0,60)
})`);
ok('脚本全部加载（ZY 命名空间）', boot.zy === 'object', boot.zy);
ok('模块齐全', ['B', 'C', 'Game', 'AI', 'Save', 'UI', 'Audio'].every((k) => boot.mods.includes(k)), boot.mods);
ok('开始界面可见、对局界面隐藏', boot.startVisible && boot.gameHidden);
ok('V5 底栏元素齐全（波内剩余/军营/道具行/兵器弹层）',
  boot.waveLeft && boot.barracks && boot.dockRow && boot.itemShovel && boot.btnWeapons && boot.weaponPanel,
  JSON.stringify(boot).slice(0, 160));
console.log('   存档面板: ' + boot.saveText);

console.log('\n== 进入无尽模式（竖屏布局）==');
await evalJs(`document.querySelector('.mode-btn[data-mode="endless"]').click()`);
await sleep(300);
const g = await evalJs(`({
  gameVisible: !document.getElementById('screen-game').hidden,
  cells: document.querySelectorAll('.cell').length,
  path: document.querySelectorAll('.cell.path').length,
  enter: document.querySelectorAll('.cell.enter').length,
  deploy: document.querySelectorAll('.cell.deploy').length,
  obstacle: document.querySelectorAll('.cell.obstacle').length,
  wasteland: document.querySelectorAll('.cell.wasteland').length,
  handSlots: document.querySelectorAll('#hand .slot').length,
  barSlots: document.querySelectorAll('#barracks .slot').length,
  adou: document.querySelectorAll('.adou').length,
  spawnMark: document.querySelectorAll('.adou.spawn-mark').length,
  bun: document.getElementById('hud-bun').textContent,
  hearts: document.querySelectorAll('#hp-player i.on').length,
  midShown: getComputedStyle(document.getElementById('midline')).display,
  shovelTxt: document.getElementById('item-shovel').textContent,
  waveLeftPos: getComputedStyle(document.getElementById('wave-left')).position
})`);
ok('对局界面显示', g.gameVisible);
ok('棋盘 8×12 = 96 格', g.cells === 96, g.cells + '');
ok('蛇形主路渲染（37 格，棕色地砖）', g.path === 37, g.path + '');
ok('入口格打入口标记（右侧 1 个）', g.enter === 1, g.enter + '');
ok('开局塔位 = 17（绿色可放置格）', g.deploy === 17, g.deploy + '');
ok('荆棘障碍（左右山脊 24 格）', g.obstacle === 24, g.obstacle + '');
ok('荒地（可铲子开塔位）存在', g.wasteland >= 1, g.wasteland + '');
ok('手牌区 8 格', g.handSlots === 8, g.handSlots + '');
ok('军营栏 5 槽', g.barSlots === 5, g.barSlots + '');
ok('阿斗 + 刷怪口「斗」都渲染', g.adou === 2 && g.spawnMark === 1, 'adou=' + g.adou + ' mark=' + g.spawnMark);
ok('开局资源 20', parseInt(g.bun, 10) === 20, g.bun);
ok('阿斗 3 血', g.hearts === 3, g.hearts + '');
ok('无尽模式不显示中线', g.midShown === 'none', g.midShown);
ok('道具栏铲子 ×2', g.shovelTxt.indexOf('×2') >= 0, g.shovelTxt);
ok('波内剩余角标绝对定位在棋盘内', g.waveLeftPos === 'absolute', g.waveLeftPos);

console.log('\n== 棋盘自适应（375×667 竖屏）==');
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

/* ---------------------------------------- 拖拽辅助（页面内执行） */
const DRAG_HELPERS = `
window.__cellXY = (r, c) => {
  const br = document.getElementById('board').getBoundingClientRect();
  return { x: br.left + (c + 0.5) * (br.width / 8), y: br.top + (r + 0.5) * (br.height / 12) };
};
window.__dragFrom = async (sel, tx, ty) => {
  const el = document.querySelector(sel);
  if (!el) return { err: 'no el ' + sel };
  const r = el.getBoundingClientRect();
  const sx = r.left + r.width / 2, sy = r.top + r.height / 2;
  const mk = (type, x, y) => new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', isPrimary: true });
  el.dispatchEvent(mk('pointerdown', sx, sy));
  await new Promise(r2 => setTimeout(r2, 60));
  window.dispatchEvent(mk('pointermove', (sx + tx) / 2, (sy + ty) / 2));
  await new Promise(r2 => setTimeout(r2, 60));
  window.dispatchEvent(mk('pointermove', tx, ty));
  await new Promise(r2 => setTimeout(r2, 60));
  const mid = { hl: document.querySelectorAll('.cell.hl').length, ghost: document.querySelectorAll('.ghost').length };
  window.dispatchEvent(mk('pointerup', tx, ty));
  await new Promise(r2 => setTimeout(r2, 240));
  return { mid: mid, ghostsLeft: document.querySelectorAll('.ghost').length };
};
window.__tapEl = async (sel) => {
  const el = document.querySelector(sel);
  if (!el) return { err: 'no el ' + sel };
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const mk = (type, xx, yy) => new PointerEvent(type, { clientX: xx, clientY: yy, bubbles: true, cancelable: true, pointerId: 2, pointerType: 'touch', isPrimary: true });
  el.dispatchEvent(mk('pointerdown', x, y));
  await new Promise(r2 => setTimeout(r2, 60));
  window.dispatchEvent(mk('pointerup', x, y));
  await new Promise(r2 => setTimeout(r2, 240));
  return { ok: true };
};
window.__dragHold = async (sel, tx, ty) => {
  const el = document.querySelector(sel);
  if (!el) return { err: 'no el ' + sel };
  const r = el.getBoundingClientRect();
  const sx = r.left + r.width / 2, sy = r.top + r.height / 2;
  const mk = (type, x, y) => new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', isPrimary: true });
  el.dispatchEvent(mk('pointerdown', sx, sy));
  await new Promise(r2 => setTimeout(r2, 60));
  window.dispatchEvent(mk('pointermove', (sx + tx) / 2, (sy + ty) / 2));
  await new Promise(r2 => setTimeout(r2, 60));
  window.dispatchEvent(mk('pointermove', tx, ty));
  await new Promise(r2 => setTimeout(r2, 60));
  return { hl: document.querySelectorAll('.cell.hl').length, ghost: document.querySelectorAll('.ghost').length };
};
window.__dragEnd = async (tx, ty) => {
  const mk = (type, x, y) => new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', isPrimary: true });
  window.dispatchEvent(mk('pointermove', tx, ty));
  await new Promise(r2 => setTimeout(r2, 60));
  window.dispatchEvent(mk('pointerup', tx, ty));
  await new Promise(r2 => setTimeout(r2, 240));
  return { ghostsLeft: document.querySelectorAll('.ghost').length };
};
`;

console.log('\n== 征兵（10 起步 +2 不封顶 · 一次 5 张进军营 5 槽）==');
await evalJs(DRAG_HELPERS);
const rec = await evalJs(`(async () => {
  const s = ZY.UI.getState();
  const before = parseInt(document.getElementById('hud-bun').textContent, 10);
  document.getElementById('btn-recruit').click();
  await new Promise(r => setTimeout(r, 300));
  return {
    barCards: document.querySelectorAll('#barracks .card').length,
    handCards: document.querySelectorAll('#hand .card').length,
    bun: parseInt(document.getElementById('hud-bun').textContent, 10),
    before: before,
    cost: s.player.recruitCost,
    btnTxt: document.getElementById('btn-recruit').textContent
  };
})()`);
ok('一次征兵 = 5 张进军营（5 槽）', rec.barCards === 5 && rec.handCards === 0, '军营=' + rec.barCards + ' 手牌=' + rec.handCards);
ok('征兵扣 10 资源', rec.before - rec.bun >= 9 && rec.before - rec.bun <= 11, rec.before + '→' + rec.bun);
ok('征兵成本 10 → 12', rec.cost === 12, 'cost=' + rec.cost);
ok('征兵按钮显示成本（12 资源 / 军营已满）', /12|军营已满/.test(rec.btnTxt), rec.btnTxt);

const cost = await evalJs(`(() => {
  const s = ZY.UI.getState();
  s.player.bun = 300;
  const c1 = s.player.recruitCost;
  s.player.barracks = [];
  document.getElementById('btn-recruit').click();
  const c2 = s.player.recruitCost;
  s.player.barracks = [];
  document.getElementById('btn-recruit').click();
  const c3 = s.player.recruitCost;
  return { c1: c1, c2: c2, c3: c3 };
})()`);
ok('征兵成本每次成功 +2（不封顶）', cost.c2 === cost.c1 + 2 && cost.c3 === cost.c1 + 4, JSON.stringify(cost));

console.log('\n== 军营 → 手牌拖拽（8 格）==');
const stage = await evalJs(`(async () => {
  const s = ZY.UI.getState();
  s.player.barracks = s.player.barracks.slice(0, 1);
  const card = document.querySelector('#barracks .card');
  if (!card) return { err: 'no barracks card' };
  const uid = +card.dataset.uid;
  const hr = document.getElementById('hand').getBoundingClientRect();
  const d = await window.__dragFrom('#barracks .card[data-uid="' + uid + '"]', hr.left + hr.width / 2, hr.top + hr.height / 2);
  return {
    uid: uid, d: d,
    hand: s.player.hand.length, bar: s.player.barracks.length,
    handCard: !!document.querySelector('#hand .card[data-uid="' + uid + '"]'),
    handSlots: document.querySelectorAll('#hand .slot').length
  };
})()`);
ok('军营卡拖到手牌区 = 转入（手牌 +1 / 军营 -1）',
  stage.hand === 1 && stage.bar === 0 && stage.handCard === true && stage.handSlots === 7,
  JSON.stringify({ hand: stage.hand, bar: stage.bar, card: stage.handCard, slots: stage.handSlots }));

console.log('\n== 武将字对合成（赵+云 → 2 格武将卡 + 合成武将提示）==');
const synth = await evalJs(`(async () => {
  const s = ZY.UI.getState();
  s.player.hand = [];
  s.player.hand.push({ uid: 800001, kind: 'gold', char: '赵', level: 1 });
  s.player.hand.push({ uid: 800002, kind: 'gold', char: '云', level: 1 });
  await new Promise(r => setTimeout(r, 260));
  const pairN = document.querySelectorAll('#hand .card.pair').length;
  const tap = await window.__tapEl('#hand .card[data-uid="800001"]');
  await new Promise(r => setTimeout(r, 120));
  const hero = document.querySelector('#hand .card.hero');
  return {
    pairN: pairN,
    tap: tap,
    banner: document.getElementById('banner').textContent,
    bannerShow: document.getElementById('banner').classList.contains('show'),
    heroCard: !!hero,
    heroSpan: hero ? hero.style.gridColumn : null,
    heroChars: hero ? hero.textContent : null,
    handCards: document.querySelectorAll('#hand .card').length,
    toast: document.getElementById('toast').textContent
  };
})()`);
ok('手牌里赵+云 两张金字黄色发光（.pair）', synth.pairN === 2, 'pair=' + synth.pairN);
ok('点金字即合成武将卡（占 2 格）', synth.heroCard === true && synth.heroSpan === 'span 2',
  'span=' + synth.heroSpan + ' cards=' + synth.handCards);
ok('弹出「合成武将」提示', synth.bannerShow && synth.banner.indexOf('合成武将') >= 0, synth.banner);
console.log('   banner: ' + synth.banner + ' · toast: ' + synth.toast);

console.log('\n== 武将卡拖到塔位 = 横跨 2 格建塔 ==');
const heroPlace = await evalJs(`(async () => {
  const s = ZY.UI.getState();
  const card = document.querySelector('#hand .card.hero');
  if (!card) return { err: 'no hero card' };
  const uid = +card.dataset.uid;
  const p = window.__cellXY(1, 5);
  const d = await window.__dragFrom('#hand .card.hero[data-uid="' + uid + '"]', p.x, p.y);
  await new Promise(r => setTimeout(r, 160));
  const el = document.querySelector('.unit.p.hero');
  const br = document.getElementById('board').getBoundingClientRect();
  const cellW = br.width / 8;
  return {
    d: d,
    placed: !!(s.grid[1][5] && s.grid[1][5].cls === 'hero'),
    span2Booked: s.grid[1][6] === s.grid[1][5],
    unitEl: !!el,
    span2Cls: el ? el.classList.contains('span2') : false,
    widthRatio: el ? (el.getBoundingClientRect().width / cellW) : 0,
    name: el ? (el.querySelector('.nm') || {}).textContent : null
  };
})()`);
ok('武将卡落塔位 = 建成武将塔', heroPlace.placed === true && heroPlace.unitEl === true, JSON.stringify(heroPlace).slice(0, 120));
ok('武将塔横跨 2 格（右邻同占 + 宽度 2 格 + span2）',
  heroPlace.span2Booked && heroPlace.span2Cls && Math.abs(heroPlace.widthRatio - 2) < 0.05,
  'booked=' + heroPlace.span2Booked + ' w=' + (heroPlace.widthRatio || 0).toFixed(2));
ok('武将塔显示武将名', heroPlace.name === '赵云', heroPlace.name);

console.log('\n== 兵器面板：铁剑装备武将（攻击 +3）==');
const weapon = await evalJs(`(async () => {
  const s = ZY.UI.getState();
  const hero = s.units.find((u) => u.cls === 'hero' && u.side === 'player');
  const atk0 = hero ? hero.atk : 0;
  document.getElementById('btn-weapons').click();
  await new Promise(r => setTimeout(r, 200));
  const panel = document.getElementById('weapon-panel');
  const shown = !panel.hidden;
  const rows = panel.querySelectorAll('.w-hero').length;
  const btn = panel.querySelector('.w-hero [data-act="equip"]');
  if (btn) btn.click();
  await new Promise(r => setTimeout(r, 240));
  const el = document.querySelector('.unit.p.hero');
  return {
    shown: shown, rows: rows,
    atk0: atk0, atk1: hero ? hero.atk : 0,
    weapon: hero ? hero.weapon : null,
    bag: s.player.weapons.tiejian,
    wpBadge: el ? (el.querySelector('.wp') || {}).textContent : null,
    panelTxt: (panel.textContent || '').replace(/\\s+/g, ' ').slice(0, 60)
  };
})()`);
ok('兵器按钮打开武器背包装备面板', weapon.shown === true && weapon.rows === 1, JSON.stringify({ shown: weapon.shown, rows: weapon.rows }));
ok('铁剑装备给武将（攻击 +3）', weapon.weapon === 'tiejian' && Math.abs(weapon.atk1 - weapon.atk0 - 3) < 1e-6,
  weapon.atk0 + '→' + weapon.atk1);
ok('单位身上出现武器徽标', weapon.wpBadge === '剑', weapon.wpBadge);
console.log('   面板: ' + weapon.panelTxt);

console.log('\n== 拖卡建塔 + 同字合成（刀²）+ 等级角标显隐 ==');
const tower = await evalJs(`(async () => {
  const s = ZY.UI.getState();
  s.player.bun = 300;
  s.player.hand.push({ uid: 555001, kind: 'unit', char: '刀', type: 'dao', level: 1 });
  s.player.hand.push({ uid: 555002, kind: 'unit', char: '刀', type: 'dao', level: 1 });
  await new Promise(r => setTimeout(r, 240));
  const free = [...document.querySelectorAll('.cell.deploy')].find((c) => {
    const r = +c.dataset.r, col = +c.dataset.c;
    return !s.grid[r][col];
  });
  if (!free) return { err: 'no free slot' };
  const row = +free.dataset.r, col = +free.dataset.c;
  const p = window.__cellXY(row, col);
  const d1 = await window.__dragFrom('#hand .card[data-uid="555001"]', p.x, p.y);
  // 落成即快照（之后会被合成改成 2 级）
  const builtObj = s.grid[row][col];
  const builtOk = !!builtObj && builtObj.type === 'dao' && builtObj.level === 1;
  const unitEl0 = builtObj ? document.querySelector('.unit.p[data-uid="' + builtObj.id + '"]') : null;
  const lvEl0 = unitEl0 && unitEl0.querySelector('.lv');
  const lv1 = lvEl0 ? lvEl0.textContent : null;
  const lvSize = lvEl0 ? parseFloat(getComputedStyle(lvEl0).fontSize) : 0;
  const lvVisDefault = lvEl0 ? getComputedStyle(lvEl0).visibility : 'none';   // V6 校准：默认隐藏
  const cardGone = !s.player.hand.some((x) => x.uid === 555001);
  // 拖动第二张同字卡（刀）→ 同字塔等级角标应可见（合成/升级目标提示）
  const hold = await window.__dragHold('#hand .card[data-uid="555002"]', p.x, p.y);
  const elDuring = document.querySelector('.unit.p[data-uid="' + builtObj.id + '"]');
  const lvVisDuringDrag = (elDuring && elDuring.querySelector('.lv')) ? getComputedStyle(elDuring.querySelector('.lv')).visibility : 'none';
  const d2 = await window.__dragEnd(p.x, p.y);   // 松手 → 同字合成（刀²），拖拽结束角标收回
  const t2 = s.grid[row][col];
  const elAfter = t2 ? document.querySelector('.unit.p[data-uid="' + t2.id + '"]') : null;
  const lvVisAfterDrag = (elAfter && elAfter.querySelector('.lv')) ? getComputedStyle(elAfter.querySelector('.lv')).visibility : 'none';
  // 点击该塔（选中）→ 等级角标应可见
  await window.__tapEl('.unit.p[data-uid="' + t2.id + '"]');
  const lvVisOnSelect = (elAfter && elAfter.querySelector('.lv')) ? getComputedStyle(elAfter.querySelector('.lv')).visibility : 'none';
  // 点棋盘空白处（脱离选中）→ 角标再隐藏
  const empty = [...document.querySelectorAll('.cell.deploy')].find((c) => {
    const r = +c.dataset.r, col = +c.dataset.c;
    return !s.grid[r][col];
  });
  if (empty) await window.__tapEl('.cell[data-r="' + +empty.dataset.r + '"][data-c="' + +empty.dataset.c + '"]');
  const lvVisAfterDeselect = (elAfter && elAfter.querySelector('.lv')) ? getComputedStyle(elAfter.querySelector('.lv')).visibility : 'none';
  return {
    d1: d1, d2: d2, row: row, col: col,
    built: builtOk, unitEl0: !!unitEl0, lv1: lv1, lvSize: lvSize, lvVisDefault: lvVisDefault, cardGone: cardGone,
    lvVisDuringDrag: lvVisDuringDrag, lvVisAfterDrag: lvVisAfterDrag, lvVisOnSelect: lvVisOnSelect, lvVisAfterDeselect: lvVisAfterDeselect,
    level2: t2 ? t2.level : -1,
    mergeGone: !s.player.hand.some((x) => x.uid === 555002)
  };
})()`);
ok('拖兵种卡到塔位 = 建塔（出现我方单位）', tower.built === true && tower.unitEl0 === true, JSON.stringify(tower).slice(0, 120));
ok('建塔后卡消失', tower.cardGone === true);
ok('等级角标默认隐藏（visibility:hidden）且字号预留 ≥14px', tower.lvVisDefault === 'hidden' && tower.lvSize >= 14, 'vis=' + tower.lvVisDefault + ' size=' + tower.lvSize);
ok('拖动同字卡时 → 目标同字塔等级角标可见', tower.lvVisDuringDrag === 'visible', 'vis=' + tower.lvVisDuringDrag);
ok('同字卡拖到同字塔 = 刀²（+1 级）', tower.level2 === 2 && tower.mergeGone === true, 'level=' + tower.level2);
ok('拖拽结束后角标收回（隐藏）', tower.lvVisAfterDrag === 'hidden', 'vis=' + tower.lvVisAfterDrag);
ok('点击/选中塔 → 等级角标可见', tower.lvVisOnSelect === 'visible', 'vis=' + tower.lvVisOnSelect);
ok('脱离选中（点空白）→ 角标再隐藏', tower.lvVisAfterDeselect === 'hidden', 'vis=' + tower.lvVisAfterDeselect);
ok('拖拽幽灵已清理', tower.d1 && tower.d1.ghostsLeft === 0 && tower.d2 && tower.d2.ghostsLeft === 0);

console.log('\n== 拖塔换位（免费 · 等级/攻速计时保留 · 非法落点拒绝）==');
const moved = await evalJs(`(async () => {
  const s = ZY.UI.getState();
  const t = s.grid[${tower.row}][${tower.col}];
  if (!t) return { err: 'no tower' };
  s.paused = true;                                   // 冻结仿真：atkT/xp 读数确定，渲染仍每帧同步
  t.xp = 3.6; t.atkT = 0.37;
  const el = document.querySelector('.unit.p[data-uid="' + t.id + '"]');
  const lvBefore = el.querySelector('.lv').textContent;
  const free = [...document.querySelectorAll('.cell.deploy')].find((c) => {
    const r = +c.dataset.r, col = +c.dataset.c;
    return !s.grid[r][col] && !(r === ${tower.row} && col === ${tower.col});
  });
  if (!free) return { err: 'no free slot' };
  const nr = +free.dataset.r, nc = +free.dataset.c;
  const p = window.__cellXY(nr, nc);
  const d = await window.__dragFrom('.unit.p[data-uid="' + t.id + '"]', p.x, p.y);
  const elAfter = document.querySelector('.unit.p[data-uid="' + t.id + '"]');
  const lvAfter = elAfter && elAfter.querySelector('.lv') ? elAfter.querySelector('.lv').textContent : null;
  const er = elAfter ? elAfter.getBoundingClientRect() : null;
  const near = er ? (Math.abs((er.left + er.width / 2) - p.x) < 6 && Math.abs((er.top + er.height / 2) - p.y) < 6) : false;
  // 非法落点：拖到主路格 → 拒绝，塔不动
  const pathCell = document.querySelector('.cell.path');
  const pr = +pathCell.dataset.r, pc = +pathCell.dataset.c;
  const pp = window.__cellXY(pr, pc);
  const d2 = await window.__dragFrom('.unit.p[data-uid="' + t.id + '"]', pp.x, pp.y);
  const toastTxt = document.getElementById('toast').textContent;
  s.paused = false;
  return {
    d: d, d2: d2, nr: nr, nc: nc,
    onNew: s.grid[nr][nc] === t, oldCleared: s.grid[${tower.row}][${tower.col}] === null,
    level: t.level, xp: t.xp, atkT: t.atkT, lvBefore: lvBefore, lvAfter: lvAfter, near: near,
    pathRejected: s.grid[pr][pc] !== t && t.row === nr && t.col === nc,
    toast: toastTxt, ghosts: document.querySelectorAll('.ghost').length
  };
})()`);
ok('拖已建塔到新塔位 = 免费换位（旧格清空）', moved.onNew === true && moved.oldCleared === true, JSON.stringify(moved).slice(0, 120));
ok('换位后等级角标不变（仍为 2）', moved.lvAfter === '2' && moved.level === 2, 'lv=' + moved.lvAfter + ' level=' + moved.level);
ok('换位后单位元素已移到新格中心', moved.near === true);
ok('攻速计时 / 经验原样保留（不重置）', moved.atkT === 0.37 && moved.xp === 3.6, 'atkT=' + moved.atkT + ' xp=' + moved.xp);
ok('拖塔时有落点高亮预览（.hl）', moved.d && moved.d.mid && moved.d.mid.hl >= 1, JSON.stringify(moved.d && moved.d.mid));
ok('拖到主路被拒绝 + toast 提示', moved.pathRejected === true && moved.toast.indexOf('主路') >= 0, moved.toast);
ok('换位/拒绝后拖拽幽灵已清理', moved.ghosts === 0 && moved.d2 && moved.d2.ghostsLeft === 0);

console.log('\n== 道具拖放：火球 / 神兵符 / 毛笔 / 铲子（道具栏）==');
const items = await evalJs(`(async () => {
  const s = ZY.UI.getState();
  const out = {};
  // 先撤下我方全部单位：保证火球伤害读数只有 80（不受守塔攻击干扰）
  s.units.filter((u) => u.side === 'player').forEach((u) => ZY.Game.removeUnit(s, u));
  await new Promise(r => setTimeout(r, 300));
  // —— 火球：3 个聚团敌人钉在主路 (4,3)(4,4)(4,5) ——
  const mk = (r, c) => { const u = ZY.Game.makeUnit(s, 'enemy', { cls: 'soldier', type: 'dao', level: 1, row: r, col: c, target: 'player' }); u.move = 0; u.hp = u.maxHp = 500; ZY.Game.addUnit(s, u); return u.id; };
  const ids = [mk(4, 3), mk(4, 4), mk(4, 5)];
  s.player.hand.push({ uid: 777001, kind: 'item', item: 'fireball' });
  await new Promise(r => setTimeout(r, 200));
  const p = window.__cellXY(4, 4);
  const df = await window.__dragFrom('#hand .card[data-uid="777001"]', p.x, p.y);
  const hp = ids.map((id) => { const u = s.units.find((x) => x.id === id); return u ? u.hp : -1; });
  out.fireball = { d: df, hp: hp, consumed: !s.player.hand.some((x) => x.uid === 777001), boom: document.querySelectorAll('#fx .boom').length };
  // —— 神兵符 ——
  s.player.hand.push({ uid: 777002, kind: 'item', item: 'warcry' });
  await new Promise(r => setTimeout(r, 200));
  const pw = window.__cellXY(6, 4);
  const dw = await window.__dragFrom('#hand .card[data-uid="777002"]', pw.x, pw.y);
  out.warcry = { d: dw, consumed: !s.player.hand.some((x) => x.uid === 777002), buff: s.buff.player };
  // —— 毛笔：先自建一座刀塔，再拖毛笔改写兵种 ——
  const free = [...document.querySelectorAll('.cell.deploy')].find((c) => {
    const r = +c.dataset.r, col = +c.dataset.c;
    return !s.grid[r][col];
  });
  s.player.hand.push({ uid: 555003, kind: 'unit', char: '刀', type: 'dao', level: 1 });
  await new Promise(r => setTimeout(r, 220));
  const fb = window.__cellXY(+free.dataset.r, +free.dataset.c);
  await window.__dragFrom('#hand .card[data-uid="555003"]', fb.x, fb.y);
  const t = s.grid[+free.dataset.r][+free.dataset.c];
  const charBefore = t ? t.char : null;
  s.player.hand.push({ uid: 777004, kind: 'item', item: 'brush' });
  await new Promise(r => setTimeout(r, 200));
  const pb = window.__cellXY(+free.dataset.r, +free.dataset.c);
  const db = await window.__dragFrom('#hand .card[data-uid="777004"]', pb.x, pb.y);
  out.brush = { d: db, consumed: !s.player.hand.some((x) => x.uid === 777004), changed: t ? (t.char !== charBefore) : false, charBefore: charBefore, charAfter: t ? t.char : null };
  // —— 铲子：道具栏拖到荒地 → 扩塔位 ——
  const spot = ZY.B.shovelSpots(s, 'player')[0];
  const before = Object.keys(s.deploy).length;
  const ps = window.__cellXY(spot.row, spot.col);
  const ds = await window.__dragFrom('#item-shovel', ps.x, ps.y);
  const cellEl = document.querySelector('.cell[data-r="' + spot.row + '"][data-c="' + spot.col + '"]');
  out.shovel = {
    d: ds, before: before, after: Object.keys(s.deploy).length,
    cls: cellEl.classList.contains('deploy'),
    count: s.player.items.shovel,
    shovelTxt: document.getElementById('item-shovel').textContent,
    toast: document.getElementById('toast').textContent
  };
  return out;
})()`);
ok('火球拖出即消耗 + 爆炸特效', items.fireball.consumed === true && items.fireball.boom >= 1, JSON.stringify(items.fireball).slice(0, 100));
ok('落点 3×3 内敌人各受 80 伤害', items.fireball.hp.length === 3 && items.fireball.hp.every((h) => h === 420), JSON.stringify(items.fireball.hp));
ok('拖拽时出现落点高亮 + 跟随幽灵', items.fireball.d && items.fireball.d.mid && items.fireball.d.mid.hl === 1 && items.fireball.d.mid.ghost === 1);
ok('神兵符拖出即消耗 + 全队攻击 buff 挂上', items.warcry.consumed === true && items.warcry.buff > 0, JSON.stringify(items.warcry));
ok('毛笔拖己方塔 → 兵种被改写', items.brush.consumed === true && items.brush.changed === true, JSON.stringify(items.brush));
ok('铲子（道具栏）拖荒地 → 塔位 +1 且计数 -1',
  items.shovel.after === items.shovel.before + 1 && items.shovel.cls === true && items.shovel.count === 1 && items.shovel.shovelTxt.indexOf('×1') >= 0,
  JSON.stringify(items.shovel).slice(0, 140));
console.log('   铲子 toast: ' + items.shovel.toast);

console.log('\n== 跑主循环看波次出兵 + 波内剩余角标（轮询至出兵）==');
const runRes = await evalJs(`(async () => {
  let maxE = 0, leftTxt = '', wave = '', warn = 0, pops = 0, simT = 0;
  for (let i = 0; i < 60; i++) {           // 最多轮询 15s
    await new Promise(r => setTimeout(r, 250));
    const s = ZY.UI.getState();
    simT = s.t;
    maxE = Math.max(maxE, s.units.filter((u) => u.side === 'enemy' && !u.dead).length);
    leftTxt = document.getElementById('wave-left').textContent;
    wave = document.getElementById('hud-wave').textContent;
    warn = document.querySelectorAll('.cell.warn').length;
    pops = document.querySelectorAll('#fx .pop').length;
    if (maxE >= 1 && /本波剩 [1-9]/.test(leftTxt)) break;
  }
  return {
    maxE: maxE, leftTxt: leftTxt, wave: wave, warn: warn, pops: pops, simT: simT,
    bun: parseInt(document.getElementById('hud-bun').textContent, 10),
    waveLeftShown: getComputedStyle(document.getElementById('wave-left')).display !== 'none'
  };
})()`);
console.log('   仿真 ' + runRes.simT.toFixed(0) + 's · 峰值场上敌人 ' + runRes.maxE + ' · HUD「' + runRes.wave + '」· 角标「' + runRes.leftTxt + '」· 资源 ' + runRes.bun);
ok('主循环在跑（资源持续增长）', runRes.bun > 15, runRes.bun + '');
ok('波次来袭、敌人沿主路行军（峰值 ≥ 1）', runRes.maxE >= 1, '峰值敌人=' + runRes.maxE);
ok('来袭预警格显示（入口首段 ▼）', runRes.warn >= 1, 'warn=' + runRes.warn);
ok('左下角显示「本波剩 N」', runRes.waveLeftShown && /本波剩 \d/.test(runRes.leftTxt), runRes.leftTxt);

console.log('\n== 关卡胜利结算（1-5 星 · 恭喜晋升 · 金币 +20）==');
await send('Page.navigate', { url: URL });
await sleep(1400);
await evalJs(`document.querySelector('.mode-btn[data-mode="level"]').click()`);
await sleep(300);
const winRes = await evalJs(`(async () => {
  const s = ZY.UI.getState();
  s.player.adou = 3;
  s.wave.done = true; s.wave.idx = 6; s.wave.pending = [];
  s.units = s.units.filter((u) => u.side !== 'enemy');
  await new Promise(r => setTimeout(r, 500));
  const ov = document.getElementById('overlay');
  return {
    hidden: ov.hidden,
    panelCls: (ov.querySelector('.panel') || {}).className,
    title: (ov.querySelector('h2') || {}).textContent,
    starsOn: ov.querySelectorAll('.stars i.on').length,
    starsOff: ov.querySelectorAll('.stars i.off').length,
    promote: (ov.querySelector('.promote') || {}).textContent,
    coin: (ov.querySelector('.coin-row') || {}).textContent,
    double: !!ov.querySelector('[data-act="double"]'),
    next: !!ov.querySelector('[data-act="next"]')
  };
})()`);
ok('胜利结算面板弹出（胜 利）', winRes.hidden === false && winRes.title === '胜 利' && winRes.panelCls.indexOf('win') >= 0,
  JSON.stringify(winRes).slice(0, 140));
ok('评级 1-5 星（3 血快速通关 = 5 星）', winRes.starsOn === 5 && winRes.starsOff === 0, 'on=' + winRes.starsOn + ' off=' + winRes.starsOff);
ok('恭喜晋升 + 金币 +20 + 双倍金币按钮（仅展示）',
  winRes.promote.indexOf('恭喜晋升') >= 0 && winRes.coin.indexOf('+20') >= 0 && winRes.double === true,
  JSON.stringify({ promote: winRes.promote, coin: winRes.coin, double: winRes.double }));

console.log('\n== 竞技双路双阿斗 ==');
await send('Page.navigate', { url: URL });
await sleep(1400);
await evalJs(`document.querySelector('.mode-btn[data-mode="versus"]').click()`);
await sleep(300);
const vs = await evalJs(`({
  path: document.querySelectorAll('.cell.path').length,
  enter: document.querySelectorAll('.cell.enter').length,
  deploy: document.querySelectorAll('.cell.deploy').length,
  adou: document.querySelectorAll('.adou').length,
  spawnMark: document.querySelectorAll('.adou.spawn-mark').length,
  heartsP: document.querySelectorAll('#hp-player i.on').length,
  heartsE: document.querySelectorAll('#hp-enemy i.on').length,
  midShown: getComputedStyle(document.getElementById('midline')).display,
  wave: document.getElementById('hud-wave').textContent,
  waveLeftShown: getComputedStyle(document.getElementById('wave-left')).display !== 'none'
})`);
ok('竞技双蛇形主路渲染（48 格）', vs.path === 48, vs.path + '');
ok('双方入口都有入口标记（2 个）', vs.enter === 2, vs.enter + '');
ok('竞技双方塔位 = 16（各 8）', vs.deploy === 16, vs.deploy + '');
ok('双阿斗都渲染（各 3 血）', vs.adou === 2 && vs.spawnMark === 0 && vs.heartsP === 3 && vs.heartsE === 3, JSON.stringify(vs));
ok('竞技模式显示中线', vs.midShown === 'block', vs.midShown);
ok('HUD 显示波次进度（/15）', vs.wave.indexOf('/15') >= 0, vs.wave);
ok('竞技模式不显示波内剩余角标', vs.waveLeftShown === false);

console.log('\n== V7 美术升级：位图立绘 / 动作动画 / 技能播报 / 纯色棋盘 ==');
await send('Page.navigate', { url: URL });
await sleep(1400);
await evalJs(`document.querySelector('.mode-btn[data-mode="endless"]').click()`);
await sleep(300);
const art = await evalJs(`(async () => {
  const s = ZY.UI.getState();
  s.paused = true;
  const dao  = ZY.Game.makeUnit(s, 'player', { cls:'soldier', type:'dao', level:1, row:1, col:2, target:null });
  ZY.Game.addUnit(s, dao);
  const hero = ZY.Game.makeUnit(s, 'player', { cls:'hero', heroId:'zhaoyun', heroLevel:1, row:1, col:5, span:2, target:null });
  ZY.Game.addUnit(s, hero);
  const zei  = ZY.Game.makeUnit(s, 'enemy', { cls:'soldier', type:'zei', level:1, row:5, col:3, target:'player' });
  ZY.Game.addUnit(s, zei);
  const boss = ZY.Game.makeUnit(s, 'enemy', { cls:'soldier', type:'zei', boss:true, level:1, row:8, col:4, target:'player' });
  ZY.Game.addUnit(s, boss);
  await new Promise(r => setTimeout(r, 460));
  const imgs = [...document.querySelectorAll('.unit .fig-img')];
  const srcOf = el => el && el.querySelector('.fig-img') ? el.querySelector('.fig-img').getAttribute('src') : null;
  const dEl = document.querySelector('.unit.p[data-uid="' + dao.id + '"]');
  const hEl = document.querySelector('.unit.p[data-uid="' + hero.id + '"]');
  const zEl = document.querySelector('.unit.e[data-uid="' + zei.id + '"]');
  const bEl = document.querySelector('.unit.e[data-uid="' + boss.id + '"]');
  let gradientCells = 0;
  document.querySelectorAll('.cell').forEach(c => { if (getComputedStyle(c).backgroundImage.indexOf('repeating-linear-gradient') >= 0) gradientCells++; });
  const pathBg = getComputedStyle(document.querySelector('.cell.path')).backgroundImage;
  const bgOf = sel => { const n = document.querySelector(sel); return n ? getComputedStyle(n).backgroundColor : 'none'; };
  return {
    imgCount: imgs.length,
    allLoaded: imgs.length > 0 && imgs.every(i => i.naturalWidth > 0),
    allAssetSrc: imgs.length > 0 && imgs.every(i => (i.getAttribute('src') || '').indexOf('assets/') === 0),
    daoKey: srcOf(dEl), heroKey: srcOf(hEl), zeiKey: srcOf(zEl), bossKey: srcOf(bEl),
    idleAnim: hEl ? getComputedStyle(hEl.querySelector('.fig-img')).animationName : 'none',
    gradientCells: gradientCells, pathBg: pathBg,
    cPath: bgOf('.cell.path'), cDeploy: bgOf('.cell.deploy'), cWaste: bgOf('.cell.wasteland'),
    cPlain: bgOf('.cell:not(.path):not(.deploy):not(.wasteland):not(.obstacle):not(.enter):not(.break)'),
    wasteCount: document.querySelectorAll('.cell.wasteland').length,
    plainCount: document.querySelectorAll('.cell:not(.path):not(.deploy):not(.wasteland):not(.obstacle):not(.enter):not(.break)').length,
    hasSkillBanner: !!document.getElementById('skill-banner'),
    hasSkillFx: !!document.querySelector('.skill-fx'),
    bossCls: bEl ? bEl.className : '',
    heroLeft: hEl ? Math.round(hEl.getBoundingClientRect().left - document.getElementById('board').getBoundingClientRect().left) : -1,
    heroRight: hEl ? Math.round(hEl.getBoundingClientRect().right - document.getElementById('board').getBoundingClientRect().left) : -1,
    boardW: Math.round(document.getElementById('board').getBoundingClientRect().width),
    ids: { dao: dao.id, hero: hero.id, zei: zei.id, boss: boss.id }
  };
})()`);
ok('V7 场上单位改为位图立绘（.fig-img）', art.imgCount >= 4, 'img=' + art.imgCount);
ok('V7 立绘全为本地 assets/ 且解码成功（naturalWidth>0）', art.allAssetSrc && art.allLoaded, JSON.stringify({ src: art.allAssetSrc, loaded: art.allLoaded }));
ok('V7 立绘映射正确（刀兵/赵云/黄巾/张梁）',
  /daobing/.test(art.daoKey) && /zhaoyun/.test(art.heroKey) && /hj-melee/.test(art.zeiKey) && /zhangliang/.test(art.bossKey),
  [art.daoKey, art.heroKey, art.zeiKey, art.bossKey].join(' | '));
ok('V7 待机跃动动画生效（figIdle）', /figIdle/.test(art.idleAnim), art.idleAnim);
ok('V7 棋盘格子纯色（无 repeating-linear-gradient）+ 主路纯色', art.gradientCells === 0 && art.pathBg === 'none', 'gradient=' + art.gradientCells + ' pathBg=' + art.pathBg);
ok('V7 新增 #skill-banner 与粒子层容器', art.hasSkillBanner && art.hasSkillFx);
ok('V7 Boss 单位带 .boss 标记（金色泛光/放大）', /(^| )boss( |$)/.test(art.bossCls), art.bossCls);
ok('V7 武将（span2）横向落在棋盘内（不再右移出界）',
  art.heroLeft >= 0 && art.heroRight <= art.boardW + 1 && (art.heroRight - art.heroLeft) > art.boardW / 8 * 1.6,
  'left=' + art.heroLeft + ' right=' + art.heroRight + ' boardW=' + art.boardW);

// —— V7.1 棋盘配色：白路 / 棕塔位 / 绿荒地 / 米底 ——
ok('V7.1 敌人主路为白色（#ffffff）', art.cPath === 'rgb(255, 255, 255)', art.cPath);
ok('V7.1 可建塔位为棕色（#8a5a2b）', art.cDeploy === 'rgb(138, 90, 43)', art.cDeploy);
ok('V7.1 可开垦荒地为草绿（#4e7d3a）', art.cWaste === 'rgb(78, 125, 58)' && art.wasteCount > 0, art.cWaste + ' n=' + art.wasteCount);
ok('V7.1 普通空地为浅米/宣纸色（#e8e0c8）', art.cPlain === 'rgb(232, 224, 200)' && art.plainCount > 0, art.cPlain + ' n=' + art.plainCount);
ok('V7.1 四色互不相同（路/塔位/荒地/空地可一眼分辨）',
  new Set([art.cPath, art.cDeploy, art.cWaste, art.cPlain]).size === 4,
  [art.cPath, art.cDeploy, art.cWaste, art.cPlain].join(' | '));

// 攻击动作帧：注入 anim 事件 → .a-atk
const atk = await evalJs(`(async () => {
  const s = ZY.UI.getState();
  s.fx.push({ type: 'anim', uid: ${art.ids.dao} });
  await new Promise(r => setTimeout(r, 90));
  const el = document.querySelector('.unit.p[data-uid="${art.ids.dao}"]');
  return { hasAtk: !!(el && el.classList.contains('a-atk')), cls: el ? el.className : '' };
})()`);
ok('V7 攻击触发 .a-atk 动作类', atk.hasAtk === true, atk.cls);

// 技能播报 + 粒子（赵云 · 横扫剑气）——走真实自动释放链路（验证 game.js → ZY.UI.onSkillCast）
const skill1 = await evalJs(`(async () => {
  const s = ZY.UI.getState();
  const hero = s.units.find(u => u.id === ${art.ids.hero});
  const foe = ZY.Game.makeUnit(s, 'enemy', { cls:'soldier', type:'zei', level:1, row:2, col:5, target:'player' });
  foe.move = 0; foe.hp = foe.maxHp = 9000;
  ZY.Game.addUnit(s, foe);
  await new Promise(r => setTimeout(r, 80));
  hero.skillT = 0;
  s.paused = false;
  await new Promise(r => setTimeout(r, 340));
  s.paused = true;
  const b = document.getElementById('skill-banner');
  return { text: b ? b.textContent : '', shown: b ? b.classList.contains('show') : false,
           parts: document.querySelectorAll('.skill-fx .fx-particle').length, fired: hero.skillT > 0 };
})()`);
ok('V7 技能真正释放 → #skill-banner 播报「横扫剑气！」', skill1.text === '横扫剑气！' && skill1.shown === true, skill1.text + ' fired=' + skill1.fired);
ok('V7 技能粒子生成（6–12 个，≤ 上限 20）', skill1.parts >= 6 && skill1.parts <= 20, 'particles=' + skill1.parts);

// Boss 技能播报（先等 1.5s 防刷屏解除）
const bossSkill = await evalJs(`(async () => {
  await new Promise(r => setTimeout(r, 1600));
  const s = ZY.UI.getState();
  const boss = s.units.find(u => u.id === ${art.ids.boss});
  boss.move = 0; boss.skillT = 0;
  s.paused = false;
  await new Promise(r => setTimeout(r, 220));
  s.paused = true;
  const b = document.getElementById('skill-banner');
  return { text: b ? b.textContent : '', parts: document.querySelectorAll('.skill-fx .fx-particle').length };
})()`);
ok('V7 Boss 技能释放 → 播报「黄天当立！」+ 法阵粒子', bossSkill.text === '黄天当立！' && bossSkill.parts >= 6, bossSkill.text + ' parts=' + bossSkill.parts);

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
