/**
 * 手感数值包 + 移动曲线 + 暂停残留 + 弹药口径 验收探针（无头 Edge + CDP）。
 *
 * 对应四块改动：
 *   块A  灵敏度 0.0035 / 辅助瞄准 0.25 / 后坐回中 5 / 降质阈值 55fps
 *   块B  moveSm 加速度曲线（起步加速、松键滑停）+ 体力将尽过渡（×0.7）
 *   块C1 暂停残留（阵亡→再来一局→配置页无"已暂停"遮罩）
 *   块C2 弹药盒口径（损失清单 ×N 盒 / 盒重 / 盒价，负重不再被撑爆）
 *
 * 为什么值得单独一个探针：块A/B 的验收全是"手感"，只能在真实浏览器里
 * 驱动输入采样 moveSm 曲线才能证伪；块C1 的根因是 HUD 画布最后一帧
 * 残留，必须读画布像素；块C2 要读结算页真实 DOM。
 *
 * 采样口径：无头软渲染帧间隔不稳（13ms~170ms 波动），墙钟采样会误判，
 * 因此块B 一律用**页内 rAF 采样器按帧记录**，断言跑在"游戏帧时"上
 * （与主循环同口径 dt≤0.05s），与机器快慢无关。
 *
 *   node tools/probe-feel.mjs [--url ...] [--time day|night]
 */
import { spawn } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMBAT, VIEW3D, PLAYER } from '../src/config.js';

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const url = flag('url', 'http://127.0.0.1:5199/index.html');
const TIME = flag('time', 'day');
const port = Number(flag('port', 9900 + Math.floor(Math.random() * 90)));
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
const profileDir = join(tmpdir(), 'cdp-feel-' + port + '-' + Date.now());

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
    exceptions.push(`[UNCAUGHT] ${d.exception?.description ?? d.text}`);
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
const key = (type, k) => evaluate(`window.dispatchEvent(new KeyboardEvent('${type}', { key: '${k}' }))`);

/** 播种存档：与 probe-battle 同构，2 盒 5.56 + 1 盒 9mm（验证 ×2 盒口径） */
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
    ],
  },
  stats: { raids: 3, extracts: 0, deaths: 0, kills: 0, bestScore: 0, bestValue: 0, bossKills: 0 },
  loadout: {
    primary: 'rifle', secondary: 'pistol', armor: 'lv2',
    ammo556Boxes: 2, ammo9mmBoxes: 1, medkits: 2, bandages: 1,
    time: '${TIME}',
  },
  settings: { tutorialDone: true },
}))`;

const checks = [];
const expect = (name, cond, extra = '') => {
  checks.push({ name, ok: !!cond, extra });
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
};

let exitCode = 0;
try {
  /* ==================== 块A：数值（Node 侧直读 config） ==================== */
  console.log('== 块A：手感数值 ==');
  expect('鼠标灵敏度 0.0022 → 0.0035', VIEW3D.sensitivity === 0.0035, String(VIEW3D.sensitivity));
  expect('辅助瞄准强度 0.45 → 0.25（仍默认开）',
    COMBAT.aimAssist.strength === 0.25 && COMBAT.aimAssist.enabled === true && COMBAT.aimAssist.coneDeg === 7,
    JSON.stringify(COMBAT.aimAssist));
  expect('后坐回中 9 → 5', COMBAT.recoilRecover === 5, String(COMBAT.recoilRecover));
  const sceneSrc = readFileSync(fileURLToPath(new URL('../src/scene3d.js', import.meta.url)), 'utf8');
  expect('降质阈值 45fps → 55fps（avg > 0.0182）',
    sceneSrc.includes('avg > 0.0182') && !sceneSrc.includes('0.0222'),
    sceneSrc.includes('avg > 0.0182') ? '阈值已改' : '阈值未改');
  expect('降级顺序保持（阴影 2048→1024→关→像素比）',
    sceneSrc.includes('shadowMapSizeFallback') && sceneSrc.includes('castShadow = false') && sceneSrc.includes('minPixelRatioFallback'));
  expect('体力将尽倍率 staminaLowMul = 0.7 已入 config', PLAYER.staminaLowMul === 0.7, String(PLAYER.staminaLowMul));

  /* ==================== 浏览器：部署进图 ==================== */
  console.log('== 部署进图 ==');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: SEED });

  await send('Page.navigate', { url });
  let booted = false;
  for (let i = 0; i < 40; i += 1) {
    if (await evaluate('!!window.SOUDACHE') === true) { booted = true; break; }
    await sleep(1000);
  }
  expect('页面启动（window.SOUDACHE 已挂载）', booted);

  expect('点击「开始战局」', await clickText('开始战局') === 'ok');
  await sleep(600);
  expect('点击「部署进入战局」', await clickText('部署进入战局') === 'ok');
  let world = null;
  for (let i = 0; i < 30; i += 1) {
    world = await evaluate('!!window.SOUDACHE.world');
    if (world === true) break;
    await sleep(1000);
  }
  expect('world 已创建（进图成功）', world === true);
  await sleep(1200); // 让主循环转起来（进图首帧有地图生成开销）

  /* ==================== 块B：加速度曲线（页内按帧采样） ==================== */
  console.log('== 块B：移动加速度曲线 ==');
  const BASE = 196; // PLAYER.speed（负重 14.5kg ≤ 23kg 上限，weightMul = 1）

  /** 装一个页内 rAF 采样器：按帧记录 moveSm 与游戏帧时（dt 口径同主循环）。
   *  代数令牌防止上一条还没跑完的采样链污染新序列。 */
  const installSampler = () => evaluate(`(() => {
    window.__smGen = (window.__smGen || 0) + 1;
    const gen = window.__smGen;
    const p = window.SOUDACHE.world.player;
    window.__sm = { ft: [], v: [] };
    let last = performance.now();
    (function tick() {
      if (window.__smGen !== gen) return; // 已被新采样器取代
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const prev = window.__sm.ft.length ? window.__sm.ft[window.__sm.ft.length - 1] : 0;
      window.__sm.ft.push(prev + dt);
      window.__sm.v.push(p.moveSm);
      if (window.__sm.ft[window.__sm.ft.length - 1] < 1.2) requestAnimationFrame(tick);
    })();
    return 'ok';
  })()`);
  const readSampler = async () => {
    const raw = await evaluate('JSON.stringify(window.__sm)');
    return typeof raw === 'string' && raw[0] === '{' ? JSON.parse(raw) : { ft: [], v: [] };
  };
  const monotonic = (arr, dir) => arr.every((x, i) => i === 0 || (dir > 0 ? x >= arr[i - 1] - 1e-6 : x <= arr[i - 1] + 1e-6));

  // ---- 起步：按 W，moveSm 应指数趋近全速而非一步到位 ----
  expect('采样器就绪', await installSampler() === 'ok');
  await key('keydown', 'w');
  await sleep(1400); // 采样窗口 1.2s 帧时 + 余量
  const ramp = await readSampler();
  const rv = ramp.v || [];
  const rft = ramp.ft || [];
  expect('起步采样到足够帧数（≥8）', rv.length >= 8, `${rv.length} 帧`);
  const rStart = rv.findIndex((x) => x > 5); // 第一个"动起来"的帧
  expect('起步是加速而非瞬移（首个运动帧 < 50% 全速）', rStart >= 0 && rv[rStart] < BASE * 0.5,
    `首个运动帧 moveSm=${rv[rStart]?.toFixed(1)}（瞬移会是 ${BASE}，指数趋近首帧 ≈ ${(BASE * (1 - Math.exp(-0.5))).toFixed(0)}）`);
  expect('加速需要多帧（第 3 帧仍在爬升，未到 95%）',
    rStart >= 0 && rStart + 2 < rv.length && rv[rStart + 2] < BASE * 0.95,
    `第3帧 moveSm=${rv[rStart + 2]?.toFixed(1)}`);
  expect('加速曲线单调上升', monotonic(rv, 1), JSON.stringify(rv.map((x) => Math.round(x))));
  const i300 = rft.findIndex((t) => t >= 0.3);
  expect('约 0.3s 帧时到达 ≥85% 全速（≈0.25s 到 90% 的曲率）', i300 >= 0 && rv[i300] >= BASE * 0.85,
    `帧时0.3s 处 moveSm=${i300 >= 0 ? rv[i300]?.toFixed(1) : 'n/a'}`);
  expect('最终收敛到全速（≥98%）', rv.length > 0 && Math.max(...rv) >= BASE * 0.98, `max=${rv.length ? Math.max(...rv).toFixed(1) : 'n/a'}`);

  // ---- 松键：moveSm 应自然衰减（滑停），而非一步清零 ----
  const vPre = rv[rv.length - 1];
  expect('采样器就绪（衰减段）', await installSampler() === 'ok');
  await key('keyup', 'w');
  await sleep(1400);
  const decay = await readSampler();
  const dv = decay.v || [];
  expect('衰减采样到足够帧数（≥8）', dv.length >= 8, `${dv.length} 帧`);
  const dropIdx = dv.findIndex((x, i) => i > 0 && x < dv[0] * 0.9); // 第一个真正下滑的帧
  expect('松键后进入衰减段', dropIdx > 0, `dropIdx=${dropIdx}`);
  expect('衰减连续（单帧降幅 < 50%，旧逻辑会直接归 0）',
    dropIdx > 0 && dv[dropIdx] >= dv[dropIdx - 1] * 0.5,
    `${dv[dropIdx - 1]?.toFixed(1)} → ${dv[dropIdx]?.toFixed(1)}`);
  expect('松键后仍在滑行（下滑帧 > 25% 全速，无急停）',
    dropIdx > 0 && dv[dropIdx] > BASE * 0.25, `moveSm=${dv[dropIdx]?.toFixed(1)}`);
  // 只查衰减段（dropIdx 起）：前几帧是 keyup 生效前的爬升尾帧，不属于衰减
  const decayPart = dv.slice(Math.max(0, dropIdx));
  const decayInv = (() => {
    for (let i = 1; i < decayPart.length; i += 1) if (decayPart[i] > decayPart[i - 1] + 1e-6) return `${i}: ${decayPart[i - 1]} → ${decayPart[i]}`;
    return null;
  })();
  expect('衰减曲线单调下降', decayInv === null, decayInv || JSON.stringify(decayPart.map((x) => Number(x).toFixed(2))));
  expect('衰减到停（末帧 < 5% 全速）', dv.length > 0 && dv[dv.length - 1] < BASE * 0.05,
    `末帧 moveSm=${dv[dv.length - 1]?.toFixed(1)}`);

  /* ==================== 块B：体力将尽过渡 ==================== */
  console.log('== 块B：体力将尽过渡 ==');
  /** 轮询直到 moveSm 进入目标区间（帧率无关）；hold 可选，每次轮询时回调注入 */
  const waitMoveSm = async (lo, hi, timeout = 5000, hold = null) => {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < timeout) {
      if (hold) await evaluate(hold);
      last = await evaluate('window.SOUDACHE.world.player.moveSm');
      if (typeof last === 'number' && last >= lo && last <= hi) return last;
      await sleep(70);
    }
    return last;
  };

  // 先拉到满速冲刺（体力满，无过渡倍率）
  await key('keydown', 'w');
  await key('keydown', 'Shift');
  const mSprint = await waitMoveSm(BASE * 1.5 - 12, BASE * 1.5 + 12);
  expect('满速冲刺 ≈ 1.5×基础（294）', typeof mSprint === 'number' && Math.abs(mSprint - BASE * 1.5) < 12, `moveSm=${mSprint}`);

  // 体力打到 15% 以下并保持：目标速度掉到 1.5×0.7 ≈ 1.05×基础（过渡段）
  const mLow = await waitMoveSm(BASE * 1.05 - 14, BASE * 1.05 + 14, 5000,
    '(() => { const p = window.SOUDACHE.world.player; p.stamina = 14; p.exhausted = false; })()');
  expect('体力将尽先减速到 ≈1.05×基础（206，过渡段）',
    typeof mLow === 'number' && Math.abs(mLow - BASE * 1.05) < 14,
    `moveSm=${mLow}（满速 294 / 过渡 206 / 走路 196 —— 证明不是从 1.5× 骤降到 0.55×）`);

  // 体力归零：exhausted → 0.55×基础（108）
  await evaluate('(() => { const p = window.SOUDACHE.world.player; p.stamina = 0; })()');
  const mEx = await waitMoveSm(BASE * 0.55 - 14, BASE * 0.55 + 14, 5000,
    '(() => { const p = window.SOUDACHE.world.player; p.stamina = 0; p.exhausted = true; })()');
  expect('体力归零后 ≈0.55×基础（108）',
    typeof mEx === 'number' && Math.abs(mEx - BASE * 0.55) < 14, `moveSm=${mEx}`);
  await key('keyup', 'Shift');
  await key('keyup', 'w');
  await sleep(500);

  // busy 时 moveSm 直接清零（读条期间不残留滑动）
  await evaluate('(() => { const p = window.SOUDACHE.world.player; p.moveSm = 150; p.search = { container: {}, progress: 0, total: 3 }; })()');
  await sleep(120);
  const mBusy = await evaluate('window.SOUDACHE.world.player.moveSm');
  expect('读条中 moveSm 直接清零（不残留滑动）', mBusy === 0, `moveSm=${mBusy}`);
  await evaluate('(() => { window.SOUDACHE.world.player.search = null; })()');
  await sleep(300);

  /* ==================== 块C1：暂停残留 ==================== */
  console.log('== 块C1：暂停残留 ==');
  await key('keydown', 'Escape');
  await sleep(300);
  const pauseVis = await evaluate(`!!document.querySelector('[data-screen="pause"]') && !document.querySelector('[data-screen="pause"]').classList.contains('hidden')`);
  expect('Esc 暂停后面板可见', pauseVis === true);
  await shot('30-pause.png');

  // 阵亡（真实 endRaid 链）→ 结算 → 再来一局 → 配置页
  await evaluate("window.SOUDACHE.endRaid('dead')");
  await sleep(1200);
  expect('点击「再来一局」', await clickText('再来一局') === 'ok');
  await sleep(900);
  const residue = await evaluate(`JSON.stringify((() => {
    const vis = [...document.querySelectorAll('[data-screen]')]
      .filter((n) => !n.classList.contains('hidden')).map((n) => n.dataset.screen);
    const pauseHidden = document.querySelector('[data-screen="pause"]').classList.contains('hidden');
    // HUD 画布中心像素：清理后必须全透明（修复前会残留"已暂停"暗化层 ≈140）
    const c = document.querySelector('canvas.hud-canvas');
    const ctx = c.getContext('2d');
    const px = ctx.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
    return { vis, pauseHidden, hudAlpha: px[3] };
  })())`);
  const rd = typeof residue === 'string' && residue[0] === '{' ? JSON.parse(residue) : {};
  expect('回到配置页（loadout 可见）', rd.vis && rd.vis.includes('loadout'), JSON.stringify(rd.vis));
  expect('暂停面板已从显示栈移除', rd.pauseHidden === true);
  expect('HUD 画布无残留（中心像素全透明，无"已暂停"遮罩）', rd.hudAlpha === 0, `alpha=${rd.hudAlpha}`);
  await shot('31-loadout-after-death.png');

  /* ==================== 块C2：损失清单弹药口径 ==================== */
  console.log('== 块C2：损失清单弹药口径 ==');
  // 重新部署再阵亡，读结算页真实 DOM
  expect('再次点击「部署进入战局」', await clickText('部署进入战局') === 'ok');
  for (let i = 0; i < 30; i += 1) {
    if (await evaluate('!!window.SOUDACHE.world') === true) break;
    await sleep(1000);
  }
  await sleep(1000);
  await evaluate("window.SOUDACHE.endRaid('dead')");
  await sleep(1200);
  const loss = await evaluate(`JSON.stringify((() => {
    const rows = [...document.querySelectorAll('[data-role="result-loot"] .item-row')].map((r) => ({
      name: (r.querySelector('.item-name') || {}).textContent || '',
      meta: (r.querySelector('.item-meta') || {}).textContent || '',
      value: (r.querySelector('.item-value') || {}).textContent || '',
    }));
    const stats = {};
    for (const s of document.querySelectorAll('[data-screen="result"] .stat')) {
      stats[(s.querySelector('.k') || {}).textContent] = (s.querySelector('.v') || {}).textContent;
    }
    return { rows, stats };
  })())`);
  const ls = typeof loss === 'string' && loss[0] === '{' ? JSON.parse(loss) : {};
  const ammo556 = (ls.rows || []).find((r) => r.name.includes('5.56mm'));
  expect('损失清单有 5.56mm 行（同 id 已合并）', !!ammo556, JSON.stringify(ls.rows));
  expect('弹药按盒显示：×2 盒（不是 ×60）', ammo556 && ammo556.name.includes('×2 盒'), ammo556 ? ammo556.name : '');
  expect('盒重口径：2.0kg（不是 60.0kg）', ammo556 && ammo556.meta.includes('2.0kg'), ammo556 ? ammo556.meta : '');
  expect('盒价口径：¥1,200（不是 ¥36,000）', ammo556 && ammo556.value === '¥1,200', ammo556 ? ammo556.value : '');
  const total = ls.stats && ls.stats['物资总值'];
  const totalNum = total ? Number(total.replace(/[^\d]/g, '')) : 0;
  // 正确值 ≈ ¥12,240（含枪甲）；×60 口径下光是弹药就 ¥72,000+
  expect('物资总值不再被放大 60 倍（¥10,000~20,000）', totalNum >= 10000 && totalNum <= 20000, `物资总值=${total}`);
  const weight = ls.stats && ls.stats['总负重'];
  const weightNum = weight ? parseFloat(weight) : 999;
  expect('总负重盒口径（≤ 30kg，不是 179.7kg）', weightNum > 0 && weightNum <= 30, `总负重=${weight}`);
  await shot('32-loss-list.png');

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
