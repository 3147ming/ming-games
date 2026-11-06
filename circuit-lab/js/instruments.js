/**
 * instruments.js — 四件测量仪器的面板（指令包 10）
 *
 * 设计边界：
 *   读数计算在 instruments-core.js（纯函数、可 node 对拍）；
 *   本文件只负责 DOM、交互与"读哪份数据"的选择。
 *
 * 数据源口径（与报告必答①一致）：
 *   万用表   → board.sim.result（直流工作点，防抖 300ms 后刷新）
 *   示波器   → board.transientRun.last（暂态最近一次结果，运行中滚动更新）
 *   逻辑分析 → 同上，只取 type==='digital' 的通道
 *   函数发生 → 就是电路里的 fgen 元件（可撤销、可存档）
 *
 * 探针是**观测层**：挂点只写 instruments 的 netId 列表，不碰 model。
 */

import {
  dmmRead, scopeMeasure, decodeUart, decodeI2c, FGEN_WAVES,
  findTrigger, fgenOutputImpedance, fgenLoadResistance, FGEN_Z_OPTIONS,
  extractStateMachine,
} from './instruments-core.js';

const TABS = [
  { id: 'dmm', label: '万用表' },
  { id: 'scope', label: '示波器' },
  { id: 'la', label: '逻辑分析' },
  { id: 'fgen', label: '函数发生' },
];

/**
 * 阶段 2 R7：万用表 8 档位。
 * probes 约定面板要显示哪些落点控件，也决定「探针未接触」的判定：
 *   A       只需红表笔（对地测量）
 *   AB      红黑两点（电阻 / 二极管 / 通断 / 电容）
 *   comp    只需串入支路的元件（直流电流）
 *   A+comp  红表笔给交流波形 + 元件给折算电阻（交流电流）
 * 内核 dmmRead() 的分支与之一一对应，别在 UI 里另算一遍读数。
 */
export const DMM_MODES = [
  { value: 'volt', label: '直流电压 DCV (V)', probes: 'A', hint: '红表笔接测点（相对地），黑表笔为参考端' },
  { value: 'acv', label: '交流电压 ACV (V~)', probes: 'A', hint: '读暂态波形的交流分量 RMS（已扣直流偏置）' },
  { value: 'amp', label: '直流电流 DCA (A)', probes: 'comp', hint: '串入支路：把红表笔拖到元件/导线上，或用下拉选元件' },
  { value: 'aca', label: '交流电流 ACA (A~)', probes: 'A+comp', hint: '交流电流 = 测点波形 RMS ÷ 元件电阻；红表笔挂测点、下拉选元件' },
  { value: 'ohm', label: '电阻档 (Ω)', probes: 'AB', hint: '红黑表笔分别接被测两端，电路按断电处理（独立源归零）' },
  { value: 'diode', label: '二极管档 (→|)', probes: 'AB', hint: '红表笔接阳极、黑表笔接阴极，10mA 测试电流测正向压降' },
  { value: 'cont', label: '通断档 · 蜂鸣', probes: 'AB', hint: '红黑表笔短接判通（|V|<0.3V 或 R<30Ω）' },
  { value: 'cap', label: '电容档 (F)', probes: 'AB', hint: '读测点所在网上电容的标称值（教学简化，断电读数）' },
];

/**
 * 画布探针槽位（包 15 遗留建议 2）：一枚标记 = 一个测点。
 * scope/key 指向 instruments 的状态字段，标记与下拉共用同一份数据，
 * 所以「拖标记」和「选下拉」永远同步，存档也只存这一份。
 */
export const PROBE_SLOTS = [
  { id: 'dmm', label: 'DMM', color: '#f2a93b', scope: 'dmm', key: 'netId', hint: '万用表主测点' },
  { id: 'dmmB', label: 'DMM B', color: '#e2685f', scope: 'dmm', key: 'netB', hint: '电阻/二极管档参考端' },
  { id: 'ch1', label: 'CH1', color: '#5fd39a', scope: 'scope', key: 'ch1', hint: '示波器通道 1' },
  { id: 'ch2', label: 'CH2', color: '#5aa9e6', scope: 'scope', key: 'ch2', hint: '示波器通道 2' },
];

/** 创建仪器面板 */
export function createInstruments(host, api = {}) {
  if (!host) return null;
  host.replaceChildren();

  const state = {
    tab: 'dmm',
    // real 为包 10 起的存档字段（必须保留）；realInput 是 dmmRead 的入参名，两者在下方同步
    dmm: {
      mode: 'volt', netId: null, netB: null, componentId: null, real: false, realInput: false,
    },
    scope: {
      ch1: null, ch2: null, timebase: 0.001, vdiv: 1, coupling: 'dc', cursor1: 0, cursor2: 0,
      // 阶段 2 R4a：触发只新增字段，既有 ch1/ch2/... 一律不动
      trigger: { edge: 'rising', level: 2.5, mode: 'auto', armed: true },
      frozenT0: null,
      frozenDrawn: false,
    },
    la: { nets: [], baud: 9600, bytes: [], error: '' },
    // 画布探针标记位置：slotId → { gx, gy }（网格坐标，随存档保存）
    markers: {},
    lastRead: null,
  };

  // HEP-DCTS-01 实物外观：示波器 / 函数发生 tab 是否套写实前面板。
  // 装饰层是纯 DOM、aria-hidden + pointer-events:none，现有控件结构一字不改。
  let skinOn = Boolean(api.hepSkin && api.hepSkin());

  const wrap = document.createElement('div');
  wrap.className = 'inst-panel';

  const head = document.createElement('div');
  head.className = 'inst-head';
  const title = document.createElement('span');
  title.className = 'inst-title';
  title.textContent = '仪器';
  const fold = document.createElement('button');
  fold.type = 'button';
  fold.className = 'inst-fold';
  fold.textContent = '收起';
  fold.setAttribute('aria-expanded', 'true');
  head.append(title);

  const tabs = document.createElement('div');
  tabs.className = 'inst-tabs';
  const body = document.createElement('div');
  body.className = 'inst-body';

  wrap.append(head, tabs, body);
  host.append(wrap);

  // 画布探针标记总开关（标记层由 app 注入 onToggleMarkers）
  const headActions = document.createElement('div');
  headActions.className = 'inst-head-actions';
  const probeToggle = document.createElement('label');
  probeToggle.className = 'inst-probe-toggle';
  const probeCb = document.createElement('input');
  probeCb.type = 'checkbox';
  probeCb.checked = true;
  probeCb.setAttribute('aria-label', '显示画布探针标记');
  probeCb.addEventListener('change', () => {
    if (api.onToggleMarkers) api.onToggleMarkers(probeCb.checked);
  });
  const probeText = document.createElement('span');
  probeText.textContent = '画布探针';
  probeToggle.append(probeCb, probeText);
  headActions.append(probeToggle, fold);
  head.append(headActions);

  fold.addEventListener('click', () => {
    const folded = wrap.classList.toggle('is-folded');
    fold.textContent = folded ? '展开' : '收起';
    fold.setAttribute('aria-expanded', String(!folded));
  });

  const tabButtons = new Map();
  TABS.forEach((tab) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'inst-tab';
    btn.textContent = tab.label;
    btn.dataset.tab = tab.id;
    btn.addEventListener('click', () => selectTab(tab.id));
    tabs.append(btn);
    tabButtons.set(tab.id, btn);
  });

  function selectTab(id) {
    state.tab = id;
    tabButtons.forEach((btn, key) => {
      btn.classList.toggle('is-active', key === id);
      btn.setAttribute('aria-selected', String(key === id));
    });
    renderBody();
  }

  /** 测点变更 → 通知画布标记层重新对齐（回调由 app 注入） */
  function notifyProbeChange() {
    if (api.onProbeChange) api.onProbeChange();
  }

  function renderBody() {
    body.replaceChildren();
    if (state.tab === 'dmm') renderDmm();
    else if (state.tab === 'scope') renderScope();
    else if (state.tab === 'la') renderLa();
    else renderFgen();
    if (state.tab === 'dmm' || state.tab === 'scope') {
      const hint = document.createElement('p');
      hint.className = 'inst-probe-hint';
      hint.textContent = '测点也可直接拖画布上的彩色探针标记到端子 / 孔位';
      body.append(hint);
    }
    notifyProbeChange();
  }

  /* ------------------------------------------------- HEP 实物仪器前面板装饰 */

  /** SIGLENT SDS 1102CNL 前面板（纯装饰，不接管任何控件） */
  function hepScopeFace() {
    const face = document.createElement('div');
    face.className = 'hep-face hep-scope-face';
    face.setAttribute('aria-hidden', 'true');
    face.innerHTML = [
      '<div class="hep-scope-brand">',
      '<span class="hep-brand-logo">SIGLENT</span>',
      '<span class="hep-brand-model">SDS 1102CNL</span>',
      '<span class="hep-brand-spec">DIGITAL STORAGE OSCILLOSCOPE · 100MHz · 1GSa/s</span>',
      '</div>',
      '<div class="hep-scope-rig">',
      '<div class="hep-rig-col"><span class="hep-rig-title">VERTICAL</span>',
      '<span class="hep-knob"></span><span class="hep-knob"></span>',
      '<span class="hep-rig-btn">CH1</span><span class="hep-rig-btn">CH2</span></div>',
      '<div class="hep-rig-col"><span class="hep-rig-title">HORIZONTAL</span>',
      '<span class="hep-knob"></span><span class="hep-knob"></span>',
      '<span class="hep-rig-btn">MENU</span><span class="hep-rig-btn">POSITION</span></div>',
      '<div class="hep-rig-col"><span class="hep-rig-title">TRIGGER</span>',
      '<span class="hep-knob"></span>',
      '<span class="hep-rig-btn hep-rig-btn--auto">AUTO</span>',
      '<span class="hep-rig-btn">RUN / STOP</span></div>',
      '</div>',
      '<div class="hep-scope-bnc">',
      '<span class="hep-bnc"><i></i>CH1</span>',
      '<span class="hep-bnc"><i></i>CH2</span>',
      '<span class="hep-bnc"><i></i>EXT TRIG</span>',
      '</div>',
    ].join('');
    return face;
  }

  /** UTG9005A 型数字合成函数信号发生器前面板（纯装饰） */
  function hepFgenFace() {
    const face = document.createElement('div');
    face.className = 'hep-face hep-fgen-face';
    face.setAttribute('aria-hidden', 'true');
    face.innerHTML = [
      '<div class="hep-fgen-brand">',
      '<span class="hep-fgen-model">UTG9005A 型数字合成函数信号发生器</span>',
      '<span class="hep-fgen-range">1μHz~5MHz</span>',
      '<span class="hep-fgen-knob"></span>',
      '</div>',
      '<div class="hep-fgen-keys">',
      '<div class="hep-fgen-func">',
      '<span>频率/周期</span><span>幅度/脉宽</span><span>键控</span><span>菜单</span>',
      '<span>调频</span><span>调幅</span><span>扫描</span><span>突发</span>',
      '</div>',
      '<div class="hep-fgen-num">',
      '<span>7</span><span>8</span><span>9</span>',
      '<span>4</span><span>5</span><span>6</span>',
      '<span>1</span><span>2</span><span>3</span>',
      '<span>0</span><span>·</span><span>−</span>',
      '</div>',
      '</div>',
      '<div class="hep-fgen-out">',
      '<span class="hep-bnc"><i></i>TTL 输出</span>',
      '<span class="hep-bnc"><i></i>42V MAX</span>',
      '</div>',
    ].join('');
    return face;
  }

  /* ---------------------------------------------------------------- 通用控件 */

  function row(label, control, hint) {
    const line = document.createElement('label');
    line.className = 'inst-row';
    const text = document.createElement('span');
    text.className = 'inst-row-label';
    text.textContent = label;
    line.append(text, control);
    if (hint) {
      const tip = document.createElement('span');
      tip.className = 'inst-hint';
      tip.textContent = hint;
      line.append(tip);
    }
    return line;
  }

  function select(options, value, onChange) {
    const el = document.createElement('select');
    el.className = 'inst-input';
    options.forEach((opt) => {
      const item = document.createElement('option');
      item.value = opt.value;
      item.textContent = opt.label;
      el.append(item);
    });
    el.value = value === null || value === undefined ? '' : String(value);
    el.addEventListener('change', () => {
      onChange(el.value);
      notifyProbeChange();
    });
    return el;
  }

  function button(text, onClick, kind = '') {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `btn btn-ghost inst-btn${kind ? ` ${kind}` : ''}`;
    el.textContent = text;
    el.addEventListener('click', onClick);
    return el;
  }

  function netOptions() {
    const list = (api.netOptions ? api.netOptions() : []) || [];
    return [{ value: '', label: '— 选择测点 —' }].concat(
      list.map((net) => ({ value: net.netId, label: net.label || net.netId })),
    );
  }

  function compOptions() {
    const list = (api.componentOptions ? api.componentOptions() : []) || [];
    return [{ value: '', label: '— 选择元件 —' }].concat(
      list.map((item) => ({ value: item.id, label: item.label })),
    );
  }

  /* ---------------------------------------------------------------- 万用表 */

  function dmmConfig() {
    return DMM_MODES.find((m) => m.value === state.dmm.mode) || DMM_MODES[0];
  }

  /** UI 状态 → dmmRead 入参：顺手把 real 映射成 realInput、把暂态波形接进来 */
  function dmmOpts() {
    const res = transient();
    const opts = {
      ...state.dmm,
      realInput: Boolean(state.dmm.realInput || state.dmm.real),
      waveforms: res && Array.isArray(res.waveforms) ? res.waveforms : [],
    };
    if (state.dmm.mode === 'aca') {
      const r = componentResistance(state.dmm.componentId);
      if (Number.isFinite(r)) opts.loadResistance = r;
    }
    return opts;
  }

  /** 交流电流档按「测点电压 RMS ÷ 元件电阻」折算，电阻取元件的标称值 */
  function componentResistance(id) {
    if (!id) return NaN;
    const m = api.model ? api.model() : null;
    if (!m || !m.getState) return NaN;
    const comp = (m.getState().components || []).find((c) => c.id === id);
    const r = Number(comp && comp.params && comp.params.resistance);
    return Number.isFinite(r) && r > 0 ? r : NaN;
  }

  function renderDmm() {
    const box = document.createElement('div');
    box.className = 'inst-dmm';
    const cfg = dmmConfig();

    const modeSel = select(
      DMM_MODES.map((m) => ({ value: m.value, label: m.label })),
      state.dmm.mode,
      (value) => { state.dmm.mode = value; renderBody(); },
    );
    modeSel.setAttribute('aria-label', '万用表档位');
    box.append(row('档位', modeSel));

    const needsA = cfg.probes !== 'comp';
    const needsB = cfg.probes === 'AB';
    const needsComp = cfg.probes === 'comp' || cfg.probes === 'A+comp';

    if (needsA) {
      box.append(row(needsB ? '红表笔' : '测点', select(netOptions(), state.dmm.netId, (value) => {
        state.dmm.netId = value || null;
        refreshDmm();
      })));
    }
    if (needsB) {
      box.append(row('黑表笔', select(netOptions(), state.dmm.netB, (value) => {
        state.dmm.netB = value || null;
        refreshDmm();
      })));
    }
    if (needsComp) {
      box.append(row('支路元件', select(compOptions(), state.dmm.componentId, (value) => {
        state.dmm.componentId = value || null;
        refreshDmm();
      })));
    }

    if (state.dmm.mode === 'volt' || state.dmm.mode === 'amp') {
      const realWrap = document.createElement('label');
      realWrap.className = 'inst-check';
      const real = document.createElement('input');
      real.type = 'checkbox';
      real.checked = Boolean(state.dmm.realInput || state.dmm.real);
      // 修包 10 遗留 bug：面板写 state.dmm.real，内核读 opts.realInput，复选框一直无效
      real.addEventListener('change', () => {
        state.dmm.real = real.checked;
        state.dmm.realInput = real.checked;
        refreshDmm();
      });
      realWrap.append(real, document.createTextNode('真实内阻模式（电压档 10MΩ / 电流档 1Ω）'));
      box.append(realWrap);
    }

    // 表笔状态：与画布上的红/黑标记共用 state.dmm.netId / netB，随读数一并刷新
    const status = document.createElement('div');
    status.className = 'inst-probe-status';
    const red = document.createElement('span');
    red.className = 'inst-probe-pill';
    red.dataset.probe = 'red';
    const black = document.createElement('span');
    black.className = 'inst-probe-pill';
    black.dataset.probe = 'black';
    status.append(red, black);
    box.append(status);

    const hint = document.createElement('p');
    hint.className = 'inst-hint inst-mode-hint';
    box.append(hint);

    const screen = document.createElement('div');
    screen.className = 'inst-screen';
    const value = document.createElement('span');
    value.className = 'inst-value';
    value.textContent = '—';
    const note = document.createElement('span');
    note.className = 'inst-note';
    screen.append(value, note);
    box.append(screen);

    body.append(box);
    state.dmmValueEl = value;
    state.dmmNoteEl = note;
    state.dmmRedEl = red;
    state.dmmBlackEl = black;
    state.dmmHintEl = hint;
    refreshDmm();
  }

  /** 表笔落点缺失时给明确提示，避免学生对着「—」不知道要拖探针 */
  function renderProbeStatus(read) {
    const cfg = dmmConfig();
    const pill = (el, label, netId) => {
      if (!el) return;
      el.textContent = `${label} · ${netId || '未接触'}`;
      el.classList.toggle('is-live', Boolean(netId));
      el.classList.remove('is-missing');
    };
    pill(state.dmmRedEl, '红表笔', state.dmm.netId);
    pill(state.dmmBlackEl, '黑表笔', state.dmm.netB);

    const missingA = cfg.probes !== 'comp' && !state.dmm.netId;
    const missingB = cfg.probes === 'AB' && !state.dmm.netB;
    const missingComp = (cfg.probes === 'comp' || cfg.probes === 'A+comp') && !state.dmm.componentId;
    if (state.dmmRedEl && missingA) state.dmmRedEl.classList.add('is-missing');
    if (state.dmmBlackEl && missingB) state.dmmBlackEl.classList.add('is-missing');

    if (!state.dmmHintEl) return;
    let text = cfg.hint;
    if (missingA || missingB || missingComp) {
      text = '探针未接触任何节点：把画布上的红/黑表笔拖到端子、孔位或导线上'
        + (missingComp ? '；电流档拖到元件/导线会自动串入支路' : '');
    }
    if (!read.ok && read.error) text = `${read.error} · ${text}`;
    state.dmmHintEl.textContent = text;
  }

  function refreshDmm() {
    if (!state.dmmValueEl) return;
    const read = dmmRead(api.model ? api.model() : null, dmmOpts());
    state.lastRead = read;
    state.dmmValueEl.textContent = read.ok ? read.text : '—';
    state.dmmValueEl.classList.toggle('is-error', !read.ok);
    state.dmmNoteEl.textContent = read.ok ? (read.note || '') : (read.error || '');
    renderProbeStatus(read);
  }

  /* ---------------------------------------------------------------- 示波器 */

  function transient() {
    return api.transient ? api.transient() : null;
  }

  function digitalChannels() {
    const res = transient();
    if (!res || !res.channels) return [];
    return res.channels.filter((ch) => ch.type === 'digital');
  }

  function analogChannels() {
    const res = transient();
    if (!res || !res.channels) return [];
    return res.channels.filter((ch) => ch.type !== 'digital');
  }

  function renderScope() {
    const box = document.createElement('div');
    box.className = 'inst-scope';
    if (skinOn) {
      box.classList.add('is-hep');
      box.append(hepScopeFace());
    }

    const chOptions = [{ value: '', label: '— 未挂 —' }].concat(
      analogChannels().map((ch) => ({ value: ch.netId, label: `${ch.netId}（${ch.driver}）` })),
    );
    box.append(row('CH1', select(chOptions, state.scope.ch1, (v) => {
      state.scope.ch1 = v || null;
      drawScope();
    })));
    box.append(row('CH2', select(chOptions, state.scope.ch2, (v) => {
      state.scope.ch2 = v || null;
      drawScope();
    })));
    box.append(row('时基', select([
      { value: '0.0001', label: '100µs/div' },
      { value: '0.001', label: '1ms/div' },
      { value: '0.01', label: '10ms/div' },
      { value: '0.1', label: '100ms/div' },
      { value: '1', label: '1s/div' },
    ], String(state.scope.timebase), (v) => {
      state.scope.timebase = Number(v);
      drawScope();
    })));
    box.append(row('幅值', select([
      { value: '0.1', label: '0.1V/div' },
      { value: '0.5', label: '0.5V/div' },
      { value: '1', label: '1V/div' },
      { value: '2', label: '2V/div' },
      { value: '5', label: '5V/div' },
    ], String(state.scope.vdiv), (v) => {
      state.scope.vdiv = Number(v);
      drawScope();
    })));
    box.append(row('耦合', select([
      { value: 'dc', label: 'DC' },
      { value: 'ac', label: 'AC' },
    ], state.scope.coupling, (v) => {
      state.scope.coupling = v;
      clearSingleFreeze();
      drawScope();
    })));

    /* ---- 阶段 2 R4a：触发控件（规格：放在现有控件下方、波形 Canvas 上方） ---- */
    const trig = state.scope.trigger;
    box.append(row('触发边沿', select([
      { value: 'rising', label: '上升沿' },
      { value: 'falling', label: '下降沿' },
    ], trig.edge, (v) => { trig.edge = v; clearSingleFreeze(); drawScope(); })));
    box.append(row('触发电平 (V)', numberInput(trig.level, -10, 10, 0.1, (v) => {
      trig.level = Number.isFinite(v) ? Math.min(10, Math.max(-10, v)) : 2.5;
      clearSingleFreeze();
      drawScope();
    })));
    box.append(row('触发模式', select([
      { value: 'auto', label: '自动（无触发显示整段）' },
      { value: 'normal', label: '正常' },
      { value: 'single', label: '单次（触发后冻结）' },
    ], trig.mode, (v) => { trig.mode = v; clearSingleFreeze(); renderBody(); })));
    if (trig.mode === 'single') {
      box.append(button('单次触发', () => {
        clearSingleFreeze();
        if (api.runTransient) {
          api.runTransient({ duration: state.scope.timebase * 20, dt: state.scope.timebase / 100 });
        }
        drawScope();
      }, 'btn-primary'));
    }

    const canvas = document.createElement('canvas');
    canvas.className = 'inst-scope-canvas';
    canvas.setAttribute('aria-label', '示波器波形');
    if (skinOn) {
      // 写实屏幕外框：canvas 仍是同一个节点，class / 查询契约不变
      const bezel = document.createElement('div');
      bezel.className = 'hep-scope-bezel';
      bezel.append(canvas);
      box.append(bezel);
    } else {
      box.append(canvas);
    }

    const measureBox = document.createElement('div');
    measureBox.className = 'inst-measure';
    box.append(measureBox);

    const actions = document.createElement('div');
    actions.className = 'inst-actions';
    actions.append(
      button('运行暂态', () => {
        if (api.runTransient) api.runTransient({ duration: state.scope.timebase * 10, dt: state.scope.timebase / 100 });
      }),
      button('自动测量', () => { drawScope(); }),
    );
    box.append(actions);

    body.append(box);
    state.scopeCanvas = canvas;
    drawScope();
  }

  function waveOf(netId) {
    const res = transient();
    if (!res || !res.waveforms) return null;
    return res.waveforms.find((w) => w.netId === netId) || null;
  }

  /** 改触发控件 / 按「单次触发」时清掉冻结画面，重新进入待触发状态 */
  function clearSingleFreeze() {
    state.scope.frozenT0 = null;
    state.scope.frozenDrawn = false;
    state.scope.trigger.armed = true;
  }

  /**
   * 阶段 2 R4a：触发后的显示窗口。
   * auto / normal 找不到触发点 → 左边界 = 0（显示整段）；
   * single 找到后 armed=false 并记住 t0，后续帧不再重绘（冻结静态窗口）。
   */
  function triggerWindow(netId) {
    const trig = state.scope.trigger;
    const span = state.scope.timebase * 10;
    const wave = netId ? waveOf(netId) : null;
    const base = wave && wave.samples.length ? wave.samples[0].t : 0;
    const whole = { t0: base, span, hit: null, frozen: false };
    if (!wave || wave.samples.length < 2) return whole;
    if (trig.mode === 'single' && !trig.armed && Number.isFinite(state.scope.frozenT0)) {
      return { t0: state.scope.frozenT0, span, hit: null, frozen: true };
    }
    const hit = findTrigger(wave.samples, { edge: trig.edge, level: trig.level });
    if (!hit) return whole;
    const pre = Math.min(span * 0.1, state.scope.timebase * 2);
    const t0 = Math.max(base, hit.t - pre);
    if (trig.mode === 'single') {
      trig.armed = false;
      state.scope.frozenT0 = t0;
    }
    return { t0, span, hit, frozen: false };
  }

  function drawScope() {
    const canvas = state.scopeCanvas;
    if (!canvas) return;
    const trig = state.scope.trigger
      || (state.scope.trigger = { edge: 'rising', level: 2.5, mode: 'auto', armed: true });
    // single 已冻结：保留上一帧静态窗口，不重绘（余辉也一并停掉）
    if (trig.mode === 'single' && !trig.armed && state.scope.frozenDrawn) return;
    const win = triggerWindow(state.scope.ch1 || state.scope.ch2);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = canvas.clientWidth || 320;
    const cssH = canvas.clientHeight || 160;
    const needW = Math.round(cssW * dpr);
    const needH = Math.round(cssH * dpr);
    // 尺寸没变就别重设 canvas.width —— 重设会清空像素，荧光余辉就没了
    if (canvas.width !== needW || canvas.height !== needH) {
      canvas.width = needW;
      canvas.height = needH;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 荧光余辉：每帧只铺一层 6% 底色，旧轨迹自然拖尾变暗；
    // prefers-reduced-motion 时退化成整屏清屏，不留拖尾。
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    ctx.fillStyle = reduce ? '#0f1419' : 'rgba(15, 20, 25, 0.06)';
    ctx.fillRect(0, 0, cssW, cssH);

    // 8 行 × 10 列分度，每大格再分 5 小格（40×50 细网格）
    const COLS = 10;
    const ROWS = 8;
    const SUB = 5;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(120, 200, 180, 0.09)';
    for (let i = 1; i < COLS * SUB; i += 1) {
      const x = (i / (COLS * SUB)) * cssW;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, cssH);
      ctx.stroke();
    }
    for (let j = 1; j < ROWS * SUB; j += 1) {
      const y = (j / (ROWS * SUB)) * cssH;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(cssW, y);
      ctx.stroke();
    }
    // 大格线亮一档，读数落在格子上
    ctx.strokeStyle = 'rgba(120, 200, 180, 0.2)';
    for (let i = 1; i < COLS; i += 1) {
      const x = (i / COLS) * cssW;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, cssH);
      ctx.stroke();
    }
    for (let j = 1; j < ROWS; j += 1) {
      const y = (j / ROWS) * cssH;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(cssW, y);
      ctx.stroke();
    }
    // 中心十字线（0V 基线 / 时间零点参考）
    ctx.strokeStyle = 'rgba(120, 200, 180, 0.3)';
    ctx.beginPath();
    ctx.moveTo(0, cssH / 2);
    ctx.lineTo(cssW, cssH / 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cssW / 2, 0);
    ctx.lineTo(cssW / 2, cssH);
    ctx.stroke();

    const colors = { ch1: '#f2c14e', ch2: '#5fd39a' };
    const drawChannel = (netId, color) => {
      const wave = netId ? waveOf(netId) : null;
      if (!wave) return;
      const span = win.span;
      const t0 = win.t0;
      const vdiv = state.scope.vdiv;
      const zero = cssH / 2;
      const sampleMean = wave.samples.reduce((a, b) => a + b.v, 0) / wave.samples.length;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      // 荧光笔迹：一圈同色微光，让轨迹"亮"起来（真机余辉的近似）
      ctx.shadowColor = color;
      ctx.shadowBlur = reduce ? 0 : 6;
      ctx.beginPath();
      let started = false;
      wave.samples.forEach((s) => {
        if (s.t < t0 || s.t - t0 > span) return;
        const x = ((s.t - t0) / span) * cssW;
        const v = state.scope.coupling === 'ac' ? s.v - sampleMean : s.v;
        const y = zero - (v / (vdiv * 8)) * cssH;
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.shadowBlur = 0;
    };
    drawChannel(state.scope.ch1, colors.ch1);
    drawChannel(state.scope.ch2, colors.ch2);

    // 阶段 2 R4a：触发电平线 + 触发点竖虚线（位置来自 triggerWindow，
    // 不再硬编码 2.5V 上升沿）。冻结帧保留原画面，不重画。
    {
      const level = Number.isFinite(trig.level) ? trig.level : 2.5;
      const yLevel = cssH / 2 - (level / (state.scope.vdiv * 8)) * cssH;
      ctx.strokeStyle = 'rgba(242, 193, 78, 0.3)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.moveTo(0, yLevel);
      ctx.lineTo(cssW, yLevel);
      ctx.stroke();
      ctx.setLineDash([]);
      // 电平箭头（左侧边缘）
      ctx.fillStyle = 'rgba(242, 193, 78, 0.95)';
      ctx.beginPath();
      ctx.moveTo(0, yLevel);
      ctx.lineTo(7, yLevel - 4);
      ctx.lineTo(7, yLevel + 4);
      ctx.closePath();
      ctx.fill();
      if (win.hit && win.hit.t >= win.t0 && win.hit.t - win.t0 <= win.span) {
        const x = ((win.hit.t - win.t0) / win.span) * cssW;
        ctx.strokeStyle = 'rgba(242, 193, 78, 0.85)';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, cssH);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = '10px "Cascadia Mono", Consolas, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillStyle = 'rgba(242, 193, 78, 0.9)';
        ctx.fillText('T', Math.min(cssW - 12, x + 3), 3);
      }
    }
    if (trig.mode === 'single' && !trig.armed) state.scope.frozenDrawn = true;

    // 自动测量
    const box = body.querySelector('.inst-measure');
    if (!box) return;
    box.replaceChildren();
    [state.scope.ch1, state.scope.ch2].forEach((netId, index) => {
      if (!netId) return;
      const wave = waveOf(netId);
      if (!wave) return;
      const m = scopeMeasure(wave.samples, { coupling: state.scope.coupling });
      const line = document.createElement('p');
      line.className = 'inst-measure-line';
      line.textContent = `CH${index + 1} ${netId}：Vpp ${fmt(m.vpp, 'V')} · Vrms ${fmt(m.vrms, 'V')} · Vmax ${fmt(m.vmax, 'V')} · Vmin ${fmt(m.vmin, 'V')} · Vavg ${fmt(m.vavg, 'V')}`
        + (m.freq ? ` · f ${fmt(m.freq, 'Hz')} · T ${fmt(m.period, 's')}` : '')
        + (m.duty !== null && m.duty !== undefined ? ` · 占空比 ${m.duty.toFixed(1)}%` : '')
        + (m.riseTime ? ` · tr ${fmt(m.riseTime, 's')}` : '');
      box.append(line);
    });
    if (box.childElementCount === 0) {
      const hint = document.createElement('p');
      hint.className = 'inst-hint';
      hint.textContent = '先挂 CH1/CH2 并运行一次暂态';
      box.append(hint);
    }
  }

  function fmt(value, unit) {
    if (value === null || value === undefined || !Number.isFinite(value)) return '—';
    const abs = Math.abs(value);
    if (unit === 'Hz') return abs >= 1000 ? `${(value / 1000).toFixed(3)}kHz` : `${value.toFixed(2)}Hz`;
    if (unit === 's') return abs >= 1 ? `${value.toFixed(3)}s` : `${(value * 1000).toFixed(3)}ms`;
    return abs >= 1 ? `${value.toFixed(3)}V` : `${(value * 1000).toFixed(1)}mV`;
  }

  /* ---------------------------------------------------------------- 逻辑分析仪 */

  /* ---- 阶段 2 R6：时序图 / 状态机（纯 Canvas，数据源 = transientRun.last） ---- */
  const LA_COLORS = ['#f2c14e', '#5fd39a', '#5aa9e6', '#e2685f', '#c58af0', '#7fd6c2', '#f0a35e', '#9fb4c8'];

  function laNets() {
    return (state.la.nets && state.la.nets.length)
      ? state.la.nets.slice(0, 8)
      : digitalChannels().map((c) => c.netId).slice(0, 8);
  }

  function drawLaTiming() {
    const canvas = state.laTimingCanvas;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = canvas.clientWidth || 300;
    const rowH = 22;
    const nets = laNets();
    const H = Math.max(72, 18 + Math.max(1, nets.length) * rowH);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0f1419';
    ctx.fillRect(0, 0, W, H);

    const left = 56;
    const plotW = Math.max(20, W - left - 6);
    const span = state.scope.timebase * 10;
    // 时间网格：每 timebase 一格
    ctx.strokeStyle = 'rgba(120, 200, 180, 0.16)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 10; i += 1) {
      const x = left + (i / 10) * plotW;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    let tMin = Infinity;
    let tMax = -Infinity;
    nets.forEach((netId) => {
      const w = waveOf(netId);
      if (w && w.samples.length) {
        tMin = Math.min(tMin, w.samples[0].t);
        tMax = Math.max(tMax, w.samples[w.samples.length - 1].t);
      }
    });
    if (!Number.isFinite(tMin)) tMin = 0;
    if (!Number.isFinite(tMax) || tMax <= tMin) tMax = tMin + span;
    const win = Math.min(span, tMax - tMin);

    if (nets.length === 0) {
      ctx.fillStyle = '#8ea3b8';
      ctx.font = '11px "Cascadia Mono", Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.fillText('运行暂态后这里会显示数字通道时序', 8, H / 2);
      return;
    }
    nets.forEach((netId, idx) => {
      const y0 = 12 + idx * rowH;
      ctx.fillStyle = LA_COLORS[idx % LA_COLORS.length];
      ctx.font = '10px "Cascadia Mono", Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(netId).slice(0, 8), 4, y0 + rowH / 2);
      const w = waveOf(netId);
      if (!w) return;
      ctx.strokeStyle = LA_COLORS[idx % LA_COLORS.length];
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let prevY = null;
      w.samples.forEach((s) => {
        if (s.t < tMin || s.t > tMin + win) return;
        const x = left + ((s.t - tMin) / win) * plotW;
        const y = y0 + (s.v >= 2.5 ? 4 : rowH - 6);
        if (prevY === null) ctx.moveTo(x, y);
        else { ctx.lineTo(x, prevY); ctx.lineTo(x, y); }
        prevY = y;
      });
      ctx.stroke();
    });
    // 两个游标 + Δt 读数
    const c1 = left + plotW * 0.33;
    const c2 = left + plotW * 0.66;
    ctx.strokeStyle = 'rgba(242, 193, 78, 0.8)';
    ctx.setLineDash([3, 3]);
    [c1, c2].forEach((x) => {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    });
    ctx.setLineDash([]);
    const dt = (c2 - c1) / plotW * win;
    ctx.fillStyle = '#f2c14e';
    ctx.font = '10px "Cascadia Mono", Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`Δt ${dt >= 1 ? `${dt.toFixed(3)}s` : `${(dt * 1000).toFixed(2)}ms`} · 1/f ${dt > 0 ? `${(1 / dt).toFixed(0)}Hz` : '—'}`, W - 6, 9);
  }

  function drawStateMachine(canvas, sm) {
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = canvas.clientWidth || 300;
    const H = canvas.clientHeight || 180;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0f1419';
    ctx.fillRect(0, 0, W, H);
    if (!sm || !sm.ok || sm.states.length === 0) {
      ctx.fillStyle = '#8ea3b8';
      ctx.font = '11px "Cascadia Mono", Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(sm && sm.error ? sm.error : '点「提取状态机」查看状态转移图', W / 2, H / 2);
      return;
    }
    const cx = W / 2;
    const cy = H / 2;
    const R = Math.max(24, Math.min(W, H) / 2 - 30);
    const pos = new Map();
    sm.states.forEach((s, i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / sm.states.length;
      pos.set(s.id, { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) });
    });
    const arrow = (a, b, label) => {
      if (!a || !b) return;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const x1 = a.x + ux * 15;
      const y1 = a.y + uy * 15;
      const x2 = b.x - ux * 17;
      const y2 = b.y - uy * 17;
      ctx.strokeStyle = 'rgba(122, 180, 220, 0.75)';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      ctx.fillStyle = 'rgba(122, 180, 220, 0.9)';
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - ux * 7 - uy * 4, y2 - uy * 7 + ux * 4);
      ctx.lineTo(x2 - ux * 7 + uy * 4, y2 - uy * 7 - ux * 4);
      ctx.closePath(); ctx.fill();
      if (label) {
        ctx.fillStyle = '#9fb4c8';
        ctx.font = '9px "Cascadia Mono", Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(label, (x1 + x2) / 2, (y1 + y2) / 2 - 4);
      }
    };
    sm.transitions.forEach((t) => arrow(pos.get(t.from), pos.get(t.to), t.count > 1 ? `×${t.count}` : ''));
    sm.states.forEach((s, i) => {
      const p = pos.get(s.id);
      ctx.fillStyle = 'rgba(95, 211, 154, 0.18)';
      ctx.strokeStyle = LA_COLORS[i % LA_COLORS.length];
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(p.x, p.y, 15, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#dfe8f2';
      ctx.font = '10px "Cascadia Mono", Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.label, p.x, p.y);
    });
  }

  function runLaStateMachine(resultEl) {
    const res = transient();
    const waves = res && res.waveforms ? res.waveforms : [];
    const nets = digitalChannels().map((c) => c.netId);
    const clockNetId = nets.find((n) => /clk|clock|cp/i.test(n)) || null;
    const sm = extractStateMachine(waves, {
      clockNetId,
      channelNetIds: nets.filter((n) => n !== clockNetId).slice(0, 8),
    });
    state.laStateMachine = sm;
    if (resultEl) {
      resultEl.textContent = sm.ok
        ? `${sm.states.length} 个状态 · ${sm.transitions.length} 条转移 · ${sm.sequence.slice(0, 10).map((x) => x.id).join('→')}`
        : (sm.error || '无法提取状态');
    }
    drawStateMachine(state.laSmCanvas, sm);
    return sm;
  }

  function renderLa() {
    const box = document.createElement('div');
    box.className = 'inst-la';

    const channels = digitalChannels();
    const list = document.createElement('div');
    list.className = 'inst-la-list';
    if (channels.length === 0) {
      const hint = document.createElement('p');
      hint.className = 'inst-hint';
      hint.textContent = '暂态结果里没有数字通道（先搭一个时钟/门电路并运行）';
      list.append(hint);
    } else {
      channels.slice(0, 8).forEach((ch, index) => {
        const line = document.createElement('label');
        line.className = 'inst-check';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.net = ch.netId;
        cb.checked = state.la.nets.includes(ch.netId);
        cb.addEventListener('change', () => {
          state.la.nets = [...list.querySelectorAll('input:checked')].map((i) => i.dataset.net);
          drawLaTiming();
        });
        const text = document.createElement('span');
        text.textContent = `CH${index + 1} ${ch.netId}（${ch.driver}）`;
        line.append(cb, text);
        list.append(line);
      });
    }
    box.append(list);

    box.append(row('波特率', select([
      { value: '9600', label: 'UART 9600' },
      { value: '115200', label: 'UART 115200' },
    ], String(state.la.baud), (v) => { state.la.baud = Number(v); })));

    // R6 时序图：勾选通道后即时重画，时间轴每 timebase 一格 + 两个游标
    const timingLabel = document.createElement('p');
    timingLabel.className = 'inst-hint';
    timingLabel.textContent = '时序图（每格 = 示波器时基，游标可读 Δt / 1/f）';
    box.append(timingLabel);
    const timing = document.createElement('canvas');
    timing.className = 'inst-la-timing';
    timing.setAttribute('aria-label', '逻辑分析仪时序图');
    box.append(timing);
    state.laTimingCanvas = timing;

    const result = document.createElement('div');
    result.className = 'inst-la-result';
    box.append(result);

    const actions = document.createElement('div');
    actions.className = 'inst-actions';
    actions.append(
      button('解码 UART', () => {
        const net = state.la.nets[0];
        const wave = net ? waveOf(net) : null;
        const decoded = wave ? decodeUart(wave.samples, state.la.baud) : { ok: false, bytes: [], error: '未选通道' };
        state.la.bytes = decoded.bytes;
        result.textContent = decoded.ok
          ? `解出 ${decoded.bytes.length} 字节：${decoded.bytes.map((b) => b.text).join(' ')}`
          : `解码失败：${decoded.error}`;
      }),
      button('解码 I2C', () => {
        if (state.la.nets.length < 2) {
          result.textContent = 'I2C 需要挂两条线（SCL / SDA）';
          return;
        }
        const w1 = waveOf(state.la.nets[0]);
        const w2 = waveOf(state.la.nets[1]);
        const decoded = w1 && w2 ? decodeI2c(w1.samples, w2.samples) : { ok: false, bytes: [] };
        result.textContent = decoded.ok
          ? `I2C 字节：${decoded.bytes.map((b) => `0x${b.value.toString(16).toUpperCase()}`).join(' ')}`
          : `未解出字节：${decoded.error || ''}`;
      }),
    );
    box.append(actions);

    // R6 状态机：从时钟上升沿采样各数字通道，画状态转移图
    const smLabel = document.createElement('p');
    smLabel.className = 'inst-hint';
    smLabel.textContent = '状态机（按时钟沿提取输出位组合）';
    box.append(smLabel);
    const smResult = document.createElement('div');
    smResult.className = 'inst-la-result';
    box.append(smResult);
    const smCanvas = document.createElement('canvas');
    smCanvas.className = 'inst-la-sm-canvas';
    smCanvas.setAttribute('aria-label', '状态转移图');
    box.append(smCanvas);
    state.laSmCanvas = smCanvas;
    const smActions = document.createElement('div');
    smActions.className = 'inst-actions';
    smActions.append(button('提取状态机', () => runLaStateMachine(smResult)));
    box.append(smActions);

    body.append(box);
    requestAnimationFrame(() => {
      drawLaTiming();
      drawStateMachine(smCanvas, state.laStateMachine || null);
    });
  }

  /* ---------------------------------------------------------------- 函数发生器 */

  function renderFgen() {
    const box = document.createElement('div');
    box.className = 'inst-fgen';
    if (skinOn) {
      box.classList.add('is-hep');
      box.append(hepFgenFace());
    }
    const comp = api.fgenComponent ? api.fgenComponent() : null;

    if (!comp) {
      const hint = document.createElement('p');
      hint.className = 'inst-hint';
      hint.textContent = '电路里还没有函数发生器。放一个后可直接在元件属性里改波形/频率，或在这里编辑。';
      box.append(hint);
      box.append(button('放置函数发生器', () => {
        if (api.placeFgen) api.placeFgen();
        renderBody();
      }, 'btn-primary'));
      body.append(box);
      return;
    }

    const params = comp.params || {};
    box.append(row('波形', select(
      Object.entries(FGEN_WAVES).map(([value, label]) => ({ value, label })),
      params.wave || 'sine',
      (v) => api.updateFgen && api.updateFgen(comp.id, { wave: v }),
    )));
    box.append(row('频率 (Hz)', numberInput(params.frequency, 0.1, 100000, 100,
      (v) => api.updateFgen && api.updateFgen(comp.id, { frequency: v }))));
    box.append(row('幅值 (Vpp)', numberInput(params.amplitude, 0, 10, 0.5,
      (v) => api.updateFgen && api.updateFgen(comp.id, { amplitude: v }))));
    box.append(row('偏置 (V)', numberInput(params.offset, -5, 5, 0.5,
      (v) => api.updateFgen && api.updateFgen(comp.id, { offset: v }))));
    box.append(row('占空比 (%)', numberInput(params.duty, 10, 90, 5,
      (v) => api.updateFgen && api.updateFgen(comp.id, { duty: v }))));

    /* ---- 阶段 2 R4b：输出阻抗 + 负载端分压说明 ---- */
    const zNow = fgenOutputImpedance(params) > 0 ? '50' : 'hi';
    box.append(row('输出阻抗', select(FGEN_Z_OPTIONS, zNow, (v) => {
      if (api.updateFgen) api.updateFgen(comp.id, { outputImpedance: v === 'hi' ? 'hi' : 50 });
      renderBody();
    })));
    let loadR = Infinity;
    try {
      const m = api.model ? api.model() : null;
      if (m) {
        const nl = m.getNetlist();
        loadR = fgenLoadResistance(
          m.getState().components, nl.netOf, comp,
          nl.netOf.get(`c:${comp.id}:OUT`), nl.netOf.get(`c:${comp.id}:GND`),
        );
      }
    } catch (_) { loadR = Infinity; }
    const rin = fgenOutputImpedance(params);
    const ratio = rin > 0 && Number.isFinite(loadR) ? loadR / (loadR + rin) : 1;
    const zNote = document.createElement('p');
    zNote.className = 'inst-hint';
    zNote.textContent = `测量点 = 负载端 · ${rin > 0 ? `内阻 ${rin}Ω` : '高阻输出'} · `
      + `${Number.isFinite(loadR) ? `负载 ${loadR.toFixed(0)}Ω` : '高阻负载（示波器 1MΩ）'} · `
      + `输出 = ${(ratio * 100).toFixed(0)}% V_src`
      + (rin > 0 && Number.isFinite(loadR) ? '（接 50Ω 负载时幅值减半）' : '');
    box.append(zNote);

    const note = document.createElement('p');
    note.className = 'inst-hint';
    note.textContent = '发生器 = 电路里的 fgen 元件：改动走撤销栈，可随存档保存；把它删掉就是断开激励。';
    box.append(note);
    body.append(box);
  }

  function numberInput(value, min, max, step, onChange) {
    const el = document.createElement('input');
    el.className = 'inst-input';
    el.type = 'number';
    el.min = String(min);
    el.max = String(max);
    el.step = String(step);
    el.value = String(Number(value) || 0);
    el.addEventListener('change', () => onChange(Number(el.value)));
    return el;
  }

  /* ---------------------------------------------------------------- 对外 */

  selectTab('dmm');

  return {
    selectTab,
    /** 切换 HEP 实物外观（由 app 的 onSkinChange 驱动，重绘当前 tab） */
    setSkin(on) {
      skinOn = Boolean(on);
      renderBody();
      return skinOn;
    },
    refresh() {
      if (state.tab === 'dmm') refreshDmm();
      else if (state.tab === 'scope') drawScope();
      else if (state.tab === 'la') renderBody();
      else renderBody();
    },
    /** 探针（探针状态随存档保存） */
    snapshot() {
      return {
        tab: state.tab,
        dmm: { ...state.dmm },
        scope: { ...state.scope, trigger: { ...state.scope.trigger } },
        la: { nets: [...state.la.nets], baud: state.la.baud },
        markers: Object.fromEntries(Object.entries(state.markers).map(([k, v]) => [k, { ...v }])),
      };
    },
    restore(data) {
      if (!data) return;
      if (data.tab && TABS.some((t) => t.id === data.tab)) {
        selectTab(data.tab);
      }
      if (data.dmm) {
        Object.assign(state.dmm, data.dmm);
        // 老存档只有 real：补出同义的 realInput，保证内阻模式恢复后依然生效
        if (data.dmm.realInput === undefined) state.dmm.realInput = Boolean(data.dmm.real);
      }
      if (data.scope) {
        // 旧存档没有 trigger 字段：只合并其余字段，别把触发配置冲成 undefined
        const { trigger, ...rest } = data.scope;
        Object.assign(state.scope, rest);
        if (trigger && typeof trigger === 'object') Object.assign(state.scope.trigger, trigger);
      }
      if (data.la) Object.assign(state.la, data.la);
      state.markers = data.markers ? { ...data.markers } : {};
      renderBody();
    },
    /** 探针读数（探针/自动化用，不经过 DOM） */
    read() {
      return {
        dmm: dmmRead(api.model ? api.model() : null, dmmOpts()),
        scope: {
          ch1: state.scope.ch1,
          ch2: state.scope.ch2,
          measures: [state.scope.ch1, state.scope.ch2].map((netId) => {
            const wave = netId ? waveOf(netId) : null;
            return { netId, ...(wave ? scopeMeasure(wave.samples, { coupling: state.scope.coupling }) : {}) };
          }),
        },
        la: {
          nets: [...state.la.nets], baud: state.la.baud, bytes: state.la.bytes,
          stateMachine: state.laStateMachine ? {
            ok: state.laStateMachine.ok,
            states: state.laStateMachine.states.length,
            transitions: state.laStateMachine.transitions.length,
            sequence: state.laStateMachine.sequence.slice(0, 12).map((x) => x.id),
            error: state.laStateMachine.error,
          } : null,
        },
        markers: { ...state.markers },
      };
    },
    /** 设置 DMM（探针直接用，省得点 DOM） */
    setDmm(patch) {
      Object.assign(state.dmm, patch || {});
      if (state.tab === 'dmm') renderBody();
      return { ...state.dmm };
    },
    setScope(patch) {
      Object.assign(state.scope, patch || {});
      if (state.tab === 'scope') renderBody();
      return { ...state.scope };
    },
    setLa(patch) {
      Object.assign(state.la, patch || {});
      if (state.tab === 'la') renderBody();
      return { ...state.la };
    },
    /* 画布探针标记（包 15 遗留建议 2）：与下拉共用同一份测点状态 */
    probes() {
      return PROBE_SLOTS.map((slot) => ({
        id: slot.id,
        label: slot.label,
        color: slot.color,
        hint: slot.hint,
        netId: state[slot.scope][slot.key] || null,
      }));
    },
    setProbe(slotId, netId, extra = {}) {
      const slot = PROBE_SLOTS.find((item) => item.id === slotId);
      if (!slot) return false;
      state[slot.scope][slot.key] = netId || null;
      // R7 电流档：表笔拖到元件 / 导线上时自动「串入支路」，
      // componentId 由 probe-markers 的落点解析给出，不必再回头点下拉
      if (slot.scope === 'dmm' && (state.dmm.mode === 'amp' || state.dmm.mode === 'aca')
        && extra && extra.componentId) {
        state.dmm.componentId = extra.componentId;
      }
      if (state.tab === slot.scope) renderBody();
      else notifyProbeChange();
      return true;
    },
    /** 供画布探针层读当前档位（只给必要字段，不暴露整个 state） */
    dmmMode() { return state.dmm.mode; },
    markerPositions() {
      return Object.fromEntries(Object.entries(state.markers).map(([k, v]) => [k, { ...v }]));
    },
    setMarkerPositions(map) {
      state.markers = {};
      Object.entries(map || {}).forEach(([id, pos]) => {
        if (PROBE_SLOTS.some((s) => s.id === id) && pos
          && Number.isFinite(pos.gx) && Number.isFinite(pos.gy)) {
          state.markers[id] = { gx: pos.gx, gy: pos.gy };
        }
      });
      return { ...state.markers };
    },
  };
}
