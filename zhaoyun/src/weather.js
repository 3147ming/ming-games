/**
 * 赵云与阿斗 · 天气（weather.js）— 纯数据 + 纯函数，零依赖、零 DOM
 * ---------------------------------------------------------------------------
 * 设计目标：给八关八图各自一点"这一关气质不同"的感受，
 * 但**绝不引入随机性** —— 天气由关卡序号决定，同一关永远是同一个天气。
 *
 * 为什么只改伤害、不改移速/射程：
 *   移速和射程散落在寻路与索敌的多处，改它们要动 B.threatsInRange 与行军推进，
 *   一旦漏掉一处就是"雾天弓兵射程没变"这种只在特定关卡出现的诡异 bug。
 *   伤害只有 hurt() 一个收口（所有伤害都从那儿过），改一处就全对 ——
 *   这是"用最少的改动换取最大的确定性"。
 *
 * 数值取向：天气是**双刃**的，不能只让我方变弱（那是惩罚而不是玩法）。
 *   晴：无修正（基准）
 *   雨：我方 -8%（弓弦受潮）            → 玩家要更耐心地攒兵
 *   雾：我方 -12% / 敌方 -6%            → 双方都弱，但玩家更吃亏，节奏变慢
 *   风：双方 +6%                        → 双方都猛，战斗更快结束
 */
(function (ZY) {
  'use strict';

  var WEATHERS = [
    {
      id: 'clear', name: '晴', glyph: '☀',
      note: '视野开阔，双方发挥正常',
      dmgMul: { player: 1.00, enemy: 1.00 },
    },
    {
      id: 'rain', name: '雨', glyph: '☂',
      note: '弓弦受潮 —— 我方伤害 -8%',
      dmgMul: { player: 0.92, enemy: 1.00 },
    },
    {
      id: 'fog', name: '雾', glyph: '≋',
      note: '敌我不辨 —— 我方伤害 -12%，敌方 -6%',
      dmgMul: { player: 0.88, enemy: 0.94 },
    },
    {
      id: 'wind', name: '风', glyph: '≫',
      note: '顺风助势 —— 双方伤害 +6%',
      dmgMul: { player: 1.06, enemy: 1.06 },
    },
  ];

  var BY_ID = {};
  for (var i = 0; i < WEATHERS.length; i++) BY_ID[WEATHERS[i].id] = WEATHERS[i];

  /** 按 id 取天气定义；未知 id 一律回落到"晴"（不崩） */
  function byId(id) {
    return BY_ID[id] || WEATHERS[0];
  }

  /**
   * 关卡 → 天气。用 levelIdx 取模，保证：
   *   · 同一关永远同一天气（可复现，探针与测试都能依赖）
   *   · 相邻两关天气不同（不会连着两关都是雨）
   */
  function forLevel(levelIdx) {
    var n = Number(levelIdx);
    if (!isFinite(n) || n < 0) n = 0;
    return WEATHERS[Math.floor(n) % WEATHERS.length];
  }

  /**
   * 取某一方的伤害倍率。
   * @param weather 天气 id 或天气对象（两种都收，调用点不用先查一遍）
   * @param side    'player' | 'enemy'；其它值按 1 处理（比如中立来源的火球）
   */
  function dmgMul(weather, side) {
    var w = typeof weather === 'string' ? byId(weather) : (weather || WEATHERS[0]);
    var m = w.dmgMul || {};
    var v = Number(m[side]);
    return isFinite(v) && v > 0 ? v : 1;
  }

  ZY.Weather = {
    WEATHERS: WEATHERS,
    byId: byId,
    forLevel: forLevel,
    dmgMul: dmgMul,
  };
})(window.ZY);
