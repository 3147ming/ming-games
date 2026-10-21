/* =============================================================================
 * 赵云与阿斗 · AI（塔防策略）(ai.js)  — V5 原版对齐
 * 竞技 / 无尽通用：征兵 → 军营转手牌 → 火球清团 → 神兵符 → 武将字对合成 →
 * 喂塔合成 → 铲子扩塔位 → 建塔（武将卡占 2 格）→ 毛笔
 * 每 0.5 秒决策一次；thinkSide(state, side) 侧别无关，双方同规则
 * ========================================================================== */
(function (ZY) {
  'use strict';

  const B = ZY.B;
  const C = ZY.C;
  const U = ZY.UNITS;

  function S(state, side) { return side === 'player' ? state.player : state.enemy; }
  function canPlace(state, side, r, c, span) { return B.canPlace(state, side, r, c, span); }
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
    const seq = B.pathSeq(state.mode, side, state.levelIdx);
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

  /** V5 武将字对合成：手里凑齐一对 → 合成武将卡（2 格宽）
   *  V6：先做「同名武将卡升星」（2 合 1，净腾 2 格手牌），再做字对合成 */
  function trySynth(state, side) {
    const s = S(state, side);
    if (ZY.heroStarReady(state, side) && ZY.Game.synthHeroStar(state, side)) return true;
    if (!ZY.heroSynthReady(state, side)) return false;
    // 手牌放不下 2 格武将卡时，先腾位（交给 stage 逻辑自然流转）
    if (ZY.handUsed(s) > C.HAND_MAX - 2) return false;
    return !!ZY.Game.synthHero(state, side);
  }

  /** V8 喂塔合成：手牌兵种卡只喂「同兵种 1 级」塔 → 升 2 级 */
  function tryFeed(state, side) {
    const s = S(state, side);
    const towers = ownTowers(state, side);
    if (towers.length < 4) return false;            // 早期优先铺开
    for (let i = 0; i < s.hand.length; i++) {
      const card = s.hand[i];
      if (card.kind !== 'unit') continue;
      const best = towers.find(function (u) { return u.cls === 'soldier' && u.type === card.type && u.level === 1; });
      if (best) return !!ZY.Game.deploy(state, side, card.uid, best.row, best.col).ok;
    }
    return false;
  }

  /** V8 塔塔合成：存在同兵种、同等级的己方兵种塔一对（均未满级）→ 优先合并（均衡升主塔，不牺牲防线） */
  function tryTowerMerge(state, side) {
    const towers = ownTowers(state, side).filter(function (u) { return u.cls === 'soldier' && u.level < C.MAX_LEVEL; });
    const seen = {};
    for (let i = 0; i < towers.length; i++) {
      const u = towers[i];
      const key = u.type + ':' + u.level;
      const target = seen[key];
      if (target) {
        if (ZY.Game.mergeTower(state, side, u.id, target.row, target.col).ok) return true;
      } else {
        seen[key] = u;
      }
    }
    return false;
  }

  /** 铲子扩塔位（道具栏计数）：塔位占用率高时，扩覆盖最好的相邻荒地 */
  function tryShovel(state, side) {
    const s = S(state, side);
    if (!s.items || s.items.shovel <= 0) return false;
    const spots = B.shovelSpots(state, side);
    if (!spots.length) return false;
    const slots = ownSlotCount(state, side);
    const towers = ownTowers(state, side).length;
    if (towers < slots - 1) return false;           // 还有空塔位，先建塔
    let best = null, bestScore = -Infinity;
    for (let p = 0; p < spots.length; p++) {
      const sp = spots[p];
      const score = B.coverCount(state.mode, side, sp.row, sp.col, 2, state.levelIdx) + Math.random();
      if (score > bestScore) { bestScore = score; best = sp; }
    }
    if (!best) return false;
    return !!ZY.Game.useShovel(state, side, best.row, best.col).ok;
  }

  /** 建塔：选覆盖主路最多（切比雪夫 2）的空塔位；武将卡需要左右相邻两格 */
  function tryBuild(state, side) {
    const s = S(state, side);
    let idx = -1;
    for (let i = 0; i < s.hand.length; i++) {
      if (s.hand[i].kind === 'unit' || s.hand[i].kind === 'hero') { idx = i; break; }
    }
    if (idx < 0) return false;
    const card = s.hand[idx];
    const span = ZY.cardSpan(card);
    let best = null, bestScore = -Infinity;
    Object.keys(state.deploy).forEach(function (k) {
      if (state.deploy[k] !== side) return;
      const p = k.split(',');
      const r = +p[0], c = +p[1];
      if (!canPlace(state, side, r, c, span)) return;
      const score = B.coverCount(state.mode, side, r, c, 2, state.levelIdx) + Math.random() * 1.2;
      if (score > bestScore) { bestScore = score; best = { row: r, col: c }; }
    });
    if (!best) return false;
    return !!ZY.Game.deploy(state, side, card.uid, best.row, best.col).ok;
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

  /** V5 军营 → 手牌：每次决策转 1~2 张（手牌 8 格，武将卡占 2 格） */
  function tryStage(state, side) {
    const s = S(state, side);
    const barracks = s.barracks || [];
    if (!barracks.length) return false;
    let moved = 0;
    for (let i = 0; i < barracks.length && moved < 2; i++) {
      if (ZY.Game.stageCard(state, side, barracks[i].uid)) moved++;
    }
    return moved > 0;
  }

  /** 每 0.5 秒调用一次。侧别无关：双方同规则（成本递增征兵、击杀赏金经济） */
  function thinkSide(state, side) {
    if (state.over || state.paused) return;
    const s = S(state, side);

    // 1) 征兵（成本 10+2n 不封顶；一次 5 张进军营）
    if (s.bun >= s.recruitCost && (s.barracks || []).length < C.BARRACKS_MAX && Math.random() < 0.95) {
      ZY.Game.recruit(state, side);
    }
    // 2) 军营转手牌（先有牌才能干活）
    tryStage(state, side);
    // 3) 火球清团（自己路上的聚团敌人）
    if (tryFireball(state, side)) return;
    // 4) 神兵符
    if (tryWarcry(state, side)) return;
    // 5) 武将字对合成（凑齐就合，别让金字烂在手里）
    if (trySynth(state, side)) return;
    // 5.5) V8 塔塔合成（同兵种同级两塔优先合并，均衡升主塔）
    if (tryTowerMerge(state, side)) return;
    // 6) 喂塔合成（塔少时优先铺开，由 tryFeed 内部控制）
    if (tryFeed(state, side)) return;
    // 7) 铲子扩塔位
    if (tryShovel(state, side)) return;
    // 8) 建塔（含武将卡 2 格）
    if (tryBuild(state, side)) return;
    // 9) 毛笔
    tryBrush(state, side);
  }

  function think(state) {
    thinkSide(state, 'enemy');
  }

  ZY.AI = { think: think, thinkSide: thinkSide };
})(window.ZY);
