/**
 * 长期进度系统回归测试：每日任务 / 成就 / 天赋 / 剧情。
 *
 * 四个模块都是纯数据（不碰 DOM），可在 Node 下直接 import。
 * 重点锁两件最容易出错的事：
 *   1. 幂等 —— 货币与阶段只能发一次（重开旧存档 / 重复结算不能刷钱）；
 *   2. 门槛 —— 点数不足、前置未学、任务未达标时一律不给。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ITEMS, SHOP, WEAPONS } from '../src/config.js';
import { buildPlayerMods, equippedAttachmentIds, ATTACH_SLOTS } from '../src/attachments.js';
import { refreshDaily, bumpDaily, claimDaily, dailyTaskDone, pickDaily, newDaily } from '../src/daily.js';
import { syncAchievements, latestTitle, ACHIEVEMENTS } from '../src/achievements.js';
import { grantXp, learnNode, canLearn, buildPerks, xpForLevel, ALL_NODE_IDS } from '../src/perks.js';
import { advanceStory, checkStoryProgress, currentStage, STORY_STAGES } from '../src/story.js';

/** 造一份最小存档（只含进度系统要用的字段） */
function mkSave(over = {}) {
  return {
    currency: 0,
    stats: { raids: 0, extracts: 0, deaths: 0, kills: 0, bestScore: 0, bestValue: 0, bossKills: 0 },
    codex: { items: [], enemies: [] },
    ach: { ids: [], paid: [] },
    daily: { date: '', tasks: [], progress: {}, claimed: [] },
    tree: { xp: 0, level: 1, points: 0, nodes: [] },
    story: { stage: 0, done: [] },
    ...over,
  };
}

/* ==================== 每日任务 ==================== */

test('每日任务：同一天结果稳定，跨天才刷新', () => {
  const a = pickDaily('2026-10-17');
  const b = pickDaily('2026-10-17');
  assert.deepEqual(a.map((t) => t.id), b.map((t) => t.id), '同一天必须抽到同一组');
  assert.equal(a.length, 3);

  const s = mkSave();
  assert.equal(refreshDaily(s, '2026-10-17'), true, '首次初始化应刷新');
  bumpDaily(s, 'kills', 2);
  assert.equal(s.daily.progress.kills, 2);
  assert.equal(refreshDaily(s, '2026-10-17'), false, '同一天不得重置进度');
  assert.equal(s.daily.progress.kills, 2, '同天刷新后进度必须保留');
  assert.equal(refreshDaily(s, '2026-10-18'), true, '跨天应刷新');
  assert.equal(s.daily.progress.kills, 0, '跨天后进度清零');
});

test('每日任务：计数型累加、数值型取最大值', () => {
  const s = mkSave({ daily: newDaily('2026-10-17') });
  bumpDaily(s, 'kills', 3);
  bumpDaily(s, 'kills', 2);
  assert.equal(s.daily.progress.kills, 5);
  bumpDaily(s, 'value', 8000);
  bumpDaily(s, 'value', 3000);
  assert.equal(s.daily.progress.value, 8000, '带出估值应保留历史最好一局，不能被差的一局拉低');
});

test('每日任务：未达标领不到，达标只能领一次', () => {
  const s = mkSave({ daily: newDaily('2026-10-17') });
  const task = s.daily.tasks[0];
  assert.equal(claimDaily(s, task.id), 0, '未达标时不得发放');
  assert.equal(s.currency, 0);

  bumpDaily(s, task.type, task.target);
  assert.ok(dailyTaskDone(task, s.daily.progress));
  assert.equal(claimDaily(s, task.id), task.reward);
  assert.equal(s.currency, task.reward);
  assert.equal(claimDaily(s, task.id), 0, '同一任务不得重复领取');
  assert.equal(s.currency, task.reward, '重复领取不得加钱');
});

/* ==================== 成就 ==================== */

test('成就：达标即解锁并发钱，重复结算不刷钱', () => {
  const s = mkSave();
  s.stats.kills = 1;
  const first = syncAchievements(s);
  const gotIds = first.unlocked.map((a) => a.id);
  assert.ok(gotIds.includes('first_kill'), '1 杀应解锁「首杀」');
  assert.ok(first.rewards > 0);
  assert.equal(s.currency, first.rewards);

  const moneyAfter = s.currency;
  const second = syncAchievements(s);
  assert.deepEqual(second.unlocked, [], '第二次不应有新解锁');
  assert.equal(second.rewards, 0, '第二次不得再发钱');
  assert.equal(s.currency, moneyAfter);
});

test('成就：已解锁但尚未发钱的旧存档会补发一次', () => {
  const s = mkSave();
  s.stats.kills = 1;
  const r1 = syncAchievements(s);
  // 模拟旧存档：解锁记录丢了 paid（例如中途断电写档不全）
  s.ach.paid = [];
  const base = s.currency;
  const r2 = syncAchievements(s);
  assert.equal(r2.unlocked.length, 0, '已解锁的成就不得重复弹解锁');
  assert.equal(r2.rewards, base, '应补发漏掉的货币');
  assert.equal(s.currency, base * 2);
  const r3 = syncAchievements(s);
  assert.equal(r3.rewards, 0, '补发一次后不得再补');
});

test('成就：check 抛错不影响其它成就结算', () => {
  const s = mkSave();
  s.stats = {}; // 故意缺字段，让 check 读 s.stats.bossKills 之类时炸掉
  delete s.codex;
  const r = syncAchievements(s);
  assert.ok(Array.isArray(r.unlocked), '缺字段时也要能跑完，不能整局结算崩溃');
});

test('成就：称号取最新解锁的那一个', () => {
  const s = mkSave();
  assert.equal(latestTitle(s), null);
  s.stats.kills = 50;
  s.stats.extracts = 10;
  syncAchievements(s);
  const t = latestTitle(s);
  assert.ok(t, '应有称号');
  const titled = ACHIEVEMENTS.filter((a) => a.title);
  assert.ok(titled.some((a) => a.title === t));
});

/* ==================== 天赋 ==================== */

test('天赋：经验够就升级给点，可连升多级', () => {
  const s = mkSave();
  assert.equal(grantXp(s, xpForLevel(1) - 1), 0, '差一点经验不应升级');
  assert.equal(s.tree.level, 1);
  assert.equal(grantXp(s, 1), 1);
  assert.equal(s.tree.level, 2);
  assert.equal(s.tree.points, 1);

  const s2 = mkSave();
  const need = xpForLevel(1) + xpForLevel(2);
  assert.equal(grantXp(s2, need), 2, '一次结算可连升两级');
  assert.equal(s2.tree.level, 3);
  assert.equal(s2.tree.points, 2);
});

test('天赋：点数不足 / 重复学习 / 前置未学都拦得住', () => {
  const s = mkSave();
  assert.equal(canLearn(s, 'hp').ok, false, '0 点时不得学习');
  assert.equal(canLearn(s, 'nope').ok, false, '不存在的节点不得学习');

  s.tree.points = 2;
  assert.equal(learnNode(s, 'weight'), false, '同支前置未学时不得跳过');
  assert.match(canLearn(s, 'weight').reason, /前置|前一个/);

  assert.equal(learnNode(s, 'hp'), true);
  assert.equal(s.tree.points, 1);
  assert.equal(learnNode(s, 'hp'), false, '不得重复学习');
  assert.equal(s.tree.points, 1, '失败的学习不得扣点');
});

test('天赋：buildPerks 汇总已学节点加成', () => {
  const p = buildPerks(['hp', 'recoil', 'ammo']);
  assert.equal(p.hp, 15);
  assert.equal(p.recoil, 0.15);
  assert.equal(p.ammo, 30);
  assert.equal(p.weight, 0, '未学的节点必须是 0，不能污染 baseline');
  assert.deepEqual(Object.keys(buildPerks([])).length, 9);
  assert.equal(ALL_NODE_IDS.length, 9, '三分支共 9 个节点');
});

/* ==================== 剧情 ==================== */

test('剧情：达标才推进，奖励只发一次', () => {
  const s = mkSave();
  assert.equal(checkStoryProgress(s), null, '0 撤离时第一章也不该达成');
  assert.equal(currentStage(s).id, 's1');

  s.stats.extracts = 1;
  const done = advanceStory(s);
  assert.equal(done.length, 1);
  assert.equal(done[0].id, 's1');
  assert.equal(s.story.stage, 1);
  assert.equal(s.currency, STORY_STAGES[0].reward);

  const money1 = s.currency;
  assert.deepEqual(advanceStory(s), [], '条件没继续变化时不该重复推进');
  assert.equal(s.currency, money1);
});

test('剧情：一局可能连过两章，且不会越过未达成的章节', () => {
  const s = mkSave();
  s.stats.extracts = 3; // 满足 s1(1) 与 s2(3)，但 s3 还要 15 杀
  const done = advanceStory(s);
  assert.deepEqual(done.map((d) => d.id), ['s1', 's2']);
  assert.equal(s.story.stage, 2);
  assert.equal(s.currency, STORY_STAGES[0].reward + STORY_STAGES[1].reward);
});

test('剧情：缺 bossKills 字段的旧存档不应崩溃', () => {
  const s = mkSave();
  delete s.stats.bossKills;
  s.stats.extracts = 99;
  s.stats.kills = 99;
  const done = advanceStory(s);
  const bossIdx = STORY_STAGES.findIndex((st) => st.req.bossKills);
  assert.equal(done.length, bossIdx, '缺字段也要按已有条件推进');
  assert.equal(s.story.stage, bossIdx, '需要 Boss 击杀的那章不得在缺字段时被误判达成');
  assert.equal(currentStage(s).id, STORY_STAGES[bossIdx].id);
});

/* ==================== 武器配件 ==================== */

test('配件：六件三类齐全，商店在售且补货不断供', () => {
  assert.deepEqual(ATTACH_SLOTS, ['muzzle', 'sight', 'grip']);
  const ids = ['muzzle_comp', 'muzzle_sil', 'sight_holo', 'sight_scope', 'grip_vert', 'grip_angle'];
  for (const id of ids) {
    const def = ITEMS[id];
    assert.ok(def, `${id} 必须存在`);
    assert.equal(def.category, 'attachment');
    assert.ok(ATTACH_SLOTS.includes(def.slot), `${id} 的 slot 必须合法`);
    assert.ok(def.mods && Object.keys(def.mods).length, `${id} 必须带 mods`);
    assert.ok(SHOP.items.includes(id), `${id} 必须上架`);
    assert.ok((SHOP.restock[id] || 0) > 0, `${id} 必须补货`);
  }
  // 每类槽位各两件，玩家有得选
  for (const slot of ATTACH_SLOTS) {
    assert.equal(ids.filter((id) => ITEMS[id].slot === slot).length, 2, `${slot} 槽应有两件`);
  }
});

test('配件：同武器三槽同名项相加，换算成乘数', () => {
  const attach = {
    primary: { muzzle: 'muzzle_comp', grip: 'grip_vert' }, // recoil -0.2 + -0.15 = -0.35
    secondary: {},
  };
  const mods = buildPlayerMods(attach, [WEAPONS.rifle, WEAPONS.pistol]);
  assert.equal(mods.rifle.recoilMul, 0.65, '制退器 + 垂直握把的后坐加成应相加');
  assert.equal(mods.rifle.spreadMul, 0.9, '制退器的 spread -0.1');
  assert.equal(mods.rifle.spreadPerShotMul, 0.75, '垂直握把的 spreadPerShot -0.25');
  assert.equal(mods.pistol, undefined, '副武器没装配件时不该有乘数表');
});

test('配件：手枪归副武器槽，其余归主武器槽', () => {
  const attach = {
    primary: { grip: 'grip_angle' },
    secondary: { grip: 'grip_vert' },
  };
  const mods = buildPlayerMods(attach, [WEAPONS.rifle, WEAPONS.smg, WEAPONS.pistol]);
  assert.equal(mods.rifle.reloadMul, 0.9, '步枪吃主武器槽的直角握把');
  assert.equal(mods.smg.reloadMul, 0.9, '冲锋枪同样归主武器槽');
  assert.equal(mods.pistol.spreadPerShotMul, 0.75, '手枪吃副武器槽的垂直握把');
  assert.equal(mods.pistol.reloadMul, undefined);
});

test('配件：脏存档里的非法 id 被静默忽略', () => {
  const attach = {
    primary: { muzzle: 'medkit', sight: 'rifle', grip: 'grip_vert' }, // 只有握把合法
    secondary: { muzzle: 'muzzle_sil' },
  };
  const mods = buildPlayerMods(attach, [WEAPONS.rifle, WEAPONS.pistol]);
  assert.equal(mods.rifle.spreadPerShotMul, 0.75, '合法的那件照常生效');
  assert.equal(mods.rifle.recoilMul, 0.85, 'recoil 只算垂直握把的 -0.15；消耗品 / 武器不得变成 mods');
  assert.equal(mods.pistol.noiseMul, 0.4, '消音器降噪 60%');
  assert.equal(mods.pistol.damageMul, 0.95, '消音器伤害 -5%');
  assert.equal(mods.pistol.recoilMul, undefined, '消音器不带后坐 mods，不该凭空出现乘数');
  assert.deepEqual(buildPlayerMods(null, [WEAPONS.rifle]), {}, 'attach 为空时返回空表');
  assert.deepEqual(buildPlayerMods({}, []), {}, '没有武器时返回空表');
});

test('配件：equippedAttachmentIds 只收合法配件', () => {
  assert.deepEqual(equippedAttachmentIds(null), []);
  assert.deepEqual(equippedAttachmentIds({ primary: { muzzle: 'pistol' }, secondary: {} }), [],
    '武器 id 不是配件，不得被消耗');
  assert.deepEqual(
    equippedAttachmentIds({ primary: { muzzle: 'muzzle_comp', grip: 'grip_vert' }, secondary: { sight: 'sight_holo' } }),
    ['muzzle_comp', 'grip_vert', 'sight_holo'],
  );
});
