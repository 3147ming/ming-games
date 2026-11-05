/* C2 验收：history 池完整性 + 透传链路（走 _sandbox.cjs 的 Node vm） */
const { E } = require('./_sandbox.cjs');
let pass = 0, fail = 0;
function ck(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra === undefined ? '' : '| ' + extra); }
}

const P = E.POOLS.history;
console.log('=== C2 历史扩容验收 ===');

/* 1. 题数与 pools 完整性 */
ck('history 池 = 150 题', P.length === 150, P.length);
// stdCount 属 UI 层（quiz-ui.js），由浏览器探针 _probe_c2 断言书架「150 题」

/* 2. validItem 全过（源干扰项口径：3 个且不含答案） */
const badItem = P.filter(function (x) { return !E.validItem(x); });
ck('validItem 0 不合格', badItem.length === 0, badItem.length + ' 条：' + JSON.stringify(badItem.slice(0, 3)));

/* 3. 题干不重复 */
const seen = {}, dup = [];
P.forEach(function (x) { if (seen[x[0]]) dup.push(x[0]); seen[x[0]] = 1; });
ck('无重复题干', dup.length === 0, JSON.stringify(dup));

/* 4. 新增部分（带 meta 的）全带 exp/src */
const withMeta = P.filter(function (x) { return x[4]; });
ck('带 meta 的题 = 132（新增 130 + 我补 2）', withMeta.length === 132, withMeta.length);
const noExp = withMeta.filter(function (x) { return !x[4].exp || !x[4].src; });
ck('新增题全带 exp/src', noExp.length === 0, JSON.stringify(noExp.map(function (x) { return x[0]; })));

/* 5. 新增题无 ASCII 直双引号（旧题不动，只看新增） */
const dq = withMeta.filter(function (x) {
  return x[0].indexOf('"') >= 0 || x[1].indexOf('"') >= 0 || x[3].indexOf('"') >= 0
    || x[4].exp.indexOf('"') >= 0 || x[4].src.indexOf('"') >= 0;
});
ck('新增题无 ASCII 双引号', dq.length === 0, JSON.stringify(dq.map(function (x) { return x[0]; })));

/* 6. 新增题无否定式题干 */
const neg = withMeta.filter(function (x) { return /不是|不属于|没有|错误|不正确|除外/.test(x[0]); });
ck('新增题无否定式题干', neg.length === 0, JSON.stringify(neg.map(function (x) { return x[0]; })));

/* 7. mkFromPool 透传 exp/src */
const sample = P.filter(function (x) { return x[0] === '第一次世界大战的导火线是？'; })[0];
ck('存在新题「第一次世界大战的导火线是？」', !!sample, sample && sample[0]);
if (sample) {
  const q = E.mkFromPool(sample, P);
  ck('mkFromPool 透传 exp', q && !!q.exp && q.exp.indexOf('萨拉热窝') >= 0, q && q.exp);
  ck('mkFromPool 透传 src', q && q.src === '部编版初中历史', q && q.src);
  ck('mkFromPool 答案正确', q && q.a === '萨拉热窝事件', q && q.a);
}

/* 8. 剔除项确认不在池内 */
ck('已剔除「第二次世界大战全面爆发的标志是？(德国闪击波兰)」',
  !P.some(function (x) { return x[0] === '第二次世界大战全面爆发的标志是？'; }));
ck('旧重复题已删、新《独立宣言》题在（带 meta）',
  P.filter(function (x) { return x[0] === '美国《独立宣言》发表于哪一年？'; }).length === 1
  && P.filter(function (x) { return x[0] === '美国《独立宣言》发表于哪一年？'; })[0][4]);

/* 9. 出题链路：20 题局无重复、选项 4 个且含答案 */
const gen = E.genStdPool('history');
const out = gen(20, 0);
ck('gen(20) 出满 20 题', out.length === 20, out.length);
ck('同局题干不重复', new Set(out.map(function (x) { return x.q; })).size === out.length,
  new Set(out.map(function (x) { return x.q; })).size + '/' + out.length);
ck('每题 4 个选项且互不相同', out.every(function (x) { return x.opts.length === 4 && new Set(x.opts).size === 4; }));
ck('每题选项含答案', out.every(function (x) { return x.opts.indexOf(String(x.a)) >= 0; }));
const metas = out.filter(function (x) { return x.exp && x.src; }).length;
console.log('  · 本局带解析与来源的题 =', metas + '/' + out.length, '（旧 18 题无 meta 属正常）');

console.log('\n=== C2 验收：' + pass + '/' + (pass + fail) + ' 通过 ===');
process.exit(fail ? 1 : 0);
