/**
 * store.js — localStorage 封装的实验进度存储
 * 数据形态：{ [expId]: { lastOpenedAt: 时间戳, openedCount: 次数 } }
 * localStorage 不可用（隐私模式 / 配额写满）时静默降级为内存对象，不抛错。
 */

/** localStorage 键名 */
const STORAGE_KEY = 'lab-sim-progress';

/** 内存降级容器：localStorage 不可用时作为唯一数据源 */
let memoryStore = Object.create(null);

/** 可用性探测结果缓存：null 未探测 / true 可用 / false 不可用 */
let storageUsable = null;

/** 探测 localStorage 是否可读写（写入后立即删除探针键） */
function canUseStorage() {
  if (storageUsable !== null) return storageUsable;
  try {
    const probeKey = '__lab_sim_probe__';
    window.localStorage.setItem(probeKey, '1');
    window.localStorage.removeItem(probeKey);
    storageUsable = true;
  } catch (err) {
    storageUsable = false;
  }
  return storageUsable;
}

/** 读取全部进度记录，任何异常都退化为空对象 */
function readAll() {
  if (!canUseStorage()) return memoryStore;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch (err) {
    return {};
  }
}

/** 写回全部进度记录，写失败则关闭 localStorage 并继续用内存保存 */
function writeAll(data) {
  if (!canUseStorage()) {
    memoryStore = data;
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (err) {
    storageUsable = false;
    memoryStore = data;
  }
}

/** 获取全部进度记录（返回副本，避免外部误改内部状态） */
export function getProgress() {
  const all = readAll();
  return JSON.parse(JSON.stringify(all));
}

/** 获取单个实验的进度记录，无记录返回 null */
export function getProgressOf(expId) {
  const all = readAll();
  return all[expId] ? { ...all[expId] } : null;
}

/** 记录一次"打开实验"事件：存在则次数 +1 并更新时间，不存在则新建；返回最新记录 */
export function setProgress(expId) {
  if (typeof expId !== 'string' || expId === '') return null;
  const all = readAll();
  const prev = all[expId];
  const prevCount = prev && Number.isFinite(prev.openedCount) ? prev.openedCount : 0;
  const record = { lastOpenedAt: Date.now(), openedCount: prevCount + 1 };
  all[expId] = record;
  writeAll(all);
  return { ...record };
}

/** 清除单个实验的进度记录（供后续指令包"重置实验"使用） */
export function clearProgress(expId) {
  const all = readAll();
  if (!all[expId]) return false;
  delete all[expId];
  writeAll(all);
  return true;
}
