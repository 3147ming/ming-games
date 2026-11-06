/**
 * 战场 UI（模块 7）—— 纯展示层，只吃 snapshot、只写 DOM，不碰游戏逻辑。
 * ---------------------------------------------------------------------------
 * 布局（2D 叠加在 3D 之上，pointer-events:none，不挡战斗视野）：
 *   · 左上：玩家红色血条（满 100）+ 黄色无双槽 + 武艺 1/2 冷却
 *   · 右上：击杀计数；跨过 100 / 1000 时弹「百人斩 / 千人斩」大字
 *   · 左下：据点面板（名称 + 占领进度条 + 全局士气）
 *   文字用 CSS clamp() 跟随窗口缩放。
 *
 * ⚠ 这是"正式战场 UI"。模块 3 的临时 CombatUi（也是左下）在 main 里被默认隐藏，
 *   避免两个面板叠在一起——那句「模块 7 会用正式 UI 替换掉它」就是为这一刻准备的。
 */
import { HUD, INK_UI } from '../core/config.js';

const PAPER = INK_UI.PAPER;
const INK = INK_UI.INK;
const CIN = INK_UI.CINNABAR;

const CSS = `
.bh { position:fixed; inset:0; z-index:6; pointer-events:none;
  font-family:${INK_UI.FONT}; color:${INK}; text-shadow:0 1px 2px rgba(239,233,216,.35);
  /* 第 4 批 P1-5：让 HUD.FONT_MIN/MAX 真正生效（原先是一对全库无引用的死配置）。
     内部一律用 em 继承，于是"击杀 > 血/无双 > 招式 > 据点"的层级在任何窗口尺寸下都成立 */
  font-size:clamp(${HUD.FONT_MIN}px, 1.6vw, ${HUD.FONT_MAX}px); }
.bh .panel { position:absolute; }
/* 通用：宣纸米白半透明底 + 墨色细描边 */
.bh-card { background:${PAPER}; background:linear-gradient(180deg, rgba(239,233,216,.9), rgba(225,218,200,.82));
  box-shadow:inset 0 0 0 2px ${INK}, 0 3px 14px rgba(20,20,22,.4); border-radius:6px; }
/* 左上：血条 + 无双槽 + 武艺 */
.bh-tl { left:max(14px,2vw); top:max(12px,2vh); width:min(34vw,360px); padding:.5em .6em; }
.bh-row { display:flex; align-items:center; gap:.5em; margin-bottom:.4em; }
.bh-lab { width:3.2em; opacity:.85; flex:none; font-weight:700; }
.bh-track { position:relative; flex:1; height:.95em; min-height:9px; border-radius:.4em;
  background:rgba(28,28,30,.25); box-shadow:inset 0 0 0 1.5px ${INK}; overflow:hidden; }
.bh-fill { position:absolute; inset:0 auto 0 0; width:0%; border-radius:.4em; }
.bh-hp .bh-fill { background:linear-gradient(90deg,#7a1f1a,${CIN}); }
.bh-hp.low .bh-track { animation:bhLow 0.5s ease-in-out infinite; }
@keyframes bhLow { 0%,100%{box-shadow:inset 0 0 0 1.5px ${INK}, 0 0 0 0 rgba(181,50,42,0)}
  50%{box-shadow:inset 0 0 0 2px ${CIN}, 0 0 12px 2px rgba(181,50,42,.6)} }
.bh-musou .bh-fill { background:linear-gradient(90deg,#8a6a2a,#caa64a); } /* 墨金暗金 */
.bh-lv .bh-fill { background:linear-gradient(90deg,#6a6f2a,#c9d06a); } /* 第 3 批 P0-5：等级经验条 */
.bh-ki .bh-fill { background:linear-gradient(90deg,#2f5f78,${INK_UI.DAICING}); } /* 第 4 批 P0-1：斗气槽（与武艺 2 同色系） */
.bh-musou.ready .bh-fill { box-shadow:0 0 12px ${CIN}; }
.bh-seal { position:absolute; right:.3em; top:50%; transform:translateY(-50%); width:1.5em; height:1.5em;
  display:none; align-items:center; justify-content:center; border-radius:4px;
  background:${CIN}; color:${PAPER}; font-weight:800; font-size:1em; box-shadow:0 0 8px rgba(181,50,42,.7);
  animation:bhSeal 1s ease-in-out infinite; }
.bh-musou.ready .bh-seal { display:flex; }
@keyframes bhSeal { 0%,100%{filter:brightness(1)} 50%{filter:brightness(1.4)} }
.bh-num { width:3.4em; text-align:right; opacity:.9; flex:none; font-size:1.1em; font-weight:700; } /* P1-5：血/无双/斗气读数 */
.bh-arts { display:flex; gap:.6em; margin-top:.3em; }
.bh-art { flex:1; border-radius:.5em; padding:.25em .4em; background:rgba(239,233,216,.7);
  box-shadow:inset 0 0 0 1.5px ${INK}; position:relative; overflow:hidden; }
.bh-art .k { font-size:.7em; opacity:.8; }
.bh-art .n { font-size:.9em; font-weight:700; } /* P1-5：招式名 */
.bh-art .cd { position:absolute; left:0; bottom:0; height:3px; width:100%;
  background:${CIN}; transform-origin:left; transform:scaleX(0); }
.bh-art.ready { box-shadow:inset 0 0 0 2px ${CIN}; }
.bh-art.cooling { opacity:.6; }
.bh-art[data-art1] .n { color:${CIN}; }
.bh-art[data-art2] .n { color:${INK_UI.DAICING}; }
/* 右上：击杀 */
.bh-tr { right:max(14px,2vw); top:max(12px,2vh); text-align:right; }
.bh-kills { font-size:1.8em; font-weight:800; } /* P1-5：击杀数是最大最重的一档 */
.bh-kills b { color:${CIN}; font-size:1.15em; }
.bh-phase { font-size:.78em; opacity:.85; margin-top:.2em; font-weight:700; }
/* 左下：据点 */
.bh-bl { left:max(14px,2vw); bottom:max(12px,2vh); width:min(40vw,420px); padding:.5em .6em; }
.bh-bl h4 { margin:0 0 .35em; font-size:.85em; opacity:.9; font-weight:700; letter-spacing:1px; }
.bh-point { margin-bottom:.45em; }
.bh-point .nm { display:flex; justify-content:space-between; font-size:.8em; font-weight:500; } /* P1-5：据点名最轻 */
.bh-point .cap { color:${CIN}; font-weight:700; }
.bh-morale { margin-top:.4em; font-size:.78em; }
.bh-morale b { color:${CIN}; }
/* 墨色卷轴横幅（百人斩 / 千人斩） */
.bh-pop { position:absolute; left:50%; top:24%; transform:translate(-50%,-50%) scaleX(0);
  font-size:clamp(30px,6.5vw,90px); font-weight:800; letter-spacing:.1em; opacity:0;
  color:${CIN}; padding:.1em 1.2em; background:linear-gradient(180deg, rgba(239,233,216,.95), rgba(220,212,190,.9));
  box-shadow:inset 0 0 0 3px ${INK}, 0 6px 24px rgba(20,20,22,.5);
  border-left:.4em solid ${INK}; border-right:.4em solid ${INK}; white-space:nowrap;
  text-shadow:0 2px 6px rgba(239,233,216,.6); transition:transform ${INK_UI.SCROLL_BANNER.open}s cubic-bezier(.2,.8,.2,1), opacity .4s; } /* P1-5：展开时长读 SCROLL_BANNER */
.bh-pop.show { opacity:1; transform:translate(-50%,-50%) scaleX(1); }
.bh-pop.hide { opacity:0; transform:translate(-50%,-50%) scaleX(0); transition:transform ${INK_UI.SCROLL_BANNER.close}s ease-in, opacity ${INK_UI.SCROLL_BANNER.close}s; } /* P1-5：收卷时长读 SCROLL_BANNER */
/* 通关结算 */
.bh-win { position:absolute; inset:0; display:none; align-items:center; justify-content:center;
  background:rgba(20,20,22,.7); pointer-events:auto; }
.bh-win.on { display:flex; }
.bh-win .card { padding:clamp(18px,3vw,40px) clamp(24px,4vw,64px); border-radius:10px;
  background:linear-gradient(180deg, rgba(239,233,216,.96), rgba(220,212,190,.92));
  box-shadow:inset 0 0 0 3px ${INK}, 0 18px 60px rgba(0,0,0,.6); text-align:center; color:${INK}; }
.bh-win h1 { margin:0 0 .4em; color:${CIN}; letter-spacing:.12em; }
.bh-win .line { font-size:clamp(14px,1.6vw,22px); margin:.2em 0; opacity:.95; }
/* 结算卡上的「再来一把」（第 3 批 P0-4）：手机没有地址栏重载按钮，必须给一颗可点的 */
.bh-win .bh-btn { display:block; margin:1em auto 0; min-width:10em; min-height:56px;
  padding:.55em 1.6em; border-radius:8px; border:2px solid ${INK};
  background:${CIN}; color:${PAPER};
  font:700 1.05em/1.2 "Microsoft YaHei", system-ui, sans-serif;
  cursor:pointer; touch-action:manipulation; }
.bh-win .bh-btn:active { transform:translateY(1px); }
.bh-hide { display:none !important; }
/* Boss 独立血条：墨色卷轴横幅 */
.bh-boss { position:absolute; left:50%; top:max(12px,2vh); transform:translateX(-50%);
  width:min(56vw,520px); display:none; text-align:center; }
.bh-boss.on { display:block; }
.bh-boss .nm { font-size:.95em; letter-spacing:3px; color:${INK}; font-weight:800; margin-bottom:.25em; }
.bh-boss .bar { position:relative; height:1.1em; min-height:11px; border-radius:.4em;
  background:rgba(28,28,30,.35); box-shadow:inset 0 0 0 2px ${INK}; overflow:hidden; }
.bh-boss .fill { position:absolute; inset:0 auto 0 0; width:100%; background:linear-gradient(90deg,#7a1f1a,${CIN}); }
.bh-boss .fill.berserk { background:linear-gradient(90deg,${CIN},#e08a2a); box-shadow:0 0 12px ${CIN}; animation:bhBossB 0.5s ease-in-out infinite; }
@keyframes bhBossB { 0%,100%{filter:brightness(1)} 50%{filter:brightness(1.4)} }
/* ───────────── 第 3 批 P1-1：暂停键 + 暂停面板（独立一张卡，不复用结算卡的标题） */
.bh-sys { right: max(14px, 2vw); top: max(12px, 2vh); }
body:not(.touch) .bh-sys { display: none; }          /* 桌面用 F3/键盘，不占屏 */
/* 右上角被暂停键占了 44px：触屏设备把击杀数整体下移，别让两层叠在一起（任何宽度都成立） */
body.touch .bh-tr { top: calc(max(12px, 2vh) + 52px); }
.bh-icon { width: 44px; height: 44px; border-radius: 8px; border: 2px solid ${INK};
  background: ${PAPER}; color: ${INK}; font: 700 16px/1 "Microsoft YaHei", system-ui, sans-serif;
  pointer-events: auto; touch-action: manipulation; }
/* ───────────── 第 3 批 P1-2：阶段目标条（只吃现成数据，字符串不变就不写 DOM） */
.bh-aim { left: 50%; top: max(14px, 2vh); transform: translateX(-50%); padding: .26em .9em;
  font-size: .85em; display: none; white-space: nowrap; }
.bh-aim.on { display: block; }
.bh-aim b { color: ${CIN}; }
/* ───────────── 第 3 批 P1-3：受击方向箭头（屏幕边缘一个三角，指攻击者） */
.bh-hurt { position: absolute; left: 50%; top: 50%; width: 0; height: 0; opacity: 0;
  transition: opacity .35s ease; pointer-events: none;
  border-left: .7em solid transparent; border-right: .7em solid transparent;
  border-bottom: 1.1em solid ${CIN}; filter: drop-shadow(0 0 6px rgba(181,50,42,.85)); }
/* ───────────── 第 3 批 P0-7：竖屏 HUD 重排 */
@media (max-width: 520px) {
  .bh-tl { width: min(62vw, 280px); }
  .bh-bl { width: min(72vw, 300px); }
  /* 触屏按钮区高 288px（4×62 + 3×8 + 余量），据点面板必须整体让开 */
  body.touch .bh-bl { bottom: calc(300px + env(safe-area-inset-bottom)); }
  .bh-kills { font-size: 1.2em; }
  /* 目标条也居中在顶部：62vw 的左上 HUD 会盖住它，所以让 HUD 整体下移一条 */
  .bh-tl { top: calc(max(12px, 2vh) + 34px); }
}
`;

export class BattleHud {
  constructor() {
    if (!document.getElementById('bh-style')) {
      const st = document.createElement('style');
      st.id = 'bh-style';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    this.root = document.createElement('div');
    this.root.className = 'bh';
    this.root.id = 'battle-hud';
    this.root.innerHTML = `
      <div class="panel bh-tl">
        <div class="bh-row bh-hp"><span class="bh-lab">HP</span>
          <span class="bh-track"><i class="bh-fill" data-hp></i></span>
          <span class="bh-num" data-hp-num>100</span></div>
        <div class="bh-row bh-musou"><span class="bh-lab">无双</span>
          <span class="bh-track"><i class="bh-fill" data-musou></i><span class="bh-seal">無</span></span>
          <span class="bh-num" data-musou-num>0</span></div>
        <div class="bh-row bh-ki"><span class="bh-lab">斗气</span>
          <span class="bh-track"><i class="bh-fill" data-ki></i></span>
          <span class="bh-num" data-ki-num>0/60</span></div>
        <div class="bh-row bh-lv"><span class="bh-lab">等级</span>
          <span class="bh-track"><i class="bh-fill" data-lv></i></span>
          <span class="bh-num" data-lv-num>1</span></div>
        <div class="bh-arts">
          <div class="bh-art" data-art1><div class="k">[Q]</div><div class="n">裂空斩</div><i class="cd" data-art1-cd></i></div>
          <div class="bh-art" data-art2><div class="k">[E]</div><div class="n">震地击</div><i class="cd" data-art2-cd></i></div>
        </div>
      </div>
      <div class="panel bh-tr">
        <div class="bh-kills">击杀 <b data-kills>0</b></div>
        <div class="bh-phase" data-phase>前线杂兵</div>
      </div>
      <div class="panel bh-bl">
        <h4>据点 / 士气</h4>
        <div data-points></div>
        <div class="bh-morale">士气 <b data-morale>50</b> / 100</div>
      </div>
      <div class="panel bh-aim" data-aim></div>
      <div class="bh-boss" data-boss><div class="nm" data-boss-name>敌军主将</div><div class="bar"><i class="fill" data-boss-fill></i></div></div>
      <div class="bh-pop" data-pop></div>
      <div class="bh-hurt" data-hurt></div>
      <div class="panel bh-sys"><button type="button" class="bh-icon" data-pause-btn title="暂停">Ⅱ</button></div>
      <div class="bh-win bh-pause" data-pause><div class="card">
        <h1>暂歇</h1>
        <div class="line">切到后台会自动暂停</div>
        <button type="button" class="bh-btn" data-resume>继续</button>
      </div></div>
      <div class="bh-win" data-win><div class="card">
        <h1>关卡通关</h1>
        <div class="line" data-win-kills></div>
        <div class="line" data-win-hp></div>
        <div class="line" data-win-morale></div>
        <button type="button" class="bh-btn" data-again>再来一把</button>
      </div></div>
    `;
    document.body.appendChild(this.root);
    const q = (k) => this.root.querySelector(`[data-${k}]`);
    this.el = {
      hp: q('hp'), hpNum: q('hp-num'),
      musou: q('musou'), musouNum: q('musou-num'), musouRow: q('musou')?.parentElement,
      lv: q('lv'), lvNum: q('lv-num'),
      ki: q('ki'), kiNum: q('ki-num'),
      art1: q('art1'), art1Cd: q('art1-cd'),
      art2: q('art2'), art2Cd: q('art2-cd'),
      kills: q('kills'), phase: q('phase'),
      points: q('points'), morale: q('morale'),
      pop: q('pop'), win: q('win'), winKills: q('win-kills'), winHp: q('win-hp'), winMorale: q('win-morale'),
      boss: q('boss'), bossFill: q('boss-fill'), bossName: q('boss-name'),
      aim: q('aim'), hurt: q('hurt'),
      pauseBtn: q('pause-btn'), pause: q('pause'), resume: q('resume'),
      again: q('again'),
    };
    this._lastKills = 0;
    this._lastAim = '';
    this._popTimer = null;
    this._hurtTimer = null;
    // 暂停面板（P1-1）：只发信号，暂停标志归 main 的 runPaused（siblings：探针的 held 不许混用）
    this.onPause = null;
    this.onResume = null;
    this.el.pauseBtn?.addEventListener('click', () => this.onPause?.());
    this.el.resume?.addEventListener('click', () => this.onResume?.());
    // 「再来一把」（P0-4）：刷新 = 干净重开；本批仍不写存档。
    this.el.again?.addEventListener('click', () => location.reload());
  }

  setPhaseLabel(text) {
    if (this.el.phase) this.el.phase.textContent = text;
  }

  /** 模块 8：弹出 Boss 独立血条 */
  showBoss(name, hpRatio = 1) {
    if (this.el.bossName && name) this.el.bossName.textContent = name;
    if (this.el.boss) this.el.boss.classList.add('on');
    this.updateBoss(hpRatio, false);
  }

  /** 每帧刷新 Boss 血条；berserk=true 时血条变狂暴配色 */
  updateBoss(hpRatio, berserk = false) {
    if (!this.el.bossFill) return;
    const w = Math.max(0, Math.min(1, hpRatio)) * 100;
    this.el.bossFill.style.width = `${w.toFixed(1)}%`;
    this.el.bossFill.classList.toggle('berserk', !!berserk);
  }

  hideBoss() {
    if (this.el.boss) this.el.boss.classList.remove('on');
  }

  /** 跨过百人斩/千人斩阈值时弹字（每次跨过只弹一次） */
  _checkKillMilestone(kills) {
    const fire = (label) => {
      if (this.el.pop) {
        this.el.pop.textContent = label;
        this.el.pop.classList.add('show');
        clearTimeout(this._popTimer);
        this._popTimer = setTimeout(() => this.el.pop.classList.remove('show'), (INK_UI.SCROLL_BANNER?.hold ?? 2.5) * 1000); // P1-5：停留时长读 SCROLL_BANNER
      }
    };
    if (this._lastKills < HUD.HUNDRED_KILL && kills >= HUD.HUNDRED_KILL) fire(HUD.HUNDRED_LABEL);
    if (this._lastKills < HUD.THOUSAND_KILL && kills >= HUD.THOUSAND_KILL) fire(HUD.THOUSAND_LABEL);
    this._lastKills = kills;
  }

  update(snap) {
    // 血量（模块 7：红色血条，满 100）；≤25% 触发水墨低血闪烁 + 墨晕扩散
    const hpRatio = snap.maxHp > 0 ? snap.hp / snap.maxHp : 0;
    this.el.hp.style.width = `${(hpRatio * 100).toFixed(1)}%`;
    this.el.hpNum.textContent = `${Math.max(0, Math.round(snap.hp))}/${snap.maxHp}`;
    const hpRow = this.el.hp.closest('.bh-hp');
    if (hpRow) hpRow.classList.toggle('low', hpRatio <= INK_UI.LOW_HP);
    // 无双槽（黄色；满了高亮）
    this.el.musou.style.width = `${(snap.musouRatio * 100).toFixed(1)}%`;
    this.el.musouNum.textContent = `${Math.round(snap.musou)}/${snap.musouMax}`;
    this.el.musouRow.classList.toggle('ready', !!snap.musouReady);

    // 斗气槽（第 4 批 P0-1）：武艺的唯一资源，之前只能靠按钮亮不亮猜存量
    if (snap.ki !== undefined && this.el.ki) {
      const kr = Number.isFinite(snap.kiRatio) ? snap.kiRatio : 0;
      this.el.ki.style.width = `${(Math.max(0, Math.min(1, kr)) * 100).toFixed(1)}%`;
      this.el.kiNum.textContent = `${Math.round(snap.ki)}/${snap.kiMax ?? '?'}`;
    }

    // 等级 / 经验（第 3 批 P0-5）：只在 main 传了 run 快照时才写
    if (snap.run && this.el.lv) {
      const r = snap.run;
      const ratio = r.need > 0 ? Math.min(1, r.xp / r.need) : 0;
      this.el.lv.style.width = `${(ratio * 100).toFixed(1)}%`;
      this.el.lvNum.textContent = `${r.level}`;
    }

    // 武艺冷却
    this._art(this.el.art1, this.el.art1Cd, snap.art1);
    this._art(this.el.art2, this.el.art2Cd, snap.art2);

    // 击杀
    this.el.kills.textContent = snap.kills;
    this._checkKillMilestone(snap.kills);

    // 据点 + 士气
    if (snap.points) {
      let html = '';
      for (const p of snap.points) {
        const w = Math.max(0, Math.min(100, p.progress)).toFixed(0);
        html += `<div class="bh-point"><div class="nm"><span>${p.name}</span>` +
          `<span class="cap">${p.captured ? '已占领' : w + '%'}</span></div>` +
          `<div class="bh-track"><i class="bh-fill" style="width:${w}%;background:${p.captured ? 'linear-gradient(90deg,#5fe08a,#b6ffcf)' : 'linear-gradient(90deg,#7aa6ff,#bcd4ff)'}"></i></div></div>`;
      }
      this.el.points.innerHTML = html;
    }
    if (snap.morale !== undefined) this.el.morale.textContent = Math.round(snap.morale);

    // 阶段目标（P1-2）：数据全部现成，只做拼字符串；**只在字符串变化时写 DOM**
    if (snap.stage && this.el.aim) {
      const s = snap.stage;
      let text = '';
      if (s.phase === 'frontline') text = `清剿 <b>${snap.kills}</b> / ${s.killsToContest}`;
      else if (s.phase === 'contest' && snap.points) {
        const got = snap.points.filter((q) => q.captured).length;
        const next = snap.points.find((q) => !q.captured) || snap.points[0];
        text = `据点 <b>${got}</b> / ${snap.points.length} · ${next.name} 守卫 ${next.guardsAlive}`;
      }
      if (text !== this._lastAim) {
        this._lastAim = text;
        this.el.aim.innerHTML = text;
        this.el.aim.classList.toggle('on', !!text);
      }
    }
  }

  _art(box, cd, a) {
    if (!box || !a) return;
    box.classList.toggle('ready', !!a.ready);
    box.classList.toggle('cooling', a.cd > 0);
    cd.style.transform = `scaleX(${(1 - (a.cdRatio ?? 0)).toFixed(3)})`;
  }

  showVictory({ kills, hp, hpMax, morale }) {
    this.el.winKills.textContent = `总击杀：${kills}`;
    this.el.winHp.textContent = `剩余血量：${Math.max(0, Math.round(hp))} / ${hpMax}`;
    this.el.winMorale.textContent = `士气：${Math.round(morale)} / 100`;
    this.el.win.classList.add('on');
  }

  hideVictory() {
    this.el.win.classList.remove('on');
  }

  /** 暂停面板（P1-1）：只负责显隐，暂停标志在 main 的 runPaused */
  showPause() { this.el.pause?.classList.add('on'); }

  hidePause() { this.el.pause?.classList.remove('on'); }

  /**
   * 受击方向箭头（P1-3）：angleRad 是"攻击者相对镜头朝向"的角度，0 = 正前方。
   * 同一时刻只留一个箭头（clearTimeout 覆盖上一次的淡出计时）。
   */
  showHurtFrom(angleRad) {
    const el = this.el.hurt;
    if (!el) return;
    el.style.transform = `translate(-50%,-50%) rotate(${angleRad}rad) translateY(-42vh)`;
    el.style.opacity = '1';
    clearTimeout(this._hurtTimer);
    this._hurtTimer = setTimeout(() => { el.style.opacity = '0'; }, 900);
  }

  /**
   * 战败结算（P0-3）：复用通关那张纸卡，只换文案。
   * 「再来一把」是同一颗按钮，逻辑不用改（P0-4）。
   */
  showDefeat({ kills, elapsed }) {
    const sec = Math.max(0, Math.floor(elapsed));
    this.el.win.querySelector('h1').textContent = '力竭';
    this.el.winKills.textContent = `总击杀：${kills}`;
    this.el.winHp.textContent = `坚持：${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    this.el.winMorale.textContent = '敌军夺回了战场';
    this.el.win.classList.add('on');
  }
}
