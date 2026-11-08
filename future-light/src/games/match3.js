// 01 魔法符石 —— 三消消除
const COLORS = ['#ff5d73', '#4ea8ff', '#5dffa0', '#ffd54a', '#b07bff', '#ff9d4d', '#ff7bd5'];
const GLYPH = { row: '⇆', col: '⇅', bomb: '✸', rainbow: '🌈' };

function cell(c) { return { c, special: null, fixed: false, vine: false }; }
function isMovable(g) { return g && g.c !== null && !g.fixed && !g.vine; }

class Match3 {
  constructor(root, api) {
    this.root = root; this.api = api;
    this.cfg = api.cfg;
    this.size = this.cfg.size;
    this.types = this.cfg.types;
    this.moves = this.cfg.moves;
    this.score = 0; this.combo = 0; this.busy = false;
    this.sel = null; this.drag = null;
  }

  start() {
    this.buildBoard();
    this.render();
    this.bind();
    this.updateHud();
  }

  buildBoard() {
    const n = this.size;
    this.board = [];
    for (let y = 0; y < n; y++) {
      const row = [];
      for (let x = 0; x < n; x++) row.push(cell(this.rand()));
      this.board.push(row);
    }
    // 避免初始三连
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      while (this.matchAt(x, y)) this.board[y][x] = cell(this.rand());
    }
    // 放置障碍
    let fp = this.cfg.fixed, vp = this.cfg.vine;
    const spots = this.shuffleSpots();
    let i = 0;
    for (; i < fp && i < spots.length; i++) {
      const [x, y] = spots[i]; this.board[y][x] = { c: null, special: null, fixed: true, vine: false };
    }
    for (; i < fp + vp && i < spots.length; i++) {
      const [x, y] = spots[i]; this.board[y][x] = { c: null, special: null, fixed: false, vine: true };
    }
  }

  rand() { return Math.floor(Math.random() * this.types); }
  shuffleSpots() {
    const s = [];
    for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) s.push([x, y]);
    for (let i = s.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [s[i], s[j]] = [s[j], s[i]]; }
    return s;
  }

  matchAt(x, y) {
    const g = this.board[y][x];
    if (!isMovable(g)) return false;
    const c = g.c;
    // 水平
    let h = 1;
    for (let i = x - 1; i >= 0 && isMovable(this.board[y][i]) && this.board[y][i].c === c; i--) h++;
    for (let i = x + 1; i < this.size && isMovable(this.board[y][i]) && this.board[y][i].c === c; i++) h++;
    if (h >= 3) return true;
    // 垂直
    let v = 1;
    for (let j = y - 1; j >= 0 && isMovable(this.board[j][x]) && this.board[j][x].c === c; j--) v++;
    for (let j = y + 1; j < this.size && isMovable(this.board[j][x]) && this.board[j][x].c === c; j++) v++;
    return v >= 3;
  }

  // 找出所有匹配单元格（返回 Set of "x,y"）
  findMatches() {
    const n = this.size, set = new Set();
    for (let y = 0; y < n; y++) {
      let run = 1;
      for (let x = 1; x <= n; x++) {
        const ok = x < n && isMovable(this.board[y][x]) && isMovable(this.board[y][x - 1]) && this.board[y][x].c === this.board[y][x - 1].c;
        if (ok) run++;
        else { if (run >= 3) for (let k = x - run; k < x; k++) set.add(k + ',' + y); run = 1; }
      }
    }
    for (let x = 0; x < n; x++) {
      let run = 1;
      for (let y = 1; y <= n; y++) {
        const ok = y < n && isMovable(this.board[y][x]) && isMovable(this.board[y - 1][x]) && this.board[y][x].c === this.board[y - 1][x].c;
        if (ok) run++;
        else { if (run >= 3) for (let k = y - run; k < y; k++) set.add(x + ',' + k); run = 1; }
      }
    }
    return set;
  }

  // 仅一次消除回合：返回是否产生了消除
  resolveStep(preferred) {
    const matches = this.findMatches();
    if (matches.size === 0) return false;

    // 组件分析 -> 决定特殊符石
    const comp = this.components(matches);
    const keep = new Map(); // "x,y" -> specialType （本回合生成，不清除）
    for (const compCells of comp) {
      const sp = this.specialType(compCells);
      if (sp) {
        let key = preferred && matches.has(preferred) && this.inComp(compCells, preferred) ? preferred : compCells[Math.floor(compCells.length / 2)];
        keep.set(key, sp);
      }
    }

    // 计算清除集合（matched 去掉 keep，并展开已有 special 的特效）
    const clear = new Set();
    for (const k of matches) if (!keep.has(k)) clear.add(k);
    // 展开已存在的特殊符石特效
    const queue = [...clear];
    while (queue.length) {
      const k = queue.pop();
      const [x, y] = k.split(',').map(Number);
      const g = this.board[y][x];
      if (g && g.special && !keep.has(k)) {
        const affected = this.specialArea(x, y, g.special, g.c);
        for (const a of affected) if (!clear.has(a)) { clear.add(a); queue.push(a); }
      }
    }
    // 藤蔓：相邻被清除则去除
    const addVine = [];
    for (const k of clear) {
      const [x, y] = k.split(',').map(Number);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= this.size || ny >= this.size) continue;
        const g = this.board[ny][nx];
        if (g && g.vine && !clear.has(nx + ',' + ny)) addVine.push([nx, ny]);
      }
    }
    for (const [x, y] of addVine) { clear.add(x + ',' + y); }

    // 计分
    this.combo++;
    this.score += clear.size * 10 * this.combo;

    // 应用：保留的特殊符石赋值；其余清除
    for (const k of clear) {
      const [x, y] = k.split(',').map(Number);
      this.board[y][x] = cell(null);
    }
    for (const [k, sp] of keep) {
      const [x, y] = k.split(',').map(Number);
      const g = this.board[y][x];
      g.c = g.c === null ? this.rand() : g.c;
      g.special = sp;
    }
    this.gravity();
    return true;
  }

  components(set) {
    const seen = new Set(); const comps = [];
    for (const k of set) {
      if (seen.has(k)) continue;
      const [x, y] = k.split(',').map(Number);
      const c = this.board[y][x].c;
      const stack = [k]; const cells = []; seen.add(k);
      while (stack.length) {
        const cur = stack.pop(); const [cx, cy] = cur.split(',').map(Number);
        cells.push(cur);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx, ny = cy + dy, nk = nx + ',' + ny;
          if (set.has(nk) && !seen.has(nk) && this.board[ny][nx].c === c) { seen.add(nk); stack.push(nk); }
        }
      }
      comps.push(cells);
    }
    return comps;
  }
  inComp(cells, key) { return cells.includes(key); }

  specialType(cells) {
    // 计算最大水平/垂直连续长度与是否交叉
    const pts = cells.map(k => k.split(',').map(Number));
    let maxH = 1, maxV = 1, cross = false;
    const set = new Set(cells);
    for (const [x, y] of pts) {
      let h = 1; for (let i = x - 1; set.has(i + ',' + y); i--) h++; for (let i = x + 1; set.has(i + ',' + y); i++) h++;
      let v = 1; for (let j = y - 1; set.has(x + ',' + j); j--) v++; for (let j = y + 1; set.has(x + ',' + j); j++) v++;
      maxH = Math.max(maxH, h); maxV = Math.max(maxV, v);
      if (h >= 3 && v >= 3) cross = true;
    }
    const size = cells.length;
    if (maxH >= 5 || maxV >= 5 || size >= 5) return 'rainbow';
    if (cross) return 'bomb';
    if (maxH === 4) return 'row';
    if (maxV === 4) return 'col';
    return null;
  }

  specialArea(x, y, sp, c) {
    const out = [];
    if (sp === 'row') for (let i = 0; i < this.size; i++) out.push(i + ',' + y);
    else if (sp === 'col') for (let j = 0; j < this.size; j++) out.push(x + ',' + j);
    else if (sp === 'bomb') for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < this.size && ny < this.size) out.push(nx + ',' + ny);
    } else if (sp === 'rainbow') {
      const tc = c !== null ? c : this.rand();
      for (let yy = 0; yy < this.size; yy++) for (let xx = 0; xx < this.size; xx++) {
        const g = this.board[yy][xx]; if (isMovable(g) && g.c === tc) out.push(xx + ',' + yy);
      }
    }
    return out;
  }

  gravity() {
    const n = this.size;
    for (let x = 0; x < n; x++) {
      let segEnd = n;
      for (let y = n - 1; y >= 0; y--) {
        const g = this.board[y][x];
        if (g && !g.movable && (g.fixed || g.vine)) {
          this.compact(x, y + 1, segEnd - 1);
          segEnd = y;
        }
      }
      this.compact(x, 0, segEnd - 1);
    }
  }
  compact(x, top, bottom) {
    if (bottom < top) return;
    const n = this.size;
    const gems = [];
    for (let y = bottom; y >= top; y--) { const g = this.board[y][x]; if (isMovable(g)) gems.push(g); }
    let idx = 0;
    for (let y = bottom; y >= top; y--) {
      if (idx < gems.length) this.board[y][x] = gems[idx++];
      else this.board[y][x] = cell(this.rand());
    }
  }

  // -------- 交互 --------
  bind() {
    const grid = this.root.querySelector('.mg-grid');
    grid.addEventListener('pointerdown', e => {
      if (this.busy) return;
      const t = e.target.closest('.mg-cell'); if (!t) return;
      const x = +t.dataset.x, y = +t.dataset.y;
      if (!isMovable(this.board[y][x])) return;
      this.drag = { x, y };
    });
    grid.addEventListener('pointermove', e => {
      if (!this.drag || this.busy) return;
      const t = document.elementFromPoint(e.clientX, e.clientY);
      if (!t) return;
      const cellEl = t.closest && t.closest('.mg-cell');
      if (!cellEl) return;
      const x = +cellEl.dataset.x, y = +cellEl.dataset.y;
      const dx = x - this.drag.x, dy = y - this.drag.y;
      if (Math.abs(dx) + Math.abs(dy) === 1) {
        this.trySwap(this.drag.x, this.drag.y, x, y);
        this.drag = null;
      }
    });
    const end = () => { this.drag = null; };
    grid.addEventListener('pointerup', end);
    grid.addEventListener('pointercancel', end);
  }

  trySwap(x1, y1, x2, y2) {
    const a = this.board[y1][x1], b = this.board[y2][x2];
    if (!isMovable(a) || !isMovable(b)) return;
    this.busy = true;
    this.board[y1][x1] = b; this.board[y2][x2] = a;
    if (this.findMatches().size === 0) {
      // 无效交换，换回
      this.board[y1][x1] = a; this.board[y2][x2] = b;
      this.busy = false;
      this.api.toast('无法消除');
      return;
    }
    this.moves--;
    this.combo = 0;
    this.render();
    this.updateHud();
    this.loop(() => {
      this.busy = false;
      if (this.score >= this.cfg.target) { this.win(); return; }
      if (this.moves <= 0) { this.lose(); return; }
      if (!this.hasMoves()) { this.shuffle(); this.render(); this.api.toast('无可消除，已重排'); }
    });
  }

  // 连锁消除循环
  loop(done) {
    const step = () => {
      const ok = this.resolveStep(null);
      this.render();
      if (ok) setTimeout(step, 160);
      else { this.updateHud(); done(); }
    };
    setTimeout(step, 160);
  }

  hasMoves() {
    const n = this.size;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      if (!isMovable(this.board[y][x])) continue;
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx >= n || ny >= n || !isMovable(this.board[ny][nx])) continue;
        const a = this.board[y][x], b = this.board[ny][nx];
        this.board[y][x] = b; this.board[ny][nx] = a;
        const m = this.findMatches().size > 0;
        this.board[y][x] = a; this.board[ny][nx] = b;
        if (m) return true;
      }
    }
    return false;
  }
  shuffle() {
    const n = this.size; const movable = [];
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (isMovable(this.board[y][x])) movable.push(this.board[y][x]);
    for (let i = movable.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [movable[i], movable[j]] = [movable[j], movable[i]]; }
    let k = 0;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (isMovable(this.board[y][x])) this.board[y][x] = movable[k++];
  }

  win() {
    const total = this.cfg.moves;
    const r = this.moves / total;
    const stars = r >= 0.35 ? 3 : r >= 0.12 ? 2 : 1;
    this.api.win(stars, this.score);
  }
  lose() { this.api.lose(); }

  updateHud() {
    const left = Math.max(0, this.moves);
    this.api.setHud(`
      <div class="stat"><span class="k">步数</span>${left}</div>
      <div class="stat"><span class="k">分数</span>${this.score}</div>
      <div class="goal">目标 ${this.cfg.target} 分</div>`);
  }

  render() {
    const n = this.size;
    let html = '<div class="grid-wrap"><div class="mg-grid" style="--n:' + n + '">';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const g = this.board[y][x];
      let cls = 'mg-cell', style = '', inner = '';
      if (g.fixed) { cls += ' fixed'; inner = '🔒'; }
      else if (g.vine) { cls += ' vine'; }
      else {
        style = `background:${COLORS[g.c]};`;
        if (g.special) { cls += ' sp'; inner = `<span class="sp-g">${GLYPH[g.special]}</span>`; if (g.special === 'rainbow') style += 'background:conic-gradient(#ff5d73,#ffd54a,#5dffa0,#4ea8ff,#b07bff,#ff5d73);'; }
      }
      html += `<div class="${cls}" data-x="${x}" data-y="${y}" style="${style}">${inner}</div>`;
    }
    html += '</div><div class="hint">拖拽相邻符石交换 · 三连即消 · 连锁加分</div></div>';
    this.root.innerHTML = html;
  }
}

export default {
  id: 'match3', name: '魔法符石', icon: '🔮', tag: '三消消除',
  desc: '交换符石三连消除，激发直线/区域/彩虹特效，清空目标分。',
  maxLevel: 30,
  config(level) {
    const size = Math.min(7 + Math.floor((level - 1) / 5), 9);
    const types = Math.min(5 + Math.floor((level - 1) / 8), 7);
    const moves = Math.max(18, 36 - Math.floor(level / 2));
    const fixed = level >= 3 ? Math.min(1 + Math.floor(level / 5), 4) : 0;
    const vine = level >= 5 ? Math.min(1 + Math.floor((level - 6) / 4), 4) : 0;
    const target = 800 + level * 220;
    return { size, types, moves, fixed, vine, target };
  },
  mount(root, api) { new Match3(root, api).start(); }
};
