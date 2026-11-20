/**
 * 搜打撤拾取机制（P18）：可搜刮实体 / 装备槽 / 玩家随身 / 快捷拾取
 *
 * 纯逻辑模块，零 DOM / 零 three / 零随机依赖，便于单元测试与真浏览器探针复用。
 * 所有物品、格位、堆叠、旋转、自动整理都复用 inventory.js 的同一套底层函数，
 * 保证"UI 操作 = 数据操作"且任何不确定状态都回滚（防丢 / 防复制）。
 */

import {
  createInventory, createItem, itemW, itemH, canPlace, placeItem,
  findStackTarget, findFirstFit, autoPlace, PLACEMENT_REASON,
  itemValue, totalValue, totalWeight, valuePerCell, rotateItemIn, splitStack,
  sortContainer, recommendDiscard, REASON_TEXT,
} from './inventory.js';
import { ITEMS, ENEMY_TYPES, CONTAINERS } from './config.js';

/** 失败原因别名（与开发指令书 FAILURE_REASON 对齐）。 */
export const FAILURE_REASONS = PLACEMENT_REASON;

/** 装备槽类型常量（文档 EquipmentSlot.slotType）。 */
export const SLOT = {
  PRIMARY: 'primaryWeapon',
  SECONDARY: 'secondaryWeapon',
  SIDEARM: 'sidearm',
  ARMOR: 'armor',
  HELMET: 'helmet',
  RIG: 'rig',
  BACKPACK: 'backpack',
  POCKET: 'pocket',
  SECURE: 'secureContainer',
};

/** 各槽位接受的分类（item.category 或 item.slots）。 */
export const SLOT_ACCEPT = {
  [SLOT.PRIMARY]: ['weapon'],
  [SLOT.SECONDARY]: ['weapon'],
  [SLOT.SIDEARM]: ['weapon'],
  [SLOT.ARMOR]: ['armor'],
  [SLOT.HELMET]: ['helmet'],
  [SLOT.RIG]: ['rig'],
  [SLOT.BACKPACK]: ['backpack'],
  [SLOT.POCKET]: ['pocket'],
  [SLOT.SECURE]: ['valuable', 'material', 'consumable', 'ammo', 'weapon', 'armor', 'helmet'],
};

/**
 * 创建一个装备槽。
 * @param {string} type 槽位类型（SLOT.*）
 * @param {object} [opts] { name, item, container }
 * @returns {object}
 */
export function makeSlot(type, opts = {}) {
  return {
    type,
    name: opts.name || SLOT_NAME(type),
    accepted: opts.accepted || SLOT_ACCEPT[type] || null,
    item: opts.item || null,
    // 背包 / 胸挂 / 口袋 / 安全容器槽可携带一个网格容器（attachedContainer）。
    container: opts.container || null,
  };
}

function SLOT_NAME(type) {
  return {
    primaryWeapon: '主武器', secondaryWeapon: '副武器', sidearm: '手枪',
    armor: '护甲', helmet: '头盔', rig: '胸挂', backpack: '背包',
    pocket: '口袋', secureContainer: '安全容器',
  }[type] || type;
}

/**
 * 创建一个可搜刮实体（文档 LootableEntity）。
 * @param {object} def { id, name, type, containers?, slots?, searched?, locked?, readonly? }
 * @returns {object}
 */
export function makeLootable(def) {
  const containers = (def.containers || []).map((c, i) => ({
    ...c,
    cid: c.cid || `e${i}`,
    kind: c.kind || 'loot',
    containerType: c.containerType || 'corpse',
  }));
  const slots = (def.slots || []).map((s) => ({
    ...s,
    type: s.type,
    name: s.name || SLOT_NAME(s.type),
    accepted: s.accepted || SLOT_ACCEPT[s.type] || null,
  }));
  return {
    id: def.id,
    name: def.name || '目标',
    type: def.type || 'crate',
    containers,
    slots,
    searched: !!def.searched,
    locked: !!def.locked,
    readonly: !!def.readonly,
  };
}

/**
 * 普通容器（抽屉 / 箱子 / 武器箱 / 保险箱 / 空投）：单个网格 + 内部物品。
 * @param {string} type CONTAINERS 的 key
 * @param {Array<object>} loot 物品实例数组
 * @param {object} [opts] { id, searched, readonly }
 * @returns {object} LootableEntity
 */
/**
 * 按物品总体积生成一个"刚好装得下"的网格容器（自动旋转、必要时加高）。
 * 为什么不用固定尺寸：随机掉落的件数与尺寸不可控，固定格子会静默吞掉装不下的物品。
 * @param {Array<object>} items 物品实例
 * @param {object} opts { name, kind, containerType, cols }
 * @returns {object} inventory
 */
export function gridFromItems(items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const cols = Math.max(5, Math.min(10, opts.cols || 6));
  let area = 0;
  for (const it of list) area += itemW(it) * itemH(it);
  let rows = Math.max(4, Math.ceil(area / cols) + 1);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const inv = createInventory(cols, Math.min(12, rows), {
      name: opts.name, kind: opts.kind, containerType: opts.containerType,
    });
    let ok = true;
    for (const it of list) {
      if (!autoPlace(inv, it)) { ok = false; break; }
    }
    if (ok) return inv;
    rows += 2;
  }
  // 兜底：网格极限仍装不下（理论上不会），保留引用不丢物品
  const inv = createInventory(cols, 12, { name: opts.name, kind: opts.kind, containerType: opts.containerType });
  for (const it of list) if (!autoPlace(inv, it)) inv.items.push(it);
  return inv;
}

export function containerFromType(type, loot, opts = {}) {
  const def = CONTAINERS[type] || { name: type };
  const inv = gridFromItems(loot, { name: def.name, kind: 'loot', containerType: type });
  return makeLootable({
    id: opts.id || type,
    name: def.name,
    type: 'loot',
    containers: [inv],
    searched: opts.searched,
    readonly: opts.readonly,
  });
}

/**
 * 尸体：武器 / 护甲 / 头盔槽 + 一个携带背包网格。
 * 把 loot 中可装备的物资提升到对应槽位（武器栏置顶），其余进背包网格。
 * @param {string} enemyType ENEMY_TYPES 的 key
 * @param {Array<object>} loot 物品实例数组
 * @param {object} [opts] { id, name }
 * @returns {object} LootableEntity
 */
export function corpseFromEnemy(enemyType, loot, opts = {}) {
  const etype = ENEMY_TYPES[enemyType] || ENEMY_TYPES.patrol;
  const label = opts.name || (etype ? etype.name : '敌人') || '尸体';
  const slots = [
    makeSlot(SLOT.PRIMARY),
    makeSlot(SLOT.SECONDARY),
    makeSlot(SLOT.ARMOR),
    makeSlot(SLOT.HELMET),
  ];
  const bag = createInventory(6, 5, { name: '携带背包', kind: 'loot', containerType: 'corpse' });
  // 携带容器网格的尺寸随 loot 量自适应
  const need = Math.max(loot.length, 1);
  bag.cols = Math.max(5, Math.min(10, 5 + Math.floor(need / 4)));
  bag.rows = Math.max(4, Math.min(7, 4 + Math.floor(need / 6)));
  for (const it of loot) {
    const slotType = (it.slots && it.slots[0]) || null;
    const slot = slotType && slots.find((s) => s.type === slotType && !s.item);
    if (slot) slot.item = it;
    else if (!autoPlace(bag, it)) bag.items.push(it); // 极端塞不下也保留引用
  }
  return makeLootable({ id: opts.id || 'body', name: `${label} 的尸体`, type: 'corpse', containers: [bag], slots });
}

/** 地面掉落包：单个网格容器。 */
export function groundBagFromItems(items, opts = {}) {
  const inv = createInventory(5, 4, { name: '地面物资', kind: 'groundBag', containerType: 'groundBag' });
  for (const it of items) autoPlace(inv, it);
  return makeLootable({ id: opts.id || 'ground', name: '地面物资', type: 'groundBag', containers: [inv] });
}

/** 取实体的所有网格容器（供 UI 切页）。 */
export function entityContainers(entity) {
  const list = (entity.containers || []).slice();
  for (const s of entity.slots || []) if (s.container) list.push(s.container);
  return list;
}

/** 在实体（槽位或容器）中查找物品。 */
export function findItemInEntity(entity, uid) {
  for (const s of entity.slots || []) {
    if (s.item && s.item.uid === uid) return { kind: 'slot', slot: s, item: s.item };
  }
  for (const c of entityContainers(entity)) {
    const it = c.items.find((x) => x.uid === uid);
    if (it) return { kind: 'container', container: c, item: it };
  }
  return null;
}

/**
 * 从实体中移除某 uid（转移语义）。
 * ⚠ 绝不能用 removeItemByUid：它会把 item.col/row 重置为 -1，而该物品可能已被
 * push 进目标容器（同一个对象引用），会把目标容器的坐标一起抹掉 —— 界面上物品
 * 就会"消失"在 -1 格。这里只从数组摘除，坐标由目标容器重新设置。
 */
export function removeFromEntity(entity, uid) {
  for (const s of entity.slots || []) {
    if (s.item && s.item.uid === uid) { const it = s.item; s.item = null; return it; }
  }
  for (const c of entityContainers(entity)) {
    const idx = c.items.findIndex((x) => x.uid === uid);
    if (idx >= 0) return c.items.splice(idx, 1)[0];
  }
  return null;
}

/**
 * 事务快照：记录来源实体与玩家随身的容器成员 / 物品字段 / 装备槽。
 * 用于把"移动 / 拾取 / 装备 / 整理"包成原子操作：失败时一次性完整恢复，
 * 绝不出现"物品已离开来源却没进目标"或数量漂移。
 */
export function snapshotTransfer(entity, gear) {
  const containers = [];
  const seen = new Set();
  const push = (c) => {
    if (!c || seen.has(c)) return;
    seen.add(c);
    containers.push({
      c,
      fields: c.items.map((it) => ({ it, qty: it.qty, col: it.col, row: it.row, rotated: it.rotated })),
    });
  };
  for (const c of entity ? entityContainers(entity) : []) push(c);
  for (const c of gear ? gear.containers : []) push(c);
  const slots = [];
  for (const s of [...(entity ? entity.slots || [] : []), ...(gear ? gear.slots || [] : [])]) {
    slots.push({ s, item: s.item });
  }
  return { containers, slots };
}

/** 恢复 snapshotTransfer 的快照（物品对象引用与全部字段一并还原）。 */
export function restoreTransfer(snap) {
  if (!snap) return;
  for (const rec of snap.containers) {
    rec.c.items.length = 0;
    for (const f of rec.fields) {
      f.it.qty = f.qty;
      f.it.col = f.col;
      f.it.row = f.row;
      f.it.rotated = f.rotated;
      rec.c.items.push(f.it);
    }
  }
  for (const rec of snap.slots) rec.s.item = rec.item;
}

/**
 * 把可堆叠物品尽量合并进容器的同类未满堆叠，返回未能合并的剩余数量。
 * 只改 qty，不移除物品本体；调用方凭返回值决定是"整件已合并"还是"剩余另找空位"。
 */
function mergeStacksInto(containers, item) {
  if (!item || item.stack <= 1) return item ? item.qty : 0;
  let remain = item.qty;
  for (const c of containers) {
    if (remain <= 0) break;
    let guard = 0;
    while (remain > 0 && guard < 512) {
      guard += 1;
      const t = findStackTarget(c, item, item.uid);
      if (!t) break;
      const give = Math.min(t.stack - t.qty, remain);
      if (give <= 0) break;
      t.qty += give;
      remain -= give;
    }
  }
  return remain;
}

/** 按 uid 从"玩家容器 → 来源实体"里摘除物品（转移语义，不重置坐标）。 */
function detachByUid(gear, entity, uid) {
  for (const c of gear ? gear.containers : []) {
    const idx = c.items.findIndex((x) => x.uid === uid);
    if (idx >= 0) return c.items.splice(idx, 1)[0];
  }
  if (entity) return removeFromEntity(entity, uid);
  return null;
}

/**
 * 构建玩家随身模型（双栏右栏）。
 * @param {object} inventory 玩家主背包网格
 * @param {object} loadout 装备配置（primary/secondary/armor/helmet）
 * @param {object} [extra] { rig, pocket, secure } 可选网格容器（开局部署创建）
 * @returns {object} { kind:'player', slots, containers }
 */
export function makePlayerGear(inventory, loadout, extra = {}) {
  const slots = [];
  const prim = ITEMS[loadout.primary];
  if (prim) slots.push(makeSlot(SLOT.PRIMARY, { item: createItem(prim) }));
  const sec = ITEMS[loadout.secondary];
  if (sec) slots.push(makeSlot(SLOT.SECONDARY, { item: createItem(sec) }));
  if (loadout.armor && loadout.armor !== 'none' && ITEMS[loadout.armor]) {
    slots.push(makeSlot(SLOT.ARMOR, { item: createItem(ITEMS[loadout.armor]) }));
  }
  if (loadout.helmet && loadout.helmet !== 'none' && ITEMS[loadout.helmet]) {
    slots.push(makeSlot(SLOT.HELMET, { item: createItem(ITEMS[loadout.helmet]) }));
  }
  const containers = [];
  inventory.cid = 'backpack';
  inventory.kind = 'backpack';
  inventory.containerType = 'player';
  inventory.name = '背包';
  containers.push(inventory);
  for (const key of ['rig', 'pocket', 'secure']) {
    const c = extra[key];
    if (c) {
      c.cid = key;
      c.kind = key;
      c.containerType = 'player';
      c.name = SLOT_NAME(key);
      containers.push(c);
    }
  }
  return { kind: 'player', slots, containers };
}

/**
 * 快速拾取（双击 / Ctrl+左键）：优先堆叠 → 装备空槽 → 胸挂/口袋/背包/安全容器。
 * @param {object} entity 来源实体
 * @param {object} gear 玩家随身模型
 * @param {string} uid 物品 uid
 * @returns {{ok:boolean, reason:string, dest?:object}}
 */
export function quickPickup(entity, gear, uid) {
  const snap = snapshotTransfer(entity, gear);
  const found = findItemInEntity(entity, uid);
  if (!found) return { ok: false, reason: FAILURE_REASONS.UNKNOWN };
  const item = found.item;
  // 1. 优先合并同类堆叠（可跨多个未满堆叠，剩余量继续往下走，绝不吞数量）
  const remain = mergeStacksInto(gear.containers, item);
  if (remain <= 0) {
    removeFromEntity(entity, uid);
    return { ok: true, reason: FAILURE_REASONS.OK, dest: { type: 'stack' } };
  }
  item.qty = remain;
  // 2. 放入容器：胸挂 → 口袋 → 背包 → 安全容器（快速拾取不自动装备，
  //    装备由 Alt+左键显式触发，避免搜刮时误占穿戴槽）。
  const order = [SLOT.RIG, SLOT.POCKET, SLOT.BACKPACK, SLOT.SECURE];
  for (const cid of order) {
    const c = gear.containers.find((x) => x.cid === cid);
    if (!c || c.readonly) continue;
    const fit = findFirstFit(c, item, { rotate: true, ignoreUid: item.uid });
    if (fit) {
      if (!c.items.includes(item)) c.items.push(item);
      removeFromEntity(entity, uid);
      return { ok: true, reason: FAILURE_REASONS.OK, dest: { type: 'container', cid } };
    }
  }
  // 3. 失败：整体回滚（含刚才合并进去的数量），源容器物品原封不动
  restoreTransfer(snap);
  return { ok: false, reason: FAILURE_REASONS.NOT_ENOUGH_SPACE };
}

/**
 * 把物品装备到玩家槽位；若槽位已占用，旧装备必须能放进某容器，否则阻止（防丢）。
 * @param {object} gear 玩家模型
 * @param {string} slotType 槽位类型
 * @param {object} item 物品实例
 * @param {object} [entity] 来源实体（旧装备回去时放回这里，避免静默丢弃）
 * @returns {{ok:boolean, reason:string}}
 */
export function equipIntoSlot(gear, slotType, item, entity = null) {
  const slot = gear.slots.find((s) => s.type === slotType);
  if (!slot) return { ok: false, reason: FAILURE_REASONS.SLOT_NOT_ALLOWED };
  // 只读槽位 = 展示位（当前实际穿戴的装备）。局内换甲/换枪不改战斗数值，
  // 允许往这里塞物品会造出"换了却没换"的假象，直接拒绝。
  if (slot.readonly) return { ok: false, reason: FAILURE_REASONS.SLOT_NOT_ALLOWED };
  const okType = slot.accepted
    && (item.slots && item.slots.some((t) => slot.accepted.includes(t)) || slot.accepted.includes(item.category));
  if (!okType) return { ok: false, reason: FAILURE_REASONS.SLOT_NOT_ALLOWED };
  const snap = snapshotTransfer(entity, gear);
  const old = slot.item;
  // 先把新物品从来源摘除，避免"装备成功但原处仍有一份"（复制）
  detachByUid(gear, entity, item.uid);
  slot.item = item;
  if (old) {
    // 旧装备必须能放进玩家某个容器或来源实体；放不下则整体回滚（绝不静默丢弃）
    let placed = false;
    for (const c of gear.containers) {
      const fit = findFirstFit(c, old, { rotate: true, ignoreUid: old.uid });
      if (fit) { if (!c.items.includes(old)) c.items.push(old); placed = true; break; }
    }
    if (!placed && entity) {
      const c = (entity.containers && entity.containers[0]) || null;
      if (c && !c.readonly) {
        const fit = findFirstFit(c, old, { rotate: true, ignoreUid: old.uid });
        if (fit) { if (!c.items.includes(old)) c.items.push(old); placed = true; }
      }
    }
    if (!placed) {
      restoreTransfer(snap);
      return { ok: false, reason: FAILURE_REASONS.NOT_ENOUGH_SPACE };
    }
  }
  return { ok: true, reason: FAILURE_REASONS.OK };
}

/**
 * 卸下槽位物品并进玩家背包（或任意容器）。
 * @param {object} gear 玩家模型
 * @param {string} slotType 槽位类型
 * @returns {{ok:boolean, reason:string, item?:object}}
 */
export function unequipSlot(gear, slotType) {
  const slot = gear.slots.find((s) => s.type === slotType);
  if (!slot || !slot.item) return { ok: false, reason: FAILURE_REASONS.UNKNOWN };
  const snap = snapshotTransfer(null, gear);
  const item = slot.item;
  for (const c of gear.containers) {
    const fit = findFirstFit(c, item, { rotate: true, ignoreUid: item.uid });
    if (fit) {
      if (!c.items.includes(item)) c.items.push(item);
      slot.item = null;
      return { ok: true, reason: FAILURE_REASONS.OK, item };
    }
  }
  restoreTransfer(snap);
  return { ok: false, reason: FAILURE_REASONS.NOT_ENOUGH_SPACE };
}

/**
 * 在两个网格容器之间移动物品（事务化：失败回滚，绝不丢 / 复制）。
 * @param {object} fromInv 源容器
 * @param {object} toInv 目标容器
 * @param {string} uid 物品 uid
 * @param {number} x 目标列
 * @param {number} y 目标行
 * @returns {{ok:boolean, reason:string}}
 */
export function moveItemBetweenContainers(fromInv, toInv, uid, x, y) {
  const item = fromInv.items.find((it) => it.uid === uid);
  if (!item) return { ok: false, reason: FAILURE_REASONS.UNKNOWN };
  if (toInv.readonly) return { ok: false, reason: FAILURE_REASONS.CONTAINER_READONLY };
  const snap = snapshotTransfer(
    { containers: [fromInv], slots: [] },
    { containers: [toInv], slots: [] },
  );
  // 同容器移动时允许与自身原占格临时重叠：canPlace 的 ignoreUid 就是为此存在。
  const res = placeItemRaw(toInv, item, x, y, uid);
  if (!res.ok) { restoreTransfer(snap); return res; }
  // 无论同容器还是跨容器，命中后都必须写入新坐标（placeItemRaw 只做检测）。
  item.col = x;
  item.row = y;
  if (fromInv !== toInv) {
    const idx = fromInv.items.findIndex((it) => it.uid === uid);
    if (idx >= 0) fromInv.items.splice(idx, 1);
    if (!toInv.items.includes(item)) toInv.items.push(item);
  }
  return { ok: true, reason: FAILURE_REASONS.OK };
}

/** 带 ignoreUid 的放置检测（不写容器，供事务化移动复用）。 */
function placeItemRaw(inv, item, col, row, ignoreUid) {
  const w = itemW(item);
  const h = itemH(item);
  if (col < 0 || row < 0 || col + w > inv.cols || row + h > inv.rows) {
    return { ok: false, reason: FAILURE_REASONS.OUT_OF_BOUNDS };
  }
  if (inv.accepted && item.category && !inv.accepted.includes(item.category)) {
    return { ok: false, reason: FAILURE_REASONS.SLOT_NOT_ALLOWED };
  }
  if (!canPlace(inv, item, col, row, ignoreUid)) {
    return { ok: false, reason: FAILURE_REASONS.OCCUPIED };
  }
  return { ok: true, reason: FAILURE_REASONS.OK };
}

/**
 * 把来源容器的全部物品快速拾取到玩家（带整体回滚）。
 * 用于"全部拾取 / 整包带走"：任意一件放不下则整体不动作。
 * @param {object} entity 来源实体
 * @param {object} gear 玩家模型
 * @param {string} [cid] 指定容器；缺省取第一个容器
 * @returns {{ok:boolean, reason:string, taken:number}}
 */
export function takeAllFromContainer(entity, gear, cid, opts = {}) {
  const c = cid ? (entity.containers || []).find((x) => x.cid === cid) : (entity.containers || [])[0];
  if (!c) return { ok: false, reason: FAILURE_REASONS.UNKNOWN, taken: 0 };
  // 整体快照：任一物品放不下时按 opts.atomic 决定是"全部回滚"还是"保留已取"。
  // 两种模式都保证不丢 / 不复制：回滚模式由快照恢复，保留模式由 quickPickup 自事务保证。
  const snap = snapshotTransfer(entity, gear);
  const uids = c.items.map((it) => it.uid);
  let taken = 0;
  for (const uid of uids) {
    const r = quickPickup(entity, gear, uid);
    if (!r.ok) {
      if (opts.atomic !== false) restoreTransfer(snap);
      return { ok: false, reason: r.reason, taken: opts.atomic === false ? taken : 0 };
    }
    taken += 1;
  }
  return { ok: true, reason: FAILURE_REASONS.OK, taken };
}

/**
 * 实体总估值（所有容器 + 槽位物品）。
 * ⚠ 口径铁律：弹药 value 是「每盒」口径，必须经 itemValue 换算，禁止裸乘 qty。
 * @param {object} entity 实体
 * @returns {number}
 */
export function entityValue(entity) {
  let sum = 0;
  // 容器用 totalValue（内部逐件走 itemValue）；槽位物品单独换算。
  for (const c of entityContainers(entity)) sum += totalValue(c);
  for (const s of entity.slots || []) if (s.item) sum += itemValue(s.item);
  return Math.round(sum);
}

/** 玩家随身总估值（含装备槽 + 所有网格容器）。 */
export function gearValue(gear) {
  let sum = 0;
  for (const c of gear.containers || []) sum += totalValue(c);
  for (const s of gear.slots || []) if (s.item) sum += itemValue(s.item);
  return Math.round(sum);
}

/** 玩家随身总重量（含所有网格容器，口径经 itemWeight 换算）。 */
export function gearWeight(gear) {
  let sum = 0;
  for (const c of gear.containers || []) sum += totalWeight(c);
  return Math.round(sum * 10) / 10;
}

/** 列出玩家侧全部容器（供 UI 渲染 tab）。 */
export function gearContainers(gear) {
  return (gear.containers || []).slice();
}

/**
 * 统一转移入口：双栏搜刮 UI 的所有操作（双击 / Ctrl / Alt / 拖拽 / 丢弃前）
 * 都必须走这一个函数，保证规则只有一处，且失败完整回滚。
 *
 * @param {object} ctx { entity, gear }
 * @param {string} uid 物品 uid
 * @param {object} action 操作描述：
 *   { kind:'quickPickup' }                 来源→玩家（双击 / Ctrl+左键）
 *   { kind:'quickStore' }                  玩家→来源（Ctrl+左键反向）
 *   { kind:'equip', sid }                  装备到玩家槽（Alt+左键）
 *   { kind:'unequip', sid }                卸下槽位
 *   { kind:'move', toCid, x, y, rotated }  精确放置到某容器格位
 *   { kind:'rotate' }                      旋转
 *   { kind:'split', n }                    拆分堆叠
 *   { kind:'sort', cid }                   自动整理容器
 *   { kind:'takeAll', cid, atomic }        整包带走 / 全部拾取
 * @returns {{ok:boolean, reason:string, [k:string]:any}}
 */
export function transferItem(ctx, uid, action) {
  const { entity, gear } = ctx;
  const kind = action.kind;
  const fail = (reason) => ({ ok: false, reason });
  const ok = (extra = {}) => ({ ok: true, reason: FAILURE_REASONS.OK, ...extra });

  if (kind === 'quickPickup') return quickPickup(entity, gear, uid);
  if (kind === 'equip') {
    const found = findItemInEntity(entity, uid) || findGearItem(gear, uid);
    if (!found) return fail(FAILURE_REASONS.UNKNOWN);
    return equipIntoSlot(gear, action.sid, found.item, entity);
  }
  if (kind === 'unequip') return unequipSlot(gear, action.sid);
  if (kind === 'quickStore') {
    const found = findGearItem(gear, uid);
    if (!found) return fail(FAILURE_REASONS.UNKNOWN);
    return quickStoreToEntity(entity, gear, uid);
  }
  if (kind === 'move') {
    const target = allContainers(ctx).find((c) => c.cid === action.toCid);
    if (!target) return fail(FAILURE_REASONS.UNKNOWN);
    if (target.readonly) return fail(FAILURE_REASONS.CONTAINER_READONLY);
    return moveFromAnywhere(ctx, uid, target, action.x, action.y, action.rotated);
  }
  if (kind === 'rotate') {
    const target = findContainerOf(ctx, uid);
    if (!target) return fail(FAILURE_REASONS.UNKNOWN);
    const r = rotateItemIn(target, uid);
    return r.ok ? ok({ item: r.item }) : fail(r.reason);
  }
  if (kind === 'split') {
    const target = findContainerOf(ctx, uid);
    if (!target) return fail(FAILURE_REASONS.UNKNOWN);
    const r = splitStack(target, uid, action.n);
    return r.ok ? ok({ item: r.item }) : fail(r.reason);
  }
  if (kind === 'sort') {
    const target = allContainers(ctx).find((c) => c.cid === action.cid);
    if (!target) return fail(FAILURE_REASONS.UNKNOWN);
    const r = sortContainer(target, { rotate: action.rotate !== false });
    return r.ok ? ok() : fail(r.reason);
  }
  if (kind === 'takeAll') {
    return takeAllFromContainer(entity, gear, action.cid, { atomic: action.atomic !== false });
  }
  return fail(FAILURE_REASONS.UNKNOWN);
}

/** 在玩家 gear 里按 uid 找物品（槽位或容器）。 */
export function findGearItem(gear, uid) {
  for (const s of gear.slots || []) if (s.item && s.item.uid === uid) return { kind: 'slot', slot: s, item: s.item };
  for (const c of gear.containers || []) {
    const it = c.items.find((x) => x.uid === uid);
    if (it) return { kind: 'container', container: c, item: it };
  }
  return null;
}

/** 双栏里所有可放置的网格容器（来源 + 玩家）。 */
export function allContainers(ctx) {
  return [...entityContainers(ctx.entity), ...(ctx.gear.containers || [])];
}

/** 找到物品所在的网格容器（槽位物品返回 null）。 */
export function findContainerOf(ctx, uid) {
  for (const c of allContainers(ctx)) if (c.items.some((x) => x.uid === uid)) return c;
  return null;
}

/**
 * 从任意来源（实体槽 / 实体容器 / 玩家槽 / 玩家容器）把物品精确移动到目标容器格位。
 * 事务化：任何失败都整体回滚，绝不丢 / 复制。
 */
export function moveFromAnywhere(ctx, uid, target, x, y, rotated) {
  const { entity, gear } = ctx;
  const snap = snapshotTransfer(entity, gear);
  const srcEntity = findItemInEntity(entity, uid);
  const srcGear = srcEntity ? null : findGearItem(gear, uid);
  const item = srcEntity ? srcEntity.item : srcGear ? srcGear.item : null;
  if (!item) return { ok: false, reason: FAILURE_REASONS.UNKNOWN };
  if (item.locked) return { ok: false, reason: FAILURE_REASONS.ITEM_LOCKED };

  // 先摘除（转移语义，不重置坐标）
  if (srcEntity) removeFromEntity(entity, uid);
  else if (srcGear.kind === 'slot') srcGear.slot.item = null;
  else {
    const idx = srcGear.container.items.findIndex((it) => it.uid === uid);
    if (idx >= 0) srcGear.container.items.splice(idx, 1);
  }

  if (typeof rotated === 'boolean' && item.rotate) item.rotated = rotated;
  const res = placeItem(target, item, x, y);
  if (!res.ok) { restoreTransfer(snap); return res; }
  return { ok: true, reason: FAILURE_REASONS.OK, item };
}

/**
 * 玩家 → 来源容器的快速转移（双向搜刮必备）：优先堆叠，其次第一个空位，只读容器失败。
 */
export function quickStoreToEntity(entity, gear, uid) {
  const target = (entity.containers || [])[0];
  if (!target) return { ok: false, reason: FAILURE_REASONS.UNKNOWN };
  if (target.readonly) return { ok: false, reason: FAILURE_REASONS.CONTAINER_READONLY };
  const snap = snapshotTransfer(entity, gear);
  const found = findGearItem(gear, uid);
  if (!found || !found.item) return { ok: false, reason: FAILURE_REASONS.UNKNOWN };
  const item = found.item;
  if (item.locked) return { ok: false, reason: FAILURE_REASONS.ITEM_LOCKED };
  // 1. 优先堆叠
  const remain = mergeStacksInto([target], item);
  if (remain <= 0) {
    detachByUid(gear, null, uid);
    return { ok: true, reason: FAILURE_REASONS.OK, dest: { type: 'stack', cid: target.cid } };
  }
  item.qty = remain;
  // 2. 第一个合法空位
  if (found.kind === 'slot') found.slot.item = null;
  else {
    const idx = found.container.items.findIndex((it) => it.uid === uid);
    if (idx >= 0) found.container.items.splice(idx, 1);
  }
  const fit = findFirstFit(target, item, { rotate: true, ignoreUid: item.uid });
  if (!fit) { restoreTransfer(snap); return { ok: false, reason: FAILURE_REASONS.NOT_ENOUGH_SPACE }; }
  if (!target.items.includes(item)) target.items.push(item);
  return { ok: true, reason: FAILURE_REASONS.OK, dest: { type: 'container', cid: target.cid } };
}

/**
 * 背包满时给出可替换建议（不推荐锁定 / 任务 / 安全容器物品）。
 * @param {object} ctx { entity, gear }
 * @param {string} uid 想拾取的物品
 * @returns {{ok:boolean, reason:string, candidate?:object, text?:string}}
 */
export function suggestReplace(ctx, uid) {
  const found = findItemInEntity(ctx.entity, uid);
  if (!found) return { ok: false, reason: FAILURE_REASONS.UNKNOWN };
  const candidate = recommendDiscard(ctx.gear.containers[0]);
  if (!candidate) return { ok: false, reason: FAILURE_REASONS.NOT_ENOUGH_SPACE };
  return {
    ok: false,
    reason: FAILURE_REASONS.NOT_ENOUGH_SPACE,
    candidate,
    text: `空间不足。该物品单格价值 ${Math.round(valuePerCell(found.item))}，建议替换：${candidate.name}`,
  };
}

/**
 * 拖拽落点预判：UI 的绿色/红色预览必须复用 canPlace 同一套规则，
 * 不允许在 UI 里另写一份碰撞检测（否则"预览合法、放下失败"必然漂移）。
 * @returns {{ok:boolean, reason:string, x:number, y:number, w:number, h:number}}
 */
export function previewPlacement(ctx, uid, toCid, x, y, rotated) {
  const target = allContainers(ctx).find((c) => c.cid === toCid);
  if (!target) return { ok: false, reason: FAILURE_REASONS.UNKNOWN, x, y, w: 1, h: 1 };
  const srcEntity = findItemInEntity(ctx.entity, uid);
  const srcGear = srcEntity ? null : findGearItem(ctx.gear, uid);
  const item = srcEntity ? srcEntity.item : srcGear ? srcGear.item : null;
  if (!item) return { ok: false, reason: FAILURE_REASONS.UNKNOWN, x, y, w: 1, h: 1 };
  if (target.readonly) return { ok: false, reason: FAILURE_REASONS.CONTAINER_READONLY, x, y, w: itemW(item), h: itemH(item) };
  // 用一份临时副本试旋转，绝不改动真值
  const probe = { ...item, rotated: typeof rotated === 'boolean' && item.rotate ? rotated : item.rotated };
  const w = itemW(probe);
  const h = itemH(probe);
  if (x < 0 || y < 0 || x + w > target.cols || y + h > target.rows) {
    return { ok: false, reason: FAILURE_REASONS.OUT_OF_BOUNDS, x, y, w, h };
  }
  if (target.accepted && item.category && !target.accepted.includes(item.category)) {
    return { ok: false, reason: FAILURE_REASONS.SLOT_NOT_ALLOWED, x, y, w, h };
  }
  if (!canPlace(target, probe, x, y, uid)) {
    return { ok: false, reason: FAILURE_REASONS.OCCUPIED, x, y, w, h };
  }
  return { ok: true, reason: FAILURE_REASONS.OK, x, y, w, h };
}

/** 找出物品可装备的玩家空槽（Alt+左键用）。 */
export function findEquipSlot(gear, item) {
  if (!item) return null;
  for (const s of gear.slots || []) {
    if (s.item) continue;
    const okType = s.accepted
      && ((item.slots && item.slots.some((t) => s.accepted.includes(t))) || s.accepted.includes(item.category));
    if (okType) return s.type;
  }
  return null;
}

/** 失败原因 → 玩家提示（UI 直接读这里，避免两处文案漂移）。 */
export { REASON_TEXT };
