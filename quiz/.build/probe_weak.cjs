// P1-2 薄弱题本专项（无头 Edge + CDP）
// 覆盖：列表浮层 / 错误次数徽标 / 分类筛选 / 单题练（答对推进 SRS，不一次移除）/ 删除 / 150 上限保留高频
const { spawn } = require('child_process');
const path = require('path');
const { Session, sleep } = require('./cdp.cjs');

const PORT = 8858;
const APP = process.argv[2] || ('http://127.0.0.1:' + PORT + '/quiz/');
const USE_LOCAL = !process.argv[2];
const pass = [], fail = [];
function ck(n, c, e) { (c ? pass : fail).push(n + (e ? ' :: ' + e : '')); }

function seedScript(list) {
  return "(function(){localStorage.setItem('bt_qa_weak',JSON.stringify(" + JSON.stringify(list) + "));return 1;})()";
}
const D = 86400000;
const now = Date.now();
const SEED = [
  { type: 'b:geo', q: '测试薄弱题·AAAA（南非行政首都）', a: '比勒陀利亚', opts: ['比勒陀利亚', '开普敦', '布隆方丹', '约翰内斯堡'], n: 3, t: now - 3 * D, pick: '开普敦' },
  { type: 'b:science', q: '测试薄弱题·BBBB（水的分子式）', a: 'H₂O', opts: ['H₂O', 'CO₂', 'O₂', 'NaCl'], n: 1, t: now - 3600000 },
  { type: 'c:三角洲', q: '测试薄弱题·CCCC（自定义分类）', a: 'x', opts: ['x', 'y', 'z', 'w'], n: 2, t: now - 60000 },
];

(async () => {
  const srv = USE_LOCAL ? spawn(process.execPath, [path.join(__dirname, 'serve.cjs'), String(PORT)], { stdio: 'ignore' }) : null;
  if (USE_LOCAL) await sleep(700);
  const s = new Session({ width: 414, height: 896, port: 9375 });
  const rows = () => s.eval("JSON.stringify([].slice.call(document.querySelectorAll('#curOverlay .list-row')).map(function(r){return r.textContent.replace(/\\s+/g,' ').trim();}))")
    .then(t => JSON.parse(t));
  const clickByText = (sel, txt) => s.eval("(function(){var b=[].slice.call(document.querySelectorAll('" + sel + "')).filter(function(x){return x.textContent.indexOf('" + txt + "')>=0;})[0];if(!b)return 0;b.click();return 1;})()");
  try {
    await s.open(APP);
    await s.eval("localStorage.setItem('bt_qa_quickjump','true');1");
    await s.waitFor('!!document.querySelector(".book")', 15000);
    await s.eval("navigator.serviceWorker.getRegistrations().then(function(rs){return Promise.all(rs.map(function(r){return r.unregister();}));}).then(function(){return caches.keys();}).then(function(ks){return Promise.all(ks.map(function(k){return caches.delete(k);}));}).then(function(){return 1;})");

    /* ---------- A. 列表浮层 ---------- */
    /* 线上发版传播期第一帧可能还是旧 SW 的旧包（旧 loadWeak 无自愈），且 reload 偶发静默超时
       —— 种子写入后最多重载 3 轮，只要书架徽标出现「·3」就继续 */
    let actTxt = '';
    for (let i = 0; i < 3; i++) {
      await s.eval(seedScript(SEED));
      await s.reload();
      await s.waitFor('!!document.querySelector(".book")', 12000);
      actTxt = await s.eval("(function(){var a=[].slice.call(document.querySelectorAll('.act')).filter(function(x){return x.textContent.indexOf('薄弱题')>=0;})[0];return a?a.textContent:'';})()");
      if (/·\s*3/.test(actTxt)) break;
      await sleep(700);
    }
    ck('书架薄弱题入口显示条数', /·\s*3/.test(actTxt), actTxt);
    await clickByText('.act', '薄弱题');
    await sleep(400);
    const title = await s.eval("(function(){var h=document.querySelector('#curOverlay h3');return h?h.textContent:'';})()");
    ck('点「薄弱题」先打开题本列表', /薄弱题本/.test(title), title);
    let r1 = await rows();
    ck('列表显示 3 条薄弱题', r1.length === 3, 'rows=' + r1.length);
    ck('高频错题排最前且显示 ×3', /×3/.test(r1[0] || ''), r1[0]);
    ck('行内含分类标签', /地理/.test(r1[0] || ''), r1[0]);
    ck('行内含相对时间', /天前|小时前|刚刚|分钟前/.test((r1[0] || '') + (r1[1] || '') + (r1[2] || '')), r1.join(' | '));

    /* ---------- B. 分类筛选 ---------- */
    await s.eval("(function(){var sel=document.querySelector('#curOverlay select');sel.value='b:science';sel.onchange();return 1;})()");
    await sleep(200);
    const rs = await rows();
    ck('筛选「科学」只剩 1 条', rs.length === 1, 'rows=' + rs.length);
    await s.eval("(function(){var sel=document.querySelector('#curOverlay select');sel.value='';sel.onchange();return 1;})()");
    await sleep(200);
    ck('切回全部分类恢复 3 条', (await rows()).length === 3);

    /* ---------- C. 行展开详情 ---------- */
    await s.eval("(function(){var r=document.querySelectorAll('#curOverlay .list-row')[0];r.onclick();return 1;})()");
    await sleep(200);
    const detTxt = await s.eval("(function(){var r=document.querySelectorAll('#curOverlay .list-row')[0];return r.textContent.replace(/\\s+/g,' ');})()");
    ck('展开详情含正确答案', /正确答案/.test(detTxt), detTxt.slice(0, 120));
    ck('展开详情含你的错选', /你选的是/.test(detTxt), detTxt.slice(0, 120));

    /* ---------- D. 单题练：答对推进 SRS（C2：不再一次移除） ---------- */
    await clickByText('#curOverlay .btn', '练这题');
    await sleep(700);
    const hud = await s.eval("(function(){var x=document.querySelector('#stage .hl');return x?x.textContent:'';})()");
    const prog = await s.eval("(function(){var x=document.querySelector('#stage .hr');return x?x.textContent:'';})()");
    ck('单题练进入回顾模式', /回顾薄弱题/.test(hud), hud);
    ck('单题练只有 1 题', /1\/1/.test(prog), prog);
    const ansOk = await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .obtn')).filter(function(x){return x.textContent==='比勒陀利亚';})[0];if(!b)return 0;b.click();return 1;})()");
    ck('单题练题目选项可作答', ansOk === 1);
    await sleep(1400);
    const finTxt = await s.eval("(document.getElementById('stage').textContent||'').replace(/\\s+/g,' ')");
    ck('答对后进入结算页', /正确率/.test(finTxt), finTxt.slice(0, 100));
    ck('单题练答对 → 正确率 100%', /正确率 100%/.test(finTxt), finTxt.slice(0, 100));
    const backBtn = await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return x.textContent.indexOf('返回薄弱题本')>=0;})[0];return b?1:0;})()");
    ck('结算页提供「返回薄弱题本」', backBtn === 1);
    const weakAfterD = JSON.parse(await s.eval("JSON.stringify(JSON.parse(localStorage.getItem('bt_qa_weak')||'[]'))"));
    const left1 = weakAfterD.map(function(x){return x.q;});
    const itemA = weakAfterD.filter(function(x){return x.q && x.q.indexOf('AAAA') >= 0;})[0];
    ck('答对后该题仍在题本（SRS 推进，不一次移除）', left1.length === 3 && !!itemA, left1.length + ' → ' + left1.join('|'));
    ck('答对后 SRS 等级升到 1', !!(itemA && itemA.srs && itemA.srs.lv === 1), itemA ? JSON.stringify(itemA.srs) : '缺失');

    await clickByText('#stage .btn', '返回薄弱题本');
    await sleep(400);
    ck('返回后重新打开题本（题仍在）', (await rows()).length === 3, 'rows=' + (await rows()).length);

    /* ---------- E. 删除 ---------- */
    await s.eval("window.confirm=function(){return true;};1");
    await clickByText('#curOverlay .btn', '移除');
    await sleep(300);
    const left2 = JSON.parse(await s.eval("JSON.stringify(JSON.parse(localStorage.getItem('bt_qa_weak')||'[]').map(function(x){return x.q;}))"));
    ck('删除后本地只剩 2 条（3 条移除 1 条）', left2.length === 2, 'len=' + left2.length);

    /* ---------- F. 回顾答错计数 +1 ---------- */
    await s.eval(seedScript([{ type: 'b:geo', q: '测试薄弱题·DDDD（答错计数）', a: '巴黎', opts: ['巴黎', '伦敦', '东京', '柏林'], n: 1, t: now }]));
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);
    await clickByText('.act', '薄弱题');
    await s.waitFor('!!document.querySelector("#curOverlay .list-row")', 8000);
    await clickByText('#curOverlay .btn', '练这题');
    /* 固定 sleep 在线上拍不准：等选项真的可点了再点 */
    await s.waitFor('document.querySelectorAll("#stage .obtn").length>=2', 10000);
    await sleep(250);
    const clicked = await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .obtn')).filter(function(x){return x.textContent!=='巴黎';})[0];if(!b)return 0;b.click();return 1;})()");
    for (let i = 0; i < 20; i++) {
      const nn = Number(await s.eval("(function(){var a=JSON.parse(localStorage.getItem('bt_qa_weak')||'[]');return a.length?a[0].n:0;})()"));
      if (nn === 2) break;
      await sleep(150);
    }
    const n2 = await s.eval("(function(){var a=JSON.parse(localStorage.getItem('bt_qa_weak')||'[]');return a.length?a[0].n:0;})()");
    ck('回顾答错 → 错误次数 +1', Number(n2) === 2, 'n=' + n2 + ' clicked=' + clicked);

    /* ---------- G. 150 上限 + 高频保留 ---------- */
    const big = [];
    big.push({ type: 'b:common', q: 'HOT·高频错题', a: 'h', opts: ['h', 'a', 'b', 'c'], n: 9, t: now - 100 * D });
    for (let i = 0; i < 200; i++) big.push({ type: 'b:science', q: 'FILL·' + i, a: 'a', opts: ['a', 'b', 'c', 'd'], n: 1, t: now - i * 1000 });
    await s.eval(seedScript(big));
    /* 部署刚生效时首帧可能还是旧 SW / 旧 CDN 包（旧包的 loadWeak 没有自愈），
       那样会稳定读到 201；这里最多重载 3 轮，每轮轮询 3 秒，避免把发版瞬间的旧缓存当成回归。 */
    let capLen = 0; const capSeries = [];
    for (let round = 0; round < 3; round++) {
      if (round > 0) await s.eval(seedScript(big));
      await s.reload();
      await s.waitFor('!!document.querySelector(".book")', 12000);
      for (let i = 0; i < 20; i++) {
        capLen = Number(await s.eval("JSON.parse(localStorage.getItem('bt_qa_weak')||'[]').length"));
        if (!capSeries.length || capLen !== capSeries[capSeries.length - 1]) capSeries.push(capLen);
        if (capLen > 0 && capLen <= 150) break;
        await sleep(150);
      }
      if (capLen > 0 && capLen <= 150) break;
    }
    ck('首次渲染即裁剪到 150 条（saveWeak 生效）', capLen > 0 && capLen <= 150, 'raw=' + capLen + ' 序列=' + capSeries.join('>'));
    // 触发一次 saveWeak：错一次再裁（reload 偶发超时静默返回，最多重来 3 轮）
    const pushTrigger = "(function(){var a=JSON.parse(localStorage.getItem('bt_qa_weak')||'[]');a.push({type:'b:geo',q:'TRIGGER',a:'x',opts:['x','y','z','w'],n:1,t:Date.now()});localStorage.setItem('bt_qa_weak',JSON.stringify(a));return 1;})()";
    let capped = 0;
    for (let round = 0; round < 3; round++) {
      await s.eval(pushTrigger);
      await s.reload();
      await s.waitFor('!!document.querySelector(".book")', 12000);
      await s.eval("(function(){window.scrollTo(0,0);return 1;})()");
      await clickByText('.act', '薄弱题');
      await sleep(400);
      for (let i = 0; i < 15; i++) {
        capped = Number(await s.eval("JSON.parse(localStorage.getItem('bt_qa_weak')||'[]').length"));
        if (capped === 150) break;
        await sleep(200);
      }
      if (capped === 150) break;
    }
    ck('超过 150 条会裁剪到 150', capped === 150, 'len=' + capped);
    const hotKept = await s.eval("(function(){var a=JSON.parse(localStorage.getItem('bt_qa_weak')||'[]');return a.some(function(x){return x.q==='HOT·高频错题';})?1:0;})()");
    ck('高频错题（n=9）未被新题挤掉', hotKept === 1);
  } catch (e) {
    fail.push('运行异常 :: ' + (e && e.message));
  } finally {
    try { await s.close(); } catch (e) {}
    if (srv) srv.kill();
  }
  console.log('=== 薄弱题本探针：' + pass.length + '/' + (pass.length + fail.length) + ' 通过 ===');
  pass.forEach(p => console.log('  ✓ ' + p));
  fail.forEach(f => console.log('  ✗ ' + f));
  process.exit(fail.length ? 1 : 0);
})();
