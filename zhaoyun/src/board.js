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

  /* ---------- 障碍：左右荆棘山脊 + 内部岩块 ----------
   * V8.1：障碍随地图派生（buildMap 会一起镜像），不再全局固定 —— 这样入口/阿斗
   * 镜像翻转后仍不会压到山脊上。
   * 基础图留空两格：(0,0) 给左右翻转关、(11,7) 给上下翻转关的入口/终点让位。 */
  const BASE_OBSTACLES = [];
  (function () {
    for (let r = 1; r < ROWS; r++) BASE_OBSTACLES.push(key(r, 0));              // 左山脊 11 格（(0,0) 留空）
    for (let r = 1; r < ROWS - 1; r++) BASE_OBSTACLES.push(key(r, COLS - 1));   // 右山脊 10 格（(0,7)/(11,7) 留空）
    ['2,4', '2,5', '3,4', '3,5', '6,2', '6,3', '7,2', '7,3'].forEach(function (k) { BASE_OBSTACLES.push(k); });   // 内部岩块 8 格
  })();
  // 竞技双路各宽 3 列、横跨 12 行 → 只剩左右两列山脊可用（24 格，与 V8 一致）
  const VS_OBSTACLES = [];
  (function () { for (let r = 0; r < ROWS; r++) { VS_OBSTACLES.push(key(r, 0)); VS_OBSTACLES.push(key(r, COLS - 1)); } })();
  function toSet(arr) { const s = {}; arr.forEach(function (k) { s[k] = true; }); return s; }
  const VS_OBS_SET = toSet(VS_OBSTACLES);
  /** 该局地形障碍集合（竞技 / 单人各一张） */
  function obstacleSet(mode, levelIdx) {
    if (mode === 'versus') return VS_OBS_SET;
    return resolveSoloMap(levelIdx).obsSet;
  }
  function isObstacle(r, c, mode, levelIdx) { return !!obstacleSet(mode, levelIdx)[key(r, c)]; }

  /* ---------- 单人蛇形主路（无尽 / 关卡） ----------
   * V8.1 重排：折返段数 6 → 4，全长 37 → 28 格（走完全程更快，但塔的射击窗口变窄）。
   * 敌人右侧进入 (0,7) → 顶排左行 → 左岸下行 → 中排右行 → 右岸下行 →
   * 下排左行 → 中列下行 → 底排左转 → 阿斗 (11,1)。与塔位/障碍无交叠。
   */
  const SOLO_PATH = [
    [0, 7], [0, 6], [0, 5], [0, 4], [0, 3], [0, 2], [0, 1],
    [1, 1], [2, 1], [3, 1],
    [4, 1], [4, 2], [4, 3], [4, 4], [4, 5], [4, 6],
    [5, 6], [6, 6], [7, 6],
    [8, 6], [8, 5], [8, 4], [8, 3], [8, 2],
    [9, 2], [10, 2],
    [11, 2], [11, 1],
  ].map(function (p) { return { row: p[0], col: p[1] }; });
  const SOLO_ENTRANCE = { row: 0, col: 7 };   // 右侧刷怪口（右上角，贴右山脊）
  const SOLO_ADOU = { row: 11, col: 1 };      // 左侧阿斗（终点，贴左山脊）

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
  // V8.1 重排：顶排下沿 5 格 · 左侧下行两侧 2 格 · 中排下沿 4 格 · 右岸两侧 2 格 ·
  //             下排上沿 3 格 · 阿斗上方 1 格；横向相邻成对的塔位足够摆武将（span2）
  const SLOTS_SOLO_BASE = [
    '1,2', '1,3', '1,4', '1,5', '1,6',   // 顶排主路下沿
    '2,2', '3,2',                        // 左侧下行路东侧
    '5,2', '5,3', '5,4', '5,5',          // 中排主路下沿
    '6,5', '7,5',                        // 右岸下行路西侧
    '9,3', '9,4', '10,3',                // 下排主路上沿
    '11,3',                              // 阿斗右侧
  ];
  const SLOTS_SOLO_BIG = SLOTS_SOLO_BASE.concat(['3,3', '7,4', '9,5', '9,6']);   // 第 4 关起 21 个

  /* ---------- 关卡专属地图（per-level） ----------
   * 0~5 关共用 V8.1 新版 28 格蛇形图（levelIdx ≥ 3 起塔位升级为 21 格 BIG）。
   * 6~7 关为「内容扩展」新增：以原图做双射镜像变换（左右翻转 / 上下翻转）派生，
   *   路径 / 塔位 / 障碍三集合一起镜像 → 仍两两不交、且全部落在棋盘内。
   *   —— 镜像后入口(阿斗)随之翻转，形成视觉与战术都不同的新布局。 */
  function tfV(p) { return { row: p.row, col: COLS - 1 - p.col }; }   // 左右翻转
  function tfH(p) { return { row: ROWS - 1 - p.row, col: p.col }; }   // 上下翻转
  function keyTf(k, fn) { const a = k.split(','); const p = fn({ row: +a[0], col: +a[1] }); return p.row + ',' + p.col; }
  function buildMap(fn) {
    const obs = BASE_OBSTACLES.map(function (k) { return keyTf(k, fn); });
    return {
      path: SOLO_PATH.map(fn),
      entrance: fn(SOLO_ENTRANCE),
      adou: fn(SOLO_ADOU),
      slotsBase: SLOTS_SOLO_BASE.map(function (k) { return keyTf(k, fn); }),
      slotsBig: SLOTS_SOLO_BIG.map(function (k) { return keyTf(k, fn); }),
      obstacles: obs,
      obsSet: toSet(obs),
    };
  }
  const SOLO_BASE_MAP = {
    name: '巨鹿',
    path: SOLO_PATH, entrance: SOLO_ENTRANCE, adou: SOLO_ADOU,
    slotsBase: SLOTS_SOLO_BASE, slotsBig: SLOTS_SOLO_BIG,
    obstacles: BASE_OBSTACLES, obsSet: toSet(BASE_OBSTACLES),
  };

  /* ---------- 八关八图（数据源 src/maps.js） ----------
   * maps.js 只提供纯数据（path / slots / slotsBig / obstacles，坐标是 [row,col] 数组），
   * board.js 负责转成内部结构并做启动自检。
   * 自检不过（或 maps.js 未加载）→ 该关回落到基础图：宁可少一张图，也不白屏。 */
  function toMap(m) {
    const path = m.path.map(function (p) { return { row: p[0], col: p[1] }; });
    const slotsBase = m.slots.map(function (p) { return p[0] + ',' + p[1]; });
    const slotsBig = m.slotsBig.map(function (p) { return p[0] + ',' + p[1]; });
    const obstacles = m.obstacles.map(function (p) { return p[0] + ',' + p[1]; });
    return {
      name: m.name || '',
      path: path,
      entrance: path[0],
      adou: path[path.length - 1],
      slotsBase: slotsBase,
      slotsBig: slotsBig,
      obstacles: obstacles,
      obsSet: toSet(obstacles),
    };
  }

  /** 单图自检：28 格四连通主路 / 29 障碍 / 17·21 塔位 / 三类互斥 */
  function validateMap(m) {
    if (!m || !m.path || m.path.length !== 28) return false;
    const seen = {};
    for (let i = 0; i < m.path.length; i++) {
      const p = m.path[i];
      if (!inBoard(p.row, p.col)) return false;
      const k = key(p.row, p.col);
      if (seen[k]) return false;
      seen[k] = true;
      if (i) {
        const q = m.path[i - 1];
        if (Math.abs(q.row - p.row) + Math.abs(q.col - p.col) !== 1) return false;
      }
    }
    if (!m.obstacles || m.obstacles.length !== 29) return false;
    for (let i = 0; i < m.obstacles.length; i++) if (seen[m.obstacles[i]]) return false;
    if (!m.slotsBase || !m.slotsBig) return false;
    if (m.slotsBase.length !== 17 || m.slotsBig.length !== 21) return false;
    for (let i = 0; i < m.slotsBig.length; i++) {
      const k = m.slotsBig[i];
      if (seen[k] || m.obsSet[k]) return false;
    }
    return true;
  }

  const SOLO_MAPS = (function () {
    const src = (ZY.MAPS && ZY.MAPS.length >= 8) ? ZY.MAPS : null;
    // 回落：maps.js 未加载 → 沿用 V8.1 的 6 基础图 + 2 镜像
    if (!src) return [SOLO_BASE_MAP, SOLO_BASE_MAP, SOLO_BASE_MAP, SOLO_BASE_MAP, SOLO_BASE_MAP, SOLO_BASE_MAP, buildMap(tfV), buildMap(tfH)];
    const out = [];
    for (let i = 0; i < 8; i++) {
      const m = toMap(src[i]);
      if (validateMap(m)) { out.push(m); continue; }
      if (typeof console !== 'undefined' && console.error) {
        console.error('[zhaoyun] 地图自检失败，回落到基础图：index=' + i + ' name=' + (m.name || '?'));
      }
      out.push(SOLO_BASE_MAP);
    }
    return out;
  })();
  function resolveSoloMap(levelIdx) {
    let li = (typeof levelIdx === 'number') ? levelIdx : 0;
    if (li < 0) li = 0;
    if (li >= SOLO_MAPS.length) li = SOLO_MAPS.length - 1;
    return SOLO_MAPS[li];
  }

  const SLOTS_VS_P = ['1,1', '1,2', '3,2', '3,3', '5,1', '5,2', '7,2', '7,3'];     // 我方 8 个
  const SLOTS_VS_E = SLOTS_VS_P.map(function (k) { const p = k.split(','); return p[0] + ',' + (COLS - 1 - +p[1]); });

  /** 开局塔位集合（key → side） */
  function startSlots(mode, side, levelIdx) {
    const set = {};
    const put = function (arr) { arr.forEach(function (k) { set[k] = side; }); };
    if (mode === 'versus') put(side === 'enemy' ? SLOTS_VS_E : SLOTS_VS_P);
    else { const m = resolveSoloMap(levelIdx); put(levelIdx >= 3 ? m.slotsBig : m.slotsBase); }
    return set;
  }

  /* ---------- 路径查询 ---------- */
  function pathSeq(mode, side, levelIdx) {
    if (mode === 'versus') return side === 'enemy' ? VS_E_PATH : VS_P_PATH;
    return resolveSoloMap(levelIdx).path;
  }
  const _pathSets = {};
  function pathSet(mode, levelIdx) {
    if (mode === 'versus') {
      if (_pathSets['versus']) return _pathSets['versus'];
      const s = {};
      [VS_P_PATH, VS_E_PATH].forEach(function (seq) { seq.forEach(function (p) { s[key(p.row, p.col)] = true; }); });
      _pathSets['versus'] = s;
      return s;
    }
    const li = (typeof levelIdx === 'number' && levelIdx > 0) ? levelIdx : 0;
    const ck = 'solo:' + li;
    if (_pathSets[ck]) return _pathSets[ck];
    const s = {};
    resolveSoloMap(li).path.forEach(function (p) { s[key(p.row, p.col)] = true; });
    _pathSets[ck] = s;
    return s;
  }
  function isPath(mode, r, c, levelIdx) { return !!pathSet(mode, levelIdx)[key(r, c)]; }

  function entrances(mode, side, levelIdx) {
    if (mode === 'versus') return [VS_ENTRANCE[side === 'enemy' ? 'enemy' : 'player']];
    return [resolveSoloMap(levelIdx).entrance];
  }
  function adouAt(mode, side, levelIdx) {
    if (mode === 'versus') return VS_ADOU[side] || null;
    return side === 'player' ? resolveSoloMap(levelIdx).adou : null;
  }
  /** 入口格 + 首段主路（预警 ▼ 用） */
  function warnCells(mode, side, levelIdx) {
    const seq = pathSeq(mode, side, levelIdx);
    const ent = entrances(mode, side, levelIdx)[0];
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
    if (isPath(state.mode, r, c, state.levelIdx)) return false;
    if (isObstacle(r, c, state.mode, state.levelIdx)) return false;
    if (state.deploy[key(r, c)] !== side) return false;
    if (state.grid[r][c]) return false;
    if (span && span > 1) {
      const c2 = c + 1;
      if (!inBoard(r, c2)) return false;
      if (isPath(state.mode, r, c2, state.levelIdx)) return false;
      if (isObstacle(r, c2, state.mode, state.levelIdx)) return false;
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
        if (isPath(state.mode, r, c, state.levelIdx) || isObstacle(r, c, state.mode, state.levelIdx)) continue;
        if (state.deploy[key(r, c)]) continue;
        if (!adjacentToDeploy(state, side, r, c)) continue;
        out.push({ row: r, col: c });
      }
    }
    return out;
  }

  /** 某格相对主路某个参照点的覆盖格数（切比雪夫 ≤ d）——AI 选塔位用 */
  function coverCount(mode, side, r, c, d, levelIdx) {
    const seq = pathSeq(mode, side, levelIdx);
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
    BASE_OBSTACLES: BASE_OBSTACLES, VS_OBSTACLES: VS_OBSTACLES,
    resolveSoloMap: resolveSoloMap, SOLO_MAPS: SOLO_MAPS,
    key: key, inBoard: inBoard, isObstacle: isObstacle, obstacleSet: obstacleSet,
    isPath: isPath, pathSet: pathSet, pathSeq: pathSeq,
    entrances: entrances, adouAt: adouAt, warnCells: warnCells,
    createGrid: createGrid, canPlace: canPlace,
    threatsInRange: threatsInRange, neighbors: neighbors,
    adjacentToDeploy: adjacentToDeploy, shovelSpots: shovelSpots,
    startSlots: startSlots, coverCount: coverCount,
  };
})(window.ZY);
