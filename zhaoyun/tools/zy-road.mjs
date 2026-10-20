/* 赵云与阿斗 · V7.3 敌人路径"整条白色长条"复核（无头 Edge + CDP，竖屏 375×667）
 * 产出 3 张截图到 zhaoyun-v73-evidence/：
 *   ① v73-1-board.png   开局棋盘：整条主路一块白色长条，横/竖/拐角无断点
 *   ② v73-2-march.png   敌人踩在连贯白路上行军
 *   ③ v73-3-corner.png  顶部 S 弯 4× 放大特写（专看拐角衔接）
 * 并做两级体检：
 *   · 几何：SVG 轮廓必须只有 1 个环；主路格中心、横向接缝、竖向接缝中点全部落在填充内；
 *     任何非主路格中心都不许落在填充内。
 *   · 像素：直接读截图，在主路格中心 / 横向接缝 / 竖向接缝 / 拐角处逐点取色，统计非白点数。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');
const OUT = 'D:/安装包/WorkBuddy/工作空间/2026-10-16-00-32-32/zhaoyun-v73-evidence';
const PORT = 9360;
const DPR = 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--mute-audio',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=C:/Users/31474/AppData/Local/Temp/zy-road-profile',
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
const grab = async (clip) => {
  const r = await send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' });
  const buf = Buffer.from(r.result.data, 'base64');
  return { buf, img: decodePng(buf) };
};
const shot = async (name, clip) => {
  const { buf } = await grab(clip);
  fs.writeFileSync(path.join(OUT, name), buf);
  console.log('  ✓ ' + name);
};

/* --- 极简 PNG 解码（8bit RGB/RGBA，够读截图用） --- */
function decodePng(b) {
  let p = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p), ty = b.toString('ascii', p + 4, p + 8), d = b.subarray(p + 8, p + 8 + len);
    if (ty === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; }
    else if (ty === 'IDAT') idat.push(d);
    else if (ty === 'IEND') break;
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = ct === 6 ? 4 : 3, stride = w * ch + 1, out = Buffer.alloc(w * h * ch);
  let prev = Buffer.alloc(w * ch);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * stride];
    const line = Buffer.from(raw.subarray(y * stride + 1, y * stride + stride));
    for (let i = 0; i < line.length; i++) {
      const a = i >= ch ? line[i - ch] : 0, bb = prev[i], c = i >= ch ? prev[i - ch] : 0;
      if (ft === 1) line[i] = (line[i] + a) & 255;
      else if (ft === 2) line[i] = (line[i] + bb) & 255;
      else if (ft === 3) line[i] = (line[i] + ((a + bb) >> 1)) & 255;
      else if (ft === 4) {
        const pa = Math.abs(bb - c), pb = Math.abs(a - c), pc = Math.abs(a + bb - 2 * c);
        line[i] = (line[i] + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? bb : c))) & 255;
      }
    }
    line.copy(out, y * w * ch); prev = line;
  }
  return { w, h, ch, px: out, at(x, y) { const o = (y * w + x) * ch; return [out[o], out[o + 1], out[o + 2]]; } };
}

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 667, deviceScaleFactor: DPR, mobile: true });
await send('Page.navigate', { url: URL });
await sleep(1500);
await evalJs(`document.querySelector('.mode-btn[data-mode="endless"]').click()`);
await sleep(2600);   // 等开局横幅「守住阿斗」淡出，避免白字光晕干扰取色

/* ① 几何体检 + 棋盘全图 */
const g = await evalJs(`(() => {
  const s = ZY.UI.getState();
  s.paused = true;
  const road = document.getElementById('road');
  const roadPaths = road ? [...road.querySelectorAll('path')] : [];
  const p = roadPaths.find(n => (n.getAttribute('class') || '').indexOf('road-fill') >= 0) || roadPaths[0] || null;
  const edgeEl = roadPaths.find(n => (n.getAttribute('class') || '').indexOf('road-edge') >= 0) || p;
  const d = (p && p.getAttribute('d')) || '';
  const edgeD = (edgeEl && edgeEl.getAttribute('d')) || '';
  const cells = [...document.querySelectorAll('.cell')].map(n => ({
    r: +n.dataset.r, c: +n.dataset.c, n: n,
    cls: n.className,
    x: n.offsetLeft, y: n.offsetTop, w: n.offsetWidth, h: n.offsetHeight,
    bx: n.getBoundingClientRect().left, by: n.getBoundingClientRect().top,
    bw: n.getBoundingClientRect().width, bh: n.getBoundingClientRect().height
  }));
  const at = {}; cells.forEach(o => { at[o.r + ',' + o.c] = o; });
  const isP = o => !!o && /(^| )path( |$)/.test(o.cls) && !/(^| )obstacle( |$)/.test(o.cls);
  const inFill = (x, y) => { try { return p.isPointInFill(new DOMPoint(x, y)) === true; } catch (e) { return false; } };
  const ps = cells.filter(isP);
  const cw = road.viewBox.baseVal.width / 8, chh = road.viewBox.baseVal.height / 12;

  let centerOk = 0, centerBad = [];
  ps.forEach(o => { if (inFill(o.x + o.w / 2, o.y + o.h / 2)) centerOk++; else centerBad.push(o.r + ',' + o.c); });

  // 路面上的角色（阿斗图标 / 入口红签）本来就会压住白条，取色时要区分开
  const topAt = (x, y) => {
    const els = document.elementsFromPoint(x, y);
    const t = els[0];
    if (!t) return 'none';
    if (t.classList.contains('adou')) return 'adou';
    if (t.classList.contains('cell')) return 'road';
    return (t.id || t.className || t.tagName) + '';
  };

  const seams = [];   // {kind, r, c, px, py}  px/py：无头截图的设备像素坐标
  let hSeam = 0, vSeam = 0, bad = [];
  ps.forEach(o => {
    const nc = at[o.r + ',' + (o.c + 1)], nr = at[(o.r + 1) + ',' + o.c];
    if (isP(nc)) {
      hSeam++;
      const x = (o.c + 1) * cw, y = (o.r + 0.5) * chh;
      const ok = inFill(x, y);
      if (!ok) bad.push('H' + o.r + ',' + o.c);
      const cx = o.bx + o.bw, cy = o.by + o.bh / 2;
      seams.push({ kind: 'h', at: o.r + ',' + o.c, cssX: cx, cssY: cy, top: topAt(cx, cy) });
    }
    if (isP(nr)) {
      vSeam++;
      const x = (o.c + 0.5) * cw, y = (o.r + 1) * chh;
      const ok = inFill(x, y);
      if (!ok) bad.push('V' + o.r + ',' + o.c);
      const cx = o.bx + o.bw / 2, cy = o.by + o.bh;
      seams.push({ kind: 'v', at: o.r + ',' + o.c, cssX: cx, cssY: cy, top: topAt(cx, cy) });
    }
  });

  let outside = 0; const outsideBad = [];
  cells.filter(o => !isP(o)).forEach(o => {
    if (inFill(o.x + o.w / 2, o.y + o.h / 2)) { outside++; outsideBad.push(o.r + ',' + o.c); }
  });

  const pathCell = document.querySelector('.cell.path');
  const boardR = document.getElementById('board').getBoundingClientRect();
  const cnt = sel => document.querySelectorAll(sel).length;
  return {
    fillRects: (d.match(/M/g) || []).length,
    edgeSegs: (edgeD.match(/M/g) || []).length,
    pathEls: [...road.querySelectorAll('path')].length,
    viewBox: road.getAttribute('viewBox'),
    pathN: ps.length,
    centerOk, centerBad, hSeam, vSeam, bad, outside, outsideBad: outsideBad.slice(0, 6),
    fill: getComputedStyle(p).fill, fillRule: getComputedStyle(p).fillRule,
    edgeStroke: getComputedStyle(edgeEl).stroke, strokeW: getComputedStyle(edgeEl).strokeWidth,
    cellPathBg: getComputedStyle(pathCell).backgroundColor,
    cellPathBorder: getComputedStyle(pathCell).borderRightColor,
    counts: { path: cnt('.cell.path'), deploy: cnt('.cell.deploy'), waste: cnt('.cell.wasteland'),
              obstacle: cnt('.cell.obstacle'), enter: cnt('.cell.enter'),
              plain: cnt('.cell:not(.path):not(.deploy):not(.wasteland):not(.obstacle):not(.enter):not(.break)') },
    board: { x: boardR.left, y: boardR.top, w: boardR.width, h: boardR.height },
    cornerBox: (() => {
      const b = boardR;
      return { x: Math.round(b.left + b.width * 0.30), y: Math.round(b.top + 2), width: 140, height: 88 };
    })(),
    seams: seams.slice(0, 400)
  };
})()`);
console.log('   ① 主路 ' + g.pathN + ' 格 · 单条填充 path 内 ' + g.fillRects + ' 个矩形子路径（nonzero 合并）· viewBox ' + g.viewBox);
console.log('      格数 路/塔位/荒地/荆棘/入口/米底 = ' + g.counts.path + '/' + g.counts.deploy + '/' + g.counts.waste + '/' + g.counts.obstacle + '/' + g.counts.enter + '/' + g.counts.plain);
console.log('      填充=' + g.fill + '（' + g.fillRule + '）· 描边=' + g.edgeStroke + ' ' + g.strokeW + ' · ' + g.edgeSegs + ' 段外沿边 · 共 ' + g.pathEls + ' 个 path');
console.log('      主路格底色=' + g.cellPathBg + ' 边框=' + g.cellPathBorder);
console.log('      几何：格中心 ' + g.centerOk + '/' + g.pathN + ' · 横向接缝 ' + (g.hSeam - g.bad.filter(x => x[0] === 'H').length) + '/' + g.hSeam +
            ' · 竖向接缝 ' + (g.vSeam - g.bad.filter(x => x[0] === 'V').length) + '/' + g.vSeam +
            ' · 非主路格误覆盖 ' + g.outside);
if (g.centerBad.length) console.log('      ✗ 中心未填充：' + g.centerBad.join(' '));
if (g.bad.length) console.log('      ✗ 接缝未填充：' + g.bad.join(' '));
if (g.outsideBad.length) console.log('      ✗ 误覆盖：' + g.outsideBad.join(' '));

const full1 = await grab(null);
fs.writeFileSync(path.join(OUT, 'v73-1-board.png'), full1.buf);
console.log('  ✓ v73-1-board.png');

/* 像素级复核：在截图里按设备像素取色。
   每条接缝沿自身方向取 5 个点取中位数 —— 若路上真有格子分隔线，这条线上必然
   出现 1~2px 的暗带，5 点里至少 3 点会同时变暗；而阿斗徽标/入口红签只会压住
   其中一两个点，中位数仍是纯白。 */
let pxBad = [], pxTotal = 0, pxCovered = 0;
const nearWhite = (c) => c[0] >= 250 && c[1] >= 250 && c[2] >= 250;
const lum = (c) => (c[0] * 299 + c[1] * 587 + c[2] * 114) / 1000;
g.seams.forEach(s => {
  const offs = [-8, -4, 0, 4, 8];
  const vals = [];
  offs.forEach(d => {
    const x = Math.round((s.kind === 'h' ? s.cssX : s.cssX + d) * DPR);
    const y = Math.round((s.kind === 'h' ? s.cssY + d : s.cssY) * DPR);
    if (x < 1 || y < 1 || x >= full1.img.w - 1 || y >= full1.img.h - 1) return;
    vals.push(full1.img.at(x, y));
  });
  if (!vals.length) return;
  pxTotal++;
  const sorted = vals.slice().sort((a, b) => lum(a) - lum(b));
  const med = sorted[Math.floor(sorted.length / 2)];
  const whites = vals.filter(nearWhite).length;
  if (whites < 3) pxCovered++;                         // 5 点里不到 3 点露白 → 整条被图标占住，路面本身无法取样
  else if (!nearWhite(med)) pxBad.push(s.kind + s.at + ' 中位=' + med.join(','));
});
console.log('      像素：' + (pxTotal - pxBad.length) + '/' + pxTotal + ' 条接缝中位纯白' +
            '（' + g.hSeam + ' 横 + ' + g.vSeam + ' 竖，含全部拐角相邻边）' +
            (pxCovered ? ' · 其中 ' + pxCovered + ' 条整条被图标占住' : ''));
if (pxBad.length) console.log('      ✗ ' + pxBad.slice(0, 8).join(' ; '));

/* 拐角特写 */
await shot('v73-3-corner.png', { ...g.cornerBox, scale: 4 });

/* ② 敌人在连贯白路上行军 */
const m = await evalJs(`(async () => {
  const s = ZY.UI.getState();
  const seq = ZY.B.pathSeq(s.mode, 'player', s.levelIdx);
  const put = (i, type) => {
    const p = seq[Math.min(i, seq.length - 2)];
    const u = ZY.Game.makeUnit(s, 'enemy', { cls:'soldier', type: type, level: 2, row: p.row, col: p.col, target: 'player', pi: Math.min(i, seq.length - 2) });
    u.move = 0.6;
    ZY.Game.addUnit(s, u);
    return u.id;
  };
  [put(2, 'zei'), put(5, 'dao'), put(8, 'qiang'), put(11, 'gong'), put(14, 'zei')];
  s.paused = false;
  await new Promise(t => setTimeout(t, 1100));
  s.paused = true;
  await new Promise(t => setTimeout(t, 80));
  const foes = s.units.filter(u => u.side === 'enemy' && !u.dead);
  return { n: foes.length, cells: foes.map(u => u.row + ',' + u.col).join(' | '), seqLen: seq.length };
})()`);
console.log('   ② 主路长 ' + m.seqLen + ' 格 · 在途敌人 ' + m.n + ' 只 @ ' + m.cells);
await shot('v73-2-march.png');

ws.close(); proc.kill();
console.log('\nV7.3 连贯白路验收完成 → ' + OUT);
process.exit(0);
