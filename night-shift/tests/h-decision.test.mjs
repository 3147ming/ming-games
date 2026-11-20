/**
 * 任务块 H · 夜班便利店决策 / 通知 / 事件 / 存档单测
 * 运行：node --test night-shift/tests/h-decision.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TASK_TYPES, taskScore, rankTasks, fatigueFactor, shouldRest,
  learnPreference, rankSkuWithPreference, createTaskLocks, assignTasks,
} from '../src/staff-decision.mjs';
import {
  createNotifyCenter, LEVEL, FILTER,
} from '../src/notify-center.mjs';
import {
  SHIFT_EVENTS, createEventMachine, applyEffects, nextDayForecast,
  settleShift, migrateSave, createShiftStore, SAVE_VERSION,
} from '../src/shift-events.mjs';

/* ---------------- ① 店员决策 ---------------- */

test('缺货 SKU 的补货任务优先于货架偏低但未缺货', () => {
  const tasks = [
    { id: 'r-low', type: TASK_TYPES.RESTOCK, stockout: false, ratio: 0.2 },
    { id: 'r-out', type: TASK_TYPES.RESTOCK, stockout: true, ratio: 0.1 },
    { id: 'checkout', type: TASK_TYPES.CHECKOUT, hasCustomer: true },
  ];
  assert.equal(rankTasks(tasks)[0].id, 'r-out');
  assert.ok(taskScore(tasks[1]) > taskScore(tasks[0]));
});

test('爆款偏好优先：常卖 SKU 排前，但缺货流失信号仍压过偏好', () => {
  const skus = [{ id: 'drink' }, { id: 'noodle' }, { id: 'bento' }];
  const pref = { topSkuIds: ['drink'], slotBySku: { drink: 'A1' } };
  const out = rankSkuWithPreference(skus,
    { missed: {}, sold: { noodle: 2, bento: 1 }, shelfQty: {} }, pref);
  assert.equal(out[0].id, 'drink', '常卖品在同等信号下优先');
  const out2 = rankSkuWithPreference(skus,
    { missed: { bento: 5 }, sold: {}, shelfQty: {} }, pref);
  assert.equal(out2[0].id, 'bento', '缺货流失 5 件压过偏好');
});

test('多任务抢占：同一任务只会被一个店员接走，锁不重复', () => {
  const locks = createTaskLocks();
  const staff = [{ id: 'a', workSec: 0 }, { id: 'b', workSec: 0 }];
  const tasks = [{ id: 't1', type: TASK_TYPES.RESTOCK, stockout: true, ratio: 0.1 }];
  const r = assignTasks(staff, tasks, { locks });
  assert.equal(r.assignments.length, 1);
  assert.deepEqual(r.idle, ['b']);
  assert.equal(locks.ownerOf('t1'), 'a');
  assert.equal(locks.snapshot().t1, 'a');
  assert.equal(locks.release('t1', 'b'), false);
  assert.deepEqual(locks.releaseByStaff('a'), ['t1']);
});

test('疲惫降效：90s 起下降，180s 到 80%，休息 20s 恢复', () => {
  assert.equal(fatigueFactor(0), 1);
  assert.equal(fatigueFactor(90), 1);
  assert.ok(fatigueFactor(100) < 1 && fatigueFactor(100) > 0.8);
  assert.equal(fatigueFactor(180), 0.8);
  assert.equal(fatigueFactor(9999), 0.8);
  assert.equal(fatigueFactor(180, 20), 1);
  assert.equal(shouldRest(180, 0), true);
  const r = assignTasks([{ id: 'tired', workSec: 180, restSec: 0, pos: { x: 1, y: 2 } }], [], {});
  assert.equal(r.assignments[0].bubble, '休息中');
});

test('无客巡逻：有客先收银，无客才巡逻；可见气泡与路径齐全', () => {
  const withCustomer = rankTasks([
    { id: 'p', type: TASK_TYPES.PATROL },
    { id: 'c', type: TASK_TYPES.CHECKOUT, hasCustomer: true },
  ]);
  assert.equal(withCustomer[0].id, 'c');
  const noCustomer = rankTasks([
    { id: 'p', type: TASK_TYPES.PATROL, hasCustomer: false },
    { id: 'c', type: TASK_TYPES.CHECKOUT, hasCustomer: false },
  ]);
  assert.equal(noCustomer[0].id, 'p');
  const r = assignTasks(
    [{ id: 's1', pos: { x: 0, y: 0 } }],
    [{ id: 'p', type: TASK_TYPES.PATROL, target: { x: 4, y: 5 } }], {});
  assert.equal(r.assignments[0].bubble, '巡逻中');
  assert.deepEqual(r.assignments[0].path, [[0, 0], [4, 5]]);
});

test('偏好学习记录常卖 SKU 与常放位置', () => {
  const p = learnPreference([
    { skuId: 'noodle', slotId: 'A1' }, { skuId: 'noodle', slotId: 'A1' },
    { skuId: 'drink', slotId: 'B2' },
  ]);
  assert.deepEqual(p.topSkuIds, ['noodle', 'drink']);
  assert.equal(p.slotBySku.noodle, 'A1');
});

/* ---------------- ② 弹窗中心 ---------------- */

test('连发 10 条只显示 2 条 + 折叠 +8', () => {
  const nc = createNotifyCenter();
  for (let i = 0; i < 10; i++) nc.push({ text: `第${i}条` });
  let s = nc.snapshot();
  assert.equal(s.visible.length, 2);
  assert.equal(s.hidden, 8);
  assert.equal(s.collapsedLabel, '+8');
  nc.expand();
  s = nc.snapshot();
  assert.equal(s.visible.length, 10);
  assert.equal(s.collapsedLabel, '');
});

test('三级过滤与紧急最多 1 条', () => {
  const nc = createNotifyCenter();
  for (let i = 0; i < 5; i++) nc.push({ text: '普通' + i, level: LEVEL.NORMAL });
  nc.push({ text: '紧急A', level: LEVEL.URGENT });
  nc.push({ text: '紧急B', level: LEVEL.URGENT });
  let s = nc.snapshot();
  assert.equal(s.urgentCount, 1, '同屏紧急最多 1 条');
  assert.equal(s.visible[0].text, '紧急B', '新紧急顶掉旧紧急');
  assert.equal(s.visible[0].level, LEVEL.URGENT);
  nc.setFilter(FILTER.IMPORTANT);
  s = nc.snapshot();
  assert.ok(s.visible.every((n) => n.level !== LEVEL.NORMAL));
  nc.setFilter(FILTER.OFF);
  assert.equal(nc.snapshot().total, 0);
  nc.setFilter(FILTER.ALL);
});

test('过期自动移除，id 相同不堆叠', () => {
  const nc = createNotifyCenter();
  nc.push({ id: 'x', text: '补货完成', ttl: 1 });
  nc.push({ id: 'x', text: '补货完成' });
  assert.equal(nc.snapshot().total, 1);
  nc.tick(4); // 覆盖后的消息重置 age，等默认 ttl(3.2s) 过去才移除
  assert.equal(nc.snapshot().total, 0);
});

/* ---------------- ③ 事件三段流程 ---------------- */

for (const id of Object.keys(SHIFT_EVENTS)) {
  test(`事件 ${id} 跑通预警→窗口→结果（成功与失败各一次）`, () => {
    const phases = [];
    const em = createEventMachine({ onEvent: (t, p) => t === 'phase' && phases.push(p.phase) });
    assert.equal(em.start(id, 0).phase, 'warning');
    em.tick(SHIFT_EVENTS[id].warnSec + 0.1, 5);
    assert.equal(em.snapshot().phase, 'window');
    assert.equal(em.handle(true).success, true);
    assert.equal(em.snapshot().phase, 'result');
    assert.deepEqual(phases, ['warning', 'window', 'result']);

    const em2 = createEventMachine();
    em2.start(id, 0);
    em2.tick(SHIFT_EVENTS[id].warnSec + 0.1, 5);
    em2.tick(SHIFT_EVENTS[id].windowSec + 0.1, 15);
    assert.equal(em2.snapshot().result.success, false, '超时按失败结算');
  });
}

test('四种事件失败后果符合指令', () => {
  const cases = [
    ['drunk', 'reputation', -1], ['drunk', 'shelfDamage', 1],
    ['theft', 'cash', -20], ['blackout', 'customersLost', 3],
    ['inspection', 'cash', -30],
  ];
  for (const [id, field, delta] of cases) {
    assert.equal(SHIFT_EVENTS[id].fail.effects[field], delta, `${id}.${field}`);
  }
  const s = applyEffects({ cash: 100, reputation: 50 }, SHIFT_EVENTS.theft.fail.effects);
  assert.equal(s.cash, 80);
});

/* ---------------- ④ 结算与存档 ---------------- */

test('打烊结算含次日客流预估，口碑越好预估越高', () => {
  const base = settleShift({ revenue: 200, costs: 80, visitors: 20, reputation: 50, events: [] });
  const good = settleShift({ revenue: 200, costs: 80, visitors: 20, reputation: 90, events: [] });
  assert.equal(base.profit, 120);
  assert.ok(good.forecast > base.forecast);
  assert.equal(base.version, SAVE_VERSION);
  assert.equal(base.forecast, nextDayForecast({ visitorsToday: 20, reputation: 50 }));
});

test('单 key 存档 + v1 版本号迁移', () => {
  const mem = new Map();
  const storage = {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => mem.set(k, v),
    removeItem: (k) => mem.delete(k),
  };
  const store = createShiftStore(storage, 'test.shift.v2');
  store.save({
    version: 1, revenue: 88, fame: 60,
    clerkStaff: [{ type: 'stocker', stamina: 40 }],
    unlocks: { toy: true },
  });
  assert.equal(mem.size, 1, '只写一个 key');
  const data = store.load();
  assert.equal(data.version, SAVE_VERSION);
  assert.equal(data.revenue, 88);
  assert.equal(data.reputation, 60);
  assert.equal(data.staff[0].type, 'stocker');
  const patched = store.patch((d) => ({ ...d, revenue: d.revenue + 12 }));
  assert.equal(patched.revenue, 100);
  assert.equal(store.load().revenue, 100);
  store.reset();
  assert.equal(store.load(), null);
});

test('migrateSave 容忍空值与脏数据', () => {
  const d = migrateSave({ revenue: 'abc', reputation: null, version: 0 });
  assert.equal(d.revenue, 0);
  assert.equal(d.reputation, 50);
  assert.equal(d.version, SAVE_VERSION);
  assert.equal(d.migratedFrom, 0);
});
