/**
 * schematic.js — 原理图控制器
 *
 * 三件事：
 *   1. 布局表：componentId → { sx, sy, rot }（原理图逻辑格），与 model 的
 *      comp.x / comp.y（孔位网格）完全分离。自动排布负责新元件落位，
 *      手动拖拽只改布局表、不改 model——所以「拖符号」不会移动实验台上的元件。
 *   2. 视图数据：把 model + layout + netlist 组装成渲染场景，rAF 去重后重绘。
 *   3. 联动：接受 board 的变更通知（refresh），把原理图操作转回 model API
 *      （addComponent / addWire / removeComponent），并复用 board 的选中态。
 *
 * 与实验台共享 selection：两视图读同一个 board.scene.selection，所以
 * 「双向选中」不需要额外同步代码，键盘（Delete / Ctrl+Z）也天然只有一套。
 */

import * as model from './model.js';
import * as platforms from './platforms.js';
import { getPart, footprintOf } from './parts.js';
import { symSize } from './symparts.js';
import {
  createSymView,
  layoutSymView,
  renderSchematic,
  computeLinks,
  pickSchematic,
  symProject,
  symUnproject,
  symbolScreenRect,
  invalidateSchematicLayer,
  SCHEM_LAYOUT_W,
} from './symrender.js';

/** 自动排布：符号之间的最小间隔（逻辑格） */
const GAP = 4;

/** 自动排布：每行固定行高（逻辑格），须容纳最高的 ic74xx（8 格）+ 标签 */
const SLOT_H = 10;

/** 自动排布：行数上限（防止异常数据把扫描拖死） */
const MAX_ROWS = 60;

/** 拖拽判定阈值（像素） */
const DRAG_THRESHOLD = 4;

/** 模块级单例（同一时刻只有一个原理图视图） */
let schematic = null;

/* ==========================================================================
   布局表
   ========================================================================== */

/** 两个逻辑矩形是否相交（含间距） */
function boxOverlap(a, b, gap) {
  return a.x < b.x + b.w + gap
    && b.x < a.x + a.w + gap
    && a.y < b.y + b.h + gap
    && b.y < a.y + a.h + gap;
}

/** 当前布局中各符号占用的矩形（含标签预留空间） */
function occupiedBoxes(layout) {
  const state = model.getState();
  if (!state) return [];
  const boxes = [];
  layout.forEach((entry, id) => {
    const comp = state.components.find((item) => item.id === id);
    if (!comp) return;
    const size = symSize(comp.type, comp.rotation || 0);
    boxes.push({ x: entry.sx, y: entry.sy, w: size.w, h: size.h + 1.6 });
  });
  return boxes;
}

/**
 * 为某类型找一个空位：逐行扫描，奇数行从右往左（蛇形），
 * 行内以 1 格为步长找第一个不与现有符号相交的落点。
 */
function findSlot(type, layout) {
  const size = symSize(type, 0);
  const boxes = occupiedBoxes(layout);

  for (let row = 0; row < MAX_ROWS; row += 1) {
    const y = row * SLOT_H;
    const reversed = row % 2 === 1;
    const maxX = SCHEM_LAYOUT_W - size.w;
    if (maxX < 0) return null;

    for (let step = 0; step <= maxX; step += 1) {
      const x = reversed ? maxX - step : step;
      const rect = { x, y, w: size.w, h: size.h };
      if (!boxes.some((box) => boxOverlap(rect, box, GAP))) {
        return { sx: x, sy: y };
      }
    }
  }
  return null;
}

/**
 * 同步布局表：
 *   移除已删除元件的条目；
 *   为新元件分配空位（保持已有位置不动，避免用户拖好的排版被打乱）。
 */
function syncLayout() {
  if (!schematic) return;
  const state = model.getState();
  if (!state) return;

  const alive = new Set(state.components.map((comp) => comp.id));
  Array.from(schematic.layout.keys()).forEach((id) => {
    if (!alive.has(id)) schematic.layout.delete(id);
  });

  state.components.forEach((comp) => {
    if (schematic.layout.has(comp.id)) {
      // 旋转跟随 model：布局表的 rot 是 model.rotation 的镜像
      const entry = schematic.layout.get(comp.id);
      entry.rot = comp.rotation || 0;
      return;
    }
    const slot = findSlot(comp.type, schematic.layout);
    schematic.layout.set(comp.id, {
      sx: slot ? slot.sx : 0,
      sy: slot ? slot.sy : 0,
      rot: comp.rotation || 0,
    });
  });
}

/**
 * 布局内容占用范围（逻辑格）。
 * 行数向上取整到槽位；列数用于让 cell 按实际内容自适应——固定按整个
 * 布局区宽度算会让只有两三个元件时符号小得看不清。
 */
function contentExtent() {
  if (!schematic) return { rows: SLOT_H, cols: 14 };
  const state = model.getState();
  if (!state || schematic.layout.size === 0) return { rows: SLOT_H, cols: 14 };

  let maxX = 0;
  let maxY = 0;
  schematic.layout.forEach((entry, id) => {
    const comp = state.components.find((item) => item.id === id);
    if (!comp) return;
    const size = symSize(comp.type, comp.rotation || 0);
    maxX = Math.max(maxX, entry.sx + size.w);
    maxY = Math.max(maxY, entry.sy + size.h + 1.6);
  });
  return {
    rows: Math.ceil(Math.max(maxY, 8) / SLOT_H) * SLOT_H,
    cols: Math.max(14, Math.min(SCHEM_LAYOUT_W, Math.ceil(maxX) + 2)),
  };
}

/* ==========================================================================
   渲染调度
   ========================================================================== */

/** 组装渲染场景（每帧现取，保证与 model / selection 同源） */
function currentScene() {
  return {
    circuit: model.getState(),
    layout: schematic.layout,
    links: schematic.links,
    selection: schematic.getSelection(),
    hover: schematic.hover,
    wiring: schematic.wiring,
    pointer: schematic.pointer,
    contentRows: schematic.rows,
    contentCols: schematic.cols,
  };
}

function requestRender() {
  if (!schematic || schematic.raf) return;
  schematic.raf = requestAnimationFrame(() => {
    schematic.raf = 0;
    if (!schematic || !schematic.view.visible) return;
    const start = performance.now();
    renderSchematic(schematic.view, currentScene());
    const duration = performance.now() - start;
    schematic.perf.frames.push(start);
    schematic.perf.durations.push(duration);
    if (schematic.perf.frames.length > 400) {
      schematic.perf.frames.shift();
      schematic.perf.durations.shift();
    }
    updateStatus();
  });
}

/** 重算 cell / origin（画布尺寸、内容行数变化时调用） */
function relayout() {
  if (!schematic) return false;
  const host = schematic.host;
  if (!host) return false;

  const rect = host.getBoundingClientRect();
  // 视图被隐藏（display:none）时尺寸为 0：不重绘，等切回来再算
  if (rect.width < 2 || rect.height < 2) {
    schematic.view.visible = false;
    return false;
  }

  schematic.view.visible = true;
  const extent = contentExtent();
  schematic.rows = extent.rows;
  schematic.cols = extent.cols;
  const changed = layoutSymView(
    schematic.view,
    Math.floor(rect.width),
    Math.floor(rect.height),
    extent.rows,
    extent.cols,
  );
  requestRender();
  return changed;
}

/** 重建网表与连线（任何 model 变更后调用） */
function rebuildLinks() {
  if (!schematic) return;
  const state = model.getState();
  schematic.netlist = model.getNetlist();
  schematic.links = computeLinks(state, schematic.layout, schematic.netlist);
}

/** 更新原理图状态栏（内容没变就不写 DOM，避免无谓的重排） */
function updateStatus() {
  if (!schematic || !schematic.statusHost) return;
  const state = model.getState();
  const host = schematic.statusHost;
  if (!state) {
    if (host.textContent !== '') host.textContent = '';
    return;
  }
  const nets = schematic.netlist ? schematic.netlist.nets.size : 0;
  const text = `符号 ${state.components.length} · 连线 ${schematic.links.length} · 网络 ${nets}`;
  if (host.textContent !== text) host.textContent = text;
}

/* ==========================================================================
   交互
   ========================================================================== */

/** 悬停标识：只用便宜字符串比较，避免每帧 JSON.stringify */
function hoverKey(hit) {
  if (!hit) return '';
  if (hit.type === 'terminal') return `t:${hit.componentId}:${hit.terminal}`;
  if (hit.type === 'component') return `c:${hit.componentId}`;
  if (hit.type === 'wire') return `w:${hit.wireId}`;
  return '';
}

/** 事件坐标 → 画布 CSS 像素 */
function canvasPoint(event) {
  const rect = schematic.canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
    inside: event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom,
  };
}

/**
 * 把坐标夹在布局区内，保证符号不会被拖到看不见的地方。
 * @param {boolean} snap true = 吸附到 0.5 格（落点用）；false = 连续跟手（拖拽中用）
 *
 * 拖拽必须连续：若拖拽过程也做 0.5 格量化，指针在一个台阶内移动时
 * 布局坐标不变、不会触发重绘，画面就会一顿一顿地跳台阶。
 */
function clampSlot(type, gx, gy, snap = true) {
  const size = symSize(type, 0);
  const maxX = Math.max(0, SCHEM_LAYOUT_W - size.w);
  const maxY = Math.max(0, (MAX_ROWS - 2) * SLOT_H - size.h);
  const quantize = snap ? (v) => Math.round(v * 2) / 2 : (v) => v;
  const x = Math.min(Math.max(quantize(gx), 0), maxX);
  const y = Math.min(Math.max(quantize(gy), 0), maxY);
  return { sx: x, sy: y };
}

function setHover(hit) {
  if (hoverKey(hit) === hoverKey(schematic.hover)) {
    // 命中项相同但位置可能变（拖拽中），仅连线需要重绘，这里忽略
    return;
  }
  schematic.hover = hit;
  requestRender();
}

function handlePointerDown(event) {
  if (!schematic) return;
  if (event.button !== undefined && event.button !== 0) return;
  const point = canvasPoint(event);
  if (!point.inside) return;

  const hit = pickSchematic(schematic.view, currentScene(), point.x, point.y);
  const toast = schematic.toast;
  const setSelection = schematic.setSelection;

  // 连线进行中：第二击决定成功 / 取消
  if (schematic.wiring) {
    const from = schematic.wiring.from;
    if (!hit || hit.type !== 'terminal') {
      schematic.wiring = null;
      schematic.pointer = null;
      toast('已取消连线');
      requestRender();
      return;
    }
    const target = { componentId: hit.componentId, terminal: hit.terminal };
    if (from.componentId === target.componentId && from.terminal === target.terminal) {
      schematic.wiring = null;
      schematic.pointer = null;
      toast('已取消连线');
      requestRender();
      return;
    }
    const result = model.addWire(from, target);
    schematic.wiring = null;
    schematic.pointer = null;
    if (result.ok) {
      toast('已连接', 'success');
      schematic.onModelChange('schematic:wire');
    } else {
      toast(result.error || '连线失败', 'error');
    }
    requestRender();
    return;
  }

  if (!hit) {
    setSelection(null);
    return;
  }

  if (hit.type === 'terminal') {
    schematic.wiring = { from: { componentId: hit.componentId, terminal: hit.terminal } };
    schematic.pointer = { x: point.x, y: point.y };
    toast('已选起点，再点另一个引脚完成连线');
    requestRender();
    return;
  }

  if (hit.type === 'component') {
    setSelection({ type: 'component', id: hit.componentId });
    // 进入潜在拖拽态：移动超过阈值才算拖，否则算点击选中
    const entry = schematic.layout.get(hit.componentId);
    const comp = model.findComponent(hit.componentId);
    if (entry && comp) {
      schematic.drag = {
        id: hit.componentId,
        type: comp.type,
        startX: event.clientX,
        startY: event.clientY,
        origX: entry.sx,
        origY: entry.sy,
        moved: false,
      };
      attachDragListeners();
    }
    return;
  }

  if (hit.type === 'wire') {
    setSelection({ type: 'wire', id: hit.wireId });
  }
}

function attachDragListeners() {
  document.addEventListener('pointermove', handleDragMove);
  document.addEventListener('pointerup', handleDragEnd);
  document.addEventListener('pointercancel', handleDragEnd);
  schematic.dragAttached = true;
}

function detachDragListeners() {
  if (!schematic || !schematic.dragAttached) return;
  document.removeEventListener('pointermove', handleDragMove);
  document.removeEventListener('pointerup', handleDragEnd);
  document.removeEventListener('pointercancel', handleDragEnd);
  schematic.dragAttached = false;
}

function handleDragMove(event) {
  if (!schematic || !schematic.drag) return;
  const drag = schematic.drag;
  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;

  if (!drag.moved) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    drag.moved = true;
    if (schematic.canvas) schematic.canvas.style.cursor = 'grabbing';
  }

  const entry = schematic.layout.get(drag.id);
  if (!entry) return;
  const cell = schematic.view.cell;
  const slot = clampSlot(drag.type, drag.origX + dx / cell, drag.origY + dy / cell, false);
  if (entry.sx === slot.sx && entry.sy === slot.sy) return;
  entry.sx = slot.sx;
  entry.sy = slot.sy;
  // 拖拽只改显示位置，网表（电气连接）完全没变，只需重算连线几何
  schematic.links = computeLinks(model.getState(), schematic.layout, schematic.netlist);
  requestRender();
}

function handleDragEnd() {
  if (!schematic) return;
  detachDragListeners();
  const drag = schematic.drag;
  schematic.drag = null;
  if (!drag) return;
  if (schematic.canvas) schematic.canvas.style.cursor = '';
  if (drag.moved) {
    // 拖拽期间是连续坐标，松手时才吸附到整齐的 0.5 格
    const entry = schematic.layout.get(drag.id);
    if (entry) {
      const slot = clampSlot(drag.type, entry.sx, entry.sy, true);
      entry.sx = slot.sx;
      entry.sy = slot.sy;
      schematic.links = computeLinks(model.getState(), schematic.layout, schematic.netlist);
    }
    // 布局变了，内容行数可能变化，需要重算 cell
    relayout();
    requestRender();
  }
}

function handlePointerMove(event) {
  if (!schematic) return;
  const point = canvasPoint(event);
  if (!point.inside) {
    if (schematic.hover || schematic.pointer) {
      schematic.hover = null;
      schematic.pointer = null;
      requestRender();
    }
    return;
  }

  if (schematic.wiring) {
    schematic.pointer = { x: point.x, y: point.y };
    requestRender();
    return;
  }
  if (schematic.drag) return; // 拖拽由 document 上的监听处理

  const hit = pickSchematic(schematic.view, currentScene(), point.x, point.y);
  setHover(hit);
  if (schematic.canvas) {
    schematic.canvas.style.cursor = hit
      ? (hit.type === 'terminal' ? 'crosshair' : 'grab')
      : '';
  }
}

function handlePointerLeave() {
  if (!schematic) return;
  if (schematic.hover || schematic.pointer) {
    schematic.hover = null;
    if (!schematic.wiring) schematic.pointer = null;
    requestRender();
  }
  if (schematic.canvas) schematic.canvas.style.cursor = '';
}

/** 拖入新元件：实验台自动找空位，原理图落在指针附近 */
function handlePaletteDrop(event) {
  if (!schematic) return;
  const point = canvasPoint(event);
  if (!point.inside) return;
  const raw = event.dataTransfer ? event.dataTransfer.getData('text/part-type') : '';
  if (!raw) return;
  event.preventDefault();
  const grid = symUnproject(schematic.view, point.x, point.y);
  placeSymbol(raw, grid.gx, grid.gy);
}

function handleDragOver(event) {
  if (!schematic) return;
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  event.preventDefault();
}

/**
 * 元件库拖拽：原理图视图下由本模块接管。
 *
 * 实验台的拖拽实现按「落点在实验台画布内」判定（interact.js），
 * 在原理图视图下实验台画布是隐藏的，落点必然判否——所以这里用捕获阶段
 * 先拦下 pointerdown 并阻止冒泡，让 interact 的委托监听收不到，
 * 否则同一拖拽会被两边各处理一次。
 */
function handlePalettePointerDown(event) {
  if (!schematic) return;
  // 只在原理图可见时接管；实验台视图下保持 interact.js 原有行为
  if (schematic.host && schematic.host.hidden) return;
  const item = event.target.closest('[data-part-type]');
  if (!item) return;
  event.preventDefault();
  event.stopPropagation();
  startPaletteDrag(event, item.dataset.partType);
}

function startPaletteDrag(event, type) {
  const start = { x: event.clientX, y: event.clientY };
  const drag = { active: false, ghostEl: null };
  const def = getPart(type);
  const label = def ? def.label : type;

  const cleanup = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
    if (schematic) schematic.paletteCleanup = null;
  };

  const onMove = (moveEvent) => {
    const dx = moveEvent.clientX - start.x;
    const dy = moveEvent.clientY - start.y;
    if (!drag.active && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!drag.active) {
      drag.active = true;
      drag.ghostEl = document.createElement('div');
      drag.ghostEl.className = 'drag-ghost';
      drag.ghostEl.textContent = label;
      document.body.append(drag.ghostEl);
    }
    drag.ghostEl.style.transform = `translate(${moveEvent.clientX + 12}px, ${moveEvent.clientY + 10}px)`;
  };

  const onUp = (upEvent) => {
    cleanup();
    if (drag.ghostEl) drag.ghostEl.remove();
    if (!schematic) return;
    if (!drag.active) {
      schematic.toast(`把 ${label} 拖到原理图上松手即可放置`);
      return;
    }
    const point = canvasPoint(upEvent);
    if (!point.inside) {
      schematic.toast('拖到原理图画布上再松手');
      return;
    }
    const grid = symUnproject(schematic.view, point.x, point.y);
    placeSymbol(type, grid.gx, grid.gy);
  };

  schematic.paletteCleanup = cleanup;
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onUp);
}

/* ==========================================================================
   对 model 的操作
   ========================================================================== */

/** 在实验台上找第一个能放下该类型且不重叠的位置 */
function findBenchSpot(type) {
  const state = model.getState();
  const platform = platforms.getPlatform(model.getPlatformId());
  const def = getPart(type);
  if (!state || !platform || !def) return null;

  const footprint = footprintOf(def, 0);
  for (let y = 0; y + footprint.h <= platform.rows; y += 1) {
    for (let x = 0; x + footprint.w <= platform.cols; x += 1) {
      const rect = { x, y, w: footprint.w, h: footprint.h };
      const clash = state.components.some((comp) => model.rectsOverlap(rect, model.rectOf(comp)));
      if (!clash) return { x, y };
    }
  }
  return null;
}

/**
 * 在原理图上放置一个新元件。
 * 元件本体仍落在实验台网格（model 的唯一坐标），原理图只决定它的显示位置。
 */
export function placeSymbol(type, gx, gy) {
  if (!schematic) return null;
  const def = getPart(type);
  if (!def) return null;

  const spot = findBenchSpot(type);
  if (!spot) {
    schematic.toast('实验台上已没有空位，先挪走或删除一些元件', 'error');
    return null;
  }

  const added = model.addComponent(type, spot.x, spot.y);
  if (!added.ok) {
    schematic.toast(added.error || '放置失败', 'error');
    return null;
  }

  const slot = clampSlot(type, Number.isFinite(gx) ? gx : 0, Number.isFinite(gy) ? gy : 0);
  schematic.layout.set(added.component.id, { sx: slot.sx, sy: slot.sy, rot: 0 });

  schematic.setSelection({ type: 'component', id: added.component.id });
  schematic.toast(`已放置 ${def.label} ${added.component.id}`, 'success');
  schematic.onModelChange('schematic:place');
  relayout();
  requestRender();
  return added.component;
}

/* ==========================================================================
   生命周期
   ========================================================================== */

/**
 * 初始化原理图视图。
 * @param {object} options
 *   canvas            原理图画布
 *   host              画布容器（用于量尺寸）
 *   getSelection      () => board.scene.selection
 *   setSelection      (sel) => void，与实验台共用同一个选中态
 *   toast             (message, kind) => void
 *   onModelChange     (reason) => void，转回 board 的统一收尾（存档 / 属性面板 / 重绘）
 */
export function initSchematic(options) {
  destroySchematic();

  const {
    canvas,
    host,
    getSelection,
    setSelection,
    toast,
    onModelChange,
  } = options || {};

  if (!canvas || !host) return null;

  schematic = {
    canvas,
    host,
    statusHost: document.getElementById('schem-status'),
    view: createSymView(canvas),
    layout: new Map(),
    links: [],
    netlist: null,
    rows: SLOT_H,
    cols: 14,
    hover: null,
    wiring: null,
    pointer: null,
    drag: null,
    dragAttached: false,
    paletteHost: null,
    paletteCleanup: null,
    raf: 0,
    perf: { frames: [], durations: [] },
    getSelection: typeof getSelection === 'function' ? getSelection : () => null,
    setSelection: typeof setSelection === 'function' ? setSelection : () => {},
    toast: typeof toast === 'function' ? toast : () => {},
    onModelChange: typeof onModelChange === 'function' ? onModelChange : () => {},
    handlers: {},
    observer: null,
  };

  syncLayout();
  rebuildLinks();

  // 拖拽落点 / 拖入新元件
  schematic.handlers.pointerdown = handlePointerDown;
  schematic.handlers.pointermove = handlePointerMove;
  schematic.handlers.pointerleave = handlePointerLeave;
  schematic.handlers.dragover = handleDragOver;
  schematic.handlers.drop = handlePaletteDrop;
  canvas.addEventListener('pointerdown', schematic.handlers.pointerdown);
  canvas.addEventListener('pointermove', schematic.handlers.pointermove);
  canvas.addEventListener('pointerleave', schematic.handlers.pointerleave);
  canvas.addEventListener('dragover', schematic.handlers.dragover);
  canvas.addEventListener('drop', schematic.handlers.drop);

  // 元件库：捕获阶段接管（见 handlePalettePointerDown 的说明）
  schematic.paletteHost = document.getElementById('parts-palette');
  if (schematic.paletteHost) {
    schematic.handlers.paletteDown = handlePalettePointerDown;
    schematic.paletteHost.addEventListener('pointerdown', schematic.handlers.paletteDown, true);
  }

  if (typeof ResizeObserver === 'function') {
    schematic.observer = new ResizeObserver(() => relayout());
    schematic.observer.observe(host);
  }
  schematic.handlers.resize = () => relayout();
  window.addEventListener('resize', schematic.handlers.resize);

  relayout();
  requestRender();
  return schematic;
}

/** model 变更后刷新布局、连线、尺寸并重绘 */
export function refreshSchematic() {
  if (!schematic) return;
  syncLayout();
  rebuildLinks();
  updateStatus();
  relayout();
  requestRender();
}

/** 外部选中态变化：只重绘，不反向写回 */
export function syncSchematicSelection() {
  if (!schematic) return;
  clearTransient();
  requestRender();
}

/** 清掉连线中 / 悬停这类瞬时状态（切换选中、销毁前用） */
function clearTransient() {
  if (!schematic) return;
  schematic.wiring = null;
  schematic.pointer = null;
  schematic.hover = null;
  if (schematic.canvas) schematic.canvas.style.cursor = '';
}

/** 视图切换后调用：重新量尺寸并重绘 */
export function relayoutSchematic() {
  return relayout();
}

/** 销毁：解绑、停帧、清引用 */
export function destroySchematic() {
  if (!schematic) return;
  if (schematic.raf) {
    cancelAnimationFrame(schematic.raf);
    schematic.raf = 0;
  }
  detachDragListeners();

  const { canvas, host } = schematic;
  if (canvas) {
    canvas.removeEventListener('pointerdown', schematic.handlers.pointerdown);
    canvas.removeEventListener('pointermove', schematic.handlers.pointermove);
    canvas.removeEventListener('pointerleave', schematic.handlers.pointerleave);
    canvas.removeEventListener('dragover', schematic.handlers.dragover);
    canvas.removeEventListener('drop', schematic.handlers.drop);
    canvas.style.cursor = '';
  }
  if (schematic.paletteHost && schematic.handlers.paletteDown) {
    schematic.paletteHost.removeEventListener('pointerdown', schematic.handlers.paletteDown, true);
  }
  if (schematic.paletteCleanup) schematic.paletteCleanup();
  if (schematic.observer) schematic.observer.disconnect();
  if (schematic.handlers.resize) window.removeEventListener('resize', schematic.handlers.resize);

  // 状态栏与画布都要清，否则返回列表后仍残留上一次的读数
  if (schematic.statusHost) schematic.statusHost.textContent = '';
  invalidateSchematicLayer();

  // 清画布，避免下次进入时闪出上一次的残影
  const ctx = schematic.view ? schematic.view.ctx : null;
  if (ctx && canvas) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  schematic = null;
}

/** 是否已初始化 */
export function isSchematicActive() {
  return Boolean(schematic);
}

/* ==========================================================================
   调试 / 探针入口
   ========================================================================== */

/** 供 board 挂到 window.__labBoard.schematic 上的只读封装 */
export function schematicApi() {
  if (!schematic) return null;
  return {
    get view() {
      return schematic ? schematic.view : null;
    },
    get perf() {
      return schematic ? schematic.perf : null;
    },
    get rows() {
      return schematic ? schematic.rows : 0;
    },
    get cols() {
      return schematic ? schematic.cols : 0;
    },
    getLayout: () => (schematic ? new Map(schematic.layout) : new Map()),
    layoutOf: (id) => {
      if (!schematic) return null;
      const entry = schematic.layout.get(id);
      return entry ? { ...entry } : null;
    },
    getLinks: () => (schematic ? schematic.links.map((link) => ({
      netId: link.netId,
      wireId: link.wireId,
      segments: link.segments.map((segment) => segment.map((pt) => ({ ...pt }))),
      terms: link.terms.map((term) => ({ ...term })),
    })) : []),
    getNetlist: () => (schematic ? schematic.netlist : null),
    refresh: refreshSchematic,
    requestRender,
    relayout: relayoutSchematic,
    place: (type, gx, gy) => placeSymbol(type, gx, gy),
    remove: (id) => {
      if (!schematic) return false;
      const result = model.removeComponent(id);
      if (!result.ok) return false;
      schematic.onModelChange('schematic:remove');
      return true;
    },
    pick: (x, y) => (schematic
      ? pickSchematic(schematic.view, currentScene(), x, y)
      : null),
    project: (gx, gy) => (schematic ? symProject(schematic.view, gx, gy) : null),
    unproject: (x, y) => (schematic ? symUnproject(schematic.view, x, y) : null),
    symbolRect: (id) => {
      if (!schematic) return null;
      const comp = model.findComponent(id);
      const entry = schematic.layout.get(id);
      if (!comp || !entry) return null;
      return symbolScreenRect(schematic.view, comp, entry);
    },
    setSelection: (sel) => {
      if (!schematic) return;
      schematic.setSelection(sel);
      requestRender();
    },
    startWiring: (componentId, terminal) => {
      if (!schematic) return false;
      schematic.wiring = { from: { componentId, terminal } };
      schematic.pointer = null;
      requestRender();
      return true;
    },
    finishWiring: (componentId, terminal) => {
      if (!schematic || !schematic.wiring) return { ok: false, error: '当前不在连线状态' };
      const result = model.addWire(schematic.wiring.from, { componentId, terminal });
      schematic.wiring = null;
      schematic.pointer = null;
      if (result.ok) schematic.onModelChange('schematic:wire');
      requestRender();
      return result;
    },
    getWiring: () => (schematic && schematic.wiring ? { ...schematic.wiring } : null),
    findBenchSpot,
  };
}
