// 表现层（DOM 渲染 + 交互）
// 口径：UI 不持有任何局内状态，只读 Run / Combat 并回调。
//      这样「无头模拟」与「真人游玩」跑的是同一套规则代码。

import { CONST, STATUS_TEXT } from '../config/constants.js';
import { ARCHETYPES, ARCHETYPE_MAP } from '../config/archetypes.js';
import { CARD_MAP, POOL_CARDS } from '../config/cards.js';
import { RELICS } from '../config/relics.js';
import { describeCard, describeRelic, typeText, rarityText } from './describe.js';
import { glyphSvg } from './glyph.js';
import { intentView } from './enemy.js';
import { PHASE } from './run.js';
import { NODE_META } from './mapgen.js';
import { Fx } from './fx.js';
import { resolveLogEnv, lastLog, amendLastLog } from './logger.js';

const $ = (id) => document.getElementById(id);

export class Ui {
  constructor(h) {
    this.h = h;
    this.el = {
      hudHpFill: $('hud-hp-fill'),
      hudHpText: $('hud-hp-text'),
      hudProgress: $('hud-progress'),
      hudSeed: $('hud-seed'),
      hudRelics: $('hud-relics'),
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
    if (ec) ec.classList.remove('hit');
    if (this.el.playerFigure) this.el.playerFigure.classList.remove('is-strike', 'is-block', 'is-hurt');
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
    this.el.hudRelics.innerHTML = run.relicIds
      .map((id) => {
        const r = RELICS.find((x) => x.id === id);
        return r ? `<span class="relic-chip" title="${r.n}">${r.n.slice(0, 1)}</span>` : '';
      })
      .join('');
  }

  // ---------- 标题页 ----------

  renderTitle(meta) {
    this.show('title');
    const actions = document.querySelector('#screen-title .title-actions');
    actions.innerHTML = '<button id="btn-new-run" class="big">开始一世</button><button id="btn-codex">牌谱</button>';
    $('btn-new-run').onclick = () => this.showArchetypePicker();
    $('btn-codex').onclick = () => this.renderCodex(meta);
    const done = POOL_CARDS.length - meta.unlockedCards.length;
    $('title-stats').innerHTML =
      `已归来 ${meta.runs} 世 · 抵达第九层 ${meta.wins} 次<br>` +
      `牌谱 ${meta.unlockedCards.length} / ${POOL_CARDS.length} · 遗物 ${meta.unlockedRelics.length} / ${RELICS.length}` +
      (done > 0 ? `<br>还有 <b>${done}</b> 张牌没被你带回来` : '<br>你把所有的牌都带回来了。');
    this.renderHud(null);
  }

  showArchetypePicker() {
    const actions = document.querySelector('#screen-title .title-actions');
    actions.innerHTML =
      `<div style="font-size:12px;color:var(--paper-dim);margin-bottom:2px">选择你这一世的身体</div>` +
      ARCHETYPES.map(
        (a) => `<button class="big" data-arch="${a.id}" style="text-align:left;letter-spacing:0">
          <span style="color:var(--${a.color})">${a.name}</span> · ${a.tag}
          <i style="display:block;font-style:normal;font-size:11px;color:var(--paper-dim);margin-top:3px">${a.winLine}</i>
        </button>`
      ).join('') +
      '<button id="btn-arch-back">返回</button>';
    for (const b of actions.querySelectorAll('[data-arch]')) {
      b.onclick = () => this.h.onStartRun(b.dataset.arch);
    }
    $('btn-arch-back').onclick = () => this.renderTitle(this.h.getMeta());
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
    $('screen-map').onclick = () => this.h.onAdvance();
  }

  // ---------- 战斗 ----------

  renderCombat(run, combat) {
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
        <div class="enemy-sub">${e.sub || ''}</div>
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
        </div>
      </div>`;

    this.renderLog(combat);
    this.renderHand(combat);
    this.renderPiles(combat);

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
      this.h.onPlayCard(uid);
    };
    const onEnd = () => {
      const now = performance.now();
      if (now - this._lastEndTap < 260) return; // 结束回合双击去抖
      this._lastEndTap = now;
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
    this.el.handTrack.innerHTML = s.hand
      .map((inst) => {
        const d = CARD_MAP[inst.cid];
        const ok = combat.canPlay(inst);
        const arch = ARCHETYPE_MAP[d.a];
        const cls = ['card', d.a === 'basic' ? 'a-basic' : 'a-' + d.a];
        if (!ok) cls.push('unplayable');
        return `<div class="${cls.join(' ')}" data-uid="${inst.uid}">
          <div class="card-cost">${d.cost}</div>
          <div class="card-name">${d.n}</div>
          <div class="card-type">${typeText(d.t)}${arch ? ' · ' + arch.name : ''}</div>
          <div class="card-text">${describeCard(d)}</div>
          <div class="card-rarity">${rarityText(d.r)}</div>
        </div>`;
      })
      .join('');
    requestAnimationFrame(() => {
      this.el.handZone.scrollLeft = this.handScroll;
    });
  }

  renderPiles(combat) {
    const s = combat.state;
    this.el.pileDraw.textContent = s.draw.length;
    this.el.pileDiscard.textContent = s.discard.length;
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
        } else {
          const p = this.playerAnchor;
          this.fx.float(p.x, p.y, '-' + l.value, '#e24b4a', 24);
          if (l.absorbed > 0) {
            this.fx.ring(p.x, p.y + 10, '#5b93d6');
            // T2：格挡吸收单独飘字「挡 N」，蓝，与伤害飘字错开位置。
            this.fx.float(p.x + 28, p.y - 16, '挡 ' + l.absorbed, '#5b93d6', 18);
          } else {
            this.playerPose('hurt', 200); // 实际掉血才轻微后仰；被格挡挡下时玩家不晃
          }
        }
      } else if (l.t === 'block') {
        const p = this.playerAnchor;
        if (l.who === 'self') {
          this.fx.ring(p.x, p.y + 20, '#5b93d6');
          this.playerPose('block', 380); // 出盾姿势
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
       <div style="display:flex;justify-content:center;margin-top:16px"><button id="btn-skip">跳过</button></div>`;
    for (const el of this.el.rewardBody.querySelectorAll('.card')) {
      el.onclick = () => this.h.onReward(el.dataset.cid);
    }
    $('btn-skip').onclick = () => this.h.onReward(null);
  }

  cardHtml(c) {
    const arch = ARCHETYPE_MAP[c.a];
    return `<div class="card a-${c.a}" data-cid="${c.id}">
      <div class="card-cost">${c.cost}</div>
      <div class="card-name">${c.n}</div>
      <div class="card-type">${typeText(c.t)}${arch ? ' · ' + arch.name : ''}</div>
      <div class="card-text">${describeCard(c)}</div>
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
    this.show('remove');
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
      `<div style="margin-bottom:20px"><div style="font-size:13px;color:var(--gold);margin-bottom:8px">遗物 · ${meta.unlockedRelics.length}/${RELICS.length}</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px">${RELICS.map((r) =>
          meta.unlockedRelics.includes(r.id)
            ? `<span class="flag buff" style="padding:5px 9px;font-size:11px">${r.n}</span>`
            : `<span class="flag" style="padding:5px 9px;font-size:11px;opacity:.4">已封印</span>`
        ).join('')}</div></div>
        <div style="display:flex;justify-content:center"><button id="btn-codex-back">返回</button></div>`;
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
    this.el.overSub.innerHTML =
      `种子 ${s.seed}<br>` +
      `走过 ${s.cleared} / ${s.total} 个节点 · 剩余生命 ${s.hp}/${s.maxHp}<br>` +
      `牌组 ${s.deckSize} 张 · 遗物 ${s.relics} 件 · 用时 ${s.minutes} 分钟<br><br>` +
      (cleared ? '第九层没有尽头，只有更低的第九层。' : '你死在这里。但这一次不算白死。') +
      this.selfReportHtml();
    this.bindSelfReport();
    // 注意：「带回一张牌」在独立的一屏里完成，这一屏只负责收尾 —— 不要再依赖 pendingUnlock，
    // 它此时已经被消费掉了（这个 bug 是探针截图抓出来的）。
    const btn = $('btn-over-next');
    btn.textContent = '回到开头';
    btn.onclick = () => this.h.onContinue();
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

  renderUnlock(run) {
    this.show('meta');
    this.renderHud(run);
    const u = run.pendingUnlock;
    this.el.metaTitle.textContent = '带回来的那一张';
    this.el.metaBody.innerHTML =
      `<div class="reward-note" style="margin:0 0 16px">每一世，你只带回一张牌。<br>它从此会出现在后面每一局的路上。</div>
       <div class="card-row reward">${u.cards
         .map((c) => this.cardHtml(c))
         .join('')}</div>
       ${u.relics.length ? `<div class="reward-note">同时解封遗物：<span style="color:var(--gold)">${u.relics[0].n}</span></div>` : ''}`;
    for (const el of this.el.metaBody.querySelectorAll('.card')) {
      el.onclick = () => this.h.onUnlock(el.dataset.cid);
    }
  }
}
