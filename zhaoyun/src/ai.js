/* =============================================================================
 * 赵云与阿斗 · AI（塔防策略）(ai.js)  — V4
 * 竞技 / 无尽通用：征兵 → 火球清团 → 神兵符 → 喂塔合成 → 铲子扩塔位 → 凑武将 → 建塔 → 毛笔
 * 每 0.5 秒决策一次；thinkSide(state, side) 侧别无关，双方同规则
 * ========================================================================== */
(function (ZY) {
  'use strict';

  const B = ZY.B;
  const C = ZY.C;
  const U = ZY.UNITS;

  function S(state, side) { return side === 'player' ? state.player : state.enemy; }
  function canPlace(state, side, r, c) { return B.canPlace(state, side, r, c); }
  function ownTowers(state, side) {
    return state.units.filter(function (u) { return !u.dead && u.side === side; });
  }
  function ownSlotCount(state, side) {
    let n = 0;
    Object.keys(state.deploy).forEach(function (k) { if (state.deploy[k] === side) n++; });
    return n;
  }

  /** 火球：自己路上有 ≥3 个敌人聚在同一个 3×3 里 → 砸下去 */
  function tryFireball(state, side) {
    const s = S(state, side);
    const i = s.hand.findIndex(function (x) { return x.kind === 'item' && x.item === 'fireball'; });
    if (i < 0) return false;
    const foes = state.units.filter(function (u) { return !u.dead && u.side === 'enemy' && u.target === side; });
    if (foes.length < 3) return false;
    const seq = B.pathSeq(state.mode, side);
    let best = null, bestHit = 2;
    for (let p = 0; p < seq.length; p++) {
      const cell = seq[p];
      let hit = 0;
      for (let f = 0; f < foes.length; f++) {
        if (Math.max(Math.abs(foes[f].row - cell.row), Math.abs(foes[f].col - cell.col)) <= C.FIREBALL_RADIUS) hit++;
      }
      if (hit > bestHit) { bestHit = hit; best = cell; }
    }
    if (!best) return false;
    if (ZY.Game.useFireball(state, side, best.row, best.col).ok) { s.hand.splice(i, 1); return true; }
    return false;
  }

  /** 神兵符：塔够多且当前没有 buff → 挂上 */
  function tryWarcry(state, side) {
    const s = S(state, side);
    const i = s.hand.findIndex(function (x) { return x.kind === 'item' && x.item === 'warcry'; });
    if (i < 0 || state.buff[side] > 0) return false;
    if (ownTowers(state, side).length < 4) return false;
    if (Math.random() < 0.5) {
      ZY.Game.useWarcry(state, side);
      s.hand.splice(i, 1);
      return true;
    }
    return false;
  }

  /** 喂塔合成：同字塔（未满级）← 手牌卡，优先喂等级低的（均衡成长） */
  function tryFeed(state, side) {
    const s = S(state, side);
    const towers = ownTowers(state, side);
    if (towers.length < 4) return false;            // 早期优先铺开
    for (let i = 0; i < s.hand.length; i++) {
      const card = s.hand[i];
      if (card.kind !== 'unit') continue;
      let best = null;
      for (let t = 0; t < towers.length; t++) {
        const u = towers[t];
        if (u.cls !== 'soldier' || u.type !== card.type || u.level >= C.MAX_LEVEL) continue;
        if (!best || u.level < best.level) best = u;
      }
      if (best) return !!ZY.Game.deploy(state, side, card.uid, best.row, best.col).ok;
    }
    return false;
  }

  /** 铲子扩塔位：塔位占用率高时，扩覆盖最好的相邻荒地 */
  function tryShovel(state, side) {
    const s = S(state, side);
    const i = s.hand.findIndex(function (x) { return x.kind === 'item' && x.item === 'shovel' });
    if (i < 0) return false;
    const spots = B.shovelSpots(state, side);
    if (!spots.length) return false;
    const slots = ownSlotCount(state, side);
    const towers = ownTowers(state, side).length;
    if (towers < slots - 1) return false;           // 还有空塔位，先建塔
    let best = null, bestScore = -Infinity;
    for (let p = 0; p < spots.length; p++) {
      const sp = spots[p];
      const score = B.coverCount(state.mode, side, sp.row, sp.col, 2) + Math.random();
      if (score > bestScore) { bestScore = score; best = sp; }
    }
    if (!best) return false;
    if (ZY.Game.useShovel(state, side, best.row, best.col).ok) { s.hand.splice(i, 1); return true; }
    return false;
  }

  /** 建塔：选覆盖主路最多（切比雪夫 2）的空塔位 */
  function tryBuild(state, side) {
    const s = S(state, side);
    let idx = -1;
    for (let i = 0; i < s.hand.length; i++) {
      if (s.hand[i].kind === 'unit' || s.hand[i].kind === 'gold') { idx = i; break; }
    }
    if (idx < 0) return false;
    const card = s.hand[idx];
    let best = null, bestScore = -Infinity;
    Object.keys(state.deploy).forEach(function (k) {
      if (state.deploy[k] !== side) return;
      const p = k.split(',');
      const r = +p[0], c = +p[1];
      if (!canPlace(state, side, r, c)) return;
      const score = B.coverCount(state.mode, side, r, c, 2) + Math.random() * 1.2;
      if (score > bestScore) { bestScore = score; best = { row: r, col: c }; }
    });
    if (!best) return false;
    return !!ZY.Game.deploy(state, side, card.uid, best.row, best.col).ok;
  }

  /** 凑武将：手里的金字接到棋盘金字塔旁 / 两张成对一起放下 */
  function tryHero(state, side) {
    const s = S(state, side);
    const hand = s.hand;
    const goldIdx = hand.findIndex(function (x) { return x.kind === 'gold'; });
    if (goldIdx < 0) return false;
    const g = hand[goldIdx].char;

    // ① 棋盘上已有另一半 → 补到它左边 / 右边
    for (let i = 0; i < ZY.HEROES.length && !state.over; i++) {
      const h = ZY.HEROES[i];
      for (let t = 0; t < state.units.length; t++) {
        const u = state.units[t];
        if (u.dead || u.side !== side || u.cls !== 'gold') continue;
        if (h.chars[0] === g && u.char === h.chars[1] && canPlace(state, side, u.row, u.col - 1)) {
          return !!ZY.Game.deploy(state, side, hand[goldIdx].uid, u.row, u.col - 1).ok;
        }
        if (h.chars[1] === g && u.char === h.chars[0] && canPlace(state, side, u.row, u.col + 1)) {
          return !!ZY.Game.deploy(state, side, hand[goldIdx].uid, u.row, u.col + 1).ok;
        }
      }
    }

    // ② 手里有两张能凑成武将名的金字 → 找一对相邻塔位一起放下
    for (let a = 0; a < hand.length; a++) {
      if (!hand[a] || hand[a].kind !== 'gold') continue;
      for (let b = 0; b < hand.length; b++) {
        if (a === b || !hand[b] || hand[b].kind !== 'gold') continue;
        const hero = ZY.HERO_BY_NAME[hand[a].char + hand[b].char];
        if (!hero) continue;
        const uidA = hand[a].uid, charB = hand[b].char;
        const keys = Object.keys(state.deploy).filter(function (k) { return state.deploy[k] === side; });
        for (let ki = 0; ki < keys.length; ki++) {
          const p = keys[ki].split(',');
          const r = +p[0], c = +p[1];
          if (canPlace(state, side, r, c) && canPlace(state, side, r, c + 1)) {
            if (ZY.Game.deploy(state, side, uidA, r, c).ok) {
              const rest = S(state, side).hand;
              for (let i = 0; i < rest.length; i++) {
                if (rest[i].kind === 'gold' && rest[i].char === charB) {
                  ZY.Game.deploy(state, side, rest[i].uid, r, c + 1);
                  break;
                }
              }
            }
            return true;
          }
        }
      }
    }

  // ③ 先手摆一个：挑「按将名字序凑得对」的塔位（左件右边有空间 / 右件左边有空间优先）
  const goldCount = hand.filter(function (x) { return x.kind === 'gold'; }).length;
  if (goldCount < 2 && hand.length < 3) return false;
  let best = null, bestScore = -1;
  Object.keys(state.deploy).forEach(function (k) {
    if (state.deploy[k] !== side) return;
    const p = k.split(',');
    const r = +p[0], c = +p[1];
    if (!canPlace(state, side, r, c)) return;
    let score = 0;
    ZY.HEROES.forEach(function (h) {
      if (h.chars[0] === g && canPlace(state, side, r, c + 1)) score += 4;   // 本字是左件 → 右侧要接得上
      if (h.chars[1] === g && canPlace(state, side, r, c - 1)) score += 4;   // 本字是右件 → 左侧要接得上
    });
    if (canPlace(state, side, r, c + 1)) score += 1;
    if (canPlace(state, side, r, c - 1)) score += 1;
    const rt = c + 1 < B.COLS ? state.grid[r][c + 1] : null;
    const lf = c - 1 >= 0 ? state.grid[r][c - 1] : null;
    if (rt && rt.side === side && rt.cls === 'gold') score += 3;
    if (lf && lf.side === side && lf.cls === 'gold') score += 1;
    score += Math.random();
    if (score > bestScore) { bestScore = score; best = { row: r, col: c }; }
  });
    if (!best) return false;
    return !!ZY.Game.deploy(state, side, hand[goldIdx].uid, best.row, best.col).ok;
  }

  /** 毛笔：手牌将满时随机改写一座兵种塔 */
  function tryBrush(state, side) {
    const s = S(state, side);
    const i = s.hand.findIndex(function (x) { return x.kind === 'item' && x.item === 'brush'; });
    if (i < 0 || s.hand.length < C.HAND_MAX - 1) return false;
    if (Math.random() > 0.4) return false;
    const own = ownTowers(state, side).filter(function (u) {
      return u.cls === 'soldier' && u.type !== 'nong';
    });
    if (!own.length) return false;
    const t = own[Math.floor(Math.random() * own.length)];
    if (ZY.Game.useBrush(state, side, t.id).ok) { s.hand.splice(i, 1); return true; }
    return false;
  }

  /** 每 0.5 秒调用一次。侧别无关：双方同规则（成本递增征兵、击杀赏金经济） */
  function thinkSide(state, side) {
    if (state.over || state.paused) return;
    const s = S(state, side);

    // 1) 征兵（成本递增：按本侧 recruitCost）
    if (s.bun >= s.recruitCost && s.hand.length < C.HAND_MAX && Math.random() < 0.95) {
      ZY.Game.recruit(state, side);
    }
    // 2) 火球清团（自己路上的聚团敌人）
    if (tryFireball(state, side)) return;
    // 3) 神兵符
    if (tryWarcry(state, side)) return;
    // 4) 喂塔合成（塔少时优先铺开，由 tryFeed 内部控制）
    if (tryFeed(state, side)) return;
    // 5) 铲子扩塔位
    if (tryShovel(state, side)) return;
    // 6) 凑武将（金字优先凑将，别被当普通塔建掉）
    if (tryHero(state, side)) return;
    // 7) 建塔
    if (tryBuild(state, side)) return;
    // 8) 毛笔
    tryBrush(state, side);
  }

  function think(state) {
    thinkSide(state, 'enemy');
  }

  ZY.AI = { think: think, thinkSide: thinkSide };
})(window.ZY);
