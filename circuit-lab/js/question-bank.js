/**
 * question-bank.js — R14 电路题库 / 自动出题（纯函数层）
 *
 * 与 R1 的评分机制联动：每题挂一个 exampleId，答题时可用 measurePlan/gradePlan
 * 得到电路分，再与检查点勾选状态一起交给 gradeQuestion 加权求和。
 * 每日一题按「距固定纪元的天数 % 题库长度」轮换，同一天全站一致。
 */
export const QUESTIONS = [
  {
    id: 'q-001',
    title: '设计一个三输入多数表决器',
    desc: '用 74LS08 + 74LS32 实现 F = AB + AC + BC，输出在至少两个输入为高时为 1。',
    difficulty: 2,
    tags: ['组合逻辑', '表决器'],
    exampleId: 'dig-12-majority',
    expected: 'F = AB + AC + BC（或等价最简式）',
    checkpoints: [
      { key: 'truth', label: '画真值表（8 行）', weight: 30 },
      { key: 'expr', label: '写出最简表达式', weight: 30 },
      { key: 'circuit', label: '用芯片搭出电路并通过测量', weight: 40 },
    ],
    hint: '先列真值表，再化简，最后用 74LS08 做与、74LS32 做或。',
  },
  {
    id: 'q-002',
    title: '电阻分压与中点电压',
    desc: '5V 电源经两个 1kΩ 电阻串联分压，求中点电压与支路电流。',
    difficulty: 1,
    tags: ['模拟', '分压'],
    exampleId: 'ex-e1-divider',
    expected: '中点 2.500V，支路电流 2.5mA',
    checkpoints: [
      { key: 'truth', label: '写出分压公式', weight: 30 },
      { key: 'expr', label: '算出中点电压与电流', weight: 30 },
      { key: 'circuit', label: '搭电路并用万用表验证', weight: 40 },
    ],
    hint: 'V_mid = V_in × R2 / (R1 + R2)。',
  },
  {
    id: 'q-003',
    title: 'LED 限流电阻选取',
    desc: '5V 供电点亮一颗红色 LED，把电流限制在约 10mA，选合适的限流电阻。',
    difficulty: 1,
    tags: ['模拟', 'LED'],
    exampleId: 'ex-e2-led',
    expected: '约 330Ω（LED 压降按 0.7~2V 估算）',
    checkpoints: [
      { key: 'truth', label: '写出限流公式', weight: 30 },
      { key: 'expr', label: '算出电阻值与功耗', weight: 30 },
      { key: 'circuit', label: '搭电路并量 LED 电流', weight: 40 },
    ],
    hint: 'R = (Vcc - Vf) / I。',
  },
  {
    id: 'q-004',
    title: '3-8 线译码器地址映射',
    desc: '74LS138 的 A/B/C 接三位地址，写出 000~111 对应的低有效输出。',
    difficulty: 2,
    tags: ['数字', '译码器'],
    exampleId: 'dig-03-decoder',
    expected: '地址 000 选中 Y0（低），依此类推到 111 选中 Y7',
    checkpoints: [
      { key: 'truth', label: '画 8 行译码真值表', weight: 35 },
      { key: 'expr', label: '说明使能端接法', weight: 25 },
      { key: 'circuit', label: '接好使能并验证输出', weight: 40 },
    ],
    hint: 'G1 接高，G2A/G2B 接低；输出低有效。',
  },
  {
    id: 'q-005',
    title: '全加器的和与进位',
    desc: '写出一位全加器 S = A⊕B⊕Cin、Cout = AB + BCin + ACin 的真值表。',
    difficulty: 3,
    tags: ['数字', '加法器'],
    exampleId: 'dig-06-adder',
    expected: '8 行真值表，S 为奇校验，Cout 为至少两输入为高',
    checkpoints: [
      { key: 'truth', label: '画 8 行真值表', weight: 30 },
      { key: 'expr', label: '写出 S / Cout 最简式', weight: 30 },
      { key: 'circuit', label: '用 74LS283 验证', weight: 40 },
    ],
    hint: '先按 A/B/Cin 枚举 0~7，再分别算 S 与 Cout。',
  },
  {
    id: 'q-006',
    title: 'RC 低通截止频率',
    desc: 'R = 10kΩ、C = 10µF，求截止频率与 t = τ 时的电容电压。',
    difficulty: 2,
    tags: ['模拟', '滤波器'],
    exampleId: 'ex-e3-rc',
    expected: 'fc ≈ 1.59Hz，τ = 0.1s，t=τ 时约 3.16V（5V 阶跃）',
    checkpoints: [
      { key: 'truth', label: '写出 fc 与 τ 公式', weight: 30 },
      { key: 'expr', label: '算出数值', weight: 30 },
      { key: 'circuit', label: '用示波器看充放电曲线', weight: 40 },
    ],
    hint: 'fc = 1/(2πRC)，τ = RC，V(t) = V(1 - e^(-t/τ))。',
  },
  {
    id: 'q-007',
    title: 'JK 触发器的状态转移',
    desc: '给出 JK=00/01/10/11 四种输入下的次态，说明 11 时的翻转行为。',
    difficulty: 3,
    tags: ['数字', '触发器'],
    exampleId: 'dig-09-jk',
    expected: '00 保持 / 01 置 0 / 10 置 1 / 11 翻转',
    checkpoints: [
      { key: 'truth', label: '写特性表', weight: 35 },
      { key: 'expr', label: '写特性方程', weight: 25 },
      { key: 'circuit', label: '接时钟观察翻转', weight: 40 },
    ],
    hint: 'Q(t+1) = J·Q̅ + K̅·Q。',
  },
  {
    id: 'q-008',
    title: '十进制计数器状态机',
    desc: '74LS160 从 0000 计到 1001 后回到 0000，画出状态转移图与 QA..QD 波形。',
    difficulty: 3,
    tags: ['数字', '计数器'],
    exampleId: 'dig-10-counter',
    expected: '10 个状态、10 条转移边，QA 为二分频',
    checkpoints: [
      { key: 'truth', label: '列 0~9 状态码', weight: 30 },
      { key: 'expr', label: '画状态转移图', weight: 30 },
      { key: 'circuit', label: '用逻辑分析仪抓波形', weight: 40 },
    ],
    hint: 'CLR 接高、LOAD 接高、ENP/ENT 接高，CLK 给方波。',
  },
];

const EPOCH = Date.UTC(2026, 0, 1);

/** 纯函数：按难度 / 标签 / 关键词筛选 */
export function filterQuestions(list, criteria = {}) {
  const arr = Array.isArray(list) ? list : [];
  const q = String(criteria.query || '').trim().toLowerCase();
  const d = Number(criteria.difficulty) || 0;
  const tags = Array.isArray(criteria.tags) ? criteria.tags : [];
  return arr.filter((item) => {
    if (d && Number(item.difficulty) !== d) return false;
    if (tags.length && !tags.every((t) => (item.tags || []).includes(t))) return false;
    if (!q) return true;
    const hay = `${item.title} ${item.desc} ${(item.tags || []).join(' ')} ${item.expected || ''}`.toLowerCase();
    return q.split(/\s+/).every((word) => hay.includes(word));
  });
}

/** 纯函数：每日一题按天轮换（同一天返回同一题，跨天必变） */
export function dailyQuestion(list, date = new Date()) {
  const arr = Array.isArray(list) ? list : [];
  if (arr.length === 0) return null;
  const t = date instanceof Date ? date.getTime() : Date.parse(date);
  const day = Number.isFinite(t) ? Math.floor((t - EPOCH) / 86400000) : 0;
  const idx = ((day % arr.length) + arr.length) % arr.length;
  return arr[idx];
}

export function questionById(list, id) {
  return (Array.isArray(list) ? list : []).find((q) => q.id === id) || null;
}

/**
 * 纯函数：检查点加权评分。
 * @param {Object} q 题目
 * @param {Object} checks { [key]: boolean | 0..1 }，数字表示部分完成度
 * @returns {{score:number,total:number,completion:number,details:Array,verdict:string}}
 */
export function gradeQuestion(q, checks = {}) {
  const cps = q && Array.isArray(q.checkpoints) ? q.checkpoints : [];
  const total = cps.reduce((a, c) => a + (Number(c.weight) || 0), 0);
  const details = cps.map((c) => {
    const raw = checks[c.key];
    const ratio = typeof raw === 'number' ? Math.min(1, Math.max(0, raw)) : (raw ? 1 : 0);
    return { key: c.key, label: c.label, weight: Number(c.weight) || 0, ratio, points: Math.round((Number(c.weight) || 0) * ratio) };
  });
  const score = details.reduce((a, d) => a + d.points, 0);
  return {
    score,
    total,
    completion: total > 0 ? Number((score / total).toFixed(3)) : 0,
    details,
    verdict: total === 0 ? '无检查点' : (score === total ? '满分' : (score >= total * 0.6 ? '及格' : '待完成')),
  };
}

/** 题库里出现过的全部标签（去重排序），供 UI 生成筛选 chips */
export function questionTags(list) {
  const set = new Set();
  (Array.isArray(list) ? list : []).forEach((q) => (q.tags || []).forEach((t) => set.add(t)));
  return [...set].sort();
}
