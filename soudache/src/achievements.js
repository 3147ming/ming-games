/**
 * 成就定义与判定（纯数据模块，可在 Node 下直接 import 测试）。
 *
 * check 接收存档对象，返回是否达标；currency 为解锁时一次性发放的货币，
 * title 为稀有成就额外解锁的结算页称号（展示在结算头部）。
 */

export const ACHIEVEMENTS = [
  { id: 'first_raid', name: '首次突袭', desc: '完成第一次突袭', check: (s) => s.stats.raids >= 1, currency: 500 },
  { id: 'first_kill', name: '首杀', desc: '击杀第一名敌人', check: (s) => s.stats.kills >= 1, currency: 500 },
  { id: 'first_extract', name: '活着撤离', desc: '首次成功撤离', check: (s) => s.stats.extracts >= 1, currency: 800 },
  { id: 'kill_10', name: '歼灭者', desc: '累计击杀 10 名敌人', check: (s) => s.stats.kills >= 10, currency: 800 },
  { id: 'kill_50', name: '收割机', desc: '累计击杀 50 名敌人', check: (s) => s.stats.kills >= 50, currency: 1500, title: '收割机' },
  { id: 'extract_5', name: '撤离老手', desc: '累计成功撤离 5 次', check: (s) => s.stats.extracts >= 5, currency: 1200 },
  { id: 'extract_10', name: '撤离大师', desc: '累计成功撤离 10 次', check: (s) => s.stats.extracts >= 10, currency: 2000, title: '撤离大师' },
  { id: 'raider_10', name: '常客', desc: '累计突袭 10 次', check: (s) => s.stats.raids >= 10, currency: 1000 },
  { id: 'raider_25', name: '战区老兵', desc: '累计突袭 25 次', check: (s) => s.stats.raids >= 25, currency: 2000, title: '战区老兵' },
  { id: 'grade_s', name: 'S级行动', desc: '拿到一次 S 级评分（1600+）', check: (s) => s.stats.bestScore >= 1600, currency: 2000, title: 'S级常客' },
  { id: 'rich', name: '淘金者', desc: '单局带出估值 ¥20,000 以上', check: (s) => s.stats.bestValue >= 20000, currency: 1500, title: '淘金者' },
  { id: 'collector', name: '收藏家', desc: '图鉴解锁 15 种以上物品', check: (s) => (s.codex && s.codex.items.length) >= 15, currency: 1500 },
  { id: 'boss_hunter', name: '猎杀者', desc: '击杀 1 名 Boss 级目标', check: (s) => (s.stats.bossKills || 0) >= 1, currency: 2000, title: '猎杀者' },
];

/** 已解锁称号的最新一个（结算页展示） */
export function latestTitle(save) {
  const ach = save.ach || { ids: [] };
  for (let i = ACHIEVEMENTS.length - 1; i >= 0; i -= 1) {
    if (ACHIEVEMENTS[i].title && ach.ids.includes(ACHIEVEMENTS[i].id)) {
      return ACHIEVEMENTS[i].title;
    }
  }
  return null;
}

/**
 * 扫描全部成就：达标即解锁，并对未发放过的补发一次性货币。
 * 幂等 —— paid 记录保证同一成就的货币只发一次（重开旧存档也不会刷钱）。
 * @param {object} save 存档对象（原地修改）
 * @returns {{unlocked: object[], rewards: number}} 本次新解锁的成就与发放总额
 */
export function syncAchievements(save) {
  if (!save.ach || !Array.isArray(save.ach.ids)) save.ach = { ids: [], paid: [] };
  if (!Array.isArray(save.ach.paid)) save.ach.paid = [];
  const unlocked = [];
  let rewards = 0;
  for (const a of ACHIEVEMENTS) {
    let ok = false;
    try { ok = Boolean(a.check(save)); } catch { ok = false; } // 存档缺字段时不让判定炸掉整局结算
    if (!ok || save.ach.ids.includes(a.id)) continue;
    save.ach.ids.push(a.id);
    unlocked.push(a);
  }
  for (const a of save.ach.ids) {
    if (save.ach.paid.includes(a)) continue;
    const def = ACHIEVEMENTS.find((x) => x.id === a);
    if (!def) continue;
    save.ach.paid.push(a);
    save.currency += def.currency;
    rewards += def.currency;
  }
  return { unlocked, rewards };
}
