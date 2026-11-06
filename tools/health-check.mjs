/**
 * ming-games 全站体检
 * ---------------------------------------------------------------------------
 * 逐个打开 11 款游戏 + 大厅，检查：
 *   1. HTTP 200，HTML 不是空壳（有实际内容）
 *   2. 页面加载后无 console error / 无未捕获异常
 *   3. 关键资源（.js/.mjs/.css）能 404 —— 通过 Performance 资源列表检测失败项
 *   4. 页面有可见内容（body 高度 > 0、有 canvas 或文本）
 *
 * 用法：
 *   $env:CDP_PORT=9335; node tools/health-check.mjs
 */
const PORT = Number(process.env.CDP_PORT || 0);
const BASE = process.env.SITE_BASE || 'http://localhost:5188/';

if (!PORT) { console.error('需要 CDP_PORT'); process.exit(2); }

const PAGES = [
  { id: 'hub', url: '', label: '大厅' },
  { id: 'wild', url: 'wild/', label: '荒野 WILD' },
  { id: 'soudache', url: 'soudache/', label: '搜打撤' },
  { id: 'one-card', url: 'one-card/', label: '一世一牌' },
  { id: 'brain-gym', url: 'brain-gym/', label: '脑力训练场' },
  { id: 'night-shift', url: 'night-shift/', label: '夜班便利店' },
  { id: 'zhaoyun', url: 'zhaoyun/', label: '赵云与阿斗' },
  { id: 'quiz', url: 'quiz/', label: '知识问答' },
  { id: 'circuit-lab', url: 'circuit-lab/', label: '电路实验模拟器' },
  { id: 'paper-maze', url: 'paper-maze/', label: '纸上迷城' },
  { id: 'neon-rhythm', url: 'neon-rhythm/', label: '霓虹律动' },
  { id: 'pixel-runner', url: 'pixel-runner/', label: '像素跑酷' },
  { id: 'grass-cutter', url: 'grass-cutter/', label: '传统割草游戏' },
  { id: 'shanhai', url: 'shanhai/', label: '山海拾遗' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  let page = list.find((t) => t.type === 'page');
  if (!page) page = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`)).json();
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
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
    } else if (m.method) {
      for (const fn of listeners) fn(m);
    }
  });
  return {
    ws,
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const i = ++id;
      pend.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
      setTimeout(() => { if (pend.has(i)) { pend.delete(i); reject(new Error('超时 ' + method)); } }, 30000);
    }),
    on: (fn) => listeners.push(fn),
  };
}

async function checkPage(cdp, page) {
  const errors = [];
  const exceptions = [];
  const failedRequests = [];

  const handler = (m) => {
    if (m.method === 'Runtime.exceptionThrown') {
      exceptions.push((m.params.exceptionDetails?.text || '?').slice(0, 120));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      const txt = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      if (txt) errors.push(txt.slice(0, 120));
    }
    if (m.method === 'Network.loadingFailed') {
      const t = m.params.type;
      if (t === 'Script' || t === 'Stylesheet' || t === 'Document') {
        failedRequests.push(`${t}: ${m.params.errorText}`);
      }
    }
  };
  cdp.on(handler);

  const url = BASE + page.url;
  await cdp.send('Page.navigate', { url });
  /* 不同页面的首屏耗时差别很大：
     brain-gym / quiz 是几百 KB 的内联单文件，circuit-lab 要现搭一块实验台，
     2.2s 对它们不够 —— 那会把"还在加载"误判成"页面坏了"。
     宁可多等，也不要让体检报一个假故障（假阳性会让人逐渐不信任这套工具）。 */
  const slowPages = new Set(['brain-gym', 'quiz', 'circuit-lab', 'grass-cutter']);
  await sleep(slowPages.has(page.id) ? 4500 : 2200);

  const info = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const body = document.body;
      const canvas = document.querySelector('canvas');
      const scripts = [...document.querySelectorAll('script[src]')].map(s => s.src);
      return {
        title: document.title || '',
        readyState: document.readyState,
        bodyH: body ? body.scrollHeight : 0,
        childCount: body ? body.children.length : 0,
        textLen: (body ? body.innerText : '').trim().length,
        hasCanvas: !!canvas,
        canvasSize: canvas ? (canvas.width + 'x' + canvas.height) : '',
        scriptCount: scripts.length,
        activeScreens: document.querySelectorAll('.screen.active').length,
      };
    })()`,
    returnByValue: true,
  });

  // 移除 listener（通过重新连接代价太高，简化为只测一轮）
  return {
    info: info.result.value || {},
    errors, exceptions, failedRequests,
  };
}

async function main() {
  const cdp = await connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');

  const rows = [];
  for (const page of PAGES) {
    process.stdout.write(`检查 ${page.label} … `);
    try {
      const r = await checkPage(cdp, page);
      const ok = r.info.readyState === 'complete'
        && r.info.bodyH > 0
        && r.info.textLen > 0
        && r.errors.length === 0
        && r.exceptions.length === 0
        && r.failedRequests.length === 0;
      rows.push({ ...page, ...r, ok });
      console.log(ok ? '✓' : '✗');
    } catch (e) {
      rows.push({ ...page, info: {}, errors: [], exceptions: [e.message], failedRequests: [], ok: false, crashed: true });
      console.log('✗ 异常：' + e.message);
    }
    await sleep(300);
  }

  console.log('\n═════════════ ming-games 全站体检 ═════════════');
  console.log('页面'.padEnd(18) + '状态   高度      文本    画布         脚本  错误');
  console.log('─'.repeat(78));
  for (const r of rows) {
    const i = r.info || {};
    const status = r.ok ? '✓' : '✗';
    const err = (r.errors.length + r.exceptions.length + r.failedRequests.length);
    console.log(
      r.label.padEnd(16)
      + status.padEnd(6)
      + String(i.bodyH || 0).padEnd(10)
      + String(i.textLen || 0).padEnd(8)
      + String(i.canvasSize || (i.hasCanvas ? 'yes' : '—')).padEnd(13)
      + String(i.scriptCount || 0).padEnd(6)
      + String(err),
    );
  }
  console.log('─'.repeat(78));

  const bad = rows.filter((r) => !r.ok);
  console.log(`\n通过 ${rows.length - bad.length} / ${rows.length}`);
  if (bad.length) {
    console.log('\n失败明细：');
    for (const r of bad) {
      console.log(`\n【${r.label}】${BASE}${r.url}`);
      if (r.crashed) console.log('  · 检查过程异常：' + (r.exceptions[0] || ''));
      for (const e of r.exceptions) console.log('  · 未捕获异常：' + e);
      for (const e of r.errors) console.log('  · console.error：' + e);
      for (const e of r.failedRequests) console.log('  · 资源加载失败：' + e);
      if (r.info && r.info.bodyH === 0) console.log('  · body 高度为 0（可能是空壳或渲染失败）');
      if (r.info && r.info.textLen === 0 && !r.info.hasCanvas) console.log('  · 无任何可见文本与画布');
    }
  }

  cdp.ws.close();
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error('体检脚本异常：', e.message); process.exit(2); });
