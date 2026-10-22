/* =============================================================
   知识问答 · Service Worker
   -------------------------------------------------------------
   目标：首次联网打开后，断网也能直接从浏览器 / 主屏图标打开使用。

   策略
   - install ：预缓存应用外壳（页面、manifest、图标、可用音频），skipWaiting
   - activate：删除旧版本缓存，clients.claim 立即接管
   - fetch   ：仅处理同源 GET
       · 页面导航   → 缓存优先（命中即回，同时后台静默更新）
       · 静态资源   → 缓存优先（index.html / manifest / icons / audio）
       · 外部 API   → 完全不拦（opentdb、百度、AI 端点直连网络）
   升级
   - 发布新版本时把 VERSION 加一（quiz-v1 → quiz-v2），旧缓存会在 activate 里被清掉。
   ============================================================= */

var VERSION = 'quiz-v1';
var CACHE = VERSION;
var BASE = self.registration ? self.registration.scope : self.location.href.replace(/sw\.js.*$/, '');

/* 应用外壳：必须缓存成功 */
var CORE = ['./', './index.html', './manifest.json', './icons/icon-192.png', './icons/icon-512.png'];

/* 音频是可选资源：存在才缓存，且体积超限就跳过（避免几十 MB 的曲库把安装卡死） */
var AUDIO_GUESS = ['./audio/flower-dance.mp3', './audio/summer.mp3', './audio/luv-letter.mp3', './audio/canon.mp3'];
var AUDIO_MAX_BYTES = 6 * 1024 * 1024;
var AUDIO_RE = /\.(mp3|m4a|aac|ogg|oga|wav|flac|opus)$/i;

function abs(p) {
  try { return new URL(p, BASE).href; } catch (e) { return p; }
}

/* ---------------- install ---------------- */
self.addEventListener('install', function (event) {
  event.waitUntil((async function () {
    var cache = await caches.open(CACHE);
    var mandatory = [abs('./'), abs('./index.html')];
    var rest = CORE.slice(2).map(abs);

    // 逐个抓取：任何一个失败都不该让整次安装崩掉
    async function grab(u) {
      try {
        var res = await fetch(new Request(u, { cache: 'reload' }));
        if (res && res.ok) await cache.put(u, res.clone());
        return res && res.ok;
      } catch (e) { return false; }
    }

    var shellOK = false;
    for (var i = 0; i < mandatory.length; i++) {
      if (await grab(mandatory[i])) shellOK = true;
    }
    for (var j = 0; j < rest.length; j++) await grab(rest[j]);

    // 可选音频：先 HEAD 探体积，超限就完全不下载（避免把几十 MB 的曲库拖进安装流程）
    for (var k = 0; k < AUDIO_GUESS.length; k++) {
      try {
        var u = abs(AUDIO_GUESS[k]);
        var head = await fetch(new Request(u, { method: 'HEAD', cache: 'no-store' }));
        if (!head || !head.ok) continue;
        var len = parseInt(head.headers.get('content-length') || '0', 10);
        if (!len || len > AUDIO_MAX_BYTES) continue;
        var r = await fetch(new Request(u, { cache: 'reload' }));
        if (!r || !r.ok) continue;
        await cache.put(u, r.clone());
      } catch (e) { /* 占位文件缺失 = 正常情况，忽略 */ }
    }

    if (!shellOK) throw new Error('quiz sw: precache shell failed');
    await self.skipWaiting();
  })());
});

/* ---------------- activate ---------------- */
self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    var keys = await caches.keys();
    await Promise.all(keys.map(function (k) {
      // 只清理本应用命名空间下的旧版本，别动同域其它应用（ming-games 大厅等）的缓存
      if (k !== CACHE && k.indexOf('quiz-') === 0) return caches.delete(k);
      return null;
    }));
    await self.clients.claim();
  })());
});

/* ---------------- 工具 ---------------- */
async function cacheFirst(request) {
  var cache = await caches.open(CACHE);
  var hit = await cache.match(request, { ignoreSearch: false });
  if (hit) return hit;
  try {
    var res = await fetch(request);
    if (res && res.ok && res.type === 'basic') cache.put(request, res.clone()).catch(function () {});
    return res;
  } catch (e) {
    // 断网且没缓存：页面导航退回外壳，其余如实失败
    if (request.mode === 'navigate') {
      var shell = (await cache.match(abs('./index.html'))) || (await cache.match(abs('./')));
      if (shell) return shell;
    }
    throw e;
  }
}

async function navFirst(request) {
  var cache = await caches.open(CACHE);
  var hit = (await cache.match(request)) ||
            (await cache.match(abs('./index.html'))) ||
            (await cache.match(abs('./')));
  if (hit) {
    // 命中即回（离线必须秒开）；同时后台静默拉新，下次打开就是最新版
    fetch(request).then(function (res) {
      if (res && res.ok && res.type === 'basic') cache.put(request, res.clone()).catch(function () {});
    }).catch(function () {});
    return hit;
  }
  try {
    var res = await fetch(request);
    if (res && res.ok && res.type === 'basic') cache.put(request, res.clone()).catch(function () {});
    return res;
  } catch (e) {
    var shell = await cache.match(abs('./index.html'));
    if (shell) return shell;
    throw e;
  }
}

async function audioFirst(request) {
  var cache = await caches.open(CACHE);
  var hit = await cache.match(request);
  if (hit) return hit;
  var res = await fetch(request);
  try {
    var len = parseInt(res.headers.get('content-length') || '0', 10);
    if (res.ok && res.type === 'basic' && len <= AUDIO_MAX_BYTES) {
      await cache.put(request, res.clone());
    }
  } catch (e) { /* 不缓存也不影响播放 */ }
  return res;
}

/* ---------------- fetch ---------------- */
self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (e) { return; }

  // 外部 API（opentdb / allorigins / 百度 / AI 端点）：不缓存、不拦截，直接走网络
  if (url.origin !== self.location.origin) return;
  // 只接管本应用目录（/quiz/），同域大厅等其它页面不碰
  if (url.href.indexOf(BASE) !== 0) return;
  // 音频分段请求（Range）不能进 Cache，交给浏览器
  if (req.headers.get('range')) return;

  if (AUDIO_RE.test(url.pathname)) { event.respondWith(audioFirst(req)); return; }
  if (req.mode === 'navigate') { event.respondWith(navFirst(req)); return; }
  event.respondWith(cacheFirst(req));
});

/* ---------------- 消息 ---------------- */
self.addEventListener('message', function (event) {
  var data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
  if (data.type === 'CLEAR_CACHE') {
    event.waitUntil(caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { return k.indexOf('quiz-') === 0 ? caches.delete(k) : null; }));
    }));
  }
});
