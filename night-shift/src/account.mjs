/**
 * 账号系统 + 联机预留（需求B / 需求C）
 *
 * 设计目标：
 *   1) 内置 1/2/3 三个内测账号；首次进入自行设置密码，之后每次登录必须校验通过
 *   2) 密码做基本强度校验，明文不落盘（存的是加盐哈希）
 *   3) 为后续联机系统预留**清晰的接口与扩展点** —— 本阶段只留空实现，不真的联机
 *
 * 分层（关键：把"能换的实现"和"不换的契约"分开）
 *   ├ AccountStore       身份与凭据的持久化后端（当前：localStorage）  ← 联机时可换成服务端
 *   ├ AuthService        注册 / 登录 / 登出 / 会话，是 UI 唯一要打交道的门面
 *   ├ NetBridge          联机预留：账号校验 / 玩家身份 / 局内数据的空接口
 *   └ 纯函数 hash/verify 便于单测，不依赖 DOM / storage
 *
 * ADR-004 精神：零外部依赖。哈希是**本地内测用的轻量实现**，
 * 只为"不存明文"这一目标服务，**不是**密码学安全强度（见 hashPassword 注释）。
 */

/* ============================================================
 *  1. 内置内测账号（需求B：内置 1、2、3）
 * ========================================================== */
export const BUILTIN_ACCOUNTS = [
  { id: '1', name: '内测一号', tag: 'ALPHA-01', emoji: '①' },
  { id: '2', name: '内测二号', tag: 'ALPHA-02', emoji: '②' },
  { id: '3', name: '内测三号', tag: 'ALPHA-03', emoji: '③' },
];

export const ACCOUNT_BY_ID = Object.fromEntries(BUILTIN_ACCOUNTS.map((a) => [a.id, a]));

/** 密码规则（集中一处，UI 与校验共用，避免两端打架） */
export const PASSWORD_RULE = {
  minLen: 4,
  maxLen: 20,
  // 至少一个非空白字符，禁止全空格
  pattern: /^[^\s]+$/,
  hint: '4–20 位，不能包含空格',
};

/**
 * 校验密码是否合法。返回 { ok, reason }
 * 纯函数 —— 单测直接调，不碰 DOM。
 */
export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length === 0) {
    return { ok: false, reason: '请输入密码' };
  }
  if (pw.length < PASSWORD_RULE.minLen) {
    return { ok: false, reason: `密码至少 ${PASSWORD_RULE.minLen} 位` };
  }
  if (pw.length > PASSWORD_RULE.maxLen) {
    return { ok: false, reason: `密码最多 ${PASSWORD_RULE.maxLen} 位` };
  }
  if (!PASSWORD_RULE.pattern.test(pw)) {
    return { ok: false, reason: '密码不能包含空格' };
  }
  return { ok: true, reason: '' };
}

/* ============================================================
 *  2. 哈希（本地内测级）
 *
 *  说明：这里用 FNV-1a 变体 + 每账号随机盐 + 多轮迭代，目的是"**不存明文**"，
 *  而不是抵抗离线爆破 —— 纯前端 + 无后端的内测场景下，任何前端哈希都不具备
 *  密码学安全性（密钥一定在客户端）。真正的账号安全必须依赖服务端校验，
 *  这正是 NetBridge（需求C）要接的位置：联机后 verify 改由服务端完成。
 *  之所以不用 SubtleCrypto：它是异步的，会让登录流程与单测都变复杂，
 *  而这里的威胁模型（单机内测、3 个固定账号）用同步哈希足够。
 * ========================================================== */
const HASH_ROUNDS = 512;
const HASH_MOD = 0xFFFFFFFF;

/** 把字符串折叠成 32 位无符号整数（FNV-1a 变体） */
function fnv1a(str, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // 乘以 FNV prime (16777619)，用移位避免大数精度丢失
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** 生成随机盐（十六进制串） */
export function makeSalt(len = 4) {
  let s = '';
  for (let i = 0; i < len; i++) {
    s += Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  }
  return s;
}

/**
 * 加盐多轮哈希。返回十六进制串。
 * @param {string} password 明文密码
 * @param {string} salt     账号盐
 * @param {string} accountId 账号 id（参与哈希 → 同一密码在不同账号得到不同摘要）
 */
export function hashPassword(password, salt, accountId = '') {
  let h = fnv1a(`${salt}:${accountId}:${password}`);
  for (let r = 0; r < HASH_ROUNDS; r++) {
    // 每轮把上一轮结果、盐、轮数一起折叠，拉开雪崩效应
    h = fnv1a(`${h.toString(16)}|${salt}|${r}`, h);
  }
  return h.toString(16).padStart(8, '0');
}

/** 恒定时间比较（避免逐字符短路带来的时序侧信道 —— 本地场景意义有限，但成本极低） */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 校验密码是否匹配已存记录 */
export function verifyPassword(password, record) {
  if (!record || typeof record.salt !== 'string') return false;
  const got = hashPassword(password, record.salt, record.accountId ?? '');
  return safeEqual(got, record.hash);
}

/* ============================================================
 *  3. AccountStore —— 持久化后端（可替换）
 *     联机时把这里换成"服务端 API 客户端"，AuthService 无需改动。
 * ========================================================== */
const STORE_KEY = 'nightshift.accounts.v1';
const SESSION_KEY = 'nightshift.session.v1';

const memoryFallback = new Map();

/** 探测 localStorage 是否真的可用（隐私模式/沙箱 iframe 会抛异常） */
function storageAvailable() {
  try {
    const k = '__ns_probe__';
    window.localStorage.setItem(k, '1');
    window.localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

/**
 * 默认实现：localStorage；不可用时退化到内存（本次会话内仍可玩，刷新即忘）。
 * 无论哪种实现，都只暴露 get/set 两个方法 —— 后端可整体替换。
 */
export function createLocalStore() {
  const useLS = typeof window !== 'undefined' && storageAvailable();
  return {
    kind: useLS ? 'localStorage' : 'memory',
    get(key) {
      try {
        if (useLS) {
          const raw = window.localStorage.getItem(key);
          return raw ? JSON.parse(raw) : null;
        }
        return memoryFallback.has(key) ? JSON.parse(memoryFallback.get(key)) : null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        const raw = JSON.stringify(value);
        if (useLS) window.localStorage.setItem(key, raw);
        else memoryFallback.set(key, raw);
        return true;
      } catch {
        return false;
      }
    },
    remove(key) {
      try {
        if (useLS) window.localStorage.removeItem(key);
        else memoryFallback.delete(key);
      } catch { /* 忽略 */ }
    },
  };
}

/* ============================================================
 *  4. NetBridge —— 联机预留（需求C：只留空接口，不实现）
 * ========================================================== */

/**
 * 联机桥接占位。当前所有方法都是"本地模式"的空实现：
 *   - 不建立任何连接，不产生网络请求
 *   - 返回结果与单机行为一致，保证上层的调用点**今天就能写**，
 *     将来把实现替换掉即可，不必回头改 UI / 游戏逻辑
 *
 * 扩展点约定（将来接服务端时保持这些签名不变）：
 *   verifyCredentials(accountId, password) -> Promise<{ ok, token?, reason? }>
 *   fetchProfile(playerId)                 -> Promise<{ playerId, displayName, stats }>
 *   syncNightResult(playerId, summary)     -> Promise<{ ok }>
 *   fetchLeaderboard(scope)                -> Promise<Array<{ playerId, name, score }>>
 *   isOnline()                             -> boolean
 */
export function createNetBridge() {
  /** 当前是否处于联机模式 —— 本阶段恒为 false */
  let online = false;
  /** 本地模式下"服务端"就退化成 AccountStore 自己的校验，故这里只做转发 */
  return {
    get online() { return online; },

    /** 联机预留：账号校验（当前：不联网，交由本地 AuthService 处理） */
    async verifyCredentials() {
      // TODO(联机): 接服务端 POST /auth/login
      return { ok: false, reason: '离线模式：请使用本地账号登录', offline: true };
    },

    /** 联机预留：拉取玩家档案 */
    async fetchProfile() {
      // TODO(联机): 接服务端 GET /players/:id
      return null;
    },

    /** 联机预留：上报一局的结算数据 */
    async syncNightResult() {
      // TODO(联机): 接服务端 POST /nights
      return { ok: false, offline: true };
    },

    /** 联机预留：排行榜（本地排行由 leaderboard 模块提供） */
    async fetchLeaderboard() {
      // TODO(联机): 接服务端 GET /leaderboard
      return [];
    },

    /** 联机预留：连接状态（供 HUD 显示"离线/在线"） */
    isOnline() {
      return online;
    },

    /** 联机预留：由未来的连接管理器调用，切换在线状态 */
    _setOnline(v) {
      online = !!v;
    },
  };
}

/* ============================================================
 *  5. 玩家身份（需求C 的"玩家身份"扩展点）
 * ========================================================== */
/** 由账号推导出的稳定玩家身份 —— 联机后 playerId 应由服务端下发，本地先按 accountId 生成 */
export function makePlayerIdentity(account) {
  return {
    playerId: `local-${account.id}`,
    accountId: account.id,
    displayName: account.name,
    tag: account.tag,
    emoji: account.emoji,
    // 联机预留：服务端 token / 会话 id 将来填这里
    token: null,
  };
}

/* ============================================================
 *  6. AuthService —— UI 唯一门面
 * ========================================================== */
/**
 * @param {object} [opts]
 * @param {object} [opts.store]  持久化后端（默认 localStorage，可注入 mock 以便单测）
 * @param {object} [opts.net]    联机桥（默认离线）
 */
export function createAuthService({ store = createLocalStore(), net = createNetBridge() } = {}) {
  /* records: { [accountId]: { accountId, salt, hash, createdAt } } */
  function loadRecords() {
    return store.get(STORE_KEY) ?? {};
  }
  function saveRecords(records) {
    return store.set(STORE_KEY, records);
  }

  return {
    store,
    net,

    /** 账号是否已设置过密码（"首次进入自行设置"的判据） */
    isRegistered(accountId) {
      const r = loadRecords()[accountId];
      return !!(r && typeof r.hash === 'string');
    },

    /** 列出内置账号 + 各自是否已激活（供登录界面渲染） */
    listAccounts() {
      const records = loadRecords();
      return BUILTIN_ACCOUNTS.map((a) => ({
        ...a,
        registered: !!(records[a.id] && records[a.id].hash),
      }));
    },

    /**
     * 首次设置密码（注册）。已注册的账号应走 login，不该重复注册。
     * @returns {{ok:boolean, reason?:string, identity?:object}}
     */
    register(accountId, password) {
      const acc = ACCOUNT_BY_ID[accountId];
      if (!acc) return { ok: false, reason: '账号不存在' };
      if (this.isRegistered(accountId)) return { ok: false, reason: '该账号已设置过密码，请直接登录' };
      const v = validatePassword(password);
      if (!v.ok) return { ok: false, reason: v.reason };
      const salt = makeSalt();
      const hash = hashPassword(password, salt, accountId);
      const records = loadRecords();
      records[accountId] = { accountId, salt, hash, createdAt: Date.now() };
      saveRecords(records);
      const identity = makePlayerIdentity(acc);
      this._persistSession(identity);
      return { ok: true, identity };
    },

    /**
     * 登录。密码错误要给出可区分的提示并允许重试（由调用方控制重试次数）。
     * @returns {{ok:boolean, reason?:string, identity?:object}}
     */
    login(accountId, password) {
      const acc = ACCOUNT_BY_ID[accountId];
      if (!acc) return { ok: false, reason: '账号不存在' };
      const rec = loadRecords()[accountId];
      if (!rec) return { ok: false, reason: '该账号还没设置密码，请先设置' };
      const v = validatePassword(password);
      if (!v.ok) return { ok: false, reason: v.reason };
      if (!verifyPassword(password, rec)) return { ok: false, reason: '密码错误，请重试' };
      const identity = makePlayerIdentity(acc);
      this._persistSession(identity);
      return { ok: true, identity };
    },

    /**
     * 只校验密码、**不建立会话**。
     *
     * 与 login 的唯一区别就是"不写 SESSION_KEY"。用于重开（重置）这类
     * "要确认操作者确实是账号主人、但不该改变谁在登录"的场景
     * —— 见 reset.mjs 的 verifyPassword 注入点。
     * @returns {boolean}
     */
    verify(accountId, password) {
      const rec = loadRecords()[accountId];
      if (!rec) return false;
      if (!validatePassword(password).ok) return false;
      return verifyPassword(password, rec);
    },

    /** 当前会话（刷新页面后仍能自动恢复） */
    currentSession() {
      return store.get(SESSION_KEY);
    },

    logout() {
      store.remove(SESSION_KEY);
    },

    /** 重置某账号密码记录（调试 / 忘记密码用） */
    resetAccount(accountId) {
      const records = loadRecords();
      delete records[accountId];
      saveRecords(records);
      if (this.currentSession()?.accountId === accountId) store.remove(SESSION_KEY);
    },

    /* --- 内部：会话持久化（下划线前缀表示"非公开 API"） --- */
    _persistSession(identity) {
      const session = { ...identity, loginAt: Date.now() };
      store.set(SESSION_KEY, session);
      return session;
    },
  };
}
