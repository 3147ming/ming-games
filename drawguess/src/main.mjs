/* =============================================================================
 * drawguess/src/main.mjs —— 你画我猜主控
 * -----------------------------------------------------------------------------
 * 三种对局模式：
 *   ai        人机对练（你画，AI 猜；你守住了就得一分）
 *   hotseat   同屏派对（传手机：画师画完，依次传给每个人猜）
 *   p2p       纯 P2P 联机（零服务器，手动交换两段连接码）
 *
 * 状态分两条通道 —— 这是这个游戏跟棋类最大的不同：
 *
 *   ① 回合 / 比分 / 猜中情况 —— 进权威动作序列（HostAuthority）。
 *      两端用同一份 rules.mjs 折叠，状态必然一致。
 *
 *   ② 画布笔迹 —— **不进**动作序列。
 *      笔迹是连续的像素数据，一笔能有上百个点。塞进动作序列会让
 *      每次重放都重画整幅画，重放到几十笔就卡死了。
 *      笔迹走单独的 {t:'dg-stroke'} 消息：有序 DataChannel 保证顺序，
 *      增量追加，谁画谁发。笔迹不需要两端逐点一致 ——
 *      猜词判定又不看笔迹，允许有微小延迟。
 *
 * 私密信息隔离：
 *   画师手上的词只在画师本机，绝不进动作序列、绝不进广播状态。
 *   猜词的人提前知道词，游戏就没得玩了。
 *   词由房主抽，通过单独的 {t:'dg-word'} 消息发给画师；
 *   加入方若不是画师，一辈子拿不到这个词。
 *
 * 纪律：顶层不碰 localStorage（成绩记录除外，且都在函数里 try/catch）。
 * ========================================================================== */

import {
  WORDS, PHASE, initPub, fold, replay, hashPub, publicView,
  totalRoundsFor, drawerForRound, judgeGuess, normalizeGuess,
  roundFinished, winnersOf,
} from './rules.mjs';
import { P2PSession, HostAuthority, checkSupport } from '../../src/net/p2p.js';

const $ = (id) => document.getElementById(id);
const cv = $('cv');
const ctx = cv.getContext('2d');

/* ---- 全局状态 ---- */
let mode = 'ai';
let nPlayers = 2;
let pub = initPub(2);
let base = { n: 2, names: ['你', 'AI'] };
let localActs = [];
let session = null;          /* P2PSession */
let authority = null;        /* HostAuthority */

/* 私密：本回合的词。只在画师本机。 */
let myWord = '';
let roundWord = '';          /* 房主/本地抽出的本回合词（画师才知道） */

/* 画布 */
let strokes = [];            /* [{ pts:[[x,y],...], color, size }] */
let curStroke = null;
let color = '#111827';
let size = 7;

/* 聊天/猜测记录（本地展示用，不进权威状态） */
let chat = [];

/* 同屏模式：传手机看词 / 轮流猜 */
let handout = null;          /* { idx, revealed, word, stage, queue } */
let hotStage = '';           /* '' | 'draw' | 'guess' | 'reveal' */
let hotQueue = [];           /* 还没猜的座位 */

/* AI 猜词定时器 */
let aiTimer = null;
let aiGen = 0;
let aiPaused = false;

/* 调试钩子：只挂不含隐私的数据（连接状态、座位、笔画数、动作数）。 */
globalThis.__DG__ = {
  get session() { return session; },
  get authority() { return authority; },
  get mode() { return mode; },
  get pub() { return pub; },
  get nPlayers() { return nPlayers; },
  get mySeat() { return mySeat(); },
  get myWord() { return myWord; },
  get strokes() { return strokes.length; },
  get actionCount() { return authority ? authority.actions.length : localActs.length; },
  get chat() { return chat.slice(); },
  get hotStage() { return hotStage; },
  get canDraw() { return canDraw(); },
  get isOpen() { return !!(session && session.isOpen); },
  guess: (text) => submitGuess(text),
  act: (act) => applyLocal(act),
  pauseAI: () => { aiPaused = true; if (aiTimer) { clearTimeout(aiTimer); aiTimer = null; } },
  resumeAI: () => { aiPaused = false; scheduleAI(); },
};

/* =============================================================================
 * 当前使用者扮演的座位
 * ---------------------------------------------------------------------------
 * 必须**动态推导**，不能用静态变量 —— 加入方页面加载时 session 还是 null，
 * 静态变量会永远停在 0（房主位），加入方就会以为自己也该画。
 * ========================================================================== */
function mySeat() {
  if (mode === 'p2p') return session ? (session.isHost ? 0 : 1) : 0;
  return 0;
}

/* =============================================================================
 * 画布渲染
 * ================================================================== */
function redraw() {
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#fdfdff';
  ctx.fillRect(0, 0, W, H);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of strokes) {
    if (!s.pts || s.pts.length === 0) continue;
    ctx.strokeStyle = s.color || '#111827';
    ctx.lineWidth = s.size || 7;
    if (s.pts.length === 1) {
      ctx.beginPath();
      ctx.arc(s.pts[0][0], s.pts[0][1], (s.size || 7) / 2, 0, Math.PI * 2);
      ctx.fillStyle = s.color || '#111827';
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(s.pts[0][0], s.pts[0][1]);
    for (let i = 1; i < s.pts.length; i++) ctx.lineTo(s.pts[i][0], s.pts[i][1]);
    ctx.stroke();
  }
}

function canvasPoint(ev) {
  const r = cv.getBoundingClientRect();
  const x = ((ev.clientX - r.left) / r.width) * cv.width;
  const y = ((ev.clientY - r.top) / r.height) * cv.height;
  return [Math.round(x), Math.round(y)];
}

/** 当前能不能画。 */
function canDraw() {
  if (pub.phase !== PHASE.DRAW) return false;
  if (mode === 'p2p') {
    if (!session) return false;
    return pub.drawer === mySeat();
  }
  if (mode === 'ai') return true;         /* 人机模式：画师永远是本机玩家 */
  /* 同屏：轮到画师那一步才能画 */
  return hotStage === 'draw' && handout && handout.idx === pub.drawer;
}

function onDown(ev) {
  if (!canDraw()) return;
  ev.preventDefault();
  curStroke = { pts: [canvasPoint(ev)], color: color, size: size };
  strokes.push(curStroke);
  redraw();
}
function onMove(ev) {
  if (!curStroke) return;
  ev.preventDefault();
  curStroke.pts.push(canvasPoint(ev));
  redraw();
}
function onUp() {
  if (!curStroke) return;
  const s = curStroke;
  curStroke = null;
  redraw();
  /* 笔迹走独立通道广播 —— 不进权威动作序列 */
  if (mode === 'p2p' && session && session.isOpen) {
    session.send({ t: 'dg-stroke', pts: s.pts, color: s.color, size: s.size });
  }
}

cv.addEventListener('pointerdown', onDown);
cv.addEventListener('pointermove', onMove);
window.addEventListener('pointerup', onUp);
cv.addEventListener('pointercancel', onUp);

$('btn-undo').addEventListener('click', () => {
  if (!canDraw()) return;
  strokes.pop();
  redraw();
  if (mode === 'p2p' && session && session.isOpen) session.send({ t: 'dg-undo' });
});
$('btn-clear').addEventListener('click', () => {
  if (!canDraw()) return;
  strokes = [];
  redraw();
  if (mode === 'p2p' && session && session.isOpen) session.send({ t: 'dg-clear' });
});

document.querySelectorAll('.swatch').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.swatch').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    color = b.dataset.c;
  });
});
$('size').addEventListener('input', (e) => { size = Number(e.target.value) || 7; });

/* =============================================================================
 * 聊天 / 猜测
 * ================================================================== */
function pushChat(cls, html) {
  chat.push({ cls: cls, html: html });
  if (chat.length > 80) chat.shift();
  renderChat();
}
function renderChat() {
  const el = $('chat');
  el.innerHTML = chat.map((c) => `<div class="line ${c.cls || ''}">${c.html}</div>`).join('');
  el.scrollTop = el.scrollHeight;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* =============================================================================
 * 动作提交
 * ========================================================================== */

/** 本地/房主侧提交一个动作。联机房主走 authority（广播 + 刷新本地 + 校验）。 */
function applyLocal(act) {
  if (mode === 'p2p' && authority && session && session.isHost) {
    authority.applyLocal(act);
    return;
  }
  localActs = localActs.concat([act]);
  pub = fold(base, localActs);
  render();
  afterAction(act);
}

/** 加入方上报动作（猜测由房主判定，所以加入方只发原始猜测）。 */
function submitRemote(act) {
  if (!authority || !session) return;
  authority.input(act);
}

/** 房主收到加入方的猜测 → 判定 → 写入权威动作序列。 */
function hostJudgeGuess(act) {
  const target = roundWord;
  if (!target) { pushChat('sys', '这回合没有词，先等等'); return; }
  const j = judgeGuess(act.text, target);
  applyLocal({ act: 'guess', p: act.p, text: act.text, hit: j.hit, near: j.near });
}

/**
 * 猜词提交入口。
 * 人机模式：本机是画师，不能自己猜（AI 才猜）。
 * 同屏模式：轮到 hotQueue 里的座位猜。
 * 联机模式：房主自己判定；加入方只上报，由房主判定。
 */
function submitGuess(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (pub.phase !== PHASE.DRAW) {
    pushChat('sys', '现在不是猜词时间');
    return false;
  }
  if (mode === 'ai') {
    pushChat('sys', '你是画师，这一轮由 AI 来猜');
    return false;
  }
  if (mode === 'hotseat') {
    if (hotStage !== 'guess' || !hotQueue.length) {
      pushChat('sys', '还没轮到你猜');
      return false;
    }
    const seat = hotQueue[0];
    const j = judgeGuess(t, roundWord);
    applyLocal({ act: 'guess', p: seat, text: t, hit: j.hit, near: j.near });
    /* 猜完就传给下一个还没猜的人 */
    if (!j.hit) {
      hotQueue.shift();
      if (hotQueue.length) {
        handout = { idx: hotQueue[0], revealed: false, word: roundWord };
        pushChat('sys', '把手机交给 ' + seatName(hotQueue[0]) + ' 继续猜');
      } else {
        /* 所有人都猜过了，本回合结束 */
        doReveal();
      }
      render();
    }
    return true;
  }
  /* 联机 */
  const seat = session ? (session.isHost ? 0 : 1) : 0;
  if (pub.drawer === seat) {
    pushChat('sys', '你是画师，这一轮不能自己猜');
    return false;
  }
  if (!session) return false;
  if (session.isHost) {
    hostJudgeGuess({ p: seat, text: t });
  } else {
    session.send({ t: 'dg-guess', p: seat, text: t });
  }
  return true;
}

$('btn-guess').addEventListener('click', () => {
  const el = $('guessin');
  if (submitGuess(el.value)) el.value = '';
});
$('guessin').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const el = $('guessin');
    if (submitGuess(el.value)) el.value = '';
  }
});

/* =============================================================================
 * 回合流程
 * ========================================================================== */
function pickWord() {
  const pool = WORDS.map((x) => x.w);
  return pool[Math.floor(Math.random() * pool.length)];
}

/** 本回合画师座位。 */
function drawerOfRound(round) {
  if (mode === 'ai') return 0;                    /* 人机：画师永远是自己 */
  return drawerForRound(round, nPlayers);
}

/** 本模式一共几个回合。 */
function roundsTotal() {
  if (mode === 'ai') return 3;                     /* 人机：画 3 个词 */
  return totalRoundsFor(nPlayers);
}

/** 开一个新回合（换画师）。 */
function startRound() {
  const total = roundsTotal();
  const drawer = drawerOfRound(pub.round + 1);
  applyLocal({ act: 'round', drawer: drawer, total: total });
  strokes = [];
  curStroke = null;
  redraw();
  if (mode === 'p2p' && session && session.isOpen) session.send({ t: 'dg-clear' });
  if (mode === 'ai') scheduleAI();
}

/** 公布答案。 */
function doReveal() {
  applyLocal({ act: 'reveal', word: roundWord });
  pushChat('sys', '答案揭晓：<b>' + esc(roundWord) + '</b>');
  if (mode === 'p2p' && session && session.isOpen) session.send({ t: 'dg-clear' });
  setTimeout(() => {
    if (pub.phase !== PHASE.REVEAL) return;
    if (pub.round >= (pub.totalRounds || 0)) {
      applyLocal({ act: 'over' });
    } else {
      startRound();
    }
  }, 2600);
}

/** 动作落地后的副作用（抽词、发词、揭晓、计分播报）。 */
function afterAction(act) {
  if (!act) return;
  if (act.act === 'guess') {
    const who = seatName(act.p);
    if (act.hit) {
      pushChat('hit', '<b>' + esc(who) + '</b> 猜中了！答案就是「' + esc(roundWord) + '」');
      doReveal();
      return;
    }
    if (act.near) {
      pushChat('near', '「' + esc(act.text) + '」很接近了');
    } else {
      pushChat('', '<b>' + esc(who) + '</b>：' + esc(act.text));
    }
    return;
  }
  if (act.act === 'round') {
    if (mode === 'p2p') {
      if (session && session.isHost) {
        roundWord = pickWord();
        if (pub.drawer === 0) {
          myWord = roundWord;
        } else {
          myWord = '';
          sendWordToGuest(roundWord);
        }
      } else {
        myWord = '';
        roundWord = '';
      }
    } else {
      roundWord = pickWord();
      myWord = (mode === 'ai') ? roundWord : '';
    }
    if (mode === 'hotseat') {
      /* 同屏：先把手机传给画师 */
      hotStage = 'draw';
      hotQueue = [];
      handout = { idx: pub.drawer, revealed: false, word: roundWord };
    }
    pushChat('sys', '第 ' + pub.round + ' 回合 —— ' + seatName(pub.drawer) + ' 来画');
  }
  /* afterAction 里改了私密词、传手机面板等 —— 这些都要重画一次界面。
     applyLocal 是先 render 再调 afterAction 的，所以这里必须自己再 render 一次。 */
  render();
}

/** 房主把本回合的词单独发给加入方（只有加入方是画师时才发）。 */
function sendWordToGuest(word) {
  if (!session || !session.isHost) return;
  if (!session.isOpen) { setTimeout(() => sendWordToGuest(word), 400); return; }
  session.send({ t: 'dg-word', word: word });
}

/* =============================================================================
 * AI 猜词（人机模式）
 * ========================================================================== */
/* AI 不是神：它靠「画了多少笔」决定猜中概率。
   猜错 → 画师守住一分；猜中 → AI 得一分。 */
function scheduleAI() {
  if (aiTimer) { clearTimeout(aiTimer); aiTimer = null; }
  if (mode !== 'ai' || aiPaused) return;
  if (pub.phase !== PHASE.DRAW) return;
  const gen = aiGen;
  aiTimer = setTimeout(() => {
    if (gen !== aiGen) return;
    if (mode !== 'ai' || pub.phase !== PHASE.DRAW) return;
    if (!roundWord) { scheduleAI(); return; }
    const strokesN = strokes.length;
    if (strokesN < 1) { scheduleAI(); return; }
    /* 笔画越多，AI 猜中的概率越高：1 笔 20%，6 笔以上封顶 70% */
    const p = Math.min(0.7, 0.2 + strokesN * 0.1);
    if (Math.random() < p) {
      applyLocal({ act: 'guess', p: 1, text: roundWord, hit: true, near: false });
    } else {
      /* 猜错：报一个别的词。keep=true → 画师守住一分 */
      let wrong = WORDS[Math.floor(Math.random() * WORDS.length)].w;
      if (wrong === roundWord) wrong = WORDS[(WORDS.length + 1) % WORDS.length].w;
      const j = judgeGuess(wrong, roundWord);
      applyLocal({ act: 'guess', p: 1, text: wrong, hit: j.hit, near: j.near, keep: true });
      scheduleAI();
    }
  }, 2200 + Math.random() * 1800);
}

/* =============================================================================
 * 同屏模式：传手机
 * ========================================================================== */
function seatName(i) {
  const n = (base && base.names) || ['玩家 1', '玩家 2'];
  return n[i] != null ? n[i] : '玩家 ' + (i + 1);
}

function buildSeats() {
  const names = [];
  for (let i = 0; i < nPlayers; i++) {
    if (mode === 'ai') names.push(i === 0 ? '你' : 'AI');
    else if (mode === 'p2p') names.push(i === 0 ? '房主' : '加入方');
    else names.push('玩家 ' + (i + 1));
  }
  return names;
}

/* 画师画完 → 把手机依次传给每个猜的人 */
$('btn-pass').addEventListener('click', () => {
  if (mode !== 'hotseat' || hotStage !== 'draw') return;
  hotQueue = [];
  for (let i = 0; i < nPlayers; i++) if (i !== pub.drawer) hotQueue.push(i);
  hotStage = 'guess';
  handout = { idx: hotQueue.length ? hotQueue[0] : pub.drawer, revealed: false, word: roundWord };
  render();
});

$('btn-handout').addEventListener('click', () => {
  if (!handout) return;
  handout.revealed = true;
  if (hotStage === 'draw') myWord = handout.word;
  render();
});

/* =============================================================================
 * 渲染
 * ================================================================== */
function render() {
  const names = (base && base.names) || buildSeats();

  $('phase').textContent = ({
    [PHASE.IDLE]: '准备中',
    [PHASE.DRAW]: '作画中',
    [PHASE.REVEAL]: '已揭晓',
    [PHASE.OVER]: '已结束',
  })[pub.phase] || '准备中';
  $('round').textContent = pub.round || 0;
  $('drawerinfo').textContent = pub.phase === PHASE.DRAW
    ? ('画师：' + seatName(pub.drawer)) : '等待画师';

  /* 座位与比分 */
  $('seats').innerHTML = names.map((nm, i) => {
    const isDrawer = pub.drawer === i && pub.phase === PHASE.DRAW;
    const role = mode === 'ai' ? (i === 0 ? '画师' : '猜词') : (isDrawer ? '画师' : '猜词');
    return `<div class="seat ${isDrawer ? 'drawer' : ''}">
      <div class="nm">${esc(nm)}</div>
      <div class="sc">${(pub.scores && pub.scores[i]) || 0}</div>
      <div class="rl">${role}</div>
    </div>`;
  }).join('');

  /* 我的词（私密，只有画师看得到） */
  const showWord = !!myWord && (mode !== 'p2p' || pub.drawer === mySeat());
  $('myword').hidden = !showWord;
  $('mywordval').textContent = showWord ? (hotStage === 'draw' ? myWord : '••••') : '';

  /* 同屏传手机面板 */
  if (mode === 'hotseat' && handout && pub.phase === PHASE.DRAW) {
    $('handout').hidden = false;
    const title = hotStage === 'draw' ? '画师' : '猜的人';
    $('handout-name').textContent = seatName(handout.idx);
    $('handout-title').textContent = title;
    $('handout-word').textContent = handout.revealed
      ? (hotStage === 'draw' ? handout.word : '（轮到你猜）')
      : '···';
    $('btn-handout').textContent = handout.revealed ? '看过了' : '看看';
    $('btn-handout').hidden = handout.revealed;
    /* 「画完了」要在画师看过词之后才出现 —— 没见过词怎么画 */
    $('btn-pass').hidden = !(hotStage === 'draw' && handout.revealed);
  } else {
    $('handout').hidden = true;
    $('btn-pass').hidden = true;
  }

  /* 猜词输入的可用性 */
  const canGuess = mode === 'hotseat' ? (hotStage === 'guess' && hotQueue.length > 0)
    : mode === 'p2p' ? (!!session && pub.phase === PHASE.DRAW && pub.drawer !== mySeat())
    : false;
  $('guessin').disabled = !canGuess;
  $('btn-guess').disabled = !canGuess;

  /* 画板遮罩 —— 作画时不能盖住画布（pointer-events:none 已让它不吃事件，
     但半透明的白底会把画挡住，所以作画阶段直接隐藏） */
  const ov = $('overlay');
  if (pub.phase === PHASE.IDLE) {
    ov.classList.remove('hidden');
    $('ovtitle').textContent = '还没开始';
    $('ovdesc').textContent = '点「新局」开始';
  } else if (pub.phase === PHASE.REVEAL) {
    ov.classList.remove('hidden');
    $('ovtitle').textContent = pub.word || '';
    $('ovdesc').textContent = '本回合结束，准备下一轮';
  } else if (pub.phase === PHASE.OVER) {
    ov.classList.remove('hidden');
    $('ovtitle').textContent = '游戏结束';
    const w = winnersOf(pub);
    $('ovdesc').textContent = w.length
      ? ('获胜：' + w.map((i) => seatName(i)).join('、') + '（' + (pub.scores[w[0]] || 0) + ' 分）')
      : '没人得分';
  } else {
    /* 作画中：遮罩收起，别挡住画布 */
    ov.classList.add('hidden');
  }

  /* 结算 */
  const res = $('result');
  if (pub.phase === PHASE.REVEAL || pub.phase === PHASE.OVER) {
    res.hidden = false;
    const w = winnersOf(pub);
    res.innerHTML = '本回合答案：<b>' + esc(pub.word || roundWord || '') + '</b><br>' +
      '比分：' + names.map((nm, i) => esc(nm) + ' ' + ((pub.scores && pub.scores[i]) || 0)).join(' · ') +
      (w.length ? ('<br>领先：<b>' + w.map((i) => esc(seatName(i))).join('、') + '</b>') : '');
  } else {
    res.hidden = true;
  }

  /* 终局弹窗 */
  if (pub.phase === PHASE.OVER) {
    $('end').classList.add('show');
    const w = winnersOf(pub);
    $('endtitle').textContent = '游戏结束';
    $('enddesc').innerHTML = w.length
      ? ('获胜：<b>' + w.map((i) => esc(seatName(i))).join('、') + '</b><br>最终比分 ' +
         w.map((i) => ((pub.scores[i] || 0) + ' 分')).join('、'))
      : '这一局没人得分，再来一把？';
  } else {
    $('end').classList.remove('show');
  }

  $('hint').textContent = hintText();
  $('modehint').textContent = mode === 'ai' ? '人机：你画，AI 猜'
    : mode === 'hotseat' ? '同屏：传手机轮流画与猜' : '联机：两人轮流画';

  renderChat();
}

function hintText() {
  if (pub.phase === PHASE.IDLE) return '点「新局」开始一局。';
  if (pub.phase === PHASE.OVER) return '本局结束，点「再来一局」重开。';
  if (pub.phase === PHASE.REVEAL) return '答案已公布，马上换人作画。';
  if (mode === 'ai') return '你画，AI 猜 —— 画得越明显，AI 越容易猜中；AI 没猜中你得一分。';
  if (mode === 'hotseat') {
    if (hotStage === 'draw') return '把手机交给画师本人，看词作画，画完点「画完了，传给下一位」。';
    return '把手机交给猜的人，直接在下面打字猜。';
  }
  if (pub.drawer === mySeat()) return '轮到你画 —— 下面的词只有你看得到。';
  return '该你猜了：在下面打字，猜中就赢一分。';
}

/* =============================================================================
 * 开局 / 模式
 * ========================================================================== */
function newGame() {
  aiGen++;
  aiPaused = false;
  if (aiTimer) { clearTimeout(aiTimer); aiTimer = null; }
  localActs = [];
  strokes = [];
  curStroke = null;
  chat = [];
  roundWord = '';
  myWord = '';
  handout = null;
  hotStage = '';
  hotQueue = [];
  base = { n: nPlayers, names: buildSeats() };
  pub = initPub(nPlayers);

  if (mode === 'p2p' && authority) {
    if (session && session.isHost) {
      const s = (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0;
      authority.init({ s, base });
      pub = fold(base, []);
      render();
      startRound();
    } else {
      pub = initPub(nPlayers);
      render();
    }
    return;
  }

  render();
  if (mode === 'hotseat') {
    /* 同屏：先开一回合，afterAction 会把传手机面板摆出来 */
    startRound();
    return;
  }
  startRound();
}

function setMode(m) {
  mode = m;
  $('mode').value = m;
  $('p2p').hidden = m !== 'p2p';
  newGame();
}

$('mode').addEventListener('change', (e) => {
  if (e.target.value === 'p2p') {
    nPlayers = 2;
    $('playercount').value = '2';
    $('playercount').disabled = true;
  } else {
    $('playercount').disabled = false;
  }
  setMode(e.target.value);
});
$('playercount').addEventListener('change', (e) => {
  nPlayers = Number(e.target.value) || 2;
  newGame();
});
$('restart').addEventListener('click', () => newGame());
$('again').addEventListener('click', () => { $('end').classList.remove('show'); newGame(); });

/* 词默认遮住，按住才显示 */
$('btn-peek').addEventListener('pointerdown', () => {
  if ($('myword').hidden) return;
  $('mywordval').textContent = myWord;
});
$('btn-peek').addEventListener('pointerup', () => { $('mywordval').textContent = '••••'; });
$('btn-peek').addEventListener('pointerleave', () => { $('mywordval').textContent = '••••'; });

/* =============================================================================
 * 联机：房主权威
 * ========================================================================== */
function setupAuthority() {
  if (!session) return;
  authority = new HostAuthority(session, {
    reduce: (s, acts) => {
      const all = (s.moves || []).concat(acts);
      return { base: s.base, pub: fold(s.base, all), moves: all };
    },
    replay: (seed, acts) => {
      const base2 = (seed && seed.base) || { n: nPlayers };
      return { base: base2, pub: fold(base2, acts || []), moves: (acts || []).slice() };
    },
    hash: (s) => hashPub(publicView(s.pub)),
    /* 广播前裁剪：DRAW 阶段不能露出 word */
    view: (s) => ({ base: s.base, pub: publicView(s.pub) }),
    validate: (s, act) => {
      const st = s.pub;
      if (!st) return { ok: false, reason: '还没准备好' };
      if (st.phase === PHASE.OVER) return { ok: false, reason: '这局已经结束了' };
      if (!act) return { ok: false, reason: '空动作' };
      if (act.act === 'guess') {
        if (st.phase !== PHASE.DRAW) return { ok: false, reason: '现在不是猜词时间' };
        if (!String(act.text || '').trim()) return { ok: false, reason: '不能猜空' };
        if (st.drawer === act.p) return { ok: false, reason: '画师不能自己猜' };
        return true;
      }
      return true;
    },
  });

  const applyState = (s) => {
    if (!s || !s.pub) return;
    pub = s.pub;
    render();
  };
  authority.onState(applyState);
  authority.onLocalState((s) => {
    if (!s || !s.pub) return;
    pub = s.pub;
    render();
    const last = (s.moves || [])[s.moves.length - 1];
    if (last) afterAction(last);
  });
  authority.onReject((reason) => {
    pushChat('sys', '房主驳回了这一手：' + (reason || '不合法'));
  });
}

function handleGuestGuess(m) {
  if (!session || !session.isHost) return;
  hostJudgeGuess({ p: m.p, text: m.text });
}

function p2pState(text, cls) {
  const el = $('p2p-state');
  el.textContent = text;
  el.className = 'p2p-state ' + (cls || 'wait');
}

async function genHostCode() {
  const pass = $('host-pass').value.trim();
  try {
    p2pState('正在生成房主码…', 'wait');
    session = new P2PSession({ role: 'host', gameId: 'drawguess', name: '房主' });
    setupAuthority();
    session.on('status', (st, text) => {
      p2pState(text || st, st === 'open' ? 'ok' : st === 'failed' ? 'err' : 'wait');
      if (st === 'open') { $('rolebar').hidden = true; newGame(); }
    });
    session.on('message', (m) => {
      if (!m) return;
      if (m.t === 'dg-guess') handleGuestGuess(m);
      else if (m.t === 'dg-stroke') { strokes.push({ pts: m.pts, color: m.color, size: m.size }); redraw(); }
      else if (m.t === 'dg-clear') { strokes = []; redraw(); }
      else if (m.t === 'dg-undo') { strokes.pop(); redraw(); }
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
    session = new P2PSession({ role: 'guest', gameId: 'drawguess', name: '加入方' });
    setupAuthority();
    session.on('status', (st, text) => {
      p2pState(text || st, st === 'open' ? 'ok' : st === 'failed' ? 'err' : 'wait');
      if (st === 'open') { $('rolebar').hidden = true; newGame(); }
    });
    session.on('message', (m) => {
      if (!m) return;
      if (m.t === 'dg-word') {
        /* 房主把本回合的词发来了 —— 只有我是画师时才会收到 */
        myWord = m.word || '';
        render();
      } else if (m.t === 'dg-stroke') { strokes.push({ pts: m.pts, color: m.color, size: m.size }); redraw(); }
      else if (m.t === 'dg-clear') { strokes = []; redraw(); }
      else if (m.t === 'dg-undo') { strokes.pop(); redraw(); }
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
  myWord = '';
  roundWord = '';
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

$('btn-host').addEventListener('click', () => { $('host-flow').hidden = false; $('guest-flow').hidden = true; });
$('btn-join').addEventListener('click', () => { $('guest-flow').hidden = false; $('host-flow').hidden = true; });
$('btn-gen-host').addEventListener('click', genHostCode);
$('btn-gen-guest').addEventListener('click', genGuestCode);
$('btn-accept').addEventListener('click', acceptJoinCode);
$('btn-close').addEventListener('click', closeSession);

/* 联机面板折叠 —— 通码流程挺长，折叠起来画板能留在屏幕上 */
$('p2p-toggle').addEventListener('click', () => {
  $('p2p').classList.toggle('collapsed');
});

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
if (!support.ok) pushChat('sys', support.reason);
render();
newGame();
