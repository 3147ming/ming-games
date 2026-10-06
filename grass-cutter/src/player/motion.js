/**
 * 玩家运动学 —— **纯逻辑**，不 import three、不碰 DOM，所以能直接 `node --test`。
 * ---------------------------------------------------------------------------
 * 把"人在地上怎么走、撞墙怎么办、跳多高、站到箱子上算不算落地"全部收进这一层。
 * controller.js 只负责状态机与输入，真正决定"下一刻这个人在哪"的是这里。
 *
 * 碰撞用的形状表就是模块 1 给相机用的那一份（battlefieldLayout.blockerShapes）：
 *   { id, x, z, rotY, hw, hd, h }
 * 于是"相机不会穿过的东西"和"人走不过去的东西"是**同一份数据**，不会两边漂移。
 *
 * 一个必须写下来的设计选择：**人站得到箱子顶上**。
 *   规则：某个形状在"当前脚高"下还算障碍 ⟺ 它的顶面高于 脚高 + STEP_HEIGHT。
 *   · 站在地面（脚高 0）时：木箱 1.4 > 0.42 → 挡住你；
 *   · 你跳上去（脚高 1.4）之后：1.4 > 1.4+0.42 不成立 → 它不再挡你，可以在上面走、可以走出去掉下来。
 *   这一条让跳跃在无双里第一次有了实际用途（跳上木箱/栅栏），也让"落地判定"有东西可判。
 */

/** 角度规范到 (-π, π] */
export function normalizeAngle(a) {
  if (!Number.isFinite(a)) return 0;
  const tau = Math.PI * 2;
  let x = a % tau;
  if (x > Math.PI) x -= tau;
  if (x <= -Math.PI) x += tau;
  return x;
}

/** 以有限角速度转向目标（不会过冲，这一点和 lerp 不同） */
export function turnToward(current, target, maxDelta) {
  const d = normalizeAngle(target - current);
  const step = Number.isFinite(maxDelta) ? maxDelta : 0;
  if (Math.abs(d) <= step) return normalizeAngle(target);
  return normalizeAngle(current + Math.sign(d) * step);
}

/** 标量以有限速率逼近（用于加减速） */
export function moveToward(current, target, maxDelta) {
  const c = Number.isFinite(current) ? current : 0;
  const t = Number.isFinite(target) ? target : 0;
  const d = t - c;
  const step = Number.isFinite(maxDelta) ? Math.max(0, maxDelta) : 0;
  if (Math.abs(d) <= step) return t;
  return c + Math.sign(d) * step;
}

/** 把圆形（玩家）变换到形状的局部坐标系 */
function toLocal(px, pz, shape) {
  const dx = px - shape.x;
  const dz = pz - shape.z;
  const c = Math.cos(shape.rotY);
  const s = Math.sin(shape.rotY);
  return { lx: dx * c - dz * s, lz: dx * s + dz * c };
}

/**
 * 圆 vs 旋转盒（OBB）。做法：把圆心变换到盒的局部系，
 * 取"盒上离圆心最近的点"（就是各轴各自 clamp），再比距离。
 * 这比"AABB 近似"精确得多 —— AABB 会让旋转 45° 的栅栏凭空胖出一圈假墙。
 */
export function circleHitsOBB(px, pz, radius, shape) {
  const { lx, lz } = toLocal(px, pz, shape);
  const cx = Math.max(-shape.hw, Math.min(shape.hw, lx));
  const cz = Math.max(-shape.hd, Math.min(shape.hd, lz));
  const dx = lx - cx;
  const dz = lz - cz;
  return dx * dx + dz * dz < radius * radius;
}

/** 点是否落在形状的占地内（用于"这下面是哪个面"） */
export function pointInFootprint(px, pz, shape) {
  const { lx, lz } = toLocal(px, pz, shape);
  return Math.abs(lx) < shape.hw && Math.abs(lz) < shape.hd;
}

/**
 * 这个形状在"脚高 feetY"时是否算障碍。
 * 顶面不高于 脚高 + STEP_HEIGHT 的形状可以被忽略（要么你已经在它上面，要么能迈过去）。
 */
export function isBlocking(shape, feetY, stepHeight) {
  return shape.h > feetY + stepHeight;
}

/**
 * 玩家脚底下的"可站立面高度"。
 * = 地形高度（战场是平的，恒为 0）与"所有把落点盖住的形状顶面"里的最大值。
 * 注意用的是**圆心点**判定，不加半径 —— 否则贴着箱子边站着就会莫名其妙被抬上去。
 */
export function supportHeight(px, pz, shapes, terrainY = 0, feetY = Infinity) {
  let h = terrainY;
  for (const s of shapes) {
    // 只有"人已经在它上面或正在它上面"时才把它当支撑面；
    // 否则跳起来穿过帐篷顶的瞬间会被吸到顶上（脚还没过顶面就被"托住"）。
    if (s.h > feetY + 1e-6) continue;
    if (pointInFootprint(px, pz, s) && s.h > h) h = s.h;
  }
  return h;
}

/**
 * 水平位移 + 碰撞解算（分轴推进 → 自然得到"贴墙滑行"）。
 * @returns {{x:number, z:number, hitX:boolean, hitZ:boolean, clamped:boolean}}
 */
export function resolveHorizontal(pos, delta, radius, feetY, shapes, opts = {}) {
  const stepHeight = opts.stepHeight ?? 0.42;
  const bound = opts.bound ?? Infinity;
  const x0 = Number.isFinite(pos.x) ? pos.x : 0;
  const z0 = Number.isFinite(pos.z) ? pos.z : 0;
  const dx = Number.isFinite(delta.x) ? delta.x : 0;
  const dz = Number.isFinite(delta.z) ? delta.z : 0;

  const blockers = shapes.filter((s) => isBlocking(s, feetY, stepHeight));
  // 已经卡在里面的情况（理论上不该发生，但传送/浮点误差都可能造出来）：
  // 这时**放行**移动，否则人会永久卡死。
  const stuck = blockers.some((s) => circleHitsOBB(x0, z0, radius, s));

  let x = x0;
  let z = z0;
  let hitX = false;
  let hitZ = false;

  const nx = x0 + dx;
  if (stuck || !blockers.some((s) => circleHitsOBB(nx, z0, radius, s))) x = nx;
  else hitX = true;

  const nz = z0 + dz;
  if (stuck || !blockers.some((s) => circleHitsOBB(x, nz, radius, s))) z = nz;
  else hitZ = true;

  const bx = Math.max(-bound, Math.min(bound, x));
  const bz = Math.max(-bound, Math.min(bound, z));
  const clamped = bx !== x || bz !== z;

  return { x: bx, z: bz, hitX, hitZ, clamped };
}

/**
 * 竖直积分 + 落地判定。
 * @returns {{y:number, vy:number, grounded:boolean, landed:boolean, support:number, ceiling:number|null}}
 */
export function integrateVertical(state, dt, opts = {}) {
  const gravity = opts.gravity ?? -9.8;
  const maxFall = opts.maxFall ?? 34;
  const support = opts.support ?? 0;
  const ceiling = opts.ceiling ?? null; // 头顶碰撞（暂未使用，留给模块 3 的屋顶/洞窟）
  const eps = opts.epsilon ?? 0.02;

  let y = Number.isFinite(state.y) ? state.y : 0;
  let vy = Number.isFinite(state.vy) ? state.vy : 0;
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;

  vy += gravity * step;
  if (vy < -maxFall) vy = -maxFall;
  y += vy * step;

  let grounded = false;
  let landed = false;

  if (ceiling !== null && vy > 0 && y > ceiling) {
    y = ceiling;
    vy = 0;
  }
  if (vy <= 0 && y <= support + eps) {
    if (!state.grounded) landed = true;
    y = support;
    vy = 0;
    grounded = true;
  }
  return { y, vy, grounded, landed, support, ceiling };
}

/** 世界坐标的朝向角（yaw 约定与摄像机一致：yaw=0 → 面向 -Z） */
export function facingFromDir(dx, dz) {
  if (!Number.isFinite(dx) || !Number.isFinite(dz) || (dx === 0 && dz === 0)) return null;
  return Math.atan2(-dx, -dz);
}

/** 由 yaw 反推单位方向 */
export function dirFromFacing(facing) {
  return { x: -Math.sin(facing), z: -Math.cos(facing) };
}

/** 平面归一化，零向量返回 null（调用方据此判断"有没有输入"） */
export function normalizeDir(dx, dz) {
  const len = Math.hypot(dx, dz);
  if (!Number.isFinite(len) || len < 1e-6) return null;
  return { x: dx / len, z: dz / len, len };
}

/** 跳跃能达到的最大高度（纯公式，用来写断言而不是拍数字） */
export function jumpApex(velocity, gravity) {
  const g = Math.abs(gravity);
  if (g < 1e-9) return Infinity;
  return (velocity * velocity) / (2 * g);
}

/** 完整滞空时间 */
export function jumpAirTime(velocity, gravity) {
  const g = Math.abs(gravity);
  if (g < 1e-9) return Infinity;
  return (2 * velocity) / g;
}
