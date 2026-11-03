/**
 * datastore.js — 数据系统内核（指令包 11）
 *
 * 纯函数 + 环形缓冲，不碰 DOM：
 *   记录采样、CSV/JSON 序列化与解析、多通道对齐、项目存档版本迁移。
 *   面板（data-panel.js）只负责把这里的结果画出来/触发下载。
 *
 * 为什么单独一层：CSV 必须能和内存记录逐行对拍。若导出逻辑写在按钮回调里，
 * 就只能"打开文件看看差不多"，这正是包 11 明确禁止的验收方式。
 */

/** 存档版本：包 11 引入 records / instruments 段，版本 3 → 4 */
export const ARCHIVE_VERSION = 4;

/** 记录环形缓冲默认容量（每通道） */
export const RECORD_CAPACITY = 10000;

/** CSV 表头（长格式：多通道不等长时天然对齐） */
export const CSV_HEADER = 'time,channel,value,type';

/**
 * 环形记录器。
 * push(channel, t, v, type)：type ∈ 'analog' | 'digital'
 * 每通道独立环形，写满丢最旧；总内存 ≈ capacity × 通道数 × 24B。
 */
export function createRecorder(options = {}) {
  const capacity = Math.max(16, Number(options.capacity) || RECORD_CAPACITY);
  const channels = new Map(); // id → { id, type, buf: [], head: 0, count: 0, last }
  let paused = false;
  let total = 0;

  const ensure = (id, type) => {
    if (!channels.has(id)) {
      channels.set(id, { id, type: type || 'analog', buf: new Array(capacity), head: 0, count: 0, last: null });
    }
    return channels.get(id);
  };

  return {
    capacity,
    push(id, t, v, type = 'analog') {
      if (paused) return false;
      if (!id || !Number.isFinite(Number(t)) || !Number.isFinite(Number(v))) return false;
      const ch = ensure(id, type);
      ch.type = type;
      ch.buf[ch.head] = { t: Number(t), v: Number(v) };
      ch.head = (ch.head + 1) % capacity;
      if (ch.count < capacity) ch.count += 1;
      ch.last = { t: Number(t), v: Number(v) };
      total += 1;
      return true;
    },
    /** 展开成时间升序的样本数组 */
    samples(id) {
      const ch = channels.get(id);
      if (!ch || ch.count === 0) return [];
      const out = [];
      const start = ch.count < capacity ? 0 : ch.head;
      for (let i = 0; i < ch.count; i += 1) {
        const item = ch.buf[(start + i) % capacity];
        if (item) out.push({ ...item });
      }
      return out;
    },
    /** 全部通道的元信息 + 最新值 */
    list() {
      return [...channels.values()].map((ch) => ({
        id: ch.id,
        type: ch.type,
        count: ch.count,
        last: ch.last ? { ...ch.last } : null,
        capacity,
      }));
    },
    countOf(id) {
      const ch = channels.get(id);
      return ch ? ch.count : 0;
    },
    total() { return total; },
    paused() { return paused; },
    pause() { paused = true; return true; },
    resume() { paused = false; return true; },
    clear() {
      channels.clear();
      total = 0;
      return true;
    },
    /** 导出成统一记录数组（CSV/JSON/对比页共用） */
    records() {
      const out = [];
      channels.forEach((ch) => {
        this.samples(ch.id).forEach((s) => {
          out.push({ time: s.t, channel: ch.id, value: s.v, type: ch.type });
        });
      });
      out.sort((a, b) => a.time - b.time || String(a.channel).localeCompare(String(b.channel)));
      return out;
    },
  };
}

/** 数值保留 4 位有效数字（CSV） */
function csvNumber(value) {
  if (!Number.isFinite(value)) return '';
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e6)) return value.toExponential(3);
  return String(Number(value.toPrecision(4)));
}

/** 记录数组 → CSV 文本（UTF-8，带 BOM 便于 Excel 识别） */
export function recordsToCsv(records, options = {}) {
  const lines = [CSV_HEADER];
  (records || []).forEach((r) => {
    lines.push([
      csvNumber(Number(r.time)),
      String(r.channel),
      csvNumber(Number(r.value)),
      r.type === 'digital' ? 'digital' : 'analog',
    ].join(','));
  });
  const text = lines.join('\n');
  return options.bom === false ? text : `\uFEFF${text}`;
}

/** CSV 文本 → 记录数组（导出对拍/回读用） */
export function csvToRecords(text) {
  if (typeof text !== 'string') return [];
  const rows = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (rows.length === 0) return [];
  const header = rows[0].split(',').map((s) => s.trim().toLowerCase());
  const idx = {
    time: header.indexOf('time'),
    channel: header.indexOf('channel'),
    value: header.indexOf('value'),
    type: header.indexOf('type'),
  };
  if (idx.time < 0 || idx.channel < 0 || idx.value < 0) return [];
  const out = [];
  for (let i = 1; i < rows.length; i += 1) {
    const cells = rows[i].split(',');
    const time = Number(cells[idx.time]);
    const value = Number(cells[idx.value]);
    if (!Number.isFinite(time) || !Number.isFinite(value)) continue;
    out.push({
      time,
      channel: cells[idx.channel],
      value,
      type: idx.type >= 0 && cells[idx.type] === 'digital' ? 'digital' : 'analog',
    });
  }
  return out;
}

/** 记录数组 + 元信息 → JSON 文本 */
export function recordsToJson(records, meta = {}) {
  const byChannel = new Map();
  (records || []).forEach((r) => {
    if (!byChannel.has(r.channel)) {
      byChannel.set(r.channel, { id: r.channel, name: r.channel, type: r.type || 'analog', samples: [] });
    }
    byChannel.get(r.channel).samples.push({ t: r.time, v: r.value });
  });
  const payload = {
    meta: {
      circuit: meta.circuit || '',
      time: meta.time || Date.now(),
      dt: meta.dt || 0,
      version: ARCHIVE_VERSION,
    },
    channels: [...byChannel.values()],
  };
  return JSON.stringify(payload, null, 2);
}

/** JSON 文本 → { meta, channels }（导入对比页用） */
export function jsonToRecords(text) {
  try {
    const data = typeof text === 'string' ? JSON.parse(text) : text;
    if (!data || !Array.isArray(data.channels)) return { meta: {}, channels: [] };
    const channels = data.channels.map((ch) => ({
      id: ch.id,
      name: ch.name || ch.id,
      type: ch.type === 'digital' ? 'digital' : 'analog',
      samples: (ch.samples || []).filter((s) => Number.isFinite(Number(s.t)) && Number.isFinite(Number(s.v)))
        .map((s) => ({ t: Number(s.t), v: Number(s.v) })),
    }));
    return { meta: data.meta || {}, channels };
  } catch (err) {
    return { meta: {}, channels: [] };
  }
}

/**
 * 多通道对齐：统一重采样到最密的网格。
 * 做法：以所有通道采样时刻的并集为网格，线性插值；超出某通道首尾的区间不外推（null）。
 *
 * @returns {{times:number[], series:Array<{id, type, values:(number|null)[]}>}}
 */
export function alignSeries(channels) {
  const list = (channels || []).filter((ch) => ch && Array.isArray(ch.samples) && ch.samples.length > 0);
  if (list.length === 0) return { times: [], series: [] };

  const times = [...new Set(list.flatMap((ch) => ch.samples.map((s) => s.t)))].sort((a, b) => a - b);
  const series = list.map((ch) => {
    const samples = ch.samples.slice().sort((a, b) => a.t - b.t);
    const values = times.map((t) => {
      if (t < samples[0].t || t > samples[samples.length - 1].t) return null;
      // 二分查找
      let lo = 0;
      let hi = samples.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (samples[mid].t <= t) lo = mid;
        else hi = mid;
      }
      const a = samples[lo];
      const b = samples[hi];
      if (t === a.t) return a.v;
      if (t === b.t) return b.v;
      const k = (t - a.t) / (b.t - a.t || 1);
      return a.v + (b.v - a.v) * k;
    });
    return { id: ch.id, type: ch.type || 'analog', values };
  });
  return { times, series };
}

/**
 * 理论曲线：把 `v=5*(1-exp(-t/0.01))` 这类表达式编译成函数。
 * 安全边界：只允许数学白名单 + 变量 t，禁用全局对象（教学用，不接触外部）。
 */
export function compileFormula(expression, vars = {}) {
  const expr = String(expression || '').trim();
  if (!expr) return { ok: false, error: '公式为空' };
  const stripped = expr.replace(/^v\s*=\s*/, '');
  if (/[^\w\s+\-*/().,^<>=!?:%]|__|globalThis|window|function|=>|import|eval|new\s/.test(stripped)) {
    return { ok: false, error: '公式含不允许的字符/关键字' };
  }
  const names = Object.keys(vars);
  // 白名单数学函数按名字注入（学生写 exp(-t/0.1) 而不是 Math.exp）：
  // 用参数注入而不是改全局，作用域外的东西一律拿不到。
  const MATH_NAMES = ['exp', 'log', 'ln', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan',
    'sqrt', 'abs', 'pow', 'min', 'max', 'floor', 'ceil', 'round', 'sign'];
  const mathValues = MATH_NAMES.map((name) => (name === 'ln' ? Math.log : Math[name]));
  try {
    const fn = new Function('t', ...names, ...MATH_NAMES, 'Math', `"use strict"; return (${stripped});`);
    const call = (t, extra = {}) => fn(
      t,
      ...names.map((k) => (k in extra ? extra[k] : vars[k])),
      ...mathValues,
      Math,
    );
    const sample = call(0);
    if (!Number.isFinite(sample)) return { ok: false, error: '公式在 t=0 处无有效值' };
    return { ok: true, fn: call };
  } catch (err) {
    return { ok: false, error: `公式语法错误：${err.message}` };
  }
}

/* ==========================================================================
   项目存档版本迁移
   ========================================================================== */

/**
 * 把任意版本的电路存档迁移到当前版本。
 *
 * 原则：
 *   - 不静默丢数据：缺字段补默认，未知字段原样保留；
 *   - 不修改入参（返回新对象）；
 *   - 版本号只增不减；未来版本（>当前）原样返回并标注 tooNew。
 *
 * @returns {{ok:boolean, data:object, fromVersion:number, toVersion:number, notes:string[]}}
 */
export function migrateArchive(raw) {
  const notes = [];
  if (!raw || typeof raw !== 'object') {
    return { ok: false, data: null, fromVersion: 0, toVersion: ARCHIVE_VERSION, notes: ['存档不是对象'] };
  }
  const fromVersion = Number.isInteger(raw.version) ? raw.version : 1;
  if (fromVersion > ARCHIVE_VERSION) {
    return {
      ok: false,
      data: { ...raw },
      fromVersion,
      toVersion: ARCHIVE_VERSION,
      notes: [`存档版本 ${fromVersion} 高于当前 ${ARCHIVE_VERSION}，未做迁移`],
      tooNew: true,
    };
  }

  const data = JSON.parse(JSON.stringify(raw));
  data.version = ARCHIVE_VERSION;

  // v1 → v2：wires 从纯数组升级为对象数组（早期版本可能是 [[a,b],...]）
  if (Array.isArray(data.wires)) {
    data.wires = data.wires.map((wire) => {
      if (Array.isArray(wire)) {
        notes.push('v1 导线数组已转换为对象');
        return { a: wire[0], b: wire[1] };
      }
      return wire;
    });
  } else {
    data.wires = [];
    notes.push('补默认 wires=[]');
  }

  // v2 → v3：补 stash（跨平台暂存）
  if (!data.stash || typeof data.stash !== 'object') {
    data.stash = {};
    notes.push('补默认 stash={}');
  }

  // v3 → v4：补 instruments 与 records（包 10/11 新增段）
  if (!data.instruments || typeof data.instruments !== 'object') {
    data.instruments = null;
    notes.push('补默认 instruments=null');
  }
  if (!Array.isArray(data.records)) {
    data.records = [];
    notes.push('补默认 records=[]');
  }

  if (!Array.isArray(data.components)) {
    data.components = [];
    notes.push('补默认 components=[]');
  }
  if (typeof data.platform !== 'string') {
    data.platform = 'exp-box';
    notes.push('补默认 platform');
  }

  return { ok: true, data, fromVersion, toVersion: ARCHIVE_VERSION, notes };
}

/**
 * 存档往返一致性比较（排除时间戳字段）。
 * 返回 {same, diffKeys}，diffKeys 是首个不一致的路径，便于断言定位。
 */
export function archivesEquivalent(a, b, ignoreKeys = ['time', 'savedAt', 'updatedAt']) {
  const strip = (value, path = '') => {
    if (Array.isArray(value)) return value.map((item, i) => strip(item, `${path}[${i}]`));
    if (value && typeof value === 'object') {
      const out = {};
      Object.keys(value).sort().forEach((key) => {
        if (ignoreKeys.includes(key)) return;
        out[key] = strip(value[key], path ? `${path}.${key}` : key);
      });
      return out;
    }
    return value;
  };
  const sa = JSON.stringify(strip(a));
  const sb = JSON.stringify(strip(b));
  if (sa === sb) return { same: true, diffKeys: [] };
  // 粗定位：找出第一处不同的键
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  const diffKeys = [];
  keys.forEach((key) => {
    if (!ignoreKeys.includes(key) && JSON.stringify(a[key]) !== JSON.stringify(b[key])) diffKeys.push(key);
  });
  return { same: false, diffKeys };
}
