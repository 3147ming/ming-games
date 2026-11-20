/**
 * 麻将核心（第三批任务块 J）—— 纯逻辑，零 DOM / Canvas，Node 可单测
 * 范围（简版，写进规则页）：136 张牌、4 人、碰/杠/胡、七对、番型、自摸与点炮结算。
 * 不引外部依赖，所有判定都可独立调用。
 */

/** 牌编码 0..33：万 0-8 / 条 9-17 / 筒 18-26 / 东南西北 27-30 / 中发白 31-33 */
export const SUITS = Object.freeze({ WAN: 0, TIAO: 9, TONG: 18, HONOR: 27 });
const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
const CN_HONOR = ['东', '南', '西', '北', '中', '发', '白'];
export const TILE_NAMES = Array.from({ length: 34 }, (_, i) =>
  i < 27 ? `${CN_NUM[i % 9]}${['万', '条', '筒'][Math.floor(i / 9)]}` : CN_HONOR[i - 27]);
export const tileName = (i) => TILE_NAMES[i] ?? String(i);
export const isHonor = (t) => t >= 27;
export const suitOf = (t) => (t >= 27 ? 'z' : ['w', 's', 'p'][Math.floor(t / 9)]);
export const rankOf = (t) => (t >= 27 ? t - 26 : (t % 9) + 1);

/** 完整牌墙：34 种 ×4 = 136 张，无花牌 */
export const WALL = Array.from({ length: 34 }, (_, i) => [i, i, i, i]).flat();
export function shuffled(rng = Math.random) {
  const a = WALL.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor((typeof rng === 'function' ? rng() : Math.random()) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
export function counts(hand = []) {
  const c = new Array(34).fill(0);
  for (const t of hand) c[t] += 1;
  return c;
}
export function tileCountCheck() {
  return { total: WALL.length, perTile: counts(WALL).every((n) => n === 4), honors: 7 };
}

/* ---------------- 胡牌判定 ---------------- */
function canFormMelds(c, need) {
  const first = c.findIndex((n) => n > 0);
  if (first < 0) return need === 0;
  if (need === 0) return false;
  // 刻子
  if (c[first] >= 3) {
    c[first] -= 3;
    if (canFormMelds(c, need - 1)) { c[first] += 3; return true; }
    c[first] += 3;
  }
  // 顺子（同花色、非字牌、连续三张）
  if (first < 27 && first % 9 <= 6 && c[first + 1] > 0 && c[first + 2] > 0) {
    c[first]--; c[first + 1]--; c[first + 2]--;
    const ok = canFormMelds(c, need - 1);
    c[first]++; c[first + 1]++; c[first + 2]++;
    if (ok) return true;
  }
  return false;
}

/** 标准胡：4 面子 + 1 将（hand 长度 14，允许传入副露数量以调整手牌数） */
export function isStandardWin(hand = [], meldCount = 0) {
  const need = 4 - meldCount;
  if (need < 0 || hand.length !== need * 3 + 2) return false;
  const c = counts(hand);
  for (let i = 0; i < 34; i++) {
    if (c[i] < 2) continue;
    c[i] -= 2;
    const ok = canFormMelds(c, need);
    c[i] += 2;
    if (ok) return true;
  }
  return false;
}

/** 七对：14 张恰好 7 种各 2 张，且无副露 */
export function isSevenPairs(hand = [], meldCount = 0) {
  if (meldCount !== 0 || hand.length !== 14) return false;
  const c = counts(hand);
  const pairs = c.filter((n) => n === 2).length;
  return pairs === 7 && c.every((n) => n === 0 || n === 2);
}

/** 总胡牌判定（诈胡拦截入口） */
export function canWin(hand = [], meldCount = 0) {
  return isStandardWin(hand, meldCount) || isSevenPairs(hand, meldCount);
}

/** 听牌：13 张手牌（含副露则按 13-3×melds）可胡的牌种 */
export function waitingTiles(hand = [], meldCount = 0) {
  const c = counts(hand);
  const out = [];
  for (let t = 0; t < 34; t++) {
    if (c[t] >= 4) continue;
    c[t]++;
    if (canWin(c.reduce((a, n, i) => { for (let k = 0; k < n; k++) a.push(i); return a; }, []), meldCount)) out.push(t);
    c[t]--;
  }
  return out;
}

/** 分解一手和牌，返回面子数组（用于展示牌型明细） */
export function decompose(hand = [], meldCount = 0) {
  const need = 4 - meldCount;
  const c = counts(hand);
  const walk = (c2, left, acc) => {
    if (left === 0) return c2.every((n) => n === 0) ? acc : null;
    const first = c2.findIndex((n) => n > 0);
    if (first < 0) return null;
    if (c2[first] >= 3) {
      c2[first] -= 3;
      const r = walk(c2, left - 1, [...acc, { kind: 'triplet', tile: first }]);
      c2[first] += 3;
      if (r) return r;
    }
    if (first < 27 && first % 9 <= 6 && c2[first + 1] && c2[first + 2]) {
      c2[first]--; c2[first + 1]--; c2[first + 2]--;
      const r = walk(c2, left - 1, [...acc, { kind: 'sequence', tile: first }]);
      c2[first]++; c2[first + 1]++; c2[first + 2]++;
      if (r) return r;
    }
    return null;
  };
  for (let i = 0; i < 34; i++) {
    if (c[i] < 2) continue;
    c[i] -= 2;
    const melds = walk(c.slice(), need, []);
    c[i] += 2;
    if (melds) return { pair: i, melds };
  }
  return null;
}

/* ---------------- 番型与结算 ---------------- */
export const FAN = Object.freeze({
  pinghu: 1, menqing: 1, zimo: 1, pengpenghu: 2, qingyise: 4, qidui: 4, gangshang: 2,
});
export const FAN_NAMES = Object.freeze({
  pinghu: '平胡', menqing: '门清', zimo: '自摸', pengpenghu: '碰碰胡',
  qingyise: '清一色', qidui: '七对', gangshang: '杠上开花',
});

/**
 * 番型计算。ctx: { selfDraw, melds, rinshan, winTile }
 * melds: [{ kind:'pung'|'kong'|'chow', tile }]，暗杠 hidden:true
 */
export function scoreHand(hand = [], meldCount = 0, ctx = {}) {
  if (!canWin(hand, meldCount)) return { ok: false, reason: 'not-win' };
  const fans = [];
  const add = (k) => fans.push({ key: k, name: FAN_NAMES[k], fan: FAN[k] });
  const melds = Array.isArray(ctx.melds) ? ctx.melds : [];
  const openMelds = melds.filter((m) => !m.hidden);
  if (isSevenPairs(hand, meldCount)) add('qidui');
  else {
    const d = decompose(hand, meldCount);
    const allTriplet = d && d.melds.every((m) => m.kind === 'triplet')
      && melds.every((m) => m.kind === 'pung' || m.kind === 'kong');
    const allSequence = d && d.melds.every((m) => m.kind === 'sequence')
      && melds.every((m) => m.kind === 'chow');
    if (allTriplet) add('pengpenghu');
    if (allSequence && !isHonor(d?.pair ?? 0)) add('pinghu');
  }
  if (openMelds.length === 0) add('menqing');
  if (ctx.selfDraw) add('zimo');
  if (ctx.selfDraw && ctx.rinshan) add('gangshang');
  const suits = new Set(hand.filter((t) => t < 27).map(suitOf));
  if (suits.size === 1 && hand.every((t) => t < 27 || isHonor(t))) {
    // 字牌与单一花色混在一起不算清一色
    if (hand.every((t) => t < 27 && suitOf(t) === [...suits][0])) add('qingyise');
  }
  const total = Math.min(8, fans.reduce((a, f) => a + f.fan, 0));
  return { ok: true, fans, total, capped: fans.reduce((a, f) => a + f.fan, 0) > 8 };
}

/** 分数：1 番 ×1、2 番 ×2 …… 8 番 ×8（底分 base 默认 1） */
export function payout(fan, base = 1) {
  const f = Math.max(1, Math.min(8, Math.floor(fan)));
  return f * base;
}

/** 结算：自摸三家各付，点炮一家付 */
export function settle(seat, result, base = 1) {
  const unit = payout(result.total, base);
  if (result.selfDraw) {
    const deltas = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) if (i !== seat) deltas[i] = -unit;
    deltas[seat] = unit * 3;
    return { deltas, unit };
  }
  const deltas = [0, 0, 0, 0];
  deltas[seat] = unit;
  deltas[result.from] = -unit;
  return { deltas, unit };
}

/* ---------------- 对局状态机 ---------------- */
export function createMatch(rng = Math.random, opts = {}) {
  const wall = shuffled(rng);
  const hands = [[], [], [], []];
  for (let r = 0; r < 13; r++) for (let s = 0; s < 4; s++) hands[s].push(wall.pop());
  const dealer = 0;
  hands[dealer].push(wall.pop());
  return {
    wall, hands, melds: [[], [], [], []], discards: [[], [], [], []],
    turn: dealer, dealer, phase: 'discard', claim: null, lastDraw: null,
    rinshan: false, result: null, allowChi: opts.allowChi === true,
    steps: 0, log: [],
  };
}

export function sortHand(hand) { return hand.slice().sort((a, b) => a - b); }

/** 摸牌；杠后摸岭上牌 */
export function drawTile(m, seat = m.turn, rinshan = false) {
  if (!m.wall.length) {
    m.result = { type: 'draw-game', reason: 'wall-empty' };
    m.phase = 'end';
    return null;
  }
  const t = m.wall.pop();
  m.hands[seat].push(t);
  m.turn = seat;
  m.phase = 'discard';
  m.lastDraw = t;
  m.rinshan = !!rinshan;
  m.steps++;
  return t;
}

/** 碰 / 杠 / 胡的可用性检查（吃默认关） */
export function claimOptions(m, seat, tile) {
  const h = counts(m.hands[seat]);
  const opts = [];
  if (h[tile] >= 2) opts.push('pung');
  if (h[tile] >= 3) opts.push('kong');
  const test = m.hands[seat].concat(tile);
  if (canWin(test, m.melds[seat].length)) opts.push('win');
  if (m.allowChi && tile < 27 && !isHonor(tile)) {
    const r = tile % 9;
    for (const [a, b] of [[r - 2, r - 1], [r - 1, r + 1], [r + 1, r + 2]]) {
      if (a < 0 || b > 8) continue;
      const t1 = Math.floor(tile / 9) * 9 + a, t2 = Math.floor(tile / 9) * 9 + b;
      if (h[t1] > 0 && h[t2] > 0) { opts.push('chow'); break; }
    }
  }
  return opts;
}

/** 打牌。返回是否有和牌/副露请求。 */
export function discard(m, seat, tile) {
  if (m.phase !== 'discard' || seat !== m.turn) return { ok: false, reason: 'not-your-turn' };
  const i = m.hands[seat].indexOf(tile);
  if (i < 0) return { ok: false, reason: 'no-tile' };
  m.hands[seat].splice(i, 1);
  m.discards[seat].push(tile);
  m.phase = 'claim';
  m.lastDiscard = { seat, tile };
  m.steps++;
  const options = [];
  for (let d = 1; d <= 3; d++) {
    const s = (seat + d) % 4;
    const o = claimOptions(m, s, tile).filter((x) => x !== 'chow' || m.allowChi);
    if (o.length) options.push({ seat: s, options: o });
  }
  m.claim = { from: seat, tile, options };
  return { ok: true, options };
}

/** 暗杠 / 加杠（自己回合） */
export function declareKong(m, seat, tile, hidden = true) {
  const h = m.hands[seat];
  const need = hidden ? 4 : 1;
  const have = h.filter((t) => t === tile).length;
  if (have < need) return { ok: false, reason: 'not-enough' };
  for (let i = 0; i < need; i++) h.splice(h.indexOf(tile), 1);
  m.melds[seat].push({ kind: 'kong', tile, hidden });
  m.steps++;
  drawTile(m, seat, true);
  return { ok: true };
}

/** 响应 claim：胡 / 碰 / 杠 / 吃 / 过 */
export function resolveClaim(m, seat, action, chiPair = null) {
  if (m.phase !== 'claim' || !m.claim) return { ok: false, reason: 'no-claim' };
  const c = m.claim;
  const opt = c.options.find((o) => o.seat === seat);
  if (!opt || !opt.options.includes(action)) return { ok: false, reason: 'illegal-action' };
  const tile = c.tile;
  if (action === 'win') {
    const hand = m.hands[seat].concat(tile);
    const scored = scoreHand(hand, m.melds[seat].length, { selfDraw: false, melds: m.melds[seat], from: c.from });
    m.result = { type: 'win', winner: seat, from: c.from, tile, hand, selfDraw: false, ...scored };
    m.phase = 'end';
    m.claim = null;
    return { ok: true, result: m.result };
  }
  const h = m.hands[seat];
  if (action === 'pung') {
    for (let i = 0; i < 2; i++) h.splice(h.indexOf(tile), 1);
    m.melds[seat].push({ kind: 'pung', tile });
  } else if (action === 'kong') {
    for (let i = 0; i < 3; i++) h.splice(h.indexOf(tile), 1);
    m.melds[seat].push({ kind: 'kong', tile, hidden: false });
  } else if (action === 'chow' && chiPair) {
    for (const t of chiPair) { const k = h.indexOf(t); if (k >= 0) h.splice(k, 1); }
    m.melds[seat].push({ kind: 'chow', tile: Math.min(...chiPair, tile) });
  }
  m.discards[c.from].pop();
  m.turn = seat;
  m.phase = action === 'kong' ? 'discard' : 'discard';
  m.claim = null;
  m.steps++;
  if (action === 'kong') drawTile(m, seat, true);
  return { ok: true, action };
}

export function passClaim(m) {
  if (m.phase !== 'claim') return { ok: false };
  const from = m.claim?.from ?? (m.turn + 3) % 4;
  m.claim = null;
  m.turn = (from + 1) % 4;
  m.phase = 'draw';
  return { ok: true };
}

/** 自摸胡（自己回合） */
export function selfDrawWin(m, seat = m.turn) {
  if (m.phase !== 'discard') return { ok: false, reason: 'not-discard-phase' };
  const scored = scoreHand(m.hands[seat], m.melds[seat].length, {
    selfDraw: true, rinshan: m.rinshan, melds: m.melds[seat],
  });
  if (!scored.ok) return { ok: false, reason: 'not-win' };
  m.result = { type: 'win', winner: seat, from: null, tile: m.lastDraw, hand: m.hands[seat].slice(), selfDraw: true, ...scored };
  m.phase = 'end';
  return { ok: true, result: m.result };
}

/* ---------------- AI ---------------- */
/** 舍牌建议：现物优先（别人打过的牌不会点炮），其次孤张，再做番型倾向。 */
export function discardAdvice(m, seat = m.turn) {
  const hand = m.hands[seat] ?? [];
  const c = counts(hand);
  const danger = new Set();
  for (let s = 0; s < 4; s++) if (s !== seat) for (const t of m.discards[s]) danger.add(t);
  const suitCount = { w: 0, s: 0, p: 0, z: 0 };
  for (const t of hand) suitCount[suitOf(t)]++;
  const mainSuit = Object.entries(suitCount).filter(([k]) => k !== 'z').sort((a, b) => b[1] - a[1])[0]?.[0];
  const score = (t) => {
    let v = 0;
    if (danger.has(t)) v += 12;                 // 现物
    if (isHonor(t)) v += 2;                      // 字牌先打
    if (suitOf(t) !== mainSuit && !isHonor(t)) v += 4;  // 偏花色
    // 孤张（相邻两格内没有自己的牌）
    const lo = t < 27 && t % 9 > 0 ? c[t - 1] : 0;
    const hi = t < 27 && t % 9 < 8 ? c[t + 1] : 0;
    if (!lo && !hi) v += 3;
    if (c[t] >= 3) v -= 5;                       // 留刻子
    return v;
  };
  const ranked = hand.slice().sort((a, b) => score(b) - score(a) || a - b);
  return { tile: ranked[0] ?? null, ranked: ranked.map((t) => ({ tile: t, score: score(t) })) };
}

/** AI 自动处理一轮：胡 > 杠 > 碰 > 过；轮到自己时自摸胡 / 暗杠 / 舍牌。 */
export function aiStep(m) {
  if (m.phase === 'end') return { done: true };
  if (m.phase === 'claim') {
    const mine = m.claim.options.filter((o) => o.seat !== 0);
    for (const o of mine) {
      if (o.options.includes('win')) return resolveClaim(m, o.seat, 'win');
      if (o.options.includes('kong')) return resolveClaim(m, o.seat, 'kong');
      if (o.options.includes('pung')) return resolveClaim(m, o.seat, 'pung');
    }
    return passClaim(m);
  }
  if (m.phase === 'draw') { drawTile(m, m.turn); return { ok: true }; }
  // discard phase
  const seat = m.turn;
  if (seat !== 0) {
    const win = selfDrawWin(m, seat);
    if (win.ok) return win;
    const c = counts(m.hands[seat]);
    const kong = c.findIndex((n) => n === 4);
    if (kong >= 0 && m.wall.length > 0) { declareKong(m, seat, kong, true); return { ok: true }; }
  }
  const advice = discardAdvice(m, seat);
  return discard(m, seat, advice.tile);
}

/** 4 AI 自对弈：seat0 也由 AI 驱动，最多 2000 步，必有终局（流局或和牌） */
export function selfPlay(rng = Math.random, opts = {}) {
  const m = createMatch(rng, opts);
  let guard = 0;
  while (m.phase !== 'end' && guard++ < 2000) aiStep(m);
  if (m.phase !== 'end') m.result = { type: 'draw-game', reason: 'step-limit' };
  return {
    result: m.result, steps: m.steps, guard,
    wallLeft: m.wall.length,
    discardTotal: m.discards.reduce((a, d) => a + d.length, 0),
  };
}
