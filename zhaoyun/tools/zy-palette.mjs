/* 赵云与阿斗 · V7.1 棋盘配色复核（无头 Edge + CDP，竖屏 375×667）
 * 产出 3 张截图到 zhaoyun-v71-evidence/：
 *   ① v71-1-board.png    开局棋盘：白路 / 棕塔位 / 绿荒地 / 米底 四色分明
 *   ② v71-2-shovel.png   荒地铲子开垦 → 变棕（可放置色）的瞬间
 *   ③ v71-3-march.png    敌人已在白路上行军
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');
const OUT = 'D:/安装包/WorkBuddy/工作空间/2026-10-16-00-32-32/zhaoyun-v71-evidence';
const PORT = 9358;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--mute-audio',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=C:/Users/31474/AppData/Local/Temp/zy-pal-profile',
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
await sleep(2600);   // 等开局横幅「守住阿斗」淡出，避免文字白光晕影响配色判读

/* ① 开局棋盘：四色统计 + 采样色值 */
const c1 = await evalJs(`(() => {
  const s = ZY.UI.getState();
  s.paused = true;
  const bg = sel => { const n = document.querySelector(sel); return n ? getComputedStyle(n).backgroundColor : 'none'; };
  const cnt = sel => document.querySelectorAll(sel).length;
  return {
    path: cnt('.cell.path'), deploy: cnt('.cell.deploy'), waste: cnt('.cell.wasteland'),
    plain: cnt('.cell:not(.path):not(.deploy):not(.wasteland):not(.obstacle):not(.enter):not(.break)'),
    obstacle: cnt('.cell.obstacle'),
    cPath: bg('.cell.path'), cDeploy: bg('.cell.deploy'), cWaste: bg('.cell.wasteland'),
    cPlain: bg('.cell:not(.path):not(.deploy):not(.wasteland):not(.obstacle):not(.enter):not(.break)')
  };
})()`);
console.log('   ① 白路 ' + c1.path + ' 格 · 棕塔位 ' + c1.deploy + ' · 绿荒地 ' + c1.waste + ' · 米底 ' + c1.plain + ' · 荆棘 ' + c1.obstacle);
console.log('      路=' + c1.cPath + ' 塔位=' + c1.cDeploy + ' 荒地=' + c1.cWaste + ' 空地=' + c1.cPlain);
await shot('v71-1-board.png');

/* ② 铲子开垦：找一块绿荒地 → useShovel → 变棕的瞬间（"扩塔位"浮字仍在） */
const c2 = await evalJs(`(async () => {
  const s = ZY.UI.getState();
  s.player.items = s.player.items || {};
  s.player.items.shovel = 3;
  // 选一块"孤立度最高"的绿荒地（周围棕塔位越少越好），开垦后新棕格最跳眼
  const br = document.getElementById('board').getBoundingClientRect();
  const dep = new Set([...document.querySelectorAll('.cell.deploy')].map(n => n.dataset.r + ',' + n.dataset.c));
  let cell = null, best = 1e9;
  document.querySelectorAll('.cell.wasteland').forEach(n => {
    const r = +n.dataset.r, c = +n.dataset.c;
    let near = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      if (dep.has((r + dr) + ',' + (c + dc))) near++;
    }
    const bx = n.getBoundingClientRect();
    const dx = (bx.left + bx.width / 2) - (br.left + br.width / 2);
    const dy = (bx.top + bx.height / 2) - (br.top + br.height / 2);
    const score = near * 1e6 + Math.abs(dy) * 10 + Math.abs(dx);
    if (score < best) { best = score; cell = n; }
  });
  const r = +cell.dataset.r, c = +cell.dataset.c;
  const before = getComputedStyle(cell).backgroundColor;
  const res = ZY.Game.useShovel(s, 'player', r, c);
  await new Promise(t => setTimeout(t, 150));
  const after = getComputedStyle(cell).backgroundColor;
  return { r: r, c: c, ok: res.ok, before: before, after: after,
           nowCls: cell.className, wasteLeft: document.querySelectorAll('.cell.wasteland').length,
           fxText: [...document.querySelectorAll('#fx *')].map(n => n.textContent).join('|') };
})()`);
console.log('   ② 开垦 (' + c2.r + ',' + c2.c + ') ok=' + c2.ok + ' · ' + c2.before + ' → ' + c2.after + ' · cls=' + c2.nowCls);
console.log('      浮字=' + (c2.fxText || '(无)') + ' · 剩余绿荒地 ' + c2.wasteLeft + ' 格');
await shot('v71-2-shovel.png');

/* ③ 敌人在白路行军：沿真实主路序列放置 → 短暂开跑 → 冻结截图 */
const c3 = await evalJs(`(async () => {
  const s = ZY.UI.getState();
  const seq = ZY.B.pathSeq(s.mode, 'player', s.levelIdx);
  const put = (i, type) => {
    const p = seq[Math.min(i, seq.length - 2)];
    const u = ZY.Game.makeUnit(s, 'enemy', { cls:'soldier', type: type, level: 2, row: p.row, col: p.col, target: 'player', pi: Math.min(i, seq.length - 2) });
    u.move = 0.6;
    ZY.Game.addUnit(s, u);
    return u.id;
  };
  const ids = [put(3, 'zei'), put(9, 'dao'), put(15, 'qiang'), put(21, 'gong')];
  s.paused = false;
  await new Promise(t => setTimeout(t, 900));
  s.paused = true;
  await new Promise(t => setTimeout(t, 60));
  const onPath = s.units.filter(u => u.side === 'enemy' && u.path && !u.dead).length;
  const rows = s.units.filter(u => u.side === 'enemy').map(u => u.row + ',' + u.col).join(' | ');
  return { n: onPath, ids: ids, rows: rows, seqLen: seq.length };
})()`);
console.log('   ③ 主路长 ' + c3.seqLen + ' 格 · 在途敌人 ' + c3.n + ' 只 @ ' + c3.rows);
await shot('v71-3-march.png');

ws.close(); proc.kill();
console.log('V7.1 配色复核截图完成 → ' + OUT);
process.exit(0);
