/**
 * data-panel.js — 数据面板（指令包 11）：记录 / 对比 / 导出
 *
 * 记录源：
 *   · 暂态跑完后把每条波形按"采样间隔"抽稀写入环形缓冲（默认 10ms 一条）；
 *   · 每次直流仿真把万用表当前档位的读数写一条（通道名 __dmm）。
 *
 * 对比页：勾选 ≤8 条通道 → 对齐到并集时间网格 → 表格给首/末/最值，
 * 可选理论公式（compileFormula）在指定时刻给偏差。图表复用示波器画布，
 * 这里不重复造一套绘图。
 */

import {
  createRecorder,
  recordsToCsv,
  recordsToJson,
  jsonToRecords,
  alignSeries,
  compileFormula,
  migrateArchive,
  archivesEquivalent,
  ARCHIVE_VERSION,
} from './datastore.js';

const TABS = [
  { id: 'record', label: '记录' },
  { id: 'compare', label: '对比' },
  { id: 'export', label: '导出' },
];

export function createDataPanel(host, api = {}) {
  if (!host) return null;
  host.replaceChildren();

  const recorder = createRecorder({ capacity: 10000 });
  const state = {
    tab: 'record',
    interval: 0.01,
    selected: [],
    formula: 'v=5*(1-exp(-t/0.1))',
    formulaAt: 0.1,
    saveRecords: false,
    lastExport: null,
  };

  const wrap = document.createElement('div');
  wrap.className = 'data-panel';
  const head = document.createElement('div');
  head.className = 'inst-head';
  const title = document.createElement('span');
  title.className = 'inst-title';
  title.textContent = '数据';
  const fold = document.createElement('button');
  fold.type = 'button';
  fold.className = 'inst-fold';
  fold.textContent = '收起';
  head.append(title, fold);

  const tabs = document.createElement('div');
  tabs.className = 'inst-tabs';
  const body = document.createElement('div');
  body.className = 'inst-body';
  wrap.append(head, tabs, body);
  host.append(wrap);

  fold.addEventListener('click', () => {
    const folded = wrap.classList.toggle('is-folded');
    fold.textContent = folded ? '展开' : '收起';
  });

  const tabButtons = new Map();
  TABS.forEach((tab) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'inst-tab';
    btn.textContent = tab.label;
    btn.addEventListener('click', () => selectTab(tab.id));
    tabs.append(btn);
    tabButtons.set(tab.id, btn);
  });

  function selectTab(id) {
    state.tab = id;
    tabButtons.forEach((btn, key) => btn.classList.toggle('is-active', key === id));
    renderBody();
  }

  function row(label, control) {
    const line = document.createElement('label');
    line.className = 'inst-row';
    const text = document.createElement('span');
    text.className = 'inst-row-label';
    text.textContent = label;
    line.append(text, control);
    return line;
  }

  function button(text, onClick, kind = '') {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `btn btn-ghost inst-btn${kind ? ` ${kind}` : ''}`;
    el.textContent = text;
    el.addEventListener('click', onClick);
    return el;
  }

  function renderBody() {
    body.replaceChildren();
    if (state.tab === 'record') renderRecord();
    else if (state.tab === 'compare') renderCompare();
    else renderExport();
  }

  /* ---------------------------------------------------------------- 记录 */

  function renderRecord() {
    const list = recorder.list();
    const info = document.createElement('p');
    info.className = 'inst-hint';
    info.textContent = `环形缓冲：${list.length} 条通道 / 共 ${recorder.total()} 个采样（每通道上限 ${recorder.capacity}）`;
    body.append(info);

    const actions = document.createElement('div');
    actions.className = 'inst-actions';
    actions.append(
      button(recorder.paused() ? '恢复记录' : '暂停记录', () => {
        if (recorder.paused()) recorder.resume();
        else recorder.pause();
        renderBody();
      }),
      button('清空', () => { recorder.clear(); renderBody(); }),
    );
    body.append(actions);

    const box = document.createElement('div');
    box.className = 'inst-la-list';
    if (list.length === 0) {
      const hint = document.createElement('p');
      hint.className = 'inst-hint';
      hint.textContent = '还没有记录。跑一次暂态或直流仿真后会自动开始记录已挂探针。';
      box.append(hint);
    } else {
      list.forEach((ch) => {
        const line = document.createElement('p');
        line.className = 'inst-measure-line';
        const last = ch.last ? `${ch.last.v.toFixed(4)} @ ${ch.last.t.toFixed(4)}s` : '—';
        line.textContent = `${ch.id}（${ch.type === 'digital' ? '数字' : '模拟'}）· ${ch.count} 条 · 最新 ${last}`;
        box.append(line);
      });
    }
    body.append(box);
  }

  /* ---------------------------------------------------------------- 对比 */

  function renderCompare() {
    const list = recorder.list();
    if (list.length === 0) {
      const hint = document.createElement('p');
      hint.className = 'inst-hint';
      hint.textContent = '没有可对比的记录。';
      body.append(hint);
      return;
    }
    const pick = document.createElement('div');
    pick.className = 'inst-la-list';
    list.slice(0, 12).forEach((ch) => {
      const line = document.createElement('label');
      line.className = 'inst-check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.ch = ch.id;
      cb.checked = state.selected.includes(ch.id);
      cb.addEventListener('change', () => {
        const checked = [...pick.querySelectorAll('input:checked')].slice(0, 8).map((i) => i.dataset.ch);
        state.selected = checked;
        renderCompareTable();
      });
      const text = document.createElement('span');
      text.textContent = ch.id;
      line.append(cb, text);
      pick.append(line);
    });
    body.append(pick);

    const table = document.createElement('div');
    table.className = 'data-table';
    body.append(table);

    const formulaLine = document.createElement('div');
    formulaLine.className = 'inst-row';
    const input = document.createElement('input');
    input.className = 'inst-input';
    input.value = state.formula;
    input.addEventListener('change', () => { state.formula = input.value; renderCompareTable(); });
    formulaLine.append(input);
    const at = document.createElement('input');
    at.className = 'inst-input';
    at.type = 'number';
    at.step = '0.01';
    at.value = String(state.formulaAt);
    at.addEventListener('change', () => { state.formulaAt = Number(at.value); renderCompareTable(); });
    formulaLine.append(at);
    body.append(formulaLine);

    state.compareTable = table;
    renderCompareTable();
  }

  function renderCompareTable() {
    const table = state.compareTable;
    if (!table) return;
    table.replaceChildren();
    const channels = state.selected.map((id) => ({ id, samples: recorder.samples(id), type: 'analog' }));
    const aligned = alignSeries(channels);
    if (aligned.times.length === 0) {
      const hint = document.createElement('p');
      hint.className = 'inst-hint';
      hint.textContent = '勾选通道后在这里看对齐结果。';
      table.append(hint);
      return;
    }
    const formula = compileFormula(state.formula, {});
    const t = state.formulaAt;
    aligned.series.forEach((ser) => {
      const values = ser.values.filter((v) => v !== null);
      if (values.length === 0) return;
      const line = document.createElement('p');
      line.className = 'inst-measure-line';
      const vmin = Math.min(...values);
      const vmax = Math.max(...values);
      let extra = '';
      if (formula.ok) {
        // 在 t 处找最近的对齐点
        let best = -1;
        let bestGap = Infinity;
        aligned.times.forEach((time, index) => {
          const gap = Math.abs(time - t);
          if (gap < bestGap && ser.values[index] !== null) { bestGap = gap; best = index; }
        });
        if (best >= 0) {
          const theory = formula.fn(aligned.times[best]);
          const actual = ser.values[best];
          const dev = theory === 0 ? 0 : (actual - theory) / Math.abs(theory);
          extra = ` · t=${aligned.times[best].toFixed(3)}s 实测 ${actual.toFixed(4)} / 理论 ${Number(theory).toFixed(4)}（偏差 ${(dev * 100).toFixed(2)}%）`;
        }
      }
      line.textContent = `${ser.id}：首 ${values[0].toFixed(4)} · 末 ${values[values.length - 1].toFixed(4)} · 最小 ${vmin.toFixed(4)} · 最大 ${vmax.toFixed(4)}${extra}`;
      table.append(line);
    });
  }

  /* ---------------------------------------------------------------- 导出 */

  function renderExport() {
    const info = document.createElement('p');
    info.className = 'inst-hint';
    info.textContent = `导出记录 ${recorder.total()} 条；CSV 长格式（time,channel,value,type），JSON 可直接导回对比页。`;
    body.append(info);

    const actions = document.createElement('div');
    actions.className = 'inst-actions';
    actions.append(
      button('导出 CSV', () => {
        const text = recordsToCsv(recorder.records());
        download(`${fileStem()}-records.csv`, text, 'text/csv;charset=utf-8');
        state.lastExport = { kind: 'csv', bytes: text.length };
        renderBody();
      }),
      button('导出 JSON', () => {
        const text = recordsToJson(recorder.records(), { circuit: api.circuitName ? api.circuitName() : '' });
        download(`${fileStem()}-records.json`, text, 'application/json');
        state.lastExport = { kind: 'json', bytes: text.length };
        renderBody();
      }),
      button('截图 PNG', () => {
        const data = api.screenshot ? api.screenshot() : null;
        if (!data) return;
        download(`${fileStem()}-screenshot.png`, data, 'image/png', true);
      }),
    );
    body.append(actions);

    const saveRow = document.createElement('label');
    saveRow.className = 'inst-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.saveRecords;
    cb.addEventListener('change', () => { state.saveRecords = cb.checked; });
    const text = document.createElement('span');
    text.textContent = '保存项目时一并写入记录（数据量大，默认关闭）';
    saveRow.append(cb, text);
    body.append(saveRow);

    const projActions = document.createElement('div');
    projActions.className = 'inst-actions';
    projActions.append(
      button('保存项目', () => {
        if (api.saveProject) api.saveProject({ records: state.saveRecords ? recorder.records() : [] });
      }),
      button('打开项目', () => { if (api.openProject) api.openProject(); }),
    );
    body.append(projActions);

    if (state.lastExport) {
      const done = document.createElement('p');
      done.className = 'inst-hint';
      done.textContent = `上次导出：${state.lastExport.kind.toUpperCase()}（${state.lastExport.bytes} 字节）`;
      body.append(done);
    }
  }

  function fileStem() {
    return (api.circuitName ? api.circuitName() : 'circuit') || 'circuit';
  }

  function download(filename, content, mime, isDataUrl = false) {
    const blob = isDataUrl
      ? (() => {
        const bin = atob(String(content).split(',')[1] || '');
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: mime });
      })()
      : new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  selectTab('record');

  return {
    selectTab,
    recorder,
    /** 暂态结果 → 按采样间隔抽稀入环（每通道） */
    ingestTransient(res) {
      if (!res || !Array.isArray(res.waveforms)) return 0;
      let pushed = 0;
      res.waveforms.forEach((wave) => {
        const type = wave.type === 'digital' ? 'digital' : 'analog';
        let lastT = -Infinity;
        wave.samples.forEach((s) => {
          if (s.t - lastT < state.interval - 1e-12) return;
          lastT = s.t;
          if (recorder.push(wave.netId, s.t, s.v, type)) pushed += 1;
        });
      });
      if (state.tab === 'record') renderBody();
      return pushed;
    },
    /** 直流读数 → 一条记录 */
    ingestReading(label, value, type = 'analog') {
      if (!Number.isFinite(value)) return false;
      const ok = recorder.push(label, Date.now() / 1000, value, type);
      if (state.tab === 'record') renderBody();
      return ok;
    },
    records: () => recorder.records(),
    csv: () => recordsToCsv(recorder.records()),
    json: () => recordsToJson(recorder.records()),
    importJson(text) {
      const parsed = jsonToRecords(text);
      recorder.clear();
      parsed.channels.forEach((ch) => {
        ch.samples.forEach((s) => recorder.push(ch.id, s.t, s.v, ch.type));
      });
      state.selected = parsed.channels.slice(0, 8).map((ch) => ch.id);
      selectTab('compare');
      return { channels: parsed.channels.length, samples: parsed.channels.reduce((a, c) => a + c.samples.length, 0) };
    },
    snapshot() {
      return {
        tab: state.tab,
        interval: state.interval,
        selected: [...state.selected],
        formula: state.formula,
        saveRecords: state.saveRecords,
        version: ARCHIVE_VERSION,
        records: state.saveRecords ? recorder.records() : [],
      };
    },
    restore(data) {
      if (!data || typeof data !== 'object') return;
      if (data.tab && TABS.some((t) => t.id === data.tab)) selectTab(data.tab);
      if (Number.isFinite(Number(data.interval))) state.interval = Number(data.interval);
      if (Array.isArray(data.selected)) state.selected = data.selected.slice(0, 8);
      if (typeof data.formula === 'string') state.formula = data.formula;
      if (typeof data.saveRecords === 'boolean') state.saveRecords = data.saveRecords;
      if (Array.isArray(data.records) && data.records.length > 0) {
        recorder.clear();
        data.records.forEach((r) => recorder.push(r.channel, r.time, r.value, r.type));
      }
      renderBody();
    },
    /** 项目存档（含迁移） */
    buildArchive(modelApi) {
      const base = modelApi.serializeCircuit();
      const migrated = migrateArchive(base).data;
      migrated.records = state.saveRecords ? recorder.records() : [];
      migrated.dataOptions = this.snapshot();
      return migrated;
    },
    loadArchive(raw) {
      const migrated = migrateArchive(raw);
      if (!migrated.ok) return migrated;
      if (typeof api.applyArchive === 'function') api.applyArchive(migrated.data);
      if (Array.isArray(migrated.data.records) && migrated.data.records.length > 0) {
        recorder.clear();
        migrated.data.records.forEach((r) => recorder.push(r.channel, r.time, r.value, r.type));
      }
      renderBody();
      return migrated;
    },
    equivalent: (a, b) => archivesEquivalent(a, b),
  };
}
