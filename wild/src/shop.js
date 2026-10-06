// 阶段 6-4：局内商店「魂火商栈」。
//
// ★ 纯逻辑模块：顶层不碰 DOM、不碰 localStorage（无任何副作用）⟹ Node 测试里无头可验，
//   与 skins.js / loadout.js 同一套纪律。
//
// 货币：魂火（soulfire）—— 与 gems=xperience 完全独立（击杀掉落，不是升级经验）。
// 出现：第 2 / 5 / 8 分钟各一次（SHOP_TIMES）。
// 货物：每次 3 件随机（用 ArenaCore 的**独立**随机源抽取，不污染主玩法 rng 流）。
// 加成：每件都是**纯数值**，且走与成长 / 配装同一套初始字段（dmgBase / maxHp / moveBase /
//       magnet / xpMul / cdMul），多重来源互不擦除。
//
// 设计要点：
//   · 不新增任何伤害来源 ⟹ 击杀归因（killSrc）口径不变（'other' 恒为 0）。
//   · 全部确定性（rollShop 用外部传入的 rng）⟹ 同种子同结果。
//   · 加成幅度刻意温和 ⟹ 人力购买也只是「锦上添花」，不会把难度直接削穿。

/** 商店出现的三个时间点（秒）：第 2 / 5 / 8 分钟。 */
export const SHOP_TIMES = [120, 300, 480];

/**
 * 货物目录（每件固定字段）：
 *   id    唯一 id（购买/核对用）
 *   name  展示名
 *   desc  一句话描述
 *   stat  作用字段（必须是 applyShopGood 认得的 6 个之一）
 *   amt   数值（有限正数；xpMul/cdMul 是比例，其余是加算）
 *   cost  价格（魂火；有限正数）
 * ★ stat 与 amt 的语义由 applyShopGood 统一解释，目录里只放数据。
 */
export const SHOP_ITEMS = [
  { id: 's_dmg',  name: '焰心', desc: '全武器伤害 +2%', stat: 'dmgBase',  amt: 0.02, cost: 30 },
  { id: 's_hp',   name: '坚壁', desc: '生命上限 +10',   stat: 'maxHp',    amt: 10,   cost: 30 },
  { id: 's_move', name: '疾风', desc: '移动速度 +4',    stat: 'moveBase', amt: 4,    cost: 30 },
  { id: 's_mag',  name: '磁引', desc: '拾取范围 +20',   stat: 'magnet',   amt: 20,   cost: 25 },
  { id: 's_xp',   name: '灵慧', desc: '经验获取 +4%',   stat: 'xpMul',    amt: 0.04, cost: 30 },
  { id: 's_cd',   name: '迅律', desc: '技能冷却 -3%',   stat: 'cdMul',    amt: 0.03, cost: 30 },
];

const SHOP_BY_ID = Object.fromEntries(SHOP_ITEMS.map((g) => [g.id, g]));

/** 按 id 取货物目录项；未知 id 返回 null（不开局崩）。 */
export function shopItemById(id) {
  return SHOP_BY_ID[id] || null;
}

/**
 * 确定性地抽取 n 件互不相同的货物。
 * ★ 用 Fisher–Yates 在**副本**上洗牌，不改原目录；n 超过目录长度则取全部。
 *   rng 必须有 .next()（Rng 或兼容），且调用时机固定（每次开商店各抽一次）⟹ 同种子同结果。
 */
export function rollShop(rng, n = 3) {
  const pool = SHOP_ITEMS.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
  }
  return pool.slice(0, Math.min(n, pool.length)).map((g) => ({ ...g }));
}

/**
 * 把一件货物作用到 core 的初始字段上（与 applyGrowth / applyLoadout 同一套口子）。
 * ★ 改完 dmgBase / moveBase 必须再 _refreshClassBuffs() 折出 gDmgMul / moveSpeed。
 * ★ 不碰主 rng、不新增伤害来源。id 非法则返回 false（no-op）。
 * @param {object} core  ArenaCore 实例
 * @param {{id?:string,amt?:number}} good  货物（带 id；amt 缺省回退到目录值）
 */
export function applyShopGood(core, good) {
  if (!good) return false;
  const it = shopItemById(good.id);
  if (!it) return false;
  const amt = good.amt != null ? good.amt : it.amt;
  switch (it.stat) {
    case 'dmgBase':  core.dmgBase += amt; break;
    case 'maxHp':    core.maxHp += amt; core.hp += amt; break;
    case 'moveBase': core.moveBase += amt; break;
    case 'magnet':   core.magnet += amt; break;
    case 'xpMul':    core.xpMul *= (1 + amt); break;
    case 'cdMul':    core.cdMul *= (1 - amt); break;
    default: return false;
  }
  core._refreshClassBuffs();
  return true;
}

/**
 * 自动购买方案（无头模拟 / 驾驶员用）。
 * ★ 阶段 6-4 的回归口径：**模拟器不购买**（返回空数组）——
 *   这样商店只是「出现 + 暂停 + 跳过」，对整局数值零影响，16 局回归=基线、门禁不破；
 *   真实购买路径由 tests/shop.test.mjs 的 applyShopGood 单测覆盖。
 *   人力游戏里玩家手动点击购买，走的是同一条 resolveShop → applyShopGood。
 * @param {object} core  ArenaCore 实例（读 core.shopGoods / core.soulfire）
 * @returns {string[]} 要购买的货物 id 列表（这里恒为空）
 */
export function autoShopBuy(core) {
  return [];
}
