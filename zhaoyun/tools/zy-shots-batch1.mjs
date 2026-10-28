/* 第一批交付截图：主菜单星级 / 选关 / 图鉴 / 战绩 / 关底张角 / 安全区告急（812×375 横屏）+ PC 桌面
 * 用法：node tools/zy-shots-batch1.mjs
 * 说明：无头 Edge + CDP，直接吃 file://（与 probe.mjs 同一条链路），不依赖本地服务器。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');
const OUT = path.join(ROOT, 'tools', 'shots');
const PORT = 9444;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });

const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--mute-audio',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=C:/Users/31474/AppData/Local/Temp/zy-shot-b1',
  '--allow-file-access-from-files',
  '--window-size=812,375',
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
  if (r.result && r.result.exceptionDetails) console.log('JS ERR', JSON.stringify(r.result.exceptionDetails).slice(0, 160));
  return r.result && r.result.result ? r.result.result.value : null;
};
async function viewport(w, h) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false });
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  if (!r.result || !r.result.data) { console.log('shot fail', name); return; }
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64'));
  console.log('  ✓ ' + name + '.png');
}
const click = (sel) => js('(function(){var e=document.querySelector(' + JSON.stringify(sel) + '); if(!e) return "no"; e.click(); return "ok";})()');

await send('Page.enable');
await send('Runtime.enable');
await viewport(812, 375);
await send('Page.navigate', { url: URL });
await sleep(1500);

// 预置存档：第 8 关解锁 + 若干星级，让面板有内容
await js(`(function(){var S=ZY.Save; S.setLevel(7); for (var i=0;i<8;i++) S.setStar(i, (i*2)%6); S.markCodex('unit:dao'); S.markCodex('unit:qiang'); S.markCodex('hero:zhaoyun'); S.markCodex('boss:zhangjiao'); S.markCodex('level:0'); S.setAscension(2); S.unlockAchv('first_win'); return 1;})()`);
await sleep(200);
await js('ZY.UI.init && null');
await js('location.reload()');
await sleep(1500);

await shot('b1-01-menu-812x375');

await click('#menu-nav [data-nav="select"]'); await sleep(350);
await shot('b1-02-level-select-812x375');
await click('[data-act="close-panel"]'); await sleep(200);

await click('#menu-nav [data-nav="codex"]'); await sleep(350);
await shot('b1-03-codex-812x375');
await click('[data-act="close-panel"]'); await sleep(200);

await click('#menu-nav [data-nav="record"]'); await sleep(350);
await shot('b1-04-record-812x375');
await click('[data-act="close-panel"]'); await sleep(200);

// 第 8 关（麦城 · 张角）——造出关底波与安全区告急
await click('.mode-btn[data-mode="level"]'); await sleep(700);
await js(`(function(){var s=ZY.UI.getState(); if(!s) return 'nostate';
  s.wave.idx=6; s.wave.done=true; s.wave.pending=[];
  var mk=ZY.Game.makeUnit;
  var a=ZY.B.adouAt(s.mode,'player',s.levelIdx);
  for (var i=0;i<3;i++){ var r=Math.max(0,a.row-1-i), c=a.col; var u=mk(s,'enemy',{cls:'soldier',type:'zei',level:3,hpMul:1,atkMul:1,row:r,col:c,target:'player'}); ZY.Game.addUnit(s,u); }
  return 'ok';})()`);
await sleep(500);
await shot('b1-05-safezone-812x375');

// 张角雷落：直接放一个关底 Boss
await js(`(function(){var s=ZY.UI.getState(); if(!s) return 'nostate';
  var b=ZY.Game.makeUnit(s,'enemy',{boss:true,bossKind:2,row:0,col:0,target:'player',hpMul:2.4,atkMul:1.6,level:3});
  ZY.Game.addUnit(s,b); s.banner={text:'张角 雷落',life:3}; return 'ok';})()`);
await sleep(600);
await shot('b1-06-zhangjiao-812x375');

await viewport(1280, 800);
await js('location.reload()');
await sleep(1500);
await shot('b1-07-menu-desktop');

try { ws.close(); } catch (e) { /* noop */ }
try { proc.kill(); } catch (e) { /* noop */ }
console.log('done → ' + OUT);
