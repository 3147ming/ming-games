/**
 * versions.js — R17 电路版本管理（纯函数 + localStorage 适配）
 *
 * 存档键沿用项目约定：lab-sim-versions:<expId>
 * 每条版本 = { id, name, time, circuit, auto }，上限 20 个，超出删最早的。
 * circuit 用 model.serializeCircuit() 的同一份格式，恢复时直接 loadCircuit。
 */
export const VERSION_LIMIT = 20;
export const VERSIONS_PREFIX = 'lab-sim-versions:';

let memory = Object.create(null);
let storageFailed = false;

function storage() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  } catch (_) { /* 隐私模式 */ }
  return null;
}

export function versionsKey(expId) {
  return `${VERSIONS_PREFIX}${expId || 'unknown'}`;
}

/** 纯函数：按上限裁剪，返回新数组（不改入参） */
export function pruneVersions(list, limit = VERSION_LIMIT) {
  const arr = Array.isArray(list) ? list.slice() : [];
  if (arr.length <= limit) return arr;
  return arr.sort((a, b) => (a.time || 0) - (b.time || 0)).slice(arr.length - limit);
}

export function listVersions(expId) {
  const s = storage();
  if (!s) return (memory[expId] || []).slice();
  try {
    const raw = s.getItem(versionsKey(expId));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    memory[expId] = Array.isArray(arr) ? arr : [];
    return memory[expId].slice();
  } catch (_) {
    return (memory[expId] || []).slice();
  }
}

function writeVersions(expId, list) {
  const kept = pruneVersions(list);
  memory[expId] = kept;
  const s = storage();
  if (s && !storageFailed) {
    try {
      s.setItem(versionsKey(expId), JSON.stringify(kept));
      return kept;
    } catch (_) { storageFailed = true; }
  }
  return kept;
}

/** 保存一个版本；返回新版本对象 */
export function saveVersion(expId, name, circuit, opts = {}) {
  if (!circuit || typeof circuit !== 'object') return null;
  const version = {
    id: `v${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: String(name || '未命名版本').slice(0, 60),
    time: Date.now(),
    circuit,
    auto: Boolean(opts.auto),
  };
  writeVersions(expId, [...listVersions(expId), version]);
  return version;
}

export function getVersion(expId, id) {
  return listVersions(expId).find((v) => v.id === id) || null;
}

export function deleteVersion(expId, id) {
  const before = listVersions(expId);
  writeVersions(expId, before.filter((v) => v.id !== id));
  return before.length !== listVersions(expId).length;
}

export function clearVersions(expId) {
  writeVersions(expId, []);
}

/** 自动版本名（幂等格式，不含随机数） */
export function autoVersionName(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const p = (n) => String(n).padStart(2, '0');
  return `自动 · ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function byId(list) {
  const map = new Map();
  (Array.isArray(list) ? list : []).forEach((x) => { if (x && x.id) map.set(x.id, x); });
  return map;
}

function wireKey(wire) {
  if (!wire) return '';
  const a = wire.a ? `${wire.a.componentId || wire.a.nodeId || ''}:${wire.a.terminal || ''}` : '';
  const b = wire.b ? `${wire.b.componentId || wire.b.nodeId || ''}:${wire.b.terminal || ''}` : '';
  return [a, b].sort().join('|');
}

/**
 * 纯函数：两个电路快照的结构差异。
 * @returns 新增/删除/改参数的元件 id，以及新增/删除的导线键
 */
export function diffVersions(a, b) {
  const ca = (a && a.circuit) || a || {};
  const cb = (b && b.circuit) || b || {};
  const compsA = byId(ca.components);
  const compsB = byId(cb.components);
  const addedComps = [...compsB.keys()].filter((id) => !compsA.has(id));
  const removedComps = [...compsA.keys()].filter((id) => !compsB.has(id));
  const changedComps = [...compsB.keys()].filter((id) => compsA.has(id)
    && JSON.stringify(compsA.get(id).params || {}) !== JSON.stringify(compsB.get(id).params || {}));
  const wiresA = new Set((ca.wires || []).map(wireKey));
  const wiresB = new Set((cb.wires || []).map(wireKey));
  return {
    addedComps,
    removedComps,
    changedComps,
    addedWires: [...wiresB].filter((k) => !wiresA.has(k)),
    removedWires: [...wiresA].filter((k) => !wiresB.has(k)),
    counts: {
      compsA: compsA.size, compsB: compsB.size,
      wiresA: wiresA.size, wiresB: wiresB.size,
    },
  };
}

/** 纯函数：版本列表摘要（UI 用） */
export function versionSummary(version) {
  const c = (version && version.circuit) || {};
  return {
    id: version ? version.id : '',
    name: version ? version.name : '',
    time: version ? version.time : 0,
    components: (c.components || []).length,
    wires: (c.wires || []).length,
    auto: Boolean(version && version.auto),
  };
}
