// 敌人配置表（18 个原型 = 普通 12 + 精英 5 + Boss 3；内容批 P1-4 / P1-5 扩充）
// 意图口径：pattern 为固定循环（非随机），保证「可预告」——玩家能提前算账，这是卡牌肉鸽的策略前提。
// 血量口径：HP = 目标回合数 × 玩家每回合输出(DPT=10.8)，取整到 5 的倍数便于心算。
//
// 输出口径（第二版，由 tools/balance.mjs 的闭合方程反解后重定标）：
//   资源总量 R = HP 70 + 灯下 45%(32) = 102
//   总净损 = 28(n_d−6) + 14(n_e−6) + 12(n_b−6)
//   取 普通 7.5 / 精英 11 / Boss 10 → 总净损 160 → 缺口 1.57x
//   缺口刻意保留：由牌组成长（后期 DPT ×1.6）承担，静态数值不允许自己闭合，
//   否则玩家感受不到「越打越强」。这条成长要求由 tests/balance-math.test.mjs 守卫。
//
// 第一版取 8 / 12 / 10.8，实测缺口 1.94x —— 静态数值下玩家必死，已废弃。

export const ENEMIES = [
  // ---- 普通（9）均值目标 7.5/回合 ----
  { id: 'e.leech', n: '洞蛭', tier: 'normal', hp: 40, shape: 1, sub: 'CAVE LEECH',
    pattern: [{ t: 'attack', value: 11 }, { t: 'attack', value: 11 }, { t: 'block', value: 5 }] },
  { id: 'e.ash', n: '灰烬侍从', tier: 'normal', hp: 45, shape: 2, sub: 'ASH ATTENDANT',
    pattern: [{ t: 'attack', value: 9 }, { t: 'attack', value: 10 }] },
  { id: 'e.rust', n: '锈甲卫', tier: 'normal', hp: 50, shape: 3, sub: 'RUST GUARD',
    pattern: [{ t: 'block', value: 6 }, { t: 'attack', value: 12 }] },
  { id: 'e.crow', n: '蚀鸦', tier: 'normal', hp: 38, shape: 4, sub: 'ROT CROW',
    pattern: [{ t: 'attack', value: 10 }, { t: 'attack', value: 10 }, { t: 'debuff', status: 'poison', value: 2 }] },
  { id: 'e.jaw', n: '铁颚', tier: 'normal', hp: 48, shape: 5, sub: 'IRON JAW',
    pattern: [{ t: 'attack', value: 12 }, { t: 'attack', value: 9 }] },
  { id: 'e.moth', n: '灯蛾', tier: 'normal', hp: 35, shape: 6, sub: 'LAMP MOTH',
    pattern: [{ t: 'attack', value: 10 }, { t: 'attack', value: 10 }, { t: 'buff', status: 'str', value: 1 }] },
  { id: 'e.mason', n: '石匠', tier: 'normal', hp: 50, shape: 7, sub: 'STONEMASON',
    pattern: [{ t: 'block', value: 8 }, { t: 'attack', value: 11 }] },
  { id: 'e.scav', n: '拾荒者', tier: 'normal', hp: 42, shape: 8, sub: 'SCAVENGER',
    pattern: [{ t: 'attack', value: 10 }, { t: 'attack', value: 9 }, { t: 'debuff', status: 'vuln', value: 2 }] },
  { id: 'e.shade', n: '影徒', tier: 'normal', hp: 44, shape: 9, sub: 'SHADE',
    pattern: [{ t: 'attack', value: 10 }, { t: 'attack', value: 9 }] },
  // 内容批 P1-4：普通敌人 9 → 12（血量由 hpForTurns 反推，均伤对齐 7.5/回合）
  { id: 'e.needle', n: '针群', tier: 'normal', hp: 40, shape: 14, sub: 'NEEDLE SWARM',
    pattern: [{ t: 'attack', value: 8 }, { t: 'attack', value: 8 }, { t: 'debuff', status: 'weak', value: 2 }] },
  { id: 'e.husk', n: '空壳', tier: 'normal', hp: 46, shape: 15, sub: 'HOLLOW HUSK',
    pattern: [{ t: 'block', value: 7 }, { t: 'attack', value: 13 }] },
  { id: 'e.tally', n: '记数者', tier: 'normal', hp: 52, shape: 16, sub: 'THE TALLY',
    pattern: [{ t: 'buff', status: 'str', value: 2 }, { t: 'attack', value: 9 }, { t: 'attack', value: 12 }] },

  // ---- 精英（5）均值目标 11/回合 ----
  { id: 'e.chain', n: '铁链重犯', tier: 'elite', hp: 75, shape: 11, sub: 'ELITE · CHAINED',
    pattern: [{ t: 'attack', value: 13 }, { t: 'attack', value: 12 }, { t: 'attack', value: 17 }] },
  { id: 'e.rotmother', n: '蚀母', tier: 'elite', hp: 70, shape: 12, sub: 'ELITE · ROT MOTHER',
    pattern: [{ t: 'attack', value: 12 }, { t: 'debuff', status: 'poison', value: 4 }, { t: 'attack', value: 14 }, { t: 'attack', value: 11 }] },
  { id: 'e.frostbone', n: '霜骸', tier: 'elite', hp: 80, shape: 13, sub: 'ELITE · FROSTBONE',
    pattern: [{ t: 'block', value: 12 }, { t: 'attack', value: 15 }, { t: 'attack', value: 14 }] },
  // 内容批 P1-4：精英敌人 3 → 5（精英池从 3 扩到 5 后，mapgen 用 ei++ 独立递进，与普通同构）
  { id: 'e.warden', n: '锁匠', tier: 'elite', hp: 78, shape: 21, sub: 'ELITE · LOCKSMITH',
    pattern: [{ t: 'attack', value: 12 }, { t: 'block', value: 14 }, { t: 'attack', value: 16 }, { t: 'attack', value: 10 }] },
  { id: 'e.cantor', n: '唱经者', tier: 'elite', hp: 72, shape: 22, sub: 'ELITE · CANTOR',
    pattern: [{ t: 'debuff', status: 'vuln', value: 3 }, { t: 'attack', value: 14 }, { t: 'attack', value: 14 }, { t: 'buff', status: 'str', value: 2 }] },

  // ---- Boss（3，按 meta.wins 轮换；内容批 P1-5）----
  // 二阶段：血量降到 phase2At 比例以下，切换到 pattern2（从「稳定小碎打」变「大招 + 空窗」）。
  { id: 'e.lampkeeper', n: '第九层守灯人', tier: 'boss', hp: 130, shape: 99, sub: 'BOSS · THE NINTH LAMP KEEPER',
    phase2At: 0.5,
    pattern: [
      { t: 'attack', value: 12 },
      { t: 'attack', value: 11 },
      { t: 'buff', status: 'str', value: 2 },
      { t: 'attack', value: 14 },
      { t: 'attack', value: 13 },
    ],
    pattern2: [
      { t: 'attack', value: 20 },
      { t: 'block', value: 10 },
      { t: 'attack', value: 9 },
      { t: 'buff', status: 'str', value: 3 },
      { t: 'attack', value: 16 },
    ] },
  { id: 'e.bellringer', n: '摇钟人', tier: 'boss', hp: 140, shape: 101, sub: 'BOSS · THE BELL RINGER',
    phase2At: 0.55,
    pattern: [{ t: 'attack', value: 10 }, { t: 'attack', value: 10 }, { t: 'debuff', status: 'weak', value: 2 }, { t: 'attack', value: 15 }],
    pattern2: [{ t: 'attack', value: 18 }, { t: 'attack', value: 18 }, { t: 'block', value: 12 }, { t: 'buff', status: 'str', value: 2 }] },
  { id: 'e.ninthshadow', n: '第九个自己', tier: 'boss', hp: 120, shape: 102, sub: 'BOSS · YOUR NINTH SELF',
    phase2At: 0.5,
    pattern: [{ t: 'attack', value: 9 }, { t: 'attack', value: 9 }, { t: 'attack', value: 9 }, { t: 'buff', status: 'str', value: 1 }],
    pattern2: [{ t: 'attack', value: 13 }, { t: 'attack', value: 13 }, { t: 'attack', value: 13 }, { t: 'buff', status: 'str', value: 2 }] },
];

export const ENEMY_MAP = Object.fromEntries(ENEMIES.map((e) => [e.id, e]));

export const BY_TIER = {
  normal: ENEMIES.filter((e) => e.tier === 'normal'),
  elite: ENEMIES.filter((e) => e.tier === 'elite'),
  boss: ENEMIES.filter((e) => e.tier === 'boss'),
};

/** 意图的标称单回合输出：所有 attack 意图求和 / pattern 长度；block/buff/debuff 计 0 */
export function avgDmgPerTurn(enemy) {
  const n = enemy.pattern.length;
  const total = enemy.pattern.reduce((s, it) => s + (it.t === 'attack' ? it.value : 0), 0);
  return total / n;
}

/** 同一 tier 的均值 */
export function tierAvg(tier) {
  const list = BY_TIER[tier];
  return list.reduce((s, e) => s + avgDmgPerTurn(e), 0) / list.length;
}

/** 静态伤害预算闭合核算：总净损（不含牌组成长） */
export function staticDamageBudget(playerHp, blockPerTurn, healRatio) {
  const heal = Math.round(playerHp * healRatio);
  const R = playerHp + heal;
  const loss =
    28 * (tierAvg('normal') - blockPerTurn) +
    14 * (tierAvg('elite') - blockPerTurn) +
    12 * (tierAvg('boss') - blockPerTurn);
  return { resource: R, loss, ratio: loss / R, growthRequired: loss / R };
}
