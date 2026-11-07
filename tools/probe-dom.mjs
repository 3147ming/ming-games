/**
 * Probe the live DOM for specific element ids.
 * Usage: node tools/probe-dom.mjs <path> <id1,id2,...> [cdpPort]
 */
const PORT = Number(process.env.CDP_PORT || 0);
const BASE = process.env.SITE_BASE || 'http://localhost:5188/';
const path = process.argv[2] || '';
const ids = (process.argv[3] || '').split(',').filter(Boolean);

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
  await cdp.send('Page.navigate', { url: BASE + path });
  await sleep(4000);

  const expr = `(() => {
    const ids = ${JSON.stringify(ids)};
    const out = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      out[id] = el ? {
        found: true,
        tag: el.tagName,
        text: (el.textContent || '').slice(0, 60),
        value: el.value,
        parentTag: el.parentElement ? el.parentElement.tagName : null,
      } : { found: false };
    }
    // Also dump every element id that starts with the prefix of the first id
    if (ids.length) {
      const p = ids[0].split('-')[0];
      out.__allWithPrefix = [...document.querySelectorAll('[id]')]
        .map(e => e.id)
        .filter(id => id.toLowerCase().includes(p.toLowerCase()));
    }
    return out;
  })()`;

  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log(BASE + path);
  console.log(JSON.stringify(r.result.value, null, 2));
  cdp.ws.close();
}

main().catch((e) => { console.error('probe failed:', e.message); process.exit(2); });
