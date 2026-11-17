/* 课程数据门禁：deps 无环/无悬空、七段齐全、题量充足、kp-tag 对应。
   用法：node quiz/.build/_course.cjs [--full]
   默认 P0 模式：content=null 的骨架节跳过内容校验；--full 模式全量校验（P1 填充后用）。 */
'use strict';
const fs=require('fs'),path=require('path');
const ROOT=path.resolve(__dirname,'..');
const FULL=process.argv.indexOf('--full')>=0;
const pools=JSON.parse(fs.readFileSync(path.join(ROOT,'data','pools.json'),'utf8'));
const errs=[],warns=[];
let total=0,fullLessons=0;
/* 题库按 tag 的题数 */
function tagCount(courseId,tag){
  if(courseId==='code'){
    let n=0;for(const d in pools.code)pools.code[d].forEach(it=>{if((it[2]||'all')===tag||tag==='all')n++;});return n;
  }
  let n=0;for(const d in pools.circuit)pools.circuit[d].forEach(it=>{if(it[2]===tag)n++;});return n;
}
const FILES=['course_circuit.json','course_code.json'];
FILES.forEach(f=>{
  const c=JSON.parse(fs.readFileSync(path.join(ROOT,'data',f),'utf8'));
  const ids=new Set(c.lessons.map(l=>l.id));
  if(ids.size!==c.lessons.length)errs.push(f+' 存在重复 lesson id');
  c.lessons.forEach(l=>{
    total++;
    /* dep 悬空 */
    (l.dep||[]).forEach(d=>{if(!ids.has(d))errs.push(f+'/'+l.id+' dep 悬空: '+d);});
    /* tags 非空且题库中存在 */
    if(!Array.isArray(l.tags)||!l.tags.length)errs.push(f+'/'+l.id+' 缺 tags');
    else l.tags.forEach(t=>{
      if(c.id==='circuit'&&tagCount('circuit',t)===0)errs.push(f+'/'+l.id+' tag 无对应题: '+t);
    });
    /* 合并题量 >=5（过关测验需要 5 题） */
    const avail=c.id==='code'?Infinity:l.tags.reduce((s,t)=>s+tagCount('circuit',t),0);
    if(avail<5)errs.push(f+'/'+l.id+' 可用题量 '+avail+' <5（过关卡凑不齐）');
    /* 内容校验 */
    if(l.content){
      fullLessons++;
      const need=['hook','concepts','examples','pitfalls','practice','mastery','tutor'];
      need.forEach(k=>{if(l.content[k]==null)errs.push(f+'/'+l.id+' 缺段: '+k);});
      if(Array.isArray(l.content.concepts)&&l.content.concepts.length<2)errs.push(f+'/'+l.id+' concepts 少于 2 块');
      if(Array.isArray(l.content.examples)&&l.content.examples.length<1)errs.push(f+'/'+l.id+' 无例题');
      (l.content.examples||[]).forEach((ex,i)=>{
        if(!ex.answer)errs.push(f+'/'+l.id+' 例题'+i+' 缺 answer');
        if(!Array.isArray(ex.steps)||!ex.steps.length)errs.push(f+'/'+l.id+' 例题'+i+' 无分步');
        if(!ex.steps||!ex.steps.join('').includes('验算'))warns.push(f+'/'+l.id+' 例题'+i+' 未见验算步骤');
      });
      if(l.content.mastery&&l.content.mastery.count<5)errs.push(f+'/'+l.id+' 过关题 <5');
      if(l.content.mastery&&l.content.mastery.pass<Math.ceil(l.content.mastery.count*0.6))warns.push(f+'/'+l.id+' 过关线偏低');
      if(Array.isArray(l.content.tutor)&&l.content.tutor.length<3)errs.push(f+'/'+l.id+' 导师脚本 <3 轮');
    } else if(FULL){
      errs.push(f+'/'+l.id+' [完整模式] content 未填充');
    }
  });
  /* 环检测（DFS） */
  const map={};c.lessons.forEach(l=>map[l.id]=l.dep||[]);
  const state={};
  function dfs(id){if(state[id]===1)return true;if(state[id]===2)return false;state[id]=1;
    for(const d of map[id]||[]){if(dfs(d))return true;}state[id]=2;return false;}
  for(const id of ids){if(dfs(id)){errs.push(f+' dep 存在环（涉及 '+id+'）');break;}}
  /* 每个 tag 至少被一节覆盖 */
  const covered=new Set();c.lessons.forEach(l=>l.tags.forEach(t=>covered.add(t)));
  if(c.id==='circuit'){
    const allTags=new Set();for(const d in pools.circuit)pools.circuit[d].forEach(it=>allTags.add(it[2]));
    /* 期末真题用 'circuit' 作通用分类标签（真实知识点在 meta.topic），不代表具体知识点，不算未覆盖 */
    allTags.forEach(t=>{if(t==='circuit')return;if(!covered.has(t))warns.push(f+' tag 未被任何节点覆盖: '+t);});
  }
});
console.log('课程校验['+(FULL?'完整':'P0')+'模式]：节点 '+total+'，样例节 '+fullLessons);
warns.forEach(w=>console.log('  ⚠ '+w));
if(errs.length){errs.forEach(e=>console.error('  ✗ '+e));console.error('=== 课程校验失败：'+errs.length+' 项 ===');process.exit(1);}
console.log('=== 课程校验通过：0 错误，'+warns.length+' 提示 ===');
