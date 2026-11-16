/* 代码题「答案 ↔ 代码语义」穷举校验探针
 * 直接跑真实生成源码（code_engine.js），对目标生成器穷举其参数空间，
 * 用独立的 C 语义 oracle 算期望输出，比对生成器给出的 ans / 解析。
 * 防止再次出现「do-while 用 Math.min」「宏展开算错」这类答案与代码不符的错题。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = __dirname;
const ROOT = path.join(DIR, '..');
const pass = [], fail = [];
function ck(n, c, e) { (c ? pass : fail).push(n + (e ? ' :: ' + e : '')); }

function boot() {
  const core = fs.readFileSync(path.join(ROOT, 'src', 'engine_core.js'), 'utf8');
  const logic = fs.readFileSync(path.join(ROOT, 'src', 'logic.js'), 'utf8');
  const net = fs.readFileSync(path.join(ROOT, 'src', 'net.js'), 'utf8');
  const state = fs.readFileSync(path.join(ROOT, 'src', 'state.js'), 'utf8');
  const eng = fs.readFileSync(path.join(DIR, 'code_engine.js'), 'utf8');
  const prelude = `
var __store={};
var S={getItem:function(k){return Object.prototype.hasOwnProperty.call(__store,k)?__store[k]:null;},
       setItem:function(k,v){__store[k]=String(v);},removeItem:function(k){delete __store[k];}};
function shuffle(a){a=a.slice();for(var i=a.length-1;i>0;i--){var j=Math.floor(Math.random()*(i+1)),t=a[i];a[i]=a[j];a[j]=t;}return a;}
function ri(n){return Math.floor(Math.random()*n);}
function h(){return {};}function clearNode(){}function later(){return 0;}function esc(s){return String(s==null?'':s);}
var score=0,total=0,ok=0,qidx=0,qlist=[],locked=false,autoMode=false,selfRank=0,combo=0,wrongCombo=0,reviewMode=false,AUTO_TOTAL=10,UP_COMBO=2,DOWN_COMBO=2,selfWindow=[];
var curDiff=-1,curDiffLabel="",netStat=null;
var PROMO_STREAK=3,PROMO_SIZE=2,promoState='idle',promoStreak=0,promoKey='',promoRank=0,promoAsked=0,promoCorrect=0;
function qaDiffs(){return null;}function qaDiffDefault(){return 0;}function getCodeProfile(){return null;}
`;
  const ctx = { console, JSON, Math, Date, parseInt, parseFloat, String, Number, Array, Object, RegExp, isFinite, isNaN, setTimeout, clearTimeout };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(prelude + '\n' + logic + '\n;\n' + net + '\n;\n' + state + '\n;\n' + core + '\n' + eng + '\n', ctx, { filename: 'code-answer.js' });
  return ctx;
}

const E = boot();
function genOf(k) {
  return vm.runInContext('CODE_TOPICS.filter(function(t){return t.k===' + JSON.stringify(k) + ';})[0]', E);
}

// 用固定随机序列驱动 gen：把 riN 的每次取值钉死，便于穷举参数
function withSeq(fn, seq) {
  const orig = E.Math.random;
  let i = 0;
  E.Math.random = function () { return seq[i++ % seq.length]; };
  try { return fn(); } finally { E.Math.random = orig; }
}
// riN(a,b) = a + floor(rnd*(b-a+1))；给定目标值 v 反推 rnd（区间中点）
function rndFor(lo, hi, v) { return (v - lo + 0.5) / (hi - lo + 1); }

/* ---------- 1. do-while：int i=a; do{i++}while(i<b); 输出 max(a+1,b) ---------- */
{
  const g = genOf('do-while 至少一次');
  ck('存在 do-while 生成器', !!g && typeof g.gen === 'function');
  if (g && g.gen) {
    for (let a = 2; a <= 5; a++) {
      for (let b = 2; b <= 4; b++) {
        const q = withSeq(() => g.gen(), [rndFor(2, 5, a), rndFor(2, 4, b)]);
        const expect = String(Math.max(a + 1, b));
        const label = 'do-while a=' + a + ' b=' + b;
        ck(label + ' 答案=' + expect, q.a === expect,
          'got ' + q.a + ' / code=' + JSON.stringify(q.code));
        ck(label + ' 选项含正确答案', Array.isArray(q.opts) && q.opts.indexOf(expect) >= 0,
          'opts=' + JSON.stringify(q.opts));
        // 解析里的退出描述不能说反：a+1>=b 应「不成立/退出」，否则「继续循环」
        const a1ge = (a + 1) >= b;
        const expOk = a1ge
          ? !/继续循环/.test(q.exp)
          : /继续循环/.test(q.exp);
        ck(label + ' 解析走向正确', expOk, 'exp=' + q.exp);
      }
    }
  }
}

/* ---------- 2. 宏替换：#define SQ(x) x*x ; SQ(a+b) 展开 a+b*a+b ---------- */
{
  const g = genOf('宏文本替换陷阱');
  ck('存在宏替换生成器', !!g && typeof g.gen === 'function');
  if (g && g.gen) {
    for (let a = 1; a <= 4; a++) {
      for (let b = 1; b <= 4; b++) {
        const q = withSeq(() => g.gen(), [rndFor(1, 4, a), rndFor(1, 4, b)]);
        const expect = String(a + a * b + b);   // a + b*a + b（文本替换，无括号）
        const label = '宏 SQ(' + a + '+' + b + ')';
        ck(label + ' 答案=' + expect, q.a === expect,
          'got ' + q.a + ' / code=' + JSON.stringify(q.code));
        ck(label + ' 选项含正确答案', Array.isArray(q.opts) && q.opts.indexOf(expect) >= 0,
          'opts=' + JSON.stringify(q.opts));
        ck(label + ' 解析展开式正确', q.exp.indexOf(b + ' * ' + a) >= 0,
          'exp=' + q.exp);
      }
    }
  }
}

/* ---------- 3. 产物同步：index.html 内联的引擎块与源一致 ---------- */
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const eng = fs.readFileSync(path.join(DIR, 'code_engine.js'), 'utf8').trim();
  const i0 = html.indexOf('/*=== CODE_ENGINE_START ===*/');
  const i1 = html.indexOf('/*=== CODE_ENGINE_END ===*/');
  ck('产物含代码引擎区块', i0 >= 0 && i1 > i0);
  if (i0 >= 0 && i1 > i0) {
    const block = html.slice(i0, i1).trim();
    // 产物内可能因构建做转义，做关键片段比对即可
    ck('产物 do-while 用 Math.max', /do-while 至少一次[\s\S]{0,220}Math\.max\(a\+1,b\)/.test(html));
    ck('产物宏替换用 a+a*b+b', /宏文本替换陷阱[\s\S]{0,260}a\+a\*b\+b/.test(html));
  }
}

console.log('\n=== _probe_code_answer 代码题答案穷举校验 ' + pass.length + '/' + (pass.length + fail.length) + ' ===');
if (fail.length) {
  console.log('\n失败明细（前 20 条）：');
  fail.slice(0, 20).forEach(f => console.log('  ✗ ' + f));
  process.exitCode = 1;
} else {
  console.log('全部通过。');
}
