/* 编程语言闸 + 手写题语言化 + C 规范题库 专项探针（纯 Node 沙箱，复用 _sandbox.cjs）
   验收口径见指令「块 5 · 5.1」：
   1. c 档案：三板块 × 五档 × 100 局，越界 tag = 0、题干/代码/选项里 Java|JavaScript = 0；
      自动模式 200 抽同样 0。
   2. all 档案：抽样能命中 Java（证明「全部语言」仍可用）。
   3. 档案缺失：mode==='unset'，且 UI 提示文案存在。
   4. genHandTask：c → 100% c；js → 100% js；all → 两种都出现；C 题 25 道、r0~r4 各 5；
      每道 sol 含 stdio/main(void)/return 0、无 Tab、缩进为 4 空格倍数。
   5. 回顾局：tag:'java' 的薄弱题在 c 档案下不进场并 toast。 */
const fs = require('fs');
const path = require('path');
const SB = require('./_sandbox.cjs');
const E = SB.E, store = SB.store;
const pass = [], fail = [];
function ck(n, c, e) { (c ? pass : fail).push(n + (e ? ' :: ' + e : '')); }
const KEY = 'bt_qa_profile_code';
function setProfile(p) { if (p == null) delete store[KEY]; else store[KEY] = JSON.stringify(p); }
const P_C = { done: true, langs: ['c'], level: 0, rank: 0 };
const P_JS = { done: true, langs: ['js'], level: 0, rank: 0 };
const P_ALL = { done: true, all: true, langs: [], level: 0, rank: 0 };
function textOf(q) {
  return String(q.q || '') + '\n' + String(q.code || '') + '\n'
    + (Array.isArray(q.opts) ? q.opts.join('\n') : String(q.opts || ''));
}
const SECTIONS = ['choice', 'fill', 'code'];

try {
  /* ---------- 1. c 档案：三板块 × 五档 × 100 局 ---------- */
  setProfile(P_C);
  ck('c 档案 → codeLangState().mode==="only"', E.codeLangState().mode === 'only', E.codeLangState().mode);
  ck('c 档案 → codeAllowedLangs() 恰为 c + all',
    JSON.stringify(E.codeAllowedLangs()) === JSON.stringify(['c', 'all']), JSON.stringify(E.codeAllowedLangs()));
  let badTag = 0, javaHit = 0, totalQ = 0, emptyQ = 0;
  const badSamples = [];
  SECTIONS.forEach(function (sec) {
    E.setSection(sec);
    for (let d = 0; d < 5; d++) {
      for (let i = 0; i < 100; i++) {
        const qs = E.sectionGen('code', 10, d);
        if (!qs || !qs.length) { emptyQ++; continue; }
        qs.forEach(function (q) {
          totalQ++;
          const t = String((q && q.tag) || 'all');
          if (t !== 'c' && t !== 'all') { badTag++; if (badSamples.length < 5)badSamples.push(sec + '/L' + d + ':' + t); }
          if (/Java/.test(textOf(q || {}))) { javaHit++; if (badSamples.length < 5)badSamples.push(sec + '/L' + d + ':Java'); }
        });
      }
    }
  });
  ck('三板块 × 五档 × 100 局：越界 tag = 0', badTag === 0, 'badTag=' + badTag + ' / ' + totalQ + ' 题；' + badSamples.join(','));
  ck('三板块 × 五档 × 100 局：Java/JavaScript 出现 0 次', javaHit === 0, 'javaHit=' + javaHit + '；' + badSamples.join(','));
  ck('三板块 × 五档 × 100 局：无空局', emptyQ === 0, 'emptyQ=' + emptyQ);

  /* 自动模式 200 抽（genAutoOne 路径） */
  E.setSection('choice');
  E.setQ({ typeKey: 'b:code' });
  E.setAutoMode(true);
  let autoBad = 0, autoJava = 0, autoNull = 0;
  for (let i = 0; i < 200; i++) {
    E.setSelfRank(i % 5);
    const q = E.genAutoOne();
    if (!q || !q.q) { autoNull++; continue; }
    const t = String(q.tag || 'all');
    if (t !== 'c' && t !== 'all') autoBad++;
    if (/Java/.test(textOf(q))) autoJava++;
  }
  ck('自动模式 200 抽：越界 tag = 0', autoBad === 0, 'autoBad=' + autoBad);
  ck('自动模式 200 抽：Java/JavaScript 出现 0 次', autoJava === 0, 'autoJava=' + autoJava);
  ck('自动模式 200 抽：都有题', autoNull === 0, 'autoNull=' + autoNull);
  E.setAutoMode(false);

  /* ---------- 2. all 档案：其它语言仍可用 ---------- */
  setProfile(P_ALL);
  ck('all 档案 → codeLangState().mode==="all"', E.codeLangState().mode === 'all', E.codeLangState().mode);
  ck('all 档案 → codeAllowedLangs()===null（不过滤）', E.codeAllowedLangs() === null, String(E.codeAllowedLangs()));
  E.setSection('choice');
  const allTags = {};
  for (let d = 0; d < 5; d++) {
    for (let i = 0; i < 40; i++) {
      E.sectionGen('code', 10, d).forEach(function (q) {
        const t = String((q && q.tag) || 'all'); allTags[t] = (allTags[t] || 0) + 1;
      });
    }
  }
  ck('all 档案抽样能命中 Java', (allTags.java || 0) > 0, JSON.stringify(allTags));
  let allAutoJava = 0;
  E.setQ({ typeKey: 'b:code' });
  for (let i = 0; i < 200; i++) { const q = E.genAutoOne(); if (q && String(q.tag || 'all') === 'java')allAutoJava++; }
  ck('all 档案自动模式也能命中 Java', allAutoJava > 0, 'javaHits=' + allAutoJava);

  /* ---------- 3. 档案缺失：unset + UI 文案 ---------- */
  setProfile(null);
  ck('档案缺失 → codeLangState().mode==="unset"', E.codeLangState().mode === 'unset', E.codeLangState().mode);
  ck('档案缺失 → 不过滤（codeAllowedLangs()===null）', E.codeAllowedLangs() === null, String(E.codeAllowedLangs()));
  /* 旧格式 {done:true,langs:[]} 也必须落回 unset，不能误判成「只出 c」 */
  setProfile({ done: true, skipped: true, langs: [], level: 0, rank: 0 });
  ck('旧档案 {done:true,langs:[]} 兼容为 unset', E.codeLangState().mode === 'unset', E.codeLangState().mode);
  const ui = fs.readFileSync(path.join(__dirname, 'quiz-ui.js'), 'utf8');
  ck('难度面板 unset 红字警示文案存在', ui.indexOf('⚠️ 尚未设置语言：当前会出全部语言题（含 Java / Python / JS）。点这里只出 C / C++') >= 0);
  ck('难度面板 all 灰字文案存在', ui.indexOf('当前出全部语言题（你选择过「跳过」）· 点这里指定语言') >= 0);
  ck('书架卡副标题「全部语言」存在', ui.indexOf("_st2.mode==='only'?") >= 0 && ui.indexOf("'全部语言'") >= 0);
  ck('语言无关补池行已删除', ui.indexOf("fill(poolWith(false),1500)") < 0);
  ck('langGuard 只作用于编程分类', /var out=bk==='code'\?langGuard\(qs\):qs;/.test(ui) && !/bk!=='code'\?langGuard/.test(ui));

  /* ---------- 4. genHandTask 语言化 + C 题库 25 道 ---------- */
  const CT = E.CODE_TASKS;
  const cTasks = CT.filter(function (t) { return t.lang === 'c'; });
  const jsTasks = CT.filter(function (t) { return t.lang === 'js'; });
  ck('C 手写题恰好 25 道', cTasks.length === 25, 'c=' + cTasks.length);
  ck('JS 手写题 25 道（原题库未丢）', jsTasks.length === 25, 'js=' + jsTasks.length);
  const byRank = [0, 0, 0, 0, 0];
  cTasks.forEach(function (t) { if (t.r >= 0 && t.r < 5)byRank[t.r]++; });
  ck('C 题 r0~r4 各 5 道', byRank.every(function (n) { return n === 5; }), byRank.join('/'));
  let solBad = [], indentBad = [], noTab = [];
  cTasks.forEach(function (t, i) {
    const sol = t.sol || '';
    if (sol.indexOf('#include <stdio.h>') < 0) solBad.push(i + ':stdio');
    if (sol.indexOf('int main(void)') < 0) solBad.push(i + ':main');
    if (sol.indexOf('return 0;') < 0) solBad.push(i + ':return');
    if (sol.indexOf('\t') >= 0) noTab.push(i + ':tab');
    if (/\.\.\.（省略）|伪代码/.test(sol)) solBad.push(i + ':省略/伪代码');
    sol.split('\n').forEach(function (line, ln) {
      const m = line.match(/^( +)/);
      if (m && m[1].length % 4 !== 0) indentBad.push(i + ':L' + ln + ':' + m[1].length);
    });
  });
  ck('C 题 sol 均可编译（stdio/main/return）且无省略/伪代码', solBad.length === 0, solBad.slice(0, 8).join(','));
  ck('C 题 sol 无 Tab', noTab.length === 0, noTab.join(','));
  ck('C 题 sol 缩进为 4 空格倍数', indentBad.length === 0, indentBad.slice(0, 8).join(','));
  ck('C 题题干标注「C 语言」', cTasks.every(function (t) { return /C 语言|C语言/.test(t.t); }));
  ck('JS 题题干标注「JavaScript」', jsTasks.every(function (t) { return /JavaScript/.test(t.t); }));

  setProfile(P_C);
  let cWrong = 0;
  for (let i = 0; i < 200; i++) { E.resetHand(); const t = E.genHandTask(i % 5); if (!t || !t.task || t.task.lang !== 'c')cWrong++; }
  ck('c 档案 genHandTask 200 抽 100% 是 C 题', cWrong === 0, 'wrong=' + cWrong);
  setProfile(P_JS);
  let jsWrong = 0;
  for (let i = 0; i < 200; i++) { E.resetHand(); const t = E.genHandTask(i % 5); if (!t || !t.task || t.task.lang !== 'js')jsWrong++; }
  ck('js 档案 genHandTask 200 抽 100% 是 JS 题', jsWrong === 0, 'wrong=' + jsWrong);
  setProfile(P_ALL);
  const mix = {};
  for (let i = 0; i < 200; i++) { E.resetHand(); const t = E.genHandTask(i % 5); if (t && t.task)mix[t.task.lang] = (mix[t.task.lang] || 0) + 1; }
  ck('all 档案手写题两种语言都出现', (mix.c || 0) > 0 && (mix.js || 0) > 0, JSON.stringify(mix));
  /* 判分 prompt 带语言 */
  ck('AI 判分 prompt 写入语言标签', ui.indexOf("var langLabel=(t.lang==='c')?'C 语言'") >= 0 || ui.indexOf("langLabel=(t.lang==='c')") >= 0);
  ck('AI 判分 prompt 按语言书写规范评判', ui.indexOf('请按该语言书写规范评判') >= 0);

  /* ---------- 5. 回顾局：tag:'java' 不进场并 toast ---------- */
  setProfile(P_C);
  E.setToast('');
  E.setQ({ reviewMode: false, reviewOne: false });
  const weakItem = { q: 'Java 里哪个关键字定义接口？', a: 'interface', tag: 'java', opts: null };
  E.startReviewOne(weakItem);
  const st = E.getState();
  ck('tag:java 薄弱题在 c 档案下不进场', st.reviewMode !== true && st.reviewOne !== true,
    'reviewMode=' + st.reviewMode + ' reviewOne=' + st.reviewOne);
  ck('tag:java 薄弱题被拦后有 toast', /不属于当前语言/.test(E.getToast()), JSON.stringify(E.getToast()));
  ck('拦下后 qlist 为空', !st.qlist || st.qlist.length === 0, 'len=' + ((st.qlist || []).length));
  /* 正向对照：c 题可以进场 */
  E.setToast('');
  E.setQ({ reviewMode: false, reviewOne: false });
  E.startReviewOne({ q: 'C 语言里 int 占几字节？', a: '4', tag: 'c', opts: null });
  const st2 = E.getState();
  ck('tag:c 薄弱题可以正常进场（正向对照）', st2.reviewMode === true, 'reviewMode=' + st2.reviewMode);
} catch (e) {
  fail.push('探针异常 :: ' + e.message + ' @ ' + (e.stack || '').split('\n')[1]);
}

console.log('\n=== 编程语言闸专项：' + pass.length + '/' + (pass.length + fail.length) + ' 通过 ===');
pass.forEach(function (t) { console.log('  ✓ ' + t); });
fail.forEach(function (t) { console.log('  ✗ ' + t); });
process.exit(fail.length ? 1 : 0);
