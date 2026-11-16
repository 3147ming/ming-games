/* P1 内容注入器：node .build/_p1_inject.cjs <batch-file.cjs>
   批次文件须 module.exports={course:'circuit'|'code',data:{lessonId:contentObj,...}}
   断言：目标节存在且尚未填充；七段齐全；例题分步含验算；mastery>=5；tutor>=3；concepts>=2；
   电路节例题若题干能在题库精确匹配，答案必须一致（讲错题红线）。 */
'use strict';
const fs=require('fs'),path=require('path');
const ROOT=path.resolve(__dirname,'..');
const batchPath=process.argv[2];
if(!batchPath){console.error('缺少批次文件路径');process.exit(1);}
const batch=require(path.resolve(batchPath));
if(!batch.course||!batch.data){console.error('批次文件须导出 {course,data}');process.exit(1);}
const f=batch.course==='circuit'?'course_circuit.json':batch.course==='code'?'course_code.json':null;
if(!f){console.error('course 只能是 circuit/code');process.exit(1);}
const fp=path.join(ROOT,'data',f);
const c=JSON.parse(fs.readFileSync(fp,'utf8'));
const pools=JSON.parse(fs.readFileSync(path.join(ROOT,'data','pools.json'),'utf8'));
// 题库题干->答案 映射（电路）
const bankQ={};
if(batch.course==='circuit')for(const d in pools.circuit)pools.circuit[d].forEach(it=>{bankQ[String(it[0]).trim()]=it[1];});
const SEG=['hook','concepts','examples','pitfalls','practice','mastery','tutor'];
let errs=[],injected=0,checkQ=0;
for(const id in batch.data){
  const lesson=c.lessons.find(l=>l.id===id);
  if(!lesson){errs.push(id+' 节点不存在');continue;}
  if(lesson.content){errs.push(id+' 已有内容，拒绝覆盖（防重复注入）');continue;}
  const ct=batch.data[id];
  SEG.forEach(k=>{if(ct[k]==null)errs.push(id+' 缺段 '+k);});
  if(Array.isArray(ct.concepts)&&ct.concepts.length<2)errs.push(id+' concepts<2');
  if(Array.isArray(ct.examples)&&ct.examples.length<1)errs.push(id+' 无例题');
  (ct.examples||[]).forEach((ex,i)=>{
    if(!ex.answer)errs.push(id+' 例题'+i+' 缺 answer');
    if(!Array.isArray(ex.steps)||!ex.steps.length)errs.push(id+' 例题'+i+' 无分步');
    if(!ex.steps||!ex.steps.join('').includes('验算'))errs.push(id+' 例题'+i+' 缺验算');
    // 题干精确对账题库
    if(batch.course==='circuit'&&bankQ[String(ex.q).trim()]!=null){
      checkQ++;
      if(String(bankQ[String(ex.q).trim()]).trim()!==String(ex.answer).trim())
        errs.push(id+' 例题'+i+' 答案与题库冲突! 题库='+bankQ[String(ex.q).trim()]+' 本文='+ex.answer+' | '+ex.q);
    }
  });
  (ct.pitfalls||[]).forEach((p,i)=>{if(!p.wrong||!p.right||!p.why)errs.push(id+' 易错点'+i+' 字段不全');});
  if(ct.mastery&&ct.mastery.count<5)errs.push(id+' mastery<5');
  if(ct.mastery&&ct.mastery.pass<Math.ceil(ct.mastery.count*0.6))errs.push(id+' 过关线偏低');
  if(Array.isArray(ct.tutor)&&ct.tutor.length<3)errs.push(id+' tutor<3');
  if(!errs.some(e=>e.startsWith(id+' '))) { lesson.content=ct; injected++; }
}
if(errs.length){errs.forEach(e=>console.error('  ✗ '+e));console.error('=== 注入失败：'+errs.length+' 项（未写盘）===');process.exit(1);}
fs.writeFileSync(fp,JSON.stringify(c,null,2)+'\n','utf8');
console.log('=== 注入成功：'+f+' 新增 '+injected+' 节内容；题干对账题库 '+checkQ+' 题全部一致 ===');
