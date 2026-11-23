/**
 * 龙凤棋 · 龙棋 —— 纯规则核心（第三批任务块 I）
 * 规则出处：麻城市人民政府收录的民间棋「龙棋」
 *          http://www.mc.gov.cn/mlmc/whmc/msfq/10466903.html
 *
 * 纯逻辑、零 DOM / Canvas，Node 可直接单测。
 * 棋盘 24 点 = 三层同心正方形 × 每层 8 点（4 角 + 4 边中点）。
 * 坐标用整数：外层次 s=3 / 中层 s=2 / 内层 s=1，保证三层等距（打炮需要等距四点）。
 */

/** 点 id 命名：<层>-<方位>，tl/tm/tr/ml/mr/bl/bm/br */
const LAYERS = [['outer', 3], ['mid', 2], ['inner', 1]];
const DIRS = [
  ['tl', -1, 1], ['tm', 0, 1], ['tr', 1, 1],
  ['ml', -1, 0], ['mr', 1, 0],
  ['bl', -1, -1], ['bm', 0, -1], ['br', 1, -1],
];

export const POINTS = [];
const POINT_BY_ID = {};
for (const [layer, s] of LAYERS) {
  for (const [dir, dx, dy] of DIRS) {
    const p = { id: `${layer}-${dir}`, layer, dir, x: dx * s, y: dy * s };
    POINTS.push(p);
    POINT_BY_ID[p.id] = p;
  }
}
export const IDS = POINTS.map((p) => p.id);
export const at = (id) => POINT_BY_ID[id] ?? null;

/** 连线：每层正方形 8 条边 + 8 个方向的径向线各 2 段 = 40 条 */
export const EDGES = [];
function edge(a, b) {
  if (!POINT_BY_ID[a] || !POINT_BY_ID[b]) return;
  const key = [a, b].sort().join('~');
  if (!EDGES.some((e) => e.key === key)) EDGES.push({ key, a, b });
}
for (const [layer] of LAYERS) {
  const ring = ['tl', 'tm', 'tr', 'mr', 'br', 'bm', 'bl', 'ml'];
  for (let i = 0; i < ring.length; i++) edge(`${layer}-${ring[i]}`, `${layer}-${ring[(i + 1) % ring.length]}`);
}
for (const [dir] of DIRS) {
  edge(`outer-${dir}`, `mid-${dir}`);
  edge(`mid-${dir}`, `inner-${dir}`);
}
export const NEIGHBORS = (() => {
  const m = {};
  for (const id of IDS) m[id] = [];
  for (const e of EDGES) { m[e.a].push(e.b); m[e.b].push(e.a); }
  return m;
})();

/**
 * 龙线组：只取横 / 竖方向（不含斜线）上相邻的三点。
 * x 或 y 相同的点按另一坐标排序，连续 3 个即一条可成龙直线。
 */
export const DRAGON_LINES = (() => {
  const lines = [];
  const seen = new Set();
  const addRun = (run) => {
    for (let i = 0; i + 2 < run.length; i++) {
      const ids = run.slice(i, i + 3).map((p) => p.id).sort();
      const key = ids.join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push({ key, ids });
    }
  };
  for (const x of [...new Set(POINTS.map((p) => p.x))]) {
    addRun(POINTS.filter((p) => p.x === x).sort((a, b) => a.y - b.y));
  }
  for (const y of [...new Set(POINTS.map((p) => p.y))]) {
    addRun(POINTS.filter((p) => p.y === y).sort((a, b) => a.x - b.x));
  }
  return lines;
})();

export const other = (side) => (side === 'r' ? 'b' : 'r');
/* 克隆只保留棋盘状态，history 单独剔除 —— 原先整对象 JSON 化会把 history 一起深拷贝，
   历史一长就是指数级膨胀，几十手后直接 RangeError: Invalid string length */
export const clone = (s) => {
  const out = {};
  for (const k of Object.keys(s)) if (k !== 'history') out[k] = s[k];
  return JSON.parse(JSON.stringify(out));
};
const MAX_HISTORY = 60;

/** 新局：phase=place，双方各 9 子，红先。 */
export function createGame(seed = 0) {
  return {
    phase: 'place', turn: 'r', board: {}, placed: { r: 0, b: 0 },
    dragons: [], noCapture: 0, step: 0, winner: null, endReason: null,
    pendingCapture: null, seed, history: [],
  };
}

/** 该方当前棋子数 */
export function countPieces(s, side) {
  return Object.values(s.board).filter((v) => v === side).length;
}

/** 某方在当前盘面已成的龙（未排除「始龙」记录，用于保护判断） */
export function dragonsNow(s, side) {
  return DRAGON_LINES.filter((line) => line.ids.every((id) => s.board[id] === side));
}

/** 该子是否属于一条已成的龙（不得被吃） */
export function isDragonPiece(s, id) {
  const side = s.board[id];
  if (!side) return false;
  return dragonsNow(s, side).some((line) => line.ids.includes(id));
}

/** 已登记的「始龙」键：同一组合不能反复成龙 */
export function dragonKey(line, side) { return `${side}:${line.key}`; }

/** 新成的龙（盘面上成龙、但尚未登记过的） */
function freshDragons(s, side) {
  return dragonsNow(s, side).filter((line) => !s.dragons.includes(dragonKey(line, side)));
}

/** 可Placement：布子阶段任何空点 */
export function canPlace(s, id) {
  return s.phase === 'place' && !s.winner && !!POINT_BY_ID[id] && !s.board[id] && !s.pendingCapture;
}

/**
 * 落子。返回 { ok, dragons:[line], needCapture:boolean }
 * 成龙即登记为「始龙」，并进入待吃子状态（不得吃对方已成龙的子）。
 */
export function place(s, id) {
  if (!canPlace(s, id)) return { ok: false, reason: 'illegal-place' };
  s.history.push(clone(s));
  if (s.history.length > MAX_HISTORY) s.history.splice(0, s.history.length - MAX_HISTORY);
  s.board[id] = s.turn;
  s.placed[s.turn] += 1;
  s.step += 1;
  const fresh = freshDragons(s, s.turn);
  for (const line of fresh) s.dragons.push(dragonKey(line, s.turn));
  if (fresh.length) {
    const choices = captureChoices(s, s.turn);
    s.pendingCapture = { owner: s.turn, reason: 'dragon', choices };
  }
  /* 关键：落子后要换手。原先这里漏了 finishTurn，整局卡在红方——AI 永远没机会出手 */
  if (!s.pendingCapture) finishTurn(s);
  else if (s.placed.r >= 9 && s.placed.b >= 9) s.phase = 'move';
  const end = checkEnd(s);
  return { ok: true, dragons: fresh.map((l) => l.ids), needCapture: !!s.pendingCapture, phase: s.phase, end };
}

/** 可被 side 吃掉的子：对方棋子中不属于任何已成龙的子 */
export function captureChoices(s, side) {
  return IDS.filter((id) => s.board[id] === other(side) && !isDragonPiece(s, id));
}

/** 执行成龙 / 打炮后的吃子；吃完才换手 */
export function capture(s, targetId) {
  if (!s.pendingCapture) return { ok: false, reason: 'no-pending' };
  const p = s.pendingCapture;
  if (s.board[targetId] !== other(p.owner)) return { ok: false, reason: 'not-enemy' };
  if (isDragonPiece(s, targetId)) return { ok: false, reason: 'dragon-protected' };
  s.history.push(clone(s));
  if (s.history.length > MAX_HISTORY) s.history.splice(0, s.history.length - MAX_HISTORY);
  delete s.board[targetId];
  s.noCapture = 0;
  s.pendingCapture = null;
  finishTurn(s);
  const end = checkEnd(s);
  return { ok: true, eaten: targetId, end };
}

/** 跳过吃子（没有合法目标时） */
function skipCapture(s) {
  if (!s.pendingCapture) return;
  s.pendingCapture = null;
  finishTurn(s);
  checkEnd(s);            /* 以前这里不结算胜负：无子可吃时空转，整局卡死在布子阶段 */
}

function finishTurn(s) {
  s.turn = other(s.turn);
  if (s.phase === 'place' && s.placed.r >= 9 && s.placed.b >= 9) s.phase = 'move';
  s.step += 1;
}

/** 总子数：满天飞 / 打炮的触发条件按「己方剩余子数」判定 */
export function isSkyMode(s, side = s.turn) { return countPieces(s, other(side)) + countPieces(s, side) <= 3; }
export function isCannonMode(s, side = s.turn) { return countPieces(s, side) === 2; }

/** 打炮走法：对方 1 子在线一端、己方 1 子在同线中间，另一己方子飞到该线另一端。
 *  另一端 = 中间子关于对方子的对称点（2×mid - foe），必须为空。 */
export function cannonMoves(s, side = s.turn) {
  const out = [];
  if (!isCannonMode(s, side)) return out;
  const mine = IDS.filter((id) => s.board[id] === side).map(at);
  const foes = IDS.filter((id) => s.board[id] === other(side) && !isDragonPiece(s, id)).map(at);
  for (const foe of foes) {
    for (const mid of mine) {
      const tx = 2 * mid.x - foe.x;
      const ty = 2 * mid.y - foe.y;
      const target = POINTS.find((p) => p.x === tx && p.y === ty);
      if (!target || s.board[target.id]) continue;
      for (const far of mine) {
        if (far.id === mid.id || far.id === target.id) continue;
        out.push({ from: far.id, to: target.id, cannon: true, eaten: foe.id, via: mid.id });
      }
    }
  }
  return out;
}

/** 合法走法（走子阶段）。普通走法只到空点；斜线只走不吃。 */
export function legalMoves(s, id, side = s.turn) {
  if (s.phase !== 'move' || s.winner || s.pendingCapture) return [];
  if (s.board[id] !== side) return [];
  const cannons = cannonMoves(s, side).filter((m) => m.from === id);
  if (cannons.length) return cannons;
  if (isSkyMode(s, side)) {
    return IDS.filter((p) => !s.board[p]).map((p) => ({ from: id, to: p, sky: true }));
  }
  return NEIGHBORS[id].filter((p) => !s.board[p]).map((p) => ({ from: id, to: p }));
}

export function allMoves(s, side = s.turn) {
  if (s.phase !== 'move') return [];
  const out = [];
  for (const id of IDS) if (s.board[id] === side) out.push(...legalMoves(s, id, side));
  return out;
}

/** 走子。吃子仅在打炮（含成龙额外吃子）时发生。 */
export function move(s, from, to) {
  const m = legalMoves(s, from).find((x) => x.to === to);
  if (!m) return { ok: false, reason: 'illegal-move' };
  s.history.push(clone(s));
  if (s.history.length > MAX_HISTORY) s.history.splice(0, s.history.length - MAX_HISTORY);
  delete s.board[from];
  s.board[to] = s.turn;
  if (m.cannon) {
    delete s.board[m.eaten];
    s.noCapture = 0;
  } else {
    s.noCapture += 1;
  }
  const fresh = freshDragons(s, s.turn);
  for (const line of fresh) s.dragons.push(dragonKey(line, s.turn));
  if (fresh.length) {
    s.pendingCapture = { owner: s.turn, reason: 'dragon', choices: captureChoices(s, s.turn) };
  }
  if (!s.pendingCapture) finishTurn(s);
  const end = checkEnd(s);
  return { ok: true, move: m, dragons: fresh.map((l) => l.ids), needCapture: !!s.pendingCapture, end };
}

/** 胜负：吃光 / 无合法走法且无法成龙 / 60 回合无吃子 */
export function checkEnd(s) {
  if (s.pendingCapture) return null;
  /* 只有布子结束、进入走子阶段才存在「吃光对方」；布子时盘上本来就可能没子，
     无条件判会让空棋盘直接判负（整局第一手就结束） */
  for (const side of (s.phase === 'move' ? ['r', 'b'] : [])) {
    if (countPieces(s, side) === 0) {
      s.winner = other(side); s.endReason = 'eliminate'; return { winner: s.winner, reason: s.endReason };
    }
  }
  if (s.noCapture >= 60) {
    s.winner = 'draw'; s.endReason = 'no-capture'; return { winner: 'draw', reason: s.endReason };
  }
  if (s.phase === 'move') {
    for (const side of ['r', 'b']) {
      if (allMoves(s, side).length === 0) {
        s.winner = other(side); s.endReason = 'immobile'; return { winner: s.winner, reason: s.endReason };
      }
    }
  }
  return null;
}

/** 悔棋一步（含成龙 / 吃子前状态） */
export function undo(s) {
  const prev = s.history.pop();
  if (!prev) return false;
  for (const k of Object.keys(s)) delete s[k];
  Object.assign(s, prev);
  return true;
}

/* ---------------- AI ---------------- */
function rngOf(fn) { return typeof fn === 'function' ? fn : Math.random; }

/** 对方两子已经占住某条龙线的两点且第三点为空 → 堵点 */
function blockingPoints(s, side) {
  const foe = other(side);
  const pts = [];
  for (const line of DRAGON_LINES) {
    const mine = line.ids.filter((id) => s.board[id] === side).length;
    const theirs = line.ids.filter((id) => s.board[id] === foe).length;
    const empty = line.ids.filter((id) => !s.board[id]);
    if (theirs === 2 && mine === 0 && empty.length === 1
        && !s.dragons.includes(dragonKey(line, foe))) pts.push(empty[0]);
  }
  return pts;
}

/** 我方两子占一线、第三点为空 → 成龙点 */
function winningPoints(s, side) {
  const pts = [];
  for (const line of DRAGON_LINES) {
    const mine = line.ids.filter((id) => s.board[id] === side).length;
    const empty = line.ids.filter((id) => !s.board[id]);
    if (mine === 2 && empty.length === 1 && !s.dragons.includes(dragonKey(line, side))) pts.push(empty[0]);
  }
  return pts;
}

/** AI：easy 随机 + 见到成龙点就占；hard 先堵对方成龙，再算自己成龙吃子。 */
export function aiDecision(s, level = 'easy', rng = Math.random) {
  const rnd = rngOf(rng);
  const side = s.turn;
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)] ?? null;

  if (s.pendingCapture) {
    const cs = s.pendingCapture.choices ?? captureChoices(s, s.pendingCapture.owner);
    return { kind: 'capture', target: pick(cs) };
  }

  if (s.phase === 'place') {
    const empty = IDS.filter((id) => !s.board[id]);
    const winPts = winningPoints(s, side);
    const blockPts = level === 'hard' ? blockingPoints(s, side) : [];
    const target = (level === 'hard' && pick(blockPts)) || pick(winPts) || pick(empty);
    return { kind: 'place', id: target };
  }

  const moves = allMoves(s, side);
  if (!moves.length) return { kind: 'pass' };
  const cannons = moves.filter((m) => m.cannon);
  if (cannons.length) return { kind: 'move', ...pick(cannons) };

  const winning = moves.filter((m) => winningPoints(s, side).includes(m.to));
  if (winning.length) return { kind: 'move', ...pick(winning) };
  if (level === 'hard') {
    const blocking = moves.filter((m) => blockingPoints(s, side).includes(m.to));
    if (blocking.length) return { kind: 'move', ...pick(blocking) };
  }
  return { kind: 'move', ...pick(moves) };
}

/** 一键执行 AI 决策（含连续处理待吃子），供自对弈使用 */
export function aiPlay(s, level = 'easy', rng = Math.random) {
  const d = aiDecision(s, level, rng);
  if (d.kind === 'place') return place(s, d.id);
  if (d.kind === 'move') return move(s, d.from, d.to);
  if (d.kind === 'capture') return d.target ? capture(s, d.target) : (skipCapture(s), { ok: true });
  return { ok: false, reason: 'no-action' };
}

/** 自对弈：返回终局摘要，供 20 局零异常验收 */
export function selfPlay(levelA = 'easy', levelB = 'hard', seed = 1) {
  let x = seed >>> 0 || 1;
  const rng = () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; };
  const s = createGame(seed);
  let guard = 0;
  while (!s.winner && guard++ < 600) {
    if (s.pendingCapture && !s.pendingCapture.choices?.length) { skipCapture(s); checkEnd(s); continue; }
    const level = s.pendingCapture ? s.pendingCapture.owner : s.turn;
    const r = aiPlay(s, level === 'r' ? levelA : levelB, rng);
    if (!r?.ok && r?.reason !== 'no-action') throw new Error(`自对弈异常: ${JSON.stringify(r)}`);
    if (s.pendingCapture && !s.pendingCapture.choices?.length) { skipCapture(s); checkEnd(s); }
  }
  if (!s.winner) { s.winner = 'draw'; s.endReason = 'step-limit'; }
  return { winner: s.winner, reason: s.endReason, steps: s.step, pieces: {
    r: countPieces(s, 'r'), b: countPieces(s, 'b'),
  }, guard };
}

export { skipCapture, finishTurn };
