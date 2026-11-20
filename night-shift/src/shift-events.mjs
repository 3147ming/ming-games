/**
 * 夜班事件三段流程 + 打烊结算 + 单 key 存档迁移（第三批 · 任务块 H-3/H-4）
 * 纯逻辑，不依赖 THREE / DOM；localStorage 由注入的 storage 提供，Node 里可传 Map 适配器。
 */
export const SHIFT_EVENTS = Object.freeze({
  drunk: {
    id: 'drunk', name: '醉客闹事', emoji: '🍺', warnSec: 4, windowSec: 8,
    hint: '走过去劝离（E）',
    success: { label: '和平劝离', effects: { reputation: 1 } },
    fail: { label: '闹事升级', effects: { reputation: -1, shelfDamage: 1 } },
  },
  theft: {
    id: 'theft', name: '夜盗', emoji: '🕵️', warnSec: 3, windowSec: 7,
    hint: '靠近拦截（E）',
    success: { label: '当场拦下', effects: { reputation: 1, recovered: 20 } },
    fail: { label: '货品失窃', effects: { cash: -20 } },
  },
  blackout: {
    id: 'blackout', name: '停电', emoji: '💡', warnSec: 5, windowSec: 10,
    hint: '去配电箱切应急灯（E）',
    success: { label: '应急灯亮起', effects: { reputation: 1 } },
    fail: { label: '顾客流失', effects: { customersLost: 3, reputation: -1 } },
  },
  inspection: {
    id: 'inspection', name: '临检', emoji: '📋', warnSec: 6, windowSec: 9,
    hint: '收起违禁品（E）',
    success: { label: '检查通过', effects: {} },
    fail: { label: '违规罚款', effects: { cash: -30, reputation: -1 } },
  },
});

export const SAVE_KEY = 'nightshift.shift.v2';
export const SAVE_VERSION = 2;
const numOr = (v, d) => (Number.isFinite(v) ? v : d);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * 事件状态机：预警 → 处理窗口 → 结果。
 * 每帧 tick(dt)，到点自动推进；玩家在 window 阶段调 handle() 决定成败。
 */
export function createEventMachine(opts = {}) {
  const onEvent = opts.onEvent ?? (() => {});
  let active = null;
  let log = [];

  function start(typeId, now = 0) {
    const def = SHIFT_EVENTS[typeId];
    if (!def) return { ok: false, reason: 'unknown-event' };
    if (active && active.phase !== 'result') return { ok: false, reason: 'busy' };
    active = { id: def.id, phase: 'warning', remain: def.warnSec, now, def };
    onEvent('phase', { id: def.id, phase: 'warning', name: def.name, hint: def.hint, seconds: def.warnSec });
    return { ok: true, id: def.id, phase: 'warning' };
  }

  function resolve(success, reason) {
    if (!active || active.phase === 'result') return { ok: false, reason: 'no-active' };
    const branch = success ? active.def.success : active.def.fail;
    const result = {
      ok: true, id: active.id, phase: 'result', success: !!success, reason,
      label: branch.label, effects: { ...branch.effects },
    };
    active.phase = 'result';
    active.remain = 0;
    active.result = result;
    log.push({ id: result.id, success: result.success, at: active.now, reason });
    onEvent('phase', { id: result.id, phase: 'result', ...result });
    return result;
  }

  function tick(dt = 0, now = 0) {
    const d = Math.max(0, numOr(dt, 0));
    if (!active || active.phase === 'result' || d === 0) return null;
    active.now = now || active.now + d;
    active.remain -= d;
    if (active.remain > 0) return null;
    if (active.phase === 'warning') {
      active.phase = 'window';
      active.remain = active.def.windowSec;
      onEvent('phase', {
        id: active.id, phase: 'window', name: active.def.name,
        hint: active.def.hint, seconds: active.def.windowSec,
      });
      return { id: active.id, phase: 'window', seconds: active.def.windowSec };
    }
    return resolve(false, 'timeout');
  }

  function handle(success = true) {
    if (!active || active.phase !== 'window') return { ok: false, reason: 'no-window' };
    return resolve(success, 'handled');
  }

  return {
    start, tick, handle,
    snapshot: () => active ? {
      id: active.id, phase: active.phase, remain: Math.max(0, active.remain),
      name: active.def.name, hint: active.def.hint,
      result: active.result ?? null,
    } : null,
    log: () => log.slice(),
    clear() { active = null; log = []; },
  };
}

/** 把事件效果应用到 state（由调用方显式触发，纯逻辑、便于测试） */
export function applyEffects(state = {}, effects = {}) {
  const s = state;
  s.cash = numOr(s.cash, 0) + numOr(effects.cash, 0);
  s.reputation = clamp(numOr(s.reputation, 50) + numOr(effects.reputation, 0), 0, 100);
  s.shelfDamage = numOr(s.shelfDamage, 0) + numOr(effects.shelfDamage, 0);
  s.customersLost = numOr(s.customersLost, 0) + numOr(effects.customersLost, 0);
  if (effects.recovered) s.cash += numOr(effects.recovered, 0);
  return s;
}

/** 次日客流预估：口碑为主，事件成败与今日拥挤度做小修正 */
export function nextDayForecast(ctx = {}) {
  const base = Math.max(1, numOr(ctx.visitorsToday, 20));
  const rep = clamp(numOr(ctx.reputation, 50), 0, 100);
  const repFactor = clamp(1 + (rep - 50) / 200, 0.6, 1.5);
  const win = Math.max(0, numOr(ctx.eventsSuccess, 0));
  const lose = Math.max(0, numOr(ctx.eventsFail, 0));
  const eventFactor = clamp(1 + (win - lose) * 0.03, 0.8, 1.3);
  const crowdFactor = ctx.crowded ? 0.95 : 1;
  return Math.max(4, Math.round(base * repFactor * eventFactor * crowdFactor));
}

/**
 * 打烊结算，产出可直接写入存档的一条快照。
 */
export function settleShift(ctx = {}) {
  const revenue = Math.max(0, numOr(ctx.revenue, 0));
  const costs = Math.max(0, numOr(ctx.costs, 0));
  const events = Array.isArray(ctx.events) ? ctx.events : [];
  const success = events.filter((e) => e?.success).length;
  const fail = events.length - success;
  const reputation = clamp(numOr(ctx.reputation, 50), 0, 100);
  return {
    version: SAVE_VERSION,
    day: Math.max(1, Math.floor(numOr(ctx.day, 1))),
    revenue, costs, profit: revenue - costs,
    visitors: Math.max(0, Math.floor(numOr(ctx.visitors, 0))),
    reputation,
    eventsSuccess: success,
    eventsFail: fail,
    /** 单 key 里的四个必存字段 */
    unlocks: { ...(ctx.unlocks ?? {}) },
    staff: Array.isArray(ctx.staff) ? ctx.staff.map((s) => ({ ...s })) : [],
    forecast: nextDayForecast({
      visitorsToday: ctx.visitors ?? 20, reputation, eventsSuccess: success,
      eventsFail: fail, crowded: ctx.crowded,
    }),
    savedAt: numOr(ctx.savedAt, Date.now()),
  };
}

/**
 * 版本迁移：把任意旧结构（v1 可能是散字段或嵌套）归一化到 v2 单结构。
 * 未知字段保留在 extra 里，避免升级丢玩家数据。
 */
export function migrateSave(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const version = Math.floor(numOr(src.version, 1));
  const out = {
    version: SAVE_VERSION,
    revenue: Math.max(0, numOr(src.revenue ?? src.totalRevenue, 0)),
    reputation: clamp(numOr(src.reputation ?? src.fame, 50), 0, 100),
    unlocks: { ...(src.unlocks ?? {}) },
    staff: Array.isArray(src.staff) ? src.staff.map((s) => ({ ...s })) : [],
    day: Math.max(1, Math.floor(numOr(src.day, 1))),
    costs: Math.max(0, numOr(src.costs, 0)),
    visitors: Math.max(0, Math.floor(numOr(src.visitors, 0))),
    events: Array.isArray(src.events) ? src.events.slice() : [],
    forecast: numOr(src.forecast, 0),
    savedAt: numOr(src.savedAt, 0),
    extra: version < SAVE_VERSION ? { ...(src.extra ?? {}) } : { ...(src.extra ?? {}) },
  };
  // v1 → v2：旧档把店员状态塞在 clerkStaff / staffState 里
  if (version < 2 && out.staff.length === 0) {
    const old = src.clerkStaff ?? src.staffState ?? src.hiredStaff;
    if (Array.isArray(old)) out.staff = old.map((s) => ({ ...s }));
  }
  out.migratedFrom = version < SAVE_VERSION ? version : undefined;
  return out;
}

/** 单 key 存档。storage 需实现 getItem/setItem/removeItem（浏览器 localStorage 或测试 Map 适配器）。 */
export function createShiftStore(storage, key = SAVE_KEY) {
  const store = storage ?? null;
  function load() {
    if (!store) return null;
    let raw = null;
    try { raw = store.getItem(key); } catch { return null; }
    if (!raw) return null;
    let data = null;
    try { data = JSON.parse(raw); } catch { return null; }
    return migrateSave(data);
  }
  function save(data) {
    if (!store) return false;
    try { store.setItem(key, JSON.stringify(migrateSave(data))); return true; } catch { return false; }
  }
  function patch(fn) {
    const cur = load() ?? migrateSave({});
    const next = typeof fn === 'function' ? fn(cur) : { ...cur, ...fn };
    save(next);
    return next;
  }
  function reset() { try { store?.removeItem(key); } catch { /* 忽略 */ } }
  return { load, save, patch, reset, key };
}
