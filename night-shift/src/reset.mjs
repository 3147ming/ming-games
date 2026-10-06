/**
 * 账号重开（重置）服务 —— 把**本账号**的进度清回初始状态
 *
 * ── 为什么单独成模块 ──────────────────────────────────────
 * "重开"看着像"点一下清档"，实际要同时回答四个问题，任何一条含糊都会出事：
 *   1) 什么时候允许重开？（前置条件：已登录 / 已设密码 / 过了冷却 / 今日还有额度）
 *   2) 重开要清掉哪些数据？（存档、排行榜条目、运行时状态 —— 见 applyReset 注入点）
 *   3) 要清但**不能**清的是什么？（账号密码、会话、玩家设置 —— 清了就把人锁在门外了）
 *   4) 清完之后怎么回到一个能玩的状态？（不是"空着"，而是"像刚开的新档"）
 * 把这四条集中在纯逻辑里，UI 只负责问密码 + 显示状态，就不再到处散落判断。
 *
 * ── 关键设计：重开是**账号级**动作 ─────────────────────────
 * 所以配额（冷却 / 每日次数）按账号分别记，且记在 localStorage 的独立键里
 * （config.RESET.storageKey），**不在游戏存档里** —— 否则"清存档"会顺手把
 * 配额也清了，每日上限立刻失效。
 *
 * 反过来，账号隔离的存档键（save.mjs 的 saveKeyFor）是前提：
 * 三个内测账号共用一份存档时，"重开本账号"必然连带抹掉别人的进度。
 *
 * ── 注入点（本模块不认识游戏本体）─────────────────────────
 *   getAccountId()             -> string|null   当前登录账号
 *   isRegistered(accountId)    -> boolean       该账号是否已设过密码
 *   verifyPassword(id, pw)     -> boolean       复用 account.mjs 的哈希校验
 *   applyReset(info)           -> void          真正的清理 + 恢复（main.mjs 提供）
 *   store / now                                 可注入 → 可在 Node 单测
 *
 * ── 纯逻辑、零 DOM/THREE 依赖 ─────────────────────────────
 */

import { RESET } from './config.mjs';

/** 本地自然日标识（YYYY-MM-DD）。用**本地**时区而不是 UTC：
 *  玩家感知的"今天用完了 3 次"必须跟他手表一致，用 UTC 会在东八区凌晨 8 点才换日。 */
export function localDayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 重开的数据范围契约 —— **单一真源**。
 *
 * 这里只写"应该清什么 / 不能清什么"，实际清理动作在 main.mjs 的 applyReset 里，
 * 弹窗也从这里取文案：两边读同一份清单，就不会出现"UI 说清了、代码没清"的漂移。
 *
 * 判断依据：**这条数据属于"这一局的进度"还是"这个人的东西"？**
 *   · 进度（钱/夜/星级/成就/设备/NPC/主题/脸谱…）→ 清
 *   · 身份与偏好（密码哈希、登录会话、音量画面灵敏度）→ 保留
 */
export const RESET_SCOPE = {
  clears: [
    '游戏进度（金币 / 代币 / 夜数 / 星级 / 成就）',
    '库存 · 仓库 · 设备等级与故障状态',
    '店员 / 常客脸谱 / 二手设备 / 帖子与点评',
    '本账号在本地排行榜里的成绩',
    '当前这一夜的全部运行时状态',
  ],
  keeps: [
    '账号与密码（否则重开等于把自己锁在门外）',
    '登录状态（重开后直接回到新的第一夜）',
    '音量 / 画面 / 灵敏度等玩家设置',
    '其他账号的进度（存档按账号隔离）',
  ],
};

/** 内存兜底 store（Node 单测 / 隐私模式）—— 只暴露 get/set，后端可整体替换 */
export function createMemoryStore() {
  const map = new Map();
  return {
    kind: 'memory',
    get(key) { return map.has(key) ? JSON.parse(map.get(key)) : null; },
    set(key, value) { map.set(key, JSON.stringify(value)); return true; },
    remove(key) { map.delete(key); },
  };
}

/** 默认 store：localStorage，不可用时退化到内存 */
function defaultStore() {
  let ok = false;
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const k = '__ns_reset_probe__';
      window.localStorage.setItem(k, '1');
      window.localStorage.removeItem(k);
      ok = true;
    }
  } catch { ok = false; }
  if (!ok) return createMemoryStore();
  return {
    kind: 'localStorage',
    get(key) {
      try {
        const raw = window.localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    },
    set(key, value) {
      try { window.localStorage.setItem(key, JSON.stringify(value)); return true; }
      catch { return false; }
    },
    remove(key) {
      try { window.localStorage.removeItem(key); } catch { /* 忽略 */ }
    },
  };
}

/**
 * 创建重开服务。
 * @param opts.store            持久化后端（默认 localStorage，可注入以便单测）
 * @param opts.now              () => 毫秒时间戳（可注入以便单测冷却 / 跨日）
 * @param opts.getAccountId     () => string|null
 * @param opts.isRegistered     (accountId) => boolean
 * @param opts.verifyPassword   (accountId, password) => boolean
 * @param opts.applyReset       ({accountId, at, resetsToday}) => void
 * @param opts.onEvent          (type, payload) => void  HUD 提示用
 * @param opts.rule             覆盖 config.RESET（单测把冷却/上限调小）
 */
export function createResetService(opts = {}) {
  const store = opts.store ?? defaultStore();
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const getAccountId = typeof opts.getAccountId === 'function' ? opts.getAccountId : () => null;
  const isRegistered = typeof opts.isRegistered === 'function' ? opts.isRegistered : () => false;
  const verifyPassword = typeof opts.verifyPassword === 'function' ? opts.verifyPassword : () => false;
  const applyReset = typeof opts.applyReset === 'function' ? opts.applyReset : () => {};
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  const rule = { ...RESET, ...(opts.rule ?? {}) };
  const key = rule.storageKey ?? RESET.storageKey;

  /* records: { [accountId]: { day:'YYYY-MM-DD', count:number, lastAt:number, total:number } } */
  function loadAll() {
    const all = store.get(key);
    return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
  }
  function saveAll(all) { return store.set(key, all); }

  /** 取某账号的配额记录；跨日自动归零（**读取时就归零**，不必等一次定时任务） */
  function recFor(accountId, ts = now()) {
    const all = loadAll();
    const day = localDayKey(ts);
    const prev = all[accountId];
    const rec = prev && prev.day === day
      ? { day, count: Number(prev.count) || 0, lastAt: Number(prev.lastAt) || 0, total: Number(prev.total) || 0 }
      : { day, count: 0, lastAt: 0, total: Number(prev?.total) || 0 };
    return { all, rec };
  }

  /**
   * 当前能不能重开。
   * @returns {{ accountId, allowed, reason, message, cooldownLeft, usedToday, maxPerDay,
   *            remainingToday, totalResets, day }}
   */
  function status() {
    const ts = now();
    const accountId = getAccountId();
    const base = {
      accountId,
      allowed: false,
      reason: '',
      message: '',
      cooldownLeft: 0,
      usedToday: 0,
      maxPerDay: rule.maxPerDay,
      remainingToday: 0,
      totalResets: 0,
      day: localDayKey(ts),
    };

    if (!accountId) {
      return { ...base, reason: 'not-logged-in', message: '请先登录账号' };
    }
    if (!isRegistered(accountId)) {
      return { ...base, reason: 'not-registered', message: '该账号还没设置密码，无法重开' };
    }

    const { rec } = recFor(accountId, ts);
    const usedToday = rec.count;
    const remainingToday = Math.max(0, rule.maxPerDay - usedToday);

    const cooldownLeft = rec.lastAt
      ? Math.max(0, Math.ceil((rec.lastAt + rule.cooldownSec * 1000 - ts) / 1000))
      : 0;

    const common = { ...base, usedToday, remainingToday, totalResets: rec.total, cooldownLeft };

    if (cooldownLeft > 0) {
      return { ...common, reason: 'cooldown', message: `冷却中，还需等待 ${cooldownLeft} 秒` };
    }
    if (remainingToday <= 0) {
      return {
        ...common,
        reason: 'daily-limit',
        message: `今天已重开 ${usedToday} 次（上限 ${rule.maxPerDay} 次），明天再来`,
      };
    }
    return {
      ...common,
      allowed: true,
      reason: 'ready',
      message: `今天还能重开 ${remainingToday} 次`,
    };
  }

  /**
   * 执行重开。**所有前置条件都在这里复核**，不信任 UI 传进来的东西
   * —— UI 只是把玩家的输入转交过来。
   *
   * @param {object} input
   * @param {string} input.password 当前账号密码（必填，防误触 / 防他人操作）
   * @param {string} input.phrase   二次确认词（须等于 rule.confirmPhrase）
   * @returns {{ ok:boolean, reason:string, message:string, ... }}
   */
  function requestReset(input = {}) {
    const st = status();
    if (!st.allowed) return { ok: false, reason: st.reason, message: st.message, status: st };

    // 便宜的检查在前：确认词 → 密码（免得白算一次哈希）
    const phrase = String(input.phrase ?? '').trim();
    if (phrase !== rule.confirmPhrase) {
      return { ok: false, reason: 'bad-phrase', message: `确认词不对，请输入「${rule.confirmPhrase}」`, status: st };
    }
    if (!verifyPassword(st.accountId, String(input.password ?? ''))) {
      return { ok: false, reason: 'bad-password', message: '密码错误，重开已取消', status: st };
    }

    const ts = now();
    const { all, rec } = recFor(st.accountId, ts);
    const nextRec = {
      day: localDayKey(ts),
      count: rec.count + 1,
      lastAt: ts,
      total: rec.total + 1,
    };

    /* 先落配额再执行清理：万一清理过程把 localStorage 大面积清掉，
     * 配额也已经写进去了（否则"每日上限"会被一次重开顺手重置）。
     * 但清理若抛异常就把配额回滚 —— 失败的重开不该吃掉一次额度。 */
    const before = all[st.accountId] ?? null;
    all[st.accountId] = nextRec;
    saveAll(all);

    try {
      applyReset({ accountId: st.accountId, at: ts, resetsToday: nextRec.count });
    } catch (e) {
      const rollback = loadAll();
      if (before) rollback[st.accountId] = before; else delete rollback[st.accountId];
      saveAll(rollback);
      onEvent('reset-failed', { message: e?.message ?? String(e) });
      return { ok: false, reason: 'apply-failed', message: `重开失败，已回滚：${e?.message ?? e}`, status: st };
    }

    onEvent('reset-done', { accountId: st.accountId, resetsToday: nextRec.count });
    return {
      ok: true,
      reason: 'done',
      message: `已重开（今天第 ${nextRec.count}/${rule.maxPerDay} 次）`,
      accountId: st.accountId,
      at: ts,
      resetsToday: nextRec.count,
      remainingToday: Math.max(0, rule.maxPerDay - nextRec.count),
    };
  }

  return {
    /** 当前规则（HUD 展示冷却 / 上限用） */
    rule,
    /** 配额记录里当前账号的原始副本（诊断 / 探针用） */
    peek(accountId = getAccountId()) {
      if (!accountId) return null;
      const all = loadAll();
      return all[accountId] ? { ...all[accountId] } : null;
    },
    status,
    requestReset,
  };
}
