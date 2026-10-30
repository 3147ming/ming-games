// 阶段 2 · 内容池：武器 / 技能 / 被动 / 宝箱
//
// 这个文件是**纯表 + 纯函数**：不碰 DOM、不碰 rng、不持有任何状态。
// 数值口径仍然统一住在 arena.js 的 ARENA 里（数字只有一个家），所以这里
// **只在函数体内**引用 ARENA —— 顶层一律不读它。
//
// ⚠ 为什么有这条约束：arena.js 与 content.js 是**循环引用**（这边要读 ARENA，
//   那边要读 OFFERS）。ESM 允许循环引用，但在**求值期**读对方尚未初始化的 const
//   会直接 TDZ 报错。只要两边都只在函数体里互相访问，两种加载顺序都安全：
//     · arena.js 先：content.js 求值时 ARENA 还在 TDZ —— 所以顶层不能碰它
//     · content.js 先：arena.js 求值完毕才轮到 content.js 的顶层 —— 那时 ARENA 已就绪
//   破坏了这条约束的表现是 `Cannot access 'ARENA' before initialization`，
//   而且只在某一个入口顺序下才出现，属于"换个 import 顺序就崩"的隐形地雷。
//
// 一个 offer（三选一里的一项）的形状：
//   id       唯一契约，测试按 id 断言
//   cat      'weapon' | 'skill' | 'passive' —— UI 分组，也是"新东西"判据的来源
//   unlock   true = 这是一件**新东西**（新武器 / 新技能），前期保底靠它
//   label / desc
//   weight   抽签权重
//   max      可重复拿到的次数（Infinity = 不封顶）
//   more(c)  额外的可出现条件（封顶判据之外的）
//   avail(c) 当前能否出现在池子里（由 builder 按 max / more 合成，可覆盖）
//   apply(c) 选中后落地到 core

import { ARENA } from './arena.js';

// 阶段 8-2：技能槽已从游戏移除（冲击波/闪现/霜环连同其强化项全部删除），只剩武器 + 被动两类。
export const CAT_LABEL = { weapon: '武器', passive: '被动' };

// ── 抽取权重 ──
// ★ 新东西的权重刻意最高：否则前期会被一堆纯数值项挤掉，
//   「前 2 分钟至少能拿到一件新东西」这条保底会退化成"理论上有可能"。
//   被动有 10 项，所以单项权重必须压低 —— 不然 10 项合起来会吃掉大半的签。
export const W_UNLOCK = 6;
export const W_UP = 3;
export const W_PASSIVE = 2.2;

// ───────── 武器池（多把并存，初始只有投射物） ─────────
export const WEAPONS = [
  { id: 'projectile', label: '投射物', desc: '自动锁定最近的敌人', start: true },
  { id: 'orbit', label: '环绕刃', desc: '利刃绕身旋转，碰到的敌人持续受伤', start: false },
  { id: 'laser', label: '直斩', desc: '朝最近敌人扫出穿透光束', start: false },
  // 阶段 5：第 4 把武器。为什么它和直斩不是同一件东西 ——
  //   直斩 = 扫出去**那一瞬间**就结算完的即时光束；剑 = 有弹速、有射程、**飞行途中穿透多个目标**的实体。
  //   同一个"直线穿透"的说法，打起来的手感与升级方向完全不同，所以值得占一个独立槽位。
  { id: 'sword', label: '剑', desc: '斩出飞行的穿透剑气（可进化为扇形 / 环绕形态）', start: false },
  // 阶段10·P1-6：第 5 把武器。机制与现有四把**不重叠**：不是弹道、不是环绕、不是直线穿透，
  //   而是"在脚下留一片持续伤害地面"—— 走位本身就是输出手段。
  { id: 'mist', label: '毒雾', desc: '脚下留下一片腐蚀地面，踩上去持续掉血', start: false },
];

// ───────── 技能池 · 已于阶段 8-2 整体移除 ─────────
//
// 主动技能（冲击波 / 闪现 / 霜环）连同"每 3 级技能向保底"的整套机制已**从游戏里完全删除**。
// 理由（用户已确认"没必要存在"）：三个技能在阶段 4-9 降格之后既不负责输出也不负责保命 ——
//   冲击波 3.75 伤 < 最小怪血 4（打不死任何东西）、半径上限 190 < 半屏宽 195（扫不出一片）、
//   闪现撞伤 3 / 无敌 0.18s、霜环零伤害。它们唯一的实际作用是**占住三个输入键和一个触屏角落**。
// ⟹ 输出与保命全交给四把武器 + 被动池；触屏左下角腾出的空间留给倍速按钮（见阶段 8 联动）。
//
// ★ 删除清单（回退请按此重塑）：SKILLS / SKILL_ORDER / SKILL_SHORT / SKILL_LABEL /
//   SKILL_SLOT_KEYS / skillOffers（解锁 dash·frost + 9 条 ks_/kd_/kf_ 技能强化）/
//   UP_DEFS 里的 ks_* kd_* kf_* / SKILL_TIER_CADENCE / SPECIAL_EFFECTS / isSkillFlavored /
//   hero.skill 字段。核心侧对应：this.skills / skShock / skDash / skFrost / castSkill /
//   shockwave() / dashCast() / frostCast() / skillOrder / skillReady / skillCd / nextSkill /
//   空格·Q·E 键位 / 触屏 .arena-skillbar 三槽 / 图标栏技能胶囊 / killSrc.shockwave·dash 桶。

// ───────── 被动池（原有 6 项 + 新增 4 项） ─────────
// 每项都有上限：封顶后从池子里剔除，不让玩家"选了没反应"。
// ★ `regen` 是唯一不封顶的：满血时它同样加不上去，但那是**玩家自己的时机判断**
//   （该留到受伤时拿），不是"这项已经作废"。滤掉反而抽掉一个合法决策。
export const PASSIVES = [
  // ★ 阶段 5.1：伤害类被动改为**全局乘区**（走 c.gUpMul，最终折进 gDmgMul）。
  //   原来是 `c.dmg += 1`（只给投射物），现在是"所有武器伤害 ×1.12" —— 一份升级惠及 4 把武器。
  // 阶段 8-2：desc 里的「技能」二字已删 —— 没有技能了，文案留着就是向玩家承诺一个不存在的能力。
  { id: 'dmg', label: '伤害 +12%', desc: '全局伤害提高 12%（所有武器与剑气）', max: 10, weight: 2.4,
    apply(c) { c.gUpMul *= 1.12; } },
  { id: 'move', label: '移速 +15%', desc: '移动速度提高 15%', max: 6, weight: 2.2,
    // ★ 阶段 5：写累加器而不是直接写 `moveSpeed *= 1.15`。理由 —— moveSpeed 现在是
    //   `_refreshClassBuffs()` 折出来的结果（疾风行者的「猎风」每层都在重算它），
    //   直接乘上去的话，下一次重算就把这次补偿擦掉了。写 moveMulP 才会被折进去。
    apply(c) { c.moveMulP *= 1.15; c._refreshClassBuffs(); } },
  { id: 'atk', label: '攻速 -0.15s', desc: '自动攻击间隔缩短 0.15 秒', max: 4, weight: 2.6,
    more: (c) => c.attackInterval > ARENA.ATTACK_INTERVAL_MIN + 1e-9,
    apply(c) { c.attackInterval = Math.max(ARENA.ATTACK_INTERVAL_MIN, c.attackInterval - 0.15); } },
  // ★ max 用 Infinity、封顶交给 more：这里若写 `max: ARENA.MAX_SHOTS - 1`，
  //   就是在**求值期**读 ARENA —— 会踩到循环引用的 TDZ（见文件头）。
  //   更根本的理由是：上限本来就是 ARENA.MAX_SHOTS，让 more 直接问它，
  //   就不需要在 content.js 里再算一份"减一"，也就不会和 ARENA 漂。
  { id: 'multi', label: '投射物 +1', desc: '自动攻击多打出一条弹道', max: Infinity, weight: 2.6,
    more: (c) => c.shots < ARENA.MAX_SHOTS,
    apply(c) { c.shots = Math.min(ARENA.MAX_SHOTS, c.shots + 1); } },
  { id: 'magnet', label: '磁吸 +30%', desc: '宝石吸附范围扩大 30%', max: 5, weight: 2.0,
    apply(c) { c.magnet *= 1.3; } },
  { id: 'regen', label: '回复 +2', desc: '立刻回复 2 点生命', max: Infinity, weight: 1.8,
    apply(c) { c.healPlayer(2); } },

  // ── 阶段 2 新增 ──
  { id: 'hp', label: '最大血 +15', desc: '血量上限 +15，并立刻补上这 15 点', max: 6, weight: 2.2,
    apply(c) { c.maxHp += 15; c.hp = Math.min(c.maxHp, c.hp + 15); } },
  // 阶段 8-2：`cd`（技能冷却 -15%）与 `knock`（击退 +40%）两条被动**一并删除**。
  //   它们的乘区 cdMul / knockMul 在项目里**只有**三个主动技能在读（技能 CD 与冲击波击退），
  //   技能一撤，这两项就变成"选了没反应"的空选项 —— 而"三选一里出现没有效果的选项是在骗
  //   玩家的一次选择"是本项目的硬纪律。⟹ 宁可少两条被动，也不留两个死旋钮。
  { id: 'pspd', label: '弹速 +25%', desc: '投射物飞得更快', max: 4, weight: 1.8,
    apply(c) { c.projSpeed *= 1.25; } },

  // ── 阶段 3 新增（被动池 10 → 14）──
  // 这四条各自新增一个 core 字段（armor / xpMul / regenRate / thorn），默认值都恒等（0 / 1），
  // 因此对"没拿这些被动"的局零影响 —— 现有 70 个测试不需要改口径（见 arena.js 的对应处理）。
  { id: 'armor', label: '减伤 +1', desc: '受到的接触伤害减少 1', max: 5, weight: 2.0,
    apply(c) { c.armor += 1; } },
  { id: 'xp', label: '经验 +20%', desc: '拾取宝石获得的经验提高 20%', max: 4, weight: 2.0,
    apply(c) { c.xpMul = Math.min(ARENA.XP_MUL_MAX, c.xpMul * 1.20); } },
  { id: 'regenp', label: '持续回复 +0.6/s', desc: '每秒回复 0.6 点生命', max: 5, weight: 1.8,
    apply(c) { c.regenRate += 0.6; } },
  { id: 'thorn', label: '反伤 +2', desc: '敌人撞到你时也受到伤害', max: 4, weight: 1.6,
    apply(c) { c.thorn += 2; } },
];

/** 宝箱在「新武器/新技能都拿满了」时才给的"高品被动"。 */
// 阶段 8-2：'cd' / 'knock' 两条被动已随主动技能删除（它们的乘区没了消费者），
//   稀有被动因此收成 2 条。
export const RARE_PASSIVES = ['hp', 'pspd'];

// ───────── offer 构造 ─────────
/**
 * 把一个原始 def 补成完整 offer。`avail` 由 `max` / `more` 合成：
 * 上限判据只在这一个地方写，避免"池子里剔了、apply 里又各自判一遍"的口径分裂。
 */
function offer(o) {
  return {
    cat: 'passive', unlock: false, weight: W_PASSIVE,
    avail(c) {
      if (this.max !== Infinity && c.taken(this.id) >= this.max) return false;
      return this.more ? !!this.more(c) : true;
    },
    ...o, // def 显式给的同名字段覆盖默认值（avail 可被完全接管）
  };
}

const passiveOffers = PASSIVES.map((p) => offer({ ...p, cat: 'passive' }));

/**
 * 解锁一件新武器。
 * ★ 阶段 8-2：原本还有 `kind === 'skill'` 那一支（解锁 dash / frost，`c.skills[id] = true; c.initSkill(id)`）。
 *   技能整体删除后这条函数只被武器调用，所以把 skill 分支与 `s_` 前缀一起删掉 ——
 *   留着它就是"一个永远走不到的分支"，而分支里的 `c.skills` / `c.initSkill` 连字段都不存在了。
 */
function unlockOffer(kind, id, label, desc) {
  return {
    id: `w_${id}`,
    cat: kind, unlock: true, weight: W_UNLOCK, max: 1,
    label, desc,
    avail(c) { return !c.weapons[id]; },
    apply(c) { c.weapons[id] = true; c.initWeapon(id); },
  };
}

/** 已持有武器的强化项。 */
function upOffer(cat, id, label, desc, weight = W_UP) {
  return offer({ cat, id, label, desc, weight });
}

const weaponOffers = [
  unlockOffer('weapon', 'orbit', '新武器 · 环绕刃', '两把利刃绕着你转，碰到就掉血'),
  unlockOffer('weapon', 'laser', '新武器 · 直斩', '每 0.9 秒朝最近敌人扫一道穿透光束'),
  // 阶段 5：第 4 把武器「剑」—— 飞行 + 穿透 + 后续两段进化形态
  unlockOffer('weapon', 'sword', '新武器 · 剑', '每 1.2 秒斩出一道飞行的穿透剑气'),
  // 阶段10·P1-6：第 5 把武器「毒雾」—— 地面持续伤害（不是弹道/环绕/直线）
  unlockOffer('weapon', 'mist', '新武器 · 毒雾', '脚下留下一片腐蚀地面，踩上去持续掉血'),

  // 下面每一条都只是**壳**：id / 文案 / 分组。数值与门槛统一在下面的 UP_DEFS 里补，
  // 这样"改了某个上限"只需要动一张表，不会漏掉池子那一侧的判据。
  upOffer('weapon', 'wp_dmg', '全局 · 伤害 +8%', '所有武器伤害提高 8%'),
  upOffer('weapon', 'wp_shots', '投射物 · 弹道 +1', '自动攻击多打出一条弹道'),
  upOffer('weapon', 'wp_cd', '投射物 · 攻速 -0.1s', '自动攻击间隔缩短 0.1 秒'),
  upOffer('weapon', 'wo_count', '环绕刃 · 剑数 +1', '多一把绕身利刃'),
  upOffer('weapon', 'wo_dmg', '全局 · 伤害 +8%', '所有武器伤害提高 8%'),
  upOffer('weapon', 'wl_dmg', '全局 · 伤害 +8%', '所有武器伤害提高 8%'),
  upOffer('weapon', 'wl_width', '直斩 · 宽度 +6', '光束更宽，扫到更多敌人'),
  upOffer('weapon', 'wl_cd', '直斩 · CD -0.15s', '光束扫得更频繁'),
  // ── 阶段 5：剑的三轴（伤害 / 道数 / 节拍）──
  upOffer('weapon', 'ws_dmg', '全局 · 伤害 +8%', '所有武器伤害提高 8%'),
  upOffer('weapon', 'ws_count', '剑 · 剑气 +1', '多斩出一道剑气（扇形展开）'),
  upOffer('weapon', 'ws_cd', '剑 · 间隔 -0.15s', '挥剑更频繁（下限 0.5s）'),
  // ── 阶段10·P1-6：毒雾的三轴（伤害 / 范围 / 铺设节拍）──
  upOffer('weapon', 'wm_dmg', '全局 · 伤害 +8%', '所有武器伤害提高 8%'),
  upOffer('weapon', 'wm_size', '毒雾 · 范围 +8', '腐蚀地面的半径扩大'),
  upOffer('weapon', 'wm_cd', '毒雾 · 铺设 -0.2s', '更快在脚下留下腐蚀地面（下限 0.5s）'),
];

// 阶段 8-2：skillOffers（解锁 dash/frost + 9 条 ks_/kd_/kf_ 技能强化）已随主动技能整体删除。

// 武器强化项的"门槛 + 落地"逐个补齐（放在这里是为了让资质判据与 ARENA 常量
// 一眼对得上：改数值时这两处最容易被忘掉）。
//
// ★ 阶段 4-5：`w` 是"这条强化属于哪把武器"。它同时干两件事 ——
//   ① 拿到时给该武器的**等级** +1（等级满了就进化）；
//   ② 满级（或已进化）之后这条强化从池子里消失（spec「进化后不能再强化」）。
//   所以"武器等级"不需要另存一份计数表：它就是"这把武器的强化拿过几次"，
//   和 UP_DEFS 里已有的 max / more 共用一个来源，不会漂。
const UP_DEFS = {
  // ★ 阶段 4-5：三系强化项都先判「已持有该武器」—— 否则重壳守卫（不开局投射物）会被塞
  //   wp_dmg 这类"投射物强化"，白拿 +2 伤害事小，更糟的是 wLvl.projectile 会被推上去、
  //   凭空触发螺旋进化（它根本没有投射物）。所以 `more` 第一道闸就是 `c.weapons.xxx`。
  wp_dmg: { w: 'projectile', max: 8, more: (c) => c.weapons.projectile && c.wlvlUp('projectile'), apply: (c) => { c.gUpMul *= 1.08; } },
  wp_shots: { w: 'projectile', max: Infinity, more: (c) => c.weapons.projectile && c.wlvlUp('projectile') && c.shots < ARENA.MAX_SHOTS,
    apply: (c) => { c.shots = Math.min(ARENA.MAX_SHOTS, c.shots + 1); } },
  wp_cd: { w: 'projectile', max: 4, more: (c) => c.weapons.projectile && c.wlvlUp('projectile') && c.attackInterval > ARENA.ATTACK_INTERVAL_MIN + 1e-9,
    apply: (c) => { c.attackInterval = Math.max(ARENA.ATTACK_INTERVAL_MIN, c.attackInterval - 0.1); } },
  wo_count: { w: 'orbit', max: Infinity, more: (c) => c.weapons.orbit && c.wlvlUp('orbit') && c.orbit.count < ARENA.ORBIT_MAX,
    apply: (c) => { c.orbit.count = Math.min(ARENA.ORBIT_MAX, c.orbit.count + 1); } },
  wo_dmg: { w: 'orbit', max: 5, more: (c) => c.weapons.orbit && c.wlvlUp('orbit'), apply: (c) => { c.gUpMul *= 1.08; } },
  wl_dmg: { w: 'laser', max: 5, more: (c) => c.weapons.laser && c.wlvlUp('laser'), apply: (c) => { c.gUpMul *= 1.08; } },
  wl_width: { w: 'laser', max: 4, more: (c) => c.weapons.laser && c.wlvlUp('laser'), apply: (c) => { c.laser.w += 6; } },
  wl_cd: { w: 'laser', max: 4, more: (c) => c.weapons.laser && c.wlvlUp('laser') && c.laser.interval > ARENA.LASER_MIN_CD + 1e-9,
    apply: (c) => { c.laser.interval = Math.max(ARENA.LASER_MIN_CD, c.laser.interval - 0.15); } },

  // ── 阶段 5：剑 ──
  ws_dmg: { w: 'sword', max: 8, more: (c) => c.weapons.sword && c.wlvlUp('sword'),
    apply: (c) => { c.gUpMul *= 1.08; } },
  ws_count: { w: 'sword', max: Infinity, more: (c) => c.weapons.sword && c.wlvlUp('sword') && c.sword.count < ARENA.SWORD_MAX_COUNT,
    apply: (c) => { c.sword.count = Math.min(ARENA.SWORD_MAX_COUNT, c.sword.count + 1); } },
  // interval 1.2 → 0.5 需要 -0.7，而步长固定 0.15（spec 明文），
  //   凑不出整数层恰好触底 ⟹ 取 5 层（余下那点由 Math.max 兜住），与其他线"恰好顶到上限"的
  //   纪律在这里是**刻意破例**：宁可多一层夹到下限，也**不许**为了凑整数改动 spec 给的 -0.15。
  ws_cd: { w: 'sword', max: 5, more: (c) => c.weapons.sword && c.wlvlUp('sword') && c.sword.interval > ARENA.SWORD_MIN_CD + 1e-9,
    apply: (c) => { c.sword.interval = Math.max(ARENA.SWORD_MIN_CD, c.sword.interval - 0.15); } },

  // ── 阶段10·P1-6：毒雾 ──
  wm_dmg: { w: 'mist', max: 8, more: (c) => c.weapons.mist && c.wlvlUp('mist'),
    apply: (c) => { c.gUpMul *= 1.08; } },
  wm_size: { w: 'mist', max: 4, more: (c) => c.weapons.mist && c.wlvlUp('mist'),
    apply: (c) => { c.mist.r += 8; } },
  wm_cd: { w: 'mist', max: 4, more: (c) => c.weapons.mist && c.wlvlUp('mist') && c.mist.interval > ARENA.MIST_MIN_CD + 1e-9,
    apply: (c) => { c.mist.interval = Math.max(ARENA.MIST_MIN_CD, c.mist.interval - 0.2); } },

  // 阶段 8-2：技能强化（ks_/kd_/kf_ 九条）已随主动技能整体删除 —— 三选一池里不再有任何 'skill' 类目。
};
// Object.assign 而不是重写对象：offer() 合成的那个 `avail` 读的是 **this.max / this.more**，
// 所以补上 max / more 之后它自动就对了 —— 不需要再抄一份判据（抄就会漂）。
for (const o of [...weaponOffers]) {
  const d = UP_DEFS[o.id];
  if (d) Object.assign(o, d);
  else if (!o.unlock) throw new Error(`强化项 ${o.id} 缺 UP_DEFS 定义`);
}

/**
 * 完整 offer 池。**顺序即 id 契约**，测试按 id 断言。
 * 阶段 8-2：池子从「被动 → 新武器 → 武器强化 → 新技能 → 技能强化」五类收成
 * 「**被动 → 新武器 → 武器强化**」三类 —— 技能那两类已随主动技能整体消失。
 * ⟹ 新断言（取代旧的"技能占比<15%"）：**池里不存在 any cat==='skill' 的项**。
 */
export const OFFERS = [
  ...passiveOffers, ...weaponOffers,
];

/**
 * 兜底三选一：池子被抽空（武器满级、被动封顶）时用它补位。
 * ★ 它们不进 OFFERS（不参与正常抽签），只在 openUpgrade 的兜底分支出场；
 *   三张牌都"永远有效" —— 用同文件内部工厂 offer() 造，复用 avail 合成逻辑，杜绝"选了没反应"。
 *   ★ 顺序即 id 契约（见上方 OFFERS 注释）：OFFERS 不许加项/挪位；FALLBACK_OFFERS 同理独立于抽签池。
 */
export const FALLBACK_OFFERS = [
  offer({ id: 'f_heal', cat: 'passive', label: '当场回血 +6', desc: '立刻回复 6 点生命', weight: 1,
    apply(c) { c.healPlayer(6); } }),
  offer({ id: 'f_fire', cat: 'passive', label: '魂火 +25', desc: '局内商栈货币 +25', weight: 1,
    apply(c) { c.soulfire += 25; } }),
  offer({ id: 'f_mend', cat: 'passive', label: '生命上限 +5', desc: '上限 +5 并补上这 5 点', weight: 1,
    apply(c) { c.maxHp += 5; c.hp = Math.min(c.maxHp, c.hp + 5); } }),
];

/** 按 id 查 offer（宝箱发奖 / 测试都用它）。两段查表：先正常池，再兜底池（f_*）。 */
export const offerById = (id) =>
  OFFERS.find((o) => o.id === id) || FALLBACK_OFFERS.find((o) => o.id === id) || null;

/** 调试/结算用：把 core 当前持有的武器读成字符串数组（阶段 8-2：技能字段已随主动技能移除）。 */
export const ownedIds = (c) => ({
  weapons: Object.keys(c.weapons).filter((k) => c.weapons[k]),
});

// ───────── 阶段 5：长期成长（localStorage 持久化）─────────
//
// 取代旧的 META_UNLOCKS 7 条一次性解锁。新系统由三块组成，全部由 arena.js 的 applyGrowth()
// 在开局一次性套到初始状态上（同样是"只改初始字段、不新开状态机"的纪律）：
//   A1 无限属性树  —— kind==='generic' 的 8 条，等级上限见 GROWTH_LVL_CAP。
//   A2 职业专属线  —— kind==='class' 的 3 条，每条只对自己职业的被动生效。
//   A3 转生        —— 门槛见 meta.js 的 canRebirth；重置全部属性等级、给全局倍率。
//
// 每条线的 effect是**纯数据**（stat + per），由 applyGrowth 按 stat 映射到 core 字段，
// 这样不引入 rng、不新增伤害来源（killSrc 归因不变），也便于无头测试。
//   id    唯一契约，测试按 id 断言
//   kind  'generic' | 'special' | 'class'
//   stat  映射到 core 字段（见 arena.js applyGrowth 的 switch）
//   per   每一级加多少（对 xpMul/luck 等倍率项是"每级 +per"的增量）
//   hero  仅 class 线有：只对应该职业生效
// desc = 标题页成长面板逐行显示的效果说明（`${L.desc}　Lv.N`）。
// ★ 必须有：renderMetaPanel 直接拼 `${L.desc}`，缺了会在页面上打出字面量 "undefined"
//   （无头首页探针 screenshot 实测抓到，2026-09-25）。
//
// ───────── 阶段 7：属性树平衡重算 ─────────
// spec 要求「以一阶初始属性为 1.0，每级提升幅度不超过 15%」。逐条核对（基准值取 arena.js 的
// ARENA 初始字段，1 阶 = 全部等级 0、无转生、无配装）：
//
//   属性      1 阶基准      每级增量      占基准      判定
//   生命90      90          +8          8.9%   ✓ <15%
//   伤害      1.00         +5%          5.0%   ✓
//   移速      150          +4          2.7%     ✓（绝对值口径，占比最小）
//   磁吸      280          +10%        10.0%   ✓ ← 本轮由"+20 绝对"改成"+10% 百分比"
//   悟性      1.00         +4%          4.0%   ✓
//   再生      0/s          +0.15/s      —（无基准，比值无意义；用"等效 90 血的回复时间"衡量：
//                                          满血时该回复量在 10 分钟里回满 54%，不构成）
//   狂怒      0%           +3%          —（从 0 起步，按"50 级 = 150% 暴击率"封顶反推）
//   续航      0%           +2%          —（同上，50 级 = 100% 吸血，见下方两条注释）
//
// ★ 磁吸为什么必须改口径：原来"每级 +20"是**绝对值**，于是它的实际占比随玩家把磁吸
//   堆高而衰减（1 阶 20/280 = 7.1%，被配装+磁暴抬到 400 之后同样 +20 只剩 5%），
//   而生命/伤害是**相对量**——同一棵树里两种口径混用，"每级 ≤15%"这条判据根本没法统一算。
//   改成百分比后，八条线全部是"相对基准的百分比"，判据才成立、也才可比。
//   ⚠ 落地方式**不是**直接把 this.magnet 乘大（那是绝对半径），而是新开一个相对累加器
//   `magnetPct`，由 ARENA.GEM_MAGNET 折算 —— 这样"磁暴事件"（magnetMul，纯增益波）
//   与"属性树磁吸"两个来源仍然互不擦除，语义和改动前完全一致。
//
// ★ 狂怒（暴击）的三条纪律：
//   ① **零 rng**。用 rng 判暴击会污染主随机流 ⟹ "同种子同结果"这条冻结项直接破。
//      改成**确定性周期暴击**：把累计伤害当计数器，每满 1/critRate 点伤害触发一次 ×1.5。
//      代价是暴击分布与真实 rng 不同（本该几何分布），收益是护栏不破 —— 这个交换划算。
//   ② **不新增伤害来源**。暴击走applyHit 内部把 amount ×1.5，killSrc 归属不变
//      （阶段 5踩过一次"Σ来源 < 总击杀"的坑，不能再犯）。
//   ③ **每条线有自己的 `max`**（见下），因为「每级 +3%」与「总上限 50 级」这两条 spec
//      在数学上冲突：3% × 50 = **150% > 100%**，暴击率溢出。
//      三个候选解里选了「单线封顶34 级」（34 × 3% = 102% →钳到 100% 恰好触顶）：
//        · 改每级数值 → 违背 spec 明文的 +3%；
//        · 允许暴击率 >100% → 数学上没有意义（100% 已经每击都暴）；
//        · 单线封顶 → 保留 spec 的两个数字，并在面板上明确"这一项已满"。
//      ⟹ 于是g_cri 的 max=34、g_lif 的 max=50（2% × 50 = 100%，天然不溢出）。
export const GROWTH_LINES = [
  // ── A1 属性树（8 条 generic）──
  { id: 'g_hp',  label: '生命', kind: 'generic', stat: 'maxHp',     per: 8,     desc: '每级 +8 生命上限' },
  { id: 'g_dmg', label: '利刃', kind: 'generic', stat: 'dmgBase',   per: 0.05,  desc: '每级 +5% 基础伤害' },
  { id: 'g_spd', label: '疾行', kind: 'generic', stat: 'moveFlat',  per: 4,     desc: '每级 +4 移速' },
  // ★ 阶段 7：+20 绝对 → +10% 百分比（理由见上方注释块）
  { id: 'g_mag', label: '磁吸', kind: 'generic', stat: 'magnetPct', per: 0.10,  desc: '每级 +10% 拾取范围' },
  { id: 'g_xp',  label: '悟性', kind: 'generic', stat: 'xpMul',     per: 0.04,  desc: '每级 +4% 经验获取' },
  { id: 'g_reg', label: '再生', kind: 'generic', stat: 'regen',     per: 0.15,  desc: '每级 +0.15/秒 回血' },
  // ── 阶段 7 新增的 2 条通用节点 ──
  // ★ max = min(GROWTH_LVL_CAP, ceil(封顶 / per))：见上方「三条纪律 ③」的裁决
  { id: 'g_cri', label: '狂怒', kind: 'generic', stat: 'critRate',  per: 0.03,  max: 34, desc: '每级 +3% 暴击率，暴击造成 150% 伤害（满 34 级 = 100%）' },
  { id: 'g_lif', label: '续航', kind: 'generic', stat: 'lifesteal', per: 0.02,  max: 50, desc: '每级 +2% 生命偷取，击杀敌人回复生命（满 50 级 = 100%）' },
  // ── special 特殊线（2 条；A3 转生门槛之一"两条特殊线都已解锁"）──
  { id: 's_rev',  label: '不屈', kind: 'special', stat: 'revives', per: 1,    desc: '每级 +1 次复活' },
  { id: 's_luck', label: '幸运', kind: 'special', stat: 'luck',    per: 0.03, desc: '每级 +3% 幸运' },
  // ── A2 职业专属线（3 条，只对本职业生效）──
  { id: 'c_wan', label: '剑意修行', kind: 'class', hero: 'wanderer', stat: 'classDmg',   per: 0.005, desc: '每级 +0.5% 剑意伤害' },
  { id: 'c_bul', label: '磐石修行', kind: 'class', hero: 'bulwark',  stat: 'classStone', per: 0.05,  desc: '每级 +5% 磐石减伤' },
  { id: 'c_gal', label: '猎风修行', kind: 'class', hero: 'gale',     stat: 'classWind',  per: 0.03,  desc: '每级 +3% 猎风加成' },
];

/** ★ 阶段 7：属性树单条线的等级上限（spec：属性树总等级上限 50 级）。
 *  原来是"无上限、靠 cost 指数增长自我封顶"。改成**显式上限**的理由：
 *  指数封顶意味着玩家每一级都要点，几十级之后单次花费进入四位数、而收益还在 15%/级，
 *  于是"再点一级"的决策全部退化成"再攒 20 局"。显式 50 级把终点画出来，
 *  玩家能看见还剩几级 —— 这是"总等级上限 50 级"这条 spec 的原意。 */
export const GROWTH_LVL_CAP = 50;

/** 阶段 7 · 阶段晋升阶梯：总属性等级达到这些阈值即晋升一阶（spec：10 / 25 / 50）。
 *  每一阶解锁一组内容（见 TIERS）。tier 是**由总等级算出来的**，不单独存——
 *  与 rebirth（要主动重置）是两种不同的机制，互不覆盖。 */
// ★ 阶段11·P1-7：perk 文案必须与 LOADOUT_ITEMS / SKINS 的**实际门槛**一致。
//   旧文案承诺了三件不存在/不同阶段的东西：
//     · 「急速」阶段 8-2 就随主动技能删了；
//     · 「拾荒」是 tier 0，开局就能用；
//     · 「贯穿/荆棘/重生」是击杀门槛（1500/3000/800），不是四阶。
//   ⟹ 四阶其实只解锁皮肤。下面的守门测试会拦住下一次漂移。
export const TIERS = [
  { tier: 0, at: 0,  label: '一阶·荒野猎手', perk: '起始装备：锐锋 / 生机 / 拾荒 / 悟性' },
  { tier: 1, at: 10, label: '二阶·荒野游侠', perk: '解锁装备：疾袭 / 专注；皮肤：赤焰' },
  { tier: 2, at: 25, label: '三阶·荒野贵胄', perk: '解锁装备：散射 / 护盾 / 贪婪；皮肤：幽霜 / 灰烬 / 玄曜' },
  { tier: 3, at: 50, label: '四阶·荒野之主', perk: '皮肤：鎏金 / 苔痕 / 余烬（四阶不再解锁装备 —— 贯穿/荆棘/重生 走击杀门槛）' },
];

/** 总属性等级 → 阶段序号（0..3）。已改属性的老存档立刻按新阶梯判定，不需要迁移。 */
export function tierOf(totalLv) {
  const n = Math.max(0, Number(totalLv) || 0);
  let t = 0;
  for (const x of TIERS) if (n >= x.at) t = x.tier;
  return t;
}

/** 总属性等级 → 下一阶还差多少级（已到顶返回 null）。 */
export function nextTierGap(totalLv) {
  const t = tierOf(totalLv);
  const next = TIERS.find((x) => x.tier === t + 1);
  if (!next) return null;
  return { tier: next.tier, name: next.label, need: next.at, gap: next.at - Math.max(0, Number(totalLv) || 0) };
}

/** 按 id 查成长线（标题页 / 测试用）。 */
export const growthLineOf = (id) => GROWTH_LINES.find((x) => x.id === id) || null;
export const GENERIC_LINES  = GROWTH_LINES.filter((x) => x.kind === 'generic');
export const SPECIAL_LINES  = GROWTH_LINES.filter((x) => x.kind === 'special');
export const CLASS_LINES    = GROWTH_LINES.filter((x) => x.kind === 'class');

/** 属性树里所有可升级的线（special/class 也在内——标题页"总等级"按它们一起算）。 */
export const UPGRADABLE_LINES = GROWTH_LINES;

// ───────── 阶段 7 · 局内技能池（每 3 级一次的三选一）─────────
//
// spec：「每 3 级提供一次技能选择（3 选 1），技能池包含：主动技能强化、被动属性提升、特殊效果」。
//
// ⚠★ **口径冲突，已裁决，按下面的方案落地** —— 请主理人复核：
//   spec 的「每 3 级一次」与**现状**（每升 1 级一次三选一）是两套节奏，不能同时成立。
//   现状的节奏不是随手定的：ARENA.XP_BASE/XP_GROWTH 是拿16 局 sim 反复扫出来的，
//   其护栏是「首次升级<20s / 最长升级空档 ≤45s」，实测 16/16 达成、
//   等级在 62.9s 到 Lv.10、361.9s 到 Lv.30。**每 3 级一次会把 10 次决策压成 3 次**，
//   中期的 build 成型度会明显塌方，而且会连带改变等级曲线的观感（每 90 秒才长一次）。
//   ⟹ **保留"每级一次"作为主节奏**（它已经超额达成 spec 的"6 分钟内有感知"）。
//     ★ 阶段 8-2：原先挂在"每 3 级"上的那条**技能向保底**（SKILL_TIER_CADENCE +
//       isSkillFlavored + SPECIAL_EFFECTS）已随主动技能整体删除 —— 它保证的是
//       "每隔几级必有一张技能牌"，而这个目标随技能消失不再存在。
//       三类来源里「主动技能强化」删除，「特殊效果」6 张从未真正进池（不在 OFFERS 里），
//       一并删除以免留下不可达的死配置。三选一现在纯粹是「被动 / 新武器 / 武器强化」。
//   ⟹ 副作用很小：pool 里只剩纯数值项时"连着三张被动"的概率确实回来了，
//      但这是"输出与保命全走武器+被动"这条口径的直接后果，用户已确认。

// ───────── 阶段 4-5：超武进化 ─────────
//
// 一把武器拿满 W_LEVEL_MAX 次专属强化 = **满级**；满级 + 凑齐指定的被动 ⟹ 本局自动进化。
// 这张表只描述"哪条线要凑什么"，**进化后的效果落在 core 里**（那是执行层，不是表）。
//
//   weapon   哪把武器
//   passive  还需要的那个被动（id），need = 要拿够几次
//   label    进化后的名字（大字 "★武器进化★ xxx"）
//
// ★ 为什么三条线各自要不同的被动：三条线如果都要求同一个被动，池子里那一项就变成
//   必抢的独木桥；分开之后"我这局往哪个方向堆"才真的是一个选择。
export const EVOLUTIONS = [
  { id: 'ev_spiral', weapon: 'projectile', passive: 'multi', need: 3,
    label: '螺旋弹幕', desc: '每 1.2 秒向四周齐射一圈弹幕' },
  { id: 'ev_storm', weapon: 'orbit', passive: 'atk', need: 2,
    label: '五刃风暴', desc: '刃数翻倍、旋转加速、范围加大' },
  { id: 'ev_cleave', weapon: 'laser', passive: 'dmg', need: 2,
    label: '裂光', desc: '一道变三道扇形穿透光束' },
  // ── 阶段 5：剑的两级链 ──
  // ★ `stage` = 这条线跃迁到**第几阶**（stage:1 是第一段，stage:2 是第二段）。
  //   两条线同 weapon ≠ 冲突：_checkEvolution 只在"当前阶 = stage-1"时兑现，
  //   所以必定是先把 C1 推到 C2、再让武器等级重新爬满之后才可能到 C3。
  { id: 'ev_sword_fan', weapon: 'sword', passive: 'multi', need: 2, stage: 1,
    label: '扇形剑幕', desc: '一次张开 100° 斩出三道穿透剑气' },
  { id: 'ev_sword_ring', weapon: 'sword', passive: 'dmg', need: 3, stage: 2,
    label: '环绕剑域', desc: '十二道剑气绕身常驻，贴身者持续受创' },
  // 阶段10·P1-6：毒雾的进化线。passive 用 'xp'（经验 +20%）—— 这条线此前没有任何进化占用，
  //   正好分流，不去挤 multi/dmg/atk 三条独木桥。
  { id: 'ev_mist', weapon: 'mist', passive: 'xp', need: 2,
    label: '腐潮', desc: '毒雾连成一片，会缓慢跟着你移动' },
];

/** 按 id 查进化线。 */
export const evoById = (id) => EVOLUTIONS.find((x) => x.id === id) || null;
/** 按武器查**当前这一阶**还能进化成什么（HUD 显示用）。
 *  ★ 阶段 5 加第二参数：剑有 C1→C2→C3 两级链，`evoOfWeapon('sword')` 只会一直返回第一条，
 *    进化成 C2 之后 HUD 还写着"还能进化成扇形剑幕"就成 bug 了。传 stage 进来就对得上：
 *    stage=0 ⟹ 找 stage:1 那条；stage=1 ⟹ 找 stage:2 那条；到顶 ⟹ null（"已到最终形态"）。
 *    旧调用只传 w ⟹ stage 默认 0 ⟹ 行为与阶段 4 完全一致。 */
export const evoOfWeapon = (w, stage = 0) => EVOLUTIONS.find((x) => x.weapon === w && (x.stage || 1) === stage + 1) || null;

/** 武器强化 id → 属于哪把武器（驾驶员凑进化 / 测试都用它）。 */
export const WEAPON_OF_UP = Object.fromEntries(
  Object.entries(UP_DEFS).filter(([, d]) => d.w).map(([id, d]) => [id, d.w]),
);

// ───────── 阶段 4-5：角色 ─────────
//
// 每个角色描述"开局时的初始配置"，用**倍率**而不是绝对值 —— 绝对值会和 ARENA 常量
// 各存一份，改一次基础血量就要改三个角色；倍率则永远跟着 ARENA 走。
//
//   weapon / skill  开局就持有的那件（**替换**默认的投射物 / 冲击波，不是额外多给）
//   hpMul / dmgMul / moveMul   属性倍率
//   atkMul          攻速倍率（>1 = 更快；间隔 = 基础 / atkMul）
//   cost            灵魂解锁价（0 = 默认角色）
//
// ★ cost 走的是 meta.js 同一套 localStorage（meta.heroes），不是新开一套存档：
//   "灵魂"这一种货币只该有一个账本。
// 阶段 8-2：三个角色的 `skill` 开局字段已移除（原为 shockwave / shockwave / frost）。
//   ⟹ gale 的 desc 里"霜环开局"这句必须跟着改：文案里留着技能名等于向玩家承诺一个不存在的能力。
export const HEROES = [
  { id: 'wanderer', label: '流浪者', tag: '均衡', weapon: 'projectile',
    hpMul: 1, dmgMul: 1, moveMul: 1, atkMul: 1, cost: 0,
    desc: '标准体魄。投射物开局，什么都不偏，也什么都不缺。' },
  { id: 'bulwark', label: '重壳守卫', tag: '重装', weapon: 'orbit',
    hpMul: 1.5, dmgMul: 0.8, moveMul: 0.9, atkMul: 1, cost: 14,
    desc: '血 +50%、攻击 −20%、移速 −10%。环绕刃开局，靠贴身磨。' },
  { id: 'gale', label: '疾风行者', tag: '敏捷', weapon: 'projectile',
    hpMul: 0.7, dmgMul: 1, moveMul: 1.2, atkMul: 1.15, cost: 18,
    desc: '移速 +20%、血 −30%、攻速 +15%。没有主动技能兜底，全靠步幅把距离拉开。' },
];

/** 按 id 查角色。**找不到就回退流浪者** —— 存档里塞了乱 id 也不能开局崩。 */
export const heroById = (id) => HEROES.find((h) => h.id === id) || HEROES[0];
/** 默认角色（也是所有兜底路径的落点）。 */
export const DEFAULT_HERO = HEROES[0].id;

// ───────── 阶段 5 · 职业专属被动（B1）─────────
//
// ⚠ 重建说明（主理人请看）：本表是阶段 5 大版本里「B1 专属被动」的落地。原始 spec 的这一段
//   在上下文里已经丢失，这里的**数值是我按职业身份重建的**，名字（剑意 / 磐石 / 猎风）
//   按 spec 保留。**替换成本很低**：三条效果的常量全在这张表里 + ARENA 的 STONE_*/WIND_*
//   两块常量，改数不需要动 core 逻辑。
//
// 三条共同的硬约束（踩过的坑都指向这里）：
//   · **零 rng**：任何"触发概率"都会消耗主随机流 ⟹ 破坏"同种子同结果"这条冻结项，
//     而且新浪潮还要一个个隔着 stream 去隔离（4-12/4-13 已经为之心累）。所以这里全是**确定性状态机**。
//   · **不新增伤害来源**：凭空多出来的一次攻击最容易漏掉 killSrc 归因
//     （阶段 5 刚踩过一次：Σ来源 < 总击杀，spec 那两条占比变成假读数）。
//     所以三条全部走**倍率 / 减伤**，不凭空跳出一次伤害。
//   · **只读已有字段**：core 侧只多几个计时器（stoneT / windIdleT / windDist），不新开子系统。
export const CLASS_PASSIVES = {
  wanderer: {
    label: '剑意',
    desc: '专注：每升 1 级，所有武器伤害 +0.6%（30 级 +18%）',
    // ★ 走 gDmgMul（阶段 5 立的全局伤害口子）—— 它对所有武器一视同仁，
    //   正好是"均衡"这个身份该有的样子：不偏袒任何一把武器。
    dmgPerLevel: 0.006,
  },
  bulwark: {
    label: '磐石',
    desc: '硬扛：受伤后 1.5 秒内，再受的伤害减免 30%',
    // ★ 为什么是"受击后的短窗"而不是"常驻减伤"：常驻减伤和「减伤」被动做的是同一件事，
    //   读不出职业特色；而这条针对的正是**本作真正的死法** —— 被围住时同一帧/连续几帧
    //   连挨数下（4-1 那次"单帧巨额叠加"的实测）。它对"挨第一下"无效、专治"挨第二下开始滚雪球"。
    stoneDr: 0.30, stoneWindow: 1.5,
  },
  gale: {
    label: '猎风',
    desc: '拉扯：每移动 240px 积一层风势（≤5 层），每层移速 +4%、武器伤害 +4%；站定 1.2 秒后开始掉层',
    // ★ 为什么用"位移积分"而不是"持续时间"：距离才是"拉开距离"这件事本身 ——
    //   站着不动（哪怕是被围住滑步）不应累加；逃跑跑得越远收益越高，和职业身份一致。
    windPer: 240, windMax: 5, windDmg: 0.04, windMove: 0.04, windHold: 1.2, windDecay: 0.6,
  },
};
/** 某职业的专属被动（没有就是 null —— 加新职业忘了配也不会崩）。 */
export const classPassiveOf = (heroId) => CLASS_PASSIVES[heroId] || null;

// ───────── 阶段 5 · B3 专属武器强化（B2 技能变体已于阶段 8-2 删除）─────────
//
// ⚠ 同样请注意：本表随 B1 一起重建，数值可换、口径不变。改数不需要动 core 逻辑。
//
// ★ B3 的设计约束：强化的是**本命武器**（职业开局就有的那把），且三者互不重叠：
//     流浪者 → 投射物**穿透**（打穿一排）
//     重壳守卫 → 环绕刃**对硬目标（精英 / Boss）增伤**（重装惯有的"啃硬骨头"）
//     疾风行者 → 投射物**更快更远**（隔着一整个屏幕点名）
//   → gale 与 wanderer 共用 projectile，但两条口子完全不冲突（一个动射程手感，一个动命中方式）。
//
// ★ 阶段 8-2：每个角色的 perks 原本是 **skill（主动技能强化）+ weapon（武器强化）** 两支，
//   前者三个 perk 全部挂在已删除的冲击波/霜环上（破阵定身 / 地裂减速场 / 寒潮残留减速），
//   随技能一并移除，只保留 weapon 支。⟹ 失去的这部分"角色辨识度"属于本次口径的直接后果，
//   若 16 局 sim 跑满率跌破 14/16，只允许在**被动生存项**上补，不许回补技能
//   （见 README 阶段 8-2 的补偿记录）。
//
// ★ 二阶连带（本次一并处理，避免留下"配了却没效果"的空 perk）：
//   重壳守卫「重刃」的原判据「被控目标」依赖的正是上面那三个写入端 ⟹ 恒不成立。
//   判据改成「精英 / Boss」，**数值 0.25 一字未动**（详见 arena.js `_isHeavyTarget`）。
export const CLASS_PERKS = {

  wanderer: {
    weapon: { id: 'projectile', label: '连珠', desc: '投射物可穿透 1 个目标后继续飞行',
      pierceN: 1 },
  },
  bulwark: {
    // ★ 阶段 8-2 改判据：`ctrlBonus`（对被控目标 +25%）→ `heavyBonus`（对硬目标 +25%）。
    //   被控的三个写入端（破阵定身 / 霜环冻结 / 地裂减速场）全随主动技能删除 ⟹
    //   原判据恒不成立 ⟹ 这就是一条"配了却没效果"的空 perk。改成**精英 / Boss** 后
    //   触发条件重新可达，**数值一字未动**（仍是 +25%）。
    weapon: { id: 'orbit', label: '重刃', desc: '环绕刃对精英 / Boss 伤害 +25%',
      heavyBonus: 0.25 },
  },
  gale: {
    weapon: { id: 'projectile', label: '疾影', desc: '投射物弹速 +25%、有效射程 +15%',
      speedMul: 1.25, reachMul: 1.15 },
  },
};
export const classPerkOf = (heroId) => CLASS_PERKS[heroId] || null;
