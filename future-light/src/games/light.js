// 04 点石成金 —— 光线反射解谜（彻底统一为：光源→直线→镜子90°反射→点亮外圈接收点）
// 4×4 棋盘 + 外圈 16 接收点；玩家放置/切换/移除镜子；胜利=目标接收点全亮
const N = 4, M = 44, CELL = 78, BOARD = M + N * CELL; // 画布逻辑尺寸 BOARD×BOARD

function reflect(m, d) {
  // d = {dr, dc}
  if (m === '/') return { dr: d.dc, dc: d.dr };
  return { dr: -d.dc, dc: -d.dr }; // '\'
}
// 光源起始格 + 入射方向
function srcStart(edge, idx) {
  if (edge === 'bottom') return { r: N - 1, c: idx, dr: -1, dc: 0 };
  if (edge === 'top') return { r: 0, c: idx, dr: 1, dc: 0 };
  if (edge === 'left') return { r: idx, c: 0, dr: 0, dc: 1 };
  return { r: idx, c: N - 1, dr: 0, dc: -1 }; // right
}
function edgeKey(edge, idx) {
  return edge[0].toUpperCase() + idx; // T/B/L/R + idx
}

class Light {
  constructor(root, api) {
    this.root = root; this.api = api; this.cfg = api.cfg;
    this.ended = false; this.raf = 0; this.last = 0; this.t = 0;
    this.board = Array.from({ length: N }, () => Array(N).fill(0));
    this.placed = 0;
    this.gen();
    this.build();
    this.bind();
    this.time = this.cfg.time;
    this.last = performance.now();
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
    if (this.cfg.time > 0) this.api.setClock(this.cfg.time); else this.api.setClock(null);
  }

  build() {
    const showPath = this.cfg.showPath;
    this.root.innerHTML = `
      <div class="grid-wrap lt-wrap">
        <div class="lt-tip">${this.cfg.tip}</div>
        <canvas class="lt-cv" width="${BOARD}" height="${BOARD}"></canvas>
        <div class="lt-legend">
          <span>🟢 光源</span><span>🟡 镜子(点放/切换/移除)</span>
          <span>⭕ 接收点</span><span>剩余镜子：<b id="lt-m">${this.cfg.mirrorLimit}</b></span>
        </div>
      </div>`;
    this.cv = this.root.querySelector('.lt-cv');
    this.ctx = this.cv.getContext('2d');
    this.api.setHud(`<div class="stat"><span class="k">🎯 目标点亮</span><b id="lt-lit">0</b>/${this.target.size}</div>
      <div class="stat"><span class="k">🪞 镜子</span><b id="lt-left">${this.cfg.mirrorLimit}</b></div>`);
  }

  // 生成可解关卡：随机放镜→追踪→记录亮灯→移除为题目，保证有解
  gen() {
    const lv = this.api.level;
    const targetArr = [1, 2, 3, 4, 6, 7, 8, 9, 10, 10];
    const mirrorArr = [3, 2, 3, 4, 5, 5, 6, 6, 7, 7];
    const timeArr = [0, 60, 55, 55, 60, 55, 50, 50, 45, 45];
    const target = targetArr[Math.min(9, lv - 1)];
    this.cfg.mirrorLimit = mirrorArr[Math.min(9, lv - 1)];
    this.cfg.time = timeArr[Math.min(9, lv - 1)];
    this.cfg.showPath = lv <= 3;

    if (lv === 1) {
      // 教学关：1 光源(底·0列)上行，1 接收点(右·0行)，1 镜子('/' 于 0,0)，无倒计时
      this.sources = [{ edge: 'bottom', idx: 0, ...srcStart('bottom', 0) }];
      this.target = new Set(['R0']);
      this.hintCell = { r: 0, c: 0 };
      this.cfg.tip = '教学关：点击下方高亮格子放置镜子，再次点击切换「/」「\\」，第三次点击移除。让光线点亮右侧金点！';
      return;
    }

    const srcCount = lv < 5 ? 1 : 2;
    const edges = ['bottom', 'top', 'left', 'right'];
    let best = null;
    for (let attempt = 0; attempt < 240; attempt++) {
      const board = Array.from({ length: N }, () => Array(N).fill(0));
      const cells = [];
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) cells.push([r, c]);
      // 洗牌取镜子格
      for (let i = cells.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [cells[i], cells[j]] = [cells[j], cells[i]]; }
      const solMirrors = [];
      for (let i = 0; i < this.cfg.mirrorLimit; i++) { const [r, c] = cells[i]; const o = Math.random() < 0.5 ? '/' : '\\'; board[r][c] = o; solMirrors.push({ r, c, o }); }
      const sources = [];
      for (let s = 0; s < srcCount; s++) { const e = edges[(Math.random() * 4) | 0]; const idx = (Math.random() * N) | 0; sources.push({ edge: e, idx, ...srcStart(e, idx) }); }
      const lit = this.trace(board, sources);
      const score = -Math.abs(lit.size - target) - (lit.size > 12 ? (lit.size - 12) * 2 : 0);
      if (!best || score > best.score) best = { board, sources, lit, solMirrors, score };
      if (lit.size === target) break;
    }
    this.sources = best.sources;
    this.solMirrors = best.solMirrors;
    // 题目：点亮集合 = 解所能点亮的全部；镜子上限 = 解所用镜子数（保证可复现）
    this.target = best.lit.size > 0 ? new Set(best.lit) : new Set(['R0']);
    this.cfg.mirrorLimit = Math.max(1, best.solMirrors.length);
    this.hintCell = null;
    this.cfg.tip = this.cfg.showPath ? '前 3 关实时显示光路（半透明），把金色接收点全部点亮' : '高难关卡隐藏实时光路，仅显示已点亮接收点，靠推理放置镜子';
  }

  trace(board, sources) {
    const lit = new Set();
    for (const s of sources) {
      let pos = { r: s.r, c: s.c }, d = { dr: s.dr, dc: s.dc }, steps = 0;
      const path = [{ r: pos.r, c: pos.c }];
      while (steps++ < 80) {
        const m = board[pos.r][pos.c];
        if (m) d = reflect(m, d);
        path.push({ r: pos.r, c: pos.c, mirror: !!m });
        const nr = pos.r + d.dr, nc = pos.c + d.dc;
        if (nr < 0 || nr >= N || nc < 0 || nc >= N) {
          let key;
          if (nr < 0) key = edgeKey('top', pos.c);
          else if (nr >= N) key = edgeKey('bottom', pos.c);
          else if (nc < 0) key = edgeKey('left', pos.r);
          else key = edgeKey('right', pos.r);
          lit.add(key); break;
        }
        pos = { r: nr, c: nc };
      }
      s._path = path;
    }
    return lit;
  }

  bind() {
    const onClick = e => {
      if (this.ended) return;
      const r = this.cv.getBoundingClientRect();
      const sx = (e.clientX - r.left) * (this.cv.width / r.width);
      const sy = (e.clientY - r.top) * (this.cv.height / r.height);
      const c = Math.floor((sx - M) / CELL), row = Math.floor((sy - M) / CELL);
      if (c < 0 || c >= N || row < 0 || row >= N) return;
      const cur = this.board[row][c];
      if (!cur) {
        if (this.placed >= this.cfg.mirrorLimit) { this.api.toast('镜子已用完'); return; }
        this.board[row][c] = '/'; this.placed++;
      } else if (cur === '/') this.board[row][c] = '\\';
      else { this.board[row][c] = 0; this.placed--; }
      this.refresh();
    };
    this.cv.addEventListener('pointerdown', onClick);
    this._clean = () => this.cv.removeEventListener('pointerdown', onClick);
    this.api.onDestroy(this._clean);
  }

  refresh() {
    const lit = this.trace(this.board, this.sources);
    let cnt = 0; this.target.forEach(k => { if (lit.has(k)) cnt++; });
    const litEl = this.root.querySelector('#lt-lit'); if (litEl) litEl.textContent = cnt;
    const leftEl = this.root.querySelector('#lt-left'); if (leftEl) leftEl.textContent = this.cfg.mirrorLimit - this.placed;
    this.curLit = lit;
    if (cnt >= this.target.size && this.target.size > 0) this.finish(lit);
  }

  finish(lit) {
    if (this.ended) return; this.ended = true;
    const stars = this.cfg.time > 0 ? (this.time > this.cfg.time * 0.5 ? 3 : this.time > this.cfg.time * 0.2 ? 2 : 1) : 3;
    const score = this.target.size * 100 + (this.cfg.time > 0 ? Math.ceil(this.time) * 3 : 60);
    this.api.win(stars, score);
  }

  loop(now) {
    if (this.ended) return;
    const dt = Math.min(0.05, (now - this.last) / 1000); this.last = now; this.t += dt;
    if (this.cfg.time > 0) { this.time -= dt; this.api.setClock(this.time); if (this.time <= 0) { this.time = 0; this.api.setClock(0); this.api.lose(); return; } }
    this.render();
    this.raf = requestAnimationFrame(this.loop);
  }

  render() {
    const c = this.ctx; c.clearRect(0, 0, BOARD, BOARD);
    c.fillStyle = '#0a1226'; c.fillRect(0, 0, BOARD, BOARD);
    // 棋盘格
    for (let r = 0; r < N; r++) for (let cc = 0; cc < N; cc++) {
      c.fillStyle = (r + cc) % 2 ? 'rgba(28,38,66,0.6)' : 'rgba(18,26,48,0.6)';
      c.fillRect(M + cc * CELL, M + r * CELL, CELL, CELL);
    }
    c.strokeStyle = 'rgba(120,160,255,0.18)'; c.lineWidth = 1;
    for (let i = 0; i <= N; i++) { c.beginPath(); c.moveTo(M + i * CELL, M); c.lineTo(M + i * CELL, M + N * CELL); c.stroke(); c.beginPath(); c.moveTo(M, M + i * CELL); c.lineTo(M + N * CELL, M + i * CELL); c.stroke(); }
    // 教学高亮
    if (this.hintCell) {
      const px = M + this.hintCell.c * CELL, py = M + this.hintCell.r * CELL;
      const a = 0.4 + 0.3 * Math.sin(this.t * 4);
      c.strokeStyle = `rgba(56,249,215,${a})`; c.lineWidth = 3; c.strokeRect(px + 3, py + 3, CELL - 6, CELL - 6);
    }
    // 实时光路（仅前 3 关）
    if (this.cfg.showPath) {
      this.trace(this.board, this.sources);
      for (const s of this.sources) {
        if (!s._path) continue;
        c.strokeStyle = 'rgba(56,249,215,0.4)'; c.lineWidth = 3; c.beginPath();
        s._path.forEach((p, i) => { const x = M + p.c * CELL + CELL / 2, y = M + p.r * CELL + CELL / 2; i ? c.lineTo(x, y) : c.moveTo(x, y); });
        c.stroke();
      }
    }
    // 镜子
    for (let r = 0; r < N; r++) for (let cc = 0; cc < N; cc++) {
      const m = this.board[r][cc]; if (!m) continue;
      const x = M + cc * CELL, y = M + r * CELL;
      c.strokeStyle = '#ffd54a'; c.lineWidth = 6; c.lineCap = 'round';
      c.beginPath();
      if (m === '/') { c.moveTo(x + 10, y + CELL - 10); c.lineTo(x + CELL - 10, y + 10); }
      else { c.moveTo(x + 10, y + 10); c.lineTo(x + CELL - 10, y + CELL - 10); }
      c.stroke();
    }
    // 接收点
    const lit = this.curLit || this.trace(this.board, this.sources);
    const drawRec = (x, y, key) => {
      const on = lit.has(key) && this.target.has(key);
      c.beginPath(); c.arc(x, y, 13, 0, 7);
      if (on) { c.fillStyle = '#ffd54a'; c.fill(); c.shadowColor = '#ffd54a'; c.shadowBlur = 14; c.fill(); c.shadowBlur = 0; }
      else { c.strokeStyle = 'rgba(160,180,220,0.7)'; c.lineWidth = 3; c.stroke(); }
    };
    for (let i = 0; i < N; i++) { drawRec(M + i * CELL + CELL / 2, 22, 'T' + i); drawRec(M + i * CELL + CELL / 2, BOARD - 22, 'B' + i); drawRec(22, M + i * CELL + CELL / 2, 'L' + i); drawRec(BOARD - 22, M + i * CELL + CELL / 2, 'R' + i); }
    // 光源（绿三角，呼吸）
    const pulse = 0.6 + 0.4 * Math.sin(this.t * 3);
    for (const s of this.sources) {
      let x, y, ang;
      if (s.edge === 'bottom') { x = M + s.idx * CELL + CELL / 2; y = BOARD - 22; ang = Math.PI; }
      else if (s.edge === 'top') { x = M + s.idx * CELL + CELL / 2; y = 22; ang = 0; }
      else if (s.edge === 'left') { x = 22; y = M + s.idx * CELL + CELL / 2; ang = Math.PI / 2; }
      else { x = BOARD - 22; y = M + s.idx * CELL + CELL / 2; ang = -Math.PI / 2; }
      c.save(); c.translate(x, y); c.rotate(ang);
      c.fillStyle = `rgba(93,255,160,${pulse})`; c.shadowColor = '#5dffa0'; c.shadowBlur = 12;
      c.beginPath(); c.moveTo(0, -12); c.lineTo(10, 10); c.lineTo(-10, 10); c.closePath(); c.fill(); c.restore();
    }
  }
}

export default {
  id: 'light', name: '点石成金', icon: '🔦', tag: '光线·解谜',
  desc: '放置镜子让光源点亮外圈全部接收点，关卡保证有解。',
  maxLevel: 10,
  config(level) { return { showPath: level <= 3, time: 0, mirrorLimit: 3, tip: '' }; },
  mount(root, api) { new Light(root, api); }
};
