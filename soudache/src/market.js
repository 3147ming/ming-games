/**
 * 本地交易行报价（P2 交互层，纯数据模块、零 DOM、零联网）。
 *
 * 设计边界（用户 2026-11-10 明确要求）：
 *   · 交易行目前**只用于物资购买**：按本地 NPC 报价买入一件物品。
 *   · 没有共享物资总数：报价单是「本次刷新的一张价目表」，由种子确定性生成，
 *     刷新只重掷种子；本地收购价也由种子推导，不代表跨局行情或真实成交历史。
 *   · P10 起玩家可以把自己的仓库物资交给本地收购商，个人委托单会写进存档；
 *     但依然没有共享物资总数、没有跨局库存账本、没有全局限购额度，
 *     撮合对象始终是本地模拟的 NPC，不是别的玩家或服务器。
 *
 * 之所以做成纯函数：Node 能直测确定性；main.js 买入时用同一个种子复算报价，
 * 防止 DOM 被改价后按伪造价格成交。存档读写不在本模块，交给 economy.js / storage.js。
 */
import { ITEMS, SHOP, SHOP_TIER, CAREER } from './config.js';

export const MARKET = Object.freeze({
  listingCount: 6,
  /** 报价浮动：0.82 ~ 1.18 倍基准价，步长 0.01 */
  bandSteps: 37,
  baseMul: 0.82,
  sellers: Object.freeze([
    'RELAY-07', 'DOCK-12', 'QUARTERMASTER', 'FIELD-03', 'CARAVAN-9', 'DEPOT-21',
  ]),
});

/** 32 位整数混淆：同一个 (seed, i) 恒定得到同一个值，不消耗全局 RNG。 */
function mix(seed, i) {
  let x = ((Number(seed) >>> 0) ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/**
 * 生成本地报价单。
 * @param {number} seed 本地种子（日期种子 + 刷新序号，不来自网络）
 * @param {number} [count] 报价条数
 * @returns {Array<{key:string,id:string,name:string,rarity:string,category:string,
 *   base:number,price:number,delta:number,trend:string,seller:string,tier:number}>}
 */
export function rollListings(seed, count = MARKET.listingCount) {
  const pool = SHOP.items.filter((id) => ITEMS[id]);
  if (!pool.length) return [];
  const seen = new Set();
  const out = [];
  for (let i = 0; out.length < count && i < count * 12; i += 1) {
    const h = mix(seed, i);
    const id = pool[h % pool.length];
    if (seen.has(id)) continue;
    seen.add(id);
    const def = ITEMS[id];
    const h2 = mix((Number(seed) >>> 0) ^ 0x5bf03635, i);
    const mul = MARKET.baseMul + (h2 % MARKET.bandSteps) / 100;
    const price = Math.max(1, Math.round(def.value * mul));
    const delta = Math.round((mul - 1) * 100);
    out.push({
      key: `${seed >>> 0}-${i}-${id}`,
      id,
      name: def.name,
      rarity: def.rarity,
      category: def.category,
      base: def.value,
      price,
      delta,
      trend: delta > 2 ? 'up' : (delta < -2 ? 'down' : 'flat'),
      seller: MARKET.sellers[(h2 >>> 8) % MARKET.sellers.length],
      tier: SHOP_TIER[id] || 1,
    });
  }
  return out;
}

/**
 * 按 key 复算报价。买入时必须走这里，而不是信任 DOM 传来的价格。
 * @returns {object|null} 找不到返回 null
 */
export function findListing(seed, key, count = MARKET.listingCount) {
  if (typeof key !== 'string') return null;
  return rollListings(seed, count).find((l) => l.key === key) || null;
}

/* ==================== P10：本地收购指数与个人委托单 ==================== */

/**
 * 本地收购指数（0.90 ~ 1.10）。只由种子决定，同种子逐位一致；
 * 这是给玩家看的一口价浮动，不是跨局累积的行情曲线，也不参与局内数值。
 */
export function marketIndex(seed) {
  const h = mix((Number(seed) >>> 0) ^ 0x51ed270b, 91);
  return 0.9 + (h % 21) / 100;
}

/**
 * 收购商对一件物资的一口价。基准是既有的出售比例（SHOP.sellRatio），
 * 叠加当日指数与稀有度溢价后扣手续费 —— 整体仍在 ±20% 内，不破坏原有平衡。
 * @param {number} baseValue 该件物资的 itemValue 结果（由调用方按盒/发口径算好）
 * @param {string} rarity 稀有度
 * @param {number} seed 本地种子
 */
export function sellQuote(baseValue, rarity, seed) {
  const base = Math.max(0, Number(baseValue) || 0);
  const index = marketIndex(seed);
  const rarityMul = (CAREER.consign.rarityMul && CAREER.consign.rarityMul[rarity]) || 1;
  const gross = Math.max(1, Math.round(base * SHOP.sellRatio * index * rarityMul));
  const fee = Math.round(gross * CAREER.consign.fee);
  return { base, index, rarityMul, gross, fee, net: Math.max(1, gross - fee) };
}

/** 委托单是否到点可以结算；纯判断，不改动任何对象。 */
export function isOrderDue(order, now) {
  return Boolean(order && Number.isFinite(Number(order.settleAt)) && Number(now) >= Number(order.settleAt));
}
