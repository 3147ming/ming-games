/* =============================================================================
 * connect4/src/rules.mjs —— 四子棋规则引擎（零依赖、纯逻辑、可单测）
 * -----------------------------------------------------------------------------
 * 规矩：7 列 × 6 行竖盘，玩家把棋子「掉」进某一列，棋子落到该列最下面的空格。
 *       红黑轮流，谁先连成横向/纵向/斜向 4 子即胜；棋盘落满为和棋。
 *
 * 与五子棋（gomoku）的关键差异：
 *   · 落子不是任选格，而是重力下落 —— 所以「能否落子」只看列高。
 *   · 连珠阈值是 4 不是 5。
 *   · 棋盘小（42 格），终局判定可以直接全盘扫，不用记录最后一手。
 *
 * 纪律（对齐仓库既有口径）：
 *   · 顶层不碰 DOM、不碰 localStorage。
 *   · 所有纯函数，方便单测与「房主权威重放」（同一份代码在两端算出同一结果）。
 * ========================================================================== */

export const COLS = 7;
export const ROWS = 6;
export const EMPTY = 0;
export const RED = 1;      /* 红棋（先手） */
export const BLACK = 2;    /* 黑棋（后手） */
export const CONNECT = 4;  /* 连成 4 即胜 */

/** 四条轴：横、竖、两条斜。 */
const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

/** 创建一个空棋盘（长度 42 的数组，下标 = y * COLS + x）。y=0 是最上面一行。 */
export function emptyBoard() {
  return new Uint8Array(COLS * ROWS);
}

export function inBounds(x, y) {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
  return x >= 0 && x < COLS && y >= 0 && y < ROWS;
}

export function idx(x, y) { return y * COLS + x; }

/**
 * 某列当前还能不能落子（该列没满）。
 * 注意判据是「列是否满」，不是「最底行是否空」——
 * 最底行有棋子恰恰说明这列还能往上堆，判错会让第 2 手就报「这列满了」。
 */
export function canDrop(board, x) {
  if (!Number.isInteger(x) || x < 0 || x >= COLS) return false;
  return dropRow(board, x) >= 0;
}

/**
 * 落子后的落点：重力下落，落在这列最下面的空格上。
 * 该列已满返回 -1。
 */
export function dropRow(board, x) {
  if (!Number.isInteger(x) || x < 0 || x >= COLS) return -1;
  for (let y = ROWS - 1; y >= 0; y--) {
    if (board[idx(x, y)] === EMPTY) return y;
  }
  return -1;
}

/**
 * 落子。返回 { ok, board, x, y, winner, line, draw } —— 不修改传入的 board。
 * @param {Uint8Array} board
 * @param {number} x 落子列
 * @param {number} stone RED / BLACK
 */
export function place(board, x, stone) {
  if (stone !== RED && stone !== BLACK) return { ok: false, reason: '棋子颜色不对' };
  if (!Number.isInteger(x) || x < 0 || x >= COLS) return { ok: false, reason: '超出棋盘' };
  const y = dropRow(board, x);
  if (y < 0) return { ok: false, reason: '这一列已经满了' };

  const next = Uint8Array.from(board);
  next[idx(x, y)] = stone;
  const res = checkWin(next, x, y, stone);
  const filled = countFilled(next);
  return {
    ok: true, board: next, x, y,
    winner: res.winner, line: res.line,
    draw: res.winner === EMPTY && filled >= COLS * ROWS,
  };
}

/**
 * 从刚落子的位置往外找连珠。
 * @returns {{winner:number, line:Array<[number,number]>}}
 */
export function checkWin(board, x, y, stone) {
  const out = { winner: EMPTY, line: [] };
  if (stone !== RED && stone !== BLACK) return out;

  for (const [dx, dy] of DIRS) {
    const line = [[x, y]];
    let cx = x + dx, cy = y + dy;
    while (inBounds(cx, cy) && board[idx(cx, cy)] === stone) { line.push([cx, cy]); cx += dx; cy += dy; }
    cx = x - dx; cy = y - dy;
    while (inBounds(cx, cy) && board[idx(cx, cy)] === stone) { line.push([cx, cy]); cx -= dx; cy -= dy; }
    if (line.length >= CONNECT) {
      out.winner = stone;
      out.line = line;
      return out;
    }
  }
  return out;
}

/** 棋盘上已落子的数量。 */
export function countFilled(board) {
  let n = 0;
  for (let i = 0; i < board.length; i++) if (board[i] !== EMPTY) n++;
  return n;
}

/**
 * 简易 AI：给每个「可落子的列」打分，取最高分。
 * 评分逻辑：能立即连成 4 给最高分；对手能立即连成 4 的列必须堵；
 *           否则看这一手能把己方连珠数推到多少（越靠近 4 越好）。
 * 够用即可 —— 联机玩法里 AI 只是陪练。
 */
export function aiMove(board, stone) {
  const opp = stone === RED ? BLACK : RED;
  let best = null, bestScore = -Infinity;

  for (let x = 0; x < COLS; x++) {
    if (!canDrop(board, x)) continue;
    const y = dropRow(board, x);

    /* 这一手我能不能直接赢？ */
    const self = board[idx(x, y)] === EMPTY ? stone : board[idx(x, y)];
    const afterSelf = Uint8Array.from(board);
    afterSelf[idx(x, y)] = stone;
    if (checkWin(afterSelf, x, y, stone).winner === stone) return { x, y };

    /* 堵：对手下一手能不能直接赢？（把当前列视为对手落点） */
    const afterOpp = Uint8Array.from(board);
    afterOpp[idx(x, y)] = opp;
    const oppWin = checkWin(afterOpp, x, y, opp).winner === opp;

    /* 潜力分：算己方在这一列能连成几。 */
    const potential = linePotential(afterSelf, x, y, stone);

    let score = potential;
    if (oppWin) score += 5000;      /* 必须堵 */
    if (y === ROWS - 1) score += 12; /* 靠底的重力优势 */
    score += Math.abs(x - (COLS - 1) / 2) * -2; /* 略偏好中间 */

    if (score > bestScore) { bestScore = score; best = { x, y }; }
  }
  return best || { x: 3, y: ROWS - 1 };
}

/** 落子后己方在该点能连成几（含自身）。 */
function linePotential(board, x, y, stone) {
  let score = 0;
  for (const [dx, dy] of DIRS) {
    let n = 1;
    let openEnds = 0;
    let cx = x + dx, cy = y + dy;
    while (inBounds(cx, cy) && board[idx(cx, cy)] === stone) { n++; cx += dx; cy += dy; }
    if (inBounds(cx, cy) && board[idx(cx, cy)] === EMPTY) openEnds++;
    cx = x - dx; cy = y - dy;
    while (inBounds(cx, cy) && board[idx(cx, cy)] === stone) { n++; cx -= dx; cy -= dy; }
    if (inBounds(cx, cy) && board[idx(cx, cy)] === EMPTY) openEnds++;
    if (n >= CONNECT) score += 100000;
    else if (n === 3) score += openEnds >= 2 ? 500 : 60;
    else if (n === 2) score += openEnds >= 2 ? 60 : 8;
    else score += 2;
  }
  return score;
}

/**
 * 状态摘要：房主权威模型里用来比对面板是否一致。
 * 同一份棋盘在两端算出同一个字符串 → 状态同步没问题。
 */
export function hashBoard(board) {
  let s = '';
  for (let i = 0; i < board.length; i++) s += board[i];
  return s;
}

/**
 * 从动作序列重放棋局（联机双方共用同一份代码，保证结果一致）。
 * @param {Array<{x:number,stone:number}>} actions
 */
export function replay(actions) {
  let board = emptyBoard();
  let winner = EMPTY;
  let line = [];
  let last = null;
  let draw = false;
  const moves = [];           /* 落点明细：{x,y,stone} —— 渲染与悔棋都要用 */
  for (const a of actions || []) {
    const r = place(board, a.x, a.stone);
    if (!r.ok) break;
    board = r.board;
    const mv = { x: r.x, y: r.y, stone: a.stone };
    moves.push(mv);
    last = mv;
    if (r.winner) { winner = r.winner; line = r.line; draw = false; break; }
    if (r.draw) { draw = true; break; }
  }
  return { board, winner, line, last, draw, moves, actions: (actions || []).slice() };
}

/** 终局判定包装：给定棋盘，返回是否已终局。 */
export function evaluate(board) {
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const s = board[idx(x, y)];
      if (s === EMPTY) continue;
      for (const [dx, dy] of DIRS) {
        let n = 1;
        let cx = x + dx, cy = y + dy;
        while (inBounds(cx, cy) && board[idx(cx, cy)] === s) { n++; cx += dx; cy += dy; }
        if (n >= CONNECT) return { over: true, winner: s, line: [[x, y]] };
      }
    }
  }
  const filled = countFilled(board);
  return { over: filled >= COLS * ROWS, winner: EMPTY, line: [], draw: filled >= COLS * ROWS };
}
