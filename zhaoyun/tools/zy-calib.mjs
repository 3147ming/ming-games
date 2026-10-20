/* 赵云与阿斗 · V6 数值校准肉眼复核（无头 Edge + CDP）
 * 场景：无尽模式 → 部署 赵云武将塔(1,5) + 刀塔(1,3)
 * 截图 4 张到 zhaoyun-v5-evidence/：
 *   ① v6-calib-default.png   默认战斗画面（等级角标隐藏）
 *   ② v6-calib-drag.png      拖动同字卡(刀)时，目标刀塔角标显示
 *   ③ v6-calib-select.png     点击赵云塔选中 → 角标显示
 *   ④ v6-calib-hero-atk.png  选中赵云塔的属性提示（攻 15.61）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');
const OUT = 'D:/安装包/WorkBuddy/工作空间/2026-10-16-00-32-32/zhaoyun-v5-evidence';
const PORT = 9356;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--mute-audio',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=C:/Users/31474/AppData/Local/Temp/zy-calib-profile',
  '--allow-file-access-from-files', '--window-size=390,844', 'about:blank',
], { stdio: 'ignore' });

async function waitPort() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/version'); if (r.ok) return; } catch (e) {}
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
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval 失败');
  return r.result?.result?.value;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
  console.log('  ✓ ' + name);
};

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: URL });
await sleep(1400);
await evalJs(`document.querySelector('.mode-btn[data-mode="endless"]').click()`);
await sleep(400);

// 部署 赵云武将塔(1,5) + 刀塔(1,3)
const setup = await evalJs(`(async () => {
  const s = ZY.UI.getState();
  s.paused = true;
  const z = ZY.Game.makeUnit(s, 'player', { cls:'hero', heroId:'zhaoyun', heroLevel:1, row:1, col:5, span:2, target:null });
  ZY.Game.addUnit(s, z);
  const d = ZY.Game.makeUnit(s, 'player', { cls:'soldier', type:'dao', level:1, row:1, col:3, target:null });
  ZY.Game.addUnit(s, d);
  await new Promise(r => setTimeout(r, 200));
  const zEl = document.querySelector('.unit.p.hero');
  const dEl = document.querySelector('.unit.p:not(.hero)');
  return {
    zAtk: z.atk, zEl: !!zEl, dEl: !!dEl,
    zBadgeVis: zEl && zEl.querySelector('.lv') ? getComputedStyle(zEl.querySelector('.lv')).visibility : 'n/a',
    dBadgeVis: dEl && dEl.querySelector('.lv') ? getComputedStyle(dEl.querySelector('.lv')).visibility : 'n/a'
  };
})()`);
console.log('   setup: 赵云 atk=' + setup.zAtk + ' 赵云塔=' + setup.zEl + ' 刀塔=' + setup.dEl +
  ' 默认角标 赵云=' + setup.zBadgeVis + ' 刀=' + setup.dBadgeVis);
await sleep(200);
await shot('v6-calib-default.png');   // ① 默认无角标

// ② 拖动同字卡(刀) → 刀塔角标显示：推一张刀卡进手牌，按住拖向刀塔
await evalJs(`(async () => {
  const s = ZY.UI.getState();
  s.player.hand.push({ uid: 900001, kind:'unit', char:'刀', type:'dao', level:1 });
  await new Promise(r => setTimeout(r, 120));
})()`);
const cellXY = (r, c) => evalJs(`(() => { const b = document.getElementById('board').getBoundingClientRect(); return { x: b.left + (${c}+0.5)*(b.width/8), y: b.top + (${r}+0.5)*(b.height/12) }; })()`);
const dp = await cellXY(1, 3);
await evalJs(`(async () => {
  const card = document.querySelector('#hand .card[data-uid="900001"]');
  const r = card.getBoundingClientRect();
  const sx = r.left + r.width/2, sy = r.top + r.height/2;
  const mk = (t,x,y) => new PointerEvent(t, { clientX:x, clientY:y, bubbles:true, cancelable:true, pointerId:1, pointerType:'touch', isPrimary:true });
  card.dispatchEvent(mk('pointerdown', sx, sy));
  await new Promise(r2 => setTimeout(r2, 60));
  window.dispatchEvent(mk('pointermove', (sx+${dp.x})/2, (sy+${dp.y})/2));
  await new Promise(r2 => setTimeout(r2, 60));
  window.dispatchEvent(mk('pointermove', ${dp.x}, ${dp.y}));
  await new Promise(r2 => setTimeout(r2, 80));
})()`);
const dragVis = await evalJs(`(() => { const d = document.querySelector('.unit.p:not(.hero)'); return d && d.querySelector('.lv') ? getComputedStyle(d.querySelector('.lv')).visibility : 'n/a'; })()`);
console.log('   拖动同字卡时 刀塔角标 visibility=' + dragVis);
await shot('v6-calib-drag.png');   // ② 拖动同字卡 → 角标显示
// 释放
await evalJs(`(async () => { const mk=(t,x,y)=>new PointerEvent(t,{clientX:x,clientY:y,bubbles:true,cancelable:true,pointerId:1,pointerType:'touch',isPrimary:true}); window.dispatchEvent(mk('pointermove', ${dp.x}, ${dp.y})); window.dispatchEvent(mk('pointerup', ${dp.x}, ${dp.y})); await new Promise(r2=>setTimeout(r2,200)); })()`);

// ③④ 点击赵云塔选中 → 角标显示 + 属性提示（攻 15.61）
const zp = await cellXY(1, 5);
await evalJs(`(async () => {
  const el = document.querySelector('.unit.p.hero');
  const r = el.getBoundingClientRect();
  const x = r.left + r.width/2, y = r.top + r.height/2;
  const mk = (t,xx,yy) => new PointerEvent(t, { clientX:xx, clientY:yy, bubbles:true, cancelable:true, pointerId:2, pointerType:'touch', isPrimary:true });
  el.dispatchEvent(mk('pointerdown', x, y));
  await new Promise(r2 => setTimeout(r2, 60));
  window.dispatchEvent(mk('pointerup', x, y));
  await new Promise(r2 => setTimeout(r2, 200));
})()`);
const after = await evalJs(`(() => {
  const z = document.querySelector('.unit.p.hero');
  const vis = z && z.querySelector('.lv') ? getComputedStyle(z.querySelector('.lv')).visibility : 'n/a';
  const toast = document.getElementById('toast').textContent;
  return { vis: vis, toast: toast };
})()`);
console.log('   点击赵云塔后 角标 visibility=' + after.vis + ' · toast="' + after.toast + '"');
await shot('v6-calib-select.png');   // ③ 点击选中 → 角标显示
await shot('v6-calib-hero-atk.png'); // ④ 属性提示（攻 15.61）

ws.close(); proc.kill();
console.log('校准复核截图完成 → ' + OUT);
process.exit(0);
