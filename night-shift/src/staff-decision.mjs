/**
 * 店员决策层（第三批 · 任务块 H）—— 纯逻辑，不依赖 THREE / DOM（ADR-002）
 *
 * 与 staff.mjs 的分工：
 *   staff.mjs      —— 既有四类店员的雇佣 / 薪资 / 体力 / 具体动作执行
 *   staff-decision —— 这一层只回答「谁、接下来做哪件事、效率多少、头顶显示什么」
 *
 * 五条硬需求（对应指令 H-1）：
 *   ① 任务队列 + 优先级：补货（缺货 SKU > 货架<30%）> 收银（有客）> 巡逻（无客）> 事件
 *   ② 疲惫：连续工作 90s 起效率 -20%；休息满 20s 恢复
 *   ③ 偏好学习：统计常卖 SKU 与常放位置，补货时优先该类
 *   ④ 任务锁：同一任务不会被两个店员重复接走
 *   ⑤ 行为可见：每个分配带 path（移动路径）与 bubble（头顶气泡文案）
 */
import { rankSkuByDemand, skuDemandScore } from './staff.mjs';

/** 任务类型与优先级（数值越大越先接） */
export const TASK_TYPES = Object.freeze({
  RESTOCK: 'restock',
  CHECKOUT: 'checkout',
  PATROL: 'patrol',
  EVENT: 'event',
});

export const BASE_PRIORITY = Object.freeze({
  restock: 100,
  checkout: 70,
  patrol: 30,
  event: 10,
});

/** 疲惫参数（游戏秒） */
export const FATIGUE = Object.freeze({
  thresholdSec: 90,   // 连续工作超过 90s
  minFactor: 0.8,     // 效率降到 80%（-20%）
  recoverSec: 20,     // 休息 20s 恢复
});

/** 行为可见文案 */
const BUBBLE = Object.freeze({
  restock: '补货中',
  checkout: '收银中',
  patrol: '巡逻中',
  event: '处理中',
  resting: '休息中',
  idle: '待命',
});

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const numOr = (v, d) => (Number.isFinite(v) ? v : d);

/** 对单个任务打分。缺货（stockout）比「货架 <30%」再高一档。 */
export function taskScore(task = {}) {
  const type = task.type ?? TASK_TYPES.PATROL;
  let score = BASE_PRIORITY[type] ?? 0;
  if (type === TASK_TYPES.RESTOCK) {
    // 缺货是真实流失信号，压过一切「比例低但还有货」的补货
    score += task.stockout ? 40 : 0;
    // ratio = 当前货架 / 目标容量；越低越急，<30% 已进入急补区间
    const ratio = clamp(numOr(task.ratio, 1), 0, 1);
    score += (1 - ratio) * 20;
    if (ratio < 0.3) score += 10;
  }
  if (type === TASK_TYPES.CHECKOUT && task.hasCustomer === false) score -= 100;
  if (type === TASK_TYPES.PATROL && task.hasCustomer) score -= 100;
  return score;
}

/** 任务排序（不改入参） */
export function rankTasks(tasks = []) {
  return tasks.slice().sort((a, b) => {
    const d = taskScore(b) - taskScore(a);
    if (d !== 0) return d;
    return String(a.id ?? '').localeCompare(String(b.id ?? ''));
  });
}

/** 疲惫效率系数：0.8 ~ 1。restSec 从 0 走到 20 线性恢复。 */
export function fatigueFactor(workSec = 0, restSec = 0) {
  const w = Math.max(0, numOr(workSec, 0));
  const r = Math.max(0, numOr(restSec, 0));
  if (r > 0) {
    // 休息进度：不足 20s 时按线性从当前疲劳回到 1
    return clamp(FATIGUE.minFactor + (1 - FATIGUE.minFactor) * (r / FATIGUE.recoverSec), 0, 1);
  }
  if (w <= FATIGUE.thresholdSec) return 1;
  // 90s 之后一路降到 80%，之后保持（不会越干越废到 0）
  const over = w - FATIGUE.thresholdSec;
  return Math.max(FATIGUE.minFactor, 1 - (1 - FATIGUE.minFactor) * clamp(over / FATIGUE.thresholdSec, 0, 1));
}

/** 是否该去休息（与 staff.mjs 的 stamina 阈值互补，这里只按连续工作时长判断） */
export function shouldRest(workSec = 0, restSec = 0) {
  return restSec <= 0 && workSec >= FATIGUE.thresholdSec * 2;
}

/**
 * 偏好学习：从成交流水里统计「常卖 SKU」与「常放位置」。
 * @param {Array<{skuId:string, slotId?:string}>} history 已成交记录
 * @returns {{ skus:Array<{id:string,count:number}>, slotBySku:object, topSkuIds:string[] }}
 */
export function learnPreference(history = []) {
  const skuCount = {}, slotCount = {}, slotBySku = {};
  for (const h of history) {
    if (!h?.skuId) continue;
    skuCount[h.skuId] = (skuCount[h.skuId] ?? 0) + 1;
    if (h.slotId) {
      slotCount[h.slotId] = (slotCount[h.slotId] ?? 0) + 1;
      const m = slotBySku[h.skuId] ?? (slotBySku[h.skuId] = {});
      m[h.slotId] = (m[h.slotId] ?? 0) + 1;
    }
  }
  for (const id of Object.keys(slotBySku)) {
    slotBySku[id] = Object.entries(slotBySku[id]).sort((a, b) => b[1] - a[1])[0][0];
  }
  const skus = Object.entries(skuCount).map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count);
  return { skus, slotBySku, topSkuIds: skus.slice(0, 3).map((s) => s.id) };
}

/**
 * 把偏好注入 rankSkuByDemand：常卖 SKU 加一点权重，但不压过缺货流失信号。
 * 偏好加成固定 2.5 分 ≈ 0.6 件流失，所以「缺货 1 件」就能翻盘，符合直觉。
 * 纯函数，不改入参。
 */
export function rankSkuWithPreference(skus, ctx = {}, preference = {}) {
  const top = new Set(preference.topSkuIds ?? []);
  if (top.size === 0) return rankSkuByDemand(skus, ctx);
  const miss = ctx.missed ?? {}, sold = ctx.sold ?? {}, shelf = ctx.shelfQty ?? {};
  const hasTelemetry = skus.some((s) => (miss[s.id] | 0) > 0 || (sold[s.id] | 0) > 0);
  const score = (s) => skuDemandScore(s, ctx) + (top.has(s.id) ? 2.5 : 0);
  return skus.slice().sort((a, b) =>
    hasTelemetry
      ? (score(b) - score(a))
      : ((top.has(b.id) ? 1 : 0) - (top.has(a.id) ? 1 : 0)) || ((shelf[a.id] ?? 0) - (shelf[b.id] ?? 0)));
}

/** 任务锁：同一任务只会被一个店员持有。 */
export function createTaskLocks() {
  const owner = new Map(); // taskId -> staffId
  return {
    acquire(taskId, staffId) {
      if (owner.has(taskId)) return owner.get(taskId) === staffId;
      owner.set(taskId, staffId);
      return true;
    },
    release(taskId, staffId) {
      if (owner.get(taskId) !== staffId) return false;
      owner.delete(taskId);
      return true;
    },
    releaseByStaff(staffId) {
      const freed = [];
      for (const [t, s] of owner) if (s === staffId) { owner.delete(t); freed.push(t); }
      return freed;
    },
    isLocked: (taskId) => owner.has(taskId),
    ownerOf: (taskId) => owner.get(taskId) ?? null,
    clear: () => owner.clear(),
    snapshot: () => Object.fromEntries(owner),
  };
}

/** 直线移动路径（含起终点）；纯数据，渲染层据此画虚线。 */
export function pathBetween(from = null, to = null) {
  if (!from || !to) return [];
  const a = [numOr(from.x, 0), numOr(from.y, 0)];
  const b = [numOr(to.x, 0), numOr(to.y, 0)];
  return [a, b];
}

/**
 * 综合决策：给每个店员分配一个任务。
 * @param {Array<{id:string, type:string, workSec?:number, restSec?:number, pos?:object}>} staff
 * @param {Array<{id:string, type:string, target?:object, ...}>} tasks
 * @param {{locks?:object, preference?:object, now?:number}} ctx
 * @returns {{assignments:Array, idle:Array}}
 */
export function assignTasks(staff = [], tasks = [], ctx = {}) {
  const locks = ctx.locks ?? createTaskLocks();
  const preference = ctx.preference ?? {};
  const ordered = rankTasks(tasks);
  // 疲劳低的先挑（把急活给状态好的人）；同状态按 id 稳定排序
  const people = staff.slice().sort((a, b) => {
    const fa = fatigueFactor(a.workSec, a.restSec), fb = fatigueFactor(b.workSec, b.restSec);
    return fb - fa || String(a.id).localeCompare(String(b.id));
  });
  const assignments = [], idle = [];
  let ti = 0;
  for (const p of people) {
    if (shouldRest(p.workSec, p.restSec)) {
      const task = { id: 'rest', type: 'rest', target: p.pos };
      assignments.push({ staffId: p.id, task, factor: 1, bubble: BUBBLE.resting, path: [] });
      continue;
    }
    // 找第一个没被锁、且类型匹配的活
    let chosen = null;
    while (ti < ordered.length) {
      const t = ordered[ti];
      if (!locks.isLocked(t.id) && locks.acquire(t.id, p.id)) { chosen = t; ti += 1; break; }
      ti += 1;
    }
    if (!chosen) { idle.push(p.id); continue; }
    const factor = fatigueFactor(p.workSec, p.restSec);
    assignments.push({
      staffId: p.id,
      task: chosen,
      factor,
      bubble: BUBBLE[chosen.type] ?? BUBBLE.idle,
      path: pathBetween(p.pos, chosen.target),
      // 偏好提示：补货任务优先放到常放位置
      preferSlotId: chosen.type === TASK_TYPES.RESTOCK
        ? preference.slotBySku?.[chosen.skuId] ?? null : null,
    });
  }
  return { assignments, idle };
}

export { BUBBLE };
