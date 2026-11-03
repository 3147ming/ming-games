/**
 * digmodels.js — 数字元件逻辑模型注册表
 *
 * 与 devmodels.js 的分工：
 *   devmodels  模拟域（电阻/LED/开关/电容/电源），参与 MNA 求解
 *   digmodels  数字域（74 系列 IC），按三值逻辑求值
 * 两类模型按 type 归属互斥，由 tools/test-model.mjs 的覆盖断言锁定。
 *
 * 三值逻辑：0（低）/ 1（高）/ X（未知或不确定，也用于驱动竞争）
 *
 * 为什么用引脚号当端子名：
 *   实验箱上学生看到的是 DIP 封装的脚号，原理图符号里写的也是脚号。
 *   逻辑功能（1A/1B/1Y）是 datasheet 上的第二层信息，放在本文件的 pinMap 里，
 *   这样 parts.js 的 14 个端子对七种芯片通用，不需要为每型芯片重排端子。
 */

/** 未知态 */
export const X = 'X';

/** TTL 输入阈值（74LS 系列 datasheet：Vih ≥ 2.0V，Vil ≤ 0.8V） */
export const TTL = Object.freeze({ vih: 2.0, vil: 0.8 });

/** 传播延迟：74LS 门典型 10ns，触发器 20ns。本包只用于报告，不驱动暂态波形 */
export const TPD_GATE = 10e-9;
export const TPD_FF = 20e-9;

/* ==========================================================================
   三值逻辑
   ========================================================================== */

/** 归一化成 0 / 1 / X（外部可能传布尔或字符串） */
export function norm(value) {
  if (value === 0 || value === '0' || value === false) return 0;
  if (value === 1 || value === '1' || value === true) return 1;
  return X;
}

/** AND：任一输入为 0 就一定是 0；否则有 X 就是 X */
export function logicAnd(values) {
  if (values.some((v) => norm(v) === 0)) return 0;
  if (values.some((v) => norm(v) !== 1)) return X;
  return 1;
}

/** OR：任一输入为 1 就一定是 1；否则有 X 就是 X */
export function logicOr(values) {
  if (values.some((v) => norm(v) === 1)) return 1;
  if (values.some((v) => norm(v) !== 0)) return X;
  return 0;
}

export function logicNot(value) {
  const v = norm(value);
  if (v === 0) return 1;
  if (v === 1) return 0;
  return X;
}

/**
 * XOR：按"未知传播"实现——任一输入 X 即输出 X。
 * 严格三值代数里 X XOR 1 可以化简成 X̅，但那样会让"某个输入没接好"
 * 看起来像"电路正常工作"，这里宁可保守。
 */
export function logicXor(values) {
  if (values.some((v) => norm(v) !== 0 && norm(v) !== 1)) return X;
  let acc = 0;
  values.forEach((v) => {
    acc ^= norm(v);
  });
  return acc;
}

const OPS = {
  and: (values) => logicAnd(values),
  or: (values) => logicOr(values),
  nand: (values) => logicNot(logicAnd(values)),
  nor: (values) => logicNot(logicOr(values)),
  xor: (values) => logicXor(values),
  not: (values) => logicNot(values[0]),
};

/* ==========================================================================
   电平 ↔ 电压
   ========================================================================== */

/** 节点电压 → 逻辑电平（阈值判定；中间区判 X） */
export function levelFromVoltage(voltage, thresholds = TTL) {
  if (voltage === null || voltage === undefined) return X;
  const v = Number(voltage);
  if (!Number.isFinite(v)) return X;
  if (v >= thresholds.vih) return 1;
  if (v <= thresholds.vil) return 0;
  return X;
}

/** 逻辑电平 → 等效电压（数字输出驱动模拟负载时用） */
export function voltageOfLevel(level, supply = 5) {
  if (level === 1) return supply;
  if (level === 0) return 0;
  return supply / 2; // X：取中点，面板上标注"不确定"
}

/** 电平的中文短名 */
export function levelText(level) {
  if (level === 1) return '高';
  if (level === 0) return '低';
  return 'X';
}

/* ==========================================================================
   IC 定义
   ========================================================================== */

/**
 * 七种实验箱常用 74LS 芯片。
 * gates 里的 a/b/y 是**真实 DIP-14 引脚号**：
 *   74LS00/08/32/86 —— 1A=1 1B=2 1Y=3 2A=4 2B=5 2Y=6 GND=7 3Y=8 3A=9 3B=10 4Y=11 4A=12 4B=13 VCC=14
 *   74LS02（或非）—— 1Y=1 1A=2 1B=3 2Y=4 2A=5 2B=6 GND=7 3A=8 3B=9 3Y=10 4A=11 4B=12 4Y=13 VCC=14
 *   74LS04（六反相）—— 1A=1 1Y=2 2A=3 2Y=4 3A=5 3Y=6 GND=7 4Y=8 4A=9 5Y=10 5A=11 6Y=12 6A=13 VCC=14
 */
const GATE_ICS = [
  {
    id: '74LS00',
    label: '74LS00 四 2 输入与非',
    op: 'nand',
    gates: [
      { a: 1, b: 2, y: 3 },
      { a: 4, b: 5, y: 6 },
      { a: 9, b: 10, y: 8 },
      { a: 12, b: 13, y: 11 },
    ],
  },
  {
    id: '74LS02',
    label: '74LS02 四 2 输入或非',
    op: 'nor',
    gates: [
      { a: 2, b: 3, y: 1 },
      { a: 5, b: 6, y: 4 },
      { a: 8, b: 9, y: 10 },
      { a: 11, b: 12, y: 13 },
    ],
  },
  {
    id: '74LS04',
    label: '74LS04 六反相器',
    op: 'not',
    gates: [
      { a: 1, y: 2 },
      { a: 3, y: 4 },
      { a: 5, y: 6 },
      { a: 9, y: 8 },
      { a: 11, y: 10 },
      { a: 13, y: 12 },
    ],
  },
  {
    id: '74LS08',
    label: '74LS08 四 2 输入与',
    op: 'and',
    gates: [
      { a: 1, b: 2, y: 3 },
      { a: 4, b: 5, y: 6 },
      { a: 9, b: 10, y: 8 },
      { a: 12, b: 13, y: 11 },
    ],
  },
  {
    id: '74LS32',
    label: '74LS32 四 2 输入或',
    op: 'or',
    gates: [
      { a: 1, b: 2, y: 3 },
      { a: 4, b: 5, y: 6 },
      { a: 9, b: 10, y: 8 },
      { a: 12, b: 13, y: 11 },
    ],
  },
  {
    id: '74LS86',
    label: '74LS86 四 2 输入异或',
    op: 'xor',
    gates: [
      { a: 1, b: 2, y: 3 },
      { a: 4, b: 5, y: 6 },
      { a: 9, b: 10, y: 8 },
      { a: 12, b: 13, y: 11 },
    ],
  },
];

/** 74LS74 双 D 触发器：真实 DIP-14 引脚（TI datasheet） */
const DFF_PINS = {
  vcc: '14',
  gnd: '7',
  units: [
    { id: 'FF1', label: '1FF', clr: '1', d: '2', clk: '3', pr: '4', q: '5', qb: '6' },
    { id: 'FF2', label: '2FF', clr: '13', d: '12', clk: '11', pr: '10', q: '9', qb: '8' },
  ],
};

/** 引脚功能名（datasheet 上的 1A / 1Y / 1Q̅），用于面板与符号标注 */
const PIN_LABELS = {
  '74LS00': ['1A', '1B', '1Y', '2A', '2B', '2Y', 'GND', '3Y', '3A', '3B', '4Y', '4A', '4B', 'VCC'],
  '74LS02': ['1Y', '1A', '1B', '2Y', '2A', '2B', 'GND', '3A', '3B', '3Y', '4A', '4B', '4Y', 'VCC'],
  '74LS04': ['1A', '1Y', '2A', '2Y', '3A', '3Y', 'GND', '4Y', '4A', '5Y', '5A', '6Y', '6A', 'VCC'],
  '74LS08': ['1A', '1B', '1Y', '2A', '2B', '2Y', 'GND', '3Y', '3A', '3B', '4Y', '4A', '4B', 'VCC'],
  '74LS32': ['1A', '1B', '1Y', '2A', '2B', '2Y', 'GND', '3Y', '3A', '3B', '4Y', '4A', '4B', 'VCC'],
  '74LS86': ['1A', '1B', '1Y', '2A', '2B', '2Y', 'GND', '3Y', '3A', '3B', '4Y', '4A', '4B', 'VCC'],
  '74LS74': ['1CLR', '1D', '1CLK', '1PRE', '1Q', '1Q̅', 'GND', '2Q̅', '2Q', '2PRE', '2CLK', '2D', '2CLR', 'VCC'],
};

/** 旧存档里的型号写法 → 现在的键 */
const LEGACY_TYPES = {
  7400: '74LS00',
  7402: '74LS02',
  7404: '74LS04',
  7408: '74LS08',
  7432: '74LS32',
  7486: '74LS86',
  7474: '74LS74',
  LS00: '74LS00',
  LS02: '74LS02',
  LS04: '74LS04',
  LS08: '74LS08',
  LS32: '74LS32',
  LS86: '74LS86',
  LS74: '74LS74',
};

/**
 * 型号归一化：'7408' / '74ls08' / '74LS08' 都返回 '74LS08'。
 * 包 5 及更早的存档里 params.type 写的是四位短号，必须能继续认出来。
 */
export function normalizeType(type) {
  if (typeof type !== 'string') return '';
  const raw = type.trim().toUpperCase().replace(/[\s-]/g, '');
  if (!raw) return '';
  if (DIG_MODELS[raw]) return raw;
  if (LEGACY_TYPES[raw]) return LEGACY_TYPES[raw];
  // 74HC00 / 74F00 之类的工艺差异对逻辑功能无影响，统一当 LS 处理
  const swapped = raw.replace(/^74[A-Z]{0,2}(?=\d{2}$)/, '74LS');
  if (DIG_MODELS[swapped]) return swapped;
  return raw;
}

/** 门单元：一个门 = 一个求值节点（同一封装内级联不会被误判成环路） */
function buildGateUnits(def) {
  return def.gates.map((gate, index) => {
    const n = index + 1;
    const hasB = gate.b !== undefined;
    const inputs = hasB ? [String(gate.a), String(gate.b)] : [String(gate.a)];
    return {
      id: `U${n}`,
      kind: 'gate',
      label: hasB ? `${n}A/${n}B → ${n}Y` : `${n}A → ${n}Y`,
      inputs,
      outputs: [String(gate.y)],
      fn: (values) => ({
        [String(gate.y)]: OPS[def.op](inputs.map((pin) => values[pin])),
      }),
    };
  });
}

function buildGateModel(def) {
  const units = buildGateUnits(def);
  const labels = PIN_LABELS[def.id] || [];
  const pins = {};
  labels.forEach((name, index) => {
    const pin = String(index + 1);
    let dir = 'in';
    if (name === 'GND' || name === 'VCC') dir = 'power';
    else if (/Y$/.test(name)) dir = 'out';
    pins[pin] = { name, dir };
  });
  return {
    id: def.id,
    label: def.label,
    kind: 'gate',
    op: def.op,
    tpd: TPD_GATE,
    thresholds: TTL,
    pins,
    power: { vcc: '14', gnd: '7' },
    units,
    /** 整包求值（一次算完四个/六个门） */
    fn: (inputs) => {
      const out = {};
      units.forEach((unit) => {
        const local = {};
        unit.inputs.forEach((pin) => {
          local[pin] = inputs[pin];
        });
        Object.assign(out, unit.fn(local));
      });
      return out;
    },
  };
}

/**
 * D 触发器的电平/边沿求值。
 *
 * 优先级（对应 datasheet 的 function table）：
 *   1. PR=0 且 CLR=0 → Q=1、Q̅=1（datasheet 明写这是不稳定状态）
 *   2. CLR=0 → Q=0（异步清零）
 *   3. PR=0  → Q=1（异步置位）
 *   4. 以上都没有时，只认 CLK 的**上升沿**：上升沿采样 D，其余时刻保持
 * 只要 PR/CLR 有一个有效，时钟沿就被完全忽略——这是"异步优先于同步"。
 */
function evalFlipFlop(unit, values, prevState) {
  const prev = prevState && typeof prevState === 'object' ? prevState : { q: 0, clk: 0 };
  const clr = norm(values[unit.clr]);
  const pr = norm(values[unit.pr]);
  const d = norm(values[unit.d]);
  const clk = norm(values[unit.clk]);

  let q = prev.q === 1 || prev.q === 0 ? prev.q : 0;
  let mode = 'hold';
  let invalid = false;
  let edge = false;

  if (clr === 0 && pr === 0) {
    q = 1;
    mode = 'invalid';
    invalid = true;
  } else if (clr === 0) {
    q = 0;
    mode = 'clear';
  } else if (pr === 0) {
    q = 1;
    mode = 'preset';
  } else if (prev.clk === 0 && clk === 1) {
    edge = true;
    if (d === 1) {
      q = 1;
      mode = 'sample';
    } else if (d === 0) {
      q = 0;
      mode = 'sample';
    } else {
      q = X;
      mode = 'sample-x';
    }
  }

  const qLevel = q === 1 || q === 0 ? q : X;
  return {
    // PRE 与 CLR 同时有效时 datasheet 规定两输出都为高（不稳定态），
    // 这时 Q̅ 不再是 Q 的反相——不能无脑取反。
    outputs: { [unit.q]: qLevel, [unit.qb]: invalid ? 1 : logicNot(qLevel) },
    state: { q: qLevel, clk: clk === X ? prev.clk : clk },
    edge,
    mode,
    invalid,
  };
}

function buildDffModel() {
  const labels = PIN_LABELS['74LS74'];
  const pins = {};
  labels.forEach((name, index) => {
    const pin = String(index + 1);
    let dir = 'in';
    if (name === 'GND' || name === 'VCC') dir = 'power';
    else if (/Q̅$/.test(name) || /Q$/.test(name)) dir = 'out';
    pins[pin] = { name, dir };
  });

  const units = DFF_PINS.units.map((unit) => ({
    id: unit.id,
    kind: 'ff',
    label: `${unit.label}（${unit.clr}/CLR · ${unit.d}/D · ${unit.clk}/CLK · ${unit.pr}/PRE → ${unit.q} Q / ${unit.qb} Q̅）`,
    inputs: [unit.clr, unit.d, unit.clk, unit.pr],
    outputs: [unit.q, unit.qb],
    pins: { clr: unit.clr, d: unit.d, clk: unit.clk, pr: unit.pr, q: unit.q, qb: unit.qb },
    fn: (values, state) => evalFlipFlop(unit, values, state),
  }));

  return {
    id: '74LS74',
    label: '74LS74 双 D 触发器',
    kind: 'flipflop',
    tpd: TPD_FF,
    thresholds: TTL,
    pins,
    power: { vcc: '14', gnd: '7' },
    units,
    /** 整包求值：state 按单元 id 分开存，两个触发器互不干扰 */
    fn: (inputs, state) => {
      const out = {};
      const nextState = {};
      units.forEach((unit) => {
        const local = {};
        unit.inputs.forEach((pin) => {
          local[pin] = inputs[pin];
        });
        const evaluated = unit.fn(local, state ? state[unit.id] : undefined);
        Object.assign(out, evaluated.outputs);
        nextState[unit.id] = evaluated.state;
      });
      return { outputs: out, state: nextState };
    },
  };
}

/** 数字元件模型表：键是元件 type（ic74xx 则看 params.type） */
export const DIG_MODELS = {
  '74LS00': buildGateModel(GATE_ICS[0]),
  '74LS02': buildGateModel(GATE_ICS[1]),
  '74LS04': buildGateModel(GATE_ICS[2]),
  '74LS08': buildGateModel(GATE_ICS[3]),
  '74LS32': buildGateModel(GATE_ICS[4]),
  '74LS86': buildGateModel(GATE_ICS[5]),
  '74LS74': buildDffModel(),
};

/** 型号下拉框顺序（与 parts.js 的 paramFields 对齐） */
export const DIG_MODEL_ORDER = ['74LS00', '74LS02', '74LS04', '74LS08', '74LS32', '74LS86', '74LS74'];

/** 数字源元件（不是 IC，但属于数字域） */
export const DIG_SOURCES = {
  'logic-switch': {
    id: 'logic-switch',
    label: '逻辑电平开关',
    kind: 'source',
    out: 'OUT',
    ref: '',
    level: (comp) => (comp.params && comp.params.state === 'hi' ? 1 : 0),
    note: (level) => (level === 1 ? '高电平' : '低电平'),
  },
  pulse: {
    id: 'pulse',
    label: '脉冲源',
    kind: 'source',
    out: '+',
    ref: '-',
    level: null, // 由 simdig 的运行态提供
    note: () => '脉冲',
  },
  clock: {
    id: 'clock',
    label: '时钟源',
    kind: 'source',
    out: '+',
    ref: 'GND',
    level: null,
    note: () => '时钟',
  },
};

/** 全部数字 type（含源） */
export const DIGITAL_TYPES = Object.freeze([
  ...Object.keys(DIG_MODELS),
  ...Object.keys(DIG_SOURCES),
]);

/** 取数字模型：ic74xx 走 params.type，其余按 type 直接命中 */
export function getDigModel(type, params) {
  if (type === 'ic74xx') return DIG_MODELS[normalizeType(params ? params.type : '')] || null;
  if (DIG_MODELS[type]) return DIG_MODELS[type];
  return null;
}

/** 是否数字域元件 */
export function isDigital(type) {
  if (type === 'ic74xx') return true;
  return Object.prototype.hasOwnProperty.call(DIG_SOURCES, type);
}

/** 引脚功能名（用于面板/符号）：'74LS00', '3' → '1Y' */
export function pinLabel(modelId, pin) {
  const labels = PIN_LABELS[modelId];
  const index = Number(pin) - 1;
  if (!labels || index < 0 || index >= labels.length) return String(pin);
  return labels[index];
}
