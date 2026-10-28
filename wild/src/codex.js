// 阶段10·P1-11：图鉴（只增不减的收集册）。
//
// ★ 纯逻辑模块：顶层不碰 DOM；localStorage 读写全部 try/catch ⟹ 隐私模式静默降级。
// ★ 独立 key：**不往 wild.meta.v2 里塞**（那份存档已有 8 个字段，再混进去会让
//   loadMeta 的兜底分支越来越难读）。
//
// 形状：
//   { kinds: { normal: 3, boss1: 1, ... }, evolutions: ['ev_spiral'], weapons: ['sword'], skins: ['flame'] }
//   · kinds 同时装普通怪与 Boss（Boss 由 res.bossSpawned 映射进来，因为 spawnBoss 不走 kindCounts）；
//   · 全部"只增不减"：计数累加、集合去重。

const KEY = 'wild.codex.v1';

const EMPTY = () => ({ kinds: {}, evolutions: [], weapons: [], skins: [] });

/** 读图鉴；损坏 / 隐私模式 ⟹ 空册，绝不抛。 */
export function loadCodex() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const o = JSON.parse(raw);
      return {
        kinds: (o && o.kinds && typeof o.kinds === 'object') ? { ...o.kinds } : {},
        evolutions: Array.isArray(o && o.evolutions) ? o.evolutions.slice() : [],
        weapons: Array.isArray(o && o.weapons) ? o.weapons.slice() : [],
        skins: Array.isArray(o && o.skins) ? o.skins.slice() : [],
      };
    }
  } catch { /* 忽略 */ }
  return EMPTY();
}

function saveCodex(c) {
  try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* 忽略 */ }
  return c;
}

/**
 * 合并一局的结算读数，返回本次**新增**条目数（结算页「★ 图鉴 +N ★」用）。
 * ★ 只读 res，绝不改 res。
 * @param {object} res 结算读数
 * @param {string[]} bossOrder Boss 的出场顺序（BOSS_ORDER），用来把 bossSpawned 下标映射成 id
 */
export function mergeCodex(res, bossOrder = []) {
  const c = loadCodex();
  let fresh = 0;

  // 普通怪 / 其它出场类型
  const counts = (res && res.kindCounts) || {};
  for (const [k, n] of Object.entries(counts)) {
    const add = Math.max(0, Number(n) || 0);
    if (!add) continue;
    if (!c.kinds[k]) fresh += 1;
    c.kinds[k] = (Number(c.kinds[k]) || 0) + add;
  }

  // Boss：spawnBoss 不写 kindCounts，用 bossSpawned 补（下标 → id）
  const spawned = (res && res.bossSpawned) || [];
  for (let i = 0; i < spawned.length; i++) {
    const add = Math.max(0, Number(spawned[i]) || 0);
    const id = bossOrder[i];
    if (!id || !add) continue;
    if (!c.kinds[id]) fresh += 1;
    c.kinds[id] = (Number(c.kinds[id]) || 0) + add;
  }

  const addSet = (arr, list) => {
    for (const id of list) {
      if (!id || arr.includes(id)) continue;
      arr.push(id);
      fresh += 1;
    }
  };
  // 本局进化：evolutions 是 { 武器id: 阶数 }，阶数 >0 才算"见过"
  const evo = (res && res.evolutions) || {};
  addSet(c.evolutions, Object.keys(evo).filter((k) => Number(evo[k]) > 0));
  addSet(c.weapons, Array.isArray(res && res.weapons) ? res.weapons : []);
  addSet(c.skins, res && res.skin ? [res.skin] : []);

  saveCodex(c);
  return fresh;
}
