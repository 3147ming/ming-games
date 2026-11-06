// 表现层（DOM 渲染 + 交互）
// 口径：UI 不持有任何局内状态，只读 Run / Combat 并回调。
//      这样「无头模拟」与「真人游玩」跑的是同一套规则代码。

import { CONST, STATUS_TEXT } from '../config/constants.js';
import { ARCHETYPES, ARCHETYPE_MAP } from '../config/archetypes.js';
import { CARD_MAP, POOL_CARDS } from '../config/cards.js';
import { RELICS } from '../config/relics.js';
import { SET_DEFS, countSets, activeBonuses } from './sets.js';
import { describeCard, describeRelic, typeText, rarityText, shortCardText } from './describe.js';
import { glyphSvg } from './glyph.js';
import { intentView } from './enemy.js';
import { ENEMY_MAP } from '../config/enemies.js';
import { EPITAPHS } from '../config/epitaphs.js';
import { PHASE, dailyInfo } from './run.js';
import { NODE_META } from './mapgen.js';
import { Fx } from './fx.js';
import { Sfx } from './sfx.js';
import { resolveLogEnv, lastLog, amendLastLog } from './logger.js';
import { load } from './storage.js';

const $ = (id) => document.getElementById(id);
const SET_BY_ID = Object.fromEntries(SET_DEFS.map((s) => [s.id, s]));

export class Ui {
  constructor(h) {
    this.h = h;
    this.el = {
      hudHpFill: $('hud-hp-fill'),
      hudHpText: $('hud-hp-text'),
      hudProgress: $('hud-progress'),
      hudSeed: $('hud-seed'),
      hudRelics: $('hud-relics'),
      hudSets: $('hud-sets'),
      hudDeck: $('hud-deck'),
      hudDeckN: $('hud-deck-n'),
      energy: $('energy'),
      energyNow: $('energy-now'),
      energyMax: $('energy-max'),
      block: $('block'),
      blockNow: $('block-now'),
      stage: $('stage'),
      enemyZone: $('enemy-zone'),
      logZone: $('log-zone'),
      handZone: $('hand-zone'),
      handTrack: $('hand-track'),
      actionZone: $('action-zone'),
      btnEndTurn: $('btn-end-turn'),
      pileDraw: $('pile-draw').querySelector('.pile-n'),
      pileDiscard: $('pile-discard').querySelector('.pile-n'),
      mapBody: $('map-body'),
      mapTitle: $('map-title'),
      rewardBody: $('reward-body'),
      eventBody: $('event-body'),
      eventTitle: $('event-title'),
      restBody: $('rest-body'),
      metaBody: $('meta-body'),
      metaTitle: $('meta-title'),
      overTitle: $('over-title'),
      overSub: $('over-sub'),
      toast: $('toast'),
      fx: $('fx'),
    };
    this.fx = new Fx(this.el.fx);
    // 第四批 P1-5：音效实例跟着 UI 走 —— 表现层的东西不该漏进 run/combat。
    this.sfx = new Sfx();
    this._bindSfxUnlock();
    // 第四批 P1-2：数值弹跳要记住"上一次的值"。只活在 UI 实例上，不进 run 快照。
    this._prevEnergy = -1;
    this._prevBlock = -1;
    this.screen = 'title';
    this.logCursor = 0;
    this.handScroll = 0;
    this.busy = false;
    // 玩家剪影（阶段 5 / T1）：位置由 playerAnchor 钉，颜色按流派注入。
    this.el.playerZone = $('player-zone');
    this.el.playerFigure = this.el.playerZone ? this.el.playerZone.querySelector('.player-figure') : null;
    this.el.playerShield = this.el.playerZone ? this.el.playerZone.querySelector('.player-shield') : null;
    // 阶段 5 / T4：DOM 层输入去抖（只拦真人双击，不碰 act.* → 不会卡死探针）。
    // 不能用 ui.busy：main.onPlayCard 以 ui.busy 为门槛，复用它会让探针的 act.playCard 被挡。
    this._lastCardTap = { uid: -1, t: 0 };
    this._lastEndTap = 0;
    this._poseToken = 0;
    this._poisonTimer = 0;
    this._setupSkipListener();
  }

  /** 阶段 5 / T4：一个全局 one-time 监听器 —— 点屏幕任意处跳过当前所有未播动画。
   *  不 preventDefault，所以不会吞掉出牌/点按钮；只清掉已在播放的一次性特效与姿势。 */
  _setupSkipListener() {
    document.addEventListener(
      'pointerdown',
      () => {
        if (this.fx.items.length === 0 && !this._poseToken) return; // 没有在播的动画就不打扰
        this.skipAnimations();
      },
      true
    );
  }

  skipAnimations() {
    this.fx.clear();
    const ec = document.getElementById('enemy-card');
    if (ec) ec.classList.remove('hit', 'is-strike');
    // 第四批 P1-1：震屏与飞行副本也属于"一次性动画"，点屏幕就该立刻收掉。
    if (this.el.stage) this.el.stage.classList.remove('shake');
    for (const g of document.querySelectorAll('.card-ghost')) g.remove();
    if (this.el.playerFigure) this.el.playerFigure.classList.remove('is-strike', 'is-block', 'is-hurt');
  }

  /** 第四批 P1-5：iOS 只在用户手势里允许创建/恢复 AudioContext —— 挂一次就够。 */
  _bindSfxUnlock() {
    const un = () => this.sfx.unlock();
    document.addEventListener('pointerdown', un, { once: true, capture: true });
    document.addEventListener('keydown', un, { once: true, capture: true });
  }

  /** 第四批 P1-2：数值变化时让徽标"弹一下"（≤200ms）。reduce 下直接不动。 */
  _bump(el) {
    if (!el || this.fx.reduced) return;
    el.classList.remove('bump');
    void el.offsetWidth; // 强制重排：连续两次变化也能重启动画（否则第二次加类无效）
    el.classList.add('bump');
    clearTimeout(el._bumpTimer);
    el._bumpTimer = setTimeout(() => el.classList.remove('bump'), 220);
  }

  /** 第四批 P1-1：出牌飞行副本。
   *  为什么做成"克隆一个固定在视口原位的副本"而不是"延后 renderCombat"：
   *  延后重绘会让 act.playCard 的 UI 更新滞后（探针连打时会读到旧手牌），
   *  而克隆副本既能保住"牌飞出去"的观感，又让 combat 结算与重绘保持同步。
   *  用法：重绘**前** const fly = ui.cardGhost(uid)；重绘**后** fly?.()。 */
  cardGhost(uid) {
    if (this.fx.reduced) return null;
    const cardEl = document.querySelector('#hand-track .card[data-uid="' + uid + '"]');
    if (!cardEl) return null;
    const r = cardEl.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const ghost = cardEl.cloneNode(true);
    ghost.removeAttribute('data-uid');
    ghost.classList.add('card-ghost');
    ghost.style.position = 'fixed';
    ghost.style.left = r.left + 'px';
    ghost.style.top = r.top + 'px';
    ghost.style.width = r.width + 'px';
    ghost.style.height = r.height + 'px';
    ghost.style.margin = '0';
    ghost.style.zIndex = '80';
    ghost.style.pointerEvents = 'none';
    document.body.appendChild(ghost);
    return () => {
      const p = this.enemyPos();
      const s = this.el.stage.getBoundingClientRect();
      const tx = Math.round(s.left + p.x - (r.left + r.width / 2));
      const ty = Math.round(s.top + p.y - (r.top + r.height / 2));
      ghost.style.setProperty('--gx', tx + 'px');
      ghost.style.setProperty('--gy', ty + 'px');
      requestAnimationFrame(() => ghost.classList.add('go'));
      setTimeout(() => ghost.remove(), 320);
    };
  }

  /** 阶段 5 / T3：按环节切背景（只在 #stage 上加 mood-* class，只改 background-color，transition 0.6s）。 */
  setMood(name) {
    const s = this.el.stage;
    for (const c of [...s.classList]) if (c.startsWith('mood-')) s.classList.remove(c);
    s.classList.add('mood-' + name);
  }

  /** 阶段 5 / T1：玩家剪影姿势（≤300ms）。reduced-motion 下由 CSS 把 transform 归零，这里照常加类即可。 */
  playerPose(name, ms) {
    if (!this.el.playerFigure) return;
    const token = ++this._poseToken;
    this.el.playerFigure.classList.add('is-' + name);
    setTimeout(() => {
      if (token !== this._poseToken) return; // 已有更新的姿势，旧定时器作废
      this.el.playerFigure.classList.remove('is-' + name);
    }, ms);
  }

  /** 阶段 5 / T1：中毒绿雾持续发射（每 120ms 冒一粒，直到中毒层数为 0）。
   *  只读 combat.state，不写任何 run 字段；reduced-motion 下 mist() 自身跳过。 */
  startPoisonMist(combat) {
    clearInterval(this._poisonTimer);
    if (this.fx.reduced) return; // 降级模式不发射粒子
    const tick = () => {
      if (!combat || !combat.state) return;
      const s = combat.state;
      if (s.enemy.statuses.poison > 0) {
        const p = this.enemyPos();
        if (p) this.fx.mist(p.x, p.y, '#7ba64a');
      }
      if (s.player.statuses.poison > 0) {
        const p = this.playerAnchor;
        this.fx.mist(p.x, p.y - 18, '#7ba64a');
      }
      if (s.enemy.statuses.poison <= 0 && s.player.statuses.poison <= 0) clearInterval(this._poisonTimer);
    };
    tick();
    this._poisonTimer = setInterval(tick, 120);
  }

  enemyPos() {
    const card = document.getElementById('enemy-card');
    return card ? this.centerOf(card) : { x: 180, y: 140 };
  }

  // ---------- 基础 ----------

  show(name) {
    for (const s of document.querySelectorAll('.screen')) s.classList.remove('active');
    const target = $('screen-' + name);
    if (target) target.classList.add('active');
    else if (typeof console !== 'undefined') console.warn('[ui] 没有这个屏：', name);
    this.screen = name;
    // 阶段 5 / T3：每个环节给 #stage 上对应 mood（combat 在 renderCombat 里还会细化到 elite/boss）。
    const mood = {
      title: 'neutral', map: 'neutral', combat: 'battle', reward: 'neutral',
      event: 'event', rest: 'rest', remove: 'rest', meta: 'neutral', over: 'neutral',
    }[name] || 'neutral';
    this.setMood(mood);
    if (name !== 'combat') {
      this.fx.clear();
      clearInterval(this._poisonTimer); // 离开战斗，停掉绿雾定时器
    }
    requestAnimationFrame(() => this.fx.resize());
  }

  toast(text, ms = 1300) {
    const t = this.el.toast;
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  centerOf(el) {
    const s = this.el.stage.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { x: r.left - s.left + r.width / 2, y: r.top - s.top + r.height / 2 };
  }

  get playerAnchor() {
    const s = this.el.stage.getBoundingClientRect();
    const hz = this.el.handZone.getBoundingClientRect();
    // 剪影中心：钉在手牌区上方，使其脚部刚好悬在手牌之上而不压住卡面。
    return { x: s.width / 2, y: Math.max(60, hz.top - s.top - 54) };
  }

  // ---------- HUD ----------

  renderHud(run) {
    if (!run) {
      this.el.hudHpFill.style.width = '100%';
      this.el.hudHpText.textContent = `${CONST.HP_PLAYER} / ${CONST.HP_PLAYER}`;
      this.el.hudProgress.textContent = '第 1 层 · 1/4';
      this.el.hudSeed.textContent = '种子 ——';
      this.el.hudRelics.innerHTML = '';
      if (this.el.hudSets) this.el.hudSets.innerHTML = '';
      return;
    }
    const pct = Math.max(0, Math.min(100, (run.hp / run.maxHp) * 100));
    this.el.hudHpFill.style.width = pct + '%';
    this.el.hudHpText.textContent = `${run.hp} / ${run.maxHp}`;
    const n = run.currentNode;
    this.el.hudProgress.textContent = n
      ? `第 ${n.floor} 层 · ${n.index + 1}/${CONST.NODES_PER_FLOOR}`
      : `第九层的尽头`;
    this.el.hudSeed.textContent = `种子 ${run.seed}`;
    // 机制批 P0-7：遗物改可点方块（去掉 title，手机上触屏没有 hover）。点击弹 toast 显示效果。
    // 第四批套装：属于套装的遗物加一圈金边，点开时一并说出「哪套、几件、还差几件」。
    const counts = countSets(run.relicIds);
    const bonuses = activeBonuses(run.relicIds);
    const bonusBySet = new Map(bonuses.map((b) => [b.setId, b]));
    this.el.hudRelics.innerHTML = run.relicIds
      .map((id) => {
        const r = RELICS.find((x) => x.id === id);
        return r ? `<span class="relic-chip${r.set ? ' set-member' : ''}" data-relic="${r.id}">${r.n.slice(0, 1)}</span>` : '';
      })
      .join('');
    for (const el of this.el.hudRelics.querySelectorAll('[data-relic]')) {
      el.onclick = () => {
        const r = RELICS.find((x) => x.id === el.dataset.relic);
        if (!r) return;
        // describeRelic 输出带 <b>/<br>，toast 里只需要纯文本
        const def = r.set ? SET_BY_ID[r.set] : null;
        const n = def ? counts[def.id] : 0;
        const setLine = def
          ? `；【${def.name}】${n}/3${n >= 3 ? '（已集齐）' : `，还差 ${3 - n} 件`}`
          : '';
        this.toast(`${r.n}：${describeRelic(r).replace(/<br>/g, '；').replace(/<\/?b>/g, '')}${setLine}`, 3600);
      };
    }
    // 套装进度条：只显示本局已经沾到的套装，避免 HUD 被四行空槽占满。
    // 2 件档用金色描边（on），3 件档填金（done）—— 玩家不点开也能一眼看出「质变已生效」。
    if (this.el.hudSets) {
      this.el.hudSets.innerHTML = SET_DEFS.filter((s) => counts[s.id] > 0)
        .map((s) => {
          const n = counts[s.id];
          const b = bonusBySet.get(s.id);
          const cls = `set-chip${b ? ' on' : ''}${b && b.tier === 3 ? ' done' : ''}`;
          return `<span class="${cls}" data-set="${s.id}">${s.name} ${n}/3${n < 3 ? ` · 差${3 - n}` : ''}</span>`;
        })
        .join('');
      for (const el of this.el.hudSets.querySelectorAll('[data-set]')) {
        el.onclick = () => {
          const def = SET_BY_ID[el.dataset.set];
          if (!def) return;
          const n = counts[def.id];
          const b = bonusBySet.get(def.id);
          const stateText = b
            ? `当前生效（${b.tier} 件）：${b.text}`
            : `还差 ${3 - n} 件集齐 3 件效果。`;
          this.toast(
            `${def.name} ${n}/3｜${def.desc}｜2 件：${def.two.text}｜3 件：${def.three.text}｜${stateText}`,
            5200
          );
        };
      }
    }
    // 机制批 P0-1：牌组数字 + 只读牌组视图入口
    if (this.el.hudDeckN) this.el.hudDeckN.textContent = run.deck.length;
    if (this.el.hudDeck) this.el.hudDeck.onclick = () => this.h.onDeckView();
  }

  // ---------- 标题页 ----------

  renderTitle(meta) {
    this.show('title');
    const actions = document.querySelector('#screen-title .title-actions');
    // 机制批 P0-6：存在节点边界快照时，给一个「继续这一世」入口（resumeRun 读快照续局）。
    const snap = load(CONST.RUN_KEY, null);
    const canResume = !!(snap && snap.v === 1);
    // 内容批 P1-7：今日之牌 —— 按钮上直接写今日日期与今日最好成绩（没打过就只有日期）
    const di = dailyInfo();
    const drec = load('one-card:daily:v1', null);
    const todayRec = drec && drec.date === di.date ? drec : null;
    const dailyLabel = todayRec
      ? `今日之牌 · ${di.date.slice(5).replace('-', '/')} · 最好 ${todayRec.best.nodes || 0}/${CONST.FLOORS * CONST.NODES_PER_FLOOR} 节点`
      : `今日之牌 · ${di.date.slice(5).replace('-', '/')}`;
    actions.innerHTML =
      '<button id="btn-new-run" class="big">开始一世</button>' +
      (canResume ? '<button id="btn-resume">继续这一世</button>' : '') +
      `<button id="btn-daily">${dailyLabel}</button>` +
      '<button id="btn-codex">牌谱</button>';
    $('btn-new-run').onclick = () => this.showArchetypePicker();
    $('btn-codex').onclick = () => this.renderCodex(meta);
    $('btn-daily').onclick = () => this.h.onDaily();
    if (canResume) $('btn-resume').onclick = () => this.h.onResumeRun();
    const done = POOL_CARDS.length - meta.unlockedCards.length;
    // 内容批 P1-6：难度阶梯显示（封顶 5）。0 阶不显示 —— 第一世的标题页不该有数字。
    const asc = meta.ascension || 0;
    const carriedCard = meta.carried && CARD_MAP[meta.carried] ? CARD_MAP[meta.carried] : null;
    $('title-stats').innerHTML =
      `已归来 ${meta.runs} 世 · 抵达第九层 ${meta.wins} 次<br>` +
      `牌谱 ${meta.unlockedCards.length} / ${POOL_CARDS.length} · 遗物 ${meta.unlockedRelics.length} / ${RELICS.length}` +
      (done > 0 ? `<br>还有 <b>${done}</b> 张牌没被你带回来` : '<br>你把所有的牌都带回来了。') +
      // 第三批 P0-3：本世带着哪张牌 —— 它是这个游戏的全部卖点，标题页必须看得见、点得开
      (carriedCard
        ? `<br>本世带着 <b id="title-carried" style="color:var(--gold);cursor:pointer">${carriedCard.n}</b>` +
          `（${typeText(carriedCard.t)} · ${(ARCHETYPE_MAP[carriedCard.a] || {}).name || ''}）`
        : '') +
      (asc > 0 ? `<br>第九层之下 <b>${'ⅠⅡⅢⅣⅤⅥⅦⅧ'[Math.min(asc, 8) - 1]}</b> · 敌人血量 +${asc * 12}%` : '') +
      // 内容批 P1-8：世记 —— 最近 6 世，最新的在最上面（纯 DOM，不新开屏）
      this.historyHtml(meta);
    this.renderHud(null);
    const tc = $('title-carried');
    if (tc) tc.onclick = () => this.toast(describeCard(carriedCard).replace(/<\/?b>/g, ''), 2600);
  }

  /**
   * 内容批 P1-8：世记（最近 6 世）。流派名必须走 ARCHETYPE_MAP，不在模板里写死中文映射。
   * 第三批 P0-3：行尾补「带走了什么」—— e.carried 早就被写进历史里了，只是没显示。
   * 第三批 P1-11：每日局也会进世记（run === null），显示为「今日」而不是「第 N 世」。
   */
  historyHtml(meta) {
    const h = (meta.history || []).slice(-6).reverse();
    if (!h.length) return '';
    return `<div class="hist">${h
      .map(
        (e) =>
          `${e.daily ? '今日' : `第 ${e.run} 世`} · ${(ARCHETYPE_MAP[e.arch] || {}).name || e.arch} · ` +
          `${e.cleared ? '通关' : `死在第 ${e.floor} 层`} · 牌组 ${e.deck} 张` +
          (e.carried && CARD_MAP[e.carried] ? ` · 带着 ${CARD_MAP[e.carried].n}` : '')
      )
      .join('<br>')}</div>`;
  }

  /** 内容批 P1-9：第一步 —— 选流派（第二步选出身，见 showOriginPicker）。 */
  showArchetypePicker() {
    this.show('title');
    const actions = document.querySelector('#screen-title .title-actions');
    const carriedNow = this.h.getMeta().carried && CARD_MAP[this.h.getMeta().carried]
      ? CARD_MAP[this.h.getMeta().carried] : null;
    actions.innerHTML =
      `<div style="font-size:12px;color:var(--paper-dim);margin-bottom:2px">选择你这一世的身体</div>` +
      // 第三批 P0-3：选流派时必须知道「这一世会带上什么」—— 否则没法做「带回来的毒核心 → 继续选蚀」这个决策
      (carriedNow
        ? `<div style="font-size:11px;color:var(--gold);margin-bottom:6px">本世会带上「${carriedNow.n}」—— 选同一流派更容易凑出 combo</div>`
        : '') +
      ARCHETYPES.map(
        (a) => `<button class="big" data-arch="${a.id}" style="text-align:left;letter-spacing:0">
          <span style="color:var(--${a.color})">${a.name}</span> · ${a.tag}
          <i style="display:block;font-style:normal;font-size:11px;color:var(--paper-dim);margin-top:3px">${a.winLine}</i>
        </button>`
      ).join('') +
      '<button id="btn-arch-back">返回</button>';
    for (const b of actions.querySelectorAll('[data-arch]')) {
      b.onclick = () => this.showOriginPicker(b.dataset.arch);
    }
    $('btn-arch-back').onclick = () => this.renderTitle(this.h.getMeta());
  }

  /**
   * 内容批 P1-9：第二步 —— 选出身。
   * 口径：每个出身**只替换流派那 2 张入门牌**，4 打击 + 4 防御不动，牌组仍是 10 张。
   *      没有 origins 字段的流派直接开局（配置缺字段也不能把玩家卡在选人页）。
   */
  showOriginPicker(archId) {
    const a = ARCHETYPE_MAP[archId];
    if (!a) return this.showArchetypePicker();
    if (!a.origins || !a.origins.length) return this.h.onStartRun(archId);
    this.show('title');
    const actions = document.querySelector('#screen-title .title-actions');
    actions.innerHTML =
      `<div style="font-size:12px;color:var(--paper-dim);margin-bottom:2px">
        <span style="color:var(--${a.color})">${a.name}</span> · 你是从哪里来的？</div>` +
      a.origins
        .map(
          (o) => `<button class="big" data-origin="${o.id}" style="text-align:left;letter-spacing:0">
            ${o.n} · ${o.tag}
            <i style="display:block;font-style:normal;font-size:11px;color:var(--paper-dim);margin-top:3px">${o.deck
              .map((cid) => (CARD_MAP[cid] ? CARD_MAP[cid].n : cid))
              .join(' + ')}</i>
          </button>`
        )
        .join('') +
      '<button id="btn-origin-back">换流派</button>';
    for (const b of actions.querySelectorAll('[data-origin]')) {
      b.onclick = () => this.h.onStartRun(archId, { originId: b.dataset.origin });
    }
    $('btn-origin-back').onclick = () => this.showArchetypePicker();
  }

  // ---------- 地图 ----------

  renderMap(run) {
    this.show('map');
    this.renderHud(run);
    this.el.mapTitle.textContent = `第九层 · 已走过 ${run.cleared}/${run.map.length}`;
    this.el.mapBody.innerHTML = run.map
      .map((n) => {
        const m = NODE_META[n.type] || {};
        const cur = n.uid === run.cursor;
        const cls = ['map-node'];
        if (n.done && !cur) cls.push('done');
        if (cur) cls.push('current');
        if (n.type === 'boss') cls.push('boss');
        if (n.type === 'wild') cls.push('wild'); // 阶段 6：荒野节点用 --flux 紫区分
        const sep = n.index === 0 && n.floor > 1 ? `<div class="map-sep">—— 第 ${n.floor} 层 ——</div>` : '';
        const sub = cur ? '你在这里' : n.done ? '已通过' : m.hint;
        return `${sep}<div class="${cls.join(' ')}">
          <span class="mk">${m.icon || '·'}</span>
          <span class="mn">${cur ? '▶ ' : ''}${m.label || n.type}</span>
          <span class="ms">${sub}</span>
        </div>`;
      })
      .join('');
    this.el.mapBody.scrollTop = this.el.mapBody.scrollHeight;
    // 机制批 P1-2：入口二选一 —— 即将进入的节点若带 alt，给一个副选项
    const upcoming = run.map.find((n) => !n.done);
    const altWrap = document.getElementById('map-alt');
    if (altWrap) altWrap.remove();
    if (upcoming && upcoming.alt) {
      const alt = upcoming.alt;
      const altLabel = NODE_META[alt.type] ? NODE_META[alt.type].label : alt.type;
      const wrap = document.createElement('div');
      wrap.id = 'map-alt';
      wrap.className = 'map-alt';
      wrap.innerHTML = `也可以走：<button data-alt="1">${altLabel}</button>`;
      wrap.querySelector('[data-alt]').onclick = (ev) => {
        ev.stopPropagation();
        // 第三批 P0-1：第二参 true = 明确走备选。旧实现与主路线共用同一条路径，
        // 于是「点遗迹」和「点屏幕」结果完全一样，这个决策根本不存在。
        this.h.onAdvance(upcoming.uid, true);
      };
      this.el.mapBody.appendChild(wrap);
    }
    // 第三批 P1-10：整屏点击 = 前进，但地图是可滚动的 —— 滑一下浏览路线就误进节点。
    // 口径：同一次触摸里位移超过 8px 就算滑动，松手补发的那个 click 一律不前进。
    let sx = 0;
    let sy = 0;
    let moved = false;
    this.el.mapBody.ontouchstart = (e) => {
      moved = false;
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
    };
    this.el.mapBody.ontouchmove = (e) => {
      if (Math.abs(e.touches[0].clientX - sx) > 8 || Math.abs(e.touches[0].clientY - sy) > 8) moved = true;
    };
    $('screen-map').onclick = () => {
      if (moved) {
        moved = false;
        return;
      }
      this.h.onAdvance();
    };
    // 显式「继续」按钮：滑动被屏蔽之后，需要一个不靠「点空白」的明确出口。
    // 每次重渲染先删再建，避免叠加。
    const oldGo = document.getElementById('btn-map-go');
    if (oldGo) oldGo.remove();
    const go = document.createElement('button');
    go.id = 'btn-map-go';
    go.className = 'big';
    go.textContent = '继续 · 下一站';
    go.onclick = (ev) => {
      ev.stopPropagation();
      this.h.onAdvance();
    };
    this.el.mapBody.parentElement.appendChild(go);
  }

  // ---------- 战斗 ----------

  renderCombat(run, combat) {
    document.getElementById('tut')?.remove();   // 机制批 P1-5：每次重渲染先清掉新手提示
    this.show('combat');
    this.renderHud(run);
    // 阶段 5 / T3：按节点类型细化氛围（精英偏红、Boss 深红暗涌）。
    const node = run.currentNode;
    this.setMood(node && node.type === 'boss' ? 'boss' : node && node.type === 'elite' ? 'elite' : 'battle');
    // 阶段 5 / T1：玩家剪影钉位 + 按流派上色。
    if (this.el.playerZone) {
      const arch = ARCHETYPE_MAP[run.archetypeId];
      if (arch) this.el.playerZone.style.color = `var(--${arch.color})`;
      const pa = this.playerAnchor;
      this.el.playerZone.style.left = pa.x + 'px';
      this.el.playerZone.style.top = pa.y + 'px';
    }
    const s = combat.state;
    const e = s.enemy;
    const iv = intentView(s, e);

    this.el.enemyZone.innerHTML = `
      <div class="enemy-card" id="enemy-card">
        <div class="enemy-name">${e.n}</div>
        <div class="enemy-sub">${e.sub || ''}${e.phase2 ? ' · 蜕变' : ''}</div>
        <div class="enemy-glyph">${glyphSvg({ shape: e.shape, tier: e.tier })}</div>
        <div class="enemy-hp bar">
          <div class="bar-fill" style="width:${Math.max(0, (e.hp / e.maxHp) * 100)}%"></div>
          <span class="bar-text">${e.hp} / ${e.maxHp}</span>
        </div>
        <div class="enemy-flags">
          ${e.block > 0 ? `<span class="flag block">格挡 ${e.block}</span>` : ''}
          ${this.statusFlags(e.statuses, 'enemy')}
        </div>
        <div class="intent ${iv.kind}">
          <span>意图</span><span class="iv">${iv.value}</span><span>${iv.text}</span>
          ${iv.kind === 'atk' && s.player.block > 0 && Number.isFinite(Number(iv.value))
            ? `<span class="iv-net">你还吃 ${Math.max(0, Number(iv.value) - s.player.block)}</span>`
            : ''}
        </div>
      </div>`;

    this.renderLog(combat);
    // 机制批 P1-5：新手提示只在「第一世」出现。不引入新的存档字段 —— meta.runs 就是最准的判据。
    const firstLife = run.meta.runs === 0;
    if (firstLife && !this._tutDismissed) {
      this.el.logZone.insertAdjacentHTML('beforebegin', `
        <div id="tut" class="tut">
          <b>点手牌出牌</b>：左上数字是费用，灰牌是费不够 · 每回合 3 能量<br>
          <b>意图</b>是它下回合要做什么 · 打完点<b>结束回合</b>
        </div>`);
    }
    this.renderHand(combat);
    this.renderPiles(combat);
    // 机制批 P0-2：能量可见。数据源就是 s.player，不新增字段。
    if (this.el.energy) {
      // 第四批 P1-2：数字硬跳会让"消耗/获得"没有量感 —— 变化时让徽标弹一下（≤200ms）。
      if (this._prevEnergy >= 0 && this._prevEnergy !== s.player.energy) this._bump(this.el.energy);
      this._prevEnergy = s.player.energy;
      this.el.energyNow.textContent = s.player.energy;
      this.el.energyMax.textContent = s.player.maxEnergy;
      this.el.energy.classList.toggle('empty', s.player.energy <= 0);
      this.el.energy.classList.toggle('gain', s.player.energy > s.player.maxEnergy); // 熵流过载时 >3
    }
    // 第三批 P0-7：玩家的格挡必须可见 —— 否则「这一下挡还是打」全靠心算。
    // 能量至少有「打出牌后数字变化」的间接反馈，格挡连间接反馈都没有（只在获取瞬间闪一下盾）。
    if (this.el.block) {
      if (this._prevBlock >= 0 && this._prevBlock !== s.player.block) this._bump(this.el.block);
      this._prevBlock = s.player.block;
      this.el.blockNow.textContent = s.player.block;
      this.el.block.classList.toggle('on', s.player.block > 0);
    }

    const any = s.hand.some((i) => combat.canPlay(i));
    this.el.btnEndTurn.classList.toggle('ready', !any);
    this.el.btnEndTurn.disabled = this.busy;

    this.el.handTrack.onclick = (ev) => {
      const card = ev.target.closest('.card');
      if (!card) return;
      const uid = Number(card.dataset.uid);
      // 阶段 5 / T4：同一张牌 260ms 内的重复点击按双击去抖（不影响不同牌、不影响 act.* 探针路径）。
      const now = performance.now();
      if (this._lastCardTap.uid === uid && now - this._lastCardTap.t < 260) return;
      this._lastCardTap = { uid, t: now };
      this._tutDismissed = true; // 机制批 P1-5：打出第一张牌后撤掉新手提示
      this.h.onPlayCard(uid);
    };
    const onEnd = () => {
      const now = performance.now();
      if (now - this._lastEndTap < 260) return; // 结束回合双击去抖
      this._lastEndTap = now;
      this._tutDismissed = true; // 机制批 P1-5：结束回合也撤掉新手提示
      this.h.onEndTurn();
    };
    this.el.btnEndTurn.onclick = onEnd;
    this.el.pileDiscard.onclick = onEnd;
    this.startPoisonMist(combat);
  }

  statusFlags(st, who) {
    const map = who === 'self' ? ['str', 'dex', 'vuln', 'weak', 'poison'] : ['str', 'vuln', 'weak', 'poison'];
    return map
      .filter((k) => st[k] > 0)
      .map((k) => {
        const cls = k === 'str' || k === 'dex' ? 'buff' : k === 'vuln' || k === 'weak' || k === 'poison' ? 'debuff' : '';
        return `<span class="flag ${cls}">${STATUS_TEXT[k]} ${st[k]}</span>`;
      })
      .join('');
  }

  renderLog(combat) {
    const lines = combat.state.log.slice(Math.max(0, combat.state.log.length - 40));
    this.el.logZone.innerHTML = lines
      .map((l) => {
        switch (l.t) {
          case 'dmg': {
            const to = l.from === 'self' ? '敌人' : '你';
            const extra = l.absorbed > 0 ? `（格挡吸收 ${l.absorbed}）` : '';
            return `<div><span class="lg-dmg">${to}受到 ${l.value} 点伤害</span>${extra}</div>`;
          }
          case 'pure':
            return `<div><span class="lg-dmg">${l.from === 'self' ? '你' : '敌人'}受到 ${l.value} 点无视格挡的伤害</span></div>`;
          case 'block':
            return `<div><span class="lg-blk">获得 ${l.value} 点格挡</span></div>`;
          case 'energy':
            return `<div><span class="lg-buf">获得 ${l.value} 点能量</span></div>`;
          case 'heal':
            return `<div><span class="lg-buf">回复 ${l.value} 点生命</span></div>`;
          case 'status':
            return `<div><span class="lg-buf">${l.who === 'self' ? '你' : '敌人'}获得 ${l.value} 层${STATUS_TEXT[l.status] || l.status}</span></div>`;
          case 'poison':
            return `<div><span class="lg-dmg">${l.who === 'self' ? '你' : '敌人'}因中毒失去 ${l.value} 点生命</span></div>`;
          default:
            return `<div>${l.text || ''}</div>`;
        }
      })
      .join('');
    this.el.logZone.scrollTop = this.el.logZone.scrollHeight;
  }

  renderHand(combat) {
    if (!this.busy) this.handScroll = this.el.handZone.scrollLeft;
    const s = combat.state;
    // 机制批 P0-3：这一世开局带在牌组里的那张牌，战斗里认得出
    const carried = combat.run && combat.run.meta ? combat.run.meta.carried : null;
    this.el.handTrack.innerHTML = s.hand
      .map((inst) => {
        const d = CARD_MAP[inst.cid];
        const ok = combat.canPlay(inst);
        const arch = ARCHETYPE_MAP[d.a];
        const cls = ['card', d.a === 'basic' ? 'a-basic' : 'a-' + d.a];
        if (!ok) cls.push('unplayable');
        return `<div class="${cls.join(' ')}" data-uid="${inst.uid}">
          <div class="card-cost">${d.cost}</div>
          ${inst.cid === carried ? '<div class="card-carry">本世</div>' : ''}
          <div class="card-name">${d.n}</div>
          <div class="card-type">${typeText(d.t)}${arch ? ' · ' + arch.name : ''}</div>
          <div class="card-text">${shortCardText(d)}</div>
          ${d.ex ? '<div class="card-ex">消耗</div>' : ''}
          <div class="card-rarity">${rarityText(d.r)}</div>
        </div>`;
      })
      .join('');
    requestAnimationFrame(() => {
      this.el.handZone.scrollLeft = this.handScroll;
    });
    // 机制批 P0-8：窄屏只完整显示 5 张，必须告诉玩家「右边还有」
    const more = Math.max(0, s.hand.length - 5);
    document.getElementById('hand-more')?.remove();
    if (more > 0) {
      const tag = document.createElement('div');
      tag.id = 'hand-more';
      tag.className = 'hand-more';
      tag.textContent = `+${more}`;
      this.el.handZone.appendChild(tag);
    }
  }

  renderPiles(combat) {
    const s = combat.state;
    this.el.pileDraw.textContent = s.draw.length;
    this.el.pileDiscard.textContent = s.discard.length;
  }

  /** 第四批 P1-1：整屏轻震（≤260ms）。reduce 下由 CSS 兜底归零，这里再挡一次避免无谓的类操作。 */
  shakeStage() {
    const st = this.el.stage;
    if (!st || this.fx.reduced) return;
    st.classList.remove('shake');
    void st.offsetWidth;
    st.classList.add('shake');
    clearTimeout(this._shakeTimer);
    this._shakeTimer = setTimeout(() => st.classList.remove('shake'), 280);
  }

  /** 把战斗日志的新增部分翻译成画面特效（阶段 5 / T1+T2：四类动作 + 飘字分级） */
  playFxC(combat, from) {
    const entries = combat.state.log.slice(from);
    const enemyPos = () => this.enemyPos();
    // 本批次内玩家打向敌人的总伤害（用于「多段合计」判大伤害）。
    let batchDmgToEnemy = 0;
    for (const l of entries) if (l.t === 'dmg' && l.from === 'self') batchDmgToEnemy += l.value;
    for (const l of entries) {
      if (l.t === 'dmg') {
        if (l.from === 'self') {
          const p = enemyPos();
          const big = l.value >= 12 || batchDmgToEnemy >= 12; // 大伤害：单次 ≥12 或多段合计
          this.fx.float(p.x, p.y - 26, '-' + l.value, '#e8e3da', big ? 34 : 24, big);
          if (l.absorbed > 0) this.fx.ring(p.x, p.y, '#5b93d6');
          this.fx.burst(p.x, p.y, '#d1544a', 14);
          this.fx.slash(p.x, p.y, '#d1544a');
          const card = $('enemy-card');
          if (card) {
            card.classList.add('hit');
            setTimeout(() => card.classList.remove('hit'), 320);
          }
          this.playerPose('strike', 220); // 玩家前扑
          this.sfx.play('hit');
          // 第四批 P1-1：大伤害给整屏一下"重量"（单次 ≥12 或单批合计 ≥12）
          if (big) this.shakeStage();
        } else {
          const p = this.playerAnchor;
          this.fx.float(p.x, p.y, '-' + l.value, '#e24b4a', 24);
          if (l.absorbed > 0) {
            this.fx.ring(p.x, p.y + 10, '#5b93d6');
            // T2：格挡吸收单独飘字「挡 N」，蓝，与伤害飘字错开位置。
            this.fx.float(p.x + 28, p.y - 16, '挡 ' + l.absorbed, '#5b93d6', 18);
            this.sfx.play('block');
          } else {
            this.playerPose('hurt', 200); // 实际掉血才轻微后仰；被格挡挡下时玩家不晃
            this.sfx.play('hurt');
          }
          // 第四批 P1-1：敌人出手时本体前扑一下 —— 否则玩家只是"莫名掉血"。
          const mine = $('enemy-card');
          if (mine) {
            mine.classList.remove('is-strike');
            void mine.offsetWidth;
            mine.classList.add('is-strike');
            setTimeout(() => mine.classList.remove('is-strike'), 260);
          }
        }
      } else if (l.t === 'block') {
        const p = this.playerAnchor;
        if (l.who === 'self') {
          this.fx.ring(p.x, p.y + 20, '#5b93d6');
          this.playerPose('block', 380); // 出盾姿势
          this.sfx.play('block');
        }
      } else if (l.t === 'energy') {
        // T1：补上缺失的获能分支 —— 紫/金充能闪光 + 飘字「+N 能量」。
        const p = this.playerAnchor;
        this.fx.ring(p.x, p.y + 8, '#a89ae6');
        this.fx.float(p.x, p.y - 6, '+' + l.value + ' 能量', '#d9a94a', 20);
      } else if (l.t === 'pure') {
        const p = l.from === 'self' ? this.playerAnchor : enemyPos();
        const big = l.value >= 12;
        this.fx.float(p.x, p.y, '-' + l.value, '#7ba64a', big ? 30 : 22, big);
      } else if (l.t === 'heal' && l.value > 0) {
        const p = this.playerAnchor;
        this.fx.float(p.x, p.y, '+' + l.value, '#7ba64a', 22);
        this.sfx.play('heal');
      } else if (l.t === 'poison') {
        const p = l.who === 'self' ? this.playerAnchor : enemyPos();
        this.fx.float(p.x, p.y, '毒 ' + l.value, '#7ba64a', 20);
      }
    }
  }

  // ---------- 奖励 ----------

  renderReward(run) {
    this.show('reward');
    this.renderHud(run);
    $('reward-title').textContent =
      run.currentNode && run.currentNode.type === 'elite' ? '精英的遗物与牌' : '选择一张牌';
    this.el.rewardBody.innerHTML =
      `<div class="card-row reward">${run.rewardCards.map((c) => this.cardHtml(c)).join('')}</div>
       <div class="reward-note">点击取走一张，或跳过</div>
       <div style="display:flex;gap:12px;justify-content:center;margin-top:16px">
         <button id="btn-reroll"${run.rerollUsed ? ' disabled' : ''}>重抽（本局 1 次）</button>
         <button id="btn-skip">跳过</button>
       </div>`;
    for (const el of this.el.rewardBody.querySelectorAll('.card')) {
      el.onclick = () => this.h.onReward(el.dataset.cid);
    }
    $('btn-reroll').onclick = () => { this.h.onReroll(); };
    $('btn-skip').onclick = () => this.h.onReward(null);
  }

  cardHtml(c) {
    const arch = ARCHETYPE_MAP[c.a];
    return `<div class="card a-${c.a}" data-cid="${c.id}">
      <div class="card-cost">${c.cost}</div>
      <div class="card-name">${c.n}</div>
      <div class="card-type">${typeText(c.t)}${arch ? ' · ' + arch.name : ''}</div>
      <div class="card-text">${describeCard(c)}</div>
      ${c.ex ? '<div class="card-ex">消耗</div>' : ''}
      <div class="card-rarity">${rarityText(c.r)}</div>
    </div>`;
  }

  // ---------- 事件 / 灯下 ----------

  renderEvent(run) {
    this.show('event');
    this.renderHud(run);
    const ev = run.event;
    this.el.eventTitle.textContent = ev.n;
    this.el.eventBody.innerHTML =
      `<div class="event-text">${ev.text}</div>
       <div class="event-choices">${ev.choices
         .map((c, i) => `<button data-i="${i}">${c.label}<i>${c.note || ''}</i></button>`)
         .join('')}</div>`;
    for (const b of this.el.eventBody.querySelectorAll('button')) {
      b.onclick = () => this.h.onEvent(Number(b.dataset.i));
    }
  }

  renderRest(run) {
    this.show('rest');
    this.renderHud(run);
    // 提示层（阶段 3 / G3）：满血或接近满血时，把「这次回血会浪费多少」显式写出来。
    // 只读 Run.restHealPreview()，不改任何结算数值（结算仍在 Run.resolveRest('heal') 里）。
    const { heal, overflow } = run.restHealPreview();
    const healLabel =
      `回复 ${heal} 点生命（${Math.round(CONST.REST_HEAL_RATIO * 100)}% 上限）` +
      (overflow > 0 ? `<b class="rest-warn">将浪费 ${overflow} 点治疗量</b>` : '');
    this.el.restBody.innerHTML =
      `<div class="event-text">灯还亮着。你可以把手放在上面，也可以从怀里抽出那张多余的牌，烧掉。</div>
       <div class="event-choices">
         <button data-k="heal">烤火<i>${healLabel}</i></button>
         <button data-k="remove">烧掉一张牌<i>从牌组中永久移除一张牌</i></button>
       </div>`;
    for (const b of this.el.restBody.querySelectorAll('button')) {
      b.onclick = () => this.h.onRest(b.dataset.k);
    }
  }

  renderRemove(run) {
    this.show('rest');   // 复用 #screen-rest：删牌本来就发生在灯下/遗迹，视觉上也是同一块地方
    this.renderHud(run);
    this.el.restBody.innerHTML =
      `<div class="event-text">选择要移除的一张牌。</div>
       <div class="card-row reward">${run.deck
         .map((inst) => {
           const d = CARD_MAP[inst.cid];
           return `<div class="card a-${d.a}" data-uid="${inst.uid}">
             <div class="card-cost">${d.cost}</div>
             <div class="card-name">${d.n}</div>
             <div class="card-type">${typeText(d.t)}</div>
             <div class="card-text">${describeCard(d)}</div>
           </div>`;
         })
         .join('')}</div>`;
    for (const el of this.el.restBody.querySelectorAll('.card')) {
      el.onclick = () => this.h.onRemove(Number(el.dataset.uid));
    }
  }

  // ---------- 牌谱 ----------

  renderCodex(meta) {
    this.show('meta');
    this.renderHud(null);
    this.el.metaTitle.textContent = '牌谱 · 只有带回来的牌才会出现在这里';
    const owned = new Set(meta.unlockedCards);
    // 套装总览：牌谱页是玩家「离线研究构筑」的地方，必须能在这里看到 2/3 件效果，
    // 而不是等集齐了才在战斗里靠 toast 猜。成员列表按 RELICS 的 set 字段现查，不另维护一份。
    const setBlocks = SET_DEFS.map((s) => {
      const members = RELICS.filter((r) => r.set === s.id);
      const got = members.filter((r) => meta.unlockedRelics.includes(r.id)).length;
      const flags = members
        .map((r) =>
          meta.unlockedRelics.includes(r.id)
            ? `<span class="flag buff" data-relic="${r.id}">${r.n}</span>`
            : `<span class="flag" style="opacity:.4">${r.n} · 未解封</span>`
        )
        .join('');
      return `<div class="codex-set">
        <div class="cs-head"><b>${s.name}</b><span>${got}/${members.length} 件已解封</span></div>
        <div class="cs-desc">${s.desc}</div>
        <div class="cs-effect"><b>2 件</b>：${s.two.text}</div>
        <div class="cs-effect"><b>3 件</b>：${s.three.text}</div>
        <div class="cs-members">${flags}</div>
      </div>`;
    }).join('');
    this.el.metaBody.innerHTML = ARCHETYPES.map((a) => {
      const list = POOL_CARDS.filter((c) => c.a === a.id);
      const got = list.filter((c) => owned.has(c.id)).length;
      return `<div style="margin-bottom:20px">
        <div style="font-size:13px;color:var(--${a.color});margin-bottom:8px">${a.name} · ${got}/${list.length}
          <span style="color:var(--paper-dim);font-size:11px">${a.winLine}</span></div>
        <div class="card-row">${list
          .map((c) => (owned.has(c.id) ? this.cardHtml(c) : `<div class="card locked a-basic"><div class="card-name">已封印</div><div class="card-type">${rarityText(c.r)}</div><div style="margin-top:auto;font-size:11px;color:var(--paper-dim)">带回它</div></div>`))
          .join('')}</div>
      </div>`;
    }).join('') +
      `<div style="margin-bottom:20px">
        <div style="font-size:13px;color:var(--gold);margin-bottom:8px">遗物套装</div>
        <div class="codex-sets">${setBlocks}</div>
        <div style="font-size:13px;color:var(--gold);margin-bottom:8px">遗物 · ${meta.unlockedRelics.length}/${RELICS.length}
          <span style="color:var(--paper-dim);font-size:11px">（套件以 · 套装名 标注；散件不给套装，是刻意的）</span></div>
        <div style="display:flex;flex-wrap:wrap;gap:8px">${RELICS.map((r) => {
          const setName = r.set && SET_BY_ID[r.set] ? ` · ${SET_BY_ID[r.set].name}` : '';
          return meta.unlockedRelics.includes(r.id)
            // 第三批 P0-3：牌谱里的遗物必须能点开看效果 —— describeRelic 已在 HUD 用了，这里只是补上
            ? `<span class="flag buff" data-relic="${r.id}" style="padding:5px 9px;font-size:11px;cursor:pointer">${r.n}${setName}</span>`
            : `<span class="flag" style="padding:5px 9px;font-size:11px;opacity:.4">已封印</span>`;
        }).join('')}</div></div>
        <div style="display:flex;justify-content:center"><button id="btn-codex-back">返回</button></div>`;
    for (const el of this.el.metaBody.querySelectorAll('[data-relic]')) {
      el.onclick = () => {
        const r = RELICS.find((x) => x.id === el.dataset.relic);
        if (!r) return;
        const def = r.set ? SET_BY_ID[r.set] : null;
        const setLine = def ? `；【${def.name}】2 件：${def.two.text} 3 件：${def.three.text}` : '';
        this.toast(`${r.n}：${describeRelic(r).replace(/<br>/g, '；').replace(/<\/?b>/g, '')}${setLine}`, 3600);
      };
    }
    $('btn-codex-back').onclick = () => this.h.onBack();
  }

  // ---------- 结算 ----------

  renderOver(run) {
    this.show('over');
    this.renderHud(run);
    this._overRun = run;
    const s = run.summary();
    const cleared = s.outcome === 'cleared';
    this.el.overTitle.textContent = cleared ? '你把第九层的灯带走了' : '这一世，到此为止';
    // 机制批 P1-1：死因行 —— 告诉玩家死在哪、打到第几回合
    const lb = s.lastBattle;
    const foe = lb && lb.enemyId ? ENEMY_MAP[lb.enemyId] : null;
    this.el.overSub.innerHTML =
      `种子 ${s.seed}<br>` +
      `走过 ${s.cleared} / ${s.total} 个节点 · 剩余生命 ${s.hp}/${s.maxHp}<br>` +
      (cleared ? '' : (foe ? `最后一场：${foe.n} · 打到第 ${lb.turns} 回合<br>` : '你在路上倒下了<br>')) +
      `牌组 ${s.deckSize} 张 · 遗物 ${s.relics} 件 · 用时 ${s.minutes} 分钟<br><br>` +
      // 内容批 P1-11：碑文。wins 在 finish() 里已 +1，所以第一次通关取第 0 条；
      // 死亡文案是全游戏最好的一句，不动它。
      (cleared
        ? EPITAPHS[(run.meta.wins - 1 + EPITAPHS.length) % EPITAPHS.length]
        : '你死在这里。但这一次不算白死。') +
      this.selfReportHtml();
    this.bindSelfReport();
    // 注意：「带回一张牌」在独立的一屏里完成，这一屏只负责收尾 —— 不要再依赖 pendingUnlock，
    // 它此时已经被消费掉了（这个 bug 是探针截图抓出来的）。
    const arch = ARCHETYPE_MAP[run.archetypeId];
    const btn = $('btn-over-next');
    btn.textContent = `再来一世 · ${arch ? arch.name : ''}`;
    btn.onclick = () => this.h.onAgain(run.archetypeId);
    $('btn-over-home').onclick = () => this.h.onContinue();
  }

  // ---------- 试玩自报（阶段 4 / T2）----------
  //
  // 口径：这些控件**只在埋点开启时**（?log=1 或 localStorage）才渲染，普通玩家永远看不到，
  //      也就不存在"影响普通游玩"的可能。它们不改任何游戏状态 ——
  //      只调用 logger 的 amendLastLog 往那条已存在的记录里补两个手填字段。
  // 为什么这两项要手填：难度感受与"是否押注了载体"都无法从日志自动推断
  //      （押注是玩家脑内的意图，牌组里有 keyCard 不等于这局是靠它赢的）。

  selfReportHtml() {
    if (!resolveLogEnv().on) return '';
    const rec = lastLog();
    const sd = rec ? rec.selfDifficulty : null;
    const push = rec ? rec.didPush : null;
    const player = resolveLogEnv().player;
    return `<div class="self-report">
      <div class="sr-title">试玩自报 · 埋点已开${player ? ` · player=<b>${player}</b>` : ' · <b>player 未设置</b>（?player=你的名字）'}</div>
      <div class="sr-label">这一局你觉得多难？（1 = 很轻松，5 = 几乎没机会）</div>
      <div class="sr-row">${[1, 2, 3, 4, 5]
        .map((n) => `<button class="sr-btn${sd === n ? ' on' : ''}" data-sd="${n}">${n}</button>`)
        .join('')}</div>
      <div class="sr-label">这局你押注了载体吗？（是否围绕增幅/载体做过取舍）</div>
      <div class="sr-row">
        <button class="sr-btn${push === true ? ' on' : ''}" data-push="1">押注了</button>
        <button class="sr-btn${push === false ? ' on' : ''}" data-push="0">没有</button>
      </div>
      <div class="sr-hint">填完即写入本局那条 JSONL 记录（不会多产生一行）。回收方式见 docs/06。</div>
    </div>`;
  }

  bindSelfReport() {
    if (!resolveLogEnv().on) return;
    const root = this.el.overSub;
    for (const b of root.querySelectorAll('[data-sd]')) {
      b.onclick = () => {
        amendLastLog({ selfDifficulty: Number(b.dataset.sd) });
        if (this._overRun) this.renderOver(this._overRun);
      };
    }
    for (const b of root.querySelectorAll('[data-push]')) {
      b.onclick = () => {
        amendLastLog({ didPush: b.dataset.push === '1' });
        if (this._overRun) this.renderOver(this._overRun);
      };
    }
  }

  /**
   * 「带回一张牌」。两种模式（第三批 P0-2）：
   *  ① 还有封印牌 → 从封印池三选一解锁（旧行为，一字未改）
   *  ② 卡池已全解锁 → 从**本世牌组**里挑 3 张带走。
   *     口径：第 24 世起 sealedCards 为空，旧实现会直接落到 OVER —— 仪式断供，
   *     「一世一牌」在第 24 世消失。所以这里必须给一条兜底路径。
   */
  renderUnlock(run) {
    this.show('meta');
    this.renderHud(run);
    const u = run.pendingUnlock || { cards: [], relics: [] };
    const carry = run.pendingCarry;
    const isCarry = !!(carry && carry.length);
    const cards = isCarry ? carry : u.cards;
    this.el.metaTitle.textContent = isCarry ? '带走这一世的一张牌' : '带回来的那一张';
    this.el.metaBody.innerHTML =
      `<div class="reward-note" style="margin:0 0 16px">${
        isCarry
          ? '牌谱已经满了。<br>这一次，你可以从这一世打过的牌里带走一张。'
          : '每一世，你只带回一张牌。<br>它会躺进你下一世的起手牌组。'
      }</div>
       <div class="card-row reward">${cards
         .map((c) => this.cardHtml(c))
         .join('')}</div>
       ${u.relics.length ? `<div class="reward-note">同时解封遗物：<span style="color:var(--gold)">${u.relics[0].n}</span></div>` : ''}`;
    for (const el of this.el.metaBody.querySelectorAll('.card')) {
      el.onclick = () => this.h.onUnlock(el.dataset.cid);
    }
  }

  /** 只读牌组视图（机制批 P0-1）。绝不绑 onclick —— 看牌不能改牌。 */
  renderDeckView(run) {
    this.show('meta');
    this.renderHud(run);
    this.el.metaTitle.textContent = `牌组 · ${run.deck.length} 张`;
    this.el.metaBody.innerHTML =
      `<div class="card-row">${run.deck.map((inst) => this.cardHtml(CARD_MAP[inst.cid])).join('')}</div>
       <div style="display:flex;justify-content:center;margin-top:16px"><button id="btn-deck-back">返回</button></div>`;
    $('btn-deck-back').onclick = () => this.h.onResume();
  }
}
