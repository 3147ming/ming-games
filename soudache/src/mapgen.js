/**
 * 程序化战术地图生成 + 视线检测 + 寻路流场（纯逻辑模块）
 *
 * 算法：BSP 二叉空间切分生成房间 → 递归连接兄弟节点打通走廊（保证全图连通）
 *      → 房间内撒掩体箱 / 草丛 / 容器 → 合并实心格为矩形（供渲染）
 * 依赖：config.js（常量）、rng.js（可复现随机）
 */

import {
  TILE, CELL, MATCH, VIEW3D,
  CONTAINERS, CONTAINER_SPAWN_WEIGHTS, POI, ENEMY_SPAWN_WEIGHTS, CRATE, VEHICLE,
  MAPS, DEFAULT_MAP_ID, POI_NAMES, HUD, TERRAIN3D,
} from './config.js';
import { createRng } from './rng.js';
import { buildAreaPlan } from './areas.js';
import { EXTRACT_LAYOUT } from './extract.js';

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

/**
 * 该点上方是否有屋顶，有就返回层高（米）；露天返回 Infinity。
 *
 * 用途：跳跃/翻越时把离地高度夹在天花板以下。没有这条约束时，
 * 站在架高平台（1.25m）上一跳，相机直接穿出楼板 —— 室内会看到"从屋顶里穿出去"的破面。
 * 判定只读 map.rooms 的 indoor 标记，与渲染层盖顶用的是同一份数据，不会出现
 * "看着有顶、撞不到"或"看着露天、却被夹住"的错位。
 *
 * @param {object} map 地图
 * @param {number} x 世界 x
 * @param {number} y 世界 y
 * @returns {number} 层高（米）或 Infinity
 */
export function ceilingHeightAt(map, x, y) {
  const rooms = map && map.rooms;
  if (!rooms) return Infinity;
  for (let i = 0; i < rooms.length; i += 1) {
    const r = rooms[i];
    if (r.indoor === false) continue;
    // 每栋楼的层高不同（1~3 层）：返回该分区自己的高度，跳/翻越才不会穿出屋顶
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
      return Number.isFinite(r.wallHeight) && r.wallHeight > 0 ? r.wallHeight : VIEW3D.wallHeight;
    }
  }
  return Infinity;
}

/**
 * 该点的**墙体高度**（米）。非墙格 / 越界返回基准层高。
 *
 * 与 `ceilingHeightAt` 的分工：那个回答"头顶有没有屋顶"，这个回答"这面墙多高"。
 * 弹道要用后者：子弹越过 4.2m 的矮墙可以打到后面的人，但 12.6m 的楼必须挡住。
 * 数据源是生成期算好的 `map.wallHeightGrid`，渲染与判定读同一份，不会出现
 * "看着三层的楼，子弹从二楼穿过去"。
 *
 * @param {object} map 地图
 * @param {number} x 世界 x
 * @param {number} y 世界 y
 * @returns {number} 墙高（米）
 */
export function wallHeightAt(map, x, y) {
  if (!map || !map.wallHeightGrid) return VIEW3D.wallHeight;
  const tx = Math.floor(x / map.tile);
  const ty = Math.floor(y / map.tile);
  if (tx < 0 || ty < 0 || tx >= map.cols || ty >= map.rows) return VIEW3D.wallHeight;
  const h = map.wallHeightGrid[ty * map.cols + tx];
  return Number.isFinite(h) && h > 0 ? h : VIEW3D.wallHeight;
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
 * 该点是否被实体（墙 / 掩体箱）占据。供投掷物的墙面反弹使用：
 * 视线函数只回答"看不看得见"，投掷物需要的是"能不能穿过"，语义不同，不能复用。
 * @param {object} map 地图
 * @param {number} wx 世界 x
 * @param {number} wy 世界 y
 * @returns {boolean} 是否实体
 */
export function solidAt(map, wx, wy) {
  const tx = Math.floor(wx / map.tile);
  const ty = Math.floor(wy / map.tile);
  if (tx < 0 || ty < 0 || tx >= map.cols || ty >= map.rows) return true;
  const cell = map.grid[ty * map.cols + tx];
  return cell === CELL.WALL || cell === CELL.CRATE;
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
 * 世界坐标处的地形高度（米，W7 缓坡）：从 terrainGrid 双线性采样。
 *
 * ⚠ 采样而非取格值：逐格取值会让 2m 一格的地面变成台阶，玩家走上去一颠一颠、
 * 子弹高度判定也会在格边界跳变。双线性插值保证高度连续。
 * 旧地图 / 无地形字段时恒返回 0（向后兼容，不需要迁移存档）。
 * @param {object} map 地图
 * @param {number} x 世界 x
 * @param {number} y 世界 y
 * @returns {number} 地形高度（米）
 */
export function terrainHeightAt(map, x, y) {
  const g = map && map.terrainGrid;
  if (!g || !map.terrainGridInfo) return 0;
  const { cols, rows, tile } = map.terrainGridInfo;
  // 格中心坐标 = (tx+0.5)*tile；采样点落在四个中心之间 → 换算到中心坐标系
  const fx = x / tile - 0.5;
  const fy = y / tile - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const sx = fx - x0;
  const sy = fy - y0;
  const at = (tx, ty) => {
    if (tx < 0 || ty < 0 || tx >= cols || ty >= rows) return 0;
    return g[ty * cols + tx];
  };
  const a = at(x0, y0); const b = at(x0 + 1, y0);
  const c = at(x0, y0 + 1); const d = at(x0 + 1, y0 + 1);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}

/**
 * 世界坐标处的站立高度（米）：地形缓坡与架高平台取高者。
 *
 * ⚠ 设计要点：平台格本身仍是 CELL.FLOOR（可通行），高程只是一个**附加属性**。
 * 因此平台不改变连通性、不参与碰撞，也就不会破坏"敌人出生点必须可达"这类既有保证 ——
 * 这正是把垂直结构做成"架高平台"而非"真正的二层"的原因。
 * W7：地形缓坡也走同一条真值链 —— 视觉、碰撞、弹道、投掷、AI 视野全部读这一个函数，
 * 不会出现"看着有坡、子弹却按平地算"的分裂。
 * @param {object} map 地图
 * @param {number} x 世界 x
 * @param {number} y 世界 y
 * @returns {number} 高度（米）
 */
export function elevationAt(map, x, y) {
  const terrain = terrainHeightAt(map, x, y);
  const platform = platformHeightAt(map, x, y);
  return platform > terrain ? platform : terrain;
}

/**
 * 架高平台高度（米）：只认 platform 矩形，不含地形缓坡。
 *
 * 为什么单独有它：几处"是否已经站在平台上"的判断（敌人出生点过滤、AI 抢占高地）
 * 在 W7 之前写的是 `elevationAt(...) > 0.5`。若直接沿用，缓坡也会被误判成"平台"，
 * 敌人就不刷在坡上、AI 也不去抢真高地 —— 布局会悄悄漂移（golden 会红）。
 * 这些地方语义是"平台"而非"高度"，必须读这个专门的真值。
 * @param {object} map 地图
 * @param {number} x 世界 x
 * @param {number} y 世界 y
 * @returns {number} 平台高度（米），不在平台上返回 0
 */
export function platformHeightAt(map, x, y) {
  const plats = map && map.platforms;
  if (!plats || !plats.length) return 0;
  for (let i = 0; i < plats.length; i += 1) {
    const p = plats[i];
    if (x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h) return VIEW3D.platformHeight;
  }
  return 0;
}

/* ============================ W7 露天缓坡地形 ============================ */

/**
 * 为露天广场生成缓坡高度场（独立 RNG 分叉，不动主序列）。
 *
 * 做法：每个 plaza room 撒 1~3 个"丘"，丘心在房间内、半径按房间尺寸取，
 * 高度按高斯衰减叠加；再乘一层边缘 fade，让靠近墙的一圈高度降到 0 ——
 * 否则广场边缘的地面会比墙脚高，视觉上就是"墙陷进土里"。
 *
 * ⚠ 只写 plaza 格（room.indoor === false）：室内地板保持 0，房间/走廊/墙体不受影响。
 * 高度存在**格中心**，采样时双线性插值（见 terrainHeightAt），所以格边界连续。
 *
 * @param {object} map 已建好的地图对象（需要 rooms / grid / cols / rows / tile）
 * @param {object} rng 独立子流（调用方用 rng.fork(TERRAIN3D.forkSalt) 生成）
 * @returns {{grid:Float32Array, info:object}} 高度场
 */
export function generateTerrain(map, rng) {
  const { cols, rows, tile } = map;
  const grid = new Float32Array(cols * rows);
  const info = { cols, rows, tile };
  if (!TERRAIN3D.enabled) return { grid, info };

  const plazas = (map.rooms || []).filter((r) => r.indoor === false && r.plaza);
  for (const room of plazas) {
    const tw = room.tw; const th = room.th;
    if (tw < 4 || th < 4) continue; // 太小的空地做坡只会像土包
    const n = Math.max(TERRAIN3D.hillCountMin,
      Math.min(TERRAIN3D.hillCountMax, rng.int(TERRAIN3D.hillCountMin, TERRAIN3D.hillCountMax)));
    const hills = [];
    for (let i = 0; i < n; i += 1) {
      hills.push({
        tx: room.tx + rng.float(1, tw - 1),
        ty: room.ty + rng.float(1, th - 1),
        rx: Math.max(2, tw * rng.float(0.28, 0.52)),
        ry: Math.max(2, th * rng.float(0.28, 0.52)),
        amp: rng.float(TERRAIN3D.amplitudeMin, TERRAIN3D.amplitudeMax),
      });
    }
    const fadeTiles = Math.max(1, Math.min(tw, th) * TERRAIN3D.edgeFade);
    for (let ty = room.ty; ty < room.ty + th; ty += 1) {
      for (let tx = room.tx; tx < room.tx + tw; tx += 1) {
        const idx = ty * cols + tx;
        if (map.grid[idx] !== CELL.FLOOR) continue; // 墙/箱格不抬高，避免压进障碍
        // 边缘 fade：离最近房间边界不足 fadeTiles 时线性降到 0
        const edge = Math.min(
          tx - room.tx, room.tx + tw - 1 - tx,
          ty - room.ty, room.ty + th - 1 - ty,
        );
        const fade = Math.min(1, edge / fadeTiles);
        if (fade <= 0) continue;
        let h = 0;
        for (const hill of hills) {
          const dx = (tx + 0.5 - hill.tx) / hill.rx;
          const dy = (ty + 0.5 - hill.ty) / hill.ry;
          h += hill.amp * Math.exp(-2.2 * (dx * dx + dy * dy));
        }
        grid[idx] = Math.min(h * fade, TERRAIN3D.amplitudeMax);
      }
    }
  }
  return { grid, info };
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

/**
 * 在网格上挖一个矩形房间。
 *
 * rows 必须由调用方传入而不是读全局 MAP_ROWS：两张地图虽然当前同为 60×45，
 * 但生成函数不该再把"世界有多大"写死，否则以后换尺寸时 BSP 边界会静默错位。
 */
function carveRect(grid, cols, rows, x, y, w, h) {
  for (let ty = y; ty < y + h; ty += 1) {
    if (ty < 1 || ty >= rows - 1) continue;
    for (let tx = x; tx < x + w; tx += 1) {
      if (tx < 1 || tx >= cols - 1) continue;
      grid[ty * cols + tx] = CELL.FLOOR;
    }
  }
}

function carveH(grid, cols, rows, x1, x2, y, h) {
  const y0 = Math.max(1, Math.min(rows - 1 - h, y));
  const a = Math.max(1, Math.min(x1, x2));
  const b = Math.min(cols - 2, Math.max(x1, x2));
  for (let x = a; x <= b; x += 1) {
    for (let dy = 0; dy < h; dy += 1) grid[(y0 + dy) * cols + x] = CELL.FLOOR;
  }
}

function carveV(grid, cols, rows, y1, y2, x, w) {
  const x0 = Math.max(1, Math.min(cols - 1 - w, x));
  const a = Math.max(1, Math.min(y1, y2));
  const b = Math.min(rows - 2, Math.max(y1, y2));
  for (let y = a; y <= b; y += 1) {
    for (let dx = 0; dx < w; dx += 1) grid[y * cols + x0 + dx] = CELL.FLOOR;
  }
}

const DEFAULT_LEAF_MIN = 9;
/** 出生点校验时使用的碰撞半径，略大于玩家半径以留出余量 */
const PLAYER_SPAWN_R = 15;

function buildTree(node, rng, depth, minLeaf = DEFAULT_LEAF_MIN) {
  if (depth <= 0) {
    node.leaf = true;
    return node;
  }
  const canH = node.h >= minLeaf * 2;
  const canV = node.w >= minLeaf * 2;
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
    const cut = rng.int(minLeaf, node.h - minLeaf);
    node.left = { x: node.x, y: node.y, w: node.w, h: cut };
    node.right = { x: node.x, y: node.y + cut, w: node.w, h: node.h - cut };
  } else {
    const cut = rng.int(minLeaf, node.w - minLeaf);
    node.left = { x: node.x, y: node.y, w: cut, h: node.h };
    node.right = { x: node.x + cut, y: node.y, w: node.w - cut, h: node.h };
  }
  buildTree(node.left, rng, depth - 1, minLeaf);
  buildTree(node.right, rng, depth - 1, minLeaf);
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

function carveRoom(grid, cols, rows, leaf, rng, fillMin = 0.62) {
  const maxW = Math.max(3, leaf.w - 2);
  const maxH = Math.max(3, leaf.h - 2);
  const w = rng.int(Math.max(3, Math.ceil(maxW * fillMin)), maxW);
  const h = rng.int(Math.max(3, Math.ceil(maxH * fillMin)), maxH);
  const x = leaf.x + 1 + rng.int(0, Math.max(0, maxW - w));
  const y = leaf.y + 1 + rng.int(0, Math.max(0, maxH - h));
  carveRect(grid, cols, rows, x, y, w, h);
  return {
    tx: x, ty: y, tw: w, th: h,
    x: x * TILE, y: y * TILE, w: w * TILE, h: h * TILE,
    cx: (x + w / 2) * TILE, cy: (y + h / 2) * TILE,
    indoor: true,
  };
}

/**
 * 露天广场：把整个叶子挖空，**不留四周围墙**。
 *
 * 这是"大地图"和"大号室内迷宫"的分界线：BSP 只切分区，不切建筑；
 * 被抽中做广场的叶子整块变成可行走地面，相邻广场会连成一片开阔地，
 * 建筑只出现在剩下的叶子里 —— 于是有了"街区 / 货场 / 停车场"，
 * 而不是"更大的走廊网"。渲染层按 `indoor:false` 决定不给它盖屋顶。
 *
 * @returns {object} 与 carveRoom 同构的 room 记录（indoor=false）
 */
function carvePlaza(grid, cols, rows, leaf) {
  const x = leaf.x;
  const y = leaf.y;
  const w = leaf.w;
  const h = leaf.h;
  carveRect(grid, cols, rows, x, y, w, h);
  return {
    tx: x, ty: y, tw: w, th: h,
    x: x * TILE, y: y * TILE, w: w * TILE, h: h * TILE,
    cx: (x + w / 2) * TILE, cy: (y + h / 2) * TILE,
    indoor: false,
    plaza: true,
  };
}

function connectTree(node, grid, cols, rows, rng, width = 2) {
  if (node.leaf) return node.room;
  const a = connectTree(node.left, grid, cols, rows, rng, width);
  const b = connectTree(node.right, grid, cols, rows, rng, width);
  const w = width;
  if (rng.chance(0.5)) {
    carveH(grid, cols, rows, Math.floor(a.cx / TILE), Math.floor(b.cx / TILE), Math.floor(a.cy / TILE), w);
    carveV(grid, cols, rows, Math.floor(a.cy / TILE), Math.floor(b.cy / TILE), Math.floor(b.cx / TILE), w);
  } else {
    carveV(grid, cols, rows, Math.floor(a.cy / TILE), Math.floor(b.cy / TILE), Math.floor(a.cx / TILE), w);
    carveH(grid, cols, rows, Math.floor(a.cx / TILE), Math.floor(b.cx / TILE), Math.floor(b.cy / TILE), w);
  }
  return rng.chance(0.5) ? a : b;
}

/**
 * 额外环路：在随机两个房间中心之间再挖一条 L 形通道。
 *
 * 为什么窄图需要这个：1 格宽走廊的 BSP 树本质是一棵树，任意一条走廊被打断/
 * 被箱子挤窄，后面就是一整片死胡同。多挖几条环路把树变成网，
 * 玩家才有"换一条路绕回去"的选择，窄图也才敢往里走。
 * 只挖地面、不拆墙以外的东西，因此只会改善连通性，不会制造不可达区域。
 */
function carveLoops(grid, cols, rows, rooms, rng, count, width) {
  for (let i = 0; i < count; i += 1) {
    const a = rng.pick(rooms);
    const b = rng.pick(rooms);
    if (!a || !b || a === b) continue;
    const ax = Math.floor(a.cx / TILE);
    const ay = Math.floor(a.cy / TILE);
    const bx = Math.floor(b.cx / TILE);
    const by = Math.floor(b.cy / TILE);
    if (rng.chance(0.5)) {
      carveH(grid, cols, rows, ax, bx, ay, width);
      carveV(grid, cols, rows, ay, by, bx, width);
    } else {
      carveV(grid, cols, rows, ay, by, ax, width);
      carveH(grid, cols, rows, ax, bx, by, width);
    }
  }
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
 * 解析地图定义：接受地图 id、地图定义对象，或空值（默认旧图）。
 * 未知 id 直接抛错 —— 地图 id 只可能来自 MAPS 与 UI 常量，静默回落成旧图
 * 会让"选错图"变成一张看起来正常、实际不是玩家想要的局，更难排查。
 * @param {string|object|undefined} mapId 地图 id / 定义 / 空
 * @returns {object} 地图定义
 */
function resolveMapDef(mapId) {
  if (mapId && typeof mapId === 'object') return mapId;
  const id = mapId == null ? DEFAULT_MAP_ID : String(mapId);
  const def = MAPS[id];
  if (!def) throw new Error(`未知地图 id: ${id}`);
  return def;
}

/**
 * 生成一张完整地图。
 *
 * 同一 seed 必得同一张图；第二参数只决定"用哪套地形参数"，不改变随机源。
 * 旧图（不传 mapId）的随机调用顺序必须与历史版本逐次一致 ——
 * 新增参数只允许以"值为旧字面量"的方式接入，绝不能多消耗一次 rng。
 * @param {number} seed 随机种子
 * @param {string|object} [mapId] 地图 id（'depot' / 'conduit'）或地图定义
 * @returns {object} 地图对象
 */
export function generateMap(seed, mapId, opts = {}) {
  const def = resolveMapDef(mapId);
  const rng = createRng(seed >>> 0 || 1);
  const cols = def.cols;
  const rows = def.rows;
  const grid = new Uint8Array(cols * rows).fill(CELL.WALL);

  // 1) BSP 切分 + 房间
  const root = { x: 1, y: 1, w: cols - 2, h: rows - 2 };
  buildTree(root, rng, def.bspDepth, def.leafMin);
  const leaves = collectLeaves(root, []);
  // 抽签决定哪些叶子是"露天广场"（不盖顶、不留围墙）。抽签用独立子流，
  // 不动主 rng 序列：改了 roomSkipChance 也不该让房间尺寸/容器位置跟着漂。
  const plazaRng = rng.fork(0x9e3779b1);
  for (const leaf of leaves) {
    const skip = def.roomSkipChance || 0;
    // 先取随机数再判尺寸：抽签顺序与叶子大小无关，改尺寸阈值不会让整图 rng 漂移。
    const roll = plazaRng.chance(skip);
    // 小叶子不做广场：屋顶要外扩盖住墙顶（约 1 格），太小的空地会被两侧屋檐挤成天窗，
    // 既不像广场也不像院子，反而把"能看见天空"的面积浪费掉。
    leaf.plaza = roll && skip > 0 && leaf.w >= 6 && leaf.h >= 5;
    leaf.room = leaf.plaza
      ? carvePlaza(grid, cols, rows, leaf)
      : carveRoom(grid, cols, rows, leaf, rng, def.roomFillMin);
  }
  connectTree(root, grid, cols, rows, rng, def.corridorWidth);
  // 只对窄图额外加环路：disconnected 的树状走廊在 1 格宽时太容易变成死胡同。
  if (def.loopCorridors > 0) {
    carveLoops(grid, cols, rows, leaves.map((l) => l.room), rng, def.loopCorridors, def.corridorWidth);
  }
  const rooms = leaves.map((l) => l.room);

  /* ---------------- 建筑高度分层 ----------------
   * 单层等高的方块城永远不可能像城市：天际线是一条水平线，远看就是一圈围墙。
   * 这里给每个**室内**分区抽一个层数（1~3 层 = 4.2 / 8.4 / 12.6m），
   * 屋顶设备（女儿墙/水箱/机组/天线）在 level3d 里按层数挂上去。
   *
   * ⚠ 抽签走独立子流 `0x5ee1`：不动主 rng 序列，否则房间尺寸、容器位置、
   * 敌人出生点会跟着漂，golden 哈希全变，改动会变成"哪里都动了"。
   * 图层高度写进 `room.wallHeight`（米），是渲染 / 天花板夹取 / 弹道遮挡的**唯一真值**。
   */
  const heightRng = rng.fork(0x5ee1);
  const table = def.heightFloors || [0.5, 0.36, 0.14];
  const t0 = table[0];
  const t1 = table[0] + table[1];
  for (const room of rooms) {
    if (room.indoor === false) { room.floors = 0; room.wallHeight = 0; continue; }
    const roll = heightRng.float(0, 1);
    const floors = roll < t0 ? 1 : (roll < t1 ? 2 : 3);
    room.floors = floors;
    room.wallHeight = VIEW3D.wallHeight * floors;
  }

  /**
   * 墙体高度网格：**墙格**取相邻建筑的最高层，其余保持基准层高。
   *
   * 为什么要有它：`map.walls` 是一堆矩形，渲染、弹道、跳跃夹取都按"一个全局墙高"算。
   * 一旦建筑有高低差，同一个 4.2m 常量就会让高楼的墙在画面上只有半截，
   * 或者让子弹穿透 12m 的楼 —— 必须有一份"这个格子上的墙有多高"的真值表。
   * 只写建筑外扩 1 圈的**边界**：那是墙所在的位置；房间里与走廊上的值不参与判定。
   */
  const heightGrid = new Float32Array(cols * rows).fill(VIEW3D.wallHeight);
  for (const room of rooms) {
    if (room.indoor === false) continue;
    const x0 = Math.max(0, room.tx - 1); const x1 = Math.min(cols - 1, room.tx + room.tw);
    const y0 = Math.max(0, room.ty - 1); const y1 = Math.min(rows - 1, room.ty + room.th);
    for (let ty = y0; ty <= y1; ty += 1) {
      for (let tx = x0; tx <= x1; tx += 1) {
        const i = ty * cols + tx;
        // 只写**实心墙格**：房间内部与走廊的格值不参与任何判定，
        // 写进去反而会让"相邻高楼的外圈"污染别人的室内格（多栋共用一堵墙时取最高是对的，
        // 但楼内中心格被邻居抬高就是错的）。
        if (grid[i] !== CELL.WALL) continue;
        if (heightGrid[i] < room.wallHeight) heightGrid[i] = room.wallHeight;
      }
    }
  }

  const map = {
    // 地图身份：只用于 UI / 结算展示，不参与生成，也不进 golden 哈希。
    id: def.id,
    name: def.name,
    tagline: def.tagline,
    desc: def.desc,
    seed: seed >>> 0,
    cols, rows, tile: TILE,
    // 尺寸由 cols/rows 派生：换画面尺寸时不再需要同步改全局常量。
    width: cols * TILE, height: rows * TILE,
    grid,
    rooms,
    // 每个墙格的实际高度（米）。渲染挤出、弹道遮挡、跳跃夹取都读它。
    wallHeightGrid: heightGrid,
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

  // 1.5) W7 露天缓坡地形。独立 RNG 分叉，不动主序列；新字段不进 GOLDEN 快照。
  //      必须早于任何 elevationAt 调用（敌人出生点过滤、落位），让它们看到真实高程。
  {
    const terrain = generateTerrain(map, rng.fork(TERRAIN3D.forkSalt));
    map.terrainGrid = terrain.grid;
    map.terrainGridInfo = terrain.info;
  }

  // 2) 房间内掩体箱（实心，值 2）
  for (const room of rooms) {
    // 露天广场单独给上限：按房间那套（上限 3）会让几十米的空地只剩两个箱子，
    // 室外对枪就成了"谁先跑谁死"的裸奔。货场/停车场本来该堆满集装箱。
    const crateCap = room.plaza ? (def.plazaCrateMax || 8) : def.crateCountMax;
    const count = rng.int(
      def.crateCountMin,
      Math.max(def.crateCountMin, Math.min(crateCap, Math.floor((room.tw * room.th) / def.crateAreaDiv))),
    );
    for (let i = 0; i < count; i += 1) {
      const wTiles = rng.chance(def.crateWideChance) ? 1 : 2;
      const hTiles = rng.chance(def.crateTallChance) ? 1 : 2;
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
    const count = rng.int(0, def.bushMax);
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
    // 房间有容器的概率（默认 1）。蜂窝式地图（管廊 49 个小隔间）如果不给这个折扣，
    // 光容器就是 49 个写实木箱 ≈ 24 万三角形，直接把手机预算打穿。
    const roomRate = def.containerRoomRate == null ? 1 : def.containerRoomRate;
    const want = roomRate >= 1 || rng.chance(roomRate);
    const count = want
      ? Math.max(1, Math.min(def.containerMax, Math.round((room.tw * room.th) / def.containerAreaDiv)))
      : 0;
    for (let i = 0; i < count; i += 1) {
      const type = rng.weighted(typeEntries);
      let placed = null;
      for (let attempt = 0; attempt < 12 && !placed; attempt += 1) {
        const p = roomFloorPoint(room, rng, 1.1);
        if (isSolidAt(map, p.x, p.y)) continue;
        // 避让半径取该类型容器的实际半径：此前固定 16 小于 crate(20)/weaponbox(22) 的视觉半径，
        // 导致木箱 / 武器箱被判定可放、实际却插进墙根 / 地面（穿模）。
        const clear = (CONTAINERS[type] && CONTAINERS[type].radius) || 16;
        if (circleHitsSolid(map, p.x, p.y, clear)) continue;
        if (map.containers.some((c) => Math.hypot(c.x - p.x, c.y - p.y) < 62)) continue;
        placed = p;
      }
      if (!placed) continue;
      map.containers.push({
        id: cid, type, x: Math.round(placed.x), y: Math.round(placed.y),
        r: CONTAINERS[type].radius, searched: false, loot: null, spawned: false,
      });
      cid += 1;
    }
  }

  // 6) 撤离点：优先靠近地图边缘且彼此分散的房间
  const edgeScore = (room) => Math.min(room.cx, room.cy, cols * TILE - room.cx, rows * TILE - room.cy);
  const candidates = rooms.slice().sort((a, b) => edgeScore(a) - edgeScore(b));
  const picked = [];
  for (const room of candidates) {
    if (picked.length >= MATCH.extractTotal) break;
    if (picked.some((r) => Math.hypot(r.cx - room.cx, r.cy - room.cy) < def.extractSpread)) continue;
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
    // 兜底也不能直接落房间中心：房间是从叶子里内缩挖出来的，中心可能正好压在墙上
    // （地图放大 + 填充率 0.62 后真的踩到了，撤离点插进实心格 = 那处出口永远撤不了）。
    if (!point) {
      const t = nearestWalkableTile(map, Math.floor(room.cx / TILE), Math.floor(room.cy / TILE));
      point = t
        ? { x: (t.tx + 0.5) * TILE, y: (t.ty + 0.5) * TILE }
        : { x: room.cx, y: room.cy };
    }
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
  let spawnCandidates = rooms.slice().sort((a, b) => {
    const sa = Math.min(...map.extracts.map((e) => Math.hypot(e.x - a.cx, e.y - a.cy)));
    const sb = Math.min(...map.extracts.map((e) => Math.hypot(e.x - b.cx, e.y - b.cy)));
    return sb - sa;
  });
  // 窄图（conduit）要求出生点离最近出口足够远：物资多，但"搬回去"本身就是风险。
  // 只在 def.spawnMinExtractDist > 0 时过滤，旧图（0）完全走原路径、随机序列不变。
  // 若整张图没有任何房间满足下限（极端种子），保留原排序结果兜底 —— 宁可不满足参数，也不能生成失败。
  if (def.spawnMinExtractDist > 0) {
    const distToNearest = (room) => Math.min(...map.extracts.map((e) => Math.hypot(e.x - room.cx, e.y - room.cy)));
    const far = spawnCandidates.filter((room) => distToNearest(room) >= def.spawnMinExtractDist);
    if (far.length) spawnCandidates = far;
  }
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

  // 8.5) 撤离点类型：standard（常规）/ free / paid / guarded
  // 「常规撤离」= 离出生点最远的一处，从开局就开放 —— 保证任何时刻都有至少一个可用方案，
  // 否则开局到 2:30 之间一处都不可用，等于把「早走」的选择权收走了。
  // 其余点里保证再有一个免费点（免费通道永远存在），剩下的随机付费/守点。
  for (const ex of map.extracts) ex.kind = 'free';
  const distOf = (ex) => Math.hypot(ex.x - map.playerSpawn.x, ex.y - map.playerSpawn.y);
  const standard = map.extracts.slice().sort((a, b) => distOf(b) - distOf(a))[0] || null;
  if (standard) {
    standard.kind = 'standard';
    standard.name = standard.name + '（常规）';
  }
  const kinded = rng.shuffle(map.extracts.filter((ex) => ex !== standard));
  kinded.forEach((ex, i) => {
    if (i === 0) return; // 保底免费撤离点（standard 之外再留一处免费）
    ex.kind = rng.chance(0.5) ? 'paid' : 'guarded';
    if (ex.kind === 'paid') ex.cost = MATCH.extractFee;
  });

  // 8.6) 撤离点按 openAt 依次开启：免费点先开（它是"早走"的选项），付费/守点压在局末。
  // 注意：免费点不是索引 0 —— 上面 rng.shuffle 随机挑了保底免费点（8.5 步），
  // 所以这里必须按 kind 判断，不能按下标判断。
  // openAt 是**经过秒数**（与 world.time 同口径），不是剩余秒数。
  for (const ex of map.extracts) {
    if (ex.kind === 'standard') ex.openAt = 0;
    else if (ex.kind === 'free') ex.openAt = MATCH.extractFirstOpen;
    else ex.openAt = MATCH.duration - MATCH.extractOpenAt;
  }

  // 9) 敌人出生点
  // P15：风险分级只乘「数量」，不改 rng 抽取点。倍率为 1 时 `Math.round(x * 1) === x`，
  // 循环次数与调用序列逐位不变 —— 这是常规局 GOLDEN 不受影响的前提。
  const countMul = Number.isFinite(opts.enemyCountMul) && opts.enemyCountMul > 0 ? opts.enemyCountMul : 1;
  const enemyCount = Math.max(1, Math.round(rng.int(def.enemyCountMin, def.enemyCountMax) * countMul));
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
        // 高度校验：敌人不刷在架高平台上（避免一出生就"站在高墙顶 / 屋顶"的观感异常），
        // 抢占高地交给 AI 的 pickHighGround 在战斗中按需执行。
        if (platformHeightAt(map, p.x, p.y) > 0.5) continue;
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
    const wanted = Math.max(0, def.platformCount || 0);
    const pad = 18;
    // 注意：room.x / room.w 是**世界坐标**（见 roomFloorPoint），需要先换算成格
    const bigRooms = rng.shuffle(map.rooms
      .filter((r) => r.w >= 5 * TILE && r.h >= 5 * TILE));
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

  // 9.55) 首领出生点：每张图一个 Boss（主题各异）。
  // depot/conduit 放在最大房间中心（开阔据点）；ridge 优先放在架高平台（狙击喜高地）。
  // 落点做可达性兜底：若算出的点压在墙体里，则回退到最近可站立格。
  {
    let bp;
    if (map.id === 'ridge' && map.platforms.length) {
      const p = map.platforms[0];
      bp = { x: p.x + p.w / 2, y: p.y + p.h / 2 };
    } else {
      const room = map.rooms.reduce((a, b) => ((b.tw * b.th) > (a.tw * a.th) ? b : a), map.rooms[0]);
      bp = { x: room.cx, y: room.cy };
    }
    if (isSolidAt(map, bp.x, bp.y) || circleHitsSolid(map, bp.x, bp.y, 18)) {
      const st = nearestWalkableTile(map, Math.floor(bp.x / TILE), Math.floor(bp.y / TILE));
      bp = { x: st.tx * TILE + TILE / 2, y: st.ty * TILE + TILE / 2 };
    }
    map.enemySpawns.push({ type: 'boss', x: Math.round(bp.x), y: Math.round(bp.y), bossId: map.id });
  }

  // 9.6) 机动载具：停在大房间的空地上，用于快速转移。
  // 只要求"周围够空旷能开出去"，不写进 grid（不是静态障碍），碰撞由玩家驾驶时自行处理。
  // def.vehicles 为 false 的图（管廊）完全不消耗这段的随机数，也不生成载具。
  if (def.vehicles && VEHICLE.enabled) {
    const wanted = Math.round(rng.float(VEHICLE.count[0], VEHICLE.count[1]));
    const clear = VEHICLE.radius + 18; // 预留出一圈能开动的余量
    const rooms = rng.shuffle(map.rooms.slice());
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

  // 11) 分区命名（POI）：取面积最大的前 N 个房间，稳定贴战术代号。
  // 纯展示、不影响生成、不改 seed（名字来自固定名称池，按房间面积排序确定）。
  // 作为小地图分区代号与「当前区域」HUD 的唯一真值源，也便于单测锁定。
  // 面积并列时按原房间序排序，保证同 seed 结果稳定。
  {
    const names = POI_NAMES[map.id] || POI_NAMES.depot;
    const cap = (HUD && HUD.minimap && HUD.minimap.poiMax) || 6;
    map.pois = map.rooms
      .map((r, i) => ({ r, i, area: r.tw * r.th }))
      .sort((a, b) => b.area - a.area || a.i - b.i)
      .slice(0, cap)
      .map(({ r, i }) => ({ x: r.cx, y: r.cy, name: names[i % names.length], area: r.tw * r.th }));
  }

  // 12) 区域价值分层 / 热点 / 出生点类型（P20）。
  //     只往 map 上挂**新字段**（areas / hotspots / spawnKind），不动任何几何字段 ——
  //     所以 GOLDEN 快照（不含这些字段）仍然逐字节可比。
  {
    const plan = buildAreaPlan(map);
    map.areas = plan.areas;
    map.hotspots = plan.hotspots;
    map.spawnKind = plan.spawnKind;
  }

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

/**
 * M-03：在 buildExtractPlan(map, { layout: true }) 之后落实出口网络的几何侧。
 *
 * 为什么不在 generateMap 里做：GOLDEN 快照锁的是 generateMap 直出结果，往里插 POI
 * 会一次性打翻 5 个种子的哈希。布局层放在生成之后，既拿到真实房间/热点/出生点，
 * 又不碰任何 rng 序列。
 *
 * - 校验每个出口从出生点可达（BFS 流场）、不插在实心里；
 * - 给拉闸点配一个**圈外、可见、可达**的闸刀 POI（复用终端的交互模型）；
 * - 只报告问题，不硬挪点 —— 挪点会破坏"出生点离出口最远"的既有口径。
 *
 * @param {object} map 地图
 * @returns {{ok:boolean, switches:Array<object>, issues:Array<string>}}
 */
export function finalizeExtractLayout(map) {
  const layout = map && map.extractLayout;
  const list = (map && map.extracts) || [];
  const issues = Array.isArray(layout && layout.issues) ? layout.issues.slice() : [];
  if (!layout || layout.ok !== true) {
    issues.push('layout-not-applied');
    return { ok: false, switches: [], issues };
  }
  const stx = Math.floor((map.playerSpawn ? map.playerSpawn.x : 0) / map.tile);
  const sty = Math.floor((map.playerSpawn ? map.playerSpawn.y : 0) / map.tile);
  const field = bfsFlowField(map, stx, sty);
  const cellIndex = (x, y) => {
    const tx = Math.floor(x / map.tile);
    const ty = Math.floor(y / map.tile);
    return (tx >= 0 && ty >= 0 && tx < map.cols && ty < map.rows) ? ty * map.cols + tx : -1;
  };
  const reachable = (x, y) => {
    const i = cellIndex(x, y);
    return i >= 0 && field[i] >= 0;
  };
  for (const ex of list) {
    if (!reachable(ex.x, ex.y)) issues.push(`unreachable:${ex.id}`);
    if (isSolidAt(map, ex.x, ex.y)) issues.push(`inside-wall:${ex.id}`);
  }

  const sw = layout.switchPoint;
  const switches = [];
  if (sw) {
    let placed = null;
    // 固定方向 × 固定半径，零随机；优先近处，保证闸刀始终在撤离圈边缘外。
    // ⚠ 候选集必须够宽：地图放大后箱子/容器/终端密度上升，旧的 4 半径 × 8 方向
    // 在 ridge 的某些种子上会全部被挡，于是兜底把闸刀塞进撤离圈（等于"拉闸点在撤离圈里"，
    // 玩家一进圈就能顺手拉闸，博弈消失）。这里加到 7 半径 × 16 方向 = 112 个候选。
    const radii = [2.8, 3.4, 4.0, 4.6, 5.4, 6.4, 7.6].map((m) => m * EXTRACT_LAYOUT.switchRadius);
    for (const r of radii) {
      if (placed) break;
      for (let k = 0; k < 16 && !placed; k += 1) {
        const ang = EXTRACT_LAYOUT.switchAngle + (k * Math.PI) / 8;
        const x = Math.round(sw.x + Math.cos(ang) * r);
        const y = Math.round(sw.y + Math.sin(ang) * r);
        if (!reachable(x, y) || isSolidAt(map, x, y) || circleHitsSolid(map, x, y, 18)) continue;
        if (!hasLineOfSight(map, sw.x, sw.y, x, y)) continue;
        // 别把闸刀塞进木箱 / 搜刮容器 / 数据终端：几何可达但视觉被挡 = 玩家看不见，
        // 等于没有交互目标（截图复核实测踩过这个坑）。
        const crowded = (map.containers || []).some((c) => Math.hypot(c.x - x, c.y - y) < 64)
          || (map.terminals || []).some((t) => Math.hypot(t.x - x, t.y - y) < 64)
          || (map.crates || []).some((c) => x > c.x - 26 && x < c.x + c.w + 26
            && y > c.y - 26 && y < c.y + c.h + 26);
        if (crowded) continue;
        placed = { x, y };
      }
    }
    if (!placed) {
      // 极端种子兜底：宁可放在圈内，也不能没有可拉的闸刀（软锁比位置不美更糟）。
      placed = { x: Math.round(sw.x), y: Math.round(sw.y) };
      issues.push('switch-fallback-inside-circle');
    }
    switches.push({
      id: 0,
      x: placed.x,
      y: placed.y,
      r: EXTRACT_LAYOUT.switchRadius,
      extractId: sw.id,
      name: `闸刀 · ${sw.name}`,
      pulled: false,
    });
  }
  map.switches = switches;
  layout.issues = issues;
  layout.switches = switches;
  return { ok: !issues.some((s) => s.startsWith('unreachable:')), switches, issues };
}
