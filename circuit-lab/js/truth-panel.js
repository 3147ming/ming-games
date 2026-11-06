/**
 * truth-panel.js — 真值表 / 卡诺图面板（阶段 2 · R5）
 *
 * 职责：DOM 渲染 + 变量识别 + 枚举接线。算法全在 truth-table.js，
 * 电路求值复用 examples-measure.js 的同款 solveCoupled 口径。
 * 扫描会**真的改开关状态**（updateParams），所以必须保存原态并在 finally 里恢复，
 * 否则学生切回实验台会发现开关全被扫成最后一组 111…。
 */

import { buildTruthTable, varNames } from './truth-table.js';
import { solveCoupled } from './simdig.js';

/** 面板状态：勾选态 / 输出选择 / 最近一次结果（切 tab 回来仍在） */
const ui = { enabled: {}, output: null, last: null, lastSig: null };

/** 给探针用的只读状态快照 */
export function truthPanelState() {
  return {
    enabled: { ...ui.enabled },
    output: ui.output ? { ...ui.output } : null,
    last: ui.last ? {
      ok: ui.last.ok,
      error: ui.last.error,
      rows: ui.last.table ? ui.last.table.rows.length : 0,
      n: ui.last.table ? ui.last.table.n : 0,
      expression: ui.last.qm ? ui.last.qm.expression : null,
      kmapOk: ui.last.kmap ? ui.last.kmap.ok : false,
      cells: ui.last.kmap ? ui.last.kmap.cells.length : 0,
      groups: ui.last.kmap ? ui.last.kmap.groups.length : 0,
    } : null,
  };
}

/** 可控输入：逻辑电平开关 1 位、4 位拨码 4 位 */
function collectVars(comps) {
  const out = [];
  (comps || []).forEach((comp) => {
    if (comp.type === 'logic-switch') {
      out.push({
        key: `${comp.id}:state`, compId: comp.id, param: 'state',
        onVal: 'hi', offVal: 'lo', label: comp.id,
      });
    } else if (comp.type === 'dip4') {
      for (let i = 1; i <= 4; i += 1) {
        out.push({
          key: `${comp.id}:s${i}`, compId: comp.id, param: `s${i}`,
          onVal: 'on', offVal: 'off', label: `${comp.id}.s${i}`,
        });
      }
    }
  });
  return out;
}

/** 从联合求解结果里列出所有可选输出引脚 */
function outputOptions(model) {
  let dig = {};
  try { dig = solveCoupled(model).dig || {}; } catch (_) { return []; }
  const opts = [];
  (dig.compStates || []).forEach((st) => {
    Object.keys(st.outputs || {}).forEach((pin) => {
      opts.push({
        key: `${st.componentId}|${pin}`,
        componentId: st.componentId,
        pin,
        label: `${st.componentId}.${pin}`,
      });
    });
  });
  return opts;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 枚举一次真值表，扫完恢复开关原态 */
function scan(model, active, output, afterScan) {
  const comps = model.getState().components || [];
  const saved = active.map((v) => {
    const comp = comps.find((c) => c.id === v.compId);
    return { compId: v.compId, param: v.param, value: comp && comp.params ? comp.params[v.param] : undefined };
  });
  const evaluate = (bits) => {
    active.forEach((v, i) => {
      model.updateParams(v.compId, { [v.param]: bits[i] ? v.onVal : v.offVal });
    });
    let dig = {};
    try { dig = solveCoupled(model).dig || {}; } catch (_) { return 'X'; }
    const st = (dig.compStates || []).find((c) => c.componentId === output.componentId);
    const level = st && st.outputs ? st.outputs[output.pin] : null;
    if (level === 1 || level === '1') return 1;
    if (level === 0 || level === '0') return 0;
    return 'X';
  };
  try {
    return buildTruthTable(active, evaluate);
  } finally {
    saved.forEach((s) => {
      if (s.value !== undefined) model.updateParams(s.compId, { [s.param]: s.value });
    });
    if (typeof afterScan === 'function') afterScan();
  }
}

/* ==========================================================================
   卡诺图 Canvas
   ========================================================================== */

function spansOf(list) {
  const sorted = [...new Set(list)].sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const segs = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] === prev + 1) prev = sorted[i];
    else { segs.push([start, prev]); start = sorted[i]; prev = sorted[i]; }
  }
  segs.push([start, prev]);
  return segs;
}

function drawKmap(canvas, kmap) {
  if (!canvas || !kmap || !kmap.ok) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = canvas.clientWidth || 300;
  const H = canvas.clientHeight || Math.max(160, Math.min(230, 40 * kmap.rowLabels.length + 46));
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const rows = kmap.rowLabels.length;
  const cols = kmap.colLabels.length;
  const padL = 34;
  const padT = 22;
  const cw = (W - padL - 10) / cols;
  const ch = (H - padT - 10) / rows;

  ctx.font = '11px "Cascadia Mono", Consolas, monospace';
  ctx.fillStyle = '#8ea3b8';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  kmap.colLabels.forEach((label, c) => {
    ctx.fillText(label, padL + (c + 0.5) * cw, padT / 2);
  });
  kmap.rowLabels.forEach((label, r) => {
    ctx.fillText(label, padL / 2, padT + (r + 0.5) * ch);
  });

  kmap.cells.forEach((cell) => {
    const x = padL + cell.c * cw;
    const y = padT + cell.r * ch;
    ctx.fillStyle = cell.value === 1 ? 'rgba(95, 211, 154, 0.16)' : 'rgba(255,255,255,0.02)';
    ctx.fillRect(x, y, cw, ch);
    ctx.strokeStyle = 'rgba(140, 170, 200, 0.28)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, cw, ch);
    ctx.fillStyle = cell.value === 1 ? '#7ee0ac' : cell.value === 'X' ? '#8b96a5' : '#cfd8e3';
    ctx.font = '13px "Cascadia Mono", Consolas, monospace';
    ctx.fillText(cell.value === 'X' ? 'X' : String(cell.value), x + cw / 2, y + ch / 2);
  });

  // 圈：与最简式共用 qm.selected，按行合并成连续矩形（含绕边时拆成两段）
  const palette = ['#f2c14e', '#5aa9e6', '#e2685f', '#c58af0', '#5fd39a'];
  kmap.groups.forEach((group, gi) => {
    ctx.strokeStyle = palette[gi % palette.length];
    ctx.lineWidth = 2;
    const byRow = new Map();
    group.cells.forEach((cell) => {
      if (!byRow.has(cell.r)) byRow.set(cell.r, []);
      byRow.get(cell.r).push(cell.c);
    });
    byRow.forEach((cs, r) => {
      spansOf(cs).forEach(([a, b]) => {
        ctx.strokeRect(
          padL + a * cw + 3, padT + r * ch + 3,
          (b - a + 1) * cw - 6, ch - 6,
        );
      });
    });
  });
}

/* ==========================================================================
   面板
   ========================================================================== */

/**
 * @param {HTMLElement} host #truth-body
 * @param {{model:()=>object, afterScan?:Function, onToast?:Function}} ctx
 */
export function renderTruthTab(host, ctx = {}) {
  if (!host) return;
  host.replaceChildren();
  const model = typeof ctx.model === 'function' ? ctx.model() : null;
  if (!model) {
    host.append(el('p', 'tab-empty', '请先进入实验，再打开真值表工具。'));
    return;
  }

  const comps = model.getState().components || [];
  const vars = collectVars(comps);
  const opts = outputOptions(model);
  const head = el('div', 'truth-head');
  head.append(el('h3', 'truth-title', '真值表 / 卡诺图'));
  head.append(el('p', 'truth-hint', '自动列出可控输入，枚举全部组合并给出 Quine-McCluskey 最简式；K 图圈选与表达式共用同一套质蕴涵项。'));
  host.append(head);

  if (vars.length === 0) {
    host.append(el('p', 'truth-empty', '电路里没有可控输入（逻辑电平开关 / 4 位拨码）。放几个开关并接到门电路，再回来刷新。'));
    return;
  }

  // 变量勾选区
  const varBox = el('div', 'truth-vars');
  varBox.append(el('span', 'truth-section-label', '输入变量'));
  vars.forEach((v, index) => {
    if (ui.enabled[v.key] === undefined) ui.enabled[v.key] = index < 6;
    const line = el('label', 'truth-var');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = ui.enabled[v.key];
    cb.dataset.varKey = v.key;
    cb.addEventListener('change', () => {
      ui.enabled[v.key] = cb.checked;
      ui.last = null;
      ui.lastSig = null;
      renderTruthTab(host, ctx);
    });
    line.append(cb, el('span', '', v.label));
    varBox.append(line);
  });
  host.append(varBox);

  if (opts.length === 0) {
    host.append(el('p', 'truth-empty', '没有可测的逻辑输出引脚：请先运行一次数字仿真，或检查门电路是否接好。'));
    return;
  }

  // 输出选择 + 刷新
  if (!ui.output || !opts.some((o) => o.key === ui.output.key)) ui.output = opts[opts.length - 1];
  const ctl = el('div', 'truth-controls');
  const outLabel = el('label', 'truth-row');
  outLabel.append(el('span', '', '输出引脚'));
  const sel = el('select', 'truth-select');
  opts.forEach((o) => {
    const item = document.createElement('option');
    item.value = o.key;
    item.textContent = o.label;
    sel.append(item);
  });
  sel.value = ui.output.key;
  sel.addEventListener('change', () => {
    ui.output = opts.find((o) => o.key === sel.value) || opts[0];
    ui.last = null;
    ui.lastSig = null;
    renderTruthTab(host, ctx);
  });
  outLabel.append(sel);
  ctl.append(outLabel);
  const refresh = el('button', 'btn btn-primary', '刷新真值表');
  refresh.type = 'button';
  refresh.addEventListener('click', () => { ui.last = null; ui.lastSig = null; renderTruthTab(host, ctx); });
  ctl.append(refresh);
  host.append(ctl);

  const active = vars.filter((v) => ui.enabled[v.key] !== false);
  // 缓存必须带「电路结构签名」：学生增删开关 / 换门之后切回本 tab，
  // 变量集合或输出集合一变就要重扫，否则会一直显示上一次的 8 行旧表。
  const sig = [
    vars.map((v) => v.key).join('|'),
    opts.map((o) => o.key).join('|'),
    active.map((v) => v.key).join('|'),
    ui.output ? ui.output.key : '',
  ].join('::');
  if (!ui.last || ui.lastSig !== sig) {
    ui.last = scan(model, active, ui.output, ctx.afterScan);
    ui.lastSig = sig;
  }
  const result = ui.last;

  if (!result || !result.ok) {
    host.append(el('p', 'truth-empty', result ? result.error : '枚举失败'));
    return;
  }

  // 真值表
  const labels = varNames(result.table.n);
  const table = el('table', 'truth-table');
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  labels.forEach((name) => hr.append(el('th', '', name)));
  hr.append(el('th', '', 'Y'));
  thead.append(hr);
  table.append(thead);
  const tbody = document.createElement('tbody');
  result.table.rows.forEach((row) => {
    const tr = document.createElement('tr');
    row.inputs.forEach((bit) => tr.append(el('td', '', String(bit))));
    tr.append(el('td', row.output === 1 ? 'truth-one' : '', row.output === 'X' ? 'X' : String(row.output)));
    tbody.append(tr);
  });
  table.append(tbody);
  host.append(table);

  // 最简式
  const expr = el('p', 'truth-expr', result.qm.expression);
  host.append(expr);
  host.append(el('p', 'truth-hint',
    `${result.table.n} 个变量 · ${result.table.rows.length} 行 · ${result.qm.minterms.length} 个最小项 · ${result.qm.primes.length} 个质蕴涵项 · 选中 ${result.qm.selected.length} 项`));

  // K 图
  host.append(el('span', 'truth-section-label', '卡诺图'));
  if (!result.kmap.ok) {
    host.append(el('p', 'truth-hint', result.kmap.hint));
  } else {
    const canvas = el('canvas', 'truth-kmap');
    canvas.setAttribute('aria-label', '卡诺图');
    host.append(canvas);
    host.append(el('p', 'truth-hint', result.kmap.hint));
    if (result.kmap.groups.length) {
      host.append(el('p', 'truth-hint', `圈选：${result.kmap.groups.map((g) => g.term).join('  ·  ')}`));
    }
    requestAnimationFrame(() => drawKmap(canvas, result.kmap));
  }
}
