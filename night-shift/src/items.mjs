/**
 * 道具背包与消耗品（需求I 第③条）
 *
 * ── 分工 ────────────────────────────────────────────────
 * 本模块只管**库存与选中状态**（买 / 存 / 选中 / 消耗）；
 * "用下去会发生什么"涉及场景与经营状态，由 main.mjs 的 useItem() 执行 ——
 * 保持"系统只算、main 记账"的既有分层（ADR-002）。
 *
 * ── 使用流程 ────────────────────────────────────────────
 *   B 打开背包 → 点击选中 → 关闭 → 对准目标按 E → 消耗 1 个
 * 之所以要"选中"这一步而不是按键直接用：三种道具有两种需要目标（对准设备 / 附近垃圾），
 * 如果按 B 就即时生效，玩家会在没对准的情况下白白消耗一个道具。
 *
 * ── 纯逻辑、零 THREE / DOM ──────────────────────────────
 * inventory / selectedItem 都在 save.mjs 的 STATE_FIELDS 白名单里，可跨存档保留。
 */

import { CONSUMABLES, CONSUMABLE_BY_ID } from './config.mjs';

const numOr = (v, d) => (Number.isFinite(v) ? v : d);

/**
 * @param opts.state   state.mjs 的单一真源
 * @param opts.onEvent (type, payload) —— 'buy' | 'select' | 'consume'
 */
export function createInventory(opts = {}) {
  const state = opts.state;
  const onEvent = opts.onEvent ?? (() => {});

  function count(id) {
    return Math.max(0, Math.round(numOr(state.inventory?.[id], 0)));
  }

  /** 直接发放（任务奖励等；不走现金） */
  function add(id, n = 1) {
    const def = CONSUMABLE_BY_ID[id];
    if (!def || !(n > 0)) return { ok: false, reason: '未知道具' };
    state.inventory[id] = count(id) + Math.round(n);
    return { ok: true, id, count: state.inventory[id] };
  }

  /** 商店购买：扣现金 +1 个（现金校验在外层 UI 也应做一次，这里做最终兜底） */
  function buy(id, n = 1) {
    const def = CONSUMABLE_BY_ID[id];
    if (!def) return { ok: false, reason: '未知道具' };
    const q = Math.max(1, Math.round(n));
    const cost = def.price * q;
    if (state.cash < cost) return { ok: false, reason: '现金不足', cost };
    state.cash -= cost;
    state.inventory[id] = count(id) + q;
    onEvent('buy', { id, qty: q, cost });
    return { ok: true, id, qty: q, cost, count: state.inventory[id] };
  }

  /** 选中（再次点击同一项 = 取消选中） */
  function select(id) {
    if (id != null && !CONSUMABLE_BY_ID[id]) return { ok: false, reason: '未知道具' };
    if (id != null && count(id) <= 0) return { ok: false, reason: '没有这个道具' };
    state.selectedItem = (state.selectedItem === id) ? null : id;
    onEvent('select', { id: state.selectedItem });
    return { ok: true, selected: state.selectedItem };
  }

  function selected() {
    const id = state.selectedItem;
    if (!id || count(id) <= 0) return null;
    return CONSUMABLE_BY_ID[id] ?? null;
  }

  /** 消耗 1 个（由 main 在效果真正生效后调用 —— 先扣钱再办事会让失败也吃掉道具） */
  function consume(id) {
    if (count(id) <= 0) return { ok: false, reason: '没有这个道具' };
    state.inventory[id] = count(id) - 1;
    if (state.inventory[id] <= 0) {
      delete state.inventory[id];
      if (state.selectedItem === id) state.selectedItem = null;
    }
    onEvent('consume', { id, left: count(id) });
    return { ok: true, id, left: count(id) };
  }

  /** 背包面板数据（HUD 用） */
  function list() {
    return CONSUMABLES.map((c) => ({
      id: c.id, name: c.name, emoji: c.emoji, price: c.price, desc: c.desc,
      count: count(c.id),
      selected: state.selectedItem === c.id,
      affordable: state.cash >= c.price,
    }));
  }

  function total() {
    return CONSUMABLES.reduce((a, c) => a + count(c.id), 0);
  }

  return { count, add, buy, select, selected, consume, list, total };
}

export { CONSUMABLES, CONSUMABLE_BY_ID };
