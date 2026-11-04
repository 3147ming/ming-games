/**
 * simdig.js — 数字仿真引擎
 *
 * 求值模型：稳态评估（不是事件驱动暂态）。
 *   1. 从 model 网表里挑出数字元件（IC + 逻辑开关/脉冲/时钟）
 *   2. 每个「门」是一个求值节点（同封装内级联不会被误判成环路）
 *   3. 输出网 → 输入端子连边，拓扑排序；排不完就是组合环路
 *   4. 按拓扑序逐节点求值，三值逻辑（0/1/X）
 *   5. 输出每个网的电平、每个元件的输出端子电平、告警
 *
 * 时钟/脉冲只在这里维护"当前电平"，边沿由触发器自己比对上一轮电平判定。
 * 暂态波形（传播延迟、毛刺）留给包 7。
 */

import { solveDC } from './simdc.js';
import { getModel as getAnalogModel } from './devmodels.js';
import {
  DIG_MODELS,
  DIG_SOURCES,
  getDigModel,
  isDigital,
  levelFromVoltage,
  voltageOfLevel,
  logicNot,
  X,
} from './digmodels.js';
import {
  collectMix,
  evalMixUnit,
  bitsToLevels,
  resetMixState,
  analyzeMixLoops,
} from './simmix.js';

/** 数字驱动注入到直流求解时用的假元件前缀（面板上要过滤掉） */
export const DRIVE_PREFIX = '__drv';

/** LED 判定为"亮"的电流阈值（0.2mA：暗室里肉眼可见） */
export const LED_ON_CURRENT = 2e-4;

/** 单次求值的元件上限，防止病态电路把页面拖死 */
const MAX_UNITS = 400;

const sourceState = new Map(); // compId → { level: 0|1 }
const ffMemory = new Map(); // `${compId}#${unitId}` → { q, clk }

/** 清空时钟/脉冲电平与触发器记忆（切换实验、载入存档时调用） */
export function resetDigState() {
  sourceState.clear();
  ffMemory.clear();
  // 边界元件的比较器输出/ADC 码值同样是"上电状态"，一起清零
  resetMixState();
  // 结构缓存也一起清：断电重上后再求值等价于新电路
  resetDigPlanCache();
}

/** 读时钟/脉冲的当前电平 */
export function sourceLevel(modelApi, componentId) {
  const state = sourceState.get(componentId);
  if (state) return state.level;
  if (modelApi && typeof modelApi.findComponent === 'function') {
    const comp = modelApi.findComponent(componentId);
    if (comp && comp.type === 'logic-switch') return comp.params.state === 'hi' ? 1 : 0;
  }
  return 0;
}

/** 写时钟/脉冲电平（不触发求值，供测试与 UI 精确控制） */
export function setSourceLevel(componentId, level) {
  sourceState.set(componentId, { level: level === 1 ? 1 : 0 });
}

/** 取触发器的内部状态（调试/测试用） */
export function ffStateOf(componentId, unitId) {
  return ffMemory.get(`${componentId}#${unitId}`) || null;
}

function timeNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function elapsedSince(started) {
  return Number((timeNow() - started).toFixed(3));
}

/** 数字源的当前电平：逻辑开关读参数（跟着存档走），脉冲/时钟读运行态 */
function levelOfSource(comp) {
  if (comp.type === 'logic-switch') {
    return comp.params && comp.params.state === 'hi' ? 1 : 0;
  }
  const stored = sourceState.get(comp.id);
  return stored && stored.level === 1 ? 1 : 0;
}

/* ==========================================================================
   组合环路
   ========================================================================== */

/**
 * 在"排不出拓扑序"的节点集合里找一条具体的环，用于告警文案。
 * 三色 DFS：遇到灰色（在栈上）节点就是回边，栈里那一段就是环。
 */
function findCycle(nodes, consumers) {
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
      if (c === 0 && nodes.has(item)) visit(item);
    }
    stack.pop();
    if (!found) color.set(key, 2);
  };

  nodes.forEach((key) => {
    if (!found && (color.get(key) || 0) === 0) visit(key);
  });
  return found || [];
}

/* ==========================================================================
   求值
   ========================================================================== */

/**
 * 数字稳态求值。
 * @param {object} modelApi  js/model.js 的命名空间（getState / getNetlist / findComponent）
 * @param {object} options
 *   analog       可选的直流结果：数字输入网没有数字驱动时，按节点电压判电平
 *   ttlFloatHigh 悬空 TTL 输入是否读作高（默认 true，符合 74LS 真实行为）
 */
/* ==========================================================================
   结构缓存："收集 + 拓扑"只跟电路结构有关，按电路指纹缓存；
   电平 / 触发器状态每步都会变，绝不缓存（否则时钟与开关会冻住）。
   ========================================================================== */

let digPlanCache = { key: null, plan: null, hits: 0, misses: 0 };

/** 清空结构缓存（换电路、重置数字状态时调用） */
export function resetDigPlanCache() {
  digPlanCache = { key: null, plan: null, hits: 0, misses: 0 };
}

/** 缓存统计（探针 / 性能面板用） */
export function digPlanCacheStats() {
  const plan = digPlanCache.plan;
  return {
    cached: Boolean(plan),
    hits: digPlanCache.hits,
    misses: digPlanCache.misses,
    units: plan && plan.units ? plan.units.length : 0,
  };
}

/**
 * 电路指纹：元件（id/类型/参数）+ 端子→网映射 + TTL 悬空策略。
 * 任一元件参数或任一根导线变化都会改变指纹；O(n) 字符串拼接，远低于重建拓扑。
 */
function circuitSignature(state, netOf, ttlFloatHigh) {
  const parts = [];
  state.components.forEach((comp) => {
    parts.push(`${comp.id}|${comp.type}|${JSON.stringify(comp.params || {})}`);
  });
  const nets = [];
  netOf.forEach((net, key) => { nets.push(`${key}=${net}`); });
  return `${ttlFloatHigh ? 1 : 0}|${state.platform || ''}|${parts.join(';')}|${nets.join(';')}`;
}

/**
 * 建立数字结构：收集单元 / 驱动表 / 拓扑序 / 冲突 / 跨域环路判定。
 * 纯结构、不写任何求值结果，因此可安全缓存。
 */
function buildDigPlan(state, netOf, netOfPin, ttlFloatHigh, warnings) {
  let hasDigital = false;
  let overflow = false;
  let mixCount = 0;
  const conflicts = [];

  /* ---- 第一步：收集数字元件 ---- */
  const drivers = new Map(); // netId → [{ unitKey, compId, pin }]
  const units = []; // 求值节点（门 / 触发器）
  const sources = [];
  const floatingByComp = new Map();

  const addDriver = (net, record) => {
    if (!net) return;
    if (!drivers.has(net)) drivers.set(net, []);
    drivers.get(net).push(record);
  };

  state.components.forEach((comp) => {
    if (!isDigital(comp.type)) return;

    // 两种 DIP 封装（ic74xx = 14 脚 / ic74xx16 = 16 脚）都按 params.type 查模型
    if (comp.type === 'ic74xx' || comp.type === 'ic74xx16' || DIG_MODELS[comp.type]) {
      const model = getDigModel(comp.type, comp.params);
      if (!model) {
        warnings.push(`${comp.id}：型号 ${comp.params ? comp.params.type : '?'} 不在数字模型库里，已跳过`);
        return;
      }
      hasDigital = true;

      model.units.forEach((unit) => {
        const key = `${comp.id}#${unit.id}`;
        const inputs = unit.inputs.map((pin) => ({ pin, net: netOfPin(comp, pin) }));
        const outputs = unit.outputs.map((pin) => ({ pin, net: netOfPin(comp, pin) }));

        if (units.length >= MAX_UNITS) {
          if (!overflow) {
            overflow = true;
            warnings.push(`数字元件超过 ${MAX_UNITS} 个门，只评估前 ${MAX_UNITS} 个`);
          }
          return;
        }

        units.push({ key, comp, model, unit, inputs, outputs, levelIn: {}, levelOut: {} });
        outputs.forEach((out) => {
          addDriver(out.net, { unitKey: key, compId: comp.id, pin: out.pin });
        });

        const floating = inputs.filter((item) => !item.net).map((item) => item.pin);
        if (floating.length > 0) {
          if (!floatingByComp.has(comp.id)) floatingByComp.set(comp.id, []);
          floatingByComp.get(comp.id).push(...floating);
        }
      });
      return;
    }

    const spec = DIG_SOURCES[comp.type];
    if (!spec) return;
    hasDigital = true;
    const level = levelOfSource(comp);
    const outNet = netOfPin(comp, spec.out);
    sources.push({ comp, spec, level, net: outNet });
    addDriver(outNet, { unitKey: null, compId: comp.id, pin: spec.out });
  });

  /* ---- 混合信号边界元件（指令包 8） ---- */
  const mix = collectMix(state, netOf);
  const mixUnits = mix.units;
  if (mixUnits.length > 0) hasDigital = true;
  // 先给出边界元件计数：环路早退时状态行也要知道"这是混合仿真"
  mixCount = mixUnits.length;

  /**
   * 混信源只登记「结构」：网、驱动表、spec。
   * 比较器 / ADC 的输出电平依赖模拟电压，属于运行态；由 solveDig 每步用
   * evalMixUnit 重算，绝不写进结构缓存（否则输出会被冻在第一次求值上）。
   */
  const registerMixSource = (unit, pin, runtime) => {
    const net = netOfPin(unit.comp, pin);
    sources.push({
      comp: unit.comp,
      spec: { id: unit.spec.id, label: unit.spec.label, out: pin },
      level: 0,
      net,
      runtimeUnit: unit,
      runtimePin: pin,
      runtime: runtime || null,
    });
    addDriver(net, { unitKey: null, compId: unit.componentId, pin });
  };

  mixUnits.forEach((unit) => {
    if (unit.kind === 'comparator') {
      const out = unit.outputs.find((item) => item.pin === 'OUT');
      if (out && out.net) registerMixSource(unit, 'OUT', 'comparator');
      return;
    }
    if (unit.kind === 'adc') {
      unit.outputs.forEach((out) => {
        if (out.net) registerMixSource(unit, out.pin, 'adc');
      });
      return;
    }
    if (unit.kind === 'buffer') {
      const input = unit.inputs.find((item) => item.pin === 'IN');
      const output = unit.outputs.find((item) => item.pin === 'OUT');
      const key = `mix:${unit.componentId}`;
      units.push({
        key,
        comp: unit.comp,
        model: { id: 'buffer74', label: '数字缓冲', tpd: 0 },
        unit: {
          id: 'BUF',
          label: '缓冲',
          kind: 'gate',
          inputs: ['IN'],
          outputs: ['OUT'],
          fn: (values) => ({ OUT: values.IN }),
        },
        inputs: [{ pin: 'IN', net: input ? input.net : null }],
        outputs: [{ pin: 'OUT', net: output ? output.net : null }],
        levelIn: {},
        levelOut: {},
      });
      addDriver(output ? output.net : null, { unitKey: key, compId: unit.componentId, pin: 'OUT' });
      return;
    }
    if (unit.kind === 'dac') {
      // DAC 没有数字输出，但它的输入位要进拓扑图（这样"某位悬空/未驱动"能显示出来）
      units.push({
        key: `mix:${unit.componentId}`,
        comp: unit.comp,
        model: { id: 'dac8', label: '8 位 DAC', tpd: 0 },
        unit: {
          id: 'DAC',
          label: 'DAC',
          kind: 'gate',
          inputs: unit.inputs.map((item) => item.pin),
          outputs: [],
          fn: () => ({}),
        },
        inputs: unit.inputs.map((item) => ({ pin: item.pin, net: item.net })),
        outputs: [],
        levelIn: {},
        levelOut: {},
      });
    }
  });

  // 跨域组合环路：结构性错误，先于拓扑排序报出（包 8.2）
  if (mixUnits.length > 0) {
    const loop = analyzeMixLoops({ state, netOf, mixUnits, digitalUnits: units });
    if (!loop.ok) {
      return {
        fatal: {
          error: '检测到跨域组合环路（请检查连线）',
          cycle: loop.cycle,
          detail: `环上元件：${loop.cycle.join(' → ')}`
            + (loop.via.length > 0 ? `（经由 ${loop.via.join('、')}）` : ''),
        },
        mixCount,
        mixTypes: mix.types,
        hasDigital: true,
        warnings: warnings.slice(),
      };
    }
  }

  floatingByComp.forEach((pins, compId) => {
    const unique = [...new Set(pins)].sort((a, b) => Number(a) - Number(b));
    const shown = unique.slice(0, 4).join('、');
    const more = unique.length > 4 ? ` 等 ${unique.length} 个` : '';
    warnings.push(
      `${compId}：输入端子 ${shown}${more}悬空，`
      + (ttlFloatHigh ? 'TTL 悬空读作高电平' : '按未知 X 处理'),
    );
  });

  if (!hasDigital) {
    return { empty: true, hasDigital: false, warnings: warnings.slice() };
  }

  /* ---- 第二步：多驱动检测 ---- */
  drivers.forEach((list, net) => {
    if (list.length > 1) {
      const who = list.map((item) => `${item.compId}.${item.pin}`).join('、');
      conflicts.push(net);
      warnings.push(`驱动竞争：${net} 有 ${list.length} 个数字输出（${who}）`);
    }
  });

  /* ---- 第三步：连边 + 拓扑排序 ---- */
  const unitByKey = new Map(units.map((item) => [item.key, item]));
  const consumers = new Map();
  const indeg = new Map();
  units.forEach((item) => {
    consumers.set(item.key, new Set());
    indeg.set(item.key, 0);
  });

  const selfLoop = [];
  units.forEach((item) => {
    item.inputs.forEach((input) => {
      if (!input.net) return;
      (drivers.get(input.net) || []).forEach((driver) => {
        if (!driver.unitKey) return; // 逻辑开关/时钟不是求值节点
        if (driver.unitKey === item.key) {
          selfLoop.push(item.key);
          return;
        }
        const bucket = consumers.get(driver.unitKey);
        if (bucket && !bucket.has(item.key)) {
          bucket.add(item.key);
          indeg.set(item.key, indeg.get(item.key) + 1);
        }
      });
    });
  });

  const queue = [];
  units.forEach((item) => {
    if (indeg.get(item.key) === 0) queue.push(item.key);
  });
  const order = [];
  let head = 0;
  while (head < queue.length) {
    const key = queue[head];
    head += 1;
    order.push(key);
    consumers.get(key).forEach((next) => {
      indeg.set(next, indeg.get(next) - 1);
      if (indeg.get(next) === 0) queue.push(next);
    });
  }

  const ordered = new Set(order);
  const blocked = units.filter((item) => !ordered.has(item.key)).map((item) => item.key);
  if (blocked.length > 0 || selfLoop.length > 0) {
    const blockedSet = new Set(blocked.concat(selfLoop));
    const path = findCycle(blockedSet, consumers);
    const cycle = (path.length > 0 ? path : blocked).map((key) => {
      const item = unitByKey.get(key);
      return item ? `${item.comp.id}.${item.unit.label}` : key;
    });
    return {
      fatal: {
        error: '检测到组合逻辑环路（请检查连线）',
        cycle,
        detail: cycle.length > 0 ? `环上元件：${cycle.join(' → ')}` : '',
      },
      mixCount,
      mixTypes: mix.types,
      hasDigital: hasDigital || mixCount > 0,
      warnings: warnings.slice(),
    };
  }


  return {
    units,
    sources,
    drivers,
    order,
    unitByKey,
    conflicts,
    hasDigital,
    overflow,
    mixUnits,
    mix,
    mixCount,
    warnings: warnings.slice(),
  };
}

export function solveDig(modelApi, options = {}) {
  const started = timeNow();
  const warnings = [];
  const result = {
    ok: true,
    error: null,
    detail: '',
    warnings,
    digNets: [],
    compStates: [],
    units: [],
    cycle: [],
    conflicts: [],
    netLevels: {},
    hasDigital: false,
    analogInputsUsed: 0,
    mix: { units: [], analogDrives: [] },
    elapsedMs: 0,
  };

  if (!modelApi || typeof modelApi.getState !== 'function' || typeof modelApi.getNetlist !== 'function') {
    result.ok = false;
    result.error = '仿真引擎缺少 model 接口';
    result.elapsedMs = elapsedSince(started);
    return result;
  }

  const state = modelApi.getState();
  if (!state || !Array.isArray(state.components) || state.components.length === 0) {
    result.warnings.push('电路为空，放几个数字元件再仿真');
    result.elapsedMs = elapsedSince(started);
    return result;
  }

  const ttlFloatHigh = options.ttlFloatHigh !== false;
  const netlist = modelApi.getNetlist();
  const netOf = netlist && netlist.netOf ? netlist.netOf : new Map();
  const netOfPin = (comp, pin) => netOf.get(`c:${comp.id}:${pin}`) || null;

  /* ---- 直流结果 → 模拟节点电压（混合电路的数字输入用） ---- */
  const analogVoltages = new Map();
  if (options.analog && Array.isArray(options.analog.nodeVoltages)) {
    options.analog.nodeVoltages.forEach((node) => {
      if (node && node.v !== null && Number.isFinite(node.v)) analogVoltages.set(node.netId, node.v);
    });
  }

  const netLevel = new Map(); // netId → 0|1|X（已求出的驱动电平）
  const levelConflicts = new Set();

  /* ---- 混合信号边界元件求值上下文（运行态：每次求解重建，不进结构缓存） ---- */
  // 供电电压：VCC 脚实测电压 − GND 脚实测电压，缺省 5V
  const mixSupplyOf = (unit) => {
    const read = (net) => (net && analogVoltages.has(net) ? analogVoltages.get(net) : null);
    const vcc = read(unit.vccNet);
    if (vcc === null) return 5;
    const gnd = read(unit.gndNet);
    return Math.max(0.1, vcc - (gnd === null ? 0 : gnd));
  };
  // 拓扑求值前：只能读模拟电压（数字电平还没算出来）
  const mixVoltageCtx = {
    supplyOf: mixSupplyOf,
    voltage: (net) => (net && analogVoltages.has(net) ? analogVoltages.get(net) : null),
    level: (net) => {
      if (!net) return X;
      if (netLevel.has(net)) return netLevel.get(net);
      return analogVoltages.has(net) ? levelFromVoltage(analogVoltages.get(net)) : X;
    },
  };
  // 拓扑求值后：可以读三值电平
  const mixLevelCtx = {
    supplyOf: mixSupplyOf,
    voltage: mixVoltageCtx.voltage,
    level: (net) => {
      if (!net) return X;
      if (netLevel.has(net)) return netLevel.get(net);
      return analogVoltages.has(net) ? levelFromVoltage(analogVoltages.get(net)) : X;
    },
  };

  /* ---- 结构：按电路指纹缓存（收集 + 拓扑；求值绝不缓存） ---- */
  const signature = circuitSignature(state, netOf, ttlFloatHigh);
  let plan;
  if (digPlanCache.key === signature && digPlanCache.plan) {
    plan = digPlanCache.plan;
    digPlanCache.hits += 1;
  } else {
    plan = buildDigPlan(state, netOf, netOfPin, ttlFloatHigh, []);
    digPlanCache = { key: signature, plan, hits: digPlanCache.hits, misses: digPlanCache.misses + 1 };
  }
  plan.warnings.forEach((text2) => warnings.push(text2));
  // hasDigital 必须在早退分支之前落地：组合/跨域环路会提前 return，
  // 面板与状态行靠它区分「仿真出错」和「电路里没有数字元件」。
  result.hasDigital = Boolean(plan.hasDigital || (plan.mixCount || 0) > 0);

  if (plan.empty) {
    result.warnings.push('没有数字元件，数字仿真跳过');
    result.elapsedMs = elapsedSince(started);
    return result;
  }
  if (plan.fatal) {
    result.ok = false;
    result.error = plan.fatal.error;
    result.cycle = plan.fatal.cycle;
    result.detail = plan.fatal.detail;
    if (plan.mixCount > 0) {
      result.mix = { units: plan.mixCount, types: plan.mixTypes, analogDrives: [], detail: [] };
    }
    result.elapsedMs = elapsedSince(started);
    return result;
  }

  const { units, sources, drivers, order, unitByKey, mixUnits, mix } = plan;
  if (mixUnits.length > 0) {
    result.mix = { units: mixUnits.length, types: mix.types, analogDrives: [], detail: [] };
  }
  plan.conflicts.forEach((net) => {
    if (!result.conflicts.includes(net)) result.conflicts.push(net);
  });
  // 复用同一批 unit 对象：清掉上一步留下的求值痕迹
  units.forEach((item) => {
    item.levelIn = {};
    item.levelOut = {};
    item.edge = undefined;
    item.mode = undefined;
    item.invalid = undefined;
  });
  // 源电平是运行态，每步重算：
  //   · 逻辑开关 / 时钟 / 脉冲 → 读运行态或元件参数
  //   · 比较器 / ADC（混信源）  → 用本步模拟电压重新求值，绝不读缓存
  const runtimeEval = new Map();
  sources.forEach((source) => {
    if (!source.runtimeUnit) {
      source.level = levelOfSource(source.comp);
      return;
    }
    let r = runtimeEval.get(source.runtimeUnit);
    if (!r) {
      r = evalMixUnit(source.runtimeUnit, mixVoltageCtx);
      runtimeEval.set(source.runtimeUnit, r);
    }
    if (source.runtime === 'adc') {
      const levels = bitsToLevels(r.bits || 0);
      source.level = levels[source.runtimePin] === 1 ? 1 : 0;
    } else {
      source.level = r.level === 1 ? 1 : 0;
    }
  });


  /* ---- 第四步：按拓扑序求值 ---- */
  // netLevel / levelConflicts 提前到收集阶段声明：边界元件求值要读它们

  const assignNet = (net, level) => {
    if (!net) return;
    if (!netLevel.has(net)) {
      netLevel.set(net, level);
      return;
    }
    const prev = netLevel.get(net);
    if (prev !== level) {
      netLevel.set(net, X);
      levelConflicts.add(net);
    }
  };

  // 逻辑开关/时钟的电平是"已知常量"，先落进网电平表
  sources.forEach((source) => assignNet(source.net, source.level));

  const readInput = (net) => {
    if (!net) return ttlFloatHigh ? 1 : X;
    if (netLevel.has(net)) return netLevel.get(net);
    if (analogVoltages.has(net)) {
      result.analogInputsUsed += 1;
      return levelFromVoltage(analogVoltages.get(net));
    }
    // 有驱动但还没轮到（只可能出现在环里，前面已拦掉）
    if (drivers.has(net)) return X;
    return ttlFloatHigh ? 1 : X;
  };

  order.forEach((key) => {
    const item = unitByKey.get(key);
    const values = {};
    item.inputs.forEach((input) => {
      values[input.pin] = readInput(input.net);
      item.levelIn[input.pin] = values[input.pin];
    });

    if (item.unit.kind === 'ff') {
      const prev = ffMemory.get(key);
      const evaluated = item.unit.fn(values, prev);
      ffMemory.set(key, evaluated.state);
      item.edge = Boolean(evaluated.edge);
      item.mode = evaluated.mode;
      item.invalid = Boolean(evaluated.invalid);
      item.outputs.forEach((output) => {
        // 模型没吐出来的引脚一律按未知处理，绝不让 undefined 流进电平表
        const raw = evaluated.outputs[output.pin];
        const level = raw === undefined || raw === null ? X : raw;
        item.levelOut[output.pin] = level;
        assignNet(output.net, level);
      });
      if (evaluated.invalid) {
        warnings.push(`${item.comp.id}.${item.unit.label}：PRE 与 CLR 同时有效，输出进入不确定状态`);
      }
      return;
    }

    const produced = item.unit.fn(values);
    item.outputs.forEach((output) => {
      const raw = produced[output.pin];
      const level = raw === undefined || raw === null ? X : raw;
      item.levelOut[output.pin] = level;
      assignNet(output.net, level);
    });
    item.edge = false;
    item.mode = 'gate';
  });

  /* ---- 边界元件：求值后回填模拟输出（供 solveCoupled 注入） ---- */
  const mixAnalogDrives = [];
  const mixReport = [];
  mixUnits.forEach((unit) => {
    const r = evalMixUnit(unit, mixLevelCtx);
    const record = {
      componentId: unit.componentId,
      kind: unit.kind,
      label: unit.spec.label,
      level: r.level === undefined ? null : r.level,
      bits: r.bits === null ? null : r.bits,
      vout: r.vout,
      supply: r.supply,
    };
    if (unit.kind === 'comparator') {
      record.diff = r.diff;
      const out = unit.outputs.find((item) => item.pin === 'OUT');
      if (out && out.net) {
        mixAnalogDrives.push({
          componentId: unit.componentId,
          pin: 'OUT',
          netId: out.net,
          voltage: r.vout,
          level: r.level,
        });
      }
    } else if (unit.kind === 'dac') {
      const out = unit.outputs.find((item) => item.pin === 'OUT');
      if (out && out.net) {
        mixAnalogDrives.push({
          componentId: unit.componentId,
          pin: 'OUT',
          netId: out.net,
          voltage: r.vout,
          level: null,
        });
      }
    } else if (unit.kind === 'buffer') {
      const out = unit.outputs.find((item) => item.pin === 'OUT');
      if (out && out.net && r.vout !== null) {
        mixAnalogDrives.push({
          componentId: unit.componentId,
          pin: 'OUT',
          netId: out.net,
          voltage: r.vout,
          level: r.level,
        });
      }
    }
    mixReport.push(record);
  });
  result.mix = {
    units: mixUnits.length,
    types: mix.types,
    analogDrives: mixAnalogDrives,
    detail: mixReport,
  };

  if (levelConflicts.size > 0) {
    levelConflicts.forEach((net) => {
      if (!result.conflicts.includes(net)) result.conflicts.push(net);
    });
  }

  /* ---- 第五步：结构化输出 ---- */
  const netIds = new Set();
  drivers.forEach((_, net) => netIds.add(net));
  units.forEach((item) => item.inputs.forEach((input) => {
    if (input.net) netIds.add(input.net);
  }));

  result.digNets = [...netIds]
    .map((net) => {
      const driven = netLevel.has(net);
      const fromAnalog = !driven && analogVoltages.has(net);
      return {
        netId: net,
        level: driven
          ? netLevel.get(net)
          : (fromAnalog ? levelFromVoltage(analogVoltages.get(net)) : X),
        drivers: (drivers.get(net) || []).length,
        conflict: result.conflicts.includes(net),
        source: driven ? 'digital' : (fromAnalog ? 'analog' : 'none'),
      };
    })
    .sort((a, b) => {
      const na = Number(String(a.netId).replace(/\D/g, ''));
      const nb = Number(String(b.netId).replace(/\D/g, ''));
      return na - nb;
    });

  result.netLevels = {};
  result.digNets.forEach((net) => {
    // 只有数字驱动出来的网才允许回灌到直流求解；模拟阈值判定出来的不算驱动
    if (net.source === 'digital') result.netLevels[net.netId] = net.level;
  });

  const byComp = new Map();
  units.forEach((item) => {
    if (!byComp.has(item.comp.id)) {
      byComp.set(item.comp.id, {
        componentId: item.comp.id,
        type: item.comp.type,
        modelId: item.model.id,
        label: item.model.label,
        tpd: item.model.tpd,
        outputs: {},
        wired: {},
        units: [],
      });
    }
    const record = byComp.get(item.comp.id);
    item.outputs.forEach((output) => {
      // 电平照算不误（门自己知道输出什么），但是否接线要分开记：
      // 面板上"未接"与"低电平"是两件事，画布上也不该给未接的脚挂标签。
      record.outputs[output.pin] = item.levelOut[output.pin] === undefined ? X : item.levelOut[output.pin];
      record.wired[output.pin] = Boolean(output.net);
    });
    record.units.push({
      id: item.unit.id,
      label: item.unit.label,
      inputs: { ...item.levelIn },
      outputs: { ...item.levelOut },
      edge: Boolean(item.edge),
      mode: item.mode || 'gate',
    });
  });

  sources.forEach((source) => {
    const existing = byComp.get(source.comp.id);
    if (existing) {
      // 多输出源（ADC 的 8 个数据脚）合并进同一条元件记录
      existing.outputs[source.spec.out] = source.level;
      existing.wired[source.spec.out] = Boolean(source.net);
      if (existing.units[0]) existing.units[0].outputs[source.spec.out] = source.level;
      return;
    }
    byComp.set(source.comp.id, {
      componentId: source.comp.id,
      type: source.comp.type,
      modelId: source.spec.id,
      label: source.spec.label,
      tpd: 0,
      outputs: { [source.spec.out]: source.level },
      wired: { [source.spec.out]: Boolean(source.net) },
      units: [{
        id: 'SRC',
        label: source.spec.out,
        inputs: {},
        outputs: { [source.spec.out]: source.level },
        edge: false,
        mode: source.comp.type,
      }],
    });
  });

  result.compStates = [...byComp.values()];
  result.units = units.map((item) => ({
    key: item.key,
    componentId: item.comp.id,
    unitId: item.unit.id,
    label: item.unit.label,
    inputs: { ...item.levelIn },
    outputs: { ...item.levelOut },
    edge: Boolean(item.edge),
    mode: item.mode || 'gate',
  }));

  result.elapsedMs = elapsedSince(started);
  return result;
}

/**
 * 只收集数字求值单元（不求解）。
 * 跨域环路分析需要"单元 + 输入/输出网"的原始结构；求解结果里的 units 只有
 * 引脚电平，重建不出网表。这里导出收集逻辑，让 board/simmix 共用同一份。
 */
export function collectDigitalUnits(modelApi) {
  const units = [];
  if (!modelApi || typeof modelApi.getState !== 'function') return units;
  const state = modelApi.getState();
  const netlist = modelApi.getNetlist();
  const netOf = netlist && netlist.netOf ? netlist.netOf : new Map();
  if (!state || !Array.isArray(state.components)) return units;
  state.components.forEach((comp) => {
    if (!isDigital(comp.type)) return;
    const model = getDigModel(comp.type, comp.params);
    if (!model) return;
    model.units.forEach((unit) => {
      units.push({
        key: `${comp.id}#${unit.id}`,
        compId: comp.id,
        comp,
        model,
        unit,
        inputs: unit.inputs.map((pin) => ({ pin, net: netOf.get(`c:${comp.id}:${pin}`) || null })),
        outputs: unit.outputs.map((pin) => ({ pin, net: netOf.get(`c:${comp.id}:${pin}`) || null })),
      });
    });
  });
  return units;
}

/* ==========================================================================
   时钟步进与脉冲触发
   ========================================================================== */

/** 找出电路里的某类数字源 */
function sourcesOfType(modelApi, type) {
  if (!modelApi || typeof modelApi.getState !== 'function') return [];
  const state = modelApi.getState();
  if (!state || !Array.isArray(state.components)) return [];
  return state.components.filter((comp) => comp.type === type);
}

/**
 * 手动时钟步进：一个"步"= 一个完整时钟周期（先拉高求值一次，再拉低求值一次）。
 * 这样每点一次按钮，上升沿触发器正好采样一次——与实验箱上按一下单脉冲键一致。
 */
export function stepClock(modelApi, options = {}) {
  const clocks = sourcesOfType(modelApi, 'clock');
  if (clocks.length === 0) {
    return { ok: false, error: '电路里没有时钟源', dig: null };
  }
  clocks.forEach((comp) => setSourceLevel(comp.id, 1));
  const high = solveDig(modelApi, options);
  clocks.forEach((comp) => setSourceLevel(comp.id, 0));
  const low = solveDig(modelApi, options);
  return {
    ok: low.ok !== false,
    error: low.ok === false ? low.error : null,
    high,
    low,
    dig: low,
    clocks: clocks.map((comp) => comp.id),
  };
}

/**
 * 触发脉冲源。
 *   momentary：拉高求值一次 + 拉低求值一次 = 恰好一个上升沿
 *   toggle   ：翻转并保持
 */
export function triggerPulse(modelApi, componentId, options = {}) {
  const pulses = sourcesOfType(modelApi, 'pulse');
  if (pulses.length === 0) {
    return { ok: false, error: '电路里没有脉冲源', dig: null };
  }
  const comp = componentId
    ? pulses.find((item) => item.id === componentId)
    : pulses[0];
  if (!comp) return { ok: false, error: '脉冲源不存在', dig: null };

  const mode = comp.params && comp.params.mode === 'toggle' ? 'toggle' : 'momentary';
  const before = levelOfSource(comp);

  if (mode === 'toggle') {
    setSourceLevel(comp.id, before === 1 ? 0 : 1);
    const dig = solveDig(modelApi, options);
    return { ok: dig.ok !== false, error: dig.ok === false ? dig.error : null, dig, mode, level: levelOfSource(comp) };
  }

  setSourceLevel(comp.id, 1);
  const high = solveDig(modelApi, options);
  setSourceLevel(comp.id, 0);
  const low = solveDig(modelApi, options);
  return {
    ok: low.ok !== false,
    error: low.ok === false ? low.error : null,
    high,
    low,
    dig: low,
    mode,
    level: 0,
  };
}

/* ==========================================================================
   与直流内核的耦合
   ========================================================================== */

/** 数字电平 → 驱动电压，面板上要能看到"哪个网由谁驱动" */
export function coupleSim(analogResult, digResult, options = {}) {
  const supply = Number(options.supply) > 0 ? Number(options.supply) : 5;
  const drives = [];
  const levels = digResult && digResult.netLevels ? digResult.netLevels : {};
  Object.keys(levels).forEach((netId) => {
    const level = levels[netId];
    drives.push({ netId, level, voltage: voltageOfLevel(level, supply) });
  });

  const analogInputs = [];
  if (analogResult && Array.isArray(analogResult.nodeVoltages)) {
    analogResult.nodeVoltages.forEach((node) => {
      if (!node || node.v === null || !Number.isFinite(node.v)) return;
      analogInputs.push({ netId: node.netId, v: node.v, level: levelFromVoltage(node.v) });
    });
  }

  return {
    supply,
    drives,
    analogInputs,
    conflicts: (digResult && digResult.conflicts) || [],
    levelsByNet: levels,
  };
}

/**
 * 只含模拟元件的 model 门面。
 *
 * 为什么需要：数字源（逻辑开关 / 脉冲 / 时钟）在 devmodels 里没有电学模型，
 * 而 simdc 遇到"缺电学模型"会直接报错终止——于是一个带逻辑开关的电路
 * 连直流工作点都算不出来。在 simdig 这一层把它们从元件表里摘掉即可，
 * simdc 完全不需要知道数字域的存在。
 *
 * 网表沿用原样：多出来的数字端子只是没人查询的键，不影响任何网 id。
 */
function analogView(modelApi) {
  const state = modelApi.getState();
  const components = state.components.filter((comp) => !isDigital(comp.type));
  return {
    getState: () => ({ ...state, components }),
    getNetlist: () => modelApi.getNetlist(),
  };
}

/** 电路里"有模拟负载"的网集合：只有这些网值得把数字电平注入成电压源 */
function analogNetsOf(modelApi) {
  const nets = new Set();
  const state = modelApi.getState();
  const netlist = modelApi.getNetlist();
  const netOf = netlist && netlist.netOf ? netlist.netOf : new Map();
  if (!state || !Array.isArray(state.components)) return nets;
  state.components.forEach((comp) => {
    const model = getAnalogModel(comp.type);
    if (!model || model.skip) return; // 数字元件与"有意跳过"的元件不构成模拟负载
    comp.terminals.forEach((terminal) => {
      const net = netOf.get(`c:${comp.id}:${terminal.name}`);
      if (net) nets.add(net);
    });
  });
  return nets;
}

/** 参考地：优先复用直流结果，其次取端子最多的网（与 simdc 的策略一致） */
function pickDriveGround(modelApi, analogResult) {
  if (analogResult && analogResult.ground) return analogResult.ground;
  const netlist = modelApi.getNetlist();
  const nets = netlist && netlist.nets ? netlist.nets : new Map();
  let best = null;
  let size = -1;
  nets.forEach((members, netId) => {
    if (members.length > size) {
      size = members.length;
      best = netId;
    }
  });
  return best;
}

/**
 * 把数字驱动包成一次"带隐含电压源"的直流求解。
 *
 * 做法：给 model 套一层只读门面，在元件表末尾追加若干 __drvN 电压源
 * （+ 接被驱动的网，− 接参考地），并把它们的端子网登记进 netOf。
 * 这样 simdc 完全不需要知道数字域的存在——数字域也不去改 simdc 的代码。
 */
function withDrives(modelApi, drives, groundNet) {
  const state = modelApi.getState();
  const netlist = modelApi.getNetlist();
  const netOf = new Map(netlist.netOf);

  const extra = drives.map((drive, index) => {
    const id = `${DRIVE_PREFIX}${index + 1}`;
    netOf.set(`c:${id}:+`, drive.netId);
    netOf.set(`c:${id}:-`, groundNet);
    return {
      id,
      type: 'vsource',
      x: 0,
      y: 0,
      rotation: 0,
      params: { voltage: drive.voltage },
      terminals: [
        { name: '+', direction: 'out', role: '', net: drive.netId },
        { name: '-', direction: 'out', role: '', net: groundNet },
      ],
    };
  });

  return {
    getState: () => ({ ...state, components: state.components.concat(extra) }),
    getNetlist: () => ({ netOf, nets: netlist.nets }),
    driveIds: extra.map((item) => item.id),
  };
}

/** 去掉注入用的假元件痕迹，面板上只留真实元件 */
function cleanDriveRows(result, ids) {
  if (!result || !Array.isArray(ids) || ids.length === 0) return result;
  const set = new Set(ids);
  if (Array.isArray(result.elementResults)) {
    result.elementResults = result.elementResults.filter((item) => !set.has(item.componentId));
  }
  if (Array.isArray(result.warnings)) {
    result.warnings = result.warnings.filter((text) => !ids.some((id) => String(text).includes(id)));
  }
  if (Array.isArray(result.errors)) {
    result.errors = result.errors.filter((text) => !ids.some((id) => String(text).includes(id)));
  }
  return result;
}

/** LED 亮灭：电流到 0.2mA 才算亮，避免"反向漏电 1e-14A 也算点亮" */
export function ledStatesOf(analogResult) {
  const list = [];
  if (!analogResult || !Array.isArray(analogResult.elementResults)) return list;
  analogResult.elementResults.forEach((item) => {
    if (item.type !== 'led') return;
    const i = Number(item.i);
    const v = Number(item.v);
    list.push({
      componentId: item.componentId,
      on: Number.isFinite(i) && i >= LED_ON_CURRENT,
      v: Number.isFinite(v) ? v : null,
      i: Number.isFinite(i) ? i : null,
    });
  });
  return list;
}

/**
 * 一次算完「直流 + 数字 + 耦合」。
 *
 * 顺序：
 *   1. 先按真实电源跑一次直流（此时数字输出还不存在）
 *   2. 数字求值；数字输入可以从第 1 步的节点电压按阈值判定
 *   3. 把数字输出的电平当作理想电压源，注入到"有模拟负载"的网上重解一次直流
 *   4. LED 亮灭从最终直流结果里取电流判定
 *
 * 为什么要第 3 步：门输出接 LED 时，LED 那一支在纯模拟视角里是"未接地网段"，
 * 不注入电压就没有电流。注入后 LED 支路电流才和实验箱一致（mA 级）。
 */
export function solveCoupled(modelApi, options = {}) {
  const analogBase = solveDC(analogView(modelApi), options.dc);
  const dig = solveDig(modelApi, { analog: analogBase, ...(options.dig || {}) });
  const coupling = coupleSim(analogBase, dig, options);

  const analogNets = analogNetsOf(modelApi);
  // 边界元件的模拟输出（比较器 OUT / DAC OUT / 缓冲 OUT）与数字电平同为"驱动源"
  const mixDrives = (dig.mix && Array.isArray(dig.mix.analogDrives) ? dig.mix.analogDrives : [])
    .filter((drive) => drive.voltage !== null && drive.voltage !== undefined)
    .map((drive) => ({ netId: drive.netId, voltage: Number(drive.voltage), level: drive.level }));
  const activeDrives = coupling.drives
    .filter((drive) => analogNets.has(drive.netId))
    .concat(mixDrives.filter((drive) => analogNets.has(drive.netId)));

  let analog = analogBase;
  let drove = false;

  if (activeDrives.length > 0) {
    const ground = pickDriveGround(modelApi, analogBase);
    if (ground) {
      const adapter = withDrives(analogView(modelApi), activeDrives, ground);
      const driven = solveDC(adapter, options.dc);
      cleanDriveRows(driven, adapter.driveIds);
      driven.digitalDriven = activeDrives.map((drive) => ({
        netId: drive.netId,
        level: drive.level,
        voltage: drive.voltage,
      }));
      analog = driven;
      drove = true;
    }
  }

  return {
    analog,
    analogBase,
    dig,
    coupling,
    activeDrives,
    drove,
    leds: ledStatesOf(analog),
  };
}

/** 导出给面板用：把三值电平变成短标签 */
export function levelBadge(level) {
  if (level === 1) return 'H';
  if (level === 0) return 'L';
  if (level === null) return '—';
  return 'X';
}

export { logicNot, X, levelFromVoltage, voltageOfLevel };
