/**
 * Verify PWA readiness on a page:
 *  - manifest.json loads and parses
 *  - manifest link is present and resolves
 *  - service worker registers and becomes active
 *  - icons referenced by the manifest exist
 *
 * Usage: node tools/verify-pwa.mjs <path> [cdpPort]
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
await sleep(4000);

const expr = `(async () => {
  const out = {};
  // 1. manifest link resolves
  const link = document.querySelector('link[rel="manifest"]');
  out.manifestLink = link ? link.href : null;
  // 2. manifest parses
  if (link) {
    try {
      const resp = await fetch(link.href);
      out.manifestStatus = resp.status;
      out.manifest = await resp.json();
    } catch (e) { out.manifestError = e.message; }
  }
  // 3. service worker state
  try {
    const reg = await navigator.serviceWorker.ready;
    out.swScope = reg.scope;
    out.swActive = !!(reg.active && reg.active.state === 'activated');
    out.swScript = reg.active ? reg.active.scriptURL : null;
  } catch (e) { out.swError = e.message; }
  // 4. controller ready
  out.controller = !!navigator.serviceWorker.controller;
  // 5. icons exist
  if (out.manifest && out.manifest.icons) {
    out.icons = [];
    for (const ic of out.manifest.icons) {
      try {
        const r = await fetch(new URL(ic.src, out.manifestLink));
        out.icons.push({ src: ic.src, status: r.status, sizes: ic.sizes });
      } catch (e) {
        out.icons.push({ src: ic.src, error: e.message });
      }
    }
  }
  return out;
})()`;

const r = await cdp.send('Runtime.evaluate', {
  expression: `(async () => {
    const out = {};
    const link = document.querySelector('link[rel="manifest"]');
    out.manifestLink = link ? link.href : null;
    if (link) {
      try {
        const resp = await fetch(link.href);
        out.manifestStatus = resp.status;
        out.manifest = await resp.json();
      } catch (e) { out.manifestError = e.message; }
    }
    try {
      const reg = await navigator.serviceWorker.ready;
      out.swScope = reg.scope;
      out.swActive = !!(reg.active && reg.active.state === 'activated');
    } catch (e) { out.swError = e.message; }
    out.controller = !!navigator.serviceWorker.controller;
    if (out.manifest && out.manifest.icons) {
      out.icons = [];
      for (const ic of out.manifest.icons) {
        try {
          const r = await fetch(new URL(ic.src, out.manifestLink));
          out.icons.push({ src: ic.src, status: r.status });
        } catch (e) {
          out.icons.push({ src: ic.src, error: e.message });
        }
      }
    }
    return out;
  })()`,
  awaitPromise: true,
  returnByValue: true,
});

console.log(JSON.stringify(r.result.value, null, 2));
cdp.ws.close();
