/**
 * 定价系统（单品调价 ±20% / 全店限时促销 / 临期提醒）
 *
 * ── 为什么不新造一套价格字段 ──────────────────────────────
 * state.prices[skuId] 与"价格弹性"（customers.demandMul）是既有的一对机制：
 * 售价高于建议价 → 需求按 ELASTICITY_K 下降。
 * 所以"玩家调价"直接**写进 state.prices** 就好 —— 销量变慢/走量快是自动的，
 * 不需要再写一遍弹性公式。调价系数另存 state.priceMul（因为需要 base 才能调回去）。
 *
 * 而"全店 9 折""促销夜 8 折"这类**临时**折扣不能写进 state.prices：
 * 它们会过期，写进去就得记着恢复，一旦中途存档/读档就会留下脏价格。
 * 所以临时折扣只在结账那一刻乘上去（checkoutAdjust），不改任何持久字段。
 *
 * ── 纯逻辑、零 DOM/THREE 依赖 ────────────────────────────
 */

import { SKU_BY_ID, NIGHT_WALL_SECONDS, GAME_HOURS } from './config.mjs';

export const PRICING = {
  /** 单品调价范围（需求：±20%） */
  minMul: 0.8,
  maxMul: 1.2,
  step: 0.05,
  /** 售价每高于建议价 10% 带来的满意度惩罚系数（小降，不是硬惩罚） */
  repPenaltyK: 0.15,
  /** 限时促销（2026-10-05 重做：拉客型促销 —— 开时一波 + 期间持续高客流；
   *  数值经 sim-promo 2万次蒙特卡洛校准：cost60/wave10 理想态净利约+¥23） */
  promo: {
    cost: 60,
    /** 持续**游戏内**分钟（一夜 = 8 游戏小时 = 480 游戏分钟） */
    durationMin: 40,
    mul: 0.9,
    /** 开启时立刻引来的客流波人数 */
    wave: 10,
    /** 促销期间购物顾客额外生成倍率（customers.mjs 读 state.promoUntil 判定） */
    trafficMul: 2.2,
    /** 促销让利记在账本上的 key */
    ledgerKey: 'promo.discount',
  },
};

/** 15 游戏分钟 → 墙钟秒（一夜 480 墙钟秒 = 8 游戏小时 = 480 游戏分钟 → 1:1） */
export function gameMinToWallSec(min) {
  return (min / (GAME_HOURS * 60)) * (NIGHT_WALL_SECONDS ?? 480);
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const numOr = (v, d = 0) => (Number.isFinite(v) ? v : d);

/**
 * @param {object} opts
 * @param {object} opts.state
 * @param {object} opts.api { payCash, toast, ledger, spawnWave }
 */
export function createPricing(opts = {}) {
  const state = opts.state;
  const api = opts.api ?? {};

  const muls = () => {
    if (!state.priceMul || typeof state.priceMul !== 'object') state.priceMul = {};
    return state.priceMul;
  };

  function basePrice(skuId) {
    return numOr(SKU_BY_ID[skuId]?.price, 1);
  }

  /** 玩家对某 SKU 的调价系数（缺省 1） */
  function mulOf(skuId) {
    return clamp(numOr(muls()[skuId], 1), PRICING.minMul, PRICING.maxMul);
  }

  /** 写入调价：**同时**把结果写进 state.prices（既有弹性与显示都读它） */
  function setMul(skuId, mul) {
    const m = clamp(mul, PRICING.minMul, PRICING.maxMul);
    muls()[skuId] = m;
    if (!state.prices || typeof state.prices !== 'object') state.prices = {};
    state.prices[skuId] = Math.round(basePrice(skuId) * m * 100) / 100;
    return { skuId, mul: m, price: state.prices[skuId] };
  }

  /** 按档位增减（UI 的 +/− 按钮） */
  function adjust(skuId, dir = 1) {
    return setMul(skuId, Math.round((mulOf(skuId) + dir * PRICING.step) * 100) / 100);
  }

  function reset(skuId) {
    return setMul(skuId, 1);
  }

  /* ---------- 限时促销 ---------- */

  function promoActive(now = state.wallElapsed) {
    return state.promoUntil !== null && state.promoUntil !== undefined && now < state.promoUntil;
  }

  function promoRemaining(now = state.wallElapsed) {
    return promoActive(now) ? Math.max(0, state.promoUntil - now) : 0;
  }

  function startPromo(now = state.wallElapsed) {
    if (promoActive(now)) return { ok: false, reason: '促销进行中' };
    const paid = typeof api.payCash === 'function'
      ? api.payCash(PRICING.promo.cost, '限时促销')
      : { ok: true };
    if (!paid?.ok) return { ok: false, reason: paid?.reason ?? '现金不足' };
    state.promoUntil = now + gameMinToWallSec(PRICING.promo.durationMin);
    // 立刻引来一波客流
    try { api.spawnWave?.(PRICING.promo.wave); } catch { /* 客流波失败不该吞掉促销 */ }
    api.ledger?.(PRICING.promo.ledgerKey, '限时促销费用', -PRICING.promo.cost, 'promo');
    return {
      ok: true,
      until: state.promoUntil,
      durationSec: gameMinToWallSec(PRICING.promo.durationMin),
      mul: PRICING.promo.mul,
    };
  }

  /** 促销自然到期（供 HUD 横幅收起） */
  function tick(now = state.wallElapsed) {
    if (state.promoUntil !== null && now >= state.promoUntil) {
      state.promoUntil = null;
      return true; // 刚刚结束
    }
    return false;
  }

  /* ---------- 结账时的合成乘数 ---------- */

  /**
   * 结账时套在单价上的**临时**折扣（促销 / 主题）+ 满意度修正。
   * 由 economy.checkout 通过 setCheckoutHook 注入调用。
   * @returns { mul:number, repDelta:number, promo:boolean, discount:number }
   */
  function checkoutAdjust(skuId, opts = {}) {
    const themeMul = numOr(opts.themePriceMul, 1);
    const promoMul = promoActive() ? PRICING.promo.mul : 1;
    const mul = themeMul * promoMul;
    // 售价高于建议价的满意度惩罚：+20% → -0.3（小降）
    const ratio = mulOf(skuId);
    const repDelta = ratio > 1 ? -(ratio - 1) * 10 * PRICING.repPenaltyK : 0;
    return { mul, repDelta, promo: promoMul !== 1, discount: 1 - mul };
  }

  /* ---------- 临期 ---------- */

  /** 该格是否"临期"（今夜结束就过期 → 标黄提醒） */
  function isExpiring(slot) {
    if (!slot || !slot.skuId || !(slot.qty > 0)) return false;
    return numOr(state.night, 1) >= numOr(slot.expiryNight, 0);
  }

  function expiringSlots() {
    return (Array.isArray(state.slots) ? state.slots : [])
      .map((s, i) => ({ index: i, slot: s }))
      .filter((x) => isExpiring(x.slot));
  }

  /** 今夜结束会过期报废的库存估值（结算里单列一行） */
  function expiringValue() {
    let total = 0;
    for (const { slot } of expiringSlots()) {
      total += (slot.qty ?? 0) * numOr(SKU_BY_ID[slot.skuId]?.cost, 0);
    }
    return Math.round(total * 100) / 100;
  }

  return {
    setMul, adjust, reset, mulOf, basePrice,
    startPromo, promoActive, promoRemaining, tick,
    checkoutAdjust, isExpiring, expiringSlots, expiringValue,
    /** 面板数据（Tab 商店的定价页） */
    sheet() {
      return Object.keys(state.prices ?? {}).map((id) => ({
        skuId: id,
        name: SKU_BY_ID[id]?.name ?? id,
        emoji: SKU_BY_ID[id]?.emoji ?? '📦',
        base: basePrice(id),
        price: numOr(state.prices[id], basePrice(id)),
        mul: mulOf(id),
        /** 相对建议价的需求倍率预览（与 customers.demandMul 同一公式） */
        demand: Math.max(0.3, Math.min(1.8, 1 - 1.5 * (mulOf(id) - 1))),
      }));
    },
    snapshot() {
      return {
        promo: promoActive() ? { remaining: promoRemaining(), mul: PRICING.promo.mul } : null,
        cost: PRICING.promo.cost,
        expiring: expiringSlots().length,
        muls: { ...muls() },
      };
    },
  };
}

export default createPricing;
