/* 第三批交付截图（无头 Edge + CDP，直接吃 file://）
 * 用法：node tools/zy-shots-batch3.mjs
 * 覆盖：① 塔信息卡「精铸 2/3」 ② 拆迁精英「拆」+ 塔闪白 ③ 失败复盘 ④ HUD 倒计时归位
 *      ⑤ 选关面板修罗档位 ⑥ 第 7 关 / 第 1 关地形对照 ⑦ 图鉴武器组
 *      + 812×375 安全区 + PC 1280×800 桌面
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');
const OUT = path.join(ROOT, 'tools', 'shots');
const PORT = 9455;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });

const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--mute-audio',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=C:/Users/31474/AppData/Local/Temp/zy-shot-b3',
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
  if (r.result && r.result.exceptionDetails) console.log('JS ERR ' + JSON.stringify(r.result.exceptionDetails).slice(0, 200));
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

const DRAG = `
window.__cellXY = (r, c) => {
  const br = document.getElementById('board').getBoundingClientRect();
  const rot = document.querySelector('.stage').classList.contains('rot');
  if (!rot) return { x: br.left + (c + 0.5) * (br.width / 8), y: br.top + (r + 0.5) * (br.height / 12) };
  return { x: br.right - (r + 0.5) * (br.width / 12), y: br.top + (c + 0.5) * (br.height / 8) };
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
};`;

await send('Page.enable');
await send('Runtime.enable');
await viewport(667, 375);
await send('Page.navigate', { url: URL });
await sleep(1500);

// 预置存档：全解锁 + 若干星，让选关/修罗/图鉴有内容
await js(`(function(){var S=ZY.Save; S.setLevel(7);
  for (var i=0;i<8;i++) S.setStar(i, 3 + (i % 3));
  ['unit:dao','unit:qiang','unit:gong','unit:qi','hero:zhaoyun','boss:zhangliang','boss:zhangjiao','weapon:tiejian','weapon:qinggang','level:0','level:6','level:7']
    .forEach(function(k){ S.markCodex(k); });
  S.setAscension(2); return 1; })()`);
await sleep(200);
await reload();

/* ⑤ 选关面板（含顶部修罗档位条） */
await click('#menu-nav [data-nav="select"]');
await sleep(400);
await shot('b3-05-level-select-asc');
await click('[data-act="close-panel"]');
await sleep(200);

/* ⑦ 图鉴（滚到武器组） */
await click('#menu-nav [data-nav="codex"]');
await sleep(400);
await js(`(function(){var ov=document.getElementById('overlay');
  var ps=[].slice.call(ov.querySelectorAll('p.dim'));
  var w=ps.filter(function(p){return p.textContent.indexOf('武器')===0;})[0];
  if(w) w.scrollIntoView({block:'center'}); return 1;})()`);
await sleep(300);
await shot('b3-07-codex-weapon');
await click('[data-act="close-panel"]');
await sleep(200);

/* ⑥-a 第 1 关地形 */
await js(`(function(){ ZY.Save.setLevel(0); return 1; })()`);
await click('.mode-btn[data-mode="level"]');
await sleep(700);
await shot('b3-06a-map1');
await reload();

/* ⑥-b 第 7 关地形（新图） */
await js(`(function(){ ZY.Save.setLevel(7); return 1; })()`);
await reload();
await click('#menu-nav [data-nav="select"]');
await sleep(350);
await click('.lv-card[data-idx="6"]');
await sleep(800);
await shot('b3-06b-map7');
await reload();

/* ① 塔信息卡「精铸 2/3」：无尽局造塔 + 喂两张同字卡（1 级 → 3 级、精铸 2） */
await click('.mode-btn[data-mode="endless"]');
await sleep(700);
await js(DRAG);
await js(`(function(){ var s=ZY.UI.getState();
  s.player.bun = 400;
  s.player.hand.push({ uid: 991001, kind:'unit', char:'刀', type:'dao', level:1 });
  s.player.hand.push({ uid: 991002, kind:'unit', char:'刀', type:'dao', level:1 });
  s.player.hand.push({ uid: 991003, kind:'unit', char:'刀', type:'dao', level:1 });
  return 1; })()`);
await sleep(400);
const refined = await js(`(function(){ var s=ZY.UI.getState();
  var free=[].slice.call(document.querySelectorAll('.cell.deploy')).filter(function(c){ return !s.grid[+c.dataset.r][+c.dataset.c]; })[0];
  var r=+free.dataset.r, c=+free.dataset.c;
  ZY.Game.deploy(s,'player',991001,r,c);
  ZY.Game.deploy(s,'player',991002,r,c);
  ZY.Game.deploy(s,'player',991003,r,c);
  var t=s.grid[r][c];
  window.__lastTower = t;
  return { level: t.level, refined: t.refined, hp: Math.round(t.hp), max: Math.round(t.maxHp) }; })()`);
console.log('   塔：Lv' + refined.level + ' 精铸 ' + refined.refined + '/3');
await sleep(500);
await js(`window.__tapEl('.unit.p[data-uid="' + window.__lastTower.id + '"]')`);
await sleep(500);
await shot('b3-01-unitcard-refined');

/* ② 拆迁精英「拆」（贴着塔的那一格）+ 塔闪白 / 掉血 */
const siege = await js(`(function(){ var s=ZY.UI.getState();
  var t=window.__lastTower;
  var seq=ZY.B.pathSeq(s.mode,'player',s.levelIdx);
  var cell=-1;
  for (var i=0;i<seq.length;i++){
    if (Math.abs(seq[i].row-t.row)+Math.abs(seq[i].col-t.col)===1){ cell=i; break; }
  }
  if (cell<0) return { err:'no adjacent path cell' };
  var mk=ZY.Game.makeUnit, got=null;
  for (var n=0;n<8 && !got;n++){
    var e=mk(s,'enemy',{cls:'soldier',type:'zei',level:3,elite:true,row:seq[cell].row,col:seq[cell].col,target:'player',pi:cell});
    if (e.trait==='siege'){ e.move=1e6; e.siegeT=1.0; ZY.Game.addUnit(s,e); got=e; }
  }
  if (!got) return { err:'no siege elite' };
  window.__siege=got;
  return { trait: got.trait, tag: got.traitTag, at: seq[cell].row+','+seq[cell].col }; })()`);
console.log('   拆迁精英：' + JSON.stringify(siege));
await sleep(520);
await js(`(function(){ var s=ZY.UI.getState(); var t=window.__lastTower;
  t.hp = Math.max(1, Math.round(t.maxHp * 0.45));
  s.fx.push({ type:'hit', row:t.row, col:t.col });
  s.fx.push({ type:'big', row:t.row, col:t.col, text:'塔受损' });
  return 1; })()`);
await sleep(120);
await shot('b3-02-siege-elite');

/* ③ 失败复盘：第 8 关，一条敌军漏到阿斗（关卡复盘三行 + 诊断） */
await reload();
await click('.mode-btn[data-mode="level"]');
await sleep(900);
await js(`(function(){ var s=ZY.UI.getState(); s.player.adou=1; s.stats.peakEnemies = 9; return 1; })()`);
await js(`(async function(){ var s=ZY.UI.getState();
  var seq=ZY.B.pathSeq(s.mode,'player',s.levelIdx);
  var pi=seq.length-2, p=seq[pi];
  var e=ZY.Game.makeUnit(s,'enemy',{cls:'soldier',type:'zei',level:1,row:p.row,col:p.col,target:'player',pi:pi});
  ZY.Game.addUnit(s,e);
  return 1; })()`);
await sleep(2600);
await shot('b3-03-lose-recap');
await reload();

/* ④ HUD 倒计时归位（第 8 关 · 带着倒计时与漏怪行） */
await click('.mode-btn[data-mode="level"]');
await sleep(1400);
await js(`(function(){ var s=ZY.UI.getState(); s.wave.timer = Math.max(0, s.wave.interval - 7); s.leaked.player = 1; return 1; })()`);
await sleep(600);
await shot('b3-04-hud-timer');

/* 812×375 安全区 */
await viewport(812, 375);
await sleep(600);
await shot('b3-08-safe-area-812');

/* PC 1280×800 */
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await sleep(600);
await reload();
await click('.mode-btn[data-mode="level"]');
await sleep(1200);
await shot('b3-09-desktop-1280x800');

try { ws.close(); } catch (e) { /* noop */ }
try { proc.kill(); } catch (e) { /* noop */ }
console.log('done → ' + OUT);
