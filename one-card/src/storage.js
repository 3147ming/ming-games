// 存档（localStorage，Node 下退化为内存 Map 以便单测）

const mem = new Map();

function hasLS() {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null;
  } catch {
    return false;
  }
}

export function load(key, fallback) {
  try {
    const raw = hasLS() ? localStorage.getItem(key) : mem.get(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  const raw = JSON.stringify(value);
  try {
    if (hasLS()) localStorage.setItem(key, raw);
    else mem.set(key, raw);
  } catch {
    mem.set(key, raw);
  }
}

export function clear(key) {
  try {
    if (hasLS()) localStorage.removeItem(key);
    else mem.delete(key);
  } catch {
    mem.delete(key);
  }
}
