/**
 * Inspect the Service Worker caches: list cache names and check whether the
 * cached HTML for a game still contains the old (broken) markup.
 *
 * Usage: node tools/probe-sw-cache.mjs [cdpPort]
 */
const PORT = Number(process.env.CDP_PORT || 0);
const BASE = process.env.SITE_BASE || 'http://localhost:5188/';

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
await cdp.send('Page.navigate', { url: BASE + 'neon-rhythm/' });
await new Promise((r) => setTimeout(r, 3000));

const expr = `(async () => {
  const out = { caches: [], stale: [] };
  const names = await caches.keys();
  out.caches = names;
  for (const n of names) {
    const c = await caches.open(n);
    const keys = await c.keys();
    for (const k of keys) {
      const url = k.url;
      if (!/index\\.html|\\/$/.test(url)) continue;
      const resp = await c.match(k);
      if (!resp) continue;
      const txt = await resp.clone().text();
      // does the cached copy still have the unclosed <input ... aria-label=...>
      // without a closing bracket?
      const broken = /<input[^<>]*aria-label="[^"]*"\\s*(?=<b|<span|<div)/.test(txt);
      const fixed  = /<input[^<>]*aria-label="[^"]*"\\s*\\/>/.test(txt);
      out.stale.push({ cache: n, url, len: txt.length, broken, fixed });
    }
  }
  return out;
})()`;

const r = await cdp.send('Runtime.evaluate', {
  expression: expr, awaitPromise: true, returnByValue: true,
});
console.log(JSON.stringify(r.result.value, null, 2));
cdp.ws.close();
