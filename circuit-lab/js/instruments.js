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

import { dmmRead, scopeMeasure, decodeUart, decodeI2c, FGEN_WAVES } from './instruments-core.js';

const TABS = [
  { id: 'dmm', label: '万用表' },
  { id: 'scope', label: '示波器' },
  { id: 'la', label: '逻辑分析' },
  { id: 'fgen', label: '函数发生' },
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
    dmm: { mode: 'volt', netId: null, netB: null, componentId: null, real: false },
    scope: { ch1: null, ch2: null, timebase: 0.001, vdiv: 1, coupling: 'dc', cursor1: 0, cursor2: 0 },
    la: { nets: [], baud: 9600, bytes: [], error: '' },
    // 画布探针标记位置：slotId → { gx, gy }（网格坐标，随存档保存）
    markers: {},
    lastRead: null,
  };

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

  function renderDmm() {
    const box = document.createElement('div');
    box.className = 'inst-dmm';

    const modeSel = select([
      { value: 'volt', label: '电压档 (V)' },
      { value: 'amp', label: '电流档 (A)' },
      { value: 'ohm', label: '电阻档 (Ω)' },
      { value: 'diode', label: '二极管档' },
    ], state.dmm.mode, (value) => { state.dmm.mode = value; renderBody(); });
    box.append(row('档位', modeSel));

    if (state.dmm.mode === 'volt') {
      box.append(row('测点', select(netOptions(), state.dmm.netId, (value) => {
        state.dmm.netId = value || null;
        refreshDmm();
      })));
    } else if (state.dmm.mode === 'amp') {
      box.append(row('元件', select(compOptions(), state.dmm.componentId, (value) => {
        state.dmm.componentId = value || null;
        refreshDmm();
      })));
    } else {
      box.append(row('测点 A', select(netOptions(), state.dmm.netId, (value) => {
        state.dmm.netId = value || null;
        refreshDmm();
      })));
      box.append(row('测点 B', select(netOptions(), state.dmm.netB, (value) => {
        state.dmm.netB = value || null;
        refreshDmm();
      })));
    }

    if (state.dmm.mode === 'volt' || state.dmm.mode === 'amp') {
      const realWrap = document.createElement('label');
      realWrap.className = 'inst-check';
      const real = document.createElement('input');
      real.type = 'checkbox';
      real.checked = state.dmm.real;
      real.addEventListener('change', () => { state.dmm.real = real.checked; refreshDmm(); });
      const text = document.createElement('span');
      text.textContent = '真实内阻模式（电压档 10MΩ / 电流档 1Ω）';
      realWrap.append(real, text);
      box.append(realWrap);
    }

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
    refreshDmm();
  }

  function refreshDmm() {
    if (!state.dmmValueEl) return;
    const read = dmmRead(api.model ? api.model() : null, state.dmm);
    state.lastRead = read;
    state.dmmValueEl.textContent = read.ok ? read.text : '—';
    state.dmmValueEl.classList.toggle('is-error', !read.ok);
    state.dmmNoteEl.textContent = read.ok ? (read.note || '') : (read.error || '');
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
      drawScope();
    })));

    const canvas = document.createElement('canvas');
    canvas.className = 'inst-scope-canvas';
    canvas.setAttribute('aria-label', '示波器波形');
    box.append(canvas);

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

  function drawScope() {
    const canvas = state.scopeCanvas;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = canvas.clientWidth || 320;
    const cssH = canvas.clientHeight || 160;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // 网格 10×8
    ctx.fillStyle = '#0f1419';
    ctx.fillRect(0, 0, cssW, cssH);
    ctx.strokeStyle = 'rgba(120, 200, 180, 0.18)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 10; i += 1) {
      const x = (i / 10) * cssW;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, cssH);
      ctx.stroke();
    }
    for (let j = 1; j < 8; j += 1) {
      const y = (j / 8) * cssH;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(cssW, y);
      ctx.stroke();
    }

    const colors = { ch1: '#f2c14e', ch2: '#5fd39a' };
    const drawChannel = (netId, color) => {
      const wave = netId ? waveOf(netId) : null;
      if (!wave) return;
      const span = state.scope.timebase * 10;
      const t0 = wave.samples.length > 0 ? wave.samples[0].t : 0;
      const vdiv = state.scope.vdiv;
      const zero = cssH / 2;
      const sampleMean = wave.samples.reduce((a, b) => a + b.v, 0) / wave.samples.length;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      wave.samples.forEach((s) => {
        if (s.t - t0 > span) return;
        const x = ((s.t - t0) / span) * cssW;
        const v = state.scope.coupling === 'ac' ? s.v - sampleMean : s.v;
        const y = zero - (v / (vdiv * 8)) * cssH;
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };
    drawChannel(state.scope.ch1, colors.ch1);
    drawChannel(state.scope.ch2, colors.ch2);

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
      line.textContent = `CH${index + 1} ${netId}：Vpp ${fmt(m.vpp, 'V')} · Vmax ${fmt(m.vmax, 'V')} · Vmin ${fmt(m.vmin, 'V')} · Vavg ${fmt(m.vavg, 'V')}`
        + (m.freq ? ` · f ${fmt(m.freq, 'Hz')} · T ${fmt(m.period, 's')}` : '');
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
    body.append(box);
  }

  /* ---------------------------------------------------------------- 函数发生器 */

  function renderFgen() {
    const box = document.createElement('div');
    box.className = 'inst-fgen';
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
        scope: { ...state.scope },
        la: { nets: [...state.la.nets], baud: state.la.baud },
        markers: Object.fromEntries(Object.entries(state.markers).map(([k, v]) => [k, { ...v }])),
      };
    },
    restore(data) {
      if (!data) return;
      if (data.tab && TABS.some((t) => t.id === data.tab)) {
        selectTab(data.tab);
      }
      if (data.dmm) Object.assign(state.dmm, data.dmm);
      if (data.scope) Object.assign(state.scope, data.scope);
      if (data.la) Object.assign(state.la, data.la);
      state.markers = data.markers ? { ...data.markers } : {};
      renderBody();
    },
    /** 探针读数（探针/自动化用，不经过 DOM） */
    read() {
      return {
        dmm: dmmRead(api.model ? api.model() : null, state.dmm),
        scope: {
          ch1: state.scope.ch1,
          ch2: state.scope.ch2,
          measures: [state.scope.ch1, state.scope.ch2].map((netId) => {
            const wave = netId ? waveOf(netId) : null;
            return { netId, ...(wave ? scopeMeasure(wave.samples, { coupling: state.scope.coupling }) : {}) };
          }),
        },
        la: { nets: [...state.la.nets], baud: state.la.baud, bytes: state.la.bytes },
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
    setProbe(slotId, netId) {
      const slot = PROBE_SLOTS.find((item) => item.id === slotId);
      if (!slot) return false;
      state[slot.scope][slot.key] = netId || null;
      if (state.tab === slot.scope) renderBody();
      else notifyProbeChange();
      return true;
    },
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
