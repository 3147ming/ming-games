/* 批次 C2：SRS 四个 bug + 掌握标准统一 专项探针
   A. SRS 复习 3 题全对 → 结算 3/3（不是 0/3）+ 已复习 3 题
   B. SRS 结算「再复习一轮」→ 回到 SRS（不是上一次分类；先制造 lastRun=math）
   C. SRS 里点「不会」→ lv=0、due 改为明天、反馈提示明天再复习
   D. 普通局答错已有 SRS 记录 → lv 重置 0、due 明天（addWeak 数据层）
   E. SRS 局点板块 chip → 不报错、不弹板块面板
   F. 薄弱题本答对 → SRS 推进 lv=1，不一次移除
   G. 收尾：无 JS 异常、无横向溢出 */
const { spawn } = require('child_process');
const path = require('path');
const { Session, sleep } = require('./cdp.cjs');

const PORT = 8862;
const APP = process.argv[2] || ('http://127.0.0.1:' + PORT + '/quiz/');
const USE_LOCAL = !process.argv[2];
const pass = [], fail = [];
function ck(n, c, e) { (c ? pass : fail).push(n + (e ? ' :: ' + e : '')); }
const D = 86400000, now = Date.now();

function seed(q, a, lv, dueOff) {
  return { n: 1, t: now - 1000, type: 'b:science', diff: 0, q: q, a: a, opts: [a, 'w1', 'w2', 'w3'], srs: { lv: lv, due: now + dueOff } };
}

(async () => {
  const srv = USE_LOCAL ? spawn(process.execPath, [path.join(__dirname, 'serve.cjs'), String(PORT)], { stdio: 'ignore' }) : null;
  if (USE_LOCAL) await sleep(700);
  const s = new Session({ width: 414, height: 896, port: 9362 });
  let LAST = '';
  try {
    await s.open(APP);
    await s.waitFor('!!document.querySelector(".book")', 15000);
    await s.ensureLoaded();   // 线上先验文档完整性（抓包代理会截断 HTML）
    await s.eval("(function(){try{return navigator.serviceWorker.getRegistrations().then(function(rs){return Promise.all(rs.map(function(r){return r.unregister();}));});}catch(e){return 1;}})()");
    await s.eval("localStorage.clear();localStorage.setItem('bt_qa_profile_code', JSON.stringify({done:true,skipped:true,langs:[],level:0,rank:0}));localStorage.setItem('bt_qa_quickjump','true');1");
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);
    await s.eval("window.confirm=function(){return true;};window.alert=function(){};1");
    const _ev = s.eval.bind(s);
    s.eval = function (x) { LAST = String(x).slice(0, 120); return _ev(x); };

    const hasSel = (sel) => s.eval('!!document.querySelector(' + JSON.stringify(sel) + ')');
    const toShelf = async () => {
      for (let i = 0; i < 8; i++) {
        if (await hasSel('#curOverlay')) { await s.eval("(function(){var o=document.getElementById('curOverlay');var b=o.querySelector('.close');if(b){b.click();return 1;}return 0;})()"); await sleep(300); continue; }
        if (await hasSel('.book')) return true;
        await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /退出本局|结束并结算/.test(x.textContent)})[0];if(b)b.click();return 1;})()");
        await sleep(500);
      }
      return await hasSel('.book');
    };
    const setWeak = (arr) => s.eval("localStorage.setItem('bt_qa_weak', JSON.stringify(" + JSON.stringify(arr) + "));1");
    const weakArr = async () => JSON.parse(await s.eval("localStorage.getItem('bt_qa_weak')||'[]'"));
    const hudText = () => s.eval("(function(){var e=document.querySelector('#stage .hl');return e?e.textContent:'';})()");
    const finTxt = () => s.eval("(function(){return (document.getElementById('stage').textContent||'').replace(/\\s+/g,' ');})()");

    /* ===== A. SRS 复习 3 题全对 → 3/3 ===== */
    await setWeak([seed('SRS_A2_升档题', 'ansA2', 0, -1000), seed('SRS_B2_升档题', 'ansB2', 0, -1000), seed('SRS_C2_升档题', 'ansC2', 0, -1000)]);
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);
    /* 先进入数学一局，把 lastRun 设成 math（用于 B 检验「再来一局」是否误回数学） */
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('.book')).filter(function(x){return x.textContent.indexOf('数学')>=0;})[0];if(b)b.click();return 1;})()");
    await s.waitFor("!!document.querySelector('.secbtn')||!!document.querySelector('.diffbtn')", 8000);
    if (await hasSel('.secbtn')) { await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('.secbtn')).filter(function(x){return /选择题/.test(x.textContent)})[0];if(b)b.click();return 1;})()"); await sleep(500); }
    await s.eval("(function(){var bs=document.querySelectorAll('.diffbtn');if(bs.length)bs[2%bs.length].click();var go=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return /开始出题/.test(x.textContent)})[0];if(go)go.click();return 1;})()");
    await s.waitFor("!!document.querySelector('#stage .qbox')", 8000);
    const mathHud = await hudText();
    ck('已先跑一局数学（供 B 检验「再复习一轮」不误回上次分类）', /数学/.test(mathHud), 'hud=' + mathHud);
    await toShelf();

    const srsBtn = await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('.act')).filter(function(x){return /待复习/.test(x.textContent)})[0];if(b){b.click();return 1;}return 0;})()");
    ck('书架有「⏰ 待复习」入口', srsBtn === 1, '');
    await s.waitFor("!!document.querySelector('#stage .qbox')", 8000);
    ck('进入 SRS 复习局', /SRS/.test(await hudText()), await hudText());

    let answered = 0;
    for (let i = 0; i < 8; i++) {
      if (/再复习一轮|正确率/.test(await finTxt())) break;
      await s.waitFor("!!document.querySelector('#stage .qbox')", 6000);
      const stem = await s.eval("(document.querySelector('#stage .qbox')||{}).textContent||''");
      let corr = /SRS_A2/.test(stem) ? 'ansA2' : (/SRS_B2/.test(stem) ? 'ansB2' : (/SRS_C2/.test(stem) ? 'ansC2' : null));
      if (!corr) { await sleep(400); continue; }
      await s.eval("(function(){var bs=[].slice.call(document.querySelectorAll('#stage .obtn'));var c=" + JSON.stringify(corr) + ";var b=bs.filter(function(x){return x.textContent===c;})[0];if(b)b.click();return 1;})()");
      answered++;
      await sleep(1000);   /* quickjump：答对 800ms 自动跳 */
    }
    await s.waitFor("(function(){return /再复习一轮|正确率/.test(document.getElementById('stage').textContent||'');})()", 8000);
    const ft = await finTxt();
    ck('SRS 3 题全对 → 结算（3 / 3）', ft.indexOf('（3 / 3）') >= 0, ft.slice(0, 120));
    ck('SRS 结算文案含「已复习 3 题」', /已复习 3 题/.test(ft), ft.slice(0, 160));
    const storeA = await weakArr();
    ck('SRS 答对后 A/B/C 都升到 lv1', ['SRS_A2', 'SRS_B2', 'SRS_C2'].every(function(k) { var r = storeA.filter(function(x) { return x.q && x.q.indexOf(k) >= 0; })[0]; return !!(r && r.srs && r.srs.lv === 1); }), JSON.stringify(storeA.map(function(x) { return x.srs && x.srs.lv; })));

    /* ===== B. 「再复习一轮」→ 回到 SRS（不是上一次分类 math） ===== */
    const storeB = await weakArr();
    storeB.push(seed('SRS_D2_再复习题', 'ansD2', 0, -1000));
    await setWeak(storeB);
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /再复习一轮/.test(x.textContent)})[0];if(b)b.click();return 1;})()");
    await s.waitFor("!!document.querySelector('#stage .qbox')", 8000);
    const hudB = await hudText();
    const tkB = await s.eval('typeKey');
    ck('SRS「再复习一轮」→ 回到 SRS（不是上一次分类）', /SRS/.test(hudB) && tkB === 'b:srs', 'hud=' + hudB + ' typeKey=' + tkB);

    /* ===== C. SRS 点「不会」→ due 明天 ===== */
    await s.eval("(function(){var b=document.querySelector('#stage .unkbtn');if(b)b.click();return 1;})()");
    await sleep(400);
    const storeC = await weakArr();
    const rC = storeC.filter(function(x) { return x.q && x.q.indexOf('SRS_D2') >= 0; })[0];
    ck('SRS 点「不会」→ lv 重置 0', !!(rC && rC.srs && rC.srs.lv === 0), rC ? JSON.stringify(rC.srs) : '缺失');
    ck('SRS 点「不会」→ due 改为明天', !!(rC && rC.srs && rC.srs.due > Date.now() + 0.5 * D && rC.srs.due < Date.now() + 2 * D), rC ? ('due in ' + ((rC.srs.due - Date.now()) / 3600000).toFixed(1) + 'h') : '缺失');
    ck('SRS 点「不会」→ 反馈提示明天再复习', /明天再复习/.test(await s.eval("(document.querySelector('#fbzone .fb')||{}).textContent||''")), '');

    /* ===== E. SRS 局点板块 chip → 不报错、不弹面板 ===== */
    const errBefore = s.errors.length;
    await s.eval("(function(){var e=document.querySelector('#stage .sec');if(e)e.click();return 1;})()");
    await sleep(300);
    ck('SRS 局点板块 chip 不报错', s.errors.length === errBefore, s.errors.slice(-2).join(' | '));
    ck('SRS 局点板块 chip 不弹板块面板', (await hasSel('#curOverlay')) === false, '');

    /* ===== D. 普通局答错已有 SRS 记录 → 间隔重置（addWeak 数据层） ===== */
    const hasAddWeak = await s.eval("typeof addWeak==='function'");
    ck('addWeak 可从页面调用', hasAddWeak === true, '');
    if (hasAddWeak) {
      const storeD = await weakArr();
      storeD.push({ n: 1, t: Date.now(), type: 'b:science', diff: 2, q: 'SRS_R_RESET_重置题', a: 'ansR', opts: ['ansR', 'r1', 'r2', 'r3'], srs: { lv: 3, due: Date.now() + 7 * D } });
      await setWeak(storeD);
      const afterD = await s.eval("(function(){addWeak({type:'b:science',q:'SRS_R_RESET_重置题',a:'ansR'});var a=JSON.parse(localStorage.getItem('bt_qa_weak')||'[]');var r=a.filter(function(x){return x.q.indexOf('SRS_R_RESET')>=0;})[0];return JSON.stringify(r&&r.srs);})()");
      const rd = JSON.parse(afterD || '{}');
      ck('普通局答错已有 SRS 记录 → lv 重置 0', rd.lv === 0, afterD);
      ck('普通局答错已有 SRS 记录 → due 改为明天', rd.due > Date.now() + 0.5 * D && rd.due < Date.now() + 2 * D, 'due in ' + ((rd.due - Date.now()) / 3600000).toFixed(1) + 'h');
    }

    /* ===== F. 薄弱题本答对 → SRS 推进 lv=1，不一次移除 ===== */
    await s.eval("localStorage.setItem('bt_qa_weak', JSON.stringify([{n:1,t:Date.now()-1000,type:'b:geo',q:'弱题_WEAK_SRS_巴黎',a:'巴黎',opts:['巴黎','伦敦','罗马','柏林'],srs:{lv:0,due:Date.now()-1000}}]));1");
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);
    await s.eval("window.confirm=function(){return true;};window.alert=function(){};1");
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('.act')).filter(function(x){return /薄弱题/.test(x.textContent)})[0];if(b)b.click();return 1;})()");
    /* 面板是「先出行、后出底部按钮」的渐进渲染：只等 .list-row 会在按钮还没挂上时抢跑。
       直接等「▶ 全部回顾」按钮本身；两次都没等到就把面板关掉重开一次。 */
    const _ALLRECALL = "!!([].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return /全部回顾/.test(x.textContent)})[0])";
    let _cl2 = 'no-btn';
    for (let t = 0; t < 2; t++) {
      if (await s.waitFor(_ALLRECALL, 6000)) break;
      await s.eval("(function(){var o=document.getElementById('curOverlay');var b=o&&o.querySelector('.close');if(b)b.click();return 1;})()");
      await sleep(500);
      await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('.act')).filter(function(x){return /薄弱题/.test(x.textContent)})[0];if(b)b.click();return 1;})()");
    }
    if (await s.waitFor(_ALLRECALL, 4000)) {
      /* 4.0.1-5：掌握口径文案（旧文案「回顾中答对即移除」与 C2 统一冲突） */
      const _hintTxt = await s.eval("(function(){var h=document.querySelector('#curOverlay .panel > .hint');return h?h.textContent:'';})()");
      ck('4.0.1-5 薄弱题本文案走 SRS 掌握口径', /30 天档答对才算掌握/.test(_hintTxt) && /1\/2\/4\/7\/15\/30/.test(_hintTxt) && !/答对即移除/.test(_hintTxt), _hintTxt.slice(0, 70));
      _cl2 = await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return /全部回顾/.test(x.textContent)})[0];if(!b)return 'no-btn';b.click();return 'clicked';})()");
    }
    /* 线上踩过：点「全部回顾」后 #stage 会先渲染一批选项再整块重绘，
       而 waitFor 超时只返回 false 不抛错 —— 抢在空窗期点击会被吞掉。
       改为「点 + 看反馈」最多重试 6 次（每次重新取 DOM），稳过重绘窗口。 */
    let _clk = 'no-opt';
    for (let i = 0; i < 6; i++) {
      await s.waitFor("document.querySelectorAll('#stage .obtn').length > 0", 3000);
      _clk = await s.eval("(function(){var bs=[].slice.call(document.querySelectorAll('#stage .obtn'));var b=bs.filter(function(x){return x.textContent==='巴黎';})[0];if(!b)return 'no-opt';b.click();return 'clicked';})()");
      if (_clk !== 'clicked') { await sleep(400); continue; }
      const got = await s.waitFor("!!document.querySelector('#fbzone .fb')", 1500);
      if (got) break;
      await sleep(400);
    }
    await sleep(300);
    const storeF = await weakArr();
    const rF = storeF.filter(function(x) { return x.q && x.q.indexOf('WEAK_SRS') >= 0; })[0];
    ck('薄弱题本答对 → 仍在题本（不一次移除）', !!rF, 'count=' + storeF.length + ' 回顾=' + _cl2 + ' 点击=' + _clk);
    ck('薄弱题本答对 → SRS 等级升到 1', !!(rF && rF.srs && rF.srs.lv === 1), rF ? JSON.stringify(rF.srs) : '缺失');
    ck('薄弱题本答对 → 反馈提示下次复习', /下次复习/.test(await s.eval("(document.querySelector('#fbzone .fb')||{}).textContent||''")), '');

    /* ===== G. 收尾 ===== */
    ck('全程无 JS 异常', s.errors.length === 0, s.errors.slice(0, 2).join(' | '));
    const ovf = await s.eval('document.documentElement.scrollWidth - document.documentElement.clientWidth');
    ck('无横向溢出', ovf <= 0, 'overflow=' + ovf);
  } catch (e) {
    fail.push('探针异常 :: ' + e.message + ' | 最后表达式: ' + LAST);
  } finally {
    console.log('\n=== SRS bug 修复 + 掌握标准统一（批次 C2）：' + pass.length + '/' + (pass.length + fail.length) + ' 通过 ===');
    pass.forEach(t => console.log('  ✓ ' + t));
    fail.forEach(t => console.log('  ✗ ' + t));
    await s.close();
    try { srv && srv.kill('SIGKILL'); } catch (e) {}
  }
})().catch(e => { console.error(e); process.exit(1); });
