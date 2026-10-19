/* 赵云与阿斗 · V6 视觉打磨肉眼复核（无头 Edge + CDP 截图）
 * 用法：node tools/zy-visual.mjs
 * 输出：../evidence/v6-start.png 与 v6-board.png（证据目录由 OUT 指定）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = path.join(ROOT, 'index.html');
const URL = 'file:///' + INDEX.replace(/\\/g, '/');
const OUT = 'D:/安装包/WorkBuddy/工作空间/2026-10-16-00-32-32/zhaoyun-v5-evidence';
fs.mkdirSync(OUT, { recursive: true });
const PORT = 9348;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--mute-audio',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=C:/Users/31474/AppData/Local/Temp/zy-visual-profile',
  '--allow-file-access-from-files', '--window-size=390,844', 'about:blank',
], { stdio: 'ignore' });

async function waitPort() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/version'); if (r.ok) return await r.json(); } catch (e) {}
    await sleep(300);
  }
  throw new Error('Edge 未启动');
}
let mid = 0; const pending = new Map();
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
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => { const id = ++mid; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pending.set(id, r)); };
const evalJs = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval'); return r.result?.result?.value; };
async function shoot(name, clip) {
  const r = await send('Page.captureScreenshot', { format: 'png', clip: clip ? { ...clip, scale: 2 } : undefined, captureBeyondViewport: true });
  const buf = Buffer.from(r.result.data, 'base64');
  const f = path.join(OUT, name);
  fs.writeFileSync(f, buf);
  console.log('  截图 ' + name + '  ' + buf.length + 'B');
}

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: URL });
await sleep(1600);

// 1) 开始界面
const startBox = await evalJs(`(() => { const s = document.getElementById('screen-start').getBoundingClientRect(); return {x:0,y:0,width:window.innerWidth,height:window.innerHeight}; })()`);
await shoot('v6-start.png', startBox);

// 2) 进入无尽 + 征兵 + 拖 3 张不同类型卡到棋盘
await evalJs(`document.querySelector('.mode-btn[data-mode="endless"]').click()`);
await sleep(400);
await evalJs(`document.getElementById('btn-recruit').click();`);
await sleep(400);
const helpers = `
window.__cellXY = (r,c) => { const b=document.getElementById('board').getBoundingClientRect(); return {x:b.left+(c+0.5)*(b.width/8), y:b.top+(r+0.5)*(b.height/12)}; };
window.__dragBar = async (idx, r, c) => {
  const cards=[...document.querySelectorAll('#barracks .card')]; const el=cards[idx]; if(!el) return {err:'no card '+idx};
  const rr=el.getBoundingClientRect(); const sx=rr.left+rr.width/2, sy=rr.top+rr.height/2;
  const t=window.__cellXY(r,c);
  const mk=(t,x,y)=>new PointerEvent(t,{clientX:x,clientY:y,bubbles:true,cancelable:true,pointerId:1,pointerType:'touch',isPrimary:true});
  el.dispatchEvent(mk('pointerdown',sx,sy)); await new Promise(r=>setTimeout(r,60));
  window.dispatchEvent(mk('pointermove',(sx+t.x)/2,(sy+t.y)/2)); await new Promise(r=>setTimeout(r,60));
  window.dispatchEvent(mk('pointermove',t.x,t.y)); await new Promise(r=>setTimeout(r,60));
  window.dispatchEvent(mk('pointerup',t.x,t.y)); await new Promise(r=>setTimeout(r,300));
  return {ok:true};
};`;
await evalJs(helpers);
// 确定性上盘：直接用 deploy API 把军营里的兵种卡放到前 5 个合法塔位
await evalJs(`(() => {
  const s = ZY.UI.getState();
  const spots = [...document.querySelectorAll('.cell')]
    .map((c,i)=>({i, dep:c.className.indexOf('deploy')>=0}))
    .filter(x=>x.dep).map(x=>({r:Math.floor(x.i/8), c:x.i%8}));
  let placed = 0;
  for (const sp of spots) {
    const bar = s.player.barracks;
    if (!bar || !bar.length) break;
    let card = null;
    while (bar.length && !card) { const c = bar[0]; if (c.kind === 'unit') card = c; else bar.shift(); }
    if (!card) break;
    const res = ZY.Game.deploy(s, 'player', card.uid, sp.r, sp.c);
    if (res && res.ok) placed++;
    if (placed >= 5) break;
  }
  return placed;
})()`);
await sleep(300);
// #31 验证：关底名将张梁改为「领队先出」，此处确定性放置一名张梁到主路中段，
// 肉眼复核名将渲染（紫色武将调 + 名牌「张梁」）。
await evalJs(`(() => {
  const s = ZY.UI.getState();
  const u = ZY.Game.makeUnit(s, 'enemy', { cls:'soldier', type:'boss', level:3, boss:true, target:'player', row:5, col:3 });
  ZY.Game.addUnit(s, u);
  s.banner = null;                       // 清掉「守住阿斗」开场横幅，避免遮挡名将
  return 'zhaoliang@' + u.row + ',' + u.col;
})()`);
await sleep(500);
const types = await evalJs(`[...document.querySelectorAll('.units .unit')].map(u=>u.className).join(' | ')`);
console.log('   棋盘单位类名: ' + types);
const boardBox = await evalJs(`(() => { const b=document.getElementById('board').getBoundingClientRect(); return {x:Math.round(b.left),y:Math.round(b.top),width:Math.round(b.width),height:Math.round(b.height)}; })()`);
await shoot('v6-board.png', boardBox);

console.log('完成 → ' + OUT);
proc.kill('SIGKILL');
