import { store } from './store.js';
import { initUI, showResult, showMenu, toast, closeOverlay, ICONS } from './ui.js';
import { games } from '../games/index.js';

let app = null;
let destroyFns = [];
let curId = null;
let curLevel = 1;

export function boot(root) {
  app = root;
  store.migrate(); // 迁移旧 BRAIN-GYM 部署站数据
  initUI(app);
  renderLobby();
}

function clearApp() {
  destroyFns.forEach(fn => { try { fn(); } catch (e) {} });
  destroyFns = [];
  closeOverlay();
  app.innerHTML = '';
}

function renderLobby() {
  clearApp();
  const el = document.createElement('div');
  el.className = 'lobby';
  el.innerHTML = `
    <header class="topbar lobby-top">
      <div class="brand"><span class="brand-glow">未来之光</span><small>脑力合集</small></div>
      <div class="wallet">
        <span class="chip gold">🪙 ${store.coins}</span>
        <span class="chip star">${ICONS.star} ${store.stars}</span>
      </div>
    </header>
    <div class="lobby-sub">选择一款游戏开始挑战</div>
    <div class="lobby-grid">
      ${games.map(g => {
        const lv = store.getUnlocked(g.id);
        const lvTxt = lv > 1 ? `已解锁 第 ${lv} 关` : '点击开始';
        return `<button class="game-card" data-id="${g.id}">
          <div class="gc-icon">${g.icon}</div>
          <div class="gc-name">${g.name}</div>
          <div class="gc-tag">${g.tag}</div>
          <div class="gc-desc">${g.desc}</div>
          <div class="gc-foot"><span class="gc-lv">${lvTxt}</span><span class="gc-go">进入 ›</span></div>
        </button>`;
      }).join('')}
    </div>
    <button class="rec-btn" id="g-records">${ICONS.flag} 战绩总览</button>`;
  app.appendChild(el);
  el.querySelectorAll('.game-card').forEach(c => {
    c.onclick = () => startGame(c.dataset.id, store.getUnlocked(c.dataset.id));
  });
  el.querySelector('#g-records').onclick = showRecords;
}

function showRecords() {
  clearApp();
  const el = document.createElement('div');
  el.className = 'rec-page';
  el.innerHTML = `
    <header class="topbar"><button class="icon-btn" id="r-back">‹ 大厅</button>
      <div class="game-title">${ICONS.flag} 战绩总览</div><span class="wallet"><span class="chip gold">🪙 ${store.coins}</span></span></header>
    <div class="rec-list">
      ${games.map(g => {
        const id = g.id;
        const rows = [];
        for (let lv = 1; lv <= g.maxLevel; lv++) {
          const best = store.getBest(id, lv);
          const hist = store.isHistorical(id, lv);
          const plays = store.getPlays(id, lv);
          if (!best && !plays && !hist) continue;
          rows.push(`<div class="rec-row">
            <span class="rec-lv">${g.name} · 第${lv}关</span>
            <span class="rec-best">${hist ? `历史 ${hist}` : (best ? `最高 ${best}` : '—')}</span>
            <span class="rec-plays">游玩 ${plays} 次</span>
          </div>`);
        }
        return rows.length ? `<div class="rec-game">${rows.join('')}</div>` : '';
      }).join('')}
      ${games.every(g => store.getPlays(g.id, 1) === 0 && !store.getBest(g.id, 1) && !store.isHistorical(g.id, 1)) ? '<p class="modal-sub">还没有战绩，去玩一局吧！</p>' : ''}
    </div>`;
  app.appendChild(el);
  el.querySelector('#r-back').onclick = renderLobby;
}

function startGame(id, level) {
  const mod = games.find(g => g.id === id);
  if (!mod) return;
  curId = id; curLevel = level;
  clearApp();

  const wrap = document.createElement('div');
  wrap.className = 'game-shell';
  wrap.innerHTML = `
    <header class="topbar game-top">
      <button class="icon-btn" id="g-menu">☰</button>
      <div class="game-title">${mod.icon} ${mod.name}</div>
      <div class="top-right">
        <span class="clock" id="g-clock"></span>
        <button class="icon-btn" id="g-restart" title="重新开始">↻</button>
      </div>
    </header>
    <div class="hud" id="g-hud"></div>
    <div class="stage" id="g-stage"></div>`;
  app.appendChild(wrap);

  const stage = wrap.querySelector('#g-stage');
  const hud = wrap.querySelector('#g-hud');
  const clockEl = wrap.querySelector('#g-clock');
  wrap.querySelector('#g-menu').onclick = () =>
    showMenu({ onResume() {}, onRestart() { startGame(id, curLevel); }, onHome() { renderLobby(); } });
  wrap.querySelector('#g-restart').onclick = () => startGame(id, curLevel);

  let ended = false;
  const api = {
    level,
    cfg: mod.config(level),
    setHud(html) { hud.innerHTML = html; },
    setClock(sec) {
      if (sec == null) { clockEl.textContent = ''; clockEl.classList.remove('warn'); return; }
      const s = Math.max(0, Math.ceil(sec));
      clockEl.textContent = '⏱ ' + s + 's';
      clockEl.classList.toggle('warn', s <= 5);
    },
    toast,
    store,
    onDestroy(fn) { destroyFns.push(fn); },
    win(stars = 1, score = 0) {
      if (ended) return; ended = true;
      gameWin(id, level, stars, score);
    },
    lose() {
      if (ended) return; ended = true;
      gameLose(id, level);
    },
    restart() { startGame(id, curLevel); }
  };
  mod.mount(stage, api);
}

function gameWin(id, level, stars, score) {
  store.addPlay(id, level);
  const prevBest = store.getBest(id, level);
  const isRecord = score > prevBest;
  const coins = store.coinsFor(score);
  const firstClear = !store.isCleared(id, level);
  store.addCoins(coins);
  if (firstClear) {
    store.addStars(stars);
    store.clear(id, level);
    store.setUnlocked(id, level + 1);
  }
  store.setBest(id, level, score);
  const mod = games.find(g => g.id === id);
  const hasNext = level < mod.maxLevel;
  showResult({
    type: 'win', stars, score, best: Math.max(prevBest, score), isRecord, coins, hasNext,
    onRetry() { startGame(id, level); },
    onNext() { startGame(id, level + 1); },
    onHome() { renderLobby(); }
  });
}

function gameLose(id, level) {
  store.addPlay(id, level);
  showResult({
    type: 'lose', stars: 1,
    onRetry() { startGame(id, level); },
    onHome() { renderLobby(); }
  });
}
