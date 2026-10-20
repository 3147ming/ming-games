/**
 * 图标接入验收：位图物品图标（assets/icons/）在五处渲染点是否都生效、且无裂图。
 *
 * 为什么需要它：图标是 <img>，路径写错 / key 与 def.id 对不上 / 部署漏文件，
 * 在浏览器里都只表现为"一个破图标"或"静默不显示" —— 单测与逻辑探针全都发现不了。
 * 这里走真实 UI：菜单 → 仓库 → 商店 → 战前配置 → 部署 → 背包 → 战利品 → 结算，
 * 每处断言"有位图图标"且"图标真的加载成功（naturalWidth > 0）"。
 *
 *   node tools/probe-icons.mjs [--url ...] [--port N]
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
const port = Number(flag('port', 9800 + Math.floor(Math.random() * 150)));
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
const profileDir = join(tmpdir(), 'cdp-icons-' + port + '-' + Date.now());
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
  throw new Error('无法连接 CDP');
}

const ws = new WebSocket(await waitForTarget());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0;
const pending = new Map();
const exceptions = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); return; }
  if (msg.method === 'Runtime.exceptionThrown') {
    exceptions.push(`[UNCAUGHT] ${msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text}`);
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
  if (s?.data) writeFileSync(join(outDir, name), Buffer.from(s.data, 'base64'));
};
const click = async (text) => evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes(${JSON.stringify(text)}));
  if (!b) return 'NOT-FOUND';
  b.click();
  return 'ok';
})()`);

/**
 * 扫描当前屏的物品行图标状况。
 * 返回 { rows, withPng, loaded, broken, missing, vector, byId }：
 *   rows     物品行（.item-row / .grid-item / .opt 按钮）总数
 *   withPng  其中带位图图标的行数
 *   loaded   其中 naturalWidth > 0（真的加载出来了）
 *   broken   加载失败（naturalWidth === 0）—— 必须是 0，否则就是裂图
 *   missing  映射表里有、但这行没渲染出 <img> —— 接线漏了
 *   vector   回退到矢量图标的行数（正常：其余配件/收藏品没有位图）
 */
const SCAN = `(() => {
  // 只扫"当前可见的屏 / 战斗面板" —— 否则隐藏屏里的行也会被算进来，
  // 断言就会退化成"整页至少有一个图标"，失去逐屏验收的意义。
  // 注意优先级：局内打开背包/战利品面板时，面板才是真正要看的东西（它在 battle 屏之内）。
  const want = ${JSON.stringify('__SCOPE__')};
  const scope = (want && document.querySelector(want))
    || document.querySelector('.battle-panel:not(.hidden)')
    || document.querySelector('[data-screen]:not(.hidden)')
    || document;
  const out = { scope: scope.id || scope.className || scope.tagName, rows: 0, withPng: 0, loaded: 0, broken: 0, vector: 0, srcs: [], names: [] };
  const nodes = [...scope.querySelectorAll('.item-row, .grid-item, .codex-item, .opt')];
  for (const n of nodes) {
    // 只统计"代表一件物品"的节点：排除纯文字的成就/剧情条目
    const img = n.querySelector('img.item-ic');
    const hasName = !!n.querySelector('.item-name, .gi-name, .ci-name') || n.classList.contains('opt');
    if (!img && !hasName) continue;
    out.rows += 1;
    const nm = n.querySelector('.item-name, .gi-name, .ci-name');
    if (nm && out.names.length < 12) out.names.push(nm.textContent.trim().slice(0, 10));
    if (img) {
      out.withPng += 1;
      const src = img.getAttribute('src') || '';
      if (out.srcs.indexOf(src) < 0) out.srcs.push(src);
      if (img.complete && img.naturalWidth > 0) out.loaded += 1;
      else out.broken += 1;
    } else {
      out.vector += 1;
    }
  }
  return JSON.stringify(out);
})()`;

/** 12 张位图对应的文件名（映射表覆盖的全部图标） */
const ALL_ICONS = ['m4a1', 'mp5', 'g17', 'medkit', 'bandage', 'ammo556', 'ammo9mm', 'vest2', 'vest3', 'muzzle_sil', 'sight_scope', 'grip_vert'];

const checks = [];
const expect = (name, cond, extra = '') => {
  checks.push({ name, ok: !!cond });
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
};
const scan = async (selector = '') => {
  // 注意替换的是**带引号的整体**："__SCOPE__" → "[data-screen=\"stash\"]"，
  // 只替换裸标识符会把外层引号吃掉，拼出 want = "[data-screen="stash"]" 这种语法错误。
  const raw = await evaluate(SCAN.replace('"__SCOPE__"', JSON.stringify(selector)));
  return typeof raw === 'string' && raw[0] === '{' ? JSON.parse(raw) : { scope: '?', rows: 0, withPng: 0, loaded: 0, broken: 0, vector: 0, srcs: [] };
};
/** 本屏出现过的位图文件名集合 */
const seenIcons = (s) => new Set(s.srcs.map((p) => (p.split('/').pop() || '').replace('.png', '')));

/** 播种：仓库塞满 12 张位图对应的物品 + 若干无图标的配件/收藏品 */
const SEED = `localStorage.setItem('soudache.save.v1', JSON.stringify({
  version: 1,
  currency: 9999999,
  stash: {
    cols: 6, rows: 8,
    items: [
      { id: 'rifle', qty: 1 }, { id: 'smg', qty: 1 }, { id: 'pistol', qty: 1 },
      { id: 'lv2', qty: 1 }, { id: 'lv3', qty: 1 },
      { id: 'medkit', qty: 1 }, { id: 'medkit', qty: 1 },
      { id: 'bandage', qty: 1 }, { id: 'bandage', qty: 1 },
      { id: 'ammo556', qty: 60 }, { id: 'ammo556', qty: 60 },
      { id: 'ammo9mm', qty: 60 },
      { id: 'muzzle_sil', qty: 1 }, { id: 'sight_scope', qty: 1 }, { id: 'grip_vert', qty: 1 },
      { id: 'muzzle_comp', qty: 1 }, { id: 'sight_holo', qty: 1 }, { id: 'grip_angle', qty: 1 },
      { id: 'chip', qty: 1 }, { id: 'optic', qty: 1 }, { id: 'gold', qty: 1 },
      { id: 'doc', qty: 1 }, { id: 'bolt', qty: 1 },
    ],
  },
  stats: { raids: 30, extracts: 12, deaths: 2, kills: 40, bestScore: 5000, bestValue: 90000, bossKills: 1 },
  codex: { enemies: ['patrol'], items: ['rifle', 'medkit', 'chip'] },
  loadout: {
    primary: 'rifle', secondary: 'pistol', armor: 'lv2',
    ammo556Boxes: 2, ammo9mmBoxes: 1, medkits: 1, bandages: 1,
    attach: { primary: { muzzle: 'muzzle_sil', sight: 'sight_scope', grip: 'grip_vert' }, secondary: {} },
    time: 'day',
  },
  settings: { tutorialDone: true },
}))`;

let exitCode = 0;
try {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: SEED });
  await send('Page.navigate', { url });

  // 直连线上时 900KB bundle 的冷加载可能很慢（surge 边缘节点 + 弱网），
  // 40s 偶发不够 —— 这里给到 75s，避免把"网络慢"误判成"功能坏"。
  let booted = false;
  for (let i = 0; i < 75; i++) {
    if (await evaluate('!!window.SOUDACHE') === true) { booted = true; break; }
    await sleep(1000);
  }
  expect('页面启动', booted);
  await sleep(1200); // 等图标首批加载完成

  /* ---------- 1. 仓库 ---------- */
  await click('仓库');
  await sleep(700);
  let s = await scan('[data-screen="stash"]');
  expect('仓库：物品行有位图图标', s.withPng >= 10, `rows=${s.rows} png=${s.withPng} 矢量=${s.vector}`);
  expect('仓库：位图全部加载成功（无裂图）', s.broken === 0 && s.loaded === s.withPng, `loaded=${s.loaded}/${s.withPng} broken=${s.broken}`);
  // 精确覆盖：种子里 12 件有图标的物品都应出现对应位图（不靠名称猜测，按 src 判定）
  const stashIcons = seenIcons(s);
  const notShown = ALL_ICONS.filter((n) => !stashIcons.has(n));
  expect('仓库：12 张位图全部出现（无漏接）', notShown.length === 0, notShown.length ? '缺 ' + notShown.join(',') : `已出现 ${stashIcons.size} 张`);
  await shot('60-stash-icons.png');

  /* ---------- 2. 商店 ---------- */
  await click('返回');
  await sleep(400);
  await click('商店');
  await sleep(900);
  s = await scan('[data-screen="shop"]');
  expect('商店：位图图标已接入', s.withPng >= 20, `rows=${s.rows} png=${s.withPng} 矢量=${s.vector}（购买列表 16 项 + 出售列表）`);
  expect('商店：无裂图', s.broken === 0 && s.loaded === s.withPng, `loaded=${s.loaded}/${s.withPng}`);
  await shot('61-shop-icons.png');

  /* ---------- 3. 战前配置（武器 / 护甲 / 配件按钮也是物品 id） ---------- */
  await click('返回');
  await sleep(400);
  await click('开始战局');
  await sleep(700);
  s = await scan('[data-screen="loadout"]');
  expect('战前配置：武器/护甲/配件按钮用位图图标', s.withPng >= 5, `png=${s.withPng}（M4A1 / MP5 / G17 / 二级甲 / 三级甲 / 消音器 / 瞄准镜 / 垂直握把）`);
  expect('战前配置：无裂图', s.broken === 0 && s.loaded === s.withPng, `loaded=${s.loaded}/${s.withPng}`);

  /* ---------- 4. 部署 → 背包 Tab ---------- */
  await click('部署进入战局');
  let world = null;
  for (let i = 0; i < 30; i++) {
    world = await evaluate('!!window.SOUDACHE && !!window.SOUDACHE.world');
    if (world === true) break;
    await sleep(1000);
  }
  expect('进图成功', world === true);
  await sleep(1500);
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Tab', key: 'Tab', bubbles: true }))`);
  await sleep(700);
  s = await scan('[data-role="backpack"]');
  // 背包件数随部署与容量浮动（放不下的会被 autoPlace 静默丢弃），所以断言的是
  // "背包里每一件都带图标"，而不是某个固定件数。
  expect('背包 Tab：每件物品都有图标', s.rows > 0 && s.withPng + s.vector === s.rows,
    `屏=${s.scope} rows=${s.rows} png=${s.withPng} 矢量=${s.vector} — ${s.names.join(' / ')}`);
  expect('背包 Tab：带图标的都用位图（本部署 8 件全部有位图）', s.withPng === s.rows && s.rows >= 5,
    `png=${s.withPng}/${s.rows}`);
  expect('背包 Tab：无裂图', s.broken === 0 && s.loaded === s.withPng, `loaded=${s.loaded}/${s.withPng}`);
  await shot('62-backpack-icons.png');

  /* ---------- 5. 战利品拾取面板 ---------- */
  // 注意：未搜过的容器按 E 只是启动搜刮读条，只有 searched 且仍有战利品才开面板，
  // 所以这里直接把它置为"已搜过"，把探针的关注点限定在"图标渲染"上。
  const opened = await evaluate(`(() => {
    const w = window.SOUDACHE.world;
    const cs = (w.map && w.map.containers) || [];
    const c = cs.find((x) => (x.loot || []).length) || cs[0];
    if (!c) return 'NO-CONTAINERS';
    c.searched = true;
    const p = w.player;
    p.x = c.x + 30; p.y = c.y;
    p.angle = Math.PI;
    p.hp = 1e9; p.maxHp = 1e9;
    return 'loot=' + (c.loot || []).length;
  })()`);
  expect('传送到容器旁并标记已搜过', String(opened).startsWith('loot=') && Number(String(opened).slice(5)) > 0, String(opened));
  await sleep(400);
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', key: 'e', bubbles: true }))`);
  await sleep(400);
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyE', key: 'e', bubbles: true }))`);
  await sleep(800);
  const lootOpen = await evaluate(`(() => {
    const n = document.querySelector('[data-role="loot"]');
    return !!n && !n.classList.contains('hidden');
  })()`);
  expect('战利品面板已打开', lootOpen === true);
  if (lootOpen === true) {
    s = await scan('[data-role="loot"]');
    // 掉落是随机的：这局可能全是无位图物品（栓钉/零件/芯片…），
    // 所以断言的是"每一行都有图标（位图或矢量回退）"，而不是"至少一张位图"。
    expect('战利品面板：每件物品都有图标', s.rows > 0 && s.withPng + s.vector === s.rows,
      `rows=${s.rows} png=${s.withPng} 矢量=${s.vector} — ${s.names.join(' / ')}`);
    expect('战利品面板：无裂图', s.broken === 0 && s.loaded === s.withPng, `loaded=${s.loaded}/${s.withPng}`);
    await shot('63-loot-icons.png');
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', key: 'e', bubbles: true }))`);
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyE', key: 'e', bubbles: true }))`);
    await sleep(300);
  }

  /* ---------- 6. 结算页（损失 / 带出清单） ---------- */
  await evaluate('window.SOUDACHE.endRaid("dead")');
  await sleep(1500);
  s = await scan('[data-screen="result"]');
  expect('结算页：清单行用位图图标', s.withPng >= 3, `rows=${s.rows} png=${s.withPng} 矢量=${s.vector}`);
  expect('结算页：无裂图', s.broken === 0 && s.loaded === s.withPng, `loaded=${s.loaded}/${s.withPng}`);
  await shot('64-result-icons.png');

  /* ---------- 7. 全局：任何一个 <img> 都不许是破图 ---------- */
  const globalBroken = await evaluate(`(() => {
    const bad = [...document.querySelectorAll('img')].filter((i) => !(i.complete && i.naturalWidth > 0));
    return bad.map((i) => i.getAttribute('src')).join(',');
  })()`);
  expect('全局无裂图（含历史屏残留）', globalBroken === '', globalBroken);

  await sleep(300);
  expect('无未捕获异常', exceptions.length === 0, exceptions.slice(0, 3).join(' / '));

  const pass = checks.filter((c) => c.ok).length;
  console.log(`\n=== 探针结果：${pass}/${checks.length} 通过 ===`);
  if (pass !== checks.length) exitCode = 1;
} catch (err) {
  console.error('探针执行失败：', err);
  exitCode = 2;
} finally {
  try { child.kill(); } catch { /* 已退出 */ }
}
process.exit(exitCode);
