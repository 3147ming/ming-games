/**
 * 常客系统（模块 4 子功能③）
 *
 * ── 定位：只加不改，零 DOM / 零 THREE ──────────────────────
 * 给每位顾客生成一个**脸谱 id（faceId）**，跨夜累计"到店夜数"。
 * 同一张脸满 3 夜（REGULARS.nightsToRegular）即升级为熟客，带"熟"标，
 * 结账时**复用 economy.checkout 里既有的 isRegular 加成**（口碑 +1 / 小费 ×1.1），
 * 一行既有逻辑都不用改 —— 这正是"只加不改"的体现。
 *
 * ── 与既有系统的边界 ──────────────────────────────────────
 *   · 不改动 customers 的动线/排队/失销判定；只在 spawn 时注入一个可选钩子
 *     regularJudge(faceId)，返回是否熟客与展示用 name/emoji/tag。
 *   · 与 customers.spawnRegular()（随机常客事件）**并存**：两者都让 isRegular=true，
 *     但本系统的常客是"同一张脸跨夜培养出来的"，多一层身份感。
 *
 * ── 跨夜持久化 ────────────────────────────────────────────
 *   state.regularFaces 进存档白名单；nights 数组存夜号（去重），读档后连续。
 *
 * ── 纯逻辑、零 THREE/DOM 依赖（可在 Node 单测） ─────────────
 */

import { REGULARS, WORD_OF_MOUTH } from './config.mjs';

const FACE_EMOJI = ['😀', '🤓', '😎', '🥰', '🧑', '👩', '👨', '🧔', '👵', '🧒', '🧑‍🦰', '👱'];

let pick = 0;

/**
 * @param opts.state    state.mjs 单一真源
 * @param opts.rng      () => number
 * @param opts.onEvent  (type, payload) => void
 */
export function createRegulars(opts = {}) {
  const state = opts.state;
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};

  function ensure() {
    if (!state.regularFaces || typeof state.regularFaces !== 'object') state.regularFaces = {};
    return state.regularFaces;
  }

  /**
   * 顾客进店时调用：登记这张脸今夜到店，并判定是否已是熟客。
   * @param faceId   稳定的脸谱标识（由 customers 生成并传入）
   * @returns { regular:boolean, name:string, emoji:string, tag:string|null, nights:number }
   */
  function judge(faceId) {
    const faces = ensure();
    const night = state.night;
    let entry = faces[faceId];
    if (!entry) {
      entry = {
        nights: [],
        name: REGULARS.names[Math.floor(rng() * REGULARS.names.length)],
        emoji: FACE_EMOJI[pick++ % FACE_EMOJI.length],
        /* 2026-10-06 块2：新脸入场时抽一个偏好商品 + 忠诚度归零。
         * 偏好只从 preferPool 里抽（不抽 festival —— 节日限定商品当天可能根本没进过货，
         * 常客抱着"想买节日礼盒"的执念却永远买不到，那不是ident感，是挫败）。 */
        prefer: REGULARS.loyalty.preferPool[Math.floor(rng() * REGULARS.loyalty.preferPool.length)],
        loyalty: 0,
      };
      faces[faceId] = entry;
    }
    // 同一夜多次到店只记一次（去重），避免"刷脸刷出熟客"
    if (!entry.nights.includes(night)) entry.nights.push(night);
    const nights = entry.nights.length;
    const regular = nights >= REGULARS.nightsToRegular;
    if (regular && entry.nights.length === REGULARS.nightsToRegular) {
      // 恰好达成当夜首次升级：提示一次
      onEvent('regular-promote', { name: entry.name, emoji: entry.emoji });
    }
    return {
      regular,
      name: entry.name,
      emoji: entry.emoji,
      tag: regular ? REGULARS.tag : null,
      nights,
      /* 块2 扩展字段 */
      prefer: entry.prefer ?? null,
      loyalty: entry.loyalty ?? 0,
      loyaltyLabel: loyaltyLabel(entry.loyalty ?? 0),
      discount: loyaltyDiscount(entry),
    };
  }

  /* ---------- 2026-10-06 块2：忠诚度 ---------- */

  /** 忠诚度等级（0..maxLevel），老存档没有该字段时按 0 兜底
   *
   *  ⚠ 上钳要用**数组长度**而不是配置里的 maxLevel：discountByLevel 只有 5 个元素
   *  （索引 0..4 对应 1..5 级），若按 maxLevel=5 钳位，满级时会去取
   *  discountByLevel[5] → undefined → 折扣变成 undefined（乘进售价得 NaN）。
   *  写成 Math.min(数组长度-1) 之后，"配置少写一项"也只会退到最后一档，不会炸。 */
  function levelOf(entry) {
    const maxIdx = REGULARS.loyalty.discountByLevel.length - 1;
    return Math.max(0, Math.min(maxIdx, entry?.loyalty ?? 0));
  }
  /** 该常客当前享有的折扣（只对他偏好的那个 SKU 生效，见 config 注释） */
  function loyaltyDiscount(entry) {
    return REGULARS.loyalty.discountByLevel[levelOf(entry)] ?? 1;
  }
  /** 该常客当前等级的标签 */
  function loyaltyLabel(level) {
    return REGULARS.loyalty.labelByLevel[level] ?? '新客';
  }

  /**
   * 复购结算：顾客买走了**他偏好的那个 SKU** 才算一次有效复购，忠诚度 +1。
   *
   * 为什么只在买中偏好时才加：需求是"常客有偏好商品、会复购"，
   * 如果到店就涨忠诚度，那忠诚度衡量的就是"来过几次"而不是"认不认这家店"，
   * 玩家只要把人流量做上去就能刷满 5 级拿 85 折 —— 奖励的是"人流量"而不是"经营"。
   * 买中偏好才涨，忠诚度才是真的"回头客指数"。
   *
   * @returns { leveled:boolean, level:number, label:string, discount:number }
   */
  function recordPurchase(faceId, skuId) {
    const faces = ensure();
    const entry = faces[faceId];
    if (!entry) return { leveled: false, level: 0, label: loyaltyLabel(0), discount: 1 };
    const bought = entry.prefer && skuId === entry.prefer;
    if (!bought) {
      return { leveled: false, level: levelOf(entry), label: loyaltyLabel(levelOf(entry)), discount: loyaltyDiscount(entry) };
    }
    const before = levelOf(entry);
    // 上钳同样按数组长度（见 levelOf 的注释），保证 after 一定是合法索引
    const after = Math.min(REGULARS.loyalty.discountByLevel.length - 1, before + REGULARS.loyalty.perVisit);
    entry.loyalty = after;
    const leveled = after > before;
    if (leveled) {
      onEvent('loyalty-up', { name: entry.name, emoji: entry.emoji, level: after, label: loyaltyLabel(after) });
    }
    return { leveled, level: after, label: loyaltyLabel(after), discount: loyaltyDiscount(entry) };
  }

  /** 某张脸的忠诚度视图（手机面板 / HUD 用） */
  function loyaltyOf(faceId) {
    const entry = ensure()[faceId];
    if (!entry) return null;
    const lv = levelOf(entry);
    const idxMax = REGULARS.loyalty.discountByLevel.length - 1;
    return {
      id: faceId,
      name: entry.name,
      emoji: entry.emoji,
      prefer: entry.prefer ?? null,
      /* @level 0 基索引（0 = 未培育，4 = 最高档）。用索引而非"级数"是因为
       *   discountByLevel / labelByLevel 都是按索引查的，直接给索引最不容易错。
       *   UI 要显示"几级"时用 level+1。 */
      level: lv,
      /** 最高档的索引（= 级数-1）。UI 画进度条时用 lv / maxIdx。 */
      maxIndex: idxMax,
      /** 最高档的**级数**（5）。仅用于文案"满级 5 级"这类展示。 */
      maxLevel: idxMax + 1,
      label: loyaltyLabel(lv),
      discount: loyaltyDiscount(entry),
      nights: (entry.nights ?? []).length,
    };
  }

  /** 已培养的熟客数量（nights >= 阈值；HUD / 测试用） */
  function regularCount() {
    const faces = ensure();
    return Object.values(faces).filter((e) => e.nights.length >= REGULARS.nightsToRegular).length;
  }

  /** 清场（读档/重置时不应清空跨夜脸谱；这里仅作占位，保持接口一致） */
  function reset() { /* 跨夜保留，无需清除 */ }

  function snapshot() {
    const faces = ensure();
    return {
      total: Object.keys(faces).length,
      regulars: regularCount(),
      /* 2026-10-06 块2：把忠诚度视图带进快照（手机面板直接渲染这份，不用二次遍历） */
      loyal: Object.entries(faces)
        .map(([id, e]) => loyaltyOf(id))
        .filter(Boolean)
        .sort((a, b) => b.level - a.level || b.nights - a.nights),
      faces: Object.entries(faces).map(([id, e]) => ({
        id, name: e.name, emoji: e.emoji, nights: e.nights.length,
        regular: e.nights.length >= REGULARS.nightsToRegular,
        prefer: e.prefer ?? null,
        loyalty: e.loyalty ?? 0,
      })),
    };
  }

  return {
    ensure, judge, regularCount, reset, snapshot,
    /* 2026-10-06 块2：忠诚度 */
    recordPurchase, loyaltyOf, loyaltyLabel,
    /** 口碑档位（读本实例的 state.reputation → 档位），供结算面板/HUD 展示 */
    wordOfMouthOf: () => wordOfMouth(state?.reputation),
  };
}

/**
 * 口碑档位（2026-10-06 块2）。
 *
 * ⚠ 刻意**复用 state.reputation**（见 config.WORD_OF_MOUTH 的注释）：
 * 项目里 reputation 已经影响客流（state.mjs 的 repMul）、星级与结账收益，
 * 再造一个并行的"口碑分"会变成双真源。这个函数只做"把连续值翻译成档位 + 系数"。
 *
 * 需求要的是 60/90 两档（<60 ×0.8、>90 ×1.3），而既有 repMul 是连续线性
 * （1 + (rep-50)/100 × 0.3，rep=0 → 0.85、rep=100 → 1.15）。
 * 两者不冲突：既有线性项继续生效（保证老平衡不漂），
 * 这里额外叠一个**档位乘数**，让玩家能明确感知"跌到 60 以下真的会掉客流"。
 *
 * @param rep 0..100 的口碑值（由调用方从 state.reputation 传入）
 */
export function wordOfMouth(rep) {
  const v = Number.isFinite(rep) ? rep : 50;   // 缺省取中间档，不猜
  for (const t of WORD_OF_MOUTH.tiers) {
    if (v >= t.min) return { ...t, value: v };
  }
  return { ...WORD_OF_MOUTH.tiers[WORD_OF_MOUTH.tiers.length - 1], value: v };
}
