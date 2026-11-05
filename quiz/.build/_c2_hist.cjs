/* C2 历史扩容：从指令文件提取 130 条 → 校验 → 追加到 POOLS.history
   - 全部改动走 rep() 锚点唯一性断言
   - 先用 --dry 只看校验结果，确认无误后再写盘                        */
const fs = require('fs');
const F = 'C:/Users/31474/OneDrive/Desktop/指令/知识问答-第三批C2历史扩容-WorkBuddy指令.md';
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
  const lines = sec.split('\n').filter(function (l) { return /^\["/.test(l); });
  SEC_CNT.push([name, lines.length]);
  lines.forEach(function (l) {
    const core = l.replace(/,$/, '');
    ADD0.push(eval(core));
  });
});
let ADD = ADD0;

/* ---------- 1. 读取旧池 ---------- */
let src = fs.readFileSync(TARGET, 'utf8');
const idx = src.indexOf('history:[');
if (idx < 0) { console.log('✗ 找不到 POOLS.history'); process.exit(1); }
const startBracket = idx + 'history:'.length;
let depth = 0, end = -1;
for (let i = startBracket; i < src.length; i++) {
  if (src[i] === '[') depth++;
  else if (src[i] === ']') { depth--; if (depth === 0) { end = i; break; } }
}
const OLD_ALL = eval('[' + src.slice(startBracket + 1, end) + ']');

/* 剔除名单（用户决策）：
   ① 「第二次世界大战全面爆发的标志是？(德国闪击波兰)」—— 与旧题「…德国入侵哪国？(波兰)」近似 0.64
   ② 旧题「美国《独立宣言》发表于哪一年？」—— 与新增同题干同答案，用户决定删旧保新       */
const DROP_NEW = ['第二次世界大战全面爆发的标志是？'];
const DROP_OLD = ['美国《独立宣言》发表于哪一年？'];
let dropped = 0;
ADD = ADD.filter(function (x) { if (DROP_NEW.indexOf(x[0]) >= 0) { dropped++; return false; } return true; });
console.log('按用户决策剔除新增近似题 =', dropped, '条');

/* 补 2 题（用户决策：三项相抵后由我补 2 题凑到 150）—— 均为部编版口径、带 exp/src */
const EXTRA = [
  ['香港回归祖国是哪一年？', '1997', 'history', '1999|1993|2001',
    { exp: '1997 年 7 月 1 日中国政府对香港恢复行使主权，设立香港特别行政区。', src: '部编版初中历史' }],
  ['中国恢复在联合国合法席位是哪一年？', '1971', 'history', '1972|1979|1984',
    { exp: '1971 年 10 月第 26 届联合国大会恢复中华人民共和国在联合国的一切合法权利。', src: '部编版初中历史' }]
];
ADD = ADD.concat(EXTRA);
const OLD = OLD_ALL.filter(function (x) { return DROP_OLD.indexOf(x[0]) < 0; });
console.log('按用户决策删除旧题 =', OLD_ALL.length - OLD.length, '条（美国《独立宣言》重复项，删旧保新）');

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
console.log('=== C2 历史扩容校验 ===');
console.log('分组实际条数：', SEC_CNT.map(function (x) { return x[0] + '=' + x[1]; }).join(' / '));
console.log('ADD 条数 =', ADD.length, '（应为 130）');
console.log('旧 history =', OLD.length, '｜追加后 =', OLD.length + ADD.length);

let bad = 0;
// 3.1 validItem
const badItem = ADD.filter(function (x) { return !validItem(x); });
console.log('validItem 不合格 =', badItem.length, badItem.length ? JSON.stringify(badItem.slice(0, 5)) : '');
bad += badItem.length;
// 3.2 meta
const noMeta = ADD.filter(function (x) { return !(x[4] && x[4].exp && x[4].src); });
console.log('缺 exp/src =', noMeta.length, noMeta.length ? JSON.stringify(noMeta.map(function (x) { return x[0]; })) : '');
bad += noMeta.length;
// 3.3 ASCII 直双引号（U+0022）—— 只查内容字段，中文「」“”是允许的
const DQ = '"';
function hasDQ(s) { return String(s).indexOf(DQ) >= 0; }
const asciiQ = ADD.filter(function (x) {
  return hasDQ(x[0]) || hasDQ(x[1]) || hasDQ(x[3]) || hasDQ(x[4].exp) || hasDQ(x[4].src);
});
console.log('含 ASCII 双引号 =', asciiQ.length, asciiQ.length ? JSON.stringify(asciiQ.map(function (x) { return x[0]; })) : '');
bad += asciiQ.length;
// 3.4 否定式题干
const negQ = ADD.filter(function (x) { return /不是|不属于|没有|错误|不正确|除外/.test(x[0]); });
console.log('否定式题干 =', negQ.length, negQ.length ? JSON.stringify(negQ.map(function (x) { return x[0]; })) : '');
bad += negQ.length;
// 3.5 内部精确重复
const seen = {}, dup = [];
ADD.forEach(function (x) { if (seen[x[0]]) dup.push(x[0]); seen[x[0]] = 1; });
console.log('ADD 内部精确重复 =', dup.length, dup.length ? JSON.stringify(dup) : '');
bad += dup.length;
// 3.6 与旧题精确重复
const oldQ = {};
OLD.forEach(function (x) { oldQ[x[0]] = 1; });
const crossDup = ADD.filter(function (x) { return oldQ[x[0]]; });
console.log('与旧题精确重复 =', crossDup.length, crossDup.length ? JSON.stringify(crossDup.map(function (x) { return x[0]; })) : '');
// 3.7 近似重复（jaccard>0.6，不限答案；再补一组「同答案 + jaccard>0.4」）
console.log('--- 近似题排查（题干相似度>0.6 或 同答案>0.4）---');
let near = 0;
OLD.forEach(function (o) {
  ADD.forEach(function (n) {
    const j = jac(o[0], n[0]);
    const hit = j > 0.6 || (o[1] === n[1] && j > 0.4);
    if (hit) { near++; console.log('  [旧vs新]', j.toFixed(2), '|', o[0], '(' + o[1] + ')', '||', n[0], '(' + n[1] + ')'); }
  });
});
for (let i = 0; i < ADD.length; i++) {
  for (let j = i + 1; j < ADD.length; j++) {
    if (ADD[i][1] === ADD[j][1]) {
      const jj = jac(ADD[i][0], ADD[j][0]);
      if (jj > 0.5) { near++; console.log('  [新vs新]', jj.toFixed(2), '|', ADD[i][0], '||', ADD[j][0]); }
    }
  }
}
if (!near) console.log('  无');
// 3.8 答案极度集中（同答案 >=4 条，提示是否重复堆积）
const byAns = {};
ADD.forEach(function (x) { (byAns[x[1]] = byAns[x[1]] || []).push(x[0]); });
Object.keys(byAns).filter(function (k) { return byAns[k].length >= 4; }).forEach(function (k) {
  console.log('  ⚠ 同答案 ×' + byAns[k].length + '：' + k, '→', byAns[k].slice(0, 6).join(' / '));
});

if (OLD.length + ADD.length !== 150) { console.log('✗ 最终总数 ' + (OLD.length + ADD.length) + ' ≠ 150，终止'); process.exit(1); }
if (bad) { console.log('✗ 校验有 ' + bad + ' 项不合格，未写盘'); process.exit(1); }
console.log('✓ 数据校验全部通过');
if (DRY) { console.log('（--dry 模式，未写盘）'); process.exit(0); }

/* ---------- 4. 写盘：先删旧重复题，再在末尾追加 ---------- */
function rep(old, neo, tag) {
  const n = src.split(old).length - 1;
  if (n !== 1) { console.log('✗ 锚点[' + tag + ']命中 ' + n + ' 次'); process.exit(1); }
  src = src.replace(old, neo.replace(/\$/g, '$$$$'));
}
const lines = ADD.map(function (x) {
  return '  ' + JSON.stringify(x).replace(/^\[/, '[').replace(/\]$/, '],')
    .replace(/,"干扰/, ',"干扰');  // 保持原样即可
});
// 手工生成行：保留中文，不加额外转义
const rows = ADD.map(function (x) {
  const meta = '{"exp":' + JSON.stringify(x[4].exp) + ',"src":' + JSON.stringify(x[4].src) + '}';
  return '  [' + JSON.stringify(x[0]) + ',' + JSON.stringify(x[1]) + ',' + JSON.stringify(x[2]) + ','
    + JSON.stringify(x[3]) + ',' + meta + '],';
});
const lastOld = OLD[OLD.length - 1];
/* 注意：池最后一行没有尾逗号；且旧题里存在含转义双引号的题干，
   所以锚点必须「原样 + 行尾有无逗号都要兼容」，这里统一按「无逗号的行」处理。 */
const lastLineNoComma = src.slice(0, end).split('\n').filter(function (l) {
  return l.indexOf(JSON.stringify(lastOld[0])) >= 0;
})[0];
if (!lastLineNoComma) { console.log('✗ 找不到池最后一行的文本'); process.exit(1); }
rep(lastLineNoComma, lastLineNoComma.replace(/,?\s*$/, ',') + '\n' + rows.join('\n'), 'history-末尾');
/* 删旧重复题：锚点是它整行（旧题无 meta，行尾是 ],） */
DROP_OLD.forEach(function (q) {
  const it = OLD_ALL.filter(function (x) { return x[0] === q; })[0];
  if (!it) { console.log('✗ 找不到待删旧题：' + q); process.exit(1); }
  const lineWithoutComma = '  [' + JSON.stringify(it[0]) + ',' + JSON.stringify(it[1]) + ',' + JSON.stringify(it[2]) + ',' + JSON.stringify(it[3]) + ']';
  const hit = src.split('\n').filter(function (l) { return l.indexOf(lineWithoutComma) === 0; });
  if (hit.length !== 1) { console.log('✗ 锚点[删旧]命中 ' + hit.length + ' 次'); process.exit(1); }
  const idxLine = hit[0];
  rep(idxLine + '\n', '', '删旧-' + q);
});
fs.writeFileSync(TARGET, src, 'utf8');
console.log('✓ 已追加 ' + ADD.length + ' 题、删除 ' + DROP_OLD.length + ' 条旧重复题');
