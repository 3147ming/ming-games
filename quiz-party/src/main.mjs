/* =============================================================================
 * quiz-party/src/main.mjs —— 快问快答派对主控
 * -----------------------------------------------------------------------------
 * 两种模式：
 *   solo   单人练习（本地出题、本地判分；「每日一局」当天全网同题）
 *   p2p    纯 P2P 联机（零服务器，手动交换两段连接码，两名玩家同题同时作答）
 *
 * ---------------------------------------------------------------------------
 * 这个游戏接纯 P2P 的核心难点：**正确答案属于私密信息。**
 *
 * 吹牛骰子靠 commit-reveal（先承诺后揭示）解决；
 * 这边用的是同一思路的另一种形态 —— **答案根本不上线**：
 *
 *   · 网络上传输的动作只有四种：pick / timeout / close / next，
 *     pick 里只有「谁按了第几个按钮、当时剩多少毫秒」。
 *   · 正确项是**纯函数推导**出来的：
 *       正确项 = 题库原始答案下标 → 本局选项置换表 → 按钮下标
 *     置换表由公开种子推导，双方各算各的必然一致，房主改不动。
 *   · 得分也是纯函数推导（gradeAll 只吃动作序列），房主下发不了分数。
 *   · publicView 把分数、正确项、解释统统裁掉 ——
 *     「某人这轮得了几分」本身就等于告诉对手他答对了。
 *   · 结算环节房主额外揭示答案 + 承诺哈希，加入方核对；答不上就报警。
 *
 * 详见 src/rules.mjs 开头那段说明。
 *
 * 联机状态同步用「房主权威」模型（见 src/net/p2p.js 的 HostAuthority）：
 *   · 玩家只上报「我按了第几项」（input）
 *   · 房主判定合法性、推进棋局、广播权威状态（state）
 *   · 双方用同一份规则引擎重放，状态一致
 *   · 定期比对摘要（hash），不一致由房主下发快照（sync）纠偏
 *
 * 纪律：顶层不碰 DOM 查询（放文件末尾启动段）；localStorage 全程 try/catch。
 * ========================================================================== */

import {
  GAME_ID, LIMIT_MS, CATEGORY_LIST, CATEGORY_LABEL,
  initState, applyAction, fold, hashState, publicView,
  gradeAll, questionView, correctIndex, rating, verdict,
  dailySeed, seedFromRoom, randomSeed, dateKeyOf, questionCounts,
  commitTable, revealOf, answerCommit, roundComplete, hasPicked, hasTimedOut,
} from './rules.mjs';
import { P2PSession, HostAuthority, checkSupport } from '../../src/net/p2p.js';

const $ = (id) => document.getElementById(id);

/* ---- 全局状态 ---- */
let mode = 'solo';                 /* solo | p2p */
let st = initState(randomSeed(), { cat: 'all', total: 10, players: 1, mode: 'solo' });
let base = { seed: st.seed, cat: 'all', total: 10, players: 1, mode: 'solo', daily: false };
let localActs = [];
let session = null;
let authority = null;
let mySeat = 0;                    /* p2p：0 = 房主，1 = 加入方 */
let peerSeat = 1;
let dailyToday = false;
let catSel = 'all';
let totalSel = 10;
/* 联机时是否使用每日题库（种子由日期派生，全网同题） */
let dailyP2P = false;

/* 本轮的本地计时起点（本地时钟，用来算剩余毫秒） */
let roundStartAt = 0;
let roundKey = '';

/* 计时器 */
let rafId = 0;

/* 加入方：我提交过的动作（核对房主有没有偷改/截断） */
let mySubmitted = [];

/* 房主承诺表 / 结算揭示 */
let hostCommits = [];
let hostReveals = {};

/* 检测到房主作弊时的告警（一旦有就不许被普通提示覆盖） */
let cheatWarn = '';

/* P2P：加入方是否已经收到房主的开局状态。
   没收到之前不能作答 —— 否则会用单机的题目顺序算「正确项」，跟联机局对不上。 */
let p2pReady = false;
let p2pBaseSeed = 0;

/* 调试钩子（端到端测试用） */
globalThis.__QUIZPARTY__ = {
  get session() { return session; },
  get authority() { return authority; },
  get mode() { return mode; },
  get pub() { return st; },
  get seed() { return st.seed; },
  get round() { return st.round; },
  get phase() { return st.phase; },
  get over() { return st.phase === 'done'; },
  get actionCount() { return authority ? authority.actions.length : localActs.length; },
  get moves() {
    if (authority && authority.state && authority.state.moves) return authority.state.moves.slice();
    return localActs.slice();
  },
  get picks() { return st.picks.map((x) => ({ r: x.r, p: x.x !== undefined ? x.x : x.p, c: x.c, ms: x.ms })); },
  get mySeat() { return mySeat; },
  get commits() { return hostCommits.slice(); },
  get reveals() { return JSON.parse(JSON.stringify(hostReveals)); },
  get grade() { return gradeAll(st); },
  get view() { return publicView(st); },
  correctOf: (r) => correctIndex(st, r == null ? st.round : r),
  question: (r) => questionView(st, r == null ? st.round : r),
  act: (act) => submitAction(act),
  submit: (c, ms) => submitAction({ act: 'pick', r: st.round, p: mySeat, c, ms: ms == null ? remainingMs() : ms }),
  timeout: () => submitAction({ act: 'timeout', r: st.round, p: mySeat }),
  close: () => submitAction({ act: 'close', r: st.round }),
  next: () => submitAction({ act: 'next', r: st.round }),
  remaining: () => remainingMs(),
  reset: (seed, cat, total, players, m) => startGame(seed, cat, total, players, m, false),
};

/* ============================================================================
 * 计时
 * ========================================================================== */
function remainingMs() {
  if (!roundStartAt) return LIMIT_MS;
  const left = LIMIT_MS - (performance.now() - roundStartAt);
  return Math.max(0, Math.min(LIMIT_MS, Math.round(left)));
}

function startTimer() {
  stopTimer();
  roundStartAt = performance.now();
  const loop = () => {
    const left = remainingMs();
    const fill = $('timer-fill');
    if (fill) fill.style.transform = 'scaleX(' + (left / LIMIT_MS).toFixed(4) + ')';
    const txt = $('timer-text');
    if (txt) txt.textContent = (left / 1000).toFixed(1) + ' 秒';
    if (left <= 0) { stopTimer(); onTimeout(); return; }
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
}

function stopTimer() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
}

/** 每进入一个新题目就重开计时器（联机时双方各自本地计时）。 */
function ensureRoundTimer() {
  if (st.phase !== 'question') { stopTimer(); return; }
  const key = 'r' + st.round;
  if (roundKey !== key) {
    roundKey = key;
    startTimer();
  }
}

/* ============================================================================
 * 动作提交
 * ========================================================================== */
function submitAction(act) {
  if (!act) return false;
  if (mode === 'p2p' && authority && session) {
    if (session.isHost) {
      const before = authority.actions.length;
      authority.applyLocal(act);
      return authority.actions.length !== before;
    }
    /* 加入方：还没收到房主的开局状态之前不能作答
       （否则会用本机的题序算「正确项」，跟联机局对不上）。 */
    if (!p2pReady) {
      setMsg('还在等房主开局…', 'dim');
      return false;
    }
    /* 加入方：上报给房主裁决 */
    mySubmitted = mySubmitted.concat([act]);
    authority.input(act);
    stopTimer();
    setMsg('已上报，等房主结算…', 'dim');
    render();
    return true;
  }
  const before = hashState(st);
  const next = applyAction(st, act);
  if (hashState(next) === before) return false;
  localActs = localActs.concat([act]);
  st = next;
  afterAction(act);
  render();
  return true;
}

/** 动作落地后的副作用（结算、推进）。 */
function afterAction(act) {
  if (!act) return;
  if (act.act === 'pick' || act.act === 'timeout') {
    stopTimer();
    /* 单人局：答完立刻结算 */
    if (mode !== 'p2p' && roundComplete(st, st.round)) {
      localActs = localActs.concat([{ act: 'close', r: st.round }]);
      st = fold(base, localActs);
    }
    render();
    return;
  }
  if (act.act === 'close') {
    stopTimer();
    render();
    return;
  }
  if (act.act === 'next') {
    render();
    return;
  }
}

function onTimeout() {
  if (st.phase !== 'question') return;
  const act = { act: 'timeout', r: st.round, p: mySeat };
  if (mode === 'p2p' && authority && session) {
    if (session.isHost) {
      authority.applyLocal(act);
      /* 房主还要把没答的对面也标超时，否则这一轮永远结算不了 */
      setTimeout(() => {
        if (!authority || !session || !session.isHost) return;
        if (st.phase === 'question' && !hasPicked(st, st.round, peerSeat)
            && !hasTimedOut(st, st.round, peerSeat)) {
          authority.applyLocal({ act: 'timeout', r: st.round, p: peerSeat });
        }
      }, 1500);
    } else {
      mySubmitted = mySubmitted.concat([act]);
      authority.input(act);
      stopTimer();
      render();
    }
    return;
  }
  submitAction(act);
}

/* ============================================================================
 * 开局
 * ========================================================================== */
function startGame(seed, cat, total, players, m, daily) {
  dailyToday = !!daily;
  base = {
    seed: seed >>> 0, cat, total, players, mode: m, daily: !!daily,
  };
  localActs = [];
  mySubmitted = [];
  hostReveals = {};
  hostCommits = [];
  cheatWarn = '';
  st = initState(base.seed, base);
  roundKey = '';
  if (mode === 'p2p' && authority && session && session.isHost) {
    hostCommits = commitTable(st);
    authority.init({ s: base.seed, base });
    st = fold(base, []);
  }
  render();
  setMsg(daily ? '每日一局：今天的题，全网同题同序' : (m === 'p2p' ? '联机局：两人同题同时作答' : '准备好了就开始吧'));
}

function newSoloGame(daily) {
  mode = 'solo';
  const cat = catSel;
  const total = totalSel;
  const seed = daily ? dailySeed(dateKeyOf(new Date()), cat) : randomSeed();
  startGame(seed, cat, total, 1, 'solo', daily);
}

/* ============================================================================
 * 渲染
 * ========================================================================== */
function render() {
  ensureRoundTimer();
  const g = gradeAll(st);
  const mine = g.players[mySeat] || g.players[0];
  const save = loadSave();

  $('stat-score').textContent = String(mine.score);
  $('stat-streak').textContent = String(mine.streak);
  $('stat-best').textContent = String(save.best || 0);
  $('stat-today').textContent = (save.today && save.today.date === dateKeyOf(new Date()))
    ? String(save.today.score) : '-';

  const over = st.phase === 'done';
  const reviewing = st.phase === 'review';

  $('stage').hidden = over;
  $('review').hidden = !reviewing;
  $('end').hidden = !over;

  if (!over) renderQuestion();
  if (reviewing) renderReview(g);
  if (over) renderEnd(g);

  renderSeats(g);
  renderFoot();
}

function renderQuestion() {
  const qv = questionView(st, st.round);
  if (!qv) return;
  $('q-cat').textContent = qv.catLabel + (dailyToday ? ' · 每日' : '');
  $('q-index').textContent = '第 ' + (st.round + 1) + ' / ' + st.total + ' 题';
  $('q-text').textContent = qv.text;

  const box = $('opts');
  box.innerHTML = '';
  const locked = st.phase !== 'question';
  qv.options.forEach((o, i) => {
    const b = document.createElement('button');
    b.className = 'opt' + (locked ? ' locked' : '');
    b.type = 'button';
    b.setAttribute('data-opt', String(i));
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = 'ABCD'[i];
    const t = document.createElement('span');
    t.textContent = o.text;
    b.appendChild(k);
    b.appendChild(t);
    b.addEventListener('click', () => onPick(i));
    box.appendChild(b);
  });
  $('timer-hint').textContent = st.phase === 'question' ? '快点！' : '';
}

function onPick(i) {
  if (st.phase !== 'question') return;
  if (hasPicked(st, st.round, mySeat)) return;
  submitAction({ act: 'pick', r: st.round, p: mySeat, c: i, ms: remainingMs() });
}

function renderReview(g) {
  const r = g.rounds[st.round];
  if (!r) return;
  const mine = r.picks.find((x) => x.p === mySeat);
  const pt = r.points.find((x) => x.p === mySeat);
  const qv = questionView(st, st.round);
  const ci = r.correctIndex;

  /* 结算阶段揭示：把正确项标出来 */
  const box = $('opts');
  if (box.children.length === qv.options.length) {
    for (let i = 0; i < box.children.length; i++) {
      const b = box.children[i];
      b.classList.add('locked');
      if (i === ci) b.classList.add('right');
      else if (mine && i === mine.c) b.classList.add('wrong');
    }
  }

  const v = $('rv-verdict');
  if (!mine) {
    v.textContent = '超时了，没答上';
    v.className = 'verdict bad';
  } else if (mine.correct) {
    v.textContent = '答对了！';
    v.className = 'verdict ok';
  } else {
    v.textContent = '答错了';
    v.className = 'verdict bad';
  }
  $('rv-answer').innerHTML = '正确答案：<b>' + 'ABCD'[ci] + '. '
    + escapeHtml(qv.options[ci] ? qv.options[ci].text : '') + '</b>';
  $('rv-points').textContent = pt && pt.total
    ? '本轮得分 +' + pt.total + '（基础 ' + pt.base + ' + 速度 ' + pt.speed
      + ' + 连对 ' + pt.streak + (pt.first ? ' + 抢先 ' + pt.first : '') + '）'
    : '本轮 0 分';
  $('rv-exp').textContent = r.explanation || '';

  /* 联机结算：核对房主揭示的答案与承诺 */
  const rv = hostReveals[st.round];
  if (rv) {
    if (rv.correctIndex !== ci) {
      warnCheat('房主揭示的答案跟本机算的不一致 —— 他在作弊');
    } else if (rv.commit && rv.commit !== answerCommit(st, st.round)) {
      warnCheat('房主的答案承诺对不上 —— 他在作弊');
    }
  }
  if (mode === 'p2p' && r.firstCorrectP >= 0) {
    const who = r.firstCorrectP === mySeat ? '你' : '对方';
    setMsg(who + '先答对，抢先分 +30', who === '你' ? 'ok' : 'dim');
  }
}

function renderSeats(g) {
  const bar = $('seats');
  bar.innerHTML = '';
  if (st.players < 2) return;
  for (let p = 0; p < st.players; p++) {
    const pl = g.players[p];
    const d = document.createElement('div');
    d.className = 'seat' + (p === mySeat ? ' me' : '');
    const nm = p === mySeat ? '你' : '对方';
    d.innerHTML = '<div class="nm">' + nm + '</div><div class="sc">' + pl.score + '</div>'
      + '<div class="st">连对 ' + pl.streak + ' · 答对 ' + pl.correct + '</div>';
    bar.appendChild(d);
  }
}

function renderEnd(g) {
  const mine = g.players[mySeat] || g.players[0];
  const acc = mine.attempts > 0 ? Math.round(mine.correct / mine.attempts * 100) : 0;
  $('end-score').textContent = String(mine.score);
  $('end-acc').textContent = acc + '%';
  $('end-streak').textContent = String(mine.bestStreak);
  $('end-right').textContent = mine.correct + ' / ' + mine.attempts;
  const rt = rating(mine.score);
  $('end-rate').textContent = rt.label;
  $('end-ratetext').textContent = rt.text;

  if (mode === 'p2p') {
    const v = verdict(st);
    if (v.kind === 'p0' || v.kind === 'p1') {
      const winSeat = v.kind === 'p0' ? 0 : 1;
      setMsg(winSeat === mySeat ? '你赢了！' : '这局输了，再来一局', winSeat === mySeat ? 'ok' : 'bad');
    } else {
      setMsg('打平了', 'dim');
    }
  }
  saveResult(mine);
}

function renderFoot() {
  const f = $('foot-hint');
  if (st.phase === 'done') { f.textContent = '本局结束 —— 点「再来一局」再来一次'; return; }
  if (st.phase === 'review') {
    f.textContent = mode === 'p2p' ? '等房主推进下一题…' : '看完解释，点「下一题」继续';
    return;
  }
  f.textContent = '点选项就作答 · 每题 ' + (LIMIT_MS / 1000) + ' 秒';
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ============================================================================
 * 存档（最高分 / 最长连对 / 每日成绩）
 * ========================================================================== */
const SAVE_KEY = 'mg_quizparty.v1';

function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return { best: 0, bestStreak: 0, today: null };
    const o = JSON.parse(raw);
    return {
      best: o.best || 0,
      bestStreak: o.bestStreak || 0,
      today: o.today || null,
    };
  } catch (e) {
    return { best: 0, bestStreak: 0, today: null };
  }
}

function saveResult(summary) {
  try {
    const s = loadSave();
    const dk = dateKeyOf(new Date());
    s.best = Math.max(s.best || 0, summary.score || 0);
    s.bestStreak = Math.max(s.bestStreak || 0, summary.bestStreak || 0);
    if (!s.today || s.today.date !== dk) {
      s.today = { date: dk, score: summary.score || 0, streak: summary.bestStreak || 0, right: summary.correct || 0 };
    } else {
      s.today.score = Math.max(s.today.score || 0, summary.score || 0);
      s.today.streak = Math.max(s.today.streak || 0, summary.bestStreak || 0);
      s.today.right = Math.max(s.today.right || 0, summary.correct || 0);
    }
    localStorage.setItem(SAVE_KEY, JSON.stringify(s));
  } catch (e) { /* file:// 下可能抛，忽略 */ }
}

/* ============================================================================
 * 消息
 * ========================================================================== */
function setMsg(text, cls) {
  const el = $('msg');
  if (!el) return;
  /* 一旦发现房主作弊，告警不被任何普通提示覆盖 */
  if (cheatWarn && cls !== 'bad') return;
  el.textContent = text;
  el.className = 'msg' + (cls ? ' ' + cls : '');
}

/** 报出「房主在作弊」的告警（粘住，直到重开一局）。 */
function warnCheat(text) {
  cheatWarn = text;
  setMsg(text, 'bad');
}

/* ============================================================================
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
      const base2 = (seed && seed.base) || base;
      return { base: base2, pub: fold(base2, acts || []), moves: (acts || []).slice() };
    },
    hash: (s) => hashState(s.pub),
    view: (s) => ({
      base: s.base,
      pub: publicView(s.pub),
      moves: (s.moves || []).slice(),
      reveals: hostReveals,
      commits: hostCommits,
    }),
    validate: (s, act) => {
      const cur = s.pub;
      if (!cur) return { ok: false, reason: '还没准备好' };
      if (!act || typeof act.act !== 'string') return { ok: false, reason: '非法动作' };
      if (cur.phase === 'done') return { ok: false, reason: '这局已经结束了' };

      if (act.act === 'pick') {
        if (cur.phase !== 'question') return { ok: false, reason: '现在不是答题阶段' };
        if (act.r !== cur.round) return { ok: false, reason: '题号对不上' };
        if (!Number.isInteger(act.p) || act.p < 0 || act.p >= cur.players) return { ok: false, reason: '玩家序号不合法' };
        if (!Number.isInteger(act.c) || act.c < 0 || act.c > 3) return { ok: false, reason: '选项不合法' };
        if (!Number.isFinite(act.ms) || act.ms < 0 || act.ms > cur.limitMs) return { ok: false, reason: '用时不合法' };
        if (hasPicked(cur, cur.round, act.p)) return { ok: false, reason: '这一题已经答过了' };
        /* 房主不能给对方乱填剩余时间：用房主自己测到的本题剩余时间兜底 */
        if (act.p === peerSeat) {
          const allowed = Math.max(0, LIMIT_MS - (performance.now() - roundStartAt));
          if (act.ms > allowed + 5000) {
            return { ok: false, reason: '剩余时间对不上（不能虚报）' };
          }
        }
        return true;
      }
      if (act.act === 'timeout') {
        if (cur.phase !== 'question') return { ok: false, reason: '现在不是答题阶段' };
        if (act.r !== cur.round) return { ok: false, reason: '题号对不上' };
        if (!Number.isInteger(act.p) || act.p < 0 || act.p >= cur.players) return { ok: false, reason: '玩家序号不合法' };
        if (hasPicked(cur, cur.round, act.p)) return { ok: false, reason: '这一题已经答过了' };
        return true;
      }
      if (act.act === 'close') {
        if (cur.phase !== 'question') return { ok: false, reason: '这一题已经结算过了' };
        if (act.r !== cur.round) return { ok: false, reason: '题号对不上' };
        if (!roundComplete(cur, cur.round)) return { ok: false, reason: '还有人没作答' };
        return true;
      }
      if (act.act === 'next') {
        if (cur.phase !== 'review') return { ok: false, reason: '这一题还没结算' };
        if (act.r !== cur.round) return { ok: false, reason: '题号对不上' };
        return true;
      }
      return { ok: false, reason: '未知动作' };
    },
  });

  /**
   * 加入方收到权威状态。
   *
   * 关键：**不采信房主广播的局面，自己重放一遍。**
   * 全部信息都是公开可推导的（种子 + 动作序列），
   * 所以加入方完全有能力自己算出「这一局应该是什么样」。
   * 房主广播的局面跟自己对不上 —— 那就是房主在撒谎。
   */
  const applyState = (s) => {
    if (!s) return;
    const moves = s.moves || [];

    /* 联机局的种子双方都能自己算出来（从房间号派生；每日局从日期派生）——
       房主要是换种子，一眼就能看出来。 */
    let expectSeed = null;
    if (mode === 'p2p' && session) {
      if (s.base && s.base.daily) {
        const dk = dateKeyOf(new Date());
        expectSeed = dailySeed(dk, s.base.cat);
        /* 跨零点了也认（昨天开的局） */
        const y = new Date(); y.setDate(y.getDate() - 1);
        const alt = dailySeed(dateKeyOf(y), s.base.cat);
        if (s.base.seed !== expectSeed && s.base.seed !== alt) {
          warnCheat('房主换了对局的种子 —— 他可能在作弊');
          return;
        }
      } else if (session.roomId) {
        expectSeed = seedFromRoom(session.roomId);
      }
    }
    if (expectSeed != null && s.base && s.base.seed !== expectSeed) {
      warnCheat('房主换了对局的种子 —— 他可能在作弊');
      return;
    }

    /* 房主不能截断我的动作 —— 我提交过的每一步都必须原封不动地出现。
       注意：房主的状态广播可能**先于**房主处理我的输入到达，
       所以「暂时没看到」不等于「被改了」。
       只有当房主已经推进到那一轮之后（说明它早就该收到我的输入了）才算作弊。 */
    if (mySubmitted.length) {
      let idx = -1;
      for (const mine0 of mySubmitted) {
        const at = moves.findIndex((m, k) => k > idx && sameAction(m, mine0));
        if (at < 0) {
          /* 房主是不是已经越过这一轮了？越过了还不出现 = 真的被吞了 */
          const passed = moves.some((m) => m && (m.act === 'close' || m.act === 'next')
            && m.r >= mine0.r);
          if (passed) {
            warnCheat('房主改了我提交过的那一步 —— 他在作弊');
            return;
          }
          break;   /* 可能还在路上，下一次广播再看 */
        }
        idx = at;
      }
    }

    /* 自己重放 */
    const b = s.base || base;
    const mine2 = fold(b, moves);

    /* 房主广播的局面跟自己对不上 → 报出来（但仍然用自己算的） */
    if (s.pub && hashState(s.pub) !== hashState(mine2)) {
      warnCheat('房主发的局面跟你自己算的对不上 —— 他可能在作弊');
    }

    /* 揭示与承诺 —— 用自己重放出来的局面核对 */
    if (s.reveals) {
      hostReveals = s.reveals;
      for (const key of Object.keys(hostReveals)) {
        const rv = hostReveals[key];
        const mine = revealOf(mine2, Number(key));
        if (!mine) continue;
        if (rv.correctIndex !== mine.correctIndex) {
          warnCheat('房主揭示的答案跟本机算的不一致 —— 他在作弊');
        } else if (rv.commit && rv.commit !== mine.commit) {
          warnCheat('房主的答案承诺对不上 —— 他在作弊');
        }
      }
    }
    if (s.commits && s.commits.length) {
      for (let r = 0; r < s.commits.length; r++) {
        const mine = answerCommit(mine2, r);
        if (mine && s.commits[r] !== mine) {
          warnCheat('房主的题目顺序承诺对不上 —— 他串题了');
        }
      }
    }

    st = mine2;
    /* 收到房主的开局状态，加入方才可以作答 */
    if (!session.isHost && s.base && s.base.players === 2) {
      if (p2pBaseSeed !== s.base.seed) {
        /* 房主重开了一局 —— 采纳他的分类/题数，清掉上一局的提交记录 */
        base = {
          seed: s.base.seed, cat: s.base.cat, total: s.base.total,
          players: 2, mode: 'p2p', daily: !!s.base.daily,
        };
        mySubmitted = [];
        hostReveals = {};
        cheatWarn = '';
        p2pBaseSeed = s.base.seed;
      }
      p2pReady = true;
    }
    afterStateChange();
    render();
  };
  authority.onState(applyState);
  authority.onLocalState((s) => {
    if (!s || !s.pub) return;
    st = s.pub;
    afterStateChange();
    render();
  });
  authority.onReject((reason) => {
    setMsg('房主驳回了这一手：' + (reason || '不合法'), 'bad');
  });
}

/**
 * 房主这边：对方作答后，如果本轮可以结算就结算 → 揭示答案 → 推进下一题。
 *
 * 注意揭示是在 close **之前**写进 hostReveals 的 ——
 * 这样随 close 一起广播出去，加入方就能立刻核对答案与承诺。
 */
function afterStateChange() {
  if (mode !== 'p2p' || !session || !session.isHost || !authority) return;
  if (st.phase !== 'question') return;
  if (!roundComplete(st, st.round)) return;
  const r = st.round;
  const rv = revealOf(st, r);
  if (rv) hostReveals[r] = rv;
  hostCommits = commitTable(st);
  /* 延后一拍执行，避免在 authority 的回调里重入 */
  setTimeout(() => {
    if (!authority || st.phase !== 'question' || st.round !== r) return;
    authority.applyLocal({ act: 'close', r: r });
    /* 停一会儿再推进下一题，让双方看清结算 */
    setTimeout(() => {
      if (!authority || st.phase !== 'review' || st.round !== r) return;
      authority.applyLocal({ act: 'next', r: r });
    }, 2800);
  }, 60);
}

/** 两个动作是否「同一手」（用于核对房主有没有改我的动作）。 */
function sameAction(a, b) {
  if (!a || !b || a.act !== b.act) return false;
  if (a.act === 'pick') {
    return a.r === b.r && a.p === b.p && a.c === b.c && a.ms === b.ms;
  }
  if (a.act === 'timeout') return a.r === b.r && a.p === b.p;
  return a.r === b.r;
}

function p2pState(text, cls) {
  const el = $('p2p-state');
  if (!el) return;
  el.textContent = text;
  el.className = 'p2p-state ' + (cls || 'wait');
}

async function genHostCode() {
  const pass = $('host-pass') ? $('host-pass').value.trim() : '';
  try {
    p2pState('正在生成房主码…', 'wait');
    session = new P2PSession({ role: 'host', gameId: GAME_ID, name: '房主' });
    setupAuthority();
    session.on('status', (stt, text) => {
      p2pState(text || stt, stt === 'open' ? 'ok' : stt === 'failed' ? 'err' : 'wait');
      if (stt === 'open') {
        mySeat = 0;
        peerSeat = 1;
        startP2PGame();
      }
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
    session = new P2PSession({ role: 'guest', gameId: GAME_ID, name: '加入方' });
    setupAuthority();
    session.on('status', (stt, text) => {
      p2pState(text || stt, stt === 'open' ? 'ok' : stt === 'failed' ? 'err' : 'wait');
      if (stt === 'open') {
        mySeat = 1;
        peerSeat = 0;
        /* 先按房间号把种子对上，题目分类/题数等房主的开局广播为准 */
        const seed = session.roomId ? seedFromRoom(session.roomId) : randomSeed();
        mode = 'p2p';
        base = { seed, cat: catSel, total: totalSel, players: 2, mode: 'p2p', daily: false };
        localActs = [];
        mySubmitted = [];
        hostReveals = {};
        hostCommits = [];
        cheatWarn = '';
        p2pReady = false;
        st = initState(seed, base);
        roundKey = '';
        render();
        setMsg('已连上，等房主开局…', 'dim');
      }    });
    const code = await session.createGuestCode(hostCode, pass);
    $('guest-code').value = code;
    $('guest-flow').hidden = false;
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

/** 联机局开局：种子从房间号派生（双方必然一致）；每日局从日期派生。 */
function startP2PGame() {
  const daily = !!dailyP2P;
  const cat = catSel;
  const total = totalSel;
  const seed = daily
    ? dailySeed(dateKeyOf(new Date()), cat)
    : (session && session.roomId ? seedFromRoom(session.roomId) : randomSeed());
  mode = 'p2p';
  base = { seed, cat, total, players: 2, mode: 'p2p', daily };
  localActs = [];
  mySubmitted = [];
  hostReveals = {};
  hostCommits = [];
  cheatWarn = '';
  st = initState(seed, base);
  roundKey = '';
  if (authority) {
    if (session.isHost) {
      hostCommits = commitTable(st);
      authority.init({ s: seed, base });
    }
    st = fold(base, (authority.actions || []));
  }
  render();
}

function closeSession() {
  if (session) session.close();
  session = null;
  authority = null;
  $('host-flow').hidden = true;
  $('guest-flow').hidden = true;
  $('host-code').value = '';
  $('guest-code').value = '';
  $('host-in').value = '';
  $('join-in').value = '';
  $('btn-close').hidden = true;
  p2pState('未连接', 'wait');
  mode = 'solo';
  newSoloGame(false);
}

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

/* ============================================================================
 * 启动（所有 DOM 查询都放在这里，模块顶层不碰 DOM）
 * ========================================================================== */
function boot() {
  /* 分类下拉 */
  const sel = $('cat');
  sel.innerHTML = '';
  const allOpt = document.createElement('option');
  allOpt.value = 'all';
  allOpt.textContent = '全部（' + questionCounts().all + ' 题）';
  sel.appendChild(allOpt);
  for (const c of CATEGORY_LIST) {
    const o = document.createElement('option');
    o.value = c;
    o.textContent = CATEGORY_LABEL[c] + '（' + questionCounts()[c] + ' 题）';
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => { catSel = sel.value; });
  $('count').addEventListener('change', () => { totalSel = parseInt($('count').value, 10) || 10; });
  $('daily-p2p').addEventListener('change', (e) => { dailyP2P = !!e.target.checked; });

  $('btn-start').addEventListener('click', () => newSoloGame(false));
  $('btn-daily').addEventListener('click', () => newSoloGame(true));
  $('btn-next').addEventListener('click', () => submitAction({ act: 'next', r: st.round }));
  $('btn-again').addEventListener('click', () => {
    if (mode === 'p2p' && session && session.isHost) startP2PGame();
    else newSoloGame(dailyToday);
  });
  $('btn-info').addEventListener('click', () => { $('info').hidden = false; });
  $('info-close').addEventListener('click', () => { $('info').hidden = true; });

  $('mode-solo').addEventListener('click', () => {
    mode = 'solo';
    $('mode-solo').classList.add('on');
    $('mode-p2p').classList.remove('on');
    $('p2p').hidden = true;
    $('setup').hidden = false;
    $('btn-start').hidden = false;
    $('btn-daily').hidden = false;
    newSoloGame(false);
  });
  $('mode-p2p').addEventListener('click', () => {
    mode = 'p2p';
    $('mode-p2p').classList.add('on');
    $('mode-solo').classList.remove('on');
    $('p2p').hidden = false;
    /* 联机局也保留分类/题数选择（以房主的为准） */
    $('setup').hidden = false;
    $('btn-start').hidden = true;
    $('btn-daily').hidden = true;
    setMsg('选一个：建房还是加入', 'dim');
  });

  $('btn-host').addEventListener('click', () => { $('host-flow').hidden = false; $('guest-flow').hidden = true; });
  $('btn-join').addEventListener('click', () => { $('guest-flow').hidden = false; $('host-flow').hidden = true; });
  $('btn-gen-host').addEventListener('click', genHostCode);
  $('btn-gen-guest').addEventListener('click', genGuestCode);
  $('btn-accept').addEventListener('click', acceptJoinCode);
  $('btn-close').addEventListener('click', closeSession);
  $('btn-copy-host').addEventListener('click', () => copyTo($('host-code'), $('btn-copy-host')));
  $('btn-copy-guest').addEventListener('click', () => copyTo($('guest-code'), $('btn-copy-guest')));

  const support = checkSupport();
  if (!support.ok) setMsg(support.reason, 'bad');

  newSoloGame(false);
}

boot();
