import { IDS, at, DRAGON_LINES, other, allMoves, captureChoices } from './rules.mjs';

/** 待吃子但对方没有可吃的子（对方全在龙里）→ 跳过这一步吃子 */
const SKIP = Symbol('skip');

/* ================= 龙凤棋 · 搜索型 AI =================
 * 原先是「见到成龙点就占，否则随机走子」，中盘基本等于随机。
 * 这里换成迭代加深 α–β 搜索：吃子优先 + 机动性 + 龙形潜在成线 + 位置势能，
 * 保留 easy / normal / hard 三档（hard 深度 6、时间上限 900ms）。
 * 纯函数、零 DOM，Node 可直接单测与自对弈。
 */

const SIDE_VAL = 1000;      /* 一子价值 */
const DRAGON_VAL = 130;     /* 已成龙的每子额外价值（不可被吃，等于半条命） */
const THREAT_VAL = 45;      /* 双联一线的潜在成龙点 */
const MOBILITY_VAL = 2.2;   /* 每多一步走法的价值 */
const CENTER_VAL = 3;       /* 越靠内圈越有价值（视野大、可打炮） */

const PT = (id) => at(id);

/** 局面评分（站在 side 视角） */
function evaluate(s, side) {
  const foe = other(side);
  let score = 0;
  let myPieces = 0, foePieces = 0;
  for (const id of IDS) {
    const v = s.board[id];
    if (!v) continue;
    if (v === side) myPieces++; else foePieces++;
  }
  score += (myPieces - foePieces) * SIDE_VAL;

  /* 龙：已成龙的子不可被吃，价值更高 */
  for (const line of DRAGON_LINES) {
    const mine = line.ids.every((id) => s.board[id] === side);
    const theirs = line.ids.every((id) => s.board[id] === foe);
    if (mine) score += DRAGON_VAL * 3;
    if (theirs) score -= DRAGON_VAL * 3;
  }

  /* 潜在成线：两子一线且第三点空着 */
  for (const line of DRAGON_LINES) {
    let mine = 0, theirs = 0, empty = 0;
    for (const id of line.ids) {
      if (s.board[id] === side) mine++;
      else if (s.board[id] === foe) theirs++;
      else empty++;
    }
    if (empty === 1) {
      if (mine === 2) score += THREAT_VAL;
      if (theirs === 2) score -= THREAT_VAL * 1.15;  /* 该堵的稍微更贵 */
    }
  }

  /* 位置：内圈优先 */
  for (const id of IDS) {
    const v = s.board[id];
    if (!v) continue;
    const p = PT(id);
    const ring = Math.max(Math.abs(p.x), Math.abs(p.y));
    const bonus = (4 - ring) * CENTER_VAL;
    score += v === side ? bonus : -bonus;
  }

  /* 机动性 */
  const myMob = allMoves(s, side).length;
  const foeMob = allMoves(s, foe).length;
  score += (myMob - foeMob) * MOBILITY_VAL;
  return score;
}

/** 按「有吃子 → 有威胁 → 其余」排序，提高剪枝效率 */
function orderMoves(s, side, moves) {
  const foe = other(side);
  const scored = moves.map((m) => {
    let v = 0;
    if (m.cannon) v += 900;
    for (const line of DRAGON_LINES) {
      if (!line.ids.includes(m.to)) continue;
      let mine = 0, empty = 0, theirs = 0;
      for (const id of line.ids) {
        if (id === m.to) { mine++; continue; }
        if (s.board[id] === side) mine++;
        else if (s.board[id] === foe) theirs++;
        else empty++;
      }
      if (mine === 3) v += 700;
      if (mine === 2 && empty === 1) v += 220;
      if (theirs === 2 && empty === 1 && mine === 1) v += 260; /* 堵点 */
    }
    const p = PT(m.to);
    v += (4 - Math.max(Math.abs(p.x), Math.abs(p.y))) * 4;
    return { m, v };
  });
  scored.sort((a, b) => b.v - a.v);
  return scored.map((x) => x.m);
}

/** 走一步用于搜索的「干净」模拟：不写 history，不算耗时日志 */
function applySim(s, side, m) {
  const prevBoard = s.board;
  const board = { ...prevBoard };
  if (m.cannon) { delete board[m.from]; board[m.to] = side; delete board[m.eaten]; }
  else { delete board[m.from]; board[m.to] = side; }
  const placed = { ...s.placed };
  const step = s.step;
  s.board = board;
  s.placed = placed;
  s.step = step;
  return prevBoard;
}

function restore(s, prevBoard) { s.board = prevBoard; }

function negamax(s, side, depth, alpha, beta, deadline, registered) {
  if (performance.now() > deadline) return { score: evaluate(s, side), aborted: true };
  if (depth <= 0) return { score: evaluate(s, side) };

  const moves = allMoves(s, side);
  if (!moves.length) return { score: -SIDE_VAL * 8 };   /* 无子可动 ≈ 输 */

  let best = -Infinity;
  for (const m of orderMoves(s, side, moves)) {
    const prev = applySim(s, side, m);
    const dragonsJustMade = DRAGON_LINES.some((line) => line.ids.every((id) => s.board[id] === side)
      && !registered.has(`${side}:${line.key}`));
    const res = negamax(s, other(side), depth - 1, -beta, -alpha, deadline, registered);
    restore(s, prev);
    if (res.aborted) return res;
    let sc = -res.score;
    if (dragonsJustMade) sc += DRAGON_VAL;             /* 立刻成龙吃子，马上兑现 */
    if (sc > best) best = sc;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return { score: best };
}

/** 记「本步结束后」的强度：用于生成前若干候选，好让 UI 给玩家一个强弱提示 */
function rootRanking(s, side, moves, depth, budget) {
  const deadline = performance.now() + budget;
  const list = [];
  for (const m of orderMoves(s, side, moves)) {
    const prev = applySim(s, side, m);
    const res = negamax(s, other(side), depth - 1, -Infinity, Infinity, deadline, new Set(s.dragons));
    restore(s, prev);
    if (res.aborted) break;
    list.push({ move: m, score: -res.score });
  }
  list.sort((a, b) => b.score - a.score);
  return list;
}

/** 档位：easy 浅搜 + 噪声（会犯错），normal 3 层，hard 迭代加深 6 层 900ms */
const LEVELS = {
  easy: { depth: 2, budget: 120, noise: 260 },
  normal: { depth: 3, budget: 380, noise: 40 },
  hard: { depth: 5, budget: 420, noise: 0 },
};

/** 对外：选一步棋。
 * 返回 { move } 或 { place }（布子阶段）或 { capture }（待吃子）。 */
export { SKIP };

export function aiSearch(s, level = 'normal', rng = Math.random) {
  const cfg = LEVELS[level] ?? LEVELS.normal;
  const side = s.turn;

  if (s.pendingCapture) {
    const cs = s.pendingCapture.choices ?? captureChoices(s, s.pendingCapture.owner);
    if (!cs.length) return { capture: SKIP };
    /* 吃哪颗最疼：优先吃「对方唯一的大龙子」或内圈核心子 */
    const ranked = cs.slice().sort((a, b) => scoreOfCell(s, other(side), b) - scoreOfCell(s, other(side), a));
    return { capture: ranked[0] };
  }

  if (s.phase === 'place') {
    const empty = IDS.filter((id) => !s.board[id]);
    if (!empty.length) return { place: null };
    /* 布子阶段用「落子后评估」，等价于一层搜索，能同时兼顾成龙与堵点 */
    /* easy 档：先看有没有成龙点，有就从中随机，制造「AI 也会错过堵点」的观感 */
    const winPts = winningPointsOf(s, side);
    if (cfg.noise >= 200 && winPts.length && rng() < 0.55) return { place: winPts[Math.floor(rng() * winPts.length)] };

    let best = null, bestScore = -Infinity;
    for (const id of empty) {
      const board = { ...s.board };
      board[id] = side;
      const prev = s.board;
      s.board = board;
      const dragonsNow = DRAGON_LINES.filter((line) => line.ids.every((x) => board[x] === side)).length;
      let sc = evaluate(s, side) + dragonsNow * 160;
      s.board = prev;
      sc += (rng() - 0.5) * cfg.noise;
      if (sc > bestScore) { bestScore = sc; best = id; }
    }
    return { place: best };
  }

  const moves = allMoves(s, side);
  if (!moves.length) return { move: null };

  /* 迭代加深：从 2 层起步，时间用完就用上一层的结果 */
  const deadline = performance.now() + cfg.budget;
  let bestMove = null;
  let bestScore = -Infinity;
  for (let d = 2; d <= cfg.depth; d++) {
    if (performance.now() > deadline && bestMove) break;
    const ranked = rootRanking(s, side, moves, d, Math.max(40, deadline - performance.now()));
    if (!ranked.length) break;
    /* 噪声让低难度会犯错，但绝不故意走「送死」的一步 */
    let pick = ranked[0];
    if (cfg.noise > 0) {
      const pool = ranked.filter((x) => x.score >= ranked[0].score - cfg.noise);
      pick = pool[Math.floor(rng() * pool.length)] ?? ranked[0];
    }
    bestMove = pick.move;
    bestScore = pick.score;
    if (performance.now() >= deadline) break;
  }
  return { move: bestMove, score: bestScore };
}

/** 我方两子占一线、第三点空着、且这条线还没成龙 → 成龙点 */
function winningPointsOf(s, side) {
  const out = [];
  for (const line of DRAGON_LINES) {
    const mine = line.ids.filter((id) => s.board[id] === side).length;
    const empty = line.ids.filter((id) => !s.board[id]);
    if (mine === 2 && empty.length === 1 && !s.dragons?.includes(`${side}:${line.key}`)) out.push(empty[0]);
  }
  return out;
}

function scoreOfCell(s, side, id) {
  const p = PT(id);
  let v = (4 - Math.max(Math.abs(p.x), Math.abs(p.y))) * 2;
  for (const line of DRAGON_LINES) {
    if (!line.ids.includes(id)) continue;
    const mine = line.ids.filter((x) => s.board[x] === side).length;
    if (mine >= 2) v += 30;
  }
  return v;
}

/** 给 UI 用：当前局面我方最佳的 3 步（提示功能） */
export function aiHints(s, level = 'normal') {
  if (s.phase !== 'move' || s.winner || s.pendingCapture) return [];
  const side = s.turn;
  const moves = allMoves(s, side);
  if (!moves.length) return [];
  const cfg = LEVELS[level] ?? LEVELS.normal;
  const ranked = rootRanking(s, side, moves, Math.min(3, cfg.depth), cfg.budget);
  return ranked.slice(0, 3).map((x) => ({ from: x.move.from, to: x.move.to, score: Math.round(x.score) }));
}
