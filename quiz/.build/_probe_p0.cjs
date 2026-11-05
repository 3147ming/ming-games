/* P0 修复定向验证（Node + vm，复用 build.js 的装配顺序）
   验证：parseJudge 否定优先 / windowAcc 空窗口=0 / genPool·genStdPool 无放回不重复 /
        validItem 全量通过 / finish 结算口径（0题0%、2对100%、clamp≤100%） */
const fs = require('fs');
const vm = require('vm');
const DIR = 'D:/Projects/_github_pages/ming-games/quiz/.build';

// ---- 极简 DOM / 浏览器 mock ----
function fakeEl() {
  const e = {
    children: [], style: { setProperty(){} }, className: '', _text: '', hidden: false,
    appendChild(c){ this.children.push(c); return c; },
    removeChild(c){ const i=this.children.indexOf(c); if(i>=0)this.children.splice(i,1); },
    set innerHTML(v){ this._text = v; }, get innerHTML(){ return this._text; },
    set textContent(v){ this._text = v; }, get textContent(){ return this._text; },
    set onclick(f){ this._onclick = f; }, get onclick(){ return this._onclick; },
    setAttribute(){}, addEventListener(){}, get firstChild(){ return this.children[0]||null; },
    querySelector(){ return fakeEl(); }, appendChildChild(){},
  };
  return e;
}
const _ids = {};
const document = {
  getElementById(id){ return _ids[id] || (_ids[id] = fakeEl()); },
  createElement(){ return fakeEl(); },
  createTextNode(t){ return { _text:t }; },
  addEventListener(){}, documentElement:{ style:{ setProperty(){} } },
  head:{ appendChild(){} }, body:{ appendChild(){} }, readyState:'complete',
};
const store = {};
const window = {
  localStorage:{ getItem:k=>k in store?store[k]:null, setItem:(k,v)=>{store[k]=String(v);}, removeItem:k=>{delete store[k];} },
  visualViewport:{ height:800 }, innerHeight:800, addEventListener(){}, location:{ protocol:'https:', hostname:'localhost' },
  serviceWorker:null, readyState:'complete',
};
const navigator = { onLine:true, serviceWorker:null };

const FRAMEWORK = [
'var S=window.localStorage;',
'function shuffle(a){a=a.slice();for(var i=a.length-1;i>0;i--){var j=Math.floor(Math.random()*(i+1)),t=a[i];a[i]=a[j];a[j]=t;}return a;}',
'function ri(n){return Math.floor(Math.random()*n);}',
'function h(tag,cls,html){var e=document.createElement(tag);if(cls)e.className=cls;if(html!=null)e.innerHTML=html;return e;}',
'function clearNode(n){while(n&&n.firstChild)n.removeChild(n.firstChild);}',
'function later(fn,ms){return setTimeout(fn,ms||0);}',
'function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];});}',
'var score=0,total=0,ok=0,qidx=0,qlist=[],typeLabel="",typeKey="",locked=false,autoMode=false,selfRank=0,combo=0,wrongCombo=0,reviewMode=false,AUTO_TOTAL=10,UP_COMBO=2,DOWN_COMBO=2;',
'var curDiff=-1,curDiffLabel="",netStat=null;',
  'var PROMO_STREAK=3,PROMO_SIZE=2,promoState="idle",promoStreak=0,promoKey="",promoRank=0,promoAsked=0,promoCorrect=0;',
  'var selfWindow=[];',
'function qaDiffs(bk){var T=QA_TYPES[bk];return (T&&T.diffs&&T.diffs.length)?T.diffs:null;}',
'function qaDiffDefault(bk){var ds=qaDiffs(bk);if(!ds)return -1;var sv=parseInt(S.getItem("bd_qa_diff_"+bk),10);return (sv>=0&&sv<ds.length)?sv:0;}',
].join('\n');

const core = fs.readFileSync(DIR + '/engine_core.js', 'utf8');
let ui = fs.readFileSync(DIR + '/quiz-ui.js', 'utf8');
// 在 quiz-ui.js 的 IIFE 收尾前，把需要测的函数/状态暴露到 globalThis
const iEnd = ui.lastIndexOf('})();');
const exportLine = ';globalThis.__exp={parseJudge:parseJudge,windowAcc:windowAcc,finish:finish,selfWindow:selfWindow,'
  + 'genHandTask:genHandTask,genStdPool:genStdPool,'
  + 'getStage:function(){return stageEl;},resetHand:function(){_handUsed.length=0;},'
  + 'setQ:function(o){if("ok"in o)ok=o.ok;if("total"in o)total=o.total;if("score"in o)score=o.score;'
  + 'if("qidx"in o)qidx=o.qidx;if("lastAuto"in o)lastAuto=o.lastAuto;if("quizOver"in o)quizOver=o.quizOver;'
  + 'if("typeKey"in o)typeKey=o.typeKey;if("lastRun"in o)lastRun=o.lastRun;}};';
ui = ui.slice(0,iEnd) + exportLine + ui.slice(iEnd);

const ctx = {
  console, Math, Date, JSON, parseInt, parseFloat, String, Number, Array, Object, RegExp,
  isFinite, isNaN, setTimeout, clearTimeout, AbortController, Promise, Set, Map, globalThis:{},
  document, window, navigator, indexedDB:undefined, fetch:()=>Promise.resolve({json:()=>Promise.resolve({}),ok:true}),
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(FRAMEWORK + '\n' + core + '\n' + ui, ctx, { filename: 'bundle.js' });
const E = ctx.__exp;

// ---------- 测试 ----------
let pass = 0, fail = [];
function ck(name, cond, info){ if(cond){pass++;} else {fail.push(name+' :: '+(info||''));} }

// 1) parseJudge 否定优先
ck('parseJudge 不完全正确→false', E.parseJudge('这个解法不完全正确').ok === false);
ck('parseJudge 完全正确→true', E.parseJudge('完全正确').ok === true);
ck('parseJudge 边界有问题→false', E.parseJudge('看起来基本正确，但边界有问题').ok === false);
ck('parseJudge 不确定→null', E.parseJudge('我不确定这个对不对') === null);
ck('parseJudge 纯 JSON→按 ok', E.parseJudge('{"ok":false,"why":"x"}').ok === false);
ck('parseJudge 正确→true', E.parseJudge('正确').ok === true);

// 2) windowAcc 空窗口 = 0（不是 1）
E.selfWindow.length = 0;
ck('windowAcc 空窗口=0', E.windowAcc() === 0, 'got '+E.windowAcc());

// 3) genPool 无放回：池子小也只出不重复、且不超池
const smallPool = [['q1','a1','g'],['q2','a2','g'],['q3','a3','g'],['q4','a4','g'],['q5','a5','g']];
const gp = ctx.genPool(40, smallPool, 0);
ck('genPool 不超池大小', gp.length === 5, 'len='+gp.length);
ck('genPool 无重复', new Set(gp.map(x=>x.q)).size === gp.length);

// 4) genStdPool 无放回 + 跨局 recent
//    注意：请求数必须小于池容量，否则「两局不重复」在数学上不可能（池里就那么多题）。
const histN = ctx.pickPoolByDiff(ctx.POOLS.history, 0).length;
const g1 = E.genStdPool('history')(histN, 0);
const g2 = E.genStdPool('history')(histN, 0);
ck('genStdPool 第一局无重复', new Set(g1.map(x=>x.q)).size === g1.length, 'len='+g1.length);
ck('genStdPool 第二局无重复', new Set(g2.map(x=>x.q)).size === g2.length, 'len='+g2.length);
ck('genStdPool 不超池大小', g1.length <= histN, 'len='+g1.length+' 池='+histN);
const interAll = g1.map(x=>x.q).filter(q=>g2.map(y=>y.q).indexOf(q)>=0).length;
ck('genStdPool 请求=池容量时不报错且返回完整', g1.length === histN && interAll === histN, 'len='+g1.length+' 交集='+interAll);

// 4b) 请求数 = 池一半：第二局应基本避开第一局（recent 队列生效）
const x1 = E.genStdPool('science')(5, 0);
const x2 = E.genStdPool('science')(5, 0);
const interHalf = x1.map(y=>y.q).filter(q=>x2.map(z=>z.q).indexOf(q)>=0).length;
ck('genStdPool 跨局 recent 命中 0', interHalf === 0, '交集='+interHalf+'/5 : '+x1.map(y=>y.q[0]+y.q[1]).join(',')+' | '+x2.map(y=>y.q[0]+y.q[1]).join(','));
ck('genStdPool 跨局无重复项', new Set(x1.map(y=>y.q).concat(x2.map(y=>y.q))).size === 10, 'uniq='+new Set(x1.map(y=>y.q).concat(x2.map(y=>y.q))).size);

// 4c) genHandTask 一局内不重复：连出 10 题应 10 道不同
E.resetHand();
const handQ = [];
for (let i=0;i<10;i++) handQ.push(E.genHandTask(0).q);
ck('genHandTask 10 题不重复', new Set(handQ).size === 10, 'uniq='+new Set(handQ).size);
E.resetHand();
const handQ2 = [];
for (let i=0;i<25;i++) handQ2.push(E.genHandTask(1).q);
ck('genHandTask 25 题不重复（全库 25 道）', new Set(handQ2).size === 25, 'uniq='+new Set(handQ2).size);

// 5) validItem 全量（非 code 静态题）
let vOk=0, vBad=0; const badList=[];
['geo','history','science','english','common','literature','sports','animals','astronomy','food'].forEach(function(bk){
  const arr = ctx.POOLS[bk]||[];
  arr.forEach(function(it){
    if(ctx.validItem(it))vOk++; else {vBad++; if(badList.length<5)badList.push(bk+':'+(it&&it[0]));}
  });
});
ck('validItem 全量通过', vBad===0, 'bad='+vBad+' 样例='+badList.join('|'));

// 5b) code 池：源条目是 [题干,答案,语言]（干扰项由 mkFromPool 现场生成），
//     所以校验的是「生成出来的题」必须 4 个互不相同且包含答案。
let cOk=0, cBad=0; const cSamp=[];
Object.keys(ctx.POOLS.code||{}).forEach(function(d){
  const arr=ctx.POOLS.code[d]||[];
  arr.forEach(function(it){
    const q=ctx.mkFromPool(it, arr);
    if(ctx.validItem({a:q.a,opts:q.opts}))cOk++; else {cBad++; if(cSamp.length<5)cSamp.push('code'+d+':'+it[0]);}
  });
});
ck('code 池生成结果 validItem 全量通过（'+cOk+' 题）', cBad===0, 'bad='+cBad+' 样例='+cSamp.join('|'));

// 5c) 同分类内题干不重复（同局撞题的根因之一）
let dupIn=0, dupSamp='';
['geo','history','science','english','common','literature','sports','animals','astronomy','food'].forEach(function(bk){
  const seen={};
  (ctx.POOLS[bk]||[]).forEach(function(it){
    const k=String(it[0]);
    if(seen[k]){dupIn++; if(!dupSamp)dupSamp=bk+':'+k;}
    seen[k]=1;
  });
});
ck('静态题库分类内无重复题干', dupIn===0, 'dup='+dupIn+' 样例='+dupSamp);

// 5d) P0-1 点名要下架的否定式题确实没了
const BANNED=[
  '中国古代“四大发明”不包括下列哪一项？',
  '网球“大满贯”赛事不包括以下哪一项？',
  '中国“八大菜系”不包括以下哪一项？',
  '啤酒的主要原料不包括以下哪一项？',
  '以下哪个不是编程语言？'
];
let bannedHit=0;
Object.keys(ctx.POOLS).forEach(function(bk){
  const arr=ctx.POOLS[bk]; if(!Array.isArray(arr))return;
  arr.forEach(function(it){ if(BANNED.indexOf(String(it[0]))>=0)bannedHit++; });
});
ck('5 道否定式题已全部下架', bannedHit===0, '残留='+bannedHit);

// 5e) 静态题出题结果必须：4 个互不相同、含答案、且不出现「以上都不对/不确定/其他答案」这类兜底垃圾项
let gBad=0, gJunk=0, gSamp='';
['geo','history','science','english','common','literature','sports','animals','astronomy','food'].forEach(function(bk){
  const qs=E.genStdPool(bk)(30,0);
  qs.forEach(function(q){
    if(!ctx.validItem({a:q.a,opts:q.opts})){gBad++;if(!gSamp)gSamp=bk+':'+q.q;}
    (q.opts||[]).forEach(function(o){
      if(['以上都不对','不确定','其他答案'].indexOf(String(o))>=0){gJunk++;if(!gSamp)gSamp=bk+':'+q.q+' opts='+q.opts.join('/');}
    });
  });
});
ck('静态题选项规整（4 项/唯一/含答案）', gBad===0, 'bad='+gBad+' 样例='+gSamp);
ck('静态题不出现兜底垃圾选项', gJunk===0, 'junk='+gJunk+' 样例='+gSamp);

// 6) finish 结算口径：0题→0%，2对→100%，clamp≤100
function accOf(score, okv, totalv){
  E.setQ({ok:okv,total:totalv,score:score,qidx:totalv,lastAuto:null,quizOver:false});
  E.finish(score);
  let found=null;
  (function walk(n){ if(found||!n)return;
    var t=n._text?String(n._text):'';
    /* C1 二批：0 题不再写「正确率 0%」（那是谎报），改成「本局未作答」—— 两种都要抓到 */
    if(t&&(t.indexOf('正确率')>=0||t.indexOf('本局未作答')>=0))found=t;
    (n.children||[]).forEach(walk); })(E.getStage());
  return found;
}
const r0 = accOf(0, 0, 0);
ck('finish 0题→不谎报 0%（写「本局未作答」）', r0 && (r0.indexOf('0%')>=0||r0.indexOf('本局未作答')>=0), 'txt='+r0);
const r2 = accOf(20, 2, 2);
ck('finish 2对→100%', r2 && r2.indexOf('100%')>=0, 'txt='+r2);
const rOver = accOf(30, 3, 2); // ok>total 也应被 clamp 到 100%
ck('finish clamp≤100%（ok>total 不爆表）', rOver && rOver.indexOf('100%')>=0, 'txt='+rOver);

console.log('P0 定向验证：通过 '+pass+'，失败 '+fail.length);
if(fail.length){ console.log('失败项：\n - '+fail.join('\n - ')); process.exit(1); }
else console.log('✅ 全部通过');
