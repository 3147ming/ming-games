/**
 * board.js — 实验台控制器
 *
 * 把 model（数据）/ render（绘制）/ interact（交互）三者粘起来：
 *   - initBoard(expId, platform)：组装画布、恢复存档、构建元件库、绑定平台切换
 *   - destroyBoard()：解绑全部事件、停止动画帧、把电路落盘
 *
 * 存档键：lab-sim-circuit-<expId>（变更防抖 500ms 写入）
 */

import * as model from './model.js';
import * as platforms from './platforms.js';
import { getPart, terminalPos } from './parts.js';
import {
  createView,
  layoutView,
  renderScene,
  invalidatePlatformLayer,
  project,
  pickAt,
  terminalScreenPos,
  setZoom,
  setPan,
  getZoom,
  zoomIn,
  zoomOut,
  resetView,
  focusOnGrid,
  ZOOM_LEVELS,
} from './render.js';
import { createInteraction } from './interact.js';
import {
  initSchematic,
  destroySchematic,
  refreshSchematic,
  syncSchematicSelection,
  relayoutSchematic,
  schematicApi,
} from './schematic.js';
import {
  reportFormat,
  formatVolt,
  formatAmp,
  formatWatt,
  formatResidual,
} from './simdc.js';
import {
  solveCoupled,
  stepClock,
  triggerPulse,
  resetDigState,
  levelBadge,
  collectDigitalUnits,
  digPlanCacheStats,
  resetDigPlanCache,
} from './simdig.js';
import { levelText } from './digmodels.js';
import {
  solveTransient,
  runTransient,
  resetTransientState,
} from './simtrans.js';
import { createFaultView } from './experiment-config.js';
import {
  collectMix,
  mixStateSnapshot,
  mixStateOf,
  analyzeMixLoops,
  comparatorThreshold,
  resetMixState,
  MAX_MIX_ITER,
} from './simmix.js';

/** 存档键前缀 */
const STORAGE_PREFIX = 'lab-sim-circuit-';

/** 变更落盘防抖（毫秒） */
const SAVE_DEBOUNCE = 500;

/** 电路变更后重仿的防抖（毫秒） */
const SIM_DEBOUNCE = 300;

/** 面板里节点 / 元件的展示上限，避免大电路把右栏撑成无限长 */
const SIM_ROW_LIMIT = 20;

/** 当前实验台（同一时刻只有一个） */
let board = null;

/** 落盘定时器 / 动画帧句柄 */
let saveTimer = 0;
let rafHandle = 0;

/** 重仿防抖定时器 */
let simTimer = 0;

/**
 * 仿真调用计数。防抖是否真的生效只能靠它验证（数"跑了几次"而不是"看起来更新了"），
 * 排查"改了参数没反应"时也先看这里。
 */
const simStats = { solves: 0, lastMs: 0, lastReason: '', lastAt: 0 };

/** model 变更订阅者（原理图视图等外部观察者） */
let changeListeners = [];

/* ==========================================================================
   model 变更事件桥
   ========================================================================== */

/**
 * 订阅电路变更。返回取消订阅函数。
 * 触发点：handleChange（交互产生的增删改）、applyPlatform（平台切换）。
 * 原理图视图靠它保持与实验台一致——两视图共用同一个 model 实例，
 * 所以这里只需要"通知重绘"，不需要传数据。
 */
export function onModelChange(callback) {
  if (typeof callback !== 'function') return () => {};
  changeListeners.push(callback);
  return () => {
    changeListeners = changeListeners.filter((fn) => fn !== callback);
  };
}

/** 广播变更（订阅者抛错不连累其它订阅者与主流程） */
function notifyModelChange(reason) {
  changeListeners.slice().forEach((fn) => {
    try {
      fn(reason);
    } catch (err) {
      console.error('[onModelChange] 订阅者执行失败', err);
    }
  });
}

/** 性能采样：frames 记录每帧开始时间，durations 记录渲染耗时 */
const perf = { frames: [], durations: [] };

/** 平台中文名 */
const PLATFORM_LABEL = { 'exp-box': '数字电路实验箱', breadboard: '面包板' };

/* ==========================================================================
   存档
   ========================================================================== */

function readSave(expId) {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + expId);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch (err) {
    return null;
  }
}

/** 立即落盘；失败只提示一次，不打断操作 */
function saveNow() {
  if (!board) return;
  try {
    const data = model.serializeCircuit();
    window.localStorage.setItem(STORAGE_PREFIX + board.expId, JSON.stringify(data));
    board.saveOk = true;
  } catch (err) {
    if (board.saveOk !== false) {
      board.saveOk = false;
      board.onToast('本地存储不可用，本次电路只保留在内存中（关闭页面会丢失）', 'error');
    }
  }
}

function scheduleSave() {
  if (!board) return;
  if (saveTimer) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = 0;
    saveNow();
  }, SAVE_DEBOUNCE);
}

/* ==========================================================================
   渲染调度
   ========================================================================== */

/* ==========================================================================
   画布上的仿真标注
   ========================================================================== */

/** LED 光晕色（与 parts.js 的灯珠配色一致） */
const LED_GLOW = {
  red: [255, 104, 88],
  green: [95, 211, 154],
  yellow: [242, 201, 76],
};

/** 圆角矩形路径（老浏览器没有 roundRect 时用 arcTo 兜底） */
function roundRectPath(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * 在场景之上叠一层仿真标注：
 *   - LED 点亮时画光晕（数字输出 1 → 灯亮，这是实验箱上最直观的反馈）
 *   - 每个已接线的数字输出端子旁挂一个电平标签（H 琥珀 / L 灰 / X 虚线）
 */
function drawSimOverlay(view, scene, sim) {
  if (!view || !view.ctx || !sim) return;
  const ctx = view.ctx;
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);

  /* ---- LED ---- */
  (sim.leds || []).forEach((led) => {
    if (!led.on) return;
    const comp = model.findComponent(led.componentId);
    const def = getPart(comp ? comp.type : null);
    if (!comp || !def) return;
    const center = project(view, comp.x + def.size.w / 2 - 0.5, comp.y + def.size.h / 2 - 0.5);
    const cy = center.y - 6;
    const radius = Math.max(14, view.tileW * 1.15);
    const tone = LED_GLOW[comp.params.color] || LED_GLOW.red;
    const grad = ctx.createRadialGradient(center.x, cy, 0, center.x, cy, radius);
    grad.addColorStop(0, `rgba(${tone[0]}, ${tone[1]}, ${tone[2]}, 0.55)`);
    grad.addColorStop(0.45, `rgba(${tone[0]}, ${tone[1]}, ${tone[2]}, 0.22)`);
    grad.addColorStop(1, `rgba(${tone[0]}, ${tone[1]}, ${tone[2]}, 0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(center.x, cy, radius, 0, Math.PI * 2);
    ctx.fill();
  });

  /* ---- 电平标签 ---- */
  const dig = sim.dig;
  if (!dig || !dig.ok) return;

  const size = Math.max(8, Math.min(11, view.tileW * 0.3));
  const badgeW = size * 1.9;
  const badgeH = size * 1.5;

  (dig.compStates || []).forEach((state) => {
    const comp = model.findComponent(state.componentId);
    if (!comp) return;
    Object.keys(state.outputs).forEach((pin) => {
      const level = state.outputs[pin];
      if (level === null) return; // 未接线的输出不标注，避免满屏小方块
      if (state.wired && state.wired[pin] === false) return;
      const pos = terminalPos(comp, pin);
      if (!pos) return;
      const p = project(view, pos.x, pos.y);
      const bx = p.x - badgeW / 2;
      const by = p.y - view.tileH * 0.5 - badgeH - 3;

      roundRectPath(ctx, bx, by, badgeW, badgeH, badgeH * 0.28);
      ctx.fillStyle = 'rgba(18, 20, 26, 0.82)';
      ctx.fill();
      if (level === 1) {
        ctx.strokeStyle = 'rgba(242, 169, 59, 0.92)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      } else if (level === 0) {
        ctx.strokeStyle = 'rgba(126, 134, 150, 0.9)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      } else {
        ctx.strokeStyle = 'rgba(120, 128, 146, 0.6)';
        ctx.lineWidth = 1.1;
        ctx.setLineDash([2, 2]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.font = `600 ${size}px "Cascadia Mono", Consolas, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = level === 1
        ? 'rgba(242, 169, 59, 0.98)'
        : (level === 0 ? 'rgba(178, 186, 202, 0.95)' : 'rgba(150, 158, 176, 0.9)');
      ctx.fillText(levelBadge(level), p.x, by + badgeH / 2);
    });
  });
}

function requestRender() {
  if (!board || rafHandle) return;
  rafHandle = requestAnimationFrame(() => {
    rafHandle = 0;
    if (!board) return;
    const start = performance.now();
    renderScene(board.view, board.scene);
    // DOM 覆盖层（画布探针标记）跟同一帧的视图变换对齐，避免平移/缩放漂移
    if (board.onAfterRender) board.onAfterRender(board.view);
    // 仿真标注画在同一张画布上、紧跟场景之后：LED 光晕与端子电平标签
    // 需要跟元件同帧对齐，另开一层反而会漂移。
    drawSimOverlay(board.view, board.scene, board.sim);
    const end = performance.now();

    perf.frames.push(start);
    perf.durations.push(end - start);
    // 只保留最近 400 帧，避免长时间运行把数组撑大
    if (perf.frames.length > 400) {
      perf.frames.shift();
      perf.durations.shift();
    }
  });
}

/* ==========================================================================
   画布尺寸
   ========================================================================== */

function relayout() {
  if (!board) return;
  const host = board.host;
  if (!host) return;
  const rect = host.getBoundingClientRect();
  const cssWidth = Math.max(120, Math.floor(rect.width));
  const cssHeight = Math.max(120, Math.floor(rect.height));
  const changed = layoutView(board.view, board.scene.platform, cssWidth, cssHeight, { pad: 26 });
  if (changed) invalidatePlatformLayer();
  requestRender();
}

/**
 * 求解用的模型门面（包 13）：有故障时套一层只读视图。
 * 放在模块级是因为 simulateNow / __labBoard.simtrans 都在 initBoard 之外。
 */
function simModel() {
  if (!board || !board.faults || board.faults.length === 0) return model;
  return createFaultView(model, board.faults);
}

/* ==========================================================================
   状态栏与属性面板
   ========================================================================== */

/** 轻量体检：刷新悬空导线集合 + 状态栏 */
function refreshHealth() {
  if (!board) return;
  const report = model.validateCircuit();
  board.scene.dangling = new Set(report.danglingWires);
  board.report = report;

  const status = board.statusHost;
  if (status) {
    const circuit = model.getState();
    const parts = [
      `元件 ${circuit.components.length}`,
      `导线 ${circuit.wires.length}`,
      `网络 ${report.netCount}`,
    ];
    if (report.danglingWires.length > 0) parts.push(`悬空导线 ${report.danglingWires.length}`);
    // 混合仿真标识（包 8）：电路里有边界元件时明确显示"混合仿真"；
    // 环路/不收敛时把可读原因直接写进状态行（面板另有环路详情）
    const dig = board.sim ? board.sim.dig : null;
    const mixCount = dig && dig.mix ? (Number(dig.mix.units) || 0) : 0;
    let mixedError = false;
    if (mixCount > 0) {
      if (dig && dig.ok === false) {
        mixedError = true;
        parts.push(`混合仿真 · ${dig.error || '求解失败'}`);
      } else {
        parts.push(`混合仿真 · 边界 ${mixCount}`);
      }
    }
    status.textContent = parts.join(' · ');
    status.classList.toggle('is-warn', report.danglingWires.length > 0 || mixedError);
  }
}

/** 变更后的统一收尾：体检 → 落盘 → 属性面板 → 重绘 → 通知订阅者 → 排一次仿真 */
function handleChange(reason) {
  if (!board) return;
  if (board.interaction) board.interaction.syncScene();
  refreshHealth();
  scheduleSave();
  renderProps();
  requestRender();
  notifyModelChange(reason || 'change');
  scheduleSimulation();
}

/**
 * 外部（原理图视图）设置选中。
 * 两视图共用 board.scene.selection，所以这里不需要"同步"两套状态，
 * 设一次就够：实验台按它画高亮，原理图也按它画高亮。
 */
function applySelection(selection) {
  if (!board) return;
  board.scene.selection = selection;
  // 置一个不会命中的 key，强制属性面板重建（参数可能来自另一个元件）
  board.propsKey = '__external__';
  if (board.interaction) board.interaction.syncScene();
  renderProps();
  syncSchematicSelection();
  requestRender();
}

/* ---------------------------------------------------------------- 属性面板 */

function selectionKey() {
  if (!board || !board.scene.selection) return '';
  const sel = board.scene.selection;
  return `${sel.type}:${sel.id}`;
}

/** 把存储值换算成界面显示值（避开浮点尾差） */
function displayValue(value, field) {
  const scaled = field.factor ? value / field.factor : value;
  return Number(Number(scaled).toFixed(6));
}

/** 渲染右栏元件参数面板 */
function renderProps() {
  if (!board) return;
  const host = board.propsHost;
  if (!host) return;

  const key = selectionKey();
  if (key === board.propsKey) {
    updatePropStatic();
    return;
  }
  board.propsKey = key;
  host.replaceChildren();

  const sel = board.scene.selection;
  if (!sel) {
    const hint = document.createElement('p');
    hint.className = 'props-empty';
    hint.textContent = '选中画布上的元件或导线，这里会显示它的参数。';
    host.append(hint);
    return;
  }

  if (sel.type === 'wire') {
    const wire = model.findWire(sel.id);
    if (!wire) return;
    host.append(buildPropsHead('导线', sel.id));

    const rows = document.createElement('div');
    rows.className = 'props-rows';
    rows.append(
      buildPropRow('起点', describeRef(wire.a)),
      buildPropRow('终点', describeRef(wire.b)),
      buildPropRow('网络', model.getNetOf(wire.a) || '未成网'),
    );
    host.append(rows);
    host.append(buildPropsActions([{ label: '删除导线', action: 'delete' }]));
    return;
  }

  const comp = model.findComponent(sel.id);
  const def = getPart(comp ? comp.type : null);
  if (!comp || !def) return;

  host.append(buildPropsHead(def.label, comp.id));

  const rows = document.createElement('div');
  rows.className = 'props-rows';
  const posRow = buildPropRow('位置', `(${comp.x}, ${comp.y})`);
  posRow.dataset.propStatic = 'position';
  const rotRow = buildPropRow('旋转', `${comp.rotation}°`);
  rotRow.dataset.propStatic = 'rotation';
  rows.append(posRow, rotRow);
  host.append(rows);

  if (def.paramFields.length > 0) {
    const form = document.createElement('div');
    form.className = 'props-form';
    def.paramFields.forEach((field) => {
      form.append(buildParamField(comp, field));
    });
    host.append(form);
  } else {
    const none = document.createElement('p');
    none.className = 'props-empty';
    none.textContent = '该元件没有可调参数。';
    host.append(none);
  }

  const actions = [{ label: '删除元件', action: 'delete' }];
  if (comp.rotation === 0) {
    // 正方占位（比较器）也能转：端子排布不对称
    actions.unshift({ label: '旋转 90°', action: 'rotate' });
  }
  host.append(buildPropsActions(actions));
}

/** 选中项不变时只刷新只读行（避免重建表单打断输入） */
function updatePropStatic() {
  if (!board) return;
  const sel = board.scene.selection;
  if (!sel || sel.type !== 'component') return;
  const comp = model.findComponent(sel.id);
  const host = board.propsHost;
  if (!comp || !host) return;
  const pos = host.querySelector('[data-prop-static="position"] .props-value');
  const rot = host.querySelector('[data-prop-static="rotation"] .props-value');
  if (pos) pos.textContent = `(${comp.x}, ${comp.y})`;
  if (rot) rot.textContent = `${comp.rotation}°`;
}

function buildPropsHead(title, id) {
  const head = document.createElement('div');
  head.className = 'props-head';
  const name = document.createElement('span');
  name.className = 'props-title';
  name.textContent = title;
  const tag = document.createElement('span');
  tag.className = 'props-id';
  tag.textContent = id;
  head.append(name, tag);
  return head;
}

function buildPropRow(label, value) {
  const row = document.createElement('div');
  row.className = 'props-row';
  const dt = document.createElement('span');
  dt.className = 'props-key';
  dt.textContent = label;
  const dd = document.createElement('span');
  dd.className = 'props-value';
  dd.textContent = value;
  row.append(dt, dd);
  return row;
}

/** 端点可读描述：元件端子 / 平台孔位 */
function describeRef(ref) {
  if (!ref) return '—';
  if (ref.componentId) return `${ref.componentId}.${ref.terminal}`;
  if (ref.node) {
    const node = platforms.getNode(ref.node);
    if (!node) return `${ref.node}（已失效）`;
    const owner = platforms.getPlatform(node.id.split(':')[0]);
    return `${owner ? owner.label : '平台'} @(${node.x}, ${node.y})`;
  }
  return '—';
}

/** 单个参数字段 */
function buildParamField(comp, field) {
  const wrapper = document.createElement('label');
  wrapper.className = 'props-field';

  const label = document.createElement('span');
  label.className = 'props-field-label';
  label.textContent = field.label;

  let input;
  if (field.type === 'select') {
    input = document.createElement('select');
    input.className = 'props-input';
    field.options.forEach((option) => {
      const opt = document.createElement('option');
      opt.value = option.value;
      opt.textContent = option.label;
      input.append(opt);
    });
    // 旧存档里可能存着已改名的取值（如 7408 → 74LS08），显示前先归一化
    const rawValue = field.normalize
      ? field.normalize(comp.params[field.key])
      : comp.params[field.key];
    input.value = rawValue;
  } else {
    input = document.createElement('input');
    input.className = field.type === 'range' ? 'props-input props-range' : 'props-input';
    input.type = field.type === 'range' ? 'range' : 'number';
    if (field.step !== undefined) input.step = String(field.step);
    if (field.min !== undefined) input.min = String(field.min);
    if (field.max !== undefined) input.max = String(field.max);
    input.value = String(displayValue(comp.params[field.key], field));
    if (field.type === 'range') {
      // 滑块拖动实时生效：input 事件即改参数（走既有参数防抖）
      input.addEventListener('input', () => {
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
  }

  input.dataset.paramKey = field.key;
  input.dataset.paramType = field.type;
  input.dataset.componentId = comp.id;

  const unit = document.createElement('span');
  unit.className = 'props-unit';
  unit.textContent = field.unit || '';

  const valueBox = document.createElement('span');
  valueBox.className = 'props-input-box';
  valueBox.append(input);
  if (field.unit) valueBox.append(unit);

  wrapper.append(label, valueBox);
  return wrapper;
}

function buildPropsActions(actions) {
  const box = document.createElement('div');
  box.className = 'props-actions';
  actions.forEach((item) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = item.action === 'delete' ? 'btn btn-ghost btn-danger' : 'btn btn-ghost';
    btn.textContent = item.label;
    btn.dataset.propAction = item.action;
    box.append(btn);
  });
  return box;
}

/** 属性面板事件委托：change 改参数，click 触发旋转/删除 */
function handlePropsChange(event) {
  const input = event.target.closest('[data-param-key]');
  if (!input || !board) return;
  const compId = input.dataset.componentId;
  const key = input.dataset.paramKey;
  const isNumber = input.dataset.paramType === 'number' || input.dataset.paramType === 'range';

  if (!isNumber) {
    model.updateParams(compId, { [key]: input.value });
    handleChange();
    return;
  }

  const field = findParamField(compId, key);
  const raw = Number(input.value);
  if (!field || !Number.isFinite(raw)) {
    board.onToast('参数必须是数字', 'error');
    renderPropsForce();
    return;
  }
  const min = field.min === undefined ? -Infinity : field.min;
  const max = field.max === undefined ? Infinity : field.max;
  const clamped = Math.min(Math.max(raw, min), max);
  if (clamped !== raw) {
    board.onToast(`已限制在 ${min} ~ ${max}${field.unit || ''}`, 'info');
  }
  const stored = field.factor ? clamped * field.factor : clamped;
  model.updateParams(compId, { [key]: stored });
  handleChange();
  // 回写夹紧后的显示值
  input.value = String(displayValue(stored, field));
}

function findParamField(compId, key) {
  const comp = model.findComponent(compId);
  if (!comp) return null;
  const def = getPart(comp.type);
  if (!def) return null;
  return def.paramFields.find((field) => field.key === key) || null;
}

/** 强制重建属性面板（参数非法时用来回滚输入框） */
function renderPropsForce() {
  if (!board) return;
  board.propsKey = '__force__';
  renderProps();
}

function handlePropsClick(event) {
  const btn = event.target.closest('[data-prop-action]');
  if (!btn || !board) return;
  const action = btn.dataset.propAction;
  if (action === 'delete') board.interaction.deleteSelection();
  else if (action === 'rotate') board.interaction.rotateSelection();
}

/* ==========================================================================
   直流工作点仿真
   ========================================================================== */

/**
 * 立即跑一次仿真并刷新面板。
 * 手动点「重新仿真」时先取消挂起的防抖，避免紧接着又跑第二次。
 *
 * 一次调用同时算三件事：直流工作点 → 数字稳态 → 数字驱动回灌直流（LED 才会亮）。
 * 任何一个环节抛异常都降级成"错误结果"，画布必须保持可编辑。
 */
export function simulateNow(reason = 'manual') {
  if (!board) return null;
  if (simTimer) {
    window.clearTimeout(simTimer);
    simTimer = 0;
  }

  const started = performance.now();
  let coupled;
  try {
    coupled = solveCoupled(simModel());
  } catch (err) {
    // 引擎自身的意外不能把整个应用带走：降级成一条错误结果，画布仍可编辑
    const message = err && err.message ? err.message : String(err);
    coupled = {
      analog: {
        ok: false,
        error: `仿真引擎异常：${message}`,
        warnings: [],
        convergence: { iter: 0, residual: 0 },
        nodeVoltages: [],
        elementResults: [],
      },
      dig: {
        ok: false,
        error: `数字引擎异常：${message}`,
        warnings: [],
        digNets: [],
        compStates: [],
        elapsedMs: 0,
      },
      leds: [],
      drove: false,
      activeDrives: [],
    };
  }
  const cost = Number((performance.now() - started).toFixed(3));

  simStats.solves += 1;
  simStats.lastMs = cost;
  simStats.lastReason = reason;
  simStats.lastAt = Date.now();

  board.sim = {
    result: coupled.analog,
    dig: coupled.dig,
    leds: coupled.leds || [],
    drove: Boolean(coupled.drove),
    drives: coupled.activeDrives || [],
    reason,
    at: simStats.lastAt,
    cost,
  };
  renderSimPanel();
  renderDigPanel();
  // 计算完成：清除 pending 标志，状态行恢复结果摘要（2.11）
  board.scene.simPending = false;
  refreshHealth();
  requestRender();
  return coupled.analog;
}

/** 状态行显示"计算中…"：防抖等待期即置位，提示用户仿真正在跑（D1） */
function renderSimPending() {
  const status = board ? board.statusHost : null;
  if (!status) return;
  status.textContent = '计算中…';
  status.classList.remove('is-warn');
}

/** 电路变更后的防抖重仿：300ms 内的连续改动只算最后一次 */
function scheduleSimulation() {
  if (!board) return;
  // 进入防抖期即标记 pending：状态行立刻显示"计算中…"（2.11）
  board.scene.simPending = true;
  renderSimPending();
  if (simTimer) window.clearTimeout(simTimer);
  simTimer = window.setTimeout(() => {
    simTimer = 0;
    simulateNow('change');
  }, SIM_DEBOUNCE);
}

/* ==========================================================================
   时钟 / 脉冲 / 逻辑开关
   ========================================================================== */

/**
 * 时钟步进：一个步 = 一个完整时钟周期，正好产生一次上升沿。
 * 步进本身已经把触发器状态推到了新值，这里再整体重算一次是为了刷新
 * 直流侧的 LED 与面板（数字输出可能刚变，LED 亮灭要跟着变）。
 */
function runClockStep() {
  if (!board) return null;
  const stepped = stepClock(model);
  if (!stepped.ok) {
    board.onToast(stepped.error || '时钟步进失败', 'error');
    return null;
  }
  simulateNow('clock');
  board.onToast(`时钟步进：${stepped.clocks.join('、')} 产生一个上升沿`, 'success');
  return stepped;
}

/** 触发脉冲源（momentary 一次一个上升沿；toggle 翻转保持） */
function runPulse(componentId) {
  if (!board) return null;
  const fired = triggerPulse(model, componentId);
  if (!fired.ok) {
    board.onToast(fired.error || '脉冲触发失败', 'error');
    return null;
  }
  simulateNow('pulse');
  board.onToast(
    fired.mode === 'toggle'
      ? `${componentId} 翻转为${levelText(fired.level)}`
      : `${componentId} 触发一次脉冲`,
    'success',
  );
  return fired;
}

/**
 * 点击画布上的元件：逻辑开关拨一下、脉冲源按一下。
 * interact.js 负责选中/拖动，这里只补"点一下本体"这一个动作，
 * 所以用 pointerdown/pointerup 的距离阈值区分"点击"与"拖拽"。
 */
function handleCanvasTap(event) {
  if (!board) return;
  const rect = board.canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;

  const hit = pickAt(board.view, board.scene, x, y);
  if (!hit || hit.type !== 'component') return;
  const comp = model.findComponent(hit.componentId);
  if (!comp) return;

  if (comp.type === 'logic-switch') {
    const next = comp.params.state === 'hi' ? 'lo' : 'hi';
    model.updateParams(comp.id, { state: next });
    // 参数面板要立刻反映新状态：置一个不会命中的 key 强制重建
    board.propsKey = '__tap__';
    board.onToast(`${comp.id} → ${next === 'hi' ? '高电平 1' : '低电平 0'}`, 'success');
    handleChange('toggle');
    return;
  }

  if (comp.type === 'pulse') runPulse(comp.id);
}

/** 记录按下位置与电路规模：规模变了说明这一下是放置/连线，不是点击元件 */
function markCanvasDown(event) {
  if (!board) return;
  const circuit = model.getState();
  board.tapStart = {
    x: event.clientX,
    y: event.clientY,
    size: circuit ? circuit.components.length + circuit.wires.length : 0,
  };
}

function finishCanvasTap(event) {
  if (!board) return;
  const start = board.tapStart;
  board.tapStart = null;
  if (!start) return;
  if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
  const circuit = model.getState();
  const size = circuit ? circuit.components.length + circuit.wires.length : 0;
  if (size !== start.size) return;
  handleCanvasTap(event);
}

/** 渲染右栏「仿真结果」面板（全 DOM API，无拼接） */
function renderSimPanel() {
  if (!board) return;
  const host = board.simHost;
  if (!host) return;
  host.replaceChildren();

  const head = document.createElement('div');
  head.className = 'sim-head';
  const title = document.createElement('span');
  title.className = 'sim-title';
  title.textContent = '仿真结果';
  const run = document.createElement('button');
  run.type = 'button';
  run.className = 'btn btn-ghost sim-run';
  run.dataset.simAction = 'run';
  run.textContent = '重新仿真';
  head.append(title, run);
  host.append(head);

  const sim = board.sim;
  if (!sim) {
    const hint = document.createElement('p');
    hint.className = 'sim-empty';
    hint.textContent = '尚未仿真。电路一改就会自动重算，也可以点「重新仿真」。';
    host.append(hint);
    return;
  }

  const result = sim.result || {};
  const status = document.createElement('p');
  status.className = 'sim-status';

  if (!result.ok) {
    status.classList.add('is-error');
    status.textContent = `直流工作点 · ${result.error || '求解失败'}`
      + (result.detail ? `（${result.detail}）` : '');
  } else if (result.elementResults.length === 0) {
    status.classList.add('is-idle');
    status.textContent = '直流工作点 · 暂无可分析元件';
  } else {
    status.classList.add('is-ok');
    const iter = result.convergence ? result.convergence.iter : 0;
    const residual = result.convergence ? result.convergence.residual : 0;
    const resText = Number.isFinite(residual) ? ` · 残差 ${formatResidual(residual)}` : '';
    status.textContent = `直流工作点 · 收敛（迭代 ${iter} 次${resText} · ${sim.cost} ms）`;
  }
  host.append(status);

  if (sim.drove && sim.drives && sim.drives.length > 0) {
    const note = document.createElement('p');
    note.className = 'sim-note sim-drive-note';
    note.textContent = `数字输出回灌：${sim.drives
      .map((drive) => `${drive.netId}=${levelText(drive.level)}`)
      .join('、')}`;
    host.append(note);
  }

  if (result.nodeVoltages && result.nodeVoltages.length > 0) {
    host.append(buildSimBlock('节点电压', buildNodeRows(result), result));
  }
  if (result.elementResults && result.elementResults.length > 0) {
    host.append(buildSimBlock('元件结果', buildElementCards(result), result));
  }

  if (result.warnings && result.warnings.length > 0) {
    const box = document.createElement('div');
    box.className = 'sim-warns';
    result.warnings.forEach((text) => {
      const line = document.createElement('p');
      line.className = 'sim-warn';
      line.textContent = text;
      box.append(line);
    });
    host.append(box);
  }
}

/* ==========================================================================
   数字状态面板
   ========================================================================== */

/** 渲染右栏「数字状态」面板：网络电平 + 器件输出 + 时钟/脉冲控制条 */
function renderDigPanel() {
  if (!board) return;
  const host = board.digHost;
  if (!host) return;
  host.replaceChildren();

  const circuit = model.getState();
  const components = circuit && Array.isArray(circuit.components) ? circuit.components : [];
  const clocks = components.filter((comp) => comp.type === 'clock');
  const pulses = components.filter((comp) => comp.type === 'pulse');

  const head = document.createElement('div');
  head.className = 'sim-head';
  const title = document.createElement('span');
  title.className = 'sim-title';
  title.textContent = '数字状态';
  head.append(title);

  const tools = document.createElement('div');
  tools.className = 'dig-tools';
  if (clocks.length > 0) {
    const step = document.createElement('button');
    step.type = 'button';
    step.className = 'btn btn-ghost sim-run';
    step.dataset.digAction = 'step';
    step.title = '一个步进 = 一个完整时钟周期（产生一次上升沿）';
    step.textContent = '时钟步进';
    tools.append(step);
  }
  if (pulses.length > 0) {
    const fire = document.createElement('button');
    fire.type = 'button';
    fire.className = 'btn btn-ghost sim-run';
    fire.dataset.digAction = 'pulse';
    fire.dataset.componentId = pulses[0].id;
    fire.title = `触发 ${pulses[0].id}`;
    fire.textContent = '触发脉冲';
    tools.append(fire);
  }
  if (tools.childElementCount > 0) head.append(tools);
  host.append(head);

  const sim = board.sim;
  const dig = sim ? sim.dig : null;

  const status = document.createElement('p');
  status.className = 'sim-status';

  if (!dig) {
    status.classList.add('is-idle');
    status.textContent = '尚未仿真。';
    host.append(status);
    return;
  }

  if (!dig.hasDigital) {
    status.classList.add('is-idle');
    status.textContent = '电路里没有数字元件。';
    host.append(status);
    return;
  }

  if (!dig.ok) {
    status.classList.add('is-error');
    status.textContent = `数字逻辑 · ${dig.error || '求解失败'}`;
    host.append(status);

    if (dig.cycle && dig.cycle.length > 0) {
      const box = document.createElement('div');
      box.className = 'sim-warns';
      const line = document.createElement('p');
      line.className = 'sim-warn';
      line.textContent = `环：${dig.cycle.join(' → ')}`;
      box.append(line);
      host.append(box);
    }
    appendWarnings(host, dig.warnings);
    return;
  }

  status.classList.add('is-ok');
  const clockText = clocks.length > 0 ? ` · 时钟 ${levelText(digClockLevel(dig, clocks[0]))}` : '';
  status.textContent = `数字逻辑 · ${dig.units.length} 个单元 / ${dig.digNets.length} 个网络`
    + `（${dig.elapsedMs} ms）${clockText}`;
  host.append(status);

  if (dig.digNets.length > 0) {
    host.append(buildDigBlock('网络电平', buildDigNetRows(dig), dig.digNets.length));
  }
  if (dig.compStates.length > 0) {
    host.append(buildDigBlock('逻辑器件', buildDigCards(dig), dig.compStates.length));
  }
  appendWarnings(host, dig.warnings);
}

/** 时钟当前电平：从器件输出里取（solveDig 已经把源的状态算进去了） */
function digClockLevel(dig, clockComp) {
  const record = dig.compStates.find((item) => item.componentId === clockComp.id);
  if (!record) return null;
  return record.outputs['+'];
}

function appendWarnings(host, warnings) {
  if (!warnings || warnings.length === 0) return;
  const box = document.createElement('div');
  box.className = 'sim-warns';
  warnings.forEach((text) => {
    const line = document.createElement('p');
    line.className = 'sim-warn';
    line.textContent = text;
    box.append(line);
  });
  host.append(box);
}

function buildDigBlock(titleText, body, total) {
  const block = document.createElement('div');
  block.className = 'sim-block';
  const heading = document.createElement('p');
  heading.className = 'sim-block-title';
  heading.textContent = titleText;
  block.append(heading, body.node);
  if (body.shown < total) {
    const more = document.createElement('p');
    more.className = 'sim-note';
    more.textContent = `仅显示前 ${body.shown} 项，共 ${total} 项`;
    block.append(more);
  }
  return block;
}

/** 三值电平小标签 */
function levelChip(level) {
  const chip = document.createElement('span');
  chip.className = 'dig-chip';
  if (level === 1) chip.classList.add('is-hi');
  else if (level === 0) chip.classList.add('is-lo');
  else if (level === null) chip.classList.add('is-none');
  else chip.classList.add('is-x');
  chip.textContent = level === null ? '—' : levelBadge(level);
  return chip;
}

function buildDigNetRows(dig) {
  const wrap = document.createElement('div');
  wrap.className = 'sim-rows';
  const list = dig.digNets.slice(0, SIM_ROW_LIMIT);
  list.forEach((net) => {
    const row = document.createElement('div');
    row.className = 'sim-row';
    if (net.conflict) row.classList.add('is-conflict');
    if (net.level === 1) row.classList.add('is-hi');
    else if (net.level === 0) row.classList.add('is-lo');
    else row.classList.add('is-x');

    const key = document.createElement('span');
    key.className = 'sim-row-key';
    key.textContent = net.conflict ? `${net.netId}（竞争）` : net.netId;

    const val = document.createElement('span');
    val.className = 'sim-row-val dig-net-val';
    const text = document.createElement('span');
    text.className = 'dig-net-text';
    text.textContent = levelText(net.level);
    val.append(text, levelChip(net.level));

    row.append(key, val);
    wrap.append(row);
  });
  return { node: wrap, shown: list.length };
}

function buildDigCards(dig) {
  const wrap = document.createElement('div');
  wrap.className = 'sim-cards';
  const list = dig.compStates.slice(0, SIM_ROW_LIMIT);
  list.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'sim-card';

    const head = document.createElement('div');
    head.className = 'sim-card-head';
    const name = document.createElement('span');
    name.className = 'sim-card-name';
    name.textContent = item.componentId;
    const tag = document.createElement('span');
    tag.className = 'sim-card-tag';
    tag.textContent = item.label;
    head.append(name, tag);

    const pins = document.createElement('div');
    pins.className = 'dig-pins';
    Object.keys(item.outputs).forEach((pin) => {
      const level = item.outputs[pin];
      const wired = !item.wired || item.wired[pin] !== false;
      const entry = document.createElement('span');
      entry.className = 'dig-pin';
      if (!wired) entry.classList.add('is-unwired');
      const label = document.createElement('span');
      label.className = 'dig-pin-label';
      label.textContent = pin;
      entry.append(label, levelChip(level));
      if (!wired) {
        const hint = document.createElement('span');
        hint.className = 'dig-pin-hint';
        hint.textContent = '未接';
        entry.append(hint);
      }
      pins.append(entry);
    });

    card.append(head, pins);

    // 触发器补充一行时序信息：这一轮是不是踩到了上升沿
    const edgeUnit = item.units.find((unit) => unit.edge);
    if (edgeUnit) {
      const note = document.createElement('p');
      note.className = 'sim-note dig-edge';
      note.textContent = `${edgeUnit.label} · 上升沿采样`;
      card.append(note);
    }

    wrap.append(card);
  });
  return { node: wrap, shown: list.length };
}

/** 一个带标题的结果区块；超出展示上限时补一行省略说明 */
function buildSimBlock(titleText, body, result) {
  const block = document.createElement('div');
  block.className = 'sim-block';
  // 元件结果随电路规模增长，条目越多这一段越高；限高后内部滚动，
  // 免得把右栏撑长、把下面的「数字状态」挤出可视区。
  if (titleText === '元件结果') block.classList.add('is-capped');
  const heading = document.createElement('p');
  heading.className = 'sim-block-title';
  heading.textContent = titleText;
  block.append(heading);
  block.append(body.node);

  const total = titleText === '节点电压'
    ? (result.nodeVoltages ? result.nodeVoltages.length : 0)
    : (result.elementResults ? result.elementResults.length : 0);
  if (body.shown < total) {
    const more = document.createElement('p');
    more.className = 'sim-note';
    more.textContent = `仅显示前 ${body.shown} 项，共 ${total} 项`;
    block.append(more);
  }
  return block;
}

/** 节点电压行 */
function buildNodeRows(result) {
  const wrap = document.createElement('div');
  wrap.className = 'sim-rows';
  const list = result.nodeVoltages.slice(0, SIM_ROW_LIMIT);
  list.forEach((node) => {
    const row = document.createElement('div');
    row.className = 'sim-row';
    if (node.grounded) row.classList.add('is-ground');
    if (node.floating) row.classList.add('is-floating');

    const key = document.createElement('span');
    key.className = 'sim-row-key';
    key.textContent = node.grounded ? `${node.netId}（地）` : node.netId;

    const val = document.createElement('span');
    val.className = 'sim-row-val';
    val.textContent = node.floating ? '悬空' : formatVolt(node.v);

    row.append(key, val);
    wrap.append(row);
  });
  return { node: wrap, shown: list.length };
}

/** 元件 V / I / P 卡片 */
function buildElementCards(result) {
  const wrap = document.createElement('div');
  wrap.className = 'sim-cards';
  const list = result.elementResults.slice(0, SIM_ROW_LIMIT);
  list.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'sim-card';

    const head = document.createElement('div');
    head.className = 'sim-card-head';
    const name = document.createElement('span');
    name.className = 'sim-card-name';
    name.textContent = item.componentId;
    const tag = document.createElement('span');
    tag.className = 'sim-card-tag';
    tag.textContent = item.note ? `${item.label} · ${item.note}` : item.label;
    head.append(name, tag);

    const metrics = document.createElement('div');
    metrics.className = 'sim-metrics';
    metrics.append(
      buildMetric('V', formatVolt(item.v)),
      buildMetric('I', formatAmp(item.i)),
      buildMetric('P', formatWatt(item.power)),
    );

    card.append(head, metrics);
    wrap.append(card);
  });
  return { node: wrap, shown: list.length };
}

function buildMetric(key, value) {
  const box = document.createElement('span');
  box.className = 'sim-metric';
  const k = document.createElement('span');
  k.className = 'sim-metric-key';
  k.textContent = key;
  const v = document.createElement('span');
  v.className = 'sim-metric-val';
  v.textContent = value;
  box.append(k, v);
  return box;
}

/* ==========================================================================
   平台切换
   ========================================================================== */

/** 元件是否落在某平台边界内 */
function fitsPlatform(comp, platform) {
  const rect = model.rectOf(comp);
  return rect.x >= 0 && rect.y >= 0
    && rect.x + rect.w <= platform.cols
    && rect.y + rect.h <= platform.rows;
}

/**
 * 切换平台。已有电路尽量保留：
 *  - 边界内且不冲突的元件原地保留；
 *  - 放不下的元件移入目标平台的暂存区（切回来时自动恢复）；
 *  - 连到旧平台孔位的导线保留为"悬空导线"并标红，切回原平台会自动复活。
 */
function applyPlatform(nextId) {
  if (!board || !platforms.isPlatformId(nextId)) return false;
  const platform = platforms.getPlatform(nextId);
  const circuit = model.getState();

  const stashed = circuit.components.filter((comp) => !fitsPlatform(comp, platform));

  model.setPlatform(nextId);

  if (stashed.length > 0) {
    const ids = new Set(stashed.map((comp) => comp.id));
    const innerWires = circuit.wires.filter(
      (wire) => ids.has(wire.a.componentId) && ids.has(wire.b.componentId),
    );
    model.stashComponents(nextId, stashed, innerWires);
    stashed.forEach((comp) => model.removeComponent(comp.id));
  }

  // 恢复目标平台暂存区里放得下的元件
  const bucket = model.takeStash(nextId);
  let restored = 0;
  bucket.components.forEach((raw) => {
    const added = model.addComponent(raw.type, raw.x, raw.y, {
      rotation: raw.rotation,
      params: raw.params,
      id: raw.id,
      silent: true,
    });
    if (added.ok) restored += 1;
  });

  // 平台切换属于结构性变更，撤销栈里的旧坐标已无意义
  model.clearUndo();

  board.platformId = nextId;
  board.scene.platform = platform;
  invalidatePlatformLayer();
  relayout();
  refreshHealth();
  renderPropsForce();
  scheduleSave();

  const notes = [`已切换到${PLATFORM_LABEL[nextId] || nextId}`];
  if (stashed.length > 0) notes.push(`${stashed.length} 个元件暂存（切回后恢复）`);
  if (restored > 0) notes.push(`恢复 ${restored} 个暂存元件`);
  if (board.report && board.report.danglingWires.length > 0) {
    notes.push(`${board.report.danglingWires.length} 条导线悬空（已标红）`);
  }
  board.onToast(notes.join('，'), stashed.length > 0 ? 'info' : 'success');
  board.onPlatformChange(nextId, board.locked);
  requestRender();
  notifyModelChange('platform');
  scheduleSimulation();
  return true;
}

/* ==========================================================================
   初始化 / 销毁
   ========================================================================== */

/**
 * 初始化实验台。
 * @param {object} options { expId, platformId, locked, onToast, onPlatformChange }
 */
export function initBoard(options) {
  destroyBoard();

  const {
    expId,
    platformId,
    locked = false,
    onToast = () => {},
    onPlatformChange = () => {},
  } = options || {};

  const canvas = document.getElementById('breadboard-canvas');
  const host = document.getElementById('canvas-area');
  const schemCanvas = document.getElementById('schematic-canvas');
  const schemHost = document.getElementById('schematic-area');
  const paletteHost = document.getElementById('parts-palette');
  const propsHost = document.getElementById('props-panel');
  const simHost = document.getElementById('sim-panel');
  const digHost = document.getElementById('dig-panel');
  const statusHost = document.getElementById('canvas-status');
  const btnSwitch = document.getElementById('btn-switch-platform');
  if (!canvas || !host) return null;

  const requested = platforms.isPlatformId(platformId) ? platformId : 'exp-box';
  const saved = readSave(expId);
  const restoredPlatform = !locked && saved && platforms.isPlatformId(saved.platform)
    ? saved.platform
    : requested;

  if (saved) model.loadCircuit(saved, restoredPlatform);
  else model.createCircuit(restoredPlatform);

  // 换实验/载入存档 = 断电重上：时钟相位、脉冲电平、触发器记忆全部清零，
  // 否则上一个实验里残留的 Q=1 会跟着新电路一起"开机就有电"。
  resetDigState();

  const view = createView(canvas);
  const scene = {
    platform: platforms.getPlatform(restoredPlatform),
    // 始终取活引用：model.loadCircuit / createCircuit 会整体替换 state 对象，
    // 若这里存死引用，换存档后 pickAt/渲染会看到旧电路（元件点不中、导线看不见）
    get circuit() { return model.getState(); },
    selection: null,
    hover: null,
    hoverGroup: null,
    wiring: null,
    pointer: null,
    pointerInside: false,
    ghost: null,
    dangling: new Set(),
    lens: { on: false },
    // 删除预告：临时保存将被删导线的几何，render 层用醒目色闪一下（~150ms）
    pendingFlash: null,
    // 仿真计算"进行中"标志（防抖等待期即置位，供状态行显示"计算中…"）
    simPending: false,
  };

  board = {
    expId,
    locked,
    view,
    scene,
    canvas,
    host,
    paletteHost,
    propsHost,
    simHost,
    digHost,
    statusHost,
    btnSwitch,
    platformId: restoredPlatform,
    onToast,
    onPlatformChange,
    propsKey: '',
    report: null,
    sim: null,
    saveOk: true,
    handlers: {},
    observer: null,
    interaction: null,
  };

  // 暂态运行态（分帧运行中 / 最近一次结果）
  board.transientRun = { active: false, handle: null, last: null };
  // 故障注入（包 13）：求解前临时变换，不改 model 本体
  board.faults = [];

  board.interaction = createInteraction({
    canvas,
    paletteHost,
    view,
    scene,
    requestRender,
    toast: onToast,
    onChange: handleChange,
    onSelectionChange: () => {
      renderProps();
      // 选中变化是轻量事件：原理图只需重画高亮，不重建布局与连线
      syncSchematicSelection();
      requestRender();
    },
  });

  board.interaction.buildPalette();
  board.interaction.attach();

  // 点元件本体：逻辑开关拨动 / 脉冲源触发（与实验箱上的手指动作对应）
  board.handlers.canvasDown = markCanvasDown;
  board.handlers.canvasUp = finishCanvasTap;
  canvas.addEventListener('pointerdown', board.handlers.canvasDown);
  canvas.addEventListener('pointerup', board.handlers.canvasUp);

  // 原理图视图：与实验台共用同一个 model 实例和同一个 scene.selection，
  // 所以「双向联动」不需要两套状态同步，只靠事件桥 + 共享选中态。
  if (schemCanvas && schemHost) {
    initSchematic({
      canvas: schemCanvas,
      host: schemHost,
      getSelection: () => (board ? board.scene.selection : null),
      setSelection: (selection) => applySelection(selection),
      toast: onToast,
      // 原理图自己的操作（放置 / 删除 / 连线）走回实验台的统一收尾：
      // 存档、体检、属性面板、实验台重绘一次都不会漏。
      onModelChange: (reason) => handleChange(reason),
    });
    // 反向：实验台的任何变更都要通知原理图重算布局与连线。
    // 这一条订阅是「单向 A」的全部实现——两视图共用 model，无需搬数据。
    onModelChange(() => refreshSchematic());
  }

  // 画布容器尺寸变化
  if (typeof ResizeObserver === 'function') {
    board.observer = new ResizeObserver(() => relayout());
    board.observer.observe(host);
  }
  board.handlers.resize = () => relayout();
  window.addEventListener('resize', board.handlers.resize);

  // 属性面板事件委托
  if (propsHost) {
    board.handlers.propsChange = handlePropsChange;
    board.handlers.propsClick = handlePropsClick;
    propsHost.addEventListener('change', board.handlers.propsChange);
    propsHost.addEventListener('click', board.handlers.propsClick);
  }

  // 仿真面板：按钮用委托（面板内容每次重建，直接绑按钮会丢监听）
  board.handlers.simClick = (event) => {
    if (!board) return;
    const runBtn = event.target.closest('[data-sim-action="run"]');
    if (runBtn) {
      simulateNow('manual');
      return;
    }
    const digBtn = event.target.closest('[data-dig-action]');
    if (!digBtn) return;
    if (digBtn.dataset.digAction === 'step') runClockStep();
    else if (digBtn.dataset.digAction === 'pulse') runPulse(digBtn.dataset.componentId);
  };
  if (simHost) simHost.addEventListener('click', board.handlers.simClick);
  if (digHost) digHost.addEventListener('click', board.handlers.simClick);
  renderSimPanel();
  renderDigPanel();

  // 平台切换按钮
  if (btnSwitch) {
    board.handlers.switchPlatform = () => {
      if (board.locked) {
        board.onToast('该实验已标注平台，平台已锁定');
        return;
      }
      applyPlatform(board.platformId === 'exp-box' ? 'breadboard' : 'exp-box');
    };
    btnSwitch.addEventListener('click', board.handlers.switchPlatform);
  }

  // 完成后：布局、体检、属性面板、首帧
  relayout();
  refreshHealth();
  renderProps();
  onPlatformChange(restoredPlatform, locked);
  requestRender();

  // 调试与自动化探针入口
  window.__labBoard = {
    view,
    perf,
    model,
    platforms,
    schematic: schematicApi(),
    onModelChange: (callback) => onModelChange(callback),
    get scene() {
      return board ? board.scene : null;
    },
    get platformId() {
      return board ? board.platformId : null;
    },
    get report() {
      return board ? board.report : null;
    },
    get locked() {
      return board ? board.locked : false;
    },
    project: (gx, gy) => project(view, gx, gy),
    // 画布覆盖层注册每帧回调（当前仅探针标记用；传 null 注销）
    onAfterRender: (fn) => {
      if (board) board.onAfterRender = typeof fn === 'function' ? fn : null;
      return Boolean(board && board.onAfterRender);
    },
    pick: (x, y) => pickAt(view, board ? board.scene : scene, x, y),
    nodeAt: (gx, gy) => (board ? platforms.nodesAt(board.platformId, gx, gy) : []),
    // 7B 探针支持：端子的网格/屏幕坐标（拖拽连线、光标、右键删除探针需要真实坐标）
    geometry: {
      terminal: (componentId, terminalName) => {
        const comp = model.findComponent(componentId);
        return comp ? terminalPos(comp, terminalName) : null;
      },
      terminals: (componentId) => {
        const comp = model.findComponent(componentId);
        if (!comp) return [];
        return comp.terminals.map((terminal) => ({
          name: terminal.name,
          ...terminalPos(comp, terminal.name),
        }));
      },
      screenTerminal: (componentId, terminalName) => {
        const comp = model.findComponent(componentId);
        return comp ? terminalScreenPos(view, comp, terminalName) : null;
      },
    },
    switchPlatform: (id) => applyPlatform(id),
    place: (type, x, y) => board.interaction.placeComponent(type, x, y),
    undo: () => board.interaction.undo(),
    deleteSelection: () => board.interaction.deleteSelection(),
    // 7B 交互探针入口：重做 / 旋转 / 连续放置 / 右键删除（右键走 canvas 原生事件）
    interact: {
      redo: () => board.interaction.redo(),
      rotate: () => board.interaction.rotateSelection(),
      continuousPlace: (on) => board.interaction.setContinuousPlace(on),
      isContinuousPlace: () => board.interaction.isContinuousPlace(),
      contextmenu: (clientX, clientY) => {
        if (!board || !board.canvas) return false;
        board.canvas.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX, clientY }),
        );
        return true;
      },
    },
    setSelection: (selection) => applySelection(selection),
    relayout: () => relayout(),
    // 仿真调试入口：solve 立即重算，last 取上一次结果，report 取格式化文本
    simdc: {
      solve: (reason) => simulateNow(reason || 'probe'),
      last: () => (board ? (board.sim ? board.sim.result : null) : null),
      report: () => {
        const result = board && board.sim ? board.sim.result : null;
        return reportFormat(result);
      },
      stats: () => ({ ...simStats }),
    },
    // 数字域：稳态结果 / 时钟步进 / 脉冲触发 / LED 亮灭
    simdig: {
      solve: (reason) => simulateNow(reason || 'probe-dig'),
      // 结构缓存统计（指令包 14 遗留建议 1）：探针用它证明缓存命中且结果不变
      cache: () => digPlanCacheStats(),
      resetCache: () => { resetDigPlanCache(); return true; },
      last: () => (board && board.sim ? board.sim.dig : null),
      leds: () => (board && board.sim ? board.sim.leds : []),
      stepClock: () => runClockStep(),
      triggerPulse: (componentId) => runPulse(componentId),
      reset: () => resetDigState(),
      toggleSwitch: (componentId) => {
        const comp = model.findComponent(componentId);
        if (!comp || comp.type !== 'logic-switch') return null;
        model.updateParams(comp.id, { state: comp.params.state === 'hi' ? 'lo' : 'hi' });
        handleChange('toggle');
        return comp.params.state;
      },
    },
    // 同步渲染一帧（性能基准 B4 / 截图用；正常画面仍走 rAF 合并）
    renderNow: () => {
      if (!board) return false;
      renderScene(board.view, board.scene);
      return true;
    },
    // 故障注入（指令包 13）：探针/配置面板设置
    simModel: () => simModel(),
    setFaults: (list) => {
      board.faults = Array.isArray(list) ? list.filter((f) => f && f.componentId) : [];
      simulateNow('faults');
      return board.faults.length;
    },
    faults: () => board.faults.slice(),
    // 混合信号边界层（指令包 8）：供探针读取边界状态 / 环路 / 阈值
    simmix: {
      state: () => mixStateSnapshot(),
      stateOf: (id) => mixStateOf(id),
      units: () => collectMix(model.getState(), model.getNetlist().netOf).units.map((unit) => ({
        componentId: unit.componentId,
        kind: unit.kind,
        vccNet: unit.vccNet,
        gndNet: unit.gndNet,
        inputs: unit.inputs,
        outputs: unit.outputs,
      })),
      threshold: (params, supply) => comparatorThreshold(params || {}, supply),
      loops: () => {
        const netlist = model.getNetlist();
        const collected = collectMix(model.getState(), netlist.netOf);
        return analyzeMixLoops({
          state: model.getState(),
          netOf: netlist.netOf,
          mixUnits: collected.units,
          digitalUnits: collectDigitalUnits(model),
        });
      },
      maxIter: () => MAX_MIX_ITER,
      reset: () => { resetMixState(); return true; },
    },
    // 暂态仿真入口（指令包 7）：与 simdc/simdig 同契约风格
    simtrans: {
      // 同步跑完返回结果（测试/一次性求解用）
      // 同步求解并记住结果：示波器/逻辑分析仪读的就是"最近一次"
      solve: (opts) => {
        const res = solveTransient(simModel(), opts || {});
        board.transientRun.last = res;
        return res;
      },
      last: () => board.transientRun.last,
      running: () => board.transientRun.active,
      // 分帧异步运行：每帧算一小段，进度回报 hooks，可随时 stop
      start: (opts, hooks) => {
        if (board.transientRun.active) return { ok: false, error: '暂态仿真正在运行中', stop: () => {} };
        board.transientRun.active = true;
        const handle = runTransient(simModel(), opts || {}, {
          onProgress: (done, total) => {
            if (hooks && typeof hooks.onProgress === 'function') hooks.onProgress(done, total);
          },
          onChunk: (merged) => {
            board.transientRun.last = merged;
            if (hooks && typeof hooks.onChunk === 'function') hooks.onChunk(merged);
          },
          onDone: (merged, cancelled) => {
            board.transientRun.active = false;
            board.transientRun.handle = null;
            board.transientRun.last = merged;
            if (hooks && typeof hooks.onDone === 'function') hooks.onDone(merged, cancelled);
          },
          onError: (part) => {
            board.transientRun.active = false;
            board.transientRun.handle = null;
            board.transientRun.last = part;
            if (hooks && typeof hooks.onError === 'function') hooks.onError(part);
          },
        });
        board.transientRun.handle = handle;
        return handle;
      },
      stop: () => {
        if (board.transientRun.handle) board.transientRun.handle.stop();
        return true;
      },
      waveforms: () => (board.transientRun.last ? board.transientRun.last.waveforms : []),
      channels: () => (board.transientRun.last ? board.transientRun.last.channels : []),
      stats: () => (board.transientRun.last ? board.transientRun.last.stats : null),
      // 清结果 + 电容状态清零（断电重上语义，同包 6 resetDigState）
      reset: () => {
        if (board.transientRun.handle) board.transientRun.handle.stop();
        board.transientRun.active = false;
        board.transientRun.handle = null;
        board.transientRun.last = null;
        resetTransientState();
        return true;
      },
    },
    save: () => {
      saveNow();
      return true;
    },
    requestRender,
    // 视图缩放 / 平移 / 放大镜（包 7A）：全部为渲染层状态，不触碰 model
    zoom: {
      levels: () => ZOOM_LEVELS.slice(),
      level: () => getZoom(view),
      set: (scale) => { setZoom(view, scale); requestRender(); },
      in: () => { zoomIn(view); requestRender(); },
      out: () => { zoomOut(view); requestRender(); },
      reset: () => { resetView(view); requestRender(); },
      pan: (x, y) => { setPan(view, x, y); requestRender(); },
    },
    focus: {
      enable: (mode) => { if (scene.lens) { scene.lens.on = true; requestRender(); } },
      disable: () => { if (scene.lens) { scene.lens.on = false; requestRender(); } },
      onGrid: (gx, gy, scale) => { focusOnGrid(view, gx, gy, scale); requestRender(); },
    },
    lens: {
      on: () => { if (scene.lens) { scene.lens.on = true; requestRender(); } },
      off: () => { if (scene.lens) { scene.lens.on = false; requestRender(); } },
      isOn: () => Boolean(scene.lens && scene.lens.on),
      setPointer: (x, y) => { scene.pointer = { x, y }; requestRender(); },
    },
  };

  if (saved) {
    const restoredCount = model.getState().components.length;
    if (restoredCount > 0) {
      onToast(`已恢复上次的电路（${restoredCount} 个元件）`, 'success');
    }
  }

  return board;
}

/** 销毁实验台：落盘 + 解绑 + 停帧 */
export function destroyBoard() {
  if (!board) return;
  if (saveTimer) {
    window.clearTimeout(saveTimer);
    saveTimer = 0;
  }
  saveNow();

  if (rafHandle) {
    cancelAnimationFrame(rafHandle);
    rafHandle = 0;
  }

  if (board.transientRun && board.transientRun.handle) board.transientRun.handle.stop();
  resetTransientState();
  resetMixState();
  if (board.interaction) board.interaction.detach();
  destroySchematic();
  changeListeners = [];
  if (simTimer) {
    window.clearTimeout(simTimer);
    simTimer = 0;
  }
  if (board.observer) board.observer.disconnect();
  if (board.handlers.resize) window.removeEventListener('resize', board.handlers.resize);

  if (board.propsHost) {
    board.propsHost.removeEventListener('change', board.handlers.propsChange);
    board.propsHost.removeEventListener('click', board.handlers.propsClick);
    board.propsHost.replaceChildren();
  }
  if (board.btnSwitch) board.btnSwitch.removeEventListener('click', board.handlers.switchPlatform);
  if (board.paletteHost) board.paletteHost.replaceChildren();
  if (board.statusHost) board.statusHost.textContent = '';
  if (board.simHost) {
    board.simHost.removeEventListener('click', board.handlers.simClick);
    board.simHost.replaceChildren();
  }
  if (board.digHost) {
    board.digHost.removeEventListener('click', board.handlers.simClick);
    board.digHost.replaceChildren();
  }
  if (board.canvas) {
    board.canvas.removeEventListener('pointerdown', board.handlers.canvasDown);
    board.canvas.removeEventListener('pointerup', board.handlers.canvasUp);
  }
  board.tapStart = null;

  if (window.__labBoard) {
    // 先把 schematic / simdc / simdig 置空再删除入口：外部若持有旧引用，读到的也是 null
    window.__labBoard.schematic = null;
    window.__labBoard.simdc = null;
    window.__labBoard.simdig = null;
    delete window.__labBoard;
  }
  board = null;
}

/** 当前实验台是否在工作区 */
export function isBoardActive() {
  return Boolean(board);
}

/** 供快捷键调用：等价于点面板上的「时钟步进」 */
export function stepClockNow() {
  return runClockStep();
}

/** 供外部读取的性能采样 */
export function getPerf() {
  return perf;
}

/** 重新量画布尺寸并重绘（视图切换回实验台时调用） */
export function relayoutBoard() {
  relayout();
}

/** 当前模式下的原理图重排（视图切到原理图时调用） */
export function relayoutSchematicView() {
  return relayoutSchematic();
}
