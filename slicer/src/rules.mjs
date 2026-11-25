/* =============================================================================
 * slicer/src/rules.mjs —— 切片大师规则引擎（零依赖、纯逻辑、可单测）
 * -----------------------------------------------------------------------------
 * 玩法（休闲「切水果」类，但机制是自己设计的，不抄任何现成游戏）：
 *   · 场上不断有物体从上方落下：水果 / 炸弹 / 冰冻蛋 / 磁铁星。
 *   · 玩家用鼠标或手指**划过**屏幕，画出一条轨迹；轨迹扫过的物体会被切开。
 *   · 水果被切 → 裂成两半（表现层的事，规则层只记「被切了」），按品种计分。
 *   · 一次划过切中多个水果 → 连击倍率（最高 4 倍）。
 *   · 炸弹 → 扣分、连击清零；累计 3 颗炸弹直接判负结束。
 *   · 冰冻蛋 → 全场慢速 5 秒（时间尺度被压慢）。
 *   · 磁铁星 → 周围物体被横向吸引过来，方便连切。
 *   · 每局限时 60 秒，结束显示得分、最佳连击、评价等级（S/A/B/C/D）。
 *   · 难度随时间上升：刷新更快、下落更快、炸弹更多。
 *   · 每日一局：日期派生 seed，同一天所有人的出现序列完全一致。
 *
 * ---------------------------------------------------------------------------
 * P2P 的难点：轨迹是**连续像素数据**，不是离散动作
 * -----------------------------------------------------------------------------
 * 普通的联机游戏传的是「走了一步棋」这种离散动作；这里传的是一整条轨迹
 * （几十个浮点坐标点）。硬塞进权威动作序列有两个问题：
 *   ① 体积大，而且天然是增量的（边划边发）；
 *   ② 更要命的是——**结算必须两边一致**。一旦允许轨迹乱序到达，
 *      任何依赖「之前发生过什么」的效果（冰冻减速、磁铁吸引）就会算歪。
 *
 * 解法（三条）：
 *   1. 轨迹走**独立的增量消息** {t:'slicer-stroke'}，不进权威动作序列；
 *      结算（切中几颗、多少分）由双方**各自按同一套规则算**。
 *   2. 随机数完全**可推导**：整张出现顺序表 schedule = f(seed, 序号)，
 *      序号就是调度表下标。哈希用 FNV-1a（**不用 crypto.subtle** ——
 *      file:// 不是安全上下文，crypto.subtle 在 file:// 下是 undefined）。
 *   3. 结算用**纯函数重算**：score = evaluate(seed, 轨迹集合)。
 *      evaluate 只依赖 (seed, 轨迹集合)，跟轨迹到达顺序无关，
 *      所以哪怕两端轨迹到达顺序不同，最终分数也必然一致。
 *      代价是每来一条轨迹就重算一次 —— 一局最多几百条，够快。
 *
 * 纪律：
 *   · 顶层不碰 DOM、不碰 localStorage。
 *   · 所有随机都是纯 JS 伪随机（mulberry32 + FNV-1a），不用 Math.random()。
 * ========================================================================== */

/* ---------------------------------------------------------------------------
 * 常量
 * ------------------------------------------------------------------------- */

/** 逻辑帧长（毫秒）。20 帧/秒。 */
export const TICK_MS = 50;

/** 一局多少逻辑帧（1200 帧 = 60 秒）。 */
export const ROUND_FRAMES = 1200;

/** 虚拟坐标系：100 × 100，y 向下。轨迹坐标也用这套，跟屏幕分辨率无关。 */
export const VW = 100;
export const VH = 100;

/** 物体类型。 */
export const T_FRUIT = 'fruit';
export const T_BOMB = 'bomb';
export const T_ICE = 'ice';
export const T_MAGNET = 'magnet';

/** 水果品种：半径越大越好切但分少，越小越值钱。 */
export const FRUIT_KINDS = [
  { name: '西瓜', r: 6.0, points: 12, color: '#e0574f', leaf: false },
  { name: '草莓', r: 3.6, points: 16, color: '#ef476f', leaf: false },
  { name: '橙子', r: 4.6, points: 9, color: '#f7931e', leaf: true },
  { name: '苹果', r: 4.2, points: 10, color: '#d7263d', leaf: true },
  { name: '葡萄', r: 2.8, points: 20, color: '#8e44ad', leaf: true },
];

/** 炸弹半径（比水果小一点，视觉上更扎眼）。 */
export const BOMB_R = 3.4;
export const ICE_R = 3.8;
export const MAGNET_R = 4.2;

/** 切到炸弹扣多少分。 */
export const BOMB_PENALTY = 25;
/** 累计几颗炸弹直接判负。 */
export const MAX_BOMBS = 3;
/** 冰冻蛋得分。 */
export const ICE_POINTS = 30;
/** 磁铁星得分。 */
export const MAGNET_POINTS = 20;
/** 冰冻持续帧数（100 帧 = 5 秒）。 */
export const FREEZE_FRAMES = 100;
/** 磁铁持续帧数（80 帧 = 4 秒）。 */
export const MAGNET_FRAMES = 80;
/** 冰冻时的时间倍率（越小越慢）。 */
export const FREEZE_FACTOR = 0.5;
/** 磁铁时的时间倍率。 */
export const MAGNET_FACTOR = 0.8;
/** 磁铁吸引半径（虚拟单位）。 */
export const MAGNET_RANGE = 22;
/** 磁铁最大吸引比例。 */
export const MAGNET_PULL = 0.55;
/** 刀刃宽容度：判定时半径 +BLADE，手指划得糙也能切到。 */
export const BLADE = 1.0;
/** 连击倍率上限。 */
export const MAX_COMBO_MULT = 4;
/** 一个物体最多能活多久（用于粗筛，冰冻时会更久，留足余量）。 */
export const MAX_LIFETIME = 280;

/* ---------------------------------------------------------------------------
 * 哈希与伪随机
 * ------------------------------------------------------------------------- */

/** FNV-1a 32 位哈希（纯 JS，file:// 下可用）。 */
export function fnv1a(str) {
  const s = String(str);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 —— 32 位伪随机数发生器，返回 [0,1)。 */
export function mulberry32(a) {
  let s = a >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 第 index 号物体的随机流种子。
 * 序号是公开的、写在调度表里 —— 房主改不了。
 */
export function hashInt(seed, index) {
  return fnv1a('slicer|' + (seed >>> 0) + '|' + index);
}

/**
 * 开局用的随机种子（单机局用；只用来生成一次性初始 seed）。
 *
 * 不用 Math.random() —— 全部随机走 FNV-1a + mulberry32，
 * 这样整个规则层只有「seed + 计数器」这一种随机来源，房主推不出来也改不了。
 */
let soloSeedCounter = 0;
export function randomSeed() {
  soloSeedCounter += 1;
  return fnv1a('slicer|solo|' + Date.now() + '|' + soloSeedCounter);
}

/** 日期字符串（本地时区），每日一局用。 */
export function dateKey(d) {
  const dt = d || new Date();
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

/** 每日一局的种子：同一天全球算出来都一样。 */
export function dailySeed(key) {
  return fnv1a('slicer|daily|' + (key || dateKey()));
}

/** 从房间号派生种子（P2P 局用，双方交换连接码时房号都在手上）。 */
export function seedFromRoom(roomId, gameId) {
  return fnv1a((gameId || 'slicer') + '|room|' + (roomId || '0'));
}

/* ---------------------------------------------------------------------------
 * 出现顺序表（schedule）
 * ------------------------------------------------------------------------- */

/**
 * 按 seed 生成整局的出现顺序表。
 *
 * 这是纯函数：给定 seed，双方拿到的表一模一样，房主改不了。
 * 每个物体用 `mulberry32(hashInt(seed, index))` 抽自己的随机数 ——
 * 抽的次数与顺序固定，所以每个物体的参数只跟 (seed, index) 有关。
 */
export function buildSchedule(seed) {
  const s = seed >>> 0;
  const out = [];
  let frame = 8;
  let index = 0;
  while (index < 400 && frame < ROUND_FRAMES - 20) {
    const rnd = mulberry32(hashInt(s, index));
    const diff = Math.min(1, frame / ROUND_FRAMES);   /* 0 → 1 难度 */
    /* 刷新间隔：前期慢，后期快 */
    const gap = Math.round(7 + 11 * (1 - diff) + rnd() * 6);
    frame += gap;
    if (frame >= ROUND_FRAMES - 20) break;

    /* 类型：炸弹概率随难度上升 */
    const tr = rnd();
    const bombChance = 0.04 + 0.13 * diff;
    const iceChance = 0.10;
    const magnetChance = 0.09;
    let type = T_FRUIT;
    if (tr < bombChance) type = T_BOMB;
    else if (tr < bombChance + iceChance) type = T_ICE;
    else if (tr < bombChance + iceChance + magnetChance) type = T_MAGNET;

    let kind = 0, r = 4, points = 0, color = '#888', name = '';
    if (type === T_FRUIT) {
      kind = Math.floor(rnd() * FRUIT_KINDS.length) % FRUIT_KINDS.length;
      const k = FRUIT_KINDS[kind];
      r = k.r; points = k.points; color = k.color; name = k.name;
    } else if (type === T_BOMB) {
      r = BOMB_R + rnd() * 1.2; points = 0; color = '#2f3542'; name = '炸弹';
    } else if (type === T_ICE) {
      r = ICE_R; points = ICE_POINTS; color = '#48b8e8'; name = '冰冻蛋';
    } else {
      r = MAGNET_R; points = MAGNET_POINTS; color = '#f4c542'; name = '磁铁星';
    }

    /* 横向位置：留出边距 */
    const margin = r + 2;
    const x = margin + rnd() * Math.max(1, (VW - 2 * margin));

    /* 运动参数：越到后面掉得越快 */
    const vx = (rnd() - 0.5) * 0.12;
    const vy = 0.28 + 0.30 * diff + rnd() * 0.06;
    const g = 0.009 + 0.010 * diff;

    out.push({
      id: index,
      frame: frame,
      type: type,
      kind: kind,
      name: name,
      color: color,
      r: r,
      points: points,
      x: x,
      y0: -r - 1,
      vx: vx,
      vy: vy,
      g: g,
    });
    index++;
  }
  return out;
}

/* 调度表按 seed 缓存 —— 每来一条轨迹都要重算一遍结算，别重复生成。 */
const SCHED_CACHE = new Map();
/** 取（并缓存）某个 seed 的调度表。 */
export function scheduleOf(seed) {
  const s = seed >>> 0;
  let t = SCHED_CACHE.get(s);
  if (!t) {
    t = buildSchedule(s);
    /* 只留最近 8 张，内存不会无限涨 */
    if (SCHED_CACHE.size > 8) SCHED_CACHE.delete(SCHED_CACHE.keys().next().value);
    SCHED_CACHE.set(s, t);
  }
  return t;
}

/* ---------------------------------------------------------------------------
 * 几何
 * ------------------------------------------------------------------------- */

/**
 * 把轨迹点加密：太长的线段拆成小段。
 * 手指划得快时 pointermove 很稀，直接用粗线段判交容易「穿过」小水果。
 */
export function densify(pts, maxLen) {
  const step = maxLen || 2.5;
  const out = [];
  if (!pts || !pts.length) return out;
  out.push([pts[0][0], pts[0][1]]);
  for (let i = 1; i < pts.length; i++) {
    const a = out[out.length - 1];
    const b = pts[i];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len <= 1e-9) continue;
    const n = Math.ceil(len / step);
    for (let k = 1; k <= n; k++) {
      out.push([a[0] + dx * k / n, a[1] + dy * k / n]);
    }
  }
  return out;
}

/** 轨迹 → 线段数组（每段 [x1,y1,x2,y2]）。单点也算一条退化线段。 */
export function segmentsOf(pts, maxLen) {
  const dense = densify(pts, maxLen);
  const segs = [];
  if (!dense.length) return segs;
  if (dense.length === 1) {
    segs.push([dense[0][0], dense[0][1], dense[0][0], dense[0][1]]);
    return segs;
  }
  for (let i = 1; i < dense.length; i++) {
    segs.push([dense[i - 1][0], dense[i - 1][1], dense[i][0], dense[i][1]]);
  }
  return segs;
}

/** 线段与圆是否相交（点到线段的最短距离 ≤ r）。 */
export function segCircleHit(x1, y1, x2, y2, cx, cy, r) {
  if (!(r > 0)) return false;
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 1e-12) t = ((cx - x1) * dx + (cy - y1) * dy) / len2;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const px = x1 + t * dx, py = y1 + t * dy;
  const ex = px - cx, ey = py - cy;
  return ex * ex + ey * ey <= r * r;
}

/* ---------------------------------------------------------------------------
 * 慢速效果与位置
 * ------------------------------------------------------------------------- */

/**
 * 从 f0 到 f 经过的「有效帧数」。
 *
 * 慢速窗口（冰冻 / 磁铁）里的帧只算一部分，
 * 所以落在窗口之后才生成的物体，也会跟着变慢 —— 整场是同一套时间尺度。
 */
export function effectiveFrames(f0, f, slow) {
  if (f <= f0) return 0;
  const wins = [];
  for (const w of (slow || [])) {
    if (w.e <= f0 || w.s >= f) continue;
    wins.push(w);
  }
  if (!wins.length) return f - f0;
  wins.sort((a, b) => a.s - b.s);
  let eff = 0;
  let cur = f0;
  for (const w of wins) {
    const s = Math.max(w.s, cur);
    const e = Math.min(w.e, f);
    if (e <= s) continue;
    if (s > cur) { eff += s - cur; cur = s; }
    eff += (w.factor == null ? 1 : w.factor) * (e - cur);
    cur = e;
    if (cur >= f) break;
  }
  eff += (f - cur);
  return eff;
}

/**
 * 物体在某一帧的位置。
 * @param {object} obj    调度表里的一项
 * @param {number} frame  逻辑帧
 * @param {object} ctx    { slow:[{s,e,factor}], magnets:[{s,e,x}] }
 */
export function objPos(obj, frame, ctx) {
  const c = ctx || {};
  const eff = effectiveFrames(obj.frame, frame, c.slow);
  let x = obj.x + (obj.vx || 0) * eff;
  const y = obj.y0 + obj.vy * eff + 0.5 * obj.g * eff * eff;
  /* 磁铁横向牵引 */
  for (const m of (c.magnets || [])) {
    if (frame < m.s || frame > m.e) continue;
    const dx = m.x - x;
    const dist = Math.abs(dx);
    if (dist >= MAGNET_RANGE || dist < 1e-6) continue;
    const strength = (1 - dist / MAGNET_RANGE) * MAGNET_PULL;
    const grow = Math.min(1, (frame - m.s + 1) / 24);
    x += (dx >= 0 ? 1 : -1) * dist * strength * grow;
  }
  return { x: x, y: y };
}

/** 当前帧下可见（还没被切、还没掉出画面）的物体。 */
export function visibleObjects(seed, frame, summary) {
  const sched = scheduleOf(seed);
  const sum = summary || {};
  const sliced = new Set(sum.sliced || []);
  const slow = [];
  for (const w of (sum.freezes || [])) if (w.s <= frame) slow.push(w);
  const mags = [];
  for (const m of (sum.magnetWins || [])) if (m.s <= frame) mags.push(m);
  const ctx = { slow: slow, magnets: mags };
  const out = [];
  for (const o of sched) {
    if (sliced.has(o.id)) continue;
    if (frame < o.frame) continue;
    if (frame - o.frame > MAX_LIFETIME) continue;
    const p = objPos(o, frame, ctx);
    if (p.y - o.r > VH) continue;
    out.push({
      id: o.id, type: o.type, kind: o.kind, name: o.name, color: o.color,
      r: o.r, points: o.points, x: p.x, y: p.y,
    });
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * 轨迹与结算
 * ------------------------------------------------------------------------- */

/** 连击倍率：切中 n 个水果 → 1 + 0.5*(n-1)，封顶 4 倍。 */
export function comboMult(fruitCount) {
  const n = Math.max(0, fruitCount | 0);
  if (n <= 1) return 1;
  return Math.min(MAX_COMBO_MULT, 1 + 0.5 * (n - 1));
}

/** 分数 → 评价等级。 */
export function gradeOf(score) {
  const s = Math.max(0, score | 0);
  if (s >= 900) return 'S';
  if (s >= 650) return 'A';
  if (s >= 400) return 'B';
  if (s >= 200) return 'C';
  return 'D';
}

/** 轨迹规范化；不合法就返回 null（整手丢弃）。 */
export function normalizeStroke(act) {
  if (!act || act.act !== 'stroke') return null;
  const id = act.id;
  if (id == null || id === '') return null;
  const frame = act.frame;
  if (!Number.isFinite(frame) || frame < 0 || Math.floor(frame) !== frame) return null;
  const seat = act.seat == null ? 0 : act.seat;
  if (seat !== 0 && seat !== 1) return null;
  const raw = act.pts;
  if (!Array.isArray(raw) || raw.length < 1) return null;
  const pts = [];
  for (const p of raw) {
    if (!p || p.length < 2) return null;
    const x = Number(p[0]), y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    pts.push([x, y]);
  }
  return { act: 'stroke', id: String(id), frame: frame, seat: seat, pts: pts };
}

/** 轨迹的规范顺序：先按帧，再按座位，最后按 id —— 保证两端算出来一样。 */
export function canonicalCompare(a, b) {
  if (a.frame !== b.frame) return a.frame - b.frame;
  if (a.seat !== b.seat) return a.seat - b.seat;
  return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
}

/** 把轨迹列表排成规范顺序。 */
export function canonicalStrokes(list) {
  const arr = [];
  const seen = new Set();
  for (const raw of (list || [])) {
    const s = normalizeStroke(raw);
    if (!s) continue;
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    arr.push(s);
  }
  arr.sort(canonicalCompare);
  return arr;
}

/**
 * 结算：**纯函数**。
 *
 * score = evaluate(seed, 轨迹集合)
 * 只依赖 (seed, 轨迹集合)，跟轨迹到达顺序无关 ——
 * 这就是 P2P 下两端分数必然一致的根据。
 */
export function evaluate(seed, strokes) {
  const sched = scheduleOf(seed >>> 0);
  const list = canonicalStrokes(strokes);
  const sliced = new Set();
  const res = {
    score: 0,
    bestCombo: 0,
    fruits: 0,
    bombs: 0,
    ices: 0,
    magnets: 0,
    freezes: [],
    magnetWins: [],
    events: [],
    sliced: [],
    lastFrame: 0,
    over: false,
    grade: 'D',
    strokeCount: list.length,
  };

  for (const s of list) {
    /* 只有更早的轨迹产生的效果才作用于这一刀 */
    const slow = [];
    for (const w of res.freezes) if (w.s <= s.frame) slow.push(w);
    const mags = [];
    for (const m of res.magnetWins) if (m.s <= s.frame) mags.push(m);
    const ctx = { slow: slow, magnets: mags };
    const segs = segmentsOf(s.pts);

    const hits = [];
    for (const o of sched) {
      if (sliced.has(o.id)) continue;
      if (s.frame < o.frame) continue;
      if (s.frame - o.frame > MAX_LIFETIME) continue;
      const p = objPos(o, s.frame, ctx);
      if (p.y - o.r > VH) continue;            /* 已经掉出画面 */
      let hit = false;
      for (const g of segs) {
        if (segCircleHit(g[0], g[1], g[2], g[3], p.x, p.y, o.r + BLADE)) { hit = true; break; }
      }
      if (hit) hits.push(o);
    }

    const fruits = hits.filter((o) => o.type === T_FRUIT);
    const mult = comboMult(fruits.length);
    let gained = 0, penalty = 0;
    for (const o of hits) {
      sliced.add(o.id);
      if (o.type === T_FRUIT) {
        gained += Math.round(o.points * mult);
        res.fruits++;
      } else if (o.type === T_ICE) {
        gained += ICE_POINTS;
        res.ices++;
        res.freezes.push({ s: s.frame, e: s.frame + FREEZE_FRAMES, factor: FREEZE_FACTOR });
      } else if (o.type === T_MAGNET) {
        gained += MAGNET_POINTS;
        res.magnets++;
        res.magnetWins.push({ s: s.frame, e: s.frame + MAGNET_FRAMES, x: o.x });
      } else if (o.type === T_BOMB) {
        penalty += BOMB_PENALTY;
        res.bombs++;
      }
    }
    res.score += gained - penalty;
    if (fruits.length > res.bestCombo) res.bestCombo = fruits.length;
    res.events.push({
      id: s.id, frame: s.frame, seat: s.seat,
      hitIds: hits.map((o) => o.id),
      fruitCount: fruits.length, mult: mult, gained: gained, penalty: penalty,
    });
    if (s.frame > res.lastFrame) res.lastFrame = s.frame;
  }

  res.sliced = Array.from(sliced);
  res.over = res.bombs >= MAX_BOMBS;
  res.grade = gradeOf(res.score);
  return res;
}

/* ---------------------------------------------------------------------------
 * 规则引擎对外接口（规范要求的六个）
 * ------------------------------------------------------------------------- */

/** 开局局面。 */
export function initState(seed) {
  const s = seed >>> 0;
  const summary = evaluate(s, []);
  return {
    seed: s,
    strokes: [],
    summary: summary,
    over: false,
    rngCount: scheduleOf(s).length,   /* 随机数序号：调度表下标（公开） */
  };
}

/**
 * 应用一条动作（这里只有一种动作：一条轨迹）。
 * 非法动作 / 重复 id → **整手丢弃**，原状态原样返回。
 */
export function applyAction(state, act) {
  if (!state || !act || act.act !== 'stroke') return state;
  const s = normalizeStroke(act);
  if (!s) return state;
  if (state.over) return state;
  for (const x of state.strokes) if (x.id === s.id) return state;

  const strokes = canonicalStrokes(state.strokes.concat([s]));
  const summary = evaluate(state.seed, strokes);
  return {
    seed: state.seed,
    strokes: strokes,
    summary: summary,
    over: summary.over,
    rngCount: state.rngCount,
  };
}

/** 把动作序列折叠成局面。 */
export function fold(base, actions) {
  let st = initState((base && base.seed) || 0);
  for (const a of (actions || [])) st = applyAction(st, a);
  return st;
}

/** 从种子重放（房主权威模型用）。 */
export function replay(seed, actions) {
  return fold({ seed: seed >>> 0 }, actions);
}

/**
 * 局面摘要 —— 双方比对用。
 *
 * 必须包含：
 *   · seed —— 房主换种子会被发现；
 *   · 全部轨迹（含 id / 帧 / 座位 / 坐标摘要）—— 房主删改轨迹会被发现；
 *   · rngCount —— 随机数序号（调度表长度），房主改不了随机序列；
 *   · 结算结果 —— 分数、连击、炸弹数、是否结束。
 */
export function hashState(state) {
  if (!state) return '';
  const sum = state.summary || {};
  const digests = (state.strokes || []).map((s) => {
    const body = s.pts.map((p) => p[0].toFixed(2) + ',' + p[1].toFixed(2)).join(';');
    return s.id + '@' + s.frame + '#' + s.seat + ':' + fnv1a(body);
  }).join('|');
  return [
    state.seed,
    state.rngCount,
    state.strokes.length,
    digests,
    sum.score, sum.bestCombo, sum.bombs, sum.fruits,
    sum.over ? 1 : 0, sum.grade,
  ].join('#');
}

/**
 * 广播前的视图裁剪。
 * 这个游戏**没有私密信息** —— 种子、轨迹、结算全是公开的
 * （轨迹走独立通道，这里给的是摘要用的部分）。
 */
export function publicView(state) {
  if (!state) return state;
  return {
    seed: state.seed,
    rngCount: state.rngCount,
    strokes: (state.strokes || []).map((s) => ({
      id: s.id, frame: s.frame, seat: s.seat,
      pts: s.pts.map((p) => [p[0], p[1]]),
    })),
    summary: Object.assign({}, state.summary, {
      sliced: (state.summary.sliced || []).slice(),
      freezes: (state.summary.freezes || []).map((w) => Object.assign({}, w)),
      magnetWins: (state.summary.magnetWins || []).map((w) => Object.assign({}, w)),
      events: (state.summary.events || []).map((e) => Object.assign({}, e)),
    }),
    over: !!state.over,
  };
}

/**
 * 轨迹摘要（不进权威状态广播用，只给房主广播「我记了哪些刀」）。
 */
export function strokeDigest(s) {
  const body = s.pts.map((p) => p[0].toFixed(2) + ',' + p[1].toFixed(2)).join(';');
  return { id: s.id, frame: s.frame, seat: s.seat, h: fnv1a(body) };
}
