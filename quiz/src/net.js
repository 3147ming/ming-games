/* ===== 知识问答 · 网络适配层（UMD：浏览器挂 globalThis.QANet，Node 可 require 单测） =====
   目的（A4）：以前 8 类外部端点的超时、中断、错误分类、降级顺序散在 netFailText /
   trySource / fetchOnline / callAI / testAI / callAIRaw / 维基三接口里，断网行为没法单测。
   现在统一：
   - FALLBACK   一张显式降级表（每条链路的源顺序、超时、失败策略、涉及端点）；
   - FAIL_TEXT  一张失败文案表，netFailText 只做委托；
   - timedFetch 带超时 + AbortController 的 fetch，返回原生 Response 的 Promise，
                调用点的 .then/.catch 形状不变（原有探针的 fetch stub 照旧生效）；
   - reason     统一错误分类（timeout / net / http / empty / nofetch）；
   - chain      按总预算逐源重试（联网题库的主源 → 代理 → 离线兜底）。
   本文件不碰 DOM、不读写存储；需要时间/定时器的地方都由调用方或 env 注入，便于 Node 单测。 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.QANet = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /* 一张显式降级表：源顺序即降级顺序。端点 URL 只在各自的调用处定义一份，
       这里登记 id / 用途 / 失败策略，避免把 URL 复制成第二真相。 */
    var FALLBACK = {
        quiz: {
            label: '联网题库',
            chain: ['opentdb', 'allorigins', 'offlinePool'],
            endpoints: ['opentdb.com/api.php', 'api.allorigins.win/raw'],
            timeoutMs: 8000, minLeftMs: 1500, onFail: 'offlinePool'
        },
        wiki: {
            label: '百科释义',
            chain: ['opensearch', 'search', 'wikidata', 'summary', 'extract'],
            endpoints: ['zh.wikipedia.org/w/api.php (opensearch)', 'zh.wikipedia.org/w/api.php (search)',
                        'www.wikidata.org/w/api.php', 'zh.wikipedia.org/api/rest_v1/page/summary',
                        'zh.wikipedia.org/w/api.php (extracts)'],
            timeoutMs: 6000, onFail: 'empty'
        },
        ai: {
            label: 'AI 建题 / 评判 / 连接测试',
            chain: ['configuredUrl', 'proxy'],
            endpoints: ['7 家服务商 + Pollinations（URL 见 AI_PROVIDERS）'],
            timeoutMs: 30000, testTimeoutMs: 10000, onFail: 'disableOrToast'
        },
        suggest: {
            label: '百度联想 / 百科卡片',
            chain: ['suggestion.baidu.com', 'baike.baidu.com'],
            endpoints: ['suggestion.baidu.com/su', 'baike.baidu.com/api/openapi/BaikeLemmaCardApi'],
            timeoutMs: 5000, onFail: 'empty'
        },
        audio: {
            label: '本地音频扩展名探测',
            chain: ['mp3', 'flac', 'wav', 'm4a', 'ogg', 'aac'],
            endpoints: ['quiz/audio/<basename>.<ext>'],
            timeoutMs: 0, onFail: 'nextExt'
        }
    };

    var FAIL_TEXT = {
        timeout: '⚠️ 联网超时，已尝试备用源',
        net: '⚠️ 网络不可达，请检查网络后重试',
        nofetch: '⚠️ 当前环境不支持联网，已使用本地离线题库（{n}题）',
        http: '⚠️ 联网服务返回异常，已尝试备用源',
        empty: '⚠️ 联网题库返回空数据，已使用本地离线题库（{n}题）',
        fail: '⚠️ 联网获取失败，已使用本地离线题库（{n}题）'
    };
    function failText(reason, offlineCount) {
        var t = FAIL_TEXT[reason] || FAIL_TEXT.fail;
        return t.replace(/\{n\}/g, String(offlineCount == null ? 0 : offlineCount));
    }

    function err(kind, message) {
        var e = new Error(message || kind);
        e.name = kind === 'timeout' ? 'AbortError' : kind;
        e.reason = kind;
        return e;
    }
    /* 统一错误分类：AbortError / reason=timeout 一律归超时，其余归网络不可达。 */
    function reason(e) {
        if (!e) { return 'net'; }
        if (e.reason && FAIL_TEXT[e.reason]) { return e.reason; }
        var name = String(e.name || '');
        if (/Abort|timeout/i.test(name) || /timeout/i.test(String(e.message || ''))) { return 'timeout'; }
        return 'net';
    }

    function envOf(env) {
        var E = env || {};
        var G = (typeof globalThis !== 'undefined') ? globalThis : null;
        /* 显式传 fetch:null 表示「环境不支持联网」，不能被宿主自带的 fetch 顶掉 */
        var f = Object.prototype.hasOwnProperty.call(E, 'fetch')
            ? E.fetch : (typeof fetch === 'function' ? fetch : null);
        var st = E.setTimeout || (typeof setTimeout === 'function' ? setTimeout : null);
        var ct = E.clearTimeout || (typeof clearTimeout === 'function' ? clearTimeout : null);
        return {
            fetch: f,
            /* 原生 fetch / setTimeout 以对象方法形式调用会抛 Illegal invocation，
               必须绑定到全局对象再调（Node 单测的 mock 函数同样接受 .call）。 */
            callFetch: function (u, o) { return f.call(G, u, o); },
            AbortController: E.AbortController || (typeof AbortController === 'function' ? AbortController : null),
            setTimeout: function (fn, ms) { return st.call(G, fn, ms); },
            clearTimeout: function (h) { if (ct) { return ct.call(G, h); } },
            now: E.now || function () { return Date.now(); }
        };
    }
    /* 带超时的 fetch：返回原生 Response 的 Promise，签名与既有 .then 链兼容。
       env 可注入 fetch / AbortController / 定时器，供 Node 单测构造断网场景。 */
    function timedFetch(url, opt, ms, env) {
        var E = envOf(env);
        return new Promise(function (resolve, reject) {
            if (!E.fetch) { reject(err('nofetch')); return; }
            var o = {}, k;
            for (k in opt) { if (Object.prototype.hasOwnProperty.call(opt, k)) { o[k] = opt[k]; } }
            var ac = null, timer = null, done = false;
            function finish(kind, value) {
                if (done) { return; }
                done = true;
                if (timer) { E.clearTimeout(timer); }
                if (kind) { reject(err(kind, value)); } else { resolve(value); }
            }
            if (ms > 0 && E.AbortController) {
                try { ac = new E.AbortController(); o.signal = ac.signal; } catch (e) { ac = null; }
            }
            if (ms > 0) {
                timer = E.setTimeout(function () {
                    try { if (ac && ac.abort) { ac.abort(); } } catch (e) { }
                    finish('timeout');
                }, ms);
            }
            try {
                Promise.resolve(E.callFetch(url, o)).then(function (r) {
                    finish('', r);
                }).catch(function (e) {
                    finish(reason(e));
                });
            } catch (e) {
                finish('net');
            }
        });
    }

    /* 按总预算逐源重试：attempt(src, leftMs, next)；next(ok, value, reason) 决定是否继续。
       done(ok, value, reason, src)。预算见底或源用尽时以最后一个 reason 收尾。 */
    function chain(sources, budget, attempt, done, env) {
        var E = envOf(env);
        var i = 0, t0 = E.now(), lastReason = '';
        var minLeft = 1500;
        function finish(ok, value, why, src) {
            done(!!ok, value, why || lastReason || 'fail', src || null);
        }
        function next(ok, value, why) {
            if (why) { lastReason = why; }
            if (ok) { finish(true, value, '', sources[i - 1]); return; }
            var left = budget - (E.now() - t0);
            if (i >= sources.length || left < minLeft) {
                finish(false, null, lastReason || (left < minLeft ? 'timeout' : 'fail'), null);
                return;
            }
            var src = sources[i++];
            try {
                attempt(src, left, next);
            } catch (e) {
                lastReason = 'net';
                next(false, null, 'net');
            }
        }
        next(false, null, '');
    }

    return {
        FALLBACK: FALLBACK,
        FAIL_TEXT: FAIL_TEXT,
        failText: failText,
        reason: reason,
        timedFetch: timedFetch,
        chain: chain
    };
});
