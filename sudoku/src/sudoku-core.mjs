/**
 * 《数独速递》纯逻辑核心 —— 生成、解题器、唯一解校验、铅笔笔记。
 * 不碰 DOM / localStorage。浏览器 <script type=module> 引入，Node 直接单测。
 */

/** 确定性 PRNG（mulberry32） */
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hashSeed(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export const DIFFICULTY = Object.freeze({
  easy: { key: '4', n: 9, boxW: 3, boxH: 3, blanks: 45, label: '简单', hints: 5 },
  medium: { key: '5', n: 9, boxW: 3, boxH: 3, blanks: 52, label: '中等', hints: 4 },
  hard: { key: '6', n: 9, boxW: 3, boxH: 3, blanks: 56, label: '困难', hints: 3 },
  expert: { key: '7', n: 9, boxW: 3, boxH: 3, blanks: 58, label: '专家', hints: 2 },
});

/** 宫序号 */
export function boxOf(r, c, cfg) { return Math.floor(r / cfg.boxH) * (cfg.n / cfg.boxW) + Math.floor(c / cfg.boxW); }

/** 该盘在 (r,c) 填 v 是否合法 */
export function canPlace(board, r, c, v, cfg) {
  const n = cfg.n;
  for (let i = 0; i < n; i++) {
    if (board[r * n + i] === v && i !== c) return false;
    if (board[i * n + c] === v && i !== r) return false;
  }
  const br = Math.floor(r / cfg.boxH) * cfg.boxH, bc = Math.floor(c / cfg.boxW) * cfg.boxW;
  for (let i = 0; i < cfg.boxH; i++) for (let j = 0; j < cfg.boxW; j++) {
    const rr = br + i, cc = bc + j;
    if ((rr !== r || cc !== c) && board[rr * n + cc] === v) return false;
  }
  return true;
}

/** 解题器：统计解的数量，最多数到 limit 即停（默认 2，够判唯一） */
export function countSolutions(board, cfg, limit = 2) {
  const n = cfg.n, size = n * n;
  const b = board.slice();
  let count = 0;
  // 候选位掩码
  const rowMask = new Array(n).fill(0), colMask = new Array(n).fill(0), boxMask = new Array(n).fill(0);
  const FULL = (1 << n) - 1;
  for (let i = 0; i < size; i++) {
    const v = b[i]; if (!v) continue;
    const r = (i / n) | 0, c = i % n, bit = 1 << (v - 1), bx = boxOf(r, c, cfg);
    if ((rowMask[r] & bit) || (colMask[c] & bit) || (boxMask[bx] & bit)) return 0; // 已冲突
    rowMask[r] |= bit; colMask[c] |= bit; boxMask[bx] |= bit;
  }
  function dfs() {
    if (count >= limit) return;
    // 找候选最少的空格（MRV）
    let best = -1, bestMask = 0, bestCnt = 99;
    for (let i = 0; i < size; i++) {
      if (b[i]) continue;
      const r = (i / n) | 0, c = i % n, bx = boxOf(r, c, cfg);
      const mask = FULL & ~(rowMask[r] | colMask[c] | boxMask[bx]);
      let cnt = 0, m = mask;
      while (m) { m &= m - 1; cnt++; }
      if (cnt < bestCnt) { bestCnt = cnt; best = i; bestMask = mask; if (cnt <= 1) break; }
    }
    if (best === -1) { count++; return; } // 填满 = 一个解
    if (bestCnt === 0) return;
    const r = (best / n) | 0, c = best % n, bx = boxOf(r, c, cfg);
    let m = bestMask;
    while (m) {
      const bit = m & -m; m -= bit;
      const v = 31 - Math.clz32(bit) + 1;
      b[best] = v; rowMask[r] |= bit; colMask[c] |= bit; boxMask[bx] |= bit;
      dfs();
      b[best] = 0; rowMask[r] &= ~bit; colMask[c] &= ~bit; boxMask[bx] &= ~bit;
      if (count >= limit) return;
    }
  }
  dfs();
  return count;
}

export function isUnique(board, cfg) { return countSolutions(board, cfg, 2) === 1; }

/** 生成一个完整解（随机化回溯） */
function fullSolution(cfg, rand) {
  const n = cfg.n, b = new Array(n * n).fill(0);
  const FULL = (1 << n) - 1;
  const rowMask = new Array(n).fill(0), colMask = new Array(n).fill(0), boxMask = new Array(n).fill(0);
  function dfs(k) {
    if (k === n * n) return true;
    const r = (k / n) | 0, c = k % n, bx = boxOf(r, c, cfg);
    let mask = FULL & ~(rowMask[r] | colMask[c] | boxMask[bx]);
    const vals = [];
    while (mask) { const bit = mask & -mask; mask -= bit; vals.push(bit); }
    // 洗牌
    for (let i = vals.length - 1; i > 0; i--) { const j = (rand() * (i + 1)) | 0; const t = vals[i]; vals[i] = vals[j]; vals[j] = t; }
    for (const bit of vals) {
      const v = 31 - Math.clz32(bit) + 1;
      b[k] = v; rowMask[r] |= bit; colMask[c] |= bit; boxMask[bx] |= bit;
      if (dfs(k + 1)) return true;
      b[k] = 0; rowMask[r] &= ~bit; colMask[c] &= ~bit; boxMask[bx] &= ~bit;
    }
    return false;
  }
  dfs(0);
  return b;
}

/**
 * 生成唯一解数独。目标空数 blanks；挖空时每挖一格校验仍唯一，保证解数恰好 1。
 * 返回 { puzzle, solution, seed, blanks, unique:true }
 */
export function generate(seed, cfg = DIFFICULTY.easy) {
  // 挖空到目标数受具体完整解限制（不是每个解都能挖到 58）；换若干次完整解重试。
  let best = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    const rand = rng((seed + attempt * 104729) >>> 0);
    const solution = fullSolution(cfg, rand);
    const puzzle = solution.slice();
    const n = cfg.n, size = n * n;
    const order = Array.from({ length: size }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) { const j = (rand() * (i + 1)) | 0; const t = order[i]; order[i] = order[j]; order[j] = t; }
    let blanks = 0;
    for (const idx of order) {
      if (blanks >= cfg.blanks) break;
      const saved = puzzle[idx];
      puzzle[idx] = 0;
      if (isUnique(puzzle, cfg)) blanks++;
      else puzzle[idx] = saved;
    }
    const result = { puzzle, solution, seed, blanks, unique: isUnique(puzzle, cfg) };
    if (!best || blanks > best.blanks) best = result;
    if (blanks >= cfg.blanks) return result; // 达标即返回（保持确定性）
  }
  return best;
}

/** 给定正式数字后，清除同行/同列/同宫的该候选笔记 */
export function clearPeerNotes(notes, index, value, cfg) {
  const n = cfg.n, r = (index / n) | 0, c = index % n;
  const out = notes.map((a) => a ? a.slice() : []);
  for (let i = 0; i < n * n; i++) {
    if (i === index) continue;
    const rr = (i / n) | 0, cc = i % n;
    if (rr === r || cc === c || boxOf(rr, cc, cfg) === boxOf(r, c, cfg)) {
      out[i] = out[i].filter((v) => v !== value);
    }
  }
  out[index] = [];
  return out;
}

/** 检查某格填入是否与已有数字冲突（ UI 填错标红用，不判负） */
export function isWrong(board, index, solution, cfg) {
  const v = board[index];
  return v > 0 && v !== solution[index];
}

/** 盘面是否已全部正确填满 */
export function isSolved(board, solution) {
  return board.length === solution.length && board.every((v, i) => v === solution[i]);
}

if (typeof globalThis !== 'undefined') globalThis.SudokuCore = {
  rng, hashSeed, DIFFICULTY, boxOf, canPlace, countSolutions, isUnique, generate, clearPeerNotes, isWrong, isSolved,
};
