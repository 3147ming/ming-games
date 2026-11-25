/* =============================================================================
 * quiz-party/src/rules.mjs —— 快问快答派对规则引擎（零依赖、纯逻辑、可单测）
 * -----------------------------------------------------------------------------
 * 规矩（限时抢答的答题派对）
 *   · 一局 N 题（默认 10 题）。题目与选项顺序都由「公开种子」推导。
 *   · 流程：出题 → 限时 15 秒 → 玩家点选项 → 判对错并显示正确答案与解释 → 下一题。
 *   · 计分（答对）：
 *       基础分 100
 *     + 速度分 0~60（按剩余时间比例，答得越快越高）
 *     + 连对加成 每次连对 +10，最多 +50
 *     + 抢先分 30（仅双人 P2P：本轮**先答对**的那位拿；用剩余时间判定谁先）
 *     答错 / 超时 = 0 分，且连对中断。
 *   · 局末给出：总分、正确率、最长连对、评价。
 *   · 每日一局：日期派生种子决定当天的题目顺序与选项顺序 —— 同一天所有人同一套题。
 *   · 分类筛选：开局前可选题库分类（常识 / 科学与自然 / 历史地理 / 生活常识）。
 *
 * ---------------------------------------------------------------------------
 * 这个游戏接纯 P2P 的核心难点：**正确答案属于私密信息**
 * -----------------------------------------------------------------------------
 * 飞行棋那边难点是「骰子点数」，靠「点数算出来而不是掷出来」解决；
 * 这边难点是「哪一项是正确答案」——
 *   如果正确性由房主说了算，房主可以偷偷把自己选的那项说成对的，凭空多拿分。
 *
 * 本作的做法（照抄吹牛骰子的 commit-reveal 思路，但落在「不上线」这件事上）：
 *
 *   1) **正确答案根本不进网络。**
 *      动作只有四种：pick / timeout / close / next。
 *      pick 里只有「谁（第 r 题、第 p 人）按了第几个按钮、当时剩多少毫秒」。
 *      没有任何一条消息携带「哪一项是对的」。
 *
 *   2) **正确性是纯函数推导出来的，不是房主说了算。**
 *      正确项 = 题库里的原始答案下标 → 经本局的选项置换表 → 落在第几个按钮上。
 *      置换表 opts 由公开种子推导（双方各算各的，必然一致），
 *      所以**双方各自算出的对错必然相同**：
 *      房主改不动 —— 他改了就跟加入方对不上，当场被抓住。
 *
 *   3) **得分也是纯函数推导。**
 *      gradeAll(state) 只吃「动作序列」，不吃任何房主下发的分数。
 *      房主广播的公开状态里甚至没有分数字段 ——
 *      因为「某人这轮得了几分」本身就等于告诉对手他答对了。
 *
 *   4) **publicView 裁掉一切能反推答案的东西。**
 *      广播出去的只有：种子、题目顺序、选项置换、谁按了第几号。
 *      分数、正确项、解释全部不出现在广播视图里。
 *
 *   5) **结算环节揭示 + commit-reveal 校验。**
 *      开局时房主提交一份「答案承诺」：
 *          commit[r] = H(种子 | 分类 | 题号 | 正确项下标)
 *      每题 close（结算）时房主揭示正确项；加入方拿自己算出的正确项核对，
 *      同时核对承诺哈希。对不上 = 房主在撒谎（串题或赖账），页面直接报警。
 *
 *   6) **时间也不能乱填。**
 *      速度分来自动作里的 ms（答题时剩余毫秒）。房主不能给对手乱填 ms：
 *      房主那边有自己测到的「本题已过时间」，与对方自报的 ms 对不上就报警。
 *      房主自己的那份由房主自己填，加入方会用本地计时交叉核对。
 *
 * 代价（必须说清楚，别粉饰）：
 *   题库是内置的（file:// 要能开、两边题库必须一致），所以**加入方理论上能自己
 *   算出正确答案**——这是「题库内置」这条硬约束的必然结果。
 *   本作能保证、并且实际做到的：
 *     · 协议层永不传输答案；
 *     · 房主无法单方面改判对错、无法伪造分数（得分是共享动作序列的纯函数）；
 *     · 房主无法篡改已记录的作答（摘要比对 + 我提交过什么我记得）；
 *     · 房主无法在结算时撒谎（commit-reveal 校验）。
 *
 * ---------------------------------------------------------------------------
 * 为什么要用「种子 + 计数器」的伪随机
 * -----------------------------------------------------------------------------
 *   题目顺序、选项顺序都由 mulberry32(seed) 顺序抽出来，抽了多少个数记在
 *   状态的 rngCounter 里。hashState 把 seed 与 rngCounter 一起算进摘要 ——
 *   房主偷偷换种子或换题序会被发现。
 *   绝不用 Math.random() 生成跟状态相关的随机（Math.random 只用来生成一次初始种子）。
 *
 * 纪律：
 *   · 顶层不碰 DOM、不碰 localStorage。
 *   · 所有纯函数，方便单测与「房主权威重放」。
 * ========================================================================== */

import {
  QUESTIONS, CATEGORY_LIST, CATEGORY_LABEL,
  questionById, questionsOf, questionCounts,
} from './questions.mjs';

/* ---------------------------------------------------------------------------
 * 常量
 * ------------------------------------------------------------------------- */

export const GAME_ID = 'quiz-party';

/** 每题限时（毫秒）。 */
export const LIMIT_MS = 15000;

/** 答对的基础分。 */
export const BASE_POINTS = 100;

/** 速度分上限（剩余时间越满给越多）。 */
export const SPEED_MAX = 60;

/** 连对加成：每连对一次 +10，连对 5 次封顶（+50）。 */
export const STREAK_STEP = 10;
export const STREAK_CAP = 5;

/** 双人 P2P 局的「抢先答对」额外加分。 */
export const FIRST_BONUS = 30;

/** 每题的选项个数。 */
export const OPTION_COUNT = 4;

/** 一局默认题数。 */
export const DEFAULT_TOTAL = 10;

/* ---------------------------------------------------------------------------
 * 哈希与伪随机
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

/**
 * mulberry32 —— 纯 JS 伪随机。
 * 返回一个带计数的取数器：count 就是「随机数序号」，
 * 必须进 hashState，否则房主能偷偷换题序。
 */
export function makeRng(seedInt) {
  let a = seedInt >>> 0;
  let count = 0;
  function next() {
    count += 1;
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return {
    next,
    get count() { return count; },
  };
}

/** 开局用的随机种子（一次性；不参与任何跟状态相关的随机）。 */
export function randomSeed() {
  return (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0;
}

/**
 * 每日一局的种子：同一天、同一个分类 → 全网同一套题。
 * @param {string} dateKey 'YYYY-MM-DD'
 * @param {string} cat 分类
 */
export function dailySeed(dateKey, cat) {
  return fnv1a('quizparty|daily|' + (dateKey || '') + '|' + (cat || 'all'));
}

/**
 * 从房间号派生种子（纯 P2P 局用）—— 双方必然算出同一个值。
 * 房间号在交换连接码时双方都拿到了。
 */
export function seedFromRoom(roomId) {
  return fnv1a('quizparty|room|' + (roomId || '0'));
}

/** 本地日期键（YYYY-MM-DD，本地时区）。 */
export function dateKeyOf(d) {
  const t = d || new Date();
  const y = t.getFullYear();
  const m = String(t.getMonth() + 1).padStart(2, '0');
  const day = String(t.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

/* ---------------------------------------------------------------------------
 * 题库派生：题目顺序 + 选项置换
 * ------------------------------------------------------------------------- */

/**
 * Fisher-Yates 洗牌（用传入的 rng，顺序取数）。
 * @param {any[]} arr
 * @param {{next:()=>number}} rng
 */
export function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

/**
 * 由种子派生出「本局题目顺序」与「每题的选项置换表」。
 *
 * opts[r][j] = 显示在第 j 个按钮上的，是题库里的第几个选项。
 * 置换表是公开的（双方各自算，必然一致），所以「正确答案在第几个按钮上」
 * 双方也算得一致 —— 房主改不了。
 *
 * @returns {{order:string[], opts:number[][], rngCounter:number}}
 */
export function buildLayout(seed, cat, total) {
  const rng = makeRng(fnv1a('quizparty|layout|' + (seed >>> 0) + '|' + (cat || 'all')));
  const pool = questionsOf(cat || 'all');
  const need = Math.max(1, Math.min(total | 0 || DEFAULT_TOTAL, pool.length));
  const order = shuffle(pool.map((q) => q.id), rng).slice(0, need);
  const opts = [];
  for (let r = 0; r < order.length; r++) {
    opts.push(shuffle([0, 1, 2, 3], rng));
  }
  return { order, opts, rngCounter: rng.count };
}

/* ---------------------------------------------------------------------------
 * 局面
 * ------------------------------------------------------------------------- */

/**
 * 开局局面。
 * @param {number} seed  公开种子
 * @param {object} [opts]
 * @param {string} [opts.cat='all']   分类（'all' 或四个分类之一）
 * @param {number} [opts.total=10]    一局题数
 * @param {number} [opts.players=1]   玩家数（1 = 单人，2 = 纯 P2P）
 * @param {string} [opts.mode='solo'] 'solo' | 'p2p'
 * @param {number} [opts.limitMs=15000]
 * @param {boolean} [opts.daily=false]
 */
export function initState(seed, opts) {
  const o = opts || {};
  const cat = o.cat && o.cat !== 'all' && CATEGORY_LIST.indexOf(o.cat) >= 0 ? o.cat : 'all';
  const total = Math.max(1, o.total || DEFAULT_TOTAL);
  const players = o.players === 2 ? 2 : 1;
  const mode = o.mode === 'p2p' ? 'p2p' : 'solo';
  const layout = buildLayout(seed >>> 0, cat, total);
  return {
    seed: seed >>> 0,
    cat,
    catLabel: CATEGORY_LABEL[cat] || '全部分类',
    daily: !!o.daily,
    mode,
    players,
    limitMs: o.limitMs || LIMIT_MS,
    total: layout.order.length,
    order: layout.order,
    opts: layout.opts,
    rngCounter: layout.rngCounter,
    round: 0,
    phase: 'question',        /* question → review → question … → done */
    picks: [],                /* [{r, p, c, ms}]，按提交先后排列 */
    timeouts: [],             /* [{r, p}] 超时没答的人 */
    closed: [],               /* [r] 已结算（close）的题 */
  };
}

/* ---------------------------------------------------------------------------
 * 动作
 * ------------------------------------------------------------------------- */

/** 合法选项下标？ */
function validOption(c) {
  return Number.isInteger(c) && c >= 0 && c < OPTION_COUNT;
}

/** 合法剩余毫秒？ */
function validMs(ms, limitMs) {
  return Number.isFinite(ms) && ms >= 0 && ms <= limitMs;
}

/** 某玩家这一轮是否已经作答。 */
export function hasPicked(state, r, p) {
  return state.picks.some((x) => x.r === r && x.p === p);
}

/** 某玩家这一轮是否已经超时。 */
export function hasTimedOut(state, r, p) {
  return state.timeouts.some((x) => x.r === r && x.p === p);
}

/** 某轮的所有作答（按提交先后）。 */
export function picksOfRound(state, r) {
  return state.picks.filter((x) => x.r === r);
}

/** 某轮是否已经「全员有交代」（都答了或都超时了）。 */
export function roundComplete(state, r) {
  const r0 = (r == null) ? state.round : r;
  const done = new Set();
  for (const x of state.picks) if (x.r === r0) done.add(x.p);
  for (const x of state.timeouts) if (x.r === r0) done.add(x.p);
  return done.size >= state.players;
}

/**
 * 应用一个动作。非法动作**整手丢弃**（返回原状态对象）。
 *
 * 动作格式：
 *   { act:'pick',    r, p, c, ms }  玩家 p 在第 r 题选了第 c 项，剩余 ms 毫秒
 *   { act:'timeout', r, p }         玩家 p 在第 r 题超时没答
 *   { act:'close',   r }            第 r 题结算（揭示答案）
 *   { act:'next',    r }            进入下一题
 */
export function applyAction(state, act) {
  if (!state || !act || typeof act.act !== 'string') return state;

  if (act.act === 'pick') {
    if (state.phase !== 'question') return state;
    if (act.r !== state.round) return state;
    if (!Number.isInteger(act.p) || act.p < 0 || act.p >= state.players) return state;
    if (!validOption(act.c)) return state;
    if (!validMs(act.ms, state.limitMs)) return state;
    if (hasPicked(state, state.round, act.p)) return state;   /* 一轮只能答一次 */
    if (hasTimedOut(state, state.round, act.p)) return state; /* 已判超时，不能再答 */
    return Object.assign({}, state, {
      picks: state.picks.concat([{ r: act.r, p: act.p, c: act.c, ms: Math.round(act.ms) }]),
    });
  }

  if (act.act === 'timeout') {
    if (state.phase !== 'question') return state;
    if (act.r !== state.round) return state;
    if (!Number.isInteger(act.p) || act.p < 0 || act.p >= state.players) return state;
    if (hasPicked(state, state.round, act.p)) return state;   /* 已答过就不算超时 */
    if (hasTimedOut(state, state.round, act.p)) return state;
    return Object.assign({}, state, {
      timeouts: state.timeouts.concat([{ r: act.r, p: act.p }]),
    });
  }

  if (act.act === 'close') {
    if (state.phase !== 'question') return state;
    if (act.r !== state.round) return state;
    if (state.closed.indexOf(state.round) >= 0) return state;  /* 同一轮只能结算一次 */
    /* 全员有交代才能结算 —— 房主不能提前结算刷答案 */
    if (!roundComplete(state, state.round)) return state;
    return Object.assign({}, state, {
      phase: 'review',
      closed: state.closed.concat([state.round]),
    });
  }

  if (act.act === 'next') {
    if (state.phase !== 'review') return state;
    if (act.r !== state.round) return state;
    if (state.round + 1 >= state.total) {
      return Object.assign({}, state, { phase: 'done' });
    }
    return Object.assign({}, state, { phase: 'question', round: state.round + 1 });
  }

  return state;
}

/**
 * 把动作序列折叠成局面。
 * @param {object} base {seed, cat, total, players, mode, limitMs, daily}
 * @param {object[]} actions
 */
export function fold(base, actions) {
  const b = base || {};
  let st = initState((b.seed || 0) >>> 0, b);
  const list = actions || [];
  for (const a of list) st = applyAction(st, a);
  return st;
}

/** 从种子重放（房主权威模型用）。 */
export function replay(seed, actions, opts) {
  const b = Object.assign({}, opts || {}, { seed: (seed || 0) >>> 0 });
  return fold(b, actions);
}

/* ---------------------------------------------------------------------------
 * 判定与计分（**全部是纯函数推导 —— 状态里不存答案，也不存分数**）
 * ------------------------------------------------------------------------- */

/**
 * 第 r 题的「正确答案在第几个按钮上」。
 *
 * 推导链：题库原始答案下标 → 本局选项置换表 → 按钮下标。
 * 双方各自算，必然一致；房主改不了。
 */
export function correctIndex(state, r) {
  const qid = state.order[r];
  if (!qid) return -1;
  const q = questionById(qid);
  if (!q) return -1;
  const perm = state.opts[r] || [];
  return perm.indexOf(q.a);
}

/** 第 r 题的题目对象（含正确答案与解释 —— 只在本地推导，不进广播）。 */
export function questionAt(state, r) {
  const qid = state.order[r];
  return qid ? questionById(qid) : null;
}

/** 第 r 题给玩家看的题目视图（题干 + 四个按钮的文字）。 */
export function questionView(state, r) {
  const q = questionAt(state, r);
  if (!q) return null;
  const perm = state.opts[r] || [];
  return {
    r,
    qid: q.id,
    cat: q.cat,
    catLabel: CATEGORY_LABEL[q.cat] || '',
    text: q.q,
    options: perm.map((orig) => ({ i: orig, text: q.o[orig] })),
    count: state.total,
  };
}

/**
 * 一整局的判定结果（纯推导，不进状态）。
 *
 * rounds[r] = {
 *   r, qid, cat, correctIndex, explanation,
 *   picks: [{p, c, ms, correct}],
 *   firstCorrectP,       谁先答对（用剩余时间判定）
 *   points: [{p, base, speed, streak, first, total}]
 * }
 * players[p] = { score, correct, attempts, bestStreak, streak }
 */
export function gradeAll(state) {
  const rounds = [];
  const players = [];
  for (let p = 0; p < state.players; p++) {
    players.push({ score: 0, correct: 0, attempts: 0, bestStreak: 0, streak: 0 });
  }

  for (let r = 0; r < state.total; r++) {
    const q = questionAt(state, r);
    const ci = q ? correctIndex(state, r) : -1;
    const ps = picksOfRound(state, r);
    const items = [];
    let firstCorrectP = -1;
    let firstMs = -1;
    let firstIdx = Infinity;
    ps.forEach((x, idx) => {
      const correct = x.c === ci;
      /* 谁先答对：剩余时间多的先答；时间相同则按提交先后。 */
      if (correct && (x.ms > firstMs || (x.ms === firstMs && idx < firstIdx))) {
        firstMs = x.ms;
        firstIdx = idx;
        firstCorrectP = x.p;
      }
      items.push({ p: x.p, c: x.c, ms: x.ms, correct });
    });

    const points = [];
    for (const x of items) {
      const pl = players[x.p];
      pl.attempts += 1;
      let base = 0, speed = 0, streak = 0, first = 0;
      if (x.correct) {
        pl.streak += 1;
        if (pl.streak > pl.bestStreak) pl.bestStreak = pl.streak;
        pl.correct += 1;
        base = BASE_POINTS;
        speed = Math.round(SPEED_MAX * x.ms / state.limitMs);
        streak = STREAK_STEP * Math.min(pl.streak, STREAK_CAP);
        first = (state.players > 1 && firstCorrectP === x.p) ? FIRST_BONUS : 0;
        pl.score += base + speed + streak + first;
      } else {
        pl.streak = 0;
      }
      points.push({ p: x.p, base, speed, streak, first, total: base + speed + streak + first });
    }

    /* 超时没答的人算一次尝试（0 分，连对中断） */
    const answered = new Set(items.map((x) => x.p));
    for (const t of state.timeouts) {
      if (t.r !== r) continue;
      if (answered.has(t.p)) continue;
      players[t.p].attempts += 1;
      players[t.p].streak = 0;
    }

    rounds.push({
      r,
      qid: q ? q.id : null,
      cat: q ? q.cat : null,
      correctIndex: ci,
      explanation: q ? q.e : '',
      picks: items,
      firstCorrectP,
      points,
    });
  }
  return { rounds, players };
}

/** 某个玩家在一局里的汇总（含正确率）。 */
export function playerSummary(state, p) {
  const g = gradeAll(state);
  const pl = g.players[p] || { score: 0, correct: 0, attempts: 0, bestStreak: 0, streak: 0 };
  const accuracy = pl.attempts > 0 ? pl.correct / pl.attempts : 0;
  return Object.assign({}, pl, {
    accuracy,
    accuracyPct: Math.round(accuracy * 100),
    rounds: state.total,
  });
}

/** 局末评价（按总分档位）。 */
export function rating(score) {
  if (score >= 1800) return { key: 'legend', label: '派对之神', text: '这分数能把整桌人镇住。' };
  if (score >= 1400) return { key: 'ace', label: '学霸', text: '手速和脑速都在线。' };
  if (score >= 1000) return { key: 'good', label: '稳健选手', text: '答得又快又准，继续保持。' };
  if (score >= 600) return { key: 'ok', label: '热身完毕', text: '节奏起来了，再来一局？' };
  if (score >= 200) return { key: 'newbie', label: '幸运观众', text: '猜对的运气也是实力的一部分。' };
  return { key: 'sleepy', label: '人在心不在', text: '下一题再认真点！' };
}

/** 双人局的胜负结论。 */
export function verdict(state) {
  const g = gradeAll(state);
  if (state.players < 2) return { kind: 'solo' };
  const a = g.players[0].score, b = g.players[1].score;
  if (a === b) return { kind: 'draw', a, b };
  return { kind: a > b ? 'p0' : 'p1', a, b };
}

/* ---------------------------------------------------------------------------
 * 摘要与广播视图
 * ------------------------------------------------------------------------- */

/**
 * 局面摘要 —— 双方比对用。
 *
 * 必须包含所有会影响后续演化的公开信息：
 *   种子、分类、题数、玩家数、限时、**随机数序号 rngCounter**、
 *   题目顺序、选项置换表、当前轮次、阶段、所有作答与超时记录。
 *
 * 注意这里**没有**分数和正确答案 —— 它们是推导出来的，不进摘要，
 * 也就不会因为摘要被广播出去而泄露答案。
 */
export function hashState(state) {
  if (!state) return '';
  const picks = (state.picks || []).map((x) => [x.r, x.p, x.c, x.ms].join(':')).join(',');
  const tos = (state.timeouts || []).map((x) => x.r + '#' + x.p).join(',');
  const closed = (state.closed || []).join(',');
  return [
    state.seed, state.cat, state.total, state.players, state.mode,
    state.limitMs, state.daily ? 1 : 0, state.rngCounter,
    (state.order || []).join(','),
    (state.opts || []).map((o) => o.join('')).join('|'),
    state.round, state.phase,
    picks, tos, closed,
  ].join('|');
}

/**
 * 广播前的视图裁剪。
 *
 * 这里裁掉的是**能反推出正确答案的东西**：
 *   · 分数 / 正确数 / 连对数 —— 「某人得了多少分」等于告诉对手他答对了
 *   · 任何推导结果（correctIndex / explanation）—— 那是结算环节才该揭示的
 *
 * 留下来的全是「谁按了哪个按钮」这类公开动作信息。
 */
export function publicView(state) {
  if (!state) return state;
  const view = {
    seed: state.seed,
    cat: state.cat,
    total: state.total,
    players: state.players,
    mode: state.mode,
    limitMs: state.limitMs,
    daily: state.daily ? 1 : 0,
    rngCounter: state.rngCounter,
    round: state.round,
    phase: state.phase,
    order: state.order.slice(),
    opts: state.opts.map((o) => o.slice()),
    picks: state.picks.map((x) => ({ r: x.r, p: x.p, c: x.c, ms: x.ms })),
    timeouts: state.timeouts.map((x) => ({ r: x.r, p: x.p })),
    closed: state.closed.slice(),
  };
  /* 兜底：任何叫这些名字的字段都不许出现在广播视图里 */
  delete view.correct;
  delete view.correctIndex;
  delete view.explanation;
  delete view.score;
  delete view.scores;
  delete view.grade;
  return view;
}

/**
 * 房主在结算环节额外广播的「揭示」。
 *
 * 同时带上承诺哈希，加入方一算就知道房主是不是在撒谎。
 */
export function revealOf(state, r) {
  const q = questionAt(state, r);
  if (!q) return null;
  const ci = correctIndex(state, r);
  return {
    r,
    qid: q.id,
    correctIndex: ci,
    explanation: q.e,
    commit: answerCommit(state, r),
  };
}

/**
 * 答案承诺：H(种子 | 分类 | 题号 | 正确项下标)。
 *
 * 房主开局时把每题的承诺发出来，结算时揭示正确项 ——
 * 揭示值算出来的哈希必须等于当初的承诺，否则就是房主串题/赖账。
 */
export function answerCommit(state, r) {
  const qid = state.order[r];
  if (!qid) return '';
  return fnv1a('quizparty|commit|' + (state.seed >>> 0) + '|' + state.cat + '|' + qid + '|' + correctIndex(state, r));
}

/** 全部题目的承诺表（开局时广播）。 */
export function commitTable(state) {
  const out = [];
  for (let r = 0; r < state.total; r++) out.push(answerCommit(state, r));
  return out;
}

/* ---------------------------------------------------------------------------
 * 题库信息（给 UI 用）
 * ------------------------------------------------------------------------- */

export { CATEGORY_LIST, CATEGORY_LABEL, questionById, questionsOf, questionCounts, QUESTIONS };
