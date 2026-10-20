/* 赵云与阿斗 · V7 美术升级复核（无头 Edge + CDP，竖屏 375×667）
 * 产出 5 张截图到 zhaoyun-v7-evidence/：
 *   ① v7-1-board.png       开局棋盘：纯色无网格无斜线 + 己方兵种立绘
 *   ② v7-2-units.png       兵种 + 赵云/关羽双格武将（等级角标显隐）
 *   ③ v7-3-attack.png      攻击动作帧（.a-atk 生效）
 *   ④ v7-4-skill.png       技能播报 #skill-banner + 专属粒子
 *   ⑤ v7-5-enemy-boss.png  敌方黄巾兵 + Boss 张梁立绘
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');
const OUT = 'D:/安装包/WorkBuddy/工作空间/2026-10-16-00-32-32/zhaoyun-v7-evidence';
const PORT = 9357;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--mute-audio',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=C:/Users/31474/AppData/Local/Temp/zy-art-profile',
  '--allow-file-access-from-files', '--window-size=390,844', 'about:blank',
], { stdio: 'ignore' });

async function waitPort() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/version'); if (r.ok) return; } catch (e) {}
    await sleep(300);
  }
  throw new Error('Edge 未启动');
}
let mid = 0; const pending = new Map();
await waitPort();
let target = null;
for (let i = 0; i < 40 && !target; i++) {
  const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
  target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!target) await sleep(300);
}
if (!target) throw new Error('找不到 page target');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => { const id = ++mid; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pending.set(id, r)); };
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval 失败');
  return r.result?.result?.value;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
  console.log('  ✓ ' + name);
};

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 667, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: URL });
await sleep(1500);
await evalJs(`document.querySelector('.mode-btn[data-mode="endless"]').click()`);
await sleep(400);

const HELPERS = `
window.__tap = async (sel) => {
  const el = document.querySelector(sel);
  if (!el) return { err: 'no el ' + sel };
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const mk = (t, xx, yy) => new PointerEvent(t, { clientX: xx, clientY: yy, bubbles: true, cancelable: true, pointerId: 2, pointerType: 'touch', isPrimary: true });
  el.dispatchEvent(mk('pointerdown', x, y));
  await new Promise(r2 => setTimeout(r2, 60));
  window.dispatchEvent(mk('pointerup', x, y));
  await new Promise(r2 => setTimeout(r2, 220));
  return { ok: true };
};
`;
await evalJs(HELPERS);

// 冻结 + 铺设己方兵种（刀/枪/弓）
const setup = await evalJs(`(() => {
  const s = ZY.UI.getState();
  s.paused = true;
  const mk = (type, r, c) => { const u = ZY.Game.makeUnit(s, 'player', { cls:'soldier', type, level:1, row:r, col:c, target:null }); ZY.Game.addUnit(s, u); return u.id; };
  return { dao: mk('dao', 1, 2), qiang: mk('qiang', 2, 2), gong: mk('gong', 3, 2) };
})()`);
await sleep(500);
const s1 = await evalJs(`(() => {
  const imgs = [...document.querySelectorAll('.unit .fig-img')];
  return { n: imgs.length, loaded: imgs.every(i => i.naturalWidth > 0), srcs: imgs.map(i => i.getAttribute('src')) };
})()`);
console.log('   ① 兵种立绘 ' + s1.n + ' 张 · 全部解码=' + s1.loaded + ' · ' + s1.srcs.join(', '));
await shot('v7-1-board.png');   // ① 开局棋盘 + 己方兵种立绘

// ② 双格武将（赵云 span2 / 关羽 span2）+ 等级角标显隐（点选赵云显示，关羽保持隐藏）
const heroes = await evalJs(`(() => {
  const s = ZY.UI.getState();
  const z = ZY.Game.makeUnit(s, 'player', { cls:'hero', heroId:'zhaoyun', heroLevel:1, row:1, col:5, span:2, target:null });
  ZY.Game.addUnit(s, z);
  const g = ZY.Game.makeUnit(s, 'player', { cls:'hero', heroId:'guanyu', heroLevel:1, row:3, col:5, span:2, target:null });
  ZY.Game.addUnit(s, g);
  return { z: z.id, g: g.id };
})()`);
await sleep(420);
await evalJs(`window.__tap('.unit.p.hero[data-uid="${heroes.z}"]')`);
const b2 = await evalJs(`(() => {
  const z = document.querySelector('.unit.p.hero[data-uid="${heroes.z}"]');
  const g = document.querySelector('.unit.p.hero[data-uid="${heroes.g}"]');
  const vis = el => (el && el.querySelector('.lv')) ? getComputedStyle(el.querySelector('.lv')).visibility : 'n/a';
  const br = document.getElementById('board').getBoundingClientRect();
  const zr = z ? z.getBoundingClientRect() : null;
  return { zBadge: vis(z), gBadge: vis(g), zSrc: z && z.querySelector('.fig-img').getAttribute('src'),
           gSrc: g && g.querySelector('.fig-img').getAttribute('src'),
           zW: zr ? Math.round(zr.width) : 0, cellW: Math.round(br.width / 8),
           zLeft: zr ? Math.round(zr.left - br.left) : -1, zRight: zr ? Math.round(zr.right - br.left) : -1, boardW: Math.round(br.width) };
})()`);
console.log('   ② 赵云角标=' + b2.zBadge + ' 关羽角标=' + b2.gBadge + ' · 塔宽=' + b2.zW + 'px（单格 ' + b2.cellW + 'px）· 板宽=' + b2.boardW + ' · 赵云left=' + b2.zLeft + ' right=' + b2.zRight + ' · ' + b2.zSrc + ' / ' + b2.gSrc);
await shot('v7-2-units.png');   // ② 兵种 + 双格武将

// ③ 攻击动作帧：注入 anim 事件 → .a-atk
await evalJs(`(async () => {
  const s = ZY.UI.getState();
  s.fx.push({ type: 'anim', uid: ${setup.dao} });
  await new Promise(r => setTimeout(r, 70));
})()`);
const atk = await evalJs(`(() => { const el = document.querySelector('.unit.p[data-uid="${setup.dao}"]'); return { hasAtk: !!(el && el.classList.contains('a-atk')), anim: el ? getComputedStyle(el.querySelector('.fig-img')).animationName : 'none' }; })()`);
console.log('   ③ 攻击帧 .a-atk=' + atk.hasAtk + ' · animationName=' + atk.anim);
await shot('v7-3-attack.png');  // ③ 攻击动作帧

// ④ 技能播报 + 粒子：贴近敌人触发赵云自动技能（真实 game.js → ZY.UI.onSkillCast 链路）
const skill = await evalJs(`(async () => {
  const s = ZY.UI.getState();
  const hero = s.units.find(u => u.heroId === 'zhaoyun' && u.side === 'player');
  const foe = ZY.Game.makeUnit(s, 'enemy', { cls:'soldier', type:'zei', level:1, row:2, col:5, target:'player' });
  foe.move = 0; foe.hp = foe.maxHp = 9000;
  ZY.Game.addUnit(s, foe);
  await new Promise(r => setTimeout(r, 80));
  hero.skillT = 0;
  s.paused = false;
  await new Promise(r => setTimeout(r, 140));
  s.paused = true;
  const b = document.getElementById('skill-banner');
  return { text: b ? b.textContent : '', shown: b ? b.classList.contains('show') : false,
           parts: document.querySelectorAll('.skill-fx .fx-particle').length };
})()`);
console.log('   ④ 播报「' + skill.text + '」shown=' + skill.shown + ' · 粒子 ' + skill.parts + ' 个');
await shot('v7-4-skill.png');   // ④ 技能播报 + 粒子

// ⑤ 敌方黄巾兵 + Boss 张梁（先取消选中、等播报淡出，避免选中框/横幅遮挡）
await evalJs(`(async () => {
  const s = ZY.UI.getState();
  const empty = [...document.querySelectorAll('.cell.deploy')].find(c => { const r = +c.dataset.r, col = +c.dataset.c; return !s.grid[r][col]; });
  if (empty) {
    const r = empty.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const mk = (t, xx, yy) => new PointerEvent(t, { clientX: xx, clientY: yy, bubbles: true, cancelable: true, pointerId: 3, pointerType: 'touch', isPrimary: true });
    empty.dispatchEvent(mk('pointerdown', x, y));
    await new Promise(r2 => setTimeout(r2, 50));
    window.dispatchEvent(mk('pointerup', x, y));
  }
  await new Promise(r2 => setTimeout(r2, 1800));
})()`);
const foes = await evalJs(`(() => {
  const s = ZY.UI.getState();
  const z = ZY.Game.makeUnit(s, 'enemy', { cls:'soldier', type:'zei', level:1, row:5, col:5, target:'player' });
  z.move = 0; ZY.Game.addUnit(s, z);
  const b = ZY.Game.makeUnit(s, 'enemy', { cls:'soldier', type:'zei', boss:true, level:1, row:7, col:4, target:'player' });
  b.move = 0; ZY.Game.addUnit(s, b);
  return { z: z.id, b: b.id };
})()`);
await sleep(420);
const e5 = await evalJs(`(() => {
  const z = document.querySelector('.unit.e[data-uid="${foes.z}"]');
  const b = document.querySelector('.unit.e[data-uid="${foes.b}"]');
  return { zSrc: z && z.querySelector('.fig-img').getAttribute('src'),
           bSrc: b && b.querySelector('.fig-img').getAttribute('src'),
           bCls: b ? b.className : '', flipped: z ? getComputedStyle(z.querySelector('.fig-wrap')).transform : 'none' };
})()`);
console.log('   ⑤ 黄巾=' + e5.zSrc + ' · Boss=' + e5.bSrc + ' · Boss类=' + e5.bCls + ' · 敌方镜像=' + e5.flipped);
await shot('v7-5-enemy-boss.png');   // ⑤ 敌方黄巾 + Boss

ws.close(); proc.kill();
console.log('V7 美术复核截图完成 → ' + OUT);
process.exit(0);
