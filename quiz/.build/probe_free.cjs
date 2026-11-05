/* 一次性探针：免费 AI 通道端到端打真实 Pollinations（无桩） */
const { spawn } = require('child_process');
const path = require('path');
const { Session, sleep } = require('./cdp.cjs');

const PORT = 8859;
const APP = process.argv[2] || ('http://127.0.0.1:' + PORT + '/quiz/');
const USE_LOCAL = !process.argv[2];
const pass = [], fail = [];
function ck(n, c, e) { (c ? pass : fail).push(n + (e ? ' :: ' + e : '')); }

(async () => {
  const srv = USE_LOCAL ? spawn(process.execPath, [path.join(__dirname, 'serve.cjs'), String(PORT)], { stdio: 'ignore' }) : null;
  if (USE_LOCAL) await sleep(700);
  const s = new Session({ width: 414, height: 896, port: 9359 });
  try {
    await s.open(APP);
    await s.eval("localStorage.setItem('bt_qa_quickjump','true');1");
    await s.waitFor('!!document.querySelector(".book")', 15000);
    // 只配免费通道：Key 留空
    await s.eval(`localStorage.setItem('bt_qa_ai', JSON.stringify({url:'https://text.pollinations.ai/openai',key:'',model:'openai',proxy:''}));1`);
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);

    // 非侵入式观测：clone 一份读正文，原响应仍交给 callAI
    await s.eval(`(function(){
      window.__aiRes=null;window.__realFetch=window.fetch;
      window.fetch=function(u,o){
        if(o&&String(o.method||'').toUpperCase()==='POST'){
          return window.__realFetch.apply(window,arguments).then(function(r){
            try{var c=r.clone();c.text().then(function(t){window.__aiRes={status:r.status,ok:r.ok,bytes:t.length,head:t.slice(0,80),tail:t.slice(-80)};});}catch(e){}
            return r;
          });
        }
        return window.__realFetch.apply(window,arguments);
      };
      return 1;})()`);
    // 1) 测试连接打真实端点
    await s.eval(`document.getElementById('settingsBtn').click();1`);
    await s.waitFor(`!!document.getElementById('aiProvider')`, 6000);
    await sleep(300);
    const pid = await s.eval(`document.getElementById('aiProvider').value`);
    ck('设置回显免费 AI 服务商', pid === 'free', 'pid=' + pid);
    await s.eval(`(function(){var b=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return x.textContent.indexOf('测试连接')>=0;})[0];b.click();return 1;})()`);
    let testMsg = '';
    for (let i = 0; i < 24; i++) {
      await sleep(1000);
      testMsg = await s.eval(`(function(){var hs=[].slice.call(document.querySelectorAll('#curOverlay .hint'));return hs.length?hs[hs.length-1].textContent:'';})()`);
      if (/连接成功|失败/.test(testMsg)) break;
    }
    ck('真实端点测试连接 → ✅ 连接成功', /✅ 连接成功/.test(testMsg), testMsg);
    await s.eval(`(function(){var o=document.querySelector('#curOverlay .close');if(o)o.click();return 1;})()`);
    await sleep(200);

    // 2) 新建题库 → AI 生成（真实链路：素材聚合 + 真实模型出题）
    await s.eval(`(function(){var a=[].slice.call(document.querySelectorAll('.act')).filter(function(x){return x.textContent.indexOf('新建')>=0;})[0];a.click();return 1;})()`);
    await sleep(300);
    const btnTxt = await s.eval(`(function(){var b=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return x.textContent.indexOf('AI 生成')>=0;})[0];return b.textContent;})()`);
    ck('入口按钮标注免费通道无需 Key', /无需 Key/.test(btnTxt), btnTxt);
    await s.eval(`(function(){var i=document.querySelector('#curOverlay input');i.value='化学元素';return 1;})()`);
    await s.eval(`(function(){var b=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return x.textContent.indexOf('AI 生成')>=0;})[0];b.click();return 1;})()`);
    let rows = 0, hud = '';
    for (let i = 0; i < 100; i++) {
      await sleep(1500);
      rows = await s.eval("document.querySelectorAll('#stage .list-row').length");
      hud = await s.eval("document.getElementById('stage').textContent||''");
      if (rows) break;
      if (/未返回有效题目|抓不到/.test(hud)) break;
    }
    const sample = rows ? await s.eval("document.querySelector('#stage .list-row').textContent") : '';
    const liveRes = await s.eval("JSON.stringify(window.__aiRes)");
    ck('真实免费模型出题成功（预览 ≥1 题）', rows >= 1, 'rows=' + rows + ' | ' + hud.slice(0, 60) + ' | ' + String(sample).slice(0, 50) + ' | resp=' + liveRes);

    const errs = s.errors.filter(e => !/favicon|sw\.js|SW /i.test(e));
    ck('无 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));
  } catch (e) {
    fail.push('EXCEPTION :: ' + e.message);
  } finally {
    console.log('\n=== 免费 AI 通道真实链路：' + pass.length + '/' + (pass.length + fail.length) + ' 通过 ===');
    pass.forEach(t => console.log('  ✓ ' + t));
    fail.forEach(t => console.log('  ✗ ' + t));
    await s.close();
    try { srv && srv.kill('SIGKILL'); } catch (e) {}
  }
})().catch(e => { console.error(e); process.exit(1); });
