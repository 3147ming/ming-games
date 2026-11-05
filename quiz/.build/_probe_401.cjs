// 4.0.1-3（手写题「不会」不进本局错题）+ 4.0.1-4（examLike 误杀/漏网）
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Session, sleep } = require('./cdp.cjs');

const BUILD = __dirname;
const PORT = 8865;
const APP = process.argv[2] || ('http://127.0.0.1:' + PORT + '/quiz/');
const USE_LOCAL = !process.argv[2];
const pass = [], fail = [];
function ck(n, c, e) { (c ? pass : fail).push(n + (e ? ' :: ' + e : '')); }

function slice(src, from, to) {
  const i = src.indexOf(from); const j = src.indexOf(to, i + 1);
  if (i < 0 || j < 0) throw new Error('切片失败：' + from);
  return src.slice(i, j);
}
const coreSrc = fs.readFileSync(path.join(BUILD, 'engine_core.js'), 'utf8');
const uiSrc = fs.readFileSync(path.join(BUILD, 'quiz-ui.js'), 'utf8');
const validSrc = slice(coreSrc, 'function validItem(it){', 'function genMathPrimary(');
const typeSrc = slice(uiSrc, '/* ---------- 4.0 自定义题库生成质量', '/* ---------- AI 出题 prompt');
const P = new Function(validSrc + '\n' + typeSrc +
  '\nreturn {validItem:validItem,examLike:examLike,isAcademic:isAcademic,META_Q_RE:META_Q_RE,ACADEMIC_RE:ACADEMIC_RE};')();

/* ---------- 纯函数 ---------- */
ck('META_Q_RE 不再无条件拦「作者是」：《红楼梦》的作者是谁？放行',
  P.META_Q_RE.test('《红楼梦》的作者是谁？') === false);
ck('META_Q_RE 仍拦书目元信息：作者是 + 出版社',
  P.META_Q_RE.test('《红楼梦》的作者是人民文学出版社的曹雪芹') === true);
ck('META_Q_RE 仍拦「出版社」本身', P.META_Q_RE.test('该书由某出版社出版') === true);
ck('examLike：《红楼梦》的作者是谁？（4 选项 + 解析）不被误杀',
  P.examLike({ q: '《红楼梦》的作者是谁？', a: '曹雪芹', opts: ['曹雪芹', '罗贯中', '吴承恩', '施耐庵'], exp: '曹雪芹著《红楼梦》', src: '人教版语文' }) === true);
ck('examLike：书目元信息题仍被拦',
  P.examLike({ q: '《XX》一书由哪个出版社出版？', a: '人民文学出版社', opts: ['人民文学出版社', '商务印书馆', '中华书局', '三联书店'], exp: 'x', src: 'y' }) === false);
ck('ACADEMIC_RE 补上文学类（文学/名著/古诗/文言文）',
  ['文学', '名著', '古诗', '文言文'].every(x => P.isAcademic(x)), ['文学', '名著', '古诗', '文言文'].filter(x => !P.isAcademic(x)).join(','));
ck('ACADEMIC_RE 不误伤普通主题（三角洲/咖啡）', !P.isAcademic('三角洲') && !P.isAcademic('咖啡'));

(async () => {
  const srv = USE_LOCAL ? spawn(process.execPath, [path.join(__dirname, 'serve.cjs'), String(PORT)], { stdio: 'ignore' }) : null;
  if (USE_LOCAL) await sleep(700);
  const s = new Session({ width: 414, height: 896, port: 9389 });
  const txt = (sel) => s.eval("(function(){var e=document.querySelector('" + sel + "');return e?e.textContent:'';})()");
  const clickText = (sel, t) => s.eval("(function(){var b=[].slice.call(document.querySelectorAll('" + sel + "')).filter(function(x){return x.textContent.indexOf('" + t + "')>=0;})[0];if(!b)return 0;b.click();return 1;})()");

  try {
    await s.open(APP);
    await s.ensureLoaded();
    await s.eval("localStorage.clear();localStorage.setItem('bt_qa_quickjump','true');"
      + "localStorage.setItem('bt_qa_profile_code',JSON.stringify({done:true,skipped:true,langs:[],level:0,rank:0}));"
      + "localStorage.setItem('bt_qa_ai',JSON.stringify({url:'http://127.0.0.1:9/v1/chat/completions',key:'k',model:'m',proxy:''}));1");
    await s.reload();
    await s.ensureLoaded();
    await s.waitFor('!!document.querySelector(".book")', 15000);
    await s.eval("window.confirm=function(){return true;};window.alert=function(){};window.fetch=function(){return Promise.reject(new Error('probe: 不联网'));};1");

    /* ---------- A. 免费搜索：学科主题立刻拦，不再白等 6 秒 ---------- */
    await clickText('.act', '新建');
    await s.waitFor("!!document.querySelector('#curOverlay input')", 8000);
    await s.eval("(function(){var i=document.querySelector('#curOverlay input');i.value='文学';return 1;})()");
    const t0 = Date.now();
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return /免费搜索/.test(x.textContent)})[0];if(b)b.click();return 1;})()");
    let hit = false, waited = 0;
    for (let i = 0; i < 25; i++) {
      await sleep(200); waited = Date.now() - t0;
      const t = await txt('#stage');
      if (/学科类主题/.test(t)) { hit = true; break; }
    }
    ck('免费搜索学科主题立即给提示（不等抓资料）', hit && waited < 3000, '耗时 ' + waited + 'ms');
    const fbTxt = await txt('#stage');
    ck('提示同时给出「配置 AI」与「手动录入」两条出路', /配置 AI/.test(fbTxt) && /手动录入/.test(fbTxt), fbTxt.replace(/\s+/g, ' ').slice(0, 90));
    ck('没有真的去抓百科（无 list-row 生成）', (await s.eval("document.querySelectorAll('#stage .list-row').length")) === 0);

    /* ---------- B. 手写题点「不会」不进本局错题 ---------- */
    await clickText('#stage .btn', '返回书架');
    await s.waitFor('!!document.querySelector(".book")', 12000);
    await clickText('.book', '编程');
    await s.waitFor("!!document.querySelector('.secbtn')||!!document.querySelector('.diffbtn')", 10000);
    if (await s.eval("!!document.querySelector('.secbtn')")) { await clickText('.secbtn', '程序编写'); await s.waitFor("!!document.querySelector('.diffbtn')", 8000); }
    await s.eval("(function(){document.querySelectorAll('#curOverlay .diffbtn')[0].click();var go=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return /开始出题/.test(x.textContent)})[0];if(go)go.click();return 1;})()");
    await s.waitFor("!!document.querySelector('#stage .toggle')", 10000);
    await clickText('#stage .toggle', '手写代码');
    await s.waitFor("!!document.querySelector('#stage .codeinp')", 8000);
    await clickText('#stage .unkbtn', '不会');
    await s.waitFor("!!document.querySelector('#fbzone .fb')", 6000);
    ck('手写题点「不会」仍给参考代码与思路', /参考代码/.test(await txt('#fbzone .fb')));
    await clickText('#stage .quizfoot .btn', '结束并结算');
    await s.waitFor("document.querySelector('#stage').textContent.indexOf('正确率')>=0", 9000);
    const fin1 = await txt('#stage');
    ck('手写题「不会」不进本局错题（结算页无错题区）', !/本局错题/.test(fin1), fin1.replace(/\s+/g, ' ').slice(0, 70));

    /* ---------- C. 对照：读代码题点「不会」照旧进本局错题 ---------- */
    await clickText('#stage .btn', '返回书架');
    await s.waitFor('!!document.querySelector(".book")', 12000);
    await clickText('.book', '编程');
    await s.waitFor("!!document.querySelector('.secbtn')||!!document.querySelector('.diffbtn')", 10000);
    if (await s.eval("!!document.querySelector('.secbtn')")) { await clickText('.secbtn', '选择题'); await s.waitFor("!!document.querySelector('.diffbtn')", 8000); }
    await s.eval("(function(){document.querySelectorAll('#curOverlay .diffbtn')[0].click();var go=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return /开始出题/.test(x.textContent)})[0];if(go)go.click();return 1;})()");
    await s.waitFor("!!document.querySelector('#stage .obtn')||!!document.querySelector('#stage .unkbtn')", 10000);
    await clickText('#stage .unkbtn', '不会');
    await s.waitFor("!!document.querySelector('#fbzone .fb')", 6000);
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .quizfoot .btn')).filter(function(x){return /结束并结算/.test(x.textContent)})[0];if(b)b.click();return 1;})()");
    await s.waitFor("document.querySelector('#stage').textContent.indexOf('正确率')>=0", 9000);
    const fin2 = await txt('#stage');
    ck('对照：非手写题点「不会」仍进本局错题', /本局错题（\d+ 道）/.test(fin2), fin2.replace(/\s+/g, ' ').slice(0, 70));

    ck('运行期无 JS 异常', s.errors.length === 0, s.errors.slice(0, 2).join(' | '));
  } catch (e) {
    fail.push('运行异常 :: ' + (e && e.message));
  } finally {
    try { await s.close(); } catch (e) {}
    if (srv) srv.kill();
  }
  console.log('=== 4.0.1-3/4 手写错题与 examLike：' + pass.length + '/' + (pass.length + fail.length) + ' 通过 ===');
  pass.forEach(p => console.log('  ✓ ' + p));
  fail.forEach(f => console.log('  ✗ ' + f));
  process.exit(fail.length ? 1 : 0);
})();
