/* =============================================================================
 * liar/src/main.mjs —— 骗子酒馆（吹牛骰子）主控
 * -----------------------------------------------------------------------------
 * 两种模式：
 *   ai    人机对局（你 + 2 个酒客 AI）
 *   p2p   纯 P2P 联机（零服务器，手动交换两段连接码）
 *
 * ---------------------------------------------------------------------------
 * 这个游戏接纯 P2P 的核心难点：**骰子点数是私密信息，但叫牌要基于全场。**
 *
 * 如果房主掌握双方的骰子，他就能算出「实际有几颗 V 点」，
 * 质疑必赢 —— 就是在作弊。所以骰子必须**各自本地摇**，
 * 房主和加入方都提前看不到对方的点数。
 *
 * 解法是 commit-reveal（先承诺、后揭示），详见 src/rules.mjs 的说明：
 *   1. 每人本地摇骰子，选随机 salt，算 commit = H(salt || dice)，公开 commit
 *   2. 叫牌、质疑都是公开动作
 *   3. 有人质疑 → 进入揭示阶段，双方各自把 salt + dice 发给对方
 *   4. 收到 reveal 先验 hash 对不对得上 commit，对不上就是作弊
 *   5. 房主算出 actual 广播；加入方自己也重算一遍核对
 *
 * 联机状态同步用「房主权威」模型（见 src/net/p2p.js 的 HostAuthority）：
 *   · 玩家只上报「我想做什么」（input）
 *   · 房主判定合法性、推进牌局、广播权威状态（state）
 *   · 双方用同一份规则引擎重放，状态一致
 *   · 定期比对摘要（hash），不一致由房主下发快照（sync）纠偏
 *
 * 纪律：顶层不碰 localStorage（成绩记录除外，且都在函数里 try/catch）。
 * ========================================================================== */

import {
  PHASE, initPub, fold, replay, hashPub, publicView,
  bidOK, totalDice, nextSeat, allCommitted, countValue,
  commitHash, makeSalt, rollDice, verifyReveal, resolveDoubt,
} from './rules.mjs';
import { P2PSession, HostAuthority, checkSupport } from '../../src/net/p2p.js';

const $ = (id) => document.getElementById(id);

/* ---- 全局状态 ---- */
let mode = 'ai';
let nPlayers = 3;               /* 人机局是 3 人；联机局固定 2 人 */
let pub = initPub(3, 3);
let base = { n: 3, dicePerPlayer: 3 };
let localActs = [];
let session = null;
let authority = null;

/* 本地私密的骰子与承诺（只有自己知道点数） */
let myDice = [];
let mySalt = '';
let myCommit = '';
let peerDice = null;           /* 揭示阶段拿到的对方骰子 */
let peerSalt = '';
let revealed = false;          /* 本轮是否已揭示 */

/* 揭示阶段的本地快照 —— 结算会把落败者的承诺清空、
   也会把 lastBid 清掉，所以进揭示阶段那一刻先把底稿留一份，核对时用。 */
let myRevealed = null;         /* {salt, dice} —— 我这一轮摊开的骰子 */
let peerRevealed = null;       /* {salt, dice} —— 对方这一轮摊开的骰子 */
let revealCommits = [];        /* 进揭示阶段时各座位的承诺值 */
let revealCounts = [];         /* 进揭示阶段时各座位的骰子数 */
let revealBid = null;          /* 进揭示阶段时的叫牌 */
let revealDoubter = -1;        /* 进揭示阶段时的质疑者 */
let revealSent = false;        /* 本轮是否已发出揭示（防止重复发） */

/* 叫牌输入 */
let bidN = 1, bidV = 2;

/* AI 状态（人机模式） */
let aiState = [];              /* [{dice, salt, commit}] */

/* 调试钩子 */
globalThis.__LIAR__ = {
  get session() { return session; },
  get authority() { return authority; },
  get mode() { return mode; },
  get pub() { return pub; },
  get myDice() { return myDice.slice(); },
  get myCommit() { return myCommit; },
  get peerDice() { return peerDice ? peerDice.slice() : null; },
  get actionCount() { return authority ? authority.actions.length : localActs.length; },
  get revealed() { return revealed; },
  bid: (n, v) => { bidN = n; bidV = v; return doBid(); },
  doubt: () => doDoubt(),
  act: (act) => applyLocal(act),
  /* 测试用：直接把骰子塞进来，模拟各种局面 */
  setDice: (d) => { myDice = d.slice(); mySalt = makeSalt(); myCommit = commitHash(mySalt, myDice); },
  roll: () => { myDice = rollDice(pub.counts[mySeat()] || 3); mySalt = makeSalt(); myCommit = commitHash(mySalt, myDice); },
  /* 测试用：取出揭示阶段的本地底稿 ——
     「房主谎报点数」这种作弊只有拿这份底稿重算才能发现。 */
  revealSnapshot: () => ({
    commits: revealCommits.slice(),
    counts: revealCounts.slice(),
    bid: revealBid ? Object.assign({}, revealBid) : null,
    doubter: revealDoubter,
    dice: myRevealed ? myRevealed.dice.slice() : null,
    saltSelf: myRevealed ? myRevealed.salt : '',
    saltPeer: peerSalt,
    peerDice: peerRevealed ? peerRevealed.dice.slice() : null,
    peerSalt: peerRevealed ? peerRevealed.salt : '',
  }),
};

/* =============================================================================
 * 座位
 * ========================================================================== */
function mySeat() {
  if (mode === 'p2p') return session ? (session.isHost ? 0 : 1) : 0;
  return 0;
}
function seatName(i) {
  if (mode === 'p2p') return i === 0 ? '你' : '对方';
  return ['你', '酒客·刀疤', '酒客·独眼'][i] || ('酒客 ' + (i + 1));
}
function isAI(i) { return mode === 'ai' && i !== 0; }

/* =============================================================================
 * 动作提交
 * ========================================================================== */
function applyLocal(act) {
  if (mode === 'p2p' && authority && session) {
    if (session.isHost) {
      authority.applyLocal(act);
    } else {
      /* 加入方没有权威 —— 上报给房主，等房主广播。
         千万别落到下面那条本地 fold 上：那样加入方的状态就跟房主分叉了。 */
      authority.input(act);
    }
    return;
  }
  localActs = localActs.concat([act]);
  pub = fold(base, localActs);
  render();
  afterAction(act);
}

function afterAction(act) {
  if (!act) return;
  if (act.act === 'commit') {
    if (allCommitted(pub)) {
      pushMsg(pub.lastText || '开牌');
      scheduleAI();
    }
    return;
  }
  if (act.act === 'bid') {
    pushMsg(pub.lastText);
    scheduleAI();
    return;
  }
  if (act.act === 'doubt') {
    pushMsg(pub.lastText);
    /* 进入揭示阶段 —— 联机时双方各自把骰子发过去 */
    if (mode === 'p2p') {
      revealed = false;
      peerDice = null;
      peerSalt = '';
      revealSent = false;
      snapshotReveal();
      sendReveal();
    } else {
      /* 人机模式：AI 的骰子本机就有，直接揭示 */
      doResolveLocal();
    }
    return;
  }
  if (act.act === 'resolve') {
    revealed = true;
    peerDice = null;
    peerSalt = '';
    pushMsg(pub.lastText);
    render();
    /* 掉骰的人要重新摇骰、重新承诺 —— 骰子变了，旧承诺就作废了。
       这一步在 rules.mjs 的 applyAction 里已经把 commits[loser] 清空。 */
    scheduleRecommit();
    return;
  }
  render();
}

/**
 * 逐个消化**新出现的**动作。
 *
 * 为什么不能只看最后一个动作：
 *   房主一次广播里可能带了好几个新动作（比如「质疑 + 结算」连着来），
 *   只处理最后一个的话，中间那个动作的副作用就丢了。
 *
 * 更要紧的是：加入方也得靠这个触发「掉骰后重新承诺」——
 * 加入方不重新承诺，这一局就卡在那儿等不到开牌。
 */
let moveCursor = 0;
function runAfterActions(s) {
  const moves = (s && s.moves) || [];
  for (let i = moveCursor; i < moves.length; i++) afterAction(moves[i]);
  moveCursor = moves.length;
}

/**
 * 掉骰后的重新承诺。
 * 人机模式：掉骰的 AI 或本机玩家重新摇。
 * 联机模式：房主自己重摇（本地 applyLocal）；加入方重摇后要走消息通道上报。
 */
function scheduleRecommit() {
  if (pub.phase !== PHASE.COMMIT) return;
  const need = [];
  for (let i = 0; i < pub.n; i++) {
    if (pub.out[i]) continue;
    if (!pub.commits[i]) need.push(i);
  }
  if (!need.length) return;
  if (mode === 'ai') {
    for (const i of need) {
      const cnt = pub.counts[i] || 3;
      const dice = rollDice(cnt);
      const salt = makeSalt();
      const commit = commitHash(salt, dice);
      if (i === 0) { myDice = dice; mySalt = salt; myCommit = commit; }
      else aiState[i - 1] = { dice: dice, salt: salt, commit: commit };
      applyLocal({ act: 'commit', p: i, count: cnt, commit: commit });
    }
    return;
  }
  /* 联机：本机该重摇就重摇 */
  if (need.indexOf(mySeat()) >= 0) {
    const cnt = pub.counts[mySeat()] || 1;
    myDice = rollDice(cnt);
    mySalt = makeSalt();
    myCommit = commitHash(mySalt, myDice);
    if (session && session.isHost) {
      applyLocal({ act: 'commit', p: mySeat(), count: cnt, commit: myCommit });
    } else {
      session.send({ t: 'liar-commit', p: mySeat(), count: cnt, commit: myCommit });
    }
  }
}

function pushMsg(text) {
  if (!text) return;
  setMsg(text, '');
}

/** 只改显示，不动锁定状态。 */
function setMsg(text, cls) {
  const el = $('msg');
  el.textContent = text;
  el.className = 'msg' + (cls ? ' ' + cls : '');
}

/**
 * 核对结论 —— 单独一个区域，不跟 msg 抢位置。
 *
 * 之前核对结果塞在 msg 里，结果每次 render 的阶段提示就把它冲掉了，
 * 玩家根本来不及看「核对通过」还是「房主作弊」。分开显示才靠谱。
 */
function setVerdict(text, cls) {
  const el = $('verdict');
  if (!el) return;
  if (!text) { el.hidden = true; el.textContent = ''; el.className = 'verdict'; return; }
  el.hidden = false;
  el.textContent = text;
  el.className = 'verdict' + (cls ? ' ' + cls : '');
}

/* =============================================================================
 * 揭示流程
 * ========================================================================== */

/** 联机：把自己的 salt + dice 发给对方（不进权威序列 —— 这是私密信息）。 */
function sendReveal() {
  if (mode !== 'p2p' || !session || !session.isOpen) return;
  if (revealSent) return;
  revealSent = true;
  /* 快照自己这一轮摊开的骰子 ——
     结算后掉骰的人要重摇重承诺，mySalt/myDice 会变，
     但核对房主结算时必须用**当时摊开的那份**。 */
  myRevealed = { salt: mySalt, dice: myDice.slice() };
  session.send({ t: 'liar-reveal', salt: mySalt, dice: myDice.slice() });
}

/**
 * 收到对方的揭示 → 验 hash。
 *
 * 注意这里验的是**对方自己承诺的那份骰子**：
 *   pub.commits[p] 是对方在承诺阶段公开的哈希，
 *   salt + dice 是对方现在摊开的，
 *   两者必须对得上 —— 对不上就是对方中途换了骰子。
 */
function onPeerReveal(m) {
  if (mode !== 'p2p') return;
  const p = session && session.isHost ? 1 : 0;
  const v = verifyReveal(m.salt, m.dice, pub.commits[p], pub.counts[p]);
  if (!v.ok) {
    setVerdict('对方作弊：' + v.reason, 'bad');
    return;
  }
  peerDice = v.dice;
  peerSalt = m.salt || '';
  /* 留一份底 —— 结算后 peerDice 会被清掉，
     但核对房主的结算时还需要「对方当时摊的是什么」。 */
  peerRevealed = { salt: peerSalt, dice: peerDice.slice() };
  /* 房主算完广播；加入方等房主的 resolve，再自己核对 */
  if (session && session.isHost) {
    doResolveP2P();
  } else {
    render();
  }
}

/**
 * 快照揭示阶段的状态 —— 结算会把落败者的承诺清空，
 * 所以进揭示阶段那一刻先把承诺值和颗数留一份底，核对时用。
 */
function snapshotReveal() {
  revealCommits = (pub.commits || []).slice();
  revealCounts = (pub.counts || []).slice();
  revealBid = pub.lastBid ? { n: pub.lastBid.n, v: pub.lastBid.v, p: pub.lastBid.p } : null;
  revealDoubter = pub.doubter;
  peerRevealed = null;
}

/**
 * 加入方核对房主的结算。
 *
 * 这一步是这个游戏里**唯一能防住房主作弊**的地方，所以查得细一点：
 *   ① 房主摊的骰子必须跟他的承诺哈希对得上（不能中途换骰子）
 *   ② 房主转述我的骰子必须跟我自己摊的一模一样（不能改我的点数）
 *   ③ actual / liar / loser 全部由加入方**自己重算**，房主报的对不上就是作弊
 *   ④ 剩余骰子数也要对得上
 *
 * 关键：③④ 用的是加入方**自己的**揭示快照，
 * 不依赖房主给的任何数字 —— 房主给的东西全都要拿本地底稿去验。
 */
function verifyGuestResolve(m) {
  const mine = mySeat();
  const peer = mine === 0 ? 1 : 0;
  const dice = m.dice || [];
  const commits = revealCommits.length ? revealCommits : (pub.commits || []);
  const counts = revealCounts.length ? revealCounts : (pub.counts || []);

  /* 房主报的叫牌必须跟本地底稿一致 —— 否则它可以改叫牌来凑点数 */
  if (revealBid) {
    if (m.bidN !== revealBid.n || m.bidV !== revealBid.v || m.bidP !== revealBid.p) {
      setVerdict('房主报的叫牌跟当时的不一样 —— 他在作弊', 'bad');
      return;
    }
  }

  /* ① 房主的骰子 —— 用房主给的 salt 验房主的承诺哈希 */
  const hostDice = dice[peer];
  if (!Array.isArray(hostDice)) {
    setVerdict('房主没给出骰子 —— 无法核对', 'bad');
    return;
  }
  const vh = verifyReveal(m.saltSelf, hostDice, commits[peer], counts[peer]);
  if (!vh.ok) {
    setVerdict('房主摊的骰子跟他的承诺对不上 —— 他在作弊', 'bad');
    return;
  }

  /* ② 我的骰子 —— 用**我自己的** salt 验（房主给的 salt 只是对照） */
  if (!myRevealed) {
    setVerdict('还没摊牌就结算了 —— 不认', 'bad');
    return;
  }
  const vm = verifyReveal(myRevealed.salt, dice[mine], commits[mine], counts[mine]);
  if (!vm.ok) {
    setVerdict('房主转述我的骰子跟我的承诺对不上 —— 他在作弊', 'bad');
    return;
  }
  if (JSON.stringify(dice[mine]) !== JSON.stringify(myRevealed.dice)) {
    setVerdict('房主转述的我的骰子跟我摊的不一样 —— 他在作弊', 'bad');
    return;
  }

  /* ③④ 自己重算 actual / liar / loser —— 房主报的对不上就是作弊 */
  const bid = revealBid || { n: m.bidN, v: m.bidV, p: m.bidP };
  /* 质疑者也要用本地记录的 —— 房主报的可能不是同一个人 */
  const doubter = revealDoubter >= 0 ? revealDoubter : m.doubter;
  if (doubter !== m.doubter) {
    setVerdict('房主报的质疑者跟当时的不一样 —— 他在作弊', 'bad');
    return;
  }
  const diceList = [];
  diceList[mine] = myRevealed.dice.slice();
  diceList[peer] = hostDice.slice();
  const r = resolveDoubt(diceList, bid, doubter);
  if (r.actual !== m.actual) {
    setVerdict('房主报的点数对不上（他报 ' + m.actual + '，实际 ' + r.actual + '）—— 他在作弊', 'bad');
    return;
  }
  if (!!m.liar !== !!r.liar || m.loser !== r.loser) {
    setVerdict('房主判定的输赢跟我自己算的不一样 —— 他在作弊', 'bad');
    return;
  }

  /* ④ 剩余骰子数 */
  const expectCounts = counts.slice();
  if (r.loser >= 0) expectCounts[r.loser] = Math.max(0, expectCounts[r.loser] - 1);
  if (m.countsAfter && JSON.stringify(m.countsAfter) !== JSON.stringify(expectCounts)) {
    setVerdict('房主报的剩余骰子数对不上 —— 他在作弊', 'bad');
    return;
  }
  setVerdict('核对通过：房主的结算没问题', 'ok');
}

/**
 * 房主算出实际点数并生成 resolve 动作。
 *
 * 关键：**骰子与 salt 的对应关系不能搞反**。
 *   saltSelf  = 房主自己的 salt，配 pub.dice[mySeat]
 *   saltPeer  = 对方的 salt，配 pub.dice[peerSeat]
 * 加入方拿到这两组数据后，要能自己重算 actual 并核对房主有没有乱报。
 */
function doResolveP2P() {
  if (!session || !session.isHost) return;
  if (!peerDice) return;
  const my = mySeat();
  const peerSeat = my === 0 ? 1 : 0;
  const diceList = [];
  diceList[my] = myDice.slice();
  diceList[peerSeat] = peerDice.slice();
  /* 叫牌信息要在 applyLocal **之前**抓下来 ——
     applyLocal 会推进状态，lastBid 随之被清掉，事后再读就是 null 了。
     承诺值和颗数同理：结算会把落败者的承诺清掉，事后读到的已经不是原来那份了。 */
  const bid = pub.lastBid ? { n: pub.lastBid.n, v: pub.lastBid.v, p: pub.lastBid.p } : null;
  const doubter = pub.doubter;
  if (!bid) { pushMsg('没有待结算的叫牌'); return; }
  const commitsBefore = (pub.commits || []).slice();
  const countsBefore = (pub.counts || []).slice();
  /* 自己的 salt 和骰子也必须**提前**快照 ——
     applyLocal 会触发 afterAction('resolve') → scheduleRecommit，
     如果这局是房主掉骰，房主会当场重摇重承诺，mySalt/myDice 就变了。
     事后读到的已经是新的一份 salt —— 加入方拿它验 hash 必然对不上，
     会误判「房主作弊」。 */
  const saltSelf = mySalt;
  const r = resolveDoubt(diceList, bid, doubter);
  const counts = countsBefore.slice();
  applyLocal({
    act: 'resolve',
    p: doubter,
    actual: r.actual,
    liar: r.liar,
    loser: r.loser,
    dice: diceList,
    counts: counts,
  });
  /* 额外把叫牌细节发给加入方 —— 它要自己重算 actual 核对房主有没有乱报。
     注意 salt 要**分清是谁的**：
       saltSelf 配 dice[my]（房主的骰子）
       saltPeer 配 dice[peer]（对方的骰子）
     之前搞混过：加入方拿对方的 salt 去验房主的骰子，
     结果 hash 永远对不上，误报「房主作弊」。
     这里把**结算前**的承诺值和骰子数也一并带上 ——
     结算会清掉落败者的承诺，加入方得用结算前那份来验。 */
  const countsAfter = countsBefore.slice();
  if (r.loser >= 0) countsAfter[r.loser] = Math.max(0, countsAfter[r.loser] - 1);
  if (session && session.isOpen) {
    session.send({
      t: 'liar-resolve',
      bidN: bid.n, bidV: bid.v, bidP: bid.p,
      doubter: doubter, actual: r.actual,
      liar: r.liar, loser: r.loser,
      dice: diceList,
      countsAfter: countsAfter,
      commits: commitsBefore,
      saltSelf: saltSelf,
      saltPeer: peerSalt,
      mySeat: my,
    });
  }
}

/** 人机模式：直接揭示全部骰子并结算。 */
function doResolveLocal() {
  const diceList = pub.counts.map((_, i) => (aiState[i] ? aiState[i].dice.slice() : []));
  diceList[0] = myDice.slice();
  const doubter = pub.doubter;
  const r = resolveDoubt(diceList, pub.lastBid, doubter);
  applyLocal({
    act: 'resolve',
    p: doubter,
    actual: r.actual,
    liar: r.liar,
    loser: r.loser,
    dice: diceList,
    counts: (pub.counts || []).slice(),
  });
}

/* =============================================================================
 * 玩家操作
 * ========================================================================== */

/** 叫牌。 */
function doBid() {
  if (pub.phase !== PHASE.BID) { pushMsg('现在不能叫牌'); return false; }
  if (pub.turn !== mySeat()) { pushMsg('还没轮到你'); return false; }
  if (!bidOK(pub.lastBid, bidN, bidV, totalDice(pub))) {
    pushMsg('叫牌必须比上一手更大');
    return false;
  }
  const act = { act: 'bid', p: mySeat(), n: bidN, v: bidV };
  if (mode === 'p2p' && authority && session && !session.isHost) {
    authority.input(act);
    pushMsg('叫牌已上报');
    return true;
  }
  applyLocal(act);
  return true;
}

/** 质疑上家。 */
function doDoubt() {
  if (pub.phase !== PHASE.BID) { pushMsg('现在不能质疑'); return false; }
  if (pub.turn !== mySeat()) { pushMsg('还没轮到你'); return false; }
  if (!pub.lastBid) { pushMsg('首轮没有上家可以质疑'); return false; }
  const act = { act: 'doubt', p: mySeat() };
  if (mode === 'p2p' && authority && session && !session.isHost) {
    authority.input(act);
    pushMsg('质疑已上报');
    return true;
  }
  applyLocal(act);
  return true;
}

/* =============================================================================
 * AI
 * ========================================================================== */
let aiTimer = null;
let aiGen = 0;

function scheduleAI() {
  if (aiTimer) { clearTimeout(aiTimer); aiTimer = null; }
  if (mode !== 'ai') return;
  if (pub.phase !== PHASE.BID) return;
  const seat = pub.turn;
  if (!isAI(seat)) return;
  const gen = aiGen;
  aiTimer = setTimeout(() => {
    if (gen !== aiGen) return;
    if (mode !== 'ai' || pub.phase !== PHASE.BID || pub.turn !== seat) return;
    aiAct(seat);
  }, 800 + Math.random() * 700);
}

/** AI 决策：加码 or 质疑。 */
function aiAct(seat) {
  const r = Math.random();
  const last = pub.lastBid;
  if (last && r < 0.28) {
    applyLocal({ act: 'doubt', p: seat });
    return;
  }
  let n, v;
  if (last) {
    if (r < 0.6) { n = last.n + 1; v = last.v; }
    else { n = last.n; v = Math.min(6, last.v + 1); }
  } else {
    n = 1 + Math.floor(Math.random() * 2);
    v = 2 + Math.floor(Math.random() * 4);
  }
  const max = totalDice(pub);
  if (n > max) n = max;
  if (!bidOK(last, n, v, max)) {
    /* 加不动了就质疑 */
    if (last) applyLocal({ act: 'doubt', p: seat });
    return;
  }
  applyLocal({ act: 'bid', p: seat, n: n, v: v });
}

/* =============================================================================
 * 开局
 * ========================================================================== */
function newGame() {
  aiGen++;
  if (aiTimer) { clearTimeout(aiTimer); aiTimer = null; }
  localActs = [];
  moveCursor = 0;
  setVerdict('');
  peerDice = null;
  peerSalt = '';
  myRevealed = null;
  revealCommits = [];
  revealCounts = [];
  revealBid = null;
  revealDoubter = -1;
  myRevealed = null;
  peerRevealed = null;
  revealSent = false;
  revealed = false;
  bidN = 1; bidV = 2;

  const n = mode === 'p2p' ? 2 : nPlayers;
  base = { n: n, dicePerPlayer: 3 };
  pub = initPub(n, 3);

  if (mode === 'p2p' && authority) {
    if (session && session.isHost) {
      const s = (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0;
      authority.init({ s, base });
      pub = fold(base, []);
      render();
      /* 房主先摇自己的骰子并提交承诺 */
      myDice = rollDice(3);
      mySalt = makeSalt();
      myCommit = commitHash(mySalt, myDice);
      applyLocal({ act: 'commit', p: 0, count: 3, commit: myCommit });
    } else {
      /* 加入方：本地摇骰、提交承诺（承诺值公开，点数保密） */
      myDice = rollDice(3);
      mySalt = makeSalt();
      myCommit = commitHash(mySalt, myDice);
      render();
      submitMyCommit();
    }
    return;
  }

  /* 人机模式 */
  myDice = rollDice(3);
  mySalt = makeSalt();
  myCommit = commitHash(mySalt, myDice);
  aiState = [];
  for (let i = 1; i < n; i++) {
    const d = rollDice(3);
    const salt = makeSalt();
    aiState.push({ dice: d, salt: salt, commit: commitHash(salt, d) });
  }
  render();
  /* 依次提交承诺 —— 承诺值公开，点数各人自己知道 */
  applyLocal({ act: 'commit', p: 0, count: 3, commit: myCommit });
  for (let i = 1; i < n; i++) {
    applyLocal({ act: 'commit', p: i, count: 3, commit: aiState[i - 1].commit });
  }
}

/** 加入方把自己的承诺上报给房主。 */
function submitMyCommit() {
  if (!authority || !session) return;
  if (!session.isHost) {
    /* 加入方 → 房主：承诺是公开信息，但点数不能给。
       这里只报承诺值和颗数。 */
    session.send({ t: 'liar-commit', p: mySeat(), count: myDice.length, commit: myCommit });
    return;
  }
  applyLocal({ act: 'commit', p: 0, count: myDice.length, commit: myCommit });
}

/* =============================================================================
 * 渲染
 * ========================================================================== */
function render() {
  const n = pub.n || 3;
  /* 座位 */
  $('seats').innerHTML = pub.counts.map((cnt, i) => {
    const mine = i === mySeat();
    const dice = revealed && pub.dice && pub.dice[i]
      ? pub.dice[i]
      : (mine ? myDice : null);
    const shown = dice ? dice.map((d) => `<span class="die">${d}</span>`).join('')
      : cnt ? new Array(cnt).fill('<span class="die hidden"></span>').join('') : '';
    const cls = 'seat' + (i === pub.turn && pub.phase === PHASE.BID ? ' active' : '') + (pub.out[i] ? ' out' : '');
    const who = mine ? seatName(i) + '（你）' : seatName(i);
    return `<div class="${cls}">
      <div class="who${mine ? ' me' : ''}">${who}</div>
      <div class="dice">${shown}</div>
      <div class="life">${pub.out[i] ? '出局' : cnt + ' 颗骰'}</div>
    </div>`;
  }).join('');

  /* 桌上的叫牌 */
  const td = totalDice(pub);
  $('claim').innerHTML = pub.lastBid
    ? ('桌上叫牌：<b>' + pub.lastBid.n + ' 颗 ' + pub.lastBid.v + ' 点</b> · 全场骰子共 ' + td + ' 颗')
    : ('尚未叫牌 · 全场骰子共 ' + td + ' 颗');

  /* 叫牌框：轮到谁就谁能操作 */
  const myTurn = pub.phase === PHASE.BID && pub.turn === mySeat();
  $('bidbox').hidden = !(myTurn);
  $('btn-doubt').disabled = !pub.lastBid;
  $('bidN').textContent = bidN;
  $('bidV').textContent = bidV;

  /* 揭示区 */
  const rv = $('reveal');
  if (pub.phase === PHASE.REVEAL || (pub.phase === PHASE.OVER && pub.actual >= 0)) {
    rv.hidden = false;
    const diceTxt = (pub.dice || []).map((d, i) =>
      (d ? seatName(i) + '：' + d.join(' ') : seatName(i) + '：—')).join('<br>');
    rv.innerHTML = '叫牌：<b>' + (pub.lastBid ? pub.lastBid.n + ' 颗 ' + pub.lastBid.v + ' 点' : '—') + '</b><br>' +
      '实际点数：<b>' + (pub.actual >= 0 ? pub.actual : '—') + '</b> 颗<br>' +
      diceTxt + '<br>' +
      (pub.loser >= 0 ? ('<b>' + seatName(pub.loser) + '</b> 掉了一颗骰子' + (pub.out[pub.loser] ? '，出局！' : '')) : '');
  } else {
    rv.hidden = true;
  }

  /* 阶段提示 */
  if (pub.phase === PHASE.COMMIT) {
    setMsg('等所有人亮出骰子承诺…', '');
  } else if (pub.phase === PHASE.OVER) {
    setMsg(pub.winner === mySeat() ? '你赢了！+20 金币' : '你出局了 -10 金币',
      pub.winner === mySeat() ? 'win' : 'lose');
  }
}

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
      const base2 = (seed && seed.base) || { n: 2 };
      return { base: base2, pub: fold(base2, acts || []), moves: (acts || []).slice() };
    },
    hash: (s) => hashPub(publicView(s.pub)),
    /* REVEAL 阶段不能提前露出骰子。
       也要带上 moves —— 加入方靠它逐个消化动作（掉骰后重新承诺靠这个触发）。 */
    view: (s) => ({ base: s.base, pub: publicView(s.pub), moves: (s.moves || []).slice() }),
    validate: (s, act) => {
      const st = s.pub;
      if (!st) return { ok: false, reason: '还没准备好' };
      if (st.phase === PHASE.OVER) return { ok: false, reason: '这局已经结束了' };
      if (!act) return { ok: false, reason: '空动作' };
      if (act.act === 'bid') {
        if (st.phase !== PHASE.BID) return { ok: false, reason: '现在不是叫牌阶段' };
        if (st.turn !== act.p) return { ok: false, reason: '还没轮到你' };
        if (!bidOK(st.lastBid, act.n, act.v, totalDice(st))) return { ok: false, reason: '叫牌必须比上一手更大' };
        return true;
      }
      if (act.act === 'doubt') {
        if (st.phase !== PHASE.BID) return { ok: false, reason: '现在不是叫牌阶段' };
        if (st.turn !== act.p) return { ok: false, reason: '还没轮到你' };
        if (!st.lastBid) return { ok: false, reason: '首轮没有上家可以质疑' };
        return true;
      }
      if (act.act === 'commit') {
        if (act.count != null && act.count !== st.counts[act.p]) {
          return { ok: false, reason: '骰子颗数对不上' };
        }
        return true;
      }
      return true;
    },
  });

  const applyState = (s) => {
    if (!s || !s.pub) return;
    const prevPhase = pub.phase;
    pub = s.pub;
    render();
    /* 新动作逐个走 afterAction —— 加入方也得靠它触发「掉骰后重新承诺」。
       （否则加入方掉骰后不会重新承诺，这一局就卡住了。）
       afterAction('doubt') 里已经处理了「进揭示阶段 → 各自发骰子」。 */
    runAfterActions(s);
    if (pub.phase === PHASE.BID && prevPhase === PHASE.COMMIT) scheduleAI();
  };
  authority.onState(applyState);
  authority.onLocalState((s) => {
    if (!s || !s.pub) return;
    const prevPhase = pub.phase;
    pub = s.pub;
    render();
    runAfterActions(s);
  });
  authority.onReject((reason) => {
    pushMsg('房主驳回了这一手：' + (reason || '不合法'));
    $('msg').className = 'msg lose';
  });
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
    session = new P2PSession({ role: 'host', gameId: 'liar', name: '房主' });
    setupAuthority();
    session.on('status', (st, text) => {
      p2pState(text || st, st === 'open' ? 'ok' : st === 'failed' ? 'err' : 'wait');
      if (st === 'open') { $('rolebar').hidden = true; newGame(); }
    });
    session.on('message', (m) => {
      if (!m) return;
      if (m.t === 'liar-commit') {
        /* 加入方的承诺 → 写进权威序列 */
        if (session && session.isHost) {
          applyLocal({ act: 'commit', p: m.p, count: m.count, commit: m.commit });
        }
      } else if (m.t === 'liar-reveal') {
        onPeerReveal(m);
      }
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
    session = new P2PSession({ role: 'guest', gameId: 'liar', name: '加入方' });
    setupAuthority();
    session.on('status', (st, text) => {
      p2pState(text || st, st === 'open' ? 'ok' : st === 'failed' ? 'err' : 'wait');
      if (st === 'open') { $('rolebar').hidden = true; newGame(); }
    });
    session.on('message', (m) => {
      if (!m) return;
      if (m.t === 'liar-reveal') {
        onPeerReveal(m);
      } else if (m.t === 'liar-resolve') {
        verifyGuestResolve(m);
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
  myDice = [];
  myCommit = '';
  peerDice = null;
  peerSalt = '';
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

/* =============================================================================
 * 事件绑定
 * ========================================================================== */
$('btn-claim').addEventListener('click', doBid);
$('btn-doubt').addEventListener('click', doDoubt);
$('btn-new').addEventListener('click', newGame);
document.querySelectorAll('.stepper button').forEach((b) => {
  b.addEventListener('click', () => {
    const t = b.getAttribute('data-t');
    const max = totalDice(pub);
    if (t === 'n+') bidN = Math.min(max, bidN + 1);
    if (t === 'n-') bidN = Math.max(1, bidN - 1);
    if (t === 'v+') bidV = Math.min(6, bidV + 1);
    if (t === 'v-') bidV = Math.max(2, bidV - 1);
    $('bidN').textContent = bidN;
    $('bidV').textContent = bidV;
  });
});
$('btn-info').addEventListener('click', () => { $('info').hidden = false; });
$('info-close').addEventListener('click', () => { $('info').hidden = true; });
$('btn-reset').addEventListener('click', () => { $('msg').textContent = '已重置'; });

$('mode-ai').addEventListener('click', () => {
  mode = 'ai';
  $('mode-ai').classList.add('on');
  $('mode-p2p').classList.remove('on');
  $('p2p').hidden = true;
  newGame();
});
$('mode-p2p').addEventListener('click', () => {
  mode = 'p2p';
  $('mode-p2p').classList.add('on');
  $('mode-ai').classList.remove('on');
  $('p2p').hidden = false;
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
if (!support.ok) pushMsg(support.reason);
newGame();
