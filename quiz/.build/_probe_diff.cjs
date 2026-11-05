/* 批次 C4：难度面板按真实题量标注 + 题量不足整局提示 + 自动模式不谎报实力
   A. 美食（12 题）→ 三档都标「本类仅 12 题」，困难档仍可选
   B. 选简单（20 题）→ 开局 HUD 第 1/12 + 常驻提示，答完一题后仍在
   C. 美食自动匹配 → HUD「🎲 混合难度」，不出现「实力：」；结算页同理
   D. 数学自动匹配 → 保留「实力：」（按档生成，真实的）
   E. 地理（177 题）→ 难度面板不出现「本类仅」
   F. 收尾：无 JS 异常、无横向溢出 */
const { spawn } = require('child_process');
const path = require('path');
const { Session, sleep } = require('./cdp.cjs');

const PORT = 8865;
const APP = process.argv[2] || ('http://127.0.0.1:' + PORT + '/quiz/');
const USE_LOCAL = !process.argv[2];
const pass = [], fail = [];
function ck(n, c, e) { (c ? pass : fail).push(n + (e ? ' :: ' + e : '')); }

(async () => {
  const srv = USE_LOCAL ? spawn(process.execPath, [path.join(__dirname, 'serve.cjs'), String(PORT)], { stdio: 'ignore' }) : null;
  if (USE_LOCAL) await sleep(700);
  const s = new Session({ width: 414, height: 896, port: 9365 });
  let LAST = '';
  try {
    await s.open(APP);
    await s.waitFor('!!document.querySelector(".book")', 15000);
    await s.eval("(function(){try{return navigator.serviceWorker.getRegistrations().then(function(rs){return Promise.all(rs.map(function(r){return r.unregister();}));});}catch(e){return 1;}})()");
    await s.eval("localStorage.clear();localStorage.setItem('bt_qa_profile_code', JSON.stringify({done:true,skipped:true,langs:[],level:0,rank:0}));localStorage.setItem('bt_qa_quickjump','false');1");
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);
    await s.eval("window.confirm=function(){return true;};window.alert=function(){};1");
    const _ev = s.eval.bind(s);
    s.eval = function (x) { LAST = String(x).slice(0, 120); return _ev(x); };
    const hasSel = (sel) => s.eval('!!document.querySelector(' + JSON.stringify(sel) + ')');

    const openBook = async (kw) => {
      await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('.book')).filter(function(x){return x.textContent.indexOf(" + JSON.stringify(kw) + ")>=0;})[0];if(b)b.click();return 1;})()");
      await s.waitFor("!!document.querySelector('.secbtn')||!!document.querySelector('.diffbtn')", 9000);
      if (await hasSel('.secbtn')) {
        await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('.secbtn')).filter(function(x){return /选择题/.test(x.textContent)})[0];if(b)b.click();return 1;})()");
        await sleep(450);
      }
    };
    const ddTexts = () => s.eval("JSON.stringify([].slice.call(document.querySelectorAll('#curOverlay .diffbtn .dd')).map(function(e){return e.textContent;}))");
    const startDiff = async (idx) => {
      await s.eval("(function(){var bs=document.querySelectorAll('#curOverlay .diffbtn');if(bs.length>" + idx + ")bs[" + idx + "].click();var go=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return /开始出题/.test(x.textContent)})[0];if(go)go.click();return 1;})()");
      await s.waitFor("!!document.querySelector('#stage .qbox')", 9000);
      await sleep(250);
    };
    const hud = () => s.eval("(function(){var e=document.querySelector('#stage .hl');return e?e.textContent:'';})()");
    const hrTxt = () => s.eval("(function(){var e=document.querySelector('#stage .hr');return e?e.textContent:'';})()");
    const stageTxt = () => s.eval("(function(){return (document.getElementById('stage').textContent||'').replace(/\\s+/g,' ');})()");
    const toShelf = async () => {
      for (let i = 0; i < 8; i++) {
        if (await hasSel('#curOverlay')) { await s.eval("(function(){var o=document.getElementById('curOverlay');var b=o.querySelector('.close');if(b)b.click();return 1;})()"); await sleep(250); continue; }
        if (await hasSel('.book')) return true;
        await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /退出本局|结束并结算/.test(x.textContent)})[0];if(b)b.click();return 1;})()");
        await sleep(450);
      }
      return await hasSel('.book');
    };

    /* ===== A. 美食（12 题）难度面板 ==== */
    await openBook('美食');
    const dds = JSON.parse(await ddTexts()).slice(1);   /* 第 0 项是「自动匹配」，不参与档位断言 */
    ck('美食难度面板渲染 3 个档位', dds.length === 3, dds.join(' | '));
    ck('美食三档都标注「本类仅 12 题」', dds.length === 3 && dds.every(t => /本类仅 12 题/.test(t)), dds.join(' | '));
    const hardOff = await s.eval("(function(){var bs=[].slice.call(document.querySelectorAll('#curOverlay .diffbtn'));var b=bs[bs.length-1];return b?(b.style.opacity||'')+'|'+(b.style.cursor||''):'';})()");
    ck('美食困难档仍可选（未置灰，只做标注）', hardOff === '|' || !/0\.45/.test(hardOff), hardOff);

    /* ===== B. 选简单（20 题）→ 实际 12 题 + 常驻提示 ===== */
    await startDiff(1);
    ck('选 20 题档 → 实际按 12 题出（HUD 第 1/12）', /1\/12/.test(await hrTxt()), await hrTxt());
    const st1 = await stageTxt();
    ck('开局有「唯一题只有 12 题」常驻提示', /唯一题只有 12 题/.test(st1), st1.slice(0, 90));
    /* 答一题后提示仍在（不是 toast 一过就没） */
    await s.eval("(function(){var b=document.querySelector('#stage .obtn');if(b)b.click();return 1;})()");
    await sleep(500);
    const st2 = await stageTxt();
    ck('答完一题后提示仍在（整局常驻）', /唯一题只有 12 题/.test(st2), st2.slice(0, 90));

    /* ===== C. 美食自动匹配 → 混合难度，不谎报实力 ===== */
    await toShelf();
    await openBook('美食');
    await startDiff(0);   /* 自动匹配 */
    const hudAuto = await hud();
    ck('美食自动模式 HUD 显示「🎲 混合难度」', /混合难度/.test(hudAuto), hudAuto);
    ck('美食自动模式 HUD 不再出现「实力：」', !/实力：/.test(hudAuto), hudAuto);
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /结束并结算/.test(x.textContent)})[0];if(b)b.click();return 1;})()");
    await s.waitFor("(function(){return /正确率/.test(document.getElementById('stage').textContent||'');})()", 9000);
    const fin1 = await stageTxt();
    ck('美食自动局结算页写「🎲 本轮混合难度」', /混合难度/.test(fin1), fin1.slice(0, 120));
    ck('美食自动局结算页不再写「当前实力」', !/当前实力/.test(fin1), fin1.slice(0, 120));

    /* ===== D. 数学自动匹配 → 保留真实实力 ===== */
    await toShelf();
    await openBook('数学');
    await startDiff(0);
    const hudMath = await hud();
    ck('数学自动模式仍显示「实力：」（按档生成，真实）', /实力：/.test(hudMath), hudMath);

    /* ===== E. 地理（177 题）不标注 ===== */
    await toShelf();
    await openBook('地理');
    const ddsGeo = JSON.parse(await ddTexts()).slice(1);
    ck('地理难度面板不出现「本类仅」（题量够）', ddsGeo.length === 3 && !ddsGeo.some(t => /本类仅/.test(t)), ddsGeo.join(' | '));

    /* ===== F. 收尾 ===== */
    ck('全程无 JS 异常', s.errors.length === 0, s.errors.slice(0, 2).join(' | '));
    const ovf = await s.eval('document.documentElement.scrollWidth - document.documentElement.clientWidth');
    ck('无横向溢出', ovf <= 0, 'overflow=' + ovf);
  } catch (e) {
    fail.push('探针异常 :: ' + e.message + ' | 最后表达式: ' + LAST);
  } finally {
    console.log('\n=== 难度面板真实题量 + 自动模式文案（批次 C4）：' + pass.length + '/' + (pass.length + fail.length) + ' 通过 ===');
    pass.forEach(t => console.log('  ✓ ' + t));
    fail.forEach(t => console.log('  ✗ ' + t));
    await s.close();
    try { srv && srv.kill('SIGKILL'); } catch (e) {}
  }
})().catch(e => { console.error(e); process.exit(1); });
