/* 赵云与阿斗 · V3 动画证据截图（无头 Edge + CDP）
 * 生成 4 张证据图：①弓兵持弓拉弦 ②刀/枪攻击 ③敌方红色调小人 ④整盘无溢出
 * 用法：node tools/v3-shot.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
const URL = 'file:///' + INDEX.replace(/\\/g, '/');
const PORT = 9344;
const OUT = 'C:/Users/31474/AppData/Local/Temp/zy-v3';
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--mute-audio',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=C:/Users/31474/AppData/Local/Temp/zy-v3-profile',
  '--allow-file-access-from-files', '--window-size=420,900', 'about:blank',
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
async function shoot(name, zoom) {
  const rect = await evalJs(`(() => {
    const b = document.getElementById('board');
    if (${zoom} > 1) b.style.zoom = ${zoom}; else b.style.zoom = '';
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  await sleep(140);
  const clip = { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: Math.min(1200, rect.w), height: Math.min(1500, rect.h), scale: 1 };
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });
  if (!r.result?.data) throw new Error('截图失败 ' + name + ': ' + JSON.stringify(r.error || 'no data'));
  fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
  await evalJs(`document.getElementById('board').style.zoom = ''`);
  console.log('  存图 ' + name + '  (' + rect.w + 'x' + rect.h + ', ' + fs.statSync(path.join(OUT, name)).size + ' bytes)');
}

await waitPort();
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: URL });
await sleep(1500);

console.log('== 进入竞技并摆盘（暂停，确定性布阵）==');
await evalJs(`document.querySelector('.mode-btn[data-mode="versus"]').click()`);
await sleep(500);
const ids = await evalJs(`(() => {
  const s = ZY.UI.getState();
  if (!s) return { err: 'no state' };
  s.paused = true;
  s.units.length = 0;
  for (let r=0;r<12;r++) for (let c=0;c<8;c++) s.grid[r][c]=null;
  function add(side, type, row, col, o){ o=o||{};
    const u = ZY.Game.makeUnit(s, side, { cls:'soldier', type, char:(ZY.UNITS[type]?ZY.UNITS[type].char:type), level:o.level||1, row, col, elite:!!o.elite });
    if (o.hpFrac) u.hp = u.maxHp*o.hpFrac;
    ZY.Game.addUnit(s, u); return u.id;
  }
  const out = {};
  out.gong  = add('player','gong',9,2,{level:2,hpFrac:0.7});
  out.dao   = add('player','dao',9,4,{level:3,hpFrac:0.5,elite:true});
  out.qiang = add('player','qiang',9,5,{level:2,hpFrac:0.85});
  out.qi    = add('player','qi',10,3,{level:2,hpFrac:0.6});
  out.nong  = add('player','nong',10,6,{level:1});
  const h = ZY.Game.makeUnit(s,'player',{cls:'hero',heroId:'zhaoyun',heroLevel:2,row:9,col:1});
  ZY.Game.addUnit(s,h); out.hero = h.id;
  out.e1 = add('enemy','zei',2,2,{level:2,hpFrac:0.6});
  out.e2 = add('enemy','dao',2,4,{level:2,hpFrac:0.5,elite:true});
  return out;
})()`);
if (ids && ids.err) throw new Error(ids.err);
await sleep(260);

async function clearAttack() {
  await evalJs(`document.querySelectorAll('.unit.a-attack').forEach(e=>e.classList.remove('a-attack'))`);
}

// ① 弓兵持弓拉弦
await evalJs(`document.querySelector('.unit[data-uid="${ids.gong}"]').classList.add('a-attack','atk-gong')`);
await sleep(210);
await shoot('v3-1-gong-draw.png', 2.1);

// ② 刀兵挥砍 + 枪兵突刺
await clearAttack();
await evalJs(`document.querySelector('.unit[data-uid="${ids.dao}"]').classList.add('a-attack','atk-dao');
document.querySelector('.unit[data-uid="${ids.qiang}"]').classList.add('a-attack','atk-qiang')`);
await sleep(130);
await shoot('v3-2-dao-qiang.png', 2.1);

// ③ 敌方红色调小人（含一次攻击动作）
await clearAttack();
await evalJs(`document.querySelector('.unit[data-uid="${ids.e2}"]').classList.add('a-attack','atk-dao')`);
await sleep(150);
await shoot('v3-3-enemy-red.png', 2.1);

// ④ 整盘总览（无溢出 / 血条等级角标）
await clearAttack();
await sleep(140);
await shoot('v3-4-board.png', 1);

console.log('完成，证据在 ' + OUT);
ws.close();
proc.kill('SIGKILL');
process.exit(0);
