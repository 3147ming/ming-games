/**
 * 监控室 + 蹲小偷（模块 4 子功能①）
 *
 * ── 定位：只加不改，零 DOM / 零 THREE ──────────────────────
 * 小偷是**每夜临时事件**，不进存档白名单（读档 / 夜末自动清空）。
 * 监控室面板（hud.openMonitor）只负责把本模块的纯数据画成 4 路监控小窗，
 * 玩家点对应分区即可"当场抓住"小偷。
 *
 * ── 与既有系统的边界（重要，别混） ────────────────────────
 *   · 小偷**不**走 customers / npcs 的移动系统 —— 它只活在本模块的 state.thief 里，
 *     是一个逻辑实体（分区 + 倒计时），表现层画成监控红点即可，不新增任何 3D 模型。
 *   · 抓住给现金奖励、漏抓按配置盗现金 —— 都走 state.cash，不干扰门店营收/结算。
 *   · 排程复用 night 的 gameHour 进度（与 RUSH/DRUNK 同口径），不另起计时。
 *
 * ── 纯逻辑、零 THREE/DOM 依赖（可在 Node 单测） ─────────────
 */

import { MONITOR } from './config.mjs';

/**
 * @param opts.state    state.mjs 单一真源
 * @param opts.rng      () => number  可注入 → 单测确定化
 * @param opts.onEvent  (type, payload) => void  HUD 提示用
 */
export function createMonitor(opts = {}) {
  const state = opts.state;
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};

  /** 每夜开局摇定小偷出现时刻（gameHour 0..8），0–2 只 */
  function rollForNight() {
    state.thief = null;
    state.thiefQueue = [];
    const n = MONITOR.minThieves
      + (rng() < 0.5 ? 1 : 0)
      + (rng() < 0.35 ? 1 : 0); // 0 / 1 / 2
    const count = Math.min(MONITOR.maxThieves, Math.max(MONITOR.minThieves, n));
    const hours = [];
    for (let i = 0; i < count; i++) {
      // 均匀分布在 1..7.5（避开刚开店与打烊前），每只错开至少 1 小时
      hours.push(1 + rng() * 6.5);
    }
    hours.sort((a, b) => a - b);
    state.thiefQueue = hours;
    return hours;
  }

  function spawnThief() {
    const zone = Math.min(MONITOR.zones.length - 1, Math.floor(rng() * MONITOR.zones.length));
    state.thief = {
      zone,
      left: MONITOR.thiefSeconds,
      total: MONITOR.thiefSeconds,
      caught: false,
    };
    onEvent('thief-appear', { zone, zoneName: MONITOR.zones[zone] });
  }

  /**
   * 每帧推进（传墙钟秒 dt；只在 running 阶段调用）。
   * @param ctx { gameHour: number }
   */
  function update(dt, ctx = {}) {
    if (!(dt > 0)) return;
    const gameHour = Number(ctx.gameHour ?? state.gameHour);

    /* 当前没有小偷时，按排程触发；一次只放一只，避免屏幕上同时两红点 */
    if (!state.thief && state.thiefQueue.length > 0) {
      // 取所有已到点的时刻，只放第一只（其余留给下一帧/下一时段）
      const due = state.thiefQueue.filter((h) => h <= gameHour);
      if (due.length > 0) {
        state.thiefQueue = state.thiefQueue.filter((h) => h > gameHour);
        spawnThief();
      }
    }

    if (state.thief && !state.thief.caught) {
      state.thief.left -= dt;
      if (state.thief.left <= 0) {
        // 漏抓：盗走现金
        const amount = Math.min(state.cash, MONITOR.stealAmount);
        state.cash -= amount;
        onEvent('thief-stole', { amount });
        state.thief = null;
      }
    }
  }

  /**
   * 玩家从监控室点击某分区尝试抓小偷。
   * @param zone 分区下标 0..3
   * @returns { ok, reward?, reason? }
   */
  function catchThief(zone) {
    if (!state.thief) return { ok: false, reason: 'no-thief' };
    if (state.thief.caught) return { ok: false, reason: 'already-caught' };
    if (state.thief.zone !== zone) return { ok: false, reason: 'wrong-zone' };
    state.thief.caught = true;
    const reward = MONITOR.catchReward;
    state.cash += reward;
    onEvent('thief-caught', { reward, zone });
    state.thief = null;
    return { ok: true, reward };
  }

  /** 当前状态（HUD / 测试用） */
  function status() {
    return {
      active: !!state.thief,
      thief: state.thief ? { ...state.thief } : null,
      pending: state.thiefQueue.length,
    };
  }

  /** 清场（读档 / 夜末 / 重置） */
  function reset() {
    state.thief = null;
    state.thiefQueue = [];
  }

  /** 派生快照（给 HUD 监控室面板） */
  function snapshot() {
    return {
      zones: MONITOR.zones.slice(),
      active: !!state.thief,
      thief: state.thief ? { ...state.thief } : null,
      pending: state.thiefQueue.length,
    };
  }

  return {
    rollForNight, update, catchThief, status, reset, snapshot,
    /** 序列化（小偷临时态，不进存档，这里仅作联机/调试预留） */
    serialize() { return { thief: state.thief, queue: state.thiefQueue }; },
    hydrate(data) {
      if (!data) return;
      state.thief = data.thief ?? null;
      state.thiefQueue = Array.isArray(data.queue) ? data.queue : [];
    },
  };
}
