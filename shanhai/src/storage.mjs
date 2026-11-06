/**
 * 本地存档。零后端，只用 localStorage。
 *
 * 为什么存档结构用对象而不是数组：
 *   以后新增关卡时，旧存档缺一个 key 只会少一条记录，不会因为数组长度变化而整体失效。
 * 为什么要版本号：
 *   localStorage 是用户可改、也可能被旧版本写坏的环境。版本不符或结构损坏时
 *   宁可回到默认档，也不能让战斗页面因为 JSON.parse 抛错而白屏。
 */
(function attachStorage(root) {
  'use strict';

  const SAVE_VERSION = 1;
  const STORAGE_KEY = 'shanhai.save.v1';
  const RATINGS = Object.freeze(['C', 'B', 'A', 'S']);

  let memoryFallback = null;

  function defaultSave() {
    return {
      version: SAVE_VERSION,
      cleared: {},
      updatedAt: null,
    };
  }

  function getStorage(injected) {
    if (injected) return injected;
    try {
      const local = root.localStorage;
      if (local) {
        // 某些隐私模式会允许拿到对象、但 setItem 时抛错；这里只探测读取。
        const probe = '__shanhai_probe__';
        local.setItem(probe, '1');
        local.removeItem(probe);
        return local;
      }
    } catch (error) {
      // 静默降级到内存，游戏仍可玩，只是刷新后丢失进度。
    }
    if (!memoryFallback) {
      const memory = new Map();
      memoryFallback = {
        getItem: (key) => (memory.has(key) ? memory.get(key) : null),
        setItem: (key, value) => memory.set(key, String(value)),
        removeItem: (key) => memory.delete(key),
      };
    }
    return memoryFallback;
  }

  function validRating(value) {
    return RATINGS.includes(value);
  }

  function normalizeEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    if (!validRating(entry.bestRating)) return null;
    const clears = Number.isInteger(entry.clears) && entry.clears > 0 ? entry.clears : 1;
    const bestRounds = Number.isFinite(entry.bestRounds) && entry.bestRounds > 0
      ? Math.round(entry.bestRounds)
      : null;
    const bestHp = Number.isFinite(entry.bestHp) && entry.bestHp >= 0
      ? Math.round(entry.bestHp)
      : null;
    return {
      bestRating: entry.bestRating,
      bestRounds,
      bestHp,
      clears,
      lastClearedAt: typeof entry.lastClearedAt === 'string' ? entry.lastClearedAt : null,
    };
  }

  /**
   * 容错读取：
   *   - localStorage 不可用 → 内存档；
   *   - JSON 损坏 / 版本不符 / 顶层不是对象 → 返回默认档；
   *   - 单条关卡记录损坏只丢这一条，不丢整档。
   */
  function loadSave(injectedStorage) {
    let raw = null;
    try {
      raw = getStorage(injectedStorage).getItem(STORAGE_KEY);
    } catch (error) {
      return defaultSave();
    }
    if (!raw) return defaultSave();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return defaultSave();
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return defaultSave();
    }
    if (parsed.version !== SAVE_VERSION) {
      return defaultSave();
    }

    const cleaned = defaultSave();
    cleaned.updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null;
    const source = parsed.cleared && typeof parsed.cleared === 'object' && !Array.isArray(parsed.cleared)
      ? parsed.cleared
      : {};
    for (const [stageId, entry] of Object.entries(source)) {
      if (!/^[a-z0-9_-]{1,32}$/i.test(stageId)) continue;
      const normalized = normalizeEntry(entry);
      if (normalized) cleaned.cleared[stageId] = normalized;
    }
    return cleaned;
  }

  function writeSave(save, injectedStorage) {
    const safe = save && save.version === SAVE_VERSION ? save : defaultSave();
    safe.updatedAt = new Date().toISOString();
    try {
      getStorage(injectedStorage).setItem(STORAGE_KEY, JSON.stringify(safe));
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * 记录一次通关。只有胜利才调用；同关卡保留更高评级，
   * 同评级下保留更少回合与更高剩余血量，作为“更好的一次”。
   */
  function recordClear(stageId, result, injectedStorage) {
    if (!stageId || !result || !result.won) {
      return { save: loadSave(injectedStorage), recorded: false };
    }
    const save = loadSave(injectedStorage);
    const previous = save.cleared[stageId] || null;
    const rating = validRating(result.rating) ? result.rating : 'B';
    const rounds = Number.isFinite(result.rounds) ? Math.max(1, Math.round(result.rounds)) : null;
    const hp = Number.isFinite(result.hpRemaining) ? Math.max(0, Math.round(result.hpRemaining)) : null;

    let bestRating = rating;
    let bestRounds = rounds;
    let bestHp = hp;
    if (previous) {
      if (RATINGS.indexOf(previous.bestRating) > RATINGS.indexOf(rating)) {
        bestRating = previous.bestRating;
      } else if (previous.bestRating === rating) {
        // 同评级时保留“回合更少，其次剩余血量更高”的一次。
        bestRounds = Math.min(
          rounds == null ? Infinity : rounds,
          previous.bestRounds == null ? Infinity : previous.bestRounds,
        );
        if (!Number.isFinite(bestRounds)) bestRounds = null;
        bestHp = Math.max(hp == null ? 0 : hp, previous.bestHp == null ? 0 : previous.bestHp);
      }
    }

    save.cleared[stageId] = {
      bestRating,
      bestRounds,
      bestHp,
      clears: (previous ? previous.clears : 0) + 1,
      lastClearedAt: new Date().toISOString(),
    };
    const saved = writeSave(save, injectedStorage);
    return { save, recorded: saved };
  }

  function clearSave(injectedStorage) {
    try {
      getStorage(injectedStorage).removeItem(STORAGE_KEY);
    } catch (error) {
      // 清档失败不影响战斗。
    }
  }

  const api = {
    SAVE_VERSION,
    STORAGE_KEY,
    RATINGS,
    defaultSave,
    loadSave,
    writeSave,
    recordClear,
    clearSave,
  };

  Object.defineProperty(root, 'ShanhaiStorage', {
    value: Object.freeze(api),
    writable: false,
    configurable: false,
    enumerable: true,
  });
}(typeof globalThis !== 'undefined' ? globalThis : this));
