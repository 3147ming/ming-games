/**
 * 搜刮界面的键盘焦点导航（纯逻辑 · 零 DOM · 零 three · 零随机）。
 *
 * 为什么单独抽出来：方向键选物品是这一屏唯一有算法的部分，
 * 剩下的都是 DOM 渲染。抽成纯函数后可以用单测锁住"大件不会被跳过"、
 * "只往按下的方向走"这两条最容易退化的规则，而不必起无头浏览器。
 *
 * 规则：
 * 1. 主轴（按下的方向）必须为正 —— 绝不因为"斜着更近"就往反方向跳；
 * 2. 目标必须落在按下方向约 ±70° 的扇区内（主轴 > 横移 × 0.34）：
 *    否则"焦点在 4×2 大件中间按左键、跳到左下方那件"这种鬼跳会反复出现；
 * 3. 扇区内的正交邻居优先于斜向（cross 距离乘 2.4 的代价）；
 * 4. 用物品**中心点**算距离，不做格子步进 —— 4×2 的大件会占据多格，
 *    步进式导航会整块跳过它，玩家会以为方向键坏了。
 */

import { itemW, itemH } from './inventory.js';

/** 物品中心点（格坐标，非像素） */
export function centerOf(it) {
  return { cx: (it.col || 0) + itemW(it) / 2, cy: (it.row || 0) + itemH(it) / 2 };
}

/**
 * 在 list 里按方向挑下一件。
 * @param {Array<object>} list 候选物品（同一容器）
 * @param {string|null} fromUid 当前焦点 uid（不存在时回落第一件）
 * @param {number} dx -1/0/1 水平方向
 * @param {number} dy -1/0/1 垂直方向
 * @returns {object|null} 下一件物品
 */
export function pickByDirection(list, fromUid, dx, dy) {
  if (!Array.isArray(list) || !list.length) return null;
  const from = list.find((it) => it.uid === fromUid);
  if (!from) return list[0];
  const f = centerOf(from);
  let best = null;
  let bestScore = Infinity;
  for (const it of list) {
    if (it.uid === fromUid) continue;
    const c = centerOf(it);
    const vx = c.cx - f.cx;
    const vy = c.cy - f.cy;
    const main = dy ? vy * dy : vx * dx;
    const cross = dy ? Math.abs(vx) : Math.abs(vy);
    // 扇区门槛：主轴至少是横移的 34%（≈ 与按下方向夹角 < 70°）。
    // 少了这一条，4×2 大件居中时按左键会跳到"左下方那件"，读起来像按键失灵。
    if (main <= 0.01 || main <= cross * 0.34) continue;
    const score = main + cross * 2.4;
    if (score < bestScore) { bestScore = score; best = it; }
  }
  return best;
}
