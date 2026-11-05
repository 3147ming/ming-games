/* P0-1：重建 POOLS —— 给 172 道非 code 静态题补齐「每题自带同质干扰项」opts，
   并下线 5 道否定题（不包括/不是/不属于）。code 题原样保留 lang+opts。
   仅改 .build/engine_core.js；quiz-ui.js 由 build.js 重新拼装。
   brace-match 取整块 → vm 求值 → 按分类重建文本 → 整块替换（锚点唯一性校验）。 */
const fs = require('fs');
const vm = require('vm');
const F = '.build/engine_core.js';
let src = fs.readFileSync(F, 'utf8');

// 1) 取出 POOLS 整块
const startTag = 'var POOLS=';
const si = src.indexOf(startTag);
if (si < 0) { console.error('POOLS not found'); process.exit(1); }
let i = si + startTag.length, depth = 0, end = -1;
for (; i < src.length; i++) {
  const c = src[i];
  if (c === '{') depth++;
  else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
}
if (end < 0) { console.error('POOLS brace match failed'); process.exit(1); }
const objText = src.slice(si + startTag.length, end + 1);
const before = src.slice(0, si);
const after = src.slice(end + 1);
if (after[0] !== ';') { console.error('POOLS 闭合后非分号: ' + after.slice(0,10)); process.exit(1); }
const POOLS = vm.runInNewContext('(' + objText + ')', {});

// 2) 干扰项构造（复刻 ansClass + 长度相近优先）
function ansClass(s){ s=String(s);
  if(/^O\(/.test(s)) return 'bigo';
  if(/^-?\d+(\.\d+)?$/.test(s)) return 'num';
  return 'txt'; }
function buildOpts(catAnswers, ans){
  const a = String(ans);
  const cls = ansClass(a);
  const pool = catAnswers.filter(function(w){ return String(w)!==a; });
  const sameCls = pool.filter(function(w){ return ansClass(w)===cls; });
  const rest = pool.filter(function(w){ return ansClass(w)!==cls; });
  function near(arr){ return arr.slice().sort(function(x,y){ return Math.abs(String(x).length-String(a).length) - Math.abs(String(y).length-String(a).length); }); }
  let cand = (cls==='txt'? near(sameCls) : sameCls).concat(near(rest));
  const seen = {}; seen[a]=1; const out=[];
  cand.forEach(function(w){ w=String(w); if(out.length>=3) return; if(seen[w]) return; seen[w]=1; out.push(w); });
  if (out.length<3){ rest.concat(sameCls).forEach(function(w){ w=String(w); if(out.length>=3) return; if(seen[w]) return; seen[w]=1; out.push(w); }); }
  return out;
}

// 3) 明确下线这 5 道否定题（精确匹配题干，避免误伤「程序错误」这类名词）
const REMOVE = [
  '中国古代"四大发明"不包括下列哪项？',
  '网球"大满贯"不包括下列哪项？',
  '中国"八大菜系"不包括下列哪项？',
  '啤酒的主要原料不包括下列哪项？',
  '以下哪个不是编程语言？'
];
function isRemove(q){ return REMOVE.indexOf(String(q).replace(/\\"/g,'"'))>=0; }
// 兼容：POOLS 里字符串用的是转义双引号 \" ，与上面的普通双引号不同，统一比对角
function eqQ(a,b){ return String(a).replace(/\\"/g,'"')===String(b).replace(/\\"/g,'"'); }
function shouldRemove(q){ return REMOVE.some(function(r){ return eqQ(q,r); }); }

// 4) 重建文本
function jq(s){ return JSON.stringify(s); }
function itemLine(it){
  let s = '[' + jq(it[0]) + ',' + jq(it[1]);
  if (it[2]!==undefined) s += ',' + jq(it[2]);
  if (it[3]!==undefined) s += ',' + jq(it[3]);
  s += ']';
  return s;
}
let block = 'var POOLS={\n';
const cats = Object.keys(POOLS);
cats.forEach(function(cat, ci){
  if (cat === 'code'){
    block += 'code:{';
    const ranks = Object.keys(POOLS.code);
    ranks.forEach(function(rk, ri){
      const kept = POOLS.code[rk].filter(function(it){ return !shouldRemove(it[0]); });
      block += (ri? ',':'') + '\n ' + jq(rk) + ':[' + kept.map(itemLine).join(',') + ']';
    });
    block += '}';
  } else {
    const answers = POOLS[cat].map(function(it){ return it[1]; });
    const kept = POOLS[cat].filter(function(it){ return !shouldRemove(it[0]); });
    block += cat + ':[' + kept.map(function(it){
      const opts = buildOpts(answers, it[1]);
      // 非 code 题结构 [q,a,tag,opts]：第 2 元素用分类 tag（占位避免 JSON 丢弃 undefined 导致 opts 错位到 item[2]），
      // 第 4 元素 opts 与 mkFromPool 的 item[3] 约定一致。
      const ni = [it[0], it[1], cat, opts.length===3 ? opts.join('|') : undefined];
      return '\n  ' + itemLine(ni);
    }).join(',') + '\n ]';
  }
  block += (ci<cats.length-1? ',':'') + '\n';
});
block += '};';

// 5) 自检：重新求值，断言 172 道非 code 题每题干扰项 3 个/唯一/不含答案，且无残留否定题
const POOLS2 = vm.runInNewContext('(' + block.slice('var POOLS='.length, block.length-1) + ')', {});
let total=0, fail=0, negLeft=0;
Object.keys(POOLS2).forEach(function(c){
  if (c==='code') return; // code 为生成题，不在 172 静态题范围，且本就有 lang/opts 约定
  POOLS2[c].forEach(function(it){
    total++;
    if (shouldRemove(it[0])) { negLeft++; return; }
    if (it[3]===undefined) { fail++; return; }
    const o = String(it[3]).split('|');
    const ok = o.length===3 && new Set(o).size===3 && o.indexOf(String(it[1]))<0 &&
               o.every(function(x){ return String(x).trim()!==''; });
    if(!ok) fail++;
  });
});
console.log('重建后（非 code）：题数='+total+' 干扰项失败='+fail+' 残留否定题='+negLeft);
if (fail>0 || negLeft>0){ console.error('自检未通过'); process.exit(1); }

// 6) 锚点唯一性
if (src.split('var POOLS=').length-1 !== 1){ console.error('锚点出现多次'); process.exit(1); }

// 7) 写回
fs.writeFileSync(F, before + block + after, 'utf8');
console.log('OK 已写回 engine_core.js，字节='+ (before+block+after).length);
