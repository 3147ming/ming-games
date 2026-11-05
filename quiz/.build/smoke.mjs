import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import WebSocket from 'ws';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const FILE = 'file:///D:/Projects/_github_pages/ming-games/quiz/index.html';
const PORT = 9333;

function httpGet(path){return new Promise((res,rej)=>{const http=require('http');http.get({host:'127.0.0.1',port:PORT,path},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(d));}).on('error',rej);});}

const edge = spawn(EDGE, ['--headless=new','--disable-gpu','--no-sandbox','--remote-debugging-port='+PORT,'about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function main(){
  await sleep(1500);
  let targets=[];
  for(let i=0;i<20;i++){try{targets=JSON.parse(await httpGet('/json'));if(targets.length)break;}catch(e){}await sleep(300);}
  const page=targets.find(t=>t.type==='page')|| targets[0];
  if(!page){console.error('NO_PAGE');process.exit(1);}
  const ws=new WebSocket(page.webSocketDebuggerUrl);
  const pending={};let id=0;
  const send=(method,params)=>new Promise((res,rej)=>{const my=++id;pending[my]={res,rej};ws.send(JSON.stringify({id:my,method,params:params||{}}));});
  const errors=[];const logs=[];
  ws.on('message',m=>{const o=JSON.parse(m);if(o.id&&pending[o.id]){pending[o.id].res(o.result);delete pending[o.id];}
    if(o.method==='Runtime.consoleAPICalled'){logs.push((o.params.args||[]).map(a=>a.value).join(' '));}
    if(o.method==='Runtime.exceptionThrown'){errors.push(o.params.exceptionDetails.exception?o.params.exceptionDetails.exception.description:o.params.exceptionDetails.text);}});
  await new Promise(r=>ws.on('open',r));
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate',{url:FILE});
  await sleep(2500);
  // 触发一次渲染检查
  const evalRes=await send('Runtime.evaluate',{expression:'(function(){var books=document.querySelectorAll(".book");var shelf=document.getElementById("shelf");return JSON.stringify({books:books.length, shelfShown: shelf && !shelf.hidden, title: document.title, hasQA: typeof QA_TYPES!=="undefined", codeGen: (typeof QA_TYPES!=="undefined" && QA_TYPES.code && typeof QA_TYPES.code.gen==="function")});})()',returnByValue:true});
  console.log('EVAL:', evalRes.result?evalRes.result.value:'(none)');
  console.log('CONSOLE_LOGS:', logs.slice(0,20).join(' | ')||'(none)');
  console.log('PAGE_ERRORS:', errors.length?errors.join(' | '):'(none)');
  ws.close();edge.kill('SIGKILL');process.exit(errors.length?2:0);
}
main().catch(e=>{console.error('ERR',e);try{edge.kill('SIGKILL');}catch(_){}process.exit(1);});
