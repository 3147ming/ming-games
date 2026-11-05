// 任务2 专项：语言过滤 / 试水校准 / 徽标 / 自评记忆；任务3 免费搜索
const { Session } = require('./cdp.cjs');
const URL = process.argv[2] || 'file:///D:/Projects/_github_pages/ming-games/quiz/index.html';
const pass = [], fail = [];
function ck(n, c, e) { (c ? pass : fail).push(n + (e ? ' :: ' + e : '')); }
const clickText = (sel, txt) => `(function(){var a=[].slice.call(document.querySelectorAll('${sel}'));var e=a.filter(function(x){return (x.textContent||'').indexOf('${txt}')>=0;})[0];if(e){e.click();return true;}return false;})()`;

// 采集 n 道编程题的题干（用「下一题」逐题推进）
async function collectCodeQuestions(s, n, diffIdx) {
  await s.waitFor('!!document.querySelector(".book")', 12000);
  await s.eval(clickText('.book', '编程'));
  await s.waitFor('!!document.querySelector(".diffbtn") || !!document.querySelector(".tagbtn")', 10000);
  if (await s.eval('!!document.querySelector(".tagbtn")')) {
    // 首次会弹问卷 → 用注入的 profile 时不该出现
    await s.eval(clickText('#curOverlay .btn', '跳过'));
    await s.waitFor('!!document.querySelector(".diffbtn") || !!document.querySelector(".secbtn")', 8000);
  }
  if (await s.eval('!!document.querySelector(".secbtn")')) {
    await s.eval(clickText('.secbtn', '选择题'));
    await s.waitFor('!!document.querySelector(".diffbtn")', 8000);
  }
  await s.eval(`(function(){var b=document.querySelectorAll('.diffbtn')[${diffIdx}];if(b)b.click();var go=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return /开始出题/.test(x.textContent)})[0];if(go)go.click();return 1})()`);
  await s.waitFor('!!document.querySelector(".obtn") || !!document.querySelector(".qbox")', 10000);
  const out = [];
  for (let i = 0; i < n; i++) {
    const q = await s.eval('(document.querySelector(".qbox")||{}).textContent||""');
    if (q) out.push(q);
    const before = q;
    await s.eval('(function(){var u=[].slice.call(document.querySelectorAll("button")).filter(function(x){return /不会/.test(x.textContent)&&!x.disabled;})[0];if(u)u.click();return 1})()');
    // 等下一题出现或结算页出现
    await s.waitFor(
      '(function(){var q=(document.querySelector(".qbox")||{}).textContent||"";' +
      'var end=[].slice.call(document.querySelectorAll("button")).filter(function(x){return /再来一局/.test(x.textContent)})[0];' +
      'return !!(end || (q && q!==' + JSON.stringify(before) + '));})()',
      9000
    );
    if (await s.eval('!!([].slice.call(document.querySelectorAll("button")).filter(function(x){return /再来一局/.test(x.textContent)})[0])')) break;
  }
  // 回书架
  await s.eval('(function(){var b=[].slice.call(document.querySelectorAll("button")).filter(function(x){return /返回书架/.test(x.textContent)})[0];if(b)b.click();return 1})()');
  await s.wait(300);
  return out;
}

(async () => {
  const s = new Session({ width: 414, height: 896, port: 9347 });
  await s.open(URL);
  await s.eval("localStorage.setItem('bt_qa_quickjump','true');1");
  try {
    // ---------- A. 只勾 C 时不应出现 Python/Java/JS/SQL/HTML 专属题 ----------
    await s.eval(`localStorage.setItem('bt_qa_profile_code', JSON.stringify({done:true,langs:['c'],level:0,rank:0}));1`);
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);
    const cQ = await collectCodeQuestions(s, 10, 1);
    const bad = cQ.filter((q) => /Python|JavaScript|typeof|const |let |SELECT|INSERT|HTML|CSS|组件化|length|JSON/.test(q));
    ck('勾选 C 后无 Python/Java/JS/SQL/前端 专属题', bad.length === 0, bad.slice(0, 3).join(' / ') || ('共 ' + cQ.length + ' 题'));
    ck('C 档仍能出满题', cQ.length >= 8, 'n=' + cQ.length);

    // ---------- B. 徽标 ----------
    await s.eval(clickText('.book', '编程'));
    await s.wait(300);
    const diffPanel = await s.eval('(function(){var e=document.querySelector("#curOverlay .okmsg");return e?e.textContent:"";})()');
    ck('难度面板显示已检测信息', /C \/ C\+\+/.test(diffPanel), diffPanel);
    await s.eval('(function(){document.querySelectorAll(".diffbtn")[1].click();var go=[].slice.call(document.querySelectorAll("#curOverlay .btn")).filter(function(x){return /开始出题/.test(x.textContent)})[0];go.click();return 1})()');
    await s.wait(450);
    const hud = await s.eval('(function(){var h=document.querySelector(".hud .hl");return h?h.textContent:"";})()');
    ck('答题页顶部显示「已检测」徽标', /C \/ C\+\+/.test(hud) && /入门|进阶|熟练/.test(hud), hud);

    // ---------- C. 只勾 Python：不应出现 C 语言/指针 ----------
    await s.eval(`localStorage.setItem('bt_qa_profile_code', JSON.stringify({done:true,langs:['python'],level:1,rank:1}));1`);
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);
    const pQ = await collectCodeQuestions(s, 10, 1);
    const bad2 = pQ.filter((q) => /C 语言|指针|块注释|C 系/.test(q));
    ck('勾选 Python 后无 C 专属题', bad2.length === 0, bad2.slice(0, 3).join(' / ') || ('共 ' + pQ.length + ' 题'));

    // ---------- D. 自评难度记忆（非编程分类） ----------
    await s.eval(`localStorage.setItem('bd_qa_diff_geo','2');1`);
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);
    await s.eval(clickText('.book', '地理'));
    await s.wait(300);
    await s.eval(clickText('.secbtn', '选择题'));
    await s.wait(250);
    const sel = await s.eval('(function(){var b=[].slice.call(document.querySelectorAll(".diffbtn")).filter(function(x){return x.classList.contains("sel")})[0];return b?b.textContent:"";})()');
    ck('自评难度记忆生效并高亮', /困难|20/.test(sel), sel);
    await s.eval('(function(){var go=[].slice.call(document.querySelectorAll("#curOverlay .btn")).filter(function(x){return /开始出题/.test(x.textContent)})[0];go.click();return 1})()');
    await s.wait(400);
    const hudGeo = await s.eval('(function(){var h=document.querySelector(".hud .hl");return h?h.textContent:"";})()');
    ck('困难档进入后 HUD 显示困难', /困难/.test(hudGeo), hudGeo);

    // ---------- E. 免费搜索建题库 ----------
    await s.eval(clickText('button', '退出本局'));
    await s.wait(300);
    await s.eval(`(function(){var b=[].slice.call(document.querySelectorAll('.act')).filter(function(x){return /新建/.test(x.textContent)})[0];b.click();return 1})()`);
    await s.wait(250);
    await s.eval(`(function(){var i=document.querySelector('#curOverlay input');i.value='化学';i.dispatchEvent(new Event('input'));return 1})()`);
    await s.eval(clickText('#curOverlay .btn', '免费搜索'));
    let fr = { txt: '', rows: 0 };
    for (let i = 0; i < 20; i++) {
      await s.wait(1500);
      fr = JSON.parse(await s.eval('JSON.stringify({txt:((document.querySelector("#stage .hud")||{}).textContent||""), rows:document.querySelectorAll("#stage .list-row").length})'));
      if (fr.rows > 0) break;
    }
    ck('免费搜索（化学）生成 ≥6 题', fr.rows >= 6, 'rows=' + fr.rows + ' | ' + fr.txt);

    ck('无 JS 异常', s.errors.length === 0, s.errors.join(' | ').slice(0, 300));
  } catch (e) {
    fail.push('EXCEPTION :: ' + e.message);
  }
  await s.close();
  console.log('=== 任务2/3 探针：' + pass.length + '/' + (pass.length + fail.length) + ' 通过 ===');
  if (fail.length) { console.log('--- 失败 ---'); fail.forEach((f) => console.log('  ✗ ' + f)); }
  pass.forEach((p) => console.log('  ✓ ' + p));
  process.exit(fail.length ? 1 : 0);
})();
