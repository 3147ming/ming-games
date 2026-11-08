// 02 连线作战 —— 空间连线解谜 (Numberlink/Flow)
const PAIR_COLORS = ['#ff5d73', '#4ea8ff', '#5dffa0', '#ffd54a', '#b07bff', '#ff9d4d', '#ff7bd5', '#3ad6ff', '#ff8a5c', '#8cff5c', '#5c8cff', '#ff5ce0'];

class Connect {
  constructor(root, api) {
    this.root = root; this.api = api; this.cfg = api.cfg;
    this.n = this.cfg.size; this.timer = this.cfg.time;
    this.running = true; this.ended = false;
    this.build();
  }

  build() {
    const n = this.n;
    // 单元格状态
    this.cell = [];
    for (let y = 0; y < n; y++) {
      const r = [];
      for (let x = 0; x < n; x++) r.push({ wall: false, ep: null, owner: null });
      this.cell.push(r);
    }
    const occupied = new Set();
    this.pairs = [];
    let color = 0;
    const pairCount = this.cfg.pairs;
    for (let p = 0; p < pairCount; p++) {
      const start = this.randomEmpty(occupied);
      if (!start) break;
      const path = this.walk(occupied, start, 3, Math.min(6, n));
      if (!path) { occupied.add(start[0] + ',' + start[1]); continue; }
      for (const k of path) occupied.add(k);
      const a = path[0], b = path[path.length - 1];
      const id = p;
      this.cell[a[1]][a[0]].ep = id;
      this.cell[b[1]][b[0]].ep = id;
      this.pairs.push({ id, color: PAIR_COLORS[color % PAIR_COLORS.length], a, b, sol: path, done: false });
      color++;
    }
    // 剩余空格设为墙
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++)
      if (!occupied.has(x + ',' + y)) this.cell[y][x].wall = true;

    this.paths = {}; // id -> [cells]
    this.cur = null;
    this.render();
    this.bind();
    this.tick();
  }

  randomEmpty(occ) {
    const n = this.n; const list = [];
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (!occ.has(x + ',' + y) && !this.cell[y][x].wall) list.push([x, y]);
    if (!list.length) return null;
    return list[Math.floor(Math.random() * list.length)];
  }

  walk(occ, start, minL, maxL) {
    const n = this.n;
    const path = [start];
    const used = new Set([start[0] + ',' + start[1]]);
    let cur = start;
    for (let step = 1; step < maxL; step++) {
      const nb = [];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cur[0] + dx, ny = cur[1] + dy;
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const k = nx + ',' + ny;
        if (used.has(k) || occ.has(k) || this.cell[ny][nx].wall) continue;
        nb.push([nx, ny]);
      }
      if (!nb.length) break;
      const nx = nb[Math.floor(Math.random() * nb.length)];
      path.push(nx); used.add(nx[0] + ',' + nx[1]); cur = nx;
      if (path.length >= minL && Math.random() < 0.35) break;
    }
    return path.length >= minL ? path : null;
  }

  bind() {
    const grid = this.root.querySelector('.cn-grid');
    grid.addEventListener('pointerdown', e => {
      if (!this.running) return;
      const t = e.target.closest('.cn-cell'); if (!t) return;
      const x = +t.dataset.x, y = +t.dataset.y;
      const c = this.cell[y][x];
      if (c.wall || c.ep === null) return;
      const id = c.ep;
      if (this.paths[id]) this.clearPath(id); // 重画：先清除
      this.cur = { id, cells: [[x, y]] };
      this.render();
    });
    grid.addEventListener('pointermove', e => {
      if (!this.cur || !this.running) return;
      const t = document.elementFromPoint(e.clientX, e.clientY);
      if (!t) return; const el = t.closest && t.closest('.cn-cell'); if (!el) return;
      const x = +el.dataset.x, y = +el.dataset.y;
      this.tryExtend(x, y);
    });
    const end = () => { if (this.cur) { this.commit(); this.cur = null; } };
    grid.addEventListener('pointerup', end);
    grid.addEventListener('pointercancel', end);
    this.root.querySelector('#cn-reset').onclick = () => this.resetAll();
  }

  tryExtend(x, y) {
    const cur = this.cur; const last = cur.cells[cur.cells.length - 1];
    if (x === last[0] && y === last[1]) return;
    const dx = x - last[0], dy = y - last[1];
    if (Math.abs(dx) + Math.abs(dy) !== 1) return; // 必须相邻
    const c = this.cell[y][x];
    const pair = this.pairs[cur.id];
    // 回退
    if (cur.cells.length >= 2) {
      const prev = cur.cells[cur.cells.length - 2];
      if (prev[0] === x && prev[1] === y) { cur.cells.pop(); this.render(); return; }
    }
    // 不能穿过墙/其他已锁定线/其他端点
    if (c.wall) return;
    if (c.owner !== null && c.owner !== cur.id) return;
    if (c.ep !== null && c.ep !== cur.id) return;
    // 不能重复经过自身（除回退外）
    if (cur.cells.some(p => p[0] === x && p[1] === y)) return;
    // 到达匹配端点 -> 完成
    if (c.ep === cur.id && !(x === pair.a[0] && y === pair.a[1])) {
      cur.cells.push([x, y]); this.commit(); this.cur = null; this.render(); this.checkWin(); return;
    }
    cur.cells.push([x, y]);
    this.render();
  }

  commit() {
    const id = this.cur.id;
    this.clearPath(id);
    this.paths[id] = this.cur.cells.slice();
    for (const [x, y] of this.paths[id]) this.cell[y][x].owner = id;
    this.pairs[id].done = true;
  }
  clearPath(id) {
    if (!this.paths[id]) return;
    for (const [x, y] of this.paths[id]) this.cell[y][x].owner = null;
    this.paths[id] = null; this.pairs[id].done = false;
  }
  resetAll() {
    for (const p of this.pairs) this.clearPath(p.id);
    this.cur = null; this.render();
  }

  checkWin() {
    if (this.pairs.every(p => p.done)) {
      this.running = false; this.ended = true;
      const stars = this.timer > this.cfg.time * 0.5 ? 3 : this.timer > this.cfg.time * 0.2 ? 2 : 1;
      this.api.win(stars, this.pairs.length * 100 + Math.round(this.timer) * 2);
    }
  }

  tick() {
    if (this.ended) return;
    const iv = setInterval(() => {
      if (!this.running || this.ended) return;
      this.timer--;
      this.updateHud();
      if (this.timer <= 0) { this.running = false; this.ended = true; this.api.lose(); }
    }, 1000);
    this.api.onDestroy(() => clearInterval(iv));
  }
  updateHud() {
    const done = this.pairs.filter(p => p.done).length;
    this.api.setHud(`
      <div class="stat warn"><span class="k">时间</span>${Math.max(0, this.timer)}s</div>
      <div class="stat"><span class="k">已连</span>${done}/${this.pairs.length}</div>
      <div class="goal">连接所有同色圆点</div>`);
  }

  render() {
    const n = this.n;
    let html = '<div class="grid-wrap">';
    html += `<div class="cn-bar"><button class="gbtn" id="cn-reset">↺ 重置线路</button><div class="hint">从圆点拖出线条，连通同色两端</div></div>`;
    html += `<div class="cn-grid" style="--n:${n}">`;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const c = this.cell[y][x];
      let cls = 'cn-cell', style = '', inner = '';
      const inCur = this.cur && this.cur.cells.some(p => p[0] === x && p[1] === y);
      const owner = c.owner;
      if (c.wall) { cls += ' wall'; }
      else if (c.ep !== null) {
        cls += ' ep'; style = `background:${this.pairs[c.ep].color}`;
        if (c.ep === (this.cur && this.cur.id)) style += ';box-shadow:0 0 0 3px #fff inset';
      } else if (owner !== null || inCur) {
        cls += ' line'; style = `background:${this.pairs[(owner !== null ? owner : this.cur.id)].color}`;
      }
      html += `<div class="${cls}" data-x="${x}" data-y="${y}" style="${style}">${inner}</div>`;
    }
    html += '</div></div>';
    this.root.innerHTML = html;
    // 重新绑定 reset（render 重建了 DOM）
    const rb = this.root.querySelector('#cn-reset'); if (rb) rb.onclick = () => this.resetAll();
  }
}

export default {
  id: 'connect', name: '连线作战', icon: '🔗', tag: '空间连线',
  desc: '按住圆点拖出线条，连通所有同色两端，不可交叉。',
  maxLevel: 30,
  config(level) {
    const size = Math.min(5 + Math.floor((level - 1) / 3), 9);
    const pairs = Math.min(3 + Math.floor(level / 2), Math.floor(size * size / 4));
    const time = Math.max(40, 120 - level * 2);
    return { size, pairs, time };
  },
  mount(root, api) { new Connect(root, api); }
};
