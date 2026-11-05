/**
 * 本地存档（localStorage）
 *
 * 只做"读 / 写 / 合并 / 重置"，不含任何游戏逻辑。
 * 局外成长（天赋、永久属性、机甲解锁、战绩）都从这里进出，
 * 后续 P3/P4/P5 直接读写这个对象，不要再各自散写 localStorage。
 */

import { DEFAULT_BINDS } from '../config/keybinds.js';
import { defaultLoadout, getAttachment } from '../config/mods.js';
import { MISSIONS, calcRunRewards, missionProgress } from '../config/economy.js';
import { ATTRIBUTES, LEVEL, MECHS, talentCost, runXp, xpToNext } from '../config/growth.js';

export const SAVE_KEY = 'warehouse-strike.save.v1';
export const SAVE_VERSION = 1;

/** 全新存档的默认结构 */
export function defaultSave() {
  return {
    v: SAVE_VERSION,
    meta: {
      cores: 0,
      coins: 0,
      reputation: 0,
      materials: { awaken: 0, mecha: 0, research: 0 },
      claimedMissions: [],
    },
    talents: { atk: 0, def: 0, mob: 0 },
    permanent: { hp: 0, dmg: 0, armor: 0, speed: 0 },
    progress: { level: 1, xp: 0, points: 0 },
    unlocks: {
      mechs: [],
      weapons: ['rifle', 'pistol', 'shotgun', 'sniper'],
      levels: 1,
    },
    stats: { runs: 0, kills: 0, bestLevel: 1, bestWave: 0, totalTime: 0 },
    loadout: defaultLoadout(),
    settings: {
      sens: 0.0022,
      vol: 1.0,
      autoPickup: true,
      binds: { ...DEFAULT_BINDS },
    },
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

  /** 修改单项设置（灵敏度 / 音量 / 自动拾取）并保存 */
  setSetting(key, value) {
    if (!(key in this.data.settings)) return false;
    this.data.settings[key] = value;
    return this.save();
  }

  /** 改键：把某个动作绑定到指定按键编码 */
  setBind(action, code) {
    if (!(action in this.data.settings.binds)) return false;
    this.data.settings.binds[action] = code;
    return this.save();
  }

  /** 恢复默认键位 */
  resetBinds() {
    this.data.settings.binds = { ...DEFAULT_BINDS };
    return this.save();
  }

  /** 改装：把某武器某槽位换成指定配件 */
  setMod(weaponId, slotId, attachmentId) {
    const slots = this.data.loadout[weaponId];
    if (!slots || !(slotId in slots)) return false;
    const att = getAttachment(slotId, attachmentId);
    slots[slotId] = att ? att.id : 'none';
    return this.save();
  }

  /** 一键卸下所有改装 */
  resetLoadout() {
    this.data.loadout = defaultLoadout();
    return this.save();
  }

  /** 局外素材：丧尸核心 */
  addCores(n) {
    this.data.meta.cores = Math.max(0, (this.data.meta.cores || 0) + n);
    this.save();
  }

  /** 统一发放奖励（金币 / 声望 / 核心 / 材料），返回实际发放明细 */
  _grantReward(reward = {}) {
    const meta = this.data.meta;
    const coins = reward.coins || 0;
    const reputation = reward.reputation || 0;
    const cores = reward.cores || 0;
    const materials = {};
    meta.coins += coins;
    meta.reputation += reputation;
    meta.cores += cores;
    if (reward.materials) {
      for (const [key, value] of Object.entries(reward.materials)) {
        if (!(key in meta.materials)) continue;
        meta.materials[key] += value;
        materials[key] = value;
      }
    }
    return { coins, reputation, cores, materials };
  }

  /** 消费金币 / 声望 / 材料；任一项余额不足时返回 false 且不扣款 */
  spend({ coins = 0, reputation = 0, materials = null } = {}) {
    const meta = this.data.meta;
    if (meta.coins < coins || meta.reputation < reputation) return false;
    if (materials) {
      for (const [key, value] of Object.entries(materials)) {
        if (!(key in meta.materials) || meta.materials[key] < value) return false;
      }
    }
    meta.coins -= coins;
    meta.reputation -= reputation;
    if (materials) {
      for (const [key, value] of Object.entries(materials)) meta.materials[key] -= value;
    }
    this.save();
    return true;
  }

  // ---------------- 局外成长：等级 / 属性 / 天赋 / 机甲 ----------------
  /** 当前等级与经验进度 */
  getProgress() {
    const p = this.data.progress;
    return {
      level: p.level,
      xp: p.xp,
      points: p.points,
      next: xpToNext(p.level),
      max: p.level >= LEVEL.max,
    };
  }

  /**
   * 增加经验并处理连续升级；返回升级获得的属性点与新等级。
   * 满级后经验不再累计。
   */
  addXp(amount) {
    const p = this.data.progress;
    let gained = 0;
    if (p.level < LEVEL.max) {
      p.xp += Math.max(0, Math.floor(amount));
      while (p.level < LEVEL.max && p.xp >= xpToNext(p.level)) {
        p.xp -= xpToNext(p.level);
        p.level += 1;
        p.points += LEVEL.pointsPerLevel;
        gained += LEVEL.pointsPerLevel;
      }
      if (p.level >= LEVEL.max) p.xp = 0;
      this.save();
    }
    return { level: p.level, points: gained, xp: p.xp };
  }

  /** 分配一点属性；点数不足 / 已满时返回 false */
  allocateAttr(stat) {
    const def = ATTRIBUTES[stat];
    const p = this.data.progress;
    const cur = this.data.permanent[stat] || 0;
    if (!def || p.points <= 0 || cur >= def.max) return false;
    this.data.permanent[stat] = cur + 1;
    p.points -= 1;
    this.save();
    return true;
  }

  /** 升级天赋；返回 {ok, message} */
  upgradeTalent(branch) {
    const def = this.data.talents;
    if (!(branch in def)) return { ok: false, message: '未知天赋分支' };
    const cost = talentCost(branch, def[branch]);
    if (!cost) return { ok: false, message: '该分支已满级' };
    if (!this.spend({ coins: cost.coins, materials: { awaken: cost.awaken } })) {
      return { ok: false, message: `需要 ${cost.coins} 金币 + ${cost.awaken} 觉醒材料` };
    }
    def[branch] += 1;
    this.save();
    return { ok: true, message: `天赋提升：${branch} → ${def[branch]} 级` };
  }

  /** 解锁机甲；返回 {ok, message} */
  unlockMech(id) {
    const def = MECHS[id];
    if (!def) return { ok: false, message: '未知机甲' };
    const mechs = this.data.unlocks.mechs || [];
    if (mechs.includes(id)) return { ok: false, message: '已解锁' };
    const cost = def.cost;
    if (!this.spend({ coins: cost.coins, materials: { mecha: cost.mecha } })) {
      return { ok: false, message: `需要 ${cost.coins} 金币 + ${cost.mecha} 机甲材料` };
    }
    mechs.push(id);
    this.save();
    return { ok: true, message: `已解锁：${def.name}` };
  }

  /** 机甲是否已解锁 */
  hasMech(id) {
    return (this.data.unlocks.mechs || []).includes(id);
  }

  /** 任务列表：进度按累计战绩实时计算 */
  getMissionStates() {
    const claimed = this.data.meta.claimedMissions || [];
    return MISSIONS.map((m) => ({
      id: m.id,
      name: m.name,
      desc: m.desc,
      target: m.target,
      progress: missionProgress(m, this.data.stats),
      claimed: claimed.includes(m.id),
      reward: m.reward,
    }));
  }

  /** 领取任务奖励；未完成 / 已领取返回 null */
  claimMission(id) {
    const def = MISSIONS.find((m) => m.id === id);
    if (!def) return null;
    if (this.data.meta.claimedMissions.includes(id)) return null;
    if (missionProgress(def, this.data.stats) < def.target) return null;
    const granted = this._grantReward(def.reward);
    this.data.meta.claimedMissions.push(id);
    this.save();
    return granted;
  }

  /**
   * 一局结束后调用：累计战绩 + 结算金币 / 声望 / 核心
   * @param {{kills?:number, seconds?:number, level?:number, wave?:number, win?:boolean}} run
   * @returns {{coins:number, reputation:number, cores:number, materials:object}}
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
    const rewards = calcRunRewards({ kills, waves: wave || 0, win });
    this._grantReward(rewards);
    const xp = runXp({ kills, waves: wave || 0, win });
    const up = this.addXp(xp);
    rewards.xp = xp;
    rewards.levelUp = up.points > 0 ? up.points : 0;
    rewards.level = up.level;
    this.save();
    return rewards;
  }
}
