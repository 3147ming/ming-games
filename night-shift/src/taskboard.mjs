/**
 * 任务板系统（2026-10-06 块4）
 *
 * ── 定位：把"跑腿/任务"从隐性收入做成正式的经营决策 ──────────
 * 需求原文：「解决'钱全靠任务和跑腿'」+「平衡主线营收和任务收入」。
 * 做法：每晚刷 3 张卡，玩家**主动接单**（可弃，有冷却），完成即入账。
 * 收益刻意压在营收的 20~30%（见 config.TASKBOARD 的平衡推算）。
 *
 * ── 与既有 quests.mjs 的关系：并存，不替换 ────────────────────
 * QUESTS（需求I）是"活动限时任务"：自动刷新、最多 1 个、不可接弃、超时失效。
 * 任务板是"经营决策"：要你点接单、要你权衡今晚做哪单。
 * 两者共存 —— 自动任务保证玩家不会闲着，任务板提供取舍空间。
 * 所以本模块**不碰** state.quest（那是 QUESTS 的），自己用 state.taskboard。
 *
 * ── 进度口径：沿用 quests.mjs 的"基线差分"，零埋点 ────────────
 * 接单那一刻记 baseline（该 metric 的当前累计值），进度 = 当前累计 − baseline。
 * 新任务类型只要提供一个 metric 取值函数即可，不必在 economy / interaction /
 * customers 三处埋点 —— 漏埋的地方会静默不计数，那是这类系统最常见的 bug。
 *
 * ── 纯逻辑、零 THREE / DOM（ADR-002）─────────────────────────
 */

import { TASKBOARD } from './config.mjs';

const numOr = (v, d) => (Number.isFinite(v) ? v : d);

/**
 * 指标取值器表：从 main 每帧传入的快照 ctx 里取累计值。
 * 全部走"累计值"，因此本模块只需要 ctx，不需要认识 economy / customers。
 * 促销限定类（soldDrinkPromo）由 main 侧判断是否在促销期，不在促销期时返回 0
 * （这样进度不会在非促销期累积，玩家接了单却推进不了会以为坏了）。
 */
const METRICS = {
  served: (c) => numOr(c.served, 0),
  servedBento: (c) => numOr(c.servedBento, 0),
  soldDrinkPromo: (c) => numOr(c.promoActive ? c.soldDrinkPromo : 0, 0),
  cleaned: (c) => numOr(c.cleaned, 0),
  placed: (c) => numOr(c.placed, 0),
  cleared: (c) => numOr(c.cleared, 0),
};

function metricOf(metric, ctx) {
  const fn = METRICS[metric];
  return typeof fn === 'function' ? fn(ctx) : 0;
}

/**
 * @param opts.state   state.mjs 单一真源
 * @param opts.rng     () => number（测试注入）
 * @param opts.onEvent (type, payload) —— 'tb-new' | 'tb-accept' | 'tb-done'
 *                            | 'tb-abandon' | 'tb-expire'
 */
export function createTaskboard(opts = {}) {
  const state = opts.state;
  const rnd = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};

  let seq = 0;

  /** 读出任务板状态容器（老存档没有就建一个） */
  function ensure() {
    if (!state.taskboard || typeof state.taskboard !== 'object') {
      state.taskboard = { offers: [], accepted: null, abandonCooldown: 0 };
    }
    const tb = state.taskboard;
    if (!Array.isArray(tb.offers)) tb.offers = [];
    if (typeof tb.abandonCooldown !== 'number') tb.abandonCooldown = 0;
    return tb;
  }

  /** 从模板池抽 n 张不重复的卡（洗牌后取前 n） */
  function pickTemplates(n) {
    const pool = [...TASKBOARD.templates];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, Math.min(n, pool.length));
  }

  /**
   * 每晚刷一批卡（startNight 调用）。
   * 已接受的进行中任务跨夜保留 —— 玩家接了单就该做完它，
   * 跨夜作废等于"接单是个陷阱"，那玩家以后就不敢接了。
   */
  function dealNight(ctx = {}) {
    const tb = ensure();
    tb.offers = pickTemplates(TASKBOARD.offerPerNight).map((tpl) => ({
      uid: `T${++seq}`,
      tplId: tpl.id,
      metric: tpl.metric,
      label: tpl.label,
      unit: tpl.unit,
      hint: tpl.hint ?? '',
      goal: tpl.goals[0] ?? 1,
      reward: { cash: tpl.reward.cash ?? 0, tokens: tpl.reward.tokens ?? 0 },
      left: TASKBOARD.offerValidSec,
      // accepted 卡的 baseline 在接单那一刻才记；offer 卡的 baseline 是 0
      baseline: 0,
      progress: 0,
    }));
    tb.abandonCooldown = 0;
    onEvent('tb-new', { offers: panel().offers });
    return tb.offers;
  }

  /** 接单：把 offer 移到 accepted，并记下那一刻的基线 */
  function accept(uid, ctx = {}) {
    const tb = ensure();
    if (tb.abandonCooldown > 0) return { ok: false, reason: `弃单冷却中（${Math.ceil(tb.abandonCooldown)}s）` };
    const acceptedCount = tb.accepted ? 1 : 0;
    if (acceptedCount >= TASKBOARD.acceptedMax) {
      return { ok: false, reason: `同时最多接 ${TASKBOARD.acceptedMax} 单 · 先完成手上的` };
    }
    const i = tb.offers.findIndex((o) => o.uid === uid);
    if (i < 0) return { ok: false, reason: '该任务不在板上' };
    const card = tb.offers[i];
    // baseline 在**接单时刻**取，而不是发牌时刻：发牌到接单之间玩家已经干了不少活，
    // 那些不该算进这单（否则"接单瞬间就接近完成"）。
    card.baseline = metricOf(card.metric, ctx);
    card.progress = 0;
    tb.offers.splice(i, 1);
    tb.accepted = card;
    onEvent('tb-accept', { task: card });
    return { ok: true, task: card };
  }

  /**
   * 弃单：无惩罚但进冷却。
   * 弃掉的卡直接消失（不放回 offer 池）—— 放回去就是"重摇"，
   * 玩家会刷到想要的组合，冷却形同虚设。
   */
  function abandon() {
    const tb = ensure();
    if (!tb.accepted) return { ok: false, reason: '当前没有进行中的任务' };
    const task = tb.accepted;
    tb.accepted = null;
    tb.abandonCooldown = TASKBOARD.abandonCooldownSec;
    onEvent('tb-abandon', { task });
    return { ok: true, task, cooldown: tb.abandonCooldown };
  }

  /** 完成并入账（cash + tokens，都不进 revenue —— 任务不是门店营收） */
  function complete(task) {
    const cash = numOr(task?.reward?.cash, 0);
    const tokens = numOr(task?.reward?.tokens, 0);
    state.cash += cash;
    state.tokens += tokens;
    // 累计到本夜账，供结算面板算"任务收入占比"
    state.taskboardIncome = (state.taskboardIncome | 0) + cash;
    const tb = ensure();
    if (tb.accepted && tb.accepted.uid === task.uid) tb.accepted = null;
    onEvent('tb-done', { task, cash, tokens });
    return { ok: true, cash, tokens };
  }

  /** 超时作废（offer 到期 / accepted 过期） */
  function expireCard(task) {
    const tb = ensure();
    const i = tb.offers.findIndex((o) => o.uid === task.uid);
    if (i >= 0) tb.offers.splice(i, 1);
    if (tb.accepted && tb.accepted.uid === task.uid) tb.accepted = null;
    onEvent('tb-expire', { task });
  }

  /**
   * 每帧推进（传**游戏**秒）。检查：冷却倒数 → 进度 → 完成 → offer 到期。
   * @param ctx { served, servedBento, soldDrinkPromo, promoActive, cleaned, placed, cleared }
   */
  function update(dt, ctx = {}) {
    if (!(dt > 0)) return null;
    const tb = ensure();
    if (tb.abandonCooldown > 0) tb.abandonCooldown = Math.max(0, tb.abandonCooldown - dt);

    // ① 进度推进 + 完成判定（只对已接单）
    const task = tb.accepted;
    if (task) {
      task.progress = Math.max(0, metricOf(task.metric, ctx) - numOr(task.baseline, 0));
      task.left = Math.max(0, numOr(task.left, 0) - dt);
      if (task.progress >= task.goal) {
        complete(task);
        return { done: true, task };
      }
      if (task.left <= 0) {
        expireCard(task);
        return { expired: true, task };
      }
    }

    // ② offer 倒计时（未被接的卡也会过期，避免板上永远堆着旧任务）
    for (let i = tb.offers.length - 1; i >= 0; i--) {
      const o = tb.offers[i];
      o.left = Math.max(0, numOr(o.left, 0) - dt);
      if (o.left <= 0) {
        tb.offers.splice(i, 1);
        onEvent('tb-expire', { task: o });
      }
    }
    return null;
  }

  /** 展示数据（HUD 顶部进度 + 手机任务面板消费） */
  function panel() {
    const tb = ensure();
    const mk = (c, isAccepted) => ({
      uid: c.uid,
      /* ⚠ metric / tplId 必须透出：外部（探针、未来的成就系统）要靠 metric
       * 判断"这是哪类任务"，漏了它 panel().offers 里就只剩标签文本，
       * 想断言"抽到的是哪张卡"都做不到 —— 这个坑真的踩过一次。 */
      metric: c.metric,
      tplId: c.tplId,
      label: c.label,
      unit: c.unit,
      hint: c.hint,
      goal: c.goal,
      progress: Math.min(c.goal, Math.round(numOr(c.progress, 0) * 10) / 10),
      left: Math.max(0, Math.round(numOr(c.left, 0))),
      ratio: Math.max(0, Math.min(1, c.goal > 0 ? numOr(c.progress, 0) / c.goal : 0)),
      reward: { cash: c.reward?.cash ?? 0, tokens: c.reward?.tokens ?? 0 },
      accepted: !!isAccepted,
    });
    return {
      offers: tb.offers.map((c) => mk(c, false)),
      accepted: tb.accepted ? mk(tb.accepted, true) : null,
      abandonCooldown: Math.max(0, Math.ceil(tb.abandonCooldown)),
      canAccept: !tb.accepted && tb.abandonCooldown <= 0,
      acceptedMax: TASKBOARD.acceptedMax,
    };
  }

  /** 跨夜重置：清本夜收入累计 + 刷新卡面（打烊时调） */
  function settleNight() {
    const tb = ensure();
    tb.abandonCooldown = 0;
    const income = state.taskboardIncome | 0;
    state.taskboardIncome = 0;
    return income;
  }

  function reset() {
    state.taskboard = { offers: [], accepted: null, abandonCooldown: 0 };
    state.taskboardIncome = 0;
  }

  return { ensure, dealNight, accept, abandon, update, panel, complete, settleNight, reset };
}
