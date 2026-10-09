/**
 * 代币出口：永久增益（boons）+ 限时券（buffCards）+ 代币扭蛋（gacha）
 *
 * 背景：代币此前只有"二手设备过夜产代币"一个来源，没有稳定出口，玩家攒了没处花。
 * 本模块给代币三个出口：兑换（确定性）、扭蛋（惊喜）、主题情报（在 themes.mjs）。
 *
 * ── 设计口径（为什么这么切） ─────────────────────────────────
 * · **永久增益与限时券必须分两个字段**：永久的写 `state.boons`（一次性、跨夜、读档保留），
 *   临时的写 `state.buffCards`（带 expireNight，打烊后按夜清理）。
 *   混在一起会导致"打烊清理"把永久增益也清了 —— 那是不可逆的翻车。
 * · **同夜同类不叠加、取最高**：限时券叠乘会让"全店售价 +10%" 买两张变成 +20%，
 *   玩家用一张券反复买反而是亏的，机制自己就崩了。所以按 kind 去重取极值。
 * · **纯逻辑、零 DOM、不碰现金规则**：代币扣减由本模块自己管（`state.tokens` 是纯数据），
 *   表现（toast / 面板重绘）由 main.mjs 的 onEvent 收口，和 ADR-002 一致。
 * · **rng 可注入**：扭蛋概率必须"公示 = 实际"，所以抽卡逻辑写成纯函数，
 *   测试里灌确定性 rng 就能断言分布，不需要真的抽一万次。
 */

/* ==================== 数值表（改这里就能调平衡） ==================== */

/** 永久增益兑换项。cost 单位 = 代币 */
export const BOON_SHOP = [
  {
    key: 'tipUp', name: '小费加成 +5%', emoji: '💰', cost: 50, once: true,
    desc: '常客 / 主题小费结算处叠乘（永久）',
  },
  {
    key: 'fatigueLess', name: '疲劳消耗 -10%', emoji: '😴', cost: 100, once: true,
    desc: '玩家疲劳增长速度 ×0.9（永久）',
  },
  {
    key: 'staffSlot', name: '员工位 +1', emoji: '👥', cost: 150, once: false,
    desc: '店员总上限 +1（与星级加成叠加，可重复购买）',
  },
  {
    key: 'startCash', name: '每夜启动资金 +¥100', emoji: '💵', cost: 80, once: true,
    desc: '每开新一夜，现金额外 +¥100（永久）',
  },
  {
    /* 任务3（长期线）：可重复购买、效果累计、有上限的永久售价升级。
     * once:false 复用 staffSlot 同款可重复路径（state.boons.priceUp 每买 +1，HUD 显示"已兑换 N 次"）。 */
    key: 'priceUp', name: '全店售价 +5%', emoji: '🏷️', cost: 100, once: false,
    desc: '结账计价永久 ×1.05/级（可重复购买，上限 +50% = 10 级）',
  },
];

/** 限时券种类 → 生效倍率字段。取最高不叠加。 */
export const BUFF_KINDS = {
  arrivals: { name: '一晚客流 +15%', emoji: '👥', mul: 0.15, field: 'arrivalMul' },
  price: { name: '一晚全店售价 +10%', emoji: '🏷️', mul: 0.10, field: 'priceMul' },
  tip: { name: '一晚小费 +10%', emoji: '🪙', mul: 0.10, field: 'tipMul' },
};

/** 扭蛋单价 */
export const GACHA_COST = 30;

/**
 * 扭蛋奖池。**weight 之和必须 = 100**，且与 UI 公示表同源（避免公示与实际不一致）。
 * kind:
 *   'cash'   立即入账现金
 *   'boon'   永久增益（写入 state.boons，可叠加数值）
 *   'card'   限时券（进 buffCards，下夜生效）
 */
export const GACHA_PRIZES = [
  // —— 60% 常见 ——
  { id: 'card-arrivals', kind: 'card', card: 'arrivals', weight: 36, label: '限时券「一晚客流 +15%」' },
  { id: 'cash20', kind: 'cash', amount: 20, weight: 24, label: '现金 ¥20' },
  // —— 30% 稀有 ——
  { id: 'card-price', kind: 'card', card: 'price', weight: 18, label: '限时券「一晚全店售价 +10%」' },
  { id: 'card-tip', kind: 'card', card: 'tip', weight: 12, label: '限时券「一晚小费 +10%」' },
  // —— 9% 传说（永久增益，二选一） ——
  { id: 'boon-tip', kind: 'boon', boon: 'tipUp', amount: 0.02, weight: 5, label: '永久增益「小费 +2%」' },
  { id: 'boon-fatigue', kind: 'boon', boon: 'fatigueLess', amount: 0.02, weight: 4, label: '永久增益「疲劳 -2%」' },
  // —— 1% 大奖 ——
  { id: 'boon-staff', kind: 'boon', boon: 'staffSlot', amount: 1, weight: 1, label: '大奖：员工位 +1' },
];

/** 稀有度分档（与指令里的 60/30/9/1 对应），UI 直接拿它渲染概率表 */
export const GACHA_TIERS = [
  { key: 'common', name: '常见', emoji: '⚪', pct: 60, ids: ['card-arrivals', 'cash20'] },
  { key: 'rare', name: '稀有', emoji: '🔵', pct: 30, ids: ['card-price', 'card-tip'] },
  { key: 'epic', name: '传说', emoji: '🟣', pct: 9, ids: ['boon-tip', 'boon-fatigue'] },
  { key: 'jackpot', name: '大奖', emoji: '🟡', pct: 1, ids: ['boon-staff'] },
];

/* ==================== 纯工具 ==================== */

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 惰性补齐 boons / buffCards / intel —— 老存档没有这些字段时要兜住（不能崩） */
export function ensureBoons(state) {
  if (!isObj(state.boons)) state.boons = { tipUp: 0, fatigueLess: 0, staffSlot: 0, startCash: 0, priceUp: 0 };
  for (const b of BOON_SHOP) {
    if (!Number.isFinite(state.boons[b.key])) state.boons[b.key] = 0;
  }
  if (!Array.isArray(state.buffCards)) state.buffCards = [];
  if (!isObj(state.intel)) state.intel = { next: 0, lockedId: null };
  if (!Number.isFinite(state.intel.next)) state.intel.next = 0;
  if (state.intel.lockedId === undefined) state.intel.lockedId = null;
  return state;
}

/* ==================== 永久增益 ==================== */

/**
 * 疲劳消耗倍率。
 *
 * ⚠ `boons.fatigueLess` 是**混合单位**的计数器，这点必须写清楚否则一定会算错：
 *   · 兑换「疲劳消耗 -10%」→ +1（整数 = 10%）
 *   · 扭蛋传说「疲劳 -2%」  → +0.02（小数 = 2%）
 * 所以不能简单 `1 - v*0.1`（那会把一次兑换算成 -100%），
 * 也不能简单 `1 - v*0.02`（那会把一次兑换只算成 -2%，兑换等于白给）。
 * 正确读法：**整数部分按 10%/级，小数部分按 2%/份**，封顶 -50%（疲劳永不上涨就没意思了）。
 */
export function fatigueRateMul(state) {
  const v = Math.max(0, ensureBoons(state).boons.fatigueLess ?? 0);
  const whole = Math.floor(v);        // 兑换次数
  const frac = v - whole;             // 扭蛋累计（0.02 份）
  const cut = whole * 0.10 + frac;     // 0.02 份 = 2%
  return Math.max(0.5, 1 - cut);
}

/** 小费倍率：兑换 +5%/级，扭蛋传说再 +2%/次 */
/**
 * 小费倍率 = 永久加成 × 限时券。
 * 与 fatigueLess 同为混合单位：**整数 = 兑换次数（+5%/级），小数 = 扭蛋累计（+2%/份）**。
 * tipMul 另在 main.mjs 的 checkoutHook 里与主题小费相乘（主题 × 永久 × 限时）。
 */
export function tipMul(state) {
  const v = Math.max(0, ensureBoons(state).boons.tipUp ?? 0);
  const whole = Math.floor(v);
  const frac = v - whole;
  const tipUp = 1 + whole * 0.05 + frac;
  return tipUp * buffMul(state, 'tip');
}

/** 员工位加成：兑换 +1/次（可重复买），与 stars.staffCapBonus() 相加 */
export function staffSlotBonus(state) {
  return Math.max(0, Math.floor(ensureBoons(state).boons.staffSlot ?? 0));
}

/** 每夜启动现金 */
export function startCashBonus(state) {
  return Math.max(0, Math.floor(ensureBoons(state).boons.startCash ?? 0)) * 100;
}

/**
 * 永久售价倍率（任务3，长期线）：每级 +5%，封顶 +50%（10 级）。
 *
 * ⚠ 与 tipMul / fatigueRateMul 不同，priceUp **不是混合单位** —— 只有兑换一条来源
 * （扭蛋不产出 priceUp），所以直接按整数级数算即可，无需拆整数/小数。
 * 该因子在 main.mjs 的 checkoutHook 里与 调价 × 主题 × 限时券 叠乘，
 * 各司其职（永久成长 × 当夜增益）。平衡：+50% 封顶 × 促销 9 折 = 1.35×，促销夜仍盈利。
 */
export function priceUpMul(state) {
  const v = Math.max(0, ensureBoons(state).boons.priceUp ?? 0);
  return 1 + Math.min(10, v) * 0.05; // 每级 +5%，封顶 +50%（10 级）
}

/* ==================== 限时券 ==================== */

/**
 * 某夜某类券的倍率（同类多张取最高，不叠乘）。
 *
 * ⚠ 必须自己判过期，不能只靠 pruneBuffCards 清场：打烊清理发生在开新一夜时，
 *   而结算页 / 面板在这之前还会读一次倍率。少了 expireNight 判断就会"券已到期但加成还在"。
 *
 * @returns {number} 1 = 无加成
 */
export function buffMul(state, kind) {
  for (const c of state.buffCards) {
    if (c.kind !== kind) continue;
    if ((c.expireNight ?? 0) <= state.night) continue;   // 已过期，跳过
    return 1 + (BUFF_KINDS[kind]?.mul ?? 0);
  }
  return 1;
}

/** 加一张券：同夜同类只保留最高（这里是同 kind 唯一，直接替换即可） */
export function addBuffCard(state, kind, night) {
  ensureBoons(state);
  if (!BUFF_KINDS[kind]) return { ok: false, reason: '未知券种' };
  const expireNight = (Number.isFinite(night) ? night : state.night) + 1; // 当晚买 → 下夜生效
  const existing = state.buffCards.find((c) => c.kind === kind && c.expireNight === expireNight);
  if (existing) {
    // 同夜同类不叠加 —— 已存在就原样保留（不去重复加）
    return { ok: true, expireNight, dup: true, card: BUFF_KINDS[kind] };
  }
  state.buffCards.push({ kind, expireNight });
  return { ok: true, expireNight, dup: false, card: BUFF_KINDS[kind] };
}

/** 打烊后清理过期券（expireNight <= 当前夜 = 已失效） */
export function pruneBuffCards(state) {
  ensureBoons(state);
  const before = state.buffCards.length;
  state.buffCards = state.buffCards.filter((c) => (c.expireNight ?? 0) > state.night);
  return before - state.buffCards.length;
}

/* ==================== 兑换区 ==================== */

/**
 * 购买一个永久增益。
 * @param {object} state
 * @param {string} key  BOON_SHOP 的 key
 * @returns {{ok:boolean, reason?:string, boon?:object, tokens?:number}}
 */
export function buyBoon(state, key) {
  ensureBoons(state);
  const def = BOON_SHOP.find((b) => b.key === key);
  if (!def) return { ok: false, reason: '没有这个兑换项' };
  if (def.once && (state.boons[key] ?? 0) > 0) {
    return { ok: false, reason: '已拥有', owned: true };
  }
  if (state.tokens < def.cost) return { ok: false, reason: '代币不足' };
  state.tokens -= def.cost;
  state.boons[key] = (state.boons[key] ?? 0) + 1;
  return { ok: true, boon: def, tokens: state.tokens, level: state.boons[key] };
}

/** 商店快照（UI 只读）：含已拥有 / 可买状态 */
export function shopSnapshot(state) {
  ensureBoons(state);
  return {
    tokens: state.tokens,
    rows: BOON_SHOP.map((b) => {
      const level = state.boons[b.key] ?? 0;
      const owned = b.once && level > 0;
      return {
        ...b, level, owned,
        affordable: !owned && state.tokens >= b.cost,
        // 可重复购买的显示"已买 N 次"
        repeatCount: b.once ? 0 : level,
      };
    }),
  };
}

/* ==================== 扭蛋 ==================== */

/** 按 weight 抽一个奖品（纯函数，rng 可注入 → 分布可断言） */
export function rollPrize(rng = Math.random) {
  const total = GACHA_PRIZES.reduce((a, p) => a + p.weight, 0);
  let x = rng() * total;
  for (const p of GACHA_PRIZES) {
    x -= p.weight;
    if (x <= 0) return p;
  }
  return GACHA_PRIZES[GACHA_PRIZES.length - 1];
}

/** 概率表快照（UI 公示用；与 rollPrize 同源，不会公示与实际不一致） */
export function gachaTable() {
  return {
    cost: GACHA_COST,
    tiers: GACHA_TIERS.map((t) => ({
      ...t,
      items: t.ids.map((id) => GACHA_PRIZES.find((p) => p.id === id)).filter(Boolean),
    })),
  };
}

/**
 * 抽一次扭蛋。
 * @returns {{ok:boolean, reason?:string, prize?:object, text?:string, tokens?:number}}
 */
export function pullGacha(state, rng = Math.random) {
  ensureBoons(state);
  if (state.tokens < GACHA_COST) return { ok: false, reason: '代币不足' };
  state.tokens -= GACHA_COST;
  const prize = rollPrize(rng);
  const out = { ok: true, prize, tokens: state.tokens, kind: prize.kind };

  if (prize.kind === 'cash') {
    state.cash = (state.cash ?? 0) + prize.amount;
    out.cash = prize.amount;
    out.text = `${prize.label}`;
  } else if (prize.kind === 'boon') {
    state.boons[prize.boon] = (state.boons[prize.boon] ?? 0) + (prize.amount ?? 1);
    out.boonKey = prize.boon;
    out.boonLevel = state.boons[prize.boon];
    out.text = `${prize.label}`;
  } else if (prize.kind === 'card') {
    const r = addBuffCard(state, prize.card, state.night);
    out.card = prize.card;
    out.expireNight = r.expireNight;
    out.text = `${prize.label}`;
  }
  return out;
}

/** 主题情报：查看明晚（当晚免费再看） */
export const INTEL_VIEW_COST = 10;
export const INTEL_LOCK_COST = 40;

/** 花代币查看看明晚主题；已看过当晚不再扣费 */
export function viewNextTheme(state) {
  ensureBoons(state);
  if (state.intel.next) return { ok: true, cached: true, free: true };
  if (state.tokens < INTEL_VIEW_COST) return { ok: false, reason: '代币不足' };
  state.tokens -= INTEL_VIEW_COST;
  state.intel.next = 1;
  return { ok: true, cached: false, free: false, tokens: state.tokens };
}

/** 花代币锁定明晚主题（可重复覆盖锁）；锁定与查看互不影响 */
export function lockNextTheme(state, themeId) {
  ensureBoons(state);
  if (!themeId) return { ok: false, reason: '请先选一个主题' };
  if (state.tokens < INTEL_LOCK_COST) return { ok: false, reason: '代币不足' };
  state.tokens -= INTEL_LOCK_COST;
  state.intel.lockedId = themeId;
  return { ok: true, lockedId: themeId, tokens: state.tokens };
}

/** 开新一夜时：主题生效后清空锁定（锁定只对"下一夜"有效） */
export function consumeLock(state) {
  ensureBoons(state);
  const id = state.intel.lockedId;
  state.intel.lockedId = null;
  state.intel.next = 0;      // 情报也只看当晚会"下一夜"，翻页即失效
  return id;
}

export default {
  BOON_SHOP, GACHA_PRIZES, GACHA_TIERS, GACHA_COST, BUFF_KINDS,
  INTEL_VIEW_COST, INTEL_LOCK_COST,
  ensureBoons, fatigueRateMul, tipMul, staffSlotBonus, startCashBonus, priceUpMul,
  buffMul, addBuffCard, pruneBuffCards,
  buyBoon, shopSnapshot, rollPrize, gachaTable, pullGacha,
  viewNextTheme, lockNextTheme, consumeLock,
};
