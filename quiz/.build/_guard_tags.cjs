/* 构建前置断言：语言闸 langGuard 把缺 tag 的题当作「通用」放行，
   所以任何一道题忘了打标签，严格语言档案就会漏题。
   本文件由 build.js 在写产物之前调用；不合规直接阻断构建，不产出 index.html。 */
const SB = require('./_sandbox.cjs');
const E = SB.E, store = SB.store;
const KEY = 'bt_qa_profile_code';
const errs = [];
const VALID = ['all'].concat(E.CODE_LANGS.map(function (x) { return x.k; }));

function tagOK(t) { return typeof t === 'string' && t.length > 0 && VALID.indexOf(t) >= 0; }

/* 1) 手写题库每题必须有合法语言标记 */
E.CODE_TASKS.forEach(function (t, i) {
  if (typeof t.lang !== 'string' || t.lang.length === 0) errs.push('CODE_TASKS#' + i + ' 缺 lang');
  else if (VALID.indexOf(t.lang) < 0) errs.push('CODE_TASKS#' + i + ' lang 非法: ' + t.lang);
});

/* 2) 每个出题模板必须带语言标记：上层靠它给题打 tag，漏了会被当作通用题放行 */
E.CODE_TOPICS.forEach(function (t, i) {
  if (!tagOK(t.lang)) errs.push('CODE_TOPICS#' + i + ' lang 非法: ' + String(t.lang));
});

/* 3) 出题链路断言：三态档案 × 三板块 × 五档，最终题目都必须带合法 tag */
let sampled = 0;
const SECTIONS = ['choice', 'fill', 'code'];
const PROFILES = [
  null,
  { done: true, langs: ['c'], level: 0, rank: 0 },
  { done: true, langs: ['js'], level: 0, rank: 0 },
  { done: true, all: true, langs: [], level: 0, rank: 0 }
];
SECTIONS.forEach(function (sec) {
  E.setSection(sec);
  PROFILES.forEach(function (p) {
    if (p) store[KEY] = JSON.stringify(p); else delete store[KEY];
    for (let d = 0; d < 5; d++) {
      E.sectionGen('code', 8, d).forEach(function (q) {
        sampled++;
        if (!tagOK(q.tag)) errs.push(sec + '/档' + d + ' tag 非法: ' + String(q.tag));
      });
    }
  });
});
delete store[KEY];

/* 4) 行为断言：严格 C 档案下 Java 题必须被拦下，C 题与通用题保留 */
store[KEY] = JSON.stringify({ done: true, langs: ['c'], level: 0, rank: 0 });
const out = E.langGuard([{ q: 'j', tag: 'java' }, { q: 'c', tag: 'c' }, { q: 'a', tag: 'all' }]);
if (out.length !== 2 || out.some(function (q) { return q.tag === 'java'; })) {
  errs.push('langGuard 未拦下 Java 题（返回 ' + out.length + ' 题）');
}
delete store[KEY];

if (errs.length) {
  console.error('语言标签断言失败（' + errs.length + ' 条），构建已阻断：');
  errs.slice(0, 12).forEach(function (x) { console.error('  - ' + x); });
  process.exit(1);
}
console.log('语言标签断言通过：手写题 ' + E.CODE_TASKS.length + ' 道 / 模板 '
  + E.CODE_TOPICS.length + ' 条 / 出题抽样 ' + sampled + ' 题 / langGuard 拦截正常');
