/* 线上产物内容复验：把 curl 拉回的 HTML/sw.js 与本地逐项比对。
   用法：node _online_verify.cjs <线上html路径> <线上sw路径> */
const fs = require('fs');
const crypto = require('crypto');
const ROOT = 'D:/Projects/_github_pages/ming-games/';
const onlineHtml = fs.readFileSync(process.argv[2], 'utf8');
const onlineSw = fs.readFileSync(process.argv[3], 'utf8');
const localHtml = fs.readFileSync(ROOT + 'quiz/index.html', 'utf8');
const localSw = fs.readFileSync(ROOT + 'quiz/sw.js', 'utf8');
const deployHtml = fs.readFileSync(ROOT + '_deploy_gym/quiz/index.html', 'utf8');
const deploySw = fs.readFileSync(ROOT + '_deploy_gym/quiz/sw.js', 'utf8');
const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
const pass = [], fail = [];
function ck(name, cond, extra) { (cond ? pass : fail).push(name + (extra ? ' :: ' + extra : '')); }

/* 1) 四方字节一致 */
const h = md5(onlineHtml);
ck('线上 /quiz/ 与源产物 md5 一致', h === md5(localHtml), h);
ck('线上 /quiz/ 与部署包 md5 一致', h === md5(deployHtml));
ck('线上 sw.js 与源 sw.js md5 一致', md5(onlineSw) === md5(localSw));
ck('线上 sw.js 与部署包 sw.js md5 一致', md5(onlineSw) === md5(deploySw));

/* 2) SW 版本号必须等于 HTML 内容哈希（构建链自动生成，防漏改） */
const want = 'quiz-' + h.slice(0, 10);
const got = (onlineSw.match(/var VERSION = '([^']+)';/) || [])[1];
ck('线上 SW 版本号 = 产物内容哈希', got === want, 'want=' + want + ' got=' + got);
ck('线上 SW 版本号非旧的 quiz-v33', got !== 'quiz-v33');

/* 3) 本批所有改动都必须出现在线上 HTML 里 */
const markers = [
  ['三态语言档案', "function codeLangState()"],
  ['语言闸', 'function langGuard('],
  ['手写题语言判定', 'function handLangInfo('],
  ['语言无关补池已删除的旁证：严格按语言出题', 'codeAllowedLangs()'],
  ['C 手写题库标记（25 道）', "lang:'c',c:1"],
  ['JS 手写题题面', '用 JavaScript 写一个函数'],
  ['C 手写题题面', '用 C 语言写'],
  ['AI 判分语言提示', '（请按该语言书写规范评判'],
  ['难度面板语言警示', '尚未设置语言'],
  ['书架语言副标题', '全部语言'],
  ['C 规范注释', 'C 代码规范（本项目统一）'],
];
markers.forEach(([name, needle]) => ck('线上含「' + name + '」', onlineHtml.indexOf(needle) >= 0));

/* 4) 静态计数：语言无关补池行必须彻底消失 */
ck('语言无关补池行已删除', onlineHtml.indexOf('fill(poolWith(false),1500)') < 0);
const cCount = (onlineHtml.match(/\{r:\d,lang:'c',c:1/g) || []).length;
const jsCount = (onlineHtml.match(/用 JavaScript 写一个函数/g) || []).length;
ck('C 手写题 = 25 道', cCount === 25, 'got=' + cCount);
ck('JS 手写题 = 25 道', jsCount === 25, 'got=' + jsCount);

/* 5) 内联脚本语法 */
const m = onlineHtml.match(/<script>([\s\S]*?)<\/script>/);
let parseOk = false;
try { if (m) { new Function(m[1]); parseOk = true; } } catch (e) { parseOk = false; }
ck('线上内联脚本可解析', parseOk);
ck('线上 HTML 字节数合理（>400KB）', Buffer.byteLength(onlineHtml, 'utf8') > 400000,
   String(Buffer.byteLength(onlineHtml, 'utf8')));

console.log('\n=== 线上复验结果：' + pass.length + '/' + (pass.length + fail.length) + ' 通过 ===');
fail.forEach((x) => console.log('  ✗ ' + x));
if (fail.length) process.exit(1);
console.log('OK');
