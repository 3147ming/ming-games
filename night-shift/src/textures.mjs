/**
 * 程序化贴图（ADR-004 的落地：无外部资源、无构建步骤、离线可跑）
 *
 * 设计要点：
 * 1) 全部用 Canvas 现画，不加载任何图片 —— 零网络请求、零版权风险。
 * 2) 每张贴图都做无缝平铺（元素绘制时按 wrap 补画，采样时取模）。
 * 3) 每张 albedo 配套生成 法线图（由高度图 Sobel 求导）与 粗糙度图（灰度）。
 * 4) 避免拉伸：纹理只有一份，靠 applyBoxUV() 按物体实际尺寸缩放几何 UV，
 *    于是全场 texel 密度一致，且不会因 repeat 差异产生多份 GPU 上传。
 *
 * ── R5（需求E/F）改造说明 ──────────────────────────────────
 * · 配色全部改由 src/art.mjs 的令牌驱动，本文件不再出现硬编码品牌色。
 *   改配色只改 art.mjs 一处（这是"美术规范单一真源"的落地）。
 * · 规范要求「无白底 → 深色底」：所有面从 BASE_COLORS 的深色起笔，
 *   且新增 clampLuma() 兜底，保证绘完的贴图不会出现纯白像素。
 * · 规范要求「PBR Albedo 2048×2048」：RECIPES 的 size 改由 art.TEX.levels
 *   按资产重要度分级（hero/large = 2048）。
 * · 新增需求F 点名的 7 类资产绘制函数（见 TEX_ASSETS）。
 */
import * as THREE from 'three';
import { BASE_COLORS, NEON, NEON_DIM, SEMANTIC, TEX } from './art.mjs';

/* ---------- 基础工具 ---------- */

/** 固定种子随机，保证每次运行贴图一致 */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function newCanvas(size) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c;
}

/**
 * 无缝绘制：元素靠近边界时，在 ±size 处补画一份。
 * r 为元素半径，用于判断是否需要补画。
 */
function tile(c, size, x, y, r, fn) {
  for (const ox of [-size, 0, size]) {
    for (const oy of [-size, 0, size]) {
      const px = x + ox;
      const py = y + oy;
      if (px + r < 0 || px - r > size || py + r < 0 || py - r > size) continue;
      fn(px, py);
    }
  }
}

/** '#RRGGBB' → [r,g,b]（0-255），用于做明度缩放 */
function rgbOf(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** 把颜色按系数提亮/压暗，返回 css 颜色串。k>1 更亮，k<1 更暗 */
function shade(hex, k, alpha = 1) {
  const [r, g, b] = rgbOf(hex);
  const cl = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
  return alpha >= 1
    ? `rgb(${cl(r)},${cl(g)},${cl(b)})`
    : `rgba(${cl(r)},${cl(g)},${cl(b)},${alpha})`;
}

/** 两个颜色按 t 线性混合（t=0 → a，t=1 → b） */
function mix(a, b, t, alpha = 1) {
  const A = rgbOf(a);
  const B = rgbOf(b);
  const cl = (i) => Math.round(A[i] + (B[i] - A[i]) * t);
  return alpha >= 1
    ? `rgb(${cl(0)},${cl(1)},${cl(2)})`
    : `rgba(${cl(0)},${cl(1)},${cl(2)},${alpha})`;
}

/**
 * 「无白底」规范的兜底：逐像素把亮度过高的像素压回上限内。
 * 为什么需要它：Canvas 的加色叠加（globalCompositeOperation='lighter'）
 * 或多次半透明提亮很容易把局部推到纯白，而规范明确禁止白底。
 * 这里用一个软膝盖（soft knee）压缩高光，保留层次而不是硬截断 ——
 * 硬截断（v>max 直接设 max）会在霓虹中心留下难看的死白圆斑。
 */
function clampLuma(canvas, max = TEX.maxLuma) {
  const size = canvas.width;
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const luma = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    if (luma > max) {
      // 软压缩：超出部分按 0.35 的斜率保留，同时整体缩到 max 附近
      const k = (max + (luma - max) * 0.35) / luma;
      d[i] = Math.round(d[i] * k);
      d[i + 1] = Math.round(d[i + 1] * k);
      d[i + 2] = Math.round(d[i + 2] * k);
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** 由高度图（灰度 canvas）生成法线图：Sobel 求导 + 取模采样保证无缝 */
function heightToNormal(heightCanvas, strength = 1.6) {
  const size = heightCanvas.width;
  const src = heightCanvas.getContext('2d').getImageData(0, 0, size, size).data;
  const out = newCanvas(size);
  const octx = out.getContext('2d');
  const img = octx.createImageData(size, size);
  const H = (x, y) => src[(((y + size) % size) * size + ((x + size) % size)) * 4] / 255;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx =
        H(x + 1, y - 1) + 2 * H(x + 1, y) + H(x + 1, y + 1) -
        (H(x - 1, y - 1) + 2 * H(x - 1, y) + H(x - 1, y + 1));
      const dy =
        H(x - 1, y + 1) + 2 * H(x, y + 1) + H(x + 1, y + 1) -
        (H(x - 1, y - 1) + 2 * H(x, y - 1) + H(x + 1, y - 1));
      const nx = -dx * strength;
      const ny = -dy * strength;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      const i = (y * size + x) * 4;
      img.data[i] = ((nx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((nz / len) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

function texFromCanvas(canvas, { srgb = false, repeat = true } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  if (repeat) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
  }
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/**
 * 建立三张画布（albedo / height / rough）的样板。
 * 深色底规范：albedo 一律从 base 色起笔（默认深色底），
 * 并在返回前统一过一遍 clampLuma 去掉可能的纯白像素。
 */
function layers(size, { base, baseH = '#C0C0C0', baseR = '#8C8C8C' } = {}) {
  const albedo = newCanvas(size);
  const height = newCanvas(size);
  const rough = newCanvas(size);
  const a = albedo.getContext('2d');
  const h = height.getContext('2d');
  const g = rough.getContext('2d');
  a.fillStyle = base ?? BASE_COLORS.mid;
  a.fillRect(0, 0, size, size);
  h.fillStyle = baseH;
  h.fillRect(0, 0, size, size);
  g.fillStyle = baseR;
  g.fillRect(0, 0, size, size);
  return { albedo, height, rough, a, h, g };
}

/**
 * 霓虹描边：在画布上画一条带外发光感的直线段。
 * 低多边形卡通风格里，霓虹是靠「亮芯 + 暗边」两条线表现的，
 * 单画一条纯色线会显得像贴纸，缺乏"灯管"的厚度。
 */
function neonLine(ctx, x0, y0, x1, y1, color, width, glow = 0.55) {
  ctx.save();
  ctx.lineCap = 'round';
  // 外发光
  ctx.globalAlpha = glow * 0.5;
  ctx.strokeStyle = color;
  ctx.lineWidth = width * 3;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  // 中晕
  ctx.globalAlpha = glow;
  ctx.lineWidth = width * 1.8;
  ctx.stroke();
  // 亮芯（用接近白的同色系，而不是纯白 —— 白色会破「无白底」规范）
  ctx.globalAlpha = 1;
  ctx.strokeStyle = shade(color, 1.55);
  ctx.lineWidth = width;
  ctx.stroke();
  ctx.restore();
}

/** 霓虹矩形描边 */
function neonRect(ctx, x, y, w, h, color, width, glow = 0.5) {
  neonLine(ctx, x, y, x + w, y, color, width, glow);
  neonLine(ctx, x + w, y, x + w, y + h, color, width, glow);
  neonLine(ctx, x + w, y + h, x, y + h, color, width, glow);
  neonLine(ctx, x, y + h, x, y, color, width, glow);
}

/** 圆角矩形路径（避免依赖 ctx.roundRect，兼容性更好） */
function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/* ---------- 各类贴图的绘制 ---------- */

/**
 * ①墙面瓷砖（需求F）—— 深色哑光瓷砖 + 霓虹分缝线
 * 平铺尺度：4×4 块，配合 applyBoxUV 的 texScale 使用时约 2m 见方。
 */
function drawWall(size) {
  const r = rng(11);
  const { albedo, height, rough, a, h, g } = layers(size, {
    base: BASE_COLORS.mid, baseH: '#E8E8E8', baseR: '#595959',
  });

  // 4×4 瓷砖：每块内部做极轻的明度抖动（低多边形也怕死平）
  const n = 4;
  const cell = size / n;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      a.fillStyle = mix(BASE_COLORS.mid, BASE_COLORS.raise, 0.25 + r() * 0.5);
      a.fillRect(i * cell, j * cell, cell, cell);
    }
  }

  // 砖缝：深色缝 + 极淡的霓虹紫反光（霓虹环境光洒在墙上的暗示）
  for (let i = 0; i <= n; i++) {
    for (const off of [0, size]) {
      const p = i * cell + off;
      const w = Math.max(3, size / 256 * 3);
      a.fillStyle = BASE_COLORS.deep;
      a.fillRect(p - w / 2, 0, w, size);
      a.fillRect(0, p - w / 2, size, w);
      // 缝里的霓虹残光：只在外侧补一份，模拟灯管在墙缝的高光
      a.fillStyle = shade(NEON_DIM.purple, 1, 0.16);
      a.fillRect(p - w / 2 - w, 0, w, size);
      a.fillRect(0, p - w / 2 - w, size, w);

      h.fillStyle = '#3C3C3C';
      h.fillRect(p - w / 2, 0, w, size);
      h.fillRect(0, p - w / 2, size, w);
      g.fillStyle = '#D9D9D9'; // 缝粗糙 0.85
      g.fillRect(p - w / 2, 0, w, size);
      g.fillRect(0, p - w / 2, size, w);
    }
  }

  // 一处霓虹灯管的墙面反光带（横向，让墙面不平）
  const bandY = Math.round(size * 0.31);
  const bandH = Math.max(6, Math.round(size * 0.018));
  const gg = a.createLinearGradient(0, bandY - bandH, 0, bandY + bandH * 2);
  gg.addColorStop(0, 'rgba(177,91,216,0)');
  gg.addColorStop(0.5, 'rgba(177,91,216,0.14)');
  gg.addColorStop(1, 'rgba(177,91,216,0)');
  a.fillStyle = gg;
  a.fillRect(0, bandY - bandH, size, bandH * 3);

  // 轻微脏污（少量，卡通风格不要写实污渍）
  for (let k = 0; k < 160; k++) {
    const x = r() * size;
    const y = r() * size;
    const rad = (2 + r() * 9) * (size / 256);
    tile(a, size, x, y, rad, (px, py) => {
      a.globalAlpha = 0.04 + r() * 0.04;
      a.fillStyle = r() > 0.5 ? NEON_DIM.ice : BASE_COLORS.deep;
      a.beginPath();
      a.arc(px, py, rad, 0, Math.PI * 2);
      a.fill();
    });
    a.globalAlpha = 1;
  }
  return { albedo: clampLuma(albedo), height, rough };
}

/**
 * ⑤地面瓷砖（需求F）—— 深色大砖 + 霓虹导引条
 * 平铺尺度：2×2 块，约 2m 见方（砖大，显得场地开阔）。
 */
function drawFloorTile(size) {
  const r = rng(23);
  const { albedo, height, rough, a, h, g } = layers(size, {
    base: BASE_COLORS.deep, baseH: '#E0E0E0', baseR: '#6B6B6B',
  });

  const n = 2;
  const cell = size / n;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      a.fillStyle = mix(BASE_COLORS.deep, BASE_COLORS.mid, 0.2 + r() * 0.45);
      a.fillRect(i * cell, j * cell, cell, cell);
    }
  }

  // 砖缝
  for (let i = 0; i <= n; i++) {
    for (const off of [0, size]) {
      const p = i * cell + off;
      const w = Math.max(5, Math.round(size / 256 * 6));
      a.fillStyle = '#0A0E15';
      a.fillRect(p - w / 2, 0, w, size);
      a.fillRect(0, p - w / 2, size, w);
      h.fillStyle = '#404040';
      h.fillRect(p - w / 2, 0, w, size);
      h.fillRect(0, p - w / 2, size, w);
      g.fillStyle = '#CCCCCC';
      g.fillRect(p - w / 2, 0, w, size);
      g.fillRect(0, p - w / 2, size, w);
    }
  }

  // 霓虹导引条：贴砖缝内侧的冷蓝线（电玩城常见的"地面指示灯带"）
  const laneW = Math.max(4, Math.round(size / 256 * 5));
  neonLine(a, 0, cell - laneW * 3, size, cell - laneW * 3, NEON.ice, laneW, 0.28);
  neonLine(a, cell - laneW * 3, 0, cell - laneW * 3, size, NEON.ice, laneW, 0.28);

  // 磨损颗粒
  for (let k = 0; k < 420; k++) {
    const x = r() * size;
    const y = r() * size;
    const s = size / 256 * 2;
    tile(a, size, x, y, s, (px, py) => {
      a.globalAlpha = 0.05 + r() * 0.07;
      a.fillStyle = r() > 0.6 ? NEON_DIM.ice : BASE_COLORS.deep;
      a.fillRect(px, py, s, s);
    });
    a.globalAlpha = 1;
  }
  return { albedo: clampLuma(albedo), height, rough };
}

/** 木纹（收银台 / 桌椅）—— 深色木，压入深色域 */
function drawWood(size) {
  const r = rng(37);
  const { albedo, height, rough, a, h, g } = layers(size, {
    base: '#3A2A1E', baseH: '#C8C8C8', baseR: '#8C8C8C',
  });

  // 沿 x 的木纹条：颜色随 y 周期变化（正弦组合天然无缝）
  for (let y = 0; y < size; y++) {
    const t =
      Math.sin((2 * Math.PI * 3 * y) / size) * 0.5 +
      Math.sin((2 * Math.PI * 7 * y) / size + 1.3) * 0.3 +
      Math.sin((2 * Math.PI * 13 * y) / size + 2.1) * 0.2;
    const v = 0.5 + t * 0.5;
    const k = 0.82 + v * 0.36;
    a.fillStyle = shade('#3A2A1E', k);
    a.fillRect(0, y, size, 1);
    const hv = Math.round(180 + v * 50);
    h.fillStyle = `rgb(${hv},${hv},${hv})`;
    h.fillRect(0, y, size, 1);
  }
  const ku = size / 256;
  // 木节
  for (let k = 0; k < 5; k++) {
    const cx = r() * size;
    const cy = r() * size;
    const rad = 14 * ku;
    tile(a, size, cx, cy, rad, (px, py) => {
      const grad = a.createRadialGradient(px, py, 1, px, py, rad);
      grad.addColorStop(0, 'rgba(20,12,7,0.85)');
      grad.addColorStop(1, 'rgba(20,12,7,0)');
      a.fillStyle = grad;
      a.beginPath();
      a.arc(px, py, rad, 0, Math.PI * 2);
      a.fill();
    });
  }
  // 细划痕
  for (let k = 0; k < 60; k++) {
    const y = r() * size;
    const x = r() * size;
    const len = (10 + r() * 60) * ku;
    a.globalAlpha = 0.12;
    a.strokeStyle = '#160D06';
    a.lineWidth = Math.max(1, ku);
    a.beginPath();
    a.moveTo(x, y);
    a.lineTo(x + len, y + (r() - 0.5) * 2);
    a.stroke();
    a.globalAlpha = 1;
  }
  return { albedo: clampLuma(albedo), height, rough };
}

/** 拉丝金属（货架框 / 机柜边框）—— 冷灰拉丝，带冰蓝反射暗示 */
function drawMetal(size) {
  const r = rng(53);
  const { albedo, height, rough, a, h, g } = layers(size, {
    base: '#3C4450', baseH: '#C0C0C0', baseR: '#595959',
  });

  for (let y = 0; y < size; y++) {
    const v = 0.5 + Math.sin((2 * Math.PI * 40 * y) / size) * 0.5 * (0.6 + r() * 0.4);
    const k = 0.86 + v * 0.28;
    a.fillStyle = shade('#3C4450', k);
    a.fillRect(0, y, size, 1);
  }
  // 划痕
  const ku = size / 256;
  for (let k = 0; k < 40; k++) {
    const y = r() * size;
    const x = r() * size;
    const len = (20 + r() * 90) * ku;
    a.globalAlpha = 0.16;
    a.strokeStyle = r() > 0.5 ? shade(NEON.ice, 1.2) : '#1E242E';
    a.lineWidth = Math.max(1, ku);
    a.beginPath();
    a.moveTo(x, y);
    a.lineTo(x + len, y);
    a.stroke();
    a.globalAlpha = 1;
  }
  return { albedo: clampLuma(albedo), height, rough };
}

/** 室外沥青（后巷） */
function drawAsphalt(size) {
  const r = rng(71);
  const { albedo, height, rough, a, h } = layers(size, {
    base: '#161B22', baseH: '#A8A8A8', baseR: '#E6E6E6',
  });

  // 颗粒
  const count = Math.round(2600 * (size / 256));
  for (let k = 0; k < count; k++) {
    const x = r() * size;
    const y = r() * size;
    const v = r();
    // 保持深色但让颗粒可读：用冷灰而非白
    a.fillStyle = v > 0.5 ? `rgba(70,80,96,${0.10 + v * 0.22})` : `rgba(6,8,11,${0.10 + v * 0.25})`;
    a.fillRect(x, y, 1 + (v > 0.9 ? 1 : 0), 1);
    const hv = Math.round(140 + v * 90);
    h.fillStyle = `rgb(${hv},${hv},${hv})`;
    h.fillRect(x, y, 1, 1);
  }
  // 裂纹
  const ku = size / 256;
  for (let k = 0; k < 5; k++) {
    let x = r() * size;
    let y = r() * size;
    a.strokeStyle = 'rgba(4,5,8,0.6)';
    a.lineWidth = Math.max(1, 1.5 * ku);
    a.beginPath();
    a.moveTo(x, y);
    for (let s = 0; s < 14; s++) {
      x += (r() - 0.5) * 26 * ku;
      y += (r() - 0.5) * 26 * ku;
      a.lineTo(x, y);
    }
    a.stroke();
  }
  return { albedo: clampLuma(albedo), height, rough };
}

/** 广场铺装（室外方砖 + 霓虹地灯） */
function drawPlaza(size) {
  const r = rng(89);
  const { albedo, height, rough, a, h, g } = layers(size, {
    base: '#1C222D', baseH: '#D0D0D0', baseR: '#A6A6A6',
  });

  const n = 4;
  const cell = size / n;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      a.fillStyle = mix('#1C222D', BASE_COLORS.raise, 0.15 + r() * 0.5);
      a.fillRect(i * cell, j * cell, cell, cell);
    }
  }
  for (let i = 0; i <= n; i++) {
    for (const off of [0, size]) {
      const p = i * cell + off;
      const w = Math.max(4, Math.round((size / 256) * 5));
      a.fillStyle = '#0C1017';
      a.fillRect(p - w / 2, 0, w, size);
      a.fillRect(0, p - w / 2, size, w);
      h.fillStyle = '#4A4A4A';
      h.fillRect(p - w / 2, 0, w, size);
      h.fillRect(0, p - w / 2, size, w);
      g.fillStyle = '#D9D9D9';
      g.fillRect(p - w / 2, 0, w, size);
      g.fillRect(0, p - w / 2, size, w);
    }
  }
  // 地砖四角的霓虹地灯点（电玩城广场的典型元素）
  const lampR = Math.max(3, (size / 256) * 5);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const cx = i * cell + cell / 2;
      const cy = j * cell + cell / 2;
      tile(a, size, cx, cy, lampR * 3, (px, py) => {
        const grd = a.createRadialGradient(px, py, 1, px, py, lampR * 3);
        grd.addColorStop(0, 'rgba(79,209,232,0.5)');
        grd.addColorStop(1, 'rgba(79,209,232,0)');
        a.fillStyle = grd;
        a.beginPath();
        a.arc(px, py, lampR * 3, 0, Math.PI * 2);
        a.fill();
      });
    }
  }
  for (let k = 0; k < 700; k++) {
    const x = r() * size;
    const y = r() * size;
    const s = size / 256 * 2;
    a.globalAlpha = 0.05 + r() * 0.07;
    a.fillStyle = r() > 0.5 ? NEON_DIM.ice : '#0E1219';
    a.fillRect(x, y, s, s);
    a.globalAlpha = 1;
  }
  return { albedo: clampLuma(albedo), height, rough };
}

/** 街机柜体（暗色侧板 + 霓虹条） */
function drawArcade(size) {
  const { albedo, height, rough, a, h, g } = layers(size, {
    base: '#151B28', baseH: '#B0B0B0', baseR: '#8C8C8C',
  });
  const ku = size / 256;

  // 霓虹竖条（紫 / 青），沿 x 分布 —— 与竖直柜体走向一致
  const bands = [0.14, 0.3, 0.68, 0.86];
  const bw = Math.max(4, Math.round(size * 0.028));
  for (let bi = 0; bi < bands.length; bi++) {
    const x = Math.round(bands[bi] * size);
    const color = bi % 2 === 0 ? NEON.purple : NEON.ice;
    neonLine(a, x, 0, x, size, color, bw, 0.5);
  }
  // 面板分缝
  a.strokeStyle = '#080B12';
  a.lineWidth = Math.max(2, 3 * ku);
  for (let i = 1; i < 4; i++) {
    const p = (i * size) / 4;
    a.beginPath();
    a.moveTo(p, 0);
    a.lineTo(p, size);
    a.stroke();
    h.fillStyle = '#5A5A5A';
    h.fillRect(p - 2 * ku, 0, 4 * ku, size);
  }
  return { albedo: clampLuma(albedo), height, rough };
}

/**
 * ②抓娃娃机外壳（需求F）
 * 竖长柜体：顶部灯箱 + 中部玻璃仓（能看见里面的毛绒剪影）+ 底部取物口。
 * 不平铺（ClampToEdge），这是"正面资产"。
 */
function drawClawCabinet(size) {
  const r = rng(131);
  const albedo = newCanvas(size);
  const a = albedo.getContext('2d');
  const ku = size / 512;

  a.fillStyle = BASE_COLORS.raise;
  a.fillRect(0, 0, size, size);

  // 顶部灯箱：紫→冰蓝渐变，暖黄描边（霓虹三色同框，是电玩城的视觉签名）
  const headH = size * 0.2;
  const hg = a.createLinearGradient(0, 0, 0, headH);
  hg.addColorStop(0, NEON.purple);
  hg.addColorStop(1, NEON_DIM.purple);
  a.fillStyle = hg;
  a.fillRect(0, 0, size, headH);
  neonRect(a, 0, 0, size, headH, NEON.warm, 5 * ku, 0.6);
  a.fillStyle = SEMANTIC.textHi;
  a.font = `bold ${Math.round(size * 0.085)}px system-ui, sans-serif`;
  a.textAlign = 'center';
  a.textBaseline = 'middle';
  a.fillText('CLAW', size / 2, headH * 0.52);
  // 灯箱下沿的一道冰蓝灯管
  neonLine(a, 0, headH + 4 * ku, size, headH + 4 * ku, NEON.ice, 5 * ku, 0.7);

  // 中部玻璃仓：深色玻璃 + 内部毛绒剪影 + 玻璃反光斜带
  const cabY = headH + size * 0.03;
  const cabH = size * 0.55;
  const cabX = size * 0.08;
  const cabW = size * 0.84;
  const glass = a.createLinearGradient(cabX, cabY, cabX, cabY + cabH);
  glass.addColorStop(0, 'rgba(52,72,96,0.95)');
  glass.addColorStop(1, 'rgba(22,32,46,0.98)');
  a.fillStyle = glass;
  roundRectPath(a, cabX, cabY, cabW, cabH, 10 * ku);
  a.fill();

  // 里面的毛绒玩偶剪影（低多边形：用三角/圆角块堆出来，不画细节）
  const toys = [
    { x: 0.24, y: 0.72, s: 0.1, c: '#B06CD8' },
    { x: 0.42, y: 0.78, s: 0.085, c: '#E8A94E' },
    { x: 0.58, y: 0.7, s: 0.095, c: '#6FCF97' },
    { x: 0.74, y: 0.78, s: 0.08, c: '#4FD1E8' },
    { x: 0.34, y: 0.88, s: 0.075, c: '#EB5757' },
    { x: 0.66, y: 0.9, s: 0.07, c: '#D8DCE6' },
  ];
  for (const t of toys) {
    const cx = cabX + t.x * cabW;
    const cy = cabY + t.y * cabH;
    const rad = t.s * cabW * 0.5;
    a.fillStyle = shade(t.c, 0.85);
    a.beginPath();
    a.arc(cx, cy - rad * 0.5, rad, 0, Math.PI * 2);      // 头
    a.fill();
    a.beginPath();
    a.ellipse(cx, cy + rad * 0.55, rad * 0.9, rad * 0.8, 0, 0, Math.PI * 2); // 身
    a.fill();
    // 耳朵（两个小圆）
    a.beginPath();
    a.arc(cx - rad * 0.7, cy - rad * 1.05, rad * 0.36, 0, Math.PI * 2);
    a.arc(cx + rad * 0.7, cy - rad * 1.05, rad * 0.36, 0, Math.PI * 2);
    a.fill();
  }

  // 抓手（桁架 + 三爪）
  const gx = cabX + cabW * 0.5;
  const gy = cabY + cabH * 0.16;
  a.strokeStyle = shade(SEMANTIC.textMid, 0.9);
  a.lineWidth = 4 * ku;
  a.beginPath();
  a.moveTo(cabX, gy - 6 * ku);
  a.lineTo(cabX + cabW, gy - 6 * ku);
  a.stroke();
  a.beginPath();
  a.moveTo(gx, gy - 6 * ku);
  a.lineTo(gx, gy + 10 * ku);
  a.stroke();
  a.lineWidth = 5 * ku;
  a.strokeStyle = shade(NEON.ice, 0.8);
  for (const dx of [-1, 0, 1]) {
    a.beginPath();
    a.moveTo(gx, gy + 10 * ku);
    a.lineTo(gx + dx * 6 * ku, gy + 26 * ku);
    a.stroke();
  }

  // 玻璃反光斜带（两道，低透明度，玻璃感的关键）
  a.save();
  roundRectPath(a, cabX, cabY, cabW, cabH, 10 * ku);
  a.clip();
  a.globalAlpha = 0.13;
  a.fillStyle = '#DFEBFF';
  a.beginPath();
  a.moveTo(cabX + cabW * 0.05, cabY + cabH);
  a.lineTo(cabX + cabW * 0.35, cabY);
  a.lineTo(cabX + cabW * 0.48, cabY);
  a.lineTo(cabX + cabW * 0.18, cabY + cabH);
  a.closePath();
  a.fill();
  a.globalAlpha = 0.07;
  a.beginPath();
  a.moveTo(cabX + cabW * 0.5, cabY + cabH);
  a.lineTo(cabX + cabW * 0.72, cabY);
  a.lineTo(cabX + cabW * 0.78, cabY);
  a.lineTo(cabX + cabW * 0.56, cabY + cabH);
  a.closePath();
  a.fill();
  a.restore();

  // 玻璃仓霓虹边框
  neonRect(a, cabX, cabY, cabW, cabH, NEON.ice, 5 * ku, 0.65);
  // 玻璃竖棂
  a.strokeStyle = shade(NEON_DIM.ice, 1, 0.5);
  a.lineWidth = 3 * ku;
  for (const px of [0.36, 0.64]) {
    a.beginPath();
    a.moveTo(cabX + cabW * px, cabY);
    a.lineTo(cabX + cabW * px, cabY + cabH);
    a.stroke();
  }

  // 底部取物口
  const doorY = cabY + cabH + size * 0.035;
  const doorH = size - doorY - size * 0.03;
  a.fillStyle = '#0B1017';
  roundRectPath(a, size * 0.2, doorY, size * 0.6, doorH, 8 * ku);
  a.fill();
  neonRect(a, size * 0.2, doorY, size * 0.6, doorH, NEON.purple, 4 * ku, 0.5);
  // 投币口
  a.fillStyle = BASE_COLORS.raise;
  a.fillRect(size * 0.72, doorY + doorH * 0.2, size * 0.16, doorH * 0.18);
  a.fillStyle = '#080C12';
  a.fillRect(size * 0.74, doorY + doorH * 0.25, size * 0.12, doorH * 0.05);

  // 侧边散热格栅
  for (let i = 0; i < 7; i++) {
    a.fillStyle = 'rgba(0,0,0,0.35)';
    a.fillRect(size * 0.02, size * 0.84 + i * 7 * ku, size * 0.045, 3 * ku);
    a.fillRect(size * 0.935, size * 0.84 + i * 7 * ku, size * 0.045, 3 * ku);
  }
  // 细碎磨损
  for (let k = 0; k < 120; k++) {
    a.globalAlpha = 0.05;
    a.fillStyle = r() > 0.5 ? '#000' : NEON_DIM.ice;
    a.fillRect(r() * size, r() * size, 2 * ku, 2 * ku);
  }
  a.globalAlpha = 1;

  return { albedo: clampLuma(albedo), height: null, rough: null, emissive: true };
}

/**
 * ③弹珠机面板（需求F）
 * 从上到下：标题灯箱 → 落珠路径示意（钉子阵列）→ 底部落槽色块 → 控制区。
 * 不平铺，正面资产。
 */
function drawPachinkoPanel(size) {
  const r = rng(149);
  const albedo = newCanvas(size);
  const a = albedo.getContext('2d');
  const ku = size / 512;

  // 面板底色：紫调深色（比普通柜体更"电子"）
  const bg = a.createLinearGradient(0, 0, 0, size);
  bg.addColorStop(0, '#241A33');
  bg.addColorStop(0.5, '#171324');
  bg.addColorStop(1, '#101019');
  a.fillStyle = bg;
  a.fillRect(0, 0, size, size);

  // 外框霓虹
  neonRect(a, 6 * ku, 6 * ku, size - 12 * ku, size - 12 * ku, NEON.purple, 6 * ku, 0.7);

  // 顶部标题灯箱
  const headH = size * 0.14;
  const hg = a.createLinearGradient(0, 0, size, headH);
  hg.addColorStop(0, NEON.purple);
  hg.addColorStop(0.55, mix(NEON.purple, NEON.ice, 0.5));
  hg.addColorStop(1, NEON.ice);
  a.fillStyle = hg;
  a.fillRect(size * 0.03, size * 0.03, size * 0.94, headH);
  a.fillStyle = SEMANTIC.textHi;
  a.font = `bold ${Math.round(size * 0.072)}px system-ui, sans-serif`;
  a.textAlign = 'center';
  a.textBaseline = 'middle';
  a.fillText('PACHINKO', size / 2, size * 0.03 + headH * 0.52);
  // 灯箱里的跑马灯点
  for (let i = 0; i < 24; i++) {
    const x = size * 0.04 + (i / 23) * size * 0.92;
    a.fillStyle = i % 3 === 0 ? NEON.warm : shade(NEON.warm, 0.55);
    a.beginPath();
    a.arc(x, size * 0.03 + headH - 9 * ku, 3.2 * ku, 0, Math.PI * 2);
    a.fill();
  }

  // 落珠区：钉子阵列（6 行 × 7 列，与 config.MINIGAME.pachinko 的 pegRows/pegCols 一致）
  const areaTop = size * 0.21;
  const areaH = size * 0.5;
  const areaX = size * 0.07;
  const areaW = size * 0.86;
  a.fillStyle = 'rgba(8,10,18,0.55)';
  roundRectPath(a, areaX, areaTop, areaW, areaH, 12 * ku);
  a.fill();
  neonRect(a, areaX, areaTop, areaW, areaH, NEON_DIM.ice, 3 * ku, 0.4);

  const rows = 6;
  const cols = 7;
  for (let ri = 0; ri < rows; ri++) {
    for (let ci = 0; ci < cols; ci++) {
      // 奇偶行错开半格，这才是真实弹珠机的钉子排布
      const off = ri % 2 === 0 ? 0 : 0.5;
      const x = areaX + ((ci + off + 0.5) / (cols + 0.5)) * areaW;
      const y = areaTop + ((ri + 0.8) / (rows + 0.6)) * areaH;
      // 钉子是亮银点 + 一圈冷光（低多边形：一个圆点足够）
      const grd = a.createRadialGradient(x, y, 0, x, y, 11 * ku);
      grd.addColorStop(0, shade(NEON.ice, 1.5));
      grd.addColorStop(0.45, NEON.ice);
      grd.addColorStop(1, 'rgba(79,209,232,0)');
      a.fillStyle = grd;
      a.beginPath();
      a.arc(x, y, 11 * ku, 0, Math.PI * 2);
      a.fill();
      a.fillStyle = SEMANTIC.textHi;
      a.beginPath();
      a.arc(x, y, 3.4 * ku, 0, Math.PI * 2);
      a.fill();
    }
  }

  // 底部落槽色块（5 格，与 config 的 slots 数量一致；分值越高越暖）
  const slotY = size * 0.755;
  const slotH = size * 0.085;
  const slotColors = [BASE_COLORS.deep, NEON_DIM.ice, NEON.ice, NEON.warm, SEMANTIC.danger];
  const slotLabels = ['空', '小', '中', '大', 'JP'];
  const slotW = (areaW - 8 * ku * 4) / 5;
  for (let i = 0; i < 5; i++) {
    const x = areaX + i * (slotW + 8 * ku);
    a.fillStyle = mix('#0B0E15', slotColors[i], 0.55);
    roundRectPath(a, x, slotY, slotW, slotH, 6 * ku);
    a.fill();
    neonRect(a, x, slotY, slotW, slotH, slotColors[i], 3 * ku, i >= 3 ? 0.7 : 0.35);
    a.fillStyle = i >= 3 ? '#1A1206' : SEMANTIC.textHi;
    a.font = `bold ${Math.round(size * 0.03)}px system-ui, sans-serif`;
    a.fillText(slotLabels[i], x + slotW / 2, slotY + slotH * 0.52);
  }

  // 控制区：投币口 + 旋钮 + 按钮
  const ctrlY = size * 0.875;
  a.fillStyle = BASE_COLORS.raise;
  roundRectPath(a, areaX, ctrlY, areaW, size * 0.085, 10 * ku);
  a.fill();
  // 投币口
  a.fillStyle = '#070A0F';
  a.fillRect(areaX + areaW * 0.06, ctrlY + size * 0.028, areaW * 0.16, size * 0.014);
  // 旋钮
  const knobX = areaX + areaW * 0.42;
  const knobY = ctrlY + size * 0.042;
  a.fillStyle = '#20283A';
  a.beginPath();
  a.arc(knobX, knobY, size * 0.032, 0, Math.PI * 2);
  a.fill();
  neonLine(a, knobX, knobY, knobX, knobY - size * 0.026, NEON.ice, 4 * ku, 0.8);
  // 按钮（暖黄 / 红）
  for (const [bx, col] of [[0.62, NEON.warm], [0.76, SEMANTIC.danger]]) {
    a.fillStyle = shade(col, 0.75);
    a.beginPath();
    a.arc(areaX + areaW * bx, knobY, size * 0.026, 0, Math.PI * 2);
    a.fill();
    a.fillStyle = col;
    a.beginPath();
    a.arc(areaX + areaW * bx - size * 0.004, knobY - size * 0.004, size * 0.017, 0, Math.PI * 2);
    a.fill();
  }

  // 面板高光（左上到右下的一条淡扫光，让平涂面有体积）
  const sh = a.createLinearGradient(0, 0, size, size);
  sh.addColorStop(0, 'rgba(255,255,255,0.07)');
  sh.addColorStop(0.45, 'rgba(255,255,255,0)');
  sh.addColorStop(1, 'rgba(0,0,0,0.18)');
  a.fillStyle = sh;
  a.fillRect(0, 0, size, size);

  for (let k = 0; k < 90; k++) {
    a.globalAlpha = 0.04;
    a.fillStyle = r() > 0.5 ? '#000' : NEON_DIM.purple;
    a.fillRect(r() * size, r() * size, 2 * ku, 2 * ku);
  }
  a.globalAlpha = 1;

  return { albedo: clampLuma(albedo), height: null, rough: null, emissive: true };
}

/**
 * ④货架商品柜（需求F）—— 三层货架正面 + 整齐的商品色块
 * 平铺（但用较大的 texScale 让它接近"一柜一贴"）。带 emissive，商品格有背光。
 */
function drawShelfCabinet(size) {
  const r = rng(167);
  const albedo = newCanvas(size);
  const height = newCanvas(size);
  const rough = newCanvas(size);
  const a = albedo.getContext('2d');
  const h = height.getContext('2d');
  const g = rough.getContext('2d');
  const ku = size / 512;

  // 柜体深色底
  a.fillStyle = BASE_COLORS.mid;
  a.fillRect(0, 0, size, size);
  h.fillStyle = '#B8B8B8';
  h.fillRect(0, 0, size, size);
  g.fillStyle = '#7A7A7A';
  g.fillRect(0, 0, size, size);

  // 立柱（左右 + 中间两道，金属冷色）
  const posts = [0.03, 0.36, 0.66, 0.965];
  for (const p of posts) {
    const x = size * p;
    const w = size * 0.035;
    const grad = a.createLinearGradient(x, 0, x + w, 0);
    grad.addColorStop(0, '#2A3240');
    grad.addColorStop(0.4, '#4A5464');
    grad.addColorStop(1, '#232A36');
    a.fillStyle = grad;
    a.fillRect(x, 0, w, size);
    h.fillStyle = '#E0E0E0';
    h.fillRect(x, 0, w, size);
    g.fillStyle = '#4A4A4A';
    g.fillRect(x, 0, w, size);
  }

  // 三层货架，每层有层板 + 背板灯带 + 商品
  const rows = 3;
  const palette = ['#4A90D9', NEON.warm, '#6FCF97', '#B08BD8', '#EB5757', NEON.ice, '#D8DCE6'];
  for (let ri = 0; ri < rows; ri++) {
    const y0 = size * (0.06 + ri * 0.31);
    const y1 = y0 + size * 0.26;

    // 背板（比柜体亮一档 → 商品背光）
    const bh = a.createLinearGradient(0, y0, 0, y1);
    bh.addColorStop(0, 'rgba(58,74,102,0.85)');
    bh.addColorStop(1, 'rgba(26,34,48,0.9)');
    a.fillStyle = bh;
    a.fillRect(size * 0.065, y0, size * 0.87, y1 - y0);
    // 背板灯带（暖黄，层板下沿）
    a.fillStyle = 'rgba(232,169,78,0.5)';
    a.fillRect(size * 0.065, y1 - size * 0.012, size * 0.87, size * 0.008);

    // 层板
    a.fillStyle = '#2E3646';
    a.fillRect(size * 0.05, y1, size * 0.9, size * 0.022);
    h.fillStyle = '#F0F0F0';
    h.fillRect(size * 0.05, y1, size * 0.9, size * 0.022);
    g.fillStyle = '#5A5A5A';
    g.fillRect(size * 0.05, y1, size * 0.9, size * 0.022);

    // 商品：沿层板排 5 个，每个是圆角块 + 一条高光（低多边形，不画标签细节）
    const cnt = 5;
    const gap = size * 0.87 / cnt;
    for (let i = 0; i < cnt; i++) {
      const bx = size * 0.065 + i * gap + gap * 0.15;
      const bw = gap * 0.7;
      const bh2 = (y1 - y0) * (0.5 + r() * 0.3);
      const by = y1 - bh2;
      const col = palette[Math.floor(r() * palette.length)];
      a.fillStyle = col;
      roundRectPath(a, bx, by, bw, bh2, 4 * ku);
      a.fill();
      // 左缘高光 + 右缘暗边（廉价但有体积感的卡通做法）
      a.fillStyle = 'rgba(255,255,255,0.16)';
      a.fillRect(bx + bw * 0.08, by + bh2 * 0.12, bw * 0.14, bh2 * 0.72);
      a.fillStyle = 'rgba(0,0,0,0.22)';
      a.fillRect(bx + bw * 0.82, by + bh2 * 0.1, bw * 0.14, bh2 * 0.78);
      // 顶部封口（瓶盖 / 盒盖）
      a.fillStyle = shade(col, 1.35);
      a.fillRect(bx + bw * 0.2, by - bh2 * 0.1, bw * 0.6, bh2 * 0.12);
    }
  }

  // 顶部灯箱条
  a.fillStyle = mix(NEON.warm, NEON_DIM.warm, 0.4);
  a.fillRect(0, 0, size, size * 0.045);
  neonLine(a, 0, size * 0.045, size, size * 0.045, NEON.warm, 4 * ku, 0.5);

  // 柜脚
  a.fillStyle = '#12171F';
  a.fillRect(0, size * 0.975, size, size * 0.025);

  return { albedo: clampLuma(albedo), height, rough };
}

/**
 * ⑦UI 悬浮交互提示框（需求F）
 * 注意：这张贴图不是 3D 物体的表面，而是**磨砂玻璃面板的底**。
 * 画法刻意做成"半透玻璃"：中间半透明深色 + 细微噪点 + 顶部高光 + 霓虹描边，
 * 让 HUD 用它做背景时能透出后面的场景（真正的磨砂由 CSS backdrop-filter 完成，
 * 这里提供的是玻璃的**质感底**与圆角形状）。
 */
function drawUiHint(size) {
  const r = rng(181);
  const albedo = newCanvas(size);
  const a = albedo.getContext('2d');
  const ku = size / 512;

  a.clearRect(0, 0, size, size);

  // 玻璃主体：从左上到右下略微变亮的深色半透渐变
  const gg = a.createLinearGradient(0, 0, size, size);
  gg.addColorStop(0, 'rgba(40,50,68,0.72)');
  gg.addColorStop(0.5, 'rgba(30,38,53,0.66)');
  gg.addColorStop(1, 'rgba(22,28,40,0.74)');
  a.fillStyle = gg;
  roundRectPath(a, 8 * ku, 8 * ku, size - 16 * ku, size - 16 * ku, size * 0.11);
  a.fill();

  // 噪点（磨砂的关键：细微不均匀才像磨砂，纯平涂像塑料）
  const dots = Math.round(9000 * (size / 512) ** 2);
  for (let k = 0; k < dots; k++) {
    const x = 12 * ku + r() * (size - 24 * ku);
    const y = 12 * ku + r() * (size - 24 * ku);
    a.globalAlpha = 0.012 + r() * 0.02;
    a.fillStyle = r() > 0.5 ? '#FFFFFF' : '#000000';
    a.fillRect(x, y, 2 * ku, 2 * ku);
  }
  a.globalAlpha = 1;

  // 顶部内侧高光带（玻璃厚度感）
  a.save();
  roundRectPath(a, 8 * ku, 8 * ku, size - 16 * ku, size - 16 * ku, size * 0.11);
  a.clip();
  const hl = a.createLinearGradient(0, 8 * ku, 0, size * 0.3);
  hl.addColorStop(0, 'rgba(255,255,255,0.14)');
  hl.addColorStop(1, 'rgba(255,255,255,0)');
  a.fillStyle = hl;
  a.fillRect(0, 8 * ku, size, size * 0.3);
  // 底部内侧的霓虹反光
  const bl = a.createLinearGradient(0, size * 0.82, 0, size - 8 * ku);
  bl.addColorStop(0, 'rgba(177,91,216,0)');
  bl.addColorStop(1, 'rgba(177,91,216,0.18)');
  a.fillStyle = bl;
  a.fillRect(0, size * 0.82, size, size * 0.18);
  a.restore();

  // 圆角霓虹描边
  a.strokeStyle = 'rgba(180,200,230,0.30)';
  a.lineWidth = 3 * ku;
  roundRectPath(a, 8 * ku, 8 * ku, size - 16 * ku, size - 16 * ku, size * 0.11);
  a.stroke();
  // 上沿更亮的一道（光源来自上方）
  a.strokeStyle = 'rgba(220,235,255,0.22)';
  a.lineWidth = 5 * ku;
  a.beginPath();
  a.moveTo(size * 0.16, 10 * ku);
  a.lineTo(size * 0.84, 10 * ku);
  a.stroke();

  // 左侧的霓虹指示条（提示框的"强调边"，UI 用 E 键提示时会亮起）
  const barX = 40 * ku;
  const barY = size * 0.3;
  const barH = size * 0.4;
  neonLine(a, barX, barY, barX, barY + barH, NEON.purple, 8 * ku, 0.85);

  // 内容占位示意：一个图标位 + 两行文字条（真正的文字由 HUD 用 DOM 覆盖）
  const iconX = size * 0.26;
  const iconY = size * 0.5;
  const iconR = size * 0.13;
  a.fillStyle = 'rgba(79,209,232,0.22)';
  a.beginPath();
  a.arc(iconX, iconY, iconR, 0, Math.PI * 2);
  a.fill();
  a.strokeStyle = 'rgba(79,209,232,0.5)';
  a.lineWidth = 4 * ku;
  a.stroke();

  a.fillStyle = 'rgba(236,241,248,0.22)';
  roundRectPath(a, size * 0.45, size * 0.4, size * 0.4, size * 0.075, 6 * ku);
  a.fill();
  a.fillStyle = 'rgba(168,180,198,0.14)';
  roundRectPath(a, size * 0.45, size * 0.53, size * 0.28, size * 0.06, 6 * ku);
  a.fill();

  return { albedo, height: null, rough: null, transparent: true };
}

/**
 * 街机屏幕（发光画面，不平铺）
 *
 * ⚠ 事故记录：旧实现往 16×16 网格里随机塞 90 个彩色方块，渲染出来就是
 * **紫/绿/黄相间的棋盘格马赛克** —— 玩家当成"贴图加载失败的错误占位材质"。
 * 现在改成正经的电玩画面：顶部跑马灯 + 得分界面 + 像素游玩区 + 底部提示。
 * 结构化排版（横向分层）而不是均匀格子，从任何角度看都不会再读成棋盘格。
 */
function drawScreen(size) {
  const r = rng(101);
  const canvas = newCanvas(size);
  const c = canvas.getContext('2d');
  const u = size / 256;

  // 背景：深紫 → 深蓝 → 近黑
  const grad = c.createLinearGradient(0, 0, 0, size);
  grad.addColorStop(0, '#150B33');
  grad.addColorStop(0.55, '#0B1730');
  grad.addColorStop(1, '#080F1E');
  c.fillStyle = grad;
  c.fillRect(0, 0, size, size);

  // 顶部跑马灯：三条霓虹色带 + 一排灯点
  const mqH = size * 0.16;
  c.fillStyle = '#1B2540';
  c.fillRect(0, 0, size, mqH);
  const mq = [NEON.purple, NEON.ice, NEON.warm];
  for (let i = 0; i < mq.length; i++) {
    c.fillStyle = mq[i];
    c.globalAlpha = 0.92;
    c.fillRect(size * (0.06 + i * 0.31), mqH * 0.26, size * 0.26, mqH * 0.48);
  }
  c.globalAlpha = 1;
  for (let i = 0; i < 12; i++) {
    c.fillStyle = i % 2 ? NEON.warm : NEON.ice;
    c.beginPath();
    c.arc(size * (0.05 + i * 0.082), mqH + 9 * u, 3.2 * u, 0, Math.PI * 2);
    c.fill();
  }

  // 得分界面
  c.fillStyle = 'rgba(10,16,30,0.85)';
  c.fillRect(size * 0.06, size * 0.23, size * 0.88, size * 0.15);
  c.font = `bold ${Math.round(size * 0.068)}px ui-monospace, Consolas, monospace`;
  c.textBaseline = 'middle';
  c.textAlign = 'left';
  c.fillStyle = NEON.warm;
  c.fillText('1-UP', size * 0.09, size * 0.305);
  c.fillStyle = '#EAF2FF';
  c.fillText(`0${Math.floor(r() * 900 + 100)}`, size * 0.225, size * 0.305);
  c.textAlign = 'right';
  c.fillStyle = NEON.ice;
  c.fillText('HI-SCORE', size * 0.91, size * 0.305);
  c.fillStyle = '#EAF2FF';
  c.fillText(`12${Math.floor(r() * 900 + 100)}`, size * 0.90, size * 0.305);

  // 游玩区：一条地平线 + 若干像素角色（错落分布，不是均匀格子）
  const fy = size * 0.63;
  c.fillStyle = 'rgba(79,209,232,0.20)';
  c.fillRect(size * 0.06, fy, size * 0.88, 2 * u);
  const pal = [NEON.ice, NEON.purple, NEON.warm, '#7BFF6B'];
  for (let i = 0; i < 7; i++) {
    const bw = size * (0.05 + r() * 0.05);
    const bh = size * (0.06 + r() * 0.10);
    const x = size * (0.09 + i * 0.12) + (r() - 0.5) * 6 * u;
    const y = fy - bh;
    c.fillStyle = pal[Math.floor(r() * pal.length)];
    c.fillRect(x, y, bw, bh);
    // 两只"眼睛"，让它读成角色而不是色块
    c.fillStyle = 'rgba(255,255,255,0.6)';
    c.fillRect(x + bw * 0.22, y + bh * 0.18, bw * 0.16, bh * 0.22);
    c.fillRect(x + bw * 0.60, y + bh * 0.18, bw * 0.16, bh * 0.22);
  }

  // 底部提示行
  c.fillStyle = 'rgba(10,16,30,0.85)';
  c.fillRect(size * 0.06, size * 0.80, size * 0.88, size * 0.12);
  c.fillStyle = NEON.ice;
  c.font = `bold ${Math.round(size * 0.056)}px ui-monospace, Consolas, monospace`;
  c.textAlign = 'center';
  c.fillText('INSERT COIN · PRESS START', size / 2, size * 0.86);

  // 扫描线
  for (let y = 0; y < size; y += 4) {
    c.fillStyle = 'rgba(0,0,0,0.22)';
    c.fillRect(0, y, size, 2);
  }
  // 暗角
  const vg = c.createRadialGradient(size / 2, size / 2, size * 0.25, size / 2, size / 2, size * 0.74);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.5)');
  c.fillStyle = vg;
  c.fillRect(0, 0, size, size);

  return { albedo: clampLuma(canvas), height: null, rough: null, emissive: true };
}

/**
 * ①饮料售货机表面（需求F）
 * 正面资产，不平铺：灯箱 + 玻璃商品陈列（能看见瓶身）+ 取货口 + 支付区。
 * 带 emissive —— 售货机是夜里的主要光源之一。
 */
function drawVending(size) {
  const r = rng(113);
  const albedo = newCanvas(size);
  const a = albedo.getContext('2d');
  const ku = size / 512;

  // 机身
  const body = a.createLinearGradient(0, 0, size, 0);
  body.addColorStop(0, '#1A2330');
  body.addColorStop(0.5, '#232E3F');
  body.addColorStop(1, '#161D28');
  a.fillStyle = body;
  a.fillRect(0, 0, size, size);

  // 顶部灯箱：暖黄（品牌色），夜里最醒目
  const headH = size * 0.15;
  const hg = a.createLinearGradient(0, 0, 0, headH);
  hg.addColorStop(0, shade(NEON.warm, 1.15));
  hg.addColorStop(1, NEON_DIM.warm);
  a.fillStyle = hg;
  a.fillRect(size * 0.03, size * 0.025, size * 0.94, headH);
  a.fillStyle = '#241A0B';
  a.font = `bold ${Math.round(size * 0.088)}px system-ui, sans-serif`;
  a.textAlign = 'center';
  a.textBaseline = 'middle';
  a.fillText('DRINKS', size / 2, size * 0.025 + headH * 0.52);
  // 灯箱冰蓝下沿灯管
  neonLine(a, size * 0.04, size * 0.025 + headH + 6 * ku, size * 0.96, size * 0.025 + headH + 6 * ku, NEON.ice, 5 * ku, 0.7);

  // 商品陈列窗：深色玻璃 + 3 列 × 4 行饮料
  const winY = size * 0.21;
  const winH = size * 0.54;
  const winX = size * 0.07;
  const winW = size * 0.7;
  const winGrad = a.createLinearGradient(winX, winY, winX, winY + winH);
  winGrad.addColorStop(0, 'rgba(46,64,86,0.92)');
  winGrad.addColorStop(1, 'rgba(16,24,34,0.96)');
  a.fillStyle = winGrad;
  roundRectPath(a, winX, winY, winW, winH, 10 * ku);
  a.fill();

  // 每格背后的灯带（让饮料有背光，这是售货机的灵魂）
  const cols = 3;
  const rows = 4;
  const gw = winW / cols;
  const gh = winH / rows;
  const palette = ['#4A90D9', NEON.warm, '#6FCF97', '#B08BD8', '#EB5757', NEON.ice, '#D8DCE6', '#F2C879'];
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const gx = winX + i * gw;
      const gy = winY + j * gh;
      // 格背光
      const bg2 = a.createLinearGradient(0, gy, 0, gy + gh);
      bg2.addColorStop(0, 'rgba(232,169,78,0.16)');
      bg2.addColorStop(1, 'rgba(232,169,78,0.04)');
      a.fillStyle = bg2;
      a.fillRect(gx + gw * 0.08, gy + gh * 0.12, gw * 0.84, gh * 0.76);

      // 瓶身：圆角矩形 + 瓶颈 + 高光
      const col = palette[Math.floor(r() * palette.length)];
      const bw = gw * 0.42;
      const bh = gh * 0.62;
      const bx = gx + (gw - bw) / 2;
      const by = gy + gh * 0.3;
      a.fillStyle = col;
      roundRectPath(a, bx, by, bw, bh, 5 * ku);
      a.fill();
      a.fillStyle = shade(col, 1.3);
      a.fillRect(bx + bw * 0.42, by - gh * 0.1, bw * 0.16, gh * 0.12); // 瓶颈
      a.fillStyle = 'rgba(255,255,255,0.28)';                          // 高光
      a.fillRect(bx + bw * 0.14, by + bh * 0.1, bw * 0.16, bh * 0.68);
      a.fillStyle = 'rgba(0,0,0,0.28)';                                // 暗边
      a.fillRect(bx + bw * 0.76, by + bh * 0.08, bw * 0.18, bh * 0.72);
      // 标签环
      a.fillStyle = 'rgba(255,255,255,0.55)';
      a.fillRect(bx + bw * 0.1, by + bh * 0.44, bw * 0.8, bh * 0.14);
    }
  }

  // 玻璃反光斜带
  a.save();
  roundRectPath(a, winX, winY, winW, winH, 10 * ku);
  a.clip();
  a.globalAlpha = 0.12;
  a.fillStyle = '#DFEBFF';
  a.beginPath();
  a.moveTo(winX + winW * 0.1, winY + winH);
  a.lineTo(winX + winW * 0.42, winY);
  a.lineTo(winX + winW * 0.54, winY);
  a.lineTo(winX + winW * 0.22, winY + winH);
  a.closePath();
  a.fill();
  a.restore();
  neonRect(a, winX, winY, winW, winH, NEON_DIM.ice, 4 * ku, 0.45);

  // 右侧操作区：支付面板 + 选货按钮列
  const panelX = size * 0.81;
  const panelW = size * 0.15;
  a.fillStyle = '#101823';
  roundRectPath(a, panelX, winY, panelW, winH * 0.62, 8 * ku);
  a.fill();
  neonRect(a, panelX, winY, panelW, winH * 0.62, NEON.ice, 3 * ku, 0.4);
  // 小屏幕（显示价格）
  a.fillStyle = '#0B2C33';
  a.fillRect(panelX + panelW * 0.14, winY + winH * 0.06, panelW * 0.72, winH * 0.14);
  a.fillStyle = NEON.ice;
  a.font = `bold ${Math.round(size * 0.026)}px monospace`;
  a.textAlign = 'center';
  a.fillText('¥5.00', panelX + panelW * 0.5, winY + winH * 0.155);
  // 选货键 3×4（与商品格一一对应）
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const bx = panelX + panelW * (0.16 + i * 0.24);
      const by = winY + winH * (0.26 + j * 0.09);
      a.fillStyle = '#26303F';
      roundRectPath(a, bx, by, panelW * 0.2, winH * 0.06, 3 * ku);
      a.fill();
      a.fillStyle = 'rgba(79,209,232,0.55)';
      a.fillRect(bx + panelW * 0.04, by + winH * 0.024, panelW * 0.12, winH * 0.012);
    }
  }
  // 投币 / 刷卡口
  a.fillStyle = '#070A0F';
  a.fillRect(panelX + panelW * 0.2, winY + winH * 0.68, panelW * 0.6, winH * 0.035);
  a.fillStyle = shade(NEON.warm, 0.9);
  a.fillRect(panelX + panelW * 0.2, winY + winH * 0.72, panelW * 0.6, winH * 0.012);

  // 取货口
  const outY = winY + winH + size * 0.035;
  const outH = size * 0.13;
  a.fillStyle = '#080C12';
  roundRectPath(a, size * 0.12, outY, size * 0.76, outH, 8 * ku);
  a.fill();
  // 里面的挡板
  a.fillStyle = 'rgba(40,52,68,0.9)';
  a.fillRect(size * 0.14, outY + outH * 0.55, size * 0.72, outH * 0.4);
  neonLine(a, size * 0.12, outY, size * 0.88, outY, NEON.purple, 4 * ku, 0.5);

  // 底部散热格栅
  for (let i = 0; i < 16; i++) {
    a.fillStyle = 'rgba(0,0,0,0.4)';
    a.fillRect(size * 0.08 + i * (size * 0.84 / 16), size * 0.955, size * 0.032, size * 0.018);
  }
  // 磨损
  for (let k = 0; k < 140; k++) {
    a.globalAlpha = 0.04 + r() * 0.04;
    a.fillStyle = r() > 0.5 ? '#000' : NEON_DIM.ice;
    a.fillRect(r() * size, r() * size, 2 * ku, 2 * ku);
  }
  a.globalAlpha = 1;

  return { albedo: clampLuma(albedo), height: null, rough: null, emissive: true };
}

/** 夜空（天空球用，仅 albedo：顶部深蓝 → 地平线微亮 + 星点） */
function drawSky(size) {
  const r = rng(211);
  const canvas = newCanvas(size);
  const c = canvas.getContext('2d');
  const grad = c.createLinearGradient(0, 0, 0, size);
  grad.addColorStop(0, '#05080F');
  grad.addColorStop(0.55, '#0D1420');
  grad.addColorStop(1, '#1D2940');
  c.fillStyle = grad;
  c.fillRect(0, 0, size, size);
  const stars = Math.round(180 * (size / 128));
  for (let k = 0; k < stars; k++) {
    const x = r() * size;
    const y = r() * size * 0.62;
    c.globalAlpha = 0.2 + r() * 0.7;
    c.fillStyle = '#DDE6F5';
    const s = Math.max(1, size / 128 * 1.4);
    c.fillRect(x, y, s, s);
  }
  c.globalAlpha = 1;
  return { albedo: clampLuma(canvas), height: null, rough: null };
}

/** 天花板 */
function drawCeiling(size) {
  const r = rng(127);
  const { albedo, height, rough, a, h, g } = layers(size, {
    base: BASE_COLORS.ceiling, baseH: '#C0C0C0', baseR: '#E6E6E6',
  });
  const ku = size / 128;
  // 低多边形吸音板：2×2 分格，缝深色
  a.fillStyle = '#0B0F17';
  a.fillRect(size / 2 - 3 * ku, 0, 6 * ku, size);
  a.fillRect(0, size / 2 - 3 * ku, size, 6 * ku);
  h.fillStyle = '#7A7A7A';
  h.fillRect(size / 2 - 3 * ku, 0, 6 * ku, size);
  h.fillRect(0, size / 2 - 3 * ku, size, 6 * ku);
  for (let k = 0; k < 300; k++) {
    const x = r() * size;
    const y = r() * size;
    a.globalAlpha = 0.05;
    a.fillStyle = '#000000';
    a.fillRect(x, y, 2 * ku, 2 * ku);
    a.globalAlpha = 1;
  }
  return { albedo: clampLuma(albedo), height, rough };
}

/** 水面（钓鱼池塘）—— 俯视贴图：波纹环 + 焦散亮点 + 霓虹反射条 */
function drawWater(size) {
  const r = rng(223);
  const { albedo, height, rough, a, h, g } = layers(size, {
    base: '#0E2A3A', baseH: '#3A6E84', baseR: '#5A6E78',
  });
  // 波纹同心环
  for (let k = 0; k < 30; k++) {
    const cx = r() * size, cy = r() * size;
    const rad = (18 + r() * 130) * (size / 256);
    a.globalAlpha = 0.08 + r() * 0.14;
    a.strokeStyle = r() > 0.5 ? NEON.ice : '#2E6E84';
    a.lineWidth = Math.max(1, (size / 256) * 2);
    a.beginPath();
    a.arc(cx, cy, rad, 0, Math.PI * 2);
    a.stroke();
  }
  a.globalAlpha = 1;
  // 焦散亮点（低多边形：小亮斑代替真实焦散）
  for (let k = 0; k < 260; k++) {
    const x = r() * size, y = r() * size;
    const rad = (1 + r() * 3) * (size / 256);
    a.globalAlpha = 0.10 + r() * 0.22;
    a.fillStyle = r() > 0.4 ? '#9FE8F4' : NEON.ice;
    a.beginPath();
    a.arc(x, y, rad, 0, Math.PI * 2);
    a.fill();
  }
  a.globalAlpha = 1;
  // 霓虹反射斜条（冰蓝 / 紫，低透明度，电玩城灯洒在水面的感觉）
  for (let k = 0; k < 4; k++) {
    const x0 = r() * size, y0 = r() * size;
    neonLine(a, x0, y0, x0 + size * 0.5, y0 + size * 0.18,
      k % 2 ? NEON.purple : NEON.ice, (size / 256) * 3, 0.18);
  }
  return { albedo: clampLuma(albedo), height, rough };
}

/**
 * 货箱（库存箱 / 后巷货箱 / 仓库存货堆）—— **牛皮纸纸箱**：瓦楞纤维 + 封箱胶带 + 墨色印标。
 *
 * 线上问题：正面读成"彩色棋盘格"。两个原因叠在一起：
 *   ① 底色是木箱 + 底部两排 6 色小方块，本身就是一块彩色马赛克；
 *   ② 箱子走 applyBoxUV(…, texScale = 1)，1.1×0.9×1.1 的箱体让贴图在一面上重复
 *      1.1 次 / 0.9 次，接缝把图案切成周期性子块 —— 马赛克于是变成了"棋盘格"。
 * 现在：底色换牛皮纸（瓦楞纹 + 折痕），图案改成结构化的纸箱要素（封箱胶带 / 条码 /
 * 规格线），**印刷只用深褐单色**，绝不出现彩色块；箱体改用 applyFaceUVAll 每面各铺满一次。
 */
function drawGoodsCrate(size) {
  const r = rng(241);
  const { albedo, height, rough, a, h } = layers(size, {
    base: '#BE9059', baseH: '#DCC79C', baseR: '#A2825C',
  });
  const u = size / 256;                 // 以 256px 为基准的缩放单位
  const px = (n) => Math.max(1, Math.round(n * u));

  // 瓦楞纤维：等距细横纹（等距才不像噪声）
  for (let y = 0; y < size; y += px(4)) {
    a.fillStyle = `rgba(122,88,46,${0.05 + 0.04 * ((y / px(4)) % 2)})`;
    a.fillRect(0, y, size, px(1));
  }
  // 纸板折痕：两条横折线，读成箱板的翻折而不是花纹
  for (const fy of [0.30, 0.72]) {
    a.fillStyle = 'rgba(92,64,30,0.26)';
    a.fillRect(0, size * fy, size, px(1.6));
    h.fillStyle = '#4A4A4A';
    h.fillRect(0, size * fy, size, px(1.6));
  }
  // 封箱胶带：居中竖向半透明一条（牛皮纸箱最常见的样子）
  a.fillStyle = 'rgba(232,214,176,0.52)';
  a.fillRect(size * 0.445, 0, size * 0.11, size);
  a.fillStyle = 'rgba(150,118,70,0.30)';
  a.fillRect(size * 0.445, 0, px(1), size);
  a.fillRect(size * 0.555 - px(1), 0, px(1), size);

  // 以下都是**深褐单色**印刷，不出彩色
  const ink = (al) => `rgba(58,40,20,${al})`;
  a.fillStyle = ink(0.85);
  a.font = `bold ${Math.round(size * 0.085)}px system-ui, sans-serif`;
  a.textAlign = 'center';
  a.textBaseline = 'middle';
  a.fillText('STOCK', size / 2, size * 0.40);
  // 条码块（等宽等距的竖条）
  const bx = size * 0.30, by = size * 0.55, bw = size * 0.40, bh = size * 0.095;
  a.fillStyle = ink(0.80);
  for (let cx = bx; cx + px(1.6) < bx + bw;) {
    a.fillRect(cx, by, px(1.6), bh);
    cx += px(4.2);
  }
  // 规格细线（左对齐的短横线，像纸箱上的印刷字段）
  for (let i = 0; i < 3; i++) {
    a.fillStyle = ink(0.42 - i * 0.08);
    a.fillRect(size * 0.30, size * (0.70 + i * 0.045), size * (0.30 - i * 0.06), px(1.4));
  }
  // 四角磨损（比底色略深的纸色斑，不是彩块）
  a.fillStyle = 'rgba(86,58,28,0.30)';
  for (const [cx, cy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    a.beginPath();
    a.arc(cx * size, cy * size, size * 0.07, 0, Math.PI * 2);
    a.fill();
  }
  return { albedo: clampLuma(albedo), height, rough };
}

/** 霓虹海报（墙面装饰，MeshBasicMaterial 自发光；variant 控制内容） */
export function drawPoster(size, variant = 0) {
  const r = rng(257 + variant * 13);
  const albedo = newCanvas(size);
  const a = albedo.getContext('2d');
  a.fillStyle = BASE_COLORS.deep;
  a.fillRect(0, 0, size, size);
  const pal = [NEON.purple, NEON.ice, NEON.warm];
  const col = pal[variant % pal.length];
  neonRect(a, size * 0.05, size * 0.05, size * 0.9, size * 0.9, col, size * 0.012, 0.8);
  const ads = [
    { emoji: '🎰', t: 'ARCADE' }, { emoji: '🍜', t: 'OPEN 24H' },
    { emoji: '🥤', t: 'SALE' }, { emoji: '🧸', t: 'NEW' }, { emoji: '🎣', t: 'FISHING' },
  ];
  const ad = ads[variant % ads.length];
  a.textAlign = 'center';
  a.textBaseline = 'middle';
  a.font = `bold ${Math.round(size * 0.2)}px system-ui, "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
  a.fillText(ad.emoji, size / 2, size * 0.4);
  a.fillStyle = col;
  a.font = `bold ${Math.round(size * 0.11)}px system-ui, sans-serif`;
  a.fillText(ad.t, size / 2, size * 0.7);
  return { albedo, height: null, rough: null };
}

/** 安全出口指示牌（绿色自发光，透明底，贴墙） */
function drawExitSign(size) {
  const albedo = newCanvas(size);
  const a = albedo.getContext('2d');
  a.clearRect(0, 0, size, size);
  a.fillStyle = 'rgba(8,20,12,0.92)';
  roundRectPath(a, size * 0.05, size * 0.2, size * 0.9, size * 0.6, size * 0.08);
  a.fill();
  a.strokeStyle = '#1E7A45';
  a.lineWidth = size * 0.02;
  a.stroke();
  a.fillStyle = '#6FE89A';
  a.textAlign = 'center';
  a.textBaseline = 'middle';
  a.font = `bold ${Math.round(size * 0.22)}px system-ui, sans-serif`;
  a.fillText('EXIT', size / 2, size * 0.42);
  a.font = `bold ${Math.round(size * 0.13)}px system-ui, sans-serif`;
  a.fillText('安全出口', size / 2, size * 0.68);
  return { albedo, height: null, rough: null, transparent: true };
}

/** 地面导视箭头（霓虹，透明底，平铺在广场地面） */
function drawDecal(size) {
  const albedo = newCanvas(size);
  const a = albedo.getContext('2d');
  a.clearRect(0, 0, size, size);
  a.lineCap = 'round';
  a.lineJoin = 'round';
  const drawArrow = (s) => {
    a.beginPath();
    a.moveTo(s * 0.5, s * 0.18);
    a.lineTo(s * 0.5, s * 0.72);
    a.moveTo(s * 0.32, s * 0.54);
    a.lineTo(s * 0.5, s * 0.72);
    a.lineTo(s * 0.68, s * 0.54);
    a.stroke();
  };
  a.globalAlpha = 0.4;
  a.strokeStyle = NEON.ice;
  a.lineWidth = size * 0.1;
  drawArrow(size);
  a.globalAlpha = 1;
  a.strokeStyle = shade(NEON.ice, 1.4);
  a.lineWidth = size * 0.05;
  drawArrow(size);
  return { albedo, height: null, rough: null, transparent: true };
}

/* ---------- 材质装配与缓存 ---------- */

const L = TEX.levels;

/**
 * RECIPES —— kind → 绘制配方。
 * size 由 art.mjs 的 TEX.levels 分级给出（需求E 硬指标：hero/large = 2048）。
 * 清单必须与 art.mjs 的 TEX_ASSETS + TEX_EXTRA 一致（tests/art.test.mjs 守着）。
 */
const RECIPES = {
  /* --- 需求F 点名的 7 类 --- */
  vending:   { size: L.hero,  draw: drawVending,     emissive: true },
  claw:      { size: L.hero,  draw: drawClawCabinet, emissive: true },
  pachinko:  { size: L.hero,  draw: drawPachinkoPanel, emissive: true },
  shelf:     { size: L.mid,   draw: drawShelfCabinet, strength: 1.0, rough: 1, metalness: 0.18 },
  floorTile: { size: L.large, draw: drawFloorTile,   strength: 1.2, rough: 1, metalness: 0.04 },
  wallTile:  { size: L.large, draw: drawWall,        strength: 1.8, rough: 1, metalness: 0.02 },
  uiHint:    { size: L.mid,   draw: drawUiHint,      basic: true, transparent: true },

  /* --- 场景补充 --- */
  arcade:  { size: L.mid,   draw: drawArcade,  strength: 1.0, rough: 1, metalness: 0.25 },
  metal:   { size: L.mid,   draw: drawMetal,   strength: 0.6, rough: 1, metalness: 0.55 },
  wood:    { size: L.mid,   draw: drawWood,    strength: 0.8, rough: 1, metalness: 0.02 },
  asphalt: { size: L.small, draw: drawAsphalt, strength: 0.9, rough: 1, metalness: 0.02 },
  ceiling: { size: L.small, draw: drawCeiling, strength: 0.5, rough: 1, metalness: 0.0 },
  screen:  { size: L.small, draw: drawScreen,  emissive: true },
  sky:     { size: L.small, draw: drawSky,     basic: true },
  water:      { size: L.small, draw: drawWater,      strength: 0.5, rough: 1, metalness: 0.05 },
  goodsCrate: { size: L.mid,   draw: drawGoodsCrate, strength: 1.2, rough: 1, metalness: 0.05 },
  exitSign:   { size: L.small, draw: drawExitSign,   basic: true, transparent: true },
  decal:      { size: L.small, draw: drawDecal,      basic: true, transparent: true },
};

/**
 * 旧 kind → 新 kind 的兼容映射。
 * 为什么需要：scene.mjs 等模块里散落着 'wall' / 'floor' 之类的旧名，
 * 一次性全改风险大（漏一处就黑屏）。这里做一层别名，
 * 旧名照样能用，新代码统一用新名，后续可逐步清理。
 */
const ALIASES = {
  wall: 'wallTile',
  floor: 'floorTile',
  plaza: 'floorTile',   // 广场铺装与室内地面共用同一套（都是地砖）
  floorTile: 'floorTile',
  wallTile: 'wallTile',
};

/** 可用 kind 清单（含别名） */
export function materialKinds() {
  return [...Object.keys(RECIPES), ...Object.keys(ALIASES)];
}

/** 需求F 的 7 类资产对应的 kind（供测试与报告使用） */
export const ASSET_KINDS = ['vending', 'claw', 'pachinko', 'shelf', 'floorTile', 'wallTile', 'uiHint'];

let MATS = null;

/** 生成（并缓存）全部材质；只应在启动时调用一次 */
export function createMaterials() {
  if (MATS) return MATS;
  MATS = {};
  for (const [kind, rec] of Object.entries(RECIPES)) {
    const { albedo, height, rough, emissive } = rec.draw(rec.size);
    // 天空球不吃光照，用 Basic；其余用 Standard（接收灯光与法线/粗糙度）
    const mat = rec.basic
      ? new THREE.MeshBasicMaterial({
        map: texFromCanvas(albedo, { srgb: true, repeat: false }),
        fog: false,
        transparent: rec.transparent === true,
      })
      : new THREE.MeshStandardMaterial({
        map: texFromCanvas(albedo, { srgb: true }),
        roughness: rec.rough ?? 0.9,
        metalness: rec.metalness ?? 0.02,
      });
    if (height && rough) {
      mat.normalMap = texFromCanvas(heightToNormal(height, rec.strength ?? 1));
      mat.normalScale = new THREE.Vector2(0.85, 0.85);
      mat.roughnessMap = texFromCanvas(rough);
    }
    if (emissive) {
      mat.emissive = new THREE.Color(0xffffff);
      mat.emissiveMap = texFromCanvas(albedo, { srgb: true, repeat: false });
      mat.emissiveIntensity = 0.85;
      mat.map.wrapS = mat.map.wrapT = THREE.ClampToEdgeWrapping;
    }
    // 正面资产（不平铺）：售货机 / 弹珠机 / 抓娃娃机 / 屏幕 / UI 都是"一张图贴一个面"
    if (['screen', 'vending', 'claw', 'pachinko', 'uiHint'].includes(kind)) {
      mat.map.wrapS = mat.map.wrapT = THREE.ClampToEdgeWrapping;
    }
    MATS[kind] = mat;
  }
  // 别名：指向同一份材质实例（不额外占显存）
  for (const [alias, target] of Object.entries(ALIASES)) {
    if (!MATS[alias] && MATS[target]) MATS[alias] = MATS[target];
  }
  return MATS;
}

/** 取一张材质（带别名解析）；未生成时返回 null（调用方决定回退） */
export function mat(kind) {
  if (!MATS) return null;
  return MATS[kind] ?? null;
}

/** 清空缓存（测试用；正常运行时不需要） */
export function resetMaterials() {
  MATS = null;
}

/**
 * 按物体实际尺寸缩放 BoxGeometry 的 UV，使全场 texel 密度一致。
 * 这样同一份纹理可以被任意尺寸的物体复用：既不拉伸，也不产生额外 GPU 上传。
 * @param texScale 这张贴图代表的实际边长（米）
 */
export function applyBoxUV(geo, w, h, d, texScale = 2) {
  const uv = geo.attributes.uv;
  // BoxGeometry 面序：+X, -X, +Y, -Y, +Z, -Z；各面对应的 (宽, 高)
  const faces = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    const su = faces[f][0] / texScale;
    const sv = faces[f][1] / texScale;
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
    }
  }
  uv.needsUpdate = true;
  return geo;
}

/**
 * 把某张贴图的 UV 映射到"只有一个面"的几何上（正面资产用）。
 * 需求F 的 7 类里，售货机/弹珠机/抓娃娃机/UI 都是**一整张贴满一个面**，
 * 不能走 applyBoxUV（那会把它切成重复的若干块，画面变成九宫格）。
 * 这个函数把目标面的 UV 直接归一化到 (0,0)-(1,1)。
 */
export function applyFaceUV(geo, faceIndex = 4) {
  const uv = geo.attributes.uv;
  for (let k = 0; k < 4; k++) {
    const i = faceIndex * 4 + k;
    uv.setXY(i, k === 1 || k === 3 ? 1 : 0, k >= 2 ? 1 : 0);
  }
  uv.needsUpdate = true;
  return geo;
}

/**
 * 把**六个面**的 UV 各自贴满一整个 (0,0)-(1,1)（牛皮纸货箱这类"每面一张图"的箱体用）。
 *
 * 为什么不直接用 applyBoxUV：那是"按面尺寸平铺"，1.1×0.9×1.1 的箱体会让贴图重复
 * 1.1 / 0.9 次，接缝把图案切成周期性子块 —— 这就是货箱正面被读成**棋盘格**的机制。
 *
 * 实现取巧但正确：BoxGeometry 每个面的 4 个顶点 UV 本来就是 (0,1) (1,1) (0,0) (1,0)，
 * 已经正好铺满 0–1，所以只要把它们吸附到最近的角，就等于"去掉重复 + 保留正确朝向"
 * （用 applyFaceUV 反而会把 v 轴翻过来，文字会上下颠倒）。
 */
export function applyFaceUVAll(geo) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) < 0.5 ? 0 : 1, uv.getY(i) < 0.5 ? 0 : 1);
  }
  uv.needsUpdate = true;
  return geo;
}

/* ==================================================================
 * 商品包装贴图（2026-10-06 块1：商品视觉升级）
 *
 * 问题：货架商品此前是**纯色几何体**（scene.mjs 的 prodMat(hex) 只给 color，
 * 没有 map），近看就是"一排彩色小方块"，正是反馈里"太粗制滥造"的来源。
 *
 * 做法：给每个商品变体生成一张**包装标签贴图**（Canvas 现画，ADR-004），
 * 按形状分配到罐身/瓶身标签/袋面/盒面/便当盖等部位：
 *   · 罐装（can）    → 竖向品牌色标签条 + 上下金属高光环 + 易拉环
 *   · 瓶装（bottle） → 环绕纸标 + 瓶颈高光
 *   · 杯装（cup）    → 杯套色带 + 吸管压印
 *   · 袋装（bag）    → 袋面褶皱 + 顶部撕口缺口
 *   · 盒装（box/smallbox）→ 盒面品名条 + 侧面配料色块
 *   · 便当（bentobox）→ 半透明盖 + 分格菜色
 *
 * 关键约束：**贴图是"锦上添花"，不是"唯一可读信息"** —— 颜色/形状仍由变体的
 * color/accent 决定（色盲玩家靠形状+色块仍能分辨），贴图只提供包装质感。
 * 尺寸取 256（商品在货架上只有几厘米宽，256 足够看清标签条，贴图显存也小）。
 * ================================================================== */

/** 变体 hex → '#RRGGBB' */
function hexStr(hex) {
  return '#' + (hex >>> 0).toString(16).padStart(6, '0').slice(-6);
}

/** 竖向金属高光带（罐/瓶都用它制造"圆柱反光"） */
function cylinderSheen(ctx, size, strength = 0.30) {
  const g = ctx.createLinearGradient(0, 0, size, 0);
  g.addColorStop(0.00, 'rgba(255,255,255,0)');
  g.addColorStop(0.18, `rgba(255,255,255,${strength * 0.55})`);
  g.addColorStop(0.34, `rgba(255,255,255,${strength})`);
  g.addColorStop(0.52, 'rgba(255,255,255,0)');
  g.addColorStop(0.86, 'rgba(0,0,0,0.16)');
  g.addColorStop(1.00, 'rgba(0,0,0,0.30)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
}

/** 顶部/底部金属环（易拉罐的上下盖） */
function metalRings(ctx, size, accent) {
  const a = hexStr(accent);
  const bands = [
    [0.00, 0.07], [0.93, 1.00],
  ];
  for (const [y0, y1] of bands) {
    const g = ctx.createLinearGradient(0, size * y0, 0, size * y1);
    g.addColorStop(0, shade(a, 0.35));
    g.addColorStop(0.5, a);
    g.addColorStop(1, shade(a, -0.35));
    ctx.fillStyle = g;
    ctx.fillRect(0, size * y0, size, size * (y1 - y0));
  }
}

/** 易拉环（罐顶的小椭圆拉片，印在贴图顶部） */
function pullTab(ctx, size, accent) {
  ctx.save();
  ctx.translate(size * 0.5, size * 0.038);
  ctx.strokeStyle = shade(hexStr(accent), -0.25);
  ctx.lineWidth = size * 0.008;
  ctx.beginPath();
  ctx.ellipse(0, 0, size * 0.035, size * 0.016, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = shade(hexStr(accent), -0.10);
  ctx.globalAlpha = 0.85;
  ctx.fill();
  ctx.restore();
}

/** 品牌标签条（横向色带 + 细描边 + 伪品名块） */
function labelBand(ctx, size, { y0 = 0.34, y1 = 0.72, color, text = '#FFFFFF' }) {
  const c = hexStr(color);
  const g = ctx.createLinearGradient(0, size * y0, 0, size * y1);
  g.addColorStop(0, shade(c, 0.22));
  g.addColorStop(0.5, c);
  g.addColorStop(1, shade(c, -0.20));
  ctx.fillStyle = g;
  ctx.fillRect(0, size * y0, size, size * (y1 - y0));
  // 上下细描边，让标签"贴"在罐身上而不是浮着
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.fillRect(0, size * y0, size, size * 0.008);
  ctx.fillRect(0, size * y1 - size * 0.008, size, size * 0.008);
  // 伪品名：几条横向色块（不写真文字，避免贴图缩到 6cm 时糊成一团）
  ctx.fillStyle = text;
  ctx.globalAlpha = 0.9;
  const r = rng(color & 0xffff);
  for (let i = 0; i < 3; i++) {
    const w = size * (0.16 + r() * 0.30);
    const h = size * 0.045;
    const x = size * (0.16 + r() * 0.20);
    const y = size * (y0 + 0.06 + i * 0.13);
    ctx.fillRect(x, y, w, h);
  }
  ctx.globalAlpha = 1;
}

/** 袋装褶皱：竖向明暗条 + 顶部撕口缺口 */
function bagWrinkles(ctx, size, seed) {
  const r = rng(seed);
  for (let i = 0; i < 9; i++) {
    const x = size * (0.06 + r() * 0.88);
    const w = size * (0.012 + r() * 0.03);
    const dark = r() > 0.5;
    ctx.fillStyle = dark ? 'rgba(0,0,0,0.16)' : 'rgba(255,255,255,0.13)';
    ctx.beginPath();
    ctx.moveTo(x, size * 0.10);
    ctx.lineTo(x + (r() - 0.5) * size * 0.05, size * 0.92);
    ctx.lineTo(x + w + (r() - 0.5) * size * 0.05, size * 0.92);
    ctx.lineTo(x + w, size * 0.10);
    ctx.closePath();
    ctx.fill();
  }
  // 撕口：顶部中央的锯齿缺口
  ctx.fillStyle = 'rgba(0,0,0,0.42)';
  ctx.beginPath();
  ctx.moveTo(size * 0.38, 0);
  for (let i = 0; i <= 6; i++) {
    const x = size * (0.38 + i * 0.04);
    ctx.lineTo(x, size * (i % 2 === 0 ? 0.045 : 0.015));
  }
  ctx.lineTo(size * 0.62, 0);
  ctx.closePath();
  ctx.fill();
}

/** 便当盖：半透明高光 + 三格菜色（透明材质单独走，见 productTexture 的 clear 分支） */
function bentoLid(ctx, size) {
  // 盖面高光
  const g = ctx.createLinearGradient(0, 0, size, size);
  g.addColorStop(0, 'rgba(255,255,255,0.30)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.06)');
  g.addColorStop(1, 'rgba(255,255,255,0.20)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  // 三格菜色（分格线 + 各自菜色）
  const cells = [
    [0.06, 0.10, 0.42, 0.34, '#7FBF5A'],
    [0.52, 0.10, 0.42, 0.34, '#E8A94E'],
    [0.06, 0.52, 0.88, 0.38, '#D85A5A'],
  ];
  for (const [x, y, w, h, col] of cells) {
    ctx.fillStyle = col;
    ctx.globalAlpha = 0.72;
    ctx.fillRect(size * x, size * y, size * w, size * h);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.30)';
    ctx.lineWidth = size * 0.010;
    ctx.strokeRect(size * x, size * y, size * w, size * h);
  }
}

/** 电池四联卡：卡纸底 + 4 节电池柱 + 端子 */
function batteryCard(ctx, size) {
  // 卡纸
  ctx.fillStyle = '#2B3550';
  ctx.fillRect(0, 0, size, size);
  // 挂孔
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath();
  ctx.arc(size * 0.5, size * 0.06, size * 0.028, 0, Math.PI * 2);
  ctx.fill();
  // 4 节电池（竖排，铜/黑/银/铜顶）
  const cols = ['#B98A2E', '#2B2B33', '#C8CDD6', '#1F3D7A'];
  for (let i = 0; i < 4; i++) {
    const x = size * (0.10 + i * 0.21);
    const y = size * 0.18;
    const w = size * 0.15;
    const h = size * 0.62;
    const g = ctx.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, shade(cols[i], -0.30));
    g.addColorStop(0.35, cols[i]);
    g.addColorStop(1, shade(cols[i], -0.42));
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    // 铜顶
    ctx.fillStyle = '#D9B45A';
    ctx.fillRect(x, y, w, size * 0.05);
    // 品牌条
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillRect(x, y + h * 0.42, w, size * 0.035);
  }
}

/** 杂志薄本：封面 + 刊头条 + 人物剪影块 + 条码 */
function magazineCover(ctx, size, accent) {
  const a = hexStr(accent);
  ctx.fillStyle = a;
  ctx.fillRect(0, 0, size, size);
  // 刊头条
  ctx.fillStyle = 'rgba(255,255,255,0.88)';
  ctx.fillRect(size * 0.08, size * 0.06, size * 0.62, size * 0.13);
  // 封面主图块
  ctx.fillStyle = shade(a, -0.42);
  ctx.fillRect(size * 0.08, size * 0.24, size * 0.84, size * 0.50);
  // 人物剪影
  ctx.fillStyle = shade(a, 0.30);
  ctx.beginPath();
  ctx.arc(size * 0.5, size * 0.44, size * 0.13, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(size * 0.36, size * 0.54, size * 0.28, size * 0.18);
  // 侧栏文字条
  ctx.fillStyle = 'rgba(255,255,255,0.42)';
  for (let i = 0; i < 4; i++) ctx.fillRect(size * 0.10, size * 0.79 + i * 0.045, size * (0.5 - i * 0.08), size * 0.022);
  // 条码
  ctx.fillStyle = '#F2F2F2';
  ctx.fillRect(size * 0.70, size * 0.80, size * 0.22, size * 0.14);
  ctx.fillStyle = '#1A1A1A';
  const r = rng(7717);
  for (let i = 0; i < 11; i++) ctx.fillRect(size * (0.71 + i * 0.019), size * 0.81, size * (0.004 + r() * 0.008), size * 0.12);
}

/** 口香糖小盒：盒面 + 糖粒小格 + 开封切线 */
function gumBox(ctx, size, accent) {
  const a = hexStr(accent);
  const g = ctx.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0, shade(a, 0.20));
  g.addColorStop(1, shade(a, -0.30));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  // 品名条
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillRect(size * 0.12, size * 0.14, size * 0.56, size * 0.16);
  // 糖粒格（5 片薄糖）
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.16 + i * 0.05})`;
    ctx.fillRect(size * (0.10 + i * 0.17), size * 0.44, size * 0.13, size * 0.30);
  }
  // 开封切线
  ctx.strokeStyle = 'rgba(0,0,0,0.30)';
  ctx.setLineDash([size * 0.03, size * 0.02]);
  ctx.lineWidth = size * 0.008;
  ctx.beginPath();
  ctx.moveTo(0, size * 0.88);
  ctx.lineTo(size, size * 0.88);
  ctx.stroke();
  ctx.setLineDash([]);
}

const _prodTexCache = new Map();

/**
 * 取某个商品变体的包装贴图（带缓存）。
 *
 * @param {object} variant PRODUCT_VARIANTS 里的一条（需含 shape/color/accent）
 * @returns {THREE.CanvasTexture|null} null = 该形状不做贴图（调用方回落到纯色）
 */
export function productTexture(variant) {
  if (!variant) return null;
  const key = `${variant.shape}|${variant.color}|${variant.accent}`;
  if (_prodTexCache.has(key)) return _prodTexCache.get(key);
  const size = 256;
  const c = newCanvas(size);
  const ctx = c.getContext('2d');
  const col = hexStr(variant.color);
  const acc = hexStr(variant.accent);

  // 底色 = 变体主色（保持与纯色时代一致，贴图只是叠加细节）
  ctx.fillStyle = col;
  ctx.fillRect(0, 0, size, size);

  switch (variant.shape) {
    case 'can':
      cylinderSheen(ctx, size, 0.34);
      labelBand(ctx, size, { y0: 0.30, y1: 0.74, color: variant.accent });
      metalRings(ctx, size, variant.accent);
      pullTab(ctx, size, variant.accent);
      break;
    case 'bottle':
      cylinderSheen(ctx, size, 0.26);
      labelBand(ctx, size, { y0: 0.38, y1: 0.78, color: variant.accent });
      // 瓶颈高光
      ctx.fillStyle = 'rgba(255,255,255,0.20)';
      ctx.fillRect(0, 0, size, size * 0.12);
      break;
    case 'cup':
      cylinderSheen(ctx, size, 0.22);
      labelBand(ctx, size, { y0: 0.30, y1: 0.62, color: variant.accent });
      ctx.fillStyle = 'rgba(0,0,0,0.20)';
      ctx.fillRect(0, size * 0.78, size, size * 0.10);
      break;
    case 'bag':
      bagWrinkles(ctx, size, variant.color);
      labelBand(ctx, size, { y0: 0.30, y1: 0.62, color: variant.accent });
      break;
    case 'box':
    case 'lolli':
      labelBand(ctx, size, { y0: 0.28, y1: 0.66, color: variant.accent });
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect(size * 0.08, size * 0.74, size * 0.84, size * 0.10);
      break;
    case 'smallbox':
      gumBox(ctx, size, variant.accent);
      break;
    case 'bentobox':
      bentoLid(ctx, size);
      break;
    case 'noodlecup':
      cylinderSheen(ctx, size, 0.20);
      labelBand(ctx, size, { y0: 0.32, y1: 0.60, color: variant.accent });
      // 封口膜环
      ctx.fillStyle = 'rgba(255,255,255,0.30)';
      ctx.fillRect(0, 0, size, size * 0.10);
      break;
    case 'batterycard':
      batteryCard(ctx, size);
      break;
    case 'magazine':
      magazineCover(ctx, size, variant.accent);
      break;
    case 'hotdog':
    case 'sausage':
      // 面包/肠本身不贴图（几何已表达），只加一点烘烤焦斑
      ctx.fillStyle = 'rgba(0,0,0,0.16)';
      for (let i = 0; i < 6; i++) {
        ctx.beginPath();
        ctx.arc(size * (0.15 + (i % 3) * 0.32), size * (0.30 + Math.floor(i / 3) * 0.34), size * 0.055, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    default:
      // 未知形状：只保留底色（几何兜底已在 scene 侧处理）
      break;
  }

  const tex = texFromCanvas(c, { srgb: true, repeat: false });
  _prodTexCache.set(key, tex);
  return tex;
}

/** 清空包装贴图缓存（重开 / 换主题时用，避免旧贴图常驻显存） */
export function resetProductTextures() {
  for (const t of _prodTexCache.values()) t.dispose?.();
  _prodTexCache.clear();
}
