/* =============================================================================
 * ludo/src/main.mjs —— 飞行棋主控
 * -----------------------------------------------------------------------------
 * 两种模式：
 *   ai    人机对局（你 + 最多 3 个 AI）
 *   p2p   纯 P2P 联机（零服务器，手动交换两段连接码）
 *
 * ---------------------------------------------------------------------------
 * 这个游戏接纯 P2P 的核心难点：**骰子是随机数。**
 *
 * 吹牛骰子那边靠 commit-reveal（先承诺后揭示）解决；
 * 飞行棋这边点数本来就是公开的，所以干脆用另一招 ——
 * **点数不是掷出来的，是算出来的**：
 *
 *   点数 = H(seed | 掷骰序号) % 6 + 1
 *
 * seed 写在开局状态里（公开），掷骰序号写在动作序列里（公开），
 * 所以双方各自算出来的点数必然一致 —— 房主想改也改不了，
 * 他一改就跟加入方算出来的不一样，会被哈希校验当场抓住。
 *
 * 详见 src/rules.mjs 开头那段说明。
 *
 * 联机状态同步用「房主权威」模型（见 src/net/p2p.js 的 HostAuthority）：
 *   · 玩家只上报「我想走哪颗棋子」（input）
 *   · 房主判定合法性、推进棋局、广播权威状态（state）
 *   · 双方用同一份规则引擎重放，状态一致
 *   · 定期比对摘要（hash），不一致由房主下发快照（sync）纠偏
 *
 * 纪律：顶层不碰 localStorage（成绩记录除外，且都在函数里 try/catch）。
 * ========================================================================== */

import {
  COLORS, COLOR_LABEL, COLOR_HEX, COLOR_COUNT, PLANES_PER_COLOR,
  RING, RING_LEN, LANES, LANE_LEN, MOUTH_IDX, START_IDX, JUMP_IDX, JUMP_STEPS,
  HOLD, LANE_START, FINISH_POS,
  dieFor, randomSeed, seedFromRoom,
  initState, ringIndexOf, cellOf, legalPlanes, finishedCount,
  applyAction, fold, replay, hashState, publicView, aiChoose,
} from './rules.mjs';
import { P2PSession, HostAuthority, checkSupport } from '../../src/net/p2p.js';

const $ = (id) => document.getElementById(id);

/* ---- 全局状态 ---- */
let mode = 'ai';
let nColors = 4;              /* 参与的色数 */
let st = initState(randomSeed(), 4);
let base = { seed: st.seed, n: 4 };
let localActs = [];
let session = null;
let authority = null;

/* 我这一方控制的颜色（联机局：房主 0/2，加入方 1/3） */
let myColors = [0];

/* 联机时我提交过的动作 —— 加入方用它核对房主有没有偷改/截断动作序列。
   房主能伪造「局面」，但伪造不了「我确实走过这一步」这件事。 */
let mySubmitted = [];

/* 掷骰动画 */
let rolling = false;
let pendingDie = 0;

/* 联机模式下的对手座位 */
let peerSeat = 1;

/* 调试钩子 */
globalThis.__LUDO__ = {
  get session() { return session; },
  get authority() { return authority; },
  get mode() { return mode; },
  get pub() { return st; },
  get seed() { return st.seed; },
  get roll() { return st.roll; },
  get turn() { return st.turn; },
  get over() { return st.over; },
  get winner() { return st.winner; },
  get myColors() { return myColors.slice(); },
  get actionCount() { return authority ? authority.actions.length : localActs.length; },
  get moves() {
    if (authority && authority.state && authority.state.moves) return authority.state.moves.slice();
    return localActs.slice();
  },
  get lastDie() { return st.lastDie; },
  get planes() { return st.planes.map((r) => r.slice()); },
  die: (r) => dieFor(st.seed, r),
  legal: (c) => legalPlanes(st, c),
  /* 测试用：直接提交一个动作 */
  act: (act) => applyLocal(act),
  /* 测试用：摆一个局面 */
  setPlanes: (c, arr) => { st.planes[c] = arr.slice(); },
};

/* =============================================================================
 * 座位与归属
 * ========================================================================== */
function mySeat() {
  if (mode === 'p2p') return session ? (session.isHost ? 0 : 1) : 0;
  return 0;
}
/** 这个颜色归谁管：0 = 我，1 = 对手，-1 = AI。 */
function ownerOf(color) {
  if (mode === 'p2p') {
    const seat = mySeat();
    return (color % 2) === seat ? 0 : 1;
  }
  return color === 0 ? 0 : -1;
}
function isMyTurn() {
  if (st.over) return false;
  return ownerOf(st.turn) === 0;
}
function colorName(c) {
  if (mode === 'p2p') return (c % 2) === mySeat() ? COLOR_LABEL[COLORS[c]] + '（你）' : COLOR_LABEL[COLORS[c]];
  return c === 0 ? COLOR_LABEL[COLORS[c]] + '（你）' : COLOR_LABEL[COLORS[c]] + '（AI）';
}

/* =============================================================================
 * 动作提交
 * ========================================================================== */
function applyLocal(act) {
  if (mode === 'p2p' && authority && session) {
    if (session.isHost) authority.applyLocal(act);
    else authority.input(act);
    return;
  }
  localActs = localActs.concat([act]);
  st = fold(base, localActs);
  afterAction(act);
  render();
}

function afterAction(act) {
  if (!act) return;
  if (act.act === 'move') {
    if (act.plane >= 0) {
      const c = act.c;
      pushMsg(colorName(c) + ' 走了 ' + describeMove(act, c));
    } else {
      pushMsg(colorName(st.turn) + ' 没有能走的棋子，跳过');
    }
    if (st.over) {
      const win = st.winner;
      setMsg(win === st.turn || (mode === 'p2p' && ownerOf(win) === 0)
        ? '你赢了！+20 金币' : '这局输了 -10 金币',
        ownerOf(win) === 0 ? 'ok' : 'bad');
      saveScore(win);
    }
    scheduleAI();
  }
}

/** 说清楚这一步干了啥（撞机、飞跃、起飞都要讲）。 */
function describeMove(act, color) {
  const die = st.lastDie;
  /* 注意用 act.c —— applyLocal 之后 st.turn 已经轮到下一个人了 */
  const bits = [];
  const before = st.planes[color][act.plane];
  bits.push('掷出 ' + die + ' 点');
  if (before === HOLD) bits.push('起飞');
  if (st.victims && st.victims.length) bits.push('撞飞 ' + st.victims.length + ' 颗');
  if (st.flew) bits.push('飞越 ' + JUMP_STEPS + ' 格');
  return bits.join(' · ');
}

function pushMsg(text) {
  if (!text) return;
  setMsg(text, '');
}

function setMsg(text, cls) {
  const el = $('msg');
  el.textContent = text;
  el.className = 'msg' + (cls ? ' ' + cls : '');
}

/* =============================================================================
 * 玩家操作
 * ========================================================================== */

/** 掷骰子（点确定后自动选棋）。 */
function doRoll() {
  if (st.over) { setMsg('这局已经结束了，点「开局」再来', 'dim'); return; }
  if (!isMyTurn()) { setMsg('还没轮到你', 'dim'); return; }
  if (rolling) return;

  const die = dieFor(st.seed, st.roll);
  const legal = legalPlanes(st, st.turn);
  /* 点数先亮出来 —— 就算这回合没棋可走，玩家也该看到掷到了几点 */
  $('die').textContent = die;
  if (!legal.length) {
    /* 没有能走的棋子 —— 直接过 */
    submitMove(-1);
    return;
  }
  /* 滚动动画。
     只给**玩家自己**的回合做 —— AI 走棋直接亮点数。
     一局要掷几百次骰子，每次都滚 8 帧的话，
     光动画就要 3 分多钟，手感会被拖垮。 */
  rolling = true;
  pendingDie = die;
  $('die').textContent = die;
  $('die').classList.add('rolling');
  $('btn-roll').disabled = true;
  const d = $('die');
  let n = 0;
  const timer = setInterval(() => {
    n++;
    d.textContent = 1 + Math.floor(Math.random() * 6);
    if (n >= 5) {
      clearInterval(timer);
      d.textContent = die;
      d.classList.remove('rolling');
      rolling = false;
      $('btn-roll').disabled = false;
      showPlaneChoice(legal, die);
    }
  }, 45);
}

/** 列出这次能走的棋子，让玩家点。 */
function showPlaneChoice(legal, die) {
  const c = st.turn;
  const box = $('ctl-planes');
  box.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'hint';
  title.textContent = '掷出 ' + die + ' 点 —— 选一颗要走的棋子：';
  box.appendChild(title);
  legal.forEach((i) => {
    const b = document.createElement('button');
    b.className = 'btn';
    b.type = 'button';
    b.textContent = '第 ' + (i + 1) + ' 颗' + planeHint(c, i);
    b.addEventListener('click', () => { box.innerHTML = ''; submitMove(i); });
    box.appendChild(b);
  });
  const skip = document.createElement('button');
  skip.className = 'btn';
  skip.type = 'button';
  skip.textContent = '跳过';
  skip.addEventListener('click', () => { box.innerHTML = ''; submitMove(-1); });
  box.appendChild(skip);
}

/** 棋子的位置提示。 */
function planeHint(color, i) {
  const p = st.planes[color][i];
  if (p === HOLD) return '（待飞）';
  if (p >= LANE_START) {
    const laneIdx = p - LANE_START;
    return laneIdx === LANE_LEN - 1 ? '（终点）' : '（通道 ' + (laneIdx + 1) + '/6）';
  }
  const ring = ringIndexOf(color, p);
  return JUMP_IDX.indexOf(ring) >= 0 ? '（飞跃点）' : '（外圈）';
}

function submitMove(plane) {
  /* 把点数一起报上去 —— 房主的 validate 会核对。
     点数本来就是双方各自算出来的，多报一个只是双保险。 */
  const act = {
    act: 'move', c: st.turn, plane: plane, r: st.roll,
    die: dieFor(st.seed, st.roll),
  };
  if (mode === 'p2p' && authority && session && !session.isHost) {
    /* 记下我提交过 —— 后面核对房主的动作序列时要用 */
    mySubmitted = mySubmitted.concat([{
      act: 'move', c: act.c, plane: act.plane, r: act.r, die: act.die,
    }]);
    authority.input(act);
    setMsg('已上报，等房主裁决…', 'dim');
    return;
  }
  applyLocal(act);
}

/* =============================================================================
 * AI
 * ========================================================================== */
let aiTimer = null;
let aiGen = 0;

function scheduleAI() {
  if (aiTimer) { clearTimeout(aiTimer); aiTimer = null; }
  if (mode !== 'ai') return;
  if (st.over) return;
  if (ownerOf(st.turn) !== -1) return;
  const gen = aiGen;
  aiTimer = setTimeout(() => {
    if (gen !== aiGen) return;
    if (mode !== 'ai' || st.over || ownerOf(st.turn) !== -1) return;
    const c = st.turn;
    const pick = aiChoose(st, c);
    const die = dieFor(st.seed, st.roll);
    /* AI 走棋不滚动画 —— 直接亮点数，省时间 */
    $('die').textContent = die;
    $('die').classList.remove('rolling');
    applyLocal({ act: 'move', c: c, plane: pick, r: st.roll });
  }, 450 + Math.random() * 350);
}

/* =============================================================================
 * 开局
 * ========================================================================== */
function newGame() {
  aiGen++;
  if (aiTimer) { clearTimeout(aiTimer); aiTimer = null; }
  localActs = [];
  mySubmitted = [];
  $('ctl-planes').innerHTML = '';

  const n = mode === 'p2p' ? 2 : nColors;
  /* 联机局的种子从房间号派生 —— 双方算出来必然一致。
     人机局用随机种子。 */
  const seed = mode === 'p2p' && session && session.roomId
    ? seedFromRoom(session.roomId, 'ludo')
    : randomSeed();
  base = { seed: seed, n: n };
  st = initState(seed, n);
  myColors = mode === 'p2p' ? (session && session.isHost ? [0, 2] : [1, 3]) : [0];

  if (mode === 'p2p' && authority) {
    if (session && session.isHost) {
      const s = (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0;
      authority.init({ s, base });
      st = fold(base, []);
    }
    render();
    setMsg(mode === 'p2p' ? '联机局：' + (myColors.map((c) => COLOR_LABEL[COLORS[c]]).join('、')) + ' 是你的颜色'
      : '人机局：你用红色，其余 AI');
    return;
  }

  st = fold(base, []);
  render();
  setMsg('人机局：你用红色，其余 ' + (n - 1) + ' 个 AI');
}

/* =============================================================================
 * 渲染
 * ========================================================================== */

/** 棋盘坐标 → canvas 像素。棋盘是 15×15 的格子。 */
const CELL = 40;
function px(cell) {
  return [cell[0] * CELL + CELL / 2, cell[1] * CELL + CELL / 2];
}

function render() {
  drawBoard();
  renderSeats();
  renderControls();
}

function drawBoard() {
  const cv = $('board');
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  /* 底 */
  g.fillStyle = '#f0e7d3';
  g.fillRect(0, 0, W, H);

  /* 外圈 52 格 */
  for (let i = 0; i < RING_LEN; i++) {
    const c = RING[i];
    const isJump = JUMP_IDX.indexOf(i) >= 0;
    /* 每格按「属于哪个颜色」上淡色 —— 走自己的那段路是暖色 */
    const owner = colorOfRing(i);
    g.fillStyle = isJump ? '#a8dcbe' : (owner >= 0 ? lighten(COLOR_HEX[COLORS[owner]], 0.62) : '#e6dcc4');
    roundRect(g, c[0] * CELL + 2, c[1] * CELL + 2, CELL - 4, CELL - 4, 6);
    g.fill();
    g.strokeStyle = 'rgba(0,0,0,.07)';
    g.lineWidth = 1;
    g.stroke();

    if (isJump) {
      g.fillStyle = '#2f8f5b';
      g.font = 'bold 15px sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('飞', c[0] * CELL + CELL / 2, c[1] * CELL + CELL / 2);
    }
    /* 起点标记 */
    if (START_IDX.indexOf(i) >= 0) {
      const ci = START_IDX.indexOf(i);
      g.fillStyle = COLOR_HEX[COLORS[ci]];
      g.beginPath();
      g.arc(c[0] * CELL + CELL / 2, c[1] * CELL + CELL / 2, CELL / 2 - 7, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#fff';
      g.font = 'bold 12px sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(ci + 1), c[0] * CELL + CELL / 2, c[1] * CELL + CELL / 2);
    }
  }

  /* 终点通道 */
  for (let ci = 0; ci < nColorsUsed(); ci++) {
    const L = LANES[ci];
    for (let k = 0; k < L.length; k++) {
      const c = L[k];
      const isEnd = k === L.length - 1;
      g.fillStyle = isEnd ? COLOR_HEX[COLORS[ci]] : lighten(COLOR_HEX[COLORS[ci]], 0.55);
      roundRect(g, c[0] * CELL + 2, c[1] * CELL + 2, CELL - 4, CELL - 4, 6);
      g.fill();
      g.strokeStyle = 'rgba(0,0,0,.08)';
      g.lineWidth = 1;
      g.stroke();
      if (isEnd) {
        g.fillStyle = '#fff';
        g.font = 'bold 13px sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText('终', c[0] * CELL + CELL / 2, c[1] * CELL + CELL / 2);
      }
    }
  }

  /* 棋子 */
  for (let ci = 0; ci < nColorsUsed(); ci++) {
    const row = st.planes[ci] || [];
    /* 按落点分组 —— 同格的叠在一起要错开画 */
    const groups = {};
    for (let i = 0; i < row.length; i++) {
      const p = row[i];
      if (p === HOLD) continue;
      const cell = cellOf(ci, p);
      if (!cell) continue;
      const key = cell[0] + ',' + cell[1];
      if (!groups[key]) groups[key] = [];
      groups[key].push(i);
    }
    for (const key in groups) {
      const arr = groups[key];
      const cell = cellOf(ci, arr[0] === undefined ? 0 : st.planes[ci][arr[0]]);
      if (!cell) continue;
      const [cx, cy] = px(cell);
      const n = arr.length;
      arr.forEach((planeIdx, k) => {
        const off = n === 1 ? 0 : (k - (n - 1) / 2) * 9;
        const ox = cx + off, oy = cy + (n > 1 ? (k % 2 ? 4 : -4) : 0);
        g.beginPath();
        g.arc(ox, oy, 11, 0, Math.PI * 2);
        g.fillStyle = COLOR_HEX[COLORS[ci]];
        g.fill();
        g.strokeStyle = '#fff';
        g.lineWidth = 2;
        g.stroke();
      });
    }
  }

  /* 待飞区（棋盘外的四个角） */
  for (let ci = 0; ci < nColorsUsed(); ci++) {
    const row = st.planes[ci] || [];
    const held = row.filter((p) => p === HOLD).length;
    if (!held) continue;
    const base2 = holdCorner(ci);
    for (let k = 0; k < held; k++) {
      const ox = base2[0] + (k % 2 ? 13 : -13);
      const oy = base2[1] + (k > 1 ? 13 : -13);
      g.beginPath();
      g.arc(ox, oy, 10, 0, Math.PI * 2);
      g.fillStyle = COLOR_HEX[COLORS[ci]];
      g.fill();
      g.strokeStyle = 'rgba(255,255,255,.9)';
      g.lineWidth = 2;
      g.stroke();
    }
  }
}

/** 外圈第 i 格属于哪个颜色（自己那段路是暖色）。 */
function colorOfRing(i) {
  for (let ci = 0; ci < 4; ci++) {
    const s = START_IDX[ci];
    const steps = (i - s + RING_LEN) % RING_LEN;
    if (steps < 13) return ci;      /* 自己起点往前 13 格算自己的路 */
  }
  return -1;
}

/**
 * 待飞区在棋盘内侧的哪个角落。
 *
 * 为什么放内侧而不是起点外侧：
 *   起点在外圈边上，「往外挪」会挪出画布 —— 棋子就被裁掉了。
 *   放内侧的角上既看得见，又不会出界。
 *   红起点在下边 → 左下；黄在右边 → 右下；蓝在上边 → 右上；绿在左边 → 左上。
 */
const HOLD_SPOTS = [
  [2, 12],   /* 红：左下 */
  [11, 12],  /* 黄：右下 */
  [11, 2],   /* 蓝：右上 */
  [2, 2],    /* 绿：左上 */
];
function holdCorner(ci) {
  const spot = HOLD_SPOTS[ci] || HOLD_SPOTS[0];
  return [spot[0] * CELL + CELL / 2, spot[1] * CELL + CELL / 2];
}

function nColorsUsed() {
  return mode === 'p2p' ? Math.min(2, st.n || 2) : (st.n || 4);
}

function lighten(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, gg = (n >> 8) & 255, b = n & 255;
  r = Math.round(r + (255 - r) * amt);
  gg = Math.round(gg + (255 - gg) * amt);
  b = Math.round(b + (255 - b) * amt);
  return 'rgb(' + r + ',' + gg + ',' + b + ')';
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function renderSeats() {
  const bar = $('seatbar');
  bar.innerHTML = '';
  for (let ci = 0; ci < nColorsUsed(); ci++) {
    const row = st.planes[ci] || [];
    const home = row.filter((p) => p === FINISH_POS).length;
    const d = document.createElement('div');
    d.className = 'pill' + (ci === st.turn && !st.over ? ' active' : '');
    d.innerHTML = '<span class="dot" style="background:' + COLOR_HEX[COLORS[ci]] + '"></span>' +
      '<span>' + colorName(ci) + '</span>' +
      '<span class="home">到终点 ' + home + '/4</span>';
    bar.appendChild(d);
  }
}

function renderControls() {
  const mine = isMyTurn();
  $('btn-roll').disabled = !mine || st.over || rolling;
  const hint = $('hint');
  if (st.over) {
    hint.textContent = '本局结束，点「开局」再来一局。';
  } else if (mode === 'p2p') {
    hint.textContent = mine
      ? '轮到你（' + colorName(st.turn) + '）：点「掷骰子」。'
      : '等对方走（当前 ' + colorName(st.turn) + '）。';
  } else {
    hint.textContent = mine
      ? '轮到你：点「掷骰子」，然后选一颗棋子。'
      : 'AI 在想…（当前 ' + colorName(st.turn) + '）';
  }
}

/* =============================================================================
 * 成绩
 * ========================================================================== */
const SAVE_KEY = 'ming.ludo.v1';
function loadScore() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return { coin: 100, wins: 0, best: 100 };
    const o = JSON.parse(raw);
    return { coin: o.coin || 100, wins: o.wins || 0, best: o.best || 100 };
  } catch (e) { return { coin: 100, wins: 0, best: 100 }; }
}
function saveScore(winner) {
  try {
    const s = loadScore();
    const mine = mode === 'p2p' ? ownerOf(winner) === 0 : winner === 0;
    if (mine) { s.wins++; s.coin += 20; s.best = Math.max(s.best, s.coin); }
    else s.coin = Math.max(0, s.coin - 10);
    localStorage.setItem(SAVE_KEY, JSON.stringify(s));
    $('coin').textContent = s.coin;
    $('wins').textContent = s.wins;
    $('best').textContent = s.best;
  } catch (e) { /* 忽略 */ }
}
function renderScore() {
  const s = loadScore();
  $('coin').textContent = s.coin;
  $('wins').textContent = s.wins;
  $('best').textContent = s.best;
}

/* =============================================================================
 * 纯 P2P
 * ========================================================================== */
function setupAuthority() {
  if (!session) return;
  authority = new HostAuthority(session, {
    reduce: (s, acts) => {
      const all = (s.moves || []).concat(acts);
      return { base: s.base, pub: fold(s.base, all), moves: all };
    },
    replay: (seed, acts) => {
      const base2 = (seed && seed.base) || { seed: 0, n: 2 };
      return { base: base2, pub: fold(base2, acts || []), moves: (acts || []).slice() };
    },
    hash: (s) => hashState(s.pub),
    view: (s) => ({ base: s.base, pub: publicView(s.pub), moves: (s.moves || []).slice() }),
    validate: (s, act) => {
      const cur = s.pub;
      if (!cur) return { ok: false, reason: '还没准备好' };
      if (cur.over) return { ok: false, reason: '这局已经结束了' };
      if (!act || act.act !== 'move') return { ok: false, reason: '非法动作' };
      if (act.c !== cur.turn) return { ok: false, reason: '还没轮到你' };
      if (act.r != null && act.r !== cur.roll) return { ok: false, reason: '掷骰序号对不上' };
      /* 点数是算出来的 —— 这里再核一次，房主想改点数也没用 */
      if (act.die != null && act.die !== dieFor(cur.seed, cur.roll)) {
        return { ok: false, reason: '点数对不上（点数是双方各自算出来的）' };
      }
      const legal = legalPlanes(cur, act.c);
      if (act.plane === -1) {
        if (legal.length > 0) return { ok: false, reason: '有棋能走，不能跳过' };
      } else if (legal.indexOf(act.plane) < 0) {
        return { ok: false, reason: '这颗棋子这一步走不了' };
      }
      return true;
    },
  });

  /**
   * 加入方收到权威状态。
   *
   * 关键：**不采信房主广播的局面，自己重放一遍。**
   *
   * 飞行棋的所有信息都是公开可推导的（种子 + 动作序列），
   * 所以加入方完全有能力自己算出「这一局应该是什么样」。
   * 房主广播的局面跟自己对不上 —— 那就是房主在撒谎。
   *
   * 为什么不直接用房主广播的 pub：
   *   万一房主改了 pub（比如偷偷挪了一颗棋子），
   *   加入方照单全收就等于把作弊结果吃下去了。
   * 自己重放，房主改什么都没用。
   */
  const applyState = (s) => {
    if (!s) return;
    const moves = s.moves || [];

    /* 联机局的种子双方都能自己算出来（从房间号派生）——
       房主要是换种子，一眼就能看出来。 */
    const expectSeed = (mode === 'p2p' && session && session.roomId)
      ? seedFromRoom(session.roomId, 'ludo')
      : null;
    if (expectSeed != null && s.base && s.base.seed !== expectSeed) {
      setMsg('房主换了对局的种子 —— 他可能在作弊', 'bad');
      return;
    }

    /* 房主不能截断我的动作 ——
       我提交过的每一步都必须原封不动地出现在动作序列里。 */
    if (mySubmitted.length) {
      let idx = -1;
      let missing = null;
      for (const mine0 of mySubmitted) {
        const at = moves.findIndex((m, k) => k > idx &&
          m.act === 'move' && m.c === mine0.c && m.plane === mine0.plane && m.r === mine0.r);
        if (at < 0) { missing = mine0; break; }
        idx = at;
      }
      if (missing) {
        setMsg('房主改了我走过的某一步 —— 他在作弊', 'bad');
        return;
      }
    }

    /* 自己重放 */
    const b = s.base || base;
    const mine = fold(b, moves);

    /* 房主广播的局面跟自己对不上 → 报出来（但仍然用自己算的） */
    if (s.pub && hashState(s.pub) !== hashState(mine)) {
      setMsg('房主发的棋局跟你自己算的对不上 —— 他可能在作弊', 'bad');
    }
    st = mine;
    render();
  };
  authority.onState(applyState);
  authority.onLocalState((s) => {
    if (!s || !s.pub) return;
    st = s.pub;
    const last = (s.moves || [])[(s.moves || []).length - 1];
    if (last) afterAction(last);
    render();
  });
  authority.onReject((reason) => {
    setMsg('房主驳回了这一手：' + (reason || '不合法'), 'bad');
  });
}

function p2pState(text, cls) {
  const el = $('p2p-state');
  el.textContent = text;
  el.className = 'p2p-state ' + (cls || 'wait');
}

async function genHostCode() {
  const pass = $('host-pass') ? $('host-pass').value.trim() : '';
  try {
    p2pState('正在生成房主码…', 'wait');
    session = new P2PSession({ role: 'host', gameId: 'ludo', name: '房主' });
    setupAuthority();
    session.on('status', (stt, text) => {
      p2pState(text || stt, stt === 'open' ? 'ok' : stt === 'failed' ? 'err' : 'wait');
      if (stt === 'open') { $('rolebar').hidden = true; newGame(); }
    });
    const code = await session.createHostCode(pass);
    $('host-code').value = code;
    $('host-flow').hidden = false;
    p2pState('房主码已生成，发给朋友', 'wait');
  } catch (e) {
    p2pState(e.message || '生成失败', 'err');
  }
}

async function genGuestCode() {
  const hostCode = $('host-in').value.trim();
  const pass = $('host-pass') ? $('host-pass').value.trim() : '';
  if (!hostCode) { p2pState('先把朋友发回的房主码粘进来', 'err'); return; }
  try {
    p2pState('正在生成加入码…', 'wait');
    session = new P2PSession({ role: 'guest', gameId: 'ludo', name: '加入方' });
    setupAuthority();
    session.on('status', (stt, text) => {
      p2pState(text || stt, stt === 'open' ? 'ok' : stt === 'failed' ? 'err' : 'wait');
      if (stt === 'open') { $('rolebar').hidden = true; newGame(); }
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
  } catch (e) {
    p2pState(e.message || '接受失败', 'err');
  }
}

function closeSession() {
  if (session) session.close();
  session = null;
  authority = null;
  $('rolebar').hidden = false;
  $('host-flow').hidden = true;
  $('guest-flow').hidden = true;
  $('host-code').value = '';
  $('guest-code').value = '';
  $('host-in').value = '';
  $('join-in').value = '';
  $('btn-close').hidden = true;
  p2pState('未连接', 'wait');
  newGame();
}

/* =============================================================================
 * 事件绑定
 * ========================================================================== */
$('btn-roll').addEventListener('click', doRoll);
$('btn-new').addEventListener('click', newGame);
$('btn-info').addEventListener('click', () => { $('info').hidden = false; });
$('info-close').addEventListener('click', () => { $('info').hidden = true; });

$('mode-ai').addEventListener('click', () => {
  mode = 'ai';
  $('mode-ai').classList.add('on');
  $('mode-p2p').classList.remove('on');
  $('p2p').hidden = true;
  $('playercount').hidden = false;
  nColors = parseInt($('playercount').value, 10) || 4;
  newGame();
});
$('mode-p2p').addEventListener('click', () => {
  mode = 'p2p';
  $('mode-p2p').classList.add('on');
  $('mode-ai').classList.remove('on');
  $('p2p').hidden = false;
  $('playercount').hidden = true;
  newGame();
});
$('playercount').addEventListener('change', () => {
  nColors = parseInt($('playercount').value, 10) || 4;
  newGame();
});

$('btn-host').addEventListener('click', () => { $('host-flow').hidden = false; $('guest-flow').hidden = true; });
$('btn-join').addEventListener('click', () => { $('guest-flow').hidden = false; $('host-flow').hidden = true; });
$('btn-gen-host').addEventListener('click', genHostCode);
$('btn-gen-guest').addEventListener('click', genGuestCode);
$('btn-accept').addEventListener('click', acceptJoinCode);
$('btn-close').addEventListener('click', closeSession);

function copyTo(el, btn) {
  const text = el.value;
  if (!text) return;
  const done = () => {
    const old = btn.textContent;
    btn.textContent = '已复制';
    setTimeout(() => { btn.textContent = old; }, 1200);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => {
      el.select();
      try { document.execCommand('copy'); done(); } catch (e) { /* 忽略 */ }
    });
  } else {
    el.select();
    try { document.execCommand('copy'); done(); } catch (e) { /* 忽略 */ }
  }
}
$('btn-copy-host').addEventListener('click', () => copyTo($('host-code'), $('btn-copy-host')));
$('btn-copy-guest').addEventListener('click', () => copyTo($('guest-code'), $('btn-copy-guest')));

/* =============================================================================
 * 启动
 * ========================================================================== */
const support = checkSupport();
if (!support.ok) setMsg(support.reason, 'bad');
renderScore();
newGame();
