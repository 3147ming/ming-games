/* 答错 / 不会 / 手写重写 专项探针（批次 A 后行为）
   核心规则（指令 2.1）：
   - 选择题 / 填空题 / 读代码 / 代码补全：答错 / 不会 / 判错后 只显示「下一题」，不给任何重写入口。
   - 代码手写题（Q.hand===true）：显示「✍️ 重写代码」+「下一题」；重写答对只 +5 学习奖励。
   A. 选择题答错 → 只「下一题」（无重写）
   B. 选择题「下一题」立即切题、无残留计时
   C. 选择题答对 → +10、800ms 自动跳（无重写）
   D. 选择题「不会」→ 只「下一题」（无重写）
   G. 无限模式：5 次首次作答 → 结算「最近 5 题」
   H. 薄弱题回顾（数学）答错 → 无重写、只「下一题」
   --- 以下依赖本地 mock AI ---
   E. 手写题「不会」→ 给「✍️ 重写代码」+「下一题」；重写答对只 +5、不计入 ok、不重复记薄弱
   F. 手写题重写多次答错 → 不扣分、不重复 +5
   J. 手写题 AI 判错 → 给「✍️ 重写代码」+「下一题」；再点提交不重复烧 AI
   I. 人工题（选择题）答错 → 无重写、「💡 AI 解析」可用
   K. 收尾体检：无 JS 异常、无横向溢出 */
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const { Session, sleep } = require('./cdp.cjs');

const PORT = 8857;
const AI_PORT = 8858;
const APP = process.argv[2] || ('http://127.0.0.1:' + PORT + '/quiz/');
const USE_LOCAL = !process.argv[2];
const pass = [], fail = [];
function ck(n, c, e) { (c ? pass : fail).push(n + (e ? ' :: ' + e : '')); }

/* 本地 mock AI：
   - 评判类 prompt（含「批改一道编程练习」）→ 默认判不正确；代码里带 ALLGOOD 标记则判正确。
   - 讲题类 prompt → 返回 {"exp":...} */
const aiHits = [];
const aiSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const isJudge = /批改一道编程练习/.test(body);
    aiHits.push(isJudge ? 'judge' : 'explain');
    const isCorrect = /ALLGOOD/.test(body);
    const content = isJudge
      ? JSON.stringify({ ok: isCorrect, why: isCorrect ? '边界判断正确' : '缺少边界判断' })
      : JSON.stringify({ exp: '先把题意拆成两步，再合并结果' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});

(async () => {
  aiSrv.listen(AI_PORT, '127.0.0.1');
  const srv = USE_LOCAL ? spawn(process.execPath, [path.join(__dirname, 'serve.cjs'), String(PORT)], { stdio: 'ignore' }) : null;
  if (USE_LOCAL) await sleep(700);
  const s = new Session({ width: 414, height: 896, port: 9357 });
  let LAST = '';
  try {
    await s.open(APP);
    await s.waitFor('!!document.querySelector(".book")', 15000);
    await s.eval("(function(){try{return navigator.serviceWorker.getRegistrations().then(function(rs){return Promise.all(rs.map(function(r){return r.unregister();}));});}catch(e){return 1;}})()");
    await s.eval("localStorage.clear();localStorage.setItem('bt_qa_quickjump','true');localStorage.setItem('bt_qa_profile_code', JSON.stringify({done:true,skipped:true,langs:[],level:0,rank:0}));1");
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);
    await s.eval("window.confirm=function(){return true;};window.alert=function(){};1");

    const _ev = s.eval.bind(s);
    s.eval = function (x) { LAST = String(x).slice(0, 110); return _ev(x); };

    const hasSel = (sel) => s.eval('!!document.querySelector(' + JSON.stringify(sel) + ')');
    const clickSel = (sel) => s.eval("(function(){var e=document.querySelector(" + JSON.stringify(sel) + ");if(e){e.click();return 1;}return 0;})()");
    const clickBook = (name) => s.eval("(function(){var bs=document.querySelectorAll('.book');for(var i=0;i<bs.length;i++){if(bs[i].textContent.indexOf(" + JSON.stringify(name) + ")>=0){bs[i].click();return 1;}}return 0;})()");
    const pickSec = (kw) => s.eval("(function(){var bs=[].slice.call(document.querySelectorAll('.secbtn'));for(var i=0;i<bs.length;i++){if(bs[i].textContent.indexOf(" + JSON.stringify(kw) + ")>=0){bs[i].click();return 1;}}return 0;})()");
    const startDiff = (idx) => s.eval("(function(){var bs=document.querySelectorAll('.diffbtn');if(!bs.length)return 0;bs[" + idx + "].click();var go=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return /开始出题/.test(x.textContent)})[0];if(!go)return 0;go.click();return 1;})()");
    const clickAns = (v, want) => s.eval("(function(){var v=" + JSON.stringify(v) + ",want=" + (want ? 1 : 0) + ";var bs=[].slice.call(document.querySelectorAll('#stage .obtn'));if(bs.length){for(var i=0;i<bs.length;i++){var t=bs[i].textContent.trim();if(want?(t===v):(t!==v)){bs[i].click();return 1;}}return 0;}var inp=document.querySelector('#stage input[type=text]');if(inp){inp.value=want?v:'__绝不可能答对__';var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /^提交$/.test(x.textContent.trim())})[0];if(b){b.click();return 2;}}return -1;})()");
    const curAns = () => s.eval("(function(){var q=qlist[qidx];return q?String(q.a==null?'':q.a):'';})()");
    const fbText = () => s.eval("(function(){var f=document.querySelector('#fbzone .fb');return f?f.textContent:'';})()");
    const qidx = () => s.eval('qidx');
    const score = () => s.eval('score');
    const okN = () => s.eval('ok');
    const settled = () => s.eval("(function(){var q=qlist[qidx];return !!(q&&q.settled);})()");
    const enabledOpts = () => s.eval("[].slice.call(document.querySelectorAll('#stage .obtn')).filter(function(b){return !b.disabled;}).length");
    const weakN = async () => JSON.parse(await s.eval("S.getItem('bt_qa_weak')||'[]'")).length;
    const hitNext = () => clickSel('#fbzone .fb .fbnext');
    const hasRewrite = () => s.eval("(function(){var bs=[].slice.call(document.querySelectorAll('#fbzone .fb .chip')||[]);for(var i=0;i<bs.length;i++){if(/重写代码/.test(bs[i].textContent))return 1;}return 0;})()");
    const hasNext = () => hasSel('#fbzone .fb .fbnext');
    const hasRetryLegacy = () => s.eval("/🔄 重试/.test((document.querySelector('#fbzone .fb')||{}).textContent||'')");
    const unk = () => clickSel('#stage .unkbtn');
    const rewrite = () => clickSel('#fbzone .fb .fbretry');

    const toShelf = async () => {
      for (let i = 0; i < 6; i++) {
        if (await hasSel('.book')) return true;
        if (await hasSel('#curOverlay')) {
          await s.eval("(function(){var o=document.getElementById('curOverlay');var b=[].slice.call(o.querySelectorAll('.btn')).filter(function(x){return /返回|关闭|取消/.test(x.textContent)})[0];if(b)b.click();return 1;})()");
          await sleep(320); continue;
        }
        await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /退出本局|结束并结算/.test(x.textContent)})[0];if(b)b.click();return 1;})()");
        await sleep(520);
      }
      const r = await hasSel('.book');
      if (!r) await s.eval("history.back();1");
      await sleep(500);
      return await hasSel('.book');
    };
    const openCat = async (name, secKw, diffIdx) => {
      await toShelf();
      await clickBook(name);
      await s.waitFor('!!document.querySelector(".secbtn")||!!document.querySelector(".diffbtn")', 8000);
      if (await hasSel('.secbtn')) { await pickSec(secKw); await s.waitFor('!!document.querySelector(".diffbtn")', 8000); }
      await startDiff(diffIdx);
      return await s.waitFor("document.querySelectorAll('#stage .obtn').length>=2", 10000);
    };
    const enterHand = async () => {
      await toShelf();
      await clickBook('编程');
      await s.waitFor('!!document.querySelector(".secbtn")||!!document.querySelector(".diffbtn")', 8000);
      if (await hasSel('.secbtn')) { await pickSec('程序编写'); await s.waitFor('!!document.querySelector(".diffbtn")', 8000); }
      await startDiff(1);
      await s.waitFor("!!document.querySelector('#stage .obtn')||!!document.querySelector('#stage .toggle')", 10000);
      await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .toggle')).filter(function(x){return /手写代码/.test(x.textContent)})[0];if(b)b.click();return 1;})()");
      await s.waitFor("!!document.querySelector('#stage .codeinp')", 8000);
    };
    const submitCode = (code) => s.eval("(function(){var t=document.querySelector('#stage .codeinp');if(!t)return 0;t.value=" + JSON.stringify(code) + ";if(t.dispatchEvent)t.dispatchEvent(new Event('input'));var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /提交 AI 评判/.test(x.textContent)})[0];if(b){b.click();return 1;}return 0;})()");

    /* ================= A. 选择题答错 → 只「下一题」（无重写） ================= */
    ck('进入数学·选择题（能出题）', await openCat('数学', '选择题', 2), '');
    const s0 = await score(), o0 = await okN(), w0 = await weakN();
    const a1 = await curAns();
    await clickAns(a1, false);
    await sleep(320);
    const t1 = await fbText();
    ck('答错后反馈条有「正确答案：」', /正确答案：/.test(t1), JSON.stringify(t1.slice(0, 40)));
    ck('答错后反馈条有解析盒', await hasSel('#fbzone .fb .fexp'), '');
    ck('答错后【不】给重写入口（选择题无重写）', (await hasRewrite()) === 0, '');
    ck('答错后【不】是旧「🔄 重试」', (await hasRetryLegacy()) === false, '');
    ck('答错后给「下一题 ›」', await hasNext(), '');
    ck('答错后本题标记 settled（首次已结算）', (await settled()) === true, '');
    ck('答错后薄弱题 +1', (await weakN()) === w0 + 1, w0 + '→' + await weakN());
    await sleep(3600);
    ck('答错后 3.6s 仍停在本題（不再自动跳）', (await qidx()) === 0, 'qidx=' + await qidx());

    /* ================= B. 「下一题」立即切题、无残留计时 ================= */
    await hitNext();
    await sleep(200);
    ck('点「下一题 ›」立即进入下一题', (await qidx()) === 1, 'qidx=' + await qidx());
    const qAfter = await qidx();
    await sleep(1500);
    ck('切题后没有残留计时器再跳一次', (await qidx()) === qAfter, qAfter + '→' + await qidx());

    /* ================= C. 选择题答对 → +10、自动跳（无重写） ================= */
    const a2 = await curAns();
    const sBeforeC = await score();
    await clickAns(a2, true);
    await sleep(320);
    const t2 = await fbText();
    ck('答对 → 文案含「＋10」', /＋10/.test(t2), JSON.stringify(t2.slice(0, 40)));
    ck('答对 → 只加 10 分', (await score()) === sBeforeC + 10, sBeforeC + '→' + await score());
    ck('答对 → 【不】给重写入口', (await hasRewrite()) === 0, '');
    await sleep(1300);
    ck('答对仍自动跳到下一题', (await qidx()) === 2, 'qidx=' + await qidx());

    /* ================= D. 选择题「不会」→ 只「下一题」（无重写） ================= */
    const wBeforeD = await weakN();
    await unk();
    await sleep(320);
    const t3 = await fbText();
    ck('「不会」后显示正确答案', /正确答案：/.test(t3), JSON.stringify(t3.slice(0, 40)));
    ck('「不会」后显示解析', await hasSel('#fbzone .fb .fexp'), '');
    ck('「不会」后【不】给重写入口（选择题无重写）', (await hasRewrite()) === 0, '');
    ck('「不会」后【不】是旧「🔄 重试」', (await hasRetryLegacy()) === false, '');
    ck('「不会」后给「下一题 ›」', await hasNext(), '');
    ck('「不会」后薄弱题再 +1', (await weakN()) === wBeforeD + 1, wBeforeD + '→' + await weakN());
    await sleep(3200);
    ck('「不会」后 3.2s 仍停在本題', (await qidx()) === 2, 'qidx=' + await qidx());

    /* ================= G. 无限模式：5 次首次作答 → 结算「最近 5 题」 ================= */
    await openCat('数学', '选择题', 0);
    const hud0 = await s.eval("(function(){var e=document.querySelector('#stage .hud .hl');return e?e.textContent:'';})()");
    ck('进入无限模式（HUD 显示实力档）', /实力：/.test(String(hud0)), JSON.stringify(hud0));
    for (let i = 0; i < 5; i++) {
      await clickAns(await curAns(), false);
      await sleep(260);
      await hitNext();
      await sleep(220);
    }
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /结束并结算/.test(x.textContent)})[0];if(b)b.click();return 1;})()");
    await s.waitFor("(function(){return /返回书架/.test(document.getElementById('stage').textContent);})()", 8000);
    const finTxt = await s.eval("(function(){return document.getElementById('stage').textContent;})()");
    const mWin = String(finTxt).match(/最近 (\d+) 题正确率/);
    ck('结算页显示窗口题数', !!mWin, JSON.stringify(String(finTxt).slice(0, 80)));
    ck('无限模式：5 次首次作答 → 最近 5 题', mWin && Number(mWin[1]) === 5, mWin ? mWin[0] : '未匹配');

    /* ================= H. 薄弱题回顾（数学）答错 → 无重写 ================= */
    await toShelf();
    await s.eval("localStorage.setItem('bt_qa_weak', JSON.stringify([{type:'b:math',diff:1,q:'3+5=?',a:'8',opts:['6','7','8','9'],time:Date.now()}]));1");
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);
    await s.eval("window.confirm=function(){return true;};window.alert=function(){};1");
    await clickBook('数学'); // 触发书架渲染（weak 数据已就绪）
    const wBeforeH = await weakN();
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('.act')).filter(function(x){return /薄弱题/.test(x.textContent)})[0];if(b)b.click();return 1;})()");
    await s.waitFor("!!document.querySelector('#curOverlay .list-row')", 8000);
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return /全部回顾/.test(x.textContent)})[0];if(b)b.click();return 1;})()");
    await s.waitFor("document.querySelectorAll('#stage .obtn').length>=2", 10000);
    ck('进入薄弱题回顾', (await s.eval('reviewMode')) === true, '');
    await clickAns(await curAns(), false);
    await sleep(320);
    ck('回顾答错 → 【不】给重写入口（数学题无重写）', (await hasRewrite()) === 0, '');
    ck('回顾答错 → 给「下一题 ›」', await hasNext(), '');
    const rq = await qidx();
    await sleep(2200);
    ck('回顾答错不自动跳', (await qidx()) === rq, rq + '→' + await qidx());
    ck('薄弱题条数未减少（答错不移除）', (await weakN()) >= wBeforeH, wBeforeH + '→' + await weakN());

    /* ================= 以下依赖本地 mock AI ================= */
    if (USE_LOCAL) {
      await s.eval("localStorage.setItem('bt_qa_ai', JSON.stringify({url:'http://127.0.0.1:" + AI_PORT + "/v1/chat/completions',key:'k',model:'m',proxy:''}));1");
      await s.reload();
      await s.waitFor('!!document.querySelector(".book")', 12000);
      await s.eval("window.confirm=function(){return true;};window.alert=function(){};1");

      /* ================= E. 手写题「不会」→ 重写 + 下一题；重写答对只 +5 ================= */
      await enterHand();
      ck('进入手写代码题（mock AI 已配置）', await hasSel('#stage .codeinp'), '');
      await unk();
      await sleep(320);
      const tE = await fbText();
      ck('手写题「不会」→ 给结论/参考代码', /正确答案：（AI 评判）/.test(tE) || /参考代码/.test(tE), JSON.stringify(tE.slice(0, 50)));
      ck('手写题「不会」→ 给「✍️ 重写代码」（非旧「🔄 重试」）', (await hasRewrite()) === 1, '');
      ck('手写题「不会」→ 不是旧「🔄 重试」', (await hasRetryLegacy()) === false, '');
      ck('手写题「不会」→ 给「下一题 ›」', await hasNext(), '');
      const sE = await score(), oE = await okN(), wE = await weakN();
      await rewrite();
      await sleep(320);
      ck('点「✍️ 重写代码」后仍在本題（qidx 未动）', (await qidx()) === 0, 'qidx=' + await qidx());
      ck('重写后代码输入框重新出现', await hasSel('#stage .codeinp'), '');
      ck('重写后反馈条已清空', !(await hasSel('#fbzone .fb')), '');
      await submitCode('ALLGOOD\nint main(){return 0;}');
      await s.waitFor("/判为正确/.test((document.querySelector('#fbzone .fb')||{}).textContent||'')", 12000);
      const tE2 = await fbText();
      ck('重写答对 → 提示正确', /判为正确/.test(tE2), JSON.stringify(tE2.slice(0, 40)));
      ck('重写答对 → 只加 5 分', (await score()) === sE + 5, sE + '→' + await score());
      ck('重写答对 → 不计入 ok（正确率不被刷高）', (await okN()) === oE, oE + '→' + await okN());
      ck('重写答对不重复记薄弱题', (await weakN()) === wE, wE + ' vs ' + await weakN());
      ck('重写答对 → 【不】再给重写入口', (await hasRewrite()) === 0, '');
      ck('重写答对 → 给「下一题 ›」', await hasNext(), '');
      await sleep(1400);
      ck('重写答对 1.4s 内不立即跳（等用户读反馈）', (await qidx()) === 0, 'qidx=' + await qidx());
      await sleep(1300);
      ck('重写答对 → 约 2.2s 后自动跳到下一题', (await qidx()) === 1, 'qidx=' + await qidx());

      /* ================= F. 手写题重写多次答错 → 不扣分、不重复 +5 ================= */
      await toShelf();
      await enterHand();
      await unk();
      await sleep(300);
      ck('手写题「不会」→ 给「✍️ 重写代码」', (await hasRewrite()) === 1, '');
      await rewrite();
      await sleep(300);
      const sF0 = await score();
      await submitCode('int main(){return 1;}');
      await s.waitFor("/判为不正确/.test((document.querySelector('#fbzone .fb')||{}).textContent||'')", 12000);
      ck('重写答错 → 判为不正确', /判为不正确/.test(await fbText()), JSON.stringify((await fbText()).slice(0, 40)));
      ck('重写答错 → 不扣分', (await score()) === sF0, sF0 + '→' + await score());
      ck('重写答错 → 仍给「✍️ 重写代码」可再写', (await hasRewrite()) === 1, '');
      await rewrite();
      await sleep(300);
      await submitCode('int main(){return 2;}');
      await s.waitFor("/判为不正确/.test((document.querySelector('#fbzone .fb')||{}).textContent||'')", 12000);
      ck('重写再答错 → 仍不扣分', (await score()) === sF0, sF0 + '→' + await score());
      ck('重写再答错 → 不重复 +5', (await score()) === sF0, sF0 + '→' + await score());

      /* ================= J. 手写题 AI 判错 → 重写 + 下一题；不重复烧 AI ================= */
      await toShelf();
      await enterHand();
      const hitsBefore = aiHits.filter(x => x === 'judge').length;
      await submitCode('int main(){return 99;}');
      await s.waitFor("/判为不正确|判为正确/.test((document.querySelector('#fbzone .fb')||{}).textContent||'')", 12000);
      const tJ = await fbText();
      ck('手写题 AI 判错 → 反馈条给结论', /判为不正确/.test(tJ), JSON.stringify(tJ.slice(0, 50)));
      ck('手写题 AI 判错 → 给「✍️ 重写代码」', (await hasRewrite()) === 1, '');
      ck('手写题 AI 判错 → 给「下一题 ›」', await hasNext(), '');
      ck('手写题 AI 判错 → 不是旧「🔄 重试」', (await hasRetryLegacy()) === false, '');
      const hq = await qidx();
      await sleep(2200);
      ck('手写题 AI 判错不自动跳', (await qidx()) === hq, hq + '→' + await qidx());
      ck('作答后输入框 / 提交按钮已禁用', await s.eval("(function(){var t=document.querySelector('#stage .codeinp');var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /提交 AI 评判/.test(x.textContent)})[0];return !!(t&&t.disabled&&b&&b.disabled);})()"), '');
      await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /提交 AI 评判/.test(x.textContent)})[0];if(b)b.click();return 1;})()");
      await sleep(600);
      ck('再点提交不会重复调 AI', aiHits.filter(x => x === 'judge').length === hitsBefore + 1, 'hits=' + aiHits.filter(x => x === 'judge').length);

      /* ================= I. 人工题（选择题）答错 → 无重写、AI 解析可用 ================= */
      await toShelf();
      await openCat('常识', '选择题', 3);
      const c0 = await score();
      await clickAns(await curAns(), false);
      await sleep(320);
      ck('高档位答错扣 5 分', (await score()) === c0 - 5, c0 + '→' + await score());
      ck('人工题答错【不】给重写入口（选择题无重写）', (await hasRewrite()) === 0, '');
      ck('人工题答错【不】是旧「🔄 重试」', (await hasRetryLegacy()) === false, '');
      ck('人工题答错给「💡 AI 解析」按钮', await hasSel('#fbzone .fb .aibtn'), '');
      ck('人工题答错给「下一题 ›」', await hasNext(), '');
      await clickSel('#fbzone .fb .aibtn');
      await s.waitFor('!!document.querySelector("#fbzone .fb .fexp")', 6000);
      ck('AI 解析回来 → 渲染成解析盒', /先把题意拆成两步/.test(await fbText()), JSON.stringify((await fbText()).slice(0, 60)));
      const cq = await qidx();
      await sleep(1500);
      ck('AI 解析回来也不自动跳（等用户决定）', (await qidx()) === cq, cq + '→' + await qidx());

    } else {
      console.log("  - 跳过 AI 相关项（线上 https 页面无法访问本地 http mock）");
    }

    /* ================= K. 收尾体检 ================= */
    ck('全程无 JS 异常', s.errors.length === 0, s.errors.slice(0, 2).join(' | '));
    const ovf = await s.eval('document.documentElement.scrollWidth - document.documentElement.clientWidth');
    ck('无横向溢出', ovf <= 0, 'overflow=' + ovf);
  } catch (e) {
    fail.push('探针异常 :: ' + e.message + ' | 最后表达式: ' + LAST);
  } finally {
    console.log('\n=== 答错/不会/手写重写（批次 A 后）：' + pass.length + '/' + (pass.length + fail.length) + ' 通过 ===');
    pass.forEach(t => console.log('  ✓ ' + t));
    fail.forEach(t => console.log('  ✗ ' + t));
    await s.close();
    try { srv && srv.kill('SIGKILL'); } catch (e) {}
    try { aiSrv.close(); } catch (e) {}
  }
})().catch(e => { console.error(e); process.exit(1); });
