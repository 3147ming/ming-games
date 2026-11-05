/* 无限自适应 + 三板块（选择 / 程序编写 / 填空）专项探针
   A 段：Node vm 直接跑引擎（板块出题 / 手写题库 / 答案是否参数化）
   B 段：无头 Edge 跑真实页面（板块面板 / 无限模式 / 实力评级卡 / 代码块 / 填空判分） */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');
const { Session, sleep } = require('./cdp.cjs');
const { step } = require('./pace.cjs');

const DIR = __dirname;
const PORT = 8867;
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
var CODE_PROFILE_KEY='bt_qa_profile_code';
`;
  const ctx = { console, JSON, Math, Date, parseInt, parseFloat, String, Number, Array, Object, RegExp, isFinite, isNaN, setTimeout, clearTimeout };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(prelude + '\n' + core + '\n' + block + '\n', ctx, { filename: 'engine.js' });
  return ctx;
}

function layerA() {
  const E = boot();
  const run = (code) => vm.runInContext(code, E);
  const sec = (n, d) => JSON.parse(run(`JSON.stringify(QA_TYPES.code.genSection(${n},${d}))`));

  /* 1. 五档都有读代码题型（知识点×难度矩阵） */
  const per = [];
  for (let d = 0; d < 5; d++) {
    const g = run(`CODE_TOPICS.filter(function(t){return t.ranks.indexOf(${d})>=0;}).length`);
    per.push(d + ':' + g);
    if (g < 4) fail.push(`L${d} 知识点只有 ${g} 个`);
  }
  ck('五档各 ≥4 个读代码知识点', per.every(s => Number(s.split(':')[1]) >= 4), per.join(' '));

  /* 2. 每档出 10 题：数量 / 去重 / 选项 / 答案 */
  const bad = [];
  for (let d = 0; d < 5; d++) {
    run("(function(){S.removeItem('bt_qa_profile_code');return 1;})()");
    const qs = sec(10, d);
    if (qs.length !== 10) bad.push(`L${d} 只出 ${qs.length} 题`);
    if (new Set(qs.map(x => x.q + '\u0001' + (x.code || ''))).size !== qs.length) bad.push(`L${d} 同局重题`);
    qs.forEach(q => {
      if (!q.q) bad.push(`L${d} 空题干`);
      if (q.a == null || q.a === '') bad.push(`L${d} 空答案「${q.q}」`);
      if (q.opts) {
        if (q.opts.length !== 4) bad.push(`L${d} 选项数=${q.opts.length}「${q.q}」`);
        if (new Set(q.opts).size !== 4) bad.push(`L${d} 选项重复「${q.q}」`);
        if (q.opts.indexOf(String(q.a)) < 0) bad.push(`L${d} 答案不在选项「${q.q}」`);
      }
      if (/undefined|NaN|\[object/.test(String(q.q) + String(q.a) + (q.opts || []).join(''))) bad.push(`L${d} 脏数据「${q.q}」`);
    });
  }
  ck('五档各出 10 题：不重复、答案在选项内、无脏数据', bad.length === 0, bad.slice(0, 4).join(' ; '));

  /* 3. 两类题型都在（输出预测 / 代码补全） */
  const kinds = {};
  for (let d = 0; d < 5; d++) {
    const qs = sec(10, d);
    qs.forEach(q => { kinds[q.kind] = (kinds[q.kind] || 0) + 1; });
  }
  ck('输出预测题与代码补全题都存在', (kinds.out || 0) > 0 && (kinds.fill || 0) > 0, JSON.stringify(kinds));
  const noCode = [];
  for (let d = 0; d < 5; d++) sec(10, d).forEach(q => { if (!q.code) noCode.push('L' + d + '「' + q.q + '」'); });
  ck('所有程序编写题都带代码块', noCode.length === 0, noCode.slice(0, 3).join(' ; '));

  /* 4. 答案由参数算出（不是写死）：同档连出 60 题，答案种类足够多 */
  const variety = [];
  for (let d = 0; d < 5; d++) {
    const set = new Set();
    for (let i = 0; i < 6; i++) sec(10, d).forEach(q => set.add(String(q.a)));
    variety.push('L' + d + ':' + set.size);
  }
  ck('同档连出 60 题答案 ≥6 种（证明是当场算出来的）', variety.every(s => Number(s.split(':')[1]) >= 6), variety.join(' '));

  /* 5. 语言过滤：只勾 Python 时不出 C 题 */
  run("S.setItem('bt_qa_profile_code',JSON.stringify({done:true,langs:['python'],level:0,rank:0}));");
  const onlyPy = sec(10, 2);
  const mixTag = onlyPy.filter(q => q.tag && q.tag !== 'python' && q.tag !== 'all');
  ck('只勾 Python 时不出其他语言题', mixTag.length === 0 && onlyPy.length === 10, mixTag.map(q => q.tag).join(',') + ' n=' + onlyPy.length);
  /* 只勾 SQL（没有专项题型）也要能凑满 */
  run("S.setItem('bt_qa_profile_code',JSON.stringify({done:true,langs:['sql'],level:0,rank:0}));");
  const onlySql = sec(10, 3);
  ck('只勾 SQL 时用通用题补齐（不空题）', onlySql.length === 10, 'n=' + onlySql.length);
  /* 块 5.2 新口径：语言无关补池已删除，c 档案三板块五档不得出现任何越界 tag */
  run("S.setItem('bt_qa_profile_code',JSON.stringify({done:true,langs:['c'],level:0,rank:0}));");
  let badTag = 0, emptySec = 0;
  ['choice', 'fill', 'code'].forEach(function (sec) {
    for (let d = 0; d < 5; d++) {
      const g = JSON.parse(run(`JSON.stringify(QA_TYPES.code.genSection(10,${d},'${sec}'))`));
      if (!g.length) emptySec++;
      g.forEach(q => { const t = String(q.tag || 'all'); if (t !== 'c' && t !== 'all')badTag++; });
    }
  });
  ck('c 档案 · 三板块五档越界 tag = 0', badTag === 0, 'badTag=' + badTag);
  ck('c 档案 · 三板块五档无空局', emptySec === 0, 'empty=' + emptySec);
  run("S.setItem('bt_qa_profile_code',JSON.stringify({done:true,all:true,langs:[],level:0,rank:0}));");
  const allHit = {};
  for (let d = 0; d < 5; d++) sec(10, d).forEach(q => { const t = String(q.tag || 'all'); allHit[t] = (allHit[t] || 0) + 1; });
  ck('all 档案 · 其它语言题仍可出', (allHit.python || 0) > 0 || (allHit.java || 0) > 0, JSON.stringify(allHit));
  run("S.removeItem('bt_qa_profile_code');");

  /* 6. 手写题库 */
  const tasks = JSON.parse(run('JSON.stringify(CODE_TASKS)'));
  const byRank = [0, 0, 0, 0, 0];
  tasks.forEach(t => { if (t.r >= 0 && t.r < 5) byRank[t.r]++; });
  ck('手写题库覆盖 5 档且每档 ≥1 题', byRank.every(n => n >= 1), byRank.join('/'));
  ck('手写题库 50 道（C 25 + JS 25）且都带 lang', tasks.length === 50 && tasks.every(t => t.lang === 'c' || t.lang === 'js'),
    'n=' + tasks.length + ' c=' + tasks.filter(t => t.lang === 'c').length + ' js=' + tasks.filter(t => t.lang === 'js').length);
  ck('手写题都带题面 / 样例 / 要点', tasks.every(t => t.t && t.ex && t.tip), '');
  const handTags = [];
  for (let d = 0; d < 5; d++) {
    const h = JSON.parse(run(`JSON.stringify(genHandTask(${d}))`));
    if (!h.hand || !h.task || h.opts !== null || !h.q) handTags.push('L' + d);
    if (h.task.r !== d) handTags.push('L' + d + ' 取到 r=' + h.task.r);
  }
  ck('genHandTask 按档取材且是手写题结构', handTags.length === 0, handTags.join(','));

  /* 7. 手写题不进薄弱题（结构上 a 是占位符，不能当答案） */
  const placeholder = JSON.parse(run('JSON.stringify(genHandTask(0).a)'));
  ck('手写题答案标记为 AI 评判占位', placeholder === '（AI 评判）', String(placeholder));
}

(async () => {
  try { layerA(); } catch (e) { fail.push('A 段异常 :: ' + e.message + '\n' + (e.stack || '').split('\n')[1]); }

  const srv = USE_LOCAL ? spawn(process.execPath, [path.join(DIR, 'serve.cjs'), String(PORT)], { stdio: 'ignore' }) : null;
  if (USE_LOCAL) await sleep(700);
  const s = new Session({ width: 414, height: 896, port: 9367 });
  try {
    await s.open(APP);
    await s.eval("localStorage.setItem('bt_qa_quickjump','true');1");
    await s.waitFor('!!document.querySelector(".book")', 15000);
    await s.ensureLoaded();   // 线上先验文档完整性（抓包代理会截断 HTML）
    await s.eval("(function(){try{return navigator.serviceWorker.getRegistrations().then(function(rs){return Promise.all(rs.map(function(r){return r.unregister();}));});}catch(e){return 1;}})()");
    await s.eval("localStorage.setItem('bt_qa_profile_code', JSON.stringify({done:true,skipped:true,langs:[],level:0,rank:0}));1");
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);
    await s.eval('window.confirm=function(){return true;};window.alert=function(){};1');

    const clickBook = (name) => s.eval("(function(){var bs=document.querySelectorAll('.book');for(var i=0;i<bs.length;i++){if(bs[i].textContent.indexOf(" + JSON.stringify(name) + ")>=0){bs[i].click();return 1;}}return 0;})()");
    const secBtns = () => s.eval("(function(){return [].slice.call(document.querySelectorAll('.secbtn .dn')).map(function(x){return x.textContent;}).join('|');})()");
    const pickSec = (kw) => s.eval("(function(){var bs=[].slice.call(document.querySelectorAll('.secbtn'));for(var i=0;i<bs.length;i++){if(bs[i].textContent.indexOf(" + JSON.stringify(kw) + ")>=0){bs[i].click();return 1;}}return 0;})()");
    /* 当前题的真实答案 / 实力档 / HUD 标签（qlist、qidx、selfRank 都是顶层 var，探测得到） */
    const curAns = () => s.eval("(function(){var q=qlist[qidx];return q?String(q.a==null?'':q.a):'';})()");
    const hudLvl = () => s.eval("(function(){var x=document.querySelector('.hud .hl');return x?x.textContent:'';})()");
    /* 档位不读内部变量（IIFE 作用域在不同加载路径下可能拿不到），直接从 HUD 档名解析 */
    const rankOf = async () => { const t = await hudLvl(); return ['小学', '初中', '高中', '大学'].findIndex((x) => t.indexOf(x) >= 0); };
    /* 按 want=true 点正确项 / want=false 点错误项；填空则写值后点提交 */
    const clickAns = (v, want) => s.eval("(function(){var v=" + JSON.stringify(v) + ",want=" + (want ? 1 : 0) + ";var bs=[].slice.call(document.querySelectorAll('#stage .obtn'));if(bs.length){for(var i=0;i<bs.length;i++){var t=bs[i].textContent.trim();if(want?(t===v):(t!==v)){bs[i].click();return 1;}}return 0;}var inp=document.querySelector('#stage input[type=text]');if(inp){inp.value=want?v:'__不可能答对的答案__';var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /^提交$/.test(x.textContent.trim())})[0];if(b){b.click();return 2;}}return -1;})()");

    /* ---------- 1. 数学：板块面板只有两个（无程序编写） ---------- */
    await clickBook('数学');
    await s.waitFor('!!document.querySelector(".secbtn")', 8000);
    const mSec = await secBtns();
    ck('非编程分类的板块面板只有选择题 + 填空题', mSec.split('|').length === 2 && /选择题/.test(mSec) && /填空题/.test(mSec), mSec);
    ck('非编程分类不出现「程序编写」', !/程序编写/.test(mSec), mSec);

    await pickSec('选择题');
    await s.waitFor('!!document.querySelector(".diffbtn")', 8000);
    const mDiff = await s.eval("document.querySelectorAll('.diffbtn').length");
    ck('选完板块进入难度面板（自动 + 4 学业阶段）', mDiff === 5, 'diffbtns=' + mDiff);

    /* ---------- 2. 自动匹配 = 无限模式 ---------- */
    await s.eval("(function(){document.querySelectorAll('.diffbtn')[0].click();var go=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return /开始出题/.test(x.textContent)})[0];go.click();return 1})()");
    await s.waitFor("document.querySelectorAll('#stage .obtn').length>=2", 8000);
    const inf = JSON.parse(await s.eval("JSON.stringify({hud:(document.querySelector('.hud')||{}).textContent||'',inf:/inf/.test((document.querySelector('.pbar')||{}).className||''),sec:/选择题/.test((document.querySelector('.chip.sec')||{}).textContent||'')})"));
    ck('自动匹配进入无限模式（HUD 标注）', /无限模式/.test(inf.hud), inf.hud.slice(0, 60));
    ck('无限模式进度条为流动满格', inf.inf === true, 'pbar class inf=' + inf.inf);
    ck('HUD 显示当前板块徽标', inf.sec === true, inf.hud.slice(0, 40));

    /* 连答 4 题仍在答题页（不被 10 题上限结算） */
    for (let i = 0; i < 4; i++) {
      await s.eval("(function(){var b=document.querySelector('#stage .obtn');if(b)b.click();return 1})()");
      await sleep(140);
      await step(s);
    }
    const still = await s.eval("!!document.querySelector('#stage .obtn')");
    const nNow = await s.eval("(function(){var h=(document.querySelector('.hud .hr')||{}).textContent||'';return h;})()");
    ck('答了 4 题仍在答题页（没有 10 题上限）', still === true, nNow);
    ck('进度显示「第 N 题 · 无限模式」', /第 5 题 · 无限模式/.test(nNow), nNow);

    /* ---------- 3. 随时退出 → 结算 + 实力评级卡 ---------- */
    await s.eval("(function(){var bs=[].slice.call(document.querySelectorAll('#stage .btn'));var b=bs.filter(function(x){return /结束并结算/.test(x.textContent)})[0];if(b)b.click();return 1})()");
    await s.waitFor("!!document.querySelector('.lvlcard')", 6000);
    const lv = await s.eval("(function(){var c=document.querySelector('.lvlcard');return c?c.textContent:'';})()");
    ck('退出后进入结算并显示实力评级卡', /当前实力/.test(lv), lv.slice(0, 60));
    ck('评级卡含题数与正确率', /做了 \d+ 题/.test(lv) && /正确率/.test(lv), lv.slice(0, 80));

    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /返回书架/.test(x.textContent)})[0];if(b)b.click();return 1})()");
    await s.waitFor('!!document.querySelector(".book")', 8000);

    /* ---------- 4. 同分类二次进入不再弹板块 ---------- */
    await clickBook('数学');
    await s.waitFor('!!document.querySelector(".diffbtn")', 8000);
    const again = await s.eval("JSON.stringify({sec:document.querySelectorAll('.secbtn').length,diff:document.querySelectorAll('.diffbtn').length})");
    const ag = JSON.parse(again);
    ck('同一分类二次进入不再弹板块面板', ag.sec === 0 && ag.diff === 5, again);
    await s.eval("(function(){var b=document.querySelector('#curOverlay .close');if(b)b.click();return 1})()");
    await s.waitFor('!!document.querySelector(".book")', 6000);

    /* ---------- 5. 填空题：输入框作答 + 判分 ---------- */
    await clickBook('历史');
    await s.waitFor('!!document.querySelector(".secbtn")', 8000);
    const hSec = await secBtns();
    ck('历史分类也只给两个板块', hSec.split('|').length === 2, hSec);
    await pickSec('填空题');
    await s.waitFor('!!document.querySelector(".diffbtn")', 8000);
    await s.eval("(function(){document.querySelectorAll('.diffbtn')[0].click();var go=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return /开始出题/.test(x.textContent)})[0];go.click();return 1})()");
    await s.waitFor("!!document.querySelector('#stage input[type=text]')", 8000);
    const fq = JSON.parse(await s.eval("JSON.stringify({opt:document.querySelectorAll('#stage .obtn').length,input:!!document.querySelector('#stage input[type=text]'),q:(document.querySelector('.qbox')||{}).textContent||''})"));
    ck('填空板块不给选项，只有输入框', fq.opt === 0 && fq.input === true, JSON.stringify(fq).slice(0, 80));
    /* 拿真实答案填空：直接读题目的 a（探针内部用 qlist 不可达，改为点「不会」验证流程） */
    await s.eval("(function(){var i=document.querySelector('#stage input[type=text]');i.value='__错答案__';var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /^提交$/.test(x.textContent.trim())})[0];if(b)b.click();return 1})()");
    await s.waitFor("!!document.querySelector('#stage .fb')", 5000);
    const ffb = await s.eval("(document.querySelector('#stage .fb')||{}).textContent||''");
    ck('填空题答错给出正确答案反馈', /正确答案/.test(ffb), ffb.slice(0, 50));

    /* 数学填空题：正确答案可以被算出来（fillEqual 数值容错） */
    await sleep(900);
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /退出本局/.test(x.textContent)})[0];if(b)b.click();return 1})()");
    await s.waitFor('!!document.querySelector(".book")', 6000);
    await clickBook('数学');
    await s.waitFor('!!document.querySelector(".secbtn")', 6000);
    await pickSec('填空题');
    await s.waitFor('!!document.querySelector(".diffbtn")', 8000);
    await s.eval("(function(){document.querySelectorAll('.diffbtn')[1].click();var go=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return /开始出题/.test(x.textContent)})[0];go.click();return 1})()");
    await s.waitFor("!!document.querySelector('#stage input[type=text]')", 8000);
    const expr = await s.eval("(document.querySelector('.qbox')||{}).textContent||''");
    const m = String(expr).match(/(\d+)\s*([+\-−×÷])\s*(\d+)\s*=\s*\?/);
    let ansVal = null;
    if (m) {
      const a = Number(m[1]), b = Number(m[3]);
      ansVal = m[2] === '+' ? a + b : m[2] === '−' ? a - b : m[2] === '×' ? a * b : (a / b);
    }
    ck('数学填空题题面可解析（a op b = ?）', ansVal != null, String(expr).slice(0, 40));
    if (ansVal != null) {
      await s.eval("(function(){var i=document.querySelector('#stage input[type=text]');i.value=" + JSON.stringify(String(ansVal)) + ";var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /^提交$/.test(x.textContent.trim())})[0];if(b)b.click();return 1})()");
      await s.waitFor("!!document.querySelector('#stage .fb')", 5000);
      const okFb = await s.eval("(document.querySelector('#stage .fb')||{}).textContent||''");
      ck('填空题答对判为正解', /答对|正确/.test(okFb) && !/正确答案/.test(okFb), okFb.slice(0, 40) + ' | 答案 ' + ansVal);
    } else { fail.push('填空题数值判分 :: 题面不可解析'); }

    await sleep(900);
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /退出本局/.test(x.textContent)})[0];if(b)b.click();return 1})()");
    await s.waitFor('!!document.querySelector(".book")', 6000);

    /* ---------- 6. 编程：三板块 + 代码题 + 手写开关 ---------- */
    await clickBook('编程');
    await s.waitFor('!!document.querySelector(".secbtn")', 8000);
    const cSec = await secBtns();
    ck('编程分类给出三个板块', cSec.split('|').length === 3 && /程序编写/.test(cSec), cSec);
    await pickSec('程序编写');
    await s.waitFor('!!document.querySelector(".diffbtn")', 8000);
    const cd = await s.eval("document.querySelectorAll('.diffbtn').length");
    ck('程序编写板块仍走五档难度面板', cd === 6, 'diffbtns=' + cd);
    await s.eval("(function(){document.querySelectorAll('.diffbtn')[3].click();var go=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return /开始出题/.test(x.textContent)})[0];go.click();return 1})()");
    await s.waitFor("!!document.querySelector('#stage .codeblk')", 8000);
    const cq = JSON.parse(await s.eval("JSON.stringify({code:!!document.querySelector('#stage .codeblk'),txt:(document.querySelector('#stage .codeblk')||{}).textContent||'',hud:(document.querySelector('.hud')||{}).textContent||'',opt:document.querySelectorAll('#stage .obtn').length,mono:(function(){var p=document.querySelector('#stage .codeblk');if(!p)return '';return getComputedStyle(p).fontFamily;})()})"));
    cq.ws = await s.eval("(function(){var p=document.querySelector('#stage .codeblk');return p?getComputedStyle(p).whiteSpace:'';})()");
    ck('程序编写题渲染代码块（等宽字体，保留换行）', cq.code === true && /mono|Consolas|Menlo|Courier/i.test(cq.mono), cq.mono);
    /* 单行代码题（如 printf("%d", 5 | 7)）确实存在，不能拿当前这一题判「多行」；
       改为判渲染层是否保留换行 + 题库里确实有多行题 */
    ck('代码块 CSS 保留换行（white-space: pre*）', /pre/.test(cq.ws), cq.ws);
    const multi = await s.eval("(function(){var qs=QA_TYPES.code.genSection(8,2,'code');var m=0;qs.forEach(function(q){if(q.code&&q.code.indexOf(String.fromCharCode(10))>=0)m++;});return m;})()");
    ck('程序编写题库抽样 8 题里有 ≥2 道多行代码题', multi >= 2, 'multi=' + multi);
    ck('HUD 标注「⌨️ 程序编写」', /程序编写/.test(cq.hud), cq.hud.slice(0, 50));
    ck('程序编写题有 4 个选项或填空输入', cq.opt === 4 || cq.opt === 0, 'opt=' + cq.opt);

    /* 本地判分：答对 → 「答对」；答错 → 给「正确答案」（全程不联网、不调 AI） */
    const cA1 = await curAns();
    const hitR = await clickAns(cA1, true);
    await s.waitFor("!!document.querySelector('#stage .fb')", 5000);
    const fbR = await s.eval("(document.querySelector('#stage .fb')||{}).textContent||''");
    ck('程序编写题本地判分：答对给出正解反馈', hitR >= 1 && /答对/.test(fbR), 'hit=' + hitR + ' ans=' + cA1 + ' fb=' + fbR.slice(0, 36));
    await sleep(1000);
    const cA2 = await curAns();
    const hitW = await clickAns(cA2, false);
    await s.waitFor("!!document.querySelector('#stage .fb')", 5000);
    const fbW = await s.eval("(document.querySelector('#stage .fb')||{}).textContent||''");
    ck('程序编写题本地判分：答错给出正确答案', hitW >= 1 && /正确答案/.test(fbW), 'hit=' + hitW + ' ans=' + cA2 + ' fb=' + fbW.slice(0, 36));

    /* 手写开关：未配 AI 时点了只提示，不切换 */
    await s.eval("(function(){var t=document.querySelector('#stage .toggle');if(t)t.click();return 1})()");
    await sleep(350);
    const tg = JSON.parse(await s.eval("JSON.stringify({txt:(document.querySelector('#stage .toggle')||{}).textContent||'',toast:(document.querySelector('#toast')||{}).textContent||'',cls:(document.querySelector('#stage .toggle')||{}).className||''})"));
    ck('未配置 AI 时手写开关保持关闭并给出提示', /关/.test(tg.txt) && !/on/.test(tg.cls) && /AI/.test(tg.toast), JSON.stringify(tg).slice(0, 90));

    /* 溢出 / 异常 */
    const ov = await s.eval("document.documentElement.scrollWidth<=window.innerWidth+1");
    ck('程序编写页无横向溢出', ov === true, String(ov));
    const errs = s.errors.filter(e => !/favicon|sw\.js|SW /i.test(e));
    ck('无 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));
    /* ---------- 7. 自适应升降档（近 12 题滑动窗口） ---------- */
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /退出本局/.test(x.textContent)})[0];if(b)b.click();return 1})()");
    await s.waitFor('!!document.querySelector(".book")', 8000);
    /* 不 reload（线上 SW 接管期 reload 不稳定）：按真实用户路径逐层退出回书架 */
    for (let i = 0; i < 4; i++) {
      if (await s.eval("!!document.querySelector('.book')")) break;
      await s.eval('history.back();1');
      await sleep(700);
    }
    await s.waitFor('!!document.querySelector(".book")', 15000);
    await clickBook('数学');
    await s.waitFor('!!document.querySelector(".secbtn")||!!document.querySelector(".diffbtn")', 12000);
    if (await s.eval("!!document.querySelector('.secbtn')")) {
      await pickSec('选择题');
      await s.waitFor('!!document.querySelector(".diffbtn")', 12000);
    }
    await s.eval("(function(){document.querySelectorAll('.diffbtn')[0].click();var go=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return /开始出题/.test(x.textContent)})[0];go.click();return 1})()");
    await s.waitFor("document.querySelectorAll('#stage .obtn').length>=2", 8000);
    const r0 = await rankOf();
    const l0 = await hudLvl();
    for (let i = 0; i < 8; i++) {
      const a = await curAns();
      await clickAns(a, true);
      await sleep(140);
      await step(s);
    }
    const r1 = await rankOf();
    const l1 = await hudLvl();
    const maxD = await s.eval('QA_TYPES.math.diffs.length-1');
    /* C7：窗口升档已删除，升档只走「连对 3 题 → 升档挑战」，一次最多 +2 */
    ck('自动匹配连答 8 对 → 升档只走挑战、一次最多 +2', r1 === Math.min(r0 + 2, maxD), 'rank ' + r0 + '→' + r1 + '（max ' + maxD + '）');
    ck('升档后 HUD 实力标签同步变化', l1 !== l0 && /实力/.test(l1), JSON.stringify([l0, l1]));
    /* 窗口语义：答错一题不该升档（曾出现「连对 8 题后答错反而升档」） */
    const aMid = await curAns();
    await clickAns(aMid, false);
    await sleep(140);
    await step(s);
    const rMid = await rankOf();
    ck('窗口语义：答错一题不会升档', rMid === r1, 'rank ' + r1 + '→' + rMid);
    for (let i = 0; i < 9; i++) {
      const a = await curAns();
      await clickAns(a, false);
      await sleep(140);
      await step(s);
    }
    const r2 = await rankOf();
    /* C7：降档仍走窗口（正确率 ≤40% + 冷却 2 题），10 连错只降一档，不会一路跌到底 */
    ck('连答 10 错 → 只靠窗口降档，且冷却挡住连跌（只降一档）', r2 === r1 - 1, 'rank ' + r1 + '→' + r2);
    const saved = await s.eval("localStorage.getItem('bt_qa_rank_math')");
    ck('实力档位跨会话落地（bt_qa_rank_*）', String(saved) === String(r2), 'saved=' + saved + ' rank=' + r2);
    const stillAuto = await s.eval("/无限模式/.test((document.querySelector('.hud .hr')||{}).textContent||'')");
    ck('自适应过程中始终是无限模式', stillAuto === true, String(stillAuto));

  } catch (e) {
    fail.push('B 段异常 :: ' + e.message);
  } finally {
    console.log('\n=== 无限自适应 + 三板块：' + pass.length + '/' + (pass.length + fail.length) + ' 通过 ===');
    pass.forEach(t => console.log('  ✓ ' + t));
    fail.forEach(t => console.log('  ✗ ' + t));
    await s.close();
    try { srv && srv.kill('SIGKILL'); } catch (e) {}
  }
})().catch(e => { console.error(e); process.exit(1); });
