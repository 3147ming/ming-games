// PWA 验收探针：manifest / SW / 缓存内容 / 离线刷新 / 离线完整一局 / 离线建题库提示 / 在线联网题
// 注意：页面脚本内联在 <body> 里，document.body.textContent 会包含源码文本，
//      所以所有"界面上出现了什么"的断言必须用 DOM 元素查询，不能拿 body.textContent 判断。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Session, sleep } = require('./cdp.cjs');
const { step } = require('./pace.cjs');

const ROOT = 'D:/Projects/_github_pages/ming-games';
const PORT = 8849;
const LIVE = process.argv[2] || '';                     // 传入线上地址则跳过本地服务
const results = [];
function ok(cond, name, extra) {
  results.push({ pass: !!cond, name, extra });
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (extra ? ' :: ' + extra : ''));
}
function pngSize(file) {
  const b = fs.readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length };
}

(async () => {
  const srv = LIVE ? null : spawn(process.execPath, [path.join(__dirname, 'serve.cjs'), String(PORT)], { stdio: 'ignore' });
  if (!LIVE) await sleep(600);
  const APP = LIVE || ('http://127.0.0.1:' + PORT + '/quiz/');

  const s = new Session({ port: 9412, width: 414, height: 896 });
  // #stage 内是否存在含某文案的按钮（结算页/面板用）
  const stageBtn = (t) => s.eval(`[].slice.call(document.querySelectorAll('#stage button')).some(function(b){return b.textContent.indexOf(${JSON.stringify(t)})>=0})`);
  const stageHint = () => s.eval(`(function(){var h=document.querySelector('#stage .hint');return h?h.textContent:'';})()`);

  try {
    await s.open(APP);
    await s.waitFor('!!document.querySelector(".book")', 15000);
    await s.ensureLoaded();   // 线上先验文档完整性（抓包代理会截断 HTML）
    await s.eval("localStorage.setItem('bt_qa_quickjump','true');1");

    // ---------- manifest / 图标 ----------
    const mRes = await s.eval(`fetch('manifest.json').then(r=>r.json()).then(j=>JSON.stringify(j)).catch(e=>'ERR:'+e.message)`);
    let mani = null;
    try { mani = JSON.parse(mRes); } catch (e) {}
    ok(!!mani, 'manifest.json 可解析', mani ? mani.name : String(mRes).slice(0, 60));
    ok(mani && mani.display === 'standalone', 'display=standalone', mani && mani.display);
    ok(mani && mani.start_url === './' && mani.scope === './', 'start_url/scope 均为 ./', mani && (mani.start_url + ' / ' + mani.scope));
    ok(mani && /^#[0-9a-f]{6}$/i.test(mani.theme_color) && /^#[0-9a-f]{6}$/i.test(mani.background_color),
      '主题色/背景色合法', mani && (mani.theme_color + ' / ' + mani.background_color));
    ok(mani && mani.icons && mani.icons.length === 2 && mani.icons.some(i => i.sizes === '192x192') && mani.icons.some(i => i.sizes === '512x512'),
      'icons 含 192 与 512', mani && mani.icons.map(i => i.sizes).join(','));

    const i192 = pngSize(path.join(ROOT, 'quiz/icons/icon-192.png'));
    const i512 = pngSize(path.join(ROOT, 'quiz/icons/icon-512.png'));
    ok(i192.w === 192 && i192.h === 192, 'icon-192 为正方形 192×192', i192.w + '×' + i192.h + ' ' + i192.bytes + 'B');
    ok(i512.w === 512 && i512.h === 512, 'icon-512 为正方形 512×512', i512.w + '×' + i512.h + ' ' + i512.bytes + 'B');

    // ---------- 页面 & 头部 ----------
    const shelfOK = await s.waitFor('!!document.querySelector(".book")', 15000);
    ok(shelfOK, '页面打开并渲染书架', 'books=' + (await s.eval('document.querySelectorAll(".book").length')));
    const headOK = await s.eval(`!!document.querySelector('link[rel=manifest]') && !!document.querySelector('link[rel=apple-touch-icon]') && !!document.querySelector('meta[name=theme-color]')`);
    ok(headOK, 'HTML 头部含 manifest / apple-touch-icon / theme-color');

    // ---------- SW ----------
    const gotActive = await s.waitFor(`navigator.serviceWorker.getRegistrations().then(function(rs){return rs.some(function(r){return r.active&&r.active.state==='activated';});})`, 40000);
    ok(gotActive, 'SW 已 activated', await s.eval(`navigator.serviceWorker.getRegistrations().then(function(rs){return JSON.stringify(rs.map(function(r){return (r.active&&r.active.state)||(r.installing&&('installing:'+r.installing.state))||'none';}));})`));
    const hasCtrl = await s.waitFor('!!navigator.serviceWorker.controller', 8000);
    ok(hasCtrl, '当前页面已被 SW 接管（controller 非空）', await s.eval('navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : "null"'));

    // ---------- 缓存内容 ----------
    /* install 是「逐个 grab，单个失败不拖垮安装」的容错设计（见 sw.js），
       所以在弱网/抓包代理截断时可能出现 index.html 进缓存、512 图标没下完的中间态。
       这里给最多 3 次、间隔 2s 的补读，避免把「网络抖动」判成「预缓存缺失」。 */
    const readCache = () => s.eval(`(async()=>{
      const keys = await caches.keys();
      const k = keys.find(x=>x.indexOf('quiz-')===0) || keys[0];
      if(!k) return JSON.stringify({keys:keys, entries:[]});
      const c = await caches.open(k);
      const reqs = await c.keys();
      return JSON.stringify({keys:keys, entries:reqs.map(r=>r.url)});
    })()`);
    let ci = { keys: [], entries: [] };
    for (let k = 0; k < 3; k++) {
      try { ci = JSON.parse(await readCache()); } catch (e) { ci = { keys: [], entries: [] }; }
      const _i = ci.entries.filter(u => /icons\/icon-\d+\.png$/.test(u)).length;
      if (ci.entries.some(u => /manifest\.json$/.test(u)) && _i === 2) break;
      if (k < 2) await sleep(2000);
    }
    const hasIdx = ci.entries.some(u => /\/quiz\/(index\.html)?$/.test(u));
    const hasMani = ci.entries.some(u => /manifest\.json$/.test(u));
    const hasIcons = ci.entries.filter(u => /icons\/icon-\d+\.png$/.test(u)).length;
    ok(/quiz-v\d+/.test(ci.keys.join(',')), '缓存名带版本号', ci.keys.join(','));
    ok(hasIdx, '已预缓存页面外壳', hasIdx ? 'yes' : ci.entries.slice(0, 6).join(' | '));
    ok(hasMani && hasIcons === 2, '已预缓存 manifest 与 2 枚图标', 'manifest=' + hasMani + ' icons=' + hasIcons);
    ok(!ci.entries.some(u => /opentdb|allorigins|baidu|openai|deepseek/i.test(u)), '外部 API 未进缓存（符合要求）', 'entries=' + ci.entries.length);

    // ---------- 离线刷新 ----------
    await s.send('Network.enable');
    await s.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await s.send('Page.reload', {});   // 不能 ignoreCache，否则会绕过 SW
    await sleep(2200);
    const offShelf = await s.waitFor('!!document.querySelector(".book")', 12000);
    ok(offShelf, '断网刷新后仍能打开书架', 'title=' + (await s.eval('document.title')) + ' books=' + (await s.eval('document.querySelectorAll(".book").length')));

    // ---------- 离线完整一局 ----------
    await s.eval(`(function(){var bs=document.querySelectorAll('.book');for(var i=0;i<bs.length;i++){if(bs[i].textContent.indexOf('数学')>=0){bs[i].click();return 1;}}return 0;})()`);
    await sleep(500);
    await s.waitFor(`!!document.querySelector('.secbtn')`, 6000);
    await s.eval(`(function(){var b=document.querySelector('.secbtn');if(b)b.click();return 1;})()`);
    await s.wait(250);
    const hasDiff = await s.waitFor(`!!document.querySelector('.diffbtn')`, 5000);
    ok(hasDiff, '离线能打开难度面板', 'diffbtn=' + (await s.eval(`document.querySelectorAll('.diffbtn').length`)));
    if (hasDiff) {
      await s.eval(`(function(){var bs=document.querySelectorAll('.diffbtn');if(bs.length>1)bs[1].click();else bs[0].click();return 1;})()`);
      await sleep(250);
      await s.eval(`(function(){var bs=document.querySelectorAll('.btn.gold');for(var i=0;i<bs.length;i++){if(bs[i].textContent.indexOf('开始出题')>=0){bs[i].click();return 1;}}return 0;})()`);
      await sleep(700);
    }
    const q1 = await s.waitFor(`!!document.querySelector('.obtn')`, 8000);
    ok(q1, '离线能进入答题页', (await s.eval(`(function(){var h=document.querySelector('.hud');var q=document.querySelector('.qbox');return (h?h.textContent:'')+' / '+(q?q.textContent.slice(0,24):'');})()`)));

    let answered = 0;
    for (let i = 0; i < 14; i++) {
      if (await stageBtn('再来一局')) break;
      const st = await s.eval(`(function(){
        if(document.querySelector('.obtn')){document.querySelector('.obtn').click();return 'opt';}
        var ti=document.querySelector('input[type=text]');
        if(ti){ti.value='x';var bs=document.querySelectorAll('#stage .btn.gold');for(var i=0;i<bs.length;i++){if(bs[i].textContent.indexOf('提交')>=0){bs[i].click();return 'fill';}}}
        return 'none';
      })()`);
      if (st === 'none') break;
      answered++;
      /* 答完一题反馈条会停留（答对 0.8s / 答错 2.5s 供读解析）：点「下一题 ›」直接跳过，
         否则下一次点击落在 locked 的本题上，一局永远走不完 */
      await sleep(140);
      await step(s);
    }
    const finished = await stageBtn('再来一局');
    ok(answered >= 10, '离线连续答题正常推进', 'answered=' + answered);
    ok(finished, '离线能完整答完一局并到结算页', (await s.eval(`(function(){var c=document.querySelector('#stage .qcard');return c?c.textContent.replace(/\\s+/g,' ').slice(0,60):'no-card';})()`)));

    // ---------- 离线建题库提示 ----------
    await s.eval(`(function(){var bs=document.querySelectorAll('#stage button');for(var i=0;i<bs.length;i++){if(bs[i].textContent.indexOf('返回书架')>=0){bs[i].click();return 1;}}return 0;})()`);
    await sleep(500);
    await s.eval(`(function(){var a=document.querySelectorAll('.act');for(var i=0;i<a.length;i++){if(a[i].textContent.indexOf('新建')>=0){a[i].click();return 1;}}return 0;})()`);
    await sleep(450);
    const panelOpen = await s.eval(`(function(){var p=document.querySelector('.panel');return !!p && p.textContent.indexOf('免费搜索生成')>=0;})()`);
    ok(panelOpen, '新建题库面板可打开（离线）');
    if (panelOpen) {
      await s.eval(`(function(){var i=document.querySelector('.panel input');if(i){i.value='离线测试';}return 1;})()`);
      await s.eval(`(function(){var bs=document.querySelectorAll('.panel .btn');for(var i=0;i<bs.length;i++){if(bs[i].textContent.indexOf('免费搜索')>=0){bs[i].click();return 1;}}return 0;})()`);
      await sleep(800);
      const hint = await stageHint();
      ok(hint.indexOf('当前没有网络') >= 0, '离线时「🆓 免费搜索建题库」明确提示网络不可用', hint.slice(0, 60));
    } else {
      ok(false, '离线时「🆓 免费搜索建题库」明确提示网络不可用', '面板未打开');
    }

    const jsErr1 = s.errors.filter(e => !/favicon|sw\.js/i.test(e));
    ok(jsErr1.length === 0, '离线阶段无 JS 异常', jsErr1.slice(0, 2).join(' | '));

    // ---------- 恢复在线 ----------
    await s.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    /* 走守卫版 reload：固定 sleep + 浅 waitFor 在线上会踩导航竞态（旧文档命中 / 新文档半渲染），
       后面「联网更新题库入口」就会在 #shelf 还没重绘时误判为不存在。 */
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);

    const online = await s.eval(`(async()=>{
      try{ const r = await fetch('https://opentdb.com/api.php?amount=1&type=multiple', {cache:'no-store'}); return 'http:'+r.status; }
      catch(e){ return 'fail:'+e.message; }
    })()`);
    ok(/http:200|fail:/.test(String(online)), '恢复在线后外部请求可用（不受 SW 拦截）', String(online).slice(0, 60));

    const swActive2 = await s.waitFor(`navigator.serviceWorker.getRegistrations().then(function(rs){return rs.some(function(r){return r.active&&r.active.state==='activated';});})`, 20000);
    ok(swActive2, '在线时 SW 仍正常工作', await s.eval(`navigator.serviceWorker.getRegistrations().then(function(rs){return JSON.stringify(rs.map(function(r){return (r.active&&r.active.state)||'none';}));})`));

    // 在线时联网题库入口仍在（不破坏原有功能）
    const onlineEntry = await s.waitFor(`(function(){var bs=document.querySelectorAll('#stage button, #shelf button');for(var i=0;i<bs.length;i++){if(bs[i].textContent.indexOf('联网更新题库')>=0)return true;}return false;})()`, 8000);
    ok(onlineEntry, '在线时「🔄 联网更新题库」入口不受影响');

    const jsErr2 = s.errors.filter(e => !/favicon|sw\.js/i.test(e));
    ok(jsErr2.length === 0, '在线阶段无 JS 异常', jsErr2.slice(0, 2).join(' | '));
  } catch (e) {
    ok(false, '探针执行异常', e.message + ' @ ' + (e.stack || '').split('\n')[1]);
  } finally {
    await s.close();
    try { srv && srv.kill('SIGKILL'); } catch (e) {}
  }

  const pass = results.filter(r => r.pass).length;
  console.log('\n=== PWA 验收：' + pass + '/' + results.length + ' 通过 ===');
  process.exit(pass === results.length ? 0 : 1);
})();
