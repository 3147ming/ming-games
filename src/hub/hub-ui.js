/* hub-ui.js — 大厅渲染与 iframe 生命周期
 * P0：卡片网格 + 同页 iframe 切换 + 返回大厅 + 前进后退 + 加载/错误反馈。
 * P3 会在此扩展元系统 UI、沙盒面板、Q 版角色；P4 换 Q 版成品素材。
 */
(function () {
  'use strict';
  var games = globalThis.__HUB_GAMES__ || [];
  var meta = globalThis.__HUB_META__ || {};
  var byId = Object.create(null);
  games.forEach(function (g) { byId[g.id] = g; });

  var grid = document.getElementById('hub-grid');
  var stage = document.getElementById('hub-stage');
  var back = document.getElementById('hub-back');
  var loading = document.getElementById('hub-loading');
  var bar = document.getElementById('hub-progress');
  var pctEl = document.getElementById('hub-loading-pct');
  var nameEl = document.getElementById('hub-loading-name');
  var sub = document.getElementById('hubSub');
  var foot = document.getElementById('hubFoot');
  var notice = document.getElementById('hub-notice');

  if (sub) sub.textContent = meta.subtitle || '';
  if (foot) foot.textContent = meta.footnote || '';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function say(msg, isError) {
    if (!notice) return;
    notice.textContent = msg || '';
    notice.className = 'hub-notice' + (msg ? ' show' : '') + (isError ? ' err' : '');
    if (msg) {
      clearTimeout(say._t);
      say._t = setTimeout(function () { notice.className = 'hub-notice'; }, 6000);
    }
  }

  /* ---- 加载进度条子系统 ----
   * 进度来源有两路：① 子页面经 GAME_PROGRESS 上报的阶段值（boot→dom→ready）；
   * ② 本地平滑动画，9s 内缓坡爬到 0.9，避免没有真实上报时进度条卡死。
   * 收到 GAME_READY 或（离线 opaque origin）iframe load 时置 1 并淡出。 */
  var progRAF = null, progStart = 0, progCur = 0, progTarget = 0;
  function progFrame(now) {
    if (!progStart) progStart = now;
    var elapsed = now - progStart;
    var auto = Math.min(0.9, 0.06 + (elapsed / 9000) * 0.84);
    var target = Math.max(progTarget, auto);
    progCur += (target - progCur) * 0.14;
    if (progCur > 0.999) progCur = 1;
    if (bar) bar.style.width = (progCur * 100).toFixed(1) + '%';
    if (pctEl) pctEl.textContent = Math.floor(progCur * 100) + '%';
    if (progCur >= 1 && target >= 1) { progRAF = null; return; }
    progRAF = requestAnimationFrame(progFrame);
  }
  function progStartRun(name) {
    progStart = 0; progCur = 0; progTarget = 0.06;
    if (nameEl) nameEl.textContent = name || '';
    if (bar) bar.style.width = '0%';
    if (pctEl) pctEl.textContent = '0%';
    if (loading) loading.hidden = false;
    if (!progRAF) progRAF = requestAnimationFrame(progFrame);
  }
  function progSet(v) { if (typeof v === 'number' && isFinite(v)) progTarget = Math.max(progTarget, Math.min(1, v)); }
  function progFinish() {
    progTarget = 1;
    if (!progRAF) progRAF = requestAnimationFrame(progFrame);
    setTimeout(function () { if (loading) loading.hidden = true; }, 360);
  }
  function progStop() {
    if (progRAF) { cancelAnimationFrame(progRAF); progRAF = null; }
    if (loading) loading.hidden = true;
  }

  function renderGrid() {
    if (!grid) return;
    grid.innerHTML = '';
    games.forEach(function (g) {
      var ready = g.status === 'ready';
      var el = document.createElement(ready ? 'a' : 'div');
      el.className = 'card' + (ready ? '' : ' card-pending');
      el.setAttribute('data-id', g.id);
      if (ready) el.href = globalThis.HubRouter.href(g.id);
      el.innerHTML =
        '<div class="card-cover">' +
          '<img src="' + esc(g.cover) + '" alt="' + esc(g.name) + ' 封面" loading="lazy" decoding="async">' +
          (ready ? '' : '<span class="card-badge">接入中</span>') +
        '</div>' +
        '<div class="card-body">' +
          '<span class="card-name">' + esc(g.name) + '</span>' +
          (g.tag ? '<span class="card-tag">' + esc(g.tag) + '</span>' : '') +
          '<span class="card-enter">' + (ready ? '进入游戏 ▶' : 'P2 构建链接入') + '</span>' +
        '</div>';
      var img = el.querySelector('img');
      if (img) img.addEventListener('error', function () { img.style.display = 'none'; });
      grid.appendChild(el);
    });
  }

  var bridge = globalThis.HubBridge.createParent({
    onError: function (e) { console.error('[hub-bridge]', e); }
  });
  var currentId = null;
  var loadTimer = null;
  var bridgeConnected = false;

  bridge.on('GAME_READY', function (d) {
    window.__HUB_LAST_READY__ = d.payload;
    bridgeConnected = true;
    progFinish();
    clearTimeout(loadTimer);
    say((byId[currentId] ? byId[currentId].name : '游戏') + ' 已就绪');
  });
  bridge.on('GAME_REQUEST_HOME', function () { globalThis.HubRouter.home(); });
  bridge.on('GAME_ERROR', function (d) {
    console.error('[game error]', d.payload);
    say('游戏报错：' + (d.payload && d.payload.message ? d.payload.message : '未知错误'), true);
  });
  bridge.on('GAME_PROGRESS', function (d) {
    bridgeConnected = true;
    var p = d.payload || {};
    var v = (typeof p.value === 'number') ? p.value : (typeof p.progress === 'number' ? p.progress : null);
    if (v !== null) progSet(v);
    try {
      localStorage.setItem('hub:last-progress', JSON.stringify({
        gameId: d.gameId, t: Date.now(), payload: d.payload
      }));
    } catch (e) { /* file:// 下 localStorage 可能不可用，忽略 */ }
  });
  bridge.on('SAVE_GET', function (d) {
    var value = null;
    try { value = localStorage.getItem('hub:game:' + d.gameId + ':' + d.payload.key); } catch (e) { /* noop */ }
    bridge.send('SAVE_GET_RESULT', { key: d.payload.key, value: value });
  });
  bridge.on('SAVE_SET', function (d) {
    try { localStorage.setItem('hub:game:' + d.gameId + ':' + d.payload.key, String(d.payload.value)); } catch (e) { /* noop */ }
    bridge.send('SAVE_SET_ACK', { key: d.payload.key });
  });

  function showHome() {
    clearTimeout(loadTimer);
    if (currentId) { bridge.dispose(); currentId = null; }
    if (stage) { stage.hidden = true; stage.innerHTML = ''; }
    if (grid) grid.hidden = false;
    if (back) back.hidden = true;
    progStop();
    document.title = '游戏大厅 · GAME HUB';
    document.body.classList.remove('in-game');
  }

  function showGame(state) {
    var g = byId[state.gameId];
    if (!g || g.status !== 'ready') { globalThis.HubRouter.home(); return; }
    if (currentId === g.id) return;
    if (currentId) bridge.dispose();
    clearTimeout(loadTimer);
    bridgeConnected = false;

    if (grid) grid.hidden = true;
    if (back) back.hidden = false;
    if (stage) { stage.hidden = false; stage.innerHTML = ''; }
    progStartRun(g.name);
    document.body.classList.add('in-game');
    document.title = g.name + ' · 游戏大厅';

    window.__HUB_LAST_READY__ = null;
    window.__HUB_IFRAME_LOADED__ = false;
    var sessionId = globalThis.HubBridge.newSessionId();
    var iframe = document.createElement('iframe');
    iframe.className = 'game-frame';
    iframe.title = g.name;
    iframe.setAttribute('allow', 'autoplay; fullscreen; gamepad; pointer-lock');
    /* 子页面会在 bridge 初始化时上报 GAME_PROGRESS(boot)。若 9s 内收到过任何桥消息，
       说明通道正常，等 GAME_READY 收尾；否则是 file:// 的 opaque origin，postMessage 被拦，
       此时以 iframe load 作为兜底直接拉满进度并提示离线形态。 */
    iframe.addEventListener('load', function () {
      window.__HUB_IFRAME_LOADED__ = true;
      if (bridgeConnected) { progSet(0.8); return; }
      progFinish();
      say('已加载（离线形态，桥未连接）');
    });
    var sep = g.playUrl.indexOf('?') >= 0 ? '&' : '?';
    iframe.src = g.playUrl + sep + '__hub_session=' + encodeURIComponent(sessionId);
    if (stage) stage.appendChild(iframe);
    currentId = g.id;
    bridge.attach(iframe, g.id, sessionId, { params: state.params, saveSnapshot: {} });

    loadTimer = setTimeout(function () {
      if (loading && !loading.hidden && !window.__HUB_LAST_READY__) {
        progSet(0.95);
        say('加载较慢，正在继续…若长时间空白可按 Esc 返回', true);
        loadTimer = setTimeout(function () {
          if (loading && !loading.hidden && !window.__HUB_LAST_READY__) {
            progFinish();
            say('加载超时，若画面空白可点「返回大厅」重试', true);
          }
        }, 9000);
      }
    }, 9000);
  }

  if (back) back.addEventListener('click', function () { globalThis.HubRouter.home(); });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && currentId) globalThis.HubRouter.home();
  });

  renderGrid();
  globalThis.HubRouter.onChange(function (state) {
    if (state.view === 'game') showGame(state);
    else showHome();
  });
})();
