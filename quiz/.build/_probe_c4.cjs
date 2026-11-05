// C4 英语扩容功能抽查（无头 Edge + CDP）：题量来源 / 选项唯一 / 解析与来源 / 从扩容池抽题
const path = require('path');
const { Session, sleep } = require('./cdp.cjs');

const URL = process.argv[2] || 'file:///D:/Projects/_github_pages/ming-games/quiz/index.html';
const pass = [], fail = [];
function ck(n, c, e) { (c ? pass : fail).push(n + (e ? ' :: ' + e : '')); }

// 14 道旧英语题题干（精确，含引号，与显示值一致）；凡不在其中的题干即来自扩容后的新题
const OLD_STEMS = ['"苹果"的英文是？', '"书"的英文是？', '"水"的英文是？', '"太阳"的英文是？',
  '"朋友"的英文是？', '"城市"的英文是？', '"红色"的英文是？', '"学校"的英文是？',
  '"快乐"的英文是？', '"时间"的英文是？', '"电脑"的英文是？', '"猫"的英文是？',
  '"爱"的英文是？', '"天空"的英文是？'];
function isNewStem(q) { return OLD_STEMS.indexOf((q || '').trim()) < 0; }

(async () => {
  const s = new Session({ width: 414, height: 896, port: 9384 });
  try {
    await s.open(URL);
    await s.eval("localStorage.setItem('bt_qa_quickjump','true');1");
    await s.waitFor('!!document.querySelector(".book")', 15000);
    ck('页面加载无 page error', (s.errors || []).length === 0, (s.errors || []).slice(0, 2).join(' | '));

    // 书架里存在「英语」书
    const hasEng = await s.eval("(function(){return [].slice.call(document.querySelectorAll('.book')).some(function(x){return x.textContent.indexOf('英语')>=0;});})()");
    ck('书架有「英语」书', hasEng === true);

    // 进英语 → 选择题 → 简单
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('.book')).filter(function(x){return x.textContent.indexOf('英语')>=0;})[0];b.click();return 1;})()");
    await s.wait(300);
    const secClicked = await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('.secbtn')).filter(function(x){return x.textContent.indexOf('选择题')>=0;})[0];if(!b)return 0;b.click();return 1;})()");
    ck('英语分类有「选择题」板块', secClicked === 1);
    await s.wait(300);
    // 点 🟢 简单（注意 [0] 是「🤖 自动匹配」无限模式，不能选）
    const diffClicked = await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('.diffbtn')).filter(function(x){return x.textContent.indexOf('简单')>=0;})[0];if(!b)return 0;b.click();return 1;})()");
    ck('选「简单」难度档', diffClicked === 1);
    await s.wait(300);
    const started = await s.eval("(function(){var g=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return x.textContent.indexOf('开始出题')>=0;})[0];if(!g)return 0;g.click();return 1;})()");
    ck('点「开始出题」进入答题', started === 1);
    await s.wait(500);

    let sawWrongMeta = false, sawNew = false, optBad = false, sawEnd = false;
    const stems = [];
    let prev = '', sameRun = 0;
    for (let i = 0; i < 30; i++) {
      // 检测结算/再来一局
      const ended = await s.eval("!!([].slice.call(document.querySelectorAll('button')).filter(function(x){return /再来一局/.test(x.textContent);})[0])");
      if (ended) { sawEnd = true; break; }
      const q = await s.eval("(function(){var e=document.querySelector('#stage .qbox');return e?e.textContent:'';})()");
      if (!q) { await s.wait(400); continue; }
      if (q === prev) sameRun++; else sameRun = 0;
      prev = q;
      stems.push(q);
      if (isNewStem(q)) sawNew = true;
      // 选项唯一 + 4 个
      const optInfo = await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .obtn')).map(function(x){return x.textContent;});return JSON.stringify({n:b.length,u:new Set(b).size});})()");
      const oi = JSON.parse(optInfo);
      if (oi.n !== 4 || oi.u !== 4) optBad = true;
      // 点第一个启用选项
      await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .obtn')).filter(function(x){return !x.disabled;})[0];if(b)b.click();})()");
      await s.wait(700);
      // 是否答错：存在 .fbnext 即停住（答错/不会）
      const wrong = await s.eval("!!document.querySelector('.fbnext')");
      if (wrong) {
        const fb = await s.eval("(function(){var e=document.querySelector('.fb');return e?e.textContent:'';})()");
        if (/解析/.test(fb) && /来源/.test(fb)) sawWrongMeta = true;
        // 进入下一题
        await s.eval("var b=document.querySelector('.fbnext');if(b)b.click();");
        await s.wait(500);
      } else {
        // 答对，等自动跳
        await s.wait(900);
      }
      if (sameRun >= 3) { console.log('⚠ 疑似卡在同一题（连续 3 次相同题干），中断'); break; }
    }
    ck('选项始终 4 个且互不重复', optBad === false);
    ck('从扩容后英语池抽到新题（标志词命中）', sawNew === true, 'seen=' + stems.length);
    ck('答错反馈含「解析」+「来源」', sawWrongMeta === true);
    ck('完成一局（出现结算页）', sawEnd === true);

    console.log('--- 抽到的题干样例（前 8）---');
    stems.slice(0, 8).forEach(function (t) { console.log('   ' + t.slice(0, 28)); });
  } catch (e) {
    fail.push('异常 :: ' + e.message);
  } finally {
    try { await s.close(); } catch (e) {}
  }
  console.log('\n=== C4 英语探针结果：' + pass.length + '/' + (pass.length + fail.length) + ' 通过 ===');
  pass.forEach(function (p) { console.log('  ✓ ' + p); });
  fail.forEach(function (f) { console.log('  ✗ ' + f); });
  if (fail.length) { console.log('FAILED'); process.exit(1); }
  console.log('OK');
})();
