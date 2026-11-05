// 出题质量专项：免费素材去噪 / 干扰项同质化 / 自定义题库去重 / AI prompt
const { spawn } = require('child_process');
const path = require('path');
const { Session, sleep } = require('./cdp.cjs');
const { step } = require('./pace.cjs');

const PORT = 8858;
const APP = process.argv[2] || ('http://127.0.0.1:' + PORT + '/quiz/');
const USE_LOCAL = !process.argv[2];
const pass = [], fail = [];
function ck(n, c, e) { (c ? pass : fail).push(n + (e ? ' :: ' + e : '')); }
const JUNK = /Android|安卓|iOS|吴彦祖|虚幻引擎|视频|影院|金币|香烟|下载/;

(async () => {
  const srv = USE_LOCAL ? spawn(process.execPath, [path.join(__dirname, 'serve.cjs'), String(PORT)], { stdio: 'ignore' }) : null;
  if (USE_LOCAL) await sleep(700);
  const s = new Session({ width: 414, height: 896, port: 9374 });
  try {
    await s.open(APP);
    await s.eval("localStorage.setItem('bt_qa_quickjump','true');1");
    await s.waitFor('!!document.querySelector(".book")', 15000);
    await s.eval("navigator.serviceWorker.getRegistrations().then(function(rs){return Promise.all(rs.map(function(r){return r.unregister();}));}).then(function(){return caches.keys();}).then(function(ks){return Promise.all(ks.map(function(k){return caches.delete(k);}));}).then(function(){return 1;})");
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);

    // ---------- A. 免费通道：三角洲 去噪 ----------
    await s.eval("(function(){var a=[].slice.call(document.querySelectorAll('.act')).filter(function(x){return x.textContent.indexOf('新建')>=0;})[0];a.click();return 1;})()");
    await sleep(300);
    await s.eval("(function(){var i=document.querySelector('#curOverlay input');i.value='三角洲';return 1;})()");
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return x.textContent.indexOf('免费搜索')>=0;})[0];b.click();return 1;})()");
    let rows = [];
    for (let i = 0; i < 24; i++) {
      await sleep(2000);
      rows = JSON.parse(await s.eval("JSON.stringify([].slice.call(document.querySelectorAll('#stage .list-row')).map(function(r){return r.textContent.replace(/\\s+/g,' ');}))"));
      if (rows.length) break;
      const t = await s.eval("document.getElementById('stage').textContent||''");
      if (/资料不足|抓不到|凑不出/.test(t)) break;
    }
    const hud = await s.eval("(document.querySelector('#stage .hud')||{}).textContent||''");
    ck('三角洲免费生成 ≥3 题', rows.length >= 3, 'rows=' + rows.length + ' | ' + hud);
    const junkHits = rows.filter(r => JUNK.test(r));
    ck('免费题目不含 Android/iOS/吴彦祖 等无关实体', junkHits.length === 0, junkHits.slice(0, 2).join(' | '));
    const related = rows.filter(r => /三角洲|蜂医|特种部队|零号大坝|长弓溪谷/.test(r)).length;
    ck('免费题目全部与主题相关', related === rows.length && rows.length > 0, related + '/' + rows.length);

    // 入库后看真实选项是否同主题
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return x.textContent.indexOf('入库并开始')>=0;})[0];if(b)b.click();return 1;})()");
    await sleep(600);
    let opts = [];
    for (let i = 0; i < 3; i++) {
      const o = JSON.parse(await s.eval("JSON.stringify([].slice.call(document.querySelectorAll('#stage .obtn')).map(function(b){return b.textContent;}))"));
      if (o.length >= 4) opts.push(o);
      await s.eval("(function(){var u=[].slice.call(document.querySelectorAll('#stage .unkbtn'))[0];if(u)u.click();return 1;})()");
      await sleep(220);
      await step(s);
      if (await s.eval("!!([].slice.call(document.querySelectorAll('#stage button')).filter(function(x){return /再来一局/.test(x.textContent);})[0])")) break;
    }
    const flat = [].concat.apply([], opts);
    ck('入库后选项数=4 且无跨类噪音', opts.length > 0 && opts.every(o => o.length === 4) && !JUNK.test(flat.join('|')), flat.slice(0, 6).join(' / '));

    // ---------- B. 自定义题库两局去重 ----------
    const bank = [];
    for (let i = 0; i < 20; i++) bank.push({ q: '测试题' + i + '：' + (i % 3 === 0 ? '甲' : (i % 3 === 1 ? '乙' : '丙')) + '项？', a: 'A' + i, opts: ['A' + i, 'B' + i, 'C' + i, 'D' + i] });
    await s.eval(`localStorage.setItem('bt_qa_custom', JSON.stringify({考题库: ${JSON.stringify(bank)}}));1`);
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);

    async function playRound() {
      await s.eval("(function(){var bs=document.querySelectorAll('.book');for(var i=0;i<bs.length;i++){if(bs[i].textContent.indexOf('考题库')>=0){bs[i].click();return 1;}}return 0;})()");
      await s.waitFor(`!!document.querySelector('#stage .obtn') || !!document.querySelector('#stage .unkbtn')`, 8000);
      const qs = [];
      for (let i = 0; i < 10; i++) {
        const q = await s.eval("(document.querySelector('#stage .qbox')||{}).textContent||''");
        if (q) qs.push(q);
        await s.eval("(function(){var u=document.querySelector('#stage .unkbtn');if(u)u.click();return 1;})()");
        await sleep(220);
        await step(s);
      }
      await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /返回书架/.test(x.textContent);})[0];if(b)b.click();return 1;})()");
      await sleep(400);
      return qs;
    }
    const r1 = await playRound();
    const r2 = await playRound();
    const dup = r2.filter(q => r1.indexOf(q) >= 0).length;
    ck('两局题目重复率 ≤30%', r1.length === 10 && r2.length === 10 && dup / 10 <= 0.3, 'dup=' + dup + '/10');
    const rec = await s.eval("localStorage.getItem('bt_qa_recent_c:考题库')");
    ck('最近出题记录写入 bt_qa_recent_<typeKey>', !!rec && JSON.parse(rec).length > 0 && JSON.parse(rec).length <= 15, String(rec).slice(0, 60));

    // ---------- C. AI prompt ----------
    await s.eval(`localStorage.setItem('bt_qa_ai', JSON.stringify({url:'https://api.deepseek.com/v1/chat/completions',key:'sk-test',model:'deepseek-chat',proxy:''}));1`);
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);
    await s.eval(`(function(){
      window.__aiPrompt=null;window.__realFetch=window.fetch;
      window.fetch=function(u,o){
        if(o&&String(o.method||'').toUpperCase()==='POST'){
          window.__aiPrompt=(o&&o.body)||'';
          var arr=[];
          for(var i=0;i<10;i++)arr.push({q:'AI题'+i,a:'干员'+i,opts:['干员'+i,'干员'+(i+1),'干员'+(i+2),'干员'+(i+3)],exp:'解析：干员编号对应 '+i,src:'测试来源'});
          return Promise.resolve({json:function(){return Promise.resolve({choices:[{message:{content:JSON.stringify(arr)}}]});}});
        }
        return window.__realFetch.apply(window,arguments);
      };
      return 1;})()`);
    await s.eval("(function(){var a=[].slice.call(document.querySelectorAll('.act')).filter(function(x){return x.textContent.indexOf('新建')>=0;})[0];a.click();return 1;})()");
    await sleep(300);
    await s.eval("(function(){var i=document.querySelector('#curOverlay input');i.value='三角洲';return 1;})()");
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return x.textContent.indexOf('AI 生成')>=0;})[0];b.click();return 1;})()");
    let aiRows = 0;
    for (let i = 0; i < 20; i++) {
      await sleep(1500);
      aiRows = await s.eval("document.querySelectorAll('#stage .list-row').length");
      if (aiRows) break;
      const t = await s.eval("document.getElementById('stage').textContent||''");
      if (/未返回有效题目|抓不到/.test(t)) break;
    }
    const pr = await s.eval("window.__aiPrompt||''");
    ck('付费 AI prompt 要求 30 道（不少于 27 道）', /30 道/.test(pr) && /27 道/.test(pr), pr.slice(0, 80));
    ck('AI prompt 是「命题老师」角色并要求全部简体中文', /命题老师/.test(pr) && /全部简体中文/.test(pr), '');
    ck('AI prompt 严禁百科词条/书目元信息题', /严禁出的题/.test(pr) && /补全词条/.test(pr) && /出版社/.test(pr), '');
    ck('AI prompt 仍禁止政治/色情/暴力/违法', /政治敏感/.test(pr) && /色情/.test(pr) && /暴力/.test(pr) && /违法/.test(pr), '');
    ck('AI 通道返回题目可预览入库', aiRows === 10, 'rows=' + aiRows);

    // ---------- D. 免费通道（Pollinations）：15 道 + reasoning_effort=low ----------
    await s.eval(`localStorage.setItem('bt_qa_ai', JSON.stringify({url:'https://text.pollinations.ai/openai',key:'',model:'openai',proxy:''}));1`);
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);
    await s.eval(`(function(){
      window.__aiPrompt=null;window.__realFetch=window.fetch;
      window.fetch=function(u,o){
        if(o&&String(o.method||'').toUpperCase()==='POST'){
          window.__aiPrompt=(o&&o.body)||'';
          var arr=[];
          for(var i=0;i<10;i++)arr.push({q:'免费AI题'+i,a:'选项'+i,opts:['选项'+i,'选项'+(i+1),'选项'+(i+2),'选项'+(i+3)],exp:'解析'+i,src:'来源'});
          return Promise.resolve({json:function(){return Promise.resolve({choices:[{message:{content:JSON.stringify(arr)}}]});}});
        }
        return window.__realFetch.apply(window,arguments);
      };
      return 1;})()`);
    await s.eval("(function(){var a=[].slice.call(document.querySelectorAll('.act')).filter(function(x){return x.textContent.indexOf('新建')>=0;})[0];a.click();return 1;})()");
    await sleep(300);
    await s.eval("(function(){var i=document.querySelector('#curOverlay input');i.value='中国地理';return 1;})()");
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return x.textContent.indexOf('AI 生成')>=0;})[0];b.click();return 1;})()");
    let freeRows = 0;
    for (let i = 0; i < 20; i++) {
      await sleep(1500);
      freeRows = await s.eval("document.querySelectorAll('#stage .list-row').length");
      if (freeRows) break;
      const t = await s.eval("document.getElementById('stage').textContent||''");
      if (/未返回有效题目|抓不到/.test(t)) break;
    }
    const pr2 = await s.eval("window.__aiPrompt||''");
    ck('免费 AI prompt 要求 15 道（不少于 12 道）', /15 道/.test(pr2) && /12 道/.test(pr2), pr2.slice(0, 80));
    ck('免费 AI 请求带 reasoning_effort=low', /reasoning_effort/.test(pr2), '');
    ck('免费 AI 通道返回题目可预览入库', freeRows === 10, 'rows=' + freeRows);

    // ---------- E. 模型输出被截断时，打捞出已完整的题目 ----------
    await s.eval(`localStorage.setItem('bt_qa_ai', JSON.stringify({url:'https://text.pollinations.ai/openai',key:'',model:'openai',proxy:''}));1`);
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);
    await s.eval(`(function(){
      window.__realFetch=window.fetch;
      window.fetch=function(u,o){
        if(o&&String(o.method||'').toUpperCase()==='POST'){
          var arr=[];
          for(var i=0;i<15;i++)arr.push({q:'截断题'+i,a:'答案'+i,opts:['答案'+i,'干扰'+(i+1),'干扰'+(i+2),'干扰'+(i+3)],exp:'解析'+i,src:'来源'});
          var full=JSON.stringify(arr);
          var cut=full.slice(0,full.indexOf('截断题10'));   // 断在第 11 题中间
          return Promise.resolve({json:function(){return Promise.resolve({choices:[{message:{content:cut}}]});}});
        }
        return window.__realFetch.apply(window,arguments);
      };
      return 1;})()`);
    await s.eval("(function(){var a=[].slice.call(document.querySelectorAll('.act')).filter(function(x){return x.textContent.indexOf('新建')>=0;})[0];a.click();return 1;})()");
    await sleep(300);
    await s.eval("(function(){var i=document.querySelector('#curOverlay input');i.value='截断测试';return 1;})()");
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return x.textContent.indexOf('AI 生成')>=0;})[0];b.click();return 1;})()");
    let cutRows = 0;
    for (let i = 0; i < 20; i++) {
      await sleep(1500);
      cutRows = await s.eval("document.querySelectorAll('#stage .list-row').length");
      if (cutRows) break;
      const t = await s.eval("document.getElementById('stage').textContent||''");
      if (/未返回有效题目|抓不到/.test(t)) break;
    }
    ck('输出被截断时打捞出已完整的 10 题', cutRows === 10, 'rows=' + cutRows);

    const errs = s.errors.filter(e => !/favicon|sw\.js|SW /i.test(e));
    ck('无 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));
  } catch (e) {
    fail.push('EXCEPTION :: ' + e.message);
  } finally {
    console.log('\n=== 出题质量专项：' + pass.length + '/' + (pass.length + fail.length) + ' 通过 ===');
    pass.forEach(t => console.log('  ✓ ' + t));
    fail.forEach(t => console.log('  ✗ ' + t));
    await s.close();
    try { srv && srv.kill('SIGKILL'); } catch (e) {}
  }
})();
