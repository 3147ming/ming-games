// 设置面板「服务商 + 模型」两级联动专项探针
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { Session, sleep } = require('./cdp.cjs');

const PORT = 8856;
const APP = process.argv[2] || ('http://127.0.0.1:' + PORT + '/quiz/');
const USE_LOCAL = !process.argv[2];
const pass = [], fail = [];
function ck(n, c, e) { (c ? pass : fail).push(n + (e ? ' :: ' + e : '')); }
const clickText = (sel, txt) => `(function(){var a=[].slice.call(document.querySelectorAll('${sel}'));var e=a.filter(function(x){return (x.textContent||'').indexOf('${txt}')>=0;})[0];if(e){e.click();return true;}return false;})()`;

(async () => {
  const srv = USE_LOCAL ? spawn(process.execPath, [path.join(__dirname, 'serve.cjs'), String(PORT)], { stdio: 'ignore' }) : null;
  if (USE_LOCAL) await sleep(700);
  const s = new Session({ width: 414, height: 896, port: 9356 });
  try {
    await s.open(APP);
    await s.eval("localStorage.setItem('bt_qa_quickjump','true');1");
    await s.waitFor('!!document.querySelector(".book")', 15000);
    // 清空 AI 配置，模拟全新用户
    await s.eval(`localStorage.removeItem('bt_qa_ai');1`);
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);

    const openSettings = async () => {
      await s.eval(`(function(){var o=document.querySelector('.ov');if(o){var c=o.querySelector('.close');if(c)c.click();}return 1;})()`);
      await sleep(150);
      await s.eval(`document.getElementById('settingsBtn').click();1`);
      await s.waitFor(`!!document.getElementById('aiProvider')`, 6000);
      await sleep(200);
    };
    const switchProv = async (id) => {
      await s.eval(`(function(){var p=document.getElementById('aiProvider');p.value=${JSON.stringify(id)};p.dispatchEvent(new Event('change'));return p.value;})()`);
      await sleep(150);
    };

    // ---------- A. 新用户默认「自定义」，模型下拉隐藏 ----------
    await openSettings();
    const provCount = await s.eval(`document.querySelectorAll('#aiProvider option').length`);
    const defPid = await s.eval(`document.getElementById('aiProvider').value`);
    const selHidden = await s.eval(`getComputedStyle(document.getElementById('aiModel')).display==='none'`);
    const inpShown = await s.eval(`getComputedStyle(document.getElementById('aiModelInput')).display!=='none'`);
    ck('服务商下拉有 8 项（7 家 + 自定义）', provCount === 8, 'n=' + provCount);
    ck('默认选「自定义」', defPid === 'custom', defPid);
    ck('自定义时模型下拉隐藏、手填框可见', selHidden && inpShown, 'sel=' + selHidden + ' input=' + inpShown);

    // ---------- B. 切 DeepSeek：地址自动填 + 模型列表刷新 ----------
    await switchProv('deepseek');
    const url1 = await s.eval(`document.getElementById('aiUrl').value`);
    const modelOpts = await s.eval(`JSON.stringify([].slice.call(document.querySelectorAll('#aiModel option')).map(function(o){return o.value;}))`);
    const selShown = await s.eval(`getComputedStyle(document.getElementById('aiModel')).display!=='none'`);
    const inpHidden = await s.eval(`getComputedStyle(document.getElementById('aiModelInput')).display==='none'`);
    ck('切 DeepSeek 自动填地址', url1 === 'https://api.deepseek.com/v1/chat/completions', url1);
    ck('模型下拉出现 deepseek-chat / deepseek-reasoner', modelOpts === '["deepseek-chat","deepseek-reasoner"]', modelOpts);
    ck('预设服务商时模型下拉可见、手填框隐藏', selShown && inpHidden, 'sel=' + selShown + ' inputHidden=' + inpHidden);

    // ---------- C. 选模型 → 自动填模型名 ----------
    await s.eval(`(function(){var m=document.getElementById('aiModel');m.value='deepseek-reasoner';m.dispatchEvent(new Event('change'));return 1;})()`);
    await sleep(120);
    const modelVal = await s.eval(`document.getElementById('aiModelInput').value`);
    ck('选 deepseek-reasoner 后模型名自动填入', modelVal === 'deepseek-reasoner', modelVal);
    await s.eval(`(function(){var m=document.getElementById('aiModel');m.value='deepseek-chat';m.dispatchEvent(new Event('change'));return 1;})()`);
    await sleep(120);
    ck('选 deepseek-chat 后模型名自动填入', (await s.eval(`document.getElementById('aiModelInput').value`)) === 'deepseek-chat');

    // ---------- D. 切回自定义：下拉消失、手填恢复 ----------
    await switchProv('custom');
    const backHidden = await s.eval(`getComputedStyle(document.getElementById('aiModel')).display==='none'`);
    const backShown = await s.eval(`getComputedStyle(document.getElementById('aiModelInput')).display!=='none'`);
    const keepModel = await s.eval(`document.getElementById('aiModelInput').value`);
    const keepUrl = await s.eval(`document.getElementById('aiUrl').value`);
    ck('切回自定义：模型下拉消失、手填框恢复', backHidden && backShown, 'sel=' + backHidden + ' input=' + backShown);
    ck('切回自定义不丢失已填地址与模型', keepUrl === 'https://api.deepseek.com/v1/chat/completions' && keepModel === 'deepseek-chat', keepUrl + ' | ' + keepModel);

    // ---------- E. 地址等于旧默认才替换（手改过的不覆盖） ----------
    await s.eval(`(function(){document.getElementById('aiUrl').value='https://my-relay.example.com/v1/chat/completions';return 1;})()`);
    await switchProv('qwen');
    const keepRelay = await s.eval(`document.getElementById('aiUrl').value`);
    ck('手填过的地址切服务商不被覆盖', keepRelay === 'https://my-relay.example.com/v1/chat/completions', keepRelay);
    const qwenOpts = await s.eval(`JSON.stringify([].slice.call(document.querySelectorAll('#aiModel option')).map(function(o){return o.value;}))`);
    ck('切通义千问刷新为 qwen 三档', qwenOpts === '["qwen-turbo","qwen-plus","qwen-max"]', qwenOpts);

    // ---------- F. 保存仍只存 4 个键 ----------
    await s.eval(`document.getElementById('aiUrl').value='';1`);
    await switchProv('deepseek');
    await s.eval(`(function(){document.getElementById('aiKey').value='sk-test-123';return 1;})()`);
    await s.eval(clickText('#curOverlay .btn', '保存配置'));
    await sleep(200);
    const stored = await s.eval(`localStorage.getItem('bt_qa_ai')`);
    let keys = [];
    try { keys = Object.keys(JSON.parse(stored)).sort(); } catch (e) {}
    ck('保存只写 url/key/model/proxy 四个键', JSON.stringify(keys) === '["key","model","proxy","url"]', JSON.stringify(keys));
    ck('保存内容为 DeepSeek 地址 + deepseek-chat', /deepseek\.com/.test(stored) && /deepseek-chat/.test(stored), stored);

    // ---------- G. 重开设置：旧配置原样回显并自动匹配服务商 ----------
    await openSettings();
    const p2 = await s.eval(`document.getElementById('aiProvider').value`);
    const u2 = await s.eval(`document.getElementById('aiUrl').value`);
    const m2 = await s.eval(`document.getElementById('aiModelInput').value`);
    const ms2 = await s.eval(`document.getElementById('aiModel').value`);
    ck('重开设置：按地址自动回显 DeepSeek', p2 === 'deepseek', p2);
    ck('重开设置：地址 / 模型原样显示', u2 === 'https://api.deepseek.com/v1/chat/completions' && m2 === 'deepseek-chat' && ms2 === 'deepseek-chat', u2 + ' | ' + m2 + ' | sel=' + ms2);

    // 老配置（不匹配任何预设）→ 自定义 + 原值
    await s.eval(`localStorage.setItem('bt_qa_ai',JSON.stringify({url:'https://old.example.com/api',key:'k',model:'my-legacy-model',proxy:''}));1`);
    await openSettings();
    const p3 = await s.eval(`document.getElementById('aiProvider').value`);
    const u3 = await s.eval(`document.getElementById('aiUrl').value`);
    const m3 = await s.eval(`document.getElementById('aiModelInput').value`);
    ck('旧配置（非预设地址）回落自定义且原样显示', p3 === 'custom' && u3 === 'https://old.example.com/api' && m3 === 'my-legacy-model', p3 + ' | ' + u3 + ' | ' + m3);

    // ---------- H. 测试连接：testAI 语义（HTTP 2xx = 成功，不校验返回内容） ----------
    // 桩：抓真实出站请求 + 按模式返回 ok / 401 / 网络错误
    const installStub = (mode) => s.eval(`(function(){
      if(!window.__realFetch)window.__realFetch=window.fetch;
      window.__cap=null;window.__stubMode=${JSON.stringify(mode)};
      window.fetch=function(u,o){
        window.__cap={url:String(u),auth:(o&&o.headers&&o.headers.Authorization)||'',body:(o&&o.body)||''};
        if(window.__stubMode==='ok')return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve({choices:[{message:{content:'连接成功'}}]});}});
        if(window.__stubMode==='401')return Promise.resolve({ok:false,status:401,json:function(){return Promise.resolve({error:{message:'invalid api key'}});}});
        return Promise.reject(new TypeError('Failed to fetch'));
      };
      return 1;})()`);
    const fillZhipu = () => s.eval(`(function(){
      document.getElementById('aiUrl').value='https://open.bigmodel.cn/api/paas/v4/chat/completions';
      document.getElementById('aiKey').value='zk-1';
      var m=document.getElementById('aiModel');m.value='glm-4';m.dispatchEvent(new Event('change'));
      return 1;})()`);
    const clickTest = () => s.eval(clickText('#curOverlay .btn', '测试连接'));
    const hintText = () => s.eval(`document.querySelector('#curOverlay .hint').textContent`);

    await switchProv('zhipu');
    const zhipuOpts = await s.eval(`JSON.stringify([].slice.call(document.querySelectorAll('#aiModel option')).map(function(o){return o.value;}))`);
    ck('智谱下拉前三项为 glm-4 / glm-4-plus / glm-3-turbo', /^\["glm-4","glm-4-plus","glm-3-turbo"(,|\])/.test(zhipuOpts), zhipuOpts);

    await fillZhipu();
    await installStub('ok');
    await clickTest();
    await sleep(400);
    let cap = await s.eval(`JSON.stringify(window.__cap)`);
    let tm = await hintText();
    ck('测试连接用表单里的地址 + Key + 模型名', /open\.bigmodel\.cn/.test(cap) && /zk-1/.test(cap) && /glm-4/.test(cap), cap);
    ck('测试连接发「请只回复两个字：连接成功」探测消息', /请只回复两个字：连接成功/.test(cap), cap);
    ck('HTTP 2xx → 显示「✅ 连接成功」', /✅ 连接成功/.test(tm), tm);

    await installStub('401');
    await clickTest();
    await sleep(400);
    tm = await hintText();
    ck('HTTP 401 → 显示「❌ 失败：HTTP 401」', /❌ 失败：HTTP 401/.test(tm), tm);

    await installStub('net');
    await clickTest();
    await sleep(400);
    tm = await hintText();
    ck('网络错误 → 显示「❌ 失败：网络错误」', /❌ 失败：网络错误/.test(tm), tm);

    await s.eval(`(function(){if(window.__realFetch)window.fetch=window.__realFetch;return 1;})()`);

    // ---------- J. 免费 AI 通道（Pollinations·无需 Key） ----------
    await s.eval(`(function(){var o=document.querySelector('#curOverlay .close');if(o)o.click();return 1;})()`);
    await sleep(200);
    await s.eval(`localStorage.removeItem('bt_qa_ai');1`);
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);
    await openSettings();
    await switchProv('free');
    const freeUrl = await s.eval(`document.getElementById('aiUrl').value`);
    const freeOpts = await s.eval(`JSON.stringify([].slice.call(document.querySelectorAll('#aiModel option')).map(function(o){return o.value;}))`);
    ck('选「免费 AI」自动填 Pollinations 地址', freeUrl === 'https://text.pollinations.ai/openai', freeUrl);
    ck('免费通道模型下拉为 openai', freeOpts === '["openai"]', freeOpts);
    await s.eval(clickText('#curOverlay .btn', '保存配置'));
    await sleep(200);
    await s.eval(`(function(){var o=document.querySelector('#curOverlay .close');if(o)o.click();return 1;})()`);
    await sleep(200);
    await openSettings();
    const freePid = await s.eval(`document.getElementById('aiProvider').value`);
    const freeKey = await s.eval(`document.getElementById('aiKey').value`);
    ck('免费配置（空 Key）重开后回显「免费 AI」服务商', freePid === 'free' && freeKey === '', 'pid=' + freePid + ' key=' + JSON.stringify(freeKey));
    await installStub('ok');
    await clickTest();
    await sleep(400);
    const freeCap = await s.eval(`JSON.stringify(window.__cap)`);
    const freeTm = await hintText();
    ck('免费通道空 Key 可点测试连接 → ✅ 连接成功', /✅ 连接成功/.test(freeTm), freeTm);
    ck('免费通道空 Key 不发 Authorization 头', !/"auth":"Bearer/.test(freeCap), freeCap);
    ck('免费通道请求带 reasoning_effort=low', /reasoning_effort/.test(freeCap), freeCap.slice(0, 160));
    // 付费服务商仍然拦空 Key
    await s.eval(`(function(){var p=document.getElementById('aiProvider');p.value='deepseek';p.dispatchEvent(new Event('change'));document.getElementById('aiKey').value='';return 1;})()`);
    await sleep(200);
    await clickTest();
    await sleep(200);
    const paidNoKey = await hintText();
    ck('付费服务商空 Key 仍提示先填 Key', /请先填 API 地址与 Key/.test(paidNoKey), paidNoKey);
    await s.eval(`(function(){if(window.__realFetch)window.fetch=window.__realFetch;return 1;})()`);
    // 已有旧自定义配置的用户选免费通道，也要零配置可用
    await s.eval(`localStorage.setItem('bt_qa_ai',JSON.stringify({url:'https://old.example.com/api',key:'k',model:'my-legacy-model',proxy:''}));1`);
    await s.reload();
    await s.waitFor('!!document.querySelector(".book")', 12000);
    await openSettings();
    await switchProv('free');
    const legacyUrl = await s.eval(`document.getElementById('aiUrl').value`);
    const legacyModel = await s.eval(`document.getElementById('aiModelInput').value`);
    ck('有旧自定义配置时选免费通道也自动填地址', legacyUrl === 'https://text.pollinations.ai/openai', legacyUrl);
    ck('有旧自定义配置时选免费通道模型归位 openai', legacyModel === 'openai', legacyModel);

    // ---------- I. AI 生成题库入口不受影响 ----------
    await s.eval(`(function(){var c=document.querySelector('#curOverlay .close');if(c)c.click();return 1;})()`);
    await sleep(200);
    await s.eval(`(function(){var a=document.querySelector('.section-title .act');if(a){a.click();return 1;}return 0;})()`);
    await s.waitFor(`document.body.textContent.indexOf('免费搜索')>=0`, 5000);
    const modes = await s.eval(`['AI 生成','免费搜索','手动录入'].filter(function(t){return document.body.textContent.indexOf(t)>=0;}).join(',')`);
    ck('新建分类面板三条通道都在', modes.split(',').length === 3, modes);
    await s.eval(clickText('#curOverlay .btn', '取消') + '||1');
    await sleep(200);

    // ---------- J. 布局与异常 ----------
    await openSettings();
    const of = await s.eval(`document.documentElement.scrollWidth<=document.documentElement.clientWidth+1`);
    ck('设置面板无横向溢出', of);
    const r = await s.send('Page.captureScreenshot', { format: 'png' });
    if (!fs.existsSync(path.join(__dirname, 'shots'))) fs.mkdirSync(path.join(__dirname, 'shots'));
    fs.writeFileSync(path.join(__dirname, 'shots', 'ai-presets.png'), Buffer.from(r.data, 'base64'));

    const errs = s.errors.filter(e => !/favicon|sw\.js|SW /i.test(e));
    ck('无 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));
  } catch (e) {
    fail.push('EXCEPTION :: ' + e.message);
  } finally {
    console.log('\n=== 设置面板 AI 服务商联动：' + pass.length + '/' + (pass.length + fail.length) + ' 通过 ===');
    pass.forEach(t => console.log('  ✓ ' + t));
    fail.forEach(t => console.log('  ✗ ' + t));
    await s.close();
    try { srv && srv.kill('SIGKILL'); } catch (e) {}
  }
})();
