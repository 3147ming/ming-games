/**
 * 跨周纪录（内容批 P1-3）—— 本机历史最好成绩 + 最近七夜流水
 *
 * ── 为什么单独成键 ──────────────────────────────────────────
 * 存档（save.mjs）是**账号级**的"这一世进度"，重开账号必须一起清掉；
 * 而"本机历史最好成绩"是**设备级**的纪念册 —— 重开之后玩家仍然想知道
 * "我上次最高净利是多少"。两者生命周期不同，所以刻意分键存放：
 *   · save.mjs      的 nightshift.save.v1.<accountId>  → 随重开清空
 *   · records.mjs   的 nightshift.records.v1           → 重开保留
 * reset.mjs 的 RESET_SCOPE.keeps 里明确写了这一条（见该文件）。
 *
 * ── 为什么只留最近七夜 ─────────────────────────────────────
 * 周终面板要画"本周七夜"条形图，超过 7 条的数据在这个用途上是噪音；
 * 每夜一条、按 night 去重（重打本夜会覆盖同一条，而不是叠加），
 * 于是"最近 7 条"恰好就是"最近一个完整周"。
 *
 * ── 纯逻辑、零 THREE / 零 DOM ──────────────────────────────
 * storage 可注入（getItem/setItem），因此可在 Node 里单测；
 * 默认 localStorage，不可用时退化到进程内 Map（隐私模式 / 单测）。
 */

/** localStorage 键名（与 save.mjs 的 SAVE_KEY 刻意分开，见文件头） */
export const RECORDS_KEY = 'nightshift.records.v1';

/** 最近七夜 / 最近八周（周表只做纪念，不需要很长） */
const MAX_NIGHTS = 7;
const MAX_WEEKS = 8;

function emptyData() {
  return { weeks: [], bestNet: 0, bestCash: 0, bestStar: 1, lastNights: [] };
}

const numOr = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** 进程内兜底（Node 单测 / 隐私模式）；模块级 Map 保证多次 createRecords 共享 */
const memory = new Map();
function memoryStore() {
  return {
    kind: 'memory',
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => { memory.set(k, String(v)); },
    removeItem: (k) => { memory.delete(k); },
  };
}

/** 探测 localStorage 是否真的可写（存在对象但一写就抛的环境也有） */
function probeStorage() {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return null;
    const k = '__ns_records_probe__';
    ls.setItem(k, '1');
    ls.removeItem(k);
    return ls;
  } catch {
    return null;
  }
}

/** 把任意读到的数据规整成合法结构（手改坏 / 旧版本都不能让面板崩） */
function normalize(raw) {
  const d = emptyData();
  if (!raw || typeof raw !== 'object') return d;

  if (Array.isArray(raw.lastNights)) {
    d.lastNights = raw.lastNights
      /* ⚠ 这里必须显式排掉 null / '' —— `Number(null)` 是 0、`Number('')` 也是 0，
       *   两者都能通过 `Number.isFinite`，于是"没有夜号的脏条目"会被下面的
       *   `Math.max(1, ...)` 悄悄变成**第 1 夜**，再和真正的第 1 夜撞成一条。
       *   表现就是"周终图里少了一夜、多了一根来路不明的柱子"。
       *   所以先判 e.night 自身非空，再要求 ≥1。 */
      .filter((e) => e && e.night != null && e.night !== '' && Number.isFinite(Number(e.night)) && Number(e.night) >= 1)
      .map((e) => ({
        night: Math.max(1, Math.round(Number(e.night))),
        revenue: numOr(e.revenue, 0),
        netProfit: numOr(e.netProfit, 0),
        star: clamp(Math.round(numOr(e.star, 1)), 1, 5),
      }))
      // 同 night 去重（后写的覆盖先写的），再按夜号升序
      .sort((a, b) => a.night - b.night)
      .filter((e, i, arr) => i === arr.length - 1 || e.night !== arr[i + 1].night)
      .slice(-MAX_NIGHTS);
  }

  if (Array.isArray(raw.weeks)) {
    d.weeks = raw.weeks
      .filter((e) => e && e.week != null && e.week !== '' && Number.isFinite(Number(e.week)) && Number(e.week) >= 1)
      .map((e) => ({
        week: Math.max(1, Math.round(Number(e.week))),
        netProfit: numOr(e.netProfit, 0),
        star: clamp(Math.round(numOr(e.star, 1)), 1, 5),
        passed: e.passed === true,
      }))
      .sort((a, b) => a.week - b.week)
      .slice(-MAX_WEEKS);
  }

  d.bestNet = Math.max(numOr(raw.bestNet, 0), ...d.lastNights.map((e) => e.netProfit), 0);
  d.bestCash = Math.max(numOr(raw.bestCash, 0), ...d.lastNights.map((e) => e.revenue), 0);
  d.bestStar = clamp(
    Math.max(Math.round(numOr(raw.bestStar, 1)), ...d.lastNights.map((e) => e.star), 1),
    1, 5,
  );
  return d;
}

/**
 * 创建纪录读写器。
 * @param storage 注入的存储（需有 getItem/setItem）；不传则探测 localStorage
 * @returns {{ snapshot, submitNight, submitWeek, resetHistory, key }}
 */
export function createRecords(storage) {
  const store = storage ?? probeStorage() ?? memoryStore();

  function read() {
    try {
      const raw = store.getItem(RECORDS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function write(data) {
    try {
      store.setItem(RECORDS_KEY, JSON.stringify(data));
      return true;
    } catch {
      // 配额超限 / 隐私模式：纪录是附加信息，写不进去绝不能打断结算
      return false;
    }
  }

  let data = normalize(read());

  /** 深拷贝快照（HUD 只读，不持有内部引用） */
  function snapshot() {
    return JSON.parse(JSON.stringify(data));
  }

  /**
   * 记录一夜。
   * ⚠ 按 night **upsert**：P0-7 重打本夜会再次结算同一夜，
   *   若直接 push，周终的"本周七夜"会多出一条重复夜，净利合计也会翻倍。
   * @param {{night:number, revenue:number, netProfit:number, star:number}} n
   */
  function submitNight(n = {}) {
    const night = Math.max(1, Math.round(numOr(n.night, 1)));
    const row = {
      night,
      revenue: numOr(n.revenue, 0),
      netProfit: numOr(n.netProfit, 0),
      star: clamp(Math.round(numOr(n.star, 1)), 1, 5),
    };
    data.lastNights = data.lastNights.filter((e) => e.night !== night);
    data.lastNights.push(row);
    data.lastNights.sort((a, b) => a.night - b.night);
    if (data.lastNights.length > MAX_NIGHTS) data.lastNights = data.lastNights.slice(-MAX_NIGHTS);

    if (row.netProfit > data.bestNet) data.bestNet = row.netProfit;
    if (row.revenue > data.bestCash) data.bestCash = row.revenue;
    if (row.star > data.bestStar) data.bestStar = row.star;

    write(data);
    return snapshot();
  }

  /**
   * 记录一周（周终调用）。
   * 按 week upsert，理由同 submitNight。
   * @param {{week:number, netProfit:number, star:number, passed:boolean}} w
   */
  function submitWeek(w = {}) {
    const week = Math.max(1, Math.round(numOr(w.week, 1)));
    const row = {
      week,
      netProfit: numOr(w.netProfit, 0),
      star: clamp(Math.round(numOr(w.star, 1)), 1, 5),
      passed: w.passed === true,
    };
    data.weeks = data.weeks.filter((e) => e.week !== week);
    data.weeks.push(row);
    data.weeks.sort((a, b) => a.week - b.week);
    if (data.weeks.length > MAX_WEEKS) data.weeks = data.weeks.slice(-MAX_WEEKS);
    write(data);
    return snapshot();
  }

  /** 清空本机纪录（调试 / 未来"清空纪念册"入口用；账号重开**不**调用它） */
  function resetHistory() {
    data = emptyData();
    write(data);
    return snapshot();
  }

  return { snapshot, submitNight, submitWeek, resetHistory, key: RECORDS_KEY };
}

export default createRecords;
