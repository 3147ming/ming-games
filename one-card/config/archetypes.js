// 4 流派定义
// 口径：每个流派必须有「一个可被玩家一句话描述的获胜方式」，否则不算流派。
// 每个流派至少 3 张关键卡构成最小 combo 环（施法源 + 增幅 + 触发），这是 D_min 推导的前提。

export const ARCHETYPES = [
  {
    id: 'blade',
    name: '刃',
    ui: '斩',
    color: 'blade',
    tag: '直伤 / 连击 / 力量',
    // 一句话获胜方式（玩家能自己说出口，是可辨识性的判定标准）
    winLine: '把力量堆起来，用一次多段攻击带走。',
    keyCards: ['b.charge', 'b.dualblade', 'b.bladedance'],
    starter: ['b.slash', 'b.stance'],
  },
  {
    id: 'frost',
    name: '霜',
    ui: '盾',
    color: 'frost',
    tag: '格挡 / 虚弱 / 灵巧',
    winLine: '让敌人打不动你，再靠易伤反打。',
    keyCards: ['f.permafrost', 'f.shatter', 'f.stasis'],
    starter: ['f.ward', 'f.froststrike'],
  },
  {
    id: 'rot',
    name: '蚀',
    ui: '毒',
    color: 'rot',
    tag: '中毒 / 持续伤害 / 自我消耗',
    winLine: '用生命换毒层，让敌人在自己的回合里掉血。',
    keyCards: ['r.corrupt', 'r.plague', 'r.heartrot'],
    starter: ['r.poisonblade', 'r.miasma'],
  },
  {
    id: 'flux',
    name: '熵',
    ui: '环',
    color: 'flux',
    tag: '能量 / 抽牌 / 循环',
    winLine: '把能量和手牌滚起来，在一回合里打出整个牌库。',
    keyCards: ['x.cycle', 'x.overload', 'x.perpetual'],
    starter: ['x.spark', 'x.vent'],
  },
];

export const ARCHETYPE_MAP = Object.fromEntries(ARCHETYPES.map((a) => [a.id, a]));
