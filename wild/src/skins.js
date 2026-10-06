// 皮肤（阶段 6-2）：纯外观，不影响任何数值 / 判定 / RNG。
//
// 机制：英雄真图（hero.png）画完后，按皮肤色叠一层半透明蒙版（复用 Arena._buildMask 的
// 「source-in 纯色块」烘焙，绘制时 globalAlpha < 1 叠在真图之上）—— 这样既换了整体色调、
// 又透得出素材本身的明暗层次（与精英「更红」蒙版同一套思路）。默认皮肤不叠蒙版，用原图。
//
// 状态形状（meta）：{ ... , skin: string } —— 当前选中皮肤 id，默认 'default'。

/** 叠在英雄真图之上的蒙版不透明度：0.55 与精英红一致，纯色不会压掉素材层次。 */
export const SKIN_TINT_ALPHA = 0.55;

/** 四套皮肤。color = null 表示不重涂（用原图）；其余为蒙版色。 */
export const SKINS = [
  { id: 'default', name: '默认', color: null, desc: '原版荒野猎手' },
  { id: 'flame',   name: '赤焰', color: '#ff5a2c', desc: '炽红涂装 · 燃尽荒野' },
  { id: 'frost',   name: '幽霜', color: '#46c8e6', desc: '冰蓝涂装 · 寒锋过境' },
  { id: 'gold',    name: '鎏金', color: '#e8b54a', desc: '鎏金涂装 · 荒野贵胄' },
];

export const DEFAULT_SKIN = 'default';

export const skinById = (id) =>
  SKINS.find((s) => s.id === id) || SKINS[0];

/** 当前皮肤是否需要在英雄真图之上叠蒙版（默认皮肤不叠）。 */
export const skinNeedsTint = (id) => {
  const s = skinById(id);
  return !!s.color;
};
