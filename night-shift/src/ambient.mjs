/**
 * 环境互动（深夜猫 / 外卖员送货员 / 墙上老电视）
 *
 * ── 定位：氛围层，不进核心循环 ──────────────────────────
 * 三件事的共同点是"给玩家一个可做的事，但不做也不亏"：
 *   · 猫：摸一下 → 全场满意度短暂 +8（错过就错过）
 *   · 跑腿：接单 → 20 秒后到账一笔外快（不接也没损失）
 *   · 电视：换台 / 看一眼 → 一点点满意度（纯氛围）
 * 它们都不产生"必须响应"的压力，因此不会影响挂机玩法。
 *
 * ── 为什么满意度用"加上去再扣回来" ───────────────────────
 * "短暂提升"如果只改显示值，玩家在结算里看不到它的贡献，会觉得摸猫没用；
 * 如果只加不扣，摸几次猫就能把口碑顶到 100，星级成长线会直接失效。
 * 所以：立刻 +8，到期自动 -8（走 choices.mjs 同一套 repRestore 计时器思路），
 * 期间 HUD 上挂一个"+8"的小角标，玩家看得见它什么时候消失。
 *
 * ── 纯逻辑、零 DOM/THREE 依赖 ────────────────────────────
 * 猫 / 外卖员的位置由本模块算，mesh 由 scene 通过 setActor 回调摆放。
 */

export const AMBIENT = {
  cat: {
    /** 一夜里最多来几次 */
    maxVisits: 2,
    /** 首次出现时间窗（游戏小时） */
    fromHour: 1.5, toHour: 7,
    /** 停留时长（墙钟秒）—— 错过了就白来 */
    staySec: 75,
    /** 抚摸带来的满意度提升与持续时长 */
    rep: 8, buffSec: 90,
  },
  courier: {
    /** 一夜里最多来几次 */
    maxVisits: 2,
    fromHour: 1, toHour: 7,
    /** 门口等待时长（墙钟秒） */
    waitSec: 50,
    /** 跑腿小单：接单后多久到账（墙钟秒）与报酬区间 */
    errandSec: 20,
    pay: [35, 60],
  },
  tv: {
    /** 换台间隔（墙钟秒） */
    rotateSec: 90,
    /** 玩家看一眼 / 换台的满意度（很小，纯氛围） */
    rep: 2,
    cooldownSec: 30,
    programs: [
      { id: 'news', name: '深夜新闻', emoji: '📺' },
      { id: 'movie', name: '老电影重播', emoji: '🎬' },
      { id: 'mv', name: '音乐 MV', emoji: '🎵' },
      { id: 'football', name: '足球集锦', emoji: '⚽' },
      { id: 'ad', name: '深夜购物广告', emoji: '📢' },
    ],
  },
};

const numOr = (v, d = 0) => (Number.isFinite(v) ? v : d);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * @param {object} opts
 * @param {object} opts.state
 * @param {() => number} opts.rng
 * @param {object} opts.api { addRep, earnCash, toast, ledger, setActor }
 */
export function createAmbient(opts = {}) {
  const state = opts.state;
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const api = opts.api ?? {};

  const amb = () => {
    if (!state.ambient || typeof state.ambient !== 'object') {
      state.ambient = { cat: null, courier: null, tv: null, visits: { cat: 0, courier: 0 } };
    }
    return state.ambient;
  };

  const pick = (arr) => arr[Math.floor(rng() * arr.length)];

  /** 排今晚的到访时刻（游戏小时 → 由 main 在对应 gameHour 触发） */
  function planForNight() {
    const a = amb();
    a.visits = { cat: 0, courier: 0 };
    a.cat = null;
    a.courier = null;
    const plan = [];
    for (let i = 0; i < AMBIENT.cat.maxVisits; i++) {
      if (rng() < 0.75) {
        plan.push({ kind: 'cat', at: AMBIENT.cat.fromHour + rng() * (AMBIENT.cat.toHour - AMBIENT.cat.fromHour) });
      }
    }
    for (let i = 0; i < AMBIENT.courier.maxVisits; i++) {
      if (rng() < 0.7) {
        plan.push({ kind: 'courier', at: AMBIENT.courier.fromHour + rng() * (AMBIENT.courier.toHour - AMBIENT.courier.fromHour) });
      }
    }
    plan.sort((x, y) => x.at - y.at);
    a.plan = plan;
    // 电视：开局就有一个节目在播
    a.tv = { program: Math.floor(rng() * AMBIENT.tv.programs.length), until: 0, rotateAt: AMBIENT.tv.rotateSec, watchedAt: -999 };
    return plan;
  }

  /** 按当前游戏小时决定是否该出现（main 每帧调用） */
  function update(gameHour, wallElapsed) {
    const a = amb();
    let spawned = null;
    const plan = Array.isArray(a.plan) ? a.plan : [];

    for (const p of plan) {
      if (p.done || gameHour < p.at) continue;
      p.done = true;
      if (p.kind === 'cat') {
        if ((a.visits?.cat ?? 0) < AMBIENT.cat.maxVisits) {
          a.visits.cat = (a.visits?.cat ?? 0) + 1;
          a.cat = { until: wallElapsed + AMBIENT.cat.staySec, petted: false };
          spawned = 'cat';
          api.setActor?.('cat', { visible: true });
        }
      } else if (p.kind === 'courier') {
        if ((a.visits?.courier ?? 0) < AMBIENT.courier.maxVisits) {
          a.visits.courier = (a.visits?.courier ?? 0) + 1;
          const pay = Math.round(AMBIENT.courier.pay[0] + rng() * (AMBIENT.courier.pay[1] - AMBIENT.courier.pay[0]));
          a.courier = { until: wallElapsed + AMBIENT.courier.waitSec, order: null, pay, accepted: false };
          spawned = 'courier';
          api.setActor?.('courier', { visible: true });
        }
      }
    }

    // 到期离场
    if (a.cat && wallElapsed >= numOr(a.cat.until, 0)) {
      a.cat = null;
      api.setActor?.('cat', { visible: false });
    }
    if (a.courier && !a.courier.accepted && wallElapsed >= numOr(a.courier.until, 0)) {
      a.courier = null;
      api.setActor?.('courier', { visible: false });
    }
    // 跑腿完成
    if (a.courier?.order && wallElapsed >= numOr(a.courier.order.doneAt, 0)) {
      const pay = numOr(a.courier.pay, 0);
      api.earnCash?.(pay, '跑腿外快');
      api.ledger?.('ambient.errand', '跑腿外快', pay, 'ambient');
      api.setActor?.('courier', { visible: false });
      a.courier = null;
      spawned = 'errandDone';
    }
    // 电视换台
    if (a.tv && wallElapsed >= numOr(a.tv.rotateAt, 0)) {
      a.tv.program = Math.floor(rng() * AMBIENT.tv.programs.length);
      a.tv.rotateAt = wallElapsed + AMBIENT.tv.rotateSec;
    }
    return spawned;
  }

  /** 抚摸猫 */
  function petCat(wallElapsed) {
    const a = amb();
    if (!a.cat || a.cat.petted) return { ok: false, reason: '猫已经跑开了' };
    a.cat.petted = true;
    api.addRep?.(AMBIENT.cat.rep);
    // 到期自动扣回（短暂提升）
    scheduleRestore(-AMBIENT.cat.rep, wallElapsed + AMBIENT.cat.buffSec);
    if (!a.buff) a.buff = null;
    a.buff = { amount: AMBIENT.cat.rep, until: wallElapsed + AMBIENT.cat.buffSec };
    api.ledger?.('ambient.cat', '撸猫 · 满意度提升', 0, 'ambient');
    return { ok: true, rep: AMBIENT.cat.rep, until: a.buff.until };
  }

  /** 接下跑腿单 */
  function acceptErrand(wallElapsed) {
    const a = amb();
    if (!a.courier || a.courier.accepted) return { ok: false, reason: '没有等待接的单' };
    a.courier.accepted = true;
    a.courier.order = { doneAt: wallElapsed + AMBIENT.courier.errandSec };
    return { ok: true, pay: a.courier.pay, sec: AMBIENT.courier.errandSec };
  }

  /** 婉拒 */
  function declineErrand() {
    const a = amb();
    if (!a.courier) return { ok: false };
    a.courier = null;
    api.setActor?.('courier', { visible: false });
    return { ok: true };
  }

  /** 看电视 / 换台（带冷却，防站桩刷满意度） */
  function watchTv(wallElapsed) {
    const a = amb();
    if (!a.tv) return { ok: false };
    if (wallElapsed - numOr(a.tv.watchedAt, -999) < AMBIENT.tv.cooldownSec) {
      return { ok: false, reason: '刚看过 · 等一会' };
    }
    a.tv.watchedAt = wallElapsed;
    api.addRep?.(AMBIENT.tv.rep);
    scheduleRestore(-AMBIENT.tv.rep, wallElapsed + AMBIENT.tv.cooldownSec);
    return { ok: true, program: tvProgram(), rep: AMBIENT.tv.rep };
  }

  function tvProgram() {
    const a = amb();
    const list = AMBIENT.tv.programs;
    return list[clamp(numOr(a?.tv?.program, 0), 0, list.length - 1)] ?? list[0];
  }

  /** 满意度到期回退计时（与 choices 的 repRestore 同构，但独立存放，互不干扰） */
  function scheduleRestore(amount, at) {
    if (!Array.isArray(state.ambientRestore)) state.ambientRestore = [];
    state.ambientRestore.push({ amount, at });
  }

  function tick(wallElapsed) {
    const a = amb();
    const list = Array.isArray(state.ambientRestore) ? state.ambientRestore : [];
    const keep = [];
    for (const r of list) {
      if (wallElapsed >= numOr(r.at, 0)) api.addRep?.(numOr(r.amount, 0));
      else keep.push(r);
    }
    state.ambientRestore = keep;
    if (a.buff && wallElapsed >= numOr(a.buff.until, 0)) a.buff = null;
  }

  /** 当前生效的满意度加成（HUD 角标） */
  function satisfactionBonus() {
    const a = amb();
    return a?.buff ? numOr(a.buff.amount, 0) : 0;
  }

  return {
    planForNight, update, tick, petCat, acceptErrand, declineErrand, watchTv,
    tvProgram, satisfactionBonus,
    /** 供 interaction 判定"能不能按 E" */
    catHere() { const a = amb(); return !!a.cat && !a.cat.petted; },
    courierHere() { const a = amb(); return !!a.courier && !a.courier.accepted; },
    snapshot() {
      const a = amb();
      return {
        cat: !!a.cat,
        courier: a.courier ? { pay: a.courier.pay, accepted: a.courier.accepted } : null,
        tv: tvProgram(),
        bonus: satisfactionBonus(),
      };
    },
  };
}

export default createAmbient;
