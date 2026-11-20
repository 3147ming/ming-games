/**
 * 背包格子与负重系统（纯逻辑模块）
 *
 * 采用"俄罗斯方块"式格位背包：每个物品占据 w×h 个格子，可堆叠物品优先合并。
 * 不依赖 DOM / Canvas / localStorage。
 */

import { PLAYER, ITEMS, BACKPACKS, RIGS } from './config.js';
import { canSecureItem } from './secure.js';

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
    // P18（搜打撤拾取机制）：旋转 / 是否可以旋转 / 锁定 / 标签 / 可装备槽位。
    // 现有物品默认 rotatable；def.noRotate 可关掉（如某些 1×1 铆钉）。
    rotated: false,
    rotate: def.noRotate ? false : true,
    // 锁定物品：自动整理 / 快速转移都不动它（任务物、安全容器物）。
    locked: !!def.locked,
    // 任务 / 制作 / 高价值 / 绑定 等语义标签，UI 取舍推荐用。
    tags: Array.isArray(def.tags) ? def.tags.slice() : [],
    // 可装备的槽位类型（如 ['armor'] / ['helmet'] / ['primaryWeapon']），
    // 空表示只能进格位背包、不能进装备槽。
    slots: Array.isArray(def.slot) ? def.slot.slice() : (def.slot ? [def.slot] : []),
    col: -1,
    row: -1,
  };
}

/**
 * 物品实际宽度（已计旋转）。
 * @param {object} item 物品实例
 * @returns {number} 占格宽
 */
export function itemW(item) {
  return item.rotated ? item.h : item.w;
}

/**
 * 物品实际高度（已计旋转）。
 * @param {object} item 物品实例
 * @returns {number} 占格高
 */
export function itemH(item) {
  return item.rotated ? item.w : item.h;
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
    // P18：容器元信息（与文档 GridContainer 对齐），老调用方忽略即可。
    name: opts.name || '背包',
    kind: opts.kind || 'inventory', // inventory | rig | pocket | secure | corpse | crate | groundBag
    containerType: opts.containerType || 'player',
    // 该容器只接受这些 category（未指定表示全接受）。
    accepted: opts.accepted ? opts.accepted.slice() : null,
    // 只读容器（如已搜空的尸体背包）不可写入。
    readonly: !!opts.readonly,
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
  // E-05：安全箱禁放清单。放在最底层，autoPlace / findFirstFit / placeItemAt /
  // placeItem 全部经过这里，任何入口都绕不过（placeItem 另有 SECURE_BLOCKED 文案）。
  if (inv.kind === 'secure' && !canSecureItem(item)) return false;
  const w = itemW(item);
  const h = itemH(item);
  if (col < 0 || row < 0 || col + w > inv.cols || row + h > inv.rows) return false;
  if (inv.accepted && item.category && !inv.accepted.includes(item.category)) return false;
  for (const other of inv.items) {
    if (other.uid === item.uid || (ignoreUid && other.uid === ignoreUid)) continue;
    const ox = other.col;
    const oy = other.row;
    if (ox < 0 || oy < 0) continue;
    const ow = itemW(other);
    const oh = itemH(other);
    const overlap = col < ox + ow && col + w > ox && row < oy + oh && row + h > oy;
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
  for (let row = 0; row <= inv.rows - itemH(item); row += 1) {
    for (let col = 0; col <= inv.cols - itemW(item); col += 1) {
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
  for (let row = 0; row <= inv.rows - itemH(item); row += 1) {
    for (let col = 0; col <= inv.cols - itemW(item); col += 1) {
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
/**
 * 物品展示单位换算：弹药按「盒」展示，其余按件数。
 *
 * ⚠ 口径铁律：弹药库存 qty 以「发」计，但配置里 weight / value 都是「每盒」口径
 * （见 config.ammo556.weight=1.0 是「每盒 60 发」的重量，不是每发）。
 * 一切展示 / 计价 / 计重都必须经此换算，禁止直接 `qty × weight/value` ——
 * 否则「一盒 5.56 按 60kg / ¥36,000 计」、带弹即永久超重。
 *
 * @param {object} item 物品实例
 * @returns {{count: (number|string), unit: string}} 展示数量与单位
 */
export function displayUnits(item) {
  const def = ITEMS[item.id] || {};
  const qty = Math.max(0, item.qty || 0);
  if (def.category === 'ammo' && def.ammoQty && def.ammoQty > 1) {
    const per = def.ammoQty;
    const boxes = Math.floor(qty / per);
    const rem = qty % per;
    if (boxes === 0) return { count: `${rem}发`, unit: '' };
    if (rem === 0) return { count: boxes, unit: '盒' };
    return { count: `${boxes}盒+${rem}发`, unit: '' };
  }
  return { count: qty, unit: '' };
}

/** 单件物品重量（kg，已按口径换算：弹药按盒计） */
export function itemWeight(it) {
  // 回落顺序：配置表 → 物品实例快照（createItem 已把 value/weight/category/ammoQty 拷进实例）。
  // 真实物品永远命中 ITEMS；回落只让"合成物品 / 未来新增未登记物品"也能正确计价而不显示 0/kg。
  const def = ITEMS[it.id] || it;
  if (def.category === 'ammo' && def.ammoQty && def.ammoQty > 1) {
    return Math.round((def.weight || 0) * (Math.max(0, it.qty || 0) / def.ammoQty) * 10) / 10;
  }
  return Math.round((def.weight || 0) * Math.max(1, it.qty || 1) * 10) / 10;
}

/** 单件物品价值（已按口径换算：弹药按盒计） */
export function itemValue(it) {
  const def = ITEMS[it.id] || it;
  if (def.category === 'ammo' && def.ammoQty && def.ammoQty > 1) {
    return Math.round((def.value || 0) * (Math.max(0, it.qty || 0) / def.ammoQty));
  }
  return Math.round((def.value || 0) * Math.max(1, it.qty || 1));
}

export function totalWeight(inv) {
  if (!inv) return 0;
  let sum = 0;
  for (const it of inv.items) sum += itemWeight(it);
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
  for (const it of inv.items) sum += itemValue(it);
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
 * 负重上限（kg）= 基础 28kg + 护甲加成 + 背包加成（W2）。
 * 二级甲 +8kg、三级甲 +12kg —— 穿甲的收益是"能多背一点"，代价是本身更重（5.0 / 7.5kg），
 * 净收益二级 +(-2.0)、三级 +(-1.5)，即重甲仍然略亏，但亏得少，鼓励"看情况穿"。
 *
 * W2 新增第二个参数：背包的 `packBonus`。**默认 0**，所以只传护甲的老调用点
 * （含旧单测与玩家构造）结果与改动前逐位相同。
 * @param {string|null} armorId 当前护甲 id（none / lv2 / lv3）
 * @param {string|null} [backpackId] 当前背包 id（none / bp_lv1…）
 * @returns {number} 上限 kg
 */
export function weightLimitFor(armorId, backpackId) {
  const bonus = PLAYER.weightArmorBonus[armorId];
  const pack = backpackId && BACKPACKS[backpackId] ? BACKPACKS[backpackId] : null;
  const packBonus = pack && typeof pack.packBonus === 'number' ? pack.packBonus : 0;
  return PLAYER.weightBaseLimit + (typeof bonus === 'number' ? bonus : 0) + packBonus;
}

/**
 * 胸挂容器尺寸（W2）。胸挂槽的 id → `{cols, rows}`。
 *
 * 未知/空 id 一律回落到 `rig_lv1` 而不是 `none`：旧档没有这个字段、
 * 手改存档写了不存在的 id，都不该让玩家凭空丢掉 4 格容量（那是隐性削弱）。
 * 只有玩家**显式**选 `none`（无胸挂）才降到 3×1。
 * @param {string|null} rigId 胸挂 id
 * @returns {{cols:number, rows:number}} 容器尺寸
 */
export function rigSizeFor(rigId) {
  const def = rigId && RIGS[rigId] ? RIGS[rigId] : RIGS.rig_lv1;
  return { cols: def.cols, rows: def.rows };
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

/* ============================ P18 搜打撤拾取机制 ============================
 * 在既有"格位 + 堆叠 + 移动 + 序列化"基底上，补上三角洲式搜刮所需的能力：
 * 旋转、装备槽占位、枚举化失败原因、拆分、事务化自动整理、单格价值、取舍推荐。
 * 所有新接口都向后兼容旧调用方（旧 boolean 接口的语义保持不变）。
 */

/**
 * 占位失败原因枚举（与开发指令书对齐）。
 * 所有"放置 / 移除 / 移动 / 旋转 / 拆分 / 整理"操作都返回 { ok, reason }，
 * 不返回裸 false —— UI 才能给出"为什么失败"的可读提示。
 */
export const PLACEMENT_REASON = {
  OK: 'OK',
  OUT_OF_BOUNDS: 'OUT_OF_BOUNDS',
  OCCUPIED: 'OCCUPIED',
  NOT_ENOUGH_SPACE: 'NOT_ENOUGH_SPACE',
  NOT_STACKABLE: 'NOT_STACKABLE',
  STACK_FULL: 'STACK_FULL',
  SLOT_NOT_ALLOWED: 'SLOT_NOT_ALLOWED',
  ITEM_LOCKED: 'ITEM_LOCKED',
  CONTAINER_READONLY: 'CONTAINER_READONLY',
  SECURE_BLOCKED: 'SECURE_BLOCKED', // E-05：禁放物不能进安全箱
  UNKNOWN: 'UNKNOWN',
};

/** 失败原因 → 玩家可读提示（与指令书 P1-13 映射一致）。 */
export const REASON_TEXT = {
  OUT_OF_BOUNDS: '放不下：超出容器范围',
  OCCUPIED: '放不下：位置已被占用',
  NOT_ENOUGH_SPACE: '空间不足',
  NOT_STACKABLE: '不能与该物品堆叠',
  STACK_FULL: '堆叠已满',
  SLOT_NOT_ALLOWED: '该物品不能装备到此槽位',
  ITEM_LOCKED: '该物品已锁定',
  CONTAINER_READONLY: '该容器不可放入物品',
  SECURE_BLOCKED: '该物品不可放入安全箱（高价值/任务物品）',
  UNKNOWN: '操作失败',
};

/**
 * 把物品放到指定格位（枚举化版本）。
 * @returns {{ok:boolean, reason:string, item:object|null}}
 */
export function placeItem(inv, item, col, row) {
  if (inv.readonly) return { ok: false, reason: PLACEMENT_REASON.CONTAINER_READONLY, item: null };
  // E-05：安全箱禁放清单（高价值争夺物 / 任务关键物 / 部分针剂）在放置底层拦截，
  // 任何入口（拖拽/快速拾取/takeAll）都绕不过，且失败原因有明确玩家提示。
  if (inv.kind === 'secure' && !canSecureItem(item)) {
    return { ok: false, reason: PLACEMENT_REASON.SECURE_BLOCKED, item: null };
  }
  if (!canPlace(inv, item, col, row)) {
    const w = itemW(item);
    const h = itemH(item);
    let reason = PLACEMENT_REASON.OCCUPIED;
    if (col < 0 || row < 0 || col + w > inv.cols || row + h > inv.rows) reason = PLACEMENT_REASON.OUT_OF_BOUNDS;
    else if (inv.accepted && item.category && !inv.accepted.includes(item.category)) reason = PLACEMENT_REASON.SLOT_NOT_ALLOWED;
    return { ok: false, reason, item: null };
  }
  item.col = col;
  item.row = row;
  if (!inv.items.includes(item)) inv.items.push(item);
  return { ok: true, reason: PLACEMENT_REASON.OK, item };
}

/**
 * 按 uid 移除物品（枚举化版本）。
 * @returns {{ok:boolean, reason:string, item:object|null}}
 */
export function removeItem(inv, uid) {
  const item = removeItemByUid(inv, uid);
  if (!item) return { ok: false, reason: PLACEMENT_REASON.UNKNOWN, item: null };
  return { ok: true, reason: PLACEMENT_REASON.OK, item };
}

/**
 * 在容器内寻找可合并的同模板堆叠目标（返回空间最多的那个）。
 * @param {object} inv 容器
 * @param {object} item 待合并物品
 * @param {string} [ignoreUid] 忽略（自身）
 * @returns {object|null}
 */
export function findStackTarget(inv, item, ignoreUid = null) {
  if (!inv || !item || item.stack <= 1) return null;
  let best = null;
  let bestSpace = 0;
  for (const other of inv.items) {
    if (other.uid === item.uid || (ignoreUid && other.uid === ignoreUid)) continue;
    if (other.id !== item.id || other.stack <= 1) continue;
    if (other.col < 0) continue;
    const space = other.stack - other.qty;
    if (space > bestSpace) { best = other; bestSpace = space; }
  }
  return best;
}

/** 在给定朝向下扫描第一个可放位置（不修改 col/row 除非命中）。 */
function fitAtOrientation(inv, item, rotated, ignoreUid) {
  item.rotated = rotated;
  const w = itemW(item);
  const h = itemH(item);
  if (w > inv.cols || h > inv.rows) return null;
  for (let row = 0; row <= inv.rows - h; row += 1) {
    for (let col = 0; col <= inv.cols - w; col += 1) {
      if (canPlace(inv, item, col, row, ignoreUid)) return { x: col, y: row, rotated };
    }
  }
  return null;
}

/**
 * 为物品寻找第一个合法落位（优先堆叠，其次空格；可旋转时尝试旋转以提升密度）。
 * 命中会就地改写 item.rotated / col / row。
 * @param {object} inv 容器
 * @param {object} item 物品
 * @param {object} [opts] { rotate=true, ignoreUid=null, preferStack=true }
 * @returns {{x:number,y:number,rotated:boolean}|null}
 */
export function findFirstFit(inv, item, opts = {}) {
  if (!inv || !item) return null;
  const allowRotate = opts.rotate !== false && item.rotate && item.w !== item.h;
  const saved = item.rotated;
  // 先尝试当前朝向
  let r = fitAtOrientation(inv, item, saved, opts.ignoreUid);
  // 再尝试另一朝向
  if (!r && allowRotate) r = fitAtOrientation(inv, item, !saved, opts.ignoreUid);
  if (!r) { item.rotated = saved; return null; }
  item.rotated = r.rotated;
  item.col = r.x;
  item.row = r.y;
  return r;
}

/**
 * 在原位或就近尝试旋转物品，旋转后放不下则回滚。
 * @param {object} inv 容器
 * @param {string} uid 物品 uid
 * @returns {{ok:boolean, reason:string, item:object|null}}
 */
export function rotateItemIn(inv, uid) {
  const item = inv && inv.items.find((it) => it.uid === uid);
  if (!item) return { ok: false, reason: PLACEMENT_REASON.UNKNOWN, item: null };
  if (!item.rotate || item.w === item.h) return { ok: false, reason: PLACEMENT_REASON.NOT_ROTATABLE, item: null };
  const oldRot = item.rotated;
  const oldCol = item.col;
  const oldRow = item.row;
  item.rotated = !oldRot;
  const fit = findFirstFit(inv, item, { ignoreUid: uid });
  if (fit) return { ok: true, reason: PLACEMENT_REASON.OK, item };
  // 回滚
  item.rotated = oldRot;
  item.col = oldCol;
  item.row = oldRow;
  return { ok: false, reason: PLACEMENT_REASON.NOT_ENOUGH_SPACE, item: null };
}

/**
 * 拆分堆叠：从 uid 物品上分出 n 个到新堆，新堆必须能落进容器。
 * @param {object} inv 容器
 * @param {string} uid 源物品 uid
 * @param {number} [n] 拆分数量；缺省为一半
 * @returns {{ok:boolean, reason:string, item:object|null}}
 */
export function splitStack(inv, uid, n) {
  const item = inv && inv.items.find((it) => it.uid === uid);
  if (!item) return { ok: false, reason: PLACEMENT_REASON.UNKNOWN, item: null };
  if (!inv || inv.readonly) return { ok: false, reason: PLACEMENT_REASON.CONTAINER_READONLY, item: null };
  if (item.stack <= 1) return { ok: false, reason: PLACEMENT_REASON.NOT_STACKABLE, item: null };
  if (n == null) n = Math.floor(item.qty / 2);
  n = Math.max(1, Math.min(Math.floor(n), item.qty - 1));
  if (!(n >= 1 && n <= item.qty - 1)) return { ok: false, reason: PLACEMENT_REASON.UNKNOWN, item: null };
  const def = ITEMS[item.id] || {};
  const part = createItem(def, n);
  part.rotated = item.rotated;
  part.rotate = item.rotate;
  part.locked = item.locked;
  part.tags = item.tags.slice();
  part.slots = item.slots.slice();
  const before = item.qty;
  item.qty -= n;
  // 拆分出的新堆必须落到"另一个空格"，绝不自动并回原堆（否则只剩一堆、丢失拆分语义）。
  const fit = findFirstFit(inv, part, { rotate: false, ignoreUid: part.uid });
  if (!fit) {
    item.qty = before; // 回滚，绝不丢数量
    return { ok: false, reason: PLACEMENT_REASON.NOT_ENOUGH_SPACE, item: null };
  }
  if (!inv.items.includes(part)) inv.items.push(part);
  return { ok: true, reason: PLACEMENT_REASON.OK, item: part };
}

/**
 * 自动整理当前容器（事务化）：
 * 1) 锁定物品原地不动；2) 同类未满堆叠先合并；3) 按面积→价值→名称稳定排序；
 * 4) 从左上到右下放置，必要时旋转以提高密度。
 * 任意物品无处可去则整体回滚，容器状态不变。
 * @param {object} inv 容器
 * @param {object} [opts] { rotate=true }
 * @returns {{ok:boolean, reason:string}}
 */
export function sortContainer(inv, opts = {}) {
  if (!inv) return { ok: false, reason: PLACEMENT_REASON.UNKNOWN };
  if (inv.readonly) return { ok: false, reason: PLACEMENT_REASON.CONTAINER_READONLY };
  // 快照（含数量，因为整理会合并堆叠）
  const snap = inv.items.map((it) => ({ uid: it.uid, col: it.col, row: it.row, rotated: it.rotated, qty: it.qty }));
  const order = inv.items.slice().sort((a, b) => {
    const la = itemW(a) * itemH(a);
    const lb = itemW(b) * itemH(b);
    if (la !== lb) return lb - la;
    const va = itemValue(a);
    const vb = itemValue(b);
    if (va !== vb) return vb - va;
    return String(a.id).localeCompare(String(b.id));
  });
  // 锁定物品视为不动障碍；可移动物品清空位置
  for (const it of order) if (!it.locked) { it.col = -1; it.row = -1; }
  const rollback = () => {
    for (const s of snap) {
      const x = inv.items.find((o) => o.uid === s.uid);
      if (x) { x.col = s.col; x.row = s.row; x.rotated = s.rotated; x.qty = s.qty; }
    }
  };
  for (const it of order) {
    if (it.locked) continue;
    // 先合并进同类未满堆叠
    const target = findStackTarget(inv, it, it.uid);
    if (target) {
      const give = Math.min(target.stack - target.qty, it.qty);
      target.qty += give;
      it.qty -= give;
      if (it.qty <= 0) {
        removeItemByUid(inv, it.uid);
        continue;
      }
    }
    const fit = findFirstFit(inv, it, { rotate: opts.rotate !== false, ignoreUid: it.uid });
    if (!fit) {
      rollback();
      return { ok: false, reason: PLACEMENT_REASON.NOT_ENOUGH_SPACE };
    }
  }
  return { ok: true, reason: PLACEMENT_REASON.OK };
}

/**
 * 单格价值 = 总价值 / 占格数（堆叠按总数量计）。
 * @param {object} item 物品实例
 * @returns {number}
 */
export function valuePerCell(item) {
  const cells = Math.max(1, item.w * item.h);
  return Math.round(itemValue(item) / cells);
}

/**
 * 在容器中找出"最该被替换/丢弃"的低价值物品（用于背包满时的取舍推荐）。
 * 不推荐：锁定物品、任务物（tag task）、安全容器物（tag secure）。
 * @param {object} inv 容器
 * @returns {object|null} 推荐丢弃的物品
 */
export function recommendDiscard(inv) {
  if (!inv) return null;
  let worst = null;
  let worstScore = Infinity;
  for (const it of inv.items) {
    if (it.locked) continue;
    if (Array.isArray(it.tags) && (it.tags.includes('task') || it.tags.includes('secure'))) continue;
    const score = valuePerCell(it);
    if (score < worstScore) { worstScore = score; worst = it; }
  }
  return worst;
}

