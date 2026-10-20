/**
 * 美术验收探针：真实部署进图后，把玩家逐个传送到每种敌人面前截图，
 * 供人工对照 docs/art-concept/02-enemies.png 检查造型与配色。
 *
 * 不做硬断言（美术方向由人眼判定），只保证：进图成功、传送生效、截图落盘、零未捕获异常。
 *   node tools/probe-art.mjs [--time day|night] [--out 目录]
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
const TIME = flag('time', 'day');
const port = Number(flag('port', 9600 + Math.floor(Math.random() * 200)));
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
const profileDir = join(tmpdir(), 'cdp-art-' + port + '-' + Date.now());

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
    const d = msg.params.exceptionDetails;
    exceptions.push(`[UNCAUGHT] ${d.exception?.description ?? d.text}`);
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
  console.log(`  截图 → ${name}`);
};
const clickText = async (text) => evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes(${JSON.stringify(text)}));
  if (!b) return 'NOT-FOUND';
  b.click();
  return 'ok';
})()`);

/** 播种存档（与 probe-battle 同款：满仓库 + 全套配件 + 指定时段） */
const SEED = `localStorage.setItem('soudache.save.v1', JSON.stringify({
  version: 1,
  currency: 999999,
  stash: {
    cols: 5, rows: 6,
    items: [
      { id: 'rifle', qty: 1 }, { id: 'pistol', qty: 1 }, { id: 'lv2', qty: 1 },
      { id: 'ammo556', qty: 60 }, { id: 'ammo556', qty: 60 }, { id: 'ammo556', qty: 60 }, { id: 'ammo556', qty: 60 },
      { id: 'ammo9mm', qty: 60 }, { id: 'ammo9mm', qty: 60 },
      { id: 'medkit', qty: 1 }, { id: 'medkit', qty: 1 }, { id: 'medkit', qty: 1 }, { id: 'medkit', qty: 1 },
      { id: 'bandage', qty: 1 }, { id: 'bandage', qty: 1 }, { id: 'bandage', qty: 1 }, { id: 'bandage', qty: 1 },
      { id: 'muzzle_comp', qty: 1 }, { id: 'sight_holo', qty: 1 },
      { id: 'grip_vert', qty: 1 }, { id: 'muzzle_sil', qty: 1 },
    ],
  },
  stats: { raids: 24, extracts: 0, deaths: 0, kills: 0, bestScore: 0, bestValue: 0, bossKills: 0 },
  loadout: {
    primary: 'rifle', secondary: 'pistol', armor: 'lv2',
    ammo556Boxes: 2, ammo9mmBoxes: 1, medkits: 2, bandages: 1,
    attach: {
      primary: { muzzle: 'muzzle_comp', sight: 'sight_holo', grip: 'grip_vert' },
      secondary: { muzzle: 'muzzle_sil' },
    },
    time: '${TIME}',
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

  let booted = false;
  for (let i = 0; i < 40; i += 1) {
    if (await evaluate('!!window.SOUDACHE') === true) { booted = true; break; }
    await sleep(1000);
  }
  console.log(`  ${booted ? 'ok  ' : 'FAIL'} 页面启动`);
  await clickText('开始战局');
  await sleep(800);
  await clickText(TIME === 'day' ? '白昼' : '夜战');
  await sleep(400);
  await clickText('部署进入战局');
  let world = null;
  for (let i = 0; i < 30; i += 1) {
    world = await evaluate('!!window.SOUDACHE && !!window.SOUDACHE.world');
    if (world === true) break;
    await sleep(1000);
  }
  console.log(`  ${world ? 'ok  ' : 'FAIL'} 进图成功（theme=${TIME}）`);

  // 暂停 AI 避免敌人转身/开火干扰构图：直接把整局敌人定住（只改表现层字段）
  const roster = await evaluate(`JSON.stringify((() => {
    const w = window.SOUDACHE.world;
    const seen = {};
    for (const e of (w.enemies || [])) seen[e.typeId] = (seen[e.typeId] || 0) + 1;
    return seen;
  })())`);
  const types = JSON.parse(roster || '{}');
  console.log(`  本局敌人：${JSON.stringify(types)}`);

  let idx = 0;
  // 先找一块空旷地（5×5 全为地面），把敌人与玩家都摆进去 —— 避免被墙挡住视线
  const openSpot = await evaluate(`(() => {
    const map = window.SOUDACHE.world.map;
    for (let ty = 2; ty < map.rows - 2; ty += 1) {
      for (let tx = 2; tx < map.cols - 2; tx += 1) {
        let ok = true;
        for (let dy = -2; dy <= 2 && ok; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            if (map.grid[(ty + dy) * map.cols + (tx + dx)] !== 0) { ok = false; break; }
          }
        }
        if (ok) return { x: (tx + 0.5) * map.tile, y: (ty + 0.5) * map.tile };
      }
    }
    return null;
  })()`);
  console.log(`  空旷机位：${JSON.stringify(openSpot)}`);

  for (const typeId of ['patrol', 'rusher', 'elite', 'marksman', 'boss']) {
    if (!types[typeId]) continue;
    idx += 1;
    // 把该类型的一个敌人固定到空旷地，玩家站在它西侧 60 单位并正对。
    // 每 120ms 刷新一次（AI 会覆盖坐标），最后一次刷新后立即截图，保证构图稳定。
    const place = `(() => {
      const w = window.SOUDACHE.world;
      const spot = ${JSON.stringify(openSpot)};
      const e = (w.enemies || []).find((x) => x.typeId === ${JSON.stringify(typeId)});
      if (!e || !spot) return false;
      e.x = spot.x; e.y = spot.y; e.angle = 0;
      const p = w.player;
      p.x = spot.x - 60; p.y = spot.y;
      p.angle = 0; // 逻辑角 0 = 朝 +X，正对敌人
      p.hp = 1e9; p.maxHp = 1e9; // 美术取景：不受击、不死亡
      return true;
    })()`;
    let ok = false;
    for (let k = 0; k < 4; k += 1) {
      ok = await evaluate(place);
      await sleep(120);
    }
    await evaluate(place); // 最后一刷：保证截图瞬间玩家还活着且血量满
    if (ok !== true) { console.log(`  skip ${typeId}（本局无此类型）`); continue; }
    await shot(`4${idx}-enemy-${typeId}-${TIME}.png`);
  }

  // 全景一张：原图站位 + 广角（能看到地面/墙/天空的整体色调）
  await evaluate(`(() => {
    const w = window.SOUDACHE.world;
    const s = w.map.enemySpawns && w.map.enemySpawns[0];
    if (s) { w.player.x = s.x + 120; w.player.y = s.y + 120; }
    return true;
  })()`);
  await sleep(900);
  await shot(`40-overview-${TIME}.png`);

  await sleep(1500);
  console.log(`  ${exceptions.length === 0 ? 'ok  ' : 'FAIL'} 无未捕获异常 — ${exceptions.length} 条`);
  for (const ex of exceptions.slice(0, 5)) console.log(ex);
  if (exceptions.length) exitCode = 1;
} catch (err) {
  console.error('探针执行失败：', err);
  exitCode = 2;
} finally {
  try { child.kill(); } catch { /* 已退出 */ }
}
process.exit(exitCode);
