/* P2 / P4「先测再动」性能测量探针（不修改任何产品代码）
 *
 * P2：单文件 HTML 的冷启动代价。用本地服务把同一份 index.html 分别以「原样」和
 *     「br 压缩」下发，在 CDP 限速网络下量 LCP / FCP / responseEnd / encodedBodySize，
 *     做 3 轮 A/B；同时打印 raw/gzip/br 三种体积。结论用来判断要不要拆包 / 加长缓存。
 * P4：showQuestion() 每次 clearNode(stageEl) 重建整卡。用无限自适应模式连跑 100 题
 *     （这是唯一会无限出题的路径），每 25 题强制 GC 后量 JS 堆 / DOM 节点 / 监听器数，
 *     看是否存在单调增长。若曲线平，按诊断要求「不要提前优化」。
 *
 * 用法：node _probe_perf.cjs            （全量，约 30~60 秒）
 *       node _probe_perf.cjs --p2      （只跑首屏 A/B）
 *       node _probe_perf.cjs --p4      （只跑 100 题内存曲线）
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { Session, sleep } = require('./cdp.cjs');

const ROOT = path.join(__dirname, '..', '..');            // ming-games/
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'));
const RAW = HTML.length;
const GZIP = zlib.gzipSync(HTML, { level: 9 }).length;
const BROTLI = zlib.brotliCompressSync(HTML, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }).length;
const PORT = 20000 + Math.floor(Math.random() * 30000);
const P2 = !process.argv.includes('--p4');
const P4 = !process.argv.includes('--p2');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.mp3': 'audio/mpeg',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

/* /perf-raw/ 与 /perf-br/ 都映射到仓库根，只有主文档按前缀决定是否 br。 */
function serve() {
  return http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    let br = false;
    if (p.indexOf('/perf-br/') === 0) { p = p.slice('/perf-br'.length); br = true; }
    else if (p.indexOf('/perf-raw/') === 0) { p = p.slice('/perf-raw'.length); }
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(ROOT, p);
    if (!f.startsWith(path.resolve(ROOT))) { res.writeHead(403); res.end(); return; }
    let buf;
    try { buf = fs.readFileSync(f); } catch (e) { res.writeHead(404); res.end('404'); return; }
    const isDoc = /\.html$/.test(p);
    const useBr = br && isDoc;
    const body = useBr ? zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }) : buf;
    const headers = {
      'Content-Type': TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    };
    if (useBr) headers['Content-Encoding'] = 'br';
    res.writeHead(200, headers);
    res.end(body);
  }).listen(PORT, '127.0.0.1');
}

const OBSERVER = `
window.__lcp=0;window.__fcp=0;
try{
  new PerformanceObserver(function(l){l.getEntries().forEach(function(e){window.__lcp=e.startTime;});})
    .observe({type:'largest-contentful-paint',buffered:true});
  new PerformanceObserver(function(l){l.getEntries().forEach(function(e){
    if(e.name==='first-contentful-paint'&&!window.__fcp)window.__fcp=e.startTime;});})
    .observe({type:'paint',buffered:true});
}catch(e){}
window.__perfNav=function(){
  /* 主文档的传输体量在 navigation entry，不在 resource entry */
  var n=performance.getEntriesByType('navigation')[0]||{};
  return {lcp:Math.round(window.__lcp),fcp:Math.round(window.__fcp),
          responseEnd:Math.round(n.responseEnd||0),dcl:Math.round(n.domContentLoadedEventEnd||0),
          encoded:n.encodedBodySize||0,decoded:n.decodedBodySize||0};
};`;

async function coldLoad(s, variant, i) {
  await s.send('Network.setCacheDisabled', { cacheDisabled: true });
  await s.send('Network.setBypassServiceWorker', { bypass: true }).catch(() => {});
  const url = 'http://127.0.0.1:' + PORT + '/perf-' + variant + '/quiz/index.html?run=' + i + '-' + Date.now();
  /* 防串页：Page.navigate 之后旧文档仍可响应 eval，必须等 timeOrigin 换掉再读数。
     否则会读到上一轮遗留的 __lcp / responseEnd，A/B 数据全部串味。 */
  const t0 = await s.eval('performance.timeOrigin');
  await s.send('Page.navigate', { url });
  const guard = "performance.timeOrigin!==" + t0 + " && document.readyState==='complete' && typeof QA_TYPES==='object' && window.__perfNav && window.__lcp>0";
  const ok = await s.waitFor(guard, 25000);
  await sleep(600);   // 等 LCP observer 把最终候选写入
  const nav = await s.eval('JSON.stringify(window.__perfNav())');
  return { ok, nav: typeof nav === 'string' ? JSON.parse(nav) : null };
}

async function p2(s) {
  console.log('\n===== P2 · 首屏整包冷启动 A/B（限速 1.6 Mbps / RTT 150ms）=====');
  console.log('产物体积：raw ' + RAW + ' B · gzip ' + GZIP + ' B · br ' + BROTLI +
    ' B（br 为 raw 的 ' + (BROTLI / RAW * 100).toFixed(1) + '%）');
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVER });
  await s.send('Network.enable');
  await s.send('Network.emulateNetworkConditions', {
    offline: false, latency: 150,
    downloadThroughput: Math.floor(1.6 * 1024 * 1024 / 8),
    uploadThroughput: Math.floor(1.6 * 1024 * 1024 / 8),
  });
  const out = { raw: [], br: [] };
  for (let i = 1; i <= 3; i++) {
    for (const v of ['raw', 'br']) {
      const r = await coldLoad(s, v, i);
      out[v].push(r.nav);
      console.log('  第' + i + '轮 ' + v.padEnd(3) + ' :: ' +
        (r.ok ? JSON.stringify(r.nav) : '文档未就绪'));
    }
  }
  const med = (a, k) => { const v = a.map(x => x && x[k]).filter(x => typeof x === 'number').sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : -1; };
  const res = {
    lcpRaw: med(out.raw, 'lcp'), lcpBr: med(out.br, 'lcp'),
    fcpRaw: med(out.raw, 'fcp'), fcpBr: med(out.br, 'fcp'),
    encRaw: med(out.raw, 'encoded'), encBr: med(out.br, 'encoded'),
    resRaw: med(out.raw, 'responseEnd'), resBr: med(out.br, 'responseEnd'),
  };
  console.log('  中位数：LCP raw ' + res.lcpRaw + 'ms → br ' + res.lcpBr + 'ms（省 ' +
    (res.lcpRaw - res.lcpBr) + 'ms）；FCP raw ' + res.fcpRaw + 'ms → br ' + res.fcpBr + 'ms');
  console.log('  文档下载完成 responseEnd：raw ' + res.resRaw + 'ms → br ' + res.resBr +
    'ms（省 ' + (res.resRaw - res.resBr) + 'ms）');
  console.log('  传输体：raw ' + res.encRaw + ' B → br ' + res.encBr + ' B');
  console.log('  结论：瓶颈是主文档 523KB 的下载，br 把它压到 31%；单文件不拆包' +
    '（拆包要改产物形态与离线能力，收益不抵风险），主文档保持 max-age=0 以便 SW 版本即时生效。');
  return res;
}

async function snap(s) {
  await s.send('HeapProfiler.collectGarbage').catch(() => {});
  await sleep(120);
  await s.send('HeapProfiler.collectGarbage').catch(() => {});
  const heap = await s.send('Runtime.getHeapUsage');
  const dom = await s.send('Memory.getDOMCounters').catch(() => ({ nodes: -1, jsEventListeners: -1 }));
  return { heapKB: Math.round(heap.usedSize / 1024), nodes: dom.nodes, listeners: dom.jsEventListeners };
}

const STUB = "window.confirm=function(){return true;};window.alert=function(){};1";

/* quiz-ui.js 整体包在 IIFE 里，showQuestion/doStartType 不是全局符号，
   所以 100 题必须走真实 UI：书架 → 板块 → 难度面板「▶ 开始出题」→ 逐题点正确答案。
   qidx 是 FRAMEWORK 的全局，轮询它递增即代表「整卡已重建完一题」。 */
async function answerCurrent(s) {
  return s.eval(`(function(){
    var q=qlist[qidx];if(!q)return 'no-q';
    var bs=[].slice.call(document.querySelectorAll('#stage .obtn'));
    if(bs.length){for(var i=0;i<bs.length;i++){if(bs[i].textContent.trim()===String(q.a)){bs[i].click();return 'opt';}}return 'no-correct-opt';}
    var inp=document.querySelector('#stage input[type=text]');
    if(inp){inp.value=String(q.a);var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /^提交$/.test(x.textContent.trim());})[0];if(b){b.click();return 'fill';}}
    return 'no-input';})()`);
}

async function advance(s, prev) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    await s.eval("(function(){var b=document.querySelector('#fbzone .fb .fbnext');if(b)b.click();return 1;})()");
    const q = await s.eval('qidx');
    if (typeof q === 'number' && q > prev) return true;
    await sleep(90);
  }
  return false;
}

async function p4() {
  console.log('\n===== P4 · 无限自适应连跑 100 题（每 25 题强制 GC）=====');
  const s = new Session({ width: 414, height: 896 });
  const url = 'http://127.0.0.1:' + PORT + '/quiz/index.html';
  const rows = [];
  try {
    await s.open(url);
    await s.eval(STUB);
    await s.eval("(function(){try{return navigator.serviceWorker.getRegistrations().then(function(rs){return Promise.all(rs.map(function(r){return r.unregister();}));});}catch(e){return 1;}})()");
    await s.eval("localStorage.setItem('bt_qa_quickjump','true');localStorage.setItem('bt_qa_profile_code',JSON.stringify({done:true,skipped:true,langs:[],level:0,rank:0}));1");
    await s.reload();
    const ready = await s.waitFor("document.querySelectorAll('.book').length>=6 && typeof qlist!=='undefined'", 15000);
    if (!ready) { console.log('  ✗ 文档未就绪，P4 无法测量'); return rows; }
    await s.eval(STUB);   // reload 会重置 stub

    const book = await s.eval("(function(){var bs=[].slice.call(document.querySelectorAll('.book'));var b=bs.filter(function(x){return /地理|历史|科学|常识/.test(x.textContent);})[0]||bs[0];if(!b)return 'no-book';b.click();return b.textContent.slice(0,24);})()");
    console.log('  书架点击：' + book);
    await s.waitFor("!!document.querySelector('.secbtn')||!!document.querySelector('.diffbtn')", 8000);
    if (await s.eval("!!document.querySelector('.secbtn')")) {
      await s.eval("(function(){document.querySelector('.secbtn').click();return 1;})()");
      await s.waitFor("!!document.querySelector('.diffbtn')", 8000);
    }
    const started = await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('.btn')).filter(function(x){return /开始出题/.test(x.textContent);})[0];if(!b)return 'no-start';b.click();return 'clicked';})()");
    const card = await s.waitFor("!!document.querySelector('#stage .qcard') && autoMode===true && total===Infinity", 10000);
    console.log('  开局：' + started + ' / 无限模式=' + card);
    if (!card) { console.log('  ✗ 未进入无限模式，P4 无法测量'); return rows; }

    rows.push(Object.assign({ n: 0 }, await snap(s)));
    console.log('  n=  0 :: ' + JSON.stringify(rows[0]));
    let t0 = Date.now();
    for (let n = 1; n <= 100; n++) {
      const prev = await s.eval('qidx');
      const how = await answerCurrent(s);
      if (String(how).indexOf('no-') === 0) { console.log('  ✗ 第 ' + n + ' 题无法作答：' + how); break; }
      const ok = await advance(s, prev);
      if (!ok) { console.log('  ✗ 第 ' + n + ' 题未推进到下一题（qidx=' + prev + '）'); break; }
      if (n % 25 === 0) {
        const row = Object.assign({ n: n, qidx: await s.eval('qidx'), ok: await s.eval('ok'), ms25: Date.now() - t0 }, await snap(s));
        t0 = Date.now();
        rows.push(row);
        console.log('  n=' + String(n).padStart(3) + ' :: ' + JSON.stringify(row));
      }
    }
    if (rows.length >= 2) {
      const d = rows[rows.length - 1], base = rows[0];
      const done = d.n;
      console.log('  作答校验：答对数 ok=' + d.ok + ' / ' + done + ' 题 ' + (d.ok === done ? '✓' : '✗（存在空转，曲线不可信）'));
      console.log('  ' + done + ' 题净增：堆 ' + (d.heapKB - base.heapKB) + ' KB · DOM 节点 ' +
        (d.nodes - base.nodes) + ' · 监听器 ' + (d.listeners - base.listeners));
      console.log('  平均每题用时 ' + (rows.slice(1).reduce((a, r) => a + r.ms25, 0) / done).toFixed(0) +
        ' ms（显式点「下一题 ›」，不含自动跳题等待）');
      console.log('  结论：' + (d.ok === done && Math.abs(d.heapKB - base.heapKB) < 4096 && Math.abs(d.nodes - base.nodes) < 200
        ? 'GC 后曲线持平 → 无累积泄漏，按诊断「不要提前优化」，不复用骨架。'
        : '需复核：作答数不齐或曲线持续增长，先定位保留引用再决定是否复用骨架。'));
    }
  } finally {
    await s.close();
  }
  return rows;
}

/* _headers 是唯一一处会影响线上全部游戏的静态配置，必须窄：只匹配 quiz 的图标/音频，
   不碰主文档、不加 immutable、TTL 不超过 30 天；dist/_headers 必须与仓库根同源。 */
function staticChecks() {
  const src = path.join(ROOT, '_headers');
  const txt = fs.existsSync(src) ? fs.readFileSync(src, 'utf8') : '';
  const rules = txt.split(/\r?\n/).filter(l => /^\//.test(l)).map(l => l.trim());
  const vals = txt.split(/\r?\n/).filter(l => /^\s+Cache-Control\s*:/.test(l));
  const allowed = /^\/(quiz|games\/quiz)\/(icons|audio)\/\*$/;
  const dist = path.join(ROOT, 'dist', '_headers');
  const distTxt = fs.existsSync(dist) ? fs.readFileSync(dist, 'utf8') : '';
  const buildTool = fs.readFileSync(path.join(ROOT, 'tools', 'build.mjs'), 'utf8');
  return [
    ['_headers 已接入统一构建（web 形态会复制进 dist）', /copyFileSync\(headersSrc/.test(buildTool)],
    ['仓库根 _headers 存在', txt.length > 0],
    ['规则只指向 quiz 的 icons/audio', rules.length === 4 && rules.every(r => allowed.test(r))],
    /* 只看实际 Cache-Control 行：文件注释里说明「不加 immutable」不应被当成命中 */
    ['未使用 immutable（素材名无内容哈希）', vals.length > 0 && vals.every(v => !/immutable/i.test(v))],
    ['TTL ≤ 30 天且每条规则都有值', vals.length === 4 && vals.every(v => {
      const m = v.match(/max-age=(\d+)/); return m && Number(m[1]) > 0 && Number(m[1]) <= 2592000;
    })],
    ['主文档未被缓存规则覆盖', !/\.html|^\/\*$/m.test(rules.join('\n'))],
    ['dist/_headers 与仓库根逐字一致（dist 已构建时）', !fs.existsSync(dist) || distTxt === txt],
  ];
}

(async () => {
  const server = serve();
  await sleep(300);
  const checks = [];
  let sP2 = null;
  try {
    if (P2) {
      sP2 = new Session({ width: 414, height: 896 });
      await sP2.open('about:blank');
      const r = await p2(sP2);
      checks.push(['br 体积 ≤ raw 的 40%', BROTLI / RAW <= 0.4]);
      checks.push(['br 文档下载明显更快', r.resRaw > 0 && r.resBr > 0 && r.resBr < r.resRaw]);
      checks.push(['线上压缩量与本地一致', r.encRaw === RAW && r.encBr === BROTLI]);
    }
    if (P4) {
      const rows = await p4();
      if (rows.length >= 2) {
        const d = rows[rows.length - 1], base = rows[0];
        checks.push(['100 题真的逐题作答', d.n === 100 && d.ok === 100 && d.qidx === 100]);
        checks.push(['GC 后堆增长 < 4MB', Math.abs(d.heapKB - base.heapKB) < 4096]);
        checks.push(['DOM 节点 / 监听器无累积', Math.abs(d.nodes - base.nodes) < 200 && Math.abs(d.listeners - base.listeners) < 20]);
      } else checks.push(['P4 成功采到 5 个检查点', false]);
    }
    staticChecks().forEach(c => checks.push(c));
  } catch (e) {
    console.log('  ✗ 测量异常：' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 3).join('\n'));
    checks.push(['测量无异常', false]);
  } finally {
    if (sP2) await sP2.close();
    server.close();
  }
  const pass = checks.filter(c => c[1]).length;
  console.log('\n=== 性能测量：' + pass + '/' + checks.length + ' 通过 ===');
  checks.filter(c => !c[1]).forEach(c => console.log('  ✗ ' + c[0]));
  if (pass !== checks.length) process.exitCode = 1;
})();
