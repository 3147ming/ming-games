/* ===== Q1：单一状态源（由 build.js 与各 Node 探针在 FRAMEWORK 之后内联） =====
   8 个并行模式标志（autoMode / reviewMode / handMode / quizOver / locked /
   promoState / qaSection / customMixed）以前散在 30 多处直接赋值，靠 if 组合推断局面。
   现在：
   - qaState()        实时快照（从真实变量读，探针直接改变量也不会让快照过期）；
   - setQAState(patch) 唯一写入口，先合并、再断言、最后一次性写回全部全局镜像；
   - QA_STATE         最近一次通过断言的快照，供诊断与探针读取；
   - assertQAState()  关键生命周期入口的即时校验。
   合法性规则是 QALogic.validateState 纯函数（logic.js），Node 单测直接覆盖。
   为什么保留 8 个全局镜像：3000+ 行读点与既有探针都直接读这些变量，全改读点风险过高；
   写入口统一后，任何一处绕过 setQAState 的赋值都会在下一次断言里暴露。 */
/* typeof 兜底：部分探针的 FRAMEWORK 副本没有声明全部标志；重复 var 在同一 script 内
   会提升合并，赋值取的是「当前值」，不会把已有状态重置。 */
var autoMode=(typeof autoMode!=='undefined')?autoMode:false;
var reviewMode=(typeof reviewMode!=='undefined')?reviewMode:false;
var locked=(typeof locked!=='undefined')?locked:false;
var promoState=(typeof promoState!=='undefined')?promoState:'idle';
var selfWindow=(typeof selfWindow!=='undefined')?selfWindow:[];
var handMode=(typeof handMode!=='undefined')?handMode:false;
var quizOver=(typeof quizOver!=='undefined')?quizOver:false;
var qaSection=(typeof qaSection!=='undefined')?qaSection:'choice';
var customMixed=(typeof customMixed!=='undefined')?customMixed:false;

var QA_STATE_KEYS=['autoMode','reviewMode','handMode','quizOver','locked','promoState','qaSection','customMixed'];
var QA_STATE={};
function qaState(){
  return {autoMode:autoMode,reviewMode:reviewMode,handMode:handMode,quizOver:quizOver,
          locked:locked,promoState:promoState,qaSection:qaSection,customMixed:customMixed};
}
function setQAState(patch,ctx){
  var s=qaState(),k;
  for(k in patch){
    if(QA_STATE_KEYS.indexOf(k)<0)throw new Error('setQAState 收到未登记的字段：'+k+' @'+(ctx||''));
    s[k]=patch[k];
  }
  QALogic.validateState(s,ctx||'setQAState');
  QA_STATE=s;
  autoMode=s.autoMode;reviewMode=s.reviewMode;handMode=s.handMode;quizOver=s.quizOver;
  locked=s.locked;promoState=s.promoState;qaSection=s.qaSection;customMixed=s.customMixed;
  return s;
}
function assertQAState(ctx){
  var s=qaState();
  QALogic.validateState(s,ctx||'assertQAState');
  QA_STATE=s;
  return s;
}
