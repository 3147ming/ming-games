/**
 * 回牌 · 纯规则核心（合并指令 块7）
 * 规则卡权威：rules/huipai.json（v6）。纯逻辑、零 DOM，Node 可直接单测。
 * 3 人、3 副 156 张（含 6 王）、每人 10 张、牌堆 126；先出完胜；
 * 特殊牌型 5-10-K 与炸弹共用一条牌力阶梯。
 */

export const SUITS = Object.freeze([
  { id: 'S', label: '♠', name: '黑桃', color: '#1c1c28', strength: 4, tier: 'spade' },
  { id: 'H', label: '♥', name: '红桃', color: '#c62f3b', strength: 3, tier: 'heart' },
  { id: 'C', label: '♣', name: '梅花', color: '#1c1c28', strength: 2, tier: 'club' },
  { id: 'D', label: '♦', name: '方块', color: '#c62f3b', strength: 1, tier: 'diamond' },
]);
export const SUIT_BY_ID = Object.fromEntries(SUITS.map((s) => [s.id, s]));
export const RANKS = Object.freeze([
  { v: 3, label: '3' }, { v: 4, label: '4' }, { v: 5, label: '5' }, { v: 6, label: '6' },
  { v: 7, label: '7' }, { v: 8, label: '8' }, { v: 9, label: '9' }, { v: 10, label: '10' },
  { v: 11, label: 'J' }, { v: 12, label: 'Q' }, { v: 13, label: 'K' }, { v: 14, label: 'A' },
  { v: 15, label: '2' }, { v: 16, label: '小王' }, { v: 17, label: '大王' },
]);
export const rankLabel = (v) => RANKS.find((r) => r.v === v)?.label || String(v);

/** 牌力阶梯（唯一权威，从小到大）—— 与 rules/huipai.json powerLadder 一一对应 */
export const POWER_LADDER = Object.freeze([
  '四炸', '异色5-10-K', '五炸', '方片5-10-K', '六炸', '梅花5-10-K', '七炸', '红桃5-10-K',
  '八炸', '黑桃5-10-K', '九炸', '十炸', '十一炸', '十二炸', '王炸',
]);
const BOMB_TIER = { 4: 0, 5: 2, 6: 4, 7: 6, 8: 8, 9: 10, 10: 11, 11: 12, 12: 13 };
const S510K_TIER = { mixed: 1, diamond: 3, club: 5, heart: 7, spade: 9 };
export const ROCKET_TIER = 14;

/** 种子随机（可复现，便于自对弈日志比对） */
export function rngFrom(seed = 0) {
  let x = (Number(seed) || 0) >>> 0 || 0x2f6e2b1;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; };
}
function shuffle(cards, rng) {
  const a = cards.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/**
 * 构造 3 副共 156 张（含 6 王）。
 * 每副 4 花色 × 13 点数（3→A、2）= 52 张；每副的 ♠2/♥2 记为小王/大王，
 * 合起来正好 6 王、总计 156 张；点数 2 仍有 ♣2/♦2。
 */
export function buildDeck(spec = {}) {
  const decks = spec.decks ?? 3;
  const cards = [];
  let seq = 0;
  const nums = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]; // 3..A,2
  for (let d = 0; d < decks; d++) {
    for (const s of SUITS) {
      for (const v of nums) {
        const joker = v === 15 && (s.id === 'S' || s.id === 'H');
        const label = joker ? (s.id === 'S' ? '小王' : '大王') : rankLabel(v);
        cards.push({ id: `c${seq++}`, deck: d, suit: joker ? 'JOKER' : s.id,
          suitLabel: joker ? '★' : s.label, suitName: joker ? '王' : s.name,
          color: joker ? '#c62f3b' : s.color, rank: joker ? (s.id === 'S' ? 16 : 17) : v,
          label, joker });
      }
    }
  }
  return cards;
}

/** 一手牌是不是特殊牌型 5-10-K：各一张 5、10、K，不多不少 */
export function is510K(cards = []) {
  if (cards.length !== 3) return false;
  const ranks = cards.map((c) => c.rank).sort((a, b) => a - b);
  return ranks[0] === 5 && ranks[1] === 10 && ranks[2] === 13;
}

/** 5-10-K 花色档：三张同花→对应花色；其余（含两同一异、三异）→异色档 */
export function tier510K(cards = []) {
  const suits = cards.map((c) => c.suit);
  if (suits.length === 3 && suits.every((s) => s === suits[0])) {
    return { key: suits[0], tier: S510K_TIER[SUIT_BY_ID[suits[0]]?.tier] ?? 1,
      name: `${SUIT_BY_ID[suits[0]].name}5-10-K` };
  }
  return { key: 'mixed', tier: S510K_TIER.mixed, name: '异色5-10-K' };
}

/** 识别牌型，返回 { id, name, len, rank, tier?, special?, k? } 或 null */
export function identify(cards = []) {
  const n = cards.length;
  if (!n) return null;
  const cs = cards.slice().sort((a, b) => a.rank - b.rank);
  const ranks = cs.map((c) => c.rank);
  const counts = new Map();
  for (const r of ranks) counts.set(r, (counts.get(r) || 0) + 1);
  const entries = [...counts.entries()].sort((a, b) => a[0] - b[0]);
  const maxRank = Math.max(...ranks);
  const base = { cards: cs, len: n, rank: maxRank };

  // 特殊牌型优先（三张只能作为 5-10-K，不得拆散混入别型）
  if (is510K(cs)) {
    const t = tier510K(cs);
    return { ...base, id: '510k', name: t.name, special: true, tier: t.tier, suitKey: t.key,
      rank: 0, k: t.key };
  }
  // 王炸：六张王（3 副×2）
  if (n === 6 && cs.every((c) => c.joker)) {
    return { ...base, id: 'rocket', name: '王炸', special: true, tier: ROCKET_TIER, rank: 0 };
  }
  // 炸弹：≥4 张同点（2 也能炸，王以外）
  if (entries.length === 1 && n >= 4 && n <= 12 && cs.every((c) => !c.joker)) {
    const name = `${['', '', '', '', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'][n]}炸`;
    return { ...base, id: 'bomb', name, special: true, tier: BOMB_TIER[n] ?? n - 4, rank: 0, k: n };
  }
  if (n === 1) return { ...base, id: 'single', name: '单张' };
  if (n === 2 && entries.length === 1) return { ...base, id: 'pair', name: '对子' };
  if (n === 3 && entries.length === 1) return { ...base, id: 'triple', name: '三张' };
  if (n === 4 && entries.length === 2 && entries.some(([, c]) => c === 3))
    return { ...base, id: 'triple-single', name: '三带一', rank: entries.find(([, c]) => c === 3)[0] };
  if (n === 5 && entries.length === 2 && entries.some(([, c]) => c === 3))
    return { ...base, id: 'triple-pair', name: '三带二', rank: entries.find(([, c]) => c === 3)[0] };
  if (n === 6 && entries.length === 2 && entries.every(([, c]) => c === 3) && isRun(entries.map(([r]) => r)))
    return { ...base, id: 'plane', name: '飞机', rank: Math.max(...entries.map(([r]) => r)) };
  if (n === 8 && entries.length === 4 && entries.filter(([, c]) => c === 3).length === 2
    && isRun(entries.filter(([, c]) => c === 3).map(([r]) => r)))
    return { ...base, id: 'plane-single', name: '飞机带单', rank: Math.max(...entries.filter(([, c]) => c === 3).map(([r]) => r)) };
  if (n === 10 && entries.length === 4 && entries.filter(([, c]) => c === 3).length === 2
    && isRun(entries.filter(([, c]) => c === 3).map(([r]) => r))
    && entries.filter(([, c]) => c === 2).length === 2)
    return { ...base, id: 'plane-pair', name: '飞机带对', rank: Math.max(...entries.filter(([, c]) => c === 3).map(([r]) => r)) };
  if (n === 6 && entries.length === 2 && entries.some(([, c]) => c === 4) && entries.some(([, c]) => c === 2))
    return { ...base, id: 'four-two', name: '四带二', rank: entries.find(([, c]) => c === 4)[0] };

  const plain = cs.filter((c) => !c.joker && c.rank < 15);
  const pr = plain.map((c) => c.rank);
  const uniq = [...new Set(pr)].sort((a, b) => a - b);
  if (n >= 5 && n === plain.length && uniq.length === n && isRun(uniq))
    return { ...base, id: 'straight', name: '顺子', rank: Math.max(...uniq) };
  if (n >= 6 && n % 2 === 0 && n === plain.length && entries.length === n / 2
    && entries.every(([, c]) => c === 2) && isRun(entries.map(([r]) => r)))
    return { ...base, id: 'double-straight', name: '连对', rank: Math.max(...entries.map(([r]) => r)) };
  return null;
}
function isRun(sorted) {
  if (!sorted.length) return false;
  return sorted.every((r, i) => i === 0 || r === sorted[i - 1] + 1);
}

/**
 * a 能否压住 b。b 为空=自由领出。
 * 规则：同牌型同张数比点数；炸弹/5-10-K/王炸之间只按牌力阶梯比；特殊牌压普通牌；
 * 同档 5-10-K 相遇视为平手（先出者压住）→ 返回 false。
 */
export function beats(a, b) {
  if (!a) return false;
  if (!b) return true;
  if (a.special && b.special) return a.tier > b.tier; // 同档平手，挑战者不能压
  if (a.special && !b.special) return true;
  if (!a.special && b.special) return false;
  return a.id === b.id && a.len === b.len && a.rank > b.rank;
}

/** 枚举合法出牌（领出返回全部牌型；跟牌只返回能压过的） */
export function candidatePlays(hand = [], last = null) {
  const groups = new Map();
  for (const c of hand) {
    if (!groups.has(c.rank)) groups.set(c.rank, []);
    groups.get(c.rank).push(c);
  }
  const tries = [];
  for (const cs of groups.values()) {
    tries.push([cs[0]]);
    if (cs.length >= 2) tries.push(cs.slice(0, 2));
    if (cs.length >= 3) tries.push(cs.slice(0, 3));
    if (cs.length >= 4 && cs[0].rank < 16) tries.push(cs.slice(0, 4));
    if (cs.length >= 5 && cs[0].rank < 16) tries.push(cs.slice(0, 5));
  }
  // 5-10-K：取任意各一张组合（花色影响档位）
  const f5 = hand.filter((c) => c.rank === 5), f10 = hand.filter((c) => c.rank === 10), fk = hand.filter((c) => c.rank === 13);
  for (const a of f5) for (const b of f10) for (const k of fk) tries.push([a, b, k]);
  // 王炸
  const jokers = hand.filter((c) => c.joker);
  if (jokers.length === 6) tries.push(jokers);
  // 顺子 / 连对
  const ranks = [...groups.keys()].filter((r) => r >= 3 && r <= 14).sort((x, y) => x - y);
  for (let i = 0; i < ranks.length; i++) {
    const run = [ranks[i]];
    for (let j = i + 1; j < ranks.length && ranks[j] === run[run.length - 1] + 1; j++) {
      run.push(ranks[j]);
      if (run.length >= 5) tries.push(run.map((r) => groups.get(r)[0]));
      if (run.length >= 3) tries.push(run.flatMap((r) => groups.get(r).slice(0, 2)));
    }
  }
  const seen = new Set(); const out = [];
  for (const cs of tries) {
    const pat = identify(cs);
    if (!pat) continue;
    const key = cs.map((c) => c.id).sort().join(',');
    if (seen.has(key) || (last && !beats(pat, last))) continue;
    seen.add(key);
    out.push({ cards: cs.map((c) => c.id), pattern: pat });
  }
  return out;
}

export function createGame(options = {}) {
  const cfg = {
    players: options.players ?? 3, handSize: options.handSize ?? 10,
    refillWinner: options.refillWinner ?? 6, refillOthers: options.refillOthers ?? 3,
    maxReshuffle: options.maxReshuffle ?? 3, difficulty: options.difficulty ?? 'normal',
    seed: options.seed ?? Date.now(), first: options.first ?? 'p0',
  };
  const ids = Array.from({ length: cfg.players }, (_, i) => `p${i}`);
  const rng = rngFrom(cfg.seed);
  const pile = shuffle(buildDeck({ decks: 3 }), rng);
  const hands = Object.fromEntries(ids.map((id) => [id, []]));
  for (let r = 0; r < cfg.handSize; r++) for (const id of ids) hands[id].push(pile.pop());
  return {
    cfg, ids, rng, hands, pile, discard: [], turn: cfg.first, leader: cfg.first,
    last: null, passed: {}, shuffles: 0, ranks: {}, finished: [], winner: null,
    steps: 0, tricks: 0, log: [`发牌：每人 ${cfg.handSize} 张，牌堆 ${pile.length} 张`], lastError: null,
  };
}

/** 牌堆空 → 弃牌洗回；受最多 3 次限制；用尽后不再洗回 */
export function reshuffleIfNeeded(s) {
  if (s.pile.length || !s.discard.length) return false;
  if (s.shuffles >= s.cfg.maxReshuffle) { s.log.push('洗牌已达上限，停止洗回，只用手牌打完'); return false; }
  s.pile = shuffle(s.discard.splice(0), s.rng);
  s.shuffles++;
  s.log.push(`牌堆抽空：第 ${s.shuffles} 次洗回 ${s.pile.length} 张`);
  return true;
}

/** 一墩结束：赢家补 6、其余各补 3；牌堆不足则洗回，洗回用尽则少补/不补 */
export function refill(s, winner) {
  for (const id of s.ids) {
    const n = id === winner ? s.cfg.refillWinner : s.cfg.refillOthers;
    for (let k = 0; k < n; k++) {
      if (!s.pile.length && !reshuffleIfNeeded(s)) break;
      const c = s.pile.pop();
      if (c) s.hands[id].push(c);
    }
  }
  s.log.push(`补给：${winner}+${s.cfg.refillWinner}，其余各+${s.cfg.refillOthers}，牌堆余 ${s.pile.length}`);
}

export function moves(s, side = s.turn) {
  if (s.winner || !s.hands[side]?.length) return [];
  const free = !s.last || s.last.side === side;
  const plays = candidatePlays(s.hands[side], free ? null : s.last.pattern);
  return free ? plays : [...plays, { pass: true }];
}

/** 非法出牌返回具体原因，不静默吞掉 */
export function checkPlay(s, side, m) {
  if (s.winner) return '对局已结束，不能出牌';
  if (!m || m.pass) return s.last ? null : '你是领出方，必须出牌不能过';
  const ids = Array.isArray(m.cards) ? m.cards : [];
  if (!ids.length) return '没有选出任何牌';
  if (new Set(ids).size !== ids.length) return '同一张牌不能重复出';
  const cards = ids.map((id) => s.hands[side].find((c) => c.id === id));
  if (cards.some((c) => !c)) return '出的牌不在自己的手牌里';
  const pat = identify(cards);
  if (!pat) return `牌型不符合回牌规则（${cards.length} 张无法组成合法牌型）`;
  if (s.last && s.last.side !== side && !beats(pat, s.last.pattern))
    return `压不过上家的${s.last.pattern.name}`;
  return null;
}

function endTrick(s, side) {
  s.tricks++;
  s.log.push(`第 ${s.tricks} 墩 ${side} 赢下`);
  refill(s, side);
  s.last = null; s.passed = {}; s.turn = side; s.leader = side;
}

export function apply(s, m) {
  if (s.winner) return s;
  const side = s.turn;
  s.lastError = null;
  const bad = checkPlay(s, side, m);
  if (bad) { s.lastError = bad; s.log.push(`非法出牌（${side}）：${bad}`); return s; }
  if (!m || m.pass) {
    s.passed[side] = true; s.steps++;
    s.log.push(`${side} 过牌`);
    const done = s.ids.filter((id) => id !== side).every((id) => id === s.last.side || s.passed[id]);
    if (done) endTrick(s, s.last.side); else nextTurn(s);
    return s;
  }
  const ids = m.cards;
  const cards = ids.map((id) => s.hands[side].find((c) => c.id === id));
  s.hands[side] = s.hands[side].filter((c) => !ids.includes(c.id));
  s.discard.push(...cards);
  s.last = { side, pattern: m.pattern || identify(cards), cards };
  s.leader = side; s.passed = {}; s.steps++;
  s.log.push(`${side} 出 ${s.last.pattern.name}${s.last.pattern.special ? '（阶梯第' + (s.last.pattern.tier + 1) + '级）' : ''}，余 ${s.hands[side].length} 张`);
  if (!s.hands[side].length) {
    s.winner = side; s.finished.push(side);
    s.ranks[side] = 1;
    s.ids.filter((id) => id !== side).forEach((id, i) => { s.ranks[id] = i + 2; });
    s.log.push(`终局：${side} 先出完获胜 · 名次 ${s.ids.map((id) => `${id}:${s.ranks[id]}`).join(' ')} · 洗牌 ${s.shuffles} 次`);
    return s;
  }
  nextTurn(s);
  return s;
}
function nextTurn(s) { s.turn = s.ids[(s.ids.indexOf(s.turn) + 1) % s.ids.length]; }

/** AI：简单=随机；普通=最小牌型且不浪费王炸；困难=遵守牌力阶梯、只在必要时用大牌 */
export function aiMove(s, difficulty = s.cfg.difficulty) {
  const ms = moves(s);
  if (!ms.length) return null;
  const plays = ms.filter((m) => !m.pass);
  if (!plays.length) return { pass: true };
  const cost = (m) => {
    const p = m.pattern;
    if (p.id === 'rocket') return 1000;
    if (p.special) return 100 + p.tier * 10;
    return (p.id === 'bomb' ? 90 : 0) + p.rank + p.len * 2;
  };
  if (difficulty === 'easy') return plays[Math.floor(s.rng() * plays.length)];
  const sorted = plays.slice().sort((a, b) => cost(a) - cost(b));
  if (difficulty === 'hard') {
    // 跟牌且上家是特殊牌时，只在能压且不是王炸时出，尽量用最小阶梯
    const specials = sorted.filter((m) => m.pattern.special && m.pattern.id !== 'rocket');
    if (specials.length) return specials[0];
    const normal = sorted.filter((m) => !m.pattern.special);
    return normal[0] || sorted[0];
  }
  const safe = sorted.filter((m) => !['rocket'].includes(m.pattern.id));
  return safe[0] || sorted[0];
}

/** 单局自对弈，返回含洗牌/补给/5-10-K 记录的日志 */
export function selfPlay(seed = 0, difficulty = 'normal') {
  const s = createGame({ seed, difficulty });
  let guard = 0;
  while (!s.winner && guard++ < 600) {
    const before = s.steps;
    const m = aiMove(s);
    if (!m) { s.winner = 'draw'; s.log.push('无人能出牌，判和'); break; }
    apply(s, m);
    if (s.steps === before) { s.winner = 'draw'; s.log.push('卡死：出牌未被接受'); break; }
  }
  if (!s.winner) { s.winner = 'stall'; s.log.push('超过步数上限'); }
  return {
    winner: s.winner, steps: s.steps, shuffles: s.shuffles, tricks: s.tricks,
    stall: s.winner === 'stall' || s.winner === 'draw',
    log: s.log, ranks: s.ranks,
    has510K: s.log.some((l) => l.includes('5-10-K')),
    hasShuffle: s.log.some((l) => l.includes('洗回')),
    hasRefill: s.log.some((l) => l.includes('补给')),
  };
}
