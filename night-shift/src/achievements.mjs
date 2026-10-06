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
 * ── 纯逻辑、零 DOM/THREE 依赖 ────────────────────────────
 */

/** 成就定义。check(ctx, prog) → boolean；prog 是跨夜保留的进度容器 */
export const ACHIEVEMENTS = [
  {
    id: 'first500', name: '第一桶金', emoji: '💰', tokens: 20,
    desc: '单夜营业收入突破 ¥500',
    on: 'settle',
    check: (c) => c.revenue >= 500,
  },
  {
    id: 'net300', name: '精打细算', emoji: '📈', tokens: 35,
    desc: '单夜净利突破 ¥300',
    on: 'settle',
    check: (c) => c.netProfit >= 300,
  },
  {
    id: 'perfectNight', name: '零失销之夜', emoji: '🎯', tokens: 25,
    desc: '单夜服务 ≥15 人且零失销',
    on: 'settle',
    check: (c) => c.served >= 15 && c.lostSales === 0,
  },
  {
    id: 'sat7', name: '口碑常青', emoji: '🌟', tokens: 50,
    desc: '连续 7 夜满意度 90 以上',
    on: 'settle',
    check: (c, p) => {
      p.sat90 = c.reputation >= 90 ? (p.sat90 ?? 0) + 1 : 0;
      return p.sat90 >= 7;
    },
    progress: (p) => ({ cur: Math.min(p.sat90 ?? 0, 7), max: 7 }),
  },
  {
    id: 'clawDex', name: '娃娃图鉴', emoji: '🧸', tokens: 40,
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
    id: 'rareFish', name: '锦鲤上岸', emoji: '🎣', tokens: 30,
    desc: '钓到一条稀有鱼',
    on: 'fish',
    check: (c) => c.rare === true,
  },
  {
    id: 'combo10', name: '弹珠连击', emoji: '🎰', tokens: 15,
    desc: '弹珠机单局连击达到 10',
    on: 'pachinko',
    check: (c) => (c.combo ?? 0) >= 10,
  },
  {
    id: 'streak5', name: '神射手', emoji: '🏀', tokens: 15,
    desc: '投篮机连中 5 球',
    on: 'basket',
    check: (c) => (c.streak ?? 0) >= 5,
  },
  {
    id: 'dance30', name: '节奏大师', emoji: '🕺', tokens: 20,
    desc: '跳舞机单局连击达到 30',
    on: 'dance',
    check: (c) => (c.combo ?? 0) >= 30,
  },
  {
    id: 'racer5', name: '漂移之王', emoji: '🏎️', tokens: 20,
    desc: '赛车机单局完成 5 次完美过弯',
    on: 'racing',
    check: (c) => (c.perfect ?? 0) >= 5,
  },
  {
    id: 'ktv90', name: '麦霸', emoji: '🎤', tokens: 20,
    desc: 'KTV 单曲得分达到 90',
    on: 'ktv',
    check: (c) => (c.score ?? 0) >= 90,
  },
  {
    id: 'star3', name: '三星店铺', emoji: '⭐', tokens: 30,
    desc: '店铺星级升到 3 星',
    on: 'star',
    check: (c) => (c.level ?? 0) >= 3,
  },
  {
    id: 'star5', name: '传奇夜班', emoji: '👑', tokens: 60,
    desc: '店铺星级升到 5 星',
    on: 'star',
    check: (c) => (c.level ?? 0) >= 5,
  },
  {
    id: 'allThemes', name: '见多识广', emoji: '🎭', tokens: 30,
    desc: '经历过全部 6 种夜间主题',
    on: 'theme',
    check: (c, p) => {
      p.themes = p.themes ?? {};
      if (c.themeId) p.themes[c.themeId] = true;
      return Object.keys(p.themes).length >= 6;
    },
    progress: (p) => ({ cur: Object.keys(p.themes ?? {}).length, max: 6 }),
  },
];

export const ACHIEVEMENT_BY_ID = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a]));

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
  /** 跨夜进度容器 { dex:{}, sat90:0, themes:{} } */
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
