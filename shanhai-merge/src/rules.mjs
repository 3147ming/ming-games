/* =============================================================================
 * shanhai-merge/src/rules.mjs —— 「山海合成」规则引擎（零依赖、纯逻辑、可单测）
 * -----------------------------------------------------------------------------
 * 规矩（一句话版）：
 *   把两只**同种**的上古神兽叠在一起，它们会合体成下一阶神兽；
 *   棋盘上不断飘落新神兽，棋盘塞满又合不动了就结束；
 *   合成出目标阶（默认九尾狐）即获胜。
 *
 * ---------------------------------------------------------------------------
 * 玩法细节
 * -----------------------------------------------------------------------------
 *   · 棋盘：6×6（可配 5×5 等），每格放 0~1 只神兽。
 *   · 等级（阶）：1~8 级，对应八只上古神兽，名字和配色见 BEASTS。
 *       1 山魈 · 2 白泽 · 3 玄鸟 · 4 毕方 · 5 九尾狐 · 6 烛龙 · 7 鲲鹏 · 8 饕餮
 *     8 级（饕餮）是顶阶，再往上没有 —— **两只 8 级不能再合**。
 *   · 合成：把 A 拖到 B 上，要求 A、B **非空、等级相同、等级 < 8**。
 *       结果 A 格清空，B 格变成 level+1，得分 += (level+1) × 10。
 *       「同种」= 等级相同，不要求相邻 —— 棋盘上任意两只同阶都能合体。
 *   · 飘落：每次成功合成后，棋盘上会飘落 1~2 只新神兽（等级随机，偏低级），
 *     **只落在空位上**；每合成 dropEvery 次，飘落数量 +1（上限 dropMax）。
 *   · 结束：
 *       · 合出目标阶 → 胜利（won）
 *       · 步数挑战模式用完步数 → 失败（over / 'steps'）
 *       · **棋盘满了**又找不到任何一对可合体 → 失败（'stuck'）
 *   · 等待飘落：棋盘还没满、但已经没有任何一对能合体的时候，
 *       玩家可以「等一等」，天上再飘一只下来（act:'wait'）。
 *       没有这一手的话，玩家会卡在一个空荡荡的棋盘上 —— 无解。
 *   · 撤销：任何一步都能撤销（包括游戏结束之后）—— 撤销栈存在状态里。
 *
 * ---------------------------------------------------------------------------
 * 随机：为什么必须可复现，以及怎么做的
 * -----------------------------------------------------------------------------
 *   「每日固定局」是这游戏的核心玩法之一：按日期派生的 seed，
 *   必须让**所有人当天看到的初始盘面和整条飘落序列完全一样**，才能比分数。
 *
 *   所以这里用的是**纯 JS 计数式伪随机**（mulberry32）：
 *   第 i 个随机数 = randAt(seed, i)，只由 (seed, i) 决定，与调用顺序无关、
 *   也不依赖任何全局状态。同一个 seed ⇒ 同一串随机数 ⇒ 同一局。
 *
 *   状态里记着 rngPos（已经消耗到第几个随机数），
 *   它必须进 hashState —— 否则房主可以偷偷多消耗/少消耗随机数，
 *   之后飘落出来的神兽就跟别人算的对不上。
 *
 *   纪律：
 *   · 绝不用 Math.random() 生成任何跟状态相关的随机
 *     （Math.random() 只在 main.mjs 里用来造一局随机 seed，且那个 seed 一旦定下
 *      就写进状态，之后一切由 seed 推导）。
 *   · 不用 crypto.subtle —— file:// 双击打开时 crypto.subtle 不可用
 *     （非安全上下文），而且它只能给随机字节，给不了「可复算的第 i 个随机数」。
 *
 * ---------------------------------------------------------------------------
 * 如果要接 P2P，难点在哪、怎么解决
 * -----------------------------------------------------------------------------
 *   本作目前是**单人**（games.json 里 multiplayer = none），但规则引擎
 *   从第一天起就按「可重放」写好了，将来接 P2P 不需要改内核：
 *
 *   难点：飘落的随机神兽由 seed 决定 —— 如果由房主生成再广播，
 *   房主完全可以偷偷换掉落序列、给自己多掉高级神兽。
 *
 *   解决：跟飞行棋同一个思路 —— **随机不是掷出来的，是算出来的**。
 *     初始盘面 = f(seed)，第 i 次飘落 = f(seed, rngPos)。
 *     seed 和动作序列都是公开的，双方各自跑同一份 rules.mjs，
 *     得到的盘面必然一致；房主改了 seed 或者改了动作序列，
 *     对方重放一遍就对不上，当场发现。
 *
 *   为什么这比 commit-reveal 适合这里：
 *     合成类游戏是**单人单机**的（本作），多机同屏 P2P 反而会破坏「比分数」的乐趣；
 *     落点选择（拖到哪只身上）本来就是玩家动作，进动作序列就够，
 *     不需要额外的承诺/揭示往返。
 *
 *   为什么 undo 也要进状态：
 *     撤销是**动作**（{act:'undo'}），不是「把状态改回去」的魔法。
 *     撤销栈因此是可重放的：双方跑同一串动作，撤销栈自然一模一样。
 *     这也是 hashState 必须把撤销栈摘要进去的原因 ——
 *     栈的长度/内容变了，后续能撤销到哪一步就变了。
 * ========================================================================== */

/* ---------------------------------------------------------------------------
 * 常量
 * ------------------------------------------------------------------------- */

/** 棋盘边长（格数 = size × size）。 */
export const SIZE = 6;

/** 最高等级（饕餮）。到顶就不能再合了。 */
export const MAX_LEVEL = 8;

/** 默认目标等级（九尾狐）。合出它就算赢。 */
export const TARGET_DEFAULT = 5;

/** 合成基础得分系数：得分 = 新等级 × SCORE_UNIT。 */
export const SCORE_UNIT = 10;

/** 初始摆放的神兽只数（不超过棋盘格数）。 */
export const INIT_BLOCKS = 8;

/** 撤销栈最多留多少步（内存兜底）。 */
export const HISTORY_MAX = 240;

/**
 * 八阶神兽：从冷到暖（青 → 蓝 → 紫 → 红 → 金）。
 * 数组下标 0 对应 1 级。
 */
export const BEASTS = [
  { name: '山魈', color: '#2aa7a0', glow: 'rgba(42,167,160,.35)' },
  { name: '白泽', color: '#3f6fd4', glow: 'rgba(63,111,212,.35)' },
  { name: '玄鸟', color: '#6f57cf', glow: 'rgba(111,87,207,.35)' },
  { name: '毕方', color: '#a847c8', glow: 'rgba(168,71,200,.35)' },
  { name: '九尾狐', color: '#d94f7a', glow: 'rgba(217,79,122,.35)' },
  { name: '烛龙', color: '#e0473c', glow: 'rgba(224,71,60,.35)' },
  { name: '鲲鹏', color: '#f0872c', glow: 'rgba(240,135,44,.35)' },
  { name: '饕餮', color: '#e8b93c', glow: 'rgba(232,185,60,.4)' },
];

/** 等级 → 神兽定义（越界返回 null）。 */
export function beastOf(level) {
  if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL) return null;
  return BEASTS[level - 1];
}

/** 等级 → 名字（越界返回 '?'）。 */
export function beastName(level) {
  const b = beastOf(level);
  return b ? b.name : '?';
}

/* ---------------------------------------------------------------------------
 * 伪随机（纯 JS、计数式、可复现）
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

/** mulberry32 —— 32 位状态的经典伪随机发生器。 */
export function mulberry32(a) {
  let s = a >>> 0;
  return function next() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 第 i 个随机数（i 从 0 开始），只由 (seed, i) 决定。
 *
 * 同一个 seed + 同一个 i ⇒ 同一个值。跟调用顺序无关，也不吃任何全局状态。
 *
 * 为什么是 O(1)：mulberry32 的内部状态就是个 32 位计数器
 * （每步加同一个常数），所以「第 i 步的状态」可以直接算出来，
 * 不用从头跑 i 步。顺序版和跳跃版输出完全一致（单测里有对拍）。
 */
export function randAt(seed, i) {
  const a = ((seed >>> 0) + Math.imul(i + 1, 0x6D2B79F5)) | 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** 开局用的随机种子（只在 main.mjs 里调用一次）。 */
export function randomSeed() {
  return (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0;
}

/** 按日期派生的种子 —— 每日固定局用（同一天所有人拿到同一个 seed）。 */
export function seedFromDate(dateKey) {
  return fnv1a('shanhai-merge|daily|' + (dateKey || '0'));
}

/** 按房间号派生的种子 —— 将来接 P2P 时用（双方算出来必然一致）。 */
export function seedFromRoom(roomId) {
  return fnv1a('shanhai-merge|room|' + (roomId || '0'));
}

/* ---------------------------------------------------------------------------
 * 局面
 * ------------------------------------------------------------------------- */

/**
 * 开局局面。
 *
 * @param {number} seed  公开种子
 * @param {object} [opts]
 *   size       棋盘边长（默认 6）
 *   target     目标等级（默认 5 = 九尾狐）
 *   maxMoves   步数上限（0 = 不限；「步数挑战」模式用）
 *   dropEvery  每合成多少次飘落数 +1（默认 4）
 *   dropMax    每次最多飘落几只（默认 2）
 */
export function initState(seed, opts = {}) {
  const size = Math.max(1, Math.min(12, opts.size || SIZE));
  const n = size * size;
  const st = {
    v: 1,
    seed: seed >>> 0,
    size,
    target: Math.max(1, Math.min(MAX_LEVEL, opts.target || TARGET_DEFAULT)),
    maxMoves: Math.max(0, opts.maxMoves || 0),
    dropEvery: Math.max(1, opts.dropEvery || 4),
    dropMax: Math.max(1, opts.dropMax || 2),
    board: new Array(n).fill(0),
    score: 0,
    moves: 0,
    rngPos: 0,        /* 已经消耗到第几个随机数 */
    over: false,
    overReason: '',   /* '' | 'win' | 'steps' | 'stuck' */
    won: false,
    best: 0,          /* 历史最高「合成出来」的等级 */
    history: [],      /* 撤销栈 */
    events: null,     /* 本次动作的动画信息（不属于演化状态，不进摘要） */
  };

  /* 初始摆放：先把所有格子洗一遍，取前 INIT_BLOCKS 格放神兽。 */
  const idx = new Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const r = randAt(st.seed, st.rngPos++);
    const j = Math.floor(r * (i + 1));
    const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
  }
  const blocks = Math.min(INIT_BLOCKS, n);
  for (let k = 0; k < blocks; k++) {
    const r = randAt(st.seed, st.rngPos++);
    st.board[idx[k]] = dropLevel(r);
  }
  /* best 恒为 0 —— 它表示「玩家合成出来的最高等级」，
     初始盘面上的灵兽不算（那是天上掉下来的，不是你合出来的）。 */

  /* 棋盘一开始就是满的且合不动 → 直接结束（极小棋盘的边界情形）。 */
  if (isFull(st.board) && !hasMerge(st.board)) {
    st.over = true;
    st.overReason = 'stuck';
  }  st.events = { type: 'init' };
  return st;
}

/** 飘落神兽的等级：偏低级（55% 一阶 / 30% 二阶 / 15% 三阶）。 */
export function dropLevel(r) {
  if (r < 0.55) return 1;
  if (r < 0.85) return 2;
  return 3;
}

/* ---------------------------------------------------------------------------
 * 棋盘工具
 * ------------------------------------------------------------------------- */

/** 棋盘是否已满（没有空位）。 */
export function isFull(board) {
  for (let i = 0; i < board.length; i++) if (!board[i]) return false;
  return true;
}

/** 空位下标列表。 */
export function emptyCells(board) {
  const out = [];
  for (let i = 0; i < board.length; i++) if (!board[i]) out.push(i);
  return out;
}

/**
 * 棋盘上是否存在一对可合成的（等级相同且 < 顶阶）。
 * 返回 false 不代表游戏结束 —— 棋盘没满的话还可以「等飘落」。
 */
export function hasMerge(board) {
  const seen = new Set();
  for (let i = 0; i < board.length; i++) {
    const v = board[i];
    if (!v || v >= MAX_LEVEL) continue;
    if (seen.has(v)) return true;
    seen.add(v);
  }
  return false;
}

/** 所有可合成的格子对（{from, to}），to 是落点。 */
export function mergePairs(board) {
  const out = [];
  const first = new Map();
  for (let i = 0; i < board.length; i++) {
    const v = board[i];
    if (!v || v >= MAX_LEVEL) continue;
    if (first.has(v)) out.push({ from: first.get(v), to: i });
    else first.set(v, i);
  }
  return out;
}

/**
 * 一次合成是否合法。
 * 规则：from ≠ to、两格都非空、等级相同、等级 < 顶阶。
 */
export function canMerge(board, from, to) {
  if (!Array.isArray(board)) return false;
  if (!Number.isInteger(from) || !Number.isInteger(to)) return false;
  if (from < 0 || to < 0 || from >= board.length || to >= board.length) return false;
  if (from === to) return false;
  const a = board[from], b = board[to];
  if (!a || !b) return false;
  if (a !== b) return false;
  if (a >= MAX_LEVEL) return false;
  return true;
}

/**
 * 当前局面下是否还能继续合（等价于 hasMerge(board)）。
 * 注意：还能「等飘落」也算能继续 —— 只要棋盘没满。
 */
export function canContinue(state) {
  if (!state || state.over) return false;
  if (hasMerge(state.board)) return true;
  return !isFull(state.board);
}

/* ---------------------------------------------------------------------------
 * 动作
 * ------------------------------------------------------------------------- */

/** 深拷贝一个局面（board / history 里的棋盘都拷一份）。 */
export function cloneState(state) {
  return {
    v: state.v,
    seed: state.seed,
    size: state.size,
    target: state.target,
    maxMoves: state.maxMoves,
    dropEvery: state.dropEvery,
    dropMax: state.dropMax,
    board: state.board.slice(),
    score: state.score,
    moves: state.moves,
    rngPos: state.rngPos,
    over: state.over,
    overReason: state.overReason,
    won: state.won,
    best: state.best,
    history: state.history.map((h) => ({ board: h.board.slice(), score: h.score, moves: h.moves, rngPos: h.rngPos, over: h.over, overReason: h.overReason, won: h.won, best: h.best })),
    events: state.events,
  };
}

/** 取一份快照（撤销栈里存的东西）。 */
function snapshotOf(state) {
  return {
    board: state.board.slice(),
    score: state.score,
    moves: state.moves,
    rngPos: state.rngPos,
    over: state.over,
    overReason: state.overReason,
    won: state.won,
    best: state.best,
  };
}

/**
 * 应用一个动作。
 *
 * 动作格式：
 *   { act:'merge', from: 格子下标, to: 格子下标 }
 *   { act:'wait' }   等待飘落（仅当没有可合成对且棋盘未满）
 *   { act:'undo' }
 *
 * 非法动作一律**原样返回旧局面**（不抛错、不改状态）——
 * 这样重放时双方对同一串动作一定得到同一结果。
 */
export function applyAction(state, act) {
  if (!state || !act || typeof act.act !== 'string') return state;

  if (act.act === 'undo') return applyUndo(state);
  if (act.act === 'wait') return applyWait(state);
  if (act.act !== 'merge') return state;

  /* 已经结束了就不能再合成（撤销除外，撤销单独处理）。 */
  if (state.over) return state;
  if (!canMerge(state.board, act.from, act.to)) return state;

  const level = state.board[act.from];
  const next = cloneState(state);

  /* --- 合成 --- */
  next.board[act.from] = 0;
  next.board[act.to] = level + 1;
  const gained = (level + 1) * SCORE_UNIT;
  next.score += gained;
  next.moves += 1;
  if (level + 1 > next.best) next.best = level + 1;

  /* --- 飘落 --- */
  const drops = [];
  const count = Math.min(next.dropMax, 1 + Math.floor(next.moves / next.dropEvery));
  for (let k = 0; k < count; k++) {
    const blanks = emptyCells(next.board);
    if (!blanks.length) break;               /* 棋盘满了就不飘 */
    const rc = randAt(next.seed, next.rngPos++);
    const cell = blanks[Math.floor(rc * blanks.length)];
    const rl = randAt(next.seed, next.rngPos++);
    next.board[cell] = dropLevel(rl);
    drops.push({ i: cell, level: next.board[cell] });
  }

  /* --- 撤销栈：先存「动作之前」的快照 --- */
  next.history = state.history.concat([snapshotOf(state)]);
  if (next.history.length > HISTORY_MAX) next.history = next.history.slice(next.history.length - HISTORY_MAX);

  /* --- 结束判定 --- */
  if (next.best >= next.target) {
    next.won = true;
    next.over = true;
    next.overReason = 'win';
  } else if (next.maxMoves > 0 && next.moves >= next.maxMoves) {
    next.over = true;
    next.overReason = 'steps';
  } else if (isFull(next.board) && !hasMerge(next.board)) {
    /* 棋盘塞满了又合不动 —— 这才叫走投无路。
       棋盘还空着但暂时合不动，不算结束：可以「等一等」等天上再飘一只。 */
    next.over = true;
    next.overReason = 'stuck';
  }

  next.events = { type: 'merge', from: act.from, to: act.to, level, newLevel: level + 1, gained, drops };
  return next;
}

/**
 * 等待飘落 —— 棋盘还没满、但已经没有任何一对能合体时的「等一等」。
 *
 * 为什么需要这一手：
 *   合成类游戏里，棋盘上偶尔会出现「等级各不相同」的僵局（比如只剩白泽和玄鸟）。
 *   如果没有这一手，玩家就只能干看着 —— 一个空棋盘，没得合，也没法结束。
 *   所以规则是：**棋盘未满且无对可合时，可以主动等天上再飘一只下来。**
 *
 * 合法性：必须「当前没有任何可合成对」且「棋盘还没满」。
 * 如果还有对可以合，等一等就是浪费回合 —— 不给。
 */
export function applyWait(state) {
  if (!state || state.over) return state;
  if (hasMerge(state.board)) return state;          /* 还有对能合，不许干等 */
  if (isFull(state.board)) return state;            /* 满了也就不用等了（而且已经结束了）*/
  const blanks = emptyCells(state.board);
  if (!blanks.length) return state;

  const next = cloneState(state);
  const rc = randAt(next.seed, next.rngPos++);
  const cell = blanks[Math.floor(rc * blanks.length)];
  const rl = randAt(next.seed, next.rngPos++);
  next.board[cell] = dropLevel(rl);

  next.history = state.history.concat([snapshotOf(state)]);
  if (next.history.length > HISTORY_MAX) next.history = next.history.slice(next.history.length - HISTORY_MAX);

  /* 等完这一下，棋盘可能刚好塞满 —— 那就看看还有没有得合 */
  if (isFull(next.board) && !hasMerge(next.board)) {
    next.over = true;
    next.overReason = 'stuck';
  }

  next.events = { type: 'wait', drops: [{ i: cell, level: next.board[cell] }] };
  return next;
}

/** 撤销一步（游戏结束之后也能撤 —— 撤销就是「回到上一个局面」）。 */
export function applyUndo(state) {
  if (!state || !state.history.length) return state;
  const snap = state.history[state.history.length - 1];
  const next = cloneState(state);
  next.board = snap.board.slice();
  next.score = snap.score;
  next.moves = snap.moves;
  next.rngPos = snap.rngPos;
  next.over = snap.over;
  next.overReason = snap.overReason;
  next.won = snap.won;
  next.best = snap.best;
  next.history = state.history.slice(0, -1);
  next.events = { type: 'undo' };
  return next;
}

/* ---------------------------------------------------------------------------
 * 折叠与重放
 * ------------------------------------------------------------------------- */

/**
 * 把动作序列折叠成局面。
 * @param {object} base  {seed, opts}
 */
export function fold(base, actions) {
  const b = base || {};
  let st = initState((b.seed || 0) >>> 0, b.opts || {});
  const list = actions || [];
  for (const a of list) st = applyAction(st, a);
  return st;
}

/** 从种子重放（房主权威模型 / 单测都用这个）。 */
export function replay(seed, actions, opts) {
  return fold({ seed, opts: opts || {} }, actions);
}

/* ---------------------------------------------------------------------------
 * 摘要与视图
 * ------------------------------------------------------------------------- */

/**
 * 局面摘要 —— 双方比对用。
 *
 * 必须包含所有会影响后续演化的公开信息：
 *   seed（决定随机流）、rngPos（随机流位置）、棋盘内容、分数、步数、
 *   目标/上限、结束标志，**以及撤销栈的摘要**
 *   （栈变了 ⇒ 之后能撤到哪一步就变了 ⇒ 后续演化会变）。
 */
export function hashState(state) {
  if (!state) return '';
  const hist = (state.history || []).map((h) => h.board.join('') + ':' + h.score + ':' + h.moves).join(';');
  return [
    state.seed, state.size, state.target, state.maxMoves,
    state.dropEvery, state.dropMax,
    state.board.join(''),
    state.score, state.moves, state.rngPos,
    state.over ? 1 : 0, state.won ? 1 : 0, state.overReason || '',
    state.best,
    (state.history || []).length, fnv1a(hist),
  ].join('|');
}

/**
 * 广播前的视图裁剪。
 *
 * 这个游戏**没有私密信息** —— 盘面、随机流位置、撤销栈全都是公开的
 * （双方各自重放就能算出来，藏起来只会让房主有机可乘）。
 * 所以视图就是原样的一份拷贝。
 */
export function publicView(state) {
  if (!state) return state;
  return cloneState(state);
}

/* ---------------------------------------------------------------------------
 * 一些给 UI 用的小工具（纯函数，方便测）
 * ------------------------------------------------------------------------- */

/** 这一步的飘落数量：每 dropEvery 次合成 +1 只，上限 dropMax。 */
export function dropCountFor(state, moves) {
  return Math.min(state.dropMax, 1 + Math.floor(moves / state.dropEvery));
}

/** 棋盘上当前最高等级（0 = 空棋盘）。 */
export function topLevel(board) {
  let m = 0;
  for (let i = 0; i < board.length; i++) if (board[i] > m) m = board[i];
  return m;
}

/** 棋盘里每一阶各有几只（用于图鉴面板）。 */
export function levelCounts(board) {
  const counts = new Array(MAX_LEVEL + 1).fill(0);
  for (let i = 0; i < board.length; i++) {
    const v = board[i];
    if (v >= 1 && v <= MAX_LEVEL) counts[v]++;
  }
  return counts;
}

/** 一句话说明这次动作干了什么（给提示条用）。 */
export function describeEvents(state) {
  const ev = state && state.events;
  if (!ev) return '';
  if (ev.type === 'init') return '开局';
  if (ev.type === 'undo') return '撤销一步';
  if (ev.type === 'merge') {
    const bits = [beastName(ev.level) + ' + ' + beastName(ev.level) + ' → ' + beastName(ev.newLevel)];
    bits.push('+' + ev.gained + ' 分');
    if (ev.drops && ev.drops.length) bits.push('飘落 ' + ev.drops.length + ' 只');
    return bits.join(' · ');
  }
  if (ev.type === 'wait') {
    return '等来一只 ' + beastName(ev.drops[0].level);
  }
  return '';
}
