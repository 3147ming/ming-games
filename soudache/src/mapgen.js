/**
 * 程序化战术地图生成 + 视线检测 + 寻路流场（纯逻辑模块）
 *
 * 算法：BSP 二叉空间切分生成房间 → 递归连接兄弟节点打通走廊（保证全图连通）
 *      → 房间内撒掩体箱 / 草丛 / 容器 → 合并实心格为矩形（供渲染）
 * 依赖：config.js（常量）、rng.js（可复现随机）
 */

import {
  TILE, MAP_COLS, MAP_ROWS, WORLD_W, WORLD_H, CELL, MATCH, VIEW3D,
  CONTAINERS, CONTAINER_SPAWN_WEIGHTS, POI, ENEMY_SPAWN_WEIGHTS, CRATE, VEHICLE,
} from './config.js';
import { createRng } from './rng.js';

/** 兵种权重表：模块级算一次，避免在敌人生成循环里反复 Object.entries */
const ENEMY_TYPE_ENTRIES = Object.entries(ENEMY_SPAWN_WEIGHTS);

/* ============================ 基础查询 ============================ */

/**
 * 指定格是否为实心（阻挡）。越界视为实心。
 * @param {object} map 地图对象
 * @param {number} tx 列
 * @param {number} ty 行
 * @returns {boolean} 是否阻挡
 */
export function isTileSolid(map, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= map.cols || ty >= map.rows) return true;
  return map.grid[ty * map.cols + tx] !== CELL.FLOOR;
}

/** 该格是否可通行 */
export function isWalkableTile(map, tx, ty) {
  return !isTileSolid(map, tx, ty);
}

/** 世界坐标处是否实心 */
export function isSolidAt(map, wx, wy) {
  return isTileSolid(map, Math.floor(wx / map.tile), Math.floor(wy / map.tile));
}

/** 世界坐标处的网格取值（0=地面, 1=墙, 2=掩体箱）；越界视为墙 */
export function cellAt(map, wx, wy) {
  const tx = Math.floor(wx / map.tile);
  const ty = Math.floor(wy / map.tile);
  if (tx < 0 || ty < 0 || tx >= map.cols || ty >= map.rows) return CELL.WALL;
  return map.grid[ty * map.cols + tx];
}

/** 世界坐标 → 格索引 */
export function tileIndex(map, wx, wy) {
  const tx = Math.floor(wx / map.tile);
  const ty = Math.floor(wy / map.tile);
  if (tx < 0 || ty < 0 || tx >= map.cols || ty >= map.rows) return -1;
  return ty * map.cols + tx;
}

/**
 * 圆是否与实心格相交。
 * @param {object} map 地图
 * @param {number} cx 圆心 x
 * @param {number} cy 圆心 y
 * @param {number} r 半径
 * @returns {boolean} 是否碰撞
 */
export function circleHitsSolid(map, cx, cy, r) {
  const t = map.tile;
  const minTx = Math.floor((cx - r) / t);
  const maxTx = Math.floor((cx + r) / t);
  const minTy = Math.floor((cy - r) / t);
  const maxTy = Math.floor((cy + r) / t);
  for (let ty = minTy; ty <= maxTy; ty += 1) {
    for (let tx = minTx; tx <= maxTx; tx += 1) {
      if (!isTileSolid(map, tx, ty)) continue;
      const rx = tx * t;
      const ry = ty * t;
      const px = Math.max(rx, Math.min(cx, rx + t));
      const py = Math.max(ry, Math.min(cy, ry + t));
      const dx = cx - px;
      const dy = cy - py;
      if (dx * dx + dy * dy < r * r) return true;
    }
  }
  return false;
}

/**
 * 带碰撞的位移（分轴解析，天然产生贴墙滑行）。
 * @param {object} map 地图
 * @param {number} x 起点 x
 * @param {number} y 起点 y
 * @param {number} dx x 位移
 * @param {number} dy y 位移
 * @param {number} r 半径
 * @returns {{x: number, y: number}} 新坐标
 */
export function moveWithCollision(map, x, y, dx, dy, r) {
  let nx = x + dx;
  if (circleHitsSolid(map, nx, y, r)) nx = x;
  let ny = y + dy;
  if (circleHitsSolid(map, nx, ny, r)) ny = y;
  return { x: nx, y: ny };
}

/**
 * 视线采样点是否遮挡。
 * seeOverCover 为真时只有墙体算遮挡 —— 掩体箱是半身掩体，站在架高平台上能看过去。
 * @param {object} map 地图
 * @param {number} wx 世界 x
 * @param {number} wy 世界 y
 * @param {boolean} seeOverCover 是否越过掩体
 * @returns {boolean} 是否遮挡
 */
function isBlocking(map, wx, wy, seeOverCover) {
  const tx = Math.floor(wx / map.tile);
  const ty = Math.floor(wy / map.tile);
  if (tx < 0 || ty < 0 || tx >= map.cols || ty >= map.rows) return true;
  const cell = map.grid[ty * map.cols + tx];
  return seeOverCover ? cell === CELL.WALL : cell !== CELL.FLOOR;
}

/**
 * 视线检测：两点之间是否被墙体/掩体遮挡。
 * 采用等距采样，采样间隔小于格宽的一半，不会穿透 1 格厚的墙。
 *
 * opts.seeOverCover：任一端站在架高平台上时为 true，此时**掩体箱不再遮挡**
 * （高地方能越过半身掩体观察），墙体无论多高都依旧遮挡。
 * @param {object} map 地图
 * @param {number} x1 起点 x
 * @param {number} y1 起点 y
 * @param {number} x2 终点 x
 * @param {number} y2 终点 y
 * @param {object} opts 选项 { seeOverCover }
 * @returns {boolean} 是否可见
 */
export function hasLineOfSight(map, x1, y1, x2, y2, opts = {}) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return true;
  // 未显式指定时自动按高程判定：任一端站在架高平台上，就能越过掩体箱观察。
  // 这样敌人 AI / 玩家交互的所有既有调用点都自动获得"高地视野"，无需逐个改。
  const seeOverCover = opts.seeOverCover != null
    ? !!opts.seeOverCover
    : (elevationAt(map, x1, y1) > 0.5 || elevationAt(map, x2, y2) > 0.5);
  const step = map.tile * 0.35;
  const steps = Math.ceil(dist / step);
  for (let i = 1; i < steps; i += 1) {
    const t = i / steps;
    if (isBlocking(map, x1 + dx * t, y1 + dy * t, seeOverCover)) return false;
  }
  return true;
}

/**
 * 世界坐标处的站立高度（米）：站在架高平台上返回 VIEW3D.platformHeight，否则 0。
 *
 * ⚠ 设计要点：平台格本身仍是 CELL.FLOOR（可通行），高程只是一个**附加属性**。
 * 因此平台不改变连通性、不参与碰撞，也就不会破坏"敌人出生点必须可达"这类既有保证 ——
 * 这正是把垂直结构做成"架高平台"而非"真正的二层"的原因。
 * @param {object} map 地图
 * @param {number} x 世界 x
 * @param {number} y 世界 y
 * @returns {number} 高度（米）
 */
export function elevationAt(map, x, y) {
  const plats = map.platforms;
  if (!plats || !plats.length) return 0;
  for (let i = 0; i < plats.length; i += 1) {
    const p = plats[i];
    if (x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h) return VIEW3D.platformHeight;
  }
  return 0;
}

/* ============================ 可破坏掩体箱 ============================ */

/**
 * 初始化掩体箱的可破坏状态：每个合并后的 crateRect 有独立血量，
 * crateRectAt 把每个 CRATE 格映射到它所属的 rect 索引（供命中时定位要扣血的箱子）。
 * 仅做数据初始化，不修改连通性 —— 箱子碎裂只会"移除实心格"，只会改善连通性，绝不破坏可达性。
 * @param {object} map 地图对象（已含 crateRects）
 * @returns {void}
 */
export function initCrateState(map) {
  const rects = map.crateRects || [];
  const n = rects.length;
  map.crateRectHp = new Float32Array(n);
  map.crateRectAt = new Int32Array(map.cols * map.rows).fill(-1);
  for (let i = 0; i < n; i += 1) {
    const r = rects[i];
    const tw = Math.max(1, Math.round(r.w / map.tile));
    const th = Math.max(1, Math.round(r.h / map.tile));
    const tiles = tw * th;
    const hp = CRATE.maxHp + CRATE.hpPerTile * (tiles - 1);
    map.crateRectHp[i] = hp;
    r.hp = hp;
    r.destroyed = false;
    const tx0 = Math.floor(r.x / map.tile);
    const ty0 = Math.floor(r.y / map.tile);
    const tx1 = Math.floor((r.x + r.w - 1) / map.tile);
    const ty1 = Math.floor((r.y + r.h - 1) / map.tile);
    for (let ty = ty0; ty <= ty1; ty += 1) {
      for (let tx = tx0; tx <= tx1; tx += 1) {
        map.crateRectAt[ty * map.cols + tx] = i;
      }
    }
  }
}

/**
 * 世界坐标处的掩体箱 rect 索引；非掩体箱格返回 -1。
 * @param {object} map 地图对象
 * @param {number} wx 世界 x
 * @param {number} wy 世界 y
 * @returns {number} rect 索引或 -1
 */
export function crateRectIndexAt(map, wx, wy) {
  const tx = Math.floor(wx / map.tile);
  const ty = Math.floor(wy / map.tile);
  if (tx < 0 || ty < 0 || tx >= map.cols || ty >= map.rows) return -1;
  return map.crateRectAt ? map.crateRectAt[ty * map.cols + tx] : -1;
}

/**
 * 对某个掩体箱 rect 造成伤害。血量归零则碎裂：覆盖格全部变回地面
 * （可通行、不挡视线），并标记 destroyed。
 * @param {object} map 地图对象
 * @param {number} ri rect 索引
 * @param {number} dmg 伤害
 * @returns {{destroyed: boolean, blocked: boolean}} 是否已碎 / 当前是否仍阻挡子弹
 */
export function damageCrateRect(map, ri, dmg) {
  if (ri < 0 || ri >= (map.crateRects || []).length) return { destroyed: false, blocked: true };
  const r = map.crateRects[ri];
  if (r.destroyed) return { destroyed: true, blocked: false };
  map.crateRectHp[ri] = Math.max(0, map.crateRectHp[ri] - dmg);
  r.hp = map.crateRectHp[ri];
  if (map.crateRectHp[ri] > 0) return { destroyed: false, blocked: true };
  r.destroyed = true;
  const tx0 = Math.max(0, Math.floor(r.x / map.tile));
  const ty0 = Math.max(0, Math.floor(r.y / map.tile));
  const tx1 = Math.min(map.cols - 1, Math.floor((r.x + r.w - 1) / map.tile));
  const ty1 = Math.min(map.rows - 1, Math.floor((r.y + r.h - 1) / map.tile));
  for (let ty = ty0; ty <= ty1; ty += 1) {
    for (let tx = tx0; tx <= tx1; tx += 1) {
      map.grid[ty * map.cols + tx] = CELL.FLOOR;
    }
  }
  return { destroyed: true, blocked: false };
}

/* ============================ 寻路流场 ============================ */

/**
 * 以 (tx,ty) 为目标做 BFS，返回每格的步数场（不可达为 -1）。
 * @param {object} map 地图
 * @param {number} tx 目标列
 * @param {number} ty 目标行
 * @returns {Int32Array} 距离场
 */
export function bfsFlowField(map, tx, ty) {
  const { cols, rows } = map;
  const field = new Int32Array(cols * rows).fill(-1);
  if (!isWalkableTile(map, tx, ty)) return field;
  const queue = new Int32Array(cols * rows);
  let head = 0;
  let tail = 0;
  const start = ty * cols + tx;
  field[start] = 0;
  queue[tail] = start;
  tail += 1;
  while (head < tail) {
    const cur = queue[head];
    head += 1;
    const cx = cur % cols;
    const cy = (cur - cx) / cols;
    const d = field[cur];
    for (let k = 0; k < 4; k += 1) {
      const nx = cx + (k === 0 ? 1 : k === 1 ? -1 : 0);
      const ny = cy + (k === 2 ? 1 : k === 3 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const ni = ny * cols + nx;
      if (map.grid[ni] !== CELL.FLOOR) continue;
      if (field[ni] !== -1) continue;
      field[ni] = d + 1;
      queue[tail] = ni;
      tail += 1;
    }
  }
  return field;
}

/**
 * 获取（带缓存的）到目标格的流场。缓存上限 40 个，超出整体清空。
 * @param {object} map 地图
 * @param {number} tx 目标列
 * @param {number} ty 目标行
 * @returns {Int32Array|null} 距离场，目标不可达时返回 null
 */
export function getFlowField(map, tx, ty) {
  if (!isWalkableTile(map, tx, ty)) return null;
  if (!map._flowCache) map._flowCache = new Map();
  const key = ty * map.cols + tx;
  const cached = map._flowCache.get(key);
  if (cached) return cached;
  const field = bfsFlowField(map, tx, ty);
  if (map._flowCache.size > 40) map._flowCache.clear();
  map._flowCache.set(key, field);
  return field;
}

/**
 * 由流场求出当前位置应当前进的单位方向。
 * @param {object} map 地图
 * @param {Int32Array} field 距离场
 * @param {number} wx 世界 x
 * @param {number} wy 世界 y
 * @returns {{x: number, y: number}|null} 单位方向，无路可走时返回 null
 */
export function flowDirection(map, field, wx, wy) {
  if (!field) return null;
  const t = map.tile;
  const tx = Math.floor(wx / t);
  const ty = Math.floor(wy / t);
  const here = field[ty * map.cols + tx];
  if (here === undefined || here < 0) return null;
  let best = here;
  let bx = -1;
  let by = -1;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const nx = tx + dx;
      const ny = ty + dy;
      if (!isWalkableTile(map, nx, ny)) continue;
      // 对角线需要两个正交邻格都可通行，避免卡墙角
      if (dx !== 0 && dy !== 0) {
        if (!isWalkableTile(map, tx + dx, ty) || !isWalkableTile(map, tx, ty + dy)) continue;
      }
      const v = field[ny * map.cols + nx];
      if (v < 0) continue;
      if (v < best) {
        best = v;
        bx = nx;
        by = ny;
      }
    }
  }
  if (bx < 0) return null;
  const cx = bx * t + t / 2;
  const cy = by * t + t / 2;
  const dx = cx - wx;
  const dy = cy - wy;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

/**
 * 找到离给定格最近的可通行格（螺旋搜索）。
 * @param {object} map 地图
 * @param {number} tx 列
 * @param {number} ty 行
 * @returns {{tx: number, ty: number}} 可通行格坐标
 */
export function nearestWalkableTile(map, tx, ty) {
  if (isWalkableTile(map, tx, ty)) return { tx, ty };
  for (let r = 1; r < 12; r += 1) {
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        if (isWalkableTile(map, tx + dx, ty + dy)) return { tx: tx + dx, ty: ty + dy };
      }
    }
  }
  return { tx: 1, ty: 1 };
}

/* ============================ 地图生成 ============================ */

function carveRect(grid, cols, x, y, w, h) {
  for (let ty = y; ty < y + h; ty += 1) {
    if (ty < 1 || ty >= MAP_ROWS - 1) continue;
    for (let tx = x; tx < x + w; tx += 1) {
      if (tx < 1 || tx >= cols - 1) continue;
      grid[ty * cols + tx] = CELL.FLOOR;
    }
  }
}

function carveH(grid, cols, x1, x2, y, h) {
  const y0 = Math.max(1, Math.min(MAP_ROWS - 1 - h, y));
  const a = Math.max(1, Math.min(x1, x2));
  const b = Math.min(cols - 2, Math.max(x1, x2));
  for (let x = a; x <= b; x += 1) {
    for (let dy = 0; dy < h; dy += 1) grid[(y0 + dy) * cols + x] = CELL.FLOOR;
  }
}

function carveV(grid, cols, y1, y2, x, w) {
  const x0 = Math.max(1, Math.min(cols - 1 - w, x));
  const a = Math.max(1, Math.min(y1, y2));
  const b = Math.min(MAP_ROWS - 2, Math.max(y1, y2));
  for (let y = a; y <= b; y += 1) {
    for (let dx = 0; dx < w; dx += 1) grid[y * cols + x0 + dx] = CELL.FLOOR;
  }
}

const MIN_LEAF = 9;
/** 出生点校验时使用的碰撞半径，略大于玩家半径以留出余量 */
const PLAYER_SPAWN_R = 15;

function buildTree(node, rng, depth) {
  if (depth <= 0) {
    node.leaf = true;
    return node;
  }
  const canH = node.h >= MIN_LEAF * 2;
  const canV = node.w >= MIN_LEAF * 2;
  if (!canH && !canV) {
    node.leaf = true;
    return node;
  }
  let horiz;
  if (canH && canV) {
    if (node.w / node.h > 1.25) horiz = false;
    else if (node.h / node.w > 1.25) horiz = true;
    else horiz = rng.chance(0.5);
  } else {
    horiz = canH;
  }
  if (horiz) {
    const cut = rng.int(MIN_LEAF, node.h - MIN_LEAF);
    node.left = { x: node.x, y: node.y, w: node.w, h: cut };
    node.right = { x: node.x, y: node.y + cut, w: node.w, h: node.h - cut };
  } else {
    const cut = rng.int(MIN_LEAF, node.w - MIN_LEAF);
    node.left = { x: node.x, y: node.y, w: cut, h: node.h };
    node.right = { x: node.x + cut, y: node.y, w: node.w - cut, h: node.h };
  }
  buildTree(node.left, rng, depth - 1);
  buildTree(node.right, rng, depth - 1);
  return node;
}

function collectLeaves(node, out) {
  if (node.leaf) {
    out.push(node);
    return out;
  }
  collectLeaves(node.left, out);
  collectLeaves(node.right, out);
  return out;
}

function carveRoom(grid, cols, leaf, rng) {
  const maxW = Math.max(3, leaf.w - 2);
  const maxH = Math.max(3, leaf.h - 2);
  const w = rng.int(Math.max(3, Math.ceil(maxW * 0.62)), maxW);
  const h = rng.int(Math.max(3, Math.ceil(maxH * 0.62)), maxH);
  const x = leaf.x + 1 + rng.int(0, Math.max(0, maxW - w));
  const y = leaf.y + 1 + rng.int(0, Math.max(0, maxH - h));
  carveRect(grid, cols, x, y, w, h);
  return {
    tx: x, ty: y, tw: w, th: h,
    x: x * TILE, y: y * TILE, w: w * TILE, h: h * TILE,
    cx: (x + w / 2) * TILE, cy: (y + h / 2) * TILE,
  };
}

function connectTree(node, grid, cols, rng) {
  if (node.leaf) return node.room;
  const a = connectTree(node.left, grid, cols, rng);
  const b = connectTree(node.right, grid, cols, rng);
  const w = 2;
  if (rng.chance(0.5)) {
    carveH(grid, cols, Math.floor(a.cx / TILE), Math.floor(b.cx / TILE), Math.floor(a.cy / TILE), w);
    carveV(grid, cols, Math.floor(a.cy / TILE), Math.floor(b.cy / TILE), Math.floor(b.cx / TILE), w);
  } else {
    carveV(grid, cols, Math.floor(a.cy / TILE), Math.floor(b.cy / TILE), Math.floor(a.cx / TILE), w);
    carveH(grid, cols, Math.floor(a.cx / TILE), Math.floor(b.cx / TILE), Math.floor(b.cy / TILE), w);
  }
  return rng.chance(0.5) ? a : b;
}

function mergeCells(grid, cols, rows, value) {
  const used = new Uint8Array(cols * rows);
  const rects = [];
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const i = y * cols + x;
      if (grid[i] !== value || used[i]) continue;
      let w = 0;
      while (x + w < cols && grid[y * cols + x + w] === value && !used[y * cols + x + w]) w += 1;
      let h = 1;
      let grow = true;
      while (grow && y + h < rows) {
        for (let k = 0; k < w; k += 1) {
          const j = (y + h) * cols + x + k;
          if (grid[j] !== value || used[j]) {
            grow = false;
            break;
          }
        }
        if (grow) h += 1;
      }
      for (let dy = 0; dy < h; dy += 1) {
        for (let dx = 0; dx < w; dx += 1) used[(y + dy) * cols + x + dx] = 1;
      }
      rects.push({ x: x * TILE, y: y * TILE, w: w * TILE, h: h * TILE });
    }
  }
  return rects;
}

function roomFloorPoint(room, rng, inset = 1.4) {
  const half = TILE / 2;
  const minX = room.x + inset * TILE;
  const maxX = room.x + room.w - inset * TILE;
  const minY = room.y + inset * TILE;
  const maxY = room.y + room.h - inset * TILE;
  return {
    x: maxX > minX ? rng.float(minX, maxX) : room.cx,
    y: maxY > minY ? rng.float(minY, maxY) : room.cy,
  };
}

/**
 * 生成一张完整地图。
 * @param {number} seed 随机种子（同种子必得同一张图）
 * @returns {object} 地图对象
 */
export function generateMap(seed) {
  const rng = createRng(seed >>> 0 || 1);
  const cols = MAP_COLS;
  const rows = MAP_ROWS;
  const grid = new Uint8Array(cols * rows).fill(CELL.WALL);

  // 1) BSP 切分 + 房间
  const root = { x: 1, y: 1, w: cols - 2, h: rows - 2 };
  buildTree(root, rng, 4);
  const leaves = collectLeaves(root, []);
  for (const leaf of leaves) leaf.room = carveRoom(grid, cols, leaf, rng);
  connectTree(root, grid, cols, rng);
  const rooms = leaves.map((l) => l.room);

  const map = {
    seed: seed >>> 0,
    cols, rows, tile: TILE,
    width: WORLD_W, height: WORLD_H,
    grid,
    rooms,
    crates: [],
    bushes: [],
    containers: [],
    extracts: [],
    terminals: [], // POI：数据终端（破解给评分 + 情报费）
    airdrop: null, // POI：限时空投 { x, y, delay, landed }
    enemySpawns: [],
    platforms: [],
    vehicles: [], // 机动载具（可驾驶，用于快速转移）
    playerSpawn: { x: rooms[0].cx, y: rooms[0].cy },
    walls: [],
  };

  // 2) 房间内掩体箱（实心，值 2）
  for (const room of rooms) {
    const count = rng.int(1, Math.max(1, Math.min(3, Math.floor((room.tw * room.th) / 12))));
    for (let i = 0; i < count; i += 1) {
      const wTiles = rng.chance(0.5) ? 1 : 2;
      const hTiles = rng.chance(0.7) ? 1 : 2;
      const tx = rng.int(room.tx + 1, Math.max(room.tx + 1, room.tx + room.tw - 1 - wTiles));
      const ty = rng.int(room.ty + 1, Math.max(room.ty + 1, room.ty + room.th - 1 - hTiles));
      let ok = true;
      for (let dy = 0; dy < hTiles; dy += 1) {
        for (let dx = 0; dx < wTiles; dx += 1) {
          if (grid[(ty + dy) * cols + tx + dx] !== CELL.FLOOR) ok = false;
        }
      }
      if (!ok) continue;
      for (let dy = 0; dy < hTiles; dy += 1) {
        for (let dx = 0; dx < wTiles; dx += 1) grid[(ty + dy) * cols + tx + dx] = CELL.CRATE;
      }
      map.crates.push({ x: tx * TILE, y: ty * TILE, w: wTiles * TILE, h: hTiles * TILE, tx, ty, tw: wTiles, th: hTiles });
    }
  }

  // 3) 连通性校验：若某个房间中心不可达，移除该房间内的掩体箱
  const spawnTile = nearestWalkableTile(map, Math.floor(rooms[0].cx / TILE), Math.floor(rooms[0].cy / TILE));
  for (let pass = 0; pass < 3; pass += 1) {
    const field = bfsFlowField(map, spawnTile.tx, spawnTile.ty);
    let broken = false;
    for (const room of rooms) {
      const idx = Math.floor(room.cy / TILE) * cols + Math.floor(room.cx / TILE);
      if (field[idx] < 0) {
        broken = true;
        for (const c of map.crates) {
          if (c.x >= room.x - TILE && c.x < room.x + room.w && c.y >= room.y - TILE && c.y < room.y + room.h) {
            for (let dy = 0; dy < c.th; dy += 1) {
              for (let dx = 0; dx < c.tw; dx += 1) grid[(c.ty + dy) * cols + c.tx + dx] = CELL.FLOOR;
            }
            c.removed = true;
          }
        }
        map.crates = map.crates.filter((c) => !c.removed);
      }
    }
    if (!broken) break;
  }

  // 4) 草丛（非实心，提供隐蔽）
  for (const room of rooms) {
    const count = rng.int(0, 2);
    for (let i = 0; i < count; i += 1) {
      const p = roomFloorPoint(room, rng, 0.8);
      if (isSolidAt(map, p.x, p.y)) continue;
      map.bushes.push({ x: p.x, y: p.y, r: rng.float(22, 34) });
    }
  }

  // 5) 容器
  const typeEntries = Object.entries(CONTAINER_SPAWN_WEIGHTS);
  let cid = 0;
  for (const room of rooms) {
    const count = Math.max(1, Math.min(3, Math.round((room.tw * room.th) / 13)));
    for (let i = 0; i < count; i += 1) {
      let placed = null;
      for (let attempt = 0; attempt < 12 && !placed; attempt += 1) {
        const p = roomFloorPoint(room, rng, 1.1);
        if (isSolidAt(map, p.x, p.y)) continue;
        if (circleHitsSolid(map, p.x, p.y, 16)) continue;
        if (map.containers.some((c) => Math.hypot(c.x - p.x, c.y - p.y) < 62)) continue;
        placed = p;
      }
      if (!placed) continue;
      const type = rng.weighted(typeEntries);
      map.containers.push({
        id: cid, type, x: Math.round(placed.x), y: Math.round(placed.y),
        r: CONTAINERS[type].radius, searched: false, loot: null, spawned: false,
      });
      cid += 1;
    }
  }

  // 6) 撤离点：优先靠近地图边缘且彼此分散的房间
  const edgeScore = (room) => Math.min(room.cx, room.cy, WORLD_W - room.cx, WORLD_H - room.cy);
  const candidates = rooms.slice().sort((a, b) => edgeScore(a) - edgeScore(b));
  const picked = [];
  for (const room of candidates) {
    if (picked.length >= MATCH.extractTotal) break;
    if (picked.some((r) => Math.hypot(r.cx - room.cx, r.cy - room.cy) < 430)) continue;
    picked.push(room);
  }
  while (picked.length < MATCH.extractTotal && candidates.length > picked.length) {
    const room = candidates[picked.length % candidates.length];
    if (!picked.includes(room)) picked.push(room);
    else break;
  }
  const names = ['撤离点 ALPHA', '撤离点 BRAVO', '撤离点 CHARLIE'];
  picked.slice(0, MATCH.extractTotal).forEach((room, i) => {
    let point = null;
    for (let attempt = 0; attempt < 24 && !point; attempt += 1) {
      const p = roomFloorPoint(room, rng, 1.0);
      if (isSolidAt(map, p.x, p.y)) continue;
      point = p;
    }
    if (!point) point = { x: room.cx, y: room.cy };
    map.extracts.push({
      id: i,
      name: names[i] || `撤离点 ${i + 1}`,
      x: Math.round(point.x),
      y: Math.round(point.y),
      r: MATCH.extractRadius,
      open: false,
    });
  });

  // 7) 玩家出生点：离所有撤离点最远的房间（房间按"离撤离点距离"降序逐个尝试合法落点）
  const spawnCandidates = rooms.slice().sort((a, b) => {
    const sa = Math.min(...map.extracts.map((e) => Math.hypot(e.x - a.cx, e.y - a.cy)));
    const sb = Math.min(...map.extracts.map((e) => Math.hypot(e.x - b.cx, e.y - b.cy)));
    return sb - sa;
  });
  let spawnPoint = null;
  for (const room of spawnCandidates) {
    for (let attempt = 0; attempt < 24 && !spawnPoint; attempt += 1) {
      const p = roomFloorPoint(room, rng, 1.2);
      if (isSolidAt(map, p.x, p.y) || circleHitsSolid(map, p.x, p.y, PLAYER_SPAWN_R)) continue;
      spawnPoint = p;
    }
    if (spawnPoint) break;
  }
  if (!spawnPoint) {
    const st = nearestWalkableTile(map, Math.floor(rooms[0].cx / TILE), Math.floor(rooms[0].cy / TILE));
    spawnPoint = { x: st.tx * TILE + TILE / 2, y: st.ty * TILE + TILE / 2 };
  }
  map.playerSpawn = { x: Math.round(spawnPoint.x), y: Math.round(spawnPoint.y) };
  const spawnTileFinal = nearestWalkableTile(
    map, Math.floor(map.playerSpawn.x / TILE), Math.floor(map.playerSpawn.y / TILE),
  );
  const spawnField = bfsFlowField(map, spawnTileFinal.tx, spawnTileFinal.ty);

  // 7.5) POI：数据终端（放在房间里，彼此分散且不在出生点附近）
  const terminalRooms = rng.shuffle(rooms.slice());
  let tid = 0;
  for (const room of terminalRooms) {
    if (map.terminals.length >= MATCH.terminalCount) break;
    if (Math.hypot(room.cx - map.playerSpawn.x, room.cy - map.playerSpawn.y) < TILE * 5) continue;
    let placed = null;
    for (let attempt = 0; attempt < 16 && !placed; attempt += 1) {
      const p = roomFloorPoint(room, rng, 1.2);
      if (isSolidAt(map, p.x, p.y) || circleHitsSolid(map, p.x, p.y, 16)) continue;
      if (map.terminals.some((t) => Math.hypot(t.x - p.x, t.y - p.y) < 260)) continue;
      placed = p;
    }
    if (!placed) continue;
    map.terminals.push({
      id: tid, x: Math.round(placed.x), y: Math.round(placed.y),
      r: POI.terminalRadius, hacked: false,
    });
    tid += 1;
  }

  // 7.6) POI：限时空投落点（必须能从出生点走到，且离出生点有一定距离）
  {
    let drop = null;
    for (let relax = 0; relax < 3 && !drop; relax += 1) {
      const minDist = relax === 0 ? 520 : relax === 1 ? 320 : 0;
      for (let attempt = 0; attempt < 60 && !drop; attempt += 1) {
        const room = rng.pick(rooms);
        const p = roomFloorPoint(room, rng, 1.3);
        if (isSolidAt(map, p.x, p.y) || circleHitsSolid(map, p.x, p.y, 26)) continue;
        if (Math.hypot(p.x - map.playerSpawn.x, p.y - map.playerSpawn.y) < minDist) continue;
        const idx = Math.floor(p.y / TILE) * cols + Math.floor(p.x / TILE);
        if (spawnField[idx] < 0) continue;
        drop = p;
      }
    }
    if (!drop) drop = { x: map.playerSpawn.x, y: map.playerSpawn.y };
    map.airdrop = {
      x: Math.round(drop.x), y: Math.round(drop.y),
      r: POI.airdropRadius,
      delay: MATCH.airdropDelay,
      landed: false,
    };
  }

  // 8) 撤离点默认全部关闭：固定 2 个点，统一在「最后 2 分钟」由 main.js 打开。
  //    （不在此处随机开放，避免早期就能撤离 —— 撤离窗口本来就压在局末。）
  for (const ex of map.extracts) ex.open = false;

  // 8.5) 撤离点类型：free / paid / guarded
  // 保证第一个撤离点免费（免费通道永远存在），其余随机为付费或守点。
  for (const ex of map.extracts) ex.kind = 'free';
  const kinded = rng.shuffle(map.extracts.slice());
  kinded.forEach((ex, i) => {
    if (i === 0) return; // 保底免费撤离点
    ex.kind = rng.chance(0.5) ? 'paid' : 'guarded';
    if (ex.kind === 'paid') ex.cost = MATCH.extractFee;
  });

  // 9) 敌人出生点
  const enemyCount = rng.int(MATCH.enemyCountMin, MATCH.enemyCountMax);
  // 敌人不刷在玩家出生房间（按离出生点距离剔除）
  const spawnRooms = rooms.filter(
    (r) => Math.hypot(r.cx - map.playerSpawn.x, r.cy - map.playerSpawn.y) > TILE * 6,
  );
  const pool = spawnRooms.length ? spawnRooms : rooms;
  for (let i = 0; i < enemyCount; i += 1) {
    let pos = null;
    // 逐步放宽"远离玩家出生点"的要求，保证一定能落到合法地面上
    for (let relax = 0; relax < 3 && !pos; relax += 1) {
      const minDist = relax === 0 ? 430 : relax === 1 ? 260 : 0;
      for (let attempt = 0; attempt < 40 && !pos; attempt += 1) {
        const p = roomFloorPoint(rng.pick(pool), rng, 1.2);
        if (isSolidAt(map, p.x, p.y) || circleHitsSolid(map, p.x, p.y, 14)) continue;
        if (Math.hypot(p.x - map.playerSpawn.x, p.y - map.playerSpawn.y) < minDist) continue;
        // 敌人出生点必须能从玩家出生点走到，避免生成在封闭孤岛
        const idx = Math.floor(p.y / TILE) * cols + Math.floor(p.x / TILE);
        if (spawnField[idx] < 0) continue;
        pos = p;
      }
    }
    if (!pos) {
      const st = nearestWalkableTile(map, Math.floor(map.playerSpawn.x / TILE), Math.floor(map.playerSpawn.y / TILE));
      pos = { x: st.tx * TILE + TILE / 2, y: st.ty * TILE + TILE / 2 };
    }
    map.enemySpawns.push({
      x: Math.round(pos.x),
      y: Math.round(pos.y),
      // 按权重混编四种兵种（巡逻 / 冲锋 / 精确射手 / 精英）
      type: rng.weighted(ENEMY_TYPE_ENTRIES),
    });
  }

  // 9.4) 架高平台：在大房间内部挑空地架台 —— 站上去抬高视点，并能越过掩体箱观察。
  // 平台格本身仍是 FLOOR（可通行），高程只是附加属性，因此不影响连通性与碰撞。
  {
    const wanted = Math.max(0, MATCH.platformCount || 0);
    const pad = 18;
    // 注意：room.x / room.w 是**世界坐标**（见 roomFloorPoint），需要先换算成格
    const bigRooms = map.rooms
      .filter((r) => r.w >= 5 * TILE && r.h >= 5 * TILE)
      .sort(() => rng.float(-1, 1));
    const fits = (tx, ty, tw, th) => {
      for (let y = ty; y < ty + th; y += 1) {
        for (let x = tx; x < tx + tw; x += 1) {
          if (isTileSolid(map, x, y)) return false;
        }
      }
      const x0 = tx * TILE;
      const y0 = ty * TILE;
      const x1 = x0 + tw * TILE;
      const y1 = y0 + th * TILE;
      const near = (px, py, r) => px + r > x0 - pad && px - r < x1 + pad
        && py + r > y0 - pad && py - r < y1 + pad;
      // 不压容器 / 撤离点 / 终端 / 出生点：否则交互物会悬空或被台面挡住
      for (const c of map.containers) if (near(c.x, c.y, c.r || 16)) return false;
      for (const ex of (map.extracts || [])) if (near(ex.x, ex.y, ex.r || 40)) return false;
      for (const t of (map.terminals || [])) if (near(t.x, t.y, POI.terminalRadius)) return false;
      if (map.playerSpawn && near(map.playerSpawn.x, map.playerSpawn.y, 24)) return false;
      // 与已放下的平台保持至少一格间距
      for (const p of map.platforms) {
        if (x0 < p.x + p.w + TILE && p.x - TILE < x1 && y0 < p.y + p.h + TILE && p.y - TILE < y1) return false;
      }
      return true;
    };
    for (const room of bigRooms) {
      if (map.platforms.length >= wanted) break;
      const roomTw = Math.floor(room.w / TILE) - 2;
      const roomTh = Math.floor(room.h / TILE) - 2;
      if (roomTw < 2 || roomTh < 2) continue;
      const tw = Math.max(2, Math.min(4, Math.floor(roomTw / 3)));
      const th = Math.max(2, Math.min(4, Math.floor(roomTh / 3)));
      const tx0 = Math.ceil(room.x / TILE) + 1;
      const ty0 = Math.ceil(room.y / TILE) + 1;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const tx = tx0 + Math.floor(rng.float(0, Math.max(1, roomTw - tw)));
        const ty = ty0 + Math.floor(rng.float(0, Math.max(1, roomTh - th)));
        if (!fits(tx, ty, tw, th)) continue;
        map.platforms.push({
          x: tx * TILE, y: ty * TILE, w: tw * TILE, h: th * TILE, tx, ty, tw, th,
        });
        break;
      }
    }
  }

  // 9.5) 守点撤离点：在撤离点附近额外部署精英守卫（guardOf 交给 enemy.js 做拴绳）
  for (const ex of map.extracts) {
    if (ex.kind !== 'guarded') continue;
    let gp = null;
    for (let attempt = 0; attempt < 24 && !gp; attempt += 1) {
      const a = rng.float(0, Math.PI * 2);
      const d = rng.float(60, 140);
      const p = { x: ex.x + Math.cos(a) * d, y: ex.y + Math.sin(a) * d };
      if (isSolidAt(map, p.x, p.y) || circleHitsSolid(map, p.x, p.y, 14)) continue;
      gp = p;
    }
    if (!gp) gp = { x: ex.x, y: ex.y };
    map.enemySpawns.push({
      x: Math.round(gp.x), y: Math.round(gp.y), type: 'elite', guardOf: ex.id,
    });
  }

  // 9.6) 机动载具：停在大房间的空地上，用于快速转移。
  // 只要求"周围够空旷能开出去"，不写进 grid（不是静态障碍），碰撞由玩家驾驶时自行处理。
  if (VEHICLE.enabled) {
    const wanted = Math.round(rng.float(VEHICLE.count[0], VEHICLE.count[1]));
    const clear = VEHICLE.radius + 18; // 预留出一圈能开动的余量
    const rooms = map.rooms.slice().sort(() => rng.float(-1, 1));
    for (const room of rooms) {
      if (map.vehicles.length >= wanted) break;
      if (room.w < 6 * TILE || room.h < 6 * TILE) continue;
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const p = roomFloorPoint(room, rng, 1.4);
        if (isSolidAt(map, p.x, p.y) || circleHitsSolid(map, p.x, p.y, clear)) continue;
        // 别压在交互物 / 撤离点 / 平台上
        let bad = false;
        const near = (q, r) => Math.hypot(q.x - p.x, q.y - p.y) < r;
        for (const c of map.containers) if (near(c, (c.r || 16) + clear)) bad = true;
        for (const ex of (map.extracts || [])) if (near(ex, (ex.r || 40) + clear)) bad = true;
        for (const t of (map.terminals || [])) if (near(t, POI.terminalRadius + clear)) bad = true;
        for (const pl of map.platforms) {
          if (p.x > pl.x - clear && p.x < pl.x + pl.w + clear
            && p.y > pl.y - clear && p.y < pl.y + pl.h + clear) bad = true;
        }
        if (bad) continue;
        map.vehicles.push({
          id: `veh${map.vehicles.length}`,
          x: Math.round(p.x),
          y: Math.round(p.y),
          angle: rng.float(0, Math.PI * 2),
          speed: 0,
          driver: null,
        });
        break;
      }
    }
  }

  // 10) 合并实心格为矩形（渲染用）
  map.walls = mergeCells(grid, cols, rows, CELL.WALL);
  map.crateRects = mergeCells(grid, cols, rows, CELL.CRATE);
  initCrateState(map); // 为每个掩体箱 rect 初始化可破坏血量

  return map;
}

/**
 * 在房间内随机取一个可通行的世界坐标点。
 * @param {object} map 地图
 * @param {object} room 房间
 * @param {object} rng 随机数发生器
 * @returns {{x: number, y: number}} 世界坐标
 */
export function randomPointInRoom(map, room, rng) {
  for (let i = 0; i < 24; i += 1) {
    const p = roomFloorPoint(room, rng, 1.1);
    if (!isSolidAt(map, p.x, p.y) && !circleHitsSolid(map, p.x, p.y, 14)) return p;
  }
  return { x: room.cx, y: room.cy };
}

/**
 * 统计从某格出发可达的地面格数量（连通性检查用）。
 * @param {object} map 地图
 * @param {number} tx 起始列
 * @param {number} ty 起始行
 * @returns {number} 可达格数
 */
export function reachableCount(map, tx, ty) {
  const field = bfsFlowField(map, tx, ty);
  let n = 0;
  for (let i = 0; i < field.length; i += 1) if (field[i] >= 0) n += 1;
  return n;
}
