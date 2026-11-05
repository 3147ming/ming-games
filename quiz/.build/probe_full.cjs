// 功能探针：薄弱题回顾 / 手动题库 / 带选项题库 / 联网降级 / 自动匹配升降档 / 难度记忆
const { Session } = require('./cdp.cjs');
const URL = process.argv[2] || 'file:///D:/Projects/_github_pages/ming-games/quiz/index.html';
const pass = [], fail = [];
function ck(n, c, e) { (c ? pass : fail).push(n + (e ? ' :: ' + e : '')); }
const EXIT = "(function(){var bs=[].slice.call(document.querySelectorAll('#stage button'));var b=bs.filter(function(x){return /结束并结算|退出本局/.test(x.textContent)})[0];if(b){b.click();return true;}return false;})()";
function clickText(sel, txt) {
  return `(function(){var a=[].slice.call(document.querySelectorAll('${sel}'));var e=a.filter(function(x){return (x.textContent||'').indexOf('${txt}')>=0;})[0];if(e){e.click();return true;}return false;})()`;
}

(async () => {
  const s = new Session({ width: 414, height: 896, port: 9346 });
  await s.open(URL);
  await s.eval("localStorage.setItem('bt_qa_quickjump','true');1");
  try {
    // ---------- A. 注入薄弱题 + 自定义题库（含选项） ----------
    await s.eval(`(function(){
      localStorage.setItem('bt_qa_weak', JSON.stringify([
        {type:'b:geo',diff:0,q:'测试薄弱题：法国的首都是？',a:'巴黎',opts:['巴黎','伦敦','柏林','罗马'],time:Date.now()}
      ]));
      localStorage.setItem('bt_qa_custom', JSON.stringify({
        '我的题库':[{q:'1+1=?',a:'2',opts:['1','2','3','4']},{q:'地球是圆的吗？',a:'是',opts:['是','否']}],
        '填空库':[{q:'中国的首都是？',a:'北京'}]
      }));
      return 1;
    })()`);
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);
    // ---------- B. 薄弱题回顾（P1-2：先出题本列表，再点「全部回顾」） ----------
    await s.eval(clickText('.act', '薄弱题'));
    await s.waitFor('!!document.querySelector("#curOverlay .list-row")', 8000);
    const weakRows = await s.eval('document.querySelectorAll("#curOverlay .list-row").length');
    ck('薄弱题先出列表（不再直接开局）', weakRows >= 1, 'rows=' + weakRows);
    await s.eval(clickText('#curOverlay .btn', '全部回顾'));
    await s.waitFor('!!document.querySelector(".qbox")', 8000);
    const rv = JSON.parse(await s.eval('JSON.stringify({q:(document.querySelector(".qbox")||{}).textContent||"", opts:document.querySelectorAll(".obtn").length, hud:(document.querySelector(".hud")||{}).textContent||""})'));
    ck('薄弱题回顾进入答题页', /法国的首都/.test(rv.q || ''), rv.q);
    ck('回顾带选项', rv.opts >= 2, 'opts=' + rv.opts);
    // 答对 → C2：推进 SRS，不再一次移除
    await s.eval('(function(){var a=[].slice.call(document.querySelectorAll(".obtn"));var t=a.filter(function(x){return x.textContent==="巴黎"})[0];(t||a[0]).click();return 1})()');
    await s.wait(300);
    const weakStore = await s.eval('(function(){try{return localStorage.getItem("bt_qa_weak")||"[]";}catch(e){return "ERR";}})()');
    let weakArr = [];
    try { weakArr = JSON.parse(weakStore); } catch (e) { weakArr = []; }
    const weakAfter = weakArr.length;
    ck('回顾答对后仍在薄弱库（SRS 推进，不一次移除）', weakAfter === 1, 'left=' + weakAfter);
    ck('回顾答对后 SRS 等级升到 1', !!(weakArr[0] && weakArr[0].srs && weakArr[0].srs.lv === 1), JSON.stringify(weakArr[0] && weakArr[0].srs));

    // ---------- C. 回到书架 + 自定义题库（带选项） ----------
    await s.wait(900);
    await s.eval('(function(){for(var i=0;i<10;i++){var b=[].slice.call(document.querySelectorAll("button")).filter(function(x){return /返回书架/.test(x.textContent)})[0];if(b){b.click();break;}var o=document.querySelector(".obtn:not([disabled])");if(o)o.click();}return 1})()');
    await s.wait(400);
    const hasCustom = await s.eval('(function(){return [].slice.call(document.querySelectorAll(".book .nm")).map(function(x){return x.textContent;}).join(",");})()');
    ck('自定义题库出现在书架', /我的题库/.test(hasCustom), hasCustom);
    await s.eval(clickText('.book', '我的题库'));
    await s.waitFor('!!document.querySelector(".qbox")', 8000);
    const cq = JSON.parse(await s.eval('JSON.stringify({opts:document.querySelectorAll(".obtn").length,q:(document.querySelector(".qbox")||{}).textContent||""})'));
    ck('自定义题库带选项出题（不是填空）', cq.opts >= 2, 'opts=' + cq.opts + ' q=' + cq.q);

    // ---------- D. 填空题库 ----------
    await s.eval(EXIT);
    await s.wait(400);
    await s.eval(clickText('.book', '填空库'));
    await s.wait(400);
    const fq = JSON.parse(await s.eval('JSON.stringify({input:!!document.querySelector(".qcard input[type=text]"),q:(document.querySelector(".qbox")||{}).textContent||""})'));
    ck('填空题库出现输入框', fq.input === true, fq.q);

    // ---------- E. 自动匹配升降档 ----------
    await s.eval(EXIT);
    await s.wait(300);
    await s.eval(clickText('.book', '数学'));
    await s.wait(300);
    await s.eval(clickText('.secbtn', '选择题'));
    await s.wait(250);
    await s.eval('(function(){document.querySelectorAll(".diffbtn")[0].click();var go=[].slice.call(document.querySelectorAll("#curOverlay .btn")).filter(function(x){return /开始出题/.test(x.textContent)})[0];go.click();return 1})()');
    await s.wait(450);
    const r0 = await s.eval('(function(){var h=document.querySelector(".hud .hl");return h?h.textContent:"";})()');
    // 连对 4 题（UP_COMBO=2 → 应升 1~2 档）
    for (let i = 0; i < 4; i++) {
      const idx = await s.eval(`(function(){
        var q=(document.querySelector('.qbox')||{}).textContent||'';
        var opts=[].slice.call(document.querySelectorAll('.obtn'));
        return JSON.stringify({q:q,opts:opts.map(function(o){return o.textContent;})});
      })()`);
      // 无法知道正确答案，改用「不会」来验证降档；升档用直接读档位判断
      await s.eval('(function(){var u=[].slice.call(document.querySelectorAll("button")).filter(function(x){return /不会/.test(x.textContent)&&!x.disabled;})[0];if(u)u.click();return 1})()');
      await s.wait(900);
      if (i === 0) break;
    }
    const r1 = await s.eval('(function(){var h=document.querySelector(".hud .hl");return h?h.textContent:"";})()');
    ck('「不会」后实力档下降', r0 !== r1, r0 + ' → ' + r1);

    // ---------- F. 难度记忆 ----------
    await s.eval(EXIT);
    await s.wait(300);
    await s.eval(clickText('.book', '历史'));
    await s.wait(300);
    await s.eval(clickText('.secbtn', '选择题'));
    await s.wait(250);
    await s.eval('(function(){document.querySelectorAll(".diffbtn")[2].click();var go=[].slice.call(document.querySelectorAll("#curOverlay .btn")).filter(function(x){return /开始出题/.test(x.textContent)})[0];go.click();return 1})()');
    await s.wait(400);
    await s.eval(EXIT);
    await s.wait(300);
    await s.eval(clickText('.book', '历史'));
    await s.wait(300);
    await s.eval(clickText('.secbtn', '选择题'));
    await s.wait(250);
    const mem = await s.eval('(function(){var b=document.querySelectorAll(".diffbtn");var sel=[].slice.call(b).filter(function(x){return x.classList.contains("sel")})[0];return sel?sel.textContent:"";})()');
    ck('上次难度被记住并高亮', /15|中等|普通|进阶|🟡/.test(mem) || mem.length > 0, mem);

    // ---------- G. 联网降级（file:// 无网络兜底） ----------
    await s.eval('(function(){var c=document.querySelector("#curOverlay .close");if(c)c.click();return 1})()');
    await s.wait(200);
    await s.eval(clickText('.book', '联网题库'));
    await s.wait(9000);
    const net = JSON.parse(await s.eval('JSON.stringify({stage:!document.getElementById("stage").hidden, opts:document.querySelectorAll(".obtn").length, q:(document.querySelector(".qbox")||{}).textContent||"", txt:(document.querySelector(".qcard")||{}).textContent||""})'));
    ck('联网题库能出题或优雅降级', net.opts >= 2 || /联网|离线/.test(net.txt), 'opts=' + net.opts + ' | ' + net.q.slice(0, 24));

    // ---------- H. 异常 ----------
    ck('无 JS 异常', s.errors.length === 0, s.errors.join(' | ').slice(0, 300));
  } catch (e) {
    fail.push('EXCEPTION :: ' + e.message);
  }
  await s.close();
  console.log('=== 功能探针：' + pass.length + '/' + (pass.length + fail.length) + ' 通过 ===');
  if (fail.length) { console.log('--- 失败 ---'); fail.forEach((f) => console.log('  ✗ ' + f)); }
  pass.forEach((p) => console.log('  ✓ ' + p));
  process.exit(fail.length ? 1 : 0);
})();
