/**
 * P12 程序化表面材质：确定性分层噪声烘焙。
 *
 * 参考「几猫国产3A大作 V1」的材质分层思路（多频 fbm / voronoi 点蚀 / 板缝 /
 * 拉丝划痕 / 锈蚀 / 污渍 / 磨损），把 GPU 端 MRT 烘焙改为 CPU 端 Canvas 可平铺烘焙，
 * 一次遍历同时产出 albedo / height / roughness 三通道，零外部素材、零 DOM、零 three。
 *
 * 设计要点：
 * - 全部噪声由整数哈希推导，同 (kind, size, seed) 跨进程逐字节一致，不消耗战局随机流。
 * - 频率均为整数并按频率取模 → 贴图四边可无缝平铺。
 * - albedo 是**中性近白调制层**而非固有色：本项目的分区配色由顶点色决定，
 *   贴图只负责细节层次，避免挂上 uv 后把整面墙压暗。
 *
 * 导出纯函数，供 models.js 包成 CanvasTexture、供单元测试做确定性断言。
 */

/** 支持的表面配方（与 models.js 的贴图 getter 一一对应） */
export const SURFACE_KINDS = Object.freeze(['concrete', 'floor', 'metal', 'rust']);

const wrap = (n, m) => ((n % m) + m) % m;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** 与格线的距离衰减，用来画预制板缝 / 标线 */
const lineAt = (x, at, width) => 1 - smooth(0, width, Math.abs(x - at));

/**
 * 32 位整数哈希 → [0,1)。只依赖整数坐标与种子，无全局状态。
 * @param {number} ix 格子 x
 * @param {number} iy 格子 y
 * @param {number} seed 种子
 * @returns {number} 0~1
 */
export function hash2(ix, iy, seed) {
  let h = Math.imul(ix | 0, 0x9e3779b1) ^ Math.imul(iy | 0, 0x85ebca77) ^ Math.imul(seed | 0, 0xc2b2ae3d);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * 可平铺 value noise，横纵频率可不同（拉丝材质需要各向异性）。
 * @param {number} u 0~1
 * @param {number} v 0~1
 * @param {number} fx x 方向整数频率
 * @param {number} fy y 方向整数频率
 * @param {number} seed 种子
 * @returns {number} 0~1
 */
export function tileNoiseXY(u, v, fx, fy, seed) {
  const x = u * fx;
  const y = v * fy;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const tx = x - ix;
  const ty = y - iy;
  const sx = tx * tx * tx * (tx * (tx * 6 - 15) + 10);
  const sy = ty * ty * ty * (ty * (ty * 6 - 15) + 10);
  const x0 = wrap(ix, fx);
  const y0 = wrap(iy, fy);
  const x1 = wrap(ix + 1, fx);
  const y1 = wrap(iy + 1, fy);
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  return mix(mix(a, b, sx), mix(c, d, sx), sy);
}

/** 各向同性可平铺 value noise 的简写 */
export function tileNoise(u, v, freq, seed) {
  return tileNoiseXY(u, v, freq, freq, seed);
}

/**
 * 分形噪声：每次倍频仍保持整数频率，因此结果同样可平铺。
 * @returns {number} 0~1，围绕 0.5
 */
export function fbm(u, v, freq, octaves, seed) {
  let amp = 0.5;
  let sum = 0;
  let norm = 0;
  let f = freq;
  for (let i = 0; i < octaves; i += 1) {
    sum += amp * tileNoise(u, v, f, seed + i * 131);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

/**
 * 可平铺 voronoi：用于混凝土孔隙、锈层片块。
 * @returns {{d: number, edge: number, cell: number}} d=到最近特征点距离，edge=与次近点的差（裂纹），cell=单元格哈希
 */
export function voronoi(u, v, freq, seed) {
  const x = u * freq;
  const y = v * freq;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let d1 = 9;
  let d2 = 9;
  let cell = 0;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const cx = ix + dx;
      const cy = iy + dy;
      const wx = wrap(cx, freq);
      const wy = wrap(cy, freq);
      const h = hash2(wx, wy, seed);
      const px = cx + 0.18 + 0.64 * h;
      const py = cy + 0.18 + 0.64 * hash2(wx, wy, seed + 7919);
      const ddx = px - x;
      const ddy = py - y;
      const d = Math.sqrt(ddx * ddx + ddy * ddy);
      if (d < d1) {
        d2 = d1;
        d1 = d;
        cell = h;
      } else if (d < d2) {
        d2 = d;
      }
    }
  }
  return { d: d1, edge: d2 - d1, cell };
}

/** 单像素的公共噪声层（一次算齐，各配方按需取用） */
function layers(u, v, s) {
  return {
    big: fbm(u, v, 2, 4, s + 1),
    mid: fbm(u, v, 12, 4, s + 2),
    fine: fbm(u, v, 96, 3, s + 3),
    grit: fbm(u, v, 224, 2, s + 4),
    blotch: fbm(u, v, 4, 3, s + 6),
    brushV: tileNoiseXY(u, v, 2, 160, s + 7),
    brushH: tileNoiseXY(u, v, 160, 2, s + 8),
    cell: voronoi(u, v, 44, s + 5),
  };
}

/**
 * 采样某个配方在 (u,v) 处的三通道值。
 * 返回分量均为 0~1：rgb 是 sRGB 的调制色，h 是高度，rough 是粗糙度。
 * @param {string} kind SURFACE_KINDS 之一
 * @param {number} u 0~1
 * @param {number} v 0~1
 * @param {number} seed 种子
 * @returns {{r:number,g:number,b:number,h:number,rough:number}}
 */
export function sampleSurface(kind, u, v, seed = 0x5d0a) {
  const L = layers(u, v, seed);
  const pore = 1 - smooth(0.015, 0.12, L.cell.d);
  const seam = Math.max(
    lineAt(u, 0, 0.012), lineAt(u, 1, 0.012),
    lineAt(u, 1 / 3, 0.010), lineAt(u, 2 / 3, 0.010),
    lineAt(v, 1 / 3, 0.010), lineAt(v, 2 / 3, 0.010),
  );
  const stain = smooth(0.52, 0.82, L.blotch) * (0.35 + 0.65 * smooth(0.35, 1, v));
  const wear = smooth(0.66, 0.86, L.big) * (1 - pore * 0.5);
  const scratch = 1 - smooth(0.0, 0.028, L.cell.edge);
  const rustMask = smooth(0.62, 0.80, L.mid * 0.6 + L.big * 0.4) * (1 - wear * 0.6);

  // 中性基色：只做细节调制，分区本色仍由顶点色承担。
  let r = 0.92;
  let g = 0.93;
  let b = 0.94;
  let h = 0.5;
  let rough = 0.8;

  if (kind === 'concrete') {
    const tone = (L.big - 0.5) * 0.20 + (L.mid - 0.5) * 0.14 + (L.fine - 0.5) * 0.07;
    r = 0.92 + tone + stain * 0.02;
    g = 0.93 + tone + stain * 0.01;
    b = 0.94 + tone - stain * 0.03;
    r -= pore * 0.16 + seam * 0.30 + stain * 0.10;
    g -= pore * 0.15 + seam * 0.29 + stain * 0.09;
    b -= pore * 0.13 + seam * 0.27 + stain * 0.06;
    // 零星暖锈：只在斑块核心出现，不把整面墙染黄
    r = mix(r, r + 0.05, rustMask * 0.5);
    g = mix(g, g - 0.06, rustMask * 0.5);
    b = mix(b, b - 0.12, rustMask * 0.5);
    h = 0.5 + (L.mid - 0.5) * 0.42 + (L.fine - 0.5) * 0.18 - pore * 0.30 - seam * 0.42;
    rough = 0.78 + (L.grit - 0.5) * 0.20 + pore * 0.12 + stain * 0.08 - wear * 0.12;
  } else if (kind === 'floor') {
    const lane = smooth(0.38, 0.66, L.blotch);
    const crack = scratch * smooth(0.45, 0.72, L.big);
    const tone = (L.big - 0.5) * 0.16 + (L.mid - 0.5) * 0.12 + (L.grit - 0.5) * 0.10;
    r = 0.91 + tone - crack * 0.20 - stain * 0.07 + lane * 0.03;
    g = 0.92 + tone - crack * 0.19 - stain * 0.07 + lane * 0.03;
    b = 0.94 + tone - crack * 0.17 - stain * 0.05 + lane * 0.03;
    h = 0.5 + (L.mid - 0.5) * 0.30 + (L.grit - 0.5) * 0.18 - crack * 0.34 - pore * 0.12;
    rough = 0.84 + (L.grit - 0.5) * 0.14 + pore * 0.08 - lane * 0.14 + crack * 0.06;
  } else if (kind === 'metal') {
    const brush = (L.brushV - 0.5) * 0.16 + (L.brushH - 0.5) * 0.05;
    const sc = smooth(0.72, 0.90, L.brushH + (L.fine - 0.5) * 0.12);
    const tone = (L.big - 0.5) * 0.10 + brush;
    r = 0.90 + tone + sc * 0.06 - rustMask * 0.16;
    g = 0.92 + tone + sc * 0.06 - rustMask * 0.24;
    b = 0.95 + tone + sc * 0.05 - rustMask * 0.32;
    h = 0.5 + (L.brushV - 0.5) * 0.34 + (L.fine - 0.5) * 0.08 - sc * 0.16 + rustMask * 0.10;
    rough = 0.44 + (L.brushV - 0.5) * 0.22 + sc * 0.10 + rustMask * 0.34 + stain * 0.06;
  } else {
    // rust：片状锈层 + 点蚀 + 粉化，作为容器 / 金属件的重锈变体。
    // 基色同样保持近白：暖意来自 R/B 差值，而不是把整张贴图画暗。
    const flake = smooth(0.42, 0.62, L.cell.cell);
    const tone = (L.big - 0.5) * 0.24 + (L.mid - 0.5) * 0.18 + (L.fine - 0.5) * 0.10;
    r = 0.96 + tone - flake * 0.10 - pore * 0.07;
    g = 0.94 + tone - flake * 0.16 - pore * 0.10;
    b = 0.92 + tone - flake * 0.20 - pore * 0.12;
    r = mix(r, r + 0.04, rustMask * 0.4);
    h = 0.5 + (L.mid - 0.5) * 0.48 + flake * 0.16 - pore * 0.32 + (L.grit - 0.5) * 0.12;
    rough = 0.86 + (L.grit - 0.5) * 0.14 + flake * 0.08 - wear * 0.06;
  }

  return {
    r: clamp01(r), g: clamp01(g), b: clamp01(b),
    h: clamp01(h), rough: clamp01(rough),
  };
}

/** FNV-1a 风格校验和，用于确定性护栏与探针取证 */
export function bytesChecksum(bytes) {
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 烘焙一整套三通道贴图。每个通道都是 RGBA 的 Uint8ClampedArray，
 * 可直接喂给 Canvas 的 ImageData（height / roughness 取 R 通道做灰度）。
 *
 * @param {string} kind 配方名
 * @param {number} size 边长（建议 2 的幂，保证各档 WebGL 下 RepeatWrapping 可用）
 * @param {number} seed 种子
 * @returns {{albedo:Uint8ClampedArray,height:Uint8ClampedArray,roughness:Uint8ClampedArray,size:number,checksum:number}}
 */
export function bakeSurface(kind, size = 128, seed = 0x5d0a) {
  const s = Math.max(8, Math.min(512, Math.floor(size) || 128));
  const n = s * s * 4;
  const albedo = new Uint8ClampedArray(n);
  const height = new Uint8ClampedArray(n);
  const roughness = new Uint8ClampedArray(n);
  for (let y = 0; y < s; y += 1) {
    const v = y / s;
    for (let x = 0; x < s; x += 1) {
      const u = x / s;
      const p = sampleSurface(kind, u, v, seed);
      const i = (y * s + x) * 4;
      albedo[i] = p.r * 255;
      albedo[i + 1] = p.g * 255;
      albedo[i + 2] = p.b * 255;
      albedo[i + 3] = 255;
      const hv = p.h * 255;
      height[i] = hv; height[i + 1] = hv; height[i + 2] = hv; height[i + 3] = 255;
      const rv = p.rough * 255;
      roughness[i] = rv; roughness[i + 1] = rv; roughness[i + 2] = rv; roughness[i + 3] = 255;
    }
  }
  return { albedo, height, roughness, size: s, checksum: bytesChecksum(albedo) };
}
