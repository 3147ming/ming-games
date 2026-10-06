/**
 * 夜间主题（每晚首次开店时宣布的随机主题）
 *
 * ── 定位：只做表现层与成长线，不改动既有玩法数值 ──────────────
 * 主题**不是**新的玩法系统，它是一组乘数，作用在既有系统的既有入口上：
 *   · arrivalMul  → 乘在 state.arrivalsTarget（customers 的既有到店量）
 *   · priceMul    → 乘在 checkout 的计价（economy 的既有公式）
 *   · litterMul   → 乘在垃圾生成间隔（worldstate 的既有计时）
 *   · breakdownMul→ 乘在故障概率（worldstate 的既有判定）
 *   · typeWeight  → 乘在顾客类型抽取权重（npcs 的既有 pickType）
 *   · preferKinds → 覆盖顾客类型偏好（npcs 的既有 pickPlayFacility）
 * 也就是说：主题关掉后，所有系统回到乘数 = 1 的原样，核心循环一行没改。
 *
 * ── 为什么"明晚主题"要提前摇好 ────────────────────────────
 * 情报服务要能"预知明晚主题"，就必须**在今晚开始前就已经把明晚的主题定下来**。
 * 否则玩家买完情报、读档重来一次，明晚主题就变了 —— 那是骗钱。
 * 所以 state 里同时存 themeId（今晚）与 themeNextId（明晚，已定死）。
 *
 * ── 纯逻辑、零 DOM/THREE 依赖 ────────────────────────────
 * rng 可注入 → 可在 Node 里断言"抽主题的分布"与"效果合成"。
 */

import { viewNextTheme, lockNextTheme } from './boons.mjs';

/** 情报服务（Tab 商店购买）：花少量金币预知明晚主题 */
export const INTEL_COST = 60;

/** 效果默认值：任何主题没写的字段都取这里的值（保证"关掉主题 = 原样"） */
export const DEFAULT_EFFECTS = {
  /** 客流倍率（乘在 arrivalsTarget） */
  arrivalMul: 1,
  /** 单次消费倍率（乘在结账金额） */
  spendMul: 1,
  /** 小费倍率（乘在常客小费部分） */
  tipMul: 1,
  /** 全店售价倍率（促销夜 0.8 = 全店 8 折） */
  priceMul: 1,
  /** 单台设备利润倍率 */
  playProfitMul: 1,
  /** 垃圾生成速度倍率 */
  litterMul: 1,
  /** 设备故障率倍率 */
  breakdownMul: 1,
  /** 顾客停留时间倍率 */
  stayMul: 1,
  /** 顾客类型权重倍率：{ youth: 2.2 } */
  typeWeight: {},
  /** 强制偏好设施 kind（覆盖顾客类型的 prefer）；null = 不改 */
  preferKinds: null,
  /** 老主顾（常客）必到 */
  regularsGuaranteed: false,
  /** 超大客流高峰的起始游戏小时（0..8）；null = 无 */
  surgeAtHour: null,
  /** 高峰持续游戏小时 */
  surgeHours: 0,
  /** 高峰期间的客流倍率 */
  surgeMul: 1,
};

export const THEMES = [
  {
    id: 'normal', name: '普通夜', emoji: '🌙', weight: 34,
    desc: '平平淡淡的一夜 · 没有加成也没有扣减',
    effects: {},
  },
  {
    id: 'student', name: '学生夜', emoji: '🎒', weight: 16,
    desc: '学生客暴增 · 偏爱跳舞机与赛车机 · 消费更高 · 垃圾速度 +50%',
    effects: {
      typeWeight: { youth: 2.2, child: 0.7 },
      preferKinds: ['dance', 'racing'],
      spendMul: 1.25,
      litterMul: 1.5,
    },
  },
  {
    id: 'promo', name: '促销夜', emoji: '🏷️', weight: 14,
    desc: '全店 8 折 · 客流翻倍 · 单台设备利润下降',
    effects: { priceMul: 0.8, arrivalMul: 2.0, playProfitMul: 0.75 },
  },
  {
    id: 'rain', name: '雨夜', emoji: '🌧️', weight: 14,
    desc: '客流减半 · 老主顾必到 · 小费更高',
    effects: { arrivalMul: 0.5, regularsGuaranteed: true, tipMul: 1.6 },
  },
  {
    id: 'exam', name: '考试周夜', emoji: '📚', weight: 12,
    desc: '学生减半 · 老年客上升 · 偏爱简单机器',
    effects: { typeWeight: { youth: 0.5, elder: 2.0 }, preferKinds: ['vending'] },
  },
  {
    id: 'weekend', name: '周末狂欢夜', emoji: '🎉', weight: 10,
    desc: '中段 2 小时超大客流 · 垃圾与故障率同步上升',
    effects: {
      surgeAtHour: 3, surgeHours: 2, surgeMul: 2.4,
      litterMul: 1.4, breakdownMul: 1.5,
    },
  },
  /* ---------- 节日限定夜（模块 4 子功能④） ----------
   * 设计：就是三条"有节日味"的主题，效果全乘在既有入口（与所有主题同口径）。
   * 预告走 themeNextId 既有机制（开新一夜时已把明晚主题定死，情报服务可预知）。
   * 额外在 startNight 给"明晚是节日"弹一条提前预告 toast（见 main.mjs）。 */
  {
    id: 'halloween', name: '万圣节限定夜', emoji: '🎃', weight: 6, festival: true,
    desc: '🎃 鬼影憧憧！客流 +30% · 垃圾与故障率上升 · 小费更高',
    effects: {
      arrivalMul: 1.3, litterMul: 1.3, breakdownMul: 1.2,
      tipMul: 1.3, spendMul: 1.1,
    },
  },
  {
    id: 'newyear', name: '跨年限定夜', emoji: '🎆', weight: 5, festival: true,
    desc: '🎆 倒数跨年！客流 +50% · 开局超大高峰 · 消费与小费齐飞',
    effects: {
      arrivalMul: 1.5, spendMul: 1.3, tipMul: 1.4, playProfitMul: 1.1,
      surgeAtHour: 0.5, surgeHours: 1.5, surgeMul: 2.2,
    },
  },
  {
    id: 'anniversary', name: '店庆限定夜', emoji: '🎂', weight: 5, festival: true,
    desc: '🎂 便利店周年庆！全场 9 折 · 客流 +40% · 设备收益提升',
    effects: {
      priceMul: 0.9, arrivalMul: 1.4, playProfitMul: 1.2, tipMul: 1.3,
    },
  },
];

/** 是否为节日限定夜（模块 4：用于提前一夜预告） */
export function isFestival(themeId) {
  const t = THEME_BY_ID[themeId];
  return !!(t && t.festival === true);
}

export const THEME_BY_ID = Object.fromEntries(THEMES.map((t) => [t.id, t]));

const clampNum = (v, d) => (Number.isFinite(v) ? v : d);

/** 按 weight 抽一个主题（rng 可注入，便于测试确定性） */
export function rollTheme(rng = Math.random) {
  const total = THEMES.reduce((a, t) => a + (t.weight ?? 1), 0);
  let x = rng() * total;
  for (const t of THEMES) {
    x -= (t.weight ?? 1);
    if (x <= 0) return t;
  }
  return THEMES[THEMES.length - 1];
}

/**
 * @param {object} opts
 * @param {object} opts.state  全局状态
 * @param {() => number} opts.rng
 * @param {(theme: object) => void} opts.onChange 主题切换回调（横幅 / 音效）
 */
export function createThemes(opts = {}) {
  const state = opts.state;
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : null;

  /** 当前生效的效果对象（已与默认值合并，缺字段 = 不改） */
  function effects() {
    const t = THEME_BY_ID[state.themeId] ?? THEMES[0];
    return { ...DEFAULT_EFFECTS, ...(t.effects ?? {}) };
  }

  function current() {
    return THEME_BY_ID[state.themeId] ?? THEMES[0];
  }

  /**
   * 开新一夜时调用：把"明晚（已定死）"翻成"今晚"，再摇出新的明晚。
   * 第一次调用时 state.themeNextId 为空 → 直接摇今晚。
   *
   * 主题情报锁定（state.intel.lockedId）优先于随机：锁定只对"紧接着的这一夜"有效，
   * 生效后立刻清空（consumeLock），否则玩家能一次锁定把整周主题都钉死。
   */
  function rollForNight() {
    const locked = state.intel?.lockedId ?? null;
    const tonight = locked ?? (THEME_BY_ID[state.themeNextId] ? state.themeNextId : rollTheme(rng).id);
    state.themeId = tonight;
    state.themeNextId = rollTheme(rng).id;
    // 上一夜买的情报只对"上一夜所预知的那一夜"有效，翻页后失效
    state.intelNight = null;
    // 锁定与情报都是"一次性"：翻页即消耗（无论今晚是否真的用了锁定）
    state.intel = { next: 0, lockedId: null };
    onChange?.(current());
    return current();
  }

  /** 明晚主题（未买情报时返回 null —— 不知道就是不知道） */
  function forecast() {
    if (state.intelNight !== state.night) return null;
    return THEME_BY_ID[state.themeNextId] ?? null;
  }

  /**
   * 购买情报服务。
   * @param {() => {ok:boolean, reason?:string}} payFn 扣款（由 economy 提供，保持本模块不碰现金规则）
   */
  function buyIntel(payFn) {
    if (forecast()) return { ok: false, reason: '已经知道明晚主题了' };
    const paid = typeof payFn === 'function'
      ? payFn(INTEL_COST)
      : { ok: true };
    if (!paid?.ok) return { ok: false, reason: paid?.reason ?? '现金不足' };
    state.intelNight = state.night;
    return { ok: true, theme: THEME_BY_ID[state.themeNextId] ?? null, cost: INTEL_COST };
  }

  /** 顶部横幅文案 */
  function bannerText() {
    const t = current();
    return `${t.emoji} 今夜主题：${t.name} — ${t.desc}`;
  }

  /** 高峰时间窗（游戏小时）；无高峰返回 null */
  function surgeWindow() {
    const e = effects();
    if (e.surgeAtHour === null || e.surgeAtHour === undefined) return null;
    return { from: e.surgeAtHour, to: e.surgeAtHour + clampNum(e.surgeHours, 0), mul: clampNum(e.surgeMul, 1) };
  }

  /** 结算里"主题加成扣减"那几行（账本里 kind==='theme' 的条目） */
  function settleLines(ledger) {
    const t = current();
    const rows = (ledger?.byKind?.('theme') ?? []).map((e) => ({
      label: e.label,
      value: e.value,
      kind: 'theme',
    }));
    return { theme: t, rows };
  }

  return {
    rollForNight, current, effects, forecast, buyIntel, bannerText, surgeWindow, settleLines,
    /** 顾客类型权重倍率（缺省 1） */
    typeWeightMul(typeId) {
      const w = effects().typeWeight ?? {};
      return clampNum(w[typeId], 1);
    },
    /** 强制偏好（null = 沿用顾客类型自己的 prefer） */
    preferKinds() {
      return effects().preferKinds ?? null;
    },
    /** 供 scene/hud 读取的只读快照 */
    snapshot() {
      const t = current();
      return {
        id: t.id, name: t.name, emoji: t.emoji, desc: t.desc,
        next: forecast()?.id ?? null,
        intelCost: INTEL_COST,
        effects: effects(),
        /** 主题情报（代币版）：锁定状态 + 候选池，供商店"锁定明晚"分区用 */
        intel: {
          viewed: !!(state.intel && state.intel.next),
          lockedId: state.intel?.lockedId ?? null,
        },
      };
    },

    /**
     * 主题情报（代币）：查看明晚主题 / 锁定明晚主题。
     * 与既有"现金情报服务 buyIntel"并存 —— 那条花现金、只告知；这条花代币、可锁定。
     * 扣费与锁定逻辑放在 boons.mjs（纯逻辑可单测），这里只做 themes 侧的取值。
     */
    viewNext(payFn) {
      const r = viewNextTheme(state);
      if (!r.ok) return r;
      if (r.cached) return { ...r, theme: THEME_BY_ID[state.themeNextId] ?? null };
      if (typeof payFn === 'function') payFn(r);
      return { ...r, theme: THEME_BY_ID[state.themeNextId] ?? null };
    },

    /** 锁定明晚主题；候选池排除节日限定（节日由系统按预告 mechanics 推给玩家，不该被钉死） */
    lockNext(themeId) {
      const r = lockNextTheme(state, themeId);
      if (!r.ok) return r;
      return { ...r, theme: THEME_BY_ID[themeId] ?? null };
    },

    /** 锁定候选池：非节日限定主题 */
    lockCandidates() {
      return THEMES.filter((t) => !t.festival);
    },
  };
}

export default createThemes;
