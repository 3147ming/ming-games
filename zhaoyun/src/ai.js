/* =============================================================================
 * 赵云与阿斗 · AI（竞技模式上半区对手）(ai.js)  — V2
 * 与玩家同规则：成本递增征兵、击杀赏金经济、铲子扩地、分兵线布阵
 * 每 0.5 秒决策一次
 * ========================================================================== */
(function (ZY) {
  'use strict';

  const B = ZY.B;
  const C = ZY.C;
  const U = ZY.UNITS;

  // 敌方半区 row 0-5，阿斗在 row 0。「前排」= row 5（最靠近中线 / 玩家方向）
  // 行序号越大越靠前（对敌方而言）。
  // 各兵种偏好行（按策略优先级排序）：
  //   front(刀)/flank(骑) → 最靠前，堵在兵线前排
  //   mid(枪)            → 中排，二线输出
  //   back(弓)           → 后排，靠近己方阿斗远程
  //   nong(农)           → 核心 3×3，种田
  const ROLE_ROWS = {
    front: [5, 4, 3, 2],
    flank: [5, 4, 3, 2],
    mid:   [3, 2, 4, 1],
    back:  [1, 2, 0, 3],
    core:  [1, 2, 0],
  };

  // 各兵种偏好占用的兵线列
  const LANE = B.LANES;
  function roleCols(role) {
    switch (role) {
      case 'front': return LANE.left.concat(LANE.right);   // 刀走左右路
      case 'flank': return LANE.left.concat(LANE.right);   // 骑走左右路
      case 'mid':   return LANE.mid.slice();              // 枪走中路
      case 'back':  return LANE.mid.concat([2, 5]);        // 弓靠近中路 / 二线
      default:      return [2, 3, 4];
    }
  }

  function E(state) { return state.enemy; }
  function canPlace(state, r, c) { return B.canPlace(state, 'enemy', r, c); }

  /** 选一个落点：综合「兵种偏好列 / 越靠前越优先 / 该列玩家威胁 / 合成优先」打分 */
  function pickCell(state, rows, card) {
    const role = (card && card.type && U[card.type]) ? U[card.type].role : 'core';
    const pref = roleCols(role);
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      for (let c = 0; c < B.COLS; c++) {
        if (!canPlace(state, r, c)) continue;
        let score = Math.random() * 1.5;
        if (pref.indexOf(c) >= 0) score += 2.6;          // 偏好兵线列
        score += r * 0.18;                                // 越靠前（row 大）越优先
        // 该列我方单位数 → 避免把兵全堆在同一列
        let own = 0, threat = false, twin = false;
        for (let rr = B.ENEMY_TOP; rr <= B.ENEMY_BOTTOM; rr++) {
          const t = state.grid[rr][c];
          if (!t || t.side !== 'enemy') continue;
          own++;
          if (card && t.cls === 'soldier' && t.type === card.type && t.level === (card.level || 1)) twin = true;
        }
        for (let rr = B.PLAYER_BOTTOM; rr >= B.PLAYER_TOP; rr--) {
          const t = state.grid[rr][c];
          if (t && t.side === 'player') { threat = true; break; }
        }
        score += threat ? 3.0 : 1.4;   // 有玩家推过来 → 重点堵；空列 → 直接推过去
        score -= own * 0.9;
        if (twin) score += 3.2;        // 合成优先于铺开
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
        const uidA = hand[a].uid, charB = hand[b].char;
        for (let r = B.ENEMY_TOP; r <= B.ENEMY_BOTTOM; r++) {
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

    // ③ 先手摆一个：挑「左右都还放得下」的位置
    const goldCount = hand.filter(function (x) { return x.kind === 'gold'; }).length;
    if (goldCount < 2 && hand.length < 3) return false;
    let best = null, bestScore = -1;
    for (let r = B.ENEMY_TOP + 1; r <= B.ENEMY_BOTTOM; r++) {
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

  /** 铲子优先：扩「最靠前（玩家方向）且与部署地相邻的荒地兵线格」 */
  function tryShovel(state) {
    const s = E(state);
    const shovel = s.hand.findIndex(function (x) { return x.kind === 'item' && x.item === 'shovel'; });
    if (shovel < 0) return false;
    const cell = B.frontWasteland(state, 'enemy');
    if (!cell) return false;
    if (ZY.Game.useShovel(state, 'enemy', cell.row, cell.col).ok) {
      s.hand.splice(shovel, 1);
      return true;
    }
    return false;
  }

  /** 布阵：按兵种定位放一张牌 */
  function tryPlace(state) {
    const hand = E(state).hand;
    if (!hand.length) return false;
    // 先放农民（核心区种田），再放兵
    let idx = hand.findIndex(function (x) { return x.kind === 'unit' && x.type === 'nong'; });
    if (idx < 0) idx = hand.findIndex(function (x) { return x.kind === 'unit'; });
    if (idx < 0) idx = hand.findIndex(function (x) { return x.kind === 'gold'; });
    if (idx < 0) return false;
    const card = hand[idx];
    const role = card.kind === 'unit' ? U[card.type].role : 'core';
    const rows = ROLE_ROWS[role] || [2, 1, 3];
    const spot = pickCell(state, rows, card);
    if (!spot) return false;
    return !!ZY.Game.deploy(state, 'enemy', card.uid, spot.row, spot.col).ok;
  }

  /** 道具：神兵符 / 毛笔 */
  function tryItems(state) {
    const s = E(state);
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

  /** 每 0.5 秒调用一次。与玩家同规则：成本递增征兵、击杀赏金经济 */
  function think(state) {
    if (state.over || state.paused) return;
    const s = E(state);

    // 1) 征兵（成本递增：按本侧 recruitCost）
    if (s.bun >= s.recruitCost && s.hand.length < C.HAND_MAX && Math.random() < 0.95) {
      ZY.Game.recruit(state, 'enemy');
    }
    // 2) 铲子优先：把前线荒地扩成部署地（早期频繁扩，越往后越省）
    if (Math.random() < 0.7 && tryShovel(state)) return;
    // 3) 凑武将（最高优先级）
    if (tryHero(state)) return;
    // 4) 合成
    if (Math.random() < 0.9 && tryMerge(state)) return;
    // 5) 布阵
    if (Math.random() < 0.9 && tryPlace(state)) return;
    // 6) 其余道具
    tryItems(state);
  }

  ZY.AI = { think: think };
})(window.ZY);
