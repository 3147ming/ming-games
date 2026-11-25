/* =============================================================================
 * gomoku/src/rules.mjs —— 五子棋规则引擎（零依赖、纯逻辑、可单测）
 * -----------------------------------------------------------------------------
 * 规矩：15×15 棋盘，黑先，五子连珠即胜。
 * 可选禁手（黑棋三三 / 四四 / 长连）—— 默认关，休闲局不必那么严。
 *
 * 纪律（对齐仓库既有口径）：
 *   · 顶层不碰 DOM、不碰 localStorage。
 *   · 所有纯函数，方便单测与「房主权威重放」（同一份代码在两端算出同一结果）。
 * ========================================================================== */

export const SIZE = 15;
export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;

/** 四条轴：横、竖、两条斜。 */
const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

/** 创建一个空棋盘（长度 225 的数组，下标 = y * SIZE + x）。 */
export function emptyBoard() {
  return new Uint8Array(SIZE * SIZE);
}

/** 坐标换算。越界返回 null。 */
export function inBounds(x, y) {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
  return x >= 0 && x < SIZE && y >= 0 && y < SIZE;
}

export function idx(x, y) { return y * SIZE + x; }

/**
 * 落子。返回 { ok, board, winner, line } —— 不修改传入的 board。
 * @param {Uint8Array} board
 * @param {number} x
 * @param {number} y
 * @param {number} stone  BLACK / WHITE
 */
export function place(board, x, y, stone) {
  if (!inBounds(x, y)) return { ok: false, reason: '坐标超出棋盘' };
  const i = idx(x, y);
  if (board[i] !== EMPTY) return { ok: false, reason: '这个位置已经有子了' };
  const next = Uint8Array.from(board);
  next[i] = stone;
  const res = checkWin(next, x, y, stone);
  return { ok: true, board: next, winner: res.winner, line: res.line, forbidden: res.forbidden };
}

/**
 * 从刚落子的位置往外找连珠。
 * @returns {{winner:number, line:Array<[number,number]>, forbidden:Array}}
 */
export function checkWin(board, x, y, stone) {
  const out = { winner: EMPTY, line: [], forbidden: [] };
  if (stone !== BLACK && stone !== WHITE) return out;

  for (const [dx, dy] of DIRS) {
    const line = [[x, y]];
    /* 正向 */
    let cx = x + dx, cy = y + dy;
    while (inBounds(cx, cy) && board[idx(cx, cy)] === stone) { line.push([cx, cy]); cx += dx; cy += dy; }
    /* 反向 */
    cx = x - dx; cy = y - dy;
    while (inBounds(cx, cy) && board[idx(cx, cy)] === stone) { line.push([cx, cy]); cx -= dx; cy -= dy; }
    if (line.length >= 5) {
      out.winner = stone;
      out.line = line;
      return out;
    }
  }
  return out;
}

/**
 * 禁手判定（仅黑棋）。
 * 语义：**假设在 (x,y) 落下一颗黑子**，判断这手是否违禁。
 * 所以调用时 board 里 (x,y) 可以是空的 —— 判定用的就是「落子之后」的棋形。
 * 默认不启用，联机休闲局免得吵架。
 * @returns {Array} 违禁的类型：'三三' / '四四' / '长连'
 */
export function checkForbidden(board, x, y) {
  const bad = [];
  if (!inBounds(x, y)) return bad;
  const i = idx(x, y);
  if (board[i] !== EMPTY && board[i] !== BLACK) return bad;

  /* 在「落子之后」的棋形上判断：先把这颗子放上去。 */
  const b = Uint8Array.from(board);
  b[i] = BLACK;

  /* 长连：连成六子或以上 */
  for (const [dx, dy] of DIRS) {
    let n = 1;
    let cx = x + dx, cy = y + dy;
    while (inBounds(cx, cy) && b[idx(cx, cy)] === BLACK) { n++; cx += dx; cy += dy; }
    cx = x - dx; cy = y - dy;
    while (inBounds(cx, cy) && b[idx(cx, cy)] === BLACK) { n++; cx -= dx; cy -= dy; }
    if (n >= 6) { bad.push('长连'); break; }
  }
  if (bad.length) return bad;

  /* 四四：两条不同轴上都有活四 */
  let fours = 0;
  for (const [dx, dy] of DIRS) {
    if (countOpenFours(b, x, y, dx, dy) > 0) fours++;
  }
  if (fours >= 2) bad.push('四四');

  /* 三三：两条不同轴上都有活三 */
  let threes = 0;
  for (const [dx, dy] of DIRS) {
    if (countOpenThrees(b, x, y, dx, dy) > 0) threes++;
  }
  if (threes >= 2) bad.push('三三');

  return bad;
}

/**
 * 数某条轴上「落这手能成的活四」个数（0 或 1）。
 * 活四 = 存在一种填法能连成五，且两端都留有空位可扩展成六。
 */
function countOpenFours(board, x, y, dx, dy) {
  /* 把这条轴上的连续黑子（含假设落子处）抽成一维序列，看能否凑成两个「四」，
     或一个两端都能延伸的「四」。简化判定：这一轴上是否能连成 5 个，
     且该连珠的一端（或两端）外面还有空。 */
  const cells = axisCells(board, x, y, dx, dy);
  const n = cells.length;
  /* 找出所有长度 5 的窗口里全黑的数量 */
  let win5 = 0;
  for (let s = 0; s + 5 <= n; s++) {
    let all = true;
    for (let k = 0; k < 5; k++) if (cells[s + k].v !== BLACK) { all = false; break; }
    if (all) win5++;
  }
  if (win5 === 0) return 0;
  /* 一端能延伸成六 —— 活四；两端都封死的是「冲四」，不算活四。 */
  /* 简化：只要存在一个窗口，其两端之外至少一侧有可下的空位且能连六。 */
  for (let s = 0; s + 5 <= n; s++) {
    let all = true;
    for (let k = 0; k < 5; k++) if (cells[s + k].v !== BLACK) { all = false; break; }
    if (!all) continue;
    const before = s > 0 ? cells[s - 1].v : EMPTY;
    const after = s + 5 < n ? cells[s + 5].v : EMPTY;
    /* 一端被封、另一端可下 → 冲四（可被堵），两端可下 → 活四 */
    if (before === EMPTY && after === EMPTY) return 1;
  }
  /* 只有一个成五窗口且两端都被封 → 死四，不算活四。 */
  return 0;
}

/** 某条轴上「落这手能成的活三」个数（0 或 1）。 */
function countOpenThrees(board, x, y, dx, dy) {
  const cells = axisCells(board, x, y, dx, dy);
  const n = cells.length;
  /* 活三 = 存在一个长度 5 的窗口，其中恰好 3 个黑子（含落子处）、2 个空，
     且这 2 个空能填成五（连续）。简化：窗口内 3 黑且其余 2 空为连续空位。 */
  for (let s = 0; s + 5 <= n; s++) {
    let blacks = 0; const empties = [];
    for (let k = 0; k < 5; k++) {
      const v = cells[s + k].v;
      if (v === BLACK) blacks++;
      else if (v === EMPTY) empties.push(s + k);
      else { blacks = -99; break; }
    }
    if (blacks !== 3 || empties.length !== 2) continue;
    /* 两个空必须相邻（在窗口内连续），且窗口外侧还有延伸空间 → 活三 */
    if (empties[1] !== empties[0] + 1) continue;
    /* 检查这 2 个空填满后，两端是否还有空间继续连（能成五且不是死三） */
    const left = s > 0 ? cells[s - 1].v : EMPTY;
    const right = s + 5 < n ? cells[s + 5].v : EMPTY;
    if (left === EMPTY || right === EMPTY) return 1;
  }
  return 0;
}

/** 取某条轴上以 (x,y) 为中心的一段序列（向正反两向各取若干格）。
    假定 (x,y) 已是黑子（调用方已把假设落子放进 board）。 */
function axisCells(board, x, y, dx, dy) {
  const out = [];
  /* 先向负向收集，直到出界或遇到非黑子 */
  let back = [];
  let cx = x - dx, cy = y - dy;
  while (inBounds(cx, cy) && board[idx(cx, cy)] === BLACK) { back.unshift({ x: cx, y: cy, v: BLACK }); cx -= dx; cy -= dy; }
  /* 负向再延伸一格（可能是空位，凑窗口用） */
  if (inBounds(cx, cy)) back.unshift({ x: cx, y: cy, v: board[idx(cx, cy)] });
  out.push(...back);
  out.push({ x, y, v: BLACK });
  cx = x + dx; cy = y + dy;
  while (inBounds(cx, cy) && board[idx(cx, cy)] === BLACK) { out.push({ x: cx, y: cy, v: BLACK }); cx += dx; cy += dy; }
  if (inBounds(cx, cy)) out.push({ x: cx, y: cy, v: board[idx(cx, cy)] });
  return out;
}

/**
 * 简易 AI：给每个空点打分（能成五最高，能成四次之），取最高分。
 * 够用即可 —— 联机玩法里 AI 只是陪练，棋力不是重点。
 */
export function aiMove(board, stone, depth) {
  const maxDepth = depth || 1;
  let best = null, bestScore = -1;
  const opp = stone === BLACK ? WHITE : BLACK;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (board[idx(x, y)] !== EMPTY) continue;
      /* 只考虑已有子附近的空点：远处的点不值得算，省时间 */
      if (!nearStone(board, x, y, 2)) continue;
      const self = scorePoint(board, x, y, stone, maxDepth);
      const foe = scorePoint(board, x, y, opp, maxDepth);
      const total = self * 1.05 + foe;   /* 略偏防守优先一点 */
      if (total > bestScore) { bestScore = total; best = { x, y }; }
    }
  }
  return best || { x: 7, y: 7 };
}

function nearStone(board, x, y, r) {
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const nx = x + dx, ny = y + dy;
      if (inBounds(nx, ny) && board[idx(nx, ny)] !== EMPTY) return true;
    }
  }
  return false;
}

/** 给「在某点落子后」这一方的连线潜力打分。 */
function scorePoint(board, x, y, stone, depth) {
  let score = 0;
  for (const [dx, dy] of DIRS) {
    /* 把这条轴上的同色连珠数出来 */
    let n = 1;
    let openEnds = 0;
    let cx = x + dx, cy = y + dy;
    while (inBounds(cx, cy) && board[idx(cx, cy)] === stone) { n++; cx += dx; cy += dy; }
    if (inBounds(cx, cy) && board[idx(cx, cy)] === EMPTY) openEnds++;
    cx = x - dx; cy = y - dy;
    while (inBounds(cx, cy) && board[idx(cx, cy)] === stone) { n++; cx -= dx; cy -= dy; }
    if (inBounds(cx, cy) && board[idx(cx, cy)] === EMPTY) openEnds++;
    if (n >= 5) score += 1000000;
    else if (n === 4) score += openEnds >= 2 ? 100000 : 8000;
    else if (n === 3) score += openEnds >= 2 ? 8000 : 500;
    else if (n === 2) score += openEnds >= 2 ? 500 : 60;
    else score += 10;
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
 * @param {Array<{x:number,y:number,stone:number}>} actions
 */
export function replay(actions) {
  let board = emptyBoard();
  let winner = EMPTY;
  let line = [];
  for (const a of actions || []) {
    const r = place(board, a.x, a.y, a.stone);
    if (!r.ok) break;
    board = r.board;
    if (r.winner) { winner = r.winner; line = r.line; break; }
  }
  return { board, winner, line, actions: (actions || []).slice() };
}

/** 胜负判定包装：给定棋盘与最后一手，返回是否已终局。 */
export function evaluate(board) {
  /* 从头扫一遍找有没有五连 —— 棋盘小，直接扫比记录最后一手更稳。 */
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const s = board[idx(x, y)];
      if (s === EMPTY) continue;
      for (const [dx, dy] of DIRS) {
        let n = 1;
        let cx = x + dx, cy = y + dy;
        while (inBounds(cx, cy) && board[idx(cx, cy)] === s) { n++; cx += dx; cy += dy; }
        if (n >= 5) return { over: true, winner: s, line: [[x, y]] };
      }
    }
  }
  return { over: false, winner: EMPTY, line: [] };
}
