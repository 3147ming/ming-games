/* 批次 B：草稿板专项探针
   A. 数学题显示「📝 草稿」；常识/英语类不显示
   B. 科学题：chip 出现与否 === 题干命中计算关键词
   C. 打开草稿板 → canvas 可见；手写后像素有墨迹
   D. 清空 → 画布归零
   E. 收起再开同一题 → 草稿还在（toDataURL 还原）
   F. 切到下一题 → 新题草稿为空（按题隔离，不串题）
   G. 退出本局再开新局 → 草稿不残留（Map 清空）
   H. 草稿不影响答题/判分（画完收起仍能正常答错记薄弱）
   I. 收尾：无 JS 异常、无横向溢出 */
const { spawn } = require('child_process');
const path = require('path');
const { Session, sleep } = require('./cdp.cjs');

const PORT = 8860;
const APP = process.argv[2] || ('http://127.0.0.1:' + PORT + '/quiz/');
const USE_LOCAL = !process.argv[2];
const pass = [], fail = [];
function ck(n, c, e) { (c ? pass : fail).push(n + (e ? ' :: ' + e : '')); }

(async () => {
  const srv = USE_LOCAL ? spawn(process.execPath, [path.join(__dirname, 'serve.cjs'), String(PORT)], { stdio: 'ignore' }) : null;
  if (USE_LOCAL) await sleep(700);
  const s = new Session({ width: 414, height: 896, port: 9360 });
  let LAST = '';
  try {
    await s.open(APP);
    await s.waitFor('!!document.querySelector(".book")', 15000);
    await s.eval("(function(){try{return navigator.serviceWorker.getRegistrations().then(function(rs){return Promise.all(rs.map(function(r){return r.unregister();}));});}catch(e){return 1;}})()");
    await s.eval("localStorage.clear();localStorage.setItem('bt_qa_quickjump','true');localStorage.setItem('bt_qa_profile_code', JSON.stringify({done:true,skipped:true,langs:[],level:0,rank:0}));1");
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);
    await s.eval("window.confirm=function(){return true;};window.alert=function(){};1");
    const _ev = s.eval.bind(s);
    s.eval = function (x) { LAST = String(x).slice(0, 110); return _ev(x); };

    const hasSel = (sel) => s.eval('!!document.querySelector(' + JSON.stringify(sel) + ')');
    const clickBook = (name) => s.eval("(function(){var bs=document.querySelectorAll('.book');for(var i=0;i<bs.length;i++){if(bs[i].textContent.indexOf(" + JSON.stringify(name) + ")>=0){bs[i].click();return 1;}}return 0;})()");
    const pickSec = (kw) => s.eval("(function(){var bs=[].slice.call(document.querySelectorAll('.secbtn'));for(var i=0;i<bs.length;i++){if(bs[i].textContent.indexOf(" + JSON.stringify(kw) + ")>=0){bs[i].click();return 1;}}return 0;})()");
    const startDiff = (idx) => s.eval("(function(){var bs=document.querySelectorAll('.diffbtn');if(!bs.length)return 0;bs[" + idx + "].click();var go=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return /开始出题/.test(x.textContent)})[0];if(!go)return 0;go.click();return 1;})()");
    const toShelf = async () => {
      for (let i = 0; i < 6; i++) {
        if (await hasSel('.book')) return true;
        if (await hasSel('#curOverlay')) {
          await s.eval("(function(){var o=document.getElementById('curOverlay');var b=[].slice.call(o.querySelectorAll('.btn')).filter(function(x){return /返回|关闭|取消/.test(x.textContent)})[0];if(b)b.click();return 1;})()");
          await sleep(320); continue;
        }
        await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /退出本局|结束并结算/.test(x.textContent)})[0];if(b)b.click();return 1;})()");
        await sleep(520);
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
    const hasChip = () => hasSel('#stage .scratchchip');
    const curQ = () => s.eval("(function(){var q=qlist[qidx];return q?String(q.q||''):'';})()");
    const clickWrong = () => s.eval("(function(){var q=qlist[qidx];var bs=[].slice.call(document.querySelectorAll('#stage .obtn'));if(!bs.length)return 0;for(var i=0;i<bs.length;i++){if(bs[i].textContent.trim()!==String(q.a)){bs[i].click();return 1;}}return 0;})()");
    const hitNext = () => s.eval("(function(){var n=document.querySelector('#fbzone .fb .fbnext');if(n){n.click();return 1;}return 0;})()");
    const openPad = () => s.eval("(function(){var b=document.querySelector('#stage .scratchchip');if(!b)return 0;b.click();return 1;})()");
    const padVisible = () => s.eval("(function(){var e=document.getElementById('scratchPad');if(!e)return false;return getComputedStyle(e).display!=='none';})()");
    const padInk = () => s.eval("(function(){var cv=document.querySelector('#scratchPad canvas');if(!cv)return -1;var c=cv.getContext('2d');var d=c.getImageData(0,0,cv.width,cv.height).data;var n=0;for(var i=3;i<d.length;i+=4){if(d[i]>0)n++;}return n;})()");
    const drawOnPad = () => s.eval("(function(){var cv=document.querySelector('#scratchPad canvas');if(!cv)return 0;var r=cv.getBoundingClientRect();function pe(t,cx,cy){cv.dispatchEvent(new PointerEvent(t,{clientX:cx,clientY:cy,pointerId:1,pointerType:'mouse',bubbles:true,cancelable:true}));}pe('pointerdown',r.left+40,r.top+60);pe('pointermove',r.left+80,r.top+80);pe('pointermove',r.left+120,r.top+100);pe('pointerup',r.left+120,r.top+100);return 1;})()");
    const clearPad = () => s.eval("(function(){var e=document.getElementById('scratchPad');if(!e)return 0;var b=[].slice.call(e.querySelectorAll('.spbtn')).filter(function(x){return /清空/.test(x.textContent)})[0];if(b){b.click();return 1;}return 0;})()");
    const collapsePad = () => s.eval("(function(){var e=document.getElementById('scratchPad');if(!e)return 0;var b=[].slice.call(e.querySelectorAll('.spbtn')).filter(function(x){return /收起/.test(x.textContent)})[0];if(b){b.click();return 1;}return 0;})()");
    const weakN = async () => JSON.parse(await s.eval("S.getItem('bt_qa_weak')||'[]'")).length;

    /* ================= A. 数学显示 / 常识不显示 ================= */
    ck('进入数学·选择题', await openCat('数学', '选择题', 2), '');
    ck('数学题显示「📝 草稿」chip', await hasChip(), '');
    await toShelf();
    ck('进入常识·选择题', await openCat('常识', '选择题', 2), '');
    ck('常识题不显示草稿 chip', (await hasChip()) === false, '');

    /* ================= B. 科学：chip 出现 === 题干命中计算关键词（逐题扫 12 道） ================= */
    const secOK = await openCat('科学', '选择题', 2);
    ck('进入科学·选择题', secOK, '');
    if (secOK) {
      const KW = /计算|多少|等于|求|速度|压强|电流|电压|电阻|功率|面积|体积|浓度|质量|密度|浮力|热量|公式|路程|时间/;
      let consistent = true, sawCalc = false, sawMem = false, bad = [], scanned = 0;
      for (let i = 0; i < 12; i++) {
        if (!(await hasSel('#stage .obtn'))) break;
        const q = await curQ();
        const want = KW.test(q);
        const got = await hasChip();
        scanned++;
        if (got !== want) { consistent = false; bad.push((q.slice(0, 22)) + ' want=' + want + ' got=' + got); }
        if (want) sawCalc = true; else sawMem = true;
        if (i < 11) { await clickWrong(); await sleep(220); await hitNext(); await sleep(240); }
      }
      ck('科学题 chip 与计算关键词逐题一致', consistent, 'scanned=' + scanned + ' ' + bad.slice(0, 2).join(' | '));
      ck('科学样本里既有计算题（显示）也有记忆题（不显示）', sawCalc && sawMem, 'scanned=' + scanned + ' sawCalc=' + sawCalc + ' sawMem=' + sawMem);
    }

    /* ================= C. 打开草稿板 → 画布可见 + 手写有墨迹 ================= */
    await toShelf();
    await openCat('数学', '选择题', 2);
    ck('回到数学题有草稿 chip', await hasChip(), '');
    await openPad();
    await s.waitFor("!!document.querySelector('#scratchPad canvas')", 5000);
    await sleep(300);
    ck('点草稿 chip → 浮层可见', await padVisible(), '');
    const cvDim = await s.eval("(function(){var cv=document.querySelector('#scratchPad canvas');return cv?[cv.width,cv.height,cv.clientWidth,cv.clientHeight]:null;})()");
    ck('canvas 完成 dpr 尺寸设置（宽高 > 0）', cvDim && cvDim[0] > 0 && cvDim[1] > 0, JSON.stringify(cvDim));
    const ink0 = await padInk();
    await drawOnPad();
    await sleep(120);
    const ink1 = await padInk();
    ck('手写后画布有墨迹', ink1 > ink0, ink0 + '→' + ink1);

    /* ================= D. 清空 → 归零 ================= */
    await clearPad();
    await sleep(150);
    ck('点「清空」→ 画布归零', (await padInk()) === 0, 'ink=' + await padInk());

    /* ================= E. 收起再开同一题 → 草稿还在 ================= */
    await drawOnPad();
    await sleep(120);
    const inkDrawn = await padInk();
    await collapsePad();
    await sleep(200);
    ck('点「收起」→ 浮层隐藏', (await padVisible()) === false, '');
    await openPad();
    await sleep(450);
    ck('再次打开同一题 → 草稿还原', (await padInk()) > 0, 'ink=' + await padInk() + ' (原 ' + inkDrawn + ')');
    await collapsePad();
    await sleep(150);

    /* ================= F. 切到下一题 → 新题草稿为空（按题隔离） ================= */
    await s.eval("(function(){var q=qlist[qidx];var bs=[].slice.call(document.querySelectorAll('#stage .obtn'));for(var i=0;i<bs.length;i++){if(bs[i].textContent.trim()!==String(q.a)){bs[i].click();break;}}var n=[].slice.call(document.querySelectorAll('#fbzone .fb .fbnext'))[0];if(n)n.click();return 1;})()");
    await sleep(500);
    ck('已切到下一题（qidx=1）', (await s.eval('qidx')) === 1, 'qidx=' + await s.eval('qidx'));
    await openPad();
    await sleep(400);
    ck('新题草稿为空（不串题）', (await padInk()) === 0, 'ink=' + await padInk());
    await collapsePad();
    await sleep(150);

    /* ================= H. 草稿不影响答题/判分 ================= */
    const wB = await weakN();
    await clickWrong();
    await sleep(320);
    const fb = await s.eval("(function(){var f=document.querySelector('#fbzone .fb');return f?f.textContent:'';})()");
    ck('画过草稿后仍能正常答错（反馈条出现）', /正确答案：/.test(fb), JSON.stringify(fb.slice(0, 30)));
    ck('答错仍记入薄弱题（草稿不影响判分）', (await weakN()) === wB + 1, wB + '→' + await weakN());

    /* ================= G. 退出本局再开新局 → 草稿不残留 ================= */
    await toShelf();
    await openCat('数学', '选择题', 2);
    await openPad();
    await sleep(400);
    ck('新局首题草稿为空（Map 已清空）', (await padInk()) === 0, 'ink=' + await padInk());
    await collapsePad();

    /* ================= I. 收尾 ================= */
    ck('全程无 JS 异常', s.errors.length === 0, s.errors.slice(0, 2).join(' | '));
    const ovf = await s.eval('document.documentElement.scrollWidth - document.documentElement.clientWidth');
    ck('无横向溢出', ovf <= 0, 'overflow=' + ovf);
  } catch (e) {
    fail.push('探针异常 :: ' + e.message + ' | 最后表达式: ' + LAST);
  } finally {
    console.log('\n=== 草稿板（批次 B）：' + pass.length + '/' + (pass.length + fail.length) + ' 通过 ===');
    pass.forEach(t => console.log('  ✓ ' + t));
    fail.forEach(t => console.log('  ✗ ' + t));
    await s.close();
    try { srv && srv.kill('SIGKILL'); } catch (e) {}
  }
})().catch(e => { console.error(e); process.exit(1); });
