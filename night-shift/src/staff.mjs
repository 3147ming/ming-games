/**
 * 店员系统（需求J）—— 纯逻辑层，不依赖 Three.js / DOM（ADR-002）
 *
 * 四类店员（维修员 / 保洁员 / 采购员 / 上货员）各可雇 1 人，总上限 4 名。
 * 店员拥有「体力 / 休息」机制（沿用 R1 店员四状态口径，但与玩家本人的 state.clerk 互不干扰）：
 *   · 连续工作会掉体力，体力低于阈值去休息，恢复后回来继续。
 *   · 每 salarySec(180) 游戏秒统一扣一次薪资；金币不足则全员停工，补足后恢复。
 *   · 可随时解雇，解雇后不再扣对应薪资。
 *
 * 四类店员的 AI（均通过注入的 economy / worldState 接口做事，不碰任何渲染）：
 *   repairer —— 自动维修故障设备（不清理、不补货）
 *   cleaner   —— 自动清理店内垃圾（不维修、不补货）
 *   purchaser —— 库存低于阈值时自动外出采购补货（少量溢价；外出期间不工作）
 *   stocker   —— 自动把仓库货品上架到货架与设备（无库存时原地待命；故障机不补）
 *
 * 表现副作用（店员 mesh 移动 / toast）由 main.mjs 统一收口（onEvent 回调）。
 */
import { STAFF, WAREHOUSE, SKU_BY_ID } from './config.mjs';
import { availableSkus } from './economy.mjs';
import { fmtYuan } from './fmt.mjs';

/**
 * @param opts.state       全局状态（含 staff / warehouse / cash / deviceStock）
 * @param opts.economy     { purchase, buyWarehouseGood, restockShelfIfPossible, backroomTotal, warehouseFree, warehouseCap, warehouseUsed }
 * @param opts.worldState  { deviceList, repair, repairCost, litter, clean, cleanAll, brokenCount }
 * @param opts.onEvent     (type, payload) => void  用于弹 toast / 驱动场景
 */
export function createStaff(opts = {}) {
  const { state, economy, worldState } = opts;
  const onEvent = opts.onEvent ?? (() => {});
  /* 店员上限的两个注入口（成长线：每升 1 星，总上限 +1）。
   * 不传 = 用 config 的既有值 —— 行为与扩展前完全一致（staff.test 的断言不受影响）。 */
  const capOf = typeof opts.capOf === 'function' ? opts.capOf : () => STAFF.maxTotal;
  const perTypeOf = typeof opts.maxPerType === 'function' ? opts.maxPerType : () => STAFF.maxPerType;
  const defOf = (type) => STAFF.types[type];
  // idSeq 从已存档的店员编号续接，避免读档后再雇出现 `#1` 重复 id（scene mesh key 冲突）
  let idSeq = (state.staff ?? [])
    .map((s) => {
      const i = (s.id ?? '').indexOf('#');
      return i >= 0 ? Number(s.id.slice(i + 1)) : 0;
    })
    .filter((n) => Number.isFinite(n))
    .reduce((mx, n) => Math.max(mx, n), 0);
  let salaryAcc = 0;
  let stopped = false; // 金币不足停工标志

  const roster = () => state.staff ?? (state.staff = []);

  /* ---------- 雇佣 / 解雇 ---------- */

  function canHire(type) {
    const def = defOf(type);
    if (!def) return { ok: false, reason: '未知店员' };
    const sameType = roster().filter((s) => s.type === type).length;
    if (sameType >= perTypeOf(type)) return { ok: false, reason: '该类已雇满' };
    if (roster().length >= capOf()) return { ok: false, reason: `店员已满（上限 ${capOf()}）` };
    if (state.cash < def.hireCost) return { ok: false, reason: `现金不足 · 需 ${fmtYuan(def.hireCost)}` };
    return { ok: true };
  }

  function hire(type) {
    const chk = canHire(type);
    if (!chk.ok) return chk;
    const def = defOf(type);
    state.cash -= def.hireCost;
    roster().push({
      id: `${type}#${++idSeq}`,
      type,
      stamina: 100,
      resting: false,
      working: false,
      status: 'idle',     // idle | working | resting | errand | stopped
      cooldownUntil: 0,
      errandUntil: 0,
      pending: null,      // 采购员外出期间挂起的采购单
      targetId: null,
    });
    onEvent('hire', { type, name: def.name, emoji: def.emoji });
    return { ok: true, type };
  }

  function fire(type) {
    const arr = roster();
    const i = arr.findIndex((s) => s.type === type);
    if (i < 0) return { ok: false, reason: '未雇佣' };
    arr.splice(i, 1);
    onEvent('fire', { type, name: defOf(type).name });
    return { ok: true, type };
  }

  /* ---------- 薪资 ---------- */

  function paySalary() {
    const arr = roster();
    if (arr.length === 0) return;
    const total = arr.reduce((s, m) => s + (defOf(m.type).salary | 0), 0);
    if (state.cash >= total) {
      state.cash -= total;
      stopped = false;
      onEvent('salary', { total });
    } else {
      stopped = true;
      onEvent('salary-fail', { total });
    }
  }

  /* ---------- 单店员推进 ---------- */

  function updateMember(s, dt, now) {
    const def = defOf(s.type);

    /* 体力：工作掉、休息回 */
    if (s.resting) {
      s.stamina = Math.min(100, s.stamina + STAFF.restRecover * dt);
      if (s.stamina >= 95) s.resting = false;
    } else {
      s.stamina = Math.max(0, s.stamina - STAFF.workDrain * dt);
      if (s.stamina < STAFF.restStamina) s.resting = true;
    }

    if (s.resting) { s.working = false; s.status = 'resting'; return; }
    if (stopped) { s.working = false; s.status = 'stopped'; return; }
    if (now < s.cooldownUntil) { s.status = s.working ? 'working' : 'idle'; return; }

    switch (s.type) {
      case 'repairer': return aiRepairer(s, now);
      case 'cleaner':   return aiCleaner(s, now);
      case 'purchaser': return aiPurchaser(s, now);
      case 'stocker':   return aiStocker(s, now);
      default: s.status = 'idle';
    }
  }

  function aiRepairer(s, now) {
    const broken = worldState.deviceList().find((d) => d.broken);
    if (!broken) { s.working = false; s.status = 'idle'; return; }
    s.working = true;
    s.status = 'repair';
    s.targetId = broken.id;
    const r = worldState.repair(broken.id, state.cash);
    if (r.ok) onEvent('repair-done', { type: s.type, name: defOf(s.type).name, id: broken.id });
    else if (r.reason === 'insufficient') onEvent('repair-nocash', { type: s.type });
    s.cooldownUntil = now + STAFF.actionCd;
  }

  function aiCleaner(s, now) {
    const litter = worldState.litter;
    if (!litter || litter.length === 0) { s.working = false; s.status = 'idle'; return; }
    s.working = true;
    s.status = 'clean';
    const r = worldState.clean(litter[0].id);
    // name 必须带上：main.mjs 的 toast 要显示"谁完成的"（Bug⑥ —— 漏传就会拼出 "undefined 清理了垃圾"）
    if (r.ok) onEvent('clean-done', { type: s.type, name: defOf(s.type).name });
    s.cooldownUntil = now + STAFF.actionCd;
  }

  function aiPurchaser(s, now) {
    // 外出归来：执行挂起的采购单
    if (s.status === 'errand' && now >= s.errandUntil) {
      const p = s.pending;
      s.pending = null;
      s.status = 'idle';
      if (p) {
        const res = p.skuId
          ? economy.purchase(p.skuId, p.qty, p.premium)
          : economy.buyWarehouseGood(p.goodId, p.qty, p.premium);
        if (res.ok) onEvent('purchase-done', { type: s.type, staffName: defOf(s.type).name, good: p.goodId ?? 'snack', name: p.name });
      }
      s.cooldownUntil = now + STAFF.actionCd;
      return;
    }
    if (s.status === 'errand') return; // 外出中，不工作

    // 找最低库存的货品
    const need = evaluateNeed();
    if (!need) { s.working = false; s.status = 'idle'; return; }

    // 钱够才出门；不够就原地等（不弹频繁 toast）
    if (state.cash < need.cost) { s.working = false; s.status = 'idle'; return; }

    // 出门采购（errandSec 期间不工作）
    s.status = 'errand';
    s.errandUntil = now + STAFF.errandSec;
    s.pending = need;
    onEvent('errand', { type: s.type, staffName: defOf(s.type).name, good: need.goodId ?? 'snack', name: need.name });
  }

  /** 返回第一个低于阈值的货品采购单（含成本，已算溢价） */
  function evaluateNeed() {
    const free = economy.warehouseFree();
    if (free <= 0) return null;
    const g = state.warehouse?.goods ?? {};
    const thresholdOf = (id) => WAREHOUSE.goods[id]?.threshold ?? 0;

    // 零食饮料：映射 backroom 总件数
    const snackCur = economy.backroomTotal();
    if (snackCur < thresholdOf('snack')) {
      /* 采购 SKU 按**货架缺口**挑（2026-10-05 反馈：之前固定买饮料，饮料需求又少，
       * 结果饮料堆满仓库、泡面便当断货）。选货架上当前总量最少的已解锁 SKU，
       * 全部为空时按 SKUS 顺序取第一个（drink 兜底，避免破坏初始采购流程）。 */
      const skuId = pickLowestShelfSku();
      const qty = Math.min(free, Math.max(10, thresholdOf('snack') - snackCur), 20);
      const cost = Math.round(qty * (SKU_BY_ID[skuId]?.cost ?? 3) * (1 + WAREHOUSE.purchaserPremium));
      return { skuId, qty, premium: WAREHOUSE.purchaserPremium, cost, goodId: 'snack', name: '零食饮料' };
    }
    // 玩具 / 鱼饵 / 维修耗材
    for (const id of ['toy', 'bait', 'parts']) {
      const cur = g[id] | 0;
      if (cur < thresholdOf(id)) {
        const qty = Math.min(free, Math.max(1, thresholdOf(id) - cur), 10);
        const cost = Math.round(qty * WAREHOUSE.goods[id].cost * (1 + WAREHOUSE.purchaserPremium));
        return { goodId: id, qty, premium: WAREHOUSE.purchaserPremium, cost, name: WAREHOUSE.goods[id].name };
      }
    }
    return null;
  }

  /** 采购员挑 SKU：货架上当前总量最少的已解锁 SKU（缺口最大优先补）；
   *  2026-10-06：改为直接复用 economy.availableSkus()。
   *  原来这里自己抄了一份 `!s.locked || state.upgrades?.[s.id]` 判定，
   *  在 locked 语义扩展成"借用别的升级钥匙"（口香糖/电池/杂志）后就会漏判，
   *  而且它还漏了 festivalOnly —— 采购员会在非节日夜去进节日礼盒。
   *  单一真源比"两处写得很像"更不容易漂移。 */
  function pickLowestShelfSku() {
    const shelfQty = {};
    for (const s of state.slots) {
      if (s.skuId && s.qty > 0) shelfQty[s.skuId] = (shelfQty[s.skuId] ?? 0) + s.qty;
    }
    const unlocked = availableSkus();
    if (unlocked.length === 0) return SKU_BY_ID.drink?.id ?? 'drink';
    unlocked.sort((a, b) => (shelfQty[a.id] ?? 0) - (shelfQty[b.id] ?? 0));
    return unlocked[0].id;
  }

  function aiStocker(s, now) {
    // 1) 货架补货（backroom → 空货架格）
    if (economy.restockShelfIfPossible()) {
      s.working = true;
      s.status = 'stock-shelf';
      onEvent('stock-done', { type: s.type, name: defOf(s.type).name, kind: 'shelf', label: '货架' });
      s.cooldownUntil = now + STAFF.actionCd;
      return;
    }
    // 2) 售货机补货（消耗 backroom 零食饮料）
    const maxV = WAREHOUSE.deviceStockMax.vending;
    if ((state.deviceStock?.vending | 0) < maxV && economy.backroomTotal() > 0) {
      // 从 backroom 取 1 件（随便哪个有货的）当作售货机补货
      const skuId = Object.keys(state.backroom).find((id) => state.backroom[id] > 0);
      if (skuId) {
        state.backroom[skuId] -= 1;
        state.deviceStock.vending = (state.deviceStock.vending | 0) + 1;
        s.working = true; s.status = 'stock-vending';
        onEvent('stock-done', { type: s.type, name: defOf(s.type).name, kind: 'vending', label: '售货机' });
        s.cooldownUntil = now + STAFF.actionCd;
        return;
      }
    }
    // 3) 娃娃机补货（消耗仓库玩具）
    const maxC = WAREHOUSE.deviceStockMax.claw;
    if ((state.deviceStock?.claw | 0) < maxC && (state.warehouse?.goods?.toy | 0) > 0) {
      state.warehouse.goods.toy -= 1;
      state.deviceStock.claw = (state.deviceStock.claw | 0) + 1;
      s.working = true; s.status = 'stock-claw';
      onEvent('stock-done', { type: s.type, name: defOf(s.type).name, kind: 'claw', label: '娃娃机' });
      s.cooldownUntil = now + STAFF.actionCd;
      return;
    }
    s.working = false;
    s.status = 'idle';
  }

  /* ---------- 每帧 ---------- */

  function update(dt, ctx = {}) {
    const arr = roster();
    if (arr.length === 0) return;
    const now = ctx.now ?? state.wallElapsed;
    salaryAcc += dt;
    if (salaryAcc >= STAFF.salarySec) {
      salaryAcc -= STAFF.salarySec;
      paySalary();
    }
    for (const s of arr) updateMember(s, dt, now);
  }

  /* ---------- 快照（HUD 用） ---------- */

  function snapshot() {
    return {
      stopped,
      salaryDueIn: Math.max(0, STAFF.salarySec - salaryAcc),
      /** 当前店员总上限（含星级加成）与已雇人数（HUD 展示用） */
      cap: capOf(),
      headcount: roster().length,
      roster: STAFF.order.map((type) => {
        const def = defOf(type);
        const entry = roster().find((s) => s.type === type);
        return {
          type,
          name: def.name,
          emoji: def.emoji,
          hireCost: def.hireCost,
          salary: def.salary,
          desc: def.desc,
          hired: !!entry,
          stamina: entry ? Math.round(entry.stamina) : 0,
          status: entry ? entry.status : 'idle',
        };
      }),
    };
  }

  return {
    hire, fire, canHire,
    update,
    snapshot,
    isStopped: () => stopped,
    /** 当前雇佣人数 */
    count: () => roster().length,
  };
}
