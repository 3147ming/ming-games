/* =============================================================================
 * 赵云与阿斗 · AI（竞技模式上半区对手）(ai.js)
 * 简单贪心 + 随机扰动；每 0.5 秒决策一次
 * ========================================================================== */
(function (ZY) {
  'use strict';

  const B = ZY.B;
  const C = ZY.C;
  const U = ZY.UNITS;

  // AI 半区是 row 0-5，阿斗在 row 0，所以「前排」= row 5（靠近中线）
  const ROLE_ROWS = {
    front: [5, 4, 3],
    flank: [5, 4, 3],
    mid:   [4, 3, 2],
    back:  [2, 1, 3],
  };

  function E(state) { return state.enemy; }

  function canPlace(state, r, c) { return B.canPlace(state, 'enemy', r, c); }

  /** 选一个落点：玩家压过来的列要堵，空列要抢（底线整行都是宫门，空列能直取） */
  function pickCell(state, rows, card) {
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      for (let c = 0; c < B.COLS; c++) {
        if (!canPlace(state, r, c)) continue;
        let score = Math.random() * 2;
        // 该列我方单位数 → 避免把兵全堆在同一列
        let own = 0, threat = false, twin = false;
        for (let rr = B.ENEMY_TOP; rr <= B.ENEMY_BOTTOM; rr++) {
          const t = state.grid[rr][c];
          if (!t || t.side !== 'enemy') continue;
          own++;
          // 同字同级已在场 → 落这一列下一拍就能合成，优先
          if (card && t.cls === 'soldier' && t.type === card.type && t.level === (card.level || 1)) twin = true;
        }
        for (let rr = B.PLAYER_BOTTOM; rr >= B.PLAYER_TOP; rr--) {
          const t = state.grid[rr][c];
          if (t && t.side === 'player') { threat = true; break; }
        }
        score += threat ? 3.0 : 1.8;   // 有玩家推过来 → 重点堵；空列 → 直接推过去
        score -= own * 0.9;
        if (twin) score += 3.5;        // 合成优先于铺开
        if (score > bestScore) { bestScore = score; best = { row: r, col: c }; }
      }
    }
    return best;
  }

  /** 合成：找同字同级的两个，结果落在更靠前排（row 更大）的那格 */
  function tryMerge(state) {
    const groups = {};
    state.units.forEach(function (u) {
      if (u.dead || u.side !== 'enemy' || u.cls !== 'soldier') return;
      if (u.level >= C.MAX_LEVEL) return;
      const k = u.type + '#' + u.level;
      (groups[k] = groups[k] || []).push(u);
    });
    const keys = Object.keys(groups).filter(function (k) { return groups[k].length >= 2; });
    if (!keys.length) return false;
    // 非农民优先
    keys.sort(function (a, b) {
      const an = groups[a][0].type === 'nong' ? 1 : 0;
      const bn = groups[b][0].type === 'nong' ? 1 : 0;
      return an - bn;
    });
    const arr = groups[keys[0]].slice().sort(function (a, b) { return b.row - a.row; });
    const dst = arr[0], src = arr[1];
    return !!ZY.Game.dropUnitOn(state, 'enemy', src.id, dst.row, dst.col).ok;
  }

  /** 凑武将：手里的金字能不能接到棋盘上已有的金字旁边 */
  function tryHero(state) {
    const hand = E(state).hand;
    const goldIdx = hand.findIndex(function (x) { return x.kind === 'gold'; });
    if (goldIdx < 0) return false;
    const g = hand[goldIdx].char;

    // ① 棋盘上已有另一半 → 补到它左边 / 右边
    for (let i = 0; i < ZY.HEROES.length; i++) {
      const h = ZY.HEROES[i];
      for (let r = B.ENEMY_TOP; r <= B.ENEMY_BOTTOM; r++) {
        for (let c = 0; c < B.COLS; c++) {
          const t = state.grid[r][c];
          if (!t || t.side !== 'enemy' || t.cls !== 'gold' || t.dead) continue;
          if (h.chars[0] === g && t.char === h.chars[1] && canPlace(state, r, c - 1)) {
            return !!ZY.Game.deploy(state, 'enemy', hand[goldIdx].uid, r, c - 1).ok;
          }
          if (h.chars[1] === g && t.char === h.chars[0] && canPlace(state, r, c + 1)) {
            return !!ZY.Game.deploy(state, 'enemy', hand[goldIdx].uid, r, c + 1).ok;
          }
        }
      }
    }

    // ② 手里有两张能凑成武将名的金字 → 找一对相邻空格一起放下
    for (let a = 0; a < hand.length; a++) {
      if (!hand[a] || hand[a].kind !== 'gold') continue;
      for (let b = 0; b < hand.length; b++) {
        if (a === b || !hand[b] || hand[b].kind !== 'gold') continue;
        const hero = ZY.HERO_BY_NAME[hand[a].char + hand[b].char];
        if (!hero) continue;
        // 先记下 uid / 字，deploy 会 splice 手牌，不能再按下标取
        const uidA = hand[a].uid, charB = hand[b].char;
        for (let r = 2; r <= 5; r++) {
          for (let c = 0; c < B.COLS - 1; c++) {
            if (canPlace(state, r, c) && canPlace(state, r, c + 1)) {
              if (ZY.Game.deploy(state, 'enemy', uidA, r, c).ok) {
                const rest = E(state).hand;
                for (let i = 0; i < rest.length; i++) {
                  if (rest[i].kind === 'gold' && rest[i].char === charB) {
                    ZY.Game.deploy(state, 'enemy', rest[i].uid, r, c + 1);
                    break;
                  }
                }
              }
              return true;
            }
          }
        }
      }
    }

    // ③ 先手摆一个：挑「左右都还放得下」的位置，并且尽量挨着已有的单字，
    //    这样下一张金字不管是大名还是小名都有机会接上去。
    const goldCount = hand.filter(function (x) { return x.kind === 'gold'; }).length;
    if (goldCount < 2 && hand.length < 3) return false; // 先攒着，等能配对
    let best = null, bestScore = -1;
    for (let r = 1; r <= 4; r++) {
      for (let c = 0; c < B.COLS; c++) {
        if (!canPlace(state, r, c)) continue;
        let score = 0;
        if (canPlace(state, r, c + 1)) score += 2;
        if (canPlace(state, r, c - 1)) score += 2;
        const rt = c + 1 < B.COLS ? state.grid[r][c + 1] : null;
        const lf = c - 1 >= 0 ? state.grid[r][c - 1] : null;
        if (rt && rt.side === 'enemy' && rt.cls === 'gold') score += 3;
        if (lf && lf.side === 'enemy' && lf.cls === 'gold') score += 1;
        score += Math.random();
        if (score > bestScore) { bestScore = score; best = { row: r, col: c }; }
      }
    }
    if (!best) return false;
    return !!ZY.Game.deploy(state, 'enemy', hand[goldIdx].uid, best.row, best.col).ok;
  }

  /** 布阵：按兵种定位放一张牌 */
  function tryPlace(state) {
    const hand = E(state).hand;
    if (!hand.length) return false;
    // 先放农民，再放兵
    let idx = hand.findIndex(function (x) { return x.kind === 'unit' && x.type === 'nong'; });
    if (idx < 0) idx = hand.findIndex(function (x) { return x.kind === 'unit'; });
    if (idx < 0) return false;
    const card = hand[idx];
    const rows = ROLE_ROWS[U[card.type].role] || [4, 3, 2];
    const spot = pickCell(state, card.type === 'nong' ? [1, 2] : rows, card);
    if (!spot) return false;
    return !!ZY.Game.deploy(state, 'enemy', card.uid, spot.row, spot.col).ok;
  }

  /** 道具 */
  function tryItems(state) {
    const s = E(state);
    const shovel = s.hand.findIndex(function (x) { return x.kind === 'item' && x.item === 'shovel'; });
    if (shovel >= 0) {
      const keys = Object.keys(state.locked).filter(function (k) {
        const r = parseInt(k.split(',')[0], 10);
        return B.isOwnRow('enemy', r);
      });
      if (keys.length && Math.random() < 0.6) {
        const k = keys[Math.floor(Math.random() * keys.length)];
        const p = k.split(',');
        if (ZY.Game.useShovel(state, 'enemy', parseInt(p[0], 10), parseInt(p[1], 10)).ok) {
          s.hand.splice(shovel, 1);
          return true;
        }
      }
    }
    const warcry = s.hand.findIndex(function (x) { return x.kind === 'item' && x.item === 'warcry'; });
    if (warcry >= 0 && state.buff.enemy <= 0) {
      const own = state.units.filter(function (u) { return u.side === 'enemy' && !u.dead; }).length;
      if (own >= 5 && Math.random() < 0.5) {
        ZY.Game.useWarcry(state, 'enemy');
        s.hand.splice(warcry, 1);
        return true;
      }
    }
    const brush = s.hand.findIndex(function (x) { return x.kind === 'item' && x.item === 'brush'; });
    if (brush >= 0 && s.hand.length >= C.HAND_MAX - 1 && Math.random() < 0.4) {
      const own = state.units.filter(function (u) {
        return u.side === 'enemy' && u.cls === 'soldier' && u.type !== 'nong' && !u.dead;
      });
      if (own.length) {
        const t = own[Math.floor(Math.random() * own.length)];
        if (ZY.Game.useBrush(state, 'enemy', t.id).ok) {
          s.hand.splice(brush, 1);
          return true;
        }
      }
    }
    return false;
  }

  /** 每 0.5 秒调用一次 */
  function think(state) {
    if (state.over || state.paused) return;
    const s = E(state);

    // 1) 征兵
    if (s.bun >= C.RECRUIT_COST && s.hand.length < C.HAND_MAX && Math.random() < 0.95) {
      ZY.Game.recruit(state, 'enemy');
    }
    // 2) 凑武将（最高优先级）
    if (tryHero(state)) return;
    // 3) 合成
    if (tryMerge(state)) return;
    // 4) 布阵
    if (Math.random() < 0.9 && tryPlace(state)) return;
    // 5) 道具
    tryItems(state);
  }

  ZY.AI = { think: think };
})(window.ZY);
