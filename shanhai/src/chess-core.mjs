/**
 * 《山海拾遗 · 棋艺》核心 —— 纯逻辑，不碰 DOM、不读 localStorage、不碰 Canvas。
 *
 * 为什么把规则全放这里：界面层（chess-ui.mjs）只负责“把状态画出来 / 把手势翻译成动作”，
 * 这样 node 测试可以直接验证走子、吃子、胜负与 AI，不必开浏览器。
 *
 * 文件加载方式说明：
 *   浏览器在 file:// 下会以 CORS 拦截 type="module" 的本地脚本，而本作要求“双击也能玩”。
 *   因此浏览器端用普通 <script defer> 加载这个 .mjs，并挂到 globalThis.ShanhaiChessCore；
 *   Node 测试则用 import 执行同一份文件。仍然零构建、零依赖、零网络。
 */
(function attachChessCore(root) {
  'use strict';

  /* ── 基础工具 ───────────────────────────────────────────────────── */
  const other = (side) => (side === 'r' ? 'b' : 'r');
  const inB = (x, y, cols, rows) => x >= 0 && y >= 0 && x < cols && y < rows;
  const makeBoard = (cols, rows, fill) =>
    Array.from({ length: rows }, () => Array.from({ length: cols }, () => (fill ? fill() : null)));

  function cloneState(s) {
    const board = s.board.map((row) => row.map((c) => (c && typeof c === 'object' ? { ...c } : c)));
    const out = { ...s, board };
    delete out.passed;
    return out;
  }

  /* 棋子价值（同时服务象棋与暗棋；checkers / reversi 用各自的值）。 */
  const VAL = {
    general: 10000, chariot: 600, cannon: 300, horse: 270, advisor: 120,
    elephant: 120, soldier: 30, man: 100, king: 170, stone: 1,
  };

  /* ── 模式清单（UI 用来渲染入口） ──────────────────────────────────── */
  const MODES = [
    { id: 'xiangqi', name: '象棋', blurb: '楚河汉界，车马炮士象全。', players: 2, vsAI: true, cols: 9, rows: 10 },
    { id: 'gomoku', name: '五子棋', blurb: '十五路棋盘，先连五子者胜。', players: 2, vsAI: true, cols: 15, rows: 15 },
    { id: 'checkers', name: '跳棋', blurb: '西洋跳棋，斜行跳吃、到底成王。', players: 2, vsAI: true, cols: 8, rows: 8 },
    { id: 'banqi', name: '暗棋', blurb: '三十二子覆面，翻棋论高低。', players: 2, vsAI: true, cols: 8, rows: 4 },
    { id: 'reversi', name: '翻棋', blurb: '翻转棋：落子夹反，多者称雄。', players: 2, vsAI: true, cols: 8, rows: 8 },
  ];
  const MODE_BY_ID = Object.fromEntries(MODES.map((m) => [m.id, m]));

  /* ════════════════════════════════════════════════════════════════
   *  象棋（完整规则：将/士/象/马/车/炮/兵 + 蹩马腿/塞象眼/飞将/过河）
   * ════════════════════════════════════════════════════════════════ */
  function xiangqiSetup() {
    const cols = 9, rows = 10;
    const b = makeBoard(cols, rows, null);
    const back = ['chariot', 'horse', 'elephant', 'advisor', 'general', 'advisor', 'elephant', 'horse', 'chariot'];
    for (let x = 0; x < 9; x++) {
      b[0][x] = { side: 'b', kind: back[x] };
      b[9][x] = { side: 'r', kind: back[x] };
    }
    b[2][1] = { side: 'b', kind: 'cannon' }; b[2][7] = { side: 'b', kind: 'cannon' };
    b[7][1] = { side: 'r', kind: 'cannon' }; b[7][7] = { side: 'r', kind: 'cannon' };
    for (const x of [0, 2, 4, 6, 8]) {
      b[3][x] = { side: 'b', kind: 'soldier' };
      b[6][x] = { side: 'r', kind: 'soldier' };
    }
    return { mode: 'xiangqi', board: b, cols, rows, turn: 'r', status: 'playing', winner: null, lastMove: null, moveCount: 0 };
  }

  function inPalace(side, x, y) {
    if (x < 3 || x > 5) return false;
    return side === 'b' ? (y >= 0 && y <= 2) : (y >= 7 && y <= 9);
  }
  function crossedRiver(side, y) {
    return side === 'r' ? y <= 4 : y >= 5;
  }

  /* 返回某子的可达落点（含吃子），cap 表示“是否以吃子方式到达”。 */
  function xiangqiTargets(s, x, y) {
    const p = s.board[y][x];
    if (!p) return [];
    const side = p.side, cols = s.cols, rows = s.rows;
    const out = [];
    const at = (nx, ny) => (inB(nx, ny, cols, rows) ? s.board[ny][nx] : undefined);
    const push = (nx, ny) => {
      const q = at(nx, ny);
      if (!inB(nx, ny, cols, rows)) return;
      out.push({ x: nx, y: ny, cap: !!(q && q.side !== side), occ: !!q });
    };
    switch (p.kind) {
      case 'general':
        push(x, y - 1); push(x, y + 1); push(x - 1, y); push(x + 1, y);
        break;
      case 'advisor':
        for (const [dx, dy] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
          const nx = x + dx, ny = y + dy;
          if (inPalace(side, nx, ny)) push(nx, ny);
        }
        break;
      case 'elephant':
        for (const [dx, dy] of [[-2, -2], [-2, 2], [2, -2], [2, 2]]) {
          const nx = x + dx, ny = y + dy;
          if (!inB(nx, ny, cols, rows)) continue;
          if (crossedRiver(side, ny)) continue; // 象不能过河
          const mx = x + dx / 2, my = y + dy / 2;
          if (at(mx, my)) continue; // 塞象眼
          push(nx, ny);
        }
        break;
      case 'horse':
        for (const [dx, dy] of [[-1, -2], [1, -2], [-2, -1], [2, -1], [-1, 2], [1, 2], [-2, 1], [2, 1]]) {
          const nx = x + dx, ny = y + dy;
          if (!inB(nx, ny, cols, rows)) continue;
          const legX = Math.abs(dx) === 2 ? x + dx / 2 : x;
          const legY = Math.abs(dy) === 2 ? y + dy / 2 : y;
          if (at(legX, legY)) continue; // 蹩马腿
          push(nx, ny);
        }
        break;
      case 'chariot':
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          let nx = x + dx, ny = y + dy;
          while (inB(nx, ny, cols, rows)) {
            const q = at(nx, ny);
            if (!q) out.push({ x: nx, y: ny, cap: false, occ: false });
            else { out.push({ x: nx, y: ny, cap: q.side !== side, occ: true }); break; }
            nx += dx; ny += dy;
          }
        }
        break;
      case 'cannon':
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          let nx = x + dx, ny = y + dy, screen = false;
          while (inB(nx, ny, cols, rows)) {
            const q = at(nx, ny);
            if (!screen) {
              if (!q) out.push({ x: nx, y: ny, cap: false, occ: false });
              else screen = true;
            } else {
              if (q) { if (q.side !== side) out.push({ x: nx, y: ny, cap: true, occ: true }); break; }
            }
            nx += dx; ny += dy;
          }
        }
        break;
      case 'soldier': {
        const fwd = side === 'r' ? -1 : 1;
        push(x, y + fwd);
        if (crossedRiver(side, y)) { push(x - 1, y); push(x + 1, y); }
        break;
      }
    }
    return out;
  }

  function generalsFacing(s) {
    let rg = null, bg = null;
    for (let y = 0; y < s.rows; y++) for (let x = 0; x < s.cols; x++) {
      const c = s.board[y][x];
      if (c && c.kind === 'general') (c.side === 'r' ? (rg = [x, y]) : (bg = [x, y]));
    }
    if (!rg || !bg || rg[0] !== bg[0]) return false;
    const x = rg[0];
    const lo = Math.min(rg[1], bg[1]), hi = Math.max(rg[1], bg[1]);
    for (let y = lo + 1; y < hi; y++) if (s.board[y][x]) return false;
    return true;
  }

  function isAttacked(s, tx, ty, bySide) {
    for (let y = 0; y < s.rows; y++) for (let x = 0; x < s.cols; x++) {
      const c = s.board[y][x];
      if (!c || c.side !== bySide) continue;
      for (const t of xiangqiTargets(s, x, y)) {
        if (t.x === tx && t.y === ty && t.cap) return true;
      }
    }
    return false;
  }

  function xiangqiKingSafe(s, side) {
    let gx = -1, gy = -1;
    for (let y = 0; y < s.rows; y++) for (let x = 0; x < s.cols; x++) {
      const c = s.board[y][x];
      if (c && c.kind === 'general' && c.side === side) { gx = x; gy = y; }
    }
    if (gx < 0) return false; // 将已被吃
    if (generalsFacing(s)) return false;
    return !isAttacked(s, gx, gy, other(side));
  }

  function xiangqiActionsAt(s, x, y, side) {
    const p = s.board[y][x];
    if (!p || p.side !== side) return [];
    const targets = xiangqiTargets(s, x, y).filter((t) => {
      if (t.cap) return t.occ && s.board[t.y][t.x].side !== side;
      return !t.occ;
    });
    const out = [];
    for (const t of targets) {
      const ns = cloneState(s);
      ns.board[y][x] = null;
      ns.board[t.y][t.x] = p;
      if (!xiangqiKingSafe(ns, side)) continue;
      if (generalsFacing(ns)) continue;
      out.push({ from: [x, y], to: [t.x, t.y], capture: t.occ ? [t.x, t.y] : null });
    }
    return out;
  }

  /* ════════════════════════════════════════════════════════════════
   *  五子棋（15×15，先连五子者胜）
   * ════════════════════════════════════════════════════════════════ */
  function gomokuSetup() {
    const cols = 15, rows = 15;
    return { mode: 'gomoku', board: makeBoard(cols, rows, null), cols, rows, turn: 'r', status: 'playing', winner: null, lastMove: null, moveCount: 0 };
  }
  function gomokuWinAt(s, x, y, side) {
    const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (const [dx, dy] of dirs) {
      let count = 1;
      for (const sgn of [1, -1]) {
        let nx = x + dx * sgn, ny = y + dy * sgn;
        while (inB(nx, ny, s.cols, s.rows) && s.board[ny][nx] === side) { count++; nx += dx * sgn; ny += dy * sgn; }
      }
      if (count >= 5) return true;
    }
    return false;
  }
  function gomokuActionsAt(s, x, y) {
    if (s.board[y][x]) return [];
    return [{ to: [x, y] }];
  }

  /* ════════════════════════════════════════════════════════════════
   *  西洋跳棋（8×8，强制吃子，连跳，到底成王）
   * ════════════════════════════════════════════════════════════════ */
  function checkersSetup() {
    const cols = 8, rows = 8;
    const b = makeBoard(cols, rows, null);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      if ((x + y) % 2 !== 1) continue; // 只用深色格
      if (y <= 2) b[y][x] = { side: 'b', kind: 'man' };
      else if (y >= 5) b[y][x] = { side: 'r', kind: 'man' };
    }
    return { mode: 'checkers', board: b, cols, rows, turn: 'r', status: 'playing', winner: null, lastMove: null, moveCount: 0, noCap: 0 };
  }
  function checkersDirs(p) {
    return p.king ? [[-1, -1], [-1, 1], [1, -1], [1, 1]]
      : (p.side === 'r' ? [[-1, -1], [-1, 1]] : [[1, -1], [1, 1]]);
  }
  function checkersCaptures(board, cols, rows, x, y, piece) {
    const res = [];
    for (const [dy, dx] of checkersDirs(piece)) {
      const mx = x + dx, my = y + dy, jx = x + 2 * dx, jy = y + 2 * dy;
      if (!inB(jx, jy, cols, rows)) continue;
      const mid = board[my][mx], land = board[jy][jx];
      if (mid && mid.side !== piece.side && !land) {
        const nb = board.map((r) => r.slice());
        nb[y][x] = null; nb[my][mx] = null;
        const np = { ...piece };
        if ((np.side === 'r' && jy === 0) || (np.side === 'b' && jy === rows - 1)) np.king = true;
        nb[jy][jx] = np;
        const sub = checkersCaptures(nb, cols, rows, jx, jy, np);
        if (sub.length) for (const sq of sub) res.push({ path: [[x, y]].concat(sq.path), captures: [[mx, my]].concat(sq.captures), to: sq.to });
        else res.push({ path: [[x, y], [jx, jy]], captures: [[mx, my]], to: [jx, jy] });
      }
    }
    return res;
  }
  function checkersActionsAt(s, x, y, side) {
    const p = s.board[y][x];
    if (!p || p.side !== side) return [];
    const caps = checkersCaptures(s.board, s.cols, s.rows, x, y, p)
      .map((sq) => ({ from: [x, y], to: sq.to, path: sq.path, captures: sq.captures }));
    if (caps.length) return caps; // 有吃必吃
    const out = [];
    for (const [dy, dx] of checkersDirs(p)) {
      const nx = x + dx, ny = y + dy;
      if (!inB(nx, ny, s.cols, s.rows)) continue;
      if (!s.board[ny][nx]) out.push({ from: [x, y], to: [nx, ny] });
    }
    return out;
  }

  /* ════════════════════════════════════════════════════════════════
   *  暗棋（Banqi：8×4，三十二子覆面，翻棋按品级吃子）
   * ════════════════════════════════════════════════════════════════ */
  const BANQI_RANK = { general: 7, advisor: 6, elephant: 5, chariot: 4, horse: 3, cannon: 2, soldier: 1 };
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function banqiSetup(seed) {
    const cols = 8, rows = 4;
    const list = [];
    for (const side of ['r', 'b']) {
      list.push(['general', 1], ['advisor', 2], ['elephant', 2], ['chariot', 2], ['horse', 2], ['cannon', 2], ['soldier', 5]);
      // 展开
    }
    const pieces = [];
    for (const side of ['r', 'b']) {
      const spec = [['general', 1], ['advisor', 2], ['elephant', 2], ['chariot', 2], ['horse', 2], ['cannon', 2], ['soldier', 5]];
      for (const [kind, n] of spec) for (let i = 0; i < n; i++) pieces.push({ side, kind, faceUp: false });
    }
    const rng = mulberry32(seed == null ? (Date.now() & 0xffffffff) : seed);
    for (let i = pieces.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [pieces[i], pieces[j]] = [pieces[j], pieces[i]];
    }
    const b = makeBoard(cols, rows, null);
    let k = 0;
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) b[y][x] = pieces[k++];
    return { mode: 'banqi', board: b, cols, rows, turn: 'r', status: 'playing', winner: null, lastMove: null, moveCount: 0 };
  }
  function banqiCanCapture(att, def) {
    if (att.side === def.side) return false;
    const a = BANQI_RANK[att.kind], d = BANQI_RANK[def.kind];
    if (att.kind === 'soldier' && def.kind === 'general') return true;
    if (att.kind === 'cannon' && def.kind === 'cannon') return false;
    return a >= d;
  }
  function banqiTargets(s, x, y) {
    const p = s.board[y][x];
    if (!p || !p.faceUp) return [];
    const side = p.side, cols = s.cols, rows = s.rows;
    const out = [];
    const at = (nx, ny) => (inB(nx, ny, cols, rows) ? s.board[ny][nx] : undefined);
    const push = (nx, ny) => {
      if (!inB(nx, ny, cols, rows)) return;
      const q = at(nx, ny);
      out.push({ x: nx, y: ny, cap: !!(q && q.side !== side), occ: !!q });
    };
    switch (p.kind) {
      case 'general': case 'chariot':
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          let nx = x + dx, ny = y + dy;
          while (inB(nx, ny, cols, rows)) {
            const q = at(nx, ny);
            if (!q) out.push({ x: nx, y: ny, cap: false, occ: false });
            else { out.push({ x: nx, y: ny, cap: q.side !== side, occ: true }); break; }
            nx += dx; ny += dy;
          }
        }
        break;
      case 'advisor':
        for (const [dx, dy] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) push(x + dx, y + dy);
        break;
      case 'elephant':
        for (const [dx, dy] of [[-2, -2], [-2, 2], [2, -2], [2, 2]]) {
          const nx = x + dx, ny = y + dy;
          if (!inB(nx, ny, cols, rows)) continue;
          if (at(x + dx / 2, y + dy / 2)) continue;
          push(nx, ny);
        }
        break;
      case 'horse':
        for (const [dx, dy] of [[-1, -2], [1, -2], [-2, -1], [2, -1], [-1, 2], [1, 2], [-2, 1], [2, 1]]) {
          const nx = x + dx, ny = y + dy;
          if (!inB(nx, ny, cols, rows)) continue;
          const legX = Math.abs(dx) === 2 ? x + dx / 2 : x;
          const legY = Math.abs(dy) === 2 ? y + dy / 2 : y;
          if (at(legX, legY)) continue;
          push(nx, ny);
        }
        break;
      case 'cannon':
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          let nx = x + dx, ny = y + dy, screen = false;
          while (inB(nx, ny, cols, rows)) {
            const q = at(nx, ny);
            if (!screen) { if (!q) out.push({ x: nx, y: ny, cap: false, occ: false }); else screen = true; }
            else if (q) { if (q.side !== side) out.push({ x: nx, y: ny, cap: true, occ: true }); break; }
            nx += dx; ny += dy;
          }
        }
        break;
      case 'soldier':
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) push(x + dx, y + dy);
        break;
    }
    return out;
  }
  function banqiActionsAt(s, x, y, side) {
    const p = s.board[y][x];
    if (!p) return [];
    if (!p.faceUp) {
      // 翻棋：任意覆面子都可翻，且属于当前行动方的一个合法动作
      return [{ flip: [x, y] }];
    }
    if (p.side !== side) return [];
    const out = [];
    for (const t of banqiTargets(s, x, y)) {
      const q = s.board[t.y][t.x];
      if (t.cap) { if (q && banqiCanCapture(p, q)) out.push({ from: [x, y], to: [t.x, t.y], capture: [t.x, t.y] }); }
      else if (!t.occ) out.push({ from: [x, y], to: [t.x, t.y], capture: null });
    }
    return out;
  }

  /* ════════════════════════════════════════════════════════════════
   *  翻转棋 / Reversi（8×8，夹反）
   * ════════════════════════════════════════════════════════════════ */
  const REVERSI_W = [
    [120, -20, 20, 5, 5, 20, -20, 120],
    [-20, -40, -5, -5, -5, -5, -40, -20],
    [20, -5, 15, 3, 3, 15, -5, 20],
    [5, -5, 3, 3, 3, 3, -5, 5],
    [5, -5, 3, 3, 3, 3, -5, 5],
    [20, -5, 15, 3, 3, 15, -5, 20],
    [-20, -40, -5, -5, -5, -5, -40, -20],
    [120, -20, 20, 5, 5, 20, -20, 120],
  ];
  function reversiSetup() {
    const cols = 8, rows = 8;
    const b = makeBoard(cols, rows, null);
    b[3][3] = 'b'; b[3][4] = 'r'; b[4][3] = 'r'; b[4][4] = 'b';
    return { mode: 'reversi', board: b, cols, rows, turn: 'b', status: 'playing', winner: null, lastMove: null, moveCount: 0 };
  }
  function reversiFlips(s, x, y, side) {
    if (s.board[y][x]) return [];
    const opp = other(side);
    const flips = [];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const line = [];
      let nx = x + dx, ny = y + dy;
      while (inB(nx, ny, s.cols, s.rows) && s.board[ny][nx] === opp) { line.push([nx, ny]); nx += dx; ny += dy; }
      if (line.length && inB(nx, ny, s.cols, s.rows) && s.board[ny][nx] === side) flips.push(...line);
    }
    return flips;
  }
  function reversiActionsAt(s, x, y, side) {
    const flips = reversiFlips(s, x, y, side);
    return flips.length ? [{ to: [x, y], flips }] : [];
  }

  /* ── 统一调度 ───────────────────────────────────────────────────── */
  function actionsAt(s, x, y, side) {
    const who = side || s.turn;
    if (s.mode === 'gomoku' || s.mode === 'reversi') {
      if (s.board[y][x]) return [];
      return s.mode === 'gomoku' ? gomokuActionsAt(s, x, y) : reversiActionsAt(s, x, y, who);
    }
    if (s.mode === 'xiangqi') return xiangqiActionsAt(s, x, y, who);
    if (s.mode === 'checkers') return checkersActionsAt(s, x, y, who);
    if (s.mode === 'banqi') return banqiActionsAt(s, x, y, who);
    return [];
  }

  function allActions(s, side) {
    const who = side || s.turn;
    const out = [];
    for (let y = 0; y < s.rows; y++) for (let x = 0; x < s.cols; x++) {
      if (s.mode === 'gomoku' || s.mode === 'reversi') {
        if (!s.board[y][x]) out.push(...actionsAt(s, x, y, who));
      } else if (s.mode === 'banqi') {
        out.push(...banqiActionsAt(s, x, y, who)); // 含翻棋动作
      } else {
        const p = s.board[y][x];
        if (p && p.side === who && p.faceUp !== false) out.push(...actionsAt(s, x, y, who));
      }
    }
    return out;
  }

  function boardFull(s) {
    for (let y = 0; y < s.rows; y++) for (let x = 0; x < s.cols; x++) if (!s.board[y][x]) return false;
    return true;
  }
  function countPieces(s, side) {
    let n = 0;
    for (let y = 0; y < s.rows; y++) for (let x = 0; x < s.cols; x++) {
      const c = s.board[y][x];
      if (c && typeof c === 'object' && c.side === side && c.faceUp !== false) n++;
    }
    return n;
  }
  function countSide(s, side) {
    let n = 0;
    for (let y = 0; y < s.rows; y++) for (let x = 0; x < s.cols; x++) if (s.board[y][x] === side) n++;
    return n;
  }

  function applyAction(state, action) {
    let s = cloneState(state);
    const mover = s.turn;
    let winByGeneral = false;
    if (action.flip) {
      const [x, y] = action.flip;
      s.board[y][x] = { ...s.board[y][x], faceUp: true };
    } else if (action.to && !action.from) {
      const [x, y] = action.to;
      s.board[y][x] = s.turn;
      if (s.mode === 'reversi' && action.flips) for (const [fx, fy] of action.flips) s.board[fy][fx] = s.turn;
    } else {
      const [fx, fy] = action.from, [tx, ty] = action.to;
      const p = s.board[fy][fx];
      if (action.captures) {
        for (const [cx, cy] of action.captures) {
          const cap = s.board[cy][cx];
          if (cap && cap.kind === 'general') winByGeneral = true;
          s.board[cy][cx] = null;
        }
      }
      s.board[fy][fx] = null;
      if (s.mode === 'checkers' && p) {
        if ((p.side === 'r' && ty === 0) || (p.side === 'b' && ty === s.rows - 1)) p.king = true;
      }
      s.board[ty][tx] = p;
    }
    s.lastMove = action.flip ? { flip: action.flip } : { from: action.from, to: action.to };
    s.moveCount = (s.moveCount || 0) + 1;
    if (s.mode === 'checkers') s.noCap = action.captures && action.captures.length ? 0 : (s.noCap || 0) + 1;
    s = setEndIfFinished(s, mover, winByGeneral);
    s.turn = other(s.turn);
    if (s.mode === 'reversi') s = prepareTurn(s);
    return s;
  }

  function setEndIfFinished(s, mover, winByGeneral) {
    if (winByGeneral) { s.status = 'over'; s.winner = mover; return s; }
    if (s.mode === 'gomoku') {
      const lm = s.lastMove;
      if (lm && lm.to && gomokuWinAt(s, lm.to[0], lm.to[1], mover)) { s.status = 'over'; s.winner = mover; return s; }
      if (boardFull(s)) { s.status = 'over'; s.winner = 'draw'; return s; }
      return s;
    }
    if (s.mode === 'reversi') return s; // 由 prepareTurn 处理 pass / 终局
    // 象棋 / 跳棋 / 暗棋：轮到的一方无棋可走即判负
    const acts = allActions(s, s.turn);
    if (acts.length === 0) { s.status = 'over'; s.winner = other(s.turn); return s; }
    if (s.mode === 'checkers') {
      if (countPieces(s, s.turn) === 0) { s.status = 'over'; s.winner = other(s.turn); return s; }
      if ((s.noCap || 0) >= 40) { s.status = 'over'; s.winner = 'draw'; return s; }
    }
    if (s.mode === 'banqi') {
      if (countPieces(s, s.turn) === 0) { s.status = 'over'; s.winner = other(s.turn); return s; }
    }
    return s;
  }

  function reversiFinish(s) {
    const r = countSide(s, 'r'), b = countSide(s, 'b');
    s.status = 'over';
    s.winner = r > b ? 'r' : b > r ? 'b' : 'draw';
    return s;
  }
  function prepareTurn(s) {
    if (s.status !== 'playing') return s;
    let guard = 0;
    while (s.status === 'playing' && guard < 6) {
      if (allActions(s, s.turn).length) break;
      const opp = other(s.turn);
      if (allActions(s, opp).length === 0) { s = reversiFinish(s); break; }
      s = { ...s, turn: opp, passed: true };
      guard++;
    }
    return s;
  }

  /* ── AI ─────────────────────────────────────────────────────────── */
  function evalMaterial(s, side) {
    let v = 0;
    for (let y = 0; y < s.rows; y++) for (let x = 0; x < s.cols; x++) {
      const c = s.board[y][x];
      if (!c || typeof c !== 'object' || c.faceUp === false) continue;
      const w = VAL[c.kind] || 1;
      if (s.mode === 'xiangqi' && c.kind === 'soldier') {
        const bonus = c.side === 'r' ? (crossedRiver('r', y) ? 30 : 0) : (crossedRiver('b', y) ? 30 : 0);
        v += (c.side === side ? (w + bonus) : -(w + bonus));
      } else {
        v += c.side === side ? w : -w;
      }
    }
    return v;
  }
  function evalCheckers(s, side) {
    let v = 0;
    for (let y = 0; y < s.rows; y++) for (let x = 0; x < s.cols; x++) {
      const c = s.board[y][x];
      if (!c) continue;
      let w = c.king ? VAL.king : VAL.man;
      if (!c.king) {
        const adv = c.side === 'r' ? (s.rows - 1 - y) : y;
        w += adv * 12;
      }
      w += (x >= 2 && x <= 5) ? 4 : 0;
      v += c.side === side ? w : -w;
    }
    return v;
  }
  function evalReversi(s, side) {
    let v = 0;
    for (let y = 0; y < s.rows; y++) for (let x = 0; x < s.cols; x++) {
      const c = s.board[y][x];
      if (!c) continue;
      const w = REVERSI_W[y][x];
      v += c === side ? w : -w;
    }
    const dr = countSide(s, side) - countSide(s, other(side));
    return v + dr * 2;
  }
  function evalState(s, side) {
    if (s.status === 'over') return s.winner === side ? 1e6 : s.winner === 'draw' ? 0 : -1e6;
    if (s.mode === 'checkers') return evalCheckers(s, side);
    if (s.mode === 'reversi') return evalReversi(s, side);
    if (s.mode === 'banqi') return evalMaterial(s, side);
    return evalMaterial(s, side); // xiangqi
  }
  function search(s, side, depth, alpha, beta) {
    if (depth === 0 || s.status !== 'playing') return evalState(s, side);
    const acts = allActions(s, s.turn);
    if (!acts.length) return evalState(s, side);
    let best = -Infinity;
    for (const a of acts) {
      const ns = applyAction(s, a);
      const val = -search(ns, other(side), depth - 1, -beta, -alpha);
      if (val > best) best = val;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }
  function chooseBySearch(s, side, depth) {
    const acts = allActions(s, side);
    if (!acts.length) return null;
    let best = acts[0], bestV = -Infinity, alpha = -Infinity;
    for (const a of acts) {
      const ns = applyAction(s, a);
      const v = -search(ns, other(side), depth - 1, -Infinity, -alpha);
      if (v > bestV) { bestV = v; best = a; }
      if (v > alpha) alpha = v;
    }
    return best;
  }

  /* 五子棋：启发式（攻防加权），不进入深搜，保证响应快。 */
  function gomokuScoreIf(s, x, y, side) {
    if (s.board[y][x]) return 0;
    s.board[y][x] = side;
    const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    let total = 0;
    for (const [dx, dy] of dirs) total += gomokuLineScore(s, x, y, dx, dy, side);
    s.board[y][x] = null;
    return total;
  }
  function gomokuLineScore(s, cx, cy, dx, dy, side) {
    let count = 1, open = 0;
    let x = cx + dx, y = cy + dy;
    while (inB(x, y, s.cols, s.rows) && s.board[y][x] === side) { count++; x += dx; y += dy; }
    if (inB(x, y, s.cols, s.rows) && !s.board[y][x]) open++;
    x = cx - dx; y = cy - dy;
    while (inB(x, y, s.cols, s.rows) && s.board[y][x] === side) { count++; x -= dx; y -= dy; }
    if (inB(x, y, s.cols, s.rows) && !s.board[y][x]) open++;
    if (count >= 5) return 100000;
    if (count === 4) return open === 2 ? 12000 : 2000;
    if (count === 3) return open === 2 ? 2000 : 400;
    if (count === 2) return open === 2 ? 300 : 80;
    if (count === 1) return open === 2 ? 20 : 5;
    return 0;
  }
  function gomokuAi(s, side) {
    const opp = other(side);
    const cands = new Set();
    let any = false;
    for (let y = 0; y < s.rows; y++) for (let x = 0; x < s.cols; x++) {
      if (s.board[y][x]) {
        any = true;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx, ny = y + dy;
          if (inB(nx, ny, s.cols, s.rows) && !s.board[ny][nx]) cands.add(nx + ',' + ny);
        }
      }
    }
    const cells = any ? [...cands].map((k) => k.split(',').map(Number)) : [[7, 7]];
    let best = null, bestV = -Infinity;
    for (const [x, y] of cells) {
      const my = gomokuScoreIf(s, x, y, side);
      const op = gomokuScoreIf(s, x, y, opp);
      const v = my + op * 0.92;
      if (v > bestV) { bestV = v; best = { to: [x, y] }; }
    }
    return best;
  }

  /* 暗棋：贪心（吃子优先、吃将即胜、否则翻一枚）。 */
  function banqiAi(s, side) {
    const acts = allActions(s, side);
    if (!acts.length) return null;
    for (const a of acts) if (a.captures) {
      const [cx, cy] = a.captures[0];
      if (s.board[cy][cx] && s.board[cy][cx].kind === 'general') return a;
    }
    let best = null, bestV = -1;
    for (const a of acts) if (a.captures) {
      const [cx, cy] = a.captures[0];
      const cap = s.board[cy][cx];
      const v = cap ? (VAL[cap.kind] || 1) : 0;
      if (v > bestV) { bestV = v; best = a; }
    }
    if (best) return best;
    const flips = acts.filter((a) => a.flip);
    if (flips.length) return flips[Math.floor(Math.random() * flips.length)];
    return acts[0];
  }

  function aiAction(state, side) {
    const who = side || state.turn;
    if (state.mode === 'gomoku') return gomokuAi(state, who);
    if (state.mode === 'banqi') return banqiAi(state, who);
    if (state.mode === 'checkers') return chooseBySearch(state, who, 5);
    if (state.mode === 'reversi') return chooseBySearch(state, who, 4);
    if (state.mode === 'xiangqi') return chooseBySearch(state, who, 2);
    return null;
  }

  /* ── 渲染辅助：把格子里的对象翻译成 {side, kind, faceUp} ──────────── */
  function cellInfo(s, x, y) {
    const c = s.board[y][x];
    if (!c) return null;
    if (s.mode === 'gomoku' || s.mode === 'reversi') return { side: c, kind: 'stone', faceUp: true };
    if (s.mode === 'checkers') return { side: c.side, kind: c.king ? 'king' : 'man', faceUp: true, king: !!c.king };
    return { side: c.side, kind: c.kind, faceUp: c.faceUp !== false };
  }

  function createGame(modeId, opts) {
    opts = opts || {};
    let s;
    switch (modeId) {
      case 'xiangqi': s = xiangqiSetup(); break;
      case 'gomoku': s = gomokuSetup(); break;
      case 'checkers': s = checkersSetup(); break;
      case 'banqi': s = banqiSetup(opts.seed); break;
      case 'reversi': s = reversiSetup(); break;
      default: throw new Error('未知棋类：' + modeId);
    }
    s.status = 'playing'; s.winner = null; s.passed = false;
    if (modeId === 'reversi') s = prepareTurn(s);
    return s;
  }

  const api = {
    MODES, MODE_BY_ID,
    other, cloneState, createGame,
    actionsAt, allActions, applyAction, prepareTurn,
    aiAction, cellInfo, countPieces, countSide,
    // 仅供测试 / 调试
    _internal: { xiangqiTargets, banqiCanCapture, gomokuWinAt, reversiFlips, generalsFacing },
  };

  Object.defineProperty(root, 'ShanhaiChessCore', {
    value: Object.freeze(api), writable: false, configurable: false, enumerable: true,
  });
}(typeof globalThis !== 'undefined' ? globalThis : this));
