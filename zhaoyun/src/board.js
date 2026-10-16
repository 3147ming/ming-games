/* =============================================================================
 * 赵云与阿斗 · 棋盘模型 (board.js)  — V5 原版对齐（竖屏化）
 * 8 列 × 12 行；竖屏 9:16。
 * 单人居中主路（无尽/关卡）：敌人从**右侧刷怪口**进入 → 右侧竖排通道 →
   * 中排横排 → 左侧竖排 → **左侧阿斗（终点）**；右侧入口处另立一「斗」作为敌方刷怪口标记。
   * 地形三态：**绿色可放置格（塔位）/ 棕色敌人路径 / 荆棘山石障碍**；其余为荒地（铲子可扩）。
   * 竞技：左右镜像双路保留（各宽 3 列， cols 1-3 我方 / cols 4-6 敌方），同步竖屏化。
   * 塔位与主路互斥；V5 起武将塔占 2 格宽（横跨两格）。
   * ========================================================================== */
(function (ZY) {
  'use strict';

  const ROWS = 12;
  const COLS = 8;

  function key(r, c) { return r + ',' + c; }
  function inBoard(r, c) { return r >= 0 && r < ROWS && c >= 0 && c < COLS; }

  /* ---------- 障碍：左右两列荆棘山脊（装饰路径边缘，不可建塔、敌人不走） ---------- */
  const OBSTACLE = {};
  for (let r = 0; r < ROWS; r++) { OBSTACLE[key(r, 0)] = true; OBSTACLE[key(r, COLS - 1)] = true; }
  function isObstacle(r, c) { return !!OBSTACLE[key(r, c)]; }

  /* ---------- 单人蛇形主路（无尽 / 关卡） ----------
   * 敌人右侧进入 (0,6) → 顶排左行 → 右岸下行 → 中排右行 → 左岸下行 →
   * 中排左行 → 右岸下行 → 底排左行 → 阿斗 (11,1)。全长 37 格，与塔位/障碍无交叠。
   */
  const SOLO_PATH = [
    [0, 6], [0, 5], [0, 4],
    [1, 4], [2, 4],
    [2, 3], [2, 2], [2, 1],
    [3, 1], [4, 1],
    [4, 2], [4, 3], [4, 4], [4, 5], [4, 6],
    [5, 6], [6, 6],
    [6, 5], [6, 4], [6, 3], [6, 2], [6, 1],
    [7, 1], [8, 1],
    [8, 2], [8, 3], [8, 4], [8, 5], [8, 6],
    [9, 6], [10, 6],
    [10, 5], [10, 4], [10, 3], [10, 2], [10, 1],
    [11, 1],
  ].map(function (p) { return { row: p[0], col: p[1] }; });
  const SOLO_ENTRANCE = { row: 0, col: 6 };   // 右侧刷怪口
  const SOLO_ADOU = { row: 11, col: 1 };      // 左侧阿斗（终点）

  /* ---------- 竞技双路（左右镜像，各宽 3 列，互不交叠） ---------- */
  const VS_P_PATH = [
    [0, 1], [0, 2], [0, 3],
    [1, 3], [2, 3],
    [2, 2], [2, 1],
    [3, 1], [4, 1],
    [4, 2], [4, 3],
    [5, 3], [6, 3],
    [6, 2], [6, 1],
    [7, 1], [8, 1],
    [8, 2], [8, 3],
    [9, 3], [10, 3],
    [10, 2], [10, 1],
    [11, 1],
  ].map(function (p) { return { row: p[0], col: p[1] }; });
  const VS_E_PATH = VS_P_PATH.map(function (p) { return { row: p.row, col: COLS - 1 - p.col }; });
  const VS_ENTRANCE = { player: { row: 0, col: 1 }, enemy: { row: 0, col: 6 } };
  const VS_ADOU = { player: { row: 11, col: 1 }, enemy: { row: 11, col: 6 } };

  /* ---------- 初始塔位（绿色可放置格，贴主路两侧） ---------- */
  // 单人：贴蛇形主路肩位 17 个（第 4 关起 +4 = 21）
  const SLOTS_SOLO_BASE = [
    '1,3', '1,5', '1,6',            // 顶部入口段两侧
    '3,2', '3,3', '3,4',            // 上排横路下方
    '3,5', '3,6',                   // 中排右行路上方
    '5,2', '5,4', '5,5',            // 中排右行路下方
    '7,4', '7,5', '7,6',            // 下排横路两侧
    '9,2', '9,5',                   // 底排右行路上方
    '11,2',                         // 阿斗右侧
  ];
  const SLOTS_SOLO_BIG = SLOTS_SOLO_BASE.concat(['5,3', '7,3', '9,3', '11,3']);   // 第 4 关起 21 个
  const SLOTS_VS_P = ['1,1', '1,2', '3,2', '3,3', '5,1', '5,2', '7,2', '7,3'];     // 我方 8 个
  const SLOTS_VS_E = SLOTS_VS_P.map(function (k) { const p = k.split(','); return p[0] + ',' + (COLS - 1 - +p[1]); });

  /** 开局塔位集合（key → side） */
  function startSlots(mode, side, levelIdx) {
    const set = {};
    const put = function (arr) { arr.forEach(function (k) { set[k] = side; }); };
    if (mode === 'versus') put(side === 'enemy' ? SLOTS_VS_E : SLOTS_VS_P);
    else put(levelIdx >= 3 ? SLOTS_SOLO_BIG : SLOTS_SOLO_BASE);
    return set;
  }

  /* ---------- 路径查询 ---------- */
  function pathSeq(mode, side) {
    if (mode === 'versus') return side === 'enemy' ? VS_E_PATH : VS_P_PATH;
    return SOLO_PATH;
  }
  const _pathSets = {};
  function pathSet(mode) {
    if (_pathSets[mode]) return _pathSets[mode];
    const s = {};
    const seqs = mode === 'versus' ? [VS_P_PATH, VS_E_PATH] : [SOLO_PATH];
    seqs.forEach(function (seq) { seq.forEach(function (p) { s[key(p.row, p.col)] = true; }); });
    _pathSets[mode] = s;
    return s;
  }
  function isPath(mode, r, c) { return !!pathSet(mode)[key(r, c)]; }

  function entrances(mode, side) {
    if (mode === 'versus') return [VS_ENTRANCE[side === 'enemy' ? 'enemy' : 'player']];
    return [SOLO_ENTRANCE];
  }
  function adouAt(mode, side) {
    if (mode === 'versus') return VS_ADOU[side] || null;
    return side === 'player' ? SOLO_ADOU : null;
  }
  /** 入口格 + 首段主路（预警 ▼ 用） */
  function warnCells(mode, side) {
    const seq = pathSeq(mode, side);
    const ent = entrances(mode, side)[0];
    return [ent, seq[1], seq[2]].filter(Boolean);
  }

  function createGrid() {
    const g = [];
    for (let r = 0; r < ROWS; r++) {
      const row = [];
      for (let c = 0; c < COLS; c++) row.push(null);
      g.push(row);
    }
    return g;
  }

  /** 该格能否建塔：非主路 / 非障碍 / 是己方塔位 / 为空。
   *  span=2（武将塔）：右侧邻格也要满足同样条件。 */
  function canPlace(state, side, r, c, span) {
    if (!inBoard(r, c)) return false;
    if (isPath(state.mode, r, c)) return false;
    if (isObstacle(r, c)) return false;
    if (state.deploy[key(r, c)] !== side) return false;
    if (state.grid[r][c]) return false;
    if (span && span > 1) {
      const c2 = c + 1;
      if (!inBoard(r, c2)) return false;
      if (isPath(state.mode, r, c2)) return false;
      if (isObstacle(r, c2)) return false;
      if (state.deploy[key(r, c2)] !== side) return false;
      if (state.grid[r][c2]) return false;
    }
    return true;
  }

  /** 切比雪夫距离 ≤ range 的「冲我来的」敌人，按沿路进度（pi）从大到小 = 最靠前优先 */
  function threatsInRange(state, u, range) {
    const out = [];
    for (let i = 0; i < state.units.length; i++) {
      const t = state.units[i];
      if (t.dead || t.side !== 'enemy' || t.target !== u.side) continue;
      const dr = Math.abs(t.row - u.row), dc = Math.abs(t.col - u.col);
      if (Math.max(dr, dc) <= range) out.push(t);
    }
    out.sort(function (a, b) { return (b.pi || 0) - (a.pi || 0); });
    return out;
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

  /** 与己方塔位上下左右相邻的荒地（铲子扩地候选） */
  function adjacentToDeploy(state, side, r, c) {
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (let i = 0; i < 4; i++) {
      if (state.deploy[key(r + dirs[i][0], c + dirs[i][1])] === side) return true;
    }
    return false;
  }

  /** 全部可铲荒地（非主路 / 非障碍 / 非塔位 / 与己方塔位相邻） */
  function shovelSpots(state, side) {
    const out = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (isPath(state.mode, r, c) || isObstacle(r, c)) continue;
        if (state.deploy[key(r, c)]) continue;
        if (!adjacentToDeploy(state, side, r, c)) continue;
        out.push({ row: r, col: c });
      }
    }
    return out;
  }

  /** 某格相对主路某个参照点的覆盖格数（切比雪夫 ≤ d）——AI 选塔位用 */
  function coverCount(mode, side, r, c, d) {
    const seq = pathSeq(mode, side);
    let n = 0;
    for (let i = 0; i < seq.length; i++) {
      if (Math.max(Math.abs(seq[i].row - r), Math.abs(seq[i].col - c)) <= d) n++;
    }
    return n;
  }

  ZY.B = {
    ROWS: ROWS, COLS: COLS,
    SOLO_PATH: SOLO_PATH, VS_P_PATH: VS_P_PATH, VS_E_PATH: VS_E_PATH,
    SOLO_ENTRANCE: SOLO_ENTRANCE, SOLO_ADOU: SOLO_ADOU,
    key: key, inBoard: inBoard, isObstacle: isObstacle,
    isPath: isPath, pathSet: pathSet, pathSeq: pathSeq,
    entrances: entrances, adouAt: adouAt, warnCells: warnCells,
    createGrid: createGrid, canPlace: canPlace,
    threatsInRange: threatsInRange, neighbors: neighbors,
    adjacentToDeploy: adjacentToDeploy, shovelSpots: shovelSpots,
    startSlots: startSlots, coverCount: coverCount,
  };
})(window.ZY);
