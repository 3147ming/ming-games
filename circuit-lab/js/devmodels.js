/**
 * devmodels.js — 元件电学模型注册表
 *
 * 与 parts.js 的分工：
 *   parts.js   管"长什么样"——外观、占位、端子位置；
 *   本文件     管"电气上是什么"——导纳 / 源 / 非线性 I(V)。
 *   两者靠 `type` 对齐：parts.js 里有的类型，这里必须有模型或显式标记 skip。
 *   覆盖关系由 tools/test-model.mjs 断言锁定，不靠人工记忆。
 *
 * 模型接口（统一四件套）：
 *   pins        ['第一端', '第二端']，名字必须与 parts.js 的 terminals 一致
 *   isNonlinear 是否需要在 NR 每一轮重建
 *   conducts(params)      直流上是否导通（供 simdc 做接地可达性剪枝）
 *   validate(params)      参数合法性，返回错误文案或 null
 *   stampLinear(A, b, refs, params)      线性贡献；非线性元件也用它做初值
 *   stampNR(A, b, refs, params, x)       在当前迭代点 x 上的切线（F/J）贡献
 *
 * refs 结构（由 simdc 装配）：
 *   { pos, neg, br, size, comp }
 *   pos/neg 为节点下标，-1 表示该端接地（接地端不占行列）
 *   br 为该元件的支路电流未知量下标（仅电压源需要），-1 表示没有
 *   size 为当前矩阵维度，stamp 辅助函数需要它做越界保护
 *
 * MNA 符号约定（全文件统一，改动前请先读这段）：
 *   - 节点方程按「流出节点的电流之和 = 0」建立，等价于 G·v = i_injected
 *   - 电导 g 接在 p、n 之间：stampConductance 写 4 个位置
 *   - 电流源 I 从 p 经元件内部流向 n：b[p] -= I，b[n] += I
 *   - 电压源支路电流 i 定义为「从 + 端流入、从 − 端流出」：
 *     b[br] = V，因此 V 源输出功率时 i < 0
 */

import { stampAdd, stampConductance, stampRhs } from './solver.js';

/* ==========================================================================
   物理常数
   ========================================================================== */

/** 热电压 @25℃（kT/q） */
export const VT_25C = 0.02585;

/**
 * LED 发射系数（理想因子）。
 *
 * 取 1.0 = 理想二极管。与 Is=1e-14 组合后，mA 级电流下压降落在 0.66~0.81V，
 * 对应指令包「LED 压降 ≈ 0.7V」的硬标准（5V/220Ω → 0.728V @ 16.8mA）。
 *
 * 想改成"真实红光 LED 手感"（20mA 时约 1.9V）把这里调到 2.6；
 * 指令包原文给的 1.8 与 Is=1e-14 组合会得到 1.31V——既不是 0.7V 也不是真实 LED 的 1.9V，
 * 属于文档内部两个数字（0.7V 与 n=1.8）互相矛盾，这里按可验证的 0.7V 对齐。
 */
export const LED_N = 1.0;

/** LED 反向饱和电流（A），1e-14 对应小功率 LED 的量级 */
export const LED_IS = 1e-14;

/** LED 的等效热电压 n·Vt */
export const LED_VT = LED_N * VT_25C;

/**
 * 导通临界电压 vcrit：二极管电流等于「切线电流」的那个点。
 * vcrit = nVt · ln( nVt / (√2 · Is) )
 * 高于此点后指数项过陡，必须做电压限制（见 limitJunction）。
 */
export const LED_VCRIT = LED_VT * Math.log(LED_VT / (Math.SQRT2 * LED_IS));

/** 开关闭合时的导通电阻（Ω）。1μΩ 对 1Ω~1MΩ 的电路相对误差 ≤ 1e-6 */
export const SWITCH_RON = 1e-6;

/** exp() 参数上限，防止 Math.exp 溢出成 Infinity（700 已远超物理量程） */
const EXP_LIMIT = 700;

/* ==========================================================================
   LED 的非线性处理
   ========================================================================== */

/**
 * 结电压限制器（对应 SPICE 的 pnjlim，但改为无状态版本）。
 *
 * 为什么需要它：指数模型的斜率是 I/nVt，在 5V 附近牛顿步长被死死限制在
 * 一个 nVt（≈25.9mV）上——从 5V 爬到 0.73V 要 150 多轮，远超 20 轮预算。
 * 限制器的做法是：把「比较点」沿对数轴压缩，
 *   vlim = vcrit + nVt·ln(1 + (vd - vcrit)/nVt)      (vd > vcrit)
 * 于是第一轮就能从 5V 直接落到 0.86V 附近，约 9 轮收敛。
 *
 * 无状态的代价：若工作点本身就在 vcrit 以上（大电流），限制器会一直生效，
 * 迭代不动点不再是真解。所以 simdc 的求解分两段：先用限制器求全局收敛，
 * 再用纯净牛顿从该点精修——第二段在解附近二次收敛，3~4 轮即到 1e-12。
 */
export function limitJunction(vd, vt = LED_VT, vcrit) {
  const vc = typeof vcrit === 'number'
    ? vcrit
    : vt * Math.log(vt / (Math.SQRT2 * LED_IS));
  if (!Number.isFinite(vd) || vd <= vc) return vd;
  return vc + vt * Math.log(1 + (vd - vc) / vt);
}

/** LED 电流 I(Vd) = Is·(e^(Vd/nVt) − 1) */
export function ledCurrent(vd, is = LED_IS, vt = LED_VT) {
  const arg = Math.min(vd / vt, EXP_LIMIT);
  return is * (Math.exp(arg) - 1);
}

/** LED 微分电导 dI/dV */
export function ledConductance(vd, is = LED_IS, vt = LED_VT) {
  const arg = Math.min(vd / vt, EXP_LIMIT);
  return (is / vt) * Math.exp(arg);
}

/** 给定电流下的正向压降（反解指数式，供测试与装配参考） */
export function ledVoltageAt(current, is = LED_IS, vt = LED_VT) {
  const ratio = Math.abs(current) / is;
  if (!(ratio > 0)) return -Infinity;
  return vt * Math.log(ratio + 1);
}

/* ==========================================================================
   模型定义
   ========================================================================== */

/** 电阻：欧姆定律 G = 1/R */
const resistorModel = {
  id: 'resistor',
  label: '电阻',
  pins: ['1', '2'],
  isNonlinear: false,
  conducts: () => true,
  validate(params) {
    const r = Number(params.resistance);
    if (!Number.isFinite(r) || r <= 0) return '电阻值必须为正';
    return null;
  },
  stampLinear(A, b, refs, params) {
    const g = 1 / Number(params.resistance);
    stampConductance(A, refs.size, refs.pos, refs.neg, g);
  },
};

/**
 * LED：指数模型（理想二极管 + 串联体电阻的近似）
 * I = Is·(e^(Vd/nVt) − 1)，n = 1.0，Is = 1e-14 A @25℃
 * → mA 级电流下压降 0.66~0.81V（5V/220Ω 为 0.731V）
 *
 * 选指数模型而不是 0.7V 分片线性的理由：压降随电流连续变化，
 * 换电阻值不用改阈值；代价是必须处理硬非线性（见 limitJunction）。
 */
const ledModel = {
  id: 'led',
  label: 'LED',
  pins: ['A', 'K'],
  isNonlinear: true,
  conducts: () => true,
  validate(params) {
    if (params && params.model && !LED_MODELS[params.model]) return `未知 LED 型号：${params.model}`;
    return null;
  },
  /** 线性化：取 0.7V 偏置处的切线。仅用于需要纯线性初值的场合（求解走 stampNR） */
  stampLinear(A, b, refs, params) {
    const spec = ledSpec(params);
    const vt = spec.n * VT_25C;
    const vf = 0.7;
    const g = ledConductance(vf, spec.is, vt);
    const ieq = ledCurrent(vf, spec.is, vt) - g * vf;
    stampConductance(A, refs.size, refs.pos, refs.neg, g);
    stampRhs(b, refs.size, refs.pos, -ieq);
    stampRhs(b, refs.size, refs.neg, ieq);
  },
  /** 在当前迭代点做切线：g 并联一个等效电流源。refs.limit === false 时关闭结电压限制器 */
  stampNR(A, b, refs, params, x) {
    const spec = ledSpec(params);
    const vt = spec.n * VT_25C;
    const vp = refs.pos < 0 ? 0 : x[refs.pos];
    const vn = refs.neg < 0 ? 0 : x[refs.neg];
    const vd = vp - vn;
    const used = refs.limit === false ? vd : limitJunction(vd, vt);
    const i0 = ledCurrent(used, spec.is, vt);
    const g = ledConductance(used, spec.is, vt);
    // 切线形式 I ≈ i0 + g·(v − used)，改写成「电导 g + 电流源 ieq」
    const ieq = i0 - g * used;
    stampConductance(A, refs.size, refs.pos, refs.neg, g);
    stampRhs(b, refs.size, refs.pos, -ieq);
    stampRhs(b, refs.size, refs.neg, ieq);
  },
  resultOf(entry, voltageOf) {
    const v = voltageOf(entry.netPos) - voltageOf(entry.netNeg);
    const spec = ledSpec(entry.comp.params);
    const vt = spec.n * VT_25C;
    return {
      v,
      i: ledCurrent(v, spec.is, vt),
      note: v <= 0 ? '反向截止' : '',
    };
  },
};

/**
 * 开关：闭合 = 1μΩ 导通电阻（不接理想 0V 源，避免两个开关并联时
 * 出现"支路电流不唯一"的奇异结构）；断开 = 完全不参与方程。
 */
const switchModel = {
  id: 'switch',
  label: '开关',
  pins: ['COM', 'NO'],
  isNonlinear: false,
  conducts: (params) => params.state === 'closed',
  validate(params) {
    if (params.state !== 'closed' && params.state !== 'open') return '开关状态非法';
    return null;
  },
  stampLinear(A, b, refs, params) {
    if (params.state !== 'closed') return;
    stampConductance(A, refs.size, refs.pos, refs.neg, 1 / SWITCH_RON);
  },
};

/** 电容：直流开路——不进方程，但结果里仍报两端电压与「直流开路」标注 */
const capacitorModel = {
  id: 'capacitor',
  label: '电容',
  pins: ['1', '2'],
  isNonlinear: false,
  conducts: () => false,
  /**
   * 暂态下电容是有记忆的导通元件（能传导电流），
   * 供 simtrans 的接地可达性剪枝用；直流剪枝仍走 conducts()。
   */
  conductsTransient: () => true,
  validate() {
    return null;
  },
  stampLinear() {
    // 直流下理想电容 = 开路，不 stamp 任何东西
  },
  /**
   * 暂态伴随模型（梯形积分 + 首步后向欧拉启动）。
   *
   * 梯形格式：i[k] = (2C/dt)·(v[k] − v[k−1]) − i[k−1] = G·v[k] − I0
   *   G = 2C/dt，I0 = G·v[k−1] + i[k−1]
   * 首步没有可信的 i[0]，改用后向欧拉（G = C/dt、I0 = G·v[0]）起步，
   * 之后全程梯形。选型实测见 simtrans.js 文件头注释。
   *
   * ctx = { dt, vPrev, iPrev, startup }
   */
  stampTransient(A, b, refs, params, ctx) {
    const c = capacitanceOf(params);
    const pair = transientCompanion(c, ctx);
    stampConductance(A, refs.size, refs.pos, refs.neg, pair.g);
    // 常数项等效电流源 I0 从 n 端流向 p 端（见文件头 MNA 符号约定）
    stampRhs(b, refs.size, refs.pos, pair.i0);
    stampRhs(b, refs.size, refs.neg, -pair.i0);
  },
  note: () => '直流开路',
};

/** 读容值（存储单位 F；非法/缺省按 0 处理，调用方负责告警） */
export function capacitanceOf(params) {
  const c = Number(params && params.capacitance);
  return Number.isFinite(c) && c > 0 ? c : 0;
}

/**
 * 电容伴随模型系数。
 * @param {number} c 容值（F）
 * @param {{dt:number, vPrev:number, iPrev:number, startup?:boolean}} ctx
 * @returns {{g:number, i0:number}}  i = g·v − i0
 */
export function transientCompanion(c, ctx) {
  const dt = Number(ctx && ctx.dt);
  const vPrev = Number(ctx && ctx.vPrev) || 0;
  const iPrev = Number(ctx && ctx.iPrev) || 0;
  if (!(dt > 0) || !(c > 0)) return { g: 0, i0: 0 };
  if (ctx && ctx.startup) {
    // 首步：后向欧拉 G = C/dt，I0 = G·vPrev（不需要 iPrev）
    const g = c / dt;
    return { g, i0: g * vPrev };
  }
  const g = (2 * c) / dt;
  return { g, i0: g * vPrev + iPrev };
}

/** 由解出的 v 反推本步电容电流：i = g·v − i0 */
export function transientCurrent(pair, v) {
  return pair.g * v - pair.i0;
}

/** 理想电压源：MNA 增广一行一列，引入支路电流未知量 */
const vsourceModel = {
  id: 'vsource',
  label: '电压源',
  pins: ['+', '-'],
  isNonlinear: false,
  needsBranch: true,
  conducts: () => true,
  validate(params) {
    if (!Number.isFinite(Number(params.voltage))) return '电压源电压值非法';
    return null;
  },
  stampLinear(A, b, refs, params) {
    const v = Number(params.voltage);
    const { pos, neg, br, size } = refs;
    if (br < 0) return;
    // 节点方程：电流 i 从 + 流入、从 − 流出
    stampAdd(A, size, pos, br, 1);
    stampAdd(A, size, neg, br, -1);
    // 支路方程：v(+) − v(−) = V
    stampAdd(A, size, br, pos, 1);
    stampAdd(A, size, br, neg, -1);
    stampRhs(b, size, br, v);
  },
};

/** 理想电流源：电流从 + 经元件内部流向 − */
const isourceModel = {
  id: 'isource',
  label: '电流源',
  pins: ['+', '-'],
  isNonlinear: false,
  conducts: () => true,
  validate(params) {
    if (!Number.isFinite(Number(params.current))) return '电流源电流值非法';
    return null;
  },
  stampLinear(A, b, refs, params) {
    const i = Number(params.current);
    stampRhs(b, refs.size, refs.pos, -i);
    stampRhs(b, refs.size, refs.neg, i);
  },
};

/**
 * 74 系列：数字器件，直流工作点无意义。
 * 显式标为 skip 而不是"缺模型"——缺模型是错误（说明有人加了元件忘了写模型），
 * skip 是本包已知的、有意留空的分工。
 */
const ic74xxModel = {
  id: 'ic74xx',
  label: '74 系列芯片',
  skip: true,
  reason: '数字元件，包 6 处理',
};

/* ==========================================================================
   指令包 9：半导体 / 动态 / 机电元件
   ========================================================================== */

/** 二极管型号表（Is、n 由「10mA 时 Vf」反解，见报告型号映射表） */
export const DIODE_MODELS = {
  // n 由「4.3mA 与 10mA 两点的 Vf 都落在 0.68–0.72V」反解（见报告型号映射表）
  '1N4148': { label: '1N4148', is: 2.45e-9, n: 1.83, vf: 0.70, vr: 100 },
  '1N4007': { label: '1N4007', is: 2.00e-9, n: 1.83, vf: 0.70, vr: 1000 },
};

/** 取二极管型号参数（未知型号回落到 1N4148） */
export function diodeSpec(params) {
  const key = params && params.model;
  return DIODE_MODELS[key] || DIODE_MODELS['1N4148'];
}

/** 通用 PN 结电流（二极管/稳压管/三极管共用同一套指数公式） */
export function junctionCurrent(vd, is, vt) {
  const arg = Math.min(vd / vt, EXP_LIMIT);
  return is * (Math.exp(arg) - 1);
}

/** 通用 PN 结微分电导 */
export function junctionConductance(vd, is, vt) {
  const arg = Math.min(vd / vt, EXP_LIMIT);
  return (is / vt) * Math.exp(arg);
}

/** 结电压限制器（通用版，供三极管/稳压管用） */
export function limitJunctionV(vd, vt) {
  const vcrit = vt * Math.log(vt / (Math.SQRT2 * 1e-14));
  if (!Number.isFinite(vd) || vd <= vcrit) return vd;
  return vcrit + vt * Math.log(1 + (vd - vcrit) / vt);
}

/**
 * 二极管：指数模型（1N4148 / 1N4007）。
 * 反向 5V 时电流 ≈ −Is（nA 级），满足「反向 <1µA」。
 */
const diodeModel = {
  id: 'diode',
  label: '二极管',
  pins: ['A', 'K'],
  isNonlinear: true,
  conducts: () => true,
  validate(params) {
    if (params && params.model && !DIODE_MODELS[params.model]) return `未知二极管型号：${params.model}`;
    return null;
  },
  stampLinear(A, b, refs, params) {
    const spec = diodeSpec(params);
    const vt = spec.n * VT_25C;
    const vf = 0.7;
    const g = junctionConductance(vf, spec.is, vt);
    const ieq = junctionCurrent(vf, spec.is, vt) - g * vf;
    stampConductance(A, refs.size, refs.pos, refs.neg, g);
    stampRhs(b, refs.size, refs.pos, -ieq);
    stampRhs(b, refs.size, refs.neg, ieq);
  },
  stampNR(A, b, refs, params, x) {
    const spec = diodeSpec(params);
    const vt = spec.n * VT_25C;
    const vp = refs.pos < 0 ? 0 : x[refs.pos];
    const vn = refs.neg < 0 ? 0 : x[refs.neg];
    const vd = vp - vn;
    const used = refs.limit === false ? vd : limitJunctionV(vd, vt);
    const i0 = junctionCurrent(used, spec.is, vt);
    const g = junctionConductance(used, spec.is, vt);
    const ieq = i0 - g * used;
    stampConductance(A, refs.size, refs.pos, refs.neg, g);
    stampRhs(b, refs.size, refs.pos, -ieq);
    stampRhs(b, refs.size, refs.neg, ieq);
  },
  resultOf(entry, voltageOf) {
    const v = voltageOf(entry.netPos) - voltageOf(entry.netNeg);
    const spec = diodeSpec(entry.comp.params);
    const vt = spec.n * VT_25C;
    return {
      v,
      i: junctionCurrent(v, spec.is, vt),
      note: v < -1 ? '反向截止' : '',
    };
  },
};

/**
 * 稳压管：正向同二极管，反向在 −Vz 附近雪崩击穿。
 * 反向电流用第二个指数项：
 *   I = Is·(e^(V/nVt) − 1) − Isz·(e^(−(V+Vz)/nzVt) − 1)
 * Isz 由「击穿后 0.1V 处约 1mA」定标，膝点足够陡又不至于在 Vz 以下漏电。
 */
export const ZENER_ISZ = 2.1e-5;
export const ZENER_NZ = 1.0;

/** 稳压管电流（v 为 A−K 电压；反向击穿时 v < 0） */
export function zenerCurrent(v, vz, spec = DIODE_MODELS['1N4148']) {
  const vt = spec.n * VT_25C;
  const fwd = junctionCurrent(v, spec.is, vt);
  const nzVt = ZENER_NZ * VT_25C;
  const arg = Math.min(-(v + vz) / nzVt, EXP_LIMIT);
  const rev = ZENER_ISZ * (Math.exp(arg) - 1);
  return fwd - rev;
}

/** 稳压管微分电导 */
export function zenerConductance(v, vz, spec = DIODE_MODELS['1N4148']) {
  const vt = spec.n * VT_25C;
  const gF = junctionConductance(v, spec.is, vt);
  const nzVt = ZENER_NZ * VT_25C;
  const arg = Math.min(-(v + vz) / nzVt, EXP_LIMIT);
  const gR = (ZENER_ISZ / nzVt) * Math.exp(arg);
  return gF + gR;
}

const zenerModel = {
  id: 'zener',
  label: '稳压管',
  pins: ['A', 'K'],
  isNonlinear: true,
  conducts: () => true,
  validate(params) {
    const vz = Number(params && params.vz);
    if (!Number.isFinite(vz) || vz <= 0) return '稳压值必须为正';
    return null;
  },
  stampLinear(A, b, refs, params) {
    const vz = Number(params.vz);
    const v = -vz;
    const g = zenerConductance(v, vz);
    const ieq = zenerCurrent(v, vz) - g * v;
    stampConductance(A, refs.size, refs.pos, refs.neg, g);
    stampRhs(b, refs.size, refs.pos, -ieq);
    stampRhs(b, refs.size, refs.neg, ieq);
  },
  stampNR(A, b, refs, params, x) {
    const vz = Number(params.vz);
    const vp = refs.pos < 0 ? 0 : x[refs.pos];
    const vn = refs.neg < 0 ? 0 : x[refs.neg];
    let v = vp - vn;
    if (refs.limit !== false) {
      // 正向按普通 PN 结限幅；反向要绕 −Vz 展开（把「超出击穿电压的量」当自变量），
      // 否则会把 9V 直接限到 −0.73V，永远进不了击穿区。
      const vt = VT_25C;
      if (v >= 0) {
        v = limitJunctionV(v, vt);
      } else {
        const excess = -(v + vz);
        if (excess > 0) {
          const lim = limitJunctionV(excess, ZENER_NZ * VT_25C);
          v = -(vz + lim);
        }
      }
    }
    const g = zenerConductance(v, vz);
    const ieq = zenerCurrent(v, vz) - g * v;
    stampConductance(A, refs.size, refs.pos, refs.neg, g);
    stampRhs(b, refs.size, refs.pos, -ieq);
    stampRhs(b, refs.size, refs.neg, ieq);
  },
  resultOf(entry, voltageOf) {
    const v = voltageOf(entry.netPos) - voltageOf(entry.netNeg);
    const vz = Number(entry.comp.params.vz);
    const i = zenerCurrent(v, vz);
    let note = '';
    if (i < -1e-3) note = `击穿稳压 ${(-v).toFixed(2)}V`;
    else if (v < -1) note = '未击穿（反向截止）';
    return { v, i, note };
  },
};

/**
 * LED 型号表（指令包 9 四色）。
 * 发射系数由「10mA 时的目标 Vf」反解：n = Vf / (Vt·ln(10mA/Is))。
 * 默认仍是 ideal（0.7V），保证包 5/6 的既有断言不回归；
 * 学生要在参数面板选 red/green/yellow/blue 才切到真实压降。
 */
export const LED_MODELS = {
  ideal: { label: '理想 0.7V', n: 1.0, is: 1e-14 },
  // n = Vf / (Vt·ln(10mA/1e-14)) = Vf / 0.7142（10mA 处正好落在标称压降）
  red: { label: '红色 2.0V', n: 2.80, is: 1e-14 },
  green: { label: '绿色 2.2V', n: 3.08, is: 1e-14 },
  yellow: { label: '黄色 2.0V', n: 2.80, is: 1e-14 },
  blue: { label: '蓝色 3.0V', n: 4.20, is: 1e-14 },
};

/** 取 LED 电学型号（未知回落 ideal） */
export function ledSpec(params) {
  const key = params && params.model;
  return LED_MODELS[key] || LED_MODELS.ideal;
}

/**
 * 三极管：Ebers-Moll 简化（活性区 Ic=βIb、饱和区由 BC 结自然给出、
 * 截止区指数衰减）。不做高频小信号。
 */
export const TRANSISTOR_MODELS = {
  '2N2222': { label: '2N2222 (NPN)', polarity: 'npn', beta: 100, is: 1e-14, alphaR: 0.12 },
  '2N3906': { label: '2N3906 (PNP)', polarity: 'pnp', beta: 100, is: 1e-14, alphaR: 0.12 },
};

export function transistorSpec(params) {
  const key = params && params.model;
  return TRANSISTOR_MODELS[key] || TRANSISTOR_MODELS['2N2222'];
}

const transistorModel = {
  id: 'transistor',
  label: '三极管',
  pins: ['B', 'C', 'E'],
  requiredPins: ['B', 'C', 'E'],
  isNonlinear: true,
  conducts: () => true,
  // 接地可达性剪枝用：B-E 结与 C-E 通路（饱和时导通）
  conductsPairs: () => [['B', 'E'], ['C', 'E']],
  validate(params) {
    const spec = transistorSpec(params);
    if (!spec) return '未知三极管型号';
    const beta = Number(params && params.beta);
    if (params && params.beta !== undefined && (!Number.isFinite(beta) || beta <= 1)) return 'β 必须大于 1';
    return null;
  },
  stampLinear() { /* 非线性元件：初值由 stampMultiNR 在 x=0 处给出 */ },
  stampMulti(A, b, refs, params, x) {
    const spec = transistorSpec(params);
    const beta = Number(params && params.beta) > 1 ? Number(params.beta) : spec.beta;
    const alphaF = beta / (beta + 1);
    const alphaR = spec.alphaR;
    const pol = spec.polarity === 'pnp' ? -1 : 1;
    const iB = refs.idx.B;
    const iC = refs.idx.C;
    const iE = refs.idx.E;
    // idx=-1 表示该端子接地（合法），stampAdd/stampConductance 会自动跳过该行列；
    // 只有三个端子全都落空才是真的没接（collectEntries 已按 requiredPins 拦过）
    if (iB < 0 && iC < 0 && iE < 0) return;
    const V = (i) => (i < 0 ? 0 : x[i]);
    const vt = VT_25C;
    const vbe = pol * (V(iB) - V(iE));
    const vbc = pol * (V(iB) - V(iC));
    const lim = refs.limit === false ? null : 1;
    const vbeUsed = lim ? limitJunctionV(vbe, vt) : vbe;
    const vbcUsed = lim ? limitJunctionV(vbc, vt) : vbc;
    const If = junctionCurrent(vbeUsed, spec.is, vt);
    const Ir = junctionCurrent(vbcUsed, spec.is, vt);
    const gF = junctionConductance(vbeUsed, spec.is, vt);
    const gR = junctionConductance(vbcUsed, spec.is, vt);
    const eqF = If - gF * vbeUsed;
    const eqR = Ir - gR * vbcUsed;
    const size = refs.size;

    // 电导矩阵（NPN/PNP 相同：PN 结的小信号电导恒为正）
    stampAdd(A, size, iB, iB, (1 - alphaF) * gF + (1 - alphaR) * gR);
    stampAdd(A, size, iB, iE, -(1 - alphaF) * gF);
    stampAdd(A, size, iB, iC, -(1 - alphaR) * gR);
    stampAdd(A, size, iC, iB, alphaF * gF - gR);
    stampAdd(A, size, iC, iE, -alphaF * gF);
    stampAdd(A, size, iC, iC, gR);
    stampAdd(A, size, iE, iB, -gF + alphaR * gR);
    stampAdd(A, size, iE, iE, gF);
    stampAdd(A, size, iE, iC, -alphaR * gR);

    // 等效电流源（方向随极性翻转）
    stampRhs(b, size, iB, -pol * ((1 - alphaF) * eqF + (1 - alphaR) * eqR));
    stampRhs(b, size, iC, -pol * (alphaF * eqF - eqR));
    stampRhs(b, size, iE, -pol * (-eqF + alphaR * eqR));
  },
  resultOf(entry, voltageOf, x, branchOf) {
    void branchOf;
    const vb = voltageOf(entry.nets.B) || 0;
    const vc = voltageOf(entry.nets.C) || 0;
    const ve = voltageOf(entry.nets.E) || 0;
    const spec = transistorSpec(entry.comp.params);
    const beta = Number(entry.comp.params.beta) > 1 ? Number(entry.comp.params.beta) : spec.beta;
    const pol = spec.polarity === 'pnp' ? -1 : 1;
    const vt = VT_25C;
    const vbe = pol * (vb - ve);
    const vbc = pol * (vb - vc);
    const If = junctionCurrent(vbe, spec.is, vt);
    const Ir = junctionCurrent(vbc, spec.is, vt);
    const alphaF = beta / (beta + 1);
    const ic = pol * (alphaF * If - Ir);
    const ib = pol * ((1 - alphaF) * If + (1 - alphaF + 0) * Ir);
    const vce = vc - ve;
    let note = '';
    if (vbe < 0.45) note = '截止';
    else if (vce < 0.3) note = '饱和';
    else note = '放大';
    return { v: vce, i: ic, note, ib, vbe };
  },
};

/**
 * 运算放大器：有限增益 + 输出摆幅钳位。
 * 输出用一条支路方程约束：v(OUT) − v(V−) = clamp(A·(v+ − v−), −(VCC−2), VCC−2)
 * 钳位区导数置 0（理想电压源），线性区导数 = A。
 */
export const OPAMP_MODELS = {
  LM741: { label: 'LM741', gain: 2e5, swingDrop: 2 },
  OP07: { label: 'OP07', gain: 2e5, swingDrop: 2 },
};

export function opampSpec(params) {
  const key = params && params.model;
  return OPAMP_MODELS[key] || OPAMP_MODELS.LM741;
}

const opampModel = {
  id: 'opamp',
  label: '运算放大器',
  pins: ['+', '-', 'OUT', 'V+', 'V-'],
  requiredPins: ['+', '-', 'OUT'],
  needsBranch: true,
  isNonlinear: true,
  conducts: () => true,
  // 剪枝用：输出对 V− 有定义；电源脚成对。刻意放宽（宁可多算不可漏算）
  conductsPairs: () => [['+', '-'], ['OUT', '-'], ['V+', 'V-']],
  validate() { return null; },
  stampLinear() {},
  stampMulti(A, b, refs, params, x) {
    const iPlus = refs.idx['+'];
    const iMinus = refs.idx['-'];
    const iOut = refs.idx.OUT;
    const iVp = refs.idx['V+'];
    const iVm = refs.idx['V-'];
    const br = refs.br;
    if (iOut < 0 || br < 0) return;
    const V = (i) => (i < 0 ? 0 : x[i]);
    const vp = V(iPlus);
    const vm = V(iMinus);
    const vcc = (iVp >= 0 ? V(iVp) : 0) - (iVm >= 0 ? V(iVm) : 0);
    const span = vcc > 1 ? vcc : 15;
    const spec = opampSpec(params);
    const gain = Number(params && params.gain) > 0 ? Number(params.gain) : spec.gain;
    const limit = Math.max(0.1, span - spec.swingDrop);
    const raw = gain * (vp - vm);
    const out = Math.min(limit, Math.max(-limit, raw));
    const g = (raw > -limit && raw < limit) ? gain : 0;
    const ref = iVm >= 0 ? iVm : -1;

    // 节点方程：支路电流从 OUT 流入、从参考端流出
    stampAdd(A, refs.size, iOut, br, 1);
    stampAdd(A, refs.size, ref, br, -1);
    // 支路方程：v(OUT) − v(ref) − [out0 + g·(v+ − v−)] = 0
    stampAdd(A, refs.size, br, iOut, 1);
    if (ref >= 0) stampAdd(A, refs.size, br, ref, -1);
    if (iPlus >= 0) stampAdd(A, refs.size, br, iPlus, -g);
    if (iMinus >= 0) stampAdd(A, refs.size, br, iMinus, g);
    stampRhs(b, refs.size, br, out - g * (vp - vm));
  },
  resultOf(entry, voltageOf, x, branchOf) {
    const br = branchOf.get(entry.comp.id);
    const vo = voltageOf(entry.nets.OUT) || 0;
    const vref = entry.nets['V-'] ? (voltageOf(entry.nets['V-']) || 0) : 0;
    const vp = voltageOf(entry.nets['+']) || 0;
    const vm = voltageOf(entry.nets['-']) || 0;
    const spec = opampSpec(entry.comp.params);
    const vcc = (entry.nets['V+'] ? (voltageOf(entry.nets['V+']) || 0) : 0) - vref;
    const span = vcc > 1 ? vcc : 15;
    const limit = Math.max(0.1, span - spec.swingDrop);
    const out = vo - vref;
    const i = br === undefined ? null : x[br];
    let note = '线性';
    if (out >= limit - 1e-3) note = '正向饱和';
    else if (out <= -limit + 1e-3) note = '负向饱和';
    return { v: out, i, note, diff: vp - vm };
  },
};

/**
 * 电感：直流短路；暂态伴随模型用梯形积分。
 *   v[k] = R·(i[k] − i[k−1]) − v[k−1]，R = 2L/dt（首步 R = L/dt）
 * 支路方程：v(pos) − v(neg) − R·i[k] = −(R·iPrev + vPrev)
 */
const inductorModel = {
  id: 'inductor',
  label: '电感',
  pins: ['1', '2'],
  needsBranch: true,
  isNonlinear: false,
  conducts: () => true,
  validate(params) {
    const l = Number(params && params.inductance);
    if (!Number.isFinite(l) || l <= 0) return '电感量必须为正';
    return null;
  },
  stampLinear(A, b, refs) {
    // 直流：理想短路（0V 支路）
    const { pos, neg, br, size } = refs;
    if (br < 0) return;
    stampAdd(A, size, pos, br, 1);
    stampAdd(A, size, neg, br, -1);
    stampAdd(A, size, br, pos, 1);
    stampAdd(A, size, br, neg, -1);
    stampRhs(b, size, br, 0);
  },
  stampTransient(A, b, refs, params, ctx) {
    const { pos, neg, br, size } = refs;
    if (br < 0) return;
    const l = inductanceOf(params);
    const dt = Number(ctx && ctx.dt);
    const iPrev = Number(ctx && ctx.iPrev) || 0;
    const vPrev = Number(ctx && ctx.vPrev) || 0;
    const r = dt > 0 && l > 0 ? (ctx && ctx.startup ? l / dt : (2 * l) / dt) : 0;
    stampAdd(A, size, pos, br, 1);
    stampAdd(A, size, neg, br, -1);
    stampAdd(A, size, br, pos, 1);
    stampAdd(A, size, br, neg, -1);
    stampAdd(A, size, br, br, -r);
    stampRhs(b, size, br, -(r * iPrev + vPrev));
  },
  resultOf(entry, voltageOf, x, branchOf) {
    const br = branchOf.get(entry.comp.id);
    return {
      v: voltageOf(entry.netPos) - voltageOf(entry.netNeg),
      i: br === undefined ? null : x[br],
      note: br === undefined ? '' : '',
    };
  },
};

/** 读电感量（存储单位 H） */
export function inductanceOf(params) {
  const l = Number(params && params.inductance);
  return Number.isFinite(l) && l > 0 ? l : 0;
}

/**
 * 函数发生器：直流工作点取 offset，暂态由 simtrans 按波形逐时刻驱动。
 * 这里只负责"直流那一面"——学生在直流面板看到的是偏置电压。
 */
const fgenModel = {
  id: 'fgen',
  label: '函数发生器',
  pins: ['OUT', 'GND'],
  needsBranch: true,
  isNonlinear: false,
  conducts: () => true,
  validate(params) {
    const f = Number(params && params.frequency);
    if (params && params.wave !== 'dc' && (!Number.isFinite(f) || f <= 0)) return '频率必须大于 0';
    return null;
  },
  stampLinear(A, b, refs, params) {
    const { pos, neg, br, size } = refs;
    if (br < 0) return;
    const v = Number(params && params.offset) || 0;
    stampAdd(A, size, pos, br, 1);
    stampAdd(A, size, neg, br, -1);
    stampAdd(A, size, br, pos, 1);
    stampAdd(A, size, br, neg, -1);
    stampRhs(b, size, br, v);
  },
  resultOf(entry, voltageOf, x, branchOf) {
    const br = branchOf.get(entry.comp.id);
    return {
      v: (voltageOf(entry.netPos) || 0) - (voltageOf(entry.netNeg) || 0),
      i: br === undefined ? null : x[br],
      note: '波形源（暂态由发生器驱动）',
    };
  },
};

/** 蜂鸣器：有源=100Ω、无源=1kΩ（只做"通电发声"的负载模型） */
const buzzerModel = {
  id: 'buzzer',
  label: '蜂鸣器',
  pins: ['+', '-'],
  isNonlinear: false,
  conducts: () => true,
  validate() { return null; },
  resistanceOf(params) {
    const raw = Number(params && params.resistance);
    if (Number.isFinite(raw) && raw > 0) return raw;
    return params && params.mode === 'passive' ? 1000 : 100;
  },
  stampLinear(A, b, refs, params) {
    const r = buzzerModel.resistanceOf(params);
    stampConductance(A, refs.size, refs.pos, refs.neg, 1 / r);
  },
  resultOf(entry, voltageOf) {
    const v = voltageOf(entry.netPos) - voltageOf(entry.netNeg);
    const r = buzzerModel.resistanceOf(entry.comp.params);
    const i = v / r;
    return { v, i, note: Math.abs(i) >= 0.01 ? '发声' : '静音' };
  },
};

/** 继电器：线圈 100Ω + 单刀双掷触点（吸合 30mA / 释放 20mA，带回差） */
export const RELAY_RCOIL = 100;
export const RELAY_ON = 0.03;
export const RELAY_OFF = 0.02;
const relayEnergized = new Map(); // compId → bool

/** 清继电器状态（上电/切换实验） */
export function resetRelayState() {
  relayEnergized.clear();
}

export function relayStateOf(componentId) {
  return relayEnergized.get(componentId) === true;
}

/**
 * 用已解出的端电压刷新继电器状态（带回差），返回是否发生变化。
 * 求解器用它做外层不动点：状态变了就带新触点重解一次。
 */
export function refreshRelayState(entry, voltageOf) {
  const nets = entry.nets || {};
  const v1 = nets.COIL1 ? (voltageOf(nets.COIL1) || 0) : 0;
  const v2 = nets.COIL2 ? (voltageOf(nets.COIL2) || 0) : 0;
  const icoil = Math.abs((v1 - v2) / RELAY_RCOIL);
  const prev = relayEnergized.get(entry.comp.id) === true;
  let on = prev;
  if (icoil >= RELAY_ON) on = true;
  else if (icoil <= RELAY_OFF) on = false;
  if (on === prev) return false;
  relayEnergized.set(entry.comp.id, on);
  return true;
}

const relayModel = {
  id: 'relay',
  label: '继电器',
  pins: ['COIL1', 'COIL2', 'COM', 'NO', 'NC'],
  // 只接线圈也是合法电路（触点不用），所以 COM 不强制；触点缺失时 stampMulti 会跳过
  requiredPins: ['COIL1', 'COIL2'],
  isNonlinear: true,
  conducts: () => true,
  conductsPairs: () => [['COIL1', 'COIL2'], ['COM', 'NO'], ['COM', 'NC']],
  validate() { return null; },
  // 求解器外层不动点：用已解出的线圈电压刷新吸合状态
  refreshState(entry, voltageOf) {
    return refreshRelayState(entry, voltageOf);
  },
  stampLinear() {},
  stampMulti(A, b, refs, params, x) {
    const size = refs.size;
    const idx = refs.idx;
    const V = (i) => (i < 0 ? 0 : x[i]);
    const i1 = idx.COIL1;
    const i2 = idx.COIL2;
    if (!refs.connected || !refs.connected.COIL1 || !refs.connected.COIL2) return;
    // 线圈
    stampConductance(A, size, i1, i2, 1 / RELAY_RCOIL);
    const vcoil = V(i1) - V(i2);
    const icoil = vcoil / RELAY_RCOIL;
    const prev = relayEnergized.get(refs.comp.id) === true;
    let on = prev;
    if (Math.abs(icoil) >= RELAY_ON) on = true;
    else if (Math.abs(icoil) <= RELAY_OFF) on = false;
    relayEnergized.set(refs.comp.id, on);
    // 触点
    const com = idx.COM;
    if (!refs.connected || !refs.connected.COM) return;
    const closed = on ? idx.NO : idx.NC;
    const closedPin = on ? 'NO' : 'NC';
    if (refs.connected[closedPin]) stampConductance(A, size, com, closed, 1 / SWITCH_RON);
  },
  resultOf(entry, voltageOf) {
    const vcoil = (voltageOf(entry.nets.COIL1) || 0) - (voltageOf(entry.nets.COIL2) || 0);
    const i = vcoil / RELAY_RCOIL;
    const on = relayEnergized.get(entry.comp.id) === true;
    return { v: vcoil, i, note: on ? '吸合（COM-NO）' : '释放（COM-NC）' };
  },
};

/** 4 位拨码开关：每位一对端子，互不干扰 */
const dip4Model = {
  id: 'dip4',
  label: '拨码开关组',
  pins: ['1A', '1B', '2A', '2B', '3A', '3B', '4A', '4B'],
  requiredPins: [],
  isNonlinear: false,
  conducts: () => true,
  conductsPairs: () => [['1A', '1B'], ['2A', '2B'], ['3A', '3B'], ['4A', '4B']],
  validate() { return null; },
  stampLinear(A, b, refs, params) {
    const size = refs.size;
    const idx = refs.idx;
    for (let i = 1; i <= 4; i += 1) {
      if (params && (params[`s${i}`] === 'off' || params[`s${i}`] === false)) continue;
      const a = idx[`${i}A`];
      const c = idx[`${i}B`];
      if (!refs.connected || !refs.connected[`${i}A`] || !refs.connected[`${i}B`]) continue;
      stampConductance(A, size, a, c, 1 / SWITCH_RON);
    }
  },
  resultOf(entry) {
    const closed = [];
    for (let i = 1; i <= 4; i += 1) {
      if (!entry.comp.params || entry.comp.params[`s${i}`] !== 'off') closed.push(i);
    }
    return { v: null, i: null, note: closed.length > 0 ? `闭合 ${closed.join('/')}` : '全断开' };
  },
};

/** 电位器：两端 1/3，滑臂 2；α 为滑臂位置（0=顶端，100=底端） */
const potModel = {
  id: 'pot',
  label: '电位器',
  pins: ['1', '2', '3'],
  requiredPins: ['1', '2', '3'],
  isNonlinear: false,
  conducts: () => true,
  conductsPairs: () => [['1', '2'], ['2', '3']],
  validate(params) {
    const r = Number(params && params.resistance);
    if (!Number.isFinite(r) || r <= 0) return '电位器总阻值必须为正';
    return null;
  },
  stampLinear(A, b, refs, params) {
    const size = refs.size;
    const idx = refs.idx;
    const total = Number(params.resistance);
    const alpha = Math.min(1, Math.max(0, Number(params.wiper) / 100 || 0));
    const r12 = Math.max(total * alpha, 1e-3);
    const r23 = Math.max(total * (1 - alpha), 1e-3);
    const conn = refs.connected || {};
    if (conn['1'] && conn['2']) stampConductance(A, size, idx['1'], idx['2'], 1 / r12);
    if (conn['2'] && conn['3']) stampConductance(A, size, idx['2'], idx['3'], 1 / r23);
  },
  resultOf(entry, voltageOf) {
    const v12 = (voltageOf(entry.nets['1']) || 0) - (voltageOf(entry.nets['2']) || 0);
    const total = Number(entry.comp.params.resistance);
    const alpha = Math.min(1, Math.max(0, Number(entry.comp.params.wiper) / 100 || 0));
    const r12 = Math.max(total * alpha, 1e-3);
    return { v: v12, i: v12 / r12, note: `滑臂 ${Math.round(alpha * 100)}%` };
  },
};

/**
 * 混合信号边界元件（指令包 8）：跨域换算由 simmix 负责。
 * 这里显式 skip——它们在模拟方程里不出现（输出经 simtrans/simdig 的驱动源注入），
 * 但也不是"缺模型"。
 */
function mixSkip(id, label) {
  return {
    id,
    label,
    skip: true,
    reason: '混合信号边界元件，由 simmix 处理',
  };
}

/* ==========================================================================
   注册表与查询
   ========================================================================== */

export const MODELS = {
  resistor: resistorModel,
  led: ledModel,
  switch: switchModel,
  capacitor: capacitorModel,
  vsource: vsourceModel,
  isource: isourceModel,
  ic74xx: ic74xxModel,
  diode: diodeModel,
  zener: zenerModel,
  transistor: transistorModel,
  opamp: opampModel,
  inductor: inductorModel,
  fgen: fgenModel,
  buzzer: buzzerModel,
  relay: relayModel,
  dip4: dip4Model,
  pot: potModel,
  comparator: mixSkip('comparator', '比较器'),
  buffer74: mixSkip('buffer74', '数字缓冲'),
  dac8: mixSkip('dac8', '8 位 DAC'),
  adc8: mixSkip('adc8', '8 位 ADC'),
};

/** 取模型，未知类型返回 null */
export function getModel(type) {
  return Object.prototype.hasOwnProperty.call(MODELS, type) ? MODELS[type] : null;
}

/** 是否有可直接参与方程的模型（skip 不算） */
export function hasModel(type) {
  const model = getModel(type);
  return Boolean(model) && !model.skip;
}

/** 是否为「已知但有意跳过」的类型 */
export function isSkipped(type) {
  const model = getModel(type);
  return Boolean(model) && Boolean(model.skip);
}

/** 已注册的模型类型列表 */
export function listModelTypes() {
  return Object.keys(MODELS);
}

/** 需要支路电流未知量的类型（MNA 增广） */
export function needsBranch(type) {
  const model = getModel(type);
  return Boolean(model) && model.needsBranch === true;
}

/** 直流上是否导通（接地可达性剪枝用；无模型时按不导通处理） */
export function conductsDC(type, params) {
  const model = getModel(type);
  if (!model || model.skip || typeof model.conducts !== 'function') return false;
  return Boolean(model.conducts(params || {}));
}

/**
 * 暂态上是否导通（接地可达性剪枝用）。
 * 与直流的唯一差别：电容在暂态下能传导电流（有记忆的导通元件），
 * 于是「只靠电容接到地」的网在暂态里是可达的、会进方程。
 */
export function conductsTransient(type, params) {
  const model = getModel(type);
  if (!model || model.skip) return false;
  if (typeof model.conductsTransient === 'function') {
    return Boolean(model.conductsTransient(params || {}));
  }
  if (typeof model.conducts !== 'function') return false;
  return Boolean(model.conducts(params || {}));
}

/** 模型参数校验：返回错误文案或 null */
export function validateParams(type, params) {
  const model = getModel(type);
  if (!model || model.skip) return null;
  if (typeof model.validate !== 'function') return null;
  return model.validate(params || {});
}

/** 模型的固定备注（如电容「直流开路」） */
export function modelNote(type) {
  const model = getModel(type);
  if (!model || typeof model.note !== 'function') return '';
  return model.note();
}
