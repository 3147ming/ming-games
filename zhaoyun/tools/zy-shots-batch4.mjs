/* 第四批交付截图（无头 Edge + CDP，直接吃 file://）
 * 用法：node tools/zy-shots-batch4.mjs
 * 覆盖：① 开始界面 ② 新开局棋盘（配色核对） ③ 武将卡 span2 两格高亮
 *      ④ 合成瞬间（金光 + 光柱 + 飘字） ⑤ 结算面板入场 ⑥ 低配模式 ⑦ 桌面 1280×800
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');
const OUT = path.join(ROOT, 'tools', 'shots');
const PORT = 9457;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });

const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--mute-audio',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=C:/Users/31474/AppData/Local/Temp/zy-shot-b4',
  '--allow-file-access-from-files',
  '--window-size=667,375',
  'about:blank',
], { stdio: 'ignore' });

async function waitPort() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/version'); if (r.ok) return; } catch (e) { /* retry */ }
    await sleep(300);
  }
  throw new Error('Edge 未启动');
}
await waitPort();

let target = null;
for (let i = 0; i < 40 && !target; i++) {
  const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
  target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!target) await sleep(300);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });

let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params) => new Promise((res) => {
  const id = ++seq;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params: params || {} }));
});
const js = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) console.log('JS ERR ' + JSON.stringify(r.result.exceptionDetails).slice(0, 240));
  return r.result && r.result.result ? r.result.result.value : null;
};
async function viewport(w, h) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  if (!r.result || !r.result.data) { console.log('shot fail ' + name); return; }
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64'));
  console.log('  ✓ ' + name + '.png');
}
const reload = async () => { await js('location.reload()'); await sleep(1500); };
const click = (sel) => js('(function(){var e=document.querySelector(' + JSON.stringify(sel) + '); if(!e) return "no"; e.click(); return "ok";})()');

const HELP = `
window.__cellXY = (r, c) => {
  const br = document.getElementById('board').getBoundingClientRect();
  const rot = document.querySelector('.stage').classList.contains('rot');
  if (!rot) return { x: br.left + (c + 0.5) * (br.width / 8), y: br.top + (r + 0.5) * (br.height / 12) };
  return { x: br.right - (r + 0.5) * (br.width / 12), y: br.top + (c + 0.5) * (br.height / 8) };
};
window.__mk = (t, x, y) => new PointerEvent(t, { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', isPrimary: true });
window.__holdStart = async (sel, r, c) => {
  const card = document.querySelector(sel);
  if (!card) return { err: 'no card' };
  const b = card.getBoundingClientRect();
  card.dispatchEvent(window.__mk('pointerdown', b.left + b.width / 2, b.top + b.height / 2));
  await new Promise((x) => setTimeout(x, 70));
  const p = window.__cellXY(r, c);
  window.dispatchEvent(window.__mk('pointermove', p.x, p.y));
  await new Promise((x) => setTimeout(x, 110));
  return { hl: document.querySelectorAll('.cell.hl').length, hl2: document.querySelectorAll('.cell.hl2').length };
};
window.__holdEnd = async (r, c) => {
  const p = window.__cellXY(r, c);
  window.dispatchEvent(window.__mk('pointerup', p.x, p.y));
  await new Promise((x) => setTimeout(x, 240));
  return 1;
};`;

await send('Page.enable');
await send('Runtime.enable');
await viewport(667, 375);
await send('Page.navigate', { url: URL });
await sleep(1500);
await js(`(function(){ ZY.Save.setLevel(0); return 1; })()`);   // 固定从第 1 关拍，避免上次跑的进度影响
await reload();

/* ① 开始界面 */
await shot('b4-01-start');

/* ② 新开局棋盘（配色必须与改前一致；等关卡横幅淡出再拍） */
await click('.mode-btn[data-mode="level"]');
await sleep(2300);
await js(HELP);
await shot('b4-02-board');

/* ③ 武将卡 span2：两格同亮（塔位绿；右邻淡绿） */
const pos = await js(`(function(){
  var s = ZY.UI.getState();
  var slots = [].slice.call(document.querySelectorAll('.cell.deploy'));
  var good = slots.filter(function(c){
    var r = +c.dataset.r, cc = +c.dataset.c;
    return slots.some(function(x){ return +x.dataset.r === r && +x.dataset.c === cc + 1; }) && !s.grid[r][cc] && !s.grid[r][cc + 1];
  })[0];
  s.player.hand.push({ uid: 940001, kind: 'hero', heroId: 'zhaoyun', char: '赵云', level: 1, span: 2 });
  s.paused = true;                                     // 定格：不要让行军敌兵挡住落点预览
  s.units = s.units.filter(function (u) { return u.side === 'player'; });
  var card = document.querySelector('#hand .card');
  if (card) card.dataset.uid = '940001';
  return { r: +good.dataset.r, c: +good.dataset.c };
})()`);
await sleep(320);
await js(`window.__holdStart('#hand .card', ${pos.r}, ${pos.c})`);
await sleep(260);
console.log('   高亮: ' + JSON.stringify(await js(`({ hl: document.querySelectorAll('.cell.hl').length, hl2: document.querySelectorAll('.cell.hl2').length, ghost: (function(){ var g = document.querySelector('.ghost'); return g ? Math.round(g.getBoundingClientRect().left) + ',' + Math.round(g.getBoundingClientRect().top) : 'none'; })() })`)));
await shot('b4-03-span2-hl');
/* 同一帧再拍一张「隐藏幽灵」的干净版：只为看清两格高亮本身（幽灵会挡住落点中心） */
await js(`(function(){ var g = document.querySelector('.ghost'); if (g) g.style.display = 'none'; return 1; })()`);
await sleep(80);
await shot('b4-03b-span2-clean');
await js(`window.__holdEnd(${pos.r}, ${pos.c})`);

/* ④ 合成瞬间：真喂一张同级卡 → 金光 + 光柱 + 震屏 + 「刀² 合成 Lv2」 */
await js(`(async function(){
  var s = ZY.UI.getState();
  s.player.bun = 300;
  s.player.hand.push({ uid: 941001, kind: 'unit', char: '刀', type: 'dao', level: 1 });
  var slots = [].slice.call(document.querySelectorAll('.cell.deploy'));
  // 挑棋盘下半部的空塔位：避开顶部 HUD 与刚放下的武将塔，光柱和飘字才看得清
  var free = slots.filter(function(c){ var r=+c.dataset.r, cc=+c.dataset.c; return !s.grid[r][cc] && r >= 6; });
  var a = free[0] || slots[0];
  ZY.Game.deploy(s, 'player', 941001, +a.dataset.r, +a.dataset.c);
  s.player.hand.push({ uid: 941002, kind: 'unit', char: '刀', type: 'dao', level: 1 });
  ZY.Game.deploy(s, 'player', 941002, +a.dataset.r, +a.dataset.c);
  return 1;
})()`);
await sleep(300);
await shot('b4-04-merge');

/* ⑤ 结算面板入场（胜利面板 + 逐个弹出的星子） */
await js(`(function(){ ZY.Game.endGame(ZY.UI.getState(), 'win'); return 1; })()`);
await sleep(320);
await shot('b4-05-result');

/* ⑥ 低配模式：同一张棋盘，双击静音键前后对比 */
await reload();
await js(`(function(){ ZY.Save.setLevel(0); return 1; })()`);
await reload();
await click('.mode-btn[data-mode="level"]');
await sleep(2300);
await js(`(async function(){
  var s = ZY.UI.getState();
  s.player.bun = 500;
  var slots = [].slice.call(document.querySelectorAll('.cell.deploy'));
  var free = slots.filter(function(c){ var r=+c.dataset.r, cc=+c.dataset.c; return !s.grid[r][cc]; });
  var types = ['dao','qiang','gong','qi'];
  for (var i = 0; i < 4; i++) {
    var uid = 942000 + i;
    s.player.hand.push({ uid: uid, kind: 'unit', char: '兵', type: types[i], level: 1 });
    var a = free[i * 2];
    if (a) ZY.Game.deploy(s, 'player', uid, +a.dataset.r, +a.dataset.c);
  }
  return 1;
})()`);
await sleep(500);
await js(`(function(){ ZY.Save.setLowFx(false); document.body.classList.remove('lowfx'); return 1; })()`);   // 上一轮可能留下 lowfx，先归零
await sleep(160);
await shot('b4-06a-normal');
await js(`(function(){ var b=document.getElementById('btn-mute'); b.click(); setTimeout(function(){ b.click(); }, 90); return 1; })()`);
await sleep(500);
await shot('b4-06b-lowfx');

/* ⑦ 桌面 1280×800 */
await viewport(1280, 800);
await reload();
await js(`(function(){ ZY.Save.setLevel(0); return 1; })()`);
await reload();
await click('.mode-btn[data-mode="level"]');
await sleep(2300);
await shot('b4-07-desktop');

console.log('\n完成，输出目录: ' + OUT);
try { ws.close(); } catch (e) { /* noop */ }
try { proc.kill(); } catch (e) { /* noop */ }
