/**
 * 《山海拾遗 · 棋艺》交互层 —— 只负责 DOM、事件、AI 调度；规则全在 chess-core.mjs。
 *
 * 接入方式：页面存在一个 <section id="chess-screen"> 容器，本模块在其内构建
 * “棋类大厅 + 对局面板”。调用 ShanhaiChessUI.open() 即可从战棋界面切入。
 */
(function attachChessUI() {
  'use strict';
  const Core = globalThis.ShanhaiChessCore;
  const Render = globalThis.ShanhaiChessRender;

  let root, lobbyEl, modesEl, optsEl, gameEl, canvas, ctx, statusEl, turnEl, titleEl;
  let state = null, history = [], selected = null, targets = [], hoverCell = null;
  let humanSides = new Set(['r', 'b']);
  let aiColor = null;
  let vsAI = true, myColor = 'r';
  let aiPending = false, currentLayout = null;

  function init() {
    root = document.getElementById('chess-screen');
    if (!root || root.dataset.bound) return;
    root.dataset.bound = '1';
    root.innerHTML = `
      <div class="screen__panel chess-panel">
        <div class="chess-lobby" id="chess-lobby">
          <p class="eyebrow">SHAN HAI · QI YI</p>
          <h2>棋艺</h2>
          <p class="hero-copy">择一棋，对坐手谈。棋子皆为实体图形，非文字。</p>
          <div class="chess-opts" id="chess-opts"></div>
          <div class="chess-modes" id="chess-modes"></div>
          <div class="screen__foot">
            <button class="btn btn--ghost btn--small" id="chess-close" type="button">返回战棋</button>
          </div>
        </div>
        <div class="chess-game" id="chess-game" hidden>
          <div class="chess-topbar">
            <button class="btn btn--ghost btn--small" id="chess-tolobby" type="button">返回</button>
            <span class="chess-title" id="chess-title"></span>
            <span class="chess-turn" id="chess-turn"></span>
            <button class="btn btn--ghost btn--small" id="chess-undo" type="button">悔棋</button>
            <button class="btn btn--ghost btn--small" id="chess-restart" type="button">重开</button>
          </div>
          <div class="chess-board-wrap"><canvas id="chess-canvas"></canvas></div>
          <p class="chess-status" id="chess-status" aria-live="polite"></p>
        </div>
      </div>`;

    lobbyEl = document.getElementById('chess-lobby');
    modesEl = document.getElementById('chess-modes');
    optsEl = document.getElementById('chess-opts');
    gameEl = document.getElementById('chess-game');
    canvas = document.getElementById('chess-canvas');
    ctx = canvas.getContext('2d');
    statusEl = document.getElementById('chess-status');
    turnEl = document.getElementById('chess-turn');
    titleEl = document.getElementById('chess-title');

    document.getElementById('chess-close').addEventListener('click', close);
    document.getElementById('chess-tolobby').addEventListener('click', showLobby);
    document.getElementById('chess-undo').addEventListener('click', undo);
    document.getElementById('chess-restart').addEventListener('click', () => { if (state) startGame(state.mode); });
    canvas.addEventListener('click', onCanvasClick);
    canvas.addEventListener('mousemove', onCanvasMove);
    canvas.addEventListener('mouseleave', () => { hoverCell = null; render(); });
    window.addEventListener('resize', () => { if (!gameEl.hidden && state) render(); });

    buildOptions();
    buildModes();

    const openBtn = document.getElementById('open-chess');
    if (openBtn) openBtn.addEventListener('click', open);
    const openBtn2 = document.getElementById('open-chess-stage');
    if (openBtn2) openBtn2.addEventListener('click', open);
  }

  function buildOptions() {
    optsEl.innerHTML = `
      <div class="chess-opt">
        <span class="chess-opt__label">对手</span>
        <div class="chess-seg" role="group" aria-label="对手">
          <button type="button" data-vs="1" class="${vsAI ? 'is-on' : ''}">人机</button>
          <button type="button" data-vs="0" class="${!vsAI ? 'is-on' : ''}">双人</button>
        </div>
      </div>
      <div class="chess-opt" id="chess-color-opt">
        <span class="chess-opt__label">执子</span>
        <div class="chess-seg" role="group" aria-label="执子">
          <button type="button" data-color="r" class="${myColor === 'r' ? 'is-on' : ''}">红方</button>
          <button type="button" data-color="b" class="${myColor === 'b' ? 'is-on' : ''}">黑方</button>
        </div>
      </div>`;
    optsEl.querySelectorAll('[data-vs]').forEach((b) => b.addEventListener('click', () => {
      vsAI = b.dataset.vs === '1';
      optsEl.querySelectorAll('[data-vs]').forEach((x) => x.classList.toggle('is-on', x === b));
      document.getElementById('chess-color-opt').style.opacity = vsAI ? '1' : '0.4';
    }));
    optsEl.querySelectorAll('[data-color]').forEach((b) => b.addEventListener('click', () => {
      myColor = b.dataset.color;
      optsEl.querySelectorAll('[data-color]').forEach((x) => x.classList.toggle('is-on', x === b));
    }));
    document.getElementById('chess-color-opt').style.opacity = vsAI ? '1' : '0.4';
  }

  function buildModes() {
    modesEl.innerHTML = Core.MODES.map((m) => `
      <button class="chess-mode-card" type="button" data-mode="${m.id}">
        <span class="chess-mode-card__name">${m.name}</span>
        <span class="chess-mode-card__blurb">${m.blurb}</span>
      </button>`).join('');
    modesEl.querySelectorAll('[data-mode]').forEach((card) => {
      card.addEventListener('click', () => startGame(card.dataset.mode));
    });
  }

  function open() {
    init();
    if (root) root.hidden = false;
    showLobby();
  }
  function close() {
    if (root) root.hidden = true;
    aiPending = false;
  }
  function showLobby() {
    if (gameEl) gameEl.hidden = true;
    if (lobbyEl) lobbyEl.hidden = false;
    state = null; selected = null; targets = [];
  }

  function startGame(modeId) {
    const mode = Core.MODE_BY_ID[modeId];
    if (!mode) return;
    humanSides = vsAI ? new Set([myColor]) : new Set(['r', 'b']);
    aiColor = vsAI ? (myColor === 'r' ? 'b' : 'r') : null;
    state = Core.createGame(modeId, { seed: (Date.now() & 0x7fffffff) });
    history = [state];
    selected = null; targets = []; hoverCell = null; aiPending = false;

    lobbyEl.hidden = true;
    gameEl.hidden = false;
    titleEl.textContent = mode.name;
    render();
    updateStatus();
    maybeAIMove();
  }

  function resizeCanvas() {
    const wrap = canvas.parentElement;
    const rect = wrap.getBoundingClientRect();
    const cssW = Math.max(220, Math.floor(rect.width));
    const cssH = Math.max(220, Math.floor(rect.height));
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { cssW, cssH };
  }

  function render() {
    if (!state) return;
    const { cssW, cssH } = resizeCanvas();
    ctx.clearRect(0, 0, cssW, cssH);
    const L = Render.computeLayout(state, cssW, cssH, 16);
    currentLayout = L;
    Render.draw(ctx, state, L, { selected, targets, lastMove: state.lastMove, hover: hoverCell });
  }

  function onCanvasMove(e) {
    if (!currentLayout || aiPending) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    hoverCell = Render.cellAt(currentLayout, px, py);
    render();
  }

  function onCanvasClick(e) {
    if (!state || aiPending || state.status === 'over') return;
    if (!humanSides.has(state.turn)) return;
    const rect = canvas.getBoundingClientRect();
    const cell = Render.cellAt(currentLayout, e.clientX - rect.left, e.clientY - rect.top);
    if (!cell) return;
    const [x, y] = cell;

    if (selected) {
      const t = targets.find((t) => t.x === x && t.y === y);
      if (t) { doMove(t.action); return; }
    }
    const acts = Core.actionsAt(state, x, y, state.turn);
    if (acts.length) {
      const a = acts[0];
      if (a.flip) { doMove(a); return; }                 // 暗棋：翻棋
      if (a.to && !a.from) { doMove(a); return; }        // 五子棋 / 翻转棋：落子
      selected = [x, y];                                 // 走子类：选中己方棋子
      targets = acts.map((ac) => ({ x: ac.to[0], y: ac.to[1], action: ac }));
      render();
      return;
    }
    selected = null; targets = []; render();
  }

  function doMove(action) {
    history.push(state);
    state = Core.applyAction(state, action);
    selected = null; targets = [];
    render(); updateStatus();
    maybeAIMove();
  }

  function maybeAIMove() {
    if (!state || state.status !== 'playing') return;
    if (!humanSides.has(state.turn)) {
      aiPending = true;
      turnEl.textContent = '对手思考中…';
      setTimeout(aiStep, 340);
    }
  }
  function aiStep() {
    if (!state || state.status !== 'playing') { aiPending = false; return; }
    if (humanSides.has(state.turn)) { aiPending = false; return; }
    const a = Core.aiAction(state, state.turn);
    if (!a) { aiPending = false; return; }
    history.push(state);
    state = Core.applyAction(state, a);
    render(); updateStatus();
    if (state.status !== 'playing') { aiPending = false; return; }
    if (humanSides.has(state.turn)) { aiPending = false; return; }
    setTimeout(aiStep, 340);
  }

  function undo() {
    if (!history.length) return;
    state = history.pop();
    while (history.length && aiColor && state.turn === aiColor) state = history.pop();
    selected = null; targets = []; aiPending = false;
    render(); updateStatus();
  }

  function updateStatus() {
    if (!state) return;
    const sideLabel = state.turn === 'r' ? '红方' : '黑方';
    if (state.status === 'over') {
      turnEl.textContent = '对局结束';
      if (state.winner === 'draw') statusEl.textContent = '和局。';
      else {
        const w = state.winner === 'r' ? '红方' : '黑方';
        const who = humanSides.has(state.winner)
          ? (humanSides.size === 2 ? '胜' : '你胜')
          : (aiColor ? 'AI 胜' : '对方胜');
        statusEl.textContent = `${w}（${who}）获胜。`;
      }
      return;
    }
    const who = humanSides.has(state.turn)
      ? (humanSides.size === 2 ? '玩家' : '你')
      : (aiColor ? 'AI' : '对方');
    turnEl.textContent = `${sideLabel} · ${who}行棋`;
    turnEl.dataset.side = state.turn;
    if (state.passed) statusEl.textContent = `${sideLabel}无子可落，跳过一手。`;
    else if (state.mode === 'banqi') statusEl.textContent = '翻棋或行子；翻开的子归其本色，按品级吃子。';
    else if (state.mode === 'reversi') statusEl.textContent = '落子夹反，多者称雄；无子可落则跳过。';
    else if (state.mode === 'xiangqi') statusEl.textContent = '车马炮士象全，将帅不可照面。';
    else if (state.mode === 'checkers') statusEl.textContent = '斜行跳吃，到底成王。';
    else statusEl.textContent = '先连五子者胜。';
  }

  const api = { open, close, init, debugState: () => state, debugLayout: () => currentLayout };
  Object.defineProperty(globalThis, 'ShanhaiChessUI', {
    value: Object.freeze(api), writable: false, configurable: false, enumerable: true,
  });

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
}());
