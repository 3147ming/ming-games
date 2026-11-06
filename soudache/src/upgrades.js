/**
 * 局外改装树（纯逻辑）
 *
 * 设计约束：
 *  1. 不 import three / 不碰 DOM / 不读 localStorage —— 这样既能被 Node 单测直接 import，
 *     也能在 UI、结算、战局创建等任意层复用，而不把浏览器依赖带进来。
 *  2. 所有「买不买得起 / 能不能点下一级」的判定都放在本文件。UI 只负责把 canBuy/checkBuy
 *     的结果画成按钮，绝不在 DOM 层另写一份价格与前置条件（两套真值一定会漂移）。
 *  3. applyMods 必须返回**新的**配置对象，原因见函数注释：config.js 的导出是全局单例，
 *     一旦原地改它，本次战斗的强化会泄漏到下一局、也会污染同进程的所有测试。
 */

/** 改装数据的结构版本。与存档顶层 version 分开，便于单独演进而不牵动老存档迁移。 */
export const UPGRADE_VERSION = 1;

/**
 * 三支改装树。
 *
 * 价格采用「每支 1→2→3 级递增」：首级是攒一两局就能摸到的甜点，
 * 末级需要持续撤离才能负担，保证长期目标感但不会在第一局就全解锁。
 * effect 使用乘区 / 加区两种形式，applyMods 按节点顺序累乘或累加。
 */
export const BRANCHES = [
  {
    id: 'firepower',
    name: '火力',
    short: 'FIREPOWER',
    color: '#ffb020',
    desc: '把每一发子弹变得更值钱：伤害、弹匣与换弹速度。',
    nodes: [
      {
        id: 'firepower_1',
        tier: 1,
        name: '强化装药',
        price: 2200,
        effectText: '武器伤害 +8%',
        effects: { damageMul: 0.08 },
      },
      {
        id: 'firepower_2',
        tier: 2,
        name: '扩容弹匣',
        price: 5200,
        effectText: '弹匣容量 +25%',
        effects: { magMul: 0.25 },
      },
      {
        id: 'firepower_3',
        tier: 3,
        name: '快速换弹',
        price: 11000,
        effectText: '换弹时间 -15%',
        effects: { reloadMul: 0.85 },
      },
    ],
  },
  {
    id: 'survival',
    name: '生存',
    short: 'SURVIVAL',
    color: '#5ddc7a',
    desc: '活下来才有下一局：生命、护甲耐久与医疗效率。',
    nodes: [
      {
        id: 'survival_1',
        tier: 1,
        name: '强健体魄',
        price: 1800,
        effectText: '最大生命 +15',
        effects: { maxHpAdd: 15 },
      },
      {
        id: 'survival_2',
        tier: 2,
        name: '插板加固',
        price: 4600,
        effectText: '护甲耐久 +25%',
        effects: { armorMul: 0.25 },
      },
      {
        id: 'survival_3',
        tier: 3,
        name: '战地急救',
        price: 9800,
        effectText: '医疗物资恢复量 +25%',
        effects: { healMul: 0.25 },
      },
    ],
  },
  {
    id: 'mobility',
    name: '机动',
    short: 'MOBILITY',
    color: '#35e0d0',
    desc: '跑得动、背得动、回得快：速度、体力恢复与负重上限。',
    nodes: [
      {
        id: 'mobility_1',
        tier: 1,
        name: '轻量跑鞋',
        price: 2000,
        effectText: '移动速度 +6%',
        effects: { speedMul: 0.06 },
      },
      {
        id: 'mobility_2',
        tier: 2,
        name: '耐力训练',
        price: 4800,
        effectText: '体力恢复 +20%',
        effects: { staminaRegenMul: 0.2 },
      },
      {
        id: 'mobility_3',
        tier: 3,
        name: '外骨骼背架',
        price: 10200,
        effectText: '负重上限 +5kg',
        effects: { weightAdd: 5 },
      },
    ],
  },
];

/** 分支 id 列表，供存档归一化与 UI 遍历使用。 */
export const BRANCH_IDS = BRANCHES.map((b) => b.id);

/** nodeId → 节点定义（含所属分支），避免每次购买都线性扫树。 */
const NODE_MAP = new Map();
for (const branch of BRANCHES) {
  for (const node of branch.nodes) {
    NODE_MAP.set(node.id, { ...node, branchId: branch.id, branchName: branch.name });
  }
}

/** 每支的等级上限（= 该支节点数）。 */
export const MAX_LEVEL = Math.max(...BRANCHES.map((b) => b.nodes.length));

/**
 * 全新存档的改装数据。
 * version 独立于存档顶层 version：顶层版本被既有测试锁在 1，改装结构另行演进时不必冒险迁移。
 * @returns {{version: number, firepower: number, survival: number, mobility: number}} 改装进度
 */
export function defaultUpgrades() {
  const out = { version: UPGRADE_VERSION };
  for (const id of BRANCH_IDS) out[id] = 0;
  return out;
}

/**
 * 把任意来源的 upgrades 字段归一化成合法进度（老档缺字段 / 手改坏值都不会让游戏崩）。
 *
 * 为什么必须在这里做而不是只靠 loadSave：buy() / applyMods() 也可能被控制台或测试直接调用，
 * 逻辑层的每个入口都应当能容忍「全未解锁」这一种合法状态。
 * @param {*} raw 原始 upgrades 字段
 * @returns {{version: number, firepower: number, survival: number, mobility: number}} 归一化进度
 */
export function normalizeUpgrades(raw) {
  const out = defaultUpgrades();
  if (!raw || typeof raw !== 'object') return out;
  for (const id of BRANCH_IDS) {
    const value = Number(raw[id]);
    if (!Number.isFinite(value)) continue;
    out[id] = Math.max(0, Math.min(MAX_LEVEL, Math.floor(value)));
  }
  // 兼容未来可能升级的结构版本：当前只有 v1，未知版本按 v1 处理而不是丢弃进度
  out.version = UPGRADE_VERSION;
  return out;
}

/**
 * 按 id 取节点（含 branchId / branchName）。
 * @param {string} nodeId 节点 id
 * @returns {object|null} 节点定义
 */
export function getNode(nodeId) {
  return NODE_MAP.get(nodeId) || null;
}

/**
 * 某支当前等级（0 = 一级都没点）。
 * @param {object} state 存档对象
 * @param {string} branchId 分支 id
 * @returns {number} 等级
 */
export function getBranchLevel(state, branchId) {
  const upgrades = state && state.upgrades;
  if (!upgrades || typeof upgrades !== 'object') return 0;
  const value = Number(upgrades[branchId]);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_LEVEL, Math.floor(value)));
}

/**
 * 已解锁节点总数（用于菜单 / 面板显示进度）。
 * @param {object} state 存档对象
 * @returns {number} 已解锁数量
 */
export function unlockedCount(state) {
  return BRANCH_IDS.reduce((sum, id) => sum + getBranchLevel(state, id), 0);
}

/**
 * 检查某个节点当前能否购买，并给出**可直接展示给玩家**的原因。
 *
 * 判定顺序就是玩家的思考顺序：先看有没有这个节点 → 是不是已经买过 → 上一级点了吗 → 钱够吗。
 * @param {object} state 存档对象（至少含 currency 与 upgrades）
 * @param {string} nodeId 节点 id
 * @returns {{ok: boolean, reason: string}} 检查结果
 */
export function checkBuy(state, nodeId) {
  const node = getNode(nodeId);
  if (!node) return { ok: false, reason: '未知改装节点' };
  const level = getBranchLevel(state, node.branchId);
  if (level >= node.tier) return { ok: false, reason: '已解锁' };
  if (level !== node.tier - 1) {
    const prev = BRANCHES.find((b) => b.id === node.branchId).nodes[node.tier - 2];
    return { ok: false, reason: `需先解锁「${prev ? prev.name : `第 ${node.tier - 1} 级`}」` };
  }
  if (!(Number(state && state.currency) >= node.price)) {
    return { ok: false, reason: '资金不足' };
  }
  return { ok: true, reason: '' };
}

/**
 * 能否购买（布尔快捷方式，UI 按钮 disabled 状态直接用它）。
 * @param {object} state 存档对象
 * @param {string} nodeId 节点 id
 * @returns {boolean} 是否可购买
 */
export function canBuy(state, nodeId) {
  return checkBuy(state, nodeId).ok;
}

/**
 * 购买一个改装节点：成功时扣钱并提升分支等级。
 *
 * 只允许在 checkBuy 通过后落地，任何失败路径都**不产生副作用**（不扣钱、不 upgrade），
 * 这样 UI 即使因为竞态重复触发也不会出现「钱扣了但节点没亮」。
 * @param {object} state 存档对象
 * @param {string} nodeId 节点 id
 * @returns {boolean} 是否购买成功
 */
export function buy(state, nodeId) {
  const check = checkBuy(state, nodeId);
  if (!check.ok) return false;
  const node = getNode(nodeId);
  const upgrades = normalizeUpgrades(state.upgrades);
  upgrades[node.branchId] = Math.min(MAX_LEVEL, upgrades[node.branchId] + 1);
  state.upgrades = upgrades;
  state.currency = Number(state.currency) - node.price;
  return true;
}

/**
 * 当前改装提供的负重上限加成（kg）。
 * UI 的负重估算读这一条；applyMods 用同一组 weightAdd 写进 PLAYER.weightBaseLimit，
 * 两处不会对「+5kg」各写一个数字。
 * @param {object} state 存档对象
 * @returns {number} 加成 kg
 */
export function weightLimitBonus(state) {
  const branch = BRANCHES.find((b) => b.id === 'mobility');
  if (!branch) return 0;
  const level = getBranchLevel(state, branch.id);
  let bonus = 0;
  for (const node of branch.nodes) {
    if (level < node.tier) continue;
    bonus += (node.effects && node.effects.weightAdd) || 0;
  }
  return bonus;
}

/* ============================== 配置应用 ============================== */

/** 深拷贝普通数据对象。配置里只有数据（无函数 / DOM），这样最直接也最安全。 */
function cloneDeep(value) {
  if (Array.isArray(value)) return value.map(cloneDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = cloneDeep(value[key]);
    return out;
  }
  return value;
}

/** 保留两位小数，避免浮点尾数进入配置（例如 27 * 1.08 = 29.160000000000004）。 */
function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * 把当前改装进度应用到一份配置上，返回**全新**配置对象。
 *
 * 为什么必须返回新对象、绝不能直接改 config.js 导出的常量：
 *  - 那些常量是全局单例。原地加伤害会永久改变所有后续战局，甚至影响同一进程里的测试；
 *  - 玩家卖号 / 清档 / 回退节点时无法撤销，因为原值已经被覆盖；
 *  - 返回新对象让「基础配置」与「本次战局配置」边界清晰：改坏了，下一局重新算即可。
 *
 * 入参 baseCfg 约定为 `{ PLAYER, WEAPONS, ARMORS, ITEMS }`（可只传关心的部分），
 * 这样纯逻辑层不必反过来 import config.js，测试也能用最小配置验证。
 *
 * @param {{PLAYER?: object, WEAPONS?: object, ARMORS?: object, ITEMS?: object}} baseCfg 基础配置
 * @param {object} state 存档对象
 * @returns {{PLAYER: object, WEAPONS: object, ARMORS: object, ITEMS: object}} 应用改装后的新配置
 */
export function applyMods(baseCfg, state) {
  const src = baseCfg || {};
  const cfg = cloneDeep({
    PLAYER: src.PLAYER || {},
    WEAPONS: src.WEAPONS || {},
    ARMORS: src.ARMORS || {},
    ITEMS: src.ITEMS || {},
  });

  // 汇总三支的乘区 / 加区。逐支按等级取节点，只累计真正解锁过的节点。
  const effects = {
    damageMul: 1,
    magMul: 1,
    reloadMul: 1,
    maxHpAdd: 0,
    armorMul: 1,
    healMul: 1,
    speedMul: 1,
    staminaRegenMul: 1,
    weightAdd: 0,
  };
  for (const branch of BRANCHES) {
    const level = getBranchLevel(state, branch.id);
    for (const node of branch.nodes) {
      if (level < node.tier) continue;
      const e = node.effects || {};
      effects.damageMul *= 1 + (e.damageMul || 0);
      effects.magMul *= 1 + (e.magMul || 0);
      // 换弹节点直接给时间乘数（0.85 = 快 15%），未配置的节点乘 1 不产生副作用
      effects.reloadMul *= (e.reloadMul || 1);
      effects.maxHpAdd += e.maxHpAdd || 0;
      effects.armorMul *= 1 + (e.armorMul || 0);
      effects.healMul *= 1 + (e.healMul || 0);
      effects.speedMul *= 1 + (e.speedMul || 0);
      effects.staminaRegenMul *= 1 + (e.staminaRegenMul || 0);
      effects.weightAdd += e.weightAdd || 0;
    }
  }

  // 玩家：生命 / 移速 / 体力恢复 / 负重上限
  const p = cfg.PLAYER;
  if (typeof p.maxHp === 'number') p.maxHp = Math.round(p.maxHp + effects.maxHpAdd);
  if (typeof p.speed === 'number') p.speed = round2(p.speed * effects.speedMul);
  if (typeof p.staminaRegen === 'number') p.staminaRegen = round2(p.staminaRegen * effects.staminaRegenMul);
  if (typeof p.weightBaseLimit === 'number') p.weightBaseLimit += effects.weightAdd;
  if (typeof p.weightLimit === 'number') p.weightLimit += effects.weightAdd;

  // 武器：伤害 / 弹匣 / 换弹时间。换弹时间减少 = 时间乘数 < 1。
  for (const def of Object.values(cfg.WEAPONS)) {
    if (!def || typeof def !== 'object') continue;
    if (typeof def.damage === 'number') def.damage = round2(def.damage * effects.damageMul);
    if (typeof def.magSize === 'number') def.magSize = Math.round(def.magSize * effects.magMul);
    if (typeof def.reloadTime === 'number') def.reloadTime = round2(def.reloadTime * effects.reloadMul);
  }

  // 护甲：耐久（armor 字段就是可吸收的护甲值）
  for (const def of Object.values(cfg.ARMORS)) {
    if (!def || typeof def !== 'object') continue;
    if (typeof def.armor === 'number') def.armor = Math.round(def.armor * effects.armorMul);
  }

  // 医疗物资：恢复量。只改有 heal 的条目，材料和弹药不受影响。
  for (const def of Object.values(cfg.ITEMS)) {
    if (!def || typeof def !== 'object') continue;
    if (typeof def.heal === 'number' && def.heal > 0) {
      def.heal = Math.round(def.heal * effects.healMul);
    }
  }

  return cfg;
}
