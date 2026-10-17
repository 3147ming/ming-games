/**
 * 弹药"盒口径"回归测试。
 *
 * 背景（2026-10-17 修复）：库存 qty 存的是"发"（combat 换弹按发消耗），
 * 而 ITEMS.ammo*.weight / value 都是"盒"口径（一盒 = AMMO_STACK 发）。
 * 修复前所有展示/计价直接 qty×weight/value，导致一盒 5.56 按
 * 60.0kg / ¥36,000 计 —— 损失清单、物资总值、仓库估值被放大 60 倍，
 * 且玩家带弹部署就永久超重（179.7kg / 上限 23kg，禁跑+减速）。
 *
 * 本文件锁死：displayUnits 换算 + totalWeight/totalValue/Loot 三处计价
 * 一律走盒口径，非弹药物品行为不变。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ITEMS, AMMO_STACK, WEAPONS, ARMORS } from '../src/config.js';
import { createItem, displayUnits, totalWeight, totalValue, createInventory } from '../src/inventory.js';
import { valueOf, weightOf } from '../src/loot.js';
import { Player, buildLoadoutItems } from '../src/player.js';

/* ==================== displayUnits 换算 ==================== */

test('口径：整盒弹药 = 1 单位，半盒 = 0.5', () => {
  const box = createItem(ITEMS.ammo556, AMMO_STACK); // 一盒 60 发
  assert.equal(box.qty, AMMO_STACK, '库存里确实是"发"');
  assert.equal(displayUnits(box), 1, '整盒必须换算成 1 盒');

  const half = createItem(ITEMS.ammo556, 30); // 半盒
  assert.equal(displayUnits(half), 0.5);

  const nine = createItem(ITEMS.ammo9mm, 45);
  assert.equal(displayUnits(nine), 0.75);
});

test('口径：非弹药物品 qty 即单位数（行为不变）', () => {
  const kit = createItem(ITEMS.medkit, 1);
  assert.equal(displayUnits(kit), 1);
  // chip 不可堆叠（stack=1），createItem 会把 qty 裁到 1
  const chip = createItem(ITEMS.chip, 3);
  assert.equal(chip.qty, 1);
  assert.equal(displayUnits(chip), 1);
  // 假想可堆叠非弹药（未来的材料堆）：qty 直接为单位数，不走盒换算
  assert.equal(displayUnits({ category: 'material', qty: 7, stack: 20 }), 7);
  // 极端防御：stack=1 的"弹药"按 qty 计，不会除出小数
  assert.equal(displayUnits({ category: 'ammo', qty: 4, stack: 1 }), 4);
});

/* ==================== 计价 / 计重 ==================== */

test('计价：一盒 5.56 = 1.0kg / ¥600（不再是 60kg / ¥36,000）', () => {
  const inv = createInventory(5, 6);
  inv.items.push(createItem(ITEMS.ammo556, AMMO_STACK));
  assert.equal(totalWeight(inv), 1.0, '盒重 × 盒数');
  assert.equal(totalValue(inv), 600, '盒价 × 盒数');
  assert.equal(valueOf(inv.items), 600);
  assert.equal(weightOf(inv.items), 1.0);
});

test('计价：两盒 5.56 + 一盒 9mm = 2.8kg / ¥1,620', () => {
  const inv = createInventory(5, 6);
  inv.items.push(createItem(ITEMS.ammo556, AMMO_STACK));
  inv.items.push(createItem(ITEMS.ammo556, AMMO_STACK));
  inv.items.push(createItem(ITEMS.ammo9mm, AMMO_STACK));
  assert.equal(totalWeight(inv), 2.8);
  assert.equal(totalValue(inv), 600 * 2 + 420);
  assert.equal(valueOf(inv.items), 600 * 2 + 420);
});

test('计价：半盒按比例计（0.5kg / ¥300）', () => {
  const inv = createInventory(5, 6);
  inv.items.push(createItem(ITEMS.ammo556, 30));
  assert.equal(totalWeight(inv), 0.5);
  assert.equal(totalValue(inv), 300);
  assert.equal(valueOf(inv.items), 300);
});

/* ==================== 端到端：负重不再被弹药撑爆 ==================== */

test('端到端：带 2 盒 5.56 + 1 盒 9mm 部署不超重（修复前 179.7kg）', () => {
  const items = buildLoadoutItems({ ammo556Boxes: 2, ammo9mmBoxes: 1, medkits: 2, bandages: 1 });
  const p = new Player({
    x: 0, y: 0,
    weaponDefs: [WEAPONS.rifle, WEAPONS.pistol],
    armorDef: ARMORS.lv2,
    items,
  });
  assert.equal(p.weight, 14.5, '弹药按盒计重后的总负重');
  assert.ok(p.weight <= p.weightLimit, '不得超重（否则禁跑+减速，冲刺类玩法全部失效）');
});

test('端到端：发射耗弹后负重随之下降（按发消耗、按盒计重）', () => {
  const items = buildLoadoutItems({ ammo556Boxes: 1, ammo9mmBoxes: 0, medkits: 0, bandages: 0 });
  const p = new Player({ x: 0, y: 0, weaponDefs: [WEAPONS.pistol], items });
  const before = p.weight;
  p.consumeReserve('ammo556', 30); // 打掉半盒
  assert.equal(p.weight, Math.round((before - 0.5) * 10) / 10, '半盒 5.56 = 0.5kg');
});
