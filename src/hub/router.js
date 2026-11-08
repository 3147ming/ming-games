/* router.js — hash 路由
 * 为什么用 hash 而不是 pushState：file:// 下 pushState 会抛 SecurityError，
 * pages.dev 无 SPA fallback，只有 hash 在「离线 / 本地服务 / 线上」三形态零服务端依赖可用。
 */
(function () {
  'use strict';
  function parse() {
    var h = (typeof location !== 'undefined' && location.hash) ? location.hash : '#/';
    var raw = h.charAt(0) === '#' ? h.slice(1) : h;
    if (!raw || raw === '/' || raw === '') return { view: 'home', gameId: null, params: {} };
    var qi = raw.indexOf('?');
    var pathname = qi < 0 ? raw : raw.slice(0, qi);
    var query = qi < 0 ? '' : raw.slice(qi + 1);
    var m = pathname.match(/^\/game\/([A-Za-z0-9_-]+)\/?$/);
    if (!m) return { view: 'home', gameId: null, params: {} };
    var params = {};
    query.split('&').forEach(function (kv) {
      if (!kv) return;
      var p = kv.split('=');
      try { params[decodeURIComponent(p[0])] = decodeURIComponent(p.slice(1).join('=') || ''); }
      catch (e) { /* 忽略坏参数 */ }
    });
    return { view: 'game', gameId: m[1], params: params };
  }
  function href(gameId, params) {
    var q = '';
    if (params) {
      var parts = Object.keys(params).filter(function (k) { return params[k] !== undefined && params[k] !== null && params[k] !== ''; })
        .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(String(params[k])); });
      if (parts.length) q = '?' + parts.join('&');
    }
    return '#/game/' + encodeURIComponent(gameId) + q;
  }
  function home() { if (typeof location !== 'undefined') location.hash = '#/'; }
  function go(gameId, params) { if (typeof location !== 'undefined') location.hash = href(gameId, params); }
  function onChange(fn) {
    if (typeof window === 'undefined') return;
    var fire = function () { try { fn(parse()); } catch (e) { console.error('[router]', e); } };
    window.addEventListener('hashchange', fire);
    window.addEventListener('popstate', fire);
    fire();
  }
  globalThis.HubRouter = { parse: parse, href: href, home: home, go: go, onChange: onChange };
})();
