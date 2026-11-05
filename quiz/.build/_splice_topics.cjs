/* 把 CODE_TOPICS 矩阵 + 新 genSection + 新手写题 拼进 code_engine.js（锚点唯一性校验） */
const fs = require('fs');
const DIR = 'D:/Projects/_github_pages/ming-games/quiz/.build';
const F = DIR + '/code_engine.js';
let s = fs.readFileSync(F, 'utf8');
const matrix = fs.readFileSync(DIR + '/_topics_block.js', 'utf8');

function assertOnce(hay, needle, label) {
  const n = hay.split(needle).length - 1;
  if (n !== 1) { console.error('✗ 锚点不唯一或缺失 [' + label + ']：命中 ' + n + ' 次'); process.exit(1); }
}

/* ---- 区域 A：替换 CODE_GEN_CODE IIFE 为 CODE_TOPICS 矩阵 ---- */
assertOnce(s, 'var CODE_GEN_CODE={}', 'A_START');
assertOnce(s, '/* 程序编写板块组题', 'A_END_MARK');
const iM = s.indexOf('/* 程序编写板块组题');
const iEndA = s.lastIndexOf('})();', iM); // CODE_GEN_CODE IIFE 的收尾
const iStartA = s.indexOf('var CODE_GEN_CODE={}');
if (iEndA < iStartA) { console.error('✗ 区域 A 边界错误'); process.exit(1); }
s = s.slice(0, iStartA) + matrix + s.slice(iEndA + 5); // 5 = '})();'
console.log('✓ 区域 A 替换完成（矩阵已植入）');

/* ---- 区域 B：替换 genSection ---- */
const NEW_GEN = `QA_TYPES.code.genSection=function(n,diff){
  n=Math.max(1,n|0);
  var dd=(typeof diff==='number'&&diff>=0&&diff<5)?diff:0;
  var allowed=codeAllowedLangs();
  function poolFor(d){
    var arr=CODE_TOPICS.filter(function(t){
      return t.ranks.indexOf(d)>=0 && (!allowed||allowed.indexOf(t.lang)>=0);
    });
    return arr;
  }
  var pool=poolFor(dd);
  if(pool.length<2){
    var alt=[dd-1,dd+1,dd-2,dd+2];
    for(var i=0;i<alt.length;i++){
      if(alt[i]<0||alt[i]>4)continue;
      pool=pool.concat(poolFor(alt[i]));
      if(pool.length>=4)break;
    }
  }
  var out=[],seen={},guard=0;
  function qk(q){return q.q+'\\u0001'+(q.code||'');}
  while(out.length<n&&pool.length&&guard++<1500){
    var t=pool[riN(0,pool.length-1)],q=null;
    try{q=t.gen();}catch(e){continue;}
    if(!q||!q.q||q.a==null)continue;
    if(seen[qk(q)])continue;
    q.tag=q.tag||t.lang||t.k;
    seen[qk(q)]=1;out.push(q);
  }
  if(out.length<n){
    var more=QA_TYPES.code.gen(n-out.length,dd);
    more.forEach(function(q){
      if(out.length>=n||!q||seen[qk(q)])return;
      seen[qk(q)]=1;out.push(q);
    });
  }
  return out.slice(0,n);
};`;

assertOnce(s, 'QA_TYPES.code.genSection=function(n,diff){', 'B_START');
assertOnce(s, '/* ===== 手写代码题', 'B_END_MARK');
const iB = s.indexOf('QA_TYPES.code.genSection=function(n,diff){');
const iH = s.indexOf('/* ===== 手写代码题');
const iEndB = s.lastIndexOf('};', iH);
if (iEndB < iB) { console.error('✗ 区域 B 边界错误'); process.exit(1); }
s = s.slice(0, iB) + NEW_GEN + s.slice(iEndB + 2);
console.log('✓ 区域 B 替换完成（genSection 已按档位重写）');

/* ---- 区域 C：CODE_TASKS 末尾追加 r0/r1 基础手写题 ---- */
const NEW_TASKS = `  {r:0,t:'写一行 C 代码，用 printf 输出数字 5。',ex:'输出：5',tip:'printf + %d',
   sol:'printf("%d", 5);',
   steps:['printf 的 %d 占位符对应一个整数','把 5 填进去：printf("%d", 5);']},
  {r:0,t:'写一行 C 代码，声明 int 变量 x 并赋值为 3。',ex:'x 的值是 3',tip:'类型 变量名 = 值;',
   sol:'int x = 3;',
   steps:['先写类型 int','再写变量名 x，用 = 赋初值 3，结尾分号']},
  {r:0,t:'写一行 C 代码，让 int 变量 a 自增 1。',ex:'a 的值 +1',tip:'a++ 或 a+=1',
   sol:'a++;',
   steps:['自增就是 a = a + 1','简写 a++ 或 a += 1 都行']},
  {r:0,t:'写一段 C 代码：x 大于 0 时输出 "正数"。',ex:'x=1 时输出 正数',tip:'if (x > 0)',
   sol:'if (x > 0) { printf("正数"); }',
   steps:['if 条件判断 x > 0','成立就执行花括号里的 printf']},
  {r:0,t:'写一段 C 代码：x 是偶数时输出 "偶"，否则输出 "奇"。',ex:'x=4 输出 偶，x=3 输出 奇',tip:'x % 2 == 0 判断奇偶',
   sol:'if (x % 2 == 0) printf("偶"); else printf("奇");',
   steps:['x % 2 == 0 是偶数、== 1 是奇数','if 处理偶数，else 处理奇数']},
  {r:1,t:'写一段 C 代码：用 for 循环打印 1 到 5。',ex:'输出 12345',tip:'for (int i=1; i<=5; i++)',
   sol:'for (int i = 1; i <= 5; i++) printf("%d", i);',
   steps:['for 三部分：初值 i=1、条件 i<=5、步进 i++','循环体 printf 打印 i']},
  {r:1,t:'写一段 C 代码：用 while 循环把 1 加到 n（n 已声明），结果存 sum。',ex:'n=3 时 sum=6',tip:'while (i <= n)',
   sol:'int i = 1; int sum = 0; while (i <= n) { sum += i; i++; }',
   steps:['计数器 i 从 1 开始','sum 累加 i 后 i 自增','i > n 时循环结束']},
  {r:1,t:'写一段 C 代码：x 在 60 到 100 之间（含）输出 "及格"。',ex:'x=70 输出 及格',tip:'x >= 60 && x <= 100',
   sol:'if (x >= 60 && x <= 100) printf("及格");',
   steps:['两个条件都要满足，用 && 连接','x >= 60 且 x <= 100']}`;

assertOnce(s, "没有重复返回 false']}\n];", 'C_ANCHOR');
const iC = s.indexOf("没有重复返回 false']}\n];");
s = s.slice(0, iC) + "没有重复返回 false']},\n" + NEW_TASKS + "\n];" + s.slice(iC + "没有重复返回 false']}\n];".length);
console.log('✓ 区域 C 完成（CODE_TASKS 追加 8 道基础手写题）');

fs.writeFileSync(F, s, 'utf8');
console.log('OK code_engine.js 字节=' + Buffer.byteLength(s, 'utf8'));

/* 删除临时矩阵文件 */
try { fs.unlinkSync(DIR + '/_topics_block.js'); } catch (e) {}
console.log('✓ 临时矩阵文件已清理');
