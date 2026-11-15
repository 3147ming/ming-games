/**
 * recorder.js — R12 操作录像：录制 / 回放 / 导出导入（纯函数 + 一层 localStorage）
 *
 * 设计边界（改动前务必读）：
 *   - 只记录「对电路有语义影响」的操作，不记录平移、缩放、悬停、选中这类视图操作，
 *     否则 2000 条上限会被鼠标移动瞬间填满。
 *   - 回放不依赖原始 id 猜测：place 操作带原始 componentId，回放时用
 *     `addComponent(type,x,y,{id})` 原样复用；导线 id 由 model 自增生成，
 *     所以维护 wireMap(原始 id → 回放 id) 来支持后续 removeWire。
 *   - 全部撤销/回放都由 model 的 pushUndo 记录，因此回放结束后用户仍能 Ctrl+Z。
 *   - 本模块不 import board / DOM，node 直测可用（tools/test-model.mjs 覆盖）。
 */

export const RECORD_PREFIX = 'lab-sim-record:';
export const RECORD_MAX = 2000;
export const PLAY_SPEEDS = [0.5, 1, 2, 4];

export function recordKey(expId) {
  return `${RECORD_PREFIX}${expId || '_unknown'}`;
}

/** 各类操作的显示名（回放列表 / 汇总用） */
const OP_LABEL = {
  place: '放置',
  remove: '删除',
  wire: '连线',
  unwire: '拆线',
  rotate: '旋转',
  param: '改参数',
  switch: '拨开关',
};

export function opLabel(type) {
  return OP_LABEL[type] || type;
}

/** 开关类元件：参数变化单独标成 switch，回放时可突出显示 */
function isSwitchType(type) {
  return /switch|dip|logic|button/i.test(String(type || ''));
}

function compSnapshot(comp) {
  return {
    id: comp.id,
    type: comp.type,
    x: comp.x,
    y: comp.y,
    rotation: comp.rotation || 0,
    params: { ...(comp.params || {}) },
  };
}

function refOf(ref) {
  if (!ref) return null;
  const out = { componentId: ref.componentId || null, terminal: ref.terminal || null };
  if (ref.nodeId) out.nodeId = ref.nodeId;
  if (ref.x !== undefined) out.x = ref.x;
  if (ref.y !== undefined) out.y = ref.y;
  return out;
}

function refKeyOf(ref) {
  if (!ref) return '';
  if (ref.nodeId) return `n:${ref.nodeId}`;
  if (ref.componentId) return `c:${ref.componentId}:${ref.terminal}`;
  return '';
}

/**
 * 由「前后两次电路快照」差分出操作列表 —— 录制侧唯一入口。
 * 差分口径与 R10 埋点一致（增删元件 / 增删导线 / 参数变化），
 * 额外补旋转与位置（同一元件参数不变但要回放位置时仍可见）。
 *
 * @param {{components:Array,wires:Array}|null} prev
 * @param {{components:Array,wires:Array}} next
 * @param {number} t 毫秒时间戳（相对录制起点）
 * @returns {Array<{t:number,type:string,payload:object}>}
 */
export function diffToOps(prev, next, t = 0) {
  const before = prev || { components: [], wires: [] };
  const prevComps = new Map((before.components || []).map((c) => [c.id, c]));
  const nextComps = new Map((next.components || []).map((c) => [c.id, c]));
  const ops = [];

  // 新增元件
  for (const [id, comp] of nextComps) {
    if (!prevComps.has(id)) {
      ops.push({ t, type: 'place', payload: compSnapshot(comp) });
    }
  }
  // 删除元件（连带导线由 model 处理，不再单独记 unwire，否则回放会重复删）
  for (const id of prevComps.keys()) {
    if (!nextComps.has(id)) ops.push({ t, type: 'remove', payload: { componentId: id } });
  }
  // 保留元件的旋转 / 位置 / 参数变化
  for (const [id, comp] of nextComps) {
    const old = prevComps.get(id);
    if (!old) continue;
    if ((old.rotation || 0) !== (comp.rotation || 0)) {
      ops.push({ t, type: 'rotate', payload: { componentId: id, rotation: comp.rotation || 0 } });
    }
    if (old.x !== comp.x || old.y !== comp.y) {
      ops.push({
        t, type: 'rotate', payload: { componentId: id, rotation: comp.rotation || 0, x: comp.x, y: comp.y, move: true },
      });
    }
    const oldParams = JSON.stringify(old.params || {});
    const newParams = JSON.stringify(comp.params || {});
    if (oldParams !== newParams) {
      ops.push({
        t,
        type: isSwitchType(comp.type) ? 'switch' : 'param',
        payload: { componentId: id, type: comp.type, params: { ...(comp.params || {}) } },
      });
    }
  }
  // 导线
  const prevWires = new Map((before.wires || []).map((w) => [w.id, w]));
  const nextWires = new Map((next.wires || []).map((w) => [w.id, w]));
  for (const [id, wire] of nextWires) {
    if (prevWires.has(id)) continue;
    ops.push({
      t,
      type: 'wire',
      payload: { wireId: id, a: refOf(wire.a), b: refOf(wire.b) },
    });
  }
  for (const [id, wire] of prevWires) {
    if (nextWires.has(id)) continue;
    // 元件被删时 model 会连带删线：这类导线不单独记，避免回放删两次
    if (!nextComps.has(wire.a && wire.a.componentId) || !nextComps.has(wire.b && wire.b.componentId)) {
      continue;
    }
    ops.push({
      t, type: 'unwire', payload: { wireId: id, a: refOf(wire.a), b: refOf(wire.b) },
    });
  }
  return ops;
}

/* ------------------------------------------------------------------ 存储 */

export function loadRecord(expId) {
  try {
    const raw = window.localStorage.getItem(recordKey(expId));
    if (!raw) return [];
    const data = JSON.parse(raw);
    const ops = Array.isArray(data) ? data : (data && Array.isArray(data.ops) ? data.ops : []);
    return ops.filter(isValidOp);
  } catch (_) {
    return [];
  }
}

export function saveRecord(expId, ops) {
  const list = (Array.isArray(ops) ? ops : []).filter(isValidOp).slice(-RECORD_MAX);
  try {
    window.localStorage.setItem(recordKey(expId), JSON.stringify({
      v: 1, savedAt: Date.now(), ops: list,
    }));
  } catch (_) { /* 隐私模式 / 超配额：静默降级为仅内存 */ }
  return list;
}

/** 追加一条（录制热路径：只做尾部追加，避免每次都全量 diff 落盘） */
export function createRecorder(expId, opts = {}) {
  const max = Number(opts.max) || RECORD_MAX;
  let ops = [];
  let last = null;
  let startedAt = 0;

  return {
    get expId() { return expId; },
    get ops() { return ops; },
    get size() { return ops.length; },
    /** 开始录制：用当前电路快照做差分基线，firstCapture 不会把已有元件当成新增 */
    start(state, now = Date.now()) {
      ops = [];
      last = state ? JSON.parse(JSON.stringify(state)) : null;
      startedAt = now;
      return true;
    },
    /** 电路变化后调用：差分出操作并追加 */
    capture(state, now = Date.now()) {
      if (!state) return [];
      const t = Math.max(0, now - startedAt);
      const added = diffToOps(last, state, t);
      if (added.length === 0) return [];
      ops.push(...added);
      if (ops.length > max) ops = ops.slice(-max);
      last = JSON.parse(JSON.stringify(state));
      return added;
    },
    clear() { ops = []; last = null; return true; },
    /** 用外部操作列表替换当前录像（导入 JSON / 清空用） */
    replaceOps(next) {
      ops = (Array.isArray(next) ? next : []).filter(isValidOp).slice(-max);
      last = null;
      return ops.length;
    },
    flush() { saveRecord(expId, ops); return ops.length; },
    exportText(meta = {}) { return exportRecord(ops, { expId, ...meta }); },
  };
}

export function clearRecord(expId) {
  try { window.localStorage.removeItem(recordKey(expId)); } catch (_) { /* ignore */ }
}

export function isValidOp(op) {
  if (!op || typeof op !== 'object') return false;
  if (typeof op.type !== 'string' || !OP_LABEL[op.type]) return false;
  return Boolean(op.payload && typeof op.payload === 'object');
}

/* -------------------------------------------------------------- 导出导入 */

export function exportRecord(ops, meta = {}) {
  return JSON.stringify({
    app: 'circuit-lab',
    kind: 'record',
    v: 1,
    exportedAt: new Date().toISOString(),
    expId: meta.expId || null,
    title: meta.title || '',
    count: (ops || []).length,
    ops: (ops || []).filter(isValidOp),
  }, null, 2);
}

/** @returns {{ok:boolean, ops:Array, error:string}} */
export function importRecord(text) {
  let data;
  try {
    data = JSON.parse(String(text || ''));
  } catch (err) {
    return { ok: false, ops: [], error: '不是合法 JSON' };
  }
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.ops) ? data.ops : null);
  if (!list) return { ok: false, ops: [], error: '缺少 ops 数组' };
  const ops = list.filter(isValidOp).slice(0, RECORD_MAX);
  if (ops.length === 0) return { ok: false, ops: [], error: '没有可回放的操作' };
  return { ok: true, ops, error: '' };
}

/* ------------------------------------------------------------------ 汇总 */

export function summarize(ops) {
  const list = (ops || []).filter(isValidOp);
  const byType = {};
  list.forEach((op) => { byType[op.type] = (byType[op.type] || 0) + 1; });
  const last = list.length ? list[list.length - 1].t : 0;
  return {
    total: list.length,
    durationMs: Math.max(0, Math.round(Number(last) || 0)),
    byType,
  };
}

/* ------------------------------------------------------------------ 回放 */

/**
 * 回放器：把 ops 逐条施加到 modelApi 上。
 * modelApi 只需 model.js 的那几个函数（addComponent/removeComponent/addWire/
 * removeWire/updateParams/rotateComponent），node 直测可直接传 model 模块。
 */
export function createPlayer(ops, modelApi) {
  const list = (ops || []).filter(isValidOp);
  const wireMap = new Map();
  let cursor = 0;

  function resolveRefWithMap(ref) {
    if (!ref) return null;
    if (ref.nodeId) return { nodeId: ref.nodeId, x: ref.x, y: ref.y };
    return { componentId: ref.componentId, terminal: ref.terminal, x: ref.x, y: ref.y };
  }

  function applyOne(op) {
    const p = op.payload || {};
    switch (op.type) {
      case 'place': {
        const res = modelApi.addComponent(p.type, p.x, p.y, {
          id: p.id, rotation: p.rotation || 0, params: p.params || {}, silent: true,
        });
        return { ok: Boolean(res && res.ok), error: res && res.error };
      }
      case 'remove': {
        const res = modelApi.removeComponent(p.componentId);
        return { ok: Boolean(res && res.ok), error: res && res.error };
      }
      case 'wire': {
        const res = modelApi.addWire(resolveRefWithMap(p.a), resolveRefWithMap(p.b));
        if (res && res.ok && p.wireId) wireMap.set(p.wireId, res.wire.id);
        return { ok: Boolean(res && res.ok), error: res && res.error };
      }
      case 'unwire': {
        const id = wireMap.get(p.wireId) || p.wireId;
        const res = modelApi.removeWire(id);
        return { ok: Boolean(res && res.ok), error: res && res.error };
      }
      case 'rotate': {
        if (p.move) return { ok: true, note: 'move-skip' };
        const res = modelApi.rotateComponent(p.componentId);
        return { ok: Boolean(res && res.ok), error: res && res.error };
      }
      case 'param':
      case 'switch': {
        const res = modelApi.updateParams(p.componentId, p.params || {});
        return { ok: Boolean(res && res.ok), error: res && res.error };
      }
      default:
        return { ok: false, error: `未知操作：${op.type}` };
    }
  }

  return {
    get total() { return list.length; },
    get index() { return cursor; },
    get done() { return cursor >= list.length; },
    get durationMs() { return list.length ? Math.max(0, list[list.length - 1].t || 0) : 0; },
    ops: list,
    reset() { cursor = 0; wireMap.clear(); return true; },
    /** 前进一步；越界返回 false */
    step() {
      if (cursor >= list.length) return false;
      const op = list[cursor];
      const res = applyOne(op);
      cursor += 1;
      return { ok: res.ok, error: res.error || '', op };
    },
    /** 连走到第 n 步（用于拖动进度条） */
    seekTo(n) {
      const target = Math.max(0, Math.min(list.length, Math.round(n)));
      while (cursor < target) {
        const res = this.step();
        if (!res.ok && res.error) cursor += 1;
      }
      return cursor;
    },
  };
}
