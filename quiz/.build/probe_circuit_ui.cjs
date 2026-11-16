/* circuit 学科真实 UI 冒烟：书架 → 分类 → 难度面板 → 开局 → 答题 → 结算。
   独立端口/独立 profile，避免与 _runall 的浏览器串扰。 */
const { spawn } = require('child_process');
const path = require('path');
const { Session, sleep } = require('./cdp.cjs');
const PORT = 8931;
const pass = [], fail = [];
function ck(n, c, e) { (c ? pass : fail).push(n + (e ? ' :: ' + e : '')); }

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, 'serve.cjs'), String(PORT)], { stdio: 'ignore' });
  await sleep(700);
  const s = new Session({ width: 414, height: 896, port: 9331 });
  try {
    await s.open('http://127.0.0.1:' + PORT + '/quiz/');
    await s.eval("localStorage.clear();1");
    await s.eval("navigator.serviceWorker.getRegistrations().then(function(rs){return Promise.all(rs.map(function(r){return r.unregister();}));}).then(function(){return caches.keys();}).then(function(ks){return Promise.all(ks.map(function(k){return caches.delete(k);}));}).then(function(){return 1;})");
    await s.eval("localStorage.setItem('bt_qa_quickjump','true');localStorage.setItem('bt_qa_onboard','done');1");
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 15000);

    // A. 书架里 circuit 分类存在，显示 507 题（人工精编）
    const shelf = await s.eval(`(function(){var bs=document.querySelectorAll('.book');for(var i=0;i<bs.length;i++){var t=bs[i].textContent||'';if(t.indexOf('电路与模拟电子')>=0)return t.replace(/\\s+/g,' ').trim();}return '';})()`);
    ck('书架显示「电路与模拟电子」分类', shelf.length > 0, shelf);
    ck('书架卡片显示 507 题', /507/.test(shelf), shelf);
    ck('书架卡片标注「人工精编」', /人工精编/.test(shelf), shelf);

    // B. 点开分类 → 板块选择 → 难度面板（5 档 + circuit hint）
    const opened = await s.eval(`(function(){var bs=document.querySelectorAll('.book');for(var i=0;i<bs.length;i++){if((bs[i].textContent||'').indexOf('电路与模拟电子')>=0){bs[i].click();return 1;}}return 0;})()`);
    ck('电路分类可点开', opened === 1);
    await s.waitFor('!!document.querySelector(".secbtn")', 6000);
    await s.eval(`(function(){var b=document.querySelector('.secbtn');if(b)b.click();return 1;})()`); // 选「选择题」板块
    await s.waitFor('!!document.querySelector(".diffbtn")', 8000);
    const diffPanel = await s.eval(`(function(){var ov=document.querySelector('#curOverlay')||document.body;var t=ov.textContent.replace(/\\s+/g,' ');var bs=document.querySelectorAll('.diffbtn');return JSON.stringify({n:bs.length,hint:(t.indexOf('模拟 IC')>=0||t.indexOf('电路基础到')>=0),labels:Array.prototype.map.call(bs,function(b){return b.textContent.trim();}),txt:t.slice(0,200)});})()`);
    const dp = JSON.parse(diffPanel);
    ck('难度面板含 5 档 circuit 难度', dp.n >= 5 && dp.labels.filter(x => /入门|基础|进阶|熟练|精通/.test(x)).length === 5, JSON.stringify(dp.labels));
    ck('难度面板含 circuit 专属 hint', dp.hint, dp.txt);

    // C. 选「入门」档 → 开始出题 → 答题界面出现
    await s.eval(`(function(){var bs=[].slice.call(document.querySelectorAll('.diffbtn'));for(var i=0;i<bs.length;i++){if((bs[i].textContent||'').indexOf('入门')>=0){bs[i].click();return 1;}}return 0;})()`);
    await sleep(250);
    const go = await s.eval(`(function(){var g=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return /开始出题/.test(x.textContent);})[0];if(g){g.click();return 1;}return 0;})()`);
    ck('点击「开始出题」', go === 1);
    await s.waitFor('!!document.querySelector(".obtn")', 8000);
    const qinfo = await s.eval(`(function(){var qb=document.querySelector('.qbox');var opts=document.querySelectorAll('.obtn');return JSON.stringify({q:qb?qb.textContent.replace(/\\s+/g,' ').trim():'',n:opts.length});})()`);
    const qi = JSON.parse(qinfo);
    ck('题目文本出现', qi.q.length > 4, qi.q);
    ck('4 个选项', qi.n === 4, String(qi.n));

    // 核对当前题来自 circuit 题干集合（避免抽到别的学科）：用题库题干逐条做包含匹配
    const inPool = await s.eval(`(function(){var qb=document.querySelector('.qbox');var t=qb?qb.textContent.replace(/\\s+/g,''):'';var hit=0;for(var d=0;d<5;d++){var arr=(typeof POOLS!=='undefined'&&POOLS.circuit&&POOLS.circuit[d])||[];for(var i=0;i<arr.length;i++)if(arr[i][0]&&t.indexOf(String(arr[i][0]).replace(/\\s+/g,''))>=0)hit++;}return hit;})()`);
    ck('首题来自 circuit 题库', inPool > 0, 'hit=' + inPool);

    console.log('=== circuit 真实 UI 冒烟：通过 ' + pass.length + '，失败 ' + fail.length + ' ===');
    fail.forEach(f => console.log('  ✗ ' + f));
    if (fail.length) process.exitCode = 1;
  } catch (e) {
    console.log('  ✗ 测量异常：' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n'));
    process.exitCode = 1;
  } finally {
    await s.close();
    srv.kill('SIGKILL');
  }
})();
