/* 批次 C6：小问题 7 条验收
   A. 书架徽标：0 分也显示「⭐ 0」，不再「未挑战」；书架文案不再承诺 AI 扩充
   B. 同名题库保存 → confirm 取消则不覆盖
   C. 删除自定义题库 → confirm 取消则不删除；确认才删
   D. 导出备份剔除 API Key（key_stripped）
   E. 设置里「✨ 题库不足时自动补题」开关默认关、可持久化
   F. 关闭浮层会补一次 history.back()（返回键不用点好几次）
   G. 收尾：无 JS 异常、无横向溢出 */
const { spawn } = require('child_process');
const path = require('path');
const { Session, sleep } = require('./cdp.cjs');

const PORT = 8866;
const APP = process.argv[2] || ('http://127.0.0.1:' + PORT + '/quiz/');
const USE_LOCAL = !process.argv[2];
const pass = [], fail = [];
function ck(n, c, e) { (c ? pass : fail).push(n + (e ? ' :: ' + e : '')); }

(async () => {
  const srv = USE_LOCAL ? spawn(process.execPath, [path.join(__dirname, 'serve.cjs'), String(PORT)], { stdio: 'ignore' }) : null;
  if (USE_LOCAL) await sleep(700);
  const s = new Session({ width: 414, height: 896, port: 9366 });
  let LAST = '';
  try {
    await s.open(APP);
    await s.waitFor('!!document.querySelector(".book")', 15000);
    await s.eval("(function(){try{return navigator.serviceWorker.getRegistrations().then(function(rs){return Promise.all(rs.map(function(r){return r.unregister();}));});}catch(e){return 1;}})()");
    await s.eval("localStorage.clear();"
      + "localStorage.setItem('bt_qa_profile_code', JSON.stringify({done:true,skipped:true,langs:[],level:0,rank:0}));"
      + "localStorage.setItem('bt_qa_quickjump','false');"
      + "localStorage.setItem('bt_qa_custom', JSON.stringify({'化学':[{q:'水的化学式是？',a:'H2O'},{q:'氧气的化学式是？',a:'O2'}]}));"
      + "localStorage.setItem('bt_qa_best', JSON.stringify({'b:food:0':0}));"
      + "localStorage.setItem('bt_qa_ai', JSON.stringify({url:'http://127.0.0.1:9/v1/chat/completions',key:'sk-secret-123',model:'m',proxy:''}));1");
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);
    await s.eval("window.__confirmRet=true;window.confirm=function(t){window.__lastConfirm=String(t);return !!window.__confirmRet;};window.alert=function(){};1");
    const _ev = s.eval.bind(s);
    s.eval = function (x) { LAST = String(x).slice(0, 120); return _ev(x); };
    const hasSel = (sel) => s.eval('!!document.querySelector(' + JSON.stringify(sel) + ')');
    const shelfTxt = () => s.eval("(document.getElementById('shelf').textContent||'')");
    const customLen = (n) => s.eval("(function(){var o=JSON.parse(localStorage.getItem('bt_qa_custom')||'{}');return (o[" + JSON.stringify(n) + "]||[]).length;})()");

    /* ===== A. 书架徽标 + 文案 ===== */
    const st0 = await shelfTxt();
    ck('美食 0 分也显示「⭐ 0」（不再未挑战）', /⭐ 0/.test(st0), st0.replace(/\s+/g, ' ').slice(0, 120));
    ck('书架文案不再承诺「AI 扩充题」', !/AI 扩充题/.test(st0), '');
    ck('书架文案改为「人工题库」+ 题量为准', /人工题库/.test(st0), '');

    /* ===== B. 同名题库保存：取消则不覆盖 ===== */
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('.act')).filter(function(x){return /新建/.test(x.textContent)})[0];if(b)b.click();return 1;})()");
    await s.waitFor("!!document.querySelector('#curOverlay input')", 8000);
    await s.eval("(function(){var i=document.querySelector('#curOverlay input');i.value='化学';i.dispatchEvent(new Event('input'));var b=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return /手动录入/.test(x.textContent)})[0];if(b)b.click();return 1;})()");
    await s.waitFor("!!document.querySelector('#stage input')", 8000);
    await s.eval("(function(){var ins=[].slice.call(document.querySelectorAll('#stage input'));var q=ins.filter(function(x){return x.placeholder==='问题'})[0];var a=ins.filter(function(x){return x.placeholder==='答案'})[0];q.value='新题';a.value='新答';var add=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /添加题目/.test(x.textContent)})[0];if(add)add.click();return 1;})()");
    await sleep(200);
    await s.eval("window.__confirmRet=false;1");
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /保存并开始/.test(x.textContent)})[0];if(b)b.click();return 1;})()");
    await sleep(400);
    const cf = await s.eval('window.__lastConfirm||""');
    ck('同名保存会弹覆盖确认', /已存在同名题库/.test(String(cf)), String(cf));
    ck('确认框选「取消」→ 题库不被覆盖', (await customLen('化学')) === 2, 'len=' + await customLen('化学'));
    const emTxt = await s.eval("(function(){var e=document.querySelector('#stage');return e?e.textContent:'';})()");
    ck('取消后有「未覆盖」提示', /未覆盖/.test(emTxt), emTxt.replace(/\s+/g, ' ').slice(0, 80));

    /* 确认覆盖：改成 1 题并开局，验证确实替换 */
    await s.eval("window.__confirmRet=true;1");
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /保存并开始/.test(x.textContent)})[0];if(b)b.click();return 1;})()");
    await s.waitFor("!!document.querySelector('#stage .qbox')", 9000);
    ck('确认「覆盖」→ 题库被替换为 1 题', (await customLen('化学')) === 1, 'len=' + await customLen('化学'));

    /* 回书架 */
    /* 退出本局用可切换的 confirm 桩（别再换成恒 true，否则后面的删除确认会失效） */
    await s.eval("window.__confirmRet=true;1");
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /退出本局/.test(x.textContent)})[0];if(b)b.click();return 1;})()");
    await s.waitFor('!!document.querySelector(".book")', 9000);

    /* ===== C. 删除题库确认 ===== */
    await s.eval("window.__confirmRet=false;1");
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('.book')).filter(function(x){return x.textContent.indexOf('化学')>=0;})[0];var d=b&&b.querySelector('.del');if(d)d.click();return 1;})()");
    await sleep(300);
    const cf2 = await s.eval('window.__lastConfirm||""');
    ck('删除题库会弹确认（含题库名）', /删除整个题库「化学」/.test(String(cf2)), String(cf2));
    ck('确认框选「取消」→ 题库仍在', (await customLen('化学')) === 1, 'len=' + await customLen('化学'));
    await s.eval("window.__confirmRet=true;1");
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('.book')).filter(function(x){return x.textContent.indexOf('化学')>=0;})[0];var d=b&&b.querySelector('.del');if(d)d.click();return 1;})()");
    await sleep(400);
    ck('确认「删除」→ 题库被删掉', (await customLen('化学')) === 0, 'len=' + await customLen('化学'));

    /* ===== D. 导出备份剔除 API Key ===== */
    await s.eval("(function(){window.__blobText='';var RB=window.Blob;window.Blob=function(parts,opts){try{window.__blobText=String((parts&&parts[0])||'');}catch(e){}return new RB(parts,opts);};"
      + "window.URL.createObjectURL=function(){return 'blob:probe';};window.URL.revokeObjectURL=function(){};return 1;})()");
    await s.eval("document.getElementById('statsBtn').click()");
    await s.waitFor("!!document.querySelector('#curOverlay .btn')", 8000);
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return /导出数据/.test(x.textContent)})[0];if(b)b.click();return 1;})()");
    await sleep(400);
    const bk = JSON.parse(await s.eval("window.__blobText||'{}'"));
    let aiCfg = null;
    try { aiCfg = JSON.parse((bk.values || {})['bt_qa_ai'] || '{}'); } catch (e) {}
    ck('导出内容含 bt_qa_ai 但 Key 被清空', !!aiCfg && aiCfg.key === '' && aiCfg.url === 'http://127.0.0.1:9/v1/chat/completions', JSON.stringify(aiCfg));
    ck('导出带 key_stripped 标记', bk.key_stripped === true, String(bk.key_stripped));
    await s.eval("(function(){var b=document.querySelector('#curOverlay .close');if(b)b.click();return 1;})()");
    await sleep(300);

    /* ===== E. 设置里的自动补题开关（默认关） ===== */
    await s.eval("document.getElementById('settingsBtn').click()");
    await s.waitFor("!!document.querySelector('#curOverlay input')", 8000);
    const arSt = JSON.parse(await s.eval("(function(){var ls=[].slice.call(document.querySelectorAll('#curOverlay label'));var l=ls.filter(function(x){return /自动补题/.test(x.textContent)})[0];var c=l&&l.querySelector('input');return JSON.stringify({has:!!l,checked:!!(c&&c.checked),stored:localStorage.getItem('bt_qa_autorefill')||''});})()"));
    ck('设置里有「题库不足时自动补题」开关', arSt.has === true, JSON.stringify(arSt));
    ck('自动补题默认关闭', arSt.checked === false && arSt.stored !== 'true', JSON.stringify(arSt));
    await s.eval("(function(){var ls=[].slice.call(document.querySelectorAll('#curOverlay label'));var l=ls.filter(function(x){return /自动补题/.test(x.textContent)})[0];var c=l&&l.querySelector('input');if(c){c.checked=true;c.onchange();}return 1;})()");
    ck('打开开关会持久化 bt_qa_autorefill', (await s.eval("localStorage.getItem('bt_qa_autorefill')")) === 'true', '');

    /* ===== F. 关闭浮层补一次 history.back() ===== */
    await s.eval("(function(){window.__hb=0;var b=history.back.bind(history);history.back=function(){window.__hb++;return b();};return 1;})()");
    await s.eval("(function(){var b=document.querySelector('#curOverlay .close');if(b)b.click();return 1;})()");
    await sleep(500);
    ck('关闭浮层会补一次 history.back()', (await s.eval('window.__hb||0')) >= 1, 'hb=' + await s.eval('window.__hb||0'));
    ck('关闭后浮层消失', (await hasSel('#curOverlay')) === false, '');

    /* ===== G. 收尾 ===== */
    ck('全程无 JS 异常', s.errors.length === 0, s.errors.slice(0, 2).join(' | '));
    const ovf = await s.eval('document.documentElement.scrollWidth - document.documentElement.clientWidth');
    ck('无横向溢出', ovf <= 0, 'overflow=' + ovf);
  } catch (e) {
    fail.push('探针异常 :: ' + e.message + ' | 最后表达式: ' + LAST);
  } finally {
    console.log('\n=== 小问题 7 条（批次 C6）：' + pass.length + '/' + (pass.length + fail.length) + ' 通过 ===');
    pass.forEach(t => console.log('  ✓ ' + t));
    fail.forEach(t => console.log('  ✗ ' + t));
    await s.close();
    try { srv && srv.kill('SIGKILL'); } catch (e) {}
  }
})().catch(e => { console.error(e); process.exit(1); });
