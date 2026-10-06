/**
 * 程序化贴图（Canvas 2D 现画，零素材、零网络请求）
 * ---------------------------------------------------------------------------
 * 为什么不用图片素材：
 *  · 项目铁律是"零依赖零构建"，贴图一旦变成二进制素材，部署包、git、缓存全都要跟着管；
 *  · 程序化生成可以**参数化**（草的密度、土路的车辙深浅都是代码里的数），
 *    调战场观感不用重开图；
 *  · 全部走"绕边重复绘制"（wrapDraw），所以贴图**能无缝平铺** ——
 *    草地要 repeat 40+ 次，接缝会非常明显，这是必须做的一步。
 *
 * ⚠ 本文件依赖 DOM（document/Canvas2D），所以**不在 node --test 覆盖范围内**，
 *   它的正确性由无头浏览器探针（tools/probe.mjs）的截图 + 运行时报错来保证。
 */
import {
  CanvasTexture,
  RepeatWrapping,
  SRGBColorSpace,
  LinearMipmapLinearFilter,
  LinearFilter,
} from '../../vendor/three/three.module.js';
import { SCENE_INK } from './config.js';
import { tonePixels } from './inkTone.js';

function makeCanvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** 让随机图元在贴图边界处"绕回来再画一次"，从而得到无缝平铺 */
function wrapDraw(ctx, size, x, y, draw) {
  for (const dx of [-size, 0, size]) {
    for (const dy of [-size, 0, size]) {
      const px = x + dx;
      const py = y + dy;
      if (px < -size * 0.5 || px > size * 1.5 || py < -size * 0.5 || py > size * 1.5) continue;
      draw(px, py);
    }
  }
}

function wrapBlob(ctx, size, x, y, r, color, alpha) {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  wrapDraw(ctx, size, x, y, (px, py) => {
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;
}

function toTexture(canvas, { repeat = 1, srgb = true, aniso = 1 } = {}) {
  const t = new CanvasTexture(canvas);
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = aniso;
  if (srgb) t.colorSpace = SRGBColorSpace;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.needsUpdate = true;
  return t;
}

// ───────────────────────────────────────────────────────────── 战场草地
export function makeGrassTexture({ size = 512, repeat = 1, aniso = 1 } = {}) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');

  ctx.fillStyle = '#5a6f3c';
  ctx.fillRect(0, 0, size, size);

  // 大尺度色斑：让草地不是一片死平的绿（远处看会形成自然的深浅层次）
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 22 + Math.random() * 68;
    const dark = Math.random() < 0.5;
    wrapBlob(ctx, size, x, y, r, dark ? '#4a5c31' : '#6d8148', 0.22 + Math.random() * 0.16);
  }
  // 枯黄斑：战场不该是高尔夫球场
  for (let i = 0; i < 26; i++) {
    wrapBlob(ctx, size, Math.random() * size, Math.random() * size, 16 + Math.random() * 40, '#8b8a4e', 0.16);
  }

  // 草叶：短线段，方向偏竖直但带随机倾角
  const blades = size * 7;
  for (let i = 0; i < blades; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const len = 2.5 + Math.random() * 5.5;
    const tilt = (Math.random() - 0.5) * 0.9;
    const shade = Math.random();
    ctx.strokeStyle = shade < 0.34 ? '#41532a' : shade < 0.7 ? '#6f8a44' : '#87a055';
    ctx.lineWidth = 0.9 + Math.random() * 0.7;
    ctx.globalAlpha = 0.5 + Math.random() * 0.4;
    wrapDraw(ctx, size, x, y, (px, py) => {
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + tilt * len, py - len);
      ctx.stroke();
    });
  }
  ctx.globalAlpha = 1;

  // 细土粒：靠近镜头时地面才不会像一块纯色
  for (let i = 0; i < size * 2; i++) {
    ctx.fillStyle = Math.random() < 0.5 ? 'rgba(120,104,66,0.35)' : 'rgba(38,46,24,0.35)';
    ctx.fillRect(Math.random() * size, Math.random() * size, 1.2, 1.2);
  }

  applyInkTone(ctx, size, {
    satMul: SCENE_INK.GRASS_SAT_MUL,
    lightMul: SCENE_INK.GRASS_LIGHT_MUL,
    target: SCENE_INK.GRASS_TARGET,
  });

  return toTexture(c, { repeat, aniso });
}

/**
 * 整图水墨调色（模块 13）：逐像素 HSL 变换 + 均值平移到目标色。
 * ---------------------------------------------------------------------------
 * ⚠ 为什么放在**画完之后**统一处理，而不是改上面几十处随机色：
 *   贴图里全是 `Math.random()` 出来的色斑/草叶/碎石，逐个常量改既不现实也改不齐；
 *   统一后处理既保留了所有随机层次，又能保证整图均值精确落在 spec 的目标色上。
 */
export function applyInkTone(ctx, size, opt) {
  try {
    const img = ctx.getImageData(0, 0, size, size);
    tonePixels(img.data, opt);
    ctx.putImageData(img, 0, 0);
  } catch (err) {
    console.warn('[textures] 水墨调色失败，保留原色：', err && err.message);
  }
}

// ───────────────────────────────────────────────────────────── 土路
export function makeDirtTexture({ size = 512, repeat = 1, aniso = 1 } = {}) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');

  ctx.fillStyle = '#8a7048';
  ctx.fillRect(0, 0, size, size);

  // 底噪：湿土/干土的斑驳。
  // ⚠ 半径别开大：土路贴图的 U 方向不重复（整张图正好横铺一个路宽），
  //   大半径色斑会被拉伸成一眼可见的"水彩团"，反而比均匀的土更像贴图。
  for (let i = 0; i < 200; i++) {
    const light = Math.random() < 0.5;
    wrapBlob(
      ctx,
      size,
      Math.random() * size,
      Math.random() * size,
      9 + Math.random() * 26,
      light ? '#a08a5e' : '#6a5436',
      0.12 + Math.random() * 0.16
    );
  }

  // 车辙：两条沿 V（贴图竖直方向）的深色压痕，土路最有辨识度的特征。
  // ⚠ 横向（U）只会重复 1 次，所以这两条辙就落在路面的 30% / 70% 处 —— 
  //   如果以后有人把 repeat 的 u 调大，路面上会出现 2N 条辙，看起来像木板栈道。
  for (const cx of [size * 0.3, size * 0.7]) {
    for (let pass = 0; pass < 2; pass++) {
      ctx.globalAlpha = 0.1 + pass * 0.045;
      ctx.fillStyle = '#5b472c';
      const w = 20 + pass * 14;
      ctx.fillRect(cx - w / 2 + (Math.random() - 0.5) * 4, 0, w, size);
    }
  }
  ctx.globalAlpha = 1;

  // 碎石
  for (let i = 0; i < size * 2.2; i++) {
    const r = 0.7 + Math.random() * 1.8;
    ctx.globalAlpha = 0.3 + Math.random() * 0.35;
    ctx.fillStyle = Math.random() < 0.6 ? '#b3a077' : '#4f3f27';
    wrapDraw(ctx, size, Math.random() * size, Math.random() * size, (px, py) => {
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
    });
  }
  ctx.globalAlpha = 1;

  // 路肩：左右两侧稍微变暗，视觉上把路面"箍"住
  const edge = ctx.createLinearGradient(0, 0, size, 0);
  edge.addColorStop(0, 'rgba(52,42,26,0.42)');
  edge.addColorStop(0.12, 'rgba(52,42,26,0)');
  edge.addColorStop(0.88, 'rgba(52,42,26,0)');
  edge.addColorStop(1, 'rgba(52,42,26,0.42)');
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, size, size);

  // ★SPEC(模块13) 土路转灰褐 #8a7a68
  applyInkTone(ctx, size, {
    satMul: SCENE_INK.ROAD_SAT_MUL,
    lightMul: SCENE_INK.ROAD_LIGHT_MUL,
    target: SCENE_INK.ROAD_TARGET,
  });

  return toTexture(c, { repeat, aniso });
}

// ───────────────────────────────────────────────────────────── 石 / 木 / 布
export function makeStoneTexture({ size = 256, repeat = 1 } = {}) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#8b8b86';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 70; i++) {
    wrapBlob(ctx, size, Math.random() * size, Math.random() * size, 10 + Math.random() * 34, Math.random() < 0.5 ? '#a5a49d' : '#6f6f69', 0.3);
  }
  // 砖缝
  ctx.strokeStyle = 'rgba(60,60,56,0.55)';
  ctx.lineWidth = 2;
  for (let y = 0; y <= size; y += size / 4) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y);
    ctx.stroke();
  }
  for (let row = 0; row < 4; row++) {
    const y0 = (row * size) / 4;
    const off = row % 2 ? size / 4 : 0;
    for (let x = off; x <= size; x += size / 2) {
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y0 + size / 4);
      ctx.stroke();
    }
  }
  return toTexture(c, { repeat });
}

export function makeWoodTexture({ size = 256, repeat = 1 } = {}) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#8a6234';
  ctx.fillRect(0, 0, size, size);
  // 木纹
  for (let i = 0; i < 260; i++) {
    const y = Math.random() * size;
    ctx.globalAlpha = 0.12 + Math.random() * 0.22;
    ctx.strokeStyle = Math.random() < 0.5 ? '#6b4a25' : '#a67c47';
    ctx.lineWidth = 0.8 + Math.random() * 2.2;
    wrapDraw(ctx, size, 0, y, (px, py) => {
      ctx.beginPath();
      ctx.moveTo(px - 4, py);
      ctx.bezierCurveTo(px + size * 0.3, py + 3, px + size * 0.7, py - 3, px + size + 4, py);
      ctx.stroke();
    });
  }
  ctx.globalAlpha = 1;
  // 板缝
  ctx.strokeStyle = 'rgba(48,32,16,0.6)';
  ctx.lineWidth = 3;
  for (let x = 0; x <= size; x += size / 4) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, size);
    ctx.stroke();
  }
  return toTexture(c, { repeat });
}

export function makeClothTexture({ size = 256, repeat = 1 } = {}) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#b6ab93';
  ctx.fillRect(0, 0, size, size);
  // 粗布经纬
  ctx.globalAlpha = 0.18;
  for (let i = 0; i < size; i += 3) {
    ctx.fillStyle = '#8d8266';
    ctx.fillRect(i, 0, 1, size);
    ctx.fillRect(0, i, size, 1);
  }
  ctx.globalAlpha = 1;
  // 污渍
  for (let i = 0; i < 26; i++) {
    wrapBlob(ctx, size, Math.random() * size, Math.random() * size, 8 + Math.random() * 26, '#7d7359', 0.16);
  }
  return toTexture(c, { repeat });
}

export function makeRockTexture({ size = 256, repeat = 1 } = {}) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#6e6a63';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 90; i++) {
    wrapBlob(ctx, size, Math.random() * size, Math.random() * size, 6 + Math.random() * 30, Math.random() < 0.5 ? '#8a857c' : '#565249', 0.3);
  }
  for (let i = 0; i < size * 0.6; i++) {
    ctx.fillStyle = Math.random() < 0.5 ? 'rgba(200,196,186,0.3)' : 'rgba(40,38,34,0.3)';
    ctx.fillRect(Math.random() * size, Math.random() * size, 2, 2);
  }
  return toTexture(c, { repeat });
}

// ───────────────────────────────────────────────────────────── 天穹
/**
 * 天穹渐变贴图。**不做无缝平铺**（ClampToEdge），贴在一个 BackSide 大球上。
 * 用球而不是 scene.background 纯色：抬头低头时天空会跟着视差移动，
 * 这是"3D 战场"和"贴在一张背景图上"的观感分界线。
 */
export function makeSkyTexture({ top = '#39659e', horizon = '#c8d7e3', size = 256 } = {}) {
  const c = makeCanvas(4, size);
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0.0, top);
  g.addColorStop(0.62, horizon);
  g.addColorStop(1.0, horizon);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, size);

  const t = new CanvasTexture(c);
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.colorSpace = SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/** 取当前渲染器支持的最大各向异性（大平面贴图的清晰度几乎全靠它） */
export function resolveAnisotropy(renderer, cap) {
  const max = renderer?.capabilities?.getMaxAnisotropy?.() ?? 1;
  return Math.max(1, Math.min(cap, max));
}
