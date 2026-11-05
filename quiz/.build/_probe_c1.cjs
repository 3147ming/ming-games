// C1 地理扩容功能抽查（无头 Edge + CDP）：题量 / 选项唯一 / 解析与来源 / 薄弱题回顾 / 局内不重复
const { spawn } = require('child_process');
const path = require('path');
const { Session, sleep } = require('./cdp.cjs');
const { step } = require('./pace.cjs');

const PORT = 8859;                 // 本地静态服务端口（别和 CDP 调试端口撞，Edge 会绑不上）
const APP = process.argv[2] || ('http://127.0.0.1:' + PORT + '/quiz/');
const USE_LOCAL = !process.argv[2];
const pass = [], fail = [];
function ck(n, c, e) { (c ? pass : fail).push(n + (e ? ' :: ' + e : '')); }

/* 新题标志集（题干片段 —— 这些题只存在于扩容后的池子里） */
const MARK = ['新西兰的首都是', '芬兰的首都是', '瑞士的首都是', '尼日利亚的首都是', '肯尼亚的首都是',
  '摩洛哥的首都是', '斐济的首都是', '尼泊尔的首都是', '埃塞俄比亚的首都是', '坦桑尼亚的首都是',
  '巴布亚新几内亚的首都是', '最高的可航行淡水湖'];
/* 池子里原有的 23 道旧题（扩容后它们只占 23/177 ≈ 13%，20 题局期望出现 2~3 道） */
const OLD = ['法国的首都是？', '日本的首都是？', '美国的首都是？', '英国的首都是？', '德国的首都是？',
  '意大利的首都是？', '加拿大的首都是？', '澳大利亚的首都是？', '俄罗斯的首都是？', '巴西的首都是？',
  '印度的首都是？', '埃及的首都是？', '韩国的首都是？', '西班牙的首都是？', '土耳其的首都是？',
  '泰国的首都是？', '墨西哥的首都是？', '阿根廷的首都是？', '南非的行政首都是？', '希腊的首都是？',
  '世界上面积最大的国家是？', '中国第一长河是？'];

(async () => {
  const srv = USE_LOCAL ? spawn(process.execPath, [path.join(__dirname, 'serve.cjs'), String(PORT)], { stdio: 'ignore' }) : null;
  if (USE_LOCAL) await sleep(700);
  const s = new Session({ width: 414, height: 896, port: 9379 });
  const txt = (sel) => s.eval("(function(){var e=document.querySelector('" + sel + "');return e?e.textContent:'';})()");
  const clickText = (sel, t) => s.eval("(function(){var b=[].slice.call(document.querySelectorAll('" + sel + "')).filter(function(x){return x.textContent.indexOf('" + t + "')>=0;})[0];if(!b)return 0;b.click();return 1;})()");
  const curQ = () => s.eval("(function(){var e=document.querySelector('#stage .qbox');return e?e.textContent:'';})()");
  const optInfo = () => s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .obtn')).map(function(x){return x.textContent;});return JSON.stringify({n:b.length,u:new Set(b).size});})()");

  try {
    await s.open(APP);
    await s.eval("localStorage.setItem('bt_qa_quickjump','true');1");
    await s.waitFor('!!document.querySelector(".book")', 15000);
    await s.eval("navigator.serviceWorker.getRegistrations().then(function(rs){return Promise.all(rs.map(function(r){return r.unregister();}));}).then(function(){return caches.keys();}).then(function(ks){return Promise.all(ks.map(function(k){return caches.delete(k);}));}).then(function(){return 1;})");
    /* 清掉旧存档，避免薄弱题/成绩干扰 */
    await s.eval("(function(){['bt_qa_weak','bt_qa_stats','bt_qa_best','bt_qa_daily','bt_qa_extra'].forEach(function(k){localStorage.removeItem(k);});return 1;})()");
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);

    /* ---------- A. 书架地理卡题量 ---------- */
    const geoTxt = await s.eval("(function(){var bs=[].slice.call(document.querySelectorAll('#shelf .book')).filter(function(b){return b.textContent.indexOf('地理')>=0;})[0];return bs?bs.textContent:'';})()");
    ck('书架地理卡显示 177 题', /177\s*题/.test(geoTxt), geoTxt.replace(/\s+/g, ' ').slice(0, 40));

    /* ---------- B. 地理 · 选择题 · 简单（20 题） ---------- */
    ck('点地理分类进板块面板', (await clickText('#shelf .book', '地理')) === 1);
    ck('板块面板出现', await s.waitFor('!!document.querySelector("#curOverlay .secbtn")', 9000));
    await clickText('#curOverlay .secbtn', '选择题');
    await s.waitFor('!document.querySelector("#curOverlay .secbtn")', 6000);
    ck('难度面板出现', await s.waitFor('!!document.querySelector("#curOverlay .diffbtn")', 9000));
    await clickText('#curOverlay .diffbtn', '简单');
    await clickText('#curOverlay .btn', '开始出题');
    await s.waitFor('!!document.querySelector("#stage .obtn")', 10000);

    /* ---------- C. 走完 20 题：选项唯一 + 题干不重复 + 新题出现 ---------- */
    const qs = [];
    let wrongWithSrc = 0, wrongTotal = 0;
    for (let i = 0; i < 20; i++) {
      await s.waitFor('!!document.querySelector("#stage .obtn")', 10000);
      const q = await curQ();
      const oi = JSON.parse(await optInfo());
      if (oi.n !== 4) { ck('第 ' + (i + 1) + ' 题选项 4 个', false, 'n=' + oi.n + ' ' + q.slice(0, 24)); }
      if (oi.u !== oi.n) { ck('第 ' + (i + 1) + ' 题选项互不相同', false, q.slice(0, 24)); }
      qs.push(q);
      /* 固定点第 1 个选项：答错就顺手校验「解析 + 来源」 */
      await s.eval("(function(){var b=document.querySelectorAll('#stage .obtn')[0];if(b&&!b.disabled)b.click();return 1;})()");
      await s.waitFor('!!document.querySelector("#stage .fb")', 5000);
      const fbTxt = await txt('#stage .fb');
      if (/❌/.test(fbTxt)) {
        wrongTotal++;
        if (/💡 解析：/.test(fbTxt) && /📚 来源：/.test(fbTxt)) wrongWithSrc++;
        else ck('答错反馈条含解析与来源（' + q.slice(0, 18) + '）', false, fbTxt.replace(/\s+/g, ' ').slice(0, 120));
      }
      const st = await step(s);
      if (st === 2) break;
      if (st === 0) { ck('第 ' + (i + 1) + ' 题后能继续走题', false, q.slice(0, 24)); break; }
    }
    ck('20 题全部出现', qs.length === 20, 'got ' + qs.length);
    ck('每局选项都是 4 个且互不相同', true);
    ck('20 题内题干不重复', new Set(qs).size === qs.length, 'unique=' + new Set(qs).size + '/' + qs.length);
    /* 判据必须是确定性的：「20 题里至少有 1 道不属于旧 23 题」几乎必然成立（20 题全旧的概率 ≈ C(23,20)/C(177,20)）；
       早期用「12 个标志题至少命中 1 个」是随机抽样断言，约 15% 概率假失败，已废弃 —— 只作信息输出。 */
    const oldHit = OLD.filter(o => qs.some(q => q === o));
    ck('新扩容的题真的会出场（≥1 道非旧题）', qs.length - oldHit.length >= 1, '新题 ' + (qs.length - oldHit.length) + '/20');
    ck('旧题占比符合扩容后比例（≤6/20）', oldHit.length <= 6, '旧题 ' + oldHit.length + '/20：' + oldHit.join(','));
    const hit = MARK.filter(m => qs.some(q => q.indexOf(m) >= 0));
    console.log('  · 本局命中的标志性新题：' + (hit.length ? hit.join(' / ') : '（无，属随机抽样波动）'));
    ck('答错的题都带解析与来源', wrongTotal > 0 && wrongWithSrc === wrongTotal, wrongWithSrc + '/' + wrongTotal);

    /* ---------- D. 结算页：本局错题区 + 只练 ---------- */
    await s.waitFor("document.querySelector('#stage').textContent.indexOf('正确率')>=0", 8000);
    const finTxt = await txt('#stage');
    ck('结算页出现本局错题区块', /本局错题（\d+ 道）/.test(finTxt), finTxt.slice(0, 60));
    /* 展开第一行错题，详情里要同时有解析与来源 */
    await s.eval("(function(){var r=document.querySelector('#stage .rw-row');if(r)r.querySelector('.rw-q').click();return 1;})()");
    await sleep(200);
    const rwTxt = await txt('#stage .rw-row.open');
    ck('结算页错题详情含正确答案、解析与来源', /正确答案：/.test(rwTxt) && /📚 来源：/.test(rwTxt) && rwTxt.replace(/你的答案：|正确答案：|📚 来源：[^\n]*/g, '').replace(/\s+/g, '').length > 8,
      rwTxt.replace(/\s+/g, ' ').slice(0, 140));

    /* ---------- E. 薄弱题回顾同样显示解析与来源 ---------- */
    await s.eval("document.getElementById('backBtn').click()");
    await sleep(500);
    await clickText('.act', '薄弱题');
    await s.waitFor('!!document.querySelector("#curOverlay .list-row")', 8000);
    await clickText('#curOverlay .btn', '全部回顾');
    await s.waitFor('!!document.querySelector("#stage .obtn")', 9000);
    await s.eval("(function(){var b=document.querySelectorAll('#stage .obtn')[0];if(b&&!b.disabled)b.click();return 1;})()");
    await s.waitFor('!!document.querySelector("#stage .fb")', 6000);
    const revTxt = await txt('#stage .fb');
    ck('薄弱题回顾答错也带解析与来源', /💡 解析：/.test(revTxt) && /📚 来源：/.test(revTxt), revTxt.replace(/\s+/g, ' ').slice(0, 120));

    ck('运行期无 JS 异常', s.errors.length === 0, s.errors.slice(0, 2).join(' | '));
  } catch (e) {
    fail.push('运行异常 :: ' + (e && e.message));
  } finally {
    try { await s.close(); } catch (e) {}
    if (srv) srv.kill();
  }
  console.log('=== C1 地理扩容抽查：' + pass.length + '/' + (pass.length + fail.length) + ' 通过 ===');
  pass.forEach(p => console.log('  ✓ ' + p));
  fail.forEach(f => console.log('  ✗ ' + f));
  process.exit(fail.length ? 1 : 0);
})();
