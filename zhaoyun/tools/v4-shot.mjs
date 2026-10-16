/* 赵云与阿斗 · V4 塔防化证据截图（无头 Edge + CDP）
 * 生成 5 张验收图：
 *   ① 蛇形主路全貌（入口标记 + 地砖路径 + 阿斗终点 + 塔位/荒地/障碍可辨）
 *   ② 路边塔阵（5 座塔含武将塔，等级数字清晰可见）
 *   ③ 火球拖到主路爆炸瞬间（爆炸特效 + 敌人受伤/消灭）
 *   ④ 神兵符/铲子拖放释放后的状态（banner + buff + 新塔位）
 *   ⑤ 竞技双路双阿斗界面（整屏含 HUD 双心血）
 * 用法：node tools/v4-shot.mjs
 * 注意：CDP 的 clip 必须带 scale（该 Edge 版本缺失会 -32602 静默失败），存图后校验字节数。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
const URL = 'file:///' + INDEX.replace(/\\/g, '/');
const PORT = 9345;
const OUT = 'C:/Users/31474/AppData/Local/Temp/zy-v4';
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--mute-audio',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=C:/Users/31474/AppData/Local/Temp/zy-v4-profile',
  '--allow-file-access-from-files', '--window-size=420,900', 'about:blank',
], { stdio: 'ignore' });

async function waitPort() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/version'); if (r.ok) return; } catch (e) {}
    await sleep(300);
  }
  throw new Error('Edge 未启动');
}

let mid = 0;
const pending = new Map();
async function waitTarget() {
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
    const t = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
    if (t) return t;
    await sleep(300);
  }
  throw new Error('找不到 page target');
}
await waitPort();
const ws = new WebSocket((await waitTarget()).webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
const send = (method, params = {}) => new Promise((r) => {
  const id = ++mid; ws.send(JSON.stringify({ id, method, params }));
  pending.set(id, r);
});
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval');
  return r.result?.result?.value;
}

/** 截图：zoom 放大棋盘 → clip 裁顶部 crop 比例 → 校验字节数落盘 */
async function shoot(name, zoom, crop) {
  const rect = await evalJs(`(() => {
    const b = document.getElementById('board');
    if (${zoom} > 1) b.style.zoom = ${zoom}; else b.style.zoom = '';
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  await sleep(150);
  const h = crop && crop < 1 ? Math.round(rect.h * crop) : rect.h;
  const clip = { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: Math.min(1200, rect.w), height: Math.min(1500, h), scale: 1 };
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });
  if (!r.result?.data) throw new Error('截图失败 ' + name + ': ' + JSON.stringify(r.error || 'no data'));
  const file = path.join(OUT, name);
  fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  const bytes = fs.statSync(file).size;
  if (bytes < 5000) throw new Error('截图异常小 ' + name + ': ' + bytes + ' bytes');
  await evalJs(`document.getElementById('board').style.zoom = ''`);
  console.log('  存图 ' + name + '  (' + clip.width + 'x' + clip.height + ', ' + bytes + ' bytes)');
}
/** 整屏截图（不裁棋盘，含 HUD） */
async function shootFull(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  if (!r.result?.data) throw new Error('截图失败 ' + name + ': ' + JSON.stringify(r.error || 'no data'));
  const file = path.join(OUT, name);
  fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  const bytes = fs.statSync(file).size;
  if (bytes < 5000) throw new Error('截图异常小 ' + name + ': ' + bytes + ' bytes');
  console.log('  存图 ' + name + '  (整屏, ' + bytes + ' bytes)');
}
/** 截图（保留调用方预设的 zoom，不再触碰布局 —— 用于压短「拖拽→截图」延迟，抓爆炸峰值） */
async function shootKeepZoom(name, crop) {
  const rect = await evalJs(`(() => {
    const b = document.getElementById('board');
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  await sleep(60);
  const h = crop && crop < 1 ? Math.round(rect.h * crop) : rect.h;
  const clip = { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: Math.min(1200, rect.w), height: Math.min(1500, h), scale: 1 };
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });
  if (!r.result?.data) throw new Error('截图失败 ' + name + ': ' + JSON.stringify(r.error || 'no data'));
  const file = path.join(OUT, name);
  fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  const bytes = fs.statSync(file).size;
  if (bytes < 5000) throw new Error('截图异常小 ' + name + ': ' + bytes + ' bytes');
  console.log('  存图 ' + name + '  (' + clip.width + 'x' + clip.height + ', ' + bytes + ' bytes)');
}

/** 清盘并暂停（直接置 paused，不弹暂停面板） */
const RESET = `(() => {
  const s = ZY.UI.getState();
  s.paused = true;
  s.units.length = 0;
  s.player.hand.length = 0;
  for (let r=0;r<12;r++) for (let c=0;c<8;c++) s.grid[r][c]=null;
  return true;
})()`;
/** 拖拽辅助（与 probe 同手法：pointer 事件） */
const DRAG_HELPERS = `
window.__cellXY = (r, c) => {
  const br = document.getElementById('board').getBoundingClientRect();
  return { x: br.left + (c + 0.5) * (br.width / 8), y: br.top + (r + 0.5) * (br.height / 12) };
};
window.__dragCard = async (uid, tx, ty, settle) => {
  const card = document.querySelector('#hand .card[data-uid="' + uid + '"]');
  if (!card) return { err: 'no card ' + uid };
  const cr = card.getBoundingClientRect();
  const sx = cr.left + cr.width / 2, sy = cr.top + cr.height / 2;
  const mk = (type, x, y) => new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', isPrimary: true });
  card.dispatchEvent(mk('pointerdown', sx, sy));
  await new Promise(r => setTimeout(r, 60));
  window.dispatchEvent(mk('pointermove', (sx + tx) / 2, (sy + ty) / 2));
  await new Promise(r => setTimeout(r, 60));
  window.dispatchEvent(mk('pointermove', tx, ty));
  await new Promise(r => setTimeout(r, 60));
  window.dispatchEvent(mk('pointerup', tx, ty));
  await new Promise(r => setTimeout(r, settle == null ? 240 : settle));
  return { ok: true };
};
`;

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: URL });
await sleep(1500);

/* ================================================== ①②③④ 无尽模式 */
console.log('== 进入无尽并布阵（暂停，确定性）==');
await evalJs(`document.querySelector('.mode-btn[data-mode="endless"]').click()`);
await sleep(400);
await evalJs(RESET);
await evalJs(DRAG_HELPERS);
// 布：塔位塔 2 座 + 主路行军敌人 5 个（不同路段）+ 1 精英
await evalJs(`(() => {
  const s = ZY.UI.getState();
  const add = (side, type, row, col, o) => { o=o||{};
    const u = ZY.Game.makeUnit(s, side, { cls:'soldier', type, char: ZY.UNITS[type].char, level:o.level||1, row, col, elite:!!o.elite });
    ZY.Game.addUnit(s, u); return u.id;
  };
  const addE = (pi, o) => { o=o||{};
    const p = ZY.B.pathSeq('endless','player')[pi];
    const u = ZY.Game.makeUnit(s, 'enemy', { cls:'soldier', type:o.type||'zei', level:o.level||1, row:p.row, col:p.col, target:'player', pi, elite:!!o.elite });
    ZY.Game.addUnit(s, u); return u.id;
  };
  add('player','dao',1,2,{level:1});
  add('player','gong',3,4,{level:1});
  addE(3); addE(10,{type:'dao',elite:true}); addE(17,{type:'qiang'}); addE(24,{type:'gong'}); addE(31,{type:'qi'});
  return true;
})()`);
await sleep(280);

console.log('== ① 蛇形主路全貌 ==');
await shoot('v4-1-path.png', 1.15, 1);

console.log('== ② 路边塔阵（等级清晰）==');
await evalJs(RESET);
await evalJs(`(() => {
  const s = ZY.UI.getState();
  const add = (type, row, col, level) => {
    const u = ZY.Game.makeUnit(s, 'player', { cls:'soldier', type, char: ZY.UNITS[type].char, level, row, col });
    ZY.Game.addUnit(s, u); return u.id;
  };
  add('dao',1,1,1); add('gong',1,3,2); add('qiang',1,5,3);
  add('dao',3,3,2); add('qi',3,5,1);
  const h = ZY.Game.makeUnit(s,'player',{cls:'hero',heroId:'zhaoyun',heroLevel:2,row:3,col:4});
  ZY.Game.addUnit(s,h);
  // 主路上来两个敌人，体现「路边塔阵打主路」
  [[2,'zei',1],[6,'dao',2]].forEach(([pi,t,lv]) => {
    const p = ZY.B.pathSeq('endless','player')[pi];
    const u = ZY.Game.makeUnit(s,'enemy',{cls:'soldier',type:t,level:lv,row:p.row,col:p.col,target:'player',pi});
    ZY.Game.addUnit(s,u);
  });
  return true;
})()`);
await sleep(280);
await shoot('v4-2-towers.png', 2.1, 0.56);

console.log('== ③ 火球拖到主路爆炸瞬间 ==');
await evalJs(RESET);
// 4 个敌人聚团在主路爆炸 3×3 内：(4,3)(4,4)(4,5) 各 500 血 + (3,4) 60 血（距爆心 1 格，将被秒杀）
await evalJs(`(() => {
  const s = ZY.UI.getState();
  const mk = (r,c,hp) => { const u = ZY.Game.makeUnit(s,'enemy',{cls:'soldier',type:'dao',level:1,row:r,col:c,target:'player'}); u.move=0; u.hp=u.maxHp=hp; ZY.Game.addUnit(s,u); return u.id; };
  window.__fbTargets = [mk(4,3,500), mk(4,4,500), mk(4,5,500), mk(3,4,60)];
  s.player.hand.push({ uid: 888001, kind:'item', item:'fireball' });
  return true;
})()`);
await sleep(260);
// 先预设放大再拖拽：把「释放→截图」延迟压到爆炸亮度峰值附近（boom 生命周期 540ms）
await evalJs(`document.getElementById('board').style.zoom = 2.1`);
await sleep(250);
const fbDrag = await evalJs(`(async () => {
  const p = window.__cellXY(4, 4);
  return await window.__dragCard(888001, p.x, p.y, 40);
})()`);
if (fbDrag && fbDrag.err) throw new Error(fbDrag.err);
// 断言：卡已消耗 / 3×500 血各受 80（剩 420）/ 60 血秒杀 / 爆炸与伤害 DOM 在场
const fbChk = await evalJs(`(() => {
  const s = ZY.UI.getState();
  const alive = s.units.filter(u => u.side === 'enemy' && !u.dead);
  return {
    consumed: !s.player.hand.some(c => c.uid === 888001),
    alive: alive.length,
    hps: alive.map(u => u.hp).sort((a,b)=>a-b).join(','),
    boomDom: document.querySelectorAll('.boom').length,
    dmgDom: document.querySelectorAll('.dmg').length,
  };
})()`);
console.log('  火球断言 ' + JSON.stringify(fbChk));
if (!fbChk.consumed) throw new Error('火球卡牌未被消耗');
if (fbChk.alive !== 3) throw new Error('预期 3 个敌人存活，实际 ' + fbChk.alive);
if (fbChk.hps !== '420,420,420') throw new Error('预期血量 420,420,420，实际 ' + fbChk.hps);
if (fbChk.boomDom < 1) throw new Error('爆炸特效 DOM 未出现（时序错过）');
if (fbChk.dmgDom < 3) throw new Error('伤害飘字 DOM 不足 3，实际 ' + fbChk.dmgDom);
await sleep(80);   // 落在爆炸亮度峰值附近
await shootKeepZoom('v4-3-fireball.png', 0.56);
await evalJs(`document.getElementById('board').style.zoom = ''`);

console.log('== ④ 神兵符/铲子拖放释放后的状态 ==');
await evalJs(RESET);
// 先布 3 座塔（buff 有对象），再走真实拖放：铲子开 (2,1) 荒地 → 神兵符横拖释放
await evalJs(`(() => {
  const s = ZY.UI.getState();
  [['dao',1,2,1],['gong',1,4,2],['qiang',3,3,2]].forEach(([t,r,c,lv]) => {
    const u = ZY.Game.makeUnit(s,'player',{cls:'soldier',type:t,char:ZY.UNITS[t].char,level:lv,row:r,col:c});
    ZY.Game.addUnit(s,u);
  });
  s.player.hand.push({ uid: 888002, kind:'item', item:'shovel' });
  s.player.hand.push({ uid: 888003, kind:'item', item:'warcry' });
  return true;
})()`);
await sleep(240);
const shDrag = await evalJs(`(async () => {
  const p = window.__cellXY(2, 1);
  return await window.__dragCard(888002, p.x, p.y);
})()`);
if (shDrag && shDrag.err) throw new Error(shDrag.err);
// 断言：铲子把 (2,1) 荒地扩成塔位（state + DOM 双证）
const shChk = await evalJs(`(() => {
  const s = ZY.UI.getState();
  const cell = document.querySelector('.cell[data-r="2"][data-c="1"]');
  return { deploy: s.deploy['2,1'] || null, cls: cell ? cell.className : 'no-cell' };
})()`);
console.log('  铲子断言 ' + JSON.stringify(shChk));
if (shChk.deploy !== 'player') throw new Error('铲子未把 (2,1) 扩成塔位');
if (!/\bdeploy\b/.test(shChk.cls)) throw new Error('(2,1) DOM 未切到塔位样式: ' + shChk.cls);
const wcDrag = await evalJs(`(async () => {
  // 神兵符：从手牌横拖到棋盘中部释放（途中生成轨迹特效）
  const card = document.querySelector('#hand .card[data-uid="888003"]');
  const cr = card.getBoundingClientRect();
  const sx = cr.left + cr.width / 2, sy = cr.top + cr.height / 2;
  const mk = (type, x, y) => new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 2, pointerType: 'touch', isPrimary: true });
  card.dispatchEvent(mk('pointerdown', sx, sy));
  await new Promise(r => setTimeout(r, 60));
  const p1 = window.__cellXY(0, 4), p2 = window.__cellXY(1, 4);
  window.dispatchEvent(mk('pointermove', p1.x, p1.y));
  await new Promise(r => setTimeout(r, 70));
  window.dispatchEvent(mk('pointermove', p2.x, p2.y));
  await new Promise(r => setTimeout(r, 70));
  window.dispatchEvent(mk('pointerup', p2.x, p2.y));
  await new Promise(r => setTimeout(r, 160));
  return { ok: true };
})()`);
if (wcDrag && wcDrag.err) throw new Error(wcDrag.err);
// 断言：神兵符 buff 生效 + banner 文案（state.banner 是一次性信票，渲染帧读过即置 null，显示态在 DOM）
const wcChk = await evalJs(`(() => {
  const s = ZY.UI.getState();
  const b = document.getElementById('banner');
  return { buff: s.buff.player, banner: b.textContent, shown: b.classList.contains('show') };
})()`);
console.log('  神兵符断言 ' + JSON.stringify(wcChk));
if (!(wcChk.buff > 0)) throw new Error('神兵符 buff 未生效');
if (!/神兵符/.test(wcChk.banner)) throw new Error('banner 文案异常: ' + wcChk.banner);
if (!wcChk.shown) throw new Error('banner 未显示');
await sleep(60);
await shoot('v4-4-items.png', 1.3, 0.78);

/* ================================================== ⑤ 竞技双路双阿斗（整屏） */
console.log('== ⑤ 竞技双路双阿斗 ==');
await send('Page.navigate', { url: URL });
await sleep(1500);
await evalJs(`document.querySelector('.mode-btn[data-mode="versus"]').click()`);
await sleep(400);
await evalJs(RESET);
await evalJs(`(() => {
  const s = ZY.UI.getState();
  const addT = (side, type, row, col, level) => {
    // 塔：显式 target:null（否则敌方单位默认 target='player' 会沿主路行军）
    const u = ZY.Game.makeUnit(s, side, { cls:'soldier', type, char: ZY.UNITS[type].char, level, row, col, target: null });
    ZY.Game.addUnit(s, u);
  };
  const addW = (target, pi, type) => {
    const p = ZY.B.pathSeq('versus', target)[pi];
    const u = ZY.Game.makeUnit(s, 'enemy', { cls:'soldier', type, level: 2, row: p.row, col: p.col, target });
    u.pi = pi;
    ZY.Game.addUnit(s, u);
  };
  // 我方 3 塔守我方路（cols 1-3 侧塔位）
  addT('player','dao',1,1,2); addT('player','gong',3,2,1); addT('player','qiang',5,2,2);
  // 敌方 3 塔守敌方路（cols 4-6 侧塔位）
  addT('enemy','dao',1,6,1);  addT('enemy','gong',3,5,2);  addT('enemy','qiang',5,5,1);
  // 两侧路各 2 个行军敌人（不同路段）
  addW('player', 4, 'zei'); addW('player', 12, 'dao');
  addW('enemy', 8, 'qiang'); addW('enemy', 16, 'zei');
  return true;
})()`);
// 断言：双方各 3 塔（敌方塔 side='enemy' 且无行军路径）+ 双路各 2 个行军敌人
const vsChk = await evalJs(`(() => {
  const s = ZY.UI.getState();
  const towers = s.units.filter(u => u.target == null);
  const walkers = s.units.filter(u => u.target != null);
  return {
    pTowers: towers.filter(u => u.side === 'player').length,
    eTowers: towers.filter(u => u.side === 'enemy').length,
    eTowerWithPath: towers.filter(u => u.side === 'enemy' && u.path).length,
    onPlayerPath: walkers.filter(u => u.target === 'player').length,
    onEnemyPath: walkers.filter(u => u.target === 'enemy').length,
    adou: [s.player.adou, s.enemy.adou],
  };
})()`);
console.log('  竞技断言 ' + JSON.stringify(vsChk));
if (vsChk.pTowers !== 3 || vsChk.eTowers !== 3) throw new Error('双方塔数异常: ' + JSON.stringify(vsChk));
if (vsChk.eTowerWithPath !== 0) throw new Error('敌方塔被配了行军路径（会沿主路走）');
if (vsChk.onPlayerPath !== 2 || vsChk.onEnemyPath !== 2) throw new Error('双路行军敌人异常: ' + JSON.stringify(vsChk));
if (vsChk.adou[0] !== 3 || vsChk.adou[1] !== 3) throw new Error('双方阿斗血量异常: ' + JSON.stringify(vsChk.adou));
await sleep(300);
await shootFull('v4-5-versus.png');

console.log('完成，证据在 ' + OUT);
ws.close();
proc.kill('SIGKILL');
process.exit(0);
