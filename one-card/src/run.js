// 单局运行控制器（阶段机）
// 口径：这是「一局游戏」的唯一状态源。UI 只读它、只调它的方法，绝不自己维护局内状态。
// 这样无头模拟（tools/balance.mjs）可以直接驱动 Run，不需要浏览器。

import { CONST } from '../config/constants.js';
import { ENEMY_MAP } from '../config/enemies.js';
import { RELICS } from '../config/relics.js';
import { EVENT_MAP } from '../config/events.js';
import { starterDeck } from '../config/cards.js';
import { makeDeck, makeInstance, rollRewardCards, rollCardsByRarity, removeFromDeck } from './cards.js';
import { generateMap, nodeAt, nextNode, validateMap } from './mapgen.js';
import { loadMeta, grantCardUnlock, grantRelicUnlock, rollUnlockChoices } from './meta.js';
import { makeSeed, Rng } from './rng.js';
import { emitRunLog } from './logger.js';

export const PHASE = {
  MAP: 'map',
  COMBAT: 'combat',
  REWARD: 'reward',
  EVENT: 'event',
  REST: 'rest',
  REMOVE: 'remove',
  UNLOCK: 'unlock',
  OVER: 'over',
};

export class Run {
  constructor({ archetypeId, meta, seed }) {
    this.seedSource = seed;
    this.rng = new Rng(seed);
    this.seed = makeSeed(this.rng);
    this.archetypeId = archetypeId;
    this.meta = meta || loadMeta();

    this.hp = CONST.HP_PLAYER;
    this.maxHp = CONST.HP_PLAYER;
    this.deck = makeDeck(starterDeck(archetypeId));
    this.relicIds = [];
    this.map = generateMap(this.rng);
    this.mapCheck = validateMap(this.map);
    this.cursor = null;
    this.phase = PHASE.MAP;
    this.outcome = null;
    this.rewardCards = [];
    this.event = null;
    this.pendingRemove = null;
    this.pendingUnlock = null;
    this.history = [];
    this.startedAt = Date.now();
    // 观测字段（阶段 4 / T2）：记录玩家在灯下节点的选择，只被 src/logger.js 读取。
    // 骨架里灯下恰好 1 个（FLOOR_SKELETON），所以这是一个至多 1 元素的数组。
    // 它不参与任何分支判断、不参与 RNG —— 删掉它也不会改变任何一局的结果。
    this.restChoices = [];

    this.unlocked = new Set(this.meta.unlockedCards);

    // 开局 1 件遗物：口径见 docs/02「遗物来源明细」
    this.grantRelic(true);
  }

  get currentNode() {
    return this.cursor ? nodeAt(this.map, this.cursor) : null;
  }

  get floor() {
    const n = this.currentNode;
    return n ? n.floor : CONST.FLOORS;
  }

  get cleared() {
    return this.map.filter((n) => n.done).length;
  }

  /** 已解锁的卡牌池（决定奖励三选一里能出现什么） */
  get pool() {
    return new Set(this.meta.unlockedCards);
  }

  grantRelic(silent = false) {
    const held = new Set(this.relicIds);
    const avail = RELICS.filter((r) => this.meta.unlockedRelics.includes(r.id) && !held.has(r.id));
    if (!avail.length) return null;
    const pick = this.rng.pick(avail);
    this.relicIds.push(pick.id);
    if (!silent) this.history.push({ kind: 'relic', id: pick.id });
    return pick;
  }

  addCard(cid, silent = false) {
    this.deck.push(makeInstance(cid));
    if (!silent) this.history.push({ kind: 'card', id: cid });
    return cid;
  }

  // ---------- 流程推进 ----------

  /** 进入下一个节点。返回当前 phase。 */
  advance() {
    const n = nextNode(this.map);
    if (!n) {
      this.finish('cleared');
      return this.phase;
    }
    this.cursor = n.uid;
    n.done = true;

    switch (n.type) {
      case 'battle':
      case 'elite':
      case 'boss':
        this.phase = PHASE.COMBAT;
        break;
      case 'event':
        this.event = EVENT_MAP[n.eventId];
        this.phase = PHASE.EVENT;
        break;
      case 'rest':
        this.phase = PHASE.REST;
        break;
      default:
        this.phase = PHASE.MAP;
    }
    return this.phase;
  }

  combatEnemy() {
    const n = this.currentNode;
    if (!n || !n.enemyId) return null;
    return ENEMY_MAP[n.enemyId];
  }

  /** 战斗结算回调：由 UI 在战斗结束后调用 */
  resolveCombat(result) {
    const n = this.currentNode;
    if (!result.won) {
      this.finish('dead');
      return this.phase;
    }
    if (n.type === 'elite') this.grantRelic();

    if (n.type === 'boss') {
      this.pendingBoss = true;
    }
    this.rewardCards = rollRewardCards(this.rng, this.pool, CONST.REWARD_CHOICES);
    this.phase = PHASE.REWARD;
    return this.phase;
  }

  /**
   * 回到地图屏。
   * 口径：每个节点结算完都回到地图，而不是直接冲进下一个节点 ——
   *      地图是玩家的「信息 + 呼吸」节点：下一个是精英还是灯下，决定要不要现在就补血。
   *      这条如果省掉，12 个决策点会退化成 11 个「无信息的一路按下去」。
   */
  toMap() {
    this.phase = PHASE.MAP;
    return this.phase;
  }

  /** 取走奖励；cid 为 null 表示跳过 */
  takeReward(cid) {
    if (cid) this.addCard(cid);
    this.rewardCards = [];
    if (this.pendingBoss) {
      this.pendingBoss = false;
      this.finish('cleared');
      return this.phase;
    }
    return this.toMap();
  }

  resolveEvent(choiceIndex) {
    const ev = this.event;
    const choice = ev.choices[choiceIndex];
    const a = choice.apply || {};
    if (a.loseHp) this.hp = Math.max(1, this.hp - a.loseHp);
    if (a.heal) this.hp = Math.min(this.maxHp, this.hp + a.heal);
    if (a.maxHp) {
      this.maxHp += a.maxHp;
      this.hp += a.maxHp;
    }
    if (a.gainRelic) this.grantRelic();
    if (a.gainCard) {
      const n = a.count || 1;
      const list =
        a.gainCard === 'rare'
          ? rollCardsByRarity(this.rng, this.pool, 3, n)
          : rollRewardCards(this.rng, this.pool, n);
      for (const c of list) this.addCard(c.id, true);
      this.history.push({ kind: 'cardBatch', n: list.length });
    }
    this.event = null;
    if (a.removeCard) {
      this.pendingRemove = { then: 'map' };
      this.phase = PHASE.REMOVE;
      return this.phase;
    }
    return this.toMap();
  }

  /** kind: 'heal' | 'remove' */
  resolveRest(kind) {
    this.restChoices.push(kind === 'heal' ? 'heal' : 'remove');
    if (kind === 'heal') {
      this.hp = Math.min(this.maxHp, this.hp + Math.round(this.maxHp * CONST.REST_HEAL_RATIO));
      return this.toMap();
    }
    this.pendingRemove = { then: 'map' };
    this.phase = PHASE.REMOVE;
    return this.phase;
  }

  /**
   * 灯下回血预览（只读，仅用于 UI 提示，不参与结算）。
   * 口径（阶段 3 / G3）：
   *   治疗量 heal = round(maxHp × REST_HEAL_RATIO)
   *   溢出量 overflow = max(0, floor(hp + heal − maxHp))   ← 「将浪费 X 点治疗量」的 X
   * 注意：上限用 this.maxHp，**不是** CONST.HP_PLAYER —— 事件（ev.carving）能抬高上限，
   *      而 resolveRest('heal') 的结算用的就是 this.maxHp。提示必须与结算同源，
   *      否则满上限被抬高后提示会撒谎（详见 docs/05 §T3 的口径修正说明）。
   */
  restHealPreview() {
    const heal = Math.round(this.maxHp * CONST.REST_HEAL_RATIO);
    const overflow = Math.max(0, Math.floor(this.hp + heal - this.maxHp));
    return { heal, overflow };
  }

  completeRemove(uid) {
    if (uid != null) removeFromDeck(this.deck, uid);
    this.pendingRemove = null;
    // 口径：牌组不允许被清空，否则单局无法继续
    if (this.deck.length === 0) this.deck.push(makeInstance('base.strike'));
    return this.toMap();
  }

  /** 一局结束：结算元进度，进入「带回一张牌」 */
  finish(outcome) {
    this.outcome = outcome;
    this.meta.runs += 1;
    if (outcome === 'cleared') this.meta.wins += 1;
    this.meta.bestFloor = Math.max(this.meta.bestFloor, this.floor);
    const minutes = (Date.now() - this.startedAt) / 60000;
    this.meta.totalMinutes = Math.round((this.meta.totalMinutes + minutes) * 10) / 10;
    this.pendingUnlock = rollUnlockChoices(this.rng, this.meta, 3);
    // 口径：如果没有可解封的卡，直接进结算页 —— 否则会卡在一个空的三选一里
    this.phase = this.pendingUnlock.cards.length ? PHASE.UNLOCK : PHASE.OVER;
    // 埋点（阶段 4 / T2）：只读观测层。放这里是唯一正确的位置 ——
    // finish 是一局的唯一出口，此时 outcome / cleared / deck 都已定稿。
    // 这个函数内部自己判断开关，默认直接 return null（零副作用、零 RNG 消耗）。
    emitRunLog(this);
    return this.phase;
  }

  /** 带回一张牌（必须选一张，这就是核心幻想） */
  takeUnlock(cardId) {
    const c = this.pendingUnlock && this.pendingUnlock.cards.find((x) => x.id === cardId);
    if (c) grantCardUnlock(this.meta, c.id);
    const r = this.pendingUnlock && this.pendingUnlock.relics[0];
    if (r) grantRelicUnlock(this.meta, r.id);
    this.pendingUnlock = null;
    this.phase = PHASE.OVER;
    return this.phase;
  }

  summary() {
    return {
      seed: this.seed,
      outcome: this.outcome,
      hp: this.hp,
      maxHp: this.maxHp,
      cleared: this.cleared,
      total: this.map.length,
      deckSize: this.deck.length,
      relics: this.relicIds.length,
      minutes: Math.round(((Date.now() - this.startedAt) / 60000) * 10) / 10,
    };
  }
}
