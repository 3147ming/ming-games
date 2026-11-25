/* =============================================================================
 * uno/src/rules.mjs —— UNO 彩牌规则引擎（零依赖、纯逻辑、可单测）
 * -----------------------------------------------------------------------------
 * 规矩（简化到「能一局打完」的程度，规则贴近官方）：
 *   · 牌库：四种颜色（红黄蓝绿）× 数字 0-9，每色 0 一张、1-9 两张，
 *           外加万能牌（Wild）×4、加二牌（+2）×2、反转牌（Reverse）×2、跳过牌（Skip）×2。
 *   · 开局每人 7 张，弃牌堆翻一张当起始牌。
 *   · 出牌条件：颜色相同 / 数字相同 / 是万能牌 / 弃牌堆顶是万能牌。
 *   · 万能牌出牌后由出牌人指定颜色。
 *   · +2 让下家摸 2 张并跳过；Skip 让下家跳过；Reverse 反转出牌方向（两人局等价于跳过）。
 *   · 手牌出完即胜。
 *
 * 纪律：
 *   · 顶层不碰 DOM、不碰 localStorage。
 *   · 所有纯函数，方便单测与「房主权威重放」。
 * ========================================================================== */

export const COLORS = ['red', 'yellow', 'green', 'blue'];
export const COLOR_LABEL = { red: '红', yellow: '黄', green: '绿', blue: '蓝' };
export const COLOR_HEX = { red: '#e0483c', yellow: '#f5c542', green: '#3fb96b', blue: '#3d8bd8' };

export const WILD = 'wild';
export const SKIP = 'skip';
export const REVERSE = 'reverse';
export const DRAW2 = 'draw2';

export const HAND_SIZE = 7;
export const COLORS_COUNT = COLORS.length;

/**
 * 牌 id。
 *   颜色牌：'red-5'
 *   功能牌：'wild' / 'draw2' / 'skip' / 'reverse'
 * 同 id 可以有多张（数字牌 1-9 各两张、功能牌若干张）——
 * 手里用 id 数组表示，出牌时移除第一张匹配的。
 */
export function cardId(card) {
  if (!card) return '';
  if (card.color === WILD) {
    /* 功能牌的 value 本身就是类型（wild/draw2/skip/reverse）——
       别把 draw2 压成 wild，否则 +2 和万能牌就分不开了。 */
    return card.value === WILD ? WILD : String(card.value);
  }
  return card.color + '-' + card.value;
}

export function parseCard(id) {
  if (id === WILD) return { color: WILD, value: WILD };
  if (id === SKIP) return { color: WILD, value: SKIP };
  if (id === REVERSE) return { color: WILD, value: REVERSE };
  if (id === DRAW2) return { color: WILD, value: DRAW2 };
  const [color, value] = String(id).split('-');
  return { color, value: Number(value) };
}

/**
 * 生成牌库（数组，每项 {color,value}）。
 * id 一律由 cardId() 现算，别在牌库里存 id —— 两处定义很容易打架。
 */
export function makeDeck() {
  const deck = [];
  for (const color of COLORS) {
    deck.push({ color, value: 0 });
    for (let n = 1; n <= 9; n++) {
      deck.push({ color, value: n });
      deck.push({ color, value: n });
    }
  }
  for (let i = 0; i < 4; i++) deck.push({ color: WILD, value: WILD });
  for (let i = 0; i < 2; i++) deck.push({ color: WILD, value: DRAW2 });
  for (let i = 0; i < 2; i++) deck.push({ color: WILD, value: REVERSE });
  for (let i = 0; i < 2; i++) deck.push({ color: WILD, value: SKIP });
  return deck;
}

/** 可复现的洗牌（mulberry32 伪随机）。seed 相同 → 牌序相同，联机两端才一致。 */
export function shuffle(deck, seed) {
  const rnd = mulberry32(seed >>> 0);
  const arr = deck.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 开局：发牌 + 翻一张起始牌。
 * @param {number} seed
 * @param {number} players 玩家数（本实现按 2 人）
 */
export function deal(seed, players) {
  const n = Math.max(2, players || 2);
  const deck = shuffle(makeDeck(), seed);
  const hands = [];
  for (let p = 0; p < n; p++) hands.push([]);
  for (let i = 0; i < HAND_SIZE; i++) {
    for (let p = 0; p < n; p++) hands[p].push(cardId(deck.pop()));
  }
  /* 起始牌：翻到一张有颜色的牌（万能/功能牌作为起始牌太容易卡手，重新翻） */
  let top = deck.pop();
  while (top.color === WILD && deck.length) top = deck.pop();
  return {
    deck: deck.map(cardId),
    hands,
    discard: [cardId(top)],   /* 弃牌堆，顶牌是最后一张 */
    top: cardId(top),
    activeColor: top.color,
    direction: 1,
    turn: 0,
    winner: -1,
    lastPlayed: null,
  };
}

/** 从一张手牌里挑一个「最多的颜色」—— 万能牌没指定颜色时的兜底。 */
export function pickColor(hand) {
  const counts = {};
  for (const id of hand || []) {
    const c = parseCard(id);
    if (c.color !== WILD) counts[c.color] = (counts[c.color] || 0) + 1;
  }
  let best = COLORS[0], bestN = -1;
  for (const col of COLORS) {
    if ((counts[col] || 0) > bestN) { bestN = counts[col] || 0; best = col; }
  }
  return best;
}

/**
 * 这张牌能不能打出。
 * @param {string} id 牌 id
 * @param {string} top 弃牌堆顶牌 id
 * @param {string} activeColor 当前生效颜色（顶牌是万能牌时用这个）
 */
export function canPlay(id, top, activeColor) {
  const c = parseCard(id);
  const t = parseCard(top);
  if (c.color === WILD) return true;              /* 万能/功能牌：简化成任意时候都能打 */
  if (t.color === WILD) return c.color === activeColor;
  if (c.color === t.color) return true;
  if (c.value === t.value) return true;
  return false;
}

/**
 * 出牌后的新状态。返回 { ok, state, reason }。
 * 不修改传入的 state。
 * @param {object} state
 * @param {number} player 出牌人索引
 * @param {string} id 牌 id
 * @param {string} [chosenColor] 万能牌指定的颜色
 */
export function play(state, player, id, chosenColor) {
  if (state.winner >= 0) return { ok: false, reason: '这局已经结束了' };
  if (state.turn !== player) return { ok: false, reason: '还没轮到你出牌' };
  if (!canPlay(id, state.top, state.activeColor)) return { ok: false, reason: '这张牌接不上' };

  const hand = state.hands[player] || [];
  const at = hand.indexOf(id);
  if (at < 0) return { ok: false, reason: '手里没有这张牌' };

  const c = parseCard(id);
  const next = cloneState(state);
  const players = next.hands.length;

  next.hands[player].splice(at, 1);
  /* 旧顶牌进弃牌堆，新牌成为顶牌（弃牌堆用于牌库耗尽时回收重洗） */
  next.discard = (next.discard || []).concat([state.top]);
  next.top = id;
  next.lastPlayed = { player, id, color: c.color };

  /* 出牌后的生效颜色：万能牌由出牌人指定，否则就是这张牌的颜色 */
  if (c.color === WILD) {
    next.activeColor = (chosenColor && COLORS.includes(chosenColor))
      ? chosenColor
      : pickColor(next.hands[player]);
  } else {
    next.activeColor = c.color;
  }

  /* 手牌出完即胜 —— 先判胜负，再处理功能牌效果 */
  if (next.hands[player].length === 0) {
    next.winner = player;
    return { ok: true, state: next };
  }

  /* 功能牌效果 */
  if (c.value === SKIP) {
    next.turn = advance(advance(player, players, next.direction), players, next.direction);
  } else if (c.value === REVERSE) {
    if (players === 2) {
      /* 两人局：反转 = 跳过下家 */
      next.turn = advance(advance(player, players, next.direction), players, next.direction);
    } else {
      next.direction *= -1;
      next.turn = advance(player, players, next.direction);
    }
  } else if (c.value === DRAW2) {
    /* +2：下家摸两张。
       注意 UNO 规则里被罚的人**仍然轮到自己出牌**（不是跳过）——
       写错会让被罚的一方永远等不到回合，直接死等。 */
    const victim = advance(player, players, next.direction);
    drawCards(next, victim, 2);
    next.turn = victim;
  } else {
    next.turn = advance(player, players, next.direction);
  }

  return { ok: true, state: next };
}

/**
 * 摸牌。牌库空了就用弃牌堆重洗（顶牌除外）。
 * 直接改传入的 state（内部用）。
 * @returns 实际摸到的张数
 */
export function drawCards(state, player, count) {
  let got = 0;
  for (let i = 0; i < count; i++) {
    if (!state.deck.length) {
      /* 弃牌堆只留顶牌（state.top），其余回收重洗 */
      const recycled = (state.discard || []).filter((id) => id !== state.top);
      if (!recycled.length) break;
      state.deck = shuffle(recycled, (state.deck.length * 2654435761 + state.turn * 7919) >>> 0);
      state.discard = [state.top];
    }
    const c = state.deck.pop();
    if (!c) break;
    state.hands[player].push(c);
    got++;
  }
  return got;
}

/** 玩家没牌可出时摸一张。返回 { ok, state, drawn }。 */
export function drawOne(state, player) {
  if (state.turn !== player) return { ok: false, reason: '还没轮到你' };
  const next = cloneState(state);
  const before = next.hands[player].length;
  drawCards(next, player, 1);
  return { ok: true, state: next, drawn: next.hands[player].length > before };
}

/**
 * 「摸牌」这个动作的完整语义（本地与联机重放共用同一份）。
 *
 * 为什么要单独抽一个函数：
 *   联机是「房主权威 + 动作重放」，如果本地摸牌的收尾逻辑（接不上就跳过回合）
 *   只写在 UI 层，重放时就会漏掉这一步 —— 两端状态从此对不上。
 *   所以规则必须整个放在规则引擎里，两边共用。
 *
 * 语义：摸一张；如果摸完仍然一张都接不上，这轮就算跳过，回合交给下家。
 */
export function drawAction(state, player) {
  if (state.turn !== player) return { ok: false, reason: '还没轮到你' };
  const next = cloneState(state);
  drawCards(next, player, 1);
  if (!hasPlayable(next, player)) {
    next.turn = advance(player, next.hands.length, next.direction);
  }
  return { ok: true, state: next };
}

/** 推进玩家索引（带方向）。 */
export function advance(player, players, direction) {
  return ((player + direction) % players + players) % players;
}

/** 当前玩家是否有能接的牌。 */
export function hasPlayable(state, player) {
  const hand = state.hands[player] || [];
  for (const id of hand) if (canPlay(id, state.top, state.activeColor)) return true;
  return false;
}

/** 深拷贝状态（联机广播用普通对象，浅拷贝不够）。 */
export function cloneState(s) {
  return {
    deck: s.deck.slice(),
    hands: s.hands.map((h) => h.slice()),
    discard: (s.discard || []).slice(),
    top: s.top,
    activeColor: s.activeColor,
    direction: s.direction,
    turn: s.turn,
    winner: s.winner,
    lastPlayed: s.lastPlayed ? { ...s.lastPlayed } : null,
  };
}

/**
 * 状态摘要：房主权威模型里用来比对面板是否一致。
 */
export function hashState(s) {
  const parts = [];
  parts.push(s.top, s.activeColor, String(s.direction), String(s.turn), String(s.winner));
  for (const h of s.hands) parts.push(h.slice().sort().join(','));
  return parts.join('|');
}

/**
 * 从动作序列重放整局（联机双方共用同一份代码，保证结果一致）。
 * 动作：{p:玩家索引, act:'play'|'draw', id?, color?}
 */
export function replay(actions, seed, players) {
  let s = deal(seed, players || 2);
  for (const a of actions || []) {
    if (s.winner >= 0) break;
    if (a.act === 'play') {
      const r = play(s, a.p, a.id, a.color);
      if (!r.ok) break;
      s = r.state;
    } else if (a.act === 'draw') {
      /* 用 drawAction（完整语义）而不是 drawOne（只摸牌）——
         否则重放时漏掉「接不上就跳过回合」，两端状态会对不上。 */
      const r = drawAction(s, a.p);
      if (!r.ok) break;
      s = r.state;
    }
  }
  return { state: s, actions: (actions || []).slice() };
}

/**
 * AI 选牌：优先出功能牌，其次出同色高数字，最后随便出一张。
 * @param {object} state
 * @param {number} player
 * @param {number} seed 用于随机挑选（可复现）
 */
export function aiChoose(state, player, seed) {
  const hand = state.hands[player] || [];
  const playable = hand.filter((id) => canPlay(id, state.top, state.activeColor));
  if (!playable.length) return null;

  const rnd = mulberry32((seed >>> 0) + player * 7919 + state.hands[player].length * 131);
  const score = (id) => {
    const c = parseCard(id);
    if (c.value === DRAW2) return 100;
    if (c.value === SKIP) return 90;
    if (c.value === REVERSE) return 80;
    if (c.value === WILD) return 70;
    /* 颜色牌：数字越大越先甩出去（数字牌 value 是 Number） */
    return Number(c.value) * 3;
  };
  const sorted = playable.slice().sort((a, b) => {
    const d = score(b) - score(a);
    if (d !== 0) return d;
    return rnd() - 0.5;
  });
  const best = sorted[0];
  const c = parseCard(best);
  /* 万能牌：选一个自己手里最多的颜色 */
  let chosen = null;
  if (c.color === WILD) {
    chosen = pickColor(hand);
  }
  return { id: best, color: chosen };
}

/** 手牌里某个颜色的张数（UI 显示用）。 */
export function countColor(hand, color) {
  let n = 0;
  for (const id of hand) if (parseCard(id).color === color) n++;
  return n;
}
