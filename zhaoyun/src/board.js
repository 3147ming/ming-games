/* =============================================================================
 * 赵云与阿斗 · 棋盘模型 (board.js)  — V2 长坂坡战场
 * 8 列 × 12 行；三兵线（左路/右路/蛇形中路）+ 岔口 + 障碍地形
 * 单位沿兵线（道路格）用流场寻路推进，攻击按切比雪夫射程结算
 * 部署体系：开局 3×3 可部署地 + 荒地（道路但不可部署）+ 铲子扩地
 * ========================================================================== */
(function (ZY) {
  'use strict';

  const ROWS = 12;
  const COLS = 8;

  // 半区（玩家永远在下、敌方在上；竞技模式双方镜像）
  const PLAYER_TOP = 6, PLAYER_BOTTOM = 11;   // 玩家可放置行区间 [6,11]
  const ENEMY_TOP = 0, ENEMY_BOTTOM = 5;      // 敌方行区间 [0,5]
  const MID_LINE = 6;                          // 中线画在第 6 行上沿

  // 阿斗位置（竖屏棋盘中心对称）：玩家 (11,4) / 敌方 (0,3)
  // 中路占 col 3-4，二者都在中路上
  const ADOU = {
    player: { row: 11, col: 4 },
    enemy:  { row: 0,  col: 3 },
  };

  /* 地形：1 = 兵线道路（可部署/可通行），0 = 障碍（不可部署/不可通行）
   * 布局：左路 col0-1、右路 col6-7 全通；中路 col3-4 全通；
   *       col2 / col5 为线间障碍带，但在 row4 / row7 处开岔口连通左右路；
   *       敌方半区 row0-2 与玩家半区 row9-11 全开（开局地所在）。
   * 保证三兵线全程连通，任意道路格都能走到对方阿斗。 */
  const TERRAIN = [
    [1, 1, 1, 1, 1, 1, 1, 1], // 0  敌 开局地 cols2-4
    [1, 1, 1, 1, 1, 1, 1, 1], // 1
    [1, 1, 1, 1, 1, 1, 1, 1], // 2
    [1, 1, 0, 1, 1, 0, 1, 1], // 3  障碍带 col2/col5
    [1, 1, 1, 1, 1, 1, 1, 1], // 4  岔口（col2、col5 连通）
    [1, 1, 0, 1, 1, 0, 1, 1], // 5  障碍带
    [1, 1, 0, 1, 1, 0, 1, 1], // 6  障碍带
    [1, 1, 1, 1, 1, 1, 1, 1], // 7  岔口
    [1, 1, 1, 1, 1, 1, 1, 1], // 8  玩家扩地行（4×4 起）
    [1, 1, 1, 1, 1, 1, 1, 1], // 9  玩家开局地 cols3-5
    [1, 1, 1, 1, 1, 1, 1, 1], // 10
    [1, 1, 1, 1, 1, 1, 1, 1], // 11
  ];

  // 三兵线与出兵列
  const LANES = {
    left:  [0, 1],
    mid:   [3, 4],
    right: [6, 7],
  };

  function key(r, c) { return r + ',' + c; }
  function inBoard(r, c) { return r >= 0 && r < ROWS && c >= 0 && c < COLS; }
  function isRoad(r, c) { return inBoard(r, c) && TERRAIN[r][c] === 1; }

  function isOwnRow(side, r) {
    return side === 'player' ? (r >= PLAYER_TOP && r <= PLAYER_BOTTOM)
                             : (r >= ENEMY_TOP && r <= ENEMY_BOTTOM);
  }

  /** 流场：从目标阿斗格对道路格做 BFS，得到每格到阿斗的步数。
   *  FIELD_P = 朝向玩家阿斗（供「敌方单位」寻路用）
   *  FIELD_E = 朝向敌方阿斗（供「玩家单位」寻路用） */
  function buildField(target) {
    const dist = [];
    for (let r = 0; r < ROWS; r++) { dist.push(new Array(COLS).fill(Infinity)); }
    const q = [target];
    dist[target.row][target.col] = 0;
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    while (q.length) {
      const cur = q.shift();
      const d = dist[cur.row][cur.col];
      for (let i = 0; i < 4; i++) {
        const nr = cur.row + dirs[i][0], nc = cur.col + dirs[i][1];
        if (isRoad(nr, nc) && dist[nr][nc] === Infinity) {
          dist[nr][nc] = d + 1;
          q.push({ row: nr, col: nc });
        }
      }
    }
    return dist;
  }
  const FIELD_P = buildField(ADOU.player);   // 敌方单位朝此
  const FIELD_E = buildField(ADOU.enemy);    // 玩家单位朝此

  /** 单位应朝向的流场（朝对方阿斗） */
  function fieldFor(side) { return side === 'player' ? FIELD_E : FIELD_P; }

  function createGrid() {
    const g = [];
    for (let r = 0; r < ROWS; r++) {
      const row = [];
      for (let c = 0; c < COLS; c++) row.push(null);
      g.push(row);
    }
    return g;
  }

  function dirOf(side) { return side === 'player' ? -1 : 1; }

  /* ----------------------------------------------------- 开局可部署地 */
  /** 开局可部署地（state.deploy 初始集合）。
   *  玩家：第 4 关（idx>=3）起扩为 4×4（rows 8-11 × cols 3-6），否则 3×3（rows 9-11 × cols 3-5）
   *  敌方（竞技镜像）：固定 3×3（rows 0-2 × cols 2-4） */
  function startRegion(side, levelIdx) {
    const set = {};
    if (side === 'player') {
      const big = levelIdx >= 3;
      const r0 = big ? 8 : 9, r1 = 11;
      const c0 = big ? 3 : 3, c1 = big ? 6 : 5;
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (isRoad(r, c)) set[key(r, c)] = true;
    } else {
      for (let r = 0; r <= 2; r++) for (let c = 2; c <= 4; c++) if (isRoad(r, c)) set[key(r, c)] = true;
    }
    return set;
  }

  /** 己方半区内的荒地（道路格、不在开局地、未扩为部署地） */
  function wastelandCells(side) {
    const out = [];
    const r0 = side === 'player' ? PLAYER_TOP : ENEMY_TOP;
    const r1 = side === 'player' ? PLAYER_BOTTOM : ENEMY_BOTTOM;
    for (let r = r0; r <= r1; r++) for (let c = 0; c < COLS; c++) {
      if (isRoad(r, c)) out.push({ row: r, col: c });
    }
    return out;
  }

  /** 该格能否放东西（己方半区 + 道路 + 已在可部署地 + 为空） */
  function canPlace(state, side, r, c) {
    if (!inBoard(r, c)) return false;
    if (!isOwnRow(side, r)) return false;
    if (!isRoad(r, c)) return false;
    if (!state.deploy[key(r, c)]) return false;
    if (state.grid[r][c]) return false;
    return true;
  }

  /** 该格是否为障碍（不可部署不可通行） */
  function isObstacle(r, c) { return inBoard(r, c) && TERRAIN[r][c] === 0; }

  /* ----------------------------------------------------- 寻路与攻击 */
  /** 切比雪夫距离 ≤ range 的敌方单位（用于攻击结算） */
  function enemiesInRange(state, u, range) {
    const out = [];
    for (let i = 0; i < state.units.length; i++) {
      const t = state.units[i];
      if (t.dead || t.side === u.side) continue;
      const dr = Math.abs(t.row - u.row), dc = Math.abs(t.col - u.col);
      if (Math.max(dr, dc) <= range) out.push(t);
    }
    return out;
  }

  /** 流场下一步：朝对方阿斗更近的相邻道路格；岔口按概率转向侧路 */
  function nextStep(state, u) {
    const field = fieldFor(u.side);
    const cur = field[u.row][u.col];
    if (!isFinite(cur)) return null;
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let best = null, bestVal = cur;
    for (let i = 0; i < 4; i++) {
      const nr = u.row + dirs[i][0], nc = u.col + dirs[i][1];
      if (!isRoad(nr, nc)) continue;
      const v = field[nr][nc];
      if (!isFinite(v)) continue;
      if (v < bestVal) { bestVal = v; best = [{ row: nr, col: nc }]; }
      else if (v === bestVal) { (best || (best = [])).push({ row: nr, col: nc }); }
    }
    if (!best) return null;          // 已在阿斗格（cur=0 无更小邻格）
    if (best.length === 1) return best[0];
    // 岔口：多数情况沿「更向前」的方向，FORK_CHANCE 概率随机转向（实现侧路分流）
    const fwd = function (a, b) { return u.side === 'player' ? (a.row - b.row) : (b.row - a.row); };
    best.sort(function (a, b) { return fwd(a, b); });
    const chance = (ZY.C && ZY.C.FORK_CHANCE != null) ? ZY.C.FORK_CHANCE : 0.3;
    if (Math.random() < chance) return best[Math.floor(Math.random() * best.length)];
    return best[0];
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

  /** 与现有可部署地上下左右相邻的荒地道路格（铲子扩地候选） */
  function adjacentToDeploy(state, side, r, c) {
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (let i = 0; i < 4; i++) {
      const k = key(r + dirs[i][0], c + dirs[i][1]);
      if (state.deploy[k]) return true;
    }
    return false;
  }

  /** AI 用：选一个离敌方阿斗最近（最靠前）且与部署地相邻的荒地格 */
  function frontWasteland(state, side) {
    const r0 = side === 'player' ? PLAYER_TOP : ENEMY_TOP;
    const r1 = side === 'player' ? PLAYER_BOTTOM : ENEMY_BOTTOM;
    const field = fieldFor(side === 'player' ? 'enemy' : 'player'); // 朝自己阿斗的反向即"最前"
    let best = null, bestScore = -Infinity;
    const cells = wastelandCells(side);
    for (let i = 0; i < cells.length; i++) {
      const rc = cells[i];
      if (state.deploy[key(rc.row, rc.col)]) continue;
      if (!adjacentToDeploy(state, side, rc.row, rc.col)) continue;
      // 越靠近对方（field 越小 = 越接近对方阿斗）越优先
      const score = -field[rc.row][rc.col] + Math.random();
      if (score > bestScore) { bestScore = score; best = rc; }
    }
    return best;
  }

  ZY.B = {
    ROWS: ROWS, COLS: COLS,
    PLAYER_TOP: PLAYER_TOP, PLAYER_BOTTOM: PLAYER_BOTTOM,
    ENEMY_TOP: ENEMY_TOP, ENEMY_BOTTOM: ENEMY_BOTTOM, MID_LINE: MID_LINE,
    ADOU: ADOU, TERRAIN: TERRAIN, LANES: LANES,
    FIELD_P: FIELD_P, FIELD_E: FIELD_E,
    key: key, inBoard: inBoard, isRoad: isRoad, isObstacle: isObstacle, isOwnRow: isOwnRow,
    createGrid: createGrid, dirOf: dirOf, startRegion: startRegion,
    wastelandCells: wastelandCells, canPlace: canPlace,
    enemiesInRange: enemiesInRange, nextStep: nextStep, neighbors: neighbors,
    adjacentToDeploy: adjacentToDeploy, frontWasteland: frontWasteland,
    fieldFor: fieldFor,
  };
})(window.ZY);
