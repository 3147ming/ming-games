// 07 数字谜图 —— Nonogram 逻辑绘图
class Nonogram {
  constructor(root, api) {
    this.root = root; this.api = api; this.cfg = api.cfg;
    this.n = this.cfg.size; this.time = this.cfg.time;
    this.ended = false; this.mode = 1; // 1 填色 / 2 打叉
    this.gen();
    this.render(); this.bind(); this.tick();
  }

  gen() {
    const n = this.n;
    this.sol = [];
    for (let y = 0; y < n; y++) {
      const row = [];
      for (let x = 0; x < n; x++) row.push(Math.random() < 0.55 ? 1 : 0);
      this.sol.push(row);
    }
    // 避免整行/整列全空（至少 1 个）
    for (let y = 0; y < n; y++) if (this.sol[y].every(v => !v)) this.sol[y][Math.floor(Math.random() * n)] = 1;
    for (let x = 0; x < n; x++) { let any = false; for (let y = 0; y < n; y++) if (this.sol[y][x]) any = true; if (!any) this.sol[Math.floor(Math.random() * n)][x] = 1; }
    this.rowH = this.sol.map(r => this.runs(r));
    this.colH = [];
    for (let x = 0; x < n; x++) { const col = []; for (let y = 0; y < n; y++) col.push(this.sol[y][x]); this.colH.push(this.runs(col)); }
    this.state = Array.from({ length: n }, () => Array(n).fill(0));
  }
  runs(arr) {
    const out = []; let c = 0;
    for (const v of arr) { if (v) c++; else if (c) { out.push(c); c = 0; } }
    if (c) out.push(c); if (!out.length) out.push(0);
    return out;
  }

  bind() {
    this.root.querySelector('#nm-fill').onclick = () => { this.mode = 1; this.render(); };
    this.root.querySelector('#nm-cross').onclick = () => { this.mode = 2; this.render(); };
    const grid = this.root.querySelector('.nm-grid');
    const click = (e, right) => {
      const t = e.target.closest('.nm-cell'); if (!t || this.ended) return;
      const x = +t.dataset.x, y = +t.dataset.y;
      let v = this.state[y][x];
      if (right || this.mode === 2) { v = v === 2 ? 0 : 2; }
      else { v = v === 1 ? 0 : 1; }
      this.state[y][x] = v;
      this.render();
      this.check();
    };
    grid.addEventListener('click', e => click(e, false));
    grid.addEventListener('contextmenu', e => { e.preventDefault(); click(e, true); });
  }

  check() {
    for (let y = 0; y < this.n; y++) for (let x = 0; x < this.n; x++) {
      if ((this.state[y][x] === 1) !== (this.sol[y][x] === 1)) return;
    }
    this.ended = true;
    const stars = this.time > this.cfg.time * 0.5 ? 3 : this.time > this.cfg.time * 0.2 ? 2 : 1;
    this.api.win(stars, this.n * this.n * 5 + Math.round(this.time) * 3);
  }

  tick() {
    const iv = setInterval(() => {
      if (this.ended) return;
      this.time--; this.updateHud();
      if (this.time <= 0) { this.ended = true; this.api.lose(); }
    }, 1000);
    this.api.onDestroy(() => clearInterval(iv));
  }
  updateHud() {
    this.api.setHud(`
      <div class="stat warn"><span class="k">时间</span>${Math.max(0, this.time)}s</div>
      <div class="goal">按行列数字填色复原图案</div>`);
  }

  render() {
    const n = this.n;
    let html = '<div class="grid-wrap nm-wrap">';
    html += `<div class="nm-bar">
      <button class="gbtn ${this.mode === 1 ? 'on' : ''}" id="nm-fill">🖌 填色</button>
      <button class="gbtn ${this.mode === 2 ? 'on' : ''}" id="nm-cross">✖ 打叉</button>
      <div class="hint">左键填色/打叉，右键切换</div>
    </div>`;
    html += `<div class="nm-grid" style="--n:${n}">`;
    // 角
    html += '<div class="nm-corner"></div>';
    // 列提示
    for (let x = 0; x < n; x++) html += `<div class="nm-ch">${this.colH[x].map(v => `<b>${v}</b>`).join('')}</div>`;
    // 行
    for (let y = 0; y < n; y++) {
      html += `<div class="nm-rh">${this.rowH[y].map(v => `<b>${v}</b>`).join('')}</div>`;
      for (let x = 0; x < n; x++) {
        const v = this.state[y][x];
        const cls = 'nm-cell' + (v === 1 ? ' on' : v === 2 ? ' x' : '');
        html += `<div class="${cls}" data-x="${x}" data-y="${y}">${v === 2 ? '✕' : ''}</div>`;
      }
    }
    html += '</div></div>';
    this.root.innerHTML = html;
    // 重新绑定（render 重建 DOM）
    const f = this.root.querySelector('#nm-fill'); if (f) f.onclick = () => { this.mode = 1; this.render(); };
    const cr = this.root.querySelector('#nm-cross'); if (cr) cr.onclick = () => { this.mode = 2; this.render(); };
    const grid = this.root.querySelector('.nm-grid');
    const click = (e, right) => {
      const t = e.target.closest('.nm-cell'); if (!t || this.ended) return;
      const x = +t.dataset.x, y = +t.dataset.y;
      let v = this.state[y][x];
      if (right || this.mode === 2) { v = v === 2 ? 0 : 2; } else { v = v === 1 ? 0 : 1; }
      this.state[y][x] = v; this.render(); this.check();
    };
    grid.addEventListener('click', e => click(e, false));
    grid.addEventListener('contextmenu', e => { e.preventDefault(); click(e, true); });
  }
}

export default {
  id: 'nonogram', name: '数字谜图', icon: '🔢', tag: '逻辑推理',
  desc: '依据行列数字提示填色，推理复原隐藏图案。',
  maxLevel: 30,
  config(level) {
    const size = Math.min(5 + Math.floor((level - 1) / 3), 12);
    const time = Math.max(60, 260 - level * 7);
    return { size, time };
  },
  mount(root, api) { new Nonogram(root, api); }
};
