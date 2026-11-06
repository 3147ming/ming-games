/**
 * 像素跑酷 PIXEL RUNNER · UI 层
 * ============================================================================
 * 唯一碰 DOM / Canvas / localStorage / AudioContext 的文件。
 * 逻辑全部委托给 engine.mjs（纯函数），这里只做：画 + 收输入 + 存档。
 *
 * 手感约定：
 *   · 输入 → 画面反馈 ≤ 1 帧（跳跃立即改 vy，渲染同帧反映）
 *   · 过渡 0.16s / cubic-bezier(.22,.61,.36,1)
 *   · prefers-reduced-motion 与 settings.fx 双开关控制粒子
 * ============================================================================
 */

import {
  createRun, step, pressJump, pressSlide, releaseSlide,
  playerBox, distanceOf, summarize, PLAYER_W, PLAYER_H, SLIDE_H,
  GRAVITY, JUMP_V, SPEED_MAX, BASE_SPEED, MAX_STEP,
} from './engine.mjs';

import {
  loadSave, saveSave, loadSettings, saveSettings, mergeRun, summarizeSave,
  resolveStorage, clearAll, todayKey, ACHIEVEMENTS,
} from './save.mjs';

/* ============================ 工具 ============================ */

const $ = (id) => document.getElementById(id);
const qsa = (sel) => [...document.querySelectorAll(sel)];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

const storage = resolveStorage(null);
let save = loadSave(storage);
let settings = loadSettings(storage);

const prefersReduced = window.matchMedia
  ? matchMedia('(prefers-reduced-motion: reduce)').matches
  : false;

const fxOn = () => settings.fx !== false && !prefersReduced;

/* ============================ 音频（程序化） ============================ */

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

/** 简单音效：freq 起始频率，slide 到 freq2，dur 秒。 */
function beep({ freq = 440, freq2 = null, dur = 0.09, type = 'square', gain = 0.06 } = {}) {
  if (settings.muted || settings.sfx === false) return;
  const c = ctx();
  if (!c || c.state !== 'running') return;
  try {
    const t0 = c.currentTime;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (freq2) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq2), t0 + dur);
    const vol = gain * (settings.volume ?? 0.7);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(c.destination);
    o.start(t0); o.stop(t0 + dur + 0.02);
  } catch { /* 忽略 */ }
}

const SFX = {
  jump: () => beep({ freq: 520, freq2: 880, dur: 0.09, type: 'square', gain: 0.05 }),
  double: () => beep({ freq: 700, freq2: 1180, dur: 0.1, type: 'triangle', gain: 0.055 }),
  slide: () => beep({ freq: 300, freq2: 160, dur: 0.14, type: 'sawtooth', gain: 0.04 }),
  coin: () => beep({ freq: 1180, freq2: 1560, dur: 0.07, type: 'square', gain: 0.045 }),
  power: () => beep({ freq: 660, freq2: 1320, dur: 0.18, type: 'triangle', gain: 0.07 }),
  shield: () => beep({ freq: 880, freq2: 440, dur: 0.22, type: 'sawtooth', gain: 0.075 }),
  hit: () => beep({ freq: 220, freq2: 70, dur: 0.32, type: 'sawtooth', gain: 0.1 }),
  near: () => beep({ freq: 1400, freq2: 1800, dur: 0.05, type: 'square', gain: 0.025 }),
};

function haptic(ms) {
  if (!settings.vibrate || prefersReduced) return;
  try { navigator.vibrate && navigator.vibrate(ms); } catch { /* 忽略 */ }
}

/* ============================ Canvas ============================ */

const canvas = $('canvas');
const g2d = canvas.getContext('2d');
let view = { w: 0, h: 0, dpr: 1, groundY: 0, scale: 1 };

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  view.w = w; view.h = h; view.dpr = dpr;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  g2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  // 地面线：底部留 18% 给 HUD 区
  view.groundY = h * 0.78;
  // 缩放：让玩家高度约等于屏高 12%（手机竖屏大约 80px）
  view.scale = clamp(h * 0.12 / PLAYER_H, 1.2, 3.4);
}

window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 120));

/* ============================ 视觉特效 ============================ */

let particles = [];
let shakeT = 0;
let shakeMag = 0;

function burst(x, y, color, n = 10, speed = 260) {
  if (!fxOn()) return;
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i) / n + Math.random() * 0.4;
    const v = speed * (0.4 + Math.random() * 0.7);
    particles.push({
      x, y,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v - 60,
      life: 0.45 + Math.random() * 0.35,
      maxLife: 0.8,
      color,
      size: 3 + Math.random() * 4,
    });
  }
  if (particles.length > 260) particles = particles.slice(-260);
}

function shake(mag, dur) {
  if (!fxOn()) return;
  shakeMag = Math.max(shakeMag, mag);
  shakeT = Math.max(shakeT, dur);
}

function updateParticles(dt) {
  for (const p of particles) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 1600 * dt;
    p.life -= dt;
  }
  particles = particles.filter((p) => p.life > 0);
  if (shakeT > 0) {
    shakeT -= dt;
    if (shakeT <= 0) shakeMag = 0;
  }
}

/* ============================ 游戏状态 ============================ */

const G = {
  run: null,
  raf: 0,
  lastT: 0,
  running: false,
  paused: false,
  screen: 'menu',
  lastDist: -1,
  camX: 0,
  time: 0,
};

function showScreen(name) {
  G.screen = name;
  $('screen-menu').classList.toggle('active', name === 'menu');
  $('screen-game').classList.toggle('active', name === 'game');
}

/* ============================ 渲染 ============================ */

const COLORS = {
  sky: '#0a0f1e',
  sky2: '#131c3a',
  far: '#18234a',
  mid: '#1e2b54',
  ground: '#0e1428',
  groundLine: '#2a3a6a',
  player: '#40e0d0',
  playerDark: '#1a8f86',
  spike: '#ff4757',
  bar: '#ffd93d',
  drone: '#a29bfe',
  coin: '#ffd93d',
  shield: '#7bed9f',
  magnet: '#ff6b9d',
  slow: '#a29bfe',
};

function draw() {
  const { w, h, groundY, scale } = view;
  g2d.save();

  // 震屏
  if (shakeT > 0 && shakeMag > 0) {
    const m = shakeMag * (shakeT / 0.3);
    g2d.translate((Math.random() - 0.5) * m, (Math.random() - 0.5) * m);
  }

  // 天空渐变
  const sky = g2d.createLinearGradient(0, 0, 0, groundY);
  sky.addColorStop(0, COLORS.sky);
  sky.addColorStop(1, COLORS.sky2);
  g2d.fillStyle = sky;
  g2d.fillRect(-40, -40, w + 80, groundY + 40);

  if (!G.run) { g2d.restore(); return; }

  const run = G.run;

  // 相机
  const camX = run.x - w * 0.28;
  G.camX = camX;
  const toScreenX = (wx) => (wx - camX);
  const toScreenY = (wy) => groundY - wy * scale;

  // 远景（视差 0.25）
  drawParallax(camX * 0.25, groundY, w, 0.35, COLORS.far, 140);
  // 中景（视差 0.5）
  drawParallax(camX * 0.5, groundY, w, 0.55, COLORS.mid, 90);

  // 地面
  g2d.fillStyle = COLORS.ground;
  g2d.fillRect(-40, groundY, w + 80, h - groundY + 40);
  g2d.strokeStyle = COLORS.groundLine;
  g2d.lineWidth = 2;
  g2d.beginPath();
  g2d.moveTo(-40, groundY + 0.5);
  g2d.lineTo(w + 40, groundY + 0.5);
  g2d.stroke();

  // 地面纹理（等距竖线，随相机滚动）
  const gridStep = 60 * view.scale;
  const offset = (camX % gridStep);
  g2d.strokeStyle = 'rgba(42,58,106,0.45)';
  g2d.lineWidth = 1;
  for (let x = -offset; x < w + gridStep; x += gridStep) {
    g2d.beginPath();
    g2d.moveTo(x, groundY);
    g2d.lineTo(x, groundY + 14);
    g2d.stroke();
  }

  // 拾取物
  for (const p of run.pickups) {
    if (p.taken) continue;
    const sx = toScreenX(p.x);
    if (sx < -60 || sx > w + 60) continue;
    const bob = Math.sin(run.t * 3 + p.bobT) * 4;
    const sy = toScreenY(p.y) + bob;
    const r = p.r * (view.scale / 1.6);

    if (p.kind === 'coin') {
      g2d.save();
      g2d.translate(sx, sy);
      g2d.rotate(Math.sin(run.t * 4 + p.bobT) * 0.35);
      g2d.fillStyle = COLORS.coin;
      g2d.shadowBlur = fxOn() ? 12 : 0;
      g2d.shadowColor = 'rgba(255,217,61,0.85)';
      // 像素硬币：菱形
      g2d.beginPath();
      g2d.moveTo(0, -r);
      g2d.lineTo(r, 0);
      g2d.lineTo(0, r);
      g2d.lineTo(-r, 0);
      g2d.closePath();
      g2d.fill();
      g2d.fillStyle = '#fff7cc';
      g2d.fillRect(-r * 0.22, -r * 0.22, r * 0.44, r * 0.44);
      g2d.restore();
      g2d.shadowBlur = 0;
    } else {
      const col = p.kind === 'shield' ? COLORS.shield : p.kind === 'magnet' ? COLORS.magnet : COLORS.slow;
      const icon = p.kind === 'shield' ? '🛡' : p.kind === 'magnet' ? '🧲' : '⏳';
      g2d.save();
      g2d.translate(sx, sy);
      g2d.shadowBlur = fxOn() ? 16 : 0;
      g2d.shadowColor = col;
      g2d.fillStyle = 'rgba(10,15,30,0.7)';
      g2d.strokeStyle = col;
      g2d.lineWidth = 2;
      const rr = r * 1.5;
      g2d.beginPath();
      g2d.arc(0, 0, rr, 0, Math.PI * 2);
      g2d.fill(); g2d.stroke();
      g2d.shadowBlur = 0;
      g2d.font = `${Math.round(rr * 1.3)}px system-ui`;
      g2d.textAlign = 'center';
      g2d.textBaseline = 'middle';
      g2d.fillText(icon, 0, 1);
      g2d.restore();
    }
  }

  // 障碍
  for (const o of run.obstacles) {
    const sx = toScreenX(o.x);
    if (sx < -120 || sx > w + 120) continue;
    const ow = o.w * view.scale;
    const oh = o.h * view.scale;
    const bottomY = toScreenY(o.y);
    const x0 = sx - ow / 2;
    const y0 = bottomY - oh;

    if (o.kind === 'spike') {
      g2d.fillStyle = COLORS.spike;
      g2d.shadowBlur = fxOn() ? 10 : 0;
      g2d.shadowColor = 'rgba(255,71,87,0.7)';
      // 三连锯齿
      const n = 3;
      const segW = ow / n;
      g2d.beginPath();
      g2d.moveTo(x0, bottomY);
      for (let i = 0; i < n; i++) {
        g2d.lineTo(x0 + segW * (i + 0.5), y0);
        g2d.lineTo(x0 + segW * (i + 1), bottomY);
      }
      g2d.closePath();
      g2d.fill();
      g2d.shadowBlur = 0;
    } else if (o.kind === 'bar') {
      g2d.fillStyle = COLORS.bar;
      g2d.shadowBlur = fxOn() ? 10 : 0;
      g2d.shadowColor = 'rgba(255,217,61,0.7)';
      g2d.fillRect(x0, y0, ow, oh);
      g2d.shadowBlur = 0;
      // 斜纹
      g2d.fillStyle = 'rgba(10,15,30,0.5)';
      for (let i = 0; i < ow; i += 12) {
        g2d.fillRect(x0 + i, y0, 5, oh);
      }
    } else {
      const bob = Math.sin(run.t * 4 + o.bobT) * 5;
      g2d.fillStyle = COLORS.drone;
      g2d.shadowBlur = fxOn() ? 12 : 0;
      g2d.shadowColor = 'rgba(162,155,254,0.7)';
      g2d.beginPath();
      g2d.ellipse(sx, y0 + oh / 2 + bob, ow / 2, oh / 2, 0, 0, Math.PI * 2);
      g2d.fill();
      g2d.shadowBlur = 0;
      // 眼睛
      g2d.fillStyle = '#0a0f1e';
      g2d.beginPath();
      g2d.arc(sx - ow * 0.14, y0 + oh / 2 + bob, ow * 0.09, 0, Math.PI * 2);
      g2d.arc(sx + ow * 0.14, y0 + oh / 2 + bob, ow * 0.09, 0, Math.PI * 2);
      g2d.fill();
    }
  }

  // 玩家
  drawPlayer(run, toScreenX, toScreenY);

  // 粒子
  if (particles.length) {
    for (const p of particles) {
      const a = clamp(p.life / p.maxLife, 0, 1);
      g2d.globalAlpha = a;
      g2d.fillStyle = p.color;
      g2d.fillRect(p.x, p.y, p.size, p.size);
    }
    g2d.globalAlpha = 1;
  }

  g2d.restore();
}

function drawParallax(offX, groundY, w, alpha, color, baseH) {
  g2d.save();
  g2d.globalAlpha = alpha;
  g2d.fillStyle = color;
  const step = 90;
  for (let i = 0; i < 20; i++) {
    const wx = i * step - (offX % (step * 20)) * 0.999;
    const sx = wx;
    if (sx < -120 || sx > w + 120) continue;
    // 用 i 做伪随机高度，保证滚动时形状稳定
    const hh = baseH * (0.55 + ((i * 37) % 100) / 160);
    const ww = 46 + ((i * 53) % 40);
    g2d.fillRect(sx, groundY - hh, ww, hh);
  }
  g2d.restore();
}

function drawPlayer(run, toScreenX, toScreenY) {
  const scale = view.scale;
  const sx = toScreenX(run.x);
  const box = playerBox(run);
  const h = (run.sliding ? SLIDE_H : PLAYER_H) * scale;
  const w = PLAYER_W * scale;
  const bottomY = toScreenY(run.y);
  const x0 = sx - w / 2;
  const y0 = bottomY - h;

  g2d.save();

  // 拖尾（跳跃时）
  if (!run.onGround && fxOn()) {
    g2d.globalAlpha = 0.22;
    g2d.fillStyle = COLORS.player;
    for (let i = 1; i <= 3; i++) {
      g2d.fillRect(x0 - i * 7, y0 + h * 0.2 + i * 3, w * 0.7, h * 0.5 - i * 4);
    }
    g2d.globalAlpha = 1;
  }

  // 身体（像素块）
  g2d.shadowBlur = fxOn() ? 16 : 0;
  g2d.shadowColor = run.shield ? COLORS.shield : 'rgba(64,224,208,0.8)';
  g2d.fillStyle = COLORS.player;
  g2d.fillRect(x0, y0, w, h);

  // 深色装饰（像素风的分块感）
  g2d.fillStyle = COLORS.playerDark;
  g2d.fillRect(x0, y0 + h * 0.62, w, h * 0.38);
  g2d.fillRect(x0 + w * 0.7, y0, w * 0.3, h * 0.32);

  // 眼
  g2d.fillStyle = '#06201d';
  const eyeSize = Math.max(3, w * 0.16);
  g2d.fillRect(x0 + w * 0.62, y0 + h * 0.22, eyeSize, eyeSize);

  // 护盾环
  if (run.shield) {
    g2d.strokeStyle = COLORS.shield;
    g2d.lineWidth = 2.5;
    g2d.globalAlpha = 0.75 + Math.sin(run.t * 6) * 0.2;
    g2d.beginPath();
    g2d.arc(sx, y0 + h / 2, h * 0.92, 0, Math.PI * 2);
    g2d.stroke();
    g2d.globalAlpha = 1;
  }

  g2d.shadowBlur = 0;
  g2d.restore();
}

/* ============================ HUD 更新 ============================ */

let hudCache = { dist: -1, coins: -1, score: -1, powers: '' };

function updateHud() {
  if (!G.run) return;
  const run = G.run;
  const dist = distanceOf(run);
  if (dist !== hudCache.dist) {
    hudCache.dist = dist;
    $('hud-dist').textContent = dist;
  }
  if (run.coins !== hudCache.coins) {
    hudCache.coins = run.coins;
    $('hud-coins').textContent = run.coins;
  }
  const sc = dist + run.coins * 10;
  if (sc !== hudCache.score) {
    hudCache.score = sc;
    $('hud-score').textContent = sc;
  }
  // 连击（近失）提示
  const combo = $('hud-combo');
  if (run.nearMiss >= 3) {
    combo.textContent = `近失 ×${run.nearMiss}`;
    combo.classList.add('on');
  } else {
    combo.classList.remove('on');
  }
  // 道具条
  const pw = [];
  if (run.shield) pw.push(`<span class="pw" style="--c:${COLORS.shield}">🛡 护盾</span>`);
  if (run.magnetT > 0) pw.push(`<span class="pw" style="--c:${COLORS.magnet}">🧲 <i>${run.magnetT.toFixed(1)}s</i></span>`);
  if (run.slowT > 0) pw.push(`<span class="pw" style="--c:${COLORS.slow}">⏳ <i>${run.slowT.toFixed(1)}s</i></span>`);
  const key = pw.join('|');
  if (key !== hudCache.powers) {
    hudCache.powers = key;
    $('powerbar').innerHTML = key;
  }
}

function toast(text, cls = '') {
  const el = $('toast');
  el.textContent = text;
  el.className = 'toast';
  void el.offsetWidth;
  el.classList.add('show');
  if (cls) el.classList.add(cls);
}

/* ============================ 主循环 ============================ */

function loop(now) {
  if (!G.running) return;

  const t = now / 1000;
  let dt = G.lastT ? t - G.lastT : 0;
  G.lastT = t;
  dt = Math.min(dt, 0.05);      // 切后台回来不瞬移

  if (!G.paused && G.run && !G.run.dead) {
    const prevX = G.run.x;
    const { events } = step(G.run, dt);

    for (const ev of events) {
      if (ev.type === 'coin') {
        SFX.coin();
        const sx = view.w * 0.28 + 20;
        burst(sx, view.groundY - 80, COLORS.coin, 6, 160);
      } else if (ev.type === 'powerup') {
        SFX.power();
        toast(ev.kind === 'shield' ? '🛡 护盾' : ev.kind === 'magnet' ? '🧲 磁铁' : '⏳ 慢放', 'gold');
        haptic(12);
      } else if (ev.type === 'shield-break') {
        SFX.shield();
        toast('护盾破碎', 'pink');
        shake(10, 0.25);
        haptic(24);
      } else if (ev.type === 'near-miss') {
        SFX.near();
      } else if (ev.type === 'land' && fxOn()) {
        const sx = view.w * 0.28;
        burst(sx, view.groundY, '#2a3a6a', 4, 90);
      } else if (ev.type === 'death') {
        SFX.hit();
        haptic(60);
        shake(16, 0.36);
        const sx = view.w * 0.28;
        burst(sx, view.groundY - PLAYER_H * view.scale, COLORS.spike, 18, 320);
      }
    }

    // 每 100 米提示
    const d = distanceOf(G.run);
    if (hudCache.dist >= 0 && Math.floor(d / 100) > Math.floor(hudCache.dist / 100) && d >= 100) {
      toast(`${Math.floor(d / 100) * 100} 米`, 'pink');
    }

    updateParticles(dt);
    draw();
    updateHud();

    if (G.run.dead) {
      finishRun();
      return;
    }
  } else {
    updateParticles(dt);
    draw();
  }

  G.raf = requestAnimationFrame(loop);
}

/* ============================ 开局 / 结算 ============================ */

function startRun() {
  unlockAudio();
  showScreen('game');
  resize();
  $('overlay-result').hidden = true;
  $('overlay-pause').hidden = true;
  $('powerbar').innerHTML = '';
  particles = [];
  shakeT = 0;

  G.run = createRun({ seed: 'run-' + Date.now().toString(36) });
  G.lastT = 0;
  G.paused = false;
  G.running = true;
  hudCache = { dist: -1, coins: -1, score: -1, powers: '' };
  updateHud();
  draw();

  cancelAnimationFrame(G.raf);
  G.raf = requestAnimationFrame(loop);
}

function finishRun() {
  G.running = false;
  cancelAnimationFrame(G.raf);
  const run = G.run;
  const summary = summarize(run);

  const merged = mergeRun(save, summary, { now: Date.now(), dateKey: todayKey() });
  save = merged.save;
  saveSave(storage, save);

  showResult(summary, merged.isBest, merged.unlocked);
}

function showResult(sum, isBest, unlocked) {
  $('res-title').textContent = sum.deathReason === 'bar' ? '撞上横杆' : sum.deathReason === 'drone' ? '撞上飞行物' : '撞上地刺';
  $('res-score').textContent = sum.score;
  $('res-best').hidden = !isBest;
  $('res-dist').textContent = sum.distance;
  $('res-coins').textContent = sum.coins;
  $('res-near').textContent = sum.nearMiss;
  $('res-time').textContent = sum.seconds + 's';

  const un = $('res-unlock');
  if (unlocked && unlocked.length) {
    const names = unlocked.map((id) => {
      const a = ACHIEVEMENTS.find((x) => x.id === id);
      return a ? a.name : id;
    });
    un.innerHTML = `🏆 解锁成就：${names.join('、')}`;
    un.hidden = false;
  } else {
    un.hidden = true;
  }

  $('overlay-result').hidden = false;
  if (isBest) SFX.power();
  renderMenu();
}

/* ============================ 输入 ============================ */

let touchStartY = 0;
let touchStartT = 0;
let touchMoved = false;

window.addEventListener('keydown', (e) => {
  if (G.screen !== 'game' || !G.running || G.paused) {
    if (e.code === 'Space' && G.screen === 'menu') { e.preventDefault(); startRun(); }
    return;
  }
  if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
    e.preventDefault();
    doJump();
  } else if (e.code === 'ArrowDown' || e.code === 'KeyS') {
    e.preventDefault();
    doSlide();
  } else if (e.code === 'Escape') {
    e.preventDefault();
    pauseGame();
  }
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'ArrowDown' || e.code === 'KeyS') {
    if (G.run) releaseSlide(G.run);
  }
});

canvas.addEventListener('touchstart', (e) => {
  if (G.screen !== 'game' || !G.running || G.paused) return;
  e.preventDefault();
  unlockAudio();
  const t = e.changedTouches[0];
  touchStartY = t.clientY;
  touchStartT = performance.now();
  touchMoved = false;
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
  if (G.screen !== 'game' || !G.running || G.paused) return;
  e.preventDefault();
  const t = e.changedTouches[0];
  const dy = t.clientY - touchStartY;
  if (dy > 36 && !touchMoved) {
    touchMoved = true;
    doSlide();
  }
}, { passive: false });

canvas.addEventListener('touchend', (e) => {
  if (G.screen !== 'game' || !G.running || G.paused) return;
  e.preventDefault();
  const dt = performance.now() - touchStartT;
  // 轻点（没滑）= 跳
  if (!touchMoved && dt < 400) doJump();
  releaseSlideIfNeeded();
}, { passive: false });

canvas.addEventListener('touchcancel', () => {
  releaseSlideIfNeeded();
}, { passive: true });

// 鼠标（桌面）
canvas.addEventListener('mousedown', (e) => {
  if (G.screen !== 'game' || !G.running || G.paused) return;
  e.preventDefault();
  unlockAudio();
  if (e.button === 2) doSlide();
  else doJump();
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

function doJump() {
  if (!G.run || G.run.dead) return;
  const before = G.run.jumpsLeft;
  if (pressJump(G.run)) {
    if (before > 1) SFX.jump(); else SFX.double();
    haptic(6);
    if (fxOn()) {
      burst(view.w * 0.28, view.groundY - 4, '#2a3a6a', 5, 120);
    }
  }
}

function doSlide() {
  if (!G.run || G.run.dead) return;
  if (pressSlide(G.run)) {
    SFX.slide();
    haptic(6);
  }
}

function releaseSlideIfNeeded() {
  if (G.run) releaseSlide(G.run);
}

/* ============================ 暂停 ============================ */

function pauseGame() {
  if (!G.running || G.paused) return;
  G.paused = true;
  const run = G.run;
  $('pause-stats').innerHTML =
    `<span>距离 <b>${distanceOf(run)}</b></span>` +
    `<span>硬币 <b>${run.coins}</b></span>` +
    `<span>近失 <b>${run.nearMiss}</b></span>`;
  $('overlay-pause').hidden = false;
}

function resumeGame() {
  if (!G.paused) return;
  G.paused = false;
  G.lastT = 0;
  $('overlay-pause').hidden = true;
}

function quitToMenu() {
  G.running = false;
  G.paused = false;
  cancelAnimationFrame(G.raf);
  $('overlay-pause').hidden = true;
  $('overlay-result').hidden = true;
  G.run = null;
  showScreen('menu');
  renderMenu();
  draw();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden && G.running && !G.paused) pauseGame();
});

/* ============================ 主菜单渲染 ============================ */

function renderMenu() {
  const sum = summarizeSave(save);
  $('menu-best').textContent = sum.best.score;
  $('menu-best-dist').textContent = sum.best.distance + ' 米';
  $('menu-best-coins').textContent = sum.best.coins + ' 币';
  $('menu-stats').innerHTML =
    `<span>总局数 <b>${sum.totals.runs}</b></span>` +
    `<span>累计 <b>${sum.totals.distance}</b> 米</span>` +
    `<span>硬币 <b>${sum.totals.coins}</b></span>` +
    `<span>近失 <b>${sum.totals.nearMiss}</b></span>`;
  $('achv-count').textContent = `${sum.achievements}/${sum.achievementsTotal}`;
  $('achv-head').textContent = `${sum.achievements}/${sum.achievementsTotal}`;
}

function renderAchievements() {
  const list = $('achv-list');
  list.innerHTML = '';
  for (const a of ACHIEVEMENTS) {
    const got = Object.prototype.hasOwnProperty.call(save.achievements, a.id);
    const row = document.createElement('div');
    row.className = 'achv' + (got ? ' on' : '');
    row.innerHTML =
      `<div class="achv-ico">${got ? '🏆' : '🔒'}</div>` +
      `<div class="achv-txt"><div class="achv-n">${a.name}</div><div class="achv-d">${a.desc}</div></div>`;
    list.appendChild(row);
  }
}

/* ============================ 设置渲染 ============================ */

function paintSettings() {
  $('set-vol').value = String(Math.round((settings.volume ?? 0.7) * 100));
  $('set-vol-v').textContent = Math.round((settings.volume ?? 0.7) * 100) + '%';
  const setT = (id, on) => {
    const el = $(id);
    if (!el) return;
    el.dataset.on = on ? '1' : '0';
    el.textContent = on ? '开' : '关';
  };
  setT('set-music', settings.music !== false);
  setT('set-sfx', settings.sfx !== false);
  setT('set-fx', settings.fx !== false);
  setT('set-vib', settings.vibrate !== false);
  qsa('#set-control button').forEach((b) => b.classList.toggle('on', b.dataset.c === settings.control));
}

function persist() {
  saveSettings(storage, settings);
  paintSettings();
}

/* ============================ 事件绑定 ============================ */

$('btn-start').addEventListener('click', startRun);
$('btn-again').addEventListener('click', startRun);
$('btn-home').addEventListener('click', quitToMenu);
$('btn-quit').addEventListener('click', quitToMenu);
$('btn-resume').addEventListener('click', resumeGame);
$('btn-pause').addEventListener('click', pauseGame);
$('btn-restart').addEventListener('click', () => {
  $('overlay-pause').hidden = true;
  startRun();
});

$('btn-achv').addEventListener('click', () => {
  renderAchievements();
  $('overlay-achv').hidden = false;
});
$('btn-close-achv').addEventListener('click', () => { $('overlay-achv').hidden = true; });
$('overlay-achv').addEventListener('click', (e) => {
  if (e.target === $('overlay-achv')) $('overlay-achv').hidden = true;
});

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

$('set-vol').addEventListener('input', (e) => {
  settings.volume = clamp((Number(e.target.value) || 0) / 100, 0, 1);
  $('set-vol-v').textContent = Math.round(settings.volume * 100) + '%';
});
$('set-vol').addEventListener('change', persist);

for (const [id, key] of [['set-music', 'music'], ['set-sfx', 'sfx'], ['set-fx', 'fx'], ['set-vib', 'vibrate']]) {
  $(id).addEventListener('click', () => {
    settings[key] = settings[key] === false;
    persist();
  });
}

qsa('#set-control button').forEach((b) => {
  b.addEventListener('click', () => {
    settings.control = b.dataset.c;
    persist();
  });
});

$('btn-clear').addEventListener('click', () => {
  if (!confirm('清除全部成绩与成就？（不可恢复）')) return;
  clearAll(storage);
  save = loadSave(storage);
  settings = loadSettings(storage);
  renderMenu();
  renderAchievements();
  $('overlay-settings').hidden = true;
});

/* ============================ 启动 ============================ */

function boot() {
  resize();
  renderMenu();
  paintSettings();
  showScreen('menu');
  draw();

  requestAnimationFrame(() => requestAnimationFrame(() => {
    const b = $('boot');
    if (b) { b.classList.add('gone'); setTimeout(() => b.remove(), 320); }
  }));

  // 首次交互解锁音频
  const once = () => {
    unlockAudio();
    document.removeEventListener('pointerdown', once);
    document.removeEventListener('keydown', once);
  };
  document.addEventListener('pointerdown', once, { passive: true });
  document.addEventListener('keydown', once);

  // 诊断出口
  window.RUNNER = {
    get run() { return G.run; },
    get save() { return save; },
    get settings() { return settings; },
    startRun, pauseGame, resumeGame, quitToMenu,
    doJump, doSlide,
    distanceOf: () => (G.run ? distanceOf(G.run) : 0),
  };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
