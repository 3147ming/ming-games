/* M3 验收：题库 JSON 化后的数据自洽、镜像一致、产物注入正确。 */
const fs = require('fs');
const path = require('path');
const P = require('./_pools.cjs');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, total = 0;
function ok(c, n, extra) { total++; if (c) pass++; else console.log('  ✗ ' + n + (extra ? ' :: ' + extra : '')); }

const data = P.load();
const v = P.validate(data);
ok(v.errs.length === 0, '题库字段/选项/去重/标签校验全通过', v.errs.slice(0, 3).join('; '));
ok(v.stats.subjects === 11, '11 个分类', String(v.stats.subjects));
ok(v.stats.questions === 807, '807 道题', String(v.stats.questions));
ok(v.stats.withDistractors === 719, '719 道三干扰项题', String(v.stats.withDistractors));
ok(v.stats.withCandidates === 22, '22 道四候选题', String(v.stats.withCandidates));
ok(v.stats.plain === 66, '66 道走随机兜底', String(v.stats.plain));
ok(v.stats.meta === 580, '580 道带解析/来源', String(v.stats.meta));

/* code 分类的语言标签必须都在 UI 的 CODE_LANGS 白名单内 */
const SB = require('./_sandbox.cjs');
const VALID = ['all'].concat(SB.E.CODE_LANGS.map(function (x) { return x.k; }));
const codeTags = {};
Object.keys(data.code).forEach(function (lv) {
  data.code[lv].forEach(function (it) { codeTags[it[2]] = 1; });
});
const badTags = Object.keys(codeTags).filter(function (t) { return VALID.indexOf(t) < 0; });
ok(badTags.length === 0, 'code 题语言标签都在 CODE_LANGS 内', badTags.join(','));

/* 沙箱装配出的 POOLS 与 JSON 一致（镜像没漂） */
ok(JSON.stringify(SB.E.POOLS) === JSON.stringify(data), '沙箱 POOLS 与 JSON 一致');
ok(P.assertMatchesCore(fs.readFileSync(path.join(ROOT, 'src', 'engine_core.js'), 'utf8')) === true,
  'core 镜像一致性断言通过');

/* 产物里的 POOLS 必须由 JSON 序列化注入（不是旧字面量） */
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const want = P.js(data);
ok(html.indexOf(want) >= 0, '产物内嵌 var POOLS=<JSON>');
const a = html.indexOf('var POOLS=');
const b = html.indexOf('\n', a);
ok(html.slice(a, b) === want, '产物 POOLS 与 JSON 序列化逐字一致');
const buildSrc = fs.readFileSync(path.join(__dirname, 'build.js'), 'utf8');
ok(buildSrc.indexOf("require('./_pools.cjs')") >= 0, 'build.js 接入题库校验器');
ok(buildSrc.indexOf('POOLS.js(poolsData)') >= 0, 'build.js 用 JSON 序列化注入 POOLS');
ok(buildSrc.indexOf('POOLS.assertMatchesCore(core)') >= 0, 'build.js 强制镜像一致性');
/* 部署包同源 */
const dep = path.resolve(ROOT, '..', '_deploy_gym', 'quiz', 'index.html');
if (fs.existsSync(dep)) {
  const depHtml = fs.readFileSync(dep, 'utf8');
  const da = depHtml.indexOf('var POOLS=');
  ok(depHtml.slice(da, depHtml.indexOf('\n', da)) === want, '部署包 POOLS 同源');
} else { ok(true, '部署包存在性（本仓库内）'); }

/* 校验器拒绝坏数据（假阳性/假阴性双向自检） */
const bad = JSON.parse(JSON.stringify(data));
bad.geo[0][3] = '巴黎|马赛|尼斯';           // 干扰项里塞进答案 → 3 项含答案，形态非法
const badV = P.validate(bad);
ok(badV.errs.length > 0, '校验器能拦「干扰项含答案」');
const bad2 = JSON.parse(JSON.stringify(data));
bad2.geo.push(Array.from(bad2.geo[0]));      // 重复题干
ok(P.validate(bad2).errs.length > 0, '校验器能拦重复题干');
const bad3 = JSON.parse(JSON.stringify(data));
bad3.geo[0][1] = '';                          // 空答案
ok(P.validate(bad3).errs.length > 0, '校验器能拦空答案');
const bad4 = JSON.parse(JSON.stringify(data));
bad4.geo[0][2] = 'science';                   // 标签与分类不符
ok(P.validate(bad4).errs.length > 0, '校验器能拦错标标签');
ok(P.validate(data).errs.length === 0, '校验器对合法数据不误报');

console.log('=== 题库 JSON 化探针：' + pass + '/' + total + ' ===');
if (pass !== total) process.exit(1);
