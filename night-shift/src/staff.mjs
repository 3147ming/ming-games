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
import { STAFF, WAREHOUSE, SKU_BY_ID, NIGHT_WALL_SECONDS } from './config.mjs';
import { availableSkus } from './economy.mjs';
import { fmtYuan } from './fmt.mjs';
/* 培训树（纯逻辑）：每位员工点过的节点 → 累计倍率。
 * staff 只消费 getBonuses 的结果，不认识节点价格/前置规则（那些在 training.mjs）。 */
import { getBonuses } from './training.mjs';

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
      status: 'idle',     // idle | working | resting | errand | stopped | off
      cooldownUntil: 0,
      errandUntil: 0,
      pending: null,      // 采购员外出期间挂起的采购单
      targetId: null,
      /* P1-9 排班：false = 今夜不上班（不扣薪资、不干活）。旧档无此字段 → 用 `!== false` 口径视为上班。 */
      onDuty: true,
    });
    onEvent('hire', { type, name: def.name, emoji: def.emoji });
    return { ok: true, type };
  }

  function fire(type) {
    const arr = roster();
    const i = arr.findIndex((s) => s.type === type);
    if (i < 0) return { ok: false, reason: '未雇佣' };
    const [gone] = arr.splice(i, 1);
    /* 培训按 staffId 存（见 training.mjs）：人走了，这条技能线也随人消失。
     * 顺手删掉键，避免读档后留下一堆永远不会再生效的孤儿数据。 */
    if (gone?.id && state.training && typeof state.training === 'object') delete state.training[gone.id];
    onEvent('fire', { type, name: defOf(type).name });
    return { ok: true, type };
  }

  /* ---------- 薪资 ---------- */

  function paySalary() {
    /* P1-9：只给**今夜上班**的人发薪。旧档没有 onDuty 字段 → `!== false` 视为上班。 */
    const arr = roster().filter((m) => m.onDuty !== false);
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

  /* ---------- 排班（P1-9） ---------- */
  /** 设置某人今夜是否上班。关闭时立刻收工（清 working、状态标 off），不影响已发工资。 */
  function setDuty(type, on) {
    const m = roster().find((s) => s.type === type);
    if (!m) return { ok: false, reason: '未雇佣' };
    m.onDuty = on !== false;
    if (!m.onDuty) {
      m.working = false;
      m.resting = false;
      m.status = 'off';
    } else if (m.status === 'off') {
      m.status = 'idle';
    }
    onEvent('duty', { type, name: defOf(type).name, onDuty: m.onDuty });
    return { ok: true, type, onDuty: m.onDuty };
  }

  /** 翻转排班（HUD 按钮用）。 */
  function toggleDuty(type) {
    const m = roster().find((s) => s.type === type);
    if (!m) return { ok: false, reason: '未雇佣' };
    return setDuty(type, m.onDuty === false);
  }

  /* ---------- 单店员推进 ---------- */

  /** 培训后的行动冷却。
   *  口径：训练缩短的是"两次动作之间的间隔"，不是单次动作的产出 ——
   *  这样玩家能直观看到"同一个人一分钟里多干了一件事"，而不是数值偷偷变大。 */
  function actionCdOf(bonus) {
    return STAFF.actionCd * (bonus?.actionCdMul ?? 1);
  }

  function updateMember(s, dt, now) {
    const def = defOf(s.type);

    /* P1-9：今夜不上班 → 不干活、也不掉体力。旧档缺字段按"上班"处理（!== false）。 */
    if (s.onDuty === false) {
      s.working = false;
      s.resting = false;
      s.status = 'off';
      return;
    }

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

    /* 培训加成每次走到动作前现算：玩家可能在夜中途点完培训，
     * 缓存到开局会让"刚花的钱这一夜不生效"，与"永久能力"的直觉不符。 */
    const bonus = getBonuses(state, s.id);
    switch (s.type) {
      case 'repairer': return aiRepairer(s, now, bonus);
      case 'cleaner':   return aiCleaner(s, now, bonus);
      case 'purchaser': return aiPurchaser(s, now, bonus);
      case 'stocker':   return aiStocker(s, now, bonus);
      default: s.status = 'idle';
    }
  }

  function aiRepairer(s, now, bonus = {}) {
    const broken = worldState.deviceList().find((d) => d.broken);
    if (!broken) { s.working = false; s.status = 'idle'; return; }
    s.working = true;
    s.status = 'repair';
    s.targetId = broken.id;
    /* 培训「维修费减免」：worldState.repair 支持第三参数 costOverride（QTE 折扣也走它），
     * 这里用同一入口传折后价，不另开一条"先扣钱再修"的旁路。
     * 只有真有折扣且 worldState 报价函数存在时才传，保持未培训路径的行为完全不变。 */
    const canDiscount = (bonus.repairCostMul ?? 1) < 1 && typeof worldState.repairCost === 'function';
    const r = canDiscount
      ? worldState.repair(broken.id, state.cash, Math.max(1, Math.round(worldState.repairCost(broken.id) * bonus.repairCostMul)))
      : worldState.repair(broken.id, state.cash);
    if (r.ok) onEvent('repair-done', { type: s.type, name: defOf(s.type).name, id: broken.id });
    else if (r.reason === 'insufficient') onEvent('repair-nocash', { type: s.type });
    s.cooldownUntil = now + actionCdOf(bonus);
  }

  function aiCleaner(s, now, bonus = {}) {
    const litter = worldState.litter;
    if (!litter || litter.length === 0) { s.working = false; s.status = 'idle'; return; }
    s.working = true;
    s.status = 'clean';
    /* 培训「一次多清」：cleanBatch 是"这一趟最多处理几件"。
     * 逐件调用 worldState.clean 而不是新写批量接口 —— 垃圾的清理副作用
     * （口碑/满意度/音效）都在 clean 里，绕开它会让培训变成"清了个寂寞"。 */
    const batch = Math.max(1, bonus.cleanBatch ?? 1);
    let count = 0;
    for (let i = 0; i < batch; i += 1) {
      const cur = worldState.litter;
      if (!cur || cur.length === 0) break;
      const r = worldState.clean(cur[0].id);
      if (!r.ok) break;   // 清不掉就别空转，留给下一轮
      count += 1;
    }
    // name 必须带上：main.mjs 的 toast 要显示"谁完成的"（Bug⑥ —— 漏传就会拼出 "undefined 清理了垃圾"）
    if (count > 0) onEvent('clean-done', { type: s.type, name: defOf(s.type).name, count });
    s.cooldownUntil = now + actionCdOf(bonus);
  }

  function aiPurchaser(s, now, bonus = {}) {
    // 外出归来：执行挂起的采购单
    if (s.status === 'errand' && now >= s.errandUntil) {
      const p = s.pending;
      s.pending = null;
      s.status = 'idle';
      if (p) {
        /* 培训「采购溢价减免」：premium 是 economy.purchase 的第三个参数，
         * 直接乘在基础溢价上（0.15 × 0.4 = 0.06）。不在这里改货品进价 ——
         * 进价是 config 的单一真源，培训只动"这个人拿到的溢价"。 */
        const premium = (p.premium ?? 0) * (bonus.purchasePremiumMul ?? 1);
        const res = p.skuId
          ? economy.purchase(p.skuId, p.qty, premium)
          : economy.buyWarehouseGood(p.goodId, p.qty, premium);
        if (res.ok) onEvent('purchase-done', { type: s.type, staffName: defOf(s.type).name, good: p.goodId ?? 'snack', name: p.name });
      }
      s.cooldownUntil = now + actionCdOf(bonus);
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
    /* 培训「抄近路」：缩短往返。用乘法而不是减固定秒数 ——
     * 6s 是配置值，未来若调长/调短，百分比仍然表达同一种"快 25%"。 */
    s.errandUntil = now + STAFF.errandSec * (bonus.errandMul ?? 1);
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

  function aiStocker(s, now, bonus = {}) {
    // 1) 货架补货（backroom → 空货架格）
    /* 培训「理货进阶」的两个参数：
     *   batch     —— 一趟多搬几件（默认 PICK_BATCH 6）
     *   capExtra  —— 每格软上限往上加（economy 内部会 clamp 到 SLOT_CAP）
     * 都做成可选参数，economy 的旧调用方（玩家/测试）不传时行为完全不变。 */
    if (economy.restockShelfIfPossible({ capExtra: bonus.restockCapBonus ?? 0, batch: bonus.restockBatch })) {
      s.working = true;
      s.status = 'stock-shelf';
      onEvent('stock-done', { type: s.type, name: defOf(s.type).name, kind: 'shelf', label: '货架' });
      s.cooldownUntil = now + actionCdOf(bonus);
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
        s.cooldownUntil = now + actionCdOf(bonus);
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
      s.cooldownUntil = now + actionCdOf(bonus);
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
        /* 培训状态随快照一起给 HUD —— HUD 只读快照，不自己 import training，
         * 避免"面板算一套、AI 算另一套"的两套口径。 */
        const training = entry ? getBonuses(state, entry.id) : null;
        return {
          type,
          name: def.name,
          emoji: def.emoji,
          hireCost: def.hireCost,
          salary: def.salary,
          /* P1-9：每夜薪资 = 单次薪资 × 每夜扣薪次数（480/180 只够扣 2 次，第 3 次在打烊后）。 */
          salaryPerNight: def.salary * Math.floor(NIGHT_WALL_SECONDS / STAFF.salarySec),
          desc: def.desc,
          hired: !!entry,
          onDuty: entry ? entry.onDuty !== false : true,
          stamina: entry ? Math.round(entry.stamina) : 0,
          status: entry ? entry.status : 'idle',
          /* 培训：等级 / 总数 / 当前累计的夜产出与关键倍率（HUD 直接展示） */
          training: training ? {
            level: training.level,
            maxLevel: training.maxLevel,
            nightOutput: training.nightOutput,
            repairCostMul: training.repairCostMul,
            actionCdMul: training.actionCdMul,
            purchasePremiumMul: training.purchasePremiumMul,
            errandMul: training.errandMul,
            cleanBatch: training.cleanBatch,
            restockBatch: training.restockBatch,
            restockCapBonus: training.restockCapBonus,
          } : null,
        };
      }),
    };
  }

  return {
    hire, fire, canHire,
    setDuty, toggleDuty,
    update,
    snapshot,
    isStopped: () => stopped,
    /** 当前雇佣人数 */
    count: () => roster().length,
    /** 今夜上班人数（P1-9） */
    onDutyCount: () => roster().filter((m) => m.onDuty !== false).length,
  };
}
