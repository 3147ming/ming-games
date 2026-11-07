/**
 * Probe uncaught exceptions on a single page with full detail.
 * Usage: node tools/probe-errors.mjs <path> [cdpPort]
 */
const PORT = Number(process.env.CDP_PORT || 0);
const BASE = process.env.SITE_BASE || 'http://localhost:5188/';
const path = process.argv[2] || '';

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
      setTimeout(() => { if (pend.has(i)) { pend.delete(i); reject(new Error('timeout ' + method)); } }, 30000);
    }),
    on: (fn) => listeners.push(fn),
  };
}

async function main() {
  const cdp = await connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  await cdp.send('Log.enable');

  const events = [];
  cdp.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      events.push({
        kind: 'exception',
        text: d.text,
        url: d.url,
        line: d.lineNumber,
        col: d.columnNumber,
        desc: d.exception && (d.exception.description || d.exception.value),
      });
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      const txt = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      if (m.params.type === 'error' || m.params.type === 'warning') {
        events.push({ kind: 'console.' + m.params.type, text: txt.slice(0, 300) });
      }
    }
    if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      if (e.level === 'error') events.push({ kind: 'log.error', text: (e.text || '').slice(0, 300), url: e.url });
    }
  });

  const url = BASE + path;
  await cdp.send('Page.navigate', { url });
  await sleep(5000);

  console.log('=== ' + url + ' ===');
  if (!events.length) console.log('(no errors)');
  for (const e of events) {
    console.log(JSON.stringify(e, null, 2));
  }

  const sw = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      return {
        swCount: regs.length,
        swScopes: regs.map(r => r.scope),
        controller: !!navigator.serviceWorker.controller,
        controllerUrl: navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : null,
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  }).catch((e) => ({ error: e.message }));
  console.log('\nSW state:', JSON.stringify(sw.result && sw.result.value || sw));

  cdp.ws.close();
}

main().catch((e) => { console.error('probe failed:', e.message); process.exit(2); });
