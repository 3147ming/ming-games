/* B 批：知识卡先学后练 + SRS 间隔复习 —— 源码改造（engine_core.js + quiz-ui.js）
   全部用锚点唯一性校验（rep：旧串在原文件必须恰好出现 1 次），避免静默错位。 */
const fs = require('fs');
const CORE = 'D:/Projects/_github_pages/ming-games/quiz/.build/engine_core.js';
const UI   = 'D:/Projects/_github_pages/ming-games/quiz/.build/quiz-ui.js';

const DRY = process.argv.indexOf('--dry') >= 0;
const files = { [CORE]: fs.readFileSync(CORE, 'utf8'), [UI]: fs.readFileSync(UI, 'utf8') };

function rep(path, oldStr, newStr, tag) {
  const s = files[path];
  const n = s.split(oldStr).length - 1;
  if (n !== 1) { console.log('✗ [' + tag + '] 锚点命中 ' + n + ' 次（必须 1 次）'); process.exit(1); }
  if (!DRY) files[path] = s.replace(oldStr, newStr);
  console.log('✓ [' + tag + '] 锚点命中 1 次' + (DRY ? '（dry）' : ' · 已写'));
}

/* ---- 公共代码块 ---- */
const SRS_BLOCK = `/* B 批：SRS 间隔复习（SM-2 简化，6 级阶梯 1/2/4/7/15/30 天） */
var SRS_INTERVALS=[1,2,4,7,15,30];
function srsInit(){return {lv:0,due:Date.now()+86400000};}
function srsDue(rec){var s=rec&&rec.srs;if(!s)return false;return s.due<=Date.now();}
function srsAdvance(rec,correct){
  var s=rec&&rec.srs;if(!s){rec.srs=srsInit();s=rec.srs;}
  if(correct){
    s.lv=Math.min(s.lv+1,SRS_INTERVALS.length-1);
    s.due=Date.now()+SRS_INTERVALS[s.lv]*86400000;
    return s.lv>=SRS_INTERVALS.length-1;   /* 30 天档答对 = 掌握 */
  }
  s.lv=0;s.due=Date.now()+86400000;        /* 明天再复习 */
  return false;
}
/* loadWeak 每次返回新解析对象；改动某条 srs/t 后必须按 type+q 找回再存 */
function srsTouch(rec){if(!rec)return;var a=loadWeak();for(var i=0;i<a.length;i++){if(a[i]&&a[i].type===rec.type&&a[i].q===rec.q){a[i].srs=rec.srs;a[i].t=rec.t;saveWeak(a);return;}}}`;

const KNOW_BLOCK = `/* B 批：知识卡先学后练（每个分类核心知识点，开局前展示） */
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
function startSrs(){
  var a=loadWeak().filter(srsDue);
  if(!a.length){toast('⏰ 今天没有到期复习题：错题会按 1/2/4/7/15/30 天间隔安排复习');return;}
  reviewMode=true;reviewOne=false;autoMode=false;quizOver=false;typeKey='b:srs';typeLabel='SRS 复习';qaSection='choice';handMode=false;
  navPush('quiz');
  qlist=weakSort(a).map(weakToQ);   /* 次数多 + 新的在前，到期题内也有轻重 */
  ok=0;qidx=0;score=0;total=qlist.length;roundWrong=[];showQuestion();
}`;

/* ============ engine_core.js ============ */

// 1) SRS 函数块（在 WEAK_CAP 之后、loadWeak 之前）
rep(CORE, 'var WEAK_CAP=150;', 'var WEAK_CAP=150;\n' + SRS_BLOCK, 'core-srs-block');

// 2) loadWeak 自愈补 srs
rep(CORE,
`  if(!Array.isArray(a))a=[];
  /* 自愈：旧版本上限是 50，历史数据或异常写入可能超出 150，读的时候顺手裁一次 */`,
`  if(!Array.isArray(a))a=[];
  /* B 批：SRS 自愈 —— 旧条目缺 srs 字段时补上（间隔复习首屏即生效） */
  for(var _si=0;_si<a.length;_si++){if(a[_si]&&!a[_si].srs)a[_si].srs=srsInit();}
  /* 自愈：旧版本上限是 50，历史数据或异常写入可能超出 150，读的时候顺手裁一次 */`,
  'core-loadWeak-selfheal');

// 3) addWeak 新条目补 srs
rep(CORE,
`    a.push({n:1,t:Date.now(),type:item.type,diff:item.diff,q:item.q,a:item.a,
      opts:item.opts?item.opts.slice():null,code:item.code,exp:item.exp,sol:item.sol,steps:item.steps,
      fillin:item.fillin,pick:item.pick||null,src:item.src||null});`,
`    a.push({n:1,t:Date.now(),type:item.type,diff:item.diff,q:item.q,a:item.a,
      opts:item.opts?item.opts.slice():null,code:item.code,exp:item.exp,sol:item.sol,steps:item.steps,
      fillin:item.fillin,pick:item.pick||null,src:item.src||null,srs:srsInit()});`,
  'core-addWeak-srs');

/* ============ quiz-ui.js ============ */

// 4) renderShelf 加 ⏰ 待复习 按钮
rep(UI,
`  var _wn=loadWeak().length;
  var bWeak=ht('span','act','😵 薄弱题'+(_wn?(' · '+_wn):''));bWeak.onclick=function(){openWeakBook();};
  var bNew=ht('span','act','➕ 新建');bNew.onclick=function(){openNewCategory();};
  acts.appendChild(bWeak);acts.appendChild(bNew);sec1.appendChild(acts);`,
`  var _wn=loadWeak().length;
  var bWeak=ht('span','act','😵 薄弱题'+(_wn?(' · '+_wn):''));bWeak.onclick=function(){openWeakBook();};
  var _due=loadWeak().filter(srsDue).length;
  var bSrs=ht('span','act','⏰ 待复习'+(_due?(' · '+_due):''));bSrs.onclick=function(){startSrs();};
  var bNew=ht('span','act','➕ 新建');bNew.onclick=function(){openNewCategory();};
  acts.appendChild(bWeak);acts.appendChild(bSrs);acts.appendChild(bNew);sec1.appendChild(acts);`,
  'ui-shelf-srsbtn');

// 5) answer() review 分支顶部加 b:srs 处理
rep(UI,
`    var _roundR=(typeKey==='b:round');
    if(correct){`,
`    var _roundR=(typeKey==='b:round');
    /* B 批：SRS 复习局 —— 走间隔升档/重置，不复用 b:weak「答对即移除」语义 */
    if(typeKey==='b:srs'){
      if(correct){
        var _rec=Q&&Q.weak;
        if(_rec){
          var _mastered=srsAdvance(_rec,true);
          if(_mastered){removeWeak(_rec);fbR.textContent='✅ 答对了！连续 30 天档答对，已掌握并移出复习队列';}
          else{_rec.t=Date.now();srsTouch(_rec);var _iv=SRS_INTERVALS[_rec.srs.lv];fbR.textContent='✅ 答对了！下次复习：'+_iv+' 天后';}
        }else{ok++;fbR.textContent='✅ 答对了！';}
      }else{
        var _rec2=Q&&Q.weak;
        if(_rec2){srsAdvance(_rec2,false);_rec2.t=Date.now();srsTouch(_rec2);}
        fbR.textContent='❌ 正确答案：'+ans+'（明天再复习一次）';
        appendSol(fbR,Q);appendSteps(fbR,Q);appendExp(fbR,Q);appendSrc(fbR,Q);appendNextChip(fbR);
      }
      appendFb(fbR);
      if(correct)advance(800);else cancelPending();
      return;
    }
    if(correct){`,
  'ui-answer-bsrs');

// 6) answer() 普通局首次答对推进 SRS
rep(UI,
`    if(correct){ok++;score+=10;}`,
`    if(correct){ok++;score+=10;
      /* B 批：普通局首次答对 —— 若该题在薄弱题本里，推进其 SRS 间隔（达 30 天档则掌握移除并提示） */
      var _wa=loadWeak();
      for(var _wi=0;_wi<_wa.length;_wi++){if(_wa[_wi]&&_wa[_wi].type===typeKey&&_wa[_wi].q===Q.q){
        if(srsAdvance(_wa[_wi],true)){removeWeak(_wa[_wi]);toast('🎉 已通过 SRS 复习掌握：'+Q.q);}
        else{saveWeak(_wa);}
        break;}}}`,
  'ui-answer-normalsrs');

// 7) openWeakBook 行内复习状态
rep(UI,
`      var ago=ht('span','hint2',weakAgo(x.t));ago.style.cssText='font-size:11px;opacity:.7';
      row.appendChild(ago);`,
`      var ago=ht('span','hint2',weakAgo(x.t));ago.style.cssText='font-size:11px;opacity:.7';
      row.appendChild(ago);
      if(x.srs){
        var _rs=ht('span','hint2',srsDue(x)?'⏰ 今天可复习':'⏭ 下次 '+SRS_INTERVALS[x.srs.lv]+' 天');
        _rs.style.cssText='font-size:11px;opacity:.7;color:'+(srsDue(x)?'#d97706':'#888');
        row.appendChild(_rs);
      }`,
  'ui-weakbook-srsstatus');

// 8) KNOW_CARDS + maybeShowCard + startSrs（插在 startReview 之前）
rep(UI,
`function startReview(){`,
  KNOW_BLOCK + `
function startReview(){`,
  'ui-knowcards-block');

// 9) doStartType 开局弹卡接线
rep(UI,
`  ok=0;qidx=0;score=0;roundWrong=[];showQuestion();`,
`  ok=0;qidx=0;score=0;roundWrong=[];
  /* B 批：先学后练 —— 开启开关且该分类有知识卡时，开局前先弹知识卡覆盖层 */
  if(bk&&KNOW_CARDS[bk]&&JSON.parse(S.getItem('bt_qa_learn_before')||'false')){maybeShowCard(bk,function(){showQuestion();});}
  else{showQuestion();}`,
  'ui-dostarttype-card');

// 10) pickDiffPanel 加 📖 先学后练开关
rep(UI,
`  ov.p.appendChild(dr);
  var goS=h('button','btn gold','▶ 开始出题');goS.style.width='100%';goS.style.marginTop='4px';`,
`  ov.p.appendChild(dr);
  /* B 批：先学后练开关（持久化到 bt_qa_learn_before） */
  var _lb=!!JSON.parse(S.getItem('bt_qa_learn_before')||'false');
  var _tg=document.createElement('label');_tg.style.cssText='display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;margin-top:8px';
  var _cb=document.createElement('input');_cb.type='checkbox';_cb.checked=_lb;
  _cb.onchange=function(){safeSet('bt_qa_learn_before',_cb.checked?'true':'false');};
  _tg.appendChild(_cb);_tg.appendChild(ht('span',null,'📖 先学后练（开局先看知识卡）'));
  ov.p.appendChild(_tg);
  var goS=h('button','btn gold','▶ 开始出题');goS.style.width='100%';goS.style.marginTop='4px';`,
  'ui-pickdiff-toggle');

/* 重复标识符检查 */
['SRS_INTERVALS','srsInit','srsDue','srsAdvance','srsTouch','KNOW_CARDS','maybeShowCard','startSrs'].forEach(function(id){
  const re = new RegExp('\\b' + id + '\\b','g');
  const cCore = (files[CORE].match(re) || []).length;
  const cUI = (files[UI].match(re) || []).length;
  console.log('· ' + id + ' 出现：core=' + cCore + ' ui=' + cUI);
});

if (DRY) { console.log('\\nDRY 通过：所有锚点唯一，未写盘。'); process.exit(0); }

fs.writeFileSync(CORE, files[CORE], 'utf8');
fs.writeFileSync(UI, files[UI], 'utf8');
console.log('\\n已写盘：engine_core.js / quiz-ui.js');
