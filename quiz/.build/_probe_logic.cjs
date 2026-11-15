/* Q3/P3 验收探针：纯逻辑层直接 require 跑单测（秒级，不启浏览器），并校验装配与 CSS。
   覆盖：SRS 间隔推进、降档门槛、干扰项生成、validItem、build/沙箱装配顺序、P3 样式。 */
const fs = require('fs');
const path = require('path');
const L = require('../src/logic.js');
const SRC = path.resolve(__dirname, '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
let pass = 0, total = 0;
function ok(cond, name) {
  total++;
  if (cond) { pass++; }
  else { console.log('  ✗ ' + name); }
}
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), name + '（实际 ' + JSON.stringify(a) + '）'); }

const DAY = 86400000;
/* ---------- SRS ---------- */
eq(L.SRS_INTERVALS, [1, 2, 4, 7, 15, 30], 'SRS 六级阶梯');
ok(L.DAY === DAY, 'DAY 常量');
const s0 = L.srsInit(0);
eq(s0, { lv: 0, due: DAY }, 'srsInit 首次到期 1 天');
ok(L.srsDue({ due: 100 }, 100) === true, 'srsDue 到点为真');
ok(L.srsDue({ due: 101 }, 100) === false, 'srsDue 未到点为假');
ok(L.srsDue(null, 100) === false, 'srsDue 无记录为假');
const s = L.srsInit(1000);
for (let i = 1; i <= 5; i++) {
  const mastered = L.srsAdvance(s, true, 1000);
  ok(s.lv === i && s.due === 1000 + L.SRS_INTERVALS[i] * DAY, '答对第 ' + i + ' 次升到 ' + L.SRS_INTERVALS[i] + ' 天');
  ok(mastered === (i === 5), '答对第 ' + i + ' 次掌握判定');
}
ok(L.srsAdvance(s, true, 1000) === true && s.lv === 5, '最高档再答对不越界');
eq(L.srsAdvance(s, false, 5000), false, '答错返回未掌握');
eq(s, { lv: 0, due: 5000 + DAY }, '答错重置到明天');
L.srsAdvance(s, true, 6000);
ok(s.lv === 1 && s.due === 6000 + 2 * DAY, '重置后答对回到 2 天档');

/* ---------- 降档门槛 ---------- */
const W6 = [0, 0, 0, 0, 0, 0];
eq(L.demoteDecision([0, 0, 0, 0, 0], 2, 0), { demote: false, cool: 0 }, '窗口不足 6 题不判');
eq(L.demoteDecision(W6, 2, 0), { demote: true, cool: 2 }, '满 6 题全错降档 + 冷却 2');
eq(L.demoteDecision([1, 1, 1, 0, 0, 0], 2, 0), { demote: false, cool: 0 }, '正确率 50% 不降');
eq(L.demoteDecision(W6, 0, 0), { demote: false, cool: 0 }, '已在最低档不降');
eq(L.demoteDecision(W6, 2, 2), { demote: false, cool: 1 }, '冷却中只减冷却');
eq(L.demoteDecision([], 2, 3), { demote: false, cool: 2 }, '答对时只减冷却');
eq(L.demoteDecision([0, 0, 0, 0], 2, 0, { min: 4, threshold: 0.4, cooldown: 5 }),
  { demote: true, cool: 5 }, '自定义门槛/冷却生效');
eq(L.demoteDecision([1, 0, 0, 0, 0, 0], 2, 0, { threshold: 0.1 }),
  { demote: false, cool: 0 }, '阈值收紧到 0.1 时 1/6 不降');

/* ---------- 干扰项 ---------- */
ok(L.ansClass('O(n log n)') === 'bigo', 'ansClass 复杂度');
ok(L.ansClass('-12.5') === 'num', 'ansClass 数值');
ok(L.ansClass('巴黎') === 'txt', 'ansClass 文本');
eq(L.fallbackWrongs('10'), ['11', '9', '12', '8', '13', '7'], '数值答案的邻居干扰项');
eq(L.fallbackWrongs('巴黎'), ['以上都不对', '不确定', '其他答案'], '文本答案的兜底干扰项');
eq(L.numericNeighbors('10', {}, 3), ['11', '9', '12'], 'numericNeighbors 补 3 个');
const seen = { 11: 1 };
eq(L.numericNeighbors('10', seen, 3), ['9', '12', '8'], 'numericNeighbors 跳过已占用');
ok(seen['9'] === 1 && seen['12'] === 1 && seen['8'] === 1, 'numericNeighbors 就地更新 seen');
eq(L.numericNeighbors('巴黎', {}, 3), [], '非数值答案不补邻居');
const nn = L.numericNeighbors('10', {}, 100);
ok(nn.length > 3 && new Set(nn).size === nn.length && nn.length < 40, 'numericNeighbors 不去重且有上限');

/* ---------- validItem ---------- */
ok(L.validItem({ q: '1+1', a: '2', opts: ['2', '3', '4', '5'] }) === true, '运行时四选项含答案');
ok(L.validItem({ q: '1+1', a: '9', opts: ['2', '3', '4', '5'] }) === false, '四选项不含答案');
ok(L.validItem({ q: '1+1', a: '2', opts: ['2', '3', '4'] }) === false, '三选项运行时题');
ok(L.validItem({ q: '1+1', a: '2', opts: ['2', '2', '4', '5'] }) === false, '重复选项');
ok(L.validItem([null, '巴黎', 'geo', '里昂|马赛|尼斯']) === true, '源静态题三干扰项');
ok(L.validItem({ a: '巴黎', 3: '巴黎|马赛|尼斯' }) === false, '源静态题干扰项含答案');
/* 数组写法答案在 [1]、没有 .a —— 抽离前就不参与该项检查，行为必须原样保留 */
ok(L.validItem([null, '巴黎', 'geo', '巴黎|马赛|尼斯']) === true, '源数组题不检查 [1]（与旧实现一致）');
ok(L.validItem({ q: '填空', a: '答案', type: 'fill' }) === true, '非选择题只要题干答案');
ok(L.validItem({ q: '填空', a: '  ', type: 'calc' }) === false, '非选择题空答案');
ok(L.validItem(null) === false, '空题对象');
ok(L.validItem({ q: 'x', a: 'y', opts: null }) === false, '选项为 null');

/* ---------- 与抽离前实现逐例对比（防行为漂移） ---------- */
/* 下面两个函数逐字保留抽离前的实现，只把外部常量改成参数，作为对照基准。 */
function refValidItem(it) {
  if (!it) return false;
  var _ty = it.type;
  if (_ty === 'fill' || _ty === 'calc' || _ty === 'experiment') {
    var _q = (it.q == null) ? '' : String(it.q).trim();
    var _a = (it.a == null) ? '' : String(it.a).trim();
    return !!(_q && _a);
  }
  var o = it.opts;
  if (!o && it[3] != null) o = String(it[3]).split('|');
  if (!Array.isArray(o) || o.length < 3) return false;
  if (new Set(o).size !== o.length) return false;
  if (it.opts) return o.length === 4 && o.indexOf(String(it.a)) >= 0;
  return o.length === 3 && o.indexOf(String(it.a)) < 0;
}
function refDemote(win, rank, cool, correct) {
  if (cool > 0) return { demote: false, cool: cool - 1 };
  if (!win || win.length < 6 || rank <= 0) return { demote: false, cool: 0 };
  var hit = 0;
  for (var i = 0; i < win.length; i++) { if (win[i]) hit++; }
  if (!correct && hit / win.length <= 0.4) return { demote: true, cool: 2 };
  return { demote: false, cool: 0 };
}
let dDrift = 0;
for (let i = 0; i < 200; i++) {
  const n = 1 + Math.floor(Math.random() * 14);
  const win = Array.from({ length: n }, () => (Math.random() < 0.5 ? 1 : 0));
  const rank = Math.floor(Math.random() * 5);
  const cool = Math.floor(Math.random() * 4);
  const correct = Math.random() < 0.5;
  const a = refDemote(win, rank, cool, correct);
  const b = L.demoteDecision(correct ? [] : win, rank, cool, { min: 6, threshold: 0.4, cooldown: 2 });
  if (JSON.stringify(a) !== JSON.stringify(b)) dDrift++;
}
ok(dDrift === 0, '降档判定与旧实现 200 组随机用例一致');
const POOL = ['A', 'B', 'C', 'D', 'E'];
const TYPES = [null, 'fill', 'calc', 'experiment', 'choice'];
let vDrift = 0;
for (let i = 0; i < 200; i++) {
  let it;
  if (i % 10 === 0) {
    it = [null, POOL[i % 5], 'geo', POOL.slice(0, 3).join('|')];
  } else {
    const len = Math.floor(Math.random() * 6);
    it = {
      q: Math.random() < 0.1 ? '' : '题干',
      a: POOL[Math.floor(Math.random() * POOL.length)],
      opts: Math.random() < 0.2 ? null : Array.from({ length: len }, () => POOL[Math.floor(Math.random() * POOL.length)])
    };
    const t = TYPES[Math.floor(Math.random() * TYPES.length)];
    if (t) it.type = t;
    if (i % 7 === 0) { delete it.opts; it[3] = POOL.slice(0, 3).join('|'); }
  }
  if (refValidItem(it) !== L.validItem(it)) vDrift++;
}
ok(vDrift === 0, 'validItem 与旧实现 200 组随机用例一致');

/* ---------- 装配 / P3 ---------- */
const build = fs.readFileSync(path.join(__dirname, 'build.js'), 'utf8');
const sandbox = fs.readFileSync(path.join(__dirname, '_sandbox.cjs'), 'utf8');
const core = read('engine_core.js');
const ui = read('quiz-ui.js');
const head = read('head.html');
ok(build.indexOf("readFileSync(path.join(SRC, 'logic.js')") >= 0, 'build.js 读 logic.js');
/* 装配链后面还会插入 net / state / 题库，这里只断言「logic 在 core 之前」这个顺序约束 */
/* 按整行取：表达式里含 '\n;\n' 字符串，不能用 [^;]+ 截 */
const htmlLine = (build.match(/^const html = .*$/m) || [''])[0];
const iLogic = htmlLine.indexOf('logic');
const iCore = htmlLine.indexOf('coreOut') >= 0 ? htmlLine.indexOf('coreOut') : htmlLine.indexOf('+ core');
ok(iLogic >= 0 && iCore > iLogic, 'logic 内联在 core 之前');
const sbExpr = (sandbox.match(/vm\.runInContext\(([^\n]*?)\);/) || [])[1] || '';
const sLogic = sbExpr.indexOf('logic');
const sCore = sbExpr.indexOf("' + core");
ok(sLogic >= 0 && sCore > sLogic, '沙箱同序装配（logic 在 core 之前）');
ok(core.indexOf('function validItem(it){return QALogic.validItem(it)}') >= 0, 'core 委托 validItem');
ok(core.indexOf('function srsAdvance(rec,correct){') >= 0 && core.indexOf('QALogic.srsAdvance(s,correct,Date.now())') >= 0, 'core 委托 SRS');
ok(ui.indexOf('QALogic.demoteDecision(') >= 0, 'UI 委托降档判定');
ok(head.indexOf('body::before') >= 0 && head.indexOf('pointer-events:none') >= 0, 'P3 背景合成层');
ok(head.indexOf('background-attachment:fixed') < 0, 'P3 去掉 fixed 背景');
ok(head.indexOf('@supports ((backdrop-filter:blur(12px))') >= 0, 'P3 顶栏 @supports 兜底');

/* ---------- 沙箱内委托确实生效 ---------- */
const SB = require('./_sandbox.cjs');
ok(SB.E.validItem({ q: 'x', a: '2', opts: ['2', '3', '4', '5'] }) === true, '沙箱内 validItem 委托可用');
ok(typeof SB.ctx.QALogic === 'object' && typeof SB.ctx.QALogic.srsAdvance === 'function', '沙箱内挂上 QALogic');

console.log('=== 纯逻辑探针：' + pass + '/' + total + ' ===');
if (pass !== total) process.exit(1);
