/**
 * 存档 / 读档系统
 *
 * ── 为什么单独成模块 ──────────────────────────────────────
 * 存档要横跨 5 个互不相识的子系统（state / worldState / npcs / dayNight / player）。
 * 如果让每个子系统自己写 localStorage，就会出现 5 份键名、5 套版本、5 个出错点，
 * 而且"读档后只恢复了一半"这种最难查的问题会频繁出现。
 * 所以这里做**唯一的一层编排**：只负责 gather / validate / distribute，
 * 每个子系统只要提供 serialize() / hydrate() 即可，不需要知道自己被存档了。
 *
 * ── 三条硬性设计约束 ──────────────────────────────────────
 * 1) **不能因为存档让游戏崩**。存档发生在自动存档 tick 里，若它抛异常，
 *    rAF 主循环会每帧报错（虽然 main 有兜底，但会刷屏）。
 *    所以 buildSave/applySave 全程 try-catch，任何一段读不出来就跳过那一段。
 * 2) **不能把 mesh / 函数写进 JSON**。state.customers 里带 THREE 对象引用，
 *    直接 JSON.stringify(state) 会抛循环引用 → 因此 state 用**白名单字段**导出，
 *    而不是整体序列化（这是本模块最容易被后人"优化"掉的地方，别改）。
 * 3) **读档必须容错**。旧存档、手改坏的存档、版本不匹配的存档都不能让游戏起不来，
 *    校验失败就当作"没有存档"，走新游戏流程。
 *
 * ── 纯逻辑、零 DOM/THREE 依赖 ─────────────────────────────
 * storage 由外部注入（默认 localStorage，不可用时退化内存），因此可在 Node 里单测。
 */

/** localStorage 键名。改结构时**升版本号**而不是改键名 —— 旧键名留着能做迁移 */
export const SAVE_KEY = 'nightshift.save.v1';

/**
 * 按账号隔离的存档键。
 *
 * ── 为什么必须隔离 ──────────────────────────────────────────
 * 三个内测账号原本共用 SAVE_KEY 这一份进度，于是"重开本账号"必然连带抹掉别人的进度，
 * 语义上是错的（重开是**账号级**动作，见 reset.mjs）。所以存档改为
 * `nightshift.save.v1.<accountId>`。
 *
 * ── 旧档怎么办（不能静默丢进度）──────────────────────────────
 * 已经在 SAVE_KEY 下存过档的玩家：createSaveManager().migrateLegacy() 会在
 * "本账号还没有档 + 旧全局档还在且有效"时把它**搬**过来（搬完删旧键）。
 * 于是第一个登录的账号继承旧进度，其余账号从零开始。
 *
 * @param accountId 账号 id；空（未登录 / 单机调试）时退回旧的全局键
 */
export function saveKeyFor(accountId) {
  const id = accountId === null || accountId === undefined ? '' : String(accountId).trim();
  return id ? `${SAVE_KEY}.${id}` : SAVE_KEY;
}

/** 存档结构版本：与 SAVE_KEY 的版本号保持一致，做一次冗余校验 */
export const SAVE_VERSION = 1;
/** 自动存档间隔（游戏秒） */
export const AUTOSAVE_SEC = 120;

/**
 * state.mjs 里**允许**持久化的字段（白名单）。
 * 未列出的字段一律不存 —— 尤其是 customers / hover / events，它们带 mesh 引用或运行时句柄。
 */
/** 导出给单测：新增存档字段时，白名单漏登记是最容易静默发生的错误之一，必须可断言 */
export const STATE_FIELDS = [
  /* 经济 */
  'cash', 'tokens', 'backroom', 'prices', 'upgrades', 'held', 'slots',
  /* 时间 / 流程 */
  'night', 'gameHour', 'wallElapsed', 'phase', 'paused',
  /* 统计 */
  'reputation', 'served', 'lostSales', 'revenue', 'earned', 'purchaseCost', 'loss', 'garbage',
  /* 顾客 / 事件 */
  'spawnedTonight', 'arrivalsTarget', 'blackoutUntil', 'rushUntil', 'rushActive',
  /* 店员状态（R1） */
  'clerk', 'mentalGainFromGames',
  /* 小游戏 */
  'minigamePlays', 'minigameSpend', 'minigameEarn', 'facilityPlays',
  /* 需求I 玩法叠加（全是纯数据，无 mesh 引用，可安全 JSON 化） */
  'deviceLevels', 'deviceMods', 'inventory', 'selectedItem', 'quest', 'expansions', 'expansion',
  /* 2026-10-06 块4：任务板（纯数据：卡面 + 进行中的任务 + 弃单冷却）。
   * 跨夜要保留 —— 玩家接了单就该接着做完，读档丢掉等于"接单是个陷阱"。 */
  'taskboard',
  /* 2026-10-06 块5：进货运输（在途单 / 门口货箱 / 手持箱）。
   * 在途单跨夜保留：读档后玩家仍应知道「还有一单在路上」；
   * 门口气箱与手持箱在 startNight 重置 —— 夜店里没人看门口。 */
  'delivery',
  'powerOutUntil', 'surgeUntil', 'posterUntil', 'vendingCooldown',
  /* 需求J：店员 / 仓库 / 设备库存（纯数据，无 mesh 引用，可安全 JSON 化） */
  'staff', 'warehouse', 'deviceStock',
  /* 成长线扩展（星级 / 主题 / 成就 / 定价 / 抉择 / 环境）—— 全是纯数据 */
  'star', 'starStreak',
  'themeId', 'themeNextId', 'intelNight',
  'achievements', 'achProgress',
  'priceMul', 'promoUntil',
  'choiceQueue', 'choiceLog', 'influenceUntilNight', 'influenceMul',
  'pendingNextNight', 'expiringTonight', 'jukeboxStyle',
  'ambient', 'ledger',
  /* 疲劳系统：玩家疲劳度（纯数据） */
  'playerFatigue',
  /* 代币出口：永久增益 / 限时券 / 主题情报（纯数据，读档后效果必须仍在） */
  'boons', 'buffCards', 'intel',
  /* 前台手机：点评 / 消息箱 / 跑腿 / 补救（全纯数据，无 mesh 引用） */
  'reviews', 'inbox', 'errand', 'errandsDoneTonight', 'remedy', 'badReviewStreak',
  /* 模块 4：二手市场（owned 跨夜保留）/ 常客脸谱（跨夜累积）；thief 每夜临时不存 */
  'secondHand', 'regularFaces',
  /* 任务6 CG：已弹过的 CG id 数组。存了才不会读档后把里程碑 CG 再弹一遍。
   * 纯字符串数组、无 mesh 引用；它只是"已弹"标记，绝不携带进度数据。 */
  'cgSeen',
];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const numOr = (v, d) => (Number.isFinite(v) ? v : d);

/* ==================== 存储层 ==================== */

/** 内存兜底存储：localStorage 被禁用（隐私模式 / 沙箱 iframe）时顶上 */
function makeMemoryStore() {
  const map = new Map();
  return {
    kind: 'memory',
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

/** 探测 localStorage 是否真的可写（有些环境存在对象但一写就抛） */
function probeLocalStorage() {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return null;
    const k = '__ns_probe__';
    ls.setItem(k, '1');
    ls.removeItem(k);
    return ls;
  } catch {
    return null;
  }
}

/**
 * 创建存档读写器。
 * @param storage 注入的存储（测试用假 localStorage；不传则自动探测）
 */
export function createSaveStore(storage) {
  const store = storage ?? probeLocalStorage() ?? makeMemoryStore();
  const kind = store === globalThis.localStorage ? 'localStorage' : (store.kind ?? 'injected');

  return {
    kind,
    /** 底层存储（测试注入 / 调试查看用） */
    store,

    /**
     * 读取并解析存档。
     * @returns { data, raw } | null —— 无存档 / 解析失败都返回 null（调用方当作"没存档"）
     */
    read(key = SAVE_KEY) {
      let raw = null;
      try {
        raw = store.getItem(key);
      } catch {
        return null;
      }
      if (raw == null || raw === '') return null;
      try {
        return { data: JSON.parse(raw), raw };
      } catch {
        return null;
      }
    },

    /**
     * 写入存档。
     * @returns { ok:boolean, reason?:string }
     */
    write(payload, key = SAVE_KEY) {
      try {
        store.setItem(key, JSON.stringify(payload));
        return { ok: true };
      } catch (e) {
        // 最常见：配额超限（QuotaExceededError）。不能让它冒泡到主循环。
        return { ok: false, reason: e?.name === 'QuotaExceededError' ? 'quota' : 'write-failed' };
      }
    },

    /** 删除存档 */
    clear(key = SAVE_KEY) {
      try {
        store.removeItem(key);
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
  };
}

/* ==================== 组装存档 ==================== */

/**
 * 从各子系统收集存档数据。
 *
 * @param ctx.state       state.mjs 的单一真源
 * @param ctx.worldState  经营环境（设备 / 垃圾 / 洁净度）
 * @param ctx.npcs        NPC 系统（可为 null —— 未接入时跳过该段）
 * @param ctx.dayNight    昼夜轮换（可为 null）
 * @param ctx.player      玩家控制器（可为 null）
 * @param ctx.meta        附加元信息（如账号名）
 * @returns 纯数据对象（可直接 JSON.stringify）
 */
export function buildSave(ctx = {}) {
  const { state, worldState, npcs, dayNight, player, meta } = ctx;
  const out = {
    version: SAVE_VERSION,
    /** 墙钟时间戳：UI 显示"上次存档 xx:xx"用 */
    savedAt: Date.now(),
    sections: [],
  };

  /* --- 1. 玩家经济：金币 / 代币 --- */
  if (state) {
    const econ = {};
    for (const k of STATE_FIELDS) {
      if (state[k] === undefined) continue;
      try {
        // 结构化克隆一道：既能剔除 undefined/函数，也能顺带验证"这段能不能 JSON 化"
        econ[k] = JSON.parse(JSON.stringify(state[k]));
      } catch {
        // 单个字段坏了不该拖垮整份存档 —— 记下来，跳过它
      }
    }
    out.state = econ;
    out.sections.push('state');

    // 需求要求"金币、代币数量"单独可读（HUD / 存档面板直接取，不用翻 state）
    out.wallet = {
      cash: numOr(state.cash, 0),
      tokens: numOr(state.tokens, 0),
    };
  }

  /* --- 2. 设备状态（正常 / 故障 / 等待维修）+ 清洁状态 + 垃圾 --- */
  if (worldState && typeof worldState.serialize === 'function') {
    try {
      out.world = worldState.serialize();
      out.sections.push('world');
    } catch { /* 见约束 1 */ }
  }

  /* --- 3. 顾客 NPC 数量与站位 --- */
  if (npcs && typeof npcs.serialize === 'function') {
    try {
      const list = npcs.serialize();
      out.npcs = {
        count: Array.isArray(list) ? list.length : 0,
        items: list,
      };
      out.sections.push('npcs');
    } catch { /* 见约束 1 */ }
  }

  /* --- 4. 昼夜阶段 --- */
  if (dayNight && typeof dayNight.serialize === 'function') {
    try {
      out.dayNight = dayNight.serialize();
      out.sections.push('dayNight');
    } catch { /* 见约束 1 */ }
  }

  /* --- 5. 玩家坐标与朝向 --- */
  if (player && player.position) {
    const p = player.position;
    const look = typeof player.look === 'object' ? player.look : null;
    out.player = {
      x: numOr(p.x, 0),
      z: numOr(p.y ?? p.z, 0),
      yaw: numOr(look?.yaw, 0),
      pitch: numOr(look?.pitch, 0),
    };
    out.sections.push('player');
  }

  /* --- 派生快照：满意度数值（需求点名的存档项） --- */
  if (worldState && typeof worldState.satisfaction === 'function') {
    try {
      out.derived = {
        satisfaction: worldState.satisfaction(),
        cleanliness: numOr(worldState.cleanliness, 1),
        litterCount: Array.isArray(worldState.litter) ? worldState.litter.length : 0,
        brokenCount: typeof worldState.brokenCount === 'function' ? worldState.brokenCount() : 0,
      };
    } catch { /* 见约束 1 */ }
  }

  if (meta) out.meta = meta;
  return out;
}

/* ==================== 校验 ==================== */

/**
 * 校验一份存档是否可用。
 * 宁可严格一点判为无效（走新游戏），也不要带着半个坏存档进游戏 ——
 * 后者表现为"读档后某个数字变成 NaN"，极难定位。
 *
 * @returns { ok:boolean, reason?:string }
 */
export function validateSave(data) {
  if (!isObj(data)) return { ok: false, reason: 'not-object' };
  if (numOr(data.version, -1) !== SAVE_VERSION) return { ok: false, reason: 'version' };
  // 至少要有一段能恢复的内容，否则这份存档没有意义
  if (!Array.isArray(data.sections) || data.sections.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (isObj(data.wallet)) {
    if (!Number.isFinite(data.wallet.cash)) return { ok: false, reason: 'bad-cash' };
    if (!Number.isFinite(data.wallet.tokens)) return { ok: false, reason: 'bad-tokens' };
  }
  if (data.player != null && !isObj(data.player)) return { ok: false, reason: 'bad-player' };
  return { ok: true };
}

/* ==================== 应用存档 ==================== */

/**
 * 把存档写回各子系统。
 *
 * @param data 已校验的存档
 * @param ctx  与 buildSave 同构（缺少的子系统自动跳过）
 * @returns { ok:boolean, applied:string[], skipped:string[], reason?:string }
 */
export function applySave(data, ctx = {}) {
  const check = validateSave(data);
  if (!check.ok) return { ok: false, applied: [], skipped: [], reason: check.reason };

  const { state, worldState, npcs, dayNight, player } = ctx;
  const applied = [];
  const skipped = [];

  /* --- 经济与流程 --- */
  if (state && isObj(data.state)) {
    for (const k of STATE_FIELDS) {
      if (data.state[k] === undefined) continue;
      // slots 是数组：整段替换（长度可能因为升级变化）
      state[k] = data.state[k];
    }
    // 运行时句柄一律重置：它们带 mesh 引用，读档时必须重新生成
    state.customers = [];
    state.queue = [];
    state.hover = null;
    state.busyUntil = null;
    state.minigameId = null;
    state.pointerLockBlocked = false;
    applied.push('state');
  } else if (state) {
    skipped.push('state');
  }

  /* --- 设备 / 垃圾 / 洁净度 --- */
  if (worldState && typeof worldState.hydrate === 'function' && isObj(data.world)) {
    try {
      worldState.hydrate(data.world);
      applied.push('world');
    } catch {
      skipped.push('world');
    }
  } else if (worldState) {
    skipped.push('world');
  }

  /* --- NPC --- */
  if (npcs && typeof npcs.hydrate === 'function') {
    const items = isObj(data.npcs) ? data.npcs.items : null;
    if (Array.isArray(items)) {
      try {
        npcs.hydrate(items);
        applied.push('npcs');
      } catch {
        skipped.push('npcs');
      }
    } else {
      // 存档里没有 NPC 段（老存档）：清场比留着旧人更符合"回到存档时刻"
      try {
        npcs.hydrate([]);
        applied.push('npcs');
      } catch { skipped.push('npcs'); }
    }
  }

  /* --- 昼夜 --- */
  if (dayNight && typeof dayNight.hydrate === 'function' && isObj(data.dayNight)) {
    try {
      dayNight.hydrate(data.dayNight);
      applied.push('dayNight');
    } catch {
      skipped.push('dayNight');
    }
  }

  /* --- 玩家坐标 --- */
  if (player && isObj(data.player)) {
    try {
      if (typeof player.setPosition === 'function') {
        player.setPosition(data.player.x, data.player.z);
      }
      if (typeof player.setLook === 'function') {
        player.setLook(data.player.yaw, data.player.pitch);
      }
      applied.push('player');
    } catch {
      skipped.push('player');
    }
  }

  return { ok: applied.length > 0, applied, skipped };
}

/* ==================== 自动存档计时器 ==================== */

/**
 * 自动存档计时器：按**游戏秒**累计（暂停 / 小游戏中不计，避免挂机刷存档）。
 *
 * @param opts.intervalSec 间隔（默认 AUTOSAVE_SEC）
 * @param opts.onSave      () => void 触发保存（由外部决定存什么、怎么提示）
 * @param opts.shouldTick  () => boolean 是否该计时（暂停时返回 false）
 */
export function createAutoSaver(opts = {}) {
  const intervalSec = numOr(opts.intervalSec, AUTOSAVE_SEC);
  const onSave = opts.onSave ?? (() => {});
  const shouldTick = opts.shouldTick ?? (() => true);

  let acc = 0;
  let count = 0;
  let enabled = true;

  return {
    /** 每帧调用；dt 为**游戏**秒（不是墙钟秒 —— 暂停时调用方直接不调用即可） */
    tick(dt) {
      if (!enabled || !shouldTick() || !(dt > 0)) return false;
      acc += dt;
      if (acc < intervalSec) return false;
      acc -= intervalSec;
      count += 1;
      try {
        onSave(count);
      } catch {
        // 保存失败也不能打断主循环（见约束 1）
        return false;
      }
      return true;
    },
    /** 距下次自动存档还剩多少游戏秒（HUD 可显示） */
    get remain() { return Math.max(0, intervalSec - acc); },
    get count() { return count; },
    get intervalSec() { return intervalSec; },
    /** 手动存档后重置计时，避免"刚手动存完 2 秒又自动存" */
    reset() { acc = 0; },
    setEnabled(v) { enabled = v !== false; },
    get enabled() { return enabled; },
  };
}

/* ==================== 组合入口（main.mjs 用这一层） ==================== */

/**
 * 创建存档管理器：把"存储 + 组装 + 应用 + 自动存档"串成一个对象。
 * main.mjs 只需要 save() / load() / tick(dt)。
 *
 * @param opts.ctx         与 buildSave 同构的引用集合
 * @param opts.store       注入存储（测试用）
 * @param opts.storageKey  键名，或 `() => 键名`（按账号切换用，见 saveKeyFor）
 * @param opts.onResult    (kind:'save'|'load', res) 回调，供 main 弹提示
 */
export function createSaveManager(opts = {}) {
  const store = createSaveStore(opts.store);
  /* storageKey 可以是字符串，也可以是**函数** —— 后者用于"按账号切换存档键"：
   * 本管理器在登录之前就被创建了，只有真正读写的那一刻才知道当前是谁，
   * 所以必须每次调用时求值，不能提前 bind 成常量。 */
  const keyOf = typeof opts.storageKey === 'function'
    ? opts.storageKey
    : () => opts.storageKey ?? SAVE_KEY;
  const ctx = opts.ctx ?? {};
  const onResult = opts.onResult ?? (() => {});

  const auto = createAutoSaver({
    intervalSec: opts.autosaveSec ?? AUTOSAVE_SEC,
    shouldTick: opts.shouldTick ?? (() => true),
    onSave: (n) => {
      const res = writeSave();
      onResult('autosave', res, n);
    },
  });

  /** 组装 + 落盘 */
  function writeSave() {
    const payload = buildSave(ctx);
    const w = store.write(payload, keyOf());
    return { ...w, payload, at: payload.savedAt };
  }

  return {
    store,
    auto,

    /** 当前实际使用的存档键（诊断 / 探针用；按账号隔离后它会随登录变化） */
    get storageKey() { return keyOf(); },

    /** 立即存档（F5 / 自动存档共用） */
    save() {
      const res = writeSave();
      auto.reset();
      onResult('save', res);
      return res;
    },

    /**
     * 读取并应用存档。
     * @returns { ok, reason?, applied, skipped, data }
     */
    load() {
      const got = store.read(keyOf());
      if (!got) {
        const res = { ok: false, reason: 'no-save', applied: [], skipped: [] };
        onResult('load', res);
        return res;
      }
      const applied = applySave(got.data, ctx);
      const res = { ...applied, data: got.data };
      onResult('load', res);
      return res;
    },

    /** 只查有没有可用存档（开局决定"读档还是新游戏"用），不改动任何状态 */
    peek() {
      const got = store.read(keyOf());
      if (!got) return { ok: false, reason: 'no-save' };
      const v = validateSave(got.data);
      return v.ok ? { ok: true, data: got.data } : { ok: false, reason: v.reason };
    },

    /** 清档（新游戏 / 重开时调用，避免旧存档又被自动读回来） */
    clear() {
      return store.clear(keyOf());
    },

    /**
     * 把旧版"全局存档"搬给当前账号（一次性，见 saveKeyFor 的注释）。
     *
     * 只在「目标键还没有档 + 旧全局键有可用档」时才搬 —— 否则会把玩家
     * 已经玩出来的新进度覆盖掉，那是比不迁移严重得多的 bug。
     *
     * @param from 旧键名（默认全局键）
     * @returns {{ok:boolean, moved?:boolean, reason?:string}}
     */
    migrateLegacy(from = SAVE_KEY) {
      const to = keyOf();
      if (to === from) return { ok: false, reason: 'same-key' };        // 未登录，无需迁移
      if (store.read(to)) return { ok: false, reason: 'already-has' };  // 本账号已有自己的档
      const legacy = store.read(from);
      if (!legacy) return { ok: false, reason: 'no-legacy' };
      if (!validateSave(legacy.data).ok) return { ok: false, reason: 'legacy-invalid' };
      const w = store.write(legacy.data, to);
      if (!w.ok) return { ok: false, reason: 'write-failed' };
      store.clear(from);
      return { ok: true, moved: true };
    },

    /** 每帧推进自动存档（传**游戏**秒） */
    tick(dt) {
      return auto.tick(dt);
    },
  };
}
