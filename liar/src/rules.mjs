/* =============================================================================
 * liar/src/rules.mjs —— 吹牛骰子规则引擎（零依赖、纯逻辑、可单测）
 * -----------------------------------------------------------------------------
 * 规矩：每人 3 颗骰子，点数只有自己看得见。轮流叫牌，声称「全场至少有
 * N 颗 V 点」。叫牌必须比上一手大。不信就质疑：实际不足则上家掉骰，
 * 实际够数则质疑者掉骰。1 点是万能，可充当任意点数。掉光者出局。
 *
 * ---------------------------------------------------------------------------
 * 这个游戏接纯 P2P 的核心难点：**骰子点数是私密信息，但叫牌要基于全场。**
 *
 * 房主如果掌握双方骰子，他就能算出「实际有几颗 V 点」，质疑必赢 —— 作弊。
 * 所以骰子必须**各自本地摇**，房主和加入方都不能提前看到对方的点数。
 *
 * 解法是 commit-reveal（先承诺、后揭示）：
 *   1. 每人本地摇骰子，选一个随机 salt，算出承诺值
 *        commit = H(salt || dice)
 *      把 commit 公开（进权威动作序列），但 salt 和 dice 都不公开。
 *   2. 叫牌、质疑都是公开动作。
 *   3. 有人质疑 → 进入「揭示」阶段。双方各自把 salt + dice 发给对方。
 *   4. 收到对方的 reveal 后先验 hash 对不对得上 commit：
 *        对不上 = 对方作弊（他中途换了骰子）
 *        对得上 = 骰子是真的，可以放心统计
 *   5. 房主算出 actual 并广播 resolve 动作。加入方**自己也重算一遍**，
 *      跟房主广播的数字对不上 —— 那就是房主在乱报，直接提示。
 *
 * 为什么用简单哈希而不是 SHA-256：
 *   承诺的目的不是防篡改，是**防中途换骰**。攻击者要作弊就得在收到
 *   对方 reveal 之前改自己的骰子，但那时他的 commit 已经发出去了，
 *   改了就对不上。所以哈希只要「碰撞概率低」就够，不需要密码学强度。
 *   另外一个现实原因：crypto.subtle 在 file:// 下不可用（非安全上下文），
 *   而本仓库要支持 file:// 双击打开。
 *
 * 纪律：顶层不碰 DOM、不碰 localStorage。
 * ========================================================================== */

/* ---------------------------------------------------------------------------
 * 承诺哈希
 * ------------------------------------------------------------------------- */

/**
 * FNV-1a 32 位哈希（够用：承诺的目的只是防中途换骰）。
 * @param {string} salt
 * @param {number[]} dice
 */
export function commitHash(salt, dice) {
  const s = String(salt) + '|' + (dice || []).join(',');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  /* 再混一轮长度，避免「不同长度同前缀」碰撞 */
  let g = 0x9e3779b9 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    g = (g * 33 + s.charCodeAt(i)) >>> 0;
  }
  return (h.toString(16).padStart(8, '0') + g.toString(16).padStart(8, '0'));
}

/** 生成一枚随机 salt（不依赖 crypto，file:// 下也能用）。 */
export function makeSalt() {
  let s = '';
  for (let i = 0; i < 8; i++) s += Math.floor(Math.random() * 36).toString(36);
  return s;
}

/** 本地摇骰子。 */
export function rollDice(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(1 + Math.floor(Math.random() * 6));
  return out;
}

/* ---------------------------------------------------------------------------
 * 局面
 * ------------------------------------------------------------------------- */
export const PHASE = {
  COMMIT: 'commit',    /* 等双方提交承诺（开局 / 掉骰后） */
  BID: 'bid',          /* 叫牌中 */
  REVEAL: 'reveal',    /* 质疑后，等双方揭示骰子 */
  OVER: 'over',
};

/** 一局的初始公开局面。 */
export function initPub(n, dicePerPlayer) {
  const count = Math.max(2, n | 0 || 2);
  const per = dicePerPlayer || 3;
  return {
    n: count,
    phase: PHASE.COMMIT,
    turn: 0,             /* 当前该谁行动 */
    round: 0,            /* 第几轮（每轮到一次质疑或结束） */
    counts: new Array(count).fill(per),   /* 每人剩几颗骰（公开） */
    out: new Array(count).fill(false),    /* 是否出局（公开） */
    commits: new Array(count).fill(''),   /* 骰子承诺值（公开，但不含骰子） */
    lastBid: null,       /* { n, v, p } 上一手叫牌（公开） */
    doubter: -1,         /* 发起质疑的座位（公开） */
    hasRevealed: false,  /* 本轮是否已经揭示过骰子 */
    dice: [],            /* 揭示后的骰子（公开，未揭示时为空数组） */
    actual: -1,          /* 上一轮质疑的实际点数统计 */
    liar: false,         /* 上一轮质疑：上家是否撒谎 */
    loser: -1,           /* 上一轮掉骰的人 */
    winner: -1,          /* 胜者座位 */
    lastText: '',        /* 最近一条播报（展示用） */
  };
}

/* ---------------------------------------------------------------------------
 * 动作
 * ---------------------------------------------------------------------------
 *   { act:'commit', p, count, commit }        提交骰子承诺（公开）
 *   { act:'bid', p, n, v }                    叫牌（公开）
 *   { act:'doubt', p }                        质疑上家（公开）
 *   { act:'resolve', p, actual, liar, loser, dice, counts }   房主结算（公开）
 *   { act:'over', winner }                    整局结束
 * ------------------------------------------------------------------------- */

/** 叫牌是否合法（必须比上一手大）。 */
export function bidOK(last, n, v, totalDice) {
  if (!Number.isInteger(n) || n < 1) return false;
  if (!Number.isInteger(v) || v < 2 || v > 6) return false;
  if (totalDice != null && n > totalDice) return false;
  if (!last) return true;
  return n > last.n || (n === last.n && v > last.v);
}

/** 全场还有几颗骰（未出局的人）。 */
export function totalDice(pub) {
  if (!pub || !pub.counts) return 0;
  let n = 0;
  for (let i = 0; i < pub.counts.length; i++) if (!pub.out[i]) n += pub.counts[i];
  return n;
}

/** 数一下全场有多少颗 V 点（1 点是万能，算任意点数）。 */
export function countValue(diceList, v) {
  let n = 0;
  for (const dice of diceList) {
    if (!dice) continue;
    for (const d of dice) if (d === v || d === 1) n += 1;
  }
  return n;
}

/** 下一个还在场的座位。 */
export function nextSeat(pub, from) {
  if (!pub) return 0;
  const n = pub.n;
  for (let k = 1; k <= n; k++) {
    const s = (from + k) % n;
    if (!pub.out[s]) return s;
  }
  return from;
}

/** 承诺是否都已提交。 */
export function allCommitted(pub) {
  if (!pub || !pub.commits) return false;
  for (let i = 0; i < pub.n; i++) {
    if (pub.out[i]) continue;
    if (!pub.commits[i]) return false;
  }
  return true;
}

/**
 * 把动作作用到公开局面。
 * @param {object} pub
 * @param {object} act
 */
export function applyAction(pub, act) {
  if (!pub || !act) return pub;
  const next = Object.assign({}, pub);
  next.counts = (pub.counts || []).slice();
  next.out = (pub.out || []).slice();
  next.commits = (pub.commits || []).slice();
  next.dice = (pub.dice || []).slice();

  switch (act.act) {
    case 'commit': {
      /* 只接受计数与自己当前骰子数一致的承诺 —— 防止房主塞进一个
         「承诺 1 颗骰但哈希对应 3 颗」的假承诺。 */
      if (act.count != null && act.count !== next.counts[act.p]) break;
      next.commits[act.p] = act.commit || '';
      /* 两边承诺都齐了 → 进入叫牌 */
      if (allCommitted(next) && next.phase === PHASE.COMMIT) {
        next.phase = PHASE.BID;
        next.turn = nextSeat(next, next.n - 1);
        next.round += 1;
        next.lastText = '开牌 —— ' + (next.turn === 0 ? '你先叫' : '对方先叫');
      }
      break;
    }
    case 'bid': {
      if (next.phase !== PHASE.BID) break;
      next.lastBid = { n: act.n, v: act.v, p: act.p };
      next.turn = nextSeat(next, act.p);
      next.lastText = (act.p === 0 ? '你' : '对方') + '叫牌：' + act.n + ' 颗 ' + act.v + ' 点';
      break;
    }
    case 'doubt': {
      if (next.phase !== PHASE.BID) break;
      if (!next.lastBid) break;               /* 首轮没有上家可质疑 */
      next.phase = PHASE.REVEAL;
      next.doubter = act.p;
      next.lastText = (act.p === 0 ? '你' : '对方') + '质疑上家';
      break;
    }
    case 'resolve': {
      if (next.phase !== PHASE.REVEAL) break;
      next.hasRevealed = true;
      next.actual = act.actual;
      next.liar = !!act.liar;
      next.loser = act.loser;
      next.dice = act.dice || [];
      if (act.counts) next.counts = act.counts.slice();
      if (act.loser >= 0) {
        next.counts[act.loser] = Math.max(0, (next.counts[act.loser] || 0) - 1);
        if (next.counts[act.loser] === 0) next.out[act.loser] = true;
        /* 掉骰的人骰子变了 → 旧承诺作废，要重新承诺 */
        next.commits[act.loser] = '';
      }
      /* 结算完，宣布下一阶段 */
      const alive = [];
      for (let i = 0; i < next.n; i++) if (!next.out[i]) alive.push(i);
      if (alive.length <= 1) {
        next.phase = PHASE.OVER;
        next.winner = alive.length ? alive[0] : -1;
        next.lastText = next.winner === 0 ? '你赢了！' : (next.winner >= 0 ? '对方赢了' : '平局');
      } else {
        /* 承诺没交齐 → 回到承诺阶段；否则直接进叫牌 */
        next.phase = allCommitted(next) ? PHASE.BID : PHASE.COMMIT;
        if (next.phase === PHASE.BID) {
          /* 质疑后由上一手的叫牌者继续叫（避免同一人连续叫） */
          next.turn = nextSeat(next, next.lastBid ? next.lastBid.p : next.loser);
          next.round += 1;
          /* 新一局开始 —— 上一轮揭开的骰子作废（掉骰的人已经重摇了） */
          next.hasRevealed = false;
          next.dice = [];
        }
        next.lastBid = null;
      }
      break;
    }
    case 'over': {
      next.phase = PHASE.OVER;
      next.winner = act.winner;
      next.lastText = act.winner === 0 ? '你赢了！' : '对方赢了';
      break;
    }
    default:
      break;
  }
  return next;
}

/** 动作序列 → 公开局面。非法动作跳过。 */
export function fold(base, actions) {
  const b = base || {};
  /* 先用 initPub 填满默认值，再用 base 覆盖。
     注意顺序：initPub 的数组字段必须**在** Object.assign 之后再 slice 一遍，
     否则 base 里缺字段时会把 initPub 的默认值弄丢（比如 counts 变成空数组）。 */
  const seed = initPub(b.n || 2, b.dicePerPlayer || 3);
  let pub = Object.assign(seed, b);
  pub.counts = (seed.counts || []).slice();
  pub.out = (seed.out || []).slice();
  pub.commits = (seed.commits || []).slice();
  if (Array.isArray(b.counts)) pub.counts = b.counts.slice();
  if (Array.isArray(b.out)) pub.out = b.out.slice();
  if (Array.isArray(b.commits)) pub.commits = b.commits.slice();
  const list = actions || [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a || typeof a !== 'object') continue;
    const r = applyAction(pub, a);
    if (r) pub = r;
  }
  return pub;
}

/** 双方统一的重放入口。 */
export function replay(seed, actions) {
  const base = (seed && seed.base) || { n: 2 };
  return { base: base, pub: fold(base, actions || []), moves: (actions || []).slice() };
}

/** 公开局面摘要。 */
export function hashPub(pub) {
  if (!pub) return '';
  return [
    pub.n, pub.phase, pub.turn, pub.round,
    (pub.counts || []).join(','),
    (pub.out || []).join(','),
    (pub.commits || []).join(','),
    pub.lastBid ? (pub.lastBid.n + '/' + pub.lastBid.v + '/' + pub.lastBid.p) : '-',
    pub.doubter,
    pub.actual, pub.liar ? 1 : 0, pub.loser, pub.winner, pub.hasRevealed ? 1 : 0,
  ].join('|');
}

/**
 * 广播前的视图裁剪。
 * REVEAL 阶段还没揭示 —— 不能提前把骰子露出去（那就是作弊）。
 */
export function publicView(pub) {
  if (!pub) return pub;
  const v = Object.assign({}, pub);
  v.counts = (pub.counts || []).slice();
  v.out = (pub.out || []).slice();
  v.commits = (pub.commits || []).slice();
  v.dice = (pub.dice || []).slice();
  /* 骰子只在**揭示之后**才公开。
     注意不能按 phase 裁 —— 结算完阶段会退到 COMMIT（掉骰的人要重新承诺），
     那样会把刚揭开的骰子又抹掉，加入方就看不到这局揭了什么。
     所以用 hasRevealed 这个显式标记。 */
  if (!pub.hasRevealed) v.dice = [];
  return v;
}

/* ---------------------------------------------------------------------------
 * 揭示校验
 * ------------------------------------------------------------------------- */

/**
 * 校验对方揭示的骰子。
 * @returns {{ok:boolean, reason:string, dice:number[]}}
 */
export function verifyReveal(salt, dice, commit, expectCount) {
  if (!Array.isArray(dice)) return { ok: false, reason: '揭示的骰子格式不对', dice: [] };
  if (expectCount != null && dice.length !== expectCount) {
    return { ok: false, reason: '骰子数量对不上（说 ' + expectCount + ' 颗，揭示了 ' + dice.length + ' 颗）', dice: [] };
  }
  for (const d of dice) {
    if (!Number.isInteger(d) || d < 1 || d > 6) {
      return { ok: false, reason: '骰子点数不合法', dice: [] };
    }
  }
  if (!commit) return { ok: false, reason: '对方没有承诺过', dice: [] };
  if (commitHash(salt, dice) !== commit) {
    return { ok: false, reason: '揭示的骰子跟之前的承诺对不上 —— 他中途换了骰子', dice: [] };
  }
  return { ok: true, reason: '', dice: dice.slice() };
}

/**
 * 算出质疑结果。
 * @param {number[][]} diceList  每人揭示的骰子
 * @param {object} lastBid        { n, v, p }
 * @param {number} doubter        质疑者座位
 * @returns {{actual:number, liar:boolean, loser:number}}
 */
export function resolveDoubt(diceList, lastBid, doubter) {
  const actual = countValue(diceList, lastBid.v);
  const liar = actual < lastBid.n;
  const loser = liar ? lastBid.p : doubter;
  return { actual: actual, liar: liar, loser: loser };
}
