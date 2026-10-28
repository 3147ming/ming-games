/* =============================================================================
 * 赵云与阿斗 · 核心规则与主循环 (game.js)  — V5 原版对齐
 * 只管状态与规则，不碰 DOM；UI 层负责渲染与输入
 * 敌人沿预计算主路序列逐格走（不攻击、目标是走到阿斗）；
 * 兵种塔固定在地块上自动攻击射程内「最靠前」的敌人（武将塔横跨 2 格）；
 * 征兵 → 5 张进军营（5 槽）→ 拖进军牌（8 格，武将卡占 2 格）→ 拖到塔位建塔；
 * 同字同级喂养 +1 级；赵+云 等五对字在手牌合成武将卡（2 格宽）；
 * 单位击杀获经验（满 10 升 1 级，上限 5）；武器背包含铁剑（攻击+3）可装备武将；
 * 道具全部拖放释放（神兵符/毛笔/火球为卡牌，铲子为道具栏计数）。
 * ========================================================================== */
(function (ZY) {
  'use strict';

  const B = ZY.B;
  const C = ZY.C;
  const U = ZY.UNITS;
  const TICK = 0.1;               // 固定逻辑步长：10 tick / 秒
  const SPAWN_GAP = 0.35;         // 波次内逐个出兵间隔（突破口处会被缩短）
  const BREAK_W = 0.5;            // 突破口额外出怪权重

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
      row: spec.row, col: spec.col, span: spec.span || 1,   // V5：武将塔横跨 2 格
      hp: 0, maxHp: 0, atk: 0, aspd: 0, range: 1, move: 1,
      pierce: false, splash: 0, crit: 0, critMul: 1,
      dmgReduce: 0, noAttack: false, produce: 0,
      atkT: 0, moveT: 0, stun: 0,
      kills: 0, xp: 0, weapon: spec.weapon || null,          // V5：经验值 / 装备武器
      skillCd: 0, skillT: 0,
      elite: !!spec.elite, dead: false,
      /* V4 塔防：行军敌人专属 —— target=冲谁来的（哪侧阿斗），path=主路序列，pi=走到第几格
       * 塔（含武将塔）不行军：deploy/synth 显式传 target:null */
      target: spec.target !== undefined ? spec.target : (side === 'enemy' ? 'player' : null),
      path: spec.path || null, pi: spec.pi || 0,
    };
    if (side === 'enemy' && u.target && !u.path) {
      u.path = B.pathSeq(state.mode, u.target, state.levelIdx);
      if (spec.pi == null) u.pi = 0;          // 调用方显式给了 pi（如从半路放置）则尊重之
    }

    if (u.boss) {
      const kinds = (ZY.BOSSES && ZY.BOSSES.length) ? ZY.BOSSES : [ZY.BOSS];
      let bi = (typeof spec.bossKind === 'number') ? spec.bossKind : 0;
      if (bi < 0 || bi >= kinds.length) bi = 0;
      const bo = kinds[bi];
      u.bossKind = bi; u.bossId = bo.id; u.bossSkill = bo.skill || null;
      const hpMul = num(spec.hpMul, 1) * bo.hpMul;
      const atkMul = num(spec.atkMul, 1) * bo.atkMul;
      u.char = bo.char; u.name = bo.name;     // 带名武将（张梁 / 张宝 / 张角）
      u.maxHp = bo.hp * hpMul; u.hp = u.maxHp;
      u.atk = bo.atk * atkMul; u.aspd = bo.aspd; u.range = bo.range; u.move = bo.move;
      u.skillCd = bo.skillCd; u.skillT = bo.skillCd;   // 出场先攒一次冷却
      if (ZY.Save && ZY.Save.markCodex) ZY.Save.markCodex('boss:' + bo.id);
    } else if (u.cls === 'hero') {
      const h = ZY.HERO_BY_ID[u.heroId];
      const st = ZY.heroStats(u.heroId, u.heroLevel);
      if (ZY.Save && ZY.Save.markCodex) ZY.Save.markCodex('hero:' + u.heroId);
      u.char = h.name;
      u.maxHp = st.hp; u.hp = st.hp;
      u.atk = st.atk + weaponAtk(u); u.aspd = st.aspd + weaponMod(u, 'aspd'); u.range = st.range + weaponMod(u, 'range'); u.move = st.move;
      u.pierce = st.pierce; u.splash = st.splash;
      u.crit = st.crit; u.critMul = st.critMul; u.dmgReduce = st.dmgReduce;
      u.noAttack = st.noAttack;
      u.skillCd = h.skill.cd; u.skillT = h.skill.cd;
    } else {
      if (!u.char && U[u.type]) u.char = U[u.type].char;
      if (ZY.Save && ZY.Save.markCodex && u.type) ZY.Save.markCodex('unit:' + u.type);
      const st = ZY.statsAt(u.type, u.level);
      const hpMul = num(spec.hpMul, 1), atkMul = num(spec.atkMul, 1);
      const em = u.elite ? C.ELITE_MUL : 1;          // V8.1：精英基础 hp/atk ×1.25（与敌方 +25% 同一口径）
      u.maxHp = st.hp * hpMul * em; u.hp = u.maxHp;
      u.atk = st.atk * atkMul * em;
      u.aspd = st.aspd; u.range = U[u.type].range; u.move = U[u.type].move;
      u.pierce = !!U[u.type].pierce; u.splash = U[u.type].splash || 0;
      u.produce = U[u.type].produce || 0;
      u.noAttack = u.atk <= 0;
      /* 第一批：精英词条 —— 按 id 轮转（同种子可复现），只给行军敌人挂 */
      if (u.elite && u.side === 'enemy' && ZY.ELITE_TRAITS && ZY.ELITE_TRAITS.length) {
        const tr = ZY.ELITE_TRAITS[u.id % ZY.ELITE_TRAITS.length];
        u.trait = tr.id; u.traitName = tr.name; u.traitTag = tr.tag;
        if (tr.hp) { u.maxHp *= tr.hp; u.hp = u.maxHp; }
        if (tr.dmgReduce) u.dmgReduce = (u.dmgReduce || 0) + tr.dmgReduce;
        if (tr.move) u.move = u.move / tr.move;      // move = 每格耗时（秒），除的是速度倍率
      }
    }

    // 击杀赏金：敌方行军单位才给赏金（塔不给对方送经济）
    if (u.boss) u.bounty = C.BOSS_BOUNTY;
    else if (u.side === 'enemy') u.bounty = (u.cls === 'hero') ? 6 : (u.elite ? C.ELITE_BOUNTY : C.NORMAL_BOUNTY);
    else u.bounty = 0;
    return u;
  }

  /** 装备攻击加成（铁剑 +3） */
  function weaponAtk(u) {
    if (!u || !u.weapon) return 0;
    const w = ZY.WEAPONS[u.weapon];
    return w ? w.atk : 0;
  }
  /** 第一批：武器除攻击外还带攻速 / 射程修正（青釭 +15% 攻速、的卢 +1 射程） */
  function weaponMod(u, key) {
    if (!u || !u.weapon) return 0;
    const w = ZY.WEAPONS[u.weapon];
    return (w && w[key]) || 0;
  }

  function addUnit(state, u) {
    state.grid[u.row][u.col] = u;
    if (u.span > 1) {                                   // 武将塔：右邻格同占
      const c2 = u.col + 1;
      if (c2 < B.COLS) state.grid[u.row][c2] = u;
    }
    state.units.push(u);
    return u;
  }

  function removeUnit(state, u, silent) {
    u.dead = true;
    if (state.grid[u.row] && state.grid[u.row][u.col] === u) state.grid[u.row][u.col] = null;
    if (u.span > 1) {
      const c2 = u.col + 1;
      if (state.grid[u.row] && state.grid[u.row][c2] === u) state.grid[u.row][c2] = null;
    }
    if (!silent) state.fx.push({ type: 'die', row: u.row, col: u.col, big: (u.elite || u.boss) });
  }

  function restatUnit(state, u) {
    const ratio = u.maxHp > 0 ? clamp(u.hp / u.maxHp, 0, 1) : 1;
    if (u.cls === 'hero') {
      const st = ZY.heroStats(u.heroId, u.heroLevel);
      u.maxHp = st.hp; u.atk = st.atk + weaponAtk(u); u.aspd = st.aspd + weaponMod(u, 'aspd'); u.range = st.range + weaponMod(u, 'range'); u.move = st.move;
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

  /** 击杀入账（赏金 / 计数 / 经验 / 飘字），killerSide 为凶手阵营 */
  function creditKill(state, killerSide, tgt) {
    const s = sideState(state, killerSide);
    if (!s) return;
    s.bun += tgt.bounty;
    s.kills++;
    state.fx.push({ type: 'bun', row: tgt.row, col: tgt.col, text: '+' + tgt.bounty });   // 击杀普通敌人飘字 +1
    if (tgt.side === 'enemy' && tgt.target === 'player') state.stats.kills++;
    if (tgt.boss) { state.bossKilled = true; state.banner = { text: '强敌倒下', life: 2.2 }; state.fx.push({ type: 'shake' }); }
    if (tgt.elite) state.fx.push({ type: 'big', row: tgt.row, col: tgt.col, text: '精英倒下' });
  }

  function killUnit(state, src, tgt) {
    if (tgt.dead) return;
    const killerSide = src ? src.side : (tgt.side === 'player' ? 'enemy' : 'player');
    creditKill(state, killerSide, tgt);
    if (src && src.id != null) {
      src.kills++;
      // V5：击杀获经验（推导：Lv1 敌 +1.2，3 只 = 3.6，对齐原版刘备面板 3.6/10）
      const gain = C.XP_PER_KILL * Math.max(1, tgt.level || 1) * (tgt.boss ? 5 : (tgt.elite ? 2 : 1));
      src.xp = (src.xp || 0) + gain;
    }
    removeUnit(state, tgt);
    ZY.Audio.play('kill');
  }

  /** V5：经验满 10 升 1 级（上限 5），士兵走 level / 武将走 heroLevel */
  function tryLevelUp(state, u) {
    if (!u || u.dead || u.xp < C.XP_PER_LEVEL) return false;
    const isHero = u.cls === 'hero';
    const lv = isHero ? u.heroLevel : u.level;
    if (lv >= C.MAX_LEVEL) { u.xp = C.XP_PER_LEVEL; return false; }   // 满级经验定格显示
    u.xp -= C.XP_PER_LEVEL;
    if (isHero) u.heroLevel++; else u.level++;
    restatUnit(state, u);
    state.fx.push({ type: 'up', row: u.row, col: u.col, text: (u.char || '') + ' 升级 Lv' + (isHero ? u.heroLevel : u.level) });
    if (u.side === 'player') ZY.Audio.play('hero');
    return true;
  }

  /* ------------------------------------------------------------ 阿斗受击 */
  /** 敌人踏入终点格（阿斗格）：掉 1 血 + 补偿资源 + 该敌人消失 */
  function adouHit(state, side, unit) {
    const s = sideState(state, side);
    state.leaked[side] = (state.leaked[side] || 0) + 1;   // 第一批：漏怪统计（被护盾吃掉的也算漏）
    /* 第一批：护心镜 —— 有盾先碎盾，不扣阿斗血 */
    if (state.shield[side] > 0) {
      state.shield[side] -= 1;
      const a0 = B.adouAt(state.mode, side, state.levelIdx);
      state.fx.push({ type: 'adou', row: a0.row, col: a0.col, text: '护盾 -1' });
      state.fx.push({ type: 'shake' });
      state.fx.push({ type: 'toast', text: '护心镜碎裂！抵下 1 次漏怪' });
      removeUnit(state, unit, true);
      ZY.Audio.play('item');
      return;
    }
    s.adou -= 1;
    s.bun += C.ADOU_BONUS;
    const a = B.adouAt(state.mode, side, state.levelIdx);
    state.fx.push({ type: 'adou', row: a.row, col: a.col, text: '阿斗 -1' });
    state.fx.push({ type: 'bun', row: a.row, col: a.col, text: '+' + C.ADOU_BONUS + ' 资源' });
    state.fx.push({ type: 'shake' });
    state.fx.push({ type: 'redflash' });
    removeUnit(state, unit, true);
    ZY.Audio.play('adou');
    if (side === 'player') {
      // 阿斗台词（原版）：血量告急
      if (s.adou === 1) state.fx.push({ type: 'toast', text: '阿斗：' + C.ADOU_LINE_LOW + '！' });
    }
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
    } else if (sk.type === 'cleave') {               // 马超：周围溅射
      const near = B.threatsInRange(state, u, 1);
      if (near.length) {
        near.forEach(function (t) { hurt(state, u, t, u.atk * 2); });
        state.fx.push({ type: 'ring', row: u.row, col: u.col }); fired = true;
      }
    } else if (sk.type === 'burn') {                 // 诸葛亮：范围内群伤 + 短眩晕
      const all = B.threatsInRange(state, u, 4);
      if (all.length) {
        all.forEach(function (t) {
          hurt(state, u, t, u.atk * 1.8);
          t.stun = Math.max(t.stun, 0.6);
          state.fx.push({ type: 'stun', row: t.row, col: t.col, text: '晕' });
        });
        state.fx.push({ type: 'ring', row: u.row, col: u.col });
        fired = true;
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
    }

    if (!fired) return false;
    u.skillT = sk.cd;
    /* V7：技能真正释放 → 表现钩子（技能名播报 + 专属粒子）；game.js 不直接写 DOM */
    if (ZY.UI && ZY.UI.onSkillCast) ZY.UI.onSkillCast(u);
    state.fx.push({ type: 'ring', row: u.row, col: u.col });
    state.fx.push({ type: 'shake' });
    ZY.Audio.play('skill');
    return true;
  }

  /** Boss（张梁）震击：对象 = 射程内守这条路的塔（u.target 侧） */
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
    /* V7：Boss 技能释放 → 播报「黄天当立！」+ 黄色法阵粒子 */
    if (ZY.UI && ZY.UI.onSkillCast) ZY.UI.onSkillCast(u);
    ZY.Audio.play('skill');
  }

  /* ------------------------------------------------------------ 行军：沿主路逐格走 */
  function walkPath(state, u, dt) {
    if (u.move <= 0 || !u.path) return;
    // V6 手感：出关第一步用 gateExit 快速腾出入口格，出关后恢复正常移速。
    //       否则单格入口被一个敌人占满移速周期，整波只能按「1 个 / 移速」滴出，
    //       关底张梁排到队尾可达 20s+（入口堵路节流）。
    let stepT = (u.pi === 0 ? Math.min(u.move, (ZY.TUNE && ZY.TUNE.gateExit) || 0.5) : u.move);
    if (u.slowT > 0) stepT /= (u.slowMul || 0.6);       // 第一批：号角减速（每格耗时拉长）
    u.moveT += dt;
    if (u.moveT < stepT) return;
    u.moveT = 0;
    const next = u.path[u.pi + 1];
    if (!next) return;                               // 已在终点（理论上进入终点即被移除）
    const adou = B.adouAt(state.mode, u.target, state.levelIdx);
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

    // 1) 自然收入（原版：资源自动 +1/s）+ 农民产出
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
    if (state.player.bun > (state.peakBun || 0)) state.peakBun = state.player.bun;   // 成就「富甲一方」用
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
      /* 第一批：连弩加速 / 号角减速的计时（塔与敌人都可能带） */
      if (u.crossbowT > 0) { u.crossbowT -= dt; if (u.crossbowT <= 0) { u.crossbowT = 0; u.crossbowMul = 1; } }
      if (u.slowT > 0) { u.slowT -= dt; if (u.slowT <= 0) { u.slowT = 0; u.slowMul = 1; } }
      if (u.stun > 0) { u.stun -= dt; continue; }
      if (u.skillCd > 0) {
        u.skillT -= dt;
        if (u.skillT <= 0) {
          if (u.boss) { castBossSkill(state, u); u.skillT = C.BOSS_SKILL_CD; }
          else if (!castSkill(state, u)) u.skillT = 0;
        }
      }
      if (u.dead) continue;
      tryLevelUp(state, u);                          // V5：经验升级
      if (u.dead) continue;
      if (u.side === 'enemy' && u.target) { walkPath(state, u, dt); continue; }   // 行军敌人：只走路，不攻击（塔 target=null，走攻击逻辑）
      if (u.noAttack && !u.produce) continue;        // 不攻击的产出单位
      if (u.produce) continue;                       // 农民：只产资源

      const targets = B.threatsInRange(state, u, u.range);
      if (targets.length) {
        const interval = u.aspd > 0 ? 1 / (u.aspd * (u.crossbowMul || 1)) : 1;
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
    /* 第一批 P1-8：压力闸门 —— 同屏敌人超过上限就暂缓出兵（不减少总量，只压节奏，
     * 避免低端机在波峰处掉帧；塔清得掉就自然恢复） */
    const cap = (ZY.TUNE && ZY.TUNE.pressureCap) || 26;
    let alive = 0;
    for (let i = 0; i < state.units.length; i++) {
      const u = state.units[i];
      if (u.side === 'enemy' && !u.dead) alive++;
    }
    if (w.pending.length && w.spawnT >= gap && alive < cap) {
      const spec = w.pending.shift();
      // V6：出兵成功才清零；入口仍被占则放回队首并保持阈值，下一 tick 立即重试
      //     （旧逻辑无条件归零，失败要白等一个完整 gap）
      if (spawnEnemyNow(state, spec)) w.spawnT = 0;
      else { w.pending.unshift(spec); w.spawnT = gap; }
    }
    if (w.done) return;
    w.timer += dt;
    if (w.timer >= w.interval && w.pending.length === 0) {
      w.timer = 0;
      startWave(state);
    }
  }

  /** 第一批 P0-5：收兵 —— 提前结束本波备战、立刻开下一波；
   *  提前的秒数按 3s = 1 资源折算（封顶 6），清完波的玩家可以换节奏换钱。 */
  function collectWave(state, side) {
    const w = state.wave;
    if (state.over || state.paused) return { ok: false, msg: '现在不能收兵' };
    if (w.done) return { ok: false, msg: '本局波次已结束' };
    if (w.pending.length) return { ok: false, msg: '本波还在出兵，等出完' };
    const left = Math.max(0, w.interval - w.timer);
    if (left <= 0.5) return { ok: false, msg: '下一波马上就到' };
    const gain = Math.min(6, Math.floor(left / 3));
    const s = sideState(state, side);
    if (s && gain > 0) s.bun += gain;
    w.timer = w.interval;                    // 下一个 tick 自然开波
    if (side === 'player') {
      ZY.Audio.play('tap');
      state.fx.push({ type: 'toast', text: '收兵出击！提前 ' + Math.round(left) + 's' + (gain ? '，+ ' + gain + ' 资源' : '') });
    }
    return { ok: true, gain: gain, left: left };
  }

  function startWave(state) {
    const w = state.wave;
    w.idx++;
    state.stats.waves = w.idx;

    const T = ZY.TUNE;
    let count, hpMul, atkMul, elites = 0, level, isBoss = false, bt = false;

    if (state.mode === 'endless' || state.mode === 'versus') {
      // 无尽 / 竞技共用一套波次配方（竞技 = 公共波次，spawnEnemyNow 镜像进双方路）
      // V8.1：每波 +1 起，后期再按波次微增（6 波 +1）—— 敌方波次压力整体上调
      count = Math.floor(T.endlessBase + w.idx * T.endlessStep) + 1 + Math.floor(w.idx / 6);
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
          st.items.shovel = (st.items.shovel || 0) + 1;      // 每 5 波奖励 1 把铲子
          const a = B.adouAt(state.mode, sd, state.levelIdx);
          state.fx.push({ type: 'bun', row: a ? a.row : 6, col: a ? a.col : 3, text: '波次奖励 +' + bonus });
        });
      }
      if (w.idx >= T.breakStart && w.idx === state.nextBreak) {
        bt = true;
        state.nextBreak = w.idx + T.breakMin + Math.floor(Math.random() * (T.breakMax - T.breakMin + 1));
      }
      if (state.mode === 'versus' && w.idx >= T.versusWaves) w.done = true;   // 竞技：打完公共波次即收官
    } else {                                          // 关卡：5 普通波 + 1 关底（第 6 波，强化波 + 关底名将）
      const lv = ZY.LEVELS[state.levelIdx];
      // 难度接线（第一批）：三个按钮 → 三项实际投放参数；键就是按钮的 data-diff
      const dk = (T.diff && T.diff[String(state.difficulty)]) || { hp: 1, atk: 1, count: 1 };
      // 修罗八阵（第一批）：0~3 层，只放大敌方 hp/atk
      const ascIdx = (typeof state.ascension === 'number') ? state.ascension
        : ((ZY.Save && ZY.Save.getAscension) ? ZY.Save.getAscension() : 0);
      const asc = (ZY.ASCEND_MUL && ZY.ASCEND_MUL[ascIdx]) || 1;
      isBoss = w.idx >= T.levelWaves;                 // 第 6 波 = 关底
      const baseCount = isBoss
        ? Math.round((lv.count + (T.levelWaves - 2) * T.levelStep) * T.bossCountMul) + 1
        : lv.count + (w.idx - 1) * T.levelStep + 1;   // V8.1：每波 +1（关底 +1）
      count = Math.max(1, Math.round(baseCount * dk.count));
      hpMul = lv.hpMul * (1 + T.levelHpRamp * (w.idx - 1)) * (isBoss ? T.bossHpMul : 1) * asc * dk.hp;
      atkMul = lv.atkMul * (1 + T.levelAtkRamp * (w.idx - 1)) * (isBoss ? T.bossAtkMul : 1) * asc * dk.atk;
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
      // V6 手感：关底名将「领队」先出（旧逻辑 push 到队尾，单车道吞吐 1/移速，排队太久）。
      // 第一批：按 LEVEL_BOSS 决定这一关是谁（张梁 / 张宝 / 张角）。
      const bk = (ZY.LEVEL_BOSS && ZY.LEVEL_BOSS[state.levelIdx]) || 0;
      state.bossKind = bk;
      w.pending.unshift({ type: 'boss', level: level, hpMul: hpMul, atkMul: atkMul, boss: true, bossKind: bk });
    }
    w.total = w.pending.length;                      // V5：波内总敌人数（左下角「剩 N」用）
    if (bt) {
      // 突破口：该波从入口集中出怪（数量 ×breakMul 权重，间隔减半）
      const extra = Math.max(1, Math.round(count * (T.breakMul - 1) * BREAK_W));
      for (let i = 0; i < extra; i++) {
        const pick = ZY.weighted(ZY.ENEMY_MIX);
        w.pending.push({ type: pick.type, level: level, hpMul: hpMul, atkMul: atkMul, elite: Math.random() < 0.2 });
      }
      w.total = w.pending.length;
      w.spawnGap = SPAWN_GAP * T.breakGapMul;
      w.breakEntrance = true;
    } else {
      w.spawnGap = SPAWN_GAP;
      w.breakEntrance = false;
    }
    state.banner = {
      text: '第 ' + w.idx + ' 波' +
            (state.mode === 'level' && isBoss ? ' · 关底' : '') +
            (bt ? ' · 突破口！' : '') + ' 来袭',
      life: 1.6,
    };
    if (state.mode !== 'versus') {
      // 阿斗台词（原版）：敌人来袭
      state.fx.push({ type: 'toast', text: '阿斗：' + C.ADOU_LINE_WAVE });
    }
    ZY.Audio.play('hurt');
  }

  /** 出一个敌人：竞技模式双方路各出一个（数量/强度对等） */
  function spawnEnemyNow(state, spec) {
    const targets = state.mode === 'versus' ? ['player', 'enemy'] : ['player'];
    const ents = targets.map(function (t) { return B.entrances(state.mode, t, state.levelIdx)[0]; });
    // 入口被堵 → 返回 false 由调用方放回队首、下一 tick 立即重试（V6 手感）
    if (!ents.every(function (e) { return B.inBoard(e.row, e.col) && !state.grid[e.row][e.col]; })) {
      return false;
    }
    targets.forEach(function (tgt, i) {
      const u = makeUnit(state, 'enemy', {
        cls: 'soldier', type: spec.type, level: spec.level,
        hpMul: spec.hpMul, atkMul: spec.atkMul, elite: spec.elite, boss: spec.boss,
        row: ents[i].row, col: ents[i].col, target: tgt,
      });
      addUnit(state, u);
      if (spec.boss && tgt === 'player') {
        // 第一批：登场播报按实际 Boss 名字（张梁 / 张宝 / 张角）
        state.fx.push({ type: 'toast', text: '敌方名将 ' + u.name + ' 登场！' });
        state.fx.push({ type: 'big', row: u.row, col: u.col, text: u.name });
      }
    });
    return true;
  }

  /* ------------------------------------------------------------ 胜负 */
  function checkEnd(state) {
    if (state.over) return;
    if (state.mode === 'level' && state.wave.done && state.wave.idx >= ZY.TUNE.levelWaves) {
      if (!state.wave.pending.length && !state.units.some(function (u) { return u.side === 'enemy'; })) {
        endGame(state, 'win');
      }
    }
    // 竞技：公共波次打满且路上敌军清空 → 先比阿斗剩血，持平比击杀，再持平比资源存量
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

  /** V5：关卡胜利星级（1-5 星）：基础 1 + 阿斗剩血（0-3）+ 时限内清完 +1 */
  function starsOf(state) {
    const par = ZY.C.LEVEL_WAVES * ZY.C.STAR_PAR_WAVE;
    let stars = 1 + Math.max(0, Math.min(ZY.C.ADOU_HP, state.player.adou));
    if (state.t <= par) stars++;
    return Math.max(1, Math.min(5, stars));
  }

  function endGame(state, result) {
    if (state.over) return;
    state.over = true;
    state.result = result;
    state.paused = false;
    if (result === 'win') ZY.Audio.play('win'); else ZY.Audio.play('lose');
    /* 第一批：战绩落盘 + 成就判定（纯数据，异常不影响结算） */
    try {
      if (ZY.Save && ZY.Save.addLog) {
        ZY.Save.addLog({
          date: Date.now(), mode: state.mode, levelIdx: state.levelIdx,
          result: result, wave: state.wave.idx, kills: state.stats.kills,
          dur: Math.round(state.t), leaked: state.leaked.player,
          ascension: state.ascension || 0, daily: !!state.daily,
        });
      }
      if (ZY.Achv && ZY.Achv.eval) ZY.Achv.eval(state, result);
    } catch (e) { /* noop */ }
  }

  /* ------------------------------------------------------------ 玩家操作 */
  /** V5 征兵：扣资源 → 成本 +2（不封顶）→ 一次 5 张进军营（5 槽，槽满则只填空槽） */
  function recruit(state, side) {
    const s = sideState(state, side);
    if (!s) return null;
    if (s.bun < s.recruitCost) return null;
    const free = C.BARRACKS_MAX - (s.barracks ? s.barracks.length : 0);
    if (free <= 0) return null;
    s.bun -= s.recruitCost;
    s.recruitCost += C.RECRUIT_STEP;                 // 原版：每次成功征兵 +2，不封顶
    const n = Math.min(C.BATCH, free);
    const cards = [];
    for (let i = 0; i < n; i++) {
      const card = ZY.rollRecruit(state, side);
      card.uid = state.nextCardId++;
      cards.push(card);
    }
    for (let i = 0; i < cards.length; i++) s.barracks.push(cards[i]);
    if (side === 'player') {
      ZY.Audio.play('recruit');
      state.fx.push({ type: 'toast', text: '征兵 ×' + cards.length + '（进军营）' });
    }
    return { cards: cards };
  }

  /** 军营 → 手牌：手牌格数（武将卡占 2）不超 8 才能转入 */
  function stageCard(state, side, uid) {
    const s = sideState(state, side);
    const i = (s.barracks || []).findIndex(function (x) { return x.uid === uid; });
    if (i < 0) return null;
    const card = s.barracks[i];
    if (ZY.handUsed(s) + ZY.cardSpan(card) > C.HAND_MAX) return null;
    s.barracks.splice(i, 1);
    s.hand.push(card);
    return card;
  }

  /** 在手牌/军营里找卡（拖拽落点统一走 deploy） */
  function findCard(s, uid) {
    let i = s.hand.findIndex(function (x) { return x.uid === uid; });
    if (i >= 0) return { card: s.hand[i], from: 'hand', i: i };
    i = (s.barracks || []).findIndex(function (x) { return x.uid === uid; });
    if (i >= 0) return { card: s.barracks[i], from: 'barracks', i: i };
    return null;
  }
  function removeCard(s, found) {
    if (found.from === 'hand') s.hand.splice(found.i, 1);
    else s.barracks.splice(found.i, 1);
  }

  function cardLabel(card) {
    if (card.kind === 'item') return ZY.ITEMS[card.item].name;
    if (card.kind === 'hero') return '武将卡「' + card.char + '」' + ((card.level || 1) > 1 ? ' ' + card.level + '★' : '') + '（占 2 格）';
    if (card.kind === 'gold') return '金字「' + card.char + '」';
    return '「' + card.char + '」' + U[card.type].name;
  }

  /** V5 武将字对合成：手里同时持有某对两个字 → 合成武将卡（2 格宽），弹「合成武将」提示 */
  function synthHero(state, side) {
    const s = sideState(state, side);
    const h = ZY.heroSynthReady(state, side);
    if (!h) return null;
    const iA = s.hand.findIndex(function (c) { return c.kind === 'gold' && c.char === h.chars[0]; });
    s.hand.splice(iA, 1);
    const iB = s.hand.findIndex(function (c) { return c.kind === 'gold' && c.char === h.chars[1]; });
    s.hand.splice(iB, 1);
    const card = { uid: state.nextCardId++, kind: 'hero', heroId: h.id, char: h.name, level: 1, span: 2 };
    s.hand.push(card);
    if (side === 'player') {
      ZY.Audio.play('hero');
      state.banner = { text: '合成武将 · ' + h.name, life: 1.8 };
      state.fx.push({ type: 'toast', text: '「' + h.name + '」合成！拖到塔位落下（横跨 2 格）' });
    }
    return card;
  }

  /** V6 合成深化：同名武将卡 ×2 → 升 1 星（level+1，封顶 MAX_LEVEL），仍占 2 格。
   *  字对 → 武将（Lv1）之上再叠一层「武将 → 升星」，把手牌里的重复将卡变成战力。 */
  function synthHeroStar(state, side) {
    const s = sideState(state, side);
    const heroId = ZY.heroStarReady(state, side);
    if (!heroId) return null;
    const idxs = [];
    for (let i = 0; i < s.hand.length && idxs.length < 2; i++) {
      const c = s.hand[i];
      if (c.kind === 'hero' && c.heroId === heroId && (c.level || 1) < C.MAX_LEVEL) idxs.push(i);
    }
    if (idxs.length < 2) return null;
    const lv = Math.min(C.MAX_LEVEL, Math.max(s.hand[idxs[0]].level || 1, s.hand[idxs[1]].level || 1) + 1);
    const hi = Math.max(idxs[0], idxs[1]), lo = Math.min(idxs[0], idxs[1]);
    s.hand.splice(hi, 1); s.hand.splice(lo, 1);          // 从后往前删，避免索引错位
    const h = ZY.HERO_BY_ID[heroId];
    const card = { uid: state.nextCardId++, kind: 'hero', heroId: heroId, char: h.name, level: lv, span: 2 };
    s.hand.push(card);
    if (side === 'player') {
      ZY.Audio.play('hero');
      state.banner = { text: '武将升星 · ' + h.name + ' ' + lv + '★', life: 1.8 };
      state.fx.push({ type: 'toast', text: '「' + h.name + '」升星至 ' + lv + ' 星！' });
    }
    return card;
  }

  /** 拖放落点：空格塔位 = 建塔（武将卡占 2 格）；己方塔上 = 同字合成 +1 级 */
  function deploy(state, side, cardUid, r, c) {
    const s = sideState(state, side);
    const found = findCard(s, cardUid);
    if (!found) return { ok: false, msg: '没有这张牌' };
    const card = found.card;
    if (card.kind === 'item') return { ok: false, msg: ZY.ITEMS[card.item].name + '要拖出去释放' };
    if (card.kind === 'gold') return { ok: false, msg: '金字「' + card.char + '」：与另一半在手牌里合成武将' };

    const t = state.grid[r] && state.grid[r][c];
    if (t) {
      // —— 落到己方塔上：V8 卡喂塔（仅 1 级塔）+ 同字合成 ——
      if (t.side !== side) return { ok: false, msg: '不能叠到敌方单位上' };
      if (card.kind !== 'unit' || t.cls !== 'soldier') return { ok: false, msg: '只有同字兵种塔才能合成' };
      if (t.type !== card.type) return { ok: false, msg: '兵种不同，无法合成' };
      if (t.level >= C.MAX_LEVEL) return { ok: false, msg: '已满级（' + C.MAX_LEVEL + ' 级），无法再合成' };
      if (t.level !== 1) return { ok: false, msg: '只有 1 级塔才能喂卡；同级塔可拖来合成升阶' };
      t.level++;
      restatUnit(state, t);
      removeCard(s, found);
      if (side === 'player') {
        ZY.Audio.play('merge');
        state.fx.push({ type: 'merge', row: r, col: c, text: t.char + '² 合成 Lv' + t.level });
      }
      return { ok: true, merged: true, level: t.level };
    }

    // —— 空格：建塔（武将卡 span=2） ——
    const span = ZY.cardSpan(card);
    if (!B.canPlace(state, side, r, c, span)) {
      if (B.isPath(state.mode, r, c, state.levelIdx)) return { ok: false, msg: '这里是主路，不能建塔' };
      if (B.isObstacle(r, c, state.mode, state.levelIdx)) return { ok: false, msg: '这里是荆棘障碍，不能建塔' };
      if (state.deploy[B.key(r, c)] !== side) return { ok: false, msg: '只能放在自己的塔位上' };
      if (span > 1) return { ok: false, msg: '武将塔要横跨 2 格，右侧放不下' };
      return { ok: false, msg: '这里放不了' };
    }
    const spec = {
      row: r, col: c, span: span,
      cls: card.kind === 'hero' ? 'hero' : 'soldier',
      type: card.kind === 'unit' ? card.type : null,
      char: card.char,
      heroId: card.kind === 'hero' ? card.heroId : null,
      level: 1, heroLevel: card.kind === 'hero' ? card.level : 1,
      target: null,                                  // 塔是防守单位，不冲任何阿斗
    };
    const u = makeUnit(state, side, spec);
    addUnit(state, u);
    removeCard(s, found);
    if (side === 'player') ZY.Audio.play('place');
    return { ok: true, unit: u };
  }

  /** V8 塔塔合成：拖一座兵种塔到另一座「同兵种、同等级」的己方兵种塔上 → 目标塔 +1 级，被吃塔消失（占地清空）。
   *  允许 1+1=2（与卡喂并存）；等级上限 5（4+4=5 后不可再合）；不同兵种 / 等级 / 满级 → 拒绝。 */
  function mergeTower(state, side, draggedId, r, c) {
    const u = state.units.find(function (x) { return x.id === draggedId; });
    if (!u || u.dead || u.side !== side || u.cls !== 'soldier') return { ok: false, msg: '只能合成己方的兵种塔' };
    const t = state.grid[r] && state.grid[r][c];
    if (!t || t.dead || t.side !== side || t.cls !== 'soldier') return { ok: false, msg: '要把塔拖到己方兵种塔上' };
    if (t.id === u.id) return { ok: false, msg: '不能和自己合成' };
    if (t.type !== u.type) return { ok: false, msg: '兵种不同，无法合成' };
    if (t.level !== u.level) return { ok: false, msg: '等级不同，只有同级才能合成' };
    if (t.level >= C.MAX_LEVEL) return { ok: false, msg: '已满级（' + C.MAX_LEVEL + ' 级），无法再合成' };
    t.level++;
    restatUnit(state, t);
    t.hp = t.maxHp;                             // 第一批 P1-13：合成即满血（不再「合完反而更脆」）
    removeUnit(state, u, true);                 // 被吃塔消失（清空占地，不触发死亡特效）
    const di = state.units.indexOf(u);          // 立即从单位表移除，避免拖拽来源滞留一帧
    if (di >= 0) state.units.splice(di, 1);
    if (side === 'player') {
      ZY.Audio.play('merge');
      state.fx.push({ type: 'merge', row: r, col: c, text: t.char + '² 合成 Lv' + t.level });
      state.fx.push({ type: 'toast', text: '塔塔合成 · ' + t.char + ' 升至 Lv' + t.level });
    }
    return { ok: true, merged: true, level: t.level, consumedId: u.id };
  }

  /** V5：拖塔换位——免费把已部署塔拖到另一个可放置格（三模式一致）。
   *  等级 / 合成状态 / 装备 / 经验 / 攻速计时（atkT）原样保留，不重置、不扣资源。 */
  function moveUnit(state, side, unitId, r, c) {
    const u = state.units.find(function (x) { return x.id === unitId; });
    if (!u || u.dead || u.side !== side) return { ok: false, msg: '没有这个单位' };
    if (u.row === r && u.col === c) return { ok: true, same: true, unit: u };   // 放回原地 = 无事发生
    if (!B.canPlace(state, side, r, c, u.span)) {
      if (B.isPath(state.mode, r, c, state.levelIdx)) return { ok: false, msg: '这里是主路，不能放塔' };
      if (B.isObstacle(r, c, state.mode, state.levelIdx)) return { ok: false, msg: '这里是荆棘障碍，不能放塔' };
      if (state.grid[r][c]) return { ok: false, msg: '这一格已经有单位了' };
      if (u.span > 1) return { ok: false, msg: '武将塔要横跨 2 格，右侧放不下' };
      if (state.deploy[B.key(r, c)] !== side) return { ok: false, msg: '只能放在自己的塔位上' };
      return { ok: false, msg: '这里放不了塔' };
    }
    // 双格记账：先清旧占位（span2 连带右邻格），再记新占位；不碰 dead/fx，atkT 原样
    if (state.grid[u.row] && state.grid[u.row][u.col] === u) state.grid[u.row][u.col] = null;
    if (u.span > 1) {
      const oc = u.col + 1;
      if (state.grid[u.row] && state.grid[u.row][oc] === u) state.grid[u.row][oc] = null;
    }
    u.row = r; u.col = c;
    state.grid[r][c] = u;
    if (u.span > 1 && c + 1 < B.COLS) state.grid[r][c + 1] = u;
    if (side === 'player') {
      ZY.Audio.play('tap');
      state.fx.push({ type: 'toast', text: (u.char || '塔') + ' 已换位 · 等级装备原样保留' });
    }
    return { ok: true, unit: u };
  }

  /* ------------------------------------------------------------ 道具（拖放释放） */
  /** 铲子（道具栏计数）：扩一格与塔位相邻的荒地 */
  function useShovel(state, side, r, c) {
    const s = sideState(state, side);
    if (!s || !s.items || !(s.items.shovel > 0)) return { ok: false, msg: '没有铲子了' };
    if (!B.inBoard(r, c)) return { ok: false, msg: '超出棋盘' };
    if (B.isPath(state.mode, r, c, state.levelIdx)) return { ok: false, msg: '主路格不能建塔' };
    if (B.isObstacle(r, c, state.mode, state.levelIdx)) return { ok: false, msg: '障碍格不能扩' };
    if (state.deploy[B.key(r, c)]) return { ok: false, msg: '这一格已经是塔位' };
    if (!B.adjacentToDeploy(state, side, r, c)) return { ok: false, msg: '铲子只能扩与塔位相邻的荒地' };
    state.deploy[B.key(r, c)] = side;
    s.items.shovel--;
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
    if (u.cls === 'soldier' && u.type === 'nong') return { ok: false, msg: '农民塔不能被毛笔改写' };
    const pool = ZY.SOLDIER_CHARS;
    const candidates = pool.filter(function (ch) { return ch !== u.char; });
    const next = candidates[Math.floor(Math.random() * candidates.length)];
    u.char = next; u.type = ZY.CHAR2TYPE[next];
    const st = ZY.statsAt(u.type, u.level);
    const ratio = u.maxHp > 0 ? u.hp / u.maxHp : 1;
    u.maxHp = st.hp; u.atk = st.atk; u.aspd = st.aspd; u.range = U[u.type].range;
    u.move = U[u.type].move; u.pierce = !!U[u.type].pierce; u.splash = U[u.type].splash || 0;
    u.hp = Math.max(1, u.maxHp * ratio);
    if (side === 'player') { ZY.Audio.play('item'); state.fx.push({ type: 'brush', row: u.row, col: u.col, text: '改写 → ' + u.char }); }
    return { ok: true };
  }

  function useWarcry(state, side) {
    state.buff[side] = C.WARCRY_TIME;
    if (side === 'player') {
      ZY.Audio.play('item');
      state.banner = { text: '神兵符！全队攻击 ×' + C.WARCRY_MULT + '（' + C.WARCRY_TIME + 's）', life: 1.6 };
    }
    return { ok: true };
  }

  /** 第一批 · 护心镜：阿斗叠 1 层护盾（抵挡 1 次漏怪，不扣血） */
  function useMirror(state, side) {
    state.shield[side] = (state.shield[side] || 0) + 1;
    if (side === 'player') {
      ZY.Audio.play('item');
      state.banner = { text: '护心镜！阿斗护盾 ×' + state.shield[side], life: 1.6 };
    }
    return { ok: true, shield: state.shield[side] };
  }

  /** 第一批 · 连弩：该塔攻速 ×1.35，持续 15 秒（重复使用刷新时长） */
  function useCrossbow(state, side, unitId) {
    const u = state.units.find(function (x) { return x.id === unitId; });
    if (!u || u.dead) return { ok: false, msg: '目标塔不存在' };
    if (u.side !== side) return { ok: false, msg: '连弩只能给自己人' };
    if (u.noAttack) return { ok: false, msg: '这个单位不攻击，装了没用' };
    u.crossbowMul = 1.35; u.crossbowT = 15;
    if (side === 'player') ZY.Audio.play('item');
    return { ok: true };
  }

  /** 第一批 · 号角：全体冲该侧的敌人减速 40%，持续 5 秒 */
  function useHorn(state, side) {
    let n = 0;
    state.units.forEach(function (u) {
      if (u.dead || u.side !== 'enemy' || u.target !== side) return;
      u.slowMul = 0.6; u.slowT = 5; n++;
    });
    if (side === 'player') {
      ZY.Audio.play('item');
      state.banner = { text: '号角！敌军减速 40%（5s）· ' + n + ' 人', life: 1.6 };
    }
    return { ok: true, hit: n };
  }

  /** 火球：落点 3×3 内「冲我来的」敌人各受 80 固定伤害 + 爆炸特效 */
  function useFireball(state, side, row, col) {
    let hit = 0;
    // 第一批：火球随波缩放 —— 第 1 波仍是 80，之后每波 +6%，封顶 ×2.5
    const wv = Math.max(1, (state.wave && state.wave.idx) || 1);
    const scale = Math.min((ZY.TUNE && ZY.TUNE.fireballCap) || 2.5,
      1 + (wv - 1) * ((ZY.TUNE && ZY.TUNE.fireballPerWave) || 0.06));
    const dmg = C.FIREBALL_DMG * scale;
    const foes = state.units.filter(function (t) {
      return !t.dead && t.side === 'enemy' && t.target === side;
    });
    foes.forEach(function (t) {
      if (Math.max(Math.abs(t.row - row), Math.abs(t.col - col)) <= C.FIREBALL_RADIUS) {
        hurtFixed(state, side, t, dmg);
        hit++;
      }
    });
    state.fx.push({ type: 'boom', row: row, col: col });
    state.fx.push({ type: 'shake' });
    if (side === 'player') ZY.Audio.play('boom');
    return { ok: true, hit: hit };
  }

  /* ------------------------------------------------------------ 武器装备 */
  /** 装备武器给武将（背包含该武器）；换装自动归还旧武器 */
  function equipWeapon(state, side, unitId, weaponId) {
    const s = sideState(state, side);
    const u = state.units.find(function (x) { return x.id === unitId; });
    if (!u || u.dead || u.side !== side) return { ok: false, msg: '只能给己方单位装备' };
    if (u.cls !== 'hero') return { ok: false, msg: '武器只能装备给武将' };
    const w = ZY.WEAPONS[weaponId];
    if (!w) return { ok: false, msg: '没有这件武器' };
    if (!s.weapons || !(s.weapons[weaponId] > 0)) return { ok: false, msg: '武器背包里没有' + w.name };
    if (u.weapon) s.weapons[u.weapon] = (s.weapons[u.weapon] || 0) + 1;
    s.weapons[weaponId]--;
    u.weapon = weaponId;
    if (ZY.Save && ZY.Save.markCodex) ZY.Save.markCodex('weapon:' + weaponId);
    restatUnit(state, u);
    if (side === 'player') {
      state.fx.push({ type: 'brush', row: u.row, col: u.col, text: '装备 ' + w.name + '（攻击+' + w.atk + '）' });
      ZY.Audio.play('item');
    }
    return { ok: true, weapon: w, atk: u.atk };
  }

  function unequipWeapon(state, side, unitId) {
    const s = sideState(state, side);
    const u = state.units.find(function (x) { return x.id === unitId; });
    if (!u || u.dead || u.side !== side || !u.weapon) return { ok: false, msg: '没有可卸下的武器' };
    const w = ZY.WEAPONS[u.weapon];
    s.weapons[u.weapon] = (s.weapons[u.weapon] || 0) + 1;
    u.weapon = null;
    restatUnit(state, u);
    if (side === 'player') state.fx.push({ type: 'brush', row: u.row, col: u.col, text: '卸下 ' + w.name });
    return { ok: true };
  }

  /* ------------------------------------------------------------ 建立对局 */
  function baseState(mode, opts) {
    opts = opts || {};
    const T = ZY.TUNE;
    const state = {
      mode: mode, difficulty: num(opts.difficulty, 1),
      levelIdx: num(opts.levelIdx, 0),
      ascension: num(opts.ascension, 0),      // 第一批：修罗八阵层级（0~3）
      daily: !!opts.daily,                    // 第一批：今日之战标记
      levelName: mode === 'level' ? ZY.LEVELS[num(opts.levelIdx, 0)].name : '',
      t: 0, paused: false, over: false, result: null, speed: 1,
      grid: B.createGrid(), units: [], deploy: {},
      nextBreak: T.breakStart, levelBtDone: false,
      nextId: 1, nextCardId: 1,
      player: freshSide(),
      enemy: freshSide(),
      buff: { player: 0, enemy: 0 },
      shield: { player: 0, enemy: 0 },     // 第一批：护心镜层数
      leaked: { player: 0, enemy: 0 },     // 第一批：漏怪统计（踏进阿斗格即 +1）
      hasAdou: { player: true, enemy: mode === 'versus' },
      wave: { idx: 0, timer: 0, interval: mode === 'level' ? T.levelFirstGap : T.endlessInterval, pending: [], spawnT: 0, spawnGap: SPAWN_GAP, done: false, breakEntrance: false, total: 0 },
      aiT: 0, fx: [], banner: null, stats: { kills: 0, waves: 0, duration: 0 },
    };
    state.deploy = B.startSlots(mode, 'player', state.levelIdx);
    if (mode === 'versus') {
      const es = B.startSlots(mode, 'enemy', state.levelIdx);
      Object.keys(es).forEach(function (k) { state.deploy[k] = 'enemy'; });
    }
    return state;
  }

  /** V5 一侧状态：资源 / 阿斗 / 军营(5) / 手牌(8) / 道具栏 / 武器背包 */
  function freshSide() {
    return {
      bun: C.START_BUN, adou: C.ADOU_HP,
      hand: [], barracks: [],
      items: { shovel: C.SHOVEL_START },
      weapons: { tiejian: 1 },                 // 开局送 1 把铁剑（攻击+3）
      kills: 0, recruitCost: C.RECRUIT_BASE_COST,
    };
  }

  function inherit(state, prev, noBonus) {
    if (!prev) { seedArmy(state, state.levelIdx); return state; }
    state.player.recruitCost = C.RECRUIT_BASE_COST;        // 每关重置征兵成本
    state.player.bun = prev.player.bun + (noBonus ? 0 : C.LEVEL_CLEAR_BONUS);
    state.player.hand = prev.player.hand.slice();
    state.player.barracks = (prev.player.barracks || []).slice();
    state.player.items = Object.assign({}, prev.player.items);
    state.player.weapons = Object.assign({}, prev.player.weapons);
    state.deploy = {};
    Object.keys(prev.deploy).forEach(function (k) { state.deploy[k] = prev.deploy[k]; });
    state.nextId = prev.nextId;
    state.nextCardId = prev.nextCardId;
    prev.units.forEach(function (u) {
      if (u.side !== 'player' || u.dead) return;
      const nu = makeUnit(state, 'player', {
        cls: u.cls, type: u.type, char: u.char, heroId: u.heroId,
        heroLevel: u.heroLevel, level: u.level, row: u.row, col: u.col,
        span: u.span, weapon: u.weapon,
      });
      nu.hp = nu.maxHp;
      nu.kills = u.kills; nu.xp = u.xp || 0; nu.skillT = u.skillT;
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

  /** 第一批 P1-9：拆塔 —— 拖到荒地上即拆除，返还 50% 估算造价（2×等级） */
  function demolish(state, side, unitId) {
    const u = state.units.find(function (x) { return x.id === unitId; });
    if (!u || u.dead || u.side !== side) return { ok: false, msg: '没有这个塔' };
    if (u.cls === 'hero') return { ok: false, msg: '武将不能拆，先拖到别的塔位' };
    const refund = Math.max(1, Math.round(2 * (u.level || 1)));
    const s = sideState(state, side);
    if (s) s.bun += refund;
    removeUnit(state, u, true);
    const di = state.units.indexOf(u);
    if (di >= 0) state.units.splice(di, 1);
    if (side === 'player') {
      ZY.Audio.play('merge');
      state.fx.push({ type: 'toast', text: '拆塔 · 返还 ' + refund + ' 资源' });
    }
    return { ok: true, refund: refund };
  }

  /** 第一批 P0-7：安全区判定 —— 敌人距阿斗 ≤ 2 格（切比雪夫）即为「告急」，不暂停只提示 */
  function adouDanger(state, side) {
    if (!state.hasAdou[side]) return { danger: false, n: 0, dist: 99 };
    const a = B.adouAt(state.mode, side, state.levelIdx);
    if (!a) return { danger: false, n: 0, dist: 99 };
    let n = 0, best = 99;
    for (let i = 0; i < state.units.length; i++) {
      const u = state.units[i];
      if (u.dead || u.side !== 'enemy' || u.target !== side) continue;
      const d = Math.max(Math.abs(u.row - a.row), Math.abs(u.col - a.col));
      if (d < best) best = d;
      if (d <= 2) n++;
    }
    return { danger: n > 0, n: n, dist: best };
  }

  /* ------------------------------------------------------------ 成就判定（第一批 12 条） */
  const Achv = {
    list: function () { return ZY.ACHV || []; },
    eval: function (state, result) {
      if (!state || !ZY.Save || !ZY.Save.unlockAchv) return [];
      const got = [];
      const win = result === 'win';
      const unlock = function (id, cond) { if (cond && ZY.Save.unlockAchv(id)) got.push(id); };
      const stars = (ZY.Game && ZY.Game.starsOf) ? ZY.Game.starsOf(state) : 0;
      unlock('first_win', win && state.mode === 'level');
      unlock('no_leak', win && state.mode === 'level' && (state.leaked.player || 0) === 0);
      unlock('five_star', win && state.mode === 'level' && stars >= 5);
      unlock('boss_slayer', !!state.bossKilled);
      unlock('endless_10', state.mode === 'endless' && state.wave.idx >= 10);
      unlock('endless_20', state.mode === 'endless' && state.wave.idx >= 20);
      unlock('kill_300', (ZY.Save.getKillTotal() + (state.stats.kills || 0)) >= 300);
      unlock('all_weapons', ZY.Save.codexCount('weapon:') >= 4);
      unlock('codex_half', ZY.Save.codexCount() >= 12);
      unlock('ascend_1', win && state.mode === 'level' && (state.ascension || 0) >= 1);
      unlock('daily_once', !!state.daily && state.over);
      unlock('rich', (state.peakBun || 0) >= 300);
      state.newAchv = got;
      if (got.length && state.fx) {
        const all = Achv.list();
        got.slice(0, 3).forEach(function (id) {
          const a = all.find(function (x) { return x.id === id; });
          if (a) state.fx.push({ type: 'toast', text: '成就解锁 · ' + a.name });
        });
      }
      return got;
    },
  };
  ZY.Achv = Achv;

  ZY.Game = {
    TICK: TICK, SPAWN_GAP: SPAWN_GAP,
    baseState: baseState, inherit: inherit, seedArmy: seedArmy,
    tick: tick, recruit: recruit, stageCard: stageCard, deploy: deploy, mergeTower: mergeTower,
    synthHero: synthHero, synthHeroStar: synthHeroStar, useShovel: useShovel, useBrush: useBrush,
    useWarcry: useWarcry, useFireball: useFireball,
    useMirror: useMirror, useCrossbow: useCrossbow, useHorn: useHorn,
    collectWave: collectWave, demolish: demolish, adouDanger: adouDanger,
    Achv: Achv,
    equipWeapon: equipWeapon, unequipWeapon: unequipWeapon,
    endGame: endGame, sideState: sideState, cardLabel: cardLabel,
    makeUnit: makeUnit, addUnit: addUnit, removeUnit: removeUnit, moveUnit: moveUnit,
    hurt: hurt, hurtFixed: hurtFixed, starsOf: starsOf,
  };
})(window.ZY);
