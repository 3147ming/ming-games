/* =============================================================================
 * blast/src/main.mjs —— 方块爆破主控
 * -----------------------------------------------------------------------------
 * 模式：
 *   solo    单人无限：自己跟自己比，撑爆即结束
 *   ai      人机对战：各打各的盘，谁先撑爆谁输
 *   daily   每日固定局：种子由日期派生，当天所有人盘面一致
 *   p2p     纯 P2P 联机：房主权威 + 双方各自重放，随机数算出来而非抽出来
 *
 * ---------------------------------------------------------------------------
 * 随机与可复现
 * -----------------------------------------------------------------------------
 * 一切影响局面的随机都来自 seed + 计数器，写在 rules.mjs 里。
 * 这里只在单机/人机开局时用 randomSeed() 造一次 seed（一次性，写进状态），
 * 每日局从日期派生，P2P 从房号派生 —— 双方必然算出同一个种子。
 *
 * ---------------------------------------------------------------------------
 * P2P 难点
 * -----------------------------------------------------------------------------
 * 新方块的颜色是随机值 —— 如果房主说了算，他就能挑颜色坑对手。
 * 解法：随机数 = f(seed, 计数器)，hashState 含 seed 与计数器，房主改不了。
 * 加入方用同一份动作序列自己重放，摘要对不上就报「房主在作弊」。
 *
 * 纪律：顶层不碰 DOM / localStorage，全部在启动段。
 * ========================================================================== */

import {
  COLS, ROWS, COLORS, EMPTY, PALETTE, SEAT_HOST, SEAT_GUEST, UNDO_ALL, UNDO_SEAT,
  randomSeed, seedFromRoom, dailySeed, todayKey,
  idx, initState, applyAction, fold, replay, hashState, publicView,
  legalMoves, aiChoose, levelOf, maxHeight, blockCount,
} from './rules.mjs';
import { P2PSession, HostAuthority } from '../../src/net/p2p.js';

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------------------
 * 全局状态
 * ------------------------------------------------------------------------- */
let mode = 'solo';
let st = null;
let seed = 0;
let base = null;              /* { seed, seats, opts } —— P2P 重放的底 */
let acts = [];                /* 已提交的动作序列 */
let mySeat = 0;               /* P2P 座位 */
let session = null;
let authority = null;
let aiTimer = 0;
let lastMsg = '';

/* 调试钩子（端到端测试用） */
globalThis.__BLAST__ = {
  get pub() { return st ? publicView(st) : null; },
  get seed() { return seed; },
  get hash() { return st ? hashState(st) : ''; },
  get over() { return st ? st.over : false; },
  get winner() { return st ? st.winner : -1; },
  get score() { return st ? st.seatsState[mySeat]?.score || 0 : 0; },
  get moves() { return st ? st.moves : 0; },
  get mode() { return mode; },
  get mySeat() { return mySeat; },
  get actionCount() { return acts.length; },
  get cells() { return st ? (st.seatsState[mySeat]?.cells || []).slice() : []; },
  get sessionOpen() { return !!(session && session.isOpen); },
  get isHost() { return !!(session && session.isHost); },
  start: (m) => startMode(m),
  act: (x, y) => doAct({ act: 'blast', seat: mySeat, x, y }),
  undo: () => doAct({ act: 'undo', seat: mySeat }),
};

/* ---------------------------------------------------------------------------
 * 存档（try/catch，file:// 下 localStorage 可能抛）
 * ------------------------------------------------------------------------- */
const SAVE_KEY = 'mg_blast.v1';
function loadSave() {
  try { return JSON.parse(localStorage.getItem(SAVE_KEY) || '{}') || {}; }
  catch { return {}; }
}
function save(patch) {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify({ ...loadSave(), ...patch })); }
  catch { /* 忽略 */ }
}

function setMsg(text, cls) {
  lastMsg = text;
  const el = $('msg');
  el.textContent = text;
  el.className = 'msg' + (cls ? ' ' + cls : '');
}

/* ---------------------------------------------------------------------------
 * 开局
 * ------------------------------------------------------------------------- */
function startMode(m) {
  mode = m;
  clearTimeout(aiTimer);
  closeSession();
  $('mode-solo').classList.toggle('on', m === 'solo');
  $('mode-ai').classList.toggle('on', m === 'ai');
  $('mode-daily').classList.toggle('on', m === 'daily');
  $('mode-p2p').classList.toggle('on', m === 'p2p');
  $('p2p-panel').hidden = (m !== 'p2p');
  $('ai-box').hidden = (m !== 'ai' && m !== 'p2p');
  $('btn-undo').disabled = false;

  if (m === 'daily') {
    seed = dailySeed(todayKey(), 'blast');
    base = { seed, seats: 1, opts: {} };
  } else if (m === 'ai') {
    seed = randomSeed();
    base = { seed, seats: 2, opts: {} };
  } else if (m === 'solo') {
    seed = randomSeed();
    base = { seed, seats: 1, opts: {} };
  } else {
    /* P2P：等连接建立后再开局 */
    st = null; acts = []; seed = 0; base = null;
    setMsg('先建立连接，房主会自动开局', '');
    render();
    return;
  }
  mySeat = 0;
  acts = [];
  st = initState(seed, base.seats, base.opts);
  setMsg(m === 'daily' ? '今日盘面人人相同，比谁连锁更高' : '点一个方块开始爆破', '');
  save({ mode: m });
  render();
  scheduleAI();
}

function newGame() { startMode(mode); }

/* ---------------------------------------------------------------------------
 * 动作
 * ------------------------------------------------------------------------- */
function doAct(act) {
  if (!act) return;
  if (mode === 'p2p') {
    if (!session || !session.isOpen) { setMsg('还没连上', 'lose'); return; }
    if (act.act === 'undo' && !($('btn-undo').disabled)) {
      /* 联机撤销只撤自己的盘，通过权威序列广播 */
    }
    if (session.isHost) {
      applyLocal(act);
    } else {
      /* 加入方：动作发给房主，等房主广播权威状态 */
      session.send({ t: 'blast-act', act });
    }
    return;
  }
  acts.push(act);
  st = fold(base, acts);
  render();
  scheduleAI();
  if (st.over) onOver();
}

function applyLocal(act) {
  acts.push(act);
  st = fold(base, acts);
  if (session && session.isHost && authority) authority.applyLocal(act);
  render();
  scheduleAI();
  if (st.over) onOver();
}

function scheduleAI() {
  clearTimeout(aiTimer);
  if (mode !== 'ai' || !st || st.over || st.turn !== SEAT_GUEST) return;
  aiTimer = setTimeout(() => {
    const a = aiChoose(st, SEAT_GUEST);
    if (a) doAct(a);
  }, 420);
}

function onOver() {
  const w = st.winner;
  if (mode === 'p2p') {
    setMsg(w === mySeat ? '你赢了！' : w === 2 ? '平局' : '你输了', w === mySeat ? 'win' : 'lose');
  } else if (mode === 'ai') {
    setMsg(w === 0 ? '你赢了！' : w === 2 ? '平局' : '你撑爆了', w === 0 ? 'win' : 'lose');
  } else {
    setMsg('撑爆了 · 本局得分 ' + st.seatsState[0].score, 'lose');
  }
  const best = Math.max(loadSave().best || 0, st.seatsState[mySeat]?.score || 0);
  save({ best });
  $('btn-undo').disabled = false;   /* 结束后仍可撤销回看 */
}

/* ---------------------------------------------------------------------------
 * 渲染
 * ------------------------------------------------------------------------- */
function drawBoard(el, seat, cells) {
  if (!el) return;
  const cols = st?.cols || COLS, rows = st?.rows || ROWS;
  el.style.gridTemplateColumns = `repeat(${cols}, 38px)`;
  el.innerHTML = '';
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const c = cells[idx(x, y, cols)] || EMPTY;
      const d = document.createElement('div');
      d.className = 'cell' + (c ? ' has c' + c : '');
      d.dataset.x = x; d.dataset.y = y;
      if (c) d.style.background = PALETTE[c - 1] || '#ccc';
      el.appendChild(d);
    }
  }
}

function render() {
  if (!st) {
    $('board').innerHTML = '';
    $('score').textContent = '—'; $('best').textContent = '—';
    $('moves').textContent = '—'; $('level').textContent = '—';
    $('seed').textContent = '—'; $('chain').textContent = '';
    return;
  }
  const my = st.seatsState[mySeat] || st.seatsState[0];
  const foe = st.seatsState[1 - mySeat];
  drawBoard($('board'), mySeat, my.cells);
  if (foe && !$('ai-box').hidden) drawBoard($('aiboard'), 1 - mySeat, foe.cells);
  $('score').textContent = my.score;
  $('best').textContent = my.best + ' 段';
  $('moves').textContent = my.myMoves;
  $('level').textContent = levelOf(my.myMoves);
  $('seed').textContent = st.seed;
  $('chain').textContent = st.lastChain > 1 ? ('上次连锁 ×' + st.lastChain + ' +' + st.lastGain) : '';
  if (foe) $('ai-score').textContent = foe.score;
  $('board-title').textContent = (mode === 'p2p' ? (session?.isHost ? '房主' : '加入方') : '你的棋盘');
  $('btn-undo').disabled = !st.hist || !st.hist.length || !st.allowUndo;
  const top = maxHeight(my.cells, st.cols, st.rows);
  if (top >= st.rows - 1 && !st.over) setMsg('警告：快顶到天花板了！', 'lose');
}

/* ---------------------------------------------------------------------------
 * P2P：房主权威
 * ------------------------------------------------------------------------- */
function setupAuthority() {
  if (!session) return;
  authority = new HostAuthority(session, {
    /* rules.fold 从 base 顶层读 undoScope/cols/rows ——
       所以要把 base.opts 展开到顶层，否则两端会用不同的撤销范围算出不同摘要。 */
    reduce: (s, newActs) => {
      const all = (s.moves || []).concat(newActs);
      const flat = Object.assign({}, s.base, s.base.opts || {});
      return { base: s.base, pub: fold(flat, all), moves: all };
    },
    replay: (b, as) => {
      const bb = b || base;
      const flat = Object.assign({}, bb, bb.opts || {});
      return { base: bb, pub: fold(flat, as || []), moves: (as || []).slice() };
    },
    hash: (s) => hashState(s.pub),
    view: (s) => ({ base: s.base, pub: publicView(s.pub), moves: (s.moves || []).slice() }),
    validate: (s, a) => {
      const cur = s.pub;
      if (!cur) return { ok: false, reason: '还没开局' };
      if (cur.over) return { ok: false, reason: '已经结束' };
      if (!a || !Number.isInteger(a.seat)) return { ok: false, reason: '坏动作' };
      if (a.seat !== cur.turn) return { ok: false, reason: '还没轮到你' };
      if (a.act === 'blast') {
        if (!Number.isInteger(a.x) || !Number.isInteger(a.y)) return { ok: false, reason: '坐标非法' };
        if (a.x < 0 || a.x >= cur.cols || a.y < 0 || a.y >= cur.rows) return { ok: false, reason: '越界' };
        if (cur.seatsState[a.seat].cells[idx(a.x, a.y, cur.cols)] === EMPTY) return { ok: false, reason: '空格不能炸' };
        return true;
      }
      if (a.act === 'undo') return { ok: true };
      return { ok: false, reason: '未知动作' };
    },
  });

  const applyState = (s) => {
    if (!s || !s.pub) return;
    /* 加入方不采信房主广播 —— 自己重放一遍 */
    if (!session.isHost) {
      const expectSeed = seedFromRoom(session.roomId, 'blast');
      if (s.base && s.base.seed !== expectSeed) {
        setMsg('房主换了对局的种子 —— 他可能在作弊', 'lose');
        return;
      }
      const mine = fold(Object.assign({}, s.base, s.base.opts || {}), s.moves || []);
      if (hashState(mine) !== hashState(s.pub)) {
        setMsg('房主发的局面跟你自己算的对不上 —— 他可能在作弊', 'lose');
        return;
      }
      /* 校验自己提交的动作没被截断 */
      for (const a of acts) {
        if (!a || a.act !== 'blast') continue;
        const found = (s.moves || []).some((m) => m.act === 'blast' && m.seat === a.seat && m.x === a.x && m.y === a.y);
        if (!found) { setMsg('房主删了我的一步 —— 他可能在作弊', 'lose'); return; }
      }
    }
    base = s.base;
    seed = s.base.seed;
    st = s.pub;
    acts = (s.moves || []).slice();
    render();
    if (st.over) onOver();
  };
  authority.onState(applyState);
  authority.onLocalState((s) => {
    if (!s || !s.pub) return;
    base = s.base; st = s.pub; seed = s.base.seed;
    acts = (s.moves || []).slice();
    render();
    if (st.over) onOver();
  });
  authority.onReject((reason) => setMsg('房主驳回了这一步：' + reason, 'lose'));
}

function p2pState(text, cls) {
  const el = $('p2p-state');
  el.textContent = text;
  el.className = 'p2p-state ' + (cls || '');
}

async function genHostCode() {
  try {
    p2pState('正在生成房主码…', '');
    session = new P2PSession({ role: 'host', gameId: 'blast', name: '房主' });
    setupAuthority();
    session.on('status', (s, text) => {
      p2pState(text || s, s === 'open' ? 'ok' : s === 'failed' ? 'err' : '');
      if (s === 'open') {
        $('rolebar').hidden = true;
        mySeat = SEAT_HOST;
        seed = seedFromRoom(session.roomId, 'blast');
        base = { seed, seats: 2, opts: { undoScope: UNDO_SEAT } };
        acts = [];
        st = initState(seed, 2, base.opts);
        authority.init(base);
        render();
      }
    });
    session.on('message', (m) => {
      if (!m) return;
      if (m.t === 'blast-act') applyLocal(m.act);
    });
    const code = await session.createHostCode('');
    $('host-code').value = code;
    $('host-flow').hidden = false;
    $('rolebar').hidden = true;
    p2pState('房主码已生成，发给朋友吧', '');
  } catch (e) { p2pState(e.message || '生成失败', 'err'); }
}

async function genGuestCode() {
  const hostCode = $('host-in').value.trim();
  try {
    p2pState('正在生成加入码…', '');
    session = new P2PSession({ role: 'guest', gameId: 'blast', name: '加入方' });
    setupAuthority();
    session.on('status', (s, text) => {
      p2pState(text || s, s === 'open' ? 'ok' : s === 'failed' ? 'err' : '');
      if (s === 'open') {
        $('rolebar').hidden = true;
        mySeat = SEAT_GUEST;
        seed = seedFromRoom(session.roomId, 'blast');
        render();
      }
    });
    const code = await session.createGuestCode(hostCode, '');
    $('guest-code').value = code;
    $('guest-flow').hidden = false;
    $('rolebar').hidden = true;
    p2pState('加入码已生成，发回房主', '');
  } catch (e) { p2pState(e.message || '生成失败', 'err'); }
}

async function acceptJoinCode() {
  const code = $('join-in').value.trim();
  if (!code) { p2pState('先把加入码粘进来', 'err'); return; }
  try {
    p2pState('正在建立通道…', '');
    await session.acceptGuestCode(code);
  } catch (e) { p2pState(e.message || '接受失败', 'err'); }
}

function closeSession() {
  clearTimeout(aiTimer);
  if (session) { try { session.close(); } catch { /* 忽略 */ } session = null; }
  authority = null;
  if ($('rolebar')) {
    $('rolebar').hidden = false;
    $('host-flow').hidden = true;
    $('guest-flow').hidden = true;
    $('host-code').value = '';
    $('guest-code').value = '';
    $('host-in').value = '';
    $('join-in').value = '';
    p2pState('未连接 · 不连任何服务器，需手动交换连接码', '');
  }
}

/* ---------------------------------------------------------------------------
 * 启动
 * ------------------------------------------------------------------------- */
function boot() {
  $('board').addEventListener('click', (e) => {
    const c = e.target.closest('.cell');
    if (!c || !c.classList.contains('has')) return;
    if (mode === 'ai' && st && st.turn !== SEAT_HOST) return;
    doAct({ act: 'blast', seat: mySeat, x: +c.dataset.x, y: +c.dataset.y });
  });
  $('btn-undo').addEventListener('click', () => doAct({ act: 'undo', seat: mySeat }));
  $('btn-new').addEventListener('click', newGame);
  $('mode-solo').addEventListener('click', () => startMode('solo'));
  $('mode-ai').addEventListener('click', () => startMode('ai'));
  $('mode-daily').addEventListener('click', () => startMode('daily'));
  $('mode-p2p').addEventListener('click', () => startMode('p2p'));
  $('btn-host').addEventListener('click', genHostCode);
  $('btn-guest').addEventListener('click', genGuestCode);
  $('btn-accept').addEventListener('click', acceptJoinCode);
  $('btn-close').addEventListener('click', () => { closeSession(); setMsg('已断开', ''); });

  const s = loadSave();
  mode = s.mode || 'solo';
  if (mode === 'p2p') mode = 'solo';   /* 联机不自动恢复 */
  startMode(mode);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
