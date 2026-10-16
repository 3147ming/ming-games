/**
 * 真机探针：无头 Edge + CDP，验证「每日 / 成就 / 天赋 / 剧情」四个新屏能真正渲染。
 *
 * 为什么需要它：esbuild 打包通过只说明"能解析"，不代表运行时不炸。
 * 这四个屏走的是 createUI 内部的 handlers 闭包 + data-action 路由，
 * 任何一处接线漏了（方法没导出 / handler 没注册）都只在点击时才暴露。
 *
 *   node tools/probe-progress.mjs [--url http://127.0.0.1:5199/index.html]
 *
 * 断言失败或有未捕获异常时以非 0 退出码结束。
 */
import { spawn } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const url = flag('url', 'http://127.0.0.1:5199/index.html');
const waitMs = Number(flag('wait', 6000));
const port = Number(flag('port', 9300 + Math.floor(Math.random() * 400)));
const outDir = resolve(flag('out', '.workbuddy/shots'));

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('找不到 Edge / Chrome'); process.exit(2); }
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profileDir = join(tmpdir(), 'cdp-prog-' + port + '-' + Date.now());

const child = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions',
  '--remote-debugging-port=' + port,
  '--user-data-dir=' + profileDir,
  'about:blank',
], { stdio: 'ignore' });

async function waitForTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const page = (await r.json()).find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('无法连接 CDP（端口 ' + port + '）');
}

const ws = new WebSocket(await waitForTarget());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
const exceptions = [];
const logs = [];

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); return; }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ');
    if (msg.params.type !== 'log' && msg.params.type !== 'debug') logs.push(`[console.${msg.params.type}] ${text}`);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    const frames = (d.stackTrace?.callFrames ?? []).slice(0, 8)
      .map((f) => `      at ${f.functionName || '<anon>'} (${f.url || '?'}:${f.lineNumber + 1})`)
      .join('\n');
    exceptions.push(`[UNCAUGHT] ${d.exception?.description ?? d.text}\n${frames}`);
  } else if (msg.method === 'Log.entryAdded') {
    const e = msg.params.entry;
    if (e.level === 'error' && !/favicon/.test(e.text)) logs.push(`[log.error] ${e.text}`);
  }
};

const send = (method, params = {}) => new Promise((res) => {
  const id = ++msgId;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) return `ERR: ${r.exceptionDetails.text}`;
  return r?.result?.value;
};
const shot = async (name) => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  if (!s?.data) return;
  writeFileSync(join(outDir, name), Buffer.from(s.data, 'base64'));
};
const clickText = async (text) => {
  const r = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes(${JSON.stringify(text)}));
    if (!b) return 'NOT-FOUND';
    b.click();
    return 'ok';
  })()`);
  return r;
};

/** 当前可见屏 + 关键节点计数 */
const probeExpr = `JSON.stringify((() => {
  const vis = [...document.querySelectorAll('[data-screen]')]
    .filter((n) => !n.classList.contains('hidden'))
    .map((n) => n.dataset.screen);
  return {
    visible: vis,
    dailyTasks: document.querySelectorAll('.daily-task').length,
    achItems: document.querySelectorAll('.ach-item').length,
    perkNodes: document.querySelectorAll('.perk-node').length,
    storyItems: document.querySelectorAll('.story-item').length,
    booted: !!window.SOUDACHE,
    title: document.title,
  };
})())`;

const read = async () => {
  const raw = await evaluate(probeExpr);
  if (typeof raw !== 'string' || raw[0] !== '{') return { raw };
  return JSON.parse(raw);
};

const checks = [];
const expect = (name, cond, extra = '') => {
  checks.push({ name, ok: !!cond, extra });
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
};

let exitCode = 0;
try {
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  await send('Page.navigate', { url });
  await sleep(waitMs);
  let booted = false;
  for (let i = 0; i < 40; i += 1) {
    const s = await read();
    if (s.booted) { booted = true; break; }
    await sleep(1000);
  }
  expect('页面启动（window.SOUDACHE 已挂载）', booted);
  await shot('10-menu.png');

  const pages = [
    { btn: '每日', screen: 'daily', key: 'dailyTasks', min: 3, shot: '11-daily.png' },
    { btn: '成就', screen: 'ach', key: 'achItems', min: 13, shot: '12-ach.png' },
    { btn: '天赋', screen: 'tree', key: 'perkNodes', min: 9, shot: '13-tree.png' },
    { btn: '剧情', screen: 'story', key: 'storyItems', min: 5, shot: '14-story.png' },
  ];
  for (const p of pages) {
    const clicked = await clickText(p.btn);
    await sleep(900);
    const s = await read();
    expect(`点击「${p.btn}」按钮存在`, clicked === 'ok', String(clicked));
    expect(`进入 ${p.screen} 屏`, s.visible && s.visible.includes(p.screen), JSON.stringify(s.visible));
    expect(`${p.screen} 渲染出内容`, (s[p.key] || 0) >= p.min, `${p.key}=${s[p.key]}`);
    await shot(p.shot);
    await clickText('返回'); // 回菜单，保证下一步按钮在同一层
    await sleep(500);
  }

  console.log('\n=== CONSOLE / EXCEPTIONS ===');
  console.log([...exceptions, ...logs].join('\n') || '(无异常)');
  expect('无未捕获异常', exceptions.length === 0, `${exceptions.length} 条`);

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n=== 探针结果：${checks.length - failed.length}/${checks.length} 通过 ===`);
  if (failed.length || exceptions.length) exitCode = 1;
} catch (err) {
  console.error('探针出错：', err?.message ?? err);
  exitCode = 2;
} finally {
  try { await send('Browser.close'); } catch { /* 忽略 */ }
  try { ws.close(); } catch { /* 忽略 */ }
  child.kill();
}

console.log(`---- exit=${exitCode} ----`);
process.exit(exitCode);
