/* Q1 验收：状态合法性纯函数、唯一写入口、UI 写点收编、装配与产物。 */
const fs = require('fs');
const path = require('path');
const L = require('../src/logic.js');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, total = 0;
function ok(c, n, extra) { total++; if (c) pass++; else console.log('  ✗ ' + n + (extra ? ' :: ' + extra : '')); }
function throws(fn, n) { let t = false; try { fn(); } catch (e) { t = true; } ok(t, n); }

const GOOD = {
  autoMode: false, reviewMode: false, handMode: false, quizOver: false,
  locked: false, promoState: 'idle', qaSection: 'choice', customMixed: false
};
ok(L.validateState(GOOD) === true, '合法初始状态通过');
ok(L.validateState(Object.assign({}, GOOD, { autoMode: true, handMode: true, qaSection: 'code', promoState: 'challenge' })) === true,
  '无限模式 + 手写代码 + 挑战中 是合法组合');
throws(() => L.validateState(Object.assign({}, GOOD, { autoMode: true, reviewMode: true })), '拦下 autoMode && reviewMode');
throws(() => L.validateState(Object.assign({}, GOOD, { reviewMode: true, handMode: true })), '拦下 reviewMode && handMode');
throws(() => L.validateState(Object.assign({}, GOOD, { qaSection: 'quiz' })), '拦下非法板块');
throws(() => L.validateState(Object.assign({}, GOOD, { promoState: '' })), '拦下空挑战状态');
throws(() => L.validateState(Object.assign({}, GOOD, { locked: 1 })), '拦下非布尔标志');
throws(() => L.validateState(null), '拦下空快照');
ok(L.QA_BOOL_KEYS.length === 6 && L.QA_SECTIONS.length === 3, '布尔字段与板块枚举齐全');

/* 沙箱：写入口真的把值写回全局镜像，且实时快照不被直接赋值污染 */
const SB = require('./_sandbox.cjs');
const ctx = SB.ctx;
ok(typeof ctx.setQAState === 'function' && typeof ctx.qaState === 'function' && typeof ctx.assertQAState === 'function',
  '沙箱挂上 setQAState / qaState / assertQAState');
const s1 = ctx.setQAState({ autoMode: true, qaSection: 'fill', promoState: 'challenge', locked: true }, 'probe');
ok(s1.autoMode === true && s1.qaSection === 'fill' && s1.promoState === 'challenge' && s1.locked === true, '写入口返回合并快照');
ok(ctx.autoMode === true && ctx.qaSection === 'fill' && ctx.promoState === 'challenge' && ctx.locked === true,
  '写入口同步 8 个全局镜像');
ok(JSON.stringify(ctx.QA_STATE) === JSON.stringify(s1), 'QA_STATE 保存最近一次快照');
ctx.reviewMode = false;
ctx.autoMode = false;
const s2 = ctx.qaState();
ok(s2.autoMode === false && s2.qaSection === 'fill', 'qaState 实时读真实变量（探针直接赋值不失配）');
throws(() => ctx.setQAState({ autoMode: true, reviewMode: true }), '写入口拦截非法组合');
throws(() => ctx.setQAState({ notAState: 1 }), '写入口拒绝未登记字段');
ok(ctx.assertQAState('probe') !== null, '关键入口断言可用');
/* 复位，避免影响同一进程里后续断言 */
ctx.setQAState({ autoMode: false, qaSection: 'choice', promoState: 'idle', locked: false });

/* 源码：UI 不再直接给 8 个标志赋值 */
const ui = fs.readFileSync(path.join(ROOT, 'src', 'quiz-ui.js'), 'utf8');
const re = /\b(autoMode|reviewMode|handMode|quizOver|locked|promoState|qaSection|customMixed)\s*=[^=]/g;
const lines = ui.split('\n');
const leftovers = [];
lines.forEach(function (ln, i) {
  if (/^\s*(\/\/|\/\*|\*)/.test(ln)) return;
  re.lastIndex = 0;
  if (re.test(ln)) leftovers.push((i + 1) + ': ' + ln.trim().slice(0, 80));
});
ok(leftovers.length === 0, 'UI 里 8 个标志的写点已全部收编', leftovers.join(' | '));
const setCalls = (ui.match(/setQAState\(\{/g) || []).length;
ok(setCalls >= 25, '写入口调用覆盖主要生命周期', String(setCalls));
ok(ui.indexOf("assertQAState('showQuestion')") >= 0, 'showQuestion 入口有即时断言');
ok(ui.indexOf('var qaSection=') < 0 && ui.indexOf('var handMode=') < 0, 'UI 不再局部声明状态标志');

/* 装配 / 产物 */
const build = fs.readFileSync(path.join(__dirname, 'build.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
ok(build.indexOf("'state.js'") >= 0, 'build.js 内联 state.js');
ok(build.indexOf("+ state + '\\n;\\n' + coreOut") >= 0, 'state.js 排在 core 之前');
ok(html.indexOf('function setQAState(patch,ctx){') >= 0, '产物含唯一写入口');
ok(html.indexOf('var QA_STATE_KEYS=') >= 0, '产物含状态字段清单');
ok(html.indexOf('QALogic.validateState(s,ctx') >= 0, '产物写入口调用纯函数断言');

console.log('=== 状态机探针：' + pass + '/' + total + ' ===');
if (pass !== total) process.exit(1);
