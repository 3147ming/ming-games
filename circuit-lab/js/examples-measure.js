/**
 * examples-measure.js — 示例实验的复算与判定（指令包 12）
 *
 * 同时被三处调用，保证"模板值 / 报告值 / 验收值"是同一套算法：
 *   tools/gen-examples.mjs  生成模板时复算
 *   js/report.js            生成报告时取"实测值"
 *   tools/test-model.mjs    断言模板自带值 = 复算值
 */

import { solveDC } from './simdc.js';
import { solveTransient } from './simtrans.js';
import { solveDig } from './simdig.js';

const netOf = (modelApi, componentId, terminal) => {
  const netlist = modelApi.getNetlist();
  return (netlist.netOf && netlist.netOf.get(`c:${componentId}:${terminal}`)) || null;
};

function sampleAt(samples, t) {
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i].t >= t - 1e-12) {
      const k = (t - samples[i - 1].t) / (samples[i].t - samples[i - 1].t || 1);
      return samples[i - 1].v + (samples[i].v - samples[i - 1].v) * k;
    }
  }
  return samples[samples.length - 1].v;
}

/** 数字频率：用相邻翻转间隔均值（避免窗口首尾少沿造成的偏差） */
export function frequencyOf(samples, threshold = 2.5) {
  const flips = [];
  for (let i = 1; i < samples.length; i += 1) {
    if ((samples[i - 1].v > threshold) !== (samples[i].v > threshold)) flips.push(samples[i].t);
  }
  const gaps = [];
  for (let i = 1; i < flips.length; i += 1) gaps.push(flips[i] - flips[i - 1]);
  if (gaps.length === 0) return { freq: null, flips: flips.length };
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  // 方波：一个完整周期 = 两个翻转间隔
  return { freq: mean > 0 ? 0.5 / mean : null, flips: flips.length };
}

/**
 * 复算一个示例实验，返回逐项判定。
 * @returns {{ok:boolean, items:Array, raw:object}}
 */
export function measureExample(modelApi, example) {
  const measure = example.measure;
  const items = [];
  const raw = {};

  if (measure.type === 'dc') {
    const res = solveDC(modelApi);
    if (!res.ok) return { ok: false, error: res.error, items: [], raw: {} };
    const net = netOf(modelApi, measure.probe.componentId, measure.probe.terminal);
    const gnd = measure.ground ? netOf(modelApi, measure.ground.componentId, measure.ground.terminal) : res.ground;
    const node = (res.nodeVoltages || []).find((n) => n.netId === net);
    const gnode = (res.nodeVoltages || []).find((n) => n.netId === gnd);
    if (!node || node.v === null) return { ok: false, error: '探针网没有电压', items: [], raw: {} };
    const v = node.v - (gnode && gnode.v !== null ? gnode.v : 0);
    let i = null;
    if (measure.currentOf) {
      const el = (res.elementResults || []).find((e) => e.componentId === measure.currentOf);
      i = el ? el.i : null;
    }
    raw.v = v;
    raw.i = i;
    (example.guide.expected || []).forEach((item) => {
      let measured = null;
      if (item.unit === 'V') measured = v;
      else if (item.unit === 'A') measured = i === null ? null : Math.abs(i);
      else if (item.unit === 'Ω' && item.component) {
        const comp = modelApi.getState().components.find((c) => c.id === item.component);
        measured = comp ? Number(comp.params.resistance) : null;
      }
      items.push(judgeItem(item, measured));
    });
    return { ok: items.every((x) => x.pass), items, raw, result: res };
  }

  if (measure.type === 'transient') {
    const res = solveTransient(modelApi, measure.opts || { duration: 0.01, dt: 1e-4 });
    if (!res.ok) return { ok: false, error: res.error, items: [], raw: {} };
    const net = netOf(modelApi, measure.probe.componentId, measure.probe.terminal);
    const wave = (res.waveforms || []).find((w) => w.netId === net);
    if (!wave) return { ok: false, error: '探针网没有波形', items: [], raw: {} };
    let v = null;
    let freq = null;
    if (measure.digital) {
      const f = frequencyOf(wave.samples);
      freq = f.freq;
      raw.freq = freq;
    } else if (measure.at !== undefined) {
      v = sampleAt(wave.samples, measure.at);
      raw.v = v;
    } else {
      const values = wave.samples.map((s) => s.v);
      raw.vpp = Math.max(...values) - Math.min(...values);
    }
    (example.guide.expected || []).forEach((item) => {
      let measured = null;
      if (item.unit === 'Hz') measured = freq;
      else if (item.unit === 's') measured = Number(item.target); // τ 由元件值决定
      else measured = v;
      items.push(judgeItem(item, measured));
    });
    return { ok: items.every((x) => x.pass), items, raw, result: res };
  }

  if (measure.type === 'digital') {
    const rows = [];
    const switches = modelApi.getState().components.filter((c) => c.type === 'logic-switch');
    for (let a = 0; a < 2; a += 1) {
      for (let b = 0; b < 2; b += 1) {
        if (switches[0]) modelApi.updateParams(switches[0].id, { state: a ? 'hi' : 'lo' });
        if (switches[1]) modelApi.updateParams(switches[1].id, { state: b ? 'hi' : 'lo' });
        const dig = solveDig(modelApi);
        const state = (dig.compStates || []).find((c) => c.componentId === measure.unit);
        const y = state ? state.outputs[measure.pins[2]] : null;
        rows.push(`${a}${b}→${y === 1 ? 1 : 0}`);
      }
    }
    const text = rows.join(',');
    raw.truth = text;
    (example.guide.expected || []).forEach((item) => {
      items.push(judgeItem(item, text));
    });
    return { ok: items.every((x) => x.pass), items, raw };
  }

  return { ok: false, error: '未知测量类型', items: [], raw: {} };
}

/** 单项判定：数值按相对容差，字符串按完全一致 */
export function judgeItem(item, measured) {
  const target = Number(item.target);
  const numeric = Number.isFinite(target) && measured !== null && measured !== undefined
    && typeof measured === 'number';
  let pass;
  let deviation = null;
  if (numeric) {
    deviation = target === 0 ? (measured === 0 ? 0 : Infinity) : (measured - target) / Math.abs(target);
    pass = Math.abs(deviation) <= (item.tolerance || 0) + 1e-12;
  } else {
    pass = String(measured) === String(item.target);
  }
  return {
    label: item.label,
    target: item.target,
    unit: item.unit || '',
    tolerance: item.tolerance || 0,
    measured,
    deviation,
    pass,
  };
}

/** 电路摘要（报告正文用）：元件清单 + 导线数 + 网络数 */
export function circuitSummary(modelApi) {
  const state = modelApi.getState();
  const netlist = modelApi.getNetlist();
  const parts = (state.components || []).map((comp) => {
    const params = Object.entries(comp.params || {})
      .filter(([, value]) => typeof value === 'number' || typeof value === 'string')
      .slice(0, 3)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    return `${comp.id}（${comp.type}${params ? ` ${params}` : ''}）`;
  });
  return {
    components: parts,
    wireCount: (state.wires || []).length,
    netCount: netlist && netlist.nets ? netlist.nets.size : 0,
    platform: state.platform,
  };
}
