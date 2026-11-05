// 增量二批 C1：答对 1 秒自动跳（默认开）+ 草稿板暂停计时 + 4.0.1-2 自动模式结算分母
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
  const s = new Session({ width: 414, height: 896, port: 9385 });
  const txt = (sel) => s.eval("(function(){var e=document.querySelector('" + sel + "');return e?e.textContent:'';})()");
  const clickText = (sel, t) => s.eval("(function(){var b=[].slice.call(document.querySelectorAll('" + sel + "')).filter(function(x){return x.textContent.indexOf('" + t + "')>=0;})[0];if(!b)return 0;b.click();return 1;})()");
  const qidx = () => s.eval('qidx');
  /* 点正确答案（选项文字 === qlist[qidx].a） */
  const answerRight = () => s.eval("(function(){var Q=qlist[qidx];if(!Q||Q.a==null)return 'no-q';var t=String(Q.a);var bs=[].slice.call(document.querySelectorAll('#stage .obtn'));for(var i=0;i<bs.length;i++){if(bs[i].textContent===t){bs[i].click();return 'ok';}}return 'no-opt:'+t;})()");
  const answerWrong = () => s.eval("(function(){var Q=qlist[qidx];if(!Q||Q.a==null)return 'no-q';var t=String(Q.a);var bs=[].slice.call(document.querySelectorAll('#stage .obtn'));for(var i=0;i<bs.length;i++){if(bs[i].textContent!==t){bs[i].click();return 'ok';}}return 'no-opt';})()");
  const clickNext = () => s.eval("(function(){var b=document.querySelector('#fbzone .fb .fbnext');if(!b)return 'no-next';b.click();return 'clicked';})()");
  const startAutoMath = async () => {
    await clickText('#shelf .book', '数学');
    await s.waitFor('!!document.querySelector("#curOverlay .secbtn")', 9000);
    await clickText('#curOverlay .secbtn', '选择题');
    await s.waitFor('!document.querySelector("#curOverlay .secbtn")', 6000);
    await s.waitFor('!!document.querySelector("#curOverlay .diffbtn")', 9000);
    await s.eval("(function(){var b=document.querySelectorAll('#curOverlay .diffbtn')[0];if(b)b.click();return 1;})()");
    await clickText('#curOverlay .btn', '开始出题');
    await s.waitFor('!!document.querySelector("#stage .obtn")', 12000);
  };

  try {
    await s.open(APP);
    await s.ensureLoaded();
    await s.eval("(function(){['bt_qa_quickjump','bt_qa_weak','bt_qa_stats','bt_qa_best','bt_qa_daily','bt_qa_extra','bt_qa_rank_math','bt_qa_rank_code','bt_qa_learn_before','bt_qa_autorefill'].forEach(function(k){localStorage.removeItem(k);});return 1;})()");
    await s.reload();
    await s.ensureLoaded();
    await s.waitFor('!!document.querySelector(".book")', 15000);

    /* ---------- A. 设置默认开 ---------- */
    await s.eval("document.getElementById('settingsBtn').click()");
    await s.waitFor("!!document.querySelector('#curOverlay .close')", 8000);
    const qj = await s.eval("(function(){var ls=[].slice.call(document.querySelectorAll('#curOverlay label'));for(var i=0;i<ls.length;i++){if(ls[i].textContent.indexOf('自动跳')>=0){var c=ls[i].querySelector('input');return JSON.stringify({ck:!!(c&&c.checked),tx:ls[i].textContent});}}return 'no-label';})()");
    let qjObj = { ck: null, tx: '' }; try { qjObj = JSON.parse(qj); } catch (e) {}
    ck('设置里「答对自动跳」默认勾选（需求变更：默认开）', qjObj.ck === true, qj);
    ck('开关文案写明 1 秒后可看解析', /1 秒后自动跳/.test(qjObj.tx) && /看解析/.test(qjObj.tx), qjObj.tx);
    await s.eval("(function(){var b=document.querySelector('#curOverlay .close');if(b)b.click();return 1;})()");
    await s.waitFor('!document.querySelector("#curOverlay .close")', 6000);

    /* ---------- B. 答对 1 秒自动跳 ---------- */
    await startAutoMath();
    const b0 = await qidx();
    ck('自动匹配开局在无限模式', /无限模式/.test(await s.eval("(function(){var e=document.querySelector('#stage .hr');return e?e.textContent:'';})()")));
    const br = await answerRight();
    const bFb = await txt('#stage .fb');
    ck('答对反馈条仍带「下一题」', /下一题/.test(bFb), bFb.replace(/\s+/g, ' ').slice(0, 60));
    await sleep(1600);
    const b1 = await qidx();
    ck('答对后 ~1 秒自动进下一题（不点下一题）', b0 === 0 && b1 === 1, 'r=' + br + ' qidx ' + b0 + '→' + b1);

    /* ---------- C. 1 秒内点「下一题」立即跳且只跳一次 ---------- */
    const c0 = await qidx();
    await answerRight();
    const cclick = await clickNext();
    await sleep(260);
    const c1 = await qidx();
    await sleep(1500);
    const c2 = await qidx();
    ck('1 秒内点「下一题」立即跳（只 +1）', cclick === 'clicked' && c1 === c0 + 1, 'click=' + cclick + ' ' + c0 + '→' + c1);
    ck('随后计时器不会再补跳一次', c2 === c1, c1 + '→' + c2);

    /* ---------- D. 关掉设置后答对停住 ---------- */
    await s.eval("localStorage.setItem('bt_qa_quickjump','false');1");
    const d0 = await qidx();
    await answerRight();
    await sleep(1800);
    const d1 = await qidx();
    ck('关闭开关后答对停住不跳', d1 === d0, d0 + '→' + d1);
    ck('停住时反馈条给解析与「下一题」', /💡 解析：|💡 AI 解析/.test(await txt('#stage .fb')) && /下一题/.test(await txt('#stage .fb')));
    await clickNext();
    await sleep(320);
    ck('手动点「下一题」能继续', (await qidx()) === d0 + 1);

    /* ---------- E. 答错不跳（开关打开也不跳） ---------- */
    await s.eval("localStorage.setItem('bt_qa_quickjump','true');1");
    const e0 = await qidx();
    const er = await answerWrong();
    await sleep(1700);
    const e1 = await qidx();
    ck('答错停住不自动跳', er === 'ok' && e1 === e0, 'r=' + er + ' ' + e0 + '→' + e1);

    /* ---------- F. 草稿板：打开暂停计时，收起重新计时 ---------- */
    await clickNext();
    await sleep(320);
    await s.waitFor("!!document.querySelector('#stage .scratchchip')", 8000);
    const f0 = await qidx();
    await answerRight();
    const fOpen = await s.eval("(function(){var b=document.querySelector('#stage .scratchchip');if(!b)return 'no-chip';b.click();return 'clicked';})()");
    await sleep(1600);
    const f1 = await qidx();
    const fVisible = await s.eval("(function(){var e=document.getElementById('scratchPad');return !!(e&&e.style.display!=='none');})()");
    ck('草稿板打开期间不被自动跳打断', fOpen === 'clicked' && fVisible === true && f1 === f0, 'open=' + fOpen + ' vis=' + fVisible + ' ' + f0 + '→' + f1);
    const fClose = await s.eval("(function(){var bs=[].slice.call(document.querySelectorAll('#scratchPad .spbtn'));for(var i=0;i<bs.length;i++){if(/收起/.test(bs[i].textContent)){bs[i].click();return 'clicked';}}return 'no-btn';})()");
    await sleep(1500);
    const f2 = await qidx();
    ck('收起草稿板后重新计时并跳到下一题', fClose === 'clicked' && f2 === f0 + 1, 'close=' + fClose + ' ' + f1 + '→' + f2);

    /* ---------- G. 4.0.1-2 自动模式结算分母 ---------- */
    /* 先收尾当前这一局（B~F 都算在同一局里），再用「再来一局」开一局干净的重置 */
    await clickText('#stage .quizfoot .btn', '结束并结算');
    await s.waitFor("document.querySelector('#stage').textContent.indexOf('正确率')>=0", 9000);
    await s.eval("(function(){var bs=[].slice.call(document.querySelectorAll('#stage .btn'));for(var i=0;i<bs.length;i++){if(/再来一局/.test(bs[i].textContent)){bs[i].click();return 1;}}return 0;})()");
    await s.waitFor('!!document.querySelector("#stage .obtn")', 12000);
    await answerRight();
    await sleep(1500);                    // 让自动跳走到下一题（未作答的那题不该进分母）
    await clickText('#stage .quizfoot .btn', '结束并结算');
    await s.waitFor("document.querySelector('#stage').textContent.indexOf('正确率')>=0", 9000);
    const gTxt = await txt('#stage');
    ck('答 1 题对就结束 → 分母是 1（1 / 1）', /（1 \/ 1）/.test(gTxt), gTxt.replace(/\s+/g, ' ').slice(0, 90));
    ck('不出现 n/0 或 2/1 这类错分母', !/（\d+ \/ 0）/.test(gTxt) && !/（1 \/ 2）/.test(gTxt));

    await s.eval("(function(){var bs=[].slice.call(document.querySelectorAll('#stage .btn'));for(var i=0;i<bs.length;i++){if(/再来一局/.test(bs[i].textContent)){bs[i].click();return 1;}}return 0;})()");
    await s.waitFor('!!document.querySelector("#stage .obtn")', 12000);
    await answerRight(); await sleep(1500);
    await answerRight(); await sleep(1500);
    await clickText('#stage .quizfoot .btn', '结束并结算');
    await s.waitFor("document.querySelector('#stage').textContent.indexOf('正确率')>=0", 9000);
    const g2Txt = await txt('#stage');
    ck('答 2 题对结束 → 100%（2 / 2）', /（2 \/ 2）/.test(g2Txt) && /正确率 100%/.test(g2Txt), g2Txt.replace(/\s+/g, ' ').slice(0, 90));

    ck('运行期无 JS 异常', s.errors.length === 0, s.errors.slice(0, 2).join(' | '));
  } catch (e) {
    fail.push('运行异常 :: ' + (e && e.message));
  } finally {
    try { await s.close(); } catch (e) {}
    if (srv) srv.kill();
  }
  console.log('=== C1 二批自动跳与结算分母：' + pass.length + '/' + (pass.length + fail.length) + ' 通过 ===');
  pass.forEach(p => console.log('  ✓ ' + p));
  fail.forEach(f => console.log('  ✗ ' + f));
  process.exit(fail.length ? 1 : 0);
})();
