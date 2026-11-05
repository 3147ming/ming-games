// B 批：SRS 间隔复习 + 知识卡先学后练（无头 Edge + CDP）
const { Session } = require('./cdp.cjs');

const URL = process.argv[2] || 'file:///D:/Projects/_github_pages/ming-games/quiz/index.html';
const pass = [], fail = [];
function ck(n, c, e) { (c ? pass : fail).push(n + (e ? ' :: ' + e : '')); }

const now = Date.now();
// 4 条种子：A/B 待复习lv0、C 待掌握lv5、O 旧格式（无 srs）。O 不应计入待复习，但应被自愈写回 srs。
const seeds = [
  { n: 1, t: now - 3000, type: 'b:science', diff: 0, q: 'SRS_A_升档测试题', a: 'ansA', opts: ['ansA', 'w1', 'w2', 'w3'], srs: { lv: 0, due: now - 1000 } },
  { n: 1, t: now - 2000, type: 'b:science', diff: 0, q: 'SRS_B_重置测试题', a: 'ansB', opts: ['ansB', 'x1', 'x2', 'x3'], srs: { lv: 0, due: now - 1000 } },
  { n: 1, t: now - 1000, type: 'b:science', diff: 0, q: 'SRS_C_移除测试题', a: 'ansC', opts: ['ansC', 'y1', 'y2', 'y3'], srs: { lv: 5, due: now - 1000 } },
  { n: 1, t: now - 9000, type: 'b:science', diff: 0, q: 'OLD_NO_SRS_旧格式题', a: 'ansO', opts: ['ansO', 'z1', 'z2', 'z3'] }
];

(async () => {
  const s = new Session({ width: 414, height: 896, port: 9385 });
  try {
    await s.open(URL);
    await s.eval("localStorage.setItem('bt_qa_quickjump','true');1");
    await s.waitFor("!!document.querySelector('.book')", 15000);
    ck('页面加载无 page error', (s.errors || []).length === 0, (s.errors || []).slice(0, 2).join(' | '));

    // ===== 阶段1：SRS 数据层 + 复习局 =====
    const seedLiteral = JSON.stringify(seeds);
    await s.eval("localStorage.setItem('bt_qa_weak', JSON.stringify(" + seedLiteral + "))");
    await s.eval("localStorage.setItem('bt_qa_learn_before','false')");
    await s.reload();
    await s.waitFor("!!document.querySelector('.book')", 15000);
    ck('重载后无 page error', (s.errors || []).length === 0, (s.errors || []).slice(0, 2).join(' | '));

    // 待复习计数 = 3（A/B/C 到期；O 无 srs 不计）
    const dueTxt = await s.eval("(function(){return [].slice.call(document.querySelectorAll('.act')).map(function(x){return x.textContent;}).join(' | ');})()");
    ck('书架「⏰ 待复习 · 3」显示', /⏰ 待复习 · 3/.test(dueTxt), dueTxt);

    // 点「⏰ 待复习」进入 SRS 复习局
    const started = await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('.act')).filter(function(x){return x.textContent.indexOf('⏰ 待复习')>=0;})[0];if(!b)return 0;b.click();return 1;})()");
    ck('点「⏰ 待复习」进入复习局', started === 1);
    const revStarted = await s.waitFor("!!document.querySelector('#stage .qbox')", 8000);
    ck('SRS 复习局出题', revStarted === true);

    let sawNext = false, sawTomorrow = false, sawMastered = false;
    for (let i = 0; i < 8; i++) {
      const ended = await s.eval("!!([].slice.call(document.querySelectorAll('button')).filter(function(x){return /再来一局/.test(x.textContent);})[0])");
      if (ended) break;
      await s.waitFor("!!document.querySelector('#stage .qbox')", 8000);
      const stem = await s.eval("(document.querySelector('#stage .qbox')||{}).textContent||''");
      let target = /SRS_A/.test(stem) ? 'A' : (/SRS_B/.test(stem) ? 'B' : (/SRS_C/.test(stem) ? 'C' : null));
      if (!target) { await s.wait(400); continue; }
      const corr = { A: 'ansA', B: 'ansB', C: 'ansC' }[target];
      await s.eval("(function(){var btns=[].slice.call(document.querySelectorAll('#stage .obtn'));var corr='" + corr + "';var b=btns.filter(function(x){return x.textContent===corr;})[0];if('" + target + "'==='B'){b=btns.filter(function(x){return x.textContent!==corr&&!x.disabled;})[0];}if(b)b.click();})()");
      await s.wait(700);
      const fb = await s.eval("(document.querySelector('.fb')||{}).textContent||''");
      if (target === 'A') { if (/下次复习/.test(fb)) sawNext = true; }
      if (target === 'B') { if (/明天再复习/.test(fb)) sawTomorrow = true; }
      if (target === 'C') { if (/已掌握/.test(fb)) sawMastered = true; }
      if (target === 'B') {
        await s.eval("var b=document.querySelector('.fbnext');if(b)b.click();");
        await s.wait(500);
      } else {
        await s.wait(1000); // 答对自动跳
      }
    }
    ck('SRS 答对 → 反馈含「下次复习 X 天后」', sawNext === true);
    ck('SRS 答错 → 反馈含「明天再复习一次」', sawTomorrow === true);
    ck('SRS 30天档答对 → 「已掌握并移出复习队列」', sawMastered === true);

    // 读回 localStorage 校验 srs 状态
    const store = JSON.parse(await s.eval("localStorage.getItem('bt_qa_weak')") || '[]');
    const A = store.find(x => x.q && x.q.indexOf('SRS_A') >= 0);
    const B = store.find(x => x.q && x.q.indexOf('SRS_B') >= 0);
    const C = store.find(x => x.q && x.q.indexOf('SRS_C') >= 0);
    const O = store.find(x => x.q && x.q.indexOf('OLD_NO_SRS') >= 0);
    ck('SRS_A 答对后 lv 升到 1', !!(A && A.srs && A.srs.lv === 1), A ? ('lv=' + A.srs.lv) : '缺失');
    ck('SRS_B 答错后 lv 重置为 0 且 due 已推到未来', !!(B && B.srs && B.srs.lv === 0 && B.srs.due > Date.now()), B ? ('lv=' + B.srs.lv + ' due<' + (Date.now() - B.srs.due)) : '缺失');
    ck('SRS_C 掌握后已从薄弱题移除', !C);
    ck('旧格式条目（无 srs）被自愈并写回 srs 字段', !!(O && O.srs && typeof O.srs.lv === 'number'), O ? ('srs=' + JSON.stringify(O.srs)) : '缺失');

    // ===== 阶段2：知识卡先学后练 =====
    await s.eval("localStorage.clear()");
    await s.eval("localStorage.setItem('bt_qa_learn_before','true')");
    await s.reload();
    await s.waitFor("!!document.querySelector('.book')", 15000);

    // 进科学 → 选择题板块
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('.book')).filter(function(x){return x.textContent.indexOf('科学')>=0;})[0];if(b)b.click();})()");
    await s.wait(500);
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('.secbtn')).filter(function(x){return x.textContent.indexOf('选择题')>=0;})[0];if(b)b.click();})()");
    await s.wait(600);
    // 难度面板应出现 📖 先学后练开关
    const toggle = await s.eval("!!document.querySelector('#curOverlay') && document.querySelector('#curOverlay').textContent.indexOf('（开局先看知识卡）')>=0");
    ck('难度面板含「📖 先学后练」开关', toggle === true);
    // 点「开始出题」→ 应弹知识卡覆盖层（而非直接进题）
    await s.eval("(function(){var g=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return x.textContent.indexOf('开始出题')>=0;})[0];if(g)g.click();})()");
    await s.wait(500);
    const cardShown = await s.eval("(function(){var o=document.querySelector('#curOverlay');var q=document.querySelector('#stage .qbox');return !!o && o.textContent.indexOf('先学后练')>=0 && !q;})()");
    ck('开启开关 → 开局先弹知识卡（题未出现）', cardShown === true);
    // 点「跳过知识卡，直接开始」→ 进题
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return x.textContent.indexOf('跳过知识卡')>=0;})[0];if(b)b.click();})()");
    await s.wait(600);
    const qAfterSkip = await s.eval("!!document.querySelector('#stage .qbox')");
    ck('点「跳过」后进入答题', qAfterSkip === true);

    ck('全程无 page error', (s.errors || []).length === 0, (s.errors || []).slice(0, 3).join(' | '));
  } catch (e) {
    fail.push('异常 :: ' + e.message);
  } finally {
    try { await s.close(); } catch (e) {}
  }
  console.log('\n=== B 批探针结果：' + pass.length + '/' + (pass.length + fail.length) + ' 通过 ===');
  pass.forEach(p => console.log('  ✓ ' + p));
  fail.forEach(f => console.log('  ✗ ' + f));
  if (fail.length) { console.log('FAILED'); process.exit(1); }
  console.log('OK');
})();
