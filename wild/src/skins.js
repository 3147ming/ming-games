// 皮肤（阶段 6-2）：纯外观，不影响任何数值 / 判定 / RNG。
//
// 机制：英雄真图（hero.png）画完后，按皮肤色叠一层半透明蒙版（复用 Arena._buildMask 的
// 「source-in 纯色块」烘焙，绘制时 globalAlpha < 1 叠在真图之上）—— 这样既换了整体色调、
// 又透得出素材本身的明暗层次（与精英「更红」蒙版同一套思路）。默认皮肤不叠蒙版，用原图。
//
// 状态形状（meta）：{ ... , skin: string } —— 当前选中皮肤 id，默认 'default'。

/** 叠在英雄真图之上的蒙版不透明度：0.55 与精英红一致，纯色不会压掉素材层次。 */
export const SKIN_TINT_ALPHA = 0.55;

/**
 * 皮肤。color = null 表示不重涂（用原图）；其余为蒙版色。
 * ★ 阶段10·P1-9：`tier` = 解锁所需阶段（总属性等级 10/25/50 → 1/2/3 阶；0 = 恒可用）。
 *   原先四套全开局可选，导致「二阶解锁赤焰 / 三阶幽霜 / 四阶鎏金」的文案在骗人。
 *   DEFAULT_SKIN 必须恒 tier 0 —— loadMeta 的两处兜底都指向它。
 */
export const SKINS = [
  { id: 'default', name: '默认', color: null,      tier: 0, desc: '原版荒野猎手' },
  { id: 'flame',   name: '赤焰', color: '#ff5a2c', tier: 1, desc: '炽红涂装 · 燃尽荒野' },
  { id: 'frost',   name: '幽霜', color: '#46c8e6', tier: 2, desc: '冰蓝涂装 · 寒锋过境' },
  { id: 'gold',    name: '鎏金', color: '#e8b54a', tier: 3, desc: '鎏金涂装 · 荒野贵胄' },
  // 阶段10·P1-9：新增 4 套纯色皮肤（4 → 8），把阶段晋升的仪式感补齐。
  { id: 'ash',     name: '灰烬', color: '#6f6a63', tier: 2, desc: '灰白涂装 · 余烬未熄' },
  { id: 'obsid',   name: '玄曜', color: '#2b2b33', tier: 2, desc: '黑曜涂装 · 无声之影' },
  { id: 'moss',    name: '苔痕', color: '#5f8a4a', tier: 3, desc: '苔绿涂装 · 荒野同色' },
  { id: 'ember',   name: '余烬', color: '#c86a30', tier: 3, desc: '橙褐涂装 · 余火不灭' },
];

export const DEFAULT_SKIN = 'default';

export const skinById = (id) =>
  SKINS.find((s) => s.id === id) || SKINS[0];

/** 当前皮肤是否需要在英雄真图之上叠蒙版（默认皮肤不叠）。 */
export const skinNeedsTint = (id) => {
  const s = skinById(id);
  return !!s.color;
};
