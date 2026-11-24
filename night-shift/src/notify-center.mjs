/**
 * 通知中心（第三批 · 任务块 H-2）—— 纯逻辑，不依赖 DOM（ADR-002）
 *
 * 解决「弹窗糊屏 / 压住准星」：
 *   · 同屏最多 2 条，其余折叠成 +N，点一下展开
 *   · 三级：普通 / 重要 / 紧急；紧急同屏最多 1 条（新紧急顶掉旧紧急，旧的降为重要，不丢消息）
 *   · 三档过滤：全部 / 仅重要 / 关闭（设置值由 settings.mjs 持久化，本模块只消费）
 *
 * 布局约束由 hud.mjs 的 CSS 负责：左下窄列 + 90vw 断点切底部单行滚动；
 * 这里只保证「最多 2 条」的数据契约，渲染层不再自己数数。
 */
export const LEVEL = Object.freeze({ NORMAL: 'normal', IMPORTANT: 'important', URGENT: 'urgent' });
export const FILTER = Object.freeze({ ALL: 'all', IMPORTANT: 'important', OFF: 'off' });
const LEVEL_WEIGHT = { normal: 0, important: 1, urgent: 2 };

const numOr = (v, d) => (Number.isFinite(v) ? v : d);

/**
 * @param {{filter?:string, maxVisible?:number, maxUrgent?:number, ttl?:number}} opts
 */
export function createNotifyCenter(opts = {}) {
  let filter = opts.filter ?? FILTER.ALL;
  const maxVisible = Math.max(1, Math.floor(numOr(opts.maxVisible, 2)));
  const maxUrgent = Math.max(1, Math.floor(numOr(opts.maxUrgent, 1)));
  const defaultTtl = Math.max(0.2, numOr(opts.ttl, 3.2));
  let seq = 0;
  let expanded = false;
  let items = [];   // { id, text, level, ttl, age, order }

  function allowed(level) {
    if (filter === FILTER.OFF) return false;
    if (filter === FILTER.IMPORTANT) return LEVEL_WEIGHT[level] >= 1;
    return true;
  }

  /** 按等级降序、同等级按先来后到 */
  function ordered(list) {
    return list.slice().sort((a, b) =>
      (LEVEL_WEIGHT[b.level] - LEVEL_WEIGHT[a.level]) || (a.order - b.order));
  }

  function push(raw) {
    if (!raw) return null;
    const level = LEVEL_WEIGHT[raw.level] === undefined ? LEVEL.NORMAL : raw.level;
    if (!allowed(level)) return null;
    const msg = {
      id: raw.id ?? `n${++seq}`,
      text: String(raw.text ?? ''),
      level,
      ttl: Math.max(0.2, numOr(raw.ttl, defaultTtl)),
      age: 0,
      order: ++seq,
    };
    if (!msg.text) return null;

    // 同 id 覆盖（例如「补货完成」反复触发时不堆叠）
    const idx = items.findIndex((n) => n.id === msg.id);
    if (idx >= 0) items[idx] = msg;
    else items.push(msg);

    // 紧急上限：新紧急进来，最老的紧急降级为重要，保证紧急始终只有 maxUrgent 条。
    // 按 order 倒序（最新的在前）保留前 maxUrgent 条，其余降级 —— 不能连刚 push 的也降掉。
    const urgents = items.filter((n) => n.level === LEVEL.URGENT).sort((a, b) => b.order - a.order);
    for (const old of urgents.slice(maxUrgent)) old.level = LEVEL.IMPORTANT;

    return msg;
  }

  /** 推进时间，自动移除过期项；返回被移除的数量 */
  function tick(dt) {
    const d = Math.max(0, numOr(dt, 0));
    if (d === 0) return 0;
    const before = items.length;
    items = items.filter((n) => { n.age += d; return n.age < n.ttl; });
    if (items.length === 0) expanded = false;
    return before - items.length;
  }

  function visibleItems() {
    return ordered(items).slice(0, maxVisible).map((n) => ({ ...n }));
  }

  function snapshot() {
    const order = ordered(items);
    const shown = expanded ? order : order.slice(0, maxVisible);
    const hidden = Math.max(0, order.length - shown.length);
    return {
      visible: shown.map((n) => ({ ...n })),
      hidden,
      collapsedLabel: hidden > 0 ? `+${hidden}` : '',
      expanded,
      urgentCount: items.filter((n) => n.level === LEVEL.URGENT).length,
      total: items.length,
    };
  }

  return {
    push,
    tick,
    snapshot,
    expand() { expanded = true; },
    collapse() { expanded = false; },
    toggle() { expanded = !expanded; },
    /** 手动关闭单条（块4 第4条） */
    dismiss(id) {
      const before = items.length;
      items = items.filter((n) => n.id !== id);
      if (!items.length) expanded = false;
      return before - items.length;
    },
    clear() { items = []; expanded = false; },
    setFilter(v) {
      filter = v === FILTER.OFF || v === FILTER.IMPORTANT ? v : FILTER.ALL;
      if (!allowed(LEVEL.NORMAL)) items = items.filter((n) => allowed(n.level));
      if (items.length === 0) expanded = false;
      return filter;
    },
    getFilter: () => filter,
    isExpanded: () => expanded,
  };
}
