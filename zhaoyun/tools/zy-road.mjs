/* 赵云与阿斗 · V7.2 白色路径连贯化复核（无头 Edge + CDP，竖屏 375×667）
 * 产出 2 张截图到 zhaoyun-v72-evidence/：
 *   ① v72-1-board.png   开局棋盘：主路为一条连贯白色长条，路上无格子断点
 *   ② v72-2-march.png   敌人踩在连贯白路上行军
 * 同时打印"接缝体检"：所有'主路-主路'相邻边必须边框透明 + 无内阴影 + 无背景图。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');
const OUT = 'D:/安装包/WorkBuddy/工作空间/2026-10-16-00-32-32/zhaoyun-v72-evidence';
const PORT = 9360;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--mute-audio',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=C:/Users/31474/AppData/Local/Temp/zy-road-profile',
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
await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 667, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: URL });
await sleep(1500);
await evalJs(`document.querySelector('.mode-btn[data-mode="endless"]').click()`);
await sleep(2600);   // 等开局横幅「守住阿斗」淡出

/* ① 开局棋盘 + 接缝体检 */
const c1 = await evalJs(`(() => {
  const s = ZY.UI.getState();
  s.paused = true;
  const cells = [...document.querySelectorAll('.cell')];
  const at = {};
  cells.forEach(n => { at[n.dataset.r + ',' + n.dataset.c] = n; });
  const isPath = n => !!n && n.classList.contains('path') && !n.classList.contains('obstacle');
  let seams = 0, badSeams = [];
  cells.forEach(n => {
    if (!isPath(n)) return;
    const r = +n.dataset.r, c = +n.dataset.c;
    const cs = getComputedStyle(n);
    // 右邻 / 下邻是主路 → 该条边必须是透明边框（无分隔线）
    if (isPath(at[r + ',' + (c + 1)])) {
      seams++;
      if (cs.borderRightColor !== 'rgba(0, 0, 0, 0)' || parseFloat(cs.borderRightWidth) === 0) badSeams.push('R' + r + ',' + c + ' ' + cs.borderRightColor + '/' + cs.borderRightWidth);
    }
    if (isPath(at[(r + 1) + ',' + c])) {
      seams++;
      if (cs.borderBottomColor !== 'rgba(0, 0, 0, 0)' || parseFloat(cs.borderBottomWidth) === 0) badSeams.push('B' + r + ',' + c + ' ' + cs.borderBottomColor + '/' + cs.borderBottomWidth);
    }
  });
  const p = document.querySelector('.cell.path');
  const pcs = getComputedStyle(p);
  const cnt = sel => document.querySelectorAll(sel).length;
  const bg = sel => { const n = document.querySelector(sel); return n ? getComputedStyle(n).backgroundColor : 'none'; };
  function alphaOfCol(sh) { return sh; }
  return {
    path: cnt('.cell.path'), deploy: cnt('.cell.deploy'), waste: cnt('.cell.wasteland'), obstacle: cnt('.cell.obstacle'),
    plain: cnt('.cell:not(.path):not(.deploy):not(.wasteland):not(.obstacle):not(.enter):not(.break)'),
    peT: cnt('.cell.path.pe-t'), peR: cnt('.cell.path.pe-r'), peB: cnt('.cell.path.pe-b'), peL: cnt('.cell.path.pe-l'),
    seams: seams, badSeams: badSeams.slice(0, 6),
    innerRing: /inset 0 0 0 1px/.test(pcs.boxShadow),
    pathShadow: pcs.boxShadow.slice(0, 120),
    pathBgImg: pcs.backgroundImage,
    afterContent: getComputedStyle(p, '::after').content,
    borderStyle: pcs.borderTopStyle + '/' + pcs.borderTopWidth,
    cPath: bg('.cell.path'), cDeploy: bg('.cell.deploy'), cWaste: bg('.cell.wasteland'),
    cPlain: bg('.cell:not(.path):not(.deploy):not(.wasteland):not(.obstacle):not(.enter):not(.break)')
  };
})()`);
console.log('   ① 主路 ' + c1.path + ' 格 · 棕塔位 ' + c1.deploy + ' · 绿荒地 ' + c1.waste + ' · 荆棘 ' + c1.obstacle + ' · 米底 ' + c1.plain);
console.log('      轮廓边标记 t/r/b/l = ' + c1.peT + '/' + c1.peR + '/' + c1.peB + '/' + c1.peL + ' · 内部接缝 ' + c1.seams + ' 条，其中带分隔线的 ' + c1.badSeams.length + ' 条');
if (c1.badSeams.length) console.log('      ✗ ' + c1.badSeams.join(' ; '));
console.log('      主路 shadow=' + c1.pathShadow);
console.log('      主路 bgImage=' + c1.pathBgImg + ' · ::after content=' + c1.afterContent + ' · 边框=' + c1.borderStyle);
console.log('      色值 路=' + c1.cPath + ' 塔位=' + c1.cDeploy + ' 荒地=' + c1.cWaste + ' 空地=' + c1.cPlain);
await shot('v72-1-board.png');

/* ② 敌人在连贯白路上行军 */
const c2 = await evalJs(`(async () => {
  const s = ZY.UI.getState();
  const seq = ZY.B.pathSeq(s.mode, 'player', s.levelIdx);
  const put = (i, type) => {
    const p = seq[Math.min(i, seq.length - 2)];
    const u = ZY.Game.makeUnit(s, 'enemy', { cls:'soldier', type: type, level: 2, row: p.row, col: p.col, target: 'player', pi: Math.min(i, seq.length - 2) });
    u.move = 0.6;
    ZY.Game.addUnit(s, u);
    return u.id;
  };
  const ids = [put(2, 'zei'), put(5, 'dao'), put(8, 'qiang'), put(11, 'gong'), put(14, 'zei')];
  s.paused = false;
  await new Promise(t => setTimeout(t, 1100));
  s.paused = true;
  await new Promise(t => setTimeout(t, 60));
  const onPath = s.units.filter(u => u.side === 'enemy' && u.path && !u.dead).length;
  const rows = s.units.filter(u => u.side === 'enemy').map(u => u.row + ',' + u.col).join(' | ');
  return { n: onPath, rows: rows, seqLen: seq.length };
})()`);
console.log('   ② 主路长 ' + c2.seqLen + ' 格 · 在途敌人 ' + c2.n + ' 只 @ ' + c2.rows);
await shot('v72-2-march.png');

ws.close(); proc.kill();
console.log('V7.2 白路连贯复核截图完成 → ' + OUT);
process.exit(0);
