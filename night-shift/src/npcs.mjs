/**
 * 漫游顾客 NPC 系统（需求G 第③条）
 *
 * ── 与 customers.mjs 的分工（重要，别混） ────────────────
 * customers.mjs = **购物顾客**：有明确需求（买某个 SKU），走 货架→排队→结账 的动线，
 *                 目的是驱动 SYS-01/02/03 的进货-销售-口碑循环。
 * npcs.mjs      = **漫游玩乐顾客**：没有购物需求，在广场/电玩区闲逛，
 *                 随机去玩小游戏并**主动付费**（给店主带来代币收益），
 *                 并且会**避开故障设备**、被脏乱劝退。
 * 两者并存、互不干涉：一个管"店内经营"，一个管"店外游乐场的人气"。
 *
 * ── 需求G 第③条的四项要求逐条落地 ──────────────────────
 *   ① 自动漫游      → 路点 + 随机停留（state.machine = wander）
 *   ② 随机游玩      → 到达设施后按 playChance 决定是否玩（state.machine = playing）
 *   ③ 游玩产生代币收益 → 游玩结束时回调 onRevenue(amount)，由 main 记账
 *   ④ 避开故障设备   → 选目标时查询 worldState.brokenDeviceNear()，命中就换目标
 *   ⑤ 脏乱降低满意度减客流 → 生成频率乘以 worldState.trafficMul()
 *
 * ── 分层 ────────────────────────────────────────────────
 * 本模块**依赖 THREE**（要建模型），但**不碰 DOM、不碰 state.mjs**。
 * 收益与事件通过回调交给 main.mjs —— 保持"系统只算、main 记账"的既有分层。
 */

import * as THREE from 'three';
import { ZONES, STORE, POND, FACILITIES as ALL_FACILITIES, CUSTOMER_TYPES } from './config.mjs';
import { NPC } from './art.mjs';

/** 可游玩设施（有 kind 的）——游玩收益只来自这些 */
const PLAYABLE = ALL_FACILITIES.filter((f) => f.kind && f.kind !== 'fishing');
/** 钓鱼池只有玩家能玩（NPC 站岸边钓会堵住玩家的钓位），所以排除 */

/**
 * 需求I 第⑤条：按权重抽一个顾客类型。
 * 类型差异化是"读得出来"的 —— 玩家能从场上人群构成判断该先修哪台机器、该不该打扫：
 *   · 小孩扎堆 → 抓娃娃机/弹珠机不能坏（坏了他们掉满意度最快）
 *   · 老人扎堆 → 场景必须干净（脏乱敏感 ×2）
 */
/**
 * @param r        随机数源
 * @param weightOf (typeId) => number 外部权重倍率（夜间主题用；不传 = 原样）
 *                 缺省 1 保证"没有主题时人群构成与扩展前完全一致"。
 */
function pickType(r, weightOf = null) {
  const w = (t) => Math.max(0.01, (t.weight ?? 1) * (weightOf ? weightOf(t.id) : 1));
  const total = CUSTOMER_TYPES.reduce((a, t) => a + w(t), 0);
  let x = r() * total;
  for (const t of CUSTOMER_TYPES) {
    x -= w(t);
    if (x <= 0) return t;
  }
  return CUSTOMER_TYPES[CUSTOMER_TYPES.length - 1];
}

function makeRng(seed = 7) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 在矩形区域内均匀取点 */
function pointIn(rect, r) {
  return {
    x: rect.minX + r() * (rect.maxX - rect.minX),
    z: rect.minZ + r() * (rect.maxZ - rect.minZ),
  };
}

/**
 * 可漫游区域列表。
 * 只取"室外三区 + 店内"，且必须避开池塘（NPC 走水里会很怪）。
 */
function wanderPoints(r) {
  const z = ZONES;
  const pool = [
    pointIn(z.plaza, r),
    pointIn(z.arcade, r),
    pointIn(z.rest, r),
    // 店内也允许 —— 顾客逛到店里看看是自然的
    { x: STORE.minX + 1 + r() * 3, z: STORE.minZ + 1 + r() * (STORE.maxZ - STORE.minZ - 2) },
  ];
  // 池塘避让：落在池内的点推出去
  const pts = pool.filter((p) => {
    const inPond =
      p.x > POND.x - POND.w / 2 - 0.6 && p.x < POND.x + POND.w / 2 + 0.6 &&
      p.z > POND.z - POND.d / 2 - 0.6 && p.z < POND.z + POND.d / 2 + 0.6;
    return !inPond;
  });
  return pts.length ? pts : [pointIn(z.plaza, r)];
}

/**
 * 创建 NPC 系统。
 *
 * @param scene       THREE.Scene
 * @param worldState  worldstate.mjs 的实例（读故障设备 / 客流倍率）
 * @param opts.createCharacter 角色工厂（默认用 character.mjs）
 * @param opts.onRevenue       回调 (amount, npc) —— NPC 游玩花钱带来的收益
 * @param opts.onEvent         回调 (type, payload) —— 供 HUD 提示
 * @param opts.playable        () => facility[] 当前可玩的设施（扩建后会变多；缺省用 config 的基础设施）
 * @param opts.attractMul      (id) => number 设备吸引力倍率（升级 / 彩灯模组）
 * @param opts.revenueMul      (id) => number 单次收益倍率（升级）
 * @param opts.playSecMul      (id) => number 游玩时长倍率（快充模块）
 *          三个倍率缺省为 1 —— 不接入成长系统时行为与需求G 完全一致。
 */
export function createNpcs(scene, worldState, opts = {}) {
  const rnd = makeRng(opts.seed ?? 7331);
  const createCharacter = opts.createCharacter;
  if (typeof createCharacter !== 'function') {
    throw new Error('createNpcs 需要 opts.createCharacter（角色工厂）');
  }
  const onRevenue = opts.onRevenue ?? (() => {});
  const onEvent = opts.onEvent ?? (() => {});
  const playableOf = typeof opts.playable === 'function' ? opts.playable : () => PLAYABLE;
  const attractOf = typeof opts.attractMul === 'function' ? opts.attractMul : () => 1;
  const revenueOf = typeof opts.revenueMul === 'function' ? opts.revenueMul : () => 1;
  const playSecOf = typeof opts.playSecMul === 'function' ? opts.playSecMul : () => 1;
  /* 夜间主题的两个注入口（缺省为"不改"，保证关掉主题后人群构成与扩展前一致）：
   *   typeWeightOf  (typeId) => number  顾客类型权重倍率（学生夜青年 ×2.2）
   *   preferKindsOf () => string[]|null 强制偏好的设施 kind（学生夜只想去跳舞机/赛车机） */
  const typeWeightOf = typeof opts.typeWeightOf === 'function' ? opts.typeWeightOf : null;
  const preferKindsOf = typeof opts.preferKindsOf === 'function' ? opts.preferKindsOf : null;

  /** 场上全部 NPC */
  const list = [];
  let spawnAcc = 0;
  /** 超编劝离的计时器 */
  let leaveAcc = 0;
  let seq = 0;
  let enabled = true;
  /** 停电中（需求 I ⑥ / P1-8）：全场 NPC 停止游玩、不再挑机器，已上机的起身去等待区 */
  let outage = false;

  /** 生成一个 NPC。@param startOverride 指定出生点（读档还原用；不给则随机从广场边缘进场） */
  function spawn(startOverride, typeOverride) {
    const type = typeOverride ?? pickType(rnd, typeWeightOf);
    const look = type.look ?? {};
    const char = createCharacter({
      seed: rnd(),
      type: type.id,
      // 外观差异化走 character.mjs 的 opt：体型 / 发色 / 服装 / 驼背
      scale: look.scale,
      hairPool: look.hair,
      clothPool: look.cloth,
      stoop: look.stoop === true,
    });
    const mesh = char.group;
    // 从广场边缘进场（不是凭空出现）
    const start = startOverride ?? { x: (rnd() - 0.5) * 10, z: opts.spawnZ ?? ZONES.plaza.maxZ - 0.3 };
    mesh.position.set(start.x, 0, start.z);
    scene.add(mesh);

    const npc = {
      id: `N${++seq}`,
      mesh,
      char,
      /** 需求I 第⑤条：顾客类型（儿童 / 青年 / 老年）—— 行为与收益全按它分化 */
      type,
      x: start.x,
      z: start.z,
      /** 行为机：wander → (maybe) playing → wander */
      machine: 'wander',
      /** 当前寻路目标 */
      tx: start.x,
      tz: start.z,
      /** 到达后还要停留多久（秒）；构造后按类型重算（见下方 idleSpan 调用） */
      idleLeft: 1 + rnd() * 2,
      /** 本次游玩还剩多久 */
      playLeft: 0,
      /** 正在玩的设施 id */
      playingAt: null,
      /** 已产生的累计收益 */
      paid: 0,
      /** 因为脏乱/故障想走了：连续多少次决策受阻 */
      unhappyCount: 0,
      /** 非游玩状态下的连续停留时长（秒）—— 用于"等待超过 10 秒"的头顶灰色"…"提示。
       *  只统计"站着不动、也没在玩"的时间：走路中会清零，所以它精确对应玩家的直觉"干等着"。 */
      waitT: 0,
    };
    npc.idleLeft = idleSpan(npc);
    list.push(npc);
    onEvent('npc-spawn', { id: npc.id, ctype: npc.type?.id });
    return npc;
  }

  /** 移除 NPC */
  function despawn(npc, reason) {
    scene.remove(npc.mesh);
    const i = list.indexOf(npc);
    if (i >= 0) list.splice(i, 1);
    onEvent('npc-leave', { id: npc.id, reason });
  }

  /**
   * 需求I 第⑤条：按顾客类型挑一台"他愿意玩"的设施。
   *
   * 两步筛选：
   *   ① 类型偏好 —— 儿童偏爱抓娃娃/弹珠机、青年偏爱弹珠/投篮、老年**只**玩售货机
   *      （onlyPrefer 的类型在偏好设施全部不可用时返回 null → 他这趟就不玩了，只闲逛）
   *   ② 吸引力加权 —— 升级与彩灯模组通过 attractMul 提高被选中的概率，
   *      于是"把热门机位升满级"会真的改变人群分布（升级的收益是看得见的）
   */
  function pickPlayFacility(npc) {
    const all = playableOf().filter((f) => f && !worldState.isBroken(f.id));
    if (all.length === 0) return null;

    const type = npc.type;
    /* 夜间主题可以**覆盖**类型偏好（学生夜：只想去跳舞机 / 赛车机）。
     * 主题偏好优先于类型偏好，因为主题是"今夜这一晚"的特殊性，而类型是长期倾向。 */
    const themePrefer = preferKindsOf?.() ?? null;
    const prefer = (themePrefer && themePrefer.length ? themePrefer : type?.prefer) ?? [];
    let pool = all;
    if (prefer.length) {
      const hit = all.filter((f) => prefer.includes(f.kind));
      if (hit.length) pool = hit;
      else if (type.onlyPrefer) return null;   // 老年顾客：场上没有售货机 → 这趟不玩
    }

    const weights = pool.map((f) => Math.max(0.01, attractOf(f.id)));
    let total = 0;
    for (const w of weights) total += w;
    let x = rnd() * total;
    let idx = weights.length - 1;
    for (let i = 0; i < weights.length; i++) {
      x -= weights[i];
      if (x <= 0) { idx = i; break; }
    }
    return pool[idx];
  }

  /**
   * 为 NPC 挑下一个目标点。
   * 这里是需求③「避开故障设备」的落点：先把候选设施按"是否有故障"过滤。
   *
   * 关键教训（实测踩到）：unhappyCount 是**连续受阻计数**，一旦成功选到目标
   * 就必须清零。否则 NPC 每次路过一台坏设备都+1、永不归零，
   * 最终所有 NPC 都被判"不满"而离场 —— 表现为"顾客一个都不玩就全走了"。
   */
  function pickTarget(npc) {
    const playChance = NPC.playChance * (npc.type?.playChanceMul ?? 1);
    // 停电中：所有设备停摆 → 谁也不挑机器（不新排队），改为纯闲逛
    const wantsPlay = !outage && rnd() < Math.min(1, playChance);

    if (wantsPlay) {
      const f = pickPlayFacility(npc);
      if (f) {
        // 站到设施正面（不是站在设施里）
        const stand = { x: f.x, z: f.z };
        if (f.rot !== undefined && Math.abs(f.rot) > 1) {
          // 朝西/朝东的柜体：正面在 x 方向让出 1.1m
          stand.x = f.x + (f.rot < 0 ? -1.1 : 1.1);
        } else {
          stand.z = f.z + (f.rot === 0 ? 1.1 : -1.1);
        }
        npc.tx = stand.x;
        npc.tz = stand.z;
        npc.pendingPlay = f.id;
        npc.machine = 'wander';
        npc.unhappyCount = 0;   // 成功选到目标 → 连续受阻清零
        return;
      }
      // 想玩但没得玩（设备全坏 / 偏好设施不可用）→ 记一次不满。
      // 儿童的不满增长更快（需求⑤"机器故障会快速掉满意度"）。
      npc.unhappyCount += Math.max(0, npc.type?.unhappyMul ?? 1);
    } else {
      // 这次本来就不想玩 → 不算受阻
      npc.unhappyCount = Math.max(0, npc.unhappyCount - 1);
    }

    // 连续受阻太多 → 决定离场（故障太多会真的流失客流）
    if (npc.unhappyCount >= 3 && rnd() < 0.5) {
      npc.wantLeave = true;
      return;
    }

    // 闲逛：随机取一个漫游点，但如果它落在故障设备附近就重抽（避开故障区）
    for (let attempt = 0; attempt < 6; attempt++) {
      const p = wanderPoints(rnd)[0];
      if (!worldState.brokenDeviceNear(p.x, p.z)) {
        npc.tx = p.x;
        npc.tz = p.z;
        npc.pendingPlay = null;
        npc.machine = 'wander';
        npc.unhappyCount = 0;   // 找到可去的地方 → 连续受阻清零
        return;
      }
    }

    // 6 次都撞上故障设备（坏得实在太多）→ 记为受阻，但**仍给一个目标点**，
    // 否则 NPC 会卡在原地不动（曾因为这里直接 return 而出现"站着不动"的僵尸 NPC）。
    const p = wanderPoints(rnd)[0];
    npc.tx = p.x;
    npc.tz = p.z;
    npc.pendingPlay = null;
    npc.machine = 'wander';
    npc.unhappyCount += 1;
  }

  /**
   * 漫游停留时长 —— 按顾客类型缩放（需求⑤：儿童停留短、老年停留久）。
   * stayMul 是**全局**加成（点唱机的"全场顾客停留 +15%"），默认 1 = 与原样一致。
   */
  let stayMul = 1;
  function idleSpan(npc) {
    const mul = (npc?.type?.idleSecMul ?? 1) * stayMul;
    return (NPC.idleSec[0] + rnd() * (NPC.idleSec[1] - NPC.idleSec[0])) * mul;
  }

  const tmp = new THREE.Vector3();

  return {
    /** 场上 NPC 数量 */
    get count() { return list.length; },
    /** NPC 列表（只读；渲染侧如需遍历） */
    get items() { return list; },
    /** 开关（暂停 / 低配时可以整体关掉） */
    setEnabled(v) { enabled = v; },
    get enabled() { return enabled; },

    /**
     * 每帧推进。
     * @param dt 墙钟秒
     * @param ctx { trafficMul?: number, incomeMul?: number } —— 由 main 传入
     *            昼夜/清洁带来的倍率（本模块不直接读 daynight，保持解耦）
     */
    update(dt, ctx = {}) {
      if (!enabled || !(dt > 0)) return;

      const trafficMul = ctx.trafficMul ?? 1;
      const incomeMul = ctx.incomeMul ?? 1;
      /** 点唱机 / 主题带来的"全场停留时长"加成（缺省 1 = 不变） */
      stayMul = Math.max(0.2, ctx.stayMul ?? 1);
      /** 需求I 第⑥条：停电 / 大故障场景下由 main 关掉"开始新游玩"（false = 不能玩） */
      const canPlay = ctx.canPlay !== false;
      outage = !canPlay;

      /* --- 生成：节奏受客流倍率影响（脏乱/白天 → 人变少） ---
       *
       * 这里有个**必须同时处理容量**的坑（实测踩到）：
       * 如果只把 trafficMul 作用在"生成间隔"上，会得到一个反直觉的结果 ——
       * 脏乱环境里 NPC 因为满意度低而快速离场，名额不断空出来，反而**生成得更频繁**；
       * 干净环境里 NPC 活得久、占满名额，新人进不来。
       * 于是"到店总人数"在脏乱时更高，正好与需求③（脏乱减少客流）相反。
       * 所以客流倍率必须**同时压制并存上限**，让"脏乱 = 场上人少"直接成立。
       */
      const liveCap = Math.max(2, Math.round(NPC.maxAlive * trafficMul));
      spawnAcc += dt * trafficMul;
      const interval = NPC.spawnIntervalSec / Math.max(0.15, trafficMul);
      while (spawnAcc >= interval) {
        spawnAcc -= interval;
        if (list.length < liveCap) spawn();
      }

      /* --- 超编劝离：客流下降后，场上的"多余" NPC 应当陆续散去 ---
       * 光压低生成频率不够 —— 已经站在场上的老人不会凭空消失，
       * 玩家会看到"明明脏得不行，人还是挤满"的矛盾画面。
       * 这里每秒钟按超出比例劝离一部分，让压力**看得见**。 */
      if (list.length > liveCap) {
        leaveAcc += dt;
        if (leaveAcc >= 1) {
          leaveAcc -= 1;
          const over = list.length - liveCap;
          // 一次最多劝离超编人数的 1/3，避免场面瞬间清空得很突兀
          const quota = Math.max(1, Math.ceil(over / 3));
          let n = 0;
          for (const npc of list) {
            if (n >= quota) break;
            if (npc.machine === 'playing' || npc.wantLeave) continue;
            npc.wantLeave = true;
            n += 1;
          }
        }
      } else {
        leaveAcc = 0;
      }

      /* --- 逐个推进行为机 --- */
      for (let i = list.length - 1; i >= 0; i--) {
        const npc = list[i];

        /* 申请离场（不满累积够了）：只设一次目标，之后交给下面的移动逻辑推进。
         * 注意别每帧都重置 tx/tz —— 那样 NPC 永远走不到边缘、也永远不被移除
         * （曾经写成每帧赋值，结果 leaving 状态的 NPC 无限期挂在场上）。 */
        if (npc.wantLeave && npc.machine !== 'leaving') {
          npc.machine = 'leaving';
          npc.pendingPlay = null;
          npc.tx = (npc.x > 0 ? 1 : -1) * (ZONES.plaza.maxX + 2);
          npc.tz = ZONES.plaza.maxZ + 1.5;
        }

        /* 停电（P1-8）：正在游玩 / 正走向机台的顾客一律起身离开，改去休息区等待；
         * 来电后 pickTarget 恢复挑机器，自然回到机台。只用一次状态切换触发，
         * 不会每帧重设目标点（否则顾客永远走不到、也永不离场）。 */
        if (outage && (npc.machine === 'playing' || npc.pendingPlay)) {
          npc.machine = 'wander';
          npc.playingAt = null;
          npc.pendingPlay = null;
          const wait = pointIn(ZONES.rest, rnd);
          npc.tx = wait.x;
          npc.tz = wait.z;
          npc.idleLeft = idleSpan(npc);
          npc.unhappyCount = 0;
          onEvent('npc-powerout-leave', { id: npc.id });
        }

        /* 游玩中：站着不动，倒计时结束就结算收益 */
        if (npc.machine === 'playing') {
          npc.char.update(dt, false, null);
          npc.waitT = 0;             // 在玩就不是"干等"
          npc.playLeft -= dt;
          if (npc.playLeft <= 0) {
            const [lo, hi] = NPC.playRevenue;
            // 需求I：收益 = 基础 × 昼夜倍率 × 设备等级倍率 × 顾客类型倍率
            const mul = incomeMul * revenueOf(npc.playingAt) * (npc.type?.revenueMul ?? 1);
            const amount = Math.round((lo + rnd() * (hi - lo)) * mul);
            npc.paid += amount;
            onRevenue(amount, npc);
            onEvent('npc-play', { id: npc.id, facility: npc.playingAt, amount });
            npc.playingAt = null;
            npc.machine = 'wander';
            npc.idleLeft = idleSpan(npc);
          }
          continue;
        }

        /* 移动：朝目标点走 */
        const dx = npc.tx - npc.x;
        const dz = npc.tz - npc.z;
        const dist = Math.hypot(dx, dz);

        if (dist > 0.25) {
          const step = Math.min(dist, NPC.speed * dt);
          npc.waitT = 0;             // 在走就不算"等"（走路中的停留只是路过）
          // 本帧起始位置（卡住检测的基准）
          const nx0 = npc.x;
          const nz0 = npc.z;
          const nx = npc.x + (dx / dist) * step;
          const nz = npc.z + (dz / dist) * step;

          // 绕开故障设备：**沿切向滑动**而不是径向外推。
          //
          // 曾经用"径向外推"（把 NPC 沿 设备→NPC 方向推出避让圈），结果是死锁：
          // 电玩区的 4 台设施挤在 x=9.4 一线，避让半径 2.2m 会把整条动线盖住；
          // NPC 被推出去、再走回来、再被推出去……永远到不了目标点，
          // 表现为"顾客一直在某条线上来回抖、一次都不玩"。
          //
          // 切向滑动才是真正的绕行：把"朝向目标的速度"投影掉法向分量、
          // 保留切向分量，NPC 就会贴着避让圈滑过去、最终绕过障碍。
          const blocker = worldState.brokenDeviceNear(nx, nz, NPC.avoidRadius);
          let fx = nx;
          let fz = nz;
          const headingToPlay = npc.pendingPlay != null
            && blocker != null && blocker.id === npc.pendingPlay;
          if (blocker && !headingToPlay) {
            const ax = nx - blocker.x;                    // 设备 → NPC（法向）
            const az = nz - blocker.z;
            const al = Math.hypot(ax, az) || 1;
            const nxu = ax / al;
            const nzu = az / al;
            // 把本帧位移沿法向的投影去掉，剩下的就是切向分量（绕行方向）
            const mx = (fx - npc.x);
            const mz = (fz - npc.z);
            const dot = mx * nxu + mz * nzu;
            // dot > 0 表示还在往圈里走 → 扣掉法向分量（贴边滑）
            const tanScalar = dot > 0 ? dot : 0;
            fx = npc.x + (mx - nxu * tanScalar);
            fz = npc.z + (mz - nzu * tanScalar);
            // 贴边：把位置拉回避让圈边界外一点点，避免因浮点误差卡在圈上
            const pad = NPC.avoidRadius + 0.05;
            const cx = fx - blocker.x;
            const cz = fz - blocker.z;
            const cl = Math.hypot(cx, cz) || 1;
            if (cl < pad) {
              fx = blocker.x + (cx / cl) * pad;
              fz = blocker.z + (cz / cl) * pad;
            }
          }
          npc.x = fx;
          npc.z = fz;
          npc.mesh.position.set(fx, 0, fz);
          npc.char.update(dt, true, Math.atan2(dx, dz));
          // 卡住检测：连续多帧几乎没位移，说明绕不过去 → 重新选目标，
          // 防止个别几何死角把 NPC 永久困住（比超时兜底更及时）。
          const moved = Math.hypot(fx - nx0, fz - nz0);
          if (moved < NPC.speed * dt * 0.25) {
            npc.stuckFrames = (npc.stuckFrames ?? 0) + 1;
            if (npc.stuckFrames > 40) {
              npc.stuckFrames = 0;
              npc.idleLeft = 0;
              pickTarget(npc);
            }
          } else {
            npc.stuckFrames = 0;
          }
          continue;
        }

        /* 到达目标：停留 → 决定下一步 */
        npc.char.update(dt, false, null);
        npc.idleLeft -= dt;
        if (npc.idleLeft > 0) { npc.waitT += dt; continue; }

        // 到了设施旁边 → 开始游玩
        if (npc.pendingPlay) {
          const fid = npc.pendingPlay;
          // 需求I 第⑥条：停电期间设备全部停摆 → 走到跟前也玩不了，改为继续闲逛
          if (canPlay === false) {
            npc.pendingPlay = null;
          } else {
            npc.pendingPlay = null;
            if (!worldState.isBroken(fid)) {
              npc.machine = 'playing';
              npc.playingAt = fid;
              // 游玩时长 = 基础 × 设备快充倍率 × 类型倍率（儿童玩得短、老年玩得久）
              npc.playLeft = (NPC.playSec[0] + rnd() * (NPC.playSec[1] - NPC.playSec[0]))
                * playSecOf(fid) * (npc.type?.playSecMul ?? 1);
              npc.unhappyCount = 0;
              onEvent('npc-start-play', { id: npc.id, facility: fid, ctype: npc.type?.id });
              continue;
            }
            // 走到一半坏了 → 直接换目标（这就是"避开故障设备"的动态版本）
            npc.unhappyCount += Math.max(0, npc.type?.unhappyMul ?? 1);
          }
        }

        // 满意度低时的离场判定（需求③：脏乱降低满意度 → 减少客流）
        // 只在"决策点"掷一次，避免每帧重复判定导致 NPC 集体瞬移离场。
        // 需求I 第⑤条：阈值与敏感度按类型分化 ——
        //   青年满意度下降缓慢（阈值 0.4）、老年对脏乱非常敏感（阈值 0.72 × 敏感 2.0）、
        //   儿童则是因为机器故障（上面的 unhappyMul）而不是脏乱才走。
        const sat = worldState.satisfaction();
        const thr = npc.type?.leaveSatThreshold ?? 0.5;
        const sens = npc.type?.dirtSensitive ?? 1;
        if (sat < thr && rnd() < NPC.leaveChanceLowSat * 0.25 * sens) {
          npc.wantLeave = true;
          continue;
        }

        pickTarget(npc);
      }

      /* --- 清理已离场的 --- */
      for (let i = list.length - 1; i >= 0; i--) {
        const npc = list[i];
        if (npc.machine !== 'leaving') continue;
        if (Math.abs(npc.x) > ZONES.plaza.maxX + 1.2 || npc.z > ZONES.plaza.maxZ + 1.0) {
          despawn(npc, npc.wantLeave ? 'unhappy' : 'done');
        }
      }
    },

    /** 清场（新的一夜 / 重置） */
    resetForNight() {
      for (const npc of [...list]) {
        scene.remove(npc.mesh);
      }
      list.length = 0;
      spawnAcc = 0;
      leaveAcc = 0;
      seq = 0;
    },

    /**
     * 连带顾客（KTV 的社交属性）：一次性放几位同类型顾客进场。
     * 数量受 liveCap 之外的硬上限保护 —— 避免"唱一首歌全场爆满"把性能与平衡一起冲掉。
     * @param n      人数
     * @param typeId 顾客类型 id（缺省走正常权重抽取）
     * @returns 实际生成的人数
     */
    spawnGuests(n = 1, typeId = null) {
      const want = Math.max(0, Math.min(6, Math.floor(n)));
      const type = typeId ? CUSTOMER_TYPES.find((t) => t.id === typeId) ?? null : null;
      let made = 0;
      for (let i = 0; i < want; i++) {
        if (list.length >= NPC.maxAlive + 4) break;
        try { spawn(null, type); made += 1; } catch { break; }
      }
      return made;
    },

    /** 派生统计（给 HUD / 测试） */
    stats() {
      const playing = list.filter((n) => n.machine === 'playing').length;
      const paid = list.reduce((a, n) => a + n.paid, 0);
      return { alive: list.length, playing, paid };
    },

    /** 导出可同步状态（联机预留，需求C；也是存档的 NPC 段） */
    serialize() {
      return list.map((n) => ({
        id: n.id, x: n.x, z: n.z, machine: n.machine, playingAt: n.playingAt,
        /** 需求I 第⑤条：顾客类型要跟着存档走 —— 否则读档后全场顾客类型会重新随机 */
        type: n.type?.id ?? null,
      }));
    },

    /**
     * 从存档还原 NPC（需求：读档后顾客数量与站位全部复原）。
     *
     * 注意 machine='playing' 的还原：playingAt 必须仍然指向一台**正常**设备，
     * 否则 NPC 会卡在"正在玩一台坏机器"的状态里 —— 读档时设备可能已经修好/又坏了，
     * 所以这里要按还原后的设备状态重新判定一次，坏掉就退回 wander。
     */
    hydrate(saved) {
      if (!Array.isArray(saved)) return;
      for (const npc of [...list]) scene.remove(npc.mesh);
      list.length = 0;
      spawnAcc = 0;
      leaveAcc = 0;
      seq = 0;

      for (const s of saved) {
        if (!s || typeof s !== 'object') continue;
        const x = Number.isFinite(s.x) ? s.x : (rnd() - 0.5) * 10;
        const z = Number.isFinite(s.z) ? s.z : (ZONES.plaza.maxZ - 0.3);
        // 类型按存档还原；老存档没有 type 字段时走随机（与新增字段前的行为一致）
        const savedType = CUSTOMER_TYPES.find((t) => t.id === s.type) ?? null;
        const npc = spawn({ x, z }, savedType);

        // id 尽量沿用存档值，保证"同一个顾客"在统计上连续
        if (typeof s.id === 'string' && s.id) {
          npc.id = s.id;
          const n = Number(s.id.replace(/^N/, ''));
          if (Number.isFinite(n) && n > seq) seq = n;
        }

        const canPlay = typeof s.playingAt === 'string'
          && s.playingAt
          && !worldState.isBroken(s.playingAt);
        npc.machine = s.machine === 'playing' && canPlay ? 'playing' : 'wander';
        npc.playingAt = npc.machine === 'playing' ? s.playingAt : null;
        npc.playLeft = npc.machine === 'playing'
          ? (NPC.playSec[0] + rnd() * (NPC.playSec[1] - NPC.playSec[0]))
            * playSecOf(npc.playingAt) * (npc.type?.playSecMul ?? 1)
          : 0;
        npc.tx = x;
        npc.tz = z;
        npc.idleLeft = idleSpan(npc);
        npc.unhappyCount = 0;
        npc.wantLeave = false;
      }
    },
  };
}
