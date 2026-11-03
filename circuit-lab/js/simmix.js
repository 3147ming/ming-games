/**
 * simmix.js — 混合信号边界层（指令包 8）
 *
 * 职责边界：
 *   simdc   纯模拟（直流工作点）
 *   simdig  纯数字（三值稳态）
 *   simtrans 暂态（时域步进）
 *   simmix   **跨域**：模拟电压 ↔ 逻辑电平的换算、边界元件求值、跨域环路分析
 *
 * 为什么单独一层：两套求解器各自只认自己域里的量，边界规则（阈值、驱动、
 * 高阻）要是散落在两个内核里，同一条规则迟早会写出两个版本。这里做成
 * 单点定义，simtrans / simdig / 面板全部引用同一套函数。
 *
 * 边界元件（4 个）：
 *   comparator 比较器  模拟 +/− 输入 → 逻辑输出（可选滞回）
 *   buffer74   数字缓冲  逻辑进、逻辑出（强驱动中继）
 *   dac8       8 位 DAC  8 位逻辑输入 → 模拟电压 Vout = D/255·Vref
 *   adc8       8 位 ADC  模拟输入 → 8 位逻辑输出 D = round(Vin/Vref·255)
 *
 * 数值口径（与指令包 8 一致，改动前请先读这段）：
 *   模拟→数字：v ≥ Vref/2 → hi，v < Vref/2 → lo（比较器用 +/− 差值判定）
 *   数字→模拟：hi → VCC、lo → 0V、z/X → 不驱动（保持上一值）
 */

import { X } from './digmodels.js';
import { getModel } from './devmodels.js';

/** 联合迭代上限（次/步）。收敛电路 1-3 次即稳，超限快速失败而不是假死 */
export const MAX_MIX_ITER = 20;

/** 边界默认供电电压（VCC 未接线时） */
export const MIX_DEFAULT_SUPPLY = 5;

/** DAC/ADC 位数 */
export const MIX_BITS = 8;
export const MIX_FULL_SCALE = (1 << MIX_BITS) - 1; // 255

/** 浮点比较容差 */
const EPS = 1e-12;

/**
 * 边界元件规格。端子角色是**单点定义**：
 * 求解器、环路分析、面板文案都从这里读，不允许各写一份。
 */
export const MIX_SPECS = {
  comparator: {
    id: 'comparator',
    label: '比较器',
    kind: 'comparator',
    analogIn: ['+', '-'],
    digitalOut: ['OUT'],
    vccPin: 'V+',
    gndPin: 'GND',
  },
  buffer74: {
    id: 'buffer74',
    label: '数字缓冲',
    kind: 'buffer',
    digitalIn: ['IN'],
    digitalOut: ['OUT'],
    vccPin: 'VCC',
    gndPin: 'GND',
  },
  dac8: {
    id: 'dac8',
    label: '8 位 DAC',
    kind: 'dac',
    digitalIn: ['D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7'],
    analogOut: ['OUT'],
    vccPin: 'VCC',
    gndPin: 'GND',
  },
  adc8: {
    id: 'adc8',
    label: '8 位 ADC',
    kind: 'adc',
    analogIn: ['IN'],
    digitalOut: ['D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7'],
    vccPin: 'VCC',
    gndPin: 'GND',
  },
};

/** 是否是混合信号边界元件 */
export function isMixType(type) {
  return Object.prototype.hasOwnProperty.call(MIX_SPECS, type);
}

/** 取边界规格，未知返回 null */
export function mixSpec(type) {
  return Object.prototype.hasOwnProperty.call(MIX_SPECS, type) ? MIX_SPECS[type] : null;
}

/** 某端子的域：'analog' | 'digital' | 'power' | null */
export function mixPinDomain(type, pin) {
  const spec = mixSpec(type);
  if (!spec) return null;
  if ((spec.analogIn || []).includes(pin)) return 'analog';
  if ((spec.analogOut || []).includes(pin)) return 'analog';
  if ((spec.digitalIn || []).includes(pin)) return 'digital';
  if ((spec.digitalOut || []).includes(pin)) return 'digital';
  if (pin === spec.vccPin || pin === spec.gndPin) return 'power';
  return null;
}

/* ==========================================================================
   运行态：比较器输出（滞回需要记忆）、DAC/ADC 最近一次结果
   ========================================================================== */

const mixState = new Map(); // compId → { level, bits, vout, supply, diff }

/** 清空边界元件状态（切换实验 / 载入存档 / 断电重上） */
export function resetMixState() {
  mixState.clear();
}

/** 取某边界元件的最近状态（调试、面板、探针用） */
export function mixStateOf(componentId) {
  return mixState.get(componentId) || null;
}

/** 全部边界状态快照（面板显示用） */
export function mixStateSnapshot() {
  return [...mixState.entries()].map(([id, value]) => ({ componentId: id, ...value }));
}

/* ==========================================================================
   收集：从 model 网表挑出边界元件
   ========================================================================== */

/**
 * 收集边界元件并解析其端子网。
 * @param {object} state model.getState()
 * @param {Map} netOf   netlist.netOf
 * @returns {{units:Array, types:string[]}}
 */
export function collectMix(state, netOf) {
  const units = [];
  const types = [];
  if (!state || !Array.isArray(state.components)) return { units, types };
  const map = netOf instanceof Map ? netOf : new Map();
  const pinNet = (comp, pin) => map.get(`c:${comp.id}:${pin}`) || null;

  state.components.forEach((comp) => {
    const spec = mixSpec(comp.type);
    if (!spec) return;
    if (!types.includes(comp.type)) types.push(comp.type);
    const inputs = [];
    (spec.analogIn || []).forEach((pin) => inputs.push({ pin, net: pinNet(comp, pin), analog: true }));
    (spec.digitalIn || []).forEach((pin) => inputs.push({ pin, net: pinNet(comp, pin), analog: false }));
    const outputs = [];
    (spec.digitalOut || []).forEach((pin) => outputs.push({ pin, net: pinNet(comp, pin), analog: false }));
    (spec.analogOut || []).forEach((pin) => outputs.push({ pin, net: pinNet(comp, pin), analog: true }));
    units.push({
      comp,
      spec,
      kind: spec.kind,
      key: `mix:${comp.id}`,
      componentId: comp.id,
      inputs,
      outputs,
      vccNet: pinNet(comp, spec.vccPin),
      gndNet: pinNet(comp, spec.gndPin),
      // 每个输出端一个驱动电压（模拟侧压源值）
      driveV: outputs.map(() => null),
      // 每个输出端的逻辑电平（数字侧）
      outLevel: outputs.map(() => X),
      bits: 0,
    });
  });

  return { units, types };
}

/* ==========================================================================
   求值
   ========================================================================== */

/** 参考电压（Vref）：参数优先，其次 VCC 实测电压，最后默认 5V */
function vrefOf(unit, ctx) {
  const raw = Number(unit.comp.params && unit.comp.params.vref);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return ctx.supplyOf(unit);
}

/** 比较器阈值（V）：参数 threshold 优先，其次 VCC/2 */
export function comparatorThreshold(params, supply) {
  const raw = Number(params && params.threshold);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return (Number(supply) > 0 ? Number(supply) : MIX_DEFAULT_SUPPLY) / 2;
}

/**
 * 求值一个边界元件。
 *
 * ctx 提供三个读取器（由调用方注入，便于在暂态/直流两种上下文复用）：
 *   voltage(net) → 电压（null 表示未知/不在方程里）
 *   level(net)   → 0|1|X（数字驱动优先，其次按电压判）
 *   supplyOf(unit) → 该元件的供电电压（VCC − GND）
 *
 * @returns {{kind, level?, bits?, vout?, diff?, supply}}
 */
export function evalMixUnit(unit, ctx) {
  const { comp, kind } = unit;
  const params = comp.params || {};
  const supply = ctx.supplyOf(unit);
  const prev = mixState.get(comp.id) || {};
  const result = { kind, level: undefined, bits: null, vout: null, supply, diff: null };

  if (kind === 'comparator') {
    const plus = unit.inputs.find((item) => item.pin === '+');
    const minus = unit.inputs.find((item) => item.pin === '-');
    const vp = plus && plus.net ? ctx.voltage(plus.net) : null;
    const vm = minus && minus.net ? ctx.voltage(minus.net) : null;
    const diff = (vp === null ? 0 : vp) - (vm === null ? 0 : vm);
    const hyst = Math.max(0, Number(params.hysteresis) || 0);
    let level;
    if (hyst <= 0) {
      level = diff >= 0 ? 1 : 0;
    } else if (diff >= hyst / 2 - EPS) {
      level = 1;
    } else if (diff <= -hyst / 2 + EPS) {
      level = 0;
    } else {
      // 滞回带内：保持上一状态（这正是施密特触发器能稳定振荡的原因）
      level = prev.level === 1 ? 1 : 0;
    }
    result.level = level;
    result.vout = level === 1 ? supply : 0;
    result.diff = diff;
  } else if (kind === 'adc') {
    const input = unit.inputs.find((item) => item.pin === 'IN');
    const vin = input && input.net ? ctx.voltage(input.net) : null;
    const vref = vrefOf(unit, ctx);
    const ratio = vref > 0 ? (vin === null ? 0 : vin) / vref : 0;
    const clamped = Math.min(1, Math.max(0, ratio));
    const d = Math.round(clamped * MIX_FULL_SCALE);
    result.bits = Math.min(MIX_FULL_SCALE, Math.max(0, d));
    result.vout = null;
  } else if (kind === 'dac') {
    let d = 0;
    let unknown = 0;
    unit.inputs.forEach((item, index) => {
      const level = item.net ? ctx.level(item.net) : X;
      if (level === 1) d |= 1 << index;
      else if (level !== 0) unknown += 1;
    });
    const vref = vrefOf(unit, ctx);
    result.bits = d;
    result.vout = (d / MIX_FULL_SCALE) * vref;
    result.unknownBits = unknown;
  } else if (kind === 'buffer') {
    const input = unit.inputs.find((item) => item.pin === 'IN');
    const level = input && input.net ? ctx.level(input.net) : X;
    result.level = level;
    // z/X → 不驱动（vout=null），模拟侧保持上一值
    result.vout = level === 1 ? supply : level === 0 ? 0 : null;
  }

  const next = { ...prev, ...result, componentId: comp.id, kind };
  mixState.set(comp.id, next);
  return next;
}

/** 8 位整数 → 各输出脚电平（D0 为最低位） */
export function bitsToLevels(bits) {
  const levels = {};
  for (let i = 0; i < MIX_BITS; i += 1) {
    levels[`D${i}`] = (bits >> i) & 1 ? 1 : 0;
  }
  return levels;
}

/** 电平表 → 8 位整数（缺省/X 按 0） */
export function levelsToBits(levels) {
  let d = 0;
  for (let i = 0; i < MIX_BITS; i += 1) {
    if (levels[`D${i}`] === 1) d |= 1 << i;
  }
  return d;
}

/* ==========================================================================
   跨域组合环路检测
   ========================================================================== */

/**
 * 模拟网络的「瞬时依赖边」。
 *
 * 方向约定：边 from → to 表示 to 的瞬时电压可能由 from 决定。
 *   - 二端无源器件（电阻/二极管/开关）：双向
 *   - 独立源：双向（把两端绑死）
 *   - 电容/电感：**不建边**（状态元件，瞬时电压不被当前激励决定）
 *   - 运放：+/− → OUT（输出由输入决定，不反向）
 *   - 三极管：B → C、B → E、C ↔ E
 *
 * 为什么电容要断开：H4 这类弛张振荡器里，比较器输出经 R 给电容充电，
 * 电容节点同时是比较器输入——若把这条通路算成瞬时依赖，任何 RC 振荡器
 * 都会被误判成组合环路。电容把"当前步的输入"与"输出"解耦，正是它能振荡的原因。
 */
function buildAnalogEdges(state, netOf) {
  const edges = new Map(); // net → Set(net)
  const add = (from, to) => {
    if (!from || !to || from === to) return;
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from).add(to);
  };
  if (!state || !Array.isArray(state.components)) return edges;

  state.components.forEach((comp) => {
    const model = getModel(comp.type);
    if (!model || model.skip) return;
    // 状态元件：断开瞬时依赖
    if (comp.type === 'capacitor' || comp.type === 'inductor') return;
    const nets = (comp.terminals || [])
      .map((terminal) => netOf.get(`c:${comp.id}:${terminal.name}`))
      .filter(Boolean);
    if (nets.length < 2) return;

    if (comp.type === 'opamp') {
      // 端子名约定：+ / - / OUT / V+ / V-
      const byName = new Map();
      (comp.terminals || []).forEach((terminal) => {
        const net = netOf.get(`c:${comp.id}:${terminal.name}`);
        if (net) byName.set(terminal.name, net);
      });
      const out = byName.get('OUT');
      const plus = byName.get('+');
      const minus = byName.get('-');
      if (out && plus) add(plus, out);
      if (out && minus) add(minus, out);
      return;
    }

    if (comp.type === 'transistor') {
      const byName = new Map();
      (comp.terminals || []).forEach((terminal) => {
        const net = netOf.get(`c:${comp.id}:${terminal.name}`);
        if (net) byName.set(terminal.name, net);
      });
      const b = byName.get('B');
      const c = byName.get('C');
      const e = byName.get('E');
      if (b && c) add(b, c);
      if (b && e) add(b, e);
      if (c && e) { add(c, e); add(e, c); }
      return;
    }

    // 默认：两端（或多端）互相绑定
    for (let i = 0; i < nets.length; i += 1) {
      for (let j = i + 1; j < nets.length; j += 1) {
        add(nets[i], nets[j]);
        add(nets[j], nets[i]);
      }
    }
  });

  return edges;
}

/** 被电容/电感"钉住"的网：作为输入时不构成瞬时依赖（环路在此断开） */
function buildStateNets(state, netOf) {
  const set = new Set();
  if (!state || !Array.isArray(state.components)) return set;
  state.components.forEach((comp) => {
    if (comp.type !== 'capacitor' && comp.type !== 'inductor') return;
    (comp.terminals || []).forEach((terminal) => {
      const net = netOf.get(`c:${comp.id}:${terminal.name}`);
      if (net) set.add(net);
    });
  });
  return set;
}

/** 从 fromNet 到 toNet 是否存在瞬时路径；toNet 是状态网时一律视为断开 */
function reachable(fromNet, toNet, edges, stateNets, limit = 4000) {
  if (!fromNet || !toNet) return false;
  if (stateNets.has(toNet)) return false;
  if (fromNet === toNet) return true;
  const seen = new Set([fromNet]);
  const queue = [fromNet];
  let guard = 0;
  while (queue.length > 0 && guard < limit) {
    guard += 1;
    const net = queue.shift();
    const next = edges.get(net);
    if (!next) continue;
    for (const item of next) {
      if (stateNets.has(item)) continue; // 状态网不传导瞬时依赖
      if (item === toNet) return true;
      if (seen.has(item)) continue;
      seen.add(item);
      queue.push(item);
    }
  }
  return false;
}

/** 找出从 fromNet 到 toNet 的一条瞬时路径上的元件（用于告警文案） */
function pathComponents(fromNet, toNet, edges, stateNets, netToComps, limit = 4000) {
  if (!fromNet || !toNet) return [];
  if (stateNets.has(toNet)) return [];
  const prev = new Map();
  const seen = new Set([fromNet]);
  const queue = [fromNet];
  let guard = 0;
  while (queue.length > 0 && guard < limit) {
    guard += 1;
    const net = queue.shift();
    if (net === toNet) break;
    const next = edges.get(net);
    if (!next) continue;
    for (const item of next) {
      if (stateNets.has(item)) continue;
      if (seen.has(item)) continue;
      seen.add(item);
      prev.set(item, net);
      queue.push(item);
    }
  }
  const list = [];
  let cursor = toNet;
  while (cursor && prev.has(cursor)) {
    const from = prev.get(cursor);
    const comps = netToComps.get(`${from}→${cursor}`) || [];
    if (comps.length > 0) list.push(comps[0]);
    cursor = from;
  }
  return list;
}

/**
 * 跨域组合环路检测。
 *
 * 图：数字门单元 + 边界元件 = 节点；「输出网经瞬时模拟路径可达另一个单元的输入网」= 有向边。
 * 只要找到的环里含至少一个边界元件，就是跨域环路（纯数字环由包 6 负责报）。
 *
 * @returns {{ok:boolean, cycle:string[], chain:string[], mixInCycle:boolean}}
 */
export function analyzeMixLoops({ state, netOf, mixUnits, digitalUnits }) {
  const units = Array.isArray(mixUnits) ? mixUnits : [];
  if (units.length === 0) return { ok: true, cycle: [], chain: [], mixInCycle: false };
  if (!(netOf instanceof Map)) return { ok: true, cycle: [], chain: [], mixInCycle: false };

  const edges = buildAnalogEdges(state, netOf);
  const stateNets = buildStateNets(state, netOf);

  // net → 元件（用于路径文案）
  const netToComps = new Map();
  (state.components || []).forEach((comp) => {
    (comp.terminals || []).forEach((terminal) => {
      const net = netOf.get(`c:${comp.id}:${terminal.name}`);
      if (!net) return;
      // 记录以该网为端点的元件，键在下面按边补
      if (!netToComps.has(net)) netToComps.set(net, []);
    });
  });
  // 为每条边记录"是哪个元件连的"
  (state.components || []).forEach((comp) => {
    const model = getModel(comp.type);
    if (!model || model.skip) return;
    if (comp.type === 'capacitor' || comp.type === 'inductor') return;
    const nets = (comp.terminals || [])
      .map((terminal) => netOf.get(`c:${comp.id}:${terminal.name}`))
      .filter(Boolean);
    if (nets.length < 2) return;
    for (let i = 0; i < nets.length; i += 1) {
      for (let j = i + 1; j < nets.length; j += 1) {
        const key = `${nets[i]}→${nets[j]}`;
        if (!netToComps.has(key)) netToComps.set(key, []);
        netToComps.get(key).push(comp.id);
        const back = `${nets[j]}→${nets[i]}`;
        if (!netToComps.has(back)) netToComps.set(back, []);
        netToComps.get(back).push(comp.id);
      }
    }
  });

  // 统一节点：{ id, label, componentId, mix, inputs:[net], outputs:[net] }
  const nodes = [];
  const nodeByKey = new Map();
  (digitalUnits || []).forEach((ui) => {
    // 两种形状都接受：求解器内部记录（inputs 是数组）与结果记录（inputs 是 pin→电平）
    const netOfList = (list) => (Array.isArray(list)
      ? list.map((item) => (item && typeof item === 'object' ? item.net : null))
      : Object.keys(list || {}).map((pin) => (
        ui.compId ? (netOf.get(`c:${ui.compId}:${pin}`) || null) : null
      )));
    const node = {
      key: `d:${ui.key || ui.componentId}`,
      label: `${ui.compId || ui.componentId}.${ui.unit && ui.unit.id ? ui.unit.id : (ui.unitId || 'U')}`,
      componentId: ui.compId || ui.componentId,
      mix: false,
      inputs: netOfList(ui.inputs).filter(Boolean),
      outputs: netOfList(ui.outputs).filter(Boolean),
    };
    nodes.push(node);
    nodeByKey.set(node.key, node);
  });
  units.forEach((unit) => {
    const node = {
      key: unit.key,
      label: `${unit.componentId}.${unit.spec.label}`,
      componentId: unit.componentId,
      mix: true,
      inputs: unit.inputs.map((item) => item.net).filter(Boolean),
      outputs: unit.outputs.map((item) => item.net).filter(Boolean),
    };
    nodes.push(node);
    nodeByKey.set(node.key, node);
  });

  const consumers = new Map();
  nodes.forEach((node) => consumers.set(node.key, new Set()));
  nodes.forEach((from) => {
    nodes.forEach((to) => {
      if (from === to) {
        // 自环：输出直接回到自己的输入（比较器输出经电阻回 + 输入）
        const self = from.outputs.some((outNet) => from.inputs.some(
          (inNet) => reachable(outNet, inNet, edges, stateNets),
        ));
        if (self) consumers.get(from.key).add(to.key);
        return;
      }
      const hit = from.outputs.some((outNet) => to.inputs.some(
        (inNet) => reachable(outNet, inNet, edges, stateNets),
      ));
      if (hit) consumers.get(from.key).add(to.key);
    });
  });

  // 找环（三色 DFS）
  const color = new Map();
  const stack = [];
  let found = null;
  const visit = (key) => {
    if (found) return;
    color.set(key, 1);
    stack.push(key);
    const next = consumers.get(key) || new Set();
    for (const item of next) {
      if (found) break;
      const c = color.get(item) || 0;
      if (c === 1) {
        const at = stack.indexOf(item);
        found = stack.slice(at >= 0 ? at : 0).concat(item);
        break;
      }
      if (c === 0) visit(item);
    }
    stack.pop();
    if (!found) color.set(key, 2);
  };
  nodes.forEach((node) => {
    if (!found && (color.get(node.key) || 0) === 0) visit(node.key);
  });

  if (!found) return { ok: true, cycle: [], chain: [], mixInCycle: false };

  const cycleKeys = [...new Set(found)];
  const cycleNodes = cycleKeys.map((key) => nodeByKey.get(key)).filter(Boolean);
  const mixInCycle = cycleNodes.some((node) => node.mix);
  const cycle = [];
  cycleNodes.forEach((node) => {
    if (!cycle.includes(node.label)) cycle.push(node.label);
  });

  // 路径上的无源元件（让报告能列出"环上 4 个元件"）
  const via = [];
  for (let i = 0; i < cycleKeys.length; i += 1) {
    const fromNode = nodeByKey.get(cycleKeys[i]);
    const toNode = nodeByKey.get(cycleKeys[(i + 1) % cycleKeys.length]);
    if (!fromNode || !toNode) continue;
    fromNode.outputs.forEach((outNet) => {
      toNode.inputs.forEach((inNet) => {
        if (!reachable(outNet, inNet, edges, stateNets)) return;
        pathComponents(outNet, inNet, edges, stateNets, netToComps).forEach((id) => {
          if (!via.includes(id) && !cycleNodes.some((node) => node.componentId === id)) via.push(id);
        });
      });
    });
  }

  return {
    ok: !mixInCycle,
    cycle,
    via,
    mixInCycle,
    keys: cycleKeys,
  };
}

/* ==========================================================================
   面板文案
   ========================================================================== */

/** 边界元件的状态短标签（面板用） */
export function mixStateLabel(unit) {
  const state = mixState.get(unit.componentId);
  if (!state) return '—';
  if (unit.kind === 'comparator') {
    if (state.level === 1) return '高';
    if (state.level === 0) return '低';
    return 'X';
  }
  if (unit.kind === 'buffer') {
    if (state.level === 1) return '高';
    if (state.level === 0) return '低';
    return '高阻';
  }
  if (unit.kind === 'dac') return `${state.bits} / 0x${Number(state.bits || 0).toString(16).toUpperCase()}`;
  if (unit.kind === 'adc') return `${state.bits} / 0x${Number(state.bits || 0).toString(16).toUpperCase()}`;
  return '—';
}
