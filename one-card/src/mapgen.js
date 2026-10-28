// 地图生成（3 层 × 4 节点 = 12 节点）
// 口径：节点「类型」是固定骨架，只有「内容」由种子随机。
//      理由：D_min=12 是单局时长的推导基石，如果节点数随机，时长方差会失控 ——
//      在一个 12 分钟的产品里，方差是缺点不是惊喜。
// 骨架产出：战斗 6 + 荒野 1 + 精英 2 + 遗迹 1 + 灯下 1 + Boss 1 = 12
// 阶段 6：第 2 层第 1 个 battle 位换成 wild（荒野遭遇，实时割草小关）。
// 奖励节点仍为 9（6 battle + 1 wild + 2 elite）；总数恒为 12、Boss 恒最后。

import { CONST } from '../config/constants.js';
import { BY_TIER } from '../config/enemies.js';
import { EVENTS } from '../config/events.js';

// 骨架：battle / elite / event / rest / boss
export const FLOOR_SKELETON = [
  ['battle', 'battle', 'event', 'battle'],
  ['wild', 'elite', 'battle', 'rest'],
  ['battle', 'elite', 'battle', 'boss'],
];

export const NODE_META = {
  battle: { icon: '刃', label: '战斗', hint: '击败后可取一张牌' },
  elite: { icon: '精', label: '精英', hint: '强敌，遗物与牌都在这里' },
  event: { icon: '?', label: '遗迹', hint: '不明' },
  rest: { icon: '灯', label: '灯下', hint: '回复或精简牌组' },
  boss: { icon: '九', label: '守灯人', hint: '第九层的尽头' },
  // 阶段 6：荒野遭遇（实时小关）。用 --flux 紫与主色板区分，图标「荒」。
  wild: { icon: '荒', label: '荒野', hint: '实时遭遇 · 75 秒割草（可选）', color: 'flux' },
};

export function generateMap(rng, floor = CONST.FLOORS, opts = {}) {
  const nodes = [];
  // 一局只有 1 个主遗迹节点；但每层入口若选 alt 也会变成遗迹，最多再 2 个（FLOOR_SKELETON 第 0 格 battle→event）。
  // 因此抽 3 个，保证主事件节点与两个 alt 事件不撞同一张（机制批 P1-2：用同一个池、不能重复）。
  const events = rng.shuffled(EVENTS).slice(0, 3);
  // 普通敌人只洗一次牌：洗多次会导致 ni 递增但数组不同，出现重复敌人
  const normals = rng.shuffled(BY_TIER.normal);
  const elites = rng.shuffled(BY_TIER.elite);
  let eventIdx = 0;
  let uid = 1;
  // ni 在整局范围内递增：普通战斗消耗不同敌人原型，一局内不重复
  let ni = 0;
  // 精英池从 3 扩到 5 后，(f+i)%len 只会命中固定下标 —— 改成整局的独立递进，与普通敌人同构（内容批 P1-4）
  let ei = 0;

  for (let f = 0; f < floor; f++) {
    const row = FLOOR_SKELETON[f % FLOOR_SKELETON.length];

    for (let i = 0; i < row.length; i++) {
      const type = row[i];
      const node = { uid: uid++, floor: f + 1, index: i, type, done: false };
      if (type === 'battle') {
        node.enemyId = normals[ni % normals.length].id;
        ni++;
      } else if (type === 'elite') {
        node.enemyId = elites[ei++ % elites.length].id;
      } else if (type === 'boss') {
        // 内容批 P1-5：Boss 按「通关次数」轮换 —— 玩家每赢一次，下一世就换一个最终对手。
        const bossPool = BY_TIER.boss;
        node.enemyId = bossPool[Math.min(opts.wins || 0, bossPool.length - 1) % bossPool.length].id;
      } else if (type === 'event') {
        node.eventId = events[eventIdx % events.length].id;
        eventIdx++;
      }
      // 机制批 P1-2：每层入口二选一。节点总数仍是 12、Boss 仍是最后一个 —— 变的只是「这一层的第一个节点是什么」。
      if (i === 0) {
        const altType = type === 'battle' ? 'event' : 'battle';
        node.alt = altType === 'event'
          ? { type: 'event', eventId: events[eventIdx++ % events.length].id }
          : { type: 'battle', enemyId: normals[ni++ % normals.length].id };
      }
      nodes.push(node);
    }
  }
  return nodes;
}

/** 校验：地图必须是 12 个节点且包含 1 个 boss —— 单测会断言这条 */
export function validateMap(nodes) {
  const counts = { battle: 0, elite: 0, event: 0, rest: 0, boss: 0, wild: 0 };
  for (const n of nodes) counts[n.type] = (counts[n.type] || 0) + 1;
  return {
    counts,
    total: nodes.length,
    ok: nodes.length === CONST.FLOORS * CONST.NODES_PER_FLOOR && counts.boss === 1,
  };
}

export function nodeAt(nodes, uid) {
  return nodes.find((n) => n.uid === uid) || null;
}

export function nextNode(nodes) {
  return nodes.find((n) => !n.done) || null;
}
