/**
 * 像素跑酷 PIXEL RUNNER · 核心逻辑（纯函数，不碰 DOM / Canvas / 时钟）
 * ============================================================================
 * 这一层可以被 node 直接 import 跑测试：
 *   · 时间一律由调用方传 dt（秒），不读 Date.now / performance.now
 *   · 随机数走注入的 Rng（同种子必然同序列）
 *   · 世界坐标：x 向右增长（相机跟随），y 向上为正，地面 y = 0
 * ============================================================================
 */

/* ------------------------------ 常量 ------------------------------ */

export const GRAVITY = 2900;          // px/s²
export const JUMP_V = -980;           // 一段跳初速
export const DOUBLE_JUMP_V = -840;    // 二段跳初速
export const COYOTE_TIME = 0.10;      // 离地后仍可跳的宽容时间
export const JUMP_BUFFER = 0.12;      // 落地前提前按的缓冲时间

export const PLAYER_W = 34;
export const PLAYER_H = 50;
export const SLIDE_H = 26;
export const SLIDE_TIME = 0.45;       // 滑铲最长时长

export const BASE_SPEED = 430;        // 起始速度 px/s
export const SPEED_MAX = 1180;
export const SPEED_RAMP = 11;         // 每秒加速 px/s

export const MAX_STEP = 1 / 120;      // 单步最大 dt（防止切后台回来瞬移）
export const SUB_STEPS_MAX = 8;

/* 障碍物类型：地面刺 / 高横杆 / 飞行物 */
export const OBSTACLE_KINDS = ['spike', 'bar', 'drone'];

/* 道具 */
export const POWERUPS = ['shield', 'magnet', 'slow'];

/* 币值与分值 */
export const COIN_VALUE = 1;
export const SCORE_PER_METER = 1;
export const NEAR_MISS_BONUS = 5;

/* ------------------------------ 随机 -------------- */

/** mulberry32：小而稳的确定性 PRNG。 */
export function makeRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 把字符串散列成 32 位种子。 */
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/* ------------------------------ 几何 ------------------------------ */

/** 轴对齐碰撞检测（矩形用 {x,y,w,h}，y 为底部，向上为正）。 */
export function aabb(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x
    && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** 玩家当前碰撞盒（滑铲时更矮）。 */
export function playerBox(p) {
  const h = p.sliding ? SLIDE_H : PLAYER_H;
  return { x: p.x - PLAYER_W / 2, y: p.y, w: PLAYER_W, h };
}

/* ------------------------------ 难度 ------------------------------ */

/** 当前速度（px/s）：随时间线性爬升，封顶 SPEED_MAX。 */
export function speedAt(t, opts = {}) {
  const base = opts.base ?? BASE_SPEED;
  const max = opts.max ?? SPEED_MAX;
  const ramp = opts.ramp ?? SPEED_RAMP;
  return Math.min(max, base + ramp * Math.max(0, t));
}

/**
 * 生成间隔（秒）：速度越快间隔越短，但有下限，保证"永远跳得过去"。
 * 关键不变量：两次障碍之间的可反应距离 ≥ 一个完整跳跃的滞空距离 × 1.6。
 */
export function spawnGap(speed, rng, opts = {}) {
  const jumpAir = Math.abs(2 * JUMP_V / GRAVITY);        // 单跳滞空秒数
  /* 最小安全距离：一个完整跳跃的滞空距离 × 1.6。
     随着速度上升，这个"绝对距离"自然变大（speed 变大），
     但我们要的是**秒数**变短——所以额外乘一个随速度衰减的系数，
     让高端局的反应窗口真正被压缩，而距离仍 ≥ 安全下限。 */
  const minDist = speed * jumpAir * 1.6;
  const speedT = Math.min(1, Math.max(0, (speed - BASE_SPEED) / (SPEED_MAX - BASE_SPEED)));
  const tighten = 1.15 - 0.38 * speedT;                  // 1.15 → 0.77
  const baseDist = minDist * (tighten + rng() * (0.9 - 0.42 * speedT));
  const dist = Math.max(minDist * 1.02, baseDist);
  return dist / Math.max(1, speed);
}

/* ------------------------------ 初始状态 ------------------------------ */

export function createRun(opts = {}) {
  const seed = opts.seed === undefined ? 'default' : opts.seed;
  const rng = makeRng(typeof seed === 'number' ? seed : hashSeed(seed));
  return {
    seed: String(seed),
    rng,
    t: 0,                    // 存活秒数
    x: 0,                    // 玩家世界 x
    y: 0,                    // 玩家世界 y（底部）
    vy: 0,
    onGround: true,
    jumpsLeft: 2,
    coyote: 0,               // 离地后剩余宽容时间
    buffer: 0,               // 跳跃缓冲剩余
    sliding: false,
    slideT: 0,
    dead: false,
    deathReason: null,
    coins: 0,
    score: 0,
    nearMiss: 0,
    combo: 0,
    shield: false,
    magnetT: 0,
    slowT: 0,
    obstacles: [],
    pickups: [],
    nextSpawnAt: 1.6,        // 首个障碍前的空窗
    nextPickupAt: 2.4,
    lastKind: null,
    history: [],             // 最近事件（UI 做特效，测试做断言）
  };
}

/* ------------------------------ 输入 ------------------------------ */

/** 按跳：支持二段跳 + 土狼时间 + 输入缓冲。 */
export function pressJump(run) {
  if (run.dead) return false;
  run.buffer = JUMP_BUFFER;          // 先记缓冲，grounded 时立刻消费
  return consumeJump(run);
}

function consumeJump(run) {
  if (run.jumpsLeft <= 0) return false;
  const canGround = run.onGround || run.coyote > 0;
  if (canGround) {
    run.vy = JUMP_V;
    run.onGround = false;
    run.coyote = 0;
    run.jumpsLeft = 1;               // 用掉地面跳，剩一次空中跳
    run.sliding = false;
    run.buffer = 0;
    run.history.push({ t: run.t, type: 'jump', air: false });
    return true;
  }
  if (run.jumpsLeft > 0) {
    run.vy = DOUBLE_JUMP_V;
    run.jumpsLeft = 0;
    run.buffer = 0;
    run.sliding = false;
    run.history.push({ t: run.t, type: 'jump', air: true });
    return true;
  }
  return false;
}

/** 按下滑铲：在空中按下会快速落地（手感上的"快落"）。 */
export function pressSlide(run) {
  if (run.dead) return false;
  if (!run.onGround) {
    run.vy = Math.max(run.vy, 1400);  // 快落
    run.history.push({ t: run.t, type: 'fastfall' });
    return true;
  }
  run.sliding = true;
  run.slideT = SLIDE_TIME;
  run.history.push({ t: run.t, type: 'slide' });
  return true;
}

export function releaseSlide(run) {
  if (run.sliding) {
    run.sliding = false;
    run.slideT = 0;
  }
}

/* ------------------------------ 生成 ------------------------------ */

function pickKind(run, rng) {
  const t = run.t;
  // 前 8 秒只出地面刺（教学期）
  if (t < 8) return 'spike';
  const r = rng();
  if (t < 20) return r < 0.75 ? 'spike' : 'bar';
  if (r < 0.42) return 'spike';
  if (r < 0.76) return 'bar';
  return 'drone';
}

function spawnObstacle(run, rng) {
  const kind = pickKind(run, rng);
  const speed = speedAt(run.t);
  const ahead = run.x + Math.max(560, speed * 1.35);

  if (kind === 'spike') {
    const w = 26 + Math.floor(rng() * 3) * 12;
    run.obstacles.push({ kind, x: ahead, y: 0, w, h: 34, hit: false });
  } else if (kind === 'bar') {
    // 高横杆：必须滑铲
    const w = 60 + Math.floor(rng() * 3) * 20;
    run.obstacles.push({ kind, x: ahead, y: 62, w, h: 26, hit: false });
  } else {
    // 飞行物：悬在空中，跳过或蹲下都能过（但高度要求精准）
    const w = 40;
    const y = 38 + rng() * 24;
    run.obstacles.push({ kind, x: ahead, y, w, h: 30, hit: false, bobT: rng() * 6.28 });
  }

  run.lastKind = kind;
  run.nextSpawnAt = spawnGap(speed, rng);
}

function spawnPickup(run, rng) {
  const speed = speedAt(run.t);
  const ahead = run.x + Math.max(600, speed * 1.5);
  const r = rng();

  if (r < 0.16) {
    const kind = POWERUPS[Math.floor(rng() * POWERUPS.length)];
    run.pickups.push({ kind, x: ahead, y: 90 + rng() * 50, r: 16, taken: false, bobT: rng() * 6.28 });
    return;
  }

  // 一弧硬币（5~8 枚，抛物线排列，诱导玩家跳）
  const n = 5 + Math.floor(rng() * 4);
  const span = 40;
  const peak = 60 + rng() * 70;
  for (let i = 0; i < n; i++) {
    const u = n === 1 ? 0 : i / (n - 1);
    const y = 40 + peak * Math.sin(Math.PI * u);
    run.pickups.push({
      kind: 'coin', x: ahead + i * span, y, r: 11, taken: false, bobT: u * 6.28,
    });
  }
}

/* ------------------------------ 单步推进 ------------------------------ */

/**
 * 推进一帧（自动拆成 ≤ MAX_STEP 的子步，保证高帧率/低帧率手感一致）。
 * @returns {{events:Array, dead:boolean}}
 */
export function step(run, dt, opts = {}) {
  const events = [];
  if (run.dead) return { events, dead: true };

  let remain = Math.min(Math.max(0, Number(dt) || 0), MAX_STEP * SUB_STEPS_MAX);
  const slow = run.slowT > 0 ? 0.55 : 1;      // 慢放道具：世界前进变慢

  while (remain > 1e-9) {
    const h = Math.min(MAX_STEP, remain);
    remain -= h;
    advance(run, h * slow, events, opts);
    if (run.dead) break;
  }
  return { events, dead: run.dead };
}

function advance(run, dt, events, opts) {
  run.t += dt;
  const speed = speedAt(run.t, opts);

  // 位移
  run.x += speed * dt;

  // 垂直物理
  run.vy += GRAVITY * dt;
  run.y -= run.vy * dt;      // vy 正 = 向上，所以 y 减去

  if (run.y <= 0) {
    if (!run.onGround) {
      events.push({ type: 'land', t: run.t });
    }
    run.y = 0;
    run.vy = 0;
    run.onGround = true;
    run.jumpsLeft = 2;
    run.coyote = 0;
    // 落地缓冲：玩家提前按过就立刻起跳
    if (run.buffer > 0) {
      run.buffer = 0;
      consumeJump(run);
    }
  } else {
    if (run.onGround) {
      run.onGround = false;
      run.coyote = COYOTE_TIME;
    }
    run.coyote = Math.max(0, run.coyote - dt);
  }

  if (run.buffer > 0) run.buffer = Math.max(0, run.buffer - dt);

  // 滑铲计时
  if (run.sliding) {
    run.slideT -= dt;
    if (run.slideT <= 0) run.sliding = false;
  }

  // 道具计时
  if (run.magnetT > 0) run.magnetT = Math.max(0, run.magnetT - dt);
  if (run.slowT > 0) run.slowT = Math.max(0, run.slowT - dt);

  // 生成
  run.nextSpawnAt -= dt;
  if (run.nextSpawnAt <= 0) spawnObstacle(run, run.rng);
  run.nextPickupAt -= dt;
  if (run.nextPickupAt <= 0) {
    spawnPickup(run, run.rng);
    const speed2 = speedAt(run.t, opts);
    run.nextPickupAt = Math.max(1.2, 2.6 - speed2 / 4000) * (0.8 + run.rng() * 0.7);
  }

  // 清理远离的物体
  const cullX = run.x - 400;
  if (run.obstacles.length && run.obstacles[0].x + 200 < cullX) {
    run.obstacles = run.obstacles.filter((o) => o.x + 200 >= cullX);
  }
  if (run.pickups.length && run.pickups[0].x + 200 < cullX) {
    run.pickups = run.pickups.filter((p) => p.x + 200 >= cullX);
  }

  // 碰撞：障碍
  const pb = playerBox(run);
  for (const o of run.obstacles) {
    if (o.hit) continue;
    const ob = { x: o.x - o.w / 2, y: o.y, w: o.w, h: o.h };
    if (aabb(pb, ob)) {
      o.hit = true;
      if (run.shield) {
        run.shield = false;
        events.push({ type: 'shield-break', t: run.t, kind: o.kind });
        run.history.push({ t: run.t, type: 'shield-break' });
      } else {
        run.dead = true;
        run.deathReason = o.kind;
        events.push({ type: 'death', t: run.t, kind: o.kind });
        run.history.push({ t: run.t, type: 'death', kind: o.kind });
        return;
      }
    } else {
      // 擦身而过（近失）：判定"从旁边 8px 内掠过"
      const dx = Math.abs((pb.x + pb.w / 2) - o.x) - (pb.w + o.w) / 2;
      const dy = Math.abs((pb.y + pb.h / 2) - (o.y + o.h / 2)) - (pb.h + o.h) / 2;
      const gap = Math.max(dx, dy);
      if (!o.nearMissed && gap < 10 && gap > -1) {
        o.nearMissed = true;
        run.nearMiss += 1;
        run.score += NEAR_MISS_BONUS;
        events.push({ type: 'near-miss', t: run.t, x: o.x });
      }
    }
  }

  // 碰撞：拾取
  for (const p of run.pickups) {
    if (p.taken) continue;
    const magnetR = run.magnetT > 0 ? 130 : 0;
    const dist = Math.hypot(p.x - run.x, p.y - (run.y + (pb.h / 2)));
    if (dist <= p.r + 16 + magnetR) {
      p.taken = true;
      if (p.kind === 'coin') {
        run.coins += COIN_VALUE;
        events.push({ type: 'coin', t: run.t, x: p.x, y: p.y });
      } else if (p.kind === 'shield') {
        run.shield = true;
        events.push({ type: 'powerup', t: run.t, kind: 'shield' });
      } else if (p.kind === 'magnet') {
        run.magnetT = 6;
        events.push({ type: 'powerup', t: run.t, kind: 'magnet' });
      } else if (p.kind === 'slow') {
        run.slowT = 5;
        events.push({ type: 'powerup', t: run.t, kind: 'slow' });
      }
    }
  }
}

/* ------------------------------ 结算 ------------------------------ */

export function distanceOf(run) {
  return Math.max(0, Math.floor(run.x / 10));      // 10px = 1 米
}

export function summarize(run) {
  const dist = distanceOf(run);
  return {
    distance: dist,
    meters: dist,
    seconds: Math.round(run.t * 10) / 10,
    coins: run.coins,
    nearMiss: run.nearMiss,
    score: scoreOf(run),
    shield: run.shield,
    deathReason: run.deathReason,
    seed: run.seed,
  };
}

/** 最终得分 = 距离 + 硬币×10 + 近失×5（近失已在跑动中累加过，这里只算一次）。 */
export function scoreOf(run) {
  return distanceOf(run) * SCORE_PER_METER + run.coins * 10;
}

/* ------------------------------ 自检（构建期 + 测试用） ------------------------------ */

/**
 * 校验生成逻辑不会产出"必死局"：
 * 以固定速度跑 200 次生成，检查相邻障碍的间距都 ≥ 最小安全距离。
 * @returns {string[]} 问题列表，空 = 健康
 */
export function validateSpawning(seed = 'validate', iterations = 200) {
  const problems = [];
  const rng = makeRng(hashSeed(seed));
  const speed = BASE_SPEED;
  const jumpAir = Math.abs(2 * JUMP_V / GRAVITY);
  const minDist = speed * jumpAir * 1.6;

  for (let i = 0; i < iterations; i++) {
    const gap = spawnGap(speed, rng);
    const dist = gap * speed;
    if (gap <= 0) problems.push(`第 ${i} 次间隔非正：${gap}`);
    if (dist < minDist - 1e-6) problems.push(`第 ${i} 次间距过小：${dist.toFixed(1)} < ${minDist.toFixed(1)}`);
  }
  return problems;
}

export default {
  createRun, step, pressJump, pressSlide, releaseSlide,
  aabb, playerBox, speedAt, spawnGap, makeRng, hashSeed,
  summarize, scoreOf, distanceOf, validateSpawning,
};
