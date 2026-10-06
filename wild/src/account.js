// 阶段 4-5：本地账号系统 —— 玩家名 + 累计档案 + 称号。
//
// 与 meta.js 同一套纪律：只管存读，不碰 ArenaCore、不碰 DOM。所有副作用都在函数里，
// 顶层不访问 localStorage —— 所以在 Node 测试里只要给 globalThis.localStorage 一个
// 最小 shim，就能无头验证整套累计 / 称号逻辑（见 tests/account.test.mjs）。
//
// 状态形状：
//   { name: string, runs: number, kills: number, survival: number, best: { [heroId]: number } }
//   · name      玩家名（标题页左上角，首次起名、可改）
//   · runs      总局数
//   · kills     历史总击杀
//   · survival  历史总存活秒
//   · best      各角色的最高纪录（按英雄 id 存，目前记"最高击杀"）
//
// ⚠ 这是**本地存档**：没有云端同步（spec 明示"本轮不做真云同步"）。任何读取异常都
//   回退到空档案，绝不抛 —— 存档坏了最多从头累计，不能让游戏起不来。

import { HEROES, heroById, DEFAULT_HERO } from './content.js';

const KEY = 'wild.account.v1';

// 称号阶梯（按累计总击杀数解锁）。数组按 kills 升序，便于 `titleOf` 从后往前取。
// ★ 为什么这些数字：500/2000/5000/10000 是"百人斩/千人斩/荒野猎手/荒野之狼"的量级，
//   既不会在前两局轻易解锁（失去目标感），也不是遥不可及（百人斩一局就能摸到）。
export const TITLES = [
  { kills: 0, name: '初入荒野' },
  { kills: 500, name: '百人斩' },
  { kills: 2000, name: '千人斩' },
  { kills: 5000, name: '荒野猎手' },
  { kills: 10000, name: '荒野之狼' },
];

const EMPTY = {
  name: '', runs: 0, kills: 0, survival: 0, best: {},
  // ── 阶段 7：成就「四相俱显 / 三途行者」需要"用过哪些皮肤 / 角色" ──
  // ★ 为什么存在 account 而不是 best：best记的是"最高纪录"（可被后来者覆盖），
  //   而这两个字段是**集合**（只增不减），语义不同。混在一张表里会出现
  //   "重新打一局就把皮肤记录清掉"这种丢数据的写法。
  skinsUsed: [], heroesUsed: [],
};

/** 读档案；任何异常（隐私模式 / 损坏 JSON）都回退到空档案，绝不抛。 */
export function loadAccount() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const o = JSON.parse(raw);
      return {
        name: typeof o.name === 'string' ? o.name : '',
        runs: Number(o.runs) || 0,
        kills: Number(o.kills) || 0,
        survival: Number(o.survival) || 0,
        best: o.best && typeof o.best === 'object' ? o.best : {},
        // ★ 旧存档（阶段 4-5 写的）没有这两个键 ⟹ 必须兜成 []，否则 submitRun 里
        //   `.includes` 直接抛，"打完一局进不去标题页"。
        skinsUsed: Array.isArray(o.skinsUsed) ? o.skinsUsed.filter((s) => typeof s === 'string') : [],
        heroesUsed: Array.isArray(o.heroesUsed) ? o.heroesUsed.filter((s) => typeof s === 'string') : [],
      };
    }
  } catch { /* 忽略，走默认 */ }
  return { ...EMPTY, best: {}, skinsUsed: [], heroesUsed: [] };
}

export function saveAccount(a) {
  try { localStorage.setItem(KEY, JSON.stringify(a)); } catch { /* 忽略 */ }
  return a;
}

/** 起名 / 改名（截断到 16 字、去首尾空白）。返回更新后的档案。 */
export function setName(name) {
  const a = loadAccount();
  a.name = (name || '').toString().trim().slice(0, 16);
  return saveAccount(a);
}

/** 当前累计击杀对应的称号名。 */
export function titleOf(totalKills) {
  let t = TITLES[0];
  for (const x of TITLES) if (totalKills >= x.kills) t = x;
  return t.name;
}

/** 距下一个称号还差多少杀；已满级（荒野之狼）返回 null。 */
export function nextTitle(totalKills) {
  for (const x of TITLES) {
    if (totalKills < x.kills) return { name: x.name, need: x.kills, gap: x.kills - totalKills };
  }
  return null;
}

/** 本局结算时累计。res 至少含 { kills, survivalSec, hero }。
 *  返回 { account, title, next, record }：更新后的档案、当前称号、下个称号进度、本局是否破该角色纪录。
 *  ★ record（破角色纪录）用"写入前旧值"比较，持平不算破（与 best.js 同一口径）。 */
export function submitRun(res) {
  const a = loadAccount();
  const hero = heroById(res.hero || DEFAULT_HERO).id;
  const before = a.best[hero] || 0;
  const now = res.kills || 0;
  const record = now > before;
  a.runs += 1;
  a.kills += now;
  a.survival += res.survivalSec || 0;
  if (record) a.best[hero] = now;
  // ── 阶段 7：记录本局用过的皮肤 / 角色（成就「四相俱显」「三途行者」的判据来源）──
  // ★ 只增不减：用 Set 去重后写回，重复用同一件不会重复计数。
  if (typeof res.skin === 'string' && !a.skinsUsed.includes(res.skin)) a.skinsUsed.push(res.skin);
  if (!a.heroesUsed.includes(hero)) a.heroesUsed.push(hero);
  saveAccount(a);
  return { account: a, title: titleOf(a.kills), next: nextTitle(a.kills), record, hero };
}

/** 调试/标题页用：把角色表与"已解锁"信息读出来（cost 走 meta.js 的 souls 账本，这里不重复）。 */
export const heroCatalog = () => HEROES.slice();
