/**
 * 流派觉醒横幅 —— 轻量展示层，不碰玩法数值。
 * ---------------------------------------------------------------------------
 * · announce(syn)：流派新激活时，屏幕中上方弹出大字横幅，数秒后淡出。
 * · 自带 style 注入（幂等），不依赖任何外部 CSS 文件。
 * · reduced-motion 下只做静态显示，不做位移动画。
 */
const CSS = `
.syn-banner { position:fixed; top:16%; left:50%; z-index:30; pointer-events:none;
  transform:translateX(-50%); text-align:center; font-family:"STKaiti","KaiTi","楷体",serif;
  opacity:0; transition:opacity .35s ease, transform .5s cubic-bezier(.2,.8,.2,1); }
.syn-banner.on { opacity:1; transform:translateX(-50%) translateY(6px); }
.syn-banner .k { font-size:.8em; letter-spacing:.5em; color:#f0e6c8; text-shadow:0 2px 8px #000; }
.syn-banner .n { font-size:2.2em; font-weight:800; letter-spacing:.25em; margin:.1em 0;
  color:#fff6dd; text-shadow:0 0 18px var(--syn-c,#a8362c), 0 3px 10px #000; }
.syn-banner .d { font-size:.9em; letter-spacing:.15em; color:#e8dcc0; text-shadow:0 2px 6px #000; }
.syn-banner .bar { height:3px; width:0; margin:.5em auto 0; background:var(--syn-c,#a8362c);
  box-shadow:0 0 12px var(--syn-c,#a8362c); transition:width 1.6s linear; }
.syn-banner.on .bar { width:100%; }
`;

export class SynergyBanner {
  constructor() {
    if (!document.getElementById('syn-style')) {
      const st = document.createElement('style');
      st.id = 'syn-style';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    this.root = document.createElement('div');
    this.root.className = 'syn-banner';
    this.root.id = 'synergy-banner';
    this.root.innerHTML =
      '<div class="k">流派觉醒</div><div class="n" data-name></div>' +
      '<div class="d" data-desc></div><div class="bar"></div>';
    document.body.appendChild(this.root);
    this._timer = null;
  }

  /** 弹出一个流派的觉醒横幅。onDone 在淡出后回调（可选）。 */
  announce(syn, onDone) {
    if (!syn) return;
    this.root.style.setProperty('--syn-c', syn.color || '#a8362c');
    this.root.querySelector('[data-name]').textContent = syn.name || syn.id;
    this.root.querySelector('[data-desc]').textContent = syn.desc || '';
    // 重启进度条动画：先撤 on，强制回流，再挂 on
    this.root.classList.remove('on');
    void this.root.offsetWidth;
    this.root.classList.add('on');
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this.root.classList.remove('on');
      if (typeof onDone === 'function') onDone();
    }, 2100);
  }
}
