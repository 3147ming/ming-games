// 程序化剪影生成
// 口径：美术零素材 —— 所有敌人形象由 shape 种子确定性生成「极简剪影」。
//      "加一种敌人"的美术成本因此为 0，这正是这个项目敢用零位图做 3 种敌人的原因。
//
// ⚠ 一个必须记住的坑（本项目实测踩过）：生成出来的点是**以 (50,46) 为中心、左右对称**的，
//   而半径上下各能到 r*1.28 ≈ 66 —— 也就是说 y 的实际范围是 **-20 ~ 112**，超出了
//   0~100 这个直觉上的"画布"。任何"把它塞进 100×100 的方框"的烘焙都会在上下各裁掉一截，
//   敌人剪影看起来像被削平的方块（而且不报任何错）。
//   所以这里除了路径，还必须**同时导出真实包围盒** silhouetteBox()，让烘焙方按包围盒来。
// 移植自 ONE-CARD（只保留剪影生成，卡牌相关的 glyphSvg / archetypeMark 已删除）。

/** 确定性伪随机（与 rng.js 的 mulberry32 不同：这里要的是"同 shape 出同形状"，不需要流式状态） */
function lcg(seed) {
  let s = (seed * 2654435761) >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 2246822519) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 生成左右对称的轮廓点（已按中轴镜像，坐标在 (50,46) 附近，**不保证落在 0~100 内**）。 */
function pointsOf(shape, spikes) {
  const rnd = lcg(shape);
  const N = 9 + (shape % 4);
  const right = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const angle = -Math.PI / 2 + t * Math.PI; // 从顶部扫到底部
    let r = 30 + rnd() * 22;
    if (spikes && i % 2 === 1) r += 6 + rnd() * 8; // 尖刺
    const x = Math.cos(angle) * r * 0.72;
    const y = Math.sin(angle) * r * 1.28;
    right.push([50 + x, 46 + y]);
  }
  const left = right.slice().reverse().map(([x, y]) => [100 - x, y]); // 以 x=50 为轴镜像
  return [...right, ...left];
}

const fmt = (v) => v.toFixed(1);

/**
 * 生成一个左右对称的剪影路径（返回 SVG path 的 d 字符串）。
 * @param {number} shape 形状种子（不同值 → 不同轮廓；相同值恒等）
 * @param {boolean} spikes 是否加尖刺（坦克用，轮廓更"厚重"）
 */
export function silhouette(shape, spikes) {
  return 'M' + pointsOf(shape, spikes).map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join('L') + 'Z';
}

/**
 * 剪影的真实包围盒（路径坐标）。
 * 烘焙离屏精灵时必须用它当画布范围 —— 用固定的 0~100 会裁掉上下两截，
 * 而且裁切是**静默**的：没有报错，只是敌人看起来"被削平了"。
 */
export function silhouetteBox(shape, spikes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pointsOf(shape, spikes)) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 剪影的锚点（路径坐标系）：与生成时的中心一致，绘制时用它对齐实体位置。 */
export const SILHOUETTE_ANCHOR = { x: 50, y: 46 };
