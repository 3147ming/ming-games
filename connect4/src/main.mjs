/* =============================================================================
 * connect4/src/main.mjs —— 四子棋主控
 * -----------------------------------------------------------------------------
 * 三种对局模式：
 *   ai        人机（你执蓝棋，AI 执红棋）
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
  COLS, ROWS, EMPTY, RED, BLACK, emptyBoard, idx, place, dropRow, canDrop,
  aiMove, hashBoard, replay, countFilled,
} from './rules.mjs';
import { P2PSession, HostAuthority, checkSupport } from '../../src/net/p2p.js';

const $ = (id) => document.getElementById(id);
const cv = $('cv');
const ctx = cv.getContext('2d');

/* ---- 全局状态 ---- */
let mode = 'ai';
let board = emptyBoard();
let moves = [];              /* 已落子的历史：{x,y,stone}，用于悔棋与重放 */
let turn = RED;
let over = false;
let lastMove = null;
let winner = EMPTY;
let thinking = false;
let session = null;          /* P2PSession */
let authority = null;        /* HostAuthority */

/* 调试钩子：把内部状态挂到 window 上，方便自动化测试与排查联机问题。
   不含任何隐私数据（只有连接状态与房间号）。 */
globalThis.__CONNECT4__ = {
  get session() { return session; },
  get authority() { return authority; },
  get mode() { return mode; },
  get turn() { return turn; },
  get moves() { return moves.length; },
  get board() { return board; },
  get over() { return over; },
  get winner() { return winner; },
};

/* ---- 存档：只存本机成绩 ---- */
const SAVE_KEY = 'ming.connect4.v1';
function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return { wins: 0, losses: 0, draws: 0, streak: 0 };
    const o = JSON.parse(raw);
    return {
      wins: Number(o.wins) || 0, losses: Number(o.losses) || 0,
      draws: Number(o.draws) || 0, streak: Number(o.streak) || 0,
    };
  } catch (e) { return { wins: 0, losses: 0, draws: 0, streak: 0 }; }
}
function saveResult(win) {
  try {
    const s = loadSave();
    if (win === 'draw') { s.draws++; s.streak = 0; }
    else if (win) { s.wins++; s.streak++; }
    else { s.losses++; s.streak = 0; }
    localStorage.setItem(SAVE_KEY, JSON.stringify(s));
  } catch (e) { /* 隐私模式：忽略 */ }
}

/* =============================================================================
 * 渲染
 * ========================================================================== */
const W = 560, H = 480;
const PAD_X = 26, PAD_Y = 20;
const CELL = (W - PAD_X * 2) / COLS;      /* 格子间距（列方向） */
const RADIUS = CELL * 0.42;

function draw() {
  /* 底板 */
  ctx.fillStyle = '#1d4e89';
  ctx.fillRect(0, 0, W, H);

  /* 网格上的落子孔（画成深色圆窝，棋子落在窝里更清楚） */
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const cx = PAD_X + CELL * (x + 0.5);
      const cy = PAD_Y + ((H - PAD_Y * 2) / ROWS) * (y + 0.5);
      ctx.beginPath();
      ctx.arc(cx, cy, RADIUS * 0.98, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,.26)';
      ctx.fill();
    }
  }

  /* 棋子 */
  for (const m of moves) {
    const cx = PAD_X + CELL * (m.x + 0.5);
    const cy = PAD_Y + ((H - PAD_Y * 2) / ROWS) * (m.y + 0.5);
    ctx.beginPath();
    ctx.arc(cx, cy, RADIUS, 0, Math.PI * 2);
    if (m.stone === RED) {
      const g = ctx.createRadialGradient(cx - 4, cy - 5, 2, cx, cy, RADIUS);
      g.addColorStop(0, '#ff8071'); g.addColorStop(1, '#c3352b');
      ctx.fillStyle = g;
    } else {
      const g = ctx.createRadialGradient(cx - 4, cy - 5, 2, cx, cy, RADIUS);
      g.addColorStop(0, '#ffe489'); g.addColorStop(1, '#d9a71f');
      ctx.fillStyle = g;
    }
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.3)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  /* 最后一手：白色描边 */
  if (lastMove) {
    const cx = PAD_X + CELL * (lastMove.x + 0.5);
    const cy = PAD_Y + ((H - PAD_Y * 2) / ROWS) * (lastMove.y + 0.5);
    ctx.strokeStyle = 'rgba(255,255,255,.95)';
    ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.arc(cx, cy, RADIUS * 0.96, 0, Math.PI * 2); ctx.stroke();
  }

  /* 胜利四连高亮 */
  if (over && winner) {
    const line = winLine();
    if (line.length >= 4) {
      ctx.strokeStyle = 'rgba(255,255,255,.92)';
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(PAD_X + CELL * (line[0][0] + 0.5), PAD_Y + ((H - PAD_Y * 2) / ROWS) * (line[0][1] + 0.5));
      for (const p of line) ctx.lineTo(PAD_X + CELL * (p[0] + 0.5), PAD_Y + ((H - PAD_Y * 2) / ROWS) * (p[1] + 0.5));
      ctx.stroke();
      ctx.lineCap = 'butt';
    }
  }
}

/** 从当前棋盘找出获胜的四连（终局时高亮用）。 */
function winLine() {
  const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const s = board[idx(x, y)];
      if (s === EMPTY) continue;
      for (const [dx, dy] of DIRS) {
        const line = [[x, y]];
        let cx = x + dx, cy = y + dy;
        while (cx >= 0 && cx < COLS && cy >= 0 && cy < ROWS && board[idx(cx, cy)] === s) {
          line.push([cx, cy]); cx += dx; cy += dy;
        }
        if (line.length >= 4) return line;
      }
    }
  }
  return [];
}

/* =============================================================================
 * 状态条与提示
 * ========================================================================== */
function updateUI() {
  const stoneName = turn === RED ? '红棋' : '蓝棋';
  $('turn').textContent = over ? '已结束' : stoneName + '落子';
  $('tdot').className = 'turn-dot ' + (turn === RED ? 'r' : 'k');
  $('moves').textContent = String(moves.length);
  $('phase').textContent = over ? '终局' : (thinking ? 'AI 思考中' : '进行中');

  const hints = {
    ai: '人机：红棋 AI 执子，你执蓝棋。点一列落子。',
    hotseat: '同屏双人：两人轮流下，点一列落子。',
    p2p: '纯 P2P 联机：先在下面连上通道，再点一列落子。',
  };
  $('hint').textContent = over ? endText() : (hints[mode] || '');
  $('modehint').textContent = {
    ai: '人机：AI 执红，你执蓝',
    hotseat: '同屏双人：轮流下',
    p2p: '联机：' + (session ? (session.isHost ? '你是房主（红棋）' : '你是加入方（蓝棋）') : '未连接'),
  }[mode] || '';

  $('end').classList.toggle('show', over);
  if (over) {
    $('endtitle').textContent = winner === RED ? '红棋胜' : winner === BLACK ? '蓝棋胜' : '和棋';
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
    _endTextCache = '棋盘落满了，谁也没连成四 —— 和棋。';
    return _endTextCache;
  }
  const w = winner === RED ? '红棋' : '蓝棋';
  if (mode === 'ai') {
    const youWin = (winner === BLACK);
    saveResult(youWin);
    const s = loadSave();
    _endTextCache = youWin
      ? '你赢了！战绩 ' + s.wins + ' 胜 ' + s.losses + ' 负，当前连胜 ' + s.streak + '。'
      : 'AI 赢了。再来一局？战绩 ' + s.wins + ' 胜 ' + s.losses + ' 负。';
    return _endTextCache;
  }
  _endTextCache = w + '四连获胜。';
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
    const myStone = session.isHost ? RED : BLACK;
    return turn === myStone;
  }
  if (mode === 'ai') return turn === BLACK && !thinking;
  return true;   /* hotseat：都轮次 */
}

function doPlace(x, stone) {
  const r = place(board, x, stone);
  if (!r.ok) {
    $('hint').textContent = r.reason;
    return false;
  }
  board = r.board;
  moves.push({ x: r.x, y: r.y, stone });
  lastMove = { x: r.x, y: r.y };
  turn = stone === RED ? BLACK : RED;

  if (r.winner) {
    over = true;
    winner = r.winner;
  } else if (r.draw) {
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
     这里千万别写成反的 —— 写反了棋子会整体偏移，点 A 列落在 B 列。 */
  const scale = rect.width / cv.width;
  const px = (ev.clientX - rect.left) / scale;
  /* 四子棋是竖盘，点哪一列都行 —— 用 x 换算列号；y 不参与判定。 */
  const x = Math.floor((px - PAD_X) / CELL);
  if (x < 0 || x >= COLS) return;

  const stone = mode === 'ai' ? BLACK : turn;
  if (mode === 'p2p') {
    /* 联机：只上报意图，由房主判定 */
    if (session.isHost) {
      hostApply({ x, stone });
    } else {
      authority.input({ x, stone });
      $('hint').textContent = '已发送落子，等房主确认…';
    }
    return;
  }
  if (doPlace(x, stone) && mode === 'ai' && !over) aiGo();
}

function aiGo() {
  thinking = true;
  updateUI();
  setTimeout(() => {
    const mv = aiMove(board, RED, Number($('level').value) || 1);
    thinking = false;
    if (doPlace(mv.x, RED)) { /* 落子后自动刷新 */ }
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

  /* 双方共用的状态重建：从动作序列重放，保证结果一致。
     moves 要带上落点 y —— 渲染最后一手标记、悔棋都要用，
     只存 {x,stone} 的话画棋子时 cy 会是 NaN。 */
  const buildState = (actions) => {
    const r = replay(actions);
    return {
      board: toArr(r.board),
      winner: r.winner,
      line: r.line,
      draw: r.draw,
      moves: r.moves.slice(),
      turn: actions.length ? (actions[actions.length - 1].stone === RED ? BLACK : RED) : RED,
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

  const applyState = (s) => {
    board = fromArr(s.board);
    moves = (s.moves || []).slice();
    winner = s.winner;
    turn = s.turn;
    over = winner !== EMPTY || !!s.draw || countFilled(board) >= COLS * ROWS;
    lastMove = moves.length ? moves[moves.length - 1] : null;
    updateUI();
  };

  authority.onState(applyState);
  /* 房主推进后本地也要立刻刷新（广播是发给对方的，不会回环到自己）。 */
  authority.onLocalState(applyState);
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
  turn = RED;
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
  /* 人机模式：AI 执红先走。联机与同屏都是红先由玩家自己落。 */
  if (mode === 'ai' && !over) aiGo();
}

function undo() {
  if (mode === 'p2p') return;
  if (!moves.length) return;
  /* 人机模式：AI 已经落过手，悔棋要退两步（玩家 + AI），
     否则退完还是轮到 AI 走，玩家点了没反应。 */
  const back = (mode === 'ai' && moves.length >= 2) ? 2 : 1;
  for (let i = 0; i < back; i++) moves.pop();
  board = rebuild();           /* 直接按剩下的历史重建，place() 不支持落空子 */
  turn = moves.length ? moves[moves.length - 1].stone === RED ? BLACK : RED : RED;
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
    session = new P2PSession({ role: 'host', gameId: 'connect4', name: '房主' });
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
    session = new P2PSession({ role: 'guest', gameId: 'connect4', name: '玩家' });
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
