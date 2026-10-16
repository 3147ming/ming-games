/* =============================================================================
 * 赵云与阿斗 · 核心规则与主循环数据 (game.js)
 * 只管状态与规则，不碰 DOM；UI 层负责渲染与输入
 * ========================================================================== */
(function (ZY) {
  'use strict';

  const B = ZY.B;
  const C = ZY.C;
  const U = ZY.UNITS;
  const TICK = 0.1;               // 固定逻辑步长：10 tick / 秒
  const SPAWN_GAP = 0.35;         // 波次内逐个出兵间隔

  /* ---------------------------------------------------------------- 工具 */
  function sideState(state, side) { return side === 'player' ? state.player : state.enemy; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function num(v, def) { return (typeof v === 'number' && isFinite(v)) ? v : def; }

  /* ------------------------------------------------------------ 单位构造 */
  function makeUnit(state, side, spec) {
    const u = {
      id: state.nextId++,
      side: side,
      cls: spec.cls || 'soldier',   // soldier 兵种字 / gold 武将字 / hero 武将
      type: spec.type || null,      // 兵种 key
      char: spec.char || null,      // 显示的汉字
      heroId: spec.heroId || null,
      heroLevel: spec.heroLevel || 1,
      level: spec.level || 1,       // 兵种等级（武将用 heroLevel）
      row: spec.row, col: spec.col,
      hp: 0, maxHp: 0, atk: 0, aspd: 0, range: 1, move: 1,
      pierce: false, splash: 0, crit: 0, critMul: 1,
      dmgReduce: 0, noAttack: false, produce: 0,
      atkT: 0, moveT: 0, stun: 0,
      kills: 0, skillCd: 0, skillT: 0,
      bounty: num(spec.bounty, 1),
      elite: !!spec.elite,
      dead: false,
    };

    if (u.cls === 'hero') {
      const h = ZY.HERO_BY_ID[u.heroId];
      const st = ZY.heroStats(u.heroId, u.heroLevel);
      u.char = h.name;
      u.maxHp = st.hp; u.hp = st.hp;
      u.atk = st.atk; u.aspd = st.aspd; u.range = st.range; u.move = st.move;
      u.pierce = st.pierce; u.splash = st.splash;
      u.crit = st.crit; u.critMul = st.critMul; u.dmgReduce = st.dmgReduce;
      u.noAttack = st.noAttack;
      u.skillCd = h.skill.cd; u.skillT = h.skill.cd; // 出场先攒一次冷却
      u.bounty = 3;
    } else if (u.cls === 'gold') {
      u.maxHp = 30; u.hp = 30; u.atk = 0; u.aspd = 0; u.range = 0; u.move = 0;
      u.bounty = 1;
    } else {
      // 兵种字：没显式给字就从兵种表取（敌军出兵走的就是这条路）
      if (!u.char && U[u.type]) u.char = U[u.type].char;
      const st = ZY.statsAt(u.type, u.level);
      const hpMul = num(spec.hpMul, 1), atkMul = num(spec.atkMul, 1);
      u.maxHp = st.hp * hpMul; u.hp = u.maxHp;
      u.atk = st.atk * atkMul;
      u.aspd = st.aspd; u.range = U[u.type].range; u.move = U[u.type].move;
      u.pierce = !!U[u.type].pierce; u.splash = U[u.type].splash || 0;
      u.produce = U[u.type].produce || 0;
      u.noAttack = u.atk <= 0;
      // 击杀赏金：等级越高给越多，精英额外加成。
      // 这是玩家的主要收入来源（自然收入只是兜底），守得住 → 兵源越滚越多。
      u.bounty = clamp(u.level * 2, 2, 10) + (u.elite ? 4 : 0);
    }
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
    if (!silent) state.fx.push({ type: 'die', row: u.row, col: u.col });
  }

  /** 重算等级带来的数值（合成 / 升级用），按当前血量比例保留 */
  function restatUnit(state, u) {
    const ratio = u.maxHp > 0 ? clamp(u.hp / u.maxHp, 0, 1) : 1;
    if (u.cls === 'hero') {
      const st = ZY.heroStats(u.heroId, u.heroLevel);
      u.maxHp = st.hp; u.atk = st.atk; u.aspd = st.aspd; u.range = st.range; u.move = st.move;
      u.pierce = st.pierce; u.splash = st.splash;
      u.crit = st.crit; u.critMul = st.critMul; u.dmgReduce = st.dmgReduce;
      u.hp = u.maxHp; // 武将升阶回满
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
    if (tgt.side === 'player' || src && src.side === 'player') ZY.Audio.play('attack');
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
    removeUnit(state, tgt);
    ZY.Audio.play('kill');
    if (tgt.elite) state.fx.push({ type: 'big', row: tgt.row, col: tgt.col, text: '精英倒下' });
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
    const dir = B.dirOf(u.side);
    let fired = false;

    if (sk.type === 'sweep') {                       // 赵云：前方直线群伤
      const list = B.scanForward(state, u, 4);
      if (list.length) {
        list.forEach(function (t) { hurt(state, u, t, u.atk * 2); });
        fired = true;
      }
    } else if (sk.type === 'roar') {                 // 张飞：震晕前方 1 格
      const fr = B.forwardCell(u);
      const t = fr ? state.grid[fr.row][fr.col] : null;
      if (t && t.side !== u.side && !t.dead) {
        t.stun = 1;
        state.fx.push({ type: 'stun', row: t.row, col: t.col, text: '晕' });
        fired = true;
      }
    } else if (sk.type === 'snipe') {                // 黄忠：最远敌人单体大伤
      const list = B.scanForward(state, u, 5);
      if (list.length) {
        const t = list[list.length - 1];
        hurt(state, u, t, u.atk * 3);
        state.fx.push({ type: 'beam', row: t.row, col: t.col });
        fired = true;
      }
    } else if (sk.type === 'cleave') {               // 关羽：周围溅射
      const list = B.neighbors(state, u.row, u.col, false);
      let hitAny = false;
      list.forEach(function (p) {
        const t = state.grid[p.row][p.col];
        if (t && t.side !== u.side && !t.dead) { hurt(state, u, t, u.atk * 2); hitAny = true; }
      });
      if (hitAny) { state.fx.push({ type: 'ring', row: u.row, col: u.col }); fired = true; }
    } else if (sk.type === 'heal') {                 // 刘备：相邻己方回血
      const list = B.neighbors(state, u.row, u.col, false);
      let healed = false;
      list.forEach(function (p) {
        const t = state.grid[p.row][p.col];
        if (t && t.side === u.side && !t.dead && t.hp < t.maxHp) {
          t.hp = Math.min(t.maxHp, t.hp + u.atk * 1.5);
          state.fx.push({ type: 'heal', row: t.row, col: t.col, text: '+' + Math.round(u.atk * 1.5) });
          healed = true;
        }
      });
      if (healed) fired = true;
    } else if (sk.type === 'leap') {                 // 张苞：跳劈单体
      const list = B.scanForward(state, u, 2);
      if (list.length) { hurt(state, u, list[0], u.atk * 2.5); fired = true; }
    }

    if (!fired) return false;                        // 没目标就不进入冷却，继续待机
    u.skillT = sk.cd;
    state.banner = { text: h.name + ' · ' + sk.name, life: 1.5 };
    state.fx.push({ type: 'ring', row: u.row, col: u.col });
    ZY.Audio.play('skill');
    return true;
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
      // 难度只轻微改变敌方收入：线性放大（×1.2 就是 +20% 兵源）会让「困难」直接变成不可能
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
      if (state.buff[side] > 0) {
        state.buff[side] -= dt;
        if (state.buff[side] <= 0) state.buff[side] = 0;
      }
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
        if (u.skillT <= 0) { if (!castSkill(state, u)) u.skillT = 0; }
      }
      if (u.dead) continue;
      if (u.noAttack && !u.produce) { continue; }   // 刘备：不攻击
      if (u.cls === 'gold') continue;               // 未成将的金字：不动作
      if (u.produce) continue;                      // 农民：只产馒头

      let targets = B.scanForward(state, u, u.range);
      // 单人模式：敌方在自己半区（row < 6）时不准隔空点射，必须压到中线接战。
      // 否则敌方枪兵（射程 2）/弓兵（射程 4）会停在够不到的距离上白点我方前排，
      // 而我方近战（射程 1）被锁在己方半区，既打不到也追不出去 —— 那是纯亏。
      // 贴脸（距离 1 格）时照常开打。
      if (targets.length && u.side === 'enemy' && state.mode !== 'versus' && u.row < B.MID_LINE) {
        if (Math.abs(targets[0].row - u.row) > 1) targets = [];
      }
      if (targets.length) {
        // 攻击
        const interval = u.aspd > 0 ? 1 / u.aspd : 1;
        u.atkT += dt;
        if (u.atkT >= interval) {
          u.atkT -= interval;
          if (u.pierce) {
            targets.forEach(function (t) { hurt(state, u, t, u.atk); });
          } else {
            hurt(state, u, targets[0], u.atk);
          }
          if (u.splash) {
            const around = B.neighbors(state, targets[0].row, targets[0].col, false);
            around.forEach(function (p) {
              const t = state.grid[p.row][p.col];
              if (t && t.side !== u.side && !t.dead && t !== targets[0]) hurt(state, u, t, u.atk * u.splash);
            });
          }
        }
      } else if (u.move > 0) {
        // 前进：前方格为空 且 攻击范围内无敌
        u.moveT += dt;
        if (u.moveT >= u.move) {
          u.moveT = 0;
          const fr = B.forwardCell(u);
          if (!fr) continue;                        // 已到棋盘边缘
          // 单人模式：我方没有阿斗可打，北伐毫无意义，所以守住己方半区即可。
          if (!state.hasAdou[u.side === 'player' ? 'enemy' : 'player'] && !B.isOwnRow(u.side, fr.row)) continue;
          const occ = state.grid[fr.row][fr.col];
          if (!occ) {
            // 突入对方底线（阿斗所在那一行）→ 破门：阿斗掉血，该单位战死
            // 说明：阿斗格本身是底线中点，但若只有中点格算数，8 条纵列里
            // 7 条就永远打不着阿斗，双方会互相错身而过 —— 所以底线整行都算「宫门」。
            const foeSide = u.side === 'player' ? 'enemy' : 'player';
            const lastRow = foeSide === 'player' ? B.ROWS - 1 : 0;
            if (state.hasAdou[foeSide] && fr.row === lastRow) {
              state.grid[u.row][u.col] = null;
              u.row = fr.row; u.col = fr.col;
              adouHit(state, foeSide, u);
            } else {
              state.grid[u.row][u.col] = null;
              u.row = fr.row; u.col = fr.col;
              state.grid[u.row][u.col] = u;
            }
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

  /* ------------------------------------------------------------ 波次 */
  function tickWaves(state, dt) {
    const w = state.wave;
    // 逐个出兵
    w.spawnT += dt;
    if (w.pending.length && w.spawnT >= SPAWN_GAP) {
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
    let count, hpMul, atkMul, elites = 0, level;
    if (state.mode === 'endless') {
      count = Math.floor(T.endlessBase + w.idx * T.endlessStep);
      hpMul = Math.pow(T.endlessHp, w.idx);
      atkMul = Math.pow(T.endlessAtk, w.idx);
      level = clamp(1 + Math.floor(w.idx / 7), 1, 5);
      if (w.idx >= 10 && w.idx % 5 === 0) {          // 第 10 波起每 5 波强化波
        count = Math.round(count * T.endlessEliteMul);
        elites = 1 + Math.floor(w.idx / 15);
      }
      // 波间隔缓降：前期留足攒兵时间，后期靠密度施压
      w.interval = Math.max(T.endlessMin, T.endlessInterval * Math.pow(T.endlessDecay, w.idx));
      if (w.idx % 5 === 0) {                          // 每 5 波结算馒头
        const bonus = 20 * (w.idx / 5);
        state.player.bun += bonus;
        state.fx.push({ type: 'bun', row: 6, col: 3, text: '波次奖励 +' + bonus });
      }
    } else {                                          // 关卡模式：3 普通波 + 1 关底强化波
      const lv = ZY.LEVELS[state.levelIdx];
      const isBoss = w.idx >= 4;
      count = isBoss ? Math.ceil(lv.count * T.bossCountMul)
                     : lv.count + (w.idx - 1) * T.levelStep;
      hpMul = lv.hpMul * (1 + T.levelHpRamp * (w.idx - 1)) * (isBoss ? T.bossHpMul : 1);
      atkMul = lv.atkMul * (1 + T.levelAtkRamp * (w.idx - 1)) * (isBoss ? T.bossAtkMul : 1);
      // 敌方等级每 2 关才 +1：等级成长是 ×1.55 血 /×1.85 攻，逐关跳级会直接崩盘，
      // 关卡难度主要交给 hpMul / atkMul 这条更平缓的曲线。
      level = clamp(1 + Math.floor(state.levelIdx / T.levelEnemyDiv) + (isBoss ? 1 : 0), 1, 5);
      if (isBoss) elites = 1 + Math.floor(state.levelIdx / 2);
      // 每波之间要能攒出 2~3 次征兵，否则防线永远补不上
      w.interval = isBoss ? T.levelBossGap : T.levelGap;
      if (isBoss) w.done = true;
    }

    // 每一波集中走几条纵列（约每 3 个敌人一条），而不是铺满 8 条。
    // 否则来袭的「列数」永远多于玩家能摆出的单位数，防线必然被穿透。
    const laneCount = Math.max(1, Math.min(B.COLS, Math.round(count / 3)));
    const lanes = [];
    let guard = 0;
    while (lanes.length < laneCount && guard++ < 200) {
      const c = Math.floor(Math.random() * B.COLS);
      if (lanes.indexOf(c) < 0) lanes.push(c);
    }
    for (let i = 0; i < count; i++) {
      const pick = ZY.weighted(ZY.ENEMY_MIX);
      w.pending.push({
        type: pick.type, level: level, hpMul: hpMul, atkMul: atkMul,
        elite: i < elites, lane: lanes[i % laneCount],
      });
    }
    // 来袭纵列公开给玩家（UI 会在对应列顶上打预警标记）：
    // 不然每波走哪几条路纯随机，开局兵力少时只能靠撞运气堵路，防守就没技术含量了。
    w.lanes = lanes;
    state.banner = {
      text: (state.mode === 'endless' ? '第 ' + w.idx + ' 波' : '第 ' + w.idx + ' 波' + (w.idx >= 4 ? ' · 关底' : '')) + ' 来袭',
      life: 1.6,
    };
    ZY.Audio.play('hurt');
  }

  function spawnEnemyNow(state, spec) {
    // 优先落在本波指定的纵列（出兵区 row 0-2）；该列满了再退到任意空位
    const free = [];
    if (spec.lane != null) {
      for (let r = 0; r <= 2; r++) {
        if (!state.grid[r][spec.lane]) { free.push({ r: r, c: spec.lane }); break; }
      }
    }
    if (!free.length) {
      for (let r = 0; r <= 2; r++) {
        for (let c = 0; c < B.COLS; c++) if (!state.grid[r][c]) free.push({ r: r, c: c });
      }
    }
    if (!free.length) { state.wave.pending.push(spec); return; }
    const pickCell2 = free[Math.floor(Math.random() * free.length)];
    const type = spec.elite ? ZY.ELITE_TYPES[Math.floor(Math.random() * ZY.ELITE_TYPES.length)] : spec.type;
    const u = makeUnit(state, 'enemy', {
      cls: 'soldier', type: type, level: spec.level,
      hpMul: spec.hpMul, atkMul: spec.atkMul,
      elite: spec.elite, row: pickCell2.r, col: pickCell2.c,
    });
    addUnit(state, u);
  }

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
    if (s.bun < C.RECRUIT_COST) return null;
    if (s.hand.length >= C.HAND_MAX) return null;
    s.bun -= C.RECRUIT_COST;
    const card = ZY.rollRecruit(state, side);
    card.uid = state.nextCardId++;
    s.hand.push(card);
    if (side === 'player') {
      ZY.Audio.play('recruit');
      state.fx.push({ type: 'toast', text: '征到：' + cardLabel(card) });
    }
    return card;
  }

  function cardLabel(card) {
    if (card.kind === 'item') return ZY.ITEMS[card.item].name;
    if (card.kind === 'gold') return '金字「' + card.char + '」';
    return '「' + card.char + '」' + U[card.type].name;
  }

  /** 从手牌部署到棋盘 */
  function deploy(state, side, cardUid, r, c) {
    const s = sideState(state, side);
    const idx = s.hand.findIndex(function (x) { return x.uid === cardUid; });
    if (idx < 0) return { ok: false, msg: '没有这张牌' };
    const card = s.hand[idx];
    if (card.kind === 'item') return { ok: false, msg: ZY.ITEMS[card.item].name + '要点击使用' };
    if (!B.canPlace(state, side, r, c)) return { ok: false, msg: '这里放不了' };
    const spec = {
      row: r, col: c,
      cls: card.kind === 'gold' ? 'gold' : 'soldier',
      type: card.kind === 'unit' ? card.type : null,
      char: card.char,
      level: 1,
    };
    const u = makeUnit(state, side, spec);
    addUnit(state, u);
    s.hand.splice(idx, 1);
    if (side === 'player') ZY.Audio.play('place');
    const formed = checkHeroes(state, side);
    return { ok: true, unit: u, hero: formed };
  }

  /** 棋盘内拖动：合成 / 移动 */
  function dropUnitOn(state, side, unitId, r, c) {
    const u = state.units.find(function (x) { return x.id === unitId; });
    if (!u || u.dead || u.side !== side) return { ok: false, msg: '只能移动自己的字块' };
    if (r === u.row && c === u.col) return { ok: false, silent: true };
    const t = state.grid[r][c];
    if (t) {
      // 目标格有单位 → 只可能是合成。
      // 合成不限半区：已经推进到对方半区的己方单位，彼此遇到照样能合。
      if (t.side !== side) return { ok: false, msg: '不能叠到敌方单位上' };
      if (u.cls === 'soldier' && t.cls === 'soldier' && u.type === t.type && u.level === t.level
        && u.level < C.MAX_LEVEL) {
        t.level++;
        restatUnit(state, t);
        removeUnit(state, u, true);
        if (side === 'player') {
          ZY.Audio.play('merge');
          state.fx.push({ type: 'merge', row: r, col: c, text: '+1 级 → ' + t.level });
        }
        return { ok: true, merged: true };
      }
      if (u.cls === 'soldier' && t.cls === 'soldier' && u.type === t.type && u.level >= C.MAX_LEVEL) {
        return { ok: false, msg: '已满级，不能再合成' };
      }
      return { ok: false, msg: '只有同字同级才能合成' };
    }
    // 移动到空格：只能在己方半区
    if (!B.isOwnRow(side, r)) return { ok: false, msg: '只能放在己方半区' };
    if (state.locked[B.key(r, c)]) return { ok: false, msg: '锁定格，需要铲子开启' };
    state.grid[u.row][u.col] = null;
    u.row = r; u.col = c;
    state.grid[r][c] = u;
    if (side === 'player') ZY.Audio.play('place');
    const formed = checkHeroes(state, side);
    return { ok: true, moved: true, hero: formed };
  }

  /** 武将合成：同一行横向相邻、从左到右凑成武将名 */
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
        const h = makeUnit(state, side, {
          cls: 'hero', heroId: hero.id, heroLevel: 1, row: r, col: c,
        });
        addUnit(state, h);
        formed = h;
        if (side === 'player') {
          ZY.Audio.play('hero');
          state.fx.push({ type: 'hero', row: r, col: c, text: hero.name + ' 参上！' });
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
    if (!B.isOwnRow(side, r)) return { ok: false, msg: '只能开己方半区的锁定格' };
    if (!state.locked[B.key(r, c)]) return { ok: false, msg: '这一格没有上锁' };
    delete state.locked[B.key(r, c)];
    if (side === 'player') {
      ZY.Audio.play('item');
      state.fx.push({ type: 'open', row: r, col: c, text: '开启' });
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
      u.char = next;
      u.type = ZY.CHAR2TYPE[next];
      const st = ZY.statsAt(u.type, u.level);
      const ratio = u.maxHp > 0 ? u.hp / u.maxHp : 1;
      u.maxHp = st.hp; u.atk = st.atk; u.aspd = st.aspd; u.range = U[u.type].range;
      u.move = U[u.type].move; u.pierce = !!U[u.type].pierce; u.splash = U[u.type].splash || 0;
      u.hp = Math.max(1, u.maxHp * ratio);
    }
    if (side === 'player') {
      ZY.Audio.play('item');
      state.fx.push({ type: 'brush', row: u.row, col: u.col, text: '改写 → ' + u.char });
    }
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
    const state = {
      mode: mode,
      difficulty: num(opts.difficulty, 1),
      levelIdx: num(opts.levelIdx, 0),
      levelName: mode === 'level' ? ZY.LEVELS[num(opts.levelIdx, 0)].name : '',
      t: 0, paused: false, over: false, result: null,
      grid: B.createGrid(), locked: {}, units: [],
      nextId: 1, nextCardId: 1,
      player: { bun: C.START_BUN, adou: C.ADOU_HP, hand: [], kills: 0 },
      enemy: { bun: C.START_BUN, adou: C.ADOU_HP, hand: [], kills: 0 },
      buff: { player: 0, enemy: 0 },
      hasAdou: { player: true, enemy: mode === 'versus' },
      wave: { idx: 0, timer: 0, interval: mode === 'endless' ? ZY.TUNE.endlessInterval : ZY.TUNE.levelFirstGap, pending: [], spawnT: 0, done: false, lanes: [] },
      aiT: 0,
      fx: [],
      banner: null,
      stats: { kills: 0, waves: 0, duration: 0 },
    };
    if (mode === 'versus') {
      const pl = B.rollLocked(4, 'player'), el = B.rollLocked(4, 'enemy');
      Object.keys(pl).forEach(function (k) { state.locked[k] = true; });
      Object.keys(el).forEach(function (k) { state.locked[k] = true; });
    } else {
      const pl = B.rollLocked(6, 'player');
      Object.keys(pl).forEach(function (k) { state.locked[k] = true; });
    }
    return state;
  }

  /** 关卡模式：沿用上一关的棋盘 / 手牌 / 馒头，阿斗重置为 3；过关后全军整补回满血
   *  noBonus = true 用于「本关失败重来」：部队按进关时的状态还原，但不重复发战利品 */
  function inherit(state, prev, noBonus) {
    if (!prev) { seedArmy(state, state.levelIdx); return state; }
    state.player.bun = prev.player.bun + (noBonus ? 0 : C.LEVEL_CLEAR_BONUS);
    state.player.hand = prev.player.hand.slice();
    state.locked = {};
    Object.keys(prev.locked).forEach(function (k) { state.locked[k] = true; });
    state.nextId = prev.nextId;
    state.nextCardId = prev.nextCardId;
    prev.units.forEach(function (u) {
      if (u.side !== 'player' || u.dead) return;
      const nu = makeUnit(state, 'player', {
        cls: u.cls, type: u.type, char: u.char, heroId: u.heroId,
        heroLevel: u.heroLevel, level: u.level, row: u.row, col: u.col,
      });
      nu.hp = nu.maxHp;                 // 过关整军：带伤进入下一关只会越打越残
      nu.kills = u.kills;
      nu.skillT = u.skillT;
      addUnit(state, nu);
    });
    return state;
  }

  /** 中途开档（存档停在第 N 关）时补一支「当前进度该有的部队」，
   *  否则空着手打第 4 关必然是死局。 */
  function seedArmy(state, idx) {
    if (!idx) return;
    const lv = clamp(1 + Math.floor(idx / 2), 1, 3);
    const n = Math.min(2 + idx, 6);
    const types = ['dao', 'qiang', 'gong', 'dao', 'qi', 'qiang'];
    let placed = 0;
    for (let r = 8; r <= 9 && placed < n; r++) {
      for (let c = 0; c < B.COLS && placed < n; c += 2) {
        if (!B.canPlace(state, 'player', r, c)) continue;
        const u = makeUnit(state, 'player', {
          cls: 'soldier', type: types[placed % types.length], level: lv, row: r, col: c,
        });
        addUnit(state, u);
        placed++;
      }
    }
    state.player.bun += 30 * idx;
  }

  ZY.Game = {
    TICK: TICK,
    baseState: baseState,
    inherit: inherit,
    seedArmy: seedArmy,
    tick: tick,
    recruit: recruit,
    deploy: deploy,
    dropUnitOn: dropUnitOn,
    checkHeroes: checkHeroes,
    useShovel: useShovel,
    useBrush: useBrush,
    useWarcry: useWarcry,
    endGame: endGame,
    sideState: sideState,
    cardLabel: cardLabel,
    makeUnit: makeUnit,
    addUnit: addUnit,
    removeUnit: removeUnit,
  };
})(window.ZY);
