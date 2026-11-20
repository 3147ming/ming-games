/**
 * E-05 / E-15 安全箱兜底与损失预览（蓝图阶段 0 · A2）。
 *
 * 纯逻辑模块：零 DOM、零 three、零随机。规则在这里定义一次，结算（main.js endRaid）
 * 与战前预览（HUD）共用同一函数，杜绝"预览说保、结算没保"的假账。
 *
 * 核心语序（蓝图 E-15）：安全箱 → 保险 → 装备耐久 → 普通掉落。
 * - 阵亡：安全箱内物品 100% 回仓；普通容器与装备丢失（装备若投保则走保险理赔）。
 * - 撤离成功：全部带出，安全箱不重复结算。
 * - 禁放：标了 secureBlocked 的高价值/任务物不能进安全箱，保留豪赌张力。
 */
import { ITEMS } from './config.js';

/**
 * 安全箱尺寸分档。s1 = 现状 2×2（旧档默认），s2/s3 供后续成长系统解锁。
 * 局内创建安全容器时按 save.secureTier 取尺寸；缺省回落 s1 保证旧档逐位不变。
 */
export const SECURE_TIERS = {
  s1: { cols: 2, rows: 2 },
  s2: { cols: 2, rows: 3 },
  s3: { cols: 3, rows: 3 },
};

/** 存档里记录的安全箱档位字段名（storage 迁移用） */
export const SECURE_TIER_FIELD = 'secureTier';

/** 旧档没有 secureTier 时的默认档（= 现状 PLAYER.secure 2×2） */
export const DEFAULT_SECURE_TIER = 's1';

/**
 * 该容器是不是安全箱。用 kind 判定而不是数组下标 —— 容器顺序会随功能调整，
 * 下标判断会在加一个容器后静默保错东西。
 * @param {object} inv createInventory 产物
 */
export function isSecureContainer(inv) {
  return !!inv && inv.kind === 'secure';
}

/**
 * 物品能不能放进安全箱。禁放标记优先读物品实例，再回落物品定义
 * （局内 createItem 出来的实例不一定带上定义的全部字段）。
 * @param {object} item 物品实例（含 id）
 * @returns {boolean} true 表示可放
 */
export function canSecureItem(item) {
  if (!item) return false;
  if (item.secureBlocked === true) return false;
  const def = ITEMS[item.id] || ITEMS[item.def && item.def.id];
  return !(def && def.secureBlocked === true);
}

/**
 * 拆分随身物品为「安全箱」与「普通」两组。结算与预览共用。
 * @param {Array<object>} containers player.containers（背包 + 胸挂 + 口袋 + 安全箱）
 * @returns {{secure: object[], loose: object[]}}
 */
export function splitCarried(containers) {
  const secure = [];
  const loose = [];
  for (const c of containers || []) {
    for (const it of (c && c.items) || []) {
      (isSecureContainer(c) ? secure : loose).push(it);
    }
  }
  return { secure, loose };
}

/** 一组物品的估值（复用 Loot.valueOf 的口径：数量 × 单价，避免两套算法） */
function valueOf(items, valueFn) {
  return items.reduce((sum, it) => sum + (valueFn ? valueFn(it) : (Number(it.value) || 0) * (it.qty || 1)), 0);
}

/**
 * 战前/结算共用的损失预览。返回四层清单与估值。
 *
 * @param {object} args
 * @param {Array<object>} args.containers 随身容器组
 * @param {object[]} [args.gear] 身上装备（护甲 + 武器）对应的物品实例
 * @param {boolean} [args.insured] 是否投保
 * @param {function} [args.valueFn] 估值函数（默认读 item.value × qty）
 * @returns {{kept: object[], lost: object[], claim: object[], secure: object[], loose: object[],
 *            keptValue: number, lostValue: number, claimValue: number, layers: object}}
 */
export function lossPreview({ containers, gear = [], insured = false, valueFn } = {}) {
  const { secure, loose } = splitCarried(containers);
  // 语序：安全箱必留 → 装备投保则进理赔（不直接回仓）→ 其余全丢。
  // "装备耐久"层（Q-08）第一阶段不启用，见 layers.worn 的注释。
  const claim = insured ? gear.slice() : [];
  const worn = insured ? [] : gear.slice();
  const lost = loose.concat(worn);
  const kept = secure.slice();
  return {
    kept, lost, claim, secure, loose,
    keptValue: valueOf(kept, valueFn),
    lostValue: valueOf(lost, valueFn),
    claimValue: valueOf(claim, valueFn),
    layers: {
      secure: { items: secure, kept: true },
      insurance: { items: claim, kept: false, pendingClaim: true },
      // TODO(Q-08)：装备耐久折损（阵亡后 durability 归零/折损 + 修复消耗材料）阶段 0 不启用，
      // 保留空层让 UI 的四行结构稳定，后续按 Q-08 拍板结果填。
      worn: { items: worn, kept: false, enabled: false },
      dropped: { items: loose, kept: false },
    },
  };
}
