/* ===== 知识问答 独立应用 UI 层（书架式 + 实力检测 + AI/免费建题库 + 背景音乐） ===== */
/*
C 代码规范（本项目统一）：
1) 缩进一律 4 个空格，不用 Tab；
2) 控制结构（if/else/for/while/do/switch）与函数的左花括号另起一行；
3) 每条语句独立一行，行尾分号；
4) 二元运算符两侧各一个空格（= + - * / % == && ||）；
5) 单行 if (...) 语句 改为带花括号的多行块；
6) 变量名要有意义（a/b/i 允许用于循环与示例，其余用 sum/count/max 等）；
7) 参考代码（sol）必须完整可编译：带 #include <stdio.h>、int main(void)、return 0;
   题面代码允许是片段（不必完整可编译），但风格必须符合 1~6。
*/
(function(){
'use strict';
// 共享全局状态与框架函数（S/shuffle/ri/h/clearNode/later/esc、score/total/ok/qidx/qlist/
// typeLabel/typeKey/locked/autoMode/selfRank/combo/wrongCombo/reviewMode/AUTO_TOTAL/UP_COMBO/
// DOWN_COMBO/curDiff/curDiffLabel/netStat、qaDiffs/qaDiffDefault）由 head 内联脚本在引擎之前定义。
var $=function(id){return document.getElementById(id);};
function ht(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;}
var shelfEl,stageEl,overlayRoot;
var lastRun=null; // 记录本局参数，供「再来一局」精确重放（自动匹配 / 薄弱回顾都不丢）
/* ---------- 三板块（选择题 / 程序编写 / 填空题） ---------- */
var SECTIONS=[{k:'choice',n:'🎯 选择题',d:'四个选项，选中即答'},
              {k:'code',n:'⌨️ 程序编写',d:'读代码 / 补全 / 手写，考真本事'},
              {k:'fill',n:'✍️ 填空题',d:'不给选项，自己写答案'}];
var qaSection='choice';
var lastSectionBk='';
var handMode=false;
/* selfWindow 与 selfRank 同层：声明在 build.js 的全局框架里（C7 探针要验证「挑战期间窗口冻结」） */
var WIN_CAP=12,WIN_MIN=6,DN_ACC=0.4,LEVEL_COOL=2,lvlCool=0;  /* C7：UP_ACC 随窗口升档一起删除 —— 升档只走挑战机制 */
/* ---------- C7：自动升档挑战（连续答对 3 题 → 连出 2 道「升两档题」） ----------
   ⚠ 状态变量 PROMO_STREAK/PROMO_SIZE/promoState/promoStreak/promoKey/promoRank/
   promoAsked/promoCorrect 与 selfRank 同层，声明在 build.js 的全局框架里
   （引擎与探针都要直接读）—— 这里不要再 var，否则会被 IIFE 遮蔽。 */
var lastAuto=null;                              // 结算页的实力评级快照
var reviewOne=false;                            // 薄弱题本里的「单题练」：结算页返回题本而不是重开整局
var roundWrong=[];                              // P2-A1：本局首次结算的错题（重试答对不追加、不重复）
var roundShortMsg='';                           // C4：本局实际题量少于所选档位时的常驻提示
var answeredCount=0;                            // 4.0.1-2：本局「真正作答过」的题数（自动模式的结算分母）
var customMixed=false;                          // 4.0.1-1：自定义题库本局含非选择题 → HUD 显示「混合试卷」
var quizOver=false;                             // 本局是否已收尾（挡住答题后的延时切题把结算页顶掉）
function sectionName(k){for(var i=0;i<SECTIONS.length;i++){if(SECTIONS[i].k===k)return SECTIONS[i].n;}return '🎯 选择题';}
function windowAcc(){var a=selfWindow,i,n=0;if(!a.length)return 0;for(i=0;i<a.length;i++){if(a[i])n++;}return n/a.length;}
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
/* 档位名用「学科自己的」—— 数学 4 档是 🎒小学/📘初中/📗高中/🎓大学，
   与难度面板一致；levelName() 是编程那套 5 档通用名，套到数学上会驴唇不对马嘴。 */
function rankName(bk,r){var T=bk&&QA_TYPES[bk];return (T&&T.diffs&&T.diffs[r])?T.diffs[r].n:levelName(r);}
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
  toast('🔥 升档挑战 · 连出 2 道「'+rankName(bk,promoRank)+'」题，答对 2 道升两档');
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
  var pc=promoCorrect;                                    /* 先取：下面要清零 */
  var old=selfRank,bump=(pc>=2)?2:((pc>=1)?1:0);
  var mx=promoMax(bk),neu=Math.min(old+bump,mx),delta=neu-old;
  promoState='idle';promoStreak=0;promoAsked=0;promoCorrect=0;
  if(delta){selfRank=neu;setRank(bk,selfRank);}
  if(T&&T.diffs)curDiffLabel=T.diffs[selfRank].n;
  syncHudLevel();
  /* toast 按「实际位移」报，不按答对题数报 —— 到顶时 bump 会被夹紧，
     说「升 2 档」而实际只升 1 档就是撒谎 */
  if(delta>=2)toast('🎉 升 2 档：'+rankName(bk,old)+' → '+rankName(bk,neu));
  else if(delta===1)toast('⬆️ 升 1 档：'+rankName(bk,old)+' → '+rankName(bk,neu));
  else if(pc>0&&neu>=mx)toast('🎯 已是最高档「'+rankName(bk,neu)+'」，没法再升');
  else toast('本轮到挑战结束，未升档');
}
/* 档位区文案：挑战中显示目标档位，不再显示「实力：」（边界 7） */
function autoLevelTxt(bk){
  if(!autoMode)return curDiffLabel?(' · '+curDiffLabel):'';
  if(promoState==='challenge')return ' · 🔥 升档挑战 '+Math.min(promoAsked+1,PROMO_SIZE)+'/'+PROMO_SIZE+' · 目标：'+rankName(bk,promoRank);
  return diffMatters(bk)?(' · 实力：'+(curDiffLabel||'')):' · 🎲 混合难度';
}
/* 轻提示（替代阻塞式 alert） */
var toastTimer=null;
function toast(msg){
  var t=$('toast');
  if(!t){t=document.createElement('div');t.id='toast';document.body.appendChild(t);}
  t.textContent=msg;t.className='show';
  if(toastTimer)clearTimeout(toastTimer);
  toastTimer=setTimeout(function(){t.className='';},1900);
}

/* ---------- 成绩 / 统计 存储 ---------- */
function loadBest(){try{return JSON.parse(S.getItem('bt_qa_best')||'{}')||{};}catch(e){return{};}}
/* C6：书架徽标统一走 bestInfo 的 found 语义 —— 0 分 / 负分也算「挑战过」，不再显示「未挑战」。
   返回 null = 没挑战过；数字（含 0 / 负数）= 已挑战的最佳分。 */
function bestFor(prefix){var i=bestInfo(prefix);return i.found?i.best:null;}
function loadStats(){try{return JSON.parse(S.getItem('bt_qa_stats')||'{}')||{};}catch(e){return{};}}
/* P2-A3：统计页专用 —— 「键存在即已挑战」，0 分 / 负分也算成绩。
   C6 起书架徽标也走这套语义（bestFor 直接包它），统计页与书架不再互相矛盾。 */
function bestInfo(prefix){
  var m=loadBest(),best=null,found=false;
  for(var k in m){if(k.indexOf(prefix)===0){found=true;if(best===null||m[k]>best)best=m[k];}}
  return {best:found?best:0,found:found};
}
function bumpStat(prefix,correct){
  var m=loadStats();var o=m[prefix]||{n:0,c:0};o.n++;if(correct)o.c++;m[prefix]=o;
  safeSet('bt_qa_stats',JSON.stringify(m));
  bumpDaily(!!correct);
}
/* P2-A3：每天做题数 / 正确数，只留最近 30 天（用本地日期，UTC 在东八区会串日） */
function bumpDaily(correct){
  var dl={};try{dl=JSON.parse(S.getItem('bt_qa_daily')||'{}')||{};}catch(e){dl={};}
  if(!dl||typeof dl!=='object')dl={};
  var tk=dayKey(new Date());
  var td=dl[tk]||{n:0,c:0};td.n++;if(correct)td.c++;dl[tk]=td;
  var ks=Object.keys(dl).sort();
  while(ks.length>30){delete dl[ks.shift()];}
  safeSet('bt_qa_daily',JSON.stringify(dl));
}
function trendDays(n){
  var dl={};try{dl=JSON.parse(S.getItem('bt_qa_daily')||'{}')||{};}catch(e){dl={};}
  var out=[],base=new Date();base.setHours(12,0,0,0);
  for(var i=n-1;i>=0;i--){
    var d=new Date(base.getTime()-i*86400000),k=dayKey(d),o=dl[k]||{n:0,c:0};
    out.push({k:k,n:o.n||0,c:o.c||0});
  }
  return out;
}

/* ---------- 书架 ---------- */
function showView(v){if(v==='shelf'){shelfEl.hidden=false;stageEl.hidden=true;}else{shelfEl.hidden=true;stageEl.hidden=false;}}

function stdCount(key){return (POOLS[key]&&POOLS[key].length)?POOLS[key].length:0;}
/* C4：本分类「真能出多少题」= 人工题 + 过校验的 AI 补充题（按题干去重）。
   pickDiffPanel 用它标注「本类仅 N 题」，doStartType 用它做整局提示。
   math / code 是现生成，不受题量限制 → 返回 Infinity。 */
function stdAvail(bk){
  if(!bk||bk==='math'||bk==='code')return Infinity;
  var man=POOLS[bk]||[],seen={},n=0;
  man.forEach(function(it){var q=it&&it[0];if(!q)return;q=String(q);if(seen[q])return;seen[q]=1;n++;});
  extraPool(bk).forEach(function(x){if(!x||!x.q)return;var q=String(x.q);if(seen[q])return;if(!validItem(x))return;seen[q]=1;n++;});
  return n;
}
/* C4：档位是否真的改变题目难度。math 按学业阶段生成、code 按知识点×难度矩阵生成；
   其余分类是扁平题库（pickPoolByDiff 对数组不分档），换档只改题量与扣分 → 不能说「实力：困难」 */
function diffMatters(bk){return bk==='math'||bk==='code';}
function codeCount(){var n=0;for(var d in POOLS.code){if(POOLS.code.hasOwnProperty(d))n+=POOLS.code[d].length;}return n;}
function shelfCount(bk,cn){
  if(bk==='math')return '动态生成';
  if(bk==='code'){var e=codeEstimate();return (e>=10000?Math.floor(e/10000)+'万+':e)+' 题（模板生成，理论组合数）';}
  if(bk)return stdCount(bk)+' 题';
  var p=custom[cn]||[];return p.length+' 题';
}
function renderShelf(){
  quizOver=true;reviewMode=false;reviewOne=false;cancelPending();navReset();
  promoReset();   /* C7：回书架 = 放弃挑战，不补发升档 */
  showView('shelf');
  clearNode(shelfEl);
  // 顶部操作
  var sec1=h('div','section-title',null);sec1.appendChild(ht('span',null,'📚 书架'));
  var acts=h('span',null);acts.style.marginLeft='auto';acts.style.display='flex';acts.style.gap='8px';
  var _wn=loadWeak().length;
  var bWeak=ht('span','act','😵 薄弱题'+(_wn?(' · '+_wn):''));bWeak.onclick=function(){openWeakBook();};
  var _due=loadWeak().filter(srsDue).length;
  var bSrs=ht('span','act','⏰ 待复习'+(_due?(' · '+_due):''));bSrs.onclick=function(){startSrs();};
  var bNew=ht('span','act','➕ 新建');bNew.onclick=function(){openNewCategory();};
  acts.appendChild(bWeak);acts.appendChild(bSrs);acts.appendChild(bNew);sec1.appendChild(acts);
  shelfEl.appendChild(sec1);

  var grid=h('div','shelf');
  // 内置分类
  Object.keys(QA_TYPES).forEach(function(bk){
    if(bk==='online')return;
    var T=QA_TYPES[bk];
    grid.appendChild(makeBook(T.icon,T.name,bk,null,bestFor('b:'+bk),shelfCount(bk,null)));
  });
  // 自定义
  var cks=Object.keys(custom);
  cks.forEach(function(name){
    grid.appendChild(makeBook('📝',name,null,name,bestFor('c:'+name),shelfCount(null,name),true));
  });
  // 联网
  grid.appendChild(makeBook('🌐','联网题库·英文','online',null,bestFor('b:online'),(ONLINE_BANK&&ONLINE_BANK.length?ONLINE_BANK.length:0)+' 题'));
  shelfEl.appendChild(grid);
  shelfEl.appendChild(ht('div','muted','💻 编程题量为「人工题 + 模板生成（理论组合数）」，参数空间有限，实际不重复体验以出题引擎去重为准；其余分类为人工题库，题量以卡片上的实际题数为准（不再自动扩充）。'));

  // 联网管理
  var sec2=h('div','section-title',null);sec2.appendChild(ht('span',null,'🌐 联网题库'));shelfEl.appendChild(sec2);
  var netWrap=h('div','qcard');netWrap.style.margin='6px 0';
  netStat=ht('div','hint',(ONLINE_BANK.length?('已缓存 '+ONLINE_BANK.length+' 题（实时）'):'联网题库：点下方按钮实时获取最新题目'));
  netWrap.appendChild(ht('div','hint2','题源：Open Trivia DB（英文题库，CC BY-SA 4.0）· 中文题库请看其他分类'));
  netStat.style.color='#27a567';netWrap.appendChild(netStat);
  var rrow=h('div','row');
  var rbtn=h('button','btn ghost','🔄 联网更新题库');
  rbtn.onclick=function(){rbtn.disabled=true;netStat.textContent='🌐 正在联网获取…';fetchOnline(function(okf,info){rbtn.disabled=false;var why=(info&&info.reason)||'fail';if(!okf){netStat.textContent=netFailText(why);return;}if(info&&info.degraded){netStat.textContent=netFailText(why);renderShelf();return;}netStat.textContent='🌐 已联网更新：'+ONLINE_BANK.length+' 题（实时）';updateOnlineStatus();renderShelf();});};
  rrow.appendChild(rbtn);netWrap.appendChild(rrow);
  shelfEl.appendChild(netWrap);
  // AI 补充题管理（P0-5：用户可一键清空 AI 生成的题，避免坏题滞留）
  var _ex=loadExtra();var _exN=0;Object.keys(_ex).forEach(function(k){_exN+=(_ex[k]&&_ex[k].length)||0;});
  if(_exN>0){
    var aiWrap=h('div','qcard');aiWrap.style.margin='6px 0';
    var aiRow=h('div','row');
    var aiBtn=h('button','btn ghost','🗑 清空 AI 补充题（'+_exN+' 题）');
    aiBtn.onclick=function(){if(confirm('确定清空所有 AI 补充题？此操作不可恢复。')){saveExtra({});toast('已清空 AI 补充题');renderShelf();}};
    aiRow.appendChild(aiBtn);aiWrap.appendChild(aiRow);
    shelfEl.appendChild(aiWrap);
  }
  shelfEl.appendChild(ht('div','muted','题库与成绩均存于本机浏览器（与 brain-gym 知识问答共用存储），换设备不继承。'));
}
function makeBook(icon,name,bk,cn,best,count,isCustom){
  var b=h('div','book');
  if(isCustom){var del=h('button','del','🗑');del.onclick=function(e){e.stopPropagation();
    if(!confirm('删除整个题库「'+cn+'」？删除后不可恢复（该题库的成绩记录会保留）。'))return;
    delete custom[cn];saveCustom(custom);renderShelf();toast('🗑 已删除题库「'+cn+'」');};b.appendChild(del);}
  b.appendChild(ht('div','ic',icon));
  b.appendChild(ht('div','nm',name));
  /* 块4：编程卡片副标题 —— only 显示所选语言，否则「全部语言」 */
  if(bk==='code'){var _st2=codeLangState();b.appendChild(ht('div','muted',_st2.mode==='only'?_st2.langs.map(langName).join(' · '):'全部语言'));}
  var meta=h('div','meta');
  if(count&&String(count).length>8)meta.style.flexWrap='wrap';
  var _hasBest=(best!=null&&best!=='');   /* C6：0 / 负分也是成绩，只有 null 才是未挑战 */
  meta.appendChild(ht('span','star'+(_hasBest?'':' none'),_hasBest?('⭐ '+best):'未挑战'));
  meta.appendChild(ht('span',null,count));
  b.appendChild(meta);
  b.onclick=function(){openCategory(bk,cn);};
  return b;
}

/* ---------- 进入分类（含 任务2：编程实力检测） ---------- */
function openCategory(bk,cn){
  if(bk==='online'){startOnline();return;}
  if(!bk&&!cn)return;
  // 编程：先做知识面检测
  if(bk==='code'){
    var prof=getCodeProfile();
    if(!prof||!prof.done){
      codeQuestionnaire(function(){afterDetect(bk,cn);});
      return;
    }
  }
  afterDetect(bk,cn);
}
function afterDetect(bk,cn){
  if(bk){startType(bk,cn,null);return;}
  doStartType(bk,cn,-1);
}

/* ---------- 难度面板 ---------- */
function pickDiffPanel(bk,cb){
  var T=QA_TYPES[bk],ds=qaDiffs(bk);if(!ds){cb(-1);return;}
  var PANEL=[{auto:true,n:'🤖 自动匹配',d:'无限刷题 · 实时调难度'}].concat(ds.map(function(x,i){return {n:x.n,d:x.d,idx:i,cnt:x.cnt};}));
  /* C4：本类真实可用题量（math/code 为 Infinity，不做标注） */
  var _avail=stdAvail(bk);
  var defSel=0;try{var sv=parseInt(S.getItem('bd_qa_diff_'+bk),10);if(sv>=0&&sv<ds.length)defSel=sv+1;}catch(e){}
  /* C4：上次选的档位若本类一题都出不了（如题库被清空），默认回到自动匹配 */
  if(defSel>0&&ds[defSel-1]&&isFinite(stdAvail(bk))&&stdAvail(bk)<=0)defSel=0;
  var ov=overlayPanel((T.icon||'')+' '+T.name+' · 选择难度','diff');
  ov.p.appendChild(ht('div','hint',(bk==='math'?'🎓 按学业阶段出题：':(bk==='code'?'💻 按学习进度出题（已按你掌握的语言过滤）：':'⚙️ 选择难度，题量与扣分随档位变化'))+'也可选「🤖 自动匹配」无限刷题、难度实时跟着你走'));
  /* 块4：语言状态三态可见 —— only 保留检测结果；unset 红字警示可点进问卷；all 灰字说明可改 */
  if(bk==='code'){
    var _st=codeLangState();
    if(_st.mode==='only'){
      var p=getCodeProfile();
      ov.p.appendChild(ht('div','okmsg','已检测：'+_st.langs.map(langName).join(' · ')+' · '+levelName(p.rank)));
    }else{
      var _langTip=ht('div',_st.mode==='unset'?'warn':'muted',_st.mode==='unset'?'⚠️ 尚未设置语言：当前会出全部语言题（含 Java / Python / JS）。点这里只出 C / C++':'当前出全部语言题（你选择过「跳过」）· 点这里指定语言');
      _langTip.style.cursor='pointer';
      _langTip.style.textDecoration='underline';
      _langTip.onclick=function(){closeOverlay(ov);codeQuestionnaire(function(){pickDiffPanel(bk,cb);});};
      ov.p.appendChild(_langTip);
    }
  }
  var dr=h('div','diffrow');
  PANEL.forEach(function(df,i){
    var b=ht('button','diffbtn'+(i===defSel?' sel':''));
    var txt=h('div','dtxt');
    txt.appendChild(ht('div','dn',df.n));
    /* C4：档位题量 > 本类真实题量时，直接把差额写在档位上（不玩「看着 40 题实际 12 题」） */
    var _dd=df.d,_short=false,_empty=false;
    if(df.idx!=null&&isFinite(_avail)&&df.cnt>_avail){
      _short=true;_empty=(_avail<=0);
      _dd=df.d+' · 本类仅 '+_avail+' 题'+(_empty?'（暂无可用题目）':'');
    }
    var ddEl=ht('div','dd',_dd);
    if(_short)ddEl.style.color='#a8690a';
    txt.appendChild(ddEl);
    b.appendChild(txt);
    b.appendChild(ht('span','dck','✓'));
    if(_empty){
      b.classList.add('off');b.style.opacity='0.45';b.style.cursor='not-allowed';
      b.onclick=function(){toast('⚠️ 本类还没有可用题目：先「➕ 新建」题库或用 AI 补充题');};
    }else{
      b.onclick=function(){[].slice.call(dr.children).forEach(function(x){try{x.classList.remove('sel');}catch(e){}});try{b.classList.add('sel');}catch(e){}};
    }
    if(_short){try{b.setAttribute('data-short','1');}catch(e){}}
    dr.appendChild(b);});
  ov.p.appendChild(dr);
  /* B 批：先学后练开关（持久化到 bt_qa_learn_before） */
  var _lb=!!JSON.parse(S.getItem('bt_qa_learn_before')||'false');
  var _tg=document.createElement('label');_tg.style.cssText='display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;margin-top:8px';
  var _cb=document.createElement('input');_cb.type='checkbox';_cb.checked=_lb;
  _cb.onchange=function(){safeSet('bt_qa_learn_before',_cb.checked?'true':'false');};
  _tg.appendChild(_cb);_tg.appendChild(ht('span',null,'📖 先学后练（开局先看知识卡）'));
  ov.p.appendChild(_tg);
  var goS=h('button','btn gold','▶ 开始出题');goS.style.width='100%';goS.style.marginTop='4px';
  goS.onclick=function(){var sel=0;[].slice.call(dr.children).forEach(function(x,i){if(x.classList&&x.classList.contains('sel'))sel=i;});closeOverlay(ov);
    if(sel===0){cb('auto');return;}
    var realIdx=PANEL[sel].idx;try{safeSet('bd_qa_diff_'+bk,realIdx);}catch(e){}cb(realIdx);};
  ov.p.appendChild(goS);
  var backS=h('button','btn ghost','← 返回');backS.style.width='100%';backS.style.marginTop='8px';backS.onclick=function(){closeOverlay(ov);};
  ov.p.appendChild(backS);
}

/* ---------- 板块选择 / 出题套壳 / 切换 ---------- */
function pickSection(bk,cb){
  var T=QA_TYPES[bk];
  var list=SECTIONS.filter(function(x){return bk==='code'||x.k!=='code';});
  var ov=overlayPanel(((T&&T.icon)||'')+' '+((T&&T.name)||bk)+' · 选择板块','section');
  ov.p.appendChild(ht('div','hint','同一分类有三种刷法：选择题最快，填空题最考记忆，程序编写只对编程分类开放。'));
  var dr=h('div','diffrow');
  list.forEach(function(sc){
    var b=ht('button','diffbtn secbtn');
    var tx=h('div','dtxt');
    tx.appendChild(ht('div','dn',sc.n));
    tx.appendChild(ht('div','dd',sc.d));
    b.appendChild(tx);b.appendChild(ht('span','dck','›'));
    b.onclick=function(){closeOverlay(ov);cb(sc.k);};
    dr.appendChild(b);
  });
  ov.p.appendChild(dr);
  var back=h('button','btn ghost','← 返回书架');back.style.width='100%';back.onclick=function(){closeOverlay(ov);renderShelf();};
  ov.p.appendChild(back);
}
/* 填空板块：出题后统一摘掉选项，走输入框分支（norm 容错） */
function applySection(qs){
  qs=qs||[];
  if(qaSection!=='fill')return qs;
  return qs.map(function(x){
    if(!x)return x;
    return {q:x.q,a:x.a,opts:null,tag:x.tag,code:x.code,ai:x.ai,src:x.src,fillin:x.fillin,kind:x.kind,exp:x.exp,hand:x.hand,task:x.task,weak:x.weak};
  });
}
function sectionGen(bk,n,diff){
  var qs=null;
  /* C3：编程三个板块（选择题 / 填空题 / 程序编写）统一走 CODE_TOPICS 读代码题型。
     旧 POOLS.code 88 道里 66 道没自带干扰项，mkFromPool 只能从别的题答案里硬凑，
     于是冒出「可执行文件 / print / 未找到 / 视图 / 内存」这种跨类选项（P0）。
     CODE_TOPICS 的 mkCodeQ 每题自带同类干扰项，答案当场算出来。 */
  if(bk==='code'&&QA_TYPES.code.genSection)qs=QA_TYPES.code.genSection(n,diff,qaSection);
  if(!qs||!qs.length)qs=QA_TYPES[bk].gen(n,diff);
  var out=bk==='code'?langGuard(qs):qs;
  return applySection(out);
}
/* C3 补：自动匹配（无限模式）原本直接调 engine_core 的 genNextAuto() → T.gen()，
   绕过了 sectionGen ⟹ 编程选择题又掉回旧 POOLS.code 的硬凑干扰项，
   选择题板块还会混进 mkCodeFill 的填空题。这里把自动模式也接回 sectionGen。
   （genNextAuto 定义在 engine_core 的全局作用域，看不见本 IIFE 里的 sectionGen，
     所以只能在调用侧换掉。） */
function genAutoOne(){
  var bk=(typeKey&&typeKey.indexOf('b:')===0)?typeKey.slice(2):'';
  if(bk&&QA_TYPES[bk]){
    var qs=sectionGen(bk,1,autoQDiff());   /* C7：挑战中出 promoRank 的题 */
    if(bk==='code')qs=langGuard(qs);
    if(qs&&qs.length&&qs[0]&&qs[0].q)return qs[0];
  }
  return genNextAuto();
}
function switchSection(){
  promoReset();   /* C7：换板块 = 放弃挑战 */
  var bk=(typeKey&&typeKey.indexOf('b:')===0)?typeKey.slice(2):'';
  if(!bk||bk==='online'||bk==='weak'||bk==='srs'||bk==='round')return;
  var back=(lastRun&&lastRun.d!=null)?lastRun.d:(autoMode?'auto':curDiff);
  pickSection(bk,function(k){
    if(k===qaSection)return;
    qaSection=k;handMode=false;lastSectionBk=bk;
    doStartType(bk,null,back);
  });
}
/* 当前语言档案下是否真的有手写题。手写题库目前只有 C 与 JavaScript：
   勾选 Python / Java / SQL / HTML·CSS / 计算机通用时题池为空，
   以前要点开开关才被降级回普通题，现在提前把入口禁用并说明原因。 */
function handLangInfo(){
  var st=codeLangState(),allowed=codeAllowedLangs();
  var pool=CODE_TASKS.filter(function(x){
    if(!allowed)return true;
    var L=x.lang||'all';
    return L==='all'||allowed.indexOf(L)>=0;
  });
  if(!pool.length)return {ok:false,why:'当前语言暂无手写题（仅 C / C++ 与 JavaScript）；点难度面板的语言提示可改选',hint:''};
  var ls={};
  pool.forEach(function(x){ls[x.lang||'all']=1;});
  var names=Object.keys(ls).filter(function(k){return k!=='all';}).map(function(k){return langName(k);}).filter(Boolean);
  if(st.mode==='only')return {ok:true,why:'',hint:'AI 当场评判 · 当前语言：'+(names.join(' / ')||'已选语言')};
  return {ok:true,why:'',hint:'AI 当场评判 · C 与 JavaScript 混合出题'};
}
function setHandMode(on){
  if(on&&!canJudge()){toast('✍️ 手写代码要先配置 AI（点右上角 ⚙️，免费通道不用 Key）');return;}
  var _hi=handLangInfo();
  if(on&&!_hi.ok){toast(_hi.why);return;}
  if(locked)return;
  if(typeKey!=='b:code'||qaSection!=='code'){toast('手写代码只在「⌨️ 程序编写」板块可用');return;}
  handMode=!!on;
  if(handMode){
    var _ht=genHandTask(autoMode?autoQDiff():Math.max(0,curDiff));
    if(_ht){qlist[qidx]=_ht;}
    else{toast('当前语言暂无手写题，已切回普通题（仅 C / C++ 与 JavaScript 有手写题）');handMode=false;qlist[qidx]=sectionGen('code',1,Math.max(0,curDiff))[0];}
  }
  else{qlist[qidx]=sectionGen('code',1,Math.max(0,curDiff))[0];}
  showQuestion();
}

/* ---------- 开始 / 出题 ---------- */
function startType(bk,cn,forceDiff){
  if(bk==='online'){startOnline();return;}
  if(!bk&&!cn)return;
  /* 三板块：同一分类首次进入先选板块（自定义题库固定选择题，不打扰） */
  if(bk&&lastSectionBk!==bk){
    pickSection(bk,function(k){qaSection=k;lastSectionBk=bk;startType(bk,cn,forceDiff);});
    return;
  }
  if(forceDiff==='auto'){doStartType(bk,cn,'auto');return;}
  if(bk&&qaDiffs(bk)&&forceDiff==null){pickDiffPanel(bk,function(d){doStartType(bk,cn,d);});return;}
  doStartType(bk,cn,bk?qaNormDiff((typeof forceDiff==='number'&&forceDiff>=0)?forceDiff:qaDiffDefault(bk)):-1);
}
function qaNormDiff(d){return (typeof d==='number'&&d>=0)?d:0;}
/* 自定义题库出题：题量够时优先抽最近没出过的题，降低连开两局的重复率 */
function loadRecent(k){try{var a=JSON.parse(S.getItem(k)||'[]');return (a&&a.length)?a:[];}catch(e){return[];}}
function saveRecent(k,a){try{safeSet(k,JSON.stringify(a.slice(0,15)));}catch(e){}}
function makeCustomRound(tk,pairs){
  var all=pairs.slice();
  if(all.length>=15){
    var rec=loadRecent('bt_qa_recent_'+tk);
    var fresh=all.filter(function(p){return rec.indexOf(p.q)<0;});
    var pool=(fresh.length>=10)?fresh:all;
    var picked=shuffle(pool).slice(0,10);
    saveRecent('bt_qa_recent_'+tk,picked.map(function(p){return p.q;}).concat(rec).slice(0,15));
    return picked;
  }
  return shuffle(all).slice(0,Math.min(10,all.length));
}
function doStartType(bk,cn,d){
  var ds=bk?qaDiffs(bk):null;
  quizOver=false;reviewMode=false;cancelPending();navPush('quiz');
  customMixed=false;   /* 4.0.1-1：本局是否为「混合试卷」（自定义题库里含非选择题） */
  autoMode=(d==='auto');
  if(autoMode){selfRank=getRank(bk);curDiff=selfRank;}else{curDiff=(ds&&d>=0&&d<ds.length)?d:-1;}
  curDiffLabel=(curDiff>=0)?ds[curDiff].n:'';
  typeKey=bk?('b:'+bk):('c:'+cn);typeLabel=bk?QA_TYPES[bk].name:cn;
  combo=0;wrongCombo=0;selfWindow=[];lvlCool=0;handMode=false;lastAuto=null;_handUsed.length=0;roundShortMsg='';
  if(!bk)qaSection='choice';   // 自定义题库固定选择题，不弹板块面板
  if(bk){
    if(autoMode){qlist=[];total=Infinity;}
    else{var cnt=(curDiff>=0&&ds[curDiff].cnt)?ds[curDiff].cnt:10;qlist=sectionGen(bk,cnt,Math.max(0,curDiff));total=qlist.length;
      /* P0-2：无放回后题量可能不足，明确告知实际题数（绝不拿重复题凑数） */
      if(qlist.length<cnt){
        roundShortMsg='⚠️ 本类唯一题只有 '+qlist.length+' 题（所选档位是 '+cnt+' 题）· 本局按实际题量出题';
        toast('⚠️ 「'+QA_TYPES[bk].name+'」唯一题不足，本局改为 '+qlist.length+' 题（请求 '+cnt+' 题）');
      }
    }
  }else{
    var pairs=custom[cn]||[];if(!pairs.length){alert('该题库还没有题目，先去录入');return;}
    var picked=makeCustomRound(typeKey,pairs);
    qlist=picked.map(function(p){
      // AI / 免费搜索生成的题带选项，手动录入的是填空 —— 两者都要保留。
      // 4.0.1-1：type 决定四选一还是输入框；exp/src 让「判不中给解析」有内容可给。
      var _nt=qTypeOf(p);
      var o=(_nt==='choice'&&p.opts&&p.opts.length>=2)?shuffle(p.opts.slice()):null;
      return {q:p.q,a:p.a,opts:o,custom:true,type:_nt,exp:p.exp||'',src:p.src||''};
    });total=qlist.length;
    customMixed=qlist.some(isNonChoiceQ);
  }
  ok=0;qidx=0;score=0;answeredCount=0;roundWrong=[];scratchMap.clear();  /* 批次 B：开新局草稿不串题 */
  promoReset();   /* C7：开局一律回 idle（换分类/换板块/重开都走这里） */
  /* B 批：先学后练 —— 开启开关且该分类有知识卡时，开局前先弹知识卡覆盖层 */
  if(bk&&KNOW_CARDS[bk]&&JSON.parse(S.getItem('bt_qa_learn_before')||'false')){maybeShowCard(bk,function(){showQuestion();});}
  else{showQuestion();}
  lastRun={bk:bk,cn:cn,d:autoMode?'auto':curDiff};
  /* P0-5：移除静默 AI 补题（原本 900ms 后偷偷塞题进库）。题量不足不再自动写库，改由上面 toast 提示。 */
}

/* ---------- 批次 B：草稿板（数学全部 + 科学计算题；按题独立、仅本机、不参与判分） ---------- */
var scratchMap = new Map();   /* key = typeKey|qidx|Q.q → dataURL；内存态，不写 localStorage */
var scratchOpen = false, scratchCanvas = null, scratchKey = '', scratchPainting = false, scratchLast = null;
function needScratch(Q, bk) {
  if (!Q) return false;
  if (Q.scratch === true) return true;   /* 单题标记优先 */
  if (Q.hand || Q.code) return false;    /* 代码手写 / 读代码 / 补全：已有编辑器或会遮挡代码 */
  if (bk === 'math') return true;        /* 数学全部 */
  if (bk === 'science' && /计算|多少|等于|求|速度|压强|电流|电压|电阻|功率|面积|体积|浓度|质量|密度|浮力|热量|公式|路程|时间/.test(String(Q.q))) return true;
  return false;
}
function scratchKeyOf(Q) { return (typeKey || '') + '|' + qidx + '|' + String((Q && Q.q) || ''); }
function scratchPad() {
  var el = document.getElementById('scratchPad');
  if (el) { scratchCanvas = el.querySelector('canvas'); return el; }
  el = h('div'); el.id = 'scratchPad'; el.className = 'scratchpad';
  var head = h('div', 'sphead');
  head.appendChild(ht('div', 'sptitle', '📝 草稿板（仅本机，不参与判分）'));
  var ctr = h('div');
  var clr = ht('button', 'spbtn', '清空'); clr.onclick = function () { clearScratch(); };
  var col = ht('button', 'spbtn', '收起'); col.onclick = function () { closeScratch(true); };
  ctr.appendChild(clr); ctr.appendChild(col); head.appendChild(ctr); el.appendChild(head);
  var cv = document.createElement('canvas'); cv.className = 'spcv'; cv.style.touchAction = 'none';
  el.appendChild(cv); document.body.appendChild(el);
  scratchCanvas = cv; bindScratch(cv);
  return el;
}
function scratchPos(cv, e) { var r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
function scratchLine(cv, a, b) {
  var c = cv.getContext('2d');
  c.strokeStyle = '#2f2748'; c.lineWidth = 2.5; c.lineCap = 'round'; c.lineJoin = 'round';
  if (!a) { c.beginPath(); c.fillStyle = '#2f2748'; c.arc(b.x, b.y, 1.25, 0, Math.PI * 2); c.fill(); return; }
  c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
}
function bindScratch(cv) {
  cv.addEventListener('pointerdown', function (e) {
    scratchPainting = true; scratchLast = scratchPos(cv, e);
    try { cv.setPointerCapture(e.pointerId); } catch (x) {}
    scratchLine(cv, null, scratchLast);
    if (e.cancelable) e.preventDefault();
  });
  cv.addEventListener('pointermove', function (e) {
    if (!scratchPainting) return;
    var p = scratchPos(cv, e); scratchLine(cv, scratchLast, p); scratchLast = p;
    if (e.cancelable) e.preventDefault();
  });
  var end = function (e) { scratchPainting = false; scratchLast = null; if (e && e.cancelable) e.preventDefault(); };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  cv.addEventListener('pointerleave', function (e) { if (scratchPainting && e.pointerType !== 'touch') { scratchPainting = false; scratchLast = null; } });
}
function openScratch() {
  var Q = qlist[qidx]; if (!Q) return;
  cancelPending();   /* C1 二批：草稿板打开期间暂停「答对自动跳」，别刚答完就被计时器抢走 */
  scratchKey = scratchKeyOf(Q);
  var el = scratchPad(); el.style.display = 'block'; scratchOpen = true;
  var cv = scratchCanvas, dpr = window.devicePixelRatio || 1;
  requestAnimationFrame(function () {
    var w = cv.clientWidth || (el.clientWidth - 24) || 320, hh = 220;
    cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr);
    cv.style.width = w + 'px'; cv.style.height = hh + 'px';
    var c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, hh);
    var data = scratchMap.get(scratchKey);
    if (data) { var img = new Image(); img.onload = function () { try { c.drawImage(img, 0, 0, w, hh); } catch (e) {} }; img.src = data; }
  });
}
/* C1 二批：resume===true 只有「用户主动收起」（收起按钮 / Esc）才传 ——
   内部调用（切题、作答、返回书架）一律不传，否则切题瞬间会被重新计时顶掉下一题。 */
function closeScratch(resume) {
  if (!scratchOpen) return;
  if (scratchCanvas && scratchKey) { try { scratchMap.set(scratchKey, scratchCanvas.toDataURL('image/png')); } catch (e) {} }
  var el = document.getElementById('scratchPad'); if (el) el.style.display = 'none';
  scratchOpen = false; scratchPainting = false; scratchLast = null;
  /* 本题已答对 + 自动跳开着：收起草稿板后重新给 1 秒，看完草稿再走 */
  if (resume === true && !quizOver && curAnsCorrect && quickJump()) advance(QUICK_JUMP_DELAY);
}
function clearScratch() {
  if (!scratchCanvas) return;
  var c = scratchCanvas.getContext('2d');
  c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, scratchCanvas.width, scratchCanvas.height); c.restore();
  if (scratchKey) scratchMap.delete(scratchKey);
}
/* Esc 关闭草稿板（不影响 1-4 / Enter 答题） */
document.addEventListener('keydown', function (e) { if (scratchOpen && e && e.key === 'Escape') { closeScratch(true); } });
/* ---------- 答题页 ---------- */
function showQuestion(){
  if(quizOver)return;
  curAnsCorrect=false;   /* C1 二批：新题 = 未答对，草稿板「收起」不会误触发自动跳 */
  closeScratch();   /* 批次 B：切题前先收起并保存上一题草稿 */
  showView('stage');clearNode(stageEl);locked=false;
  if(qidx>=total&&!autoMode){endQuiz();return;}
  var Q;
  if(autoMode){
    /* 无限自适应：题不够就现生成，qidx 永不触发结算，退出由用户决定 */
    while(qlist.length<=qidx){
      /* 每档内尽量不重复：生成时避开最近 30 题的题干（含代码块指纹） */
      var _rk='bt_qa_recent_auto_'+(typeKey||'x').replace(/[^\w]/g,'_');
      var _rec=loadRecent(_rk),_tries=0,_nq=null,_nk='';
      do{
        _nq=(typeKey==='b:code'&&qaSection==='code'&&handMode)?genHandTask(autoQDiff()):genAutoOne();
        if(!_nq){if(handMode){toast('当前语言暂无手写题，已切回普通题（仅 C / C++ 与 JavaScript 有手写题）');handMode=false;}_nq=genAutoOne();}
        _nk=_nq.q+(_nq.code?('|'+_nq.code):'');
        _tries++;
      }while(_tries<8&&_rec.indexOf(_nk)>=0);
      try{_rec.unshift(_nk);safeSet(_rk,JSON.stringify(_rec.slice(0,30)));}catch(e){}
      qlist.push(applySection([_nq])[0]);
    }
    Q=qlist[qidx];
  }else{
    Q=qlist[qidx];
    /* 手写模式开关一旦打开，整局都出待手写题：以前只替换当前这一题，下一题又跳回读代码题，
       开关还显示「✍️ 手写代码：开」，非常误导。 */
    if(typeKey==='b:code'&&qaSection==='code'&&handMode&&Q&&!Q.hand){
      var _ht=genHandTask(Math.max(0,curDiff));
      if(_ht){Q=_ht;qlist[qidx]=Q;}
      else{toast('当前语言暂无手写题，已切回普通题（仅 C / C++ 与 JavaScript 有手写题）');handMode=false;}
    }
  }
  if(!Q){endQuiz();return;}
  var bk=(typeKey&&typeKey.indexOf('b:')===0)?typeKey.slice(2):'';
  var card=h('div','qcard quizfill');
  // 进度条：自动匹配是无限模式，进度条固定满格（不打表，只做氛围）
  var pb=h('div','pbar'+(autoMode?' inf':''));var pbi=h('i');pbi.style.width=(autoMode?'100%':(Math.round((qidx+1)/Math.max(1,total)*100)+'%'));pb.appendChild(pbi);card.appendChild(pb);
  var hud=h('div','hud');
  /* 4.0.1-1：自定义题库里混着填空/计算/实验时，别再固定写「选择题」 */
  var sec=ht('span','chip sec',customMixed?'📄 混合试卷':sectionName(qaSection));
  sec.title='点击切换板块';
  if(typeKey&&typeKey.indexOf('b:')===0&&typeKey!=='b:online'&&typeKey!=='b:weak'&&typeKey!=='b:srs'&&typeKey!=='b:round'){sec.onclick=function(){switchSection();};}
  hud.appendChild(sec);
  var _tik='';if(typeKey.indexOf('b:')===0&&QA_TYPES[typeKey.slice(2)])_tik=QA_TYPES[typeKey.slice(2)].icon+' ';
  var _badge='';
  if(typeKey==='b:code'){var _cp=getCodeProfile();if(_cp&&_cp.done&&_cp.langs&&_cp.langs.length){_badge=' · '+langName(_cp.langs[0])+(_cp.langs.length>1?(' 等'+_cp.langs.length+'种'):'');}}
  /* C4：标准池是扁平题库（换档不改题目难度），自动模式报「实力：困难」是假的 → 只在真按档生成时才有实力 */
  /* C7：档位区单独一个 span —— 挑战开始/结算时要能原地改写文案（syncHudLevel） */
  var hlEl=ht('div','hl',_tik+typeLabel+_badge);
  hlEl.appendChild(ht('span','lvt',autoLevelTxt(bk)));
  hud.appendChild(hlEl);
  hud.appendChild(ht('div','hr',autoMode?('第 '+(qidx+1)+' 题 · 无限模式'):('第 '+(qidx+1)+'/'+total)));
  /* 无限模式没有「满分」，头顶只留实力与题数，得分放结算页，避免四个 chip 挤成省略号 */
  if(!autoMode)hud.appendChild(ht('span','chip','✅ '+ok));
  card.appendChild(hud);
  /* C4：toast 会消失，玩家会以为「40 题的局丢题了」→ 整局常驻一行说明 */
  if(roundShortMsg&&!autoMode&&isFinite(total)){
    var _rsh=ht('div','hint',roundShortMsg);
    _rsh.style.color='#a8690a';_rsh.style.margin='2px 0 0';
    card.appendChild(_rsh);
  }
  /* 批次 B：需要草稿板的题（数学全部 / 科学计算题 / Q.scratch）在题干上方给一个入口 chip */
  if(needScratch(Q,bk)){
    var _sbar=h('div','scratchbar');
    var _sbtn=ht('button','chip scratchchip','📝 草稿');
    _sbtn.onclick=function(){openScratch();};
    _sbar.appendChild(_sbtn);card.appendChild(_sbar);
  }
  if(typeKey==='b:code'&&qaSection==='code'){
    var swr=h('div','swrow');
    var _hi=handLangInfo();
    var tg=h('button','toggle'+(handMode?' on':''),_hi.ok?(handMode?'✍️ 手写代码：开':'✍️ 手写代码：关'):'✍️ 手写代码：当前语言不可用');
    if(!_hi.ok)tg.disabled=true;                 /* .toggle:disabled 已带灰化样式 */
    tg.onclick=function(){if(!_hi.ok){toast(_hi.why);return;}setHandMode(!handMode);};
    swr.appendChild(tg);
    swr.appendChild(ht('span','hint2',!canJudge()?'手写题需先配置 AI（免费通道即可）':(_hi.ok?_hi.hint:_hi.why)));
    card.appendChild(swr);
  }

  if(typeKey==='b:online'&&Q&&Q.src==='offline')card.appendChild(ht('div','hint','📴 联网不可用，正在使用本地离线题库（返回书架点「🔄 联网更新题库」可重试）'));
  // 题干（全屏：吃掉中间剩余高度）；带代码/手写标记的题用左对齐 + 代码块
  var qbox=h('div','qbox fill');
  if(Q.code||Q.hand){
    qbox.className='qbox fill hascode';
    qbox.appendChild(ht('div','qlead',Q.q));
    if(Q.code){var pre=h('pre','codeblk');pre.textContent=Q.code;qbox.appendChild(pre);}
    if(Q.hand&&Q.task){qbox.appendChild(ht('div','hint','样例：'+Q.task.ex+'　（'+Q.task.tip+'）'));}
    if(Q.fillin)qbox.appendChild(ht('div','hint','✍️ 把空缺处该填的代码写进下面的输入框'));
  }else{qbox.textContent=Q.q;}
  card.appendChild(qbox);
  // P0-5：AI 生成的题标注「未审核」，提醒答案未经人工核对
  if(Q&&Q.ai)card.appendChild(ht('div','hint','🤖 AI 生成题 · 未审核（答案未经人工核对，书架「🗑 清空 AI 补充题」可删）'));
  // 选项 / 手写输入 / 填空
  if(Q.hand){
    var ta=document.createElement('textarea');
    ta.className='codeinp';ta.rows=6;
    ta.placeholder='// 写你的代码（JS 可直接自测）';
    ta.setAttribute('autocapitalize','off');ta.setAttribute('autocorrect','off');ta.setAttribute('spellcheck','false');
    var edWrap=h('div');card.appendChild(edWrap);
    codeEditor(edWrap,ta);        /* textarea 由 codeEditor 挂进高亮层，别再 card.appendChild(ta) */
    var hr=h('div','row');
    var runB=h('button','btn runbtn','▶ 运行自测');runB.style.flex='1';
    runB.title='本地执行题目样例、对比期望值（Ctrl+Shift+Enter）';
    var hsb=h('button','btn gold submitbtn','🤖 提交 AI 评判');hsb.style.flex='1';
    hsb.title='交给 AI 判分，语言不限（Ctrl+Enter）';
    var hmsg=h('div','hint','');
    var canDo=canJudge();
    if(!canDo)hsb.disabled=true;
    runB.onclick=function(){runSelfTest(Q,ta.value,hmsg);};
    hsb.onclick=function(){submitHand(Q,ta.value,hsb,hmsg);};
    hr.appendChild(runB);hr.appendChild(hsb);card.appendChild(hr);card.appendChild(hmsg);
    if(!canDo)hmsg.textContent='⚠️ 未配 AI：「▶ 运行自测」照样能用（JS 写法本地跑），要 AI 判分请点右上角 ⚙️';
    var unkH=h('button','unkbtn','😵 不会 · 跳过本题');unkH.onclick=function(){markUnknown();};card.appendChild(unkH);
  }else if(Q.opts){
    var opts=h('div','opts');
    Q.opts.forEach(function(op,i){var b=h('button','obtn');b.textContent=op;b.setAttribute('data-k',String(i+1));b.onclick=function(){answer(op===Q.a,op,Q.a,b);};opts.appendChild(b);});
    card.appendChild(opts);
    var unk=h('button','unkbtn','😵 不会 · 记入薄弱题');unk.onclick=function(){markUnknown();};card.appendChild(unk);
  }else{
    var ir=h('div','row');ir.style.marginTop='4px';
    var ti=h('input');ti.type='text';
    /* 4.0.1-1：填空 / 计算 / 实验共用同一个输入框判分（fillEqual 归一化：去空格标点、分数小数、上标） */
    var _qt=qTypeOf(Q);
    ti.placeholder=(_qt==='calc'?'输入计算结果（只写数值/表达式）':(_qt==='experiment'?'输入实验现象/结论的关键词':'输入答案'));
    ti.style.flex='1';
    ti.setAttribute('autocapitalize','off');ti.setAttribute('autocorrect','off');ti.setAttribute('spellcheck','false');
    var sb=h('button','btn gold','提交');sb.onclick=function(){answer(fillEqual(ti.value,Q.a),ti.value,Q.a);};
    ti.onkeydown=function(e){if(e&&e.key==='Enter'){sb.click();}};
    ir.appendChild(ti);ir.appendChild(sb);card.appendChild(ir);
    var unk2=h('button','unkbtn','😵 不会 · 记入薄弱题');unk2.onclick=function(){markUnknown();};card.appendChild(unk2);
  }

  // 固定反馈预留区：空着也占位，反馈条出现不会把选项往上顶
  var fz=h('div','fbzone');fz.id='fbzone';card.appendChild(fz);
  // 底部操作
  var foot=h('div','quizfoot');foot.style.marginTop='12px';
  if(autoMode){
    var quitA=h('button','btn ghost','🏁 结束并结算');
    quitA.onclick=function(){endQuiz();};
    foot.appendChild(quitA);
  }else{
    var quit=h('button','btn ghost','🏠 退出本局');
    quit.onclick=function(){if(confirm('退出本局？本局成绩不保存。'))backOneLayer();};
    foot.appendChild(quit);
  }
  card.appendChild(foot);

  stageEl.appendChild(card);
}
/* 作答后锁死所有可点的东西：选项、不会、填空输入框与提交、手写输入框与 AI 提交。
   现在答错会停住不跳，留着点了没反应的按钮比直接禁掉更让人困惑。 */
function lockOpts(){var bs=stageEl.querySelectorAll?stageEl.querySelectorAll('.obtn,.unkbtn,.codeinp,.qcard .row .btn'):[];try{[].slice.call(bs).forEach(function(b){b.disabled=true;});}catch(e){}}
// 反馈条进固定预留区（#fbzone）；没有预留区时（结算页等）回退到旧逻辑
function appendFb(fb){
  var z=stageEl.querySelector?stageEl.querySelector('#fbzone'):null;
  if(z){clearNode(z);z.appendChild(fb);return;}
  var c=stageEl.querySelector?stageEl.querySelector('.qcard'):null;
  var f=c&&c.querySelector?c.querySelector('.quizfoot'):null;
  if(c&&f)c.insertBefore(fb,f);else stageEl.appendChild(fb);
}
function markChosen(btn,ans){
  var bs=stageEl.querySelectorAll?stageEl.querySelectorAll('.obtn'):[];
  try{[].slice.call(bs).forEach(function(b){
    b.disabled=true;
    if(String(b.textContent)===String(ans))b.classList.add('right');
    else if(btn&&b===btn)b.classList.add('wrong');
  });}catch(e){}
}
/* ---------- 题目解析：程序化题带 exp，人工题走 AI 兜底 ---------- */
function expText(Q){return (Q&&Q.exp)?String(Q.exp):'';}
/* 语言判定：ASCII 字母占字符数的比例（中文题通常 < 0.2，英文题接近 1） */
function enRatio(s){
  s=String(s==null?'':s);if(!s.length)return 0;
  var a=0;for(var i=0;i<s.length;i++){var c=s.charCodeAt(i);if((c>=65&&c<=90)||(c>=97&&c<=122))a++;}
  return a/s.length;
}
function isEnText(s){return enRatio(s)>0.5;}
function cnCount(s){
  s=String(s==null?'':s);var n=0;
  for(var i=0;i<s.length;i++){var c=s.charCodeAt(i);if(c>=0x4e00&&c<=0x9fa5)n++;}
  return n;
}
/* 单个词 / 代码片段（def、lambda、[x for x in a]、printf("%d")）不算「英文选项」：
   「Python 中哪个关键字定义函数？」这类题的选项本来就是英文标识符，按字符占比会全部误杀。 */
function isCodeish(s){
  s=String(s==null?'':s).trim();
  if(/[(){}\[\];:=<>+*\/%#&|!"']/.test(s))return true;   /* 含代码符号（冒号要有：lambda x: x 这类） */
  return s.indexOf(' ')<0&&s.length<=16;               /* 单个词 / 标识符 */
}
/* 英文题：题干基本没有中文（汉字少于 4 个）且字母过半 —— 纯字母占比会误杀
   「SQL 中 JOIN 的作用？」这种中文提问夹英文术语的正常题，所以先看有没有中文。
   中文题干只可能因为「选项是成句英文」被判英文（单个词 / 代码片段放行）。 */
function isEnglishQ(q){
  if(!q)return false;
  var stem=q.q||'';
  if(cnCount(stem)<4&&isEnText(stem))return true;
  /* 选项同理：夹着中文的（「len 是内置函数」）不算英文选项 */
  return (q.opts||[]).some(function(o){return !isCodeish(o)&&cnCount(o)<2&&isEnText(o);});
}
/* 一句话解析（独立于 callAI：那个只认「题目 JSON 数组」，讲题走原始文本通道）。
   英文题先让 AI 翻译再解析：解析永远用中文写，不翻译就会「中文解析配英文题干」。 */
function aiExplain(Q,cb){
  cb=cb||function(){};
  var cfg=loadAICfg();
  if(!cfg||!cfg.url||!(cfg.key||isFreeAI(cfg.url))){cb('');return;}
  var q=String((Q&&Q.q)||'').slice(0,300),a=String((Q&&Q.a)||'').slice(0,100);
  var code=Q&&Q.code?('\n代码：\n'+String(Q.code).slice(0,400)):'';
  var en=isEnText(q)||((Q&&Q.opts)||[]).filter(function(o){return isEnText(o);}).length>=2;
  var prompt=en
    ?('你在讲题。题目：'+q+code+'\n正确答案：'+a+
      '\n题目是英文。请先把题目和选项翻译成中文，再用不超过 40 字的一句话中文解析为什么是这个答案（讲清关键一步，别复述题目）。\n严格只返回 JSON：{"trans":"题目中文翻译","exp":"解析内容"}')
    :('你在讲题。题目：'+q+code+'\n正确答案：'+a+
      '\n请用不超过 40 字的一句话中文解析为什么是这个答案（讲清关键一步，别复述题目）。\n严格只返回 JSON：{"exp":"解析内容"}');
  callAIRaw(cfg,prompt,function(txt){
    if(!txt){cb('');return;}
    var t=String(txt),m=t.match(/\{[\s\S]*?\}/);
    if(m){
      try{
        var o=JSON.parse(m[0]);
        if(o&&(o.exp||o.trans)){cb(o.exp?String(o.exp).slice(0,60):'',o.trans?String(o.trans).slice(0,140):'');return;}
      }catch(e){}
    }
    var ex=t.match(/"exp"\s*:\s*"([^"]*)"/),tr=t.match(/"trans"\s*:\s*"([^"]*)"/);
    if(ex||tr){cb(ex?ex[1].slice(0,60):'',tr?tr[1].slice(0,140):'');return;}
    var plain=t.replace(/[{}"]/g,'').replace(/^\s*exp\s*:\s*/,'').trim();
    if(plain&&plain.length<=70&&/[\u4e00-\u9fa5]/.test(plain)){cb(plain);return;}
    cb('');
  },20000);
}
/* 把解析挂到反馈条：有 exp 直接显示，没有就给一个「💡 AI 解析」按钮（手写题判错也走这里） */
function appendExp(fb,Q){
  var e=expText(Q);
  if(e){fb.appendChild(ht('div','fexp','💡 解析：'+e));return;}
  if(!Q)return;
  var b=ht('button','chip aibtn','💡 AI 解析');
  b.onclick=function(){
    if(!canJudge()){toast('未配置 AI：点右上角 ⚙️ 选服务商（免费通道不用 Key）就能生成解析');return;}
    b.disabled=true;b.textContent='💡 解析中…';
    aiExplain(Q,function(t,tr){
      if(!t&&!tr){b.disabled=false;b.textContent='💡 重试 AI 解析';return;}
      /* 英文题：译文 + 解析一起给，先看懂题目再看懂为什么 */
      var box=ht('div','fexp');
      if(tr)box.appendChild(ht('div','fexpL','💬 译文：'+tr));
      if(t)box.appendChild(ht('div','fexpL','💡 解析：'+t));
      if(b.parentNode)b.parentNode.replaceChild(box,b);else fb.appendChild(box);
    });
  };
  fb.appendChild(b);
}
/* C1：题目来源小字行（解析之后）。人工题大多带 src，答错/不会时顺手告诉用户「这说法出自哪」，
   比让用户自己猜更可信；没有 src 的题（AI/生成题）自动跳过。 */
function appendSrc(fb,Q){
  if(!Q||!Q.src)return;
  fb.appendChild(ht('div','fexp fexpL','📚 来源：'+Q.src));
}
function appendNextChip(fb){
  var b=ht('button','chip fbnext','下一题 ›');
  b.onclick=function(){goNext();};
  fb.appendChild(b);
}
/* 「🔄 重试」：把同一题重新渲染出来再答一次。分数只认「首次 + 一次重试奖励」，杜绝反复刷分。
   showQuestion 会重建选项/输入框，而 lockOpts 只在作答后锁 —— 重渲染天然解锁，不用额外处理。 */
function retryQuestion(){
  var _Q=qlist[qidx];if(!canRewrite(_Q))return;   /* 选项/填空永远不能重写，避免误触把非手写题重渲染 */
  cancelPending();            /* 清掉任何残留的自动跳转计时 */
  locked=false;               /* 解锁，允许再次作答 */
  showQuestion();             /* qidx 不动；Q 还是同一对象，settled 标记保留 */
}
function canRewrite(Q){return !!(Q&&Q.hand===true);}
function appendRewriteChip(fb){
  var b=ht('button','chip fbretry','✍️ 重写代码');
  b.onclick=function(){retryQuestion();};
  fb.appendChild(b);
}
/* 参考代码块：手写题答错/不会时展示正确实现 —— 错题是学习时刻，光说「错了」没用，
   得让用户看到正确写法。sol 只存在于手写题（CODE_TASKS），其它题型自动跳过。 */
function appendSol(fb,Q){
  if(!Q||!Q.sol)return;
  var box=h('div','fsol');
  box.appendChild(ht('div','fsol-t','✅ 参考代码'));
  var pre=h('pre','fsol-code');pre.textContent=Q.sol;
  box.appendChild(pre);
  fb.appendChild(box);
}
/* 答题思路步骤列表：分步讲清「先干什么后干什么」，手写题的 steps 来自 CODE_TASKS */
function appendSteps(fb,Q){
  var st=Q&&Q.steps;
  if(!st||!st.length)return;
  var box=h('div','fsteps');
  box.appendChild(ht('div','fsteps-t','🧭 答题思路'));
  st.forEach(function(s,i){
    box.appendChild(ht('div','fstep',(i+1)+'. '+s));
  });
  fb.appendChild(box);
}
/* 走题节奏：只有「答对」自动跳（800ms，保持流畅）；答错 / 不会一律停住，
   由用户点「🔄 重试」或「下一题 ›」决定去向 —— 错题是学习时刻，不该被计时器抢走。 */
var nextTimer=null;
function cancelPending(){if(nextTimer){try{clearTimeout(nextTimer);}catch(e){}nextTimer=null;}}
function advance(ms){
  cancelPending();
  nextTimer=later(function(){nextTimer=null;qidx++;showQuestion();},ms||800);
}
function goNext(){cancelPending();qidx++;showQuestion();}

/* ---------- 页面层级：浏览器返回只回退一层（书架是根，根上再返回才退出网页） ---------- */
var navStack=['shelf'];
var NAV_BUSY=false,NAV_DRAIN=0;
var NAV_SEQ=0;   /* C6：给每个 pushState 帧盖序号，关浮层时只弹自己那一帧 */
function navTop(){return navStack[navStack.length-1]||'shelf';}
/* 回书架：只把栈归零。⚠ 这里绝不能动 history —— 一旦当前站在历史首页，
   history.back() 会把整个页面顶出去（踩过：退出薄弱题回顾直接跳回 about:blank）。 */
function navReset(){navStack=['shelf'];NAV_DRAIN=0;}
/* 进深层：栈里记一层，同时压一帧，保证浏览器返回键有东西可 pop */
function navPush(k){
  if(navTop()===k)return;
  navStack.push(k);NAV_DRAIN=0;
  try{history.pushState({qnav:1,seq:++NAV_SEQ},'');}catch(e){}
}
function navDrop(k){
  for(var i=navStack.length-1;i>=0;i--){if(navStack[i]===k){navStack.splice(i,1);return;}}
}
/* 应用内回退一层：按栈顶决定退回哪个界面 */
function backOneLayer(){
  closeScratch();   /* 批次 B：返回书架前保存并收起草稿 */
  var top=navTop();
  if(top==='quiz'){
    navStack.pop();
    if(autoMode){endQuiz();return;}                 /* 无限模式：返回 = 结束并结算 */
    if(reviewMode){var _ro=reviewOne;reviewMode=false;reviewOne=false;cancelPending();navReset();renderShelf();if(_ro)openWeakBook();return;}
    var bk=(typeKey&&typeKey.indexOf('b:')===0)?typeKey.slice(2):'';
    if(lastRun&&lastRun.bk&&bk===lastRun.bk&&bk!=='online'){
      quizOver=true;cancelPending();
      renderShelf();                                  /* 先把书架铺回去，面板取消后落回书架 */
      startType(lastRun.bk,lastRun.cn,null);return;  /* 回到上次的难度面板 */
    }
    cancelPending();navReset();renderShelf();return;
  }
  if(top==='finish'){cancelPending();navReset();renderShelf();return;}
  if(top==='diff'||top==='section'||top==='overlay'){
    var ov=document.getElementById('curOverlay');
    if(ov)closeOverlay({ov:ov});
    if(top!=='overlay'){cancelPending();navReset();renderShelf();}
    return;
  }
}
function navInit(){
  try{history.replaceState({qnav:0},'');}catch(e){}
  window.addEventListener('popstate',function(){
    if(NAV_BUSY){NAV_BUSY=false;return;}
    NAV_BUSY=true;
    try{
      if(navTop()==='shelf'){
        /* 书架是根：这一下就是「退出网页」。历史里若还留着我们压过的帧，一路排空到真正离开 */
        /* 上限放宽到 80：一次会话里每进一层就压一帧，长会话积几十帧，20 会排不干净（实测卡在书架退不出去） */
        if(history.length>1&&NAV_DRAIN<80){NAV_DRAIN++;try{history.back();}catch(e){NAV_DRAIN=0;}}
        return;
      }
      backOneLayer();
    }finally{NAV_BUSY=false;}
  });
}

/* 自适应升降档是「立刻生效」的：答错 / 不会要停留 2.5s 让玩家读解析，
   不能让 HUD 的实力档等下一题才变（玩家会以为没生效）。 */
function syncHudLevel(){
  if(!autoMode)return;
  var el=document.querySelector('#stage .hud .hl .lvt');
  if(!el)return;
  var bk=(typeKey&&typeKey.indexOf('b:')===0)?typeKey.slice(2):'';
  el.textContent=autoLevelTxt(bk);
}
function markUnknown(){
  closeScratch();   /* 批次 B：作答时收起，避免遮挡反馈 */
  if(locked)return;locked=true;
  curAnsCorrect=false;   /* C1 二批：「不会」永远不自动跳 */
  var Q=qlist[qidx];
  /* 首次作答才结算（记薄弱题 / 记自适应窗口）；重试后再按「不会」不再重复记 */
  var first=!(Q&&Q.settled);
  if(Q)Q.settled=true;
  var recorded=false;
  var _promoTip='';   /* C7：挑战反馈文案（结算后 promoCorrect 已清零，必须先取） */
  if(first){
    answeredCount++;   /* 4.0.1-2：点「不会」也算作答过（自动模式结算分母） */
    if(Q&&!reviewMode&&!Q.hand){
      addWeak({type:typeKey,diff:curDiff,q:Q.q,a:Q.a,opts:Q.opts?Q.opts.slice():null,code:Q.code,exp:Q.exp,sol:Q.sol,steps:Q.steps,fillin:Q.fillin,pick:'（不会）',tag:Q.tag||'',src:Q.src,time:Date.now()});
      recorded=true;
    }
    /* C2：SRS 复习里点「不会」—— 该题间隔重置，due 改为明天，不再连续出现 */
    if(typeKey==='b:srs'&&Q&&Q.weak){srsAdvance(Q.weak,false);Q.weak.t=Date.now();srsTouch(Q.weak);}
    /* P2-A1：本局错题（回顾局不记，回顾本身就是错题本）
       4.0.1-3：手写题不进来 —— 与 answer() 的错题分支对齐（重练要再烧一次 AI 评判，
       而且代码题被塞进「只练这几题」会当填空渲染）。 */
    if(Q&&!reviewMode&&!Q.hand&&Q.q){
      roundWrong.push({q:Q.q,a:Q.a,given:'（未作答）',opts:Q.opts?Q.opts.slice():null,code:Q.code,exp:Q.exp,sol:Q.sol,steps:Q.steps,src:Q.src,tag:Q.tag||''});
    }
    if(autoMode){
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
    }
  }
  lockOpts();
  var fb=h('div','fb unk');
  var _unkMsg='😵 已跳过本题'+(recorded?'，已记入薄弱题':'');
  if(typeKey==='b:srs')_unkMsg='😵 已跳过本题 · 明天再复习一次';
  fb.appendChild(ht('div','fbm',_unkMsg));
  if(Q&&Q.a!=null&&String(Q.a)!=='')fb.appendChild(ht('div','fba','正确答案：'+Q.a));
  appendSol(fb,Q);      // 手写题：✅ 参考代码
  appendSteps(fb,Q);    // 手写题：🧭 答题思路
  appendExp(fb,Q);      // 解析（手写题有要点，选择题有 exp / AI 解析按钮）
  appendSrc(fb,Q);      // 来源（C1）
  if(_promoTip)fb.appendChild(ht('div','fpromo',_promoTip));   // C7：升档挑战 n/2
  /* 重试对所有题型开放：看过参考代码后自己再写一遍，正是「学习时刻」的意义。
     手写题此时并未提交过，重试不会多烧 AI 调用。 */
  if(canRewrite(Q))appendRewriteChip(fb);
  appendNextChip(fb);
  appendFb(fb);
  /* 不再 advance()：错题是学习时刻，去留由用户点「重试」还是「下一题」决定 */
}

/* C1（二批）：答对先显示解析/来源，1 秒后自动跳 —— 默认开启（需求变更，上一批默认关）。
   1 秒内点「下一题」立即跳（goNext 已 cancelPending，不会重复跳）。
   答错 / 不会仍停住，去留由用户点「重写代码」还是「下一题」决定。 */
var QUICK_JUMP_DELAY=1000;
function quickJump(){try{return JSON.parse(S.getItem('bt_qa_quickjump')||'true')!==false;}catch(e){return true;}}
function maybeAdvance(correct,ms){if(correct&&quickJump())advance(ms||QUICK_JUMP_DELAY);else cancelPending();}
/* C1 二批：本题是否已答对（草稿板「收起」后据此重新计时，避免开了草稿板就再不自动跳） */
var curAnsCorrect=false;
function answer(correct,given,ans,btn,opt){
  closeScratch();   /* 批次 B：作答时收起，避免遮挡反馈 */
  if(locked)return;locked=true;
  opt=opt||{};
  var _bk=(typeKey&&typeKey.indexOf('b:')===0)?typeKey.slice(2):'';
  var Q=qlist[qidx];
  var _promoTip='';   /* C7：挑战反馈文案（结算后 promoCorrect 已清零，必须先取） */
  /* 首次 / 重试分层：重试只给 +5 学习奖励 —— 不扣分、不重复记薄弱题、不重复记窗口、不重复升降档 */
  var first=!(Q&&Q.settled);
  if(Q)Q.settled=true;
  curAnsCorrect=!!correct;   /* C1 二批：草稿板「收起」后据此重新计时（重试答对也算） */
  if(reviewMode){
    if(btn)markChosen(btn,ans);else lockOpts();
    var fbR=h('div','fb '+(correct?'ok':'no'));
    var _roundR=(typeKey==='b:round');
    /* B 批：SRS 复习局 —— 走间隔升档/重置，不复用 b:weak「答对即移除」语义 */
    if(typeKey==='b:srs'){
      if(correct){
        ok++;   /* C2：SRS 答对也要计入 ok，否则结算 0/N */
        var _rec=Q&&Q.weak;
        if(_rec){
          var _mastered=srsAdvance(_rec,true);
          if(_mastered){removeWeak(_rec);fbR.textContent='✅ 答对了！连续 30 天档答对，已掌握并移出复习队列';}
          else{_rec.t=Date.now();srsTouch(_rec);var _iv=SRS_INTERVALS[_rec.srs.lv];fbR.textContent='✅ 答对了！下次复习：'+_iv+' 天后';}
        }else{fbR.textContent='✅ 答对了！';}
        /* C1：答对也讲清楚 —— 解析/来源 + 下一题（默认不自动跳） */
        appendExp(fbR,Q);appendSrc(fbR,Q);appendNextChip(fbR);
      }else{
        var _rec2=Q&&Q.weak;
        if(_rec2){srsAdvance(_rec2,false);_rec2.t=Date.now();srsTouch(_rec2);}
        fbR.textContent='❌ 正确答案：'+ans+'（明天再复习一次）';
        appendSol(fbR,Q);appendSteps(fbR,Q);appendExp(fbR,Q);appendSrc(fbR,Q);appendNextChip(fbR);
      }
      appendFb(fbR);
      maybeAdvance(correct);   /* C1：默认不自动跳，看设置 */
      return;
    }
    if(correct){
      ok++;
      if(_roundR){
        /* 本局错题回顾：答对即从本轮错题移除（不是薄弱题本，不参与 SRS） */
        dropRoundWrong(Q&&Q.q);
        fbR.textContent='✅ 答对了！已从本轮错题移除';
      }else{
        /* C2：掌握标准统一 —— 薄弱题本答对推进 SRS 间隔，30 天档答对才算掌握（不再一次移除） */
        var _recW=Q&&Q.weak;
        if(_recW){
          var _masteredW=srsAdvance(_recW,true);
          if(_masteredW){removeWeak(_recW);fbR.textContent='✅ 答对了！连续 30 天档答对，已掌握并移出薄弱题本';}
          else{_recW.t=Date.now();srsTouch(_recW);fbR.textContent='✅ 答对了！下次复习：'+SRS_INTERVALS[_recW.srs.lv]+' 天后（30 天档答对才算掌握）';}
        }else{fbR.textContent='✅ 答对了！';}
      }
      /* C1：答对也讲清楚 —— 解析/来源 + 下一题（默认不自动跳） */
      appendExp(fbR,Q);appendSrc(fbR,Q);appendNextChip(fbR);
    }
    else{
      if(_roundR){
        /* 「只练这几题」不是薄弱题本：答错只是原地保留，别往 bt_qa_weak 里塞一条 b:round */
        fbR.textContent='❌ 正确答案：'+ans+'（仍在本轮错题里，稍后可再练）';
      }else{
        /* P1-2：回顾里答错要计数 +1（此前只提示「保留」，次数不会涨） */
        var _wk=(Q&&Q.weak)||{};
        addWeak({type:_wk.type||typeKey,diff:_wk.diff,q:Q.q,a:Q.a,opts:Q.opts?Q.opts.slice():null,
          code:Q.code,exp:Q.exp,sol:Q.sol,steps:Q.steps,fillin:Q.fillin,pick:given||null,tag:Q.tag||'',src:Q.src});
        fbR.textContent='❌ 正确答案：'+ans+'（保留在薄弱题，错误次数 +1）';
      }
      appendSol(fbR,Q);appendSteps(fbR,Q);appendExp(fbR,Q);appendSrc(fbR,Q);if(canRewrite(Q))appendRewriteChip(fbR);appendNextChip(fbR);
    }
    appendFb(fbR);
    maybeAdvance(correct);   /* C1：默认不自动跳，看设置 */
    return;
  }
  var _pen=(curDiff>=2&&_bk&&QA_TYPES[_bk]&&QA_TYPES[_bk].pen)?5:0;
  if(first){
    answeredCount++;   /* 4.0.1-2：自动模式结算分母 = 真正作答过的题数（不是 qidx） */
    if(correct){ok++;score+=10;
      /* B 批：普通局首次答对 —— 若该题在薄弱题本里，推进其 SRS 间隔（达 30 天档则掌握移除并提示） */
      var _wa=loadWeak();
      for(var _wi=0;_wi<_wa.length;_wi++){if(_wa[_wi]&&_wa[_wi].type===typeKey&&_wa[_wi].q===Q.q){
        if(srsAdvance(_wa[_wi],true)){removeWeak(_wa[_wi]);toast('🎉 已通过 SRS 复习掌握：'+Q.q);}
        else{saveWeak(_wa);}
        break;}}}
    else{
      if(_pen){score-=5;}
      /* 首次答错也沉淀进薄弱题（结算页文案一直说「错题会进薄弱题」，之前只有「😵 不会」会记）。
         重试答错不重复记 —— 同一题只留一条。 */
      if(Q&&!Q.hand)addWeak({type:typeKey,diff:curDiff,q:Q.q,a:Q.a,opts:Q.opts?Q.opts.slice():null,code:Q.code,exp:Q.exp,sol:Q.sol,steps:Q.steps,fillin:Q.fillin,pick:(given==null?null:String(given)),tag:Q.tag||'',src:Q.src,time:Date.now()});
      /* P2-A1：本局错题回顾（手写题不进来：重练要再烧一次 AI 评判） */
      if(Q&&!Q.hand&&Q.q)roundWrong.push({q:Q.q,a:Q.a,given:(given==null?'（未作答）':String(given)),opts:Q.opts?Q.opts.slice():null,code:Q.code,exp:Q.exp,sol:Q.sol,steps:Q.steps,src:Q.src,tag:Q.tag||''});
    }
    if(autoMode&&_bk&&QA_TYPES[_bk]&&QA_TYPES[_bk].diffs){
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
    }
  }else if(correct){score+=5;}
  if(btn)markChosen(btn,ans);else lockOpts();
  var fb=h('div','fb '+(correct?'ok':'no'));
  if(opt.note){
    var noteTxt=(correct?'✅ 判为正确 '+(first?'＋10':'＋5'):('❌ 判为不正确'+((first&&_pen)?'　（−5 分）':'')))+'　'+opt.note;
      if(correct){fb.textContent=noteTxt;appendExp(fb,Q);appendSrc(fb,Q);appendNextChip(fb);}
      else{
        fb.appendChild(ht('div','fbm',noteTxt));
        /* 手写题由 AI 评判（耗时、每次都要钱），不给「重试」；但必须给解析与正确写法 ——
           只说「判为不正确」等于什么都没教，参考代码 + 思路才是学习时刻。 */
        appendSol(fb,Q);appendSteps(fb,Q);appendExp(fb,Q);appendSrc(fb,Q);if(canRewrite(Q))appendRewriteChip(fb);appendNextChip(fb);
      }
  }else{
    fb.textContent=correct?(first?'✅ 答对了！＋10':'✅ 重试答对了！＋5')
      :('❌ 正确答案：'+ans+((first&&_pen)?'　（−5 分）':''));
    if(!correct){appendSol(fb,Q);appendSteps(fb,Q);appendExp(fb,Q);appendSrc(fb,Q);if(canRewrite(Q))appendRewriteChip(fb);appendNextChip(fb);}
    else{appendExp(fb,Q);appendSrc(fb,Q);appendNextChip(fb);}
  }
  if(_promoTip)fb.appendChild(ht('div','fpromo',_promoTip));   // C7：升档挑战 n/2
  appendFb(fb);
  if(first)bumpStat(typeKey,correct);
  /* 答对保持自动跳（800ms），不打断节奏；答错 / 不会一律停住，等用户决定重试还是下一题 */
  maybeAdvance(correct,opt.wait||800);   /* C1：默认不自动跳，看设置 */
}

function endQuiz(){
  quizOver=true;
  promoReset();   /* C7：结算/退出 = 放弃挑战，不补发升档 */
  if(reviewMode){reviewMode=false;finish(score);return;}
  var key=(autoMode&&typeKey.indexOf('b:')===0)?(typeKey+':auto'):((curDiff>=0)?(typeKey+':'+curDiff):typeKey);
  if(autoMode){
    /* 4.0.1-2：无限模式没有预设题量，分母必须用「真正作答过的题数」——
       旧写法 total=qidx 是「已经切到第几题」，答完当前题还没点下一题时 qidx 少 1，
       会出现 2/1；C1 二批默认不自动跳后这条路径天天走，必然复现。 */
    lastAuto={rank:selfRank,n:answeredCount,acc:windowAcc(),win:selfWindow.length,lab:curDiffLabel};
    total=answeredCount;
  }
  autoMode=false;saveTypeBest(key,score);finish(score);
}

/* ---------- P2-A1：本局错题回顾 ---------- */
function dropRoundWrong(q){
  if(!q)return;
  for(var i=0;i<roundWrong.length;i++){if(roundWrong[i].q===q){roundWrong.splice(i,1);return;}}
}
function retryRoundWrong(){
  if(!roundWrong.length){toast('✅ 本轮错题都练完了');return;}
  reviewMode=true;reviewOne=false;autoMode=false;quizOver=false;
  typeKey='b:round';typeLabel='重练本局错题';qaSection='choice';handMode=false;
  navPush('quiz');
  var gl=langGuard(roundWrong.map(function(w){
    return {q:w.q,a:w.a,opts:(w.opts&&w.opts.length)?w.opts.slice():null,
            code:w.code,exp:w.exp,sol:w.sol,steps:w.steps,src:w.src,tag:w.tag,weak:null};
  }));
  if(!gl.length){toast('✅ 本轮错题都练完了');return;}
  qlist=gl;
  ok=0;qidx=0;score=0;answeredCount=0;total=qlist.length;showQuestion();
}
function finish(sc){
  closeScratch();   /* 批次 B：结算前保存并收起草稿 */
  navPush('finish');
  showView('stage');clearNode(stageEl);
  var acc=total?(Math.min(100,Math.round(ok/total*100))):0;
  var card=h('div','qcard');card.style.textAlign='center';card.style.paddingTop='24px';card.style.margin='auto 0';
  var emo=ht('div',null,acc>=80?'🎉':acc>=60?'👍':'💪');emo.style.cssText='font-size:40px;line-height:1';
  card.appendChild(emo);
  card.appendChild(ht('div','hint',acc>=80?'太棒了，这轮很稳！':(acc>=60?'不错，继续保持～':'别急，错题会进薄弱题，多刷两轮就起来了')));
  /* 回顾模式不计分：大数字显示「已掌握几题」，别把 0 分摆在一个「太棒了」旁边 */
  var _isRev=(typeKey==='b:weak'||typeKey==='b:round'||typeKey==='b:srs');
  var scoreBig=ht('div',null,_isRev?String(ok):String(sc));scoreBig.style.cssText='font-size:52px;font-weight:900;color:var(--purple-d);line-height:1.15;margin:6px 0 2px';
  card.appendChild(scoreBig);
  if(_isRev){
    var _revMsg;
    if(typeKey==='b:srs'){
      var _nd=srsNextDueDays();
      _revMsg='已复习 '+ok+' 题 · 下次到期：'+(_nd==null?'暂无':(_nd<=0?'今天':_nd+' 天后'))+' · 答对会推进复习间隔，30 天档答对才算掌握';
    }else if(typeKey==='b:round'){
      _revMsg='本轮掌握 '+ok+' 题 · 答对的已从本轮错题移除';
    }else{
      _revMsg='本次回顾答对 '+ok+' 题 · 答对会推进复习间隔，30 天档答对才算掌握';
    }
    card.appendChild(ht('div','hint',_revMsg));
  }
  /* 4.0.1-2：自动模式一题没答就点结束，分母是 0 —— 别把「0 / 0」摆给用户看 */
  var accLine=ht('div','hint',total?('正确率 '+acc+'%　（'+ok+' / '+total+'）'):'本局未作答（0 题）');accLine.style.color='var(--sub)';accLine.style.fontWeight='700';
  card.appendChild(accLine);
  if(lastAuto){
    var lc=h('div','lvlcard');
    var _bkF=(typeKey&&typeKey.indexOf('b:')===0)?typeKey.slice(2):'';
    lc.appendChild(ht('div','lvlt',diffMatters(_bkF)?('🎯 当前实力：'+(lastAuto.lab||levelName(lastAuto.rank))):'🎲 本轮混合难度（该分类题库不按难度分档）'));
    lc.appendChild(ht('div','lvls','做了 '+lastAuto.n+' 题 · 正确 '+ok+' 题 · 最近 '+lastAuto.win+' 题正确率 '+Math.round(lastAuto.acc*100)+'%'));
    var _A=lastAuto.acc;
    lc.appendChild(ht('div','lvld',_A>=0.85?'状态在线，往上一档再试试。':(_A>=0.65?'基本稳住，这个档位可以继续刷。':(_A>=0.45?'还在爬坡，错题点「😵 不会」沉淀后回顾。':'这档偏难，先回低一档把基础打牢。'))));
    card.appendChild(lc);
    lastAuto=null;
  }
  /* P2-A1：本局错题（折叠，点题干展开；回顾局不显示 —— 回顾本身就是在过错题） */
  if(roundWrong.length&&typeKey!=='b:weak'&&typeKey!=='b:round'){
    var wsec=ht('div','section-title','❌ 本局错题（'+roundWrong.length+' 道）');
    wsec.style.marginTop='16px';card.appendChild(wsec);
    var wlist=h('div','round-wrong');card.appendChild(wlist);
    roundWrong.forEach(function(w){
      var rw=h('div','rw-row');
      var head=ht('div','rw-q',String(w.q||''));
      var det=h('div','rw-d');
      det.appendChild(ht('div','rw-line','你的答案：'+(w.given==null?'—':String(w.given))));
      var ansLine=ht('div','rw-line','正确答案：'+(w.a==null?'—':String(w.a)));ansLine.style.color='#177a4d';
      det.appendChild(ansLine);
      if(w.exp)det.appendChild(ht('div','rw-exp',String(w.exp)));
      if(w.src)det.appendChild(ht('div','rw-exp rw-src','📚 来源：'+String(w.src)));
      if(w.sol){var sl=h('pre','fsol-code');sl.textContent=w.sol;det.appendChild(sl);}
      if(w.steps&&w.steps.length){w.steps.forEach(function(s){det.appendChild(ht('div','fstep',s));});}
      head.onclick=function(){rw.classList.toggle('open');};
      rw.appendChild(head);rw.appendChild(det);
      wlist.appendChild(rw);
    });
    var retryBtn=h('button','btn gold','🔁 只练这 '+roundWrong.length+' 题');
    retryBtn.style.marginTop='8px';retryBtn.style.width='100%';
    retryBtn.onclick=function(){retryRoundWrong();};
    card.appendChild(retryBtn);
  }
  var row=h('div','row');row.style.marginTop='16px';
  var again=h('button','btn gold',reviewOne?'📚 返回薄弱题本':
    (typeKey==='b:round'?(roundWrong.length?('🔁 再练这 '+roundWrong.length+' 题'):'📚 返回书架'):
    (typeKey==='b:srs'?'🔁 再复习一轮':'🔄 再来一局')));
  again.onclick=function(){
    if(reviewOne){reviewOne=false;openWeakBook();return;}
    if(typeKey==='b:round'){if(roundWrong.length){retryRoundWrong();}else{renderShelf();}return;}
    if(typeKey==='b:weak'){startReview();return;}
    if(typeKey==='b:srs'){startSrs();return;}
    if(typeKey==='b:online'){startOnline();return;}
    if(lastRun){doStartType(lastRun.bk,lastRun.cn,lastRun.d);return;}
    renderShelf();
  };
  var back=h('button','btn ghost','📚 返回书架');back.onclick=function(){renderShelf();};
  row.appendChild(again);row.appendChild(back);card.appendChild(row);
  var rev=h('button','btn ghost','😵 错题回顾');rev.style.marginTop='9px';rev.style.width='100%';
  rev.onclick=function(){startReview();};card.appendChild(rev);
  stageEl.appendChild(card);
  // 自定义题库：结算时若题量已不足，静默在后台补题（不打断结算页）
  if(lastRun&&lastRun.cn&&typeKey&&typeKey.indexOf('c:')===0){
    setTimeout(function(){autoRefill(lastRun.cn);},600);
  }
}

/* ---------- 薄弱题回顾 ---------- */
function weakToQ(x){
  return {q:x.q,a:x.a,opts:(x.opts&&x.opts.length)?x.opts.slice():null,code:x.code,
          exp:x.exp,sol:x.sol,steps:x.steps,src:x.src,fillin:x.fillin,tag:x.tag,weak:x};
}
function weakCatName(t){
  var k=String(t||'');
  if(k.indexOf('c:')===0)return '📝 '+k.slice(2);
  var b=(k.indexOf('b:')===0)?k.slice(2):k;
  if(QA_TYPES[b])return QA_TYPES[b].icon+' '+QA_TYPES[b].name;
  if(k==='b:weak')return '📚 回顾';
  return '📦 其他';
}
function weakAgo(ts){
  if(!ts)return '—';
  var d=Date.now()-ts;if(d<0)d=0;
  if(d<60000)return '刚刚';
  if(d<3600000)return Math.floor(d/60000)+' 分钟前';
  if(d<86400000)return Math.floor(d/3600000)+' 小时前';
  if(d<2592000000)return Math.floor(d/86400000)+' 天前';
  return Math.floor(d/2592000000)+' 个月前';
}
function weakSort(a){
  return a.slice().sort(function(x,y){var dn=(y.n||1)-(x.n||1);if(dn)return dn;return (y.t||0)-(x.t||0);});
}
var weakFilter='';
/* P1-2：薄弱题本 —— 先看列表（错误次数 / 分类 / 最后时间），再决定练哪一题 */
function openWeakBook(cat){
  var all=weakSort(loadWeak());
  if(!all.length){toast('📚 暂无薄弱题：做题时点「😵 不会」或答错就会沉淀到这里');return;}
  if(cat!=null)weakFilter=cat;
  var ov=overlayPanel('📚 薄弱题本');
  var top=h('div','row');top.style.gap='8px';top.style.marginBottom='8px';
  var allB=h('button','btn gold','▶ 全部回顾（'+all.length+'）');allB.style.flex='1';
  allB.onclick=function(){closeOverlay(ov);startReview();};
  var sel=document.createElement('select');sel.style.flex='1';
  var cats={},order=[];
  all.forEach(function(x){var c=String(x.type||'other');if(!cats[c]){cats[c]=0;order.push(c);}cats[c]++;});
  (function(){
    var o0=document.createElement('option');o0.value='';o0.textContent='全部分类（'+all.length+'）';sel.appendChild(o0);
    order.forEach(function(c){
      var o=document.createElement('option');o.value=c;o.textContent=weakCatName(c)+'（'+cats[c]+'）';
      if(c===weakFilter)o.selected=true;sel.appendChild(o);
    });
  })();
  sel.onchange=function(){weakFilter=sel.value;renderRows();};
  top.appendChild(sel);top.appendChild(allB);ov.p.appendChild(top);
  var listBox=h('div');ov.p.appendChild(listBox);
  /* 4.0.1-5：文案对齐 SRS 掌握口径 —— 旧文案「答对即移除」与 C2 的统一冲突 */
  var hint=ht('div','hint','掌握标准：答对会推进复习间隔（1/2/4/7/15/30 天），30 天档答对才算掌握；也可手动移除。');
  hint.style.marginTop='10px';ov.p.appendChild(hint);

  function renderRows(){
    clearNode(listBox);
    var rows=weakFilter?all.filter(function(x){return String(x.type||'other')===weakFilter;}):all;
    if(!rows.length){listBox.appendChild(ht('div','hint','该分类下暂无错题'));return;}
    rows.forEach(function(x){
      var row=h('div','list-row');row.style.flexWrap='wrap';row.style.cursor='pointer';
      row.style.padding='6px 0';row.style.borderBottom='1px solid #f2eefc';
      var badge=ht('span',null,'×'+(x.n||1));
      badge.style.cssText='min-width:32px;text-align:center;font-weight:800;color:#d94b57;background:#fdecee;border-radius:9px;padding:2px 6px;font-size:12px';
      row.appendChild(badge);
      var qs=String(x.q||'');
      var t=ht('span',null,(qs.length>40?qs.slice(0,40)+'…':qs));
      t.style.flex='1';t.style.minWidth='140px';
      row.appendChild(t);
      var catEl=ht('span','hint2',weakCatName(x.type));catEl.style.cssText='font-size:11px;opacity:.9';
      row.appendChild(catEl);
      var ago=ht('span','hint2',weakAgo(x.t));ago.style.cssText='font-size:11px;opacity:.7';
      row.appendChild(ago);
      if(x.srs){
        var _rs=ht('span','hint2',srsDue(x)?'⏰ 今天可复习':'⏭ 下次 '+SRS_INTERVALS[x.srs.lv]+' 天');
        _rs.style.cssText='font-size:11px;opacity:.7;color:'+(srsDue(x)?'#d97706':'#888');
        row.appendChild(_rs);
      }
      var det=h('div');
      det.style.cssText='display:none;width:100%;margin:6px 0 2px;padding:9px 10px;background:#faf8ff;border-radius:12px;font-size:13px;line-height:1.6';
      det.appendChild(ht('div','fbm',qs));
      if(x.pick)det.appendChild(ht('div','hint','你选的是：'+x.pick));
      det.appendChild(ht('div','hint','正确答案：'+(x.a==null?'—':String(x.a))));
      if(x.exp)det.appendChild(ht('div','hint','解析：'+x.exp));
      if(x.sol){var sl=h('pre','codeblk');sl.textContent=x.sol;det.appendChild(sl);}
      if(x.steps)det.appendChild(ht('div','hint','思路：'+x.steps));
      if(x.src)det.appendChild(ht('div','hint2','来源：'+x.src));
      row.appendChild(det);
      var btns=h('div');
      btns.style.cssText='display:none;width:100%;gap:8px;margin-top:6px';
      var pb=h('button','btn gold','▶ 练这题');pb.style.flex='1';
      pb.onclick=function(e){if(e&&e.stopPropagation)e.stopPropagation();closeOverlay(ov);startReviewOne(x);};
      var db=h('button','btn ghost','🗑 移除');db.style.flex='1';
      db.onclick=function(e){
        if(e&&e.stopPropagation)e.stopPropagation();
        if(!confirm('从薄弱题本移除这道题？'))return;
        removeWeak({type:x.type,q:x.q});
        var i=all.indexOf(x);if(i>=0)all.splice(i,1);
        if(!all.length){closeOverlay(ov);renderShelf();toast('📚 薄弱题本已空');return;}
        renderRows();renderShelf();
      };
      btns.appendChild(pb);btns.appendChild(db);row.appendChild(btns);
      row.onclick=function(){
        var open=det.style.display!=='none';
        det.style.display=open?'none':'block';
        btns.style.display=open?'none':'flex';
      };
      listBox.appendChild(row);
    });
  }
  renderRows();
}
/* B 批：知识卡先学后练（每个分类核心知识点，开局前展示） */
var KNOW_CARDS={
  math:[
    {t:'整数与四则',p:'加减乘除优先级、括号、负数运算是数学基础，心算题考察速度与准确率。'},
    {t:'小数与分数',p:'0.1+0.2≠0.3（浮点误差）、分数约分通分、百分数转换。'},
    {t:'几何基础',p:'三角形内角和 180°、勾股定理 a²+b²=c²、圆面积 πr²。'},
    {t:'方程与代数',p:'一元一次方程移项、合并同类项；二元一次方程组代入/消元。'},
    {t:'统计与概率',p:'平均数/中位数/众数、简单概率 = 目标数÷总数。'}
  ],
  code:[
    {t:'数制与码制',p:'二进制/十进制转换、补码表示负数、ASCII 码。'},
    {t:'变量与类型',p:'int/float/char 的取值与精度、强制类型转换。'},
    {t:'运算符与表达式',p:'算术/关系/逻辑运算符优先级、自增自减、短路求值。'},
    {t:'选择结构',p:'if/else、switch、三目运算符；条件嵌套注意 else 配对。'},
    {t:'循环结构',p:'for/while 的边界、break/continue、循环嵌套与复杂度。'},
    {t:'函数与数组',p:'函数定义调用、参数传递、数组下标从 0 开始、指针初步。'}
  ],
  english:[
    {t:'常用名词',p:'食物、动物、家庭、学校生活高频词的拼写与单复数。'},
    {t:'颜色数词',p:'颜色词、1-10 基数词、日期星期的英文表达。'},
    {t:'形容词',p:'大小/新旧/长短/快慢等反义词对。'},
    {t:'动词',p:'跑走跳游吃喝睡等常用动作动词。'},
    {t:'时间表达',p:'morning/afternoon/evening/night、today/tomorrow/yesterday。'}
  ],
  science:[
    {t:'物理基础',p:'力/质量/压强/功/功率单位与关系，光声热电常识。'},
    {t:'化学基础',p:'常见化学式（CO₂/H₂SO₄/NaCl）、俗称、酸碱指示剂。'},
    {t:'生物基础',p:'细胞结构、人体系统与器官、遗传物质 DNA。'},
    {t:'自然地理',p:'地震火山成因、台风季风、淡水分布、雾霾成因。'},
    {t:'科学之最',p:'司南/法拉第/爱因斯坦/门捷列夫/达尔文等标志性贡献。'}
  ],
  geo:[
    {t:'世界地理',p:'七大洲四大洋、著名地形地貌、主要国家首都。'},
    {t:'中国地理',p:'省级行政区、主要山脉河流、南北地理分界。'},
    {t:'自然现象',p:'河流峡谷成因、沙漠绿洲、地质灾害分布。'},
    {t:'城市国家',p:'各国首都、最大城市、城市国家特例。'}
  ],
  history:[
    {t:'中国古代史',p:'朝代更迭顺序、重要制度与事件（秦统一/丝绸之路/科举）。'},
    {t:'中国近现代史',p:'鸦片战争、辛亥革命、五四运动、改革开放等节点。'},
    {t:'世界史',p:'文艺复兴、工业革命、两次世界大战关键事件。'},
    {t:'思想文化',p:'百家争鸣、马克思主义诞生、《独立宣言》等。'}
  ]
};
/* 先学后练：开局前弹知识卡覆盖层（bt_qa_learn_before 开关控制） */
function maybeShowCard(bk,start){
  var cards=KNOW_CARDS[bk];
  if(!cards||!cards.length)return start();
  var ov=overlayPanel('📖 '+QA_TYPES[bk].name+' · 先学后练');
  cards.forEach(function(c){
    var blk=h('div');blk.style.cssText='margin:0 0 12px;padding:10px 12px;background:#faf8ff;border-radius:12px';
    blk.appendChild(ht('div','fbm',c.t));
    blk.appendChild(ht('div','hint',c.p));
    ov.p.appendChild(blk);
  });
  var go=h('button','btn gold','我学会了，开始练习');go.style.width='100%';go.style.marginTop='8px';
  go.onclick=function(){closeOverlay(ov);start();};
  ov.p.appendChild(go);
  var skip=h('button','btn ghost','跳过知识卡，直接开始');skip.style.width='100%';skip.style.marginTop='6px';
  skip.onclick=function(){closeOverlay(ov);start();};
  ov.p.appendChild(skip);
}
/* SRS 复习局入口（书架空格「⏰ 待复习」） */
/* C2：结算页「下次到期」—— 薄弱题本里最近一条 srs due 折成天 */
function srsNextDueDays(){
  var a=loadWeak(),best=null;
  for(var i=0;i<a.length;i++){var s=a[i]&&a[i].srs;if(!s||typeof s.due!=='number')continue;var d=s.due-Date.now();if(best==null||d<best)best=d;}
  if(best==null)return null;
  return Math.max(0,Math.ceil(best/86400000));
}
function startSrs(){
  var a=loadWeak().filter(srsDue);
  if(!a.length){toast('⏰ 今天没有到期复习题：错题会按 1/2/4/7/15/30 天间隔安排复习');return;}
  reviewMode=true;reviewOne=false;autoMode=false;quizOver=false;typeKey='b:srs';typeLabel='SRS 复习';qaSection='choice';handMode=false;
  navPush('quiz');
  qlist=weakSort(a).map(weakToQ);   /* 次数多 + 新的在前，到期题内也有轻重 */
  ok=0;qidx=0;score=0;answeredCount=0;total=qlist.length;roundWrong=[];promoReset();showQuestion();
}
function startReview(){
  var a=loadWeak();
  if(!a.length){toast('📚 暂无薄弱题：做题时点「😵 不会」就会沉淀到这里');return;}
  reviewMode=true;reviewOne=false;autoMode=false;quizOver=false;typeKey='b:weak';typeLabel='回顾薄弱题';qaSection='choice';handMode=false;
  navPush('quiz');
  qlist=weakSort(a).map(weakToQ);
  ok=0;qidx=0;score=0;answeredCount=0;total=qlist.length;roundWrong=[];promoReset();showQuestion();
}
/* 单题练：只做这一道，答对移除、答错计数 +1，结算页回题本 */
function startReviewOne(x){
  if(!x)return;
  qlist=langGuard([weakToQ(x)]);
  if(!qlist.length){toast('这题不属于当前语言，已跳过');return;}
  reviewMode=true;reviewOne=true;autoMode=false;quizOver=false;typeKey='b:weak';typeLabel='回顾薄弱题';qaSection='choice';handMode=false;
  navPush('quiz');
  ok=0;qidx=0;score=0;answeredCount=0;total=1;roundWrong=[];promoReset();showQuestion();
}

/* ---------- 联网 ---------- */
function startOnline(){
  typeKey='b:online';typeLabel='🌐 联网';
  if(ONLINE_BANK.length){beginOnline();return;}
  showView('stage');clearNode(stageEl);
  var c=h('div','qcard');c.style.textAlign='center';
  c.appendChild(ht('div','hud','🌐 正在联网获取最新题目…'));
  var sp=ht('div','hint','（首次获取需联网，之后会缓存到本地；失败会自动回退备用源与本地离线题库）');c.appendChild(sp);
  stageEl.appendChild(c);
  fetchOnline(function(okf,info){
    if(okf&&ONLINE_BANK.length){beginOnline();return;}
    var reason=(info&&info.reason)||'fail';
    if(info&&info.degraded&&ONLINE_BANK.length){beginOnline();return;}
    /* P1-6：失败不再「1200ms 后静默跳进常识分类」——用户会以为点的是联网题。
       改成明确告知 + 两个选项，由用户决定做本地题还是回书架。 */
    clearNode(stageEl);
    var cc=h('div','qcard');cc.style.textAlign='center';
    cc.appendChild(ht('div','hud','📴 联网题库暂时不可用'));
    cc.appendChild(ht('div','hint',netFailText(reason)));
    cc.appendChild(ht('div','hint2','联网题库用的是海外公开题库（英文题 · Open Trivia DB）。网络受限时可先做本地题库，成绩与错题本不受影响。'));
    var r1=h('div','row');r1.style.marginTop='14px';
    var b1=h('button','btn gold','📚 先做本地常识题');b1.style.flex='1';
    b1.onclick=function(){doStartType('common',null,qaDiffDefault('common'));};
    var b2=h('button','btn ghost','← 返回书架');b2.style.flex='1';
    b2.onclick=function(){renderShelf();};
    r1.appendChild(b1);r1.appendChild(b2);cc.appendChild(r1);
    stageEl.appendChild(cc);
  });
}
function beginOnline(){
  typeKey='b:online';typeLabel=(ONLINE_SRC==='offline')?'📴 联网（离线兜底）':'🌐 联网';curDiff=-1;curDiffLabel='';qaSection='choice';handMode=false;quizOver=false;reviewMode=false;
  navPush('quiz');
  qlist=shuffle(ONLINE_BANK.slice()).slice(0,Math.min(10,ONLINE_BANK.length)).map(function(it){return {q:it.q,a:it.a,opts:it.opts,src:it.src};});
  ok=0;qidx=0;score=0;answeredCount=0;total=qlist.length;roundWrong=[];promoReset();showQuestion();
}

/* ---------- 自定义题库编辑器 ---------- */
function openEditor(preset){
  showView('stage');clearNode(stageEl);
  var card=h('div','qcard');
  card.appendChild(ht('div','hud','➕ 新增自定义题库'));
  var em=h('div','hint','');card.appendChild(em);
  var nm=h('input');nm.type='text';nm.value=preset||'';nm.placeholder='题库名称（如：化学）';nm.style.margin='8px 0';card.appendChild(nm);
  var list=h('div');card.appendChild(list);var pairs=[];
  function renderList(){clearNode(list);if(!pairs.length){list.appendChild(ht('div','hint','还没有题目，下面添加'));return;}
    pairs.forEach(function(p,i){var r=h('div','list-row');r.appendChild(ht('span',null,p.q+' → '+p.a));
      var del=h('button','chip','✕');del.onclick=function(){pairs.splice(i,1);renderList();};r.appendChild(del);list.appendChild(r);});}
  renderList();
  var qinp=h('input');qinp.placeholder='问题';
  var ainp=h('input');ainp.placeholder='答案';
  var addQ=h('button','btn','＋ 添加题目');var ar=h('div','row');ar.appendChild(qinp);ar.appendChild(ainp);ar.appendChild(addQ);card.appendChild(ar);
  addQ.onclick=function(){var q=qinp.value.trim(),a=ainp.value.trim();if(!q||!a){em.textContent='⚠️ 问题和答案都要填';return;}em.textContent='';pairs.push({q:q,a:a});qinp.value='';ainp.value='';renderList();};
  var saveB=h('button','btn gold','💾 保存并开始');saveB.onclick=function(){var name=nm.value.trim();if(!name){em.textContent='⚠️ 请输入题库名称';return;}if(!pairs.length){em.textContent='⚠️ 至少录入一题';return;}if(custom[name]&&!confirm('已存在同名题库「'+name+'」，覆盖它？')){em.textContent='⚠️ 已有同名题库「'+name+'」，未覆盖';return;}custom[name]=pairs;saveCustom(custom);renderShelf();startType(null,name);};
  card.appendChild(saveB);
  var backB=h('button','btn ghost','← 返回');backB.onclick=function(){renderShelf();};card.appendChild(backB);
  stageEl.appendChild(card);
}

/* ---------- 任务2：编程实力检测 ---------- */
var CODE_PROFILE_KEY='bt_qa_profile_code';
var CODE_LANGS=[{k:'c',n:'C / C++'},{k:'python',n:'Python'},{k:'java',n:'Java'},{k:'js',n:'JavaScript'},{k:'sql',n:'SQL'},{k:'web',n:'HTML·CSS'},{k:'all',n:'计算机通用'}];
function langName(k){for(var i=0;i<CODE_LANGS.length;i++)if(CODE_LANGS[i].k===k)return CODE_LANGS[i].n;return k;}
function levelName(r){return ['🐣 入门','🚀 基础','🔧 进阶','🧠 熟练','👑 精通'][r||0]||'🐣 入门';}
function getCodeProfile(){try{return JSON.parse(S.getItem(CODE_PROFILE_KEY)||'null');}catch(e){return null;}}
function codeProfileDone(){var p=getCodeProfile();return !!(p&&p.done);}
function bkIsCode(key){return key==='b:code';}
// 编程题的语言标签内联在题目第 3 位（c/python/java/js/sql/web/all），题库调整不再需要同步标签表
var CODE_TAGS=null;
function buildCodeTags(){
  if(CODE_TAGS)return CODE_TAGS;
  CODE_TAGS={};
  for(var d in POOLS.code){if(POOLS.code.hasOwnProperty(d))CODE_TAGS[d]=(POOLS.code[d]||[]).map(function(it){return (it&&it[2])||'all';});}
  return CODE_TAGS;
}
buildCodeTags();
/*=== CODE_ENGINE_START ===*/
/* ================= 全语言程序化题库（五档：模板 + 随机参数 / 知识点池） =================
   语言键：c / python / java / js / sql / web / all（all = 语言无关）
   知识点池格式：[问题, 正确答案, '选项1|选项2|选项3|选项4']（四个选项同类相近，含正确答案）
   参数化生成器：返回 {q,a,opts}，答案当场计算，题量 = 模板参数空间（P1-4 逐条标 kb） */
function riN(a,b){return a+Math.floor(Math.random()*(b-a+1));}
function binOf(n,w){var s=n.toString(2);while(w&&s.length<w)s='0'+s;return s;}
function binWrongs(s,n){
  var out=[];
  for(var i=0;i<s.length;i++)out.push(s.slice(0,i)+(s[i]==='1'?'0':'1')+s.slice(i+1));
  return shuffle(out).slice(0,n||3);
}
function hexOf(n){return n.toString(16).toUpperCase();}
/* 位运算的同类候选：保证能凑出 3 个不重复且非负的干扰项 */
function bitCands(a,b,ans){
  var all=[a&b,a|b,a+b,a*b,Math.abs(a-b),a+1,b+1],out=[],seen={};
  seen[ans]=1;
  all.forEach(function(v){if(out.length>=4)return;if(!isFinite(v)||seen[v])return;seen[v]=1;out.push(v);});
  return out;
}
function shiftCands(a,k,ans){
  var all=[a*k,a<<(k+1),a>>k,a+k,a*(k+1),ans+1,ans-1],out=[],seen={};
  seen[ans]=1;
  all.forEach(function(v){if(out.length>=4)return;if(!isFinite(v)||seen[v])return;seen[v]=1;out.push(v);});
  return out;
}
function fact(n){var r=1;for(var i=2;i<=n;i++)r*=i;return r;}
function fibOf(n){var a=1,b=1;for(var i=3;i<=n;i++){var c=a+b;a=b;b=c;}return b;}

var CODE_KB={
all:{
 0:[
  ['1 KB 等于多少字节？','1024','1024|1000|512|2048'],
  ['1 字节（Byte）等于多少位（bit）？','8','8|4|16|32']
 ],
 1:[
  ['逻辑运算 true && false 的结果是？','false','false|true|null|空字符串'],
  ['程序中的变量本质上是什么？','一块有名字的内存空间','一块有名字的内存空间|一个数字|一个函数|一个文件']
 ],
 2:[
  ['位运算符 & 表示什么运算？','按位与','按位与|按位或|按位异或|按位取反'],
  ['一个字节最多能表示多少个不同的值？','256','256|128|255|512']
 ],
 3:[
  ['冒泡排序的平均时间复杂度是？','O(n²)','O(n²)|O(n log n)|O(log n)|O(1)'],
  ['快速排序的平均时间复杂度是？','O(n log n)','O(n log n)|O(n²)|O(log n)|O(n)'],
  ['二分查找的时间复杂度是？','O(log n)','O(log n)|O(n)|O(n log n)|O(1)'],
  ['哈希表理想情况下的查找复杂度是？','O(1)','O(1)|O(log n)|O(n)|O(n²)'],
  ['深度优先搜索（DFS）常用的辅助结构是？','栈','栈|队列|堆|链表'],
  ['广度优先搜索（BFS）常用的辅助结构是？','队列','队列|栈|树|哈希表'],
  ['数组按下标随机访问的复杂度是？','O(1)','O(1)|O(n)|O(log n)|O(n²)'],
  ['归并排序相对冒泡排序的优势是？','平均复杂度更低','平均复杂度更低|不需要额外空间|实现更简单|比较次数恒定'],
  ['递归缺少终止条件通常会导致？','栈溢出','栈溢出|内存泄漏|死循环但不会崩溃|编译失败'],
  ['链表相比数组的优势是？','插入删除不需要移动元素','插入删除不需要移动元素|随机访问更快|占用内存更少|支持下标直接访问']
 ],
 4:[
  ['8 位有符号整数能表示的范围是？','-128 ~ 127','-128 ~ 127|-127 ~ 127|-128 ~ 128|0 ~ 255'],
  ['8 位补码相加产生溢出时，最高位的进位会怎样？','被丢弃','被丢弃|自动扩展到 16 位|触发异常|存入标志位并保留'],
  ['多数语言中 0.1 + 0.2 不等于 0.3，原因是？','二进制无法精确表示 0.1','二进制无法精确表示 0.1|运算顺序错误|编译器缺陷|0.2 被舍入为 0.25'],
  ['面试常问的「时间复杂度」衡量的是什么？','随输入规模增长的趋势','随输入规模增长的趋势|程序运行的确切秒数|代码行数|内存占用字节数']
 ]
},
c:{
 0:[
  ['C 语言中用于声明整型变量的关键字是？','int','int|char|float|double'],
  ['C 语言中用于声明单精度浮点数的关键字是？','float','float|int|double|char'],
  ['C 语言中字符类型 char 通常占几个字节？','1','1|2|4|8'],
  ['C 语言程序的入口函数是？','main','main|start|init|begin'],
  ['C 语言中单行注释用什么符号开头？','//','//|#|/*|--'],
  ['C 语言中 for 循环括号里的三个部分依次是？','初始化;条件;更新','初始化;条件;更新|条件;初始化;更新|更新;条件;初始化|初始化;更新;条件'],
  ['C 语言中 printf 函数的作用是？','格式化输出','格式化输出|读取输入|分配内存|打开文件'],
  ['C 语言中每条语句通常以什么符号结束？','分号 ;','分号 ;|冒号 :|逗号 ,|句号 .']
 ],
 1:[
  ['C 语言中，int a[5] 的合法下标范围是？','0~4','0~4|1~5|0~5|1~4'],
  ['C 语言中 while 条件一开始就为假时，循环体执行几次？','0 次','0 次|1 次|无限次|编译错误'],
  ['C 语言中 break 在循环里的作用是？','立即结束整个循环','立即结束整个循环|跳过本次进入下一次|重新开始循环|结束整个程序'],
  ['C 语言中 continue 的作用是？','跳过本次剩余语句，进入下一次循环','跳过本次剩余语句，进入下一次循环|结束整个循环|结束程序|跳出当前函数'],
  ['C 语言中三目运算符的写法是？','条件 ? 值1 : 值2','条件 ? 值1 : 值2|条件 : 值1 ? 值2|条件 ? 值1 ; 值2|条件 ? 值1 , 值2'],
  ['C 语言中 if 的条件表达式值为 0 时表示？','假','假|真|语法错误|未定义'],
  ['C 语言中 do-while 与 while 的关键区别是？','do-while 至少执行一次','do-while 至少执行一次|while 至少执行一次|两者完全相同|do-while 不能带条件']
 ],
 2:[
  ['C 语言中，取变量 a 的内存地址用哪个运算符？','&a','&a|*a|a.|a->'],
  ['C 语言中，若 p 是整型指针，*p 表示什么？','p 所指向变量的值','p 所指向变量的值|p 自身的内存地址|p 占用的字节数|p 的类型名'],
  ['C 语言中，数组名在表达式中通常等价于什么？','数组首元素的地址','数组首元素的地址|数组的长度|数组最后一个元素|数组的一份副本'],
  ['C 语言中，宏 NULL 通常表示什么？','空指针','空指针|字符串 "0"|未初始化的数组|字符串结束符'],
  ['C 语言中，malloc 申请的内存应当用哪个函数释放？','free','free|delete|clear|release'],
  ['C 语言中，访问结构体变量 s 的成员 x 用哪个写法？','s.x','s.x|s->x|s::x|s[x]'],
  ['C 语言中，访问结构体指针 p 的成员 x 用哪个写法？','p->x','p->x|p.x|*p.x|p::x'],
  ['C 语言中，sizeof 运算符返回的是什么？','占用的字节数','占用的字节数|元素个数|二进制位数|内存地址'],
  ['C 语言中，释放后仍继续使用的指针称为？','悬空指针','悬空指针|野指针|空指针|函数指针'],
  ['C 语言中，对同一块内存连续 free 两次通常会导致？','堆破坏（未定义行为）','堆破坏（未定义行为）|内存自动扩容|编译报错|返回错误码'],
  ['C 语言中，指针变量本身占用的内存大小取决于什么？','平台的字长','平台的字长|它指向的类型|数组长度|编译优化等级'],
  ['C 语言中，二维数组 a[3][4] 中 a[1] 表示什么？','第二行首元素的地址','第二行首元素的地址|第二行第一个元素的值|第一行第二个元素的值|数组总长度']
 ],
 3:[
  ['冒泡排序的平均时间复杂度是？','O(n²)','O(n²)|O(n log n)|O(log n)|O(1)'],
  ['快速排序的平均时间复杂度是？','O(n log n)','O(n log n)|O(n²)|O(log n)|O(n)'],
  ['二分查找的时间复杂度是？','O(log n)','O(log n)|O(n)|O(n log n)|O(1)'],
  ['单链表结点的典型组成是？','数据域 + 指向下一结点的指针','数据域 + 指向下一结点的指针|只有数据域|两个数据域|数据域 + 数组长度'],
  ['栈的访问特点是？','后进先出','后进先出|先进先出|随机访问|按优先级出'],
  ['队列的访问特点是？','先进先出','先进先出|后进先出|随机访问|按大小排序出'],
  ['二叉树前序遍历的顺序是？','根 → 左 → 右','根 → 左 → 右|左 → 根 → 右|左 → 右 → 根|右 → 左 → 根'],
  ['在有序数组中查找目标值，效率更高的是？','二分查找','二分查找|顺序查找|冒泡查找|哈希查找']
 ],
 4:[
  ['C 语言中 int (*fp)(int); 声明的是什么？','指向函数的指针','指向函数的指针|返回指针的函数|整型数组|指向 int 的指针'],
  ['C 语言中 #define 的作用是什么？','预处理阶段的宏替换','预处理阶段的宏替换|定义普通变量|定义函数|引入头文件'],
  ['C 语言中 typedef 的作用是什么？','为已有类型起别名','为已有类型起别名|定义新变量|申请堆内存|声明函数'],
  ['C 语言中 union 的大小通常等于什么？','最大成员的大小','最大成员的大小|所有成员大小之和|最小成员的大小|固定 4 字节'],
  ['结构体按成员最大对齐数对齐，主要目的是什么？','提高内存访问效率','提高内存访问效率|节省内存|兼容旧编译器|方便调试'],
  ['C 语言中 int *p 指向数组元素，执行 p+1 实际前进多少字节？','sizeof(int) 个字节','sizeof(int) 个字节|1 个字节|4 个位|sizeof(int*) 个字节'],
  ['在常见补码平台上，C 语言里 8 位有符号 char 存储 200 会得到什么？','-56','-56|200|56|0'],
  ['C 语言中，无符号数与有符号数比较时，有符号数会怎样？','被转换为无符号数','被转换为无符号数|保持有符号|编译报错|被截断为 0'],
  ['C 语言中，宏 #define SQ(x) x*x 在 SQ(1+2) 展开后是什么？','1+2*1+2','1+2*1+2|(1+2)*(1+2)|9|3*3'],
  ['C 语言中，volatile 关键字的主要作用是？','禁止编译器优化该变量的读写','禁止编译器优化该变量的读写|把变量放入寄存器|声明变量为只读|申请动态内存']
 ]
},
python:{
 0:[
  ['Python 中向控制台输出内容用哪个函数？','print','print|echo|printf|write'],
  ['Python 中单行注释以什么符号开头？','#','#|//|--|/*'],
  ['Python 中定义函数用哪个关键字？','def','def|function|func|lambda'],
  ['Python 中定义列表使用哪对符号？','方括号 []','方括号 []|花括号 {}|圆括号 ()|尖括号 <>'],
  ['Python 中表示布尔真值的字面量是？','True','True|true|TRUE|Yes'],
  ['Python 中缩进的作用是？','表示代码块层级','表示代码块层级|仅为了好看|分隔语句|声明变量'],
  ['Python 3 中 print 属于什么？','内置函数','内置函数|关键字|标准库模块|类']
 ],
 1:[
  ['Python 中 len("hello") 的结果是？','5','5|4|6|报错'],
  ['Python 中 range(5) 生成的整数是？','0,1,2,3,4','0,1,2,3,4|1,2,3,4,5|0,1,2,3,4,5|1,2,3,4'],
  ['Python 中 "abc".upper() 的结果是？','ABC','ABC|abc|Abc|报错'],
  ['Python 中 s="hello"，s[1:3] 的结果是？','el','el|ell|he|lo'],
  ['Python 中 if 之后继续判断分支用哪个关键字？','elif','elif|else if|elseif|otherwise'],
  ['Python 中 for x in [1,2,3] 会循环几次？','3 次','3 次|2 次|4 次|1 次'],
  ['Python 中 int("12") 得到什么？','整数 12','整数 12|字符串 12|浮点数 12|布尔值']
 ],
 2:[
  ['Python 中字典 dict 存储的是什么？','键值对','键值对|有序整数|仅字符串|集合元素'],
  ['Python 中 [x*x for x in range(3)] 的结果是？','[0, 1, 4]','[0, 1, 4]|[0, 1, 2]|[1, 4, 9]|[0, 4, 9]'],
  ['Python 中捕获异常用哪个关键字？','except','except|catch|rescue|handler'],
  ['Python 中判断元素是否在列表里用哪个运算符？','in','in|has|contains|within'],
  ['Python 中 tuple 与 list 的主要区别是？','tuple 创建后不可修改','tuple 创建后不可修改|tuple 不能遍历|tuple 只能存数字|两者没有区别'],
  ['Python 中 set 的主要特点是？','元素不重复','元素不重复|元素有序|只能存字符串|不可遍历'],
  ['Python 中 d={"a":1}，d["a"] 的值是？','1','1|"a"|None|报错']
 ],
 3:[
  ['Python 中 sorted([3,1,2]) 的结果是？','[1, 2, 3]','[1, 2, 3]|[3, 2, 1]|None|报错'],
  ['Python 中 list.sort() 的返回值是？','None','None|排序后的列表|原列表的副本|布尔值'],
  ['Python 中 lambda x: x+1 表示什么？','匿名函数','匿名函数|循环|条件表达式|类'],
  ['Python 中递归函数必须有什么？','终止条件','终止条件|全局变量|返回值|装饰器'],
  ['Python 中 sum([1,2,3]) 的结果是？','6','6|5|123|报错'],
  ['Python 中 2**3 的结果是？','8','8|6|9|5'],
  ['Python 中 max([4,9,2]) 的结果是？','9','9|4|2|15']
 ],
 4:[
  ['Python 中 @decorator 这种写法的作用是？','装饰器，包装原函数','装饰器，包装原函数|声明变量|导入模块|定义子类'],
  ['Python 中含 yield 的函数返回的是？','生成器','生成器|列表|元组|None'],
  ['Python 中属于不可变类型的是？','tuple','tuple|list|dict|set'],
  ['Python 中在函数内修改全局变量需要先声明什么？','global','global|public|extern|var'],
  ['Python 中做深拷贝应使用哪个函数？','copy.deepcopy','copy.deepcopy|copy.copy|list()|dict()'],
  ['Python 中把 list 用作函数默认参数可能导致什么？','默认值在多次调用间共享','默认值在多次调用间共享|每次调用都重建|无法传参|运行时报错'],
  ['Python 中 GIL 限制了同一时刻只有几个线程执行字节码？','1 个','1 个|2 个|4 个|不受限制'],
  ['Python 中小整数与字符串的缓存机制主要影响什么？','is 比较的结果','is 比较的结果|== 比较的结果|内存回收速度|import 速度']
 ]
},
java:{
 0:[
  ['Java 程序入口方法的签名是？','public static void main(String[] args)','public static void main(String[] args)|public void main(String[] args)|static void Main()|public static main(String[] args)'],
  ['Java 中向控制台输出一行用哪个写法？','System.out.println','System.out.println|console.log|printf|echo'],
  ['Java 中定义类用哪个关键字？','class','class|struct|object|def'],
  ['Java 中基本的整型类型是？','int','int|integer|Int|long int'],
  ['Java 中字符串类型是？','String','String|string|str|char[]']
 ],
 1:[
  ['Java 中声明整型数组的正确写法是？','int[] a = new int[5];','int[] a = new int[5];|int a[5];|int a = new int[5];|array int a[5];'],
  ['Java 中 switch 不支持下列哪种类型？','double','double|int|char|String'],
  ['Java 中从方法返回结果用哪个关键字？','return','return|yield|give|out'],
  ['Java 中 else 后面继续判断分支写作？','else if','else if|elif|elseif|else when'],
  ['Java 中 for(int i=0;i<5;i++) 循环体执行几次？','5 次','5 次|4 次|6 次|0 次']
 ],
 2:[
  ['Java 中比较两个字符串内容是否相等应使用？','equals()','equals()|==|hashCode()|toString()'],
  ['Java 中 String 的 length() 返回什么？','字符个数','字符个数|字节数|内存占用|数组长度'],
  ['Java 中创建对象使用哪个关键字？','new','new|create|make|alloc'],
  ['Java 中 ArrayList 的特点是什么？','可变长度的列表','可变长度的列表|定长数组|键值对集合|线程安全队列'],
  ['Java 中 s.substring(1,3) 取的是？','下标 1 到 2 的字符','下标 1 到 2 的字符|下标 1 到 3 的字符|前 3 个字符|最后 3 个字符']
 ],
 3:[
  ['Java 中继承父类用哪个关键字？','extends','extends|implements|inherits|super'],
  ['Java 中实现接口用哪个关键字？','implements','implements|extends|interface|abstract'],
  ['Java 中捕获异常用哪组关键字？','try-catch','try-catch|try-except|do-catch|catch-finally'],
  ['Java 中重写父类方法通常加什么注解？','@Override','@Override|@Overload|@Rewrite|@Super'],
  ['Java 中父类引用指向子类对象体现了什么特性？','多态','多态|封装|继承|重载'],
  ['Java 中 final 修饰的类有什么特点？','不能被继承','不能被继承|不能被实例化|不能被引用|不能被编译']
 ],
 4:[
  ['Java 中泛型 List<String> 的作用是？','限定元素类型','限定元素类型|限定列表长度|提高运行速度|自动排序'],
  ['Java 中启动线程通常调用哪个方法？','start()','start()|run()|exec()|begin()'],
  ['Java 中垃圾回收主要回收什么？','不再被引用的对象占用的内存','不再被引用的对象占用的内存|磁盘文件|线程栈|类定义'],
  ['Java 中 static 成员属于？','类本身','类本身|每个对象|父类|接口'],
  ['Java 中接口里的方法默认修饰符是？','public abstract','public abstract|private|protected|static final']
 ]
},
js:{
 0:[
  ['JavaScript 中声明块级作用域变量用哪个关键字？','let','let|var|const|def'],
  ['JavaScript 中向控制台输出用哪个写法？','console.log','console.log|print|printf|System.out.println'],
  ['JavaScript 中 typeof 返回的是什么？','数据类型的字符串','数据类型的字符串|变量的值|内存地址|布尔值'],
  ['JavaScript 中严格相等运算符是？','===','===|==|=|!=='],
  ['JavaScript 中声明常量的关键字是？','const','const|let|var|final']
 ],
 1:[
  ['JavaScript 中向数组末尾添加元素用哪个方法？','push()','push()|pop()|shift()|unshift()'],
  ['JavaScript 中获取数组长度的属性是？','length','length|size|count|len'],
  ['JavaScript 中移除数组最后一个元素用哪个方法？','pop()','pop()|push()|shift()|slice()'],
  ['JavaScript 中模板字符串用哪对符号包裹？','反引号','反引号|单引号|双引号|圆括号'],
  ['JavaScript 中声明函数的传统关键字是？','function','function|func|def|fn']
 ],
 2:[
  ['JavaScript 中箭头函数的写法是？','() => {}','() => {}|function(){}|def(){}|fn(){}'],
  ['JavaScript 中数组的 map 方法返回什么？','一个新数组','一个新数组|原数组|单个元素|布尔值'],
  ['JavaScript 中 JSON.stringify 的作用是？','对象转 JSON 字符串','对象转 JSON 字符串|字符串转对象|深拷贝对象|格式化日期'],
  ['JavaScript 中 JSON.parse 的作用是？','JSON 字符串转对象','JSON 字符串转对象|对象转字符串|校验 JSON|压缩 JSON'],
  ['JavaScript 中 filter 方法返回什么？','满足条件的元素组成的新数组','满足条件的元素组成的新数组|第一个匹配元素|布尔值|原数组']
 ],
 3:[
  ['JavaScript 中 Promise 注册完成回调用哪个方法？','then','then|done|success|resolve'],
  ['JavaScript 中 await 只能用在哪种函数里？','async 函数','async 函数|普通函数|箭头函数|构造函数'],
  ['JavaScript 中闭包指的是什么？','函数与其引用的外部变量的组合','函数与其引用的外部变量的组合|立即执行函数|箭头函数|递归函数'],
  ['JavaScript 中按 id 获取元素用哪个方法？','document.getElementById','document.getElementById|document.querySelectorAll|document.getElementsByClassName|document.getElementsByTagName'],
  ['JavaScript 中 async 函数一定返回什么？','Promise','Promise|回调函数|生成器|布尔值']
 ],
 4:[
  ['JavaScript 中原型链的主要作用是？','实现对象间的属性继承','实现对象间的属性继承|管理内存|处理事件|解析 JSON'],
  ['JavaScript 中 setTimeout(fn,0) 的回调会在何时执行？','当前同步代码执行完后','当前同步代码执行完后|立即同步执行|下一帧绘制前|页面卸载时'],
  ['JavaScript 中普通函数的 this 取决于什么？','调用方式','调用方式|定义位置|函数名|参数个数'],
  ['JavaScript 中 let 与 var 的关键区别是？','let 具有块级作用域','let 具有块级作用域|let 不能重新赋值|var 不能声明函数|两者没有区别'],
  ['JavaScript 中 0.1 + 0.2 === 0.3 的结果是？','false','false|true|NaN|报错']
 ]
},
sql:{
 0:[
  ['SQL 中查询数据用哪个关键字？','SELECT','SELECT|GET|FIND|QUERY'],
  ['SQL 中指定查询的表用哪个关键字？','FROM','FROM|IN|TABLE|WHERE'],
  ['SQL 中筛选条件用哪个关键字？','WHERE','WHERE|IF|HAVING|WHEN'],
  ['SQL 中插入数据用哪组关键字？','INSERT INTO','INSERT INTO|ADD INTO|PUT INTO|APPEND TO'],
  ['SQL 语句结尾通常用哪个符号？','分号 ;','分号 ;|句号 .|冒号 :|斜杠 /']
 ],
 1:[
  ['SQL 中删除表中数据用哪个关键字？','DELETE','DELETE|REMOVE|DROP|CLEAR'],
  ['SQL 中修改数据用哪个关键字？','UPDATE','UPDATE|MODIFY|ALTER|SET'],
  ['SQL 中排序用哪组关键字？','ORDER BY','ORDER BY|SORT BY|GROUP BY|ARRANGE BY'],
  ['SQL 中限制返回行数用哪个关键字？','LIMIT','LIMIT|TOP|MAX|ROWS'],
  ['SQL 中模糊匹配用哪个关键字？','LIKE','LIKE|MATCH|REGEX|SIMILAR'],
  ['SQL 中降序排列用哪个关键字？','DESC','DESC|ASC|DOWN|REVERSE']
 ],
 2:[
  ['SQL 中连接两张表用哪个关键字？','JOIN','JOIN|LINK|MERGE|COMBINE'],
  ['SQL 中分组统计用哪组关键字？','GROUP BY','GROUP BY|ORDER BY|PARTITION BY|SPLIT BY'],
  ['SQL 中对分组结果筛选用哪个关键字？','HAVING','HAVING|WHERE|FILTER|ON'],
  ['SQL 中统计行数用哪个函数？','COUNT(*)','COUNT(*)|SUM(*)|TOTAL(*)|ROWS(*)'],
  ['SQL 中左连接的关键字是？','LEFT JOIN','LEFT JOIN|LEFT MERGE|JOIN LEFT|OUTER LEFT']
 ],
 3:[
  ['SQL 中子查询指的是什么？','嵌套在另一条语句中的查询','嵌套在另一条语句中的查询|并行执行的查询|被缓存的查询|一张视图'],
  ['数据库索引的主要作用是？','加快查询速度','加快查询速度|节省磁盘空间|保证事务完整|加密数据'],
  ['事务 ACID 中的 I 指什么？','隔离性','隔离性|完整性|独立性|幂等性'],
  ['SQL 中唯一约束的关键字是？','UNIQUE','UNIQUE|ONLY|DISTINCT|SINGLE'],
  ['SQL 中主键的特点是什么？','唯一且非空','唯一且非空|可以重复|可以为空|只能为数字']
 ],
 4:[
  ['SQL 中视图 VIEW 本质上是什么？','保存下来的查询','保存下来的查询|一张物理表|一个索引|一个触发器'],
  ['防止 SQL 注入最有效的做法是？','使用参数化查询','使用参数化查询|过滤单引号|隐藏表名|限制返回行数'],
  ['数据库第一范式要求什么？','每个字段不可再分','每个字段不可再分|必须有主键|不能有外键|必须有索引'],
  ['SQL 中存储过程的主要优点是什么？','预编译并可重复调用','预编译并可重复调用|自动创建索引|自动备份数据|自动加密字段'],
  ['SQL 中 TRUNCATE 与 DELETE 的主要区别是？','TRUNCATE 不能带条件且更快','TRUNCATE 不能带条件且更快|TRUNCATE 可以回滚|DELETE 会删除表结构|两者没有区别']
 ]
},
web:{
 0:[
  ['HTML 的全称是？','超文本标记语言','超文本标记语言|高级文本语言|超链接语言|网页编程语言'],
  ['HTML 中最大的标题标签是？','h1','h1|h6|title|head'],
  ['HTML 中定义段落的标签是？','p','p|div|span|br'],
  ['HTML 中定义超链接的标签是？','a','a|link|href|url'],
  ['HTML 中图片地址写在哪个属性里？','src','src|href|alt|url'],
  ['HTML 中定义无序列表的标签是？','ul','ul|ol|li|dl']
 ],
 1:[
  ['CSS 中选择 class 为 box 的元素用哪个写法？','.box','.box|#box|box|*box'],
  ['CSS 中选择 id 为 box 的元素用哪个写法？','#box','#box|.box|box|@box'],
  ['CSS 中设置文字颜色的属性是？','color','color|font-color|text-color|foreground'],
  ['CSS 中设置元素显示方式的属性是？','display','display|show|visible|layout'],
  ['CSS 中设置外边距的属性是？','margin','margin|padding|border|gap'],
  ['CSS 中设置内边距的属性是？','padding','padding|margin|border|spacing']
 ],
 2:[
  ['CSS 中开启弹性布局用哪个声明？','display:flex','display:flex|display:grid|position:flex|layout:flex'],
  ['CSS 中开启网格布局用哪个声明？','display:grid','display:grid|display:flex|display:table|display:block'],
  ['CSS 中让元素相对定位并保留原占位用？','position:relative','position:relative|position:absolute|position:fixed|position:static'],
  ['CSS 中让元素固定在视口用？','position:fixed','position:fixed|position:absolute|position:relative|position:sticky'],
  ['CSS 中媒体查询用哪个规则？','@media','@media|@query|@screen|@responsive'],
  ['CSS 中 flex 布局的主轴对齐用哪个属性？','justify-content','justify-content|align-items|flex-wrap|flex-direction']
 ],
 3:[
  ['CSS 盒模型由内到外依次是？','content → padding → border → margin','content → padding → border → margin|content → border → padding → margin|margin → padding → border → content|padding → content → border → margin'],
  ['CSS 中鼠标悬停的伪类是？',':hover',':hover|:focus|:active|:visited'],
  ['下列 CSS 选择器中优先级最高的是？','行内样式','行内样式|类选择器|标签选择器|后代选择器'],
  ['响应式页面通常需要在 head 里加什么？','viewport meta','viewport meta|charset meta|base 标签|link 标签'],
  ['CSS 中 box-sizing:border-box 的作用是？','宽高包含 padding 和 border','宽高包含 padding 和 border|宽高只包含内容|去掉边框|禁用盒模型'],
  ['CSS 中 :nth-child(2) 表示什么？','父元素下的第 2 个子元素','父元素下的第 2 个子元素|第 2 个 class 元素|第 2 个兄弟中的任意元素|最后一个子元素']
 ],
 4:[
  ['CSS 中定义关键帧动画用哪个规则？','@keyframes','@keyframes|@animation|@transition|@frames'],
  ['CSS 变量的声明方式是？','--name: value','--name: value|$name: value|@name: value|var name: value'],
  ['浏览器渲染流程的正确顺序是？','解析 → 布局 → 绘制 → 合成','解析 → 布局 → 绘制 → 合成|布局 → 解析 → 合成 → 绘制|解析 → 绘制 → 布局 → 合成|绘制 → 布局 → 解析 → 合成'],
  ['图片懒加载的主要目的是什么？','减少首屏请求与流量','减少首屏请求与流量|提升图片清晰度|加快服务器编译|避免浏览器缓存'],
  ['防抖（debounce）的作用是什么？','频繁触发时只执行最后一次','频繁触发时只执行最后一次|立即执行第一次|按固定间隔执行|并行执行所有调用']
 ]
}
};

/* ---------- 参数化生成器（每题答案当场计算，解析与答案同源） ---------- */
function binExp(n){var s=binOf(n),p=[];for(var i=0;i<s.length;i++){if(s.charAt(i)==='1')p.push(String(Math.pow(2,s.length-1-i)));}return '按位权展开：'+s+'₂ = '+p.join(' + ')+' = '+n;}
function bitExp(a,b,ans,op){
  var name={and:'按位与',or:'按位或',xor:'按位异或'}[op];
  var rule={and:'同为 1 才得 1',or:'有一位是 1 就得 1',xor:'两位不同才得 1'}[op];
  return name+'：'+rule+'，'+binOf(a)+' '+({and:'&',or:'|',xor:'^'}[op])+' '+binOf(b)+' = '+binOf(ans)+' = '+ans;
}
function factSeq(n){var a=[];for(var i=1;i<=n;i++)a.push(i);return a.join(' × ');}
var CODE_GENX={
all:{
 0:[
  function(){var n=riN(5,63);return mkQA('二进制 '+binOf(n)+' 等于十进制多少？',n,neighbors(n),binExp(n));},
  function(){var n=riN(5,63),s=binOf(n);return mkQA('十进制 '+n+' 的二进制是？',s,binWrongs(s),'用 2 不断除取余、余数倒序排列：'+n+' = '+s+'₂');},
  function(){var n=riN(16,255);return mkQA('十六进制 0x'+hexOf(n)+' 等于十进制多少？',n,neighbors(n),'按 16 的幂展开：0x'+hexOf(n)+' 每位乘 16⁰、16¹… 累加得 '+n);},
  function(){var n=riN(16,255);return mkQA('十进制 '+n+' 的十六进制是？',hexOf(n),[hexOf(n^1),hexOf(n^2),hexOf(n^4)],'用 16 不断除取余、余数倒序排列：'+n+' = 0x'+hexOf(n));},
  function(){var i=riN(0,25),ch=String.fromCharCode(65+i);return mkQA('大写字母 '+ch+' 的 ASCII 码是？',65+i,neighbors(65+i),'A 从 65 起按字母表递增，'+ch+' 是第 '+(i+1)+' 个：65 + '+i+' = '+(65+i));}
 ],
 1:[
  function(){var a=riN(20,99),b=riN(3,9);return mkQA(a+' % '+b+'（取余）的结果是？',a%b,neighbors(a%b),a+' ÷ '+b+' = '+Math.floor(a/b)+' 余 '+(a%b)+'，取余只看余数');},
  function(){var a=riN(2,9),b=riN(2,9),c=riN(2,9);return mkQA('表达式 '+a+' + '+b+' × '+c+' 的值是？',a+b*c,[(a+b)*c,a*b+c,a+b+c].concat(neighbors(a+b*c)),'先乘除后加减：'+b+' × '+c+' = '+(b*c)+'，再加 '+a+' 得 '+(a+b*c));},
  function(){var a=riN(11,99),b=riN(2,9);return mkQA('整数除法 '+a+' / '+b+'（向下取整）的结果是？',Math.floor(a/b),neighbors(Math.floor(a/b)),b+' × '+Math.floor(a/b)+' = '+(b*Math.floor(a/b))+'，整数除法把余数丢掉，得 '+Math.floor(a/b));}
 ],
 2:[
  function(){var a=riN(1,15),b=riN(1,15);return mkQA(a+' & '+b+'（按位与）的结果是？',a&b,bitCands(a,b,a&b),bitExp(a,b,a&b,'and'));},
  function(){var a=riN(1,15),b=riN(1,15);return mkQA(a+' | '+b+'（按位或）的结果是？',a|b,bitCands(a,b,a|b),bitExp(a,b,a|b,'or'));},
  function(){var a=riN(1,15),b=riN(1,15);return mkQA(a+' ^ '+b+'（按位异或）的结果是？',a^b,bitCands(a,b,a^b),bitExp(a,b,a^b,'xor'));},
  function(){var a=riN(1,9),k=riN(1,3);return mkQA(a+' << '+k+'（左移）的结果是？',a<<k,shiftCands(a,k,a<<k),'左移 '+k+' 位等于乘 '+Math.pow(2,k)+'：'+a+' × '+Math.pow(2,k)+' = '+(a<<k));}
 ],
 3:[],
 4:[
  function(){var v=riN(1,63);return mkQA('8 位补码中，-'+v+' 的二进制表示是？',binOf(256-v,8),[binOf(v,8),binOf(v|128,8),binOf(255-v,8)],'补码 = 256 − '+v+' = '+(256-v)+'，写成 8 位二进制就是 '+binOf(256-v,8));}
 ]
},
c:{
 0:[],
 1:[
  function(){var a=riN(2,9),b=riN(2,9),c=riN(2,9);return mkQA('C 语言中，表达式 '+a+' + '+b+' * '+c+' 的值是？',a+b*c,[(a+b)*c,a*b+c,a+b+c].concat(neighbors(a+b*c)),'C 里 * 优先级高于 +：先算 '+b+' * '+c+' = '+(b*c)+'，再加 '+a+' 得 '+(a+b*c));},
  function(){var x=riN(1,9);return mkQA('C 语言中 int x='+x+'; 执行 printf("%d", x++); 输出的是？',x,neighbors(x),'x++ 是后置自增：先取用旧值 '+x+' 打印，之后 x 才变成 '+(x+1));},
  function(){var n=riN(2,12);return mkQA('C 语言中 for(int i=0;i<'+n+';i++) 的循环体执行几次？',n,neighbors(n),'i 从 0 开始、取到 '+(n-1)+' 为止，一共 '+n+' 次');},
  function(){var n=riN(3,10);return mkQA('C 语言中 int a['+n+']; 最后一个元素的下标是？',n-1,neighbors(n-1),'C 数组下标从 0 开始，'+n+' 个元素的下标是 0 ~ '+(n-1));},
  function(){var a=riN(1,9),b=riN(1,9);return mkQA('C 语言中 (a>b)?a:b，当 a='+a+'、b='+b+' 时结果是？',Math.max(a,b),neighbors(Math.max(a,b)),'三目运算符先判条件：'+(a>b?'a>b 成立，取 a = ':'a>b 不成立，取 b = ')+Math.max(a,b));}
 ],
 2:[
  function(){var T=[['char',1],['short',2],['int',4],['float',4],['double',8]],it=T[ri(T.length)];return mkQA('C 语言中，在常见 64 位平台上 sizeof('+it[0]+') 的值通常是？',it[1],neighbors(it[1]),'在 64 位平台上 '+it[0]+' 占 '+it[1]+' 个字节');},
  function(){var a=riN(1,15),b=riN(1,15);return mkQA('C 语言中，'+a+' & '+b+' 的结果是？',a&b,bitCands(a,b,a&b),bitExp(a,b,a&b,'and'));},
  function(){var a=riN(1,20),k=riN(1,3);return mkQA('C 语言中，'+a+' << '+k+' 的结果是？',a<<k,shiftCands(a,k,a<<k),'左移 '+k+' 位等于乘 '+Math.pow(2,k)+'：'+a+' × '+Math.pow(2,k)+' = '+(a<<k));}
 ],
 3:[
  function(){var n=riN(3,6);return mkQA('C 语言中，递归计算 '+n+'! 的结果是？',fact(n),neighbors(fact(n)),'阶乘连乘：'+n+'! = '+factSeq(n)+' = '+fact(n));},
  function(){var n=riN(5,9);return mkQA('斐波那契数列 F(1)=1、F(2)=1，则 F('+n+') 的值是？',fibOf(n),neighbors(fibOf(n)),'按 F(n)=F(n−1)+F(n−2) 逐项递推，F('+n+') = '+fibOf(n));}
 ],
 4:[
  function(){var v=riN(128,255);return mkQA('在常见补码平台上，8 位有符号 char 存储 '+v+' 会得到？',v-256,neighbors(v-256),'8 位有符号 char 上限 127，'+v+' 越界后按补码回绕：'+v+' − 256 = '+(v-256));}
 ]
},
python:{
 0:[],
 1:[
  function(){var W=['code','python','list','hello','data','test','java','web'],s=W[ri(W.length)];return mkQA('Python 中 len("'+s+'") 的结果是？',s.length,neighbors(s.length),'len() 数字符个数，"'+s+'" 一共 '+s.length+' 个字符');},
  function(){var n=riN(3,10);return mkQA('Python 中 sum(range('+n+')) 的结果是？',n*(n-1)/2,neighbors(n*(n-1)/2),'range('+n+') 是 0 ~ '+(n-1)+'，首尾相加乘项数除以 2，得 '+(n*(n-1)/2));},
  function(){var s='abcdefgh',i=riN(0,3),j=riN(i+2,7),ans=s.slice(i,j);return mkQA('Python 中 "'+s+'"['+i+':'+j+'] 的结果是？',ans,[s.slice(i,j+1),s.slice(i+1,j),s.slice(i+1,j+1),ans.toUpperCase()],'切片含头不含尾，取下标 '+i+' 到 '+(j-1)+'，得 "'+ans+'"');}
 ],
 2:[
  function(){var n=riN(10,99);return mkQA('Python 中 d={"a": '+n+'}，则 d["a"] 的值是？',n,neighbors(n),'字典按键取值，d["a"] 就是构造时写进去的 '+n);}
 ],
 3:[
  function(){var n=riN(3,9);return mkQA('Python 中 max(list(range('+n+'))) 的结果是？',n-1,neighbors(n-1),'range('+n+') 是 0 ~ '+(n-1)+'，最大值是 '+(n-1));}
 ],
 4:[]
},
java:{
 0:[],
 1:[
  function(){var n=riN(2,12);return mkQA('Java 中 for(int i=0;i<'+n+';i++) 的循环体执行几次？',n,neighbors(n),'i 从 0 走到 '+(n-1)+'，共 '+n+' 次');},
  function(){var n=riN(2,9);return mkQA('Java 中 int[] a = new int['+n+']; 该数组的 length 是？',n,neighbors(n),'new int['+n+'] 申请 '+n+' 个元素，length 就是 '+n);}
 ],
 2:[
  function(){var W=['hello','java','code','world','array'],s=W[ri(W.length)];return mkQA('Java 中 "'+s+'".length() 的结果是？',s.length,neighbors(s.length),'length() 数字符个数，"'+s+'" 有 '+s.length+' 个字符');},
  function(){var s='abcdef',i=riN(0,3);return mkQA('Java 中 "'+s+'".substring('+i+') 的结果是？',s.slice(i),[s.slice(i+1),s.slice(Math.max(0,i-1)),s.slice(0,i+1),s.slice(i,i+2)],'substring(n) 从下标 n 取到末尾，结果是 "'+s.slice(i)+'"');}
 ],
 3:[],
 4:[]
},
js:{
 0:[],
 1:[
  function(){var n=riN(2,9),arr=[];for(var i=0;i<n;i++)arr.push(i+1);return mkQA('JavaScript 中 ['+arr.join(',')+'].length 的值是？',n,neighbors(n),'length 是元素个数，数组里有 '+n+' 个元素');},
  function(){var n=riN(1,5),x=riN(1,9),arr=[];for(var i=0;i<n;i++)arr.push(i+1);return mkQA('JavaScript 中 var a=['+arr.join(',')+']; a.push('+x+'); 之后 a.length 的值是？',n+1,neighbors(n+1),'push 在末尾追加一个元素：'+n+' + 1 = '+(n+1));}
 ],
 2:[
  function(){var n=riN(2,4),k=riN(2,3),arr=[];for(var i=0;i<n;i++)arr.push(riN(1,5));var out=arr.map(function(x){return x*k});return mkQA('JavaScript 中 ['+arr.join(',')+'].map(x => x * '+k+') 的结果是？','['+out.join(', ')+']',['['+arr.join(', ')+']','['+out.map(function(x){return x+1}).join(', ')+']','['+out.concat([out[0]]).join(', ')+']','['+arr.map(function(x){return x+k}).join(', ')+']'],'map 逐个元素乘以 '+k+'：'+arr.join("、")+' 分别变成 '+out.join("、"));}
 ],
 3:[],
 4:[]
},
sql:{
 0:[],
 1:[
  function(){var n=riN(5,100);return mkQA('SQL 中 SELECT * FROM t LIMIT '+n+' 最多返回多少行？',n,neighbors(n),'LIMIT '+n+' 限制结果集最多 '+n+' 行');}
 ],
 2:[],
 3:[],
 4:[]
},
web:{
 0:[],
 1:[],
 2:[
  function(){var w=riN(50,300),p=riN(5,20);return mkQA('CSS 中 width:'+w+'px; padding:'+p+'px;（box-sizing 为默认 content-box）该元素实际占宽多少 px？',w+p*2,neighbors(w+p*2),'content-box 下 width 只是内容宽，左右各加 '+p+' 的内边距：'+w+' + '+p+'×2 = '+(w+p*2));},
  function(){var w=riN(50,300),p=riN(5,20);return mkQA('CSS 中 width:'+w+'px; padding:'+p+'px; 且 box-sizing:border-box，内容区宽度是多少 px？',w-p*2,neighbors(w-p*2),'border-box 下 width 含内边距，内容宽 = '+w+' − '+p+'×2 = '+(w-p*2));}
 ],
 3:[],
 4:[]
}
};
/* ---------- 知识点池生成器 ---------- */
function kbGen(list){
  var g=function(){
    var it=list[ri(list.length)];
    return mkQA(it[0],it[1],String(it[2]||'').split('|'));
  };
  g.kb=list.length;
  return g;
}
function tagGen(g,L){
  var w=function(){
    var q=g();
    if(q&&!q.tag)q.tag=L;
    return q;
  };
  w.kb=g.kb;w.lang=L;
  return w;
}

var CODE_LANG_KEYS=['c','python','java','js','sql','web','all'];
/* P1-4：CODE_GENX 每个生成器的参数空间（kb = 随机变量取值数之积，固定题记 1）。
   由 tagGen 抄到 CODE_GEN 的包装函数上，codeEstimate 才能按真实参数空间统计（旧版一律按 600 估）。 */
var CODE_GENX_KB={
 all:{0:[59,59,240,240,26],1:[560,512,712],2:[225,225,225,27],4:[63]},
 c:{1:[512,9,11,8,81],2:[5,225,60],3:[4,5],4:[128]},
 python:{1:[8,8,18],2:[90],3:[7]},
 java:{1:[11,8],2:[5,4]},
 js:{1:[8,45],2:[30]},
 sql:{1:[96]},
 web:{2:[4016,4016]}
};
(function(){for(var L in CODE_GENX_KB){if(!CODE_GENX_KB.hasOwnProperty(L))continue;
  for(var d in CODE_GENX_KB[L]){if(!CODE_GENX_KB[L].hasOwnProperty(d))continue;
    var ks=CODE_GENX_KB[L][d],fs=(CODE_GENX[L]||{})[d]||[];
    for(var i=0;i<fs.length&&i<ks.length;i++){if(fs[i]&&ks[i]!=null)fs[i].kb=ks[i];}
  }}})();

var CODE_GEN={};
(function(){
  CODE_LANG_KEYS.forEach(function(L){
    CODE_GEN[L]={};
    for(var d=0;d<5;d++){
      var arr=[],ks=(CODE_KB[L]||{})[String(d)]||[];
      if(ks.length)arr.push(tagGen(kbGen(ks),L));
      var xs=(CODE_GENX[L]||{})[String(d)]||[];
      for(var i=0;i<xs.length;i++)arr.push(tagGen(xs[i],L));
      CODE_GEN[L][String(d)]=arr;
    }
  });
})();
/* 题量估算口径（P1-4）：人工题按实际条数、模板生成器按自己的参数空间（kb）累加。
   旧版对没有 kb 的生成器一律按 600 估，书架会显示「≥X 万题」，实际参数空间远小于此。 */
function codeEstimate(){
  var manual=0,gen=0,k,L;
  for(k in POOLS.code)if(POOLS.code.hasOwnProperty(k))manual+=POOLS.code[k].length;
  for(L in CODE_GEN)if(CODE_GEN.hasOwnProperty(L)){
    for(k in CODE_GEN[L])if(CODE_GEN[L].hasOwnProperty(k)){
      CODE_GEN[L][k].forEach(function(g){gen+=(g&&g.kb)?g.kb:60;});
    }
  }
  return manual+gen;
}
/* 分项给人看：[人工题, 模板题] */
function codeEstimateParts(){
  var n=codeEstimate(),manual=0,k;
  for(k in POOLS.code)if(POOLS.code.hasOwnProperty(k))manual+=POOLS.code[k].length;
  return {manual:manual,gen:Math.max(0,n-manual),total:n};
}
/* 语言档案三态：
   'unset'  = 从没做过检测（或数据损坏）→ 出全部语言，但 UI 必须显式警示
   'all'    = 用户明确「跳过 / 全部语言」→ 出全部语言，不警示
   'only'   = 用户显式勾选了语言 → 严格只出这些 + all
   旧数据兼容：done=true 且 langs=[] 且没有 all 字段 → 视为 'unset'（疑似「跳过」旧写法） */
function codeLangState(){
  var p=null;
  try{p=JSON.parse(S.getItem(CODE_PROFILE_KEY)||'null');}catch(e){p=null;}
  if(!p||!p.done)return {mode:'unset',langs:[]};
  if(p.all)return {mode:'all',langs:[]};
  if(p.langs&&p.langs.length)return {mode:'only',langs:p.langs.slice()};
  return {mode:'unset',langs:[]};
}
/* 语言过滤：读过实力检测档案就只出勾选语言 + 通用题 */
function codeAllowedLangs(){
  var st=codeLangState();
  if(st.mode==='only')return st.langs.concat(['all']);
  return null;                     /* unset / all → 不过滤 */
}
/* 最终语言闸：档案为 only 时，凡 tag 不在允许列表且不是 all 的题一律丢弃。
   放在所有取题出口的最后一步，防止任何补池/兜底/回顾路径把别的语言带进来。 */
function langGuard(qs){
  var allowed=codeAllowedLangs();
  if(!allowed)return qs||[];
  return (qs||[]).filter(function(q){
    if(!q)return false;
    var t=String(q.tag||'all');
    return t==='all'||allowed.indexOf(t)>=0;
  });
}
/* 出题：人工题限量（保证不把生成器饿死）+ 近期去重（跨局不撞题）+ 生成器补齐 */
function codeLoadRecent(k){
  try{var a=JSON.parse(S.getItem(k)||'[]');return Array.isArray(a)?a:[];}catch(e){return [];}
}
function codeSaveRecent(k,a){
  try{S.setItem(k,JSON.stringify(a.slice(0,80)));}catch(e){}
}
QA_TYPES.code.gen=function(n,diff){
  n=Math.max(1,n|0);
  var dd=(typeof diff==='number'&&diff>=0&&diff<5)?diff:0;
  var pool=POOLS.code[String(dd)]||POOLS.code['0']||[];
  var allowed=codeAllowedLangs();
  var filtered=[];
  pool.forEach(function(it){
    if(allowed&&allowed.indexOf(it[2]||'all')<0)return;
    filtered.push(it);
  });
  var rk='bt_qa_recent_code_'+dd;
  var rec=codeLoadRecent(rk),recSet={};
  rec.forEach(function(x){if(x)recSet[x]=1;});
  var seen={};
  if(n===1&&typeof qlist!=='undefined'&&qlist&&qlist.length){
    qlist.forEach(function(x){if(x&&x.q)seen[x.q]=1;});
  }
  var langs=allowed||CODE_LANG_KEYS;
  var gens=[];
  langs.forEach(function(L){
    var g=(CODE_GEN[L]||{})[String(dd)]||[];
    g.forEach(function(x){gens.push(x);});
  });
  /* 人工题每局最多占一半，且保证连刷 5 局不重复（按人工题总数反推本局上限） */
  var cap=Math.max(1,Math.min(Math.round(n*0.5),Math.floor(filtered.length/5)));
  if(n>=4&&cap<2)cap=2;
  var out=[];
  var order=filtered.slice().sort(function(a,b){
    var ra=recSet[a[0]]?1:0,rb=recSet[b[0]]?1:0;
    if(ra!==rb)return ra-rb;
    return Math.random()-0.5;
  });
  order.forEach(function(it){
    if(out.length>=cap)return;
    if(seen[it[0]])return;
    var q=mkFromPool(it,filtered);
    if(!q||seen[q.q])return;
    q.tag=it[2]||'all';
    seen[q.q]=1;out.push(q);
  });
  var guard=0,relaxed=false;
  while(out.length<n&&gens.length&&guard++<900){
    if(guard>380)relaxed=true;
    var g=gens[riN(0,gens.length-1)],q=null;
    try{q=g();}catch(e){continue;}
    if(!q||!q.q||q.a==null)continue;
    if(q.tag&&allowed&&allowed.indexOf(q.tag)<0)continue;
    if(seen[q.q])continue;
    if(!relaxed&&recSet[q.q])continue;
    seen[q.q]=1;out.push(q);
  }
  /* 单语言档位题量不够时，用 all 的相邻档补齐（规格允许，避免无题可出） */
  if(out.length<n){
    var alt=[dd,dd-1,dd+1,dd-2,dd+2];
    for(var ai=0;ai<alt.length&&out.length<n;ai++){
      var ad=alt[ai];
      if(ad<0||ad>4)continue;
      var ag=(CODE_GEN.all||{})[String(ad)]||[];
      if(!ag.length)continue;
      guard=0;
      while(out.length<n&&guard++<300){
        var aq=null;
        try{aq=ag[riN(0,ag.length-1)]();}catch(e){continue;}
        if(!aq||!aq.q||aq.a==null||seen[aq.q])continue;
        aq.tag='all';seen[aq.q]=1;out.push(aq);
      }
    }
  }
  out=out.slice(0,n);
  codeSaveRecent(rk,out.map(function(x){return x.q;}).concat(rec));
  return out;
};
/* ===== 程序编写板块：读代码 / 补全代码（答案当场算出，绝不写死） ===== */
function mkCodeQ(prompt,code,ans,alts,exp){
  /* 选项去重后再按数值补足到 4 个，避免参数巧合时只剩 3 个选项 */
  var a=String(ans),seen={},list=[];seen[a]=1;
  (alts||[]).forEach(function(x){x=String(x);if(seen[x]||list.length>=3)return;seen[x]=1;list.push(x);});
  /* 补足条件放宽到「任意纯数字串」：整数按 ±1/±2 偏移，小数保持原有小数位，
     否则像 "4.0" 这种答案（Number→4→"4" 与原串不等）会被判成不可补位，只剩 3 个选项 */
  var num=/^-?\d+(\.\d+)?$/.test(a)?Number(a):NaN;
  if(list.length<3&&isFinite(num)){
    var dec=a.indexOf('.')>=0?a.split('.')[1].length:0,k=1;
    while(list.length<3&&k<200){
      var d=Math.ceil(k/2)*(k%2?1:-1),w=(num+d).toFixed(dec);
      if(!seen[w]){seen[w]=1;list.push(w);}
      k++;
    }
  }
  var q=mkQA(prompt,a,list,exp);
  q.code=code;q.kind='out';
  return q;
}
function mkCodeFill(prompt,code,ans,cands,exp){
  var q=mkQA(prompt,ans,cands||[],exp);
  q.code=code;q.opts=null;q.fillin=1;q.kind='fill';
  return q;
}
/* ===== 程序编写 · 知识点×难度矩阵（替代 CODE_GEN_CODE 的分档数组） =====
   每个 topic：{k:知识点, lang:语言, ranks:[可出题的档位], gen:生成函数}
   组题时按当前档位过滤 → 随机抽知识点 → 调 gen() 生成一题（答案当场算出）。
   低档 = 数制码制/数据类型/运算符/顺序/选择（用户点名的 C 基础）
   中档 = 循环/数组/字符串   高档 = 函数/指针/递归/算法    */
var CODE_TOPICS=[
  /* ---- rank 0 · 数制与码制（C 基础第一章） ---- */
  {k:'十进制转二进制',lang:'c',ranks:[0],kb:11,gen:function(){
    var n=riN(5,15),b=n.toString(2);
    return mkCodeQ('把十进制 '+n+' 转成二进制，结果是？',
      '// 手算或除 2 取余',b,
      [bitsFlip(b),bitsFlip2(b),String(n+1)],
      n+' 转二进制：'+n+' = '+b.split('').join('+')+'₂（除 2 取余倒序排列）');
  }},
  {k:'二进制转十进制',lang:'c',ranks:[0],kb:16,gen:function(){
    var b=randBits(4),d=parseInt(b,2);
    return mkCodeQ('二进制 '+b+'₂ 对应的十进制是？',
      '// 按位权展开',String(d),
      [String(d+1),String(d+2),String(d-1)],
      b+'₂ = 按权展开：'+b.split('').map(function(ch,i){return ch+'×2^'+(3-i);}).join(' + ')+' = '+d);
  }},
  {k:'十六进制转十进制',lang:'c',ranks:[0],kb:14,gen:function(){
    var n=riN(2,15),h=n.toString(16).toUpperCase();
    return mkCodeQ('十六进制 0x'+h+' 对应的十进制是？',
      '// 0x 前缀表示十六进制',String(n),
      [String(n+1),String(n+2),String(n*2)],
      '0x'+h+' = '+n+'（十六进制位权是 16，A=10…F=15）');
  }},
  {k:'十进制转十六进制',lang:'c',ranks:[0],kb:21,gen:function(){
    var n=riN(10,30),h=n.toString(16).toUpperCase();
    return mkCodeQ('十进制 '+n+' 转成十六进制，结果是？',
      '// 除 16 取余',h,
      pickAlts(h,['0x'+h,String(n+1),String(n+2),String(n*2)]),
      n+' 转十六进制 = 0x'+h+'（除 16 取余倒序）');
  }},
  {k:'原码补码概念',lang:'c',ranks:[0],kb:5,gen:function(){
    var n=riN(3,7);
    return mkCodeQ('int 类型里，负数通常用什么码存储？',
      '// C 语言整型负数存储方式','补码',
      ['原码','反码','ASCII码'],
      'C 里 int 负数用补码存储：符号位不变、其余取反再加 1（例：-'+n+' 的补码由 '+n+' 的二进制取反+1 得到）');
  }},
  /* ---- rank 0 · 基本数据类型 ---- */
  {k:'sizeof 类型大小',lang:'c',ranks:[0],kb:4,gen:function(){
    var ts=[['char',1],['int',4],['float',4],['double',8]],t=ts[riN(0,3)];
    return mkCodeQ('在 32 位体系下，sizeof('+t[0]+') 的值是？',
      'printf("%d", sizeof('+t[0]+'));',String(t[1]),
      [String(t[1]+1),String(t[1]+4),String(t[1]*2)],
      'sizeof('+t[0]+') 返回该类型占的字节数：'+t[0]+' 占 '+t[1]+' 字节（int 按 4 字节计）');
  }},
  {k:'整数除法',lang:'c',ranks:[0],kb:10,gen:function(){
    var a=riN(5,9),b=riN(2,3);
    return mkCodeQ('这段 C 代码输出什么？',
      'int a = '+a+', b = '+b+';\nprintf("%d", a / b);',
      String(Math.floor(a/b)),[String(a/b),String(Math.ceil(a/b)),String(a-b)],
      '两个 int 相除结果是整数（向零取整）：'+a+'÷'+b+' = '+(a/b)+'，取整得 '+Math.floor(a/b));
  }},
  {k:'ASCII 与字符',lang:'c',ranks:[0],kb:4,gen:function(){
    var c=['A','B','C','D'][riN(0,3)],d=c.charCodeAt(0);
    return mkCodeQ('这段 C 代码输出什么？',
      'char c = \''+c+'\';\nprintf("%d", c);',
      String(d),[String(d+1),String(d-1),String(d+32)],
      '字符 \''+c+'\' 的 ASCII 码是 '+d+'，%d 按整数输出');
  }},
  {k:'类型隐式转换',lang:'c',ranks:[0],kb:1,gen:function(){
    return mkCodeQ('这段 C 代码输出什么？',
      'printf("%f", 7.0 / 2);',
      '3.500000',['3','3.5','4'],
      '7.0 是浮点数，7.0/2 结果是浮点 3.5，%f 默认保留 6 位小数输出 3.500000');
  }},
  /* ---- rank 0-1 · 运算符与表达式 ---- */
  {k:'后置自增',lang:'c',ranks:[0,1],kb:7,gen:function(){
    var a=riN(2,8);
    return mkCodeQ('这段 C 代码输出什么？',
      'int a = '+a+';\nint b = a++;\nprintf("%d", b);',
      String(a),[String(a+1),String(a+2),String(a-1)],
      'a++ 是先取 a 的值赋给 b、再让 a 自增，所以 b = '+a+'（a 变成 '+(a+1)+'）');
  }},
  {k:'前置自增',lang:'c',ranks:[0,1],kb:7,gen:function(){
    var a=riN(2,8);
    return mkCodeQ('这段 C 代码输出什么？',
      'int a = '+a+';\nint b = ++a;\nprintf("%d", b);',
      String(a+1),[String(a),String(a+2),String(a-1)],
      '++a 是先把 a 自增再赋值，所以 b = '+(a+1));
  }},
  {k:'取余运算',lang:'c',ranks:[0,1],kb:52,gen:function(){
    var a=riN(7,19),b=riN(3,6);
    return mkCodeQ('这段 C 代码输出什么？',
      'int a = '+a+', b = '+b+';\nprintf("%d", a % b);',
      String(a%b),[String(b),String(Math.floor(a/b)),String(a%b+b)],
      'a % b 是取余数：'+a+' ÷ '+b+' 商 '+Math.floor(a/b)+' 余 '+(a%b));
  }},
  {k:'变量相加输出',lang:'c',ranks:[0],kb:64,gen:function(){
    var a=riN(2,9),b=riN(2,9);
    return mkCodeQ('这段 C 代码输出什么？',
      'int x = '+a+';\nint y = '+b+';\nprintf("%d", x + y);',
      String(a+b),[String(a*b),String(a-b),String(a+b+1)],
      'x='+a+'、y='+b+'，printf 里算 x + y，输出 '+(a+b));
  }},
  /* ---- rank 0 · 顺序结构 / printf 格式 ---- */
  {k:'printf 格式符',lang:'c',ranks:[0],kb:8,gen:function(){
    var v=riN(2,9);
    return mkCodeQ('这段 C 代码输出什么？',
      'printf("%d", '+v+');',
      String(v),[String(v+1),String(v*2),String(v+10)],
      '%d 按十进制整数输出，直接打印 '+v);
  }},
  {k:'printf 连续输出',lang:'c',ranks:[0],kb:25,gen:function(){
    var a=riN(1,5),b=riN(1,5);
    return mkCodeQ('这段 C 代码输出什么？',
      'printf("%d%d", '+a+', '+b+');',
      String(a)+String(b),pickAlts(String(a)+String(b),[String(a+b),String(b)+String(a),String(a)+String(b+1),String(a+1)+String(b)]),
      '%d%d 是两个占位符、中间没有分隔符，所以两个数直接拼在一起：'+a+b);
  }},
  /* ---- rank 1 · 运算符与表达式 ---- */
  {k:'运算优先级',lang:'c',ranks:[1],kb:27,gen:function(){
    var a=riN(2,4),b=riN(2,4),c=riN(2,4);
    return mkCodeQ('这段 C 代码输出什么？',
      'printf("%d", '+a+' + '+b+' * '+c+');',
      String(a+b*c),[String((a+b)*c),String(a+b+c),String(a*b+c)],
      '乘除优先于加减：'+a+' + '+b+' × '+c+' = '+(b*c)+'，再加 '+a+' = '+(a+b*c));
  }},
  {k:'复合赋值',lang:'c',ranks:[1],kb:20,gen:function(){
    var a=riN(3,7),b=riN(2,5);
    return mkCodeQ('这段 C 代码输出什么？',
      'int x = '+a+';\nx += '+b+';\nprintf("%d", x);',
      String(a+b),[String(a-b),String(a*b),String(a+b+1)],
      'x += '+b+' 等价于 x = x + '+b+'，所以 x = '+(a+b));
  }},
  {k:'三目运算',lang:'c',ranks:[1],kb:7,gen:function(){
    var a=riN(3,9),b=a>=5?'A':'B';
    return mkCodeQ('这段 C 代码输出什么？',
      'int x = '+a+';\nprintf("%c", x >= 5 ? \'A\' : \'B\');',
      b,[b==='A'?'B':'A','C','5'],
      '三目运算：x>=5 成立输出 A，不成立输出 B；x='+a+'，所以输出 '+b);
  }},
  {k:'位运算',lang:'c',ranks:[1,2],kb:147,gen:function(){
    var a=riN(1,7),b=riN(1,7),op=['&','|','^'][riN(0,2)];
    var r=op==='&'?(a&b):op==='|'?(a|b):(a^b);
    return mkCodeQ('这段 C 代码输出什么？',
      'printf("%d", '+a+' '+op+' '+b+');',
      String(r),[String(a+b),String(a*b),String(r+1)],
      a+' '+op+' '+b+' = '+r+'（按二进制逐位运算：'+a.toString(2)+' '+op+' '+b.toString(2)+' = '+r.toString(2)+'₂）');
  }},
  {k:'保留小数位数',lang:'c',ranks:[1],kb:81,gen:function(){
    var a=riN(1,9),b=riN(1,9),f=parseFloat('3.'+a+b),r1=f.toFixed(1);
    /* 第三个干扰项由答案派生，避开硬编码 "4.0" 撞答案（f≥3.95 时答案四舍五入就是 4.0） */
    return mkCodeQ('这段 C 代码输出什么？',
      'printf("%.1f", '+f.toFixed(2)+');',
      r1,[f.toFixed(0),f.toFixed(2),(parseFloat(r1)+0.5).toFixed(1)],
      '%.1f 表示保留 1 位小数并四舍五入：'+f.toFixed(2)+' → '+r1);
  }},
  /* ---- rank 1 · 选择结构 ---- */
  {k:'if-else 判断',lang:'c',ranks:[1],kb:9,gen:function(){
    var x=riN(1,9),hit=x>3;
    return mkCodeQ('这段 C 代码输出什么？',
      'int x = '+x+';\nif (x > 3)\n{\n    printf("A");\n}\nelse\n{\n    printf("B");\n}',
      hit?'A':'B',[hit?'B':'A','C','3'],
      'x='+x+'，条件 x>3 是'+(hit?'真':'假')+'，'+(hit?'走 if 输出 A':'走 else 输出 B'));
  }},
  {k:'if-else 链',lang:'c',ranks:[1],kb:9,gen:function(){
    var x=riN(1,9),r=x>=7?'大':(x>=4?'中':'小');
    return mkCodeQ('这段 C 代码输出什么？',
      'int x = '+x+';\nif (x >= 7)\n{\n    printf("大");\n}\nelse if (x >= 4)\n{\n    printf("中");\n}\nelse\n{\n    printf("小");\n}',
      r,[r==='大'?'中':'大',r==='小'?'中':'小','零'],
      '从上往下找第一个成立的条件：x='+x+'，'+(r==='大'?'x>=7 成立':(r==='中'?'x>=7 不成立，x>=4 成立':'x>=7 与 x>=4 都不成立'))+'，输出「'+r+'」');
  }},
  {k:'逻辑与或非',lang:'c',ranks:[1],kb:12,gen:function(){
    var a=riN(2,4),b=riN(6,9),hit=(a>1&&b<5);
    return mkCodeQ('这段 C 代码输出什么？',
      'int a = '+a+', b = '+b+';\nif (a > 1 && b < 5)\n{\n    printf("Y");\n}\nelse\n{\n    printf("N");\n}',
      hit?'Y':'N',[hit?'N':'Y','1','0'],
      'a>1 是'+(a>1?'真':'假')+'，b<5 是'+(b<5?'真':'假')+'，&& 要求两边都真：'+(hit?'输出 Y':'输出 N'));
  }},
  {k:'switch 分支',lang:'c',ranks:[1,2],kb:3,gen:function(){
    var x=riN(1,3);
    return mkCodeQ('这段 C 代码输出什么？',
      'int x = '+x+';\nswitch (x)\n{\ncase 1:\n    printf("A");\n    break;\ncase 2:\n    printf("B");\n    break;\ndefault:\n    printf("C");\n}',
      x===1?'A':(x===2?'B':'C'),[x===1?'B':(x===2?'C':'A'),'D','X'],
      'switch 按 x 的值匹配 case：x='+x+'，'+(x===1?'匹配 case 1 输出 A':(x===2?'匹配 case 2 输出 B':'没有匹配项走 default 输出 C')));
  }},
  /* ---- rank 1-2 · 循环结构 ---- */
  {k:'for 循环次数',lang:'c',ranks:[1],kb:6,gen:function(){
    var n=riN(3,8);
    return mkCodeQ('这段 C 代码循环体执行多少次？',
      'for (int i = 0; i < '+n+'; i++) { }',
      String(n),[String(n-1),String(n+1),String(n*2)],
      'i 从 0 到 '+(n-1)+'，共 '+n+' 次（i<n 时执行，i='+n+' 时退出）');
  }},
  {k:'while 累加',lang:'c',ranks:[1],kb:7,gen:function(){
    var n=riN(3,9);
    return mkCodeQ('这段 C 代码输出什么？',
      'int i = 1, s = 0;\nwhile (i <= '+n+')\n{\n    s += i;\n    i++;\n}\nprintf("%d", s);',
      String(n*(n+1)/2),[String(n*n),String(n*(n-1)/2),String(n+1)],
      '循环把 1 到 '+n+' 全加起来，等差数列求和 '+(n*(n+1))+'÷2 = '+(n*(n+1)/2));
  }},
  {k:'for 累加',lang:'c',ranks:[1],kb:7,gen:function(){
    var n=riN(3,9);
    return mkCodeQ('这段 C 代码输出什么？',
      'int s = 0;\nfor (int i = 1; i <= '+n+'; i++)\n{\n    s += i;\n}\nprintf("%d", s);',
      String(n*(n+1)/2),[String(n*n),String(n*(n+1)/2+1),String(n)],
      'for 循环把 1 到 '+n+' 累加到 s，等差数列求和 '+(n*(n+1))+'÷2 = '+(n*(n+1)/2));
  }},
  /* ---- rank 2 · 循环结构进阶 ---- */
  {k:'break 中断',lang:'c',ranks:[2],kb:4,gen:function(){
    var k=riN(3,6);
    return mkCodeQ('这段 C 代码输出什么？',
      'for (int i = 0; i < 10; i++)\n{\n    if (i == '+k+')\n    {\n        break;\n    }\n}\nprintf("%d", i);',
      String(k),[String(k+1),String(k-1),String(10)],
      'i 到 '+k+' 时命中 if 触发 break，立即跳出循环，此时 i = '+k);
  }},
  {k:'continue 跳过',lang:'c',ranks:[2],kb:5,gen:function(){
    var n=riN(4,8);
    return mkCodeQ('这段 C 代码输出什么？',
      'int s = 0;\nfor (int i = 1; i <= '+n+'; i++)\n{\n    if (i % 2 == 0)\n    {\n        continue;\n    }\n    s += i;\n}\nprintf("%d", s);',
      String(squareSumOdd(n)),[String(n*(n+1)/2),String(squareSumOdd(n)+1),String(n)],
      'continue 跳过偶数，只加奇数：1+3+… 到 '+n+' = '+squareSumOdd(n));
  }},
  {k:'do-while 至少一次',lang:'c',ranks:[2],kb:12,gen:function(){
    var a=riN(2,5),b=riN(2,4),r=Math.min(a+1,b);
    return mkCodeQ('这段 C 代码输出什么？',
      'int i = '+a+';\ndo { i++; } while (i < '+b+');\nprintf("%d", i);',
      String(r),[String(a),String(b),String(a+b)],
      'do-while 先执行一次再判断：i 先变成 '+(a+1)+'，再判断是否 <'+b+'，'+(r===(a+1)?'满足则退出':'继续循环到 '+r));
  }},
  {k:'双重循环计数',lang:'c',ranks:[2,3],kb:4,gen:function(){
    var n=riN(3,6);
    return mkCodeQ('这段 C 代码输出什么？',
      'int s = 0;\nfor (int i = 0; i < '+n+'; i++)\n{\n    for (int j = 0; j < '+n+'; j++)\n    {\n        s++;\n    }\n}\nprintf("%d", s);',
      String(n*n),[String(n*2),String(n),String(n*n-1)],
      '外层 '+n+' 次、内层每次 '+n+' 次，s 共加 '+n+'×'+n+' = '+(n*n)+' 次');
  }},
  /* ---- rank 2-3 · 数组（C） ---- */
  {k:'数组下标',lang:'c',ranks:[2],kb:36000,gen:function(){
    var v=[riN(1,9),riN(10,19),riN(20,29),riN(30,39)],i=riN(0,3);
    var others=v.filter(function(x){return x!==v[i];});
    return mkCodeQ('这段 C 代码输出什么？',
      'int a[4] = {'+v.join(', ')+'};\nprintf("%d", a['+i+']);',
      String(v[i]),pickAlts(String(v[i]),others.map(String)),
      '数组下标从 0 开始，a['+i+'] 是第 '+(i+1)+' 个元素 '+v[i]);
  }},
  {k:'数组遍历求和',lang:'c',ranks:[2],kb:27,gen:function(){
    var n=riN(3,5),arr=[],s=0;
    for(var i=0;i<n;i++){var v=riN(1,9);arr.push(v);s+=v;}
    return mkCodeQ('这段 C 代码输出什么？',
      'int a['+n+'] = {'+arr.join(', ')+'};\nint s = 0;\nfor (int i = 0; i < '+n+'; i++)\n{\n    s += a[i];\n}\nprintf("%d", s);',
      String(s),[String(s+1),String(s-1),String(s*n)],
      '循环把数组每个元素加起来：'+arr.join('+')+' = '+s);
  }},
  {k:'sizeof 数组长度',lang:'c',ranks:[2,3],kb:7,gen:function(){
    var n=riN(3,9);
    return mkCodeQ('这段 C 代码输出什么？',
      'int a['+n+'];\nprintf("%d", (int)(sizeof(a) / sizeof(a[0])));',
      String(n),[String(n-1),String(n*4),'1'],
      'sizeof(a) 是整个数组的字节数，除以单个元素的字节数就是元素个数 '+n);
  }},
  /* ---- rank 2-3 · 字符串（C） ---- */
  {k:'字符串下标字符',lang:'c',ranks:[2],kb:9,gen:function(){
    var s=['hello','world','abcde'][riN(0,2)],i=riN(0,2);
    var cands=[];
    for(var j=0;j<s.length;j++){var ch=s.charAt(j);if(ch!==s.charAt(i)&&cands.indexOf(ch)<0)cands.push(ch);}
    while(cands.length<3)cands.push(String.fromCharCode(65+cands.length));
    return mkCodeQ('这段 C 代码输出什么？',
      'char s[] = "'+s+'";\nprintf("%c", s['+i+']);',
      s.charAt(i),pickAlts(s.charAt(i),cands),
      '字符数组下标从 0 开始，s['+i+'] 是第 '+(i+1)+' 个字符 "'+s.charAt(i)+'"');
  }},
  {k:'strlen 字符串长度',lang:'c',ranks:[2],kb:3,gen:function(){
    var s=['abc','hello','program'][riN(0,2)];
    return mkCodeQ('这段 C 代码输出什么？',
      '#include <string.h>\nchar s[] = "'+s+'";\nprintf("%d", (int)strlen(s));',
      String(s.length),[String(s.length+1),String(s.length*2),String(s.length-1)],
      'strlen 统计字符串长度（不含结尾 \\0）："'+s+'" 有 '+s.length+' 个字符');
  }},
  /* ---- rank 3-4 · 函数（C） ---- */
  {k:'函数调用返回值',lang:'c',ranks:[3],kb:8,gen:function(){
    var a=riN(2,9);
    return mkCodeQ('这段 C 代码输出什么？',
      'int f(int x) { return x * 2; }\nprintf("%d", f('+a+'));',
      String(a*2),[String(a),String(a+2),String(a*a)],
      '调用 f('+a+')，形参 x='+a+'，函数体 return x*2，返回 '+(a*2));
  }},
  /* ---- rank 2-3 · 指针基础（C，保留并搬入） ---- */
  {k:'指针下标访问',lang:'c',ranks:[2,3],kb:2,gen:function(){
    var k=riN(1,2);
    return mkCodeQ('这段 C 代码输出什么？',
      'int a[3] = {1, 2, 3};\nint *p = a;\nprintf("%d", *(p + '+k+'));',
      String(k+1),[String(k),String(3),String(k+2)],
      'p 指向 a[0]，p + '+k+' 指向 a['+k+']（下标从 0 算），解引用得 '+(k+1));
  }},
  {k:'指针解引用赋值',lang:'c',ranks:[2,3],kb:70,gen:function(){
    var x=riN(3,9),v=riN(10,19);
    return mkCodeQ('这段 C 代码输出什么？',
      'int x = '+x+';\nint *p = &x;\n*p = '+v+';\nprintf("%d", x);',
      String(v),[String(x),String(x+v),String(v-x)],
      'p 存的是 x 的地址，*p = '+v+' 就是直接改 x 本身，所以输出 '+v);
  }},
  {k:'指针数组语法',lang:'c',ranks:[2,3],kb:1,gen:function(){
    return mkCodeQ('这段 C 代码输出什么？',
      'int a[4] = {1, 2, 3, 4};\nint *p = a + 1;\nprintf("%d", p[1]);',
      '3',['2','4','1'],
      'p 指向 a[1]，p[1] 相当于 a[2]，值是 3');
  }},
  /* ---- rank 3-4 · 递归与算法（C，保留并搬入） ---- */
  {k:'递归阶乘',lang:'c',ranks:[3,4],kb:3,gen:function(){
    var n=riN(4,6);
    return mkCodeQ('这段 C 代码输出什么？',
      'int f(int n) {\n    return n <= 1 ? 1 : n * f(n - 1);\n}\nprintf("%d", f('+n+'));',
      String(fact(n)),[String(fact(n)+n),String(n*n),String(fact(n-1))],
      '这是阶乘递归：'+n+'! = '+factSeq(n)+' = '+fact(n));
  }},
  {k:'递归斐波那契',lang:'c',ranks:[3,4],kb:6,gen:function(){
    var n=riN(6,11);
    return mkCodeQ('这段 C 代码输出什么？',
      'int f(int n) {\n    return n < 2 ? n : f(n - 1) + f(n - 2);\n}\nprintf("%d", f('+n+'));',
      String(fibOf(n)),[String(fibOf(n)+1),String(fibOf(n-1)),String(n)],
      '斐波那契递推 F(n)=F(n−1)+F(n−2)，逐项算到 F('+n+') = '+fibOf(n));
  }},
  {k:'二进制1的个数',lang:'c',ranks:[3,4],kb:16,gen:function(){
    var X=[5,6,7,9,10,11,12,13,14,17,19,21,23,25,27,29],x=X[riN(0,15)];
    var c=0,v=x;while(v){c+=v&1;v>>=1;}
    return mkCodeQ('这段 C 代码输出什么？',
      'int n = '+x+';\nint c = 0;\nwhile (n)\n{\n    c += n & 1;\n    n >>= 1;\n}\nprintf("%d", c);',
      String(c),[String(c+1),String(c+2),String(c+3)],
      '这段在数二进制里 1 的个数：'+x+' = '+binOf(x)+'₂，共有 '+c+' 个 1');
  }},
  {k:'指针相减',lang:'c',ranks:[3,4],kb:5,gen:function(){
    var k=riN(2,6);
    return mkCodeQ('这段 C 代码输出什么？',
      'int a[8] = {0};\nint *p = &a['+k+'];\nprintf("%d", (int)(p - a));',
      String(k),[String(k+1),String(k-1),String(k*4)],
      '指针相减得到相隔的元素个数，p 指向 a['+k+']，与 a 相差 '+k);
  }},
  /* ---- rank 4 · 陷阱 / 未定义行为（C，保留并搬入） ---- */
  {k:'宏文本替换陷阱',lang:'c',ranks:[4],kb:16,gen:function(){
    var a=riN(1,4),b=riN(1,4);
    return mkCodeQ('这段 C 代码输出什么？',
      '#define SQ(x) x*x\n\nprintf("%d", SQ('+a+' + '+b+'));',
      String(a+b*b),[String((a+b)*(a+b)),String(a*a+b*b),String(a+b*2)],
      '宏只是文本替换，SQ('+a+' + '+b+') 展开成 '+a+' + '+b+' * '+b+'，先乘后加得 '+(a+b*b));
  }},
  {k:'补码转无符号',lang:'c',ranks:[4],kb:9,gen:function(){
    var k=riN(1,9);
    return mkCodeQ('这段 C 代码输出什么（8 位 char）？',
      'char c = -'+k+';\nprintf("%d", (unsigned char)c);',
      String(256-k),[String(-k),String(k),String(256+k)],
      '负数按补码存，转成无符号就是 256 − '+k+' = '+(256-k));
  }},
  {k:'前置后置综合',lang:'c',ranks:[3,4],kb:12,gen:function(){
    var sv=riN(0,2),ops=['i++','++i','i--','--i'],op=ops[riN(0,3)];
    var pre=/^[+-]{2}/.test(op),after=(op==='i++'||op==='++i');
    var a=pre?(after?sv+1:sv-1):sv;
    var iv=after?sv+1:sv-1;
    var why=pre?('前置 '+op+' 先自增/自减再赋值，a 拿到新值 '+a):('后置 '+op+' 先取值 '+sv+' 赋给 a，i 之后才变 '+iv);
    return mkCodeQ('这段 C 代码输出什么？',
      'int i = '+sv+';\nint a = '+op+';\nprintf("%d %d", a, i);',
      a+' '+iv,[(a+1)+' '+iv,a+' '+(iv+1),(a+1)+' '+(iv+1)],why);
  }},
  {k:'无符号溢出回绕',lang:'c',ranks:[4],kb:1296,gen:function(){
    var a=riN(215,250),b=riN(10,45),r=(a+b)%256;
    return mkCodeQ('这段 C 代码输出什么？',
      'unsigned char c = '+a+';\nc += '+b+';\nprintf("%d", c);',
      String(r),pickAlts(r,[String(256-r),String(255-r),String(r>0?r-1:1)]),
      'unsigned char 只存 8 位、上限 255，'+(a+b)+' 溢出后回绕：'+(a+b)+' − 256 = '+r);
  }},
  /* ---- 以下为其他语言（lang 标注，仅当用户勾选对应语言且档位≥2 时出现） ---- */
  {k:'Python 乘法输出',lang:'python',ranks:[2,3,4],kb:25,gen:function(){
    var a=riN(2,6),b=riN(2,6);
    return mkCodeQ('这段 Python 代码输出什么？',
      'a = '+a+'\nb = '+b+'\nprint(a * b)',
      String(a*b),[String(a+b),String(a*10+b),String(a*b+1)],
      'Python 里数字的 * 是乘法，'+a+' × '+b+' = '+(a*b));
  }},
  {k:'Python 字符串下标',lang:'python',ranks:[2,3,4],kb:9,gen:function(){
    var s=['abc','quiz','code'][riN(0,2)],i=riN(0,2);
    return mkCodeQ('这段 Python 代码输出什么？',
      's = "'+s+'"\nprint(s['+i+'])',
      s.charAt(i),[s.charAt((i+1)%3),s.charAt((i+2)%3),String(s.length)],
      '字符串下标从 0 开始，s['+i+'] 是第 '+(i+1)+' 个字符 "'+s.charAt(i)+'"');
  }},
  {k:'Python 切片长度',lang:'python',ranks:[2,3,4],kb:6,gen:function(){
    var n=riN(2,4),k=riN(2,3);
    return mkCodeQ('这段 Python 代码输出什么？',
      'a = [1, 2, 3, 4, 5][:'+n+']\nprint(len(a) * '+k+')',
      String(n*k),[String(n+k),String(n),String(n*k+1)],
      '切片 [:'+n+'] 取前 '+n+' 个元素，len 得 '+n+'，再乘 '+k+' = '+(n*k));
  }},
  {k:'Python 可变参数',lang:'python',ranks:[2,3,4],kb:1,gen:function(){
    return mkCodeQ('这段 Python 代码输出什么？',
      'def f(t):\n    t.append(9)\n\nx = [1]\nf(x)\nprint(len(x))',
      '2',['1','9','0'],
      '列表是可变对象、按引用传入，append 改的是原列表，长度从 1 变 2');
  }},
  {k:'Python 默认参数陷阱',lang:'python',ranks:[3,4],kb:28,gen:function(){
    var t=riN(0,3),m=riN(3,9),body='';
    for(var i=0;i<t;i++)body+='f('+(i+1)+')\n';
    return mkCodeQ('这段 Python 代码输出什么？',
      'def f(x, acc=[]):\n    acc.append(x)\n    return len(acc)\n\n'+body+'print(f('+m+'))',
      String(t+1),[String(t),String(t+2),'1'],
      '默认参数 acc=[] 只在定义时创建一次，前面调用已累积 '+t+' 个，再 append 变 '+(t+1)+' 个');
  }},
  {k:'Java 字符串长度',lang:'java',ranks:[2,3,4],kb:4,gen:function(){
    var s=['quiz','code','java','html'][riN(0,3)];
    return mkCodeQ('这段 Java 代码输出什么？',
      'String s = "'+s+'";\nSystem.out.println(s.length());',
      String(s.length),[String(s.length-1),String(s.length+1),String(s.length*2)],
      'Java 的 length() 返回字符个数，"'+s+'" 有 '+s.length+' 个字符');
  }},
  {k:'Java 数组排序',lang:'java',ranks:[3,4],kb:1,gen:function(){
    return mkCodeQ('这段 Java 代码输出什么？',
      'int[] a = {5, 2, 9};\nArrays.sort(a);\nSystem.out.println(a[0]);',
      '2',['5','9','0'],
      'Arrays.sort 升序排成 {2, 5, 9}，a[0] 是最小的 2');
  }},
  {k:'JS 偶数计数',lang:'js',ranks:[2,3,4],kb:4,gen:function(){
    var n=riN(4,7);
    return mkCodeQ('这段 JavaScript 代码输出什么？',
      'var a = [];\nfor (var i = 1; i <= '+n+'; i++) {\n  if (i % 2 === 0) a.push(i);\n}\nconsole.log(a.length);',
      String(Math.floor(n/2)),[String(Math.ceil(n/2)),String(n),String(n-1)],
      '1 到 '+n+' 里偶数有 '+(Math.floor(n/2))+' 个，只有偶数被 push 进数组');
  }},
  {k:'JS 数组排序拼接',lang:'js',ranks:[3,4],kb:1,gen:function(){
    return mkCodeQ('这段 JavaScript 代码输出什么？',
      'var a = [3, 1, 2];\na.sort();\nconsole.log(a.join(""));',
      '123',['321','312','132'],
      '默认 sort 按字符串升序排列，得到 [1, 2, 3]，拼接成 "123"');
  }},
  {k:'JS 字符串拼接',lang:'js',ranks:[2,3,4],kb:3,gen:function(){
    var n=riN(2,4);
    return mkCodeQ('这段 JavaScript 代码输出什么？',
      'var s = "";\nfor (var i = 0; i < '+n+'; i++) {\n  s += i;\n}\nconsole.log(s);',
      '012345'.slice(0,n),['123456'.slice(0,n),String(n),'9'.slice(0,n)],
      'i 取 0 到 '+(n-1)+'，字符串依次拼接，得 "'+      '012345'.slice(0,n)+'"');
  }},
  /* ---- 代码补全题（kind:'fill'）：读代码 + 填空，补全关键符号 / 关键字 / 表达式 ---- */
  {k:'C 补全·比较运算符',lang:'c',ranks:[0],kb:1,gen:function(){
    return mkCodeFill('补全下面 C 代码的空白处，使它表示“a 大于 b 时输出 a 大”。',
      'int a = 7, b = 3;\nif (a ___ b)\n{\n    printf("a 大");\n} /* 判断 a 是否大于 b */',
      '>','',
      '> 是大于比较运算符，a > b 为真时进入 if 分支。');
  }},
  {k:'C 补全·变量赋值',lang:'c',ranks:[0],kb:1,gen:function(){
    return mkCodeFill('补全下面 C 代码的空白处，使 x 的值等于 5。',
      'int x = ___; /* x 应为 5 */',
      '5','',
      '直接写 5 即可：int x = 5;');
  }},
  {k:'JS 补全·数组反转',lang:'js',ranks:[0,1],kb:1,gen:function(){
    return mkCodeFill('补全下面 JavaScript 代码的空白处，使 r 成为 a 的反转数组。',
      'var a = [1, 2, 3];\nvar r = a.______(); // 反转数组',
      'reverse','',
      '数组方法 reverse() 会原地反转并返回该数组。');
  }},
  {k:'C 补全·累加赋值',lang:'c',ranks:[1],kb:1,gen:function(){
    return mkCodeFill('补全下面 C 代码的空白处，使 sum 成为 1 到 5 的累加和。',
      'int sum = 0;\nfor (int i = 1; i <= 5; i++)\n{\n    sum = sum ___ i;\n} /* 累加 1..5 */',
      '+=','',
      '+= 是复合赋值，sum += i 等价于 sum = sum + i。');
  }},
  {k:'C 补全·循环条件',lang:'c',ranks:[1],kb:1,gen:function(){
    return mkCodeFill('补全下面 C 代码的空白处，使循环打印 0 到 9。',
      'for (int i = 0; i ___ 10; i++)\n{\n    printf("%d ", i);\n} /* 打印 0..9 */',
      '<','',
      'i < 10 时循环继续，打印 0,1,...,9 共 10 个数。');
  }},
  {k:'JS 补全·函数返回',lang:'js',ranks:[1,2],kb:1,gen:function(){
    return mkCodeFill('补全下面 JavaScript 代码的空白处，使 add 返回两数之和。',
      'function add(a, b) {\n  return a ___ b;\n}',
      '+','',
      '+ 把两个参数相加后返回。');
  }},
  {k:'C 补全·数组下标',lang:'c',ranks:[2],kb:1,gen:function(){
    return mkCodeFill('补全下面 C 代码的空白处，使循环正序打印数组每个元素。',
      'int arr[] = {3, 1, 4};\nfor (int i = 0; i < 3; i++)\n{\n    printf("%d ", arr[___]);\n}',
      'i','',
      '用下标 i 访问元素 arr[i]，i 从 0 到 2 正序遍历。');
  }},
  {k:'JS 补全·字符串长度',lang:'js',ranks:[2,3],kb:1,gen:function(){
    return mkCodeFill('补全下面 JavaScript 代码的空白处，使 n 等于字符串 s 的长度。',
      'var s = "hello";\nvar n = s.______; // 字符串长度',
      'length','',
      '字符串的 length 属性给出字符个数。');
  }},
  {k:'C 补全·取地址',lang:'c',ranks:[3],kb:1,gen:function(){
    return mkCodeFill('补全下面 C 代码的空白处，使指针 p 指向变量 x。',
      'int x = 10;\nint *p = ___; /* p 指向 x */',
      '&x','',
      '& 是取地址符，&x 得到 x 的地址赋给指针 p。');
  }},
  {k:'JS 补全·对象属性',lang:'js',ranks:[3,4],kb:1,gen:function(){
    return mkCodeFill('补全下面 JavaScript 代码的空白处，使 v 等于对象 o 的 name 属性值。',
      'var o = { name: "Tom" };\nvar v = o.______; // 取出 name 的值',
      'name','',
      '用点号 o.name 访问对象属性。');
  }},
  {k:'C 补全·阶乘递归',lang:'c',ranks:[4],kb:1,gen:function(){
    return mkCodeFill('补全下面 C 代码的空白处，使 fact 正确计算 n 的阶乘。',
      'int fact(int n)\n{\n    if (n <= 1)\n    {\n        return 1;\n    }\n    return n ___ fact(n - 1);\n} /* 阶乘 */',
      '*','',
      'n! = n × (n-1)!，所以返回 n * fact(n-1)。');
  }}
];

/* 矩阵辅助函数（定义于 CODE_TOPICS 之后） */
function bitsFlip(b){var s=(b==='0'?'1':'0');return b.slice(1)+s;}
function bitsFlip2(b){var s=b.charAt(0)==='1'?'0':'1';return s+b.slice(1);}
function randBits(len){var s='';for(var i=0;i<len;i++)s+=(Math.random()<0.5?'0':'1');return s;}
function squareSumOdd(n){var s=0;for(var i=1;i<=n;i++)if(i%2) s+=i;return s;}
function pickAlts(ans,cands){
  var seen={},out=[],a=String(ans);
  seen[a]=1;
  (cands||[]).forEach(function(c){c=String(c);if(!seen[c]&&out.length<3){seen[c]=1;out.push(c);}});
  var pad=0;
  while(out.length<3){var p='#'+pad;if(!seen[p]){seen[p]=1;out.push(p);}pad++;}
  return out;
}

/* 程序编写板块组题：按已掌握语言过滤，档位不够时相邻档补齐，绝不空题 */
QA_TYPES.code.genSection=function(n,diff,sec){
  n=Math.max(1,n|0);
  var dd=(typeof diff==='number'&&diff>=0&&diff<5)?diff:0;
  /* 板块由调用方传进来（vm 直跑引擎时没有 qaSection 这个全局） */
  var _sec=(typeof sec==='string')?sec:'';
  if(!_sec&&typeof qaSection==='string')_sec=qaSection;
  var allowed=codeAllowedLangs();
  /* useLang=true 按已掌握语言过滤；false 忽略语言（选择题补池用） */
  function poolWith(useLang){
    function poolFor(d){
      return CODE_TOPICS.filter(function(t){
        return t.ranks.indexOf(d)>=0 && (!useLang||!allowed||allowed.indexOf(t.lang)>=0);
      });
    }
    var p=poolFor(dd);
    if(p.length<2){
      var alt=[dd-1,dd+1,dd-2,dd+2];
      for(var i=0;i<alt.length;i++){
        if(alt[i]<0||alt[i]>4)continue;
        p=p.concat(poolFor(alt[i]));
        if(p.length>=4)break;
      }
    }
    return p;
  }
  var out=[],seen={};
  function qk(q){return q.q+'\u0001'+(q.code||'');}
  /* C3：选择题板块只收自带选项的题 —— mkCodeFill 生成的是填空题（opts=null），
     放进「选择题」会退化成输入框，与板块承诺不符 */
  function pickable(q){
    if(!q||!q.q||q.a==null)return false;
    if(_sec==='choice'&&!(q.opts&&q.opts.length>=2))return false;
    return true;
  }
  function fill(pool,cap){
    var guard=0;
    while(out.length<n&&pool.length&&guard++<cap){
      var t=pool[riN(0,pool.length-1)],q=null;
      try{q=t.gen();}catch(e){continue;}
      if(!pickable(q)||seen[qk(q)])continue;
      q.tag=q.tag||t.lang||t.k;
      seen[qk(q)]=1;out.push(q);
    }
  }
  fill(poolWith(true),1500);
  /* 旧随机池兜底只留给非选择题板块：POOLS.code 的硬凑干扰项不再进选择题 */
  if(out.length<n&&_sec!=='choice'){
    var more=QA_TYPES.code.gen(n-out.length,dd);
    more.forEach(function(q){
      if(out.length>=n||!q||seen[qk(q)])return;
      seen[qk(q)]=1;out.push(q);
    });
  }
  return out.slice(0,n);
};
/* ===== 手写代码题（AI 评判用，题面与样例都在本地生成） ===== */
var CODE_TASKS=[
  {r:0,lang:'js',t:'用 JavaScript 写一个函数 sum(a, b)，返回两个数之和。',ex:'sum(2, 3) → 5',tip:'直接返回 a + b',
   sol:'function sum(a, b) { return a + b; }',
   steps:['函数需要把两个参数加起来','直接 return a + b 即可']},
  {r:0,lang:'js',t:'用 JavaScript 写一个函数 maxOf(a, b)，返回较大的那个数。',ex:'maxOf(4, 9) → 9',tip:'比较两个数',
   sol:'function maxOf(a, b) { return a > b ? a : b; }',
   steps:['比较 a 和 b 的大小','哪个大返回哪个：a > b 则返回 a，否则返回 b']},
  {r:0,lang:'js',t:'用 JavaScript 写一个函数 minOf(a, b)，返回较小的那个数。',ex:'minOf(4, 9) → 4',tip:'比较两个数、保留较小的那个',
   sol:'function minOf(a, b) { return a < b ? a : b; }',
   steps:['比较 a 和 b 的大小','哪个小返回哪个：a < b 则返回 a，否则返回 b']},
  {r:0,lang:'js',t:'用 JavaScript 写一个函数 absVal(n)，返回 n 的绝对值。',ex:'absVal(-7) → 7',tip:'负数取相反数、非负原样返回',
   sol:'function absVal(n) { return n < 0 ? -n : n; }',
   steps:['绝对值：负数取相反数，非负数不变','判断 n < 0 时返回 -n，否则返回 n']},
  {r:0,lang:'js',t:'用 JavaScript 写一个函数 isPositive(n)，n 为正数返回 true，否则返回 false。',ex:'isPositive(-3) → false',tip:'与 0 比较',
   sol:'function isPositive(n) { return n > 0; }',
   steps:['正数就是大于 0','直接返回 n > 0 的结果']},
  {r:1,lang:'js',t:'用 JavaScript 写一个函数 isEven(n)，n 是偶数返回 true，否则返回 false。',ex:'isEven(7) → false',tip:'用取余判断',
   sol:'function isEven(n) { return n % 2 === 0; }',
   steps:['偶数能被 2 整除','n % 2 === 0 就是偶数，直接返回']},
  {r:1,lang:'js',t:'用 JavaScript 写一个函数 reverseStr(s)，返回反转后的字符串。',ex:'reverseStr("abc") → "cba"',tip:'循环或内置反转',
   sol:'function reverseStr(s) { return s.split("").reverse().join(""); }',
   steps:['字符串不能直接反转','先 split("") 拆成字符数组','reverse() 反转','join("") 拼回字符串']},
  {r:1,lang:'js',t:'用 JavaScript 写一个函数 repeatStr(s, n)，返回把 s 重复 n 次的字符串。',ex:'repeatStr("ab", 3) → "ababab"',tip:'循环拼接或字符串乘法',
   sol:'function repeatStr(s, n) { var r = ""; for (var i = 0; i < n; i++) r += s; return r; }',
   steps:['准备一个空字符串','循环 n 次，每次都把 s 拼进去','返回拼接结果']},
  {r:1,lang:'js',t:'用 JavaScript 写一个函数 countVowels(s)，统计元音字母 a/e/i/o/u 的个数。',ex:'countVowels("hello") → 2',tip:'遍历每个字符逐个判断',
   sol:'function countVowels(s) { var n = 0; for (var i = 0; i < s.length; i++) { if ("aeiou".indexOf(s[i].toLowerCase()) >= 0) n++; } return n; }',
   steps:['准备计数器 n=0','遍历每个字符（先转小写）','是 a/e/i/o/u 之一就 n++','返回 n']},
  {r:1,lang:'js',t:'用 JavaScript 写一个函数 factorial(n)，返回 n 的阶乘（0 的阶乘是 1）。',ex:'factorial(5) → 120',tip:'递推 n × (n−1)!，边界 0! = 1',
   sol:'function factorial(n) { if (n <= 1) return 1; return n * factorial(n - 1); }',
   steps:['阶乘：n! = n × (n-1)!','边界：0! = 1，1! = 1','n <= 1 返回 1','否则递归 n * factorial(n-1)']},
  {r:2,lang:'js',t:'用 JavaScript 写一个函数 countChar(s, c)，统计字符 c 在 s 中出现的次数。',ex:'countChar("banana", "a") → 3',tip:'遍历计数',
   sol:'function countChar(s, c) { var n = 0; for (var i = 0; i < s.length; i++) { if (s[i] === c) n++; } return n; }',
   steps:['准备计数器 n=0','遍历 s 的每个字符','与 c 相等就 n++','返回 n']},
  {r:2,lang:'js',t:'用 JavaScript 写一个函数 fib(n)，返回斐波那契数列第 n 项（1, 1, 2, 3, 5 …）。',ex:'fib(6) → 8',tip:'递推或递归',
   sol:'function fib(n) { var a = 1, b = 1; for (var i = 3; i <= n; i++) { var t = a + b; a = b; b = t; } return b; }',
   steps:['斐波那契：每一项 = 前两项之和','第 1、2 项都是 1','从第 3 项起循环递推 a+b','循环到第 n 项返回']},
  {r:2,lang:'js',t:'用 JavaScript 写一个函数 isPrime(n)，n 是素数返回 true，否则返回 false。',ex:'isPrime(7) → true',tip:'从 2 试除到 √n，小于 2 直接 false',
   sol:'function isPrime(n) { if (n < 2) return false; for (var i = 2; i * i <= n; i++) { if (n % i === 0) return false; } return true; }',
   steps:['小于 2 不是素数','从 2 试除到 √n（i*i <= n）','能整除就不是素数','都除不尽就是素数']},
  {r:2,lang:'js',t:'用 JavaScript 写一个函数 reverseArr(a)，返回反转后的数组。',ex:'reverseArr([1,2,3]) → [3,2,1]',tip:'首尾交换或倒序复制',
   sol:'function reverseArr(a) { return a.slice().reverse(); }',
   steps:['注意别改原数组','先 slice() 复制一份','reverse() 反转后返回']},
  {r:2,lang:'js',t:'用 JavaScript 写一个函数 gcd(a, b)，返回 a 与 b 的最大公约数。',ex:'gcd(12, 18) → 6',tip:'辗转相除法：gcd(a,b)=gcd(b,a%b)',
   sol:'function gcd(a, b) { while (b) { var t = a % b; a = b; b = t; } return a; }',
   steps:['辗转相除法：gcd(a,b)=gcd(b, a%b)','循环到 b 为 0','每轮：t=a%b，a=b，b=t','b 为 0 时 a 就是答案']},
  {r:3,lang:'js',t:'用 JavaScript 写一个函数 twoSum(nums, target)，返回和为 target 的两个元素下标（数组返回）。',ex:'twoSum([2, 7, 11, 15], 9) → [0, 1]',tip:'哈希表可做到 O(n)',
   sol:'function twoSum(nums, target) { var m = {}; for (var i = 0; i < nums.length; i++) { var d = target - nums[i]; if (m[d] != null) return [m[d], i]; m[nums[i]] = i; } return []; }',
   steps:['遍历时记录每个数的下标','对当前数求补数 d = target - nums[i]','补数在记录里就返回两个下标','不在就把当前数记进去']},
  {r:3,lang:'js',t:'用 JavaScript 写一个函数 isPalindrome(s)，忽略大小写与非字母数字字符，判断是否回文。',ex:'isPalindrome("A man, a plan") → false',tip:'双指针或反转后比较',
   sol:'function isPalindrome(s) { s = s.toLowerCase().replace(/[^a-z0-9]/g, ""); for (var i = 0, j = s.length - 1; i < j; i++, j--) { if (s[i] !== s[j]) return false; } return true; }',
   steps:['先清洗：转小写、去掉非字母数字','用双指针 i 从前往后、j 从后往前','对应字符不等就不是回文','走完都是相等的就是回文']},
  {r:3,lang:'js',t:'用 JavaScript 写一个函数 firstUnique(s)，返回第一个只出现一次的字符，没有则返回 null。',ex:'firstUnique("aabcc") → "b"',tip:'先计数，再按原顺序找第一个计数为 1 的',
   sol:'function firstUnique(s) { var c = {}; for (var i = 0; i < s.length; i++) c[s[i]] = (c[s[i]] || 0) + 1; for (var i = 0; i < s.length; i++) { if (c[s[i]] === 1) return s[i]; } return null; }',
   steps:['第一遍遍历统计每个字符出现次数','第二遍按原顺序找','第一个计数为 1 的字符就是答案','没有就返回 null']},
  {r:3,lang:'js',t:'用 JavaScript 写一个函数 mySqrt(n)，返回 n 的整数平方根（向下取整）。',ex:'mySqrt(8) → 2',tip:'二分或从 0 递增到 i*i>n',
   sol:'function mySqrt(n) { var x = 0; while ((x + 1) * (x + 1) <= n) x++; return x; }',
   steps:['从 0 开始递增','下一个数的平方还 <= n 就继续','第一个平方超过 n 的数减 1','或直接用二分更高效']},
  {r:3,lang:'js',t:'用 JavaScript 写一个函数 longestWord(s)，返回句子中最长的单词（长度相同取靠前的）。',ex:'longestWord("I love coding") → "coding"',tip:'按空格拆分后逐个比长度',
   sol:'function longestWord(s) { var w = ""; s.split(" ").forEach(function(t) { if (t.length > w.length) w = t; }); return w; }',
   steps:['按空格拆分成单词数组','逐个比较长度','只更新比当前更长的（长度相同不动）','返回最长单词']},
  {r:4,lang:'js',t:'用 JavaScript 写一个函数 flatten(arr)，把任意层嵌套数组展平成一维数组。',ex:'flatten([1, [2, [3]]]) → [1, 2, 3]',tip:'递归处理嵌套',
   sol:'function flatten(arr) { var out = []; arr.forEach(function(x) { if (Array.isArray(x)) out = out.concat(flatten(x)); else out.push(x); }); return out; }',
   steps:['遍历每个元素','是数组就递归展平后拼接','不是数组直接放进结果','递归出口：元素不是数组']},
  {r:4,lang:'js',t:'用 JavaScript 写一个函数 maxSubArray(nums)，返回连续子数组的最大和。',ex:'maxSubArray([-2, 1, -3, 4, -1, 2, 1]) → 6',tip:'Kadane 算法：当前和转负就重新起头',
   sol:'function maxSubArray(nums) { var best = nums[0], cur = 0; for (var i = 0; i < nums.length; i++) { cur = Math.max(nums[i], cur + nums[i]); best = Math.max(best, cur); } return best; }',
   steps:['Kadane 算法：边遍历边累加','当前和加这个数反而变小就重新从它开始','每步更新历史最大和','遍历完的最大和就是答案']},
  {r:4,lang:'js',t:'用 JavaScript 写一个函数 mergeSorted(a, b)，合并两个已升序排列的数组，结果仍升序。',ex:'mergeSorted([1,3,5],[2,4]) → [1,2,3,4,5]',tip:'双指针归并，比到一方走完再补齐',
   sol:'function mergeSorted(a, b) { var out = [], i = 0, j = 0; while (i < a.length && j < b.length) { if (a[i] < b[j]) out.push(a[i++]); else out.push(b[j++]); } while (i < a.length) out.push(a[i++]); while (j < b.length) out.push(b[j++]); return out; }',
   steps:['双指针 i、j 分别指向两个数组','谁小谁先放进结果并前进','一方走完后把另一方剩余全部拼上','结果自然有序']},
  {r:4,lang:'js',t:'用 JavaScript 写一个函数 evalRPN(tokens)，计算逆波兰表达式（数组里是数字字符串与 + - * / 运算符）。',ex:'evalRPN(["2","1","+","3","*"]) → 9',tip:'栈：遇数入栈、遇运算符弹出两个数',
   sol:'function evalRPN(tokens) { var st = []; tokens.forEach(function(t) { if (t === "+" || t === "-" || t === "*" || t === "/") { var b = +st.pop(), a = +st.pop(); st.push(t === "+" ? a + b : t === "-" ? a - b : t === "*" ? a * b : Math.trunc(a / b)); } else { st.push(t); } }); return st[0]; }',
   steps:['准备一个栈','遇到数字就入栈','遇到运算符弹出栈顶两个数（注意顺序：a 是先入的）','算出结果再入栈，最后栈顶就是答案']},
  {r:4,lang:'js',t:'用 JavaScript 写一个函数 hasDupe(a)，数组里有重复元素返回 true，否则返回 false。',ex:'hasDupe([1,2,1]) → true',tip:'哈希集合或双重循环',
   sol:'function hasDupe(a) { var s = {}; for (var i = 0; i < a.length; i++) { if (s[a[i]]) return true; s[a[i]] = 1; } return false; }',
   steps:['用哈希记录见过的元素','遍历时先查是否已存在','存在就是重复，返回 true','没有重复返回 false']},
/* ---- rank 0 · 顺序结构 / 输入输出 ---- */
{r:0,lang:'c',c:1,t:'用 C 语言写一行代码，用 printf 输出数字 5。',ex:'输出：5',tip:'printf + %d',
 sol:'#include <stdio.h>\n\nint main(void)\n{\n    printf("%d", 5);\n    return 0;\n}',
 steps:['printf 的 %d 占位符对应一个整数','把 5 填进去：printf("%d", 5);','写完语句别忘了结尾分号']},
{r:0,lang:'c',c:1,t:'用 C 语言声明 int 变量 x 并赋值为 3，然后输出它。',ex:'x 的值是 3',tip:'类型 变量名 = 值;',
 sol:'#include <stdio.h>\n\nint main(void)\n{\n    int x = 3;\n    printf("%d", x);\n    return 0;\n}',
 steps:['先写类型 int','再写变量名 x，用 = 赋初值 3，结尾分号','printf("%d", x) 输出这个变量']},
{r:0,lang:'c',c:1,t:'用 C 语言让 int 变量 a（初值 1）自增 1，并输出结果。',ex:'a 的值 +1 → 输出 2',tip:'a++ 或 a += 1',
 sol:'#include <stdio.h>\n\nint main(void)\n{\n    int a = 1;\n    a++;\n    printf("%d", a);\n    return 0;\n}',
 steps:['自增就是 a = a + 1','简写 a++ 或 a += 1 都行','自增后再 printf 才是新值']},
{r:0,lang:'c',c:1,t:'用 C 语言写一段代码：x 大于 0 时输出「正数」。',ex:'x=1 时输出 正数',tip:'if (x > 0)',
 sol:'#include <stdio.h>\n\nint main(void)\n{\n    int x = 1;\n    if (x > 0)\n    {\n        printf("正数");\n    }\n    return 0;\n}',
 steps:['if 条件判断 x > 0','成立就执行花括号里的 printf','按 C 规范左花括号另起一行']},
{r:0,lang:'c',c:1,t:'用 C 语言写一段代码：x 是偶数输出「偶」，否则输出「奇」。',ex:'x=4 输出 偶，x=3 输出 奇',tip:'x % 2 == 0 判断奇偶',
 sol:'#include <stdio.h>\n\nint main(void)\n{\n    int x = 4;\n    if (x % 2 == 0)\n    {\n        printf("偶");\n    }\n    else\n    {\n        printf("奇");\n    }\n    return 0;\n}',
 steps:['x % 2 == 0 是偶数，否则是奇数','if 处理偶数，else 处理奇数','两个分支都要有花括号']},

/* ---- rank 1 · 循环结构 / 多分支 ---- */
{r:1,lang:'c',c:1,t:'用 C 语言写一段代码：用 for 循环打印 1 到 5（数字连在一起）。',ex:'输出 12345',tip:'for (i = 1; i <= 5; i++)',
 sol:'#include <stdio.h>\n\nint main(void)\n{\n    int i;\n    for (i = 1; i <= 5; i++)\n    {\n        printf("%d", i);\n    }\n    return 0;\n}',
 steps:['for 三部分：初值 i=1、条件 i<=5、步进 i++','循环体 printf 打印 i','C89 风格把 int i 声明在 for 外面']},
{r:1,lang:'c',c:1,t:'用 C 语言写一段代码：用 while 循环把 1 加到 n，结果存 sum（n 已声明）。',ex:'n=3 时 sum=6',tip:'while (i <= n)',
 sol:'#include <stdio.h>\n\nint main(void)\n{\n    int n = 3;\n    int i = 1;\n    int sum = 0;\n    while (i <= n)\n    {\n        sum += i;\n        i++;\n    }\n    printf("%d", sum);\n    return 0;\n}',
 steps:['计数器 i 从 1 开始，sum 从 0 开始','sum 累加 i 后 i 自增','i > n 时循环结束']},
{r:1,lang:'c',c:1,t:'用 C 语言写一段代码：x 在 60 到 100 之间（含）输出「及格」。',ex:'x=70 输出 及格',tip:'x >= 60 && x <= 100',
 sol:'#include <stdio.h>\n\nint main(void)\n{\n    int x = 70;\n    if (x >= 60 && x <= 100)\n    {\n        printf("及格");\n    }\n    return 0;\n}',
 steps:['两个条件都要满足，用 && 连接','写成 x >= 60 && x <= 100','&& 两侧各留一个空格']},
{r:1,lang:'c',c:1,t:'用 C 语言写一段代码：用 do-while 循环打印 1 到 3。',ex:'输出 123',tip:'do { … } while (i <= 3);',
 sol:'#include <stdio.h>\n\nint main(void)\n{\n    int i = 1;\n    do\n    {\n        printf("%d", i);\n        i++;\n    } while (i <= 3);\n    return 0;\n}',
 steps:['do-while 先执行一次再判断条件','循环体后要写 while (条件); 结尾带分号','i 每次自增，到 4 时退出']},
{r:1,lang:'c',c:1,t:'用 C 语言写一段代码：level 为 1/2/3 时分别输出「一等奖」「二等奖」「三等奖」，其它输出「未获奖」。',ex:'level=2 输出 二等奖',tip:'switch + case + break',
 sol:'#include <stdio.h>\n\nint main(void)\n{\n    int level = 2;\n    switch (level)\n    {\n    case 1:\n        printf("一等奖");\n        break;\n    case 2:\n        printf("二等奖");\n        break;\n    case 3:\n        printf("三等奖");\n        break;\n    default:\n        printf("未获奖");\n    }\n    return 0;\n}',
 steps:['switch 按 level 的值跳到对应 case','每个 case 结束要 break，否则会继续往下执行','其它情况用 default']},

/* ---- rank 2 · 数组与字符串 ---- */
{r:2,lang:'c',c:1,t:'用 C 语言写一段代码：求 int 数组 a[5] 所有元素之和。',ex:'a={1,2,3,4,5} → 15',tip:'for 遍历 + 累加',
 sol:'#include <stdio.h>\n\nint main(void)\n{\n    int a[5] = {1, 2, 3, 4, 5};\n    int i;\n    int sum = 0;\n    for (i = 0; i < 5; i++)\n    {\n        sum += a[i];\n    }\n    printf("%d", sum);\n    return 0;\n}',
 steps:['sum 初值 0','下标从 0 到 4 遍历，累加 a[i]','循环结束后输出 sum']},
{r:2,lang:'c',c:1,t:'用 C 语言写一段代码：统计 int 数组 a[5] 中大于 0 的元素个数。',ex:'a={-1,3,0,7,-2} → 2',tip:'if (a[i] > 0) count++',
 sol:'#include <stdio.h>\n\nint main(void)\n{\n    int a[5] = {-1, 3, 0, 7, -2};\n    int i;\n    int count = 0;\n    for (i = 0; i < 5; i++)\n    {\n        if (a[i] > 0)\n        {\n            count++;\n        }\n    }\n    printf("%d", count);\n    return 0;\n}',
 steps:['count 初值 0','遍历数组，大于 0 才 count++','注意 0 不算正数']},
{r:2,lang:'c',c:1,t:'用 C 语言写一段代码：求 int 数组 a[5] 的最大值（不调用库函数）。',ex:'a={3,9,2,7,5} → 9',tip:'max 先取 a[0]，再逐个比较',
 sol:'#include <stdio.h>\n\nint main(void)\n{\n    int a[5] = {3, 9, 2, 7, 5};\n    int i;\n    int max = a[0];\n    for (i = 1; i < 5; i++)\n    {\n        if (a[i] > max)\n        {\n            max = a[i];\n        }\n    }\n    printf("%d", max);\n    return 0;\n}',
 steps:['max 先设为第一个元素','从第二个元素开始比较','更大就更新 max']},
{r:2,lang:'c',c:1,t:'用 C 语言写一段代码：把字符串 s 逆序输出（不修改原串）。',ex:'s="abc" → cba',tip:'strlen + 从末尾倒着打印',
 sol:'#include <stdio.h>\n#include <string.h>\n\nint main(void)\n{\n    char s[] = "abc";\n    int i;\n    for (i = (int)strlen(s) - 1; i >= 0; i--)\n    {\n        printf("%c", s[i]);\n    }\n    return 0;\n}',
 steps:['strlen(s) 得到长度','下标从 len-1 递减到 0','%c 打印单个字符']},
{r:2,lang:'c',c:1,t:'用 C 语言写一段代码：判断字符串 s 是否为回文（如 level）。',ex:'s="level" → 是回文',tip:'双下标向中间夹',
 sol:'#include <stdio.h>\n#include <string.h>\n\nint main(void)\n{\n    char s[] = "level";\n    int i = 0;\n    int j = (int)strlen(s) - 1;\n    int ok = 1;\n    while (i < j)\n    {\n        if (s[i] != s[j])\n        {\n            ok = 0;\n            break;\n        }\n        i++;\n        j--;\n    }\n    printf("%s", ok ? "是回文" : "不是回文");\n    return 0;\n}',
 steps:['左下标 i 从 0、右下标 j 从末尾','对应字符不等就标记失败并 break','全部相等才是回文']},

/* ---- rank 3 · 函数与指针 ---- */
{r:3,lang:'c',c:1,t:'用 C 语言写函数 int maxOf(int a, int b)，返回较大的数。',ex:'maxOf(4, 9) → 9',tip:'if 比较后 return',
 sol:'#include <stdio.h>\n\nint maxOf(int a, int b)\n{\n    if (a > b)\n    {\n        return a;\n    }\n    return b;\n}\n\nint main(void)\n{\n    printf("%d", maxOf(4, 9));\n    return 0;\n}',
 steps:['函数名、参数类型、返回类型要写全','a > b 就返回 a','否则返回 b']},
{r:3,lang:'c',c:1,t:'用 C 语言写函数 void swap(int *a, int *b)，交换两个变量的值。',ex:'x=3,y=7 → 交换后 x=7,y=3',tip:'用临时变量 + 指针解引用',
 sol:'#include <stdio.h>\n\nvoid swap(int *a, int *b)\n{\n    int t = *a;\n    *a = *b;\n    *b = t;\n}\n\nint main(void)\n{\n    int x = 3;\n    int y = 7;\n    swap(&x, &y);\n    printf("%d %d", x, y);\n    return 0;\n}',
 steps:['先用临时变量保存 *a','把 *b 赋给 *a，再把临时值赋给 *b','调用时传地址：swap(&x, &y)']},
{r:3,lang:'c',c:1,t:'用 C 语言写函数 int sumArray(const int *a, int n)，返回数组前 n 个元素之和。',ex:'a={1,2,3,4}, n=4 → 10',tip:'指针当数组用 a[i]',
 sol:'#include <stdio.h>\n\nint sumArray(const int *a, int n)\n{\n    int i;\n    int sum = 0;\n    for (i = 0; i < n; i++)\n    {\n        sum += a[i];\n    }\n    return sum;\n}\n\nint main(void)\n{\n    int a[4] = {1, 2, 3, 4};\n    printf("%d", sumArray(a, 4));\n    return 0;\n}',
 steps:['const 表示函数内不改数组内容','用 a[i] 访问第 i 个元素','累加后 return']},
{r:3,lang:'c',c:1,t:'用 C 语言写函数 int countChar(const char *s, char c)，统计字符 c 在 s 中出现的次数。',ex:'countChar("banana", \'a\') → 3',tip:'遍历到 \'\\0\' 结束',
 sol:'#include <stdio.h>\n\nint countChar(const char *s, char c)\n{\n    int i;\n    int count = 0;\n    for (i = 0; s[i] != \'\\0\'; i++)\n    {\n        if (s[i] == c)\n        {\n            count++;\n        }\n    }\n    return count;\n}\n\nint main(void)\n{\n    printf("%d", countChar("banana", \'a\'));\n    return 0;\n}',
 steps:['字符串以 \'\\0\' 结尾，循环条件写 s[i] != \'\\0\'','相等就 count++','返回 count']},
{r:3,lang:'c',c:1,t:'用 C 语言写函数 int isPrime(int n)，n 是素数返回 1，否则返回 0。',ex:'isPrime(13) → 1',tip:'试除到 sqrt(n)',
 sol:'#include <stdio.h>\n\nint isPrime(int n)\n{\n    int i;\n    if (n < 2)\n    {\n        return 0;\n    }\n    for (i = 2; i * i <= n; i++)\n    {\n        if (n % i == 0)\n        {\n            return 0;\n        }\n    }\n    return 1;\n}\n\nint main(void)\n{\n    printf("%d", isPrime(13));\n    return 0;\n}',
 steps:['小于 2 的数都不是素数','i 从 2 试到 i*i <= n','能被整除就返回 0，循环走完返回 1']},

/* ---- rank 4 · 递归 / 结构体 / 指针综合 ---- */
{r:4,lang:'c',c:1,t:'用 C 语言写递归函数 int fact(int n)，返回 n 的阶乘（0! = 1）。',ex:'fact(5) → 120',tip:'n<=1 返回 1，否则 n * fact(n-1)',
 sol:'#include <stdio.h>\n\nint fact(int n)\n{\n    if (n <= 1)\n    {\n        return 1;\n    }\n    return n * fact(n - 1);\n}\n\nint main(void)\n{\n    printf("%d", fact(5));\n    return 0;\n}',
 steps:['递归必须有终止条件：n <= 1 返回 1','否则 n * fact(n-1)','n 会一路减到 1 收口']},
{r:4,lang:'c',c:1,t:'用 C 语言写递归函数 int fib(int n)，返回斐波那契数列第 n 项（1,1,2,3,5…）。',ex:'fib(7) → 13',tip:'n<=2 返回 1',
 sol:'#include <stdio.h>\n\nint fib(int n)\n{\n    if (n <= 2)\n    {\n        return 1;\n    }\n    return fib(n - 1) + fib(n - 2);\n}\n\nint main(void)\n{\n    printf("%d", fib(7));\n    return 0;\n}',
 steps:['前两项都是 1，作为终止条件','后面每一项 = 前两项之和','递归写法简单但重复计算多']},
{r:4,lang:'c',c:1,t:'用 C 语言写函数 int gcd(int a, int b)，求最大公约数。',ex:'gcd(12, 18) → 6',tip:'辗转相除或递归',
 sol:'#include <stdio.h>\n\nint gcd(int a, int b)\n{\n    if (b == 0)\n    {\n        return a;\n    }\n    return gcd(b, a % b);\n}\n\nint main(void)\n{\n    printf("%d", gcd(12, 18));\n    return 0;\n}',
 steps:['辗转相除：gcd(a,b) = gcd(b, a%b)','b 为 0 时 a 就是最大公约数','递归收口在 b==0']},
{r:4,lang:'c',c:1,t:'用 C 语言定义结构体 struct Student（姓名 char name[20]、成绩 int score），输出成绩最高的学生姓名。',ex:'张三85 李四92 王五78 → 李四',tip:'结构体数组 + 记录最大下标',
 sol:'#include <stdio.h>\n\nstruct Student\n{\n    char name[20];\n    int score;\n};\n\nint main(void)\n{\n    struct Student list[3] = {\n        {"张三", 85},\n        {"李四", 92},\n        {"王五", 78}\n    };\n    int i;\n    int best = 0;\n    for (i = 1; i < 3; i++)\n    {\n        if (list[i].score > list[best].score)\n        {\n            best = i;\n        }\n    }\n    printf("%s", list[best].name);\n    return 0;\n}',
 steps:['struct 定义写在 main 之前','结构体数组初始化用嵌套花括号','best 记下标，最后输出 list[best].name']},
{r:4,lang:'c',c:1,t:'用 C 语言写函数 void reverseArray(int *a, int n)，原地反转数组（不新建数组）。',ex:'a={1,2,3,4,5} → 5 4 3 2 1',tip:'首尾对调，走一半就停',
 sol:'#include <stdio.h>\n\nvoid reverseArray(int *a, int n)\n{\n    int i;\n    int t;\n    for (i = 0; i < n / 2; i++)\n    {\n        t = a[i];\n        a[i] = a[n - 1 - i];\n        a[n - 1 - i] = t;\n    }\n}\n\nint main(void)\n{\n    int a[5] = {1, 2, 3, 4, 5};\n    int i;\n    reverseArray(a, 5);\n    for (i = 0; i < 5; i++)\n    {\n        printf("%d", a[i]);\n    }\n    return 0;\n}',
 steps:['交换 a[i] 与 a[n-1-i]','只需走前一半：i < n/2','原地交换，不需要额外数组']}
];
function genHandTask(rank){
  var r=(typeof rank==='number'&&rank>=0)?rank:0;
  var allowed=codeAllowedLangs();
  var pool=CODE_TASKS.filter(function(x){
    if(!allowed)return true;
    var L=x.lang||'all';
    return L==='all'||allowed.indexOf(L)>=0;
  });
  if(!pool.length)return null;                /* 当前语言没有手写题，由调用侧降级 */
  /* P0-2：手写题一局内不重复。先只在同档里挑没出过的；同档用完了向相邻档扩
     （rad 0→5），全库都出过才清空重来 —— 这样一局 10 题手写模式能拿到 10 道不同的题，
     而不是 5 道转两圈。 */
  var pick=null,rad;
  for(rad=0;rad<=5&&!pick;rad++){
    var band=pool.filter(function(x){return Math.abs(x.r-r)<=rad;});
    var freshIn=band.filter(function(x){return _handUsed.indexOf(x.t)<0;});
    if(freshIn.length)pick=freshIn[ri(freshIn.length)];
  }
  if(!pick){_handUsed.length=0;pick=pool[ri(pool.length)];}
  var t=pick;
  _handUsed.push(t.t);
  /* 解析 = 该题的「要点 + 样例」，本地拼、不调 AI：判错时至少能知道该往哪儿想。
     有 AI 的手写题还能再点「AI 解析」拿更细的讲法，没 AI 也不至于一片空白。 */
  return {q:t.t,a:'（AI 评判）',opts:null,hand:true,task:t,tag:'all',
          sol:t.sol,steps:t.steps||[],
          exp:'要点：'+(t.tip||'')+(t.ex?('　样例：'+t.ex):'')};
}
/*=== CODE_ENGINE_END ===*/
function codeQuestionnaire(cb){
  var ov=overlayPanel('💻 编程 · 知识面检测');
  ov.p.appendChild(ht('div','hint','告诉我们你学过哪些语言、大概什么水平，后面只出你勾选语言相关的题（语言无关的通用题一直都在）。可跳过。'));
  ov.p.appendChild(ht('div','section-title','① 你学过哪些语言（可多选）'));
  var sel=h('div','tagsel');var chosen={};
  var prevLangs=codeLangState().langs;
  prevLangs.forEach(function(k){chosen[k]=1;});
  var langHint=ht('div','hint','');
  function updLangHint(){
    var ks=Object.keys(chosen);
    langHint.textContent=ks.length?('已选：'+ks.map(langName).join(' / ')+'（改选后立即生效）'):('（未选 → 将出全部题，含 Java/Python/JS）');
  }
  CODE_LANGS.filter(function(l){return l.k!=='all';}).forEach(function(l){
    var pre=!!chosen[l.k];
    var b=ht('button','tagbtn'+(pre?' sel':''),l.n);b.onclick=function(){if(chosen[l.k]){delete chosen[l.k];b.classList.remove('sel');}else{chosen[l.k]=1;b.classList.add('sel');}updLangHint();};sel.appendChild(b);});
  ov.p.appendChild(sel);
  ov.p.appendChild(langHint);updLangHint();
  ov.p.appendChild(ht('div','section-title','② 你的水平（单选）'));
  var lvRow=h('div','tagsel');var level=0;
  ['🐣 入门','🚀 基础','🔧 进阶','🧠 熟练','👑 精通'].forEach(function(n,i){
    var b=ht('button','tagbtn'+(i===0?' sel':''),n);
    b.onclick=function(){level=i;[].slice.call(lvRow.children).forEach(function(x){try{x.classList.remove('sel');}catch(e){}});b.classList.add('sel');};
    lvRow.appendChild(b);
  });
  ov.p.appendChild(lvRow);
  var em=ht('div','hint','');ov.p.appendChild(em);
  var skip=h('button','btn ghost','⏭ 跳过（出全部题）');skip.style.cssText='width:100%;margin-top:6px';
  skip.onclick=function(){closeOverlay(ov);try{safeSet(CODE_PROFILE_KEY,JSON.stringify({done:true,all:true,langs:[],level:0,rank:0}));}catch(e){}cb();};
  var go=h('button','btn gold','下一步：试水测试');go.style.cssText='width:100%;margin-top:8px';
  go.onclick=function(){
    var langs=Object.keys(chosen);
    if(!langs.length){em.textContent='⚠️ 没勾选语言 → 将出全部题（含 Java/Python 等）';return;}
    try{safeSet(CODE_PROFILE_KEY,JSON.stringify({done:true,langs:langs,level:level,rank:level}));}catch(e){}
    closeOverlay(ov);codeTrial(langs,cb);
  };
  ov.p.appendChild(go);ov.p.appendChild(skip);
}
function codeTrial(langs,cb){
  var prof=getCodeProfile()||{done:true,langs:langs,rank:0};
  var allowed=langs.concat(['all']);
  /* P1-3：从入门/基础/进阶三档各抽 2 题（共 6 题，低档在前、难度递增）。
     旧版只考 POOLS.code['0'] 的 5 道入门题 —— 只要背过基础语法就能拿「精通」。 */
  var qs=[];
  [0,1,2].forEach(function(d){
    var pool=POOLS.code[String(d)]||[],tags=CODE_TAGS[String(d)]||[];
    var f=[];pool.forEach(function(it,i){if(allowed.indexOf(tags[i])>=0)f.push(it);});
    if(f.length<2)f=pool;
    shuffle(f.slice()).slice(0,2).forEach(function(p){qs.push({q:p[0],a:String(p[1]),opts:null,d:d});});
  });
  if(qs.length<6){
    qs=shuffle((POOLS.code['0']||[]).slice()).slice(0,6).map(function(p){return {q:p[0],a:String(p[1]),opts:null,d:0};});
  }
  var idx=0,answeredOK=[];
  function ask(){
    if(idx>=qs.length){
      /* 按难度加权：答对入门题算 1 分、基础 2 分、进阶 3 分，再映射到 5 个档位 */
      var w=0,tw=0;
      qs.forEach(function(q,i){tw+=(q.d+1);if(answeredOK[i])w+=(q.d+1);});
      var ratio=tw?w/tw:0;
      var r=ratio>=0.8?4:ratio>=0.6?3:ratio>=0.4?2:ratio>=0.2?1:0;
      prof.rank=r;
      try{
        safeSet(CODE_PROFILE_KEY,JSON.stringify(prof));
        setRank('code',r);
        /* 难度面板默认档读的是 bd_qa_diff_code，只写 setRank 检测结果不会生效（踩过） */
        safeSet('bd_qa_diff_code',r);
      }catch(e){}
      var ov2=overlayPanel('🎯 检测完成');
      ov2.p.appendChild(ht('div','okmsg','试水 '+qs.length+' 题（入门/基础/进阶各 2 题）答对 '+answeredOK.filter(Boolean).length+' 题 · 加权得分 '+Math.round(ratio*100)+'%'));
      ov2.p.appendChild(ht('div','okmsg','已把默认难度设为「'+levelName(r)+'」，下次进编程板块会默认停在这一档。'));
      ov2.p.appendChild(ht('div','hint','（可在 ⚙️ 设置里「重新检测」）'));
      var okb=h('button','btn gold','开始答题');okb.onclick=function(){closeOverlay(ov2);cb();};ov2.p.appendChild(okb);return;
    }
    var Q=qs[idx];var ov3=overlayPanel('🤔 试水 '+(idx+1)+'/'+qs.length+'（'+['入门','基础','进阶','熟练','精通'][Q.d]+'档）');
    ov3.p.appendChild(ht('div','qbox',esc(Q.q)));
    var ti=h('input');ti.placeholder='输入答案';ti.style.margin='8px 0';ov3.p.appendChild(ti);
    var sb=h('button','btn gold','提交');
    sb.onclick=function(){
      if(fillEqual(ti.value,Q.a))answeredOK[idx]=1;else answeredOK[idx]=0;
      idx++;closeOverlay(ov3);ask();
    };
    ov3.p.appendChild(sb);
  }
  ask();
}

/* ---------- 任务3：新建分类（AI / 免费 / 手动） ---------- */
// 已配置免费通道时，入口按钮直接说明「无需 Key」，别再把用户吓去设置里填 Key
function aiEntryLabel(){
  var cfg=loadAICfg();
  return (cfg&&cfg.url&&isFreeAI(cfg.url))?'🌐 AI 生成题库（免费通道·无需 Key）':'🌐 AI 生成题库（需配置 API）';
}
function openNewCategory(){
  var ov=overlayPanel('➕ 新建题库');
  ov.p.appendChild(ht('div','hint','输入任意分类名，自动生成题目，不再只靠手动录入。'));
  var nm=h('input');nm.placeholder='分类名，如：三角洲 / 化学 / 三国';nm.style.margin='8px 0';ov.p.appendChild(nm);
  var bAI=h('button','btn gold',aiEntryLabel());
  var bFree=h('button','btn','🆓 免费搜索生成（无需 Key）');
  var bManual=h('button','btn ghost','📝 手动录入');
  var bClose=h('button','btn ghost','取消');
  [bAI,bFree,bManual,bClose].forEach(function(b){b.style.width='100%';b.style.marginTop='8px';b.style.display='block';});
  ov.p.appendChild(bAI);ov.p.appendChild(bFree);ov.p.appendChild(bManual);ov.p.appendChild(bClose);
  bClose.onclick=function(){closeOverlay(ov);};
  bManual.onclick=function(){var v=nm.value.trim();closeOverlay(ov);openEditor(v);};
  bFree.onclick=function(){var v=nm.value.trim();if(!v){alert('请输入分类名');return;}closeOverlay(ov);freeBuild(v);};
  bAI.onclick=function(){var v=nm.value.trim();if(!v){alert('请输入分类名');return;}var cfg=loadAICfg();if(!cfg||!cfg.url||(!cfg.key&&!isFreeAI(cfg.url))){alert('尚未配置 API，请先到 ⚙️ 设置 里填写 API 地址与 Key（免费 AI 通道无需 Key）');openSettings();return;}closeOverlay(ov);aiBuild(v);};
}
function offlineBlock(card,sp,what){
  sp.textContent='📴 当前没有网络：'+what+'需要联网。已缓存的题库和刷题、错题本、成绩统计都不受影响，联网后再来即可（或改用「📝 手动录入」）。';
  var back=h('button','btn ghost','← 返回书架');back.onclick=function(){renderShelf();};card.appendChild(back);
  return true;
}
function freeBuild(name){
  showView('stage');clearNode(stageEl);
  var card=h('div','qcard');
  card.appendChild(ht('div','hud','🆓 免费搜索：'+name));
  var sp=ht('div','hint','正在抓取资料（百度百科优先，维基百科兜底）…');card.appendChild(sp);
  stageEl.appendChild(card);
  if(navigator.onLine===false){offlineBlock(card,sp,'「免费搜索建题库」');return;}
  /* 4.0.1-4：学科主题在抓资料之前就拦下 —— 以前要等百度百科 6 秒抓完、到 finishFree 才说
     「这不是考试题」，白等一场。这里直接给「配置 AI / 手动录入」两条出路。 */
  if(isAcademic(name)){
    sp.textContent='⚠️ 「'+name+'」是学科类主题，免费搜索只能生成「百科词条/书名」类检索题，不是考试题。请到 ⚙️ 设置 配置 AI（命题老师模式）生成试卷题，或用「📝 手动录入」。';
    var _mb=h('button','btn','📝 手动录入「'+name+'」');_mb.style.width='100%';_mb.style.marginTop='8px';
    _mb.onclick=function(){openEditor(name);};card.appendChild(_mb);
    var _bk=h('button','btn ghost','← 返回书架');_bk.style.width='100%';_bk.style.marginTop='8px';
    _bk.onclick=function(){renderShelf();};card.appendChild(_bk);
    return;
  }
  gatherMaterial(name,function(items){
    if(!items||items.length<4){sp.textContent='⚠️ 该主题抓不到足够资料（网络受限或词条太少），请手动录入或配置 AI（⚙️ 设置）。';var back=h('button','btn ghost','← 返回');back.onclick=function(){renderShelf();};card.appendChild(back);return;}
    finishFree(name,items,sp,card);
  });
}
// 干扰项：优先挑和正确答案长度接近的标题，选项才有迷惑性
function pickDistractors(ansTitle,titles,n){
  var cand=titles.filter(function(t){return t!==ansTitle;});
  var near=cand.filter(function(t){return Math.abs(t.length-ansTitle.length)<=4;});
  var rest=cand.filter(function(t){return near.indexOf(t)<0;}).sort(function(a,b){
    return Math.abs(a.length-ansTitle.length)-Math.abs(b.length-ansTitle.length);
  });
  var pool=(near.length>=n?near:near.concat(rest.slice(0,8))).slice(0,10);
  return shuffle(pool).slice(0,n);
}
function finishFree(name,items,sp,card){
  if(isAcademic(name)){
    sp.textContent='⚠️ 「'+name+'」是学科类主题，免费搜索只能生成「百科词条/书名」类检索题，不是考试题。请到 ⚙️ 设置 配置 AI（命题老师模式）生成试卷题，或用「📝 手动录入」。';
    var _back=h('button','btn ghost','← 返回书架');_back.onclick=function(){renderShelf();};card.appendChild(_back);
    return;
  }
  var usable=items.filter(function(x){return descOK(x.desc);});
  if(usable.length<4){sp.textContent='⚠️ 资料不足（有效条目 '+usable.length+' 条），无法生成选择题，请手动录入或配置 AI。';var back=h('button','btn ghost','← 返回');back.onclick=function(){renderShelf();};card.appendChild(back);return;}
  var qs=[],titles=usable.map(function(x){return x.title;});
  usable.forEach(function(ans){
    var others=pickDistractors(ans.title,titles,3);
    if(others.length<3)return;
    var opts=shuffle([ans.title].concat(others));
    var d=ans.desc;
    if(d.indexOf(ans.title)>=0){
      var stem=d.replace(ans.title,'____');
      if(stem.length>64)stem=stem.slice(0,64)+'…';
      qs.push({q:'补全词条：'+stem,a:ans.title,opts:opts,exp:'（百科速记，非考试题）',src:'百度百科摘要'});
    }else if(d.length<=90&&!/^(该|其|它|这|他|她|此)/.test(d)){
      // 摘要是一句完整介绍就用「描述的是哪项」；开头是「该/其/它」的指代句信息不全，跳过
      var cut=d.length>60?d.slice(0,60)+'…':d;
      qs.push({q:'「'+cut+'」描述的是下列哪项？',a:ans.title,opts:opts,exp:'（百科速记，非考试题）',src:'百度百科摘要'});
    }
  });
  qs=shuffle(qs).slice(0,20);
  if(!qs.length){sp.textContent='⚠️ 素材太少，凑不出 4 个选项，请手动录入或配置 AI。';return;}
  sp.textContent='已抓取 '+items.length+' 条素材，生成 '+qs.length+' 题'+(qs.length<8?'（该主题免费资料有限，建议配置 AI 生成更高质量的题）':'');
  previewQuestions(name,qs,card);
}
/* ---------- 4.0 自定义题库生成质量：examLike 硬过滤 + 学术主题判定 ---------- */
/* 4.0.1-4：学科范围补上文学类 —— 这些主题走免费搜索只会出百科词条题 */
var ACADEMIC_RE=/化学|物理|数学|生物|历史|地理|英语|语文|政治|文学|名著|古诗|文言文|中考|高考|九年级|人教版|初中|高中/;
function isAcademic(name){return ACADEMIC_RE.test(String(name||''));}
/* 4.0.1-1：题型。取值缺省/未知一律按 choice 处理（旧题库无 type 字段，行为不变）。
   choice=四选一；fill=填空；calc=计算；experiment=实验探究（后三者走输入框判分）。 */
var QTYPE_NAME={choice:'单选',fill:'填空',calc:'计算',experiment:'实验'};
function qTypeOf(Q){var t=Q&&Q.type;return (t==='fill'||t==='calc'||t==='experiment')?t:'choice';}
function isNonChoiceQ(Q){return qTypeOf(Q)!=='choice';}
/* 4.0.1-4：「作者是」不能无条件拦 —— 会误杀「《红楼梦》的作者是谁？」这种正常文学题；
   只有它和「出版/图书/词条」一起出现（书目元信息题）才拦。 */
var META_Q_RE=/描述的是下列哪项|出版社出版的图书|出版社|补全词条|普通高等学校本科专业|以下哪项.{0,6}(图书|专业|词条)|(作者是.{0,6}(出版|图书|词条))|第[一二三四五六七八九十]+版|九年级[上下]册/;
var META_OPT_RE=/出版社|第[一二三四五六七八九十]+版|九年级[上下]册|本科专业$/;
function examLike(q){
  if(!q||!q.q||!q.a)return false;
  if(META_Q_RE.test(String(q.q)))return false;
  if(/^补全词条/.test(String(q.q)))return false;
  if((q.opts||[]).some(function(o){return META_OPT_RE.test(String(o));}))return false;
  if(!q.exp&&!q.src)return false;   // 解析/来源至少其一（指令要求两者，放宽为 OR 以兼容免费 AI 输出）
  /* 4.0.1-1：填空/计算/实验不要求四选项，但元信息 + 解析来源两道闸照旧 */
  if(isNonChoiceQ(q))return true;
  return validItem(q);
}
/* ---------- AI 出题 prompt（aiBuild 与「边刷边补」共用同一套要求） ---------- */
function makeQuizPrompt(name,count,items){
  var material='';
  if(items&&items.length){material='参考素材（仅作知识点提示，不要照抄成题干）：\n'+items.slice(0,12).map(function(x){return '· '+x.title+'：'+(x.desc||'').slice(0,90);}).join('\n')+'\n';}
  var chemHint='';
  if(/化学/.test(String(name))){
    chemHint='本题库按「人教版九年级化学」单元组织，请围绕这些单元出题（不要出泛化的「化学」大词题）：\n'+
      '①走进化学世界 ②我们身边的空气 ③物质构成的奥秘 ④自然界的水 ⑤化学方程式 ⑥碳和碳的氧化物 ⑦燃料及其利用 ⑧金属和金属材料 ⑨溶液 ⑩酸和碱 ⑪盐和化肥 ⑫化学与生活。\n'+
      '每单元至少覆盖：概念辨析、实验操作、化学方程式、计算、图像/表格分析。\n';
  }
  /* 4.0.1-1：题型必须混排 —— 旧 prompt 写了「填空/实验/计算」但返回格式只允许四选一，
     AI 只能照抄成选择题；现在把 type 字段写进返回格式，并要求每 10 题至少 2 道非单选。 */
  var typeHint='题型（必须混排，禁止全是「下列说法正确的是」）：choice 单选 / fill 填空 / calc 计算 / experiment 实验探究，每 10 题至少 2 道非单选。\n';
  var ban='严禁出的题（一旦发现作废）：\n'+
    '· 含书名、出版社、版次（如「第3版」）、专业名（如「普通高等学校本科专业」）、词条名、作者、年份+出版物的元信息题；\n'+
    '· 「XX 描述的是下列哪项」「补全词条：____」这类百科检索/词条题；\n'+
    '· 编造的具体年份、地区、考试名（无法确认就写「中考真题改编」）。\n';
  var fmt='每题返回对象：{"type":"choice|fill|calc|experiment","q":"题干","a":"正确答案","opts":["选项1","选项2","选项3","选项4"],"exp":"解析（写步骤/方程式/易错点，计算题写算式）","src":"来源（如：人教版九年级化学第X单元 / 中考真题改编）"}。\n'+
    'type 取值：choice=四选一（opts 必须恰好 4 个互不相同的选项、且包含正确答案）；fill=填空、calc=计算、experiment=实验探究（这三种 opts 留空数组 []，由学生自己输入答案）。\n'+
    '严格只返回 JSON 数组，不要解释文字、不要 Markdown 代码块。';
  return '你是一位严谨的中学命题老师，不是百科助手。请围绕主题「'+name+'」生成 '+count+' 道中文题（不少于 '+Math.max(8,count-3)+' 道）。\n'+
    chemHint+typeHint+material+ban+
    '要求：\n0. 题干、选项、答案全部简体中文；仅代码/函数名/专有名词（如 Python、JSON）可保留英文；主题本身是英文词（如 Python）时题干必须用中文问。\n'+
    '1. 答案事实正确，拿不准宁可不出，绝不编造；同一考点不重复。\n'+
    '2. 禁止政治敏感、色情、暴力、违法内容。\n'+fmt;
}
function aiBuild(name){
  var cfg=loadAICfg();
  showView('stage');clearNode(stageEl);
  var card=h('div','qcard');card.appendChild(ht('div','hud','🌐 AI 生成：'+name));
  var sp=ht('div','hint','正在抓取素材并调用 AI 生成题库…');card.appendChild(sp);
  stageEl.appendChild(card);
  if(navigator.onLine===false){offlineBlock(card,sp,'「AI 建题库」');return;}
  gatherMaterial(name,function(items){
    // 免费通道给 15 道（后端输出上限约 1500 token），付费通道翻倍
    var prompt=makeQuizPrompt(name,isFreeAI(cfg.url)?15:30,items);
    callAI(cfg,prompt,function(res){
      if(!res||!res.length){sp.textContent='⚠️ AI 未返回有效题目（可能是网络/Key/跨域问题）。可改用「🆓 免费搜索」或手动录入。';var back=h('button','btn ghost','← 返回');back.onclick=function(){renderShelf();};card.appendChild(back);return;}
      var _raw=res.length,_ok=res.filter(examLike),_bad=_raw-_ok.length;
      sp.textContent='AI 已生成 '+_raw+' 题'+(_bad>0?'，已过滤 '+_bad+' 道百科/书目类题（缺解析来源或含书名/专业/词条）':'');
      if(!_ok.length){sp.textContent+='；均未达到考试题标准，请重试「🔄 换一批」或手动录入。';var back=h('button','btn ghost','← 返回书架');back.onclick=function(){renderShelf();};card.appendChild(back);return;}
      previewQuestions(name,_ok,card,true);
    });
  });
}
/* ---------- 边刷边补：自定义题库总量不足时静默补题 ---------- */
var REFILL_MIN=10;        // 题库总量 ≤ 此值才补（说明已经刷得差不多了）
var REFILL_TARGET=20;     // 补到多少题左右
var refillBusy=false;
/* C6：静默补题默认关闭 —— 只有用户在 ⚙️ 设置里显式打开「✨ 题库不足时自动补题」才会跑，
   否则补进去的 AI 题用户根本不知道从哪来（以前是结算后 600ms 偷偷写库）。 */
function autoRefillOn(){try{return JSON.parse(S.getItem('bt_qa_autorefill')||'false')===true;}catch(e){return false;}}
/* 4.0.1-4 +B：静默补题「宁缺毋滥」改为「降级收下」—— 缺解析/来源的题打占位入库，
   其余闸（元信息/坏选项）保持 examLike 硬过滤；显式 AI 生成入口仍走严格 examLike 不变。
   背景：examLike 的 !q.exp&&!q.src 闸会把弱模型漏带这两个字段的整批题全拒（新增 0 题），
   而补题是静默后台行为，宁可收下带占位标记的题，也不要整批丢弃。 */
function refillOk(x){
  if(!x||!x.q||!x.a)return false;
  if(!x.exp&&!x.src)x.exp='（AI 生成，暂无解析）';   // 打占位后 examLike 的 exp||src 闸必过
  return examLike(x);
}
function autoRefill(cn){
  if(!autoRefillOn())return;
  if(refillBusy)return;
  var arr=custom[cn]||[];
  if(arr.length>REFILL_MIN)return;
  var cfg=loadAICfg();
  if(!cfg||!cfg.url)return;                 // 没配 AI 就不打扰
  if(!isFreeAI(cfg.url)&&!cfg.key)return;   // 付费通道没 Key 也不打扰
  refillBusy=true;
  var per=isFreeAI(cfg.url)?15:30;
  var count=Math.max(per,Math.min(per,REFILL_TARGET-arr.length));
  if(count<5){refillBusy=false;return;}
  gatherMaterial(cn,function(items){
    callAI(cfg,makeQuizPrompt(cn,count,items),function(res){
      refillBusy=false;
      if(!res||!res.length)return;          // 失败静默，下局再试
      var exist={};arr.forEach(function(x){exist[x.q]=1;});
      /* P0-5：静默补题也必须过校验，坏题一律不入库
         4.0.1-4：补题走的是出题 prompt，只过 validItem 会把百科/书目题漏进来 → 改用 examLike
         4.0.1-4 +B：缺 exp/src 不再整批拒（弱模型常见），改由 refillOk 打占位降级收下 */
      var fresh=res.filter(function(x){return x&&x.q&&!exist[x.q]&&refillOk(x);});
      if(!fresh.length)return;
      custom[cn]=arr.concat(fresh);saveCustom(custom);
      // 书架正开着就就地刷新题量；答题/结算中绝不能调（renderShelf 里会 showView('shelf') 把用户弹回书架）
      if(shelfEl&&!shelfEl.hidden)renderShelf();
      toast('✨ 已自动补充 '+fresh.length+' 题（当前共 '+custom[cn].length+' 题）');
    });
  });
}
/* ---------- 内置分类扩充：题量不够时让 AI 补一批 ----------
   P0-5：已从「开赛 900ms 后静默写入」改为「默认不自动跑」。
   本函数保留但不再被任何自动流程调用；将来要接的话必须由用户显式点击触发（弹窗确认）。
   题量不足现在只由 doStartType 的 toast 告知实际题数，绝不偷偷写库。 */
var BUILTIN_EXTRA_TARGET=30;
var builtinRefillBusy=false;
function autoRefillBuiltin(bk,diff){
  if(!bk||bk==='code'||bk==='online')return;
  if(builtinRefillBusy||refillBusy)return;
  var T=QA_TYPES[bk];if(!T)return;
  var ds=qaDiffs(bk),cnt=(ds&&diff>=0&&ds[diff])?ds[diff].cnt:20;
  var have=(POOLS[bk]||[]).length+extraPool(bk).length;
  var target=Math.max(BUILTIN_EXTRA_TARGET,cnt);
  if(have>=target)return;                       // 本轮题量够用，不打扰
  var cfg=loadAICfg();
  if(!cfg||!cfg.url)return;                     // 没配 AI 就不打扰
  if(!isFreeAI(cfg.url)&&!cfg.key)return;       // 付费通道没 Key 也不打扰
  if(navigator.onLine===false)return;
  builtinRefillBusy=true;refillBusy=true;
  var per=isFreeAI(cfg.url)?15:30;
  var count=Math.max(6,Math.min(per,target-have));
  callAI(cfg,makeQuizPrompt(T.name,count,[]),function(res){
    builtinRefillBusy=false;refillBusy=false;
    if(!res||!res.length)return;                // 失败静默，下次再试
    var n=addExtra(bk,res.map(function(x){return {q:x.q,a:x.a,opts:(x.opts||[]).slice(0,4),d:diff,ai:true};}));
    if(!n)return;
    toast('✨ 已为「'+T.name+'」补充 '+n+' 题');
    if(shelfEl&&!shelfEl.hidden)renderShelf();
  });
}
function previewQuestions(name,qs,card,aiOk){
  var keep=[];
  function regenOne(i){
    if(!aiOk){alert('未配置 AI，无法换题。可手动「✏️ 改」或删除。');return;}
    var cfg=loadAICfg();if(!cfg||!cfg.url){alert('未配置 AI，无法换题。');return;}
    qs[i]=null;paint();
    callAI(cfg,makeQuizPrompt(name,1,[]),function(res){
      if(res&&res.length){var q=res[0];if(q&&q.q&&q.a){q.exp=q.exp||'';q.src=q.src||'';qs[i]=q;keep[i]=true;}}
      paint();
    });
  }
  function regenBatch(){
    if(!aiOk){alert('未配置 AI，无法换批。');return;}
    var cfg=loadAICfg();if(!cfg||!cfg.url){alert('未配置 AI，无法换批。');return;}
    callAI(cfg,makeQuizPrompt(name,Math.max(10,qs.length),[]),function(res){
      if(res&&res.length){qs=res.slice(0,Math.max(10,qs.length));keep=[];paint();}
    });
  }
  /* P0-5：从「只能勾选」升级为「单题可改、可删、入库前校验」。
     以前 AI 生成一道坏题，用户只能整批放弃；现在可以挑掉那一题。 */
  function paint(){
    clearNode(card);
    card.appendChild(ht('div','hud','📝 预览：'+name+'（'+qs.filter(Boolean).length+' 题）'));
    card.appendChild(ht('div','hint','勾选＝入库。单题可「✏️ 改」「🗑 删」；「🔄 换一题」由 AI 重出这一题，「🔄 换一批」重出一批；无解析/来源的题默认不勾选。〔单选〕走四选一，〔填空/计算/实验〕走输入框判分。'));
    var _tb=h('div','row');_tb.style.cssText='gap:8px;margin:6px 0;flex-wrap:wrap';
    var _b1=h('button','btn ghost','🔄 换一题');_b1.onclick=function(){var k=qs.findIndex(function(x){return x;});if(k>=0)regenOne(k);};
    var _b2=h('button','btn ghost','🔄 换一批');_b2.onclick=regenBatch;
    if(!aiOk){_b1.disabled=true;_b2.disabled=true;_b1.title=_b2.title='未配置 AI';}
    _tb.appendChild(_b1);_tb.appendChild(_b2);card.appendChild(_tb);
    qs.forEach(function(Q,i){
      if(Q==null)return;
      /* C6 修正：默认勾选只看有没有解析/来源 —— 免费搜索建的题 aiOk=false，
         但固定带「百科速记 + 百度百科摘要」，不该让用户逐题手勾 */
      if(keep[i]==null)keep[i]=!!(Q.exp||Q.src);
      var row=h('div','list-row');row.style.flexWrap='wrap';
      var chk=h('input');chk.type='checkbox';chk.checked=!!keep[i];chk.style.width='auto';
      chk.onchange=function(){keep[i]=chk.checked;};
      /* 4.0.1-1：每题标出题型，入库前一眼看出哪些是输入框题 */
      var _tyn=QTYPE_NAME[qTypeOf(Q)]||'单选';
      var lab=ht('span',null,(i+1)+'. 〔'+_tyn+'〕'+Q.q+' 〔答：'+Q.a+'〕');lab.style.flex='1';lab.style.minWidth='170px';
      var ed=h('button','btn ghost','✏️');ed.style.cssText='width:auto;padding:2px 7px;font-size:12px;flex:0 0 auto';
      ed.onclick=function(){
        var nq=prompt('改题面（取消＝不改）',Q.q);if(nq==null)return;
        var na=prompt('改答案（取消＝不改）',Q.a);if(na==null)return;
        nq=String(nq).trim();na=String(na).trim();
        if(!nq||!na){alert('题面和答案都不能为空');return;}
        var oldA=String(Q.a);
        Q.q=nq;Q.a=na;
        /* 答案改了就必须让新答案留在选项里，否则这题永远选不对 */
        if(Q.opts&&Q.opts.length){
          var oi=Q.opts.indexOf(oldA);
          if(oi>=0)Q.opts[oi]=na;
          else if(Q.opts.length<4)Q.opts.push(na);
          else Q.opts[Q.opts.length-1]=na;
        }
        paint();
      };
      var del=h('button','btn ghost','🗑');del.style.cssText='width:auto;padding:2px 7px;font-size:12px;flex:0 0 auto';
      del.onclick=function(){qs.splice(i,1);keep.splice(i,1);if(!qs.length){renderShelf();return;}paint();};
      row.appendChild(chk);row.appendChild(lab);row.appendChild(ed);row.appendChild(del);
      card.appendChild(row);
    });
    var saveB=h('button','btn gold','💾 入库并开始');saveB.onclick=function(){
      var final=[],bad=0,filtered=0;
      qs.forEach(function(Q,i){
        if(Q==null||!keep[i])return;
        if(aiOk&&!examLike(Q)){filtered++;return;}
        if(Q.opts&&Q.opts.length){
          var u={};Q.opts.forEach(function(o){u[String(o)]=1;});
          if(Q.opts.length!==4||Object.keys(u).length!==4||Q.opts.indexOf(String(Q.a))<0){bad++;return;}
        }
        final.push(Q);
      });
      if(filtered){alert('已过滤 '+filtered+' 道不合规题（缺解析/来源或含书名/专业/词条），未入库。');}
      if(bad){alert('有 '+bad+' 题选项不合规（必须 4 个互不相同、且包含答案），请「✏️ 改」或取消勾选后再入库。');return;}
      if(!final.length){alert('请至少保留一题');return;}
      if(custom[name]&&!confirm('已存在同名题库「'+name+'」，覆盖它？'))return;
      custom[name]=final;saveCustom(custom);renderShelf();startType(null,name);
    };
    card.appendChild(saveB);
    var backB=h('button','btn ghost','← 返回书架');backB.onclick=function(){renderShelf();};card.appendChild(backB);
  }
  paint();
}
/* ---------- 免费素材收集：JSONP 通道（百度百科优先，国内可用） ---------- */
function jsonp(url, cb, timeout){
  var name='__jp'+Math.floor(Math.random()*1e9)+'_'+Math.floor(Math.random()*1e6);
  var sc=document.createElement('script');
  var done=false;
  function cleanup(){
    /* 留一个空函数而不是 delete：超时后迟到的 JSONP 脚本仍会调用 __jpXXX(...)，
       delete 会让它变成未捕获 ReferenceError（慢网络下稳定复现）。 */
    try{window[name]=function(){};}catch(e){}
    if(sc.parentNode)sc.parentNode.removeChild(sc);
  }
  window[name]=function(d){if(done)return;done=true;cleanup();cb(d);};
  sc.onerror=function(){if(done)return;done=true;cleanup();cb(null);};
  sc.src=url.replace('__CB__',name);
  sc.charset='utf-8';
  document.head.appendChild(sc);
  setTimeout(function(){if(done)return;done=true;cleanup();cb(null);},timeout||6000);
}
// 百度联想词：返回相关词条名（JSONP，无需 CORS）
function baiduSuggest(term,cb){
  jsonp('https://suggestion.baidu.com/su?wd='+encodeURIComponent(term)+'&cb=__CB__',function(d){
    cb((d&&d.s&&d.s.length)?d.s:[]);
  },5000);
}
// 百度百科词条卡片：返回 {title, desc}
var SPAM_RE=/视频大全|高清在线看|价目表|官网|下载|安装教程|旗舰店|专卖店|批发|加盟|经销商|4S|报价|二手|保养|维修|有限公司|股份有限公司|怎么样|多少钱|皮卡|摩托|香烟/i;
// 联想词里的「异类词缀」：明显不是主题实体（保留下载/软件这类搜索词会把题库带偏）
var NOISE_RE=/下载|软件|app|安卓|android|ios|电影|电视剧|演员|歌手|明星|小说|漫画|破解|外挂|辅助|代练|直播|视频|淘宝|京东|拼多多|什么意思/i;
var BAD_DESC_RE=/https?:\/\/|www\.|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\b1[3-9]\d{9}\b|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
function stripTags(v){return String(v==null?'':v).replace(/<[^>]*>/g,'').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();}
// 素材质量闸门：太短 / 带网址邮箱电话 / 汉字太少（乱码）都不出题
function descOK(d){
  d=String(d||'').replace(/\s+/g,' ').trim();
  if(d.length<8)return false;
  if(BAD_DESC_RE.test(d))return false;
  if((d.match(/[\u4e00-\u9fa5]/g)||[]).length<4)return false;
  return true;
}
// 主题相关性：标题或摘要里必须出现主题词，挡掉百度联想带来的同名/跨义项词条
function isRelated(item,topic){
  if(!topic)return true;
  var t=String((item&&item.title)||''),d=String((item&&item.desc)||'');
  return t.indexOf(topic)>=0||d.indexOf(topic)>=0;
}
function baikeCard(term,cb){
  var u='https://baike.baidu.com/api/openapi/BaikeLemmaCardApi?scope=103&appid=379020&bk_length=600&format=json&bk_key='+encodeURIComponent(term)+'&callback=__CB__';
  jsonp(u,function(d){
    if(!d)return cb(null);
    var desc=stripTags(d.desc||'');
    try{(d.card||[]).forEach(function(c){if(c&&(c.key==='abstract'||c.name==='摘要')&&c.value&&String(c.value).length>desc.length)desc=stripTags(c.value);});}catch(e){}
    if(desc.length<6&&d.abstract)desc=stripTags(d.abstract);          // 摘要兜底
    if(desc.length<6){                                                  // 用信息框拼一句
      var bits=[];
      (d.card||[]).forEach(function(c){
        if(bits.length>=3)return;
        var v=stripTags((c.format&&c.format[0])||(c.value&&c.value[0])||'');
        if(v&&v.length>=2&&v.length<=26&&v!==stripTags(d.title))bits.push(c.name+'：'+v);
      });
      if(bits.length)desc=bits.join('；');
    }
    var links=[];
    try{(d.card||[]).forEach(function(c){(c.value||[]).forEach(function(v){
      var str=String(v),m=str.match(/>([^<>]{2,12})<\/a>/g);
      if(m)m.forEach(function(seg){var t=seg.slice(1).replace(/<\/a>$/,'');if(t&&links.indexOf(t)<0)links.push(t);});
    });});}catch(e){}
    cb({title:stripTags(d.title||term),desc:desc,links:links});
  },6000);
}
// 统一素材收集：百度百科主词条 → 联想词 → 信息框关联词条 → 维基兜底
function fetchCards(terms,cb,topic){
  if(!terms.length){cb([],[]);return;}
  var out=[],links=[],p=terms.length;
  terms.forEach(function(t){
    baikeCard(t,function(c){
      if(c){
        if(descOK(c.desc)&&isRelated(c,topic))out.push(c);   // 质量 + 主题相关性双闸
        if(c.links&&c.links.length)links=links.concat(c.links);
      }
      p--;if(p<=0)cb(out,links);
    });
  });
}
function gatherMaterial(name,cb){
  function wikiFallback(){
    wikiSearch(name,function(titles){
      if(!titles||!titles.length){cb([]);return;}
      var pick=titles.slice(0,12),g=[],p=pick.length;
      pick.forEach(function(t){wikiSummary(t,function(x){g.push({title:t,desc:x||''});p--;if(p<=0)cb(g);});});
    });
  }
  baiduSuggest(name,function(terms){
    var list=[],seen={};
    seen[name]=1;list.push(name); // 主词条一定在
    (terms||[]).forEach(function(t){
      if(!t||seen[t])return;
      if(SPAM_RE.test(t)||NOISE_RE.test(t))return;   // 广告词 + 异类词缀（下载/安卓/电影…）
      if(t.length>12)return;
      seen[t]=1;list.push(t);
    });
    list=list.slice(0,12);
    fetchCards(list,function(items,links){
      function finish(final){
        if(final.length>=4)cb(final);else wikiFallback();
      }
      if(items.length>=10){finish(items);return;}
      // 第二轮：用信息框里的关联词条补量（干员 / 地图 / 武器…都藏在 card 的链接里）
      // 含主题词的优先；其余也作为种子去查，真伪交给卡片层的「摘要必须提到主题」把关，
      // 这样既能收到《三角洲行动》的干员词条，也不会把「吴彦祖 / 虚幻引擎5」放进来。
      var more=[],ms={};
      function addSeed(t){
        if(!t||seen[t]||ms[t])return;
        if(SPAM_RE.test(t)||NOISE_RE.test(t))return;
        if(t.length<2||t.length>12)return;
        ms[t]=1;more.push(t);
      }
      (links||[]).forEach(function(t){if(t&&t.indexOf(name)>=0)addSeed(t);});
      (links||[]).forEach(addSeed);
      more=more.slice(0,12);
      if(!more.length){finish(items);return;}
      more.forEach(function(t){seen[t]=1;});
      fetchCards(more,function(items2){finish(items.concat(items2));},name);
    },name);
  });
}
// 免费素材源：中文维基 opensearch → 中文维基全文搜索 → Wikidata 实体（依次降级）
function wikiSearch(term,cb){
  var q=encodeURIComponent(term);
  var srcs=[
    {u:'https://zh.wikipedia.org/w/api.php?action=opensearch&search='+q+'&limit=10&format=json&origin=*',
      pick:function(d){return (d&&d[1])||[];}},
    {u:'https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch='+q+'&srlimit=8&format=json&origin=*',
      pick:function(d){var o=[];try{(d.query.search||[]).forEach(function(x){o.push(x.title);});}catch(e){}return o;}},
    {u:'https://www.wikidata.org/w/api.php?action=wbsearchentities&search='+q+'&language=zh&uselang=zh&limit=8&format=json&origin=*',
      pick:function(d){var o=[];try{(d.search||[]).forEach(function(x){if(x.label)o.push(x.label);});}catch(e){}return o;}}
  ];
  var best=[];
  (function step(i){
    if(i>=srcs.length){cb(best.length?best:null);return;}
    var ctl=null,timer=null;
    try{ctl=new AbortController();timer=setTimeout(function(){try{ctl.abort();}catch(e){}},6000);}catch(e){}
    fetch(srcs[i].u,ctl?{signal:ctl.signal}:undefined)
      .then(function(r){return r.json();})
      .then(function(d){
        if(timer)clearTimeout(timer);
        var t=srcs[i].pick(d)||[];
        if(t.length>best.length)best=t;
        if(best.length>=4){cb(best);return;}
        step(i+1);
      })
      .catch(function(){if(timer)clearTimeout(timer);step(i+1);});
  })(0);
}
function wikiSummary(title,cb){
  var u1='https://zh.wikipedia.org/api/rest_v1/page/summary/'+encodeURIComponent(title);
  var ctl=null,timer=null;
  try{ctl=new AbortController();timer=setTimeout(function(){try{ctl.abort();}catch(e){}},7000);}catch(e){}
  fetch(u1,ctl?{signal:ctl.signal}:undefined).then(function(r){return r.json();})
    .then(function(d){if(timer)clearTimeout(timer);if(d&&d.extract)cb(d.extract);else wikiSummaryFallback(title,cb);})
    .catch(function(){if(timer)clearTimeout(timer);wikiSummaryFallback(title,cb);});
}
function wikiSummaryFallback(title,cb){
  var u2='https://zh.wikipedia.org/w/api.php?action=query&prop=extracts&exintro&explaintext&titles='+encodeURIComponent(title)+'&format=json&origin=*';
  fetch(u2).then(function(r){return r.json();}).then(function(d){try{var pages=d.query.pages;for(var k in pages){if(pages[k].extract){cb(pages[k].extract);return;}}cb('');}catch(e){cb('');}}).catch(function(){cb('');});
}
function loadAICfg(){try{return JSON.parse(S.getItem('bt_qa_ai')||'null');}catch(e){return null;}}
// 模型撞上输出上限时，JSON 数组会断在半空中。这里按字符串/转义状态往前找最后一个
// 完整闭合的顶层对象，把已生成的题目打捞回来（原来只能整包扔掉、一题不剩）。
function salvageArray(text){
  var depth=0,inStr=false,esc=false,lastEnd=-1;
  for(var i=0;i<text.length;i++){
    var ch=text.charAt(i);
    if(inStr){
      if(esc)esc=false;
      else if(ch==='\\')esc=true;
      else if(ch==='"')inStr=false;
      continue;
    }
    if(ch==='"'){inStr=true;continue;}
    if(ch==='['||ch==='{'){depth++;continue;}
    if(ch===']'||ch=='}'){
      depth--;
      if(depth===1&&ch==='}')lastEnd=i;
      continue;
    }
  }
  if(lastEnd<0)return null;
  try{return JSON.parse(text.slice(0,lastEnd+1)+']');}catch(e){return null;}
}
function callAI(cfg,prompt,cb){
  var free=isFreeAI(cfg.url);
  var body={model:cfg.model||(free?'openai':'deepseek-chat'),messages:[{role:'user',content:prompt}],temperature:0.7};
  if(free)body.reasoning_effort='low';   // 否则 1500 token 全烧在 reasoning 上，content 缺失、永远解析不出题
  var url=cfg.proxy?cfg.proxy:cfg.url;
  if(!/^https?:\/\//.test(url)){cb(null);return;}
  var hd={'Content-Type':'application/json'};
  if(cfg.key)hd['Authorization']='Bearer '+cfg.key;
  /* P0-5：30s 超时 + 可中断，避免 AI 卡死且无反馈（与 callAIRaw 对齐） */
  var ctl=null,timer=null;
  try{ctl=new AbortController();timer=setTimeout(function(){try{ctl.abort();}catch(e){}},30000);}catch(e){}
  fetch(url,{method:'POST',headers:hd,body:JSON.stringify(body),signal:ctl?ctl.signal:undefined})
    .then(function(r){if(timer)clearTimeout(timer);return r.json();}).then(function(d){
      try{var content=d.choices[0].message.content;if(!content){cb(null);return;}var arr=null;
        var m=content.match(/\[[\s\S]*\]/);
        if(m){try{arr=JSON.parse(m[0]);}catch(e0){}}
        // 注意：正则只到「最后一个 ]」，会把最后一个完整对象的 } 关在匹配区外，
        // 所以打捞必须拿全文跑，不能拿 m[0] 跑（否则每局都少捞一题）。
        if(!arr)arr=salvageArray(content);
        if(!arr){cb(null);return;}
        /* 英文题（题干或选项成句英文）直接挡在题库外：解析固定用中文写，英文题进来必然错配。
           单个词 / 代码标识符放行，否则「Python 哪个关键字定义函数」这类正常题会被连坐。 */
        /* P0-5 安全闸：统一走 validItem —— 必须恰好 4 个互不相同的选项、且包含答案。
           以前只要求 opts.length>=2，2~3 个选项的坏题会一路进库。
           4.0.1-1：题型分流 —— 非选择题不校验选项，但题干/答案仍要非空。 */
        var out=arr.filter(function(x){
          if(!x||!x.q||!x.a)return false;
          if(isEnglishQ(x))return false;
          if(isNonChoiceQ(x))return !!(String(x.q).trim()&&String(x.a).trim());
          var os=(x.opts||[]).map(function(o){return String(o==null?'':o).trim();}).filter(function(o){return o!=='';});
          return validItem({a:String(x.a).trim(),opts:os});
        }).map(function(x){
          var _ty=qTypeOf(x);
          var os=(x.opts||[]).map(function(o){return String(o==null?'':o).trim();}).filter(function(o){return o!=='';});
          /* 非选择题强制清空 opts：否则会被当成四选一渲染出来 */
          return {q:x.q,a:String(x.a).trim(),opts:(_ty==='choice'?shuffle(os):null),exp:String(x.exp||'').trim(),src:String(x.src||'').trim(),type:_ty};
        });cb(out);}
      catch(e){cb(null);}
    }).catch(function(e){if(timer)clearTimeout(timer);cb(null);});
}
/* 测试连接：只验证「地址 / Key / 模型」通不通，不要求 AI 返回题目 JSON。
   判定标准 = HTTP 2xx；失败时把状态码（如 401 / 403）或「网络错误 / 超时」回给调用方，
   便于区分是 Key 无效还是网络问题。callAI（题目生成）保持原样，不受影响。 */
function testAI(cfg,cb){
  var free=isFreeAI(cfg.url);
  var url=cfg.proxy?cfg.proxy:cfg.url;
  if(!/^https?:\/\//.test(url)){cb(false,'地址无效');return;}
  var body={model:cfg.model||(free?'openai':'deepseek-chat'),messages:[{role:'user',content:'请只回复两个字：连接成功'}],temperature:0};
  if(free)body.reasoning_effort='low';
  var ctl=null,timer=null;
  try{ctl=new AbortController();timer=setTimeout(function(){try{ctl.abort();}catch(e){}},10000);}catch(e){}
  var hd={'Content-Type':'application/json'};
  if(cfg.key)hd['Authorization']='Bearer '+cfg.key;
  fetch(url,{method:'POST',headers:hd,body:JSON.stringify(body),signal:ctl?ctl.signal:undefined})
    .then(function(r){
      if(timer)clearTimeout(timer);
      if(r&&r.ok){cb(true);return;}
      cb(false,String((r&&r.status)||'未知'));
    })
    .catch(function(e){
      if(timer)clearTimeout(timer);
      if(e&&e.name==='AbortError'){cb(false,'超时');return;}
      cb(false,'网络错误');
    });
}

/* ---------- 填空判分容错 / 手写代码 AI 评判 ---------- */
var SUP_MAP={'⁰':'0','¹':'1','²':'2','³':'3','⁴':'4','⁵':'5','⁶':'6','⁷':'7','⁸':'8','⁹':'9'};
function fillNorm(s){
  s=norm(s);
  s=s.replace(/^[`'"“”‘’]+/,'').replace(/[`'"“”‘’]+$/,'');
  s=s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g,function(m){var o='^';for(var i=0;i<m.length;i++)o+=(SUP_MAP[m.charAt(i)]||'');return o;});
  return s.replace(/⁻/g,'-');
}
function fillNum(s){
  var t=String(s==null?'':s).trim().replace(/\s+/g,'');
  var m=t.match(/^(-?\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  if(m)return Number(m[1])/Number(m[2]);
  if(/^-?0x[0-9a-f]+$/i.test(t))return parseInt(t,16);
  var n=Number(t);
  return isFinite(n)?n:null;
}
/* 填空判分：忽略空格/大小写/标点，容忍上标写法（x⁴ = x^4）、分数与小数、十六进制前缀 */
function fillEqual(given,ans){
  var a=fillNorm(ans),b=fillNorm(given);
  if(a===b)return true;
  /* P1-1：十六进制必须「两边都显式写 0x」才按十六进制比较，且值要相同。
     旧写法 a.replace(/^0x/,'')===b.replace(/^0x/,'') 会把答案 0x10 和输入 10 判成相等。 */
  var _ax=/^0x/i.test(a),_bx=/^0x/i.test(b);
  if(_ax&&_bx){
    var _av=parseInt(a,16),_bv=parseInt(b,16);
    if(!isNaN(_av)&&!isNaN(_bv)&&_av===_bv)return true;
    return false;
  }
  if(_ax!==_bx)return false;   /* 一边带 0x 一边不带：格式不一致，判错（不落到数值比较） */
  var na=fillNum(a),nb=fillNum(b);
  if(na!=null&&nb!=null&&Math.abs(na-nb)<1e-9)return true;
  return false;
}
function canJudge(){var c=loadAICfg();return !!(c&&c.url&&(c.key||isFreeAI(c.url)));}
function callAIRaw(cfg,prompt,cb,ms){
  var free=isFreeAI(cfg.url);
  var url=cfg.proxy?cfg.proxy:cfg.url;
  if(!/^https?:\/\//.test(url)){cb(null,'地址无效');return;}
  var body={model:cfg.model||(free?'openai':'deepseek-chat'),messages:[{role:'user',content:prompt}],temperature:0};
  if(free)body.reasoning_effort='low';
  var hd={'Content-Type':'application/json'};
  if(cfg.key)hd['Authorization']='Bearer '+cfg.key;
  var ctl=null,timer=null;
  try{ctl=new AbortController();timer=setTimeout(function(){try{ctl.abort();}catch(e){}},ms||30000);}catch(e){}
  fetch(url,{method:'POST',headers:hd,body:JSON.stringify(body),signal:ctl?ctl.signal:undefined})
    .then(function(r){if(!r||!r.ok)throw new Error('HTTP '+((r&&r.status)||'?'));return r.json();})
    .then(function(d){
      if(timer)clearTimeout(timer);
      var t='';
      try{t=d.choices[0].message.content||'';}catch(e){}
      if(!t){cb(null,'AI 返回空内容');return;}
      cb(String(t),null);
    })
    .catch(function(e){
      if(timer)clearTimeout(timer);
      cb(null,(e&&e.name==='AbortError')?'AI 评判超时':((e&&e.message)||'AI 请求失败'));
    });
}
function parseJudge(t){
  t=String(t||'');
  // 1) 结构化 JSON 优先（AI 可能返回 {"ok":true/false,"why":...}）
  var m=t.match(/\{[\s\S]*?\}/);
  if(m){try{var o=JSON.parse(m[0]);if(o&&typeof o.ok==='boolean')return {ok:o.ok,why:String(o.why||'').slice(0,80)};}catch(e){}}
  // 2) 否定词优先：不完全正确/基本正确/部分正确/不严谨/有瑕疵/不够/不正确/错误/有 bug/失败
  if(/不完全正确|基本正确|部分正确|不严谨|有瑕疵|不够|不正确|错误|有\s*bug|失败/i.test(t))return {ok:false,why:''};
  // 3) 只有明确肯定才判 true（完全正确/全部正确/正确/通过）
  if(/完全正确|全部正确|正确|通过/i.test(t))return {ok:true,why:''};
  // 4) 不确定：不要猜，让用户重试 / 人工确认
  return null;
}
/* ============ 轻量代码编辑器（行号 + 高亮层 + 透明 textarea） ============
   不引 Monaco / CodeMirror：一块 <pre> 高亮层垫在 textarea 底下，textarea 自己的字设成透明、
   只留光标；input 时重绘高亮与行号，scroll 时把滚动量同步给高亮层和行号列。纯内联、离线可用。 */
function escH(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
/* 简化分词：注释 / 字符串 / 关键字 / 数字 / 函数名。够看懂，不做语法分析。 */
function hlCode(code){
  code=String(code==null?'':code);
  var re=/(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)|('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)|\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|import|from|export|default|true|false|null|undefined|this|typeof|instanceof|void|async|await|try|catch|finally|throw|yield|delete|def|lambda|elif|print|int|char|float|double|long|main|include|printf|scanf|True|False|None|and|or|not|in|is|static|public|private|struct|using)\b|\b(\d+(?:\.\d+)?)\b|([A-Za-z_$][\w$]*)(?=\s*\()/g;
  var out='',last=0,m;
  while((m=re.exec(code))!==null){
    out+=escH(code.slice(last,m.index));
    if(m[1])out+='<span class="t-com">'+escH(m[1])+'</span>';
    else if(m[2])out+='<span class="t-str">'+escH(m[2])+'</span>';
    else if(m[3])out+='<span class="t-kw">'+escH(m[3])+'</span>';
    else if(m[4])out+='<span class="t-num">'+escH(m[4])+'</span>';
    else out+='<span class="t-fn">'+escH(m[5])+'</span>';
    last=m.index+m[0].length;
  }
  out+=escH(code.slice(last));
  return out;
}
function codeEditor(container,ta){
  container.className='edwrap';
  var ln=h('div','edline');
  var body=h('div','edbody');
  var hl=h('pre','edhl');hl.setAttribute('aria-hidden','true');
  body.appendChild(hl);body.appendChild(ta);
  container.appendChild(ln);container.appendChild(body);
  function syncScroll(){
    try{hl.scrollTop=ta.scrollTop;ln.scrollTop=ta.scrollTop;hl.scrollLeft=ta.scrollLeft;}catch(e){}
  }
  function setCaret(pos){try{ta.selectionStart=ta.selectionEnd=pos;}catch(e){}}
  function paint(){
    var v=ta.value||'';
    /* 值以换行结尾时高亮层要多留一行，否则最后一行空行与 textarea 差一行、行号也会错位 */
    hl.innerHTML=hlCode(v)+(v.charAt(v.length-1)==='\n'?'\n':'');
    var n=v.split('\n').length,s='';
    for(var i=1;i<=n;i++)s+=i+(i<n?'\n':'');
    ln.textContent=s;
    syncScroll();
  }
  function replaceRange(a,b,txt,caret){
    ta.value=ta.value.slice(0,a)+txt+ta.value.slice(b);
    setCaret(caret);paint();
  }
  /* 多行选区整块缩进 / 反缩进（两个空格） */
  function indentBlock(on){
    var a=ta.value.lastIndexOf('\n',ta.selectionStart-1)+1;
    var b=ta.value.indexOf('\n',ta.selectionEnd);
    if(b<0)b=ta.value.length;
    var seg=ta.value.slice(a,b).split('\n');
    for(var i=0;i<seg.length;i++){
      var L=seg[i];
      if(on)seg[i]='  '+L;
      else if(L.slice(0,2)==='  ')seg[i]=L.slice(2);
      else if(L.charAt(0)===' ')seg[i]=L.slice(1);
    }
    var txt=seg.join('\n');
    ta.value=ta.value.slice(0,a)+txt+ta.value.slice(b);
    setCaret(a+txt.length);paint();
  }
  function outdentLine(){
    var st=ta.selectionStart,ls=ta.value.lastIndexOf('\n',st-1)+1;
    var head=ta.value.slice(ls,st);
    var cut=head.length>=2&&head.slice(-2)==='  '?2:(head.length>=1&&head.charAt(head.length-1)===' '?1:0);
    if(!cut)return;
    replaceRange(st-cut,st,'',st-cut);
  }
  ta.addEventListener('input',paint);
  ta.addEventListener('scroll',syncScroll);
  ta.addEventListener('keydown',function(e){
    if(!e)return;
    var st=ta.selectionStart,en=ta.selectionEnd;
    if(e.key==='Tab'){
      e.preventDefault();
      if(st!==en&&ta.value.slice(st,en).indexOf('\n')>=0){indentBlock(!e.shiftKey);return;}
      if(e.shiftKey){outdentLine();return;}
      replaceRange(st,en,'  ',st+2);return;
    }
    /* 自动补出来的右括号：光标正好停在一个 ), ], } 前面时直接跳过，别叠成两个 */
    if((e.key===')'||e.key===']'||e.key==='}')&&st===en&&ta.value.charAt(st)===e.key){
      e.preventDefault();setCaret(st+1);return;
    }
    if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){
      e.preventDefault();
      var btn=container.querySelector(e.shiftKey?'.runbtn':'.submitbtn');
      if(btn&&!btn.disabled)btn.click();
    }
  });
  ta.addEventListener('keyup',function(e){
    if(!e||e.ctrlKey||e.metaKey||e.altKey)return;
    var pairs={'(' :')','[':']','{':'}'};
    var p=pairs[e.key];
    if(!p)return;
    var st=ta.selectionStart;
    if(ta.value.charAt(st)===p)return;      /* 后面已经站着一个右括号，不重复插 */
    ta.value=ta.value.slice(0,st)+p+ta.value.slice(st);
    setCaret(st);paint();
  });
  paint();
  return ta;
}

/* ---------- JS 本地运行自测 ---------- */
/* 归一化：数组转紧凑 JSON，其余转字符串，全部去空白后再比对 */
function normOut(v){
  if(Array.isArray(v))return JSON.stringify(v).replace(/\s/g,'');
  return String(v==null?'':v).replace(/\s/g,'');
}
/* 在 Worker 里跑用户代码：死循环能被打断（4 秒），主线程不卡。
   normOut 直接取函数源码内联进去，避免两份实现走偏。 */
var RUN_WORKER_SRC='var normOut='+normOut.toString()+';'
 +'self.onmessage=function(e){var d=e.data,logs=[],old=console.log;'
 +'console.log=function(){logs.push([].slice.call(arguments).join(" "));};'
 +'var out,err="";'
 +'try{out=new Function(d.code+"\\n;return ("+d.call+");")();}catch(x){err=String((x&&x.message)||x);}'
 +'console.log=old;'
 +'var disp="";try{disp=normOut(out);}catch(y){}'
 +'self.postMessage({disp:disp,err:err,logs:logs});};';
/* 「▶ 运行自测」：取样例里「→」左边的调用注入执行，与右边期望值对比。
   只对 JS 写法有效（浏览器里只能跑 JS）；C / Python 报错时提示改用 AI 评判，不阻塞提交。 */
function runSelfTest(Q,code,msgEl){
  if(!msgEl)return;
  clearNode(msgEl);msgEl.className='hint';
  code=String(code==null?'':code);
  if(!code.trim()){msgEl.appendChild(ht('div','hint2','⚠️ 还没写代码'));return;}
  /* C 题没有「调用 → 期望值」样例，硬跑只会得到 `Function statements require a function name`
     这种 JS 语法错，纯误导。直接给出正确指引。 */
  if(Q&&Q.task&&Q.task.c){
    var dc=ht('pre','runout',null);
    dc.innerHTML='ℹ️ 本题是 C 写法，浏览器的「▶ 运行自测」只支持 JS。\n请点「🤖 提交 AI 评判」由 AI 判分（看得出思路对不对）。';
    msgEl.appendChild(dc);return;
  }
  var ex=(Q&&Q.task&&Q.task.ex)||'';
  var m=ex.match(/^([\s\S]+?)\s*→\s*([\s\S]+)$/);
  var call=m?m[1].trim():'',want=m?m[2].trim():'',wantNorm=null;
  if(m){
    try{wantNorm=normOut(new Function('return ('+want+');')());}
    catch(e){wantNorm=normOut(want.replace(/^["']|["']$/g,''));}
  }
  function render(disp,err,logs){
    var box,show=disp===''?'（无返回 / undefined）':disp;
    if(err){
      /* 「xxx is not defined」且正是样例要调用的函数名 —— 十有八九是压根没写这个名字，
         别拿「只支持 JS 写法」去误导（写了 C 的 int main 是另一回事）。 */
      var nd=err.match(/^([A-Za-z_$][\w$]*) is not defined/);
      var fname=(call.match(/^([A-Za-z_$][\w$]*)/)||[])[1]||'';
      var tail;
      if(/运行超时/.test(err))tail='（检查是不是有 while / for 少了终止条件）';
      else if(nd&&nd[1]===fname)tail='（样例要调用 '+fname+'(…)，但代码里还没定义叫 '+fname+' 的函数）';
      else tail='（浏览器自测只支持 JS 写法，C / Python 请点「🤖 提交 AI 评判」）';
      box='❌ 本地运行失败：'+escH(err)+'\n\n'+tail;
    }else if(!m){
      box='✅ 已执行完毕（本题没有「样例 → 期望值」，只看返回值）\n返回值：'+escH(show);
    }else if(disp===wantNorm){
      box='✅ 运行通过：'+escH(show)+'　（期望 '+escH(want)+'）';
    }else{
      box='⚠️ 运行结果：'+escH(show)+'　（期望 '+escH(want)+'）\n—— 与期望不一致，检查实现后再试';
    }
    if(logs&&logs.length)box+='\n📤 console 输出：\n'+escH(logs.join('\n'));
    var d=ht('pre','runout',null);d.innerHTML=box;
    msgEl.appendChild(d);
  }
  var done=false,timer=null,w=null;
  function finish(disp,err,logs){
    if(done)return;
    done=true;
    if(timer){clearTimeout(timer);timer=null;}
    if(w){try{w.terminate();}catch(e){}w=null;}
    render(disp,err,logs);
  }
  /* 首选 Worker（能中断死循环）；file:// 打开时 blob worker 会被浏览器拦，退回同步执行 */
  try{
    var url=URL.createObjectURL(new Blob([RUN_WORKER_SRC],{type:'text/javascript'}));
    w=new Worker(url);
    try{URL.revokeObjectURL(url);}catch(e){}
    w.onmessage=function(e){var d=e.data||{};finish(d.disp==null?'':String(d.disp),d.err||'',d.logs||[]);};
    w.onerror=function(){finish('','代码里抛了未捕获的异常',[]);};
    w.postMessage({code:code,call:call||'undefined'});
    timer=setTimeout(function(){finish('','运行超时（多半是死循环），已中断',[]);},4000);
    return;
  }catch(e){if(w){try{w.terminate();}catch(x){}w=null;}}
  var logs=[],oldLog=console.log;
  try{console.log=function(){logs.push([].slice.call(arguments).join(' '));};}catch(e){}
  var disp='',err='';
  try{disp=normOut(new Function(code+'\n;return ('+(call||'undefined')+');')());}
  catch(e2){err=String((e2&&e2.message)||e2);}
  try{console.log=oldLog;}catch(e){}
  finish(disp,err,logs);
}

function submitHand(Q,code,btn,msgEl){
  if(locked)return;                 /* 已结算（答过 / 点过不会）：别让二次点击再烧一次 AI 调用 */
  if(!canJudge()){toast('✍️ 手写代码要先配置 AI（免费通道不用 Key）');return;}
  if(!String(code||'').trim()){msgEl.textContent='⚠️ 还没写代码';return;}
  var t=(Q&&Q.task)||{t:Q.q,ex:'',tip:''};
  var cfg=loadAICfg();
  btn.disabled=true;msgEl.textContent='🤖 AI 正在评判…（最多 30 秒，超时本题不计分）';
  var langLabel=(t.lang==='c')?'C语言':(t.lang==='js'?'JavaScript':'该语言');
  var prompt='你在批改一道编程练习题。'+(langLabel?'（语言：'+langLabel+'）':'')+'\n题目：'+t.t+'\n样例：'+(t.ex||'')+'\n要点：'+(t.tip||'')+'\n\n学生的代码：\n```\n'+code+'\n```\n\n请判断这段代码在逻辑上是否正确完成了题目（请按该语言书写规范评判：缩进、花括号、命名、是否存在编译级错误；忽略大小写/格式/变量命名差异；明显语法错误或编译级错误判为不正确）。\n严格只返回一个 JSON 对象，不要任何解释文字：\n{"ok":true,"why":"一句中文原因"}';
  callAIRaw(cfg,prompt,function(txt,err){
    btn.disabled=false;
    if(!txt){
      msgEl.textContent='⚠️ '+(err||'AI 评判失败')+'，本题不计分，跳过';
      later(function(){qidx++;showQuestion();},1600);
      return;
    }
    var r=parseJudge(txt);
    if(!r){
      msgEl.textContent='⚠️ 没读懂 AI 的评判结果，本题不计分，跳过';
      later(function(){qidx++;showQuestion();},1600);
      return;
    }
    msgEl.textContent='';
    answer(r.ok,code,'（AI 评判）',null,{wait:2200,note:r.why?('🤖 '+r.why):''});
  },30000);
}

/* ---------- 任务4：背景音乐 ---------- */
// 曲目按「基名 + 扩展名链」探测：放 flower-dance.flac / flower-dance.wav 都能认
var AUDIO_EXTS=['mp3','flac','wav','m4a','ogg','aac'];
var MUSIC_DEFAULT=[
  {name:'🎹 内置轻音乐（免文件）',synth:true},
  {name:'Flower Dance',base:'audio/flower-dance',exts:AUDIO_EXTS},
  {name:'Windy Hill',base:'audio/windy-hill',exts:AUDIO_EXTS},
  {name:'Summer',base:'audio/summer',exts:AUDIO_EXTS},
  {name:'Luv Letter',base:'audio/luv-letter',exts:AUDIO_EXTS},
  {name:'卡农（钢琴版）',base:'audio/canon',exts:AUDIO_EXTS}
];
var MUSIC_CFG_KEY='bt_qa_music';
var bgm=null,musicList=[],musicIdx=0,musicLoop=true,musicVol=0.5,musicPlaying=false,musicFailStreak=0,musicErrMsg='',musicOv=null;
function loadMusicCfg(){try{return JSON.parse(S.getItem(MUSIC_CFG_KEY)||'{}')||{};}catch(e){return{};}}
function buildMusicList(){var cfg=loadMusicCfg();
  // 深拷贝默认曲目，避免上一局 set 的 _ext/_gone/missing 等标记跨次打开残留（MUSIC_DEFAULT 是共享引用）
  musicList=MUSIC_DEFAULT.map(function(t){var c={};for(var k in t){if(Object.prototype.hasOwnProperty.call(t,k))c[k]=t[k];}return c;});
  if(cfg.custom&&cfg.custom.length)musicList=musicList.concat(cfg.custom);
  musicIdx=cfg.idx||0;if(musicIdx>=musicList.length)musicIdx=0;musicLoop=cfg.loop!==false;musicVol=(cfg.vol==null?0.5:cfg.vol);}
function saveMusicCfg(){var cfg=loadMusicCfg();cfg.idx=musicIdx;cfg.loop=musicLoop;cfg.vol=musicVol;try{safeSet(MUSIC_CFG_KEY,JSON.stringify(cfg));}catch(e){}}
/* 当前曲目该用哪个地址：在线 URL > 旧版 file 字段 > 基名+第 N 个扩展名 */
function musicSrcOf(tr){
  if(!tr)return '';
  if(tr.url)return tr.url;
  if(tr.file)return tr.file;
  if(tr.base&&tr.exts&&tr.exts.length){
    var k=Math.max(0,Math.min(tr._ext||0,tr.exts.length-1));
    return tr.base+'.'+tr.exts[k];
  }
  return '';
}
function musicMissText(tr){
  if(!tr||!tr.base)return '⚠️ 音频文件缺失，请用「➕ 添加」导入本地音乐';
  return '⚠️ 未找到 '+tr.base+' 下的文件（已尝试 '+(tr.exts||['mp3']).slice(0,6).join('/')+'）。请确认：① 文件已放进 quiz/audio/ 且命名小写+连字符；② 线上已同步部署 audio（_deploy_gym/quiz/audio/）；或用「➕ 添加」导入本地文件播放。';
}
/* 探测某个 base 曲目在 audio/ 下是否存在：HEAD 逐个扩展名试，命中即停。
   用 HEAD（sw.js 只拦 GET，HEAD 直接走网络），不下载文件体。 */
function probeTrack(tr,cb){
  cb=cb||function(){};
  if(!tr||!tr.base||!tr.exts||!tr.exts.length){cb(false);return;}
  /* 6 个扩展名并发探测（原来是串行，最坏 6 个往返；线上慢网实测要十几秒，
     面板会一直挂着不存在的曲目）。任一 2xx 即命中，命中后留 220ms 给更靠前的
     扩展名（同一曲目若同时有 mp3/flac，优先用靠前的，别去拉 54MB 的 wav）。
     全部失败才算缺失；总预算 7s，超时按缺失处理。 */
  var hits={},done=false,pending=tr.exts.length,timer=null,hard=null;
  function best(){for(var i=0;i<tr.exts.length;i++){if(hits[i])return i;}return -1;}
  function finish(){
    if(done)return;done=true;
    if(timer){clearTimeout(timer);timer=null;}
    if(hard){clearTimeout(hard);hard=null;}
    var b=best();cb(b>=0,b>=0?tr.exts[b]:null);
  }
  hard=setTimeout(finish,7000);
  tr.exts.forEach(function(ex,idx){
    fetch(tr.base+'.'+ex,{method:'HEAD',cache:'no-store'})
      .then(function(r){
        if(r&&r.ok&&!done){
          hits[idx]=1;
          if(idx===0){finish();return;}
          if(!timer)timer=setTimeout(finish,220);
        }
      })
      .catch(function(){})
      .then(function(){if(--pending<=0)finish();});
  });
}
function musicNote(msg){musicErrMsg=msg||'';updateMusicPanel();}
function bgmPlay(){
  if(!bgm)return;
  var p=null;
  try{p=bgm.play();}catch(e){musicNote('⚠️ 播放失败：'+((e&&e.message)||(e&&e.name)||'未知原因'));return;}
  if(p&&p.catch)p.catch(function(e){
    if(e&&e.name==='NotAllowedError'){musicPlaying=false;updateMusicPanel();return;} // 浏览器要求先有点击
    if(e&&e.name==='NotSupportedError')return;   // 交给 error 事件里的扩展名探测/缺失提示，别用兜底文案覆盖
    if(e&&e.name==='AbortError')return;           // 换 src / load() 主动打断上一次 play()，属正常探测流程，别报成失败
    musicNote('⚠️ 播放失败：'+((e&&e.message)||(e&&e.name)||'未知原因'));
  });
}
/* 彻底断掉当前加载：只 pause() 不会取消在途下载，几十 MB 的曲子会继续占着连接，把下一首的 404 拖到几秒后才回来 */
function bgmReset(){if(!bgm)return;try{bgm.pause();}catch(e){}try{bgm.removeAttribute('src');bgm.load();}catch(e){}}
function ensureBgm(){if(bgm)return bgm;bgm=new Audio();bgm.loop=false;bgm.volume=musicVol;
  bgm.addEventListener('playing',function(){musicFailStreak=0;musicPlaying=true;musicErrMsg='';updateMusicPanel();});
  bgm.addEventListener('ended',function(){if(musicLoop)playMusic((musicIdx+1)%musicList.length);else{musicPlaying=false;updateMusicPanel();}});
  bgm.addEventListener('error',function(){
    var tr=musicList[musicIdx]||{};
    // 切歌会打断上一次加载，也会抛一个 error（currentSrc 还是上一个地址）——那不是当前曲目失败，别参与探测
    var want=musicSrcOf(tr);
    if(bgm.currentSrc&&want&&bgm.currentSrc.indexOf(want)<0)return;
    // 扩展名自动探测：还有候选就换下一个试（404 / 格式不支持都会走这里）
    if(tr.base&&tr.exts&&(tr._ext||0)<tr.exts.length-1){
      tr._ext=(tr._ext||0)+1;
      bgm.src=musicSrcOf(tr);
      try{bgm.load();}catch(e){}
      bgmPlay();
      return;
    }
    // 全部扩展名都失败：明确报错并停在这一首（自动乱跳会让提示串到别的曲目上）
    if(!tr.synth)tr.missing=true;
    musicPlaying=false;
    musicNote(musicMissText(tr));
    if(!tr._warned){tr._warned=1;toast(musicMissText(tr));}
  });
  return bgm;}

/* 内置合成音（无音频文件时也能听） */
var synthCtx=null,synthTimer=null,synthMaster=null,synthStep=0;
var SYNTH_CHORDS=[[0,4,7,11],[-3,2,5,9],[-5,0,4,7],[2,5,9,12]];
function synthStop(){if(synthTimer){clearInterval(synthTimer);synthTimer=null;}if(synthMaster){try{synthMaster.disconnect();}catch(e){}synthMaster=null;}}
function synthStart(){
  var AC=window.AudioContext||window.webkitAudioContext;if(!AC)return false;
  try{
    if(!synthCtx)synthCtx=new AC();
    if(synthCtx.state==='suspended')synthCtx.resume();
    synthStop();
    synthMaster=synthCtx.createGain();synthMaster.gain.value=Math.max(0.001,musicVol*0.28);synthMaster.connect(synthCtx.destination);
    synthStep=0;
    var NOTE=function(freq,at,dur,amp,type){
      var o=synthCtx.createOscillator(),g=synthCtx.createGain();
      o.type=type||'sine';o.frequency.value=freq;
      g.gain.setValueAtTime(0.0001,at);
      g.gain.linearRampToValueAtTime(amp,at+0.03);
      g.gain.exponentialRampToValueAtTime(0.0001,at+dur);
      o.connect(g);g.connect(synthMaster);o.start(at);o.stop(at+dur+0.05);
    };
    var tick=function(){
      if(!synthCtx||!synthMaster)return;
      var t=synthCtx.currentTime+0.02;
      var ch=SYNTH_CHORDS[Math.floor(synthStep/8)%SYNTH_CHORDS.length];
      var idx=synthStep%8;
      var semi=ch[idx%ch.length]+(idx>=4?12:0);
      NOTE(220*Math.pow(2,semi/12),t,1.6,0.12,'triangle');
      if(idx===0)NOTE(110*Math.pow(2,ch[0]/12),t,3.4,0.1,'sine');
      synthStep++;
    };
    tick();synthTimer=setInterval(tick,340);return true;
  }catch(e){return false;}
}
function playMusic(i,keepMsg){
  musicIdx=i;var tr=musicList[i];if(!tr)return;
  if(!keepMsg)musicErrMsg='';
  if(tr.synth){if(bgm)try{bgm.pause();}catch(e){}musicPlaying=synthStart();saveMusicCfg();updateMusicPanel();return;}
  synthStop();ensureBgm();
  if(tr.blobKey){   // 本地导入：IndexedDB 里的 blob，无命名限制
    loadBlob(tr.blobKey,function(b){
      if(!b){musicNote('⚠️ 本地音频读取失败（可能已被清理），请重新导入');return;}
      bgmReset();bgm.src=URL.createObjectURL(b);bgmPlay();
    });
    musicPlaying=true;saveMusicCfg();updateMusicPanel();return;
  }
  if(tr._ext==null)tr._ext=0;        // 已被面板探测命中就沿用该扩展名，否则从头探测
  var src=musicSrcOf(tr);
  if(src){bgmReset();bgm.src=src;bgmPlay();}
  else{musicPlaying=false;musicNote('⚠️ 该曲目没有可用地址');return;}
  musicPlaying=true;saveMusicCfg();updateMusicPanel();
}
function toggleMusic(){if(musicPlaying){synthStop();if(bgm)try{bgm.pause();}catch(e){}musicPlaying=false;updateMusicPanel();}else{musicErrMsg='';playMusic(musicIdx);}}
function updateMusicPanel(){
  var p=$('musicPanel');if(!p)return;
  var tr=musicList[musicIdx]||{};
  var nm=$('mpName');if(nm)nm.textContent=(tr.name||'—')+(tr.missing?'（文件缺失）':'');
  var pp=$('mpPlay');if(pp)pp.textContent=musicPlaying?'⏸':'▶';
  var er=$('mpErr');if(er){er.textContent=musicErrMsg||'';er.style.display=musicErrMsg?'':'none';}
}
function openMusic(){
  buildMusicList();
  var ov=overlayPanel('🎵 背景音乐');
  ov.p.id='musicPanel';
  musicOv=ov;
  ov.p.appendChild(ht('div','hint','「🎹 内置轻音乐」免文件即可播放。其它曲目支持 mp3 / flac / wav / m4a / ogg / aac：把文件放进 quiz/audio/，命名成 flower-dance.flac、windy-hill.wav 这种「小写 + 连字符」即可自动识别（扩展名会自动探测）；文件名不规范就用「➕ 添加」导入（存本机，无命名限制，离线也能播）。默认关闭，状态会被记住。　新增「📁 从 audio/ 添加」：把任意命名的文件放进 quiz/audio/ 后填文件名即可自动探测扩展名；注意音频文件不随代码发布，线上播放需同时把文件放进部署目录 _deploy_gym/quiz/audio/（或本机部署位置）。'));
  var now=h('div');now.style.textAlign='center';now.style.margin='10px 0 4px';
  var nameEl=ht('div',null,(musicList[musicIdx]||{}).name||'—');nameEl.id='mpName';
  nameEl.style.cssText='font-size:17px;font-weight:800;color:var(--purple-d)';
  now.appendChild(nameEl);
  var errEl=ht('div','hint','');errEl.id='mpErr';
  errEl.style.cssText='color:#b8233c;font-weight:700;font-size:12px;line-height:1.5;margin-top:7px;display:none';
  now.appendChild(errEl);
  var ctrl=h('div');ctrl.style.cssText='display:flex;gap:12px;justify-content:center;align-items:center;margin:12px 0';
  var prev=h('button','btn ghost','⏮');prev.style.cssText='width:50px;padding:12px 0';
  prev.onclick=function(){playMusic((musicIdx-1+musicList.length)%musicList.length);openMusic();};
  var play=h('button','btn gold',musicPlaying?'⏸':'▶');play.id='mpPlay';
  play.style.cssText='width:64px;padding:14px 0;font-size:18px';
  play.onclick=function(){toggleMusic();play.textContent=musicPlaying?'⏸':'▶';};
  var next=h('button','btn ghost','⏭');next.style.cssText='width:50px;padding:12px 0';
  next.onclick=function(){playMusic((musicIdx+1)%musicList.length);openMusic();};
  ctrl.appendChild(prev);ctrl.appendChild(play);ctrl.appendChild(next);now.appendChild(ctrl);
  ov.p.appendChild(now);
  var volRow=h('div','switch');volRow.appendChild(ht('span',null,'🔊 音量'));
  var vol=h('input');vol.type='range';vol.min='0';vol.max='100';vol.value=Math.round(musicVol*100);
  vol.oninput=function(){musicVol=vol.value/100;if(bgm)bgm.volume=musicVol;if(synthMaster)synthMaster.gain.value=Math.max(0.001,musicVol*0.28);saveMusicCfg();};
  volRow.appendChild(vol);ov.p.appendChild(volRow);
  var loopRow=h('div','switch');loopRow.appendChild(ht('span',null,'🔁 循环播放'));
  var loopChk=h('input');loopChk.type='checkbox';loopChk.checked=musicLoop;
  loopChk.onchange=function(){musicLoop=loopChk.checked;saveMusicCfg();};
  loopRow.appendChild(loopChk);ov.p.appendChild(loopRow);

  // 曲目列表（先渲染，再异步探测 audio/ 文件，无文件的自动消失）
  ov.p.appendChild(ht('div','section-title','曲目列表'));
  var mtl=h('div');mtl.id='mtrackList';ov.p.appendChild(mtl);
  renderMusicTracks(ov);
  probeAndFilterMusic();   // 探测 base 型曲目，缺失的从列表移除

  var imp=ht('div','section-title','导入音乐');ov.p.appendChild(imp);
  var fileWrap=h('div','row');
  var fileIn=h('input');fileIn.type='file';fileIn.accept='audio/*';fileWrap.appendChild(fileIn);
  var addLocal=h('button','btn','➕ 添加');
  addLocal.onclick=function(){var f=fileIn.files&&fileIn.files[0];if(!f){alert('请先选择 mp3 文件');return;}
    storeBlob(f,function(key){if(!key){alert('导入失败：浏览器不支持本地存储或空间不足');return;}
      var cfg=loadMusicCfg();cfg.custom=cfg.custom||[];cfg.custom.push({name:f.name.replace(/\.[^.]+$/,''),blobKey:key});
      try{safeSet(MUSIC_CFG_KEY,JSON.stringify(cfg));}catch(e){}
      buildMusicList();closeOverlay(ov);openMusic();});};
  fileWrap.appendChild(addLocal);ov.p.appendChild(fileWrap);
  // 「📁 从 audio/ 添加」：把任意命名的文件放进 quiz/audio/ 后，填文件名即加入列表（自动探测扩展名）
  var baseWrap=h('div','row');
  var audioBaseIn=h('input');audioBaseIn.placeholder='如 my-song（自动探测 mp3/flac/wav/m4a/ogg/aac）';baseWrap.appendChild(audioBaseIn);
  var addBase=h('button','btn','＋');
  addBase.onclick=function(){addAudioBase(audioBaseIn,ov);};
  baseWrap.appendChild(addBase);ov.p.appendChild(baseWrap);
  var urlWrap=h('div','row');var urlIn=h('input');urlIn.placeholder='或填在线音频 URL 添加';urlWrap.appendChild(urlIn);
  var addUrl=h('button','btn','＋');
  addUrl.onclick=function(){var u=urlIn.value.trim();if(!/^https?:\/\//.test(u)){alert('请输入有效的 http(s) URL');return;}
    var cfg=loadMusicCfg();cfg.custom=cfg.custom||[];cfg.custom.push({name:u.split('/').pop()||'在线音乐',url:u});
    try{safeSet(MUSIC_CFG_KEY,JSON.stringify(cfg));}catch(e){}
    buildMusicList();closeOverlay(ov);openMusic();};
  urlWrap.appendChild(addUrl);ov.p.appendChild(urlWrap);
  ov.p.appendChild(ht('div','muted','版权说明：内置曲目为默认名，正式公开使用前请确保你拥有相应音频的授权。'));
  updateMusicPanel();
}

/* 曲目列表渲染（抽出来，探测过滤后会重新调用） */
function renderMusicTracks(ov){
  var box=ov&&ov.p?ov.p.querySelector('#mtrackList'):null;
  if(!box)return;
  clearNode(box);
  if(!musicList.length){box.appendChild(ht('div','hint','（无可播放曲目——把音乐文件放进 quiz/audio/ 后会自动出现）'));return;}
  musicList.forEach(function(tr,i){
    var row=ht('div','mtrack'+(i===musicIdx?' sel':''));
    row.appendChild(ht('span','mi',(i===musicIdx&&musicPlaying)?'▶':(tr.synth?'🎹':'♪')));
    row.appendChild(ht('span','mn',tr.name));
    if(tr.missing)row.appendChild(ht('span','ms','缺失'));
    else if(tr.synth)row.appendChild(ht('span','ms','内置'));
    else if(tr.url)row.appendChild(ht('span','ms','在线'));
    else if(tr.blobKey)row.appendChild(ht('span','ms','本地'));
    else if(tr.base)row.appendChild(ht('span','ms','audio/'));
    if(tr.missing)row.title=musicMissText(tr);
    row.onclick=function(){playMusic(i);openMusic();};
    box.appendChild(row);
  });
}
/* 打开面板时探测 base 型曲目，缺失的从列表移除（synth/本地导入/在线 URL 永不探测） */
function probeAndFilterMusic(){
  var todo=musicList.map(function(tr,i){return tr&&tr.base&&!tr.synth&&!tr.url&&!tr.blobKey?i:-1;})
                    .filter(function(i){return i>=0;});
  if(!todo.length)return;
  var left=todo.length,removedTotal=0;
  /* 每确认一首缺失就立刻摘掉一首：慢网下面板不会挂着死曲目等十几秒才一次性消失 */
  function prune(){
    var keep=[],gone=0;
    musicList.forEach(function(t){if(t._gone){gone++;t._gone=false;}else keep.push(t);});
    if(!gone)return 0;
    musicList=keep;
    if(musicIdx>=musicList.length)musicIdx=Math.max(0,musicList.length-1);
    if(musicOv)renderMusicTracks(musicOv);
    updateMusicPanel();
    var nm=document.getElementById('mpName');if(nm)nm.textContent=(musicList[musicIdx]||{}).name||'—';
    return gone;
  }
  todo.forEach(function(i){
    var tr=musicList[i];   // 先抓住对象引用：prune 会重建 musicList，下标会变
    probeTrack(tr,function(ok,ex){
      if(ok&&ex)tr._ext=tr.exts.indexOf(ex);
      else tr._gone=true;
      left--;
      removedTotal+=prune();
      if(left<=0&&removedTotal)toast('已隐藏 '+removedTotal+' 首无文件的曲目');
    });
  });
}

/* 「📁 从 audio/ 添加」：填文件名即加入曲目列表，扩展名探测复用现有 musicSrcOf / error 逻辑 */
function addAudioBase(inp,ov){
  var v=(inp.value||'').trim().replace(/\s+/g,'-').replace(/[^a-z0-9\-]/gi,'');
  if(!v){alert('请填写文件名（小写字母/数字/连字符）');return;}
  var cfg=loadMusicCfg();cfg.custom=cfg.custom||[];
  var dup=cfg.custom.some(function(t){return t.base&&t.base==='audio/'+v;});
  if(dup){toast('该曲目已在列表');return;}
  cfg.custom.push({name:v,base:'audio/'+v,exts:AUDIO_EXTS.slice()});
  try{safeSet(MUSIC_CFG_KEY,JSON.stringify(cfg));}catch(e){}
  buildMusicList();
  var idx=musicList.length-1;
  if(musicList[idx]&&musicList[idx].base==='audio/'+v){closeOverlay(ov);playMusic(idx);}
  openMusic();
}

/* ---------- AI 服务商预设（选服务商自动填地址 + 刷新模型） ---------- */
var AI_PRESETS=[
  {id:'custom',name:'自定义（手填地址与模型）',url:'',models:[]},
  {id:'doubao',name:'豆包 Ark（火山方舟）',url:'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
   models:['doubao-seed-1-6-250615','doubao-1-5-pro-32k-250115','doubao-1-5-lite-32k-250115']},
  {id:'deepseek',name:'DeepSeek',url:'https://api.deepseek.com/v1/chat/completions',
   models:['deepseek-chat','deepseek-reasoner']},
  {id:'kimi',name:'Kimi（Moonshot）',url:'https://api.moonshot.cn/v1/chat/completions',
   models:['moonshot-v1-8k','moonshot-v1-32k']},
  {id:'zhipu',name:'智谱 GLM',url:'https://open.bigmodel.cn/api/paas/v4/chat/completions',
   models:['glm-4','glm-4-plus','glm-3-turbo']},
  {id:'qwen',name:'通义千问',url:'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
   models:['qwen-turbo','qwen-plus','qwen-max']},
  {id:'openai',name:'OpenAI',url:'https://api.openai.com/v1/chat/completions',
   models:['gpt-4o-mini','gpt-4o']},
  {id:'free',name:'免费 AI（Pollinations·无需Key）',url:'https://text.pollinations.ai/openai',
   models:['openai']}
];
function aiPreset(id){for(var i=0;i<AI_PRESETS.length;i++){if(AI_PRESETS[i].id===id)return AI_PRESETS[i];}return AI_PRESETS[0];}
function aiPresetByUrl(u){u=(u||'').trim();for(var i=1;i<AI_PRESETS.length;i++){if(AI_PRESETS[i].url===u)return AI_PRESETS[i];}return null;}
// 是否属于任意一家的预置模型（用来区分「下拉选出来的」和「用户手打的」模型名）
function isPresetModel(m){if(!m)return false;for(var i=1;i<AI_PRESETS.length;i++){if(AI_PRESETS[i].models.indexOf(m)>=0)return true;}return false;}
// 免费通道（Pollinations）：无需 Key。注意它是推理模型，完成 token 上限约 1500，
// 默认推理档会把预算全烧在 reasoning 上、content 整个缺失 —— 必须压低调 reasoning。
function isFreeAI(url){return /pollinations\.ai/i.test(url||'');}

/* ---------- 设置 ---------- */
function openSettings(){
  var ov=overlayPanel('⚙️ 设置');
  // 重新检测
  var sec1=ht('div','section-title','实力检测');ov.p.appendChild(sec1);
  var redetect=h('button','btn ghost','🔄 重新编程实力检测');redetect.onclick=function(){try{S.removeItem(CODE_PROFILE_KEY);S.removeItem('bt_qa_rank_code');}catch(e){}closeOverlay(ov);codeQuestionnaire(function(){renderShelf();});};
  ov.p.appendChild(redetect);
  /* C1（二批）：答题设置 —— 答对 1 秒后自动跳，默认开（关闭后可慢慢看解析） */
  ov.p.appendChild(ht('div','section-title','🧠 答题设置'));
  var _qj=quickJump();
  var _qjL=document.createElement('label');_qjL.style.cssText='display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer';
  var _qjC=document.createElement('input');_qjC.type='checkbox';_qjC.checked=_qj;
  _qjC.onchange=function(){safeSet('bt_qa_quickjump',_qjC.checked?'true':'false');};
  _qjL.appendChild(_qjC);_qjL.appendChild(ht('span',null,'⏩ 答对 1 秒后自动跳（关闭后可慢慢看解析）'));
  ov.p.appendChild(_qjL);
  ov.p.appendChild(ht('div','muted','默认开启：答对后先显示解析/来源，1 秒后自动进下一题；1 秒内点「下一题」立即跳。关闭后停住，看完解析自己点。'));
  var _arL=document.createElement('label');_arL.style.cssText='display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;margin-top:6px';
  var _arC=document.createElement('input');_arC.type='checkbox';_arC.checked=autoRefillOn();
  _arC.onchange=function(){safeSet('bt_qa_autorefill',_arC.checked?'true':'false');};
  _arL.appendChild(_arC);_arL.appendChild(ht('span',null,'✨ 题库不足时自动补题（调用 AI）'));
  ov.p.appendChild(_arL);
  ov.p.appendChild(ht('div','muted','默认关闭：打开后，自定义题库不足 10 题时会在结算后调用 AI 补到约 20 题（需先配好 AI）。'));
  // AI 配置
  var sec2=ht('div','section-title','🌐 AI 建题库（OpenAI 兼容）');ov.p.appendChild(sec2);
  var cfg=loadAICfg()||{};

  // 服务商：选中即自动填接口地址
  var provWrap=h('div','fld');provWrap.appendChild(ht('div','flabel','服务商'));
  var provI=h('select');provI.id='aiProvider';
  AI_PRESETS.forEach(function(p){var o=h('option');o.value=p.id;o.textContent=p.name;provI.appendChild(o);});
  provWrap.appendChild(provI);ov.p.appendChild(provWrap);

  // 模型：预设服务商给下拉，自定义给手填框（表单里始终有一个真实的模型名）
  var modWrap=h('div','fld');modWrap.appendChild(ht('div','flabel','模型'));
  var modSel=h('select');modSel.id='aiModel';
  var modI=h('input');modI.id='aiModelInput';modI.placeholder='模型名，如 deepseek-chat';modI.value=cfg.model||'';
  modWrap.appendChild(modSel);modWrap.appendChild(modI);ov.p.appendChild(modWrap);

  var urlWrap=h('div','fld');urlWrap.appendChild(ht('div','flabel','API 地址'));
  var urlI=h('input');urlI.id='aiUrl';urlI.placeholder='https://…/v1/chat/completions';urlI.value=cfg.url||'';
  urlWrap.appendChild(urlI);ov.p.appendChild(urlWrap);

  var keyWrap=h('div','fld');keyWrap.appendChild(ht('div','flabel','API Key'));
  var keyI=h('input');keyI.id='aiKey';keyI.type='password';keyI.placeholder='sk-…';keyI.value=cfg.key||'';
  keyWrap.appendChild(keyI);ov.p.appendChild(keyWrap);

  var proxWrap=h('div','fld');proxWrap.appendChild(ht('div','flabel','代理地址（可选）'));
  var proxI=h('input');proxI.id='aiProxy';proxI.placeholder='跨域被拦时填中转地址';proxI.value=cfg.proxy||'';
  proxWrap.appendChild(proxI);ov.p.appendChild(proxWrap);

  var curPid='custom';
  // 刷新模型下拉；keep 不在列表里时额外保留一项，避免手填过的模型被覆盖
  function fillModels(pid,keep){
    var p=aiPreset(pid),list=p.models.slice();
    clearNode(modSel);
    if(!list.length){modSel.style.display='none';modI.style.display='';modI.value=keep||'';return;}
    modSel.style.display='';modI.style.display='none';
    if(keep&&list.indexOf(keep)<0)list.push(keep);
    list.forEach(function(m){var o=h('option');o.value=m;o.textContent=m;modSel.appendChild(o);});
    var v=(keep&&list.indexOf(keep)>=0)?keep:list[0];
    modSel.value=v;modI.value=v;
  }
  // 回显：地址命中某家预设就选中该家，否则「自定义」（旧配置一切原样）
  var matched=aiPresetByUrl(cfg.url);
  curPid=(matched||AI_PRESETS[0]).id;provI.value=curPid;
  fillModels(curPid,cfg.model||'');

  provI.onchange=function(){
    var pid=provI.value,oldP=aiPreset(curPid),newP=aiPreset(pid);
    var curUrl=urlI.value.trim(),curModel=modI.value.trim();
    // 切到免费通道时无条件填地址：它无需 Key、模型只有一档，
    // 若沿用旧自定义地址会让通道静默失效（请求打到别人的接口上）
    if(newP.url&&(!curUrl||curUrl===oldP.url||isFreeAI(newP.url)))urlI.value=newP.url;
    // 切到「自定义」保留手填内容，方便在现有地址上微调；
    // 切到预设服务商时：下拉选出来的模型换成新服务商默认档，用户手打的模型名才保留
    var keep=newP.models.length?(isPresetModel(curModel)?'':curModel):curModel;
    if(isFreeAI(newP.url))keep='';   // 免费通道只有 openai 一档，别把手填模型名带进来
    fillModels(pid,keep);
    curPid=pid;
  };
  modSel.onchange=function(){modI.value=modSel.value;};

  var testB=h('button','btn','🔌 测试连接');var testMsg=ht('div','hint','');ov.p.appendChild(testB);ov.p.appendChild(testMsg);
  testB.onclick=function(){var c={url:urlI.value.trim(),key:keyI.value.trim(),model:modI.value.trim(),proxy:proxI.value.trim()};if(!c.url){testMsg.textContent='⚠️ 请先填 API 地址';return;}
    if(!c.key&&!isFreeAI(c.url)){testMsg.textContent='⚠️ 请先填 API 地址与 Key';return;}testMsg.textContent='测试中…';testAI(c,function(ok,why){
      testMsg.textContent=ok?'✅ 连接成功':'❌ 失败：'+(why?(/^\d+$/.test(why)?'HTTP '+why:why):'未知错误');
    });};
  var saveB=h('button','btn gold','💾 保存配置');saveB.onclick=function(){var c={url:urlI.value.trim(),key:keyI.value.trim(),model:modI.value.trim(),proxy:proxI.value.trim()};try{safeSet('bt_qa_ai',JSON.stringify(c));}catch(e){}testMsg.textContent='✅ 已保存';};
  ov.p.appendChild(saveB);
  ov.p.appendChild(ht('div','muted','提示：选服务商会自动填好接口地址，选模型会自动填模型名；接口需与 OpenAI 兼容（自定义可填中转地址）。无 Key 可选「免费 AI（Pollinations）」或走「🆓 免费搜索」生成题。'));
  /* ---- 离线 / 安装 ---- */
  ov.p.appendChild(ht('div','section-title','📴 离线使用'));
  var pstate=ht('div','muted','');ov.p.appendChild(pstate);
  pstate.textContent=pwaState();
  ov.p.appendChild(ht('div','muted','手机浏览器菜单里选「添加到主屏幕」，之后从图标打开就是独立窗口（无地址栏）。断网时照样能刷题、看错题本；🌐 联网题库会自动改用内置离线题池，🆓 搜索建题库 / 🤖 AI 建题库需要联网。'));
  var clr=h('button','btn ghost','🔄 清除离线缓存并更新');
  clr.onclick=function(){
    try{
      if(navigator.serviceWorker&&navigator.serviceWorker.controller){
        navigator.serviceWorker.controller.postMessage({type:'CLEAR_CACHE'});
      }
    }catch(e){}
    setTimeout(function(){location.reload();},260);
  };
  ov.p.appendChild(clr);
  var about=ht('div','section-title','关于');ov.p.appendChild(about);
  ov.p.appendChild(ht('div','muted','知识问答独立版 · 从 brain-gym 拆分 · 题库/成绩共用 bt_qa_ 存储前缀'));
}

/* ---------- P2-A2：数据导出 / 导入 ---------- */
var BACKUP_KEYS=['bt_qa_stats','bt_qa_best','bt_qa_weak','bt_qa_custom','bt_qa_ai','bt_qa_extra','bt_qa_daily','bt_qa_profile_code'];
function dayKey(d){return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2);}
function backupKeys(){
  var ks=BACKUP_KEYS.slice();
  try{for(var i=0;i<S.length;i++){var k=S.key(i);if(k&&k.indexOf('bt_qa_rank_')===0&&ks.indexOf(k)<0)ks.push(k);}}catch(e){}
  return ks;
}
function buildBackup(){
  var keys=backupKeys(),values={},keyStripped=false;
  keys.forEach(function(k){try{
    var v=S.getItem(k);if(v==null)return;
    /* C6：备份默认剔除 API Key —— 备份文件常被丢进网盘或发给别人，Key 不该跟着走 */
    if(k==='bt_qa_ai'){try{var cfg=JSON.parse(v);if(cfg&&cfg.key){cfg.key='';keyStripped=true;v=JSON.stringify(cfg);}}catch(e){}}
    values[k]=v;
  }catch(e){}});
  var out={exported_at:new Date().toISOString(),app:'ming-quiz',v:1,keys:Object.keys(values),values:values};
  if(keyStripped)out.key_stripped=true;
  return out;
}
function exportAllData(){
  var data=buildBackup(),n=Object.keys(data.values).length;
  try{
    var blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
    var a=document.createElement('a');a.href=URL.createObjectURL(blob);
    a.download='ming-quiz-backup-'+dayKey(new Date())+'.json';
    document.body.appendChild(a);a.click();document.body.removeChild(a);
    setTimeout(function(){try{URL.revokeObjectURL(a.href);}catch(e){}},1000);
    toast('💾 已导出备份（'+n+' 项'+(data.key_stripped?'，已剔除 API Key':'')+'）');
  }catch(e){toast('❌ 导出失败：当前浏览器不支持文件下载');}
}
/* 返回 -1 = 未写入（结构不对 / 用户取消）；返回 {n,bad} = 已写入 */
function applyBackup(text){
  var data=null;
  try{data=JSON.parse(String(text==null?'':text));}catch(e){toast('❌ 备份文件不是合法 JSON，现有数据未改动');return -1;}
  if(!data||data.app!=='ming-quiz'||!data.values||typeof data.values!=='object'){toast('❌ 这不是「知识问答」的备份文件，现有数据未改动');return -1;}
  var ks=Object.keys(data.values).filter(function(k){return k.indexOf('bt_qa_')===0;});
  if(!ks.length){toast('❌ 备份里没有可导入的数据，现有数据未改动');return -1;}
  if(!confirm('导入会覆盖当前的成绩 / 薄弱题 / 自定义题库（共 '+ks.length+' 项），继续？'))return -1;
  var n=0,bad=0;
  ks.forEach(function(k){var v=data.values[k];if(v==null)return;if(safeSet(k,String(v)))n++;else bad++;});
  return {n:n,bad:bad};
}
function importAllData(done){
  var inp=document.createElement('input');
  inp.type='file';inp.accept='application/json,.json';inp.style.display='none';
  inp.onchange=function(){
    var f=inp.files&&inp.files[0];
    if(!f)return;
    var r=new FileReader();
    r.onload=function(){
      var res=applyBackup(r.result);
      if(res&&res.n){
        custom=loadCustom();            /* 内存里的题库是启动时读的，导入后必须重读，否则书架不变 */
        toast('✅ 已导入 '+res.n+' 项数据'+(res.bad?('，'+res.bad+' 项写入失败'):''));
        renderShelf();
        if(done)done();
      }
    };
    r.onerror=function(){toast('❌ 读取文件失败');};
    try{r.readAsText(f);}catch(e){toast('❌ 读取文件失败');}
  };
  document.body.appendChild(inp);inp.click();
}

/* ---------- 统计 ---------- */
function openStats(){
  var ov=overlayPanel('📊 成绩统计');
  var m=loadStats();
  function cardFor(prefix,label,icon,bk){
    var s=m[prefix]||{n:0,c:0},bi=bestInfo(prefix);
    var c=h('div','stat-card');
    c.appendChild(ht('div','t',(icon?icon+' ':'')+label));
    /* P2-A3：键存在即「已挑战」——0 分、负分也是成绩，不能显示成「未挑战」 */
    c.appendChild(ht('div','big'+(bi.found?'':' empty'),bi.found?('⭐ '+bi.best):'未挑战'));
    var sub=h('div','sub');
    var s1=ht('span',null,'做题 ');s1.appendChild(ht('b',null,String(s.n)));sub.appendChild(s1);
    var s2=ht('span',null,'正确率 ');s2.appendChild(ht('b',null,(s.n?Math.round(s.c/s.n*100):0)+'%'));sub.appendChild(s2);
    c.appendChild(sub);
    var ds=bk?qaDiffs(bk):null;
    var tier=ht('div','sub','难度 ');
    tier.appendChild(ht('b',null,ds?ds[getRank(bk)].n:'—'));
    c.appendChild(tier);
    return c;
  }
  // 总览
  var tn=0,tc=0;for(var k in m){if(m.hasOwnProperty(k)){tn+=m[k].n||0;tc+=m[k].c||0;}}
  var tot=h('div','stat-grid');tot.style.marginBottom='12px';
  var c1=h('div','stat-card');c1.appendChild(ht('div','t','🧮 累计做题'));
  c1.appendChild(ht('div','big',String(tn)));c1.appendChild(ht('div','sub','正确率 '+(tn?Math.round(tc/tn*100):0)+'%'));
  var c2=h('div','stat-card');c2.appendChild(ht('div','t','😵 薄弱题'));
  c2.appendChild(ht('div','big'+(loadWeak().length?'':' empty'),String(loadWeak().length)));
  c2.appendChild(ht('div','sub','「😵 不会」自动沉淀'));
  tot.appendChild(c1);tot.appendChild(c2);ov.p.appendChild(tot);

  /* P2-A3：最近 30 天趋势（纯 div 条状图，不引库） */
  var days=trendDays(30),maxN=1,totN=0,act=0;
  days.forEach(function(d){if(d.n>maxN)maxN=d.n;if(d.n){act++;totN+=d.n;}});
  var secT=ht('div','section-title','📈 最近 30 天');ov.p.appendChild(secT);
  var trend=h('div','trend');
  days.forEach(function(d){
    var col=h('div','tcol');
    col.title=d.k+(d.n?('：做 '+d.n+' 题 · 对 '+d.c+' 题'):'：无记录');
    if(d.n){
      var pct=Math.round(d.c/d.n*100),hAll=Math.max(4,Math.round(d.n/maxN*100));
      if(pct<100){var bad=h('div','tbar bad');bad.style.height=Math.round(hAll*(100-pct)/100)+'%';col.appendChild(bad);}
      if(pct>0){var good=h('div','tbar ok');good.style.height=Math.max(2,Math.round(hAll*pct/100))+'%';col.appendChild(good);}
    }else{
      var z=h('div','tbar zero');z.style.height='3px';col.appendChild(z);
    }
    trend.appendChild(col);
  });
  ov.p.appendChild(trend);
  ov.p.appendChild(ht('div','muted',act?('最近 30 天有 '+act+' 天有记录 · 共 '+totN+' 题'):'最近 30 天还没有记录，做几题就会出现趋势'));

  var sec=ht('div','section-title','分类战绩');ov.p.appendChild(sec);
  var grid=h('div','stat-grid');
  Object.keys(QA_TYPES).forEach(function(bk){if(bk==='online')return;var T=QA_TYPES[bk];grid.appendChild(cardFor('b:'+bk,T.name,T.icon,bk));});
  Object.keys(custom).forEach(function(name){grid.appendChild(cardFor('c:'+name,name,'📝',null));});
  grid.appendChild(cardFor('b:online','联网题库','🌐',null));
  ov.p.appendChild(grid);
  /* P2-A2：备份入口 */
  var io=h('div','row');io.style.marginTop='14px';io.style.gap='8px';
  var exB=h('button','btn gold','💾 导出数据');exB.style.flex='1';exB.onclick=function(){exportAllData();};
  var imB=h('button','btn ghost','📥 导入备份');imB.style.flex='1';
  imB.onclick=function(){importAllData(function(){closeOverlay(ov);openStats();});};
  io.appendChild(exB);io.appendChild(imB);ov.p.appendChild(io);
  ov.p.appendChild(ht('div','muted','成绩按「分类 + 难度」记录；⭐ 最佳分可为 0 或负分，出现即代表已挑战；数据存于本机浏览器，可用「导出/导入」备份。'));
}

/* ---------- 通用 overlay ---------- */
function overlayPanel(title,kind){
  // 同一时刻只保留一个浮层，避免出现重复 id="curOverlay"
  if(overlayRoot){var olds=overlayRoot.querySelectorAll('.ov');for(var i=0;i<olds.length;i++){if(olds[i].__nav)navDrop(olds[i].__nav);if(olds[i].parentNode)olds[i].parentNode.removeChild(olds[i]);}}
  var ov=h('div','ov');ov.id='curOverlay';ov.__nav=kind||'overlay';navPush(ov.__nav);ov.__seq=NAV_SEQ;
  var p=h('div','panel');
  var close=h('button','close','✕');close.onclick=function(){closeOverlay({ov:ov,p:p});};
  var h3=h('h3');h3.textContent=title;
  p.appendChild(close);p.appendChild(h3);
  ov.appendChild(p);
  overlayRoot.appendChild(ov);
  return {ov:ov,p:p};
}
function closeOverlay(o){
  if(!o||!o.ov)return;
  var _wasTop=false;
  if(o.ov.__nav){_wasTop=(navTop()===o.ov.__nav);navDrop(o.ov.__nav);}
  if(o.ov.parentNode)o.ov.parentNode.removeChild(o.ov);
  /* C6：浮层开的时候压过一帧，关掉时顺手弹回去，返回键不用点好几次才退出。
     NAV_BUSY=true 说明正处在「返回键」引发的回退里，那一帧已经被 popstate 吃掉了，别再补一次。
     setTimeout 兜底：history 只剩一帧时 back() 不触发 popstate，NAV_BUSY 不能卡在 true。 */
  var _curState=null;try{_curState=history.state;}catch(e){}
  var _ownFrame=!!(_curState&&_curState.qnav&&_curState.seq!=null&&_curState.seq===o.ov.__seq);
  if(_wasTop&&_ownFrame&&!NAV_BUSY){try{NAV_BUSY=true;history.back();setTimeout(function(){NAV_BUSY=false;},300);}catch(e){NAV_BUSY=false;}}
}

/* ---------- 启动 ---------- */
function setVH(){
  try{
    var vh=(window.visualViewport&&window.visualViewport.height)||window.innerHeight||0;
    if(vh)document.documentElement.style.setProperty('--vh',(vh/100)+'px');
    var tb=document.getElementById('topbar');
    if(tb)document.documentElement.style.setProperty('--hdh',tb.offsetHeight+'px');
  }catch(e){}
}
function init(){
  shelfEl=$('shelf');stageEl=$('stage');overlayRoot=$('overlayRoot');
  /* P2-A2：存储写满时由引擎的 safeSet 调这里（只提示一次，不弹窗） */
  window.__quotaWarn=function(){toast('⚠️ 本地存储已满：请到「📊 统计」→「💾 导出数据」备份后清理旧数据');};
  setVH();window.addEventListener('resize',setVH);window.addEventListener('orientationchange',setVH);
  buildMusicList();
  $('backBtn').onclick=function(){
    /* P0-3：线上 / 是 404（无大厅），不再跳 ../index.html。回到书架即可；
       仅在答题中途才弹「进度将丢失」确认，书架上点它只是重渲染。 */
    if(quizOver===false&&qlist&&qlist.length){if(!confirm('返回书架？当前进度将丢失。'))return;}
    cancelPending();quizOver=true;renderShelf();
  };
  $('statsBtn').onclick=function(){openStats();};
  $('musicBtn').onclick=function(){openMusic();};
  $('settingsBtn').onclick=function(){openSettings();};
  /* P2-A4：键盘 1-4 选选项、输入框 Enter 提交。
     只在答题界面生效：书架/浮层/结算页按数字键无副作用；手写题（textarea）里 Enter 是换行，不提交。 */
  document.addEventListener('keydown',function(e){
    try{
      if(e.ctrlKey||e.metaKey||e.altKey)return;
      if(!stageEl||stageEl.hidden)return;
      if(document.getElementById('curOverlay'))return;
      if(quizOver)return;
      var ae=document.activeElement,tag=ae&&ae.tagName?String(ae.tagName).toUpperCase():'';
      if(tag==='TEXTAREA')return;                                  /* 手写/代码：Enter 与数字都是编辑 */
      var k=String(e.key||'');
      if(k==='Enter'){
        var ti=stageEl.querySelector('input[type=text]');
        if(!ti||!String(ti.value||'').trim())return;
        var sb=stageEl.querySelector('.row .btn.gold')||stageEl.querySelector('.btn.gold');
        if(sb&&!sb.disabled){e.preventDefault();sb.click();}
        return;
      }
      if(k>='1'&&k<='4'){
        if(tag==='INPUT')return;                                   /* 输入框里数字是打字 */
        var opts=stageEl.querySelectorAll?stageEl.querySelectorAll('.obtn'):[];
        if(!opts||!opts.length)return;
        var i=k.charCodeAt(0)-49;
        if(opts[i]&&!opts[i].disabled){e.preventDefault();opts[i].click();}
      }
    }catch(err){}
  });
  navInit();
  renderShelf();
  // 启动时不自动联网，避免首页卡顿；联网在书架「🔄 联网更新题库」触发
  registerSW();
}

/* ---------- PWA：离线状态文案 ---------- */
function pwaState(){
  try{
    if(!('serviceWorker' in navigator))return '⚠️ 当前浏览器不支持离线缓存，联网时照常可用。';
    var proto=location.protocol,host=location.hostname;
    var secure=(proto==='https:')||host==='localhost'||host==='127.0.0.1'||host==='[::1]';
    if(!secure)return 'ℹ️ 当前是非 https 环境（如本地双击打开），不会启用离线缓存，这是正常的。';
    if(navigator.serviceWorker.controller)return '✅ 已缓存到本机：断网也能打开、也能完整答题。';
    return '⏳ 首次打开需要联网缓存资源，稍等片刻即可离线使用。';
  }catch(e){return 'ℹ️ 无法读取离线状态，不影响正常使用。';}
}

/* ---------- PWA：新版本提示条 ---------- */
var swWaiting=null;
function showUpdateBar(){
  if(document.getElementById('updateBar'))return;
  var b=h('div',null,'🔄 发现新版本，点击刷新');
  b.id='updateBar';
  b.onclick=function(){
    b.textContent='正在更新…';
    try{if(swWaiting)swWaiting.postMessage({type:'SKIP_WAITING'});}catch(e){}
    setTimeout(function(){location.reload();},350);
  };
  document.body.appendChild(b);
}
/* ---------- PWA：Service Worker 注册 ----------
   只在安全上下文（https / localhost / 127.0.0.1）注册；
   file:// 双击打开或非 https 局域网地址会静默跳过，不抛错、不打断使用。 */
function registerSW(){
  try{
    if(!('serviceWorker' in navigator))return;
    var proto=location.protocol;
    if(proto!=='https:'&&proto!=='http:')return;         // file: / 其他协议直接跳过
    var host=location.hostname;
    var secure=(proto==='https:')||host==='localhost'||host==='127.0.0.1'||host==='[::1]';
    if(!secure)return;                                    // http://192.168.x 不是安全上下文
    navigator.serviceWorker.register('./sw.js',{scope:'./'}).then(function(reg){
      // 上次打开时已经下载好的新版本：直接提示，不偷偷替用户刷新
      if(reg&&reg.waiting&&navigator.serviceWorker.controller){swWaiting=reg.waiting;showUpdateBar();}
      reg.addEventListener('updatefound',function(){
        var nw=reg.installing;
        if(!nw)return;
        nw.addEventListener('statechange',function(){
          // installed 且页面仍被旧 SW 接管 = 新版在等待，给用户一个刷新入口
          if(nw.state==='installed'&&navigator.serviceWorker.controller){swWaiting=nw;showUpdateBar();}
        });
      });
    }).catch(function(){/* 注册失败（如隐私模式）静默忽略，应用照常可用 */});
  }catch(e){/* 老浏览器 / 被策略禁用：静默忽略 */}
}

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();

})();
