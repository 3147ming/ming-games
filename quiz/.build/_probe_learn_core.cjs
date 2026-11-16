/* P2 验收探针：学习系统纯逻辑层直接 require 跑单测（秒级，不启浏览器）。
   覆盖：基础工具、技能树解锁/拓扑、过关判定、掌握度升降、SRS 巩固、今日任务与打卡、
        薄弱专项组卷、统计汇总，以及 71 节真实课程的集成解锁链。 */
const fs = require('fs');
const path = require('path');
const L = require('../src/learn_core.js');
const QA = require('../src/logic.js');
let pass = 0, total = 0;
function ok(cond, name) { total++; if (cond) { pass++; } else { console.log('  ✗ ' + name); } }
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), name + '（实际 ' + JSON.stringify(a) + '）'); }

const DAY = 86400000;
const T = 1700000000000; // 固定时间锚点

/* ---------- 1. 模块形态与常量 ---------- */
eq(L.SRS_INTERVALS || QA.SRS_INTERVALS, [1, 2, 4, 7, 15, 30], '复用 SRS 六级阶梯常量');
ok(L.DAY === DAY, 'DAY 常量 86400000');
eq(L.DEFAULT_RULE, { count: 5, pass: 4 }, '默认过关规则 5题对4题');
eq(L.STATUS, { LOCKED: 'locked', AVAILABLE: 'available', LEARNING: 'learning', PASSED: 'passed' }, '四态枚举');
const apiKeys = ['clamp','pct','dayKey','depClosure','topoLevels','isUnlocked','computeTree','nextLessons',
  'srsReviewDue','judgePass','masteryAfterPass','masteryAfterFail','applyLessonResult','applyReview',
  'todayTasks','applyDaily','streakOf','weakRanking','makeWeakDrill','progressSummary'];
ok(apiKeys.every(k => typeof L[k] === 'function'), '20 个 API 全部导出为函数');
ok(/root\.LearnCore\s*=/.test(fs.readFileSync(path.resolve(__dirname,'../src/learn_core.js'),'utf8')), 'UMD 浏览器全局挂载');

/* ---------- 2. 基础工具 ---------- */
eq(L.clamp(50, 0, 100), 50, 'clamp 区间内原值');
eq(L.clamp(-5, 0, 100), 0, 'clamp 下界');
eq(L.clamp(150, 0, 100), 100, 'clamp 上界');
eq(L.clamp(NaN, 0, 100), 0, 'clamp 非数取下限');
eq(L.pct(4, 5), 80, 'pct 4/5=80');
eq(L.pct(1, 3), 33, 'pct 1/3 四舍五入');
eq(L.pct(0, 0), 0, 'pct 零分母为0');
eq(L.pct(3, 0), 0, 'pct 零分母_safe');
ok(/^\d{4}-\d{2}-\d{2}$/.test(L.dayKey(T)), 'dayKey 格式 YYYY-MM-DD');
ok(L.dayKey(T) === L.dayKey(T + 1000), 'dayKey 同一天一致');
ok(L.dayKey(T) !== L.dayKey(T + DAY), 'dayKey 隔天不同');
eq(L.dayKey(Date.UTC(2024, 0, 5, 12)), '2024-01-05', 'dayKey 本地日期正确');

/* ---------- 3. 技能树：依赖闭包 / 拓扑 / 解锁 ---------- */
const C = { id: 'test', lessons: [
  { id: 'a', dep: [], diff: 1, minutes: 5, tags: ['T1'] },
  { id: 'b', dep: ['a'], diff: 2, minutes: 8, tags: ['T1', 'T2'] },
  { id: 'c', dep: ['a'], diff: 1, minutes: 6, tags: ['T2'] },
  { id: 'd', dep: ['b', 'c'], diff: 3, minutes: 10, tags: ['T3'] },
  { id: 'e', dep: ['d'], diff: 4, minutes: 12, tags: ['T3'] }
] };
eq(L.depClosure('e', C).sort(), ['a', 'b', 'c', 'd'], 'depClosure 多层依赖全展开');
eq(L.depClosure('a', C), [], 'depClosure 起点无依赖');
eq(L.depClosure('d', C).sort(), ['a', 'b', 'c'], 'depClosure 多父依赖');
eq(L.topoLevels(C).map(x => x.sort()), [['a'], ['b','c'], ['d'], ['e']], 'topoLevels 四层');
ok(L.isUnlocked(C.lessons[0], {}) === true, 'isUnlocked 无依赖起点解锁');
ok(L.isUnlocked(C.lessons[1], {}) === false, 'isUnlocked 前置未过不上锁');
ok(L.isUnlocked(C.lessons[1], { a: { status: 'passed' } }) === true, 'isUnlocked 前置已过解锁');
ok(L.isUnlocked(null, {}) === false, 'isUnlocked 空节点为假');
let tree = L.computeTree(C, {});
eq(tree.a.state, 'available', 'computeTree 起点 available');
eq(tree.b.state, 'locked', 'computeTree 前置未过 locked');
eq(tree.e.state, 'locked', 'computeTree 深层 locked');
ok(tree.a.depMet === true && tree.b.depMet === false, 'computeTree depMet 标记');
tree = L.computeTree(C, { a: { status: 'passed', mastery: 90, srs: { lv: 1, due: T } } });
eq(tree.b.state, 'available', 'computeTree 前置过关后解锁');
eq(tree.c.state, 'available', 'computeTree 另一子也解锁');
eq(tree.d.state, 'locked', 'computeTree 双父之一未过仍锁');
eq(tree.a.mastery, 90, 'computeTree 掌握度透传');
eq(tree.a.srs, { lv: 1, due: T }, 'computeTree SRS 透传');
tree = L.computeTree(C, { a: { status: 'learning', attempts: 2, mastery: 40 } });
eq(tree.a.state, 'learning', 'computeTree 学过未过 learning');
eq(L.nextLessons(C, {}), ['a'], 'nextLessons 初始只有起点');
eq(L.nextLessons(C, { a: { status: 'passed' } }), ['c', 'b'], 'nextLessons 按难度排序（c难度1在前）');
eq(L.nextLessons(C, {}, 0), [], 'nextLessons limit=0 空');
eq(L.nextLessons(C, { a: { status: 'passed' }, b: { status: 'passed' }, c: { status: 'passed' }, d: { status: 'passed' } }), ['e'], 'nextLessons 到底只有终点');
ok(L.depClosure('ghost', C).length === 0, 'depClosure 未知节点安全');

/* ---------- 4. 过关判定 ---------- */
ok(L.judgePass(4, 5) === true, 'judgePass 4/5 过关');
ok(L.judgePass(3, 5) === false, 'judgePass 3/5 不过');
ok(L.judgePass(5, 5) === true, 'judgePass 满分过关');
ok(L.judgePass(8, 10) === true, 'judgePass 8/10 按比例过关');
ok(L.judgePass(7, 10) === false, 'judgePass 7/10 不过');
ok(L.judgePass(0, 5) === false, 'judgePass 全错不过');
ok(L.judgePass(0, 0) === false, 'judgePass 零题不过');
ok(L.judgePass(9, 10, { count: 10, pass: 9 }) === true, 'judgePass 自定义规则');
ok(L.judgePass(8, 10, { count: 10, pass: 9 }) === false, 'judgePass 自定义规则不过');

/* ---------- 5. 掌握度升降 ---------- */
eq(L.masteryAfterPass(0, 4, 5), 80, '掌握度压线80');
eq(L.masteryAfterPass(0, 5, 5), 100, '掌握度满分100');
eq(L.masteryAfterPass(0, 9, 10), 90, '掌握度中间线性');
eq(L.masteryAfterPass(85, 4, 5), 85, '掌握度不倒退');
eq(L.masteryAfterFail(90, 0, 5), 54, '全错扣25压到54');
eq(L.masteryAfterFail(50, 3, 5), 40, '部分错扣10');
eq(L.masteryAfterFail(10, 0, 5), 0, '掌握度下限0');
ok(L.masteryAfterFail(100, 0, 5) < 80, '未过关掌握度必低于掌握线');

/* ---------- 6. 应用测验结果 ---------- */
const prog0 = {};
let prog1 = L.applyLessonResult(prog0, 'a', { correct: 4, total: 5 }, T);
eq(prog0, {}, 'applyLessonResult 不改入参');
eq(prog1.a.status, 'passed', '首次过关状态 passed');
eq(prog1.a.mastery, 80, '首次过关掌握度80');
eq(prog1.a.srs, { lv: 0, due: T + DAY }, '首次过关 SRS 初始化1天后');
eq(prog1.a.attempts, 1, 'attempts 累加');
eq(prog1.a.passAt, T, 'passAt 记录');
eq(prog1.a.lastScore, { correct: 4, total: 5 }, 'lastScore 记录');
let prog2 = L.applyLessonResult(prog1, 'a', { correct: 5, total: 5 }, T + DAY);
eq(prog2.a.mastery, 100, '重测满分掌握度到100');
eq(prog2.a.srs.lv, 1, '重测过关 SRS 前进一级');
ok(prog1.a.srs.lv === 0, '重测不改旧 prog 的 SRS');
let prog3 = L.applyLessonResult(prog2, 'a', { correct: 1, total: 5 }, T + 2 * DAY);
eq(prog3.a.status, 'learning', '重测失败回 learning');
eq(prog3.a.srs.lv, 0, '重测失败 SRS 归零');
ok(prog3.a.mastery < 80, '重测失败掌握度低于掌握线');
eq(prog3.a.attempts, 3, 'attempts 累计三次');
eq(prog3.a.passAt, T, 'passAt 保留首次时间');
let prog4 = L.applyLessonResult({}, 'a', { correct: 4, total: 5 }, T, { count: 10, pass: 8 });
eq(prog4.a.status, 'passed', '自定义规则过关');

/* ---------- 7. SRS 到期与复习 ---------- */
const dueProg = {
  a: { status: 'passed', mastery: 80, srs: { lv: 1, due: T + DAY } },
  b: { status: 'passed', mastery: 90, srs: { lv: 2, due: T + 2 * DAY } },
  c: { status: 'passed', mastery: 70, srs: { lv: 1, due: T - DAY } }
};
eq(L.srsReviewDue(C, dueProg, T), ['c'], 'srsReviewDue 只返回已到期节点');
eq(L.srsReviewDue(C, dueProg, T + 2 * DAY), ['c', 'a', 'b'], 'srsReviewDue 按到期时间升序');
let rev = L.applyReview(dueProg, 'a', true, T + DAY);
eq(rev.a.srs.lv, 2, '复习答对 SRS 前进');
eq(rev.a.mastery, 83, '复习答对掌握度+3');
eq(dueProg.a.srs.lv, 1, 'applyReview 不改入参');
rev = L.applyReview(dueProg, 'a', false, T + DAY);
eq(rev.a.srs.lv, 0, '复习答错 SRS 归零');
eq(rev.a.mastery, 70, '复习答错掌握度-10');
eq(rev.a.reviews, 1, 'reviews 累加');
eq(L.applyReview({}, 'x', true, T), {}, 'applyReview 未知节点安全');

/* ---------- 8. 今日任务与打卡 ---------- */
let tasks = L.todayTasks(C, {}, null, T);
eq(tasks.date, L.dayKey(T), 'todayTasks 日期');
eq(tasks.target, 3, 'todayTasks 默认目标3');
eq(tasks.tasks.map(x => x.lessonId), ['a'], 'todayTasks 初始只推起点');
eq(tasks.tasks[0].kind, 'new', 'todayTasks 新学类型');
const taskProg = { a: { status: 'passed', mastery: 80, srs: { lv: 1, due: T - 1 } } };
tasks = L.todayTasks(C, taskProg, null, T);
eq(tasks.tasks.map(x => x.kind), ['review', 'new', 'new'], 'todayTasks 到期复习优先');
eq(tasks.tasks.map(x => x.lessonId), ['a', 'c', 'b'], 'todayTasks 复习后补新课');
tasks = L.todayTasks(C, taskProg, { date: L.dayKey(T), done: ['a'] }, T);
ok(tasks.tasks.every(x => x.lessonId !== 'a'), 'todayTasks 过滤已完成');
tasks = L.todayTasks(C, {}, null, T, { target: 1 });
eq(tasks.total, 1, 'todayTasks 自定义目标');
let d1 = L.applyDaily({}, { lessonId: 'a' }, T);
eq(d1.done, ['a'], 'applyDaily 记入完成');
eq(d1.streak, 1, 'applyDaily 首日连续1');
eq(d1.totalDone, 1, 'applyDaily 累计完成1');
let d2 = L.applyDaily(d1, { lessonId: 'b' }, T + 1000);
eq(d2.done, ['a', 'b'], 'applyDaily 同日追加');
eq(d2.streak, 1, 'applyDaily 同日不加连续');
let d3 = L.applyDaily(d2, { lessonId: 'b' }, T + 1000);
eq(d3.done, ['a', 'b'], 'applyDaily 同日去重');
eq(d3.totalDone, 2, 'applyDaily 去重不加累计');
let d4 = L.applyDaily(d3, { lessonId: 'c' }, T + DAY);
eq(d4.streak, 2, 'applyDaily 次日连续2');
let d5 = L.applyDaily(d4, { lessonId: 'd' }, T + 3 * DAY);
eq(d5.streak, 1, 'applyDaily 断签重置1');
eq(d5.date, L.dayKey(T + 3 * DAY), 'applyDaily 日期更新');
eq(L.streakOf(d4, T + DAY), 2, 'streakOf 当天有效');
eq(L.streakOf(d4, T + 2 * DAY), 2, 'streakOf 昨天有效');
eq(L.streakOf(d4, T + 3 * DAY), 0, 'streakOf 断签为0');
eq(L.streakOf({}, T), 0, 'streakOf 空记录为0');

/* ---------- 9. 薄弱专项 ---------- */
const weak = { T1: { wrong: 8, total: 10 }, T2: { wrong: 1, total: 10 }, T3: { wrong: 5, total: 10 }, D: { wrong: 0, total: 0 } };
eq(L.weakRanking(weak).map(x => x.tag), ['T1', 'T3', 'T2'], 'weakRanking 按正确率升序');
eq(L.weakRanking(weak)[0].acc, 20, 'weakRanking 正确率计算');
eq(L.weakRanking(weak, { limit: 2 }).length, 2, 'weakRanking limit');
eq(L.weakRanking({ D: { wrong: 0, total: 0 } }).length, 0, 'weakRanking 排除零分母');
let drill = L.makeWeakDrill(weak, C, 10);
eq(drill.total, 10, 'makeWeakDrill 总题数');
eq(drill.assigned, 10, 'makeWeakDrill 配额分满');
eq(drill.left, 0, 'makeWeakDrill 无剩余');
ok(drill.items.every(x => x.quota > 0 && x.lessonIds.length > 0), 'makeWeakDrill 每项有配额与节点');
ok(drill.items[0].tag === 'T1', 'makeWeakDrill 最薄弱优先');
eq(L.makeWeakDrill({ ghost: { wrong: 9, total: 10 } }, C, 10).assigned, 0, 'makeWeakDrill 无对应节点跳过');
eq(L.makeWeakDrill(weak, C, 3).assigned, 3, 'makeWeakDrill 小配额');

/* ---------- 10. 统计 ---------- */
let sum = L.progressSummary(C, {});
eq(sum.total, 5, 'progressSummary 总数');
eq(sum.available, 1, 'progressSummary 可学1');
eq(sum.locked, 4, 'progressSummary 锁定4');
eq(sum.pct, 0, 'progressSummary 进度0');
const allPassed = {};
C.lessons.forEach(l => { allPassed[l.id] = { status: 'passed', mastery: 90, srs: { lv: 3, due: T } }; });
sum = L.progressSummary(C, allPassed);
eq(sum.passed, 5, 'progressSummary 全过');
eq(sum.pct, 100, 'progressSummary 进度100');
eq(sum.avgMastery, 90, 'progressSummary 平均掌握度');
sum = L.progressSummary({ lessons: [] }, {});
eq(sum.pct, 0, 'progressSummary 空课程安全');

/* ---------- 11. 真实课程集成：71 节点解锁链 ---------- */
const cc = require('../data/course_circuit.json');
const cd = require('../data/course_code.json');
const all = { lessons: cc.lessons.concat(cd.lessons) };
ok(all.lessons.length === 71, '真实课程 71 节');
const realTree = L.computeTree(all, {});
const roots = Object.keys(realTree).filter(id => realTree[id].state === 'available');
ok(roots.length > 0, '真实课程有可学起点');
ok(L.topoLevels(all).length >= 5, '真实技能树拓扑层数合理');
// 按拓扑层顺序依次过关，模拟完整学习路径
let sim = {};
L.topoLevels(all).forEach(level => level.forEach(id => {
  sim = L.applyLessonResult(sim, id, { correct: 5, total: 5 }, T);
}));
const simSum = L.progressSummary(all, sim);
eq(simSum.passed, 71, '按拓扑序可通关全部71节');
eq(simSum.pct, 100, '通关后进度100');
ok(Object.keys(sim).every(id => sim[id].srs && sim[id].srs.lv === 0), '通关后每节都有SRS记录');
// 每日任务在真实课程上能产出
const realTasks = L.todayTasks(all, sim, null, T + 40 * DAY);
ok(realTasks.tasks.length > 0 && realTasks.tasks.every(x => all.lessons.some(l => l.id === x.lessonId)), '真实课程今日任务节点合法');
// 过关规则读取真实节 mastery
const c01 = cc.lessons.find(l => l.id === 'c01');
ok(c01.content.mastery.count === 5 && c01.content.mastery.pass === 4, '真实节过关规则5/4');
eq(L.judgePass(c01.content.mastery.pass, c01.content.mastery.count), true, '真实节规则与逻辑层一致');

console.log('\n=== 学习系统逻辑层探针：' + pass + '/' + total + ' 项通过 ===');
process.exit(pass === total ? 0 : 1);
