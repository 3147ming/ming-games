/* 轻量代码编辑器 + JS 本地运行自测 专项探针
   A. 结构：.edwrap > .edline + .edbody(.edhl + textarea.codeinp)，textarea 仍是真输入控件、文字透明
   B. 高亮分词：关键字/字符串/数字/函数名/注释 五类 span
   C. 行号：随行数变化；Tab 插两空格、Shift+Tab 反缩进；括号自动补全 + 跳过已补的右括号
   D. 运行自测：通过 / 结果不符 / C 写法报错（提示用 AI） / console 输出 / 死循环 4 秒中断
   E. 数组结果按归一化比对（找一道期望值是数组的题）
   F. 布局：编辑器定高，连打多行后 #fbzone 位置不动、无横向溢出；滚动同步到高亮层与行号列
   G. 「🤖 提交 AI 评判」与 Ctrl+Enter 仍按原逻辑走 AI（fetch 桩）
   依赖 fetch 桩，不真联网；本地与线上都能跑。 */
const { spawn } = require('child_process');
const path = require('path');
const { Session, sleep } = require('./cdp.cjs');

const PORT = 8861;
const APP = process.argv[2] || ('http://127.0.0.1:' + PORT + '/quiz/');
const USE_LOCAL = !process.argv[2];
const pass = [], fail = [];
function ck(n, c, e) { (c ? pass : fail).push(n + (e ? ' :: ' + e : '')); }

(async () => {
  const srv = USE_LOCAL ? spawn(process.execPath, [path.join(__dirname, 'serve.cjs'), String(PORT)], { stdio: 'ignore' }) : null;
  if (USE_LOCAL) await sleep(700);
  const s = new Session({ width: 414, height: 896, port: 9361 });
  let LAST = '';
  const _ev = s.eval.bind(s);
  s.eval = function (x) { LAST = String(x).slice(0, 110); return _ev(x); };

  const hasSel = (sel) => s.eval('!!document.querySelector(' + JSON.stringify(sel) + ')');
  const clickText = (sel, txt) => s.eval("(function(){var a=[].slice.call(document.querySelectorAll(" + JSON.stringify(sel) + "));var e=a.filter(function(x){return (x.textContent||'').indexOf(" + JSON.stringify(txt) + ")>=0;})[0];if(e){e.click();return 1;}return 0;})()");
  /* 给 textarea 赋值并触发 input（程序化改 value 不会自己触发） */
  const setCode = (code) => s.eval("(function(){var t=document.querySelector('#stage .codeinp');if(!t)return 0;t.value=" + JSON.stringify(code) + ";t.dispatchEvent(new Event('input'));return 1;})()");
  const keyEv = (type, key, opts) => s.eval("(function(){var t=document.querySelector('#stage .codeinp');if(!t)return 0;"
    + "var o={key:" + JSON.stringify(key) + ",bubbles:true,cancelable:true};var ex=" + JSON.stringify(opts || {}) + ";for(var k in ex)o[k]=ex[k];"
    + "var e=new KeyboardEvent(" + JSON.stringify(type) + ",o);return t.dispatchEvent(e)?1:2;})()");
  const clickRun = () => clickText('#stage .row .btn', '运行自测');
  const runOut = () => s.eval("(function(){var r=document.querySelector('#stage .runout');return r?r.textContent:'';})()");
  const qsample = () => s.eval("(function(){var h=document.querySelector('#stage .qbox .hint');var t=h?h.textContent:'';return t.replace(/^\\s*样例：/,'').split('　（')[0].trim();})()");

  const stub = `(function(){
    window.__realFetch=window.fetch;
    window.fetch=function(u,o){
      if(!o||String(o.method||'GET').toUpperCase()!=='POST')return Promise.reject(new Error('probe: 不联网'));
      var body=String((o&&o.body)||'');var content;
      if(/批改一道编程练习/.test(body)) content=JSON.stringify({ok:true,why:'实现正确'});
      else content=JSON.stringify({exp:'先拆再合并'});
      return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve({choices:[{message:{content:content}}]});}});
    };return 1;})()`;

  /* 手写题走下一题：点「下一题 ›」再轮询到新题可写 / 进结算 */
  async function nextHand() {
    await s.eval("(function(){var b=document.querySelector('#fbzone .fb .fbnext');if(b)b.click();return 1;})()");
    for (let k = 0; k < 60; k++) {
      await sleep(120);
      const st = await s.eval(`(function(){
        var bs=[].slice.call(document.querySelectorAll('#stage .btn'));
        for(var i=0;i<bs.length;i++){if(/再来一局|返回书架/.test(bs[i].textContent))return 2;}
        var t=document.querySelector('#stage .codeinp');
        if(t&&!t.disabled&&!document.querySelector('#fbzone .fb'))return 1;
        return 0;})()`);
      if (st) return st;
    }
    return 0;
  }

  async function enterHand(di) {
    /* 语言档案显式只选 js：D~G 段要有「调用 → 期望值」样例才能跑自测闭环。
       C 手写题现在五档都有，H 段会切到 c 档案专门验「运行自测被 c:1 拦住」。 */
    const idx = (di == null ? 4 : di);
    if (await hasSel('#stage .btn')) { await clickText('#stage .btn', '返回书架'); await sleep(300); }
    await s.waitFor('!!document.querySelector(".book")', 12000);
    await clickText('.book', '编程');
    await s.waitFor('!!document.querySelector(".secbtn")||!!document.querySelector(".diffbtn")', 10000);
    if (await hasSel('.secbtn')) { await clickText('.secbtn', '程序编写'); await s.waitFor('!!document.querySelector(".diffbtn")', 8000); }
    await s.eval("(function(){document.querySelectorAll('.diffbtn')[" + idx + "].click();var go=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return /开始出题/.test(x.textContent)})[0];if(go)go.click();return 1;})()");
    await s.waitFor("!!document.querySelector('#stage .toggle')", 10000);
    if (await hasSel('#curOverlay .btn')) { await clickText('#curOverlay .btn', '跳过'); await sleep(300); }
    await clickText('#stage .toggle', '手写代码');
    await s.waitFor("!!document.querySelector('#stage .codeinp')", 8000);
  }

  try {
    await s.open(APP);
    await s.waitFor('!!document.querySelector(".book")', 15000);
    await s.eval("navigator.serviceWorker.getRegistrations().then(function(rs){return Promise.all(rs.map(function(r){return r.unregister();}));}).then(function(){return 1;}).catch(function(){return 0;})");
    await s.eval("localStorage.clear();localStorage.setItem('bt_qa_quickjump','true');"
      + "localStorage.setItem('bt_qa_profile_code',JSON.stringify({done:true,langs:['js'],level:0,rank:0}));"
      + "localStorage.setItem('bt_qa_ai',JSON.stringify({url:'http://127.0.0.1:9/v1/chat/completions',key:'k',model:'m',proxy:''}));1");
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 15000);
    await s.eval(stub);
    await sleep(200);

    await enterHand();

    /* ---------- A. 结构 ---------- */
    ck('输入区外层是 .edwrap', await hasSel('#stage .edwrap'), '');
    ck('编辑器有行号列 .edline', await hasSel('#stage .edwrap .edline'), '');
    ck('编辑器有高亮层 .edhl', await hasSel('#stage .edwrap .edbody .edhl'), '');
    ck('textarea.codeinp 仍是真实输入控件（未换成 div）', await s.eval("(function(){var t=document.querySelector('#stage .edwrap textarea.codeinp');return !!t&&t.tagName==='TEXTAREA';})()"), '');
    ck('textarea 文字透明、光标可见（透明叠层方案）', await s.eval("(function(){var t=document.querySelector('#stage .edwrap textarea.codeinp');var c=getComputedStyle(t);return /rgba\\(0, 0, 0, 0\\)|transparent/.test(c.color)&&c.caretColor!=='rgba(0, 0, 0, 0)';})()"), await s.eval("(function(){var t=document.querySelector('#stage .edwrap textarea.codeinp');var c=getComputedStyle(t);return c.color+' / '+c.caretColor;})()"));
    const ph = await s.eval("(document.querySelector('#stage .codeinp')||{}).placeholder||''");
    ck('placeholder 够短（textarea 是 white-space:pre，长了会被右侧裁掉）', ph.length > 0 && ph.length <= 18, JSON.stringify(ph));

    /* ---------- B. 高亮分词 ---------- */
    await setCode('// 说明\nfunction sum(a,b){\n  return "x" + 12;\n}\nsum(1,2)');
    await sleep(150);
    const hl = await s.eval("(function(){var e=document.querySelector('#stage .edhl');return e?e.textContent:'';})()");
    ck('高亮层内容与输入一致（含换行）', hl.replace(/\s+$/, '') === '// 说明\nfunction sum(a,b){\n  return "x" + 12;\n}\nsum(1,2)', JSON.stringify(hl.slice(0, 60)));
    const cls = JSON.parse(await s.eval("JSON.stringify(['t-com','t-str','t-kw','t-num','t-fn'].map(function(c){var e=document.querySelector('#stage .edhl .'+c);return e?e.textContent:''}))"));
    ck('注释着色 .t-com', cls[0] === '// 说明', cls[0]);
    ck('字符串着色 .t-str', cls[1] === '"x"', cls[1]);
    ck('关键字着色 .t-kw', /function/.test(cls[2]), cls[2]);
    ck('数字着色 .t-num', cls[3] === '12', cls[3]);
    ck('函数名着色 .t-fn', /sum/.test(cls[4]), cls[4]);
    ck('高亮不会把标签当 HTML 执行（转义生效）', await s.eval("(function(){var e=document.querySelector('#stage .edhl');return e.querySelectorAll('script,b,i').length===0;})()"), '');

    /* ---------- C. 行号 / Tab / 括号 ---------- */
    await setCode('a\nb\nc');
    await sleep(120);
    const lines = await s.eval("(function(){var e=document.querySelector('#stage .edline');return e?e.textContent:'';})()");
    ck('行号随行数变化（3 行 → 1/2/3）', lines === '1\n2\n3', JSON.stringify(lines));

    await setCode('ab');
    await s.eval("(function(){var t=document.querySelector('#stage .codeinp');t.selectionStart=t.selectionEnd=1;return 1;})()");
    await keyEv('keydown', 'Tab');
    let v = await s.eval("(function(){var t=document.querySelector('#stage .codeinp');return t.value;})()");
    ck('Tab 插入两个空格（不再跳去下一个控件）', v === 'a  b', JSON.stringify(v));

    await keyEv('keydown', 'Tab', { shiftKey: true });
    v = await s.eval("(function(){var t=document.querySelector('#stage .codeinp');return t.value;})()");
    ck('Shift+Tab 反缩进两格', v === 'ab', JSON.stringify(v));

    /* 括号自动补：模拟「刚敲下 ( 」——keyup 已带 ( 在值里 */
    await s.eval("(function(){var t=document.querySelector('#stage .codeinp');t.value='a(';t.selectionStart=t.selectionEnd=2;t.dispatchEvent(new Event('input'));return 1;})()");
    await keyEv('keyup', '(');
    v = await s.eval("(function(){var t=document.querySelector('#stage .codeinp');return t.value+'@'+t.selectionStart;})()");
    ck('输入 ( 自动补右括号且光标留在中间', v === 'a()@2', JSON.stringify(v));

    const prevented = await keyEv('keydown', ')');
    v = await s.eval("(function(){var t=document.querySelector('#stage .codeinp');return t.value+'@'+t.selectionStart;})()");
    ck('光标停在自动补的 ) 前按 ) → 直接跳过，不叠成 ))', v === 'a()@3' && prevented === 2, JSON.stringify(v) + ' ev=' + prevented);

    /* ---------- D. 运行自测 ---------- */
    const ex = await qsample();
    const m = ex.match(/^([\s\S]+?)\s*→\s*([\s\S]+)$/);
    ck('题目样例可解析出「调用 → 期望值」', !!m, JSON.stringify(ex));
    const call = m ? m[1].trim() : '';
    const want = m ? m[2].trim() : '';
    const fname = (call.match(/^([A-Za-z_$][\w$]*)/) || [])[1] || '';
    ck('样例里能取出函数名', !!fname, call);

    /* D1. 写个「无论参数都返回期望值」的实现 → 必然通过，验证闭环 */
    await setCode('function ' + fname + '(){return ' + want + ';}');
    await clickRun();
    await s.waitFor("!!document.querySelector('#stage .runout')", 8000);
    let ro = await runOut();
    ck('▶ 运行自测 → 自动执行样例并判通过', /✅ 运行通过/.test(ro) && /期望/.test(ro), JSON.stringify(ro.slice(0, 90)));

    /* D2. 结果与期望不符 */
    await setCode('function ' + fname + '(){return 123456;}');
    await clickRun();
    await s.waitFor("!!document.querySelector('#stage .runout') && /123456/.test((document.querySelector('#stage .runout')||{}).textContent||'')", 8000);
    ro = await runOut();
    ck('写错 → 显示「⚠️ 运行结果 X（期望 Y）」', /⚠️ 运行结果/.test(ro) && /123456/.test(ro) && /期望/.test(ro), JSON.stringify(ro.slice(0, 90)));

    /* D3. C 写法 → 明确报错并指向 AI 评判 */
    await setCode('int main(){return 0;}');
    await clickRun();
    await s.waitFor("!!document.querySelector('#stage .runout') && /失败/.test((document.querySelector('#stage .runout')||{}).textContent||'')", 8000);
    ro = await runOut();
    ck('C 写法 → ❌ 本地运行失败 + 提示改用 AI 评判', /❌ 本地运行失败/.test(ro) && /AI 评判/.test(ro), JSON.stringify(ro.slice(0, 100)));

    /* D3b. 写了函数但名字跟样例对不上 → 指名道姓，别甩「只支持 JS」 */
    await setCode('function notThisName(){return 1;}');
    await clickRun();
    await s.waitFor("!!document.querySelector('#stage .runout') && /not defined/.test((document.querySelector('#stage .runout')||{}).textContent||'')", 8000);
    ro = await runOut();
    ck('样例调用的函数名没定义 → 提示「还没定义 ' + fname + '」', new RegExp('还没定义叫 ' + fname + ' 的函数').test(ro), JSON.stringify(ro.slice(0, 110)));

    /* D4. console 输出被捕获 */
    await setCode('function ' + fname + '(){console.log("调试 " + 7);return ' + want + ';}');
    await clickRun();
    await s.waitFor("!!document.querySelector('#stage .runout') && /console 输出/.test((document.querySelector('#stage .runout')||{}).textContent||'')", 8000);
    ro = await runOut();
    ck('console.log 输出回显在结果下方', /📤 console 输出/.test(ro) && /调试 7/.test(ro) && /✅ 运行通过/.test(ro), JSON.stringify(ro.slice(0, 110)));

    /* D5. 死循环 4 秒中断（Worker 才有的保护） */
    const workerOK = await s.eval("(function(){try{var u=URL.createObjectURL(new Blob(['self.onmessage=function(){self.postMessage(1)}'],{type:'text/javascript'}));var w=new Worker(u);w.terminate();URL.revokeObjectURL(u);return 1;}catch(e){return 0;}})()");
    if (workerOK) {
      await setCode('function ' + fname + '(){while(true){}}');
      const t0 = Date.now();
      await clickRun();
      const got = await s.waitFor("!!document.querySelector('#stage .runout') && /超时/.test((document.querySelector('#stage .runout')||{}).textContent||'')", 12000);
      const cost = Date.now() - t0;
      ro = await runOut();
      ck('死循环被中断（不卡死页面）', got && /运行超时/.test(ro) && cost < 11000, cost + 'ms :: ' + JSON.stringify(ro.slice(0, 60)));
      ck('中断后页面仍可交互（能继续改代码再运行）', await s.eval("(function(){var t=document.querySelector('#stage .codeinp');return !!t&&!t.disabled;})()"), '');
    }

    /* ---------- F. 布局 / 滚动 ---------- */
    await setCode('1\n2\n3');
    await sleep(120);
    const topBefore = await s.eval("document.querySelector('#fbzone').getBoundingClientRect().top");
    await setCode('1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12');
    await sleep(150);
    const topAfter = await s.eval("document.querySelector('#fbzone').getBoundingClientRect().top");
    ck('连打 12 行后反馈区位置不动（编辑器定高、内部滚动）', Math.abs(topAfter - topBefore) < 1.5, topBefore + ' → ' + topAfter);

    const hEd = await s.eval("Math.round(document.querySelector('#stage .edwrap').getBoundingClientRect().height)");
    ck('编辑器高度在 140~200px（不占满屏）', hEd >= 140 && hEd <= 200, 'h=' + hEd);
    const hTa = await s.eval("Math.round(document.querySelector('#stage .codeinp').getBoundingClientRect().height)");
    ck('textarea 与高亮层同高（不错位）', Math.abs(hTa - hEd) <= 3, 'ta=' + hTa + ' wrap=' + hEd);

    /* 长代码滚动同步 */
    await setCode(Array.from({ length: 40 }, (_, i) => 'line' + (i + 1)).join('\n'));
    await sleep(150);
    await s.eval("(function(){var t=document.querySelector('#stage .codeinp');t.scrollTop=160;t.dispatchEvent(new Event('scroll'));return 1;})()");
    await sleep(120);
    const sc = JSON.parse(await s.eval("JSON.stringify((function(){var t=document.querySelector('#stage .codeinp');var h=document.querySelector('#stage .edhl');var l=document.querySelector('#stage .edline');return {ta:t.scrollTop,hl:h.scrollTop,ln:l.scrollTop};})())"));
    ck('滚动同步：textarea / 高亮层 / 行号列 三者一致', sc.ta > 0 && sc.hl === sc.ta && sc.ln === sc.ta, JSON.stringify(sc));

    const ovf = await s.eval('document.documentElement.scrollWidth - document.documentElement.clientWidth');
    ck('编辑器不制造横向溢出', ovf <= 0, 'overflow=' + ovf);

    /* ---------- E. 数组题归一化（精通档：flatten / mergeSorted 期望值是数组） ---------- */
    await enterHand(4);
    let arrEx = '', tries = 0;
    while (tries++ < 10) {
      arrEx = await qsample();
      if (/→\s*\[/.test(arrEx)) break;
      const un = await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .unkbtn')).filter(function(x){return /不会/.test(x.textContent)&&!x.disabled;})[0];if(b){b.click();return 1;}return 0;})()");
      if (!un) break;
      await s.waitFor("!!document.querySelector('#fbzone .fb')", 6000);
      if (await nextHand() !== 1) break;
    }
    const am = arrEx.match(/^([\s\S]+?)\s*→\s*([\s\S]+)$/);
    if (am && /\[/.test(am[2])) {
      const afn = (am[1].match(/^([A-Za-z_$][\w$]*)/) || [])[1] || '';
      const awant = am[2].trim();
      await setCode('function ' + afn + '(){return ' + awant + ';}');
      await clickRun();
      await s.waitFor("!!document.querySelector('#stage .runout')", 8000);
      ro = await runOut();
      ck('数组结果按归一化比对（空格差异不算错）', /✅ 运行通过/.test(ro), arrEx + ' :: ' + JSON.stringify(ro.slice(0, 70)));
      /* 元素顺序不同必须判错 */
      const jumbled = awant.replace(/\[([^\]]*)\]/, function (_, inner) {
        const parts = inner.split(',').map(x => x.trim());
        return '[' + parts.reverse().join(', ') + ']';
      });
      if (jumbled !== awant) {
        await setCode('function ' + afn + '(){return ' + jumbled + ';}');
        await clickRun();
        await s.waitFor("!!document.querySelector('#stage .runout') && !/✅ 运行通过/.test((document.querySelector('#stage .runout')||{}).textContent||'')", 8000);
        ro = await runOut();
        ck('数组顺序不同 → 判为不一致', /⚠️ 运行结果/.test(ro), JSON.stringify(ro.slice(0, 80)));
      }
    } else {
      ck('数组题归一化（跳过：本局没抽到数组题）', true, 'last=' + arrEx);
    }

    /* ---------- G. AI 提交仍是原逻辑 ---------- */
    await enterHand();
    await setCode('function ' + fname + '(){return true;}');
    const aiOK = await clickText('#stage .row .btn', '提交 AI 评判');
    await s.waitFor("!!document.querySelector('#fbzone .fb')", 10000);
    const fb = await s.eval("(function(){var f=document.querySelector('#fbzone .fb');return f?f.textContent:'';})()");
    ck('「🤖 提交 AI 评判」照旧走 AI 判分并出反馈条', aiOK === 1 && /AI 评判|判为/.test(fb), JSON.stringify(fb.slice(0, 60)));

    /* ---------- H. C 写法手写题：自测不硬跑 JS，给正确指引 ---------- */
    await s.eval("localStorage.setItem('bt_qa_profile_code',JSON.stringify({done:true,langs:['c'],level:0,rank:0}));1");
    await enterHand(1);   // c 档案下入门档 5 道全是 C 题
    let cSample = '', foundC = false;
    for (let t = 0; t < 12; t++) {
      cSample = await qsample();
      if (cSample && cSample.indexOf('→') < 0) { foundC = true; break; }
      const un = await s.eval("(function(){var b=[].slice.call(document.querySelectorAll('#stage .unkbtn')).filter(function(x){return /不会/.test(x.textContent)&&!x.disabled;})[0];if(b){b.click();return 1;}return 0;})()");
      if (!un) break;
      await s.waitFor("!!document.querySelector('#fbzone .fb')", 6000);
      if (await nextHand() !== 1) break;
    }
    ck('c 档案下抽到 C 题（不跳过）', foundC, 'last=' + cSample);
    if (foundC) {
      await setCode('int main(void){ return 0; }');
      await clickRun();
      await s.waitFor("!!document.querySelector('#stage .runout')", 8000);
      const cr = await runOut();
      ck('C 写法手写题：自测给「只支持 JS，请用 AI 评判」而不是 JS 语法错', /C 写法/.test(cr) && !/require a function name/.test(cr), JSON.stringify(cr.slice(0, 80)));
    } else {
      ck('C 写法手写题：自测给「只支持 JS，请用 AI 评判」', false, '本局没抽到 C 题 last=' + cSample);
    }

    ck('全程无 JS 异常', s.errors.length === 0, s.errors.slice(0, 2).join(' | '));
  } catch (e) {
    fail.push('探针异常 :: ' + e.message + ' | 最后表达式: ' + LAST);
  } finally {
    console.log('\n=== 代码编辑器 + JS 运行自测：' + pass.length + '/' + (pass.length + fail.length) + ' 通过 ===');
    pass.forEach(t => console.log('  ✓ ' + t));
    fail.forEach(t => console.log('  ✗ ' + t));
    await s.close();
    try { srv && srv.kill('SIGKILL'); } catch (e) {}
  }
})().catch(e => { console.error(e); process.exit(1); });
