/* 学习中心真实 UI 冒烟（CDP 驱动产物 index.html）：独立端口与 profile，避免与 _runall 串扰。
   覆盖：入口 → 首页三场景/学科卡 → 技能树 → 微课七段 → 形成性练习 → 过关测验 → AI导师 → 今日任务。 */
const { spawn } = require('child_process');
const path = require('path');
const { Session, sleep } = require('./cdp.cjs');
const PORT = 8936;
const CDP = 9436;
const pass = [], fail = [];
function ck(n, c, e) { (c ? pass : fail).push(n + (e ? ' :: ' + e : '')); }

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, 'serve.cjs'), String(PORT)], { stdio: 'ignore' });
  await sleep(700);
  const s = new Session({ width: 414, height: 896, port: CDP });
  try {
    await s.open('http://127.0.0.1:' + PORT + '/quiz/');
    await s.eval('localStorage.clear();1');
    await s.eval("navigator.serviceWorker.getRegistrations().then(function(rs){return Promise.all(rs.map(function(r){return r.unregister();}));}).then(function(){return 1;})");
    await s.eval("localStorage.setItem('bt_qa_quickjump','true');localStorage.setItem('bt_qa_onboard','done');1");
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 15000);

    // A. 学习入口与全局对象
    ck('topbar 有 📖 学习入口', await s.eval("!!document.getElementById('learnBtn')"));
    ck('LearnCore 已装配', await s.eval("typeof LearnCore==='object' && typeof LearnCore.applyLessonResult==='function'"));
    ck('COURSE_DATA 已装配', await s.eval("typeof COURSE_DATA==='object' && COURSE_DATA.circuit && COURSE_DATA.code"));
    ck('LearnUI API 已装配', await s.eval("typeof LearnUI==='object' && typeof LearnUI.openSubject==='function'"));
    const courseN = JSON.parse(await s.eval("JSON.stringify(LearnUI.getCourse())"));
    ck('课程 71 节（电路46+编程25）', courseN.count === 71 && courseN.circuit === 46 && courseN.code === 25, JSON.stringify(courseN));

    // A2. P4 存储注册 / schema 迁移 / AI 桥接
    ck('存储 schema = 3', await s.eval("localStorage.getItem('bt_qa_schema')==='3'"));
    ck('AI 导师桥接已导出', await s.eval("typeof window.QAAskAI==='function'"));
    /* 备份清单 membership 由 _probe_shelf 沙箱断言覆盖；这里只验浏览器里 3 个键可读写的实际行为 */
    const keysRw = JSON.parse(await s.eval("(function(){var ks=['bt_qa_learn_prog','bt_qa_learn_daily','bt_qa_learn_tutor'],ok=0;ks.forEach(function(k){localStorage.setItem(k,'{}');if(localStorage.getItem(k)==='{}')ok++;});return String(ok);})()"));
    ck('3 个学习键浏览器可读写', keysRw === 3, String(keysRw));
    /* 迁移不伤合法学习进度：写入合法 prog，强制迁移后逐字节不变 */
    const keepProg = JSON.parse(await s.eval("(function(){localStorage.setItem('bt_qa_learn_prog',JSON.stringify({c01:{mastery:88,status:'passed'}}));localStorage.removeItem('bt_qa_schema');if(typeof migrateStore==='function')migrateStore();return localStorage.getItem('bt_qa_learn_prog');})()"));
    ck('迁移保留合法学习进度', keepProg && keepProg.c01 && keepProg.c01.mastery === 88, String(keepProg));
    await s.eval("localStorage.removeItem('bt_qa_learn_prog');localStorage.setItem('bt_qa_schema','3');1");

    // B. 进入学习中心首页
    await s.eval("document.getElementById('learnBtn').click();1");
    await s.waitFor("(()=>{var e=document.getElementById('learn');return e&&!e.hidden&&e.querySelector('.ln-hero');})()", 6000);
    ck('学习视图显示且书架隐藏', await s.eval("document.getElementById('learn').hidden===false && document.getElementById('shelf').hidden===true"));
    const hero = await s.eval("document.querySelector('.ln-hero').textContent.replace(/\\s+/g,' ')");
    ck('首页 Hero 文案', /从零开始/.test(hero), hero.slice(0, 60));
    ck('三场景卡', await s.eval("document.querySelectorAll('.ln-scene').length===3"));
    const scenes = await s.eval("Array.prototype.map.call(document.querySelectorAll('.ln-scene .ln-t'),function(e){return e.textContent;}).join('|')");
    ck('三场景含预习/复习/冲刺', /课前预习/.test(scenes) && /课后复习/.test(scenes) && /考前冲刺/.test(scenes), scenes);
    ck('两门学科卡', await s.eval("document.querySelectorAll('.ln-subjcard').length===2"));

    // C. 技能树（电路）
    await s.eval("LearnUI.openSubject('circuit');1");
    await s.waitFor("!!document.querySelector('.ln-node')", 5000);
    const nodeN = await s.eval("document.querySelectorAll('.ln-node').length");
    ck('电路技能树 46 节点', nodeN === 46, String(nodeN));
    ck('技能树有顶层起点可学', await s.eval("document.querySelectorAll('.ln-node.st-available').length>0"));
    ck('技能树有锁定节点', await s.eval("document.querySelectorAll('.ln-node.st-locked').length>0"));
    ck('技能树有图例', await s.eval("document.querySelectorAll('.ln-legend span').length===4"));

    // D. 微课七段（c03 样例节，基础节，起点依赖已满足）
    await s.eval("LearnUI.openLesson('c01');1");
    await s.waitFor("document.querySelectorAll('.ln-seg').length>=6", 5000);
    const segN = await s.eval("document.querySelectorAll('.ln-seg').length");
    ck('微课七段渲染（≥6 段）', segN >= 6, String(segN));
    const segTxt = await s.eval("document.getElementById('learn').textContent.replace(/\\s+/g,' ')");
    ck('微课含零基础引入', /先想一个问题/.test(segTxt));
    ck('微课含核心概念', /核心概念/.test(segTxt));
    ck('微课含分步例题', /分步例题/.test(segTxt));
    ck('微课含易错点', /易错点/.test(segTxt));
    ck('微课含过关测验', /过关测验/.test(segTxt));
    ck('微课含 AI 导师', /AI 学习导师/.test(segTxt));
    ck('例题有验算步骤', await s.eval("document.querySelectorAll('.ln-vex').length>0"));

    // E. 过关测验：全答对 → 过关 → 写入进度 → 解锁
    await s.eval("LearnUI.startQuiz('c01');1");
    await s.waitFor("document.querySelectorAll('#learn .opts .obtn').length===4", 5000);
    const qN = JSON.parse(await s.eval("String(LearnUI.getState().quiz.qs.length)"));
    ck('过关卡 5 题', qN === 5, String(qN));
    for (let i = 0; i < 5; i++) {
      await s.eval("LearnUI.answerQuiz(true);1");
      await sleep(650);
    }
    await s.waitFor("!!document.querySelector('.ln-result')", 5000);
    const result = await s.eval("document.querySelector('.ln-result').textContent.replace(/\\s+/g,' ')");
    ck('全答对显示过关', /过关/.test(result), result.slice(0, 70));
    const progAfter = JSON.parse(await s.eval("JSON.stringify(LearnUI.getState().prog.c01)"));
    ck('过关写入进度 status=passed', progAfter && progAfter.status === 'passed', JSON.stringify(progAfter));
    ck('过关掌握度≥80', progAfter && progAfter.mastery >= 80, String(progAfter && progAfter.mastery));
    ck('过关有 SRS 记录', !!(progAfter && progAfter.srs));

    // F. 过关后 c01 下游节点解锁（c02 依赖 c01）
    const unlocked = JSON.parse(await s.eval("(function(){var t=LearnCore.computeTree(COURSE_DATA.circuit,LearnUI.getState().prog);return JSON.stringify({c01:t.c01.state,c02:t.c02.state});})()"));
    ck('过关后 c01=passed', unlocked.c01 === 'passed', JSON.stringify(unlocked));
    ck('过关后下游可解锁（非 locked）', unlocked.c02 !== 'locked', JSON.stringify(unlocked));

    // G. AI 导师苏格拉底对话
    await s.eval("LearnUI.openTutor('c01');1");
    await s.waitFor("!!document.querySelector('.ln-tutor')", 5000);
    ck('导师对话有开场白', await s.eval("document.querySelectorAll('.ln-tmsg.ai').length>=1"));
    ck('导师有引导提问按钮', await s.eval("!!document.querySelector('.ln-ask')"));
    await s.eval("LearnUI.tutorAdvance('我的思路是分压');1");
    ck('导师对话推进（用户+AI 各一条）', await s.eval("document.querySelectorAll('.ln-tmsg.me').length>=1 && document.querySelectorAll('.ln-tmsg.ai').length>=2"));

    // H. 今日任务 + 打卡
    await s.eval("LearnUI.goto('home');1");
    await s.waitFor("!!document.querySelector('.ln-daily')", 5000);
    ck('首页今日任务卡', await s.eval("!!document.querySelector('.ln-daily')"));
    ck('连续打卡显示', /连续/.test(await s.eval("document.querySelector('.ln-streak').textContent")));
    const dailyBefore = JSON.parse(await s.eval("JSON.stringify(LearnUI.getState().daily)"));
    ck('打卡记录已初始化或为空', typeof dailyBefore === 'object');

    console.log('\n=== 学习中心 UI 探针：' + pass.length + '/' + (pass.length + fail.length) + ' 项通过 ===');
    fail.forEach(f => console.log('  ✗ ' + f));
    if (fail.length) process.exitCode = 1;
  } catch (e) {
    console.log('  ✗ 测量异常：' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 5).join('\n'));
    process.exitCode = 1;
  } finally {
    await s.close();
    srv.kill('SIGKILL');
  }
})();
