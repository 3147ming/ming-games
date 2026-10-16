/* =============================================================================
 * 赵云与阿斗 · 界面与交互 (ui.js)
 * 渲染、拖拽（pointer 统一鼠标 / 触屏）、飘字特效、结算面板
 * ========================================================================== */
(function (ZY) {
  'use strict';

  const B = ZY.B;
  const C = ZY.C;
  const U = ZY.UNITS;

  let state = null;
  let raf = 0, lastTs = 0, acc = 0;
  let cellEls = [], unitEls = {}, adouEls = {};
  let carry = null;                 // 关卡模式跨关继承
  let pendingLevel = 0;

  const drag = { active: false, src: null, uid: 0, unitId: 0, sx: 0, sy: 0, moved: false, el: null, cell: null };
  let armed = null;                 // {kind:'shovel'|'brush', uid}

  const el = {};
  function $(id) { return document.getElementById(id); }

  /* ======================================================== 初始化 */
  function init() {
    el.start = $('screen-start');
    el.game = $('screen-game');
    el.board = $('board');
    el.cells = $('cells');
    el.units = $('units');
    el.fx = $('fx');
    el.rangeRing = document.createElement('div');
    el.rangeRing.className = 'range-ring keep';
    el.fx.appendChild(el.rangeRing);
    el.redflash = $('redflash');
    el.midline = $('midline');
    el.hand = $('hand');
    el.btnRecruit = $('btn-recruit');
    el.hudMode = $('hud-mode');
    el.hudWave = $('hud-wave');
    el.hpPlayer = $('hp-player');
    el.hpEnemy = $('hp-enemy');
    el.hpEnemyLine = $('hp-enemy-line');
    el.hudBun = $('hud-bun');
    el.btnPause = $('btn-pause');
    el.btnMute = $('btn-mute');
    el.banner = $('banner');
    el.toast = $('toast');
    el.overlay = $('overlay');
    el.saveInfo = $('save-info');

    buildCells();
    bindStart();
    bindGame();
    refreshSave();
    setMute(ZY.Save.getMuted());
    loop();
  }

  /* ======================================================== 开始界面 */
  function bindStart() {
    const btns = document.querySelectorAll('.mode-btn');
    Array.prototype.forEach.call(btns, function (b) {
      b.addEventListener('click', function () {
        const mode = b.getAttribute('data-mode');
        const diff = parseFloat(getActiveDiff());
        ZY.Audio.unlock();
        if (mode === 'level') {
          startLevelRun(ZY.Save.getLevel(), null);
        } else {
          state = ZY.Game.baseState(mode, { difficulty: diff });
          enterGame();
        }
      });
    });
    const diffs = document.querySelectorAll('.diff-btn');
    Array.prototype.forEach.call(diffs, function (b) {
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(diffs, function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        ZY.Audio.play('tap');
      });
    });
    $('btn-reset').addEventListener('click', function () {
      if (!window.confirm('确定清空本机存档（军衔 / 关卡 / 最高波数 / 击杀）？')) return;
      ZY.Save.setRank(0); ZY.Save.setLevel(0);
      try { localStorage.setItem(ZY.Save.KEYS.waveBest, '0'); } catch (e) { /* noop */ }
      try { localStorage.setItem(ZY.Save.KEYS.killTotal, '0'); } catch (e) { /* noop */ }
      refreshSave();
    });
  }

  function getActiveDiff() {
    const b = document.querySelector('.diff-btn.active');
    return b ? b.getAttribute('data-diff') : '1';
  }

  function refreshSave() {
    const rank = ZY.Save.rankName(ZY.Save.getRank());
    const lvName = ZY.LEVELS[ZY.Save.getLevel()].name;
    const lvDone = ZY.Save.getLevel();
    el.saveInfo.innerHTML =
      '<div><b>军衔</b> ' + rank + '</div>' +
      '<div><b>关卡</b> ' + (lvDone >= ZY.LEVELS.length ? '全部通关' : '第 ' + (lvDone + 1) + ' 关 · ' + lvName) + '</div>' +
      '<div><b>无尽最高</b> ' + ZY.Save.getWaveBest() + ' 波</div>' +
      '<div><b>累计击杀</b> ' + ZY.Save.getKillTotal() + '</div>';
  }

  function setMute(v) {
    ZY.Save.setMuted(v);
    ZY.Audio.setMuted(v);
    el.btnMute.textContent = v ? '静' : '音';
    el.btnMute.classList.toggle('off', v);
  }

  /* ======================================================== 棋盘格子 */
  function buildCells() {
    el.cells.innerHTML = '';
    cellEls = [];
    for (let r = 0; r < B.ROWS; r++) {
      const rowEls = [];
      for (let c = 0; c < B.COLS; c++) {
        const d = document.createElement('div');
        d.className = 'cell';
        if (B.isOwnRow('player', r)) d.classList.add('zone-p');
        else d.classList.add('zone-e');
        d.dataset.r = r; d.dataset.c = c;
        el.cells.appendChild(d);
        rowEls.push(d);
      }
      cellEls.push(rowEls);
    }
  }

  function syncCells() {
    // 单人模式：本波来袭纵列在敌方底线前三行打 ▼ 预警；突破口波额外打「突破口」
    const warn = (state.mode !== 'versus' && state.wave.lanes && state.wave.lanes.length)
      ? state.wave.lanes : null;
    const brk = state.wave.breakCols || null;
    const vs = state.mode === 'versus';
    for (let r = 0; r < B.ROWS; r++) {
      for (let c = 0; c < B.COLS; c++) {
        const e = cellEls[r][c];
        const obs = !!B.isObstacle(r, c);
        const inDeploy = !!state.deploy[B.key(r, c)];
        const wasteland = !obs && B.isRoad(r, c) && !inDeploy &&
          (B.isOwnRow('player', r) || (vs && B.isOwnRow('enemy', r)));
        toggleCls(e, 'obstacle', obs);
        toggleCls(e, 'deploy', inDeploy && !obs);
        toggleCls(e, 'wasteland', wasteland);
        const w = !!warn && r <= 2 && warn.indexOf(c) >= 0;
        toggleCls(e, 'warn', w && !brk);
        const b = !!brk && r <= 2 && brk.indexOf(c) >= 0;
        toggleCls(e, 'break', b);
      }
    }
  }

  function toggleCls(e, cls, on) {
    if (on !== e.classList.contains(cls)) e.classList.toggle(cls, on);
  }

  /* ======================================================== 射程点圈 */
  function showRangeAt(row, col, rng) {
    if (!el.rangeRing) return;
    el.rangeRing.style.left = ((col + 0.5) / B.COLS * 100) + '%';
    el.rangeRing.style.top = ((row + 0.5) / B.ROWS * 100) + '%';
    el.rangeRing.style.setProperty('--r', rng);
    el.rangeRing.classList.add('show');
  }
  function showRange(u) { showRangeAt(u.row, u.col, u.range); }
  function clearRange() { if (el.rangeRing) el.rangeRing.classList.remove('show'); }

  /* ======================================================== 进入对局 */
  function enterGame() {
    el.start.hidden = true;
    el.game.hidden = false;
    el.midline.style.display = state.mode === 'versus' ? 'block' : 'none';
    el.hpEnemyLine.style.display = state.mode === 'versus' ? '' : 'none';
    el.overlay.hidden = true;
    el.overlay.innerHTML = '';
    armed = null;
    unitEls = {};
    el.units.innerHTML = '';
    adouEls = {};
    buildAdou();
    syncCells();
    syncUnits(true);
    syncHand();
    syncHud();
    bannerText(state.mode === 'level' ? ('第 ' + (state.levelIdx + 1) + ' 关 · ' + state.levelName)
      : (state.mode === 'endless' ? '守住阿斗' : '竞技 · 对局开始'), 1.8);
  }

  function buildAdou() {
    ['player', 'enemy'].forEach(function (side) {
      if (!state.hasAdou[side]) return;
      const a = B.ADOU[side];
      const d = document.createElement('div');
      d.className = 'adou adou-' + side;
      d.innerHTML = '<b>斗</b><i></i>';
      place(d, a.row, a.col);
      el.units.appendChild(d);
      adouEls[side] = d;
      d.addEventListener('pointerdown', function (ev) {
        ev.stopPropagation();
        showAdouInfo(side);
      });
    });
  }

  function place(node, r, c) {
    node.style.width = (100 / B.COLS) + '%';
    node.style.height = (100 / B.ROWS) + '%';
    node.style.transform = 'translate(' + (c * 100) + '%,' + (r * 100) + '%)';
  }

  /* ======================================================== 单位渲染 */
  /* 水墨 Q 版小人：内嵌 SVG，颜色走 CSS 变量（.unit.e 覆写为红色调）。
   * 全部只画一次，靠 CSS 给不同兵种不同的待机/攻击 keyframes。 */
  function weaponOf(u) {
    let w = u.cls === 'hero'
      ? (ZY.HERO_BY_ID[u.heroId] ? ZY.HERO_BY_ID[u.heroId].base : 'dao')
      : (u.type || 'dao');
    if (w === 'zei') w = 'dao';           // 贼兵套用刀兵形象 + 红色调
    return w;
  }
  function figPerson() {
    return '<g class="fig-body">' +
      '<ellipse class="fig-shadow" cx="50" cy="114" rx="19" ry="4"/>' +
      '<circle class="fig-hair" cx="50" cy="14" r="5"/>' +
      '<circle class="fig-head" cx="50" cy="28" r="13"/>' +
      '<rect class="fig-torso" x="37" y="40" width="26" height="40" rx="12"/>' +
      '<rect class="fig-leg" x="41" y="78" width="8" height="25" rx="4"/>' +
      '<rect class="fig-leg" x="51" y="78" width="8" height="25" rx="4"/>' +
      '</g>';
  }
  function figHorse() {
    return '<g class="fig-horse">' +
      '<ellipse class="fig-hbody" cx="50" cy="98" rx="29" ry="13"/>' +
      '<rect class="fig-leg" x="28" y="106" width="6" height="13" rx="3"/>' +
      '<rect class="fig-leg" x="66" y="106" width="6" height="13" rx="3"/>' +
      '<path class="fig-tail" d="M79 92 q12 5 8 19"/>' +
      '<circle class="fig-hhead" cx="24" cy="90" r="8"/>' +
      '<path class="fig-hneck" d="M30 92 q-6 -8 -2 -16"/>' +
      '</g>';
  }
  function figArmDao() {
    return '<g class="fig-arm">' +
      '<path class="fig-limb" d="M60 50 Q73 54 76 64"/>' +
      '<path class="fig-blade" d="M76 64 Q90 44 82 22 Q95 47 84 68 Z"/>' +
      '</g>';
  }
  function figArmQiang() {
    return '<g class="fig-arm">' +
      '<path class="fig-limb" d="M60 50 Q72 52 76 60"/>' +
      '<line class="fig-spear" x1="76" y1="60" x2="97" y2="32"/>' +
      '<path class="fig-tip" d="M97 32 l-6 -3 l3 7 Z"/>' +
      '</g>';
  }
  function figArmGong() {
    return '<g class="fig-arm fig-arm-l">' +
      '<path class="fig-limb" d="M40 52 Q30 58 27 66"/>' +
      '<g class="fig-bowgrp">' +
        '<path class="fig-bow" d="M21 38 Q11 64 21 90"/>' +
        '<line class="fig-string" x1="21" y1="38" x2="21" y2="90"/>' +
        '<line class="fig-arrow" x1="21" y1="64" x2="21" y2="14"/>' +
      '</g>' +
      '</g>';
  }
  function figArmQi() {
    return '<g class="fig-arm">' +
      '<path class="fig-limb" d="M60 46 Q73 50 77 58"/>' +
      '<line class="fig-spear" x1="77" y1="58" x2="96" y2="30"/>' +
      '<path class="fig-tip" d="M96 30 l-6 -3 l3 7 Z"/>' +
      '</g>';
  }
  function figArmNong() {
    return '<g class="fig-arm">' +
      '<path class="fig-limb" d="M58 50 Q70 48 76 54"/>' +
      '<g class="fig-hoe">' +
        '<line class="fig-handle" x1="76" y1="54" x2="93" y2="70"/>' +
        '<path class="fig-hoeb" d="M89 65 q9 -2 12 5 q-9 4 -13 -3 Z"/>' +
      '</g>' +
      '</g>';
  }
  function figArm(type) {
    if (type === 'qiang') return figArmQiang();
    if (type === 'gong') return figArmGong();
    if (type === 'qi') return figArmQi();
    if (type === 'nong') return figArmNong();
    return figArmDao();
  }
  function figSvg(u) {
    const w = weaponOf(u);
    const isHero = u.cls === 'hero';
    const parts = [];
    if (isHero) parts.push('<path class="fig-cape" d="M33 44 Q16 72 28 106 L45 95 Q41 70 45 46 Z"/>');
    if (w === 'nong') parts.push('<path class="fig-hat" d="M28 31 Q50 4 72 31 Q50 23 28 31 Z"/><ellipse class="fig-hat" cx="50" cy="31" rx="23" ry="4"/>');
    parts.push(figPerson());
    if (w === 'qi') parts.push(figHorse());
    parts.push(figArm(w));
    const inner = '<g class="fig-mount">' + parts.join('') + '</g>';
    return '<svg class="fig" viewBox="0 0 100 120" preserveAspectRatio="xMidYMid meet" aria-hidden="true">' + inner + '</svg>';
  }
  function unitHtml(u) {
    if (u.cls === 'gold') {
      return '<b>' + u.char + '</b>';
    }
    const nm = '<b' + (u.cls === 'hero' ? ' class="nm"' : '') + '>' + u.char + '</b>';
    const lv = (u.cls === 'hero' || u.level > 1) ? '<s class="lv">' + (u.cls === 'hero' ? u.heroLevel : u.level) + '</s>' : '';
    const hb = '<i class="hb"><u></u></i>';
    const sk = (u.cls === 'hero') ? '<em class="sk"></em>' : '';
    return nm + figSvg(u) + lv + hb + sk;
  }

  function syncUnits(force) {
    if (!state) return;
    const seen = {};
    for (let i = 0; i < state.units.length; i++) {
      const u = state.units[i];
      if (u.dead) continue;
      seen[u.id] = true;
      let e = unitEls[u.id];
      if (!e) {
        const wtype = weaponOf(u);
        e = document.createElement('div');
        e.className = 'unit ' + (u.side === 'player' ? 'p' : 'e') + ' ' + u.cls +
          (u.elite ? ' elite' : '') +
          (u.cls === 'soldier' ? ' t-' + u.type : '') +
          (u.cls === 'hero' && wtype ? ' t-' + wtype : '');
        e.dataset.uid = u.id;
        e.dataset.weapon = wtype;
        e.innerHTML = unitHtml(u);
        place(e, u.row, u.col);
        e._r = u.row; e._c = u.col;
        // 平移速度跟自身「走一格」的耗时对齐 → 看起来是连续行军而不是一格一格跳
        e.style.transitionDuration = (u.move > 0 ? Math.min(2.2, u.move * 0.9) : 0.18) + 's';
        e.classList.add('born');
        el.units.appendChild(e);
        unitEls[u.id] = e;
        void e.offsetHeight;
        e.classList.add('anim');
      }
      place(e, u.row, u.col);
      // 行军：位置变化时挂 a-move（在 .fig-mount 上跑颠簸 keyframes，不与定位 transform 冲突）
      if ((e._r !== u.row || e._c !== u.col) && u.move > 0) {
        e._r = u.row; e._c = u.col;
        e.classList.add('a-move');
        clearTimeout(e._moveT);
        e._moveT = setTimeout(function () { e.classList.remove('a-move'); }, 320);
      }
      e.classList.toggle('stun', u.stun > 0);
      // 血条
      const bar = e.querySelector('.hb u');
      if (bar) bar.style.width = Math.max(0, Math.min(100, (u.hp / u.maxHp) * 100)) + '%';
      // 等级
      const lv = e.querySelector('.lv');
      if (lv) lv.textContent = u.cls === 'hero' ? u.heroLevel : u.level;
      // 技能冷却
      const sk = e.querySelector('.sk');
      if (sk) {
        if (u.skillT > 0) { sk.textContent = Math.ceil(u.skillT); sk.classList.remove('ready'); }
        else { sk.textContent = '⚡'; sk.classList.add('ready'); }
      }
    }
    Object.keys(unitEls).forEach(function (id) {
      if (!seen[id]) {
        const e = unitEls[id];
        if (e && e.parentNode && !e.classList.contains('a-death')) {
          // 死亡：先播 a-death（约 0.26s），再移除；移除仍以 state.units 为准
          e.classList.add('a-death');
          const node = e;
          setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 270);
        }
        delete unitEls[id];
      }
    });
    // 阿斗血量
    ['player', 'enemy'].forEach(function (side) {
      const d = adouEls[side];
      if (!d) return;
      const s = ZY.Game.sideState(state, side);
      d.querySelector('i').textContent = '♥' + s.adou;
      d.classList.toggle('hurt', s.adou <= 1);
    });
  }

  /* ======================================================== HUD / 手牌 */
  let hudCache = {};
  function syncHud() {
    if (!state) return;
    const bun = Math.floor(state.player.bun);
    if (hudCache.bun !== bun) { hudCache.bun = bun; el.hudBun.textContent = bun; }
    const p = state.player.adou;
    if (hudCache.p !== p) { hudCache.p = p; el.hpPlayer.innerHTML = hearts(p); }
    if (state.mode === 'versus') {
      const e = state.enemy.adou;
      if (hudCache.e !== e) { hudCache.e = e; el.hpEnemy.innerHTML = hearts(e); }
    }
    let mode = state.mode === 'versus' ? '竞技' : (state.mode === 'endless' ? '无尽' : ('第' + (state.levelIdx + 1) + '关 ' + state.levelName));
    if (hudCache.mode !== mode) { hudCache.mode = mode; el.hudMode.textContent = mode; }
    let wave = '';
    if (state.mode !== 'versus') {
      wave = '第 ' + state.wave.idx + ' 波' + (state.wave.pending.length ? '（出兵中）' : '');
      if (state.mode === 'level') wave += ' · 剩 ' + Math.max(0, 4 - state.wave.idx) + ' 波';
      wave += ' · 击杀 ' + state.stats.kills;
    } else {
      wave = '击杀 ' + state.player.kills + ' · 敌 ' + state.enemy.kills;
    }
    if (hudCache.wave !== wave) { hudCache.wave = wave; el.hudWave.textContent = wave; }
    // 征兵按钮（成本随每次成功征兵 +1，上限 60）
    const cost = state.player.recruitCost;
    const can = state.player.bun >= cost && state.player.hand.length < C.HAND_MAX;
    el.btnRecruit.classList.toggle('dis', !can);
    el.btnRecruit.querySelector('span').textContent =
      state.player.hand.length >= C.HAND_MAX ? '待部署栏已满' : (cost + ' 馒头');
    // 神兵符提示
    el.btnRecruit.classList.toggle('buff', state.buff.player > 0);
  }

  function hearts(n) {
    let s = '';
    for (let i = 0; i < C.ADOU_HP; i++) s += '<i class="' + (i < n ? 'on' : 'off') + '">♥</i>';
    return s;
  }

  let handSig = '';
  function syncHand() {
    if (!state) return;
    const hand = state.player.hand;
    const sig = hand.map(function (c) { return c.uid + ':' + (c.char || c.item); }).join('|') +
      '#' + (armed ? armed.uid : '') + '#' + hand.length;
    if (sig === handSig) return;
    handSig = sig;
    if (el.cells) el.cells.classList.toggle('shovel-armed', !!(armed && armed.kind === 'shovel'));
    el.hand.innerHTML = '';
    for (let i = 0; i < C.HAND_MAX; i++) {
      const slot = document.createElement('div');
      slot.className = 'slot';
      const card = hand[i];
      if (card) {
        const t = document.createElement('div');
        t.className = 'card';
        if (card.kind === 'item') {
          t.classList.add('item', 'it-' + card.item);
          t.innerHTML = '<b>' + ZY.ITEMS[card.item].glyph + '</b><span>' + ZY.ITEMS[card.item].name + '</span>';
        } else if (card.kind === 'gold') {
          t.classList.add('gold');
          t.innerHTML = '<b>' + card.char + '</b><span>将</span>';
        } else {
          t.classList.add('unit', 't-' + card.type);
          t.innerHTML = '<b>' + card.char + '</b><span>' + U[card.type].name + '</span>';
        }
        t.dataset.uid = card.uid;
        if (armed && armed.uid === card.uid) t.classList.add('armed');
        slot.appendChild(t);
      } else {
        slot.classList.add('empty');
      }
      el.hand.appendChild(slot);
    }
  }

  /* ======================================================== 游戏界面事件 */
  function bindGame() {
    el.btnRecruit.addEventListener('click', function () {
      if (!state || state.over) return;
      const r = ZY.Game.recruit(state, 'player');
      if (!r) {
        toast(state.player.hand.length >= C.HAND_MAX ? '待部署栏已满' : '馒头不够（需要 ' + state.player.recruitCost + '）');
        return;
      }
      syncHand(); syncHud();
    });

    el.btnPause.addEventListener('click', function () {
      if (!state) return;
      if (state.over) return;
      state.paused = !state.paused;
      if (state.paused) showPause(); else { el.overlay.hidden = true; el.overlay.innerHTML = ''; }
      ZY.Audio.play('tap');
    });
    el.btnMute.addEventListener('click', function () {
      setMute(!ZY.Save.getMuted());
    });

    // —— 拖拽：手牌 → 棋盘 ——
    el.hand.addEventListener('pointerdown', function (ev) {
      const card = ev.target.closest ? ev.target.closest('.card') : null;
      if (!card || !state || state.over) return;
      ev.preventDefault();
      drag.active = true; drag.src = 'hand';
      drag.uid = parseInt(card.dataset.uid, 10);
      drag.sx = ev.clientX; drag.sy = ev.clientY; drag.moved = false;
      drag.el = card.cloneNode(true);
      drag.el.classList.add('ghost');
      document.body.appendChild(drag.el);
      moveGhost(ev.clientX, ev.clientY);
    });

    // —— 拖拽：棋盘内移动 / 合成（己方）；敌方单位点选显示射程 ——
    el.units.addEventListener('pointerdown', function (ev) {
      const node = ev.target.closest ? ev.target.closest('.unit') : null;
      if (!node || !state || state.over) return;
      const id = parseInt(node.dataset.uid, 10);
      const u = state.units.find(function (x) { return x.id === id; });
      if (!u) return;
      if (u.side === 'player') {
        ev.preventDefault();
        drag.active = true; drag.src = 'board'; drag.unitId = id;
        drag.sx = ev.clientX; drag.sy = ev.clientY; drag.moved = false;
        drag.el = node.cloneNode(true);
        drag.el.classList.add('ghost');
        document.body.appendChild(drag.el);
        moveGhost(ev.clientX, ev.clientY);
      } else {
        ev.preventDefault(); ev.stopPropagation();
        selectUnit(u);
      }
    });

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', cancelDrag);

    // —— 点棋盘：铲子开格 / 毛笔 / 阿斗 ——
    el.cells.addEventListener('pointerdown', function (ev) {
      const c = ev.target.closest ? ev.target.closest('.cell') : null;
      if (!c || !state || state.over) return;
      const r = parseInt(c.dataset.r, 10), col = parseInt(c.dataset.c, 10);
      handleCellTap(r, col);
    });
  }

  function moveGhost(x, y) {
    if (!drag.el) return;
    drag.el.style.left = x + 'px';
    drag.el.style.top = y + 'px';
  }

  function onMove(ev) {
    if (!drag.active) return;
    ev.preventDefault();
    const dx = ev.clientX - drag.sx, dy = ev.clientY - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 8) drag.moved = true;
    moveGhost(ev.clientX, ev.clientY);
    const t = cellAt(ev.clientX, ev.clientY);
    highlight(t, ev.clientX, ev.clientY);
    drag.cell = t;
    // 拖拽时预览射程点圈
    if (t) {
      let rng = 1;
      if (drag.src === 'hand') {
        const card = state.player.hand.find(function (c) { return c.uid === drag.uid; });
        if (card && card.kind === 'unit') rng = U[card.type].range;
      } else {
        const u = state.units.find(function (x) { return x.id === drag.unitId; });
        if (u) rng = u.range;
      }
      if (rng > 0) showRangeAt(t.row, t.col, rng); else clearRange();
    } else clearRange();
  }

  function onUp(ev) {
    if (!drag.active) return;
    const moved = drag.moved;
    const t = cellAt(ev.clientX, ev.clientY);
    const src = drag.src, uid = drag.uid, unitId = drag.unitId;
    cancelDrag();
    clearRange();
    if (!moved) {
      // 视为点击
      if (src === 'hand') {
        tapHand(uid);
      } else {
        const u = state.units.find(function (x) { return x.id === unitId; });
        if (u) selectUnit(u);
      }
      return;
    }
    if (!t) { toast('拖出棋盘，已取消'); return; }
    if (src === 'hand') {
      const res = ZY.Game.deploy(state, 'player', uid, t.row, t.col);
      if (!res.ok) toast(res.msg || '放不了');
      else { handSig = ''; syncHand(); syncUnits(); }
    } else {
      const res = ZY.Game.dropUnitOn(state, 'player', unitId, t.row, t.col);
      if (!res.ok && !res.silent) toast(res.msg || '放不了');
      else {
        // 手动挪动的这一下要立刻到位，不能按行军速度慢慢滑
        const node = unitEls[unitId];
        if (node) {
          node.style.transitionDuration = '0.14s';
          setTimeout(function () {
            const u = state && state.units.find(function (x) { return x.id === unitId; });
            if (node && u) node.style.transitionDuration = (u.move > 0 ? Math.min(2.2, u.move * 0.9) : 0.18) + 's';
          }, 260);
        }
        syncUnits();
      }
    }
    syncHud();
  }

  function cancelDrag() {
    drag.active = false; drag.src = null; drag.cell = null; drag.moved = false;
    if (drag.el && drag.el.parentNode) drag.el.parentNode.removeChild(drag.el);
    drag.el = null;
    highlight(null);
    clearRange();
  }

  function highlight(t) {
    for (let r = 0; r < B.ROWS; r++) for (let c = 0; c < B.COLS; c++) cellEls[r][c].classList.remove('hl', 'bad');
    if (!t || !state) return;
    const okCell = B.canPlace(state, 'player', t.row, t.col) ||
      (state.grid[t.row][t.col] && state.grid[t.row][t.col].side === 'player');
    cellEls[t.row][t.col].classList.add(okCell ? 'hl' : 'bad');
  }

  function cellAt(x, y) {
    const rect = el.board.getBoundingClientRect();
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
    const r = Math.floor((y - rect.top) / (rect.height / B.ROWS));
    const c = Math.floor((x - rect.left) / (rect.width / B.COLS));
    if (r < 0 || r >= B.ROWS || c < 0 || c >= B.COLS) return null;
    return { row: r, col: c };
  }

  /* ======================================================== 点击行为 */
  function tapHand(uid) {
    const card = state.player.hand.find(function (x) { return x.uid === uid; });
    if (!card) return;
    if (card.kind === 'item') {
      if (card.item === 'warcry') {
        consume(uid);
        ZY.Game.useWarcry(state, 'player');
        syncHud();
        return;
      }
      armed = (armed && armed.uid === uid) ? null : { kind: card.item, uid: uid };
      handSig = ''; syncHand();
      if (armed) {
        toast(armed.kind === 'shovel' ? '铲子已拿起：点一个与部署地相邻的荒地兵线格扩为可部署地' : '毛笔已拿起：点一个己方字块改写');
      }
      return;
    }
    toast('把「' + card.char + '」拖到己方半区空格部署');
  }

  function selectUnit(u) {
    if (!u || u.dead) { clearRange(); return; }
    if (u.range > 0) showRange(u); else clearRange();
    showUnitInfo(u);
    ZY.Audio.play('tap');
  }

  function showUnitInfo(u) {
    if (armed && armed.kind === 'brush' && u.side === 'player') {
      const res = ZY.Game.useBrush(state, 'player', u.id);
      if (!res.ok) { toast(res.msg); return; }
      consume(armed.uid);
      armed = null; handSig = ''; syncHand(); syncUnits();
      return;
    }
    if (u.cls === 'hero') {
      const h = ZY.HERO_BY_ID[u.heroId];
      toast(u.char + ' Lv' + u.heroLevel + ' · ' + h.tag + ' · 技能「' + h.skill.name + '」' + h.skill.desc +
        '（CD ' + h.skill.cd + 's）· 射程 ' + u.range);
    } else if (u.cls === 'gold') {
      toast('金字「' + u.char + '」：与另一半横向相邻、从左到右摆好即可成将');
    } else if (u.type === 'nong') {
      toast('农民 Lv' + u.level + '：每秒 +' + (U.nong.produce * u.level).toFixed(1) + ' 馒头');
    } else {
      toast(U[u.type].name + ' Lv' + u.level + '：血 ' + Math.round(u.hp) + '/' + Math.round(u.maxHp) +
        ' 攻 ' + u.atk.toFixed(1) + ' 射程 ' + u.range);
    }
  }

  function handleCellTap(r, c) {
    clearRange();
    if (armed && armed.kind === 'shovel') {
      const res = ZY.Game.useShovel(state, 'player', r, c);
      if (!res.ok) { toast(res.msg); return; }
      consume(armed.uid);
      armed = null; handSig = ''; syncHand(); syncCells();
      return;
    }
    const a = B.ADOU.player;
    if (r === a.row && c === a.col) { showAdouInfo('player'); return; }
    if (armed) { armed = null; handSig = ''; syncHand(); }
  }

  function consume(uid) {
    const i = state.player.hand.findIndex(function (x) { return x.uid === uid; });
    if (i >= 0) state.player.hand.splice(i, 1);
    handSig = '';
  }

  function showAdouInfo(side) {
    const s = ZY.Game.sideState(state, side);
    if (!s) return;
    toast('阿斗：' + s.adou + ' / ' + C.ADOU_HP + ' 血。敌方单位踏入阿斗格会扣 1 血，' +
      '同时补偿 +' + C.ADOU_BONUS + ' 馒头（卖血换经济）。血量归零即败。');
    ZY.Audio.play('tap');
  }

  /* ======================================================== 飘字 / 特效 */
  function fxPos(row, col) {
    return {
      left: ((col + 0.5) / B.COLS * 100) + '%',
      top: ((row + 0.5) / B.ROWS * 100) + '%',
    };
  }
  // 控制特效层总量 ≤ 60 个（常驻 range-ring 不计）
  function trimFx() {
    let count = el.fx.childElementCount;
    let node = el.fx.firstElementChild;
    while (count > 60 && node) {
      const next = node.nextElementSibling;
      if (node !== el.rangeRing) { el.fx.removeChild(node); count--; }
      node = next;
    }
  }
  function spawnFx(node, ttl) {
    el.fx.appendChild(node);
    trimFx();
    setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, ttl);
  }
  function nodeAt(row, col, cls) {
    const d = document.createElement('div');
    d.className = cls;
    const p = fxPos(row, col);
    d.style.left = p.left; d.style.top = p.top;
    return d;
  }
  function fxAt(row, col, text, cls) {
    const d = nodeAt(row, col, 'pop ' + (cls || ''));
    d.style.top = ((row + 0.2) / B.ROWS * 100) + '%';
    d.textContent = text;
    spawnFx(d, 850);
  }
  function ringFx(row, col, kind) {
    const d = nodeAt(row, col, 'ring ' + kind);
    spawnFx(d, 520);
  }
  function slashFx(f) {
    const d = nodeAt(f.row, f.col, 'slash ' + (f.dir > 0 ? 'd-right' : 'd-left'));
    spawnFx(d, 260);
  }
  function arrowFx(f) {
    const d = nodeAt(f.fromRow, f.fromCol, 'arrow');
    const dxc = f.toCol - f.fromCol, dyc = f.toRow - f.fromRow;
    const len = Math.max(0.6, Math.hypot(dxc, dyc));
    const ang = Math.atan2(dyc, dxc) * 180 / Math.PI;
    d.style.width = (len * 100 / B.COLS) + '%';
    d.style.transform = 'translateY(-50%) rotate(' + ang + 'deg)';
    spawnFx(d, 300);
  }
  function pillarFx(f) { spawnFx(nodeAt(f.row, f.col, 'pillar'), 700); }
  function hitFx(f) { spawnFx(nodeAt(f.row, f.col, 'hit'), 200); }
  function dmgFx(f) {
    const d = nodeAt(f.row, f.col, 'dmg');
    d.textContent = f.text;
    spawnFx(d, 850);
  }
  function shakeBoard() {
    el.board.classList.remove('shake'); void el.board.offsetWidth; el.board.classList.add('shake');
    setTimeout(function () { el.board.classList.remove('shake'); }, 360);
  }
  function redFlash() {
    el.redflash.classList.remove('on'); void el.redflash.offsetWidth; el.redflash.classList.add('on');
    setTimeout(function () { el.redflash.classList.remove('on'); }, 260);
  }

  function unitElAt(row, col) {
    const g = state.grid && state.grid[row] && state.grid[row][col];
    return g ? (unitEls[g.id] || null) : null;
  }
  function flashUnitAt(row, col, cls, ms) {
    const e = unitElAt(row, col);
    if (!e) return;
    e.classList.remove(cls); void e.offsetWidth; e.classList.add(cls);
    clearTimeout(e['_' + cls]);
    e['_' + cls] = setTimeout(function () { e.classList.remove(cls); }, ms);
  }
  function animUnit(uid) {
    const e = unitEls[uid];
    if (!e || e.classList.contains('a-attack')) return; // 同一单位攻击动画未播完不重复触发
    const w = e.dataset.weapon || 'dao';
    e.classList.add('a-attack', 'atk-' + w);
    const u = state.units.find(function (x) { return x.id === uid; });
    const interval = (u && u.aspd > 0) ? (1 / u.aspd) : 0.9;
    const dur = Math.max(0.2, interval * 0.75) * 1000;
    clearTimeout(e._atkT);
    e._atkT = setTimeout(function () { e.classList.remove('a-attack', 'atk-' + w); }, dur);
  }

  function drainFx() {
    if (!state) return;
    while (state.fx.length) {
      const f = state.fx.shift();
      if (f.type === 'toast') { toast(f.text); continue; }
      if (f.type === 'shake') { shakeBoard(); continue; }
      if (f.type === 'redflash') { redFlash(); continue; }
      if (f.type === 'anim') { animUnit(f.uid); continue; }
      if (f.type === 'ring' || f.type === 'beam') { ringFx(f.row, f.col, f.type); continue; }
      if (f.type === 'slash') { slashFx(f); continue; }
      if (f.type === 'arrow') { arrowFx(f); continue; }
      if (f.type === 'pillar') { pillarFx(f); continue; }
      if (f.type === 'hit') { hitFx(f); flashUnitAt(f.row, f.col, 'a-hit', 260); continue; }
      if (f.type === 'dmg') { dmgFx(f); continue; }
      if (f.row == null) continue;
      if (f.type === 'merge' || f.type === 'up') flashUnitAt(f.row, f.col, 'a-levelup', 520); // 合成 / 升阶金光
      const map = {
        merge: 'p-merge', hero: 'p-hero', up: 'p-up', bun: 'p-bun', adou: 'p-adou',
        crit: 'p-crit', stun: 'p-stun', heal: 'p-heal', open: 'p-open',
        brush: 'p-brush', big: 'p-big', die: 'p-die',
      };
      const cls = map[f.type] || '';
      fxAt(f.row, f.col, f.text || '', cls);
    }
  }

  let toastT = 0;
  function toast(text) {
    el.toast.textContent = text;
    el.toast.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(function () { el.toast.classList.remove('show'); }, 2600);
  }

  let bannerLife = 0;
  function bannerText(text, life) {
    el.banner.textContent = text;
    el.banner.classList.add('show');
    bannerLife = life || 1.5;
  }

  /* ======================================================== 主循环 */
  function loop(ts) {
    raf = requestAnimationFrame(loop);
    if (!lastTs) lastTs = ts;
    let dt = (ts - lastTs) / 1000;
    lastTs = ts;
    if (!isFinite(dt) || dt < 0) dt = 0;
    if (dt > 0.25) dt = 0.25;

    if (state && !state.paused && !state.over) {
      acc += dt;
      let steps = 0;
      while (acc >= ZY.Game.TICK && steps < 6) {
        ZY.Game.tick(state, ZY.Game.TICK);
        acc -= ZY.Game.TICK;
        steps++;
      }
      if (acc > 1) acc = 0;
    }
    if (state) {
      syncUnits();
      syncHud();
      syncHand();
      syncCells();
      drainFx();
      if (state.banner) { bannerText(state.banner.text, state.banner.life); state.banner = null; }
      if (bannerLife > 0) {
        bannerLife -= dt;
        if (bannerLife <= 0) el.banner.classList.remove('show');
      }
      if (state.over && el.overlay.hidden) showResult();
    }
  }

  /* ======================================================== 暂停 / 结算 */
  function showPause() {
    el.overlay.hidden = false;
    el.overlay.innerHTML =
      '<div class="panel">' +
      '<h2>暂停</h2>' +
      '<p class="p-sub">' + modeTitle() + '</p>' +
      '<div class="btns">' +
      '<button class="btn primary" data-act="resume">继续</button>' +
      '<button class="btn" data-act="restart">重开本局</button>' +
      '<button class="btn" data-act="home">返回主菜单</button>' +
      '</div></div>';
    bindPanel();
  }

  function modeTitle() {
    if (state.mode === 'versus') return '竞技模式';
    if (state.mode === 'endless') return '无尽模式';
    return '关卡模式 · 第 ' + (state.levelIdx + 1) + ' 关 ' + state.levelName;
  }

  function showResult() {
    const win = state.result === 'win';
    let title = win ? '胜 利' : '败 北';
    let body = '';
    let btns = '';

    if (state.mode === 'versus') {
      if (win) {
        const r = Math.min(ZY.RANKS.length - 1, ZY.Save.getRank() + 1);
        ZY.Save.setRank(r);
        body = '<p>敌方阿斗已破。晋升军衔：<b>' + ZY.Save.rankName(r) + '</b></p>';
      } else {
        body = '<p>我方阿斗失守。再来一局。</p>';
      }
      body += '<p class="dim">击杀 ' + state.player.kills + ' · 敌方击杀 ' + state.enemy.kills +
        ' · 用时 ' + Math.round(state.t) + 's</p>';
      btns = '<button class="btn primary" data-act="restart">再来一局</button>' +
        '<button class="btn" data-act="home">返回主菜单</button>';
    } else if (state.mode === 'endless') {
      ZY.Save.setWaveBest(state.wave.idx);
      ZY.Save.addKills(state.stats.kills);
      title = '守 家 结 算';
      body = '<p>最高波数 <b>' + state.wave.idx + '</b> · 总击杀 <b>' + state.stats.kills + '</b></p>' +
        '<p class="dim">用时 ' + Math.round(state.t) + 's · 历史最高 ' + ZY.Save.getWaveBest() + ' 波</p>';
      btns = '<button class="btn primary" data-act="restart">再来一局</button>' +
        '<button class="btn" data-act="home">返回主菜单</button>';
    } else {
      ZY.Save.addKills(state.stats.kills);
      if (win) {
        const next = state.levelIdx + 1;
        const r = Math.min(ZY.RANKS.length - 1, ZY.Save.getRank() + 1);
        ZY.Save.setRank(r);
        if (next >= ZY.LEVELS.length) {
          ZY.Save.setLevel(ZY.LEVELS.length - 1);
          body = '<p>全关通关！你是 <b>' + ZY.Save.rankName(r) + '</b></p>';
          btns = '<button class="btn primary" data-act="home">返回主菜单</button>' +
            '<button class="btn" data-act="restart">重打本关</button>';
        } else {
          ZY.Save.setLevel(next);
          body = '<p>' + state.levelName + ' 已克。晋升军衔：<b>' + ZY.Save.rankName(r) + '</b></p>' +
            '<p class="dim">下一关：' + ZY.LEVELS[next].name + '</p>';
          btns = '<button class="btn primary" data-act="next">下一关</button>' +
            '<button class="btn" data-act="restart">重打本关</button>' +
            '<button class="btn" data-act="home">返回主菜单</button>';
        }
      } else {
        body = '<p>阿斗失守于 <b>' + state.levelName + '</b>。重打本关。</p>';
        btns = '<button class="btn primary" data-act="restart">重打本关</button>' +
          '<button class="btn" data-act="home">返回主菜单</button>';
      }
    }

    el.overlay.hidden = false;
    el.overlay.innerHTML =
      '<div class="panel ' + (win ? 'win' : 'lose') + '">' +
      '<h2>' + title + '</h2>' + body +
      '<div class="btns">' + btns + '</div></div>';
    bindPanel();
    refreshSave();
  }

  function bindPanel() {
    const btns = el.overlay.querySelectorAll('.btn');
    Array.prototype.forEach.call(btns, function (b) {
      b.addEventListener('click', function () {
        const act = b.getAttribute('data-act');
        ZY.Audio.play('tap');
        if (act === 'resume') {
          state.paused = false;
          el.overlay.hidden = true; el.overlay.innerHTML = '';
        } else if (act === 'restart') {
          // 关卡失败重来：按「进本关时」的部队还原（carry），不重复发战利品；
          // 若从零重来，第 4 关起就是死局 —— 玩家会永远卡住。
          if (state.mode === 'level') startLevelRun(state.levelIdx, carry, true);
          else { state = ZY.Game.baseState(state.mode, { difficulty: state.difficulty }); enterGame(); }
        } else if (act === 'next') {
          startLevelRun(state.levelIdx + 1, state);
        } else if (act === 'home') {
          state = null; carry = null;
          el.overlay.hidden = true; el.overlay.innerHTML = '';
          el.game.hidden = true;
          el.start.hidden = false;
          refreshSave();
        }
      });
    });
  }

  /** 关卡模式开局：可继承上一关的棋盘 / 手牌 / 馒头
   *  prev 为空且关卡号 > 0（中途开档）时，补一支该进度应有的部队，避免死局 */
  function startLevelRun(idx, prev, noBonus) {
    idx = Math.max(0, Math.min(ZY.LEVELS.length - 1, idx));
    state = ZY.Game.baseState('level', { levelIdx: idx });
    if (prev) ZY.Game.inherit(state, prev, noBonus);
    else if (idx > 0) ZY.Game.inherit(state, null);   // 走 seedArmy 分支
    carry = prev || null;
    enterGame();
  }

  // getState 只读暴露当前对局状态，供自动化自测 / 调试面板使用
  ZY.UI = {
    init: init,
    toast: toast,
    getState: function () { return state; },
  };
})(window.ZY);
