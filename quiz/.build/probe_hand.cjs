/* 手写题扩量 + 手写题解析 + AI 出题中文 / 英文题拦截 / 解析带翻译 专项探针
   A. 题库静态校验：50 道（JS 25 + C 25）、每档 ≥5 道、C 题 25 道且每档 5 道、
      C 参考代码可编译且缩进 4 空格、15 道新题在库、genHandTask 全带「要点+样例」
   B. 英文题判定 isEnglishQ：英文题干/成句英文选项要滤，中文题干夹英文术语不能误杀
   C. 手写题刷题：一局里能抽到 ≥4 种不同题面（不再只有 sum/MAX），「不会」时给出要点解析
   D. 手写题 AI 判错 → 反馈条给解析 + 下一题，且不给「重试」
   E. 存量英文题点「AI 解析」→ 先给「💬 译文」再给「💡 解析」
   F. AI 出题 prompt 置顶中文约束；返回里混入的英文题被过滤，不进题库
   G. 全程无 JS 异常、无横向溢出
   依赖 fetch 桩（不真联网），本地与线上都能跑。 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { Session, sleep } = require('./cdp.cjs');

const PORT = 8859;
const APP = process.argv[2] || ('http://127.0.0.1:' + PORT + '/quiz/');
const USE_LOCAL = !process.argv[2];
const BUILD = __dirname;
const pass = [], fail = [];
function ck(n, c, e) { (c ? pass : fail).push(n + (e ? ' :: ' + e : '')); }

/* ================= A/B：Node 侧静态校验 ================= */
function nodeChecks() {
  const core = fs.readFileSync(path.join(BUILD, 'engine_core.js'), 'utf8');
  const ce = fs.readFileSync(path.join(BUILD, 'code_engine.js'), 'utf8');
  const ui = fs.readFileSync(path.join(BUILD, 'quiz-ui.js'), 'utf8');
  const ctx = { console, JSON, Math, Date, parseInt, parseFloat, String, Number, Array, Object, RegExp, isFinite, isNaN };
  vm.createContext(ctx);
  vm.runInContext('var __s={};var S={getItem:function(k){return __s[k]||null},setItem:function(k,v){__s[k]=v},removeItem:function(k){delete __s[k]}};'
    + "var CODE_PROFILE_KEY='bt_qa_profile_code';"
    + 'function ri(n){return Math.floor(Math.random()*n)}\n'
    + 'function shuffle(a){a=a.slice();for(var i=a.length-1;i>0;i--){var j=Math.floor(Math.random()*(i+1)),t=a[i];a[i]=a[j];a[j]=t;}return a;}\n'
    + core + '\n' + ce, ctx);

  const per = JSON.parse(vm.runInContext('JSON.stringify((function(){var c={};CODE_TASKS.forEach(function(t){c[t.r]=(c[t.r]||0)+1});return c;})())', ctx));
  const total = vm.runInContext('CODE_TASKS.length', ctx);
  const uniq = vm.runInContext('Object.keys(CODE_TASKS.reduce(function(m,t){m[t.t]=1;return m},{})).length', ctx);
  ck('每档手写题 ≥5 道', [0, 1, 2, 3, 4].every(r => (per[r] || 0) >= 5), JSON.stringify(per) + ' 共 ' + total + ' 道');
  ck('题目互不重复', uniq === total, uniq + '/' + total);

  /* 块 5.2：C 手写题库扩到 25 道，参考代码必须是能编译的完整 C 程序 */
  const cTasks = JSON.parse(vm.runInContext("JSON.stringify(CODE_TASKS.filter(function(t){return t.lang==='c';}))", ctx));
  const jsTasks = JSON.parse(vm.runInContext("JSON.stringify(CODE_TASKS.filter(function(t){return t.lang==='js';}))", ctx));
  ck('C 手写题 25 道', cTasks.length === 25, 'c=' + cTasks.length);
  ck('JS 手写题 25 道', jsTasks.length === 25, 'js=' + jsTasks.length);
  const cRank = [0, 0, 0, 0, 0];
  cTasks.forEach(t => { if (t.r >= 0 && t.r < 5)cRank[t.r]++; });
  ck('C 题 r0~r4 各 5 道', cRank.every(n => n === 5), cRank.join('/'));
  ck('C 题题干标注「C 语言」', cTasks.every(t => /C 语言/.test(t.t)), '');
  ck('JS 题题干标注「JavaScript」', jsTasks.every(t => /JavaScript/.test(t.t)), '');
  const compBad = cTasks.filter(t => !/#include <stdio\.h>/.test(t.sol) || !/int main\(void\)/.test(t.sol) || !/return 0;/.test(t.sol) || /\t/.test(t.sol) || /\.\.\.（省略）|伪代码/.test(t.sol)).length;
  ck('C 参考代码可编译（stdio/main/return）· 无 Tab · 无伪代码', compBad === 0, 'bad=' + compBad);
  const indBad = cTasks.filter(t => t.sol.split('\n').some(l => { const m = l.match(/^( +)/); return m && m[1].length % 4 !== 0; })).length;
  ck('C 参考代码缩进为 4 空格倍数', indBad === 0, 'bad=' + indBad);

  const NEED = ['minOf', 'absVal', 'isPositive', 'repeatStr', 'countVowels', 'factorial',
    'isPrime', 'reverseArr', 'gcd', 'firstUnique', 'mySqrt', 'longestWord',
    'mergeSorted', 'evalRPN', 'hasDupe'];
  const all = JSON.parse(vm.runInContext('JSON.stringify(CODE_TASKS.map(function(t){return t.t;}))', ctx)).join('\n');
  const miss = NEED.filter(n => all.indexOf(n) < 0);
  ck('15 道新题全部在库', miss.length === 0, miss.join(',') || ('共 ' + NEED.length + ' 个函数名'));

  let bad = 0, noSample = 0;
  for (let r = 0; r < 5; r++) {
    for (let i = 0; i < 60; i++) {
      const o = JSON.parse(vm.runInContext('JSON.stringify(genHandTask(' + r + '))', ctx));
      if (!o.exp || o.exp.indexOf('要点：') !== 0) bad++;
      if (!/样例：/.test(o.exp || '')) noSample++;
    }
  }
  ck('genHandTask 300 抽全带「要点：」解析', bad === 0, 'bad=' + bad);
  ck('解析里都带样例', noSample === 0, 'noSample=' + noSample);

  /* isEnglishQ：直接从 quiz-ui.js 抽出语言判定段求值（IIFE 里拿不到） */
  const i0 = ui.indexOf('/* 语言判定：ASCII'), i1 = ui.indexOf('/* 一句话解析');
  const M = new Function(ui.slice(i0, i1) + ';return {isEnglishQ:isEnglishQ};')();
  const CASES = [
    ['Which keyword defines a function in Python?', ['def', 'class', 'lambda', 'return'], 1, '英文题干 + 代码选项'],
    ['Explain the difference between list and tuple in Python', ['a', 'b', 'c', 'd'], 1, '整句英文题干'],
    ['What does len([]) return in Python?', ['0', '1', '2', '3'], 1, '英文题干 + 数字选项'],
    ['下列哪个是水果？', ['It is an apple', 'A kind of fruit juice drink', 'Banana milk shake', 'Fresh orange juice'], 1, '中文题干 + 成句英文选项'],
    ['Python 中，哪个关键字用于定义函数？', ['def', 'class', 'lambda', 'return'], 0, '中文题干 + 代码关键字'],
    ['以下哪个是列表推导式？', ['[x for x in a]', 'def f():', 'lambda x: x', 'if x:'], 0, '中文题干 + 代码片段'],
    ['SQL 中 JOIN 的作用是什么？', ['连接两张表', '删除数据', '新建索引', '排序结果'], 0, '中文夹英文术语'],
    ['Python 中 len 和 size 的区别？', ['len 是内置函数', '没有 size', '两者相同', 'len 更慢'], 0, '选项里夹中文英文词'],
    ['1 + 1 = ?', ['2', '3', '4', '5'], 0, '纯算式题干']
  ];
  const wrong = CASES.filter(c => (M.isEnglishQ({ q: c[0], opts: c[1] }) ? 1 : 0) !== c[2]).map(c => c[3]);
  ck('isEnglishQ 9 条用例全对（英文题滤掉、中文题不误杀）', wrong.length === 0, wrong.join(' / ') || '9/9');
}

/* ================= 浏览器侧 ================= */
(async () => {
  nodeChecks();

  const srv = USE_LOCAL ? spawn(process.execPath, [path.join(__dirname, 'serve.cjs'), String(PORT)], { stdio: 'ignore' }) : null;
  if (USE_LOCAL) await sleep(700);
  const s = new Session({ width: 414, height: 896, port: 9359 });
  let LAST = '';
  const _ev = s.eval.bind(s);
  s.eval = function (x) { LAST = String(x).slice(0, 110); return _ev(x); };

  const hasSel = (sel) => s.eval('!!document.querySelector(' + JSON.stringify(sel) + ')');
  const clickSel = (sel) => s.eval("(function(){var e=document.querySelector(" + JSON.stringify(sel) + ");if(e){e.click();return 1;}return 0;})()");
  const clickText = (sel, txt) => s.eval("(function(){var a=[].slice.call(document.querySelectorAll(" + JSON.stringify(sel) + "));var e=a.filter(function(x){return (x.textContent||'').indexOf(" + JSON.stringify(txt) + ")>=0;})[0];if(e){e.click();return 1;}return 0;})()");
  const fbText = () => s.eval("(function(){var f=document.querySelector('#fbzone .fb');return f?f.textContent:'';})()");
  const qText = () => s.eval('(document.querySelector("#stage .qbox")||{}).textContent||""');

  /* fetch 桩：判题 → 判错；英文讲题 → 译文+解析；出题 → 中英混排；其余 GET 直接失败（别真联网抓素材） */
  const stub = `(function(){
    window.__aiPrompt='';
    window.__realFetch=window.fetch;
    window.fetch=function(u,o){
      if(!o||String(o.method||'GET').toUpperCase()!=='POST')return Promise.reject(new Error('probe: 不联网'));
      var body=String((o&&o.body)||'');
      window.__aiPrompt=body;
      var content;
      if(/批改一道编程练习/.test(body)) content=JSON.stringify({ok:false,why:'缺少边界判断'});
      else if(/题目是英文/.test(body)) content=JSON.stringify({trans:'下面哪个内置类型是可变的？',exp:'list 可以原地增删元素，tuple/dict 的键都不可变'});
      else if(/命题老师|题库生成助手/.test(body)) content=JSON.stringify([
        {q:'下列关于列表的说法哪个正确？',a:'列表可以原地修改',opts:['列表可以原地修改','列表长度固定','列表元素必须同类型','列表不可遍历'],exp:'list 可变、长度动态、元素可不同类型、可遍历',src:'人教版初中信息科技'},
        {q:'Python 中哪个关键字用于定义函数？',a:'def',opts:['def','class','lambda','return'],exp:'def 定义函数，class 定义类，lambda 是匿名函数表达式',src:'Python 官方教程'},
        {q:'元组与列表最主要的区别是？',a:'元组不可变',opts:['元组不可变','元组不能嵌套','元组没有索引','元组不能遍历'],exp:'元组创建后不能增删改元素',src:'Python 官方教程'},
        {q:'下列关于字典的说法哪个正确？',a:'键必须可哈希',opts:['键必须可哈希','键可以是列表','字典不能删除键值对','值必须是字符串']},
        {q:'Which of the following is a mutable type in Python?',a:'list',opts:['tuple','list','dict','set'],exp:'list is mutable',src:'Python docs'},
        {q:'What does len([1,2,3]) return in Python?',a:'3',opts:['1','2','3','4'],exp:'len counts items',src:'Python docs'},
        {q:'下列哪个是水果？',a:'苹果',opts:['It is an apple','A kind of fruit juice drink','Banana milk shake','Fresh orange juice'],exp:'苹果是水果',src:'常识'},
        {q:'下列哪种编程语言是解释型语言？',a:'Python',opts:['C','Python','汇编','机器码']}
      ]);
      else content=JSON.stringify({exp:'先把题意拆成两步，再合并结果'});
      return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve({choices:[{message:{content:content}}]});}});
    };
    return 1;})()`;

  try {
    await s.open(APP);
    await s.waitFor('!!document.querySelector(".book")', 15000);
    await s.eval("navigator.serviceWorker.getRegistrations().then(function(rs){return Promise.all(rs.map(function(r){return r.unregister();}));}).then(function(){return 1;}).catch(function(){return 0;})");
    await s.eval("localStorage.clear();localStorage.setItem('bt_qa_quickjump','true');"
      + "localStorage.setItem('bt_qa_profile_code',JSON.stringify({done:true,skipped:true,langs:[],level:0,rank:0}));"
      + "localStorage.setItem('bt_qa_ai',JSON.stringify({url:'http://127.0.0.1:9/v1/chat/completions',key:'k',model:'m',proxy:''}));1");
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 15000);
    await s.eval(stub);
    await sleep(200);

    /* 从任意位置回到书架，再进「编程 → 程序编写 → 难度 2 → 手写代码：开」 */
    async function enterHand() {
      if (await hasSel('#stage .btn')) { await clickText('#stage .btn', '返回书架'); await sleep(300); }
      if (!(await hasSel('.book'))) {
        for (let i = 0; i < 4; i++) { if (await hasSel('.book')) break; await s.eval('history.back();1'); await sleep(600); }
      }
      await s.waitFor('!!document.querySelector(".book")', 12000);
      await clickText('.book', '编程');
      await s.waitFor('!!document.querySelector(".secbtn")||!!document.querySelector(".diffbtn")', 10000);
      if (await hasSel('.secbtn')) { await clickText('.secbtn', '程序编写'); await s.waitFor('!!document.querySelector(".diffbtn")', 8000); }
      await s.eval("(function(){document.querySelectorAll('.diffbtn')[1].click();var go=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return /开始出题/.test(x.textContent)})[0];if(go)go.click();return 1;})()");
      await s.waitFor("!!document.querySelector('#stage .toggle')", 10000);
      if (await hasSel('#curOverlay .btn')) { await clickText('#curOverlay .btn', '跳过'); await sleep(300); }
      await clickText('#stage .toggle', '手写代码');
      await s.waitFor("!!document.querySelector('#stage .codeinp')", 8000);
    }

    /* ---------- C. 进「程序编写 · 手写代码」，连点「不会」收集题面 ---------- */
    await enterHand();

    const stems = [];
    let expOK = 0, unkFb = [];
    for (let i = 0; i < 10; i++) {
      const q = (await qText()).trim();
      if (q) stems.push(q);
      const un = await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .unkbtn')).filter(function(x){return /不会/.test(x.textContent)&&!x.disabled;})[0];if(b){b.click();return 1;}return 0;})()");
      if (!un) break;
      await s.waitFor("!!document.querySelector('#fbzone .fb')", 6000);
      const t = await fbText();
      unkFb.push(t);
      if (/要点：/.test(t)) expOK++;
      await clickText('#fbzone .fb .fbnext', '下一题');
      await s.waitFor("!!document.querySelector('#stage .codeinp') || /再来一局/.test((document.querySelector('#stage')||{}).textContent||'')", 9000);
      const atFin = await s.eval("!!([].slice.call(document.querySelectorAll('#stage button')).filter(function(x){return /再来一局/.test(x.textContent)})[0])");
      if (atFin) break;
      await sleep(120);
    }
    const uniqStems = Array.from(new Set(stems));
    ck('手写题一局里能抽到 ≥4 种不同题面（不再只有 SUM/MAX）', uniqStems.length >= 4, 'unique=' + uniqStems.length + ' / 收集 ' + stems.length + ' 题');
    const stemsBad = stems.filter(x => !/用 JavaScript 写一个函数|用 C 语言/.test(x));
    ck('每题都来自扩充后的题库（题面明确标注 JavaScript / C 语言）', stems.length > 0 && stemsBad.length === 0, stemsBad.slice(0, 3).join(' | ') || (stems[0] || '').slice(0, 40));
    ck('「😵 不会」在手写题上也给要点解析', expOK === unkFb.length && expOK > 0, expOK + '/' + unkFb.length);
    ck('手写题「不会」给答案行 + 参考代码 + 答题思路', unkFb.length > 0 && unkFb.every(t => /正确答案：（AI 评判）/.test(t) && /✅ 参考代码/.test(t) && /🧭 答题思路/.test(t)), JSON.stringify((unkFb[0] || '').slice(0, 90)));

    /* ---------- D. 手写题 AI 判错 → 解析 + 下一题，无重试 ---------- */
    await enterHand();
    await s.eval("(function(){var t=document.querySelector('#stage .codeinp');t.value='int main(){return 0;}';if(t.dispatchEvent)t.dispatchEvent(new Event('input'));var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /提交 AI 评判/.test(x.textContent)})[0];if(b)b.click();return 1;})()");
    await s.waitFor("/判为不正确|判为正确/.test((document.querySelector('#fbzone .fb')||{}).textContent||'')", 12000);
    const t4 = await fbText();
    ck('手写题判错 → 反馈条给结论', /判为不正确/.test(t4), JSON.stringify(t4.slice(0, 40)));
    ck('手写题判错 → 附带要点解析', /要点：/.test(t4) && /样例：/.test(t4), JSON.stringify(t4.slice(0, 70)));
    ck('手写题判错 → 给参考代码与答题思路', /✅ 参考代码/.test(t4) && /🧭 答题思路/.test(t4), JSON.stringify(t4.slice(0, 120)));
    ck('手写题判错 → 有「下一题 ›」', await hasSel('#fbzone .fb .fbnext'), '');
    ck('手写题判错 → 给「✍️ 重写代码」（非旧「🔄 重试」）', await s.eval("(function(){var bs=[].slice.call(document.querySelectorAll('#fbzone .fb .chip')||[]);for(var i=0;i<bs.length;i++){if(/重写代码/.test(bs[i].textContent))return 1;}return 0;})()"), '');
    ck('手写题判错 → 不是旧「🔄 重试」', !(await s.eval("/🔄 重试/.test((document.querySelector('#fbzone .fb')||{}).textContent||'')")), '');

    /* ---------- E. 存量英文题：AI 解析给译文 + 解析 ---------- */
    await s.eval("localStorage.setItem('bt_qa_weak',JSON.stringify([{type:'b:code',diff:1,q:'Which of the following is a mutable type in Python?',a:'list',opts:['tuple','list','dict','set'],time:Date.now()}]));1");
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 15000);
    await s.eval(stub);
    await clickText('.act', '薄弱题');
    await s.waitFor("!!document.querySelector('#curOverlay .list-row')", 8000);
    await clickText('#curOverlay .btn', '全部回顾');
    await s.waitFor("!!document.querySelector('#stage .obtn')", 10000);
    await s.eval("(function(){var bs=[].slice.call(document.querySelectorAll('#stage .obtn'));for(var i=0;i<bs.length;i++){if(bs[i].textContent.trim()==='tuple'){bs[i].click();return 1;}}return 0;})()");
    await s.waitFor("!!document.querySelector('#fbzone .fb .aibtn')", 8000);
    ck('英文薄弱题答错 → 给「💡 AI 解析」按钮', await hasSel('#fbzone .fb .aibtn'), '');
    await clickSel('#fbzone .fb .aibtn');
    await s.waitFor("!!document.querySelector('#fbzone .fb .fexp')", 12000);
    const t5 = await fbText();
    ck('英文题 AI 解析 → 先给「💬 译文」', /译文：/.test(t5), JSON.stringify(t5.slice(0, 60)));
    ck('英文题 AI 解析 → 再给「💡 解析」', /解析：/.test(t5) && /list/.test(t5), JSON.stringify(t5.slice(0, 90)));
    ck('译文与解析分两行', await s.eval("document.querySelectorAll('#fbzone .fb .fexp>div').length") === 2, 'lines=' + await s.eval("document.querySelectorAll('#fbzone .fb .fexp>div').length"));

    /* ---------- F. AI 建题库：prompt 中文约束 + 英文题被过滤 ---------- */
    await clickText('#stage .btn', '返回书架');
    await s.waitFor('!!document.querySelector(".book")', 10000);
    await clickText('.act', '新建');
    await s.waitFor("!!document.querySelector('#curOverlay input')", 8000);
    await s.eval("(function(){var i=document.querySelector('#curOverlay input');i.value='Python';i.dispatchEvent(new Event('input'));return 1;})()");
    await clickText('#curOverlay .btn', 'AI 生成');
    let rows = 0, rowTxt = [];
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      rows = await s.eval("document.querySelectorAll('#stage .list-row').length");
      if (rows > 0) break;
    }
    /* 取真正发给模型的 prompt（body 里的 messages[0].content） */
    const rawPrompt = await s.eval("(function(){try{return JSON.parse(window.__aiPrompt).messages[0].content||'';}catch(e){return '';}})()");
    ck('出题 prompt 是「命题老师」角色 + 要求全部简体中文', /命题老师/.test(rawPrompt) && /全部简体中文/.test(rawPrompt), rawPrompt ? 'len=' + rawPrompt.length : '（未拦截到出题请求）');
    ck('出题 prompt 保留禁令（百科词条/书目元信息题）', /严禁出的题/.test(rawPrompt) && /补全词条/.test(rawPrompt) && /出版社/.test(rawPrompt), '');
    ck('出题 prompt 仍要求禁止政治敏感内容', /禁止政治敏感/.test(rawPrompt), '');
    ck('出题 prompt 要求返回 exp/src 字段（C0 硬过滤依赖）', /"exp"/.test(rawPrompt) && /"src"/.test(rawPrompt), '');
    ck('AI 返回 8 题（3 中文合规 + 2 缺解析 + 2 英文 + 1 英文选项）→ 只入库 3 道', rows === 3, 'rows=' + rows);
    rowTxt = JSON.parse(await s.eval("JSON.stringify([].slice.call(document.querySelectorAll('#stage .list-row')).map(function(x){return x.textContent.slice(0,30);}))"));
    ck('入库题目全是中文题干', rowTxt.length > 0 && rowTxt.every(x => /[\u4e00-\u9fa5]/.test(x)) && !rowTxt.some(x => /Which|What does|mutable type/.test(x)), rowTxt.join(' | ').slice(0, 120));

    /* ---------- G. 收尾体检 ---------- */
    ck('全程无 JS 异常', s.errors.length === 0, s.errors.slice(0, 2).join(' | '));
    const ovf = await s.eval('document.documentElement.scrollWidth - document.documentElement.clientWidth');
    ck('无横向溢出', ovf <= 0, 'overflow=' + ovf);
  } catch (e) {
    fail.push('探针异常 :: ' + e.message + ' | 最后表达式: ' + LAST);
  } finally {
    console.log('\n=== 手写题扩量 + 中文出题：' + pass.length + '/' + (pass.length + fail.length) + ' 通过 ===');
    pass.forEach(t => console.log('  ✓ ' + t));
    fail.forEach(t => console.log('  ✗ ' + t));
    await s.close();
    try { srv && srv.kill('SIGKILL'); } catch (e) {}
  }
})().catch(e => { console.error(e); process.exit(1); });
