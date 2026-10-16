/* =============================================================================
 * 赵云与阿斗 · 核心规则与主循环 (game.js)  — V4 塔防化
 * 只管状态与规则，不碰 DOM；UI 层负责渲染与输入
 * 敌人沿预计算主路序列逐格走（不攻击、目标是走到阿斗）；
 * 兵种塔固定在地块上自动攻击射程内「最靠前」的敌人；
 * 合成 = 拖手牌卡到同字塔上 +1 级；道具全部拖放释放（新增火球）。
 * ========================================================================== */
(function (ZY) {
  'use strict';

  const B = ZY.B;
  const C = ZY.C;
  const U = ZY.UNITS;
  const TICK = 0.1;               // 固定逻辑步长：10 tick / 秒
  const SPAWN_GAP = 0.35;         // 波次内逐个出兵间隔（突破口处会被缩短）
  const BREAK_W = 0.5;            // 突破口额外出怪权重（原三兵线中路权重）

  /* ---------------------------------------------------------------- 工具 */
  function sideState(state, side) { return side === 'player' ? state.player : state.enemy; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function num(v, def) { return (typeof v === 'number' && isFinite(v)) ? v : def; }
  function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; }

  /* ------------------------------------------------------------ 单位构造 */
  function makeUnit(state, side, spec) {
    const u = {
      id: state.nextId++, side: side,
      cls: spec.boss ? 'soldier' : (spec.cls || 'soldier'),
      type: spec.type || null, char: spec.char || null,
      heroId: spec.heroId || null, heroLevel: spec.heroLevel || 1,
      level: spec.level || 1, boss: !!spec.boss,
      row: spec.row, col: spec.col,
      hp: 0, maxHp: 0, atk: 0, aspd: 0, range: 1, move: 1,
      pierce: false, splash: 0, crit: 0, critMul: 1,
      dmgReduce: 0, noAttack: false, produce: 0,
      atkT: 0, moveT: 0, stun: 0,
      kills: 0, skillCd: 0, skillT: 0,
      elite: !!spec.elite, dead: false,
      /* V4 塔防：行军敌人专属 —— target=冲谁来的（哪侧阿斗），path=主路序列，pi=走到第几格
       * 塔（含武将塔）不行军：deploy/checkHeroes 显式传 target:null */
      target: spec.target !== undefined ? spec.target : (side === 'enemy' ? 'player' : null),
      path: spec.path || null, pi: spec.pi || 0,
    };
    if (side === 'enemy' && u.target && !u.path) {
      u.path = B.pathSeq(state.mode, u.target);
      if (spec.pi == null) u.pi = 0;          // 调用方显式给了 pi（如从半路放置）则尊重之
    }

    if (u.boss) {
      const bo = ZY.BOSS;
      const hpMul = num(spec.hpMul, 1) * bo.hpMul;
      const atkMul = num(spec.atkMul, 1) * bo.atkMul;
      u.char = bo.char; u.maxHp = bo.hp * hpMul; u.hp = u.maxHp;
      u.atk = bo.atk * atkMul; u.aspd = bo.aspd; u.range = bo.range; u.move = bo.move;
      u.skillCd = bo.skillCd; u.skillT = bo.skillCd;   // 出场先攒一次冷却
    } else if (u.cls === 'hero') {
      const h = ZY.HERO_BY_ID[u.heroId];
      const st = ZY.heroStats(u.heroId, u.heroLevel);
      u.char = h.name;
      u.maxHp = st.hp; u.hp = st.hp;
      u.atk = st.atk; u.aspd = st.aspd; u.range = st.range; u.move = st.move;
      u.pierce = st.pierce; u.splash = st.splash;
      u.crit = st.crit; u.critMul = st.critMul; u.dmgReduce = st.dmgReduce;
      u.noAttack = st.noAttack;
      u.skillCd = h.skill.cd; u.skillT = h.skill.cd;
    } else if (u.cls === 'gold') {
      u.maxHp = 30; u.hp = 30; u.atk = 0; u.aspd = 0; u.range = 0; u.move = 0;
    } else {
      if (!u.char && U[u.type]) u.char = U[u.type].char;
      const st = ZY.statsAt(u.type, u.level);
      const hpMul = num(spec.hpMul, 1), atkMul = num(spec.atkMul, 1);
      u.maxHp = st.hp * hpMul; u.hp = u.maxHp;
      u.atk = st.atk * atkMul;
      u.aspd = st.aspd; u.range = U[u.type].range; u.move = U[u.type].move;
      u.pierce = !!U[u.type].pierce; u.splash = U[u.type].splash || 0;
      u.produce = U[u.type].produce || 0;
      u.noAttack = u.atk <= 0;
    }

    // 击杀赏金：敌方行军单位才给赏金（塔不给对方送经济）
    if (u.boss) u.bounty = C.BOSS_BOUNTY;
    else if (u.side === 'enemy') u.bounty = (u.cls === 'hero') ? 6 : (u.elite ? C.ELITE_BOUNTY : C.NORMAL_BOUNTY);
    else u.bounty = 0;
    return u;
  }

  function addUnit(state, u) {
    state.grid[u.row][u.col] = u;
    state.units.push(u);
    return u;
  }

  function removeUnit(state, u, silent) {
    u.dead = true;
    if (state.grid[u.row] && state.grid[u.row][u.col] === u) state.grid[u.row][u.col] = null;
    if (!silent) state.fx.push({ type: 'die', row: u.row, col: u.col, big: (u.elite || u.boss) });
  }

  function restatUnit(state, u) {
    const ratio = u.maxHp > 0 ? clamp(u.hp / u.maxHp, 0, 1) : 1;
    if (u.cls === 'hero') {
      const st = ZY.heroStats(u.heroId, u.heroLevel);
      u.maxHp = st.hp; u.atk = st.atk; u.aspd = st.aspd; u.range = st.range; u.move = st.move;
      u.pierce = st.pierce; u.splash = st.splash;
      u.crit = st.crit; u.critMul = st.critMul; u.dmgReduce = st.dmgReduce;
      u.hp = u.maxHp;
    } else {
      const st = ZY.statsAt(u.type, u.level);
      u.maxHp = st.hp; u.atk = st.atk; u.aspd = st.aspd;
      u.hp = Math.max(1, u.maxHp * ratio);
    }
  }

  /* ------------------------------------------------------------ 伤害与死亡 */
  function hurt(state, src, tgt, amount) {
    if (!tgt || tgt.dead) return 0;
    let dmg = num(amount, 0);
    if (src && state.buff[src.side] > 0) dmg *= C.WARCRY_MULT;
    if (src && src.crit && Math.random() < src.crit) {
      dmg *= src.critMul;
      state.fx.push({ type: 'crit', row: tgt.row, col: tgt.col, text: '暴击' });
    }
    if (tgt.dmgReduce) dmg *= (1 - tgt.dmgReduce);
    dmg = Math.max(0, dmg);
    tgt.hp -= dmg;
    state.fx.push({ type: 'hit', row: tgt.row, col: tgt.col });
    state.fx.push({ type: 'dmg', row: tgt.row, col: tgt.col, text: Math.round(dmg) });
    if (src && src.side === 'player') ZY.Audio.play('attack');
    if (tgt.hp <= 0) killUnit(state, src, tgt);
    return dmg;
  }

  /** 固定伤害（火球）：不吃暴击 / 神兵符 / 减伤，但照常结算赏金 */
  function hurtFixed(state, side, tgt, amount) {
    if (!tgt || tgt.dead) return 0;
    tgt.hp -= amount;
    state.fx.push({ type: 'hit', row: tgt.row, col: tgt.col });
    state.fx.push({ type: 'dmg', row: tgt.row, col: tgt.col, text: Math.round(amount) });
    if (tgt.hp <= 0) killUnit(state, { side: side }, tgt);
    return amount;
  }

  /** 击杀入账（赏金 / 计数 / 飘字），killerSide 为凶手阵营 */
  function creditKill(state, killerSide, tgt) {
    const s = sideState(state, killerSide);
    if (!s) return;
    s.bun += tgt.bounty;
    s.kills++;
    state.fx.push({ type: 'bun', row: tgt.row, col: tgt.col, text: '+' + tgt.bounty });
    if (tgt.side === 'enemy' && tgt.target === 'player') state.stats.kills++;
    if (tgt.boss) { state.banner = { text: '强敌倒下', life: 2.2 }; state.fx.push({ type: 'shake' }); }
    if (tgt.elite) state.fx.push({ type: 'big', row: tgt.row, col: tgt.col, text: '精英倒下' });
  }

  function killUnit(state, src, tgt) {
    if (tgt.dead) return;
    const killerSide = src ? src.side : (tgt.side === 'player' ? 'enemy' : 'player');
    creditKill(state, killerSide, tgt);
    if (src && src.cls === 'hero') { src.kills++; tryHeroLevel(state, src); }
    else if (src && src.id != null) { src.kills++; }
    removeUnit(state, tgt);
    ZY.Audio.play('kill');
  }

  function tryHeroLevel(state, h) {
    if (h.heroLevel >= C.HERO_MAX_LEVEL) return;
    if (h.kills < C.HERO_KILLS_PER_LEVEL) return;
    h.kills -= C.HERO_KILLS_PER_LEVEL;
    h.heroLevel++;
    restatUnit(state, h);
    state.fx.push({ type: 'up', row: h.row, col: h.col, text: h.char + ' 升阶 ' + h.heroLevel });
    ZY.Audio.play('hero');
  }

  /* ------------------------------------------------------------ 阿斗受击 */
  /** 敌人踏入终点格（阿斗格）：掉 1 血 + 补偿馒头 + 该敌人消失 */
  function adouHit(state, side, unit) {
    const s = sideState(state, side);
    s.adou -= 1;
    s.bun += C.ADOU_BONUS;
    const a = B.adouAt(state.mode, side);
    state.fx.push({ type: 'adou', row: a.row, col: a.col, text: '阿斗 -1' });
    state.fx.push({ type: 'bun', row: a.row, col: a.col, text: '+' + C.ADOU_BONUS + ' 馒头' });
    state.fx.push({ type: 'shake' });
    state.fx.push({ type: 'redflash' });
    removeUnit(state, unit, true);
    ZY.Audio.play('adou');
    if (s.adou <= 0) {
      s.adou = 0;
      endGame(state, side === 'player' ? 'lose' : 'win');
    }
  }

  /* ------------------------------------------------------------ 技能 */
  function castSkill(state, u) {
    const h = ZY.HERO_BY_ID[u.heroId];
    if (!h) return false;
    const sk = h.skill;
    const list = B.threatsInRange(state, u, u.range || 3);
    if (!list.length && sk.type !== 'heal') return false;
    let fired = false;

    if (sk.type === 'sweep') {                       // 赵云：前方范围群伤
      const all = B.threatsInRange(state, u, 4);
      if (all.length) { all.forEach(function (t) { hurt(state, u, t, u.atk * 2); }); fired = true; }
    } else if (sk.type === 'roar') {                 // 张飞：震晕周围 1 格
      const near = B.threatsInRange(state, u, 1);
      if (near.length) {
        near.forEach(function (t) { t.stun = 1; state.fx.push({ type: 'stun', row: t.row, col: t.col, text: '晕' }); });
        fired = true;
      }
    } else if (sk.type === 'snipe') {                // 黄忠：最靠后（最远）敌人单体大伤
      const all = B.threatsInRange(state, u, 5);
      if (all.length) {
        const far = all[all.length - 1];
        hurt(state, u, far, u.atk * 3);
        state.fx.push({ type: 'beam', row: far.row, col: far.col });
        fired = true;
      }
    } else if (sk.type === 'cleave') {               // 关羽：周围溅射
      const near = B.threatsInRange(state, u, 1);
      if (near.length) {
        near.forEach(function (t) { hurt(state, u, t, u.atk * 2); });
        state.fx.push({ type: 'ring', row: u.row, col: u.col }); fired = true;
      }
    } else if (sk.type === 'heal') {                 // 刘备：相邻己方回血
      const near = B.neighbors(state, u.row, u.col, false);
      let healed = false;
      near.forEach(function (p) {
        const t = state.grid[p.row][p.col];
        if (t && t.side === u.side && !t.dead && t.hp < t.maxHp) {
          t.hp = Math.min(t.maxHp, t.hp + u.atk * 1.5);
          state.fx.push({ type: 'heal', row: t.row, col: t.col, text: '+' + Math.round(u.atk * 1.5) });
          healed = true;
        }
      });
      if (healed) fired = true;
    } else if (sk.type === 'leap') {                 // 张苞：跳劈单体
      const near = B.threatsInRange(state, u, 2);
      if (near.length) { hurt(state, u, near[0], u.atk * 2.5); fired = true; }
    }

    if (!fired) return false;
    u.skillT = sk.cd;
    state.banner = { text: h.name + ' · ' + sk.name, life: 1.5 };
    state.fx.push({ type: 'ring', row: u.row, col: u.col });
    state.fx.push({ type: 'shake' });
    ZY.Audio.play('skill');
    return true;
  }

  /** Boss 震击：对象 = 射程内守这条路的塔（u.target 侧） */
  function castBossSkill(state, u) {
    const near = B.neighbors(state, u.row, u.col, true);
    let hitAny = false;
    near.forEach(function (p) {
      const t = state.grid[p.row][p.col];
      if (t && !t.dead && t.side === u.target) { hurt(state, u, t, u.atk * 1.5); t.stun = Math.max(t.stun, C.BOSS_SLOW); hitAny = true; }
    });
    state.fx.push({ type: 'ring', row: u.row, col: u.col });
    state.fx.push({ type: 'shake' });
    state.fx.push({ type: 'redflash' });
    if (hitAny) state.banner = { text: '魔将 · 震击', life: 1.0 };
    ZY.Audio.play('skill');
  }

  /* ------------------------------------------------------------ 行军：沿主路逐格走 */
  function walkPath(state, u, dt) {
    if (u.move <= 0 || !u.path) return;
    u.moveT += dt;
    if (u.moveT < u.move) return;
    u.moveT = 0;
    const next = u.path[u.pi + 1];
    if (!next) return;                               // 已在终点（理论上进入终点即被移除）
    const adou = B.adouAt(state.mode, u.target);
    if (adou && next.row === adou.row && next.col === adou.col) {
      // 踏入阿斗格 → 破门
      state.grid[u.row][u.col] = null;
      u.row = next.row; u.col = next.col;
      u.pi++;
      adouHit(state, u.target, u);
      return;
    }
    if (!state.grid[next.row][next.col]) {
      state.grid[u.row][u.col] = null;
      u.row = next.row; u.col = next.col;
      u.pi++;
      state.grid[u.row][u.col] = u;
    }
  }

  /* ------------------------------------------------------------ 单 tick */
  function tick(state, dt) {
    if (state.over || state.paused) return;
    state.t += dt;
    state.stats.duration = state.t;

    // 1) 自然收入 + 农民产出
    ['player', 'enemy'].forEach(function (side) {
      const s = sideState(state, side);
      if (!s) return;
      // 竞技难度 = 敌方经济系数：easy(0.8)→×0.7 · normal(1.0)→×1.0 · hard(1.2)→×1.3
      let inc = (side === 'enemy' && state.mode === 'versus')
        ? C.BASE_INCOME * (1 + (num(state.difficulty, 1) - 1) * 1.5) : C.BASE_INCOME;
      if (state.mode !== 'versus' && side === 'enemy') return;
      s.bun += inc * dt;
    });
    for (let i = 0; i < state.units.length; i++) {
      const u = state.units[i];
      if (u.dead || !u.produce) continue;
      const s = sideState(state, u.side);
      if (s) s.bun += u.produce * u.level * dt;
    }

    // 2) 神兵符倒计时
    ['player', 'enemy'].forEach(function (side) {
      if (state.buff[side] > 0) { state.buff[side] -= dt; if (state.buff[side] <= 0) state.buff[side] = 0; }
    });

    // 3) 波次（全部模式跑波次机器；竞技 = 公共波次，镜像进入双方路）
    tickWaves(state, dt);

    // 4) 单位行动
    const list = state.units.slice();
    for (let i = 0; i < list.length; i++) {
      const u = list[i];
      if (u.dead) continue;
      if (u.stun > 0) { u.stun -= dt; continue; }
      if (u.skillCd > 0) {
        u.skillT -= dt;
        if (u.skillT <= 0) {
          if (u.boss) { castBossSkill(state, u); u.skillT = C.BOSS_SKILL_CD; }
          else if (!castSkill(state, u)) u.skillT = 0;
        }
      }
      if (u.dead) continue;
      if (u.side === 'enemy' && u.target) { walkPath(state, u, dt); continue; }   // 行军敌人：只走路，不攻击（塔 target=null，走攻击逻辑）
      if (u.noAttack && !u.produce) continue;        // 刘备：不攻击
      if (u.cls === 'gold') continue;                // 未成将的金字：不动作
      if (u.produce) continue;                       // 农民：只产馒头

      const targets = B.threatsInRange(state, u, u.range);
      if (targets.length) {
        const interval = u.aspd > 0 ? 1 / u.aspd : 1;
        u.atkT += dt;
        if (u.atkT >= interval) {
          u.atkT -= interval;
          performAttack(state, u, targets);
        }
      }
    }

    // 5) 清理尸体
    if (state.units.some(function (u) { return u.dead; })) {
      state.units = state.units.filter(function (u) { return !u.dead; });
    }

    // 6) AI 决策（竞技模式）
    if (state.mode === 'versus' && !state.over) {
      state.aiT += dt;
      if (state.aiT >= 0.5) { state.aiT = 0; ZY.AI.think(state); }
    }

    // 7) 胜负
    checkEnd(state);
  }

  function performAttack(state, u, targets) {
    const t0 = targets[0];                           // threatsInRange 已按「最靠前」排好序
    // V3：攻击动画触发（按单位攻速节流——performAttack 本身只在攻击间隔触发一次）
    state.fx.push({ type: 'anim', uid: u.id, name: 'attack' });
    const ranged = u.range >= 3 && (u.type === 'gong' || (u.cls === 'hero' && ZY.HERO_BY_ID[u.heroId] && ZY.HERO_BY_ID[u.heroId].base === 'gong'));
    if (u.boss) {
      state.fx.push({ type: 'slash', row: t0.row, col: t0.col, dir: (u.side === 'player' ? 1 : -1) });
    } else if (ranged) {
      state.fx.push({ type: 'arrow', fromRow: u.row, fromCol: u.col, toRow: t0.row, toCol: t0.col });
    } else if (u.pierce) {
      state.fx.push({ type: 'beam', row: u.row, col: u.col, dir: (u.side === 'player' ? 1 : -1) });
    } else if (u.splash) {
      state.fx.push({ type: 'ring', row: t0.row, col: t0.col });
    } else {
      state.fx.push({ type: 'slash', row: t0.row, col: t0.col, dir: (u.side === 'player' ? 1 : -1) });
    }
    if (u.pierce) targets.forEach(function (t) { hurt(state, u, t, u.atk); });
    else hurt(state, u, t0, u.atk);
    if (u.splash) {
      const around = B.neighbors(state, t0.row, t0.col, false);
      around.forEach(function (p) {
        const t = state.grid[p.row][p.col];
        if (t && t.side === 'enemy' && t.target === u.side && !t.dead && t !== t0) hurt(state, u, t, u.atk * u.splash);
      });
    }
  }

  /* ------------------------------------------------------------ 波次 */
  function tickWaves(state, dt) {
    const w = state.wave;
    w.spawnT += dt;
    const gap = w.spawnGap || SPAWN_GAP;
    if (w.pending.length && w.spawnT >= gap) {
      w.spawnT = 0;
      const spec = w.pending.shift();
      spawnEnemyNow(state, spec);
    }
    if (w.done) return;
    w.timer += dt;
    if (w.timer >= w.interval && w.pending.length === 0) {
      w.timer = 0;
      startWave(state);
    }
  }

  function startWave(state) {
    const w = state.wave;
    w.idx++;
    state.stats.waves = w.idx;

    const T = ZY.TUNE;
    let count, hpMul, atkMul, elites = 0, level, isBoss = false, bt = false;

    if (state.mode === 'endless' || state.mode === 'versus') {
      // 无尽 / 竞技共用一套波次配方（竞技 = 公共波次，spawnEnemyNow 镜像进双方路）
      count = Math.floor(T.endlessBase + w.idx * T.endlessStep);
      hpMul = Math.pow(T.endlessHp, w.idx);
      atkMul = Math.pow(T.endlessAtk, w.idx);
      level = clamp(1 + Math.floor(w.idx / 7), 1, 5);
      if (w.idx >= 10 && w.idx % 5 === 0) { count = Math.round(count * T.endlessEliteMul); elites = 1 + Math.floor(w.idx / 15); }
      w.interval = Math.max(T.endlessMin, T.endlessInterval * Math.pow(T.endlessDecay, w.idx));
      if (w.idx % 5 === 0) {
        const bonus = 20 * (w.idx / 5);
        const sides = state.mode === 'versus' ? ['player', 'enemy'] : ['player'];
        sides.forEach(function (sd) {
          const st = sideState(state, sd);
          if (!st) return;
          st.bun += bonus;
          const a = B.adouAt(state.mode, sd);
          state.fx.push({ type: 'bun', row: a ? a.row : 6, col: a ? a.col : 3, text: '波次奖励 +' + bonus });
        });
      }
      if (w.idx >= T.breakStart && w.idx === state.nextBreak) {
        bt = true;
        state.nextBreak = w.idx + T.breakMin + Math.floor(Math.random() * (T.breakMax - T.breakMin + 1));
      }
      if (state.mode === 'versus' && w.idx >= T.versusWaves) w.done = true;   // 竞技：打完公共波次即收官
    } else {                                          // 关卡：3 普通波 + 1 关底（强化波 + Boss）
      const lv = ZY.LEVELS[state.levelIdx];
      isBoss = w.idx >= 4;
      count = isBoss ? Math.ceil(lv.count * T.bossCountMul)
                     : lv.count + (w.idx - 1) * T.levelStep;
      hpMul = lv.hpMul * (1 + T.levelHpRamp * (w.idx - 1)) * (isBoss ? T.bossHpMul : 1);
      atkMul = lv.atkMul * (1 + T.levelAtkRamp * (w.idx - 1)) * (isBoss ? T.bossAtkMul : 1);
      level = clamp(1 + Math.floor(state.levelIdx / T.levelEnemyDiv) + (isBoss ? 1 : 0), 1, 5);
      if (isBoss) elites = 1 + Math.floor(state.levelIdx / 2);
      w.interval = isBoss ? T.levelBossGap : T.levelGap;
      if (isBoss) w.done = true;
      if (w.idx === T.levelBreakWave && !state.levelBtDone) { bt = true; state.levelBtDone = true; }
    }

    for (let i = 0; i < count; i++) {
      const pick = ZY.weighted(ZY.ENEMY_MIX);
      w.pending.push({ type: pick.type, level: level, hpMul: hpMul, atkMul: atkMul, elite: i < elites });
    }
    if (isBoss) {
      w.pending.push({ type: 'boss', level: level, hpMul: hpMul, atkMul: atkMul, boss: true });
    }
    if (bt) {
      // 突破口：该波从入口集中出怪（数量 ×breakMul 权重，间隔减半）
      const extra = Math.max(1, Math.round(count * (T.breakMul - 1) * BREAK_W));
      for (let i = 0; i < extra; i++) {
        const pick = ZY.weighted(ZY.ENEMY_MIX);
        w.pending.push({ type: pick.type, level: level, hpMul: hpMul, atkMul: atkMul, elite: Math.random() < 0.2 });
      }
      w.spawnGap = SPAWN_GAP * T.breakGapMul;
      w.breakEntrance = true;
    } else {
      w.spawnGap = SPAWN_GAP;
      w.breakEntrance = false;
    }
    state.banner = {
      text: '第 ' + w.idx + ' 波' +
            (state.mode === 'level' && w.idx >= 4 ? ' · 关底' : '') +
            (bt ? ' · 突破口！' : '') + ' 来袭',
      life: 1.6,
    };
    ZY.Audio.play('hurt');
  }

  /** 出一个敌人：竞技模式双方路各出一个（数量/强度对等） */
  function spawnEnemyNow(state, spec) {
    const targets = state.mode === 'versus' ? ['player', 'enemy'] : ['player'];
    const ents = targets.map(function (t) { return B.entrances(state.mode, t)[0]; });
    // 入口被堵 → 攒着下一批再试
    if (!ents.every(function (e) { return B.inBoard(e.row, e.col) && !state.grid[e.row][e.col]; })) {
      state.wave.pending.unshift(spec);
      return;
    }
    targets.forEach(function (tgt, i) {
      const u = makeUnit(state, 'enemy', {
        cls: 'soldier', type: spec.type, level: spec.level,
        hpMul: spec.hpMul, atkMul: spec.atkMul, elite: spec.elite, boss: spec.boss,
        row: ents[i].row, col: ents[i].col, target: tgt,
      });
      addUnit(state, u);
    });
  }

  /* ------------------------------------------------------------ 胜负 */
  function checkEnd(state) {
    if (state.over) return;
    if (state.mode === 'level' && state.wave.done && state.wave.idx >= 4) {
      if (!state.wave.pending.length && !state.units.some(function (u) { return u.side === 'enemy'; })) {
        endGame(state, 'win');
      }
    }
    // 竞技：公共波次打满且路上敌军清空 → 先比阿斗剩血，持平比击杀，再持平比馒头存量
    if (state.mode === 'versus' && state.wave.done) {
      if (!state.wave.pending.length && !state.units.some(function (u) { return u.side === 'enemy' && u.target; })) {
        if (state.player.adou !== state.enemy.adou) {
          endGame(state, state.player.adou > state.enemy.adou ? 'win' : 'lose');
        } else if (state.player.kills !== state.enemy.kills) {
          endGame(state, state.player.kills > state.enemy.kills ? 'win' : 'lose');
        } else {
          endGame(state, state.player.bun > state.enemy.bun ? 'win' : 'lose');
        }
      }
    }
  }

  function endGame(state, result) {
    if (state.over) return;
    state.over = true;
    state.result = result;
    state.paused = false;
    if (result === 'win') ZY.Audio.play('win'); else ZY.Audio.play('lose');
  }

  /* ------------------------------------------------------------ 玩家操作 */
  function recruit(state, side) {
    const s = sideState(state, side);
    if (!s) return null;
    if (s.bun < s.recruitCost) return null;
    if (s.hand.length >= C.HAND_MAX) return null;
    s.bun -= s.recruitCost;
    s.recruitCost = Math.min(C.RECRUIT_MAX_COST, s.recruitCost + C.RECRUIT_STEP);
    const n = Math.min(C.BATCH, C.HAND_MAX - s.hand.length);
    const cards = [];
    for (let i = 0; i < n; i++) {
      const card = ZY.rollRecruit(state, side);
      card.uid = state.nextCardId++;
      cards.push(card);
    }
    for (let i = 0; i < cards.length; i++) s.hand.push(cards[i]);
    if (side === 'player') {
      ZY.Audio.play('recruit');
      state.fx.push({ type: 'toast', text: '征兵 ×' + cards.length });
    }
    return { cards: cards };
  }

  function cardLabel(card) {
    if (card.kind === 'item') return ZY.ITEMS[card.item].name;
    if (card.kind === 'gold') return '金字「' + card.char + '」';
    return '「' + card.char + '」' + U[card.type].name;
  }

  /** 拖放落点：空格塔位 = 建塔；己方塔上 = 同字合成 +1 级 */
  function deploy(state, side, cardUid, r, c) {
    const s = sideState(state, side);
    const idx = s.hand.findIndex(function (x) { return x.uid === cardUid; });
    if (idx < 0) return { ok: false, msg: '没有这张牌' };
    const card = s.hand[idx];
    if (card.kind === 'item') return { ok: false, msg: ZY.ITEMS[card.item].name + '要拖出去释放' };

    const t = state.grid[r] && state.grid[r][c];
    if (t) {
      // —— 落到己方塔上：合成 ——
      if (t.side !== side) return { ok: false, msg: '不能叠到敌方单位上' };
      if (card.kind === 'gold' || t.cls !== 'soldier') return { ok: false, msg: '只有同字兵种塔才能合成' };
      if (t.type !== card.type) return { ok: false, msg: '只有同字才能合成' };
      if (t.level >= C.MAX_LEVEL) return { ok: false, msg: '已满级（' + C.MAX_LEVEL + ' 级），不能再合成' };
      t.level++;
      restatUnit(state, t);
      s.hand.splice(idx, 1);
      if (side === 'player') {
        ZY.Audio.play('merge');
        state.fx.push({ type: 'merge', row: r, col: c, text: '+1 级 → ' + t.level });
      }
      return { ok: true, merged: true, level: t.level };
    }

    // —— 空格：建塔 ——
    if (!B.canPlace(state, side, r, c)) {
      if (B.isPath(state.mode, r, c)) return { ok: false, msg: '这里是主路，不能建塔' };
      if (B.isObstacle(r, c)) return { ok: false, msg: '这里是障碍，不能建塔' };
      if (state.deploy[B.key(r, c)] !== side) return { ok: false, msg: '只能放在自己的塔位上' };
      return { ok: false, msg: '这里放不了' };
    }
    const spec = {
      row: r, col: c,
      cls: card.kind === 'gold' ? 'gold' : 'soldier',
      type: card.kind === 'unit' ? card.type : null,
      char: card.char, level: 1,
      target: null,                                  // 塔是防守单位，不冲任何阿斗
    };
    const u = makeUnit(state, side, spec);
    addUnit(state, u);
    s.hand.splice(idx, 1);
    if (side === 'player') ZY.Audio.play('place');
    const formed = checkHeroes(state, side);
    return { ok: true, unit: u, hero: formed };
  }

  /** 金字横排成将：同一行左右相邻的两个金字塔 → 武将塔（落点 = 左侧塔位） */
  function checkHeroes(state, side) {
    let formed = null;
    for (let r = 0; r < B.ROWS && !formed; r++) {
      for (let c = 0; c < B.COLS - 1; c++) {
        const a = state.grid[r][c], b = state.grid[r][c + 1];
        if (!a || !b || a.dead || b.dead) continue;
        if (a.side !== side || b.side !== side) continue;
        if (a.cls !== 'gold' || b.cls !== 'gold') continue;
        const hero = ZY.HERO_BY_NAME[a.char + b.char];
        if (!hero) continue;
        removeUnit(state, b, true);
        removeUnit(state, a, true);
        const h = makeUnit(state, side, { cls: 'hero', heroId: hero.id, heroLevel: 1, row: r, col: c, target: null });
        addUnit(state, h);
        formed = h;
        if (side === 'player') {
          ZY.Audio.play('hero');
          state.fx.push({ type: 'hero', row: r, col: c, text: hero.name + ' 参上！' });
          state.fx.push({ type: 'pillar', row: r, col: c });
          state.banner = { text: hero.name + ' 参上！', life: 1.8 };
        } else {
          state.banner = { text: '敌军 ' + hero.name + ' 登场', life: 1.5 };
        }
        break;
      }
    }
    return formed;
  }

  /* ------------------------------------------------------------ 道具（拖放释放） */
  function useShovel(state, side, r, c) {
    if (!B.inBoard(r, c)) return { ok: false, msg: '超出棋盘' };
    if (B.isPath(state.mode, r, c)) return { ok: false, msg: '主路格不能建塔' };
    if (B.isObstacle(r, c)) return { ok: false, msg: '障碍格不能扩' };
    if (state.deploy[B.key(r, c)]) return { ok: false, msg: '这一格已经是塔位' };
    if (!B.adjacentToDeploy(state, side, r, c)) return { ok: false, msg: '铲子只能扩与塔位相邻的荒地' };
    state.deploy[B.key(r, c)] = side;
    if (side === 'player') {
      ZY.Audio.play('item');
      state.fx.push({ type: 'open', row: r, col: c, text: '扩塔位' });
    }
    return { ok: true };
  }

  function useBrush(state, side, unitId) {
    const u = state.units.find(function (x) { return x.id === unitId; });
    if (!u || u.dead || u.side !== side) return { ok: false, msg: '只能改己方的塔' };
    if (u.cls === 'hero') return { ok: false, msg: '武将塔不能被毛笔改写' };
    if (u.cls === 'gold') return { ok: false, msg: '金字塔不能被毛笔改写' };
    if (u.cls === 'soldier' && u.type === 'nong') return { ok: false, msg: '农民塔不能被毛笔改写' };
    const pool = u.cls === 'gold' ? ZY.GOLD_CHARS : ZY.SOLDIER_CHARS;
    const candidates = pool.filter(function (ch) { return ch !== u.char; });
    const next = candidates[Math.floor(Math.random() * candidates.length)];
    u.char = next; u.type = ZY.CHAR2TYPE[next];
    const st = ZY.statsAt(u.type, u.level);
    const ratio = u.maxHp > 0 ? u.hp / u.maxHp : 1;
    u.maxHp = st.hp; u.atk = st.atk; u.aspd = st.aspd; u.range = U[u.type].range;
    u.move = U[u.type].move; u.pierce = !!U[u.type].pierce; u.splash = U[u.type].splash || 0;
    u.hp = Math.max(1, u.maxHp * ratio);
    if (side === 'player') { ZY.Audio.play('item'); state.fx.push({ type: 'brush', row: u.row, col: u.col, text: '改写 → ' + u.char }); }
    const formed = checkHeroes(state, side);
    return { ok: true, hero: formed };
  }

  function useWarcry(state, side) {
    state.buff[side] = C.WARCRY_TIME;
    if (side === 'player') {
      ZY.Audio.play('item');
      state.banner = { text: '神兵符！全队攻击 ×' + C.WARCRY_MULT + '（' + C.WARCRY_TIME + 's）', life: 1.6 };
    }
    return { ok: true };
  }

  /** 火球：落点 3×3 内「冲我来的」敌人各受 80 固定伤害 + 爆炸特效 */
  function useFireball(state, side, row, col) {
    let hit = 0;
    const foes = state.units.filter(function (t) {
      return !t.dead && t.side === 'enemy' && t.target === side;
    });
    foes.forEach(function (t) {
      if (Math.max(Math.abs(t.row - row), Math.abs(t.col - col)) <= C.FIREBALL_RADIUS) {
        hurtFixed(state, side, t, C.FIREBALL_DMG);
        hit++;
      }
    });
    state.fx.push({ type: 'boom', row: row, col: col });
    state.fx.push({ type: 'shake' });
    if (side === 'player') ZY.Audio.play('boom');
    return { ok: true, hit: hit };
  }

  /* ------------------------------------------------------------ 建立对局 */
  function baseState(mode, opts) {
    opts = opts || {};
    const T = ZY.TUNE;
    const state = {
      mode: mode, difficulty: num(opts.difficulty, 1),
      levelIdx: num(opts.levelIdx, 0),
      levelName: mode === 'level' ? ZY.LEVELS[num(opts.levelIdx, 0)].name : '',
      t: 0, paused: false, over: false, result: null,
      grid: B.createGrid(), units: [], deploy: {},
      nextBreak: T.breakStart, levelBtDone: false,
      nextId: 1, nextCardId: 1,
      player: { bun: C.START_BUN, adou: C.ADOU_HP, hand: [], kills: 0, recruitCost: C.RECRUIT_BASE_COST },
      enemy: { bun: C.START_BUN, adou: C.ADOU_HP, hand: [], kills: 0, recruitCost: C.RECRUIT_BASE_COST },
      buff: { player: 0, enemy: 0 },
      hasAdou: { player: true, enemy: mode === 'versus' },
      wave: { idx: 0, timer: 0, interval: mode === 'level' ? T.levelFirstGap : T.endlessInterval, pending: [], spawnT: 0, spawnGap: SPAWN_GAP, done: false, breakEntrance: false },
      aiT: 0, fx: [], banner: null, stats: { kills: 0, waves: 0, duration: 0 },
    };
    state.deploy = B.startSlots(mode, 'player', state.levelIdx);
    if (mode === 'versus') {
      const es = B.startSlots(mode, 'enemy', state.levelIdx);
      Object.keys(es).forEach(function (k) { state.deploy[k] = 'enemy'; });
    }
    return state;
  }

  function inherit(state, prev, noBonus) {
    if (!prev) { seedArmy(state, state.levelIdx); return state; }
    state.player.recruitCost = C.RECRUIT_BASE_COST;        // 每关重置征兵成本
    state.player.bun = prev.player.bun + (noBonus ? 0 : C.LEVEL_CLEAR_BONUS);
    state.player.hand = prev.player.hand.slice();
    state.deploy = {};
    Object.keys(prev.deploy).forEach(function (k) { state.deploy[k] = prev.deploy[k]; });
    state.nextId = prev.nextId;
    state.nextCardId = prev.nextCardId;
    prev.units.forEach(function (u) {
      if (u.side !== 'player' || u.dead) return;
      const nu = makeUnit(state, 'player', {
        cls: u.cls, type: u.type, char: u.char, heroId: u.heroId,
        heroLevel: u.heroLevel, level: u.level, row: u.row, col: u.col,
      });
      nu.hp = nu.maxHp;
      nu.kills = u.kills; nu.skillT = u.skillT;
      addUnit(state, nu);
    });
    return state;
  }

  function seedArmy(state, idx) {
    if (!idx) return;
    const lv = clamp(1 + Math.floor(idx / 2), 1, 3);
    const n = Math.min(2 + idx, 6);
    const types = ['dao', 'qiang', 'gong', 'dao', 'qi', 'qiang'];
    const cells = [];
    Object.keys(state.deploy).forEach(function (k) {
      if (state.deploy[k] !== 'player') return;
      const p = k.split(',');
      cells.push({ r: +p[0], c: +p[1] });
    });
    shuffle(cells);
    let placed = 0;
    for (let i = 0; i < cells.length && placed < n; i++) {
      if (state.grid[cells[i].r][cells[i].c]) continue;
      const u = makeUnit(state, 'player', { cls: 'soldier', type: types[placed % types.length], level: lv, row: cells[i].r, col: cells[i].c });
      addUnit(state, u); placed++;
    }
    state.player.bun += 30 * idx;
  }

  ZY.Game = {
    TICK: TICK, SPAWN_GAP: SPAWN_GAP,
    baseState: baseState, inherit: inherit, seedArmy: seedArmy,
    tick: tick, recruit: recruit, deploy: deploy,
    checkHeroes: checkHeroes, useShovel: useShovel, useBrush: useBrush,
    useWarcry: useWarcry, useFireball: useFireball,
    endGame: endGame, sideState: sideState, cardLabel: cardLabel,
    makeUnit: makeUnit, addUnit: addUnit, removeUnit: removeUnit,
    hurt: hurt, hurtFixed: hurtFixed,
  };
})(window.ZY);
