/**
 * 随机突发事件（需求I 第⑥条：停电 / 机器大故障 / 客流高峰）
 *
 * ── 与既有 EVENTS 的分工（重要，别混） ──────────────────
 * config.EVENTS（RUSH / DRUNK / BLACKOUT / REGULAR）是**店内顾客维度**的事件，
 * 由 main.mjs 的 scheduleEvents() 在每夜开局排程 —— 需求要求"原有全部保留"，
 * 所以那张表一行都不动。
 * 这里新增的是**设备与场地维度**的事件，走独立的计时器与 RANDOM_EVENTS 配置。
 *
 * ── 事件如何落到既有系统上（三条都是"注入调制值"，不改既有逻辑） ──
 *   · 停电    → state.powerOutUntil + worldState.setModifiers({ satisfactionPenalty })
 *               设备不产出由 main 读 state 判断（NPC 不开始新游玩 / 玩家按 E 提示停电）
 *   · 大故障  → worldState.severeBreak(id)：维修费 × RANDOM_EVENTS 的 repairCostMul
 *   · 客流高峰→ state.surgeUntil + worldState.setModifiers({ litterMul })
 * 三者在到期时都会把调制值归位 —— 否则"停电结束但满意度还压着"会变成永久 debuff。
 *
 * ── 纯逻辑、零 THREE / DOM ──────────────────────────────
 */

import { RANDOM_EVENTS } from './config.mjs';

const numOr = (v, d) => (Number.isFinite(v) ? v : d);
const TYPE_BY_ID = Object.fromEntries(RANDOM_EVENTS.types.map((t) => [t.id, t]));

/**
 * @param opts.state       state.mjs 的单一真源
 * @param opts.worldState  worldstate 实例（读设备、写调制值、触发严重故障）
 * @param opts.rng         () => number
 * @param opts.onEvent     (type, payload) —— 'incident' | 'incident-end'
 */
export function createIncidents(opts = {}) {
  const state = opts.state;
  const worldState = opts.worldState;
  const rnd = opts.rng ?? Math.random;
  const onEvent = opts.onEvent ?? (() => {});

  let timer = 0;
  let fired = 0;
  let enabled = true;

  function pickType() {
    const types = RANDOM_EVENTS.types;
    const total = types.reduce((a, t) => a + (t.weight ?? 1), 0);
    let r = rnd() * total;
    for (const t of types) {
      r -= (t.weight ?? 1);
      if (r <= 0) return t;
    }
    return types[types.length - 1];
  }

  /** 挑一台当前正常、且不是玩家正在玩的设备来"炸" */
  function pickVictim(ctx) {
    const list = (worldState?.deviceList?.() ?? []).filter((d) => !d.broken);
    if (list.length === 0) return null;
    const active = typeof ctx?.activeDevice === 'function' ? ctx.activeDevice() : null;
    const pool = list.filter((d) => d.id !== active);
    const use = pool.length ? pool : list;
    return use[Math.floor(rnd() * use.length)] ?? null;
  }

  function fire(type, ctx) {
    const now = numOr(ctx?.now, 0);
    if (type.id === 'powerout') {
      state.powerOutUntil = now + type.durationSec;
      onEvent('incident', {
        id: type.id, name: type.name, emoji: type.emoji,
        desc: type.desc, durationSec: type.durationSec,
      });
      return { ok: true, id: type.id };
    }
    if (type.id === 'surge') {
      state.surgeUntil = now + type.durationSec;
      onEvent('incident', {
        id: type.id, name: type.name, emoji: type.emoji,
        desc: type.desc, durationSec: type.durationSec,
      });
      return { ok: true, id: type.id };
    }
    if (type.id === 'meltdown') {
      const victim = pickVictim(ctx);
      if (!victim) return { ok: false, reason: 'no-device' };
      const r = worldState?.severeBreak?.(victim.id, type.repairCostMul);
      if (!r?.ok) return { ok: false, reason: r?.reason ?? 'failed' };
      onEvent('incident', {
        id: type.id, name: type.name, emoji: type.emoji,
        desc: type.desc, deviceId: victim.id,
      });
      return { ok: true, id: type.id, deviceId: victim.id };
    }
    return { ok: false, reason: 'unknown-type' };
  }

  /**
   * 每帧推进（传**游戏**秒）。
   * @param ctx { now: wallElapsed, activeDevice: () => id|null }
   */
  function update(dt, ctx = {}) {
    if (!enabled || !(dt > 0)) return null;
    const now = numOr(ctx.now, 0);

    /* --- 到期恢复：先把 modulation 归位，再判断要不要触发新的 --- */
    if (state.powerOutUntil != null && now >= state.powerOutUntil) {
      state.powerOutUntil = null;
      onEvent('incident-end', { id: 'powerout' });
    }
    if (state.surgeUntil != null && now >= state.surgeUntil) {
      state.surgeUntil = null;
      onEvent('incident-end', { id: 'surge' });
    }
    // 调制值每帧按当前状态重算（而不是触发时写一次）—— 读档后也能自动对齐
    if (worldState?.setModifiers) {
      worldState.setModifiers({
        satisfactionPenalty: state.powerOutUntil != null
          ? (TYPE_BY_ID.powerout?.satisfactionPenalty ?? 0) : 0,
        litterMul: state.surgeUntil != null ? (TYPE_BY_ID.surge?.litterMul ?? 1) : 1,
      });
    }

    /* --- 触发判定 --- */
    timer += dt;
    const threshold = fired === 0 ? RANDOM_EVENTS.firstDelaySec : RANDOM_EVENTS.intervalSec;
    if (timer < threshold) return null;
    timer = 0;
    // 已经有一个事件在跑时不叠加，避免"停电 + 高峰"同时压下来直接劝退玩家
    if (state.powerOutUntil != null || state.surgeUntil != null) return null;
    if (rnd() >= RANDOM_EVENTS.chance) return null;

    const type = pickType();
    const res = fire(type, ctx);
    if (res.ok) fired += 1;
    return res.ok ? type : null;
  }

  /** 停电 / 高峰期间的状态查询（main 与 HUD 用） */
  function status() {
    const now = numOr(state.wallElapsed, 0);
    return {
      powerOut: state.powerOutUntil != null && now < state.powerOutUntil,
      powerLeft: state.powerOutUntil != null ? Math.max(0, state.powerOutUntil - now) : 0,
      surge: state.surgeUntil != null && now < state.surgeUntil,
      surgeLeft: state.surgeUntil != null ? Math.max(0, state.surgeUntil - now) : 0,
    };
  }

  return {
    update, status, fire,
    reset() { timer = 0; fired = 0; },
    setEnabled(v) { enabled = v !== false; },
    get enabled() { return enabled; },
  };
}

export { RANDOM_EVENTS };
