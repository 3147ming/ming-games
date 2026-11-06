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

/** 输出阻抗档：50（Ω）或 'hi'/0（高阻，等效内阻 0Ω） */
export const FGEN_Z_OPTIONS = [
  { value: '50', label: '50Ω' },
  { value: 'hi', label: '高阻' },
];

/**
 * 读 fgen 的输出内阻。
 * 兼容口径：**没有 outputImpedance 字段的旧存档一律回落 0Ω（高阻）**，
 * 否则老电路（尤其 RC 低通）会在打开新版后波形凭空变矮。
 */
export function fgenOutputImpedance(params = {}) {
  const z = params && params.outputImpedance;
  if (z === undefined || z === null || z === 'hi' || z === 0 || z === '0') return 0;
  const n = Number(z);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 负载端等效电阻：只看**直接跨接 fgen OUT 与 GND 两端**的电阻并联值。
 * 串联 RC / 示波器高阻探头都不算负载，所以既有实验的分压不会被误触发。
 * @returns {number} 欧姆；无跨接电阻时 Infinity（高阻负载）
 */
export function fgenLoadResistance(components, netOf, comp, outNet, refNet) {
  if (!outNet || !refNet || !Array.isArray(components) || !netOf) return Infinity;
  const pinNet = (id, pin) => netOf.get(`c:${id}:${pin}`) || null;
  let g = 0;
  components.forEach((c) => {
    if (!c || (c.type !== 'resistor' && c.type !== 'pot')) return;
    const a = pinNet(c.id, '1');
    const b = pinNet(c.id, '2');
    if (!a || !b) return;
    if (!((a === outNet && b === refNet) || (b === outNet && a === refNet))) return;
    const r = Number(c.params && c.params.resistance);
    if (Number.isFinite(r) && r > 0) g += 1 / r;
  });
  return g > 0 ? 1 / g : Infinity;
}

/**
 * 函数发生器在 t 时刻的输出电压。
 * 幅值参数是**峰峰值**（Vpp），偏置是直流分量。
 * 方波占空比 duty（%）只影响方波；三角波按对称三角处理。
 *
 * R4b：opts.loadResistance 给定时按「理想源串联 outputImpedance 内阻」分压，
 * 返回值就是**负载端**电压（示波器测到的值），不改 MNA。
 */
export function fgenVoltageAt(t, params = {}, opts = {}) {
  const wave = FGEN_WAVES[params.wave] ? params.wave : 'sine';
  const f = Number(params.frequency) > 0 ? Number(params.frequency) : 1000;
  const vpp = Number.isFinite(Number(params.amplitude)) ? Number(params.amplitude) : 2;
  const offset = Number.isFinite(Number(params.offset)) ? Number(params.offset) : 0;
  const duty = Math.min(0.9, Math.max(0.1, (Number(params.duty) || 50) / 100));
  let raw = offset;
  if (wave !== 'dc') {
    const amp = vpp / 2;
    const phase = ((t * f) % 1 + 1) % 1;
    if (wave === 'sine') raw = offset + amp * Math.sin(2 * Math.PI * phase);
    else if (wave === 'square') raw = offset + (phase < duty ? amp : -amp);
    else {
      // 三角：0→1 上升，1→2 下降
      const tri = phase < 0.5 ? phase * 4 - 1 : 3 - phase * 4;
      raw = offset + amp * tri;
    }
  }
  const rin = fgenOutputImpedance(params);
  const load = Number(opts.loadResistance);
  if (rin > 0 && Number.isFinite(load) && load > 0) return raw * (load / (load + rin));
  return raw;
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
export function measureResistance(modelApi, netA, netB, opts = {}) {
  if (!netA || !netB) return { ok: false, r: null, v: null, error: '请选择两个测量点' };
  if (netA === netB) return { ok: true, r: 0, v: 0 };
  // 二极管档可按测试电流调整开路电压；默认 10mA×1kΩ=10V，与既有 Ω 档一致
  const voc = Number.isFinite(opts.testCurrent) && opts.testCurrent > 0
    ? opts.testCurrent * OHM_RSERIES : OHM_VOC;

  const src = {
    id: '__dmm_src',
    type: 'vsource',
    x: 0,
    y: 0,
    rotation: 0,
    params: { voltage: voc },
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
 *   mode   'volt'|'acv'|'amp'|'aca'|'ohm'|'diode'|'cont'|'cap'
 *   netId  电压/电阻档的测量点（电阻档还需要 netB）
 *   netB   第二测量点
 *   componentId 电流档的元件
 *   realInput   内阻模式（电压档并 10MΩ、电流档串 1Ω）
 *   waveforms   暂态结果（acv/aca 档的采样来源），由 UI 传入
 * @returns {{ok, mode, value, unit, text, note, error}}
 */
export function dmmRead(modelApi, opts = {}) {
  const mode = opts.mode || 'volt';
  const real = Boolean(opts.realInput);

  // —— 交流档：RMS(去掉直流分量)，采样点不足给「—」不报错 ——
  if (mode === 'acv' || mode === 'aca') {
    const waves = Array.isArray(opts.waveforms) ? opts.waveforms : [];
    const w = waves.find((x) => x.netId === opts.netId);
    const samples = w && Array.isArray(w.samples) ? w.samples : null;
    const vals = samples ? samples.map((s) => Number(s.v)).filter(Number.isFinite) : [];
    if (vals.length < 8) {
      // 没有暂态数据时退回直流工作点，避免仪表一片空白
      const res = solveDC(modelApi);
      if (!res.ok) return fail(mode, res.error || '求解失败');
      if (mode === 'acv') {
        const node = (res.nodeVoltages || []).find((n) => n.netId === opts.netId);
        if (!node || node.v === null) return fail(mode, '探针未接触任何节点');
        return ok(mode, 0, 'V', '0.000V', '无暂态采样：交流分量为 0（当前为直流工作点）');
      }
      const el = (res.elementResults || []).find((e) => e.componentId === opts.componentId);
      if (!el || el.i === null || el.i === undefined) return fail(mode, '探针未串入支路');
      return ok(mode, 0, 'A', '0.000A', '无暂态电流采样：交流分量为 0（当前为直流工作点）');
    }
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const rms = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
    if (mode === 'acv') {
      const text = Math.abs(rms) >= 1 ? `${rms.toFixed(3)}V` : `${(rms * 1000).toFixed(1)}mV`;
      return ok(mode, rms, 'V', text, 'RMS（已扣除直流偏置）· 测量点 = 负载端');
    }
    // 电流档：优先真实电流采样，否则按负载电阻折算电压波形
    const current = Array.isArray(opts.currentSamples) ? opts.currentSamples : null;
    if (current && current.length >= 8) {
      const iv = current.map((s) => Number(s.i)).filter(Number.isFinite);
      const im = iv.reduce((a, b) => a + b, 0) / iv.length;
      const irms = Math.sqrt(iv.reduce((a, b) => a + (b - im) ** 2, 0) / iv.length);
      return ok(mode, irms, 'A', `${(irms * 1000).toFixed(2)}mA`, 'RMS（电流采样）');
    }
    const r = Number(opts.loadResistance);
    if (Number.isFinite(r) && r > 0) {
      const irms = rms / r;
      return ok(mode, irms, 'A', `${(irms * 1000).toFixed(2)}mA`, `按负载 ${r}Ω 折算 · RMS`);
    }
    return fail(mode, '缺少暂态电流采样或负载电阻');
  }

  // —— 通断档：|V_AB| < 0.3V 判「通」 ——
  if (mode === 'cont') {
    if (!opts.netId || !opts.netB) return fail(mode, '请把红黑表笔都放到节点上');
    const th = measureResistance(modelApi, opts.netId, opts.netB);
    if (!th.ok) return fail(mode, th.error);
    const v = Number.isFinite(th.v) ? Math.abs(th.v) : Infinity;
    const connected = v < 0.3 || (Number.isFinite(th.r) && th.r < 30);
    return ok(mode, connected ? 1 : 0, '', connected ? '通 · 蜂鸣' : '断',
      connected ? '两点间低阻（|V|<0.3V 或 R<30Ω）' : `两点间压降 ${v.toFixed(3)}V`);
  }

  // —— 电容档：读测点所在网上的电容参数（教学简化，不做 RC 曲线拟合）——
  if (mode === 'cap') {
    if (!modelApi) return fail(mode, '电路未就绪');
    const comps = (modelApi.getState().components || []);
    const netOf = modelApi.getNetlist().netOf;
    const hit = comps.find((c) => c.type === 'capacitor' && (
      netOf.get(`c:${c.id}:1`) === opts.netId || netOf.get(`c:${c.id}:2`) === opts.netId
      || netOf.get(`c:${c.id}:1`) === opts.netB || netOf.get(`c:${c.id}:2`) === opts.netB
    ));
    if (!hit) return fail(mode, '测点所在网上没有电容');
    const c = Number(hit.params && hit.params.capacitance);
    if (!Number.isFinite(c) || c <= 0) return fail(mode, '电容参数无效');
    const text = c >= 1e-3 ? `${(c * 1e3).toFixed(2)}mF`
      : c >= 1e-6 ? `${(c * 1e6).toFixed(3)}µF`
        : c >= 1e-9 ? `${(c * 1e9).toFixed(1)}nF` : `${(c * 1e12).toFixed(1)}pF`;
    return ok(mode, c, 'F', text, `${hit.id} 标称值（断电读数）`);
  }

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
    // 旧写法把 10mA 当第 4 个位置参数传进只收 3 参的 measureResistance，静默无效。
    // 改成显式 opts：10mA×1kΩ=10V 开路电压，1N4148 正向读数约 0.68~0.70V。
    const th = measureResistance(modelApi, opts.netId, opts.netB, { testCurrent: DMM_TEST_I_DIODE });
    if (!th.ok) return fail(mode, th.error);
    // 10mA 下的压降：导通 → 0.2~1.2V；截止 → 接近满量程
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
  const empty = {
    vpp: null, vmax: null, vmin: null, vavg: null, freq: null, period: null,
    vrms: null, riseTime: null, duty: null,
  };
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

  // 第 2 卷 §1.3：新增的三项统计剔除首尾各 5% 样本，避免窗口边缘效应。
  // 既有 6 项保持原口径不动——run10 的「RC 低通 Vpp≈0.847×2V」断言依赖它，
  // 改口径会让 1289 项回归无谓地红一片。
  const cut = Math.floor(samples.length * 0.05);
  const win = samples.slice(cut, samples.length - cut);
  let vrms = null;
  let riseTime = null;
  let duty = null;
  if (win.length >= 8) {
    // Vrms 尽量取整数个周期：非整周期窗口会让正弦 RMS 偏高（2.7 周期 → 1.817 而非 1.768）
    let rmsWin = win;
    if (period > 0) {
      const t0 = win[0].t;
      const cycles = Math.floor((win[win.length - 1].t - t0) / period);
      if (cycles >= 1) {
        const tEnd = t0 + cycles * period;
        const cyc = win.filter((s) => s.t < tEnd);
        if (cyc.length >= 8) rmsWin = cyc;
      }
    }
    vrms = Math.sqrt(rmsWin.reduce((a, s) => a + s.v * s.v, 0) / rmsWin.length);
    const lo = Math.min(...win.map((s) => s.v));
    const hi = Math.max(...win.map((s) => s.v));
    const vpp = hi - lo;
    const t10 = lo + 0.1 * vpp;
    const t90 = lo + 0.9 * vpp;
    let tLow = null;
    for (let i = 1; i < win.length; i += 1) {
      const a = win[i - 1].v;
      const b = win[i].v;
      if (a < t10 && b >= t90) {
        // 理想方波一次采样就跨过 10%→90%：上升时间受采样率限制，记为 1 个 dt
        riseTime = win[i].t - win[i - 1].t;
        break;
      }
      if (a < t10 && b >= t10) {
        const k = b === a ? 0 : (t10 - a) / (b - a);
        tLow = win[i - 1].t + (win[i].t - win[i - 1].t) * k;
      } else if (tLow !== null && a < t90 && b >= t90) {
        const k = b === a ? 0 : (t90 - a) / (b - a);
        const tHigh = win[i - 1].t + (win[i].t - win[i - 1].t) * k;
        if (tHigh > tLow) riseTime = tHigh - tLow;
        break;
      } else if (tLow !== null && b < t10) {
        // 回落到低电平说明这一段上升沿结束了，不能跨周期把下一次 t90 配上来
        tLow = null;
      }
    }
    // 占空比只对数字/方波有意义：样本几乎全落在高、低两个电平附近
    const band = 0.1 * vpp;
    const rail = win.filter((s) => s.v >= hi - band || s.v <= lo + band).length;
    if (rail / win.length > 0.9) {
      const th = Number.isFinite(opts.threshold) ? opts.threshold : 2.5;
      duty = (win.filter((s) => s.v >= th).length / win.length) * 100;
    }
  }

  return {
    vpp: vmax - vmin,
    vmax,
    vmin,
    vavg,
    freq,
    period,
    vrms,
    riseTime,
    duty,
  };
}

/**
 * 示波器触发点：在 samples 上找第一个满足「边沿 + 电平」的跳变索引。
 * @param {Array<{t:number,v:number}>} samples
 * @param {{edge?:'rising'|'falling',level?:number}} trigger
 * @returns {{index:number,t:number,level:number,edge:string}|null}
 */
export function findTrigger(samples, trigger = {}) {
  const edge = trigger.edge === 'falling' ? 'falling' : 'rising';
  const level = Number.isFinite(Number(trigger.level)) ? Number(trigger.level) : 2.5;
  if (!Array.isArray(samples) || samples.length < 2) return null;
  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1].v;
    const b = samples[i].v;
    const hit = edge === 'rising' ? (a < level && b >= level) : (a > level && b <= level);
    if (hit) return { index: i, t: samples[i].t, level, edge };
  }
  return null;
}

/**
 * 逻辑分析仪状态机提取：以时钟上升沿为采样点，记录各数字通道电平组合。
 * @param {Array<{netId:string,samples:Array<{t:number,v:number}>,type?:string}>} waveforms
 * @param {{clockNetId?:string,channelNetIds?:string[],threshold?:number}} opts
 * @returns {{ok:boolean,states:Array,transitions:Array,sequence:Array,clockNetId:string|null,error:string|null}}
 */
export function extractStateMachine(waveforms, opts = {}) {
  const waves = Array.isArray(waveforms) ? waveforms : [];
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : 2.5;
  const digital = waves.filter((w) => w && (w.type === 'digital'
    || (opts.channelNetIds || []).includes(w.netId)));
  const clock = opts.clockNetId
    ? waves.find((w) => w.netId === opts.clockNetId)
    : digital.find((w) => w.netId && /clk|clock|cp/i.test(w.netId)) || digital[0];
  const channels = (opts.channelNetIds && opts.channelNetIds.length
    ? opts.channelNetIds.map((id) => waves.find((w) => w.netId === id)).filter(Boolean)
    : digital.filter((w) => w !== clock));

  if (!clock || !Array.isArray(clock.samples) || clock.samples.length < 2) {
    return { ok: false, states: [], transitions: [], sequence: [], clockNetId: null, error: '无时钟通道，无法提取状态' };
  }
  const edges = [];
  for (let i = 1; i < clock.samples.length; i += 1) {
    if (clock.samples[i - 1].v < threshold && clock.samples[i].v >= threshold) {
      edges.push(clock.samples[i].t);
    }
  }
  if (edges.length === 0) {
    return { ok: false, states: [], transitions: [], sequence: [], clockNetId: clock.netId, error: '无时钟沿，无法提取状态' };
  }
  const levelAt = (wave, t) => {
    const ss = wave.samples;
    if (!ss || ss.length === 0) return 0;
    let lo = 0;
    let hi = ss.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ss[mid].t < t) lo = mid + 1; else hi = mid;
    }
    const s = ss[Math.max(0, Math.min(ss.length - 1, lo))];
    return s.v >= threshold ? 1 : 0;
  };
  const sequence = edges.map((t, i) => ({
    t,
    step: i,
    bits: channels.map((w) => levelAt(w, t)),
    id: channels.map((w) => levelAt(w, t)).join(''),
  }));
  const stateMap = new Map();
  sequence.forEach((item) => { if (!stateMap.has(item.id)) stateMap.set(item.id, stateMap.size); });
  const states = [...stateMap.entries()].map(([id, index]) => ({ id, index, label: id || '∅' }));
  const transitions = [];
  for (let i = 1; i < sequence.length; i += 1) {
    const from = sequence[i - 1].id;
    const to = sequence[i].id;
    if (from === to) continue;
    const key = `${from}>${to}`;
    const hit = transitions.find((t) => t.key === key);
    if (hit) hit.count += 1;
    else transitions.push({ key, from, to, count: 1, at: sequence[i].t });
  }
  return { ok: true, states, transitions, sequence, clockNetId: clock.netId, error: null };
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
