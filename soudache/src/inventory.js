/**
 * 背包格子与负重系统（纯逻辑模块）
 *
 * 采用"俄罗斯方块"式格位背包：每个物品占据 w×h 个格子，可堆叠物品优先合并。
 * 不依赖 DOM / Canvas / localStorage。
 */

import { PLAYER } from './config.js';

let uidCounter = 0;

/**
 * 生成一个进程内唯一的物品 uid。
 * @returns {string} uid
 */
export function nextUid() {
  uidCounter += 1;
  return `it_${uidCounter.toString(36)}_${(uidCounter * 2654435761) % 100000}`;
}

/**
 * 由物品定义创建一个物品实例（快照式，定义变更后实例不受影响）。
 * @param {object} def ITEMS 中的定义
 * @param {number} qty 数量（可堆叠物品可 >1）
 * @returns {object} 物品实例
 */
export function createItem(def, qty = 1) {
  const stackMax = def.stack || 1;
  return {
    uid: nextUid(),
    id: def.id,
    name: def.name,
    category: def.category || 'material',
    rarity: def.rarity || 'common',
    icon: def.icon || 'bolt',
    desc: def.desc || '',
    value: def.value || 0,
    weight: def.weight || 0,
    w: Math.max(1, def.size ? def.size.w : 1),
    h: Math.max(1, def.size ? def.size.h : 1),
    stack: stackMax,
    qty: Math.max(1, Math.min(stackMax, Math.floor(qty))),
    heal: def.heal || 0,
    useTime: def.useTime || 0,
    stamina: def.stamina || 0,
    armor: def.armor || 0,
    ammoQty: def.ammoQty || 0,
    col: -1,
    row: -1,
  };
}

/**
 * 创建一个空的格位容器。
 * @param {number} cols 列数
 * @param {number} rows 行数
 * @param {object} opts 可选参数 { items: 预置物品数组 }
 * @returns {object} 容器对象
 */
export function createInventory(cols = 5, rows = 6, opts = {}) {
  return {
    cols,
    rows,
    items: Array.isArray(opts.items) ? opts.items.slice() : [],
  };
}

/**
 * 判断物品能否放在 (col,row)（左上角格）。
 * @param {object} inv 容器
 * @param {object} item 物品
 * @param {number} col 列
 * @param {number} row 行
 * @param {string|null} ignoreUid 忽略的 uid（用于移动自身）
 * @returns {boolean} 是否可放置
 */
export function canPlace(inv, item, col, row, ignoreUid = null) {
  if (!inv || !item) return false;
  if (col < 0 || row < 0 || col + item.w > inv.cols || row + item.h > inv.rows) return false;
  for (const other of inv.items) {
    if (other.uid === item.uid || (ignoreUid && other.uid === ignoreUid)) continue;
    const ox = other.col;
    const oy = other.row;
    if (ox < 0 || oy < 0) continue;
    const overlap = col < ox + other.w && col + item.w > ox && row < oy + other.h && row + item.h > oy;
    if (overlap) return false;
  }
  return true;
}

/**
 * 把物品放到指定格位。
 * @param {object} inv 容器
 * @param {object} item 物品
 * @param {number} col 列
 * @param {number} row 行
 * @returns {boolean} 是否成功
 */
export function placeItemAt(inv, item, col, row) {
  if (!canPlace(inv, item, col, row)) return false;
  item.col = col;
  item.row = row;
  if (!inv.items.includes(item)) inv.items.push(item);
  return true;
}

/**
 * 取走某一格上的物品。
 * @param {object} inv 容器
 * @param {number} col 列
 * @param {number} row 行
 * @returns {object|null} 被取出的物品
 */
export function removeItemAt(inv, col, row) {
  const idx = inv.items.findIndex(
    (it) => col >= it.col && col < it.col + it.w && row >= it.row && row < it.row + it.h,
  );
  if (idx < 0) return null;
  const [item] = inv.items.splice(idx, 1);
  item.col = -1;
  item.row = -1;
  return item;
}

/**
 * 按 uid 移除物品。
 * @param {object} inv 容器
 * @param {string} uid 物品 uid
 * @returns {object|null} 被移除的物品
 */
export function removeItemByUid(inv, uid) {
  const idx = inv.items.findIndex((it) => it.uid === uid);
  if (idx < 0) return null;
  const [item] = inv.items.splice(idx, 1);
  item.col = -1;
  item.row = -1;
  return item;
}

/**
 * 尝试把物品合并进已有的同类堆叠，返回未能合并的剩余数量。
 * @param {object} inv 容器
 * @param {object} item 物品（stack > 1）
 * @returns {number} 剩余数量
 */
export function tryStack(inv, item) {
  if (!item || item.stack <= 1) return item ? item.qty : 0;
  let remain = item.qty;
  for (const other of inv.items) {
    if (remain <= 0) break;
    if (other.id !== item.id || other.uid === item.uid) continue;
    if (other.stack <= 1) continue;
    if (other.col < 0) continue;
    const space = other.stack - other.qty;
    if (space <= 0) continue;
    const move = Math.min(space, remain);
    other.qty += move;
    remain -= move;
  }
  item.qty = remain;
  return remain;
}

/**
 * 自动寻找位置放置物品（优先堆叠，其次空格）。
 * @param {object} inv 容器
 * @param {object} item 物品
 * @returns {object|null} 成功返回该物品（已写入 col/row），失败返回 null
 */
export function autoPlace(inv, item) {
  if (!inv || !item) return null;
  const orig = item.qty;
  const remain = tryStack(inv, item);
  if (remain <= 0) {
    // 全部堆叠进已有格子，物品本体不入列
    return item;
  }
  for (let row = 0; row <= inv.rows - item.h; row += 1) {
    for (let col = 0; col <= inv.cols - item.w; col += 1) {
      if (canPlace(inv, item, col, row)) {
        item.col = col;
        item.row = row;
        if (!inv.items.includes(item)) inv.items.push(item);
        return item;
      }
    }
  }
  // 放不下：回滚堆叠的增量（保持容器状态一致）
  if (remain < orig) {
    let toUndo = orig - remain;
    for (const other of inv.items) {
      if (toUndo <= 0) break;
      if (other.id !== item.id || other.uid === item.uid) continue;
      const gave = Math.min(other.qty - 0, toUndo);
      if (gave <= 0) continue;
      other.qty -= gave;
      toUndo -= gave;
    }
    item.qty = orig;
  }
  return null;
}

/** 容器是否有空间放下该物品 */
export function hasSpace(inv, item) {
  if (!inv || !item) return false;
  if (item.stack > 1) {
    for (const other of inv.items) {
      if (other.id === item.id && other.stack > 1 && other.qty < other.stack) return true;
    }
  }
  for (let row = 0; row <= inv.rows - item.h; row += 1) {
    for (let col = 0; col <= inv.cols - item.w; col += 1) {
      if (canPlace(inv, item, col, row)) return true;
    }
  }
  return false;
}

/**
 * 容器总重量（kg）。
 * @param {object} inv 容器
 * @returns {number} 重量
 */
export function totalWeight(inv) {
  if (!inv) return 0;
  let sum = 0;
  for (const it of inv.items) sum += (it.weight || 0) * Math.max(1, it.qty || 1);
  return Math.round(sum * 10) / 10;
}

/**
 * 容器总价值。
 * @param {object} inv 容器
 * @returns {number} 价值
 */
export function totalValue(inv) {
  if (!inv) return 0;
  let sum = 0;
  for (const it of inv.items) sum += (it.value || 0) * Math.max(1, it.qty || 1);
  return Math.round(sum);
}

/** 容器内的物品件数（按格位计，堆叠算 1 件） */
export function itemCount(inv) {
  return inv ? inv.items.length : 0;
}

/** 已占用格数 */
export function usedCells(inv) {
  if (!inv) return 0;
  let n = 0;
  for (const it of inv.items) n += it.w * it.h;
  return n;
}

/** 查找符合条件的物品 */
export function findItems(inv, predicate) {
  if (!inv) return [];
  return inv.items.filter((it) => predicate(it));
}

/**
 * 按 id 查找第一个物品。
 * @param {object} inv 容器
 * @param {string} id 物品定义 id
 * @returns {object|null} 物品
 */
export function findItemById(inv, id) {
  const list = findItems(inv, (it) => it.id === id);
  return list.length ? list[0] : null;
}

/** 统计某 id 的总数量 */
export function countById(inv, id) {
  return findItems(inv, (it) => it.id === id).reduce((s, it) => s + Math.max(1, it.qty || 1), 0);
}

/**
 * 从一个容器取出若干数量（用于换弹、消耗）。
 * @param {object} inv 容器
 * @param {string} id 物品 id
 * @param {number} amount 需要数量
 * @returns {number} 实际取到的数量
 */
export function consumeById(inv, id, amount) {
  let need = amount;
  const stacks = findItems(inv, (it) => it.id === id && it.qty > 0)
    .sort((a, b) => a.qty - b.qty);
  for (const stack of stacks) {
    if (need <= 0) break;
    const take = Math.min(stack.qty, need);
    stack.qty -= take;
    need -= take;
    if (stack.qty <= 0) removeItemByUid(inv, stack.uid);
  }
  return amount - need;
}

/**
 * 在两个容器之间移动物品。
 * @param {object} from 源容器
 * @param {object} to 目标容器
 * @param {string} uid 物品 uid
 * @returns {boolean} 是否成功
 */
export function moveItem(from, to, uid) {
  const item = from.items.find((it) => it.uid === uid);
  if (!item) return false;
  const snapshot = { qty: item.qty };
  removeItemByUid(from, uid);
  if (!autoPlace(to, item)) {
    // 回滚
    item.qty = snapshot.qty;
    if (!autoPlace(from, item)) {
      // 极端情况：源容器也放不回，则丢弃
      return false;
    }
    return false;
  }
  return true;
}

/**
 * 序列化容器（存档用）。
 * @param {object} inv 容器
 * @returns {object} 纯数据快照
 */
export function serializeInventory(inv) {
  return {
    cols: inv.cols,
    rows: inv.rows,
    items: inv.items.map((it) => ({
      uid: it.uid, id: it.id, qty: it.qty, col: it.col, row: it.row,
    })),
  };
}

/**
 * 反序列化容器（存档用）。未知 id 会被跳过。
 * @param {object} data serializeInventory 的输出
 * @param {object} defs 物品定义表（ITEMS）
 * @returns {object} 容器对象
 */
export function deserializeInventory(data, defs) {
  const inv = createInventory(
    (data && data.cols) || 5,
    (data && data.rows) || 6,
  );
  if (data && Array.isArray(data.items)) {
    for (const raw of data.items) {
      const def = defs[raw.id];
      if (!def) continue;
      const item = createItem(def, raw.qty || 1);
      item.uid = raw.uid || item.uid;
      item.col = typeof raw.col === 'number' ? raw.col : -1;
      item.row = typeof raw.row === 'number' ? raw.row : -1;
      if (item.col < 0 || item.row < 0) {
        if (!autoPlace(inv, item)) continue;
      } else if (!canPlace(inv, item, item.col, item.row)) {
        item.col = -1;
        item.row = -1;
        if (!autoPlace(inv, item)) continue;
      } else {
        inv.items.push(item);
      }
    }
  }
  return inv;
}

/**
 * 负重上限（kg）= 基础 20kg + 护甲加成。
 * 二级甲 +3kg、三级甲 +6kg —— 穿甲的收益是"能多背一点"，代价是本身更重（5.0 / 7.5kg），
 * 净收益二级 +(-2.0)、三级 +(-1.5)，即重甲仍然略亏，但亏得少，鼓励"看情况穿"。
 * @param {string|null} armorId 当前护甲 id（none / lv2 / lv3）
 * @returns {number} 上限 kg
 */
export function weightLimitFor(armorId) {
  const bonus = PLAYER.weightArmorBonus[armorId];
  return PLAYER.weightBaseLimit + (typeof bonus === 'number' ? bonus : 0);
}

/**
 * 负重等级：0=轻便，1=超重，2=重度超重。
 * 判定用**比例**而不是绝对差值：上限会随护甲变化（20/23/26kg），
 * 写死 kg 差值会让"二级甲背同样重量"得出不同结论。
 * @param {number} weight 当前重量
 * @param {number} limit 当前上限
 * @returns {number} 等级 0/1/2
 */
export function weightTier(weight, limit) {
  if (weight <= limit) return 0;
  const over = weight / limit;
  if (over <= 1.35) return 1;
  return 2;
}

/**
 * 负重对移速的影响系数。
 *
 * 设计口径（与"超重减速 50% + 禁奔跑"对齐）：
 *   - 未超重：1（**没有**"越接近上限越慢"这种软惩罚）
 *   - 刚超重：约 0.95，立刻可感
 *   - 超重 35%：0.83
 *   - 超重 100%（背了两倍上限）：触底 0.5，即"减速 50%"
 * 也就是说 floor 必须在 2 倍超重时才吃到，而不是刚超重就腰斩 ——
 * 否则玩家背包一满就寸步难行，搜刮循环直接断掉。
 *
 * @param {number} weight 当前重量
 * @param {number} limit 当前上限
 * @param {number} floor 减速下限
 * @returns {number} 速度倍率
 */
export function weightSpeedMultiplier(weight, limit, floor = 0.5) {
  if (limit <= 0 || weight <= limit) return 1;
  const over = (weight - limit) / limit;
  return Math.max(floor, 1 - over * 0.5);
}

/**
 * 负重对体力恢复的影响系数。
 * 系数 0.6 比移速的 0.5 更陡、下限 0.4 比移速的 0.5 更低 ——
 * 体力是"还能不能逃"的底线，超重时它应该比腿脚先垮。
 * @param {number} weight 当前重量
 * @param {number} limit 当前上限
 * @param {number} floor 恢复下限
 * @returns {number} 体力恢复倍率
 */
export function weightStaminaMultiplier(weight, limit, floor = 0.4) {
  if (limit <= 0 || weight <= limit) return 1;
  const over = (weight - limit) / limit;
  return Math.max(floor, 1 - over * 0.6);
}

/** 是否处于硬性超重（超重即禁跑，见 player.js） */
export function isOverweight(weight, limit) {
  return limit > 0 && weight > limit;
}
