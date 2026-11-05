/* 批次 C1：答对也显示解析/来源 + 默认不自动跳 + 设置「答对自动跳题（快速模式）」
   A. 默认（未开快速模式）：答对 → 有解析(+来源) + 「下一题」，1.2s 不自动跳
   B. 点「下一题」才前进
   C. 答错仍停住（不自动跳），给「下一题」
   D. 设置面板有「⏩ 答对自动跳题（快速模式）」，默认关闭；打开后写入 bt_qa_quickjump=true
   E. 打开快速模式后：答对约 800ms 自动跳到下一题
   F. 收尾：无 JS 异常、无横向溢出 */
const { spawn } = require('child_process');
const path = require('path');
const { Session, sleep } = require('./cdp.cjs');

const PORT = 8861;
const APP = process.argv[2] || ('http://127.0.0.1:' + PORT + '/quiz/');
const USE_LOCAL = !process.argv[2];
const pass = [], fail = [];
function ck(n, c, e) { (c ? pass : fail).push(n + (e ? ' :: ' + e : '')); }

(async () => {
  const srv = USE_LOCAL ? spawn(process.execPath, [path.join(__dirname, 'serve.cjs'), String(PORT)], { stdio: 'ignore' }) : null;
  if (USE_LOCAL) await sleep(700);
  const s = new Session({ width: 414, height: 896, port: 9361 });
  let LAST = '';
  try {
    await s.open(APP);
    await s.waitFor('!!document.querySelector(".book")', 15000);
    await s.eval("(function(){try{return navigator.serviceWorker.getRegistrations().then(function(rs){return Promise.all(rs.map(function(r){return r.unregister();}));});}catch(e){return 1;}})()");
    /* 默认口径：清空后只设 profile，不设 quickjump */
    await s.eval("localStorage.clear();localStorage.setItem('bt_qa_profile_code', JSON.stringify({done:true,skipped:true,langs:[],level:0,rank:0}));1");
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);
    await s.eval("window.confirm=function(){return true;};window.alert=function(){};1");
    const _ev = s.eval.bind(s);
    s.eval = function (x) { LAST = String(x).slice(0, 110); return _ev(x); };

    const hasSel = (sel) => s.eval('!!document.querySelector(' + JSON.stringify(sel) + ')');
    const clickSel = (sel) => s.eval("(function(){var e=document.querySelector(" + JSON.stringify(sel) + ");if(e){e.click();return 1;}return 0;})()");
    const clickBook = (name) => s.eval("(function(){var bs=document.querySelectorAll('.book');for(var i=0;i<bs.length;i++){if(bs[i].textContent.indexOf(" + JSON.stringify(name) + ")>=0){bs[i].click();return 1;}}return 0;})()");
    const pickSec = (kw) => s.eval("(function(){var bs=[].slice.call(document.querySelectorAll('.secbtn'));for(var i=0;i<bs.length;i++){if(bs[i].textContent.indexOf(" + JSON.stringify(kw) + ")>=0){bs[i].click();return 1;}}return 0;})()");
    const startDiff = (idx) => s.eval("(function(){var bs=document.querySelectorAll('.diffbtn');if(!bs.length)return 0;bs[" + idx + "].click();var go=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return /开始出题/.test(x.textContent)})[0];if(!go)return 0;go.click();return 1;})()");
    const toShelf = async () => {
      for (let i = 0; i < 6; i++) {
        if (await hasSel('.book')) return true;
        if (await hasSel('#curOverlay')) { await clickSel('#curOverlay .close'); await sleep(300); continue; }
        await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /退出本局|结束并结算/.test(x.textContent)})[0];if(b)b.click();return 1;})()");
        await sleep(500);
      }
      const r = await hasSel('.book');
      if (!r) await s.eval("history.back();1");
      await sleep(500);
      return await hasSel('.book');
    };
    const openCat = async (name, secKw, diffIdx) => {
      await toShelf();
      await clickBook(name);
      await s.waitFor('!!document.querySelector(".secbtn")||!!document.querySelector(".diffbtn")', 8000);
      if (await hasSel('.secbtn')) { await pickSec(secKw); await s.waitFor('!!document.querySelector(".diffbtn")', 8000); }
      await startDiff(diffIdx);
      return await s.waitFor("document.querySelectorAll('#stage .obtn').length>=2", 10000);
    };
    const qidx = () => s.eval('qidx');
    const score = () => s.eval('score');
    const curAns = () => s.eval("(function(){var q=qlist[qidx];return q?String(q.a==null?'':q.a):'';})()");
    const curSrc = () => s.eval("(function(){var q=qlist[qidx];return q?String(q.src||''):'';})()");
    const fbText = () => s.eval("(function(){var f=document.querySelector('#fbzone .fb');return f?f.textContent:'';})()");
    const clickAns = (want) => s.eval("(function(){var want=" + (want ? 1 : 0) + ";var q=qlist[qidx];var bs=[].slice.call(document.querySelectorAll('#stage .obtn'));if(bs.length){for(var i=0;i<bs.length;i++){var t=bs[i].textContent.trim();if(want?(t===String(q.a)):(t!==String(q.a))){bs[i].click();return 1;}}return 0;}var inp=document.querySelector('#stage input[type=text]');if(inp){inp.value=want?String(q.a):'__绝不可能答对__';var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /^提交$/.test(x.textContent.trim())})[0];if(b){b.click();return 2;}}return -1;})()");
    const hitNext = () => clickSel('#fbzone .fb .fbnext');

    /* ================= A. 默认：答对 → 解析/来源 + 下一题，不自动跳 ================= */
    ck('进入数学·选择题', await openCat('数学', '选择题', 2), '');
    const q0 = await qidx(), s0 = await score(), src0 = await curSrc();
    await clickAns(true);
    await sleep(350);
    const t1 = await fbText();
    ck('答对 → 反馈条是 ok 态', await hasSel('#fbzone .fb.ok'), '');
    ck('答对 → 显示「💡 解析：」', /💡 解析：/.test(t1), JSON.stringify(t1.slice(0, 50)));
    ck('答对 → 来源行与题目 src 一致', src0 ? /📚 来源：/.test(t1) : true, 'src=' + JSON.stringify(src0.slice(0, 20)));
    ck('答对 → 给「下一题 ›」', await hasSel('#fbzone .fb .fbnext'), '');
    ck('答对 → 只加 10 分', (await score()) === s0 + 10, s0 + '→' + await score());
    await sleep(1200);
    ck('默认不自动跳（1.2s 仍在本題）', (await qidx()) === q0, 'qidx=' + await qidx());

    /* ================= B. 点「下一题」才前进 ================= */
    await hitNext();
    await sleep(220);
    ck('点「下一题」才进入下一题', (await qidx()) === q0 + 1, 'qidx=' + await qidx());

    /* ================= C. 答错仍停住 ================= */
    await clickAns(false);
    await sleep(320);
    ck('答错 → 显示正确答案', /正确答案：/.test(await fbText()), JSON.stringify((await fbText()).slice(0, 40)));
    ck('答错 → 给「下一题 ›」', await hasSel('#fbzone .fb .fbnext'), '');
    const qw = await qidx();
    await sleep(1200);
    ck('答错 → 1.2s 仍停在本題', (await qidx()) === qw, 'qidx=' + await qidx());

    /* ================= D. 设置开关：存在 + 默认关 + 可开启 ================= */
    await toShelf();
    await clickSel('#settingsBtn');
    await s.waitFor("!!document.getElementById('curOverlay')", 8000);
    const hasTxt = await s.eval("(function(){return /答对自动跳题（快速模式）/.test(document.getElementById('curOverlay').textContent);})()");
    ck('设置面板有「答对自动跳题（快速模式）」', hasTxt, '');
    const chk0 = await s.eval("(function(){var o=document.getElementById('curOverlay');var ls=o.querySelectorAll('label');for(var i=0;i<ls.length;i++){if(/答对自动跳题/.test(ls[i].textContent)){var c=ls[i].querySelector('input');return c?c.checked:null;}}return null;})()");
    ck('开关默认关闭', chk0 === false, 'checked=' + chk0);
    await s.eval("(function(){var o=document.getElementById('curOverlay');var ls=o.querySelectorAll('label');for(var i=0;i<ls.length;i++){if(/答对自动跳题/.test(ls[i].textContent)){var c=ls[i].querySelector('input');c.checked=true;if(c.onchange)c.onchange();return 1;}}return 0;})()");
    const qj = await s.eval("localStorage.getItem('bt_qa_quickjump')");
    ck('打开开关 → bt_qa_quickjump=true', qj === 'true', 'qj=' + qj);
    await clickSel('#curOverlay .close');
    await sleep(300);

    /* ================= E. 快速模式：答对约 800ms 自动跳 ================= */
    ck('快速模式：重新进入数学题', await openCat('数学', '选择题', 2), '');
    const qk = await qidx(), sk = await score();
    await clickAns(true);
    await sleep(300);
    ck('快速模式：答对仍显示解析', /💡 解析：/.test(await fbText()), JSON.stringify((await fbText()).slice(0, 40)));
    ck('快速模式：答对加分正常', (await score()) === sk + 10, sk + '→' + await score());
    await sleep(900);
    ck('快速模式：答对约 800ms 自动跳到下一题', (await qidx()) === qk + 1, 'qidx=' + await qidx());

    /* ================= F. 收尾 ================= */
    ck('全程无 JS 异常', s.errors.length === 0, s.errors.slice(0, 2).join(' | '));
    const ovf = await s.eval('document.documentElement.scrollWidth - document.documentElement.clientWidth');
    ck('无横向溢出', ovf <= 0, 'overflow=' + ovf);
  } catch (e) {
    fail.push('探针异常 :: ' + e.message + ' | 最后表达式: ' + LAST);
  } finally {
    console.log('\n=== 答对解析/来源 + 自动跳开关（批次 C1）：' + pass.length + '/' + (pass.length + fail.length) + ' 通过 ===');
    pass.forEach(t => console.log('  ✓ ' + t));
    fail.forEach(t => console.log('  ✗ ' + t));
    await s.close();
    try { srv && srv.kill('SIGKILL'); } catch (e) {}
  }
})().catch(e => { console.error(e); process.exit(1); });
