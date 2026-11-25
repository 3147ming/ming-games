/* =============================================================================
 * fishing/src/rules.mjs —— 小铺垂钓规则引擎（零依赖、纯逻辑、可单测）
 * -----------------------------------------------------------------------------
 * 规矩（湖边小铺的休闲垂钓）：
 *   · 玩家点「抛竿」→ 鱼钩落水 → 等待一段随机时间 → 有鱼咬钩（浮标下沉）
 *   · 咬钩瞬间出现一段「反应窗口」，玩家必须在这段窗口里点「收竿」
 *   · 收竿的时机决定结果：
 *       · 正好落在窗口正中的「完美区」→ 上钩大鱼（该鱼种价值 ×2）
 *       · 落在窗口里但不在完美区   → 上钩小鱼（该鱼种价值 ×0.5）
 *       · 超出窗口 / 根本没点       → 空钩（这条鱼跑了）
 *   · 鱼有稀有度：常见 / 稀有 / 传说。稀有度越高价值越高、反应窗口越窄。
 *   · 鱼竿可以升级：加宽反应窗口、提高稀有鱼出现概率、提高卖鱼单价。
 *   · 「每日一钓」：种子由日期派生，同一天所有人的鱼群与窗口分布完全一致。
 *
 * ---------------------------------------------------------------------------
 * 这个游戏接纯 P2P 的核心难点：**咬钩时刻和反应窗口都是随机数。**
 *
 * 纯 P2P 没有服务器，房主就是权威。如果随机数由房主掷、由房主报，
 * 房主完全可以把「传说鱼 + 宽窗口」都留给自己 —— 他是唯一能改的人。
 *
 * 解法跟飞行棋那边一模一样：**随机数不是掷出来的，是算出来的**。
 *   鱼种   = H(seed | "species" | 座位 | 第几次抛竿)   → 落在稀有度桶里的哪条鱼
 *   咬钩延迟 = H(seed | "bite"   | 座位 | 第几次抛竿)   → 等多久才咬钩
 *   完美区   = H(seed | "zone"   | 座位 | 第几次抛竿)   → 完美区在窗口里的位置
 *
 * seed 是公开的（写在开局状态里），座位与抛竿次序也是公开的（写在动作序列里），
 * 所以双方各自算，得到的鱼种、延迟、窗口**必然一致** —— 房主想改也改不了：
 * 他一改就跟加入方算出来的不一样，摘要当场就能比对出来。
 *
 * 为什么每个座位用「自己的抛竿次序」而不是共用一条鱼群：
 *   共用一条的话，公开的抛竿计数会让对手反推出来「你现在钓的是哪条鱼」——
 *   本作**没有**这种私密信息可言（鱼不互相争夺），但为了让「私密信息不泄漏」
 *   这条规矩站得住，取鱼位置里带上了座位号：湖里的鱼群分布两边一致，
 *   但谁正在钓哪条鱼互不可见。
 *
 * 代价（必须说清楚）：
 *   · 理论上，玩家可以自己算出这一竿的鱼种、延迟与完美区位置 —— 这是
 *     「随机可推导」的固有代价。本作是单机/休闲向，联机时双方各自计分、
 *     互不影响，房主能改的只有「公开的种子与动作序列」，改了对不上就暴露。
 *   · 收竿时刻（dt）由玩家上报，房主会拿本机观测到的时间做一次自洽性核对，
 *     离谱的整手丢弃；但玩家报小了 dt（假装自己手快）没法 100% 识别，
 *     那只会影响他自己那一份分数。
 *
 * 纪律：
 *   · 顶层不碰 DOM、不碰 localStorage。
 *   · 所有纯函数，方便单测与「房主权威重放」。
 *   · 不用 crypto.subtle（file:// 不是安全上下文），哈希一律用 FNV-1a。
 * ========================================================================== */

/* ---------------------------------------------------------------------------
 * 伪随机：FNV-1a + mulberry32（纯 JS，跨端一致）
 * ------------------------------------------------------------------------- */

/** FNV-1a 32 位哈希。 */
export function fnv1a(str) {
  const s = String(str);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32：小而稳的 32 位伪随机数发生器。 */
export function mulberry32(a) {
  let t = a >>> 0;
  return function () {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), 1 | x);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** 由 (seed, 标签, 座位, 抛竿序号) 派生一个随机数发生器。 */
function rngOf(seed, tag, seat, castIndex) {
  return mulberry32(fnv1a([seed, tag, seat, castIndex].join('|')));
}

/* ---------------------------------------------------------------------------
 * 鱼种表（湖里的鱼群）
 * ------------------------------------------------------------------------- */

/** 稀有度。 */
export const RARITIES = ['common', 'rare', 'legendary'];
export const RARITY_LABEL = { common: '常见', rare: '稀有', legendary: '传说' };
export const RARITY_COLOR = { common: '#3f8f5f', rare: '#2f6fd0', legendary: '#c8912f' };

/**
 * 鱼种。
 *   value  = 基础价值（完美命中 ×2，小鱼 ×0.5）
 *   w      = 同一稀有度内部的权重
 *   window = 该鱼的反应窗口（毫秒，越稀有越窄）
 */
export const SPECIES = [
  { id: 'ji', name: '鲫鱼', rarity: 'common', value: 12, w: 34, window: 2200 },
  { id: 'bai', name: '白条', rarity: 'common', value: 16, w: 26, window: 2050 },
  { id: 'li', name: '鲤鱼', rarity: 'common', value: 24, w: 22, window: 1850 },
  { id: 'lu', name: '鲈鱼', rarity: 'common', value: 32, w: 18, window: 1650 },
  { id: 'gui', name: '鳜鱼', rarity: 'rare', value: 90, w: 62, window: 1250 },
  { id: 'jin', name: '金枪鱼', rarity: 'rare', value: 140, w: 38, window: 1000 },
  { id: 'long', name: '龙鳞锦鲤', rarity: 'legendary', value: 420, w: 100, window: 780 },
];

export const SPECIES_BY_ID = Object.fromEntries(SPECIES.map((s) => [s.id, s]));

/** 按稀有度分桶（顺序固定，抽样才可复现）。 */
export const SPECIES_BY_RARITY = {
  common: SPECIES.filter((s) => s.rarity === 'common'),
  rare: SPECIES.filter((s) => s.rarity === 'rare'),
  legendary: SPECIES.filter((s) => s.rarity === 'legendary'),
};

/* ---------------------------------------------------------------------------
 * 鱼竿
 * ------------------------------------------------------------------------- */

/**
 * 鱼竿等级。
 *   windowMul = 反应窗口倍率
 *   rareMul   = 稀有 / 传说 出现概率倍率
 *   valueMul  = 卖鱼单价倍率（这条只影响本地金币，不影响共享局面）
 */
export const RODS = [
  { level: 0, name: '竹竿', windowMul: 1.00, rareMul: 1.00, valueMul: 1.00, price: 0 },
  { level: 1, name: '麻绳竿', windowMul: 1.16, rareMul: 1.70, valueMul: 1.15, price: 150 },
  { level: 2, name: '碳素竿', windowMul: 1.34, rareMul: 2.50, valueMul: 1.35, price: 500 },
  { level: 3, name: '月华竿', windowMul: 1.56, rareMul: 3.40, valueMul: 1.60, price: 1400 },
];

export const MAX_ROD = RODS.length - 1;

/** 每日一钓的抛竿次数。 */
export const DAILY_CASTS = 5;

/** 反应窗口的上限（毫秒），免得太好按。 */
export const MAX_WINDOW_MS = 4000;

/** 抛竿后最长等多久才咬钩（毫秒上限）。 */
export const MAX_DELAY_MS = 3700;

/** 鱼竿等级取合法值。 */
export function rodOf(level) {
  const n = Math.max(0, Math.min(MAX_ROD, Math.floor(Number(level) || 0)));
  return RODS[n];
}

/* ---------------------------------------------------------------------------
 * 派生：鱼种 / 咬钩延迟 / 完美区
 * ------------------------------------------------------------------------- */

/**
 * 抛竿次序 → 抽到哪条鱼。
 *
 * 稀有度桶的权重（基础）：常见 88 / 稀有 10 / 传说 2，
 * 鱼竿的 rareMul 同时放大稀有与传说两桶，常见桶吃掉剩下的。
 */
export function rollSpecies(seed, seat, castIndex, rodLevel) {
  const rod = rodOf(rodLevel);
  const r = rngOf(seed, 'species', seat, castIndex);
  const legendW = 2 * rod.rareMul;
  const rareW = 10 * rod.rareMul;
  const commonW = Math.max(1, 100 - legendW - rareW);
  const total = commonW + rareW + legendW;
  const x = r() * total;
  let pool;
  if (x < commonW) pool = SPECIES_BY_RARITY.common;
  else if (x < commonW + rareW) pool = SPECIES_BY_RARITY.rare;
  else pool = SPECIES_BY_RARITY.legendary;
  const wsum = pool.reduce((a, s) => a + s.w, 0);
  let y = r() * wsum;
  for (const s of pool) {
    y -= s.w;
    if (y <= 0) return s;
  }
  return pool[pool.length - 1];
}

/** 抛竿后等多久咬钩（毫秒）。 */
export function biteDelay(seed, seat, castIndex) {
  const r = rngOf(seed, 'bite', seat, castIndex);
  return 900 + Math.floor(r() * (MAX_DELAY_MS - 900 + 1));
}

/** 反应窗口长度（毫秒）：鱼种窗口 × 鱼竿倍率。 */
export function windowMs(species, rodLevel) {
  const rod = rodOf(rodLevel);
  return Math.min(MAX_WINDOW_MS, Math.round(species.window * rod.windowMul));
}

/**
 * 完美区：窗口正中一小段。
 *   宽度占比 = 0.24 + 0.03 × 鱼竿等级（鱼竿越好越宽容）
 *   中心位置 = 0.5 ± 0.14（由种子派生，不是永远在正中间）
 */
export function perfectZone(seed, seat, castIndex, win, rodLevel) {
  const rod = rodOf(rodLevel);
  const r = rngOf(seed, 'zone', seat, castIndex);
  const ratio = 0.24 + 0.03 * rod.level;
  const half = win * ratio / 2;
  const center = win * 0.5 + (r() - 0.5) * win * 0.28;
  return { center: center, half: half, ratio: ratio };
}

/**
 * 某一竿的完整计划（鱼种、延迟、窗口、完美区）。
 * 这份东西**完全由种子推导**，双方各自算出来必然一致。
 */
export function castPlan(seed, seat, castIndex, rodLevel) {
  const species = rollSpecies(seed, seat, castIndex, rodLevel);
  const win = windowMs(species, rodLevel);
  const zone = perfectZone(seed, seat, castIndex, win, rodLevel);
  return {
    seat: seat,
    index: castIndex,
    species: species,
    delay: biteDelay(seed, seat, castIndex),
    window: win,
    center: zone.center,
    half: zone.half,
  };
}

/**
 * 某个座位的前 n 竿会钓到什么鱼（湖的鱼群预览，双方应完全一致）。
 */
export function lakeSpecies(seed, rodLevel, n, seat) {
  const out = [];
  const s = seat || 0;
  for (let i = 0; i < Math.max(0, n | 0); i++) {
    out.push(rollSpecies(seed, s, i, rodLevel).id);
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * 判定
 * ------------------------------------------------------------------------- */

/** 收竿结果的等级。 */
export const GRADES = ['perfect', 'good', 'miss'];
export const GRADE_LABEL = { perfect: '完美', good: '小鱼', miss: '空钩' };

/**
 * 收竿时机判定。
 * @param {number} dt   咬钩后到收竿的毫秒数
 * @param {object} plan castPlan 的结果
 * @returns {'perfect'|'good'|'miss'}
 */
export function gradeOf(dt, plan) {
  if (!plan) return 'miss';
  const t = Number(dt);
  if (!Number.isFinite(t)) return 'miss';
  if (t < 0) return 'miss';                 /* 还没咬钩就收竿 */
  if (t > plan.window) return 'miss';        /* 错过窗口，鱼跑了 */
  if (Math.abs(t - plan.center) <= plan.half) return 'perfect';
  return 'good';
}

/** 等级 → 收益（完美＝大鱼，小鱼＝半价，空钩＝0）。 */
export function valueOf(grade, species) {
  const v = species ? species.value : 0;
  if (grade === 'perfect') return v * 2;
  if (grade === 'good') return Math.max(1, Math.round(v * 0.5));
  return 0;
}

/* ---------------------------------------------------------------------------
 * 种子
 * ------------------------------------------------------------------------- */

/** 开局用的随机种子（单机局用；Math.random 只用来生成这一次性的初始种子）。 */
export function randomSeed() {
  return (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0;
}

/** 联机局的种子：从房间号派生，双方算出同一个。 */
export function seedFromRoom(roomId, gameId) {
  return fnv1a((gameId || 'fishing') + '|room|' + (roomId || '0'));
}

/** 每日一钓的种子：从日期派生，同一天所有人一致。 */
export function dailySeed(dateKey, gameId) {
  return fnv1a((gameId || 'fishing') + '|daily|' + (dateKey || '0'));
}

/** 本地日期键（YYYY-MM-DD）。 */
export function dateKeyOf(d) {
  const dt = d instanceof Date ? d : new Date();
  const m = dt.getMonth() + 1;
  const day = dt.getDate();
  return dt.getFullYear() + '-' + String(m).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}

/* ---------------------------------------------------------------------------
 * 局面
 * ------------------------------------------------------------------------- */

/**
 * 开局局面。
 * @param {number} seed  公开种子
 * @param {object} opts  { rod, seats, daily, maxCasts }
 */
export function initState(seed, opts) {
  const o = opts || {};
  const seats = Math.max(1, Math.min(2, o.seats || 1));
  const rod = Math.max(0, Math.min(MAX_ROD, Math.floor(Number(o.rod) || 0)));
  const daily = !!o.daily;
  const maxCasts = Math.max(0, Math.floor(Number(o.maxCasts) || (daily ? DAILY_CASTS : 0)));
  return {
    seed: seed >>> 0,
    rod: rod,
    seats: seats,
    daily: daily,
    maxCasts: maxCasts,
    casts: new Array(seats).fill(0),            /* 每个座位抛了多少竿 */
    pending: new Array(seats).fill(false),      /* 是否在等收竿 */
    done: new Array(seats).fill(false),         /* 每日一钓是否已用完次数 */
    catches: Array.from({ length: seats }, () => []),   /* 每个座位钓到的鱼 */
    totals: new Array(seats).fill(0),           /* 每个座位的总收益 */
  };
}

/** 深拷贝局面（动作不修改原对象）。 */
function cloneState(state) {
  return {
    seed: state.seed,
    rod: state.rod,
    seats: state.seats,
    daily: state.daily,
    maxCasts: state.maxCasts,
    casts: state.casts.slice(),
    pending: state.pending.slice(),
    done: state.done.slice(),
    catches: state.catches.map((a) => a.map((c) => Object.assign({}, c))),
    totals: state.totals.slice(),
  };
}

/**
 * 某个座位「当前这一竿」的计划（还没抛竿时返回 null）。
 */
export function pendingPlan(state, seat) {
  if (!state || !state.pending || !state.pending[seat]) return null;
  const idx = state.casts[seat] - 1;
  if (idx < 0) return null;
  return castPlan(state.seed, seat, idx, state.rod);
}

/** 某个座位这一竿已经抛出去了但还没收竿。 */
export function isPending(state, seat) {
  return !!(state && state.pending && state.pending[seat]);
}

/** 某个座位还能不能抛竿（每日一钓有次数上限）。 */
export function canCast(state, seat) {
  if (!state) return false;
  if (state.pending[seat]) return false;
  if (state.done[seat]) return false;
  if (state.daily && state.casts[seat] >= state.maxCasts) return false;
  return true;
}

/* ---------------------------------------------------------------------------
 * 动作
 * ------------------------------------------------------------------------- */

/**
 * 动作格式：
 *   { act:'cast', seat }        抛竿
 *   { act:'reel', seat, dt }    收竿，dt = 咬钩后经过的毫秒数
 *   { act:'miss', seat }        窗口过期（等价于 dt = 窗口 + 1）
 *
 * 非法动作**整手丢弃**（返回原局面）。
 */
export function applyAction(state, act) {
  if (!state || !act || typeof act !== 'object') return state;
  const seat = act.seat;
  if (!Number.isInteger(seat) || seat < 0 || seat >= state.seats) return state;

  if (act.act === 'cast') {
    if (!canCast(state, seat)) return state;
    const next = cloneState(state);
    next.casts[seat] += 1;
    next.pending[seat] = true;
    return next;
  }

  if (act.act !== 'reel' && act.act !== 'miss') return state;
  if (!state.pending[seat]) return state;

  const plan = pendingPlan(state, seat);
  if (!plan) return state;

  let dt = act.act === 'miss' ? plan.window + 1 : Number(act.dt);
  if (!Number.isFinite(dt)) return state;
  if (dt < -200) return state;                    /* 太离谱 */
  if (dt > plan.window + 3000) return state;      /* 太离谱 */

  const grade = gradeOf(dt, plan);
  const value = valueOf(grade, plan.species);
  const next = cloneState(state);
  next.pending[seat] = false;
  next.catches[seat].push({
    id: plan.species.id,
    grade: grade,
    value: value,
    dt: Math.round(dt),
  });
  next.totals[seat] += value;
  if (next.daily && next.casts[seat] >= next.maxCasts) next.done[seat] = true;
  return next;
}

/**
 * 把动作序列折叠成局面。
 * @param {object} base  { seed, rod, seats, daily, maxCasts }
 * @param {object[]} actions
 */
export function fold(base, actions) {
  const b = base || {};
  let st = initState(b.seed || 0, b);
  const list = actions || [];
  for (const a of list) st = applyAction(st, a);
  return st;
}

/**
 * 从种子重放（房主权威模型用）。
 * @param {object|number} seed  可以直接给 {base} 结构（房主把 base 塞进 seed 里传），
 *                              也可以给纯种子 + 第三个参数 opts
 * @param {object[]} actions
 * @param {object} [opts]  { rod, seats, daily, maxCasts }
 */
export function replay(seed, actions, opts) {
  let b;
  if (seed && typeof seed === 'object' && seed.base) b = seed.base;
  else b = Object.assign({ seed: Number(seed) || 0 }, opts || {});
  return fold(b, actions || []);
}

/**
 * 局面摘要 —— 双方比对用。
 * 必须包含 **种子** 与 **随机数序号**（每个座位抛了多少竿），
 * 否则房主能偷偷换鱼群或者换顺序。
 */
export function hashState(state) {
  if (!state) return '';
  const cs = (state.catches || [])
    .map((arr) => (arr || []).map((c) => [c.id, c.grade, c.value, c.dt].join(':')).join(','))
    .join('|');
  return [
    state.seed,
    state.rod,
    state.seats,
    state.daily ? 1 : 0,
    state.maxCasts,
    (state.casts || []).join(','),
    (state.pending || []).map((b) => (b ? 1 : 0)).join(','),
    (state.done || []).map((b) => (b ? 1 : 0)).join(','),
    (state.totals || []).join(','),
    cs,
  ].join('|');
}

/**
 * 广播前的视图裁剪。
 *
 * 这个游戏**没有私密信息**：鱼种、延迟、窗口全部由公开种子推导，
 * 收竿时刻（dt）是玩家自己上报的、只影响自己那份分数。
 * 所以视图就是原样（深拷贝一份，防止外部改到内部数组）。
 */
export function publicView(state) {
  if (!state) return state;
  return cloneState(state);
}

/* ---------------------------------------------------------------------------
 * 辅助：统计
 * ------------------------------------------------------------------------- */

/** 某个座位的总收益。 */
export function scoreOf(state, seat) {
  if (!state || !state.totals) return 0;
  return state.totals[seat] || 0;
}

/** 某个座位的最高单笔收益。 */
export function bestCatchOf(state, seat) {
  const arr = (state && state.catches && state.catches[seat]) || [];
  let m = 0;
  for (const c of arr) if (c.value > m) m = c.value;
  return m;
}

/** 某个座位钓到的鱼种集合（去重）。 */
export function speciesOf(state, seat) {
  const arr = (state && state.catches && state.catches[seat]) || [];
  const out = [];
  for (const c of arr) if (out.indexOf(c.id) < 0) out.push(c.id);
  return out;
}

/** 某个座位钓到的鱼条数。 */
export function catchCount(state, seat) {
  const arr = (state && state.catches && state.catches[seat]) || [];
  return arr.length;
}
