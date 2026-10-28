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
    // 内容批 P1-9：八种出身（每流派 2 个）。第一个 origin 的牌组与该流派默认入门牌一致，
    // 保证「不选出身」时行为不变；其余引用 config/cards.js 已存在的 id，不新增卡。
    origins: [
      { id: 'edge', n: '持刃者', tag: '攻守平衡', deck: ['b.slash', 'b.stance'] },
      { id: 'brute', n: '莽夫', tag: '少一张架势，多一张蓄力', deck: ['b.slash', 'b.charge'] },
    ],
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
    origins: [
      { id: 'warden', n: '持盾者', tag: '攻守平衡', deck: ['f.ward', 'f.froststrike'] },
      { id: 'crystal', n: '凝霜者', tag: '多一张控制，少一张防御', deck: ['f.ward', 'f.freeze'] },
    ],
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
    origins: [
      { id: 'venom', n: '持毒者', tag: '攻守平衡', deck: ['r.poisonblade', 'r.miasma'] },
      { id: 'corroder', n: '腐蚀者', tag: '多一张毒性，少一张攻击', deck: ['r.miasma', 'r.corrode'] },
    ],
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
    origins: [
      { id: 'cycler', n: '持环者', tag: '攻守平衡', deck: ['x.spark', 'x.vent'] },
      { id: 'scholar', n: '研习者', tag: '多一张过牌，少一张充能', deck: ['x.spark', 'x.study'] },
    ],
  },
];

export const ARCHETYPE_MAP = Object.fromEntries(ARCHETYPES.map((a) => [a.id, a]));
