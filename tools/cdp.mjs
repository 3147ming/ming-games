/**
 * 极简 CDP 探针脚手架（零依赖）
 * 提供：进程内静态服务器 / 无头 Edge 启动 / CDP 会话 / 截图 / 帧推进 / 控制台异常收集。
 */
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.fbx': 'application/octet-stream',
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 进程内静态服务器：探针退出即释放，不会被环境回收 */
export function startServer(root) {
  const ROOT = resolve(root);
  const server = createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    const file = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    let st;
    try { st = statSync(file); } catch { res.writeHead(404).end('404 ' + p); return; }
    if (st.isDirectory()) { res.writeHead(403).end(); return; }
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
    });
    createReadStream(file).pipe(res);
  });
  return new Promise((res) => {
    server.listen(0, '127.0.0.1', () => res({ server, port: server.address().port }));
  });
}

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

async function waitWs(port) {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  throw new Error('CDP 连接超时');
}

/**
 * 启动无头浏览器并返回会话
 * @param {{tag?:string, width?:number, height?:number, dpr?:number, mobile?:boolean}} opts
 */
export async function openSession(opts = {}) {
  const browser = BROWSERS.find((p) => existsSync(p));
  if (!browser) throw new Error('找不到 Edge/Chrome，可执行文件不在预期路径');

  const tag = opts.tag || 'probe';
  const profile = join(tmpdir(), `cdp-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`);
  const port = 9400 + Math.floor(Math.random() * 400);
  const child = spawn(browser, [
    '--headless=new',
    '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--no-proxy-server', '--proxy-bypass-list=*',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--autoplay-policy=no-user-gesture-required',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--mute-audio', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    `--window-size=${opts.width || 1280},${opts.height || 720}`,
    'about:blank',
  ], { stdio: 'ignore' });

  const ws = new WebSocket(await waitWs(port));
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let msgId = 0;
  const pending = new Map();
  const exceptions = [];
  const consoleErrors = [];
  const failedRequests = [];

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      exceptions.push(`[UNCAUGHT] ${d.exception?.description || d.text}`);
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      const txt = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      consoleErrors.push(`[console.error] ${txt}`);
    } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      consoleErrors.push(`[log] ${m.params.entry.text} @${m.params.entry.url || ''}`);
    } else if (m.method === 'Network.loadingFailed') {
      failedRequests.push(`${m.params.type} ${m.params.errorText}`);
    }
  };

  const send = (method, params = {}) => new Promise((res) => {
    const id = ++msgId;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (r?.exceptionDetails) {
      return `ERR: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`;
    }
    return r?.result?.value;
  };

  /** 泵 n 帧 rAF（无头下 rAF 会停，必须主动推） */
  const frame = (n = 1) => evaluate(
    `new Promise((res) => { let left = ${n}; const t = setTimeout(() => res('timeout'), 5000);
      const step = () => { if (--left > 0) { requestAnimationFrame(step); return; } clearTimeout(t); res('raf'); };
      requestAnimationFrame(step); })`
  );

  const waitFor = async (expr, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (String(await evaluate(expr)) === 'true') return true;
      await frame(1);
      await sleep(60);
    }
    return false;
  };

  const shotDir = resolve('.workbuddy/shots');
  mkdirSync(shotDir, { recursive: true });
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const file = join(shotDir, name);
    writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  };

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Network.enable');
  if (opts.width) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: opts.width, height: opts.height || 720,
      deviceScaleFactor: opts.dpr || 1, mobile: !!opts.mobile,
    });
  }

  return {
    send, evaluate, frame, waitFor, shot,
    exceptions, consoleErrors, failedRequests,
    close: () => { try { ws.close(); } catch { /* ignore */ } child.kill(); },
  };
}
