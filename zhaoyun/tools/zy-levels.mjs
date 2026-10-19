/* 赵云与阿斗 · V6 新关卡地图肉眼复核（无头 Edge + CDP 截图）
 * 用法：node tools/zy-levels.mjs
 * 输出：../evidence 下 start + 第7关(街亭/左右翻转) + 第8关(麦城/上下翻转) 的整屏与棋盘布局图
 * 目的：肉眼复核「内容扩展·新关卡」派生的两张全新蛇形地图确实与 0 号原图不同、且入口/阿斗随之翻转。
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
const PORT = 9349;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--mute-audio',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=C:/Users/31474/AppData/Local/Temp/zy-levels-profile',
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
  fs.writeFileSync(path.join(OUT, name), buf);
  console.log('  截图 ' + name + '  ' + buf.length + 'B');
}
const FULL = `(() => ({x:0,y:0,width:window.innerWidth,height:window.innerHeight}))()`;
const BOARD = `(() => { const b=document.getElementById('board').getBoundingClientRect(); return {x:Math.round(b.left),y:Math.round(b.top),width:Math.round(b.width),height:Math.round(b.height)}; })()`;

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: URL });
await sleep(1600);

// 0) 开始界面（解锁到第 7 关，首页显示「第 7 关 · 街亭」）
await evalJs(`ZY.Save.setLevel(6)`);
await send('Page.reload');
await sleep(1600);
await shoot('v6-levels-start.png', await evalJs(FULL));

// 逐关：写存档 → 重载 → 点「关卡」按钮（startLevelRun(Save.getLevel)）→ 截图
async function shootLevel(idx, tag, label) {
  await evalJs(`ZY.Save.setLevel(${idx})`);
  await send('Page.reload');
  await sleep(1500);
  const info = await evalJs(`(() => { document.querySelector('.mode-btn[data-mode="level"]').click(); return 'clicked'; })()`);
  await sleep(650);
  const banner = await evalJs(`(() => { const s = ZY.UI.getState(); return { name: s.levelName, idx: s.levelIdx, ent: JSON.stringify(ZY.B.entrances(s.mode,'player',s.levelIdx)[0]), adou: JSON.stringify(ZY.B.adouAt(s.mode,'player',s.levelIdx)) }; })()`);
  console.log('   ' + label + ' → levelIdx=' + banner.idx + ' name=' + banner.name + ' 入口=' + banner.ent + ' 阿斗=' + banner.adou);
  await shoot('v6-' + tag + '-full.png', await evalJs(FULL));       // 含「第 X 关 · 名」横幅 + 棋盘
  await evalJs(`(() => { const s = ZY.UI.getState(); s.paused = true; s.banner = null; })()`);   // 冻结 + 去横幅
  await sleep(250);
  await shoot('v6-' + tag + '.png', await evalJs(BOARD));            // 纯棋盘布局（路径/塔位/入口/阿斗）
}

await shootLevel(6, 'level6', '第 7 关（左右翻转·街亭）');
await shootLevel(7, 'level7', '第 8 关（上下翻转·麦城）');

console.log('完成 → ' + OUT);
proc.kill('SIGKILL');
