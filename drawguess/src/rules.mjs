/* =============================================================================
 * drawguess/src/rules.mjs —— 你画我猜规则引擎（零依赖、纯逻辑、可单测）
 * -----------------------------------------------------------------------------
 * 规矩：一名玩家作画，其余人打字猜词。
 *
 * 「你画我猜」跟棋类不一样的地方，也是这个引擎最要紧的一条：
 *
 *   · 回合、比分、已猜中的词 —— 这些是**离散状态**，进权威动作序列，
 *     两端用同一份代码折叠，保证状态一致。
 *   · 画布上的每一笔 —— 这是**连续的像素数据**，体积大、变化快，
 *     塞进动作序列会让重放慢到卡死。
 *
 * 所以笔迹走**另一条通道**：房间权威（HostAuthority）之外单独发
 * {t:'dg-stroke', ...} 增量消息。笔迹不需要两端逐字节一致 ——
 * 只要「最后一笔大致对上」就行，猜词判定又不看笔迹。
 *
 * 私密信息隔离（同 undercover）：
 *   画师手上的词**只在画师本机**，绝不进动作序列、绝不进广播状态。
 *   猜词的人如果提前知道词，游戏就没得玩了。
 *
 * 纪律（对齐仓库既有口径）：
 *   · 顶层不碰 DOM、不碰 localStorage。
 *   · 所有纯函数，方便单测与「房主权威重放」。
 * ========================================================================== */

/* ---------------------------------------------------------------------------
 * 词库
 * ---------------------------------------------------------------------------
 * 分三类难度：简单（一眼能画）、中等、需要一点抽象能力。
 * 每组带一个「提示语」——猜的人看不到，只有画师在同屏模式下能看到。
 * ------------------------------------------------------------------------- */
export const WORDS = [
  /* 简单 */
  { w: '苹果', lv: 'easy' }, { w: '太阳', lv: 'easy' }, { w: '雨伞', lv: 'easy' },
  { w: '房子', lv: 'easy' }, { w: '汽车', lv: 'easy' }, { w: '大树', lv: 'easy' },
  { w: '月亮', lv: 'easy' }, { w: '小猫', lv: 'easy' }, { w: '皮球', lv: 'easy' },
  { w: '书本', lv: 'easy' }, { w: '蜡烛', lv: 'easy' }, { w: '鱼', lv: 'easy' },
  { w: '杯子', lv: 'easy' }, { w: '钥匙', lv: 'easy' }, { w: '帽子', lv: 'easy' },
  { w: '鞋子', lv: 'easy' }, { w: '西瓜', lv: 'easy' }, { w: '礼物', lv: 'easy' },
  { w: '飞机', lv: 'easy' }, { w: '铅笔', lv: 'easy' },
  /* 中等 */
  { w: '雨伞的使用者', lv: 'mid' }, { w: '自行车', lv: 'mid' },
  { w: '冰淇淋', lv: 'mid' }, { w: '圣诞老人', lv: 'mid' },
  { w: '医生', lv: 'mid' }, { w: '足球运动员', lv: 'mid' },
  { w: '火警', lv: 'mid' }, { w: '辣椒', lv: 'mid' },
  { w: '电脑', lv: 'mid' }, { w: '长颈鹿', lv: 'mid' },
  { w: '钓鱼的人', lv: 'mid' }, { w: '生日蛋糕', lv: 'mid' },
  { w: '雪人', lv: 'mid' }, { w: '热气球', lv: 'mid' },
  { w: '洗衣机', lv: 'mid' }, { w: '路灯', lv: 'mid' },
  { w: '章鱼', lv: 'mid' }, { w: '钢琴', lv: 'mid' },
  { w: '火箭', lv: 'mid' }, { w: '西瓜刀', lv: 'mid' },
  /* 难 */
  { w: '.action', lv: 'hard' }, { w: '蝴蝶效应', lv: 'hard' },
  { w: '守株待兔', lv: 'hard' }, { w: '掩耳盗铃', lv: 'hard' },
  { w: '画蛇添足', lv: 'hard' }, { w: '井底之蛙', lv: 'hard' },
  { w: '对牛弹琴', lv: 'hard' }, { w: '刻舟求剑', lv: 'hard' },
  { w: '亡羊补牢', lv: 'hard' }, { w: '狐假虎威', lv: 'hard' },
  { w: '空中楼阁', lv: 'hard' }, { w: '水滴石穿', lv: 'hard' },
];

export const PHASE = {
  IDLE: 'idle',        /* 没开局 */
  DRAW: 'draw',        /* 画师作画中，猜的人可以打字 */
  REVEAL: 'reveal',    /* 本回合结束，公布答案 */
  OVER: 'over',        /* 整局结束 */
};

/** 猜词命中判定：去掉空白与常见标点后，包含关系即算中。 */
export function normalizeGuess(s) {
  return String(s == null ? '' : s)
    .replace(/\s+/g, '')
    .replace(/[，。！？、；：""''（）【】《》,.!?;:"'()\[\]<>~`·\-_]/g, '')
    .toLowerCase();
}

/**
 * 判断一个猜测是否命中目标词。
 * 规则：归一化后 guess 包含 target，或 target 包含 guess（防止只写一个字）。
 */
export function isHit(guess, target) {
  const g = normalizeGuess(guess);
  const t = normalizeGuess(target);
  if (!g || !t) return false;
  return g.indexOf(t) >= 0 || t.indexOf(g) >= 0;
}

/* ---------------------------------------------------------------------------
 * 公开局面
 * ---------------------------------------------------------------------------
 * pub 里**不能有任何私密信息**（词、身份、提示语）。
 * 画师手上的词是私密信息，压根不进这个结构。
 * ------------------------------------------------------------------------- */

/** 新一局的公开局面。 */
export function initPub(n) {
  const count = Math.max(1, n | 0 || 1);
  return {
    n: count,
    round: 0,            /* 第几回合，从 1 开始 */
    totalRounds: 0,      /* 一共几个回合 */
    drawer: -1,          /* 当前画师座位 */
    phase: PHASE.IDLE,
    word: '',            /* 本回合的目标词 —— 只在 REVEAL 之后才填 */
    scores: new Array(count).fill(0),   /* 每个座位的猜中次数 */
    hits: [],            /* 本回合已猜中的人的座位 */
    best: [],            /* 本回合第一个猜中的人（并列取最先） */
    guessCount: 0,       /* 本回合累计猜测次数（用于提示「太接近了」） */
    lastGuess: '',       /* 最近一次（未命中）的猜测，展示用 */
    nearMiss: false,     /* 最近一次猜得很接近（只差一个字） */
  };
}

/** 空动作序列对应的空局面。 */
export function emptyActions() { return []; }

/* ---------------------------------------------------------------------------
 * 动作
 * ---------------------------------------------------------------------------
 * 所有会改变公开局面的动作都列在这里。**必须**跟 rules.mjs 的语义完全一致。
 *
 *   { act:'round', drawer, total }          开一回合（换画师）
 *   { act:'guess', p, text, hit }            有人猜了一次（hit 由房主判定）
 *   { act:'reveal' }                        公布本回合答案
 *   { act:'over' }                          整局结束
 * ------------------------------------------------------------------------- */

/**
 * 把一个动作作用到公开局面上，返回**新的**局面（不改传入对象）。
 * @param {object} pub
 * @param {object} act
 */
export function applyAction(pub, act) {
  if (!pub || !act) return pub;
  const next = Object.assign({}, pub);
  next.scores = (pub.scores || []).slice();
  next.hits = (pub.hits || []).slice();
  next.best = (pub.best || []).slice();

  switch (act.act) {
    case 'round': {
      next.round = pub.round + 1;
      next.totalRounds = act.total != null ? act.total : pub.totalRounds;
      next.drawer = act.drawer;
      next.phase = PHASE.DRAW;
      next.word = '';
      next.hits = [];
      next.best = [];
      next.guessCount = 0;
      next.lastGuess = '';
      next.nearMiss = false;
      break;
    }
    case 'guess': {
      next.guessCount = (pub.guessCount || 0) + 1;
      if (act.hit) {
        if (next.hits.indexOf(act.p) < 0) next.hits.push(act.p);
        if (!next.best.length) next.best.push(act.p);
        next.scores[act.p] = (next.scores[act.p] || 0) + 1;
        next.lastGuess = act.text || '';
        next.nearMiss = false;
      } else {
        next.lastGuess = act.text || '';
        next.nearMiss = !!act.near;
        /* keep —— 「这次没被猜中」也算画师守住一分。
           人机模式里画师是本机玩家，AI 猜错一次他就得一分。 */
        if (act.keep && pub.drawer >= 0) {
          next.scores[pub.drawer] = (next.scores[pub.drawer] || 0) + 1;
        }
      }
      break;
    }
    case 'reveal': {
      next.phase = PHASE.REVEAL;
      next.word = act.word || '';
      break;
    }
    case 'over': {
      next.phase = PHASE.OVER;
      break;
    }
    default:
      break;
  }
  return next;
}

/**
 * 动作序列 → 公开局面。
 * 非法动作直接跳过（不能因为一手脏数据把整局卡死）。
 */
export function fold(base, actions) {
  /* base 可能只带 { n }（联机时 seed 里的公开部分）——
     缺的字段用 initPub 的默认值补齐，否则局面里会没有 phase/scores。 */
  const b = base || {};
  let pub = Object.assign(initPub(b.n || 2), b);
  pub.scores = (b.scores || pub.scores || []).slice();
  pub.hits = (b.hits || []).slice();
  pub.best = (b.best || []).slice();
  const list = actions || [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a || typeof a !== 'object') continue;
    const r = applyAction(pub, a);
    if (r) pub = r;
  }
  return pub;
}

/**
 * 双方统一的重放入口。
 * @param {object} seed  只含公开信息
 * @param {Array} actions
 */
export function replay(seed, actions) {
  const base = (seed && seed.pub) || initPub((seed && seed.n) || 3);
  return { base: base, pub: fold(base, actions || []), moves: (actions || []).slice() };
}

/** 公开局面摘要 —— 两端算出来必须一样，否则触发快照纠偏。 */
export function hashPub(pub) {
  if (!pub) return '';
  const parts = [
    pub.n, pub.round, pub.totalRounds, pub.drawer, pub.phase,
    (pub.scores || []).join(','),
    (pub.hits || []).join(','),
    (pub.best || []).join(','),
    pub.guessCount, pub.word || '',
  ];
  return parts.join('|');
}

/**
 * 广播前的视图裁剪。
 * DRAW 阶段不能把 word 露出去（还没公布）。
 */
export function publicView(pub) {
  if (!pub) return pub;
  const v = Object.assign({}, pub);
  v.scores = (pub.scores || []).slice();
  v.hits = (pub.hits || []).slice();
  v.best = (pub.best || []).slice();
  if (pub.phase !== PHASE.REVEAL && pub.phase !== PHASE.OVER) v.word = '';
  return v;
}

/* ---------------------------------------------------------------------------
 * 回合调度
 * ------------------------------------------------------------------------- */

/** 座位总数 → 一共几个回合（每人画 2 回，合起来 * 2 圈）。 */
export function totalRoundsFor(n) { return n * 2; }

/**
 * 第 round 个回合（从 1 开始）该谁画。
 * 顺序固定：0,1,2,...,n-1,0,1,2,...,n-1
 */
export function drawerForRound(round, n) {
  if (!n || n < 1) return 0;
  return (round - 1) % n;
}

/** 本回合是否已经有人猜中（猜中后本回合就结束了）。 */
export function roundFinished(pub) { return !!(pub && pub.hits && pub.hits.length); }

/* ---------------------------------------------------------------------------
 * 判定辅助（房主专用）
 * ------------------------------------------------------------------------- */

/**
 * 判定一次猜测。
 * @returns {{hit:boolean, near:boolean}}
 *   hit —— 命中目标词
 *   near —— 差一点（长度相近且有共同字），用来提示「接近了」
 *
 * 注意 near 的判定不能写死「前缀相同」：一旦前缀相同，
 * isHit 里的「目标词包含猜测」就已经算命中了，near 永远走不到。
 * 所以这里按**共同字数**来算。
 */
export function judgeGuess(text, target) {
  const hit = isHit(text, target);
  if (hit) return { hit: true, near: false };
  const g = normalizeGuess(text);
  const t = normalizeGuess(target);
  if (!g || !t) return { hit: false, near: false };
  if (Math.abs(g.length - t.length) > 1) return { hit: false, near: false };
  let shared = 0;
  const pool = t.split('');
  for (const ch of g.split('')) {
    const i = pool.indexOf(ch);
    if (i >= 0) { shared += 1; pool.splice(i, 1); }
  }
  const need = Math.max(1, Math.ceil(Math.min(g.length, t.length) / 2));
  return { hit: false, near: shared >= need };
}

/** 该不该公布答案（本回合结束了？）。 */
export function shouldReveal(pub) {
  return !!(pub && pub.phase === PHASE.DRAW && roundFinished(pub));
}

/** 结算：谁赢了（并列都算赢）。 */
export function winnersOf(pub) {
  if (!pub || !pub.scores || !pub.scores.length) return [];
  let max = -1;
  pub.scores.forEach((s) => { if (s > max) max = s; });
  if (max <= 0) return [];
  const out = [];
  pub.scores.forEach((s, i) => { if (s === max) out.push(i); });
  return out;
}
