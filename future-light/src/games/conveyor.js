// 05 对色入库 —— 传送带颜色分拣（二叉树齿轮路由；异色工厂/掉出扣红心，3 次容错；可暂停）
// 渲染层：卡通场景（差异化工厂造型 / 卡车 / 天空草地树木 / 旋转齿轮 / 方块箱）
// ⚠️ 本文件所有装饰只影响 render()，绝不参与坐标计算与点击命中
//    （点击判定只用 this.nodes 里齿轮的 (x,y) 距离阈值，见 bind()）
const CW = 400, CH = 470;
const COLOR_NAME = { yellow: '黄', purple: '紫', gray: '灰', green: '绿', brown: '棕', dark: '深红' };
const COLOR_HEX = { yellow: '#ffd54a', purple: '#b06bff', gray: '#9aa6c0', green: '#5dffa0', brown: '#c08552', dark: '#ff5d73' };
const COLOR_POOL = ['yellow', 'purple', 'gray', 'green', 'brown', 'dark'];

// 颜色明暗调节：f<1 变暗，f>1 变亮
function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  r = Math.max(0, Math.min(255, Math.round(r * f)));
  g = Math.max(0, Math.min(255, Math.round(g * f)));
  b = Math.max(0, Math.min(255, Math.round(b * f)));
  return `rgb(${r},${g},${b})`;
}

class Conveyor {
  constructor(root, api) {
    this.root = root; this.api = api; this.cfg = api.cfg;
    this.ended = false; this.raf = 0; this.last = 0; this.t = 0; this.dash = 0;
    this.hearts = 3; this.delivered = 0; this.spawnT = 0.8; this.paused = false; this.showArrow = true;
    // 卡车状态：车身色开局随机取本关颜色之一；货箱色 = 最近一次成功入库的箱子色
    this.truckBody = this.cfg.colors[(Math.random() * this.cfg.colors.length) | 0];
    this.truckColor = null; this.truckX = 0;
    this.boxes = []; this.build(); this.bind();
    this.last = performance.now(); this.loop = this.loop.bind(this); this.raf = requestAnimationFrame(this.loop);
    this.api.setClock(null);
  }

  build() {
    const cfg = this.cfg;
    this.root.innerHTML = `
      <div class="grid-wrap cv-wrap">
        <div class="cv-tip">点击齿轮切换岔路方向，让同色箱子进入对应颜色工厂。送错或掉出扣 ❤️（共 3 次）。</div>
        <canvas class="cv-cv" width="${CW}" height="${CH}"></canvas>
        <div class="cv-bar">
          <button class="gbtn" id="cv-pause">⏸ 暂停</button>
          <button class="gbtn" id="cv-arrow">指引：开</button>
        </div>
      </div>`;
    this.cv = this.root.querySelector('.cv-cv'); this.ctx = this.cv.getContext('2d');
    this.buildTree();
    this.updateHud();
  }

  buildTree() {
    const gears = this.cfg.gears;
    const colors = this.cfg.colors;
    let idc = 0; const nodes = []; let ic = 0; const MAXD = 5;
    const mk = t => { const n = { id: idc++, type: t }; nodes.push(n); return n; };
    const build = (depth) => {
      if (ic < gears && depth < MAXD) {
        const n = mk('gear'); n.depth = depth; n.state = Math.random() < 0.5 ? 'L' : 'R'; ic++;
        n.left = build(depth + 1); n.right = build(depth + 1); return n;
      }
      return mk('leaf');
    };
    this.root2 = build(0);
    const leaves = [];
    const collect = n => { if (n.type === 'leaf') leaves.push(n); else { collect(n.left); collect(n.right); } };
    collect(this.root2);
    const L = leaves.length;
    // 颜色分配：保证每种出现至少一次
    const cols = [...colors];
    while (cols.length < L) cols.push(colors[(cols.length - colors.length) % colors.length]);
    for (let i = cols.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [cols[i], cols[j]] = [cols[j], cols[i]]; }
    leaves.forEach((l, i) => { l.color = cols[i]; l.x = (i + 0.5) / L * CW; l.y = CH - 36; });
    const pos = n => { if (n.type === 'leaf') return; n.x = (n.left.x + n.right.x) / 2; n.y = 36 + n.depth * ((CH - 90) / MAXD); pos(n.left); pos(n.right); };
    pos(this.root2);
    this.nodes = nodes; this.leaves = leaves;
    // 静态树木：只放在工厂间隙（叶节点之间的空档），不与工厂重叠
    const gaps = [];
    for (let i = 1; i < L; i += 2) gaps.push(i);
    this.trees = gaps.slice(0, L >= 4 ? 3 : 2).map((i, k) => ({
      x: (leaves[i - 1].x + leaves[i].x) / 2 + (Math.random() * 10 - 5),
      c: ['#2f7d4a', '#276b3f', '#35915a'][k % 3],
      dy: Math.random() * 6
    }));
  }

  pathFor(state) {
    const path = [this.root2]; let n = this.root2;
    while (n.type === 'gear') { n = n.state === 'L' ? n.left : n.right; path.push(n); }
    return path;
  }

  spawn() {
    const color = this.cfg.colors[(Math.random() * this.cfg.colors.length) | 0];
    const path = this.pathFor(null); // 路径按当前齿轮状态在每帧实时计算（允许中途变向）
    this.boxes.push({ color, seg: 0, p: 0, done: false, x: this.root2.x, y: this.root2.y });
  }

  bind() {
    const onClick = e => {
      if (this.ended) return;
      const r = this.cv.getBoundingClientRect();
      const sx = (e.clientX - r.left) * (this.cv.width / r.width);
      const sy = (e.clientY - r.top) * (this.cv.height / r.height);
      for (const n of this.nodes) {
        if (n.type !== 'gear') continue;
        if (Math.hypot(sx - n.x, sy - n.y) < 22) { n.state = n.state === 'L' ? 'R' : 'L'; this.beep(); return; }
      }
    };
    this.cv.addEventListener('pointerdown', onClick);
    this._clean = () => this.cv.removeEventListener('pointerdown', onClick);
    this.api.onDestroy(this._clean);
    this.root.querySelector('#cv-pause').onclick = e => { this.paused = !this.paused; e.target.textContent = this.paused ? '▶ 继续' : '⏸ 暂停'; };
    this.root.querySelector('#cv-arrow').onclick = e => { this.showArrow = !this.showArrow; e.target.textContent = '指引：' + (this.showArrow ? '开' : '关'); };
  }

  beep() { try { const a = new (window.AudioContext || window.webkitAudioContext)(); const o = a.createOscillator(); o.frequency.value = 660; const g = a.createGain(); g.gain.value = 0.06; o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + 0.08); } catch (e) {} }

  updateHud() {
    this.api.setHud(`<div class="stat"><span class="k">✅ 入库</span><b id="cv-d">${this.delivered}</b>/${this.cfg.target}</div>
      <div class="stat"><span class="k">❤️ 容错</span><b>${'❤️'.repeat(this.hearts)}</b></div>
      ${this.paused ? '<div class="stat warn">⏸ 已暂停</div>' : ''}`);
  }

  loop(now) {
    if (this.ended) return;
    const dt = Math.min(0.05, (now - this.last) / 1000); this.last = now; this.t += dt; this.dash = (this.dash + dt * 60) % 16;
    if (!this.paused) this.update(dt);
    this.render();
    this.raf = requestAnimationFrame(this.loop);
  }

  update(dt) {
    this.spawnT -= dt;
    if (this.spawnT <= 0) { this.spawn(); this.spawnT = this.cfg.interval; }
    const speed = 130;
    for (const b of this.boxes) {
      if (b.done) continue;
      const path = this.pathFor(); // 当前齿轮状态
      const a = nodeAt(path, b.seg), bb = nodeAt(path, b.seg + 1);
      if (!bb) { b.done = true; this.resolve(b, path[path.length - 1]); continue; }
      const len = Math.hypot(bb.x - a.x, bb.y - a.y) || 1;
      b.p += speed * dt / len; b.x = a.x + (bb.x - a.x) * b.p; b.y = a.y + (bb.y - a.y) * b.p;
      if (b.p >= 1) { b.seg++; b.p = 0; if (b.seg >= path.length - 1) { b.done = true; this.resolve(b, path[path.length - 1]); } }
    }
    this.boxes = this.boxes.filter(b => !b._remove);
    this.updateHud();
  }

  resolve(b, leaf) {
    if (b._remove) return; b._remove = true;
    if (leaf.color === b.color) {
      this.delivered++;
      // 卡车：货箱换成刚入库的箱子色，并向前挪 8px（累计 60px 后回到起点重新运一趟）
      this.truckColor = b.color;
      this.truckX += 8; if (this.truckX >= 60) this.truckX = 0;
      this.api.toast('✅ +100');
      if (this.delivered >= this.cfg.target) this.finish();
    } else {
      this.hearts--;
      this.api.toast('❌ ' + COLOR_NAME[b.color] + '箱送入' + COLOR_NAME[leaf.color] + '工厂');
      if (this.hearts <= 0) this.api.lose();
    }
  }

  finish() { if (this.ended) return; this.ended = true; this.api.win(3, this.delivered * 100); }

  /* ================= 渲染层（全部为纯装饰，不影响玩法坐标） ================= */

  render() {
    const c = this.ctx;
    c.clearRect(0, 0, CW, CH);
    this.drawSky();
    this.drawGrass();
    this.drawTrees();
    this.drawBelts();
    this.drawFactories();
    this.drawBoxes();
    this.drawGears();
    this.drawTruck();
  }

  // 深色天空渐变 + 静态星点
  drawSky() {
    const c = this.ctx;
    const g = c.createLinearGradient(0, 0, 0, CH);
    g.addColorStop(0, '#050a18'); g.addColorStop(0.42, '#0c1630'); g.addColorStop(1, '#0a1226');
    c.fillStyle = g; c.fillRect(0, 0, CW, CH);
    c.save();
    for (let i = 0; i < 26; i++) {
      // 固定伪随机星点（同一 i 永远同一位置，避免闪烁噪点）
      const x = ((i * 79) % 397) + 1.5, y = ((i * 53) % 150) + 4;
      const tw = 0.35 + 0.35 * Math.sin(this.t * 1.1 + i);
      c.globalAlpha = tw * 0.5; c.fillStyle = '#cfe0ff';
      c.fillRect(x, y, 1.4, 1.4);
    }
    c.restore();
  }

  // 底部草地（y > CH-40）：工厂与卡车都落在这条带上
  drawGrass() {
    const c = this.ctx, gy = CH - 40;
    const g = c.createLinearGradient(0, gy, 0, CH);
    g.addColorStop(0, '#20563a'); g.addColorStop(1, '#123a24');
    c.fillStyle = g; c.fillRect(0, gy, CW, CH - gy);
    c.fillStyle = '#246b47'; c.fillRect(0, gy, CW, 3);
    c.fillStyle = 'rgba(255,255,255,0.06)'; c.fillRect(0, gy + 3, CW, 1);
    // 草叶
    c.strokeStyle = 'rgba(120,220,150,0.35)'; c.lineWidth = 1;
    for (let x = 6; x < CW; x += 11) {
      const h = 3 + ((x * 7) % 4);
      c.beginPath(); c.moveTo(x, gy + 1); c.lineTo(x + 1.5, gy - h); c.stroke();
    }
  }

  // 工厂间隙的静态树（低透明度，不干扰点击判定）
  drawTrees() {
    const c = this.ctx; c.save(); c.globalAlpha = 0.5;
    for (const t of (this.trees || [])) {
      const baseY = CH - 39 + t.dy;
      c.fillStyle = '#6b4a2f'; c.fillRect(t.x - 3, baseY - 15, 6, 15);
      c.fillStyle = t.c;
      c.beginPath(); c.arc(t.x, baseY - 22, 11, 0, 7); c.fill();
      c.beginPath(); c.arc(t.x - 8, baseY - 16, 7.5, 0, 7); c.fill();
      c.beginPath(); c.arc(t.x + 8, baseY - 16, 7.5, 0, 7); c.fill();
      c.fillStyle = 'rgba(255,255,255,0.16)';
      c.beginPath(); c.arc(t.x - 4, baseY - 26, 4.5, 0, 7); c.fill();
    }
    c.restore();
  }

  // 传送带：流动虚线箭头 + 底衬（更有质感）
  drawBelts() {
    const c = this.ctx;
    c.save();
    c.strokeStyle = 'rgba(20,32,60,0.9)'; c.lineWidth = 9; c.lineCap = 'round';
    const thick = n => { if (n.type === 'leaf') return; for (const ch of [n.left, n.right]) { c.beginPath(); c.moveTo(n.x, n.y); c.lineTo(ch.x, ch.y); c.stroke(); thick(ch); } };
    thick(this.root2);
    c.strokeStyle = 'rgba(126,164,255,0.42)'; c.lineWidth = 3.5;
    c.setLineDash([9, 9]); c.lineDashOffset = -this.dash;
    const thin = n => { if (n.type === 'leaf') return; for (const ch of [n.left, n.right]) { c.beginPath(); c.moveTo(n.x, n.y); c.lineTo(ch.x, ch.y); c.stroke(); thin(ch); } };
    thin(this.root2);
    c.setLineDash([]); c.restore();
  }

  // 工厂（叶节点）：按颜色走不同造型函数
  drawFactories() {
    for (const l of this.leaves) {
      const col = COLOR_HEX[l.color], c = this.ctx;
      c.save();
      c.shadowColor = col; c.shadowBlur = 9;
      let top;
      switch (l.color) {
        case 'yellow': top = this.fYellow(l.x, l.y, col); break;
        case 'purple': top = this.fPurple(l.x, l.y, col); break;
        case 'gray': top = this.fGray(l.x, l.y, col); break;
        case 'green': top = this.fGreen(l.x, l.y, col); break;
        case 'brown': top = this.fBrown(l.x, l.y, col); break;
        default: top = this.fDark(l.x, l.y, col); break;
      }
      c.restore();
      // 门前同色箱子堆（3 个：底下 2 个 + 上面 1 个），强化颜色对应
      const dim = shade(col, 0.78);
      this.crate(l.x - 17, l.y - 3, 12, 9, dim);
      this.crate(l.x - 1, l.y - 3, 12, 9, dim);
      this.crate(l.x - 9, l.y - 12, 12, 9, col);
      // 名称标签（造型上方，12px）
      c.save();
      this.rr(l.x - 21, top - 17, 42, 15, 7);
      c.fillStyle = 'rgba(6,12,26,0.82)'; c.fill();
      c.strokeStyle = col; c.lineWidth = 1; c.stroke();
      c.font = 'bold 12px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'alphabetic';
      c.fillStyle = col; c.fillText(COLOR_NAME[l.color] + '厂', l.x, top - 6);
      c.restore();
    }
  }

  // 黄厂：主楼 + 平檐 + 烟囱（冒烟）
  fYellow(x, y, col) {
    const c = this.ctx;
    c.fillStyle = shade(col, 0.88); this.rr(x - 18, y - 26, 36, 26, 3); c.fill();
    c.fillStyle = shade(col, 0.62); c.fillRect(x - 21, y - 30, 42, 5);
    c.fillStyle = '#8892a8'; this.rr(x + 8, y - 40, 8, 12, 1); c.fill();
    c.fillStyle = 'rgba(0,0,0,0.32)'; c.fillRect(x + 9.5, y - 38, 5, 1.5); c.fillRect(x + 9.5, y - 34, 5, 1.5);
    c.fillStyle = 'rgba(10,16,30,0.75)'; this.rr(x - 6, y - 12, 12, 12, 2); c.fill();
    c.fillStyle = 'rgba(10,16,30,0.55)'; c.fillRect(x - 14, y - 22, 6, 6); c.fillRect(x + 8, y - 22, 6, 6);
    this.smoke(x + 12, y - 42);
    return y - 58;   // 含烟雾最高点，名称标签据此上移
  }

  // 紫厂：圆顶塔楼 + 尖顶 + 顶珠
  fPurple(x, y, col) {
    const c = this.ctx;
    c.fillStyle = shade(col, 0.88); this.rr(x - 14, y - 30, 28, 30, 2); c.fill();
    c.fillStyle = shade(col, 0.68);
    c.beginPath(); c.arc(x, y - 30, 14, Math.PI, 0); c.closePath(); c.fill();
    c.fillStyle = shade(col, 1.12);
    c.beginPath(); c.moveTo(x - 5, y - 41); c.lineTo(x + 5, y - 41); c.lineTo(x, y - 53); c.closePath(); c.fill();
    c.fillStyle = '#ffe9a8'; c.beginPath(); c.arc(x, y - 55, 2.6, 0, 7); c.fill();
    c.fillStyle = 'rgba(10,16,30,0.7)'; this.rr(x - 5, y - 13, 10, 13, 5); c.fill();
    c.fillStyle = 'rgba(255,255,255,0.38)'; c.fillRect(x - 9, y - 24, 5, 6); c.fillRect(x + 4, y - 24, 5, 6);
    return y - 58;
  }

  // 灰厂：方形仓库 + 平顶 + 百叶仓库门
  fGray(x, y, col) {
    const c = this.ctx;
    c.fillStyle = shade(col, 0.8); this.rr(x - 20, y - 24, 40, 24, 2); c.fill();
    c.fillStyle = shade(col, 1.14); c.fillRect(x - 23, y - 28, 46, 4);
    c.fillStyle = 'rgba(255,255,255,0.14)'; c.fillRect(x - 23, y - 28, 46, 1);
    c.fillStyle = 'rgba(10,16,30,0.72)'; this.rr(x - 13, y - 15, 26, 15, 1); c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.2)'; c.lineWidth = 1;
    for (let i = 1; i < 4; i++) { c.beginPath(); c.moveTo(x - 12.5, y - 15 + i * 3.75); c.lineTo(x + 12.5, y - 15 + i * 3.75); c.stroke(); }
    c.fillStyle = 'rgba(10,16,30,0.5)'; c.fillRect(x - 17, y - 21, 6, 6);
    return y - 28;
  }

  // 绿厂：尖顶小屋 + 砖烟囱（冒烟）
  fGreen(x, y, col) {
    const c = this.ctx;
    c.fillStyle = shade(col, 0.86); this.rr(x - 16, y - 22, 32, 22, 2); c.fill();
    c.fillStyle = shade(col, 0.58);
    c.beginPath(); c.moveTo(x - 22, y - 21); c.lineTo(x, y - 42); c.lineTo(x + 22, y - 21); c.closePath(); c.fill();
    c.fillStyle = '#b4643c'; this.rr(x + 9, y - 33, 7, 10, 1); c.fill();
    c.fillStyle = 'rgba(10,16,30,0.7)'; this.rr(x - 5, y - 12, 10, 12, 4); c.fill();
    c.fillStyle = 'rgba(255,255,255,0.42)'; c.fillRect(x + 5, y - 17, 7, 6);
    this.smoke(x + 12.5, y - 35);
    return y - 51;   // 含烟雾最高点
  }

  // 棕厂：谷仓（弧形顶 + X 形大门 + 阁楼窗）
  fBrown(x, y, col) {
    const c = this.ctx;
    c.fillStyle = shade(col, 0.84); this.rr(x - 20, y - 26, 40, 26, 2); c.fill();
    c.fillStyle = shade(col, 0.56);
    c.beginPath(); c.moveTo(x - 22, y - 25);
    c.quadraticCurveTo(x, y - 52, x + 22, y - 25);
    c.closePath(); c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.16)'; c.lineWidth = 1; c.stroke();
    c.strokeStyle = 'rgba(10,16,30,0.62)'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(x - 11, y - 1); c.lineTo(x + 11, y - 18);
    c.moveTo(x + 11, y - 1); c.lineTo(x - 11, y - 18); c.stroke();
    c.fillStyle = 'rgba(10,16,30,0.55)'; c.fillRect(x - 4, y - 23, 8, 6);
    return y - 39;
  }

  // 深红厂：锯齿厂房顶 + 烟囱（冒烟）+ 双窗
  fDark(x, y, col) {
    const c = this.ctx;
    c.fillStyle = shade(col, 0.82); this.rr(x - 21, y - 24, 42, 24, 2); c.fill();
    c.fillStyle = shade(col, 0.58);
    c.beginPath(); c.moveTo(x - 23, y - 24);
    c.lineTo(x - 13, y - 34); c.lineTo(x - 3, y - 24);
    c.lineTo(x + 7, y - 34); c.lineTo(x + 17, y - 24);
    c.lineTo(x + 23, y - 30); c.lineTo(x + 23, y - 24);
    c.closePath(); c.fill();
    c.fillStyle = '#8892a8'; this.rr(x - 19, y - 42, 8, 20, 1); c.fill();
    c.fillStyle = 'rgba(0,0,0,0.3)'; c.fillRect(x - 18, y - 40, 6, 1.5); c.fillRect(x - 18, y - 36, 6, 1.5);
    c.fillStyle = 'rgba(255,236,180,0.88)'; c.fillRect(x - 12, y - 19, 9, 7); c.fillRect(x + 3, y - 19, 9, 7);
    c.fillStyle = 'rgba(10,16,30,0.72)'; this.rr(x - 6, y - 10, 12, 10, 1); c.fill();
    this.smoke(x - 15, y - 44);
    return y - 60;   // 含烟雾最高点
  }

  // 烟囱冒烟（由 this.t 驱动）。上升高度受限，避免与上方名称标签重叠
  smoke(x, y) {
    const c = this.ctx; c.save();
    for (let i = 0; i < 3; i++) {
      const ph = (this.t * 0.42 + i / 3) % 1;
      const py = y - ph * 15, px = x + Math.sin(ph * 5.5 + i * 2) * 2.6, r = 1.8 + ph * 3.4;
      c.globalAlpha = (1 - ph) * 0.42; c.fillStyle = '#dfe8ff';
      c.beginPath(); c.arc(px, py, r, 0, 7); c.fill();
    }
    c.restore();
  }

  // 箱子：正方形 + 描边 + 对角折线（替代原来的圆形）
  crate(x, y, w, h, col) {
    const c = this.ctx; c.save();
    this.rr(x, y, w, h, 2);
    c.fillStyle = col; c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.45)'; c.lineWidth = 1.2; c.stroke();
    c.beginPath();
    c.moveTo(x + 1.5, y + 1.5); c.lineTo(x + w / 2, y + h * 0.44);
    c.lineTo(x + w - 1.5, y + 1.5);
    c.moveTo(x + w / 2, y + h * 0.44); c.lineTo(x + w / 2, y + h - 1.5);
    c.strokeStyle = 'rgba(0,0,0,0.32)'; c.lineWidth = 1; c.stroke();
    c.fillStyle = 'rgba(255,255,255,0.2)'; c.fillRect(x + 1.2, y + 1.2, w - 2.4, 1.4);
    c.restore();
  }

  drawBoxes() {
    const c = this.ctx;
    for (const b of this.boxes) {
      if (b._remove) continue;
      this.crate(b.x - 8, b.y - 8, 16, 16, COLOR_HEX[b.color]);
      if (this.showArrow) {
        const path = this.pathFor(); const leaf = path[path.length - 1];
        c.save();
        c.strokeStyle = 'rgba(255,255,255,0.4)'; c.lineWidth = 1.2;
        c.setLineDash([3, 4]); c.beginPath(); c.moveTo(b.x, b.y - 12); c.lineTo(leaf.x, leaf.y - 26); c.stroke();
        c.setLineDash([]);
        c.fillStyle = 'rgba(255,255,255,0.5)';
        c.beginPath(); c.arc(leaf.x, leaf.y - 26, 2, 0, 7); c.fill();
        c.restore();
      }
    }
  }

  // 齿轮：齿圈随 this.t 旋转（活跃时转更快 + 亮绿环），方向箭头保持水平可读
  drawGears() {
    const c = this.ctx;
    const activeGears = new Set();
    for (const b of this.boxes) {
      if (b._remove) continue;
      const path = this.pathFor(); const a = nodeAt(path, b.seg);
      if (a && a.type === 'gear') activeGears.add(a.id);
    }
    for (const n of this.nodes) {
      if (n.type !== 'gear') continue;
      const glow = activeGears.has(n.id) && !this.paused;
      // 齿圈
      c.save();
      c.translate(n.x, n.y);
      c.rotate(this.t * (glow ? 2.6 : 0.5) + n.id * 0.8);
      c.fillStyle = glow ? 'rgba(56,249,215,0.92)' : 'rgba(120,160,255,0.7)';
      const teeth = 8, R = 20, r0 = 15;
      for (let i = 0; i < teeth; i++) {
        const a0 = (i / teeth) * Math.PI * 2, a1 = ((i + 0.44) / teeth) * Math.PI * 2;
        c.beginPath(); c.arc(0, 0, R, a0, a1); c.arc(0, 0, r0, a1, a0, true); c.closePath(); c.fill();
      }
      c.restore();
      // 轮毂
      c.beginPath(); c.arc(n.x, n.y, 11.5, 0, 7);
      c.fillStyle = glow ? 'rgba(16,72,64,0.96)' : 'rgba(28,38,66,0.96)'; c.fill();
      c.strokeStyle = glow ? '#38f9d7' : 'rgba(120,160,255,0.55)'; c.lineWidth = 2; c.stroke();
      if (glow) { c.shadowColor = '#38f9d7'; c.shadowBlur = 12; c.stroke(); c.shadowBlur = 0; }
      // 方向箭头（不随齿圈旋转，保持可读）
      c.fillStyle = '#e8eeff'; c.font = 'bold 15px sans-serif';
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(n.state === 'L' ? '⟵' : '⟶', n.x, n.y);
      c.textBaseline = 'alphabetic';
    }
  }

  // 底部装饰卡车：车头 + 货箱 + 车轮；每次正确入库向前挪 8px
  drawTruck() {
    const c = this.ctx;
    const x = 24 + this.truckX, yb = CH - 8;
    const body = COLOR_HEX[this.truckBody] || '#7f8db3';
    const cargo = this.truckColor ? COLOR_HEX[this.truckColor] : shade(body, 0.75);
    c.save();
    // 地面阴影
    c.fillStyle = 'rgba(0,0,0,0.28)'; this.rr(x - 3, yb + 1, 48, 4, 3); c.fill();
    // 底盘
    c.fillStyle = '#2b3550'; this.rr(x, yb - 9, 44, 6, 2); c.fill();
    // 货箱
    this.crate(x + 1, yb - 25, 20, 15, cargo);
    // 驾驶室
    c.fillStyle = body; this.rr(x + 23, yb - 21, 20, 12, 3); c.fill();
    c.fillStyle = 'rgba(255,255,255,0.5)'; c.fillRect(x + 33, yb - 19, 8, 5);
    c.fillStyle = 'rgba(0,0,0,0.25)'; c.fillRect(x + 23, yb - 12, 20, 1.5);
    // 车轮
    for (const wx of [x + 8, x + 35]) {
      c.beginPath(); c.arc(wx, yb - 4, 4.6, 0, 7);
      c.fillStyle = '#141a2b'; c.fill();
      c.strokeStyle = 'rgba(255,255,255,0.34)'; c.lineWidth = 1; c.stroke();
    }
    c.restore();
  }

  rr(x, y, w, h, r) { const c = this.ctx; c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
}

function nodeAt(path, i) { return path[i]; }

export default {
  id: 'conveyor', name: '对色入库', icon: '📦', tag: '物流·分拣',
  desc: '切换齿轮岔路，把每个颜色的箱子送进同色工厂。',
  maxLevel: 10,
  config(level) {
    const gears = Math.min(5, 1 + Math.floor((level - 1) / 2));
    const colorN = level <= 3 ? 2 : level <= 6 ? 3 : 4;
    // 颜色池按关卡轮转，保证 6 种工厂造型都能在不同关卡出现
    const start = (level - 1) % COLOR_POOL.length;
    const pool = []; for (let i = 0; i < COLOR_POOL.length; i++) pool.push(COLOR_POOL[(start + i) % COLOR_POOL.length]);
    const colors = pool.slice(0, colorN);
    return { gears, colors, interval: Math.max(2, 5 - (level - 1) * 0.3), target: Math.min(15, 3 + (level - 1)) };
  },
  mount(root, api) {
    const inst = new Conveyor(root, api);
    // 调试/自动化钩子：供无头探针读取内部状态（不影响玩法）
    if (typeof window !== 'undefined') window.__cv = inst;
    return inst;
  }
};
