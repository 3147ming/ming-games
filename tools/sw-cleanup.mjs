/**
 * Unregister all service workers and clear all caches on the target page.
 * Usage: node tools/sw-cleanup.mjs <path> [cdpPort]
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
  ws.addEventListener('message', (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pend.has(m.id)) {
      const { resolve, reject } = pend.get(m.id);
      pend.delete(m.id);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
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
  };
}

const cdp = await connect();
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Page.navigate', { url: BASE + path });
await sleep(3000);

const r = await cdp.send('Runtime.evaluate', {
  expression: `(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const reg of regs) { await reg.unregister(); }
    const keys = await caches.keys();
    for (const k of keys) { await caches.delete(k); }
    return { unregistered: regs.length, cachesCleared: keys.length };
  })()`,
  awaitPromise: true,
  returnByValue: true,
});
console.log('cleanup:', JSON.stringify(r.result.value));
cdp.ws.close();
