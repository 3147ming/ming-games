/* 4.0.1-4 +B：autoRefill 的 fresh 过滤从「严格 examLike」改为「refillOk 降级收下」 */
const fs = require('fs');
const F = 'D:/Projects/_github_pages/ming-games/quiz/.build/quiz-ui.js';
let s = fs.readFileSync(F, 'utf8');
function rep(o, n, t) {
  const c = s.split(o).length - 1;
  if (c !== 1) { console.log('ANCHOR FAIL[' + t + '] count=' + c); process.exit(1); }
  s = s.split(o).join(n);
  console.log('  ok ' + t);
}

/* 1) 新增 refillOk —— 放在 autoRefillOn 与 autoRefill 之间 */
rep(
`function autoRefillOn(){try{return JSON.parse(S.getItem('bt_qa_autorefill')||'false')===true;}catch(e){return false;}}
function autoRefill(cn){`,
`function autoRefillOn(){try{return JSON.parse(S.getItem('bt_qa_autorefill')||'false')===true;}catch(e){return false;}}
/* 4.0.1-4 +B：静默补题「宁缺毋滥」改为「降级收下」—— 缺解析/来源的题打占位入库，
   其余闸（元信息/坏选项）保持 examLike 硬过滤；显式 AI 生成入口仍走严格 examLike 不变。
   背景：examLike 的 !q.exp&&!q.src 闸会把弱模型漏带这两个字段的整批题全拒（新增 0 题），
   而补题是静默后台行为，宁可收下带占位标记的题，也不要整批丢弃。 */
function refillOk(x){
  if(!x||!x.q||!x.a)return false;
  if(!x.exp&&!x.src)x.exp='（AI 生成，暂无解析）';   // 打占位后 examLike 的 exp||src 闸必过
  return examLike(x);
}
function autoRefill(cn){`, 'R1');

/* 2) fresh 过滤改用 refillOk */
rep(
`      /* P0-5：静默补题也必须过 validItem，坏题一律不入库
         4.0.1-4：补题走的是出题 prompt，只过 validItem 会把百科/书目题漏进来 → 改用 examLike */
      var fresh=res.filter(function(x){return x&&x.q&&!exist[x.q]&&examLike(x);});`,
`      /* P0-5：静默补题也必须过校验，坏题一律不入库
         4.0.1-4：补题走的是出题 prompt，只过 validItem 会把百科/书目题漏进来 → 改用 examLike
         4.0.1-4 +B：缺 exp/src 不再整批拒（弱模型常见），改由 refillOk 打占位降级收下 */
      var fresh=res.filter(function(x){return x&&x.q&&!exist[x.q]&&refillOk(x);});`, 'R2');

fs.writeFileSync(F, s, 'utf8');
console.log('OK quiz-ui.js');
