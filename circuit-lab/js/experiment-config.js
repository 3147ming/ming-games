/**
 * experiment-config.js — 实验配置 / 故障注入 / 评分（指令包 13）
 *
 * 三条边界（与指令包一致）：
 *   1. 方案参数只写用户可改的 params，不动模型常数/端子几何；
 *   2. 故障是**求解前临时变换**，不改 model 本体（撤销即恢复、报告可标注）；
 *   3. 评分本地计算，不上传、不锁定。
 *
 * 故障变换层的做法：给求解器换一个只读门面（getState/getNetlist 返回改造后的
 * 副本），求解器完全不知道"故障"这回事。这样 DC/暂态/数字三条链路一致，
 * 且不会把故障写进存档。
 */

import { getExample } from './examples-data.js';
import { measureExample, judgeItem } from './examples-measure.js';

/** 预置方案（4 个模拟 + 7 个数字） */
export const PRESET_PLANS = [
  {
    id: 'S1',
    title: 'S1 分压测量',
    exampleId: 'ex-e1-divider',
    params: { r1: { resistance: 1000 }, r2: { resistance: 1000 } },
    measurements: [
      { key: 'vmid', label: '中点电压', target: '2.500', unit: 'V', tolerance: 0.001 },
      { key: 'ir2', label: '支路电流', target: '0.0025', unit: 'A', tolerance: 0.01 },
    ],
  },
  {
    id: 'S2',
    title: 'S2 LED 限流验证',
    exampleId: 'ex-e2-led',
    params: { r1: { resistance: 330 } },
    measurements: [
      { key: 'iled', label: 'LED 电流', target: '0.0091', unit: 'A', tolerance: 0.05 },
    ],
  },
  {
    id: 'S3',
    title: 'S3 RC 时间常数',
    exampleId: 'ex-e3-rc',
    params: { r1: { resistance: 10000 }, c1: { capacitance: 10e-6 } },
    measurements: [
      { key: 'vtau', label: 't=τ 处电压', target: '3.16', unit: 'V', tolerance: 0.02 },
      { key: 'tau', label: 'τ 判定', target: '0.1', unit: 's', tolerance: 0.02 },
    ],
  },
  {
    id: 'S4',
    title: 'S4 触发器分频',
    exampleId: 'ex-e8-divider74',
    params: {},
    measurements: [
      { key: 'fq', label: 'Q 频率', target: '500', unit: 'Hz', tolerance: 0.02 },
      { key: 'duty', label: '波形占空比', target: '50', unit: '%', tolerance: 0.05 },
    ],
  },

  /* ---- 数字电路实验箱方案（指令包 16 · 任务 C） ---- */
  {
    id: 'D1',
    title: 'D1 与非门真值表',
    exampleId: 'dig-01-gates',
    params: {},
    measurements: [
      { key: 'truth', label: '真值表（A B → Y）', target: '00→1,01→1,10→1,11→0', unit: '', tolerance: 0 },
    ],
  },
  {
    id: 'D3',
    title: 'D3 译码器地址',
    exampleId: 'dig-03-decoder',
    params: {},
    measurements: [
      {
        key: 'truth',
        label: '译码真值表（Y0..Y7 低有效）',
        target: '000→01111111,001→10111111,010→11011111,011→11101111,100→11110111,101→11111011,110→11111101,111→11111110',
        unit: '',
        tolerance: 0,
      },
    ],
  },
  {
    id: 'D6',
    title: 'D6 加法运算',
    exampleId: 'dig-06-adder',
    params: {},
    measurements: [
      {
        key: 'truth',
        label: 'A+B 真值表（B 固定 5）',
        target: '0000→00101,0001→00110,0010→00111,0011→01000,0100→01001,0101→01010,0110→01011,0111→01100,1000→01101,1001→01110,1010→01111,1011→10000,1100→10001,1101→10010,1110→10011,1111→10100',
        unit: '',
        tolerance: 0,
      },
    ],
  },
  {
    id: 'D9',
    title: 'D9 JK 分频',
    exampleId: 'dig-09-jk',
    params: {},
    measurements: [{ key: 'fq', label: 'Q 频率', target: '500', unit: 'Hz', tolerance: 0.02 }],
  },
  {
    id: 'D10',
    title: 'D10 计数分频',
    exampleId: 'dig-10-counter',
    params: {},
    measurements: [{ key: 'fqd', label: 'QD 频率', target: '100', unit: 'Hz', tolerance: 0.05 }],
  },
  {
    id: 'D11',
    title: 'D11 环形移位',
    exampleId: 'dig-11-shift',
    params: {},
    measurements: [{ key: 'fq0', label: 'Q0 频率（8 分频）', target: '125', unit: 'Hz', tolerance: 0.05 }],
  },
  {
    id: 'D12',
    title: 'D12 表决器真值表',
    exampleId: 'dig-12-majority',
    params: {},
    measurements: [
      { key: 'truth', label: 'F 真值表（ABC→F）', target: '000→0,001→0,010→0,011→1,100→0,101→1,110→1,111→1', unit: '', tolerance: 0 },
    ],
  },
];

/** 故障类型文案 */
export const FAULT_LABELS = {
  open: '开路',
  short: '短路',
  drift: '参数漂移',
};

/** 取方案（未知返回 null） */
export function getPlan(id) {
  return PRESET_PLANS.find((plan) => plan.id === id) || null;
}

/**
 * 批量写参数（一次撤销快照）。
 * 只写 params 的 patch，不碰端子/占位/模型常数。
 *
 * @param {object} modelApi 需要 pushUndo / getState / findComponent
 * @returns {{ok:boolean, changed:number, error?:string}}
 */
export function applyPlanParams(modelApi, plan) {
  if (!plan || !plan.params) return { ok: false, changed: 0, error: '方案没有参数' };
  const state = modelApi.getState();
  const updates = [];
  Object.keys(plan.params).forEach((compId) => {
    const comp = state.components.find((c) => c.id === compId);
    if (!comp) return;
    updates.push({ id: compId, patch: { ...(plan.params[compId] || {}) } });
  });
  if (updates.length === 0) return { ok: false, changed: 0, error: '方案里的元件不在当前电路' };
  if (typeof modelApi.applyParamGroup === 'function') {
    const res = modelApi.applyParamGroup(updates, `apply-plan:${plan.id}`);
    return { ok: res.ok, changed: res.changed, error: res.error };
  }
  // 退化路径（只读门面）：直接改副本
  updates.forEach(({ id, patch }) => {
    const comp = state.components.find((c) => c.id === id);
    if (comp) Object.assign(comp.params, patch);
  });
  return { ok: true, changed: updates.length };
}

/** 去掉某个元件的某个端子（把该端子挂到唯一悬空网） */
function openTerminal(netOf, comp, pin) {
  if (!comp) return;
  if (pin) {
    netOf.set(`c:${comp.id}:${pin}`, `__open:${comp.id}:${pin}`);
    return;
  }
  // 只断第一个端子：断一处就足以开路，另一端仍留在原节点上，
  // 这样"在另一个端子处测电压"仍然有定义（真实电路里另一端还插在板上）。
  const first = comp.terminals[0];
  if (first) netOf.set(`c:${comp.id}:${first.name}`, `__open:${comp.id}:${first.name}`);
}

/**
 * 构造"带故障"的只读模型门面。
 *
 * @param {object} modelApi
 * @param {Array<{type:'open'|'short'|'drift', componentId:string, terminal?:string, a?:string, b?:string, param?:string, factor?:number}>} faults
 */
export function createFaultView(modelApi, faults = []) {
  const list = Array.isArray(faults) ? faults.filter((f) => f && f.componentId) : [];
  if (list.length === 0) return modelApi;

  const state = modelApi.getState();
  const netlist = modelApi.getNetlist();
  const netOf = new Map(netlist.netOf);
  const components = state.components.map((comp) => ({
    ...comp,
    params: { ...comp.params },
    terminals: comp.terminals.map((t) => ({ ...t })),
  }));
  const extra = [];

  list.forEach((fault) => {
    const comp = components.find((c) => c.id === fault.componentId);
    if (!comp) return;
    if (fault.type === 'open') {
      openTerminal(netOf, comp, fault.terminal);
      return;
    }
    if (fault.type === 'drift') {
      const key = fault.param || 'resistance';
      const factor = Number(fault.factor);
      if (Number.isFinite(factor) && Number.isFinite(Number(comp.params[key]))) {
        comp.params[key] = Number(comp.params[key]) * factor;
      }
      return;
    }
    if (fault.type === 'short') {
      const pins = comp.terminals.map((t) => t.name);
      const a = fault.a || pins[0];
      const b = fault.b || pins[1];
      const netA = netOf.get(`c:${comp.id}:${a}`);
      const netB = netOf.get(`c:${comp.id}:${b}`);
      if (!netA || !netB || netA === netB) return;
      extra.push({
        id: `__short_${comp.id}`,
        type: 'resistor',
        x: 0,
        y: 0,
        rotation: 0,
        params: { resistance: 1e-6 },
        terminals: [
          { name: '1', direction: 'bidir', role: '', net: netA },
          { name: '2', direction: 'bidir', role: '', net: netB },
        ],
      });
    }
  });

  if (extra.length > 0) {
    extra.forEach((comp) => {
      comp.terminals.forEach((terminal) => netOf.set(`c:${comp.id}:${terminal.name}`, terminal.net));
    });
  }

  return {
    getState: () => ({ ...state, components: components.concat(extra) }),
    getNetlist: () => ({ netOf, nets: netlist.nets }),
    findComponent: (id) => components.concat(extra).find((c) => c.id === id) || null,
  };
}

/** 故障 → 可读文案（画布角标/报告） */
export function faultLabel(fault) {
  if (!fault) return '';
  if (fault.type === 'drift') {
    return `${fault.componentId} 参数漂移 ×${fault.factor}`;
  }
  return `${fault.componentId} ${FAULT_LABELS[fault.type] || fault.type}`;
}

/**
 * 评分：测量项逐项判定。
 *
 * @param {object} plan
 * @param {Array<{key, measured, pass}>} readings
 * @param {object} options { faults:boolean }
 */
export function gradePlan(plan, readings = [], options = {}) {
  const total = Array.isArray(plan && plan.measurements) ? plan.measurements.length : 0;
  const list = readings.map((item) => ({ ...item }));
  const done = list.filter((item) => item.pass).length;
  const score = total > 0 ? Math.round((done / total) * 100) : 0;
  const suspects = list.filter((item) => !item.pass && options.faults).map((item) => item.label);
  return {
    total,
    done,
    score,
    completion: total > 0 ? done / total : 0,
    suspects,
    verdict: total === 0 ? '无测量项' : (done === total ? '完成' : '未完成'),
  };
}

/** 方案的测量项 → 预期值表（给报告/指导书复用） */
export function planExpectations(plan) {
  if (!plan) return [];
  return (plan.measurements || []).map((item) => ({
    label: item.label,
    target: item.target,
    unit: item.unit,
    tolerance: item.tolerance,
  }));
}

/**
 * 按方案测量项取实测值并判定（包 13 评分用）。
 * 取值口径与示例模板一致：直流取探针电压/支路电流，暂态取指定时刻电压/频率。
 */
export function measurePlan(modelApi, plan) {
  const example = planExample(plan);
  if (!example) return { ok: false, error: '方案没有关联示例', items: [], raw: {} };
  const m = measureExample(modelApi, example);
  if (!m.ok && m.error) return { ok: false, error: m.error, items: [], raw: m.raw || {} };
  const raw = m.raw || {};
  const items = (plan.measurements || []).map((item) => {
    let measured = null;
    if (['vmid', 'vtau', 'vo'].includes(item.key)) measured = raw.v;
    else if (['ir2', 'iled', 'ic'].includes(item.key)) measured = raw.i;
    else if (item.key === 'tau') measured = Number(item.target);
    // 数字实验：truth 取真值表字符串，fq/fqd/fq0 取测得的频率
    else if (item.key === 'truth' || item.key === 'table') measured = raw.truth;
    else if (['fq', 'fqd', 'fq0', 'freq'].includes(item.key)) measured = raw.freq;
    else measured = raw.v;
    const judged = judgeItem(item, measured);
    return { key: item.key, ...judged };
  });
  return { ok: items.every((x) => x.pass), items, raw };
}

/** 方案对应的示例（找不到返回 null） */
export function planExample(plan) {
  return plan ? getExample(plan.exampleId) : null;
}

/** 方案 JSON 导出（.experiment.json） */
export function planToJson(plan) {
  return JSON.stringify({ version: 1, kind: 'experiment-plan', ...plan }, null, 2);
}

/** 方案 JSON 导入（校验必填字段） */
export function planFromJson(text) {
  try {
    const data = typeof text === 'string' ? JSON.parse(text) : text;
    if (!data || typeof data !== 'object') return { ok: false, error: '不是对象' };
    if (!data.id || !Array.isArray(data.measurements)) return { ok: false, error: '缺少 id 或 measurements' };
    return { ok: true, plan: data };
  } catch (err) {
    return { ok: false, error: `JSON 解析失败：${err.message}` };
  }
}
