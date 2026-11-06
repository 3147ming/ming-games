/**
 * 升级三选一弹层（第 3 批 P0-5）—— 纯展示：只负责画卡、等点击、回调。
 * ---------------------------------------------------------------------------
 * ⚠ 不在这里改玩家数值，也不在这里暂停游戏（暂停标志归 main 的 runPaused）。
 *   这样弹层可以单独打开来截图/验收，而不会顺带把仿真冻住。
 * ⚠ 也不在这里写 localStorage（本批不写存档）。
 */
import { INK_UI } from '../core/config.js';

const CSS = `
.lv { position:fixed; inset:0; z-index:14; display:none; align-items:center; justify-content:center;
  background:rgba(20,20,22,.72); pointer-events:auto; font-family:${INK_UI.FONT}; color:${INK_UI.INK}; }
.lv.on { display:flex; }
.lv-wrap { display:flex; gap:12px; padding:16px; max-width:96vw; }
.lv-card { width:min(30vw,190px); padding:14px 12px; border-radius:8px; cursor:pointer;
  background:linear-gradient(180deg, rgba(239,233,216,.97), rgba(220,212,190,.93));
  box-shadow:inset 0 0 0 2px ${INK_UI.INK}, 0 10px 30px rgba(0,0,0,.55); text-align:center;
  touch-action:manipulation; }
.lv-card:active { transform:translateY(1px); }
.lv-card .t { font-size:.75em; opacity:.75; }
.lv-card .n { font-size:1.15em; font-weight:800; color:${INK_UI.CINNABAR}; margin:.15em 0 .35em; }
.lv-card .d { font-size:.85em; line-height:1.5; }
.lv-title { position:absolute; top:12vh; left:50%; transform:translateX(-50%);
  font-size:1.1em; letter-spacing:.2em; color:${INK_UI.PAPER}; }
`;

export class LevelUpPanel {
  constructor() {
    if (!document.getElementById('lv-style')) {
      const st = document.createElement('style');
      st.id = 'lv-style';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    this.root = document.createElement('div');
    this.root.className = 'lv';
    this.root.id = 'level-up';
    this.root.innerHTML = '<div class="lv-title">升级 · 择一</div><div class="lv-wrap" data-cards></div>';
    document.body.appendChild(this.root);
    this.cards = this.root.querySelector('[data-cards]');
    this.open = false;
    this._onPick = null;
  }

  /** 画三张卡并等一次点击。onPick 收到被点的那张卡。 */
  show(cards, onPick) {
    this._onPick = onPick;
    this.cards.innerHTML = '';
    for (const c of cards) {
      const el = document.createElement('div');
      el.className = 'lv-card';
      el.innerHTML = `<div class="t">${c.tier}</div><div class="n">${c.name}</div><div class="d">${c.text}</div>`;
      el.addEventListener('click', () => { if (this._onPick) this._onPick(c); });
      this.cards.appendChild(el);
    }
    this.root.classList.add('on');
    this.open = true;
  }

  hide() {
    this.root.classList.remove('on');
    this.open = false;
    this._onPick = null;
  }
}
