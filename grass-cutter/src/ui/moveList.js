/**
 * 招式表 + 教学提示（模块 3）
 * ---------------------------------------------------------------------------
 * 为什么要有它，而且**必须按 N1 / N2 / C3 / C4 / C5 显示**：
 *   spec 里「C1 = 轻 / C2 = 轻+轻」这两条**就是已有的 N1/N2 本身**。
 *   如果招式表里同时出现 N1 和 C1，玩家会以为那是两招，而实际上按同一个键、
 *   出同一个动作 —— 教学文案一旦这么写，后面所有的数值讨论都会错位
 *   （"C1 的伤害调一下"调的到底是哪个动作？）。
 *   所以这里**不设 C1/C2**，轻击不足 2 次时按重键叫「重击」（独立起手，非 C 技）。
 *
 * ★整张表是**从 config 生成的**，不是手写的。
 *   手写文案一定会和实现脱节（改了数值忘了改表），而生成的表现永远等于运行时。
 *   表里不会出现 C1/C2，是因为 `COMBAT.HEAVY.MOVES` 里根本就没有这两个 id。
 */

import { COMBAT } from '../core/config.js';
import { heavyFinisherFor } from '../combat/chain.js';

const CSS = `
.ml { position:fixed; right:14px; top:14px; width:322px; z-index:5;
  font:12px/1.55 ui-monospace,Consolas,monospace; color:#e8eef6; pointer-events:none;
  text-shadow:0 1px 2px rgba(0,0,0,.9); transition:opacity .18s; }
.ml.hidden { opacity:0; }
.ml-head { display:flex; align-items:baseline; gap:8px; margin-bottom:4px; }
.ml-title { font-size:13px; letter-spacing:1px; color:#ffe9a8; }
.ml-key { margin-left:auto; font-size:11px; opacity:.6; }
.ml-sec { margin:7px 0 3px; font-size:11px; opacity:.72; letter-spacing:.5px;
  border-bottom:1px solid rgba(255,255,255,.14); padding-bottom:2px; }
.ml-row { display:grid; grid-template-columns:74px 1fr 46px 40px; gap:4px;
  padding:1px 4px; border-radius:3px; }
.ml-row > span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ml-id { color:#ffe9a8; }
.ml-trig { opacity:.78; font-size:11px; }
.ml-num { text-align:right; opacity:.9; }
.ml-stun { text-align:right; opacity:.65; font-size:11px; }
.ml-row.next { background:rgba(255,233,168,.16); box-shadow:inset 0 0 0 1px rgba(255,233,168,.45); }
.ml-row.next .ml-id { color:#fff; }
.ml-tip { margin-top:8px; padding:4px 6px; border-radius:4px;
  background:rgba(8,12,18,.62); box-shadow:inset 0 0 0 1px rgba(255,255,255,.12);
  font-size:11px; opacity:.95; }
.ml-tip b { color:#ffe9a8; font-weight:600; }
`;

/** 重击一栏的触发文案。键就是动作 id —— 表里没有 C1/C2，也就永远不会显示出这两个名字。 */
const HEAVY_TRIGGER = {
  H: '轻击不足 2 次',
  C3: '轻×2 + 重',
  C4: '轻×3 + 重',
  C5: '轻×4 + 重',
  CHARGED: '按住蓄满',
};

/** 招式表第一列：C3/C4/C5 直接显示 id，两档"不是 C 技"的显示中文名 */
function labelOf(id) {
  if (id === 'H') return '重击';
  if (id === 'CHARGED') return '蓄力斩';
  return id;
}

export class MoveList {
  constructor(cfg = COMBAT) {
    this.cfg = cfg;
    if (!document.getElementById('ml-style')) {
      const st = document.createElement('style');
      st.id = 'ml-style';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    this.root = document.createElement('div');
    this.root.className = 'ml';
    this.root.id = 'move-list';

    const head = document.createElement('div');
    head.className = 'ml-head';
    head.innerHTML = '<span class="ml-title">招式表</span><span class="ml-key">F2 隐藏</span>';
    this.root.appendChild(head);

    this.rows = new Map(); // id → 行元素
    this.root.appendChild(this._section('轻攻击 · 鼠标左键 / N'));
    for (const m of cfg.LIGHT) this.root.appendChild(this._row(m, `${m.name}`, `第 ${cfg.LIGHT.indexOf(m) + 1} 下`));

    this.root.appendChild(this._section('重击 / 蓄力 · R / C'));
    for (const m of Object.values(cfg.HEAVY.MOVES)) {
      this.root.appendChild(this._row(m, m.name, HEAVY_TRIGGER[m.id] || '—'));
    }

    // 键位速查（2026-09-25 对齐参考布局）：无双 / 武艺 / 防御 / 卸势
    this.root.appendChild(this._section('无双乱舞 · TAB（满槽） · 武艺 Q / E'));
    this.root.appendChild(this._section('防御 · F 按住 · 卸势 · 鼠标右键'));

    this.tip = document.createElement('div');
    this.tip.className = 'ml-tip';
    this.root.appendChild(this.tip);

    document.body.appendChild(this.root);
    this._last = '';
  }

  _section(text) {
    const d = document.createElement('div');
    d.className = 'ml-sec';
    d.textContent = text;
    return d;
  }

  _row(m, name, trigger) {
    const row = document.createElement('div');
    row.className = 'ml-row';
    row.dataset.move = m.id;
    const id = document.createElement('span');
    id.className = 'ml-id';
    id.textContent = labelOf(m.id);
    const nm = document.createElement('span');
    nm.className = 'ml-trig';
    nm.textContent = `${name} · ${trigger}`;
    const num = document.createElement('span');
    num.className = 'ml-num';
    num.textContent = m.hits > 1 ? `${m.damage}×${m.hits}` : `${m.damage}`;
    const stun = document.createElement('span');
    stun.className = 'ml-stun';
    stun.textContent = `${m.stun.toFixed(2)}s`;
    row.append(id, nm, num, stun);
    this.rows.set(m.id, row);
    return row;
  }

  toggle() {
    this.root.classList.toggle('hidden');
    return !this.root.classList.contains('hidden');
  }

  /** 探针抓拍前必须收起来：面板在右上，正好压住刀光那一角 */
  show(visible) {
    this.root.classList.toggle('hidden', !visible);
    return !this.root.classList.contains('hidden');
  }

  /**
   * @param snap combat.snapshot()（需要 `lights` 与 `id`）
   * 每帧调用，内部限频 —— 写 DOM 不该跟着渲染帧率跑。
   */
  update(snap) {
    const now = performance.now();
    if (this._lastT && now - this._lastT < 80) return;
    this._lastT = now;

    const lights = snap.lights | 0;
    // 下一击：轻攻击沿 N 序列往下推（第 6 下循环回 N1），重键按 spec 的映射表取。
    const nextLight = 'N' + (Math.min(this.cfg.LIGHT.length, lights + 1) || 1);
    const nextHeavy = heavyFinisherFor(lights);

    for (const [id, el] of this.rows) el.classList.toggle('next', id === nextLight || id === nextHeavy);

    const heavyText = nextHeavy === 'H' ? '重击（独立起手）' : nextHeavy;
    const tip = `已打 <b>${lights}</b> 段轻击 · 再按一次轻击 → <b>${nextLight}</b> · 现在按重键 → <b>${heavyText}</b>`;
    if (tip !== this._last) {
      this.tip.innerHTML = tip;
      this._last = tip;
    }
  }
}
