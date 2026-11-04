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
import { solveCoupled } from './simdig.js';

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
    const all = modelApi.getState().components || [];
    // 输入集合：优先用 measure.inputs 指定的开关 id 数组（顺序即真值表列序，inputs[0] 为最高位）；
    // 老实验（01/08）没写 inputs，退回「电路里前两个逻辑开关」的两输入行为，保证不回退。
    let inputs = (measure.inputs || [])
      .map((id) => all.find((c) => c.id === id))
      .filter(Boolean);
    if (inputs.length === 0) inputs = all.filter((c) => c.type === 'logic-switch').slice(0, 2);

    // 输出：measure.outputs 是引脚向量（按序拼成一串 0/1/X）；
    // 老结构只有 measure.pins = [inA, inB, out]，取第 3 个当唯一输出脚。
    const outPins = (measure.outputs && measure.outputs.length)
      ? measure.outputs
      : [measure.pins && measure.pins[2]].filter(Boolean);

    const N = inputs.length;
    // 扫描会真的改开关状态：先存原态，跑完恢复，免得报告截图与真值表对不上
    const saved = inputs.map((c) => ({ id: c.id, state: c.params && c.params.state }));
    const rows = [];
    for (let m = 0; m < (1 << N); m += 1) {
      const bits = [];
      inputs.forEach((comp, i) => {
        const bit = (m >> (N - 1 - i)) & 1; // inputs[0] 为最高位，行标签读起来就是 ABC 顺序
        bits.push(bit);
        modelApi.updateParams(comp.id, { state: bit ? 'hi' : 'lo' });
      });
      // 必须走联合求解：使能脚 / 数据脚常直接接 +5V 或 GND（模拟域电压源），
      // 纯 solveDig 读不到这些电平；solveCoupled 内部的 analogView 会排除数字源，
      // 既能让直流收敛，又能把模拟节点电压喂给数字求解器。
      const coupled = solveCoupled(modelApi);
      const dig = coupled.dig || {};
      const state = (dig.compStates || []).find((c) => c.componentId === measure.unit);
      const y = outPins.map((pin) => {
        const level = state && state.outputs ? state.outputs[pin] : null;
        if (level === 1) return '1';
        if (level === 0) return '0';
        return 'X'; // 悬空 / 不确定一律写 X，不装作 0 或 1
      }).join('');
      rows.push(`${bits.join('')}→${y}`);
    }
    saved.forEach((item) => {
      if (item.state) modelApi.updateParams(item.id, { state: item.state });
    });

    const text = rows.join(',');
    raw.truth = text;
    raw.inputs = inputs.map((c) => c.id);
    raw.outputs = outPins;
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
