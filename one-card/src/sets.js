// 遗物套装（Set）——纯逻辑，不碰 DOM、不碰 localStorage、不自行改 Run。
// 口径：
//   ① 套装只是「一类遗物的标签 + 两档门槛」，不新增遗物实体；件数永远从 run.relicIds 现算，
//      所以旧存档（只存 id 列表）不需要迁移。
//   ② 2 件与 3 件**互斥**，不是叠加。理由：如果 3 件 = 2 件效果 + 第三个效果，
//      那「集齐 3 件」就退化成「数值又大了一点」，与项目一直反对的纯数值成长同构；
//      互斥之后，3 件是一套**换规则**的玩法（见各套 three），玩家冲 3 件的动机才是质变。
//   ③ 件数按「去重后的遗物 id」计。存档理论上不该重复，但坏档/旧实验数据可能重复；
//      一件遗物在背包里就是一件，重复 id 不能算两件，否则套装会被存档脏数据白送。

import { RELIC_MAP } from '../config/relics.js';

/**
 * 四套遗物，每套恰好 3 件（成员由 config/relics.js 的 set 字段反向确定）。
 *
 * 字段约定：
 *   id / name / desc        —— 套装身份与一句气质描述
 *   two / three             —— 两个门槛档位，各含 text（给玩家看）与 effect 数据
 *   two/three.hooks         —— 复用遗物钩子 DSL，由 Combat.fire 一并执行
 *   two/three.trigger       —— 需要战斗循环额外判定的触发器（目前只有「每回合首次攻击」）
 *   two/three.flags         —— 需要改战斗/局外规则的开关（中毒不衰减、格挡保留、额外奖励）
 *
 * 为什么把效果写成数据而不是函数：sets.js 要能在 node --test 里被直接断言，
 * 也让 UI 能原样展示「当前生效的是哪一档」，效果与文案永远同源。
 */
export const SET_DEFS = [
  {
    id: 'bing',
    name: '兵家',
    desc: '以命换势。断刃、苦修、髓晶，都是把赌注押在力量上的人留下的东西。',
    two: {
      text: '战斗开始时，额外获得 1 层力量。',
      hooks: { combatStart: [{ op: 'status', status: 'str', value: 1, who: 'self' }] },
    },
    three: {
      text: '每回合首次打出攻击牌时，抽 1 张牌并获得 1 点能量。',
      // 质变点：把「堆力量」的线性收益改成「每回合多一次出牌机会」，
      // 让兵家从「数值更大」变成「一回合能多做一件事」。
      trigger: { when: 'firstAttackEachTurn', ops: [{ op: 'draw', value: 1 }, { op: 'energy', value: 1 }] },
    },
  },
  {
    id: 'fang',
    name: '方士',
    desc: '以毒养身。骨钉、蚀纹、合唱，走的是让敌人在时间里慢慢烂掉的路子。',
    two: {
      text: '战斗开始时，敌人额外获得 2 层中毒。',
      hooks: { combatStart: [{ op: 'status', status: 'poison', value: 2, who: 'enemy' }] },
    },
    three: {
      text: '敌人身上的中毒不再随时间衰减（层数只增不减）。',
      // 质变点：默认中毒每回合 -2（POISON_DECAY），这套把「一次性爆发」改成「永久债」。
      // 不是加毒层数，而是改中毒的结算规则。
      flags: { poisonNoDecay: true },
    },
  },
  {
    id: 'jiang',
    name: '匠作',
    desc: '以守为攻。石心、铁环、齿轮，把每一回合的余力都留在身上。',
    two: {
      text: '战斗开始时，获得 1 层灵巧。',
      hooks: { combatStart: [{ op: 'status', status: 'dex', value: 1, who: 'self' }] },
    },
    three: {
      text: '回合开始时不再清空格挡，而是保留当前格挡的一半（向下取整）。',
      // 质变点：默认格挡每回合清零，这套把「当回合防御」改成「跨回合滚雪球」。
      flags: { blockRetainRatio: 0.5 },
    },
  },
  {
    id: 'shang',
    name: '商贾',
    desc: '以物生财。双生、火绒、空壳，先手越多，能换到的东西越多。',
    two: {
      text: '战斗开始时，额外抽 1 张牌。',
      hooks: { combatStart: [{ op: 'draw', value: 1 }] },
    },
    three: {
      text: '每场战斗胜利后，额外获得一次卡牌三选一（可跳过）。',
      // 质变点：改的是「一局能拿几张牌」的流程，不是战斗内数值。
      // 由 Run.resolveCombat / Run.takeReward 消费，见 run.js 的 pendingExtraReward。
      flags: { extraCombatReward: true },
    },
  },
];

const SET_MAP = Object.fromEntries(SET_DEFS.map((s) => [s.id, s]));

/**
 * 统计每个套装的当前件数。
 * 返回对象始终包含 SET_DEFS 里的全部 id（0 件也列出），UI 不必自己补零。
 * 未定义的套装 id、散件遗物、空数组都安全忽略 —— 读档永远不能让页面白屏。
 */
export function countSets(relicIds = []) {
  const counts = Object.fromEntries(SET_DEFS.map((s) => [s.id, 0]));
  // 不是数组（坏档 / 调用方传错）时直接返回全 0，而不是让 for...of 抛异常。
  if (!Array.isArray(relicIds)) return counts;
  const seen = new Set();
  for (const id of relicIds) {
    if (seen.has(id)) continue;          // 去重：一件遗物只算一件（见文件头 ③）
    seen.add(id);
    const relic = RELIC_MAP[id];
    // 散件（relic.set 缺失）和未知套装 id 都不计入任何套装
    if (!relic || !relic.set || !SET_MAP[relic.set]) continue;
    counts[relic.set] += 1;
  }
  return counts;
}

/**
 * 当前生效的套装加成列表。
 * **每个套装至多一条**：≥3 件只返回 3 件档，恰好 2 件返回 2 件档。
 * 这就是「2 件/3 件互斥」的唯一实现点 —— UI 与战斗都只消费这个列表，
 * 不存在「某处又偷偷把 2 件效果补上」的可能。
 */
export function activeBonuses(relicIds = []) {
  const counts = countSets(relicIds);
  const out = [];
  for (const def of SET_DEFS) {
    const n = counts[def.id];
    if (n >= 3) {
      out.push({
        setId: def.id,
        name: def.name,
        tier: 3,
        count: n,
        text: def.three.text,
        effect: def.three,
      });
    } else if (n === 2) {
      out.push({
        setId: def.id,
        name: def.name,
        tier: 2,
        count: n,
        text: def.two.text,
        effect: def.two,
      });
    }
  }
  return out;
}
