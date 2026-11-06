/* 错题本（薄弱题本）导出/导入 —— UI 端到端冒烟（CDP + Edge，无第三方依赖）
   覆盖：
   1) 空题本也能打开面板并导出合法 JSON；
   2) 导出文本可解析、带版本号；
   3) 导入并合并：新题追加、同题选错次更多的、现有数据不丢；
   4) 非法 JSON 给出可读提示且不改动现有数据；
   5) 版本号不符明确拒绝；
   6) 全程零 console 错误 / 零未捕获异常。
   运行：node .build/_probe_wrongbook.cjs */
const { Session, sleep } = require('./cdp.cjs');

const FILE = 'file:///D:/Projects/_github_pages/ming-games/quiz/index.html';
const results = [];
function check(name, ok, detail) {
    results.push({ name, ok });
    console.log((ok ? '✔ ' : '✘ ') + name + (detail ? ('  [' + detail + ']') : ''));
}
function findBtn(txt) {
    return "(function(){var bs=[].slice.call(document.querySelectorAll('#curOverlay .btn'));"
        + "for(var i=0;i<bs.length;i++){if(bs[i].textContent.indexOf('" + txt + "')>=0)return bs[i];}return null;})()";
}

(async function () {
    const s = await new Session({ width: 414, height: 896 }).open(FILE);
    if (!await s.ensureLoaded()) {
        console.error('页面未完整加载，无法继续');
        process.exit(2);
    }

    const lsOK = await s.eval("(function(){try{localStorage.setItem('__t','1');var v=localStorage.getItem('__t')==='1';localStorage.removeItem('__t');return v;}catch(e){return 'ERR:'+e.message;}})()");
    check('localStorage 可读可写（file:// 环境）', lsOK === true, String(lsOK));

    /* ---- 1. 空题本：面板必须能打开，且带导入入口 ---- */
    const title = await s.eval("(function(){var acts=[].slice.call(document.querySelectorAll('#shelf .section-title .act'));"
        + "for(var i=0;i<acts.length;i++){if(acts[i].textContent.indexOf('薄弱题')>=0){acts[i].click();break;}}"
        + "var h=document.querySelector('#curOverlay .panel h3');return h?h.textContent:'NO_OVERLAY';})()");
    check('空题本也能打开题本面板', String(title).indexOf('薄弱题本') >= 0, String(title));
    check('空题本面板带导出/导入文本框', await s.eval("!!document.querySelector('#curOverlay .wbio')") === true);

    /* ---- 2. 空题本导出：合法 JSON、count=0 ---- */
    const emptyExport = await s.eval("(function(){var b=" + findBtn('导出') + ";var ta=document.querySelector('#curOverlay .wbio');"
        + "if(!b||!ta)return 'MISSING';b.click();return ta.value;})()");
    let emptyJSON = null;
    try {
        emptyJSON = JSON.parse(emptyExport);
    } catch (e) {
        emptyJSON = null;
    }
    check('空题本可导出 JSON 且合法', !!emptyJSON, emptyJSON ? ('v' + emptyJSON.version + ', count=' + emptyJSON.count) : String(emptyExport).slice(0, 80));
    check('导出格式含版本号 v1', !!emptyJSON && emptyJSON.version === 1 && Array.isArray(emptyJSON.data) && emptyJSON.data.length === 0);

    /* 关掉面板，准备种子数据 */
    await s.eval("(function(){var c=document.querySelector('#curOverlay .close');if(c)c.click();return 1;})()");
    await sleep(500);

    /* ---- 3. 写入两条错题（A 错两次 → n=2；B 错一次） ---- */
    const seeded = await s.eval("(function(){"
        + "addWeak({type:'math',q:'E2E 错题 A',a:'1',opts:['1','2','3','4'],pick:'2',exp:'测试解析',tag:'',src:''});"
        + "addWeak({type:'math',q:'E2E 错题 A',a:'1',opts:['1','2','3','4'],pick:'3',exp:'测试解析',tag:'',src:''});"
        + "addWeak({type:'history',q:'E2E 错题 B',a:'B',opts:['A','B'],pick:'A',exp:'测试解析',tag:'',src:''});"
        + "var a=JSON.parse(localStorage.getItem('bt_qa_weak')||'[]');return JSON.stringify(a.map(function(x){return x.type+'|'+x.q+'|'+x.n;}));})()");
    let seedArr = [];
    try {
        seedArr = JSON.parse(seeded);
    } catch (e) { /* 下面断言会失败 */ }
    check('重复答错只累加次数（A 一条 n=2）', seedArr.length === 2 && seedArr.indexOf('math|E2E 错题 A|2') >= 0, String(seeded));

    /* ---- 4. 导出当前题本 → 合并导入（A 更强、B 更弱、C 新增） ---- */
    const title2 = await s.eval("(function(){var acts=[].slice.call(document.querySelectorAll('#shelf .section-title .act'));"
        + "for(var i=0;i<acts.length;i++){if(acts[i].textContent.indexOf('薄弱题')>=0){acts[i].click();break;}}"
        + "var h=document.querySelector('#curOverlay .panel h3');return h?h.textContent:'NO_OVERLAY';})()");
    check('有错题时题本面板正常打开', String(title2).indexOf('薄弱题本') >= 0, String(title2));

    await s.eval("(function(){var b=" + findBtn('导出') + ";if(b)b.click();return 1;})()");
    const merged = await s.eval("(function(){"
        + "var ta=document.querySelector('#curOverlay .wbio');"
        + "var doc=JSON.parse(ta.value);"
        + "doc.data.forEach(function(x){if(x.q==='E2E 错题 A')x.n=9;});"      /* 同题、次数更多 → 应覆盖 */
        + "doc.data.forEach(function(x){if(x.q==='E2E 错题 B')x.n=1;});"      /* 同题、次数更少 → 应保留本地 */
        + "doc.data.push({type:'geo',q:'E2E 导入题 C',a:'C',opts:['C','D'],n:7,t:Date.now(),srs:{lv:1,due:Date.now()+86400000}});"
        + "ta.value=JSON.stringify(doc);"
        + "var b=" + findBtn('导入') + ";if(!b)return 'NO_IMPORT_BTN';b.click();return 'CLICKED';})()");
    check('导入按钮可点击', merged === 'CLICKED', String(merged));
    await sleep(900);

    const afterImport = await s.eval("(function(){"
        + "var a=JSON.parse(localStorage.getItem('bt_qa_weak')||'[]');"
        + "var m={};a.forEach(function(x){m[x.q]=x.n;});"
        + "return JSON.stringify({len:a.length,A:m['E2E 错题 A'],B:m['E2E 错题 B'],C:m['E2E 导入题 C'],toast:(document.getElementById('toast')||{}).textContent||''});})()");
    let ai = null;
    try {
        ai = JSON.parse(afterImport);
    } catch (e) { /* 断言失败 */ }
    check('导入后数据条数 = 3（不丢不重）', !!ai && ai.len === 3, String(afterImport));
    check('合并：同题取错次更多（A n=9）', !!ai && ai.A === 9, ai ? String(ai.A) : '');
    check('合并：次数更少不覆盖本地（B n=1）', !!ai && ai.B === 1, ai ? String(ai.B) : '');
    check('合并：新题保留（C n=7）', !!ai && ai.C === 7, ai ? String(ai.C) : '');
    check('导入成功后有人话提示', !!ai && ai.toast.indexOf('已合并') >= 0, ai ? ai.toast : '');

    /* ---- 5. 非法 JSON：明确提示、不改数据 ---- */
    const before = await s.eval("localStorage.getItem('bt_qa_weak')");
    const bad = await s.eval("(function(){var ta=document.querySelector('#curOverlay .wbio');if(!ta)return 'NO_TA';"
        + "ta.value='{';var b=" + findBtn('导入') + ";if(!b)return 'NO_IMPORT_BTN';b.click();"
        + "return (document.getElementById('toast')||{}).textContent||'';})()");
    await sleep(200);
    const after = await s.eval("localStorage.getItem('bt_qa_weak')");
    check('非法 JSON 给出可读错误提示', String(bad).indexOf('❌') === 0 && String(bad).indexOf('JSON') >= 0, String(bad));
    check('非法导入不改动现有数据', before === after);

    /* ---- 6. 版本不符：明确拒绝 ---- */
    const badVer = await s.eval("(function(){var ta=document.querySelector('#curOverlay .wbio');if(!ta)return 'NO_TA';"
        + "ta.value=JSON.stringify({version:2,data:[]});var b=" + findBtn('导入') + ";if(!b)return 'NO_IMPORT_BTN';b.click();"
        + "return (document.getElementById('toast')||{}).textContent||'';})()");
    check('版本号不匹配有明确提示', String(badVer).indexOf('版本不匹配') >= 0, String(badVer));

    check('全程零未捕获异常', s.errors.length === 0, s.errors.join(' | ').slice(0, 300));
    const consoleErrors = (s.logs || []).filter(function (x) { return /^error:/.test(x); });
    check('全程零 console.error', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 300));

    await s.close();
    const failed = results.filter(function (r) { return !r.ok; });
    console.log('\n结果：' + (results.length - failed.length) + '/' + results.length + ' 通过' + (failed.length ? ('，失败 ' + failed.length) : ''));
    process.exit(failed.length ? 1 : 0);
})().catch(function (e) {
    console.error('ERR', e);
    process.exit(1);
});
