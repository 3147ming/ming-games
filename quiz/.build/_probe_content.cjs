/* 批次 C5：内容修正表验收（纯 Node，vm 直跑引擎，不起浏览器）
   A. 13 条修正后的题干都在库，旧题干全部消失
   B. 每条 mkFromPool 后仍是 4 个互不相同的选项、且包含答案（validItem）
   C. 每条都有 exp + src（解析/来源同步更新）
   D. 母亲河题干无任何反斜杠 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const pass = [], fail = [];
function ck(n, c, e) { (c ? pass : fail).push(n + (e ? ' :: ' + e : '')); }

const core = fs.readFileSync(path.join(__dirname, 'engine_core.js'), 'utf8');
const ctx = { console, JSON, Math, Date, parseInt, parseFloat, String, Number, Array, Object, RegExp, isFinite, isNaN };
vm.createContext(ctx);
vm.runInContext("var __s={};var S={getItem:function(k){return __s[k]||null},setItem:function(k,v){__s[k]=v},removeItem:function(k){delete __s[k]}};function shuffle(a){a=a.slice();for(var i=a.length-1;i>0;i--){var j=Math.floor(Math.random()*(i+1)),t=a[i];a[i]=a[j];a[j]=t;}return a;}function ri(n){return Math.floor(Math.random()*n);}" + core, ctx);
const run = (code) => vm.runInContext(code, ctx);

/* 题干 → 分类 */
const FIXED = [
  ['geo', '有“母亲河”之称的中国河流是？'],
  ['geo', '截至 2024 年，印度尼西亚的首都是？'],
  ['geo', '以色列的政府机构所在地是？'],
  ['geo', '世界海拔最高的实际首都（政府所在地）是？'],
  ['history', '1636 年改国号为清的皇帝是？'],
  ['history', '「康乾盛世」主要跨越哪三位皇帝？'],
  ['history', '清朝派驻西藏、与达赖班禅共同管理的官员是？'],
  ['history', '清朝统辖新疆军政的官员是？'],
  ['sports', '马拉松全程的标准距离是多少公里？'],
  ['animals', '通常被认为牙齿最多的动物是？'],
  ['sports', '竞技游泳中通常速度最快的项目是？'],
  ['english', '"奶牛"的英文是？'],
  ['english', '"绵羊"的英文是？']
];
const OLD = [
  '清朝的建立者是？', '康乾盛世主要指哪两位皇帝统治时期？', '清朝设置管辖西藏的机构是？',
  '清朝在新疆设置的管理机构是？', '马拉松全程约多少公里？', '世界上牙齿最多的动物是？',
  '游泳中速度通常最快的泳姿是？', '"牛"的英文是？', '"羊"的英文是？',
  '以色列的首都是？', '印度尼西亚的首都是？', '世界海拔最高的国家首都是？'
];

const all = run('JSON.stringify((function(){var o={};for(var k in POOLS){if(!POOLS.hasOwnProperty(k)||!Array.isArray(POOLS[k]))continue;o[k]=POOLS[k].map(function(it){return it[0];});}return o;})())');
const stemsBy = JSON.parse(all);

/* A1. 新题干都在 */
const missing = FIXED.filter(([cat, q]) => !(stemsBy[cat] || []).includes(q));
ck('13 条修正后的题干全部在库', missing.length === 0, missing.map(x => x[1]).join(' / '));

/* A2. 旧题干都不在（母亲河单独查反斜杠版） */
const allStems = Object.keys(stemsBy).reduce((a, k) => a.concat(stemsBy[k]), []);
const leftOld = OLD.filter(q => allStems.includes(q));
ck('12 条旧题干已全部替换', leftOld.length === 0, leftOld.join(' / '));
const badSlash = allStems.filter(q => /\\/.test(String(q)));
ck('题库里没有任何题干带反斜杠', badSlash.length === 0, badSlash.join(' / '));
ck('母亲河题干用中文引号', allStems.some(q => q === '有“母亲河”之称的中国河流是？'), '');

/* B/C. 逐条生成一次，检查选项与解析 */
const bad = [], noMeta = [], detail = [];
FIXED.forEach(function (pair) {
  const cat = pair[0], q = pair[1];
  const idx = (stemsBy[cat] || []).indexOf(q);
  if (idx < 0) return;
  const one = JSON.parse(run('JSON.stringify((function(){var pool=POOLS[' + JSON.stringify(cat) + '];var it=pool[' + idx + '];var o=mkFromPool(it,pool);'
    + 'return {q:o.q,a:o.a,opts:o.opts,ok:validItem(o),exp:o.exp||"",src:o.src||"",n:(o.opts||[]).length,u:(o.opts||[]).filter(function(x,i,arr){return arr.indexOf(x)===i;}).length};})())'));
  if (!one.ok || one.n !== 4 || one.u !== 4 || one.opts.indexOf(one.a) < 0) {
    bad.push(q + ' → opts=' + JSON.stringify(one.opts) + ' a=' + one.a);
  }
  if (!one.exp || !one.src) noMeta.push(q + '（exp=' + (one.exp ? '有' : '空') + ',src=' + (one.src ? '有' : '空') + '）');
  detail.push(one.n + '/' + one.u);
});
ck('13 条生成后都是 4 选项且含答案（validItem 通过）', bad.length === 0, bad.join(' | ').slice(0, 200));
ck('13 条都带解析 + 来源', noMeta.length === 0, noMeta.join(' | ').slice(0, 200));

/* D. 负向：确认没把别的题改坏（题库总量不变） */
const total = allStems.length;
ck('题库总量不变（只改题干不删题，719 道）', total === 719, 'total=' + total);

console.log('\n=== 内容修正表（批次 C5）：' + pass.length + '/' + (pass.length + fail.length) + ' 通过 ===');
pass.forEach(t => console.log('  ✓ ' + t));
fail.forEach(t => console.log('  ✗ ' + t));
if (fail.length) process.exitCode = 1;
