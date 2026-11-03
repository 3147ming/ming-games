/**
 * model.js — 电路唯一数据源（元件 / 端子 / 导线 / 网表）
 *
 * 设计要点：
 * 1. 单一状态源。渲染层、交互层、后续仿真层全部读这里，不各自维护副本。
 * 2. 网表（net）不靠导线单独推导，而是把「平台固有连通」与「显式导线」一起做并查集：
 *    面包板同一 5 孔组天生同网，插上导线后与元件端子合并成同一个 net。
 *    这样仿真层拿到的就是真实电气节点，不需要再关心导线细节。
 * 3. 撤销采用整体快照（结构小、操作粒度粗），不会出现"删了元件却留下半截导线"
 *    这类中间态——那类 bug 在命令式撤销里非常常见。
 * 4. 导线端点会缓存建立时的网格坐标 (x, y)，当端点实体不存在时（例如切平台后孔位消失），
 *    渲染层仍能画出这条"悬空导线"并标红，而不是静默丢掉用户数据。
 */

import { getPart, footprintOf, terminalPos } from './parts.js';
import { resetRelayState } from './devmodels.js';
import { getPlatform, getNode, isPlatformId } from './platforms.js';

/** 撤销栈上限：超过后丢弃最早快照 */
const UNDO_LIMIT = 60;

/** 当前电路（模块级单例，同时只有一个实验在工作区） */
let state = null;

/** 撤销快照栈 */
let undoStack = [];

/** 重做快照栈：撤销后产生新操作即清空 */
let redoStack = [];

/** 网表缓存：任何结构变更都会置空 */
let netCache = null;

/** id 自增计数器：元件按类型分别计数（resistor-1 / led-1），导线全局计数 */
let counters = { comp: new Map(), wire: 0 };

/* ==========================================================================
   基础工具
   ========================================================================== */

/** 端点引用 → 稳定字符串键：端子 'c:<元件id>:<端子名>'，孔位 'n:<节点id>' */
export function refKey(ref) {
  if (!ref || typeof ref !== 'object') return null;
  if (typeof ref.componentId === 'string' && typeof ref.terminal === 'string') {
    return `c:${ref.componentId}:${ref.terminal}`;
  }
  if (typeof ref.node === 'string') return `n:${ref.node}`;
  return null;
}

/** 元件占位矩形 */
export function rectOf(comp) {
  const def = getPart(comp.type);
  const footprint = footprintOf(def, comp.rotation);
  return { x: comp.x, y: comp.y, w: footprint.w, h: footprint.h };
}

/** 两个网格矩形是否相交（含边界相接） */
export function rectsOverlap(a, b) {
  if (!a || !b) return false;
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** 端点引用是否当前有效 */
export function refExists(ref) {
  return resolveRef(ref) !== null;
}

/** 解析端点：返回 { kind, pos, label }；端点不存在返回 null */
export function resolveRef(ref) {
  if (!state || !ref || typeof ref !== 'object') return null;

  if (typeof ref.componentId === 'string' && typeof ref.terminal === 'string') {
    const comp = state.components.find((item) => item.id === ref.componentId);
    if (!comp) return null;
    if (!comp.terminals.some((item) => item.name === ref.terminal)) return null;
    const pos = terminalPos(comp, ref.terminal);
    if (!pos) return null;
    return { kind: 'terminal', pos, label: `${comp.id}.${ref.terminal}` };
  }

  if (typeof ref.node === 'string') {
    // 孔位必须属于「当前平台」才算有效：换平台后旧孔位虽仍存在于
    // platforms.js 的缓存里，但画布上已经不存在这个点了，必须判为悬空。
    const platform = getPlatform(state.platform);
    if (!platform || !platform.nodeMap.has(ref.node)) return null;
    const node = getNode(ref.node);
    if (!node) return null;
    return { kind: 'node', pos: { x: node.x, y: node.y }, label: ref.node };
  }

  return null;
}

/** 失效端点仍要能画：取缓存坐标兜底 */
export function refFallbackPos(ref) {
  if (!ref || typeof ref !== 'object') return null;
  if (typeof ref.x === 'number' && typeof ref.y === 'number') return { x: ref.x, y: ref.y };
  return null;
}

/** 作废网表缓存 */
function invalidate() {
  netCache = null;
}

/* ==========================================================================
   生命周期
   ========================================================================== */

/** 新建空白电路，返回状态对象（已存在的电路与撤销栈被丢弃） */
export function createCircuit(platformId = 'exp-box') {
  if (!isPlatformId(platformId)) platformId = 'exp-box';
  state = {
    platform: platformId,
    components: [],
    wires: [],
    stash: Object.create(null),
  };
  undoStack = [];
  netCache = null;
  counters = { comp: new Map(), wire: 0 };
  // 机电元件的吸合状态是"上电态"，新电路必须清掉（否则 id 复用会串台）
  resetRelayState();
  return state;
}

/** 取当前电路（只读约定：结构变更必须走下面导出的 API） */
export function getState() {
  return state;
}

/** 当前平台 id */
export function getPlatformId() {
  return state ? state.platform : null;
}

/** 切换平台（不做数据迁移，迁移由 board.js 负责，因为要提示用户） */
export function setPlatform(platformId) {
  if (!state || !isPlatformId(platformId)) return false;
  state.platform = platformId;
  invalidate();
  return true;
}

/** 已放置的元件数量 */
export function componentCount() {
  return state ? state.components.length : 0;
}

/** 按 id 取元件（返回内部引用，仅供读取） */
export function findComponent(id) {
  if (!state) return null;
  return state.components.find((item) => item.id === id) || null;
}

/** 按 id 取导线 */
export function findWire(id) {
  if (!state) return null;
  return state.wires.find((item) => item.id === id) || null;
}

/* ==========================================================================
   撤销
   ========================================================================== */

function cloneComponents(list) {
  return list.map((comp) => ({
    id: comp.id,
    type: comp.type,
    x: comp.x,
    y: comp.y,
    rotation: comp.rotation,
    params: { ...comp.params },
    terminals: comp.terminals.map((terminal) => ({ ...terminal })),
  }));
}

function cloneWires(list) {
  return list.map((wire) => ({ id: wire.id, a: { ...wire.a }, b: { ...wire.b } }));
}

/** 记录一次快照（在任何结构变更之前调用） */
export function pushUndo(label = '') {
  if (!state) return;
  undoStack.push({
    label,
    components: cloneComponents(state.components),
    wires: cloneWires(state.wires),
  });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  // 任何新结构变更都会使"重做"失效
  redoStack = [];
}

/** 撤销一步；无可撤销时返回 false */
export function undo() {
  if (!state) return false;
  const snapshot = undoStack.pop();
  if (!snapshot) return false;
  // 被撤销的快照压入重做栈，供重做恢复到"操作后"状态
  redoStack.push({
    label: snapshot.label,
    components: cloneComponents(state.components),
    wires: cloneWires(state.wires),
  });
  state.components = snapshot.components;
  state.wires = snapshot.wires;
  invalidate();
  return true;
}

/** 是否还有可撤销的操作 */
export function canUndo() {
  return undoStack.length > 0;
}

/** 撤销栈深度（供状态栏 / 调试） */
export function undoDepth() {
  return undoStack.length;
}

/** 清空撤销栈（进入新实验时调用） */
export function clearUndo() {
  undoStack = [];
  redoStack = [];
}

/** 重做一步；无可重做时返回 false */
export function redo() {
  if (!state) return false;
  const snapshot = redoStack.pop();
  if (!snapshot) return false;
  // 把"当前（操作前）状态"压回撤销栈，保证 redo 后仍能再次 undo
  undoStack.push({
    label: snapshot.label,
    components: cloneComponents(state.components),
    wires: cloneWires(state.wires),
  });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  state.components = snapshot.components;
  state.wires = snapshot.wires;
  invalidate();
  return true;
}

/** 是否还有可重做的操作 */
export function canRedo() {
  return redoStack.length > 0;
}

/* ==========================================================================
   元件
   ========================================================================== */

/** 把 id 里的序号推到计数器之上（存档 / 暂存恢复时避免新建撞车） */
function bumpComponentSeq(id) {
  const match = /^(.*)-(\d+)$/.exec(String(id));
  if (!match) return;
  const type = match[1];
  const seq = Number(match[2]);
  const prev = counters.comp.get(type) || 0;
  if (seq > prev) counters.comp.set(type, seq);
}

/**
 * 新增元件。
 * @returns {{ok:true, component:object} | {ok:false, error:string, clashId?:string}}
 */
export function addComponent(type, x, y, options = {}) {
  if (!state) return { ok: false, error: '电路尚未初始化' };
  const def = getPart(type);
  if (!def) return { ok: false, error: `未知元件类型：${type}` };

  const rotation = options.rotation === 90 || options.rotation === 180 || options.rotation === 270
    ? options.rotation
    : 0;
  const footprint = footprintOf(def, rotation);
  const px = Math.round(Number(x));
  const py = Math.round(Number(y));
  if (!Number.isFinite(px) || !Number.isFinite(py)) {
    return { ok: false, error: '坐标无效' };
  }

  const platform = getPlatform(state.platform);
  if (!platform) return { ok: false, error: '平台无效' };
  if (px < 0 || py < 0 || px + footprint.w > platform.cols || py + footprint.h > platform.rows) {
    return { ok: false, error: `超出${platform.label}边界` };
  }

  const rect = { x: px, y: py, w: footprint.w, h: footprint.h };
  const clash = state.components.find((comp) => rectsOverlap(rect, rectOf(comp)));
  if (clash) {
    return { ok: false, error: '位置被占用', clashId: clash.id };
  }

  if (!options.silent) pushUndo(`add:${type}`);

  const id = typeof options.id === 'string' && options.id !== ''
    ? options.id
    : `${type}-${(counters.comp.get(type) || 0) + 1}`;
  // 无论 id 来自自增还是外部（存档 / 暂存恢复），都要把该类型的计数器推到序号之上，
  // 否则后续新建元件会和已有 id 撞车。
  bumpComponentSeq(id);

  const component = {
    id,
    type,
    x: px,
    y: py,
    rotation,
    params: { ...def.defaultParams, ...(options.params || {}) },
    terminals: def.terminals.map((terminal) => ({
      name: terminal.name,
      direction: terminal.direction,
      role: terminal.role || '',
      net: null,
    })),
  };

  state.components.push(component);
  invalidate();
  return { ok: true, component };
}

/** 删除元件（连带移除其全部导线） */
export function removeComponent(id) {
  if (!state) return { ok: false, removedWires: 0 };
  const index = state.components.findIndex((comp) => comp.id === id);
  if (index === -1) return { ok: false, removedWires: 0 };

  pushUndo(`remove:${id}`);
  state.components.splice(index, 1);

  const before = state.wires.length;
  state.wires = state.wires.filter(
    (wire) => wire.a.componentId !== id && wire.b.componentId !== id,
  );
  invalidate();
  return { ok: true, removedWires: before - state.wires.length };
}

/** 旋转选中元件 90°；循环四向 0→90→180→270→0；占位/越界冲突时拒绝 */
export function rotateComponent(id) {
  if (!state) return { ok: false, error: '电路尚未初始化' };
  const comp = findComponent(id);
  if (!comp) return { ok: false, error: '元件不存在' };

  const def = getPart(comp.type);
  if (!def) return { ok: false, error: '未知元件类型' };
  // 正方占位也允许旋转：比较器（3×3）的端子排布不对称，
  // 学生需要转 90° 把电源脚换到另一侧来走线。
  // 占位不变时下面的边界/重叠校验依然生效（不会把元件转出平台）。

  // 循环四向：0 → 90 → 180 → 270 → 0（每次 90°）
  const next = (comp.rotation + 90) % 360;
  const footprint = footprintOf(def, next);
  const platform = getPlatform(state.platform);
  if (
    comp.x + footprint.w > platform.cols
    || comp.y + footprint.h > platform.rows
  ) {
    return { ok: false, error: '旋转后会超出平台边界' };
  }

  const rect = { x: comp.x, y: comp.y, w: footprint.w, h: footprint.h };
  const clash = state.components.find(
    (other) => other.id !== id && rectsOverlap(rect, rectOf(other)),
  );
  if (clash) return { ok: false, error: `旋转后会与 ${clash.id} 重叠` };

  pushUndo(`rotate:${id}`);
  comp.rotation = next;
  invalidate();
  return { ok: true, component: comp };
}

/**
 * 批量写参数：一次撤销快照（包 13 的"应用方案"用）。
 * 只写 params 的 patch，不碰端子/占位/模型常数。
 * @param {Array<{id:string, patch:object}>} updates
 */
export function applyParamGroup(updates, label = 'params') {
  if (!state || !Array.isArray(updates) || updates.length === 0) {
    return { ok: false, changed: 0, error: '没有可应用的参数' };
  }
  const targets = [];
  updates.forEach(({ id, patch }) => {
    const comp = findComponent(id);
    if (!comp || !patch || typeof patch !== 'object') return;
    targets.push({ comp, patch });
  });
  if (targets.length === 0) return { ok: false, changed: 0, error: '元件不存在' };
  pushUndo(label);
  targets.forEach(({ comp, patch }) => {
    Object.assign(comp.params, patch);
  });
  invalidate();
  return { ok: true, changed: targets.length };
}

/** 修改元件参数（合并式）；无变化时不写撤销栈 */
export function updateParams(id, patch) {
  if (!state) return { ok: false, error: '电路尚未初始化' };
  const comp = findComponent(id);
  if (!comp) return { ok: false, error: '元件不存在' };
  if (!patch || typeof patch !== 'object') return { ok: false, error: '参数无效' };

  let changed = false;
  Object.keys(patch).forEach((key) => {
    if (comp.params[key] !== patch[key]) changed = true;
  });
  if (!changed) return { ok: true, component: comp, unchanged: true };

  pushUndo(`params:${id}`);
  comp.params = { ...comp.params, ...patch };
  invalidate();
  return { ok: true, component: comp };
}

/* ==========================================================================
   导线
   ========================================================================== */

/**
 * 连接两个端点。端点可以是元件端子，也可以是平台孔位。
 * @returns {{ok:true, wire:object} | {ok:false, error:string}}
 */
export function addWire(a, b) {
  if (!state) return { ok: false, error: '电路尚未初始化' };

  const keyA = refKey(a);
  const keyB = refKey(b);
  if (!keyA || !keyB) return { ok: false, error: '导线端点无效（须为端子或孔位）' };
  if (keyA === keyB) return { ok: false, error: '导线两端不能是同一个端点' };

  const resolvedA = resolveRef(a);
  const resolvedB = resolveRef(b);
  if (!resolvedA) return { ok: false, error: '起点不在当前电路上' };
  if (!resolvedB) return { ok: false, error: '终点不在当前电路上' };

  const duplicated = state.wires.find((wire) => {
    const ka = refKey(wire.a);
    const kb = refKey(wire.b);
    return (ka === keyA && kb === keyB) || (ka === keyB && kb === keyA);
  });
  if (duplicated) return { ok: false, error: '已存在连接' };

  pushUndo(`wire:${keyA}~${keyB}`);

  const wire = {
    id: `wire-${counters.wire + 1}`,
    a: { ...a, x: resolvedA.pos.x, y: resolvedA.pos.y },
    b: { ...b, x: resolvedB.pos.x, y: resolvedB.pos.y },
  };
  counters.wire += 1;
  state.wires.push(wire);
  invalidate();
  return { ok: true, wire };
}

/** 删除导线 */
export function removeWire(id) {
  if (!state) return { ok: false };
  const index = state.wires.findIndex((wire) => wire.id === id);
  if (index === -1) return { ok: false };
  pushUndo(`unwire:${id}`);
  state.wires.splice(index, 1);
  invalidate();
  return { ok: true };
}

/** 清掉所有端点已失效的导线（错误面板的一键清理） */
export function removeDanglingWires() {
  if (!state) return { ok: false, removed: 0 };
  const keep = state.wires.filter((wire) => refExists(wire.a) && refExists(wire.b));
  const removed = state.wires.length - keep.length;
  if (removed === 0) return { ok: true, removed: 0 };
  pushUndo('cleanup:dangling');
  state.wires = keep;
  invalidate();
  return { ok: true, removed };
}

/* ==========================================================================
   网表
   ========================================================================== */

/**
 * 计算网表。并查集合并三类关系：
 *   平台分组（天生同网） + 导线（显式连接）
 * 只有成员数 ≥ 2 的集合才会分配 netId——单独一个端子不构成电气节点。
 */
export function getNetlist() {
  if (netCache) return netCache;
  if (!state) {
    netCache = { netOf: new Map(), nets: new Map() };
    return netCache;
  }

  const parent = new Map();
  const refsByKey = new Map();

  const find = (key) => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root);
    // 路径压缩
    let node = key;
    while (parent.get(node) !== node) {
      const next = parent.get(node);
      parent.set(node, root);
      node = next;
    }
    return root;
  };

  const union = (a, b) => {
    if (!parent.has(a) || !parent.has(b)) return;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  state.components.forEach((comp) => {
    comp.terminals.forEach((terminal) => {
      const key = `c:${comp.id}:${terminal.name}`;
      parent.set(key, key);
      refsByKey.set(key, { componentId: comp.id, terminal: terminal.name });
    });
  });

  const platform = getPlatform(state.platform);
  if (platform) {
    platform.nodes.forEach((node) => {
      const key = `n:${node.id}`;
      parent.set(key, key);
      refsByKey.set(key, { node: node.id });
    });
    platform.groupMap.forEach((members) => {
      if (members.length < 2) return;
      const first = `n:${members[0]}`;
      for (let i = 1; i < members.length; i += 1) union(first, `n:${members[i]}`);
    });
  }

  state.wires.forEach((wire) => {
    union(refKey(wire.a), refKey(wire.b));
  });

  const byRoot = new Map();
  parent.forEach((value, key) => {
    const root = find(key);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(key);
  });

  const netOf = new Map();
  const nets = new Map();
  let index = 0;
  byRoot.forEach((members) => {
    if (members.length < 2) return;
    index += 1;
    const netId = `net${index}`;
    members.forEach((key) => {
      netOf.set(key, netId);
      const terminal = refsByKey.get(key);
      if (terminal && terminal.componentId) {
        const comp = state.components.find((item) => item.id === terminal.componentId);
        if (comp) {
          const target = comp.terminals.find((item) => item.name === terminal.terminal);
          if (target) target.net = netId;
        }
      }
    });
    nets.set(netId, members.map((key) => refsByKey.get(key)).filter(Boolean));
  });

  netCache = { netOf, nets };
  return netCache;
}

/** 端点所在网 id；未接入任何网返回 null */
export function getNetOf(ref) {
  const key = refKey(ref);
  if (!key) return null;
  return getNetlist().netOf.get(key) || null;
}

/** 网内全部端点 */
export function getNetMembers(netId) {
  const list = getNetlist().nets.get(netId);
  return list ? list.slice() : [];
}

/** 某元件是否与任何其它端点同网 */
export function isComponentConnected(componentId) {
  if (!state) return false;
  const comp = findComponent(componentId);
  if (!comp) return false;
  const { netOf } = getNetlist();
  return comp.terminals.some((terminal) => netOf.has(`c:${comp.id}:${terminal.name}`));
}

/* ==========================================================================
   校验
   ========================================================================== */

/**
 * 电路体检。
 * @returns {{
 *   ok: boolean,
 *   danglingWires: string[],
 *   orphanTerminals: {componentId, terminal}[],
 *   isolatedComponents: string[],
 *   overlaps: string[][],
 *   netCount: number
 * }}
 */
export function validateCircuit() {
  const result = {
    ok: true,
    danglingWires: [],
    orphanTerminals: [],
    isolatedComponents: [],
    overlaps: [],
    netCount: 0,
  };
  if (!state) return result;

  state.wires.forEach((wire) => {
    if (!refExists(wire.a) || !refExists(wire.b)) result.danglingWires.push(wire.id);
  });

  const list = getNetlist();
  result.netCount = list.nets.size;

  state.components.forEach((comp) => {
    let connected = false;
    comp.terminals.forEach((terminal) => {
      const key = `c:${comp.id}:${terminal.name}`;
      if (list.netOf.has(key)) connected = true;
      else result.orphanTerminals.push({ componentId: comp.id, terminal: terminal.name });
    });
    if (!connected) result.isolatedComponents.push(comp.id);
  });

  for (let i = 0; i < state.components.length; i += 1) {
    for (let j = i + 1; j < state.components.length; j += 1) {
      const a = state.components[i];
      const b = state.components[j];
      if (rectsOverlap(rectOf(a), rectOf(b))) result.overlaps.push([a.id, b.id]);
    }
  }

  result.ok = result.danglingWires.length === 0 && result.overlaps.length === 0;
  return result;
}

/* ==========================================================================
   暂存（平台切换时无法放置的元件不丢）
   ========================================================================== */

/** 把元件移入某平台的暂存区 */
export function stashComponents(targetPlatformId, components, wires) {
  if (!state) return;
  if (!state.stash[targetPlatformId]) state.stash[targetPlatformId] = { components: [], wires: [] };
  const bucket = state.stash[targetPlatformId];
  bucket.components.push(...cloneComponents(components));
  bucket.wires.push(...cloneWires(wires));
}

/** 取某平台暂存区（取出即清空） */
export function takeStash(platformId) {
  if (!state || !state.stash[platformId]) return { components: [], wires: [] };
  const bucket = state.stash[platformId];
  delete state.stash[platformId];
  return bucket;
}

/** 只读查看暂存区 */
export function peekStash(platformId) {
  return state && state.stash[platformId] ? state.stash[platformId] : { components: [], wires: [] };
}

/* ==========================================================================
   序列化
   ========================================================================== */

/** 导出为可存 localStorage 的纯数组对象（端子由 parts.js 重建，不落盘） */
let instrumentProvider = null;
let instrumentRestorer = null;

/**
 * 仪器面板把"挂点/参数/时基"寄生在存档里（包 10）。
 * 用注入而不是 import：model 层不认识任何 UI 模块，node 单测也不会被 DOM 牵连。
 */
export function setInstrumentProvider(fn) {
  instrumentProvider = typeof fn === 'function' ? fn : null;
}

export function setInstrumentRestorer(fn) {
  instrumentRestorer = typeof fn === 'function' ? fn : null;
}

export function serializeCircuit() {
  if (!state) return null;
  const data = {
    version: 3,
    platform: state.platform,
    components: state.components.map((comp) => ({
      id: comp.id,
      type: comp.type,
      x: comp.x,
      y: comp.y,
      rotation: comp.rotation,
      params: { ...comp.params },
    })),
    wires: state.wires.map((wire) => ({ id: wire.id, a: { ...wire.a }, b: { ...wire.b } })),
    stash: JSON.parse(JSON.stringify(state.stash)),
  };
  if (instrumentProvider) {
    const instruments = instrumentProvider();
    if (instruments) data.instruments = instruments;
  }
  return data;
}

/**
 * 从存档恢复。逐条尽力恢复：
 * 元件非法（类型未知 / 越界 / 重叠）计入 skipped，导线端点无效则保留为悬空导线。
 */
export function loadCircuit(data, platformId) {
  const targetPlatform = isPlatformId(platformId)
    ? platformId
    : (data && isPlatformId(data.platform) ? data.platform : 'exp-box');
  createCircuit(targetPlatform);

  const report = { ok: true, components: 0, wires: 0, skippedComponents: 0, danglingWires: 0 };
  if (!data || typeof data !== 'object') return report;

  if (Array.isArray(data.components)) {
    data.components.forEach((raw) => {
      if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') {
        report.skippedComponents += 1;
        return;
      }
      const added = addComponent(raw.type, raw.x, raw.y, {
        rotation: raw.rotation,
        params: raw.params,
        id: typeof raw.id === 'string' ? raw.id : undefined,
        silent: true,
      });
      if (!added.ok) report.skippedComponents += 1;
      else report.components += 1;
    });
  }

  if (Array.isArray(data.wires)) {
    data.wires.forEach((raw) => {
      if (!raw || typeof raw !== 'object') return;
      const keyA = refKey(raw.a);
      const keyB = refKey(raw.b);
      if (!keyA || !keyB || keyA === keyB) return;
      const duplicate = state.wires.some((wire) => {
        const ka = refKey(wire.a);
        const kb = refKey(wire.b);
        return (ka === keyA && kb === keyB) || (ka === keyB && kb === keyA);
      });
      if (duplicate) return;

      // 载荷攻击 / 旧存档：端点可能已不存在，保留但计入悬空
      if (!refExists(raw.a) || !refExists(raw.b)) report.danglingWires += 1;
      state.wires.push({
        id: typeof raw.id === 'string' ? raw.id : `wire-${counters.wire + 1}`,
        a: { ...raw.a },
        b: { ...raw.b },
      });
      counters.wire += 1;
      report.wires += 1;
    });
  }

  // 仪器挂点/参数：等元件与网表都就绪后再恢复（面板要按 netId 找通道）
  if (data.instruments && instrumentRestorer) {
    try { instrumentRestorer(data.instruments); } catch (err) { /* 仪器段坏了不能拖垮电路 */ }
  }

  if (data.stash && typeof data.stash === 'object') {
    Object.keys(data.stash).forEach((platformId) => {
      const bucket = data.stash[platformId];
      if (!bucket || typeof bucket !== 'object') return;
      state.stash[platformId] = {
        components: Array.isArray(bucket.components) ? bucket.components : [],
        wires: Array.isArray(bucket.wires) ? bucket.wires : [],
      };
    });
  }

  invalidate();
  return report;
}
