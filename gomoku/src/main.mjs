/* =============================================================================
 * gomoku/src/main.mjs —— 五子棋主控
 * -----------------------------------------------------------------------------
 * 三种对局模式：
 *   ai        人机（你执白，AI 执黑）
 *   hotseat   同屏双人（同一台设备轮流下）
 *   p2p       纯 P2P 联机（零服务器，手动交换两段连接码）
 *
 * 联机采用「房主权威」模型（见 src/net/p2p.js 的 HostAuthority）：
 *   · 玩家只上报落子意图（input）
 *   · 房主判定合法性、推进棋局、广播权威棋盘（state）
 *   · 加入方用同一份规则引擎重放，状态一致
 *   · 定期比对摘要（hash），不一致由房主下发快照（sync）纠偏
 *
 * 纪律：顶层不碰 localStorage（成绩记录除外，且都在函数里 try/catch）。
 * ========================================================================== */

import {
  SIZE, EMPTY, BLACK, WHITE, emptyBoard, idx, place, aiMove, hashBoard, replay,
} from './rules.mjs';
import { P2PSession, HostAuthority, checkSupport } from '../../src/net/p2p.js';

const $ = (id) => document.getElementById(id);
const cv = $('cv');
const ctx = cv.getContext('2d');

/* ---- 全局状态 ---- */
let mode = 'ai';
let board = emptyBoard();
let moves = [];              /* 已落子的历史：{x,y,stone}，用于悔棋与重放 */
let turn = BLACK;
let over = false;
let lastMove = null;
let winner = EMPTY;
let thinking = false;
let session = null;          /* P2PSession */

/* 调试钩子：把内部状态挂到 window 上，方便自动化测试与排查联机问题。
   不含任何隐私数据（只有连接状态与房间号）。 */
globalThis.__GOMOKU__ = {
  get session() { return session; },
  get authority() { return authority; },
  get mode() { return mode; },
  get turn() { return turn; },
  get moves() { return moves.length; },
};
let authority = null;        /* HostAuthority */
let mySeat = 1;              /* 联机时：0=房主(黑) 1=加入方(白) */

/* ---- 存档：只存本机成绩 ---- */
const SAVE_KEY = 'ming.gomoku.v1';
function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return { wins: 0, losses: 0, draws: 0, streak: 0, best: 0 };
    const o = JSON.parse(raw);
    return {
      wins: Number(o.wins) || 0, losses: Number(o.losses) || 0, draws: Number(o.draws) || 0,
      streak: Number(o.streak) || 0, best: Number(o.best) || 0,
    };
  } catch (e) { return { wins: 0, losses: 0, draws: 0, streak: 0, best: 0 }; }
}
function saveResult(win) {
  try {
    const s = loadSave();
    if (win) { s.wins++; s.streak++; }
    else { s.losses++; s.streak = 0; }
    localStorage.setItem(SAVE_KEY, JSON.stringify(s));
  } catch (e) { /* 隐私模式：忽略 */ }
}

/* =============================================================================
 * 渲染
 * ========================================================================== */
const PAD = 22;
const CELL = (600 - PAD * 2) / (SIZE - 1);

function draw() {
  const W = 600;
  /* 棋盘底：木纹色 */
  ctx.fillStyle = '#f3ead8';
  ctx.fillRect(0, 0, W, W);

  /* 网格 */
  ctx.strokeStyle = 'rgba(60,45,25,.55)';
  ctx.lineWidth = 1;
  for (let i = 0; i < SIZE; i++) {
    const p = PAD + i * CELL;
    ctx.beginPath(); ctx.moveTo(PAD, p); ctx.lineTo(W - PAD, p); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(p, PAD); ctx.lineTo(p, W - PAD); ctx.stroke();
  }
  /* 星位 */
  ctx.fillStyle = 'rgba(60,45,25,.75)';
  [[3, 3], [11, 3], [3, 11], [11, 11], [7, 7]].forEach(([x, y]) => {
    ctx.beginPath(); ctx.arc(PAD + x * CELL, PAD + y * CELL, 3.2, 0, Math.PI * 2); ctx.fill();
  });

  /* 棋子 */
  for (const m of moves) {
    const cx = PAD + m.x * CELL, cy = PAD + m.y * CELL;
    /* 落子渐隐动画：最近 12 手内有轻微缩放 */
    const age = moves.length - moves.indexOf(m);
    const k = age <= 6 ? 1 + (6 - age) * 0.06 : 1;
    ctx.beginPath();
    ctx.arc(cx, cy, CELL * 0.42 * k, 0, Math.PI * 2);
    if (m.stone === BLACK) {
      const g = ctx.createRadialGradient(cx - 3, cy - 4, 2, cx, cy, CELL * 0.44);
      g.addColorStop(0, '#5c564e'); g.addColorStop(1, '#191714');
      ctx.fillStyle = g;
    } else {
      const g = ctx.createRadialGradient(cx - 3, cy - 4, 2, cx, cy, CELL * 0.44);
      g.addColorStop(0, '#fffdf7'); g.addColorStop(1, '#ddd2bb');
      ctx.fillStyle = g;
    }
    ctx.fill();
    ctx.strokeStyle = 'rgba(40,30,15,.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  /* 最后一手标记 */
  if (lastMove) {
    const cx = PAD + lastMove.x * CELL, cy = PAD + lastMove.y * CELL;
    ctx.strokeStyle = '#c8963e';
    ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.arc(cx, cy, CELL * 0.17, 0, Math.PI * 2); ctx.stroke();
  }

  /* 胜利连珠高亮 */
  if (over && winner) {
    const line = winLine();
    if (line.length >= 5) {
      ctx.strokeStyle = 'rgba(200,150,62,.9)';
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.moveTo(PAD + line[0].x * CELL, PAD + line[0].y * CELL);
      for (const p of line) ctx.lineTo(PAD + p.x * CELL, PAD + p.y * CELL);
      ctx.stroke();
    }
  }
}

/** 从当前棋盘找出获胜的五连（终局时高亮用）。 */
function winLine() {
  const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const s = board[idx(x, y)];
      if (s === EMPTY) continue;
      for (const [dx, dy] of DIRS) {
        const line = [[x, y]];
        let cx = x + dx, cy = y + dy;
        while (cx >= 0 && cx < SIZE && cy >= 0 && cy < SIZE && board[idx(cx, cy)] === s) {
          line.push([cx, cy]); cx += dx; cy += dy;
        }
        if (line.length >= 5) return line;
      }
    }
  }
  return [];
}

/* =============================================================================
 * 状态条与提示
 * ========================================================================== */
function updateUI() {
  const stoneName = turn === BLACK ? '黑棋' : '白棋';
  $('turn').textContent = over ? '已结束' : stoneName + '落子';
  $('tdot').className = 'turn-dot ' + (turn === BLACK ? 'b' : 'w');
  $('moves').textContent = String(moves.length);
  $('phase').textContent = over ? '终局' : (thinking ? 'AI 思考中' : '进行中');

  const hints = {
    ai: '人机：黑棋 AI 执子，你执白棋。点交叉点落子。',
    hotseat: '同屏双人：两人轮流下，点交叉点落子。',
    p2p: '纯 P2P 联机：先在下面连上通道，再点交叉点落子。',
  };
  $('hint').textContent = over ? endText() : (hints[mode] || '');
  $('modehint').textContent = {
    ai: '人机：AI 执黑，你执白',
    hotseat: '同屏双人：轮流下',
    p2p: '联机：' + (session ? (session.isHost ? '你是房主（黑棋）' : '你是加入方（白棋）') : '未连接'),
  }[mode] || '';

  $('end').classList.toggle('show', over);
  if (over) {
    $('endtitle').textContent = winner === BLACK ? '黑棋胜' : winner === WHITE ? '白棋胜' : '和棋';
    /* 结果说明要写进弹层里 —— 写在 hint 的话被弹层盖住，用户根本看不到。 */
    $('enddesc').textContent = endText();
  }
  draw();
}

/* 终局说明只算一次并缓存。
   updateUI() 会被反复调用（落子、切模式、窗口变化…），
   每次都重算战绩会把胜场数刷爆 —— 所以算完存起来，缓存命中就直接返回。 */
let _endTextCache = null;

function endText() {
  if (_endTextCache !== null) return _endTextCache;
  if (winner === EMPTY) {
    _endTextCache = '棋盘满了，谁也没连成五 —— 和棋。';
    return _endTextCache;
  }
  const w = winner === BLACK ? '黑棋' : '白棋';
  if (mode === 'ai') {
    const youWin = (winner === WHITE);
    saveResult(youWin);
    const s = loadSave();
    _endTextCache = youWin
      ? '你赢了！战绩 ' + s.wins + ' 胜 ' + s.losses + ' 负，当前连胜 ' + s.streak + '。'
      : 'AI 赢了。再来一局？战绩 ' + s.wins + ' 胜 ' + s.losses + ' 负。';
    return _endTextCache;
  }
  _endTextCache = w + '五连获胜。';
  return _endTextCache;
}

/* =============================================================================
 * 落子
 * ========================================================================== */
function canPlay() {
  if (over) return false;
  if (mode === 'p2p') {
    if (!session || !session.isOpen) return false;
    /* 联机时只有轮到自己才能下 */
    const myStone = session.isHost ? BLACK : WHITE;
    return turn === myStone;
  }
  if (mode === 'ai') return turn === WHITE && !thinking;
  return true;   /* hotseat：都轮次 */
}

function doPlace(x, y, stone) {
  const r = place(board, x, y, stone);
  if (!r.ok) {
    $('hint').textContent = r.reason;
    return false;
  }
  board = r.board;
  moves.push({ x, y, stone });
  lastMove = { x, y };
  turn = stone === BLACK ? WHITE : BLACK;

  if (r.winner) {
    over = true;
    winner = r.winner;
  } else if (moves.length >= SIZE * SIZE) {
    over = true;
    winner = EMPTY;
  }
  updateUI();
  return true;
}

function onBoardClick(ev) {
  if (!canPlay()) {
    if (mode === 'ai' && thinking) $('hint').textContent = 'AI 正在想…';
    else if (mode === 'p2p' && (!session || !session.isOpen)) $('hint').textContent = '还没连上，先在下面建立通道。';
    else if (mode === 'p2p') $('hint').textContent = '还没轮到你下。';
    return;
  }
  const rect = cv.getBoundingClientRect();
  /* CSS 像素 → 画布像素：canvas 的显示尺寸（rect）和内部尺寸（cv.width）不一定相等，
     CSS 里是 width:100% 自适应缩放的。缩放系数是 rect.width / cv.width（>1 表示放大），
     这里千万别写成反的 —— 写反了棋子会整体偏移，点 A 格落在 B 格。 */
  const scale = rect.width / cv.width;
  const px = (ev.clientX - rect.left) / scale;
  const py = (ev.clientY - rect.top) / (rect.height / cv.height);
  const x = Math.round((px - PAD) / CELL);
  const y = Math.round((py - PAD) / CELL);
  if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return;

  /* 离交叉点太远就当没点中。
     15×15 的格距在 600px 画布上只有 39.7px，缩放到手机宽度后更窄，
     手指头稍微偏一点就可能落到隔壁格 —— 不做距离判断会「明明点的是空格，
     却提示那格已经有子」，非常莫名其妙。 */
  const dx = Math.abs(px - (PAD + x * CELL));
  const dy = Math.abs(py - (PAD + y * CELL));
  if (dx > CELL * 0.42 || dy > CELL * 0.42) {
    $('hint').textContent = '没点在线上 —— 请点在交叉点上。';
    return;
  }

  const stone = mode === 'ai' ? WHITE : turn;
  if (mode === 'p2p') {
    /* 联机：只上报意图，由房主判定 */
    if (session.isHost) {
      hostApply({ x, y, stone });
    } else {
      authority.input({ x, y, stone });
      $('hint').textContent = '已发送落子，等房主确认…';
    }
    return;
  }
  if (doPlace(x, y, stone) && mode === 'ai' && !over) aiGo();
}

function aiGo() {
  thinking = true;
  updateUI();
  setTimeout(() => {
    const mv = aiMove(board, BLACK, Number($('level').value) || 1);
    thinking = false;
    if (doPlace(mv.x, mv.y, BLACK)) { /* 落子后自动刷新 */ }
  }, 260);
}

/* =============================================================================
 * 联机：房主权威
 * ========================================================================== */
function hostApply(act) {
  if (!authority) return;
  authority.applyLocal(act);
}

function setupAuthority() {
  if (!session) return;

  /* 联机状态用普通数组表示棋盘 —— Uint8Array 没法 JSON 传输
     （会被转成 {"0":0,"1":0,…} 这种一坨）。 */
  const toArr = (b) => Array.from(b);
  const fromArr = (a) => Uint8Array.from(a || []);

  /* 双方共用的状态重建：从动作序列重放，保证结果一致。 */
  const buildState = (actions) => {
    const r = replay(actions);
    return {
      board: toArr(r.board),
      winner: r.winner,
      line: r.line,
      moves: actions.slice(),
      turn: actions.length ? (actions[actions.length - 1].stone === BLACK ? WHITE : BLACK) : BLACK,
    };
  };

  authority = new HostAuthority(session, {
    /* 房主：从当前状态往前推。 */
    reduce: (state, actions) => {
      const all = (state.moves || []).concat(actions);
      return buildState(all);
    },
    /* 双方：从种子 + 动作序列重放。 */
    replay: (seed, actions) => buildState(actions || []),
    /* 状态摘要：比对双方算出的棋盘是否一致。 */
    hash: (state) => hashBoard(fromArr(state.board)),
  });

  authority.onState((s) => {
    /* 应用权威状态。
       加入方靠广播收到；房主是自己推进的，也走同一条路刷新显示 ——
       否则房主点了子，棋盘不动、轮次不变，玩家会以为没点上。 */
    board = fromArr(s.board);
    moves = (s.moves || []).slice();
    winner = s.winner;
    turn = s.turn;
    over = winner !== EMPTY || moves.length >= SIZE * SIZE;
    lastMove = moves.length ? moves[moves.length - 1] : null;
    updateUI();
  });
  /* 房主推进后本地也要立刻刷新（广播是发给对方的，不会回环到自己）。 */
  authority.onLocalState((s) => {
    board = fromArr(s.board);
    moves = (s.moves || []).slice();
    winner = s.winner;
    turn = s.turn;
    over = winner !== EMPTY || moves.length >= SIZE * SIZE;
    lastMove = moves.length ? moves[moves.length - 1] : null;
    updateUI();
  });
}

function p2pState(text, cls) {
  const el = $('p2p-state');
  el.textContent = text;
  el.className = 'p2p-state ' + (cls || 'wait');
}

/* =============================================================================
 * 联机 UI
 * ========================================================================== */
function setMode(m) {
  mode = m;
  $('mode').value = m;
  $('p2p').hidden = m !== 'p2p';
  $('level').style.display = m === 'ai' ? '' : 'none';
  $('host-flow').hidden = true;
  $('guest-flow').hidden = true;
  $('rolebar').hidden = false;
  newGame();
}

function newGame() {
  board = emptyBoard();
  moves = [];
  turn = BLACK;
  over = false;
  winner = EMPTY;
  lastMove = null;
  thinking = false;
  _endTextCache = null;      /* 新一局要重算结果文案 */
  if (authority) {
    /* 联机局由房主开局 */
    if (session && session.isHost) authority.init('seed-' + Date.now());
  }
  updateUI();
  /* 人机模式：AI 执黑先走。联机与同屏都是黑先由玩家自己落。 */
  if (mode === 'ai' && !over) aiGo();
}

function undo() {
  if (mode === 'p2p') return;
  if (!moves.length) return;
  const m = moves.pop();
  board = rebuild();           /* 直接按剩下的历史重建，place() 不支持落空子 */
  turn = m.stone;
  over = false; winner = EMPTY;
  lastMove = moves.length ? moves[moves.length - 1] : null;
  updateUI();
}

function rebuild() {
  const b = emptyBoard();
  for (const m of moves) b[idx(m.x, m.y)] = m.stone;
  return b;
}

async function genHostCode() {
  const pass = $('host-pass').value.trim();
  try {
    p2pState('正在生成房主码…', 'wait');
    session = new P2PSession({ role: 'host', gameId: 'gomoku', name: '房主' });
    setupAuthority();
    session.on('status', (st, text) => {
      p2pState(text || st, st === 'open' ? 'ok' : st === 'failed' ? 'err' : 'wait');
      if (st === 'open') { $('rolebar').hidden = true; newGame(); }
    });
    const code = await session.createHostCode(pass);
    $('host-code').value = code;
    $('host-flow').hidden = false;
    $('rolebar').hidden = true;
    p2pState('房主码已生成，发给朋友吧', 'wait');
  } catch (e) {
    p2pState(e.message || '生成失败', 'err');
  }
}

async function genGuestCode() {
  const hostCode = $('host-in').value.trim();
  const pass = $('guest-pass').value;
  try {
    p2pState('正在生成加入码…', 'wait');
    session = new P2PSession({ role: 'guest', gameId: 'gomoku', name: '玩家' });
    setupAuthority();
    session.on('status', (st, text) => {
      p2pState(text || st, st === 'open' ? 'ok' : st === 'failed' ? 'err' : 'wait');
      if (st === 'open') { $('rolebar').hidden = true; }
    });
    const code = await session.createGuestCode(hostCode, pass);
    $('guest-code').value = code;
    $('guest-flow').hidden = false;
    $('rolebar').hidden = true;
    p2pState('加入码已生成，发回房主', 'wait');
  } catch (e) {
    p2pState(e.message || '生成失败', 'err');
  }
}

async function acceptJoinCode() {
  const code = $('join-in').value.trim();
  if (!code) { p2pState('先把朋友发回的加入码粘进来', 'err'); return; }
  try {
    p2pState('正在建立通道…', 'wait');
    await session.acceptGuestCode(code);
    p2pState('正在建立通道…', 'wait');
  } catch (e) {
    p2pState(e.message || '接受失败', 'err');
  }
}

function closeSession() {
  if (session) { session.close(); session = null; }
  authority = null;
  $('rolebar').hidden = false;
  $('host-flow').hidden = true;
  $('guest-flow').hidden = true;
  $('host-code').value = '';
  $('guest-code').value = '';
  $('host-in').value = '';
  $('join-in').value = '';
  p2pState('未连接', 'wait');
  newGame();
}

function copyTo(el, btn) {
  const text = el.value;
  if (!text) return;
  const done = () => { const old = btn.textContent; btn.textContent = '已复制'; setTimeout(() => { btn.textContent = old; }, 1400); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => { el.select(); document.execCommand('copy'); done(); });
  } else {
    el.select();
    document.execCommand('copy');
    done();
  }
}

/* =============================================================================
 * 绑定
 * ========================================================================== */
$('mode').addEventListener('change', (e) => setMode(e.target.value));
$('restart').addEventListener('click', newGame);
$('again').addEventListener('click', newGame);
$('undo').addEventListener('click', undo);
cv.addEventListener('click', onBoardClick);

$('btn-host').addEventListener('click', () => { $('host-flow').hidden = false; $('guest-flow').hidden = true; $('rolebar').hidden = true; });
$('btn-join').addEventListener('click', () => { $('guest-flow').hidden = false; $('host-flow').hidden = true; $('rolebar').hidden = true; });
$('btn-gen-host').addEventListener('click', genHostCode);
$('btn-gen-guest').addEventListener('click', genGuestCode);
$('btn-accept').addEventListener('click', acceptJoinCode);
$('btn-close').addEventListener('click', closeSession);
$('btn-copy-host').addEventListener('click', () => copyTo($('host-code'), $('btn-copy-host')));
$('btn-copy-guest').addEventListener('click', () => copyTo($('guest-code'), $('btn-copy-guest')));

/* 环境自检：浏览器不支持 WebRTC 就把联机模式标灰并说明原因 */
const sup = checkSupport();
if (!sup.ok) {
  const opt = $('mode').querySelector('option[value="p2p"]');
  if (opt) { opt.disabled = true; opt.textContent = '纯 P2P 联机（本浏览器不支持）'; }
  $('p2p').hidden = true;
}

/* 启动 */
setMode('ai');
updateUI();
