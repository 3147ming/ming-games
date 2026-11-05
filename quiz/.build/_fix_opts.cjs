/* 修复 CODE_TOPICS 中若干生成器的干扰项可能与答案/彼此重复 → 只出 3 选项的问题。
   新增 pickAlts(ans,cands) 辅助函数，保证返回 3 个互不相同的非答案干扰项。 */
const fs = require('fs');
const DIR = 'D:/Projects/_github_pages/ming-games/quiz/.build';
const F = DIR + '/code_engine.js';
let s = fs.readFileSync(F, 'utf8');

function once(hay, needle, label) {
  const n = hay.split(needle).length - 1;
  if (n !== 1) { console.error('✗ 锚点不唯一或缺失 [' + label + ']：命中 ' + n); process.exit(1); }
}
function rep(hay, oldS, newS, label) {
  once(hay, oldS, label);
  return hay.replace(oldS, newS);
}

/* 1) 新增 pickAlts 辅助函数（紧跟 squareSumOdd 之后） */
const OLD_HELPER = 'function squareSumOdd(n){var s=0;for(var i=1;i<=n;i++)if(i%2) s+=i;return s;}';
const NEW_HELPER = OLD_HELPER + `
function pickAlts(ans,cands){
  var seen={},out=[],a=String(ans);
  seen[a]=1;
  (cands||[]).forEach(function(c){c=String(c);if(!seen[c]&&out.length<3){seen[c]=1;out.push(c);}});
  var pad=0;
  while(out.length<3){var p='#'+pad;if(!seen[p]){seen[p]=1;out.push(p);}pad++;}
  return out;
}`;
s = rep(s, OLD_HELPER, NEW_HELPER, 'helper');

/* 2) 十进制转十六进制：干扰项去重（n+1 与 parseInt+1 重复） */
s = rep(s,
  "[h==='1A'?'2A':String(n+1),String(parseInt(h,16)+1),'0x'+h]",
  "pickAlts(h,['0x'+h,String(n+1),String(n+2),String(n*2)])",
  'hex16');

/* 3) printf 连续输出：拼接题的干扰项避免与答案/彼此重复 */
s = rep(s,
  "String(a)+String(b),[String(a+b),String(a*10+b),String(b)+String(a)],",
  "String(a)+String(b),pickAlts(String(a)+String(b),[String(a+b),String(b)+String(a),String(a)+String(b+1),String(a+1)+String(b)]),",
  'printfconcat');

/* 4) 数组下标：用同数组其余 3 个元素作干扰项，避免 v[i]+1 撞值 */
s = rep(s,
  "var v=[riN(1,9),riN(10,19),riN(20,29),riN(30,39)],i=riN(0,3);",
  "var v=[riN(1,9),riN(10,19),riN(20,29),riN(30,39)],i=riN(0,3);\n    var others=v.filter(function(x){return x!==v[i];});",
  'arrvar');
s = rep(s,
  "String(v[i]),[String(v[(i+1)%4]),String(v[(i+2)%4]),String(v[i]+1)],",
  "String(v[i]),pickAlts(String(v[i]),others.map(String)),",
  'arralts');

/* 5) 字符串下标字符：从字符串中取互不相同的其它字符，避免 'hello' 的 l 重复 */
s = rep(s,
  "var s=['hello','world','abcde'][riN(0,2)],i=riN(0,2);",
  "var s=['hello','world','abcde'][riN(0,2)],i=riN(0,2);\n    var cands=[];\n    for(var j=0;j<s.length;j++){var ch=s.charAt(j);if(ch!==s.charAt(i)&&cands.indexOf(ch)<0)cands.push(ch);}\n    while(cands.length<3)cands.push(String.fromCharCode(65+cands.length));",
  'strcharvar');
s = rep(s,
  "s.charAt(i),[s.charAt((i+1)%s.length),s.charAt(s.length-1-i),String(i)],",
  "s.charAt(i),pickAlts(s.charAt(i),cands),",
  'strcharalts');

/* 6) 二进制1的个数：x%8 在 c<8 时等于答案，改用 c+1/c+2/c+3 */
s = rep(s,
  "String(c),[String(c+1),String(c-1),String(x%8)],",
  "String(c),[String(c+1),String(c+2),String(c+3)],",
  'bitcount');

/* 7) 无符号溢出回绕：a+b≤255 时等于答案，改用安全干扰项 */
s = rep(s,
  "String(r),[String(a+b),String(255-r),String(256-r)],",
  "String(r),pickAlts(r,[String(256-r),String(255-r),String(r>0?r-1:1)]),",
  'uoverflow');

fs.writeFileSync(F, s, 'utf8');
console.log('OK 修复完成，code_engine.js 字节=' + Buffer.byteLength(s, 'utf8'));
