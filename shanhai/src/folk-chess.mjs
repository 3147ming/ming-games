/**
 * 民间棋核心 —— 憋死牛（区字棋）+ 西瓜棋。纯函数，Node 可单测。
 * 统一契约：createGame(mode) / actionsAt(s,i) / applyAction(s,a) / allActions(s) / aiAction(s,level)
 * side: 'r'(红/先) 'b'(蓝/后)。棋子 {side}。board 为一维点数组。
 */
'use strict';

/* ══════ 憋死牛（区字棋）："区"字 5 点，4 角 + 中心 ══════ */
// 点索引：0 左上 1 上中 2 右上 3 中心 4 左下 5 下中 6 右下 —— 实为 5 点：4角+中心
// 采用指令定义：5 点 = 4 角 + 中心。连线：四角各连中心 + 相邻角相连（构成"区"字框）
const NIU_POINTS = 5;                       // 0,1,2,3 四角；4 中心
const NIU_EDGES = [[0,1],[1,2],[2,3],[3,0],[0,4],[1,4],[2,4],[3,4]]; // 四边 + 四角到中心
function niuNeighbors(i) {
  const out = [];
  for (const [a,b] of NIU_EDGES) { if (a===i) out.push(b); if (b===i) out.push(a); }
  return [...new Set(out)];
}
function niuCreate() {
  // 每人 2 子。红占 0,2；蓝占 1,3；中心 4 空。先占中心者先手（这里红先）。
  const b = new Array(NIU_POINTS).fill(null);
  b[0]={side:'r'}; b[2]={side:'r'}; b[1]={side:'b'}; b[3]={side:'b'};
  return { mode:'niu', board:b, turn:'r', status:'playing', winner:null, moveCount:0 };
}
function niuActions(s, i) {
  const p = s.board[i]; if (!p || p.side !== s.turn) return [];
  const out = [];
  for (const j of niuNeighbors(i)) if (!s.board[j]) out.push({ from:i, to:j });
  return out;
}
function niuAll(s) {
  const out=[], s2={...s,turn:'r'}, s3={...s,turn:'b'};
  s.board.forEach((p,i)=>{ if(p&&p.side===s.turn) out.push(...niuActions(s,i)); });
  return out;
}
/** 判断 side 的两子是否被"堵死无法移动"（被堵方若一步可脱身则不算死）。 */
function niuStuck(s, side) {
  const st={...s,turn:side};
  return niuAll(st).length===0;
}
function niuApply(s, a) {
  const t=clone(s);
  const p=t.board[a.from]; t.board[a.from]=null; t.board[a.to]=p;
  t.moveCount=(t.moveCount||0)+1;
  // 走完后若对手两子全被堵死 → 走方胜
  if (niuStuck(t, other(s.turn))) { t.status='over'; t.winner=s.turn; }
  t.turn=other(s.turn);
  return t;
}
function niuEval(s, side) {
  const acts=niuAll({...s,turn:side}).length;
  const foeActs=niuAll({...s,turn:other(side)}).length;
  if (foeActs===0) return 1000;
  if (acts===0) return -1000;
  return acts - foeActs;
}

/* ══════ 西瓜棋：圆形 12 点 + 中心，各 6 子 ══════ */
// 12 个圆周点(0..11) + 中心(12)。边：圆周相邻 + 每个圆周点连中心（径向）
const GUA_RIM = 12, GUA_CENTER = 12, GUA_POINTS = 13;
const guaNeighbors = (() => {
  const nb=[];
  for(let i=0;i<GUA_POINTS;i++) nb.push([]);
  for(let i=0;i<GUA_RIM;i++){
    const nxt=(i+1)%GUA_RIM;
    nb[i].push(nxt); nb[nxt].push(i);       // 圆周相邻
    nb[i].push(GUA_CENTER); nb[GUA_CENTER].push(i); // 径向连中心
  }
  return nb.map(a=>[...new Set(a)]);
})();
function guaCreate() {
  const b=new Array(GUA_POINTS).fill(null);
  // 红占圆周 0-5，蓝占 6-11，中心空
  for(let i=0;i<6;i++) b[i]={side:'r'};
  for(let i=6;i<12;i++) b[i]={side:'b'};
  return {mode:'gua',board:b,turn:'r',status:'playing',winner:null,moveCount:0};
}
function guaActions(s,i){
  const p=s.board[i]; if(!p||p.side!==s.turn)return[];
  const out=[];
  for(const j of guaNeighbors[i]){
    if(!s.board[j]) out.push({from:i,to:j,capture:null});
    else if(s.board[j].side!==s.turn){
      // 围吃：落点后方（沿 i→j 方向再一格）是己方子或边界 → 夹吃
      const behind=2*j-i;
      const canCapture = (guaNeighbors[j].includes(behind) && s.board[behind] && s.board[behind].side===s.turn)
        || (!s.board[behind] && behind>=0 && behind<GUA_RIM); // 沿圆周方向冲出边界也可吃
      if(canCapture) out.push({from:i,to:j,capture:j});
    }
  }
  return out;
}
function guaAll(s){
  const out=[];s.board.forEach((p,i)=>{if(p&&p.side===s.turn)out.push(...guaActions(s,i))});return out;
}
function guaApply(s,a){
  const t=clone(s);const p=t.board[a.from];
  if(a.capture!=null) t.board[a.capture]=null;
  t.board[a.from]=null;t.board[a.to]=p;
  t.moveCount=(t.moveCount||0)+1;
  const foe=other(s.turn);
  let cnt=0;for(const q of t.board)if(q&&q.side===foe)cnt++;
  if(cnt===0){t.status='over';t.winner=s.turn}
  else if(guaAll({...t,turn:foe}).length===0){t.status='over';t.winner=s.turn}
  t.turn=foe;return t;
}
function guaEval(s,side){
  let mine=0,foe=0;
  for(const q of s.board){if(!q)continue;if(q.side===side)mine++;else foe++}
  return mine*10-foe*10 + guaAll({...s,turn:side}).length - guaAll({...s,turn:other(side)}).length;
}

/* ══════ 统一 API ══════ */
function clone(s){return {mode:s.mode,board:s.board.map(p=>p?{...p}:null),turn:s.turn,status:s.status,winner:s.winner,moveCount:s.moveCount}}
function other(s){return s==='r'?'b':'r'}
function createGame(mode){return mode==='niu'?niuCreate():mode==='gua'?guaCreate():null}
function actionsAt(s,i){if(s.mode==='niu')return niuActions(s,i);if(s.mode==='gua')return guaActions(s,i);return[]}
function allActions(s){return s.mode==='niu'?niuAll(s):s.mode==='gua'?guaAll(s):[]}
function applyAction(s,a){return s.mode==='niu'?niuApply(s,a):s.mode==='gua'?guaApply(s,a):s}
function aiAction(s,level){
  const acts=allActions(s);if(!acts.length)return null;
  const evalFn=s.mode==='niu'?niuEval:guaEval;
  let best=acts[0],bs=-1e9;
  for(const a of acts){
    const ns=applyAction(s,a);let sc=evalFn(ns,s.turn);
    // 休闲档加噪，老手档精确
    if(level!=='pro')sc+=Math.random()*8;
    if(ns.status==='over'&&ns.winner===s.turn)sc+=1e5;
    if(sc>bs){bs=sc;best=a}
  }
  return best;
}

export { NIU_POINTS,NIU_EDGES,niuNeighbors,GUA_POINTS,guaNeighbors,
  createGame,actionsAt,allActions,applyAction,aiAction,other,clone,
  niuCreate,niuAll,niuStuck,guaCreate,guaAll };
