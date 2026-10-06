/**
 * 店铺成长系统（需求I 第①④⑦条：设备升级 / 机器改装 / 店铺扩建）
 *
 * ── 为什么这三件事放同一个模块 ──────────────────────────
 * 它们共享同一个对象：**一台设备 / 一块场地的当前配置**。
 *   · 升级改的是等级（影响故障率 / 收益 / 吸引力）
 *   · 改装改的是附加模块（同样影响故障率 / 收益 / 吸引力 / 游玩时长）
 *   · 扩建改的是"这台设备存不存在"
 * 三者最终都会汇流到同一组派生倍率（attractMul / revenueMul / breakMul / repairMul），
 * 拆成三个模块会让"这台机器现在的实际故障率是多少"这个问题要跨三个文件才能算清。
 *
 * ── 纯逻辑、零 THREE / DOM 依赖 ─────────────────────────
 * 本模块只读写 state.mjs（单一真源 ADR-002），因此可以脱离浏览器完整单测。
 * 表现层（柜体描边变色 / 扩建区显隐）由 scene.mjs 消费 `snapshot()` 去画。
 *
 * ── 与既有系统的边界 ────────────────────────────────────
 * 本模块**不修改**既有的故障 / 维修 / 收益逻辑，只提供倍率供 worldstate 与 npcs 查询：
 *   worldstate.repairCost(id) × progression.repairMul(id)
 *   worldstate 故障掷骰       × progression.breakMul(id)
 *   npcs 选目标权重           × progression.attractMul(id)
 * 既有代码在"没有 progression"时行为不变（倍率缺省为 1）。
 */

import {
  DEVICE_UPGRADE, MODULES, MODULE_BY_ID, MODULE_MAX_PER_DEVICE, MODULE_REFUND,
  EXPANSIONS, EXPANSION_BY_ID, FACILITIES,
} from './config.mjs';

const numOr = (v, d) => (Number.isFinite(v) ? v : d);

/**
 * @param opts.state       state.mjs 的单一真源
 * @param opts.isBroken    (id) => boolean —— 查设备是否故障（升级的前置校验需要）
 * @param opts.onEvent     (type, payload) —— 'upgrade' | 'mod-install' | 'mod-remove' | 'expansion'
 */
export function createProgression(opts = {}) {
  const state = opts.state;
  const isBroken = opts.isBroken ?? (() => false);
  const onEvent = opts.onEvent ?? (() => {});
  /** 额外的运行时设施（星级解锁）；不传 = 空 */
  const extraFacilities = typeof opts.extraFacilities === 'function' ? opts.extraFacilities : () => [];

  /* ==================================================================
   * 设备集合：基础设施 + 已解锁扩建附带的设施
   *
   * 注意这里**不改动** config.FACILITIES —— 那是既有玩法的真源，
   * 扩建带来的新设施是运行时追加的，两者并集才是"当前场上存在的设备"。
   * ================================================================== */
  function activeFacilities() {
    const list = FACILITIES.slice();
    for (const exp of EXPANSIONS) {
      if (!state.expansions?.[exp.id]) continue;
      for (const f of exp.facilities ?? []) list.push(f);
    }
    /* 星级解锁的机器（跳舞机 / 赛车机 / KTV / 点唱机）。
     * 它们**必须**走这张表：升级 / 改装 / 故障 / 上货 / 店员五套体系都读它，
     * 只有进了这张表，新机器才算"复用现有体系"而不是另起一套。
     * 不传 extraFacilities 时行为与扩展前完全一致。 */
    for (const f of extraFacilities() ?? []) {
      if (f && !list.some((x) => x.id === f.id)) list.push(f);
    }
    return list;
  }

  function findFacility(id) {
    return activeFacilities().find((f) => f.id === id) ?? null;
  }

  /** 某台设备当前是否已解锁（未被扩建锁住） */
  function isUnlocked(id) {
    return findFacility(id) !== null;
  }

  /* ==================================================================
   * ① 设备等级
   * ================================================================== */

  function levelOf(id) {
    return Math.max(1, Math.min(DEVICE_UPGRADE.maxLevel, Math.round(numOr(state.deviceLevels?.[id], 1))));
  }

  /** 升到下一级的造价；已满级返回 null */
  function upgradeCost(id) {
    const lv = levelOf(id);
    if (lv >= DEVICE_UPGRADE.maxLevel) return null;
    return DEVICE_UPGRADE.cost[lv - 1] ?? null;
  }

  /**
   * 能否升级。
   * 需求①的硬约束：**故障状态下无法升级，必须先维修完成** ——
   * 否则玩家可以在机器坏着的时候把它升到 3 级，把"故障维护"这条经营压力绕过去。
   */
  function canUpgrade(id) {
    if (!isUnlocked(id)) return { ok: false, reason: '设备不存在' };
    const cost = upgradeCost(id);
    if (cost == null) return { ok: false, reason: '已满级' };
    if (isBroken(id)) return { ok: false, reason: '设备故障中 · 需先维修' };
    if (state.cash < cost) return { ok: false, reason: '现金不足' };
    return { ok: true, cost, level: levelOf(id) + 1 };
  }

  function upgrade(id) {
    const check = canUpgrade(id);
    if (!check.ok) return check;
    state.cash -= check.cost;
    state.deviceLevels[id] = check.level;
    onEvent('upgrade', { id, level: check.level, cost: check.cost });
    return { ok: true, cost: check.cost, level: check.level };
  }

  /* ==================================================================
   * ④ 改装模块
   * ================================================================== */

  function modsOf(id) {
    const m = state.deviceMods?.[id];
    return Array.isArray(m) ? m.filter((x) => MODULE_BY_ID[x]) : [];
  }

  /** 装上某个模块的价格（重复装同一种按原价再收一次，不做折扣） */
  function modulePrice(modId) {
    return MODULE_BY_ID[modId]?.cost ?? null;
  }

  function canInstall(id, modId) {
    const mod = MODULE_BY_ID[modId];
    if (!mod) return { ok: false, reason: '未知模块' };
    if (!isUnlocked(id)) return { ok: false, reason: '设备不存在' };
    const cur = modsOf(id);
    if (cur.includes(modId)) return { ok: false, reason: '已安装' };
    // 需求④：一台机器最多装 MODULE_MAX_PER_DEVICE 种
    if (cur.length >= MODULE_MAX_PER_DEVICE) {
      return { ok: false, reason: `最多只能装 ${MODULE_MAX_PER_DEVICE} 种` };
    }
    if (state.cash < mod.cost) return { ok: false, reason: '现金不足' };
    return { ok: true, cost: mod.cost };
  }

  function installModule(id, modId) {
    const check = canInstall(id, modId);
    if (!check.ok) return check;
    state.cash -= check.cost;
    if (!Array.isArray(state.deviceMods[id])) state.deviceMods[id] = [];
    state.deviceMods[id].push(modId);
    onEvent('mod-install', { id, modId, cost: check.cost });
    return { ok: true, cost: check.cost, mods: modsOf(id) };
  }

  /** 拆除并回收半价金币（需求④"可拆除回收半价金币"） */
  function removeModule(id, modId) {
    const mod = MODULE_BY_ID[modId];
    if (!mod) return { ok: false, reason: '未知模块' };
    const cur = modsOf(id);
    const i = cur.indexOf(modId);
    if (i < 0) return { ok: false, reason: '未安装' };
    cur.splice(i, 1);
    state.deviceMods[id] = cur;
    const refund = Math.round(mod.cost * MODULE_REFUND);
    state.cash += refund;
    onEvent('mod-remove', { id, modId, refund });
    return { ok: true, refund, mods: cur };
  }

  /* ==================================================================
   * 派生倍率 —— 本模块对外最主要的东西
   * 全部 = 等级系数 ×（各模块的系数的连乘），缺省 1（保证不接入时行为不变）
   * ================================================================== */

  function attractMul(id) {
    let m = DEVICE_UPGRADE.attractMul[levelOf(id) - 1] ?? 1;
    for (const mid of modsOf(id)) {
      const mod = MODULE_BY_ID[mid];
      if (mod?.attractMul) m *= mod.attractMul;
    }
    return m;
  }

  function revenueMul(id) {
    return DEVICE_UPGRADE.revenueMul[levelOf(id) - 1] ?? 1;
  }

  /** 故障率倍率：等级越高越容易坏，降噪模块把它压回来 */
  function breakMul(id) {
    let m = DEVICE_UPGRADE.breakMul[levelOf(id) - 1] ?? 1;
    for (const mid of modsOf(id)) {
      const mod = MODULE_BY_ID[mid];
      if (mod?.breakMul) m *= mod.breakMul;
    }
    return m;
  }

  function repairMul(id) {
    return DEVICE_UPGRADE.repairMul[levelOf(id) - 1] ?? 1;
  }

  /** 游玩时长倍率（快充模块缩短游玩 → 加快周转） */
  function playSecMul(id) {
    let m = 1;
    for (const mid of modsOf(id)) {
      const mod = MODULE_BY_ID[mid];
      if (mod?.playSecMul) m *= mod.playSecMul;
    }
    return m;
  }

  /* ==================================================================
   * ⑦ 店铺扩建
   * ================================================================== */

  function hasExpansion(id) {
    return state.expansions?.[id] === true;
  }

  function canBuyExpansion(id) {
    const exp = EXPANSION_BY_ID[id];
    if (!exp) return { ok: false, reason: '未知扩建' };
    if (hasExpansion(id)) return { ok: false, reason: '已解锁' };
    // 按顺序解锁：防止玩家跳级拿到二级区域却没打通一级的门
    const idx = EXPANSIONS.findIndex((e) => e.id === id);
    for (let i = 0; i < idx; i++) {
      if (!hasExpansion(EXPANSIONS[i].id)) {
        return { ok: false, reason: `需先解锁「${EXPANSIONS[i].name}」` };
      }
    }
    if (state.cash < exp.cost) return { ok: false, reason: '现金不足' };
    return { ok: true, cost: exp.cost };
  }

  function buyExpansion(id) {
    const check = canBuyExpansion(id);
    if (!check.ok) return check;
    state.cash -= check.cost;
    state.expansions[id] = true;
    // 场景扩建 / 新设施注册 / 碰撞体重建都由 main 监听这个事件去做
    onEvent('expansion', { id, cost: check.cost, def: EXPANSION_BY_ID[id] });
    return { ok: true, cost: check.cost, def: EXPANSION_BY_ID[id] };
  }

  /** 已解锁的扩建定义列表（顺序同 EXPANSIONS） */
  function ownedExpansions() {
    return EXPANSIONS.filter((e) => hasExpansion(e.id));
  }

  /** 售货专区加成（exp2） */
  function vendingBonus() {
    let b = 0;
    for (const e of ownedExpansions()) {
      if (e.vendingBonus) b += e.vendingBonus;
    }
    return b;
  }

  /* ==================================================================
   * 快照（HUD 渲染与测试断言的入口，返回纯数据）
   * ================================================================== */

  function deviceInfo(id) {
    const fac = findFacility(id);
    return {
      id,
      // 名称/图标/类型：HUD 要用，但那属于表现层字段，逻辑层读取时忽略即可
      name: fac?.name ?? id,
      emoji: fac?.emoji ?? '🎮',
      kind: fac?.kind ?? 'unknown',
      level: levelOf(id),
      mods: modsOf(id),
      upgradeCost: upgradeCost(id),
      canUpgrade: canUpgrade(id),
      attractMul: attractMul(id),
      revenueMul: revenueMul(id),
      breakMul: breakMul(id),
      repairMul: repairMul(id),
      playSecMul: playSecMul(id),
      unlocked: isUnlocked(id),
    };
  }

  function snapshot() {
    return {
      devices: activeFacilities().map((f) => deviceInfo(f.id)),
      expansions: EXPANSIONS.map((e) => ({
        id: e.id, name: e.name, emoji: e.emoji, cost: e.cost, desc: e.desc,
        owned: hasExpansion(e.id), canBuy: canBuyExpansion(e.id),
      })),
      modules: MODULES.map((m) => ({ ...m })),
      vendingBonus: vendingBonus(),
    };
  }

  return {
    /* 设备集合 */
    activeFacilities, findFacility, isUnlocked,
    /* ① 升级 */
    levelOf, upgradeCost, canUpgrade, upgrade,
    /* ④ 改装 */
    modsOf, modulePrice, canInstall, installModule, removeModule,
    /* 派生倍率 */
    attractMul, revenueMul, breakMul, repairMul, playSecMul,
    /* ⑦ 扩建 */
    hasExpansion, canBuyExpansion, buyExpansion, ownedExpansions, vendingBonus,
    /* 快照 */
    deviceInfo, snapshot,
  };
}

/** 常量再导出，方便调用方只 import 一处 */
export { DEVICE_UPGRADE, MODULES, MODULE_MAX_PER_DEVICE, EXPANSIONS };
