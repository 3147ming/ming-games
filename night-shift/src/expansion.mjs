/* ==================================================================
 * 店铺成长线（B）：现金 + 星级门槛的扩张投资
 * ------------------------------------------------------------------
 * 与需求I 第⑦条「区域扩建」(EXPANSIONS / state.expansions 复数) 完全解耦：
 * 那边是分区解锁 + 场景外扩，这边是「花钱 + 够星」买的 3 个永久投资项
 * （新货架排 / 店外夜市摊 / 装修升级），记录到 state.expansion（单数）。
 *
 * 设计要点：
 *  - 模块不认识 scene / world（避免循环依赖），场景副作用交给 main 通过
 *    onBuy 注入（main 里调 world.applyShelfRow / applyNightStall / applyRenovation）。
 *  - 星级判定走注入的 getStarLevel()（main 传 stars.level()），不在此硬编码。
 *  - 夜市摊被动收入 = 40 + round(reputation/100*20)，口碑 0~100；
 *    停电（powerOutUntil 进行中）不产出（防护/封锁主题当前无对应主题，钩子预留）。
 * ================================================================== */

import { state, expandSlots, notify } from './state.mjs';
import { GROWTH_EXPANSIONS } from './config.mjs';

/**
 * @param {object} opts
 * @param {() => number} [opts.getStarLevel] 当前星级（由 main 传 stars.level）
 * @param {(id: string) => void} [opts.onBuy] 购买成功后的场景副作用
 */
export function createExpansion({ getStarLevel = () => 1, onBuy = null } = {}) {
  /** 购买一项扩张投资 */
  function buyExpansion(id) {
    const item = GROWTH_EXPANSIONS.find((e) => e.id === id);
    if (!item) return { ok: false, reason: '未知扩张项' };
    if (state.expansion[id]) return { ok: false, reason: '已购买' };
    const lv = getStarLevel();
    if (lv < item.star) return { ok: false, reason: `需要 ★${item.star}` };
    if (state.cash < item.cost) return { ok: false, reason: '现金不足' };
    state.cash -= item.cost;
    state.expansion[id] = 1;
    if (id === 'shelfRow') expandSlots(2); // 兼容既有 expandSlots（默认 +4，此处 +2）
    notify();
    try { onBuy?.(id); } catch { /* 场景副作用失败不该拖垮购买 */ }
    return { ok: true, item };
  }

  /**
   * 夜市摊被动收入（结算时调用）。
   * 公式权威来源 config 注释：40 + round(reputation/100*20)，口碑取 0~100。
   * 停电（powerOutUntil 进行中）产出为 0。
   * @returns {number}
   */
  function stallIncome() {
    if (!state.expansion.nightStall) return 0;
    const po = state.powerOutUntil;
    if (po !== null && state.wallElapsed < po) return 0; // 停电不产出
    const rep = Math.max(0, Math.min(100, state.reputation ?? 0));
    return 40 + Math.round((rep / 100) * 20);
  }

  /** 读档 / 调试用：当前已购快照（防外部改 state.expansion） */
  function snapshot() {
    return { ...state.expansion };
  }

  return { buyExpansion, stallIncome, snapshot };
}
