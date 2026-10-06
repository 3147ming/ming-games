/**
 * 活动限时任务系统（需求I 第②条）
 *
 * ── 需求原文的四条约束，逐条对应 ────────────────────────
 *   ① 每隔游戏 300 秒刷新随机任务        → QUESTS.refreshSec + refresh()
 *   ② 示例四类（接待 / 维修 / 清理 / 赚钱）→ QUESTS.templates
 *   ③ 完成发金币 + 代币奖励              → 完成时 onEvent('quest-done')，奖励落 state
 *   ④ 超时自动失效并刷新新任务 · 最多 1 个 → update() 里到期即作废并立即再抽一个
 *
 * ── 进度口径：为什么用"累计值的增量"而不是埋点 ──────────
 * 四类指标里前三类在既有系统里已经有**累计计数器**（state.served / worldState.stats.*），
 * "单日赚取 X 金币"也能直接用 state.revenue + minigameEarn 的差分算出来。
 * 如果改成每个动作都去 report('serve')，就要在 economy / worldstate / interaction
 * 三处埋点 —— 每加一个新任务类型就得再埋一遍，且漏埋的地方会静默不计数。
 * 所以这里统一在**任务生成时记一份 baseline**，进度 = 当前累计 − baseline，
 * 新任务类型只要提供一个 metric 取值函数即可，零埋点。
 *
 * ── 纯逻辑、零 THREE / DOM ──────────────────────────────
 * 任务对象整体存在 state.quest 里（已在 save.mjs 的 STATE_FIELDS 白名单内），
 * 因此读档后任务进度与剩余时间都能原样恢复。
 */

import { QUESTS } from './config.mjs';

const numOr = (v, d) => (Number.isFinite(v) ? v : d);

/** 默认指标取值器：从 main 每帧传入的累计快照里取 */
const DEFAULT_METRICS = {
  served: (c) => numOr(c.served, 0),
  repaired: (c) => numOr(c.repaired, 0),
  cleaned: (c) => numOr(c.cleaned, 0),
  earned: (c) => numOr(c.earned, 0),
};

/**
 * @param opts.state   state.mjs 的单一真源
 * @param opts.rng     () => number 随机源（测试注入）
 * @param opts.onEvent (type, payload) —— 'quest-new' | 'quest-done' | 'quest-expire'
 */
export function createQuests(opts = {}) {
  const state = opts.state;
  const rnd = opts.rng ?? Math.random;
  const onEvent = opts.onEvent ?? (() => {});

  /** 本模块自己的游戏秒计时（跨夜由 main 调 reset() 清零） */
  let sinceLast = 0;
  let seq = 0;

  function metricOf(tpl, ctx) {
    const fn = DEFAULT_METRICS[tpl.metric];
    return typeof fn === 'function' ? fn(ctx) : 0;
  }

  /** 抽一个新任务（不判断时间，只负责生成） */
  function refresh(ctx = {}) {
    const tpl = QUESTS.templates[Math.floor(rnd() * QUESTS.templates.length)] ?? QUESTS.templates[0];
    const goal = tpl.goals[Math.floor(rnd() * tpl.goals.length)] ?? tpl.goals[0];
    const now = numOr(ctx.now, 0);
    const task = {
      uid: `Q${++seq}`,
      id: tpl.id,
      metric: tpl.metric,
      label: tpl.label,
      unit: tpl.unit,
      goal,
      /** 进度 = 当前累计 − baseline（见文件头的口径说明） */
      baseline: metricOf(tpl, ctx),
      progress: 0,
      /** 剩余时间（游戏秒） */
      left: QUESTS.refreshSec,
      reward: { cash: tpl.reward.cash ?? 0, tokens: tpl.reward.tokens ?? 0 },
      startedAt: now,
    };
    state.quest = task;
    onEvent('quest-new', { task });
    return task;
  }

  /**
   * 判定完成并派发奖励。
   * 奖励直接进 state（cash / tokens）而不走回调 —— 与既有 economy.earnCash 的口径一致，
   * 但刻意**不计入 state.revenue**：任务奖励不是门店营收，
   * 混进去会让"单日赚取金币"这类任务自我加速（赚得越多 → 任务完成得越快 → 又赚更多）。
   */
  function complete(task) {
    const cash = numOr(task?.reward?.cash, 0);
    const tokens = numOr(task?.reward?.tokens, 0);
    state.cash += cash;
    state.tokens += tokens;
    state.quest = null;
    onEvent('quest-done', { task, cash, tokens });
    return { ok: true, cash, tokens };
  }

  function expire(task) {
    state.quest = null;
    onEvent('quest-expire', { task });
  }

  /**
   * 每帧推进（传**游戏**秒）。
   * @param ctx { served, repaired, cleaned, earned, now }
   */
  function update(dt, ctx = {}) {
    if (!(dt > 0)) return state.quest;
    sinceLast += dt;

    // 没有任务（首次 / 刚完成 / 刚过期）→ 到点就抽一个新的
    if (!state.quest) {
      // 首次刷新要等满一个周期，避免开局 0 秒就弹一个任务糊在脸上
      if (sinceLast < QUESTS.refreshSec) return null;
      sinceLast = 0;
      return refresh(ctx);
    }

    const task = state.quest;
    task.progress = Math.max(0, metricOf(task, ctx) - numOr(task.baseline, 0));
    task.left = Math.max(0, numOr(task.left, 0) - dt);

    if (task.progress >= task.goal) {
      complete(task);
      sinceLast = 0;
      // 完成后立刻续一个新任务（需求：最多同时存在 1 个，但玩家不该有空窗期）
      return refresh(ctx);
    }
    if (task.left <= 0) {
      expire(task);
      sinceLast = 0;
      return refresh(ctx);
    }
    return task;
  }

  /** 当前任务的展示数据（HUD 左下角面板直接消费） */
  function panel() {
    const t = state.quest;
    if (!t) return null;
    return {
      uid: t.uid,
      label: t.label,
      unit: t.unit,
      goal: t.goal,
      progress: Math.min(t.goal, Math.round(numOr(t.progress, 0) * 10) / 10),
      left: Math.max(0, Math.round(numOr(t.left, 0))),
      ratio: Math.max(0, Math.min(1, t.goal > 0 ? numOr(t.progress, 0) / t.goal : 0)),
      reward: { cash: t.reward?.cash ?? 0, tokens: t.reward?.tokens ?? 0 },
    };
  }

  /** 跨夜 / 读档后重置计时（任务本身保留在 state 里，由调用方决定是否清空） */
  function reset() {
    sinceLast = 0;
  }

  return { update, refresh, complete, panel, reset, get current() { return state.quest; } };
}

export { QUESTS };
