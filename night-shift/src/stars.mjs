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

import { STAR_UNLOCKS } from './config.mjs';

/** 双达标门槛：营业额（¥）与满意度（0–100） */
export const STAR_TARGETS = { revenue: 350, satisfaction: 62 };
/** 星级上限 */
export const STAR_MAX = 5;
/** 需要连续达标的夜数 */
export const STAR_STREAK_NEED = 3;

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
    const passed = revenue >= STAR_TARGETS.revenue && satisfaction >= STAR_TARGETS.satisfaction;

    if (!passed) {
      state.starStreak = 0;
      return { leveled: false, level: level(), streak: 0, passed: false };
    }

    state.starStreak = numOr(state.starStreak) + 1;
    let leveled = false;
    if (state.starStreak >= STAR_STREAK_NEED && level() < STAR_MAX) {
      state.starStreak = 0;
      state.star = level() + 1;
      leveled = true;
      for (const u of unlocksAt(state.star)) {
        try { onUnlock?.(u); } catch { /* 解锁失败不该拖垮结算 */ }
      }
    }
    return { leveled, level: level(), streak: state.starStreak, passed: true };
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
    get targets() { return { ...STAR_TARGETS }; },
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
        targets: { ...STAR_TARGETS },
        staffCapBonus: staffCapBonus(),
        unlocked: unlocksUpTo(level()).map((u) => ({ star: u.star, name: u.name, desc: u.desc })),
      };
    },
  };
}

export default createStars;
