/**
 * 棋艺浏览器冒烟测试（headless Edge + CDP）。
 *   node tools/check-shanhai-browser.mjs
 * 验证：页面无 JS 报错；棋艺界面可打开；五子棋落子、象棋走子、暗棋翻棋均生效。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9222;
const BASE = 'http://127.0.0.1:5390/games/shanhai/index.html';

function startEdge() {
  return spawn(EDGE, [
    '--headless', '--no-sandbox', '--disable-gpu',
    `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
    'about:blank',
  ], { stdio: 'ignore', detached: false });
}

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page') || list[0];
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not ready */ }
    await sleep(250);
  }
  throw new Error('Edge CDP 未就绪');
}

function makeWs(url) {
  const ws = new WebSocket(url);
  const pend = new Map();
  const listeners = [];
  let id = 0;
  return new Promise((res) => {
    ws.addEventListener('open', () => res({
      send: (method, params = {}) => new Promise((resolve, reject) => {
        const i = ++id; pend.set(i, { resolve, reject });
        ws.send(JSON.stringify({ id: i, method, params }));
        setTimeout(() => { if (pend.has(i)) { pend.delete(i); reject(new Error('timeout ' + method)); } }, 20000);
      }),
      on: (fn) => listeners.push(fn),
      close: () => ws.close(),
    }));
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && pend.has(m.id)) { const { resolve, reject } = pend.get(m.id); pend.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
      else if (m.method) for (const fn of listeners) fn(m);
    });
    ws.addEventListener('error', () => {});
  });
}

const errors = [];
async function main() {
  const edge = startEdge();
  const url = await connect();
  const cdp = await makeWs(url);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  cdp.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      errors.push('exception: ' + (d.text || '') + (d.exception?.description ? ' :: ' + d.exception.description.slice(0, 200) : ''));
    }
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error')) {
      errors.push('console.error: ' + (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
    }
  });

  await cdp.send('Page.navigate', { url: BASE });
  await sleep(2500);

  const ev = (expr) => cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    .then((r) => { if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description || '').slice(0, 200)); return r.result.value; });

  const results = [];
  const check = (cond, msg) => { results.push((cond ? '✓ ' : '✗ ') + msg); if (!cond) errors.push('ASSERT: ' + msg); };

  // 界面存在
  check(await ev(`!!globalThis.ShanhaiChessUI`), 'ShanhaiChessUI 已加载');
  // 打开棋艺
  await ev(`document.getElementById('open-chess-stage').click()`);
  await sleep(300);
  check(await ev(`!document.getElementById('chess-screen').hidden`), '棋艺界面已打开');

  // 公共点击辅助：按 cell 坐标点击画布
  const clickCell = `(async (mode, x, y) => {
    const ui = globalThis.ShanhaiChessUI;
    const st = ui.debugState(); const L = ui.debugLayout();
    const cv = document.getElementById('chess-canvas');
    const r = cv.getBoundingClientRect();
    const px = r.left + L.ox + x * L.cell + L.cell/2;
    const py = r.top + L.oy + y * L.cell + L.cell/2;
    cv.dispatchEvent(new MouseEvent('click', {clientX:px, clientY:py, bubbles:true}));
    return true;
  })`;

  // —— 五子棋：开局 + 落子 ——
  await ev(`document.querySelector('[data-mode="gomoku"]').click()`);
  await sleep(400);
  check(await ev(`globalThis.ShanhaiChessUI.debugState().mode === 'gomoku'`), '五子棋已开始');
  const before = await ev(`(function(){const s=globalThis.ShanhaiChessUI.debugState();let n=0;for(let y=0;y<s.rows;y++)for(let x=0;x<s.cols;x++)if(s.board[y][x])n++;return n;})()`);
  await ev(`(${clickCell})('gomoku',7,7)`);
  await sleep(300);
  const after = await ev(`(function(){const s=globalThis.ShanhaiChessUI.debugState();let n=0;for(let y=0;y<s.rows;y++)for(let x=0;x<s.cols;x++)if(s.board[y][x])n++;return n;})()`);
  check(after === before + 1, `五子棋落子生效（子数 ${before}→${after}）`);

  // —— 象棋：开局 + 走一步 ——
  await ev(`document.getElementById('chess-tolobby').click()`);
  await sleep(200);
  await ev(`document.querySelector('[data-mode="xiangqi"]').click()`);
  await sleep(400);
  check(await ev(`globalThis.ShanhaiChessUI.debugState().mode === 'xiangqi'`), '象棋已开始');
  const turn0 = await ev(`globalThis.ShanhaiChessUI.debugState().turn`);
  // 取红方一个合法动作，点 from 再点 to
  const mv = await ev(`(function(){const C=globalThis.ShanhaiChessCore;const s=globalThis.ShanhaiChessUI.debugState();const a=C.allActions(s,'r')[0];return {from:a.from,to:a.to};})()`);
  await ev(`(${clickCell})('xiangqi',${mv.from[0]},${mv.from[1]})`);
  await sleep(200);
  await ev(`(${clickCell})('xiangqi',${mv.to[0]},${mv.to[1]})`);
  await sleep(300);
  const turn1 = await ev(`globalThis.ShanhaiChessUI.debugState().turn`);
  check(turn0 === 'r' && turn1 === 'b', `象棋走子生效（红→黑，实际 ${turn0}→${turn1}）`);

  // —— 暗棋：开局 + 翻一枚 ——
  await ev(`document.getElementById('chess-tolobby').click()`);
  await sleep(200);
  await ev(`document.querySelector('[data-mode="banqi"]').click()`);
  await sleep(400);
  check(await ev(`globalThis.ShanhaiChessUI.debugState().mode === 'banqi'`), '暗棋已开始');
  const down0 = await ev(`(function(){const s=globalThis.ShanhaiChessUI.debugState();let n=0;for(let y=0;y<s.rows;y++)for(let x=0;x<s.cols;x++){const c=s.board[y][x];if(c&&c.faceUp===false)n++;}return n;})()`);
  await ev(`(${clickCell})('banqi',0,0)`);
  await sleep(300);
  const down1 = await ev(`(function(){const s=globalThis.ShanhaiChessUI.debugState();let n=0;for(let y=0;y<s.rows;y++)for(let x=0;x<s.cols;x++){const c=s.board[y][x];if(c&&c.faceUp===false)n++;}return n;})()`);
  check(down1 === down0 - 1, `暗棋翻棋生效（覆面 ${down0}→${down1}）`);

  // —— 翻转棋：开局 + 落子夹反（切到双人模式，避免 AI 先手干扰测量）——
  await ev(`document.getElementById('chess-tolobby').click()`);
  await sleep(200);
  await ev(`document.querySelector('#chess-opts [data-vs="0"]').click()`);
  await ev(`document.querySelector('[data-mode="reversi"]').click()`);
  await sleep(400);
  check(await ev(`globalThis.ShanhaiChessUI.debugState().mode === 'reversi'`), '翻转棋已开始');
  const revBefore = await ev(`(function(){const s=globalThis.ShanhaiChessUI.debugState();let n=0;for(let y=0;y<s.rows;y++)for(let x=0;x<s.cols;x++)if(s.board[y][x])n++;return n;})()`);
  const revMv = await ev(`(function(){const C=globalThis.ShanhaiChessCore;const s=globalThis.ShanhaiChessUI.debugState();const a=C.allActions(s,s.turn)[0];return a.to;})()`);
  await ev(`(${clickCell})('reversi',${revMv[0]},${revMv[1]})`);
  await sleep(400);
  const revAfter = await ev(`(function(){const s=globalThis.ShanhaiChessUI.debugState();let n=0;for(let y=0;y<s.rows;y++)for(let x=0;x<s.cols;x++)if(s.board[y][x])n++;return n;})()`);
  check(revAfter > revBefore, `翻转棋落子夹反生效（子数 ${revBefore}→${revAfter}）`);

  // —— 西洋跳棋：开局 + 走一步 ——
  await ev(`document.getElementById('chess-tolobby').click()`);
  await sleep(200);
  await ev(`document.querySelector('[data-mode="checkers"]').click()`);
  await sleep(400);
  check(await ev(`globalThis.ShanhaiChessUI.debugState().mode === 'checkers'`), '跳棋已开始');
  const ch0 = await ev(`globalThis.ShanhaiChessUI.debugState().turn`);
  const chMv = await ev(`(function(){const C=globalThis.ShanhaiChessCore;const s=globalThis.ShanhaiChessUI.debugState();const a=C.allActions(s,'r')[0];return {from:a.from,to:a.to};})()`);
  await ev(`(${clickCell})('checkers',${chMv.from[0]},${chMv.from[1]})`);
  await sleep(200);
  await ev(`(${clickCell})('checkers',${chMv.to[0]},${chMv.to[1]})`);
  await sleep(300);
  const ch1 = await ev(`globalThis.ShanhaiChessUI.debugState().turn`);
  check(ch0 === 'r' && ch1 === 'b', `跳棋走子生效（红→黑，实际 ${ch0}→${ch1}）`);

  console.log(results.join('\n'));
  console.log('\nJS 错误数：' + errors.length);
  if (errors.length) console.log(errors.join('\n'));
  cdp.close();
  edge.kill('SIGTERM');
  process.exit(errors.length ? 1 : 0);
}
main().catch((e) => { console.error('smoke failed:', e.message); process.exit(2); });
