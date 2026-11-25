/* =============================================================================
 * blast/src/rules.mjs —— 方块爆破规则引擎（零依赖、纯逻辑、可单测）
 * -----------------------------------------------------------------------------
 * 规矩（方块爆破 blast）
 * -----------------------------------------------------------------------------
 * 棋盘
 *   · cols×rows 的网格（默认 8×8）。每一列的方块**从底部往上堆**，
 *     各列高度可以不同 —— 这就是「这一列有多高」。
 *   · 每个座位有**自己的一块盘**（人机对战 / 联机对战都是各打各的，
 *     谁先把自己的盘撑爆谁输）。
 *   · 关键不变量：**静止状态下棋盘上不存在正交同色相邻**。
 *     初始局面生成时避开（纵向看正下方、横向看左邻），天空掉块时也避开。
 *     所以之后出现的同色相邻，一定是「打掉中间 → 上方掉下来贴上」造成的 ——
 *     每一段连锁都名副其实，不会凭空冒出来。
 *
 * 一次行动（点一个格子）
 *   · 以它为中心爆开 3×3 范围（越界裁掉），范围内的方块全部消失。
 *   · 同列上方的方块往下掉补位（重力压实）。
 *   · 掉下来之后，凡是**正交相邻且同色**的方块贴到一起就自动消失；
 *     消失后继续掉、继续贴 —— **连锁反应**。
 *   · 计分：第 k 段里消掉 n 块 → n × 10 × k。
 *     直接爆破是第 1 段（×1），第一次连锁 ×2，第二次 ×3 …（越连锁越值钱）。
 *
 * 天空（落块 = 难度推进）
 *   · 每回合结束，天空往盘里掉若干块新方块。
 *   · 掉多少：FALL_BASE 块起步，之后每 FALL_STEP 手多掉一块，最多 FALL_MAX 块
 *     —— 越到后面越猛（难度推进）。
 *   · 一次爆破最多只能消掉 9 块（3×3 范围），**连锁是唯一的加法**：
 *     掉得比你消得快 → 盘面越来越满 → 某一列顶到天花板 → **判负**。
 *   · 掉到哪：**优先掉最矮的列**（一样矮时随机挑；随机由 seed + 计数器决定）。
 *   · 一块都放不下（每一列都到顶了）→ **棋盘满了，判负**。
 *
 * 撤销
 *   · 状态里带一个**撤销栈**（每一步都存一份快照）。
 *   · scope='all'（单机/人机/每日）：撤销把**整份局面**原样装回去 ——
 *     消除、连锁、下落、天空落块、分数全部回滚，连 AI 那一步也一起没了。
 *   · scope='seat'（联机）：撤销**只装回本座位的盘**，
 *     对手的进度一个字都不改 —— 否则「靠撤销抹掉对手的进度」就是作弊。
 *   · 撤销是**一条普通动作**（{ act:'undo', seat }），所以联机时
 *     双方重放的结果必然一致。
 *
 * ---------------------------------------------------------------------------
 * 这个游戏接纯 P2P 的难点：**新方块的颜色是随机数**
 * -------------------------------------------------------------------------
 * 纯 P2P 没有服务器，房主就是权威。如果落块颜色由房主决定，房主可以挑颜色
 * 让对手的棋盘永远凑不出连锁 —— 他能算、能改、能赢。
 *
 * 解法跟飞行棋同源：**随机数不是抽出来的，是算出来的**。
 *   · 种子 seed 公开写在开局状态里（联机局从房号派生，双方各自算出同一个值）。
 *   · 所有随机取值只由 (seed, 该座位的计数器) 唯一决定：
 *       randInt(seed, i, n) = mix32(seed ^ mix32(i+1)) % n
 *     计数器在状态里、也在摘要里。
 *   · 所以双方各自算出来的落块颜色与落块位置**必然一致** ——
 *     房主想改也改不了：他改了就跟加入方算出来的不一样，摘要当场对不上。
 *
 * 计数器特别关键：它保证「落块的先后顺序」也是可推导的，不只是「颜色」可推导。
 *
 * 为什么不用 crypto.subtle：
 *   file:// 双击打开时页面不是安全上下文，crypto.subtle 是 undefined，
 *   用它会直接崩。所以摘要用纯 JS 的 FNV-1a，随机用纯 JS 的整数混淆函数，
 *   零依赖、零浏览器 API，Node 里也能跑。
 *
 * 纪律：
 *   · 顶层不碰 DOM、不碰 localStorage。
 *   · 所有纯函数，方便单测与「房主权威重放」。
 * ========================================================================== */

/* ---------------------------------------------------------------------------
 * 常量
 * ------------------------------------------------------------------------- */

export const COLS = 8;
export const ROWS = 8;
export const COLORS = 5;
export const MAX_HISTORY = 16;     /* 撤销栈最多保留几步（联机时状态要塞得进一条消息） */
export const EMPTY = 0;
export const BASE = 10;            /* 每块基础分 */
export const MIN_HEIGHT = 4;       /* 开局每列最低堆几块 */
export const MAX_HEIGHT0 = 6;      /* 开局每列最高堆几块 */
export const FALL_BASE = 10;       /* 每回合天空至少掉几块 */
export const FALL_STEP = 8;        /* 每几手多掉一块（难度推进） */
export const FALL_MAX = 18;        /* 每回合天空最多掉几块 */

/** 撤销范围：all = 整份局面装回；seat = 只装回本座位的盘。 */
export const UNDO_ALL = 'all';
export const UNDO_SEAT = 'seat';

/** 调色板（索引 = 颜色号 - 1）。 */
export const PALETTE = ['#e0483c', '#f5c542', '#3d8bd8', '#3fb96b', '#9b5de5'];

/** 座位：0 = 房主 / 玩家，1 = 加入方 / AI。 */
export const SEAT_HOST = 0;
export const SEAT_GUEST = 1;

/* ---------------------------------------------------------------------------
 * 哈希与随机
 * ------------------------------------------------------------------------- */

/** FNV-1a 32 位哈希（纯 JS，不依赖任何浏览器 API）。 */
export function fnv1a(str) {
  const s = String(str === undefined || str === null ? '' : str);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** 32 位整数混淆（murmur3 finalizer 变体），把 (seed, 计数器) 搅成好用的随机源。 */
export function mix32(a) {
  let x = a | 0;
  x = (x + 0x7f4a7c15) | 0;
  let t = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d);
  t ^= t >>> 12;
  t = Math.imul(t, 0x297a2d39);
  t ^= t >>> 15;
  return t >>> 0;
}

/**
 * 第 i 次随机取值（i 是公开的计数器）落在 [0, n) 里。
 *
 * 这是整个 P2P 公平性的核心：取值只由 (seed, i) 决定，两者都是公开的，
 * 所以双方各自算出来的落块颜色必然一致，房主改不了。
 */
export function randInt(seed, i, n) {
  if (!(n > 0)) return 0;
  return mix32((seed >>> 0) ^ mix32((i + 1) >>> 0)) % n;
}

/** 开局用的随机种子（单机/AI 局用）。Math.random 只在这里用一次。 */
export function randomSeed() {
  return (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0;
}

/** 从房间号派生种子 —— 联机局用这个，双方算出同一个值。 */
export function seedFromRoom(roomId, gameId) {
  return fnv1a('blast|' + (gameId || 'blast') + '|' + (roomId || '0'));
}

/** 每日固定局的种子：同一天所有人拿到同一副开局棋盘。 */
export function dailySeed(dateKey, gameId) {
  return fnv1a('blast-daily|' + (gameId || 'blast') + '|' + (dateKey || '0'));
}

/** 今天的日期键（本地时区 YYYY-MM-DD）。 */
export function todayKey(now) {
  const d = now || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/* ---------------------------------------------------------------------------
 * 棋盘基础操作
 * ------------------------------------------------------------------------- */

/** 格子下标（y=0 是顶行）。 */
export function idx(x, y, cols) { return y * cols + x; }

/** 坐标是否在棋盘内。 */
export function inBoard(x, y, cols, rows) {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < cols && y < rows;
}

/** 3×3 爆破范围（越界裁掉），返回格子下标数组。 */
export function blastCells(x, y, cols, rows) {
  const out = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
      out.push(idx(nx, ny, cols));
    }
  }
  return out;
}

/**
 * 重力压实：每列的方块整体往下掉补位（保持相对顺序）。就地修改。
 *
 * 压实之后每列都是从底部连续的一段 —— 这就是「这一列有多高」的意思。
 */
export function gravity(cells, cols, rows) {
  for (let x = 0; x < cols; x++) {
    let write = rows - 1;
    for (let y = rows - 1; y >= 0; y--) {
      const i = idx(x, y, cols);
      if (cells[i] !== EMPTY) {
        cells[write * cols + x] = cells[i];
        if (write !== y) cells[i] = EMPTY;
        write--;
      }
    }
    for (let y = write; y >= 0; y--) cells[y * cols + x] = EMPTY;
  }
  return cells;
}

/** 每列当前高度（底部对齐的连续段长度）。 */
export function columnHeights(cells, cols, rows) {
  const h = new Array(cols).fill(0);
  for (let x = 0; x < cols; x++) {
    let n = 0;
    for (let y = rows - 1; y >= 0; y--) {
      if (cells[idx(x, y, cols)] !== EMPTY) n++;
      else break;
    }
    h[x] = n;
  }
  return h;
}

/** 最高的一列有多高。 */
export function maxHeight(cells, cols, rows) {
  const h = columnHeights(cells, cols, rows);
  let m = 0;
  for (let i = 0; i < h.length; i++) if (h[i] > m) m = h[i];
  return m;
}

/** 棋盘上还剩几块方块。 */
export function blockCount(cells) {
  let n = 0;
  for (let i = 0; i < cells.length; i++) if (cells[i] !== EMPTY) n++;
  return n;
}

/**
 * 找出所有「正交相邻且同色」的方块（连通块大小 ≥ 2），返回要消除的下标。
 *
 * 只看上下左右，对角不算。返回的数组里每格只出现一次。
 */
export function sameColorGroups(cells, cols, rows) {
  const n = cols * rows;
  const seen = new Uint8Array(n);
  const out = [];
  const stack = [];
  for (let start = 0; start < n; start++) {
    if (seen[start] || cells[start] === EMPTY) continue;
    const color = cells[start];
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    const group = [];
    while (stack.length) {
      const i = stack.pop();
      group.push(i);
      const x = i % cols;
      const y = (i / cols) | 0;
      const nb = [];
      if (x > 0) nb.push(i - 1);
      if (x < cols - 1) nb.push(i + 1);
      if (y > 0) nb.push(i - cols);
      if (y < rows - 1) nb.push(i + cols);
      for (const j of nb) {
        if (seen[j] || cells[j] !== color) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    if (group.length >= 2) for (const i of group) out.push(i);
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * 初始棋盘
 * ------------------------------------------------------------------------- */

/**
 * 造一副初始棋盘：每列从底部往上堆 MIN_HEIGHT~MAX_HEIGHT0 块，
 * 且**不存在正交同色相邻**。
 *
 * 填法：从左到右逐列，每列从下往上。
 *   · 同一列：跟正下方那块不同色（纵向不撞色）
 *   · 相邻两列：同一行不同色（横向不撞色）
 * 保证「静止时没有同色相邻」这个不变量。
 */
export function initialCells(seed, counter, cols, rows, colors) {
  const cells = new Array(cols * rows).fill(EMPTY);
  let r = counter;
  for (let x = 0; x < cols; x++) {
    const h = MIN_HEIGHT + randInt(seed, r++, MAX_HEIGHT0 - MIN_HEIGHT + 1);
    for (let k = 0; k < h; k++) {
      const y = rows - 1 - k;
      const forbid = new Set();
      /* 正下方（同一列已经放好的上一块） */
      if (y + 1 < rows) {
        const c = cells[idx(x, y + 1, cols)];
        if (c !== EMPTY) forbid.add(c);
      }
      /* 左邻（左边那一列已经填完了） */
      if (x - 1 >= 0) {
        const c = cells[idx(x - 1, y, cols)];
        if (c !== EMPTY) forbid.add(c);
      }
      const allowed = [];
      for (let c = 1; c <= colors; c++) if (!forbid.has(c)) allowed.push(c);
      cells[idx(x, y, cols)] = allowed.length ? allowed[randInt(seed, r++, allowed.length)] : 1;
    }
  }
  return { cells, counter: r };
}

/* ---------------------------------------------------------------------------
 * 局面
 * ------------------------------------------------------------------------- */

/**
 * 开局局面。
 *
 * @param {number} seed   公开种子
 * @param {number} seats  座位数（1 = 单人，2 = 人机或联机）
 * @param {object} [opts] {cols, rows, colors, allowUndo, undoScope}
 */
export function initState(seed, seats, opts) {
  const o = opts || {};
  const cols = o.cols || COLS;
  const rows = o.rows || ROWS;
  const colors = o.colors || COLORS;
  const n = seats === 1 ? 1 : 2;

  const seatsState = [];
  for (let s = 0; s < n; s++) {
    /* 两个座位用同一个计数器起点 —— 开局盘面一模一样，公平。 */
    const init = initialCells(seed >>> 0, 0, cols, rows, colors);
    seatsState.push({
      cells: init.cells,
      score: 0,
      best: 0,             /* 达到过的最高连锁段数 */
      out: false,          /* 是否把自己的盘撑爆了 */
      rng: init.counter,   /* 落块计数器（公开，房主改不了） */
      myMoves: 0,          /* 自己走了多少手（决定自己盘上的难度） */
    });
  }

  return {
    v: 1,
    seed: seed >>> 0,
    seats: n,
    cols,
    rows,
    colors,
    turn: 0,
    moves: 0,                        /* 总手数（信息性） */
    allowUndo: o.allowUndo !== false,
    undoScope: o.undoScope || UNDO_ALL,
    seatsState,
    over: false,
    winner: -1,
    hist: [],                        /* 撤销栈：每一步都存一份快照 */
    lastGain: 0,
    lastChain: 0,
    lastCleared: [],
  };
}

/** 判胜/判负：out[i] 表示第 i 个座位把盘撑爆了（输）。 */
export function computeWinner(out, seats) {
  const a = !!out[0];
  const b = seats > 1 ? !!out[1] : false;
  if (a && b) return 2;             /* 两边都爆 = 平局 */
  if (a) return seats > 1 ? 1 : -1; /* 0 号输 → 1 号赢；单人是自己输 */
  if (b) return 0;
  return -1;                        /* 还没分出胜负 */
}

/* ---------------------------------------------------------------------------
 * 快照（撤销用）
 * ------------------------------------------------------------------------- */

/* 快照里的棋盘用字符串编码（一格一个字符，'0' = 空，'1'.. = 颜色），
   联机时一条消息塞得下，撤销也能完整还原。 */
export function encodeCells(cells) {
  let s = '';
  for (let i = 0; i < cells.length; i++) s += String.fromCharCode(48 + (cells[i] || 0));
  return s;
}

export function decodeCells(str, len) {
  const out = new Array(len);
  for (let i = 0; i < len; i++) {
    const code = (str.charCodeAt(i) || 48) - 48;
    out[i] = code > 0 ? code : EMPTY;
  }
  return out;
}

/**
 * 拍一份**本座位**的完整快照 —— 撤销就是「把这份快照原样装回去」。
 *
 * 存了棋盘、分数、最高连锁、出局标记、随机数计数器、自己走了多少手……
 * 所以撤销能**完整**还原（消除、连锁、下落、天空落块全部回滚）。
 */
export function snapshotSeat(state, seat) {
  const s = state.seatsState[seat];
  return {
    cells: encodeCells(s.cells),
    score: s.score,
    best: s.best,
    out: s.out,
    rng: s.rng,
    myMoves: s.myMoves,
  };
}

/** 把本座位的快照装回局面。 */
export function restoreSeat(state, seat, snap) {
  const seatsState = state.seatsState.slice();
  seatsState[seat] = {
    cells: decodeCells(snap.cells, state.cols * state.rows),
    score: snap.score,
    best: snap.best,
    out: snap.out,
    rng: snap.rng,
    myMoves: snap.myMoves,
  };
  return {
    ...state,
    seatsState,
    lastGain: 0,
    lastChain: 0,
    lastCleared: [],
  };
}

/* ---------------------------------------------------------------------------
 * 核心：一次爆破 + 连锁
 * ------------------------------------------------------------------------- */

/**
 * 在一份棋盘上模拟一次爆破（含连锁），返回结果。
 * 纯函数：不改传入的 board。
 *
 * @returns {{board:number[], removed:number, seg:number, gained:number,
 *            total:number, stages:number[], cleared:number[]}}
 */
export function resolveBlast(boardIn, x, y, cols, rows) {
  const board = boardIn.slice();
  const cleared = [];
  const stages = [];

  /* 1) 直接爆破 3×3 —— 这是第 1 段连锁（倍率 ×1） */
  let removed = 0;
  for (const i of blastCells(x, y, cols, rows)) {
    if (board[i] !== EMPTY) {
      board[i] = EMPTY;
      removed++;
      cleared.push(i);
    }
  }
  stages.push(removed);

  /* 2) 连锁：掉下来贴到一起的同色方块自动消失（第 2 段 ×2、第 3 段 ×3 …） */
  let seg = 1;
  let gained = removed * BASE;
  let total = removed;
  for (;;) {
    gravity(board, cols, rows);
    const groups = sameColorGroups(board, cols, rows);
    if (!groups.length) break;
    for (const i of groups) {
      board[i] = EMPTY;
      cleared.push(i);
    }
    seg++;
    stages.push(groups.length);
    total += groups.length;
    gained += groups.length * BASE * seg;
    if (seg > 64) break;            /* 安全阀：最多 64 段 */
  }

  return { board, removed, seg, gained, total, stages, cleared };
}

/* ---------------------------------------------------------------------------
 * 天空（落块）
 * ------------------------------------------------------------------------- */

/**
 * 往某一列顶部补一块方块。颜色避开正下方与左右邻居，
 * 保证「静止时没有同色相邻」这个不变量不被破坏。
 *
 * @returns {boolean} 是否放得下（放不下说明这一列已经到顶了）
 */
export function dropInto(board, col, rows, cols, colors, seed, counter) {
  const h = columnHeights(board, cols, rows)[col];
  if (h >= rows) return false;
  const row = rows - 1 - h;
  const forbid = new Set();
  const below = board[idx(col, row + 1, cols)];
  if (below !== EMPTY) forbid.add(below);
  if (col - 1 >= 0) {
    const c = board[idx(col - 1, row, cols)];
    if (c !== EMPTY) forbid.add(c);
  }
  if (col + 1 < cols) {
    const c = board[idx(col + 1, row, cols)];
    if (c !== EMPTY) forbid.add(c);
  }
  const allowed = [];
  for (let c = 1; c <= colors; c++) if (!forbid.has(c)) allowed.push(c);
  board[idx(col, row, cols)] = allowed.length ? allowed[randInt(seed, counter, allowed.length)] : 1;
  return true;
}

/**
 * 天空：往盘里掉若干块新方块。
 *
 * 掉多少：FALL_BASE 块起步，之后每 FALL_STEP 手多掉一块，最多 FALL_MAX 块
 * —— 越到后面越猛（难度推进）。
 *
 * 掉到哪：**优先掉最矮的列**（一样矮时随机挑；随机同样由 seed + 计数器决定，
 * 双方各自算必然一致）。
 *
 * @returns {{board:number[], rng:number, full:boolean, dropped:number[]}}
 */
export function applyFall(boardIn, cols, rows, colors, seed, rngIn, myMoves) {
  const board = boardIn.slice();
  let rng = rngIn;
  const dropped = [];
  const total = Math.min(FALL_MAX, FALL_BASE + Math.floor(myMoves / FALL_STEP));
  for (let k = 0; k < total; k++) {
    const heights = columnHeights(board, cols, rows);
    let low = Infinity;
    let count = 0;
    for (let x = 0; x < cols; x++) {
      if (heights[x] < low) { low = heights[x]; count = 1; }
      else if (heights[x] === low) count++;
    }
    if (low >= rows) return { board, rng, full: true, dropped };   /* 盘满了，一块都放不下 */
    const pick = randInt(seed, rng++, count);
    let seen = 0;
    let col = 0;
    for (let x = 0; x < cols; x++) {
      if (heights[x] === low) {
        if (seen === pick) { col = x; break; }
        seen++;
      }
    }
    if (!dropInto(board, col, rows, cols, colors, seed, rng++)) {
      return { board, rng, full: true, dropped };
    }
    dropped.push(idx(col, rows - 1 - columnHeights(board, cols, rows)[col], cols));
  }
  return { board, rng, full: false, dropped };
}

/* ---------------------------------------------------------------------------
 * 动作
 * ------------------------------------------------------------------------- */

/**
 * 应用一个动作，返回**新**局面（不改原对象）。
 *
 * 动作格式：
 *   { act:'blast', seat, x, y }   爆破
 *   { act:'undo',  seat }         撤销该座位上一步
 *
 * 非法动作**整手丢弃**（返回原状态）—— 联机时房主必须这么判，
 * 否则非法动作进了动作序列，之后每次重放都会在那一手断掉，整局卡死。
 */
export function applyAction(state, act) {
  if (!state || !act) return state;
  if (act.act === 'undo') return applyUndo(state, act);
  if (act.act !== 'blast') return state;

  const seats = state.seats;
  const seat = act.seat;
  if (!Number.isInteger(seat) || seat < 0 || seat >= seats) return state;
  if (seat !== state.turn) return state;                    /* 不是你的回合 */
  if (state.over) return state;                             /* 已经结束了 */
  if (!Number.isInteger(act.x) || !Number.isInteger(act.y)) return state;
  if (!inBoard(act.x, act.y, state.cols, state.rows)) return state;

  const cur = state.seatsState[seat];
  if (!cur) return state;
  if (cur.cells[idx(act.x, act.y, state.cols)] === EMPTY) return state;  /* 点空格子不算 */

  /* 先存快照（撤销用）—— 快照就是「这一步之前」本座位的完整局面 */
  const snap = snapshotSeat(state, seat);

  /* 爆破 + 连锁 */
  const res = resolveBlast(cur.cells, act.x, act.y, state.cols, state.rows);

  /* 天空（只作用在走这一步的那块盘上） */
  const fall = applyFall(
    res.board, state.cols, state.rows, state.colors, state.seed, cur.rng, cur.myMoves + 1,
  );

  const seatsState = state.seatsState.slice();
  seatsState[seat] = {
    cells: fall.board,
    score: cur.score + res.gained,
    best: Math.max(cur.best, res.seg),
    out: cur.out || fall.full,
    rng: fall.rng,
    myMoves: cur.myMoves + 1,
  };

  const out = seatsState.map((s) => s.out);
  const hist = state.hist.slice();
  hist.push({ seat, snap });
  while (hist.length > MAX_HISTORY) hist.shift();

  return {
    ...state,
    seatsState,
    turn: (state.turn + 1) % seats,
    moves: state.moves + 1,
    over: out[0] || (seats > 1 && out[1]),
    winner: computeWinner(out, seats),
    hist,
    lastGain: res.gained,
    lastChain: res.seg,
    lastCleared: res.cleared,
  };
}

/**
 * 撤销：该座位最近一步的完整还原。
 *
 * scope='seat'（联机）：把**本座位**的盘、分数、最高连锁、出局标记、
 *   随机数计数器、自己走了多少手原样装回去 ——
 *   消除、连锁、下落、天空落块全部回滚；
 *   而**对手的进度一个字都不改**（否则「靠撤销抹掉对手的进度」就是作弊）。
 *
 * scope='all'（单机/人机/每日）：撤销由 fold() 处理 ——
 *   它把「本座位最近一步」以及它之后的动作**整段作废**，
 *   然后从头重放，于是 AI 的应答、落块、分数全都一起没了。
 *
 * 撤销之后轮到被撤销的座位。
 */
export function applyUndo(state, act) {
  if (!state) return state;
  const seat = act.seat;
  const seats = state.seats;
  if (!Number.isInteger(seat) || seat < 0 || seat >= seats) return state;
  if (!state.allowUndo) return state;
  if (state.undoScope !== UNDO_SEAT) return state;   /* 'all' 由 fold 处理 */

  /* 找该座位最近的一步 */
  let at = -1;
  for (let i = state.hist.length - 1; i >= 0; i--) {
    if (state.hist[i].seat === seat) { at = i; break; }
  }
  if (at < 0) return state;                    /* 没有可撤销的步数 */

  const hist = state.hist.slice();
  hist.splice(at, 1);
  const next = restoreSeat(state, seat, state.hist[at].snap);
  next.hist = hist;
  next.turn = seat;                            /* 撤销后轮到自己 */
  const out = next.seatsState.map((s) => s.out);
  next.over = out[0] || (seats > 1 && out[1]);
  next.winner = computeWinner(out, seats);
  return next;
}

/* ---------------------------------------------------------------------------
 * 折叠与重放
 * ------------------------------------------------------------------------- */

/** 只重放爆破动作（撤销之后的动作由调用方裁掉）。 */
function foldBlasts(base, acts) {
  const b = base || {};
  let st = initState(
    b.seed || 0,
    b.seats || 2,
    {
      cols: b.cols, rows: b.rows, colors: b.colors,
      allowUndo: b.allowUndo, undoScope: b.undoScope,
    },
  );
  for (const a of acts) st = applyAction(st, a);
  return st;
}

/**
 * 把动作序列折叠成局面。
 *
 * scope='all' 时的撤销语义：
 *   遇到 { act:'undo', seat } → 找出该座位在**有效序列**里最近的一步，
 *   把这一步**以及它之后的全部动作**作废，然后从头重放。
 *   于是「玩家这一步 + AI 的应答 + AI 的落块」一起消失 —— 这才是完整的撤销。
 *
 * scope='seat' 时的撤销语义：
 *   撤销由 applyUndo 处理（只还原本座位的盘），动作序列保持不变。
 *
 * @param {object} base {seed, seats, cols, rows, colors, allowUndo, undoScope}
 * @param {object[]} actions
 */
export function fold(base, actions) {
  const b = base || {};
  const scope = b.undoScope || UNDO_ALL;
  const eff = [];
  let st = foldBlasts(b, eff);
  for (const a of actions || []) {
    if (!a) continue;
    if (a.act === 'undo') {
      if (b.allowUndo === false) continue;
      const seat = a.seat;
      if (!Number.isInteger(seat)) continue;
      if (scope === UNDO_SEAT) {
        st = applyAction(st, a);
        eff.push(a);
        continue;
      }
      /* 找出该座位最近的一步，整段作废后重放 */
      let at = -1;
      for (let i = eff.length - 1; i >= 0; i--) {
        if (eff[i].seat === seat) { at = i; break; }
      }
      if (at < 0) continue;                 /* 没有可撤销的步数 */
      eff.length = at;
      st = foldBlasts(b, eff);
      continue;
    }
    if (a.act !== 'blast') continue;
    st = applyAction(st, a);
    eff.push(a);
  }
  return st;
}

/** 从种子重放（房主权威模型用）。 */
export function replay(seed, actions, opts) {
  const o = opts || {};
  return fold({
    seed,
    seats: o.seats || 2,
    cols: o.cols,
    rows: o.rows,
    colors: o.colors,
    allowUndo: o.allowUndo,
    undoScope: o.undoScope,
  }, actions);
}

/* ---------------------------------------------------------------------------
 * 摘要与视图
 * ------------------------------------------------------------------------- */

/**
 * 局面摘要 —— 双方比对用。
 *
 * 必须包含**所有会影响后续演化的公开信息**：
 *   · seed（房主改种子会被发现）
 *   · 每个座位的 rng（落块计数器 —— 房主改落块顺序/颜色会被发现）
 *   · 两块棋盘、分数、最高连锁、出局标记、各自手数、总手数
 *   · 撤销栈摘要（撤销会改棋盘，必须进摘要）
 */
export function hashState(state) {
  if (!state) return '';
  const hist = (state.hist || [])
    .map((h) => h.seat + ':' + h.snap.cells + ':' + h.snap.rng + ':' + h.snap.myMoves)
    .join(';');
  const seats = (state.seatsState || [])
    .map((s) => [s.cells.join(''), s.score, s.best, s.out ? 1 : 0, s.rng, s.myMoves].join(','))
    .join('/');
  return [
    state.v,
    state.seed,
    state.seats,
    state.cols,
    state.rows,
    state.colors,
    state.turn,
    state.moves,
    seats,
    state.over ? 1 : 0,
    state.winner,
    state.allowUndo ? 1 : 0,
    state.undoScope,
    fnv1a(hist),
  ].join('|');
}

/**
 * 广播前的视图裁剪。
 *
 * 这个游戏**没有私密信息**（两块盘都是公开的：对手看得见你的盘，
 * 这正是「比谁先把盘撑爆」这种竞速玩法该有的透明度），
 * 所以视图就是原样的深拷贝。
 */
export function publicView(state) {
  if (!state) return state;
  return {
    ...state,
    seatsState: (state.seatsState || []).map((s) => ({
      cells: (s.cells || []).slice(),
      score: s.score,
      best: s.best,
      out: s.out,
      rng: s.rng,
      myMoves: s.myMoves,
    })),
    hist: (state.hist || []).map((h) => ({ seat: h.seat, snap: { ...h.snap } })),
    lastCleared: (state.lastCleared || []).slice(),
  };
}

/* ---------------------------------------------------------------------------
 * AI
 * ------------------------------------------------------------------------- */

/**
 * AI 选一步：把每个可点的格子都试一遍，
 * 按「这一手能拿到的分 + 削掉最高列的收益」打分，同分时偏好连锁段数多的。
 *
 * 同时会避开「一炸就把盘撑爆」的位置（那等于自己输）。
 *
 * 纯函数、无随机 —— 同样的局面永远选同一手（方便单测）。
 */
export function aiChoose(state, seat) {
  if (!state || state.over) return null;
  const cols = state.cols, rows = state.rows;
  const cur = state.seatsState[seat];
  if (!cur) return null;
  const before = maxHeight(cur.cells, cols, rows);
  let best = null;
  let bestVal = -Infinity;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (cur.cells[idx(x, y, cols)] === EMPTY) continue;
      const res = resolveBlast(cur.cells, x, y, cols, rows);
      const fall = applyFall(
        res.board, cols, rows, state.colors, state.seed, cur.rng, cur.myMoves + 1,
      );
      const after = maxHeight(fall.board, cols, rows);
      let val = res.gained * 10 + res.seg * 20 + (before - after) * 60;
      if (fall.full) val -= 1000000;          /* 一炸就满 = 输，绝不能选 */
      if (val > bestVal) {
        bestVal = val;
        best = { act: 'blast', seat, x, y };
      }
    }
  }
  return best;
}

/** 当前局面下某座位能点的格子（供 UI 高亮 / 测试用）。 */
export function legalMoves(state, seat) {
  if (!state || state.over) return [];
  const cols = state.cols, rows = state.rows;
  const cur = state.seatsState[seat];
  if (!cur) return [];
  const out = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (cur.cells[idx(x, y, cols)] !== EMPTY) out.push({ x, y });
    }
  }
  return out;
}

/** 某块盘上还有没有方块（没有就谁也动不了）。 */
export function boardAlive(state, seat) {
  if (!state) return false;
  const cur = state.seatsState[seat];
  if (!cur) return false;
  return blockCount(cur.cells) > 0;
}

/** 难度等级：手数越多等级越高（天空掉得越猛）。 */
export function levelOf(myMoves) {
  return 1 + Math.floor(myMoves / FALL_STEP);
}
