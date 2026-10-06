// 卡牌配置表（60 张 = 4 流派 × 15）
// 字段：id / a=流派 / n=牌名 / t=类型 / cost=能量 / r=稀有度(1-3) / ops=效果 / ex=消耗 / starter=入门牌 / sealed=初始封印
// 关键口径：卡面描述由 ops 自动生成（见 src/describe.js），因此配置与文案永远不可能漂移。
// 加一张卡 = 加一条数据，0 行战斗循环代码改动 —— 这是「选对类型」的硬指标。

export const CARDS = [
  // ============ 通用基础牌（不入奖励池，由起始牌组给出）============
  { id: 'base.strike', a: 'basic', n: '打击', t: 'attack', cost: 1, r: 0, ops: [{ op: 'damage', value: 6 }] },
  { id: 'base.defend', a: 'basic', n: '防御', t: 'skill', cost: 1, r: 0, ops: [{ op: 'block', value: 5 }] },

  // ============ 刃 blade（直伤 / 连击 / 力量）============
  { id: 'b.slash', a: 'blade', n: '斩击', t: 'attack', cost: 1, r: 1, starter: true, ops: [{ op: 'damage', value: 8 }] },
  { id: 'b.stance', a: 'blade', n: '架势', t: 'skill', cost: 1, r: 1, starter: true, ops: [{ op: 'block', value: 5 }, { op: 'status', status: 'str', value: 1, who: 'self' }] },
  { id: 'b.combo', a: 'blade', n: '连斩', t: 'attack', cost: 1, r: 1, ops: [{ op: 'damage', value: 4, times: 2 }] },
  { id: 'b.charge', a: 'blade', n: '蓄力', t: 'power', cost: 1, r: 1, ops: [{ op: 'status', status: 'str', value: 2, who: 'self' }] },
  { id: 'b.cleave', a: 'blade', n: '重劈', t: 'attack', cost: 2, r: 1, ops: [{ op: 'damage', value: 14 }] },
  { id: 'b.cut', a: 'blade', n: '流血', t: 'attack', cost: 1, r: 1, ops: [{ op: 'damage', value: 5 }, { op: 'status', status: 'vuln', value: 2, who: 'enemy' }] },
  { id: 'b.rage', a: 'blade', n: '狂暴', t: 'skill', cost: 1, r: 2, ops: [{ op: 'status', status: 'str', value: 1, who: 'self' }, { op: 'draw', value: 1 }] },
  { id: 'b.hack', a: 'blade', n: '劈砍', t: 'attack', cost: 0, r: 2, ops: [{ op: 'damage', value: 4 }] },
  { id: 'b.execute', a: 'blade', n: '处决', t: 'attack', cost: 2, r: 3, sealed: true, ops: [{ op: 'damage', value: 10 }, { op: 'if', cond: { type: 'enemyHpBelowHalf' }, then: [{ op: 'damage', value: 10 }] }] },
  { id: 'b.dualblade', a: 'blade', n: '双刃', t: 'attack', cost: 1, r: 2, ops: [{ op: 'damage', value: 3, times: 3 }] },
  { id: 'b.sunder', a: 'blade', n: '破甲', t: 'attack', cost: 1, r: 2, sealed: true, ops: [{ op: 'damage', value: 6 }, { op: 'status', status: 'vuln', value: 3, who: 'enemy' }] },
  { id: 'b.bloodrage', a: 'blade', n: '血怒', t: 'skill', cost: 1, r: 2, sealed: true, ops: [{ op: 'loseHp', value: 3 }, { op: 'status', status: 'str', value: 3, who: 'self' }] },
  { id: 'b.smash', a: 'blade', n: '猛击', t: 'attack', cost: 2, r: 2, sealed: true, ops: [{ op: 'damage', value: 12 }, { op: 'status', status: 'weak', value: 1, who: 'enemy' }] },
  { id: 'b.bladedance', a: 'blade', n: '刃舞', t: 'attack', cost: 2, r: 3, sealed: true, ops: [{ op: 'damage', value: 5, times: 3 }] },
  { id: 'b.finalcut', a: 'blade', n: '绝命', t: 'attack', cost: 3, r: 3, sealed: true, ops: [{ op: 'damage', value: 30 }] },

  // ============ 霜 frost（格挡 / 虚弱 / 灵巧）============
  { id: 'f.ward', a: 'frost', n: '冰盾', t: 'skill', cost: 1, r: 1, starter: true, ops: [{ op: 'block', value: 8 }] },
  { id: 'f.froststrike', a: 'frost', n: '霜击', t: 'attack', cost: 1, r: 1, starter: true, ops: [{ op: 'damage', value: 5 }, { op: 'block', value: 4 }] },
  { id: 'f.freeze', a: 'frost', n: '凝冰', t: 'skill', cost: 1, r: 1, ops: [{ op: 'status', status: 'weak', value: 2, who: 'enemy' }] },
  { id: 'f.bulwark', a: 'frost', n: '壁垒', t: 'skill', cost: 2, r: 1, ops: [{ op: 'block', value: 14 }] },
  { id: 'f.coldwave', a: 'frost', n: '寒潮', t: 'skill', cost: 2, r: 2, sealed: true, ops: [{ op: 'block', value: 8 }, { op: 'status', status: 'weak', value: 1, who: 'enemy' }, { op: 'status', status: 'vuln', value: 1, who: 'enemy' }] },
  { id: 'f.icicle', a: 'frost', n: '冰锥', t: 'attack', cost: 1, r: 1, ops: [{ op: 'damage', value: 4 }, { op: 'block', value: 3 }] },
  { id: 'f.reflect', a: 'frost', n: '反射', t: 'attack', cost: 1, r: 2, ops: [{ op: 'block', value: 6 }, { op: 'if', cond: { type: 'enemyHasStatus', status: 'vuln' }, then: [{ op: 'damage', value: 8 }] }] },
  { id: 'f.guardbreak', a: 'frost', n: '护霜', t: 'skill', cost: 0, r: 2, ops: [{ op: 'block', value: 4 }] },
  { id: 'f.permafrost', a: 'frost', n: '冻土', t: 'power', cost: 2, r: 2, ops: [{ op: 'block', value: 12 }, { op: 'status', status: 'dex', value: 1, who: 'self' }] },
  { id: 'f.shatter', a: 'frost', n: '碎冰', t: 'attack', cost: 1, r: 2, ops: [{ op: 'damage', value: 7 }, { op: 'if', cond: { type: 'enemyHasStatus', status: 'vuln' }, then: [{ op: 'damage', value: 7 }] }] },
  { id: 'f.icewall', a: 'frost', n: '冰壁', t: 'skill', cost: 3, r: 3, sealed: true, ops: [{ op: 'block', value: 22 }] },
  { id: 'f.stasis', a: 'frost', n: '静滞', t: 'skill', cost: 1, r: 2, sealed: true, ops: [{ op: 'block', value: 5 }, { op: 'status', status: 'dex', value: 2, who: 'self' }] },
  { id: 'f.spire', a: 'frost', n: '霜刺', t: 'attack', cost: 1, r: 2, sealed: true, ops: [{ op: 'damage', value: 6 }, { op: 'status', status: 'vuln', value: 2, who: 'enemy' }] },
  { id: 'f.frostartor', a: 'frost', n: '寒霜甲', t: 'power', cost: 2, r: 2, sealed: true, ops: [{ op: 'block', value: 10 }, { op: 'status', status: 'dex', value: 1, who: 'self' }] },
  { id: 'f.absolutezero', a: 'frost', n: '绝对零度', t: 'skill', cost: 3, r: 3, sealed: true, ops: [{ op: 'block', value: 20 }, { op: 'status', status: 'weak', value: 3, who: 'enemy' }] },

  // ============ 蚀 rot（中毒 / 持续伤害 / 自我消耗）============
  { id: 'r.poisonblade', a: 'rot', n: '毒刃', t: 'attack', cost: 1, r: 1, starter: true, ops: [{ op: 'damage', value: 4 }, { op: 'status', status: 'poison', value: 3, who: 'enemy' }] },
  { id: 'r.miasma', a: 'rot', n: '蚀息', t: 'skill', cost: 1, r: 1, starter: true, ops: [{ op: 'status', status: 'poison', value: 4, who: 'enemy' }] },
  { id: 'r.corrode', a: 'rot', n: '腐蚀', t: 'skill', cost: 1, r: 1, ops: [{ op: 'status', status: 'poison', value: 5, who: 'enemy' }] },
  { id: 'r.plague', a: 'rot', n: '瘟疫', t: 'skill', cost: 2, r: 2, ops: [{ op: 'status', status: 'poison', value: 8, who: 'enemy' }] },
  { id: 'r.boneeater', a: 'rot', n: '蚀骨', t: 'attack', cost: 1, r: 2, ops: [{ op: 'damage', value: 6 }, { op: 'if', cond: { type: 'enemyHasStatus', status: 'poison' }, then: [{ op: 'damage', value: 4 }] }] },
  { id: 'r.corrupt', a: 'rot', n: '腐化', t: 'skill', cost: 1, r: 2, ops: [{ op: 'status', status: 'poison', value: 3, who: 'enemy' }, { op: 'status', status: 'vuln', value: 2, who: 'enemy' }] },
  { id: 'r.fester', a: 'rot', n: '溃烂', t: 'skill', cost: 1, r: 2, ops: [{ op: 'status', status: 'poison', value: 4, who: 'enemy' }, { op: 'block', value: 3 }] },
  { id: 'r.sacrifice', a: 'rot', n: '献祭', t: 'skill', cost: 0, r: 2, ops: [{ op: 'loseHp', value: 4 }, { op: 'status', status: 'poison', value: 6, who: 'enemy' }] },
  { id: 'r.toxicfog', a: 'rot', n: '毒雾', t: 'skill', cost: 1, r: 2, ops: [{ op: 'status', status: 'poison', value: 3, who: 'enemy' }, { op: 'status', status: 'weak', value: 1, who: 'enemy' }] },
  { id: 'r.erode', a: 'rot', n: '侵蚀', t: 'attack', cost: 2, r: 2, sealed: true, ops: [{ op: 'damage', value: 8 }, { op: 'status', status: 'poison', value: 4, who: 'enemy' }] },
  { id: 'r.moonrot', a: 'rot', n: '蚀月', t: 'skill', cost: 2, r: 2, sealed: true, ops: [{ op: 'status', status: 'poison', value: 6, who: 'enemy' }, { op: 'draw', value: 1 }] },
  { id: 'r.badblood', a: 'rot', n: '腐血', t: 'skill', cost: 1, r: 2, sealed: true, ops: [{ op: 'loseHp', value: 3 }, { op: 'status', status: 'poison', value: 5, who: 'enemy' }, { op: 'block', value: 5 }] },
  { id: 'r.dissolve', a: 'rot', n: '溶解', t: 'attack', cost: 2, r: 3, sealed: true, ops: [{ op: 'damage', value: 10 }, { op: 'status', status: 'poison', value: 5, who: 'enemy' }] },
  { id: 'r.heartrot', a: 'rot', n: '蚀心', t: 'skill', cost: 3, r: 3, sealed: true, ops: [{ op: 'status', status: 'poison', value: 14, who: 'enemy' }] },
  { id: 'r.finalrot', a: 'rot', n: '终末之蚀', t: 'attack', cost: 3, r: 3, sealed: true, ops: [{ op: 'damage', value: 10 }, { op: 'status', status: 'poison', value: 10, who: 'enemy' }] },

  // ============ 熵 flux（能量 / 抽牌 / 循环）============
  { id: 'x.spark', a: 'flux', n: '火花', t: 'attack', cost: 0, r: 1, starter: true, ops: [{ op: 'damage', value: 3 }] },
  { id: 'x.vent', a: 'flux', n: '泄能', t: 'skill', cost: 1, r: 1, starter: true, ops: [{ op: 'energy', value: 2 }] },
  { id: 'x.study', a: 'flux', n: '研读', t: 'skill', cost: 0, r: 1, ops: [{ op: 'draw', value: 2 }] },
  { id: 'x.cycle', a: 'flux', n: '循环', t: 'skill', cost: 1, r: 2, ops: [{ op: 'draw', value: 2 }, { op: 'energy', value: 1 }] },
  { id: 'x.synapse', a: 'flux', n: '突触', t: 'attack', cost: 0, r: 2, ops: [{ op: 'damage', value: 2 }, { op: 'draw', value: 1 }] },
  // ★ 阶段 3 / G1：x.overload 解封（封印卡 24 → 23）。
  //   理由：熵流三张关键卡里原本有两张被封印（x.overload + x.perpetual），
  //   导致 59.36% 的局一张关键卡都摸不到，远差于其余流派（21%~36%）。
  //   解封后熵流初始可得 2/3，落回同区间。见 docs/05-数值校准与UI.md §T1。
  { id: 'x.overload', a: 'flux', n: '过载', t: 'skill', cost: 2, r: 2, ops: [{ op: 'energy', value: 3 }, { op: 'draw', value: 1 }] },
  { id: 'x.quantum', a: 'flux', n: '量子跃迁', t: 'attack', cost: 1, r: 2, ops: [{ op: 'damage', value: 6 }, { op: 'draw', value: 1 }] },
  { id: 'x.entropy', a: 'flux', n: '熵增', t: 'attack', cost: 2, r: 2, ops: [{ op: 'damage', value: 4, times: 2 }, { op: 'energy', value: 1 }] },
  { id: 'x.echo', a: 'flux', n: '回响', t: 'attack', cost: 1, r: 1, ops: [{ op: 'damage', value: 5 }, { op: 'draw', value: 1 }] },
  { id: 'x.recurse', a: 'flux', n: '递归', t: 'skill', cost: 1, r: 2, ex: true, sealed: true, ops: [{ op: 'draw', value: 3 }] },
  { id: 'x.burst', a: 'flux', n: '爆发', t: 'skill', cost: 1, r: 3, ex: true, sealed: true, ops: [{ op: 'energy', value: 2 }, { op: 'draw', value: 2 }] },
  { id: 'x.fold', a: 'flux', n: '折叠', t: 'attack', cost: 2, r: 2, sealed: true, ops: [{ op: 'damage', value: 9 }, { op: 'draw', value: 1 }] },
  { id: 'x.singularity', a: 'flux', n: '奇点', t: 'attack', cost: 3, r: 3, sealed: true, ops: [{ op: 'damage', value: 20 }, { op: 'draw', value: 2 }] },
  { id: 'x.sketch', a: 'flux', n: '速写', t: 'attack', cost: 1, r: 1, ops: [{ op: 'damage', value: 4 }, { op: 'energy', value: 1 }] },
  { id: 'x.perpetual', a: 'flux', n: '永动', t: 'skill', cost: 3, r: 3, ex: true, sealed: true, ops: [{ op: 'energy', value: 3 }, { op: 'draw', value: 3 }] },

  // ============ 荒野牌（阶段 6 · 实时割草关「荒野遭遇」奖励，也在普通卡牌战池内可抽到）============
  // 不封印（sealed 缺省 false）→ 默认解锁，进奖励池；数值对齐同流派现有牌（spec §3）。
  // 流派按 spec §3 指定：猎手=刃(blade) 输出 / 壁垒=蚀(rot) 生存(格挡+回血) / 疾风=霜(frost) 过牌。
  { id: 'wild.hunter', a: 'blade', n: '荒野·猎手', t: 'attack', cost: 1, r: 2, ops: [{ op: 'damage', value: 10 }] },
  { id: 'wild.bastion', a: 'rot', n: '荒野·壁垒', t: 'skill', cost: 1, r: 2, ops: [{ op: 'block', value: 10 }, { op: 'heal', value: 4 }] },
  { id: 'wild.gale', a: 'frost', n: '荒野·疾风', t: 'skill', cost: 1, r: 2, ops: [{ op: 'draw', value: 2 }, { op: 'energy', value: 1 }] },
  // 阶段 6.1 / 裁决 2C：补第 4 张荒野牌，恢复「四流派各 16」的内容对称。
  // 数值口径：与现有熵牌对齐的「过载向」（x.entropy = 2 费 dmg4×2 + energy1，此处为 1 费版本，
  // 与其余三张荒野牌一样略高于同费曲线 —— 它们是高风险实时关的奖励内容）。
  { id: 'wild.purgatory', a: 'flux', n: '荒野·寂灭', t: 'attack', cost: 1, r: 2, ops: [{ op: 'damage', value: 4, times: 2 }, { op: 'energy', value: 1 }] },
];

export const CARD_MAP = Object.fromEntries(CARDS.map((c) => [c.id, c]));

// 奖励池 = 稀有度 > 0 且未被封印的卡（封印状态由 src/meta.js 的解锁表动态过滤）
export const POOL_CARDS = CARDS.filter((c) => c.r > 0);

// 起始牌组口径：4 打击 + 4 防御 + 2 张流派入门牌 = 10 张
// 推导：牌组 10 / 手牌 5 → 循环周期 2 回合；随 10 次取牌奖励成长到 20 张 → 循环周期 4 回合
export function starterDeck(archetypeId) {
  const starter = CARDS.filter((c) => c.a === archetypeId && c.starter).map((c) => c.id);
  return [
    ...Array(4).fill('base.strike'),
    ...Array(4).fill('base.defend'),
    ...starter,
  ];
}
