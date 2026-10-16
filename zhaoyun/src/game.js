/* =============================================================================
 * 赵云与阿斗 · 核心规则与主循环 (game.js)  — V2
 * 只管状态与规则，不碰 DOM；UI 层负责渲染与输入
 * 单位沿兵线（道路格）流场寻路推进，攻击按切比雪夫射程结算
 * ========================================================================== */
(function (ZY) {
  'use strict';

  const B = ZY.B;
  const C = ZY.C;
  const U = ZY.UNITS;
  const TICK = 0.1;               // 固定逻辑步长：10 tick / 秒
  const SPAWN_GAP = 0.35;         // 波次内逐个出兵间隔（缺口处会被缩短）

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
    };

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

    // 击杀赏金：敌方单位才给赏金（玩家单位不给敌方送经济）
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
    if (src && (src.side === 'player')) ZY.Audio.play('attack');
    if (tgt.hp <= 0) killUnit(state, src, tgt);
    return dmg;
  }

  function killUnit(state, src, tgt) {
    if (tgt.dead) return;
    const killerSide = src ? src.side : (tgt.side === 'player' ? 'enemy' : 'player');
    const s = sideState(state, killerSide);
    s.bun += tgt.bounty;
    s.kills++;
    if (src) {
      src.kills++;
      if (src.cls === 'hero') tryHeroLevel(state, src);
      state.fx.push({ type: 'bun', row: tgt.row, col: tgt.col, text: '+' + tgt.bounty });
    }
    if (tgt.side === 'enemy') state.stats.kills++;
    if (tgt.boss) { state.banner = { text: '强敌倒下', life: 2.2 }; state.fx.push({ type: 'shake' }); }
    if (tgt.elite) state.fx.push({ type: 'big', row: tgt.row, col: tgt.col, text: '精英倒下' });
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
  function adouHit(state, side, unit) {
    const s = sideState(state, side);
    s.adou -= 1;
    s.bun += C.ADOU_BONUS;
    const a = B.ADOU[side];
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
    const list = B.enemiesInRange(state, u, u.range || 3);
    if (!list.length && sk.type !== 'heal') return false;
    let fired = false;

    if (sk.type === 'sweep') {                       // 赵云：前方范围群伤
      const all = B.enemiesInRange(state, u, 4);
      if (all.length) { all.forEach(function (t) { hurt(state, u, t, u.atk * 2); }); fired = true; }
    } else if (sk.type === 'roar') {                 // 张飞：震晕周围 1 格
      const near = B.enemiesInRange(state, u, 1);
      if (near.length) {
        near.forEach(function (t) { t.stun = 1; state.fx.push({ type: 'stun', row: t.row, col: t.col, text: '晕' }); });
        fired = true;
      }
    } else if (sk.type === 'snipe') {                // 黄忠：最远敌人单体大伤
      const all = B.enemiesInRange(state, u, 5);
      if (all.length) {
        let far = all[0];
        all.forEach(function (t) { if (Math.max(Math.abs(t.row - u.row), Math.abs(t.col - u.col)) > Math.max(Math.abs(far.row - u.row), Math.abs(far.col - u.col))) far = t; });
        hurt(state, u, far, u.atk * 3);
        state.fx.push({ type: 'beam', row: far.row, col: far.col });
        fired = true;
      }
    } else if (sk.type === 'cleave') {               // 关羽：周围溅射
      const near = B.enemiesInRange(state, u, 1);
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
      const near = B.enemiesInRange(state, u, 2);
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

  function castBossSkill(state, u) {
    const near = B.neighbors(state, u.row, u.col, true);
    let hitAny = false;
    near.forEach(function (p) {
      const t = state.grid[p.row][p.col];
      if (t && t.side !== u.side && !t.dead) { hurt(state, u, t, u.atk * 1.5); t.stun = Math.max(t.stun, C.BOSS_SLOW); hitAny = true; }
    });
    state.fx.push({ type: 'ring', row: u.row, col: u.col });
    state.fx.push({ type: 'shake' });
    state.fx.push({ type: 'redflash' });
    if (hitAny) state.banner = { text: '魔将 · 震击', life: 1.0 };
    ZY.Audio.play('skill');
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
      let inc = (side === 'enemy' && state.mode === 'versus')
        ? C.BASE_INCOME * (1 + (num(state.difficulty, 1) - 1) * 0.6) : C.BASE_INCOME;
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

    // 3) 波次（非竞技模式）
    if (state.mode !== 'versus') tickWaves(state, dt);

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
      if (u.noAttack && !u.produce) continue;        // 刘备：不攻击
      if (u.cls === 'gold') continue;                // 未成将的金字：不动作
      if (u.produce) continue;                       // 农民：只产馒头

      const targets = B.enemiesInRange(state, u, u.range);
      if (targets.length) {
        const interval = u.aspd > 0 ? 1 / u.aspd : 1;
        u.atkT += dt;
        if (u.atkT >= interval) {
          u.atkT -= interval;
          performAttack(state, u, targets);
        }
      } else if (u.move > 0) {
        const foe = u.side === 'player' ? 'enemy' : 'player';
        if (!state.hasAdou[foe]) continue;           // 无敌方阿斗可攻 → 原地防守
        u.moveT += dt;
        if (u.moveT >= u.move) {
          u.moveT = 0;
          const step = B.nextStep(state, u);
          if (!step) continue;
          const adou = B.ADOU[foe];
          if (step.row === adou.row && step.col === adou.col) {
            // 突入阿斗格 → 破门
            state.grid[u.row][u.col] = null;
            u.row = step.row; u.col = step.col;
            adouHit(state, foe, u);
          } else if (!state.grid[step.row][step.col]) {
            state.grid[u.row][u.col] = null;
            u.row = step.row; u.col = step.col;
            state.grid[u.row][u.col] = u;
          }
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
    const t0 = targets[0];
    // V3：攻击动画触发（按单位攻速节流——performAttack 本身只在攻击间隔触发一次）
    state.fx.push({ type: 'anim', uid: u.id, name: 'attack' });
    const ranged = u.range >= 3 && (u.type === 'gong' || (u.cls === 'hero' && ZY.HERO_BY_ID[u.heroId] && ZY.HERO_BY_ID[u.heroId].base === 'gong'));
    if (u.boss) {
      state.fx.push({ type: 'slash', row: t0.row, col: t0.col, dir: (u.side === 'player' ? 1 : -1) });
    } else if (ranged) {
      let far = t0;
      for (let i = 1; i < targets.length; i++) {
        const a = Math.max(Math.abs(targets[i].row - u.row), Math.abs(targets[i].col - u.col));
        const b = Math.max(Math.abs(far.row - u.row), Math.abs(far.col - u.col));
        if (a > b) far = targets[i];
      }
      state.fx.push({ type: 'arrow', fromRow: u.row, fromCol: u.col, toRow: far.row, toCol: far.col });
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
        if (t && t.side !== u.side && !t.dead && t !== t0) hurt(state, u, t, u.atk * u.splash);
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

  function laneWeight(lane) {
    const T = ZY.TUNE;
    return lane === 'mid' ? T.laneMidW : T.laneLWR;
  }
  function pickBreakLane() {
    const arr = ['left', 'mid', 'right'];
    return arr[Math.floor(Math.random() * arr.length)];
  }
  function assignLanes(count) {
    const T = ZY.TUNE;
    const out = [];
    for (let i = 0; i < count; i++) {
      const r = Math.random() + (Math.random() - 0.5) * 0.1;
      let lane;
      if (r < T.laneMidW) lane = 'mid';
      else if (r < T.laneMidW + T.laneLWR) lane = 'left';
      else lane = 'right';
      out.push(lane);
    }
    return out;
  }
  function uniqueCols(lanes) {
    const set = {};
    lanes.forEach(function (l) { ZY.B.LANES[l].forEach(function (c) { set[c] = true; }); });
    return Object.keys(set).map(Number);
  }

  function startWave(state) {
    const w = state.wave;
    w.idx++;
    state.stats.waves = w.idx;

    const T = ZY.TUNE;
    let count, hpMul, atkMul, elites = 0, level, isBoss = false, bt = null;

    if (state.mode === 'endless') {
      count = Math.floor(T.endlessBase + w.idx * T.endlessStep);
      hpMul = Math.pow(T.endlessHp, w.idx);
      atkMul = Math.pow(T.endlessAtk, w.idx);
      level = clamp(1 + Math.floor(w.idx / 7), 1, 5);
      if (w.idx >= 10 && w.idx % 5 === 0) { count = Math.round(count * T.endlessEliteMul); elites = 1 + Math.floor(w.idx / 15); }
      w.interval = Math.max(T.endlessMin, T.endlessInterval * Math.pow(T.endlessDecay, w.idx));
      if (w.idx % 5 === 0) {
        const bonus = 20 * (w.idx / 5);
        state.player.bun += bonus;
        state.fx.push({ type: 'bun', row: 6, col: 3, text: '波次奖励 +' + bonus });
      }
      if (w.idx >= T.breakStart && w.idx === state.nextBreak) {
        bt = pickBreakLane();
        state.nextBreak = w.idx + T.breakMin + Math.floor(Math.random() * (T.breakMax - T.breakMin + 1));
      }
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
      if (w.idx === T.levelBreakWave && !state.levelBtDone) { bt = pickBreakLane(); state.levelBtDone = true; }
    }

    const lanes = assignLanes(count);
    for (let i = 0; i < count; i++) {
      const pick = ZY.weighted(ZY.ENEMY_MIX);
      w.pending.push({ type: pick.type, level: level, hpMul: hpMul, atkMul: atkMul, elite: i < elites, lane: lanes[i] });
    }
    if (isBoss) {
      w.pending.push({ type: 'boss', level: level, hpMul: hpMul, atkMul: atkMul, boss: true, lane: lanes[0] || 'mid' });
    }
    if (bt) {
      const extra = Math.max(1, Math.round(count * (T.breakMul - 1) * laneWeight(bt)));
      for (let i = 0; i < extra; i++) {
        const pick = ZY.weighted(ZY.ENEMY_MIX);
        w.pending.push({ type: pick.type, level: level, hpMul: hpMul, atkMul: atkMul, elite: Math.random() < 0.2, lane: bt });
      }
      w.spawnGap = SPAWN_GAP * T.breakGapMul;
      w.breakCols = ZY.B.LANES[bt].slice();
    } else {
      w.spawnGap = SPAWN_GAP;
      w.breakCols = null;
    }
    w.lanes = uniqueCols(lanes);
    state.banner = {
      text: (state.mode === 'endless' ? '第 ' + w.idx + ' 波' : '第 ' + w.idx + ' 波' + (w.idx >= 4 ? ' · 关底' : '')) +
            (bt ? ' · 突破口！' : '') + ' 来袭',
      life: 1.6,
    };
    ZY.Audio.play('hurt');
  }

  function spawnEnemyNow(state, spec) {
    const cols = ZY.B.LANES[spec.lane] || ZY.B.LANES.mid;
    let cell = null;
    const order = shuffle(cols.slice());
    for (let rr = 0; rr <= 2 && !cell; rr++) {
      for (let ci = 0; ci < order.length && !cell; ci++) {
        const c = order[ci];
        if (isRoadFree(state, rr, c)) cell = { row: rr, col: c };
      }
    }
    if (!cell) {
      for (let rr = 0; rr <= 2 && !cell; rr++) for (let c = 0; c < B.COLS && !cell; c++) if (isRoadFree(state, rr, c)) cell = { row: rr, col: c };
    }
    if (!cell) { state.wave.pending.push(spec); return; }
    const u = makeUnit(state, 'enemy', {
      cls: spec.boss ? 'soldier' : 'soldier', type: spec.type, level: spec.level,
      hpMul: spec.hpMul, atkMul: spec.atkMul, elite: spec.elite, boss: spec.boss,
      row: cell.row, col: cell.col,
    });
    addUnit(state, u);
  }
  function isRoadFree(state, r, c) { return B.isRoad(r, c) && !state.grid[r][c]; }

  /* ------------------------------------------------------------ 胜负 */
  function checkEnd(state) {
    if (state.over) return;
    if (state.mode === 'level' && state.wave.done && state.wave.idx >= 4) {
      if (!state.wave.pending.length && !state.units.some(function (u) { return u.side === 'enemy'; })) {
        endGame(state, 'win');
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

  function deploy(state, side, cardUid, r, c) {
    const s = sideState(state, side);
    const idx = s.hand.findIndex(function (x) { return x.uid === cardUid; });
    if (idx < 0) return { ok: false, msg: '没有这张牌' };
    const card = s.hand[idx];
    if (card.kind === 'item') return { ok: false, msg: ZY.ITEMS[card.item].name + '要点击使用' };
    if (!B.canPlace(state, side, r, c)) {
      if (!B.isRoad(r, c)) return { ok: false, msg: '这里是障碍，不能部署' };
      if (!B.isOwnRow(side, r)) return { ok: false, msg: '只能放在己方半区' };
      if (!state.deploy[B.key(r, c)]) return { ok: false, msg: '荒地需先用铲子扩地' };
      return { ok: false, msg: '这里放不了' };
    }
    const spec = {
      row: r, col: c,
      cls: card.kind === 'gold' ? 'gold' : 'soldier',
      type: card.kind === 'unit' ? card.type : null,
      char: card.char, level: 1,
    };
    const u = makeUnit(state, side, spec);
    addUnit(state, u);
    s.hand.splice(idx, 1);
    if (side === 'player') ZY.Audio.play('place');
    const formed = checkHeroes(state, side);
    return { ok: true, unit: u, hero: formed };
  }

  function dropUnitOn(state, side, unitId, r, c) {
    const u = state.units.find(function (x) { return x.id === unitId; });
    if (!u || u.dead || u.side !== side) return { ok: false, msg: '只能移动自己的字块' };
    if (r === u.row && c === u.col) return { ok: false, silent: true };
    const t = state.grid[r][c];
    if (t) {
      if (t.side !== side) return { ok: false, msg: '不能叠到敌方单位上' };
      if (u.cls === 'soldier' && t.cls === 'soldier' && u.type === t.type && u.level === t.level && u.level < C.MAX_LEVEL) {
        t.level++;
        restatUnit(state, t);
        removeUnit(state, u, true);
        if (side === 'player') { ZY.Audio.play('merge'); state.fx.push({ type: 'merge', row: r, col: c, text: '+1 级 → ' + t.level }); }
        return { ok: true, merged: true };
      }
      if (u.cls === 'soldier' && t.cls === 'soldier' && u.type === t.type && u.level >= C.MAX_LEVEL) return { ok: false, msg: '已满级，不能再合成' };
      return { ok: false, msg: '只有同字同级才能合成' };
    }
    if (!B.isOwnRow(side, r)) return { ok: false, msg: '只能放在己方半区' };
    if (!B.isRoad(r, c)) return { ok: false, msg: '障碍格不能部署' };
    state.grid[u.row][u.col] = null;
    u.row = r; u.col = c;
    state.grid[r][c] = u;
    if (side === 'player') ZY.Audio.play('place');
    const formed = checkHeroes(state, side);
    return { ok: true, moved: true, hero: formed };
  }

  function checkHeroes(state, side) {
    let formed = null;
    for (let r = 0; r < B.ROWS && !formed; r++) {
      if (!B.isOwnRow(side, r)) continue;
      for (let c = 0; c < B.COLS - 1; c++) {
        const a = state.grid[r][c], b = state.grid[r][c + 1];
        if (!a || !b || a.dead || b.dead) continue;
        if (a.side !== side || b.side !== side) continue;
        if (a.cls !== 'gold' || b.cls !== 'gold') continue;
        const hero = ZY.HERO_BY_NAME[a.char + b.char];
        if (!hero) continue;
        removeUnit(state, b, true);
        removeUnit(state, a, true);
        const h = makeUnit(state, side, { cls: 'hero', heroId: hero.id, heroLevel: 1, row: r, col: c });
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

  /* ------------------------------------------------------------ 道具 */
  function useShovel(state, side, r, c) {
    if (!B.isOwnRow(side, r)) return { ok: false, msg: '只能扩己方半区的地' };
    if (!B.isRoad(r, c)) return { ok: false, msg: '障碍格不能扩' };
    if (state.deploy[B.key(r, c)]) return { ok: false, msg: '这一格已经是部署地' };
    if (!B.adjacentToDeploy(state, side, r, c)) return { ok: false, msg: '铲子只能扩与部署地相邻的荒地' };
    state.deploy[B.key(r, c)] = true;
    if (side === 'player') {
      ZY.Audio.play('item');
      state.fx.push({ type: 'open', row: r, col: c, text: '扩地' });
    }
    return { ok: true };
  }

  function useBrush(state, side, unitId) {
    const u = state.units.find(function (x) { return x.id === unitId; });
    if (!u || u.dead || u.side !== side) return { ok: false, msg: '只能改己方字块' };
    if (u.cls === 'hero') return { ok: false, msg: '武将不能被毛笔改写' };
    if (u.cls === 'soldier' && u.type === 'nong') return { ok: false, msg: '农民不能被毛笔改写' };
    const pool = u.cls === 'gold' ? ZY.GOLD_CHARS : ZY.SOLDIER_CHARS;
    const candidates = pool.filter(function (ch) { return ch !== u.char; });
    const next = candidates[Math.floor(Math.random() * candidates.length)];
    if (u.cls === 'gold') {
      u.char = next;
    } else {
      u.char = next; u.type = ZY.CHAR2TYPE[next];
      const st = ZY.statsAt(u.type, u.level);
      const ratio = u.maxHp > 0 ? u.hp / u.maxHp : 1;
      u.maxHp = st.hp; u.atk = st.atk; u.aspd = st.aspd; u.range = U[u.type].range;
      u.move = U[u.type].move; u.pierce = !!U[u.type].pierce; u.splash = U[u.type].splash || 0;
      u.hp = Math.max(1, u.maxHp * ratio);
    }
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
      wave: { idx: 0, timer: 0, interval: mode === 'endless' ? T.endlessInterval : T.levelFirstGap, pending: [], spawnT: 0, spawnGap: SPAWN_GAP, done: false, lanes: [], breakCols: null },
      aiT: 0, fx: [], banner: null, stats: { kills: 0, waves: 0, duration: 0 },
    };
    state.deploy = Object.assign({}, B.startRegion('player', state.levelIdx));
    if (mode === 'versus') {
      const ed = B.startRegion('enemy');
      Object.keys(ed).forEach(function (k) { state.deploy[k] = true; });
    }
    return state;
  }

  function inherit(state, prev, noBonus) {
    if (!prev) { seedArmy(state, state.levelIdx); return state; }
    state.player.recruitCost = C.RECRUIT_BASE_COST;        // 每关重置征兵成本
    state.player.bun = prev.player.bun + (noBonus ? 0 : C.LEVEL_CLEAR_BONUS);
    state.player.hand = prev.player.hand.slice();
    state.deploy = {};
    Object.keys(prev.deploy).forEach(function (k) { state.deploy[k] = true; });
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
    for (let r = 6; r <= 11; r++) for (let c = 0; c < B.COLS; c++) if (state.deploy[B.key(r, c)]) cells.push({ r: r, c: c });
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
    tick: tick, recruit: recruit, deploy: deploy, dropUnitOn: dropUnitOn,
    checkHeroes: checkHeroes, useShovel: useShovel, useBrush: useBrush, useWarcry: useWarcry,
    endGame: endGame, sideState: sideState, cardLabel: cardLabel,
    makeUnit: makeUnit, addUnit: addUnit, removeUnit: removeUnit,
  };
})(window.ZY);
