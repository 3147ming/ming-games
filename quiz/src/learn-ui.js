/* ===== 知识问答 · 学习中心 UI 层（从零到掌握 · 独立系统） =====
   依赖全局（均由 build.js 在之前装配）：
   - LearnCore：纯逻辑（技能树/掌握度/SRS/今日任务/薄弱）
   - COURSE_DATA：{circuit:{...lessons}, code:{...lessons}} 课程 JSON
   - h/ht/esc/clearNode/shuffle/later/toast/safeSet/S：框架与引擎公共函数
   - QA_TYPES / genPool / POOLS：题库与抽题（过关测验）
   - showView/renderShelf：视图切换（本文件只管 #learn 的 hidden，三视图互斥在此自持）
   暴露 window.LearnUI 供 CDP 探针驱动：
   goto(section) / openSubject(subj) / openLesson(id) / startQuiz(id) / answerQuiz(idx) /
   openTutor(id) / tutorAdvance() / getState() / getCourse() */
(function () {
    'use strict';
    if (!window.LearnCore) { return; }
    var LC = window.LearnCore;
    var $ = function (id) { return document.getElementById(id); };
    var learnEl = null;

    /* ---------- 存储（学习系统独立键，P4 登记进 STORE_REG） ---------- */
    var K_PROG = 'bt_qa_learn_prog';    // 每节进度 {mastery,status,srs,attempts,...}
    var K_DAILY = 'bt_qa_learn_daily';  // 打卡 {date,done,streak,target,totalDone,lastDate}
    var K_TUTOR = 'bt_qa_learn_tutor';  // AI 导师对话缓存 {lessonId:[{role,text}]}
    function loadObj(k) { try { return JSON.parse(S.getItem(k) || '{}') || {}; } catch (e) { return {}; } }
    function saveObj(k, v) { safeSet(k, JSON.stringify(v)); }
    function prog() { return loadObj(K_PROG); }
    function daily() { return loadObj(K_DAILY); }
    function courses() { return window.COURSE_DATA || {}; }
    function allLessons() {
        var out = [], d = courses();
        ['circuit', 'code'].forEach(function (subj) {
            var c = d[subj];
            if (c && c.lessons) { c.lessons.forEach(function (l) { l._subj = subj; out.push(l); }); }
        });
        return out;
    }
    function findLesson(id) {
        var all = allLessons();
        for (var i = 0; i < all.length; i++) { if (all[i].id === id) { return all[i]; } }
        return null;
    }
    function courseBySubj(subj) { return courses()[subj] || { lessons: [] }; }
    function nowMs() { return Date.now(); }

    /* ---------- 三视图互斥：学习中心 / 书架 / 答题台 ---------- */
    function showLearn() {
        var sh = $('shelf'), st = $('stage'), ln = $('learn');
        if (sh) { sh.hidden = true; }
        if (st) { st.hidden = true; }
        if (ln) { ln.hidden = false; }
        learnEl = ln;
    }
    function leaveLearn() {
        var ln = $('learn');
        if (ln) { ln.hidden = true; }
    }

    /* ---------- 学习中心首页 ---------- */
    function gotoHome() {
        showLearn();
        clearNode(learnEl);
        var progData = prog(), dl = daily();
        var all = allLessons(), sum = LC.progressSummary({ lessons: all }, progData);

        /* Hero */
        var hero = h('div', 'ln-hero');
        hero.innerHTML =
            '<div class="ln-kicker">FROM ZERO TO MASTERY</div>' +
            '<h2>从零开始，真正学会</h2>' +
            '<p>不是刷题机器，而是一套完整学习系统：零基础讲解 → 分步例题 → 过关解锁 → 长期记忆巩固。</p>' +
            '<div class="ln-hero-row">' +
            '<div class="ln-pill"><b>' + sum.total + '</b>节微课</div>' +
            '<div class="ln-pill"><b>' + sum.passed + '</b>节已掌握</div>' +
            '<div class="ln-pill"><b>' + sum.pct + '%</b>总进度</div>' +
            '</div>';
        learnEl.appendChild(hero);

        /* 三场景 */
        var s1 = h('div', 'ln-sec'); s1.textContent = '🎯 你想做什么？'; learnEl.appendChild(s1);
        var scenes = h('div', 'ln-scenes');
        var sceneData = [
            { c: 's1', ic: '🌱', t: '课前预习', d: '零基础开始，跟着微课一步步建立概念', act: function () { openSubject('circuit'); } },
            { c: 's2', ic: '🔁', t: '课后复习', d: '今日任务 + 到期记忆，把学过的变成记住的', act: function () { openDaily(); } },
            { c: 's3', ic: '🎯', t: '考前冲刺', d: '薄弱知识点定向突破，集中攻克不会的', act: function () { openWeak(); } }
        ];
        sceneData.forEach(function (sd) {
            var el = h('div', 'ln-scene ' + sd.c);
            el.innerHTML = '<div class="ln-ic">' + sd.ic + '</div><div class="ln-t">' + sd.t + '</div><div class="ln-d">' + sd.d + '</div>';
            el.onclick = sd.act;
            scenes.appendChild(el);
        });
        learnEl.appendChild(scenes);

        /* 学科入口 */
        var s2 = h('div', 'ln-sec'); s2.textContent = '📚 课程地图'; learnEl.appendChild(s2);
        var subjGrid = h('div', 'ln-subj');
        [
            { k: 'circuit', ic: '🔌', n: '电路与模拟电子', d: '从电流电压到运放射频，46 节系统课' },
            { k: 'code', ic: '💻', n: '编程从零到实战', d: '通识→Python/C/Web/SQL→综合项目，25 节' }
        ].forEach(function (sj) {
            var cs = courseBySubj(sj.k), ss = LC.progressSummary(cs, progData);
            var card = h('div', 'ln-subjcard');
            card.innerHTML =
                '<div class="ln-si">' + sj.ic + '</div>' +
                '<div class="ln-sn">' + sj.n + '</div>' +
                '<div class="ln-sd">' + sj.d + '</div>' +
                '<div class="ln-bar"><i style="width:' + ss.pct + '%"></i></div>' +
                '<div class="ln-bt"><span>已掌握 ' + ss.passed + '/' + ss.total + ' 节</span><span>' + ss.pct + '%</span></div>';
            card.onclick = function () { openSubject(sj.k); };
            subjGrid.appendChild(card);
        });
        learnEl.appendChild(subjGrid);

        /* 今日任务 */
        var s3 = h('div', 'ln-sec'); s3.textContent = '📅 今日任务'; learnEl.appendChild(s3);
        renderDailyCard(dl, progData);
    }

    /* ---------- 今日任务卡 ---------- */
    function renderDailyCard(dl, progData) {
        var box = h('div', 'ln-daily');
        var streak = LC.streakOf(dl, nowMs());
        var head = h('div', 'ln-dh');
        head.innerHTML = '<b>今天的计划</b><div class="ln-streak">🔥 连续 ' + streak + ' 天</div>';
        box.appendChild(head);
        var all = allLessons();
        var tasks = LC.todayTasks({ lessons: all }, progData, dl, nowMs());
        if (!tasks.tasks.length) {
            box.appendChild(h('div', 'ln-empty', '🎉 今日任务已完成，去课程地图继续探索新知识吧！'));
        } else {
            tasks.tasks.forEach(function (t) {
                var l = findLesson(t.lessonId);
                var row = h('div', 'ln-task');
                var icon = t.kind === 'review' ? '⏰' : '📖';
                var nm = l ? l.name : t.lessonId;
                row.innerHTML =
                    '<div class="ln-ti">' + icon + '</div>' +
                    '<div class="ln-tt"><b>' + esc(nm) + '</b><span>' + esc(t.reason) + (l ? ' · ' + esc(l._subj === 'circuit' ? '电路' : '编程') : '') + '</span></div>' +
                    '<div class="ln-go">开始 ›</div>';
                row.onclick = function () { openLesson(t.lessonId); };
                box.appendChild(row);
            });
        }
        learnEl.appendChild(box);
    }

    /* ---------- 今日任务全览（点场景卡进入） ---------- */
    function openDaily() { gotoHome(); var el = learnEl.querySelector('.ln-daily'); if (el && el.scrollIntoView) { el.scrollIntoView({ block: 'center' }); } }

    /* ---------- 薄弱专项 ---------- */
    function openWeak() {
        var all = allLessons(), weak = {}, progData = prog();
        /* 从每节进度聚合薄弱：掌握度 < 60 的节点，其 tags 各记一次错题 */
        all.forEach(function (l) {
            var p = progData[l.id];
            if (p && (p.mastery || 0) < 60) {
                (l.tags || []).forEach(function (t) {
                    weak[t] = weak[t] || { wrong: 0, total: 0 };
                    weak[t].wrong++; weak[t].total++;
                });
            }
        });
        var rank = LC.weakRanking(weak);
        showLearn(); clearNode(learnEl);
        var top = h('div', 'ln-tree-top');
        var back = h('button', 'ln-back', '← 返回');
        back.onclick = gotoHome;
        top.appendChild(back);
        var h3 = h('h3'); h3.textContent = '🎯 薄弱专项突破'; top.appendChild(h3);
        learnEl.appendChild(top);
        if (!rank.length) {
            learnEl.appendChild(h('div', 'ln-empty', '目前还没有明显的薄弱点。先去学几节课，系统会根据你的掌握度自动生成专项训练。'));
            return;
        }
        var drill = LC.makeWeakDrill(weak, { lessons: all }, 10);
        learnEl.appendChild(h('div', 'ln-sec', '按薄弱程度排序 · 建议优先攻克前面几项'));
        var wrap = h('div', 'ln-daily');
        drill.items.forEach(function (it) {
            var row = h('div', 'ln-task');
            row.innerHTML = '<div class="ln-ti">📌</div><div class="ln-tt"><b>' + esc(it.tag) + '</b>' +
                '<span>正确率 ' + it.acc + '% · 建议 ' + it.quota + ' 题</span></div><div class="ln-go">' + it.lessonIds.length + ' 节 ›</div>';
            row.onclick = function () { if (it.lessonIds[0]) { openLesson(it.lessonIds[0]); } };
            wrap.appendChild(row);
        });
        learnEl.appendChild(wrap);
    }

    /* ---------- 技能树（按学科） ---------- */
    function openSubject(subj) {
        showLearn(); clearNode(learnEl);
        var cs = courseBySubj(subj), progData = prog();
        var tree = LC.computeTree(cs, progData);
        var top = h('div', 'ln-tree-top');
        var back = h('button', 'ln-back', '← 返回');
        back.onclick = gotoHome;
        top.appendChild(back);
        var h3 = h('h3'); h3.textContent = cs.name || (subj === 'circuit' ? '电路与模拟电子' : '编程从零到实战');
        top.appendChild(h3);
        learnEl.appendChild(top);

        /* 图例 */
        var lg = h('div', 'ln-legend');
        lg.innerHTML =
            '<span><i style="background:#8fdbb6"></i>已掌握</span>' +
            '<span><i style="background:#f5c46b"></i>学习中</span>' +
            '<span><i style="background:#c9b8ff"></i>可学习</span>' +
            '<span><i style="background:#d7d2e2"></i>未解锁</span>';
        learnEl.appendChild(lg);

        /* 按拓扑层分组 */
        var levels = LC.topoLevels(cs), byId = {};
        cs.lessons.forEach(function (l) { byId[l.id] = l; });
        levels.forEach(function (level, li) {
            var layer = h('div', 'ln-layer');
            layer.appendChild(h('div', 'ln-layer-lb', '第 ' + (li + 1) + ' 层 · ' + level.length + ' 节'));
            var nodes = h('div', 'ln-nodes');
            level.forEach(function (id) {
                var l = byId[id], t = tree[id];
                if (!l || !t) { return; }
                var node = h('div', 'ln-node st-' + t.state);
                var badge = t.state === 'passed' ? '✅' : t.state === 'learning' ? '📝' : t.state === 'locked' ? '🔒' : '›';
                node.innerHTML =
                    '<div class="ln-nid">' + esc(id) + '</div>' +
                    '<div class="ln-badge">' + badge + '</div>' +
                    '<div class="ln-nn">' + esc(l.name) + '</div>' +
                    '<div class="ln-nm">' + (t.state === 'passed' ? '掌握度 ' + t.mastery + '%' : (l.minutes || 10) + ' 分钟') + '</div>';
                if (t.state !== 'locked') { node.onclick = function () { openLesson(id); }; }
                nodes.appendChild(node);
            });
            layer.appendChild(nodes);
            learnEl.appendChild(layer);
        });
    }

    /* ---------- 微课七段 ---------- */
    function openLesson(id) {
        var l = findLesson(id);
        if (!l) { toast('课程不存在'); return; }
        showLearn(); clearNode(learnEl);
        var progData = prog(), tree = LC.computeTree({ lessons: allLessons() }, progData)[id];
        var c = l.content || {};

        var top = h('div', 'ln-lesson-top');
        var back = h('button', 'ln-back', '← 返回');
        back.onclick = function () { openSubject(l._subj); };
        top.appendChild(back);
        var h3 = h('h3'); h3.textContent = esc(l.name); top.appendChild(h3);
        var stName = { passed: '已掌握', learning: '学习中', available: '可学习', locked: '未解锁' };
        var badge = h('div', 'ln-status ' + tree.state, stName[tree.state] || tree.state);
        top.appendChild(badge);
        learnEl.appendChild(top);

        var bar = h('div', 'ln-progline');
        bar.innerHTML = '<i style="width:' + tree.mastery + '%"></i>';
        learnEl.appendChild(bar);
        learnEl.appendChild(h('div', 'ln-progtxt', '掌握度 ' + tree.mastery + '% · 已尝试 ' + tree.attempts + ' 次'));

        /* 第一段：零基础引入（hook 是字符串） */
        if (c.hook) { seg('💡 先想一个问题', [{ p: c.hook }], '1'); }
        /* 第二段：核心概念（{t,p} 对象数组） */
        var concepts = (c.concepts || []).map(function (x) {
            if (typeof x === 'string') { return { kp: x }; }
            return { html: '<div class="ln-kp"><b>' + esc(x.t || '') + '</b><br>' + esc(x.p || '') + '</div>' };
        });
        seg('📘 核心概念', concepts, '2');
        /* 第三段：分步例题（{q,answer,steps[]}，末步含「验算」单独高亮） */
        var exHtml = [];
        (c.examples || []).forEach(function (ex) {
            var steps = (ex.steps || []).map(function (step, i) {
                if (/验算|验证|检验/.test(step)) { return '<div class="ln-vex">✓ ' + esc(step) + '</div>'; }
                var label = /^第\d+步/.test(step) ? '' : ('第 ' + (i + 1) + ' 步：');
                return '<div class="ln-exs"><b>' + label + '</b>' + esc(step) + '</div>';
            }).join('');
            var ansLine = ex.answer ? '<div class="ln-exs" style="color:#177a4d;font-weight:800">答案：' + esc(ex.answer) + '</div>' : '';
            exHtml.push('<div class="ln-ex"><div class="ln-exq">' + esc(ex.q) + '</div>' + steps + ansLine + '</div>');
        });
        seg('✏️ 分步例题', exHtml.map(function (x) { return { html: x }; }), '3');
        /* 第四段：易错点（{wrong,right,why} 对象数组） */
        var pits = (c.pitfalls || []).map(function (x) {
            if (typeof x === 'string') { return { pit: x }; }
            return { html: '<div class="ln-pit"><b>✗ 误区：</b>' + esc(x.wrong || '') + '<br><b>✓ 正解：</b>' + esc(x.right || '') + (x.why ? '<br><span>原因：' + esc(x.why) + '</span>' : '') + '</div>' };
        });
        seg('⚠️ 易错点', pits, '4');
        /* 第五段：形成性练习（practice 是 {count,note} 说明对象，题目走题库即时练习） */
        var pr = c.practice || {};
        var prText = typeof pr === 'string' ? pr : (pr.note || ('配套 ' + (pr.count || 3) + ' 道练习题，学完即可做过关测验。'));
        seg('🎪 想一想，练一练', [{ p: prText }], '5');
        /* 第六段：过关测验入口 */
        var seg6 = h('div', 'ln-seg');
        var rule = c.mastery || { count: 5, pass: 4 };
        seg6.innerHTML = '<div class="ln-sg-h"><span class="ln-sg-n">6</span>🏁 过关测验</div>' +
            '<p>' + esc(rule.note || ('共 ' + rule.count + ' 题，答对 ' + rule.pass + ' 题即可解锁下一节。')) + '</p>';
        var qbtn = h('button', 'btn');
        qbtn.textContent = tree.state === 'passed' ? '🔄 再测一次（换题）' : '▶ 开始过关测验';
        qbtn.onclick = function () { startQuiz(id); };
        var actbar = h('div', 'ln-actbar'); actbar.appendChild(qbtn); seg6.appendChild(actbar);
        learnEl.appendChild(seg6);
        /* 第七段：AI 导师 */
        var seg7 = h('div', 'ln-seg ln-tutor');
        seg7.innerHTML = '<div class="ln-th"><span class="ln-sg-n">7</span>🤖 AI 学习导师（苏格拉底式引导）</div>' +
            '<p>不直接给答案，一步步问你、带你自己推出来。</p>';
        var tbtn = h('button', 'btn ghost'); tbtn.textContent = '💬 开始对话';
        tbtn.onclick = function () { openTutor(id); };
        var ab7 = h('div', 'ln-actbar'); ab7.appendChild(tbtn); seg7.appendChild(ab7);
        learnEl.appendChild(seg7);
    }

    /* 通用段渲染：支持 {p} 文本 / {kp} 要点框 / {pit} 易错框 / {html} 原生 */
    function seg(title, items, n) {
        if (!items.length) { return; }
        var box = h('div', 'ln-seg');
        box.innerHTML = '<div class="ln-sg-h"><span class="ln-sg-n">' + n + '</span>' + esc(title) + '</div>';
        items.forEach(function (it) {
            if (it.html) { var d = h('div'); d.innerHTML = it.html; box.appendChild(d); }
            else if (it.kp) { box.appendChild(h('div', 'ln-kp', '要点：' + it.kp)); }
            else if (it.pit) { box.appendChild(h('div', 'ln-pit', '⚠ ' + it.pit)); }
            else if (it.p) { box.appendChild(h('p', null, it.p)); }
            else if (typeof it === 'string') { box.appendChild(h('p', null, it)); }
        });
        learnEl.appendChild(box);
    }

    /* 形成性练习：点选后给对错反馈（不改变进度，纯练习） */
    function segPractice(title, items, n) {
        if (!items || !items.length) { return; }
        var box = h('div', 'ln-seg');
        box.innerHTML = '<div class="ln-sg-h"><span class="ln-sg-n">' + n + '</span>' + esc(title) + '</div>';
        items.forEach(function (it) {
            box.appendChild(h('p', null, it.q || (typeof it === 'string' ? it : '')));
            var opts = it.opts || (it.options || []);
            var ans = it.answer != null ? it.answer : it.a;
            var row = h('div');
            opts.forEach(function (o) {
                var b = h('button', 'ln-choice', o);
                b.onclick = function () {
                    var right = (String(o) === String(ans));
                    b.className = 'ln-choice ' + (right ? 'right' : 'wrong');
                    if (it.exp) { toast(right ? '✓ ' + it.exp : '✗ ' + it.exp); }
                    else { toast(right ? '✓ 答对了！' : '✗ 再想想，正确答案是：' + ans); }
                };
                row.appendChild(b);
            });
            box.appendChild(row);
        });
        learnEl.appendChild(box);
    }

    /* ---------- 过关测验（复用题库抽题 + LearnCore 判定） ---------- */
    var quizState = null;
    function pickQuestions(l, count) {
        var subj = l._subj, poolObj = (window.POOLS || {})[subj] || {};
        var tags = l.tags || [];
        var flat = [];
        Object.keys(poolObj).forEach(function (d) {
            (poolObj[d] || []).forEach(function (it) {
                flat.push({ d: Number(d), it: it });
            });
        });
        /* 优先抽本节点 tag 的题，不够再补同知识点其他题 */
        var matched = flat.filter(function (x) { return tags.indexOf(x.it[2]) >= 0; });
        var chosen = shuffle(matched).slice(0, count);
        if (chosen.length < count) {
            var used = {}; chosen.forEach(function (x) { used[x.it[0]] = 1; });
            var rest = shuffle(flat.filter(function (x) { return !used[x.it[0]]; }));
            while (chosen.length < count && rest.length) { chosen.push(rest.shift()); }
        }
        return chosen.map(function (x) {
            var q = window.genPool ? genPool(1, (window.POOLS || {})[subj] || {}, x.d)[0] : null;
            /* 直接用 mkFromPool 精确构造这一题（genPool 是随机抽，这里要指定 it） */
            var mk = window.mkFromPool ? mkFromPool(x.it, (poolObj[x.d] || [])) : null;
            return mk || q || { q: x.it[0], a: x.it[1], opts: [x.it[1]].concat(String(x.it[3] || '').split('|')).slice(0, 4) };
        });
    }
    function startQuiz(id) {
        var l = findLesson(id);
        if (!l) { return; }
        var rule = (l.content && l.content.mastery) || { count: 5, pass: 4 };
        var qs = pickQuestions(l, rule.count);
        quizState = { id: id, qs: qs, idx: 0, correct: 0, rule: { count: rule.count, pass: rule.pass }, done: false };
        renderQuizStep();
    }
    function renderQuizStep() {
        if (!quizState) { return; }
        showLearn(); clearNode(learnEl);
        var s = quizState, l = findLesson(s.id);
        var top = h('div', 'ln-tree-top');
        var back = h('button', 'ln-back', '← 退出测验');
        back.onclick = function () { openLesson(s.id); };
        top.appendChild(back);
        var h3 = h('h3'); h3.textContent = '🏁 过关测验 · ' + (l ? l.name : s.id); top.appendChild(h3);
        learnEl.appendChild(top);
        if (s.idx >= s.qs.length) { renderQuizResult(); return; }
        var q = s.qs[s.idx];
        var wrap = h('div', 'ln-quizwrap');
        var head = h('div', 'ln-qhead');
        head.innerHTML = '<b>第 ' + (s.idx + 1) + ' / ' + s.qs.length + ' 题</b>' +
            '<span class="ln-qi">当前答对 ' + s.correct + '</span>';
        wrap.appendChild(head);
        var qbox = h('div', 'qbox'); qbox.textContent = q.q; wrap.appendChild(qbox);
        var opts = h('div', 'opts');
        (q.opts || []).forEach(function (o) {
            var b = h('button', 'obtn', o);
            b.onclick = function () {
                if (quizState.locked) { return; }
                quizState.locked = true;
                var right = (String(o) === String(q.a));
                if (right) { quizState.correct++; b.className = 'obtn right'; }
                else { b.className = 'obtn wrong'; }
                setTimeout(function () {
                    quizState.locked = false;
                    quizState.idx++;
                    renderQuizStep();
                }, 500);
            };
            opts.appendChild(b);
        });
        wrap.appendChild(opts);
        learnEl.appendChild(wrap);
    }
    function renderQuizResult() {
        var s = quizState, passed = LC.judgePass(s.correct, s.qs.length, s.rule);
        var progData = LC.applyLessonResult(prog(), s.id, { correct: s.correct, total: s.qs.length }, nowMs(), s.rule);
        saveObj(K_PROG, progData);
        s.done = true;
        var wrap = h('div', 'ln-quizwrap ln-result');
        wrap.innerHTML =
            '<div class="ln-ric">' + (passed ? '🎉' : '💪') + '</div>' +
            '<h3>' + (passed ? '过关！' : '差一点，再来一次') + '</h3>' +
            '<p>答对 ' + s.correct + ' / ' + s.qs.length + ' 题 · 过关线 ' + s.rule.pass + ' / ' + s.rule.count + '</p>' +
            '<p>' + (passed ? '本节已掌握，下一节已解锁。' : '别灰心，讲解再看一遍，然后换题重测。') + '</p>';
        var bar = h('div', 'ln-actbar');
        var again = h('button', 'btn ghost', '📖 返回课程');
        again.onclick = function () { openLesson(s.id); };
        var next = h('button', 'btn', passed ? '▶ 学下一节' : '🔄 再测一次');
        next.onclick = function () {
            if (passed) {
                var all = allLessons(), nx = LC.nextLessons({ lessons: all }, prog(), 1)[0];
                if (nx) { openLesson(nx); } else { gotoHome(); }
            } else { startQuiz(s.id); }
        };
        bar.appendChild(again); bar.appendChild(next);
        wrap.appendChild(bar);
        learnEl.appendChild(wrap);
    }
    /* 供探针直接答第 idx 题（0=答对，1=答错） */
    function answerQuiz(right) {
        if (!quizState || quizState.idx >= quizState.qs.length) { return false; }
        var q = quizState.qs[quizState.idx];
        var target = right ? q.a : (q.opts || []).filter(function (o) { return String(o) !== String(q.a); })[0];
        var btns = document.querySelectorAll('#learn .opts .obtn');
        for (var i = 0; i < btns.length; i++) {
            if (String(btns[i].textContent) === String(target)) { btns[i].click(); return true; }
        }
        return false;
    }

    /* ---------- AI 学习导师（苏格拉底式，离线脚本保底） ---------- */
    function openTutor(id) {
        var l = findLesson(id);
        if (!l) { return; }
        var script = (l.content && l.content.tutor) || ['这一步你是怎么想的？说说看。'];
        var cache = loadObj(K_TUTOR);
        if (!cache[id]) { cache[id] = [{ role: 'ai', text: '你好！我是你的学习导师。我不直接给答案，而是通过提问帮你真正想明白「' + l.name + '」。' }]; saveObj(K_TUTOR, cache); }
        tutorState = { id: id, script: script, step: 0 };
        renderTutor();
    }
    var tutorState = null;
    function renderTutor() {
        if (!tutorState) { return; }
        showLearn(); clearNode(learnEl);
        var s = tutorState, l = findLesson(s.id);
        var top = h('div', 'ln-tree-top');
        var back = h('button', 'ln-back', '← 返回课程');
        back.onclick = function () { openLesson(s.id); };
        top.appendChild(back);
        var h3 = h('h3'); h3.textContent = '🤖 AI 导师 · ' + (l ? l.name : s.id); top.appendChild(h3);
        learnEl.appendChild(top);
        var box = h('div', 'ln-tutor');
        var msgs = (loadObj(K_TUTOR)[s.id] || []);
        msgs.forEach(function (m) {
            box.appendChild(h('div', 'ln-tmsg ' + (m.role === 'ai' ? 'ai' : 'me'), m.text));
        });
        if (s.step < s.script.length) {
            var ask = h('button', 'ln-ask', '🤔 ' + s.script[s.step] + '（点这里回答）');
            ask.onclick = function () { tutorAdvance('我想想……这一步的关键是「' + (s.script[s.step] || '').slice(0, 6) + '」'); };
            box.appendChild(ask);
        } else {
            box.appendChild(h('div', 'ln-tmsg ai', '很好！你已经走完了这节的思考路径。回到课程，做个过关测验检验一下吧。'));
        }
        learnEl.appendChild(box);
    }
    function tutorAdvance(userText) {
        if (!tutorState) { return; }
        var s = tutorState, cache = loadObj(K_TUTOR), arr = cache[s.id] || [];
        var myText = userText || '我明白了';
        var scriptQ = s.step < s.script.length ? s.script[s.step] : '';
        arr.push({ role: 'me', text: myText });
        cache[s.id] = arr; saveObj(K_TUTOR, cache);
        /* 配了 AI 就用个性化引导；未配置或失败一律回退到离线脚本（保证不配 AI 也完整可用） */
        var fallback = scriptQ ? (scriptQ + ' 先别急着看答案，试着自己推一遍。') : '很好！继续回到课程做过关测验检验一下吧。';
        if (scriptQ) { s.step++; }
        if (window.QAAskAI) {
            arr.push({ role: 'ai', text: '思考中…' });
            cache[s.id] = arr; saveObj(K_TUTOR, cache); renderTutor();
            window.QAAskAI('课程《' + (findLesson(s.id) ? findLesson(s.id).name : s.id) + '》的问题：' + scriptQ + '。学习者回答：' + myText, function (aiText) {
                var c2 = loadObj(K_TUTOR), a2 = c2[s.id] || [];
                var last = a2[a2.length - 1];
                if (last && last.role === 'ai' && last.text === '思考中…') {
                    last.text = aiText || fallback;
                    c2[s.id] = a2; saveObj(K_TUTOR, c2);
                    if (tutorState === s) { renderTutor(); }
                }
            });
        } else {
            arr.push({ role: 'ai', text: fallback });
            cache[s.id] = arr; saveObj(K_TUTOR, cache); renderTutor();
        }
    }

    /* ---------- 对外 API（探针驱动） ---------- */
    window.LearnUI = {
        goto: function (section) { if (section === 'home' || !section) { gotoHome(); } else if (section === 'daily') { openDaily(); } else if (section === 'weak') { openWeak(); } },
        openSubject: openSubject,
        openLesson: openLesson,
        startQuiz: startQuiz,
        answerQuiz: answerQuiz,
        openTutor: openTutor,
        tutorAdvance: tutorAdvance,
        getState: function () { return { view: 'learn', prog: prog(), daily: daily(), quiz: quizState, tutor: tutorState }; },
        getCourse: function () {
            var all = allLessons();
            return { count: all.length, circuit: courseBySubj('circuit').lessons.length, code: courseBySubj('code').lessons.length };
        },
        reset: function () { [K_PROG, K_DAILY, K_TUTOR].forEach(function (k) { try { S.removeItem(k); } catch (e) {} }); }
    };

    /* ---------- 入口绑定：topbar 📖 按钮 ---------- */
    function bindEntry() {
        var btn = $('learnBtn');
        if (btn) {
            btn.onclick = function () {
                /* 学习视图已开 → 回书架；否则进入学习中心 */
                var ln = $('learn');
                if (ln && !ln.hidden) { leaveLearn(); renderShelf(); }
                else { gotoHome(); }
            };
        }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindEntry);
    } else {
        bindEntry();
    }
})();
