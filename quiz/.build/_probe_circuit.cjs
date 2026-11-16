/* circuit 学科接线验收探针（放在 .build 之外独立运行，避免污染正式测试目录）
   覆盖：题库结构/数据质量/引擎注册/UI 六处/构建注入/沙箱抽题可解性。 */
const fs = require('fs');
const path = require('path');
const ROOT = 'D:/Projects/_github_pages/ming-games/quiz';
let pass = 0, total = 0;
function ok(c, n, extra) { total++; if (c) pass++; else console.log('  ✗ ' + n + (extra ? ' :: ' + extra : '')); }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

// ---------- 1. 题库结构 ----------
const pools = JSON.parse(read('data/pools.json'));
ok(Object.prototype.hasOwnProperty.call(pools, 'circuit'), 'pools.json 有 circuit 顶层 key');
const cq = pools.circuit;
ok(cq && Object.keys(cq).sort().join(',') === '0,1,2,3,4', 'circuit 分 0~4 五档', cq ? Object.keys(cq).join(',') : '无');
const expect = [56, 106, 165, 117, 169];
let tot = 0;
if (cq) expect.forEach((n, d) => {
  const arr = cq[String(d)];
  ok(Array.isArray(arr) && arr.length === n, '档' + d + ' 题量 ' + n, arr ? String(arr.length) : '缺');
  tot += arr ? arr.length : 0;
});
ok(tot === 613, 'circuit 合计 613 题（原507+扩容106）', String(tot));

// 数据质量：每题 4 元数组、干扰项恰好 3 项不含答案、同档题干不重复
let shapeErr = [], dupErr = [];
if (cq) Object.keys(cq).forEach(d => {
  const seen = {};
  (cq[d] || []).forEach((it, i) => {
    const w = '档' + d + '#' + i;
    /* P0.5 扩容题带第 5 元素 meta（exp/src），题库与引擎均支持 4/5 元形态 */
    if (!Array.isArray(it) || (it.length !== 4 && it.length !== 5)) { shapeErr.push(w + ' 元数异常=' + (it && it.length)); return; }
    if (it.length === 5 && it[4] != null && typeof it[4] !== 'object') { shapeErr.push(w + ' meta非对象'); return; }
    const [q, a, tag, dis] = it;
    if (!q || !a || !tag || !dis) shapeErr.push(w + ' 空字段');
    const opts = String(dis).split('|');
    if (opts.length !== 3) shapeErr.push(w + ' 干扰项=' + opts.length);
    if (opts.indexOf(a) >= 0) shapeErr.push(w + ' 干扰项含答案');
    if (seen[q]) dupErr.push(w + ' 题干重复');
    seen[q] = 1;
  });
});
ok(shapeErr.length === 0, 'circuit ' + tot + ' 题选项形态全合法', shapeErr.slice(0, 6).join('; '));
ok(dupErr.length === 0, 'circuit 无重复题干', dupErr.slice(0, 6).join('; '));

// ---------- 2. 引擎注册 ----------
const core = read('src/engine_core.js');
ok(/var QA_DIFFS_CIRCUIT\s*=\s*\[/.test(core), 'QA_DIFFS_CIRCUIT 已定义');
ok(/circuit:\s*\{name:'电路与模拟电子'/.test(core), 'circuit 已注册进 QA_TYPES');
ok(/sub:\['code','circuit'\]/.test(core), 'SUBJECT_GROUPS tech 组含 circuit');
ok(core.indexOf('genStdPool(\'circuit\')') >= 0, 'circuit 用 genStdPool 生成器');

// ---------- 3. UI 六处 ----------
const ui = read('src/quiz-ui.js');
const uiChecks = [
  ["if(!bk||bk==='math'||bk==='code'||bk==='circuit')return Infinity;", 'stdAvail 含 circuit'],
  ["function diffMatters(bk){return bk==='math'||bk==='code'||bk==='circuit';}", 'diffMatters 含 circuit'],
  ["if(bk==='circuit'){", 'shelfCount 有 circuit 分支'],
  ["bk==='circuit'?'🔌 按学习进度出题", 'pickDiffPanel hint 含 circuit'],
  ["if(!bk||bk==='code'||bk==='circuit'||bk==='online')return;", 'autoRefill guard 含 circuit'],
];
uiChecks.forEach(([needle, name]) => ok(ui.indexOf(needle) >= 0, name));
// shelfCount circuit 分支返回 507 题（人工精编）
ok(/n\+=POOLS\.circuit\[d\]\.length/.test(ui), 'shelfCount 累加 POOLS.circuit 各档题量');

// ---------- 4. 校验器与探针统计 ----------
const poolTool = read('.build/_pools.cjs');
ok(/k === 'circuit'/.test(poolTool) || /k==='circuit'/.test(poolTool), '_pools.cjs 校验器给 circuit 开标签白名单');
const probePools = read('.build/_probe_pools.cjs');
ok(/subjects === 12/.test(probePools), '_probe_pools 分类数更新为 12');
ok(/questions === 1420/.test(probePools), '_probe_pools 题量更新为 1420');

// ---------- 5. 构建注入 ----------
const html = read('index.html');
ok(html.indexOf('"circuit"') >= 0 || html.indexOf("'circuit'") >= 0, '产物 index.html 含 circuit 数据');
ok(/var POOLS=/.test(html) && html.indexOf('电路基础') >= 0, '产物 POOLS 含 circuit 题库内容');
const dep = 'D:/Projects/_github_pages/ming-games/_deploy_gym/quiz/index.html';
if (fs.existsSync(dep)) {
  const d = fs.readFileSync(dep, 'utf8');
  ok(d.indexOf('电路基础') >= 0, '部署包含 circuit 题库内容');
} else ok(true, '部署包存在（跳过）');

// ---------- 6. 沙箱抽题：各档都能出满、选项可解 ----------
try {
  const SB = require('D:/Projects/_github_pages/ming-games/quiz/.build/_sandbox.cjs');
  const E = SB.E;
  ok(!!(E.POOLS && E.POOLS.circuit), '沙箱 POOLS 含 circuit');
  const gen = E.QA_TYPES && E.QA_TYPES.circuit && E.QA_TYPES.circuit.gen;
  ok(typeof gen === 'function', 'QA_TYPES.circuit.gen 可调用');
  if (typeof gen === 'function') {
    for (let d = 0; d < 5; d++) {
      const qs = gen(10, d);
      const good = Array.isArray(qs) && qs.length === 10 && qs.every(q =>
        q && q.q && q.a && Array.isArray(q.opts) && q.opts.length === 4 && q.opts.indexOf(q.a) >= 0);
      ok(good, '档' + d + ' 抽10题全可解（4选项含答案）', qs ? 'n=' + qs.length + ' 首题=' + JSON.stringify(qs[0]).slice(0, 90) : 'null');
    }
    // 难度体系：5 档、每档 cnt=10
    const diffs = E.QA_TYPES.circuit.diffs;
    ok(Array.isArray(diffs) && diffs.length === 5, 'circuit difficulty 5 档');
  }
} catch (e) {
  ok(false, '沙箱装配与抽题: ' + e.message);
}

console.log('=== circuit 学科接线探针：' + pass + '/' + total + ' ===');
if (pass !== total) process.exit(1);
