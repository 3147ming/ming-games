/* =============================================================
   wild · Service Worker
   -------------------------------------------------------------
   目标：首次联网打开后，断网也能直接从浏览器 / 主屏图标打开使用。

   策略
   - install ：预缓存应用外壳（页面 / manifest / 图标），skipWaiting
   - activate：删除旧版本缓存，clients.claim 立即接管
   - fetch   ：仅处理同源 GET
       · 页面导航   → 网络优先（联网时总是拿最新页面；断网才回退缓存）
       · 静态资源   → stale-while-revalidate（缓存优先，后台静默更新）
       · sw.js 自身 → 永不缓存（保证 SW 更新能被浏览器检测到）
       · 外部请求   → 完全不拦（直连网络）

   升级
   - VERSION 手工维护：wild-v1 → v2 → …；产物一变缓存名就变，
     旧缓存会在 activate 里被清掉。
   ============================================================= */

var VERSION = 'wild-v1';
var CACHE = VERSION;
var BASE = self.registration ? self.registration.scope : self.location.href.replace(/sw\.js.*$/, '');

/* 应用外壳：必须缓存成功（离线兜底的底线） */
var CORE = ['./', './index.html', './manifest.json', './icons/icon-192.png', './icons/icon-512.png'];

function abs(p) {
  try { return new URL(p, BASE).href; } catch (e) { return p; }
}

/* ---------------- install ---------------- */
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(CORE.map(abs));
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

/* ---------------- activate ---------------- */
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) {
        return k !== CACHE;
      }).map(function (k) {
        return caches.delete(k);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

/* ---------------- fetch ---------------- */
self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  /* sw.js 永不缓存：保证浏览器每次都能检测到 SW 更新 */
  if (url.pathname.endsWith('/sw.js')) return;

  /* 页面导航：网络优先，断网才回退缓存（保证用户总能拿到最新页面） */
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(function (resp) {
        if (resp && resp.status === 200) {
          var clone = resp.clone();
          caches.open(CACHE).then(function (cache) { cache.put(req, clone); });
        }
        return resp;
      }).catch(function () {
        return caches.match(req).then(function (cached) {
          return cached || caches.match(abs('./index.html'));
        });
      })
    );
    return;
  }

  /* 静态资源：stale-while-revalidate */
  event.respondWith(
    caches.match(req).then(function (cached) {
      var network = fetch(req).then(function (resp) {
        if (resp && resp.status === 200 && resp.type === 'basic') {
          var clone = resp.clone();
          caches.open(CACHE).then(function (cache) { cache.put(req, clone); });
        }
        return resp;
      }).catch(function () {
        return cached;
      });
      return cached || network;
    })
  );
});
