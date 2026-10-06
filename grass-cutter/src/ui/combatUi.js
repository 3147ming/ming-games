/**
 * 战斗 UI（模块 3 的临时版）—— ⚠ 模块 7 会用正式的战场 UI 替换掉它。
 * ---------------------------------------------------------------------------
 * 为什么现在就做：无双槽/斗气/连击数**不是装饰**，它们是把"连段打对了没有"这件事
 * 变成可见反馈的唯一手段。没有它，模块 3 只能靠单测和探针读数证明自己。
 *
 * 刻意保持极简：左下角两根槽 + 一个连击数 + 当前招式名。
 * 真正的战场 UI（血条、据点进度、百人斩计数）是模块 7 的事，这里不抢。
 */

const CSS = `
.cbt { position:fixed; left:16px; bottom:16px; width:264px; z-index:5;
  font:12px/1.5 ui-monospace,Consolas,monospace; color:#e8eef6; pointer-events:none;
  text-shadow:0 1px 2px rgba(0,0,0,.85); transition:opacity .18s; }
.cbt.hidden { opacity:0; }
.cbt-bar { display:flex; align-items:center; gap:8px; margin-top:5px; }
.cbt-lab { width:52px; flex:none; opacity:.8; letter-spacing:.5px; }
.cbt-track { position:relative; flex:1; height:9px; border-radius:5px;
  background:rgba(8,12,18,.72); box-shadow:inset 0 0 0 1px rgba(255,255,255,.18); overflow:hidden; }
.cbt-fill { position:absolute; inset:0 auto 0 0; width:0%; border-radius:5px; transition:width .09s linear; }
.cbt-musou .cbt-fill { background:linear-gradient(90deg,#ffb347,#ffe9a8); }
.cbt-ki .cbt-fill { background:linear-gradient(90deg,#4f8cff,#a8d8ff); }
.cbt-num { width:44px; flex:none; text-align:right; opacity:.92; }
.cbt-top { display:flex; align-items:baseline; gap:10px; }
.cbt-move { font-size:15px; letter-spacing:1px; color:#ffe9a8; min-height:22px; }
.cbt-step { font-size:11px; opacity:.7; }
.cbt-combo { margin-left:auto; font-size:26px; font-weight:700; line-height:1;
  color:#fff; opacity:0; transform:scale(.7); transition:opacity .12s, transform .12s; }
.cbt-combo.on { opacity:1; transform:scale(1); }
.cbt-combo small { font-size:11px; font-weight:400; opacity:.75; margin-left:3px; }
.cbt-charge { margin-top:6px; height:5px; border-radius:3px; background:rgba(8,12,18,.72);
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.18); overflow:hidden; opacity:0; transition:opacity .1s; }
.cbt-charge.on { opacity:1; }
.cbt-charge > i { display:block; height:100%; width:0%;
  background:linear-gradient(90deg,#ff7ab0,#ffd6ea); }
.cbt-charge.full > i { background:linear-gradient(90deg,#fff2b0,#fff); box-shadow:0 0 8px #ffe9a8; }
/* 受击墨晕（模块 4 · 水墨风）：敌人真的会打你，总得让玩家**看见**这件事。
   放弃血红，改为宣纸边缘的墨色晕染 + 极淡朱砂内圈，命中感仍在但更贴合水墨基调。
   刻意不做血条 —— 玩家血量归模块 5/8 的口径，这里只做"挨打"的即时反馈。 */
.cbt-hit { position:fixed; inset:0; z-index:4; pointer-events:none; opacity:0;
  background:
    radial-gradient(ellipse at center, rgba(181,50,42,0) 52%, rgba(181,50,42,.22) 72%, rgba(181,50,42,0) 78%),
    radial-gradient(ellipse at center, rgba(28,28,30,0) 46%, rgba(28,28,30,.55) 100%);
  transition:opacity .07s linear; }
`;

export class CombatUi {
  constructor() {
    if (!document.getElementById('cbt-style')) {
      const st = document.createElement('style');
      st.id = 'cbt-style';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    this.hit = document.createElement('div');
    this.hit.className = 'cbt-hit';
    this.hit.id = 'hit-vignette';
    document.body.appendChild(this.hit);
    this._hitLevel = 0;
    this._hitTimer = 0;
    this.root = document.createElement('div');
    this.root.className = 'cbt';
    this.root.id = 'combat-ui';
    this.root.innerHTML = `
      <div class="cbt-top">
        <span class="cbt-move" data-move>待机</span>
        <span class="cbt-step" data-step></span>
        <span class="cbt-combo" data-combo>0<small>连击</small></span>
      </div>
      <div class="cbt-bar cbt-musou">
        <span class="cbt-lab">无双槽</span>
        <span class="cbt-track"><i class="cbt-fill" data-musou></i></span>
        <span class="cbt-num" data-musou-num>0</span>
      </div>
      <div class="cbt-bar cbt-ki">
        <span class="cbt-lab">斗气</span>
        <span class="cbt-track"><i class="cbt-fill" data-ki></i></span>
        <span class="cbt-num" data-ki-num>0</span>
      </div>
      <div class="cbt-charge" data-charge><i></i></div>
    `;
    document.body.appendChild(this.root);
    const q = (k) => this.root.querySelector(`[data-${k}]`);
    this.el = {
      move: q('move'),
      step: q('step'),
      combo: q('combo'),
      musou: q('musou'),
      musouNum: q('musou-num'),
      ki: q('ki'),
      kiNum: q('ki-num'),
      charge: q('charge'),
    };
    this._last = '';
  }

  toggle() {
    this.root.classList.toggle('hidden');
    return !this.root.classList.contains('hidden');
  }

  /**
   * 挨了敌人一下：屏幕边缘泛红后迅速褪掉。
   * 用"每次重新计时"而不是"往一个衰减量上累加"：连续挨打时也每一下都看得见，
   * 而不是几次之后糊成一片常亮的红（那反而看不出挨了几下）。
   */
  flashHit(strength = 1) {
    this._hitLevel = Math.min(1, this._hitLevel + strength * 0.75);
    this.hit.style.opacity = String(this._hitLevel);
    clearTimeout(this._hitTimer);
    this._hitTimer = setTimeout(() => {
      this._hitLevel = 0;
      this.hit.style.opacity = '0';
    }, 85);
  }

  /** 每帧调用，内部限频 + 变化才写 DOM（写 DOM 不该跟着渲染帧率跑） */
  update(snap) {
    const now = performance.now();
    if (this._lastT && now - this._lastT < 60) return;
    this._lastT = now;

    const moveText = snap.phase === 'charging' ? '蓄力…' : snap.busy ? `${snap.id} · ${snap.name}` : '待机';
    if (moveText !== this._last) {
      this.el.move.textContent = moveText;
      this._last = moveText;
    }
    this.el.musou.style.width = `${(snap.musouRatio * 100).toFixed(1)}%`;
    this.el.musouNum.textContent = Math.round(snap.musou);
    this.el.ki.style.width = `${(snap.kiRatio * 100).toFixed(1)}%`;
    this.el.kiNum.textContent = Math.round(snap.ki);

    const comboOn = snap.combo >= 2;
    this.el.combo.classList.toggle('on', comboOn);
    if (comboOn) this.el.combo.innerHTML = `${snap.combo}<small>连击</small>`;

    const charging = snap.phase === 'charging';
    this.el.charge.classList.toggle('on', charging);
    this.el.charge.classList.toggle('full', charging && snap.chargeRatio >= 1);
    this.el.charge.firstElementChild.style.width = `${(snap.chargeRatio * 100).toFixed(1)}%`;
  }
}
