// 答题全屏 + 固定反馈区 + 音乐扩展名探测/报错 专项探针
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { Session, sleep } = require('./cdp.cjs');

const PORT = 8857;
const APP = process.argv[2] || ('http://127.0.0.1:' + PORT + '/quiz/');
const USE_LOCAL = !process.argv[2];
const pass = [], fail = [];
function ck(n, c, e) { (c ? pass : fail).push(n + (e ? ' :: ' + e : '')); }

(async () => {
  const srv = USE_LOCAL ? spawn(process.execPath, [path.join(__dirname, 'serve.cjs'), String(PORT)], { stdio: 'ignore' }) : null;
  if (USE_LOCAL) await sleep(700);
  const s = new Session({ width: 414, height: 896, port: 9365 });
  const netAudio = [];
  s.eventHook = (o) => {
    if (o.method === 'Network.requestWillBeSent') {
      const r = o.params.request || {};
      const u = r.url || '';
      // 只统计 GET（实际播放）；面板的 HEAD 探测（逐个扩展名试）不算播放
      if (/\/audio\//.test(u) && r.method !== 'HEAD') netAudio.push(u.split('/').pop());
    }
  };
  try {
    await s.open(APP);
    await s.eval("localStorage.setItem('bt_qa_quickjump','true');1");
    await s.send('Network.enable');
    await s.waitFor('!!document.querySelector(".book")', 15000);
    // 清 SW，保证拿到最新页面
    await s.eval("navigator.serviceWorker.getRegistrations().then(function(rs){return Promise.all(rs.map(function(r){return r.unregister();}));}).then(function(){return caches.keys();}).then(function(ks){return Promise.all(ks.map(function(k){return caches.delete(k);}));}).then(function(){return 1;})");
    await s.eval(`localStorage.setItem('bt_qa_custom', JSON.stringify({填空库:[{q:'中国的首都是？',a:'北京'},{q:'1+1=？',a:'2'},{q:'水的化学式？',a:'H2O'},{q:'太阳从哪边升起？',a:'东方'}]}));1`);
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);

    // ---------- A. 选择题：全屏 + 固定反馈区 ----------
    await s.eval(`(function(){var bs=document.querySelectorAll('.book');for(var i=0;i<bs.length;i++){if(bs[i].textContent.indexOf('数学')>=0){bs[i].click();return 1;}}return 0;})()`);
    await s.waitFor(`!!document.querySelector('.secbtn')`, 6000);
    await s.eval(`(function(){var b=document.querySelector('.secbtn');if(b)b.click();return 1;})()`);
    await s.wait(250);
    await s.waitFor(`!!document.querySelector('.diffbtn')`, 8000);
    await s.eval(`(function(){var bs=[].slice.call(document.querySelectorAll('.diffbtn'));var b=bs[bs.length-1];b.click();return 1;})()`);
    await sleep(200);
    await s.eval(`(function(){var g=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return /开始出题/.test(x.textContent);})[0];if(g)g.click();return 1;})()`);
    await s.waitFor(`!!document.querySelector('.obtn')`, 8000);

    const geom = JSON.parse(await s.eval(`(function(){
      var card=document.querySelector('#stage .qcard'), stage=document.getElementById('stage');
      var qb=document.querySelector('.qbox'), fz=document.getElementById('fbzone'), ft=document.querySelector('.quizfoot');
      if(!card||!qb||!fz||!ft)return JSON.stringify({err:'missing'});
      function r(e){var b=e.getBoundingClientRect();return {t:Math.round(b.top),b:Math.round(b.bottom),h:Math.round(b.height)};}
      return JSON.stringify({card:r(card),stage:r(stage),qbox:r(qb),fbz:r(fz),foot:r(ft),vh:window.innerHeight,
        footerTop:r(ft).t, scrollY:window.scrollY, docH:document.documentElement.scrollHeight,
        cls:card.className, qcls:qb.className, fbChildren:fz.children.length});
    })()`));
    ck('答题卡使用 quizfill 全屏布局', /quizfill/.test(geom.cls || ''), geom.cls);
    ck('题干区带 fill（吃掉剩余高度）', /fill/.test(geom.qcls || ''), geom.qcls);
    ck('题干区高度 > 200px（不再是半屏小卡）', (geom.qbox || {}).h > 200, 'qbox.h=' + (geom.qbox || {}).h);
    ck('卡片撑满视口高度（≥ 视口 − 120）', (geom.card || {}).h >= geom.vh - 120, 'card.h=' + (geom.card || {}).h + ' vh=' + geom.vh);
    ck('反馈预留区存在于卡片内且已占位', !!geom.fbz && geom.fbz.h >= 70 && geom.fbChildren === 0, 'h=' + (geom.fbz || {}).h);

    // 点一个选项 → 反馈进预留区，底部按钮不位移
    await s.eval(`(function(){var b=document.querySelector('.obtn');b.click();return 1;})()`);
    await sleep(220);
    const after = JSON.parse(await s.eval(`(function(){
      var fz=document.getElementById('fbzone'), ft=document.querySelector('.quizfoot'), fb=fz?fz.querySelector('.fb'):null;
      function r(e){var b=e.getBoundingClientRect();return {t:Math.round(b.top),h:Math.round(b.height)};}
      return JSON.stringify({inZone:!!fb, footTop:ft?r(ft).t:null, fbzH:fz?r(fz).h:null, txt:(fb||{}).textContent||'', scrollY:window.scrollY});
    })()`));
    ck('反馈条出现在固定预留区 #fbzone 内', after.inZone, after.txt);
    ck('反馈出现后底部按钮不位移', Math.abs(after.footTop - geom.footerTop) <= 2, 'before=' + geom.footerTop + ' after=' + after.footTop);
    ck('反馈出现后页面不滚动', after.scrollY === 0, 'scrollY=' + after.scrollY);

    // ---------- B. 填空题分支同样全屏 + 反馈区 ----------
    await s.eval(`(function(){var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /退出本局/.test(x.textContent);})[0];if(b)b.click();return 1;})()`);
    await s.waitFor(`!!document.querySelector('.book')`, 8000);
    await sleep(300);
    await s.eval(`(function(){var bs=document.querySelectorAll('.book');for(var i=0;i<bs.length;i++){if(bs[i].textContent.indexOf('填空库')>=0){bs[i].click();return 1;}}return 0;})()`);
    await sleep(400);
    await s.waitFor(`!!document.querySelector('input[type=text]')`, 8000);
    const fill = JSON.parse(await s.eval(`(function(){
      var card=document.querySelector('#stage .qcard'), qb=document.querySelector('#stage .qbox'), fz=document.getElementById('fbzone');
      function r(e){var b=e.getBoundingClientRect();return {h:Math.round(b.height),t:Math.round(b.top)};}
      return JSON.stringify({cls:card.className,qh:qb?r(qb).h:0,fz:!!fz,fh:fz?r(fz).h:0});
    })()`));
    ck('填空题也使用全屏卡片', /quizfill/.test(fill.cls) && fill.qh > 200, 'cls=' + fill.cls + ' qh=' + fill.qh);
    ck('填空题也有固定反馈区', fill.fz && fill.fh >= 70, 'h=' + fill.fh);
    await s.eval(`(function(){var t=document.querySelector('input[type=text]');t.value='北京';var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /提交/.test(x.textContent);})[0];if(b)b.click();return 1;})()`);
    await sleep(220);
    const fillFb = await s.eval(`!!(document.getElementById('fbzone')&&document.getElementById('fbzone').querySelector('.fb'))`);
    ck('填空反馈也进预留区', fillFb);

    // ---------- C. 音乐：列表过滤（无文件曲目不显示） ----------
    await s.eval(`(function(){document.getElementById('musicBtn').click();return 1;})()`);
    await s.waitFor(`!!document.getElementById('musicPanel')`, 6000);
    await sleep(300);
    // 等探测完成（HEAD 全部跑完，列表刷新）：轮询到列表稳定 = 3（内置 + 2 首有文件）
    let tracks = -1, stable = 0;
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      tracks = parseInt(await s.eval(`document.querySelectorAll('#musicPanel .mtrack').length`), 10);
      if (tracks === 3) { if (++stable >= 2) break; } else stable = 0;
    }
    ck('过滤后只显示有文件的曲目（内置轻音乐 + Flower Dance + Windy Hill）', tracks === 3, 'n=' + tracks);
    const namesRaw = await s.eval(`JSON.stringify([].slice.call(document.querySelectorAll('#musicPanel .mtrack .mn')).map(function(x){return x.textContent;}))`);
    const namesArr = JSON.parse(namesRaw);
    ck('缺失默认曲目 Summer/Luv Letter/卡农 已从列表消失', !/Summer|Luv Letter|卡农/.test(JSON.stringify(namesArr)), JSON.stringify(namesArr));
    // 播放 Flower Dance（本地已有 flower-dance.flac），面板探测命中后应直接用 .flac
    await s.eval(`(function(){var rows=[].slice.call(document.querySelectorAll('#musicPanel .mtrack'));var r=rows.filter(function(x){return x.textContent.indexOf('Flower Dance')>=0;})[0];if(r)r.click();return 1;})()`);
    let fd = null;
    for (let i = 0; i < 16; i++) {
      await sleep(500);
      if (netAudio.indexOf('flower-dance.flac') >= 0) break;
      fd = JSON.parse(await s.eval(`(function(){
        var err=document.getElementById('mpErr');
        return JSON.stringify({err:(err||{}).textContent||'',errShown:err?getComputedStyle(err).display!=='none':false,name:(document.getElementById('mpName')||{}).textContent||'',play:(document.getElementById('mpPlay')||{}).textContent||''});
      })()`));
    }
    if (!fd) fd = JSON.parse(await s.eval(`(function(){
      var err=document.getElementById('mpErr');
      return JSON.stringify({err:(err||{}).textContent||'',errShown:err?getComputedStyle(err).display!=='none':false,name:(document.getElementById('mpName')||{}).textContent||'',play:(document.getElementById('mpPlay')||{}).textContent||''});
    })()`));
    const fdAudio = netAudio.filter((n) => /^flower-dance\./.test(n));
    fd.res = netAudio.slice();
    ck('Flower Dance 探测到 .flac 并请求成功', fd.res.indexOf('flower-dance.flac') >= 0, JSON.stringify(fd.res));
    ck('面板探测命中后直接用 .flac（不再请求 .mp3）', fdAudio.indexOf('flower-dance.mp3') < 0 && fdAudio.indexOf('flower-dance.flac') >= 0, JSON.stringify(fdAudio));
    ck('Flower Dance 播放无报错提示', !fd.errShown && fd.err === '', 'err=' + fd.err);
    // 「📁 从 audio/ 添加」一个不存在的曲目，应被过滤隐藏（自定义 base 曲目同样探测）
    await s.eval(`(function(){
      var inp=document.querySelector('#musicPanel input[placeholder*="如 my-song"]');
      if(inp)inp.value='no-such-song';
      var btns=[].slice.call(document.querySelectorAll('#musicPanel .btn')).filter(function(x){return x.textContent==='＋';});
      if(btns[0])btns[0].click();   // 第一个 ＋ = 从 audio/ 添加
      return 1;
    })()`);
    await s.waitFor(`!!document.getElementById('musicPanel')`, 6000);
    let ghostHidden = false;
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      const hasGhost = await s.eval(`[].slice.call(document.querySelectorAll('#musicPanel .mtrack .mn')).some(function(x){return x.textContent==='no-such-song';})`);
      if (!hasGhost) { ghostHidden = true; break; }
    }
    ck('「📁 从 audio/ 添加」的不存在曲目也被过滤隐藏', ghostHidden);

    const errs = s.errors.filter(e => !/favicon|sw\.js|SW /i.test(e));
    ck('无 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));

    const r = await s.send('Page.captureScreenshot', { format: 'png' });
    if (!fs.existsSync(path.join(__dirname, 'shots'))) fs.mkdirSync(path.join(__dirname, 'shots'));
    fs.writeFileSync(path.join(__dirname, 'shots', 'quiz-fullscreen.png'), Buffer.from(r.data, 'base64'));
  } catch (e) {
    fail.push('EXCEPTION :: ' + e.message);
  } finally {
    console.log('\n=== 全屏答题 / 音乐探测：' + pass.length + '/' + (pass.length + fail.length) + ' 通过 ===');
    pass.forEach(t => console.log('  ✓ ' + t));
    fail.forEach(t => console.log('  ✗ ' + t));
    await s.close();
    try { srv && srv.kill('SIGKILL'); } catch (e) {}
  }
})();
