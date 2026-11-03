/**
 * instruments-core.js — 测量仪器的"可复算内核"（指令包 10）
 *
 * 与 instruments.js 的分工：
 *   本文件  纯函数：读数计算、戴维南电阻、示波器自动测量、UART 解码。
 *           不碰 DOM，可在 node 里直接单测（tools/test-model.mjs 就是这么用的）。
 *   instruments.js  DOM 面板：把这里的返回值画成表盘/波形/读数。
 *
 * 为什么单独拆一层：仪器读数必须能和仿真真值逐位对拍。如果读数逻辑长在
 * UI 事件里，就只能靠"眼睛看着差不多"验收——这正是包 10 明确禁止的。
 */

import { solveDC } from './simdc.js';
import { levelFromVoltage } from './digmodels.js';

/** 万用表内阻（内阻模式） */
export const DMM_RIN_V = 1e7;   // 电压档 10MΩ
export const DMM_RIN_A = 1;     // 电流档 1Ω

/** 电阻档的测试电流（A） */
export const DMM_TEST_I = 1e-3;
/**
 * 二极管档的测试电流（A）。
 * 用 10mA 而不是 1mA：1N4148 的 0.7V 标称点就在 10mA（1mA 处实测 0.61V），
 * 与指令包「二极管档 0.7V±5%」的验收口径一致。
 */
export const DMM_TEST_I_DIODE = 10e-3;

/** 函数发生器波形表 */
export const FGEN_WAVES = {
  sine: '正弦',
  square: '方波',
  triangle: '三角波',
  dc: '直流',
};

/**
 * 函数发生器在 t 时刻的输出电压。
 * 幅值参数是**峰峰值**（Vpp），偏置是直流分量。
 * 方波占空比 duty（%）只影响方波；三角波按对称三角处理。
 */
export function fgenVoltageAt(t, params = {}) {
  const wave = FGEN_WAVES[params.wave] ? params.wave : 'sine';
  const f = Number(params.frequency) > 0 ? Number(params.frequency) : 1000;
  const vpp = Number.isFinite(Number(params.amplitude)) ? Number(params.amplitude) : 2;
  const offset = Number.isFinite(Number(params.offset)) ? Number(params.offset) : 0;
  const duty = Math.min(0.9, Math.max(0.1, (Number(params.duty) || 50) / 100));
  if (wave === 'dc') return offset;
  const amp = vpp / 2;
  const phase = ((t * f) % 1 + 1) % 1;
  if (wave === 'sine') return offset + amp * Math.sin(2 * Math.PI * phase);
  if (wave === 'square') return offset + (phase < duty ? amp : -amp);
  // 三角：0→1 上升，1→2 下降
  const tri = phase < 0.5 ? phase * 4 - 1 : 3 - phase * 4;
  return offset + amp * tri;
}

/** 把独立源"归零"的只读门面（电阻档/戴维南测量用） */
function zeroedView(modelApi, extraComponents = []) {
  const state = modelApi.getState();
  const netlist = modelApi.getNetlist();
  const netOf = new Map(netlist.netOf);

  // "断电测量"按教学口径实现为**移除**独立源（电池拔掉），而不是把电压源短接成 0V：
  // 后者测任何带电源的回路都是 0Ω，学生看到的读数没有意义。
  const components = state.components.filter(
    (comp) => comp.type !== 'vsource' && comp.type !== 'isource' && comp.type !== 'fgen',
  ).concat(extraComponents);

  extraComponents.forEach((comp) => {
    comp.terminals.forEach((terminal) => {
      netOf.set(`c:${comp.id}:${terminal.name}`, terminal.net);
    });
  });

  return {
    getState: () => ({ ...state, components }),
    getNetlist: () => ({ netOf, nets: netlist.nets }),
  };
}

/** 欧姆表的戴维南参数：开路电压 10V + 串联 1kΩ（最大 10mA，覆盖二极管档） */
export const OHM_VOC = 10.0;
export const OHM_RSERIES = 1000;

/** 内部节点名（不会和真实网表冲突） */
const OHM_MID = '__dmm_mid';

/**
 * 两点间的等效电阻。
 *
 * 拓扑：Voc(1V) 串 Rs(1k) 接到测点 A，参考端接 B。
 *   I = (V_mid − V_A)/Rs，R = (V_A − V_B)/I
 * 为什么不用"恒流源直接灌"：孤立节点（单只二极管）首个迭代点会飞到 −1e6 V，
 * 限幅器无状态下牛顿在两极之间震荡。串联电阻把方程拉回良态，读数再按分压反解。
 *
 * @returns {{ok:boolean, r:number|null, v:number|null, error?:string}}
 */
export function measureResistance(modelApi, netA, netB) {
  if (!netA || !netB) return { ok: false, r: null, v: null, error: '请选择两个测量点' };
  if (netA === netB) return { ok: true, r: 0, v: 0 };

  const src = {
    id: '__dmm_src',
    type: 'vsource',
    x: 0,
    y: 0,
    rotation: 0,
    params: { voltage: OHM_VOC },
    terminals: [
      { name: '+', direction: 'out', role: '', net: OHM_MID },
      { name: '-', direction: 'out', role: '', net: netB },
    ],
  };
  const series = {
    id: '__dmm_rs',
    type: 'resistor',
    x: 0,
    y: 0,
    rotation: 0,
    params: { resistance: OHM_RSERIES },
    terminals: [
      { name: '1', direction: 'bidir', role: '', net: OHM_MID },
      { name: '2', direction: 'bidir', role: '', net: netA },
    ],
  };

  const view = zeroedView(modelApi, [src, series]);
  const res = solveDC(view);
  if (!res.ok) return { ok: false, r: null, v: null, error: res.error };
  const find = (net) => (res.nodeVoltages || []).find((n) => n.netId === net);
  const vm = find(OHM_MID);
  const va = find(netA);
  const vb = find(netB);
  if (!vm || !va || !vb || vm.v === null || va.v === null || vb.v === null) {
    return { ok: false, r: null, v: null, error: '测量点未接入电路' };
  }
  const v = va.v - vb.v;
  const current = (vm.v - va.v) / OHM_RSERIES;
  if (!Number.isFinite(current) || Math.abs(current) < 1e-9) {
    return { ok: true, r: Infinity, v, ground: res.ground, overflow: true };
  }
  return { ok: true, r: v / current, v, current, ground: res.ground };
}

/**
 * 万用表读数。
 *
 * @param {object} modelApi
 * @param {object} opts
 *   mode   'volt' | 'amp' | 'ohm' | 'diode'
 *   netId  电压/电阻档的测量点（电阻档还需要 netB）
 *   netB   第二测量点
 *   componentId 电流档的元件
 *   realInput   内阻模式（电压档并 10MΩ、电流档串 1Ω）
 * @returns {{ok, mode, value, unit, text, note, error}}
 */
export function dmmRead(modelApi, opts = {}) {
  const mode = opts.mode || 'volt';
  const real = Boolean(opts.realInput);

  if (mode === 'volt') {
    const res = solveDC(modelApi);
    if (!res.ok) return fail(mode, res.error || '求解失败');
    const node = (res.nodeVoltages || []).find((n) => n.netId === opts.netId);
    if (!node || node.v === null) return fail(mode, '该测量点没有定义电压');
    let v = node.v;
    let note = '';
    if (real) {
      // 内阻影响：把测量点对地看成一个戴维南源，读数 = V·Rin/(Rin+Rth)
      const th = measureResistance(modelApi, opts.netId, res.ground);
      if (th.ok && Number.isFinite(th.r)) {
        const loaded = v * (DMM_RIN_V / (DMM_RIN_V + Math.max(0, th.r)));
        const delta = v === 0 ? 0 : (loaded - v) / v;
        note = `内阻 ${(DMM_RIN_V / 1e6).toFixed(0)}MΩ 影响 ${(delta * 100).toFixed(4)}%`;
        v = loaded;
      }
    }
    return ok(mode, v, 'V', `${v.toFixed(3)}V`, note);
  }

  if (mode === 'amp') {
    const res = solveDC(modelApi);
    if (!res.ok) return fail(mode, res.error || '求解失败');
    const el = (res.elementResults || []).find((e) => e.componentId === opts.componentId);
    if (!el) return fail(mode, '该元件没有电流读数');
    if (el.i === null || el.i === undefined) return fail(mode, '该元件电流不可测（理想源/开路）');
    let i = el.i;
    let note = '';
    if (real && el.v) {
      // 串 1Ω 的近似影响：ΔI/I ≈ R/(V/I) —— 只做标注，不改求解
      const rBranch = Math.abs(el.v / el.i);
      note = `内阻 ${DMM_RIN_A}Ω 影响 ${((DMM_RIN_A / (rBranch + DMM_RIN_A)) * 100).toFixed(2)}%`;
      i *= rBranch / (rBranch + DMM_RIN_A);
    }
    const text = Math.abs(i) >= 1 ? `${i.toFixed(3)}A` : `${(i * 1000).toFixed(2)}mA`;
    return ok(mode, i, 'A', text, note);
  }

  if (mode === 'ohm') {
    const th = measureResistance(modelApi, opts.netId, opts.netB);
    if (!th.ok) return fail(mode, th.error);
    const r = th.r;
    if (!Number.isFinite(r)) return ok(mode, r, 'Ω', 'OL 超量程', '超出电阻档量程');
    const text = Math.abs(r) >= 1e6 ? `${(r / 1e6).toFixed(3)}MΩ`
      : Math.abs(r) >= 1e3 ? `${(r / 1e3).toFixed(3)}kΩ` : `${r.toFixed(2)}Ω`;
    return ok(mode, r, 'Ω', text, '电路已按断电处理（独立源归零）');
  }

  if (mode === 'diode') {
    const th = measureResistance(modelApi, opts.netId, opts.netB, DMM_TEST_I_DIODE);
    if (!th.ok) return fail(mode, th.error);
    // 1mA 下的压降：导通 → 0.2~1.2V；截止 → 接近满量程
    const v = th.v;
    const on = v > 0.15 && v < 1.5;
    const text = on ? `${v.toFixed(3)}V 导通` : 'OL 截止';
    return {
      ok: true, mode, value: v, unit: 'V', text,
      note: on ? '正向导通' : '反向截止（过载）',
    };
  }

  return fail(mode, '未知档位');
}

function ok(mode, value, unit, text, note) {
  return { ok: true, mode, value, unit, text, note: note || '', error: null };
}

function fail(mode, error) {
  return { ok: false, mode, value: null, unit: '', text: '—', note: '', error };
}

/* ==========================================================================
   示波器自动测量
   ========================================================================== */

/**
 * 波形自动测量：Vpp / Vmax / Vmin / Vavg / 频率 / 周期。
 * 频率用"均值穿越"计数（对正弦/方波/三角波都成立），至少 2 个周期才给值。
 *
 * @param {Array<{t:number,v:number}>} samples
 * @param {object} opts { coupling: 'dc'|'ac' }
 */
export function scopeMeasure(samples, opts = {}) {
  const empty = { vpp: null, vmax: null, vmin: null, vavg: null, freq: null, period: null };
  if (!Array.isArray(samples) || samples.length < 4) return empty;

  let vmax = -Infinity;
  let vmin = Infinity;
  let sum = 0;
  samples.forEach((s) => {
    if (s.v > vmax) vmax = s.v;
    if (s.v < vmin) vmin = s.v;
    sum += s.v;
  });
  const vavg = sum / samples.length;
  const ref = opts.coupling === 'ac' ? vavg : 0;

  // 均值穿越：上升沿穿过参考电平的次数
  const crossings = [];
  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1].v - ref;
    const b = samples[i].v - ref;
    if (a <= 0 && b > 0) {
      const k = b === a ? 0 : -a / (b - a);
      crossings.push(samples[i - 1].t + (samples[i].t - samples[i - 1].t) * k);
    }
  }
  let period = null;
  let freq = null;
  if (crossings.length >= 2) {
    const span = crossings[crossings.length - 1] - crossings[0];
    period = span / (crossings.length - 1);
    freq = period > 0 ? 1 / period : null;
  }

  return {
    vpp: vmax - vmin,
    vmax,
    vmin,
    vavg,
    freq,
    period,
  };
}

/**
 * 逻辑分析仪：从数字波形解 UART（8N1）。
 * 采样必须明显快于波特率（≥4×），否则返回 null。
 *
 * @param {Array<{t:number,v:number}>} samples 0/1 电平
 * @param {number} baud
 * @param {number} threshold 判高电平的电压阈值
 */
export function decodeUart(samples, baud = 9600, threshold = 2.5) {
  if (!Array.isArray(samples) || samples.length < 20 || !(baud > 0)) return { ok: false, bytes: [], error: '采样不足' };
  const dt = samples[1].t - samples[0].t;
  const bit = 1 / baud;
  if (dt > bit / 4) return { ok: false, bytes: [], error: `采样率不足（需 ≤${(bit / 4 * 1e6).toFixed(0)}µs）` };

  const bits = samples.map((s) => (s.v >= threshold ? 1 : 0));
  const at = (t) => {
    const i = Math.round((t - samples[0].t) / dt);
    if (i < 0 || i >= bits.length) return 1;
    return bits[i];
  };

  const bytes = [];
  for (let i = 1; i < bits.length; i += 1) {
    // 空闲高 → 下降沿 = 起始位
    if (bits[i - 1] === 1 && bits[i] === 0) {
      const t0 = samples[i].t;
      // 起始位中点应为 0
      if (at(t0 + bit * 0.5) !== 0) continue;
      let value = 0;
      let valid = true;
      for (let b = 0; b < 8; b += 1) {
        const level = at(t0 + bit * (1.5 + b));
        value |= level << b;
      }
      // 停止位
      if (at(t0 + bit * 9.5) !== 1) valid = false;
      if (valid) {
        bytes.push({ t: t0, value, text: String.fromCharCode(value) });
        i = Math.round((t0 + bit * 10 - samples[0].t) / dt);
      }
    }
  }
  return { ok: true, bytes, error: null };
}

/**
 * I2C 基础解码：对 SCL/SDA 两条数字线找起始条件 + 每 9 个时钟取 8 位。
 * 只做"能看懂字节"，不做地址/寄存器语义。
 */
export function decodeI2c(sclSamples, sdaSamples) {
  if (!Array.isArray(sclSamples) || !Array.isArray(sdaSamples)) return { ok: false, bytes: [], error: '缺少通道' };
  const n = Math.min(sclSamples.length, sdaSamples.length);
  if (n < 40) return { ok: false, bytes: [], error: '采样不足' };
  const scl = sclSamples.map((s) => (s.v >= 2.5 ? 1 : 0));
  const sda = sdaSamples.map((s) => (s.v >= 2.5 ? 1 : 0));
  const bytes = [];
  let i = 1;
  while (i < n - 9) {
    // 起始：SCL 高时 SDA 下降
    if (scl[i] === 1 && sda[i - 1] === 1 && sda[i] === 0) {
      let value = 0;
      let bitCount = 0;
      let j = i + 1;
      while (j < n && bitCount < 8) {
        if (scl[j] === 1 && scl[j - 1] === 0) {
          value = (value << 1) | sda[j];
          bitCount += 1;
        }
        j += 1;
      }
      if (bitCount === 8) bytes.push({ t: sclSamples[i].t, value });
      i = j;
      continue;
    }
    i += 1;
  }
  return { ok: bytes.length > 0, bytes, error: bytes.length > 0 ? null : '未找到起始条件' };
}

/** 3.5 位显示：把数值格式化成固定 4 位有效数字（1000 → 1.000k） */
export function formatReading(value, unit) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (unit === 'Ω') {
    if (abs >= 1e6) return `${(value / 1e6).toFixed(3)}MΩ`;
    if (abs >= 1e3) return `${(value / 1e3).toFixed(3)}kΩ`;
    return `${value.toFixed(2)}Ω`;
  }
  if (unit === 'A') return abs >= 1 ? `${value.toFixed(3)}A` : `${(value * 1000).toFixed(2)}mA`;
  return `${value.toFixed(3)}${unit}`;
}
