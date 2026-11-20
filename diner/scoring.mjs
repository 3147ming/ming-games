/**
 * 深夜食堂 · 评分与火候纯逻辑（Node 可单测）。
 * 四维加权：口味40 / 摆盘20 / 速度25 / 要求命中15 → 1-5 星。
 * 火候三态：欠火 / 正好 / 过火；过火影响口味分。
 * 六条特殊要求：少油/不要葱/加辣/面硬一点/蛋全熟/不要香菜。
 */
'use strict';

const SPECIALS = ['少油', '不要葱', '加辣', '面硬一点', '蛋全熟', '不要香菜'];

/** 火候三态：progress 为烹饪进度 0..1（1=理论正好）。 */
function heatState(progress) {
  if (progress < 0.85) return 'raw';       // 欠火（黄）
  if (progress <= 1.15) return 'perfect';  // 正好（绿）
  return 'burnt';                          // 过火（红，焦色）
}
const HEAT_LABEL = { raw: '欠火', perfect: '正好', burnt: '过火' };

/**
 * 四维加权评分。
 * @param opts {
 *   foodOK:boolean,        // 餐点是否正确
 *   heat:'raw|perfect|burnt', // 火候
 *   platedRatio:number,    // 摆盘完成度 0..1
 *   patienceRatio:number,  // 速度：耐心剩余 0..1
 *   reqHit:number, reqTotal:number // 要求命中
 * }
 * @returns {stars, score, parts:{taste,plate,speed,req}}
 */
function rate(opts) {
  const heat = opts.heat || 'perfect';
  const heatMul = heat === 'perfect' ? 1 : heat === 'raw' ? 0.65 : 0.4;
  const taste = (opts.foodOK ? 1 : 0.2) * heatMul * 40;          // 口味 40
  const plate = clamp(opts.platedRatio ?? 1, 0, 1) * 20;         // 摆盘 20
  const speed = clamp(opts.patienceRatio ?? 0.5, 0, 1) * 25;     // 速度 25
  const total = Math.max(1, opts.reqTotal || 0);
  const req = (clamp(opts.reqHit || 0, 0, total) / total) * 15;  // 要求 15
  const score = taste + plate + speed + req;                     // 0..100
  const stars = Math.max(1, Math.min(5, Math.round(score / 20)));
  return { stars, score: +score.toFixed(1), parts: {
    taste: +taste.toFixed(1), plate: +plate.toFixed(1), speed: +speed.toFixed(1), req: +req.toFixed(1),
  } };
}

/** 小费：1★0 / 3★+20% / 5★+50%，线性插值。 */
function tipRate(stars) {
  if (stars <= 1) return 0;
  if (stars >= 5) return 0.5;
  return { 2: 0.1, 3: 0.2, 4: 0.35 }[stars] || 0;
}
function tipFor(stars, base) { return Math.round(base * tipRate(stars)); }

/** 六条特殊要求逐条匹配（客户要求 want，玩家选择 got）。 */
function matchSpecials(want, got) {
  const hit = want.filter(s => (got || []).indexOf(s) >= 0);
  const miss = want.filter(s => (got || []).indexOf(s) < 0);
  const extra = (got || []).filter(s => want.indexOf(s) < 0);
  return { hit, miss, extra, hitCount: hit.length, total: want.length };
}

/** 顾客三档耐心秒数。 */
const PATIENCE = { rush: 40, normal: 60, slow: 90 };

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

export { SPECIALS, heatState, HEAT_LABEL, rate, tipRate, tipFor, matchSpecials, PATIENCE };
