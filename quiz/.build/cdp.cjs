// 轻量 CDP 客户端（Node 22 内置 WebSocket，无需第三方包）
const { spawn } = require('child_process');
const http = require('http');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGet(port, path) {
  return new Promise((res, rej) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => res(d));
    });
    /* 端口处于 TIME_WAIT 时连接可能建立却不返回响应：没有超时就会永久挂起，
       表现为整套探针无任何输出地被外层终止。每次探测都给硬上限。 */
    req.setTimeout(1500, () => req.destroy(new Error('CDP_HTTP_TIMEOUT')));
    req.on('error', rej);
  });
}

class Session {
  constructor(opts) {
    opts = opts || {};
    /* 每次会话用独立随机端口：探针里传的固定端口（9342/9384…）在串行跑时
       会撞上上一个会话留下的 TIME_WAIT，导致 Edge 起不来或 /json 挂住。 */
    this.port = 20000 + Math.floor(Math.random() * 30000);
    this.width = opts.width || 414;
    this.height = opts.height || 896;
    this.edge = null;
    this.ws = null;
    this.id = 0;
    this.pending = {};
    this.errors = [];
    this.logs = [];
    this.eventHook = null;   // 可选：接收所有 CDP 事件（调试用）
  }

  async open(url) {
    const args = [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
      '--disable-dev-shm-usage', '--hide-scrollbars',
      '--remote-debugging-port=' + this.port,
      '--user-data-dir=' + require('os').tmpdir() + '/edge-cdp-' + this.port + '-' + Date.now(),
      'about:blank',
    ];
    this.edge = spawn(EDGE, args, { stdio: 'ignore' });
    let targets = [];
    for (let i = 0; i < 40; i++) {
      try { targets = JSON.parse(await httpGet(this.port, '/json')); if (targets.length) break; } catch (e) {}
      await sleep(250);
    }
    const page = targets.find((t) => t.type === 'page') || targets[0];
    if (!page) throw new Error('NO_PAGE');
    this.ws = new WebSocket(page.webSocketDebuggerUrl);
    this.ws.addEventListener('message', (ev) => {
      let o; try { o = JSON.parse(ev.data); } catch (e) { return; }
      if (o.id && this.pending[o.id]) { this.pending[o.id](o); delete this.pending[o.id]; return; }
      if (this.eventHook) { try { this.eventHook(o); } catch (e) {} }
      if (o.method === 'Runtime.consoleAPICalled') {
        const txt = (o.params.args || []).map((a) => (a.value !== undefined ? a.value : a.description || a.type)).join(' ');
        this.logs.push(o.params.type + ': ' + txt);
      }
      if (o.method === 'Runtime.exceptionThrown') {
        const d = o.params.exceptionDetails;
        this.errors.push((d.exception && (d.exception.description || d.exception.value)) || d.text || 'unknown');
      }
      if (o.method === 'Page.javascriptDialogOpening') {
        this.logs.push('dialog: ' + o.params.message);
        this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
      }
    });
    /* WebSocket 握手必须限时：连接不上时 open/error 都可能都不触发，
       Promise 会永久挂起，整套探针表现为「零输出被外层终止」。 */
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('CDP_WS_OPEN_TIMEOUT')), 8000);
      this.ws.addEventListener('open', () => { clearTimeout(t); res(); });
      this.ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('CDP_WS_OPEN_ERROR')); });
      this.ws.addEventListener('close', () => { clearTimeout(t); rej(new Error('CDP_WS_CLOSED')); });
    });
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: this.width, height: this.height, deviceScaleFactor: 2, mobile: true,
    });
    await this.send('Page.navigate', { url });
    await sleep(2200);
    return this;
  }

  send(method, params) {
    return new Promise((res, rej) => {
      const my = ++this.id;
      /* 超时定时器必须在收到响应时清掉、且不阻止进程退出：
         以前每个 CDP 命令都留一个 45s 活跃 timer，探针打印完结果后 node 仍不退出，
         外层 shell 一直挂住直到被终止。 */
      const timer = setTimeout(() => {
        if (this.pending[my]) { delete this.pending[my]; rej(new Error(method + ' timeout')); }
      }, 45000);
      if (timer.unref) timer.unref();
      this.pending[my] = (o) => {
        clearTimeout(timer);
        o.error ? rej(new Error(method + ': ' + JSON.stringify(o.error))) : res(o.result);
      };
      this.ws.send(JSON.stringify({ id: my, method, params: params || {} }));
    });
  }

  async eval(expr) {
    // 直接求值：既支持表达式，也支持多语句脚本（最后一条表达式的值会返回）
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const msg = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      this.errors.push('EVAL: ' + msg);
      return '__THROW__:' + msg;
    }
    return r.result ? r.result.value : undefined;
  }

  async wait(ms) { await sleep(ms); }

  // 轮询等待条件为真（用于线上慢加载，避免固定 sleep 抖动）
  async waitFor(expr, timeout, step) {
    const end = Date.now() + (timeout || 8000);
    while (Date.now() < end) {
      let v;
      try { v = await this.eval(expr); } catch (e) { v = null; }
      if (v) return true;
      await sleep(step || 120);
    }
    return false;
  }

  async reload() {
    /* 每次重载都可能撞上「HTML 被截断 → 脚本半截执行」：这时 page 能到 complete、
       .book 骨架也可能在，但 quiz-ui 的全局（typeKey/addWeak…）根本没定义，
       后续断言会连锁假失败。所以 reload 自带健康校验 + 重试。 */
    for (let attempt = 0; attempt < 3; attempt++) {
      await this._reloadOnce();
      const healthy = await this.waitFor("document.readyState==='complete' && typeof QA_TYPES==='object' && typeof addWeak==='function'", 5000);
      if (healthy) return this;
      console.log('   [reload] 文档不完整（QA_TYPES/addWeak 缺失，疑似传输截断），重试 ' + (attempt + 1) + '/3');
    }
    console.log('   [reload] 连续 3 次文档不完整，放弃重试（后续断言会体现为失败）');
    return this;
  }

  async _reloadOnce() {
    /* ⚠ 只等固定 1600ms 在线上会踩「导航竞态」：旧文档还没销毁时 querySelector 命中的是旧页面，
       断言会立刻通过，随后所有 eval 却落在正在加载的新文档上（表现为 qlist is not defined）。
       这里用 performance.timeOrigin 判断新文档是否真的接手。 */
    let t0 = 0;
    try { t0 = await this.eval('performance.timeOrigin'); } catch (e) { t0 = 0; }
    await this.send('Page.reload', { ignoreCache: true });
    const end = Date.now() + 25000;
    while (Date.now() < end) {
      await sleep(150);
      let raw;
      try { raw = await this.eval('(function(){return JSON.stringify({t:performance.timeOrigin,r:document.readyState});})()'); } catch (e) { continue; }
      if (typeof raw !== 'string' || raw.charAt(0) !== '{') continue;
      let j; try { j = JSON.parse(raw); } catch (e) { continue; }
      if (j.t !== t0 && j.r === 'complete') { await sleep(200); return this; }
    }
    return this;
  }

  /* 线上专治「文档被抓包代理截断」：HTML 只收到前 N KB 时脚本半截执行，
     window 上一堆全局不存在，但 waitFor('.book') 之类的浅断言仍可能命中旧 DOM/骨架，
     结果就是后续所有断言连锁假失败（典型症状 qlist/typeKey/addWeak is not defined）。
     这里先验「整套脚本都跑完了」的完整性指纹，不健康就重载重试，把网络抖动与产品缺陷区分开。 */
  async ensureLoaded(expr, tries, label) {
    const probe = expr || "(typeof QA_TYPES==='object'&&typeof srsAdvance==='function'&&typeof addWeak==='function'&&document.querySelectorAll('.book').length>=6)";
    for (let i = 0; i < (tries || 4); i++) {
      if (await this.waitFor(probe, 6000)) return true;
      const hint = String(await this.eval("document.title+'|books='+document.querySelectorAll('.book').length+'|QA_TYPES='+(typeof QA_TYPES)+'|ui='+(typeof addWeak)")).slice(0, 120);
      console.log('   [ensureLoaded] 文档不完整，重载重试 ' + (i + 1) + '/' + (tries || 4) + ' :: ' + hint + (label ? ' (' + label + ')' : ''));
      await this.reload();
      await this.waitFor('document.readyState==="complete"', 15000);
    }
    return await this.waitFor(probe, 6000);
  }

  async close() {
    try { this.ws && this.ws.close(); } catch (e) {}
    try {
      /* Edge 会 fork 出一整棵子进程树：只 kill 主进程会留残骸继承 stdio 句柄，
         表现为探针明明跑完打印了结果，外层 shell 却挂住直到被 SIGTERM。 */
      if (this.edge && this.edge.pid) {
        spawn('taskkill', ['/PID', String(this.edge.pid), '/T', '/F'],
          { stdio: 'ignore', detached: true }).unref();
      }
      this.edge && this.edge.kill('SIGKILL');
    } catch (e) {}
  }
}

module.exports = { Session, sleep };
