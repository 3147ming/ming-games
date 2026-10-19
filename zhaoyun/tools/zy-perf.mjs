/* 赵云与阿斗 · V6 性能测量（无头 Edge + CDP，A/B 对比用）
 * 场景：无尽模式 + 满编塔阵（~17 塔）+ 24 个混合敌兵沿主路行军（含精英），
 *       塔攻击 / 技能 / 血条 / 飘字全负载。
 * 指标：包住 requestAnimationFrame 回调，用 performance.now() 精确测量
 *       loop() 每帧 JS 耗时（含 tick + 全部 sync + fx），不受无头软件光栅噪声影响。
 * 用法：node tools/zy-perf.mjs            （测量并打印 avg/p95/max，软预算 2.5 ms/帧）
 *       node tools/zy-perf.mjs --quiet    （只打印汇总行，便于 A/B 对比）
 *       node tools/zy-perf.mjs --profile  （附加 CPU 采样画像 top12）
 *       node tools/zy-perf.mjs --shot     （测量后抓一张战斗中棋盘截图做肉眼复核）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');
const OUT = 'D:/安装包/WorkBuddy/工作空间/2026-10-16-00-32-32/zhaoyun-v5-evidence';
const PORT = 9351;
const QUIET = process.argv.includes('--quiet');
const PROFILE = process.argv.includes('--profile');
const SHOT = process.argv.includes('--shot');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--mute-audio',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=C:/Users/31474/AppData/Local/Temp/zy-perf-profile',
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

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: URL });
await sleep(1600);

// —— 确定性压力场景 ——
await evalJs(`document.querySelector('.mode-btn[data-mode="endless"]').click()`);
await sleep(500);
const setup = await evalJs(`(() => {
  const s = ZY.UI.getState();
  s.player.bun = 9999;
  // 反复「征兵 → 全部上盘」直到塔位用满或无进展（模拟中后期满编塔阵）
  const spots = [...document.querySelectorAll('.cell')]
    .map((c, i) => ({ r: Math.floor(i / 8), c: i % 8, dep: c.className.indexOf('deploy') >= 0 }))
    .filter((x) => x.dep);
  let placed = 0;
  for (let round = 0; round < 8 && placed < spots.length; round++) {
    ZY.Game.recruit(s, 'player');
    for (const sp of spots) {
      if (placed >= spots.length) break;
      const bar = s.player.barracks;
      if (!bar || !bar.length) break;
      let card = null;
      while (bar.length && !card) { const c = bar[0]; if (c.kind === 'unit') card = c; else bar.shift(); }
      if (!card) break;
      const res = ZY.Game.deploy(s, 'player', card.uid, sp.r, sp.c);
      if (res && res.ok) placed++;
    }
  }
  // 24 个混合敌兵沿主路错位铺开（含精英），pi 显式给定 → 完全确定
  const path = ZY.B.pathSeq('endless', 'player', 0);
  const types = ['dao', 'gong', 'qi', 'nong', 'zei'];
  let spawned = 0;
  for (let i = 0; i < 24; i++) {
    const pi = Math.min(path.length - 1, 1 + Math.floor(i * 1.5));
    const p = path[pi];
    const u = ZY.Game.makeUnit(s, 'enemy', {
      cls: 'soldier', type: types[i % types.length], level: 2 + (i % 3),
      elite: i % 6 === 3, target: 'player', row: p.row, col: p.col, pi: pi,
    });
    ZY.Game.addUnit(s, u);
    spawned++;
  }
  return { towers: placed, enemies: spawned };
})()`);
await sleep(2500);   // 让战斗全面展开（攻击/技能/血条/飘字）后再开窗

// —— 精确测量：包住 rAF 回调，记录 loop() 每帧 JS 耗时 ——
await evalJs(`(() => {
  const orig = window.requestAnimationFrame.bind(window);
  window.__ms = [];
  window.requestAnimationFrame = function (cb) {
    return orig(function (ts) {
      const t = performance.now();
      cb(ts);
      window.__ms.push(performance.now() - t);
    });
  };
})()`);
if (PROFILE) { await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 100 }); await send('Profiler.start'); }
await sleep(4000);
const stats = await evalJs(`(() => {
  const a = window.__ms.slice().sort((x, y) => x - y);
  const q = (p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
  return { n: a.length, avg: a.reduce((s, x) => s + x, 0) / a.length, p50: q(0.5), p95: q(0.95), max: a[a.length - 1] };
})()`);
if (PROFILE) {
  const pr = await send('Profiler.stop');
  const self = {};
  pr.result.profile.nodes.forEach((n) => {
    const dt = (n.hitCount || 0) * 0.0001;
    const fn = n.callFrame.functionName || '(anonymous)';
    const url = (n.callFrame.url || '').split('/').pop();
    const k = fn + ' @ ' + url + ':' + (n.callFrame.lineNumber + 1);
    self[k] = (self[k] || 0) + dt;
  });
  console.log('CPU 画像自耗时 top：');
  Object.entries(self).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .forEach(([k, v]) => console.log('  ' + (v * 1000).toFixed(0).padStart(6) + ' ms  ' + k));
}
const line = `塔 ${setup.towers} · 敌 ${setup.enemies} | 帧 ${stats.n} | JS avg ${stats.avg.toFixed(3)} / p50 ${stats.p50.toFixed(3)} / p95 ${stats.p95.toFixed(3)} / max ${stats.max.toFixed(3)} ms`;
console.log(QUIET ? line : '压力场景：' + line);
const BUDGET = 2.5;
console.log(stats.avg <= BUDGET ? `  ✓ 每帧 JS 成本在预算内（avg ≤ ${BUDGET} ms）` : `  ⚠ 每帧 JS 成本超预算（avg > ${BUDGET} ms）`);
if (SHOT) {
  fs.mkdirSync(OUT, { recursive: true });
  const live = await evalJs(`(() => {
    const s = ZY.UI.getState();
    return {
      units: document.querySelectorAll('.units .unit').length,
      fx: document.getElementById('fx').childElementCount,
      enemyHp: [...document.querySelectorAll('.units .unit.e .hb u')].map((b) => b.style.width).filter(Boolean).slice(0, 6),
      flashes: document.querySelectorAll('.unit.a-hit, .unit.a-move').length,
    };
  })()`);
  const box = await evalJs(`(() => { const b = document.getElementById('board').getBoundingClientRect(); return {x:Math.round(b.left),y:Math.round(b.top),width:Math.round(b.width),height:Math.round(b.height)}; })()`);
  const r = await send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 2 }, captureBeyondViewport: true });
  const f = path.join(OUT, 'v6-perf-combat.png');
  fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'));
  console.log(`  截图 v6-perf-combat.png（单位 ${live.units} · fx ${live.fx} · 受击闪白 ${live.flashes} · 敌血条样例 ${live.enemyHp.join('/')}）`);
}
proc.kill('SIGKILL');
