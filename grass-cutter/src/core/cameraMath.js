/**
 * 摄像机纯数学 —— 零依赖、零 DOM、零 three，所以能直接 `node --test`。
 * 运行时（cameraRig.js）只负责把这里的结果套到 three 对象上；
 * 任何"跟随够不够顺、碰撞退到多远"的判断都应该能在这一层被单测锁死。
 *
 * 坐标/角度约定与 config.js 头部一致：
 *   yaw = 0 → 玩家面向 -Z，摄像机在 +Z 一侧（正后方）
 *   pitch > 0 → 摄像机抬高（俯视玩家）
 */

const EPS = 1e-6;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 把任意输入收敛成有限数，防止 NaN 顺着矩阵污染整个场景
 * @param v 待检查的值
 * @param fallback 非有限时的兜底值
 */
function finite(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback;
}

/**
 * 平滑的兜底语义（很重要，别改成 0）：
 * 目标值是 NaN 时，**保持原地不动**，而不是朝 0 走。
 * 朝 0 走意味着"目标丢了"会表现为相机缓缓飘向世界原点 —— 一个很难查的诡异漂移；
 * 原地不动则表现为"卡住不动"，一眼能看出是上游给了脏数据。
 */
function safeTarget(t, current) {
  return Number.isFinite(t) ? t : current;
}

// ─────────────────────────────────────────────────────────── 平滑（插值）
/**
 * 帧率无关的指数平滑系数。
 * spec 的「插值系数 0.08」是**在 60fps 下**的语义，所以：
 *   dt = 1/60 时结果**恰好等于** 0.08；
 *   帧率变化（120fps / 30fps / 掉帧）时收敛速度不变，而不是"帧率越高跟得越紧"。
 * 不这么写，会出现"高刷屏上镜头更灵敏、低帧时镜头发飘"的经典抖动来源。
 */
export function dampFactor(k, dt, refFps = 60) {
  const kk = clamp(finite(k, 0), 0, 1);
  const steps = Math.max(0, finite(dt, 0)) * refFps;
  return 1 - Math.pow(1 - kk, steps);
}

export function damp(current, target, k, dt, refFps = 60) {
  const a = dampFactor(k, dt, refFps);
  const c = finite(current);
  return c + (safeTarget(target, c) - c) * a;
}

/** 三维版；输入输出都是普通对象，便于单测 */
export function dampVec3(current, target, k, dt, refFps = 60) {
  const a = dampFactor(k, dt, refFps);
  const c = current || {};
  const t = target || {};
  const cx = finite(c.x);
  const cy = finite(c.y);
  const cz = finite(c.z);
  return {
    x: cx + (safeTarget(t.x, cx) - cx) * a,
    y: cy + (safeTarget(t.y, cy) - cy) * a,
    z: cz + (safeTarget(t.z, cz) - cz) * a,
  };
}

// ─────────────────────────────────────────────────────────── boom（摇臂）几何
/** 由 spec 的「水平距离 / 高度」反算基准俯角（弧度） */
export function basePitch(distance, height) {
  return Math.atan2(finite(height), finite(distance));
}

/** 摇臂长度 = 相机到 pivot 的**直线**距离 */
export function boomLength(distance, height) {
  return Math.hypot(finite(distance), finite(height));
}

/** 相机相对 pivot 的偏移向量（含 yaw 旋转与 pitch） */
export function cameraOffset(yaw, pitch, length) {
  const cp = Math.cos(finite(pitch));
  return {
    x: Math.sin(finite(yaw)) * cp * finite(length),
    y: Math.sin(finite(pitch)) * finite(length),
    z: Math.cos(finite(yaw)) * cp * finite(length),
  };
}

export function cameraPosition(pivot, yaw, pitch, length) {
  const o = cameraOffset(yaw, pitch, length);
  const p = pivot || {};
  return { x: finite(p.x) + o.x, y: finite(p.y) + o.y, z: finite(p.z) + o.z };
}

/** 玩家前进方向（单位向量，y 分量恒 0）：yaw = 0 时为 (0,0,-1) */
export function forwardVector(yaw) {
  return { x: -Math.sin(finite(yaw)), y: 0, z: -Math.cos(finite(yaw)) };
}

/** 玩家右手方向（单位向量）：yaw = 0 时为 (1,0,0) */
export function rightVector(yaw) {
  return { x: Math.cos(finite(yaw)), y: 0, z: -Math.sin(finite(yaw)) };
}

// ─────────────────────────────────────────────────────────── 碰撞
/**
 * 把若干条射线的命中距离收敛成一个可用的摇臂长度。
 *  - 没有任何遮挡 → 用期望长度（原样返回，不做无谓的三维扰动）
 *  - 有遮挡       → min(期望, 最近命中 - 安全余量)，且不低于贴脸下限
 * 命中距离按沿射线的**参数 t**（0≈pivot，1≈期望相机位置），所以这里先把
 * 归一化 t 换算回米再比较 —— 传入 hitT 与 length 时注意单位（见 hitDistanceToMeters）。
 */
export function resolveBoomLength({ desired, hitDistances = [], margin = 0, minDistance = 0 } = {}) {
  const want = Math.max(0, finite(desired, 0));
  const hits = (hitDistances || []).map((d) => finite(d, Infinity)).filter((d) => d >= 0 && Number.isFinite(d));
  if (hits.length === 0) return want;
  const nearest = Math.min(...hits);
  const limited = Math.min(want, nearest - Math.max(0, finite(margin, 0)));
  return Math.max(Math.max(0, finite(minDistance, 0)), limited);
}

/** 命中点沿射线的 t（0~1）换算成米 */
export function hitTToMeters(t, length) {
  return clamp(finite(t, 1), 0, 1) * Math.max(0, finite(length, 0));
}

/** 相机离地硬下限 */
export function clampHeight(y, minY) {
  return Math.max(finite(y, 0), finite(minY, 0));
}

/**
 * 让相机不低于 `minY` 所允许的**最大摇臂长度**。
 *
 * 为什么需要它：spec 要求俯仰可以到 ±60°。俯角一旦为负，相机就往下走，
 * 摇臂 8.944m 会让它沉到地下（-60° 时 y = 1.6 - 7.74 = -6.1m）。
 * 传统做法是"地面钳制"——但它是在相机已经越界之后把 y 拽回来，
 * 于是相机会**离开射线**：画面里表现为"贴着地面平移，看不到人"，而且有穿模风险
 * （模块 1 之所以把俯角下限压到 -6° 就是为了躲开这条路）。
 *
 * 正确解法是把地面当成**几何约束**：先算出"在俯角 θ 下最长能用多长的摇臂"，
 * 再让它参与 min()。这样相机永远精确地停在地面下限上、始终留在射线上，
 * 而且这个上限是俯角的**连续函数** → 抬眼低头时镜头是连续变化的，不会跳。
 *
 *   相机 y = pivotY + sin(θ)·L ≥ minY  ⇒  L ≤ (minY − pivotY)/sin(θ)   （θ<0 时两边同为正）
 *   θ ≥ 0 时相机往上走，不受此约束（返回 Infinity）。
 */
export function groundLimitedBoom(pivotY, pitch, minY) {
  const p = finite(pitch, 0);
  if (p >= 0) return Infinity;
  const s = Math.sin(p);
  if (s >= -1e-9) return Infinity;
  // ⚠ 注视点高度非有限时**放弃约束**（返回 Infinity），而不是退化成 0：
  //   0 会让相机贴到注视点脸上——看起来像个"正常的近景 bug"，比明显的异常更难查。
  //   何况 pivotY 已经是 NaN 的话，落位结果本来就是 NaN，多这一层约束没有意义。
  if (!Number.isFinite(pivotY)) return Infinity;
  const limit = (finite(minY, 0) - pivotY) / s;
  // 再退 1e-6 米，避免浮点误差让 clampHeight 判定"钳制生效了"（groundClampHits 应恒为 0）
  return Math.max(0, limit - 1e-6);
}

/**
 * 选平滑系数：目标是**缩短**摇臂（被墙挡）→ 用快系数，立刻拉近；
 * 目标是**加长**摇臂（遮挡解除）→ 用慢系数，慢慢推回去。
 * 一快一慢是"镜头不抖"的核心：只用单一系数会出现"贴着墙时反复穿模/弹开"。
 */
export function boomSmoothK(current, target, pullInK, pushOutK) {
  const c = finite(current, 0);
  const t = finite(target, 0);
  return t < c - EPS ? finite(pullInK, 0) : finite(pushOutK, 0);
}

/** 角度收进 [min, max] */
export function clampPitch(pitch, minPitch, maxPitch) {
  return clamp(finite(pitch, 0), Math.min(minPitch, maxPitch), Math.max(minPitch, maxPitch));
}

/** yaw 规范到 (-π, π]，避免长时间旋转后累加到 1e6 导致精度塌陷 */
export function wrapYaw(yaw) {
  const tau = Math.PI * 2;
  let y = finite(yaw, 0) % tau;
  if (y > Math.PI) y -= tau;
  if (y <= -Math.PI) y += tau;
  return y;
}

/** 把相机推到障碍内侧时用：从命中点沿射线方向回退 margin（米） */
export function pullbackPoint(origin, dir, meters) {
  const o = origin || {};
  const d = dir || {};
  const m = Math.max(0, finite(meters, 0));
  const len = Math.hypot(finite(d.x), finite(d.y), finite(d.z)) || 1;
  return {
    x: finite(o.x) + (finite(d.x) / len) * m,
    y: finite(o.y) + (finite(d.y) / len) * m,
    z: finite(o.z) + (finite(d.z) / len) * m,
  };
}
