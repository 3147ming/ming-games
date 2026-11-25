/* =============================================================================
 * undercover/src/main.mjs —— 谁是卧底 · 主控
 * -----------------------------------------------------------------------------
 * 三种对局模式：
 *   ai        人机：你（0 号）+ 若干 AI
 *   hotseat   同屏多人：一台设备轮流玩（开局轮流传手机看词）
 *   p2p       纯 P2P 联机（零服务器，手动交换两段连接码）
 *
 * -----------------------------------------------------------------------------
 * 这个游戏最核心的不是状态同步，而是**私密信息隔离**。三条铁律：
 *
 *   1. 卧底拿的词和身份，绝不能进动作序列，也绝不能进广播状态 ——
 *      否则加入方一眼就知道谁是卧底，游戏当场结束。
 *      词与身份只活在房主的内存里。
 *
 *   2. 加入方只通过一条独立消息拿到「自己的那一个词 + 中性提示」，
 *      连「自己是不是卧底」都不告诉它（线下玩法就是这样）。
 *
 *   3. 投票阶段，广播出去的状态必须裁掉票明细 ——
 *      否则先投的人能从对端状态里看到别人的票。
 *      这靠 src/net/p2p.js 新增的 view 钩子实现（publicView）。
 *
 * 状态同步用「房主权威」模型（见 src/net/p2p.js 的 HostAuthority）：
 *   玩家只上报意图 → 房主校验并推进 → 广播权威状态 →
 *   双方用同一份规则引擎重放，摘要定期比对，不一致由房主下发快照纠偏。
 *
 * AI 座位由房主扮演：AI 的描述/投票由房主生成后写进动作序列 ——
 * 描述是「玩家输入」性质的内容，两端各自随机生成必然对不上。
 * ========================================================================== */

import {
  initPub, applyAction, fold, hashPub, publicView,
  tally, judge, deal, aiDescribe, aiVote, aiRandom,
  UNDERCOVER, PHASE, MIN_PLAYERS, MAX_PLAYERS,
} from './rules.mjs';
import { P2PSession, HostAuthority, checkSupport } from '../../src/net/p2p.js';

const $ = (id) => document.getElementById(id);

/* ---- 全局状态 ---- */
let mode = 'ai';
let nPlayers = 4;
let pub = initPub(4);
let authority = null;
let session = null;

/* 私密信息：只在房主 / 本机内存里，永远不广播、不进动作。
   words[seat] = 该座位的词；roles[seat] = 该座位的身份。 */
let secret = null;             /* { words, roles, pair, spyCount } */
let myWord = '';               /* 我自己的词（联机时由房主单独发来） */
let myHint = '';               /* 中性提示 */

/* 同屏模式的开局发词流程：轮流传手机看词 */
let handout = null;            /* { idx, revealed } —— null 表示不在发词中 */

/* AI 的「局次代号」与暂停开关（同 UNO）：
   aiGen 每次开局/切模式 +1，旧定时器醒来发现代号变了就退出。 */
let aiGen = 0;
let aiPaused = false;
let aiTimer = null;

/* 结算守卫：doResolve 里会调 applyLocal，而 applyLocal 又会走 onAfterAction ——
   如果 onAfterAction 看到 phase 还是 RESOLVE 就会再次进 doResolve，
   无限递归（爆栈）。这个标志把重入挡掉。 */
let resolving = false;

/* =============================================================================
 * 调试钩子（给自动化测试用）
 * ========================================================================== */
globalThis.__UC__ = {
  get session() { return session; },
  get authority() { return authority; },
  get mode() { return mode; },
  get pub() { return pub; },
  get state() { return pub; },
  get turn() { return pub.turnSeat; },
  get phase() { return pub.phase; },
  get mySeat() { return currentSeat(); },
  get myWord() { return myWord; },
  get nPlayers() { return nPlayers; },
  get actionCount() { return authority ? authority.actions.length : 0; },
  get handout() { return handout; },
  refresh() { render(); },
  pauseAI() { aiGen++; aiPaused = true; if (aiTimer) { clearTimeout(aiTimer); aiTimer = null; } },
  resumeAI() { aiPaused = false; scheduleAI(); },
  /* 测试用：看某个座位的词 / 身份（只有房主与本机才有） */
  peekWord(seat) { return secret ? secret.words[seat] : ''; },
  peekRole(seat) { return secret ? secret.roles[seat] : ''; },
  /* 测试用：直接推进状态（绕过界面） */
  act(a) { return applyLocal(a); },
  /* 测试用：跳到下一位该说话的人（hotseat 用） */
  setHandout(idx) { handout = idx === null ? null : { idx, revealed: false }; render(); },
};

/* =============================================================================
 * 座位
 * ========================================================================== */

/**
 * 「我」现在是哪个座位。
 *   p2p     —— 房主 0 号，加入方 1 号
 *   ai      —— 你是 0 号
 *   hotseat —— 当前轮到谁就是谁（一台设备传着玩）
 */
function currentSeat() {
  if (mode === 'p2p') return session ? (session.isHost ? 0 : 1) : 0;
  if (mode === 'ai') return 0;
  return pub.turnSeat;
}

/** 当前模式下每个座位的设置：名字 + 是否 AI（都是公开信息）。 */
function buildSeats() {
  const names = [];
  const ai = [];
  if (mode === 'p2p') {
    names.push('房主（你）', '加入方');
    ai.push(false, false);
    for (let i = 2; i < nPlayers; i++) { names.push('AI · ' + (i + 1)); ai.push(true); }
  } else if (mode === 'ai') {
    names.push('你');
    ai.push(false);
    for (let i = 1; i < nPlayers; i++) { names.push('AI · ' + (i + 1)); ai.push(true); }
  } else {
    for (let i = 0; i < nPlayers; i++) { names.push('玩家 ' + (i + 1)); ai.push(false); }
  }
  return { names, ai };
}

/* =============================================================================
 * 开局
 * ========================================================================== */
function newGame() {
  aiGen++;
  aiPaused = false;
  if (aiTimer) { clearTimeout(aiTimer); aiTimer = null; }

  const seats = buildSeats();
  const spyCount = nPlayers >= 5 ? 2 : 1;

  /* p2p 模式下：只有房主能抽词。
     加入方与「还没建连接的房间」都不能有身份信息 ——
     否则加入方页面会残留上一模式（ai）抽的词与身份。 */
  const isLocalHost = mode !== 'p2p' ? true : !!(session && session.isHost);
  if (!isLocalHost) {
    /* 加入方：手里**不能**有任何身份信息。
       之前切模式时残留了 ai 模式的 secret，加入方因此能读到身份 —— 真泄漏。 */
    secret = null;
    myWord = '';
    myHint = '';
  }
  if (isLocalHost) {
    /* 本机/房主侧：抽词、分配身份 */
    const seed = (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0;
    secret = deal(seed, nPlayers);
    secret.spyCount = spyCount;
    myWord = secret.words[currentSeat()];
    myHint = secret.pair.hint;
  }

  const base = { n: nPlayers, names: seats.names, ai: seats.ai, spyCount };

  if (mode === 'p2p' && authority) {
    /* 联机：房主开局，把 base（纯公开信息）随 seed 一起广播。
       seed 里没有任何私密信息 —— 词和身份不在这里。 */
    if (session && session.isHost) {
      const s = (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0;
      authority.init({ s, base });
      myWord = secret.words[0];
      myHint = secret.pair.hint;
      pub = fold(base, []);
      sendSecretToGuest();
    } else {
      /* 加入方：等房主的权威状态广播过来 */
      pub = initPub(nPlayers, base);
    }
  } else {
    /* 本地：直接开局 */
    pub = initPub(nPlayers, base);
    if (mode === 'hotseat') {
      /* 同屏：先轮流传手机看词 */
      handout = { idx: 0, revealed: false };
      render();
      return;
    }
    applyLocal({ act: 'round', n: 1 });
  }
  render();
  scheduleAI();
}

/* =============================================================================
 * 动作提交
 * ========================================================================== */

/**
 * 本地/房主侧提交一个动作。
 * 联机房主走 authority（它负责广播 + 刷新本地状态 + 校验）。
 */
function applyLocal(act) {
  if (mode === 'p2p' && authority && session && session.isHost) {
    authority.applyLocal(act);
    return { ok: true };
  }
  const r = applyAction(pub, act);
  if (!r.ok) return { ok: false, reason: r.reason };
  pub = r.pub;
  onAfterAction();
  return { ok: true };
}

/** 提交意图：联机加入方发给房主，本机直接落地。 */
function submit(act) {
  if (mode === 'p2p' && authority && session && !session.isHost) {
    authority.input(act);
    $('hint').textContent = '已提交，等房主确认…';
    return { ok: true };
  }
  return applyLocal(act);
}

/** 动作落地后的连锁处理：结算 / 开新一轮 / 触发 AI。 */
function onAfterAction() {
  if (pub.phase === PHASE.RESOLVE && canResolve()) doResolve();
  render();
  scheduleAI();
}

/** 能不能做结算：联机时只有房主能（需要私密身份）。 */
function canResolve() {
  if (mode !== 'p2p' || !session) return true;
  return session.isHost;
}

/**
 * 结算：计票 → 出局 → 判胜负 → 开下一轮或终局。
 * 全部以「动作」形式推进，所以重放路径与本地路径完全一致。
 */
function doResolve() {
  if (!secret || resolving) return;
  resolving = true;
  try {
    doResolveInner();
  } finally {
    resolving = false;
  }
}

function doResolveInner() {
  const seat = tally(pub);
  const role = seat >= 0 ? secret.roles[seat] : undefined;
  applyLocal({ act: 'eliminate', seat, role });

  const j = judge(pub, secret.roles);
  if (j.winner) {
    applyLocal({ act: 'win', who: j.winner });
  } else {
    applyLocal({ act: 'round', n: pub.round + 1 });
  }
  render();
}

/* =============================================================================
 * AI
 * ========================================================================== */
function scheduleAI() {
  if (aiPaused) return;
  if (pub.phase === PHASE.OVER) return;
  const seat = pub.turnSeat;
  if (seat < 0 || seat >= pub.n) return;
  if (!pub.ai[seat]) return;      /* 不是 AI 就不管 */
  if (!secret) return;            /* 没有私密信息（加入方）就做不了 AI */

  const gen = aiGen;
  const rnd = aiRandom('uc|' + pub.round + '|' + seat + '|' + pub.phase);
  const delay = 500 + Math.floor(rnd * 500);
  if (aiTimer) clearTimeout(aiTimer);
  aiTimer = setTimeout(() => {
    aiTimer = null;
    if (gen !== aiGen) return;    /* 这一局作废了 */
    if (aiPaused) return;
    if (pub.turnSeat !== seat) return;
    if (pub.phase === PHASE.DESCRIBE) {
      const text = aiDescribe(secret.pair, secret.words[seat], rnd);
      applyLocal({ act: 'desc', p: seat, text });
    } else if (pub.phase === PHASE.VOTE) {
      const target = aiVote(pub, secret.words[seat], secret.pair, rnd);
      if (target >= 0) applyLocal({ act: 'vote', p: seat, target });
    }
  }, delay);
}

/* =============================================================================
 * 渲染
 * ========================================================================== */
function render() {
  const over = pub.phase === PHASE.OVER;

  $('phase').textContent = over ? '终局' : phaseLabel();
  $('round').textContent = '第 ' + Math.max(1, pub.round) + ' 轮';
  $('spycount').textContent = String(pub.spyCount);
  $('modehint').textContent = modeHint();

  renderHandout();
  renderMyWord();
  renderSeats();
  renderDescs();
  renderVoteBox();
  renderResult();

  $('end').classList.toggle('show', over);
  if (over) {
    $('endtitle').textContent = endTitle();
    $('enddesc').textContent = endDesc();
  }

  $('hint').textContent = handout ? handoutHint() : hintText();
}

/* ---- 同屏模式：轮流传手机看词 ---- */
function renderHandout() {
  const box = $('handout');
  if (!box) return;
  if (!handout) { box.hidden = true; return; }
  box.hidden = false;
  const name = seatName(handout.idx);
  $('handout-name').textContent = name;
  const val = $('handout-word');
  const btn = $('btn-handout');
  if (handout.revealed) {
    val.textContent = secret ? secret.words[handout.idx] : '···';
    val.style.visibility = 'visible';
    btn.textContent = '记住了，看下一位';
  } else {
    val.textContent = secret ? secret.words[handout.idx] : '···';
    val.style.visibility = 'hidden';
    btn.textContent = '查看我的词';
  }
}

function handoutHint() {
  if (!handout) return '';
  const name = seatName(handout.idx);
  if (handout.revealed) return '把手机交给下一位。' + name + ' 看完之后点上面的按钮。';
  return '请把手机交给 ' + name + '，由他本人点按钮查看词（别让旁人看到屏幕）。';
}

function phaseLabel() {
  if (pub.phase === PHASE.DESCRIBE) return '描述轮';
  if (pub.phase === PHASE.VOTE) return '投票轮';
  if (pub.phase === PHASE.RESOLVE) return '结算';
  return '进行中';
}

function modeHint() {
  if (mode === 'ai') return '人机：你 + ' + (nPlayers - 1) + ' 个 AI';
  if (mode === 'hotseat') return '同屏：' + nPlayers + ' 人轮流玩';
  if (!session) return '联机：未连接';
  return session.isHost ? '联机：你是房主（0 号位）' : '联机：你是加入方（1 号位）';
}

function renderMyWord() {
  const box = $('myword');
  const val = $('mywordval');
  const hintEl = $('mywordhint');
  const btn = $('btn-peek');

  if (mode === 'hotseat') {
    /* 同屏：词在上面的发词环节看，这里不重复显示 */
    box.style.display = 'none';
    return;
  }
  box.style.display = '';
  val.textContent = myWord || '···';
  hintEl.textContent = myHint ? ('提示：' + myHint) : '';
  btn.style.display = 'none';
}

function renderSeats() {
  const box = $('seats');
  box.innerHTML = '';
  const voting = pub.phase === PHASE.VOTE;
  const me = currentSeat();
  for (let i = 0; i < pub.n; i++) {
    const el = document.createElement('div');
    const alive = pub.alive[i];
    const isTurn = pub.turnSeat === i && pub.phase !== PHASE.OVER;
    const revealed = pub.reveals ? pub.reveals[i] : null;
    el.className = 'seat' + (isTurn ? ' turn' : '') + (alive ? '' : ' out');
    el.dataset.seat = String(i);

    let st = alive ? '在场' : '已出局';
    if (revealed) st = revealed === UNDERCOVER ? '出局 · 卧底' : '出局 · 平民';

    const canVote = voting && alive && i !== me && pub.turnSeat === me && isHumanSeat(i);
    if (canVote) {
      el.classList.add('votable');
      el.addEventListener('click', () => {
        const r = submit({ act: 'vote', p: me, target: i });
        if (r && r.ok === false) $('hint').textContent = r.reason;
      });
    }

    el.innerHTML =
      '<div class="nm">' + escapeHtml(seatName(i)) + (i === me ? '（你）' : '') + '</div>' +
      '<div class="tag">' + (pub.ai && pub.ai[i] ? '电脑' : '真人') + '</div>' +
      '<div class="st">' + st + '</div>' +
      (revealed ? '<div class="role ' + (revealed === UNDERCOVER ? 'spy' : 'civ') + '">' +
        (revealed === UNDERCOVER ? '卧底' : '平民') + '</div>' : '');
    box.appendChild(el);
  }
}

function isHumanSeat(i) {
  return !(pub.ai && pub.ai[i]);
}

function seatName(i) {
  return (pub.names && pub.names[i]) || ('玩家 ' + (i + 1));
}

function renderDescs() {
  const box = $('descs');
  box.innerHTML = '';
  for (const d of pub.descs || []) {
    const el = document.createElement('div');
    el.className = 'desc' + (d.p === currentSeat() ? ' mine' : '');
    el.innerHTML = '<span class="who">' + escapeHtml(seatName(d.p)) + '</span>' +
      '<span class="txt">' + escapeHtml(d.text) + '</span>';
    box.appendChild(el);
  }
}

function renderVoteBox() {
  const vb = $('votebox');
  const db = $('descbox');
  const me = currentSeat();
  const myTurn = pub.turnSeat === me && pub.phase !== PHASE.OVER;

  if (pub.phase === PHASE.DESCRIBE && myTurn) {
    db.hidden = false;
    $('btn-desc').disabled = false;
  } else {
    db.hidden = true;
    $('descin').value = '';
  }

  const canVote = pub.phase === PHASE.VOTE && myTurn;
  vb.hidden = !(pub.phase === PHASE.VOTE);
  if (pub.phase === PHASE.VOTE) {
    $('votetitle').textContent = canVote ? '指认谁是卧底（不能投自己）' : '大家正在投票…';
    const grid = $('votegrid');
    grid.innerHTML = '';
    for (let i = 0; i < pub.n; i++) {
      if (!pub.alive[i] || i === me) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = escapeHtml(seatName(i));
      b.disabled = !canVote;
      b.addEventListener('click', () => {
        const r = submit({ act: 'vote', p: me, target: i });
        if (r && r.ok === false) $('hint').textContent = r.reason;
      });
      grid.appendChild(b);
    }
  }
}

function renderResult() {
  const box = $('result');
  if (pub.phase !== PHASE.RESOLVE && pub.phase !== PHASE.OVER) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const votes = pub.votes || {};
  const counts = {};
  for (const k of Object.keys(votes)) {
    counts[votes[k]] = (counts[votes[k]] || 0) + 1;
  }
  const parts = [];
  for (const k of Object.keys(counts)) {
    parts.push(escapeHtml(seatName(Number(k))) + ' ' + counts[k] + ' 票');
  }
  let html = '<b>本轮票型：</b>' + (parts.length ? parts.join('、') : '无人投票');
  if (pub.lastElim >= 0 && pub.reveals && pub.reveals[pub.lastElim]) {
    const r = pub.reveals[pub.lastElim];
    html += '<br><b>' + escapeHtml(seatName(pub.lastElim)) + '</b> 出局，身份是 ' +
      '<b>' + (r === UNDERCOVER ? '卧底' : '平民') + '</b>';
  } else if (pub.phase === PHASE.RESOLVE) {
    html += '<br>平票，本轮无人出局。';
  }
  box.innerHTML = html;
}

function endTitle() {
  return pub.winner === UNDERCOVER ? '卧底赢了' : '平民赢了';
}

function endDesc() {
  if (!secret) return '本局结束。';
  const lines = [];
  for (let i = 0; i < pub.n; i++) {
    const role = secret.roles[i] === UNDERCOVER ? '卧底' : '平民';
    lines.push(escapeHtml(seatName(i)) + '：' + escapeHtml(secret.words[i]) + '（' + role + '）');
  }
  if (secret.roles[currentSeat()] === UNDERCOVER) lines.push('—— 你就是那个卧底。');
  return lines.join('\n');
}

function hintText() {
  if (pub.phase === PHASE.OVER) return '本局结束，点「再来一局」重开。';
  if (pub.phase === PHASE.RESOLVE) return '正在结算…';
  const seat = pub.turnSeat;
  const who = seatName(seat);
  if (seat === currentSeat()) {
    if (pub.phase === PHASE.DESCRIBE) return '轮到你描述：说一个能让人猜到、又不会直接暴露的特征。';
    return '轮到你投票：指认一个最可疑的人。';
  }
  if (pub.phase === PHASE.DESCRIBE) return '轮到 ' + who + ' 描述，等一下。';
  return '轮到 ' + who + ' 投票，等一下。';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* =============================================================================
 * 联机：房主权威
 * ========================================================================== */
function setupAuthority() {
  if (!session) return;
  authority = new HostAuthority(session, {
    /* 房主侧推进：把动作累加后重放一遍 —— 与本地路径同一份 applyAction */
    reduce: (s, acts) => {
      const all = (s.moves || []).concat(acts);
      return { base: s.base, pub: fold(s.base, all), moves: all };
    },
    /* 双方重放：seed 里只有公开的 base，没有任何私密信息 */
    replay: (seed, acts) => {
      const base = (seed && seed.base) || { n: nPlayers };
      return { base, pub: fold(base, acts || []), moves: (acts || []).slice() };
    },
    /* 摘要只算公开部分 —— 两端一致 */
    hash: (s) => hashPub(publicView(s.pub)),
    /* 广播前的视图裁剪：投票阶段去掉票明细（见 rules.mjs 的说明 C） */
    view: (s) => ({ base: s.base, pub: publicView(s.pub) }),
    /* 合法性校验：房主必须先验这一手能不能打。
       不验的话，非法动作会被塞进动作序列，之后每次重放都在那一手断掉 ——
       整局就此卡死，两端状态再也对不上。 */
    validate: (s, act) => {
      const st = s.pub;
      if (!st) return { ok: false, reason: '牌局还没准备好' };
      if (st.phase === PHASE.OVER) return { ok: false, reason: '这局已经结束了' };
      if (!act) return { ok: false, reason: '空动作' };
      /* round / eliminate / win 由房主自己产生，不需要校验 */
      if (act.act !== 'desc' && act.act !== 'vote') return true;
      if (st.turnSeat !== act.p) {
        return { ok: false, reason: '还没轮到你（房主这边是 ' + st.turnSeat + ' 号位）' };
      }
      if (act.act === 'desc') {
        if (st.phase !== PHASE.DESCRIBE) return { ok: false, reason: '现在不是描述阶段' };
        if (!String(act.text || '').trim()) return { ok: false, reason: '描述不能为空' };
        if (String(act.text).length > 60) return { ok: false, reason: '描述太长了' };
        return true;
      }
      if (st.phase !== PHASE.VOTE) return { ok: false, reason: '现在不是投票阶段' };
      if (!Number.isInteger(act.target)) return { ok: false, reason: '投票对象不合法' };
      if (act.target === act.p) return { ok: false, reason: '不能投自己' };
      if (!st.alive[act.target]) return { ok: false, reason: '不能投已出局的人' };
      return true;
    },
  });

  const applyState = (s) => {
    if (!s || !s.pub) return;
    pub = s.pub;
    render();
    scheduleAI();
  };
  authority.onState(applyState);
  authority.onLocalState(applyState);
  authority.onReject((reason) => {
    $('hint').textContent = '房主驳回了这一手：' + (reason || '不合法');
  });
}

/** 房主把加入方自己的那一个词单独发过去（不进广播状态）。 */
function sendSecretToGuest() {
  if (!session || !session.isHost || !secret) return;
  if (!session.isOpen) {
    /* 通道还没开 —— 稍后再发 */
    setTimeout(sendSecretToGuest, 400);
    return;
  }
  session.send({ t: 'uc-secret', word: secret.words[1], hint: secret.pair.hint });
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
  handout = null;
  newGame();
}

/* =============================================================================
 * 联机 UI
 * ========================================================================== */
async function genHostCode() {
  const pass = $('host-pass').value.trim();
  try {
    p2pState('正在生成房主码…', 'wait');
    session = new P2PSession({ role: 'host', gameId: 'undercover', name: '房主' });
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
    session = new P2PSession({ role: 'guest', gameId: 'undercover', name: '玩家' });
    setupAuthority();
    session.on('status', (st, text) => {
      p2pState(text || st, st === 'open' ? 'ok' : st === 'failed' ? 'err' : 'wait');
      if (st === 'open') { $('rolebar').hidden = true; newGame(); }
    });
    /* 房主会把「你自己的那一个词」单独发来 —— 不在广播状态里 */
    session.on('message', (m) => {
      if (m && m.t === 'uc-secret') {
        myWord = m.word || '';
        myHint = m.hint || '';
        render();
      }
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
  secret = null;
  myWord = '';
  myHint = '';
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
$('playercount').addEventListener('change', (e) => {
  nPlayers = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, Number(e.target.value) || 4));
  e.target.value = String(nPlayers);
  newGame();
});
$('restart').addEventListener('click', newGame);
$('again').addEventListener('click', newGame);

$('btn-desc').addEventListener('click', () => {
  const text = $('descin').value.trim();
  if (!text) { $('hint').textContent = '先写一句描述。'; return; }
  const me = currentSeat();
  const r = submit({ act: 'desc', p: me, text });
  if (r && r.ok === false) $('hint').textContent = r.reason;
  else $('descin').value = '';
});
$('descin').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-desc').click();
});

/* 同屏发词流程 */
$('btn-handout').addEventListener('click', () => {
  if (!handout) return;
  if (!handout.revealed) {
    handout.revealed = true;
    render();
    return;
  }
  /* 看完了 → 下一位 */
  if (handout.idx + 1 < nPlayers) {
    handout = { idx: handout.idx + 1, revealed: false };
    render();
  } else {
    handout = null;
    applyLocal({ act: 'round', n: 1 });
    render();
  }
});

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
nPlayers = Number($('playercount').value) || 4;
newGame();
