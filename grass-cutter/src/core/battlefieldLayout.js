/**
 * 战场布局 —— **纯数据**，不 import three、不碰 DOM。
 * ---------------------------------------------------------------------------
 * 为什么把布局单独抽成一层：
 *  · "障碍物有没有重叠 / 有没有超出 200×200 / 有没有压在土路上" 这类问题是**数据问题**，
 *    不该靠肉眼看截图；抽出来之后 `node --test` 就能把布局锁死。
 *  · 相机碰撞的有效性 = 布局的有效性。障碍物互相重叠 → 射线命中点忽近忽远 → 镜头抖。
 *  · 生成过程用固定种子（LAYOUT_SEED），所以每次刷新页面战场长得**完全一样**，
 *    读数可复现、问题可复现。
 *
 * 模块 1 里这些物件是**占位**（几何体直出，没有美术模型），目的是：
 *  ① 给第三人称摄像机一个真实的遮挡环境，用来验证"碰撞拉近 / 不穿模"；
 *  ② 给后续「据点占领」（模块 6）预留锚点（camps 字段）。
 */
import { BATTLEFIELD } from './config.js';

// ────────────────────────────────────────────────────────── 确定性随机
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const LAYOUT_SEED = 20260924;

// ────────────────────────────────────────────────────────── 物件类型表
// w/d = 水平占地（x/z），h = 高度（y）。blocks = 是否参与相机碰撞。
// 全部单位：米。
export const KINDS = {
  bigtent: { w: 9.0, h: 4.2, d: 9.0, blocks: true },
  tent: { w: 4.4, h: 2.6, d: 4.4, blocks: true },
  tower: { w: 3.2, h: 5.6, d: 3.2, blocks: true },
  fence: { w: 2.4, h: 1.1, d: 0.22, blocks: true },
  crate: { w: 1.6, h: 1.4, d: 1.6, blocks: true },
  rock: { w: 2.6, h: 2.0, d: 2.4, blocks: true },
  // 军旗：细杆。故意不参与相机碰撞 —— 细杆挡镜头只会让画面毫无理由地猛拉一下，
  // 而它本身细到不足以"穿帮"。这条是有意的设计取舍，不是漏配。
  banner: { w: 0.34, h: 4.6, d: 0.34, blocks: false },
};

function kindOf(kind) {
  const k = KINDS[kind];
  if (!k) throw new Error(`未知物件类型: ${kind}`);
  return k;
}

/** 旋转后的保守 AABB 半尺寸（对任意 rotY 都覆盖真实占地，用于重叠判定） */
export function rotatedHalfExtent(kind, rotY) {
  const { w, d } = kindOf(kind);
  const c = Math.abs(Math.cos(rotY));
  const s = Math.abs(Math.sin(rotY));
  return { hx: (w * c + d * s) / 2, hz: (w * s + d * c) / 2 };
}

function aabbOf(o) {
  const { hx, hz } = rotatedHalfExtent(o.kind, o.rotY);
  return { minX: o.x - hx, maxX: o.x + hx, minZ: o.z - hz, maxZ: o.z + hz };
}

export function aabbOverlap(a, b, gap = 0) {
  return a.minX < b.maxX + gap && a.maxX > b.minX - gap && a.minZ < b.maxZ + gap && a.maxZ > b.minZ - gap;
}

// ────────────────────────────────────────────────────────── 道路（土路）
// 全部是轴对齐矩形条，便于单测（"路面没被障碍物压住"是可判定的）。
// axis 'z' = 沿 Z 方向延伸（南北向），centerX 是中心线；axis 'x' 反之。
export const ROADS = [
  { id: 'road-main', axis: 'z', center: 0, from: -100, to: 100, width: 8.0 }, // 主土路 8m
  { id: 'road-cross', axis: 'x', center: 0, from: -100, to: 100, width: 7.0 }, // 横路 7m
  { id: 'road-spur-west', axis: 'x', center: -42, from: -62, to: -4, width: 5.0 }, // 通往西营
  { id: 'road-spur-east', axis: 'x', center: 46, from: 4, to: 60, width: 5.0 }, // 通往东营
];

export function roadAABB(r, inflate = 0) {
  const hw = r.width / 2 + inflate;
  return r.axis === 'z'
    ? { minX: r.center - hw, maxX: r.center + hw, minZ: Math.min(r.from, r.to), maxZ: Math.max(r.from, r.to) }
    : { minX: Math.min(r.from, r.to), maxX: Math.max(r.from, r.to), minZ: r.center - hw, maxZ: r.center + hw };
}

/**
 * 第 index 条土路的贴片高度。
 * 抽成函数是为了让"路口两条路不共面"变成可断言的属性 ——
 * 主路与横路在路口必然重叠，若高度相同就会 z-fighting（闪烁噪点）。
 */
export function roadHeight(index) {
  return BATTLEFIELD.BASE_Y + BATTLEFIELD.ROAD_LIFT + index * BATTLEFIELD.ROAD_Y_STEP;
}

/** 土路是否"压"到了某个占地盒（路面要保持可走、无障碍） */
export function isOnRoad(aabb, inflate = 0) {
  return ROADS.some((r) => aabbOverlap(aabb, roadAABB(r, inflate)));
}

/** 出生点：主土路南端，面朝 -Z（朝向战场中心） */
export const SPAWN = { x: 0, z: 86, yaw: 0 };

// ────────────────────────────────────────────────────────── 据点锚点（模块 6 消费）
export const CAMPS = [
  { id: 'camp-west', name: '西营', x: -64, z: -42, radius: 15 },
  { id: 'camp-east', name: '东营', x: 60, z: 46, radius: 15 },
];

// ────────────────────────────────────────────────────────── 布局生成
/**
 * 生成整张战场的布局数据。返回结构：
 *   { seed, bounds, walls[], objects[], bushes[], roads[], camps[], spawn }
 * 其中 objects 里每个元素：{ id, kind, x, z, rotY, h, blocks }
 */
export function buildLayout(seed = LAYOUT_SEED) {
  const rng = mulberry32(seed);
  const bounds = { minX: -100, maxX: 100, minZ: -100, maxZ: 100 };
  const objects = [];

  // 「已有占地」表：边界墙、物件都登记进来，后续摆放全部要跟它比。
  const occupied = [];
  const register = (o) => {
    const a = aabbOf(o);
    occupied.push({ id: o.id, aabb: a, onRoadOk: o.onRoadOk === true });
    return o;
  };

  // ── 边界石墙（同时把地形边缘的接缝藏在墙背后）
  const WALL_T = 1.6;
  const WALL_H = 3.2;
  const walls = [
    { id: 'wall-n', x: 0, z: bounds.maxZ - WALL_T / 2, rotY: 0, len: 200, t: WALL_T, h: WALL_H },
    { id: 'wall-s', x: 0, z: bounds.minZ + WALL_T / 2, rotY: 0, len: 200, t: WALL_T, h: WALL_H },
    { id: 'wall-w', x: bounds.minX + WALL_T / 2, z: 0, rotY: Math.PI / 2, len: 200, t: WALL_T, h: WALL_H },
    { id: 'wall-e', x: bounds.maxX - WALL_T / 2, z: 0, rotY: Math.PI / 2, len: 200, t: WALL_T, h: WALL_H },
  ];
  for (const w of walls) {
    occupied.push({
      id: w.id,
      aabb: { minX: w.x - w.len / 2, maxX: w.x + w.len / 2, minZ: w.z - w.t / 2, maxZ: w.z + w.t / 2 },
      onRoadOk: true,
    });
  }

  // ── 摆放原语：任何一次摆放都要过这里，所以"重叠"在生成阶段就不可能发生
  const place = ({ id, kind, x, z, rotY = 0, onRoad = false, gap = 1.0, strict = true }) => {
    const k = kindOf(kind);
    const o = { id, kind, x, z, rotY, h: k.h, blocks: k.blocks };
    const a = aabbOf(o);
    const errs = [];
    if (a.minX < bounds.minX || a.maxX > bounds.maxX || a.minZ < bounds.minZ || a.maxZ > bounds.maxZ) {
      errs.push(`超出战场边界`);
    }
    for (const prev of occupied) {
      if (aabbOverlap(a, prev.aabb, gap)) errs.push(`与 ${prev.id} 距离 < ${gap}m`);
    }
    if (!onRoad && isOnRoad(a, 0.6)) errs.push(`压在土路上（路面必须保持可走）`);
    if (errs.length) {
      if (strict) throw new Error(`布局冲突 [${id}/${kind} @ ${x},${z}]: ${errs.join('; ')}`);
      return null;
    }
    o.onRoadOk = onRoad;
    register(o);
    objects.push(o);
    return o;
  };

  // ── 两座营寨（占位据点）
  const CAMP_A = { x: -64, z: -42 };
  const CAMP_B = { x: 60, z: 46 };
  const campSpec = [
    // 西营：大帐在西侧，路边留出通路
    ['camp-west', CAMP_A, [
      ['bigtent', -7.0, 0, 0],
      ['tower', 3.5, -11.5, 0],
      ['tower', 3.5, 11.5, 0],
      ['tent', -2.0, -11.0, 0.28],
      ['tent', -2.0, 11.0, -0.28],
      ['crate', 5.5, -5.5, 0.4],
      ['crate', 5.5, 5.5, -0.4],
      ['fence', -11.5, -9.0, Math.PI / 2],
      ['fence', -11.5, 9.0, Math.PI / 2],
      ['fence', 9.5, -13.0, 0],
      ['fence', 9.5, 13.0, 0],
    ]],
    ['camp-east', CAMP_B, [
      ['bigtent', 7.0, 0, 0],
      ['tower', -3.5, -11.5, 0],
      ['tower', -3.5, 11.5, 0],
      ['tent', 2.0, -11.0, -0.28],
      ['tent', 2.0, 11.0, 0.28],
      ['crate', -5.5, -5.5, -0.4],
      ['crate', -5.5, 5.5, 0.4],
      ['fence', 11.5, -9.0, Math.PI / 2],
      ['fence', 11.5, 9.0, Math.PI / 2],
      ['fence', -9.5, -13.0, 0],
      ['fence', -9.5, 13.0, 0],
    ]],
  ];
  const camps = [];
  for (const [id, c, items] of campSpec) {
    camps.push({ id, name: id === 'camp-west' ? '西营' : '东营', x: c.x, z: c.z, radius: 15 });
    for (const [kind, dx, dz, rotY] of items) {
      place({ id: `${id}-${kind}-${objects.length}`, kind, x: c.x + dx, z: c.z + dz, rotY });
    }
    // 军旗（不挡相机，靠 place 的 strict 仍然保证不叠人）
    place({ id: `${id}-banner-a`, kind: 'banner', x: c.x, z: c.z - 4.6, gap: 0.4 });
    place({ id: `${id}-banner-b`, kind: 'banner', x: c.x, z: c.z + 4.6, gap: 0.4 });
  }

  // ── 野外散布：巨石 / 断栅栏 / 木箱 / 军旗（固定种子 → 布局恒定）
  const scatter = (kind, count, gap, onRoad = false) => {
    let tries = 0;
    let made = 0;
    while (made < count && tries < count * 240) {
      tries++;
      // 避开两座营寨的驻地
      const x = bounds.minX + 8 + rng() * (bounds.maxX - bounds.minX - 16);
      const z = bounds.minZ + 8 + rng() * (bounds.maxZ - bounds.minZ - 16);
      const inCamp = camps.some((c) => Math.hypot(x - c.x, z - c.z) < c.radius + 3);
      if (inCamp) continue;
      const rotY = kind === 'fence' ? (rng() < 0.5 ? 0 : Math.PI / 2) + (rng() - 0.5) * 0.12 : rng() * Math.PI * 2;
      const o = place({ id: `scatter-${kind}-${made}`, kind, x, z, rotY, gap, onRoad, strict: false });
      if (o) made++;
    }
    if (made < count) throw new Error(`散布 ${kind} 只放得下 ${made}/${count} 个：把 gap 调小或数量减少`);
    return made;
  };
  scatter('rock', 12, 2.5);
  scatter('fence', 16, 2.0);
  scatter('crate', 8, 1.6);
  scatter('banner', 10, 0.6);

  // ── 草丛（InstancedMesh 用；纯装饰，不参与碰撞，允许贴着石头长）
  const bushes = [];
  for (let i = 0; i < 110; i++) {
    const x = bounds.minX + 3 + rng() * (bounds.maxX - bounds.minX - 6);
    const z = bounds.minZ + 3 + rng() * (bounds.maxZ - bounds.minZ - 6);
    if (isOnRoad({ minX: x - 0.5, maxX: x + 0.5, minZ: z - 0.5, maxZ: z + 0.5 }, 0.3)) continue;
    bushes.push({ x, z, s: 0.7 + rng() * 0.8, rotY: rng() * Math.PI * 2 });
  }

  return { seed, bounds, walls, objects, bushes, roads: ROADS, camps, spawn: SPAWN };
}

/** 独立重算一遍重叠情况（测试里用来交叉验证生成器"没有作弊"） */
export function findOverlaps(objects, gap = 0) {
  const out = [];
  for (let i = 0; i < objects.length; i++) {
    for (let j = i + 1; j < objects.length; j++) {
      if (aabbOverlap(aabbOf(objects[i]), aabbOf(objects[j]), gap)) {
        out.push([objects[i].id, objects[j].id]);
      }
    }
  }
  return out;
}

export { aabbOf };

// ────────────────────────────────────────────────────────── 相机碰撞用的形状表
/**
 * 抽出所有"能挡相机"的实体，供摄像机做"注视点是否已经在实体内部"的判定。
 *
 * 为什么需要这个：射线求交靠的是**背面剔除**（FrontSide）——
 * 一条从物体内部出发的射线，打到的是出射面（背面），会被剔除，于是返回"无遮挡"。
 * 结果就是：一旦玩家被塞进墙里（模块 2 的碰撞出 bug、或调试时传送穿模），
 * 相机不但不会退让，反而会**加速穿到墙后面** —— 而且全程没有任何报错。
 * 所以这里把"实体内部"单独判一次，让这种情况退化为"相机贴身"而不是穿墙。
 */
export function blockerShapes(layout) {
  const out = [];
  for (const o of layout.objects) {
    if (!o.blocks) continue;
    const k = kindOf(o.kind);
    out.push({ id: o.id, x: o.x, z: o.z, rotY: o.rotY, hw: k.w / 2, hd: k.d / 2, h: k.h });
  }
  for (const w of layout.walls) {
    out.push({ id: w.id, x: w.x, z: w.z, rotY: w.rotY, hw: w.len / 2, hd: w.t / 2, h: w.h });
  }
  return out;
}

/**
 * 点是否在旋转盒内部（把点变换到盒的局部系再比半边长）。
 * three 绕 Y 旋转 θ 的正向映射是 (x,z) → (x cosθ + z sinθ, -x sinθ + z cosθ)，
 * 所以逆变换是 lx = dx cosθ - dz sinθ、lz = dx sinθ + dz cosθ。
 */
export function pointInOBB(px, py, pz, b) {
  if (py < 0 || py > b.h) return false;
  const dx = px - b.x;
  const dz = pz - b.z;
  const c = Math.cos(b.rotY);
  const s = Math.sin(b.rotY);
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  return Math.abs(lx) < b.hw && Math.abs(lz) < b.hd;
}
