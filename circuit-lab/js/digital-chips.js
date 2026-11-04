/**
 * digital-chips.js — 数字实验箱 MSI 芯片扩展（指令包 16 · 任务 A）
 *
 * 补齐数字电路课程常用、但基础 digmodels.js 缺失的 8 颗组合/时序芯片：
 *   74LS138 译码器 / 74LS148 优先编码器 / 74LS151 数据选择器 / 74LS283 全加器
 *   74LS85 比较器 / 74LS112 双 JK / 74LS160 十进制计数器 / 74LS194 移位寄存器
 *
 * 全部是 **DIP-16** 封装，实物与符号由 parts.js 的 `ic74xx16` 提供。
 *
 * 分层与依赖：
 *   - 本文件只依赖 `digprims.js`（三值逻辑 + TTL 常量），不 import digmodels，
 *     因此 digmodels → digital-chips → digprims 是单向链，没有 ESM 循环。
 *   - digits 模型只描述逻辑行为，不碰 parts / render / solver。
 *
 * 模型契约（与 digmodels.js 完全一致，simdig 只认这两种）：
 *   组合：unit.kind !== 'ff'，unit.fn(values) → { 引脚号: 0|1|X }
 *   时序：unit.kind === 'ff'，unit.fn(values, prevState) → { outputs, state, edge, mode, invalid }
 *   values 的键是**真实引脚号字符串**；state 按 unit.id 分开存，prevState 只传上一轮 state。
 */

import { X, TTL, TPD_GATE, TPD_FF, norm, logicNot } from './digprims.js';

/* ==========================================================================
   辅助：从 16 位引脚名数组构建 pins 表
   ========================================================================== */

/** labels 是 16 元数组，下标 i 对应引脚 i+1。GND/VCC 判 power，outPins 里的判 out，其余 in。 */
function buildPins(labels, outPins) {
  const pins = {};
  labels.forEach((name, index) => {
    const pin = String(index + 1);
    let dir = 'in';
    if (name === 'GND' || name === 'VCC') dir = 'power';
    else if (outPins.includes(pin)) dir = 'out';
    pins[pin] = { name, dir };
  });
  return pins;
}

/* ==========================================================================
   74LS138 3-8 线译码器（输出低有效）
   ========================================================================== */

const LS138_LABELS = [
  'A', 'B', 'C', 'G2A', 'G2B', 'G1', 'Y7', 'GND',
  'Y6', 'Y5', 'Y4', 'Y3', 'Y2', 'Y1', 'Y0', 'VCC',
];
// 选中序号 0..7 → 对应输出引脚（低有效）
const LS138_YPIN = ['15', '14', '13', '12', '11', '10', '9', '7'];

function buildLs138() {
  const inputs = ['1', '2', '3', '4', '5', '6'];
  const outputs = ['7', '9', '10', '11', '12', '13', '14', '15'];
  const fn = (v) => {
    const a = norm(v['1']);
    const b = norm(v['2']);
    const c = norm(v['3']);
    const g2a = norm(v['4']);
    const g2b = norm(v['5']);
    const g1 = norm(v['6']);
    const out = { '7': 1, '9': 1, '10': 1, '11': 1, '12': 1, '13': 1, '14': 1, '15': 1 };

    if (g1 === 1 && g2a === 0 && g2b === 0) {
      if (a === X || b === X || c === X) {
        outputs.forEach((p) => { out[p] = X; });
      } else {
        const sel = c * 4 + b * 2 + a; // C 为最高位
        out[LS138_YPIN[sel]] = 0;
      }
    }
    // 未使能（G1=0 或 G2A/G2B=1）时 datasheet 明确"全部输出高"；
    // 只有使能脚本身悬空 X 才保守输出 X。
    if (g1 === X || g2a === X || g2b === X) {
      outputs.forEach((p) => { out[p] = X; });
    }
    return out;
  };
  return {
    id: '74LS138',
    label: '74LS138 3-8 线译码器',
    kind: 'gate',
    tpd: TPD_GATE,
    thresholds: TTL,
    pins: buildPins(LS138_LABELS, outputs),
    power: { vcc: '16', gnd: '8' },
    units: [{ id: 'U1', kind: 'gate', label: 'A/B/C + 使能 → Y0..Y7', inputs, outputs, fn }],
    fn,
  };
}

/* ==========================================================================
   74LS148 8-3 线优先编码器（输入/输出低有效）
   ========================================================================== */

const LS148_LABELS = [
  'IN3', 'IN2', 'IN1', 'IN0', 'EI', 'A0', 'A1', 'GND',
  'A2', 'IN7', 'IN6', 'IN5', 'IN4', 'GS', 'EO', 'VCC',
];
// 输入引脚 IN0..IN7
const LS148_IN = ['4', '3', '2', '1', '13', '12', '11', '10'];

function buildLs148() {
  const inputs = ['1', '2', '3', '4', '5', '10', '11', '12', '13'];
  const outputs = ['6', '7', '9', '14', '15'];
  const fn = (v) => {
    const ei = norm(v['5']);
    const out = { '6': X, '7': X, '9': X, '14': X, '15': X };
    if (ei === 1) {
      out['6'] = 1; out['7'] = 1; out['9'] = 1; out['14'] = 1; out['15'] = 1;
      return out;
    }
    if (ei === X) return out;

    // ei === 0：找最高优先级的有效输入（低有效，IN7 最高）
    let hit = -1;
    let hasX = false;
    for (let j = 7; j >= 0; j -= 1) {
      const lv = norm(v[LS148_IN[j]]);
      if (lv === 0) { hit = j; break; }
      if (lv === X) hasX = true;
    }
    if (hit === -1) {
      if (hasX) return out; // 有悬空，保守全 X
      out['6'] = 1; out['7'] = 1; out['9'] = 1; // A = 111
      out['14'] = 1; out['15'] = 0;             // GS=1, EO=0
      return out;
    }
    const code = 7 - hit; // A2A1A0（以电平表示，L=0 / H=1）
    out['6'] = code & 1;
    out['7'] = (code >> 1) & 1;
    out['9'] = (code >> 2) & 1;
    out['14'] = 0; // GS 低有效
    out['15'] = 1; // EO
    return out;
  };
  return {
    id: '74LS148',
    label: '74LS148 8-3 线优先编码器',
    kind: 'gate',
    tpd: TPD_GATE,
    thresholds: TTL,
    pins: buildPins(LS148_LABELS, outputs),
    power: { vcc: '16', gnd: '8' },
    units: [{ id: 'U1', kind: 'gate', label: 'IN0..IN7 + EI → A0/A1/A2/GS/EO', inputs, outputs, fn }],
    fn,
  };
}

/* ==========================================================================
   74LS151 8 选 1 数据选择器（G 低有效，Y/W 互补）
   ========================================================================== */

const LS151_LABELS = [
  'D3', 'D2', 'D1', 'D0', 'Y', 'W', 'G', 'GND',
  'C', 'B', 'A', 'D7', 'D6', 'D5', 'D4', 'VCC',
];
const LS151_D = ['4', '3', '2', '1', '15', '14', '13', '12']; // D0..D7

function buildLs151() {
  const inputs = ['1', '2', '3', '4', '7', '9', '10', '11', '12', '13', '14', '15'];
  const outputs = ['5', '6'];
  const fn = (v) => {
    const g = norm(v['7']);
    if (g === 1) return { '5': 0, '6': 1 };
    if (g === X) return { '5': X, '6': X };
    const a = norm(v['11']);
    const b = norm(v['10']);
    const c = norm(v['9']);
    if (a === X || b === X || c === X) return { '5': X, '6': X };
    const sel = c * 4 + b * 2 + a;
    const d = norm(v[LS151_D[sel]]);
    return { '5': d, '6': logicNot(d) };
  };
  return {
    id: '74LS151',
    label: '74LS151 8 选 1 数据选择器',
    kind: 'gate',
    tpd: TPD_GATE,
    thresholds: TTL,
    pins: buildPins(LS151_LABELS, outputs),
    power: { vcc: '16', gnd: '8' },
    units: [{ id: 'U1', kind: 'gate', label: 'A/B/C + G → Y / W', inputs, outputs, fn }],
    fn,
  };
}

/* ==========================================================================
   74LS283 四位二进制全加器（先行进位）
   ========================================================================== */

const LS283_LABELS = [
  'S2', 'B2', 'A2', 'S1', 'A1', 'B1', 'C0', 'GND',
  'C4', 'S4', 'B4', 'A4', 'S3', 'A3', 'B3', 'VCC',
];
// 位 0..3：{aPin, bPin, sPin}
const LS283_BITS = [
  { a: '5', b: '6', s: '4' },
  { a: '3', b: '2', s: '1' },
  { a: '14', b: '15', s: '13' },
  { a: '12', b: '11', s: '10' },
];

function buildLs283() {
  const inputs = ['2', '3', '5', '6', '7', '11', '12', '14', '15'];
  const outputs = ['1', '4', '9', '10', '13'];
  const fn = (v) => {
    const out = {};
    let carry = norm(v['7']);
    for (let i = 0; i < 4; i += 1) {
      const bit = LS283_BITS[i];
      const a = norm(v[bit.a]);
      const b = norm(v[bit.b]);
      if (a === X || b === X || carry === X) {
        out[bit.s] = X;
        carry = X;
      } else {
        out[bit.s] = a ^ b ^ carry;
        carry = (a & b) | (a & carry) | (b & carry);
      }
    }
    out['9'] = carry; // C4
    return out;
  };
  return {
    id: '74LS283',
    label: '74LS283 四位全加器',
    kind: 'gate',
    tpd: TPD_GATE,
    thresholds: TTL,
    pins: buildPins(LS283_LABELS, outputs),
    power: { vcc: '16', gnd: '8' },
    units: [{ id: 'U1', kind: 'gate', label: 'A0..A3 + B0..B3 + C0 → S0..S3 / C4', inputs, outputs, fn }],
    fn,
  };
}

/* ==========================================================================
   74LS85 四位数值比较器（级联输入 IA<B / IA=B / IA>B）
   ========================================================================== */

const LS85_LABELS = [
  'B3', 'IA<B', 'IA=B', 'IA>B', 'OA>B', 'OA=B', 'OA<B', 'GND',
  'B0', 'A0', 'B1', 'A1', 'A2', 'B2', 'A3', 'VCC',
];
const LS85_A = ['10', '12', '13', '15']; // A0..A3
const LS85_B = ['9', '11', '14', '1'];   // B0..B3

function buildLs85() {
  const inputs = ['1', '2', '3', '4', '9', '10', '11', '12', '13', '14', '15'];
  const outputs = ['5', '6', '7'];
  const fn = (v) => {
    for (let i = 3; i >= 0; i -= 1) {
      const a = norm(v[LS85_A[i]]);
      const b = norm(v[LS85_B[i]]);
      if (a === X || b === X) return { '5': X, '6': X, '7': X };
      if (a > b) return { '5': 1, '6': 0, '7': 0 };
      if (a < b) return { '5': 0, '6': 0, '7': 1 };
    }
    // 四位全等 → 级联输入决定
    return { '5': norm(v['4']), '6': norm(v['3']), '7': norm(v['2']) };
  };
  return {
    id: '74LS85',
    label: '74LS85 四位数值比较器',
    kind: 'gate',
    tpd: TPD_GATE,
    thresholds: TTL,
    pins: buildPins(LS85_LABELS, outputs),
    power: { vcc: '16', gnd: '8' },
    units: [{ id: 'U1', kind: 'gate', label: 'A0..A3 / B0..B3 → OA>B / OA=B / OA<B', inputs, outputs, fn }],
    fn,
  };
}

/* ==========================================================================
   74LS112 双 JK 触发器（下降沿触发，异步置位/清零）
   ========================================================================== */

const LS112_LABELS = [
  '1CLK', '1K', '1J', '1PR', '1Q', '1Q̅', '2Q̅', 'GND',
  '2Q', '2PR', '2J', '2K', '2CLK', '2CLR', '1CLR', 'VCC',
];

const LS112_UNITS = [
  { id: 'FF1', label: '1FF', clk: '1', k: '2', j: '3', pr: '4', q: '5', qb: '6', clr: '15' },
  { id: 'FF2', label: '2FF', clk: '13', k: '12', j: '11', pr: '10', q: '9', qb: '7', clr: '14' },
];

function evalJk112(unit, v, prevState) {
  const prev = prevState && typeof prevState === 'object' ? prevState : { q: 0, clk: 0 };
  const clr = norm(v[unit.clr]);
  const pr = norm(v[unit.pr]);
  const j = norm(v[unit.j]);
  const k = norm(v[unit.k]);
  const clk = norm(v[unit.clk]);

  let q = prev.q === 1 || prev.q === 0 ? prev.q : 0;
  let mode = 'hold';
  let invalid = false;
  let edge = false;

  if (clr === 0 && pr === 0) {
    q = 1; mode = 'invalid'; invalid = true;
  } else if (clr === 0) {
    q = 0; mode = 'clear';
  } else if (pr === 0) {
    q = 1; mode = 'preset';
  } else if (prev.clk === 1 && clk === 0) { // 下降沿
    edge = true;
    if (j === 1 && k === 1) { q = q === 0 ? 1 : 0; mode = 'toggle'; }
    else if (j === 1 && k === 0) { q = 1; mode = 'set'; }
    else if (j === 0 && k === 1) { q = 0; mode = 'reset'; }
    else if (j === 0 && k === 0) { mode = 'hold'; }
    else { q = X; mode = 'sample-x'; }
  }

  const qLevel = q === 1 || q === 0 ? q : X;
  return {
    // PR 与 CLR 同时有效时两输出都为高（不稳定态），Q̅ 不能无脑取反
    outputs: { [unit.q]: qLevel, [unit.qb]: invalid ? 1 : logicNot(qLevel) },
    state: { q: qLevel, clk: clk === X ? prev.clk : clk },
    edge, mode, invalid,
  };
}

function buildLs112() {
  const outputs = ['5', '6', '7', '9'];
  const units = LS112_UNITS.map((unit) => ({
    id: unit.id,
    kind: 'ff',
    label: `${unit.label}（${unit.j}/J · ${unit.k}/K · ${unit.clk}/CLK↓ · ${unit.pr}/PR · ${unit.clr}/CLR → ${unit.q} Q / ${unit.qb} Q̅）`,
    inputs: [unit.clk, unit.k, unit.j, unit.pr, unit.clr],
    outputs: [unit.q, unit.qb],
    fn: (values, state) => evalJk112(unit, values, state),
  }));
  return {
    id: '74LS112',
    label: '74LS112 双 JK 触发器',
    kind: 'flipflop',
    tpd: TPD_FF,
    thresholds: TTL,
    pins: buildPins(LS112_LABELS, outputs),
    power: { vcc: '16', gnd: '8' },
    units,
    fn: (inputs, state) => {
      const out = {};
      const nextState = {};
      units.forEach((unit) => {
        const evaluated = unit.fn(inputs, state ? state[unit.id] : undefined);
        Object.assign(out, evaluated.outputs);
        nextState[unit.id] = evaluated.state;
      });
      return { outputs: out, state: nextState };
    },
  };
}

/* ==========================================================================
   74LS160 十进制同步计数器（同步清零/置数，RCO 进位输出）
   ========================================================================== */

const LS160_LABELS = [
  'CLR', 'CLK', 'A', 'B', 'C', 'D', 'ENP', 'GND',
  'LOAD', 'ENT', 'QD', 'QC', 'QB', 'QA', 'RCO', 'VCC',
];

function buildLs160() {
  const inputs = ['1', '2', '3', '4', '5', '6', '7', '9', '10'];
  const outputs = ['11', '12', '13', '14', '15'];
  const unit = {
    id: 'U1',
    kind: 'ff',
    label: 'CLR/LOAD/ENP/ENT + CLK↑ → QA..QD / RCO',
    inputs,
    outputs,
    fn: (v, prevState) => {
      const prev = prevState && typeof prevState === 'object' ? prevState : { count: 0, clk: 0 };
      const clr = norm(v['1']);
      const load = norm(v['9']);
      const enp = norm(v['7']);
      const ent = norm(v['10']);
      const clk = norm(v['2']);

      let count = prev.count === X ? 0 : prev.count;
      let edge = false;
      let mode = 'hold';

      if (prev.clk === 0 && clk === 1) { // 上升沿
        edge = true;
        if (clr === 0) { count = 0; mode = 'clear'; }
        else if (load === 0) {
          const a = norm(v['3']); const b = norm(v['4']);
          const c = norm(v['5']); const d = norm(v['6']);
          count = (a === X || b === X || c === X || d === X) ? X
            : a + b * 2 + c * 4 + d * 8;
          mode = 'load';
        } else if (enp === 1 && ent === 1) {
          count = (count >= 9 || count === X) ? 0 : count + 1;
          mode = 'count';
        }
      }

      const q = count === X
        ? { '14': X, '13': X, '12': X, '11': X }
        : {
          '14': count & 1,
          '13': (count >> 1) & 1,
          '12': (count >> 2) & 1,
          '11': (count >> 3) & 1,
        };
      const rco = (ent === 1 && count === 9) ? 1 : (count === X ? X : 0);
      return {
        outputs: { ...q, '15': rco },
        state: { count, clk: clk === X ? prev.clk : clk },
        edge, mode,
      };
    },
  };
  return {
    id: '74LS160',
    label: '74LS160 十进制计数器',
    kind: 'counter',
    tpd: TPD_FF,
    thresholds: TTL,
    pins: buildPins(LS160_LABELS, outputs),
    power: { vcc: '16', gnd: '8' },
    units: [unit],
    fn: (inputs, state) => {
      const e = unit.fn(inputs, state ? state[unit.id] : undefined);
      return { outputs: e.outputs, state: { [unit.id]: e.state } };
    },
  };
}

/* ==========================================================================
   74LS194 四位双向移位寄存器（异步清零，S1S0 模式选择）
   ========================================================================== */

const LS194_LABELS = [
  'CLR', 'DSR', 'D0', 'D1', 'D2', 'D3', 'DSL', 'GND',
  'S0', 'S1', 'CLK', 'Q3', 'Q2', 'Q1', 'Q0', 'VCC',
];

function buildLs194() {
  const inputs = ['1', '2', '3', '4', '5', '6', '7', '9', '10', '11'];
  const outputs = ['12', '13', '14', '15'];
  const unit = {
    id: 'U1',
    kind: 'ff',
    label: 'S1S0 + DSR/DSL/D0..D3 + CLK↑ → Q0..Q3',
    inputs,
    outputs,
    fn: (v, prevState) => {
      const prev = prevState && typeof prevState === 'object' ? prevState : { bits: [0, 0, 0, 0], clk: 0 };
      const clr = norm(v['1']);
      const s0 = norm(v['9']);
      const s1 = norm(v['10']);
      const dsr = norm(v['2']);
      const dsl = norm(v['7']);
      const clk = norm(v['11']);

      let bits = prev.bits.slice();
      let edge = false;
      let mode = 'hold';

      if (clr === 0) { bits = [0, 0, 0, 0]; mode = 'clear'; }
      else if (prev.clk === 0 && clk === 1) {
        edge = true;
        if (s0 === X || s1 === X) { bits = [X, X, X, X]; mode = 'mode-x'; }
        else {
          const m = s1 * 2 + s0;
          if (m === 3) { // 并行置数 D0..D3 → Q0..Q3
            bits = [norm(v['3']), norm(v['4']), norm(v['5']), norm(v['6'])];
            mode = 'load';
          } else if (m === 1) { // 右移：Q3←Q2←Q1←Q0←DSR
            bits = [dsr, bits[0], bits[1], bits[2]];
            mode = 'shift-right';
          } else if (m === 2) { // 左移：Q0←Q1←Q2←Q3←DSL
            bits = [bits[1], bits[2], bits[3], dsl];
            mode = 'shift-left';
          }
        }
      }

      const out = {
        '15': bits[0], // Q0
        '14': bits[1], // Q1
        '13': bits[2], // Q2
        '12': bits[3], // Q3
      };
      return {
        outputs: out,
        state: { bits, clk: clk === X ? prev.clk : clk },
        edge, mode,
      };
    },
  };
  return {
    id: '74LS194',
    label: '74LS194 移位寄存器',
    kind: 'shiftreg',
    tpd: TPD_FF,
    thresholds: TTL,
    pins: buildPins(LS194_LABELS, outputs),
    power: { vcc: '16', gnd: '8' },
    units: [unit],
    fn: (inputs, state) => {
      const e = unit.fn(inputs, state ? state[unit.id] : undefined);
      return { outputs: e.outputs, state: { [unit.id]: e.state } };
    },
  };
}

/* ==========================================================================
   导出（digmodels.js 在末尾合并进 DIG_MODELS / PIN_LABELS / LEGACY_TYPES / ORDER）
   ========================================================================== */

export const NEW_DIG_MODELS = {
  '74LS138': buildLs138(),
  '74LS148': buildLs148(),
  '74LS151': buildLs151(),
  '74LS283': buildLs283(),
  '74LS85': buildLs85(),
  '74LS112': buildLs112(),
  '74LS160': buildLs160(),
  '74LS194': buildLs194(),
};

export const NEW_PIN_LABELS = {
  '74LS138': LS138_LABELS,
  '74LS148': LS148_LABELS,
  '74LS151': LS151_LABELS,
  '74LS283': LS283_LABELS,
  '74LS85': LS85_LABELS,
  '74LS112': LS112_LABELS,
  '74LS160': LS160_LABELS,
  '74LS194': LS194_LABELS,
};

export const NEW_LEGACY_TYPES = {
  74138: '74LS138',
  74148: '74LS148',
  74151: '74LS151',
  74283: '74LS283',
  7485: '74LS85',
  74112: '74LS112',
  74160: '74LS160',
  74194: '74LS194',
};

export const NEW_ORDER = ['74LS138', '74LS148', '74LS151', '74LS283', '74LS85', '74LS112', '74LS160', '74LS194'];
