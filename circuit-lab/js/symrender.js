/**
 * symrender.js — 原理图渲染
 *
 * 与 render.js 的分工：
 *   render.js 画 2.5D 实验台（等距投影），本文件画原理图（正交直角坐标）。
 *   两者坐标系完全独立：实验台用「孔位网格」，原理图用「布局逻辑格」，
 *   同一元件在两边的坐标分别由 model（comp.x/comp.y）与 layout 表管理。
 *
 * 布线策略：
 *   原理图画的是「电气连接」而不是「每根导线」。所以按网表（net）分组：
 *   一个 net 里所有有原理图位置的元件端子之间连线。
 *     - 2 端：同水平/同垂直走直线，否则走 Z 形（水平-垂直-水平）；
 *     - ≥3 端：立一条垂直主干，每个端子用一段水平支线接入主干。
 *   这比逐 wire 画更贴近原理图习惯，也避免多端时多条折线互相压叠。
 *   每条线段仍归属到该 net 的第一条 wire（wireId），使拾取可落到具体导线。
 *
 * 性能：与 render.js 同套路——dirty 由调用方的 requestRender 做 rAF 去重，
 * 每帧只做一次 clearRect + 全量重绘（原理图元素量级远小于 900 个孔位）。
 */

import { getSymbol, symSize, pinByName, symbolLabel, drawSymbol } from './symparts.js';

/** 原理图布局逻辑区宽度（列）；与 schematic.js 的自动排布共用 */
export const SCHEM_LAYOUT_W = 40;

/** 原理图配色：浅色图纸，刻意区别于实验台的深色面板 */
export const SCHEM_COLORS = {
  paper: '#f8f5ec',
  paperEdge: '#e3dccb',
  grid: 'rgba(96, 106, 128, 0.16)',
  gridMajor: 'rgba(96, 106, 128, 0.26)',
  ink: '#232830',
  muted: '#5f6779',
  wire: '#2f5d7c',
  wireHover: '#3f88b0',
  wireSelect: '#c9761b',
  select: '#e2851f',
  selectGlow: 'rgba(226, 133, 31, 0.14)',
  label: '#414a5c',
  pin: '#6b7385',
};

/** 画布内边距（像素） */
const PAD = 18;

/* ==========================================================================
   视图与坐标
   ========================================================================== */

/** 创建原理图视图对象 */
export function createSymView(canvas) {
  return {
    canvas,
    ctx: canvas ? canvas.getContext('2d') : null,
    dpr: 1,
    width: 0,
    height: 0,
    cell: 16,
    originX: PAD,
    originY: PAD,
    cols: 0,
    rows: 0,
    visible: false,
  };
}

/**
 * 计算 cell 与原点：让「布局区宽 × 内容行数」刚好落在画布内。
 * @param {number} contentRows 布局实际占用的行数（逻辑格），最小按 10 算
 * @returns {boolean} 几何是否变化
 */
export function layoutSymView(view, cssWidth, cssHeight, contentRows, contentCols) {
  if (!view) return false;
  const rows = Math.max(Number(contentRows) || 0, 8);
  // 列数按内容自适应：元件少时不留大片空白，元件多时最多铺满整个布局区
  const cols = Math.min(
    SCHEM_LAYOUT_W,
    Math.max(Number(contentCols) || 0, 14),
  );
  const availW = Math.max(60, cssWidth - PAD * 2);
  const availH = Math.max(60, cssHeight - PAD * 2);

  const byWidth = availW / (cols + 1.5);
  const byHeight = availH / (rows + 1.5);
  const cell = Math.max(6, Math.min(byWidth, byHeight, 26));

  const originX = PAD + Math.max(0, (availW - cols * cell) / 2);
  const originY = PAD + Math.max(0, (availH - rows * cell) / 2);

  const changed = Math.abs(view.cell - cell) > 0.01
    || Math.abs(view.originX - originX) > 0.01
    || Math.abs(view.originY - originY) > 0.01
    || view.width !== cssWidth
    || view.height !== cssHeight;

  view.width = cssWidth;
  view.height = cssHeight;
  view.cell = cell;
  view.originX = originX;
  view.originY = originY;
  view.cols = cols;
  view.rows = rows;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  view.dpr = dpr;
  const targetW = Math.max(1, Math.round(cssWidth * dpr));
  const targetH = Math.max(1, Math.round(cssHeight * dpr));
  if (view.canvas && (view.canvas.width !== targetW || view.canvas.height !== targetH)) {
    view.canvas.width = targetW;
    view.canvas.height = targetH;
  }

  return changed;
}

/** 逻辑格 → 屏幕 */
export function symProject(view, gx, gy) {
  return { x: view.originX + gx * view.cell, y: view.originY + gy * view.cell };
}

/** 屏幕 → 逻辑格（浮点） */
export function symUnproject(view, sx, sy) {
  return {
    gx: (sx - view.originX) / view.cell,
    gy: (sy - view.originY) / view.cell,
  };
}

/** 符号左上角的屏幕坐标 */
export function symbolScreenPos(view, entry) {
  return symProject(view, entry.sx, entry.sy);
}

/** 符号外接矩形的屏幕坐标 */
export function symbolScreenRect(view, comp, entry) {
  const size = symSize(comp.type, comp.rotation || 0);
  const at = symProject(view, entry.sx, entry.sy);
  return { x: at.x, y: at.y, w: size.w * view.cell, h: size.h * view.cell };
}

/* ==========================================================================
   连线构建（纯函数，供 schematic 与探针共用）
   ========================================================================== */

/** 元件某端子在该元件原理图占位中的绝对逻辑坐标 */
function terminalAbsolute(comp, entry, terminalName) {
  const pin = pinByName(comp.type, terminalName, comp.rotation || 0);
  if (!pin) return null;
  return {
    componentId: comp.id,
    terminal: terminalName,
    role: pin.role,
    side: pin.side,
    x: entry.sx + pin.x,
    y: entry.sy + pin.y,
  };
}

/** 同水平/同垂直走直线，否则走 Z 形（水平 → 垂直 → 水平） */
function orthoRoute(a, b) {
  const EPS = 0.02;
  if (Math.abs(a.y - b.y) < EPS || Math.abs(a.x - b.x) < EPS) {
    return [[{ x: a.x, y: a.y }, { x: b.x, y: b.y }]];
  }
  const mx = (a.x + b.x) / 2;
  return [[
    { x: a.x, y: a.y },
    { x: mx, y: a.y },
    { x: mx, y: b.y },
    { x: b.x, y: b.y },
  ]];
}

/** ≥3 端：立垂直主干 + 每个端子一段水平支线 */
function trunkRoute(terms) {
  const xs = terms.map((t) => t.x).sort((p, q) => p - q);
  const trunkX = xs[Math.floor(xs.length / 2)];
  const ys = terms.map((t) => t.y);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);

  const branches = [];
  if (yMax - yMin > 0.02) {
    branches.push([{ x: trunkX, y: yMin }, { x: trunkX, y: yMax }]);
  }
  terms.forEach((term) => {
    if (Math.abs(term.x - trunkX) < 0.02) return;
    branches.push([{ x: term.x, y: term.y }, { x: trunkX, y: term.y }]);
  });
  if (branches.length === 0) {
    // 所有端子都在主干上且同一点，退化成一个点，不画
    return [];
  }
  return branches;
}

/**
 * 按网表构建原理图连接。
 * @param {object} circuit model.getState()
 * @param {Map} layout componentId → { sx, sy }
 * @param {object} netlist { nets: Map<netId, members[]> }，members 元素形如 { componentId, terminal } 或 { node }
 * @returns {Array} [{ netId, wireId, segments, terms }]
 */
export function computeLinks(circuit, layout, netlist) {
  const links = [];
  if (!circuit || !layout || !netlist || !netlist.nets) return links;

  const compById = new Map();
  circuit.components.forEach((comp) => compById.set(comp.id, comp));

  // 每根导线 → 它两端所在的 net，用于给 net 归属一个 wireId
  const wireByNet = new Map();
  circuit.wires.forEach((wire) => {
    const keyA = wire.a.componentId
      ? `c:${wire.a.componentId}:${wire.a.terminal}`
      : `n:${wire.a.node}`;
    const netId = netlist.netOf.get(keyA);
    if (netId && !wireByNet.has(netId)) wireByNet.set(netId, wire.id);
  });

  netlist.nets.forEach((members, netId) => {
    const terms = [];
    members.forEach((member) => {
      if (!member || !member.componentId) return;
      const comp = compById.get(member.componentId);
      if (!comp) return;
      const entry = layout.get(member.componentId);
      if (!entry) return;
      const abs = terminalAbsolute(comp, entry, member.terminal);
      if (abs) terms.push(abs);
    });
    if (terms.length < 2) return;

    // 同一元件同一位置可能出现重复端子（数据异常兜底）
    const unique = [];
    const seen = new Set();
    terms.forEach((term) => {
      const key = `${term.componentId}:${term.terminal}`;
      if (seen.has(key)) return;
      seen.add(key);
      unique.push(term);
    });
    if (unique.length < 2) return;

    const segments = unique.length === 2
      ? orthoRoute(unique[0], unique[1])
      : trunkRoute(unique);

    if (segments.length === 0) return;
    links.push({
      netId,
      wireId: wireByNet.get(netId) || null,
      segments,
      terms: unique,
    });
  });

  // 按端子数降序，让"多端主干"先画，单段直线后画压在上面，视觉更清楚
  links.sort((a, b) => b.terms.length - a.terms.length);
  return links;
}

/* ==========================================================================
   静态层缓存
   ========================================================================== */

/**
 * 纸色底 + 网格点 + 布局虚线框，三者只依赖几何参数（尺寸 / cell / 原点 / 行数）。
 * 拖拽时几何不变，所以缓存起来，每帧只做一次 1:1 drawImage，
 * 避免每帧重填整块画布（headless 软件渲染下这一步曾占掉一半帧时间）。
 */
let gridLayer = null;
let gridLayerKey = '';

function gridLayerKeyOf(view, rows, cols) {
  return [
    view.canvas ? view.canvas.width : 0,
    view.canvas ? view.canvas.height : 0,
    view.width,
    view.height,
    view.cell.toFixed(3),
    view.originX.toFixed(2),
    view.originY.toFixed(2),
    rows,
    cols,
  ].join('|');
}

/** 网格层：纸色铺底 + 点阵 + 布局参考虚线框 */
function buildGridLayer(view, rows, cols) {
  const layer = document.createElement('canvas');
  layer.width = Math.max(1, view.canvas ? view.canvas.width : 1);
  layer.height = Math.max(1, view.canvas ? view.canvas.height : 1);
  const g = layer.getContext('2d');
  if (!g) return layer;

  g.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  g.fillStyle = SCHEM_COLORS.paper;
  g.fillRect(0, 0, view.width, view.height);

  const step = view.cell * 2;
  const startX = view.originX - Math.ceil(view.originX / step) * step;
  const startY = view.originY - Math.ceil(view.originY / step) * step;
  g.fillStyle = SCHEM_COLORS.grid;
  for (let x = startX; x < view.width; x += step) {
    if (x < 0) continue;
    for (let y = startY; y < view.height; y += step) {
      if (y < 0) continue;
      g.fillRect(x, y, 1.2, 1.2);
    }
  }

  if (rows > 0) {
    const a = symProject(view, 0, 0);
    const b = symProject(view, cols, rows);
    g.save();
    g.strokeStyle = SCHEM_COLORS.paperEdge;
    g.lineWidth = 1;
    g.setLineDash([4, 6]);
    g.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    g.restore();
  }

  return layer;
}

function ensureGridLayer(view, rows, cols) {
  const key = gridLayerKeyOf(view, rows, cols);
  if (gridLayer && gridLayerKey === key) return gridLayer;
  gridLayer = buildGridLayer(view, rows, cols);
  gridLayerKey = key;
  return gridLayer;
}

/** 丢弃静态层缓存（销毁视图时调用） */
export function invalidateSchematicLayer() {
  gridLayer = null;
  gridLayerKey = '';
}

/* ==========================================================================
   绘制
   ========================================================================== */

/** 连线 */
function drawLinks(ctx, view, scene) {
  const links = scene.links || [];
  const sel = scene.selection;
  const hover = scene.hover;

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  links.forEach((link) => {
    const isSelected = Boolean(sel && sel.type === 'wire' && sel.id === link.wireId);
    const isHover = Boolean(hover && hover.type === 'wire' && hover.wireId === link.wireId);

    let color = SCHEM_COLORS.wire;
    let width = 2;
    if (isSelected) {
      color = SCHEM_COLORS.wireSelect;
      width = 2.6;
    } else if (isHover) {
      color = SCHEM_COLORS.wireHover;
      width = 2.4;
    }

    link.segments.forEach((segment) => {
      const points = segment.map((pt) => symProject(view, pt.x, pt.y));
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.stroke();
    });

    // 连接点：每个端子画一个小实心圆，表示电气接点
    if (view.cell >= 9) {
      link.terms.forEach((term) => {
        const at = symProject(view, term.x, term.y);
        ctx.beginPath();
        ctx.arc(at.x, at.y, Math.max(1.8, view.cell * 0.11), 0, Math.PI * 2);
        ctx.fillStyle = isSelected ? SCHEM_COLORS.wireSelect : color;
        ctx.fill();
      });
    }
  });
}

/** 符号与标签 */
function drawSymbols(ctx, view, scene) {
  const circuit = scene.circuit;
  const layout = scene.layout;
  if (!circuit || !layout) return;

  const color = {
    ink: SCHEM_COLORS.ink,
    muted: SCHEM_COLORS.muted,
  };
  const labelSize = Math.max(9, Math.min(13, view.cell * 0.56));

  circuit.components.forEach((comp) => {
    const entry = layout.get(comp.id);
    if (!entry) return;
    const at = symProject(view, entry.sx, entry.sy);

    drawSymbol(ctx, comp, {
      x: at.x,
      y: at.y,
      cell: view.cell,
      rotation: comp.rotation || 0,
      color,
    });

    // 标签：符号下方居中
    const size = symSize(comp.type, comp.rotation || 0);
    const text = symbolLabel(comp);
    ctx.font = `${labelSize}px "Cascadia Mono", Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = SCHEM_COLORS.label;
    ctx.fillText(text, at.x + size.w * view.cell / 2, at.y + size.h * view.cell + Math.max(3, view.cell * 0.22));
  });
}

/** 选中高亮：橙色外框 + 淡底（两视图沿用同一个选中色） */
function drawSelectionBox(ctx, view, scene) {
  const sel = scene.selection;
  if (!sel || sel.type !== 'component') return;
  const layout = scene.layout;
  const comp = scene.circuit
    ? scene.circuit.components.find((item) => item.id === sel.id)
    : null;
  if (!comp || !layout) return;
  const entry = layout.get(comp.id);
  if (!entry) return;

  const rect = symbolScreenRect(view, comp, entry);
  const pad = Math.max(4, view.cell * 0.35);

  ctx.save();
  ctx.beginPath();
  ctx.roundRect
    ? ctx.roundRect(rect.x - pad, rect.y - pad, rect.w + pad * 2, rect.h + pad * 2, 5)
    : ctx.rect(rect.x - pad, rect.y - pad, rect.w + pad * 2, rect.h + pad * 2);
  ctx.fillStyle = SCHEM_COLORS.selectGlow;
  ctx.fill();
  ctx.strokeStyle = SCHEM_COLORS.select;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

/** 连线橡皮筋：从起点引脚到指针 */
function drawPendingWire(ctx, view, scene) {
  const wiring = scene.wiring;
  if (!wiring || !wiring.from || !scene.pointer) return;
  const comp = scene.circuit
    ? scene.circuit.components.find((item) => item.id === wiring.from.componentId)
    : null;
  const entry = comp && scene.layout ? scene.layout.get(comp.id) : null;
  if (!comp || !entry) return;

  const abs = terminalAbsolute(comp, entry, wiring.from.terminal);
  if (!abs) return;
  const from = symProject(view, abs.x, abs.y);
  const to = scene.pointer;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.strokeStyle = SCHEM_COLORS.select;
  ctx.lineWidth = 1.8;
  ctx.setLineDash([6, 4]);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.beginPath();
  ctx.arc(from.x, from.y, Math.max(3.5, view.cell * 0.2), 0, Math.PI * 2);
  ctx.fillStyle = SCHEM_COLORS.select;
  ctx.fill();
  ctx.restore();
}

/** 引脚热区：仅悬停时提示，让"哪里可以连线"可见 */
function drawPinHover(ctx, view, scene) {
  const hover = scene.hover;
  if (!hover || hover.type !== 'terminal') return;
  const comp = scene.circuit
    ? scene.circuit.components.find((item) => item.id === hover.componentId)
    : null;
  const entry = comp && scene.layout ? scene.layout.get(comp.id) : null;
  if (!comp || !entry) return;
  const abs = terminalAbsolute(comp, entry, hover.terminal);
  if (!abs) return;
  const at = symProject(view, abs.x, abs.y);
  ctx.beginPath();
  ctx.arc(at.x, at.y, Math.max(4, view.cell * 0.28), 0, Math.PI * 2);
  ctx.strokeStyle = SCHEM_COLORS.select;
  ctx.lineWidth = 1.6;
  ctx.stroke();
}

/** 空电路提示 */
function drawEmptyHint(ctx, view, scene) {
  if (!scene.circuit || scene.circuit.components.length > 0) return;
  ctx.save();
  ctx.font = `${Math.max(11, Math.min(14, view.cell * 0.75))}px "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = SCHEM_COLORS.muted;
  ctx.fillText('电路还是空的', view.width / 2, view.height / 2 - 10);
  ctx.font = `${Math.max(10, Math.min(12, view.cell * 0.62))}px "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif`;
  ctx.fillStyle = SCHEM_COLORS.pin;
  ctx.fillText('回到实验台放置元件，这里会同步显示原理图', view.width / 2, view.height / 2 + 14);
  ctx.restore();
}

/**
 * 主绘制入口。
 * @param {object} view createSymView 的返回值
 * @param {object} scene { circuit, layout, links, selection, hover, wiring, pointer, contentRows }
 */
export function renderSchematic(view, scene) {
  const ctx = view.ctx;
  if (!ctx || !view.canvas) return;

  // 静态层：纸色 + 网格 + 布局框，1:1 原样贴回（不缩放，避免额外重采样）
  const hasLayout = Boolean(scene.layout && scene.layout.size > 0);
  const rows = hasLayout ? (scene.contentRows || 0) : 0;
  const cols = hasLayout ? (scene.contentCols || 0) : 0;
  const layer = ensureGridLayer(view, rows, cols);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, view.canvas.width, view.canvas.height);
  ctx.drawImage(layer, 0, 0);

  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  drawLinks(ctx, view, scene);
  drawSymbols(ctx, view, scene);
  drawPinHover(ctx, view, scene);
  drawSelectionBox(ctx, view, scene);
  drawPendingWire(ctx, view, scene);
  drawEmptyHint(ctx, view, scene);
}

/* ==========================================================================
   拾取
   ========================================================================== */

/** 点到线段距离 */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * 屏幕坐标拾取。优先级：引脚 > 符号本体 > 连线（与实验台的「端子 > 元件 > 导线」一致）。
 * @returns {{type:'terminal',componentId,terminal,x,y}
 *          |{type:'component',componentId}
 *          |{type:'wire',wireId,netId}
 *          |null}
 */
export function pickSchematic(view, scene, sx, sy) {
  const circuit = scene.circuit;
  const layout = scene.layout;
  if (!circuit || !layout) return null;

  // 1. 引脚（连线用，热区比符号本体重叠判定更优先）
  const pinRadius = Math.max(7, view.cell * 0.42);
  let bestPin = null;
  let bestPinDistance = pinRadius;
  circuit.components.forEach((comp) => {
    const entry = layout.get(comp.id);
    if (!entry) return;
    const pins = getSymbol(comp.type);
    if (!pins) return;
    pins.pins.forEach((pin) => {
      const abs = terminalAbsolute(comp, entry, pin.name);
      if (!abs) return;
      const at = symProject(view, abs.x, abs.y);
      const distance = Math.hypot(at.x - sx, at.y - sy);
      if (distance < bestPinDistance) {
        bestPinDistance = distance;
        bestPin = {
          type: 'terminal',
          componentId: comp.id,
          terminal: pin.name,
          x: at.x,
          y: at.y,
        };
      }
    });
  });
  if (bestPin) return bestPin;

  // 2. 符号本体（后画的在上面，倒序命中）
  const point = symUnproject(view, sx, sy);
  for (let i = circuit.components.length - 1; i >= 0; i -= 1) {
    const comp = circuit.components[i];
    const entry = layout.get(comp.id);
    if (!entry) continue;
    const size = symSize(comp.type, comp.rotation || 0);
    if (
      point.gx >= entry.sx && point.gx <= entry.sx + size.w
      && point.gy >= entry.sy && point.gy <= entry.sy + size.h
    ) {
      return { type: 'component', componentId: comp.id };
    }
  }

  // 3. 连线
  const links = scene.links || [];
  const threshold = Math.max(5, view.cell * 0.3);
  let bestLink = null;
  let bestDistance = threshold;
  links.forEach((link) => {
    link.segments.forEach((segment) => {
      for (let i = 0; i < segment.length - 1; i += 1) {
        const a = symProject(view, segment[i].x, segment[i].y);
        const b = symProject(view, segment[i + 1].x, segment[i + 1].y);
        const distance = distanceToSegment(sx, sy, a.x, a.y, b.x, b.y);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestLink = { type: 'wire', wireId: link.wireId, netId: link.netId };
        }
      }
    });
  });
  return bestLink;
}

/** 导出几何工具给 schematic 复用 */
export const symGeometry = { distanceToSegment, orthoRoute, trunkRoute };
