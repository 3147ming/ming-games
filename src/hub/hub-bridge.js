/* hub-bridge.js — 大厅(父) 与 游戏 iframe(子) 的唯一通信协议
 *
 * 同一份文件被构建器内联进父页面与每个游戏页面；父调用 createParent，子调用 createChild。
 * 信封: { __hub:1, v:1, sessionId, gameId, type, payload }
 *
 * file:// 下 iframe 是 opaque origin，targetOrigin 只能用 '*'，因此额外做三重校验：
 *   event.source === iframe.contentWindow / sessionId 一致 / type 在白名单内。
 */
(function () {
  'use strict';
  var V = 1;
  var TYPES = [
    'HUB_HELLO', 'GAME_READY', 'SAVE_GET', 'SAVE_GET_RESULT', 'SAVE_SET', 'SAVE_SET_ACK',
    'SAVE_MERGE', 'GAME_PROGRESS', 'GAME_REQUEST_HOME', 'HUB_GO_HOME', 'GAME_DISPOSE',
    'SANDBOX_APPLY', 'GAME_ERROR', 'GAME_HEARTBEAT'
  ];

  function envelope(gameId, sessionId, type, payload) {
    return { __hub: 1, v: V, sessionId: sessionId, gameId: gameId, type: type, payload: payload || {} };
  }
  function isEnvelope(d) {
    return !!(d && d.__hub === 1 && d.v === V && TYPES.indexOf(d.type) >= 0);
  }
  function newSessionId() {
    var a = new Uint8Array(8);
    try { (globalThis.crypto || window.crypto).getRandomValues(a); }
    catch (e) { for (var i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256); }
    return Array.from(a, function (x) { return x.toString(16).padStart(2, '0'); }).join('');
  }
  function post(win, msg) {
    try { win.postMessage(msg, '*'); } catch (e) { /* 跨 origin 受限时静默，游戏本身照常可玩 */ }
  }

  /* ---------------- 父侧 ---------------- */
  function createParent(opts) {
    opts = opts || {};
    var handlers = Object.create(null);
    var current = null;
    var api = {};

    function emit(type, data) {
      var list = handlers[type] || [];
      for (var i = 0; i < list.length; i++) {
        try { list[i](data); } catch (e) { if (opts.onError) opts.onError(e); }
      }
    }
    api.on = function (type, fn) { (handlers[type] || (handlers[type] = [])).push(fn); return api; };
    api.send = function (type, payload) {
      if (!current || !current.iframe.contentWindow) return;
      post(current.iframe.contentWindow, envelope(current.gameId, current.sessionId, type, payload));
    };
    api.current = function () { return current; };

    api.attach = function (iframe, gameId, sessionId, hello) {
      sessionId = sessionId || newSessionId();
      current = { iframe: iframe, gameId: gameId, sessionId: sessionId, hello: hello || {} };
      var sendHello = function () {
        api.send('HUB_HELLO', {
          params: current.hello.params || {},
          tuning: current.hello.tuning || {},
          openall: current.hello.openall || {},
          saveSnapshot: current.hello.saveSnapshot || {},
          mode: current.hello.mode || null,
          seed: current.hello.seed || null
        });
      };
      iframe.addEventListener('load', sendHello);
      current.sendHello = sendHello;
      return sessionId;
    };

    api.dispose = function () {
      if (!current) return;
      api.send('GAME_DISPOSE', { reason: 'switch' });
      var f = current.iframe;
      current = null;
      try { f.remove(); } catch (e) { /* noop */ }
    };

    function onMessage(ev) {
      var d = ev.data;
      if (!isEnvelope(d)) return;
      if (!current) return;
      if (ev.source !== current.iframe.contentWindow) return;
      if (d.sessionId !== current.sessionId) return;
      if (d.type === 'GAME_READY' && current.sendHello) current.sendHello();
      emit(d.type, d);
    }
    if (typeof window !== 'undefined') window.addEventListener('message', onMessage);
    return api;
  }

  /* ---------------- 子侧 ---------------- */
  function createChild(opts) {
    opts = opts || {};
    var gameId = opts.gameId || '';
    var sessionId = opts.sessionId || '';
    var disabled = { enabled: false, send: function () {}, ready: function () {}, progress: function () {}, error: function () {} };
    if (typeof window === 'undefined') return disabled;

    if (!sessionId) {
      try { sessionId = new URLSearchParams(location.search).get('__hub_session') || ''; } catch (e) { /* noop */ }
    }
    if (!sessionId) return disabled; // 直接双击游戏 HTML 时不通信，游戏照常可玩

    function send(type, payload) {
      if (typeof parent === 'undefined' || parent === window) return;
      post(parent, envelope(gameId, sessionId, type, payload));
    }
    function ready(caps) {
      /* dom 摘要用于无头探针在父页面验证 iframe 确实渲染了游戏（file:// 下父无法直接读子 DOM） */
      var dom = { title: '', app: false, bodyText: '' };
      try {
        dom.title = document.title;
        dom.app = !!document.getElementById('app');
        dom.bodyText = String(document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 160);
      } catch (e) { /* noop */ }
      send('GAME_PROGRESS', { phase: 'ready', value: 1 });
      send('GAME_READY', { caps: caps || [], version: V, href: String(location.href), t: Date.now(), dom: dom });
    }
    function progress(p) { send('GAME_PROGRESS', p || {}); }
    /* 自动上报加载阶段，驱动大厅进度条：bridge 初始化(0.12) → DOM 就绪(0.4) → ready(1)。
       游戏业务代码也可随时调用 HubBridge.progress({ value: x }) 上报更细的进度。 */
    progress({ phase: 'boot', value: 0.12 });
    function onDom() { progress({ phase: 'dom', value: 0.4 }); }
    if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', onDom);
    else onDom();
    function error(e) {
      send('GAME_ERROR', {
        message: e && e.message ? String(e.message) : String(e),
        stack: e && e.stack ? String(e.stack).slice(0, 2000) : '',
        phase: 'runtime'
      });
    }

    window.addEventListener('error', function (e) { error(e.error || e.message); });
    window.addEventListener('unhandledrejection', function (e) { error(e.reason); });
    window.addEventListener('message', function (ev) {
      var d = ev.data;
      if (!isEnvelope(d) || d.sessionId !== sessionId) return;
      if (d.type === 'SANDBOX_APPLY') {
        globalThis.__TUNING__ = Object.assign(globalThis.__TUNING__ || {}, d.payload.tuning || {});
        globalThis.__OPENALL__ = Object.assign(globalThis.__OPENALL__ || {}, d.payload.openall || {});
      }
      if (d.type === 'HUB_GO_HOME') {
        try { parent.postMessage(envelope(gameId, sessionId, 'GAME_REQUEST_HOME', {}), '*'); } catch (e) { /* noop */ }
      }
    });
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') send('GAME_REQUEST_HOME', { source: 'esc' });
    });
    if (document.readyState === 'complete') ready(opts.caps);
    else window.addEventListener('load', function () { ready(opts.caps); });

    return { enabled: true, send: send, ready: ready, progress: progress, error: error, sessionId: sessionId };
  }

  globalThis.HubBridge = { V: V, TYPES: TYPES, createParent: createParent, createChild: createChild, newSessionId: newSessionId };
})();
