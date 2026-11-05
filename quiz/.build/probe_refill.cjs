/* 边刷边补专项：自定义题库低于阈值时自动补题（去重 / 静默 / 不越界补）
   4.0.1-4 +B：缺 exp/src 的题降级收下（打占位），其余闸照旧 */
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const { Session, sleep } = require('./cdp.cjs');
const { step } = require('./pace.cjs');

const PORT = 8861;
const APP = process.argv[2] || ('http://127.0.0.1:' + PORT + '/quiz/');
const USE_LOCAL = !process.argv[2];
const pass = [], fail = [];
function ck(n, c, e) { (c ? pass : fail).push(n + (e ? ' :: ' + e : '')); }

/* ---------- 纯函数：refillOk 的降级语义（4.0.1-4 +B） ---------- */
function slice(src, from, to) {
  const i = src.indexOf(from); const j = src.indexOf(to, i + 1);
  if (i < 0 || j < 0) throw new Error('切片失败：' + from);
  return src.slice(i, j);
}
const _core = fs.readFileSync(path.join(__dirname, 'engine_core.js'), 'utf8');
const _ui = fs.readFileSync(path.join(__dirname, 'quiz-ui.js'), 'utf8');
const P = new Function(
  slice(_core, 'function validItem(it){', 'function genMathPrimary(') + '\n' +
  slice(_ui, '/* ---------- 4.0 自定义题库生成质量', '/* ---------- AI 出题 prompt') + '\n' +
  slice(_ui, '/* 4.0.1-4 +B：静默补题', 'function autoRefill(cn){') +
  '\nreturn {refillOk:refillOk,examLike:examLike};')();

const CH = over => Object.assign({ q: '题干', a: '甲', opts: ['甲', '乙', '丙', '丁'] }, over);
const PH = '（AI 生成，暂无解析）';

const x1 = CH({ q: '弱模型题无解析' });
ck('refillOk：缺 exp/src 的 choice 题降级收下', P.refillOk(x1) === true);
ck('refillOk：收下时把占位写进 exp', x1.exp === PH, String(x1.exp));

const x2 = CH({ q: '弱模型填空题', type: 'fill', opts: null });
ck('refillOk：非 choice 题缺 exp/src 也降级收下',
  P.refillOk(x2) === true && x2.exp === PH, JSON.stringify(x2).slice(0, 90));

ck('refillOk：元信息题（出版社）仍被拒',
  P.refillOk(CH({ q: '下列说法正确的是（某出版社出版的图书）', exp: 'x', src: 'y' })) === false);
ck('refillOk：元信息题（第X版）仍被拒',
  P.refillOk(CH({ q: '以下哪项属于第二版新增内容', exp: 'x', src: 'y' })) === false);
ck('refillOk：补全词条题仍被拒',
  P.refillOk(CH({ q: '补全词条：光合作用', exp: 'x', src: 'y' })) === false);
ck('refillOk：「描述的是下列哪项」仍被拒',
  P.refillOk(CH({ q: '这段文字描述的是下列哪项', exp: 'x', src: 'y' })) === false);
ck('refillOk：choice 只有 3 个选项仍被拒',
  P.refillOk(CH({ q: '选项不全', opts: ['甲', '乙', '丙'], exp: 'x', src: 'y' })) === false);
ck('refillOk：choice 4 个选项但不含答案仍被拒',
  P.refillOk(CH({ q: '不含答案', opts: ['乙', '丙', '丁', '戊'], exp: 'x', src: 'y' })) === false);

const x3 = CH({ q: '只有来源', src: '某教材' });
ck('refillOk：只带 src 的题原样收下、不打占位', P.refillOk(x3) === true && !x3.exp, String(x3.exp));
const x4 = CH({ q: '只有解析', exp: '详解' });
ck('refillOk：只带 exp 的题原样收下、不补 src', P.refillOk(x4) === true && !x4.src, String(x4.src));
ck('refillOk：题干或答案为空仍被拒',
  P.refillOk({ q: '', a: '甲', opts: ['甲', '乙', '丙', '丁'] }) === false && P.refillOk(CH({ a: '' })) === false);

const BANK = '补题测试';
const FREE_CFG = "localStorage.setItem('bt_qa_ai', JSON.stringify({url:'https://text.pollinations.ai/openai',key:'',model:'openai',proxy:''}));1";

function makeBank(n, prefix) {
  const a = [];
  /* 4.0.1-4：autoRefill 的 fresh 过滤改成 examLike（要 exp 或 src），mock 必须跟着带上 */
  for (let i = 0; i < n; i++) a.push({ q: prefix + i, a: '答案' + i, opts: ['答案' + i, '干扰A' + i, '干扰B' + i, '干扰C' + i], exp: '解析' + i, src: '来源' + i });
  return a;
}
const seedOf = list => { const o = {}; o[BANK] = list; return JSON.stringify(JSON.stringify(o)); };

(async () => {
  const srv = USE_LOCAL ? spawn(process.execPath, [path.join(__dirname, 'serve.cjs'), String(PORT)], { stdio: 'ignore' }) : null;
  if (USE_LOCAL) await sleep(700);
  const s = new Session({ width: 414, height: 896, port: 9361 });
  try {
    await s.open(APP);
    await s.eval("localStorage.setItem('bt_qa_quickjump','true');localStorage.setItem('bt_qa_autorefill','true');1");
    await s.waitFor('!!document.querySelector(".book")', 15000);
    await s.eval("navigator.serviceWorker.getRegistrations().then(function(rs){return Promise.all(rs.map(function(r){return r.unregister();}));}).then(function(){return caches.keys();}).then(function(ks){return Promise.all(ks.map(function(k){return caches.delete(k);}));}).then(function(){return 1;})");

    /* 打一局：进题库 → 逐题作答 → 停在结算页 */
    async function playOne(name) {
      await s.eval("(function(){var bs=document.querySelectorAll('.book');for(var i=0;i<bs.length;i++){if(bs[i].textContent.indexOf(" + JSON.stringify(name) + ")>=0){bs[i].click();return 1;}}return 0;})()");
      await s.waitFor("!!document.querySelector('#stage .obtn') || !!document.querySelector('#stage .unkbtn')", 9000);
      for (let i = 0; i < 16; i++) {
        const atFin = await s.eval("!!([].slice.call(document.querySelectorAll('#stage button')).filter(function(x){return /再来一局/.test(x.textContent);})[0])");
        if (atFin) return true;
        await s.eval("(function(){var b=document.querySelector('#stage .obtn');if(b){b.click();return 1;}var u=document.querySelector('#stage .unkbtn');if(u){u.click();return 1;}return 0;})()");
        await sleep(140);
        await step(s);
      }
      return false;
    }
    const readBank = async () => {
      const raw = await s.eval("localStorage.getItem('bt_qa_custom')||'{}'");
      let o = {}; try { o = JSON.parse(raw); } catch (e) {}
      return o[BANK] || [];
    };
    const readToast = () => s.eval("(function(){var t=document.getElementById('toast');return t?t.textContent:'';})()");
    const shelfMeta = name => s.eval("(function(){var bs=document.querySelectorAll('.book');for(var i=0;i<bs.length;i++){if(bs[i].textContent.indexOf(" + JSON.stringify(name) + ")>=0)return bs[i].textContent;}return '';})()");

    /* ---------- A. 8 题的题库刷完一局 → 自动补题 + 去重 ---------- */
    await s.eval(FREE_CFG);
    await s.eval("localStorage.setItem('bt_qa_custom', " + seedOf(makeBank(8, '旧题')) + ");1");
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);
    // 桩放在 reload 之后注入，否则被页面重载冲掉
    await s.eval(`(function(){
      window.__postCount=0;window.__aiPrompt='';window.__realFetch=window.fetch;
      window.fetch=function(u,o){
        if(o&&String(o.method||'').toUpperCase()==='POST'){
          window.__postCount++;window.__aiPrompt=(o&&o.body)||'';
          var arr=[];
          arr.push({q:'旧题0',a:'答案0',opts:['答案0','x','y','z']});   // 故意与旧题重复
          arr.push({q:'旧题1',a:'答案1',opts:['答案1','x','y','z']});   // 故意与旧题重复
          for(var i=2;i<15;i++)arr.push({q:'新题'+i,a:'答案'+i,opts:['答案'+i,'干扰A'+i,'干扰B'+i,'干扰C'+i],exp:'解析'+i,src:'来源'+i});
          return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve({choices:[{message:{content:JSON.stringify(arr)}}]});}});
        }
        return window.__realFetch.apply(window,arguments);
      };
      return 1;})()`);

    const playedA = await playOne(BANK);
    ck('8 题的题库可正常打完一局', playedA, '');
    // 真实路径：结算页看一眼就点「返回书架」，补题仍在后台抓素材
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /返回书架/.test(x.textContent);})[0];if(b)b.click();return 1;})()");
    await sleep(400);

    let toastA = '', listA = [];
    for (let i = 0; i < 160; i++) {
      await sleep(400);
      toastA = await readToast();
      listA = await readBank();
      if (listA.length > 8) break;
      if (/已自动补充/.test(toastA)) break;
    }
    if (!listA.length) listA = await readBank();
    if (!toastA) toastA = await readToast();

    ck('结算页出现「✨ 已自动补充 N 题」', /已自动补充 \d+ 题/.test(toastA), toastA);
    ck('题库 8 题 → 21 题（15 题中 2 道重复被去重）', listA.length === 21, 'len=' + listA.length + ' | toast=' + toastA);
    ck('补题后题库内无重复 q', new Set(listA.map(x => x.q)).size === listA.length, 'uniq=' + new Set(listA.map(x => x.q)).size);
    ck('原有 8 题保留 + 新增 13 题', listA.filter(x => /^旧题/.test(x.q)).length === 8 && listA.filter(x => /^新题/.test(x.q)).length === 13,
      'old=' + listA.filter(x => /^旧题/.test(x.q)).length + ' new=' + listA.filter(x => /^新题/.test(x.q)).length);
    const promptA = await s.eval("window.__aiPrompt||''");
    /* body 是 JSON 字符串，prompt 里的引号会被转义成 \"，所以先解包再断言 */
    let promptTxt = String(promptA);
    try { const bd = JSON.parse(promptA); if (bd && bd.messages) promptTxt = bd.messages.map(m => m.content || '').join('\n'); } catch (e) {}
    /* C0 已重写统一出题 prompt：命题老师人设 + 严禁出的题黑名单 + 强制 exp/src 字段 */
    ck('补题 prompt 复用统一出题要求（命题老师/禁出清单/exp+src/题量）',
      /命题老师/.test(promptTxt) && /严禁出的题/.test(promptTxt) && /"exp"\s*:/.test(promptTxt) && /"src"\s*:/.test(promptTxt) && /15 道/.test(promptTxt),
      'len=' + promptTxt.length + ' | ' + promptTxt.slice(0, 40));
    await sleep(600);
    ck('书架该题库题量就地刷新为 21 题（无需手动刷新页面）', /21 题/.test(await shelfMeta(BANK)), await shelfMeta(BANK));

    /* ---------- B. 未配置 AI → 静默跳过 ---------- */
    await s.eval("localStorage.removeItem('bt_qa_ai');1");
    await s.eval("localStorage.setItem('bt_qa_custom', " + seedOf(makeBank(8, '旧题')) + ");1");
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);
    const playedB = await playOne(BANK);
    ck('未配 AI 时仍可正常打完一局', playedB, '');
    await sleep(4000);
    const listB = await readBank();
    ck('未配置 AI 时静默跳过（题库仍 8 题）', listB.length === 8, 'len=' + listB.length);
    ck('未配置 AI 时无补题提示', !/已自动补充/.test(await readToast()), await readToast());

    /* ---------- B2. 开关关（默认）→ 配了 AI 也不补题 ---------- */
    await s.eval(FREE_CFG);
    await s.eval("localStorage.removeItem('bt_qa_autorefill');1");
    await s.eval("localStorage.setItem('bt_qa_custom', " + seedOf(makeBank(8, '旧题')) + ");1");
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);
    await s.eval(`(function(){window.__postCount=0;window.__realFetch=window.fetch;window.fetch=function(u,o){if(o&&String(o.method||'').toUpperCase()==='POST'){window.__postCount++;}return window.__realFetch.apply(window,arguments);};return 1;})()`);
    const defSwitch = await s.eval("JSON.parse(localStorage.getItem('bt_qa_autorefill')||'false')");
    ck('自动补题开关缺省为关（默认不补）', defSwitch === false, String(defSwitch));
    const playedB2 = await playOne(BANK);
    ck('开关关时仍可正常打完一局', playedB2, '');
    await sleep(3500);
    const postB2 = await s.eval("window.__postCount||0");
    const listB2 = await readBank();
    ck('开关关：不发补题请求、题库仍 8 题（行为不变）',
      postB2 === 0 && listB2.length === 8, 'post=' + postB2 + ' len=' + listB2.length);

    /* ---------- C. 题库充足（18 题）→ 不该触发补题 ---------- */
    await s.eval(FREE_CFG);
    await s.eval("localStorage.setItem('bt_qa_custom', " + seedOf(makeBank(18, '足量题')) + ");1");
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);
    await s.eval(`(function(){window.__postCount=0;window.__realFetch=window.fetch;window.fetch=function(u,o){if(o&&String(o.method||'').toUpperCase()==='POST'){window.__postCount++;}return window.__realFetch.apply(window,arguments);};return 1;})()`);
    const playedC = await playOne(BANK);
    ck('18 题的题库可正常打完一局', playedC, '');
    await sleep(3500);
    const postC = await s.eval("window.__postCount||0");
    const listC = await readBank();
    ck('题库充足（18 题）时不触发补题', postC === 0 && listC.length === 18, 'post=' + postC + ' len=' + listC.length);

    /* ---------- D. 裁决 B：弱模型漏带 exp/src → 降级收下（打占位），其余闸照拒 ---------- */
    await s.eval("localStorage.setItem('bt_qa_autorefill','true');1");
    await s.eval(FREE_CFG);
    await s.eval("localStorage.setItem('bt_qa_custom', " + seedOf(makeBank(8, '旧题')) + ");1");
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);
    await s.eval(`(function(){
      window.__postCount=0;window.__realFetch=window.fetch;
      window.fetch=function(u,o){
        var us=String(u);
        if(o&&String(o.method||'').toUpperCase()==='POST'){
          window.__postCount++;
          var arr=[];
          /* ① 无 exp / src（弱模型最常见）→ 应降级收下 + 占位 */
          arr.push({q:'弱模无解析A',a:'甲',opts:['甲','乙','丙','丁']});
          arr.push({q:'弱模无解析填空B',a:'42',type:'fill'});
          /* ② 元信息题（即便带 exp/src 也拒） */
          arr.push({q:'下列说法正确的是（某出版社出版的图书）',a:'甲',opts:['甲','乙','丙','丁'],exp:'x',src:'y'});
          arr.push({q:'以下哪项属于第二版新增内容',a:'甲',opts:['甲','乙','丙','丁'],exp:'x',src:'y'});
          arr.push({q:'补全词条：光合作用',a:'甲',opts:['甲','乙','丙','丁'],exp:'x',src:'y'});
          arr.push({q:'这段文字描述的是下列哪项',a:'甲',opts:['甲','乙','丙','丁'],exp:'x',src:'y'});
          /* ③ 坏选项 */
          arr.push({q:'选项只有三个C',a:'甲',opts:['甲','乙','丙'],exp:'x',src:'y'});
          arr.push({q:'选项不含答案D',a:'甲',opts:['乙','丙','丁','戊'],exp:'x',src:'y'});
          /* ④ 只带其一 → 原样收下，不打占位 */
          arr.push({q:'只有来源E',a:'甲',opts:['甲','乙','丙','丁'],src:'某教材'});
          arr.push({q:'只有解析F',a:'甲',opts:['甲','乙','丙','丁'],exp:'详解F'});
          for(var i=1;i<=5;i++)arr.push({q:'正常题G'+i,a:'甲',opts:['甲','乙','丙','丁'],exp:'解析G'+i,src:'来源G'+i});
          return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve({choices:[{message:{content:JSON.stringify(arr)}}]});}});
        }
        /* 抓素材的外网 GET 一律立刻失败：否则 baidu jsonp 5s + wiki 每源 6s + 12 个摘要 7s，
           本机代理下能把 16s 轮询全耗光（补题逻辑本身没问题，是等不到） */
        if(/wikipedia\.org|wikidata\.org|baike\.baidu\.com/.test(us))return Promise.reject(new Error('offline'));
        return window.__realFetch.apply(window,arguments);
      };
      return 1;})()`);

    const playedD = await playOne(BANK);
    ck('D 组：8 题题库可正常打完一局', playedD, '');
    await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .btn')).filter(function(x){return /返回书架/.test(x.textContent);})[0];if(b)b.click();return 1;})()");
    await sleep(400);
    let toastD = '', listD = [];
    for (let i = 0; i < 90; i++) {
      await sleep(500);
      toastD = await readToast();
      listD = await readBank();
      if (listD.length > 8) break;
      if (/已自动补充/.test(toastD)) break;
    }
    const postD = await s.eval("window.__postCount||0");
    if (!listD.length) listD = await readBank();
    const has = q => listD.some(x => x.q === q);
    const get = q => listD.filter(x => x.q === q)[0] || {};

    ck('D1 弱模型无 exp/src 的 choice 题仍入库', has('弱模无解析A'), 'len=' + listD.length + ' | post=' + postD + ' | toast=' + toastD);
    ck('D2 无解析题带占位「（AI 生成，暂无解析）」', get('弱模无解析A').exp === PH, String(get('弱模无解析A').exp));
    ck('D3 无 exp/src 的填空题也降级收下 + 占位',
      get('弱模无解析填空B').type === 'fill' && get('弱模无解析填空B').exp === PH,
      JSON.stringify(get('弱模无解析填空B')).slice(0, 90));
    ck('D4 元信息题（出版社/版次/词条/描述是哪项）4 道全被拒',
      !has('下列说法正确的是（某出版社出版的图书）') && !has('以下哪项属于第二版新增内容') &&
      !has('补全词条：光合作用') && !has('这段文字描述的是下列哪项'), '');
    ck('D5 choice 选项不齐 / 不含答案仍被拒', !has('选项只有三个C') && !has('选项不含答案D'), '');
    ck('D6 只带 src 的题原样入库、不打占位',
      get('只有来源E').src === '某教材' && !get('只有来源E').exp, JSON.stringify(get('只有来源E')).slice(0, 90));
    ck('D7 只带 exp 的题原样入库、不补 src',
      get('只有解析F').exp === '详解F' && !get('只有解析F').src, JSON.stringify(get('只有解析F')).slice(0, 90));
    ck('D8 正常题（带 exp+src）5 道全部入库', [1, 2, 3, 4, 5].every(i => has('正常题G' + i)), '');
    ck('D9 补题后共 17 题（8 + 9）', listD.length === 17, 'len=' + listD.length);
    ck('D10 toast「已自动补充 9 题」正常', /已自动补充 9 题/.test(toastD), toastD);
    await sleep(600);
    ck('D11 书架题量就地刷新为 17 题', /17 题/.test(await shelfMeta(BANK)), await shelfMeta(BANK));

    /* ---------- E. 占位解析题的实际答题显示：答错不空解析、不白屏 ---------- */
    await s.eval("localStorage.removeItem('bt_qa_ai');1");
    await s.eval("localStorage.removeItem('bt_qa_autorefill');1");
    const PHQ = { q: '占位解析验证题', a: '正确项', opts: ['正确项', '错误项1', '错误项2', '错误项3'], exp: PH };
    /* makeCustomRound 一定 shuffle，多题时首题不确定 → 只放这 1 道，保证第一题就是它 */
    await s.eval("localStorage.setItem('bt_qa_custom', " + seedOf([PHQ]) + ");1");
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);
    await s.eval("(function(){var bs=document.querySelectorAll('.book');for(var i=0;i<bs.length;i++){if(bs[i].textContent.indexOf(" + JSON.stringify(BANK) + ")>=0){bs[i].click();return 1;}}return 0;})()");
    await s.waitFor("!!document.querySelector('#stage .obtn')", 9000);
    ck('E1 占位题是第 1 题', /占位解析验证题/.test(await s.eval("document.querySelector('#stage').textContent")), '');
    await s.eval("(function(){var os=[].slice.call(document.querySelectorAll('#stage .obtn'));for(var i=0;i<os.length;i++){if(os[i].textContent.indexOf('正确项')<0){os[i].click();return 1;}}return 0;})()");
    await sleep(600);
    const fbTxt = await s.eval("document.querySelector('#stage').textContent");
    ck('E2 答错后显示占位解析（不空白）', /解析：.*（AI 生成，暂无解析）/.test(fbTxt), fbTxt.slice(-90));
    ck('E3 答错后仍有「下一题」+ 正确答输出（不白屏）',
      /下一题/.test(fbTxt) && /正确答/.test(fbTxt), fbTxt.slice(-120));

    const errs = s.errors.filter(e => !/favicon|sw\.js|SW /i.test(e));
    ck('无 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));
  } catch (e) {
    fail.push('EXCEPTION :: ' + e.message);
  } finally {
    console.log('\n=== 边刷边补：' + pass.length + '/' + (pass.length + fail.length) + ' 通过 ===');
    pass.forEach(t => console.log('  ✓ ' + t));
    fail.forEach(t => console.log('  ✗ ' + t));
    await s.close();
    try { srv && srv.kill('SIGKILL'); } catch (e) {}
  }
})().catch(e => { console.error(e); process.exit(1); });
