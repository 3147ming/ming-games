/**
 * 霓虹律动 NEON RHYTHM · UI 层
 * ============================================================================
 * 职责边界（与 music / chart / judge / game 的分工）：
 *   · 本文件是**唯一**碰 DOM、Canvas、localStorage、AudioContext 的地方；
 *   · 判定与谱面全部委托给纯逻辑模块，这里只做"画出来 + 收输入 + 存档"；
 *   · 所有时间都问 `engine.time()`（音频时钟），**不用帧计数**——
 *     这是音游手感的命根子：掉帧时音符该在哪就在哪。
 *
 * 手感约定：
 *   · 输入 → 判定 → 画面反馈 ≤ 1 帧（判定同步做，视觉用 transform 不触发重排）
 *   · 过渡统一 0.12~0.32s / cubic-bezier(.22,.61,.36,1)
 *   · `prefers-reduced-motion` 由 CSS 统一兜底，JS 侧额外关掉拖尾与爆闪
 * ============================================================================
 */

import {
  SONGS, DIFFICULTIES, DIFFICULTY_LABEL, songById, createMusicEngine, LEAD_IN,
} from './music.mjs';
import {
  LANES, chartKey, generateChart, validateChart, APPROACH_BY_DIFFICULTY,
} from './chart.mjs';
import { VERDICT_LABEL, MAX_OFFSET_MS } from './judge.mjs';
import { createGame } from './game.mjs';
import {
  loadScores, saveScores, loadSettings, saveSettings, mergeResult, bestFor,
  emptyScores, summarizeScores, resolveStorage, clearAll, SPEED_PRESETS,
} from './save.mjs';

/* ============================ 小工具 ============================ */

const $ = (id) => document.getElementById(id);
const qs = (sel, root = document) => root.querySelector(sel);
const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const fmtScore = (n) => Math.round(n).toLocaleString('en-US');

const storage = resolveStorage(null);
let scores = loadScores(storage);
let settings = loadSettings(storage);

const prefersReduced = window.matchMedia
  ? matchMedia('(prefers-reduced-motion: reduce)').matches
  : false;

/** 视觉特效开关：系统减弱动效 或 用户手动关掉，都关。 */
const fxOn = () => settings.flash !== false && !prefersReduced;

function haptic(ms) {
  if (!settings.vibrate || prefersReduced) return;
  try { navigator.vibrate && navigator.vibrate(ms); } catch { /* 忽略 */ }
}

/* ============================ 音频 ============================ */

/** 惰性创建 AudioContext：必须等用户手势后才能真正出声。 */
let audioCtx = null;
function ctx() {
  if (audioCtx) return audioCtx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try { audioCtx = new AC(); } catch { audioCtx = null; }
  return audioCtx;
}

function unlockAudio() {
  const c = ctx();
  if (!c) return;
  if (c.state === 'suspended' && c.resume) c.resume().catch(() => {});
}

const engine = createMusicEngine({
  bus: { ctxRef: ctx },
  isMuted: () => settings.muted === true,
  getVolume: () => (settings.muted ? 0 : settings.volume),
  autoTick: true,
});

/* ============================ 屏幕切换 ============================ */

const SCREENS = ['menu', 'select', 'game', 'result'];
let curScreen = 'menu';

function show(name) {
  curScreen = name;
  for (const s of SCREENS) {
    const el = $('screen-' + s);
    if (!el) continue;
    el.classList.toggle('active', s === name);
  }
}

/* ============================ 主菜单 ============================ */

function gradeChips(songId) {
  const out = [];
  for (const d of DIFFICULTIES) {
    const e = bestFor(scores, chartKey(songId, d));
    const cls = e ? ' has g-' + e.grade : '';
    out.push(`<span class="gchip${cls}">${DIFFICULTY_LABEL[d].slice(0, 4)} ${e ? e.grade : '—'}</span>`);
  }
  return out.join('');
}

function renderMenu() {
  const sum = summarizeScores(scores);
  $('menu-stats').innerHTML =
    `<span>已玩 <b>${sum.played}/12</b> 张谱面</span>` +
    `<span>最高分 <b>${fmtScore(sum.bestScore)}</b></span>` +
    `<span>最长连击 <b>${sum.bestCombo}</b></span>`;

  const list = $('song-list');
  list.innerHTML = '';
  for (const s of SONGS) {
    const card = document.createElement('div');
    card.className = 'song-card';
    card.style.setProperty('--c1', s.accent);
    card.style.setProperty('--c2', s.accent2);
    card.innerHTML =
      `<div class="song-ico">${s.titleEn.slice(0, 2)}</div>` +
      `<div class="song-meta">` +
        `<div class="song-title">${s.title}<small>${s.titleEn}</small></div>` +
        `<div class="song-sub">${s.style} · ${s.bpm} BPM · ${s.bars} 小节</div>` +
        `<div class="song-grades">${gradeChips(s.id)}</div>` +
      `</div>`;
    card.addEventListener('click', () => { unlockAudio(); openSelect(s.id); });
    list.appendChild(card);
  }
}

/* ============================ 选难度 ============================ */

let selSongId = null;

function openSelect(songId) {
  selSongId = songId;
  const s = songById(songId);
  show('select');
  $('sel-title').innerHTML =
    `<div class="st" style="color:${s.accent}">${s.title}</div>` +
    `<div class="ss">${s.titleEn} · ${s.style} · ${s.bpm} BPM</div>`;

  const list = $('diff-list');
  list.innerHTML = '';
  for (const d of DIFFICULTIES) {
    const chart = generateChart(songId, d);
    const best = bestFor(scores, chartKey(songId, d));
    const card = document.createElement('div');
    card.className = 'diff-card';
    card.style.setProperty('--c1', s.accent);
    card.innerHTML =
      `<div class="diff-top">` +
        `<span class="diff-name ${d}">${DIFFICULTY_LABEL[d]}</span>` +
        `<span class="diff-num">${chart.notes.length} NOTES · 密度 ${chart.stats.density.toFixed(1)}/s</span>` +
      `</div>` +
      `<div class="diff-detail">${d === 'easy' ? '无长按 · 下落最慢' : d === 'normal' ? '含长按 · 中等密度' : '长按 + 高密度 · 下落最快'}</div>` +
      `<div class="diff-best">` +
        (best
          ? `最佳 <b>${fmtScore(best.score)}</b> · <b>${best.grade}</b> · 连击 <b>${best.maxCombo}</b> · 玩过 ${best.plays} 次`
          : `<span class="nograde">尚未挑战</span>`) +
      `</div>`;
    card.addEventListener('click', () => { unlockAudio(); startGame(songId, d); });
    list.appendChild(card);
  }
}

/* ============================ 局内状态 ============================ */

const game = {
  chart: null,
  g: null,              // createGame 实例
  raf: 0,
  running: false,
  countdownShown: -1,
  lastJudgeId: -1,
  laneFlash: [0, 0, 0, 0],
  pressed: [false, false, false, false],
  startWallMs: 0,
};

const canvas = $('canvas');
const ctx2d = canvas.getContext('2d');

let view = { w: 0, h: 0, dpr: 1, laneW: 0, judgeY: 0, topY: 0 };

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  view.w = w; view.h = h; view.dpr = dpr;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  view.laneW = w / LANES;
  view.judgeY = h - Math.max(78, h * 0.13);
  view.topY = 0;
}

window.addEventListener('resize', () => { if (curScreen === 'game') resize(); });
window.addEventListener('orientationchange', () => { setTimeout(() => { if (curScreen === 'game') resize(); }, 120); });

/* ---------- 开始一局 ---------- */

function startGame(songId, difficulty, practice = false) {
  const chart = generateChart(songId, difficulty);
  const problems = validateChart(chart);
  if (problems.length) {
    // 谱面坏了不能进游戏（宁可不玩也不能让玩家打着打着发现漏音符）
    console.error('[neon] 谱面自检失败：', problems);
    return;
  }

  settings.lastSong = songId;
  settings.lastDifficulty = difficulty;
  saveSettings(storage, settings);

  show('game');
  resize();

  const song = songById(songId);
  engine.load(song);

  game.chart = chart;
  game.g = createGame({
    chart,
    offsetMs: settings.offsetMs,
    practice,
    leadInMs: LEAD_IN * 1000,
  });
  game.countdownShown = -1;
  game.lastJudgeId = -1;
  game.laneFlash = [0, 0, 0, 0];
  game.pressed = [false, false, false, false];

  paintHud(true);
  $('hud-judge').className = 'hud-judge';
  $('pause-mask').hidden = true;

  // 起播：必须在用户手势的同一个调用栈里
  unlockAudio();
  engine.start();
  game.g.begin(0);
  game.startWallMs = performance.now();
  game.running = true;

  cancelAnimationFrame(game.raf);
  game.raf = requestAnimationFrame(frame);
}

/* ---------- 主循环 ---------- */

function frame() {
  if (!game.running || !game.g) return;
  const nowMs = engine.time() * 1000;   // 音频时钟（秒 → 毫秒）
  const missed = game.g.tick(nowMs);

  if (missed.length) {
    for (const _ of missed) { /* 一次 miss 只放一次反馈 */ }
    flashJudge('miss');
    haptic(24);
  }

  const lv = game.g.lastVerdict;
  const stamp = game.g.history.length;
  if (lv && stamp !== game.lastJudgeId && lv.verdict !== 'empty') {
    game.lastJudgeId = stamp;
    if (lv.verdict !== 'miss') {
      flashJudge(lv.verdict);
      haptic(lv.verdict === 'perfect' ? 8 : lv.verdict === 'great' ? 6 : 4);
      try { engine.hitSound(lv.verdict); } catch { /* 忽略 */ }
    }
  }

  draw(nowMs);
  paintHud(false);

  // 倒计时大字
  if (nowMs < 0) {
    const n = Math.ceil(-nowMs / 1000);
    if (n !== game.countdownShown && n > 0) {
      game.countdownShown = n;
      const el = $('hud-countdown');
      el.textContent = String(n);
      el.classList.remove('show');
      void el.offsetWidth;
      el.classList.add('show');
    }
  } else if (game.countdownShown !== 0) {
    game.countdownShown = 0;
    const el = $('hud-countdown');
    el.textContent = 'GO';
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  }

  if (game.g.phase === 'result') { finishGame(); return; }
  game.raf = requestAnimationFrame(frame);
}

/* ---------- 渲染 ---------- */

function laneColor(i) {
  return ['#00e5ff', '#7c4dff', '#ff2fd0', '#00ffa3'][i] || '#00e5ff';
}

function draw(nowMs) {
  const { w, h, laneW, judgeY } = view;
  ctx2d.clearRect(0, 0, w, h);

  // 四轨底
  for (let i = 0; i < LANES; i++) {
    const x = i * laneW;
    const c = laneColor(i);
    const g = ctx2d.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(255,255,255,0.012)');
    g.addColorStop(0.72, 'rgba(255,255,255,0.03)');
    g.addColorStop(1, hexA(c, 0.1));
    ctx2d.fillStyle = g;
    ctx2d.fillRect(x, 0, laneW, h);

    // 轨线
    ctx2d.strokeStyle = 'rgba(255,255,255,0.055)';
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    ctx2d.moveTo(x + 0.5, 0);
    ctx2d.lineTo(x + 0.5, h);
    ctx2d.stroke();

    // 按下反馈
    if (game.pressed[i]) {
      const g2 = ctx2d.createLinearGradient(0, judgeY - 140, 0, h);
      g2.addColorStop(0, hexA(c, 0));
      g2.addColorStop(1, hexA(c, 0.22));
      ctx2d.fillStyle = g2;
      ctx2d.fillRect(x + 1, judgeY - 140, laneW - 2, h - judgeY + 140);
    }
  }

  // 判定线
  const lg = ctx2d.createLinearGradient(0, 0, w, 0);
  lg.addColorStop(0, hexA('#00e5ff', 0.15));
  lg.addColorStop(0.5, hexA('#ff2fd0', 0.85));
  lg.addColorStop(1, hexA('#00e5ff', 0.15));
  ctx2d.strokeStyle = lg;
  ctx2d.lineWidth = 2;
  ctx2d.shadowBlur = 18;
  ctx2d.shadowColor = 'rgba(255,47,208,0.6)';
  ctx2d.beginPath();
  ctx2d.moveTo(0, judgeY + 0.5);
  ctx2d.lineTo(w, judgeY + 0.5);
  ctx2d.stroke();
  ctx2d.shadowBlur = 0;

  // 判定键盘位（四块）
  for (let i = 0; i < LANES; i++) {
    const x = i * laneW;
    const c = laneColor(i);
    const on = game.pressed[i];
    ctx2d.fillStyle = on ? hexA(c, 0.3) : 'rgba(255,255,255,0.05)';
    roundRect(ctx2d, x + laneW * 0.12, judgeY + 12, laneW * 0.76, 40, 9);
    ctx2d.fill();
    ctx2d.strokeStyle = on ? hexA(c, 0.9) : hexA(c, 0.28);
    ctx2d.lineWidth = on ? 2 : 1;
    roundRect(ctx2d, x + laneW * 0.12, judgeY + 12, laneW * 0.76, 40, 9);
    ctx2d.stroke();
  }

  if (!game.chart || !game.g) return;

  // 音符
  const approach = (APPROACH_BY_DIFFICULTY[game.chart.difficulty] || 1.45)
    * (SPEED_PRESETS[settings.speed] || 1);
  const topLimit = -0.05;
  const notes = game.chart.notes;

  for (const n of notes) {
    if (game.g.isConsumed(n.i)) continue;
    const dt = (n.timeMs - nowMs) / 1000;          // 还有多久到判定线
    if (dt > approach || dt < topLimit) continue;
    const c = laneColor(n.lane);
    const x = n.lane * view.laneW;
    const prog = 1 - dt / approach;                // 0（刚出现） → 1（到线）
    const y = (view.topY - 60) + prog * (judgeY + 60 - view.topY);
    const nh = Math.max(9, Math.min(16, view.h * 0.019));
    const nw = view.laneW * 0.8;
    const nx = x + (view.laneW - nw) / 2;

    if (n.kind === 'hold') {
      const tailDt = (n.timeMs + n.holdMs - nowMs) / 1000;
      const progTail = 1 - tailDt / approach;
      const yTail = (view.topY - 60) + progTail * (judgeY + 60 - view.topY);
      const yTop = Math.min(y, yTail);
      const yBot = Math.max(y, yTail);
      const hg = ctx2d.createLinearGradient(0, yTop, 0, yBot);
      hg.addColorStop(0, hexA(c, 0.22));
      hg.addColorStop(1, hexA(c, 0.55));
      ctx2d.fillStyle = hg;
      roundRect(ctx2d, nx, yTop, nw, Math.max(6, yBot - yTop), 6);
      ctx2d.fill();
    }

    const grd = ctx2d.createLinearGradient(nx, 0, nx + nw, 0);
    grd.addColorStop(0, hexA(c, 0.75));
    grd.addColorStop(0.5, '#ffffff');
    grd.addColorStop(1, hexA(c, 0.75));
    ctx2d.fillStyle = grd;
    ctx2d.shadowBlur = fxOn() ? 14 : 0;
    ctx2d.shadowColor = hexA(c, 0.9);
    roundRect(ctx2d, nx, y - nh / 2, nw, nh, nh / 2);
    ctx2d.fill();
    ctx2d.shadowBlur = 0;
  }
}

function hexA(hex, a) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function roundRect(c, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
}

/* ---------- HUD ---------- */

let hudCache = { scoreTxt: '', combo: -1, acc: -1, prog: -1 };

function paintHud(force) {
  if (!game.g) return;
  const s = game.g.liveStats();

  if (force || s.combo !== hudCache.combo) {
    hudCache.combo = s.combo;
    const el = $('hud-combo');
    if (s.combo >= 2) {
      el.innerHTML = `${s.combo}<small>COMBO</small>`;
      el.classList.add('on');
    } else {
      el.classList.remove('on');
    }
  }
  // 实时分：与 judge.scoreOf 同口径（900000×准确率 + 100000×(最大连击/总音符)）
  const sc = s.judged > 0
    ? 900000 * s.accuracy + 100000 * (s.maxCombo / Math.max(1, game.chart.notes.length))
    : 0;
  const txt = fmtScore(Math.round(sc));
  if (force || txt !== hudCache.scoreTxt) {
    hudCache.scoreTxt = txt;
    $('hud-score').textContent = txt;
  }
  const accPct = s.judged > 0 ? s.accuracy * 100 : 100;
  if (force || Math.abs(accPct - hudCache.acc) > 0.05) {
    hudCache.acc = accPct;
    $('hud-acc').textContent = accPct.toFixed(2) + '%';
  }
  const progPct = s.progress * 100;
  if (force || Math.abs(progPct - hudCache.prog) > 0.3) {
    hudCache.prog = progPct;
    $('hud-prog-bar').style.width = progPct.toFixed(1) + '%';
  }
}

let judgeTimer = 0;
function flashJudge(verdict) {
  const el = $('hud-judge');
  el.textContent = VERDICT_LABEL[verdict] || verdict;
  el.className = 'hud-judge';
  void el.offsetWidth;
  el.classList.add('show', verdict);
  clearTimeout(judgeTimer);
  judgeTimer = setTimeout(() => { el.className = 'hud-judge'; }, 460);
}

/* ---------- 结算 ---------- */

function finishGame() {
  game.running = false;
  cancelAnimationFrame(game.raf);
  try { engine.stop(); } catch { /* 忽略 */ }

  const r = game.g.result();
  const key = game.chart.key;
  const prev = bestFor(scores, key);
  const merged = mergeResult(scores, key, {
    score: r.score,
    maxCombo: r.maxCombo,
    accuracy: r.accuracy,
    grade: r.grade,
    fullCombo: r.fullCombo,
    cleared: r.cleared,
    counts: r.counts,
    at: Date.now(),
  }, { practice: game.g.practice });

  if (merged.wrote) {
    scores = merged.store;
    saveScores(storage, scores);
  }

  show('result');

  const gradeEl = $('res-grade');
  gradeEl.textContent = r.grade;
  gradeEl.className = 'res-grade ' + r.grade;

  $('res-title').textContent = `${game.chart.title} · ${DIFFICULTY_LABEL[game.chart.difficulty]}`;
  $('res-score').textContent = fmtScore(r.score);

  const badges = [];
  if (r.allPerfect) badges.push('<span class="badge ap">ALL PERFECT</span>');
  else if (r.fullCombo) badges.push('<span class="badge fc">FULL COMBO</span>');
  if (r.cleared && !r.fullCombo && !r.allPerfect) badges.push('<span class="badge cl">CLEAR</span>');
  $('res-badges').innerHTML = badges.join('');

  const rows = [
    ['准确率', r.accuracyPct.toFixed(2) + '%'],
    ['最大连击', r.maxCombo + ' / ' + game.chart.notes.length],
    ['PERFECT', r.counts.perfect],
    ['GREAT', r.counts.great],
    ['GOOD', r.counts.good],
    ['MISS', r.counts.miss],
  ];
  $('res-rows').innerHTML = rows.map(
    ([k, v]) => `<div class="res-row"><span>${k}</span><b>${v}</b></div>`,
  ).join('');

  const isNew = merged.wrote && (!prev || r.score > prev.score);
  $('res-new').hidden = !isNew;
}

/* ---------- 输入 ---------- */

const KEYMAP = { d: 0, f: 1, j: 2, k: 3, D: 0, F: 1, J: 2, K: 3, KeyD: 0, KeyF: 1, KeyJ: 2, KeyK: 3 };

function pressLane(lane) {
  if (curScreen !== 'game' || !game.g || !game.running) return;
  if (game.g.phase !== 'playing') return;
  game.pressed[lane] = true;
  syncLaneHits();
  const nowMs = engine.time() * 1000;
  const res = game.g.press(lane, nowMs);
  if (!res) return;
  if (!res.pending) {
    // 普通音符：判定已在 press 内提交，反馈由 frame 里的 lastVerdict 统一出
  }
}

function releaseLane(lane) {
  game.pressed[lane] = false;
  syncLaneHits();
  if (curScreen !== 'game' || !game.g || !game.running) return;
  const nowMs = engine.time() * 1000;
  const res = game.g.release(lane, nowMs);
  if (res) flashJudge(res.verdict);
}

function syncLaneHits() {
  qsa('.lane-hit').forEach((el, i) => el.classList.toggle('on', !!game.pressed[i]));
}

document.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const lane = KEYMAP[e.code] ?? KEYMAP[e.key];
  if (lane === undefined) return;
  e.preventDefault();
  if (curScreen === 'game') pressLane(lane);
});

document.addEventListener('keyup', (e) => {
  const lane = KEYMAP[e.code] ?? KEYMAP[e.key];
  if (lane === undefined) return;
  e.preventDefault();
  if (curScreen === 'game') releaseLane(lane);
});

/* 触摸：整个游戏屏按 x 坐标分四段 */
const activeTouches = new Map();

function laneAt(clientX) {
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  return clamp(Math.floor(x / (rect.width / LANES)), 0, LANES - 1);
}

canvas.addEventListener('touchstart', (e) => {
  if (curScreen !== 'game') return;
  e.preventDefault();
  unlockAudio();
  for (const t of e.changedTouches) {
    const lane = laneAt(t.clientX);
    activeTouches.set(t.identifier, lane);
    pressLane(lane);
  }
}, { passive: false });

canvas.addEventListener('touchend', (e) => {
  if (curScreen !== 'game') return;
  e.preventDefault();
  for (const t of e.changedTouches) {
    const lane = activeTouches.get(t.identifier);
    if (lane === undefined) continue;
    activeTouches.delete(t.identifier);
    releaseLane(lane);
  }
}, { passive: false });

canvas.addEventListener('touchcancel', (e) => {
  for (const t of e.changedTouches) {
    const lane = activeTouches.get(t.identifier);
    if (lane === undefined) continue;
    activeTouches.delete(t.identifier);
    releaseLane(lane);
  }
}, { passive: true });

/* 鼠标（桌面调试） */
canvas.addEventListener('mousedown', (e) => {
  if (curScreen !== 'game') return;
  e.preventDefault();
  unlockAudio();
  pressLane(laneAt(e.clientX));
});
canvas.addEventListener('mouseup', (e) => {
  if (curScreen !== 'game') return;
  releaseLane(laneAt(e.clientX));
});

/* 触摸泳道反馈条 */
(function mountLaneHits() {
  const wrap = $('lane-hits');
  if (!wrap) return;
  for (let i = 0; i < LANES; i++) {
    const d = document.createElement('div');
    d.className = 'lane-hit';
    wrap.appendChild(d);
  }
})();

/* ---------- 暂停 / 退出 ---------- */

function pauseGame() {
  if (curScreen !== 'game' || !game.running) return;
  game.running = false;
  cancelAnimationFrame(game.raf);
  try { engine.pause(); } catch { /* 忽略 */ }
  game.g.pause(engine.time() * 1000);
  $('pause-mask').hidden = false;
}

function resumeGame() {
  if (curScreen !== 'game' || game.running) return;
  $('pause-mask').hidden = true;
  unlockAudio();
  try { engine.resume(); } catch { /* 忽略 */ }
  game.g.resume();
  game.running = true;
  game.lastJudgeId = -1;
  game.raf = requestAnimationFrame(frame);
}

function quitToMenu() {
  game.running = false;
  cancelAnimationFrame(game.raf);
  try { engine.stop(); } catch { /* 忽略 */ }
  $('pause-mask').hidden = true;
  show('menu');
  renderMenu();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (curScreen === 'game' && game.running) pauseGame();
    try { engine.pause(); } catch { /* 忽略 */ }
  } else if (curScreen === 'game' && !game.running && $('pause-mask').hidden === false) {
    // 回来不自动继续：让玩家自己点，避免"回来就掉一串 miss"
  }
});

/* ============================ 设置面板 ============================ */

function paintSettings() {
  $('set-offset').value = String(settings.offsetMs);
  $('set-offset-val').textContent = (settings.offsetMs > 0 ? '+' : '') + settings.offsetMs + ' ms';
  $('set-volume').value = String(Math.round((settings.volume || 0) * 100));
  $('set-volume-val').textContent = Math.round((settings.volume || 0) * 100) + '%';
  qsa('#set-speed button').forEach((b) => b.classList.toggle('on', b.dataset.speed === settings.speed));
  $('set-fx').dataset.on = settings.flash === false ? '0' : '1';
  $('set-fx').textContent = settings.flash === false ? '关' : '开';
}

function persistSettings() {
  saveSettings(storage, settings);
  paintSettings();
}

$('btn-settings').addEventListener('click', () => { paintSettings(); $('overlay-settings').hidden = false; });
$('btn-close-settings').addEventListener('click', () => { $('overlay-settings').hidden = true; });
$('overlay-settings').addEventListener('click', (e) => {
  if (e.target === $('overlay-settings')) $('overlay-settings').hidden = true;
});

$('btn-help').addEventListener('click', () => { $('overlay-help').hidden = false; });
$('btn-close-help').addEventListener('click', () => { $('overlay-help').hidden = true; });
$('overlay-help').addEventListener('click', (e) => {
  if (e.target === $('overlay-help')) $('overlay-help').hidden = true;
});

$('set-offset').addEventListener('input', (e) => {
  settings.offsetMs = clamp(Math.round(Number(e.target.value) || 0), -MAX_OFFSET_MS, MAX_OFFSET_MS);
  $('set-offset-val').textContent = (settings.offsetMs > 0 ? '+' : '') + settings.offsetMs + ' ms';
});
$('set-offset').addEventListener('change', persistSettings);

$('set-volume').addEventListener('input', (e) => {
  settings.volume = clamp((Number(e.target.value) || 0) / 100, 0, 1);
  $('set-volume-val').textContent = Math.round(settings.volume * 100) + '%';
});
$('set-volume').addEventListener('change', persistSettings);

qsa('#set-speed button').forEach((b) => {
  b.addEventListener('click', () => {
    settings.speed = b.dataset.speed;
    persistSettings();
  });
});

$('set-fx').addEventListener('click', () => {
  settings.flash = settings.flash === false;
  persistSettings();
});

$('btn-clear').addEventListener('click', () => {
  if (!confirm('清除全部成绩？（不可恢复）')) return;
  scores = emptyScores();
  clearAll(storage);
  saveScores(storage, scores);
  $('overlay-settings').hidden = true;
  renderMenu();
});

/* ============================ 其它按钮 ============================ */

$('btn-back-menu').addEventListener('click', () => { show('menu'); renderMenu(); });
$('btn-pause').addEventListener('click', pauseGame);
$('btn-quit').addEventListener('click', pauseGame);
$('btn-resume').addEventListener('click', resumeGame);
$('btn-restart').addEventListener('click', () => {
  if (!game.chart) return;
  startGame(game.chart.songId, game.chart.difficulty, game.g && game.g.practice);
});
$('btn-to-menu').addEventListener('click', quitToMenu);
$('btn-again').addEventListener('click', () => {
  if (!game.chart) return show('menu');
  startGame(game.chart.songId, game.chart.difficulty, game.g && game.g.practice);
});
$('btn-res-menu').addEventListener('click', () => { show('menu'); renderMenu(); });

/* ============================ 启动 ============================ */

function boot() {
  // 首帧后移除加载指示
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const b = $('boot');
      if (b) {
        b.classList.add('gone');
        setTimeout(() => b.remove(), 400);
      }
    });
  });

  if (settings.muted === false && settings.volume === 0) settings.volume = 0.8;
  renderMenu();
  paintSettings();
  show('menu');

  // 首次交互解锁音频
  const once = () => {
    unlockAudio();
    document.removeEventListener('pointerdown', once);
    document.removeEventListener('keydown', once);
  };
  document.addEventListener('pointerdown', once, { passive: true });
  document.addEventListener('keydown', once);

  // 诊断出口（探针与手测用）
  window.NEON = {
    engine, get scores() { return scores; }, get settings() { return settings; },
    get game() { return game.g; }, get chart() { return game.chart; },
    startGame, show, renderMenu, pauseGame, resumeGame,
  };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
