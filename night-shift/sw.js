/* =============================================================
   night-shift · Service Worker
   -------------------------------------------------------------
   目标：首次联网打开后，断网也能从浏览器 / 主屏图标打开使用。

   策略（network-first + 缓存兜底）
   - install ：预缓存应用外壳（页面 / manifest / 图标），skipWaiting
   - activate：删除别的版本缓存，clients.claim 立即接管
   - fetch   ：仅处理同源 GET
       · 一律先走网络，成功就顺手更新缓存
       · 网络失败（断网）才回退缓存；导航失败再兜底到 index.html
       · sw.js 自身完全不拦（否则浏览器永远检测不到 SW 更新）

   为什么不用 stale-while-revalidate
   - SWR 会让"发布后第一次打开"仍显示旧样式/旧脚本，第二次才新。本项目没有
     构建产物指纹（ADR-001 无构建），没有可靠的版本号可用来失效缓存。
   - 之前靠手工维护 VERSION 常量：改了源码忘了升版本，旧缓存就永远不清 ——
     这种"要记得做"的纪律最终一定会破。
   - network-first 让"发布即生效"成为结构性保证，离线兜底能力一点没少。

   VERSION 只用于缓存命名：想强制所有客户端清空旧缓存时改它。
   ============================================================= */

var VERSION = 'night-shift-v2';
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

  /* sw.js 自身永不拦截：保证浏览器每次都能检测到 SW 更新 */
  if (url.pathname.endsWith('/sw.js')) return;

  event.respondWith(
    fetch(req).then(function (resp) {
      /* 只缓存干净的 200：206 是分段响应，304 没有实体，都不能塞进 Cache */
      if (resp && resp.status === 200 && resp.type === 'basic') {
        var clone = resp.clone();
        caches.open(CACHE).then(function (cache) { cache.put(req, clone); });
      }
      return resp;
    }).catch(function () {
      return caches.match(req).then(function (cached) {
        if (cached) return cached;
        /* 只有导航请求才有"回退到首页"的语义；图片/脚本 404 就该是 404 */
        if (req.mode === 'navigate') return caches.match(abs('./index.html'));
        return Response.error();
      });
    })
  );
});
