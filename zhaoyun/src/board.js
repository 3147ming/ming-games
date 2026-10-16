/* =============================================================================
 * 赵云与阿斗 · 棋盘模型 (board.js)
 * 8 列 × 12 行；玩家下半区 row 6-11，敌方上半区 row 0-5
 * ========================================================================== */
(function (ZY) {
  'use strict';

  const ROWS = 12;
  const COLS = 8;

  // 半区（玩家永远在下、敌方在上；竞技模式双方镜像）
  const PLAYER_TOP = 6, PLAYER_BOTTOM = 11;   // 玩家可放置行区间 [6,11]
  const ENEMY_TOP = 0, ENEMY_BOTTOM = 5;      // 敌方行区间 [0,5]
  const MID_LINE = 6;                          // 中线画在第 6 行上沿（即 row5 / row6 之间）

  // 阿斗：己方底行中央格（180° 中心对称）
  const ADOU = {
    player: { row: 11, col: 3 },
    enemy:  { row: 0,  col: 4 },
  };

  function key(r, c) { return r + ',' + c; }
  function inBoard(r, c) { return r >= 0 && r < ROWS && c >= 0 && c < COLS; }

  function isOwnRow(side, r) {
    return side === 'player' ? (r >= PLAYER_TOP && r <= PLAYER_BOTTOM)
                             : (r >= ENEMY_TOP && r <= ENEMY_BOTTOM);
  }

  /** 空棋盘 */
  function createGrid() {
    const g = [];
    for (let r = 0; r < ROWS; r++) {
      const row = [];
      for (let c = 0; c < COLS; c++) row.push(null);
      g.push(row);
    }
    return g;
  }

  /** 单位前进方向：玩家向上(row-1)，敌方向下(row+1) */
  function dirOf(side) { return side === 'player' ? -1 : 1; }

  /** 生成锁定格：在指定半区随机取 n 个格子（排除阿斗格与其正前方一格） */
  function rollLocked(n, side) {
    const set = {};
    const adou = ADOU[side];
    const dir = dirOf(side);
    const exclude = {};
    exclude[key(adou.row, adou.col)] = true;
    exclude[key(adou.row + dir, adou.col)] = true; // 阿斗正前方留一条通路，避免开局堵死
    let guard = 0;
    while (Object.keys(set).length < n && guard++ < 500) {
      const r = side === 'player'
        ? PLAYER_TOP + Math.floor(Math.random() * (PLAYER_BOTTOM - PLAYER_TOP + 1))
        : ENEMY_TOP + Math.floor(Math.random() * (ENEMY_BOTTOM - ENEMY_TOP + 1));
      const c = Math.floor(Math.random() * COLS);
      const k = key(r, c);
      if (exclude[k] || set[k]) continue;
      set[k] = true;
    }
    return set;
  }

  /** 该格能否放东西（在己方半区 + 未锁定 + 为空） */
  function canPlace(state, side, r, c) {
    if (!inBoard(r, c)) return false;
    if (!isOwnRow(side, r)) return false;
    if (state.locked[key(r, c)]) return false;
    if (state.grid[r][c]) return false;
    return true;
  }

  /** 同列前方 range 格内的敌方单位（由近到远） */
  function scanForward(state, unit, range) {
    const dir = dirOf(unit.side);
    const out = [];
    for (let k = 1; k <= range; k++) {
      const r = unit.row + dir * k;
      if (r < 0 || r >= ROWS) break;
      const occ = state.grid[r][unit.col];
      if (occ && occ.side !== unit.side && !occ.dead) out.push(occ);
    }
    return out;
  }

  /** 正前方 1 格是否可落脚（含走出棋盘边界的判断） */
  function forwardCell(unit) {
    const r = unit.row + dirOf(unit.side);
    if (r < 0 || r >= ROWS) return null;
    return { row: r, col: unit.col };
  }

  /** 切比雪夫距离 1 的邻居（含自身可选） */
  function neighbors(state, r, c, includeSelf) {
    const out = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) { if (includeSelf) out.push({ row: r, col: c }); continue; }
        const nr = r + dr, nc = c + dc;
        if (inBoard(nr, nc)) out.push({ row: nr, col: nc });
      }
    }
    return out;
  }

  ZY.B = {
    ROWS: ROWS, COLS: COLS,
    PLAYER_TOP: PLAYER_TOP, PLAYER_BOTTOM: PLAYER_BOTTOM,
    ENEMY_TOP: ENEMY_TOP, ENEMY_BOTTOM: ENEMY_BOTTOM, MID_LINE: MID_LINE,
    ADOU: ADOU,
    key: key, inBoard: inBoard, isOwnRow: isOwnRow,
    createGrid: createGrid, dirOf: dirOf, rollLocked: rollLocked,
    canPlace: canPlace, scanForward: scanForward, forwardCell: forwardCell,
    neighbors: neighbors,
  };
})(window.ZY);
