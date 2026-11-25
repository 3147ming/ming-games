/* =============================================================================
 * ludo/src/rules.mjs —— 飞行棋规则引擎（零依赖、纯逻辑、可单测）
 * -----------------------------------------------------------------------------
 * 规矩（经典中式飞行棋）：
 *   · 4 个颜色（红黄蓝绿），每色 4 颗棋子，共 16 颗。
 *   · 棋盘外圈 52 格（4 条边拼成的闭环），每人从自己的起点出发，
 *     绕外圈走一整圈（51 步）后从自己的「入口」拐进终点通道。
 *   · 终点通道每人 6 格，第 6 格是终点 —— 必须**刚好**点数到达，
 *     点数不够就走不动（这跟「掷骰子」的飞棋不一样，是经典规则）。
 *   · 棋子停在待飞区（起点外）时，要掷到 **6** 才能起飞。
 *   · 掷出 6 可以**再掷一次**。
 *   · 棋盘上有 4 个**跳跃点**，经过或停在跳跃点可以再掷一次。
 *   · 落到对方棋子所在的格子 → 对方被撞回待飞区（撞机）。
 *     自己的棋子可以叠在同一格。
 *   · 4 颗棋子全部到达终点 → 获胜。
 *
 * ---------------------------------------------------------------------------
 * 为什么要把「掷骰子」也做成可推导的
 * -----------------------------------------------------------------------------
 * 这个游戏接纯 P2P 有个绕不开的问题：**骰子点数是随机数**。
 *
 * 纯 P2P 没有服务器，房主就是权威。如果骰子由房主掷、由房主报，
 * 房主完全可以每次都掷 6 —— 他能算出所有人的点数，稳赢。
 *
 * 解法：**骰子不掷，改成算出来的**。
 *   点数 = H(seed | 掷骰序号) % 6 + 1
 *   seed 是公开的（写在开局状态里），掷骰序号是公开的（写在动作序列里）。
 *   所以双方各自算，得到的点数**必然一致** ——
 *   房主想改也改不了：他改了就跟加入方算出来的不一样，立刻被发现。
 *
 * 这跟 commit-reveal 是同一个思路的两种形态：
 *   吹牛骰子那边是「点数保密、事后揭示」；
 *   飞行棋这边点数本来就是公开的，那就干脆让它**一开始就可推导**。
 *
 * 代价：点数序列在开局就全部确定了（理论上可以推算后面的点数）。
 * 这在单机/局域网没问题；真要防「算未来点数」，得换成承诺-揭示，
 * 代价是每一步都要多一轮网络往返。这里选了前者 ——
 * 毕竟**房主作弊**才是更大的威胁，而对手预知点数最多算「心里有数」。
 *
 * 纪律：
 *   · 顶层不碰 DOM、不碰 localStorage。
 *   · 所有纯函数，方便单测与「房主权威重放」。
 * ========================================================================== */

/* ---------------------------------------------------------------------------
 * 棋盘几何
 * ------------------------------------------------------------------------- */

/**
 * 外圈 52 格（顺时针一圈）。
 * 坐标用 [x, y]，x 是列、y 是行，棋盘是 15×15（0..14）。
 *   底边 y=14 从左到右 14 格
 *   右边 x=14 从下到上 13 格
 *   顶边 y=1  从右到左 13 格
 *   左边 x=1  从上到下 12 格
 * 合计 52 格，首尾相接成一个闭环。
 */
export const RING = (() => {
  const a = [];
  for (let x = 1; x <= 14; x++) a.push([x, 14]);
  for (let y = 13; y >= 1; y--) a.push([14, y]);
  for (let x = 13; x >= 1; x--) a.push([x, 1]);
  for (let y = 2; y <= 13; y++) a.push([1, y]);
  return a;
})();

export const RING_LEN = RING.length;   /* 52 */

/**
 * 终点通道：每人 6 格，从自己的入口往中心延伸。
 *   红（0）：从底边入口往上一路
 *   黄（1）：从右边入口往左一路
 *   蓝（2）：从顶边入口往下一路
 *   绿（3）：从左边入口往右一路
 * 每条通道的第 6 格是终点（4 个终点格子在中心 3×3 里围成一圈）。
 */
export const LANES = [
  [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9], [7, 8]],
  [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7], [8, 7]],
  [[7, 2], [7, 3], [7, 4], [7, 5], [7, 6], [7, 7]],
  [[2, 8], [3, 8], [4, 8], [5, 8], [6, 8], [6, 7]],
];

export const LANE_LEN = 6;              /* 通道格数（含终点） */

/**
 * 每人「入口」在外圈上的下标 —— 走完 51 步正好到这里，再走就拐进通道。
 *   红 idx 6 = [7,14]（底边入口）
 *   黄 idx 20 = [14,7]（右边入口）
 *   蓝 idx 33 = [7,1]（顶边入口）
 *   绿 idx 46 = [1,8]（左边入口）
 */
export const MOUTH_IDX = [6, 20, 33, 46];

/** 起点 = 入口 + 1（顺时针方向的下一步）。 */
export const START_IDX = MOUTH_IDX.map((i) => (i + 1) % RING_LEN);

/**
 * 飞跃点的外圈下标（4 个，每边一个，13 格等距）。
 *   idx 3  = [4,14]（下边）  idx 16 = [14,11]（右边）
 *   idx 29 = [11,1]（上边）  idx 42 = [1,5]（左边）
 *
 * 规则：**正好落在**飞跃点上 → 棋子再往前飞 7 格（跳过中间一片）。
 * 注意是「落在」不是「经过」—— 经典飞行棋只有停到那个格子才飞。
 *
 * 为什么是 7：
 *   飞跃点之间相隔 13 格，飞 7 格正好落在两个飞跃点中间，
 *   不会「刚飞完又站在飞跃点上」而连锁触发。
 */
export const JUMP_IDX = [3, 16, 29, 42];
export const JUMP_STEPS = 7;

/* ---------------------------------------------------------------------------
 * 颜色
 * ------------------------------------------------------------------------- */

export const COLORS = ['red', 'yellow', 'blue', 'green'];
export const COLOR_LABEL = { red: '红', yellow: '黄', blue: '蓝', green: '绿' };
export const COLOR_HEX = { red: '#e0483c', yellow: '#f5c542', blue: '#3d8bd8', green: '#3fb96b' };

export const COLOR_COUNT = 4;
export const PLANES_PER_COLOR = 4;

/* 棋子位置的三种形态（统一成一个整数 pos，好处是重放/哈希都简单）：
 *   -1        在待飞区（起点外），要掷 6 才能起飞
 *   0 .. 51   在外圈上，pos 是「离自己起点走了几步」
 *   52 .. 57  在终点通道里，laneIdx = pos - 52
 * 57 是终点。
 */
export const HOLD = -1;
export const LANE_START = RING_LEN;              /* 52 */
export const FINISH_POS = LANE_START + LANE_LEN - 1;  /* 57 */

/* ---------------------------------------------------------------------------
 * 随机与派生点数
 * ------------------------------------------------------------------------- */

/** FNV-1a 32 位哈希。 */
export function fnv1a(str) {
  const s = String(str);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * 第 r 次掷骰的点数（1..6）。
 *
 * 这是整个 P2P 公平性的核心：
 *   点数只由 (seed, r) 决定，两者都是公开的，
 *   所以双方各自算出来的点数必然一致，房主改不了。
 */
export function dieFor(seed, r) {
  return (fnv1a(seed + '|' + r) % 6) + 1;
}

/** 开局用的随机种子（单机/AI 局用）。 */
export function randomSeed() {
  return (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0;
}

/**
 * 从房间号派生种子 —— 联机局用这个，双方算出同一个值。
 * 房间号在交换连接码的时候双方都拿到了，所以 seed 天然一致。
 */
export function seedFromRoom(roomId, gameId) {
  return fnv1a('ludo|' + (gameId || 'ludo') + '|' + (roomId || '0'));
}

/* ---------------------------------------------------------------------------
 * 局面
 * ------------------------------------------------------------------------- */

/**
 * 开局局面。
 * @param {number} seed  公开种子
 * @param {number} colors 参与的色数（2 或 4）
 */
export function initState(seed, colors) {
  const n = Math.max(2, Math.min(COLOR_COUNT, colors || COLOR_COUNT));
  const planes = [];
  for (let c = 0; c < n; c++) {
    const row = [];
    for (let i = 0; i < PLANES_PER_COLOR; i++) row.push(HOLD);
    planes.push(row);
  }
  return {
    seed: seed >>> 0,
    n: n,
    turn: 0,          /* 现在轮到哪个颜色行动 */
    roll: 0,          /* 即将进行的是第几次掷骰（从 0 开始） */
    planes,
    lastDie: 0,       /* 上一次掷出的点数 */
    lastMoved: -1,    /* 上一次移动的棋子（color*4 + index） */
    winner: -1,
    over: false,
    moves: 0,         /* 行动了多少轮（用于统计） */
  };
}

/* ---------------------------------------------------------------------------
 * 位置换算
 * ------------------------------------------------------------------------- */

/** 棋子在外圈上的绝对下标（通道里的棋子返回 -1）。 */
export function ringIndexOf(color, pos) {
  if (pos < 0 || pos >= LANE_START) return -1;
  return (START_IDX[color] + pos) % RING_LEN;
}

/** 棋子的棋盘坐标。 */
export function cellOf(color, pos) {
  if (pos === HOLD) return null;
  if (pos < LANE_START) return RING[ringIndexOf(color, pos)];
  const lane = LANES[color];
  const idx = pos - LANE_START;
  return lane[idx] || null;
}

/** 棋子是否已到终点。 */
export function isFinished(pos) {
  return pos === FINISH_POS;
}

/* ---------------------------------------------------------------------------
 * 走子规则
 * ------------------------------------------------------------------------- */

/**
 * 掷出 die 点后，棋子从 from 走到 to 的结果。
 * @returns {{ok:boolean, to?:number, reason?:string}}
 */
export function stepOf(color, from, die) {
  if (from === HOLD) {
    /* 待飞区：必须掷到 6 才能起飞 */
    if (die !== 6) return { ok: false, reason: '要掷到 6 才能起飞' };
    return { ok: true, to: 0 };
  }
  if (from === FINISH_POS) return { ok: false, reason: '这颗已经到终点了' };
  const to = from + die;
  /* 终点通道必须刚好点数到达 —— 超出就走不动（经典规则） */
  if (to > FINISH_POS) return { ok: false, reason: '点数不够到终点' };
  return { ok: true, to };
}

/**
 * 从 from 走到 to 的路上，经过了哪些外圈格（含起点格与落点格）。
 * 通道里的格子不参与（飞跃点只在外圈上）。
 */
export function pathCells(color, from, to) {
  const out = [];
  if (from === HOLD) return out;
  const end = Math.min(to, LANE_START - 1);
  for (let p = from; p <= end; p++) {
    out.push(ringIndexOf(color, p));
  }
  return out;
}

/**
 * 这一步是不是正好**落在**飞跃点上。
 *
 * 注意是「落在」不是「经过」——
 * 经典飞行棋只有停到那个格子才飞，走过去不算。
 */
export function hitsJump(color, from, to) {
  if (from === HOLD) return false;
  if (to >= LANE_START) return false;          /* 通道里没有飞跃点 */
  const idx = ringIndexOf(color, to);
  return JUMP_IDX.indexOf(idx) >= 0;
}

/**
 * 当前局面下，color 可以走哪几颗棋子。
 * @returns {number[]} 棋子下标（0..3）
 */
export function legalPlanes(state, color) {
  const die = dieFor(state.seed, state.roll);
  const row = state.planes[color] || [];
  const out = [];
  for (let i = 0; i < row.length; i++) {
    if (stepOf(color, row[i], die).ok) out.push(i);
  }
  return out;
}

/**
 * 某颗棋子走完后，有多少颗已经到家（用于判胜）。
 */
export function finishedCount(state, color) {
  const row = state.planes[color] || [];
  let n = 0;
  for (const p of row) if (p === FINISH_POS) n++;
  return n;
}

/**
 * 落点是否有对方棋子 → 撞机。
 *
 * @param {number} to  落点（用 color 的坐标系，即 pos）
 * @returns {number[]} 被撞回待飞区的棋子（用 color*4+i 编号）
 */
export function victimsOf(state, color, to) {
  const hit = [];
  for (let c = 0; c < state.n; c++) {
    if (c === color) continue;
    const row = state.planes[c] || [];
    for (let i = 0; i < row.length; i++) {
      const p = row[i];
      if (p === HOLD || p >= LANE_START) continue;   /* 通道内不撞机 */
      if (ringIndexOf(c, p) === ringIndexOf(color, to)) hit.push(c * PLANES_PER_COLOR + i);
    }
  }
  return hit;
}

/* ---------------------------------------------------------------------------
 * 动作
 * ------------------------------------------------------------------------- */

/**
 * 走一步（掷骰 + 移动一颗棋子）。
 *
 * 动作格式：{ act:'move', c: 颜色, plane: 棋子下标, r: 掷骰序号 }
 *   r 冗余写一遍是为了防重放 —— 服务端/房主校验它必须等于当前的 roll。
 *   plane = -1 表示「这一手没有能走的棋子，只能过」。
 *
 * @returns {object} 新的局面（不改原对象）
 */
export function applyAction(state, act) {
  if (!state || !act || act.act !== 'move') return state;
  if (state.over) return state;
  const c = act.c;
  if (c !== state.turn) return state;
  if (act.r != null && act.r !== state.roll) return state;

  const die = dieFor(state.seed, state.roll);
  const row = state.planes[c];
  if (!row) return state;

  const next = {
    seed: state.seed,
    n: state.n,
    turn: state.turn,
    roll: state.roll,
    planes: state.planes.map((r) => r.slice()),
    lastDie: state.lastDie,
    lastMoved: state.lastMoved,
    winner: state.winner,
    over: state.over,
    moves: state.moves,
    /* 这些是「过程信息」，重放时会被覆盖 */
    jumped: false,
    flew: false,
    victims: [],
    extra: false,
    passed: true,
  };

  const plane = act.plane;
  if (plane === -1) {
    /* 过 —— 但**只有在真的没棋可走时**才允许。
       否则乱报一个下标就能白嫖一回合。 */
    if (legalPlanes(state, c).length > 0) return state;
    next.passed = true;
  } else if (!Number.isInteger(plane) || plane < 0 || plane >= row.length) {
    return state;                              /* 非法下标：整手丢弃 */
  } else {
    const from = row[plane];
    const s = stepOf(c, from, die);
    if (!s.ok) return state;              /* 非法动作：整手丢弃 */
    next.passed = false;
    let landTo = s.to;
    next.jumped = hitsJump(c, from, landTo);
    if (next.jumped) {
      /* 正好落在飞跃点 → 再往前飞 7 格。
         目标不会越过外圈终点（入口），所以最远停在环上。 */
      const limit = LANE_START - 1;
      landTo = Math.min(landTo + JUMP_STEPS, limit);
      next.flew = true;
    }
    next.planes[c][plane] = landTo;
    next.lastMoved = c * PLANES_PER_COLOR + plane;
    /* 撞机判定用**落点**（飞完之后的最终位置） */
    next.victims = victimsOf(state, c, landTo);
    for (const v of next.victims) {
      const vc = Math.floor(v / PLANES_PER_COLOR);
      const vi = v % PLANES_PER_COLOR;
      next.planes[vc][vi] = HOLD;         /* 撞机 → 退回待飞区 */
    }
  }

  next.lastDie = die;
  next.roll = state.roll + 1;
  next.moves = state.moves + 1;

  /* 判胜：刚走的这一方 4 颗全到家 */
  if (finishedCount(next, c) >= PLANES_PER_COLOR) {
    next.over = true;
    next.winner = c;
    return next;
  }

  /* 掷 6 → 同一色再掷一次（经典规则） */
  next.extra = (die === 6);
  next.turn = next.extra ? c : (c + 1) % state.n;

  return next;
}

/**
 * 把动作序列折叠成局面。
 * @param {object} base  {seed, n}
 * @param {object[]} actions
 */
export function fold(base, actions) {
  let st = initState((base && base.seed) || 0, (base && base.n) || COLOR_COUNT);
  const list = actions || [];
  for (const a of list) st = applyAction(st, a);
  return st;
}

/**
 * 从种子重放（房主权威模型用）。
 */
export function replay(seed, actions, n) {
  return fold({ seed, n: n || COLOR_COUNT }, actions);
}

/**
 * 局面摘要 —— 双方比对用。
 * 种子和掷骰序号必须进摘要，否则房主能改点数。
 */
export function hashState(state) {
  if (!state) return '';
  const planes = (state.planes || []).map((row) => row.join(',')).join('|');
  return [
    state.seed, state.n, state.turn, state.roll,
    state.lastDie, state.lastMoved,
    state.winner, state.over ? 1 : 0, state.moves,
    planes,
  ].join('|');
}

/**
 * 广播前的视图裁剪。
 * 这个游戏**没有私密信息** —— 点数本来就是公开的（可推导），
 * 所以视图就是原样。
 */
export function publicView(state) {
  if (!state) return state;
  return Object.assign({}, state, {
    planes: (state.planes || []).map((r) => r.slice()),
  });
}

/* ---------------------------------------------------------------------------
 * AI
 * ------------------------------------------------------------------------- */

/**
 * AI 选棋：返回一个棋子下标（-1 表示只能过）。
 *
 * 优先级：
 *   1. 能直接到终点的 —— 走它
 *   2. 待飞区里有棋子且掷到 6 —— 起飞（但如果别的棋子能走得更远就让别的走）
 *   3. 走离终点最近的那颗
 *   4. 都不行就过
 */
export function aiChoose(state, color) {
  const die = dieFor(state.seed, state.roll);
  const row = state.planes[color] || [];
  const legal = legalPlanes(state, color);
  if (!legal.length) return -1;

  let best = -1, bestScore = -Infinity;
  for (const i of legal) {
    const from = row[i];
    const to = stepOf(color, from, die).to;
    let score;
    if (to === FINISH_POS) {
      score = 1000;                                  /* 能到终点，最优先 */
    } else if (from === HOLD) {
      score = 100;                                   /* 起飞：让棋子先上路 */
    } else {
      score = to;                                    /* 走得越远越好 */
      /* 能撞机就加分 */
      if (victimsOf(state, color, to).length) score += 200;
      /* 留一颗在待飞区（防止全被撞光） */
      const holdLeft = row.filter((p) => p === HOLD).length;
      if (holdLeft === 1 && from !== HOLD) score -= 50;
    }
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}
