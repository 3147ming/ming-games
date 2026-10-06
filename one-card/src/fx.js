// Canvas 2D 动效层
// 口径：Canvas 只承担「每帧变形」的东西（飘字、粒子、斩击弧）。
//      静态布局、按钮、滚动手牌的交互全部留给 DOM —— 那部分在 DOM 上是免费的。
//      循环只在有活跃特效时运行，静止时立刻停掉 RAF（手机省电）。

export class Fx {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.items = [];
    this.raf = 0;
    this.last = 0;
    this.dpr = 1;
    // 阶段 5：尊重 prefers-reduced-motion —— 开了就只留飘字，去掉所有位移/抖动/粒子。
    // 该项在 fx 层是「视觉噪声」门槛，与结算无关（Math.random 也不进 run state）。
    this._reduced = false;
    try {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      this._reduced = !!mq.matches;
      mq.addEventListener?.('change', (e) => { this._reduced = !!e.matches; });
    } catch { /* 旧浏览器无 matchMedia，按默认（false）处理 */ }
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  get reduced() { return this._reduced; }

  resize() {
    const c = this.canvas;
    if (!c) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    const w = c.clientWidth || 360;
    const h = c.clientHeight || 480;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w;
    this.h = h;
  }

  /** 伤害飘字（big=大伤害：字号 1.4x + 轻微震动，reduced-motion 下不震） */
  float(x, y, text, color = '#e8e3da', size = 22, big = false) {
    this.items.push({ k: 'text', x, y, baseX: x, text, color, size, big, t: 0, life: big ? 1.05 : 0.95, vy: -46 });
    this.start();
  }

  /** 命中粒子（reduced-motion 下整类跳过） */
  burst(x, y, color = '#d1544a', count = 12) {
    if (this._reduced) return;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 40 + Math.random() * 130;
      this.items.push({
        k: 'p',
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 30,
        color,
        r: 1.5 + Math.random() * 2.6,
        t: 0,
        life: 0.5 + Math.random() * 0.35,
      });
    }
    this.start();
  }

  /** 斩击弧线 */
  slash(x, y, color = '#d1544a') {
    if (this._reduced) return;
    this.items.push({ k: 'slash', x, y, color, t: 0, life: 0.28, rot: -0.5 + Math.random() });
    this.start();
  }

  /** 格挡护盾环 */
  ring(x, y, color = '#5b93d6') {
    if (this._reduced) return;
    this.items.push({ k: 'ring', x, y, color, t: 0, life: 0.42 });
    this.start();
  }

  /** 中毒绿雾（阶段 5 / T1）：缓慢上升的绿粒，只作氛围，不进结算 */
  mist(x, y, color = '#7ba64a') {
    if (this._reduced) return;
    const n = 3;
    for (let i = 0; i < n; i++) {
      this.items.push({
        k: 'mist',
        x: x + (Math.random() - 0.5) * 22,
        y: y + (Math.random() - 0.5) * 12,
        vx: (Math.random() - 0.5) * 8,
        vy: -12 - Math.random() * 12,
        color,
        r: 3 + Math.random() * 3.5,
        t: 0,
        life: 0.9 + Math.random() * 0.5,
      });
    }
    this.start();
  }

  clear() {
    this.items.length = 0;
    const { ctx } = this;
    ctx.clearRect(0, 0, this.w, this.h);
  }

  start() {
    if (this.raf) return;
    this.last = performance.now();
    const step = (now) => {
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.update(dt);
      this.render();
      if (this.items.length) this.raf = requestAnimationFrame(step);
      else {
        this.raf = 0;
        this.ctx.clearRect(0, 0, this.w, this.h);
      }
    };
    this.raf = requestAnimationFrame(step);
  }

  update(dt) {
    for (const it of this.items) {
      it.t += dt;
      if (it.k === 'p') {
        it.x += it.vx * dt;
        it.y += it.vy * dt;
        it.vy += 380 * dt;
        it.vx *= 0.98;
      } else if (it.k === 'mist') {
        it.x += it.vx * dt;
        it.y += it.vy * dt;
        it.vy *= 0.99;
        it.x += Math.sin(it.t * 3 + it.r) * 6 * dt; // 轻微飘移
      } else if (it.k === 'text') {
        it.y += it.vy * dt;
        it.vy *= 0.9;
      }
    }
    this.items = this.items.filter((it) => it.t < it.life);
  }

  render() {
    const { ctx } = this;
    ctx.clearRect(0, 0, this.w, this.h);
    for (const it of this.items) {
      const p = it.t / it.life;
      const alpha = 1 - p;
      ctx.globalAlpha = alpha;
      if (it.k === 'text') {
        const shake = it.big && !this._reduced ? Math.sin(it.t * 46) * 3 : 0;
        ctx.fillStyle = it.color;
        ctx.font = `500 ${it.size}px -apple-system, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(it.text, it.baseX + shake, it.y);
      } else if (it.k === 'p') {
        ctx.fillStyle = it.color;
        ctx.beginPath();
        ctx.arc(it.x, it.y, it.r * (1 - p * 0.6), 0, Math.PI * 2);
        ctx.fill();
      } else if (it.k === 'mist') {
        ctx.fillStyle = it.color;
        ctx.globalAlpha = alpha * 0.5;
        ctx.beginPath();
        ctx.arc(it.x, it.y, it.r * (1 + p * 0.5), 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = alpha;
      } else if (it.k === 'slash') {
        ctx.strokeStyle = it.color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        const r = 34 + p * 14;
        ctx.arc(it.x, it.y, r, it.rot + p * 1.1, it.rot + p * 1.1 + 1.5);
        ctx.stroke();
      } else if (it.k === 'ring') {
        ctx.strokeStyle = it.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(it.x, it.y, 22 + p * 22, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }
}
