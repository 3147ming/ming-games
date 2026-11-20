/**
 * 战利品交互的纯数据层（零 DOM / 零 three / 零随机）。
 *
 * 为什么单独成模块：
 *   - 「普通物资秒开 / 保险箱读条」是一条判定，却被 player(交互)、world(回调)、
 *     ui(提示)、main(开面板) 四处各写一份，改一处漏三处。这里做唯一真值。
 *   - 「多个盒子堆叠」需要一个稳定的目标列表 + 游标，HUD 显示和 E 键确认必须读
 *     同一份，否则玩家看到高亮 A 却搜了 B。
 *   - 地面散落物聚合成一个「散落物堆」容器，也是纯数据变换，塞进 player 不好测。
 *
 * 交互优先级（与 player.interact / HUD 提示共用一个真值）：
 *   终端 > 撤离 > 交互目标（容器 / 散落物堆）
 */

import { CONTAINERS } from './config.js';

/**
 * 哪些容器必须读条 + 特殊解锁界面。
 * 用户口径：除了「重要物资（保险箱这类有特殊解锁界面的）」，其它普通物资直接打开。
 * 用显式集合而不是「按稀有度猜」——稀有度是战利品属性，不是开箱方式。
 */
export const LOCKED_CONTAINER_TYPES = Object.freeze(['safe']);

/**
 * 容器是否需要搜索读条。
 * @param {object|string} container 容器对象或类型 id
 * @returns {boolean}
 */
export function needsChannel(container) {
  const type = typeof container === 'string' ? container : (container && container.type);
  return LOCKED_CONTAINER_TYPES.includes(type);
}

/**
 * 搜索读条秒数：需要解锁的容器走配置表，其它一律 0（秒开）。
 * @param {object} container
 * @returns {number}
 */
export function searchTimeFor(container) {
  if (!needsChannel(container)) return 0;
  const def = CONTAINERS[container.type];
  return def ? def.searchTime : 0;
}

/**
 * 目标种类（HUD 文案与交互行为都从这里派生，不在 ui.js 里再判一次）。
 */
export const TARGET_KIND = Object.freeze({
  terminal: 'terminal',
  extract: 'extract',
  container: 'container',
  scatter: 'scatter',
});

/**
 * 把地图容器 + 地面散落物整理成「可交互目标列表」。
 * 纯函数：只读 world，返回新数组，不改动任何实体。
 *
 * @param {object} world 战局上下文（需要 map.containers / items）
 * @param {object} player { x, y }
 * @param {object} opts { range, scatterRange, los }
 *   - range        容器的可交互距离
 *   - scatterRange 散落物聚合成堆的半径（通常比容器近，避免隔墙吸物品）
 *   - los          (x1,y1,x2,y2)=>boolean 视线判定，缺省恒 true
 * @returns {Array<{kind, name, x, y, dist, ref, searchTime, empty}>}
 */
export function collectInteractables(world, player, opts = {}) {
  if (!world || !player) return [];
  const range = opts.range != null ? opts.range : 56;
  const scatterRange = opts.scatterRange != null ? opts.scatterRange : range;
  const los = opts.los || (() => true);
  const out = [];
  const map = world.map || {};

  for (const c of (map.containers || [])) {
    const d = Math.hypot(c.x - player.x, c.y - player.y);
    if (d > range || !los(player.x, player.y, c.x, c.y)) continue;
    const def = CONTAINERS[c.type] || { name: c.type };
    const empty = !!c.searched && !(c.loot && c.loot.length);
    out.push({
      kind: TARGET_KIND.container,
      name: c.searched ? `${def.name}（已搜）` : def.name,
      x: c.x, y: c.y, dist: d, ref: c,
      searchTime: searchTimeFor(c), empty,
    });
  }

  // 地面散落物：聚合成一个「散落物堆」，按重心定位；同一堆的物品由 world.items
  // 上临时的 scatterId 关联（见 assignScatterGroups），不复制物品本体。
  const groups = groupScatter(world.items || [], player, scatterRange, los);
  for (const g of groups) {
    out.push({
      kind: TARGET_KIND.scatter,
      name: `散落物堆 · ${g.items.length} 件`,
      x: g.x, y: g.y, dist: g.dist, ref: g,
      searchTime: 0, empty: false,
    });
  }

  // 近的排前面；同距离时容器优先于散落物（散落物是"顺手捡"，不该抢主交互）
  out.sort((a, b) => (a.dist - b.dist) || (a.kind === b.kind ? 0 : (a.kind === TARGET_KIND.scatter ? 1 : -1)));
  return out;
}

/**
 * 把附近的地面掉落物按连通距离聚成若干堆（单链聚类，不做全图 O(n²) 排序）。
 * 纯函数：不写 item，只在返回结构里带引用。
 *
 * @param {Array<object>} items world.items（{ x, y, taken }）
 * @param {object} player
 * @param {number} range 聚合半径
 * @param {Function} los 视线判定
 * @returns {Array<{x,y,dist,items}>}
 */
export function groupScatter(items, player, range, los = () => true) {
  const nearby = (items || []).filter((it) =>
    !it.taken && Math.hypot(it.x - player.x, it.y - player.y) <= range
      && los(player.x, player.y, it.x, it.y));
  if (!nearby.length) return [];
  // 每件物品只能属于一堆；用 visited 下标集合而不是改 item 本体
  const used = new Set();
  const groups = [];
  for (let i = 0; i < nearby.length; i++) {
    if (used.has(i)) continue;
    const stack = [i];
    const members = [];
    used.add(i);
    while (stack.length) {
      const j = stack.pop();
      const it = nearby[j];
      members.push(it);
      for (let k = 0; k < nearby.length; k++) {
        if (used.has(k)) continue;
        const o = nearby[k];
        if (Math.hypot(it.x - o.x, it.y - o.y) <= range * 0.45) {
          used.add(k);
          stack.push(k);
        }
      }
    }
    let sx = 0; let sy = 0;
    for (const it of members) { sx += it.x; sy += it.y; }
    const x = sx / members.length; const y = sy / members.length;
    groups.push({ x, y, dist: Math.hypot(x - player.x, y - player.y), items: members });
  }
  groups.sort((a, b) => a.dist - b.dist);
  return groups;
}

/**
 * 滚轮/方向键切换目标：返回一个新的游标（有界循环）。
 * @param {number} current 当前游标
 * @param {number} delta +1 下一个 / -1 上一个
 * @param {number} length 目标数
 * @returns {number}
 */
export function cycleTarget(current, delta, length) {
  if (length <= 0) return 0;
  const d = delta > 0 ? 1 : (delta < 0 ? -1 : 0);
  return ((current + d) % length + length) % length;
}

/**
 * 给定目标，取它对应的真实容器对象（散落物堆是临时结构，没有 map 容器）。
 * @param {object} target collectInteractables 产出的目标
 * @returns {object|null}
 */
export function containerOfTarget(target) {
  if (!target) return null;
  if (target.kind === TARGET_KIND.container) return target.ref || null;
  if (target.kind === TARGET_KIND.scatter) return target.ref || null;
  return null;
}
