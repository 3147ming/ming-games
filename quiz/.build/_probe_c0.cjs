/* C0 离线逻辑单测：从真实源码抽取 4.0 段（含 isAcademic/examLike/makeQuizPrompt）在 Node 沙箱执行
   不依赖网络/AI，只验证「学科判定 / 元信息硬过滤 / 命题老师 prompt」的真实代码行为。*/
const fs=require('fs');
const p='D:/Projects/_github_pages/ming-games/quiz/.build/quiz-ui.js';
const src=fs.readFileSync(p,'utf8');

// 截取 4.0 段：从「4.0 自定义题库生成质量」注释到 function aiBuild 之前
var start=src.indexOf('/* ---------- 4.0 自定义题库生成质量');
var end=src.indexOf('function aiBuild(name){');
if(start<0||end<0){console.error('FAIL: 未找到 4.0 段锚点');process.exit(1);}
var block=src.slice(start,end);

// validItem 桩：examLike 末尾调用，这里只验证 META/exp/src 闸门，桩恒真
var validItem=function(){return true;};
var validItemRef=validItem;
var sandbox={validItem:validItemRef,console:console};
var vm=require('vm');
vm.createContext(sandbox);
try{ vm.runInContext(block,sandbox); }catch(e){ console.error('FAIL eval 4.0 block:',e.message); process.exit(1); }

var pass=0,fail=0;
function ok(name,cond){ if(cond){pass++;console.log('  ✓ '+name);} else {fail++;console.log('  ✗ '+name);} }

console.log('--- isAcademic 学科判定 ---');
ok('化学→学术', sandbox.isAcademic('化学')===true);
ok('初中物理→学术', sandbox.isAcademic('初中物理')===true);
ok('人教版九年级→学术', sandbox.isAcademic('人教版九年级化学')===true);
ok('三角洲行动→非学术', sandbox.isAcademic('三角洲行动')===false);
ok('美食→非学术', sandbox.isAcademic('美食')===false);

console.log('--- examLike 元信息硬过滤 ---');
ok('补全词条题→过滤', sandbox.examLike({q:'补全词条：____是为化学实验提供条件的场所',a:'化学实验室',opts:['a','b','c','化学实验室']})===false);
ok('描述的是下列哪项→过滤', sandbox.examLike({q:'「中国普通高等学校本科专业」描述的是下列哪项？',a:'化学工程与工艺',opts:['a','b','c','化学工程与工艺']})===false);
ok('含出版社选项→过滤', sandbox.examLike({q:'下列说法正确是？',a:'x',opts:['x','y','z','高等教育出版社']})===false);
ok('无解析无来源→过滤', sandbox.examLike({q:'下列属于化学变化的是？',a:'铁丝生锈',opts:['冰雪融化','铁丝生锈','酒精挥发','玻璃破碎']})===false);
ok('有解析有来源→通过', sandbox.examLike({q:'下列属于化学变化的是？',a:'铁丝生锈',opts:['冰雪融化','铁丝生锈','酒精挥发','玻璃破碎'],exp:'有新物质生成',src:'人教版九年级化学'})===true);
ok('仅来源无解析→通过(OR语义)', sandbox.examLike({q:'下列变化属于化学变化的是？',a:'B',opts:['A','B','C','D'],src:'中考真题改编'})===true);

console.log('--- makeQuizPrompt 命题老师 prompt ---');
var p1=sandbox.makeQuizPrompt('化学',10,[]);
ok('含「命题老师」', /命题老师/.test(p1));
ok('含「人教版九年级化学」12单元', /人教版九年级化学/.test(p1)&&/走进化学世界/.test(p1)&&/化学与生活/.test(p1));
ok('含禁止元信息题', /普通高等学校本科专业|出版社出版的图书/.test(p1));
ok('含 exp/src 字段要求', /"exp"/.test(p1)&&/"src"/.test(p1));
var p2=sandbox.makeQuizPrompt('三角洲行动',15,[]);
ok('非化学不含化学单元提示', !/走进化学世界/.test(p2));
ok('非化学仍是命题老师', /命题老师/.test(p2));

console.log('\n=== C0 逻辑单测: '+pass+' 通过 / '+fail+' 失败 ===');
process.exit(fail?1:0);
