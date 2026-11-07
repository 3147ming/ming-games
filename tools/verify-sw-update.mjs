/**
 * Verify network-first navigation via CDP Network domain (ground truth:
 * the response body the navigation actually received).
 *
 * 1. Visit the page (SW installs / updates)
 * 2. Prepend a marker to the served HTML (simulating a deploy)
 * 3. Navigate again
 * 4. Capture the navigation response body via Network.getResponseBody
 * 5. Check for the marker
 * 6. Restore the file
 *
 * Usage: node tools/verify-sw-update.mjs <path> [cdpPort]
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
    } else {
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

const cdp = await connect();
await cdp.send('Page.enable');
await cdp.send('Network.enable');
await cdp.send('Runtime.enable');

// Track the requestId of the navigation request
let navRequestId = null;
cdp.on((m) => {
  if (m.method === 'Network.requestWillBeSent' &&
      m.params.type === 'Document' &&
      m.params.request.url.includes(path.replace(/\/$/, ''))) {
    navRequestId = m.params.requestId;
  }
});

const url = BASE + path;
const MARK = 'SW-UPDATE-MARK-' + Date.now();

// 1. first visit: prime the SW / cache
await cdp.send('Page.navigate', { url });
await sleep(3500);

// 2. simulate a deploy: prepend the marker to the served HTML
const fs = await import('node:fs');
const target = 'D:/Projects/_github_pages/ming-games/' + path.replace(/\/$/, '') + '/index.html';
const original = fs.readFileSync(target, 'utf8');
fs.writeFileSync(target, '<!-- ' + MARK + ' -->\n' + original, 'utf8');

try {
  // 3. navigate again (through the SW)
  await cdp.send('Page.navigate', { url });
  await sleep(3500);

  // 4. capture the navigation response body (ground truth)
  if (!navRequestId) {
    console.log('SKIP: could not capture the navigation requestId');
    process.exitCode = 2;
  } else {
    const resp = await cdp.send('Network.getResponseBody', { requestId: navRequestId });
    const body = (resp && (resp.result || resp).body) || '';
    const gotNew = body.includes(MARK);
    console.log(gotNew
      ? 'PASS: navigation is network-first — updated HTML served after deploy'
      : 'FAIL: stale cached HTML served');
    process.exitCode = gotNew ? 0 : 1;
  }
} finally {
  fs.writeFileSync(target, original, 'utf8');
}
cdp.ws.close();
