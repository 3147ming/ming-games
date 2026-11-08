// 03 火眼金睛 —— 斯特鲁普注意力测试
const WORDS = ['红', '蓝', '粉', '绿', '浅蓝', '黄'];
const COLORS = ['#ff5d73', '#4ea8ff', '#ff7bd5', '#5dffa0', '#7fd4ff', '#ffd54a'];
// 词义下标 i 对应的"真实颜色"即 COLORS[i]

class Stroop {
  constructor(root, api) {
    this.root = root; this.api = api; this.cfg = api.cfg;
    this.score = 0; this.time = this.cfg.time; this.running = true; this.ended = false;
    this.flash = '';
    this.next(); this.tick();
  }

  next() {
    const n = WORDS.length;
    this.word = Math.floor(Math.random() * n);
    this.color = Math.floor(Math.random() * n);
    this.bg = Math.floor(Math.random() * n);
    this.render();
  }

  answer(match) {
    if (!this.running || this.ended) return;
    const isMatch = this.word === this.color;
    const correct = isMatch === match;
    if (correct) { this.score += 10; this.flash = '✓ 正确'; }
    else { this.score -= this.cfg.penalty; this.flash = '✗ 错误'; }
    this.next();
  }

  tick() {
    const iv = setInterval(() => {
      if (!this.running || this.ended) return;
      this.time--; this.updateHud();
      if (this.time <= 0) this.settle();
    }, 1000);
    this.api.onDestroy(() => clearInterval(iv));
  }

  settle() {
    this.running = false; this.ended = true;
    if (this.score >= this.cfg.target) {
      const stars = this.score >= this.cfg.target * 1.6 ? 3 : this.score >= this.cfg.target * 1.2 ? 2 : 1;
      this.api.win(stars, this.score);
    } else {
      this.api.lose();
    }
  }

  updateHud() {
    this.api.setHud(`
      <div class="stat warn"><span class="k">时间</span>${Math.max(0, this.time)}s</div>
      <div class="stat"><span class="k">得分</span>${this.score}</div>
      <div class="goal">目标 ${this.cfg.target} 分</div>`);
  }

  render() {
    const isMatch = this.word === this.color;
    this.root.innerHTML = `
      <div class="grid-wrap sp-wrap">
        <div class="sp-tip">判断【文字词义】与【字体颜色】是否一致（忽略底色）</div>
        <div class="sp-legend">
          <span style="color:${COLORS[0]}">红</span><span style="color:${COLORS[1]}">蓝</span>
          <span style="color:${COLORS[2]}">粉</span><span style="color:${COLORS[3]}">绿</span>
          <span style="color:${COLORS[4]}">浅蓝</span><span style="color:${COLORS[5]}">黄</span>
        </div>
        <div class="sp-card" style="background:${COLORS[this.bg]}33;border-color:${COLORS[this.bg]}">
          <div class="sp-word" style="color:${COLORS[this.color]}">${WORDS[this.word]}</div>
        </div>
        <div class="sp-flash ${this.flash.includes('✓') ? 'ok' : 'bad'}">${this.flash}</div>
        <div class="sp-btns">
          <button class="btn primary" id="sp-yes">匹配</button>
          <button class="btn" id="sp-no">不匹配</button>
        </div>
        <div class="hint">词义 = 字体颜色 → 匹配；否则 → 不匹配</div>
      </div>`;
    this.root.querySelector('#sp-yes').onclick = () => this.answer(true);
    this.root.querySelector('#sp-no').onclick = () => this.answer(false);
  }
}

export default {
  id: 'stroop', name: '火眼金睛', icon: '👁️', tag: '注意力',
  desc: '斯特鲁普测试：判断词义与字体颜色是否一致，无视底色。',
  maxLevel: 30,
  config(level) {
    const time = Math.max(30, 60 - Math.floor(level / 2));
    const target = 120 + level * 20;
    const penalty = Math.min(5 + Math.floor(level / 3), 15);
    return { time, target, penalty };
  },
  mount(root, api) { new Stroop(root, api); }
};
