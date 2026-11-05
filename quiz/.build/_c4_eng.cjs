/* C4 英语扩容：从指令文件提取 136 条 → 校验 → 追加到 POOLS.english
   - 全部改动走 rep() 锚点唯一性断言
   - 先用 --dry 只看校验结果，确认无误后再写盘                              */
const fs = require('fs');
const F = 'C:/Users/31474/OneDrive/Desktop/指令/知识问答-第三批C4英语扩容-WorkBuddy指令.md';
const TARGET = '.build/engine_core.js';
const DRY = process.argv.indexOf('--dry') >= 0;

/* ---------- 0. 从指令提取 ADD ---------- */
const raw = fs.readFileSync(F, 'utf8');
const body = raw.split('## 块1')[1].split('## 块2')[0];
const secs = body.split(/\n(?=### )/).slice(1);
const ADD0 = [];
const SEC_CNT = [];
secs.forEach(function (sec) {
  const name = (sec.match(/^### (.*?)（/) || [])[1];
  const lines = sec.split('\n').filter(function (l) { return /^\s*\["/.test(l); });
  SEC_CNT.push([name, lines.length]);
  lines.forEach(function (l) {
    const core = l.replace(/,\s*$/, '');
    ADD0.push(eval(core));
  });
});
const ADD = ADD0;

/* ---------- 1. 读取旧池 ---------- */
let src = fs.readFileSync(TARGET, 'utf8');
const idx = src.indexOf('english:[');
if (idx < 0) { console.log('✗ 找不到 POOLS.english'); process.exit(1); }
const startBracket = idx + 'english:'.length;
let depth = 0, end = -1;
for (let i = startBracket; i < src.length; i++) {
  if (src[i] === '[') depth++;
  else if (src[i] === ']') { depth--; if (depth === 0) { end = i; break; } }
}
const OLD_ALL = eval('[' + src.slice(startBracket + 1, end) + ']');

/* ---------- 2. 工具 ---------- */
function validItem(it) {
  const o = String(it[3]).split('|');
  if (o.length !== 3) return false;
  if (new Set(o).size !== o.length) return false;
  return o.indexOf(String(it[1])) < 0;
}
function bigram(s) { const o = {}; for (let i = 0; i < s.length - 1; i++) o[s.slice(i, i + 2)] = 1; return o; }
function jac(a, b) {
  const A = bigram(a), B = bigram(b); let inter = 0;
  for (const k in A) if (B[k]) inter++;
  return inter / (Object.keys(A).length + Object.keys(B).length - inter);
}

/* ---------- 3. 校验 ---------- */
console.log('=== C4 英语扩容校验 ===');
console.log('分组实际条数：', SEC_CNT.map(function (x) { return x[0] + '=' + x[1]; }).join(' / '));
const sumSec = SEC_CNT.reduce(function (a, x) { return a + x[1]; }, 0);
console.log('分组合计 =', sumSec, '（头条要求 136）');
console.log('ADD 条数 =', ADD.length, '（应为 136）');
console.log('旧 english =', OLD_ALL.length, '｜追加后 =', OLD_ALL.length + ADD.length, '（应为 150）');

let bad = 0;
// 3.1 validItem
const badItem = ADD.filter(function (x) { return !validItem(x); });
console.log('validItem 不合格 =', badItem.length, badItem.length ? JSON.stringify(badItem.slice(0, 5)) : '');
bad += badItem.length;
// 3.2 meta
const noMeta = ADD.filter(function (x) { return !(x[4] && x[4].exp && x[4].src); });
console.log('缺 exp/src =', noMeta.length, noMeta.length ? JSON.stringify(noMeta.map(function (x) { return x[0]; })) : '');
bad += noMeta.length;
// 3.3 ASCII 直双引号：题干仅允许「"词"的英文是？」成对引号；答案/干扰项不得含 "。
//    注意：exp/src 里作者刻意用 "英文词" 做强调（源文件为合法转义 \"），属正常展示，放行。
const DQ = '"';
function hasDQ(s) { return String(s).indexOf(DQ) >= 0; }
const asciiQ = ADD.filter(function (x) {
  if (!/^"[^"]+"的英文是？$/.test(x[0])) return true; // 题干非预期引号形态
  return hasDQ(x[1]) || hasDQ(x[3]); // 答案与干扰项不得含裸双引号
});
console.log('含非法 ASCII 双引号 =', asciiQ.length, asciiQ.length ? JSON.stringify(asciiQ.map(function (x) { return x[0]; })) : '');
bad += asciiQ.length;
// 3.4 否定式题干（宽口径）
const negQ = ADD.filter(function (x) { return /不包括|不需要|没有|不是|不属于|错误|不正确|除外/.test(x[0]); });
console.log('否定式题干（宽口径）=', negQ.length, negQ.length ? JSON.stringify(negQ.map(function (x) { return x[0]; })) : '');
// 3.5 内部精确重复
const seen = {}, dup = [];
ADD.forEach(function (x) { if (seen[x[0]]) dup.push(x[0]); seen[x[0]] = 1; });
console.log('ADD 内部精确重复 =', dup.length, dup.length ? JSON.stringify(dup) : '');
bad += dup.length;
// 3.6 与旧题精确重复
const oldQ = {};
OLD_ALL.forEach(function (x) { oldQ[x[0]] = 1; });
const crossDup = ADD.filter(function (x) { return oldQ[x[0]]; });
console.log('与旧题精确重复 =', crossDup.length, crossDup.length ? JSON.stringify(crossDup.map(function (x) { return x[0]; })) : '');
bad += crossDup.length;
// 3.7 近似重复（同答案 + 题干相似>0.4）
console.log('--- 近似题排查（同答案 + 题干相似>0.4）---');
let near = 0;
OLD_ALL.forEach(function (o) {
  ADD.forEach(function (n) {
    if (o[1] === n[1]) { const j = jac(o[0], n[0]); if (j > 0.4) { near++; console.log('  [旧vs新]', j.toFixed(2), '|', o[0], '||', n[0]); } }
  });
});
for (let i = 0; i < ADD.length; i++) {
  for (let j = i + 1; j < ADD.length; j++) {
    if (ADD[i][1] === ADD[j][1]) { const jj = jac(ADD[i][0], ADD[j][0]); if (jj > 0.5) { near++; console.log('  [新vs新]', jj.toFixed(2), '|', ADD[i][0], '||', ADD[j][0]); } }
  }
}
if (!near) console.log('  无');
// 3.8 同答案堆积（>=4 提示）
const byAns = {};
ADD.forEach(function (x) { (byAns[x[1]] = byAns[x[1]] || []).push(x[0]); });
Object.keys(byAns).filter(function (k) { return byAns[k].length >= 4; }).forEach(function (k) {
  console.log('  ⚠ 同答案 ×' + byAns[k].length + '：' + k, '→', byAns[k].slice(0, 6).join(' / '));
});

if (sumSec !== 136) { console.log('✗ 分组合计 ' + sumSec + ' ≠ 136，终止'); process.exit(1); }
if (OLD_ALL.length + ADD.length !== 150) { console.log('✗ 最终总数 ' + (OLD_ALL.length + ADD.length) + ' ≠ 150，终止'); process.exit(1); }
if (bad) { console.log('✗ 校验有 ' + bad + ' 项不合格，未写盘'); process.exit(1); }
console.log('✓ 数据校验全部通过（否定式题干 ' + negQ.length + ' 条）');
if (DRY) { console.log('（--dry 模式，未写盘）'); process.exit(0); }

/* ---------- 4. 写盘：在 english 池末尾追加 ---------- */
function rep(old, neo, tag) {
  const n = src.split(old).length - 1;
  if (n !== 1) { console.log('✗ 锚点[' + tag + ']命中 ' + n + ' 次'); process.exit(1); }
  src = src.replace(old, neo.replace(/\$/g, '$$$$'));
}
const rows = ADD.map(function (x) {
  const meta = '{"exp":' + JSON.stringify(x[4].exp) + ',"src":' + JSON.stringify(x[4].src) + '}';
  return '  [' + JSON.stringify(x[0]) + ',' + JSON.stringify(x[1]) + ',' + JSON.stringify(x[2]) + ','
    + JSON.stringify(x[3]) + ',' + meta + '],';
});
const lastOld = OLD_ALL[OLD_ALL.length - 1];
/* 旧池最后一行没有尾逗号；锚点取该行（无逗号） */
const lastLineNoComma = '  [' + JSON.stringify(lastOld[0]) + ',' + JSON.stringify(lastOld[1]) + ','
  + JSON.stringify(lastOld[2]) + ',' + JSON.stringify(lastOld[3]) + ']';
if (src.indexOf(lastLineNoComma) < 0) { console.log('✗ 找不到 english 池最后一行文本'); process.exit(1); }
rep(lastLineNoComma, lastLineNoComma + ',\n' + rows.join('\n'), 'english-末尾');
fs.writeFileSync(TARGET, src, 'utf8');
console.log('✓ 已追加 ' + ADD.length + ' 题到 POOLS.english（旧 14 题未动）');
