/* 共用 Node 沙箱：按 build.js 的顺序装配 engine_core.js + quiz-ui.js，
   并把 IIFE 内的待测函数暴露出来。供 _probe_p1.cjs 等定向验证复用。 */
const fs = require('fs');
const vm = require('vm');
const DIR = __dirname;

function fakeEl() {
  const e = {
    children: [], style: { setProperty() {} }, className: '', _text: '', hidden: false,
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); },
    set innerHTML(v) { this._text = v; }, get innerHTML() { return this._text; },
    set textContent(v) { this._text = v; }, get textContent() { return this._text; },
    set onclick(f) { this._onclick = f; }, get onclick() { return this._onclick; },
    setAttribute() {}, addEventListener() {}, get firstChild() { return this.children[0] || null; },
    querySelector() { return fakeEl(); }, querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, contains() { return false; } },
  };
  return e;
}
const _ids = {};
const document = {
  getElementById(id) { return _ids[id] || (_ids[id] = fakeEl()); },
  createElement() { return fakeEl(); },
  createTextNode(t) { return { _text: t }; },
  addEventListener() {}, documentElement: { style: { setProperty() {} } },
  head: { appendChild() {} }, body: { appendChild() {} }, readyState: 'complete',
};
const store = {};
const window = {
  localStorage: {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
  },
  visualViewport: { height: 800 }, innerHeight: 800, addEventListener() {},
  location: { protocol: 'https:', hostname: 'localhost' },
  serviceWorker: null, readyState: 'complete',
};
const navigator = { onLine: true, serviceWorker: null };

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
  /* C7：升档挑战状态 + selfWindow —— 与 build.js 的 FRAMEWORK 保持一致 */
  'var PROMO_STREAK=3,PROMO_SIZE=2,promoState="idle",promoStreak=0,promoKey="",promoRank=0,promoAsked=0,promoCorrect=0;',
  'var selfWindow=[];',
  'function qaDiffs(bk){var T=QA_TYPES[bk];return (T&&T.diffs&&T.diffs.length)?T.diffs:null;}',
  'function qaDiffDefault(bk){var ds=qaDiffs(bk);if(!ds)return -1;var sv=parseInt(S.getItem("bd_qa_diff_"+bk),10);return (sv>=0&&sv<ds.length)?sv:0;}',
].join('\n');

const core = fs.readFileSync(DIR + '/engine_core.js', 'utf8');
let ui = fs.readFileSync(DIR + '/quiz-ui.js', 'utf8');
const iEnd = ui.lastIndexOf('})();');
const exportLine = ';globalThis.__exp={POOLS:POOLS,mkFromPool:mkFromPool,validItem:validItem,'
  + 'fillEqual:fillEqual,parseJudge:parseJudge,windowAcc:windowAcc,finish:finish,selfWindow:selfWindow,'
  + 'genHandTask:genHandTask,genStdPool:genStdPool,startReviewOne:startReviewOne,openWeakBook:openWeakBook,'
  + 'weakSort:weakSort,weakCatName:weakCatName,weakAgo:weakAgo,'
  + 'codeEstimate:codeEstimate,codeEstimateParts:codeEstimateParts,codeTrial:codeTrial,'
  + 'retryRoundWrong:retryRoundWrong,dropRoundWrong:dropRoundWrong,buildBackup:buildBackup,applyBackup:applyBackup,'
  + 'exportAllData:exportAllData,trendDays:trendDays,bumpDaily:bumpDaily,bumpStat:bumpStat,bestInfo:bestInfo,dayKey:dayKey,'
  + 'getRoundWrong:function(){return roundWrong;},setRoundWrong:function(a){roundWrong=a||[];},'
  + 'getStage:function(){return stageEl;},getOverlay:function(){return overlayRoot;},resetHand:function(){_handUsed.length=0;},'
  + 'setQ:function(o){if("ok"in o)ok=o.ok;if("total"in o)total=o.total;if("score"in o)score=o.score;'
  + 'if("qidx"in o)qidx=o.qidx;if("lastAuto"in o)lastAuto=o.lastAuto;if("quizOver"in o)quizOver=o.quizOver;'
  + 'if("typeKey"in o)typeKey=o.typeKey;if("lastRun"in o)lastRun=o.lastRun;if("reviewMode"in o)reviewMode=o.reviewMode;'
  + 'if("reviewOne"in o)reviewOne=o.reviewOne;},'
  + 'getState:function(){return {qlist:qlist,total:total,qidx:qidx,reviewMode:reviewMode,reviewOne:reviewOne,typeKey:typeKey};},'
  /* 语言闸/题库（块 0/1/2/5 验收用） */
  + 'codeLangState:codeLangState,codeAllowedLangs:codeAllowedLangs,langGuard:langGuard,'
  + 'CODE_TASKS:CODE_TASKS,CODE_TOPICS:CODE_TOPICS,QA_TYPES:QA_TYPES,sectionGen:sectionGen,genAutoOne:genAutoOne,'
  + 'getCodeProfile:getCodeProfile,CODE_PROFILE_KEY:CODE_PROFILE_KEY,CODE_LANGS:CODE_LANGS,langName:langName,'
  + 'mkCodeQ:mkCodeQ,mkCodeFill:mkCodeFill,setHandMode:setHandMode,showQuestion:showQuestion,'
  + 'getHandUsed:function(){return _handUsed;},getToast:function(){var t=document.getElementById("toast");return t&&t.textContent?t.textContent:"";},'
  + 'setToast:function(m){var t=document.getElementById("toast");if(t)t.textContent=m;},'
  + 'setSection:function(k){qaSection=k;},getSection:function(){return qaSection;},'
  + 'setAutoMode:function(v){autoMode=!!v;},setSelfRank:function(r){selfRank=r;}};';
ui = ui.slice(0, iEnd) + exportLine + ui.slice(iEnd);

const ctx = {
  console, Math, Date, JSON, parseInt, parseFloat, String, Number, Array, Object, RegExp,
  isFinite, isNaN, setTimeout, clearTimeout, AbortController, Promise, Set, Map, globalThis: {},
  document, window, navigator, indexedDB: undefined,
  fetch: () => Promise.resolve({ json: () => Promise.resolve({}), ok: true }),
  confirm: () => true, alert: () => {},
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(FRAMEWORK + '\n' + core + '\n' + ui, ctx, { filename: 'bundle.js' });

module.exports = { ctx, E: ctx.__exp, store, document, fakeEl };
