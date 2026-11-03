/**
 * simtrans.js — 时域瞬态仿真引擎（Transient / Time-Domain）
 *
 * 解决包 5/6 覆盖不到的三类实验：RC 充放电曲线、时钟/脉冲的真实电压波形、
 * 门传播延迟。核心是「状态变量随步进演化 + 事件驱动跳变时间戳」两件事。
 *
 * ── 积分格式选型（实测，选型依据见文末四项必答②）────────────────────
 * 电容 i = C·dv/dt 的离散化用**梯形积分 + 首步后向欧拉启动**：
 *   梯形  i[k] = (2C/dt)·(v[k] − v[k−1]) − i[k−1] = G·v[k] − I0
 *         G = 2C/dt，I0 = G·v[k−1] + i[k−1]
 *   首步  没有可信的 i[0]，改用后向欧拉（G = C/dt、I0 = G·v[0]）起步
 * R=1kΩ C=100μF V=5V（τ=0.1s）、dt=10ms 时 t=τ 的误差：
 *   全程后向欧拉   −2.79%   ✗ 不满足 <2%
 *   梯形取 i0=0    −3.01%   ✗ 不满足 <2%
 *   **首步 BE+梯形 −0.23%**  ✓  ← 采用
 *   IC 精确 i0+梯形 +0.05%   ✓  （精度更高但要做一次「电容当电压源」的初值解）
 * 3τ/6τ 处误差进一步收敛到 −0.012%/0.000%。
 *
 * ── 跨数量级策略（技术约束 6）────────────────────────────────────────
 * 时钟 1Hz（秒级）与门 TPD 10ns（纳秒级）相差 9 个数量级，绝不允许用 ns
 * 步长跑完整个秒级波形。做法是**把翻转与采样解耦**：
 *   · 时钟/脉冲的电平翻转按**绝对时刻**触发（开始时生成翻转时间表）；
 *   · 门延迟体现为**输出跳变时间戳** = 输入跳变时刻 + TPD（事件驱动传播，
 *     多级串联时精确累加 n×TPD，不被采样栅格污染）；
 *   · 波形按用户 dt 采样，跳变在采样序列里落在最近的采样点上；
 *     精确时刻进 `stats.tpEvents`。
 *
 * ── 与 simdig 的关系（互不干扰）──────────────────────────────────────
 * 暂态模式下时钟/脉冲由本模块生成真实电压波形（不是 setSourceLevel 的布尔
 * 电平），数字门输入用 levelFromVoltage(瞬时电压) 判定；数字面板模式
 * （手动 stepClock / 空格步进）原样保留。本模块**不读写 simdig 的运行态**，
 * 自带一套数字求值与延迟线，两边语义一致（同一套阈值 levelFromVoltage）。
 *
 * ── 电容状态归属 ─────────────────────────────────────────────────────
 * 状态 = 各电容电压 vC 与上一步电流 i，存在本模块的 capState（devmodels
 * 保持无状态）。默认初始 0V；进出实验由 resetTransientState() 清零
 * （同包 6 resetDigState() 的断电重上语义）。
 */

import {
  makeMatrix,
  makeVector,
  newtonSolve,
  allFinite,
} from './solver.js';
import {
  getModel,
  needsBranch,
  validateParams,
  ledCurrent,
  capacitanceOf,
  transientCompanion,
  transientCurrent,
  conductsTransient,
} from './devmodels.js';
import {
  collectEntries,
  entryNets,
  chooseGround,
  checkShorts,
  reachableFromGround,
} from './simdc.js';
import {
  isDigital,
  getDigModel,
  DIG_SOURCES,
  levelFromVoltage,
  voltageOfLevel,
  X,
  TPD_GATE,
  TPD_FF,
} from './digmodels.js';
import { fgenVoltageAt } from './instruments-core.js';
import {
  collectMix,
  evalMixUnit,
  bitsToLevels,
  analyzeMixLoops,
  MAX_MIX_ITER,
  MIX_DEFAULT_SUPPLY,
  MIX_FULL_SCALE,
} from './simmix.js';

/* ==========================================================================
   常量
   ========================================================================== */

/** 单通道采样点上限（技术约束 5）：超出按时间均匀抽稀，保留首尾 */
export const MAX_SAMPLES = 20000;

/** 步长默认值（秒，技术约束 6 建议 10ms） */
export const DEFAULT_DT = 0.01;

/** 时长默认值（秒） */
export const DEFAULT_DURATION = 1;

/** 电压合理范围：超过视为发散（技术约束 3） */
export const V_LIMIT = 1e6;

/** 数字输出电平映射到波形的高电平电压 */
export const HIGH_VOLTAGE = 5;

/** 数字求值单步最大轮数（上电沉降用） */
const SETTLE_PASSES = 8;

/**
 * 初值解的刚度系数：k=0 把 dt 缩小这么多倍做一次「硬后向欧拉」，
 * 使电容端电压被钉在 vPrev 上（相对误差 ~1e-3），同时解出初始电流 i[0]。
 * 取 1e-3 而不是更小，是给矩阵条件数留余量（刚度再高会把正常主元挤到奇异阈值下）。
 */
const IC_STIFFEN = 1e-3;

/** 单步内允许的延迟事件上限，防止病态环路把页面拖死 */
const MAX_EVENTS_PER_STEP = 4096;

/* ==========================================================================
   电容状态（暂态状态显式归属本模块）
   ========================================================================== */

/** compId → { v: 上一步端电压, i: 上一步电流 } */
const capState = new Map();
/** compId → { i: 上一步电流, v: 上一步端电压 }（指令包 9：电感） */
const indState = new Map();

/** 清空电容状态（进出实验、切换实验时调用，同 resetDigState 语义） */
export function resetTransientState() {
  capState.clear();
  indState.clear();
}

/** 读某个电容的当前状态（调试/测试用） */
export function capStateOf(componentId) {
  return capState.get(componentId) || { v: 0, i: 0 };
}

/** 预置某个电容的初始电压（测试/续算用；电流置 0） */
export function setCapState(componentId, v, i = 0) {
  capState.set(componentId, { v: Number(v) || 0, i: Number(i) || 0 });
}

/* ==========================================================================
   小工具
   ========================================================================== */

function timeNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** 模拟域视图：滤掉数字元件（clock/pulse/logic-switch/ic74xx） */
function analogStateOf(modelApi) {
  const state = modelApi.getState();
  // 数字源与函数发生器都不进 MNA 元件表：前者由数字域驱动，后者按波形逐时刻驱动
  return {
    ...state,
    components: state.components.filter(
      (comp) => !isDigital(comp.type) && comp.type !== 'fgen',
    ),
  };
}

/** 网表查找：`c:<compId>:<pin>` → netId */
function netOfPin(netOf, compId, pin) {
  return netOf.get(`c:${compId}:${pin}`) || null;
}

/* ==========================================================================
   电源波形（时钟 / 脉冲 / 逻辑开关）
   ========================================================================== */

/** 时钟参数归一：频率 > 0，占空比 5~95% */
function clockParams(params) {
  const f = Number(params && params.frequency);
  const dutyRaw = Number(params && params.duty);
  return {
    f: Number.isFinite(f) && f > 0 ? f : 1,
    duty: Number.isFinite(dutyRaw) ? Math.min(95, Math.max(5, dutyRaw)) / 100 : 0.5,
  };
}

/** 时钟在 t 时刻的电平：上电为高，相位落在高区即高 */
export function clockLevelAt(t, params) {
  const { f, duty } = clockParams(params);
  const period = 1 / f;
  const phase = ((t % period) + period) % period;
  return phase < duty * period - 1e-15 ? 1 : 0;
}

/**
 * 时钟翻转时间表（绝对时刻，技术约束 6）。
 * 上电 t=0 为高电平不算翻转；之后每到下降/上升沿记一次。
 * 1Hz duty 50、duration=1s → 翻转 2 次（t=0.5 与 t=1.0），符合 duration×2。
 */
export function clockSchedule(params, until, t0 = 0) {
  const { f, duty } = clockParams(params);
  const period = 1 / f;
  const high = duty * period;
  const flips = [];
  let guard = 0;
  // 上电 t0 为高电平；之后在绝对时刻上交替翻转（技术约束 6）
  let at = t0 + high;
  let level = 0;
  while (at <= until + 1e-12 && guard < 100000) {
    if (at > t0 + 1e-12) flips.push({ at, level });
    guard += 1;
    at += level === 0 ? period - high : high;
    level = level === 0 ? 1 : 0;
  }
  return { initialLevel: 1, flips };
}

/**
 * 脉冲在 t 时刻的电平。
 *   mode='momentary'：运行即触发一次正脉冲，[0, width) 为高，之后为低
 *   mode='toggle'  ：翻转保持——t=0 起一直为高（等价于按下不放）
 */
export function pulseLevelAt(t, params) {
  const mode = params && params.mode === 'toggle' ? 'toggle' : 'momentary';
  if (mode === 'toggle') return 1;
  const widthRaw = Number(params && params.width);
  const width = Number.isFinite(widthRaw) && widthRaw > 0 ? widthRaw : 0.1;
  return t < width - 1e-15 ? 1 : 0;
}

/** 脉冲翻转时间表 */
export function pulseSchedule(params, until, t0 = 0) {
  const mode = params && params.mode === 'toggle' ? 'toggle' : 'momentary';
  if (mode === 'toggle') return { initialLevel: 1, flips: [] };
  const widthRaw = Number(params && params.width);
  const width = Number.isFinite(widthRaw) && widthRaw > 0 ? widthRaw : 0.1;
  const flips = [];
  // 单次脉冲在绝对时刻 t0 起算，下降沿在 t0+width
  if (t0 + width <= until + 1e-12 && t0 + width > t0 + 1e-12) {
    flips.push({ at: t0 + width, level: 0 });
  }
  return { initialLevel: 1, flips };
}

/** 逻辑开关电平：读参数（跟存档走） */
export function switchLevelAt(params) {
  return params && params.state === 'hi' ? 1 : 0;
}

/* ==========================================================================
   数字域：单位收集 + 事件驱动延迟线
   ========================================================================== */

/**
 * 收集数字求值单元（门 / 触发器）与数字源。
 * 结构取自 digmodels 的 model.units，求值函数也是同一套（阈值判定一致，
 * 保证「数字面板模式」与「暂态模式」在同一电路上结果相同）。
 */
function collectDigital(modelApi, netOf) {
  const state = modelApi.getState();
  const units = [];
  const sources = [];
  const consumersOfNet = new Map(); // netId → [unitIndex]

  const addConsumer = (net, index) => {
    if (!net) return;
    if (!consumersOfNet.has(net)) consumersOfNet.set(net, []);
    consumersOfNet.get(net).push(index);
  };

  state.components.forEach((comp) => {
    if (!isDigital(comp.type)) return;

    if (comp.type === 'ic74xx' || getDigModel(comp.type, comp.params)) {
      const model = getDigModel(comp.type, comp.params);
      if (!model) return;
      model.units.forEach((unit) => {
        const index = units.length;
        const inputs = unit.inputs.map((pin) => ({ pin, net: netOfPin(netOf, comp.id, pin) }));
        const outputs = unit.outputs.map((pin) => ({ pin, net: netOfPin(netOf, comp.id, pin) }));
        units.push({
          key: `${comp.id}#${unit.id}`,
          compId: comp.id,
          comp,
          model,
          unit,
          inputs,
          outputs,
          tpd: model.tpd || (unit.kind === 'ff' ? TPD_FF : TPD_GATE),
        });
        inputs.forEach((item) => addConsumer(item.net, index));
      });
      return;
    }

    const spec = DIG_SOURCES[comp.type];
    if (!spec) return;
    sources.push({
      comp,
      spec,
      net: netOfPin(netOf, comp.id, spec.out),
      refNet: spec.ref ? netOfPin(netOf, comp.id, spec.ref) : null,
    });
  });

  return { units, sources, consumersOfNet };
}

/** 数字求值：给定各输入电平，算出本单元的输出电平（与 simdig 同一套 fn） */
function evalUnit(unitInfo, values, ffState) {
  const { unit } = unitInfo;
  if (unit.kind === 'ff') {
    const r = unit.fn(values, ffState);
    return { outputs: r.outputs, state: r.state };
  }
  return { outputs: unit.fn(values), state: ffState };
}

/* ==========================================================================
   对外：solveTransient
   ========================================================================== */

/**
 * 跑一次暂态仿真（同步跑完返回结果）。
 *
 * @param {object} modelApi 需要 { getState(), getNetlist(), findComponent? }
 * @param {object} [opts]
 *   duration   秒，> 0（默认 1）
 *   dt         秒，> 0（默认 0.01）
 *   channels   可选，指定要采样的网 id 数组（缺省=所有有定义电压的网）
 *   initialVc  可选，{ compId: 电压 } 预置电容初始电压（默认 0V）
 * @returns {{ok, error, warnings, waveforms, channels, stats}}
 */
export function solveTransient(modelApi, opts = {}) {
  const started = timeNow();
  const warnings = [];

  const empty = (patch) => ({
    ok: true,
    error: null,
    warnings,
    waveforms: [],
    channels: [],
    stats: {
      steps: 0,
      events: 0,
      elapsedMs: 0,
      maxMemory: 0,
      tpEvents: [],
      dt: 0,
      duration: 0,
      mix: { units: 0, types: [], iterationsMax: 0, dacBits: [] },
    },
    ...patch,
  });

  if (!modelApi || typeof modelApi.getState !== 'function' || typeof modelApi.getNetlist !== 'function') {
    return empty({ ok: false, error: '仿真引擎缺少 model 接口' });
  }

  /* ---- 参数校验 ---- */
  const duration = Number(opts.duration);
  const dt = Number(opts.dt === undefined || opts.dt === null ? DEFAULT_DT : opts.dt);
  if (!Number.isFinite(duration) || duration <= 0) {
    return empty({ ok: false, error: '时长必须大于 0' });
  }
  if (!Number.isFinite(dt) || dt <= 0) {
    return empty({ ok: false, error: '步长必须大于 0' });
  }
  if (dt > duration) {
    warnings.push(`步长（${dt}s）大于时长（${duration}s），只会采到首尾两点`);
  }
  // 绝对时间起点：分帧续算时上一段的终点就是这一段的 t0，
  // 时钟/脉冲按绝对时刻定相位，波形时间戳也用绝对时刻拼接。
  const t0 = Number(opts.t0) || 0;

  const state = modelApi.getState();
  if (!state || !Array.isArray(state.components) || state.components.length === 0) {
    return empty({ ok: false, error: '电路为空，放几个元件再仿真' });
  }

  const netlist = modelApi.getNetlist();
  const netOf = netlist && netlist.netOf ? netlist.netOf : new Map();

  /* ---- 预置电容状态（默认 0V） ---- */
  if (opts.initialVc && typeof opts.initialVc === 'object') {
    Object.keys(opts.initialVc).forEach((id) => {
      setCapState(id, opts.initialVc[id], 0);
    });
  }

  /* ---- 模拟域：筛选 / 选地 / 剪枝（复用 simdc 的公共函数保持单源） ---- */
  const analogState = analogStateOf(modelApi);
  const { entries, warnings: entryWarnings, errors } = collectEntries(analogState, netOf);
  warnings.push(...entryWarnings);
  if (errors.length > 0) {
    return empty({ ok: false, error: errors[0], errors });
  }

  /* ---- 数字域 ---- */
  const digital = collectDigital(modelApi, netOf);

  /* ---- 混合信号边界元件（指令包 8） ---- */
  const mix = collectMix(state, netOf);
  const mixUnits = mix.units;

  /* ---- 时变源（时钟/脉冲/逻辑开关）→ 等效电压源 ---- */
  const sourceDrives = [];
  digital.sources.forEach((src) => {
    if (!src.net) return;
    sourceDrives.push({
      kind: 'source',
      compId: src.comp.id,
      comp: src.comp,
      refNet: src.refNet || null,
      outNet: src.net,
      levelAt:
        src.comp.type === 'clock'
          ? (t) => clockLevelAt(t, src.comp.params)
          : src.comp.type === 'pulse'
            ? (t) => pulseLevelAt(t, src.comp.params)
            : () => switchLevelAt(src.comp.params),
    });
  });

  // 函数发生器：模拟波形源（与时钟/脉冲并列，但输出是连续电压）
  state.components.forEach((comp) => {
    if (comp.type !== 'fgen') return;
    const outNet = netOfPin(netOf, comp.id, 'OUT');
    const refNet = netOfPin(netOf, comp.id, 'GND');
    if (!outNet) return;
    sourceDrives.push({
      kind: 'fgen',
      compId: comp.id,
      comp,
      refNet: refNet || null,
      outNet,
      voltageAt: (t) => fgenVoltageAt(t, comp.params),
    });
  });

  // 时钟/脉冲的翻转时间表（绝对时刻）
  const sourceSchedules = [];
  digital.sources.forEach((src) => {
    if (src.comp.type === 'clock') {
      const sch = clockSchedule(src.comp.params, t0 + duration, t0);
      sourceSchedules.push({ compId: src.comp.id, ...sch });
    } else if (src.comp.type === 'pulse') {
      const sch = pulseSchedule(src.comp.params, t0 + duration, t0);
      sourceSchedules.push({ compId: src.comp.id, ...sch });
    }
  });

  /* ---- 参考地（复用 simdc 策略：首个电压源负端优先） ----
   * 时钟/脉冲本身就是电压源，必须参与选地：否则「时钟 GND 引脚」不会被
   * 当成参考地，波形会整体漂到一个任意电位上。
   * 带参考引脚的源（clock=GND、pulse=-）按其参考端参与；无参考引脚的
   * 逻辑开关等接地端留给后面统一落到 ground。
   */
  const groundPick = chooseGround([
    ...entries,
    ...sourceDrives.filter((d) => d.refNet).map((d, i) => ({
      comp: { id: `__gs${i}`, type: 'vsource', params: { voltage: 0 } },
      model: getModel('vsource'),
      netPos: d.outNet,
      netNeg: d.refNet,
    })),
  ]);
  const ground = groundPick.net;
  sourceDrives.forEach((d) => {
    d.negNet = d.refNet || ground;
    if (d.negNet === d.outNet) d.negNet = ground;
  });

  /* ---- 暂态可达性：电容也算导通 ---- */
  const reachable = reachableFromGround(entries, ground, conductsTransient);

  /* ---- 冲激冲突检查：电容与理想电压源直连（初始电压不一致 ⇒ 冲激电流） ---- */
  const impulse = checkCapacitorImpulse(entries, sourceDrives, ground);
  if (impulse) {
    return empty({ ok: false, error: '暂态仿真发散（请检查电路）', detail: impulse });
  }

  /* ---- 短路检查（复用 simdc） ---- */
  const shortCircuit = checkShorts(entries);
  if (shortCircuit) {
    return empty({ ok: false, error: shortCircuit.error, detail: shortCircuit.detail });
  }

  /* ---- 驱动条目（时变源 + 数字输出）：一次建好，每步只改电压值 ---- */
  const driveEntries = [];
  sourceDrives.forEach((drv, index) => {
    if (!drv.outNet || drv.outNet === drv.negNet) return;
    drv.entry = makeDriveEntry(`__src${index + 1}`, drv.outNet, drv.negNet, 0);
    driveEntries.push(drv.entry);
  });
  digital.units.forEach((ui, index) => {
    ui.outputs.forEach((out) => {
      if (!out.net || out.net === ground) return;
      const entry = makeDriveEntry(`__dgt${index + 1}_${out.pin}`, out.net, ground, 0);
      entry.driveKey = `${ui.compId}:${out.pin}`;
      driveEntries.push(entry);
    });
  });
  // 边界元件（比较器 / DAC / 缓冲）的输出同样是模拟驱动源。
  // 参考端优先取元件自己的 GND 脚：芯片没接系统地时输出以它的 GND 为准。
  mixUnits.forEach((unit, index) => {
    const out = unit.outputs.find((item) => item.pin === 'OUT' && item.net);
    if (!out) return;
    const ref = unit.gndNet || ground;
    if (!ref || out.net === ref) return;
    const entry = makeDriveEntry(`__mix${index + 1}`, out.net, ref, 0);
    entry.driveKey = `mix:${unit.componentId}:OUT`;
    entry.mixUnit = unit;
    unit.driveEntry = entry;
    driveEntries.push(entry);
  });

  /* ---- 跨域组合环路检测（结构性失败，先于求解报出） ---- */
  if (mixUnits.length > 0) {
    const loop = analyzeMixLoops({
      state,
      netOf,
      mixUnits,
      digitalUnits: digital.units,
    });
    if (!loop.ok) {
      const chain = loop.cycle.join(' → ');
      const via = loop.via.length > 0 ? `（经由 ${loop.via.join('、')}）` : '';
      return empty({
        ok: false,
        error: '混合仿真不收敛：检测到跨域组合环路',
        detail: `环上元件：${chain}${via}`,
        cycle: loop.cycle,
        warnings,
        ground,
        groundReason: groundPick.why,
      });
    }
  }

  /* ---- 装配索引（含驱动条目的支路未知量） ---- */
  const built = buildIndex(entries, driveEntries, ground, reachable);
  if (built.error) return empty({ ok: false, error: built.error });

  const { nodeIndex, branchOf, orderedNets, n, driveEntries: activeDrives } = built;
  // 纯数字电路（时钟 + 门）没有模拟未知量，但数字域照样要跑、要出波形
  const analogEmpty = built.empty === true;
  if (analogEmpty) {
    const hasDigital = digital.units.length > 0 || digital.sources.length > 0;
    if (!hasDigital) {
      warnings.push('电路里没有构成回路的元件');
      return empty({ warnings, ground, groundReason: groundPick.why });
    }
  }

  /* ---- 数字延迟线状态 ---- */
  const driverLevel = new Map(); // pinKey `${compId}:${pin}` → { level, via }
  const pending = [];            // { at, key, level, via }
  const tpEvents = [];
  let sourceEvents = 0;

  const netLevelOf = (net, solvedVoltage) => {
    const drv = netDriverLevel(net);
    if (drv !== null && drv !== undefined) return drv;
    if (solvedVoltage !== undefined && solvedVoltage !== null) return levelFromVoltage(solvedVoltage);
    return X;
  };

  // 每个网的数字驱动（源 + 门/触发器输出）→ 该网的电平
  const netDriverMap = new Map(); // netId → { key, kind, comp }
  digital.sources.forEach((src) => {
    if (!src.net) return;
    netDriverMap.set(src.net, { key: `src:${src.comp.id}`, kind: 'source', comp: src.comp });
  });
  digital.units.forEach((ui) => {
    ui.outputs.forEach((out) => {
      if (!out.net) return;
      netDriverMap.set(out.net, { key: `${ui.compId}:${out.pin}`, kind: 'output', comp: ui.comp });
    });
  });
  // 边界元件的逻辑输出（比较器 OUT / ADC D0..D7 / 缓冲 OUT）。
  // DAC 的输出是模拟量，不进电平表——它的负载按电压阈值读。
  mixUnits.forEach((unit) => {
    if (unit.kind === 'dac') return;
    unit.outputs.forEach((out) => {
      if (!out.net) return;
      netDriverMap.set(out.net, {
        key: `mix:${unit.componentId}:${out.pin}`,
        kind: 'output',
        comp: unit.comp,
      });
    });
  });

  function netDriverLevel(net) {
    const info = netDriverMap.get(net);
    if (!info) return null;
    if (info.kind === 'source') {
      const drv = sourceDrives.find((d) => d.compId === info.comp.id);
      return drv ? drv.levelAt(currentT) : X;
    }
    const cur = driverLevel.get(info.key);
    return cur ? cur.level : X;
  }

  /* ---- 采样缓冲 ---- */
  const sampleNets = [];
  const sampleValues = new Map(); // netId → Float64Array
  const sampleCount = Math.floor(duration / dt + 1e-9) + 1;
  const rawN = Math.min(sampleCount, 2000000);

  const ensureChannel = (net) => {
    if (!net || sampleValues.has(net)) return;
    if (opts.channels && Array.isArray(opts.channels) && opts.channels.length > 0
      && !opts.channels.includes(net)) return;
    sampleNets.push(net);
    sampleValues.set(net, new Float64Array(rawN));
  };

  /* ---- 上电沉降：数字输出立即给定（延迟只作用于之后的跳变） ---- */
  let currentT = 0;
  const settleDigital = () => {
    const values = {};
    for (let pass = 0; pass < SETTLE_PASSES; pass += 1) {
      let changed = 0;
      digital.units.forEach((ui, index) => {
        const local = {};
        ui.inputs.forEach((item) => {
          local[item.pin] = netLevelOf(item.net);
        });
        const prev = driverLevel.get(ui.outputs[0] ? `${ui.compId}:${ui.outputs[0].pin}` : '') || {};
        const r = evalUnit(ui, local, ffMemory.get(ui.key));
        if (r.state !== undefined) ffMemory.set(ui.key, r.state);
        ui.outputs.forEach((out) => {
          const key = `${ui.compId}:${out.pin}`;
          const before = driverLevel.get(key);
          const next = r.outputs[out.pin];
          if (!before || before.level !== next) {
            driverLevel.set(key, { level: next, via: ui.key });
            changed += 1;
          }
        });
        void prev;
        void index;
      });
      if (changed === 0) break;
    }
  };

  /** 触发器记忆（暂态自用，与 simdig 的 ffMemory 互不干扰） */
  const ffMemory = new Map();

  /** 数字输入网 → 电平（数字驱动优先，其次按电压判） */
  const inputLevelOf = (net, vOfNet) => {
    const drv = netDriverLevel(net);
    if (drv !== null && drv !== undefined) return drv;
    const v = vOfNet ? vOfNet(net) : null;
    return v === null || v === undefined ? X : levelFromVoltage(v);
  };

  /** 求值一个单元并按 tpd 调度跳变 */
  const scheduleUnit = (ui, at, forceEval) => {
    const local = {};
    ui.inputs.forEach((item) => {
      local[item.pin] = inputLevelOf(item.net, vOfNetRef.v);
    });
    const r = evalUnit(ui, local, ffMemory.get(ui.key));
    if (r.state !== undefined) ffMemory.set(ui.key, r.state);
    ui.outputs.forEach((out) => {
      const key = `${ui.compId}:${out.pin}`;
      const cur = driverLevel.get(key);
      const next = r.outputs[out.pin];
      const hasPending = pending.some((p) => p.key === key);
      if (!hasPending && (!cur || cur.level !== next)) {
        pending.push({ at: at + ui.tpd, key, level: next, via: ui.key });
      }
    });
    void forceEval;
  };

  /** 应用时刻 ≤ t 的跳变（事件驱动，多级串联按绝对时刻精确累加 TPD） */
  const vOfNetRef = { v: null };
  const applyEvents = (t, budget) => {
    let guard = 0;
    while (guard < MAX_EVENTS_PER_STEP) {
      guard += 1;
      let due = null;
      for (let i = 0; i < pending.length; i += 1) {
        if (pending[i].at <= t + 1e-15 && (!due || pending[i].at < due.at)) due = pending[i];
      }
      if (!due) break;
      pending.splice(pending.indexOf(due), 1);
      const before = driverLevel.get(due.key);
      driverLevel.set(due.key, { level: due.level, via: due.via });
      tpEvents.push({ at: due.at, from: before ? before.level : X, to: due.level, via: due.via });
      // 让消费该网的单元重算，按 at + tpd 调度下一级
      const pin = due.key.slice(due.key.indexOf(':') + 1);
      const compId = due.key.slice(0, due.key.indexOf(':'));
      const net = netOfPin(netOf, compId, pin);
      const consumers = digital.consumersOfNet.get(net) || [];
      consumers.forEach((index) => scheduleUnit(digital.units[index], due.at));
      void budget;
    }
    return guard;
  };

  /* ---- 主循环 ---- */
  const caps = entries.filter((entry) => entry.model.id === 'capacitor');
  const inductors = entries.filter((entry) => entry.model.id === 'inductor');
  const ctxOfInd = (entry) => {
    const st = indState.get(entry.comp.id) || { i: 0, v: 0 };
    return {
      dt,
      vPrev: st.v,
      iPrev: st.i,
      startup: false,
    };
  };
  const hasNonlinear = entries.some((entry) => entry.model.isNonlinear);
  let currentV = new Map(); // netId → 电压（本步解）

  const vOfNet = (net) => {
    if (net === ground) return 0;
    if (currentV.has(net)) return currentV.get(net);
    const drv = sourceDrives.find((d) => d.outNet === net);
    if (drv) return voltageOfLevel(drv.levelAt(currentT));
    return null;
  };
  vOfNetRef.v = vOfNet;

  /* ---- 边界元件求值（每轮联合迭代调用） ---- */
  const mixSupplyOf = (unit) => {
    const vcc = unit.vccNet ? vOfNet(unit.vccNet) : null;
    if (vcc === null || vcc === undefined) return MIX_DEFAULT_SUPPLY;
    const gnd = unit.gndNet ? vOfNet(unit.gndNet) : null;
    return Math.max(0.1, vcc - (gnd === null || gnd === undefined ? 0 : gnd));
  };

  const evalMixNow = () => {
    const ctx = {
      supplyOf: mixSupplyOf,
      voltage: (net) => (net ? vOfNet(net) : null),
      level: (net) => inputLevelOf(net, vOfNet),
    };
    let changed = 0;
    mixUnits.forEach((unit) => {
      const r = evalMixUnit(unit, ctx);
      if (unit.kind === 'comparator' || unit.kind === 'buffer') {
        const key = `mix:${unit.componentId}:OUT`;
        const cur = driverLevel.get(key);
        if (!cur || cur.level !== r.level) {
          driverLevel.set(key, { level: r.level, via: `mix:${unit.componentId}` });
          changed += 1;
        }
        return;
      }
      if (unit.kind === 'adc') {
        const levels = bitsToLevels(r.bits || 0);
        unit.outputs.forEach((out) => {
          if (!out.net) return;
          const key = `mix:${unit.componentId}:${out.pin}`;
          const level = levels[out.pin] === 1 ? 1 : 0;
          const cur = driverLevel.get(key);
          if (!cur || cur.level !== level) {
            driverLevel.set(key, { level, via: `mix:${unit.componentId}` });
            changed += 1;
          }
        });
      }
    });
    return changed;
  };

  /** 驱动电压签名：用于联合迭代的收敛判定 */
  const driveSignature = () => activeDrives
    .filter((entry) => entry.driveKey)
    .map((entry) => Number(entry.comp.params.voltage || 0).toFixed(6))
    .join(',');

  const dacBits = new Map();

  evalMixNow();
  settleDigital();

  const steps = [];
  let mixIterMax = 0;
  const total = Math.floor(duration / dt + 1e-9);
  for (let k = 0; k <= total; k += 1) {
    const t = t0 + k * dt;
    currentT = t;

    // 1) 事件应用（源翻转 + 门跳变，绝对时刻）
    sourceSchedules.forEach((sch) => {
      sch.flips.forEach((flip) => {
        if (Math.abs(flip.at - t) < dt / 2 && !flip.done) {
          flip.done = true;
          sourceEvents += 1;
        }
      });
    });
    applyEvents(t);

    // 2) 时变源电压（时钟/脉冲/逻辑开关）
    sourceDrives.forEach((drv) => {
      // 函数发生器直接给电压；时钟/脉冲/逻辑开关走"电平 → 电压"换算
      drv.stampV = drv.voltageAt ? drv.voltageAt(t) : voltageOfLevel(drv.levelAt(t));
      if (drv.entry) drv.entry.comp.params.voltage = drv.stampV;
    });

    // 3) 联合迭代：模拟 ↔ 边界 ↔ 数字，直到驱动电压稳定（≤ MAX_MIX_ITER 次）
    //    k=0 是「初值解」：电容用很硬的后向欧拉（dt 缩小 IC_STIFFEN 倍）
    //    把端电压钉在 vPrev 上，既给出 t=0 的各点电压，又顺带解出初始电流 i[0]。
    //    之后全程梯形（i[k] = G(v[k]−v[k−1]) − i[k−1]），精度见文件头选型实测。
    const ctxOf = (entry) => {
      const st = capState.get(entry.comp.id) || { v: 0, i: 0 };
      return {
        dt: k === 0 ? dt * IC_STIFFEN : dt,
        vPrev: st.v,
        iPrev: st.i,
        startup: k === 0,
      };
    };

    let solved = null;
    let mixIterations = 0;
    let mixConverged = false;
    let prevSignature = null;

    for (let iter = 0; iter < MAX_MIX_ITER; iter += 1) {
      mixIterations = iter + 1;

      // 3a) 数字/边界驱动电压（上一轮求值结果）
      activeDrives.forEach((entry) => {
        if (!entry.driveKey) return;
        const cur = driverLevel.get(entry.driveKey);
        entry.comp.params.voltage = voltageOfLevel(cur ? cur.level : X);
      });
      // DAC 是纯组合：输出直接由当前输入位算（D/255·Vref），不需要记忆
      mixUnits.forEach((unit) => {
        if (unit.kind !== 'dac' || !unit.driveEntry) return;
        let d = 0;
        unit.inputs.forEach((input, index) => {
          if (inputLevelOf(input.net, vOfNet) === 1) d |= 1 << index;
        });
        const vrefRaw = Number(unit.comp.params && unit.comp.params.vref);
        const vref = Number.isFinite(vrefRaw) && vrefRaw > 0 ? vrefRaw : mixSupplyOf(unit);
        unit.driveEntry.comp.params.voltage = (d / MIX_FULL_SCALE) * vref;
        dacBits.set(unit.componentId, d);
      });

      // 3b) 装配 + 求解
      solved = analogEmpty
        ? { ok: true, x: new Float64Array(0), iter: 0, residual: 0 }
        : solveInstant(entries, activeDrives, nodeIndex, branchOf, n, ctxOf, hasNonlinear, ctxOfInd);
      if (!solved.ok) {
        return empty({
          ok: false,
          error: solved.error === '矩阵奇异（电路可能开路/短路）'
            ? '电路开路：存在未闭合回路'
            : (solved.error || '暂态仿真发散（请检查电路）'),
          warnings,
          ground,
          groundReason: groundPick.why,
          detail: solved.detail,
        });
      }

      // 5) 数值健全性（技术约束 3：发散必须 ok:false，不许输出垃圾）
      if (!allFinite(solved.x)) {
        return empty({
          ok: false,
          error: '暂态仿真发散（请检查电路）',
          warnings,
          ground,
          groundReason: groundPick.why,
        });
      }
      currentV = new Map();
      orderedNets.forEach((net) => {
        const idx = nodeIndex.get(net);
        currentV.set(net, solved.x[idx]);
      });
      for (const v of currentV.values()) {
        if (!(Math.abs(v) <= V_LIMIT)) {
          return empty({
            ok: false,
            error: '暂态仿真发散（请检查电路）',
            warnings,
            ground,
            groundReason: groundPick.why,
          });
        }
      }

      // 3c) 边界元件求值（用刚解出的模拟电压）
      evalMixNow();

      // 3d) 数字门按当前电压重算输入（跳变按 TPD 排到未来时刻）
      digital.units.forEach((ui) => scheduleUnit(ui, t));
      applyEvents(t);

      // 3e) 收敛判定：没有边界元件时一次即可；有则看驱动电压是否稳定
      if (mixUnits.length === 0) {
        mixConverged = true;
        break;
      }
      const signature = driveSignature();
      if (signature === prevSignature) {
        mixConverged = true;
        break;
      }
      prevSignature = signature;
    }

    if (!mixConverged) {
      return empty({
        ok: false,
        error: `混合仿真不收敛：跨域迭代超过 ${MAX_MIX_ITER} 次`,
        detail: '请检查比较器 / ADC / DAC 之间是否构成无延迟反馈（可加电容或串电阻）',
        warnings,
        ground,
        groundReason: groundPick.why,
      });
    }
    if (mixIterations > mixIterMax) mixIterMax = mixIterations;

    // 6) 电感状态更新（梯形/首步 BE）
    inductors.forEach((entry) => {
      const br = branchOf.get(entry.comp.id);
      const i = br === undefined ? 0 : solved.x[br];
      const vp = entry.netPos === ground ? 0 : (currentV.get(entry.netPos) ?? 0);
      const vn = entry.netNeg === ground ? 0 : (currentV.get(entry.netNeg) ?? 0);
      indState.set(entry.comp.id, { i, v: vp - vn });
    });

    // 6b) 电容状态更新（梯形/首步 BE）
    caps.forEach((entry) => {
      const vp = entry.netPos === ground ? 0 : (currentV.get(entry.netPos) ?? 0);
      const vn = entry.netNeg === ground ? 0 : (currentV.get(entry.netNeg) ?? 0);
      const v = vp - vn;
      const c = capacitanceOf(entry.comp.params);
      const pair = transientCompanion(c, ctxOf(entry));
      const i = transientCurrent(pair, v);
      capState.set(entry.comp.id, { v, i });
    });

    // 7) 模拟电压 → 数字输入：让门重算（TPD 调度）
    digital.units.forEach((ui) => scheduleUnit(ui, t));

    // 8) 采样
    const sampled = new Map();
    orderedNets.forEach((net) => sampled.set(net, currentV.get(net)));
    sourceDrives.forEach((drv) => {
      if (drv.outNet && !sampled.has(drv.outNet)) sampled.set(drv.outNet, drv.stampV);
    });
    digital.units.forEach((ui) => {
      ui.outputs.forEach((out) => {
        if (!out.net) return;
        const cur = driverLevel.get(`${ui.compId}:${out.pin}`);
        if (!sampled.has(out.net)) sampled.set(out.net, voltageOfLevel(cur ? cur.level : X));
      });
    });
    mixUnits.forEach((unit) => {
      if (unit.kind === 'dac') return; // DAC 输出是模拟量，已在 orderedNets 里
      unit.outputs.forEach((out) => {
        if (!out.net) return;
        const cur = driverLevel.get(`mix:${unit.componentId}:${out.pin}`);
        if (!sampled.has(out.net)) sampled.set(out.net, voltageOfLevel(cur ? cur.level : X));
      });
    });
    sampled.forEach((v, net) => {
      if (v === null || v === undefined) return;
      ensureChannel(net);
      const arr = sampleValues.get(net);
      if (arr && k < arr.length) arr[k] = v;
    });
    steps.push(t);
  }

  /* ---- 组装 waveforms / channels（含抽稀） ---- */
  const rawCount = steps.length;
  const stride = Math.max(1, Math.ceil(rawCount / MAX_SAMPLES));
  const pick = [];
  for (let i = 0; i < rawCount; i += stride) pick.push(i);
  if (pick.length > 0 && pick[pick.length - 1] !== rawCount - 1) pick.push(rawCount - 1);

  const waveforms = [];
  const channels = [];
  // 哪些网是"数字线"：门/边界元件的逻辑输出。波形容器据此画阶梯并标注 type
  const digitalNets = new Set();
  digital.units.forEach((ui) => ui.outputs.forEach((out) => {
    if (out.net) digitalNets.add(out.net);
  }));
  // 时钟/脉冲/逻辑开关的输出是"逻辑电平",同样按数字线画阶梯（示波器/LA 要挂得上）
  sourceDrives.forEach((drv) => {
    if (!drv.outNet) return;
    if (drv.comp && (drv.comp.type === 'clock' || drv.comp.type === 'pulse' || drv.comp.type === 'logic-switch')) {
      digitalNets.add(drv.outNet);
    }
  });
  mixUnits.forEach((unit) => {
    if (unit.kind === 'dac') return;
    unit.outputs.forEach((out) => {
      if (out.net) digitalNets.add(out.net);
    });
  });
  sampleNets.forEach((net) => {
    const arr = sampleValues.get(net);
    if (!arr) return;
    const samples = [];
    let min = Infinity;
    let max = -Infinity;
    for (const i of pick) {
      const v = arr[i];
      samples.push({ t: Number((t0 + i * dt).toFixed(9)), v });
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (samples.length === 0) return;
    const driver = describeDriver(net, digital, sourceDrives, mixUnits);
    const type = digitalNets.has(net) ? 'digital' : 'analog';
    waveforms.push({ netId: net, label: net, samples, type });
    channels.push({
      netId: net,
      label: net,
      min: Number.isFinite(min) ? min : 0,
      max: Number.isFinite(max) ? max : 0,
      unit: 'V',
      driver,
      type,
    });
  });

  const result = empty({
    warnings,
    waveforms,
    channels,
    ground,
    groundReason: groundPick.why,
    stats: {
      steps: rawCount,
      events: sourceEvents,
      elapsedMs: Math.round((timeNow() - started) * 1000) / 1000,
      maxMemory: pick.length,
      tpEvents,
      dt,
      duration,
      t0,
      stride,
      mix: {
        units: mixUnits.length,
        types: mix.types,
        iterationsMax: mixIterMax,
        dacBits: [...dacBits.entries()].map(([id, bits]) => ({ componentId: id, bits })),
      },
    },
  });
  return result;
}

/* ==========================================================================
   内部：装配与求解
   ========================================================================== */

/** 构造一个「等效电压源」条目（时变源 / 数字输出驱动都走它） */
function makeDriveEntry(id, netPos, netNeg, voltage) {
  const model = getModel('vsource');
  return {
    comp: {
      id,
      type: 'vsource',
      params: { voltage },
      terminals: [
        { name: '+', direction: 'out', role: '', net: netPos },
        { name: '-', direction: 'out', role: '', net: netNeg },
      ],
    },
    model,
    netPos,
    netNeg,
    pinPos: '+',
    pinNeg: '-',
    isDrive: true,
  };
}

/**
 * 电容与理想电压源直连 ⇒ 初始电压不一致时要求冲激电流（无界），
 * 判为发散并给出可操作的建议。
 */
function checkCapacitorImpulse(entries, sourceDrives, ground) {
  const sources = [];
  entries.forEach((entry) => {
    if (entry.model.id !== 'vsource') return;
    sources.push({
      id: entry.comp.id,
      a: entry.netPos,
      b: entry.netNeg,
      v: Number(entry.comp.params.voltage) || 0,
    });
  });
  sourceDrives.forEach((drv, index) => {
    if (!drv.outNet) return;
    sources.push({
      id: `__src${index + 1}`,
      a: drv.outNet,
      b: drv.negNet || ground,
      v: voltageOfLevel(drv.levelAt ? drv.levelAt(0) : 1),
    });
  });

  for (const entry of entries) {
    if (entry.model.id !== 'capacitor') continue;
    const st = capState.get(entry.comp.id) || { v: 0, i: 0 };
    for (const src of sources) {
      const samePair = (src.a === entry.netPos && src.b === entry.netNeg)
        || (src.a === entry.netNeg && src.b === entry.netPos);
      if (!samePair) continue;
      const forced = (src.a === entry.netPos ? src.v : -src.v);
      if (Math.abs(forced - st.v) > 1e-9) {
        return `${entry.comp.id}（初始 ${st.v}V）与理想电压源 ${src.id}（${forced}V）直连，`
          + '理想电压源直连电容会产生冲激电流；请给电容串联一个小电阻再试';
      }
    }
  }
  return null;
}

/** 建立节点/支路下标（与 simdc.buildAndSolve 同构，但装配交给 solveInstant） */
function buildIndex(entries, driveEntries, ground, reachable) {
  const nodeIndex = new Map();
  const orderedNets = [];
  let index = 0;
  const addNet = (net) => {
    if (net === ground || nodeIndex.has(net) || !reachable.has(net)) return;
    nodeIndex.set(net, index);
    index += 1;
    orderedNets.push(net);
  };
  entries.forEach((entry) => {
    entryNets(entry).forEach(addNet);
  });
  driveEntries.forEach((entry) => {
    addNet(entry.netPos);
    addNet(entry.netNeg);
  });

  // 两端都能落下方程（节点下标或地）的驱动才真正参与装配
  const active = entries.concat(driveEntries).filter((entry) => (
    entryNets(entry).every((net) => net === ground || nodeIndex.has(net))
  ));
  const activeDrives = active.filter((entry) => entry.isDrive);

  const branchOf = new Map();
  let branchCount = 0;
  active.forEach((entry) => {
    if (!needsBranch(entry.comp.type)) return;
    branchOf.set(entry.comp.id, nodeIndex.size + branchCount);
    branchCount += 1;
  });

  const n = nodeIndex.size + branchCount;
  if (n === 0) return { empty: true, nodeIndex, branchOf, orderedNets, n: 0, driveEntries: activeDrives };
  return { empty: false, nodeIndex, branchOf, orderedNets, n, driveEntries: activeDrives };
}

/** 单步装配 + 求解 */
function solveInstant(entries, driveEntries, nodeIndex, branchOf, n, ctxOf, hasNonlinear, ctxOfInd) {
  const A = makeMatrix(n);
  const b = makeVector(n);

  const refsOf = (entry, limit) => {
    const refs = {
      pos: nodeIndex.has(entry.netPos) ? nodeIndex.get(entry.netPos) : -1,
      neg: nodeIndex.has(entry.netNeg) ? nodeIndex.get(entry.netNeg) : -1,
      br: branchOf.has(entry.comp.id) ? branchOf.get(entry.comp.id) : -1,
      size: n,
      limit,
      comp: entry.comp,
    };
    if (entry.multi) {
      refs.idx = {};
      refs.connected = {};
      entry.pins.forEach((pin) => {
        const net = entry.nets[pin];
        refs.idx[pin] = net && nodeIndex.has(net) ? nodeIndex.get(net) : -1;
        refs.connected[pin] = Boolean(net);
      });
    }
    return refs;
  };

  const stamp = (x, limit) => {
    A.fill(0);
    b.fill(0);
    entries.forEach((entry) => {
      const refs = refsOf(entry, limit);
      if (entry.multi) {
        const fn = entry.model.stampMulti || entry.model.stampLinear;
        if (typeof fn === 'function') fn(A, b, refs, entry.comp.params, x);
        return;
      }
      if (entry.model.id === 'capacitor') {
        entry.model.stampTransient(A, b, refs, entry.comp.params, ctxOf(entry));
      } else if (entry.model.id === 'inductor') {
        entry.model.stampTransient(A, b, refs, entry.comp.params, ctxOfInd(entry));
      } else if (entry.model.isNonlinear && typeof entry.model.stampNR === 'function') {
        entry.model.stampNR(A, b, refs, entry.comp.params, x);
      } else {
        entry.model.stampLinear(A, b, refs, entry.comp.params);
      }
    });
    driveEntries.forEach((entry) => {
      entry.model.stampLinear(A, b, refsOf(entry, limit), entry.comp.params);
    });
  };

  const iterate = (limit) => (x) => {
    stamp(x, limit);
    const F = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      let sum = 0;
      const row = i * n;
      for (let k = 0; k < n; k += 1) sum += A[row + k] * x[k];
      F[i] = sum - b[i];
    }
    return { F, J: A.slice() };
  };

  const start = makeVector(n);
  let solved;
  if (!hasNonlinear) {
    solved = newtonSolve(start, iterate(false), { maxIter: 4, tol: 1e-9, relax: 1 });
  } else {
    const first = newtonSolve(start, iterate(true), { maxIter: 60, tol: 1e-6, relax: 1 });
    if (!first.ok) return { ok: false, error: first.error || '不收敛', detail: first.reason };
    const polish = newtonSolve(first.x, iterate(false), { maxIter: 20, tol: 1e-9, relax: 1 });
    solved = {
      ok: polish.ok,
      x: polish.x,
      iter: first.iter + polish.iter,
      residual: polish.residual,
      error: polish.error,
    };
  }
  if (!solved || !solved.ok) {
    return {
      ok: false,
      error: solved && solved.reason === 'singular'
        ? '矩阵奇异（电路可能开路/短路）'
        : (solved ? solved.error : '不收敛'),
      detail: solved ? solved.reason : '',
    };
  }
  return { ok: true, x: solved.x, iter: solved.iter, residual: solved.residual };
}

/** 通道的驱动来源描述（面板展示用） */
function describeDriver(net, digital, sourceDrives, mixUnits = []) {
  const src = sourceDrives.find((d) => d.outNet === net);
  if (src) return src.comp.type === 'clock' ? '时钟' : src.comp.type === 'pulse' ? '脉冲' : '逻辑开关';
  for (const ui of digital.units) {
    if (ui.outputs.some((o) => o.net === net)) return ui.model.label || '数字输出';
  }
  for (const unit of mixUnits) {
    if (unit.kind === 'dac') continue;
    if (unit.outputs.some((o) => o.net === net)) return unit.spec.label;
  }
  // 模拟网：说清是谁驱动的（DAC 输出 / 比较器输出 / 普通节点）
  for (const unit of mixUnits) {
    if (unit.kind === 'dac' && unit.outputs.some((o) => o.net === net)) return 'DAC 输出';
  }
  return '模拟网';
}

/* ==========================================================================
   分帧运行器（7.5）：每帧算一小段，长 duration 不卡 UI
   ========================================================================== */

/**
 * 把多段暂态结果拼成一份（波形时间戳已经是绝对时刻，直接接）。
 * 拼完若超过单通道上限，再做一次均匀抽稀。
 */
export function mergeTransient(parts, opts = {}) {
  const list = parts.filter(Boolean);
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];

  const byNet = new Map();
  const channels = new Map();
  let steps = 0;
  let events = 0;
  let elapsedMs = 0;
  const tpEvents = [];
  const warnings = [];

  list.forEach((part) => {
    steps += part.stats ? part.stats.steps : 0;
    events += part.stats ? part.stats.events : 0;
    elapsedMs += part.stats ? part.stats.elapsedMs : 0;
    if (part.stats && Array.isArray(part.stats.tpEvents)) tpEvents.push(...part.stats.tpEvents);
    if (Array.isArray(part.warnings)) warnings.push(...part.warnings);
    (part.waveforms || []).forEach((wave) => {
      if (!byNet.has(wave.netId)) byNet.set(wave.netId, []);
      byNet.get(wave.netId).push(...wave.samples);
    });
    (part.channels || []).forEach((ch) => {
      const prev = channels.get(ch.netId);
      if (!prev) {
        channels.set(ch.netId, { ...ch });
      } else {
        prev.min = Math.min(prev.min, ch.min);
        prev.max = Math.max(prev.max, ch.max);
      }
    });
  });

  const waveforms = [];
  let maxMemory = 0;
  byNet.forEach((samples, netId) => {
    samples.sort((a, b) => a.t - b.t);
    const stride = Math.max(1, Math.ceil(samples.length / MAX_SAMPLES));
    const picked = [];
    for (let i = 0; i < samples.length; i += stride) picked.push(samples[i]);
    if (picked.length > 0 && picked[picked.length - 1] !== samples[samples.length - 1]) {
      picked.push(samples[samples.length - 1]);
    }
    maxMemory = Math.max(maxMemory, picked.length);
    waveforms.push({ netId, label: netId, samples: picked });
  });

  return {
    ok: true,
    error: null,
    warnings,
    waveforms,
    channels: [...channels.values()],
    ground: list[0].ground || null,
    groundReason: list[0].groundReason || '',
    stats: {
      steps,
      events,
      elapsedMs: Math.round(elapsedMs * 1000) / 1000,
      maxMemory,
      tpEvents,
      dt: opts.dt || (list[0].stats ? list[0].stats.dt : 0),
      duration: opts.duration || (list[0].stats ? list[0].stats.duration : 0),
      t0: list[0].stats ? list[0].stats.t0 : 0,
      chunks: list.length,
    },
  };
}

/**
 * 分帧跑一段暂态：每帧算一小段并回调进度/中间结果，可随时 stop()。
 *
 * @param {object} modelApi
 * @param {object} opts   { duration, dt }
 * @param {object} hooks  { onProgress(done,total), onChunk(merged), onDone(merged, cancelled), onError(result) }
 * @returns {{ ok:boolean, stop:()=>void, done:Promise<object> }}
 */
export function runTransient(modelApi, opts = {}, hooks = {}) {
  const duration = Number(opts.duration) || 0;
  const dt = Number(opts.dt) || DEFAULT_DT;
  if (!(duration > 0)) {
    const bad = { ok: false, error: '时长必须大于 0', warnings: [], waveforms: [], channels: [], stats: {} };
    if (hooks.onError) hooks.onError(bad);
    return { ok: false, stop: () => {}, done: Promise.resolve(bad) };
  }

  // 每帧一段：短电路 1 段就够，长电路约 40 段，保证单帧工作量可控
  const chunkSpan = Math.max(dt * 10, duration / 40);
  const chunks = [];
  let elapsed = 0;
  let cancelled = false;
  let timer = 0;
  let settle;

  const done = new Promise((resolve) => { settle = resolve; });

  let finished = false;
  const finish = (merged, wasCancelled) => {
    if (finished) return;   // stop() 与最后一段都可能触发，只收尾一次
    finished = true;
    if (hooks.onDone) hooks.onDone(merged, wasCancelled);
    settle(merged);
  };

  const step = () => {
    if (cancelled) {
      finish(mergeTransient(chunks, { duration, dt }), true);
      return;
    }
    const span = Math.min(chunkSpan, duration - elapsed);
    const part = solveTransient(modelApi, { duration: span, dt, t0: elapsed });
    if (!part.ok) {
      if (hooks.onError) hooks.onError(part);
      finish(part, false);
      return;
    }
    chunks.push(part);
    elapsed = Math.min(duration, elapsed + span);
    if (hooks.onProgress) hooks.onProgress(elapsed, duration);
    const merged = mergeTransient(chunks, { duration, dt });
    if (hooks.onChunk) hooks.onChunk(merged);
    if (elapsed >= duration - 1e-9) {
      if (hooks.onProgress) hooks.onProgress(duration, duration);
      finish(merged, false);
      return;
    }
    timer = setTimeout(step, 0);
  };

  timer = setTimeout(step, 0);

  return {
    ok: true,
    stop() {
      // 立刻收尾：把已算的段合并返回（波形冻结），并让 running() 立即变 false
      cancelled = true;
      if (timer) clearTimeout(timer);
      finish(mergeTransient(chunks, { duration, dt }), true);
    },
    done,
  };
}

/* ==========================================================================
   采样上限与文本格式
   ========================================================================== */

/** 供面板/测试用：把结果压成可读文本 */
export function transientReport(result) {
  if (!result) return '无暂态结果';
  const lines = [];
  if (!result.ok) {
    lines.push('暂态仿真 · 失败');
    lines.push(`  错误：${result.error}`);
    if (result.detail) lines.push(`  说明：${result.detail}`);
  } else {
    const s = result.stats || {};
    lines.push(`暂态仿真 · 完成（${s.duration}s / 步长 ${s.dt}s，${s.steps} 步，${s.events} 次源翻转）`);
    if (result.ground) lines.push(`  参考地：${result.ground}（${result.groundReason || '—'}）`);
  }
  if (result.warnings && result.warnings.length > 0) {
    lines.push('');
    result.warnings.forEach((w) => lines.push(`  · ${w}`));
  }
  return lines.join('\n');
}

/** 给测试用：找出某个通道在 [t0, t1] 内的电平翻转时刻（线性插值） */
export function findFlipTimes(waveform, fromLevel, toLevel, t0 = 0, t1 = Infinity) {
  const out = [];
  if (!waveform || !waveform.samples) return out;
  const samples = waveform.samples;
  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1];
    const b = samples[i];
    const la = levelFromVoltage(a.v, { vih: 2.5, vil: 0.8 });
    const lb = levelFromVoltage(b.v, { vih: 2.5, vil: 0.8 });
    if (la === fromLevel && lb === toLevel && a.t >= t0 && a.t <= t1) out.push(b.t);
  }
  return out;
}
