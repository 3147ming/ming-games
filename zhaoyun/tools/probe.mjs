/* 赵云与阿斗 · 无头 Edge + CDP 冒烟：控制台报错 / 布局 / 塔防交互 / 外部请求 — V8.1
 * 用法：node tools/probe.mjs   （无头 Edge + CDP）
 * 覆盖：全端强制横屏（竖持旋转态 / 横屏 / PC 三档布局 + 旋转态坐标命中 + 无遮罩无暂停）/
 *      蛇形主路 28 格 + 右入口 (0,7)「斗」/ 新数值面板（刀 4.40 · 敌 +25%）/ 武将名牌侧置 /
 *      征兵 10+2n 一次 5 张进军营(5 槽) /
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
ok('蛇形主路渲染（V8.1 缩短到 28 格）', g.path === 28, g.path + '');
ok('入口格打入口标记（右侧 1 个）', g.enter === 1, g.enter + '');
ok('开局塔位 = 17（绿色可放置格）', g.deploy === 17, g.deploy + '');
ok('荆棘障碍（V8.1 随图派生 29 格：左右山脊 21 + 内部岩块 8）', g.obstacle === 29, g.obstacle + '');
ok('荒地 ≥ 8（V8.1 重排后 9 格，可铲子开塔位）', g.wasteland >= 8, g.wasteland + '');
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
  const el = document.getElementById('board');
  const doc = document.documentElement;
  // 旋转态 bbox 宽高互换：比例用 offsetWidth/offsetHeight（布局尺寸），视口贴合仍用 bbox
  return { w: Math.round(b.width), h: Math.round(b.height), lw: el.offsetWidth, lh: el.offsetHeight,
           top: Math.round(b.top), bottom: Math.round(b.bottom),
           vh: window.innerHeight, overflowY: doc.scrollHeight - doc.clientHeight, overflowX: doc.scrollWidth - doc.clientWidth };
})()`);
console.log('   棋盘 ' + box.w + '×' + box.h + '  布局 ' + box.lw + '×' + box.lh + '  视口高 ' + box.vh + '  棋盘底部 ' + box.bottom);
ok('棋盘贴合 8:12 比例', Math.abs(box.lw / box.lh - 8 / 12) < 0.02, (box.lw / box.lh).toFixed(3));
ok('棋盘完整落在视口内', box.bottom <= box.vh + 1 && box.top >= -1, 'top=' + box.top + ' bottom=' + box.bottom);
ok('无文档级滚动溢出', box.overflowY <= 0 && box.overflowX <= 0, 'y=' + box.overflowY + ' x=' + box.overflowX);

/* ---------------------------------------- 拖拽辅助（页面内执行） */
const DRAG_HELPERS = `
window.__cellXY = (r, c) => {
  const br = document.getElementById('board').getBoundingClientRect();
  const rot = document.querySelector('.stage').classList.contains('rot');
  if (!rot) return { x: br.left + (c + 0.5) * (br.width / 8), y: br.top + (r + 0.5) * (br.height / 12) };
  // V8.1 旋转态：bbox 宽 = 棋盘布局高（12 行），bbox 高 = 棋盘布局宽（8 列）；
  //   布局 (x,y) → 视口 (bbox.right - y, bbox.top + x)
  return { x: br.right - (r + 0.5) * (br.width / 12), y: br.top + (c + 0.5) * (br.height / 8) };
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
  // 旋转态下 bbox 宽高互换，比例必须用 offsetWidth（布局尺寸，不受 transform 影响）
  const cellW = document.getElementById('board').offsetWidth / 8;
  return {
    d: d,
    placed: !!(s.grid[1][5] && s.grid[1][5].cls === 'hero'),
    span2Booked: s.grid[1][6] === s.grid[1][5],
    unitEl: !!el,
    span2Cls: el ? el.classList.contains('span2') : false,
    widthRatio: el ? (el.offsetWidth / cellW) : 0,
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
    restart: !!ov.querySelector('[data-act="restart"]'),
    next: !!ov.querySelector('[data-act="next"]')
  };
})()`);
ok('胜利结算面板弹出（胜 利）', winRes.hidden === false && winRes.title === '胜 利' && winRes.panelCls.indexOf('win') >= 0,
  JSON.stringify(winRes).slice(0, 140));
ok('评级 1-5 星（3 血快速通关 = 5 星）', winRes.starsOn === 5 && winRes.starsOff === 0, 'on=' + winRes.starsOn + ' off=' + winRes.starsOff);
ok('恭喜晋升 + 本关星数 + 再来一局按钮（第一批 P1-12：假按钮改成真重开，不再有广告位文案）',
  winRes.promote.indexOf('恭喜晋升') >= 0 && winRes.coin.indexOf('星数') >= 0 &&
  winRes.double === false && winRes.restart === true,
  JSON.stringify({ promote: winRes.promote, coin: winRes.coin, double: winRes.double, restart: winRes.restart }));

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

// V7.3：竞技场是另一套路径形状（48 格，含被主路整圈围住的空腔），
// 确认同一套绘制方式在带洞的地图上依然正确。
const vsRoad = await evalJs(`(() => {
  const road = document.getElementById('road');
  const paths = road ? [...road.querySelectorAll('path')] : [];
  const p = paths.find(n => (n.getAttribute('class') || '').indexOf('road-fill') >= 0) || paths[0] || null;
  const vb = road ? (road.getAttribute('viewBox') || '0 0 0 0').split(' ').map(Number) : [0, 0, 0, 0];
  const cw = vb[2] / 8, chh = vb[3] / 12;
  const inFill = (x, y) => { try { return !!p && p.isPointInFill(new DOMPoint(x, y)); } catch (e) { return false; } };
  const cells = [...document.querySelectorAll('.cell')];
  const isP = n => n.classList.contains('path') && !n.classList.contains('obstacle');
  let okCenter = 0, nPath = 0, outside = 0;
  cells.forEach(n => {
    const x = +n.dataset.c * cw + cw / 2, y = +n.dataset.r * chh + chh / 2;
    if (isP(n)) { nPath++; if (inFill(x, y)) okCenter++; }
    else if (inFill(x, y)) outside++;
  });
  return { nPath: nPath, okCenter: okCenter, outside: outside, pathEls: paths.length };
})()`);
ok('V7.3 竞技模式主路同样整块绘制，覆盖全部主路格',
  vsRoad.pathEls === 2 && vsRoad.nPath > 0 && vsRoad.okCenter === vsRoad.nPath,
  '覆盖=' + vsRoad.okCenter + '/' + vsRoad.nPath + ' path=' + vsRoad.pathEls);
ok('V7.3 竞技模式被主路围住的空腔不被填满（自然留洞，不靠特判）',
  vsRoad.outside === 0, vsRoad.outside + ' 格');

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
  // V7.2/V7.3：主路连贯性体检
  const at = {};
  document.querySelectorAll('.cell').forEach(n => { at[n.dataset.r + ',' + n.dataset.c] = n; });
  const isP = n => !!n && n.classList.contains('path') && !n.classList.contains('obstacle');
  let seamsH = 0, seamsV = 0, badSeams = 0;
  document.querySelectorAll('.cell.path').forEach(n => {
    const r = +n.dataset.r, c = +n.dataset.c, cs = getComputedStyle(n);
    if (isP(at[r + ',' + (c + 1)])) { seamsH++; if (cs.borderRightColor !== 'rgba(0, 0, 0, 0)' || parseFloat(cs.borderRightWidth) === 0) badSeams++; }
    if (isP(at[(r + 1) + ',' + c])) { seamsV++; if (cs.borderBottomColor !== 'rgba(0, 0, 0, 0)' || parseFloat(cs.borderBottomWidth) === 0) badSeams++; }
  });
  const seams = seamsH + seamsV;
  const pathCell = document.querySelector('.cell.path');
  // V7.3：整条主路由 #road 里的一条闭合 path 绘制 —— 用 isPointInFill 直接问几何体
  // "这个点算不算路面"，横/竖/拐角一视同仁，不依赖任何逐格拼贴的判据。
  const road = document.getElementById('road');
  const roadPaths = road ? [...road.querySelectorAll('path')] : [];
  const roadPath = roadPaths.find(n => (n.getAttribute('class') || '').indexOf('road-fill') >= 0) || roadPaths[0] || null;
  const roadEdgeEl = roadPaths.find(n => (n.getAttribute('class') || '').indexOf('road-edge') >= 0) || null;
  const roadD = roadPath ? (roadPath.getAttribute('d') || '') : '';
  const roadEdgeD = roadEdgeEl ? (roadEdgeEl.getAttribute('d') || '') : '';
  const inFill = (x, y) => { try { return !!roadPath && roadPath.isPointInFill(new DOMPoint(x, y)); } catch (e) { return false; } };
  const vb = road ? road.getAttribute('viewBox').split(' ').map(Number) : [0, 0, 0, 0];
  const cw = vb[2] / 8, chh = vb[3] / 12;
  const pathCells = [...document.querySelectorAll('.cell.path')];
  let roadCenter = 0, roadH = 0, roadV = 0, roadOutside = 0;
  pathCells.forEach(n => {
    const r = +n.dataset.r, c = +n.dataset.c, x = c * cw, y = r * chh;
    if (inFill(x + cw / 2, y + chh / 2)) roadCenter++;
    if (isP(at[r + ',' + (c + 1)]) && inFill(x + cw, y + chh / 2)) roadH++;
    if (isP(at[(r + 1) + ',' + c]) && inFill(x + cw / 2, y + chh)) roadV++;
  });
  document.querySelectorAll('.cell').forEach(n => {
    if (isP(n)) return;
    if (inFill(+n.dataset.c * cw + cw / 2, +n.dataset.r * chh + chh / 2)) roadOutside++;
  });
  const bgOf = sel => { const n = document.querySelector(sel); return n ? getComputedStyle(n).backgroundColor : 'none'; };
  return {
    imgCount: imgs.length,
    allLoaded: imgs.length > 0 && imgs.every(i => i.naturalWidth > 0),
    allAssetSrc: imgs.length > 0 && imgs.every(i => (i.getAttribute('src') || '').indexOf('assets/') === 0),
    daoKey: srcOf(dEl), heroKey: srcOf(hEl), zeiKey: srcOf(zEl), bossKey: srcOf(bEl),
    idleAnim: hEl ? getComputedStyle(hEl.querySelector('.fig-img')).animationName : 'none',
    gradientCells: gradientCells, pathBg: pathBg,
    seams: seams, seamsH: seamsH, seamsV: seamsV, badSeams: badSeams,
    roadPathCount: roadPaths.length,
    roadFillCount: (roadD.match(/M/g) || []).length,
    roadEdgeSegs: (roadEdgeD.match(/M/g) || []).length,
    roadFill: roadPath ? getComputedStyle(roadPath).fill : 'none',
    roadFillRule: roadPath ? getComputedStyle(roadPath).fillRule : 'none',
    roadEdgeStroke: roadEdgeEl ? getComputedStyle(roadEdgeEl).stroke : 'none',
    roadStrokeW: roadEdgeEl ? (parseFloat(getComputedStyle(roadEdgeEl).strokeWidth) || 0) : 0,
    roadViewBox: road ? road.getAttribute('viewBox') : '',
    roadPathN: pathCells.length,
    roadCenter: roadCenter, roadH: roadH, roadV: roadV, roadOutside: roadOutside,
    pathShadow: pathCell ? getComputedStyle(pathCell).boxShadow : '',
    pathAfter: pathCell ? getComputedStyle(pathCell, '::after').content : '',
    cPath: bgOf('.cell.path'), cDeploy: bgOf('.cell.deploy'), cWaste: bgOf('.cell.wasteland'),
    cPlain: bgOf('.cell:not(.path):not(.deploy):not(.wasteland):not(.obstacle):not(.enter):not(.break)'),
    wasteCount: document.querySelectorAll('.cell.wasteland').length,
    plainCount: document.querySelectorAll('.cell:not(.path):not(.deploy):not(.wasteland):not(.obstacle):not(.enter):not(.break)').length,
    hasSkillBanner: !!document.getElementById('skill-banner'),
    hasSkillFx: !!document.querySelector('.skill-fx'),
    bossCls: bEl ? bEl.className : '',
    // V8.1：用布局宽 + transform 的 m41（%=已解析成 px）算逻辑位置 —— 不受 90° 旋转的 bbox 换轴影响
    heroLeft: hEl ? Math.round(new DOMMatrix(getComputedStyle(hEl).transform).m41) : -1,
    heroRight: hEl ? Math.round(new DOMMatrix(getComputedStyle(hEl).transform).m41 + hEl.offsetWidth) : -1,
    boardW: Math.round(document.getElementById('board').offsetWidth),
    ids: { dao: dao.id, hero: hero.id, zei: zei.id, boss: boss.id }
  };
})()`);
ok('V7 场上单位改为位图立绘（.fig-img）', art.imgCount >= 4, 'img=' + art.imgCount);
ok('V7 立绘全为本地 assets/ 且解码成功（naturalWidth>0）', art.allAssetSrc && art.allLoaded, JSON.stringify({ src: art.allAssetSrc, loaded: art.allLoaded }));
ok('V7 立绘映射正确（刀兵/赵云/黄巾/张梁）',
  /daobing/.test(art.daoKey) && /zhaoyun/.test(art.heroKey) && /hj-melee/.test(art.zeiKey) && /zhangliang/.test(art.bossKey),
  [art.daoKey, art.heroKey, art.zeiKey, art.bossKey].join(' | '));
ok('V7 待机跃动动画生效（figIdle）', /figIdle/.test(art.idleAnim), art.idleAnim);
ok('V7 棋盘格子无重复斜纹纹理（repeating-linear-gradient）', art.gradientCells === 0 && art.pathBg.indexOf('repeating-linear-gradient') < 0, 'gradient=' + art.gradientCells + ' pathBg=' + art.pathBg.slice(0, 60));
ok('V7 新增 #skill-banner 与粒子层容器', art.hasSkillBanner && art.hasSkillFx);
ok('V7 Boss 单位带 .boss 标记（金色泛光/放大）', /(^| )boss( |$)/.test(art.bossCls), art.bossCls);
ok('V7 武将（span2）横向落在棋盘内（不再右移出界）',
  art.heroLeft >= 0 && art.heroRight <= art.boardW + 2 && (art.heroRight - art.heroLeft) > art.boardW / 8 * 1.6,
  'left=' + art.heroLeft + ' right=' + art.heroRight + ' boardW=' + art.boardW);

// —— V7.1 棋盘配色：白路 / 棕塔位 / 绿荒地 / 米底 ——
ok('V7.1 敌人主路为白色（#ffffff）', art.roadFill === 'rgb(255, 255, 255)', art.roadFill);
ok('V7.1 可建塔位为棕色（#8a5a2b）', art.cDeploy === 'rgb(138, 90, 43)', art.cDeploy);
ok('V7.1 可开垦荒地为草绿（#4e7d3a）', art.cWaste === 'rgb(78, 125, 58)' && art.wasteCount > 0, art.cWaste + ' n=' + art.wasteCount);
ok('V7.1 普通空地为浅米/宣纸色（#e8e0c8）', art.cPlain === 'rgb(232, 224, 200)' && art.plainCount > 0, art.cPlain + ' n=' + art.plainCount);
ok('V7.1 四色互不相同（路/塔位/荒地/空地可一眼分辨）',
  new Set([art.roadFill, art.cDeploy, art.cWaste, art.cPlain]).size === 4,
  [art.roadFill, art.cDeploy, art.cWaste, art.cPlain].join(' | '));

// —— V7.2 敌路径连贯化：白色长条，路上无格子断点 ——
ok('V7.2 相邻主路格之间无分隔边框（全部接缝透明）', art.seams > 0 && art.badSeams === 0,
  'seams=' + art.seams + ' bad=' + art.badSeams);
ok('V7.2 主路格不画内阴影（避免小数格宽处的亚像素浅缝）', art.pathShadow === 'none', art.pathShadow.slice(0, 60));
ok('V7.2 主路无每格路心点（::after 已移除，路上无格子节奏）', art.pathAfter === 'none', art.pathAfter);

// —— V7.3 整条路交给 SVG 一次画完：横向 / 竖向 / 拐角 / S 弯一体成型 ——
ok('V7.3 主路只用两个 <path>（填充层 + 描边层），不是逐格 DOM',
  art.roadPathCount === 2, 'path 元素数=' + art.roadPathCount);
ok('V7.3 填充层一条 path 内画完所有主路格（nonzero 共边合并成实心路面）',
  art.roadFillCount === art.roadPathN && art.roadFillRule === 'nonzero',
  '矩形子路径=' + art.roadFillCount + '/' + art.roadPathN + ' rule=' + art.roadFillRule);
ok('V7.3 主路层纯白填充 + 外沿边描边（不描格子缝）',
  art.roadFill === 'rgb(255, 255, 255)' && art.roadEdgeStroke !== 'none' && art.roadStrokeW > 0 && art.roadEdgeSegs > 0,
  art.roadFill + ' / 描边 ' + art.roadEdgeStroke + ' ' + art.roadStrokeW + 'px · ' + art.roadEdgeSegs + ' 段');
ok('V7.3 主路格不再各自铺白底（透明，白底只由整块轮廓提供）',
  art.cPath === 'rgba(0, 0, 0, 0)', art.cPath);
ok('V7.3 所有主路格中心都落在同一块路面内',
  art.roadPathN > 0 && art.roadCenter === art.roadPathN,
  art.roadCenter + '/' + art.roadPathN);
ok('V7.3 横向 + 竖向接缝中点全部在路面内（竖段与拐角同样连贯）',
  art.seamsH > 0 && art.seamsV > 0 && art.roadH === art.seamsH && art.roadV === art.seamsV,
  '横 ' + art.roadH + '/' + art.seamsH + ' · 竖 ' + art.roadV + '/' + art.seamsV);
ok('V7.3 路面不外溢（非主路格 0 误覆盖）', art.roadOutside === 0, art.roadOutside + ' 格');

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

/* ========================================================= V8 收尾验收断言 */
console.log('\n== V8 合成改版（卡喂 1 级 · 塔塔同级合成升阶）==');
const syn8 = await evalJs(`(async () => {
  const s = ZY.UI.getState();
  const G = ZY.Game, B = ZY.B;
  const slots = Object.keys(B.startSlots('endless','player')).map(k => k.split(',').map(Number));
  s.units = s.units.filter(u => u.side !== 'player');
  const mk = (r,c,type,lv) => { const u = G.makeUnit(s,'player',{cls:'soldier',type,level:lv,row:r,col:c,span:1,target:null}); G.addUnit(s,u); return u; };
  const A = slots[0], Bc = slots[1], C = slots[2], D = slots[3], E = slots[4], F = slots[5];
  mk(A[0],A[1],'dao',2);
  const bT = mk(Bc[0],Bc[1],'dao',2);
  mk(C[0],C[1],'qiang',2);
  s.player.hand.push({uid:9001,kind:'unit',char:'刀',type:'dao',level:1});
  const rFeed = G.deploy(s,'player',9001,A[0],A[1]);          // V8：卡不能喂 2 级塔
  const cardStill = s.player.hand.some(x => x.uid === 9001);
  const lvlA = s.grid[A[0]][A[1]].level;
  const before = s.units.length;
  const m = G.mergeTower(s,'player',bT.id,A[0],A[1]);         // 塔塔 2+2 → 3
  const after = s.units.length;
  const consumedGone = s.grid[Bc[0]][Bc[1]] === null;
  const lvlAfter = s.grid[A[0]][A[1]].level;
  const cT = s.units.find(u => u.side==='player' && u.type==='qiang' && u.level===2 && u.row===C[0] && u.col===C[1]);
  const m2 = G.mergeTower(s,'player',cT ? cT.id : 0,A[0],A[1]);   // 异兵种
  const m3 = G.mergeTower(s,'player',s.grid[A[0]][A[1]].id,A[0],A[1]); // 自合
  const dT = mk(D[0],D[1],'dao',2);
  const m4 = G.mergeTower(s,'player',dT.id,A[0],A[1]);        // 不同级
  const eT = mk(E[0],E[1],'dao',5);
  const fT = mk(F[0],F[1],'dao',5);
  const m5 = G.mergeTower(s,'player',fT.id,E[0],E[1]);        // 满级
  return {
    rFeedOk: !rFeed.ok, rFeedMsg: rFeed.msg, cardStill, lvlA,
    mOk: m.ok, mMerged: m.merged, mLevel: m.level, before, after, consumedGone, lvlAfter,
    m2Ok: !m2.ok, m3Ok: !m3.ok, m4Ok: !m4.ok, m5Ok: !m5.ok, lvlFinal: s.grid[A[0]][A[1]].level, eLv: s.grid[E[0]][E[1]].level
  };
})()`);
ok('V8 卡不能喂 2 级塔（仅 1 级可喂）', syn8.rFeedOk && syn8.cardStill && syn8.lvlA === 2, syn8.rFeedMsg);
ok('V8 塔塔合成 2+2 → 3 级', syn8.mOk && syn8.mMerged && syn8.mLevel === 3 && syn8.lvlAfter === 3, JSON.stringify({ ok: syn8.mOk, lv: syn8.lvlAfter }));
ok('V8 被吃塔消失（单位表 -1 + 占位清空）', syn8.after === syn8.before - 1 && syn8.consumedGone, 'before=' + syn8.before + ' after=' + syn8.after);
ok('V8 异兵种不可合成', syn8.m2Ok);
ok('V8 不能和自己合成', syn8.m3Ok);
ok('V8 等级不同不可合成（仍为 3 级）', syn8.m4Ok && syn8.lvlFinal === 3);
ok('V8 满级（5 级）不可再合成', syn8.m5Ok && syn8.eLv === 5);

console.log('\n== V8.1 全端强制横屏（无遮罩 · 竖持旋转态）==');
const rotClean = await evalJs(`(() => {
  const st = ZY.UI.getState();
  return {
    overlayEl: !!document.getElementById('rotate-overlay'),
    overlayCls: !!document.querySelector('.rotate-overlay'),
    lockField: !!st && ('orientLock' in st),
    deadCss: ((document.styleSheets[0] || {}).cssRules ? Array.prototype.some.call(document.styleSheets[0].cssRules, function (r) { return (r.cssText || '').indexOf('rotate-overlay') >= 0; }) : false)
  };
})()`);
ok('V8.1 竖屏遮罩已删除（DOM / 样式类 / CSS 规则都不存在）',
  !rotClean.overlayEl && !rotClean.overlayCls && !rotClean.deadCss, JSON.stringify(rotClean));
ok('V8.1 状态机不再有 orientLock 字段（方向不再暂停）', !rotClean.lockField);

// —— 手机竖持 375×667：舞台整体旋转 90°，铺满视口 ——
await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 667, deviceScaleFactor: 2, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await sleep(420);
await evalJs(DRAG_HELPERS);   // 页面在 558/589/639 处重新导航过，拖拽辅助需重新注入
const portrait = await evalJs(`(() => {
  const st = document.querySelector('.stage');
  const b = document.getElementById('board').getBoundingClientRect();
  const d = document.documentElement;
  return {
    rot: st.classList.contains('rot'),
    bodyRot: document.body.classList.contains('ui-rot'),
    layout: [Math.round(st.offsetWidth), Math.round(st.offsetHeight)],
    vw: innerWidth, vh: innerHeight,
    board: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)],
    tf: getComputedStyle(st).transform,
    scrollX: d.scrollWidth - d.clientWidth,
    scrollY: d.scrollHeight - d.clientHeight
  };
})()`);
ok('V8.1 竖持 → 舞台加 .rot（旋转态）', portrait.rot === true && portrait.bodyRot === true, JSON.stringify(portrait).slice(0, 120));
ok('V8.1 竖持 → 舞台尺寸互换（宽 = 视口高 · 高 = 视口宽）',
  Math.abs(portrait.layout[0] - portrait.vh) < 2 && Math.abs(portrait.layout[1] - portrait.vw) < 2,
  portrait.layout.join('×') + ' vs vh/vw ' + portrait.vh + '/' + portrait.vw);
ok('V8.1 竖持 → 已应用 90° 旋转矩阵（matrix(0,1,-1,0,·)）',
  /^matrix\(0,\s*1,\s*-1,\s*0/.test(portrait.tf), portrait.tf);
ok('V8.1 竖持 → 无文档级滚动（旋转后仍铺满，不出滚动条）',
  portrait.scrollX <= 0 && portrait.scrollY <= 0, 'x=' + portrait.scrollX + ' y=' + portrait.scrollY);
ok('V8.1 竖持 → 棋盘 8:12 不变形（bbox 宽高互换 = 布局高/宽）',
  Math.abs(portrait.board[3] / portrait.board[2] - 8 / 12) < 0.03,
  portrait.board[2] + '×' + portrait.board[3]);

// —— 旋转态坐标命中：拖卡 → 必须落在 __cellXY 指定的那一格 ——
const rotHit = await evalJs(`(async () => {
  const s = ZY.UI.getState();
  s.paused = false; s.over = false;
  s.player.hand = [{ uid: 93001, kind: 'unit', char: '刀', type: 'dao', level: 1 }];
  await new Promise(r => setTimeout(r, 240));
  const free = [...document.querySelectorAll('.cell.deploy')].find(c => {
    const r = +c.dataset.r, col = +c.dataset.c; return !s.grid[r][col];
  });
  const r0 = +free.dataset.r, c0 = +free.dataset.c;
  const p = window.__cellXY(r0, c0);
  const res = await window.__dragFrom('#hand .card[data-uid="93001"]', p.x, p.y);
  await new Promise(r => setTimeout(r, 260));
  const g = s.grid[r0][c0];
  return { r0: r0, c0: c0, px: Math.round(p.x), py: Math.round(p.y), ghosts: document.querySelectorAll('.ghost').length,
           hit: !!g && g.type === 'dao', res: res && res.mid ? res.mid.hl : -1 };
})()`);
ok('V8.1 旋转态坐标命中：拖卡精确落到目标格', rotHit.hit === true, JSON.stringify(rotHit));
ok('V8.1 旋转态拖拽无残影（ghost 已回收）', rotHit.ghosts === 0, rotHit.ghosts + '');

// —— 手机横屏 667×375：不旋转，同一套横屏布局 ——
await send('Emulation.setDeviceMetricsOverride', { width: 667, height: 375, deviceScaleFactor: 2, mobile: true });
await sleep(420);
const land = await evalJs(`(() => {
  const r = (sel) => { const e = document.querySelector(sel); return e ? e.getBoundingClientRect() : null; };
  const st = document.querySelector('.stage'), board = r('#board'), dock = r('.dock'), hud = r('.hud');
  const d = document.documentElement;
  return {
    rot: st.classList.contains('rot'), vw: innerWidth, vh: innerHeight,
    stage: [Math.round(st.offsetWidth), Math.round(st.offsetHeight)],
    board: [Math.round(board.left), Math.round(board.top), Math.round(board.width), Math.round(board.height)],
    dockL: Math.round(dock.left), hudR: Math.round(hud.right), hudB: Math.round(hud.bottom),
    scrollX: d.scrollWidth - d.clientWidth, scrollY: d.scrollHeight - d.clientHeight
  };
})()`);
ok('V8.1 手机横屏 → 不旋转（.rot 已移除）', land.rot === false);
ok('V8.1 手机横屏 → 舞台铺满视口', Math.abs(land.stage[0] - land.vw) < 2 && Math.abs(land.stage[1] - land.vh) < 2,
  land.stage.join('×') + ' / ' + land.vw + '×' + land.vh);
ok('V8.1 手机横屏 → 操作栏在棋盘右侧（横向布局）', land.dockL >= land.board[0] + land.board[2] - 1,
  'board.r=' + (land.board[0] + land.board[2]) + ' dock.l=' + land.dockL);
ok('V8.1 手机横屏 → 棋盘在 HUD 下方且完整可见',
  land.board[1] >= land.hudB - 2 && land.board[1] + land.board[3] <= land.vh + 1,
  'board.t=' + land.board[1] + ' hud.b=' + land.hudB + ' board.b=' + (land.board[1] + land.board[3]));
ok('V8.1 手机横屏 → 无水平裁切（HUD 倍速键不被切）', land.scrollX <= 0 && land.hudR <= land.vw + 1,
  'scrollX=' + land.scrollX + ' hud.r=' + land.hudR + ' vw=' + land.vw);

// —— PC 1280×800：同一套横屏布局等比放大 ——
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await sleep(420);
const pc = await evalJs(`(() => {
  const r = (sel) => { const e = document.querySelector(sel); return e ? e.getBoundingClientRect() : null; };
  const st = document.querySelector('.stage'), board = r('#board'), dock = r('.dock');
  return {
    rot: st.classList.contains('rot'),
    board: [Math.round(board.width), Math.round(board.height)],
    dockL: Math.round(dock.left), boardR: Math.round(board.right),
    scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth
  };
})()`);
ok('V8.1 PC 宽屏 → 不旋转且棋盘等比 8:12',
  pc.rot === false && Math.abs(pc.board[0] / pc.board[1] - 8 / 12) < 0.02, pc.board.join('×'));
ok('V8.1 PC 宽屏 → 操作栏在右、无横向溢出', pc.dockL >= pc.boardR - 1 && pc.scrollX <= 0,
  'board.r=' + pc.boardR + ' dock.l=' + pc.dockL + ' scrollX=' + pc.scrollX);

// —— 方向变化即时切换、不暂停：旋转态下仿真时间继续推进 ——
await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 667, deviceScaleFactor: 2, mobile: true });
await sleep(380);
const live = await evalJs(`(async () => {
  const s = ZY.UI.getState();
  s.paused = false; s.over = false;
  const t0 = s.t;
  await new Promise(r => setTimeout(r, 500));
  return { dt: s.t - t0, paused: s.paused, rot: document.querySelector('.stage').classList.contains('rot') };
})()`);
ok('V8.1 旋转态不暂停：主循环继续推进仿真时间', live.rot === true && !live.paused && live.dt > 0.05,
  'dt=' + live.dt.toFixed(2) + ' paused=' + live.paused);
await send('Emulation.setTouchEmulationEnabled', { enabled: false });
await sleep(200);

console.log('\n== V8 倍速开关 1x ↔ 2x ==');
const spBtn = await evalJs(`(() => {
  const s = ZY.UI.getState();
  const btn = document.getElementById('btn-speed');
  s.paused = false; s.over = false;
  const before = s.speed;
  btn.click(); const a1 = s.speed; const lab1 = btn.textContent;
  btn.click(); const a2 = s.speed;
  return { exists: !!btn, before, a1, a2, lab1 };
})()`);
ok('V8 倍速按钮存在', spBtn.exists);
ok('V8 倍速 1x → 2x 切换', spBtn.before === 1 && spBtn.a1 === 2, '1→' + spBtn.a1);
ok('V8 倍速 2x → 1x 复位（不存档）', spBtn.a2 === 1, spBtn.a2 + '');
ok('V8 倍速按钮文案含倍速标识', /2/.test(spBtn.lab1) || /倍/.test(spBtn.lab1), spBtn.lab1);
const spTim = await evalJs(`(async () => {
  const s = ZY.UI.getState();
  s.paused = false; s.over = false;
  s.speed = 1; await new Promise(r => setTimeout(r, 200));
  const t0 = s.t; await new Promise(r => setTimeout(r, 600)); const t1 = s.t; const d1 = t1 - t0;
  s.speed = 2; await new Promise(r => setTimeout(r, 200));
  const t2 = s.t; await new Promise(r => setTimeout(r, 600)); const t3 = s.t; const d2 = t3 - t2;
  s.speed = 1;
  return { d1: d1, d2: d2 };
})()`);
ok('V8 主循环在跑（1x 推进仿真时间）', spTim.d1 > 0.05, 'd1=' + spTim.d1.toFixed(2));
ok('V8 倍速 2x 仿真推进约 2 倍（≥1.4×）', spTim.d1 > 0.05 && spTim.d2 > spTim.d1 * 1.4, 'd1=' + spTim.d1.toFixed(2) + ' d2=' + spTim.d2.toFixed(2));

console.log('\n== V8.1 兵种机制 + 敌我双向微调 ==');
const nums = await evalJs(`(() => {
  const st = (t,l) => ZY.statsAt(t,l);
  const hs = (h,l) => ZY.heroStats(h,l);
  const mk = (type) => ZY.Game.makeUnit(ZY.UI.getState(),'player',{cls:'soldier',type,level:1,row:0,col:0,span:1,target:null});
  const q = mk('qiang'), k = mk('qi');
  return {
    dao: st('dao',1), qiang: st('qiang',1), qi: st('qi',1), gong: st('gong',1),
    zy: hs('zhaoyun',1), zf: hs('zhangfei',1), gy: hs('guanyu',1), mc: hs('machao',1),
    hz: hs('huangzhong',1), zgl: hs('zhugeliang',1), lb: hs('liubei',1),
    qPierce: !!q.pierce, kSplash: k.splash,
    // 农民不参与战斗公式（statsAt 只回 hp/atk/aspd），面板要读原始表才有 produce
    nongRaw: { atk: ZY.UNITS.nong.atk, aspd: ZY.UNITS.nong.aspd, produce: ZY.UNITS.nong.produce },
    zei: ZY.UNITS.zei, boss: ZY.BOSS, elite: ZY.C.ELITE_MUL, bossHp: ZY.C.BOSS_HP_MUL, bossAtk: ZY.C.BOSS_ATK_MUL
  };
})()`);
ok('V8.1 刀兵面板 4.40 / 1.75', Math.abs(nums.dao.atk-4.40)<0.01 && Math.abs(nums.dao.aspd-1.75)<0.01, nums.dao.atk + '/' + nums.dao.aspd);
ok('V8.1 枪兵面板 3.70 / 1.90（贯穿）', Math.abs(nums.qiang.atk-3.70)<0.01 && Math.abs(nums.qiang.aspd-1.90)<0.01 && nums.qPierce, nums.qiang.atk + '/' + nums.qiang.aspd);
ok('V8.1 骑兵面板 3.20 / 1.80（溅射 0.70）', Math.abs(nums.qi.atk-3.20)<0.01 && Math.abs(nums.qi.aspd-1.80)<0.01 && Math.abs(nums.kSplash-0.70)<0.01, nums.qi.atk + '/' + nums.qi.aspd + ' s=' + nums.kSplash);
ok('V8.1 弓兵面板 2.85 / 1.60', Math.abs(nums.gong.atk-2.85)<0.01 && Math.abs(nums.gong.aspd-1.60)<0.01, nums.gong.atk + '/' + nums.gong.aspd);
ok('V8.1 农民面板不变 0 / 0（produce 0.4）', nums.nongRaw.atk === 0 && nums.nongRaw.aspd === 0 && nums.nongRaw.produce === 0.4,
  nums.nongRaw.atk + '/' + nums.nongRaw.aspd + ' p=' + nums.nongRaw.produce);
ok('V8.1 赵云 atk=15.20 · 攻速随枪系 1.90', Math.abs(nums.zy.atk-15.20)<0.01 && Math.abs(nums.zy.aspd-1.90)<0.01, nums.zy.atk + '/' + nums.zy.aspd);
ok('V8.1 关张 atk=18.07（刀系公式）· 攻速 1.75', Math.abs(nums.zf.atk-18.07)<0.01 && Math.abs(nums.gy.atk-18.07)<0.01 && Math.abs(nums.zf.aspd-1.75)<0.01, nums.zf.atk + '/' + nums.gy.atk);
ok('V8.1 马超 atk=13.14 · 攻速随骑系 1.80', Math.abs(nums.mc.atk-13.14)<0.01 && Math.abs(nums.mc.aspd-1.80)<0.01, nums.mc.atk + '/' + nums.mc.aspd);
ok('V8.1 黄忠/诸葛 atk=11.70 · 攻速随弓系 1.60', Math.abs(nums.hz.atk-11.70)<0.01 && Math.abs(nums.zgl.atk-11.70)<0.01 && Math.abs(nums.hz.aspd-1.60)<0.01, nums.hz.atk + '/' + nums.zgl.atk);
ok('V8.1 刘备 atk=16.00（锚定不进公式）· 1.75', Math.abs(nums.lb.atk-16.00)<0.01 && Math.abs(nums.lb.aspd-1.75)<0.01, nums.lb.atk + '/' + nums.lb.aspd);
ok('V8.1 敌方 +25%：贼兵 30 / 2.40 / 1.25', nums.zei.hp===30 && Math.abs(nums.zei.atk-2.40)<0.01 && Math.abs(nums.zei.aspd-1.25)<0.01, nums.zei.hp + '/' + nums.zei.atk + '/' + nums.zei.aspd);
ok('V8.1 精英倍率 1.25（与敌方同口径）', Math.abs(nums.elite-1.25)<0.01, nums.elite + '');
ok('V8.1 Boss 张梁 30 / 2.40 · 倍率 ×12 / ×3.5',
  nums.boss.hp===30 && Math.abs(nums.boss.atk-2.40)<0.01 && nums.bossHp===12 && Math.abs(nums.bossAtk-3.5)<0.01,
  nums.boss.hp + '/' + nums.boss.atk + ' ×' + nums.bossHp + '/×' + nums.bossAtk);

console.log('\n== V8 攻击动作分化（每兵种专属类 + 特效）==');
const act8 = await evalJs(`(async () => {
  const s = ZY.UI.getState();
  s.paused = false; s.over = false;
  const G = ZY.Game;
  s.units = s.units.filter(u => u.side !== 'player');
  const slots = Object.keys(ZY.B.startSlots('endless','player')).map(k => k.split(',').map(Number));
  const mkP = (r,c,type) => { const u = G.makeUnit(s,'player',{cls:'soldier',type,level:1,row:r,col:c,span:1,target:null}); G.addUnit(s,u); return u; };
  const a = mkP(slots[0][0],slots[0][1],'dao');
  const q = mkP(slots[1][0],slots[1][1],'qiang');
  const k = mkP(slots[2][0],slots[2][1],'qi');
  await new Promise(r => setTimeout(r, 140));
  s.fx.push({type:'anim', uid:a.id});
  s.fx.push({type:'anim', uid:q.id});
  s.fx.push({type:'anim', uid:k.id});
  let dao=false,qiang=false,qi=false,fxAfter=false,fxPierce=false,fxArc=false;
  for (let i=0;i<30;i++){
    await new Promise(r => setTimeout(r, 60));
    const aE=document.querySelector('.unit.p[data-uid="'+a.id+'"]');
    if(aE && aE.classList.contains('a-atk') && aE.classList.contains('atk-dao')) dao=true;
    const qE=document.querySelector('.unit.p[data-uid="'+q.id+'"]');
    if(qE && qE.classList.contains('a-atk') && qE.classList.contains('atk-qiang')) qiang=true;
    const kE=document.querySelector('.unit.p[data-uid="'+k.id+'"]');
    if(kE && kE.classList.contains('a-atk') && kE.classList.contains('atk-qi')) qi=true;
    if(document.querySelector('#fx .fx-after.dao')) fxAfter=true;
    if(document.querySelector('#fx .fx-pierce')) fxPierce=true;
    if(document.querySelector('#fx .fx-slash-arc')) fxArc=true;
    if(dao&&qiang&&qi&&fxAfter&&fxPierce&&fxArc) break;
  }
  return {dao,qiang,qi,fxAfter,fxPierce,fxArc};
})()`);
ok('V8 刀兵攻击 → .a-atk.atk-dao 专属动作', act8.dao);
ok('V8 枪兵攻击 → .a-atk.atk-qiang 专属动作', act8.qiang);
ok('V8 骑兵攻击 → .a-atk.atk-qi 专属动作', act8.qi);
ok('V8 刀攻击残影特效 .fx-after.dao', act8.fxAfter);
ok('V8 枪攻击贯穿拖光 .fx-pierce', act8.fxPierce);
ok('V8 骑攻击溅射弧光 .fx-slash-arc', act8.fxArc);

console.log('\n== V8 特效密度（存活上限 80 + 同帧≤20）==');
const part8 = await evalJs(`(async () => {
  const s = ZY.UI.getState();
  s.paused = false; s.over = false;
  const G = ZY.Game;
  s.units = s.units.filter(u => u.cls !== 'hero');
  const slots = Object.keys(ZY.B.startSlots('endless','player')).map(k => k.split(',').map(Number));
  const mkH = (hid,r,c) => { const u = G.makeUnit(s,'player',{cls:'hero',heroId:hid,heroLevel:1,row:r,col:c,span:2,target:null}); G.addUnit(s,u); return u; };
  // 技能需要射程内有敌人（castSkill 无目标不释放）——显式造高血量敌人贴住武将，
  // 否则敌人走远后 single 会变 0，测试随战况偶发失败。
  const extras = [];
  const mkE = (r,c) => {
    const rr = Math.max(0, Math.min(ZY.B.ROWS - 1, r)), cc = Math.max(0, Math.min(ZY.B.COLS - 1, c));
    const u = G.makeUnit(s,'enemy',{cls:'soldier',type:'zei',level:1,row:rr,col:cc,span:1,target:null});
    u.hp = u.maxHp = 99999; G.addUnit(s,u); extras.push(u); return u;
  };
  const z = mkH('zhaoyun',slots[0][0],slots[0][1]);
  z.skillT = 99;                       // 先锁住技能，等这一帧 syncUnits 把立绘建出来再放，避免首帧时序抖动
  mkE(slots[0][0], slots[0][1] + 1);
  mkE(slots[0][0] + 1, slots[0][1]);
  mkE(slots[0][0], slots[0][1] - 1);
  await new Promise(r => setTimeout(r, 120));
  // 只数「这一发技能新增」的粒子：用 MutationObserver 统计 addedNodes。
  // 上一场战斗的残留粒子最长要 700ms 才回收，直接 querySelectorAll 会把它们算进来（V8 时代的偶发误报）。
  const fxLayer = document.querySelector('.skill-fx');
  let single = 0;
  // 旁路屏蔽：场上 Boss 也会放技能（14 粒）并落在同一层，会把「单次」计数抬高（实测 10+14=24）
  const muted = [];
  s.units.forEach(u => { if (u !== z && (u.heroId || u.cls === 'boss')) { muted.push([u, u.skillT]); u.skillT = 1e9; } });
  const mo = new MutationObserver(list => list.forEach(m => m.addedNodes.forEach(n => {
    if (n.nodeType === 1 && n.classList && n.classList.contains('fx-particle')) single++;
  })));
  mo.observe(fxLayer, { childList: true });
  z.skillT = 0;
  await new Promise(r => setTimeout(r, 200));
  mo.disconnect();
  muted.forEach(pair => { pair[0].skillT = pair[1]; });
  const g = mkH('guanyu',slots[1][0],slots[1][1]);
  const m = mkH('machao',slots[2][0],slots[2][1]);
  g.skillT = 99; m.skillT = 99;
  mkE(slots[1][0], slots[1][1] + 1);
  mkE(slots[2][0], slots[2][1] + 1);
  await new Promise(r => setTimeout(r, 120));
  g.skillT = 0; m.skillT = 0;
  let maxLive = 0;
  for (let i=0;i<24;i++){
    await new Promise(r => setTimeout(r, 50));
    [z,g,m].forEach(h => { if (h.skillT > 0.4) h.skillT = 0; });
    const live = document.querySelectorAll('.skill-fx .fx-particle').length;
    if (live > maxLive) maxLive = live;
  }
  s.units = s.units.filter(u => u.cls !== 'hero' && extras.indexOf(u) < 0);
  return { single, maxLive, fxW: (document.querySelector('#fx')||{getBoundingClientRect:function(){return {width:0};}}).getBoundingClientRect().width,
           heroEls: document.querySelectorAll('.unit.hero').length };
})()`);
ok('V8 单次技能粒子 ∈ [6,20]（同帧创建上限 20）', part8.single >= 6 && part8.single <= 20,
  'single=' + part8.single + ' fxW=' + Math.round(part8.fxW) + ' heroEls=' + part8.heroEls);
ok('V8 粒子洪峰 ≤ 存活上限 80', part8.maxLive <= 80, 'maxLive=' + part8.maxLive);

/* —— V8.1 七张验收截图（横屏布局为主 + 竖持旋转态） —— */
const SHOT_DIR = 'D:/Projects/_github_pages/ming-games/zhaoyun/tools/shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });
async function capShot(name) { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(r.result.data, 'base64')); }
await send('Emulation.setDeviceMetricsOverride', { width: 667, height: 375, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: URL }); await sleep(1300);
await capShot('01-start-landscape.png');
await evalJs(DRAG_HELPERS);
await evalJs(`document.querySelector('.mode-btn[data-mode="endless"]').click()`); await sleep(450);
await capShot('02-new-map.png');
await evalJs(`(async () => {
  const s = ZY.UI.getState(); s.player.bun = 300;
  s.player.hand.push({uid:91001,kind:'unit',char:'刀',type:'dao',level:1});
  s.player.hand.push({uid:91002,kind:'unit',char:'刀',type:'dao',level:1});
  await new Promise(r=>setTimeout(r,200));
  const free=[...document.querySelectorAll('.cell.deploy')].find(c=>{const r=+c.dataset.r,col=+c.dataset.c;return !ZY.UI.getState().grid[r][col];});
  const p=window.__cellXY(+free.dataset.r,+free.dataset.c);
  await window.__dragFrom('#hand .card[data-uid="91001"]',p.x,p.y);
  await new Promise(r=>setTimeout(r,260));
  await window.__dragFrom('#hand .card[data-uid="91002"]',p.x,p.y);
})()`);
await sleep(220);
await capShot('03-deploy-merge.png');
// 黄忠（验收示例）：金字「黄」+「忠」→ 合成武将卡 → 拖到双塔位
await evalJs(`(async () => {
  const s = ZY.UI.getState();
  s.player.hand=[]; s.player.hand.push({uid:92001,kind:'gold',char:'黄',level:1}); s.player.hand.push({uid:92002,kind:'gold',char:'忠',level:1});
  await new Promise(r=>setTimeout(r,260));
  await window.__tapEl('#hand .card[data-uid="92001"]');
  await new Promise(r=>setTimeout(r,140));
  const hero=document.querySelector('#hand .card.hero');
  if(hero){const uid=+hero.dataset.uid; const p=window.__cellXY(1,5); await window.__dragFrom('#hand .card.hero[data-uid="'+uid+'"]',p.x,p.y);}
})()`);
await sleep(360);
const nmBox = await evalJs(`(() => {
  const u = document.querySelector('.unit.span2');
  if (!u) return { has: false };
  const nm = u.querySelector('.nm');
  const fi = u.querySelector('.fig-img');
  if (!nm || !fi) return { has: false };
  const ur = u.getBoundingClientRect(), nr = nm.getBoundingClientRect(), fr = fi.getBoundingClientRect();
  return {
    has: true, txt: nm.textContent, wm: getComputedStyle(nm).writingMode,
    unit: [Math.round(ur.width), Math.round(ur.height)],
    leftRatio: +((nr.left - ur.left) / ur.width).toFixed(3),
    vertical: nr.height > nr.width,
    inUnit: nr.left >= ur.left - 1.5 && nr.right <= ur.right + 1.5 && nr.top >= ur.top - 2 && nr.bottom <= ur.bottom + 2,
    overlapFig: !(nr.right <= fr.left + 1 || nr.left >= fr.right - 1)
  };
})()`);
ok('V8.1 武将名牌侧置：竖排 · 贴左侧外沿（left ≤ 15% 塔宽）',
  nmBox.has && nmBox.wm === 'vertical-rl' && nmBox.leftRatio <= 0.15, JSON.stringify(nmBox));
ok('V8.1 武将名牌不遮立绘主体（横坐标与立绘零重叠）', nmBox.has && nmBox.overlapFig === false, JSON.stringify(nmBox && nmBox.overlapFig));
ok('V8.1 武将名牌仍在塔格内（不溢出到邻格）', nmBox.has && nmBox.inUnit === true, JSON.stringify(nmBox && nmBox.inUnit));
await capShot('04-hero-nameplate.png');
await evalJs(`document.getElementById('btn-speed').click();`);
await sleep(220);
await capShot('05-speed-2x.png');
// 手机竖持：旋转态全屏
await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 667, deviceScaleFactor: 2, mobile: true });
await sleep(500);
await capShot('06-portrait-rotated.png');
// 手机横屏：同一套横屏布局
await send('Emulation.setDeviceMetricsOverride', { width: 812, height: 375, deviceScaleFactor: 2, mobile: true });
await sleep(420);
await capShot('07-landscape-812.png');
await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 667, deviceScaleFactor: 2, mobile: true });
await sleep(200);
console.log('   截图已存: ' + SHOT_DIR);

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
