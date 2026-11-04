/**
 * app.js — 应用入口：视图切换、实验列表渲染、右栏标签页、配置导入导出
 * 所有动态内容均通过 DOM API 写入（createElement / textContent），不使用 innerHTML 拼接。
 */

import {
  getExperiments,
  getExperimentById,
  addExperiment,
  replaceExperiment,
  validateExperiment,
  normalizeExperiment,
} from './experiments.js';
import { getProgress, setProgress } from './store.js';
import {
  initBoard,
  destroyBoard,
  relayoutBoard,
  relayoutSchematicView,
  simulateNow,
  isBoardActive,
  stepClockNow,
  onModelChange,
} from './board.js';
import { createWaveView } from './waveview.js';
import { createInstruments } from './instruments.js';
import { createProbeMarkers } from './probe-markers.js';
import { createDataPanel } from './data-panel.js';
import { migrateArchive } from './datastore.js';
import { EXAMPLES, getExample, cloneExample } from './examples-data.js';
import { measureExample, circuitSummary } from './examples-measure.js';
import { buildReportHtml } from './report.js';
import {
  PRESET_PLANS,
  applyPlanParams,
  measurePlan,
  gradePlan,
  faultLabel,
} from './experiment-config.js';
import { setInstrumentProvider, setInstrumentRestorer } from './model.js';
import { getPart } from './parts.js';

/** 允许切换的视图 id 白名单 */
const VIEW_IDS = ['view-list', 'view-workspace', 'view-report'];

/** 工作区内的画布视图模式：实验台 / 原理图 */
const BOARD_VIEWS = ['bench', 'schematic'];

/** 当前打开的实验室 id（未进入工作区时为 null） */
let currentExperimentId = null;

/** 当前画布视图（进实验时重置为实验台） */
let boardViewMode = 'bench';

/** 波形查看器句柄（指令包 7）：进实验创建、离开实验销毁 */
let waveView = null;

/** 仪器面板句柄（指令包 10） */
let instruments = null;

/** 画布可拖拽探针标记层（包 15 遗留建议 2） */
let probeMarkers = null;

/** 存档里带的仪器段：面板还没创建时先存这儿，创建后补恢复 */
let pendingInstrumentData = null;

/** 数据面板句柄（指令包 11） */
let dataPanel = null;

/** 当前平台 id（由 board 回调同步，用于切回实验台时恢复标签） */
let currentPlatformId = 'exp-box';

/** DOM 引用集合，只在初始化时查询一次 */
const dom = {
  views: document.querySelectorAll('.view'),
  grid: document.getElementById('exp-grid'),
  listCount: document.getElementById('list-count'),
  workspaceTitle: document.getElementById('workspace-title'),
  workspaceMeta: document.getElementById('workspace-meta'),
  btnImport: document.getElementById('btn-import'),
  btnExport: document.getElementById('btn-export'),
  fileInput: document.getElementById('file-input'),
  btnBack: document.getElementById('btn-back'),
  btnBackReport: document.getElementById('btn-back-report'),
  tabButtons: document.querySelectorAll('.tab'),
  tabPanels: document.querySelectorAll('.tab-panel'),
  expInfoBlock: document.getElementById('exp-info-block'),
  propsPanel: document.getElementById('props-panel'),
  wsPlatform: document.getElementById('ws-platform'),
  btnSwitchPlatform: document.getElementById('btn-switch-platform'),
  canvasTag: document.getElementById('canvas-tag'),
  canvasLabel: document.getElementById('canvas-label'),
  benchArea: document.getElementById('canvas-area'),
  schemArea: document.getElementById('schematic-area'),
  btnViewBench: document.getElementById('btn-view-bench'),
  btnViewSchematic: document.getElementById('btn-view-schematic'),
  btnZoomIn: document.getElementById('btn-zoom-in'),
  btnZoomOut: document.getElementById('btn-zoom-out'),
  btnZoomReset: document.getElementById('btn-zoom-reset'),
  btnLens: document.getElementById('btn-lens'),
  zoomLevel: document.getElementById('zoom-level'),
  btnContPlace: document.getElementById('btn-continuous-place'),
  toastHost: document.getElementById('toast-host'),
  modalHost: document.getElementById('modal-host'),
};

/* ==========================================================================
   视图切换
   ========================================================================== */

/** 切换到指定视图：viewId ∈ view-list / view-workspace / view-report */
function switchView(viewId) {
  if (!VIEW_IDS.includes(viewId)) {
    console.warn(`[switchView] 未知视图 id：${viewId}`);
    return false;
  }
  dom.views.forEach((view) => {
    const isTarget = view.id === viewId;
    view.hidden = !isTarget;
    view.classList.toggle('is-active', isTarget);
  });
  return true;
}

/* ==========================================================================
   工作区画布视图（实验台 / 原理图）
   ========================================================================== */

/** 平台 id → 画布面板标签文字 */
function platformTag(platformId) {
  return platformId === 'breadboard' ? 'BREADBOARD' : 'EXP-BOX';
}

/** 同步画布面板头部（标题 + 标签随视图与平台变化） */
function syncCanvasHead() {
  const isBench = boardViewMode === 'bench';
  if (dom.canvasLabel) dom.canvasLabel.textContent = isBench ? '实验台' : '原理图';
  if (dom.canvasTag) {
    dom.canvasTag.textContent = isBench ? platformTag(currentPlatformId) : 'SCHEMATIC';
  }
}

/**
 * 切换工作区画布视图。只改显隐，两个画布始终存在、各自状态都保留，
 * 绝不重建（更不会创建第二个 model）。
 *
 * 注意：隐藏期间元素尺寸为 0，切过去之后必须重新量一次布局，
 * 否则新显示的画布会停留在上一次的尺寸（甚至 0×0）。
 */
function switchBoardView(mode) {
  if (!BOARD_VIEWS.includes(mode)) return false;
  boardViewMode = mode;

  if (dom.benchArea) dom.benchArea.hidden = mode !== 'bench';
  if (dom.schemArea) dom.schemArea.hidden = mode !== 'schematic';

  // 2.9 视图淡入：目标画布 opacity 0→1（150ms）。纯 CSS transition，
  // 不加 JS 动画循环；先加类置 0，强制回流后再移除，确保过渡真的从 0 起跑。
  const targetArea = mode === 'bench' ? dom.benchArea : dom.schemArea;
  if (targetArea) {
    targetArea.classList.add('is-fading');
    void targetArea.offsetWidth;
    requestAnimationFrame(() => targetArea.classList.remove('is-fading'));
  }

  if (dom.btnViewBench) {
    dom.btnViewBench.classList.toggle('is-active', mode === 'bench');
    dom.btnViewBench.setAttribute('aria-pressed', String(mode === 'bench'));
  }
  if (dom.btnViewSchematic) {
    dom.btnViewSchematic.classList.toggle('is-active', mode === 'schematic');
    dom.btnViewSchematic.setAttribute('aria-pressed', String(mode === 'schematic'));
  }

  syncCanvasHead();
  if (mode === 'schematic') relayoutSchematicView();
  else relayoutBoard();
  return true;
}

/* ==========================================================================
   暂态波形查看器接线（指令包 7.5）
   ========================================================================== */

/**
 * 创建波形查看器并接上 __labBoard.simtrans。
 * 运行/暂停是同一个按钮：在跑就停（波形冻结），没跑就开跑；
 * 清空同时清结果与电容状态（断电重上，同包 6 resetDigState 语义）。
 */
function wireWaveView() {
  const host = document.getElementById('wave-panel');
  if (!host) return;
  if (waveView) waveView.destroy();
  waveView = createWaveView(host, {
    onRun: () => {
      const api = window.__labBoard && window.__labBoard.simtrans;
      if (!api || !waveView) return;
      if (api.running()) {
        api.stop();
        return;
      }
      const opts = waveView.options();
      waveView.setRunning(true, '计算中…');
      const handle = api.start(opts, {
        onProgress: (done, total) => waveView && waveView.setProgress(done, total),
        onChunk: (merged) => waveView && waveView.render(merged),
        onDone: (merged, cancelled) => {
          if (!waveView) return;
          waveView.render(merged);
          waveView.setRunning(false, cancelled ? '已暂停' : '完成');
          if (dataPanel && merged) dataPanel.ingestTransient(merged);
        },
        onError: (part) => {
          if (!waveView) return;
          waveView.setRunning(false, `失败：${(part && part.error) || '未知错误'}`);
        },
      });
      if (!handle || handle.ok === false) {
        waveView.setRunning(false, `失败：${(handle && handle.error) || '无法启动'}`);
      }
    },
    onClear: () => {
      const api = window.__labBoard && window.__labBoard.simtrans;
      if (api) api.reset();
      if (waveView) {
        waveView.clear();
        waveView.setRunning(false, '未运行');
      }
    },
    onOptions: () => {
      // 控件值由 waveView.options() 在运行时读取，这里只留钩子
    },
  });
}

/**
 * 创建仪器面板并接上实验台数据（指令包 10）。
 *
 * 数据口径：
 *   万用表   → 每次仿真结束后的直流结果（订阅 onModelChange + 防抖延时）
 *   示波器/逻辑分析 → __labBoard.simtrans.last()（最近一次暂态）
 *   函数发生 → 电路里的 fgen 元件（走 model.updateParams，可撤销）
 */
function wireInstruments() {
  const host = document.getElementById('instrument-panel');
  if (!host) return;
  if (instruments) { instruments = null; }
  const B = () => window.__labBoard;

  const netOptions = () => {
    const board = B();
    if (!board) return [];
    const netlist = board.model.getNetlist();
    const parts = [];
    (netlist.nets || new Map()).forEach((members, netId) => {
      const labels = [];
      (members || []).slice(0, 2).forEach((key) => {
        const text = String(key);
        if (text.startsWith('c:')) {
          const [, compId, pin] = text.split(':');
          labels.push(`${compId}.${pin}`);
        }
      });
      parts.push({ netId, label: labels.length > 0 ? `${netId}（${labels.join('、')}）` : netId });
    });
    return parts;
  };

  const componentOptions = () => {
    const board = B();
    if (!board) return [];
    return board.model.getState().components.map((comp) => {
      const def = getPart(comp.type);
      return { id: comp.id, label: `${comp.id}（${def ? def.label : comp.type}）` };
    });
  };

  instruments = createInstruments(host, {
    model: () => (B() ? B().model : null),
    netOptions,
    componentOptions,
    transient: () => {
      const board = B();
      return board && board.simtrans ? board.simtrans.last() : null;
    },
    runTransient: (opts) => {
      const board = B();
      if (!board) return null;
      const res = board.simtrans.solve(opts || { duration: 0.01, dt: 0.0001 });
      if (instruments) instruments.refresh();
      if (dataPanel && res && res.ok) dataPanel.ingestTransient(res);
      return res;
    },
    fgenComponent: () => {
      const board = B();
      if (!board) return null;
      return board.model.getState().components.find((comp) => comp.type === 'fgen') || null;
    },
    placeFgen: () => {
      const board = B();
      if (!board) return;
      const platform = board.platforms.getPlatform(board.platformId);
      for (let y = 1; y < platform.rows - 1; y += 1) {
        for (let x = 0; x < platform.cols - 2; x += 1) {
          const r = board.model.addComponent('fgen', x, y);
          if (r.ok) {
            board.requestRender();
            simulateNow('fgen');
            return;
          }
        }
      }
    },
    updateFgen: (id, patch) => {
      const board = B();
      if (!board) return;
      board.model.updateParams(id, patch);
      simulateNow('fgen');
      if (instruments) instruments.refresh();
    },
    // 测点（下拉 / setProbe / restore）一变，画布标记立刻对齐
    onProbeChange: () => { if (probeMarkers) probeMarkers.sync(); },
    // 面板头部的「画布探针」复选框
    onToggleMarkers: (on) => { if (probeMarkers) probeMarkers.setVisible(on); },
  });

  // 存档里带的仪器段：面板创建后补恢复
  if (pendingInstrumentData && instruments) {
    instruments.restore(pendingInstrumentData);
    pendingInstrumentData = null;
  }

  // 电路一改就刷新仪器（等防抖仿真跑完再读，避免读上一份结果）
  onModelChange(() => {
    window.setTimeout(() => {
      if (instruments) instruments.refresh();
      if (dataPanel && instruments) {
        const read = instruments.read();
        if (read && read.dmm && read.dmm.ok && Number.isFinite(read.dmm.value)) {
          dataPanel.ingestReading('__dmm', read.dmm.value, 'analog');
        }
      }
    }, 360);
  });

  window.__labBoard = window.__labBoard || {};
  window.__labBoard.instruments = instruments;

  // 画布可拖拽探针标记：与仪器面板同生共死，位置随仪器存档保存
  if (probeMarkers) probeMarkers.destroy();
  probeMarkers = createProbeMarkers({
    host: document.getElementById('canvas-area'),
    board: () => window.__labBoard,
    instruments,
    onToast: (message) => showToast(message, 'info'),
  });
  window.__labBoard.probeMarkers = probeMarkers;
  if (window.__labBoard.onAfterRender && probeMarkers) {
    window.__labBoard.onAfterRender((view) => probeMarkers.onViewFrame(view));
  }
}

/** 离开实验：销毁仪器面板 */
function destroyInstruments() {
  const host = document.getElementById('instrument-panel');
  if (host) host.replaceChildren();
  if (probeMarkers) { probeMarkers.destroy(); probeMarkers = null; }
  if (window.__labBoard) {
    window.__labBoard.instruments = null;
    window.__labBoard.probeMarkers = null;
    if (window.__labBoard.onAfterRender) window.__labBoard.onAfterRender(null);
  }
  instruments = null;
}

/* ==========================================================================
   示例实验指导书 + 报告（指令包 12）
   ========================================================================== */

/** 当前打开的实验对应的示例（非示例为 null） */
let currentExample = null;

/**
 * 渲染指导书：步骤（可打勾，仅 UI 状态）+ 预期值表 + 观察输入 + 生成报告。
 * 没有示例时整块隐藏，不占右栏高度。
 */
function renderGuide(example) {
  currentExample = example || null;
  const host = document.getElementById('guide-panel');
  if (!host) return;
  host.replaceChildren();
  if (!example) {
    host.hidden = true;
    return;
  }
  host.hidden = false;

  const head = document.createElement('div');
  head.className = 'inst-head';
  const title = document.createElement('span');
  title.className = 'inst-title';
  title.textContent = '实验指导';
  const fold = document.createElement('button');
  fold.type = 'button';
  fold.className = 'inst-fold';
  fold.textContent = '收起';
  head.append(title, fold);
  host.append(head);

  const body = document.createElement('div');
  body.className = 'inst-body';
  host.append(body);
  fold.addEventListener('click', () => {
    const folded = host.classList.toggle('is-folded');
    fold.textContent = folded ? '展开' : '收起';
    body.hidden = folded;
  });

  const steps = document.createElement('ol');
  steps.className = 'guide-steps';
  (example.guide.steps || []).forEach((text) => {
    const li = document.createElement('li');
    const label = document.createElement('label');
    label.className = 'inst-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    const span = document.createElement('span');
    span.textContent = text;
    label.append(cb, span);
    li.append(label);
    steps.append(li);
  });
  body.append(steps);

  const table = document.createElement('div');
  table.className = 'data-table';
  (example.guide.expected || []).forEach((item) => {
    const line = document.createElement('p');
    line.className = 'inst-measure-line';
    line.textContent = `${item.label}：期望 ${item.target}${item.unit || ''}（±${((item.tolerance || 0) * 100).toFixed(1)}%）`;
    table.append(line);
  });
  body.append(table);

  const obsLabel = document.createElement('span');
  obsLabel.className = 'inst-hint';
  obsLabel.textContent = '我的观察（会写进报告）：';
  const obs = document.createElement('textarea');
  obs.className = 'inst-input guide-obs';
  obs.rows = 3;
  obs.placeholder = '例如：中点电压稳定在 2.50V，与理论一致。';
  body.append(obsLabel, obs);

  const actions = document.createElement('div');
  actions.className = 'inst-actions';
  const reportBtn = document.createElement('button');
  reportBtn.type = 'button';
  reportBtn.className = 'btn btn-ghost inst-btn btn-primary';
  reportBtn.textContent = '生成实验报告';
  reportBtn.addEventListener('click', () => generateExampleReport(example, obs.value));
  actions.append(reportBtn);
  body.append(actions);

  renderConfigBlock(body, example);
}

/**
 * 实验配置块（包 13）：方案应用 / 故障注入 / 评分。
 * 方案与故障都是"电路外元数据"：方案写 params（可撤销），故障是求解前的临时变换。
 */
function renderConfigBlock(host, example) {
  const plans = PRESET_PLANS.filter((plan) => plan.exampleId === example.id);
  if (plans.length === 0) return;

  const title = document.createElement('p');
  title.className = 'inst-hint';
  title.textContent = '实验配置（老师可布置方案/故障）';
  host.append(title);

  const planRow = document.createElement('div');
  planRow.className = 'inst-row';
  const planSel = document.createElement('select');
  planSel.className = 'inst-input';
  plans.forEach((plan) => {
    const opt = document.createElement('option');
    opt.value = plan.id;
    opt.textContent = plan.title;
    planSel.append(opt);
  });
  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'btn btn-ghost inst-btn';
  applyBtn.textContent = '应用方案';
  applyBtn.addEventListener('click', () => {
    const plan = plans.find((p) => p.id === planSel.value);
    const board = window.__labBoard;
    if (!plan || !board) return;
    const res = applyPlanParams(board.model, plan);
    if (!res.ok) {
      showToast(res.error || '应用失败', 'error');
      return;
    }
    simulateNow('apply-plan');
    showToast(`已应用 ${plan.title}（可撤销）`, 'success');
  });
  planRow.append(planSel, applyBtn);
  host.append(planRow);

  const comps = () => (window.__labBoard ? window.__labBoard.model.getState().components : []);
  const faultRow = document.createElement('div');
  faultRow.className = 'inst-row';
  const compSel = document.createElement('select');
  compSel.className = 'inst-input';
  comps().forEach((comp) => {
    const opt = document.createElement('option');
    opt.value = comp.id;
    opt.textContent = comp.id;
    compSel.append(opt);
  });
  faultRow.append(compSel);
  host.append(faultRow);

  const faultActions = document.createElement('div');
  faultActions.className = 'inst-actions';
  const addFault = (fault) => {
    const board = window.__labBoard;
    if (!board) return;
    const list = board.faults().concat([fault]);
    board.setFaults(list);
    showToast(`已注入：${faultLabel(fault)}`, 'success');
  };
  const mk = (label, make) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost inst-btn';
    btn.textContent = label;
    btn.addEventListener('click', () => addFault(make(compSel.value)));
    return btn;
  };
  faultActions.append(
    mk('开路', (id) => ({ type: 'open', componentId: id })),
    mk('短路', (id) => ({ type: 'short', componentId: id })),
    mk('漂移 ×10', (id) => ({ type: 'drift', componentId: id, param: 'resistance', factor: 10 })),
  );
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'btn btn-ghost inst-btn';
  clearBtn.textContent = '清除故障';
  clearBtn.addEventListener('click', () => {
    if (window.__labBoard) window.__labBoard.setFaults([]);
    scoreBox.textContent = '';
    showToast('故障已清除', 'info');
  });
  faultActions.append(clearBtn);
  host.append(faultActions);

  const scoreActions = document.createElement('div');
  scoreActions.className = 'inst-actions';
  const scoreBtn = document.createElement('button');
  scoreBtn.type = 'button';
  scoreBtn.className = 'btn btn-ghost inst-btn';
  scoreBtn.textContent = '评分';
  const scoreBox = document.createElement('p');
  scoreBox.className = 'inst-measure-line';
  scoreBtn.addEventListener('click', () => {
    const board = window.__labBoard;
    if (!board) return;
    const plan = plans.find((p) => p.id === planSel.value);
    const measured = measurePlan(board.simModel(), plan);
    const graded = gradePlan(plan, measured.items, { faults: board.faults().length > 0 });
    scoreBox.textContent = `得分 ${graded.score}（${graded.done}/${graded.total}）`
      + (graded.suspects.length > 0 ? ` · 疑似故障：${graded.suspects.join('、')}` : '');
  });
  scoreActions.append(scoreBtn);
  host.append(scoreActions, scoreBox);
}

/** 生成并下载单文件 HTML 报告（数据冻结在点击这一刻） */
function generateExampleReport(example, observations) {
  const board = window.__labBoard;
  if (!board) return;
  const measured = measureExample(board.model, example);
  if (!measured.ok && measured.error) {
    showToast(`报告生成失败：${measured.error}`, 'error');
    return;
  }
  const canvas = document.getElementById('breadboard-canvas');
  const html = buildReportHtml({
    title: example.title,
    time: new Date().toLocaleString('zh-CN'),
    screenshot: canvas ? canvas.toDataURL('image/png') : '',
    circuit: circuitSummary(board.model),
    items: measured.items,
    observations,
  });
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${example.id}-report.html`;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  const pass = measured.items.filter((x) => x.pass).length;
  showToast(`报告已生成：${pass}/${measured.items.length} 项符合预期`, 'success');
}

/**
 * 数据面板（指令包 11）：记录 / 对比 / 导出 + 项目存档。
 * 存档沿用 model.serializeCircuit（version 4），打开时先迁移再 loadCircuit。
 */
function wireDataPanel() {
  const host = document.getElementById('data-panel');
  if (!host) return;
  const B = () => window.__labBoard;
  dataPanel = createDataPanel(host, {
    circuitName: () => currentExperimentId || 'circuit',
    screenshot: () => {
      const canvas = document.getElementById('breadboard-canvas');
      return canvas ? canvas.toDataURL('image/png') : null;
    },
    saveProject: (opts = {}) => {
      const board = B();
      if (!board) return;
      const archive = dataPanel.buildArchive(board.model);
      archive.records = opts.records || [];
      const text = JSON.stringify(archive, null, 2);
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${currentExperimentId || 'circuit'}.circuit.json`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    },
    openProject: () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const text = await file.text();
        let raw = null;
        try { raw = JSON.parse(text); } catch (err) {
          window.alert('文件损坏：不是合法的 JSON');
          return;
        }
        const migrated = migrateArchive(raw);
        if (!migrated.ok) {
          window.alert(`无法打开：${migrated.notes.join('；')}`);
          return;
        }
        const board = B();
        if (!board) return;
        board.model.loadCircuit(migrated.data, migrated.data.platform);
        simulateNow('open-project');
        if (dataPanel) dataPanel.restore(migrated.data.dataOptions || null);
      });
      input.click();
    },
    applyArchive: (data) => {
      const board = B();
      if (!board) return;
      board.model.loadCircuit(data, data.platform);
      simulateNow('open-project');
    },
  });
  window.__labBoard = window.__labBoard || {};
  window.__labBoard.data = dataPanel;
  window.__labBoard.config = {
    plans: PRESET_PLANS,
    apply: (id) => {
      const plan = PRESET_PLANS.find((p) => p.id === id);
      if (!plan || !window.__labBoard) return { ok: false };
      const res = applyPlanParams(window.__labBoard.model, plan);
      simulateNow('apply-plan');
      return res;
    },
    measure: (id) => {
      const plan = PRESET_PLANS.find((p) => p.id === id);
      return window.__labBoard ? measurePlan(window.__labBoard.simModel(), plan) : { ok: false };
    },
    grade: (id) => {
      const plan = PRESET_PLANS.find((p) => p.id === id);
      const measured = window.__labBoard ? measurePlan(window.__labBoard.simModel(), plan) : { items: [] };
      return gradePlan(plan, measured.items, { faults: window.__labBoard.faults().length > 0 });
    },
    setFaults: (list) => (window.__labBoard ? window.__labBoard.setFaults(list) : 0),
    faults: () => (window.__labBoard ? window.__labBoard.faults() : []),
  };
}

/** 离开实验：销毁数据面板 */
function destroyDataPanel() {
  const host = document.getElementById('data-panel');
  if (host) host.replaceChildren();
  dataPanel = null;
  if (window.__labBoard) window.__labBoard.data = null;
}

/** 离开实验：销毁波形查看器 */
function destroyWaveView() {
  if (waveView) {
    waveView.destroy();
    waveView = null;
  }
}

/* ==========================================================================
   实验列表
   ========================================================================== */

/** 渲染实验清单（整表重建，数据量小，逻辑最直观） */
function renderList() {
  const list = getExperiments();
  const progress = getProgress();

  dom.grid.replaceChildren();

  if (list.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '暂无实验，可通过"导入实验配置"添加。';
    dom.grid.append(empty);
    dom.listCount.textContent = '共 0 个实验';
    return;
  }

  list.forEach((exp, index) => {
    dom.grid.append(createExperimentCard(exp, progress[exp.id], index));
  });

  const openedCount = list.filter((exp) => progress[exp.id]).length;
  dom.listCount.textContent = `共 ${list.length} 个实验 · 已打开 ${openedCount} 个`;
}

/** 平台徽标：实验箱 / 面包板；platform 为 null 时调用方不渲染 */
function createPlatformBadge(platform) {
  const badge = document.createElement('span');
  badge.className = `platform-badge platform-badge--${platform}`;
  badge.textContent = platform === 'exp-box' ? '实验箱' : '面包板';
  badge.title = platform === 'exp-box' ? '数字电路实验箱（exp-box）' : '面包板（breadboard）';
  return badge;
}

/** 仪器摘要：只显示前 2 项，超出部分折叠为 +N */
function createEquipmentSummary(equipment) {
  const summary = document.createElement('span');
  summary.className = 'equip-summary';
  const shown = equipment.slice(0, 2).join('、');
  const restCount = equipment.length - 2;
  summary.textContent = restCount > 0 ? `仪器：${shown} +${restCount}` : `仪器：${shown}`;
  summary.title = `实验仪器：${equipment.join('、')}`;
  return summary;
}

/** 生成一张实验卡片（按钮元素，天然支持键盘与读屏） */
function createExperimentCard(exp, record, index) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'exp-card';
  card.dataset.expId = exp.id;

  // 顶部：序号 + 标题
  const top = document.createElement('span');
  top.className = 'exp-card-top';

  const indexEl = document.createElement('span');
  indexEl.className = 'exp-index';
  indexEl.textContent = String(index + 1).padStart(2, '0');

  const titleEl = document.createElement('span');
  titleEl.className = 'exp-title';
  titleEl.textContent = exp.title;

  top.append(indexEl, titleEl);

  // 元信息：时长 + 难度星级
  const meta = document.createElement('span');
  meta.className = 'exp-meta';

  const durationEl = document.createElement('span');
  durationEl.textContent = exp.durationMin > 0 ? `约 ${exp.durationMin} 分钟` : '时长未标注';

  const sep = document.createElement('span');
  sep.className = 'sep';
  sep.setAttribute('aria-hidden', 'true');

  const stars = document.createElement('span');
  stars.className = 'stars';
  stars.setAttribute('role', 'img');
  stars.setAttribute('aria-label', `难度 ${exp.difficulty} 星，共 3 星`);
  for (let level = 1; level <= 3; level += 1) {
    const star = document.createElement('span');
    star.textContent = '★';
    if (level > exp.difficulty) star.className = 'star-off';
    stars.append(star);
  }

  meta.append(durationEl, sep, stars);

  // 描述
  const descEl = document.createElement('span');
  descEl.className = 'exp-desc';
  descEl.textContent = exp.desc || '暂无描述';

  // 标签区：平台徽标 → 分类标签 → 仪器摘要
  const tagList = document.createElement('span');
  tagList.className = 'tag-list';

  if (exp.platform) {
    tagList.append(createPlatformBadge(exp.platform));
  }

  if (exp.tags.length === 0) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = '未分类';
    tagList.append(tag);
  } else {
    exp.tags.forEach((name) => {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = name;
      tagList.append(tag);
    });
  }

  if (exp.equipment.length > 0) {
    tagList.append(createEquipmentSummary(exp.equipment));
  }

  card.append(top, meta, descEl, tagList);

  // "已打开"角标：依据进度记录（同时给标题行留出避让空间）
  if (record) {
    card.classList.add('exp-card--opened');
    const badge = document.createElement('span');
    badge.className = 'badge-open';
    badge.textContent = '已打开';
    card.append(badge);
  }

  return card;
}

/** 平台中文名（标题栏 / 信息面板共用） */
const PLATFORM_LABELS = {
  'exp-box': '数字电路实验箱',
  breadboard: '面包板',
};

/** 右栏"实验信息"区块：把实验元数据摊平成定义列表 */
function renderExperimentInfo(exp) {
  if (!dom.expInfoBlock) return;
  dom.expInfoBlock.replaceChildren();

  const record = getProgress()[exp.id] || null;
  const rows = [
    ['实验名称', exp.title],
    ['实验说明', exp.desc || '暂无描述'],
    ['实验平台', exp.platform ? PLATFORM_LABELS[exp.platform] : '未标注（默认实验箱，可在标题栏切换）'],
    ['所需仪器', exp.equipment.length > 0 ? exp.equipment.join('、') : '未标注'],
    ['预计时长', exp.durationMin > 0 ? `约 ${exp.durationMin} 分钟` : '未标注'],
    ['打开次数', record ? `${record.openedCount} 次` : '首次打开'],
  ];

  const list = document.createElement('dl');
  list.className = 'info-list';
  rows.forEach(([label, value]) => {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    list.append(dt, dd);
  });
  dom.expInfoBlock.append(list);
}

/** 进入实验工作区：记录进度、刷新列表、切换视图、写入标题、初始化实验台 */
function openExperiment(expId) {
  const exp = getExperimentById(expId);
  if (!exp) {
    showToast('实验不存在或已被移除', 'error');
    return;
  }

  setProgress(exp.id);
  currentExperimentId = exp.id;

  dom.workspaceTitle.textContent = exp.title;
  dom.workspaceMeta.textContent = exp.durationMin > 0
    ? `${exp.durationMin} 分钟 · 难度 ${exp.difficulty}/3`
    : `难度 ${exp.difficulty}/3`;

  renderExperimentInfo(exp);
  renderList();
  activateTab('info');
  switchView('view-workspace');

  // 仪器段随存档走（包 10）：model 不认识 UI，用注入的 provider/restorer
  setInstrumentProvider(() => (instruments ? instruments.snapshot() : null));
  setInstrumentRestorer((data) => {
    if (instruments) instruments.restore(data);
    else pendingInstrumentData = data;
  });

  // 每次进入实验都回到实验台视图（原理图是辅助视图，不应成为默认落地页）
  switchBoardView('bench');
  // 连续放置是"一次操作习惯"，换实验时复位为关闭，避免用户莫名连放
  setContPlacePressed(false);

  // 画布尺寸依赖布局完成，必须在视图切过去之后再初始化
  initBoard({
    expId: exp.id,
    platformId: exp.platform,
    locked: Boolean(exp.platform),
    onToast: showToast,
    onPlatformChange: (platformId, locked) => {
      currentPlatformId = platformId;
      dom.wsPlatform.textContent = PLATFORM_LABELS[platformId] || platformId;
      dom.wsPlatform.dataset.platform = platformId;
      dom.btnSwitchPlatform.disabled = locked;
      dom.btnSwitchPlatform.title = locked
        ? '该实验已标注平台，平台已锁定'
        : '切换实验箱 / 面包板';
      // 画布标签只在实验台视图显示平台；原理图视图显示 SCHEMATIC
      syncCanvasHead();
    },
  });

  // 示例实验：每次打开都从只读模板恢复（用户改动不写回模板）
  const example = getExample(exp.id);
  if (example && window.__labBoard) {
    const template = cloneExample(example.circuit);
    window.__labBoard.model.loadCircuit(template, example.circuit.platform || exp.platform);
  }
  renderGuide(example);

  // 进入实验就先算一次直流工作点：恢复出来的电路也能立刻看到读数
  simulateNow('init');

  // 波形查看器（指令包 7）：进实验时挂上，用户点「运行」才跑暂态
  wireWaveView();

  // 测量仪器（指令包 10）：四件仪器共用一份面板
  wireInstruments();

  // 数据面板（指令包 11）：记录/对比/导出/项目存档
  wireDataPanel();
}

/** 离开工作区：先清理实验台（含落盘与原理图），再切回列表 */
function leaveWorkspace() {
  renderGuide(null);
  destroyDataPanel();
  destroyInstruments();
  destroyWaveView();
  destroyBoard();
  currentExperimentId = null;
  setContPlacePressed(false);
  switchBoardView('bench');
  switchView('view-list');
}

/* ==========================================================================
   右栏标签页
   ========================================================================== */

/** 激活指定标签页（info / steps / data） */
function activateTab(name) {
  dom.tabButtons.forEach((btn) => {
    const isActive = btn.dataset.tab === name;
    btn.classList.toggle('is-active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    btn.tabIndex = isActive ? 0 : -1;
  });
  dom.tabPanels.forEach((panel) => {
    panel.classList.toggle('is-active', panel.dataset.panel === name);
  });
}

/* ==========================================================================
   轻提示与确认对话框
   ========================================================================== */

/** toast 每条驻留时间（毫秒） */
const TOAST_DWELL = 1600;

/** toast 队列：同时最多 1 条，其余按顺序展示（2.10） */
const toastQueue = [];
let toastBusy = false;

/**
 * 底部轻提示，kind ∈ info / success / error
 *
 * 2.10 的取舍：改成「同时最多 1 条 + 顺序展示」，不做消息文本合并。
 * 合并会丢信息（如连续删除的"已删除导线 w1 / w2"看不出删了哪条），
 * 而顺序展示既不会堆积遮挡、又能让用户逐条看清；
 * 真正的高频来源（连续放置）已在交互层合并成"已放置 N 个 xxx"。
 */
function showToast(message, kind = 'info') {
  // 2.10：队列上限 3 条，超出丢最旧、保留最新——极端高频操作下提示不会积压过久
  if (toastQueue.length >= 3) toastQueue.shift();
  toastQueue.push({ message, kind });
  if (!toastBusy) pumpToast();
}

/** 取队首展示；收尾时自动抽下一条，保证同屏只有 1 条 */
function pumpToast() {
  if (toastBusy) return;
  const item = toastQueue.shift();
  if (!item) return;
  toastBusy = true;

  const toast = document.createElement('div');
  toast.className = `toast toast--${item.kind}`;

  const dot = document.createElement('span');
  dot.className = 'toast-dot';
  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = item.message;

  toast.append(dot, text);
  dom.toastHost.append(toast);
  // 兜底：无论走哪条异常路径，同屏都只保留 1 条
  while (dom.toastHost.children.length > 1) {
    dom.toastHost.firstElementChild.remove();
  }

  requestAnimationFrame(() => toast.classList.add('is-in'));
  window.setTimeout(() => {
    toast.classList.remove('is-in');
    window.setTimeout(() => {
      toast.remove();
      toastBusy = false;
      pumpToast();
    }, 240);
  }, TOAST_DWELL);
}

/** 打开覆盖确认框，返回 Promise<boolean>：确认 true / 取消 false */
function openConfirm({ title, desc, okText = '确定', cancelText = '取消' }) {
  return new Promise((resolve) => {
    const host = dom.modalHost;
    const titleEl = host.querySelector('#modal-title');
    const descEl = host.querySelector('#modal-desc');
    const okBtn = host.querySelector('[data-modal-ok]');
    const cancelBtn = host.querySelector('[data-modal-cancel].btn');
    const backdrop = host.querySelector('.modal-backdrop');
    const lastFocus = document.activeElement;

    titleEl.textContent = title;
    descEl.textContent = desc;
    okBtn.textContent = okText;
    cancelBtn.textContent = cancelText;

    host.hidden = false;
    requestAnimationFrame(() => host.classList.add('is-open'));
    okBtn.focus();

    /** 收尾：解绑事件、关闭弹层、归还焦点、兑现 Promise */
    function close(result) {
      host.classList.remove('is-open');
      host.hidden = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      backdrop.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
      resolve(result);
    }

    function onOk() {
      close(true);
    }

    function onCancel() {
      close(false);
    }

    function onKey(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    backdrop.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
  });
}

/* ==========================================================================
   平台与仪器选择对话框（导入配置未标注平台时使用）
   ========================================================================== */

/** 平台单选项：默认选中实验箱（对应用户真实的数字电路实验箱场景） */
const PLATFORM_OPTIONS = [
  { value: 'exp-box', label: '数字电路实验箱（exp-box）' },
  { value: 'breadboard', label: '面包板（breadboard）' },
];

/** 仪器多选项 */
const EQUIPMENT_OPTIONS = [
  '数字电路实验箱',
  '面包板',
  '万用表',
  '直流电源',
  '信号源',
  '示波器',
  '逻辑分析仪',
];

/** 对话框 DOM 引用缓存，惰性创建一次后复用 */
let equipDialog = null;

/** 便捷建元素：标签 + 类名 + 文本 */
function makeEl(tagName, className, text) {
  const el = document.createElement(tagName);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** 首次调用时构建 #equip-modal 的完整 DOM，返回引用集合 */
function ensureEquipDialog() {
  if (equipDialog) return equipDialog;

  const host = makeEl('div', 'modal-host equip-modal');
  host.id = 'equip-modal';
  host.hidden = true;

  const backdrop = makeEl('div', 'modal-backdrop');

  const dialog = makeEl('div', 'modal modal--wide');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'equip-title');
  dialog.setAttribute('aria-describedby', 'equip-desc');

  const title = makeEl('h3', 'modal-title', '选择实验平台与仪器');
  title.id = 'equip-title';
  const desc = makeEl('p', 'modal-desc',
    '这份配置没有标注实验平台，补充后实验卡片会显示平台徽标与仪器摘要。');
  desc.id = 'equip-desc';

  // 平台单选
  const platformField = makeEl('fieldset', 'equip-fieldset');
  platformField.append(makeEl('legend', 'equip-legend', '实验平台'));
  const platformBox = makeEl('div', 'equip-options');
  PLATFORM_OPTIONS.forEach((option, index) => {
    const label = makeEl('label', 'equip-option');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'equip-platform';
    input.value = option.value;
    input.checked = index === 0;
    label.classList.toggle('is-checked', input.checked);
    label.append(input, makeEl('span', '', option.label));
    platformBox.append(label);
  });
  platformField.append(platformBox);

  // 仪器多选
  const equipField = makeEl('fieldset', 'equip-fieldset');
  equipField.append(makeEl('legend', 'equip-legend', '所需仪器（可多选）'));
  const equipBox = makeEl('div', 'equip-options');
  EQUIPMENT_OPTIONS.forEach((name) => {
    const label = makeEl('label', 'equip-option');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'equip-item';
    input.value = name;
    label.append(input, makeEl('span', '', name));
    equipBox.append(label);
  });
  equipField.append(equipBox);

  const actions = makeEl('div', 'modal-actions');
  const skipBtn = makeEl('button', 'btn btn-ghost', '跳过（不填）');
  skipBtn.type = 'button';
  skipBtn.dataset.equipSkip = '';
  const okBtn = makeEl('button', 'btn btn-primary', '确认');
  okBtn.type = 'button';
  okBtn.dataset.equipOk = '';
  actions.append(skipBtn, okBtn);

  dialog.append(makeEl('p', 'eyebrow modal-eyebrow', 'EXPERIMENT SETUP'),
    title, desc, platformField, equipField, actions);
  host.append(backdrop, dialog);
  document.body.append(host);

  // 勾选态高亮：事件委托，只绑一次
  host.addEventListener('change', (event) => {
    const input = event.target;
    if (!input || input.tagName !== 'INPUT') return;
    const option = input.closest('.equip-option');
    if (option) option.classList.toggle('is-checked', input.checked);
  });

  equipDialog = {
    host,
    backdrop,
    okBtn,
    skipBtn,
    platformInputs: [...platformBox.querySelectorAll('input')],
    itemInputs: [...equipBox.querySelectorAll('input')],
  };
  return equipDialog;
}

/** 打开平台与仪器选择框，返回 Promise<{skipped, platform, equipment}> */
function openEquipDialog(exp) {
  const refs = ensureEquipDialog();

  return new Promise((resolve) => {
    const lastFocus = document.activeElement;

    // 预置状态：已有平台/仪器则回显，否则默认实验箱、仪器全不勾
    const presetPlatform = exp.platform || 'exp-box';
    refs.platformInputs.forEach((input) => {
      input.checked = input.value === presetPlatform;
      input.closest('.equip-option').classList.toggle('is-checked', input.checked);
    });
    const presetItems = new Set(exp.equipment);
    refs.itemInputs.forEach((input) => {
      input.checked = presetItems.has(input.value);
      input.closest('.equip-option').classList.toggle('is-checked', input.checked);
    });

    refs.host.hidden = false;
    requestAnimationFrame(() => refs.host.classList.add('is-open'));
    const focusTarget = refs.platformInputs.find((input) => input.checked) || refs.platformInputs[0];
    focusTarget.focus();

    /** 收尾：解绑事件、关闭弹层、归还焦点、兑现 Promise */
    function close(result) {
      refs.host.classList.remove('is-open');
      refs.host.hidden = true;
      refs.okBtn.removeEventListener('click', onOk);
      refs.skipBtn.removeEventListener('click', onSkip);
      refs.backdrop.removeEventListener('click', onSkip);
      document.removeEventListener('keydown', onKey);
      if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
      resolve(result);
    }

    function onOk() {
      const platformInput = refs.platformInputs.find((input) => input.checked);
      const equipment = refs.itemInputs
        .filter((input) => input.checked)
        .map((input) => input.value);
      close({ skipped: false, platform: platformInput ? platformInput.value : 'exp-box', equipment });
    }

    function onSkip() {
      close({ skipped: true, platform: null, equipment: [] });
    }

    function onKey(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onSkip();
      }
    }

    refs.okBtn.addEventListener('click', onOk);
    refs.skipBtn.addEventListener('click', onSkip);
    refs.backdrop.addEventListener('click', onSkip);
    document.addEventListener('keydown', onKey);
  });
}

/* ==========================================================================
   配置导入 / 导出
   ========================================================================== */

/** 配置模板内容：与实验数据模型字段一致，附带字段说明 */
function buildTemplate() {
  return {
    _readme: [
      '电路实验模拟器 · 实验配置模板',
      'id：字符串，实验唯一标识（必填）；与已有实验重复时会询问是否覆盖',
      'title：字符串，实验名称（必填）',
      'desc：字符串，一句话说明实验目的',
      'durationMin：数字，预计完成时长（分钟，1-600）',
      'difficulty：数字，难度 1-3（1=入门，3=挑战）',
      'tags：字符串数组，分类标签，最多 6 个',
      'platform：实验平台，exp-box=数字电路实验箱，breadboard=面包板；不填则导入时询问',
      'equipment：字符串数组，实验所需仪器列表，可留空；最多 6 项',
      '导入时仅上述字段生效，_readme 仅作说明用途',
    ],
    id: 'demo-rc-charge',
    title: 'RC 一阶电路充放电',
    desc: '观察电容电压随时间的指数变化，测量时间常数 τ 并与理论值比对',
    durationMin: 45,
    difficulty: 2,
    tags: ['模拟电路', '暂态分析'],
    platform: 'exp-box',
    equipment: ['万用表', '示波器'],
  };
}

/** 点击"导入实验配置"：清空上次选择后打开文件框 */
function handleImportClick() {
  dom.fileInput.value = '';
  dom.fileInput.click();
}

/** 处理文件选择：导入完成后重置 input 值，保证再次选同一文件仍触发 change */
async function handleFileChange(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  try {
    await importExperimentFile(file);
  } finally {
    dom.fileInput.value = '';
  }
}

/** 解析并导入配置文件：读取失败提示、格式错误容错、id 重复时询问覆盖 */
async function importExperimentFile(file) {
  let text = '';
  try {
    text = await file.text();
  } catch (err) {
    showToast('配置文件读取失败', 'error');
    return;
  }

  let data = null;
  try {
    data = JSON.parse(text);
  } catch (err) {
    showToast('配置文件格式错误', 'error');
    return;
  }

  const check = validateExperiment(data);
  if (!check.ok) {
    showToast(`配置文件格式错误：${check.message}`, 'error');
    return;
  }

  const exp = normalizeExperiment(data);
  const existing = getExperimentById(exp.id);

  // 平台未标注：优先沿用清单里同 id 实验的标注；都没有才询问用户
  // 顺序保证：先补齐仪器信息，再问是否覆盖，避免用户答完覆盖又问仪器
  if (exp.platform === null) {
    if (existing && existing.platform) {
      exp.platform = existing.platform;
      if (exp.equipment.length === 0) exp.equipment = existing.equipment.slice();
    } else {
      const picked = await openEquipDialog(exp);
      if (!picked.skipped) {
        exp.platform = picked.platform;
        exp.equipment = picked.equipment;
      }
    }
  }

  // id 已存在：询问是否覆盖
  if (existing) {
    const confirmed = await openConfirm({
      title: '已存在同名实验',
      desc: `实验 id「${exp.id}」已存在于清单中，是否覆盖其内容？`,
      okText: '覆盖',
      cancelText: '取消',
    });
    if (!confirmed) return;
    replaceExperiment(exp);
    showToast(`已覆盖实验：${exp.title}`, 'success');
    if (currentExperimentId === exp.id) {
      dom.workspaceTitle.textContent = exp.title;
    }
  } else {
    const added = addExperiment(exp);
    if (!added) {
      showToast('实验添加失败：id 不合法或已存在', 'error');
      return;
    }
    showToast(`已导入实验：${exp.title}`, 'success');
  }

  renderList();
}

/** 生成模板 JSON 并触发浏览器下载 */
function handleExport() {
  const content = JSON.stringify(buildTemplate(), null, 2);
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = 'experiments-template.json';
  document.body.append(link);
  link.click();
  link.remove();

  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('已导出 experiments-template.json', 'success');
}

/* ==========================================================================
   事件绑定与初始化
   ========================================================================== */

/** 统一绑定所有交互事件（列表用事件委托，便于后续动态增删卡片） */
function bindEvents() {
  dom.grid.addEventListener('click', (event) => {
    const card = event.target.closest('.exp-card');
    if (!card) return;
    openExperiment(card.dataset.expId);
  });

  dom.btnImport.addEventListener('click', handleImportClick);
  dom.btnExport.addEventListener('click', handleExport);
  dom.fileInput.addEventListener('change', handleFileChange);

  dom.btnBack.addEventListener('click', leaveWorkspace);
  dom.btnBackReport.addEventListener('click', leaveWorkspace);

  // 视图切换：实验台 / 原理图
  if (dom.btnViewBench) {
    dom.btnViewBench.addEventListener('click', () => switchBoardView('bench'));
  }
  if (dom.btnViewSchematic) {
    dom.btnViewSchematic.addEventListener('click', () => switchBoardView('schematic'));
  }

  // 标签页：点击切换 + 左右方向键切换（遵循 tablist 交互惯例）
  dom.tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => activateTab(btn.dataset.tab));
    btn.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      event.preventDefault();
      const tabs = Array.from(dom.tabButtons);
      const step = event.key === 'ArrowRight' ? 1 : -1;
      const next = tabs[(tabs.indexOf(btn) + step + tabs.length) % tabs.length];
      activateTab(next.dataset.tab);
      next.focus();
    });
  });

  // 空格 = 时钟步进（手不离开键盘就能一下一下打时序，等同实验箱上的单脉冲键）
  document.addEventListener('keydown', (event) => {
    if (event.key !== ' ' || event.repeat) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (!isBoardActive()) return;
    // 正在输入参数 / 操作下拉框时不要抢空格
    const target = event.target;
    if (target && (target.isContentEditable
      || target.tagName === 'INPUT'
      || target.tagName === 'TEXTAREA'
      || target.tagName === 'SELECT')) return;
    event.preventDefault();
    stepClockNow();
  });

  bindZoomControls();
}

/** 更新工具栏倍率读数 */
function setZoomReadout(level) {
  if (dom.zoomLevel) dom.zoomLevel.textContent = `${Number(level).toFixed(level % 1 === 0 ? 0 : 2)}×`;
}

/** 更新放大镜按钮的按下态 */
function setLensPressed(on) {
  if (!dom.btnLens) return;
  dom.btnLens.setAttribute('aria-pressed', String(on));
  dom.btnLens.classList.toggle('is-active', on);
}

/** 更新连续放置按钮的按下态（换实验 / 离开工作区时复位） */
function setContPlacePressed(on) {
  if (!dom.btnContPlace) return;
  dom.btnContPlace.setAttribute('aria-pressed', String(on));
  dom.btnContPlace.classList.toggle('is-active', on);
}

/** 绑定视图缩放 / 放大镜工具栏（包 7A） */
function bindZoomControls() {
  const zoomApi = () => (window.__labBoard && window.__labBoard.zoom) ? window.__labBoard.zoom : null;
  const lensApi = () => (window.__labBoard && window.__labBoard.lens) ? window.__labBoard.lens : null;

  if (dom.btnZoomIn) {
    dom.btnZoomIn.addEventListener('click', () => {
      const api = zoomApi();
      if (!api) return;
      api.in();
      setZoomReadout(api.level());
    });
  }
  if (dom.btnZoomOut) {
    dom.btnZoomOut.addEventListener('click', () => {
      const api = zoomApi();
      if (!api) return;
      api.out();
      setZoomReadout(api.level());
    });
  }
  if (dom.btnZoomReset) {
    dom.btnZoomReset.addEventListener('click', () => {
      const api = zoomApi();
      if (!api) return;
      api.reset();
      setZoomReadout(api.level());
    });
  }
  if (dom.btnLens) {
    dom.btnLens.addEventListener('click', () => {
      const api = lensApi();
      if (!api) return;
      if (api.isOn()) { api.off(); setLensPressed(false); }
      else { api.on(); setLensPressed(true); }
    });
  }

  // 连续放置开关（7B.2）：开启后放一个不退出放置模式，Esc 或再次点击退出
  if (dom.btnContPlace) {
    dom.btnContPlace.addEventListener('click', () => {
      const api = window.__labBoard && window.__labBoard.interact;
      if (!api) return;
      const on = !api.isContinuousPlace();
      api.continuousPlace(on);
      setContPlacePressed(on);
      showToast(on ? '连续放置：开（Esc 退出）' : '连续放置：关', 'info');
    });
  }

  // 缩放 / 放大镜状态由交互层（键盘、智能聚焦）驱动，这里只做读数同步
  window.addEventListener('viewzoom', (event) => {
    if (event.detail && typeof event.detail.level === 'number') setZoomReadout(event.detail.level);
  });
  window.addEventListener('lensstate', (event) => {
    if (event.detail && typeof event.detail.on === 'boolean') setLensPressed(event.detail.on);
  });
  // 连续放置模式被 Esc / 交互层关闭时，同步工具栏按钮的按下态
  window.addEventListener('placestate', (event) => {
    if (event.detail && typeof event.detail.on === 'boolean') setContPlacePressed(event.detail.on);
  });
}

/** 启动应用：绑定事件、渲染列表、进入默认视图 */
function init() {
  // 示例实验：注册到实验列表（只补缺失，避免每次启动重复写入）
  EXAMPLES.forEach((ex) => {
    if (getExperimentById(ex.id)) return;
    addExperiment({
      id: ex.id,
      title: ex.title,
      desc: ex.desc,
      durationMin: ex.durationMin,
      difficulty: ex.difficulty,
      tags: ex.tags,
      platform: ex.platform,
      equipment: ex.equipment,
    });
  });

  bindEvents();
  activateTab('info');
  renderList();
  switchView('view-list');
  window.__labSimReady = true;
}

init();

// 挂到 window 上，方便控制台调试
window.switchView = switchView;
