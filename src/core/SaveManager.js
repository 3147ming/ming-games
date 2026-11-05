/**
 * 本地存档（localStorage）
 *
 * 只做"读 / 写 / 合并 / 重置"，不含任何游戏逻辑。
 * 局外成长（天赋、永久属性、机甲解锁、战绩）都从这里进出，
 * 后续 P3/P4/P5 直接读写这个对象，不要再各自散写 localStorage。
 */

export const SAVE_KEY = 'warehouse-strike.save.v1';
export const SAVE_VERSION = 1;

/** 全新存档的默认结构 */
export function defaultSave() {
  return {
    v: SAVE_VERSION,
    meta: { cores: 0 },
    talents: { atk: 0, def: 0, mob: 0 },
    permanent: { hp: 0, dmg: 0, armor: 0, speed: 0 },
    unlocks: {
      mechs: [],
      weapons: ['rifle', 'pistol', 'shotgun', 'sniper'],
      levels: 1,
    },
    stats: { runs: 0, kills: 0, bestLevel: 1, bestWave: 0, totalTime: 0 },
    settings: { sens: 0.0022, vol: 1.0 },
  };
}

/** 深合并：只保留默认结构里存在的键，避免旧存档 / 脏数据污染 */
function mergeDefaults(target, source) {
  if (!source || typeof source !== 'object') return target;
  for (const key of Object.keys(target)) {
    const def = target[key];
    const val = source[key];
    if (val === undefined) continue;
    if (Array.isArray(def)) {
      if (Array.isArray(val)) target[key] = val.slice();
    } else if (def && typeof def === 'object') {
      target[key] = mergeDefaults({ ...def }, val);
    } else if (typeof val === typeof def) {
      target[key] = val;
    }
  }
  return target;
}

export class SaveManager {
  /**
   * @param {Storage|null} storage 可注入，方便单测；浏览器里默认用 localStorage
   */
  constructor(storage = null) {
    this.storage = storage || SaveManager._pickStorage();
    this.data = this.load();
  }

  static _pickStorage() {
    try {
      const s = globalThis.localStorage;
      if (s) return s;
    } catch (e) {
      // 隐私模式 / 沙箱环境可能直接抛错
    }
    return null;
  }

  /** 读取存档；损坏或不存在时返回默认值 */
  load() {
    const base = defaultSave();
    if (!this.storage) return base;
    try {
      const raw = this.storage.getItem(SAVE_KEY);
      if (!raw) return base;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.v !== SAVE_VERSION) return base;
      return mergeDefaults(base, parsed);
    } catch (e) {
      return base;
    }
  }

  /** 写入当前内存中的数据；存储不可用时静默失败（游戏照常可玩） */
  save() {
    if (!this.storage) return false;
    try {
      this.storage.setItem(SAVE_KEY, JSON.stringify(this.data));
      return true;
    } catch (e) {
      return false;
    }
  }

  reset() {
    this.data = defaultSave();
    return this.save();
  }

  /** 局外素材：丧尸核心 */
  addCores(n) {
    this.data.meta.cores = Math.max(0, (this.data.meta.cores || 0) + n);
    this.save();
  }

  /**
   * 一局结束后调用
   * @param {{kills?:number, seconds?:number, level?:number, wave?:number, win?:boolean}} run
   */
  recordRun({ kills = 0, seconds = 0, level = null, wave = null, win = false } = {}) {
    const st = this.data.stats;
    st.runs += 1;
    st.kills += kills;
    st.totalTime += seconds;
    if (level != null) st.bestLevel = Math.max(st.bestLevel, level);
    if (wave != null) st.bestWave = Math.max(st.bestWave, wave);
    if (win && level != null) {
      this.data.unlocks.levels = Math.max(this.data.unlocks.levels, level + 1);
    }
    this.save();
  }
}
