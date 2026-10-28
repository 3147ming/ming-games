/**
 * 成就面板（Esc 菜单新增页签）
 *
 * ── 定位：只发奖励，不改任何玩法数值 ──────────────────────
 * 成就奖励统一给**代币**（state.tokens），不给金币也不给属性：
 *   · 给金币会直接改动经济曲线（这是需求明令禁止的）
 *   · 代币是既有的、只用于排行榜/兑换的软货币，加它不影响核心循环
 *
 * ── 为什么用"事件汇"而不是每晚遍历判定 ─────────────────────
 * 有些成就的触发点是**瞬间事件**（钓到稀有鱼、连击到 10），
 * 如果只在打烊时判定，就得在 customers/minigames 里到处留痕；
 * 做成 note(type, payload) 事件汇之后，调用方只需在"事情发生的那一行"喊一声，
 * 判定逻辑集中在这里，加新成就不用改玩法模块。
 *
 * ── 分组（P1-5）────────────────────────────────────────────
 * 14 + 6 = 20 条平铺在一个列表里，玩家找不到自己想看的那一栏。
 * 每条带 `group`（'store' 经营 / 'arcade' 街机），面板按组渲染，
 * 顺序固定为「经营在前」—— 这是便利店模拟器，主业是经营。
 *
 * ── 纯逻辑、零 DOM/THREE 依赖 ────────────────────────────
 */

/** 成就定义。check(ctx, prog) → boolean；prog 是跨夜保留的进度容器 */
export const ACHIEVEMENTS = [
  /* ================= 经营（store） ================= */
  {
    id: 'first500', name: '第一桶金', emoji: '💰', tokens: 20, group: 'store',
    desc: '单夜营业收入突破 ¥500',
    on: 'settle',
    check: (c) => c.revenue >= 500,
  },
  {
    id: 'net300', name: '精打细算', emoji: '📈', tokens: 35, group: 'store',
    desc: '单夜净利突破 ¥300',
    on: 'settle',
    check: (c) => c.netProfit >= 300,
  },
  {
    id: 'perfectNight', name: '零失销之夜', emoji: '🎯', tokens: 25, group: 'store',
    desc: '单夜服务 ≥15 人且零失销',
    on: 'settle',
    check: (c) => c.served >= 15 && c.lostSales === 0,
  },
  {
    id: 'sat7', name: '口碑常青', emoji: '🌟', tokens: 50, group: 'store',
    desc: '连续 7 夜满意度 90 以上',
    on: 'settle',
    check: (c, p) => {
      p.sat90 = c.reputation >= 90 ? (p.sat90 ?? 0) + 1 : 0;
      return p.sat90 >= 7;
    },
    progress: (p) => ({ cur: Math.min(p.sat90 ?? 0, 7), max: 7 }),
  },
  {
    /* P1-5：与 perfectNight 刻意错开 —— 那条是"服务 15 人零失销"的单夜挑战，
     * 这条是"连续 3 夜都不掉一个人"的稳定性挑战，两件事不一样。
     * 加 served ≥ 10 的门槛，否则"第一夜一个人没来"也算零失销。 */
    id: 'zeroLost', name: '滴水不漏', emoji: '🧊', tokens: 40, group: 'store',
    desc: '连续 3 夜零失销（每夜至少服务 10 人）',
    on: 'settle',
    check: (c, p) => {
      const ok = (c.lostSales ?? 0) === 0 && (c.served ?? 0) >= 10;
      p.zeroStreak = ok ? (p.zeroStreak ?? 0) + 1 : 0;
      return p.zeroStreak >= 3;
    },
    progress: (p) => ({ cur: Math.min(p.zeroStreak ?? 0, 3), max: 3 }),
  },
  {
    id: 'net1000', name: '千元之夜', emoji: '💎', tokens: 60, group: 'store',
    desc: '单夜净利突破 ¥1000',
    on: 'settle',
    check: (c) => c.netProfit >= 1000,
  },
  {
    /* P1-8 的口径落地：常客数由 main 在结算时从 regulars.snapshot() 取，
     * 这里只判数字，不认识 regulars 模块（保持纯逻辑可单测）。 */
    id: 'regular5', name: '熟客满堂', emoji: '🤝', tokens: 40, group: 'store',
    desc: '同时拥有 5 位常客',
    on: 'settle',
    check: (c) => (c.regularCount ?? 0) >= 5,
    progress: (c) => null,
  },
  {
    id: 'staff3', name: '店有帮手', emoji: '🧑‍🍳', tokens: 35, group: 'store',
    desc: '雇满 3 名员工',
    on: 'settle',
    check: (c) => (c.staffCount ?? 0) >= 3,
  },
  {
    id: 'starStreak3', name: '连星三夜', emoji: '✨', tokens: 45, group: 'store',
    desc: '连续 3 夜拿到 5 星评价',
    on: 'settle',
    check: (c) => (c.starStreak ?? 0) >= 3,
    progress: (c) => ({ cur: Math.min(c.starStreak ?? 0, 3), max: 3 }),
  },
  {
    id: 'survive7', name: '撑过一周', emoji: '🌃', tokens: 50, group: 'store',
    desc: '完成第 7 夜且没有破产',
    on: 'settle',
    check: (c) => (c.night ?? 0) >= 7 && c.weekPassed === true,
  },
  {
    id: 'star3', name: '三星店铺', emoji: '⭐', tokens: 30, group: 'store',
    desc: '店铺星级升到 3 星',
    on: 'star',
    check: (c) => (c.level ?? 0) >= 3,
  },
  {
    id: 'star5', name: '传奇夜班', emoji: '👑', tokens: 60, group: 'store',
    desc: '店铺星级升到 5 星',
    on: 'star',
    check: (c) => (c.level ?? 0) >= 5,
  },
  {
    /* P1-5：上限从 6 降到 4。P0-2 把第 7 夜钉成节日夜之后，
     * 一周只有 6 个可摇夜位，还要求"抽齐全部 6 种普通主题"，
     * 概率低到接近不可达（且玩家毫无操作空间，纯看脸）。
     * 4 种既保留了"见识多种夜"的意图，又能在一周内稳定达成。 */
    id: 'allThemes', name: '见多识广', emoji: '🎭', tokens: 30, group: 'store',
    desc: '经历过 4 种不同的夜间主题',
    on: 'theme',
    check: (c, p) => {
      p.themes = p.themes ?? {};
      if (c.themeId) p.themes[c.themeId] = true;
      return Object.keys(p.themes).length >= 4;
    },
    progress: (p) => ({ cur: Math.min(Object.keys(p.themes ?? {}).length, 4), max: 4 }),
  },

  /* ================= 街机（arcade） ================= */
  {
    id: 'clawDex', name: '娃娃图鉴', emoji: '🧸', tokens: 40, group: 'arcade',
    desc: '抓齐抓娃娃机的全部 3 种奖品',
    on: 'claw',
    check: (c, p) => {
      p.dex = p.dex ?? {};
      if (c.prizeName) p.dex[c.prizeName] = true;
      return Object.keys(p.dex).length >= (c.totalPrizes ?? 3);
    },
    progress: (p) => ({ cur: Object.keys(p.dex ?? {}).length, max: 3 }),
  },
  {
    id: 'rareFish', name: '锦鲤上岸', emoji: '🎣', tokens: 30, group: 'arcade',
    desc: '钓到一条稀有鱼',
    on: 'fish',
    check: (c) => c.rare === true,
  },
  {
    id: 'combo10', name: '弹珠连击', emoji: '🎰', tokens: 15, group: 'arcade',
    desc: '弹珠机单局连击达到 10',
    on: 'pachinko',
    check: (c) => (c.combo ?? 0) >= 10,
  },
  {
    id: 'streak5', name: '神射手', emoji: '🏀', tokens: 15, group: 'arcade',
    desc: '投篮机连中 5 球',
    on: 'basket',
    check: (c) => (c.streak ?? 0) >= 5,
  },
  {
    id: 'dance30', name: '节奏大师', emoji: '🕺', tokens: 20, group: 'arcade',
    desc: '跳舞机单局连击达到 30',
    on: 'dance',
    check: (c) => (c.combo ?? 0) >= 30,
  },
  {
    id: 'racer5', name: '漂移之王', emoji: '🏎️', tokens: 20, group: 'arcade',
    desc: '赛车机单局完成 5 次完美过弯',
    on: 'racing',
    check: (c) => (c.perfect ?? 0) >= 5,
  },
  {
    id: 'ktv90', name: '麦霸', emoji: '🎤', tokens: 20, group: 'arcade',
    desc: 'KTV 单曲得分达到 90',
    on: 'ktv',
    check: (c) => (c.score ?? 0) >= 90,
  },
];

export const ACHIEVEMENT_BY_ID = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a]));

/** 分组展示顺序与标题（面板按此渲染；未登记的分组退到列表末尾） */
export const ACHIEVEMENT_GROUPS = [
  { id: 'store', title: '🏪 经营' },
  { id: 'arcade', title: '🎮 街机' },
];

/**
 * @param {object} opts
 * @param {object} opts.state
 * @param {(ach: object) => void} opts.onUnlock 解锁回调（弹提示 / 放音效）
 */
export function createAchievements(opts = {}) {
  const state = opts.state;
  const onUnlock = typeof opts.onUnlock === 'function' ? opts.onUnlock : null;

  /** 已解锁表 { [id]: true } */
  const done = () => {
    if (!state.achievements || typeof state.achievements !== 'object') state.achievements = {};
    return state.achievements;
  };
  /** 跨夜进度容器 { dex:{}, sat90:0, themes:{}, zeroStreak:0 } */
  const prog = () => {
    if (!state.achProgress || typeof state.achProgress !== 'object') state.achProgress = {};
    return state.achProgress;
  };

  function unlocked(id) {
    return done()[id] === true;
  }

  /**
   * 事件汇：在"事情发生的那一行"调用。
   * @param {string} type 见 ACHIEVEMENTS[].on
   * @param {object} ctx  判定所需的字段
   * @returns 本次新解锁的成就数组
   */
  function note(type, ctx = {}) {
    const got = [];
    for (const a of ACHIEVEMENTS) {
      if (a.on !== type) continue;
      if (unlocked(a.id)) continue;
      let ok = false;
      try { ok = !!a.check(ctx, prog()); } catch { ok = false; }
      if (!ok) continue;
      done()[a.id] = true;
      state.tokens = (Number.isFinite(state.tokens) ? state.tokens : 0) + a.tokens;
      got.push(a);
      try { onUnlock?.(a); } catch { /* 提示失败不该影响解锁 */ }
    }
    return got;
  }

  /** 面板数据（含进度与是否已解锁） */
  function list() {
    const p = prog();
    return ACHIEVEMENTS.map((a) => {
      const pr = typeof a.progress === 'function' ? a.progress(p) : null;
      return {
        id: a.id, name: a.name, emoji: a.emoji, desc: a.desc, tokens: a.tokens,
        group: a.group ?? 'store',
        done: unlocked(a.id),
        progress: pr ? { cur: pr.cur, max: pr.max } : null,
      };
    });
  }

  function count() {
    return { done: ACHIEVEMENTS.filter((a) => unlocked(a.id)).length, total: ACHIEVEMENTS.length };
  }

  /** 已发代币总量（结算里可以显示"成就奖励 +N 代币"） */
  function totalTokens() {
    return ACHIEVEMENTS.filter((a) => unlocked(a.id)).reduce((s, a) => s + a.tokens, 0);
  }

  return { note, list, count, unlocked, totalTokens };
}

export default createAchievements;
