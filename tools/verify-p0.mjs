/* verify-p0.mjs — P0 三形态真实浏览器验收（无头 Edge/Chrome + CDP）
 *
 * 验证：大厅渲染 / 深链进游戏 / iframe 真正渲染游戏 DOM / 加载遮罩收起 /
 *       返回大厅后 iframe 被移除 / 前进后退 / console 0 error。
 * 不使用 --allow-file-access-from-files，模拟用户真实双击 file:// 的行为。
 *
 * 用法: node tools/verify-p0.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CDP_PORT = 9333;
const WEB_PORT = 5390;
const PROFILE = path.join(os.tmpdir(), 'mg-p0-cdp-' + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
];
const browser = BROWSERS.find((p) => fs.existsSync(p));
if (!browser) { console.error('[p0] 未找到 Edge/Chrome，无法做真实浏览器验收'); process.exit(2); }

let edge = null;
let webServer = null;
const checks = [];
function check(name, cond, detail) {
  checks.push({ name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
}

async function waitHttp(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return true; } catch { /* noop */ }
    await sleep(200);
  }
  return false;
}

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  let page = list.find((t) => t.type === 'page');
  if (!page) page = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`)).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  let id = 0;
  const pend = new Map();
  const listeners = [];
  ws.addEventListener('message', (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pend.has(m.id)) {
      const { resolve, reject } = pend.get(m.id);
      pend.delete(m.id);
      if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
    } else if (m.method) for (const fn of listeners) fn(m);
  });
  const api = {
    events: [],
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const i = ++id;
      pend.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
      setTimeout(() => { if (pend.has(i)) { pend.delete(i); reject(new Error('timeout ' + method)); } }, 30000);
    }),
    on: (fn) => listeners.push(fn),
    ws
  };
  api.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      api.events.push({ kind: 'exception', text: d.text, desc: d.exception && (d.exception.description || d.exception.value) });
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      api.events.push({ kind: 'console.error', text: (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300) });
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      api.events.push({ kind: 'log.error', text: m.params.entry.text, url: m.params.entry.url });
    }
  });
  await api.send('Runtime.enable');
  await api.send('Page.enable');
  await api.send('Log.enable');
  await api.send('Network.enable');
  return api;
}

async function evaluate(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result.value;
}

const LOBBY_STATE = `({
  title: document.title,
  cards: document.querySelectorAll('#hub-grid .card').length,
  listed: (window.__HUB_GAMES__ || []).length,
  clickable: document.querySelectorAll('a.card').length,
  brokenCovers: [...document.querySelectorAll('#hub-grid img')].filter(i => i.complete && i.naturalWidth === 0).length,
  hasRouter: !!window.HubRouter,
  hasBridge: !!window.HubBridge,
  readyIds: (window.__HUB_GAMES__ || []).filter(g => g.status === 'ready').map(g => g.id),
  subtitle: (document.getElementById('hubSub')||{}).textContent || ''
})`;

const GAME_STATE = `({
  hash: location.hash,
  iframes: document.querySelectorAll('#hub-stage iframe').length,
  iframeSrc: (document.querySelector('#hub-stage iframe')||{}).src || '',
  loadingHidden: document.getElementById('hub-loading').hidden,
  backVisible: !document.getElementById('hub-back').hidden,
  gridHidden: document.getElementById('hub-grid').hidden,
  iframeLoaded: !!window.__HUB_IFRAME_LOADED__,
  ready: window.__HUB_LAST_READY__ || null
})`;

async function verifyForm(cdp, label, baseUrl) {
  cdp.events.length = 0;
  await cdp.send('Page.navigate', { url: baseUrl });
  await sleep(1400);
  const lobby = await evaluate(cdp, LOBBY_STATE);
  check(`${label} · 大厅渲染全部已收录卡片`, lobby.cards === lobby.listed && lobby.listed > 0, `cards=${lobby.cards} listed=${lobby.listed}`);
  check(`${label} · 桥与路由已加载`, lobby.hasRouter && lobby.hasBridge, `router=${lobby.hasRouter} bridge=${lobby.hasBridge}`);
  check(`${label} · 可点卡片已接入`, lobby.clickable >= 1, `clickable=${lobby.clickable}`);
  check(`${label} · 封面 0 破图`, lobby.brokenCovers === 0, `brokenCovers=${lobby.brokenCovers}`);
  const lobbyErrors = cdp.events.filter((e) => !/favicon/i.test(e.text || ''));
  check(`${label} · 大厅 console 0 error`, lobbyErrors.length === 0,
    lobbyErrors.length ? JSON.stringify(lobbyErrors.slice(0, 3)) : '0 errors');
  check(`${label} · 至少 1 款已接入`, lobby.readyIds.length >= 1, `ready=${lobby.readyIds.join(',')}`);

  for (const id of lobby.readyIds) {
    const tag = `${label} · ${id}`;
    cdp.events.length = 0;
    await cdp.send('Page.navigate', { url: baseUrl + '#/game/' + id });
    await sleep(2200);
    const game = await evaluate(cdp, GAME_STATE);
    check(`${tag} · 深链进入游戏（iframe 已创建）`, game.iframes === 1, `iframes=${game.iframes} hash=${game.hash}`);
    check(`${tag} · 大厅隐藏 / 返回按钮可见`, game.gridHidden && game.backVisible, `gridHidden=${game.gridHidden} back=${game.backVisible}`);
    check(`${tag} · 加载遮罩已收起`, game.loadingHidden === true, `loadingHidden=${game.loadingHidden}`);
    check(`${tag} · iframe load 事件触发`, game.iframeLoaded === true, `iframeLoaded=${game.iframeLoaded}`);
    const ready = game.ready;
    const domOk = ready && ready.dom && (ready.dom.app === true || (ready.dom.bodyText || '').length > 10);
    check(`${tag} · 游戏 DOM 真的渲染了`, !!domOk, ready ? JSON.stringify(ready.dom).slice(0, 150) : 'no GAME_READY');
    check(`${tag} · 桥 GAME_READY 可达`, !!ready, ready ? 'received' : 'missing (bridge degraded)');
    const errs = cdp.events.filter((e) => !/favicon/i.test(e.text || ''));
    check(`${tag} · console / 未捕获异常 0 条`, errs.length === 0,
      errs.length ? JSON.stringify(errs.slice(0, 3)) : '0 errors');

    await evaluate(cdp, `location.hash = '#/'; 'ok'`);
    await sleep(420);
    const home = await evaluate(cdp, `({
      iframes: document.querySelectorAll('#hub-stage iframe').length,
      gridHidden: document.getElementById('hub-grid').hidden,
      backHidden: document.getElementById('hub-back').hidden
    })`);
    check(`${tag} · 返回大厅后 iframe 被销毁`, home.iframes === 0, `iframes=${home.iframes}`);
    check(`${tag} · 返回大厅后网格恢复`, home.gridHidden === false && home.backHidden === true, JSON.stringify(home));
  }

  if (lobby.readyIds.length) {
    const first = lobby.readyIds[0];
    await cdp.send('Page.navigate', { url: baseUrl + '#/game/' + first });
    await sleep(1400);
    await evaluate(cdp, `history.back(); 'ok'`);
    await sleep(900);
    const back = await evaluate(cdp, `({ hash: location.hash, iframes: document.querySelectorAll('#hub-stage iframe').length })`);
    check(`${label} · 浏览器后退可回大厅`, back.hash === '#/' || back.iframes === 0, JSON.stringify(back));
  }
  return { lobby };
}

async function main() {
  console.log('[p0] browser: ' + browser);
  webServer = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--root=dist', '--port=' + WEB_PORT],
    { stdio: 'ignore', cwd: ROOT });
  if (!await waitHttp(`http://127.0.0.1:${WEB_PORT}/`)) throw new Error('[p0] 本地服务未起来');

  edge = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + PROFILE,
    '--window-size=1280,900', '--disable-background-timer-throttling',
    'about:blank'
  ], { stdio: 'ignore' });
  if (!await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/version`)) throw new Error('[p0] CDP 端口未就绪');
  const cdp = await connect();

  const offlineFile = path.join(ROOT, 'offline', 'index.html').split(path.sep).join('/');
  const fileUrl = 'file:///' + offlineFile.replace(/^\/+/, '');
  console.log('[p0] file:// -> ' + fileUrl);

  await verifyForm(cdp, 'offline(file://)', fileUrl);
  await verifyForm(cdp, 'web(localhost)', `http://127.0.0.1:${WEB_PORT}/`);

  cdp.ws.close();
  edge.kill();
  edge = null;
  webServer.kill();
  webServer = null;

  const passed = checks.filter((c) => c.pass).length;
  console.log('\n=== P0 验收明细 ===');
  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ' :: ' + c.detail : ''}`);
  console.log(`=== P0 探针结果：${passed}/${checks.length} 通过 ===`);
  if (passed !== checks.length) process.exit(1);
}

try { await main(); }
catch (e) { console.error('[p0] 验收脚本异常: ' + (e.stack || e.message)); process.exit(1); }
finally {
  try { if (edge) edge.kill(); } catch { /* noop */ }
  try { if (webServer) webServer.kill(); } catch { /* noop */ }
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* noop */ }
}
