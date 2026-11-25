/* =============================================================================
 * uno/src/main.mjs —— UNO 彩牌主控
 * -----------------------------------------------------------------------------
 * 三种对局模式：
 *   ai        人机（你执蓝牌，AI 执红牌）
 *   hotseat   同屏双人（同一台设备轮流下）
 *   p2p       纯 P2P 联机（零服务器，手动交换两段连接码）
 *
 * 联机采用「房主权威」模型（见 src/net/p2p.js 的 HostAuthority）：
 *   · 玩家只上报出牌意图（input）
 *   · 房主判定合法性、推进牌局、广播权威状态（state）
 *   · 加入方用同一份规则引擎重放，状态一致
 *   · 定期比对摘要（hash），不一致由房主下发快照（sync）纠偏
 *
 * 关键：UNO 的状态含「双方手牌」，是私密信息 ——
 *       联机时加入方只应该看到自己的手牌和对方的张数。
 *       房主广播完整状态给加入方（在这个简化模型里可以接受，
 *       因为只有 2 人、都是朋友局；要严格的话应让房主分别裁剪视图）。
 * ========================================================================== */

import {
  COLORS, COLOR_LABEL, COLOR_HEX, WILD, SKIP, REVERSE, DRAW2,
  parseCard, canPlay, play, drawOne, drawAction, deal, hasPlayable, advance,
  cloneState, hashState, replay, aiChoose, countColor,
} from './rules.mjs';
import { P2PSession, HostAuthority, checkSupport } from '../../src/net/p2p.js';

const $ = (id) => document.getElementById(id);

const SEATS = ['红牌方', '蓝牌方'];
const SEAT_COLORS = ['red', 'blue'];

/* ---- 全局状态 ---- */
let mode = 'ai';
let state = deal(1, 2);
let session = null;
let authority = null;
let thinking = false;
let pendingWild = null;      /* 待选色的万能牌 {cardId, player} */
let seed = 1;

/* 调试钩子：方便自动化测试与排查联机问题（无隐私数据）。 */
globalThis.__UNO__ = {
  get session() { return session; },
  get authority() { return authority; },
  get mode() { return mode; },
  get state() { return state; },
  get turn() { return state.turn; },
  get winner() { return state.winner; },
  get mySeat() { return mySeat; },
  /* 外部改了 state 之后要调这个重画界面 */
  refresh() { updateUI(); },
  /* 已确认的动作数 —— 联机同步测试用它当证据：
     顶牌可能碰巧是同一张 id（手里有两张一样的），光看 top 判不出「有没有同步」。 */
  get actionCount() { return authority ? authority.actions.length : 0; },
  /* 测试用：暂停 AI。
     摆确定性场景时如果 AI 还在跑，它会跟着出牌/摸牌，把场景搅乱 ——
     所以先 pause 再摆场景，断言完再 resume。
     暂停时 aiGo 干脆不启动，AI 也不会跟着摸牌。 */
  pauseAI() { aiGen++; thinking = false; aiPaused = true; },
  resumeAI() { aiPaused = false; if (mode === 'ai' && state.turn === 0 && state.winner < 0) aiGo(); },
};
/* 我在这个座位上（联机时房主是 0 号位红牌，加入方是 1 号位蓝牌）。
   注意：联机建通道时必须按 session.isHost 同步更新 ——
   之前写死成 1，导致房主把自己的手牌当成了「当前玩家」的手牌，
   界面显示和出牌逻辑全错位。 */
let mySeat = 1;

/* AI 的「局次代号」与暂停开关。
   aiGen：每次开局/切模式 +1，旧定时器醒来发现代号变了就退出 ——
          不这么做，切模式那一瞬间排队的 AI 定时器会跑到新局上出手。
   aiPaused：测试摆确定性场景时暂停 AI，免得它跟着出牌把场景搅乱。 */
let aiGen = 0;
let aiPaused = false;

/* =============================================================================
 * 渲染
 * ========================================================================== */
function cardStyle(id) {
  const c = parseCard(id);
  if (c.color === WILD) {
    return { bg: '', label: c.value === WILD ? 'W' : c.value === DRAW2 ? '+2' : c.value === SKIP ? '⊘' : '⇄', cls: 'wild' };
  }
  return { bg: COLOR_HEX[c.color], label: String(c.value), cls: '' };
}

function renderTop() {
  const el = $('top');
  const st = cardStyle(state.top);
  el.className = 'top-card ' + st.cls;
  if (!st.cls) el.style.background = st.bg;
  else el.style.background = '';
  const c = parseCard(state.top);
  el.innerHTML = st.label + (c.color === WILD ? '<small>' + (c.value === WILD ? '万能' : c.value) + '</small>' : '');
}

function renderHand() {
  const box = $('hand');
  box.innerHTML = '';
  const seat = currentSeat();
  const hand = state.hands[seat] || [];
  const myTurn = state.turn === seat && state.winner < 0;
  for (const id of hand) {
    const st = cardStyle(id);
    const playable = myTurn && canPlay(id, state.top, state.activeColor);
    const el = document.createElement('div');
    el.className = 'hand-card ' + st.cls + (playable ? ' playable' : ' dim');
    if (!st.cls) el.style.background = st.bg;
    else el.style.background = '';
    const c = parseCard(id);
    el.innerHTML = '<small>' + (c.color === WILD ? (c.value === WILD ? '万能' : c.value) : COLOR_LABEL[c.color]) + '</small>' + st.label;
    el.dataset.id = id;
    el.title = c.color === WILD ? (c.value === WILD ? '万能牌' : c.value) : COLOR_LABEL[c.color] + ' ' + c.value;
    if (playable) el.addEventListener('click', () => onPlayCard(id));
    box.appendChild(el);
  }
}

function renderOpponent() {
  const seat = currentSeat() === 0 ? 1 : 0;
  const hand = state.hands[seat] || [];
  $('opp-name').textContent = oppName(seat);
  $('opp-count').textContent = hand.length + ' 张';
  const fan = $('opp-fan');
  fan.innerHTML = '';
  for (const id of hand) {
    const st = cardStyle(id);
    const el = document.createElement('div');
    el.className = 'mini ' + st.cls;
    if (!st.cls) el.style.background = st.bg;
    else el.style.background = 'conic-gradient(from 0deg,#e0483c,#f5c542,#3fb96b,#3d8bd8,#e0483c)';
    fan.appendChild(el);
  }
}

function updateUI() {
  const seat = currentSeat();
  const over = state.winner >= 0;
  $('phase').textContent = over ? '终局' : (thinking ? 'AI 思考中' : '进行中');
  $('deckcount').textContent = String(state.deck.length);
  const cdot = $('cdot');
  cdot.style.background = COLOR_HEX[state.activeColor] || '#888';

  if (over) {
    $('turn').textContent = '已结束';
  } else if (mode === 'ai') {
    $('turn').textContent = state.turn === 0 ? 'AI 思考中' : '轮到你';
  } else if (mode === 'p2p') {
    $('turn').textContent = state.turn === mySeat ? '轮到你' : '等对方出牌';
  } else {
    $('turn').textContent = (state.turn === 0 ? '红牌方' : '蓝牌方') + '出牌';
  }

  $('modehint').textContent = {
    ai: '人机：你执蓝牌，AI 执红牌',
    hotseat: '同屏双人：轮流出牌',
    p2p: '联机：' + (session ? (session.isHost ? '你是房主（红牌）' : '你是加入方（蓝牌）') : '未连接'),
  }[mode] || '';

  $('hint').textContent = over ? endText() : hintText();

  $('btn-draw').disabled = over || state.turn !== seat || mode === 'p2p' && !session;
  if (mode === 'p2p' && session && !session.isOpen) $('btn-draw').disabled = true;

  renderTop();
  renderHand();
  renderOpponent();

  $('end').classList.toggle('show', over);
  if (over) {
    $('endtitle').textContent = state.winner === mySeat ? '你赢了' : (mode === 'ai' ? 'AI 赢了' : (SEATS[state.winner] + '赢了'));
    $('enddesc').textContent = endText();
  }
}

/* 我当前是哪个座位 */
function currentSeat() {
  if (mode === 'p2p' && session) return session.isHost ? 0 : 1;
  if (mode === 'ai') return 1;      /* 玩家执蓝牌 */
  return state.turn;               /* 同屏：当前出牌的人就是"我" */
}

function oppName(seat) {
  if (mode === 'ai') return seat === 0 ? 'AI（红牌）' : '你（蓝牌）';
  if (mode === 'p2p') return session
    ? (seat === 0 ? '对方（红牌）' : '你（蓝牌）')
    : SEATS[seat];
  return SEATS[seat];
}

function hintText() {
  if (mode === 'ai') return '点手牌出牌。颜色或数字对上就能接；牌库空了会自动回收弃牌堆。';
  if (mode === 'hotseat') return '同屏双人：轮到谁谁点牌。红牌方先出。';
  return '纯 P2P 联机：先在下面连上通道，再出牌。';
}

/* =============================================================================
 * 终局文案
 * ========================================================================== */
let _endTextCache = null;
function endText() {
  if (_endTextCache !== null) return _endTextCache;
  if (state.winner < 0) { _endTextCache = ''; return _endTextCache; }
  const w = SEATS[state.winner];
  if (mode === 'ai') {
    const youWin = state.winner === 1;
    _endTextCache = youWin ? '你清完了手牌！' : 'AI 先清完了手牌。';
    return _endTextCache;
  }
  _endTextCache = w + '先出完手牌。';
  return _endTextCache;
}

/* =============================================================================
 * 出牌 / 摸牌
 * ========================================================================== */
function onPlayCard(id) {
  if (state.winner >= 0) return;
  const seat = currentSeat();
  if (state.turn !== seat) { $('hint').textContent = '还没轮到你出牌。'; return; }

  const c = parseCard(id);
  /* 万能牌要先选颜色 */
  if (c.color === WILD) {
    if (c.value !== WILD) {
      /* +2 / 跳过 / 反转：功能牌不选颜色，直接出 */
      doPlay(id, null);
      return;
    }
    pendingWild = id;
    showColorPick((color) => { pendingWild = null; doPlay(id, color); });
    return;
  }
  doPlay(id, null);
}

function doPlay(id, color) {
  if (mode === 'p2p') {
    /* 联机：只上报意图，由房主判定 */
    const act = { p: currentSeat(), act: 'play', id, color: color || undefined };
    if (session && session.isHost) hostApply(act);
    else { authority.input(act); $('hint').textContent = '已出牌，等房主确认…'; }
    return;
  }
  const r = play(state, currentSeat(), id, color);
  if (!r.ok) { $('hint').textContent = r.reason; return; }
  state = r.state;
  _endTextCache = null;
  updateUI();
  if (mode === 'ai' && state.winner < 0) aiGo();
}

function onDraw() {
  if (state.winner >= 0) return;
  const seat = currentSeat();
  if (state.turn !== seat) { $('hint').textContent = '还没轮到你。'; return; }
  if (mode === 'p2p') {
    const act = { p: currentSeat(), act: 'draw' };
    if (session && session.isHost) hostApply(act);
    else { authority.input(act); $('hint').textContent = '已请求摸牌，等房主确认…'; }
    return;
  }
  /* 用 drawAction（完整语义，含「接不上就跳过回合」）——
     联机重放走的是同一个函数，两端行为必须一致。 */
  const r = drawAction(state, seat);
  if (!r.ok) { $('hint').textContent = r.reason; return; }
  const stillMine = r.state.turn === seat;
  state = r.state;
  _endTextCache = null;
  updateUI();
  if (stillMine) {
    $('hint').textContent = '摸到能接的牌了 —— 点亮着的那张出。';
  } else {
    $('hint').textContent = '摸到的牌接不上，这轮跳过。';
  }
  if (mode === 'ai' && state.winner < 0) aiGo();
}

/**
 * AI 出手。
 * 注意：AI 出了「跳过/反转」牌时轮次会回到自己（两人局），
 * 这时必须接着出 —— 否则玩家永远等不到自己的回合（死锁）。
 * 所以这里用一个循环把「该 AI 连出的牌」一次出完，
 * 中途 thinking 一直保持 true（别反复置位/清零把界面搞抖）。
 *
 * aiGen 是「局次代号」：每次开局/切模式都会 +1，
 * 旧定时器醒来时发现代号变了就直接退出 ——
 * 不这么做的话，切模式那一瞬间排队的 AI 定时器会跑到新局上出手，
 * 手牌数、轮次全乱（这个坑踩过一次）。
 */
function aiGo() {
  if (aiPaused) return;
  const gen = aiGen;
  thinking = true;
  updateUI();
  setTimeout(() => {
    if (gen !== aiGen) return;          /* 这一局已经作废了 */
    const seat = 0;
    let guard = 0;
    /* 最多连出 20 张，防止逻辑出错时无限循环 */
    while (state.turn === seat && state.winner < 0 && guard++ < 20) {
      const choice = aiChoose(state, seat, (seed * 31 + state.hands[0].length + guard) >>> 0);
      if (!choice) {
        /* AI 没牌可出 → 摸一张。
           用 drawAction（完整语义）：接得上就接着出，接不上就自动跳过回合。 */
        const r = drawAction(state, seat);
        if (!r.ok) break;
        state = r.state;
        continue;
      }
      const res = play(state, seat, choice.id, choice.color);
      if (!res.ok) break;
      state = res.state;
      _endTextCache = null;
    }
    thinking = false;
    updateUI();
  }, 320);
}

/* =============================================================================
 * 万能牌选色
 * ========================================================================== */
function showColorPick(cb) {
  const row = $('colorrow');
  row.innerHTML = '';
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = COLOR_LABEL[c];
    b.style.background = COLOR_HEX[c];
    b.addEventListener('click', () => { $('colorpick').classList.remove('show'); cb(c); });
    row.appendChild(b);
  }
  $('colorpick').classList.add('show');
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

  const toArr = (a) => a.slice();
  const fromArr = (a) => a.slice();

  /* 双方共用的状态重建：从动作序列重放，保证结果一致。
     注意 seed 必须用**房主定的那个**（从 state.seed 拿），
     绝不能用各自的模块级 seed —— 两端 seed 不同，重放出来的牌序就不同，
     摘要永远对不上，会陷入「要同步 → 要同步」的死循环。 */
  const buildState = (sd, actions) => {
    const r = replay(actions, Number(sd) >>> 0, 2);
    return {
      state: {
        deck: toArr(r.state.deck),
        hands: r.state.hands.map(fromArr),
        discard: toArr(r.state.discard),
        top: r.state.top,
        activeColor: r.state.activeColor,
        direction: r.state.direction,
        turn: r.state.turn,
        winner: r.state.winner,
        lastPlayed: r.state.lastPlayed,
      },
      moves: actions.slice(),
    };
  };

  authority = new HostAuthority(session, {
    reduce: (s, actions) => buildState(s.seed, (s.moves || []).concat(actions)),
    replay: (sd, actions) => buildState(sd, actions || []),
    hash: (s) => hashState(s.state),
    /* 合法性校验：房主必须先验这一手能不能打。
       不验的话，非法动作会被塞进动作序列，之后每次重放都在那一手断掉 ——
       整局就此卡死，两端状态再也对不上。 */
    validate: (s, act) => {
      const st = s.state;
      if (!st) return { ok: false, reason: '牌局还没准备好' };
      if (st.winner >= 0) return { ok: false, reason: '这局已经结束了' };
      if (!act) return { ok: false, reason: '空动作' };
      if (st.turn !== act.p) {
        return { ok: false, reason: '还没轮到你出牌（房主这边 turn=' + st.turn + '，你报的是 ' + act.p + '）' };
      }
      if (act.act !== 'play') return { ok: true };
      const hand = st.hands[act.p] || [];
      if (hand.indexOf(act.id) < 0) {
        return { ok: false, reason: '手里没有这张牌（你报 ' + act.id + '）' };
      }
      if (!canPlay(act.id, st.top, st.activeColor)) {
        return { ok: false, reason: '这张牌接不上（顶牌 ' + st.top + '，生效色 ' + st.activeColor + '，你出 ' + act.id + '）' };
      }
      return { ok: true };
    },
  });

  const applyState = (s) => {
    state = cloneState(s.state);
    _endTextCache = null;
    updateUI();
  };
  authority.onState(applyState);
  authority.onLocalState(applyState);
  /* 房主驳回这一手时告诉用户 —— 不说的话加入方会以为牌已经打出去了 */
  authority.onReject((reason) => {
    $('hint').textContent = '房主驳回了这一手：' + (reason || '不合法');
  });
}

function p2pState(text, cls) {
  const el = $('p2p-state');
  el.textContent = text;
  el.className = 'p2p-state ' + (cls || 'wait');
}

/* =============================================================================
 * 模式与开局
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
  aiGen++;              /* 作废上一局排队中的 AI 定时器 */
  aiPaused = false;     /* 新一局恢复正常，AI 该出手 */
  seed = (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0;
  state = deal(seed, 2);
  thinking = false;
  pendingWild = null;
  _endTextCache = null;
  if (authority) {
    /* 联机局由房主开局 —— seed 必须是**数字**，加入方要用同一个 seed 重放牌序。
       传字符串的话加入方 Number() 出来是 NaN，牌序就全乱了。 */
    if (session && session.isHost) authority.init(seed);
  }
  updateUI();
  if (mode === 'ai' && state.winner < 0) aiGo();
}

/* =============================================================================
 * 联机 UI
 * ========================================================================== */
async function genHostCode() {
  const pass = $('host-pass').value.trim();
  try {
    p2pState('正在生成房主码…', 'wait');
    session = new P2PSession({ role: 'host', gameId: 'uno', name: '房主' });
    mySeat = 0;
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
    session = new P2PSession({ role: 'guest', gameId: 'uno', name: '玩家' });
    mySeat = 1;
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
$('btn-draw').addEventListener('click', onDraw);

$('btn-host').addEventListener('click', () => { $('host-flow').hidden = false; $('guest-flow').hidden = true; $('rolebar').hidden = true; });
$('btn-join').addEventListener('click', () => { $('guest-flow').hidden = false; $('host-flow').hidden = true; $('rolebar').hidden = true; });
$('btn-gen-host').addEventListener('click', genHostCode);
$('btn-gen-guest').addEventListener('click', genGuestCode);
$('btn-accept').addEventListener('click', acceptJoinCode);
$('btn-close').addEventListener('click', closeSession);
$('btn-copy-host').addEventListener('click', () => copyTo($('host-code'), $('btn-copy-host')));
$('btn-copy-guest').addEventListener('click', () => copyTo($('guest-code'), $('btn-copy-guest')));

/* 环境自检 */
const sup = checkSupport();
if (!sup.ok) {
  const opt = $('mode').querySelector('option[value="p2p"]');
  if (opt) { opt.disabled = true; opt.textContent = '纯 P2P 联机（本浏览器不支持）'; }
  $('p2p').hidden = true;
}

/* 启动 */
setMode('ai');
updateUI();
