/**
 * analytics.js — R10 本地埋点（零后端、零依赖纯函数 + localStorage 适配层）
 *
 * 设计约束：
 *   · 只记「发生了什么」，不记任何个人信息；全部数据留在本机浏览器
 *   · 上限 5000 条，超出删最早的（避免 localStorage 被撑爆）
 *   · localStorage 不可用（隐私模式 / file://）时回落内存数组，不抛错
 *   · summarize 是纯函数，便于 tools/test-model.mjs 直测
 */
export const ANALYTICS_KEY = 'lab-sim-analytics';
export const ANALYTICS_LIMIT = 5000;

/** 事件字典（UI 与文档共用，避免拼写漂移） */
export const EVENTS = Object.freeze([
  'exp_open', 'part_place', 'wire_connect', 'switch_toggle',
  'sim_run', 'data_record', 'report_gen', 'share', 'submit',
]);

let memory = [];
let storageFailed = false;

function storage() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  } catch (_) { /* 隐私模式 */ }
  return null;
}

/** 读取全部事件（坏数据自动丢弃，不阻塞主流程） */
export function readEvents() {
  const s = storage();
  if (!s) return memory.slice();
  try {
    const raw = s.getItem(ANALYTICS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((e) => e && typeof e === 'object') : [];
  } catch (_) {
    return memory.slice();
  }
}

/** 写入一条事件；返回该事件对象 */
export function track(event, fields = {}) {
  const entry = { t: Date.now(), event, ...fields };
  const list = readEvents();
  list.push(entry);
  const trimmed = list.length > ANALYTICS_LIMIT ? list.slice(list.length - ANALYTICS_LIMIT) : list;
  const s = storage();
  if (s && !storageFailed) {
    try {
      s.setItem(ANALYTICS_KEY, JSON.stringify(trimmed));
      memory = trimmed;
      return entry;
    } catch (_) {
      storageFailed = true; // 配额满：后续只写内存，不再反复尝试
    }
  }
  memory = trimmed;
  return entry;
}

/** 清空（统计面板「清空记录」用） */
export function clearEvents() {
  memory = [];
  const s = storage();
  if (s) { try { s.removeItem(ANALYTICS_KEY); } catch (_) { /* ignore */ } }
}

/**
 * 纯函数汇总。
 * @param {Array} events 事件数组
 * @param {Object} stepsByExp 可选：{ [expId]: 已完成步骤数 }，由 UI 从 store.getSteps 传入
 * @returns {{ perExp: Object, total: number, byEvent: Object }}
 */
export function summarize(events, stepsByExp = {}) {
  const list = Array.isArray(events) ? events : [];
  const perExp = Object.create(null);
  const byEvent = Object.create(null);
  for (const e of list) {
    if (!e || typeof e !== 'object' || !e.event) continue;
    byEvent[e.event] = (byEvent[e.event] || 0) + 1;
    const id = typeof e.expId === 'string' && e.expId ? e.expId : '_unknown';
    if (!perExp[id]) perExp[id] = { expId: id, opens: 0, reports: 0, shares: 0, submits: 0, parts: 0, wires: 0, toggles: 0, simulations: 0 };
    const row = perExp[id];
    if (e.event === 'exp_open') row.opens += 1;
    else if (e.event === 'report_gen') row.reports += 1;
    else if (e.event === 'share') row.shares += 1;
    else if (e.event === 'submit') row.submits += 1;
    else if (e.event === 'part_place') row.parts += Number(e.count) || 1;
    else if (e.event === 'wire_connect') row.wires += Number(e.count) || 1;
    else if (e.event === 'switch_toggle') row.toggles += Number(e.count) || 1;
    else if (e.event === 'sim_run') row.simulations += 1;
  }
  const ids = Object.keys(perExp);
  const stepsValues = ids.map((id) => Number(stepsByExp[id]) || 0);
  const avgSteps = ids.length ? stepsValues.reduce((a, b) => a + b, 0) / ids.length : 0;
  const reportValues = ids.map((id) => perExp[id].reports);
  return {
    perExp,
    total: list.length,
    byEvent,
    avgSteps: Number(avgSteps.toFixed(2)),
    avgReports: ids.length ? Number((reportValues.reduce((a, b) => a + b, 0) / ids.length).toFixed(2)) : 0,
  };
}

/** 导出用的 JSON 文本（带元信息，方便老师离线汇总） */
export function exportJson(events, stepsByExp = {}) {
  return JSON.stringify({
    app: 'circuit-lab',
    exportedAt: Date.now(),
    summary: summarize(events, stepsByExp),
    events: Array.isArray(events) ? events : [],
  }, null, 2);
}
