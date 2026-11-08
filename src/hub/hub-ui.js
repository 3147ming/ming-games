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

  bridge.on('GAME_READY', function (d) {
    window.__HUB_LAST_READY__ = d.payload;
    if (loading) loading.hidden = true;
    clearTimeout(loadTimer);
    say((byId[currentId] ? byId[currentId].name : '游戏') + ' 已就绪');
  });
  bridge.on('GAME_REQUEST_HOME', function () { globalThis.HubRouter.home(); });
  bridge.on('GAME_ERROR', function (d) {
    console.error('[game error]', d.payload);
    say('游戏报错：' + (d.payload && d.payload.message ? d.payload.message : '未知错误'), true);
  });
  bridge.on('GAME_PROGRESS', function (d) {
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
    if (loading) loading.hidden = true;
    document.title = '游戏大厅 · GAME HUB';
    document.body.classList.remove('in-game');
  }

  function showGame(state) {
    var g = byId[state.gameId];
    if (!g || g.status !== 'ready') { globalThis.HubRouter.home(); return; }
    if (currentId === g.id) return;
    if (currentId) bridge.dispose();

    if (grid) grid.hidden = true;
    if (back) back.hidden = false;
    if (stage) { stage.hidden = false; stage.innerHTML = ''; }
    if (loading) loading.hidden = false;
    document.body.classList.add('in-game');
    document.title = g.name + ' · 游戏大厅';

    window.__HUB_LAST_READY__ = null;
    window.__HUB_IFRAME_LOADED__ = false;
    var sessionId = globalThis.HubBridge.newSessionId();
    var iframe = document.createElement('iframe');
    iframe.className = 'game-frame';
    iframe.title = g.name;
    iframe.setAttribute('allow', 'autoplay; fullscreen; gamepad; pointer-lock');
    /* file:// 下 iframe 是 opaque origin，postMessage 可能被浏览器拦；
       load 事件作为兜底，保证玩家不会卡在加载遮罩上 */
    iframe.addEventListener('load', function () {
      window.__HUB_IFRAME_LOADED__ = true;
      if (loading && !loading.hidden && !window.__HUB_LAST_READY__) {
        loading.hidden = true;
        say('已加载（离线形态，桥未连接）');
      }
    });
    var sep = g.playUrl.indexOf('?') >= 0 ? '&' : '?';
    iframe.src = g.playUrl + sep + '__hub_session=' + encodeURIComponent(sessionId);
    if (stage) stage.appendChild(iframe);
    currentId = g.id;
    bridge.attach(iframe, g.id, sessionId, { params: state.params, saveSnapshot: {} });

    loadTimer = setTimeout(function () {
      if (loading && !loading.hidden) {
        loading.hidden = true;
        say('加载较慢，若画面空白可点「返回大厅」重试', true);
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
