/**
 * 局内冒烟：无头 Edge + CDP，播种「夜战 + 全套配件」存档后真正部署进图，
 * 校验战斗循环跑起来且本轮新功能在局内生效。
 *
 * 为什么需要它：菜单屏全绿只证明"界面能渲染"；时段主题、头灯、配件乘数、
 * Boss 生成上限这些东西只在 startRaid 之后才存在，漏接线 / 抛异常都只在
 * 进图那一刻暴露。
 *
 * 覆盖点：
 *   1. 时段选择（set-time）写入存档，夜战主题进 world
 *   2. 配件：deploy 从仓库消耗、buildPlayerMods 汇总成乘数挂到 player
 *   3. 天赋：未学节点时角色属性 = 基线（不污染）
 *   4. Boss：每局最多 1 个（权重抽中才出）
 *   5. 夜战敌人视野缩短 15%
 *   6. 渲染主循环（scene3d 主题 + 头灯 + renderer3d）跑数秒无未捕获异常
 *
 *   node tools/probe-battle.mjs [--url ...] [--time night|day]
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
const TIME = flag('time', 'night'); // night | day：本次要验证的时段
const port = Number(flag('port', 9700 + Math.floor(Math.random() * 200)));
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
const profileDir = join(tmpdir(), 'cdp-battle-' + port + '-' + Date.now());

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

/** 播种存档：夜战 + 主武器全套配件 + 副武器消音器，仓库物资拉满 */
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
  await send('Page.addScriptToEvaluateOnNewDocument', { source: SEED });

  await send('Page.navigate', { url });
  let booted = false;
  for (let i = 0; i < 40; i += 1) {
    const ok = await evaluate('!!window.SOUDACHE');
    if (ok === true) { booted = true; break; }
    await sleep(1000);
  }
  expect('页面启动（window.SOUDACHE 已挂载）', booted);

  // 1) 战前配置：选夜战（走 UI，顺带验证 set-time 接线）
  expect('点击「开始战局」', await clickText('开始战局') === 'ok');
  await sleep(800);
  expect(`点击「${TIME === 'day' ? '白昼' : '夜战'}」时段`, await clickText(TIME === 'day' ? '白昼' : '夜战') === 'ok');
  await sleep(400);
  const timeSet = await evaluate('window.SOUDACHE && window.SOUDACHE.save.loadout.time');
  expect('时段写入存档', timeSet === TIME, String(timeSet));
  await shot(`20-loadout-${TIME}.png`);

  // 2) 部署进图
  expect('点击「部署进入战局」', await clickText('部署进入战局') === 'ok');
  let world = null;
  for (let i = 0; i < 30; i += 1) {
    world = await evaluate('JSON.stringify((() => { const w = window.SOUDACHE && window.SOUDACHE.world; return w ? { theme: w.theme } : null; })())');
    if (world && world !== 'null') break;
    await sleep(1000);
  }
  expect('world 已创建（进图成功）', !!world && world !== 'null', String(world));

  // 3) 局内状态断言（一次性取回，避免多次 evaluate 竞态）
  const stateRaw = await evaluate(`JSON.stringify((() => {
    const w = window.SOUDACHE.world;
    if (!w) return null;
    const p = w.player;
    const stashCount = (id) => (window.SOUDACHE.save.stash.items || [])
      .filter((it) => it.id === id).reduce((s, it) => s + (it.qty || 1), 0);
    const bossSpawns = (w.map.enemySpawns || []).filter((s) => s.type === 'boss').length;
    const enemy = w.enemies && w.enemies[0];
    return {
      theme: w.theme,
      weaponMods: p && p.weaponMods,
      maxHp: p && p.maxHp,
      staminaRegenMul: p && p.staminaRegenMul,
      searchTimeMul: p && p.searchTimeMul,
      extractTime: p && p.extractTime,
      reloadMul: p && p.reloadMul,
      recoilMul: p && p.recoilMul,
      enemyCount: (w.enemies || []).length,
      bossSpawns,
      enemyVision: enemy ? { def: enemy.def.visionRange, mul: enemy.visionMul || 1 } : null,
      stashAfter: { comp: stashCount('muzzle_comp'), sil: stashCount('muzzle_sil') },
      canvasActive: !!document.querySelector('canvas.active'),
    };
  })())`);
  const st = typeof stateRaw === 'string' && stateRaw[0] === '{' ? JSON.parse(stateRaw) : {};

  expect(`${TIME === 'day' ? '白昼' : '夜战'}主题生效`, st.theme === TIME, String(st.theme));
  const rifleMods = st.weaponMods && st.weaponMods.rifle;
  expect('配件乘数已挂到 player（主武器）', !!rifleMods, JSON.stringify(rifleMods));
  expect('制退器+垂直握把：后坐 ×0.65', rifleMods && Math.abs(rifleMods.recoilMul - 0.65) < 1e-9, String(rifleMods && rifleMods.recoilMul));
  expect('全息+制退器：基础散布 ×0.75 / 开镜 ×0.8', rifleMods && Math.abs(rifleMods.spreadMul - 0.75) < 1e-9 && Math.abs(rifleMods.adsSpreadMul - 0.8) < 1e-9, JSON.stringify(rifleMods));
  const pistolMods = st.weaponMods && st.weaponMods.pistol;
  expect('消音器：噪音 ×0.4 / 伤害 ×0.95', pistolMods && Math.abs(pistolMods.noiseMul - 0.4) < 1e-9 && Math.abs(pistolMods.damageMul - 0.95) < 1e-9, JSON.stringify(pistolMods));
  expect('天赋未学时角色属性 = 基线', st.maxHp === 100 && st.staminaRegenMul === 1 && st.searchTimeMul === 1 && st.extractTime === 3 && st.reloadMul === 1 && st.recoilMul === 1,
    `hp=${st.maxHp} stamina=${st.staminaRegenMul} search=${st.searchTimeMul} extract=${st.extractTime} reload=${st.reloadMul} recoil=${st.recoilMul}`);
  expect('Boss 每局最多 1 个', typeof st.bossSpawns === 'number' && st.bossSpawns <= 1, `bossSpawns=${st.bossSpawns} / 敌人 ${st.enemyCount}`);
  expect(TIME === 'night' ? '夜战敌人视野缩短 15%' : '白昼敌人视野不变',
    st.enemyVision && Math.abs(st.enemyVision.mul - (TIME === 'night' ? 0.85 : 1)) < 1e-9,
    st.enemyVision ? `视野系数 ×${st.enemyVision.mul}（基础 ${st.enemyVision.def}）` : '无敌人');
  expect('配件已被 deploy 消耗', st.stashAfter && st.stashAfter.comp === 0 && st.stashAfter.sil === 0, JSON.stringify(st.stashAfter));
  expect('战斗画布激活', st.canvasActive === true);

  // 4) 让渲染主循环跑一会儿（主题 + 头灯 + 敌人 AI 全在这几秒里转）
  await sleep(5000);
  const stillAlive = await evaluate('!!window.SOUDACHE.world');
  expect('主循环运行 5 秒后 world 仍在', stillAlive === true);
  await shot(`21-battle-${TIME}.png`);

  // 5) 结算链路：调用真实 endRaid（阵亡路径），验证成就解锁 / 货币 / 称号 / 死因行
  //    播种 raids=24：结算时 +1 恰好跨过 25，解锁带称号的「战区老兵」——
  //    这样能一次验证"达标→解锁→发钱→称号上结算页"整条链。
  const moneyBefore = await evaluate('window.SOUDACHE.save.currency');
  // 注入真实敌人作伤害来源（走 lastHitBy 归因链路），并用游戏真实的死亡原因 'dead'
  const killerName = await evaluate(`(() => {
    const w = window.SOUDACHE.world;
    const e = w.enemies && w.enemies[0];
    if (e) { w.player.lastHitBy = e; w.player.lastHitDist = 400; }
    return e ? e.def.name : null;
  })()`);
  await evaluate("window.SOUDACHE.endRaid('dead')");
  await sleep(1500);
  const res = await evaluate(`JSON.stringify((() => {
    const vis = [...document.querySelectorAll('[data-screen]')]
      .filter((n) => !n.classList.contains('hidden')).map((n) => n.dataset.screen);
    const toasts = [...document.querySelectorAll('.toast')].map((t) => t.textContent);
    const title2 = document.querySelector('.result-title2');
    const keys = [...document.querySelectorAll('[data-screen="result"] .stat .k')].map((n) => n.textContent);
    const vals = [...document.querySelectorAll('[data-screen="result"] .stat .v')].map((n) => n.textContent);
    const save = window.SOUDACHE.save;
    return {
      vis,
      toasts,
      title2: title2 ? title2.textContent : null,
      statKeys: keys,
      statVals: vals,
      currency: save.currency,
      achIds: save.ach.ids,
      treeLevel: save.tree.level,
    };
  })())`);
  const rs = typeof res === 'string' && res[0] === '{' ? JSON.parse(res) : {};
  expect('进入结算屏', rs.vis && rs.vis.includes('result'), JSON.stringify(rs.vis));
  expect('成就解锁 toast 弹出', (rs.toasts || []).some((t) => t.includes('成就解锁')), JSON.stringify(rs.toasts));
  expect('结算发放成就货币', rs.currency === (moneyBefore || 0) + 2000, `${moneyBefore} → ${rs.currency}（本次仅战区老兵 2000；首突袭/常客与登录补给 ¥300 在启动回菜单时已发）`);
  expect('带称号成就已解锁', (rs.achIds || []).includes('raider_25'), JSON.stringify(rs.achIds));
  expect('结算页展示称号（金色行）', rs.title2 === '称号 · 战区老兵', String(rs.title2));
  expect('结算页有死因行', (rs.statKeys || []).some((k) => k.includes('死因')), JSON.stringify(rs.statKeys));
  expect('死因归因到真实敌人', killerName && (rs.statVals || []).some((v) => v.includes(killerName)), `killer=${killerName} vals=${JSON.stringify(rs.statVals)}`);
  expect('结算发放了经验（可升级）', typeof rs.treeLevel === 'number' && rs.treeLevel >= 1, `Lv.${rs.treeLevel}`);
  await shot(`22-result-${TIME}.png`);

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
