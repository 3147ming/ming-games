/**
 * 二手市场（模块 4 子功能②）
 *
 * ── 定位：只加不改，零 DOM / 零 THREE ──────────────────────
 * 二手设备是**抽象经营资产**，不新增任何 3D 机器（避免改动 scene/几何）。
 * 它只存在于 state.secondHand，在 Tab 商店的「二手」分页里买卖，
 * 每夜按"正常运转"的台数产出被动代币收益（叠加在既有的 tokens 体系上）。
 *
 * ── 与既有系统的边界 ──────────────────────────────────────
 *   · 二手设备**不**进 worldState 的设备故障/维修体系 —— 它自己的 faulty/broken 状态
 *     由本模块管理，修复走本模块的 repairOwned（不消耗 QTE/店员维修链路）。
 *   · 购买扣 state.cash、回收退 state.cash、收益加 state.tokens —— 全部走既有字段，
 *     不新增经济维度。
 *
 * ── 纯逻辑、零 THREE/DOM 依赖（可在 Node 单测） ─────────────
 */

import { SECONDHAND } from './config.mjs';

let seq = 1;

/**
 * @param opts.state    state.mjs 单一真源
 * @param opts.rng      () => number
 * @param opts.onEvent  (type, payload) => void
 */
export function createSecondHand(opts = {}) {
  const state = opts.state;
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};

  /** 确保 state.secondHand 结构存在（读档/老存档兜底） */
  function ensure() {
    if (!state.secondHand || typeof state.secondHand !== 'object') state.secondHand = { listings: [], owned: [] };
    if (!Array.isArray(state.secondHand.listings)) state.secondHand.listings = [];
    if (!Array.isArray(state.secondHand.owned)) state.secondHand.owned = [];
    return state.secondHand;
  }

  /** 每夜重新生成挂牌（旧挂牌丢弃，owned 保留） */
  function rollListings() {
    const sh = ensure();
    sh.listings = [];
    const kinds = SECONDHAND.kinds;
    for (let i = 0; i < SECONDHAND.listingsPerNight; i++) {
      const k = kinds[Math.floor(rng() * kinds.length)];
      const faulty = rng() < SECONDHAND.faultyChance;
      const variance = 0.85 + rng() * 0.3;
      const price = Math.max(20, Math.round(
        SECONDHAND.basePrice * (faulty ? SECONDHAND.faultyPriceMul : 1) * variance,
      ));
      sh.listings.push({
        id: `SH${seq++}`,
        kind: k.kind,
        name: k.name,
        emoji: k.emoji,
        price,
        faulty,
      });
    }
    return sh.listings;
  }

  /** 购买一台挂牌设备 */
  function buy(listingId) {
    const sh = ensure();
    const idx = sh.listings.findIndex((l) => l.id === listingId);
    if (idx < 0) return { ok: false, reason: 'not-found' };
    const listing = sh.listings[idx];
    if (state.cash < listing.price) return { ok: false, reason: 'insufficient', cost: listing.price };
    state.cash -= listing.price;
    const owned = {
      id: `OWN${seq++}`,
      kind: listing.kind,
      name: listing.name,
      emoji: listing.emoji,
      price: listing.price,
      faulty: listing.faulty,
      broken: listing.faulty, // 故障机买到手就是坏的，需要先修
    };
    sh.owned.push(owned);
    sh.listings.splice(idx, 1);
    onEvent('secondhand-buy', { id: owned.id, name: owned.name, faulty: owned.faulty });
    return { ok: true, owned };
  }

  /** 修复一台故障二手设备 */
  function repairOwned(ownedId) {
    const sh = ensure();
    const o = sh.owned.find((x) => x.id === ownedId);
    if (!o) return { ok: false, reason: 'not-found' };
    if (!o.broken) return { ok: false, reason: 'not-broken' };
    if (state.cash < SECONDHAND.repairCost) return { ok: false, reason: 'insufficient', cost: SECONDHAND.repairCost };
    state.cash -= SECONDHAND.repairCost;
    o.broken = false;
    onEvent('secondhand-repair', { id: o.id, name: o.name });
    return { ok: true, cost: SECONDHAND.repairCost };
  }

  /** 回收一台二手设备（退 50%） */
  function recycle(ownedId) {
    const sh = ensure();
    const idx = sh.owned.findIndex((x) => x.id === ownedId);
    if (idx < 0) return { ok: false, reason: 'not-found' };
    const o = sh.owned[idx];
    const refund = Math.floor(o.price * SECONDHAND.recycleMul);
    state.cash += refund;
    sh.owned.splice(idx, 1);
    onEvent('secondhand-recycle', { id: o.id, name: o.name, refund });
    return { ok: true, refund };
  }

  /** 每夜被动收益：正常运转（非故障/非坏）的二手设备各产出代币 */
  function nightlyIncome() {
    const sh = ensure();
    let total = 0;
    for (const o of sh.owned) {
      if (!o.broken) total += SECONDHAND.incomePerGood;
    }
    if (total > 0) {
      state.tokens = (state.tokens | 0) + total;
      onEvent('secondhand-income', { total });
    }
    return total;
  }

  /** 清场（夜末/读档把挂牌清掉，-owned 保留） */
  function reset() {
    const sh = ensure();
    sh.listings = [];
  }

  function snapshot() {
    const sh = ensure();
    return {
      listings: sh.listings.map((l) => ({ ...l })),
      owned: sh.owned.map((o) => ({ ...o })),
    };
  }

  return {
    ensure, rollListings, buy, repairOwned, recycle, nightlyIncome, reset, snapshot,
  };
}
