/**
 * 经济系统：进货 / 库存 / 收银 / 结算 / 升级
 * 对应 SYS-01（restock）、SYS-02（inventory）、SYS-04（settlement）
 * 纯逻辑，不碰 DOM 与 Three API（ADR-002），便于将来在 Node 里单测。
 */
import {
  SKUS, SKU_BY_ID, SLOT_CAP, PICK_BATCH, RENT_PER_NIGHT,
  STAR_THRESHOLDS, UPGRADES, COFFEE_BONUS, NIGHTS_PER_WEEK,
  REP_SERVE, REP_LOST, CLERK, EVENTS, SNACK, WAREHOUSE, GARBAGE,
  FIRST_NIGHT_SPEND_MUL, IDENTITIES,
} from './config.mjs';
import { state, expandSlots, notify } from './state.mjs';
import { isFestival } from './themes.mjs';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** 当前已解锁可售的 SKU（第 4 个需升级解锁；节日礼盒仅节日夜可售可进）
 *
 *  2026-10-06：`locked` 的语义从布尔扩展为**字符串 = 借用哪把升级钥匙**
 *  （口香糖/电池/杂志写 locked:'grocery'，即"跟着杂货一起解锁"）。
 *  这里必须跟着改：原来 `!s.locked || state.upgrades[s.id]` 拿字符串当 key 去查
 *  upgrades（值恒 undefined）⟹ 三个新 SKU 永远进不了货页也上不了架。
 *  布尔写法仍然兼容（`s.locked === true` 走原路径）。 */
export function availableSkus() {
  return SKUS.filter((s) => {
    if (s.festivalOnly) return isFestival(state.themeId);   // 2026-10-05 C：节日限定
    if (!s.locked) return true;
    // 字符串 locked = 借用另一把升级钥匙；布尔 true = 用自己的 id
    const key = s.locked === true ? s.id : s.locked;
    return !!state.upgrades[key];
  });
}

/* ---------- 库存查询（SYS-02 §2） ---------- */
export function sellable(skuId) {
  let sum = 0;
  for (const s of state.slots) {
    if (s.skuId === skuId && state.night <= s.expiryNight) sum += s.qty;
  }
  return sum;
}

/** FIFO 扣减：优先扣**数量最少**的同类货架格（2026-10-05 反馈：
 * "买东西时优先消耗数量最少的同类货架" —— 数量少的格先清空，货架更整齐、
 * 且避免个别格越堆越多）。同数量时按到期先后（过期早的先扣）保证不积压临期。 */
function fifoDeduct(skuId, k) {
  let remain = k;
  const same = state.slots
    .map((s, i) => ({ s, i }))
    .filter((o) => o.s.skuId === skuId && o.s.qty > 0)
    .sort((a, b) => (a.s.qty - b.s.qty) || (a.s.expiryNight - b.s.expiryNight));
  for (const { s } of same) {
    if (remain <= 0) break;
    const d = Math.min(s.qty, remain);
    s.qty -= d;
    remain -= d;
    if (s.qty <= 0) {
      s.skuId = null;
      s.qty = 0;
    }
  }
  return k - remain; // 实际扣掉的数量
}

/* ---------- 仓库容量（需求J） ---------- */
/** backroom 库存箱现有总件数（零食饮料类） */
export function backroomTotal() {
  let n = 0;
  for (const id of Object.keys(state.backroom)) n += state.backroom[id] | 0;
  return n;
}
/** 当前仓库容量上限（按扩容等级查表） */
export function warehouseCap() {
  const tier = WAREHOUSE.tiers[state.warehouse?.level ?? 0] ?? WAREHOUSE.tiers[0];
  return tier.cap;
}
/** 仓库已用容量 = backroom 总件数 + 玩具/鱼饵/维修耗材 */
export function warehouseUsed() {
  const g = state.warehouse?.goods ?? { toy: 0, bait: 0, parts: 0 };
  return backroomTotal() + (g.toy | 0) + (g.bait | 0) + (g.parts | 0);
}
/** 仓库剩余容量 */
export function warehouseFree() {
  return Math.max(0, warehouseCap() - warehouseUsed());
}

/* ---------- 采购（SYS-01 §2） ---------- */
export function purchase(skuId, qty, premium = 0) {
  const sku = SKU_BY_ID[skuId];
  if (!sku) return { ok: false, reason: '未知商品' };
  /* 2026-10-05 C：节日礼盒仅节日夜可进（进货页已过滤，这里兜底防绕过） */
  if (sku.festivalOnly && !isFestival(state.themeId)) return { ok: false, reason: '节日礼盒仅节日夜可进' };
  if (qty < sku.moq) return { ok: false, reason: `最低起订 ${sku.moq}` };
  const cost = Math.round(qty * sku.cost * (1 + premium));
  if (cost > state.cash) return { ok: false, reason: '现金不足' };
  // 需求J：仓库容量上限（零食饮料计入 backroom 总件数）
  if (backroomTotal() + qty > warehouseCap()) return { ok: false, reason: '仓库容量已满' };
  state.cash -= cost;
  state.purchaseCost += cost;
  // |0 兜底：老存档/新 SKU 的 backroom 可能没有该键，直接 += 会 NaN
  state.backroom[skuId] = (state.backroom[skuId] | 0) + qty;
  notify();
  return { ok: true, cost, qty, sku };
}

/**
 * 需求J：直接购买仓库独立计数的三类货品（玩具 / 鱼饵 / 维修耗材）。
 * 零食饮料(snack) 不在此函数 —— 它走 purchase() 进 backroom。
 * @param goodId 'toy' | 'bait' | 'parts'
 */
export function buyWarehouseGood(goodId, qty, premium = 0) {
  const good = WAREHOUSE.goods[goodId];
  if (!good) return { ok: false, reason: '未知货品' };
  if (qty < 1) return { ok: false, reason: '数量至少 1' };
  const cost = Math.round(qty * good.cost * (1 + premium));
  if (cost > state.cash) return { ok: false, reason: '现金不足' };
  if (warehouseUsed() + qty > warehouseCap()) return { ok: false, reason: '仓库容量已满' };
  state.cash -= cost;
  state.purchaseCost += cost;
  state.warehouse.goods[goodId] = (state.warehouse.goods[goodId] | 0) + qty;
  notify();
  return { ok: true, cost, qty, good };
}

/** 扩容仓库到下一等级（Tab 仓库面板调用） */
export function upgradeWarehouse() {
  const cur = state.warehouse?.level ?? 0;
  const next = WAREHOUSE.tiers[cur + 1];
  if (!next) return { ok: false, reason: '已是最大容量' };
  if (next.cost > state.cash) return { ok: false, reason: '现金不足' };
  state.cash -= next.cost;
  state.warehouse.level = next.level;
  notify();
  return { ok: true, level: next.level, cap: next.cap, cost: next.cost };
}

/**
 * 员工（上货员 / 采购员）补货时的**软上限**：单格最多补到 SLOT_CAP 的 80%（24 → 20）。
 *
 * 为什么必须比 SLOT_CAP 低：员工只要看到 `slot.qty < SLOT_CAP` 就一直补，会把每格顶到 24。
 * 玩家从库存箱取一批货（PICK_BATCH 件）回来时，所有格都是满的 → place() 返回"该格已满"，
 * 而当时又没有任何"手持 → 放回库存箱"的出口 → 货永久卡在手上（打烊时既不算售出也不算报废，
 * 凭空蒸发）。留 4 件空位 = 至少能塞下一批货的头几件，把死锁从根上消掉。
 * 用 ceil 保证小 SLOT_CAP 时也至少比上限少 1（不会出现"软上限 == 硬上限"）。
 */
export const STAFF_SLOT_CAP = Math.ceil(SLOT_CAP * 0.8);

/** 当前已解锁可售的 SKU id 列表（内部小工具，避免重复 map） */
function availableSkuIds() {
  return availableSkus().map((s) => s.id);
}

/**
 * 需求J：上货员用 —— 把库存箱里一件货品上到空货架格（或同 SKU 未满的格）。
 * 找不到可上的就返回 false（上货员据此判断"无事可做"，原地待命）。
 *
 * 补货优先级：
 *   ① 有临期货（state.expiringTonight 的 SKU）优先补它 —— 今夜卖不掉就全额报废，
 *      摆上货架至少还有机会成交（临期货进价已三折，优先清它是纯赚）。
 *   ② 每格只补到 STAFF_SLOT_CAP（80%），剩下的空位是留给玩家的（见 STAFF_SLOT_CAP 注释）。
 */
export function restockShelfIfPossible() {
  if (state.held) return false; // 手上已有货时不抢
  const ids = availableSkuIds();
  // 临期货优先：这一夜必须清掉的 SKU，员工先替玩家把它摆出去
  const expiringId = state.expiringTonight?.skuId ?? null;
  const skuId = (expiringId && ids.includes(expiringId) && (state.backroom[expiringId] | 0) > 0)
    ? expiringId
    : ids.find((id) => state.backroom[id] > 0);
  if (!skuId) return false;
  // 找一个空格 / 同 SKU 未满软上限的格
  const slotIndex = state.slots.findIndex((s) =>
    (!s.skuId && s.qty === 0) || (s.skuId === skuId && s.qty < STAFF_SLOT_CAP));
  if (slotIndex < 0) return false;
  // 必须按挑好的 SKU 取：take() 默认是"箱子里第一个有货的"，不指定会取错商品
  const t = take(skuId);
  if (!t.ok) return false;
  const p = place(slotIndex);
  if (!p.ok) {
    // 放回手里失败：把货退回库存箱（take 已扣 backroom，held 还在手上）
    if (state.held) {
      state.backroom[state.held.skuId] = (state.backroom[state.held.skuId] | 0) + state.held.qty;
      state.held = null;
      notify();
    }
    return false;
  }
  /* place() 是"有多少空位塞多少"，它不知道员工这套软上限（玩家上货走的是同一个 place）。
   * 所以补完把超出的部分吐回库存箱：既保证员工永不超过 80%，又不给 place 加特殊分支。 */
  const slot = state.slots[slotIndex];
  const over = slot.qty - STAFF_SLOT_CAP;
  if (over > 0) {
    slot.qty -= over;
    state.backroom[skuId] = (state.backroom[skuId] | 0) + over;
    notify();
  }
  return true;
}

/* ---------- 娱乐设施收支（小游戏投币 / 兑奖） ---------- */
/** 是否付得起 */
export function canAfford(amount) {
  return state.cash >= amount;
}

/** 扣现金（付不起时返回 false，不产生副作用） */
export function payCash(amount) {
  if (amount <= 0) return true;
  if (state.cash < amount) return false;
  state.cash -= amount;
  notify();
  return true;
}

/** 加现金（小游戏收益单独记账，不混入门店 revenue） */
export function earnCash(amount) {
  if (amount <= 0) return false;
  state.cash += amount;
  // 需求I ②：累计收入单独记账，供"单日赚取金币"限时任务做差分（quests 进度=当前−baseline）。
  // 与 state.revenue（结算时才汇总）解耦，保证任务进度在营业途中就能实时推进。
  state.earned += amount;
  notify();
  return true;
}

/* ---------- 取货 / 上货（SYS-01 §2） ---------- */
/**
 * 取货：backroom → held（批量 PICK_BATCH）
 *
 * @param preferSkuId 可选 · 指定优先取的 SKU（员工补货要按自己挑好的 SKU 取）。
 *   不传时行为与以前完全一致（取箱子里第一个有货的），
 *   这样就必须传明确的 id 才会改变取货顺序 —— 不会顺手把别的线程的取货逻辑改坏。
 */
export function take(preferSkuId) {
  if (state.held) return { ok: false, reason: '手中已有货物' };
  const ids = availableSkuIds();
  const skuId = (preferSkuId && ids.includes(preferSkuId) && (state.backroom[preferSkuId] | 0) > 0)
    ? preferSkuId
    : ids.find((id) => state.backroom[id] > 0);
  if (!skuId) return { ok: false, reason: '库存箱已空，先采购（Tab）' };
  const qty = Math.min(PICK_BATCH, state.backroom[skuId]);
  state.backroom[skuId] -= qty;
  state.held = { skuId, qty };
  notify();
  return { ok: true, skuId, qty, sku: SKU_BY_ID[skuId] };
}

/** 上货：held → 货架格 */
export function place(slotIndex) {
  const slot = state.slots[slotIndex];
  if (!slot) return { ok: false, reason: '货架格不存在' };
  if (!state.held) return { ok: false, reason: '手上没有货物' };
  if (slot.skuId && slot.skuId !== state.held.skuId) {
    return { ok: false, reason: '该格已有其他商品' };
  }
  /* 满格不给放，但**必须指一条明路**：早期这里只报"该格已满"，玩家拿着货满店乱转，
   * 那时又没有"放回库存箱"，手里的货就永久卡死。现在文案直接给出解法，held 保持原样不动。 */
  if (slot.qty >= SLOT_CAP) return { ok: false, reason: '货架已满，对准库存箱按 E 放回' };
  const room = SLOT_CAP - slot.qty;
  const put = Math.min(room, state.held.qty);
  const prevEmpty = !slot.skuId;
  slot.skuId = state.held.skuId;
  slot.qty += put;
  if (prevEmpty) slot.placedAtNight = state.night;
  // 保质期：上货当夜起算（SYS-02 §2）
  const life = effectiveShelfLife(state.held.skuId);
  slot.expiryNight = slot.placedAtNight + life;
  state.held.qty -= put;
  if (state.held.qty <= 0) state.held = null;
  notify();
  return { ok: true, put, slotIndex, sku: SKU_BY_ID[slot.skuId] };
}

/**
 * 放回库存箱：held → backroom（整批退回，与 take() 严格对称）。
 *
 * 为什么必须有这条：货架被顶满时 place() 会失败，而失败又不能丢货 → 手里的货没有任何出口。
 * 库存守恒要求"手上的 qty"永远能回到它来的地方，否则这批货会在打烊结算时凭空消失。
 */
export function returnHeld() {
  if (!state.held) return { ok: false, reason: '手上没有货物' };
  const skuId = state.held.skuId;
  const qty = state.held.qty;
  state.backroom[skuId] = (state.backroom[skuId] | 0) + qty;
  state.held = null;
  notify();
  // returned 标记：main 的 E 键分支靠它区分"取货"和"放回"（两者都带 qty）
  return { ok: true, returned: true, skuId, qty, sku: SKU_BY_ID[skuId] };
}

/* ---------- 临期货清仓（2026-10-05 B 方案） ---------- */
/**
 * 半价清掉某格**今夜到期**的货（玩家主动止损，不再只能等打烊自动报废）。
 * 只对 expiryNight <= state.night 的格子生效；非临期格一律拒绝。
 * 收入按半价计（售价 × 0.5），格内货物清空、格子变空货架。
 * 不记 served（没服务顾客），只入 cash/revenue。
 */
export function clearanceSell(slotIndex) {
  const slot = state.slots[slotIndex];
  if (!slot || !slot.skuId || slot.qty <= 0) return { ok: false, reason: '货架是空的' };
  if (slot.expiryNight > state.night) return { ok: false, reason: '不是临期货（今夜才到期）' };
  const sku = SKU_BY_ID[slot.skuId];
  if (!sku) return { ok: false, reason: '未知商品' };
  const unit = state.prices?.[slot.skuId] ?? sku.price;
  const qty = slot.qty;
  const amount = Math.round(qty * unit * 0.5 * 100) / 100;
  state.cash += amount;
  state.revenue += amount;
  slot.qty = 0;
  slot.skuId = null;          // 清空成空货架（视觉同步走 updateSlotVisual 脏检查）
  notify();
  /* 块6：临期清仓每清 1 格 → 1 件垃圾（清仓半价的回收金已算"略回血"补偿）。
   * rep 扣减与拆箱一致（堆积扣分）。 */
  state.garbage = Math.min(GARBAGE.cap, (state.garbage | 0) + 1);
  state.reputation = clamp(state.reputation - GARBAGE.repPenaltyPerItem, 0, 100);
  /* slotIndex 一并返回（2026-10-06 块3）：表现层要靠它给"被清的那一格"播
   * 变暗→清空动画。逻辑层不该知道有动画，但"是哪一格"是纯逻辑事实，
   * 所以在这里给出、由 main 转给 scene —— 与 sku/qty/amount 同一性质。 */
  return { ok: true, clearance: true, qty, amount, sku, slotIndex };
}

function effectiveShelfLife(skuId) {
  const base = SKU_BY_ID[skuId]?.shelfLife ?? 1;
  // 冰柜升级：便当 1 → 2 夜（SYS-04 §2）
  if (skuId === 'bento' && state.upgrades.fridge) return 2;
  return base;
}

/* ---------- 收银（SYS-03 / SYS-06） ---------- */

/**
 * 结账时的**临时**价格修正（限时促销 / 夜间主题折扣 + 售价带来的满意度微调）。
 *
 * 为什么用注入而不是直接 import pricing：
 *   economy 是核心循环模块，直接依赖"定价"这个扩展模块会把依赖方向搞反
 *   （扩展层应该依赖核心层，不是反过来）。注入后 economy 保持零新增依赖，
 *   默认 hook 为 null → 行为与扩展前完全一致（economy.test 的断言不受影响）。
 */
let checkoutHook = null;
export function setCheckoutHook(fn) {
  checkoutHook = typeof fn === 'function' ? fn : null;
}

/** 结账成功旁路回调（2026-10-06 块2：常客复购 → 忠诚度）。同 checkoutHook 的注入理由。 */
let checkoutDoneHook = null;
export function setCheckoutDoneHook(fn) {
  checkoutDoneHook = typeof fn === 'function' ? fn : null;
}

/** 结算扩展（主题条目 / 事件账本 / 星级）—— 同上，注入而非直接依赖 */
let settleExtrasHook = null;
export function setSettleExtras(fn) {
  settleExtrasHook = typeof fn === 'function' ? fn : null;
}

export function checkout() {
  if (state.blackoutUntil !== null && state.wallElapsed < state.blackoutUntil) {
    return { ok: false, reason: '⚡ 停电中，无法结账' };
  }
  /* 手持货物不能收银：结账是"收钱 + 找零"的动作，占着手就等于同时做两件事。
   * 更重要的是它给了"卡手的货"一个明确出口 —— 提示文案直接指向库存箱（按住 state.held
   * 不放的原因多半就是货架满了，玩家正需要被提醒去放回）。 */
  if (state.held) return { ok: false, reason: '先放下手中的货物（对准库存箱按 E 放回）' };
  const headId = state.queue[0];
  const customer = state.customers.find((c) => c.id === headId);
  if (!customer) return { ok: false, reason: '没有等待结账的顾客' };

  /* 块7：组合购买 —— 顾客可能带着「主件 + 搭配件」的购物篮。
   * 逐件 FIFO 扣减；只要有一件能买到就视为成交，按「合计 × 身份消费倍率」收款。
   * 兼容旧路径：无 items 时退回单件（{skuId, qty}）。 */
  const cart = (customer.items && customer.items.length)
    ? customer.items
    : [{ skuId: customer.skuId, qty: customer.qty }];
  let subtotalUnit = 0;   // 不含小费/夜首/身份的本金合计（∑ got_i * unit_i * adjMul_i）
  let totalGot = 0;
  let repDeltaSum = 0;
  let tipMul = 1;
  const fulfilled = [];   // 实际卖出的明细（传给 checkoutDoneHook 供任务板/忠诚度逐件判定）
  for (const item of cart) {
    const sku = SKU_BY_ID[item.skuId];
    if (!sku) continue;
    const unit = state.prices[item.skuId] ?? sku.price;
    const got = fifoDeduct(item.skuId, item.qty);
    if (got <= 0) continue;  // 该件缺货：跳过（不强制整单失销）
    /* 临时折扣（促销 / 主题 / 常客忠诚度）与"售价高于建议价"的满意度微调。
     * 只在这里乘，不改 state.prices —— 否则过期后要记着恢复，中途存档会留下脏价格。
     * 2026-10-06：hook 第二个参数传整个 customer（常客忠诚度需知 faceId）。 */
    const adj = checkoutHook?.(item.skuId, customer) ?? { mul: 1, repDelta: 0 };
    subtotalUnit += got * unit * (adj.mul ?? 1);
    repDeltaSum += adj.repDelta ?? 0;
    if ((adj.tipMul ?? 1) > tipMul) tipMul = adj.tipMul ?? 1;
    totalGot += got;
    fulfilled.push({ skuId: item.skuId, qty: got });
  }
  if (totalGot <= 0) {
    // 一件都卖不出 → 失销
    removeFromQueue(customer.id);
    customer.phase = 'leaving';
    state.lostSales += 1;
    state.reputation = clamp(state.reputation + REP_LOST, 0, 100);
    notify();
    return { ok: false, reason: '该商品已售完，顾客离开' };
  }
  /* 首夜单次消费 +20%（用户要求的数值调整）：只作用于第 1 夜。
   * 目的很具体 —— 让第一夜买得起货和道具，而不是全局抬营收；
   * 若做成全局倍率，整套经济曲线都要重新标定，前面调好的平衡会全废。 */
  const nightMul = state.night === 1 ? FIRST_NIGHT_SPEND_MUL : 1;
  /* 块7：身份消费倍率（只乘总额，不动定价 —— 见 config.IDENTITIES 注释） */
  const identityMul = IDENTITIES[customer.identityId]?.spendMul ?? 1;
  const tipBase = customer.isRegular ? EVENTS.REGULAR.tip : 1;
  /* 块6：店内垃圾 ≥ tipThreshold 件 → 小费减半（顾客嫌脏，懒得给小费）。
   * 只压"小费那部分"，不动本金（与主题/常客折扣同一处理层级）。 */
  const tipPenalty = state.garbage >= GARBAGE.tipThreshold ? 0.5 : 1;
  const tip = 1 + (tipBase - 1) * tipMul * tipPenalty;   // 雨夜等主题只放大"小费那部分"，不动本金
  const amount = subtotalUnit * tip * nightMul * identityMul;
  /* 小费单独累计（打烊结算要单列"其中小费"一行）。
   * 口径：实际收款 − 不含小费的应收。促销/主题折扣压低的是本金，不该算成小费变少。 */
  const noTip = subtotalUnit * nightMul * identityMul;
  state.tips = (Number.isFinite(state.tips) ? state.tips : 0) + Math.max(0, amount - noTip);
  state.cash += amount;
  state.revenue += amount;
  state.served += 1;
  let repGain = customer.isRegular ? EVENTS.REGULAR.repGain : REP_SERVE;
  repGain += repDeltaSum;
  // 软惩罚（§1.3）：心理 <30 时标准结账声誉增益减半；常客专属奖励不受影响
  if (!customer.isRegular && state.clerk && state.clerk.mental < CLERK.thr.mental) repGain *= 0.5;
  state.reputation = clamp(state.reputation + repGain, 0, 100);
  removeFromQueue(customer.id);
  customer.phase = 'leaving';
  /* 情绪反馈（需求「结账满意冒绿色爱心」）：只挂状态，怎么画由表现层决定 ——
   * 逻辑层不碰 DOM/THREE（ADR-002），main 会把 mood 映射成头顶图标。 */
  customer.mood = 'happy';
  customer.moodT = 2.6;
  /* 2026-10-06 块2：结账成功的旁路回调（常客复购记忠诚度等）。
   * 用注入而不是直接 import regulars：与 checkoutHook 同一个理由（依赖方向），
   * economy 不该认识"常客"这个扩展层概念。
   * 回调拿得到 faceId / 明细 items / 最终收款，够上层算忠诚度与飘字了。 */
  if (checkoutDoneHook) {
    try {
      checkoutDoneHook({
        faceId: customer.faceId ?? null,
        skuId: fulfilled[0]?.skuId ?? customer.skuId,
        qty: totalGot,
        amount,
        isRegular: !!customer.isRegular,
        customer,
        items: fulfilled,
        identityId: customer.identityId ?? null,
      });
    } catch (e) {
      // 回调是"锦上添花"（记个忠诚度），绝不能因为它抛错而让玩家这笔账结不成
      console.warn('[economy] checkoutDoneHook 异常（已忽略）', e);
    }
  }
  notify();
  return {
    ok: true,
    amount,
    sku: SKU_BY_ID[fulfilled[0]?.skuId ?? customer.skuId],
    qty: totalGot,
    items: fulfilled,
    isRegular: !!customer.isRegular,
    identityId: customer.identityId ?? null,
  };
}

export function removeFromQueue(id) {
  const i = state.queue.indexOf(id);
  if (i >= 0) state.queue.splice(i, 1);
}

/* ---------- R2 小吃摊：买宵夜（§2.3） ---------- */
/** 现金漏出换饱食度（解除 S 恢复闸的投资）。前置：现金≥15 且手持为空。 */
export function purchaseSnack() {
  if (state.cash < SNACK.price) return { ok: false, reason: '现金不足' };
  if (state.held) return { ok: false, reason: '先放下手中的货物' };
  state.cash -= SNACK.price;
  state.clerk.satiety = Math.min(100, state.clerk.satiety + SNACK.satietyGain);
  notify();
  return { ok: true, satiety: SNACK.satietyGain };
}

/* ---------- 夜末结算（SYS-04 §2） ---------- */
export function settleNight() {
  // 1) 过期报废（SYS-02 §2）
  let loss = 0;
  for (const s of state.slots) {
    if (s.skuId && state.night > s.expiryNight && s.qty > 0) {
      loss += s.qty * (SKU_BY_ID[s.skuId]?.cost ?? 0);
      s.skuId = null;
      s.qty = 0;
    }
  }
  state.loss = loss;

  // 2) 咖啡机被动增益
  const coffee = state.upgrades.coffee ? COFFEE_BONUS : 0;
  if (coffee) {
    state.cash += coffee;
    state.revenue += coffee;
  }

  // 3) 房租（漏出，防失控）
  const rent = RENT_PER_NIGHT;
  const cashBefore = state.cash;
  state.cash = cashBefore - loss - rent;

  // 4) 净利（采购成本在采购时已扣现金，此处不重复扣减 —— SYS-04 §8）
  //    小游戏净额单独计一行：它不该被算成"门店营收"，但要计入当晚盈亏
  const miniNet = state.minigameEarn - state.minigameSpend;
  const netProfit = state.revenue + miniNet - (state.purchaseCost + loss + rent);

  // 5) 星级（成交率）
  const attempts = state.served + state.lostSales;
  const rate = attempts > 0 ? state.served / attempts : 0;
  let stars = 0;
  if (attempts > 0) {
    if (rate >= STAR_THRESHOLDS[0]) stars = 3;
    else if (rate >= STAR_THRESHOLDS[1]) stars = 2;
    else if (rate >= STAR_THRESHOLDS[2]) stars = 1;
  } else {
    stars = state.reputation >= 50 ? 1 : 0;
  }

  /* 扩展段（主题 / 事件账本 / 星级 / 临期损耗）：由 main 注入，economy 不认识这些模块。
   * 缺省为空对象 → 报告字段与扩展前完全一致（economy.test 的断言不受影响）。 */
  const extras = settleExtrasHook?.() ?? {};

  const report = {
    night: state.night,
    revenue: state.revenue,
    purchaseCost: state.purchaseCost,
    loss,
    rent,
    coffee,
    netProfit,
    served: state.served,
    lostSales: state.lostSales,
    rate,
    stars,
    reputation: Math.round(state.reputation),
    cashBefore,
    cashEnd: state.cash,
    ...extras,
  };
  state.lastReport = report;

  // 6) 周目标判定（软目标：撑过一周不破产，无硬 game over）
  const bankrupt = state.cash < 0;
  if (state.night >= NIGHTS_PER_WEEK) {
    state.weekPassed = !bankrupt;
    state.phase = 'weekEnd';
  } else {
    state.phase = bankrupt ? 'weekEnd' : 'settle';
    if (bankrupt) state.weekPassed = false;
  }
  notify();
  return report;
}

/** 进入下一夜 */
export function nextNight() {
  state.night += 1;
  state.phase = 'settle'; // 由 main 调用 resetForNewNight 转入 running
  notify();
}

/* ---------- 升级（SYS-04 §2） ---------- */
export function buyUpgrade(id) {
  const up = UPGRADES.find((u) => u.id === id);
  if (!up) return { ok: false, reason: '未知升级' };
  if (state.upgrades[id]) return { ok: false, reason: '已购买' };
  if (up.cost > state.cash) return { ok: false, reason: '现金不足' };
  state.cash -= up.cost;
  state.upgrades[id] = true;
  if (id === 'slot') expandSlots(4);
  // grocery：解锁第 4 个 SKU（availableSkus() 会自动放行）
  notify();
  return { ok: true, up };
}
