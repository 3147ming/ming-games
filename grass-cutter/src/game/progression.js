/**
 * 一局内的成长（第 3 批 P0-5）—— 纯逻辑，不 import three / 不碰 DOM。
 * ---------------------------------------------------------------------------
 * 只管"经验 → 等级 → 待选卡次数 → 加成倍率"四件事；
 * 卡池与抽卡在 cards.js，弹层在 ui/levelUp.js，接在 main 的三处（经验 / 暂停 / HUD）。
 *
 * ⚠ 为什么 `mods` 是一个**可变对象**而不是每次算一份新的：
 *   main 里执行的是 `combat.mods = run.mods`（同一个引用），于是 `take()` 改完
 *   `this.mods` 之后**下一帧立刻生效**，不需要任何同步代码。反过来（每次返回新对象）
 *   就必须记得在每次选卡后重新赋值，漏一处就是"选了没效果"。
 *
 * 数值口径：12 点/杀 → 第 1 级 60 点 = **5 杀**升一级；
 * 满 12 级累计约 4478 点 ≈ 375 杀，正好卡在"进 Boss 战前后点满"。
 */
export const RUN_LEVEL = { XP_BASE: 60, XP_GROWTH: 1.35, MAX_LEVEL: 12, XP_PER_KILL: 12 };

export class RunProgress {
  constructor(cfg = RUN_LEVEL) {
    this.cfg = cfg;
    this.level = 1;
    this.xp = 0;
    this.pending = 0;   // 待选卡次数（>0 时游戏暂停等玩家选）
    this.taken = [];    // 已选卡 id（顺序保留，抽卡按它算 cap）
    /* 内容批：新增三个键 —— attackSpeed（出招间隔倍率，1 = 原速，越大越快）、
       reach（攻击距离倍率）、kiMaxBonus（斗气上限绝对值）。
       ★ 这里与 cards.js 的 mods 键必须逐字一致，漏一个就是"选了没效果"。 */
    this.mods = {
      damage: 1, kiRegen: 1, musouGain: 1, lifesteal: 0, maxHpBonus: 0,
      attackSpeed: 1, reach: 1, kiMaxBonus: 0,
    };
  }

  /** 升到下一级还差多少经验 */
  get need() {
    return Math.round(this.cfg.XP_BASE * Math.pow(this.cfg.XP_GROWTH, this.level - 1));
  }

  get maxLevel() {
    return this.level >= this.cfg.MAX_LEVEL;
  }

  addKill(n = 1) {
    return this.addXp(this.cfg.XP_PER_KILL * n);
  }

  /**
   * 加经验。返回本次**升了几级**（可能 >1：连杀跨两级时 pending 会是 2）。
   * 满级后不再累积（否则 HUD 上的经验条会永远顶在 100%）。
   */
  addXp(n) {
    if (this.maxLevel) return 0;
    if (!Number.isFinite(n) || n <= 0) return 0;
    this.xp += n;
    let up = 0;
    while (this.level < this.cfg.MAX_LEVEL && this.xp >= this.need) {
      this.xp -= this.need;
      this.level++;
      this.pending++;
      up++;
    }
    if (this.maxLevel) this.xp = Math.min(this.xp, this.need); // 满级后不留溢出
    return up;
  }

  /**
   * 选走一张卡。mods 的键与 cards.js 里 `mods` 的键**必须逐字一致**（拼错一个键 = 选了没效果）。
   * 未知键直接累加到 0 上，语义仍是"加法"（伤害/斗气/无双是 1 基准的倍率，回血/上限是绝对值）。
   */
  take(card) {
    if (!card || !card.mods) return this.mods;
    for (const k in card.mods) this.mods[k] = (this.mods[k] ?? 0) + card.mods[k];
    this.taken.push(card.id);
    this.pending = Math.max(0, this.pending - 1);
    return this.mods;
  }

  snapshot() {
    return {
      level: this.level,
      xp: this.xp,
      need: this.need,
      pending: this.pending,
      maxLevel: this.maxLevel,
      taken: [...this.taken],
      mods: { ...this.mods },
    };
  }
}
