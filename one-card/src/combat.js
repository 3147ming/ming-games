// 核心战斗循环（回合状态机）
// 这是全项目唯一「无法靠配置表规避的复杂度」，所以它必须小、必须可测。
// 口径：所有具体内容（哪张牌、哪个敌人、哪件遗物）都不出现在这个文件里。

import { CONST } from '../config/constants.js';
import { CARD_MAP } from '../config/cards.js';
import { RELIC_MAP } from '../config/relics.js';
import { makeStatuses, resolveOps, tickTurnStart, tickTurnEnd, computeDamage } from './effects.js';
import { drawCards, discardAllHand, def } from './cards.js';
import { makeEnemy, advanceIntent, runIntent } from './enemy.js';

export class Combat {
  constructor({ run, enemyDef, rng }) {
    this.rng = rng;
    this.run = run;
    this.relics = run.relicIds.map((id) => RELIC_MAP[id]).filter(Boolean);
    this.state = {
      player: {
        hp: run.hp,
        maxHp: run.maxHp,
        block: 0,
        energy: 0,
        maxEnergy: CONST.MAX_ENERGY,
        statuses: makeStatuses(),
      },
      enemy: makeEnemy(enemyDef, rng),
      hand: [],
      draw: rng.shuffled(run.deck.slice()),
      discard: [],
      exhaust: [],
      turn: 1,
      cardsPlayedThisTurn: 0,
      log: [],
      phase: 'player',
    };
  }

  get over() {
    return this.state.phase === 'won' || this.state.phase === 'lost';
  }

  get won() {
    return this.state.phase === 'won';
  }

  /**
   * 执行某件遗物的某个钩子。
   * 遗物钩子有两种形态（见 config/relics.js）：
   *   1) 纯 ops 数组：[{op:'block',value:5}, ...]        —— 条件触发以外的情况
   *   2) 条件触发器：[{cond:{cardType:'attack'}, ops:[...]}] —— cardPlayed 专用
   * 用 Array.isArray(trig.ops) 区分，不允许靠猜。
   */
  fire(hook, extra = {}) {
    for (const r of this.relics) {
      const list = r.hooks && r.hooks[hook];
      if (!list) continue;
      for (const trig of list) {
        if (Array.isArray(trig.ops)) {
          const c = trig.cond;
          if (c) {
            const ok =
              (c.cardType ? extra.cardType === c.cardType : true) &&
              (c.costZero ? extra.cost === 0 : true);
            if (!ok) continue;
          }
          resolveOps(this.state, trig.ops, { rng: this.rng });
        } else {
          resolveOps(this.state, [trig], { rng: this.rng });
        }
      }
    }
  }

  start() {
    this.state.log.push({ t: 'info', text: `${this.state.enemy.n} 挡在路口。` });
    this.fire('combatStart');
    if (this.checkOver()) return;
    this.startPlayerTurn();
  }

  startPlayerTurn() {
    const s = this.state;
    s.player.block = 0;
    s.player.energy = s.player.maxEnergy;
    s.cardsPlayedThisTurn = 0;
    tickTurnStart(s, 'self');
    if (this.checkOver()) return;
    this.fire('turnStart');
    drawCards(s, CONST.DRAW_PER_TURN, this.rng);
  }

  canPlay(inst) {
    const d = def(inst);
    return !!d && this.state.player.energy >= d.cost;
  }

  /** 打出手牌。返回 {ok, reason} */
  playCard(uid) {
    const s = this.state;
    if (s.phase !== 'player') return { ok: false, reason: 'phase' };
    const idx = s.hand.findIndex((c) => c.uid === uid);
    if (idx < 0) return { ok: false, reason: 'not-in-hand' };
    const inst = s.hand[idx];
    const d = CARD_MAP[inst.cid];
    if (s.player.energy < d.cost) return { ok: false, reason: 'energy' };

    s.player.energy -= d.cost;
    s.hand.splice(idx, 1);
    s.cardsPlayedThisTurn += 1;

    resolveOps(s, d.ops, { rng: this.rng });

    if (d.ex) s.exhaust.push(inst);
    else s.discard.push(inst);

    if (!this.over) this.fire('cardPlayed', { cardType: d.t, cost: d.cost });
    this.checkOver();
    return { ok: true };
  }

  endTurn() {
    const s = this.state;
    if (s.phase !== 'player') return;
    tickTurnEnd(s, 'self');
    discardAllHand(s);
    s.phase = 'enemy';
    this.enemyTurn();
    if (this.over) return;
    s.turn += 1;
    s.phase = 'player';
    this.startPlayerTurn();
  }

  enemyTurn() {
    const s = this.state;
    s.enemy.block = 0;
    tickTurnStart(s, 'enemy');
    if (this.checkOver()) return;
    runIntent(s, { rng: this.rng });
    if (this.checkOver()) return;
    tickTurnEnd(s, 'enemy');
    advanceIntent(s.enemy);
  }

  checkOver() {
    const s = this.state;
    if (s.enemy.hp <= 0) {
      s.phase = 'won';
      return true;
    }
    if (s.player.hp <= 0) {
      s.phase = 'lost';
      return true;
    }
    return false;
  }

  /**
   * 结算战斗，把结果写回 run。
   * 口径：手牌/抽牌堆/弃牌堆/消耗堆在战斗结束后全部归位到牌组 ——
   *      「消耗」只在本次战斗内生效（与《杀戮尖塔》一致），否则熵流会自我毁灭。
   */
  finish() {
    const s = this.state;
    this.run.deck = [...s.hand, ...s.draw, ...s.discard, ...s.exhaust];
    // 战斗结束钩子（如「血杯」回血）只有在胜利时生效
    if (this.won) this.fire('combatEnd');
    this.run.hp = Math.max(0, Math.min(s.player.hp, this.run.maxHp));
    return { won: this.won, hp: this.run.hp, turns: s.turn };
  }

  /** 供表现层使用：把日志里新增的部分取走 */
  drainLog(from) {
    const out = this.state.log.slice(from);
    return { lines: out, next: this.state.log.length };
  }
}

/**
 * 无头自动战斗（供平衡模拟器与单测使用）。
 * 策略口径：模拟一个「不懂构筑、但会看意图」的普通玩家 —— 这是玩家的下限，不是上限。
 *   - 预判到这一下会掉 >18% 最大生命 → 先上格挡
 *   - 能本回合击杀 → 优先打伤害
 *   - 否则按「伤害 ×1.0 + 格挡 ×0.7」贪心出牌（口径：格挡只在当回合有效，价值略低于伤害）
 */
export function autoResolve({ run, enemyDef, rng, policy }) {
  const c = new Combat({ run, enemyDef, rng });
  c.start();

  const dmgOf = (i) =>
    (CARD_MAP[i.cid].ops || []).reduce((a, o) => (o.op === 'damage' ? a + o.value * (o.times || 1) : a), 0);
  const blkOf = (i) => (CARD_MAP[i.cid].ops || []).reduce((a, o) => (o.op === 'block' ? a + o.value : a), 0);

  const defaultPolicy = (combat) => {
    const s = combat.state;
    const playable = s.hand.filter((i) => combat.canPlay(i));
    if (!playable.length) return null;

    const intent = s.enemy.intent;
    const incoming = intent && intent.t === 'attack' ? computeDamage(intent.value, s.enemy, s.player) : 0;
    const unblocked = Math.max(0, incoming - s.player.block);
    if (unblocked > s.player.maxHp * 0.18) {
      const blocker = playable.filter((i) => blkOf(i) > 0).sort((a, b) => blkOf(b) - blkOf(a))[0];
      if (blocker) return blocker;
    }

    const lethal = playable
      .filter((i) => dmgOf(i) >= s.enemy.hp + s.enemy.block)
      .sort((a, b) => dmgOf(b) - dmgOf(a))[0];
    if (lethal) return lethal;

    return playable.sort(
      (a, b) => dmgOf(b) * 1.0 + blkOf(b) * 0.7 - (dmgOf(a) * 1.0 + blkOf(a) * 0.7)
    )[0];
  };

  const pick = policy || defaultPolicy;
  let guard = 0;
  while (!c.over && guard++ < 300) {
    let acted = true;
    while (acted && !c.over) {
      const target = pick(c);
      if (!target) acted = false;
      else c.playCard(target.uid);
    }
    if (!c.over) c.endTurn();
  }
  return c.finish();
}
