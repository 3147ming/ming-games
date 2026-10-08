/**
 * 进货运输闭环（2026-10-06 块5）
 *
 * ── 状态机 ──────────────────────────────────────────────
 *   下单(order) ──45s──▶ 到货(arrived, 门口出现货箱) ──按E拾取(pickup)──▶ 手持箱
 *                                                                      │
 *                                                        按E对准库存箱(putaway)
 *                                                                      ▼
 *                                                          按 SKU 自动入 backroom
 *
 * ── 为什么不塞进 economy.purchase ────────────────────────
 *  purchase() 是"钱扣了、货到仓"的原子操作，采购员（staff.mjs）也在用它。
 *  运输闭环要拆成"扣钱（立即）→ 在途（45s）→ 到货（需搬）"三段，
 *  若改成 purchase 的新语义，采购员会被一起拖进等待。
 *  所以这里独立成一个模块，economy 只加一个薄薄的下单入口。
 *
 * ── 与手持系统的关系 ────────────────────────────────────
 *  玩家手上是"一箱"（含多个 SKU 的若干件），不是某个 SKU 的若干件 ——
 *  这与既有 state.held（{skuId, qty} 单 SKU 语义）不同，所以另用
 *  state.deliveryHeld 存整箱内容，**不改 held**：
 *  held 关联着"取货/上架/结账拒持"一整套既有逻辑（见 interaction.mjs），
 *  换成多 SKU 会把那一整套都拖进来重写，风险远大于收益。
 *
 * ── 纯逻辑、零 THREE / DOM（ADR-002）────────────────────
 *  货箱模型与提示由 scene/main 表现层读这里的状态渲染。
 */

import { DELIVERY, SKU_BY_ID, GARBAGE } from './config.mjs';

const numOr = (v, d) => (Number.isFinite(v) ? v : d);

/**
 * @param opts.state   state.mjs 单一真源
 * @param opts.onEvent (type, payload) —— 'order' | 'arrived' | 'pickup'
 *                            | 'putaway' | 'rejected'
 */
export function createDelivery(opts = {}) {
  const state = opts.state;
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};

  /** 读出状态容器（老存档没有就建） */
  function ensure() {
    if (!state.delivery || typeof state.delivery !== 'object') {
      state.delivery = { transit: [], crates: [], held: null };
    }
    const d = state.delivery;
    if (!Array.isArray(d.transit)) d.transit = [];
    if (!Array.isArray(d.crates)) d.crates = [];
    if (d.held !== null && typeof d.held !== 'object') d.held = null;
    return d;
  }

  /** 运费 = 固定 ¥4 + 每件 ¥0.5（需求指定的计费式） */
  function feeOf(qty) {
    return Math.round((DELIVERY.feeBase + DELIVERY.feePerItem * Math.max(0, numOr(qty, 0))) * 100) / 100;
  }

  /** 某单的总计 = 货值 + 运费（进货页要显示"运费"和"总计"） */
  function quoteOf(skuId, qty) {
    const sku = SKU_BY_ID[skuId];
    if (!sku) return null;
    const q = Math.max(0, numOr(qty, 0));
    const goods = Math.round(q * sku.cost * 100) / 100;
    const fee = feeOf(q);
    return { skuId, qty: q, goods, fee, total: Math.round((goods + fee) * 100) / 100 };
  }

  /**
   * 下单：立刻扣钱（含运费），货进入"在途"。
   * ⚠ 钱在**下单时**扣而不是到货时扣 —— 玩家已经提交了订单，
   *   钱就该离开账户（这也是"提前囤货要占资金"的决策成本）。
   *   如果到货才扣，玩家会同时下多单把资金超发。
   *
   * @param now 当前墙钟秒（用 state.wallElapsed 之外的真实时间，见 main 传参）
   */
  function order(skuId, qty, now) {
    const d = ensure();
    const sku = SKU_BY_ID[skuId];
    if (!sku) return { ok: false, reason: '未知商品' };
    const q = Math.round(numOr(qty, 0));
    if (q < sku.moq) return { ok: false, reason: `最低起订 ${sku.moq}` };
    const quote = quoteOf(skuId, q);
    if (quote.total > state.cash) return { ok: false, reason: '现金不足（含运费）' };
    /* 仓库容量仍要卡 —— 在途货也是未来的库存。
     * 注意只算**一次**总量：backroomTotal() 已经包含了该 sku 的存量，
     * 不要再叠一个 (state.backroom[skuId]|0)（那是重复计数）。 */
    if (backroomTotal() + q > warehouseCap()) return { ok: false, reason: '仓库容量已满' };

    state.cash -= quote.total;
    state.purchaseCost += quote.total;
    d.transit.push({
      uid: `D${Date.now().toString(36)}${d.transit.length}`,
      skuId,
      qty: q,
      /** 到货时刻（墙钟秒） */
      arriveAt: numOr(now, 0) + DELIVERY.transitSec,
      startedAt: numOr(now, 0),
    });
    onEvent('order', { skuId, qty: q, quote, transit: d.transit.length });
    return { ok: true, quote, eta: DELIVERY.transitSec };
  }

  function backroomTotal() {
    let n = 0;
    for (const id of Object.keys(state.backroom ?? {})) n += state.backroom[id] | 0;
    return n;
  }
  function warehouseCap() {
    /* 必须外部注入（economy.warehouseCap 是权威实现）。
     * 刻意**不给默认值**：写死一个 200 的话，economy 改了扩容表这里不跟，
     * 就会出现"扩容了但下单还是说仓库满"这种难查的错。 */
    if (typeof opts.warehouseCap === 'function') return opts.warehouseCap();
    // 没注入就不拦容量（宁可放过一次，也不要用一个错的数字拦住玩家）
    return Infinity;
  }

  /**
   * 拾取：把门口的货箱拿在手里。
   * 货箱堆满（maxCrates）时新到的货不进箱 —— 提示玩家先搬走，
   * 否则箱子会无声堆积、玩家不知道要搬几次。
   */
  function pickup(crateIndex = 0) {
    const d = ensure();
    const idx = numOr(crateIndex, 0);
    if (d.held) return { ok: false, reason: '手里已经有箱子了 · 先放到库存箱' };
    if (!d.crates.length) return { ok: false, reason: '门口没有货箱' };
    if (idx < 0 || idx >= d.crates.length) return { ok: false, reason: '货箱不存在' };
    const crate = d.crates[idx];
    // 合并多单：箱内是 { skuId: qty } 的字典
    const merged = {};
    for (const item of crate.items) merged[item.skuId] = (merged[item.skuId] | 0) + item.qty;
    d.held = { items: merged, pickedAt: d.crates[idx].arrivedAt };
    d.crates.splice(idx, 1);
    onEvent('pickup', { items: merged });
    return { ok: true, items: merged };
  }

  /**
   * 入仓：把手上的箱子里所有 SKU 自动放进 backroom。
   * 容量不足时**部分入仓**并明确告诉玩家入了多少 ——
   * 全部拒绝会让玩家陷入"箱子永远放不下"的死局。
   */
  function putaway() {
    const d = ensure();
    if (!d.held) return { ok: false, reason: '手里没有箱子' };
    const cap = warehouseCap();
    let free = cap - backroomTotal();
    const put = {};
    let left = {};
    let totalPut = 0, totalLeft = 0;
    for (const [skuId, qty] of Object.entries(d.held.items)) {
      const n = Math.max(0, qty | 0);
      if (n <= 0) continue;
      const putN = Math.min(n, free);
      if (putN > 0) {
        put[skuId] = putN;
        state.backroom[skuId] = (state.backroom[skuId] | 0) + putN;
        free -= putN;
        totalPut += putN;
      }
      if (putN < n) {
        left[skuId] = n - putN;
        totalLeft += n - putN;
      }
    }
    d.held = (totalLeft > 0) ? { items: left, pickedAt: 0 } : null;
    onEvent('putaway', { put, left, totalPut, totalLeft });
    /* 块6：每彻底拆完 1 个货箱 → 1 件垃圾（空箱）。
     * 用 totalLeft===0 守卫：货箱可能分两次入仓（首次满仓只放一部分），
     * 只有"这次把箱子彻底清空"才计 1 件，避免重复计数；totalPut>0 防"啥也没放"的空操作。 */
    if (totalLeft === 0 && totalPut > 0) {
      state.garbage = Math.min(GARBAGE.cap, (state.garbage | 0) + 1);
      // 垃圾堆积扣口碑（与清理加分对称；reputation 钳在 0~100）
      state.reputation = Math.max(0, Math.min(100, state.reputation - GARBAGE.repPenaltyPerItem));
    }
    if (totalPut === 0) return { ok: false, reason: '仓库已满', put, left };
    return { ok: true, put, left, totalPut, totalLeft };
  }

  /**
   * 每帧推进：把到期的在途单转成门口货箱。
   * @param now 墙钟秒
   */
  function update(now) {
    const d = ensure();
    const t = numOr(now, 0);
    let arrived = 0;
    /* ⚠ 必须**按 arriveAt 升序**处理，不能用倒序 splice。
     * 倒序遍历下，两单同一时刻到货时：后进的那单先被处理 → 箱子里还没有同 SKU →
     * 建一个新箱；先到的那单后处理 → 找到同 SKU 箱合并 → 结果是
     * "一个箱装 6 件 + 先前那个箱被吸收"，实测其中一单凭空消失。
     * 升序 + 边过滤边处理，两单同刻到货会正确合并成一个箱。 */
    const due = d.transit
      .filter((o) => t >= o.arriveAt)
      .sort((a, b) => a.arriveAt - b.arriveAt);
    if (!due.length) return 0;
    const dueSet = new Set(due);
    d.transit = d.transit.filter((o) => !dueSet.has(o));

    for (const o of due) {
      if (d.crates.length >= DELIVERY.maxCrates) {
        /* 箱子满了但货已到 —— 不丢单，退回在途等玩家搬走。
         * arriveAt 推后 2s 重试：update 每帧都调，2s 后玩家若已搬走就能进来。 */
        o.arriveAt = t + 2;
        d.transit.push(o);
        onEvent('rejected', { reason: '门口货箱已满 · 请先搬走', skuId: o.skuId, qty: o.qty });
        continue;
      }
      /* 合并到已有箱子（同 SKU 归一堆；散装多个箱子反而更乱） */
      const exist = d.crates.find((c) => c.items.some((it) => it.skuId === o.skuId));
      if (exist) {
        const item = exist.items.find((it) => it.skuId === o.skuId);
        item.qty += o.qty;
      } else {
        d.crates.push({ items: [{ skuId: o.skuId, qty: o.qty }], arrivedAt: t });
      }
      arrived += 1;
      onEvent('arrived', { skuId: o.skuId, qty: o.qty, crates: d.crates.length });
    }
    d.transit.sort((a, b) => a.arriveAt - b.arriveAt);
    return arrived;
  }

  /** 展示数据（进货页"在途"标签 / HUD 提示 / 门口箱子） */
  function panel() {
    const d = ensure();
    return {
      transit: d.transit.map((o) => ({
        uid: o.uid,
        skuId: o.skuId,
        qty: o.qty,
        /** 剩余到达时间（秒） */
        left: Math.max(0, Math.ceil(o.arriveAt - numOr(state.wallElapsed, 0))),
      })),
      crates: d.crates.map((c) => ({
        items: c.items.map((it) => ({ skuId: it.skuId, qty: it.qty })),
        total: c.items.reduce((s, it) => s + it.qty, 0),
      })),
      held: d.held ? { items: d.held.items, total: Object.values(d.held.items).reduce((s, n) => s + (n | 0), 0) } : null,
      maxCrates: DELIVERY.maxCrates,
      feeBase: DELIVERY.feeBase,
      feePerItem: DELIVERY.feePerItem,
    };
  }

  function reset() {
    state.delivery = { transit: [], crates: [], held: null };
  }

  return { ensure, quoteOf, feeOf, order, pickup, putaway, update, panel, reset };
}
