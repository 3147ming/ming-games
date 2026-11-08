// 06 双雄争霸 —— 双车独立操控躲避（移动端左右分屏 / PC 键盘 A·D 与 ←·→）
// 分数 = 金币×10 + 存活秒×2 + 连击奖励，上限 500；金币 = max(1, floor(得分/25))
class Dual {
  constructor(root, api) {
    this.root = root; this.api = api; this.cfg = api.cfg;
    this.target = this.cfg.target; this.time = this.cfg.time;
    this.laneW = 180; this.W = this.laneW * 2; this.H = 520;
    this.ended = false; this.raf = 0; this.last = 0;
    this.survived = 0; this.comboBonus = 0;
    this.magnet = 0; this.slow = [0, 0];
    this.particles = []; this.flash = 0; this.bgScroll = 0;
    this.build();
    this.bind();
    this.spawnT = 0.6;
    this.loop = this.loop.bind(this);
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
    api.setClock(this.time);
  }

  build() {
    this.root.innerHTML = `
      <div class="grid-wrap dl-wrap">
        <div class="dl-tip">移动端：左半屏控<span style="color:#ff5d73">红车</span>、右半屏控<span style="color:#4ea8ff">蓝车</span>（左右滑动移动，按住加速）；PC：A/D 控红车、←/→ 控蓝车</div>
        <canvas class="dl-cv" width="${this.W}" height="${this.H}"></canvas>
        <div class="dl-legend">
          <span>🚧 路障(致命)</span><span>🟰 移动路障</span><span>🐌 减速带</span><span>🧲 磁铁</span><span>🪙 金币</span>
        </div>
      </div>`;
    this.cv = this.root.querySelector('.dl-cv');
    this.ctx = this.cv.getContext('2d');
    const by = this.H - 60;
    this.cars = [
      { lane: 0, x: this.laneW / 2, y: by, w: 40, h: 30, dir: 0, boost: false, color: '#ff5d73' },
      { lane: 1, x: this.laneW + this.laneW / 2, y: by, w: 40, h: 30, dir: 0, boost: false, color: '#4ea8ff' }
    ];
    this.bars = []; this.gems = [];
    this.api.setHud(`<div class="stat"><span class="k">🪙 金币</span><b id="dl-c">0</b>/${this.target}</div>
      <div class="stat"><span class="k">⏱ 时间</span><b>${Math.ceil(this.time)}</b>s</div>
      ${this.magnet > 0 ? '<div class="stat">🧲 吸附中</div>' : ''}`);
  }

  bind() {
    const rectScale = e => {
      const r = this.cv.getBoundingClientRect();
      return { rx: (e.clientX - r.left) * (this.cv.width / r.width), ry: (e.clientY - r.top) * (this.cv.height / r.height) };
    };
    const laneOf = rx => (rx < this.laneW ? 0 : 1);
    const dirOf = (rx, lane) => {
      const c = lane === 0 ? this.laneW / 2 : this.laneW + this.laneW / 2;
      return rx < c - 6 ? -1 : rx > c + 6 ? 1 : 0;
    };
    this.pointers = new Map();
    const down = e => {
      if (e.cancelable) e.preventDefault();
      const { rx } = rectScale(e);
      const lane = laneOf(rx);
      this.pointers.set(e.pointerId, lane);
      this.cars[lane].dir = dirOf(rx, lane); this.cars[lane].boost = true;
    };
    const move = e => {
      if (!this.pointers.has(e.pointerId)) return;
      const { rx } = rectScale(e);
      const lane = this.pointers.get(e.pointerId);
      this.cars[lane].dir = dirOf(rx, lane);
    };
    const up = e => {
      if (!this.pointers.has(e.pointerId)) return;
      const lane = this.pointers.get(e.pointerId);
      this.pointers.delete(e.pointerId);
      this.cars[lane].dir = 0; this.cars[lane].boost = false;
    };
    this.cv.addEventListener('pointerdown', down);
    this.cv.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);

    this.keys = {};
    const kd = e => {
      const k = e.key.toLowerCase();
      if (['a', 'd', 'arrowleft', 'arrowright'].includes(k)) {
        e.preventDefault();
        this.keys[k] = true;
        if (k === 'a') { this.cars[0].dir = -1; this.cars[0].boost = true; }
        if (k === 'd') { this.cars[0].dir = 1; this.cars[0].boost = true; }
        if (k === 'arrowleft') { this.cars[1].dir = -1; this.cars[1].boost = true; }
        if (k === 'arrowright') { this.cars[1].dir = 1; this.cars[1].boost = true; }
      }
    };
    const ku = e => {
      const k = e.key.toLowerCase();
      if (k === 'a' && this.cars[0].dir === -1) { this.cars[0].dir = 0; this.cars[0].boost = false; }
      if (k === 'd' && this.cars[0].dir === 1) { this.cars[0].dir = 0; this.cars[0].boost = false; }
      if (k === 'arrowleft' && this.cars[1].dir === -1) { this.cars[1].dir = 0; this.cars[1].boost = false; }
      if (k === 'arrowright' && this.cars[1].dir === 1) { this.cars[1].dir = 0; this.cars[1].boost = false; }
    };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    this._clean = () => {
      this.cv.removeEventListener('pointerdown', down);
      this.cv.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
    };
    this.api.onDestroy(this._clean);
  }

  spawn() {
    const cfg = this.cfg;
    for (let l = 0; l < 2; l++) {
      const lane = l * this.laneW;
      const roll = Math.random();
      if (roll < cfg.barRate) {
        const type = cfg.slowBelts && Math.random() < 0.16 ? 'slow'
          : cfg.moveBars && Math.random() < 0.4 ? 'move' : 'bar';
        const w = type === 'slow' ? this.laneW - 20 : 64;
        this.bars.push({ lane: l, x: lane + (this.laneW - w) / 2 + (Math.random() - 0.5) * 30, y: -30, w, h: 22, type, vx: type === 'move' ? (Math.random() < 0.5 ? -1 : 1) * 26 : 0 });
      } else if (roll < cfg.barRate + 0.5) {
        const cx = lane + this.laneW / 2 + (Math.random() - 0.5) * (this.laneW - 50);
        this.gems.push({ lane: l, x: cx, y: -16, r: 9 });
      } else if (cfg.magnetRate && Math.random() < cfg.magnetRate) {
        const cx = lane + this.laneW / 2;
        this.gems.push({ lane: l, x: cx, y: -16, r: 11, magnet: true });
      }
    }
  }

  crash(lane) {
    this.ended = true;
    this.flash = 1;
    for (let i = 0; i < 26; i++) this.particles.push({ x: this.cars[lane].x, y: this.cars[lane].y, vx: (Math.random() - 0.5) * 300, vy: (Math.random() - 0.5) * 300, life: 0.6 });
    try { if (navigator.vibrate) navigator.vibrate([60, 40, 60]); } catch (e) {}
    this.api.lose();
  }

  loop(now) {
    if (this.ended) return;
    let dt = (now - this.last) / 1000; this.last = now;
    if (dt > 0.05) dt = 0.05;
    this.update(dt);
    this.render();
    if (!this.ended) this.raf = requestAnimationFrame(this.loop);
  }

  update(dt) {
    this.time -= dt; this.survived += dt;
    if (this.magnet > 0) this.magnet = Math.max(0, this.magnet - dt);
    for (let i = 0; i < 2; i++) if (this.slow[i] > 0) this.slow[i] = Math.max(0, this.slow[i] - dt);
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 2);
    this.bgScroll = (this.bgScroll + dt * (this.boostAny() ? 420 : 160)) % 40;

    const baseV = this.cfg.v * (this.boostAny() ? 1.8 : 1);
    // 移动车辆
    for (const c of this.cars) {
      const sp = (this.slow[c.lane] > 0 ? 70 : 150) * (c.boost ? 1.25 : 1);
      c.x += c.dir * sp * dt;
      const lo = c.lane * this.laneW + 22, hi = c.lane * this.laneW + this.laneW - 22;
      if (c.x < lo) c.x = lo; if (c.x > hi) c.x = hi;
    }
    // 生成
    this.spawnT -= dt;
    if (this.spawnT <= 0) { this.spawn(); this.spawnT = Math.max(0.5, this.cfg.gap - this.survived * 0.006); }
    // 障碍
    for (const b of this.bars) {
      b.y += baseV * dt;
      if (b.type === 'move') { b.x += b.vx * dt; const lo = b.lane * this.laneW + 4, hi = b.lane * this.laneW + this.laneW - b.w - 4; if (b.x < lo) { b.x = lo; b.vx *= -1; } if (b.x > hi) { b.x = hi; b.vx *= -1; } }
      for (const c of this.cars) {
        if (c.lane !== b.lane) continue;
        if (this.hit(c, b)) {
          if (b.type === 'slow') { this.slow[b.lane] = 2; }
          else { this.crash(b.lane); return; }
        }
      }
    }
    this.bars = this.bars.filter(b => b.y < this.H + 30);
    // 金币
    for (const g of this.gems) {
      g.y += baseV * dt;
      if (this.magnet > 0) {
        const c = this.cars[g.lane];
        g.x += (c.x - g.x) * Math.min(1, dt * 6);
      }
      for (const c of this.cars) {
        if (c.lane !== g.lane) continue;
        const dx = c.x - g.x, dy = c.y - g.y;
        if (dx * dx + dy * dy < (c.w / 2 + g.r) * (c.w / 2 + g.r)) {
          g.dead = true;
          if (g.magnet) this.magnet = 5;
          this.coins = (this.coins || 0) + 1;
          this.comboBonus += this.coins; // 连击奖励
          this.api.toast('+' + 10 + ' 分');
        }
      }
    }
    this.gems = this.gems.filter(g => !g.dead && g.y < this.H + 30);
    // 粒子
    for (const p of this.particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; }
    this.particles = this.particles.filter(p => p.life > 0);

    this.api.setClock(this.time);
    const cEl = this.root.querySelector('#dl-c');
    if (cEl) cEl.textContent = this.coins || 0;

    if ((this.coins || 0) >= this.target) return this.finish();
    if (this.time <= 0) { this.time = 0; this.api.setClock(0); return (this.coins || 0) >= this.target ? this.finish() : this.api.lose(); }
  }

  boostAny() { return this.cars[0].boost || this.cars[1].boost; }

  hit(c, b) {
    return c.x - c.w / 2 < b.x + b.w && c.x + c.w / 2 > b.x && c.y - c.h / 2 < b.y + b.h && c.y + c.h / 2 > b.y;
  }

  finish() {
    if (this.ended) return; this.ended = true;
    const score = Math.min(500, (this.coins || 0) * 10 + Math.floor(this.survived) * 2 + Math.min(200, this.comboBonus));
    const stars = this.time > 20 ? 3 : this.time > 10 ? 2 : 1;
    this.api.win(stars, score);
  }

  render() {
    const c = this.ctx, W = this.W, H = this.H;
    c.clearRect(0, 0, W, H);
    // 背景（滚动条纹）
    c.fillStyle = '#0a1226'; c.fillRect(0, 0, W, H);
    c.strokeStyle = 'rgba(120,160,255,0.08)'; c.lineWidth = 2;
    for (let y = this.bgScroll; y < H; y += 40) { c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }
    c.strokeStyle = 'rgba(120,160,255,0.25)'; c.beginPath(); c.moveTo(this.laneW, 0); c.lineTo(this.laneW, H); c.stroke();
    // 速度线
    if (this.boostAny()) {
      c.strokeStyle = 'rgba(56,249,215,0.5)'; c.lineWidth = 2;
      for (let i = 0; i < 8; i++) { const x = 14 + i * (W - 28) / 7; const y = (this.bgScroll * 3 + i * 60) % H; c.beginPath(); c.moveTo(x, y); c.lineTo(x, y + 30); c.stroke(); }
    }
    // 障碍
    for (const b of this.bars) {
      if (b.type === 'slow') { c.fillStyle = 'rgba(120,200,255,0.55)'; }
      else if (b.type === 'move') { c.fillStyle = '#ffae42'; }
      else { c.fillStyle = '#ff5d73'; }
      this.roundRect(b.x, b.y, b.w, b.h, 6); c.fill();
      if (b.type === 'slow') { c.fillStyle = 'rgba(255,255,255,0.8)'; c.font = '14px sans-serif'; c.textAlign = 'center'; c.fillText('🐌', b.x + b.w / 2, b.y + b.h - 4); }
    }
    // 金币
    for (const g of this.gems) {
      c.beginPath(); c.arc(g.x, g.y, g.r, 0, 7);
      c.fillStyle = g.magnet ? '#b06bff' : '#ffd54a'; c.fill();
      c.strokeStyle = 'rgba(0,0,0,0.3)'; c.stroke();
    }
    // 车
    for (const car of this.cars) {
      c.fillStyle = car.color; this.roundRect(car.x - car.w / 2, car.y - car.h / 2, car.w, car.h, 8); c.fill();
      c.fillStyle = 'rgba(255,255,255,0.85)'; c.fillRect(car.x - car.w / 2 + 5, car.y - car.h / 2 + 4, car.w - 10, 5);
    }
    // 粒子
    for (const p of this.particles) { c.globalAlpha = Math.max(0, p.life / 0.6); c.fillStyle = '#ffd54a'; c.beginPath(); c.arc(p.x, p.y, 3, 0, 7); c.fill(); }
    c.globalAlpha = 1;
    // 红闪
    if (this.flash > 0) { c.fillStyle = `rgba(255,60,90,${this.flash * 0.6})`; c.fillRect(0, 0, W, H); }
  }
  roundRect(x, y, w, h, r) {
    const c = this.ctx; c.beginPath();
    c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }
}

export default {
  id: 'dual', name: '双雄争霸', icon: '🏎️', tag: '反应·躲避',
  desc: '左右分屏独立操控双车，躲路障、捡金币，限时集齐目标。',
  maxLevel: 12,
  config(level) {
    const target = Math.min(20, 4 + (level - 1) * 2);
    return {
      target, time: 30,
      v: 90 + Math.min(80, (level - 1) * 8),
      gap: Math.max(0.7, 1.4 - level * 0.05),
      barRate: Math.min(0.62, 0.42 + level * 0.02),
      moveBars: level >= 4,
      slowBelts: level >= 7,
      magnetRate: level >= 4 ? 0.08 : 0
    };
  },
  mount(root, api) { new Dual(root, api); }
};
