/**
 * 店铺星级（成长线）
 *
 * 规则（需求原文）：连续 3 夜「营业额」与「满意度」双达标 → 升 1 星，上限 5 星。
 * 每升 1 星：解锁新机器 + 新装修 + 店员上限 +1。
 *
 * ── 为什么"达标"判据不写进 economy.settleNight ──────────────
 * settleNight 是既有核心循环的一部分，往里塞星级判定会让它同时承担
 * "算账"和"发奖"两件事，而且 economy.test 里有对 report 字段的断言。
 * 所以这里只**读** report（营业额 / 满意度），自己维护 streak 与 level，
 * 升星的副作用通过 onUnlock 回调交给 main 去落地（注册设施 / 装修 / 店员上限）。
 *
 * ── 为什么"连续"要清零 ──────────────────────────────────
 * 只达标 2 夜就断掉的话，如果 streak 不清零，玩家会因为"累计"而在第 4 夜突然升星，
 * 与"连续 3 夜"的字面承诺不符。所以断档即归零（UI 上要显示 streak，玩家能看见断点）。
 */

import { STAR_UNLOCKS, ARRIVALS_PER_NIGHT, NIGHTS_PER_WEEK, nightCurve, nightInWeek } from './config.mjs';

/** 双达标门槛基准值（第 1 周的营业额基准；实际门槛按夜次缩放，见 starTargets） */
export const STAR_TARGETS = { revenue: 350, satisfaction: 62 };
/** 星级上限 */
export const STAR_MAX = 5;
/** 需要连续达标的夜数（内容批 P0-1：3 → 2，让 7 夜内容纳 3 次升星） */
export const STAR_STREAK_NEED = 2;
/** 周终奖励星：第 7 夜若双达标，额外 +1 星（内容批 P0-1，5★ 的唯一来源） */
export const STAR_WEEK_BONUS = true;

/**
 * 当夜的双达标门槛（内容批 P0-1）。
 * 机制批 P0-5 的 NIGHT_CURVE 会把客流从 18 拉到 32，固定 ¥350 会让第 1 夜
 * 几乎不可能达标、第 7 夜空手就过线 —— 门槛必须跟着客流一起涨。
 */
export function starTargets(night) {
  /* P0-5：门槛按**周内夜次**缩放，不按绝对夜号。
   * 否则第 8 夜（第 2 周第 1 夜）会按第 7 夜的客流门槛算，与第 1 周手感彻底错位。 */
  const cur = nightCurve(nightInWeek(night));
  const scale = (cur.arrivalsMul ?? 1);
  return {
    revenue: Math.round(STAR_TARGETS.revenue * scale),
    satisfaction: STAR_TARGETS.satisfaction,
  };
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const numOr = (v, d = 0) => (Number.isFinite(v) ? v : d);

/** 某一星对应的解锁内容（2 星起才有；1 星是起点，没有解锁） */
export function unlocksAt(level) {
  return STAR_UNLOCKS.filter((u) => u.star === level);
}

/** 当前星级下**已解锁**的全部条目 */
export function unlocksUpTo(level) {
  return STAR_UNLOCKS.filter((u) => u.star <= level);
}

/**
 * @param {object} opts
 * @param {object} opts.state
 * @param {(unlock: object) => void} opts.onUnlock  升星时回调（main 注册设施 / 装修）
 */
export function createStars(opts = {}) {
  const state = opts.state;
  const onUnlock = typeof opts.onUnlock === 'function' ? opts.onUnlock : null;

  function level() {
    return clamp(numOr(state.star, 1), 1, STAR_MAX);
  }

  /** 店员上限加成（每星 +1，1 星为 +0） */
  function staffCapBonus() {
    return level() - 1;
  }

  /**
   * 打烊后判定。
   * @param report economy.settleNight() 的返回值
   * @returns { leveled:boolean, level:number, streak:number, passed:boolean }
   */
  function evaluate(report) {
    const revenue = numOr(report?.revenue);
    const satisfaction = numOr(report?.reputation);
    /* ⚠ 门槛按夜次取（内容批 P0-1 B）：客流随夜次上涨，门槛必须同步，
     * 否则第 1 夜永远不达标、第 7 夜躺着达标，星级就失去意义了。 */
    const targets = starTargets(numOr(report?.night, state.night));
    const passed = revenue >= targets.revenue && satisfaction >= targets.satisfaction;

    if (!passed) {
      state.starStreak = 0;
      return { leveled: false, level: level(), streak: 0, passed: false };
    }

    state.starStreak = numOr(state.starStreak) + 1;
    let leveled = false;
    let weekBonus = false;
    if (state.starStreak >= STAR_STREAK_NEED && level() < STAR_MAX) {
      state.starStreak = 0;
      state.star = level() + 1;
      leveled = true;
      for (const u of unlocksAt(state.star)) {
        try { onUnlock?.(u); } catch { /* 解锁失败不该拖垮结算 */ }
      }
    }
    /* 周终加冕：第 7 夜双达标再 +1 星。
     * 没有这一下，一周最多 3★ —— 4★/5★ 的机器、装修、成就、CG 全是死内容。 */
    if (STAR_WEEK_BONUS && level() < STAR_MAX
        && nightInWeek(numOr(report?.night, 0)) === NIGHTS_PER_WEEK) {
      state.star = level() + 1;
      leveled = true;
      weekBonus = true;
      for (const u of unlocksAt(state.star)) {
        try { onUnlock?.(u); } catch { /* 解锁失败不该拖垮结算 */ }
      }
    }
    return { leveled, level: level(), streak: state.starStreak, passed: true, weekBonus };
  }

  /** 左下角 / 结算里的进度文案 */
  function progressText() {
    const lv = level();
    if (lv >= STAR_MAX) return `⭐ ${lv} 星 · 已满级`;
    const need = STAR_STREAK_NEED - numOr(state.starStreak);
    return `⭐ ${lv} 星 · 再连续 ${need} 夜达标升星`;
  }

  /** HUD 星级串 */
  function starString() {
    const lv = level();
    return '★'.repeat(lv) + '☆'.repeat(STAR_MAX - lv);
  }

  return {
    level, evaluate, staffCapBonus, progressText, starString,
    get streak() { return numOr(state.starStreak); },
    /** 当夜门槛（随夜次缩放，见 starTargets） */
    get targets() { return starTargets(state.night); },
    /** 下一档解锁预览（结算 / 商店里告诉玩家"再升一星能拿到什么"） */
    nextUnlock() {
      const lv = level();
      return STAR_UNLOCKS.find((u) => u.star === lv + 1) ?? null;
    },
    /** 已解锁的设施 id 列表（读档后重建场景用） */
    unlockedFacilityIds() {
      return unlocksUpTo(level()).flatMap((u) => (u.facilities ?? []).map((f) => f.id));
    },
    snapshot() {
      return {
        level: level(),
        streak: numOr(state.starStreak),
        need: STAR_STREAK_NEED,
        max: STAR_MAX,
        targets: starTargets(state.night),
        staffCapBonus: staffCapBonus(),
        unlocked: unlocksUpTo(level()).map((u) => ({ star: u.star, name: u.name, desc: u.desc })),
      };
    },
  };
}

export default createStars;
