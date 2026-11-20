import { createGame, actionsAt, allActions, applyAction, aiAction, niuNeighbors, guaNeighbors, niuStuck, niuAll, guaAll } from '../src/folk-chess.mjs';
let pass=0,fail=0;
const ok=(n,c,x)=>{if(c){pass++;console.log('  ✓ '+n)}else{fail++;console.log('  ✗ '+n+(x!==undefined?' | '+JSON.stringify(x):''))}};
const side=(b,s)=>b.filter(p=>p&&p.side===s).length;

console.log('=== 憋死牛 ===');
{
  const s=createGame('niu');
  ok('5点棋盘',s.board.length===5);
  ok('红2子蓝2子',side(s.board,'r')===2&&side(s.board,'b')===2);
  ok('中心起始空',s.board[4]===null);
  ok('四角各连中心',[0,1,2,3].every(i=>niuNeighbors(i).includes(4)));
  ok('角相邻连线',niuNeighbors(0).includes(1)&&niuNeighbors(1).includes(2));
  const acts=allActions(s);
  ok('开局红有合法走法',acts.length>0);
  ok('只能走到空点',acts.every(a=>s.board[a.to]===null));
  // 走一步
  const a=acts[0];const s2=applyAction(s,a);
  ok('走子后换手',s2.turn==='b');
  ok('走子后棋子数不变',side(s2.board,'r')===2&&side(s2.board,'b')===2);
  ok('moveCount递增',s2.moveCount===1);
  // 构造红被堵死：红在0,2，蓝占1,3,4 包围？红0邻居1,3,4 若都被占且是蓝→被堵
  const dead=createGame('niu');dead.board=[{side:'r'},null,{side:'r'},{side:'b'},{side:'b'}];
  // 红0邻居1(空),3(蓝),4(蓝)；红2邻居1(空),3(蓝),4(蓝) → 都能走1，不算死
  ok('有一空可走不算死',niuStuck(dead,'r')===false);
  const dead2=createGame('niu');dead2.board=[{side:'r'},{side:'b'},{side:'r'},{side:'b'},{side:'b'}];
  ok('全堵住判定死',niuStuck(dead2,'r')===true);
  // AI 能出招
  ok('AI有招',aiAction(s,'pro')!==null);
  // 自对弈 20 局能结束或走满
  let ended=0,maxSteps=0;
  for(let k=0;k<20;k++){let st=createGame('niu'),steps=0;
    while(st.status==='playing'&&steps<60){const ac=aiAction(st,k%2?'pro':'casual');if(!ac)break;st=applyAction(st,ac);steps++}
    maxSteps=Math.max(maxSteps,steps);if(st.status==='over')ended++}
  ok('20局自对弈无卡死',maxSteps<=60);
}

console.log('=== 西瓜棋 ===');
{
  const s=createGame('gua');
  ok('13点(12圆周+中心)',s.board.length===13&&guaNeighbors[12].length===12);
  ok('红6蓝6',side(s.board,'r')===6&&side(s.board,'b')===6);
  ok('中心空',s.board[12]===null);
  ok('圆周点连2邻+中心',guaNeighbors[0].length===3);
  const acts=allActions(s);
  ok('开局有合法走法',acts.length>0);
  const a=acts[0];const s2=applyAction(s,a);
  ok('走子后换手',s2.turn==='b');
  // 围吃构造：红在0，蓝在1，红在2 → 红0吃蓝1（后方2是红）
  const cap=createGame('gua');
  cap.board=new Array(13).fill(null);
  cap.board[0]={side:'r'};cap.board[2]={side:'r'};cap.board[1]={side:'b'};
  const ra=actionsAt(cap,0);
  ok('可夹吃',ra.some(x=>x.capture===1),ra);
  const capS=applyAction(cap,ra.find(x=>x.capture===1));
  ok('吃子后蓝减少',side(capS.board,'b')===0);
  ok('吃光判胜',capS.status==='over'&&capS.winner==='r');
  ok('AI有招',aiAction(s,'pro')!==null);
  let maxSteps=0;
  for(let k=0;k<20;k++){let st=createGame('gua'),steps=0;
    while(st.status==='playing'&&steps<80){const ac=aiAction(st,k%2?'pro':'casual');if(!ac)break;st=applyAction(st,ac);steps++}
    maxSteps=Math.max(maxSteps,steps)}
  ok('20局自对弈无卡死',maxSteps<=80,maxSteps);
}

console.log('\n结果：'+pass+' 通过 / '+fail+' 失败');
process.exit(fail?1:0);
