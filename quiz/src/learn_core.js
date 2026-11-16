/* ===== 知识问答 · 学习系统纯逻辑层（UMD：浏览器挂 globalThis.LearnCore，Node 可 require 单测） =====
   职责：技能树解锁与推荐、过关判定与掌握度升降、SRS 长期巩固、今日任务与打卡、薄弱专项组卷。
   约束（与 logic.js 同规格）：
   1) 本文件不出现 document / window / localStorage；不读写存储，进度对象全部由调用方传入、返回新对象。
   2) 所有时间由调用方显式传 now（毫秒时间戳），保证纯函数可重复断言。
   3) 复用 QALogic.srsAdvance / srsInit 作为唯一的记忆曲线实现，不另造一套。
   4) 构建时由 .build/build.js 内联进单文件产物，紧跟 logic.js 之后，不新增 script src。 */
(function (root, factory) {
    var qa = null;
    if (typeof module === 'object' && module && module.exports) {
        qa = require('./logic.js');
    }
    var api = factory(qa || (root && root.QALogic));
    if (typeof module === 'object' && module && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.LearnCore = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (QA) {
    'use strict';

    var DAY = (QA && QA.DAY) || 86400000;
    var DEFAULT_RULE = { count: 5, pass: 4 };   // 过关卡：5 题答对 4 题（≥80%）
    var STATUS = { LOCKED: 'locked', AVAILABLE: 'available', LEARNING: 'learning', PASSED: 'passed' };

    /* ---------- 基础工具（全部纯函数） ---------- */
    function clamp(v, lo, hi) {
        v = Number(v);
        if (!isFinite(v)) { return lo; }
        return Math.max(lo, Math.min(hi, v));
    }
    /* 百分比：0~100 的整数，分母为 0 时返回 0。 */
    function pct(n, d) {
        n = Number(n) || 0; d = Number(d) || 0;
        return d > 0 ? Math.round(n / d * 100) : 0;
    }
    /* 本地日期键 YYYY-MM-DD（不用 Date.UTC，避开回归夹具只挂 now 的坑）。 */
    function dayKey(now) {
        var d = new Date(Number(now) || 0);
        var m = d.getMonth() + 1, day = d.getDate();
        return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
    }
    function cloneSrs(s) {
        if (!s) { return null; }
        return { lv: s.lv || 0, due: s.due || 0 };
    }
    function entry(prog, id) {
        return (prog && prog[id]) || null;
    }
    /* ---------- 技能树：依赖闭包、拓扑分层、状态计算 ---------- */
    function index(course) {
        var byId = {};
        (course && course.lessons || []).forEach(function (l) { byId[l.id] = l; });
        return byId;
    }
    /* 依赖闭包：返回 id 的全部祖先依赖（去重，不含自身，环路自动截断）。 */
    function depClosure(id, course) {
        var byId = index(course), seen = {}, out = [];
        function walk(cur, stack) {
            var l = byId[cur];
            if (!l || stack[cur]) { return; }
            stack[cur] = 1;
            (l.dep || []).forEach(function (d) {
                if (d === id || seen[d]) { return; }
                seen[d] = 1; out.push(d);
                if (byId[d]) { walk(d, stack); }
            });
            delete stack[cur];
        }
        walk(id, {});
        return out;
    }
    /* 拓扑分层：返回 [[第0层id...],[第1层id...]]，用于技能树按层布局。 */
    function topoLevels(course) {
        var byId = index(course), level = {};
        function lv(id, stack) {
            if (level[id] != null) { return level[id]; }
            if (stack[id]) { return 0; }
            stack[id] = 1;
            var deps = ((byId[id] && byId[id].dep) || []).filter(function (d) { return byId[d]; });
            var base = 0;
            deps.forEach(function (d) { base = Math.max(base, lv(d, stack)); });
            stack[id] = 0;
            level[id] = deps.length ? base + 1 : 0;
            return level[id];
        }
        (course && course.lessons || []).forEach(function (l) { lv(l.id, {}); });
        var max = 0;
        Object.keys(level).forEach(function (k) { max = Math.max(max, level[k]); });
        var out = [];
        for (var i = 0; i <= max; i++) {
            out.push((course.lessons || []).filter(function (l) { return level[l.id] === i; })
                                            .map(function (l) { return l.id; }));
        }
        return out;
    }
    /* 依赖是否已全部过关。 */
    function isUnlocked(lesson, prog) {
        if (!lesson) { return false; }
        return (lesson.dep || []).every(function (d) {
            var p = entry(prog, d);
            return !!(p && p.status === STATUS.PASSED);
        });
    }
    /* 计算全树状态：locked（前置未过）/ passed（已过关）/ learning（学过未过）/ available（可学）。 */
    function computeTree(course, prog) {
        var out = {};
        (course && course.lessons || []).forEach(function (l) {
            var p = entry(prog, l.id);
            var depMet = isUnlocked(l, prog);
            var state;
            if (p && p.status === STATUS.PASSED) { state = STATUS.PASSED; }
            else if (!depMet) { state = STATUS.LOCKED; }
            else if (p && ((p.attempts || 0) > 0 || (p.mastery || 0) > 0)) { state = STATUS.LEARNING; }
            else { state = STATUS.AVAILABLE; }
            out[l.id] = {
                id: l.id, state: state, depMet: depMet,
                mastery: p ? clamp(p.mastery, 0, 100) : 0,
                srs: cloneSrs(p && p.srs),
                attempts: p ? (p.attempts || 0) : 0
            };
        });
        return out;
    }
    /* 下一批可学的新节点：available 节点按难度、时长、id 排序。 */
    function nextLessons(course, prog, limit) {
        var tree = computeTree(course, prog), byId = index(course);
        var ids = Object.keys(tree).filter(function (id) { return tree[id].state === STATUS.AVAILABLE; });
        ids.sort(function (a, b) {
            var la = byId[a] || {}, lb = byId[b] || {};
            return (la.diff || 0) - (lb.diff || 0) || (la.minutes || 0) - (lb.minutes || 0) || a.localeCompare(b);
        });
        return limit == null ? ids : ids.slice(0, Math.max(0, limit));
    }
    /* 到期复习节点：已过关且 SRS 到期的 id，按到期时间升序。 */
    function srsReviewDue(course, prog, now) {
        var tree = computeTree(course, prog), ids = [];
        Object.keys(tree).forEach(function (id) {
            var t = tree[id];
            if (t.state === STATUS.PASSED && t.srs && t.srs.due <= Number(now)) { ids.push(id); }
        });
        ids.sort(function (a, b) { return tree[a].srs.due - tree[b].srs.due; });
        return ids;
    }

    /* ---------- 过关判定与掌握度 ---------- */
    /* 比例判定：答对数/总题数 ≥ 过关线，兼容题库抽不满 count 的情况。 */
    function judgePass(correct, total, rule) {
        var r = rule || DEFAULT_RULE;
        var c = Number(correct) || 0, t = Number(total) || 0;
        if (t <= 0) { return false; }
        return c / t >= r.pass / r.count;
    }
    /* 过关后掌握度：满分 100；压线 80；之间线性映射；不低于历史值（不倒退）。 */
    function masteryAfterPass(prev, correct, total, rule) {
        var r = rule || DEFAULT_RULE;
        var ratio = (Number(total) > 0) ? (Number(correct) || 0) / Number(total) : 0;
        var line = r.pass / r.count;
        var gain = ratio >= 1 ? 100 : Math.round(80 + (ratio - line) / (1 - line) * 20);
        gain = clamp(gain, 80, 100);
        return Math.max(clamp(prev, 0, 100), gain);
    }
    /* 未过关掌握度：压到 79 以下（不算掌握）并按失分扣减，最低 0。 */
    function masteryAfterFail(prev, correct, total, rule) {
        var r = rule || DEFAULT_RULE;
        var ratio = (Number(total) > 0) ? (Number(correct) || 0) / Number(total) : 0;
        var miss = clamp(1 - ratio, 0, 1);
        return clamp(Math.min(clamp(prev, 0, 100), 79) - Math.round(miss * 25), 0, 79);
    }
    /* 应用一次过关测验结果，返回全新 prog（不改入参）。ruleOverride 形如 {count,pass}。 */
    function applyLessonResult(prog, id, result, now, ruleOverride) {
        var rule = ruleOverride
            ? { count: Math.max(1, Number(ruleOverride.count) || DEFAULT_RULE.count),
                pass: Math.max(1, Number(ruleOverride.pass) || DEFAULT_RULE.pass) }
            : DEFAULT_RULE;
        var prev = entry(prog, id) || { mastery: 0, status: STATUS.LEARNING, srs: null, attempts: 0, reviews: 0 };
        // 若调用方传了带 content 的 lesson 规则，优先用它的 mastery；此处 ruleOverride 可为 {count,pass}
        var correct = (result && result.correct) || 0;
        var total = (result && result.total) || 0;
        var passed = judgePass(correct, total, rule);
        var srs = cloneSrs(prev.srs) || { lv: 0, due: Number(now) + DAY };
        var mastery, status, passAt = prev.passAt || 0;
        if (passed) {
            mastery = masteryAfterPass(prev.mastery || 0, correct, total, rule);
            status = STATUS.PASSED;
            if (!passAt) { passAt = Number(now); }
            if (prev.status === STATUS.PASSED) {
                QA.srsAdvance(srs, true, Number(now));   // 重测过关 → 记忆曲线前进一级
            }
        } else {
            mastery = masteryAfterFail(prev.mastery || 0, correct, total, rule);
            status = STATUS.LEARNING;
            QA.srsAdvance(srs, false, Number(now));      // 未过关 → 记忆曲线归零
        }
        var next = {};
        Object.keys(prog || {}).forEach(function (k) { next[k] = prog[k]; });
        next[id] = {
            mastery: mastery, status: status, srs: srs,
            attempts: (prev.attempts || 0) + 1,
            reviews: prev.reviews || 0,
            passAt: passAt,
            lastScore: { correct: correct, total: total },
            lastAt: Number(now)
        };
        return next;
    }

    /* ---------- SRS 长期巩固 ---------- */
    /* 复习一次：答对推进记忆曲线、掌握度小幅上升；答错降档、掌握度扣减。返回新 prog。 */
    function applyReview(prog, id, correct, now) {
        var prev = entry(prog, id);
        if (!prev) { return prog || {}; }
        var srs = cloneSrs(prev.srs) || { lv: 0, due: Number(now) + DAY };
        QA.srsAdvance(srs, !!correct, Number(now));
        var mastery = correct
            ? clamp((prev.mastery || 0) + 3, 0, 100)
            : clamp((prev.mastery || 0) - 10, 0, 100);
        var next = {};
        Object.keys(prog || {}).forEach(function (k) { next[k] = prog[k]; });
        next[id] = {
            mastery: mastery, status: prev.status, srs: srs,
            attempts: prev.attempts || 0, reviews: (prev.reviews || 0) + 1,
            passAt: prev.passAt || 0, lastScore: prev.lastScore || null,
            lastAt: Number(now)
        };
        return next;
    }

    /* ---------- 今日任务与打卡 ---------- */
    /* 生成今日任务：到期复习优先（约一半名额），其余给可学新课；返回带日期与理由的任务单。 */
    function todayTasks(course, prog, daily, now, opt) {
        opt = opt || {};
        var target = Math.max(1, Number(opt.target || (daily && daily.target) || 3));
        var due = srsReviewDue(course, prog, now);
        var fresh = nextLessons(course, prog, 99);
        var done = (daily && daily.date === dayKey(now) && daily.done) || [];
        due = due.filter(function (id) { return done.indexOf(id) < 0; });
        fresh = fresh.filter(function (id) { return done.indexOf(id) < 0; });
        var tasks = [], reviewQuota = Math.ceil(target / 2);
        due.slice(0, reviewQuota).forEach(function (id) {
            tasks.push({ lessonId: id, kind: 'review', reason: '到期复习' });
        });
        fresh.slice(0, target - tasks.length).forEach(function (id) {
            tasks.push({ lessonId: id, kind: 'new', reason: '学习新课' });
        });
        return { date: dayKey(now), target: target, tasks: tasks, total: tasks.length,
                 done: done.length };
    }
    /* 打卡：把完成的任务记入当日 done，并维护连续天数 streak（断签重置为 1）。 */
    function applyDaily(daily, taskResult, now) {
        var key = dayKey(now), yesterday = dayKey(Number(now) - DAY);
        var d = {};
        Object.keys(daily || {}).forEach(function (k) { d[k] = daily[k]; });
        if (d.date !== key) { d.date = key; d.done = []; }
        var done = (d.done || []).slice(), added = 0;
        var id = taskResult && (taskResult.lessonId || taskResult.id);
        if (id && done.indexOf(id) < 0) { done.push(id); added = 1; }
        d.done = done;
        if (d.lastDate !== key) {
            d.streak = (d.lastDate === yesterday) ? (Number(d.streak) || 0) + 1 : 1;
            d.lastDate = key;
        }
        d.target = d.target || 3;
        d.totalDone = (Number(d.totalDone) || 0) + added;
        return d;
    }
    /* 当前连续天数：最后打卡在昨天或今天才算有效，否则视为已断签。 */
    function streakOf(daily, now) {
        if (!daily || !daily.lastDate) { return 0; }
        var key = dayKey(now), yesterday = dayKey(Number(now) - DAY);
        if (daily.lastDate === key || daily.lastDate === yesterday) { return Number(daily.streak) || 0; }
        return 0;
    }

    /* ---------- 薄弱专项 ---------- */
    /* 薄弱知识点排行：按正确率升序、错题数降序；仅统计 total>0 的项。 */
    function weakRanking(weak, opt) {
        var arr = [];
        Object.keys(weak || {}).forEach(function (tag) {
            var w = weak[tag] || {}, wrong = Number(w.wrong) || 0, total = Number(w.total) || 0;
            if (total <= 0) { return; }
            arr.push({ tag: tag, wrong: wrong, total: total, acc: pct(total - wrong, total) });
        });
        arr.sort(function (a, b) { return a.acc - b.acc || b.wrong - a.wrong || a.tag.localeCompare(b.tag); });
        return opt && opt.limit ? arr.slice(0, Math.max(0, opt.limit)) : arr;
    }
    /* 专项组卷计划：按薄弱程度分配题数配额，返回每个知识点对应的节点与配额（实际抽题交引擎）。 */
    function makeWeakDrill(weak, course, n) {
        n = Math.max(1, Number(n) || 10);
        var rank = weakRanking(weak), tagMap = {};
        (course && course.lessons || []).forEach(function (l) {
            (l.tags || []).forEach(function (t) { (tagMap[t] = tagMap[t] || []).push(l.id); });
        });
        var weightSum = 0;
        rank.forEach(function (r) { weightSum += Math.max(1, r.wrong); });
        var items = [], remain = n;
        rank.forEach(function (r) {
            if (remain <= 0) { return; }
            var ids = tagMap[r.tag] || [];
            if (!ids.length) { return; }
            var share = Math.max(1, Math.round(n * Math.max(1, r.wrong) / Math.max(1, weightSum)));
            var give = Math.min(share, remain);
            items.push({ tag: r.tag, acc: r.acc, lessonIds: ids.slice(), quota: give });
            remain -= give;
        });
        return { total: n, items: items, assigned: n - remain, left: remain };
    }

    /* ---------- 统计 ---------- */
    function progressSummary(course, prog) {
        var tree = computeTree(course, prog);
        var states = Object.keys(tree).map(function (k) { return tree[k].state; });
        var count = function (s) { return states.filter(function (x) { return x === s; }).length; };
        var passed = count(STATUS.PASSED);
        var masterySum = Object.keys(tree).reduce(function (s, k) { return s + tree[k].mastery; }, 0);
        return {
            total: states.length,
            passed: passed,
            learning: count(STATUS.LEARNING),
            available: count(STATUS.AVAILABLE),
            locked: count(STATUS.LOCKED),
            pct: pct(passed, states.length),
            avgMastery: states.length ? Math.round(masterySum / states.length) : 0
        };
    }

    return {
        DAY: DAY,
        STATUS: STATUS,
        DEFAULT_RULE: DEFAULT_RULE,
        clamp: clamp,
        pct: pct,
        dayKey: dayKey,
        depClosure: depClosure,
        topoLevels: topoLevels,
        isUnlocked: isUnlocked,
        computeTree: computeTree,
        nextLessons: nextLessons,
        srsReviewDue: srsReviewDue,
        judgePass: judgePass,
        masteryAfterPass: masteryAfterPass,
        masteryAfterFail: masteryAfterFail,
        applyLessonResult: applyLessonResult,
        applyReview: applyReview,
        todayTasks: todayTasks,
        applyDaily: applyDaily,
        streakOf: streakOf,
        weakRanking: weakRanking,
        makeWeakDrill: makeWeakDrill,
        progressSummary: progressSummary
    };
});
