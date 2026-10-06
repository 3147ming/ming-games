/**
 * 水墨调色（模块 13）—— 纯函数，不碰 DOM / three，可在 node 里单测。
 * ---------------------------------------------------------------------------
 * 场景要"转灰绿 / 转灰褐"，靠的是两步而不是直接换贴图颜色：
 *   ① 逐像素 HSL 变换：饱和度 ×satMul、明度 ×lightMul（保留贴图自身的明暗层次）
 *   ② 整图均值平移到目标色（target）—— 保证最终落进 spec 写的目标区间，
 *      同时**不破坏**第①步压出来的低饱和质感（只平移，不重新饱和）。
 *
 * 为什么必须 ②：只做 ① 的话，"草地 −30% 饱和 −10% 明度"从 #5a6f3c 出来会是更暗的橄榄色，
 * 而 spec 的目标区间 #7a8a72 反而更亮更灰 —— 两个约束单独看是自相矛盾的。
 * 均值平移把"相对关系"和"绝对色"解耦：层次由①决定，落点由②决定。
 */

/** RGB(0~1) → HSL(0~1) */
export function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-6) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h, s, l };
}

function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

/** HSL(0~1) → RGB(0~1) */
export function hslToRgb(h, s, l) {
  if (s <= 1e-6) return { r: l, g: l, b: l };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: hue2rgb(p, q, h + 1 / 3),
    g: hue2rgb(p, q, h),
    b: hue2rgb(p, q, h - 1 / 3),
  };
}

/**
 * 单色水墨变换：降饱和 + 压/提明度。
 * @param {{r:number,g:number,b:number}} rgb 各通道 0~1
 * @param {{satMul?:number, lightMul?:number}} opt
 */
export function inkTone(rgb, { satMul = 1, lightMul = 1 } = {}) {
  const { h, s, l } = rgbToHsl(rgb.r, rgb.g, rgb.b);
  return hslToRgb(h, Math.min(1, s * satMul), Math.min(1, Math.max(0, l * lightMul)));
}

/** 把 0xRRGGBB 拆成 0~1 三通道 */
export function hexToRgb(hex) {
  return { r: ((hex >> 16) & 255) / 255, g: ((hex >> 8) & 255) / 255, b: (hex & 255) / 255 };
}

/** 0~1 三通道 → 0xRRGGBB */
export function rgbToHex({ r, g, b }) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return (c(r) << 16) | (c(g) << 8) | c(b);
}

/**
 * 贴图整图调色（给 canvas 的 ImageData 用）。
 * 先逐像素做 HSL 变换，再把**整图均值**平移到 target（mix=1 → 均值精确落在 target）。
 *
 * @param {Uint8ClampedArray} data RGBA 序列，原地修改
 * @param {{satMul?:number, lightMul?:number, target?:number, mix?:number}} opt
 * @returns {{mean:number}} 变换后的整图均值（0xRRGGBB），便于自测/探针校验
 */
export function tonePixels(data, { satMul = 1, lightMul = 1, target = null, mix = 1 } = {}) {
  let n = 0;
  let sr = 0, sg = 0, sb = 0;
  // ① 逐像素 HSL 变换
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 0) continue; // 全透明像素不参与（也别把均值拉偏）
    const out = inkTone({ r: data[i] / 255, g: data[i + 1] / 255, b: data[i + 2] / 255 }, { satMul, lightMul });
    data[i] = out.r * 255;
    data[i + 1] = out.g * 255;
    data[i + 2] = out.b * 255;
    n++;
    sr += out.r; sg += out.g; sb += out.b;
  }
  if (n === 0) return { mean: 0 };
  // ② 均值平移到目标色
  if (target != null) {
    const t = hexToRgb(target);
    const mr = sr / n, mg = sg / n, mb = sb / n;
    const dr = (t.r - mr) * mix, dg = (t.g - mg) * mix, db = (t.b - mb) * mix;
    let nr = 0, ng = 0, nb = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      data[i] = clamp255(data[i] + dr * 255);
      data[i + 1] = clamp255(data[i + 1] + dg * 255);
      data[i + 2] = clamp255(data[i + 2] + db * 255);
      nr += data[i] / 255; ng += data[i + 1] / 255; nb += data[i + 2] / 255;
    }
    return { mean: rgbToHex({ r: nr / n, g: ng / n, b: nb / n }) };
  }
  return { mean: rgbToHex({ r: sr / n, g: sg / n, b: sb / n }) };
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/**
 * 远处剪影化：往淡墨色靠 + 减对比（往自身明度收）。
 * 模块 13 用它把 LOD2 的远处小兵揉成"淡墨剪影"，避免远处一堆高对比小人抢视线。
 *
 * @param {{r,g,b}} rgb
 * @param {{r,g,b}} ink 目标淡墨色
 * @param {number} mix 靠向淡墨的比例 0~1
 * @param {number} contrast 对比保留系数（<1 = 减对比，把通道往自身明度收）
 */
export function silhouette(rgb, ink, mix = 1, contrast = 1) {
  const l = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
  const flat = {
    r: l + (rgb.r - l) * contrast,
    g: l + (rgb.g - l) * contrast,
    b: l + (rgb.b - l) * contrast,
  };
  return {
    r: flat.r + (ink.r - flat.r) * mix,
    g: flat.g + (ink.g - flat.g) * mix,
    b: flat.b + (ink.b - flat.b) * mix,
  };
}
