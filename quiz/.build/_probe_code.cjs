/* 批次 C3：编程选择题走 CODE_TOPICS 读代码题型（绕开旧 POOLS.code 硬凑干扰项）
   A. 编程→选择题→进阶：出题成功、有代码块、选项齐全、无填空输入框
   B. 连查 5 题：每题选项 ≥2、无 input[type=text]
   C. 页内 genSection(10,2/0/4)：全部带 exp（来自 CODE_TOPICS）、带 code、4 选项含答案
   D. 干扰项不含旧跨类词（可执行文件/未找到/视图/内存/应用程序接口）
   E. 只勾 Python 的用户：入门档也能出满 10 题（放宽语言补齐，不回落到旧池）
   F. 填空题板块仍走输入框（回归）
   G. 收尾：无 JS 异常、无横向溢出 */
const { spawn } = require('child_process');
const path = require('path');
const { Session, sleep } = require('./cdp.cjs');

const PORT = 8864;
const APP = process.argv[2] || ('http://127.0.0.1:' + PORT + '/quiz/');
const USE_LOCAL = !process.argv[2];
const pass = [], fail = [];
function ck(n, c, e) { (c ? pass : fail).push(n + (e ? ' :: ' + e : '')); }

const SAMPLE = (function () {
  return `(function(){
    var qs=QA_TYPES.code.genSection(10,DIFF);
    var noexp=0,nocode=0,noopts=0,noans=0,not4=0,banned=[],kinds={};
    var ban=/^(可执行文件|未找到|视图|内存|应用程序接口)$/;
    qs.forEach(function(q){
      if(!q.exp)noexp++;
      if(!q.code)nocode++;
      if(!q.opts||q.opts.length<2)noopts++;
      if(!q.opts||q.opts.indexOf(String(q.a))<0)noans++;
      if(q.opts&&q.opts.length!==4)not4++;
      kinds[q.kind||'-']=1;
      (q.opts||[]).forEach(function(o){if(o!==String(q.a)&&ban.test(o))banned.push(o);});
    });
    return JSON.stringify({n:qs.length,noexp:noexp,nocode:nocode,noopts:noopts,noans:noans,not4:not4,banned:banned,first:(qs[0]&&qs[0].q)||'',kind:Object.keys(kinds).join('/')});
  })()`;
}).call(null);

(async () => {
  const srv = USE_LOCAL ? spawn(process.execPath, [path.join(__dirname, 'serve.cjs'), String(PORT)], { stdio: 'ignore' }) : null;
  if (USE_LOCAL) await sleep(700);
  const s = new Session({ width: 414, height: 896, port: 9364 });
  let LAST = '';
  try {
    await s.open(APP);
    await s.waitFor('!!document.querySelector(".book")', 15000);
    await s.eval("(function(){try{return navigator.serviceWorker.getRegistrations().then(function(rs){return Promise.all(rs.map(function(r){return r.unregister();}));});}catch(e){return 1;}})()");
    await s.eval("localStorage.clear();localStorage.setItem('bt_qa_profile_code', JSON.stringify({done:true,skipped:true,langs:[],level:0,rank:0}));localStorage.setItem('bt_qa_quickjump','false');1");
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);
    await s.eval("window.confirm=function(){return true;};window.alert=function(){};1");
    const _ev = s.eval.bind(s);
    s.eval = function (x) { LAST = String(x).slice(0, 120); return _ev(x); };
    const hasSel = (sel) => s.eval('!!document.querySelector(' + JSON.stringify(sel) + ')');

    const toShelf = async () => {
      for (let i = 0; i < 8; i++) {
        if (await hasSel('#curOverlay')) { await s.eval("(function(){var o=document.getElementById('curOverlay');var b=o.querySelector('.close');if(b){b.click();return 1;}return 0;})()"); await sleep(250); continue; }
        if (await hasSel('.book')) return true;
        await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /退出本局|结束并结算/.test(x.textContent)})[0];if(b)b.click();return 1;})()");
        await sleep(450);
      }
      return await hasSel('.book');
    };
    /* 打开编程板块并选板块 + 档位（diffIdx：0=自动，1=入门 … 5=精通） */
    const openCode = async (secRe, diffIdx) => {
      await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('.book')).filter(function(x){return x.textContent.indexOf('编程')>=0;})[0];if(b)b.click();return 1;})()");
      await s.waitFor("!!document.querySelector('.secbtn')||!!document.querySelector('.diffbtn')", 9000);
      if (await hasSel('.secbtn')) {
        await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('.secbtn')).filter(function(x){return " + secRe + ".test(x.textContent)})[0];if(b)b.click();return 1;})()");
        await sleep(450);
      }
      await s.eval("(function(){var bs=document.querySelectorAll('.diffbtn');if(bs.length>" + diffIdx + ")bs[" + diffIdx + "].click();var go=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return /开始出题/.test(x.textContent)})[0];if(go)go.click();return 1;})()");
      await s.waitFor("!!document.querySelector('#stage .qbox')", 9000);
      await sleep(200);
    };
    const qInfo = () => s.eval("(function(){var st=document.getElementById('stage');var ob=st.querySelectorAll('.obtn').length;var ip=st.querySelectorAll('input[type=text]').length;var cb=st.querySelectorAll('.codeblk').length;var qb=st.querySelector('.qbox');return JSON.stringify({ob:ob,ip:ip,cb:cb,stem:(qb?qb.textContent:'').replace(/\\s+/g,' ').slice(0,80)});})()");

    /* ===== A/B. 编程 → 选择题 → 进阶 ===== */
    await openCode('/选择题/', 2);
    const hud = await s.eval("(function(){var e=document.querySelector('#stage .hl');return e?e.textContent:'';})()");
    ck('编程选择题第 3 档出题成功', /编程/.test(hud), 'hud=' + hud);
    let q1 = JSON.parse(await qInfo());
    ck('编程选择题渲染了代码块', q1.cb >= 1, JSON.stringify(q1));
    ck('首题选项 ≥2 且不是填空输入框', q1.ob >= 2 && q1.ip === 0, JSON.stringify(q1));

    let badQ = [], seenQ = 1;
    for (let i = 0; i < 4; i++) {
      await s.eval("(function(){var b=document.querySelector('#stage .obtn');if(b)b.click();return 1;})()");
      await sleep(900);
      const nx = await s.eval("(function(){var b=document.querySelector('#stage .fbnext');if(b){b.click();return 1;}return 0;})()");
      if (!nx) break;
      await sleep(350);
      const qi = JSON.parse(await qInfo());
      seenQ++;
      if (qi.ob < 2 || qi.ip > 0) badQ.push(i + 2 + ':ob=' + qi.ob + ',ip=' + qi.ip + ' ' + qi.stem);
    }
    ck('连查 ' + seenQ + ' 题：每题选项 ≥2 且无填空输入框', badQ.length === 0, badQ.join(' | '));

    /* ===== D2. 自动匹配（无限模式）—— C3 的漏网之鱼 =====
       自动模式走 showQuestion → genAutoOne()，此前直接调 engine_core 的 genNextAuto()→T.gen()，
       完全绕过 sectionGen：编程选择题会掉回旧 POOLS.code 硬凑干扰项，还会混进 mkCodeFill 的填空题。
       这里真的点开「自动匹配·无限刷题」，连取 12 题逐题验选项。 */
    await toShelf();
    await openCode('/选择题/', 0);
    const hudAuto = await s.eval("(function(){var st=document.getElementById('stage');return (st.querySelector('.hl')?st.querySelector('.hl').textContent:'')+' | '+(st.textContent.indexOf('无限模式')>=0?'无限模式':'无');})()");
    ck('自动匹配进入无限模式（HUD 标注）', /编程/.test(hudAuto) && /无限模式/.test(hudAuto), 'hud=' + hudAuto);
    const AUTO_JUNK = /^(const|\/\* \*\/|可执行文件|未找到|视图|内存)$/;
    let autoBad = [], autoQ = [];
    for (let i = 0; i < 12; i++) {
      const qi = JSON.parse(await qInfo());
      const opts = JSON.parse(await s.eval("JSON.stringify([].slice.call(document.querySelectorAll('#stage .obtn')).map(function(x){return x.textContent;}))"));
      autoQ.push(opts.length);
      if (opts.length < 4 || qi.ip > 0) autoBad.push('#' + (i + 1) + ' ob=' + opts.length + ' ip=' + qi.ip + ' ' + qi.stem);
      else if (opts.some(o => AUTO_JUNK.test(o))) autoBad.push('#' + (i + 1) + ' 跨类=' + JSON.stringify(opts));
      await s.eval("(function(){var b=document.querySelector('#stage .obtn');if(b)b.click();return 1;})()");
      await sleep(650);
      await s.eval("(function(){var b=document.querySelector('#stage .fbnext');if(b){b.click();return 1;}return 0;})()");
      await sleep(320);
    }
    ck('自动匹配 12 题：全部 4 选项、无填空题混入、无跨类干扰项', autoBad.length === 0, autoBad.slice(0, 3).join(' | ') + ' 选项数=' + autoQ.join(','));


    for (const d of [2, 0, 4]) {
      const r = JSON.parse(await s.eval(SAMPLE.replace('DIFF', String(d))));
      const okAll = r.n === 10 && r.noexp === 0 && r.nocode === 0 && r.noopts === 0 && r.noans === 0;
      ck('档位 ' + d + ' → genSection 出满 10 题，全部带解析/代码/选项/答案', okAll, JSON.stringify(r));
      ck('档位 ' + d + ' → 干扰项无旧跨类词', r.banned.length === 0, r.banned.join(','));
      ck('档位 ' + d + ' → 每题 4 个选项', r.not4 === 0, 'not4=' + r.not4);
    }

    /* ===== E. 只勾 Python：入门档也能出满 10 题（放宽语言，不回旧池） ===== */
    await toShelf();
    await s.eval("localStorage.setItem('bt_qa_profile_code', JSON.stringify({done:true,skipped:false,langs:['python'],level:0,rank:0}));1");
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);
    await s.eval("window.confirm=function(){return true;};1");
    await openCode('/选择题/', 1);
    const rPy = JSON.parse(await s.eval(SAMPLE.replace('DIFF', '0')));
    ck('只勾 Python 的用户：入门档仍出满 10 题', rPy.n === 10, JSON.stringify(rPy).slice(0, 160));
    ck('只勾 Python 的用户：题目仍来自 CODE_TOPICS（带解析/代码）', rPy.noexp === 0 && rPy.nocode === 0, JSON.stringify(rPy).slice(0, 160));
    ck('只勾 Python 的用户：干扰项无旧跨类词', rPy.banned.length === 0, rPy.banned.join(','));

    /* ===== F. 填空题板块仍走输入框（回归）：走 HUD 板块 chip 切换（重进书架会沿用上次板块） ===== */
    await s.eval("(function(){var e=document.querySelector('#stage .sec');if(e)e.click();return 1;})()");
    await s.waitFor("!!document.querySelector('#curOverlay .secbtn')", 9000);
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#curOverlay .secbtn')).filter(function(x){return /填空题/.test(x.textContent)})[0];if(b)b.click();return 1;})()");
    await s.waitFor("!!document.querySelector('#stage .qbox')", 9000);
    await sleep(350);
    const qf = JSON.parse(await qInfo());
    ck('填空题板块仍是输入框', qf.ip >= 1, JSON.stringify(qf));
    ck('填空题板块不渲染选项按钮', qf.ob === 0, JSON.stringify(qf));

    /* ===== G. 收尾 ===== */
    ck('全程无 JS 异常', s.errors.length === 0, s.errors.slice(0, 2).join(' | '));
    const ovf = await s.eval('document.documentElement.scrollWidth - document.documentElement.clientWidth');
    ck('无横向溢出', ovf <= 0, 'overflow=' + ovf);
  } catch (e) {
    fail.push('探针异常 :: ' + e.message + ' | 最后表达式: ' + LAST);
  } finally {
    console.log('\n=== 编程选择题走 CODE_TOPICS（批次 C3）：' + pass.length + '/' + (pass.length + fail.length) + ' 通过 ===');
    pass.forEach(t => console.log('  ✓ ' + t));
    fail.forEach(t => console.log('  ✗ ' + t));
    await s.close();
    try { srv && srv.kill('SIGKILL'); } catch (e) {}
  }
})().catch(e => { console.error(e); process.exit(1); });
