/**
 * 场地碰撞布局 —— 唯一真源
 *
 * 不依赖 THREE / DOM，因此：
 *   - scene.mjs 用它注册碰撞体（建模位置与它同源，天然一致）
 *   - tests/layout.test.mjs 用它做 BFS 连通性验证
 * 玩家侧格式沿用 { min:{x,z}, max:{x,z} }（player.mjs 的圆-AABB push-out 直接消费）。
 */
import {
  ROOM, STORE, ZONES, PROPS, PROP_SIZE, SHELF_ROWS, SLOT_COUNT,
  FACILITIES, POND, EXPANSIONS, EXPANSION_BY_ID,
} from './config.mjs';

function box(cx, cz, halfW, halfD) {
  return { min: { x: cx - halfW, z: cz - halfD }, max: { x: cx + halfW, z: cz + halfD } };
}

/**
 * 需求I 第⑦条：按已解锁的扩建计算**当前场地边界**。
 * 每级扩建只声明自己改动的那条边（bounds.maxX / bounds.minZ …），
 * 这里从 ROOM 起算逐级叠加 —— 未扩建时结果与需求G 时期完全一致。
 */
export function computeBounds(ownedIds = []) {
  const b = {
    minX: -ROOM.width / 2, maxX: ROOM.width / 2,
    minZ: -ROOM.depth / 2, maxZ: ROOM.depth / 2,
  };
  for (const e of EXPANSIONS) {
    if (!ownedIds.includes(e.id)) continue;
    const nb = e.bounds ?? {};
    if (Number.isFinite(nb.maxX)) b.maxX = Math.max(b.maxX, nb.maxX);
    if (Number.isFinite(nb.minX)) b.minX = Math.min(b.minX, nb.minX);
    if (Number.isFinite(nb.maxZ)) b.maxZ = Math.max(b.maxZ, nb.maxZ);
    if (Number.isFinite(nb.minZ)) b.minZ = Math.min(b.minZ, nb.minZ);
  }
  return b;
}

/** 已解锁的扩建定义（按 EXPANSIONS 顺序） */
export function ownedExpansions(ownedIds = []) {
  return EXPANSIONS.filter((e) => ownedIds.includes(e.id));
}

/**
 * 全部静态碰撞体（墙 + 设施 + 货架等）。
 * @param opts.expansions 已解锁的扩建 id 数组；不传 = 未扩建（与既有行为一致）
 */
export function buildColliders(opts = {}) {
  const out = [];
  const owned = Array.isArray(opts.expansions) ? opts.expansions : [];
  const b = computeBounds(owned);
  const t = ROOM.wallT;

  const push = (o, tag) => { if (tag) o.tag = tag; out.push(o); return o; };

  /* 场地外墙 —— 边界随扩建外扩，带 gate 的那一面在扩建后留出门洞 */
  const width = b.maxX - b.minX;
  const depth = b.maxZ - b.minZ;
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;

  /* 东 / 北两面可能被"打通"：把整面墙按门洞位置切成两段，中间留空。
   * 门洞宽度取 3.6m（≥ 玩家直径的两倍），保证推着走不会卡在门框上。 */
  const east = owned.includes('exp1') ? EXPANSION_BY_ID.exp1.gate : null;
  const north = owned.includes('exp2') ? EXPANSION_BY_ID.exp2.gate : null;

  if (north) {
    const g0 = Math.max(b.minX, Math.min(north.min, north.max));
    const g1 = Math.min(b.maxX, Math.max(north.min, north.max));
    if (g0 > b.minX) push(box((b.minX + g0) / 2, b.minZ - t / 2, (g0 - b.minX) / 2, t / 2));
    if (b.maxX > g1) push(box((g1 + b.maxX) / 2, b.minZ - t / 2, (b.maxX - g1) / 2, t / 2));
  } else {
    push(box(cx, b.minZ - t / 2, width / 2 + t, t / 2)); // 北
  }

  push(box(cx, b.maxZ + t / 2, width / 2 + t, t / 2));   // 南
  push(box(b.minX - t / 2, cz, t / 2, depth / 2));       // 西

  if (east) {
    const g0 = Math.max(b.minZ, Math.min(east.min, east.max));
    const g1 = Math.min(b.maxZ, Math.max(east.min, east.max));
    if (g0 > b.minZ) push(box(b.maxX + t / 2, (b.minZ + g0) / 2, t / 2, (g0 - b.minZ) / 2));
    if (b.maxZ > g1) push(box(b.maxX + t / 2, (g1 + b.maxZ) / 2, t / 2, (b.maxZ - g1) / 2));
  } else {
    push(box(b.maxX + t / 2, cz, t / 2, depth / 2));     // 东
  }

  /* 便利店墙体 */
  const st = STORE.wallT;
  const sw = STORE.maxX - STORE.minX;
  const sd = STORE.maxZ - STORE.minZ;
  const scx = (STORE.minX + STORE.maxX) / 2;
  const scz = (STORE.minZ + STORE.maxZ) / 2;

  out.push(box(scx, STORE.minZ - st / 2, (sw + st * 2) / 2, st / 2)); // 北墙
  out.push(box(STORE.maxX + st / 2, scz, st / 2, sd / 2));             // 东墙
  out.push(box(STORE.minX - st / 2, scz, st / 2, sd / 2));             // 西墙

  // 南墙：两段 + 门楣（门洞 x ∈ [-doorHalfW, doorHalfW]，物理上留空）
  const dh = STORE.doorHalfW;
  const segW = STORE.maxX - dh;
  const segCx = dh + segW / 2;
  out.push(box(-segCx, STORE.maxZ + st / 2, segW / 2, st / 2));
  out.push(box(segCx, STORE.maxZ + st / 2, segW / 2, st / 2));
  // 注意：门楣（门洞上方的墙体）**不**加入碰撞 —— 它在 2.2m 以上，
  // 俯视 2D 碰撞若把它算进去会直接把门口封死，玩家将永远出不了便利店。

  /* 货架 */
  for (let i = 0; i < SLOT_COUNT; i++) {
    const row = SHELF_ROWS[Math.floor(i / 4)] ?? SHELF_ROWS[0];
    out.push(box(row.x, row.zs[i % 4] ?? 0, 0.78, 0.32));
  }

  /* 收银台 / 库存箱 */
  out.push(box(3.6, 3.4, 0.95, 0.45));
  out.push(box(4.6, -3.4, 0.58, 0.58));

  /* 电玩区顶棚柱 */
  const arc = ZONES.arcade;
  for (const cx of [arc.minX + 0.3, arc.maxX - 0.3]) {
    for (const cz of [arc.minZ + 0.3, arc.maxZ - 0.3]) out.push(box(cx, cz, 0.14, 0.14));
  }
  /* 街机 */
  for (const a of PROPS.arcades) {
    out.push(box(a.x, a.z, PROP_SIZE.arcade.w / 2 + 0.05, PROP_SIZE.arcade.d / 2 + 0.05));
  }
  /* 休息区桌椅 */
  for (const t2 of PROPS.tables) {
    out.push(box(t2.x, t2.z, PROP_SIZE.table.w / 2, PROP_SIZE.table.d / 2));
  }
  /* 长椅 */
  for (const b of PROPS.benches) {
    out.push(box(b.x, b.z, PROP_SIZE.bench.w / 2, PROP_SIZE.bench.d / 2 + 0.1));
  }
  /* 绿植 */
  for (const p of PROPS.plants) {
    out.push(box(p.x, p.z, PROP_SIZE.plant.w / 2, PROP_SIZE.plant.d / 2));
  }
  /* 灯柱 */
  for (const l of PROPS.lamps) out.push(box(l.x, l.z, PROP_SIZE.lamp.w, PROP_SIZE.lamp.d));
  /* 自动售货机 */
  for (const v of PROPS.vendings) {
    out.push(box(v.x, v.z, PROP_SIZE.vending.w / 2 + 0.05, PROP_SIZE.vending.d / 2 + 0.05));
  }
  /* 后巷货箱 */
  for (const c of PROPS.crates) {
    out.push(box(c.x, c.z, PROP_SIZE.crate.w / 2, PROP_SIZE.crate.d / 2));
  }

  /* 可玩娱乐设施（机身占位；池塘单独处理 —— 整片水面不可行走） */
  for (const f of FACILITIES) {
    if (f.kind === 'fishing') continue;
    // 设施带 rot：世界轴上的占位必须按旋转后的 AABB 算，
    // 否则横放（rot=±90°）会把 w/d 弄反，站位判定差出 0.15m。
    const rot = f.rot ?? 0;
    const c = Math.abs(Math.cos(rot));
    const s = Math.abs(Math.sin(rot));
    const w = f.w ?? 1;
    const d = f.d ?? 1;
    out.push(box(f.x, f.z, (w * c + d * s) / 2 + 0.05, (w * s + d * c) / 2 + 0.05));
  }
  out.push(box(POND.x, POND.z, POND.w / 2, POND.d / 2));

  /* 需求I 第⑦条：已解锁扩建带来的新设施与灯柱。
     未解锁时这段完全是空的 —— 既有碰撞集合一个都不变。 */
  for (const exp of ownedExpansions(owned)) {
    for (const f of exp.facilities ?? []) {
      const rot = f.rot ?? 0;
      const c = Math.abs(Math.cos(rot));
      const s = Math.abs(Math.sin(rot));
      const w = f.w ?? 1;
      const d = f.d ?? 1;
      out.push(box(f.x, f.z, (w * c + d * s) / 2 + 0.05, (w * s + d * c) / 2 + 0.05));
    }
    for (const l of exp.lamps ?? []) {
      out.push(box(l.x, l.z, PROP_SIZE.lamp.w, PROP_SIZE.lamp.d));
    }
  }

  return out;
}

/**
 * **原地**刷新一个碰撞体数组的内容（splice 清空再填满）。
 * 为什么不是"返回新数组"：player.mjs 持有 buildColliders 返回的那个引用，
 * 换新数组的话玩家会继续跟旧碰撞体做检测 —— 扩建完墙还在，玩家撞空气墙。
 */
export function applyLayout(target, opts = {}) {
  const list = buildColliders(opts);
  target.length = 0;
  for (const b of list) target.push(b);
  return target;
}

/** 点是否落在任一碰撞体内（outside=true 时按半径膨胀） */
export function isBlocked(x, z, colliders = buildColliders(), radius = 0) {
  for (const b of colliders) {
    if (
      x > b.min.x - radius && x < b.max.x + radius &&
      z > b.min.z - radius && z < b.max.z + radius
    ) return true;
  }
  return false;
}
