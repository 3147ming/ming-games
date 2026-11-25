/* =============================================================================
 * slicer/src/main.mjs —— 切片大师主控
 * -----------------------------------------------------------------------------
 * 三种模式：
 *   solo   单人（随机种子）
 *   daily  每日一局（日期派生 seed，同一天所有人出现序列一致）
 *   p2p    纯 P2P 联机（零服务器，手动交换两段连接码）
 *
 * ---------------------------------------------------------------------------
 * 这个游戏接纯 P2P 的核心难点：**轨迹是连续像素数据，不是离散动作。**
 *
 * 飞行棋那边传的是「走了第几颗棋子」这种离散动作；
 * 这里传的是一整条划过轨迹（几十个浮点坐标点），有两个麻烦：
 *   ① 体积大、天然增量 —— 塞进权威动作序列不合适；
 *   ② **结算必须两端一致** —— 冰冻减速、磁铁吸引这类效果依赖「之前发生过什么」，
 *      如果轨迹乱序到达，两端算出来的位置就会不一样，分数必然对不上。
 *
 * 解法（详见 src/rules.mjs 开头）：
 *   · 轨迹走**独立增量消息** {t:'slicer-stroke'}，不进权威动作序列；
 *   · 结算 = evaluate(seed, 轨迹集合)，是个**纯函数** —— 只依赖集合、
 *     不依赖到达顺序，所以两端最终分数必然一致；
 *   · 房主广播的权威状态里**只有轨迹摘要**（id + 帧 + 座位 + 坐标哈希），没有坐标；
 *   · 房主敢删你的轨迹 → 你会发现「我这一刀不在房主的记录里」；
 *     房主敢改分数 → 你自己按轨迹重算一遍，对不上当场报出来。
 *
 * 联机状态同步用「房主权威」模型（见 src/net/p2p.js 的 HostAuthority）。
 *
 * 纪律：模块顶层不查 DOM（都在文件末尾的启动段里）；localStorage 全程 try/catch。
 * ========================================================================== */

import {
  TICK_MS, ROUND_FRAMES, VW, VH,
  T_FRUIT, T_BOMB, T_ICE, T_MAGNET,
  FRUIT_KINDS, BOMB_PENALTY, MAX_BOMBS, ICE_POINTS, MAGNET_POINTS,
  FREEZE_FRAMES, MAGNET_FRAMES, MAGNET_RANGE, MAX_COMBO_MULT,
  fnv1a, randomSeed, dateKey, dailySeed, seedFromRoom,
  scheduleOf, visibleObjects, objPos, densify, segmentsOf, segCircleHit,
  comboMult, gradeOf, normalizeStroke, canonicalStrokes, evaluate,
  initState, applyAction, fold, replay, hashState, publicView, strokeDigest,
} from './rules.mjs';
import { P2PSession, HostAuthority, checkSupport } from '../../src/net/p2p.js';

const $ = (id) => document.getElementById(id);

/* ---- 全局状态 ---- */
let mode = 'solo';                 /* solo | daily | p2p */
let seed = randomSeed();
let st = initState(seed);
let session = null;
let authority = null;
let playing = false;
let roundOver = false;

/* 时钟：逻辑帧由锚点推进 */
let frameAnchor = 0;
let anchorTime = 0;
let paused = false;

/* 轨迹（表现层用） */
let trail = [];                    /* 正在划的那条 */
let trails = [];                   /* 已划完、正在淡出的轨迹 */
let debris = [];                   /* 被切开的两半（纯表现） */
let floaters = [];                 /* 飘字 */

/* P2P */
let mySubmitted = [];              /* 我发出去过的轨迹（用来核对房主有没有删） */
let strokeSeq = 0;
let hostClockTimer = null;
let lastBarAt = 0;

const reduceMotion = (typeof matchMedia === 'function')
  ? matchMedia('(prefers-reduced-motion: reduce)').matches : false;

/* 调试钩子（端到端测试用） */
globalThis.__SLICER__ = {
  get st() { return st; },
  get mode() { return mode; },
  get seed() { return seed; },
  get frame() { return frameNow(); },
  get score() { return st.summary.score; },
  get bestCombo() { return st.summary.bestCombo; },
  get bombs() { return st.summary.bombs; },
  get over() { return roundOver; },
  get playing() { return playing; },
  get summary() { return st.summary; },
  get strokes() {
    return st.strokes.map((s) => ({ id: s.id, frame: s.frame, seat: s.seat, pts: s.pts.map((p) => [p[0], p[1]]) }));
  },
  get session() { return session; },
  get authority() { return authority; },
  objects: () => visibleObjects(seed, frameNow(), st.summary),
  act: (stroke) => submitStroke(stroke),
  pause: () => { paused = true; },
  resume: () => { paused = false; },
  seek: (f) => { setFrame(f); },
  setSeed: (s) => { seed = s >>> 0; st = initState(seed); },
  endNow: () => { setFrame(ROUND_FRAMES + 1); },
  clientOf: (vx, vy) => clientOf(vx, vy),
};

/* =============================================================================
 * 时钟
 * ========================================================================== */
function now() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

/** 当前逻辑帧。 */
function frameNow() {
  if (paused) return frameAnchor;
  return frameAnchor + Math.floor((now() - anchorTime) / TICK_MS);
}

/** 把逻辑帧拨到 f（重设锚点）。 */
function setFrame(f) {
  frameAnchor = Math.max(0, Math.floor(f));
  anchorTime = now();
}

/** 剩余秒数。 */
function timeLeft() {
  return Math.max(0, Math.ceil((ROUND_FAMES_SAFE() - frameNow()) / (1000 / TICK_MS)));
}
function ROUND_FAMES_SAFE() { return ROUND_FRAMES; }

/* =============================================================================
 * 坐标
 * ========================================================================== */
let cv = null, ctx = null;

function toVirtual(e) {
  const rect = cv.getBoundingClientRect();
  if (!rect.width || !rect.height) return [0, 0];
  return [(e.clientX - rect.left) / rect.width * VW, (e.clientY - rect.top) / rect.height * VH];
}

/** 虚拟坐标 → 客户端坐标（给测试用）。 */
function clientOf(vx, vy) {
  const rect = cv.getBoundingClientRect();
  return { x: rect.left + vx / VW * rect.width, y: rect.top + vy / VH * rect.height };
}

/* =============================================================================
 * 回合
 * ========================================================================== */
function newRound(newSeed) {
  if (newSeed != null) seed = newSeed >>> 0;
  st = initState(seed);
  mySubmitted = [];
  strokeSeq = 0;
  playing = true;
  roundOver = false;
  trail = [];
  trails = [];
  debris = [];
  floaters = [];
  setFrame(0);
  render();
  setMsg(mode === 'daily'
    ? '每日一局 · 今天的出现序列跟所有人一样'
    : (mode === 'p2p' ? '联机局 · 一起切，看谁手快' : '按住屏幕划过水果，把它切开'));
}

/* =============================================================================
 * 提交一条轨迹
 * ========================================================================== */
function submitStroke(stroke) {
  if (!playing || roundOver) return null;
  const raw = stroke || {};
  if (!raw.id) raw.id = String(mySeat() + '-' + (++strokeSeq));
  const s = normalizeStroke(raw);
  if (!s) return null;

  if (mode === 'p2p' && session && session.isOpen) {
    if (session.isHost) {
      /* 房主：本地权威结算 + 把坐标发给加入方（独立通道） */
      if (authority) authority.applyLocal(s);
      session.send({ t: 'slicer-stroke', stroke: s });
      mySubmitted.push(s);
    } else {
      /* 加入方：坐标走独立通道发给房主；本地也先算一份，等房主的记录补齐后自动收敛 */
      mySubmitted.push(s);
      session.send({ t: 'slicer-stroke', stroke: s });
      applyLocal(s);
    }
    return s;
  }
  applyLocal(s);
  return s;
}

/** 本地结算一条轨迹。 */
function applyLocal(s) {
  st = applyAction(st, s);
  afterStroke(s);
  if (st.over && !roundOver) endRound();
  render();
}

/** 一刀之后的反馈（飘字、碎片）。 */
function afterStroke(s) {
  const ev = st.summary.events[st.summary.events.length - 1];
  if (!ev || !ev.hitIds.length) return;
  if (!reduceMotion) {
    /* 用「不带已切集合」的上下文取物体位置 —— 被切的那几个还在列表里 */
    const objs = visibleObjects(seed, s.frame, {
      freezes: st.summary.freezes, magnetWins: st.summary.magnetWins,
    });
    for (const id of ev.hitIds) {
      const o = objs.find((x) => x.id === id);
      if (!o) continue;
      const col = o.type === T_BOMB ? '#33384a' : (o.type === T_ICE ? '#48b8e8' : (o.type === T_MAGNET ? '#f4c542' : o.color));
      for (let k = 0; k < 2; k++) {
        debris.push({
          x: o.x, y: o.y, vx: (k ? 1 : -1) * (0.5 + Math.abs(s.pts[0][0] - o.x) * 0.04),
          vy: -0.5, rot: 0, vr: (k ? 1 : -1) * 0.25, r: o.r, color: col, kind: o.kind, life: 1,
        });
      }
    }
  }
  if (ev.fruitCount >= 2) {
    floaters.push({ x: 50, y: 38, text: '连击 x' + ev.fruitCount + '  ×' + ev.mult.toFixed(1), life: 1, big: true });
  } else if (ev.gained > 0) {
    floaters.push({ x: 50, y: 46, text: '+' + ev.gained, life: 1, big: false });
  }
  if (ev.penalty > 0) {
    floaters.push({ x: 50, y: 46, text: '炸弹 -' + ev.penalty, life: 1, big: false, bad: true });
  }
}

/* =============================================================================
 * 结束
 * ========================================================================== */
function endRound() {
  if (roundOver) return;
  roundOver = true;
  playing = false;
  if (mode === 'p2p' && session && session.isOpen) {
    if (session.isHost) {
      stopHostClock();
      session.send({
        t: 'slicer-final',
        seed: seed,
        score: st.summary.score,
        bestCombo: st.summary.bestCombo,
        bombs: st.summary.bombs,
        grade: st.summary.grade,
        count: (st.strokes || []).length,
      });
    } else {
      /* 加入方等房主的权威结算（分数要跟房主一模一样） */
      setMsg('等待房主结算…', 'dim');
      render();
      return;
    }
  }
  saveResult();
  showResult();
  render();
}

/* =============================================================================
 * 渲染
 * ========================================================================== */
function render() {
  renderBar();
  draw();
}

function renderBar() {
  const sum = st.summary;
  $('score').textContent = sum.score;
  $('time').textContent = timeLeft();
  $('combo').textContent = sum.bestCombo + ' ×' + comboMult(sum.bestCombo).toFixed(1);
  $('bombs').textContent = sum.bombs + '/' + MAX_BOMBS;
  $('bombs').style.color = sum.bombs > 0 ? '#b8322a' : '';
  const hint = $('hint');
  if (roundOver) hint.textContent = '本局结束，点「再来一局」。';
  else if (!playing) hint.textContent = '点「开局」开始。';
  else if (mode === 'p2p') hint.textContent = '按住并划过水果 —— 别切到炸弹。';
  else hint.textContent = '按住并划过水果 —— 一次划过切中越多，连击倍率越高。';
}

function draw() {
  if (!ctx) return;
  const W = cv.width, H = cv.height;
  const S = W / VW;
  ctx.clearRect(0, 0, W, H);

  /* ---- 背景：暖色桌面 ---- */
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#f8f0df');
  bg.addColorStop(1, '#e7d9bd');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(150,120,70,.08)';
  ctx.lineWidth = 1;
  for (let y = 40; y < H; y += 60) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  const f = frameNow();
  const sum = st.summary;

  /* ---- 冰冻 / 磁铁 的画面提示 ---- */
  if ((sum.freezes || []).some((w) => f >= w.s && f <= w.e)) {
    ctx.fillStyle = 'rgba(80,170,220,.16)';
    ctx.fillRect(0, 0, W, H);
  }
  for (const m of (sum.magnetWins || [])) {
    if (f < m.s || f > m.e) continue;
    const g2 = ctx.createRadialGradient(m.x * S, m.s * S, 4, m.x * S, m.s * S, MAGNET_RANGE * S);
    g2.addColorStop(0, 'rgba(244,197,66,.20)');
    g2.addColorStop(1, 'rgba(244,197,66,0)');
    ctx.fillStyle = g2;
    ctx.fillRect(0, 0, W, H);
  }

  /* ---- 物体 ---- */
  if (playing && !roundOver) {
    const objs = visibleObjects(seed, f, sum);
    for (const o of objs) drawObject(o, S);
  }

  /* ---- 碎片 ---- */
  for (const d of debris) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, d.life);
    ctx.translate(d.x * S, d.y * S);
    ctx.rotate(d.rot);
    ctx.beginPath();
    ctx.arc(0, 0, d.r * S * 0.92, -Math.PI / 2, Math.PI / 2);
    ctx.closePath();
    ctx.fillStyle = d.color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.15)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  /* ---- 轨迹 ---- */
  const nowT = now();
  for (const t of trails) {
    const age = (nowT - t.t) / 420;
    if (age > 1) continue;
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - age);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,.9)';
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(t.pts[0][0] * S, t.pts[0][1] * S);
    for (let i = 1; i < t.pts.length; i++) ctx.lineTo(t.pts[i][0] * S, t.pts[i][1] * S);
    ctx.stroke();
    ctx.strokeStyle = '#ff8a3d';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.restore();
  }
  if (trail.length > 1) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,.95)';
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(trail[0][0] * S, trail[0][1] * S);
    for (let i = 1; i < trail.length; i++) ctx.lineTo(trail[i][0] * S, trail[i][1] * S);
    ctx.stroke();
    ctx.strokeStyle = '#e0483c';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.restore();
  }

  /* ---- 飘字 ---- */
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const fl of floaters) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, fl.life);
    ctx.fillStyle = fl.bad ? '#b8322a' : (fl.big ? '#c8912f' : '#2a2118');
    ctx.font = fl.big ? 'bold 34px "PingFang SC","Microsoft YaHei",sans-serif'
      : 'bold 24px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillText(fl.text, fl.x * S, fl.y * S);
    ctx.restore();
  }

  /* ---- 结束遮罩 ---- */
  if (roundOver) {
    ctx.fillStyle = 'rgba(42,33,24,.28)';
    ctx.fillRect(0, 0, W, H);
  }
}

/** 画一个物体。 */
function drawObject(o, S) {
  const x = o.x * S, y = o.y * S, r = o.r * S;
  ctx.save();
  /* 影子 */
  ctx.beginPath();
  ctx.ellipse(x, y + r * 0.72, r * 0.9, r * 0.28, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,.08)';
  ctx.fill();
  if (o.type === T_BOMB) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#33384a';
    ctx.fill();
    ctx.strokeStyle = '#1b1e29';
    ctx.lineWidth = Math.max(2, r * 0.16);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x - r * 0.32, y - r * 0.34, r * 0.24, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,.32)';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.quadraticCurveTo(x + r * 0.5, y - r * 1.5, x + r * 0.15, y - r * 1.85);
    ctx.strokeStyle = '#8a6a3a';
    ctx.lineWidth = Math.max(2, r * 0.14);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x + r * 0.15, y - r * 1.9, r * 0.22, 0, Math.PI * 2);
    ctx.fillStyle = '#ffb03a';
    ctx.fill();
  } else if (o.type === T_ICE) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    const gg = ctx.createRadialGradient(x - r * 0.3, y - r * 0.4, r * 0.1, x, y, r);
    gg.addColorStop(0, '#d8f4ff');
    gg.addColorStop(1, '#48b8e8');
    ctx.fillStyle = gg;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1.5, r * 0.12);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - r * 0.5, y - r * 0.2);
    ctx.lineTo(x + r * 0.1, y + r * 0.1);
    ctx.lineTo(x - r * 0.2, y + r * 0.6);
    ctx.strokeStyle = 'rgba(255,255,255,.75)';
    ctx.lineWidth = Math.max(1, r * 0.1);
    ctx.stroke();
  } else if (o.type === T_MAGNET) {
    star(ctx, x, y, r * 1.15, r * 0.5, 5);
    ctx.fillStyle = '#f4c542';
    ctx.fill();
    ctx.strokeStyle = '#d09b1d';
    ctx.lineWidth = Math.max(1.5, r * 0.12);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    const gg = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r);
    gg.addColorStop(0, lighten(o.color, 0.35));
    gg.addColorStop(1, o.color);
    ctx.fillStyle = gg;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.18)';
    ctx.lineWidth = Math.max(1.5, r * 0.09);
    ctx.stroke();
    if (o.kind === 0) {                 /* 西瓜条纹 */
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, r * 0.98, 0, Math.PI * 2);
      ctx.clip();
      ctx.strokeStyle = 'rgba(30,60,30,.55)';
      ctx.lineWidth = Math.max(2, r * 0.14);
      for (let k = -2; k <= 2; k++) {
        ctx.beginPath();
        ctx.moveTo(x + k * r * 0.42 - r, y - r * 1.2);
        ctx.lineTo(x + k * r * 0.42 + r, y + r * 1.2);
        ctx.stroke();
      }
      ctx.restore();
    }
    if (o.kind === 1) {                 /* 草莓籽 */
      ctx.fillStyle = 'rgba(255,255,255,.6)';
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(x + Math.cos(a) * r * 0.45, y + Math.sin(a) * r * 0.45, Math.max(1, r * 0.08), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (o.kind === 2 || o.kind === 3 || o.kind === 4) {   /* 叶子 */
      ctx.beginPath();
      ctx.ellipse(x + r * 0.36, y - r * 0.92, r * 0.36, r * 0.17, -0.5, 0, Math.PI * 2);
      ctx.fillStyle = '#4f9a48';
      ctx.fill();
    }
  }
  ctx.restore();
}

/** 五角星。 */
function star(g, cx, cy, R, r, points) {
  g.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const rad = i % 2 === 0 ? R : r;
    const a = -Math.PI / 2 + i * Math.PI / points;
    const px = cx + Math.cos(a) * rad, py = cy + Math.sin(a) * rad;
    if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
  }
  g.closePath();
}

function lighten(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, gg = (n >> 8) & 255, b = n & 255;
  r = Math.round(r + (255 - r) * amt);
  gg = Math.round(gg + (255 - gg) * amt);
  b = Math.round(b + (255 - b) * amt);
  return 'rgb(' + r + ',' + gg + ',' + b + ')';
}

/* =============================================================================
 * 主循环
 * ========================================================================== */
function loop() {
  requestAnimationFrame(loop);
  const dt = 1 / 60;
  if (!reduceMotion) {
    for (const d of debris) {
      d.vy += 0.06;
      d.x += d.vx * dt * 12;
      d.y += d.vy * dt * 12;
      d.rot += d.vr;
      d.life -= 0.012;
    }
    debris = debris.filter((d) => d.life > 0 && d.y < VH + 20);
    for (const fl of floaters) { fl.y -= dt * 12; fl.life -= 0.016; }
    floaters = floaters.filter((fl) => fl.life > 0);
    const nt = now();
    trails = trails.filter((t) => (nt - t.t) / 420 <= 1);
  }
  if (playing && !roundOver && frameNow() >= ROUND_FRAMES) endRound();
  const nt2 = now();
  if (playing && nt2 - lastBarAt > 120) { lastBarAt = nt2; renderBar(); }
  draw();
}

/* =============================================================================
 * 输入
 * ========================================================================== */
function bindInput() {
  cv.addEventListener('pointerdown', (e) => {
    if (!playing || roundOver) return;
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    trail = [toVirtual(e)];
    e.preventDefault();
  });
  cv.addEventListener('pointermove', (e) => {
    if (!trail.length) return;
    const p = toVirtual(e);
    const last = trail[trail.length - 1];
    if (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) < 0.15) return;
    trail.push(p);
    e.preventDefault();
  });
  const finish = (e) => {
    if (!trail.length) return;
    const pts = trail.slice();
    trail = [];
    if (!reduceMotion) trails.push({ pts: pts, t: now() });
    submitStroke({ act: 'stroke', id: '', frame: frameNow(), seat: mySeat(), pts: pts });
    if (e && e.preventDefault) e.preventDefault();
  };
  cv.addEventListener('pointerup', finish);
  cv.addEventListener('pointercancel', () => { trail = []; });
}

/* =============================================================================
 * 消息条
 * ========================================================================== */
function setMsg(text, cls) {
  const el = $('msg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'msg' + (cls ? ' ' + cls : '');
}

/* =============================================================================
 * 成绩（localStorage，全程 try/catch）
 * ========================================================================== */
const SAVE_KEY = 'mg_slicer.v1';
function loadSave() {
  const empty = { best: 0, bestCombo: 0, coins: 0, dailyDate: '', dailyBest: 0, dailySeed: 0 };
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return empty;
    const o = JSON.parse(raw);
    return {
      best: o.best || 0,
      bestCombo: o.bestCombo || 0,
      coins: o.coins || 0,
      dailyDate: o.dailyDate || '',
      dailyBest: o.dailyBest || 0,
      dailySeed: o.dailySeed || 0,
    };
  } catch (e) {
    return empty;
  }
}
function writeSave(o) {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(o)); } catch (e) { /* file:// 下可能抛 */ }
}
function renderSave() {
  const s = loadSave();
  $('best').textContent = s.best;
  $('coins').textContent = s.coins;
  $('daily-best').textContent = s.dailyBest;
  $('daily-seed').textContent = s.dailySeed || dailySeed(dateKey());
}
function saveResult() {
  const s = loadSave();
  const sum = st.summary;
  s.coins += Math.max(0, Math.floor(sum.score / 10));
  if (sum.score > s.best) s.best = sum.score;
  if (sum.bestCombo > s.bestCombo) s.bestCombo = sum.bestCombo;
  const dk = dateKey();
  if (s.dailyDate !== dk) { s.dailyDate = dk; s.dailySeed = dailySeed(dk); s.dailyBest = 0; }
  if (mode === 'daily' && sum.score > s.dailyBest) s.dailyBest = sum.score;
  writeSave(s);
  renderSave();
}

/* =============================================================================
 * 结算面板
 * ========================================================================== */
function showResult() {
  const sum = st.summary;
  $('over-grade').textContent = sum.grade;
  $('over-grade').className = 'grade g' + sum.grade;
  $('over-score').textContent = sum.score;
  $('over-combo').textContent = sum.bestCombo;
  $('over-fruit').textContent = sum.fruits;
  $('over-bombs').textContent = sum.bombs;
  $('over-seed').textContent = seed;
  $('over').hidden = false;
}

/* =============================================================================
 * 纯 P2P
 * ========================================================================== */
function mySeat() {
  if (mode === 'p2p' && session) return session.isHost ? 0 : 1;
  return 0;
}

/**
 * 联机用的摘要哈希。
 * 两边算的是同一份东西：种子 + 轨迹摘要 + 结算数字。
 * 房主少报一条轨迹 → 摘要不同 → 加入方立刻发现。
 */
function wireHash(s) {
  const list = (s.strokes || []);
  const digests = list.map((x) => (x.h != null ? x.id + ':' + x.h : x.id + ':' + strokeDigest(x).h));
  const sum = s.summary || s;
  return fnv1a([s.seed, digests.join(','), sum.score, sum.bestCombo, sum.bombs].join('|'));
}

function p2pState(text, cls) {
  const el = $('p2p-state');
  if (!el) return;
  el.textContent = text;
  el.className = 'p2p-state ' + (cls || 'wait');
}

function setupAuthority() {
  if (!session) return;
  authority = new HostAuthority(session, {
    reduce: (s, acts) => {
      const all = (s.strokes || []).concat(acts);
      return { seed: s.seed, strokes: canonicalStrokes(all), summary: evaluate(s.seed, all) };
    },
    replay: (seed0, acts) => {
      const list = canonicalStrokes(acts || []);
      return { seed: seed0 >>> 0, strokes: list, summary: evaluate(seed0, list) };
    },
    hash: (s) => wireHash(s),
    view: (s) => {
      const pv = publicView({
        seed: s.seed, strokes: s.strokes || [], summary: s.summary,
        over: false, rngCount: scheduleOf(s.seed).length,
      });
      /* 广播里只有轨迹摘要，没有坐标本身 —— 像素数据走独立通道 */
      return {
        seed: pv.seed,
        strokes: pv.strokes.map(strokeDigest),
        summary: {
          score: pv.summary.score, bestCombo: pv.summary.bestCombo,
          bombs: pv.summary.bombs, over: !!pv.summary.over,
        },
        frame: frameNow(),
      };
    },
    validate: (s, act) => {
      const cur = s.pub || s;
      if (!cur) return { ok: false, reason: '还没准备好' };
      const ns = normalizeStroke(act);
      if (!ns) return { ok: false, reason: '非法轨迹' };
      if (ns.frame < 0 || ns.frame > ROUND_FRAMES + 600) return { ok: false, reason: '轨迹的帧号不对' };
      if (ns.seat !== 0 && ns.seat !== 1) return { ok: false, reason: '座位号不对' };
      for (const x of (cur.strokes || [])) if (x.id === ns.id) return { ok: false, reason: '重复的轨迹 id' };
      return true;
    },
  });

  /* 房主本地状态推进 */
  authority.onLocalState((s) => {
    st = {
      seed: s.seed,
      strokes: s.strokes || [],
      summary: s.summary,
      over: !!(s.summary && s.summary.over),
      rngCount: scheduleOf(s.seed).length,
    };
    const last = (s.strokes || [])[(s.strokes || []).length - 1];
    if (last) afterStroke(last);
    if (st.over && !roundOver) endRound();
    render();
  });

  /**
   * 加入方收到房主的权威状态。
   *
   * 关键：**不采信房主广播的分数**，自己按轨迹重放一遍
   * （fold + replay），对不上就当场报出来。
   */
  authority.onState((s) => {
    if (!s) return;
    const expectSeed = (session && session.roomId) ? seedFromRoom(session.roomId, 'slicer') : null;
    if (expectSeed != null && s.seed !== expectSeed) {
      setMsg('房主换了对局的种子 —— 他可能在作弊', 'bad');
      return;
    }
    const ids = new Set((s.strokes || []).map((d) => d.id));
    for (const mine of mySubmitted) {
      if (!ids.has(mine.id)) {
        setMsg('房主删了我的一刀 —— 他可能在作弊', 'bad');
        return;
      }
    }
    /* 我是不是少收了轨迹？少了就补要 */
    const have = new Set(st.strokes.map((x) => x.id));
    const missing = (s.strokes || []).filter((d) => !have.has(d.id)).map((d) => d.id);
    if (missing.length) {
      session.send({ t: 'slicer-need', ids: missing });
    } else {
      /* 轨迹齐了 —— 自己重放一遍，跟房主报的分数对一对 */
      const mine = fold({ seed: seed }, st.strokes).summary.score;
      if (s.summary && s.summary.score != null && s.summary.score !== mine) {
        setMsg('房主报的分数跟轨迹算出来的对不上 —— 他可能在作弊', 'bad');
      }
    }
    render();
  });

  authority.onReject((reason) => {
    setMsg('房主驳回了这一刀：' + (reason || '不合法'), 'bad');
  });

  /* 其它协议消息（轨迹 / 时钟 / 结算）—— 都在独立通道上，不走权威动作序列 */
  session.on('message', (m) => {
    if (!m) return;
    if (m.t === 'slicer-stroke') {
      const s = normalizeStroke(m.stroke);
      if (!s) return;
      if (!session.isHost) {
        /* 加入方：本地先算一份，等房主的记录补齐后自动收敛 */
        if (!st.strokes.some((x) => x.id === s.id)) {
          st = applyAction(st, s);
          afterStroke(s);
          if (st.over && !roundOver) endRound();
          render();
        }
      } else {
        /* 房主收到加入方的轨迹 → 进权威序列并广播摘要 */
        if (!authority) return;
        const have = (authority.state && authority.state.strokes || []).some((x) => x.id === s.id);
        if (have) return;
        authority.applyLocal(s);
      }
    } else if (m.t === 'slicer-need') {
      if (!session.isHost) return;
      const list = (authority && authority.state && authority.state.strokes) || [];
      if (m.ids === 'all') {
        for (const s of list) session.send({ t: 'slicer-stroke', stroke: s });
      } else {
        const want = new Set(m.ids || []);
        for (const s of list) if (want.has(s.id)) session.send({ t: 'slicer-stroke', stroke: s });
      }
    } else if (m.t === 'slicer-clock') {
      if (session.isHost) return;
      /* 房主的时钟是权威的 —— 加入方跟着走 */
      setFrame(m.frame);
    } else if (m.t === 'slicer-final') {
      if (session.isHost) return;
      handleFinal(m);
    } else if (m.t === 'slicer-start') {
      if (session.isHost) return;
      if (m.seed !== undefined && m.seed !== seed) {
        setMsg('房主发的种子跟算出来的不一样 —— 他可能在作弊', 'bad');
        return;
      }
      setFrame(m.frame || 0);
    }
  });
}

/** 加入方收到房主的最终结算。 */
function handleFinal(m) {
  const mine = fold({ seed: seed }, st.strokes).summary.score;
  if (m.seed !== seed) {
    setMsg('房主结算用的种子不一样 —— 他可能在作弊', 'bad');
    return;
  }
  if (m.score !== mine) {
    /* 大概率是少收了轨迹 → 已经发了 'slicer-need'，补齐后自动收敛 */
    setMsg('结算跟轨迹算出来的不一样，正在补收轨迹…', 'dim');
    if (session) session.send({ t: 'slicer-need', ids: 'all' });
  }
  roundOver = true;
  playing = false;
  saveResult();
  showResult();
  render();
}

async function genHostCode() {
  const pass = $('host-pass') ? $('host-pass').value.trim() : '';
  try {
    p2pState('正在生成房主码…', 'wait');
    session = new P2PSession({ role: 'host', gameId: 'slicer', name: '房主' });
    setupAuthority();
    session.on('status', (stt, text) => {
      p2pState(text || stt, stt === 'open' ? 'ok' : stt === 'failed' ? 'err' : 'wait');
      if (stt === 'open') {
        $('rolebar').hidden = true;
        $('btn-close').hidden = false;
        seed = seedFromRoom(session.roomId, 'slicer');
        newRound(seed);
        if (authority) authority.init(seed);
        session.send({ t: 'slicer-start', seed: seed, frame: 0 });
        startHostClock();
      }
      if (stt === 'closed' || stt === 'failed') {
        stopHostClock();
        setMsg('连接断开了 —— 点「断开连接」后可以重新建一局', 'bad');
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
    session = new P2PSession({ role: 'guest', gameId: 'slicer', name: '加入方' });
    setupAuthority();
    session.on('status', (stt, text) => {
      p2pState(text || stt, stt === 'open' ? 'ok' : stt === 'failed' ? 'err' : 'wait');
      if (stt === 'open') {
        $('rolebar').hidden = true;
        $('btn-close').hidden = false;
        seed = seedFromRoom(session.roomId, 'slicer');
        newRound(seed);
      }
      if (stt === 'closed' || stt === 'failed') {
        setMsg('连接断开了 —— 点「断开连接」后可以重新建一局', 'bad');
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
  } catch (e) {
    p2pState(e.message || '接受失败', 'err');
  }
}

/** 房主定时广播时钟 —— 加入方靠它对齐逻辑帧（画面同步）。 */
function startHostClock() {
  stopHostClock();
  hostClockTimer = setInterval(() => {
    if (mode === 'p2p' && session && session.isOpen && session.isHost) {
      session.send({ t: 'slicer-clock', frame: frameNow() });
    }
  }, 400);
}
function stopHostClock() {
  if (hostClockTimer) { clearInterval(hostClockTimer); hostClockTimer = null; }
}

function closeSession() {
  stopHostClock();
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
  mode = 'solo';
  $('mode-solo').classList.add('on');
  $('mode-p2p').classList.remove('on');
  $('p2p').hidden = true;
  newRound(randomSeed());
}

/* =============================================================================
 * 启动
 * ========================================================================== */
function boot() {
  cv = $('field');
  ctx = cv.getContext('2d');

  $('mode-solo').addEventListener('click', () => {
    mode = 'solo';
    $('mode-solo').classList.add('on');
    $('mode-daily').classList.remove('on');
    $('mode-p2p').classList.remove('on');
    $('p2p').hidden = true;
    newRound(randomSeed());
  });
  $('mode-daily').addEventListener('click', () => {
    mode = 'daily';
    $('mode-daily').classList.add('on');
    $('mode-solo').classList.remove('on');
    $('mode-p2p').classList.remove('on');
    $('p2p').hidden = true;
    const dk = dateKey();
    const s = loadSave();
    const ds = (s.dailyDate === dk && s.dailySeed) ? s.dailySeed : dailySeed(dk);
    newRound(ds);
    setMsg('每日一局 · ' + dk + ' · 种子 ' + ds, 'dim');
  });
  $('mode-p2p').addEventListener('click', () => {
    mode = 'p2p';
    $('mode-p2p').classList.add('on');
    $('mode-solo').classList.remove('on');
    $('mode-daily').classList.remove('on');
    $('p2p').hidden = false;
    newRound(randomSeed());
  });

  $('btn-new').addEventListener('click', () => {
    if (mode === 'daily') newRound(dailySeed(dateKey()));
    else if (mode === 'p2p') newRound(session && session.roomId ? seedFromRoom(session.roomId, 'slicer') : randomSeed());
    else newRound(randomSeed());
  });
  $('over-again').addEventListener('click', () => { $('over').hidden = true; $('btn-new').click(); });
  $('over-close').addEventListener('click', () => { $('over').hidden = true; });
  $('btn-info').addEventListener('click', () => { $('info').hidden = false; });
  $('info-close').addEventListener('click', () => { $('info').hidden = true; });

  $('btn-host').addEventListener('click', () => { $('host-flow').hidden = false; $('guest-flow').hidden = true; });
  $('btn-join').addEventListener('click', () => { $('guest-flow').hidden = false; $('host-flow').hidden = true; });
  $('btn-gen-host').addEventListener('click', genHostCode);
  $('btn-gen-guest').addEventListener('click', genGuestCode);
  $('btn-accept').addEventListener('click', acceptJoinCode);
  $('btn-close').addEventListener('click', closeSession);
  $('btn-copy-host').addEventListener('click', () => copyTo($('host-code'), $('btn-copy-host')));
  $('btn-copy-guest').addEventListener('click', () => copyTo($('guest-code'), $('btn-copy-guest')));

  bindInput();

  const support = checkSupport();
  if (!support.ok) setMsg(support.reason, 'bad');
  renderSave();
  newRound(mode === 'daily' ? dailySeed(dateKey()) : randomSeed());
  requestAnimationFrame(loop);
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
      try { document.execCommand('copy'); done(); } catch (e) { /* ignore */ }
    });
  } else {
    el.select();
    try { document.execCommand('copy'); done(); } catch (e) { /* ignore */ }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
