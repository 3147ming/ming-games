/**
 * C 技连段状态机（模块 3 的核心）—— **纯逻辑**，不 import three / 不碰 DOM。
 * ---------------------------------------------------------------------------
 * 为什么连段必须单独成一层：
 *   "轻×2 后接重攻击出 C3，轻×3 出 C4，轻×4 出 C5；轻击不足 2 次按重键是独立重击；
 *    按住重攻击蓄满出蓄力斩"
 *   这套规则如果散在控制器里，表现会是"某一击偶尔接不上"——而且极难复现。
 *   抽成表驱动之后，`node --test` 可以把每一条派生、每一个时间窗口全跑一遍。
 *
 * 时间轴（一次挥击）：
 *
 *   ├─ startup ─┼─ active ─┼── recovery ──┤
 *   0          s         s+a         total
 *                            ↑ cancelFrom
 *                            └─ 进入取消窗口：可以接下一击（自带 CHAIN_GRACE 宽限）
 *
 * 三条不能违反的规则：
 *   ① **active 期间只结算 hits 次**（不是每帧都判定）。多段 C 技靠 hits，不靠帧数。
 *   ② 取消窗口只能**向前**：动作一开始不能取消，否则连点会变成"无后摇"。
 *   ③ 每次挥击只用一次输入缓冲：同一次按下绝不能触发两段。
 */
export const PHASE = {
  IDLE: 'idle',
  STARTUP: 'startup',
  ACTIVE: 'active',
  RECOVERY: 'recovery',
  CHARGING: 'charging',
};

/** 轻攻击连段顺序（N5 之后回到 N1，形成循环） */
export const LIGHT_SEQ = { N1: 'N2', N2: 'N3', N3: 'N4', N4: 'N5', N5: 'N1' };

/** 轻攻击连段的顺序（用于数"已经打了几段轻攻击"） */
export const LIGHT_ORDER = ['N1', 'N2', 'N3', 'N4', 'N5'];

/** 已经打出过几段轻攻击（prevId 不是轻攻击时算 0）。⚠ 见下方"为什么要有显式计数器" */
export function lightCountOf(prevId) {
  const i = LIGHT_ORDER.indexOf(prevId);
  return i < 0 ? 0 : i + 1;
}

/**
 * 按"本轮已打出的轻攻击段数"决定重攻击该出哪一招。
 * ===========================================================================
 * ★SPEC 映射表（**这张表就是 spec 的全部内容**，改它之前先看完下面三行）：
 *
 *   轻击段数 | 出招  | spec 写法        | 内部计数（总轻击数 − 2）
 *   ---------|-------|------------------|------------------------
 *     0      |  H    | 独立重攻击起手   | —（不是 C 技，不参与连段计数）
 *     1      |  H    | 独立重攻击起手   | —（"轻击未达 2 次"→ 同上）
 *     2      |  C3   | 轻×2 + 重        | 0 段轻 + 重
 *     3      |  C4   | 轻×3 + 重        | 1 段轻 + 重
 *    ≥4      |  C5   | 轻×4 + 重        | 2 段轻 + 重（封顶）
 *
 * 为什么 C1/C2 不在表里：spec 的「C1 = 轻 / C2 = 轻+轻」**就是已有的 N1/N2 本身**。
 * 再给它们起一个 C 名，等于让同一个动作有两个名字 —— 派生表、招式表、教学文案
 * 各写各的，改一处漏一处。所以这里**不设 C1/C2**，轻击不足 2 次时按重键走独立重击。
 *
 * 为什么"内部计数"从 0 开始：前两下轻攻击已经被 N1/N2 占掉了，从第 3 下起才计入
 * C 技的段数 —— 于是 C3（轻×2+重）的内部计数是 0。
 *
 * @param lightCount 本轮已打出的轻攻击段数（ComboState.lightCount）
 */
export function heavyFinisherFor(lightCount) {
  const n = Number.isFinite(lightCount) ? lightCount | 0 : 0;
  if (n < 2) return 'H'; // ★SPEC：轻击未达 2 次 → 独立重攻击（非 C 技）
  return n >= 4 ? 'C5' : 'C' + (n + 1); // 2→C3 / 3→C4 / ≥4→C5
}

/** 收尾技（独立重击 / C 技 / 蓄力斩）之后，连段计数必须归零 */
export function isFinisher(id) {
  return !!id && (id === 'H' || id[0] === 'C');
}

/**
 * 派生表：给出"上一招 + 本次按的键 + 已打出的轻击段数"，返回下一招的 id。
 * 这张表就是 spec 里那句"轻×n + 重攻击 → C 技"的全部内容。
 *
 * @param lightCount 显式传入的轻击段数。⚠ 不能靠 prevId 反推（见 lightCountOf 的警告），
 *                   缺省时才兜底用 lightCountOf(prevId)。
 */
export function chainNext(prevId, kind, lightCount = lightCountOf(prevId)) {
  if (kind === 'heavy') {
    // 收尾技之后连段就结束了：计数归零，再按重攻击是**独立重击**（不是从 C3 重新起手）。
    // ⚠ 蓄力斩**只能靠蓄满获得**，不从派生里给 —— 否则"轻点重攻击"就能白嫖满蓄力，
    //   数值上直接塌掉（tap 一下出全游戏最高伤害）。
    return heavyFinisherFor(isFinisher(prevId) ? 0 : lightCount);
  }
  // 轻攻击：已经在连段里就往下推，出了收尾技/静止就从 N1 重新开始
  return prevId ? LIGHT_SEQ[prevId] || 'N1' : 'N1';
}

/** 由 id 取动作定义（轻攻击表 + 重攻击表） */
export function moveById(id, cfg) {
  const l = cfg.LIGHT.find((m) => m.id === id);
  if (l) return l;
  return cfg.HEAVY.MOVES[id] || null;
}

/** 动作总时长 */
export function moveTotal(move) {
  return move.startup + move.active + move.recovery;
}

/** 判定生效的时间点列表（多段攻击均匀分布在整个 active 窗口里） */
export function activeTimes(move) {
  const n = Math.max(1, move.hits | 0);
  const out = [];
  for (let i = 0; i < n; i++) out.push(move.startup + (move.active * (i + 1)) / n);
  return out;
}

export class ComboState {
  constructor(cfg) {
    this.cfg = cfg;
    this.reset();
  }

  reset() {
    this.phase = PHASE.IDLE;
    this.move = null;
    this.prevId = null; // 上一招 id → 决定派生
    /**
     * 本轮已打出的**轻攻击段数**（决定按重键出哪一招）。
     * ⚠ 为什么必须是一个显式计数器，而不是从 prevId 反推（`lightCountOf`）：
     *   轻攻击连段 N5 之后**循环回 N1**。若按 prevId 反推，打完 5 段轻（N5，计数 5）
     *   再打第 6 段（又变成 N1）时计数会**倒退回 1** —— 于是"连点 6 下再按重键"
     *   出的不是 C5 而是独立重击。这个 bug 只有在玩家连点到第 6 下时才出现，
     *   手玩极难复现，所以必须靠显式计数 + 断言锁住。
     */
    this.lightCount = 0;
    this.t = 0; // 当前动作已用时（秒）
    this.chargeT = 0; // 蓄力已用时
    this.hitsFired = 0; // 本次挥击已结算的段数
    this.pending = null; // { kind, at } 输入缓冲
    this.chainOpenAt = Infinity; // 取消窗口开启时刻（也即"能接下一击"的最早时刻）
    // ⚠ 这里**没有** chainCloseAt：窗口的关闭时刻就是"动作结束那一刻"，
    //   而动作一结束 phase 就回到 IDLE，canChain 自然变 false。
    //   曾经有过一个 chainCloseAt 字段，唯一读者是一处写错的判据
    //   （`t >= min(openAt, closeAt)`，等于把宽限吃掉了）—— 现已删除。
    this.chargeMove = null; // 蓄力成功后要放的那一招
    this.swingIndex = 0; // 本次进攻已挥了几击（统计/调试用）
    this.idleT = 0; // 待机了多久（超过 CHAIN_WINDOW 0.4s 就把连段重置回 N1）
  }

  /**
   * ⚠ `reset()` 与 `cancel()` 的区别（很容易混）：
   *   reset()  —— "把连段整个清空"：连 prevId 和 swingIndex 都归零。调试面板的复位、
   *              探针每次采样前都该用它，否则上一条用例的段数会渗到下一条里。
   *   cancel() —— "这一招被打断了"：清掉当前动作，但**保留 prevId**。闪避/受击用它，
   *              于是"砍到一半闪开、再按攻击"还能接着连 —— 这是动作游戏的惯例。
   */

  get busy() {
    return this.phase !== PHASE.IDLE;
  }

  get charging() {
    return this.phase === PHASE.CHARGING;
  }

  /** 当前动作的总时长（蓄力时以蓄力基准招为准） */
  get total() {
    return this.move ? moveTotal(this.move) : 0;
  }

  /** 0..1：正招进度（HUD / 特效缩放用） */
  get progress() {
    if (this.phase === PHASE.CHARGING) return Math.min(1, this.chargeT / this.cfg.HEAVY.CHARGE_TIME);
    return this.total > 0 ? Math.min(1, this.t / this.total) : 0;
  }

  /** 蓄力比例 0..1 */
  get chargeRatio() {
    if (this.phase !== PHASE.CHARGING) return 0;
    return Math.min(1, this.chargeT / this.cfg.HEAVY.CHARGE_TIME);
  }

  /**
   * 取消窗口是否已开（**含 CHAIN_GRACE 宽限**）。
   * ⚠ 这里必须和 request() 用同一个判据（`t + CHAIN_GRACE >= chainOpenAt`）。
   *   曾经写成 `t >= min(chainOpenAt, chainCloseAt)`（等于不带宽限），后果是
   *   HUD / 教学提示在"其实已经能接"的 80ms 里显示"不能接"，而玩家按下却真的接上了 ——
   *   两条规则各写一份、各差一点，是这类状态机最难查的一类 bug。
   *   测试里有一条断言专门锁"canChain 与 request 说同一句话"。
   */
  get canChain() {
    if (!this.busy || this.phase === PHASE.CHARGING) return false;
    return this.t + this.cfg.CHAIN_GRACE >= this.chainOpenAt;
  }

  /**
   * 记录一次输入。
   * 两条规则，缺一不可：
   *   ① **取消窗口之前的输入不收**（前摇/动作前段按下去不该生效）—— 窗口比 cancelFrom
   *      再往前放 CHAIN_GRACE，用来吸收"早按了几十毫秒"。
   *   ② 一旦收下就**一定会在本招结束时兑现**，不做超时丢弃。
   *      这与"输入层的缓冲窗口"是两件事：输入层管"多久之前的按下还算数"，
   *      这里管"收下的意图要不要兑现"。若在这里也加超时，连点就会出现
   *      "明明按了却没接上"的随机感 —— 那是最劝退的手感 bug。
   */
  request(kind, now = 0) {
    // 蓄力中收到轻攻击：忽略（蓄力只能靠松手 / 闪避结束）
    if (this.phase === PHASE.CHARGING) return false;
    if (!this.busy) {
      this.pending = { kind, at: now };
      return true;
    }
    if (this.t + this.cfg.CHAIN_GRACE >= this.chainOpenAt) {
      this.pending = { kind, at: now };
      return true;
    }
    return false;
  }

  /** 有没有收下的输入等着兑现 */
  get buffered() {
    return !!this.pending;
  }

  dropBuffer() {
    this.pending = null;
  }

  /** 开始蓄力（按住重攻击键）。baseId 是"如果没蓄满会放哪一招"。 */
  startCharge(baseId) {
    if (this.phase === PHASE.CHARGING) return [];
    this.prevId = this.move ? this.move.id : this.prevId;
    this.chargeMove = moveById(baseId, this.cfg);
    this.phase = PHASE.CHARGING;
    this.move = null;
    this.chargeT = 0;
    this.pending = null;
    return [{ type: 'chargeStart', baseId }];
  }

  /**
   * 解除蓄力。
   * @param charged 是否蓄满（蓄满 → 蓄力斩，否则出 baseId 那一招）
   */
  releaseCharge(charged) {
    if (this.phase !== PHASE.CHARGING) return [];
    const baseId = this.chargeMove ? this.chargeMove.id : 'H';
    const id = charged ? 'CHARGED' : baseId;
    this.chargeT = 0;
    this.chargeMove = null;
    return this._begin(id, { charged });
  }

  /** 取消一切进行中的动作（闪避/受击会调它） */
  cancel(reason = 'cancel') {
    const was = this.move ? this.move.id : this.phase === PHASE.CHARGING ? 'charge' : null;
    if (!was) {
      this.pending = null;
      return [];
    }
    this.phase = PHASE.IDLE;
    this.move = null;
    this.t = 0;
    this.hitsFired = 0;
    this.chainOpenAt = Infinity;
    this.pending = null;
    this.chargeT = 0;
    this.chargeMove = null;
    return [{ type: 'cancel', id: was, reason }];
  }

  /** 内部：真正开始某一招 */
  _begin(id, extra = {}) {
    const move = moveById(id, this.cfg);
    if (!move) return [];
    this.move = move;
    this.phase = PHASE.STARTUP;
    this.t = 0;
    this.hitsFired = 0;
    this.pending = null;
    // ★连段计数：轻攻击累加，**任何重击都把计数归零**（spec：重击收尾后连段计数归零）。
    //   所以 C5 打完再按重键 = 独立重击，而不是"接着 C5 往下连"。
    if (LIGHT_ORDER.includes(id)) this.lightCount++;
    else this.lightCount = 0;
    this.chainOpenAt = move.cancelFrom;
    this.swingIndex++;
    return [{ type: 'start', move, id, ...extra }];
  }

  /** 立刻起手某一招（外部/测试用；正常路径是 update 里从缓冲派生） */
  begin(id, extra = {}) {
    const ev = this._begin(id, extra);
    if (ev.length) this.prevId = id;
    return ev;
  }

  /**
   * 推进一帧。
   * @param dt 帧长（秒）
   * @param now 用于输入缓冲的绝对时间（通常等于累计时间）
   * @returns {Array<{type:string}>} 本帧发生的事件
   */
  update(dt, now = 0) {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const events = [];

    // ── 蓄力：只涨计时，判定与位移都不发生
    if (this.phase === PHASE.CHARGING) {
      this.chargeT += step;
      events.push({ type: 'charge', ratio: this.chargeRatio });
      return events;
    }

    if (!this.busy) {
      this.idleT += step;
      // ★SPEC 连段窗口 CHAIN_WINDOW（0.4s）：打完一招后 0.4s 内没按下一击，连段计数归零。
      //   ⚠ prevId 和 lightCount **必须一起清**：只清一个会让"停在 N3 上"和
      //   "已经打了 3 段"两种状态打架，派生出来的招式和玩家按的次数对不上。
      if (this.idleT > this.cfg.CHAIN_WINDOW) {
        this.prevId = null;
        this.lightCount = 0;
      }
      // 待机：收下的输入立刻起手
      if (this.pending) {
        const kind = this.pending.kind;
        this.pending = null;
        const id = chainNext(this.prevId, kind, this.lightCount);
        events.push(...this._begin(id));
        this.prevId = id;
      }
      return events;
    }
    this.idleT = 0;

    const move = this.move;
    const total = moveTotal(move);
    this.t = Math.min(total, this.t + step);

    // ── 判定帧：active 期间按 hits 次数结算（跨过时间点就触发一次）
    //    用 while 而不是 if：一帧很长（掉帧、切标签页回来）时跨过了两个判定点，
    //    也必须把两段都结算掉，否则"多段 C 技少打一段"会变成一个随机发生的 bug。
    const times = activeTimes(move);
    while (this.hitsFired < times.length && this.t >= times[this.hitsFired]) {
      this.hitsFired++;
      events.push({ type: 'hit', move, index: this.hitsFired - 1, of: times.length });
    }

    // ── 阶段标签（HUD/动画分支用）
    if (this.t < move.startup) this.phase = PHASE.STARTUP;
    else if (this.t < move.startup + move.active) this.phase = PHASE.ACTIVE;
    else this.phase = PHASE.RECOVERY;

    // ── 动作结束：有缓冲就在窗口内接续，否则回到待机
    if (this.t >= total) {
      if (this.pending) {
        const kind = this.pending.kind;
        this.pending = null;
        const id = chainNext(this.prevId, kind, this.lightCount);
        events.push({ type: 'end', move, chained: true });
        events.push(...this._begin(id));
        this.prevId = id;
      } else {
        events.push({ type: 'end', move, chained: false });
        this.phase = PHASE.IDLE;
        this.move = null;
        this.t = 0;
        this.hitsFired = 0;
        this.chainOpenAt = Infinity;
      }
    }
    return events;
  }

  /** 快照（HUD / 探针） */
  snapshot() {
    return {
      phase: this.phase,
      id: this.move ? this.move.id : this.phase === PHASE.CHARGING ? 'charge' : null,
      name: this.move ? this.move.name : this.phase === PHASE.CHARGING ? '蓄力' : '待机',
      step: this.swingIndex,
      lights: this.lightCount, // 本轮已打的轻击段数（决定按重键出哪一招）
      t: this.t,
      total: this.total,
      progress: this.progress,
      chargeRatio: this.chargeRatio,
      canChain: this.canChain,
      buffered: !!this.pending,
    };
  }
}
