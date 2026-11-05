// C2 历史扩容功能抽查（无头 Edge + CDP）：题量 / 选项唯一 / 解析与来源 / 薄弱题回顾 / 局内不重复
const { spawn } = require('child_process');
const path = require('path');
const { Session, sleep } = require('./cdp.cjs');
const { step } = require('./pace.cjs');

const PORT = 8860;                 // 本地静态服务端口（别和 CDP 调试端口撞，Edge 会绑不上）
const APP = process.argv[2] || ('http://127.0.0.1:' + PORT + '/quiz/');
const USE_LOCAL = !process.argv[2];
const pass = [], fail = [];
function ck(n, c, e) { (c ? pass : fail).push(n + (e ? ' :: ' + e : '')); }

/* 扩容前就在池里的 18 道旧题（删掉重复的《独立宣言》后）—— 用于「新题必然出场」的确定性判据：
   150 题池里旧题只有 18 道，20 题局不重复抽样 ⟹ 至少 2 道是新题。 */
const OLD = ['第二次世界大战结束于哪一年？', '第一次世界大战爆发于哪一年？', '秦朝统一中国大约在公元前哪一年？',
  '中国改革开放始于哪一年？', '哥伦布到达美洲是哪一年？', '唐朝建立于哪一年？', '中华人民共和国成立于哪一年？',
  '工业革命最早始于哪个国家？', '活字印刷术由谁发明？', '拿破仑在哪场战役惨败后被流放？', '丝绸之路的起点一般认为是？',
  '新文化运动兴起于哪一年前后？', '美国第一任总统是？', '第二次世界大战全面爆发的标志是德国入侵哪国？',
  '中国第一个统一的封建王朝是？', '文艺复兴最早兴起于哪个国家？', '郑和下西洋发生在哪个朝代？',
  '中国古代"丝绸之路"连接中国与哪个地区？'];
/* 本批改动的三个标志性题（信息性输出，不断言，避免抽样随机导致偶发失败） */
const MARK = ['中国历史上第一个王朝是？', '牧野之战中击败商朝大军的是？', '都江堰水利工程由谁主持修建？',
  '卧薪尝胆的故事主人公是？', '淝水之战的交战双方是？', '第一次世界大战的导火线是？', '《共产党宣言》发表于哪一年？',
  '香港回归祖国是哪一年？', '中国恢复在联合国合法席位是哪一年？', '马拉松运动起源于哪场战争？',
  '罗斯福新政最突出的特点是？', '萨拉热窝事件'];

(async () => {
  const srv = USE_LOCAL ? spawn(process.execPath, [path.join(__dirname, 'serve.cjs'), String(PORT)], { stdio: 'ignore' }) : null;
  if (USE_LOCAL) await sleep(700);
  const s = new Session({ width: 414, height: 896, port: 9381 });
  const txt = (sel) => s.eval("(function(){var e=document.querySelector('" + sel + "');return e?e.textContent:'';})()");
  const clickText = (sel, t) => s.eval("(function(){var b=[].slice.call(document.querySelectorAll('" + sel + "')).filter(function(x){return x.textContent.indexOf('" + t + "')>=0;})[0];if(!b)return 0;b.click();return 1;})()");
  const curQ = () => s.eval("(function(){var e=document.querySelector('#stage .qbox');return e?e.textContent:'';})()");
  const optInfo = () => s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .obtn')).map(function(x){return x.textContent;});return JSON.stringify({n:b.length,u:new Set(b).size});})()");

  try {
    await s.open(APP);
    await s.eval("localStorage.setItem('bt_qa_quickjump','true');1");
    await s.waitFor('!!document.querySelector(".book")', 15000);
    await s.eval("navigator.serviceWorker.getRegistrations().then(function(rs){return Promise.all(rs.map(function(r){return r.unregister();}));}).then(function(){return caches.keys();}).then(function(ks){return Promise.all(ks.map(function(k){return caches.delete(k);}));}).then(function(){return 1;})");
    await s.eval("(function(){['bt_qa_weak','bt_qa_stats','bt_qa_best','bt_qa_daily','bt_qa_extra'].forEach(function(k){localStorage.removeItem(k);});return 1;})()");
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);

    /* ---------- A. 书架历史卡题量 ---------- */
    const hisTxt = await s.eval("(function(){var bs=[].slice.call(document.querySelectorAll('#shelf .book')).filter(function(b){return b.textContent.indexOf('历史')>=0;})[0];return bs?bs.textContent:'';})()");
    ck('书架历史卡显示 150 题', /150\s*题/.test(hisTxt), hisTxt.replace(/\s+/g, ' ').slice(0, 40));

    /* ---------- B. 历史 · 选择题 · 简单（20 题） ---------- */
    ck('点历史分类进板块面板', (await clickText('#shelf .book', '历史')) === 1);
    ck('板块面板出现', await s.waitFor('!!document.querySelector("#curOverlay .secbtn")', 9000));
    await clickText('#curOverlay .secbtn', '选择题');
    await s.waitFor('!document.querySelector("#curOverlay .secbtn")', 6000);
    ck('难度面板出现', await s.waitFor('!!document.querySelector("#curOverlay .diffbtn")', 9000));
    await clickText('#curOverlay .diffbtn', '简单');
    await clickText('#curOverlay .btn', '开始出题');
    await s.waitFor('!!document.querySelector("#stage .obtn")', 10000);

    /* ---------- C. 走完 20 题：选项唯一 + 题干不重复 + 答错必带来源 ---------- */
    const qs = [];
    let wrongWithSrc = 0, wrongTotal = 0, optBad = 0;
    let oldWrong = 0, oldWrongAi = 0;   // 旧 18 题无 meta：按指令备注应走「💡 AI 解析」按钮
    for (let i = 0; i < 20; i++) {
      await s.waitFor('!!document.querySelector("#stage .obtn")', 10000);
      const q = await curQ();
      const oi = JSON.parse(await optInfo());
      if (oi.n !== 4 || oi.u !== oi.n) {
        optBad++;
        ck('第 ' + (i + 1) + ' 题选项异常', false, 'n=' + oi.n + ' u=' + oi.u + ' | ' + q.slice(0, 24));
      }
      qs.push(q);
      await s.eval("(function(){var b=document.querySelectorAll('#stage .obtn')[0];if(b&&!b.disabled)b.click();return 1;})()");
      await s.waitFor('!!document.querySelector("#stage .fb")', 5000);
      const fbTxt = await txt('#stage .fb');
      if (/❌/.test(fbTxt)) {
        if (OLD.indexOf(q) >= 0) {
          /* 指令备注：history 旧题不带 meta，答错显示「💡 AI 解析」按钮属预期 */
          oldWrong++;
          if (/💡 AI 解析/.test(fbTxt)) oldWrongAi++;
        } else {
          wrongTotal++;
          if (/💡 解析：/.test(fbTxt) && /📚 来源：/.test(fbTxt)) wrongWithSrc++;
          else ck('答错反馈条含解析与来源（' + q.slice(0, 18) + '）', false, fbTxt.replace(/\s+/g, ' ').slice(0, 120));
        }
      }
      const st = await step(s);
      if (st === 2) break;
      if (st === 0) { ck('第 ' + (i + 1) + ' 题后能继续走题', false, q.slice(0, 24)); break; }
    }
    ck('20 题全部出现', qs.length === 20, 'got ' + qs.length);
    ck('每局选项都是 4 个且互不相同', optBad === 0, 'bad=' + optBad);
    ck('20 题内题干不重复', new Set(qs).size === qs.length, 'unique=' + new Set(qs).size + '/' + qs.length);
    const oldHit = OLD.filter(o => qs.some(q => q === o));
    const newCnt = qs.length - oldHit.length;
    ck('扩容后的新题必然出场（≥2 道非旧题）', newCnt >= 2, '新题 ' + newCnt + '/20');
    ck('旧题占比符合 18/150 的比例（≤8/20）', oldHit.length <= 8, '旧题 ' + oldHit.length + '/20：' + oldHit.join(','));
    ck('新增题答错必带解析与来源', wrongTotal > 0 && wrongWithSrc === wrongTotal, wrongWithSrc + '/' + wrongTotal);
    ck('旧题（18 道无 meta）答错走 AI 解析按钮，与本批指令一致',
      oldWrong === oldWrongAi, oldWrongAi + '/' + oldWrong);
    const hit = MARK.filter(m => qs.some(q => q.indexOf(m) >= 0));
    console.log('  · 本局命中的标志性新题：' + (hit.length ? hit.join(' / ') : '（无，属随机抽样波动）'));

    /* ---------- D. 结算页：本局错题区含来源 ---------- */
    await s.waitFor("document.querySelector('#stage').textContent.indexOf('正确率')>=0", 8000);
    const finTxt = await txt('#stage');
    ck('结算页出现本局错题区块', /本局错题（\d+ 道）/.test(finTxt), finTxt.slice(0, 60));
    await s.eval("(function(){var r=document.querySelector('#stage .rw-row');if(r)r.querySelector('.rw-q').click();return 1;})()");
    await sleep(200);
    const rwTxt = await txt('#stage .rw-row.open');
    ck('结算页错题详情含正确答案与来源', /正确答案：/.test(rwTxt) && /📚 来源：/.test(rwTxt),
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
  console.log('=== C2 历史扩容抽查：' + pass.length + '/' + (pass.length + fail.length) + ' 通过 ===');
  pass.forEach(p => console.log('  ✓ ' + p));
  fail.forEach(f => console.log('  ✗ ' + f));
  process.exit(fail.length ? 1 : 0);
})();
