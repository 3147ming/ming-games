/**
 * 经营环境状态（需求G 第③④⑤条的共享底座）
 *
 * 三个需求背后是同一件事：「店铺的物理与运营状态」。
 *   · 第③条 NPC 系统 —— 顾客会避开故障设备、被脏乱劝退
 *   · 第④条 维修系统 —— 设备随机故障、停摆、花钱修
 *   · 第⑤条 清洁系统 —— 垃圾随时间刷新、地面变脏、清理提升满意度
 * 三者互相耦合（脏乱 → 满意度低 → 顾客少 → 顾客少来玩 → 设备收入低），
 * 所以放在同一个模块里，共享一份状态与一套派生指标。
 *
 * ── 架构定位（遵守 ADR-002：state.mjs 是单一真源） ────────
 * 本模块**不是**第二份 state。它是"环境侧"的运行时状态，
 * 由 main.mjs 每帧 step() 推进，并可通过 snapshot() 导出为纯数据供 HUD 渲染。
 * 持久化字段（跨夜保留的）由 main.mjs 决定写回 state.mjs。
 *
 * ── 纯逻辑、零 THREE 依赖 ────────────────────────────────
 * 本模块不 import three，也不碰 DOM —— 因此可以在 Node 里完整单测。
 * 视觉表现（垃圾模型、故障闪烁）由 scene.mjs 根据 snapshot 去画。
 */

import { BREAKDOWN, CLEANLINESS, NPC } from './art.mjs';
import { FACILITIES } from './config.mjs';

/** 确定性随机（同 seed 同序列，便于测试与复盘） */
function makeRng(seed = 1) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 从 [min, max] 区间取随机值 */
function range(r, pair) {
  return pair[0] + r() * (pair[1] - pair[0]);
}

/**
 * 创建经营环境。
 * @param opts.seed   随机种子
 * @param opts.onEvent 回调 (type, payload) —— 用于 HUD 弹提示（故障/扣款/清理）
 * @param opts.breakMul  (id) => number 该设备的故障率倍率（需求I：等级 / 降噪模块）
 * @param opts.repairMul (id) => number 该设备的维修费倍率（需求I：等级 / 严重损坏）
 *         两者缺省为 1 —— 不接入成长系统时行为与需求G 完全一致。
 */
export function createWorldState(opts = {}) {
  const rnd = makeRng(opts.seed ?? 20260919);
  const onEvent = opts.onEvent ?? (() => {});
  const breakMulOf = typeof opts.breakMul === 'function' ? opts.breakMul : () => 1;
  const repairMulOf = typeof opts.repairMul === 'function' ? opts.repairMul : () => 1;

  /** 设备运行时状态：id → { broken, downUntil, repairs, flicker, earnings } */
  const devices = new Map();
  /** 垃圾生成计时 */
  let litterAccum = 0;
  /** 上一次 update 传入的散落点生成器（供 spawnLitter 在 update 之外使用） */
  let lastScatter = null;

  /**
   * 外部调制值（需求I 第⑥条突发事件的注入口）。
   * 全部缺省为"无效果"，且**每帧由 incidents 重算**而不是触发时写一次 ——
   * 这样读档后即使事件计时器丢了，调制值也会跟着 state 自动对齐。
   */
  /* 两套调制值分开存，避免互相覆盖：
   *   mod   —— 突发事件（incidents.mjs）每帧写入：停电 / 客流高峰
   *   theme —— 夜间主题（themes.mjs）写入：周末狂欢夜垃圾与故障率同步上升
   * 之所以不能合并成一个：incidents 每帧无条件 setModifiers({litterMul: 1})，
   * 若主题也写同一个字段，主题的效果会在下一帧被抹掉（"设了没用"类 bug 最难查）。 */
  const mod = { satisfactionPenalty: 0, litterMul: 1 };
  const theme = { litterMul: 1, breakMul: 1 };

  /**
   * 可故障设备清单。
   * 只有"能产出收益"的设施才会坏 —— 坏一台钓鱼池比坏一株绿植有意义得多。
   * 从 config.FACILITIES 派生，保证新增设施自动纳入（配置化扩展原则）。
   */
  const deviceIds = FACILITIES.filter((f) => f.kind).map((f) => f.id);

  /** 环境状态 */
  const env = {
    /** 洁净度 0..1，1 = 全新 */
    cleanliness: CLEANLINESS.start,
    /** 场上垃圾：{ x, z, id } */
    litter: [],
    /** 累计清理次数 */
    cleaned: 0,
    /** 累计维修次数 */
    repaired: 0,
    /** 本夜因故障损失的钱（估算） */
    lostIncome: 0,
  };

  let litterSeq = 0;
  let elapsed = 0;

  for (const [idx, id] of deviceIds.entries()) {
    // 需求I 故障判定：按台独立累积（消费"等级/降噪"的倍率差异）。
    // phase 让各台错峰触发，避免"5 台同时炸"的波浪；resetForNight / repair 后重新套用同一相位。
    const phase = 0.9 * (1 - idx / Math.max(1, deviceIds.length - 1));
    devices.set(id, {
      id,
      broken: false,
      /** 剩余"最低停摆"时长（秒）；倒到 0 仍为 broken，只是进入 awaitingRepair */
      downFor: 0,
      /** 已过最低停摆、正在等玩家维修（UI 文案切换用） */
      awaitingRepair: false,
      /** 累计故障次数 */
      breakCount: 0,
      /** 当前闪烁相位 */
      flicker: 0,
      /** 最近一次故障的墙钟时间 */
      lastBreakAt: -1,
      /** 需求I：本台的故障判定累积（按台独立，才能消费"等级/降噪"的倍率差异） */
      phase,
      accum: phase,
      /** 需求I 第⑥条：严重损坏（机器大故障）→ 维修成本翻倍 */
      severe: false,
      severeMul: 1,
    });
  }

  /**
   * 故障设备可达性判断 —— 给 NPC 用（需求G 第③条"避开故障设备"）。
   * @param x,z 查询点
   * @param radius 检测半径（默认 art.NPC.avoidRadius）
   * @returns 命中的故障设备（没有则 null）
   */
  function brokenDeviceNear(x, z, radius = NPC.avoidRadius) {
    let best = null;
    let bestD = radius * radius;
    for (const f of FACILITIES) {
      const d = devices.get(f.id);
      if (!d || !d.broken) continue;
      const dx = f.x - x;
      const dz = f.z - z;
      const dd = dx * dx + dz * dz;
      if (dd <= bestD) { bestD = dd; best = f; }
    }
    return best;
  }

  /**
   * 派生指标：**满意度**。
   * 这是需求③④⑤耦合的核心 —— 脏乱与故障都压满意度，满意度压客流。
   * 口径：
   *   基础 1.0
   *   − 脏乱惩罚 (1 - cleanliness) × CLEANLINESS.satisfactionWeight
   *   − 故障惩罚 每台故障设备固定 −0.08（上限 −0.24，坏太多就崩盘）
   */
  function satisfaction() {
    let v = 1.0;
    v -= (1 - env.cleanliness) * CLEANLINESS.satisfactionWeight;
    const brokenCount = [...devices.values()].filter((d) => d.broken).length;
    v -= Math.min(3, brokenCount) * 0.08;
    // 需求I 第⑥条：停电事件期间满意度额外下降（事件结束由 incidents 归零）
    v -= mod.satisfactionPenalty;
    return Math.max(0, Math.min(1, v));
  }

  /**
   * 派生指标：**客流倍率**。
   *   cleanliness 低于 lowThreshold 后开始线性削减，最低到 minTrafficMul。
   *   故障也会小幅削客流（顾客看到坏机器会少来）。
   */
  function trafficMul() {
    const c = env.cleanliness;
    let m = 1;
    if (c < CLEANLINESS.lowThreshold) {
      const t = c / CLEANLINESS.lowThreshold;       // 0..1
      m = CLEANLINESS.minTrafficMul + (1 - CLEANLINESS.minTrafficMul) * t;
    }
    const brokenCount = [...devices.values()].filter((d) => d.broken).length;
    m *= Math.max(0.8, 1 - brokenCount * 0.05);
    return m;
  }

  return {
    /* ---------- 只读查询 ---------- */

    /** 某台设备是否故障 */
    /**
     * 立刻生成 n 件垃圾（抉择事件"小偷报复"用）。
     * 走的是与常规生成完全相同的散落点与容量上限 —— 不新造一条规则，
     * 所以"报复"只是"多几件垃圾"，不会把清洁系统玩坏。
     */
    spawnLitter(n = 1) {
      let made = 0;
      for (let i = 0; i < n; i++) {
        if (env.litter.length >= CLEANLINESS.maxLitter) break;
        const pos = lastScatter ? lastScatter(rnd) : null;
        if (!pos) break;
        env.litter.push({ id: `L${++litterSeq}`, x: pos.x, z: pos.z, bornAt: elapsed });
        onEvent('litter', { id: `L${litterSeq}` });
        made += 1;
      }
      return made;
    },

    isBroken(id) { return devices.get(id)?.broken === true; },
    /** 某台设备状态（可能为 undefined） */
    device(id) { return devices.get(id); },
    /** 全部设备状态的快照（数组） */
    deviceList() { return [...devices.values()]; },
    /** 故障设备数量 */
    brokenCount() { return [...devices.values()].filter((d) => d.broken).length; },
    /** 满意度 0..1 */
    satisfaction,
    /** 客流倍率（≤1） */
    trafficMul,
    /** 洁净度 */
    get cleanliness() { return env.cleanliness; },
    /** 垃圾列表（只读引用；渲染用） */
    get litter() { return env.litter; },
    /** 累计统计 */
    get stats() { return { cleaned: env.cleaned, repaired: env.repaired, lostIncome: env.lostIncome }; },
    /** 故障设备附近查询（NPC 用） */
    brokenDeviceNear,

    /**
     * 完整快照 —— HUD 渲染与测试断言的入口。
     * 返回纯数据，不含任何函数引用。
     */
    snapshot() {
      return {
        cleanliness: env.cleanliness,
        litterCount: env.litter.length,
        satisfaction: satisfaction(),
        trafficMul: trafficMul(),
        brokenCount: this.brokenCount(),
        devices: this.deviceList().map((d) => ({
          id: d.id, broken: d.broken, downFor: d.downFor,
          awaitingRepair: d.awaitingRepair, breakCount: d.breakCount,
          severe: d.severe === true, severeMul: d.severeMul ?? 1,
        })),
        stats: { ...this.stats },
      };
    },

    /* ---------- 推进 ---------- */

    /**
     * 每帧推进（main.mjs 的 step 里调用）。
     * @param dt   墙钟秒
     * @param ctx  { deviceActive: (id) => bool } —— 判断设备当前是否"正在被玩"
     */
    update(dt, ctx = {}) {
      if (!(dt > 0)) return;
      elapsed += dt;
      // 记住散落点生成器：抉择事件的"报复"需要在 update 之外立刻丢几件垃圾
      if (typeof ctx.scatterLitter === 'function') lastScatter = ctx.scatterLitter;

      /* --- 需求④ 故障：随机故障 → 停摆 → 等待维修 --- */
      // 用"每夜期望次数"折算成每秒概率，再乘以 dt 累积；
      // 这样帧率变化不影响故障期望（用累积器而非逐帧掷骰会更稳）
      //
      // 累积器**按台独立**（d.accum）：需求I 的等级/降噪模块是**单台**倍率，
      // 共用全局累积器就没法表达"这台 3 级机器更容易坏、那台装了降噪更稳"。
      // 单台速率 = 每夜期望次数 / 设备数 / 夜长 × 该台倍率 ——
      // 分母带设备数，保证"全场总故障次数"的期望与需求G 时期一致（倍率全为 1 时等价）。
      //
      // 另一个历史坑（保留注释以免重犯）：早先累积写在设备循环内且多台共用一个值，
      // 迭代顺序固定 → 总是第一台先坏，玩家只会看到同一台反复坏。
      const devCount = Math.max(1, devices.size);
      const baseRate = BREAKDOWN.failurePerNight / devCount / Math.max(1, this._nightSecHint ?? 480);
      // ctx.devicesPaused（停电事件）：已有故障继续走它的停摆倒计时与闪烁，
      // 但**不再累积新的故障** —— 否则停电结束会一次性炸掉一片，
      // 事件就从"暂停"变成了无法预期的随机惩罚。
      for (const d of devices.values()) {
        if (d.broken) {
          d.flicker += dt * BREAKDOWN.flickerHz;
          // downFor 是**最低停摆时长**（UI 用它做倒计时"还要硬等多久"）。
          // 倒到 0 之后设备依然是坏的 —— 修复只能靠玩家花钱，
          // 不会自动恢复（否则"花钱维修"这条需求就失去意义了）。
          // 到 0 时置 awaitingRepair，让 UI 能把文案从"故障中 12s"换成"等待维修"。
          if (d.downFor > 0) {
            d.downFor = Math.max(0, d.downFor - dt);
            if (d.downFor === 0) d.awaitingRepair = true;
          }
          continue;
        }
        if (ctx.devicesPaused) continue;
        // 玩家正在玩的那台不在手里坏掉（体验上非常糟）
        if (ctx.deviceActive && ctx.deviceActive(d.id)) continue;
        d.accum += dt * baseRate * Math.max(0, breakMulOf(d.id)) * theme.breakMul;
        if (d.accum >= 1) {
          d.accum -= 1;
          d.broken = true;
          d.breakCount += 1;
          d.downFor = range(rnd, [BREAKDOWN.minDownSec, BREAKDOWN.maxDownSec]);
          d.awaitingRepair = false;
          d.lastBreakAt = elapsed;
          d.flicker = 0;
          onEvent('breakdown', { id: d.id, downFor: d.downFor });
        }
      }

      /* --- 需求⑤ 清洁：垃圾刷新 + 洁净度衰减 --- */
      env.cleanliness = Math.max(0, env.cleanliness - CLEANLINESS.decayPerSec * dt);
      // 越脏越容易继续生成垃圾 → 形成"不管就越烂"的正反馈（经营压力）。
      // 正反馈系数取 0.4 而非 0.8：太高会让脏透后"每秒必出垃圾"，
      // 玩家清理速度追不上生成速度 → 直接躺平（负反馈失衡，玩法反而消失）。
      const dirt = 1 - env.cleanliness;
      litterAccum += dt * (1 / CLEANLINESS.litterIntervalSec)
        * (CLEANLINESS.litterChance + dirt * 0.4) * mod.litterMul * theme.litterMul;
      if (litterAccum >= 1) {
        litterAccum -= 1;
        if (env.litter.length < CLEANLINESS.maxLitter) {
          // 生成位置由上层注入的 scatter 决定（需要场景坐标，本模块不依赖场景）
          const pos = ctx.scatterLitter ? ctx.scatterLitter(rnd) : null;
          if (pos) {
            env.litter.push({ id: `L${++litterSeq}`, x: pos.x, z: pos.z, bornAt: elapsed });
            onEvent('litter', { id: `L${litterSeq}` });
          }
        }
      }

      /* --- 故障到时：如果一直没人修，到点自动"恢复"吗？ --- */
      // 设计选择：**不自动恢复**。故障必须由玩家花钱修（需求④明确"花钱维修"）。
      // downFor 只用来做 UI 倒计时与"最低停摆时长"的展示，
      // 修好之前设备一直停摆 —— 这才是经营压力。
    },

    /** 供 update 用的夜长提示（影响故障期望频率）；main 在开局设定 */
    setNightSeconds(sec) { this._nightSecHint = sec; },

    /* ---------- 玩家操作 ---------- */

    /**
     * 修理一台设备（需求④）。
     * @param {string} id   设备 id
     * @param {number} wallet 玩家现金（校验是否付得起）
     * @param {number} [costOverride] 可选维修费覆盖（QTE 成功后的折扣价）。
     *        不传时用 repairCost(id) 的常规报价 —— 店员代修 / 直接修 / 快速维修包路径不变。
     * @returns { ok, cost, reason }
     */
    repair(id, wallet, costOverride) {
      const d = devices.get(id);
      if (!d || !d.broken) return { ok: false, reason: 'not-broken', cost: 0 };
      const cost = Number.isFinite(costOverride) ? Math.max(1, costOverride) : this.repairCost(id);
      if (typeof wallet === 'number' && wallet < cost) {
        return { ok: false, reason: 'insufficient', cost };
      }
      d.broken = false;
      d.downFor = 0;
      d.awaitingRepair = false;
      d.flicker = 0;
      d.accum = d.phase;
      // 严重损坏修好后要摘掉标记，否则这台机器此后永远按"大故障"收费
      d.severe = false;
      d.severeMul = 1;
      env.repaired += 1;
      onEvent('repair', { id, cost });
      return { ok: true, cost };
    },

    /** 维修费 = 该设备一次游玩的成本 × repairCostMul × 成长倍率 × 严重损坏倍率（至少 ¥1） */
    repairCost(id) {
      const f = FACILITIES.find((x) => x.id === id);
      // 各设施成本在 MINIGAME 里，但这里不想依赖 MINIGAME 的内部结构；
      // 用设施序号派生的稳定基数即可（保证同 id 每次报价一致，玩家不会看到跳动）
      const base = f ? (f.kind === 'fishing' ? 6 : 8) : 8;
      const d = devices.get(id);
      const severe = d?.severe ? (d.severeMul ?? 1) : 1;
      return Math.max(1, Math.ceil(base * BREAKDOWN.repairCostMul * repairMulOf(id) * severe));
    },

    /**
     * 需求I 第⑥条「机器大故障」：一台设备直接严重损坏，维修成本更高。
     * 与普通故障的差别只有 severe 标记（维修费 × mul）与更长的停摆时长 ——
     * 刻意**不新增第三种设备状态**，避免 HUD / NPC / 存档都要跟着加分支。
     * @param id      设备 id
     * @param mul     维修费倍率
     * @param downFor 停摆时长（不给则用 maxDownSec）
     */
    severeBreak(id, mul = 2, downFor) {
      const d = devices.get(id);
      if (!d) return { ok: false, reason: 'missing' };
      if (d.broken) return { ok: false, reason: 'already-broken' };
      d.broken = true;
      d.severe = true;
      d.severeMul = Math.max(1, mul);
      d.breakCount += 1;
      d.downFor = Math.max(0, downFor ?? BREAKDOWN.maxDownSec);
      d.awaitingRepair = false;
      d.lastBreakAt = elapsed;
      d.flicker = 0;
      d.accum = d.phase;
      onEvent('breakdown', { id, downFor: d.downFor, severe: true });
      return { ok: true, id, severeMul: d.severeMul };
    },

    /** 严重损坏标记查询（HUD 要把"大故障"的维修费单列出来提示玩家） */
    isSevere(id) {
      return devices.get(id)?.severe === true;
    },

    /**
     * 需求I 第⑥条的事件调制入口（停电的满意度惩罚 / 客流高峰的垃圾增速）。
     * 由 incidents.mjs **每帧**调用，因此读档后即使事件计时丢失也会自动对齐。
     */
    setModifiers(next = {}) {
      if (Number.isFinite(next.satisfactionPenalty)) mod.satisfactionPenalty = next.satisfactionPenalty;
      if (Number.isFinite(next.litterMul)) mod.litterMul = Math.max(0, next.litterMul);
    },

    /** 当前调制值（HUD / 测试用） */
    get modifiers() { return { ...mod }; },

    /**
     * 夜间主题的调制入口（垃圾速度 / 故障率）。
     * 与 setModifiers 分开：见上方 mod / theme 的注释。
     * 只写传进来的字段，没传的保持原值（主题每帧全量传也没问题）。
     */
    setThemeModifiers(next = {}) {
      if (Number.isFinite(next.litterMul)) theme.litterMul = Math.max(0, next.litterMul);
      if (Number.isFinite(next.breakMul)) theme.breakMul = Math.max(0, next.breakMul);
    },

    /** 当前主题调制值 */
    get themeModifiers() { return { ...theme }; },

    /**
     * 需求I 第⑦条：店铺扩建后注册新设备。
     * 既有 5 台设备在构造时就已建好，这里是**纯追加** —— 不触碰既有条目，
     * 因此"不改动原有逻辑"这条硬约束在设备层也成立。
     */
    registerDevices(ids) {
      const added = [];
      for (const id of ids ?? []) {
        if (devices.has(id)) continue;
        devices.set(id, {
          id, broken: false, downFor: 0, awaitingRepair: false, breakCount: 0,
          flicker: 0, lastBreakAt: -1, phase: 0, accum: 0, severe: false, severeMul: 1,
        });
        added.push(id);
      }
      return added;
    },

    /**
     * 清理一件垃圾（需求⑤）。玩家走到垃圾旁边按 E。
     * @returns { ok, gain, reason }
     */
    clean(id) {
      const i = env.litter.findIndex((l) => l.id === id);
      if (i < 0) return { ok: false, reason: 'missing', gain: 0 };
      // 取出被删的那一件：事件里要带上坐标，表现层才能在"原位"爆纸屑
      const [removed] = env.litter.splice(i, 1);
      const before = env.cleanliness;
      env.cleanliness = Math.min(1, env.cleanliness + CLEANLINESS.cleanPerLitter);
      env.cleaned += 1;
      const gain = env.cleanliness - before;
      onEvent('clean', { id, gain, x: removed?.x ?? 0, z: removed?.z ?? 0 });
      return { ok: true, gain };
    },

    /** 清理**全部**垃圾（"打扫一次"批量操作，代价是时间 —— 由上层扣时间） */
    cleanAll() {
      const n = env.litter.length;
      env.litter.length = 0;
      const before = env.cleanliness;
      env.cleanliness = Math.min(1, env.cleanliness + n * CLEANLINESS.cleanPerLitter);
      env.cleaned += n;
      if (n > 0) onEvent('clean', { id: '*', gain: env.cleanliness - before, all: true });
      return { ok: n > 0, count: n, gain: env.cleanliness - before };
    },

    /** 顾客离开时的额外脏乱（由 customers.mjs 或 main 调用） */
    onCustomerLeft() {
      env.cleanliness = Math.max(0, env.cleanliness - CLEANLINESS.decayPerCustomer);
    },

    /** 记录一次因故障损失的收益（统计用） */
    recordLost(amount) {
      if (amount > 0) env.lostIncome += amount;
    },

    /* ---------- 生命周期 ---------- */

    /** 新的一夜开始：清垃圾、恢复洁净度、修好设备（除非规范要求跨夜保留） */
    resetForNight() {
      env.cleanliness = CLEANLINESS.start;
      env.litter.length = 0;
      litterAccum = 0;
      for (const d of devices.values()) {
        d.flicker = 0;
        d.downFor = 0;
        d.awaitingRepair = false;
        d.accum = d.phase;
        if (!BREAKDOWN.persistAcrossNight) {
          d.broken = false;
          d.severe = false;
          d.severeMul = 1;
        }
      }
    },

    /**
     * **回到初始状态**（账号重开用，见 reset.mjs）。
     *
     * 与 resetForNight 的区别只有一点、但很关键：
     * resetForNight 是"进入下一夜"，它**刻意保留累计统计**（cleaned / repaired /
     * lostIncome 是整局的成绩单）；重开要的是"像刚开的新档"，
     * 所以这些累计量必须一并归零，否则重开后的结算/成就口径还带着上一世的数据。
     *
     * 设备与垃圾的复位直接复用 resetForNight —— 不另写一份，避免两处规则漂移。
     */
    resetAll() {
      this.resetForNight();
      env.cleaned = 0;
      env.repaired = 0;
      env.lostIncome = 0;
      mod.satisfactionPenalty = 0;
      mod.litterMul = 1;
      theme.litterMul = 1;
      theme.breakMul = 1;
    },

    /** 从存档/state.mjs 恢复（联机同步的扩展点） */
    hydrate(data) {
      if (!data) return;
      if (typeof data.cleanliness === 'number') env.cleanliness = data.cleanliness;
      if (Array.isArray(data.litter)) {
        env.litter.length = 0;
        for (const l of data.litter) env.litter.push({ ...l });
      }
      if (data.devices) {
        for (const [id, st] of Object.entries(data.devices)) {
          const d = devices.get(id);
          if (d) Object.assign(d, st);
        }
      }
    },

    /**
     * 导出可持久化/可同步的纯数据。
     * 这是给"联机预留"（需求C）用的：将来 host 把它广播给客户端，
     * 客户端 hydrate() 即可，无需改动本模块内部实现。
     */
    serialize() {
      return {
        cleanliness: env.cleanliness,
        litter: env.litter.map((l) => ({ id: l.id, x: l.x, z: l.z })),
        devices: Object.fromEntries([...devices.entries()].map(([id, d]) => [id, {
          broken: d.broken, downFor: d.downFor, awaitingRepair: d.awaitingRepair, breakCount: d.breakCount,
          severe: d.severe === true, severeMul: d.severeMul ?? 1,
          accum: d.accum, phase: d.phase,
        }])),
        stats: { ...this.stats },
      };
    },
  };
}

/** 需求G 第③④⑤条共享的常量再导出，方便调用方只 import 一处 */
export { NPC, CLEANLINESS, BREAKDOWN };
