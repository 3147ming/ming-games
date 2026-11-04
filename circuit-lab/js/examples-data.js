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

/* ---------------------------------------------------------------- 数字实验构造器（指令包 16 · 任务 C） */
const SW = (id, x, y, state = 'lo') => C(id, 'logic-switch', x, y, { state });
const LED = (id, x, y, color = 'red') => C(id, 'led', x, y, { color, model: 'ideal' });
const RES = (id, x, y, resistance) => C(id, 'resistor', x, y, { resistance });
const V5 = (id, x, y) => C(id, 'vsource', x, y, { voltage: 5 });
const CLK = (id, x, y, frequency) => C(id, 'clock', x, y, { frequency, duty: 50 });
/** 导线简写：W([元件, 端子], [元件, 端子]) */
const W = (a, b) => ({ a: { componentId: a[0], terminal: a[1] }, b: { componentId: b[0], terminal: b[1] } });
/** DIP-14 电源：14=VCC / 7=GND */
const POWER14 = (v, u) => [W([v, '+'], [u, '14']), W([v, '-'], [u, '7'])];
/** DIP-16 电源：16=VCC / 8=GND */
const POWER16 = (v, u) => [W([v, '+'], [u, '16']), W([v, '-'], [u, '8'])];

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

  /* ==========================================================================
     数字电路实验箱 12 个课程实验（指令包 16 · 任务 C）
     组合实验用 measure.type='digital'：measure.inputs 指定扫描的开关（顺序＝真值表列序，
     inputs[0] 为最高位），measure.outputs 指定输出引脚向量（拼成 0/1/X 字符串）。
     时序实验（09/10/11）用 transient + digital:true 测频率。
     ========================================================================== */

  {
    id: 'dig-01-gates',
    title: 'D01 基本门电路真值表',
    desc: '用 74LS00 验证与非门四组输入组合',
    platform: 'exp-box',
    difficulty: 1,
    durationMin: 25,
    tags: ['数字', '门电路'],
    equipment: ['数字电路实验箱', '逻辑分析仪'],
    circuit: {
      platform: 'exp-box',
      components: [
        C('u1', 'ic74xx', 8, 4, { type: '74LS00' }),
        SW('s1', 2, 2), SW('s2', 4, 2),
        RES('r1', 16, 2, 330), LED('l1', 18, 4),
        V5('v1', 2, 10),
      ],
      wires: [
        ...POWER14('v1', 'u1'),
        W(['s1', 'OUT'], ['u1', '1']), W(['s2', 'OUT'], ['u1', '2']),
        W(['v1', '+'], ['r1', '1']), W(['r1', '2'], ['l1', 'A']),
        W(['l1', 'K'], ['u1', '3']),
      ],
    },
    guide: {
      steps: [
        '把 74LS00 插到锁紧座，14 接 +5V、7 接 GND。',
        '两个逻辑开关分别接 1A（1 脚）与 1B（2 脚）。',
        '依次拨动开关，记录 4 组输入对应的 1Y（3 脚）输出，与真值表对照。',
      ],
      expected: [
        { label: '真值表（A B → Y）', target: '00→1,01→1,10→1,11→0', unit: '', tolerance: 0 },
      ],
    },
    measure: { type: 'digital', unit: 'u1', pins: ['1', '2', '3'] },
  },

  {
    id: 'dig-02-combo',
    title: 'D02 组合逻辑化简 F = AB + A̅C',
    desc: '用 74LS04/08/32 三级搭建并验证',
    platform: 'exp-box',
    difficulty: 2,
    durationMin: 30,
    tags: ['数字', '组合逻辑'],
    equipment: ['数字电路实验箱', '逻辑分析仪'],
    circuit: {
      platform: 'exp-box',
      components: [
        C('u1', 'ic74xx', 8, 4, { type: '74LS08' }),
        C('u2', 'ic74xx', 8, 9, { type: '74LS04' }),
        C('u3', 'ic74xx', 16, 6, { type: '74LS32' }),
        SW('sa', 1, 2), SW('sb', 3, 2), SW('sc', 5, 2),
        RES('r1', 26, 6, 330), LED('l1', 28, 8),
        V5('v1', 1, 12),
      ],
      wires: [
        ...POWER14('v1', 'u1'), ...POWER14('v1', 'u2'), ...POWER14('v1', 'u3'),
        // A·B：U1 1A=1,1B=2,1Y=3
        W(['sa', 'OUT'], ['u1', '1']), W(['sb', 'OUT'], ['u1', '2']),
        // A̅：U2 1A=1,1Y=2
        W(['sa', 'OUT'], ['u2', '1']),
        // A̅·C：U1 2A=4,2B=5,2Y=6
        W(['u2', '2'], ['u1', '4']), W(['sc', 'OUT'], ['u1', '5']),
        // (AB)+(A̅C)：U3 1A=1,1B=2,1Y=3
        W(['u1', '3'], ['u3', '1']), W(['u1', '6'], ['u3', '2']),
        // 输出点亮 LED
        W(['v1', '+'], ['r1', '1']), W(['r1', '2'], ['l1', 'A']), W(['l1', 'K'], ['u3', '3']),
      ],
    },
    guide: {
      steps: [
        '按 F=AB+A̅C 化简式搭接：U1 的 1 门做 AB，U2 的 1 门做 A̅，U1 的 2 门做 A̅C，U3 做或。',
        '给出 A、B、C 的 8 种组合，记录 F，与真值表核对。',
        '把输入组合里使 F=1 的行找出来，反推最简与或式。',
      ],
      expected: [
        { label: 'F 真值表（ABC→F）', target: '000→0,001→1,010→0,011→1,100→0,101→0,110→1,111→1', unit: '', tolerance: 0 },
      ],
    },
    measure: { type: 'digital', unit: 'u3', inputs: ['sa', 'sb', 'sc'], outputs: ['3'] },
  },

  {
    id: 'dig-03-decoder',
    title: 'D03 74LS138 译码器',
    desc: '3-8 线译码：三位地址选通一个低有效输出',
    platform: 'exp-box',
    difficulty: 2,
    durationMin: 30,
    tags: ['数字', '译码器'],
    equipment: ['数字电路实验箱', '逻辑分析仪'],
    circuit: {
      platform: 'exp-box',
      components: [
        C('u1', 'ic74xx16', 8, 5, { type: '74LS138' }),
        SW('sa', 1, 2), SW('sb', 3, 2), SW('sc', 5, 2),
        V5('v1', 1, 11),
      ],
      wires: [
        ...POWER16('v1', 'u1'),
        W(['sa', 'OUT'], ['u1', '1']), W(['sb', 'OUT'], ['u1', '2']), W(['sc', 'OUT'], ['u1', '3']),
        // 使能：G1 高，G2A/G2B 低
        W(['v1', '+'], ['u1', '6']),
        W(['v1', '-'], ['u1', '4']), W(['v1', '-'], ['u1', '5']),
      ],
    },
    guide: {
      steps: [
        'A/B/C 三个地址开关接 1/2/3 脚，G1 接高、G2A/G2B 接地。',
        '逻辑分析仪同时挂 Y0~Y7，改地址看哪个输出被拉低。',
        '记录真值表：写出每个地址对应的输出（注意输出低有效，被选中那一位才是 0）。',
      ],
      expected: [
        {
          label: '地址 0~7 → Y0..Y7（低有效，标签按 C B A 读）',
          target: '000→01111111,001→10111111,010→11011111,011→11101111,100→11110111,101→11111011,110→11111101,111→11111110',
          unit: '',
          tolerance: 0,
        },
      ],
    },
    measure: {
      type: 'digital',
      unit: 'u1',
      // A 是地址最低位（pin1），标签按 C B A 从高到低读，行号才等于地址值
      inputs: ['sc', 'sb', 'sa'],
      outputs: ['15', '14', '13', '12', '11', '10', '9', '7'],
    },
  },

  {
    id: 'dig-04-encoder',
    title: 'D04 74LS148 优先编码器',
    desc: '8-3 线编码：多键按下时只认最高优先级的键',
    platform: 'exp-box',
    difficulty: 3,
    durationMin: 35,
    tags: ['数字', '编码器'],
    equipment: ['数字电路实验箱', '逻辑分析仪'],
    circuit: {
      platform: 'exp-box',
      components: [
        C('u1', 'ic74xx16', 8, 6, { type: '74LS148' }),
        // 输入低有效：默认全部拨到高（无键按下），按下才变低
        SW('i0', 1, 1, 'hi'), SW('i1', 1, 3, 'hi'), SW('i2', 1, 5, 'hi'), SW('i3', 1, 7, 'hi'),
        SW('i4', 23, 1, 'hi'), SW('i5', 23, 3, 'hi'), SW('i6', 23, 5, 'hi'), SW('i7', 23, 7, 'hi'),
        V5('v1', 1, 11),
      ],
      wires: [
        ...POWER16('v1', 'u1'),
        // 输入低有效：IN0..IN7
        W(['i0', 'OUT'], ['u1', '4']), W(['i1', 'OUT'], ['u1', '3']),
        W(['i2', 'OUT'], ['u1', '2']), W(['i3', 'OUT'], ['u1', '1']),
        W(['i4', 'OUT'], ['u1', '13']), W(['i5', 'OUT'], ['u1', '12']),
        W(['i6', 'OUT'], ['u1', '11']), W(['i7', 'OUT'], ['u1', '10']),
        // EI 使能低有效 → 接地
        W(['v1', '-'], ['u1', '5']),
      ],
    },
    guide: {
      steps: [
        '8 个开关接 IN0~IN7（低有效），EI 接地。A2/A1/A0 与 GS/EO 挂逻辑分析仪。',
        '单个开关打到低电平，记录编码输出（注意输出低有效）。',
        '同时把 IN0 和 IN7 都打到低，观察只输出 IN7 的编码——体会"优先"。',
      ],
      expected: [
        {
          label: '真值表（IN7 IN3 IN0 → A0 A1 A2 GS）',
          target: '000→0000,001→0000,010→0000,011→0000,100→0010,101→0010,110→1110,111→1111',
          unit: '',
          tolerance: 0,
        },
      ],
    },
    measure: {
      type: 'digital',
      unit: 'u1',
      inputs: ['i7', 'i3', 'i0'],
      outputs: ['6', '7', '9', '14'],
    },
  },

  {
    id: 'dig-05-mux',
    title: 'D05 74LS151 数据选择器',
    desc: '8 选 1：用三位地址在 8 路数据里选一路输出',
    platform: 'exp-box',
    difficulty: 3,
    durationMin: 35,
    tags: ['数字', '数据选择器'],
    equipment: ['数字电路实验箱', '逻辑分析仪'],
    circuit: {
      platform: 'exp-box',
      components: [
        C('u1', 'ic74xx16', 8, 6, { type: '74LS151' }),
        SW('sa', 1, 1), SW('sb', 1, 3), SW('sc', 1, 5),
        // D0=1, D1=0, D2=1, D3=0：地址 0~3 时 Y 依次为 1/0/1/0
        SW('d0', 23, 1, 'hi'), SW('d1', 23, 3), SW('d2', 23, 5, 'hi'), SW('d3', 23, 7),
        V5('v1', 1, 11),
      ],
      wires: [
        ...POWER16('v1', 'u1'),
        // 地址 A/B/C
        W(['sa', 'OUT'], ['u1', '11']), W(['sb', 'OUT'], ['u1', '10']), W(['sc', 'OUT'], ['u1', '9']),
        // 数据 D0~D3，其余 D4~D7 接地
        W(['d0', 'OUT'], ['u1', '4']), W(['d1', 'OUT'], ['u1', '3']),
        W(['d2', 'OUT'], ['u1', '2']), W(['d3', 'OUT'], ['u1', '1']),
        W(['v1', '-'], ['u1', '15']), W(['v1', '-'], ['u1', '14']),
        W(['v1', '-'], ['u1', '13']), W(['v1', '-'], ['u1', '12']),
        // G 使能低有效 → 接地
        W(['v1', '-'], ['u1', '7']),
      ],
    },
    guide: {
      steps: [
        'A/B/C 地址开关接 11/10/9 脚，D0~D3 接数据开关，G 接地。',
        '改变地址，观察 Y（5 脚）跟随哪一个数据输入，W（6 脚）是它的反相。',
        '用 74LS151 实现一个三变量逻辑函数（把 D 接成地址的最小项），体会"多路器即查表"。',
      ],
      expected: [
        {
          label: '真值表（A B C → Y W）',
          target: '000→10,001→01,010→10,011→01,100→01,101→01,110→01,111→01',
          unit: '',
          tolerance: 0,
        },
      ],
    },
    measure: { type: 'digital', unit: 'u1', inputs: ['sa', 'sb', 'sc'], outputs: ['5', '6'] },
  },

  {
    id: 'dig-06-adder',
    title: 'D06 74LS283 四位全加器',
    desc: 'A 由 4 个开关给值，B 固定为 5，观察和与进位',
    platform: 'exp-box',
    difficulty: 2,
    durationMin: 30,
    tags: ['数字', '运算电路'],
    equipment: ['数字电路实验箱', '逻辑分析仪'],
    circuit: {
      platform: 'exp-box',
      components: [
        C('u1', 'ic74xx16', 8, 6, { type: '74LS283' }),
        SW('a0', 1, 1), SW('a1', 1, 3), SW('a2', 1, 5), SW('a3', 1, 7),
        // B = 0101 = 5：b0 / b2 接高，b1 / b3 接低
        SW('b0', 23, 1, 'hi'), SW('b1', 23, 3), SW('b2', 23, 5, 'hi'), SW('b3', 23, 7),
        SW('c0', 8, 1),
        V5('v1', 1, 11),
      ],
      wires: [
        ...POWER16('v1', 'u1'),
        // A0..A3
        W(['a0', 'OUT'], ['u1', '5']), W(['a1', 'OUT'], ['u1', '3']),
        W(['a2', 'OUT'], ['u1', '14']), W(['a3', 'OUT'], ['u1', '12']),
        // B0..B3
        W(['b0', 'OUT'], ['u1', '6']), W(['b1', 'OUT'], ['u1', '2']),
        W(['b2', 'OUT'], ['u1', '15']), W(['b3', 'OUT'], ['u1', '11']),
        // C0
        W(['c0', 'OUT'], ['u1', '7']),
      ],
    },
    guide: {
      steps: [
        'A3A2A1A0 接 4 个开关，B 固定为 0101（=5），C0 接地。',
        '逻辑分析仪挂 S4~S1 与 C4，从 0+5 一直加到 15+5。',
        '验证输出五位（C4 S4 S3 S2 S1）是否等于 A+5，注意进位。',
      ],
      expected: [
        {
          label: '真值表（A3A2A1A0 → C4 S4 S3 S2 S1）',
          target: '0000→00101,0001→00110,0010→00111,0011→01000,0100→01001,0101→01010,0110→01011,0111→01100,1000→01101,1001→01110,1010→01111,1011→10000,1100→10001,1101→10010,1110→10011,1111→10100',
          unit: '',
          tolerance: 0,
        },
      ],
    },
    measure: {
      type: 'digital',
      unit: 'u1',
      inputs: ['a3', 'a2', 'a1', 'a0'],
      outputs: ['9', '10', '13', '1', '4'],
    },
  },

  {
    id: 'dig-07-comparator',
    title: 'D07 74LS85 数值比较器',
    desc: '比较两组 4 位二进制的大小关系',
    platform: 'exp-box',
    difficulty: 2,
    durationMin: 30,
    tags: ['数字', '运算电路'],
    equipment: ['数字电路实验箱', '逻辑分析仪'],
    circuit: {
      platform: 'exp-box',
      components: [
        C('u1', 'ic74xx16', 8, 6, { type: '74LS85' }),
        SW('a0', 1, 1), SW('a1', 1, 3), SW('a2', 1, 5), SW('a3', 1, 7),
        SW('b0', 23, 1), SW('b1', 23, 3), SW('b2', 23, 5), SW('b3', 23, 7),
        V5('v1', 1, 11),
      ],
      wires: [
        ...POWER16('v1', 'u1'),
        // A0..A3
        W(['a0', 'OUT'], ['u1', '10']), W(['a1', 'OUT'], ['u1', '12']),
        W(['a2', 'OUT'], ['u1', '13']), W(['a3', 'OUT'], ['u1', '15']),
        // B0..B3
        W(['b0', 'OUT'], ['u1', '9']), W(['b1', 'OUT'], ['u1', '11']),
        W(['b2', 'OUT'], ['u1', '14']), W(['b3', 'OUT'], ['u1', '1']),
        // 级联：IA=B=1，IA>B=0，IA<B=0
        W(['v1', '+'], ['u1', '3']),
        W(['v1', '-'], ['u1', '2']), W(['v1', '-'], ['u1', '4']),
      ],
    },
    guide: {
      steps: [
        'A、B 各 4 位接开关，级联输入 IA=B 置高、其余接地。',
        '逻辑分析仪挂 OA>B / OA=B / OA<B，比较 10 与 7、5 与 5 等组合。',
        '解释为什么只比较到最高不同位就能出结果（串行比较）。',
      ],
      expected: [
        {
          label: '真值表（A3 A1 B3 B1 → > = <）',
          target: '0000→010,0001→001,0010→001,0011→001,0100→100,0101→010,0110→001,0111→001,1000→100,1001→100,1010→010,1011→001,1100→100,1101→100,1110→100,1111→010',
          unit: '',
          tolerance: 0,
        },
      ],
    },
    measure: { type: 'digital', unit: 'u1', inputs: ['a3', 'a1', 'b3', 'b1'], outputs: ['5', '6', '7'] },
  },

  {
    id: 'dig-08-sr-d',
    title: 'D08 门控时钟与 D 触发器',
    desc: '74LS00 做门控时钟，74LS74 验证异步置位/清零与边沿触发',
    platform: 'exp-box',
    difficulty: 2,
    durationMin: 30,
    tags: ['数字', '触发器'],
    equipment: ['数字电路实验箱', '逻辑分析仪'],
    circuit: {
      platform: 'exp-box',
      components: [
        C('u1', 'ic74xx', 8, 4, { type: '74LS00' }),
        C('u2', 'ic74xx', 8, 9, { type: '74LS74' }),
        SW('sen', 1, 2), SW('sd', 16, 2),
        SW('spre', 16, 6), SW('sclr', 16, 8), CLK('clk', 16, 4, 1000),
        RES('r1', 26, 4, 330), LED('l1', 28, 6),
        V5('v1', 1, 12),
      ],
      wires: [
        ...POWER14('v1', 'u1'), ...POWER14('v1', 'u2'),
        // 门控时钟：CLK' = NAND(CLK, EN)，EN=1 时等于反相时钟（1Y=3 脚 → 74LS74 的 CLK）
        W(['clk', '+'], ['u1', '1']), W(['sen', 'OUT'], ['u1', '2']),
        W(['u1', '3'], ['u2', '3']),
        // D 触发器：D 接开关，PRE/CLR 各接一个开关（低有效）
        W(['sd', 'OUT'], ['u2', '2']),
        W(['spre', 'OUT'], ['u2', '4']), W(['sclr', 'OUT'], ['u2', '1']),
        W(['clk', 'GND'], ['v1', '-']),
        // 输出点亮 LED
        W(['v1', '+'], ['r1', '1']), W(['r1', '2'], ['l1', 'A']), W(['l1', 'K'], ['u2', '5']),
      ],
    },
    guide: {
      steps: [
        '先用一个与非门做门控时钟：EN=1 时 CLK′ 跟随时钟反相，EN=0 时 CLK′ 恒高、时钟被封住。',
        '再验证 74LS74 的异步端：CLR=0 清零、PRE=0 置位、两端都为 1 时保持。',
        '注意：如果把两个与非门交叉耦合成 SR 锁存器，会形成组合环路，静态求解会提示"检测到组合逻辑环路"——这种电路要用暂态仿真才能观察保持态。',
      ],
      expected: [
        { label: '异步置位/清零真值表（CLR PRE → Q）', target: '00→1,01→0,10→1,11→1', unit: '', tolerance: 0 },
      ],
    },
    measure: { type: 'digital', unit: 'u2', inputs: ['sclr', 'spre'], outputs: ['5'] },
  },

  {
    id: 'dig-09-jk',
    title: 'D09 74LS112 JK 触发器',
    desc: '验证 JK 四种功能与 T 触发器的二分频',
    platform: 'exp-box',
    difficulty: 3,
    durationMin: 35,
    tags: ['数字', '触发器'],
    equipment: ['数字电路实验箱', '逻辑分析仪', '示波器'],
    circuit: {
      platform: 'exp-box',
      components: [
        C('u1', 'ic74xx16', 8, 6, { type: '74LS112' }),
        // J=K=1 时构成 T 触发器，时钟下降沿翻转
        SW('sj', 1, 1, 'hi'), SW('sk', 1, 3, 'hi'), CLK('clk', 1, 5, 1000),
        RES('rq', 20, 2, 1000), LED('lq', 23, 4),
        V5('v1', 1, 11),
      ],
      wires: [
        ...POWER16('v1', 'u1'),
        // FF1: J=3, K=2, CLK=1, PR=4, CLR=15
        W(['sj', 'OUT'], ['u1', '3']), W(['sk', 'OUT'], ['u1', '2']),
        W(['clk', '+'], ['u1', '1']), W(['clk', 'GND'], ['v1', '-']),
        W(['v1', '+'], ['u1', '4']), W(['v1', '+'], ['u1', '15']),
        // Q 接 LED 负载：测量要有可分析的节点
        W(['v1', '+'], ['rq', '1']), W(['rq', '2'], ['lq', 'A']), W(['lq', 'K'], ['u1', '5']),
      ],
    },
    guide: {
      steps: [
        'J、K 各接一个开关，CLK 接 1kHz 时钟，PRE/CLR 接高。',
        '逐一验证：J=K=0 保持、J=1 K=0 置位、J=0 K=1 清零、J=K=1 翻转。',
        '把 J=K=1，用逻辑分析仪或示波器测 Q（5 脚）频率，应为 500Hz。',
      ],
      expected: [
        { label: 'Q 输出频率', target: '500', unit: 'Hz', tolerance: 0.02 },
      ],
    },
    measure: {
      type: 'transient',
      probe: { componentId: 'u1', terminal: '5' },
      ground: { componentId: 'v1', terminal: '-' },
      opts: { duration: 0.01, dt: 2e-6 },
      digital: true,
    },
  },

  {
    id: 'dig-10-counter',
    title: 'D10 74LS160 十进制计数器',
    desc: '同步十进制计数，QD 每 10 个时钟循环一次',
    platform: 'exp-box',
    difficulty: 3,
    durationMin: 35,
    tags: ['数字', '计数器'],
    equipment: ['数字电路实验箱', '逻辑分析仪'],
    circuit: {
      platform: 'exp-box',
      components: [
        C('u1', 'ic74xx16', 8, 6, { type: '74LS160' }),
        CLK('clk', 1, 1, 1000),
        RES('rq', 20, 2, 1000), LED('lq', 23, 4),
        V5('v1', 1, 11),
      ],
      wires: [
        ...POWER16('v1', 'u1'),
        W(['clk', '+'], ['u1', '2']), W(['clk', 'GND'], ['v1', '-']),
        // CLR/LOAD 接高（不复位不置数），ENP/ENT 接高（使能计数）
        W(['v1', '+'], ['u1', '1']), W(['v1', '+'], ['u1', '9']),
        W(['v1', '+'], ['u1', '7']), W(['v1', '+'], ['u1', '10']),
        // QD 接 LED 负载：测量要有可分析的节点
        W(['v1', '+'], ['rq', '1']), W(['rq', '2'], ['lq', 'A']), W(['lq', 'K'], ['u1', '11']),
      ],
    },
    guide: {
      steps: [
        'CLK 接 1kHz，CLR/LOAD 接高，ENP/ENT 接高。',
        '逻辑分析仪挂 QA~QD（14/13/12/11）与 RCO（15），观察 0→9 的循环。',
        '读出 QD 的频率：十进制每 10 个时钟循环一次，应为 100Hz。',
      ],
      expected: [
        { label: 'QD 输出频率', target: '100', unit: 'Hz', tolerance: 0.05 },
      ],
    },
    measure: {
      type: 'transient',
      probe: { componentId: 'u1', terminal: '11' },
      ground: { componentId: 'v1', terminal: '-' },
      opts: { duration: 0.05, dt: 2e-6 },
      digital: true,
    },
  },

  {
    id: 'dig-11-shift',
    title: 'D11 74LS194 移位寄存器',
    desc: '环形计数器：右移 + Q3 取反回灌 DSR，8 分频',
    platform: 'exp-box',
    difficulty: 3,
    durationMin: 40,
    tags: ['数字', '移位寄存器'],
    equipment: ['数字电路实验箱', '逻辑分析仪'],
    circuit: {
      platform: 'exp-box',
      components: [
        C('u1', 'ic74xx16', 8, 6, { type: '74LS194' }),
        C('u2', 'ic74xx', 16, 3, { type: '74LS04' }),
        // S1S0 = 01 → 右移
        SW('s0', 1, 1, 'hi'), SW('s1', 1, 3), CLK('clk', 1, 5, 1000),
        RES('rq', 26, 2, 1000), LED('lq', 29, 4),
        V5('v1', 1, 11),
      ],
      wires: [
        ...POWER16('v1', 'u1'), ...POWER14('v1', 'u2'),
        W(['clk', '+'], ['u1', '11']), W(['clk', 'GND'], ['v1', '-']),
        W(['s0', 'OUT'], ['u1', '9']), W(['s1', 'OUT'], ['u1', '10']),
        W(['v1', '+'], ['u1', '1']),
        // 环形：DSR = NOT(Q3)，组成 4 位 Johnson 计数器（8 分频）
        W(['u1', '12'], ['u2', '1']), W(['u2', '2'], ['u1', '2']),
        // Q0 接 LED 负载：测量要有可分析的节点
        W(['v1', '+'], ['rq', '1']), W(['rq', '2'], ['lq', 'A']), W(['lq', 'K'], ['u1', '15']),
      ],
    },
    guide: {
      steps: [
        'S1S0 拨到 01（右移），CLR 接高。',
        '把 Q3（12 脚）经一个反相器接回 DSR（2 脚），组成 Johnson 环形计数器。',
        '逻辑分析仪挂 Q0~Q3，观察 4 位里 0/1 的边界循环移动，Q0 应为时钟的 1/8。',
      ],
      expected: [
        { label: 'Q0 输出频率（8 分频）', target: '125', unit: 'Hz', tolerance: 0.05 },
      ],
    },
    measure: {
      type: 'transient',
      probe: { componentId: 'u1', terminal: '15' },
      ground: { componentId: 'v1', terminal: '-' },
      opts: { duration: 0.05, dt: 2e-6 },
      digital: true,
    },
  },

  {
    id: 'dig-12-majority',
    title: 'D12 综合：三人表决器',
    desc: '用门电路实现多数表决 F = AB+AC+BC',
    platform: 'exp-box',
    difficulty: 3,
    durationMin: 45,
    tags: ['数字', '综合'],
    equipment: ['数字电路实验箱', '逻辑分析仪'],
    circuit: {
      platform: 'exp-box',
      components: [
        C('u1', 'ic74xx', 8, 4, { type: '74LS08' }),
        C('u2', 'ic74xx', 16, 6, { type: '74LS32' }),
        SW('sa', 1, 2), SW('sb', 3, 2), SW('sc', 5, 2),
        RES('r1', 26, 6, 330), LED('l1', 28, 8),
        V5('v1', 1, 12),
      ],
      wires: [
        ...POWER14('v1', 'u1'), ...POWER14('v1', 'u2'),
        // AB、AC、BC 三路与（U1 的三个门）
        W(['sa', 'OUT'], ['u1', '1']), W(['sb', 'OUT'], ['u1', '2']),
        W(['sa', 'OUT'], ['u1', '4']), W(['sc', 'OUT'], ['u1', '5']),
        W(['sb', 'OUT'], ['u1', '9']), W(['sc', 'OUT'], ['u1', '10']),
        // (AB)+(AC)：U2 的 1 门
        W(['u1', '3'], ['u2', '1']), W(['u1', '6'], ['u2', '2']),
        // (AB+AC)+(BC)：U2 的 2 门
        W(['u2', '3'], ['u2', '4']), W(['u1', '8'], ['u2', '5']),
        // 输出点亮 LED
        W(['v1', '+'], ['r1', '1']), W(['r1', '2'], ['l1', 'A']), W(['l1', 'K'], ['u2', '6']),
      ],
    },
    guide: {
      steps: [
        'A、B、C 三个开关代表三个评委。按 F=AB+AC+BC 搭好两级与门 + 或门。',
        '给出 8 种投票组合，记录 F，验证"两票及以上通过"。',
        '把结果整理成真值表，并尝试用 74LS138 或 74LS151 重新实现一次，对比门数。',
      ],
      expected: [
        { label: 'F 真值表（ABC→F）', target: '000→0,001→0,010→0,011→1,100→0,101→1,110→1,111→1', unit: '', tolerance: 0 },
      ],
    },
    measure: { type: 'digital', unit: 'u2', inputs: ['sa', 'sb', 'sc'], outputs: ['6'] },
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
