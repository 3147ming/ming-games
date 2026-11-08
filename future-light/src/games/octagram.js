// 08 星符记忆 —— 八角星符号记忆复原
const SYMS = ['✦', '✧', '★', '☆', '❂', '❀', '☀', '⚡', '☯', '♛', '✺', '❄'];

class Octagram {
  constructor(root, api) {
    this.root = root; this.api = api; this.cfg = api.cfg;
    this.slots = this.cfg.slots;
    this.chances = this.cfg.chances;
    this.ended = false; this.phase = 'show';
    this.pick(); this.renderShow(); this.timer = setTimeout(() => this.toRecall(), this.cfg.mem * 1000);
    this.api.onDestroy(() => clearTimeout(this.timer));
  }

  pick() {
    const pool = SYMS.slice();
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    this.ans = pool.slice(0, this.slots);
    this.palette = pool.slice(0, this.slots);
    for (let i = this.palette.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [this.palette[i], this.palette[j]] = [this.palette[j], this.palette[i]]; }
    this.fill = Array(this.slots).fill(null);
    this.sel = null;
  }

  pos(i, total, R, cx, cy) {
    const ang = (-90 + i * (360 / total)) * Math.PI / 180;
    return { x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang) };
  }

  renderShow() {
    const S = this.slots, R = 120, cx = 160, cy = 160;
    let html = '<div class="grid-wrap og-wrap"><div class="og-tip">记住每个星瓣上的符号…</div>';
    html += `<div class="og-stage"><svg class="og-lines" viewBox="0 0 320 320">`;
    // 连线成星
    let pts = '';
    for (let i = 0; i < S; i++) { const p = this.pos(i, S, R, cx, cy); pts += `${p.x},${p.y} `; }
    html += `<polygon points="${pts.trim()}" />`;
    html += '</svg>';
    for (let i = 0; i < S; i++) {
      const p = this.pos(i, S, R, cx, cy);
      html += `<div class="og-slot show" style="left:${p.x}px;top:${p.y}px">${this.ans[i]}</div>`;
    }
    html += '</div></div>';
    this.root.innerHTML = html;
  }

  toRecall() {
    if (this.ended) return;
    this.phase = 'recall'; this.renderRecall();
  }

  renderRecall() {
    const S = this.slots, R = 120, cx = 160, cy = 160;
    let html = '<div class="grid-wrap og-wrap">';
    html += `<div class="og-tip">复原符号位置（剩余机会 <b>${this.chances}</b>）</div>`;
    html += '<div class="og-stage"><svg class="og-lines" viewBox="0 0 320 320">';
    let pts = '';
    for (let i = 0; i < S; i++) { const p = this.pos(i, S, R, cx, cy); pts += `${p.x},${p.y} `; }
    html += `<polygon points="${pts.trim()}" /></svg>`;
    for (let i = 0; i < S; i++) {
      const p = this.pos(i, S, R, cx, cy);
      const v = this.fill[i];
      html += `<div class="og-slot ${v ? 'filled' : ''}" data-i="${i}" style="left:${p.x}px;top:${p.y}px">${v || ''}</div>`;
    }
    html += '</div>';
    html += '<div class="og-palette">';
    for (let k = 0; k < this.palette.length; k++) {
      html += `<button class="og-sym ${this.sel === k ? 'on' : ''}" data-k="${k}">${this.palette[k]}</button>`;
    }
    html += '</div>';
    html += '<button class="btn primary og-confirm">确认复原</button>';
    html += '</div>';
    this.root.innerHTML = html;
    this.root.querySelectorAll('.og-sym').forEach(b => b.onclick = () => { this.sel = +b.dataset.k; this.renderRecall(); });
    this.root.querySelectorAll('.og-slot').forEach(s => s.onclick = () => this.place(+s.dataset.i));
    this.root.querySelector('.og-confirm').onclick = () => this.confirm();
  }

  place(i) {
    if (this.phase !== 'recall' || this.ended) return;
    if (this.sel === null) { this.api.toast('先选择一个符号'); return; }
    if (this.fill[i] !== null) return;
    this.fill[i] = this.palette[this.sel];
    this.renderRecall();
  }

  confirm() {
    if (this.fill.some(f => f === null)) { this.api.toast('还有星瓣未填'); return; }
    let wrong = 0;
    for (let i = 0; i < this.slots; i++) if (this.fill[i] !== this.ans[i]) wrong++;
    if (wrong === 0) {
      this.ended = true;
      const stars = this.chances >= 3 ? 3 : this.chances >= 1 ? 2 : 1;
      this.api.win(stars, this.chances * 100 + this.api.level * 50);
      return;
    }
    this.chances -= wrong;
    if (this.chances <= 0) { this.ended = true; this.api.lose(); return; }
    // 清掉错误星瓣，保留正确的
    for (let i = 0; i < this.slots; i++) if (this.fill[i] !== this.ans[i]) this.fill[i] = null;
    this.api.toast(`有 ${wrong} 处错误，剩余机会 ${this.chances}`);
    this.renderRecall();
  }
}

export default {
  id: 'octagram', name: '星符记忆', icon: '⭐', tag: '符号记忆',
  desc: '记住八角星上的符号位置，凭记忆复原。',
  maxLevel: 30,
  config(level) {
    const slots = Math.min(4 + Math.floor((level - 1) / 4), 8);
    const mem = Math.max(1.4, 3.2 - level * 0.06);
    const chances = Math.max(2, 5 - Math.floor(level / 6));
    return { slots, mem, chances };
  },
  mount(root, api) { new Octagram(root, api); }
};
