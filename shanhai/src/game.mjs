/**
 * 《山海拾遗》界面与回合调度。
 *
 * 分工：core.mjs 只算规则；本文件只做三件事——
 *   1. 把状态画成 DOM；
 *   2. 把点击翻译成“选中 / 移动 / 攻击”；
 *   3. 调度敌方回合、结算和 localStorage。
 *
 * 因此本文件可以读 DOM，但不参与任何战斗公式；单元测试不需要它。
 */
(function boot() {
  'use strict';

  const Core = globalThis.ShanhaiCore;
  const Maps = globalThis.ShanhaiMaps;
  const Units = globalThis.ShanhaiUnits;
  const Storage = globalThis.ShanhaiStorage;

  if (!Core || !Maps || !Units || !Storage) {
    document.body.innerHTML = '<p style="padding:24px;color:#ded0b3">加载残卷失败，请确认 src/*.mjs 与 index.html 在同一目录。</p>';
    return;
  }

  const FAST = new URLSearchParams(window.location.search).has('fast');
  const REDUCED = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // fast 只服务自动化验证；正常节奏保留敌我行动之间的停顿，便于看清战局。
  const TIMING = FAST
    ? { between: 24, step: 8, result: 25 }
    : {
        between: REDUCED ? 60 : 460,
        step: REDUCED ? 0 : 96,
        result: REDUCED ? 60 : 420,
      };

  const dom = {};
  let state = emptyState();
  let save = Storage.loadSave();
  let runToken = 0;
  let toastTimer = null;

  function emptyState() {
    return {
      stage: null,
      map: null,
      units: [],
      round: 1,
      phase: 'idle',
      outcome: null,
      selectedId: null,
      actedIds: new Set(),
      movedIds: new Set(),
      log: [],
      playerMaxHp: 0,
      initialEnemyCount: 0,
      saved: false,
      result: null,
    };
  }

  function cacheDom() {
    const ids = [
      'board', 'turn-veil', 'stage-caption', 'stage-kicker', 'stage-name', 'stage-subtitle',
      'round-label', 'turn-label', 'hint', 'roster', 'log', 'end-turn', 'wait-unit',
      'pick-stage', 'restart-stage', 'save-status', 'stage-screen', 'stage-list',
      'stage-close', 'result-screen', 'result-retry', 'result-next', 'result-back',
      'result-stamp', 'result-kicker', 'result-title', 'result-rating', 'result-rounds',
      'result-hp', 'result-kills', 'result-note', 'toast',
    ];
    for (const id of ids) dom[id] = document.getElementById(id);
    dom.resultPanel = dom['result-screen'].querySelector('.result-panel');
  }

  function init() {
    cacheDom();
    bindEvents();
    renderStageList();
    renderAll();
    dom['stage-screen'].hidden = false;
    dom['stage-close'].hidden = true;
    updateSaveStatus();
    exposeDebugApi();
    document.title = '山海拾遗 · 残卷战棋';
    window.setTimeout(() => {
      const first = dom['stage-list'].querySelector('[data-stage]');
      if (first) first.focus({ preventScroll: true });
    }, 30);
  }

  function bindEvents() {
    dom.board.addEventListener('click', onBoardClick);
    dom.roster.addEventListener('click', onRosterClick);
    dom['stage-list'].addEventListener('click', (event) => {
      const card = event.target.closest('[data-stage]');
      if (!card) return;
      startStage(card.dataset.stage);
    });
    dom['end-turn'].addEventListener('click', endPlayerTurn);
    dom['wait-unit'].addEventListener('click', waitSelectedUnit);
    dom['pick-stage'].addEventListener('click', openStageScreen);
    dom['restart-stage'].addEventListener('click', () => {
      if (!state.stage) return;
      startStage(state.stage.id);
    });
    dom['stage-close'].addEventListener('click', closeStageScreen);
    dom['result-retry'].addEventListener('click', () => {
      if (state.stage) startStage(state.stage.id);
    });
    dom['result-next'].addEventListener('click', () => {
      if (!state.stage) return;
      const next = Maps.nextStage(state.stage.id);
      if (next) startStage(next.id);
    });
    dom['result-back'].addEventListener('click', () => {
      dom['result-screen'].hidden = true;
      openStageScreen();
    });
  }

  /* ── 开局 / 关卡 ─────────────────────────────────────────────────── */

  function startStage(stageId) {
    const stage = Maps.getStage(stageId);
    if (!stage) {
      showToast('残卷中找不到这一关。');
      return;
    }

    runToken += 1;
    save = Storage.loadSave();
    const counts = new Map();
    const units = stage.deploy.map((deploy, index) => {
      const count = (counts.get(deploy.templateId) || 0) + 1;
      counts.set(deploy.templateId, count);
      const template = Units.getTemplate(deploy.templateId);
      const team = deploy.team || (template && template.teamHint) || 'enemy';
      return Units.createUnit(deploy.templateId, {
        team,
        x: deploy.x,
        y: deploy.y,
        index,
        id: `${stage.id}-${team}-${deploy.templateId}-${count}`,
      });
    });

    state = {
      ...emptyState(),
      stage,
      map: stage,
      units,
      round: 1,
      phase: 'player',
      playerMaxHp: units
        .filter((unit) => unit.team === 'player')
        .reduce((sum, unit) => sum + unit.maxHp, 0),
      initialEnemyCount: units.filter((unit) => unit.team === 'enemy').length,
    };

    appendLog(`卷开 · ${stage.name}。${stage.objective}`, 'system');
    appendLog(stage.intro, 'muted');

    dom['stage-screen'].hidden = true;
    dom['result-screen'].hidden = true;
    dom['stage-close'].hidden = false;
    dom.resultPanel.classList.remove('is-loss');
    document.title = `${stage.name} · 山海拾遗`;
    renderAll();
    showToast(`入卷 · ${stage.name}`, 'good');
  }

  function openStageScreen() {
    renderStageList();
    dom['stage-screen'].hidden = false;
    dom['stage-close'].hidden = !state.stage;
    const target = state.stage
      ? dom['stage-close']
      : dom['stage-list'].querySelector('[data-stage]');
    if (target) window.setTimeout(() => target.focus({ preventScroll: true }), 20);
  }

  function closeStageScreen() {
    if (!state.stage) return;
    dom['stage-screen'].hidden = true;
  }

  function renderStageList() {
    if (!dom['stage-list']) return;
    dom['stage-list'].innerHTML = Maps.STAGES.map((stage) => {
      const entry = save.cleared[stage.id];
      const best = entry
        ? `最高 ${entry.bestRating}${entry.bestRounds ? ` · ${entry.bestRounds} 回合` : ''}`
        : '未破';
      return `
        <button class="stage-card${entry ? ' is-cleared' : ''}" type="button"
          data-stage="${escapeHtml(stage.id)}"
          aria-label="进入${escapeHtml(stage.name)}，${entry ? `最高评级 ${entry.bestRating}` : '尚未通关'}">
          <span class="stage-card__seal" aria-hidden="true">${escapeHtml(stage.seal)}</span>
          <span class="stage-card__body">
            <span class="stage-card__eyebrow">卷 ${stage.order} · ${escapeHtml(stage.difficulty)}</span>
            <strong class="stage-card__name">${escapeHtml(stage.name)}</strong>
            <span class="stage-card__objective">${escapeHtml(stage.objective)}</span>
            <span class="stage-card__best">${escapeHtml(best)}</span>
          </span>
          <span class="stage-card__enter">入卷 ›</span>
        </button>
      `;
    }).join('');
  }

  /* ── 绘制 ────────────────────────────────────────────────────────── */

  function renderAll() {
    const stage = state.stage;
    dom['stage-caption'].textContent = stage
      ? `${stage.name} · ${stage.subtitle}`
      : '残卷战棋 · 未择卷';
    dom['stage-kicker'].textContent = stage
      ? `卷 ${stage.order} · ${stage.difficulty}`
      : '残卷 · 待启';
    dom['stage-name'].textContent = stage ? stage.name : '山海拾遗';
    dom['stage-subtitle'].textContent = stage ? stage.objective : '择一卷，入山海。';
    dom['round-label'].textContent = stage ? `第 ${state.round} 回合` : '第 1 回合';

    const turn = turnInfo();
    dom['turn-label'].textContent = turn.label;
    dom['turn-label'].dataset.side = turn.side;
    dom['turn-veil'].hidden = state.phase !== 'enemy';
    dom['wait-unit'].disabled = !canWaitSelected();
    dom['end-turn'].disabled = !(stage && state.phase === 'player' && !state.outcome);
    dom['restart-stage'].disabled = !stage;
    dom['pick-stage'].disabled = false;

    renderBoard();
    renderRoster();
    renderLog();
    renderHint();
    updateSaveStatus();
  }

  function turnInfo() {
    if (state.phase === 'enemy') return { label: '敌方行棋', side: 'enemy' };
    if (state.phase === 'over') return { label: '战事已定', side: 'over' };
    if (state.phase === 'player') return { label: '我方行棋', side: 'player' };
    return { label: '待战', side: 'idle' };
  }

  function renderBoard() {
    const board = dom.board;
    board.innerHTML = '';
    if (!state.stage) {
      board.setAttribute('aria-label', '尚未择卷');
      return;
    }

    board.setAttribute('aria-label', `${state.stage.name}八列六行战棋战场`);
    const selected = getSelectedUnit();
    const canAct = state.phase === 'player' && !state.outcome && selected;
    const hasMoved = selected ? state.movedIds.has(selected.id) : false;
    const moveCells = canAct && !hasMoved
      ? new Map(Core.computeMoveRange(state.map, state.units, selected).map((cell) => [Core.keyOf(cell), cell]))
      : new Map();
    const attackTargets = canAct
      ? new Set(Core.getAttackTargets(state.units, selected).map((unit) => unit.id))
      : new Set();

    const fragment = document.createDocumentFragment();
    for (let y = 0; y < Core.mapHeight(state.map); y += 1) {
      for (let x = 0; x < Core.mapWidth(state.map); x += 1) {
        const terrain = Core.terrainAt(state.map, x, y);
        const unit = Core.unitAt(state.units, x, y);
        const key = `${x},${y}`;
        const origin = selected && selected.x === x && selected.y === y;
        const isMove = Boolean(selected && !hasMoved && !origin && !unit && moveCells.has(key));
        const isTarget = Boolean(unit && attackTargets.has(unit.id));
        const isSelected = Boolean(unit && selected && unit.id === selected.id);
        const isActed = Boolean(unit && unit.team === 'player' && (unit.acted || state.actedIds.has(unit.id)));

        const button = document.createElement('button');
        button.type = 'button';
        button.className = `cell cell--${terrainKey(terrain)}`;
        button.dataset.x = String(x);
        button.dataset.y = String(y);
        button.dataset.terrain = terrain.name;
        if (isMove) button.classList.add('cell--move');
        if (isTarget) button.classList.add('cell--target');
        if (isSelected) button.classList.add('cell--selected');
        if (state.phase === 'over') button.disabled = true;

        const glyph = terrainGlyph(terrain);
        const unitMarkup = unit ? unitToMarkup(unit, isActed) : '';
        if (unit) button.dataset.unitId = unit.id;
        button.innerHTML = `${glyph}${unitMarkup}`;

        button.setAttribute('aria-label', cellLabel({ x, y, terrain, unit, isMove, isTarget, isSelected }));
        fragment.appendChild(button);
      }
    }
    board.appendChild(fragment);
  }

  function unitToMarkup(unit, isActed) {
    const ratio = unit.maxHp > 0 ? Math.round((unit.hp / unit.maxHp) * 100) : 0;
    return `
      <span class="unit unit--${unit.team} unit--${unit.classId}${isActed ? ' unit--acted' : ''}"
        style="--hp:${ratio}%">
        <span class="unit__sigil" aria-hidden="true">${escapeHtml(unit.sigil)}</span>
        <span class="unit__hp" aria-hidden="true"><span class="unit__hp-fill"></span></span>
      </span>
    `;
  }

  function cellLabel(info) {
    const parts = [`第${info.y + 1}行第${info.x + 1}列`, info.terrain.name];
    if (info.unit) {
      const side = info.unit.team === 'player' ? '我方' : '敌方';
      parts.push(`${side}${info.unit.name}，生命 ${info.unit.hp}/${info.unit.maxHp}`);
    }
    if (info.isMove) parts.push('可移动');
    if (info.isTarget) parts.push('可攻击');
    if (info.isSelected) parts.push('已选中');
    return parts.join('，');
  }

  function terrainKey(terrain) {
    if (terrain.code === 'F') return 'forest';
    if (terrain.code === 'M') return 'mountain';
    if (terrain.code === 'W') return 'water';
    return 'plain';
  }

  function terrainGlyph(terrain) {
    const marks = { '.': '·', F: '林', M: '山', W: '水' };
    return `<span class="cell__glyph" aria-hidden="true">${marks[terrain.code] || ''}</span>`;
  }

  function renderRoster() {
    if (!state.stage) {
      dom.roster.innerHTML = '<p class="empty-note">尚未入卷。</p>';
      return;
    }
    const players = state.units.filter((unit) => unit.team === 'player');
    dom.roster.innerHTML = players.map((unit) => {
      const hp = Math.max(0, unit.hp);
      const ratio = unit.maxHp > 0 ? Math.round((hp / unit.maxHp) * 100) : 0;
      const acted = unit.acted || state.actedIds.has(unit.id);
      const selected = state.selectedId === unit.id;
      const stateLabel = !unit.alive
        ? '已倒'
        : selected
          ? '行棋中'
          : acted
            ? '已行动'
            : state.movedIds.has(unit.id)
              ? '已移动'
              : '待命';
      const classes = [
        'unit-card',
        `unit-card--${unit.classId}`,
        selected ? 'is-selected' : '',
        acted ? 'is-spent' : '',
        unit.alive ? '' : 'is-fallen',
      ].filter(Boolean).join(' ');
      const disabled = !unit.alive || acted || state.phase !== 'player' || Boolean(state.outcome);
      return `
        <button class="${classes}" type="button" data-roster-id="${escapeHtml(unit.id)}"
          ${disabled ? 'disabled' : ''}
          aria-label="${escapeHtml(unit.name)}，${escapeHtml(unit.className)}，生命 ${hp}/${unit.maxHp}，${stateLabel}">
          <span class="unit-card__sigil" aria-hidden="true">${escapeHtml(unit.sigil)}</span>
          <span class="unit-card__body">
            <span class="unit-card__title">
              <span class="unit-card__name">${escapeHtml(unit.name)}</span>
              <span class="unit-card__class">${escapeHtml(unit.className)}</span>
            </span>
            <span class="unit-card__hp" aria-hidden="true"><span class="unit-card__hp-fill" style="--hp:${ratio}%"></span></span>
            <span class="unit-card__stats">
              <span>攻 <b>${unit.atk}</b></span>
              <span>防 <b>${unit.def}</b></span>
              <span>移 <b>${unit.move}</b></span>
              <span>射 <b>${unit.range}</b></span>
              <span>血 <b>${hp}/${unit.maxHp}</b></span>
            </span>
          </span>
          <span class="unit-card__state${!acted && unit.alive ? ' is-ready' : ''}">${stateLabel}</span>
        </button>
      `;
    }).join('');
  }

  function renderLog() {
    if (!state.log.length) {
      dom.log.innerHTML = '<li class="log__item log__item--muted"><span class="log__round">—</span><span>风过残卷，尚无战事。</span></li>';
      return;
    }
    const entries = state.log.slice(-7).reverse();
    dom.log.innerHTML = entries.map((entry) => `
      <li class="log__item log__item--${entry.tone}">
        <span class="log__round">R${entry.round}</span>
        <span>${escapeHtml(entry.text)}</span>
      </li>
    `).join('');
  }

  function renderHint() {
    if (!state.stage) {
      dom.hint.textContent = '从卷首择一关。墨色为野，朱砂为火。';
      return;
    }
    if (state.outcome) {
      dom.hint.textContent = state.outcome === 'win'
        ? '残卷已合。可在结算中再战，或续读下卷。'
        : '此卷未合。整阵再战，或换一卷重读。';
      return;
    }
    if (state.phase === 'enemy') {
      dom.hint.textContent = '敌方正在行棋。朱框会标出被攻击的我方单位。';
      return;
    }
    const selected = getSelectedUnit();
    if (selected) {
      const targets = Core.getAttackTargets(state.units, selected);
      if (state.movedIds.has(selected.id)) {
        dom.hint.textContent = targets.length
          ? `${selected.name} 已移动：点朱框敌人出手，或点“待命”收势。`
          : `${selected.name} 已移动，射程内没有目标。点“待命”结束行动。`;
        return;
      }
      dom.hint.textContent = targets.length
        ? `${selected.name}：墨框可移动；朱框敌人已在射程内，可直接攻击。`
        : `${selected.name}：墨框为可移动格。移动后若入射程，再点敌人攻击。`;
      return;
    }
    const allActed = state.units
      .filter((unit) => unit.team === 'player' && unit.alive)
      .every((unit) => state.actedIds.has(unit.id) || unit.acted);
    dom.hint.textContent = allActed
      ? '全员已行动。点“结束回合”，看敌方如何应招。'
      : '点选我方单位，查看墨色可移动格与朱框可攻击目标。';
  }

  function updateSaveStatus() {
    const count = Object.keys(save.cleared).length;
    dom['save-status'].textContent = `存档 v${Storage.SAVE_VERSION} · 已录 ${count} 卷`;
  }

  /* ── 玩家操作 ────────────────────────────────────────────────────── */

  function onBoardClick(event) {
    const cell = event.target.closest('.cell');
    if (!cell || !state.stage) return;
    if (state.phase !== 'player' || state.outcome) return;

    const x = Number(cell.dataset.x);
    const y = Number(cell.dataset.y);
    const unit = Core.unitAt(state.units, x, y);
    const selected = getSelectedUnit();

    if (unit && unit.team === 'player') {
      if (selected && selected.id === unit.id) {
        state.selectedId = null;
        renderAll();
        return;
      }
      if (unit.acted || state.actedIds.has(unit.id)) {
        showToast(`${unit.name} 本回合已行动。`);
        return;
      }
      state.selectedId = unit.id;
      renderAll();
      return;
    }

    if (unit && unit.team === 'enemy') {
      if (!selected) {
        showToast('先点选我方单位。');
        return;
      }
      const targets = Core.getAttackTargets(state.units, selected);
      if (targets.some((target) => target.id === unit.id)) {
        playerAttack(selected, unit);
      } else {
        showToast(`${unit.name} 不在 ${selected.name} 的射程内。`);
      }
      return;
    }

    if (!selected) return;
    if (state.movedIds.has(selected.id)) {
      showToast(`${selected.name} 本回合已经移动过。`);
      return;
    }
    const reachable = Core.computeMoveRange(state.map, state.units, selected);
    const destination = reachable.find((cellInfo) => cellInfo.x === x && cellInfo.y === y && cellInfo.cost > 0);
    if (!destination) {
      showToast('此格不可到达。');
      return;
    }
    moveSelected(selected, x, y);
  }

  function onRosterClick(event) {
    const card = event.target.closest('[data-roster-id]');
    if (!card || state.phase !== 'player' || state.outcome) return;
    const unit = state.units.find((candidate) => candidate.id === card.dataset.rosterId);
    if (!unit || !unit.alive) return;
    if (unit.acted || state.actedIds.has(unit.id)) {
      showToast(`${unit.name} 本回合已行动。`);
      return;
    }
    state.selectedId = state.selectedId === unit.id ? null : unit.id;
    renderAll();
  }

  function moveSelected(unit, x, y) {
    state.units = state.units.map((candidate) => (
      candidate.id === unit.id ? { ...candidate, x, y, moved: true } : candidate
    ));
    state.movedIds.add(unit.id);
    const moved = state.units.find((candidate) => candidate.id === unit.id);
    appendLog(`${moved.name} 移至第 ${y + 1} 行第 ${x + 1} 列。`, 'player');
    const targets = Core.getAttackTargets(state.units, moved);
    renderAll();
    if (targets.length) {
      showToast('已入射程，点朱框敌人出手。', 'attack');
    } else {
      showToast('已移动，射程内无目标。', 'good');
    }
  }

  function playerAttack(attacker, target) {
    const result = Core.resolveAttack(state, attacker.id, target.id);
    const before = new Map(state.units.map((unit) => [unit.id, unit]));
    state.units = Core.applyAttackResult(state.units, result);
    markActed(attacker.id);
    state.selectedId = null;
    recordHits(result, before, 'player');
    state.outcome = Core.checkBattleOutcome(state.units);
    renderAll();
    showToast(`造成 ${result.totalDamage} 点伤害。`, 'attack');
    if (state.outcome) finishBattle(state.outcome);
  }

  function waitSelectedUnit() {
    const selected = getSelectedUnit();
    if (!selected || state.phase !== 'player' || state.outcome) return;
    appendLog(`${selected.name} 按剑待命。`, 'player');
    markActed(selected.id);
    state.selectedId = null;
    renderAll();
    showToast(`${selected.name} 本回合收势。`);
  }

  function endPlayerTurn() {
    if (!state.stage || state.phase !== 'player' || state.outcome) return;
    state.selectedId = null;
    state.phase = 'enemy';
    const token = ++runToken;
    appendLog('我方收阵，敌方行棋。', 'system');
    renderAll();
    runEnemyTurn(token).catch(() => {
      if (token !== runToken) return;
      state.phase = 'player';
      state.selectedId = null;
      renderAll();
      showToast('行棋受阻，请重开此卷。');
    });
  }

  function markActed(unitId) {
    state.actedIds.add(unitId);
    state.units = state.units.map((unit) => (
      unit.id === unitId ? { ...unit, acted: true } : unit
    ));
  }

  /* ── 敌方 AI 回合 ─────────────────────────────────────────────────── */

  async function runEnemyTurn(token) {
    await sleep(TIMING.between);
    if (!activeToken(token)) return;

    const enemyIds = state.units
      .filter((unit) => unit.team === 'enemy' && unit.alive)
      .map((unit) => unit.id);

    for (const enemyId of enemyIds) {
      if (!activeToken(token)) return;
      const enemy = state.units.find((unit) => unit.id === enemyId);
      if (!enemy || !enemy.alive) continue;

      const plan = Core.chooseAIPlan(state, enemyId);
      if (!plan) continue;

      if (plan.path.length) {
        for (const step of plan.path) {
          if (!activeToken(token)) return;
          state.units = state.units.map((unit) => (
            unit.id === enemyId ? { ...unit, x: step.x, y: step.y, moved: true } : unit
          ));
          renderBoard();
          await sleep(TIMING.step);
        }
        appendLog(`${enemy.name} 移步逼近。`, 'enemy');
        renderAll();
        await sleep(TIMING.between);
      } else if (!plan.targetId) {
        appendLog(`${enemy.name} 守住地势，按兵不动。`, 'enemy');
        renderAll();
      }

      if (!activeToken(token)) return;

      if (plan.targetId) {
        const actor = state.units.find((unit) => unit.id === enemyId);
        const target = state.units.find((unit) => unit.id === plan.targetId);
        if (actor && target && target.alive) {
          const result = Core.resolveAttack(state, actor.id, target.id);
          const before = new Map(state.units.map((unit) => [unit.id, unit]));
          state.units = Core.applyAttackResult(state.units, result);
          state.units = state.units.map((unit) => (
            unit.id === enemyId ? { ...unit, acted: true } : unit
          ));
          recordHits(result, before, 'enemy');
          state.outcome = Core.checkBattleOutcome(state.units);
          renderAll();
          await sleep(TIMING.between);
          if (state.outcome) {
            finishBattle(state.outcome);
            return;
          }
        }
      }

      await sleep(TIMING.between);
    }

    if (!activeToken(token)) return;
    const outcome = Core.checkBattleOutcome(state.units);
    if (outcome) {
      finishBattle(outcome);
      return;
    }
    startPlayerTurn(token);
  }

  function activeToken(token) {
    return token === runToken && Boolean(state.stage) && state.phase === 'enemy';
  }

  function startPlayerTurn(token) {
    if (token !== runToken || !state.stage || state.outcome) return;
    state.round += 1;
    state.phase = 'player';
    state.selectedId = null;
    state.actedIds.clear();
    state.movedIds.clear();
    state.units = state.units.map((unit) => ({ ...unit, acted: false, moved: false }));
    appendLog(`第 ${state.round} 回合 · 我方行棋。`, 'system');
    renderAll();
    showToast(`第 ${state.round} 回合 · 我方`, 'good');
  }

  function recordHits(result, before, tone) {
    for (const hit of result.hits) {
      const victim = before.get(hit.unitId);
      if (!victim) continue;
      const afterHp = Math.max(0, victim.hp - hit.damage);
      const attacker = before.get(result.attackerId);
      const attackerName = attacker ? attacker.name : '术火';
      const verb = hit.splash ? '的余烬波及' : '对';
      const ending = afterHp <= 0 ? '，击倒。' : `（余 ${afterHp}）。`;
      appendLog(`${attackerName} ${verb} ${victim.name} 造成 ${hit.damage} 点伤害${ending}`, afterHp <= 0 ? 'kill' : tone);
    }
  }

  /* ── 结算与存档 ───────────────────────────────────────────────────── */

  function finishBattle(outcome) {
    if (!state.stage || state.result) return;
    state.outcome = outcome;
    state.phase = 'over';
    state.selectedId = null;
    runToken += 1;

    const won = outcome === 'win';
    const hpRemaining = Core.totalHp(state.units, 'player');
    const hpTotal = state.playerMaxHp;
    const aliveEnemies = state.units.filter((unit) => unit.team === 'enemy' && unit.alive).length;
    const kills = state.initialEnemyCount - aliveEnemies;
    const rating = Core.rateBattle({
      won,
      rounds: state.round,
      hpRemaining,
      hpTotal,
    });
    const result = {
      won,
      rounds: state.round,
      hpRemaining,
      hpTotal,
      kills,
      enemyTotal: state.initialEnemyCount,
      rating,
      recorded: false,
    };

    if (won) {
      const recorded = Storage.recordClear(state.stage.id, {
        won,
        rounds: state.round,
        hpRemaining,
        hpTotal,
        rating,
      });
      save = recorded.save;
      result.recorded = recorded.recorded;
      state.saved = recorded.recorded;
    }

    state.result = result;
    updateSaveStatus();
    renderStageList();
    renderAll();

    const scheduledStageId = state.stage.id;
    window.setTimeout(() => {
      if (!state.result || state.stage.id !== scheduledStageId) return;
      showResultPanel();
    }, TIMING.result);
  }

  function showResultPanel() {
    const result = state.result;
    const stage = state.stage;
    if (!result || !stage) return;
    const won = result.won;
    dom.resultPanel.classList.toggle('is-loss', !won);
    dom['result-stamp'].textContent = won ? '捷' : '退';
    dom['result-kicker'].textContent = won ? '战事已定 · 残卷收入' : '战事已定 · 残卷未合';
    dom['result-title'].textContent = won
      ? (stage.id === 'qingqiu' ? '青丘路开' : stage.id === 'buzhou' ? '九首归寂' : '残卷已合')
      : '残卷未合';
    dom['result-rating'].textContent = won ? result.rating : '—';
    dom['result-rounds'].textContent = String(result.rounds);
    dom['result-hp'].textContent = `${result.hpRemaining} / ${result.hpTotal}`;
    dom['result-kills'].textContent = `${result.kills} / ${result.enemyTotal}`;
    dom['result-note'].textContent = won
      ? result.recorded
        ? `本卷最高评级已写为 ${result.rating}。${result.rating === 'S' ? '山风未动，阵脚未乱。' : '残卷收拢，山风复静。'}`
        : '此局已胜，但本地存档不可写；关闭页面后进度会丢失。'
      : '山风掩去来路。整阵再战，或换一卷重读。';
    const next = Maps.nextStage(stage.id);
    dom['result-next'].hidden = !won || !next;
    dom['result-next'].textContent = next ? `续读 · ${next.name}` : '续读下卷';
    // 结算页出现后收起战场飘条，避免“造成伤害”盖在评级上。
    window.clearTimeout(toastTimer);
    dom.toast.hidden = true;
    dom['result-screen'].hidden = false;
    window.setTimeout(() => dom['result-retry'].focus({ preventScroll: true }), 20);
  }

  /* ── 小工具 ──────────────────────────────────────────────────────── */

  function getSelectedUnit() {
    if (!state.selectedId) return null;
    const unit = state.units.find((candidate) => candidate.id === state.selectedId);
    if (!unit || !unit.alive || unit.team !== 'player') return null;
    return unit;
  }

  function canWaitSelected() {
    const selected = getSelectedUnit();
    return Boolean(selected && state.phase === 'player' && !state.outcome && !selected.acted);
  }

  function appendLog(text, tone) {
    const entry = {
      round: state.stage ? state.round : 0,
      tone: tone || 'system',
      text,
    };
    state.log.push(entry);
    if (state.log.length > 60) state.log.splice(0, state.log.length - 60);
  }

  function showToast(message, tone) {
    if (!dom.toast) return;
    window.clearTimeout(toastTimer);
    dom.toast.textContent = message;
    dom.toast.dataset.tone = tone || 'info';
    dom.toast.hidden = false;
    toastTimer = window.setTimeout(() => {
      dom.toast.hidden = true;
    }, FAST ? 600 : 2100);
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[character]));
  }

  /* ── 自动化验证接口 ─────────────────────────────────────────────────
     通过 CDP 读取只读快照、请求 AI 规划；真正操作仍然走上面的 DOM 点击，
     这样验证脚本不会绕过界面。 */
  function snapshot() {
    const selected = getSelectedUnit();
    const moveRange = selected && state.phase === 'player' && !state.movedIds.has(selected.id)
      ? Core.computeMoveRange(state.map, state.units, selected)
        .filter((cell) => cell.cost > 0)
        .map((cell) => ({ x: cell.x, y: cell.y, cost: cell.cost }))
      : [];
    const attacks = selected && state.phase === 'player'
      ? Core.getAttackTargets(state.units, selected).map((unit) => ({
          id: unit.id, name: unit.name, x: unit.x, y: unit.y, hp: unit.hp,
        }))
      : [];
    return {
      stageId: state.stage ? state.stage.id : null,
      stageName: state.stage ? state.stage.name : null,
      round: state.round,
      phase: state.phase,
      outcome: state.outcome,
      selectedId: state.selectedId,
      units: state.units.map((unit) => ({
        id: unit.id,
        name: unit.name,
        classId: unit.classId,
        team: unit.team,
        x: unit.x,
        y: unit.y,
        hp: unit.hp,
        maxHp: unit.maxHp,
        atk: unit.atk,
        def: unit.def,
        move: unit.move,
        range: unit.range,
        alive: unit.alive,
        acted: unit.acted,
        moved: unit.moved,
      })),
      actedIds: Array.from(state.actedIds),
      movedIds: Array.from(state.movedIds),
      movable: moveRange,
      attackable: attacks,
      moveCells: document.querySelectorAll('.cell--move').length,
      targetCells: document.querySelectorAll('.cell--target').length,
      logs: state.log.slice(-16),
      result: state.result,
      overlay: {
        stage: !dom['stage-screen'].hidden,
        result: !dom['result-screen'].hidden,
      },
      save: {
        version: save.version,
        cleared: save.cleared,
      },
    };
  }

  function exposeDebugApi() {
    Object.defineProperty(window, '__SHANHAI_DEBUG__', {
      value: Object.freeze({
        snapshot,
        planFor(unitId) {
          return Core.chooseAIPlan(state, unitId);
        },
        constants: {
          fast: FAST,
          saveKey: Storage.STORAGE_KEY,
          saveVersion: Storage.SAVE_VERSION,
        },
      }),
      writable: false,
      configurable: false,
      enumerable: true,
    });
  }

  init();
}());
