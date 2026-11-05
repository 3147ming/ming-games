/* 在 stub 环境下加载 code_engine.js，校验 CODE_TOPICS 与 genSection 的按档位出题 */
const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync('D:/Projects/_github_pages/ming-games/quiz/.build/code_engine.js', 'utf8');

let lastQA = null;
function mkQA(p, a, opts, exp) {
  // 真实 mkQA 的精简版：带去重键所需字段
  var q = { q: p, a: a, opts: opts || null, exp: exp || null };
  return q;
}
function mkCodeQ(prompt, code, ans, alts, exp) {
  var a = String(ans), seen = {}, list = [];
  seen[a] = 1;
  (alts || []).forEach(function (x) { x = String(x); if (seen[x] || list.length >= 3) return; seen[x] = 1; list.push(x); });
  var n = Number(a);
  if (list.length < 3 && isFinite(n) && String(n) === a) {
    var k = 1;
    while (list.length < 3 && k < 60) {
      var d = Math.ceil(k / 2) * (k % 2 ? 1 : -1), w = String(n + d);
      if (!seen[w]) { seen[w] = 1; list.push(w); }
      k++;
    }
  }
  var q = mkQA(prompt, a, list, exp);
  q.code = code; q.kind = 'out';
  return q;
}
function mkCodeFill(prompt, code, ans, cands, exp) {
  var q = mkQA(prompt, ans, cands || [], exp);
  q.code = code; q.opts = null; q.fillin = 1; q.kind = 'fill';
  return q;
}
function randArr(n) { var a = []; for (var i = 0; i < n; i++) a.push(i); return a; }
var S = { _m: {}, getItem: function (k) { return this._m[k] || null; }, setItem: function (k, v) { this._m[k] = v; } };

const ctx = {
  console: console,
  Math: Math, Date: Date, JSON: JSON, parseInt: parseInt, parseFloat: parseFloat, isFinite: isFinite, Number: Number, String: String,
  ri: function (n) { return Math.floor(Math.random() * n); },
  shuffle: function (a) { return a; },
  riN: function (a, b) { return a + Math.floor(Math.random() * (b - a + 1)); },
  hexOf: function (n) { return n.toString(16).toUpperCase(); },
  binOf: function (n, w) { var s = n.toString(2); while (w && s.length < w) s = '0' + s; return s; },
  fact: function (n) { var r = 1; for (var i = 2; i <= n; i++) r *= i; return r; },
  fibOf: function (n) { var a = 1, b = 1; for (var i = 3; i <= n; i++) { var c = a + b; a = b; b = c; } return b; },
  binWrongs: function (s, n) { return randArr(n || 3); },
  bitCands: function () { return [1, 2, 3, 4]; },
  shiftCands: function () { return [1, 2, 3, 4]; },
  mkQA: mkQA, mkCodeQ: mkCodeQ, mkCodeFill: mkCodeFill,
  codeAllowedLangs: function () { return null; }, // 只学 C：返回 null → 不过滤语言（低档全 C）
  codeLoadRecent: function (k) { try { return JSON.parse(S.getItem(k) || '[]'); } catch (e) { return []; } },
  codeSaveRecent: function (k, a) { try { S.setItem(k, JSON.stringify(a.slice(0, 80))); } catch (e) {} },
  POOLS: { code: {} }, CODE_GEN: {}, CODE_GENX: {}, CODE_LANG_KEYS: ['c', 'python', 'java', 'js', 'sql', 'web', 'all'],
  tagGen: function (g, L) { var w = function () { var q = g(); if (q && !q.tag) q.tag = L; return q; }; w.lang = L; return w; },
  QA_TYPES: { code: { gen: function () { return []; } } }, // 兜底：返回空，迫使 genSection 自身池足够
  S: S,
  document: {}, window: {}
};
ctx.global = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx, { filename: 'code_engine.js' });

const TOPICS = ctx.CODE_TOPICS;
const byRank = {};
TOPICS.forEach(function (t) { t.ranks.forEach(function (r) { (byRank[r] = byRank[r] || []).push(t.k); }); });
console.log('CODE_TOPICS 总数=' + TOPICS.length);
Object.keys(byRank).sort().forEach(function (r) { console.log('  rank ' + r + ' (' + byRank[r].length + '): ' + byRank[r].join(' / ')); });

// 给每个 topic.gen 包一层，记录题来源知识点
TOPICS.forEach(function (t) { var og = t.gen; t.gen = function () { var q = og(); if (q) q.__k = t.k; return q; }; });

function rankOK(d) {
  var pool = TOPICS.filter(function (t) { return t.ranks.indexOf(d) >= 0; });
  return pool.map(function (t) { return t.k; });
}
let fail = 0;
[0, 1, 2, 3, 4].forEach(function (d) {
  var allowedSet = rankOK(d);
  var qs = ctx.QA_TYPES.code.genSection(40, d);
  var empty = qs.filter(function (q) { return !q || !q.q || q.a == null; }).length;
  var bad = qs.filter(function (q) { return q.__k && allowedSet.indexOf(q.__k) < 0; }).length;
  var langs = {};
  qs.forEach(function (q) { if (q.tag) langs[q.tag] = 1; });
  console.log('rank ' + d + ': 生成 ' + qs.length + ' 题, 空题=' + empty + ', 越档题=' + bad +
    ', 知识点=' + Array.from(new Set(qs.map(function (q) { return q.__k; }))).join('/') + ', lang=' + Object.keys(langs).join(','));
  if (qs.length < 40 || empty > 0) { console.error('  ✗ rank ' + d + ' 题量/空题不达标'); fail++; }
});
console.log(fail === 0 ? 'LOGIC TEST PASS' : 'LOGIC TEST FAIL (' + fail + ')');
process.exit(fail === 0 ? 0 : 1);
