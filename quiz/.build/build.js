// 组装 quiz/index.html：head + 全局框架 + 引擎核心(抽取) + UI + 收尾
const fs = require('fs');
const DIR = 'D:/Projects/_github_pages/ming-games/quiz/.build';
const OUT = 'D:/Projects/_github_pages/ming-games/quiz/index.html';

const head = fs.readFileSync(DIR + '/head.html', 'utf8');           // 末尾含 <script>
const core = fs.readFileSync(DIR + '/engine_core.js', 'utf8');
const ui   = fs.readFileSync(DIR + '/quiz-ui.js', 'utf8');

// 全局框架：引擎核心(全局作用域)依赖这些符号，必须在引擎之前定义
const FRAMEWORK = [
'/* ===== 全局框架（引擎核心依赖，必须在引擎之前） ===== */',
'var S=(function(){try{return window.localStorage;}catch(e){return {getItem:function(){return null},setItem:function(){},removeItem:function(){}};}})();',
'function shuffle(a){a=a.slice();for(var i=a.length-1;i>0;i--){var j=Math.floor(Math.random()*(i+1)),t=a[i];a[i]=a[j];a[j]=t;}return a;}',
'function ri(n){return Math.floor(Math.random()*n);}',
'function h(tag,cls,html){var e=document.createElement(tag);if(cls)e.className=cls;if(html!=null)e.innerHTML=html;return e;}',
'function clearNode(n){while(n&&n.firstChild)n.removeChild(n.firstChild);}',
'function later(fn,ms){return setTimeout(fn,ms||0);}',
'function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];});}',
'/* 共享答题状态（引擎的 genNextAuto/getRank 在全局作用域读取） */',
'var score=0,total=0,ok=0,qidx=0,qlist=[],typeLabel="",typeKey="",locked=false,autoMode=false,selfRank=0,combo=0,wrongCombo=0,reviewMode=false,AUTO_TOTAL=10,UP_COMBO=2,DOWN_COMBO=2;',
'var curDiff=-1,curDiffLabel="",netStat=null;',
'/* C7：自动升档挑战状态（与 selfRank 同层，引擎/探针可直接读） */',
'var PROMO_STREAK=3,PROMO_SIZE=2,promoState="idle",promoStreak=0,promoKey="",promoRank=0,promoAsked=0,promoCorrect=0;',
'var selfWindow=[];   /* auto 模式滑动窗口：最近 ≤12 题（1 对 / 0 错）—— 挑战期间冻结 */',
'function qaDiffs(bk){var T=QA_TYPES[bk];return (T&&T.diffs&&T.diffs.length)?T.diffs:null;}',
'function qaDiffDefault(bk){var ds=qaDiffs(bk);if(!ds)return -1;var sv=parseInt(S.getItem("bd_qa_diff_"+bk),10);return (sv>=0&&sv<ds.length)?sv:0;}',
'/* ===== 引擎核心（从 brain-gym 原样抽取） ===== */'
].join('\n');

// IndexedDB 辅助（导入本地音乐用），放在 UI 之前以便 openMusic 调用
const IDB = [
'function openIDB(){return new Promise(function(res,rej){try{var r=indexedDB.open("bt_qa_music",1);r.onupgradeneeded=function(){r.result.createObjectStore("blobs");};r.onsuccess=function(){res(r.result);};r.onerror=function(){rej(r.error);};}catch(e){rej(e);}});}',
'function storeBlob(file,cb){openIDB().then(function(db){var tx=db.transaction("blobs","readwrite");var key="b"+Date.now()+Math.floor(Math.random()*1e6);tx.objectStore("blobs").put(file,key);tx.oncomplete=function(){cb(key);};tx.onerror=function(){cb(null);};}).catch(function(){cb(null);});}',
'function loadBlob(key,cb){openIDB().then(function(db){var tx=db.transaction("blobs","readonly");var rq=tx.objectStore("blobs").get(key);rq.onsuccess=function(){cb(rq.result||null);};rq.onerror=function(){cb(null);};}).catch(function(){cb(null);});}'
].join('\n');

const html = head + '\n' + FRAMEWORK + '\n' + core + '\n' + IDB + '\n' + ui + '\n</script>\n</body>\n</html>\n';

fs.writeFileSync(OUT, html, 'utf8');
console.log('OK: index.html 已生成，字节=' + Buffer.byteLength(html, 'utf8'));
