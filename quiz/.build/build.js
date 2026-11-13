// 组装 quiz/index.html：head + 全局框架 + 引擎核心(抽取) + UI + 收尾
//
// 用法：
//   node quiz/.build/build.js            生成产物 + 同步部署包 + 重算 SW 版本
//   node quiz/.build/build.js --check    只校验不写入：产物 / 部署包 / SW 版本是否与源片一致
//
// index.html 是「生成文件」，不要直接改 —— 否则下次构建会把它改回去（历史上的四组书架
// 与 grid 修复就这样丢过一次）。改 head.html / engine_core.js / quiz-ui.js / src/wrongbook.js。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = __dirname;                       // quiz/.build：本脚本与探针
const ROOT = path.resolve(DIR, '..');        // quiz
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'index.html');
const DEPLOY_OUT = path.resolve(ROOT, '..', '_deploy_gym', 'quiz', 'index.html');
const SW_PATHS = [
  path.join(ROOT, 'sw.js'),
  path.resolve(ROOT, '..', '_deploy_gym', 'quiz', 'sw.js')
];
/* 统一构建链的产物（deploy.config.json 的 publishDir 就是 dist） */
const DIST_OUT = path.resolve(ROOT, '..', 'dist', 'games', 'quiz', 'index.html');
const CHECK = process.argv.indexOf('--check') >= 0;

const head = fs.readFileSync(path.join(DIR, 'head.html'), 'utf8');           // 末尾含 <script>
const core = fs.readFileSync(path.join(DIR, 'engine_core.js'), 'utf8');
/* 错题本导出/导入的纯函数（UMD：浏览器挂 window.WrongBook，Node 里可 require 做单测）。
   内联进产物的原因：index.html 是单文件离线 PWA，多一个外部脚本就多一个缓存失败点。 */
const wb = fs.readFileSync(path.join(SRC, 'wrongbook.js'), 'utf8');
const ui = fs.readFileSync(path.join(DIR, 'quiz-ui.js'), 'utf8');

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

/* 写产物之前先跑语言标签断言：不合规直接阻断，绝不产出会让语言闸漏题的 index.html */
require('./_guard_tags.cjs');

const html = head + '\n' + FRAMEWORK + '\n' + core + '\n' + IDB + '\n;\n' + wb + '\n;\n' + ui + '\n</script>\n</body>\n</html>\n';
const buf = Buffer.from(html, 'utf8');
const md5 = crypto.createHash('md5').update(buf).digest('hex');
/* Service Worker 版本号由产物内容自动生成，避免手工递增漏改让用户拿到旧缓存。
   quiz- 前缀必须保留（activate 里按该前缀清理旧缓存），两处 sw.js 同源同值。 */
const ver = 'quiz-' + md5.slice(0, 10);

function fileInfo(p) {
  if (!fs.existsSync(p)) return { exists: false, bytes: 0, md5: '' };
  const b = fs.readFileSync(p);
  return { exists: true, bytes: b.length, md5: crypto.createHash('md5').update(b).digest('hex') };
}
function swVersionOf(p) {
  if (!fs.existsSync(p)) return '';
  const m = fs.readFileSync(p, 'utf8').match(/var VERSION = '(quiz-[^']*)';/);
  return m ? m[1] : '';
}

/* ---------------- --check：只比对，不写任何文件 ---------------- */
if (CHECK) {
  const out = fileInfo(OUT);
  const dep = fileInfo(DEPLOY_OUT);
  /* rows: [标签, 通过, 实际值, 期望值] */
  const rows = [
    ['产物   quiz/index.html', out.exists && out.md5 === md5, (out.md5 || '(缺失)') + ' · ' + out.bytes + ' B', md5 + ' · ' + buf.length + ' B'],
    ['部署包 _deploy_gym/quiz/index.html', dep.exists && dep.md5 === md5, (dep.md5 || '(缺失)') + ' · ' + dep.bytes + ' B', md5 + ' · ' + buf.length + ' B']
  ];
  SW_PATHS.forEach(function (p) {
    const v = swVersionOf(p);
    rows.push(['SW ' + path.relative(path.resolve(ROOT, '..'), p), v === ver, v || '(缺失)', ver]);
  });
  /* dist 是另一条构建链（大厅外壳 + 通信桥 + SW 中和脚本），内容必然不同：
     不比对 md5，只校验「没被削成空壳」——历史上它曾只剩 39KB 且题库 0 题。 */
  if (fs.existsSync(DIST_OUT)) {
    const d = fileInfo(DIST_OUT);
    const text = fs.readFileSync(DIST_OUT, 'utf8');
    const hasApp = text.indexOf('id="shelf"') >= 0 && text.indexOf('SUBJECT_GROUPS') >= 0;
    const bigEnough = d.bytes >= buf.length * 0.8;
    rows.push(['dist 产物（体量 + 应用符号）', hasApp && bigEnough,
      d.bytes + ' B · 应用符号' + (hasApp ? '在' : '缺失'), '≥ ' + Math.floor(buf.length * 0.8) + ' B · 应用符号在']);
  } else {
    rows.push(['dist 产物', false, '(未构建)', '执行 node tools/build.mjs --target=web']);
  }
  let bad = 0;
  rows.forEach(function (r) {
    if (!r[1]) bad++;
    console.log((r[1] ? '✓ ' : '✗ ') + r[0] + '  实际=' + r[2] + '  期望=' + r[3]);
  });
  console.log(bad ? '\n不一致 ' + bad + ' 处：产物请执行 node quiz/.build/build.js 重新生成（不要手改产物）；dist 请跑统一构建'
                  : '\n一致：产物 / 部署包 / SW / dist 四者与源片匹配（md5 ' + md5 + '）');
  process.exit(bad ? 1 : 0);
}

/* ---------------- 正常构建 ---------------- */
fs.writeFileSync(OUT, buf);
/* 部署包同源同值：构建时一次写齐，避免发布前漏 cp 导致线上与源码不一致 */
if (fs.existsSync(DEPLOY_OUT)) fs.writeFileSync(DEPLOY_OUT, buf);
console.log('OK: index.html 已生成，字节=' + buf.length + ' md5=' + md5);

/* 落盘后复读校验：写失败 / 编码异常当场暴露，不留「以为写了」的假成功 */
[[OUT, '产物'], [DEPLOY_OUT, '部署包']].forEach(function (pair) {
  if (!fs.existsSync(pair[0])) { console.log('跳过（文件不存在）：' + pair[0]); return; }
  if (fileInfo(pair[0]).md5 !== md5) throw new Error(pair[1] + ' 落盘后 md5 与内存不一致：' + pair[0]);
});

SW_PATHS.forEach(function (swPath) {
  if (!fs.existsSync(swPath)) { console.log('跳过（文件不存在）：' + swPath); return; }
  const sw = fs.readFileSync(swPath, 'utf8');
  const anchor = /var VERSION = 'quiz-[^']*';/;
  if (sw.split(anchor).length - 1 !== 1) throw new Error('SW VERSION 锚点不唯一：' + swPath);
  fs.writeFileSync(swPath, sw.replace(anchor, "var VERSION = '" + ver + "';"), 'utf8');
});
console.log('OK: SW VERSION = ' + ver + '（两处 sw.js 已同步）');
