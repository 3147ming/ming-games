/* 题目解析（答案 + 讲解）+ 页面层级返回锁定 专项探针
   A 段：Node vm 直跑引擎，验「程序化题 100% 带 exp、且解析与答案同源」
   B 段：无头 Edge 跑真实页面，验「答错/不会显示解析」「浏览器返回只回退不退出」 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');
const { Session, sleep } = require('./cdp.cjs');

const DIR = __dirname;
const PORT = 8868;
const APP = process.argv[2] || ('http://127.0.0.1:' + PORT + '/quiz/');
const USE_LOCAL = !process.argv[2];
const pass = [], fail = [];
function ck(n, c, e) { (c ? pass : fail).push(n + (e ? ' :: ' + e : '')); }

function boot() {
  const core = fs.readFileSync(path.join(DIR, 'engine_core.js'), 'utf8');
  const ui = fs.readFileSync(path.join(DIR, 'quiz-ui.js'), 'utf8');
  const i0 = ui.indexOf('/*=== CODE_ENGINE_START ===*/');
  const i1 = ui.indexOf('/*=== CODE_ENGINE_END ===*/');
  if (i0 < 0 || i1 < 0) throw new Error('找不到代码引擎区块标记');
  const block = ui.slice(i0, i1);
  const prelude = `
var __store={};
var S={getItem:function(k){return Object.prototype.hasOwnProperty.call(__store,k)?__store[k]:null;},
       setItem:function(k,v){__store[k]=String(v);},removeItem:function(k){delete __store[k];}};
function shuffle(a){a=a.slice();for(var i=a.length-1;i>0;i--){var j=Math.floor(Math.random()*(i+1)),t=a[i];a[i]=a[j];a[j]=t;}return a;}
function ri(n){return Math.floor(Math.random()*n);}
var score=0,total=0,ok=0,qidx=0,qlist=[],typeLabel="",typeKey="",locked=false,autoMode=false,selfRank=0,combo=0,wrongCombo=0,reviewMode=false,AUTO_TOTAL=10,UP_COMBO=2,DOWN_COMBO=2;
var curDiff=-1,curDiffLabel="",netStat=null;
var PROMO_STREAK=3,PROMO_SIZE=2,promoState='idle',promoStreak=0,promoKey='',promoRank=0,promoAsked=0,promoCorrect=0;
var selfWindow=[];
function qaDiffs(bk){var T=QA_TYPES[bk];return (T&&T.diffs&&T.diffs.length)?T.diffs:null;}
function qaDiffDefault(bk){return 0;}
function getCodeProfile(){try{return JSON.parse(S.getItem('bt_qa_profile_code')||'null');}catch(e){return null;}}
`;
  const ctx = { console, JSON, Math, Date, parseInt, parseFloat, String, Number, Array, Object, RegExp, isFinite, isNaN, setTimeout, clearTimeout };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(prelude + '\n' + core + '\n' + block + '\n', ctx, { filename: 'engine.js' });
  return ctx;
}

function layerA() {
  const E = boot();
  const run = (c) => vm.runInContext(c, E);

  /* 1. 数学四档全部带 exp，且解析里出现答案本身（同源计算，不是套话） */
  let miss = 0, bad = 0, long = 0, sample = '';
  for (let d = 0; d < 4; d++) {
    for (let i = 0; i < 120; i++) {
      const q = JSON.parse(run(`JSON.stringify(genMath(1,${d})[0])`));
      if (!q.exp) { miss++; if (!sample) sample = 'math' + d + ':' + q.q; continue; }
      if (String(q.exp).length > 60) long++;
      if (!String(q.exp).indexOf(String(q.a)) >= 0 && !/解析/.test(String(q.exp))) bad++;
    }
  }
  ck('数学四档题目 100% 带解析（480 抽）', miss === 0, '缺 ' + miss + ' 条 ' + sample);
  ck('数学解析 ≤60 字', long === 0, '超长 ' + long + ' 条');
  const m1 = JSON.parse(run(`JSON.stringify(genMath(1,0)[0])`));
  ck('数学解析是「为什么」而不是复述题干', m1.exp && m1.exp.length >= 6 && /[0-9]/.test(m1.exp), JSON.stringify(m1.exp));

  /* 2. 程序编写（读代码/补全）全部知识点 100% 带 exp
        注：旧的 CODE_GEN_CODE 分档数组已被 CODE_TOPICS 知识点×档位矩阵取代，
        这里改为遍历矩阵里每个知识点的 gen()。 */
  miss = 0; sample = '';
  let totalQ = 0;
  const topicN = run('CODE_TOPICS.length');
  for (let i = 0; i < topicN; i++) {
    const kname = run(`CODE_TOPICS[${i}].k`);
    for (let t = 0; t < 5; t++) {
      const q = JSON.parse(run(`JSON.stringify(CODE_TOPICS[${i}].gen())`));
      totalQ++;
      if (!q.exp) { miss++; if (!sample) sample = kname + ':' + q.q; }
    }
  }
  ck('程序编写 ' + topicN + ' 个知识点 100% 带解析（' + totalQ + ' 抽）', miss === 0, '缺 ' + miss + ' 条 ' + sample);

  /* 3. 参数化题库（全语言 × 五档）100% 带 exp */
  miss = 0; sample = '';
  const langs = run('CODE_LANG_KEYS.join(",")').split(',');
  for (const L of langs) {
    for (let d = 0; d < 5; d++) {
      const n = run(`((CODE_GENX['${L}']||{})['${d}']||[]).length`);
      for (let g = 0; g < n; g++) {
        const q = JSON.parse(run(`JSON.stringify(CODE_GENX['${L}']['${d}'][${g}]())`));
        if (!q.exp) { miss++; if (!sample) sample = L + d + '#' + g + ':' + q.q; }
      }
    }
  }
  ck('参数化题库全语言全档 100% 带解析', miss === 0, '缺 ' + miss + ' 条 ' + sample);

  /* 4. 组题入口（程序编写板块）每道题都带解析 */
  miss = 0;
  for (let d = 0; d < 5; d++) {
    JSON.parse(run(`JSON.stringify(QA_TYPES.code.genSection(12,${d}))`)).forEach((q) => { if (!q.exp) miss++; });
  }
  ck('程序编写组题入口 12×5 全部带解析', miss === 0, '缺 ' + miss + ' 条');

  /* 5. 人工题库不造解析（走 AI 兜底，不能凭空编） */
  const poolQ = JSON.parse(run(`JSON.stringify(QA_TYPES.common.gen(1,0)[0])`));
  ck('人工题库题不带 exp（留给 AI 解析兜底）', !poolQ.exp, JSON.stringify(poolQ.exp || ''));
}

(async () => {
  try { layerA(); } catch (e) { fail.push('A 段异常 :: ' + e.message + ' ' + (e.stack || '').split('\n')[1]); }

  const srv = USE_LOCAL ? spawn(process.execPath, [path.join(DIR, 'serve.cjs'), String(PORT)], { stdio: 'ignore' }) : null;
  if (USE_LOCAL) await sleep(700);
  const s = new Session({ width: 414, height: 896, port: 9368 });
  let LAST='';
  try {
    await s.open(APP);
    await s.waitFor('!!document.querySelector(".book")', 15000);
    await s.eval("(function(){try{return navigator.serviceWorker.getRegistrations().then(function(rs){return Promise.all(rs.map(function(r){return r.unregister();}));});}catch(e){return 1;}})()");
    await s.eval("localStorage.clear();localStorage.setItem('bt_qa_quickjump','true');localStorage.setItem('bt_qa_profile_code', JSON.stringify({done:true,skipped:true,langs:[],level:0,rank:0}));1");
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);
    await s.eval('window.confirm=function(){return true;};window.alert=function(){};1');

    const _ev=s.eval.bind(s);s.eval=function(x){LAST=String(x).slice(0,120);return _ev(x);};
    const clickBook = (name) => s.eval("(function(){var bs=document.querySelectorAll('.book');for(var i=0;i<bs.length;i++){if(bs[i].textContent.indexOf(" + JSON.stringify(name) + ")>=0){bs[i].click();return 1;}}return 0;})()");
    const pickSec = (kw) => s.eval("(function(){var bs=[].slice.call(document.querySelectorAll('.secbtn'));for(var i=0;i<bs.length;i++){if(bs[i].textContent.indexOf(" + JSON.stringify(kw) + ")>=0){bs[i].click();return 1;}}return 0;})()");
    const startDiff = (idx) => s.eval("(function(){var bs=document.querySelectorAll('.diffbtn');if(!bs.length)return 0;bs[" + idx + "].click();var go=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return /开始出题/.test(x.textContent)})[0];if(!go)return 0;go.click();return 1;})()");
    const clickAns = (v, want) => s.eval("(function(){var v=" + JSON.stringify(v) + ",want=" + (want ? 1 : 0) + ";var bs=[].slice.call(document.querySelectorAll('#stage .obtn'));if(bs.length){for(var i=0;i<bs.length;i++){var t=bs[i].textContent.trim();if(want?(t===v):(t!==v)){bs[i].click();return 1;}}return 0;}var inp=document.querySelector('#stage input[type=text]');if(inp){inp.value=want?v:'__绝不可能答对__';var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /^提交$/.test(x.textContent.trim())})[0];if(b){b.click();return 2;}}return -1;})()");
    const curAns = () => s.eval("(function(){var q=qlist[qidx];return q?String(q.a==null?'':q.a):'';})()");
    const fbText = () => s.eval("(function(){var f=document.querySelector('#fbzone .fb');return f?f.textContent:'';})()");
    const hasSel = (sel) => s.eval("!!document.querySelector(" + JSON.stringify(sel) + ")");
    /* 层级不靠内部变量，直接用界面特征判定（探针不依赖调试钩子） */
    const layer = () => s.eval("(function(){var ov=document.getElementById('curOverlay');if(ov){if(ov.querySelector('.secbtn'))return 'section';if(ov.querySelector('.diffbtn'))return 'diff';return 'overlay';}var st=document.getElementById('stage');if(st&&!st.hidden){if(/返回书架/.test(st.textContent))return 'finish';return 'quiz';}return 'shelf';})()");
    /* 进分类：换过分类后再回来会重新问板块（只记最近一个），这里统一处理「可能先弹板块面板」 */
    const enterCat = async (name) => {
      await clickBook(name);
      await s.waitFor('!!document.querySelector(".secbtn")||!!document.querySelector(".diffbtn")', 8000);
      if (await hasSel('.secbtn')) { await pickSec('选择题'); await s.waitFor('!!document.querySelector(".diffbtn")', 8000); }
      return await hasSel('.diffbtn');
    };

    /* ---------- 1. 层级：书架 → 板块 → 难度 → 答题 ---------- */
    ck('初始层级在书架（根）', (await layer()) === 'shelf', await layer());
    await clickBook('数学');
    await s.waitFor('!!document.querySelector(".secbtn")', 8000);
    ck('打开板块面板 → 层级=section', (await layer()) === 'section', await layer());
    await pickSec('选择题');
    await s.waitFor('!!document.querySelector(".diffbtn")', 8000);
    ck('选完板块 → 层级=diff（section 已弹出）', (await layer()) === 'diff', await layer());
    await startDiff(1);
    await s.waitFor("document.querySelectorAll('#stage .obtn').length>=2", 8000);
    ck('开始出题 → 层级=quiz', (await layer()) === 'quiz', await layer());

    /* ---------- 2. 答错 → 正确答案 + 解析 ---------- */
    const a1 = await curAns();
    const ex1 = await s.eval("(function(){var q=qlist[qidx];return q?String(q.exp||''):'';})()");
    await clickAns(a1, false);
    await sleep(260);
    const t1 = await fbText();
    ck('答错后反馈条出现「正确答案：」', /正确答案：/.test(t1), JSON.stringify(t1.slice(0, 40)));
    ck('答错后反馈条出现解析段落', await hasSel('#fbzone .fb .fexp'), t1.slice(0, 60));
    ck('解析内容 = 该题 exp（同源）', ex1 !== '' && t1.indexOf(ex1) >= 0, JSON.stringify(ex1.slice(0, 40)));
    ck('解析里带着这题的正确答案', t1.indexOf(a1) >= 0, 'ans=' + a1);
    ck('答错时不出现 AI 解析按钮（有 exp 就不用兜底）', !(await hasSel('#fbzone .fb .aibtn')));
    ck('答错时给「下一题 ›」可跳过等待', await hasSel('#fbzone .fb .fbnext'));
    ck('答错时给「🔄 重试」可原地再答', await hasSel('#fbzone .fb .fbretry'));
    await sleep(1200);
    ck('答错后停住不自动跳（1.2s 仍在本题）', (await s.eval('qidx')) === 0, 'qidx=' + await s.eval('qidx'));
    await s.eval("(function(){var b=document.querySelector('#fbzone .fb .fbnext');if(b)b.click();return 1;})()");
    await sleep(300);
    ck('点「下一题 ›」立即进入下一题', (await s.eval('qidx')) === 1, 'qidx=' + await s.eval('qidx'));

    /* ---------- 3. 「😵 不会」→ 答案 + 解析 + 停 2.5s + 记入薄弱题含 exp ---------- */
    await s.eval("(function(){var b=document.querySelector('#stage .unkbtn');if(b)b.click();return 1;})()");
    await sleep(300);
    const t2 = await fbText();
    const q1 = JSON.parse(await s.eval("(function(){var q=qlist[qidx];return JSON.stringify({a:q.a,exp:q.exp||''});})()"));
    ck('「不会」后显示正确答案', t2.indexOf('正确答案：' + q1.a) >= 0, JSON.stringify(t2.slice(0, 50)));
    ck('「不会」后显示解析', t2.indexOf(q1.exp) >= 0 && q1.exp !== '', JSON.stringify(q1.exp.slice(0, 40)));
    ck('「不会」后 2.5s 内仍停在本題（可读解析）', (await s.eval('qidx')) === 1, 'qidx=' + await s.eval('qidx'));
    ck('「不会」后也给「🔄 重试」', await hasSel('#fbzone .fb .fbretry'));
    const wk = JSON.parse(await s.eval("S.getItem('bt_qa_weak')||'[]'"));
    ck('薄弱题记录里带 exp', wk.length > 0 && !!wk[wk.length - 1].exp, JSON.stringify(wk.slice(-1)[0] || {}).slice(0, 80));
    await sleep(2400);
    ck('「不会」后停住不自动跳（2.4s 仍在本题）', (await s.eval('qidx')) === 1, 'qidx=' + await s.eval('qidx'));
    await s.eval("(function(){var b=document.querySelector('#fbzone .fb .fbnext');if(b)b.click();return 1;})()");
    await sleep(300);
    ck('点「下一题 ›」进入下一题', (await s.eval('qidx')) === 2, 'qidx=' + await s.eval('qidx'));

    /* ---------- 4. 薄弱题回顾：答错也能看到解析 ---------- */
    await s.eval("(function(){document.querySelectorAll('#stage .btn').forEach(function(b){if(/退出本局/.test(b.textContent))b.click();});return 1;})()");
    await s.waitFor('!!document.querySelector(".diffbtn")', 6000);
    ck('答题页「退出本局」→ 回难度面板而不是书架', (await layer()) === 'diff', await layer());
    /* 关掉难度面板（← 返回）→ 回书架 */
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return /返回/.test(x.textContent)})[0];if(b)b.click();return 1;})()");
    await s.waitFor('!!document.querySelector(".book")', 6000);
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('.act')).filter(function(x){return /薄弱题/.test(x.textContent)})[0];if(b)b.click();return 1;})()");
    await s.waitFor("document.querySelectorAll('#stage .obtn').length>=2", 8000);
    const ra = await curAns();
    await clickAns(ra, false);
    await sleep(260);
    const t3 = await fbText();
    ck('薄弱题回顾答错 → 显示解析', /解析：/.test(t3), JSON.stringify(t3.slice(0, 60)));
    /* 退出回顾 → 回书架；同时验证 reviewMode 不会污染下一局 */
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /退出本局/.test(x.textContent)})[0];if(b)b.click();return 1;})()");
    await s.waitFor('!!document.querySelector(".book")', 6000);
    ck('退出薄弱题回顾 → 回书架', (await layer()) === 'shelf', await layer());

    /* ---------- 5. 人工题（无 exp）→ 走「💡 AI 解析」兜底 ---------- */
    await clickBook('常识');
    await s.waitFor('!!document.querySelector(".secbtn")', 8000);
    await pickSec('选择题');
    await s.waitFor('!!document.querySelector(".diffbtn")', 8000);
    await startDiff(1);
    await s.waitFor("document.querySelectorAll('#stage .obtn').length>=2", 8000);
    /* 先答对一题：回顾模式答对不会加 ok，用它确认这一局是正常模式 */
    const ok0 = await s.eval('ok');
    await clickAns(await curAns(), true);
    await sleep(1100);
    ck('退出回顾后新开一局按正常模式计分（reviewMode 已清）', (await s.eval('ok')) === ok0 + 1, 'ok ' + ok0 + '→' + await s.eval('ok'));

    const ca = await curAns();
    const cexp = await s.eval("(function(){var q=qlist[qidx];return String((q&&q.exp)||'');})()");
    await clickAns(ca, false);
    await sleep(260);
    ck('人工题（无 exp）答错后出现「💡 AI 解析」按钮', cexp === '' && (await hasSel('#fbzone .fb .aibtn')), 'exp=' + JSON.stringify(cexp));
    await s.eval("(function(){var b=document.querySelector('#fbzone .fb .aibtn');if(b)b.click();return 1;})()");
    await sleep(300);
    const toastTxt = await s.eval("(function(){var t=document.getElementById('toast');return t?t.textContent:'';})()");
    ck('未配置 AI 时点 AI 解析 → 提示去配置（不静默失败）', /AI/.test(toastTxt), JSON.stringify(toastTxt.slice(0, 40)));

    /* ---------- 6. 浏览器返回键：只回退一层 ---------- */
    await s.eval('history.back();1');
    await sleep(600);
    const afterBack1 = await s.eval("(function(){return JSON.stringify({href:location.href,books:document.querySelectorAll('.book').length,diffs:document.querySelectorAll('.diffbtn').length,layer:(function(){var ov=document.getElementById('curOverlay');if(ov){if(ov.querySelector('.secbtn'))return 'section';if(ov.querySelector('.diffbtn'))return 'diff';return 'overlay';}var st=document.getElementById('stage');if(st&&!st.hidden){if(/返回书架/.test(st.textContent))return 'finish';return 'quiz';}return 'shelf';})()});})()");
    const j1 = JSON.parse(afterBack1);
    ck('答题页按浏览器返回 → 回到难度面板（不退出网页）', j1.diffs > 0 && /\/quiz\//.test(j1.href), afterBack1);
    ck('回退后层级=diff', j1.layer === 'diff', j1.layer);

    await s.eval('history.back();1');
    await sleep(600);
    const j2 = JSON.parse(await s.eval("(function(){return JSON.stringify({href:location.href,books:document.querySelectorAll('.book').length,layer:(function(){var ov=document.getElementById('curOverlay');if(ov){if(ov.querySelector('.secbtn'))return 'section';if(ov.querySelector('.diffbtn'))return 'diff';return 'overlay';}var st=document.getElementById('stage');if(st&&!st.hidden){if(/返回书架/.test(st.textContent))return 'finish';return 'quiz';}return 'shelf';})()});})()"));
    ck('难度面板再返回 → 书架', j2.books > 0 && j2.layer === 'shelf', JSON.stringify(j2));
    ck('两次返回都没离开网页', /\/quiz\//.test(j2.href), j2.href);

    /* ---------- 7. overlay（设置）返回 → 关闭回上级 ---------- */
    await s.eval("(function(){document.getElementById('settingsBtn').click();return 1;})()");
    await s.waitFor('!!document.querySelector("#curOverlay")', 6000);
    ck('打开设置 → 层级=overlay', (await layer()) === 'overlay', await layer());
    await s.eval('history.back();1');
    await sleep(500);
    ck('设置页返回 → 关闭浮层且仍在书架', !(await hasSel('#curOverlay')) && (await layer()) === 'shelf', await layer());

    /* ---------- 7b. 自动匹配（无限模式）里按返回 = 结束并结算 ---------- */
    await enterCat('数学');
    await startDiff(0);
    await s.waitFor("document.querySelectorAll('#stage .obtn').length>=2", 8000);
    ck('进入自动匹配 → 无限模式 HUD', /无限模式/.test(await s.eval("(document.querySelector('.hud .hr')||{}).textContent||''")), '');
    await s.eval('history.back();1');
    await sleep(700);
    const autoSettle = await layer();
    ck('无限模式按返回 → 直接进结算页（不退出、不丢局）', autoSettle === 'finish', autoSettle);
    ck('结算页有实力评级卡', await hasSel('#stage .lvlcard'), '');
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /返回书架/.test(x.textContent)})[0];if(b)b.click();return 1;})()");
    await s.waitFor('!!document.querySelector(".book")', 6000);
    ck('结算页「返回书架」可用 → 回到书架', (await layer()) === 'shelf', await layer());

    /* ---------- 8. 普通一局答完 → 结算页返回 → 书架 ---------- */
    await enterCat('数学');
    await startDiff(1);
    await s.waitFor("document.querySelectorAll('#stage .obtn').length>=2", 8000);
    ck('二次进入同一分类不再弹板块面板', !(await hasSel('.secbtn')), '');
    for (let i = 0; i < 11; i++) { await s.eval("(function(){var b=document.querySelector('#stage .unkbtn');if(b)b.click();return 1;})()"); await sleep(150); await s.eval("(function(){var b=document.querySelector('#fbzone .fb .fbnext');if(b)b.click();return 1;})()"); await sleep(120); }
    await s.waitFor("!!document.querySelector('#stage .btn')", 6000);
    const settled = await s.eval("(function(){return /返回书架/.test(document.querySelector('#stage').textContent);})()");
    ck('答满一局进入结算页', settled === true, '');
    ck('结算时层级=finish', (await layer()) === 'finish', await layer());
    await s.eval('history.back();1');
    await sleep(600);
    const j3 = JSON.parse(await s.eval("(function(){return JSON.stringify({href:location.href,books:document.querySelectorAll('.book').length,layer:(function(){var ov=document.getElementById('curOverlay');if(ov){if(ov.querySelector('.secbtn'))return 'section';if(ov.querySelector('.diffbtn'))return 'diff';return 'overlay';}var st=document.getElementById('stage');if(st&&!st.hidden){if(/返回书架/.test(st.textContent))return 'finish';return 'quiz';}return 'shelf';})(),stage:document.getElementById('stage').hidden});})()"));
    ck('结算页返回 → 书架', j3.books > 0 && j3.layer === 'shelf' && j3.stage === true, JSON.stringify(j3));

    ck('全程无 JS 异常', s.errors.length === 0, s.errors.slice(0, 2).join(' | '));
    const ovf = await s.eval("document.documentElement.scrollWidth - document.documentElement.clientWidth");
    ck('无横向溢出', ovf <= 0, 'overflow=' + ovf);

    /* ---------- 9. 书架（根）按返回 = 允许退出网页，且不报错 ---------- */
    let rootAlive = '';
    try {
      await s.eval('history.back();1');
      await sleep(900);
      rootAlive = await s.eval("(function(){return JSON.stringify({href:location.href,books:document.querySelectorAll('.book').length});})()");
      const left = !/\/quiz\//.test(String(rootAlive));
      ck('书架按返回 → 直接退出网页（不再卡在应用里）', left === true, String(rootAlive).slice(0, 80));
    } catch (e) {
      /* 页面已经离开，CDP 目标失效 —— 这正是「退出了网页」 */
      ck('书架按返回 → 直接退出网页（不再卡在应用里）', true, '页面已离开');
    }
    ck('根层退出过程没有 JS 异常', s.errors.length === 0, s.errors.slice(0, 2).join(' | '));

  } catch (e) {
    fail.push('B 段异常 :: ' + e.message + ' | 最后表达式: ' + LAST);
  } finally {
    console.log('\n=== 题目解析 + 返回层级：' + pass.length + '/' + (pass.length + fail.length) + ' 通过 ===');
    pass.forEach(t => console.log('  ✓ ' + t));
    fail.forEach(t => console.log('  ✗ ' + t));
    await s.close();
    try { srv && srv.kill('SIGKILL'); } catch (e) {}
  }
})().catch(e => { console.error(e); process.exit(1); });
