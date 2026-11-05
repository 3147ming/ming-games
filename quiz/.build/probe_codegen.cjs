/* 全语言程序化题库 + 五档难度 专项探针
   A 段：Node 侧直接跑引擎（不是 mock DOM，是真实源码片段）
   B 段：无头 Edge 跑真实页面（难度面板 / 题量 / 选项渲染） */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');
const { Session, sleep } = require('./cdp.cjs');
const { step } = require('./pace.cjs');

const DIR = __dirname;
const PORT = 8866;
const APP = process.argv[2] || ('http://127.0.0.1:' + PORT + '/quiz/');
const USE_LOCAL = !process.argv[2];
const pass = [], fail = [];
function ck(n, c, e) { (c ? pass : fail).push(n + (e ? ' :: ' + e : '')); }

/* ---------- 组装沙箱：框架 + 引擎核心 + 代码引擎块 ---------- */
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
function h(tag,cls,html){return {tag:tag,className:cls,innerHTML:html};}
function clearNode(n){}
function later(fn,ms){return 0;}
function esc(s){return String(s==null?'':s);}
var score=0,total=0,ok=0,qidx=0,qlist=[],typeLabel="",typeKey="",locked=false,autoMode=false,selfRank=0,combo=0,wrongCombo=0,reviewMode=false,AUTO_TOTAL=10,UP_COMBO=2,DOWN_COMBO=2;
var curDiff=-1,curDiffLabel="",netStat=null;
var PROMO_STREAK=3,PROMO_SIZE=2,promoState='idle',promoStreak=0,promoKey='',promoRank=0,promoAsked=0,promoCorrect=0;
var selfWindow=[];
function qaDiffs(bk){var T=QA_TYPES[bk];return (T&&T.diffs&&T.diffs.length)?T.diffs:null;}
function qaDiffDefault(bk){var ds=qaDiffs(bk);if(!ds)return -1;var sv=parseInt(S.getItem("bd_qa_diff_"+bk),10);return (sv>=0&&sv<ds.length)?sv:0;}
function getCodeProfile(){try{return JSON.parse(S.getItem('bt_qa_profile_code')||'null');}catch(e){return null;}}
`;
  const ctx = { console, JSON, Math, Date, parseInt, parseFloat, String, Number, Array, Object, RegExp, isFinite, isNaN, setTimeout, clearTimeout };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(prelude + '\n' + core + '\n' + block + '\n', ctx, { filename: 'engine.js' });
  return ctx;
}

const LANGS = ['c', 'python', 'java', 'js', 'sql', 'web', 'all'];

function layerA() {
  const E = boot();
  const run = (code) => vm.runInContext(code, E);

  /* 1. 五档结构 */
  const tiers = run('Object.keys(POOLS.code).sort().join(",")');
  ck('编程题库分 5 档（0-4）', tiers === '0,1,2,3,4', tiers);
  const counts = run('Object.keys(POOLS.code).map(function(k){return POOLS.code[k].length}).join("/")');
  const cntArr = counts.split('/').map(Number);
  ck('每档人工题 ≥10 题', cntArr.every(n => n >= 10), counts);

  /* 2. 每题都有合法语言标签 */
  const badTag = run(`(function(){var bad=[];Object.keys(POOLS.code).forEach(function(d){
    POOLS.code[d].forEach(function(it){var L=['c','python','java','js','sql','web','all'];
      if(L.indexOf(it[2])<0)bad.push(d+'|'+it[0]);});});return bad.slice(0,3).join(' ; ');})()`);
  ck('人工题语言标签全部合法（无标签表错位风险）', badTag === '', badTag);

  /* 3. 显式候选题：4 个同类且含正确答案 */
  const badCands = run(`(function(){var bad=[];Object.keys(POOLS.code).forEach(function(d){
    POOLS.code[d].forEach(function(it){ if(!it[3])return;
      var ops=String(it[3]).split('|');
      if(ops.length!==4||ops.indexOf(it[1])<0||new Set(ops).size!==4)bad.push(it[0]);});});
    return bad.slice(0,3).join(' ; ');})()`);
  ck('显式候选题均为 4 个不重复同类选项且包含答案', badCands === '', badCands);

  /* 4. 知识点池条目规范 */
  const kbStat = run(`(function(){var bad=[],min=99,next='';
    ['c','python','java','js','sql','web','all'].forEach(function(L){
      for(var d=0;d<5;d++){var a=((CODE_KB[L]||{})[String(d)])||[];
        var gens=((CODE_GEN[L]||{})[String(d)]||[]).length;
        if(a.length+gens<min){min=a.length+gens;next=L+':'+d+' kb='+a.length+' gen='+gens;}
        a.forEach(function(it){var ops=String(it[2]||'').split('|');
          if(ops.length!==4||ops.indexOf(it[1])<0||new Set(ops).size!==4)bad.push(L+d+'|'+it[0]);});}});
    return JSON.stringify({bad:bad.slice(0,3),min:min,where:next});})()`);
  const kb = JSON.parse(kbStat);
  ck('知识点池选项均为 4 个同类项且含答案', kb.bad.length === 0, kb.bad.join(' ; '));
  ck('每个语言×档位至少 6 个出题来源（知识点 + 生成器）', kb.min >= 6, '最少 ' + kb.min + ' @' + kb.where);

  /* 5. 每档出题：数量 / 选项 / 答案 */
  function round(d, langFilter) {
    const filter = langFilter ? `S.setItem('bt_qa_profile_code',JSON.stringify({done:true,langs:[${langFilter.map(l => `'${l}'`).join(',')}]}));` : `S.removeItem('bt_qa_profile_code');`;
    return JSON.parse(run(`(function(){${filter}return JSON.stringify(QA_TYPES.code.gen(10,${d}));})()`));
  }
  /* 清掉跨局去重记录，避免前面的用例污染「连刷 5 局」的测量 */
  const clearRec = () => run("(function(){for(var d=0;d<5;d++)S.removeItem('bt_qa_recent_code_'+d);return 1;})()");
  const problems = [];
  for (let d = 0; d < 5; d++) {
    const qs = round(d, null);
    if (qs.length !== 10) problems.push(`档${d} 只有 ${qs.length} 题`); 
    if (new Set(qs.map(x => x.q)).size !== qs.length) problems.push(`档${d} 同局重题`);
    qs.forEach(x => {
      if (!x.opts || x.opts.length !== 4) problems.push(`档${d} 选项数=${x.opts && x.opts.length}「${x.q}」`);
      else {
        if (new Set(x.opts).size !== 4) problems.push(`档${d} 选项重复「${x.q}」`);
        if (x.opts.indexOf(String(x.a)) < 0) problems.push(`档${d} 答案不在选项「${x.q}」`);
      }
      if (/undefined|NaN|\[object/.test(String(x.q) + x.opts.join(''))) problems.push(`档${d} 脏数据「${x.q}」`);
    });
  }
  ck('五档各出 10 题：选项 4 个、不重复、含正确答案、无脏数据', problems.length === 0, problems.slice(0, 4).join(' ; '));

  /* 6. 连续 5 局不重题 + 生成器确实在产出（20 局去重数远超人工池） */
  const dupInfo = [];
  for (let d = 0; d < 5; d++) {
    clearRec();
    const all = [];
    for (let r = 0; r < 5; r++) round(d, null).forEach(x => all.push(x.q));
    const uniq = new Set(all).size;
    dupInfo.push(`${d}:${uniq}/${all.length}`);
  }
  /* 阈值 90%：档 4（精通）只有 10 道人工题 + 2 个生成器 + 10 条知识点（共 22 个来源），
     5 局 50 题在数学上不可能 95% 唯一 —— 实测 200 组唯一数分布 45~50（中位 48）。
     这是池子容量边界，不是去重失效；「同局不重复」仍由上面第 5 项硬校验。 */
  ck('同档连刷 5 局题面不重复（≥90%）', dupInfo.every(s => { const [u, t] = s.split(':')[1].split('/').map(Number); return u / t >= 0.9; }), dupInfo.join(' '));

  const grow = [];
  for (let d = 0; d < 5; d++) {
    clearRec();
    const all = [];
    for (let r = 0; r < 20; r++) round(d, null).forEach(x => all.push(x.q));
    grow.push(`${d}:${new Set(all).size}`);
  }
  const manualN = [22, 23, 12, 22, 10];
  ck('连刷 20 局的题面总数远超人工题池（生成器生效）',
    grow.every((s, i) => Number(s.split(':')[1]) >= manualN[i] * 2), grow.join(' ') + ' | 人工池 ' + manualN.join('/'));

  /* 7. 语言过滤 */
  const filterErr = [];
  ['c', 'python', 'java', 'js', 'sql', 'web'].forEach(L => {
    const qs = round(3, [L]);
    if (qs.length !== 10) filterErr.push(`${L} 只出 ${qs.length} 题`);
    qs.forEach(x => { if (x.tag !== L && x.tag !== 'all') filterErr.push(`${L} 混入 ${x.tag}「${x.q}」`); });
  });
  ck('语言过滤生效：勾选单一语言只出该语言 + 通用题', filterErr.length === 0, filterErr.slice(0, 3).join(' ; '));

  /* 8. 全部勾选 → 多语言混合 */
  const mixed = round(0, ['c', 'python', 'java', 'js', 'sql', 'web']);
  const tags = new Set(mixed.map(x => x.tag));
  ck('全部语言勾选后出题语言混合（≥3 种）', tags.size >= 3, [...tags].join(','));

  /* 9. 题量估算 */
  const est = run('codeEstimate()');
  ck('书架编程题量估算 ≥10000 题（真实参数空间）', est >= 10000, String(est));
  const est2 = run('codeEstimate();codeEstimate();');
  ck('题量估算稳定（不随抽样抖动）', est === est2, est + ' vs ' + est2);

  /* 10. 知识点题的选项来自同一知识点的同类候选 */
  const cross = run(`(function(){var bad=[];
    var qs=QA_TYPES.code.gen(10,2);
    qs.forEach(function(q){
      var hit=null;
      ['c','python','java','js','sql','web','all'].forEach(function(L){
        for(var d=0;d<5;d++){((CODE_KB[L]||{})[String(d)]||[]).forEach(function(it){if(it[0]===q.q)hit=it;});}});
      if(hit){var ops=String(hit[2]).split('|').sort().join('|');
        if(ops!==q.opts.slice().sort().join('|'))bad.push(q.q);}
    });
    return bad.join(' ; ');})()`);
  ck('知识点题目的选项严格来自同知识点的同类候选', cross === '', cross);

  /* 11. 相邻难度：勾 C 的 L4 仍能凑满 10 题（不被过滤掏空） */
  let thin = [];
  ['c', 'python', 'js', 'sql', 'web'].forEach(L => {
    for (let d = 0; d < 5; d++) { const n = round(d, [L]).length; if (n < 10) thin.push(`${L}-${d}:${n}`); }
  });
  ck('单语言各档都能凑满 10 题（不足由通用题补齐）', thin.length === 0, thin.join(' '));

  /* 12. 内置分类的 AI 扩充池：去重 + 补齐 + 难度优先 */
  const ex = run(`(function(){
    S.removeItem('bt_qa_extra');
    var batch=[{q:'法国的首都是？',a:'巴黎',opts:['巴黎','伦敦','柏林','罗马'],d:0}];
    for(var i=1;i<=10;i++)batch.push({q:'AI地理题'+i,a:'答案'+i,opts:['答案'+i,'干扰A'+i,'干扰B'+i,'干扰C'+i],d:0});
    var n1=addExtra('geo',batch);
    var n2=addExtra('geo',batch);
    var out=QA_TYPES.geo.gen(30,1);
    var extraUsed=out.filter(function(x){return x.ai}).length;
    return JSON.stringify({n1:n1,n2:n2,extraUsed:extraUsed,total:out.length,uniq:new Set(out.map(function(x){return x.q})).size});
  })()`);
  const exo = JSON.parse(ex);
  ck('addExtra 按问题去重（与人工题同名、整批重放都不重复入库）', exo.n1 === 10 && exo.n2 === 0, JSON.stringify(exo));
  ck('跨难度扩充题不掺入（d=0 的 AI 题不进 d=1 的局）', exo.extraUsed === 0, 'ai=' + exo.extraUsed);
  /* P0-2：无放回抽样，请求数超过池子时只出池内条数（绝不重复凑数）。
     ⚠ 别再拿 geo 断言「只出 24」—— C1 扩容后 geo 有 177 题，请求 30 已经小于池子；
     这条不变量改由最小的 food 池守住（food 是内置分类里题量最小的）。 */
  const exSmall = run(`(function(){
    S.removeItem('bt_qa_extra');
    var pool=POOLS.food.length;
    var out=QA_TYPES.food.gen(30,1);
    return JSON.stringify({pool:pool,total:out.length,uniq:new Set(out.map(function(x){return x.q})).size});
  })()`);
  const exso = JSON.parse(exSmall);
  ck('题量不足时不重复凑数（请求 30 只出池内 ' + exso.pool + '）',
    exso.total === exso.pool && exso.uniq === exso.pool, JSON.stringify(exso));
  /* 同难度扩充题补满：同样改用 food 池（geo 人工题已够 30，掺不进扩充题） */
  const ex2 = run(`(function(){
    var pool=POOLS.food.length;
    var b=[];for(var i=1;i<=30;i++)b.push({q:'AI美食题B'+i,a:'答案'+i,opts:['答案'+i,'A'+i,'B'+i,'C'+i],d:1});
    addExtra('food',b);
    var out=QA_TYPES.food.gen(30,1);
    return JSON.stringify({pool:pool,total:out.length,ai:out.filter(function(x){return x.ai}).length,uniq:new Set(out.map(function(x){return x.q})).size});
  })()`);
  const ex2o = JSON.parse(ex2);
  ck('同难度扩充题能补满（' + ex2o.pool + ' 人工 + ' + (30 - ex2o.pool) + ' 扩充 = 30）',
    ex2o.total === 30 && ex2o.ai === 30 - ex2o.pool, JSON.stringify(ex2o));
  ck('补齐后同局无重复题', ex2o.uniq === ex2o.total, ex2o.uniq + '/' + ex2o.total);

  /* 13. 题量够时不掺扩充题 */
  const noMix = run(`(function(){var out=QA_TYPES.geo.gen(20,0);return out.filter(function(x){return x.ai}).length;})()`);
  const geoN = run('POOLS.geo.length');
  ck('人工题够用时（20 题 ≤ 地理池 ' + geoN + ' 题）不掺入 AI 题', noMix === 0, 'ai=' + noMix);

  /* 14. 难度档位元数据 */
  const df = run('QA_DIFFS_CODE.map(function(x){return x.n}).join(",")');
  ck('编程难度面板 5 档且文案正确', df === '🐣 入门,🚀 基础,🔧 进阶,🧠 熟练,👑 精通', df);
  const sd = run('QA_DIFFS_STD.map(function(x){return x.cnt}).join(",")');
  ck('其他分类题量 20/30/40', sd === '20,30,40', sd);

  /* 15. 自动匹配（genNextAuto）在 5 档下可用 */
  const autoErr = run(`(function(){var bad=[];for(var d=0;d<5;d++){selfRank=d;typeKey='b:code';
    for(var i=0;i<5;i++){var q=genNextAuto();if(!q.q||!q.opts||q.opts.length!==4)bad.push(d);}}
    return bad.join(',');})()`);
  ck('自动匹配逐题生成在五档下均可用', autoErr === '', autoErr);
}

(async () => {
  /* ---------- A 段 ---------- */
  try { layerA(); } catch (e) { fail.push('A 段异常 :: ' + e.message + '\n' + (e.stack || '').split('\n')[1]); }

  /* ---------- B 段 ---------- */
  const srv = USE_LOCAL ? spawn(process.execPath, [path.join(DIR, 'serve.cjs'), String(PORT)], { stdio: 'ignore' }) : null;
  if (USE_LOCAL) await sleep(700);
  const s = new Session({ width: 414, height: 896, port: 9366 });
  try {
    await s.open(APP);
    await s.eval("localStorage.setItem('bt_qa_quickjump','true');1");
    await s.waitFor('!!document.querySelector(".book")', 15000);
    await s.eval("(function(){try{return navigator.serviceWorker.getRegistrations().then(function(rs){return Promise.all(rs.map(function(r){return r.unregister();}));});}catch(e){return 1;}})()");

    const shelfCode = await s.eval("(function(){var bs=document.querySelectorAll('.book');for(var i=0;i<bs.length;i++){if(/编程/.test(bs[i].textContent))return bs[i].textContent;}return '';})()");
    ck('书架编程题量显示诚实口径（模板生成·理论组合数）', /题（模板生成，理论组合数）/.test(shelfCode), shelfCode);
    ck('书架标注模板生成口径', /模板生成/.test(await s.eval("document.body.textContent")), '');

    /* 编程：跳过实力检测 → 难度面板 5 档 */
    await s.eval("localStorage.setItem('bt_qa_profile_code', JSON.stringify({done:true,skipped:true,langs:[],level:0,rank:0}));1");
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);
    await s.eval("(function(){var bs=document.querySelectorAll('.book');for(var i=0;i<bs.length;i++){if(/编程/.test(bs[i].textContent)){bs[i].click();return 1;}}return 0;})()");
    await s.waitFor('!!document.querySelector(".secbtn")', 8000);
    await s.eval('(function(){var b=document.querySelector(".secbtn");if(b)b.click();return 1;})()');
    await s.waitFor('!!document.querySelector(".diffbtn")', 8000);
    const dnames = await s.eval("(function(){return [].slice.call(document.querySelectorAll('.diffbtn .dn')).map(function(x){return x.textContent;}).join('|');})()");
    ck('难度面板出现 5 个档位按钮', dnames.split('|').length === 6, dnames); // 含「自动匹配」
    ck('五档文案齐备', /入门[\s\S]*基础[\s\S]*进阶[\s\S]*熟练[\s\S]*精通/.test(dnames), dnames);

    /* 选「精通」→ 连答 10 题，检查渲染 */
    await s.eval("(function(){var bs=document.querySelectorAll('.diffbtn');bs[5].click();var g=[].slice.call(document.querySelectorAll('.btn.gold')).filter(function(x){return /开始出题/.test(x.textContent);})[0];g.click();return 1;})()");
    await s.waitFor("document.querySelectorAll('#stage .obtn').length>=4", 8000);
    const q1 = await s.eval("(function(){return {opts:document.querySelectorAll('#stage .obtn').length,txt:document.querySelector('#stage .qbox')?document.querySelector('#stage .qbox').textContent:''};})()");
    ck('精通档能正常渲染 4 个选项', q1.opts === 4, JSON.stringify(q1));
    let seenQ = [];
    for (let i = 0; i < 10; i++) {
      const cur = await s.eval("(function(){var q=document.querySelector('#stage .qbox');return q?q.textContent:'';})()");
      if (cur) seenQ.push(cur);
      await s.eval("(function(){var b=document.querySelector('#stage .obtn');if(b)b.click();return 1;})()");
      await sleep(140);
      await step(s);
    }
    ck('连答 10 题题面同局不重复', new Set(seenQ).size === seenQ.length, seenQ.length + ' 题，去重 ' + new Set(seenQ).size);

    /* 其他分类：难度面板题量 20/30/40 */
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /返回书架/.test(x.textContent);})[0];if(b)b.click();return 1;})()");
    await s.waitFor('!!document.querySelector(".book")', 8000);
    await s.eval("(function(){var bs=document.querySelectorAll('.book');for(var i=0;i<bs.length;i++){if(/历史/.test(bs[i].textContent)){bs[i].click();return 1;}}return 0;})()");
    await s.waitFor('!!document.querySelector(".secbtn")', 8000);
    await s.eval('(function(){var b=document.querySelector(".secbtn");if(b)b.click();return 1;})()');
    await s.waitFor('!!document.querySelector(".diffbtn")', 8000);
    const dd = await s.eval("(function(){return [].slice.call(document.querySelectorAll('.diffbtn .dd')).map(function(x){return x.textContent;}).join('|');})()");
    ck('历史难度面板题量 20/30/40', /20题/.test(dd) && /30题/.test(dd) && /40题/.test(dd), dd);

    const bg = await s.eval("(function(){return document.documentElement.scrollWidth<=window.innerWidth+1;})()");
    ck('无横向溢出', bg === true, String(bg));

    const errs = s.errors.filter(e => !/favicon|sw\.js|SW /i.test(e));
    ck('无 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));
  } catch (e) {
    fail.push('B 段异常 :: ' + e.message);
  } finally {
    console.log('\n=== 程序化题库 + 五档难度：' + pass.length + '/' + (pass.length + fail.length) + ' 通过 ===');
    pass.forEach(t => console.log('  ✓ ' + t));
    fail.forEach(t => console.log('  ✗ ' + t));
    await s.close();
    try { srv && srv.kill('SIGKILL'); } catch (e) {}
  }
})().catch(e => { console.error(e); process.exit(1); });
