/* 赵云与阿斗 · V5 原版对齐证据截图（无头 Edge + CDP）
 * 生成 12 张验收图（覆盖指令 9 项 + 字对黄光 + 拖塔换位前后对比）：
 *   ① v5-1-board.png      竖屏 9:16 蛇形路径全景（37 格棕路 / 17 绿塔位 / 24 荆棘 / 右入口「斗」/ 左阿斗）
 *   ② v5-2-recruit.png    征兵 10 起步每次 +2 不封顶（第 1/2/3 次按钮数值 12/14/16）
 *   ③ v5-3-barracks.png   一次征兵 5 张进军营（5 槽）
 *   ④ v5-4-dao2.png       刀+刀 = 刀² 等级角标（.lv = 2）
 *   ⑤ v5-5-pair.png       手牌凑齐赵+云 → 两张金字黄色发光
 *   ⑥ v5-6-synth.png      点金字 →「合成武将」提示 + 武将卡（占 2 格）
 *   ⑦ v5-7-span2.png      赵云武将塔横跨 2 格上盘
 *   ⑧ v5-8-kill.png       击杀普通敌人 +1 飘字
 *   ⑨ v5-9-zhangliang.png 敌方带名武将张梁登场（第 6 波关底）
 *   ⑩ v5-10-win.png       关卡胜利结算：1-5 星 / 恭喜晋升 / 金币+20 / 双倍金币
 *   ⑪ v5-11-move-before.png 拖塔换位前：刀² 在原塔位（角标 2）
 *   ⑫ v5-12-move-after.png  拖塔换位后：同一座塔在新塔位（角标仍 2 · 旧格清空）
 * 用法：node tools/v5-shot.mjs
 * 注意：CDP 的 clip 必须带 scale（该 Edge 版本缺失会 -32602 静默失败），存图后校验字节数。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
const URL = 'file:///' + INDEX.replace(/\\/g, '/');
const PORT = 9346;
const OUT = 'D:/安装包/WorkBuddy/工作空间/2026-10-16-00-32-32/zhaoyun-v5-evidence';
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--mute-audio',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=C:/Users/31474/AppData/Local/Temp/zy-v5-profile',
  '--allow-file-access-from-files', '--window-size=390,844', 'about:blank',
], { stdio: 'ignore' });

async function waitPort() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/version'); if (r.ok) return; } catch (e) {}
    await sleep(300);
  }
  throw new Error('Edge 未启动');
}

let mid = 0;
const pending = new Map();
async function waitTarget() {
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
    const t = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
    if (t) return t;
    await sleep(300);
  }
  throw new Error('找不到 page target');
}
await waitPort();
const ws = new WebSocket((await waitTarget()).webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
const send = (method, params = {}) => new Promise((r) => {
  const id = ++mid; ws.send(JSON.stringify({ id, method, params }));
  pending.set(id, r);
});
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval');
  return r.result?.result?.value;
}

function saveShot(name, data) {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  const bytes = fs.statSync(file).size;
  if (bytes < 5000) throw new Error('截图异常小 ' + name + ': ' + bytes + ' bytes');
  console.log('  存图 ' + name + '  (' + bytes + ' bytes)');
  return bytes;
}
/** 棋盘裁剪截图（可选 zoom / crop 顶部比例 / scale） */
async function shoot(name, zoom, crop, scale) {
  const rect = await evalJs(`(() => {
    const b = document.getElementById('board');
    if (${zoom} > 1) b.style.zoom = ${zoom}; else b.style.zoom = '';
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  await sleep(150);
  const h = crop && crop < 1 ? Math.round(rect.h * crop) : rect.h;
  const clip = { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: Math.min(1400, rect.w), height: Math.min(1600, h), scale: scale || 2 };
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });
  if (!r.result?.data) throw new Error('截图失败 ' + name + ': ' + JSON.stringify(r.error || 'no data'));
  saveShot(name, r.result.data);
  await evalJs(`document.getElementById('board').style.zoom = ''`);
}
/** 元素裁剪截图（底栏 / 面板等） */
async function shootEl(name, sel, scale) {
  const rect = await evalJs(`(() => {
    const e = document.querySelector('${sel}');
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  const clip = { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: Math.min(1400, rect.w), height: Math.min(1600, rect.h), scale: scale || 2 };
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });
  if (!r.result?.data) throw new Error('截图失败 ' + name + ': ' + JSON.stringify(r.error || 'no data'));
  console.log('  存图 ' + name + '  (' + clip.width + 'x' + clip.height + ')');
  saveShot(name, r.result.data);
}
/** 整屏截图（含 HUD / banner / 结算面板） */
async function shootFull(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  if (!r.result?.data) throw new Error('截图失败 ' + name + ': ' + JSON.stringify(r.error || 'no data'));
  saveShot(name, r.result.data);
}

/** 清盘并暂停（直接置 paused，不弹暂停面板） */
const RESET = `(() => {
  const s = ZY.UI.getState();
  s.paused = true;
  s.units.length = 0;
  s.player.hand.length = 0;
  s.player.barracks.length = 0;
  for (let r=0;r<12;r++) for (let c=0;c<8;c++) s.grid[r][c]=null;
  return true;
})()`;
/** 拖拽 / 点按辅助（pointer 事件，与 probe 同手法） */
const DRAG_HELPERS = `
window.__cellXY = (r, c) => {
  const br = document.getElementById('board').getBoundingClientRect();
  return { x: br.left + (c + 0.5) * (br.width / 8), y: br.top + (r + 0.5) * (br.height / 12) };
};
window.__dragFrom = async (sel, tx, ty, settle) => {
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
  await new Promise(r2 => setTimeout(r2, settle == null ? 240 : settle));
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
`;

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

/* ================================================== 会话一：无尽（① ~ ⑦） */
console.log('== 会话一：无尽模式（暂停布阵，确定性）==');
await send('Page.navigate', { url: URL });
await sleep(1500);
await evalJs(`document.querySelector('.mode-btn[data-mode="endless"]').click()`);
await sleep(400);
await evalJs(`ZY.UI.getState().paused = true;`);
await evalJs(DRAG_HELPERS);

console.log('== ① 竖屏蛇形路径全景 ==');
const b1 = await evalJs(`(() => {
  const s = ZY.UI.getState();
  return {
    path: document.querySelectorAll('.cell.path').length,
    deploy: document.querySelectorAll('.cell.deploy').length,
    obstacle: document.querySelectorAll('.cell.obstacle').length,
    enter: document.querySelectorAll('.cell.enter').length,
    adou: document.querySelectorAll('.adou').length,
    spawnMark: document.querySelectorAll('.adou.spawn-mark').length,
    ratio: (() => { const r = document.getElementById('board').getBoundingClientRect(); return +(r.width / r.height).toFixed(3); })(),
  };
})()`);
console.log('   布局 ' + JSON.stringify(b1));
if (b1.path !== 37) throw new Error('主路格数异常: ' + b1.path);
if (b1.deploy !== 17) throw new Error('塔位格数异常: ' + b1.deploy);
if (b1.obstacle !== 24) throw new Error('障碍格数异常: ' + b1.obstacle);
if (b1.enter !== 1 || b1.spawnMark !== 1) throw new Error('入口/刷怪口标记异常');
if (Math.abs(b1.ratio - 8 / 12) > 0.02) throw new Error('棋盘比例异常: ' + b1.ratio);
await shoot('v5-1-board.png', 1, 1, 2);

console.log('== ② 征兵：10 起步每次 +2 不封顶 ==');
const rec = await evalJs(`(async () => {
  const s = ZY.UI.getState();
  s.player.bun = 999;
  const seq = [];
  for (let i = 0; i < 3; i++) {
    s.player.barracks.length = 0;
    document.getElementById('btn-recruit').click();
    await new Promise(r => setTimeout(r, 120));
    seq.push(s.player.recruitCost);
  }
  s.player.barracks.length = 4;   // 留 1 空槽 → 按钮显示当前成本
  await new Promise(r => setTimeout(r, 160));
  return { seq: seq, btn: document.getElementById('btn-recruit').textContent, bun: Math.floor(s.player.bun) };
})()`);
console.log('   征兵按钮数值序列 ' + JSON.stringify(rec.seq) + ' · 当前「' + rec.btn.trim() + '」');
if (rec.seq[0] !== 12 || rec.seq[1] !== 14 || rec.seq[2] !== 16) throw new Error('征兵成本序列异常: ' + JSON.stringify(rec.seq));
if (!/16/.test(rec.btn)) throw new Error('按钮未显示第 3 次征兵成本 16');
await shootEl('v5-2-recruit.png', '.dock', 2);

console.log('== ③ 一次征兵 5 张进军营（5 槽）==');
const bar = await evalJs(`(async () => {
  const s = ZY.UI.getState();
  s.player.bun = 999;
  s.player.barracks.length = 0;
  s.player.hand.length = 0;
  document.getElementById('btn-recruit').click();
  await new Promise(r => setTimeout(r, 260));
  return {
    cards: document.querySelectorAll('#barracks .card').length,
    slots: document.querySelectorAll('#barracks .slot').length,
    hand: document.querySelectorAll('#hand .card').length,
    state: s.player.barracks.length
  };
})()`);
console.log('   军营 ' + bar.cards + ' 张 / ' + bar.slots + ' 槽 · 手牌 ' + bar.hand + ' 张');
if (bar.cards !== 5 || bar.slots !== 5 || bar.hand !== 0 || bar.state !== 5) throw new Error('征兵 5 张进军营异常: ' + JSON.stringify(bar));
await shootEl('v5-3-barracks.png', '.dock', 2);

console.log('== ④ 刀+刀 = 刀²（等级角标）==');
await evalJs(RESET);
await evalJs(`(() => {
  const s = ZY.UI.getState();
  const add = (type, row, col, level) => {
    const u = ZY.Game.makeUnit(s, 'player', { cls:'soldier', type, char: ZY.UNITS[type].char, level, row, col, target: null });
    ZY.Game.addUnit(s, u); return u.id;
  };
  add('dao', 1, 3, 2);      // 刀²
  add('gong', 3, 5, 1);
  add('qiang', 5, 4, 3);
  const p = ZY.B.pathSeq('endless','player')[4];
  const e = ZY.Game.makeUnit(s,'enemy',{cls:'soldier',type:'zei',level:1,row:p.row,col:p.col,target:'player',pi:4});
  ZY.Game.addUnit(s, e);
  return true;
})()`);
await sleep(300);
const d2 = await evalJs(`(() => {
  const s = ZY.UI.getState();
  const t = s.grid[1][3];
  const el = t ? document.querySelector('.unit.p[data-uid="' + t.id + '"]') : null;
  return { level: t ? t.level : -1, lv: el ? (el.querySelector('.lv') || {}).textContent : null, char: t ? t.char : null };
})()`);
console.log('   刀塔 ' + d2.char + ' Lv' + d2.level + ' · 角标「' + d2.lv + '」');
if (d2.level !== 2 || d2.lv !== '2' || d2.char !== '刀') throw new Error('刀² 等级角标异常: ' + JSON.stringify(d2));
await shoot('v5-4-dao2.png', 2.2, 0.52);

console.log('== ⑤ 手牌凑齐赵+云 → 金字黄色发光 ==');
await evalJs(RESET);
await evalJs(`(() => {
  const s = ZY.UI.getState();
  s.player.hand.push({ uid: 900001, kind: 'gold', char: '赵', level: 1 });
  s.player.hand.push({ uid: 900002, kind: 'gold', char: '云', level: 1 });
  return true;
})()`);
await sleep(320);
const pair = await evalJs(`(() => ({
  pair: document.querySelectorAll('#hand .card.pair').length,
  gold: document.querySelectorAll('#hand .card.gold').length,
  ready: !!(ZY.heroSynthReady(ZY.UI.getState(), 'player'))
}))()`);
console.log('   金字 ' + pair.gold + ' 张 · 黄光 .pair ' + pair.pair + ' 张 · 可合成 ' + pair.ready);
if (pair.pair !== 2 || pair.gold !== 2 || !pair.ready) throw new Error('武将字对黄光异常: ' + JSON.stringify(pair));
await shootEl('v5-5-pair.png', '.hand', 3);

console.log('== ⑥ 点金字 →「合成武将」提示 + 2 格武将卡 ==');
const tap = await evalJs(`(async () => {
  return await window.__tapEl('#hand .card[data-uid="900001"]');
})()`);
if (tap && tap.err) throw new Error(tap.err);
const syn = await evalJs(`(() => {
  const s = ZY.UI.getState();
  const hero = document.querySelector('#hand .card.hero');
  const b = document.getElementById('banner');
  return {
    banner: b.textContent, shown: b.classList.contains('show'),
    heroCard: !!hero, span: hero ? hero.style.gridColumn : null,
    txt: hero ? hero.textContent : null,
    handCards: document.querySelectorAll('#hand .card').length
  };
})()`);
console.log('   banner「' + syn.banner + '」· 武将卡 span=' + syn.span + '「' + syn.txt + '」');
if (!syn.shown || syn.banner.indexOf('合成武将') < 0) throw new Error('合成武将 banner 异常: ' + syn.banner);
if (!syn.heroCard || syn.span !== 'span 2') throw new Error('武将卡 2 格宽异常: ' + JSON.stringify(syn));
await shootFull('v5-6-synth.png');

console.log('== ⑦ 赵云武将塔横跨 2 格 ==');
const heroCard = await evalJs(`(() => {
  const c = document.querySelector('#hand .card.hero');
  return c ? +c.dataset.uid : 0;
})()`);
const hp = await evalJs(`(async () => {
  const p = window.__cellXY(1, 5);
  return await window.__dragFrom('#hand .card.hero[data-uid="${heroCard}"]', p.x, p.y);
})()`);
if (hp && hp.err) throw new Error(hp.err);
const sp = await evalJs(`(() => {
  const s = ZY.UI.getState();
  const el = document.querySelector('.unit.p.hero');
  const br = document.getElementById('board').getBoundingClientRect();
  const cellW = br.width / 8;
  return {
    placed: !!(s.grid[1][5] && s.grid[1][5].cls === 'hero'),
    booked: s.grid[1][6] === s.grid[1][5],
    span2: el ? el.classList.contains('span2') : false,
    ratio: el ? +(el.getBoundingClientRect().width / cellW).toFixed(2) : 0,
    name: el ? (el.querySelector('.nm') || {}).textContent : null,
    heroId: s.grid[1][5] ? s.grid[1][5].heroId : null
  };
})()`);
console.log('   赵云塔 @1,5 · 双格记账 ' + sp.booked + ' · 宽度 ' + sp.ratio + ' 格 · span2 ' + sp.span2);
if (!sp.placed || !sp.booked || !sp.span2 || Math.abs(sp.ratio - 2) > 0.05 || sp.name !== '赵云' || sp.heroId !== 'zhaoyun') {
  throw new Error('2 格武将塔异常: ' + JSON.stringify(sp));
}
await shoot('v5-7-span2.png', 1.7, 0.42);

/* ================================================== 会话二：击杀 +1 飘字（⑧） */
console.log('== 会话二：击杀普通敌人 +1 飘字 ==');
await send('Page.navigate', { url: URL });
await sleep(1500);
await evalJs(`document.querySelector('.mode-btn[data-mode="endless"]').click()`);
await sleep(400);
await evalJs(RESET);
await evalJs(DRAG_HELPERS);
await evalJs(`(() => {
  const s = ZY.UI.getState();
  const t = ZY.Game.makeUnit(s, 'player', { cls:'soldier', type:'dao', char:'刀', level:2, row:1, col:3, target:null });
  ZY.Game.addUnit(s, t);
  const e = ZY.Game.makeUnit(s, 'enemy', { cls:'soldier', type:'zei', level:1, row:1, col:4, target:'player', pi:3 });
  e.move = 0; e.hp = 1; e.maxHp = 24;
  ZY.Game.addUnit(s, e);
  return true;
})()`);
await sleep(300);
const kill = await evalJs(`(async () => {
  const s = ZY.UI.getState();
  const bun0 = s.player.bun;
  s.paused = false;                       // 放行 tick：塔一刀秒杀 1 血敌人
  let pop = null;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 40));
    const el = document.querySelector('.pop.p-bun');
    if (el) { pop = el.textContent; break; }
  }
  await new Promise(r => setTimeout(r, 60));
  s.paused = true;
  return { pop: pop, gain: +(s.player.bun - bun0).toFixed(2), kills: s.stats.kills };
})()`);
console.log('   飘字「' + kill.pop + '」· 资源 +' + kill.gain + ' · 击杀 ' + kill.kills);
if (kill.pop !== '+1') throw new Error('击杀 +1 飘字异常: ' + JSON.stringify(kill));
if (kill.gain < 1 || kill.kills < 1) throw new Error('击杀入账异常: ' + JSON.stringify(kill));
await shoot('v5-8-kill.png', 1.8, 0.4);

/* ================================================== 会话三：关卡（⑨ 张梁 / ⑩ 胜利结算） */
console.log('== 会话三：关卡模式（张梁登场 + 胜利结算）==');
await send('Page.navigate', { url: URL });
await sleep(1500);
await evalJs(`document.querySelector('.mode-btn[data-mode="level"]').click()`);
await sleep(400);
await evalJs(RESET);
await evalJs(DRAG_HELPERS);
// 把波次机器推到第 6 波（关底）：横幅「第 6 波 · 关底 来袭」；张梁直接落右侧刷怪口定格
await evalJs(`(() => {
  const s = ZY.UI.getState();
  s.player.adou = 1e9;
  s.wave.idx = 5; s.wave.done = false; s.wave.pending = []; s.wave.timer = s.wave.interval;
  s.paused = false;
  return true;
})()`);
await sleep(350);   // 让波次机器跑起来（关底横幅上屏）
await evalJs(`(() => {
  const s = ZY.UI.getState();
  // 清掉行军队只留张梁（截图确定性；横幅保留在 DOM）
  s.wave.pending.length = 0;
  s.units = s.units.filter((u) => u.side !== 'enemy');
  const p = ZY.B.entrances('level', 'player')[0];
  const b = ZY.Game.makeUnit(s, 'enemy', { cls:'soldier', type:'zei', level:2, row:p.row, col:p.col, boss:true, target:'player', pi:0 });
  b.move = 0;                 // 定住，方便截图
  ZY.Game.addUnit(s, b);
  s.fx.push({ type:'toast', text:'敌方名将 张梁 登场！' });
  s.fx.push({ type:'big', row:p.row, col:p.col, text:'张梁' });
  s.paused = true;
  return true;
})()`);
await sleep(350);
const boss = await evalJs(`(() => {
  const s = ZY.UI.getState();
  const b = s.units.find((u) => u.boss && !u.dead);
  const el = b ? document.querySelector('.unit.e[data-uid="' + b.id + '"]') : null;
  return {
    name: b ? b.name : null, char: b ? b.char : null,
    row: b ? b.row : -1, col: b ? b.col : -1,
    dom: el ? (el.querySelector('.nm') || {}).textContent : null,
    hp: b ? Math.round(b.hp) : 0,
    banner: document.getElementById('banner').textContent
  };
})()`);
console.log('   张梁 @' + boss.row + ',' + boss.col + ' · DOM「' + boss.dom + '」· 血 ' + boss.hp + ' · 横幅「' + boss.banner + '」');
if (!boss.name || boss.name !== '张梁' || boss.char !== '梁' || boss.dom !== '张梁') throw new Error('张梁登场异常: ' + JSON.stringify(boss));
if (boss.banner.indexOf('关底') < 0) throw new Error('关底横幅异常: ' + boss.banner);
await shoot('v5-9-zhangliang.png', 1.5, 0.5);

console.log('== ⑩ 关卡胜利结算（1-5 星）==');
const win = await evalJs(`(async () => {
  const s = ZY.UI.getState();
  s.player.adou = 3;
  s.units = s.units.filter((u) => u.side !== 'enemy');
  s.wave.done = true; s.wave.idx = 6; s.wave.pending = [];
  s.paused = false;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 50));
    const ov = document.getElementById('overlay');
    if (!ov.hidden) {
      return {
        title: (ov.querySelector('h2') || {}).textContent,
        starsOn: ov.querySelectorAll('.stars i.on').length,
        starsOff: ov.querySelectorAll('.stars i.off').length,
        promote: (ov.querySelector('.promote') || {}).textContent,
        coin: (ov.querySelector('.coin-row') || {}).textContent,
        double: !!ov.querySelector('[data-act="double"]'),
        win: (ov.querySelector('.panel') || {}).className
      };
    }
  }
  return null;
})()`);
console.log('   结算「' + win.title + '」· ' + win.starsOn + ' 星 · ' + win.promote + ' · ' + win.coin.replace(/\s+/g, ' '));
if (!win || win.title !== '胜 利' || win.starsOn !== 5 || win.starsOff !== 0) throw new Error('胜利星级异常: ' + JSON.stringify(win));
if (win.promote.indexOf('恭喜晋升') < 0 || win.coin.indexOf('+20') < 0 || !win.double) throw new Error('结算内容异常: ' + JSON.stringify(win));
if (win.win.indexOf('win') < 0) throw new Error('结算面板样式异常: ' + win.win);
await shootFull('v5-10-win.png');

/* ================================================== 会话四：拖塔换位前后对比（⑪ ⑫） */
console.log('== 会话四：拖塔换位前后对比（等级角标不变）==');
await send('Page.navigate', { url: URL });
await sleep(1500);
await evalJs(`document.querySelector('.mode-btn[data-mode="endless"]').click()`);
await sleep(400);
await evalJs(RESET);
await evalJs(DRAG_HELPERS);
// 先记下开局两个相邻空塔位（建塔前取，保证是空闲的）
const frees = await evalJs(`(() => {
  const s = ZY.UI.getState();
  return [...document.querySelectorAll('.cell.deploy')].filter((c) => {
    const r = +c.dataset.r, col = +c.dataset.c;
    return !s.grid[r][col];
  }).map((c) => ({ row: +c.dataset.r, col: +c.dataset.c }));
})()`);
if (!frees || frees.length < 2) throw new Error('空塔位不足: ' + JSON.stringify(frees));
const slotA = frees[0], slotB = frees[1];
// 用真·拖卡合成造一座刀²（两张刀卡拖同一格）
await evalJs(`(() => {
  const s = ZY.UI.getState();
  s.player.bun = 999;
  s.player.hand.push({ uid: 611001, kind: 'unit', char: '刀', type: 'dao', level: 1 });
  s.player.hand.push({ uid: 611002, kind: 'unit', char: '刀', type: 'dao', level: 1 });
  return true;
})()`);
await sleep(240);
const pa = await evalJs(`window.__cellXY(${slotA.row}, ${slotA.col})`);
await evalJs(`(async () => { return await window.__dragFrom('#hand .card[data-uid="611001"]', ${pa.x}, ${pa.y}); })()`);
await evalJs(`(async () => { return await window.__dragFrom('#hand .card[data-uid="611002"]', ${pa.x}, ${pa.y}); })()`);
await sleep(300);
const before = await evalJs(`(() => {
  const s = ZY.UI.getState();
  const t = s.grid[${slotA.row}][${slotA.col}];
  const el = t ? document.querySelector('.unit.p[data-uid="' + t.id + '"]') : null;
  return {
    id: t ? t.id : 0, level: t ? t.level : -1,
    lv: el ? (el.querySelector('.lv') || {}).textContent : null,
    row: t ? t.row : -1, col: t ? t.col : -1
  };
})()`);
console.log('   换位前：刀 Lv' + before.level + ' @' + before.row + ',' + before.col + ' · 角标「' + before.lv + '」');
if (before.level !== 2 || before.lv !== '2') throw new Error('换位前等级异常: ' + JSON.stringify(before));
await shoot('v5-11-move-before.png', 2.2, 0.52);

// —— 拖着塔身换到 slotB ——
const pb = await evalJs(`window.__cellXY(${slotB.row}, ${slotB.col})`);
const dresp = await evalJs(`(async () => { return await window.__dragFrom('.unit.p[data-uid="${before.id}"]', ${pb.x}, ${pb.y}); })()`);
if (dresp && dresp.err) throw new Error(dresp.err);
await sleep(320);   // 0.18s 落定过渡
const after = await evalJs(`(() => {
  const s = ZY.UI.getState();
  const t = s.grid[${slotB.row}][${slotB.col}];
  const el = t ? document.querySelector('.unit.p[data-uid="' + t.id + '"]') : null;
  const er = el ? el.getBoundingClientRect() : null;
  const p = window.__cellXY(${slotB.row}, ${slotB.col});
  const near = er ? (Math.abs((er.left + er.width / 2) - p.x) < 6 && Math.abs((er.top + er.height / 2) - p.y) < 6) : false;
  return {
    same: t ? t.id === ${before.id} : false,
    level: t ? t.level : -1,
    lv: el ? (el.querySelector('.lv') || {}).textContent : null,
    oldCleared: s.grid[${slotA.row}][${slotA.col}] === null,
    near: near,
    toast: document.getElementById('toast').textContent
  };
})()`);
console.log('   换位后：刀 Lv' + after.level + ' @' + slotB.row + ',' + slotB.col + ' · 角标「' + after.lv + '」· 旧格清空 ' + after.oldCleared + ' · toast「' + after.toast.trim() + '」');
if (!after.same || after.level !== 2 || after.lv !== '2' || !after.oldCleared || !after.near) {
  throw new Error('换位后状态异常: ' + JSON.stringify(after));
}
await shoot('v5-12-move-after.png', 2.2, 0.52);

console.log('完成，12 张证据在 ' + OUT);
ws.close();
proc.kill('SIGKILL');
process.exit(0);
