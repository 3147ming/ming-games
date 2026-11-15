/**
 * gamify.js — R12 成就 / 本地排行榜 / 每日一题积分
 *
 * 设计边界：
 *   - 判定逻辑是纯函数：`evaluateAchievements(ctx, state)` 只吃上下文 + 状态，
 *     返回「新解锁的成就」和「新状态」，node 直测不需要 localStorage。
 *   - 落盘只在 `loadGamifyState()` / `saveGamifyState()` 两个薄壳里，键：
 *       lab-sim:achievements   { [achId]: ISO 时间 }
 *       lab-sim:gamify         { points, reports, diagnoses, daily: { 'YYYY-MM-DD': qid } }
 *   - 成就一旦点亮就不撤销（避免误删电路导致徽章闪灭）。
 */

export const ACH_KEY = 'lab-sim:achievements';
export const GAMIFY_KEY = 'lab-sim:gamify';

/** 12 项成就（与规格表一一对应） */
export const ACHIEVEMENTS = [
  { id: 'first-exp', icon: '🎯', title: '初次实验', desc: '打开第 1 个实验', rule: { kind: 'opened', count: 1 } },
  { id: 'gates', icon: '🔧', title: '门电路大师', desc: '完成 D01 基本门电路', rule: { kind: 'exp', expId: 'dig-01-gates' } },
  { id: 'combo', icon: '🧩', title: '组合逻辑', desc: '完成 D02 组合逻辑化简', rule: { kind: 'exp', expId: 'dig-02-combo' } },
  { id: 'decoder', icon: '🔍', title: '译码专家', desc: '完成 D03 74LS138 译码器', rule: { kind: 'exp', expId: 'dig-03-decoder' } },
  { id: 'encoder', icon: '🔢', title: '编码高手', desc: '完成 D04 74LS148 编码器', rule: { kind: 'exp', expId: 'dig-04-encoder' } },
  { id: 'adder', icon: '➕', title: '加法达人', desc: '完成 D06 74LS283 全加器', rule: { kind: 'exp', expId: 'dig-06-adder' } },
  { id: 'ff', icon: '⚡', title: '触发器行家', desc: '完成 D09 JK 触发器', rule: { kind: 'exp', expId: 'dig-09-jk' } },
  { id: 'counter', icon: '🔢', title: '计数器能手', desc: '完成 D10 十进制计数器', rule: { kind: 'exp', expId: 'dig-10-counter' } },
  { id: 'shift', icon: '↔️', title: '移位专家', desc: '完成 D11 移位寄存器', rule: { kind: 'exp', expId: 'dig-11-shift' } },
  { id: 'majority', icon: '🏆', title: '表决冠军', desc: '完成 D12 三人表决器', rule: { kind: 'exp', expId: 'dig-12-majority' } },
  { id: 'report', icon: '📝', title: '报告完成', desc: '生成第 1 个实验报告', rule: { kind: 'reports', count: 1 } },
  { id: 'doctor', icon: '🩺', title: '体检医生', desc: '用电路体检查出一个故障', rule: { kind: 'diagnoses', count: 1 } },
];

export function achievementById(id) {
  return ACHIEVEMENTS.find((a) => a.id === id) || null;
}

export function defaultGamifyState() {
  return { points: 0, reports: 0, diagnoses: 0, daily: {} };
}

export function defaultAchievements() {
  return {};
}

/* ---------------------------------------------------------------- 落盘 */

export function loadAchievements() {
  try {
    const raw = window.localStorage.getItem(ACH_KEY);
    const data = raw ? JSON.parse(raw) : null;
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (_) {
    return {};
  }
}

export function saveAchievements(unlocked) {
  try { window.localStorage.setItem(ACH_KEY, JSON.stringify(unlocked || {})); } catch (_) { /* ignore */ }
  return unlocked;
}

export function loadGamifyState() {
  try {
    const raw = window.localStorage.getItem(GAMIFY_KEY);
    const data = raw ? JSON.parse(raw) : null;
    if (!data || typeof data !== 'object') return defaultGamifyState();
    return {
      points: Number(data.points) || 0,
      reports: Number(data.reports) || 0,
      diagnoses: Number(data.diagnoses) || 0,
      daily: data.daily && typeof data.daily === 'object' ? data.daily : {},
    };
  } catch (_) {
    return defaultGamifyState();
  }
}

export function saveGamifyState(state) {
  try { window.localStorage.setItem(GAMIFY_KEY, JSON.stringify(state)); } catch (_) { /* ignore */ }
  return state;
}

/* ---------------------------------------------------------------- 判定 */

/** 今天（本地时区）的 YYYY-MM-DD */
export function todayKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function ruleHit(rule, ctx) {
  if (!rule) return false;
  switch (rule.kind) {
    case 'opened':
      return (ctx.openedExps || []).length >= (rule.count || 1);
    case 'exp':
      return (ctx.completedExps || []).includes(rule.expId);
    case 'reports':
      return (ctx.reports || 0) >= (rule.count || 1);
    case 'diagnoses':
      return (ctx.diagnoses || 0) >= (rule.count || 1);
    case 'daily':
      return (ctx.dailyDone || 0) >= (rule.count || 1);
    default:
      return false;
  }
}

/**
 * 评估成就。纯函数：不改入参，返回新状态。
 * @returns {{unlocked:string[], achievements:object, state:object}}
 */
export function evaluateAchievements(ctx = {}, achievements = {}, state = defaultGamifyState()) {
  const nextAch = { ...achievements };
  const unlocked = [];
  const now = new Date().toISOString();
  ACHIEVEMENTS.forEach((ach) => {
    if (nextAch[ach.id]) return;
    if (ruleHit(ach.rule, ctx)) {
      nextAch[ach.id] = now;
      unlocked.push(ach.id);
    }
  });
  // 每个成就 10 分（首次解锁计入，不重复加）
  const nextState = { ...state, points: (state.points || 0) + unlocked.length * 10 };
  return { unlocked, achievements: nextAch, state: nextState };
}

/**
 * 记录一次事件并落盘（薄壳，供 UI 调用）。
 * @param {'report'|'diagnose'|'daily'} kind
 * @param {{questionId?:string, date?:Date}} extra
 */
export function recordEvent(kind, extra = {}) {
  const state = loadGamifyState();
  if (kind === 'report') state.reports = (state.reports || 0) + 1;
  else if (kind === 'diagnose') state.diagnoses = (state.diagnoses || 0) + 1;
  else if (kind === 'daily') {
    const key = todayKey(extra.date || new Date());
    if (key && !state.daily[key]) state.daily[key] = extra.questionId || 'q';
  }
  saveGamifyState(state);
  return state;
}

/** 今日是否已答过每日一题 */
export function dailyDoneToday(date = new Date()) {
  const state = loadGamifyState();
  return Boolean(state.daily[todayKey(date)]);
}

/* -------------------------------------------------------------- 排行榜 */

/**
 * 本地排行榜：按「已完成实验数」降序，同分按打开顺序编号。
 * progress 结构沿用 store.js：{ [expId]: { openedAt, lastAt, count } }
 */
export function buildLeaderboard(exps, progress = {}) {
  const rows = (exps || []).map((exp, index) => {
    const p = progress[exp.id] || null;
    return {
      expId: exp.id,
      title: exp.title || exp.id,
      platform: exp.platform || '',
      difficulty: Number(exp.difficulty) || 0,
      opened: Boolean(p),
      done: Boolean(p && p.done),
      lastAt: p && p.lastAt ? p.lastAt : 0,
      order: index,
    };
  });
  rows.sort((a, b) => {
    if (a.done !== b.done) return a.done ? -1 : 1;
    if (a.lastAt !== b.lastAt) return b.lastAt - a.lastAt;
    return a.order - b.order;
  });
  const doneCount = rows.filter((r) => r.done).length;
  return {
    rows,
    total: rows.length,
    doneCount,
    openedCount: rows.filter((r) => r.opened).length,
  };
}

/** 成就进度文案：「已完成 3/12」 */
export function achievementProgress(achievements = {}) {
  const total = ACHIEVEMENTS.length;
  const done = ACHIEVEMENTS.filter((a) => achievements[a.id]).length;
  return { total, done, percent: total ? Math.round((done / total) * 100) : 0 };
}
