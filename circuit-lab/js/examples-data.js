/**
 * examples-data.js — 8 个示例实验（指令包 12）
 *
 * 每个示例 = 电路 + 指导步骤 + 预期值表（带容差）。
 * 模板只读：打开时 loadCircuit 的是深拷贝，用户的修改不会写回这里。
 *
 * 预期值不是手填的：tools/gen-examples.mjs 会用同一套 model/simdc 复算，
 * 把结果写回 examples/*.json；不一致时脚本直接报错。
 */

const K = 1000;

/** 常用元件构造器（缩短模板体积，保持可读） */
const C = (id, type, x, y, params) => ({ id, type, x, y, rotation: 0, params });

export const EXAMPLES = [
  {
    id: 'ex-e1-divider',
    title: '示例 E1：电阻分压',
    desc: '5V 经 1k:1k 分压，验证中点电压',
    platform: 'breadboard',
    difficulty: 1,
    durationMin: 15,
    tags: ['模拟', '分压'],
    equipment: ['万用表'],
    circuit: {
      platform: 'breadboard',
      components: [
        C('v1', 'vsource', 2, 2, { voltage: 5 }),
        C('r1', 'resistor', 6, 2, { resistance: K }),
        C('r2', 'resistor', 10, 2, { resistance: K }),
      ],
      wires: [
        { a: { componentId: 'v1', terminal: '+' }, b: { componentId: 'r1', terminal: '1' } },
        { a: { componentId: 'r1', terminal: '2' }, b: { componentId: 'r2', terminal: '1' } },
        { a: { componentId: 'r2', terminal: '2' }, b: { componentId: 'v1', terminal: '-' } },
      ],
    },
    guide: {
      steps: [
        '把万用表打到电压档，黑表笔接电源负端（地）。',
        '红表笔接 R1 与 R2 的连接点，读中点电压。',
        '用欧姆档量 R1、R2，确认都是 1kΩ。',
      ],
      expected: [
        { label: '中点电压', target: '2.500', unit: 'V', tolerance: 0.001 },
        { label: 'R1 阻值', target: '1000', unit: 'Ω', tolerance: 0.005, component: 'r1' },
      ],
    },
    measure: { type: 'dc', probe: { componentId: 'r1', terminal: '2' }, ground: { componentId: 'v1', terminal: '-' }, currentOf: 'r2' },
  },

  {
    id: 'ex-e2-led',
    title: '示例 E2：LED 限流',
    desc: '5V-330Ω-LED，验证限流电阻与工作电流',
    platform: 'breadboard',
    difficulty: 1,
    durationMin: 20,
    tags: ['模拟', 'LED'],
    equipment: ['万用表'],
    circuit: {
      platform: 'breadboard',
      components: [
        C('v1', 'vsource', 2, 2, { voltage: 5 }),
        C('r1', 'resistor', 6, 2, { resistance: 330 }),
        C('d1', 'led', 10, 2, { color: 'red', model: 'red' }),
      ],
      wires: [
        { a: { componentId: 'v1', terminal: '+' }, b: { componentId: 'r1', terminal: '1' } },
        { a: { componentId: 'r1', terminal: '2' }, b: { componentId: 'd1', terminal: 'A' } },
        { a: { componentId: 'd1', terminal: 'K' }, b: { componentId: 'v1', terminal: '-' } },
      ],
    },
    guide: {
      steps: [
        '按图接好 5V → 330Ω → LED → 地（注意 LED 极性，长脚为 A）。',
        '用电流档串在回路里读电流（或测 330Ω 两端电压再除以阻值）。',
        '把限流电阻换成 1kΩ，观察电流变化并解释原因。',
      ],
      expected: [
        { label: 'LED 电流', target: '0.0091', unit: 'A', tolerance: 0.05 },
        { label: 'LED 压降', target: '2.00', unit: 'V', tolerance: 0.08 },
      ],
    },
    measure: { type: 'dc', probe: { componentId: 'r1', terminal: '2' }, ground: { componentId: 'v1', terminal: '-' }, currentOf: 'r1' },
  },

  {
    id: 'ex-e3-rc',
    title: '示例 E3：RC 充放电',
    desc: '10k + 10µF，测量时间常数 τ=RC',
    platform: 'breadboard',
    difficulty: 2,
    durationMin: 30,
    tags: ['模拟', '暂态', 'RC'],
    equipment: ['示波器'],
    circuit: {
      platform: 'breadboard',
      components: [
        C('v1', 'vsource', 2, 2, { voltage: 5 }),
        C('r1', 'resistor', 6, 2, { resistance: 10 * K }),
        C('c1', 'capacitor', 10, 2, { capacitance: 10e-6 }),
      ],
      wires: [
        { a: { componentId: 'v1', terminal: '+' }, b: { componentId: 'r1', terminal: '1' } },
        { a: { componentId: 'r1', terminal: '2' }, b: { componentId: 'c1', terminal: '1' } },
        { a: { componentId: 'c1', terminal: '2' }, b: { componentId: 'v1', terminal: '-' } },
      ],
    },
    guide: {
      steps: [
        '把示波器 CH1 挂在电容上端，运行暂态 0.3s（步长 0.1ms）。',
        '读出 t=τ（0.1s）处的电压，应为 3.16V。',
        '把电容换成 5µF，解释 τ 与曲线斜率的变化。',
      ],
      expected: [
        { label: 't=τ 处电压', target: '3.16', unit: 'V', tolerance: 0.02 },
        { label: '时间常数 τ', target: '0.1', unit: 's', tolerance: 0.02 },
      ],
    },
    measure: { type: 'transient', probe: { componentId: 'c1', terminal: '1' }, ground: { componentId: 'v1', terminal: '-' }, at: 0.1, opts: { duration: 0.3, dt: 1e-4 } },
  },

  {
    id: 'ex-e4-diode',
    title: '示例 E4：二极管特性',
    desc: '5V-1k-1N4148，测正向压降与电流',
    platform: 'breadboard',
    difficulty: 2,
    durationMin: 20,
    tags: ['模拟', '半导体'],
    equipment: ['万用表'],
    circuit: {
      platform: 'breadboard',
      components: [
        C('v1', 'vsource', 2, 2, { voltage: 5 }),
        C('r1', 'resistor', 6, 2, { resistance: K }),
        C('d1', 'diode', 10, 2, { model: '1N4148' }),
      ],
      wires: [
        { a: { componentId: 'v1', terminal: '+' }, b: { componentId: 'r1', terminal: '1' } },
        { a: { componentId: 'r1', terminal: '2' }, b: { componentId: 'd1', terminal: 'A' } },
        { a: { componentId: 'd1', terminal: 'K' }, b: { componentId: 'v1', terminal: '-' } },
      ],
    },
    guide: {
      steps: [
        '用二极管档测 1N4148 的正向压降（注意红笔接 A、黑笔接 K）。',
        '把二极管反接，再测一次，观察是否截止。',
        '用电压档测 1k 电阻两端电压，换算回路电流。',
      ],
      expected: [
        { label: '正向压降', target: '0.68', unit: 'V', tolerance: 0.03 },
        { label: '回路电流', target: '0.00432', unit: 'A', tolerance: 0.02 },
      ],
    },
    measure: { type: 'dc', probe: { componentId: 'd1', terminal: 'A' }, ground: { componentId: 'v1', terminal: '-' }, currentOf: 'r1' },
  },

  {
    id: 'ex-e5-npn',
    title: '示例 E5：NPN 开关',
    desc: 'Rb 47k / Rc 1k，观察饱和导通',
    platform: 'breadboard',
    difficulty: 3,
    durationMin: 30,
    tags: ['模拟', '三极管'],
    equipment: ['万用表'],
    circuit: {
      platform: 'breadboard',
      components: [
        C('v1', 'vsource', 2, 2, { voltage: 5 }),
        C('rb', 'resistor', 6, 2, { resistance: 47 * K }),
        C('rc', 'resistor', 10, 2, { resistance: K }),
        C('q1', 'transistor', 16, 2, { model: '2N2222', beta: 100 }),
      ],
      wires: [
        { a: { componentId: 'v1', terminal: '+' }, b: { componentId: 'rb', terminal: '1' } },
        { a: { componentId: 'rb', terminal: '2' }, b: { componentId: 'q1', terminal: 'B' } },
        { a: { componentId: 'v1', terminal: '+' }, b: { componentId: 'rc', terminal: '1' } },
        { a: { componentId: 'rc', terminal: '2' }, b: { componentId: 'q1', terminal: 'C' } },
        { a: { componentId: 'q1', terminal: 'E' }, b: { componentId: 'v1', terminal: '-' } },
      ],
    },
    guide: {
      steps: [
        '基极经 47k 接 5V，集电极经 1k 接 5V，发射极接地。',
        '测 C-E 电压：饱和时约 0.1~0.2V。',
        '把 Rb 换成 470k，重新测 Ic 与 Vce，判断工作区。',
      ],
      expected: [
        { label: '集电极电流', target: '0.00488', unit: 'A', tolerance: 0.05 },
        { label: 'Vce', target: '0.12', unit: 'V', tolerance: 0.35 },
      ],
    },
    measure: { type: 'dc', probe: { componentId: 'q1', terminal: 'C' }, ground: { componentId: 'v1', terminal: '-' }, currentOf: 'q1' },
  },

  {
    id: 'ex-e6-opamp',
    title: '示例 E6：运放跟随器',
    desc: 'LM741 电压跟随，验证虚短',
    platform: 'breadboard',
    difficulty: 3,
    durationMin: 25,
    tags: ['模拟', '运放'],
    equipment: ['万用表'],
    circuit: {
      platform: 'breadboard',
      components: [
        C('v1', 'vsource', 2, 2, { voltage: 5 }),
        C('vin', 'vsource', 2, 8, { voltage: 2 }),
        C('u1', 'opamp', 12, 2, { model: 'LM741' }),
      ],
      wires: [
        { a: { componentId: 'vin', terminal: '+' }, b: { componentId: 'u1', terminal: '+' } },
        { a: { componentId: 'vin', terminal: '-' }, b: { componentId: 'v1', terminal: '-' } },
        { a: { componentId: 'u1', terminal: 'V+' }, b: { componentId: 'v1', terminal: '+' } },
        { a: { componentId: 'u1', terminal: 'V-' }, b: { componentId: 'v1', terminal: '-' } },
        { a: { componentId: 'u1', terminal: 'OUT' }, b: { componentId: 'u1', terminal: '-' } },
      ],
    },
    guide: {
      steps: [
        '把输出直接接回反相输入端（跟随器）。',
        '同相端给 2V，测输出应等于 2V。',
        '把反馈断开，观察输出饱和到电源摆幅。',
      ],
      expected: [
        { label: '输出电压', target: '2.000', unit: 'V', tolerance: 0.005 },
      ],
    },
    measure: { type: 'dc', probe: { componentId: 'u1', terminal: 'OUT' }, ground: { componentId: 'v1', terminal: '-' } },
  },

  {
    id: 'ex-e7-nand',
    title: '示例 E7：74LS00 与非门',
    desc: '双输入真值表（4 组组合）',
    platform: 'exp-box',
    difficulty: 2,
    durationMin: 25,
    tags: ['数字', '74LS'],
    equipment: ['逻辑分析仪'],
    circuit: {
      platform: 'exp-box',
      components: [
        C('u1', 'ic74xx', 8, 4, { type: '74LS00' }),
        C('s1', 'logic-switch', 2, 2, { state: 'lo' }),
        C('s2', 'logic-switch', 4, 2, { state: 'lo' }),
        C('l1', 'led', 18, 4, { color: 'red', model: 'ideal' }),
        C('r1', 'resistor', 16, 2, { resistance: 330 }),
        C('v1', 'vsource', 2, 10, { voltage: 5 }),
      ],
      wires: [
        { a: { componentId: 'v1', terminal: '+' }, b: { componentId: 'u1', terminal: '14' } },
        { a: { componentId: 'v1', terminal: '-' }, b: { componentId: 'u1', terminal: '7' } },
        { a: { componentId: 's1', terminal: 'OUT' }, b: { componentId: 'u1', terminal: '1' } },
        { a: { componentId: 's2', terminal: 'OUT' }, b: { componentId: 'u1', terminal: '2' } },
        { a: { componentId: 'v1', terminal: '+' }, b: { componentId: 'r1', terminal: '1' } },
        { a: { componentId: 'r1', terminal: '2' }, b: { componentId: 'l1', terminal: 'A' } },
        { a: { componentId: 'l1', terminal: 'K' }, b: { componentId: 'u1', terminal: '3' } },
      ],
    },
    guide: {
      steps: [
        '按图接好 74LS00 的 1A/1B/1Y 与电源（14=VCC、7=GND）。',
        '依次改变两个逻辑开关，记录 4 组输入对应的输出电平。',
        '与真值表对照：只有 1A=1 且 1B=1 时输出低。',
      ],
      expected: [
        { label: '真值表（00/01/10/11 → 输出）', target: '00→1,01→1,10→1,11→0', unit: '', tolerance: 0 },
      ],
    },
    measure: { type: 'digital', unit: 'u1', pins: ['1', '2', '3'] },
  },

  {
    id: 'ex-e8-divider74',
    title: '示例 E8：74LS74 分频',
    desc: '时钟 1kHz，Q 输出 500Hz',
    platform: 'exp-box',
    difficulty: 3,
    durationMin: 30,
    tags: ['数字', '时序'],
    equipment: ['逻辑分析仪', '示波器'],
    circuit: {
      platform: 'exp-box',
      components: [
        C('u1', 'ic74xx', 8, 4, { type: '74LS74' }),
        C('clk', 'clock', 2, 2, { frequency: 1000, duty: 50 }),
        C('v1', 'vsource', 2, 10, { voltage: 5 }),
        C('rq', 'resistor', 20, 2, { resistance: 1000 }),
      ],
      wires: [
        { a: { componentId: 'v1', terminal: '+' }, b: { componentId: 'u1', terminal: '14' } },
        { a: { componentId: 'v1', terminal: '-' }, b: { componentId: 'u1', terminal: '7' } },
        { a: { componentId: 'clk', terminal: '+' }, b: { componentId: 'u1', terminal: '3' } },
        { a: { componentId: 'clk', terminal: 'GND' }, b: { componentId: 'v1', terminal: '-' } },
        { a: { componentId: 'u1', terminal: '2' }, b: { componentId: 'u1', terminal: '6' } },
        { a: { componentId: 'u1', terminal: '4' }, b: { componentId: 'v1', terminal: '+' } },
        { a: { componentId: 'u1', terminal: '1' }, b: { componentId: 'v1', terminal: '+' } },
        { a: { componentId: 'u1', terminal: '5' }, b: { componentId: 'rq', terminal: '1' } },
        { a: { componentId: 'rq', terminal: '2' }, b: { componentId: 'v1', terminal: '-' } },
      ],
    },
    guide: {
      steps: [
        '把 74LS74 的 D 接 Q̄（2 接 6），组成 T 触发器。',
        '时钟 1kHz 从 3 脚输入，PRE/CLR 接高。',
        '用逻辑分析仪挂 Q（5 脚），读频率应为 500Hz。',
      ],
      expected: [
        { label: 'Q 输出频率', target: '500', unit: 'Hz', tolerance: 0.02 },
      ],
    },
    measure: { type: 'transient', probe: { componentId: 'u1', terminal: '5' }, ground: { componentId: 'v1', terminal: '-' }, opts: { duration: 0.01, dt: 2e-6 }, digital: true },
  },
];

/** 取示例（未知 id 返回 null） */
export function getExample(id) {
  return EXAMPLES.find((item) => item.id === id) || null;
}

/** 深拷贝（打开示例时用，保证模板不被改动） */
export function cloneExample(example) {
  return example ? JSON.parse(JSON.stringify(example)) : null;
}
