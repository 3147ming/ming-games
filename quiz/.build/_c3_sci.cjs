/* C3 科学扩容：从指令文件提取 132 条 → 校验 → 追加到 POOLS.science
   - 全部改动走 rep() 锚点唯一性断言
   - 先用 --dry 只看校验结果，确认无误后再写盘                              */
const fs = require('fs');
const F = 'C:/Users/31474/OneDrive/Desktop/指令/知识问答-第三批C3科学扩容-WorkBuddy指令.md';
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
let ADD = ADD0;

/* ---------- 0.5 用户裁决：删 9 道否定题，补 9 道肯定式新题（保持 132） ---------- */
const DROP = [
  '做功的两个必要因素不包括？',
  '热传递的三种方式不包括？',
  '燃烧的三个条件中不包括？',
  '动物细胞没有、植物细胞有的结构是？',
  '人体四大基本组织不包括？',
  '传染病流行的三个环节不包括？',
  '种子萌发不需要的环境条件是？',
  '哺乳动物的特征不包括？',
  '鸟类适应飞行的特征不包括？'
];
const REPLACE = [
  ['同种电荷相互？', '排斥', 'science', '吸引|中和|绝缘',
    { exp: '电荷间相互作用规律：同种电荷相互排斥，异种电荷相互吸引。', src: '人教版初中物理' }],
  ['物理学中描述物体运动快慢的物理量是？', '速度', 'science', '加速度|位移|力',
    { exp: '速度等于路程与时间的比值，用来描述物体运动的快慢。', src: '人教版初中物理' }],
  ['自然界中硬度最大的天然物质是？', '金刚石', 'science', '石墨|石英|方解石',
    { exp: '金刚石（钻石）是自然界已知硬度最大的物质，莫氏硬度为 10。', src: '人教版初中化学' }],
  ['能使澄清石灰水变浑浊的气体是？', '二氧化碳', 'science', '氧气|氮气|氢气',
    { exp: '二氧化碳与氢氧化钙反应生成碳酸钙沉淀，使澄清石灰水变浑浊。', src: '人教版初中化学' }],
  ['鉴别硬水与软水常用的试剂是？', '肥皂水', 'science', '食盐水|酒精|白醋',
    { exp: '加入肥皂水，泡沫多浮渣少的是软水，泡沫少浮渣多的是硬水。', src: '人教版初中化学' }],
  ['人体消化淀粉的起始部位是？', '口腔', 'science', '胃|小肠|大肠',
    { exp: '唾液淀粉酶在口腔内开始分解淀粉，所以淀粉消化从口腔开始。', src: '人教版初中生物' }],
  ['人体中含量最多的物质（约占体重 60%~70%）是？', '水', 'science', '蛋白质|脂肪|糖类',
    { exp: '人体约 60%~70% 是水，水是一切生命活动的重要介质。', src: '人教版初中生物' }],
  ['人体生命活动的主要供能物质是？', '糖类', 'science', '维生素|水|无机盐',
    { exp: '糖类在人体内氧化分解快、供能直接，是主要的供能物质。', src: '人教版初中生物' }],
  ['地球上面积最大的大洋是？', '太平洋', 'science', '大西洋|印度洋|北冰洋',
    { exp: '太平洋面积约 1.8 亿平方千米，是地球上最大的大洋。', src: '人教版初中地理' }]
];
const dropped = ADD.filter(function (x) { return DROP.indexOf(x[0]) >= 0; });
if (dropped.length !== DROP.length) { console.log('✗ 待删否定题命中 ' + dropped.length + '/' + DROP.length + '，请核对题干'); process.exit(1); }
ADD = ADD.filter(function (x) { return DROP.indexOf(x[0]) < 0; }).concat(REPLACE);
console.log('按用户裁决：删否定题 =', dropped.length, '条 ｜ 补肯定题 =', REPLACE.length, '条 ｜ ADD 净 =', ADD.length);

/* ---------- 1. 读取旧池 ---------- */
let src = fs.readFileSync(TARGET, 'utf8');
const idx = src.indexOf('science:[');
if (idx < 0) { console.log('✗ 找不到 POOLS.science'); process.exit(1); }
const startBracket = idx + 'science:'.length;
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
console.log('=== C3 科学扩容校验 ===');
console.log('分组实际条数：', SEC_CNT.map(function (x) { return x[0] + '=' + x[1]; }).join(' / '));
console.log('ADD 条数 =', ADD.length, '（应为 132）');
console.log('旧 science =', OLD_ALL.length, '｜追加后 =', OLD_ALL.length + ADD.length, '（应为 150）');

let bad = 0;
// 3.1 validItem
const badItem = ADD.filter(function (x) { return !validItem(x); });
console.log('validItem 不合格 =', badItem.length, badItem.length ? JSON.stringify(badItem.slice(0, 5)) : '');
bad += badItem.length;
// 3.2 meta
const noMeta = ADD.filter(function (x) { return !(x[4] && x[4].exp && x[4].src); });
console.log('缺 exp/src =', noMeta.length, noMeta.length ? JSON.stringify(noMeta.map(function (x) { return x[0]; })) : '');
bad += noMeta.length;
// 3.3 ASCII 直双引号（U+0022）—— 只查内容字段，中文「」是允许的
const DQ = '"';
function hasDQ(s) { return String(s).indexOf(DQ) >= 0; }
const asciiQ = ADD.filter(function (x) {
  return hasDQ(x[0]) || hasDQ(x[1]) || hasDQ(x[3]) || hasDQ(x[4].exp) || hasDQ(x[4].src);
});
console.log('含 ASCII 双引号 =', asciiQ.length, asciiQ.length ? JSON.stringify(asciiQ.map(function (x) { return x[0]; })) : '');
bad += asciiQ.length;
// 3.4 否定式题干（宽口径：不包括/不需要/没有/不是/不属于/错误/不正确/除外）
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
// 3.7 近似重复（jaccard>0.6，不限答案；再补一组「同答案 + jaccard>0.4」）
console.log('--- 近似题排查（题干相似度>0.6 或 同答案>0.4）---');
let near = 0;
OLD_ALL.forEach(function (o) {
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

if (OLD_ALL.length + ADD.length !== 150) { console.log('✗ 最终总数 ' + (OLD_ALL.length + ADD.length) + ' ≠ 150，终止'); process.exit(1); }
if (bad) { console.log('✗ 校验有 ' + bad + ' 项不合格，未写盘'); process.exit(1); }
console.log('✓ 数据校验全部通过（否定式题干 ' + negQ.length + ' 条，见上方，待用户裁决是否写盘）');
if (DRY) { console.log('（--dry 模式，未写盘）'); process.exit(0); }

/* ---------- 4. 写盘：在 science 池末尾追加 ---------- */
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
if (src.indexOf(lastLineNoComma) < 0) { console.log('✗ 找不到 science 池最后一行文本'); process.exit(1); }
rep(lastLineNoComma, lastLineNoComma + ',\n' + rows.join('\n'), 'science-末尾');
fs.writeFileSync(TARGET, src, 'utf8');
console.log('✓ 已追加 ' + ADD.length + ' 题到 POOLS.science（旧 18 题未动）');
