// 遗物配置表（24 件）
// 口径：遗物承担「局间变化性」。单局获得 4~5 件，C(24,5) = 42504 种组合，
//      因此不需要靠扩大卡池来制造变化（见 docs/01 §8.2 的卡池取舍）。
// 钩子口径：combatStart / turnStart / cardPlayed（带条件）/ combatEnd
// 效果复用卡牌的 ops DSL，不新增一套语法。

export const RELICS = [
  // ---- 常见（12，初始解锁）----
  { id: 'o.blade', n: '断刃', r: 1, hooks: { combatStart: [{ op: 'status', status: 'str', value: 1, who: 'self' }] } },
  { id: 'o.ember', n: '余烬', r: 1, hooks: { combatStart: [{ op: 'block', value: 5 }] } },
  { id: 'o.bone', n: '骨钉', r: 1, hooks: { combatStart: [{ op: 'status', status: 'poison', value: 3, who: 'enemy' }] } },
  { id: 'o.stone', n: '石心', r: 1, hooks: { combatStart: [{ op: 'block', value: 8 }] } },
  { id: 'o.ring', n: '铁环', r: 1, hooks: { turnStart: [{ op: 'block', value: 3 }] } },
  { id: 'o.frostnail', n: '寒钉', r: 1, hooks: { combatStart: [{ op: 'status', status: 'weak', value: 2, who: 'enemy' }] } },
  { id: 'o.twin', n: '双生', r: 1, hooks: { combatStart: [{ op: 'draw', value: 2 }] } },
  { id: 'o.hush', n: '沉默钟', r: 1, hooks: { combatStart: [{ op: 'status', status: 'vuln', value: 2, who: 'enemy' }] } },
  { id: 'o.frostcore', n: '冻核', r: 1, hooks: { turnStart: [{ op: 'status', status: 'dex', value: 1, who: 'self' }] } },
  { id: 'o.venom', n: '蚀纹', r: 1, hooks: { cardPlayed: [{ cond: { cardType: 'attack' }, ops: [{ op: 'status', status: 'poison', value: 1, who: 'enemy' }] }] } },
  { id: 'o.gear', n: '齿轮', r: 1, hooks: { cardPlayed: [{ cond: { cardType: 'skill' }, ops: [{ op: 'block', value: 3 }] }] } },
  { id: 'o.scourge', n: '苦修带', r: 1, hooks: { combatStart: [{ op: 'loseHp', value: 3 }, { op: 'status', status: 'str', value: 3, who: 'self' }] } },

  // ---- 稀有（12，初始封印，每局结束解锁 1 件）----
  { id: 'u.mothscale', n: '灯蛾鳞', r: 2, sealed: true, hooks: { turnStart: [{ op: 'draw', value: 1 }] } },
  { id: 'u.amnesty', n: '赦符', r: 2, sealed: true, hooks: { combatEnd: [{ op: 'heal', value: 4 }] } },
  { id: 'u.bloodline', n: '血脉', r: 2, sealed: true, hooks: { combatStart: [{ op: 'status', status: 'str', value: 1, who: 'self' }, { op: 'status', status: 'dex', value: 1, who: 'self' }] } },
  { id: 'u.entropycore', n: '熵核', r: 2, sealed: true, hooks: { cardPlayed: [{ cond: { costZero: true }, ops: [{ op: 'draw', value: 1 }] }] } },
  { id: 'u.bloodcup', n: '血杯', r: 2, sealed: true, hooks: { combatEnd: [{ op: 'heal', value: 7 }] } },
  { id: 'u.pages', n: '残页', r: 2, sealed: true, hooks: { combatStart: [{ op: 'draw', value: 3 }] } },
  { id: 'u.rustchain', n: '锈链', r: 2, sealed: true, hooks: { turnStart: [{ op: 'status', status: 'poison', value: 1, who: 'enemy' }] } },
  { id: 'u.rest', n: '静音符', r: 2, sealed: true, hooks: { combatStart: [{ op: 'status', status: 'weak', value: 2, who: 'enemy' }, { op: 'status', status: 'vuln', value: 2, who: 'enemy' }] } },

  { id: 'g.embercore', n: '火种', r: 3, sealed: true, hooks: { turnStart: [{ op: 'energy', value: 1 }] } },
  { id: 'g.marrow', n: '髓晶', r: 3, sealed: true, hooks: { combatStart: [{ op: 'status', status: 'str', value: 2, who: 'self' }] } },
  { id: 'g.terminus', n: '终结符', r: 3, sealed: true, hooks: { combatStart: [{ op: 'status', status: 'vuln', value: 3, who: 'enemy' }, { op: 'status', status: 'weak', value: 3, who: 'enemy' }] } },
  { id: 'g.ashes', n: '灰烬', r: 3, sealed: true, hooks: { cardPlayed: [{ cond: { cardType: 'attack' }, ops: [{ op: 'draw', value: 1 }] }] } },
];

export const RELIC_MAP = Object.fromEntries(RELICS.map((r) => [r.id, r]));
