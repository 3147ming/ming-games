// 单局运行控制器（阶段机）
// 口径：这是「一局游戏」的唯一状态源。UI 只读它、只调它的方法，绝不自己维护局内状态。
// 这样无头模拟（tools/balance.mjs）可以直接驱动 Run，不需要浏览器。

import { CONST } from '../config/constants.js';
import { ENEMY_MAP } from '../config/enemies.js';
import { RELICS } from '../config/relics.js';
import { EVENT_MAP } from '../config/events.js';
import { ARCHETYPE_MAP } from '../config/archetypes.js';
import { starterDeck, CARD_MAP, POOL_CARDS } from '../config/cards.js';
import { makeDeck, makeInstance, rollRewardCards, rollCardsByRarity, removeFromDeck, ensureUidAbove } from './cards.js';
import { generateMap, nodeAt, nextNode, validateMap } from './mapgen.js';
import { loadMeta, saveMeta, grantCardUnlock, grantRelicUnlock, rollUnlockChoices } from './meta.js';
import { load, save, clear } from './storage.js';
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

/** 内容批 P1-7：本地日期字符串 YYYY-MM-DD，用于 daily 记录的跨天判定 */
export function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 内容批 P1-7：今日之牌。
 * 口径：**日期同时决定流派和种子** —— 流派固定是为了防「换个流派重开刷成绩」，
 *      种子固定是让所有人（以及明天的自己）面对同一张地图、同一批敌人。
 */
const DAILY_ARCHS = ['blade', 'frost', 'rot', 'flux'];
export function dailyInfo(d = new Date()) {
  const dayOfYear = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
  const date = todayKey(d);
  return { date, arch: DAILY_ARCHS[dayOfYear % DAILY_ARCHS.length], seed: `daily-${date}` };
}

export class Run {
  constructor({ archetypeId, meta, seed, originId = null, daily = null, asc = null }) {
    this.seedSource = seed;
    this.rng = new Rng(seed);
    this.seed = makeSeed(this.rng);
    this.archetypeId = archetypeId;
    this.meta = meta || loadMeta();
    this.originId = originId;
    this.daily = daily;
    this._ascOverride = asc != null ? asc : null;   // 内容批 P1-6：?asc= 调试覆盖，不写回 meta
    // 第三批 P1-8：同一场战斗被「重进」的次数。战斗中刷新续局会重打这一场，
    //      但每次要付续命税 —— 否则「退出即回血」把赌注抹平，卡关时刷新重打就是最优解。
    this.battleTries = {};
    this.lastToll = 0;

    this.hp = CONST.HP_PLAYER;
    this.maxHp = CONST.HP_PLAYER;
    this.deck = makeDeck(starterDeck(archetypeId, originId));
    // 第三批 P1-11：每日局必须「同一天 + 同一个 seed = 同一局」，否则分享出去对不上答案。
    //      牌池 / 本世牌 / 遗物池 / 难度 / Boss 轮换这五样原本各自跟着个人存档走，全部要标准化。
    const dailyMode = !!daily;
    this.poolOverride = dailyMode ? new Set(POOL_CARDS.map((c) => c.id)) : null;
    this.relicPoolOverride = dailyMode ? new Set(RELICS.map((r) => r.id)) : null;
    // 机制批 P0-3：上一世带回的那张牌，这一世从第一回合就躺在牌组里 —— 这是「一世一牌」的机制化身。
    //      每日局不带：带着牌就又变成「起手按存档不同而不同」的局了。
    if (!dailyMode && this.meta.carried && CARD_MAP[this.meta.carried]) this.deck.push(makeInstance(this.meta.carried));
    this.relicIds = [];
    // 每日局的 Boss 轮换固定从「守灯人」起 —— meta.wins 是个人进度，拿它决定最终战就不叫每日局了。
    this.map = generateMap(this.rng, CONST.FLOORS, { wins: dailyMode ? 0 : this.meta.wins });
    this.mapCheck = validateMap(this.map);
    this.cursor = null;
    this.phase = PHASE.MAP;
    this.outcome = null;
    this.rewardCards = [];
    this.event = null;
    this.pendingRemove = null;
    this.pendingUnlock = null;
    this.pendingCarry = null;   // 卡池全解锁后的「带走一张」候选（P0-2）。有它就不用 pendingUnlock
    this.history = [];
    this.lastBattle = null;
    this.rerollUsed = false;
    // 第三批 P0-6：关键牌保底的两个观测状态。rewardIndex 是「本局第几次奖励」，
    // seenKey 是「本局已经出现在三选一里的关键牌」—— 保底只发 1 次，靠 seenKey 去重。
    this.seenKey = new Set();
    this.rewardIndex = 0;
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

  /** 已解锁的卡牌池（决定奖励三选一里能出现什么）。每日局返回全解锁池，见 P1-11。 */
  get pool() {
    return this.poolOverride || new Set(this.meta.unlockedCards);
  }

  /** 已解锁的遗物池。口径与 pool() 一致：每日局用全集，保证同一天同一个 seed 的起手遗物也相同。 */
  get relicPool() {
    return this.relicPoolOverride || new Set(this.meta.unlockedRelics);
  }

  grantRelic(silent = false) {
    const held = new Set(this.relicIds);
    const pool = this.relicPool;
    const avail = RELICS.filter((r) => pool.has(r.id) && !held.has(r.id));
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

  /** 进入下一个节点。preferUid 为机制批 P1-2 的「入口二选一」，takeAlt 为 true 时才走备选。
   *  口径：旧实现无条件 Object.assign(n, n.alt)，把每层入口的主节点整块换掉 ——
   *      第 2 层第 1 格的 wild 因此永远变成 battle，荒野关（arena.js）在真实运行里
   *      一次都进不去，一局的奖励节点也从 9 掉到 7。只有显式选择才应用 alt。 */
  advance(preferUid, takeAlt = false) {
    const n = preferUid ? this.map.find((x) => x.uid === preferUid && !x.done) : nextNode(this.map);
    if (!n) {
      this.finish('cleared');
      return this.phase;
    }
    if (takeAlt && n.alt) Object.assign(n, n.alt);
    delete n.alt;          // 走完就清掉：这一格只能走一次，备选不能留到下一层

    const isFight = n.type === 'battle' || n.type === 'elite' || n.type === 'boss';
    if (isFight) {
      // 第三批 P1-8：重进同一场战斗要付 10% 上限的续命税（下限 1 点，且不会直接扣死）。
      //      税只按 uid 计次 —— 打赢换下一格，uid 不同，t=0，不扣。
      const t = this.battleTries[n.uid] || 0;
      this.lastToll = 0;
      if (t > 0) {
        this.lastToll = Math.max(1, Math.round(this.maxHp * 0.1));
        this.hp = Math.max(1, this.hp - this.lastToll);
      }
      this.battleTries[n.uid] = t + 1;
      // 关键：快照必须在这里再落一次，且此时 n 还没标 done、cursor 还指在上一个节点。
      //   - 只在 toMap() 存 → 战斗中刷新拿到的是「进战斗前」的 battleTries（t=0），税永远收不上；
      //   - 若先标 done 再存 → 刷新回来这一格显示已完成，等于直接跳过这场战斗。
      save(CONST.RUN_KEY, this.snapshot());
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

  /** 敌人难度缩放（内容批 P1-6）。口径：只改血量与固定伤害，不改意图结构 —— 玩家仍然能「算账」，只是账更紧。
   *  绝不就地改 ENEMY_MAP 的对象，返回副本，否则同一局里下一次遇到同一敌人会叠加缩放。 */
  combatEnemy() {
    const n = this.currentNode;
    if (!n || !n.enemyId) return null;
    const base = ENEMY_MAP[n.enemyId];
    const a = this._ascOverride != null ? this._ascOverride : this.daily ? 0 : (this.meta.ascension || 0);
    if (!base || a <= 0) return base;
    const k = 1 + 0.12 * a;
    // 第三批 P1-12：普通敌人 +a，精英/Boss +2a ——
    //      最终战必须比杂兵更陡，否则后期只是「血多一点的杂兵」，阶梯形同虚设。
    const add = base.tier === 'normal' ? a : a * 2;
    return {
      ...base,
      hp: Math.round(base.hp * k),
      pattern: base.pattern.map((it) => (it.t === 'attack' ? { ...it, value: Math.round(it.value + add) } : it)),
      pattern2: base.pattern2 ? base.pattern2.map((it) => (it.t === 'attack' ? { ...it, value: Math.round(it.value + add) } : it)) : undefined,
    };
  }

  /** 战斗结算回调：由 UI 在战斗结束后调用 */
  resolveCombat(result) {
    const n = this.currentNode;
    // 机制批 P1-1：先记一笔，结算页才能告诉玩家「死在哪、打到第几回合」
    this.lastBattle = { enemyId: n.enemyId || null, turns: result.turns || 0, floor: n.floor, type: n.type };
    if (!result.won) {
      this.finish('dead');
      return this.phase;
    }
    if (n.type === 'elite') this.grantRelic();

    if (n.type === 'boss') {
      this.pendingBoss = true;
    }
    // 机制批 P0-4：本流派保底 + 第三批 P0-6：关键牌保底（整局至少给 1 次，不重复）
    this.rewardIndex += 1;
    this.rewardCards = this.rollRewards();
    this.phase = PHASE.REWARD;
    return this.phase;
  }

  /** 三选一抽卡。两个调用点（战后奖励 / 重抽）必须共用同一套口径，否则重抽能绕过保底。 */
  rollRewards() {
    const arch = ARCHETYPE_MAP[this.archetypeId];
    const cards = rollRewardCards(this.rng, this.pool, CONST.REWARD_CHOICES, {
      guaranteeArch: this.archetypeId,
      keyCards: arch ? arch.keyCards : [],
      seenKey: this.seenKey,
      rewardIndex: this.rewardIndex,
    });
    // 第三批 P0-6：这里**不**写 seenKey —— 「已见」应该在结算（takeReward）时记。
    // 若在滚动时就记，rerollRewards 会看到自己刚抽的关键牌，判定「已经见过」，
    // 于是重抽把保底牌洗掉，本局可能再也见不到任何关键牌。
    return cards;
  }

  /**
   * 回到地图屏。
   * 口径：每个节点结算完都回到地图，而不是直接冲进下一个节点 ——
   *      地图是玩家的「信息 + 呼吸」节点：下一个是精英还是灯下，决定要不要现在就补血。
   *      这条如果省掉，12 个决策点会退化成 11 个「无信息的一路按下去」。
   */
  toMap() {
    this.phase = PHASE.MAP;
    save(CONST.RUN_KEY, this.snapshot());   // 存档点之一：节点结算完毕（另一个在战斗入口，见 advance）
    return this.phase;
  }

  /** 局内快照（机制批 P0-6）。只存「节点边界」的状态：战斗打到一半不存，掉线最多重打这一场。 */
  snapshot() {
    return {
      v: 1,
      archetypeId: this.archetypeId,
      seedSource: this.seedSource,
      seed: this.seed,
      rngState: this.rng.state,
      hp: this.hp, maxHp: this.maxHp,
      deck: this.deck.map((c) => ({ uid: c.uid, cid: c.cid })),
      relicIds: this.relicIds.slice(),
      map: this.map,
      cursor: this.cursor,
      history: this.history,
      startedAt: this.startedAt,
      daily: this.daily || null,
      originId: this.originId || null,
      // 第三批 P1-8：续命税计次必须进快照，否则刷新等于把税单一起洗掉。
      battleTries: this.battleTries,
      // ?asc= 调试覆盖也要落盘 —— 否则 5 层难度中途刷新会退回 meta 的当前阶梯。
      ascOverride: this._ascOverride,
    };
  }

  /** 从快照恢复一局（机制批 P0-6）。构造过程会重新生成 map 并白送一件遗物 —— 这里整体覆盖掉。
   *  第三批 P1-8：坏档不再白屏。`{"v":1}` 这种缺字段的快照以前会在 `snap.deck.map` 抛异常，
   *  现在直接返回 null，由调用方回落到标题页。 */
  static restore(snap, meta) {
    if (!snap || !Array.isArray(snap.deck) || !snap.map) return null;
    const r = new Run({
      archetypeId: snap.archetypeId,
      meta,
      seed: snap.seedSource,
      daily: snap.daily,
      originId: snap.originId,
      asc: snap.ascOverride != null ? snap.ascOverride : null,
    });
    r.seed = snap.seed;
    r.rng.state = snap.rngState;
    r.hp = snap.hp;
    r.maxHp = snap.maxHp;
    r.deck = snap.deck.map((c) => ({ uid: c.uid, cid: c.cid }));
    r.relicIds = snap.relicIds.slice();
    r.map = snap.map;
    r.cursor = snap.cursor;
    r.history = snap.history || [];
    r.startedAt = snap.startedAt;
    r.battleTries = snap.battleTries || {};   // 旧快照没这个字段也能恢复
    r.phase = PHASE.MAP;
    ensureUidAbove(snap.deck.reduce((m, c) => Math.max(m, c.uid), 0));
    return r;
  }

  /** 每局 1 次：重抽当前奖励三选一（机制批 P1-4）。不消耗额外的机会，只消耗这一局的 1 次重抽权。 */
  rerollRewards() {
    if (this.rerollUsed) return false;
    this.rerollUsed = true;
    // 复用同一个 rollRewards，保底口径与首次完全一致。
    // 注意：不递增 rewardIndex —— 重抽是「替换这一次的三选一」，不是「再领一次奖励」。
    this.rewardCards = this.rollRewards();
    return true;
  }

  /** 取走奖励；cid 为 null 表示跳过 */
  takeReward(cid) {
    if (cid) this.addCard(cid);
    // 第三批 P0-6：这一屏的三张算「已见过」，下一屏的保底据此判断。
    for (const c of this.rewardCards) this.seenKey.add(c.id);
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
    // 内容批 P0-1 回归：maxHp 可为负（ev.stitch −6），叠加后 hp 不能越界（既不 <1 也不 >上限）。
    this.hp = Math.min(this.maxHp, Math.max(1, this.hp));
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
    clear(CONST.RUN_KEY);   // 这一世结束了，快照必须消失，否则下次进来会"继续"一局已经死掉的 run
    this.outcome = outcome;
    if (!this.daily) {
      // 第三批 P1-11：runs 是「已归来 N 世」的普通局计数，必须留在分支内 ——
      //      旧代码在上面无条件 +1，导致每日局也会推进这个数字。
      this.meta.runs += 1;
      if (outcome === 'cleared') {
        this.meta.wins += 1;
        // 内容批 P1-6 / 第三批 P1-12：通关后难度阶梯 +1（封顶 8 —— 5 阶太早到头，后期反而变简单）
        this.meta.ascension = Math.min(8, (this.meta.ascension || 0) + 1);
      }
      this.meta.bestFloor = Math.max(this.meta.bestFloor, this.floor);
      const minutes = (Date.now() - this.startedAt) / 60000;
      this.meta.totalMinutes = Math.round((this.meta.totalMinutes + minutes) * 10) / 10;
      // 内容批 P1-8：世记 —— 把每一世死在哪、带回了什么记下来（runs 已 +1，这里就是「第几世」）
      this.meta.history.push({
        run: this.meta.runs,
        arch: this.archetypeId,
        cleared: outcome === 'cleared',
        floor: this.floor,
        nodes: this.cleared,
        deck: this.deck.length,
        relics: this.relicIds.length,
        carried: this.meta.carried || null,
        at: Date.now(),
      });
      if (this.meta.history.length > 30) this.meta.history = this.meta.history.slice(-30);
    } else {
      // 内容批 P1-7 修正 / 第三批 P1-11：每日局也进世记（只读档案），
      //      但不涨 runs / wins / ascension / bestFloor / totalMinutes —— 否则会污染普通局统计。
      this.meta.history.push({
        run: null,
        daily: true,
        arch: this.archetypeId,
        cleared: outcome === 'cleared',
        floor: this.floor,
        nodes: this.cleared,
        deck: this.deck.length,
        relics: this.relicIds.length,
        carried: null,
        at: Date.now(),
      });
      if (this.meta.history.length > 30) this.meta.history = this.meta.history.slice(-30);
      this.recordDaily(outcome);
    }
    // 普通局才给解锁三选一；每日局直接进结算页
    this.pendingUnlock = this.daily ? { cards: [], relics: [] } : rollUnlockChoices(this.rng, this.meta, 3);
    // 口径：卡池全解锁后 sealedCards 为空，若仍按「三选一解锁」走，玩家会直接落到 OVER ——
    //      仪式断供，「一世一牌」在第 24 世消失。此时改为「从本世牌组里挑一张带走」。
    //      每日局不进这条分支（它不解锁、不带牌）。
    this.pendingCarry = this.daily || this.pendingUnlock.cards.length ? null : this.deckCarryChoices();
    const hasChoice = this.pendingUnlock.cards.length > 0 || (this.pendingCarry && this.pendingCarry.length > 0);
    // 口径：如果没有任何候选，直接进结算页 —— 否则会卡在一个空的三选一里
    this.phase = hasChoice ? PHASE.UNLOCK : PHASE.OVER;
    saveMeta(this.meta);    // 落盘 runs / wins / ascension / history 等增量
    // 埋点（阶段 4 / T2）：只读观测层。放这里是唯一正确的位置 ——
    // finish 是一局的唯一出口，此时 outcome / cleared / deck 都已定稿。
    // 这个函数内部自己判断开关，默认直接 return null（零副作用、零 RNG 消耗）。
    emitRunLog(this);
    return this.phase;
  }

  /** 内容批 P1-7：每日局的最好成绩记录（localStorage 键 one-card:daily:v1） */
  recordDaily(outcome) {
    const today = todayKey();
    const DAILY_KEY = 'one-card:daily:v1';
    const rec = load(DAILY_KEY, null);
    const minutes = Math.round(((Date.now() - this.startedAt) / 60000) * 10) / 10;
    const next = {
      date: today,
      seed: this.seed,
      arch: this.archetypeId,
      best: {
        cleared: outcome === 'cleared',
        floor: this.floor,
        nodes: this.cleared,        // 标题页显示「最好 X/12 节点」用；比较时也读它
        minutes,
      },
    };
    // 跨天自动重置（date 不匹配就整条覆盖）；同日则取更好成绩
    if (rec && rec.date === today) {
      const a = next.best, b = rec.best || {};
      // 判据：通关 > 未通关；同档比节点数；三项都打平才比用时（少者胜）。
      // 第三批 P1-11：旧注释写着「再同比用时」但代码没实现 —— 要么删注释、要么真比，这里选真比。
      const better =
        (a.cleared && !b.cleared) ||
        (a.cleared === !!b.cleared && (a.nodes || 0) > (b.nodes || 0)) ||
        (a.cleared === !!b.cleared && (a.nodes || 0) === (b.nodes || 0) && (a.minutes || 0) < (b.minutes || 0));
      if (!better) next.best = b;
    }
    save(DAILY_KEY, next);
  }

  /**
   * 卡池全解锁后的兜底：从本世牌组里挑 3 张不同名、非基础牌的卡，让玩家带走一张（P0-2）。
   * 口径：基础牌（r===0，打击/防御）不能当「本世牌」—— 带回来一张打击等于什么都没带。
   *      同名只留一张，避免三选一里出现两张一样的牌。牌组不足 3 种时返回实际数量（可能 0）。
   */
  deckCarryChoices() {
    const seen = new Set();
    const uniq = [];
    for (const inst of this.deck) {
      const d = CARD_MAP[inst.cid];
      if (!d || d.r === 0 || seen.has(d.id)) continue;
      seen.add(d.id);
      uniq.push(d);
    }
    return this.rng.sample(uniq, CONST.REWARD_CHOICES);
  }

  /** 带回一张牌（必须选一张，这就是核心幻想） */
  takeUnlock(cardId) {
    const c = this.pendingUnlock && this.pendingUnlock.cards.find((x) => x.id === cardId);
    if (c) grantCardUnlock(this.meta, c.id);
    else if (this.pendingCarry && this.pendingCarry.some((x) => x.id === cardId)) {
      // 全解锁兜底：只改「本世牌」，不动牌谱（这张牌早就在牌谱里了）
      this.meta.carried = cardId;
      saveMeta(this.meta);
    }
    const r = this.pendingUnlock && this.pendingUnlock.relics[0];
    if (r) grantRelicUnlock(this.meta, r.id);
    this.pendingUnlock = null;
    this.pendingCarry = null;
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
      lastBattle: this.lastBattle,
    };
  }
}
