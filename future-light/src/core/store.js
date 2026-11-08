// 全局存档 v2：金币 / 总星数 / 解锁进度 / 通关记录 / 最佳分 / 游玩次数 / 历史成绩
// 启动时自动迁移旧 BRAIN-GYM 部署站（localStorage key: bt_<id> / bt_prog）数据。
const KEY = 'futlight_save_v2';
const DEFAULT = { coins: 0, stars: 0, unlocked: {}, cleared: {}, best: {}, plays: {}, history: {}, migrated: false };

// 旧工程游戏 id -> 新工程 id（仅迁移功能正常的同名游戏）
const LEGACY_MAP = {
  dual: 'dual', light: 'light', conveyor: 'conveyor',
  connect: 'connect', stroop: 'stroop', match3: 'match3',
  nonogram: 'nonogram', octagram: 'octagram'
};
// 超过此值的旧成绩视为异常（如双雄争霸 106677 / 188700），标为「历史成绩」不参与排行
const ANOMALY_CAP = 5000;

let data = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULT);
    const parsed = JSON.parse(raw);
    return Object.assign(structuredClone(DEFAULT), parsed);
  } catch {
    return structuredClone(DEFAULT);
  }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch {}
}

// 从旧 BRAIN-GYM 部署站迁移玩家数据（只执行一次）
function migrate() {
  if (data.migrated) return;
  try {
    let prog = {};
    try { prog = JSON.parse(localStorage.getItem('bt_prog') || '{}'); } catch { prog = {}; }
    if (typeof prog !== 'object' || !prog) prog = {};
    for (const oldId in LEGACY_MAP) {
      const id = LEGACY_MAP[oldId];
      const k = id + ':1';
      const raw = localStorage.getItem('bt_' + oldId);
      if (raw != null) {
        const v = Number(raw);
        if (!isNaN(v) && v > 0) {
          if (v > ANOMALY_CAP) {
            if (v > (data.history[k] || 0)) data.history[k] = v; // 历史成绩，不参与排行
          } else if (v > (data.best[k] || 0)) {
            data.best[k] = v;
          }
        }
      }
      // 旧进度：bt_prog[id] 可能是已解锁关数
      const oldLv = Number(prog[oldId] != null ? prog[oldId] : prog[id]);
      if (!isNaN(oldLv) && oldLv > (data.unlocked[id] || 1)) {
        data.unlocked[id] = Math.min(oldLv, 999);
      }
    }
  } catch (e) { /* 迁移失败不影响新工程 */ }
  data.migrated = true;
  save();
}

export const store = {
  // 金币公式：与得分挂钩，统一全游戏
  coinsFor(score) { return Math.max(1, Math.floor(score / 25)); },

  get coins() { return data.coins; },
  get stars() { return data.stars; },

  getUnlocked(id) { return data.unlocked[id] || 1; },
  setUnlocked(id, lv) {
    if ((data.unlocked[id] || 1) < lv) { data.unlocked[id] = lv; save(); }
  },

  isCleared(id, lv) { return !!data.cleared[id + ':' + lv]; },
  clear(id, lv) { data.cleared[id + ':' + lv] = true; save(); },

  getBest(id, lv) { return data.best[id + ':' + lv] || 0; },
  isHistorical(id, lv) { return data.history[id + ':' + lv] || 0; },
  setBest(id, lv, v) {
    const k = id + ':' + lv;
    if (v > (data.best[k] || 0)) { data.best[k] = v; save(); }
  },

  addPlay(id, lv) { const k = id + ':' + lv; data.plays[k] = (data.plays[k] || 0) + 1; save(); },
  getPlays(id, lv) { return data.plays[id + ':' + lv] || 0; },

  addCoins(n) { data.coins += n; save(); },
  addStars(n) { data.stars += n; save(); },
  spendCoins(n) {
    if (data.coins < n) return false;
    data.coins -= n; save(); return true;
  },

  migrate,
  reset() { data = structuredClone(DEFAULT); save(); }
};
