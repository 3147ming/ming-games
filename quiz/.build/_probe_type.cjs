// 4.0.1-1：题目 type 字段（choice/fill/calc/experiment）—— 纯函数 + 混合试卷渲染 + AI 预览题型标签
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Session, sleep } = require('./cdp.cjs');

const BUILD = __dirname;
const PORT = 8863;
const APP = process.argv[2] || ('http://127.0.0.1:' + PORT + '/quiz/');
const USE_LOCAL = !process.argv[2];
const pass = [], fail = [];
function ck(n, c, e) { (c ? pass : fail).push(n + (e ? ' :: ' + e : '')); }

/* ---------- 纯函数：从源码里抠出 IIFE 内的实现求值（与 probe_hand 的 isEnglishQ 同一手法） ---------- */
function slice(src, from, to) {
  const i = src.indexOf(from); const j = src.indexOf(to, i + 1);
  if (i < 0 || j < 0) throw new Error('切片失败：' + from);
  return src.slice(i, j);
}
const coreSrc = fs.readFileSync(path.join(BUILD, 'engine_core.js'), 'utf8');
const uiSrc = fs.readFileSync(path.join(BUILD, 'quiz-ui.js'), 'utf8');
const validSrc = slice(coreSrc, 'function validItem(it){', 'function genMathPrimary(');
const typeSrc = slice(uiSrc, '/* ---------- 4.0 自定义题库生成质量', '/* ---------- AI 出题 prompt');
const promptSrc = slice(uiSrc, 'function makeQuizPrompt(name,count,items){', 'function aiBuild(name){');
const P = new Function(validSrc + '\n' + typeSrc + '\n' + promptSrc +
  '\nreturn {validItem:validItem,examLike:examLike,qTypeOf:qTypeOf,isNonChoiceQ:isNonChoiceQ,makeQuizPrompt:makeQuizPrompt};')();

ck('validItem：旧题（无 type）4 选项含答案 → 合格', P.validItem({ q: 'x', a: 'B', opts: ['A', 'B', 'C', 'D'] }) === true);
ck('validItem：旧题只有 3 选项 → 不合格（老闸不放松）', P.validItem({ q: 'x', a: 'B', opts: ['A', 'B', 'C'] }) === false);
ck('validItem：旧题 4 选项但不含答案 → 不合格', P.validItem({ q: 'x', a: 'E', opts: ['A', 'B', 'C', 'D'] }) === false);
ck('validItem：源数组 [q,a,cat,3干扰项] → 仍走老分支（回归）', P.validItem(['题干', '答案', 'geo', 'a|b|c']) === true);
ck('validItem：源数组只有 2 个干扰项 → 仍不合格（回归）', P.validItem(['题干', '答案', 'geo', 'a|b']) === false);
ck('validItem：fill 无选项但有题干答案 → 合格', P.validItem({ type: 'fill', q: '水的化学式', a: 'H2O' }) === true);
ck('validItem：calc 带空 opts → 合格', P.validItem({ type: 'calc', q: '3+4×2', a: '11', opts: [] }) === true);
ck('validItem：experiment 缺答案 → 不合格', P.validItem({ type: 'experiment', q: '现象？', a: '' }) === false);

ck('qTypeOf：缺省 type 归为 choice', P.qTypeOf({ q: 'x' }) === 'choice' && P.qTypeOf(null) === 'choice');
ck('qTypeOf：未知 type 归为 choice', P.qTypeOf({ type: 'essay' }) === 'choice');
ck('qTypeOf：四种取值识别', ['fill', 'calc', 'experiment'].every(t => P.qTypeOf({ type: t }) === t) && P.qTypeOf({ type: 'choice' }) === 'choice');

ck('examLike：非选择题只要有解析/来源就放行（不再卡四选项）',
  P.examLike({ type: 'fill', q: '光合作用释放什么气体？', a: '氧气', opts: [], exp: '光合作用产物为有机物和氧气', src: '人教版生物七上' }) === true);
ck('examLike：非选择题缺解析/来源仍拦',
  P.examLike({ type: 'fill', q: '光合作用释放什么气体？', a: '氧气', opts: [] }) === false);
ck('examLike：选择题缺四选项仍拦',
  P.examLike({ q: '下列哪个是质数？', a: '7', opts: ['7', '9'], exp: '7 只有 1 和自身', src: '人教版数学' }) === false);

const prompt = P.makeQuizPrompt('化学', 20, []);
ck('prompt 返回值里带 type 字段说明', /"type":"choice\|fill\|calc\|experiment"/.test(prompt), prompt.slice(0, 60));
ck('prompt 要求非选择题 opts 留空数组', /opts 留空数组/.test(prompt));
ck('prompt 要求题型混排（每 10 题至少 2 道非单选）', /每 10 题至少 2 道非单选/.test(prompt));
ck('prompt 仍保留「命题老师 + 严禁出的题」', /命题老师/.test(prompt) && /严禁出的题/.test(prompt));

/* ---------- 浏览器：混合试卷渲染与判分 ---------- */
const MIX = [
  { q: '【测】下列哪个是质数？', a: '7', opts: ['7', '9', '15', '21'], type: 'choice', exp: '7 的约数只有 1 和 7', src: '探测题' },
  { q: '【测】下列哪个是偶数？', a: '8', opts: ['8', '9', '11', '13'], type: 'choice', exp: '8 能被 2 整除', src: '探测题' },
  { q: '【测】水的化学式是？', a: 'H2O', type: 'fill', exp: '两个氢原子一个氧原子', src: '探测题' },
  { q: '【测】中国最长的河流是？', a: '长江', type: 'fill', exp: '长江全长约 6300 公里', src: '探测题' },
  { q: '【测】3 + 4 × 2 = ?', a: '11', type: 'calc', exp: '先乘除后加减：4×2=8，3+8=11', src: '探测题' },
  { q: '【测】把铁钉放入硫酸铜溶液中，会看到什么现象？', a: '铁钉表面出现红色物质，溶液由蓝色变浅绿色', type: 'experiment', exp: '铁置换出铜，Fe+CuSO₄=FeSO₄+Cu', src: '探测题' }
];

(async () => {
  const srv = USE_LOCAL ? spawn(process.execPath, [path.join(__dirname, 'serve.cjs'), String(PORT)], { stdio: 'ignore' }) : null;
  if (USE_LOCAL) await sleep(700);
  const s = new Session({ width: 414, height: 896, port: 9387 });
  const txt = (sel) => s.eval("(function(){var e=document.querySelector('" + sel + "');return e?e.textContent:'';})()");
  const clickText = (sel, t) => s.eval("(function(){var b=[].slice.call(document.querySelectorAll('" + sel + "')).filter(function(x){return x.textContent.indexOf('" + t + "')>=0;})[0];if(!b)return 0;b.click();return 1;})()");
  const submitInput = (v) => s.eval("(function(){var i=document.querySelector('#stage input[type=text]');if(!i)return 'no-input';i.value=" + JSON.stringify(v) + ";var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /提交/.test(x.textContent)})[0];if(!b)return 'no-btn';b.click();return 'ok';})()");
  const clickNext = () => s.eval("(function(){var b=document.querySelector('#fbzone .fb .fbnext');if(!b)return 'no-next';b.click();return 'clicked';})()");

  /* AI 桩：POST 回一批混合题型的试卷题；其余请求一律失败（不真联网抓素材） */
  const stub = `(function(){
    window.__aiPrompt='';
    window.fetch=function(u,o){
      if(!o||String(o.method||'GET').toUpperCase()!=='POST')return Promise.reject(new Error('probe: 不联网'));
      var body=String((o&&o.body)||''); window.__aiPrompt=body;
      var content=JSON.stringify([
        {type:'choice',q:'下列关于氧气的说法哪个正确？',a:'氧气能支持燃烧',opts:['氧气能支持燃烧','氧气可燃','氧气有毒','氧气不溶于水'],exp:'氧气助燃但本身不可燃',src:'人教版化学九上'},
        {type:'choice',q:'下列物质属于混合物的是？',a:'空气',opts:['空气','蒸馏水','二氧化碳','铁'],exp:'空气由多种气体组成',src:'人教版化学九上'},
        {type:'fill',q:'实验室制取氧气常用的固体药品是？',a:'高锰酸钾',opts:[],exp:'加热高锰酸钾可分解出氧气',src:'人教版化学九上'},
        {type:'calc',q:'4.8 g 镁完全燃烧生成氧化镁多少克？（只填数值）',a:'8',opts:[],exp:'2Mg+O₂=2MgO，4.8/24=0.2 mol，MgO 为 0.2 mol×40=8 g',src:'中考真题改编'},
        {type:'experiment',q:'用排水法收集氧气结束时，应先做什么？',a:'先把导管移出水面',opts:[],exp:'防止水倒吸使试管炸裂',src:'人教版化学九上'},
        {type:'choice',q:'下列变化属于化学变化的是？',a:'铁生锈',opts:['铁生锈','冰融化','水蒸发','玻璃破碎'],exp:'有新物质生成才是化学变化',src:'人教版化学九上'}
      ]);
      return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve({choices:[{message:{content:content}}]});}});
    };
    return 1;})()`;

  try {
    await s.open(APP);
    await s.ensureLoaded();
    await s.eval("localStorage.clear();localStorage.setItem('bt_qa_quickjump','true');"
      + "localStorage.setItem('bt_qa_ai',JSON.stringify({url:'http://127.0.0.1:9/v1/chat/completions',key:'k',model:'m',proxy:''}));"
      + "localStorage.setItem('bt_qa_custom',JSON.stringify({混合试卷探测:" + JSON.stringify(MIX) + "}));1");
    await s.reload();
    await s.ensureLoaded();
    await s.waitFor('!!document.querySelector(".book")', 15000);
    await s.eval("window.confirm=function(){return true;};window.alert=function(){};1");

    /* ---------- D. 混合试卷：HUD + 渲染分支 ---------- */
    ck('书架出现自定义题库「混合试卷探测」', /混合试卷探测/.test(await txt('#shelf')));
    await clickText('#shelf .book', '混合试卷探测');
    await s.waitFor("!!document.querySelector('#stage .qcard')", 10000);
    const hudSec = await txt('#stage .hud .chip.sec');
    ck('HUD 板块标签显示「混合试卷」而不是「选择题」', /混合试卷/.test(hudSec), hudSec);

    const seen = [];
    let wrongDone = false;
    for (let i = 0; i < MIX.length; i++) {
      await s.waitFor("!!document.querySelector('#stage .qcard')", 8000);
      const info = JSON.parse(await s.eval("(function(){var Q=qlist[qidx]||{};return JSON.stringify({ty:Q.type||'choice',n:document.querySelectorAll('#stage .obtn').length,inp:!!document.querySelector('#stage input[type=text]'),ph:(document.querySelector('#stage input[type=text]')||{}).placeholder||''});})()"));
      seen.push(info.ty);
      if (info.ty === 'choice') {
        ck('第 ' + (i + 1) + ' 题（choice）渲染 4 个选项、无输入框', info.n === 4 && info.inp === false, JSON.stringify(info));
      } else {
        ck('第 ' + (i + 1) + ' 题（' + info.ty + '）走输入框、无选项', info.n === 0 && info.inp === true, JSON.stringify(info));
      }
      /* 第一道非选择题故意答错：验证「判不中给解析」+ 答错不自动跳 */
      if (!wrongDone && info.ty !== 'choice') {
        wrongDone = true;
        const w0 = await s.eval('qidx');
        await submitInput('完全不相关的答案zzz');
        await sleep(400);
        const fb = await txt('#fbzone .fb');
        ck('非选择题答错 → 给出正确答案与解析', /❌/.test(fb) && /正确答案：/.test(fb) && /💡 解析：/.test(fb), fb.replace(/\s+/g, ' ').slice(0, 100));
        await sleep(1300);
        ck('非选择题答错不自动跳', (await s.eval('qidx')) === w0, w0 + '→' + (await s.eval('qidx')));
        await clickNext();
        await sleep(400);
        continue;
      }
      if (info.ty === 'choice') {
        await s.eval("(function(){var Q=qlist[qidx];var t=String(Q.a);var bs=[].slice.call(document.querySelectorAll('#stage .obtn'));for(var j=0;j<bs.length;j++){if(bs[j].textContent===t){bs[j].click();return 1;}}return 0;})()");
        await sleep(350);
        ck('choice 题答对给 +10 与解析', /✅/.test(await txt('#fbzone .fb')), (await txt('#fbzone .fb')).slice(0, 40));
      } else {
        const ans = await s.eval("(function(){var Q=qlist[qidx];return String(Q.a);})()");
        await submitInput(ans);
        await sleep(350);
        ck('「' + info.ty + '」题输入标准答案判对', /✅/.test(await txt('#fbzone .fb')), (await txt('#fbzone .fb')).slice(0, 40));
      }
      await clickNext();
      await sleep(400);
    }
    ck('本局确实是混合题型（choice + 至少 2 种非 choice）',
      seen.filter(t => t === 'choice').length > 0 && new Set(seen.filter(t => t !== 'choice')).size >= 2, seen.join(','));

    /* ---------- E. AI 建题库：预览题型标签 → 入库 → 混合试卷 ---------- */
    if (await s.eval("!!document.querySelector('#stage .btn')")) { await clickText('#stage .btn', '返回书架'); await sleep(400); }
    if (!(await s.eval("!!document.querySelector('.book')"))) { await s.eval("document.getElementById('backBtn').click();1"); await sleep(600); }
    await s.waitFor('!!document.querySelector(".book")', 12000);
    await s.eval(stub);
    await clickText('.act', '新建');
    await s.waitFor("!!document.querySelector('#curOverlay input')", 8000);
    await s.eval("(function(){var i=document.querySelector('#curOverlay input');i.value='化学卷二';return 1;})()");
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return /AI/.test(x.textContent)})[0];if(b)b.click();return 1;})()");
    /* gatherMaterial 走 JSONP，失败要等超时；给足 40 秒 */
    let rows = [];
    for (let i = 0; i < 20; i++) {
      await sleep(2000);
      rows = JSON.parse(await s.eval("JSON.stringify([].slice.call(document.querySelectorAll('#stage .list-row')).map(function(r){return r.textContent.replace(/\\s+/g,' ');}))"));
      if (rows.length) break;
    }
    ck('AI 预览列出题目', rows.length >= 5, 'rows=' + rows.length + ' | ' + (await txt('#stage .hud')));
    const labels = rows.map(r => (r.match(/〔(单选|填空|计算|实验)〕/) || [])[1]).filter(Boolean);
    ck('预览每题带题型标签', labels.length === rows.length, labels.join(',') + ' rows=' + rows.length);
    ck('预览里出现填空/计算/实验三类非单选', ['填空', '计算', '实验'].every(t => labels.indexOf(t) >= 0), labels.join(','));
    const promptSeen = await s.eval("(function(){try{return JSON.parse(window.__aiPrompt).messages[0].content;}catch(e){return String(window.__aiPrompt||'');}})()");
    ck('实际发出的出题 prompt 含 type 与「opts 留空数组」', /"type"/.test(promptSeen) && /opts 留空数组/.test(promptSeen), String(promptSeen).slice(0, 60));

    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /入库并开始/.test(x.textContent)})[0];if(b)b.click();return 1;})()");
    await s.waitFor("!!document.querySelector('#stage .qcard')", 12000);
    const hud2 = await txt('#stage .hud .chip.sec');
    ck('入库开局的 HUD 是「混合试卷」', /混合试卷/.test(hud2), hud2);
    const types2 = JSON.parse(await s.eval("JSON.stringify(qlist.map(function(Q){return Q.type||'choice';}))"));
    ck('入库后题目 type 保留（不是全 choice）', types2.filter(t => t !== 'choice').length >= 2, types2.join(','));
    const firstNonChoice = JSON.parse(await s.eval("(function(){var i=-1;for(var k=0;k<qlist.length;k++){if(qlist[k].type&&qlist[k].type!=='choice'){i=k;break;}}return JSON.stringify({i:i,ty:i>=0?qlist[i].type:'none'});})()"));
    ck('入库后的非选择题在队列里', firstNonChoice.i >= 0, JSON.stringify(firstNonChoice));

    ck('运行期无 JS 异常', s.errors.length === 0, s.errors.slice(0, 2).join(' | '));
  } catch (e) {
    fail.push('运行异常 :: ' + (e && e.message));
  } finally {
    try { await s.close(); } catch (e) {}
    if (srv) srv.kill();
  }
  console.log('=== 4.0.1-1 题目 type 字段：' + pass.length + '/' + (pass.length + fail.length) + ' 通过 ===');
  pass.forEach(p => console.log('  ✓ ' + p));
  fail.forEach(f => console.log('  ✗ ' + f));
  process.exit(fail.length ? 1 : 0);
})();
