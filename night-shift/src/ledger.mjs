/**
 * 结算账本（打烊结算的"事件类条目"收集器）
 *
 * ── 为什么单独成模块 ──────────────────────────────────────
 * 需求要求"事件类条目单列一行"：主题加成扣减、抉择事件后果、限时促销让利、
 * 临期损耗、环境互动外快……这些钱**不是**营业收入，也不是采购成本，
 * 它们各自有各自的来处（themes / choices / pricing / ambient 四个互不相识的模块）。
 *
 * 如果让每个模块自己去改 report 对象，settleNight 就得认识所有模块 —— 那是反向依赖。
 * 所以这里做一层极薄的收口：谁产生了"非常规收支"就往账本里记一笔，
 * settleNight 只负责把账本原样列出来。
 *
 * ── 设计约束 ────────────────────────────────────────────
 * 1) **同一 key 累加而不是新增一行**：一夜里"雨夜小费"会发生十几次，
 *    结算里应该是"雨夜额外小费 +¥xx"一行，而不是十几行。
 * 2) **纯数据**：账本存在 state.ledger（数组，可 JSON 化），打烊后由 resetForNewNight 清空。
 * 3) **不改动净利口径**：账本里的条目**同时**已经真实地改过 state.cash
 *    （比如小费在 checkout 里就加进了现金），所以结算时**不再二次加减**，
 *    只是把它们从"营业收入"里拆出来单独展示 —— 否则会重复计一次。
 */

const numOr = (v, d = 0) => (Number.isFinite(v) ? v : d);

/**
 * @param {object} state 全局状态（ADR-002 单一真源）
 * @param {object} opts
 * @param {(key:string,entry:object)=>void} opts.onAdd 记账回调（HUD 提示 / 音效）
 */
export function createLedger(state, opts = {}) {
  const onAdd = typeof opts.onAdd === 'function' ? opts.onAdd : null;

  const list = () => {
    if (!Array.isArray(state.ledger)) state.ledger = [];
    return state.ledger;
  };

  return {
    /**
     * 记一笔（同 key 累加）。
     * @param key   稳定标识（如 'theme.tip' / 'choice.wallet'）
     * @param label 结算里显示的中文名
     * @param value 金额（正 = 收入，负 = 支出）
     * @param kind  'event'（默认，事件类）| 'theme' | 'choice' | 'promo' | 'ambient'
     */
    add(key, label, value, kind = 'event') {
      if (!key) return null;
      const v = numOr(value);
      // 0 元不记：结算里出现一堆 "+¥0" 只会让人以为是 bug
      if (Math.abs(v) < 0.005) return null;
      const l = list();
      const hit = l.find((e) => e.key === key);
      if (hit) {
        hit.value += v;
        if (label) hit.label = label;
        hit.count = (hit.count ?? 1) + 1;
      } else {
        const e = { key, label: label ?? key, value: v, kind, count: 1 };
        l.push(e);
        onAdd?.(key, e);
        return e;
      }
      onAdd?.(key, hit);
      return hit;
    },

    /** 覆盖式写入（同一夜只会发生一次的事件用这个，避免重复累加） */
    set(key, label, value, kind = 'event') {
      const l = list();
      const i = l.findIndex((e) => e.key === key);
      const e = { key, label: label ?? key, value: numOr(value), kind, count: 1 };
      if (i >= 0) l[i] = e;
      else l.push(e);
      onAdd?.(key, e);
      return e;
    },

    /** 当前账本条目（副本，防止调用方改坏） */
    entries() {
      return list().map((e) => ({ ...e }));
    },

    /** 只看某一类 */
    byKind(kind) {
      return list().filter((e) => (e.kind ?? 'event') === kind).map((e) => ({ ...e }));
    },

    /** 合计（可限定 kind） */
    sum(kind = null) {
      return list()
        .filter((e) => (kind ? (e.kind ?? 'event') === kind : true))
        .reduce((a, e) => a + numOr(e.value), 0);
    },

    /** 打烊 / 新一夜时清空 */
    clear() {
      state.ledger = [];
    },

    /** 取单个条目（供 HUD 显示进度，如"促销让利已累计 -¥12"） */
    get(key) {
      const e = list().find((x) => x.key === key);
      return e ? { ...e } : null;
    },
  };
}

export default createLedger;
