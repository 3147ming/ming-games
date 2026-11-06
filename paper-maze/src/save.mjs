// 《纸上迷城》— 存档层
// 唯一持久化媒介是 localStorage（可注入替身，便于 node --test）。
// 损坏存档一律"修复到可用"，绝不抛异常。

import { ROOM_IDS, ITEMS, CLUES, PUZZLES, ENDINGS, ENDING_ORDER, META } from './story.mjs';
import { STATE_VERSION, createState, serializeState } from './engine.mjs';

export const SAVE_KEY = 'papermaze.save.v1';
export const SAVE_VERSION = 1;

/* ------------------------------------------------------------ 存储后端 */

export function memoryStorage(seed) {
  const map = new Map(seed ? Object.entries(seed) : []);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    _dump: () => Object.fromEntries(map),
  };
}

export function getStorage() {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return null;
    const probe = '__papermaze_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ 默认与规范化 */

export function defaultSave() {
  return {
    version: SAVE_VERSION,
    savedAt: null,
    elapsedMs: 0,
    runs: 0,
    endings: {},
    settings: { muted: false, sfx: true },
    state: serializeState(createState()),
  };
}

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const num = (x, d = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
/** 计数类字段一律取非负整数，避免手改存档塞进小数。 */
const count = (x, d = 0) => Math.max(0, Math.floor(num(x, d)));

/** 只接受已知 id，未知一律丢弃（版本升级 / 手改存档都走这条路）。 */
function keepKnown(list, table) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((x) => typeof x === 'string' && Object.prototype.hasOwnProperty.call(table, x)))];
}

/** v0（早期字段名） → v1。 */
export function migrate(raw) {
  if (!isObj(raw)) return null;
  const v = num(raw.version, 0);
  if (v === SAVE_VERSION) return raw;
  if (v === 0 && (raw.room || raw.bag || raw.seen)) {
    return {
      version: SAVE_VERSION,
      savedAt: raw.savedAt ?? null,
      elapsedMs: num(raw.ms, 0),
      runs: num(raw.runs, 1),
      endings: isObj(raw.endingsUnlocked)
        ? Object.fromEntries(
            Object.keys(raw.endingsUnlocked)
              .filter((k) => ENDINGS[k])
              .map((k) => [k, { count: 1, bestMs: null, firstAt: null }]),
          )
        : {},
      settings: { muted: !!raw.muted, sfx: true },
      state: {
        v: STATE_VERSION,
        roomId: raw.room,
        inventory: Array.isArray(raw.bag) ? raw.bag : [],
        clues: Array.isArray(raw.seen) ? raw.seen : [],
        solvedPuzzles: Array.isArray(raw.done) ? raw.done : [],
        takenHotspots: [],
        visits: {},
        steps: num(raw.steps, 0),
        hintsUsed: num(raw.hints, 0),
        startedAt: null,
        lastActionAt: null,
        endedAt: null,
        endingId: null,
        ngPlus: false,
      },
    };
  }
  return null; // 版本比当前新或结构不可识别
}

/**
 * 把任意输入整理成合法存档。
 * @returns {{ save: object, repaired: boolean, issues: string[] }}
 */
export function normalizeSave(raw) {
  const issues = [];
  let src = raw;
  if (typeof src === 'string') {
    try {
      src = JSON.parse(src);
    } catch {
      issues.push('json');
      src = null;
    }
  }
  if (!isObj(src)) {
    return { save: defaultSave(), repaired: true, issues: [...issues, 'not-object'] };
  }

  const migrated = migrate(src);
  if (!migrated) {
    return { save: defaultSave(), repaired: true, issues: [...issues, 'version'] };
  }
  if (migrated !== src) issues.push('migrated');

  const st = isObj(migrated.state) ? migrated.state : {};
  if (!isObj(migrated.state)) issues.push('state');

  const stock = Object.keys(ITEMS).filter((id) => ITEMS[id].start);
  let inventory = keepKnown(st.inventory, ITEMS);
  if (!inventory.length) inventory = [...stock];
  for (const s of stock) if (!inventory.includes(s)) inventory.push(s);

  const roomId = typeof st.roomId === 'string' && ROOM_IDS.includes(st.roomId) ? st.roomId : META.start;
  if (roomId !== st.roomId) issues.push('roomId');

  const visits = {};
  if (isObj(st.visits)) {
    for (const [k, val] of Object.entries(st.visits)) {
      if (ROOM_IDS.includes(k)) visits[k] = Math.max(1, count(val, 1));
    }
  }
  visits[roomId] = visits[roomId] || 1;

  const endings = {};
  if (isObj(migrated.endings)) {
    for (const [k, val] of Object.entries(migrated.endings)) {
      if (!ENDINGS[k]) continue;
      const e = isObj(val) ? val : {};
      endings[k] = {
        count: Math.max(1, count(e.count, 1)),
        bestMs: typeof e.bestMs === 'number' && Number.isFinite(e.bestMs) && e.bestMs > 0 ? e.bestMs : null,
        firstAt: num(e.firstAt, 0) || null,
      };
    }
  }

  const save = {
    version: SAVE_VERSION,
    savedAt: num(migrated.savedAt, 0) || null,
    elapsedMs: count(migrated.elapsedMs, 0),
    runs: count(migrated.runs, 0),
    endings,
    settings: {
      muted: !!(isObj(migrated.settings) ? migrated.settings.muted : false),
      sfx: isObj(migrated.settings) ? migrated.settings.sfx !== false : true,
    },
    state: {
      v: STATE_VERSION,
      roomId,
      inventory,
      clues: keepKnown(st.clues, CLUES),
      solvedPuzzles: keepKnown(st.solvedPuzzles, PUZZLES),
      takenHotspots: Array.isArray(st.takenHotspots) ? st.takenHotspots.filter((x) => typeof x === 'string') : [],
      visits,
      steps: count(st.steps, 0),
      hintsUsed: count(st.hintsUsed, 0),
      startedAt: typeof st.startedAt === 'number' ? st.startedAt : null,
      lastActionAt: typeof st.lastActionAt === 'number' ? st.lastActionAt : null,
      endedAt: typeof st.endedAt === 'number' ? st.endedAt : null,
      endingId: ENDINGS[st.endingId] ? st.endingId : null,
      ngPlus: !!st.ngPlus,
    },
  };
  return { save, repaired: issues.length > 0, issues };
}

/* ------------------------------------------------------------ 读写 */

export function loadSave(storage = getStorage()) {
  if (!storage) return { save: defaultSave(), ok: false, repaired: true, issues: ['no-storage'] };
  let raw = null;
  try {
    raw = storage.getItem(SAVE_KEY);
  } catch {
    return { save: defaultSave(), ok: false, repaired: true, issues: ['read-error'] };
  }
  if (raw == null || raw === '') return { save: defaultSave(), ok: true, repaired: false, issues: ['empty'] };
  const res = normalizeSave(raw);
  return { ...res, ok: true };
}

export function writeSave(save, storage = getStorage()) {
  if (!storage) return false;
  try {
    storage.setItem(SAVE_KEY, JSON.stringify(save));
    return true;
  } catch {
    return false;
  }
}

export function clearSave(storage = getStorage()) {
  if (!storage) return false;
  try {
    storage.removeItem(SAVE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function saveFromState(state, save, now) {
  const next = { ...save };
  next.state = serializeState(state);
  next.savedAt = now ?? null;
  return next;
}

export function stateFromSave(save) {
  const s = createState(save.state || {});
  s.journal = [];
  return s;
}

/* ------------------------------------------------------------ 局外数据 */

export function recordEnding(save, endingId, elapsedMs, now) {
  if (!ENDINGS[endingId]) return save;
  const prev = save.endings[endingId] || { count: 0, bestMs: null, firstAt: null };
  const best =
    typeof elapsedMs === 'number' && elapsedMs > 0
      ? prev.bestMs == null
        ? elapsedMs
        : Math.min(prev.bestMs, elapsedMs)
      : prev.bestMs;
  return {
    ...save,
    endings: {
      ...save.endings,
      [endingId]: { count: prev.count + 1, bestMs: best, firstAt: prev.firstAt ?? now ?? null },
    },
  };
}

export function codex(save) {
  return ENDING_ORDER.map((id) => {
    const rec = save.endings[id];
    return {
      id,
      title: ENDINGS[id].title,
      glyph: ENDINGS[id].glyph,
      tone: ENDINGS[id].tone,
      unlocked: !!rec,
      count: rec ? rec.count : 0,
      bestMs: rec ? rec.bestMs : null,
      firstAt: rec ? rec.firstAt : null,
    };
  });
}

export function endingStats(save) {
  const total = ENDING_ORDER.length;
  const got = ENDING_ORDER.filter((id) => save.endings[id]).length;
  return { unlocked: got, total, complete: got === total, runs: save.runs };
}

/** 二周目：继承线索，不继承物品；局外统计保留。 */
export function startNewRun(save, { ngPlus = false, now = null } = {}) {
  const inheritedClues = ngPlus ? [...(save.state?.clues || [])] : [];
  const state = createState({ ngPlus, clues: inheritedClues, startedAt: null });
  const next = {
    ...save,
    runs: (save.runs || 0) + 1,
    elapsedMs: 0,
    savedAt: now,
    state: serializeState(state),
  };
  return { save: next, state };
}
