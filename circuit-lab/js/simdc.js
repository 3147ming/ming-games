/**
 * simdc.js — 直流工作点仿真引擎（DC Operating Point）
 *
 * 管道：model 网表 → 节点分配 → 参考地 → 接地可达性剪枝 → 短路检查
 *        → MNA 装配 → Newton-Raphson → 结构化结果
 *
 * 这一段的每个判断都对应一类真实故障，值得单独说明：
 *
 * 1. **只用「有元件端子」的网**。model 的网表把平台固有连通也并进来了，
 *    面包板上每条 5 孔竖列甚至每条电源轨都是 net。这些 net 没有元件端子，
 *    进方程只会制造一堆孤立未知量（矩阵奇异）。所以仿真侧先做一次过滤。
 *
 * 2. **接地可达性剪枝代替"奇异就报错"**。开关断开会把电路切成两半，
 *    这时若直接装配 MNA，属于悬空那一半的节点行全是 0，矩阵必然奇异。
 *    正确做法是先按"直流上导通"的元件做连通性分析，只把与地连通的网
 *    放进矩阵，其余标为悬空并告警——数学上等价，物理上也说得通。
 *
 * 3. **短路检查放在装配之前**。电源两端同网、两个电压源并联，
 *    这类结构装配出来一定奇异，事后报"开路"会误导用户。
 *
 * 4. **NR 分两段**。LED 的指数模型在 5V 附近每轮只挪 nVt≈46.5mV，
 *    60 多轮都爬不到工作点。第一段用结电压限制器把迭代拉进收敛域，
 *    第二段用纯净牛顿在解附近二次收敛到 1e-12。详见 devmodels.limitJunction。
 */

import {
  makeMatrix,
  makeVector,
  newtonSolve,
} from './solver.js';
import {
  getModel,
  needsBranch,
  conductsDC,
  validateParams,
  ledCurrent,
} from './devmodels.js';

/** 求解默认参数 */
const DEFAULTS = {
  tol: 1e-9,
  relax: 1,
  /**
   * 第一段（带限制器）的收敛阈值。故意比最终 tol 宽 ——
   * 这一段的唯一任务是把迭代拉进收敛域，精度交给第二段。
   * 限制器在小信号下会把迭代步长压到 0.3 倍，若在这里要求 1e-9，
   * 大电流工况要多爬十几轮（实测 10Ω 时从 12 轮涨到 24 轮）。
   */
  tolLimited: 1e-6,
  /** 第一段（带限制器）的最大轮数 */
  maxIterLimited: 60,
  /** 第二段（纯净牛顿）的最大轮数 */
  maxIterExact: 20,
};

/** 规模上限：超过说明用法有问题，与其算到天荒地老不如明确报错 */
const MAX_UNKNOWNS = 400;

/* ==========================================================================
   小工具
   ========================================================================== */

/** 并查集（只用于网 id 字符串） */
function createDsu() {
  const parent = new Map();
  const find = (key) => {
    if (!parent.has(key)) parent.set(key, key);
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root);
    let node = key;
    while (parent.get(node) !== node) {
      const next = parent.get(node);
      parent.set(node, root);
      node = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  return { find, union };
}

/** 三位小数（显示层精度；内部结果保持全精度） */
export function round3(value) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(3));
}

/** 电压显示：≥1V 用 3 位小数，小电压自动降档 */
export function formatVolt(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1) return `${value.toFixed(3)} V`;
  if (abs >= 1e-3) return `${(value * 1e3).toFixed(2)} mV`;
  if (abs >= 1e-6) return `${(value * 1e6).toFixed(2)} μV`;
  if (abs === 0) return '0.000 V';
  return `${value.toExponential(2)} V`;
}

/** 电流显示 */
export function formatAmp(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1) return `${value.toFixed(3)} A`;
  if (abs >= 1e-3) return `${(value * 1e3).toFixed(2)} mA`;
  if (abs >= 1e-6) return `${(value * 1e6).toFixed(2)} μA`;
  if (abs === 0) return '0.000 A';
  return `${value.toExponential(2)} A`;
}

/** 功率显示 */
export function formatWatt(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1) return `${value.toFixed(3)} W`;
  if (abs >= 1e-3) return `${(value * 1e3).toFixed(2)} mW`;
  if (abs >= 1e-6) return `${(value * 1e6).toFixed(2)} μW`;
  if (abs === 0) return '0.000 W';
  return `${value.toExponential(2)} W`;
}

/**
 * 残差显示。线性电路常常一步就到精确 0，此时写「0」比「0.00e+0」清楚；
 * 非线性收敛到 1e-16 量级时再切科学计数。
 */
export function formatResidual(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  if (num === 0) return '0';
  return num.toExponential(1);
}

/* ==========================================================================
   第一步：元件筛选与端子解析
   ========================================================================== */

/**
 * 把 state.components 翻译成"可参与方程的二端元件"。
 * 返回 { entries, warnings, errors }
 *   entry = { comp, model, netPos, netNeg, terminalPos, terminalNeg }
 *
 * 同时导出给 simtrans.js 复用（暂态每个步进都要走同一套筛选/选地/剪枝逻辑，
 * 抽出公共函数保持单源，避免两处实现漂移）。
 */
/** 元件接入的全部网（多端器件按 pins 顺序；两端器件就是 netPos/netNeg） */
export function entryNets(entry) {
  if (!entry) return [];
  if (entry.multi) return entry.pins.map((pin) => entry.nets[pin]).filter(Boolean);
  return [entry.netPos, entry.netNeg].filter(Boolean);
}

export function collectEntries(state, netOf) {
  const entries = [];
  const warnings = [];
  const errors = [];

  state.components.forEach((comp) => {
    const model = getModel(comp.type);
    if (!model) {
      errors.push(`元件缺电学模型：${comp.type}`);
      return;
    }
    if (model.skip) {
      warnings.push(`${comp.id}：${model.label || comp.type}，${model.reason}`);
      return;
    }

    const invalid = validateParams(comp.type, comp.params);
    if (invalid) {
      errors.push(`${comp.id}：${invalid}`);
      return;
    }

    // 多端器件（三极管/运放/继电器/拨码/电位器）：按端子名逐个解析网络
    if (model.pins.length > 2) {
      const nets = {};
      model.pins.forEach((pin) => {
        nets[pin] = netOf.get(`c:${comp.id}:${pin}`) || null;
      });
      const required = Array.isArray(model.requiredPins) ? model.requiredPins : model.pins;
      const missing = required.filter((pin) => !nets[pin]);
      if (missing.length > 0) {
        warnings.push(`${comp.id} 的 ${missing.join('、')} 端子未连接，已跳过`);
        return;
      }
      const connected = model.pins.filter((pin) => nets[pin]);
      if (connected.length < 2) {
        warnings.push(`${comp.id} 至少需要两个端子接入电路，已跳过`);
        return;
      }
      entries.push({
        comp,
        model,
        multi: true,
        pins: model.pins,
        nets,
        netPos: nets[model.pins[0]],
        netNeg: nets[model.pins[1]],
        pinPos: model.pins[0],
        pinNeg: model.pins[1],
      });
      return;
    }

    const [pinPos, pinNeg] = model.pins;
    const hasPos = comp.terminals.some((item) => item.name === pinPos);
    const hasNeg = comp.terminals.some((item) => item.name === pinNeg);
    if (!hasPos || !hasNeg) {
      warnings.push(`${comp.id} 缺少端子 ${hasPos ? pinNeg : pinPos}（模型与元件定义不一致），已跳过`);
      return;
    }

    const netPos = netOf.get(`c:${comp.id}:${pinPos}`) || null;
    const netNeg = netOf.get(`c:${comp.id}:${pinNeg}`) || null;
    if (!netPos || !netNeg) {
      const missing = [];
      if (!netPos) missing.push(pinPos);
      if (!netNeg) missing.push(pinNeg);
      warnings.push(`元件 ${comp.id} 的 ${missing.join('、')} 端子未连接，已跳过`);
      return;
    }

    entries.push({ comp, model, netPos, netNeg, pinPos, pinNeg });
  });

  return { entries, warnings, errors };
}

/* ==========================================================================
   第二步：参考地
   ========================================================================== */

/**
 * 选参考地（0V）。
 * 优先级：
 *   1. 第一个电压源的负端——这是电路图里最常见的"地把"，
 *      而且能让电源电压直接等于正端节点的读数，符合直觉；
 *   2. 端子数最多的网——没有电源时至少保证最大的那块网络有定义；
 *   3. 第一个网。
 */
export function chooseGround(entries) {
  const source = entries.find((entry) => entry.model.id === 'vsource');
  if (source) return { net: source.netNeg, why: `电压源 ${source.comp.id} 负端` };

  const counts = new Map();
  entries.forEach((entry) => {
    entryNets(entry).forEach((net) => {
      counts.set(net, (counts.get(net) || 0) + 1);
    });
  });
  let best = null;
  counts.forEach((count, net) => {
    if (!best || count > best.count) best = { net, count };
  });
  if (best) return { net: best.net, why: `端子最多的网（${best.count} 端）` };

  return { net: null, why: '无可用网' };
}

/* ==========================================================================
   第三步：短路检查
   ========================================================================== */

/** 给网起个可读名字：挂在上面的元件端子，最多三个 */
function describeNet(net, entries) {
  const names = [];
  entries.forEach((entry) => {
    if (entry.netPos === net) names.push(`${entry.comp.id}.${entry.pinPos}`);
    if (entry.netNeg === net) names.push(`${entry.comp.id}.${entry.pinNeg}`);
  });
  if (names.length === 0) return net;
  const head = names.slice(0, 3).join('、');
  return names.length > 3 ? `${head} 等 ${names.length} 端` : head;
}

/**
 * 短路检查：先只按「闭合的开关」建零欧姆连通域，再看电压源是否落在里面。
 *
 * 注意这里刻意**不把电压源本身并进连通域**——否则每个电压源的正负端
 * 天生同域，检查会对任何带电源的电路误报短路。
 * 两根电池并联属于另一类问题（支路电流不唯一），单独按"跨同一对连通域"判定。
 */
export function checkShorts(entries) {
  const dsu = createDsu();
  entries.forEach((entry) => {
    dsu.find(entry.netPos);
    dsu.find(entry.netNeg);
  });

  entries.forEach((entry) => {
    if (entry.model.id === 'switch' && entry.comp.params.state === 'closed') {
      dsu.union(entry.netPos, entry.netNeg);
    }
  });

  const sources = entries.filter((entry) => entry.model.id === 'vsource');

  for (const source of sources) {
    if (dsu.find(source.netPos) === dsu.find(source.netNeg)) {
      return {
        error: '电路短路：电源直连',
        detail: `${source.comp.id} 的正负端被导线或闭合开关直接短接`,
      };
    }
  }

  const byPair = new Map();
  for (const source of sources) {
    const a = dsu.find(source.netPos);
    const b = dsu.find(source.netNeg);
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(source);
  }
  for (const group of byPair.values()) {
    if (group.length > 1) {
      return {
        error: '电路短路：电压源并联冲突',
        detail: `${group.map((item) => item.comp.id).join('、')} 接在同一对节点上`,
      };
    }
  }

  return null;
}

/* ==========================================================================
   第四步：接地可达性
   ========================================================================== */

/**
 * 从参考地出发，沿"直流上导通"的元件做连通性扩散。
 * 返回与地连通的网集合。
 */
export function reachableFromGround(entries, ground, conducts = conductsDC) {
  const adjacency = new Map();
  const link = (a, b) => {
    if (!adjacency.has(a)) adjacency.set(a, []);
    adjacency.get(a).push(b);
  };

  entries.forEach((entry) => {
    if (!conducts(entry.comp.type, entry.comp.params)) return;
    if (entry.multi) {
      const pairs = typeof entry.model.conductsPairs === 'function'
        ? entry.model.conductsPairs(entry.comp.params)
        : [[entry.pins[0], entry.pins[1]]];
      pairs.forEach(([a, b]) => {
        const na = entry.nets[a];
        const nb = entry.nets[b];
        if (!na || !nb) return;
        link(na, nb);
        link(nb, na);
      });
      return;
    }
    link(entry.netPos, entry.netNeg);
    link(entry.netNeg, entry.netPos);
  });

  const seen = new Set();
  if (!ground) return seen;
  const stack = [ground];
  seen.add(ground);
  while (stack.length > 0) {
    const net = stack.pop();
    const next = adjacency.get(net) || [];
    next.forEach((item) => {
      if (seen.has(item)) return;
      seen.add(item);
      stack.push(item);
    });
  }
  return seen;
}

/* ==========================================================================
   第五步：装配 + 求解
   ========================================================================== */

function buildAndSolve(entries, ground, reachable, options) {
  const nodeIndex = new Map();
  let index = 0;
  const orderedNets = [];
  entries.forEach((entry) => {
    entryNets(entry).forEach((net) => {
      if (net === ground || nodeIndex.has(net) || !reachable.has(net)) return;
      nodeIndex.set(net, index);
      index += 1;
      orderedNets.push(net);
    });
  });

  const branchOf = new Map();
  let branchCount = 0;
  const active = entries.filter((entry) => entryNets(entry).every((net) => reachable.has(net)));
  active.forEach((entry) => {
    if (!needsBranch(entry.comp.type)) return;
    branchOf.set(entry.comp.id, nodeIndex.size + branchCount);
    branchCount += 1;
  });

  const n = nodeIndex.size + branchCount;
  if (n === 0) {
    return { empty: true, nodeIndex, branchOf, orderedNets, x: makeVector(0), iter: 0, residual: 0 };
  }
  if (n > MAX_UNKNOWNS) {
    return { error: `方程规模超限（${n} 个未知量，上限 ${MAX_UNKNOWNS}）` };
  }

  const A = makeMatrix(n);
  const b = makeVector(n);

  const stamp = (x, limit) => {
    A.fill(0);
    b.fill(0);
    active.forEach((entry) => {
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
        const fn = entry.model.stampMulti || entry.model.stampLinear;
        if (typeof fn === 'function') fn(A, b, refs, entry.comp.params, x);
        return;
      }
      if (entry.model.isNonlinear && typeof entry.model.stampNR === 'function') {
        entry.model.stampNR(A, b, refs, entry.comp.params, x);
      } else {
        entry.model.stampLinear(A, b, refs, entry.comp.params);
      }
    });
  };

  /** 生成一个 iterate(x)：装配 → 返回 (F, J)。J 是装配结果的一份快照 */
  const makeIterate = (limit) => (x) => {
    stamp(x, limit);
    return { F: residualOf(A, b, x, n), J: A.slice() };
  };

  const hasNonlinear = active.some((entry) => entry.model.isNonlinear);
  const start = makeVector(n);

  let solved;
  if (!hasNonlinear) {
    // 纯线性：一次求解即得精确解，第二轮步长为 0 判收敛
    solved = newtonSolve(start, makeIterate(false), {
      maxIter: 4,
      tol: options.tol,
      relax: options.relax,
    });
  } else {
    // 第一段：结电压限制器把迭代拉进收敛域（对指数模型是必需的）
    const first = newtonSolve(start, makeIterate(true), {
      maxIter: options.maxIterLimited,
      tol: options.tolLimited,
      relax: options.relax,
    });
    if (!first.ok) {
      solved = first;
    } else {
      // 第二段：关掉限制器，纯净牛顿在解附近二次收敛，消掉限制器带来的偏置
      const polish = newtonSolve(first.x, makeIterate(false), {
        maxIter: options.maxIterExact,
        tol: options.tol,
        relax: 1,
      });
      solved = {
        ok: polish.ok,
        x: polish.x,
        iter: first.iter + polish.iter,
        residual: polish.residual,
        reason: polish.reason,
        error: polish.error,
      };
    }
  }

  // 继电器这类"状态由解决定"的元件：解完后刷新状态，变了就带新触点重解（≤3 轮）
  if (solved && solved.ok) {
    const relays = active.filter((entry) => entry.model.id === 'relay');
    for (let pass = 0; pass < 3 && relays.length > 0; pass += 1) {
      const voltageOf = (net) => {
        if (net === ground) return 0;
        if (!nodeIndex.has(net)) return null;
        return solved.x[nodeIndex.get(net)];
      };
      let changed = false;
      relays.forEach((entry) => {
        if (entry.model.refreshState ? entry.model.refreshState(entry, voltageOf) : false) changed = true;
      });
      // 第 0 轮无论如何都带"按最终解刷新过的状态"重解一次：
      // 牛顿最后一轮 stamp 用的是上一迭代点（首轮还是 x=0），触点状态可能已过期。
      if (pass > 0 && !changed) break;
      const next = newtonSolve(solved.x, makeIterate(false), {
        maxIter: options.maxIterExact,
        tol: options.tol,
        relax: 1,
      });
      if (!next.ok) break;
      solved = { ...solved, ...next };
    }
  }

  return { empty: false, nodeIndex, branchOf, orderedNets, n, solved };
}

/** 残差 F = A·x − b */
function residualOf(A, b, x, n) {
  const F = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    const row = i * n;
    for (let k = 0; k < n; k += 1) sum += A[row + k] * x[k];
    F[i] = sum - b[i];
  }
  return F;
}

/* ==========================================================================
   对外：solveDC
   ========================================================================== */

/**
 * 对当前电路做直流工作点分析。
 * @param {object} modelApi 需要 { getState(), getNetlist() }
 * @param {object} [options] { tol, relax, maxIterLimited, maxIterExact }
 * @returns {object} 见文件头的输出结构说明
 */
export function solveDC(modelApi, options = {}) {
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const config = { ...DEFAULTS, ...options };

  const empty = (patch) => ({
    ok: true,
    error: null,
    warnings: [],
    convergence: { iter: 0, residual: 0 },
    nodeVoltages: [],
    elementResults: [],
    ground: null,
    groundReason: '',
    nodeCount: 0,
    branchCount: 0,
    elapsedMs: 0,
    ...patch,
  });

  if (!modelApi || typeof modelApi.getState !== 'function' || typeof modelApi.getNetlist !== 'function') {
    return empty({ ok: false, error: '仿真引擎缺少 model 接口' });
  }

  const state = modelApi.getState();
  if (!state) return empty({ ok: false, error: '电路尚未初始化' });

  if (!Array.isArray(state.components) || state.components.length === 0) {
    const done = empty({ warnings: ['电路为空，放几个元件再仿真'] });
    done.elapsedMs = elapsedSinceStart();
    return done;
  }

  const netlist = modelApi.getNetlist();
  const netOf = netlist && netlist.netOf ? netlist.netOf : new Map();

  const { entries, warnings, errors } = collectEntries(state, netOf);
  if (errors.length > 0) {
    const failed = empty({ ok: false, error: errors[0], warnings });
    failed.errors = errors;
    failed.elapsedMs = elapsedSinceStart();
    return failed;
  }
  if (entries.length === 0) {
    const done = empty({ warnings: warnings.concat('没有可参与直流分析的元件') });
    done.elapsedMs = elapsedSinceStart();
    return done;
  }

  const groundPick = chooseGround(entries);
  const ground = groundPick.net;
  const reachable = reachableFromGround(entries, ground);

  const shortCircuit = checkShorts(entries);
  if (shortCircuit) {
    const failed = empty({ ok: false, error: shortCircuit.error, warnings });
    failed.detail = shortCircuit.detail;
    failed.elapsedMs = elapsedSinceStart();
    return failed;
  }

  const built = buildAndSolve(entries, ground, reachable, config);
  if (built.error) {
    const failed = empty({ ok: false, error: built.error, warnings });
    failed.elapsedMs = elapsedSinceStart();
    return failed;
  }

  // 悬空网：有元件端子但接不到地
  const floating = [];
  const seenFloating = new Set();
  entries.forEach((entry) => {
    entryNets(entry).forEach((net) => {
      if (net === ground || reachable.has(net) || seenFloating.has(net)) return;
      seenFloating.add(net);
      floating.push(net);
    });
  });
  floating.forEach((net) => {
    warnings.push(`未接地网段（${describeNet(net, entries)}）电压不定`);
  });

  if (built.empty) {
    const done = empty({
      warnings: warnings.concat('电路里没有构成回路的元件'),
      ground,
      groundReason: groundPick.why,
    });
    done.elapsedMs = elapsedSinceStart();
    return done;
  }

  const { solved } = built;
  if (!solved || !solved.ok) {
    const reason = solved ? solved.reason : 'maxIter';
    const failed = empty({
      ok: false,
      error: reason === 'singular' ? '电路开路：存在未闭合回路' : '不收敛',
      warnings,
      ground,
      groundReason: groundPick.why,
      convergence: {
        iter: solved ? solved.iter : 0,
        residual: solved && Number.isFinite(solved.residual) ? solved.residual : null,
      },
    });
    failed.elapsedMs = elapsedSinceStart();
    return failed;
  }

  const { x } = solved;
  const voltageOf = (net) => {
    if (net === ground) return 0;
    if (!built.nodeIndex.has(net)) return null;
    return x[built.nodeIndex.get(net)];
  };

  /* ---- 节点电压 ---- */
  const nodeVoltages = [];
  nodeVoltages.push({ netId: ground, v: 0, grounded: true, floating: false });
  built.orderedNets.forEach((net) => {
    nodeVoltages.push({ netId: net, v: voltageOf(net), grounded: false, floating: false });
  });
  floating.forEach((net) => {
    nodeVoltages.push({ netId: net, v: null, grounded: false, floating: true });
  });

  /* ---- 元件结果 ---- */
  const elementResults = entries.map((entry) => {
    const vp = voltageOf(entry.netPos);
    const vn = voltageOf(entry.netNeg);
    const known = vp !== null && vn !== null;
    const v = known ? vp - vn : null;
    const model = entry.model;
    let current = null;

    // 多端/自定义结果：模型自己给出 v/i/note（三极管报 Vce/Ic，运放报摆幅…）
    if (typeof model.resultOf === 'function') {
      const own = model.resultOf(entry, (net) => voltageOf(net), x, built.branchOf) || {};
      const note = own.note || '';
      return {
        componentId: entry.comp.id,
        type: entry.comp.type,
        label: model.label,
        v: own.v === undefined ? v : own.v,
        i: own.i === undefined ? null : own.i,
        power: own.v !== undefined && own.i !== undefined && own.v !== null && own.i !== null
          ? own.v * own.i
          : null,
        note,
        extra: own,
      };
    }

    if (known) {
      if (model.id === 'resistor') current = v / Number(entry.comp.params.resistance);
      else if (model.id === 'led') current = ledCurrent(v);
      else if (model.id === 'switch') current = entry.comp.params.state === 'closed' ? v * 1e6 : 0;
      else if (model.id === 'capacitor') current = 0;
      else if (model.id === 'isource') current = Number(entry.comp.params.current);
      else if (model.id === 'vsource') {
        const br = built.branchOf.get(entry.comp.id);
        current = br === undefined ? 0 : x[br];
      }
    }

    let note = '';
    if (model.id === 'capacitor') note = '直流开路';
    else if (model.id === 'switch') note = entry.comp.params.state === 'closed' ? '闭合' : '断开';
    else if (model.id === 'led' && known && v <= 0) note = '反向截止';

    return {
      componentId: entry.comp.id,
      type: entry.comp.type,
      label: model.label,
      v,
      i: current,
      power: known && current !== null ? v * current : null,
      note,
    };
  });

  const hasSource = entries.some((entry) => entry.model.id === 'vsource' || entry.model.id === 'isource');
  if (!hasSource) warnings.push('电路里没有电源，所有电压为 0');

  const result = empty({
    warnings,
    convergence: { iter: solved.iter, residual: solved.residual },
    nodeVoltages,
    elementResults,
    ground,
    groundReason: groundPick.why,
    nodeCount: built.nodeIndex.size,
    branchCount: built.branchOf.size,
    floating,
    hasNonlinear: entries.some((entry) => entry.model.isNonlinear),
  });
  result.elapsedMs = elapsedSinceStart();
  return result;

  function elapsedSinceStart() {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return Math.round((now - started) * 1000) / 1000;
  }
}

/* ==========================================================================
   对外：reportFormat
   ========================================================================== */

/**
 * 把结果格式化成文本（结果面板以外的地方也能用：导出报告、控制台排查）。
 */
export function reportFormat(result) {
  if (!result) return '无仿真结果';
  const lines = [];

  if (!result.ok) {
    lines.push(`直流工作点 · 失败`);
    lines.push(`  错误：${result.error}`);
    if (result.detail) lines.push(`  说明：${result.detail}`);
  } else if (result.nodeVoltages.length === 0 && result.elementResults.length === 0) {
    lines.push('直流工作点 · 无可分析电路');
  } else {
    const iter = result.convergence ? result.convergence.iter : 0;
    const residual = result.convergence ? result.convergence.residual : 0;
    lines.push(`直流工作点 · 收敛（迭代 ${iter} 次，残差 ${formatResidual(residual)}）`);
    lines.push(`  参考地：${result.ground || '无'}（${result.groundReason || '—'}）`);
  }

  if (result.nodeVoltages && result.nodeVoltages.length > 0) {
    lines.push('');
    lines.push('节点电压');
    result.nodeVoltages.forEach((node) => {
      const tag = node.grounded ? '  地' : (node.floating ? '  悬空' : '');
      lines.push(`  ${node.netId.padEnd(8, ' ')} ${formatVolt(node.v)}${tag}`);
    });
  }

  if (result.elementResults && result.elementResults.length > 0) {
    lines.push('');
    lines.push('元件结果');
    result.elementResults.forEach((item) => {
      const bits = [
        `${item.componentId}`.padEnd(12, ' '),
        `V ${formatVolt(item.v)}`.padEnd(14, ' '),
        `I ${formatAmp(item.i)}`.padEnd(16, ' '),
        `P ${formatWatt(item.power)}`,
      ];
      const note = item.note ? `  （${item.note}）` : '';
      lines.push(`  ${bits.join(' ')}${note}`);
    });
  }

  if (result.warnings && result.warnings.length > 0) {
    lines.push('');
    lines.push('提示');
    result.warnings.forEach((text) => lines.push(`  · ${text}`));
  }

  return lines.join('\n');
}
