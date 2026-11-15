/* A4 验收：网络适配层纯逻辑（不启浏览器、不发真实请求）。
   覆盖：显式降级表、失败文案、错误分类、超时/中断、逐源重试与预算耗尽。 */
const fs = require('fs');
const path = require('path');
const N = require('../src/net.js');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, total = 0;
function ok(c, n, extra) { total++; if (c) pass++; else console.log('  ✗ ' + n + (extra ? ' :: ' + extra : '')); }

function mock(impl) {
  let aborted = 0;
  const timers = [];
  class AC { constructor() { this.signal = { tag: 'sig' }; } abort() { aborted++; } }
  const env = {
    fetch: impl,
    AbortController: AC,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    now: () => 0
  };
  return { env, fire: () => timers.forEach(t => t.fn()), aborted: () => aborted, timers };
}

/* ---------- 降级表 ---------- */
const F = N.FALLBACK;
ok(Object.keys(F).join(',') === 'quiz,wiki,ai,suggest,audio', '五条链路都在降级表里');
ok(F.quiz.chain.join('>') === 'opentdb>allorigins>offlinePool', '联网题库主源→代理→离线');
ok(F.quiz.onFail === 'offlinePool' && F.quiz.minLeftMs === 1500, '联网题库失败策略与最小余量');
ok(F.wiki.chain.length === 5 && F.wiki.endpoints.length === 5, '维基五源/五端点登记');
ok(F.ai.timeoutMs === 30000 && F.ai.testTimeoutMs === 10000, 'AI 建题与连接测试超时分开');
ok(F.audio.chain[0] === 'mp3' && F.audio.chain.length === 6, '音频扩展名链首是 mp3');
let endpointCount = 0;
Object.keys(F).forEach(k => { endpointCount += F[k].endpoints.length; });
ok(endpointCount >= 8, '登记的端点不少于 8 类外部调用', String(endpointCount));

/* ---------- 文案 / 错误分类 ---------- */
ok(N.failText('timeout', 20).indexOf('超时') >= 0, '超时文案');
ok(N.failText('net', 20).indexOf('不可达') >= 0, '断网文案');
ok(N.failText('nofetch', 20).indexOf('20题') >= 0, 'nofetch 文案带离线题量');
ok(N.failText('empty', 20).indexOf('20题') >= 0, 'empty 文案带离线题量');
ok(N.failText('不存在的reason', 20).indexOf('失败') >= 0, '未知原因回落通用文案');
ok(N.reason({ name: 'AbortError' }) === 'timeout', 'AbortError 归超时');
ok(N.reason({ name: 'TypeError' }) === 'net', '普通异常归网络');
ok(N.reason({ reason: 'http' }) === 'http', '带 reason 的请求错误原样分类');
ok(N.reason(null) === 'net', '空异常归网络');

/* ---------- timedFetch ---------- */
(async function () {
  {
    const m = mock((url, opt) => Promise.resolve({ ok: true, url, opt, json: () => Promise.resolve({ a: 1 }) }));
    const r = await N.timedFetch('https://x/y', { method: 'HEAD', cache: 'no-store' }, 5000, m.env);
    ok(r.ok === true && r.url === 'https://x/y', '成功返回原生 Response');
    ok(r.opt.method === 'HEAD' && r.opt.cache === 'no-store' && !!r.opt.signal, 'opt 透传 + 注入 signal');
    ok(m.timers.length === 1 && m.timers[0].ms === 5000, '超时定时器按传入毫秒设置');
  }
  {
    const m = mock(() => Promise.resolve({ ok: true }));
    await N.timedFetch('u', {}, 0, m.env);
    ok(m.timers.length === 0 && !m.timers.length, 'ms=0 不装定时器（音频探测）');
  }
  {
    const m = mock(() => new Promise(() => {}));
    let got = '';
    N.timedFetch('u', {}, 3000, m.env).catch(e => { got = e.reason || e.name; });
    m.fire();
    await new Promise(r => setTimeout(r, 0));
    ok(got === 'timeout', '超时 reject 为 timeout', got);
    ok(m.aborted() === 1, '超时触发 AbortController.abort');
  }
  {
    const m = mock(() => Promise.reject(Object.assign(new Error('x'), { name: 'AbortError' })));
    let got = '';
    await N.timedFetch('u', {}, 1000, m.env).catch(e => { got = e.reason; });
    ok(got === 'timeout', 'fetch 自己抛 AbortError 也归超时', got);
  }
  {
    const m = mock(() => Promise.reject(new Error('offline')));
    let got = '';
    await N.timedFetch('u', {}, 1000, m.env).catch(e => { got = e.reason; });
    ok(got === 'net', '网络失败归 net', got);
  }
  {
    const m = mock(() => { throw new Error('sync boom'); });
    let got = '';
    await N.timedFetch('u', {}, 1000, m.env).catch(e => { got = e.reason; });
    ok(got === 'net', '同步抛错归 net', got);
  }
  {
    const env = { fetch: null, AbortController: null, setTimeout: () => 0, clearTimeout: () => {}, now: () => 0 };
    let got = '';
    await N.timedFetch('u', {}, 1000, env).catch(e => { got = e.reason; });
    ok(got === 'nofetch', '环境无 fetch 归 nofetch', got);
  }

  /* ---------- chain 逐源重试 ---------- */
  {
    const tried = [];
    const result = await new Promise(res => N.chain(['a', 'b', 'c'], 8000, (src, left, next) => {
      tried.push([src, left]);
      if (src === 'b') next(true, 'OK', ''); else next(false, null, 'empty');
    }, (okv, value, why, src) => res({ okv, value, why, src }), { now: () => 0 }));
    ok(result.okv && result.value === 'OK' && result.src === 'b', '第二源成功即止');
    ok(tried.length === 2 && tried[0][0] === 'a', '按顺序尝试主源再到备用源');
  }
  {
    const result = await new Promise(res => N.chain(['a', 'b'], 8000, (src, left, next) => next(false, null, 'http'),
      (okv, value, why) => res({ okv, why }), { now: () => 0 }));
    ok(!result.okv && result.why === 'http', '源用尽带最后原因收尾');
  }
  {
    let now = 0;
    const result = await new Promise(res => N.chain(['a', 'b', 'c'], 8000, (src, left, next) => {
      now += 5000;
      next(false, null, 'empty');
    }, (okv, value, why) => res({ okv, why }), { now: () => now }));
    ok(!result.okv && result.why === 'empty', '预算见底保留最后一次失败原因');
  }
  {
    let now = 0;
    const result = await new Promise(res => N.chain(['a', 'b'], 8000, (src, left, next) => {
      now += 5000;
      next(false, null, '');
    }, (okv, value, why) => res({ okv, why }), { now: () => now }));
    ok(!result.okv && result.why === 'timeout', '预算见底且无具体原因时归超时');
  }
  {
    const result = await new Promise(res => N.chain(['a', 'b'], 8000, () => { throw new Error('boom'); },
      (okv, value, why) => res({ okv, why }), { now: () => 0 }));
    ok(!result.okv && result.why === 'net', 'attempt 抛异常按网络失败收尾');
  }

  /* ---------- 源码接线（A4 不是只加了个空壳） ---------- */
  const core = fs.readFileSync(path.join(ROOT, 'src', 'engine_core.js'), 'utf8');
  const ui = fs.readFileSync(path.join(ROOT, 'src', 'quiz-ui.js'), 'utf8');
  const build = fs.readFileSync(path.join(__dirname, 'build.js'), 'utf8');
  ok(core.indexOf('QANet.timedFetch(') >= 0, '联网题库走统一的 timedFetch');
  ok(core.indexOf('QANet.chain(') >= 0, '联网题库走逐源重试');
  ok(core.indexOf('function netFailText(reason){return QANet.failText(') >= 0, '失败文案委托统一表');
  const posts = (ui.match(/QANet\.timedFetch\(/g) || []).length;
  ok(posts >= 3, 'AI 三条链路（建题/评判/连接测试）都走适配层', String(posts));
  ok(build.indexOf("'net.js'") >= 0, 'build.js 内联 net.js');

  console.log('=== 网络适配层探针：' + pass + '/' + total + ' ===');
  if (pass !== total) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
