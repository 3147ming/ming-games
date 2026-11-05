/* 一次性施工脚本：C7 自动升档挑战（主指令 4.2.1 + 审查方 7 个边界点）。用完即删。 */
const fs = require('fs');
const UI = 'D:/Projects/_github_pages/ming-games/quiz/.build/quiz-ui.js';
const HEAD = 'D:/Projects/_github_pages/ming-games/quiz/.build/head.html';
let s = fs.readFileSync(UI, 'utf8');
function rep(old, neu, tag, exp) {
  const n = s.split(old).length - 1;
  const e = (exp == null) ? 1 : exp;
  if (n !== e) { console.log('ANCHOR FAIL[' + tag + '] count=' + n + ' expect=' + e); process.exit(1); }
  s = s.split(old).join(neu);
  console.log('  ok ' + tag);
}

/* ---------- E1 状态变量 ---------- */
rep(
`var WIN_CAP=12,WIN_MIN=6,UP_ACC=0.75,DN_ACC=0.4,LEVEL_COOL=2,lvlCool=0;`,
`var WIN_CAP=12,WIN_MIN=6,DN_ACC=0.4,LEVEL_COOL=2,lvlCool=0;  /* C7：UP_ACC 随窗口升档一起删除 —— 升档只走挑战机制 */
/* ---------- C7：自动升档挑战（连续答对 3 题 → 连出 2 道「升两档题」） ---------- */
var PROMO_STREAK=3;      /* 连续答对 3 题触发 */
var PROMO_SIZE=2;        /* 挑战固定 2 题 */
var promoState='idle';   /* idle | challenge */
var promoStreak=0;       /* 只在 idle 累计；挑战期间冻结在 0 */
var promoKey='';         /* typeKey+'|'+qaSection：换类型/换板块即清零 */
var promoRank=0;         /* 挑战题档位 = min(selfRank+2, maxRank) */
var promoAsked=0;        /* 挑战题「首次作答」计数 */
var promoCorrect=0;      /* 挑战题首答答对计数 */`, 'E1');

/* ---------- E2 状态机函数 ---------- */
rep(
`function windowAcc(){var a=selfWindow,i,n=0;if(!a.length)return 0;for(i=0;i<a.length;i++){if(a[i])n++;}return n/a.length;}`,
`function windowAcc(){var a=selfWindow,i,n=0;if(!a.length)return 0;for(i=0;i<a.length;i++){if(a[i])n++;}return n/a.length;}
/* ---------- C7：升档挑战状态机 ----------
   主指令 4.2.1 + 审查方补的 7 个边界点（缺一条就出 bug）：
   1. 挑战期间 selfWindow 完全冻结；idle 下窗口只剩降档 —— 升档只走挑战，避免「挑战 +2 + 窗口 +1」连跳。
   2. promoStreak 只在 idle 累计，挑战期间冻结、结束后从 0 重算（防「升完档立刻又触发」）。
   3. 只认「首次作答」：重写/重试答对不改挑战结果。
   4. 第 2 题首次作答完成时立即结算，不等用户点「下一题」。
   5. 挑战题照常记薄弱题/错题，不因「挑战中」特殊化。
   6. 只有 diffMatters（数学/编程）进入挑战；标准分类扁平题库不假升档。
   7. 取档统一走 autoQDiff() —— 所有「按实力生成题」的地方都不许直接用 selfRank。 */
function autoQDiff(){return promoState==='challenge'?promoRank:selfRank;}
function promoMax(bk){var T=bk&&QA_TYPES[bk];return (T&&T.diffs)?T.diffs.length-1:0;}
/* 清空挑战（换局/退出/切板块）。promoRank 保留，只清过程量。 */
function promoReset(){promoState='idle';promoStreak=0;promoKey='';promoAsked=0;promoCorrect=0;}
/* idle 下的连对计数（边界 2）。达标即开挑战，下一题起用 promoRank 出题。 */
function promoStreakHit(correct,bk){
  var _pk=typeKey+'|'+qaSection;
  if(_pk!==promoKey){promoKey=_pk;promoStreak=0;}
  if(!correct){promoStreak=0;return;}
  promoStreak++;
  if(promoStreak<PROMO_STREAK)return;
  if(promoState!=='idle')return;
  if(!diffMatters(bk))return;                                  /* 边界 6：标准分类连对照常计数，不触发 */
  if(!bk||!QA_TYPES[bk]||!QA_TYPES[bk].diffs)return;
  if(selfRank>=promoMax(bk)){promoStreak=0;return;}             /* 最高档不触发 */
  promoRank=Math.min(selfRank+2,promoMax(bk));
  promoState='challenge';promoAsked=0;promoCorrect=0;promoStreak=0;
  toast('🔥 升档挑战 · 连出 2 道「'+levelName(promoRank)+'」题，答对 2 道升两档');
}
/* 挑战题作答（只在 first===true 时调用）。返回反馈条那一行文案。 */
function promoCount(correct){
  promoAsked++;if(correct)promoCorrect++;
  var tip='🔥 升档挑战：答对 '+promoCorrect+'/'+PROMO_SIZE+' 题';
  if(promoAsked>=PROMO_SIZE)promoSettle();                     /* 边界 4：立即结算，不等下一题 */
  return tip;
}
function promoSettle(){
  var bk=(typeKey&&typeKey.indexOf('b:')===0)?typeKey.slice(2):'';
  var T=bk&&QA_TYPES[bk];
  var old=selfRank,bump=(promoCorrect>=2)?2:((promoCorrect>=1)?1:0);
  var neu=Math.min(old+bump,promoMax(bk));
  promoState='idle';promoStreak=0;promoAsked=0;promoCorrect=0;
  if(neu!==old){selfRank=neu;setRank(bk,selfRank);}
  if(T&&T.diffs)curDiffLabel=T.diffs[selfRank].n;
  syncHudLevel();
  if(bump>=2)toast('🎉 升 2 档：'+levelName(old)+' → '+levelName(neu));
  else if(bump===1)toast('⬆️ 升 1 档：'+levelName(old)+' → '+levelName(neu));
  else toast('本轮到挑战结束，未升档');
}
/* 档位区文案：挑战中显示目标档位，不再显示「实力：」（边界 7） */
function autoLevelTxt(bk){
  if(!autoMode)return curDiffLabel?(' · '+curDiffLabel):'';
  if(promoState==='challenge')return ' · 🔥 升档挑战 '+Math.min(promoAsked+1,PROMO_SIZE)+'/'+PROMO_SIZE+' · 目标：'+levelName(promoRank);
  return diffMatters(bk)?(' · 实力：'+(curDiffLabel||'')):' · 🎲 混合难度';
}`, 'E2');

/* ---------- E3 genAutoOne 取档 ---------- */
rep(`    var qs=sectionGen(bk,1,selfRank);`,
    `    var qs=sectionGen(bk,1,autoQDiff());   /* C7：挑战中出 promoRank 的题 */`, 'E3');

/* ---------- E4 showQuestion 无限模式手写题取档 ---------- */
rep(`        _nq=(typeKey==='b:code'&&qaSection==='code'&&handMode)?genHandTask(selfRank):genAutoOne();`,
    `        _nq=(typeKey==='b:code'&&qaSection==='code'&&handMode)?genHandTask(autoQDiff()):genAutoOne();`, 'E4');

/* ---------- E5 setHandMode 取档 ---------- */
rep(`  if(handMode){qlist[qidx]=genHandTask(autoMode?selfRank:Math.max(0,curDiff));}`,
    `  if(handMode){qlist[qidx]=genHandTask(autoMode?autoQDiff():Math.max(0,curDiff));}`, 'E5');

/* ---------- E6 HUD 档位区拆成 span ---------- */
rep(
`  var _lvTxt='';
  if(autoMode)_lvTxt=diffMatters(bk)?(' · 实力：'+(curDiffLabel||'')):' · 🎲 混合难度';
  else if(curDiffLabel)_lvTxt=' · '+curDiffLabel;
  hud.appendChild(ht('div','hl',_tik+typeLabel+_badge+_lvTxt));`,
`  /* C7：档位区单独一个 span —— 挑战开始/结算时要能原地改写文案（syncHudLevel） */
  var hlEl=ht('div','hl',_tik+typeLabel+_badge);
  hlEl.appendChild(ht('span','lvt',autoLevelTxt(bk)));
  hud.appendChild(hlEl);`, 'E6');

/* ---------- E7 syncHudLevel ---------- */
rep(
`function syncHudLevel(){
  if(!autoMode||!curDiffLabel)return;
  var el=document.querySelector('#stage .hud .hl');
  if(!el)return;
  var t=el.textContent||'';
  el.textContent=/实力：/.test(t)?t.replace(/实力：[^·]*$/,'实力：'+curDiffLabel):t;
}`,
`function syncHudLevel(){
  if(!autoMode)return;
  var el=document.querySelector('#stage .hud .hl .lvt');
  if(!el)return;
  var bk=(typeKey&&typeKey.indexOf('b:')===0)?typeKey.slice(2):'';
  el.textContent=autoLevelTxt(bk);
}`, 'E7');

/* ---------- E8 markUnknown：挑战中不降档 ---------- */
rep(
`  var recorded=false;
  if(first){`,
`  var recorded=false;
  var _promoTip='';   /* C7：挑战反馈文案（结算后 promoCorrect 已清零，必须先取） */
  if(first){`, 'E8a');
rep(
`    if(autoMode){
      var _bk=(typeKey.indexOf('b:')===0)?typeKey.slice(2):'';
      selfWindow.push(0);if(selfWindow.length>WIN_CAP)selfWindow.shift();
      selfRank=Math.max(0,selfRank-1);lvlCool=LEVEL_COOL;setRank(_bk,selfRank);
      combo=0;wrongCombo=0;
      if(QA_TYPES[_bk])curDiffLabel=QA_TYPES[_bk].diffs[selfRank].n;
      syncHudLevel();
    }`,
`    if(autoMode){
      var _bk=(typeKey.indexOf('b:')===0)?typeKey.slice(2):'';
      combo=0;wrongCombo=0;
      if(promoState==='challenge'){
        /* C7 边界 1/1'：挑战中「不会」只记挑战错 —— 不降档、不动窗口，继续第 2 题 */
        _promoTip=promoCount(false);
      }else{
        selfWindow.push(0);if(selfWindow.length>WIN_CAP)selfWindow.shift();
        selfRank=Math.max(0,selfRank-1);lvlCool=LEVEL_COOL;setRank(_bk,selfRank);
        if(QA_TYPES[_bk])curDiffLabel=QA_TYPES[_bk].diffs[selfRank].n;
        promoStreakHit(false,_bk);   /* C7 边界 2：「不会」清零连对 */
        syncHudLevel();
      }
    }`, 'E8b');
rep(
`  appendSrc(fb,Q);      // 来源（C1）
  /* 重试对所有题型开放：看过参考代码后自己再写一遍，正是「学习时刻」的意义。`,
`  appendSrc(fb,Q);      // 来源（C1）
  if(_promoTip)fb.appendChild(ht('div','fpromo',_promoTip));   // C7：升档挑战 n/2
  /* 重试对所有题型开放：看过参考代码后自己再写一遍，正是「学习时刻」的意义。`, 'E8c');

/* ---------- E9 answer()：窗口只剩降档 + 挑战计数 ---------- */
rep(
`  var Q=qlist[qidx];
  /* 首次 / 重试分层：重试只给 +5 学习奖励`,
`  var Q=qlist[qidx];
  var _promoTip='';   /* C7：挑战反馈文案（结算后 promoCorrect 已清零，必须先取） */
  /* 首次 / 重试分层：重试只给 +5 学习奖励`, 'E9a');
rep(
`    if(autoMode&&_bk&&QA_TYPES[_bk]&&QA_TYPES[_bk].diffs){
      /* 滑动窗口自适应（替换原来的连对/连错计数）：
         最近 ≤12 题正确率 ≥75% 升一档、≤40% 降一档；满 6 题才判，升降后冷却 2 题，避免一波连对跳两级。
         ⚠ 升档只在「这题答对」时判、降档只在「这题答错」时判：
         否则连对 8 题后答错 1 题，窗口仍 89%，会出现「答错反而升档」（踩过）。
         ⚠ 重试不计入窗口：同一题只算一次，否则反复重试会把档位刷上去。 */
      selfWindow.push(correct?1:0);if(selfWindow.length>WIN_CAP)selfWindow.shift();
      var _acc=windowAcc(),_maxD=QA_TYPES[_bk].diffs.length-1;
      if(lvlCool>0){lvlCool--;}
      else if(selfWindow.length>=WIN_MIN){
        if(correct&&_acc>=UP_ACC&&selfRank<_maxD){selfRank++;lvlCool=LEVEL_COOL;}
        else if(!correct&&_acc<=DN_ACC&&selfRank>0){selfRank--;lvlCool=LEVEL_COOL;}
      }
      setRank(_bk,selfRank);
      curDiffLabel=QA_TYPES[_bk].diffs[selfRank].n;
      syncHudLevel();
    }`,
`    if(autoMode&&_bk&&QA_TYPES[_bk]&&QA_TYPES[_bk].diffs){
      if(promoState==='challenge'){
        /* C7 边界 1/3/5：挑战期间不动窗口、不升降档，只记「首次作答」的挑战结果；
           记薄弱题/错题在上面已照常走完，不因「挑战中」特殊化。 */
        _promoTip=promoCount(correct);
      }else{
        /* 滑动窗口自适应：最近 ≤12 题正确率 ≤40% 降一档（满 6 题才判，降后冷却 2 题）。
           C7：升档分支已删除 —— 升档只走「连对 3 题 → 升档挑战」，
           否则「挑战升 2 档 + 窗口再升 1 档」会连跳（主指令 4.2.1「防止双重升档」）。
           ⚠ 降档只在这题答错时判：否则连对 8 题后答错 1 题窗口仍 89%，会出现「答错反而升档」（踩过）。
           ⚠ 重试不计入窗口：同一题只算一次，否则反复重试会把档位刷上去。 */
        selfWindow.push(correct?1:0);if(selfWindow.length>WIN_CAP)selfWindow.shift();
        var _acc=windowAcc();
        if(lvlCool>0){lvlCool--;}
        else if(!correct&&selfWindow.length>=WIN_MIN&&_acc<=DN_ACC&&selfRank>0){selfRank--;lvlCool=LEVEL_COOL;}
        setRank(_bk,selfRank);
        curDiffLabel=QA_TYPES[_bk].diffs[selfRank].n;
        promoStreakHit(correct,_bk);   /* C7 边界 2：idle 下的连对计数，达标即开挑战 */
        syncHudLevel();
      }
    }`, 'E9b');
rep(
`  appendFb(fb);
  if(first)bumpStat(typeKey,correct);`,
`  if(_promoTip)fb.appendChild(ht('div','fpromo',_promoTip));   // C7：升档挑战 n/2
  appendFb(fb);
  if(first)bumpStat(typeKey,correct);`, 'E9c');

/* ---------- E10 重置点 ---------- */
rep(`  ok=0;qidx=0;score=0;answeredCount=0;roundWrong=[];scratchMap.clear();  /* 批次 B：开新局草稿不串题 */`,
    `  ok=0;qidx=0;score=0;answeredCount=0;roundWrong=[];scratchMap.clear();  /* 批次 B：开新局草稿不串题 */
  promoReset();   /* C7：开局一律回 idle（换分类/换板块/重开都走这里） */`, 'E10a');
rep(`function renderShelf(){
  quizOver=true;reviewMode=false;reviewOne=false;cancelPending();navReset();`,
    `function renderShelf(){
  quizOver=true;reviewMode=false;reviewOne=false;cancelPending();navReset();
  promoReset();   /* C7：回书架 = 放弃挑战，不补发升档 */`, 'E10b');
rep(`function switchSection(){
  var bk=(typeKey&&typeKey.indexOf('b:')===0)?typeKey.slice(2):'';`,
    `function switchSection(){
  promoReset();   /* C7：换板块 = 放弃挑战 */
  var bk=(typeKey&&typeKey.indexOf('b:')===0)?typeKey.slice(2):'';`, 'E10c');
rep(`  qlist=weakSort(a).map(weakToQ);   /* 次数多 + 新的在前，到期题内也有轻重 */
  ok=0;qidx=0;score=0;answeredCount=0;total=qlist.length;roundWrong=[];showQuestion();`,
    `  qlist=weakSort(a).map(weakToQ);   /* 次数多 + 新的在前，到期题内也有轻重 */
  ok=0;qidx=0;score=0;answeredCount=0;total=qlist.length;roundWrong=[];promoReset();showQuestion();`, 'E10d');
rep(`  qlist=weakSort(a).map(weakToQ);
  ok=0;qidx=0;score=0;answeredCount=0;total=qlist.length;roundWrong=[];showQuestion();`,
    `  qlist=weakSort(a).map(weakToQ);
  ok=0;qidx=0;score=0;answeredCount=0;total=qlist.length;roundWrong=[];promoReset();showQuestion();`, 'E10e');
rep(`  qlist=[weakToQ(x)];ok=0;qidx=0;score=0;answeredCount=0;total=1;roundWrong=[];showQuestion();`,
    `  qlist=[weakToQ(x)];ok=0;qidx=0;score=0;answeredCount=0;total=1;roundWrong=[];promoReset();showQuestion();`, 'E10f');
rep(`function endQuiz(){
  quizOver=true;`,
    `function endQuiz(){
  quizOver=true;
  promoReset();   /* C7：结算/退出 = 放弃挑战，不补发升档 */`, 'E10g');
rep(`  qlist=shuffle(ONLINE_BANK.slice()).slice(0,Math.min(10,ONLINE_BANK.length)).map(function(it){return {q:it.q,a:it.a,opts:it.opts,src:it.src};});
  ok=0;qidx=0;score=0;answeredCount=0;total=qlist.length;roundWrong=[];showQuestion();`,
    `  qlist=shuffle(ONLINE_BANK.slice()).slice(0,Math.min(10,ONLINE_BANK.length)).map(function(it){return {q:it.q,a:it.a,opts:it.opts,src:it.src};});
  ok=0;qidx=0;score=0;answeredCount=0;total=qlist.length;roundWrong=[];promoReset();showQuestion();`, 'E10h');

fs.writeFileSync(UI, s, 'utf8');
console.log('OK quiz-ui.js');

/* ---------- E11 反馈条 CSS ---------- */
let hh = fs.readFileSync(HEAD, 'utf8');
const cssOld = `.fb .fba{display:block;margin-top:3px;font-size:13.5px}`;
if (hh.split(cssOld).length - 1 !== 1) { console.log('ANCHOR FAIL[E11] head'); process.exit(1); }
hh = hh.split(cssOld).join(cssOld + `\n/* C7：升档挑战进度行（答案/解析之后一行小字） */\n.fb .fpromo{display:block;margin-top:6px;font-size:12.6px;font-weight:700;color:#a8690a}`);
fs.writeFileSync(HEAD, hh, 'utf8');
console.log('OK head.html');
