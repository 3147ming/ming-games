// 全流程冒烟：书架 → 数学(自动匹配)答题 → 不会 → 结算重放 → 编程检测 → 音乐 → 设置 → 统计
const { Session } = require('./cdp.cjs');
const url = process.argv[2] || 'file:///D:/Projects/_github_pages/ming-games/quiz/index.html';
const pass = [], fail = [];
function ck(name, cond, extra) { (cond ? pass : fail).push(name + (extra ? ' :: ' + extra : '')); }

function clickText(sel, txt) {
  return `(function(){var a=[].slice.call(document.querySelectorAll('${sel}'));var e=a.filter(function(x){return (x.textContent||'').indexOf('${txt}')>=0;})[0];if(e){e.click();return true;}return false;})()`;
}

// 反复答题直到出现结算页（每题后 UI 有 800ms 延时切题，必须真等待）
async function playUntilEnd(s, maxQ) {
  for (let i = 0; i < (maxQ || 16); i++) {
    const hasEnd = await s.eval('!!([].slice.call(document.querySelectorAll("button")).filter(function(x){return /再来一局/.test(x.textContent)})[0])');
    if (hasEnd) return true;
    const clicked = await s.eval('(function(){var o=document.querySelector(".obtn:not([disabled])");if(o){o.click();return "ans";}var u=[].slice.call(document.querySelectorAll("button")).filter(function(x){return /不会/.test(x.textContent)&&!x.disabled;})[0];if(u){u.click();return "unk";}return "none";})()');
    if (clicked === 'none') await s.wait(300);
    await s.wait(950);
  }
  return await s.eval('!!([].slice.call(document.querySelectorAll("button")).filter(function(x){return /再来一局/.test(x.textContent)})[0])');
}

(async () => {
  const s = new Session({ width: 414, height: 896, port: 9342 });
  await s.open(url);
  try {
    await s.ensureLoaded();   // 线上先验文档完整性（抓包代理会截断 HTML），不健康自动重载
    // ---------- 1. 书架 ----------
    const o = JSON.parse(await s.eval('JSON.stringify({books:document.querySelectorAll(".book").length, shelf:!document.getElementById("shelf").hidden, title:document.title})'));
    ck('书架书籍数 >= 10', o.books >= 10, 'books=' + o.books);
    ck('初始显示书架', o.shelf === true);
    ck('标题含知识问答', /知识问答/.test(o.title), o.title);

    // ---------- 2. 数学难度面板 ----------
    await s.eval(clickText('.book', '数学'));
    await s.wait(250);
    await s.eval(clickText('.secbtn', '选择题'));
    await s.wait(250);
    const d = JSON.parse(await s.eval('JSON.stringify({panel:!!document.getElementById("curOverlay"), btns:document.querySelectorAll(".diffbtn").length, first:(document.querySelectorAll(".diffbtn")[0]||{}).textContent||""})'));
    ck('难度面板弹出', d.panel === true);
    ck('数学档位 = 自动 + 4 学业阶段', d.btns === 5, 'btns=' + d.btns);
    ck('含 🤖 自动匹配', /自动匹配/.test(d.first), d.first);

    // ---------- 3. 自动匹配答题 ----------
    await s.eval('(function(){document.querySelectorAll(".diffbtn")[0].click();var go=[].slice.call(document.querySelectorAll("#curOverlay .btn")).filter(function(x){return /开始出题/.test(x.textContent)})[0];if(go)go.click();return 1;})()');
    await s.wait(450);
    const q = JSON.parse(await s.eval('JSON.stringify({stage:!document.getElementById("stage").hidden, opts:document.querySelectorAll(".obtn").length, q:(document.querySelector(".qbox")||{}).textContent||"", hud:(document.querySelector(".hud")||{}).textContent||""})'));
    ck('进入答题页', q.stage === true);
    ck('选择题有选项', q.opts >= 2, 'opts=' + q.opts);
    ck('题干非空', (q.q || '').length > 0, (q.q || '').slice(0, 36));
    ck('HUD 显示实力档', /实力/.test(q.hud || ''), q.hud.slice(0, 50));

    // ---------- 4. 答一题 ----------
    await s.eval('document.querySelectorAll(".obtn")[0].click()');
    await s.wait(350);
    const fb = JSON.parse(await s.eval('JSON.stringify({fb:(document.querySelector(".fb")||{}).textContent||"", disabled:(document.querySelector(".obtn")||{}).disabled})'));
    ck('答题后有反馈', /正确|答对/.test(fb.fb), fb.fb.slice(0, 40));
    ck('答题后选项锁定', fb.disabled === true);

    // ---------- 5. 「不会」 ----------
    // 答完一题后反馈条要停留（答对 0.8s / 答错 2.5s 供读解析），这里用「下一题 ›」直接跳过
    await s.eval('(function(){var b=document.querySelector("#fbzone .fb .fbnext");if(b)b.click();return 1;})()');
    await s.wait(500);
    const hasUnk = await s.eval(clickText('button', '不会'));
    ck('存在并可点「😵 不会」', hasUnk === true);
    await s.wait(300);
    const weakN = await s.eval('(function(){try{return (JSON.parse(localStorage.getItem("bt_qa_weak")||"[]")||[]).length;}catch(e){return -1;}})()');
    ck('不会的题写入薄弱库', weakN >= 1, 'weak=' + weakN);

    // ---------- 6. 答完 → 结算 ----------
    await s.eval(clickText('button', '结束并结算'));
    await s.wait(500);
    const done1 = await s.eval('!!document.querySelector(".lvlcard")');
    ck('无限模式随时结束并结算（显示实力评级卡）', done1 === true);

    // ---------- 7. 再来一局（自动匹配重放） ----------
    await s.eval(clickText('button', '再来一局'));
    await s.wait(600);
    const rp = JSON.parse(await s.eval('JSON.stringify({hud:(document.querySelector(".hud")||{}).textContent||"", opts:document.querySelectorAll(".obtn").length})'));
    ck('再来一局仍是自动匹配且正常出题', /实力/.test(rp.hud) && rp.opts >= 2, rp.hud.slice(0, 46));

    // 回书架
    await s.eval(clickText('button', '结束并结算'));
    await s.wait(400);
    await s.eval(clickText('button', '返回书架'));
    await s.wait(300);

    // ---------- 8. 编程知识面检测 ----------
    await s.eval(clickText('.book', '编程'));
    await s.wait(300);
    const cq = JSON.parse(await s.eval('JSON.stringify({ov:!!document.getElementById("curOverlay"), tags:document.querySelectorAll(".tagbtn").length})'));
    ck('编程首次进入弹知识面问卷', cq.ov === true && cq.tags >= 5, 'langs=' + cq.tags);
    await s.eval(clickText('#curOverlay .btn', '跳过'));
    await s.wait(300);
    await s.eval(clickText('.secbtn', '选择题'));
    await s.wait(300);
    const cd = JSON.parse(await s.eval('JSON.stringify({diff:document.querySelectorAll(".diffbtn").length})'));
    ck('跳过后进难度面板（5 档 + 自动 = 6）', cd.diff === 6, 'diffbtns=' + cd.diff);
    await s.eval('(function(){var b=document.querySelector("#curOverlay .close");if(b)b.click();return 1;})()');
    await s.wait(200);
    await s.eval(clickText('.book', '编程'));
    await s.wait(300);
    await s.eval(clickText('.secbtn', '选择题'));
    await s.wait(300);
    const c2 = JSON.parse(await s.eval('JSON.stringify({tags:document.querySelectorAll(".tagbtn").length, diff:document.querySelectorAll(".diffbtn").length})'));
    ck('二次进入编程不再弹问卷', c2.tags === 0 && c2.diff === 6, JSON.stringify(c2));
    await s.eval('(function(){var b=document.querySelector("#curOverlay .close");if(b)b.click();return 1;})()');

    // ---------- 9. 音乐 ----------
    await s.eval('document.getElementById("musicBtn").click()');
    await s.wait(350);
    const m = JSON.parse(await s.eval('JSON.stringify({ov:!!document.getElementById("curOverlay"), name:(document.getElementById("mpName")||{}).textContent||"", play:!!document.getElementById("mpPlay")})'));
    ck('音乐面板打开', m.ov === true);
    ck('有曲名 + 播放键', (m.name || '').length > 0 && m.play === true, m.name);
    await s.eval('document.getElementById("mpPlay").click()');
    await s.wait(500);
    const m2 = JSON.parse(await s.eval('JSON.stringify({play:(document.getElementById("mpPlay")||{}).textContent||""})'));
    ck('内置轻音乐可播放（按钮变 ⏸）', /⏸/.test(m2.play), 'btn=' + m2.play);
    await s.eval('(function(){var b=document.getElementById("mpPlay");if(b)b.click();var c=document.querySelector("#curOverlay .close");if(c)c.click();return 1;})()');

    // ---------- 10. 设置 ----------
    await s.eval('document.getElementById("settingsBtn").click()');
    await s.wait(300);
    const st = JSON.parse(await s.eval('JSON.stringify({ovs:document.querySelectorAll("#curOverlay").length, inputs:[].slice.call(document.querySelectorAll("#curOverlay input")).filter(function(i){return i.type!=="checkbox";}).map(function(i){return i.placeholder;}), labels:[].slice.call(document.querySelectorAll("#curOverlay .flabel")).map(function(e){return e.textContent;}), all:((document.getElementById("curOverlay")||{}).textContent||"")})'));
    ck('设置面板打开且仅一个浮层', st.ovs === 1, 'ovs=' + st.ovs);
    ck('设置含 API 地址/Key/模型/代理 四项', st.inputs.length === 4 && /API 地址/.test(st.labels.join('|')) && /API Key/.test(st.labels.join('|')) && /模型/.test(st.labels.join('|')) && /代理/.test(st.labels.join('|')), st.inputs.join(' | ') + ' || ' + st.labels.join(' | '));
    ck('设置含「⏩ 答对 1 秒后自动跳（关闭后可慢慢看解析）」开关', /答题设置/.test(st.all) && /1 秒后自动跳/.test(st.all), '');
    await s.eval('(function(){var c=document.querySelector("#curOverlay .close");if(c)c.click();return 1;})()');

    // ---------- 11. 统计 ----------
    await s.eval('document.getElementById("statsBtn").click()');
    await s.wait(300);
    const sta = JSON.parse(await s.eval('JSON.stringify({ov:!!document.getElementById("curOverlay"), txt:((document.getElementById("curOverlay")||{}).textContent||"").slice(0,120)})'));
    ck('统计面板打开', sta.ov === true, sta.txt.slice(0, 46));
    await s.eval('(function(){var c=document.querySelector("#curOverlay .close");if(c)c.click();return 1;})()');

    // ---------- 12. 布局 ----------
    const L = JSON.parse(await s.eval('JSON.stringify({sw:document.documentElement.scrollWidth, cw:document.documentElement.clientWidth})'));
    ck('无横向溢出', L.sw <= L.cw + 1, JSON.stringify(L));

    // ---------- 13. JS 异常 ----------
    ck('无 JS 异常', s.errors.length === 0, s.errors.join(' | ').slice(0, 400));
  } catch (e) {
    fail.push('EXCEPTION :: ' + e.message);
  }
  await s.close();
  console.log('=== 冒烟结果：' + pass.length + '/' + (pass.length + fail.length) + ' 通过 ===');
  if (fail.length) { console.log('--- 失败 ---'); fail.forEach((f) => console.log('  ✗ ' + f)); }
  pass.forEach((p) => console.log('  ✓ ' + p));
  process.exit(fail.length ? 1 : 0);
})();
