// 装备 / 局外配装（阶段 6-3 建立，本阶段 7 深化到每槽 4 件 + 解锁门槛）：纯数值/规则加成，
// 不影响任何判定节奏、不碰主 rng。
//
// ───────── 设计纪律（阶段 7 修订）─────────
//   · 3 个槽（武器 / 护符 / 印记），每槽 **4 件**（阶段 7 由 2 件扩到 4 件），玩家各选 1 件或留空。
//   · 每件只给**一个**温和加成，且全部走 ArenaCore 已有的字段
//     （dmgBase / maxHp / moveBase / magnet / xpMul / cdMul / shots / pierceN /
//       critRate / lifesteal / thorns / goldMul / shield / revives），
//     由 applyLoadout() 在 applyGrowth() 之后叠加 —— 与「属性树 + 转生」同一套口子，互不擦除。
//   · ★ **零新机制**：阶段 7 的 6 件新装备（散射/贯穿/护盾/荆棘/贪婪/重生）所需的字段
//     core 侧**早就存在** —— shots（被动「投射物 +1」在用）、pierceN（剑与流浪者「连珠」在用）、
//     thorn（被动「反伤 +2」在用）、goldMul（黄金时段在用）、revivesLeft（「不屈」线在用），
//     护盾层与暴击/吸血是本轮新增的三个字段（见 arena.js 的阶段 7 段）。
//     这不是巧合而是刻意的：**复用已验证过的字段 = 16 局回归护栏不用重标**。
//   · 数值量级小：未选时 loadoutBuffs 全 0 ⟹ 与基线逐比特相同 ⟹ 回归不破。
//
// ───────── 字段语义（务必和 ArenaCore 对齐，别乱给绝对数）─────────
//   dmgBase     乘区基数（初始 1.0），+0.05 = 全局伤害 +5%
//   maxHp       绝对生命上限（基础 90），+15 = 上限 +15
//   moveBase    绝对移动速度（基础 150），+8 = 略快
//   magnet      绝对拾取半径（基础 280），+25 = 拾取范围更大
//   xpMul       经验乘区（初始 1.0），+0.10 = 经验 +10%
//   cdMul       技能冷却缩减比例（0.10 = 冷却 -10%）
//   ── 阶段 7 新增 ──
//   dmgCut      伤害**削减**比例（0.15 = 伤害 ×0.85）。散射/贯穿用。
//               ★ 为什么是"削减"而不是"给 dmgBase 加负数"：dmgBase 是乘区基数，
//                 写 -0.15 在基数被转生/属性树抬到 1.6 之后含义就漂了；
//                 独立字段乘在最终伤害上，语义稳定（"这件装备让所有攻击 -15%"）。
//   shots       弹道 +n（受 MAX_SHOTS 硬上限约束，与「投射物 +1」被动共用同一个钳）
//   pierceN     投射物额外穿透 n 个目标（与流浪者「连珠」共用同一个字段，装备优先）
//   critRate    暴击率（0.03 = 3%，走确定性周期暴击，见 arena.js critAcc）
//   lifesteal   吸血比例（0.02 = 2%，击杀时按已造成伤害回复）
//   thorns      受击时反弹给周围敌人的伤害比例（0.20 = 20%）★ 注意与 core 的 `thorn`
//               （被动「反伤 +2」，**绝对值**、只反弹给撞上来的那只）是两个不同字段：
//               荆棘是"范围 + 比例"，反伤是"单体 + 绝对值"。混用会让两件装备互相顶掉。
//   goldMul     魂火（金币）乘区，0.20 = 击杀魂火 +20%
//   shieldEvery 每 N 秒获得一层抵挡 1 次伤害的护盾（0 = 无此效果）
//   revives     本局复活次数（走 revivesLeft，与「不屈」线共用）

export const LOADOUT_SLOTS = [
  { id: 'weapon', name: '武器' },
  { id: 'charm', name: '护符' },
  { id: 'sigil', name: '印记' },
];

/**
 * 12 件装备（阶段 7：3 槽 × 4 件）。
 *
 * `unlock` 是解锁条件，**纯数据**（由 unlocked() 判定，不碰 DOM）：
 *   kills   累计击杀数（来自 account.kills）
 *   survival累计存活秒数（来自 account.survival）
 *   souls   灵魂总数（来自 meta.souls）—— 注意判的是**持有量**而不是"历史获得量"，
 *           因为"曾经攒到过 200 灵魂"不是一个玩家能自我确认的状态，持有量才是。
 * tier    需要达到的阶段（tierOf(totalLevels)）
 * ★ 三条门槛是**或**关系（任一满足即解锁）。用"或"是因为击杀/存活/灵魂三条的
 *   推进速度差异极大（kills 最快、souls 最慢），用"与"会让早期玩家一件都拿不到。
 */
export const LOADOUT_ITEMS = [
  // ── 武器槽（4 件）──
  { id: 'w_sharp', slot: 'weapon', name: '锐锋', desc: '全局伤害 +5%', buff: { dmgBase: 0.05 }, unlock: { tier: 0 } },
  { id: 'w_swift', slot: 'weapon', name: '疾袭', desc: '移动速度 +8', buff: { moveBase: 8 }, unlock: { tier: 1 } },
  // 阶段 7 新增 —— 与 w_sharp/w_swift 构成"打得更狠 / 打得更散 / 打得更快 / 穿透"四选一
  { id: 'w_spray', slot: 'weapon', name: '散射', desc: '攻击数量 +1，伤害 -15%', buff: { shots: 1, dmgCut: 0.15 }, unlock: { tier: 2 } },
  { id: 'w_pierce', slot: 'weapon', name: '贯穿', desc: '弹道可穿透 1 个敌人，伤害 -10%', buff: { pierceN: 1, dmgCut: 0.10 }, unlock: { kills: 1500 } },

  // ── 护符槽（4 件）──
  { id: 'c_vital', slot: 'charm', name: '生机', desc: '生命上限 +15', buff: { maxHp: 15 }, unlock: { tier: 0 } },
  { id: 'c_magnet', slot: 'charm', name: '拾荒', desc: '拾取范围 +25', buff: { magnet: 25 }, unlock: { tier: 0 } },
  // 阶段 7 新增 —— 生存向的第二选择：护盾（时机向）vs 荆棘（反打向）
  { id: 'c_aegis', slot: 'charm', name: '护盾', desc: '每 30 秒获得一层抵挡 1 次伤害的护盾', buff: { shieldEvery: 30 }, unlock: { tier: 2 } },
  { id: 'c_thornmail', slot: 'charm', name: '荆棘', desc: '受到伤害时反弹 20% 给周围敌人', buff: { thorns: 0.20 }, unlock: { kills: 3000 } },

  // ── 印记槽（4 件）──
  { id: 's_sage', slot: 'sigil', name: '悟性', desc: '经验 +10%', buff: { xpMul: 0.10 }, unlock: { tier: 0 } },
  { id: 's_haste', slot: 'sigil', name: '急速', desc: '技能冷却 -10%', buff: { cdMul: 0.10 }, unlock: { tier: 1 } },
  // 阶段 7 新增 —— 经济向（贪婪）与保险向（重生）
  { id: 's_greed', slot: 'sigil', name: '贪婪', desc: '击杀金币 +20%', buff: { goldMul: 0.20 }, unlock: { tier: 2 } },
  { id: 's_rebirth', slot: 'sigil', name: '重生', desc: '每局首次死亡时复活并回复 50% 生命', buff: { revives: 1 }, unlock: { kills: 800 } },
];

export const DEFAULT_LOADOUT = { weapon: null, charm: null, sigil: null };

export const loadoutItemById = (id) =>
  LOADOUT_ITEMS.find((i) => i.id === id) || null;

/** buff 的全零形状 —— loadoutBuffs 每次都返回它的一个新副本（不给返回常量本身）。 */
function zeroBuffs() {
  return {
    dmgBase: 0, maxHp: 0, moveBase: 0, magnet: 0, xpMul: 0, cdMul: 0,
    dmgCut: 0, shots: 0, pierceN: 0, critRate: 0, lifesteal: 0,
    thorns: 0, goldMul: 0, shieldEvery: 0, revives: 0,
  };
}

/** 聚合已选装备的数值加成（只算选中的、且 id 合法的；留空槽忽略）。 */
export function loadoutBuffs(loadout) {
  const out = zeroBuffs();
  if (!loadout || typeof loadout !== 'object') return out;
  for (const slot of LOADOUT_SLOTS) {
    const it = loadoutItemById(loadout[slot.id]);
    if (it && it.buff) {
      for (const k in it.buff) out[k] = (out[k] || 0) + (it.buff[k] || 0);
    }
  }
  return out;
}

/**
 * 某件装备当前是否已解锁。
 * @param item   LOADOUT_ITEMS 的一项
 * @param stats  { kills, survival, souls, totalLevels }—— 全部走 meta/account 那两本账
 * @param tier   阶段序号（tierOf 的结果）；不传则由 stats.totalLevels 现算
 *
 * ★ 为什么**不把解锁写进存档**：解锁条件全是"累计值"（击杀/存活/灵魂/总等级），
 *   这些量只会单调不减。若把"已解锁"存进 meta，一旦某条门槛的判定被调低，
 *   玩家在旧存档里就永远看不到新解锁的那几件 —— 而实际条件已经满足了。
 *   现算的结果永远与当前规则一致，代价是每次开面板多跑几次比较（可忽略）。
 */
export function isItemUnlocked(item, stats = {}, tier = null) {
  if (!item || !item.unlock) return false;
  const t = tier == null ? null : Number(tier);
  const u = item.unlock;
  if (u.tier != null && t != null && t >= u.tier) return true;
  if (u.kills != null && (Number(stats.kills) || 0) >= u.kills) return true;
  if (u.survival != null && (Number(stats.survival) || 0) >= u.survival) return true;
  if (u.souls != null && (Number(stats.souls) || 0) >= u.souls) return true;
  return false;
}

/** 一件装备的解锁条件的人类可读描述（未解锁时展示，让人知道要攒什么）。 */
export function unlockText(item) {
  if (!item || !item.unlock) return '';
  const u = item.unlock;
  if (u.tier != null) return `${u.tier} 阶`;
  if (u.kills != null) return `累计击杀 ${u.kills}`;
  if (u.survival != null) return `累计存活 ${Math.round(u.survival / 60)} 分钟`;
  if (u.souls != null) return `灵魂 ${u.souls}`;
  return '';
}

/** 校验一个 loadout 对象（用于 meta 读入时归正）：槽→合法 item id 或 null。 */
export function normalizeLoadout(loadout) {
  const out = { weapon: null, charm: null, sigil: null };
  if (loadout && typeof loadout === 'object') {
    for (const slot of LOADOUT_SLOTS) {
      const id = loadout[slot.id];
      const it = loadoutItemById(id);
      if (it && it.slot === slot.id) out[slot.id] = it.id; // 防串槽
    }
  }
  return out;
}