// 第三批 A 学习闭环：数据层(沙箱) + UI(无头 Edge)
// 覆盖：本局错题回顾 / 只练这几题 / 全对无区块 / 导出 / 导入恢复 / 趋势 / 难度档 / 已挑战口径 / 键盘 1-4 / Enter 提交 / 配额提示
const { spawn } = require('child_process');
const path = require('path');
const { Session, sleep } = require('./cdp.cjs');
const { E, ctx, store } = require('./_sandbox.cjs');

const PORT = 8858;
const APP = process.argv[2] || ('http://127.0.0.1:' + PORT + '/quiz/');
const USE_LOCAL = !process.argv[2];
const pass = [], fail = [];
function ck(n, c, e) { (c ? pass : fail).push(n + (e ? ' :: ' + e : '')); }
function resetStore() { Object.keys(store).forEach(k => { delete store[k]; }); }

/* ---------------- 一、数据层（Node 沙箱） ---------------- */
(function dataLayer() {
  resetStore();
  store['bt_qa_stats'] = JSON.stringify({ 'b:geo:0': { n: 2, c: 1 } });
  store['bt_qa_custom'] = JSON.stringify({ '甲': [{ q: 'q1', a: 'a1' }] });

  const bk = E.buildBackup();
  ck('导出包带 app 标识', bk.app === 'ming-quiz', bk.app);
  ck('导出包含成绩与自定义题库', !!(bk.values['bt_qa_stats'] && bk.values['bt_qa_custom']));

  ck('导入：非法 JSON 被拒', E.applyBackup('{oops') === -1);
  ck('导入：非本应用备份被拒', E.applyBackup(JSON.stringify({ app: 'other', values: { 'bt_qa_x': '1' } })) === -1);
  ck('导入：空 values 被拒', E.applyBackup(JSON.stringify({ app: 'ming-quiz', values: {} })) === -1);
  ck('导入失败时原数据未动', store['bt_qa_custom'] === JSON.stringify({ '甲': [{ q: 'q1', a: 'a1' }] }));

  const res = E.applyBackup(JSON.stringify({
    app: 'ming-quiz',
    values: { 'bt_qa_custom': '{"乙":[]}', 'bt_qa_stats': '{}', evil: 'x' },
  }));
  ck('导入成功写入 2 项（忽略非 bt_qa_ 键）', !!res && res.n === 2, JSON.stringify(res));
  ck('导入后数据被覆盖', store['bt_qa_custom'] === '{"乙":[]}');
  ck('导入不写入非 bt_qa_ 前缀键', !('evil' in store));

  store['bt_qa_best'] = JSON.stringify({ 'b:geo:0': 0, 'b:geo:1': 12, 'b:history:0': -5 });
  const g = E.bestInfo('b:geo'), h = E.bestInfo('b:history'), z = E.bestInfo('b:nope');
  ck('已挑战口径：0 分也算已挑战', g.found === true && g.best === 12, JSON.stringify(g));
  ck('已挑战口径：负分保留原值', h.found === true && h.best === -5, JSON.stringify(h));
  ck('已挑战口径：没记录才是未挑战', z.found === false);

  resetStore();
  E.bumpStat('b:geo:0', true); E.bumpStat('b:geo:0', false);
  const dl = JSON.parse(store['bt_qa_daily'] || '{}');
  const today = E.dayKey(new Date());
  ck('每日统计记录做题数/正确数', dl[today] && dl[today].n === 2 && dl[today].c === 1, JSON.stringify(dl));
  const tr = E.trendDays(30);
  ck('趋势返回 30 天', tr.length === 30, 'len=' + tr.length);
  ck('趋势最后一天是今天且有数', tr[29].k === today && tr[29].n === 2 && tr[29].c === 1, JSON.stringify(tr[29]));
  ck('日期键为本地 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(today), today);

  const many = {};
  for (let i = 0; i < 45; i++) many[E.dayKey(new Date(Date.now() - i * 86400000))] = { n: 1, c: 1 };
  store['bt_qa_daily'] = JSON.stringify(many);
  E.bumpDaily(true);
  const kept = Object.keys(JSON.parse(store['bt_qa_daily'])).length;
  ck('每日统计只保留最近 30 天', kept === 30, 'kept=' + kept);

  E.setRoundWrong([{ q: 'a' }, { q: 'b' }, { q: 'c' }]);
  E.dropRoundWrong('b');
  ck('dropRoundWrong 按题干移除', E.getRoundWrong().map(x => x.q).join('') === 'ac', E.getRoundWrong().map(x => x.q).join(''));

  resetStore();
  let warns = 0; ctx.window.__quotaWarn = () => { warns++; };
  const origSet = ctx.window.localStorage.setItem;
  ctx.window.localStorage.setItem = () => { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; };
  let threw = false;
  try { E.bumpStat('b:x', true); E.bumpStat('b:x', true); } catch (e) { threw = true; }
  ck('存储写满不把异常抛给调用方', threw === false);
  ck('存储写满只提示一次', warns === 1, 'warns=' + warns);
  ctx.window.localStorage.setItem = origSet;
  delete ctx.window.__quotaWarn;
})();

/* ---------------- 二、UI（无头 Edge） ---------------- */
(async () => {
  const srv = USE_LOCAL ? spawn(process.execPath, [path.join(__dirname, 'serve.cjs'), String(PORT)], { stdio: 'ignore' }) : null;
  if (USE_LOCAL) await sleep(700);
  const s = new Session({ width: 414, height: 896, port: 9377 });
  const txt = (sel) => s.eval("(function(){var e=document.querySelector('" + sel + "');return e?e.textContent:'';})()");
  const clickText = (sel, t) => s.eval("(function(){var b=[].slice.call(document.querySelectorAll('" + sel + "')).filter(function(x){return x.textContent.indexOf('" + t + "')>=0;})[0];if(!b)return 0;b.click();return 1;})()");
  const openBook = (name) => s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#shelf .book')).filter(function(x){var n=x.querySelector('.nm');return n&&n.textContent==='" + name + "';})[0];if(!b)return 0;b.click();return 1;})()");
  const answerBy = (t) => s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .obtn')).filter(function(x){return x.textContent==='" + t + "';})[0];if(!b)return 0;b.click();return 1;})()");
  const answerNot = (t) => s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .obtn')).filter(function(x){return x.textContent!=='" + t + "';})[0];if(!b)return 0;b.click();return 1;})()");
  const Q1 = '测试题一：1+1=?', Q2 = '测试题二：天空是蓝的吗？';
  /* 自定义题库每局都会打乱题序 —— 一律按「当前题干」判定该题答案，别假设第几题是谁 */
  const curQ = () => s.eval("(function(){var e=document.querySelector('#stage .qbox');return e?e.textContent:'';})()");
  const answerCur = (right) => s.eval("(function(){var t=document.querySelector('#stage .qbox');var txt=t?t.textContent:'';"
    + "var want=(txt.indexOf('1+1')>=0)?'2':((txt.indexOf('天空是蓝的')>=0)?'是':'');"
    + "var pick=[].slice.call(document.querySelectorAll('#stage .obtn')).filter(function(b){return "
    + (right ? "b.textContent===want" : "b.textContent!==want") + ";})[0];"
    + "if(!pick)return 'NO:'+txt.slice(0,24);pick.click();return 'OK:'+pick.textContent;})()");
  try {
    await s.open(APP);
    await s.eval("localStorage.setItem('bt_qa_quickjump','true');1");
    await s.waitFor('!!document.querySelector(".book")', 15000);
    await s.eval("navigator.serviceWorker.getRegistrations().then(function(rs){return Promise.all(rs.map(function(r){return r.unregister();}));}).then(function(){return caches.keys();}).then(function(ks){return Promise.all(ks.map(function(k){return caches.delete(k);}));}).then(function(){return 1;})");
    await s.eval("(function(){localStorage.setItem('bt_qa_custom',JSON.stringify({'A批测试':["
      + "{q:'" + Q1 + "',a:'2',opts:['2','3','4','5']},"
      + "{q:'" + Q2 + "',a:'是',opts:['是','否','不确定','都不是']}]}));"
      + "['bt_qa_stats','bt_qa_best','bt_qa_daily','bt_qa_weak','bt_qa_extra','bt_qa_ai','bt_qa_online'].forEach(function(k){localStorage.removeItem(k);});return 1;})()");
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);

    /* ---------- A. 错 1 对 1 → 结算页错题区 ---------- */
    ck('自定义题库进入答题', (await openBook('A批测试')) === 1);
    await s.waitFor('document.querySelectorAll("#stage .obtn").length>=2', 9000);
    ck('选择题选项带键盘角标 data-k', (await s.eval("document.querySelectorAll('#stage .obtn[data-k]').length")) >= 2);
    const q1txt = await curQ();
    ck('第 1 题答错', /^OK:/.test(await answerCur(false)), (await curQ()).slice(0, 24));
    await s.waitFor('!!document.querySelector("#stage .fb")', 6000);
    await clickText('#stage .fbnext', '下一题');
    const waitOtherQ = (prev) => s.waitFor("(function(){var e=document.querySelector('#stage .qbox');return !!(e&&e.textContent&&e.textContent!==" + JSON.stringify(prev) + "&&document.querySelectorAll('#stage .obtn').length>=2);})()", 8000);
    ck('点下一题切到第 2 题', await waitOtherQ(q1txt));
    ck('第 2 题答对', /^OK:/.test(await answerCur(true)));
    await s.waitFor('!!document.querySelector("#stage .rw-row")', 9000);
    const ft = await txt('#stage');
    ck('结算页出现「本局错题（1 道）」', /本局错题（1 道）/.test(ft), ft.slice(0, 80));
    ck('错题行显示你的答案', /你的答案：/.test(ft) && !/你的答案：—/.test(ft));
    ck('错题行显示正确答案', /正确答案：/.test(ft));
    ck('错题行数 = 1', (await s.eval("document.querySelectorAll('#stage .rw-row').length")) === 1);
    await s.eval("document.querySelector('#stage .rw-q').click()");
    ck('点题干可展开详情', (await s.eval("document.querySelector('#stage .rw-row').classList.contains('open')")) === true);
    ck('提供「只练这 1 题」', /只练这 1 题/.test(ft), ft.slice(-60));

    /* ---------- B. 只练这几题 ---------- */
    await clickText('#stage .btn', '只练这');
    await s.waitFor('!!document.querySelector("#stage .obtn")', 8000);
    const rt = await txt('#stage');
    ck('只练进入回顾局（标题/题量）', /重练本局错题/.test(rt) && /1\s*\/\s*1/.test(rt), rt.slice(0, 80));
    ck('只练这题答对', /^OK:/.test(await answerCur(true)));
    /* ⚠ 不能用 document.body.textContent：内联脚本的源码也在 body 里，源码里本来就有「本轮掌握」 */
    await s.waitFor("document.querySelector('#stage').textContent.indexOf('本轮掌握')>=0", 9000);
    const rf = await txt('#stage');
    ck('回顾结算显示「本轮掌握 1 题」', /本轮掌握 1 题/.test(rf), rf.slice(0, 80));
    ck('回顾结算不再显示本局错题区块', (await s.eval("document.querySelectorAll('#stage .rw-row').length")) === 0);

    /* ---------- C. 全对局不显示错题区块（同时验证 roundWrong 已重置） ---------- */
    await clickText('#stage .btn', '返回书架');
    await sleep(400);
    await openBook('A批测试');
    await s.waitFor('document.querySelectorAll("#stage .obtn").length>=2', 9000);
    const c1 = await curQ();
    ck('全对局第 1 题答对', /^OK:/.test(await answerCur(true)));
    ck('全对局切到第 2 题', await waitOtherQ(c1));
    await sleep(200);
    ck('全对局第 2 题答对', /^OK:/.test(await answerCur(true)));
    await s.waitFor('document.querySelector("#stage").textContent.indexOf("正确率")>=0', 9000);
    ck('全对局不显示错题区块', (await s.eval("document.querySelectorAll('#stage .rw-row').length")) === 0
      && !/本局错题/.test(await txt('#stage')));

    /* ---------- D. 导出（拦截 Blob 与下载点击） ---------- */
    await s.eval("document.getElementById('statsBtn').click()");
    await s.waitFor('!!document.querySelector("#curOverlay")', 6000);
    await s.eval("window.__cap=null;window.__aClick=0;window.__B0=window.Blob;"
      + "window.Blob=function(p,o){try{window.__cap=String(p&&p[0]);}catch(e){}return new window.__B0(p,o);};"
      + "var pr=HTMLAnchorElement.prototype;if(!pr.__stub){pr.__stub=1;var oc=pr.click;pr.click=function(){if(this.download){window.__aClick++;return;}return oc.apply(this,arguments);};}1");
    await clickText('#curOverlay .btn', '导出数据');
    await sleep(500);
    const cap = await s.eval("window.__cap||''");
    ck('导出生成 JSON 备份并触发下载', (await s.eval("window.__aClick")) === 1 && cap.length > 20, 'bytes=' + cap.length);
    ck('备份含 app 标识与成绩/题库键', /"app": ?"ming-quiz"/.test(cap) && /"bt_qa_stats"/.test(cap) && /"bt_qa_custom"/.test(cap));
    ck('导出有 toast 反馈', /已导出备份/.test(await txt('#toast')), await txt('#toast'));

    /* ---------- E. 统计页：趋势 / 难度档 / 已挑战口径 ---------- */
    await s.eval("(function(){var e=document.querySelector('#curOverlay .close');if(!e)return 0;e.click();return 1;})()");
    await s.eval("localStorage.setItem('bt_qa_best',JSON.stringify({'b:geo:0':0,'b:history:0':-5}));1");
    await s.eval("document.getElementById('statsBtn').click()");
    await s.waitFor('!!document.querySelector("#curOverlay .trend")', 6000);
    ck('统计页有 30 天趋势条', (await s.eval("document.querySelectorAll('#curOverlay .trend .tcol').length")) === 30);
    ck('趋势有当日柱（刚做过题）', (await s.eval("document.querySelectorAll('#curOverlay .trend .tbar.ok,#curOverlay .trend .tbar.bad').length")) > 0);
    const cardBig = (name) => s.eval("(function(){var cs=[].slice.call(document.querySelectorAll('#curOverlay .stat-card')).filter(function(c){var t=c.querySelector('.t');return t&&t.textContent.indexOf('" + name + "')>=0;});"
      + "var c=cs[0];if(!c)return '';var b=c.querySelector('.big');var subs=[].slice.call(c.querySelectorAll('.sub'));return (b?b.textContent:'')+'|'+(subs.length?subs[subs.length-1].textContent:'');})()");
    const geoCard = await cardBig('地理'), histCard = await cardBig('历史');
    ck('0 分也显示 ⭐ 0（不再未挑战）', /^⭐ 0\|/.test(geoCard), geoCard);
    ck('负分保留原值 ⭐ -5', /^⭐ -5\|/.test(histCard), histCard);
    ck('分类卡显示当前难度档位', /难度\s*.+/.test(geoCard.split('|')[1] || ''), geoCard);
    const ovTxt = await txt('#curOverlay');
    ck('底部文案写明「出现即代表已挑战」', /出现即代表已挑战/.test(ovTxt));

    /* ---------- F. 键盘 1-4 ---------- */
    await s.eval("(function(){var e=document.querySelector('#curOverlay .close');if(!e)return 0;e.click();return 1;})()");
    await openBook('A批测试');
    await s.waitFor('document.querySelectorAll("#stage .obtn").length>=2', 9000);
    await s.eval("document.dispatchEvent(new KeyboardEvent('keydown',{key:'2',bubbles:true}));1");
    await s.waitFor('!!document.querySelector("#stage .fb")', 5000);
    const kb = JSON.parse(await s.eval("(function(){var b=document.querySelectorAll('#stage .obtn');return JSON.stringify({mark:b.length>1&&(b[1].classList.contains('right')||b[1].classList.contains('wrong')),fb:!!document.querySelector('#stage .fb')});})()"));
    ck('按 2 选中第 2 个选项并判分', kb.fb === true && kb.mark === true, JSON.stringify(kb));

    await s.eval("document.getElementById('backBtn').click()");
    await sleep(500);
    await s.eval("document.dispatchEvent(new KeyboardEvent('keydown',{key:'1',bubbles:true}));1");
    await sleep(300);
    const shelfSafe = await s.eval("(function(){return JSON.stringify({shelf:!document.getElementById('shelf').hidden,stage:document.getElementById('stage').hidden});})()");
    ck('书架按数字键无副作用', JSON.parse(shelfSafe).shelf === true && JSON.parse(shelfSafe).stage === true, shelfSafe);

    /* ---------- G. Enter 提交（填空题） ----------
       板块/难度面板是 overlayPanel 渲染的，挂在 #curOverlay 而不是 #stage；
       且 .secbtn 自带 diffbtn class，所以「面板切换成功」要靠 .secbtn 消失来判断。 */
    ck('书架点分类（地理）', (await openBook('地理')) === 1);
    const hasSec = await s.waitFor('!!document.querySelector("#curOverlay .secbtn")', 9000);
    ck('弹出板块面板', hasSec, (await txt('#curOverlay')).slice(0, 60));
    if (hasSec) {
      await clickText('#curOverlay .secbtn', '填空题');
      await s.waitFor('!document.querySelector("#curOverlay .secbtn")', 6000);
    }
    const hasDiff = await s.waitFor('!!document.querySelector("#curOverlay .diffbtn")', 9000);
    ck('选完板块进难度面板', hasDiff, (await txt('#curOverlay')).slice(0, 60));
    if (hasDiff) {
      await clickText('#curOverlay .diffbtn', '简单');
      await clickText('#curOverlay .btn', '开始出题');
    }
    const hasInput = await s.waitFor('!!document.querySelector("#stage input[type=text]")', 9000);
    ck('填空题出现输入框', hasInput);
    ck('填空题不渲染选项', (await s.eval("document.querySelectorAll('#stage .obtn').length")) === 0);
    if (hasInput) {
      await s.eval("(function(){var ti=document.querySelector('#stage input[type=text]');if(!ti)return 0;"
        + "ti.value='肯定不对的答案';document.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return 1;})()");
      await s.waitFor('!!document.querySelector("#stage .fb")', 6000);
    }
    ck('填空输入框 Enter 提交', !!(await s.eval("!!document.querySelector('#stage .fb')")));

    /* ---------- H. 导入恢复（DataTransfer 造文件） ---------- */
    await s.eval("document.getElementById('backBtn').click()");
    await sleep(400);
    await s.eval("localStorage.removeItem('bt_qa_custom');1");
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);
    ck('清空后书架无自定义题库', (await s.eval("document.querySelectorAll('#shelf .book').length")) > 0
      && (await s.eval("[].slice.call(document.querySelectorAll('#shelf .book .nm')).filter(function(n){return n.textContent==='A批测试';}).length")) === 0);
    await s.eval("document.getElementById('statsBtn').click()");
    await s.waitFor('!!document.querySelector("#curOverlay")', 6000);
    await s.eval("window.__fi=0;var pr=HTMLInputElement.prototype;if(!pr.__stub){pr.__stub=1;var oc=pr.click;pr.click=function(){if(this.type==='file'){window.__fi=this;return;}return oc.apply(this,arguments);};}1");
    await clickText('#curOverlay .btn', '导入备份');
    await sleep(300);
    ck('导入按钮打开文件选择器', (await s.eval("!!window.__fi")) === true);
    const injected = await s.eval("(function(){try{var inp=window.__fi;var dt=new DataTransfer();"
      + "dt.items.add(new File([" + JSON.stringify(cap) + "],'b.json',{type:'application/json'}));"
      + "inp.files=dt.files;inp.dispatchEvent(new Event('change'));return 1;}catch(e){return 'ERR:'+e.message;}})()");
    ck('导入文件已送入 input', injected === 1, String(injected));
    let restored = '';
    for (let i = 0; i < 30; i++) {
      restored = await s.eval("localStorage.getItem('bt_qa_custom')||''");
      if (restored.indexOf('A批测试') >= 0) break;
      await sleep(200);
    }
    ck('导入后自定义题库恢复', restored.indexOf('A批测试') >= 0, restored.slice(0, 60));
    ck('导入有成功 toast', /已导入/.test(await txt('#toast')), await txt('#toast'));
    await s.eval("(function(){var e=document.querySelector('#curOverlay .close');if(!e)return 0;e.click();return 1;})()");
    await sleep(400);
    ck('导入后书架重新出现该题库', (await s.eval("[].slice.call(document.querySelectorAll('#shelf .book .nm')).filter(function(n){return n.textContent==='A批测试';}).length")) === 1);

    ck('运行期无 JS 异常', s.errors.length === 0, s.errors.slice(0, 2).join(' | '));
  } catch (e) {
    fail.push('运行异常 :: ' + (e && e.message));
  } finally {
    try { await s.close(); } catch (e) {}
    if (srv) srv.kill();
  }
  console.log('=== A 批（学习闭环）探针：' + pass.length + '/' + (pass.length + fail.length) + ' 通过 ===');
  pass.forEach(p => console.log('  ✓ ' + p));
  fail.forEach(f => console.log('  ✗ ' + f));
  process.exit(fail.length ? 1 : 0);
})();
