/* =============================================================================
 * 赵云与阿斗 · 界面与交互 (ui.js)  — V5 原版对齐（竖屏）
 * 渲染、拖拽（pointer 统一鼠标 / 触屏）、飘字特效、结算面板
 * 布局：顶部信息栏 → 棋盘 → 手牌区 8 格 → 军营栏 5 格 → 征兵按钮 + 道具栏（铲子×N / 兵器）
 * ========================================================================== */
(function (ZY) {
  'use strict';

  const B = ZY.B;
  const C = ZY.C;
  const U = ZY.UNITS;
  const T = ZY.TUNE;

  let state = null;
  let raf = 0, lastTs = 0, acc = 0;
  let cellEls = [], unitEls = {}, adouEls = {};
  let cellStatic = null, cellStaticKey = '';   // V6：地形静态描述子缓存（对局内不变）
  let itemSig = -1;                            // V6：铲子数量签名（避免每帧写 DOM）
  let carry = null;                 // 关卡模式跨关继承
  let selectedUnitId = null;        // V6 数值校准：当前选中的我方塔（显示等级角标）
  let dragMatchKey = null;          // V6 数值校准：拖拽中的「同字卡」匹配键（'u:type' / 'h:heroId'）
  let pendingLevel = 0;
  let selectedHero = null;          // 武器面板当前选中的武将

  const drag = { active: false, src: null, uid: 0, unitId: 0, sx: 0, sy: 0, moved: false, el: null, cell: null };

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
    el.barracks = $('barracks');
    el.items = $('items');
    el.itemShovel = $('item-shovel');
    el.btnWeapons = $('btn-weapons');
    el.weaponPanel = $('weapon-panel');
    el.waveLeft = $('wave-left');
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
    el.btnRecruitCost = el.btnRecruit.querySelector('span');   // V6：缓存引用，避免每帧 querySelector
    el.itemShovelN = el.itemShovel.querySelector('b');

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
        d.dataset.r = r; d.dataset.c = c;
        el.cells.appendChild(d);
        rowEls.push(d);
      }
      cellEls.push(rowEls);
    }
  }

  function syncCells() {
    // V5 塔防：棕色主路地砖 / 绿色塔位 / 荆棘障碍 / 荒地 / 入口 / 来袭预警
    // V6 性能：地形三态（障碍 / 主路 / 入口）对局内不变 → 预计算静态描述子，
    //     每帧只处理动态量（塔位 deploy / 预警 warn / 突破口 break / 荒地），
    //     消除 84 格 × 每帧的地图查询与对象分配。
    const mode = state.mode;
    const sig = mode + ':' + state.levelIdx;
    if (!cellStatic || cellStaticKey !== sig) buildCellStatic(mode);
    const st = cellStatic;
    const warnOn = state.wave.idx > 0 || state.wave.pending.length > 0;
    const brk = state.wave.breakEntrance;
    let warnSet = null;
    if (warnOn) {
      const vs = mode === 'versus';
      warnSet = {};
      ['player', 'enemy'].forEach(function (side) {
        if (!vs && side === 'enemy') return;
        B.warnCells(mode, side, state.levelIdx).forEach(function (p) { warnSet[B.key(p.row, p.col)] = true; });
      });
    }
    for (let r = 0; r < B.ROWS; r++) {
      const row = cellEls[r], srow = st[r];
      for (let c = 0; c < B.COLS; c++) {
        const e = row[c], s = srow[c], k = s.k;
        const inDeploy = !!state.deploy[k];
        toggleCls(e, 'obstacle', s.obs);
        toggleCls(e, 'path', s.path && !s.obs);
        toggleCls(e, 'deploy', inDeploy && !s.obs);
        toggleCls(e, 'wasteland', !s.obs && !s.path && !inDeploy);
        toggleCls(e, 'enter', s.ent);
        const w = !!warnSet && !!warnSet[k] && !brk;
        toggleCls(e, 'warn', w && !s.ent);
        toggleCls(e, 'break', !!brk && s.ent);
      }
    }
  }
  /** 预计算每格静态地形（障碍 / 主路 / 入口），随 mode+levelIdx 失效重算 */
  function buildCellStatic(mode) {
    const vs = mode === 'versus';
    const entSet = {};
    ['player', 'enemy'].forEach(function (side) {
      if (!vs && side === 'enemy') return;
      B.entrances(mode, side, state.levelIdx).forEach(function (p) { entSet[B.key(p.row, p.col)] = true; });
    });
    cellStatic = [];
    for (let r = 0; r < B.ROWS; r++) {
      const row = [];
      for (let c = 0; c < B.COLS; c++) {
        const k = B.key(r, c);
        row.push({ k: k, obs: B.isObstacle(r, c), path: B.isPath(mode, r, c, state.levelIdx), ent: !!entSet[k] });
      }
      cellStatic.push(row);
    }
    cellStaticKey = mode + ':' + state.levelIdx;
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
    el.weaponPanel.hidden = true;
    unitEls = {};
    el.units.innerHTML = '';
    adouEls = {};
    selectedUnitId = null; dragMatchKey = null;   // V6 数值校准：开局清空选中/同字卡角标态
    buildAdou();
    buildSpawnMark();
    syncCells();
    syncUnits(true);
    syncHand(); syncBarracks(); syncItems();
    syncHud();
    bannerText(state.mode === 'level' ? ('第 ' + (state.levelIdx + 1) + ' 关 · ' + state.levelName)
      : (state.mode === 'endless' ? '守住阿斗' : '竞技 · 对局开始'), 1.8);
  }

  function buildAdou() {
    ['player', 'enemy'].forEach(function (side) {
      if (!state.hasAdou[side]) return;
      const a = B.adouAt(state.mode, side, state.levelIdx);
      const d = document.createElement('div');
      d.className = 'adou adou-' + side;
      d.innerHTML = '<b>斗</b><i></i>';
      place(d, a.row, a.col, 1);
      el.units.appendChild(d);
      adouEls[side] = d;
      d.addEventListener('pointerdown', function (ev) {
        ev.stopPropagation();
        showAdouInfo(side);
      });
    });
  }

  /** V5：右侧刷怪口另立一「斗」作为敌方刷怪口标记（单人模式） */
  function buildSpawnMark() {
    if (state.mode === 'versus') return;
    const ent = B.entrances(state.mode, 'player', state.levelIdx)[0];
    const d = document.createElement('div');
    d.className = 'adou spawn-mark';
    d.innerHTML = '<b>斗</b>';
    place(d, ent.row, ent.col, 1);
    el.units.appendChild(d);
  }

  function place(node, r, c, span) {
    // V6 性能：仅当值变化才写 style（每帧 × 每单位调用，相同字符串重复写会触发无效样式失效）
    const w = (100 / B.COLS * (span || 1)) + '%';
    const h = (100 / B.ROWS) + '%';
    const tf = 'translate(' + (c * 100) + '%,' + (r * 100) + '%)';
    if (node._pw !== w) { node._pw = w; node.style.width = w; }
    if (node._ph !== h) { node._ph = h; node.style.height = h; }
    if (node._ptf !== tf) { node._ptf = tf; node.style.transform = tf; }
  }

  /* ======================================================== 单位渲染 */
  /* 水墨 Q 版小人：内嵌 SVG，颜色走 CSS 变量（.unit.e 覆写为红色调）。 */
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
  /* V6 数值校准：等级角标（.lv）默认隐藏，仅在两种触发下显示 ——
   *   ① 拖动手牌/军营中的「同字卡」（兵种同字 / 武将字对）时，场上对应塔显示（合成/升级目标提示）；
   *   ② 点击/选中某塔时显示（配合属性面板看数值）。
   * 规则层等级数值不变，仅 UI 显隐。matchKey：兵种塔 'u:'+type，武将塔 'h:'+heroId。 */
  function cardMatchKey(c) {
    if (!c) return null;
    if (c.kind === 'unit') return 'u:' + c.type;
    if (c.kind === 'hero') return 'h:' + c.heroId;
    return null;                              // 道具（火球/神兵符/毛笔）/ 铲子 → 不触发
  }
  function updateBadges() {
    const sel = selectedUnitId;
    const mk = (drag.active && dragMatchKey) ? dragMatchKey : null;
    for (const id in unitEls) {
      const e = unitEls[id];
      if (!e) continue;
      const show = (mk && e.dataset.matchKey === mk) || (sel && +e.dataset.uid === sel);
      if (e._badge !== show) { e._badge = show; e.classList.toggle('show-lv', show); }
    }
  }

  function unitHtml(u) {
    if (u.cls === 'gold') {                                  // 兼容旧存档残留
      return '<b>' + u.char + '</b>';
    }
    // V5：带名武将（张梁）显示名字；武将塔显示武将名
    const label = (u.boss && u.name) ? u.name : u.char;
    const nm = '<b' + (u.cls === 'hero' || u.boss ? ' class="nm"' : '') + '>' + label + '</b>';
    const lv = '<s class="lv">' + (u.cls === 'hero' ? u.heroLevel : u.level) + '</s>';
    const hb = '<i class="hb"><u></u></i>';
    const sk = (u.cls === 'hero') ? '<em class="sk"></em>' : '';
    const wp = u.weapon ? '<s class="wp">' + ZY.WEAPONS[u.weapon].glyph + '</s>' : '';   // 装备武器小徽标
    return nm + figSvg(u) + lv + hb + sk + wp;
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
          (u.cls === 'hero' && wtype ? ' t-' + wtype : '') +
          (u.span > 1 ? ' span2' : '');
        e.dataset.uid = u.id;
        e.dataset.weapon = wtype;
        e.dataset.matchKey = (u.cls === 'hero') ? ('h:' + u.heroId) : (u.cls === 'soldier' ? ('u:' + u.type) : '');
        e._badge = false;
        e.innerHTML = unitHtml(u);
        e._bar = e.querySelector('.hb u');      // V6：缓存子节点引用，每帧不再 querySelector
        e._lvEl = e.querySelector('.lv');
        e._skEl = e.querySelector('.sk');
        place(e, u.row, u.col, u.span);
        e._r = u.row; e._c = u.col;
        // 敌人按移速插值滑行；我方塔只会在用户拖拽换位时移动 → 快速落定
        e.style.transitionDuration = (u.side === 'player' ? 0.18 : (u.move > 0 ? Math.min(2.2, u.move * 0.9) : 0.18)) + 's';
        e.classList.add('born');
        el.units.appendChild(e);
        unitEls[u.id] = e;
        void e.offsetHeight;
        e.classList.add('anim');
      }
      // V6：过渡时长跟随当前步 —— 出关第一步（pi=0）用 gateExit，出关后按移速插值；
      //     玩家单位（塔）只会在拖拽换位时移动，固定 0.18s 快速落定
      const stepSec = u.side === 'player' ? 0.18
        : (u.pi === 0 ? Math.min(u.move > 0 ? u.move : 0.5, (ZY.TUNE && ZY.TUNE.gateExit) || 0.5)
                      : (u.move > 0 ? Math.min(2.2, u.move * 0.9) : 0.18));
      if (e._dur !== stepSec) { e._dur = stepSec; e.style.transitionDuration = stepSec + 's'; }
      place(e, u.row, u.col, u.span);
      if ((e._r !== u.row || e._c !== u.col) && u.move > 0) {
        e._r = u.row; e._c = u.col;
        e.classList.add('a-move');
        clearTimeout(e._moveT);
        e._moveT = setTimeout(function () { e.classList.remove('a-move'); }, 320);
      }
      // V6 性能：以下逐项仅在值变化时写 DOM（每帧 × 每单位）
      if (e._stun !== (u.stun > 0)) { e._stun = u.stun > 0; e.classList.toggle('stun', e._stun); }
      const bar = e._bar;
      if (bar) {
        const hp = Math.max(0, Math.min(100, (u.hp / u.maxHp) * 100));
        if (e._hp !== hp) { e._hp = hp; bar.style.width = hp + '%'; }
      }
      const lv = e._lvEl;
      if (lv) {
        const lvTxt = u.cls === 'hero' ? u.heroLevel : u.level;
        if (e._lv !== lvTxt) { e._lv = lvTxt; lv.textContent = lvTxt; }
      }
      const sk = e._skEl;
      if (sk) {
        if (u.skillT > 0) {
          const t = Math.ceil(u.skillT);
          if (e._skT !== t) { e._skT = t; e._skR = false; sk.textContent = t; sk.classList.remove('ready'); }
        } else if (!e._skR) {
          e._skR = true; e._skT = -1; sk.textContent = '⚡'; sk.classList.add('ready');
        }
      }
      // V5：装备武器徽标（装备 / 卸下实时反映，不重建整个单位节点）
      if (u.weapon) {
        const g = (ZY.WEAPONS[u.weapon] || {}).glyph || '';
        let wp = e._wp;
        if (!wp) {
          wp = document.createElement('s');
          wp.className = 'wp';
          e.appendChild(wp);
          e._wp = wp;
        }
        if (wp.textContent !== g) wp.textContent = g;
      } else if (e._wp && e._wp.parentNode) {
        e._wp.parentNode.removeChild(e._wp);
        e._wp = null;
      }
    }
    // V6 性能：for...in 清扫死亡单位（不再每帧分配 Object.keys 数组）
    for (const id in unitEls) {
      if (!seen[id]) {
        const e = unitEls[id];
        if (e && e.parentNode && !e.classList.contains('a-death')) {
          e.classList.add('a-death');
          const node = e;
          setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 270);
        }
        delete unitEls[id];
      }
    }
    // 阿斗血量（V6：缓存 <i> 引用 + 仅在变化时写）
    ['player', 'enemy'].forEach(function (side) {
      const d = adouEls[side];
      if (!d) return;
      const s = ZY.Game.sideState(state, side);
      if (!d._hpEl) d._hpEl = d.querySelector('i');
      if (d._hpEl && d._adou !== s.adou) { d._adou = s.adou; d._hpEl.textContent = '♥' + s.adou; }
      if (d._hurt !== (s.adou <= 1)) { d._hurt = (s.adou <= 1); d.classList.toggle('hurt', d._hurt); }
    });
  }

  /* ======================================================== HUD / 手牌 / 军营 */
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
      wave = '第 ' + state.wave.idx + (state.mode === 'level' ? '/' + T.levelWaves : '') + ' 波' +
        (state.wave.pending.length ? '（出兵中）' : '');
      if (state.mode === 'level') wave += ' · 剩 ' + Math.max(0, T.levelWaves - state.wave.idx) + ' 波';
      wave += ' · 击杀 ' + state.stats.kills;
    } else {
      wave = '第 ' + Math.min(state.wave.idx, T.versusWaves) + '/' + T.versusWaves + ' 波' +
        (state.wave.pending.length ? '（出兵中）' : '') +
        ' · 击杀 ' + state.player.kills + ' · 敌 ' + state.enemy.kills;
    }
    if (hudCache.wave !== wave) { hudCache.wave = wave; el.hudWave.textContent = wave; }
    // V5：波内剩余敌人数量（左下角，随击杀递减）
    // V6 性能：display / textContent 仅在变化时写；计数改用循环（不再每帧 filter 分配数组）
    if (state.mode === 'versus') {
      if (hudCache.wlDisp !== 'none') { hudCache.wlDisp = 'none'; el.waveLeft.style.display = 'none'; }
    } else {
      if (hudCache.wlDisp !== '') { hudCache.wlDisp = ''; el.waveLeft.style.display = ''; }
      let rem = state.wave.pending.length;
      for (let i = 0; i < state.units.length; i++) {
        const u = state.units[i];
        if (u.side === 'enemy' && !u.dead) rem++;
      }
      const txt = state.wave.idx > 0 ? ('本波剩 ' + rem) : '';
      if (hudCache.waveLeft !== txt) { hudCache.waveLeft = txt; el.waveLeft.textContent = txt; }
    }
    // 征兵按钮（成本 10 起步每次 +2 不封顶；一次 5 张进军营 5 槽）
    // V6 性能：文案/样式仅在变化时写
    const cost = state.player.recruitCost;
    const bFree = C.BARRACKS_MAX - (state.player.barracks ? state.player.barracks.length : 0);
    const can = state.player.bun >= cost && bFree > 0;
    const costTxt = bFree <= 0 ? '军营已满' : (cost + ' 资源');
    if (hudCache.recruitCost !== costTxt) {
      hudCache.recruitCost = costTxt;
      if (el.btnRecruitCost) el.btnRecruitCost.textContent = costTxt;
    }
    if (hudCache.recruitDis !== !can) { hudCache.recruitDis = !can; el.btnRecruit.classList.toggle('dis', !can); }
    const buffOn = state.buff.player > 0;
    if (hudCache.recruitBuff !== buffOn) { hudCache.recruitBuff = buffOn; el.btnRecruit.classList.toggle('buff', buffOn); }
  }

  function hearts(n) {
    let s = '';
    for (let i = 0; i < C.ADOU_HP; i++) s += '<i class="' + (i < n ? 'on' : 'off') + '">♥</i>';
    return s;
  }

  function cardInner(card) {
    if (card.kind === 'item') {
      return { cls: 'item it-' + card.item, html: '<b>' + ZY.ITEMS[card.item].glyph + '</b><span>' + ZY.ITEMS[card.item].name + '</span>' };
    }
    if (card.kind === 'hero') {
      const star = (card.level || 1) > 1 ? (' · ' + card.level + '★') : ' · 2格';
      return { cls: 'hero' + ((card.level || 1) > 1 ? ' star' + Math.min(5, card.level) : ''), html: '<b>' + card.char + '</b><span>武将' + star + '</span>' };
    }
    if (card.kind === 'gold') {
      return { cls: 'gold', html: '<b>' + card.char + '</b><span>将</span>' };
    }
    return { cls: 'unit t-' + card.type, html: '<b>' + card.char + '</b><span>' + U[card.type].name + '</span>' };
  }

  let handSig = '';
  function syncHand() {
    if (!state) return;
    const hand = state.player.hand;
    const sig = hand.map(function (c) { return c.uid + ':' + (c.char || c.item); }).join('|') + '#' + ZY.handUsed(state.player);
    if (sig === handSig) return;
    handSig = sig;
    // V5：凑齐武将字对 → 两张金字黄色发光「合成武将」提示（武将卡排前，避免 2 格卡换行）
    const ready = ZY.heroSynthReady(state, 'player');
    const pairChars = ready ? ready.chars : [];
    const ordered = hand.filter(function (c) { return c.kind === 'hero'; })
      .concat(hand.filter(function (c) { return c.kind !== 'hero'; }));
    el.hand.innerHTML = '';
    let used = 0;
    ordered.forEach(function (card) {
      const span = ZY.cardSpan(card);
      const inner = cardInner(card);
      const t = document.createElement('div');
      t.className = 'card ' + inner.cls;
      t.style.gridColumn = 'span ' + span;
      if (card.kind === 'gold' && pairChars.indexOf(card.char) >= 0) t.classList.add('pair');
      t.innerHTML = inner.html;
      t.dataset.uid = card.uid;
      el.hand.appendChild(t);
      used += span;
    });
    for (let i = used; i < C.HAND_MAX; i++) {
      const slot = document.createElement('div');
      slot.className = 'slot empty';
      el.hand.appendChild(slot);
    }
  }

  let barSig = '';
  function syncBarracks() {
    if (!state) return;
    const barracks = state.player.barracks || [];
    const sig = barracks.map(function (c) { return c.uid + ':' + (c.char || c.item); }).join('|') + '#' + barracks.length;
    if (sig === barSig) return;
    barSig = sig;
    el.barracks.innerHTML = '';
    for (let i = 0; i < C.BARRACKS_MAX; i++) {
      const slot = document.createElement('div');
      slot.className = 'slot';
      const card = barracks[i];
      if (card) {
        const inner = cardInner(card);
        const t = document.createElement('div');
        t.className = 'card mini ' + inner.cls;
        t.innerHTML = inner.html;
        t.dataset.uid = card.uid;
        slot.appendChild(t);
      } else {
        slot.classList.add('empty');
      }
      el.barracks.appendChild(slot);
    }
  }

  function syncItems() {
    if (!state) return;
    // V6 性能：仅在数量变化时写 DOM
    const n = (state.player.items && state.player.items.shovel) || 0;
    if (itemSig === n) return;
    itemSig = n;
    if (el.itemShovelN) el.itemShovelN.textContent = '×' + n;
    el.itemShovel.classList.toggle('dis', n <= 0);
  }

  /* ======================================================== 游戏界面事件 */
  function bindGame() {
    el.btnRecruit.addEventListener('click', function () {
      if (!state || state.over) return;
      const r = ZY.Game.recruit(state, 'player');
      if (!r) {
        const bFree = C.BARRACKS_MAX - (state.player.barracks ? state.player.barracks.length : 0);
        toast(bFree <= 0 ? '军营已满（5 槽），先把手牌用出去' : '资源不够（需要 ' + state.player.recruitCost + '）');
        return;
      }
      syncHand(); syncBarracks(); syncItems(); syncHud();
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
    el.btnWeapons.addEventListener('click', function () {
      if (!state) return;
      if (el.weaponPanel.hidden) openWeapons(); else el.weaponPanel.hidden = true;
      ZY.Audio.play('tap');
    });

    // —— 拖拽：手牌 → 棋盘 / 手牌区内金字合成 ——
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
      // V6 数值校准：同字卡拖动 → 场上对应塔显示等级角标（合成/升级目标提示）
      const c = state.player.hand.find((x) => x.uid === drag.uid);
      dragMatchKey = cardMatchKey(c); updateBadges();
      moveGhost(ev.clientX, ev.clientY);
    });

    // —— 拖拽：军营 → 手牌 / 军营 → 棋盘 ——
    el.barracks.addEventListener('pointerdown', function (ev) {
      const card = ev.target.closest ? ev.target.closest('.card') : null;
      if (!card || !state || state.over) return;
      ev.preventDefault();
      drag.active = true; drag.src = 'barracks';
      drag.uid = parseInt(card.dataset.uid, 10);
      drag.sx = ev.clientX; drag.sy = ev.clientY; drag.moved = false;
      drag.el = card.cloneNode(true);
      drag.el.classList.add('ghost');
      document.body.appendChild(drag.el);
      // V6 数值校准：同字卡拖动 → 场上对应塔显示等级角标（合成/升级目标提示）
      const c = state.player.barracks.find((x) => x.uid === drag.uid);
      dragMatchKey = cardMatchKey(c); updateBadges();
      moveGhost(ev.clientX, ev.clientY);
    });

    // —— 拖拽：道具栏铲子 → 荒地 ——
    el.itemShovel.addEventListener('pointerdown', function (ev) {
      if (!state || state.over) return;
      if ((state.player.items.shovel || 0) <= 0) { toast('没有铲子了'); return; }
      ev.preventDefault();
      drag.active = true; drag.src = 'shovel';
      drag.sx = ev.clientX; drag.sy = ev.clientY; drag.moved = false;
      drag.el = el.itemShovel.cloneNode(true);
      drag.el.classList.add('ghost');
      document.body.appendChild(drag.el);
      moveGhost(ev.clientX, ev.clientY);
    });

    // —— 拖拽：棋盘内己方塔（松手免费换位）；行军敌人点选看信息 ——
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
        // V6 数值校准：拖塔换位时先收起选中态与同字卡角标
        selectedUnitId = null; dragMatchKey = null; updateBadges();
        moveGhost(ev.clientX, ev.clientY);
      } else {
        ev.preventDefault(); ev.stopPropagation();
        selectUnit(u);
      }
    });

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', cancelDrag);

    // —— 点棋盘：阿斗信息 ——
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
    highlight(t);
    drag.cell = t;
    // 神兵符拖拽轨迹特效（节流，计入 fx 上限）
    if (drag.moved && drag.src === 'hand') {
      const c = state.player.hand.find(function (x) { return x.uid === drag.uid; });
      if (c && c.kind === 'item' && c.item === 'warcry') maybeTrail(ev.clientX, ev.clientY);
    }
    // 拖拽时预览射程点圈
    if (t) {
      let rng = 1;
      if (drag.src === 'hand' || drag.src === 'barracks') {
        const s = state.player;
        const card = (s.hand.concat(s.barracks || [])).find(function (c) { return c.uid === drag.uid; });
        if (card && card.kind === 'unit') rng = U[card.type].range;
        else if (card && card.kind === 'hero') rng = ZY.HERO_BY_ID[card.heroId].range;
        else rng = 0;
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
    const lastCell = drag.cell;
    cancelDrag();
    clearRange();
    if (!moved) {
      // 原地松手 = 点击
      if (src === 'hand') tapHand(uid);
      else if (src === 'barracks') tapBarracks(uid);
      else if (src === 'shovel') toast('把铲子拖到荒地塔位上释放');
      else {
        const u = state.units.find(function (x) { return x.id === unitId; });
        if (u) selectUnit(u);
      }
      return;
    }
    // —— V5：拖塔换位（免费；等级/合成/装备/攻速计时原样保留）——
    if (src === 'board') {
      if (!t) { toast('把塔拖到绿色塔位上换位'); return; }
      const res = ZY.Game.moveUnit(state, 'player', unitId, t.row, t.col);
      if (res.same) { toast('塔还在原位'); return; }
      if (!res.ok) { toast(res.msg || '这里放不了'); return; }
      syncCells(); syncUnits(); syncHud();
      return;
    }

    // —— 道具栏铲子：拖到荒地释放 ——
    if (src === 'shovel') {
      if (!t) { toast('把铲子拖到荒地塔位上释放'); return; }
      const res = ZY.Game.useShovel(state, 'player', t.row, t.col);
      if (!res.ok) { toast(res.msg); return; }
      syncCells(); syncItems(); syncHud();
      return;
    }

    const s = state.player;
    const card = (s.hand.concat(s.barracks || [])).find(function (c) { return c.uid === uid; });
    if (!card) { handSig = ''; barSig = ''; syncHand(); syncBarracks(); return; }

    // —— 军营 → 手牌：拖到手牌区即转入 ——
    if (src === 'barracks') {
      const hr = el.hand.getBoundingClientRect();
      const overHand = ev.clientX >= hr.left && ev.clientX <= hr.right && ev.clientY >= hr.top && ev.clientY <= hr.bottom;
      if (overHand) {
        const r = ZY.Game.stageCard(state, 'player', uid);
        if (!r) { toast('手牌已满（8 格）'); return; }
        syncHand(); syncBarracks(); syncHud();
        return;
      }
    }

    if (card.kind === 'item') {
      if (card.item === 'warcry') {
        consume(uid);
        ZY.Game.useWarcry(state, 'player');
        toast('神兵符！全队攻击 ×' + C.WARCRY_MULT + '（' + C.WARCRY_TIME + 's）');
        syncHand(); syncBarracks(); syncHud();
        return;
      }
      if (card.item === 'fireball') {
        const cell = t || lastCell;
        consume(uid);
        if (cell) {
          const r = ZY.Game.useFireball(state, 'player', cell.row, cell.col);
          toast(r.hit ? '火球爆裂！命中 ' + r.hit + ' 个敌人' : '火球爆炸（范围内没有敌人）');
        } else {
          toast('火球已释放');
        }
        syncHand(); syncBarracks();
        return;
      }
      if (card.item === 'brush') {
        if (!t) { toast('把毛笔拖到己方塔上释放'); return; }
        const tower = state.grid[t.row][t.col];
        if (!tower || tower.side !== 'player') { toast('毛笔要拖到己方塔上'); return; }
        const res = ZY.Game.useBrush(state, 'player', tower.id);
        if (!res.ok) { toast(res.msg); return; }
        consume(uid);
        syncUnits(); syncHand(); syncBarracks();
        return;
      }
      return;
    }

    // —— 金字：拖到另一张金字上 = 合成武将 ——
    if (card.kind === 'gold' && src === 'hand') {
      const hr = el.hand.getBoundingClientRect();
      if (ev.clientX >= hr.left && ev.clientX <= hr.right && ev.clientY >= hr.top && ev.clientY <= hr.bottom) {
        const under = document.elementFromPoint(ev.clientX, ev.clientY);
        const target = under && under.closest ? under.closest('.card') : null;
        if (target && parseInt(target.dataset.uid, 10) !== uid) {
          const ready = ZY.heroSynthReady(state, 'player');
          if (ready) {
            ZY.Game.synthHero(state, 'player');
            syncHand(); syncBarracks(); syncHud();
            toast('合成武将 · ' + ready.name);
            return;
          }
        }
        toast('把金字拖到棋盘外的塔位… 不对，金字要在手牌里凑对合成');
        return;
      }
    }

    // —— 兵种 / 武将卡：空格塔位 = 建塔（武将卡占 2 格）；己方塔上 = 同字合成 +1 级 ——
    if (!t) { toast('拖出棋盘，已取消'); return; }
    const res = ZY.Game.deploy(state, 'player', uid, t.row, t.col);
    if (!res.ok) { toast(res.msg || '放不了'); return; }
    handSig = ''; barSig = '';
    syncHand(); syncBarracks(); syncUnits(); syncCells(); syncHud();
  }

  function cancelDrag() {
    drag.active = false; drag.src = null; drag.cell = null; drag.moved = false;
    if (drag.el && drag.el.parentNode) drag.el.parentNode.removeChild(drag.el);
    drag.el = null;
    // V6 数值校准：拖拽结束，收回同字卡触发的等级角标（选中态仍保留）
    dragMatchKey = null; updateBadges();
    highlight(null);
    clearRange();
  }

  function highlight(t) {
    for (let r = 0; r < B.ROWS; r++) for (let c = 0; c < B.COLS; c++) cellEls[r][c].classList.remove('hl', 'bad');
    if (!t || !state) return;
    if (drag.src === 'board') {
      const u = state.units.find(function (x) { return x.id === drag.unitId; });
      if (!u) return;
      if (u.row === t.row && u.col === t.col) return;          // 原地松手：不标记
      const ok = B.canPlace(state, 'player', t.row, t.col, u.span);
      cellEls[t.row][t.col].classList.add(ok ? 'hl' : 'bad');
      return;
    }
    if (drag.src !== 'hand' && drag.src !== 'barracks' && drag.src !== 'shovel') return;
    let ok = false;
    if (drag.src === 'shovel') {
      ok = !B.isPath(state.mode, t.row, t.col, state.levelIdx) && !B.isObstacle(t.row, t.col) &&
        !state.deploy[B.key(t.row, t.col)] && B.adjacentToDeploy(state, 'player', t.row, t.col);
    } else {
      const s = state.player;
      const card = (s.hand.concat(s.barracks || [])).find(function (c) { return c.uid === drag.uid; });
      if (!card) return;
      if (card.kind === 'item') {
        if (card.item === 'brush') {
          const tw = state.grid[t.row][t.col];
          ok = !!tw && tw.side === 'player';
        } else {
          ok = true;   // 火球 / 神兵符：任意位置可释放
        }
      } else if (card.kind === 'gold') {
        ok = false;
      } else {
        const span = ZY.cardSpan(card);
        ok = B.canPlace(state, 'player', t.row, t.col, span) || isMergeTarget(t, card);
      }
    }
    cellEls[t.row][t.col].classList.add(ok ? 'hl' : 'bad');
  }
  /** 落到己方塔上：同字且未满级 → 可合成 */
  function isMergeTarget(t, card) {
    const tw = state.grid[t.row][t.col];
    if (!tw || tw.side !== 'player' || tw.cls !== 'soldier') return false;
    if (card.kind !== 'unit' || tw.type !== card.type) return false;
    return tw.level < C.MAX_LEVEL;
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
    if (card.kind === 'gold') {
      const ready = ZY.heroSynthReady(state, 'player');
      if (ready && ready.chars.indexOf(card.char) >= 0) {
        ZY.Game.synthHero(state, 'player');
        syncHand(); syncBarracks(); syncHud();
        toast('合成武将 · ' + ready.name + '（拖到塔位，横跨 2 格）');
        return;
      }
      const pair = ZY.HEROES.find(function (h) { return h.chars.indexOf(card.char) >= 0; });
      toast('金字「' + card.char + '」：凑齐「' + (pair ? pair.chars.join('') : '??') + '」另一半即可合成武将');
      return;
    }
    if (card.kind === 'hero') {
      const h = ZY.HERO_BY_ID[card.heroId];
      toast('武将卡「' + h.name + '」：拖到塔位落下，横跨 2 格');
      return;
    }
    if (card.kind === 'item') {
      const it = ZY.ITEMS[card.item];
      toast(it.name + '：拖出手牌释放 —— ' + it.desc);
      return;
    }
    toast('把「' + card.char + '」拖到塔位建塔；拖到同字塔上可合成升级');
  }

  function tapBarracks(uid) {
    const card = (state.player.barracks || []).find(function (x) { return x.uid === uid; });
    if (!card) return;
    if (card.kind === 'gold') {
      const ready = ZY.heroSynthReady(state, 'player');
      if (ready && ready.chars.indexOf(card.char) >= 0) {
        toast('「' + card.char + '」：先拖进军牌区（8 格），凑齐即可合成武将');
        return;
      }
    }
    toast(cardLabelOf(card) + '：拖进军牌区，或直接拖到棋盘建塔');
  }

  function cardLabelOf(card) {
    if (card.kind === 'item') return ZY.ITEMS[card.item].name;
    if (card.kind === 'hero') return '武将卡「' + card.char + '」';
    if (card.kind === 'gold') return '金字「' + card.char + '」';
    return '「' + card.char + '」' + U[card.type].name;
  }

  function selectUnit(u) {
    if (!u || u.dead) { clearRange(); return; }
    if (u.side === 'player' && u.range > 0) showRange(u); else clearRange();
    // V6 数值校准：点击/选中我方塔 → 显示其等级角标（脱离选中即隐藏）
    selectedUnitId = (u.side === 'player') ? u.id : null;
    updateBadges();
    showUnitInfo(u);
    ZY.Audio.play('tap');
  }

  function showUnitInfo(u) {
    if (u.cls === 'hero') {
      const h = ZY.HERO_BY_ID[u.heroId];
      const eq = u.weapon ? (' · 装备' + ZY.WEAPONS[u.weapon].name + '（攻击力+' + ZY.WEAPONS[u.weapon].atk + '）') : '';
      selectedHero = u.id;
      toast(u.char + ' Lv' + u.heroLevel + ' · ' + h.tag + eq +
        ' · 经验 (' + u.xp.toFixed(1) + '/' + C.XP_PER_LEVEL + ')' +
        ' · 攻 ' + u.atk.toFixed(1) + ' 技能「' + h.skill.name + '」' + h.skill.desc + '（CD ' + h.skill.cd + 's）');
    } else if (u.boss) {
      toast(u.name + '（敌方名将）：血 ' + Math.round(u.hp) + '/' + Math.round(u.maxHp) + ' · 沿主路直扑阿斗');
    } else if (u.type === 'nong') {
      toast('农民塔 Lv' + u.level + '：每秒 +' + (U.nong.produce * u.level).toFixed(1) + ' 资源');
    } else if (u.side === 'enemy') {
      toast('敌军' + (u.elite ? '精英' : '') + U[u.type].name + ' Lv' + u.level + '：血 ' + Math.round(u.hp) + '/' + Math.round(u.maxHp) +
        ' · 沿主路直扑阿斗');
    } else {
      toast(U[u.type].name + '塔 Lv' + u.level + ' · ' + U[u.type].tag +
        '：血 ' + Math.round(u.hp) + '/' + Math.round(u.maxHp) +
        ' 攻 ' + u.atk.toFixed(1) + ' 射程 ' + u.range +
        ' · 经验 (' + u.xp.toFixed(1) + '/' + C.XP_PER_LEVEL + ')');
    }
  }

  function handleCellTap(r, c) {
    clearRange();
    // V6 数值校准：点棋盘空白处 / 阿斗 → 收起选中塔的等级角标
    if (selectedUnitId !== null) { selectedUnitId = null; updateBadges(); }
    const a = B.adouAt(state.mode, 'player', state.levelIdx);
    if (a && r === a.row && c === a.col) { showAdouInfo('player'); return; }
  }

  function consume(uid) {
    const i = state.player.hand.findIndex(function (x) { return x.uid === uid; });
    if (i >= 0) state.player.hand.splice(i, 1);
    else {
      const j = (state.player.barracks || []).findIndex(function (x) { return x.uid === uid; });
      if (j >= 0) state.player.barracks.splice(j, 1);
    }
    handSig = ''; barSig = '';
  }

  function showAdouInfo(side) {
    const s = ZY.Game.sideState(state, side);
    if (!s) return;
    toast('阿斗：' + s.adou + ' / ' + C.ADOU_HP + ' 血。敌方单位踏入阿斗格会扣 1 血，' +
      '同时补偿 +' + C.ADOU_BONUS + ' 资源（卖血换经济）。血量归零即败。');
    ZY.Audio.play('tap');
  }

  /* ======================================================== 武器背包 */
  function openWeapons() {
    const s = state.player;
    const heroes = state.units.filter(function (u) { return u.side === 'player' && u.cls === 'hero' && !u.dead; });
    let html = '<h3>武器背包</h3>';
    Object.keys(ZY.WEAPONS).forEach(function (wid) {
      const w = ZY.WEAPONS[wid];
      html += '<div class="w-row"><b>' + w.glyph + '</b><span>' + w.name + ' · ' + w.desc + '</span><i>×' + (s.weapons[wid] || 0) + '</i></div>';
    });
    html += '<div class="w-heroes">';
    if (!heroes.length) {
      html += '<p class="dim">场上还没有武将 —— 在手牌里凑齐「赵+云」等字对合成武将卡，拖到塔位（占 2 格）即可上场。</p>';
    }
    heroes.forEach(function (u) {
      const eq = u.weapon ? ZY.WEAPONS[u.weapon].name : '未装备';
      html += '<div class="w-hero" data-uid="' + u.id + '"><b>' + u.char + '</b>' +
        '<span>Lv' + u.heroLevel + ' · 攻 ' + u.atk.toFixed(1) + ' · ' + eq + '</span>' +
        '<button class="btn small" data-act="equip">装备铁剑</button>' +
        (u.weapon ? '<button class="btn small" data-act="unequip">卸下</button>' : '') +
        '</div>';
    });
    html += '</div><button class="btn" data-act="close">关闭</button>';
    el.weaponPanel.innerHTML = html;
    el.weaponPanel.hidden = false;
    Array.prototype.forEach.call(el.weaponPanel.querySelectorAll('.btn'), function (b) {
      b.addEventListener('click', function () {
        const act = b.getAttribute('data-act');
        if (act === 'close') { el.weaponPanel.hidden = true; return; }
        const row = b.closest('.w-hero');
        const uid = row ? parseInt(row.dataset.uid, 10) : selectedHero;
        if (act === 'equip') {
          const r = ZY.Game.equipWeapon(state, 'player', uid, 'tiejian');
          toast(r.ok ? ('已装备铁剑 · ' + (ZY.HERO_BY_ID[state.units.find(function (x) { return x.id === uid; }).heroId] || {}).name + ' 攻击力+3') : r.msg);
        } else if (act === 'unequip') {
          const r = ZY.Game.unequipWeapon(state, 'player', uid);
          if (r.ok) toast('已卸下武器');
        }
        ZY.Audio.play('tap');
        syncUnits(); syncHud();
        openWeapons();
      });
    });
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
  /** 火球爆炸：爆裂火光 + 冲击波（3×3 范围视觉） */
  function boomFx(f) {
    const d = nodeAt(f.row, f.col, 'boom');
    spawnFx(d, 540);
  }
  /** 神兵符拖拽轨迹（节流 ~55ms 一个点，计入 fx 上限） */
  let lastTrailAt = 0;
  function maybeTrail(x, y) {
    const now = (window.performance && performance.now) ? performance.now() : Date.now();
    if (now - lastTrailAt < 55) return;
    lastTrailAt = now;
    const rect = el.board.getBoundingClientRect();
    const d = document.createElement('div');
    d.className = 'trail';
    d.style.left = ((x - rect.left) / rect.width * 100) + '%';
    d.style.top = ((y - rect.top) / rect.height * 100) + '%';
    spawnFx(d, 430);
  }
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
    // V6 性能：原实现「移除类 → void offsetWidth 强制同步布局 → 加回类」用于重启动画，
    //     但高频连击（多塔同帧命中）会每击触发一次全盘强制布局 → 掉帧尖刺。
    //     改为：已在闪烁则只续期（视觉无差），省掉强制布局；冷启动依旧自然播放。
    if (e.classList.contains(cls)) {
      clearTimeout(e['_' + cls]);
      e['_' + cls] = setTimeout(function () { e.classList.remove(cls); }, ms);
      return;
    }
    e.classList.add(cls);
    e['_' + cls] = setTimeout(function () { e.classList.remove(cls); }, ms);
  }
  function animUnit(uid) {
    const e = unitEls[uid];
    if (!e || e.classList.contains('a-attack')) return; // 同一单位攻击动画未播完不重复触发
    const w = e.dataset.weapon || 'dao';
    e.classList.add('a-attack', 'atk-' + w);
    const u = state.units.find(function (x) { return x.id === uid; });
    const interval = (u && u.aspd > 0) ? 1 / u.aspd : 0.9;
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
      if (f.type === 'boom') { boomFx(f); continue; }
      if (f.type === 'ring' || f.type === 'beam') { ringFx(f.row, f.col, f.type); continue; }
      if (f.type === 'slash') { slashFx(f); continue; }
      if (f.type === 'arrow') { arrowFx(f); continue; }
      if (f.type === 'pillar') { pillarFx(f); continue; }
      if (f.type === 'hit') { hitFx(f); flashUnitAt(f.row, f.col, 'a-hit', 260); continue; }
      if (f.type === 'dmg') { dmgFx(f); continue; }
      if (f.row == null) continue;
      if (f.type === 'merge' || f.type === 'up') flashUnitAt(f.row, f.col, 'a-levelup', 520); // 合成 / 升级金光
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
      syncBarracks();
      syncItems();
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

  /** V5 关卡胜利结算：胜利 / 恭喜晋升 / 1-5 星 / 金币 +20 / 双倍金币（仅展示） */
  function winPanelLevel() {
    const r = Math.min(ZY.RANKS.length - 1, ZY.Save.getRank() + 1);
    ZY.Save.setRank(r);
    const stars = ZY.Game.starsOf(state);
    let starHtml = '';
    for (let i = 1; i <= 5; i++) starHtml += '<i class="' + (i <= stars ? 'on' : 'off') + '">★</i>';
    return '<p class="promote">恭喜晋升 · <b>' + ZY.Save.rankName(r) + '</b></p>' +
      '<div class="stars">' + starHtml + '</div>' +
      '<p class="coin-row">奖励金币 <b>+20</b>' +
      '<button class="btn small gold" data-act="double">双倍金币</button></p>' +
      '<p class="dim">阿斗剩 ' + state.player.adou + ' 血 · 击杀 ' + state.stats.kills + ' · 用时 ' + Math.round(state.t) + 's</p>';
  }

  function showResult() {
    const win = state.result === 'win';
    let title = win ? '胜 利' : '败 北';
    let body = '';
    let btns = '';

    if (state.mode === 'versus') {
      const judged = state.wave.done && state.wave.idx >= T.versusWaves;   // 打满公共波次 → 按剩血/击杀/资源判定
      let reason = '';
      if (judged) {
        if (state.player.adou !== state.enemy.adou) {
          reason = T.versusWaves + ' 波攻势已过，阿斗 ' + state.player.adou + ' : ' + state.enemy.adou;
        } else if (state.player.kills !== state.enemy.kills) {
          reason = '阿斗持平，击杀 ' + state.player.kills + ' : ' + state.enemy.kills;
        } else {
          reason = '阿斗与击杀均持平，资源 ' + Math.floor(state.player.bun) + ' : ' + Math.floor(state.enemy.bun);
        }
      }
      if (win) {
        const r = Math.min(ZY.RANKS.length - 1, ZY.Save.getRank() + 1);
        ZY.Save.setRank(r);
        body = judged
          ? '<p>' + reason + '，我方占优。晋升军衔：<b>' + ZY.Save.rankName(r) + '</b></p>'
          : '<p>敌方阿斗已破。晋升军衔：<b>' + ZY.Save.rankName(r) + '</b></p>';
      } else {
        body = judged
          ? '<p>' + reason + '，我方居劣。再来一局。</p>'
          : '<p>我方阿斗失守。再来一局。</p>';
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
        body = winPanelLevel();
        if (next >= ZY.LEVELS.length) {
          ZY.Save.setLevel(ZY.LEVELS.length - 1);
          body += '<p>全关通关！</p>';
          btns = '<button class="btn primary" data-act="home">返回主菜单</button>' +
            '<button class="btn" data-act="restart">重打本关</button>';
        } else {
          ZY.Save.setLevel(next);
          body += '<p class="dim">下一关：' + ZY.LEVELS[next].name + '</p>';
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
        } else if (act === 'double') {
          toast('双倍金币：广告位预留（本版本不接广告）');
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

  /** 关卡模式开局：可继承上一关的棋盘 / 手牌 / 军营 / 武器
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
