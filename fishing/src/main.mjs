/* =============================================================================
 * fishing/src/main.mjs —— 小铺垂钓主控
 * -----------------------------------------------------------------------------
 * 三种模式：
 *   solo   单人垂钓（湖由随机种子生成）
 *   daily  每日一钓（湖由日期派生，同一天所有人鱼群与窗口分布一致）
 *   p2p    纯 P2P 联机（零服务器，手动交换两段连接码）
 *
 * ---------------------------------------------------------------------------
 * 核心玩法
 * ---------------------------------------------------------------------------
 *   抛竿 → 浮标落水 → 等一会儿（延迟由种子推导）→ 有鱼咬钩（浮标一沉）
 *   → 屏幕下方出现一条「反应窗口」，中间那段高亮是**完美区**
 *   → 在窗口里点「收竿」：正中完美区＝大鱼，窗口里但偏了＝小鱼，超时＝空钩
 *
 * ---------------------------------------------------------------------------
 * 这个游戏接纯 P2P 的核心难点：**咬钩时刻、窗口宽度、稀有度都是随机数。**
 *
 * 纯 P2P 没有服务器，房主就是权威。随机数要是由房主掷、由房主报，
 * 房主完全可以把传说鱼和宽窗口都留给自己。
 *
 * 解法跟飞行棋那边一致：**随机数不是掷出来的，是算出来的**。
 *   鱼种   = H(seed | "species" | 座位 | 第几竿)
 *   延迟   = H(seed | "bite"    | 座位 | 第几竿)
 *   完美区 = H(seed | "zone"    | 座位 | 第几竿)
 * seed 是公开的，座位与抛竿次序也是公开的（在动作序列里），
 * 所以双方各自算出来的鱼群、延迟、窗口**必然一致** —— 房主改不了：
 * 他一改就跟加入方对不上，摘要当场就能比对出来。
 *
 * 详见 src/rules.mjs 开头那段说明。
 *
 * 联机状态同步用「房主权威」模型（见 src/net/p2p.js 的 HostAuthority）：
 *   · 玩家只上报「我想抛竿 / 我在第几毫秒收的竿」（input）
 *   · 房主判定合法性、推进局面、广播权威状态（state）
 *   · 双方用同一份规则引擎重放，状态一致
 *   · 定期比对摘要（hash），不一致由房主下发快照（sync）纠偏
 *
 * 纪律：顶层不碰 localStorage（成绩记录除外，且都在函数里 try/catch）；
 *       顶层不碰 DOM（所有查询与事件绑定都在末尾的启动段里）。
 * ========================================================================== */

import {
  SPECIES_BY_ID, RARITY_COLOR,
  RODS, MAX_ROD, DAILY_CASTS, GRADE_LABEL, rodOf,
  pendingPlan, canCast, isPending, lakeSpecies,
  randomSeed, seedFromRoom, dailySeed, dateKeyOf,
  initState, fold, hashState, publicView,
  scoreOf,
} from './rules.mjs';
import { P2PSession, HostAuthority, checkSupport } from '../../src/net/p2p.js';

const $ = (id) => document.getElementById(id);

/* =============================================================================
 * 全局状态
 * ========================================================================== */
let mode = 'solo';                 /* solo | daily | p2p */
let st = null;                     /* 规则局面 */
let base = null;                   /* { seed, rod, seats, daily, maxCasts } */
let localActs = [];                /* 单人模式的动作序列 */
let session = null;                /* P2PSession */
let authority = null;              /* HostAuthority */
let mySeat = 0;                    /* 我控制的座位（房主 0 / 加入方 1） */
let localApply = false;            /* 正在本地提交动作（房主区分本地 / 远端） */
let castRecvAt = [0, 0];           /* 房主侧：收到各座位抛竿动作的时刻 */
let mySubmitted = [];              /* 我提交过的动作（加入方用来核对房主） */
let lastBase = null;               /* 最近一次收到的权威 base（联机用） */

/* 本地节奏 */
let phase = 'idle';                /* idle | waiting | bite */
let plan = null;                   /* 当前这一竿的计划 */
let t0 = 0;                        /* 咬钩时刻（本地 performance.now()） */
let biteTimer = null;
let missTimer = null;
let seenCatches = [0, 0];          /* 已经播报过的鱼（按座位） */
let lastCatch = null;              /* 我这一竿的结果 */

/* 场景动画 */
let sceneT = 0;
let floatDip = 0;                  /* 浮标下沉程度 0..1 */
let splashAt = -1;                 /* 水花时间戳（-1 = 没有） */
let caughtAt = -1;                 /* 钓起动画时间戳 */
let reduced = false;

/* 存档 */
const SAVE_KEY = 'mg_fishing.v1';
let save = null;

/* 调试钩子（端到端测试用） */
globalThis.__FISHING__ = {
  get state() { return st; },
  get pub() { return st; },
  get base() { return base; },
  get seed() { return base ? base.seed : 0; },
  get mode() { return mode; },
  get phase() { return phase; },
  get plan() { return plan; },
  get mySeat() { return mySeat; },
  get actionCount() { return authority ? authority.actions.length : localActs.length; },
  get moves() { return authority ? authority.actions.slice() : localActs.slice(); },
  get save() { return save; },
  get basket() { return (save && save.basket) ? save.basket.slice() : []; },
  get coin() { return save ? save.coin : 0; },
  get session() { return session; },
  get authority() { return authority; },
  get remoteBase() { return lastBase || base; },
  lake: (n, seat) => lakeSpecies(st ? st.seed : 0, st ? st.rod : 0, n === undefined ? 20 : n, seat === undefined ? 0 : seat),
  cast: () => doCast(),
  reel: (dt) => doReel(dt),
  act: (a) => submitAction(a),
  render: () => render(),
  dailyKey: () => dateKeyOf(),
  dailySeed: () => dailySeed(dateKeyOf(), 'fishing'),
};

/* =============================================================================
 * 存档
 * ========================================================================== */
function defaultSave() {
  return {
    coin: 0,
    best: 0,
    rod: 0,
    caught: 0,
    species: {},
    daily: { date: '', best: 0 },
    basket: [],
  };
}

function loadSave() {
  const d = defaultSave();
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return d;
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object') return d;
    const s = Object.assign(d, o);
    s.daily = Object.assign({ date: '', best: 0 }, o.daily || {});
    s.species = o.species && typeof o.species === 'object' ? o.species : {};
    s.basket = Array.isArray(o.basket) ? o.basket.slice(-60) : [];
    s.rod = Math.max(0, Math.min(MAX_ROD, Number(o.rod) || 0));
    s.coin = Math.max(0, Number(o.coin) || 0);
    s.best = Math.max(0, Number(o.best) || 0);
    s.caught = Math.max(0, Number(o.caught) || 0);
    return s;
  } catch (e) {
    return d;
  }
}

function persist() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(save));
  } catch (e) { /* file:// 下可能抛，忽略 */ }
}

/* =============================================================================
 * 开局 / 换湖
 * ========================================================================== */
function seatCount() {
  return mode === 'p2p' ? 2 : 1;
}

/** 联机局是否走「今日之湖」（房主勾选，加入方跟着走）。 */
function p2pDailyOn() {
  const el = $('p2p-daily');
  return !!(el && el.checked);
}

/**
 * 联机局可以接受的种子（房主说了算，但加入方要能自己核对）。
 * 返回 null 表示当前没法核对。
 */
function expectedSeeds() {
  if (mode !== 'p2p' || !session || !session.roomId) return null;
  return [
    seedFromRoom(session.roomId, 'fishing'),
    dailySeed(dateKeyOf(), 'fishing'),
  ];
}

/** 这一局用哪个种子。 */
function pickSeed() {
  if (mode === 'daily') return dailySeed(dateKeyOf(), 'fishing');
  if (mode === 'p2p' && session && session.roomId) {
    return p2pDailyOn() ? dailySeed(dateKeyOf(), 'fishing') : seedFromRoom(session.roomId, 'fishing');
  }
  return randomSeed();
}

function newGame() {
  clearTimers();
  phase = 'idle';
  plan = null;
  lastCatch = null;
  localActs = [];
  mySubmitted = [];
  seenCatches = [0, 0];

  const seats = seatCount();
  const seed = pickSeed();
  const daily = mode === 'daily' || (mode === 'p2p' && p2pDailyOn());
  /* 鱼竿等级：联机局用房主的（写在开局状态里，双方一致），
     单人 / 每日局用本地存档里的等级。 */
  const rod = rodOf(save.rod).level;

  base = { seed: seed, rod: rod, seats: seats, daily: daily, maxCasts: daily ? DAILY_CASTS : 0 };
  st = initState(seed, base);

  if (mode === 'p2p' && authority) {
    if (session && session.isHost) {
      authority.init({ base: base });
      st = fold(base, []);
    }
    setMsg(daily
      ? '今日之湖已开 —— 今天这片湖跟所有人一样'
      : '联机局已就绪 —— 同一片湖，两个人各钓各的');
  } else {
    setMsg(mode === 'daily'
      ? '今日之湖已开 —— ' + dateKeyOf() + '，抛 ' + DAILY_CASTS + ' 竿'
      : '点「抛竿」，等浮标一沉就点「收竿」');
  }
  render();
}

/* =============================================================================
 * 动作提交
 * ========================================================================== */
function submitAction(act) {
  if (!act) return;
  if (mode === 'p2p' && authority && session) {
    if (session.isHost) {
      localApply = true;
      try {
        authority.applyLocal(act);
      } finally {
        localApply = false;
      }
    } else {
      mySubmitted = mySubmitted.concat([act]);
      authority.input(act);
      setMsg('已上报，等房主裁决…', 'dim');
    }
    return;
  }
  localActs = localActs.concat([act]);
  st = fold(base, localActs);
  afterState();
  render();
}

/** 局面变了之后：同步本地计时器、播报新钓到的鱼。 */
function afterState() {
  if (!st) return;
  for (let seat = 0; seat < st.seats; seat++) {
    const arr = st.catches[seat] || [];
    while (seenCatches[seat] < arr.length) {
      const c = arr[seenCatches[seat]];
      seenCatches[seat]++;
      onCatch(seat, c);
    }
  }
  syncTimers();
}

function onCatch(seat, c) {
  const sp = SPECIES_BY_ID[c.id];
  const name = sp ? sp.name : c.id;
  const mine = seat === mySeat;
  if (mine) {
    lastCatch = c;
    save.caught = (save.caught || 0) + 1;
    save.best = Math.max(save.best || 0, c.value);
    save.species[c.id] = (save.species[c.id] || 0) + 1;
    /* 卖鱼单价受鱼竿等级影响（本地经济，不影响共享局面） */
    const coin = Math.round(c.value * rodOf(save.rod).valueMul);
    save.basket = (save.basket || []).concat([{ id: c.id, value: coin, grade: c.grade }]);
    if (save.basket.length > 60) save.basket = save.basket.slice(-60);
    if (c.grade === 'perfect') {
      setMsg('完美收竿！一条大' + name + '，+' + coin + ' 金币', 'ok');
      caughtAt = sceneT;
    } else if (c.grade === 'good') {
      setMsg('钓到一条小' + name + '，+' + coin + ' 金币', '');
      caughtAt = sceneT;
    } else {
      setMsg('空钩 —— 鱼跑了，下次手快点', 'bad');
    }
    persist();
  } else {
    setMsg('对面钓到了一条' + (sp ? sp.name : '鱼') + '（' + (GRADE_LABEL[c.grade] || c.grade) + '）', 'dim');
  }
  if (st.daily && st.done[seat]) {
    const total = scoreOf(st, seat);
    const key = dateKeyOf();
    if (save.daily.date === key) save.daily.best = Math.max(save.daily.best, total);
    else save.daily = { date: key, best: total };
    persist();
    setMsg((seat === mySeat ? '你的' : '对方的') + '每日一钓结束：' + total + ' 分', seat === mySeat ? 'ok' : 'dim');
  }
}

/* =============================================================================
 * 本地节奏：抛竿 → 咬钩 → 收竿
 * ========================================================================== */
function clearTimers() {
  if (biteTimer) { clearTimeout(biteTimer); biteTimer = null; }
  if (missTimer) { clearTimeout(missTimer); missTimer = null; }
}

/** 局面里的「在钓」状态和本地计时器对齐（联机时状态是异步到的）。 */
function syncTimers() {
  const pending = isPending(st, mySeat);
  if (pending && phase === 'idle') {
    const p = pendingPlan(st, mySeat);
    if (!p) return;
    plan = p;
    phase = 'waiting';
    renderMeter();
    biteTimer = setTimeout(onBite, Math.max(0, p.delay));
  } else if (!pending && phase !== 'idle') {
    clearTimers();
    phase = 'idle';
    plan = null;
  }
}

function onBite() {
  biteTimer = null;
  if (phase !== 'waiting' || !plan) return;
  phase = 'bite';
  t0 = (globalThis.performance && performance.now) ? performance.now() : Date.now();
  floatDip = 1;
  splashAt = sceneT;
  setMsg('上钩了！快收竿 —— 红色那段是完美区', 'ok');
  render();
  /* 窗口过期 = 空钩 */
  missTimer = setTimeout(() => {
    missTimer = null;
    if (phase === 'bite') submitAction({ act: 'miss', seat: mySeat });
  }, plan.window);
}

function nowMs() {
  return (globalThis.performance && performance.now) ? performance.now() : Date.now();
}

/** 抛竿。 */
function doCast() {
  if (!st) return false;
  if (mode === 'p2p' && !session) { setMsg('还没连上，先在「纯 P2P 联机」里建房或加入', 'dim'); return false; }
  if (!canCast(st, mySeat)) {
    setMsg(st.daily && st.done[mySeat] ? '今天的每日一钓已经用完次数了' : '现在不能抛竿', 'dim');
    return false;
  }
  submitAction({ act: 'cast', seat: mySeat });
  return true;
}

/** 收竿。forcedDt 只给测试用（正常玩法用真实经过的时间）。 */
function doReel(forcedDt) {
  if (phase !== 'bite' || !plan) {
    setMsg('现在没有鱼在咬钩', 'dim');
    return false;
  }
  const dt = (typeof forcedDt === 'number') ? forcedDt : (nowMs() - t0);
  clearTimers();
  submitAction({ act: 'reel', seat: mySeat, dt: dt });
  return true;
}

/* =============================================================================
 * 渲染
 * ========================================================================== */
function setMsg(text, cls) {
  const el = $('msg');
  if (!el) return;
  el.textContent = text;
  el.className = 'msg' + (cls ? ' ' + cls : '');
}

/** 反应窗口条：完美区 + 游标。 */
function renderMeter() {
  const zone = $('meter-zone');
  const mark = $('meter-mark');
  const hint = $('meter-hint');
  if (!zone || !mark) return;
  if (!plan) {
    zone.style.display = 'none';
    mark.style.display = 'none';
    if (hint) hint.textContent = '等鱼上钩…';
    return;
  }
  zone.style.display = '';
  mark.style.display = '';
  const left = Math.max(0, (plan.center - plan.half) / plan.window * 100);
  const width = Math.min(100 - left, (plan.half * 2) / plan.window * 100);
  zone.style.left = left + '%';
  zone.style.width = width + '%';
  if (hint) hint.textContent = phase === 'bite' ? '现在！' : '鱼还没来…';
}

/** 每帧更新游标位置（用 transform，不改 left/top）。 */
function updateMeter() {
  const mark = $('meter-mark');
  const track = $('meter-track');
  if (!mark || !track || phase !== 'bite' || !plan) return;
  const w = track.clientWidth;
  const ratio = Math.max(0, Math.min(1, (nowMs() - t0) / plan.window));
  mark.style.transform = 'translateX(' + (ratio * w) + 'px)';
}

function render() {
  if (!st) return;
  renderScore();
  renderButtons();
  renderBasket();
  renderShop();
  renderMeter();
  updateMeter();
  if (reduced) drawScene(sceneT);
}

function renderScore() {
  const set = (id, v) => { const el = $(id); if (el) el.textContent = String(v); };
  set('coin', save.coin);
  set('score', scoreOf(st, mySeat));
  set('best', save.best);
  set('kinds', Object.keys(save.species || {}).length);
  set('rod-name', rodOf(save.rod).name + '（' + rodOf(save.rod).level + ' 级）');

  const daily = $('daily-bar');
  if (daily) {
    if (mode === 'daily') {
      const left = Math.max(0, st.maxCasts - st.casts[mySeat]);
      const key = dateKeyOf();
      const bestTxt = save.daily.date === key ? ('今日最好 ' + save.daily.best) : '今日最好 —';
      daily.hidden = false;
      daily.textContent = '每日一钓 · ' + key + ' · 还剩 ' + left + ' 竿 · ' + bestTxt;
    } else {
      daily.hidden = true;
    }
  }
}

function renderButtons() {
  const cast = $('btn-cast');
  const reel = $('btn-reel');
  const p2pReady = mode !== 'p2p' || !!session;
  const canC = p2pReady && st && canCast(st, mySeat);
  if (cast) cast.disabled = !canC;
  if (reel) reel.disabled = !(phase === 'bite');
  const hint = $('hint');
  const bubble = $('bubble');
  if (bubble) {
    if (phase === 'waiting') bubble.textContent = '浮标在下沉……';
    else if (phase === 'bite') bubble.textContent = '上钩了！点「收竿」';
    else if (lastCatch) {
      const sp = SPECIES_BY_ID[lastCatch.id];
      bubble.textContent = lastCatch.grade === 'miss'
        ? '空钩 —— 鱼跑了'
        : (sp ? sp.name : '鱼') + ' · ' + (GRADE_LABEL[lastCatch.grade] || '') +
          ' · +' + lastCatch.value;
    } else bubble.textContent = '湖边小铺 · 今天也来一竿';
  }
  if (hint) {
    if (mode === 'p2p' && !session) hint.textContent = '先在「纯 P2P 联机」里建房或加入。';
    else if (phase === 'waiting') hint.textContent = '浮标在下沉，好戏在后头…';
    else if (phase === 'bite') hint.textContent = '红色那段是完美区，游标进红区就点「收竿」。';
    else if (st && st.daily && st.done[mySeat]) hint.textContent = '今天的每日一钓结束了，明天再来。';
    else hint.textContent = '点「抛竿」把钩子甩进湖里，等浮标一沉再点「收竿」。';
  }
}

function renderBasket() {
  const box = $('basket');
  if (!box) return;
  const list = save.basket || [];
  box.innerHTML = '';
  if (!list.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = '鱼篓空空的 —— 先钓两条。';
    box.appendChild(d);
  } else {
    const groups = {};
    for (const f of list) {
      const k = f.id;
      if (!groups[k]) groups[k] = { n: 0, v: 0, g: f.grade };
      groups[k].n++;
      groups[k].v += f.value;
    }
    for (const id in groups) {
      const g = groups[id];
      const sp = SPECIES_BY_ID[id];
      const d = document.createElement('div');
      d.className = 'fish';
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = RARITY_COLOR[sp ? sp.rarity : 'common'];
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = (sp ? sp.name : id) + ' ×' + g.n;
      const vl = document.createElement('span');
      vl.className = 'vl';
      vl.textContent = '+' + g.v;
      d.appendChild(dot); d.appendChild(nm); d.appendChild(vl);
      box.appendChild(d);
    }
  }
  const sell = $('btn-sell');
  if (sell) {
    const total = list.reduce((a, f) => a + f.value, 0);
    sell.textContent = total > 0 ? ('卖鱼换金币（+' + total + '）') : '卖鱼换金币';
    sell.disabled = total <= 0;
  }
}

function renderShop() {
  const box = $('shop');
  if (!box) return;
  box.innerHTML = '';
  RODS.forEach((r) => {
    const owned = r.level <= save.rod;
    const d = document.createElement('div');
    d.className = 'rod' + (owned ? ' owned' : '');
    const nm = document.createElement('div');
    nm.className = 'rn';
    nm.textContent = r.name;
    const de = document.createElement('div');
    de.className = 'rd';
    de.textContent = '窗口 ×' + r.windowMul.toFixed(2) + ' · 稀有 ×' + r.rareMul.toFixed(1) + ' · 卖价 ×' + r.valueMul.toFixed(2);
    const pr = document.createElement('div');
    pr.className = 'rp';
    pr.textContent = owned ? '已拥有' : (r.price + ' 金币');
    d.appendChild(nm); d.appendChild(de); d.appendChild(pr);
    if (!owned && r.level === save.rod + 1) {
      const b = document.createElement('button');
      b.className = 'btn mini primary';
      b.type = 'button';
      b.textContent = '买下';
      b.disabled = save.coin < r.price;
      b.addEventListener('click', () => buyRod(r));
      d.appendChild(b);
    }
    box.appendChild(d);
  });
}

function buyRod(r) {
  if (save.coin < r.price) { setMsg('金币不够', 'dim'); return; }
  save.coin -= r.price;
  save.rod = r.level;
  persist();
  setMsg('换上了' + r.name + '！反应窗口更宽，稀有鱼也更多了', 'ok');
  if (mode === 'p2p' && session) {
    setMsg('换上了' + r.name + ' —— 联机局以房主的鱼竿为准，下次开局生效', 'dim');
  } else {
    newGame();
  }
  render();
}

/* =============================================================================
 * 场景绘制（canvas）
 * ========================================================================== */
function drawScene(t) {
  const cv = $('scene');
  if (!cv) return;
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const HOR = Math.round(H * 0.44);

  /* 天空 */
  const sky = g.createLinearGradient(0, 0, 0, HOR);
  sky.addColorStop(0, '#fdf2d8');
  sky.addColorStop(0.55, '#f7dcaa');
  sky.addColorStop(1, '#eec194');
  g.fillStyle = sky;
  g.fillRect(0, 0, W, HOR);

  /* 落日 */
  const sunX = W * 0.74, sunY = HOR - 46;
  const glow = g.createRadialGradient(sunX, sunY, 8, sunX, sunY, 120);
  glow.addColorStop(0, 'rgba(255,246,214,.95)');
  glow.addColorStop(0.35, 'rgba(255,224,166,.45)');
  glow.addColorStop(1, 'rgba(255,224,166,0)');
  g.fillStyle = glow;
  g.fillRect(sunX - 140, sunY - 140, 280, 280);
  g.fillStyle = '#fff6d8';
  g.beginPath();
  g.arc(sunX, sunY, 30, 0, Math.PI * 2);
  g.fill();

  /* 远山 */
  g.fillStyle = '#d8c39c';
  g.beginPath();
  g.moveTo(0, HOR);
  g.quadraticCurveTo(W * 0.16, HOR - 58, W * 0.34, HOR - 12);
  g.quadraticCurveTo(W * 0.5, HOR - 46, W * 0.68, HOR - 6);
  g.quadraticCurveTo(W * 0.85, HOR - 40, W, HOR - 14);
  g.lineTo(W, HOR);
  g.closePath();
  g.fill();
  g.fillStyle = '#bda884';
  g.beginPath();
  g.moveTo(0, HOR);
  g.quadraticCurveTo(W * 0.12, HOR - 30, W * 0.28, HOR - 4);
  g.quadraticCurveTo(W * 0.46, HOR - 24, W * 0.62, HOR - 2);
  g.quadraticCurveTo(W * 0.82, HOR - 22, W, HOR - 6);
  g.lineTo(W, HOR);
  g.closePath();
  g.fill();

  /* 湖面 */
  const lake = g.createLinearGradient(0, HOR, 0, H);
  lake.addColorStop(0, '#8ec0c6');
  lake.addColorStop(0.45, '#5d95a4');
  lake.addColorStop(1, '#2f6274');
  g.fillStyle = lake;
  g.fillRect(0, HOR, W, H - HOR);

  /* 阳光倒影：一道柔和的光柱 + 几道横向微光 */
  const refl = g.createLinearGradient(sunX - 110, 0, sunX + 110, 0);
  refl.addColorStop(0, 'rgba(255,243,205,0)');
  refl.addColorStop(0.5, 'rgba(255,243,205,.22)');
  refl.addColorStop(1, 'rgba(255,243,205,0)');
  g.fillStyle = refl;
  g.beginPath();
  g.moveTo(sunX - 22, HOR);
  g.lineTo(sunX + 22, HOR);
  g.lineTo(sunX + 96, H);
  g.lineTo(sunX - 96, H);
  g.closePath();
  g.fill();
  for (let i = 0; i < 10; i++) {
    const p = i / 10;
    const y = HOR + 12 + p * (H - HOR - 26);
    const w = 20 + p * 44;
    g.fillStyle = 'rgba(255,246,214,' + (0.16 - p * 0.12).toFixed(3) + ')';
    g.fillRect(sunX - w / 2, y, w, 2);
  }

  /* 波纹 */
  g.strokeStyle = 'rgba(255,255,255,.14)';
  g.lineWidth = 1.2;
  for (let i = 0; i < 30; i++) {
    const p = i / 30;
    const y = HOR + 12 + p * (H - HOR - 30);
    const drift = reduced ? 0 : Math.sin(t * 0.6 + i * 0.7) * 26;
    const x = ((i * 61 + drift) % (W + 90)) - 45;
    g.beginPath();
    g.ellipse(x, y, 18 + p * 30, 1.6 + p * 1.6, 0, 0, Math.PI * 2);
    g.stroke();
  }

  /* 前景岸 */
  g.fillStyle = '#6b5236';
  g.beginPath();
  g.moveTo(0, H);
  g.lineTo(0, H - 46);
  g.quadraticCurveTo(W * 0.22, H - 66, W * 0.46, H - 40);
  g.quadraticCurveTo(W * 0.72, H - 18, W, H - 34);
  g.lineTo(W, H);
  g.closePath();
  g.fill();

  /* 湖边小铺 */
  drawShop(g, 26, H - 104, 1.05);

  /* 灯笼（挂在小铺旁边的杆子上） */
  drawLantern(g, 176, H - 118, t);

  /* 钓竿与钓线 */
  const rodBaseX = W - 46, rodBaseY = H - 26;
  const rodTipX = W - 132, rodTipY = H - 208;
  g.strokeStyle = '#4a3826';
  g.lineWidth = 5;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(rodBaseX, rodBaseY);
  g.lineTo(rodTipX, rodTipY);
  g.stroke();
  g.strokeStyle = '#6b5236';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(rodBaseX - 12, rodBaseY + 4);
  g.lineTo(rodBaseX + 12, rodBaseY + 4);
  g.stroke();

  /* 钓线与浮标 */
  const fx = W * 0.52;
  const fy = HOR + 86 + Math.sin(t * 2.2) * 3 + floatDip * 16;
  g.strokeStyle = 'rgba(60,44,30,.72)';
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(rodTipX, rodTipY);
  g.quadraticCurveTo((rodTipX + fx) / 2 + 10, fy - 30, fx, fy - 7);
  g.stroke();

  /* 水花 */
  if (splashAt >= 0) {
    const dt = t - splashAt;
    if (dt < 0.9) {
      g.strokeStyle = 'rgba(255,255,255,' + (0.75 - dt * 0.8).toFixed(3) + ')';
      g.lineWidth = 2;
      g.beginPath();
      g.ellipse(fx, fy, 8 + dt * 46, 3 + dt * 12, 0, 0, Math.PI * 2);
      g.stroke();
    }
  }

  /* 浮标 */
  g.fillStyle = '#e0483c';
  g.beginPath();
  g.arc(fx, fy, 6.5, Math.PI, 0);
  g.fill();
  g.fillStyle = '#fdf6e6';
  g.beginPath();
  g.arc(fx, fy, 6.5, 0, Math.PI);
  g.fill();
  g.strokeStyle = 'rgba(40,30,20,.5)';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(fx - 6.5, fy);
  g.lineTo(fx + 6.5, fy);
  g.stroke();

  /* 钓起来的鱼（短暂） */
  if (caughtAt >= 0) {
    const dt = t - caughtAt;
    if (dt < 1.1) {
      const yy = fy - 20 - dt * 90;
      const xx = fx + Math.sin(dt * 9) * 14;
      g.save();
      g.translate(xx, yy);
      g.rotate(Math.sin(dt * 8) * 0.5);
      g.fillStyle = '#8fb8c9';
      g.beginPath();
      g.ellipse(0, 0, 20, 10, 0, 0, Math.PI * 2);
      g.fill();
      g.beginPath();
      g.moveTo(-18, 0);
      g.lineTo(-32, -9);
      g.lineTo(-32, 9);
      g.closePath();
      g.fill();
      g.fillStyle = '#33454f';
      g.beginPath();
      g.arc(12, -2, 2.6, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  }
  if (floatDip > 0) floatDip = Math.max(0, floatDip - 0.02);
}

/** 湖边小铺（一个带棚子的木摊子）。 */
function drawShop(g, x, y, s) {
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  /* 摊子 */
  g.fillStyle = '#8a6a44';
  g.fillRect(0, 26, 96, 54);
  g.fillStyle = '#6f5334';
  g.fillRect(0, 26, 96, 8);
  /* 暖光窗 */
  const win = g.createLinearGradient(0, 40, 0, 74);
  win.addColorStop(0, '#ffd98a');
  win.addColorStop(1, '#e79b3f');
  g.fillStyle = win;
  g.fillRect(10, 40, 30, 30);
  g.strokeStyle = '#5c4529';
  g.lineWidth = 2;
  g.strokeRect(10, 40, 30, 30);
  /* 遮阳棚 */
  g.fillStyle = '#c05a44';
  g.beginPath();
  g.moveTo(-8, 26);
  g.lineTo(104, 26);
  g.lineTo(96, 4);
  g.lineTo(0, 4);
  g.closePath();
  g.fill();
  g.fillStyle = '#f0e2c8';
  for (let i = 0; i < 4; i++) {
    if (i % 2 === 0) continue;
    g.beginPath();
    g.moveTo(-8 + i * 28, 26);
    g.lineTo(0 + i * 28, 4);
    g.lineTo(12 + i * 28, 4);
    g.lineTo(4 + i * 28, 26);
    g.closePath();
    g.fill();
  }
  /* 招牌 */
  g.fillStyle = '#fdf3df';
  g.fillRect(50, 34, 40, 22);
  g.strokeStyle = '#5c4529';
  g.lineWidth = 2;
  g.strokeRect(50, 34, 40, 22);
  g.fillStyle = '#8a5a2b';
  g.font = 'bold 15px "PingFang SC","Microsoft YaHei",sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('小铺', 70, 46);
  /* 灯笼（挂在摊子边） */
  g.fillStyle = '#e0483c';
  g.beginPath();
  g.arc(14, 18, 9, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

/** 岸边的灯笼。 */
function drawLantern(g, x, y, t) {
  g.save();
  /* 灯杆与横臂 */
  g.strokeStyle = '#4a3826';
  g.lineWidth = 4;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(x + 22, y + 74);
  g.lineTo(x + 22, y - 38);
  g.lineTo(x - 2, y - 38);
  g.stroke();
  g.lineWidth = 1.6;
  g.beginPath();
  g.moveTo(x, y - 38);
  g.lineTo(x, y - 17);
  g.stroke();
  /* 暖光 */
  const gl = g.createRadialGradient(x, y, 2, x, y, 66);
  const flick = reduced ? 1 : (0.85 + 0.15 * Math.sin(t * 3.1));
  gl.addColorStop(0, 'rgba(255,206,120,' + (0.5 * flick).toFixed(3) + ')');
  gl.addColorStop(1, 'rgba(255,206,120,0)');
  g.fillStyle = gl;
  g.fillRect(x - 74, y - 74, 148, 148);
  /* 灯身 */
  g.fillStyle = '#e8543f';
  g.beginPath();
  g.ellipse(x, y, 13, 16, 0, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = 'rgba(120,40,30,.55)';
  g.lineWidth = 1.4;
  for (let i = -1; i <= 1; i++) {
    g.beginPath();
    g.ellipse(x, y, 13 - Math.abs(i) * 4, 16, 0, 0, Math.PI * 2);
    g.stroke();
  }
  g.fillStyle = '#f6c46a';
  g.fillRect(x - 6, y - 16, 12, 4);
  g.fillRect(x - 6, y + 12, 12, 4);
  g.restore();
}

/** 动画主循环。 */
function loop(ts) {
  sceneT = ts / 1000;
  drawScene(sceneT);
  updateMeter();
  requestAnimationFrame(loop);
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
    replay: (sd, acts) => {
      const b = (sd && sd.base) || base;
      return { base: b, pub: fold(b, acts || []), moves: (acts || []).slice() };
    },
    hash: (s) => hashState(s.pub),
    view: (s) => ({ base: s.base, pub: publicView(s.pub), moves: (s.moves || []).slice() }),
    validate: (s, act) => {
      const cur = s.pub;
      if (!cur) return { ok: false, reason: '还没准备好' };
      if (!act || (act.act !== 'cast' && act.act !== 'reel' && act.act !== 'miss')) {
        return { ok: false, reason: '非法动作' };
      }
      /* 房主是 0 号座位，加入方是 1 号 —— 不能替对方操作 */
      const expectSeat = localApply ? 0 : 1;
      if (act.seat !== expectSeat) return { ok: false, reason: '不能替对方操作' };
      if (act.act === 'cast') {
        if (!canCast(cur, act.seat)) return { ok: false, reason: '现在不能抛竿' };
        castRecvAt[act.seat] = Date.now();
        return true;
      }
      if (!isPending(cur, act.seat)) return { ok: false, reason: '现在没有鱼在咬钩' };
      const p = pendingPlan(cur, act.seat);
      if (act.act === 'reel') {
        const dt = Number(act.dt);
        if (!Number.isFinite(dt)) return { ok: false, reason: '收竿时间不对' };
        if (dt < -200 || dt > p.window + 3000) return { ok: false, reason: '收竿时间离谱了' };
        /* 房主拿本机观测到的时间做一次自洽性核对：
           房主收到抛竿到收到收竿，最多也就「延迟 + dt + 网络抖动」。 */
        const since = Date.now() - (castRecvAt[act.seat] || Date.now());
        const est = since - p.delay - 120;
        if (dt > est + 1500) return { ok: false, reason: '收竿时间跟本机观测对不上' };
      }
      return true;
    },
  });

  /**
   * 加入方收到权威状态。
   * 关键：**不采信房主广播的局面，自己重放一遍。**
   * 鱼群、延迟、窗口全是公开种子推导出来的，加入方完全有能力自己算出
   * 「这一局应该是什么样」；房主广播的局面跟自己算的对不上 —— 那就是房主在撒谎。
   */
  const applyState = (s) => {
    if (!s) return;
    const moves = s.moves || [];

    /* 种子双方都能自己算出来（房间号 / 日期派生）——房主要是换种子，一眼就能看出来 */
    const expect = expectedSeeds();
    if (expect && s.base && expect.indexOf(s.base.seed) < 0) {
      setMsg('房主换了对局的种子 —— 他可能在作弊', 'bad');
      return;
    }
    /* 房主不能截断我的动作 —— 我提交过的每一步都必须原封不动地出现在动作序列里 */
    if (moves.length === 0) mySubmitted = [];   /* 房主重开了一局 */
    if (mySubmitted.length) {
      let idx = -1;
      let missing = null;
      for (const mine of mySubmitted) {
        const at = moves.findIndex((m, k) => k > idx &&
          m.act === mine.act && m.seat === mine.seat &&
          (mine.act !== 'reel' || Math.abs(Number(m.dt) - Number(mine.dt)) < 1));
        if (at < 0) { missing = mine; break; }
        idx = at;
      }
      if (missing) {
        setMsg('房主改了我收竿的某一步 —— 他在作弊', 'bad');
        return;
      }
    }
    const b = s.base || base;
    const mine = fold(b, moves);
    if (s.pub && hashState(s.pub) !== hashState(mine)) {
      setMsg('房主发的局面跟你自己算的对不上 —— 他可能在作弊', 'bad');
    }
    /* 加入方也记一份动作序列（房主广播过来的），方便核对与调试 */
    if (authority) authority.actions = moves.slice();
    lastBase = b;
    /* 本地 base 跟着房主走（鱼竿等级、是不是今日之湖，都以房主的为准） */
    base = Object.assign({}, b);
    st = mine;
    afterState();
    render();
  };
  authority.onState(applyState);
  authority.onLocalState((s) => {
    if (!s || !s.pub) return;
    if (s.base) lastBase = s.base;
    st = s.pub;
    afterState();
    render();
  });
  authority.onReject((reason) => {
    setMsg('房主驳回了这一手：' + (reason || '不合法'), 'bad');
  });
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
    session = new P2PSession({ role: 'host', gameId: 'fishing', name: '房主' });
    setupAuthority();
    session.on('status', (stt, text) => {
      p2pState(text || stt, stt === 'open' ? 'ok' : stt === 'failed' ? 'err' : 'wait');
      if (stt === 'open') { $('rolebar').hidden = true; $('btn-close').hidden = false; mySeat = 0; newGame(); }
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
    session = new P2PSession({ role: 'guest', gameId: 'fishing', name: '加入方' });
    setupAuthority();
    session.on('status', (stt, text) => {
      p2pState(text || stt, stt === 'open' ? 'ok' : stt === 'failed' ? 'err' : 'wait');
      if (stt === 'open') { $('rolebar').hidden = true; $('btn-close').hidden = false; mySeat = 1; newGame(); }
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
  mySeat = 0;
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

/* =============================================================================
 * 启动段（所有 DOM 查询都在这里）
 * ========================================================================== */
function bindEvents() {
  $('btn-cast').addEventListener('click', doCast);
  $('btn-reel').addEventListener('click', () => doReel());
  $('btn-sell').addEventListener('click', () => {
    const total = (save.basket || []).reduce((a, f) => a + f.value, 0);
    if (total <= 0) { setMsg('鱼篓是空的', 'dim'); return; }
    save.coin += total;
    save.basket = [];
    persist();
    setMsg('卖了 ' + total + ' 金币，去鱼竿铺看看？', 'ok');
    render();
  });
  $('btn-new').addEventListener('click', newGame);
  $('btn-info').addEventListener('click', () => { $('info').hidden = false; });
  $('info-close').addEventListener('click', () => { $('info').hidden = true; });

  $('mode-solo').addEventListener('click', () => {
    mode = 'solo';
    $('mode-solo').classList.add('on');
    $('mode-daily').classList.remove('on');
    $('mode-p2p').classList.remove('on');
    $('p2p').hidden = true;
    newGame();
  });
  $('mode-daily').addEventListener('click', () => {
    mode = 'daily';
    $('mode-daily').classList.add('on');
    $('mode-solo').classList.remove('on');
    $('mode-p2p').classList.remove('on');
    $('p2p').hidden = true;
    newGame();
  });
  $('mode-p2p').addEventListener('click', () => {
    mode = 'p2p';
    $('mode-p2p').classList.add('on');
    $('mode-solo').classList.remove('on');
    $('mode-daily').classList.remove('on');
    $('p2p').hidden = false;
    newGame();
  });

  $('btn-host').addEventListener('click', () => { $('host-flow').hidden = false; $('guest-flow').hidden = true; });
  $('btn-join').addEventListener('click', () => { $('guest-flow').hidden = false; $('host-flow').hidden = true; });
  $('p2p-daily').addEventListener('change', () => {
    /* 房主改了湖的种类要重开一局；加入方跟着房主走，不用自己改 */
    if (mode === 'p2p' && session && session.isHost) newGame();
  });
  $('btn-gen-host').addEventListener('click', genHostCode);
  $('btn-gen-guest').addEventListener('click', genGuestCode);
  $('btn-accept').addEventListener('click', acceptJoinCode);
  $('btn-close').addEventListener('click', closeSession);
  $('btn-copy-host').addEventListener('click', () => copyTo($('host-code'), $('btn-copy-host')));
  $('btn-copy-guest').addEventListener('click', () => copyTo($('guest-code'), $('btn-copy-guest')));
}

function boot() {
  save = loadSave();
  try {
    reduced = !!(globalThis.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (e) { reduced = false; }

  bindEvents();

  const support = checkSupport();
  if (!support.ok) setMsg(support.reason, 'bad');

  newGame();
  drawScene(0);
  if (!reduced) {
    requestAnimationFrame(loop);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
