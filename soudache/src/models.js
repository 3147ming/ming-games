/**
 * Low-Poly 程序化模型工厂
 *
 * 全部造型由内置几何体拼装 + `flatShading` 出效果，零外部贴图 / 模型文件。
 * 模块边界：本文件允许 `import THREE`（渲染层专用）。
 *
 * 朝向约定：模型一律"面朝 -Z"建模，与 THREE 相机默认前向一致，
 * 逻辑角 angle → 场景 yaw 的换算见 `yawFromAngle`。
 *
 * 尺寸约定：config 中的尺寸以"米"为单位，建模时统一乘 `VIEW3D.metersToUnits`。
 */

import * as THREE from '../vendor/three.module.js';
import { VIEW3D, PALETTE3D, WEAPONS, ARMORS, RARITY, SURFACE3D } from './config.js';
import { bakeSurface } from './surfaces.js';
import { loadGLB, glbLambert } from './assets.js';
// 尺寸真值单独成文件（零 three 依赖）：3D 枪模与战前改枪台的 2D 线稿读同一份，避免两表漂移
import { VM_PARAMS, resolvedBarrel } from './vmparams.js';

/** 米 → 场景单位的换算系数（见 config.VIEW3D 的单位说明） */
const U = VIEW3D.metersToUnits;

/**
 * 米 → 场景单位。
 * @param {number} meters 米
 * @returns {number} 场景单位
 */
export function u(meters) {
  return meters * U;
}

/**
 * 逻辑朝向角 → 场景 yaw。
 * 逻辑 (x, y) 映射为场景 (x, h, y)，前向 (cos a, 0, sin a)。
 * @param {number} angle 逻辑朝向弧度
 * @returns {number} 绕 Y 轴的 yaw
 */
export function yawFromAngle(angle) {
  return -Math.PI / 2 - angle;
}

/**
 * 创建一个 Low-Poly 材质。
 *
 * 默认仍是廉价的 MeshLambertMaterial（角色、道具等数量多的对象）。
 * 传 `standard: true` 时改用 MeshStandardMaterial：带粗糙度 / 金属度并接收场景环境贴图，
 * 用于地面、墙体、掩体箱这类**大面积表面** —— 这是画面从"塑料感"变成"有材质"的关键。
 * @param {string} color 颜色
 * @param {object} opts 附加参数
 *   { emissive, transparent, opacity, phong, shininess, specular,
 *     standard, roughness, metalness, envIntensity, flat }
 * @returns {THREE.Material} 材质
 */
export function lowPolyMat(color, opts = {}) {
  const params = {
    color: new THREE.Color(color),
    flatShading: opts.flat !== false,
  };
  if (opts.emissive) params.emissive = new THREE.Color(opts.emissive);
  if (opts.emissiveIntensity != null) params.emissiveIntensity = opts.emissiveIntensity;
  if (opts.transparent) {
    params.transparent = true;
    params.opacity = opts.opacity != null ? opts.opacity : 1;
  }
  if (opts.map) params.map = opts.map;
  // 顶点色必须在**构造时**声明：先 new 再赋 material.vertexColors 不会重建 program，
  // USE_COLOR 宏永远不定义，顶点色被静默忽略（地面斑驳曾经整批失效就是这个原因）。
  if (opts.vertexColors) params.vertexColors = true;

  if (opts.standard) {
    params.roughness = opts.roughness != null ? opts.roughness : 0.85;
    params.metalness = opts.metalness != null ? opts.metalness : 0.0;
    params.envMapIntensity = opts.envIntensity != null ? opts.envIntensity : VIEW3D.envIntensity;
    // P12 细节通道：凹凸 / 粗糙度贴图只在 Standard 分支挂（Lambert 不支持 roughnessMap）。
    if (opts.bumpMap) {
      params.bumpMap = opts.bumpMap;
      params.bumpScale = opts.bumpScale != null ? opts.bumpScale : SURFACE3D.bumpScale;
    }
    if (opts.roughnessMap) params.roughnessMap = opts.roughnessMap;
    const mat = new THREE.MeshStandardMaterial(params);
    return mat;
  }

  const Mat = opts.phong ? THREE.MeshPhongMaterial : THREE.MeshLambertMaterial;
  const mat = new Mat(params);
  if (opts.phong) {
    mat.shininess = opts.shininess != null ? opts.shininess : 26;
    mat.specular = new THREE.Color(opts.specular || '#202830');
  }
  return mat;
}

/**
 * 大面积表面（地面 / 墙面 / 掩体箱）专用：Standard 材质 + 贴图 + 统一粗糙度。
 * @param {string} color 颜色
 * @param {?THREE.Texture} map 贴图
 * @param {number} roughness 粗糙度
 * @returns {THREE.Material} 材质
 */
export function surfaceMat(color, map, roughness = VIEW3D.wallRoughness, detail = null) {
  return lowPolyMat(color, {
    standard: true,
    map: map || undefined,
    roughness,
    metalness: VIEW3D.metalness,
    flat: false, // 大平面不需要 flatShading，否则会露出三角形硬边
    // P12：detail = { bumpMap, roughnessMap }，低画质 / 无 DOM 时为 null 自动降级。
    bumpMap: detail ? detail.bumpMap : null,
    roughnessMap: detail ? detail.roughnessMap : null,
  });
}

/**
 * 合并若干几何体为一个（要求都带 normal 属性；全部带 color 时一并合并）。
 * three 的 BufferGeometryUtils 属于 examples，本项目只有核心包，故手写合并。
 * @param {Array<THREE.BufferGeometry>} geos 几何体列表（各自已应用变换）
 * @returns {THREE.BufferGeometry} 合并后的非索引几何体
 */
export function mergeGeometries(geos) {
  const list = [];
  let total = 0;
  let withColor = true;
  let withUv = true;
  for (const g of geos) {
    const ng = g.index ? g.toNonIndexed() : g;
    list.push(ng);
    total += ng.attributes.position.count;
    if (!ng.attributes.color) withColor = false;
    // P12：P3 以来这里只合并 position/normal/color，把 uv 丢了 ——
    // 结果是墙体/掩体箱合并后 material.map 根本采样不到，贴图一直没生效。
    // 现在按同样口径带上 uv；不含 uv 的输入（如手工灌木几何）整批跳过该属性。
    if (!ng.attributes.uv) withUv = false;
  }
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const color = withColor ? new Float32Array(total * 3) : null;
  const uv = withUv ? new Float32Array(total * 2) : null;
  let offset = 0;
  for (const g of list) {
    position.set(g.attributes.position.array, offset * 3);
    normal.set(g.attributes.normal.array, offset * 3);
    if (color) color.set(g.attributes.color.array, offset * 3);
    if (uv) uv.set(g.attributes.uv.array, offset * 2);
    offset += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  if (color) out.setAttribute('color', new THREE.BufferAttribute(color, 3));
  if (uv) out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  return out;
}

/**
 * 把同一父节点下的静态小件按材质合并（只合并 2 个以上同材质 Mesh）。
 *
 * 用途：程序化敌人 / 队友（?glb=0）每个关节组里有若干 BoxGeometry，
 * 同一个关节里的零件不会相对运动，合并后关节旋转依旧生效，draw 却少一截。
 * ⚠ 只合并同一父节点内的直接子 Mesh，绝不跨关节，否则走路动画会把腿粘在一起。
 * ⚠ 被遮蔽的 Mesh（detailMeshes / 枪口火光 / 显式 keep）必须跳过：
 *    它们会被逐帧改 visible 或单独引用，合并后就无法单独控制。
 * @param {THREE.Object3D} root 模型根
 * @param {THREE.Object3D[]} keep 必须保留独立对象的 Mesh
 * @returns {number} 合并掉的 Mesh 数量
 */
export function mergeRigidParts(root, keep = []) {
  const skip = new Set(keep.filter(Boolean));
  const parents = [];
  root.traverse((o) => { if (o.children.length) parents.push(o); });
  let removed = 0;
  for (const parent of parents) {
    const byMat = new Map();
    for (const child of parent.children) {
      if (!child.isMesh || child.isInstancedMesh || skip.has(child)) continue;
      if (child.userData && child.userData.noMerge) continue;
      const mat = child.material;
      if (!mat || Array.isArray(mat)) continue;
      if (!byMat.has(mat)) byMat.set(mat, []);
      byMat.get(mat).push(child);
    }
    for (const [mat, meshes] of byMat) {
      if (meshes.length < 2) continue;
      const geos = meshes.map((m) => {
        m.updateMatrix();
        const g = m.geometry.clone();
        g.applyMatrix4(m.matrix);
        return g;
      });
      const merged = mergeGeometries(geos);
      for (const g of geos) g.dispose();
      const out = new THREE.Mesh(merged, mat);
      out.castShadow = meshes.some((m) => m.castShadow);
      out.receiveShadow = meshes.some((m) => m.receiveShadow);
      parent.add(out);
      for (const m of meshes) parent.remove(m);
      removed += meshes.length - 1;
    }
  }
  return removed;
}

/** 便捷：把几何体平移后返回自身 */
function at(geo, x, y, z) {
  geo.translate(x, y, z);
  return geo;
}

/**
 * 生成一个带"逐面顶点色"的长方体（用于墙体 / 掩体箱这类需要区分顶面的体块）。
 * @param {number} sx x 尺寸（场景单位）
 * @param {number} sy y 尺寸
 * @param {number} sz z 尺寸
 * @param {Array<string>} faces 六面颜色 [+X, -X, +Y, -Y, +Z, -Z]
 * @returns {THREE.BufferGeometry} 几何体（位于原点）
 */
export function boxWithFaceColors(sx, sy, sz, faces) {
  const geo = new THREE.BoxGeometry(sx, sy, sz).toNonIndexed();
  const count = geo.attributes.position.count; // 36：每面 6 个顶点
  const colors = new Float32Array(count * 3);
  const c = new THREE.Color();
  for (let face = 0; face < 6; face += 1) {
    c.set(faces[face]);
    for (let v = 0; v < 6; v += 1) {
      const i = (face * 6 + v) * 3;
      colors[i] = c.r;
      colors[i + 1] = c.g;
      colors[i + 2] = c.b;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

/* ============================ 程序化贴图 ============================ */

/**
 * 用 Canvas2D 程序化生成贴图（零外部资源）。
 * Node 无头环境下 document 不存在，返回 null，调用方据此回退为纯色材质，
 * 不影响游戏逻辑与单元测试（集成冒烟在 Node 中也不会真正建贴图）。
 * @param {function(CanvasRenderingContext2D, number):void} draw 绘制回调
 * @param {number} size 贴图边长（像素）
 * @returns {THREE.CanvasTexture|null}
 */
export function makeCanvasTexture(draw, size = 64) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  draw(ctx, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

/** 模块级贴图缓存（按 key 懒生成，保证同进程只建一次） */
const _texCache = {};
function getTex(key, draw, size = 64) {
  if (_texCache[key] === undefined) _texCache[key] = makeCanvasTexture(draw, size);
  return _texCache[key];
}

/**
 * P12：把 surfaces.js 烘焙出的 RGBA 字节包成贴图。
 * albedo 走 sRGB，height / roughness 必须走线性（NoColorSpace），
 * 否则凹凸会被 gamma 抬歪、粗糙度会被整体压低。
 * @param {Uint8ClampedArray} pixels RGBA 字节
 * @param {number} size 边长
 * @param {boolean} linear 是否为数据通道（非颜色）
 * @returns {THREE.CanvasTexture|null}
 */
function surfaceTexture(pixels, size, linear) {
  if (typeof document === 'undefined') return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.putImageData(new ImageData(pixels, size, size), 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    return tex;
  } catch {
    return null;
  }
}

/** P12 三通道贴图缓存（按配方懒烘焙，同进程只算一次） */
const _surfaceCache = {};

/**
 * 取某配方的 { map, bumpMap, roughnessMap } 集合。
 * 无 DOM（Node 单测）/ 配置关闭 / 烘焙失败时返回 null，调用方回退到 P3 简易贴图。
 * @param {string} kind SURFACE_KINDS 之一
 * @returns {object|null}
 */
export function getSurfaceMaps(kind) {
  if (!SURFACE3D.enabled) return null;
  if (_surfaceCache[kind] !== undefined) return _surfaceCache[kind];
  let maps = null;
  try {
    const baked = bakeSurface(kind, SURFACE3D.size, SURFACE3D.seed);
    const map = surfaceTexture(baked.albedo, baked.size, false);
    if (map) {
      maps = {
        map,
        bumpMap: surfaceTexture(baked.height, baked.size, true),
        roughnessMap: surfaceTexture(baked.roughness, baked.size, true),
        checksum: baked.checksum,
        size: baked.size,
      };
    }
  } catch {
    maps = null;
  }
  _surfaceCache[kind] = maps;
  return maps;
}

/**
 * 贴图专用的确定性随机（mulberry32）。
 *
 * 贴图只烘焙一次、之后一直复用，但它决定的是**画面本身**。用 Math.random 的话，
 * 同一个 commit 每次启动画出来的污渍/裂纹都不一样，像素统计与 A/B 截图就没法对比了。
 * 固定种子让"改了什么"变成可归因的差异。
 * @param {number} seed 种子
 * @returns {() => number} [0,1) 随机数
 */
function texRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 在画布上撒噪点，营造材质颗粒感 */
function speckle(ctx, size, base, spread, count) {
  for (let i = 0; i < count; i += 1) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = Math.random() * size * 0.05;
    const k = 1 + (Math.random() - 0.5) * spread;
    ctx.fillStyle = `rgba(${Math.round(base[0] * k)},${Math.round(base[1] * k)},${Math.round(base[2] * k)},0.5)`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

// 各贴图绘制函数（仅在浏览器中执行）
const FLOOR_TEX = (ctx, s) => {
  const rnd = texRng(0x51f00d);
  ctx.fillStyle = '#9fa8b3'; ctx.fillRect(0, 0, s, s);

  // 大尺度污渍：这是"地面不像塑料板"的关键。只撒细噪点在缩略/远处会被 mipmap 抹平，
  // 剩下一个纯灰面；直径 20%~45% 的柔和斑块才能在中距离保住。
  for (let i = 0; i < 9; i += 1) {
    const cx = rnd() * s; const cy = rnd() * s;
    const r = s * (0.16 + rnd() * 0.28);
    const dark = rnd() < 0.62;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    const col = dark ? '60,68,78' : '196,203,212';
    g.addColorStop(0, `rgba(${col},${dark ? 0.20 : 0.14})`);
    g.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  }

  speckle(ctx, s, [150, 160, 175], 0.62, 420);

  // 分仓缝：2m 一格的混凝土板缝，加内侧高光做出"缝有深度"的错觉
  ctx.strokeStyle = 'rgba(38,46,58,0.55)'; ctx.lineWidth = Math.max(2, s / 64);
  ctx.strokeRect(0, 0, s, s);
  ctx.beginPath(); ctx.moveTo(s / 2, 0); ctx.lineTo(s / 2, s); ctx.moveTo(0, s / 2); ctx.lineTo(s, s / 2); ctx.stroke();
  ctx.strokeStyle = 'rgba(205,212,222,0.16)'; ctx.lineWidth = Math.max(1, s / 128);
  ctx.beginPath(); ctx.moveTo(0, s / 2 + 2); ctx.lineTo(s, s / 2 + 2); ctx.stroke();

  // 细裂纹：几条折线，只在近处可见，但能让地面在脚下"有内容"
  ctx.strokeStyle = 'rgba(46,54,66,0.42)'; ctx.lineWidth = Math.max(1, s / 160);
  for (let c = 0; c < 3; c += 1) {
    let x = rnd() * s; let y = rnd() * s;
    ctx.beginPath(); ctx.moveTo(x, y);
    for (let k = 0; k < 5; k += 1) {
      x += (rnd() - 0.5) * s * 0.34;
      y += (rnd() - 0.5) * s * 0.34;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
};
const CONCRETE_TEX = (ctx, s) => {
  const rnd = texRng(0xc0de11);
  ctx.fillStyle = '#6e7884'; ctx.fillRect(0, 0, s, s);

  // 大块色差：同一面墙也要有"这段新、那段旧"的观感，否则大面积单色一眼假
  for (let i = 0; i < 7; i += 1) {
    const cx = rnd() * s; const cy = rnd() * s;
    const r = s * (0.2 + rnd() * 0.3);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    const light = rnd() < 0.45;
    const col = light ? '146,158,172' : '52,60,72';
    g.addColorStop(0, `rgba(${col},${light ? 0.16 : 0.22})`);
    g.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  }

  speckle(ctx, s, [110, 122, 138], 0.7, 420);

  // 预制板缝：每 1/3 一道，缝下带一条浅色反光，读起来才有厚度
  for (const f of [s * 0.33, s * 0.66]) {
    ctx.strokeStyle = 'rgba(34,42,54,0.52)'; ctx.lineWidth = Math.max(1.5, s / 96);
    ctx.beginPath(); ctx.moveTo(0, f); ctx.lineTo(s, f); ctx.stroke();
    ctx.strokeStyle = 'rgba(190,200,212,0.14)'; ctx.lineWidth = Math.max(1, s / 200);
    ctx.beginPath(); ctx.moveTo(0, f + 2); ctx.lineTo(s, f + 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(34,42,54,0.42)'; ctx.lineWidth = Math.max(1.5, s / 96);
    ctx.beginPath(); ctx.moveTo(f, 0); ctx.lineTo(f, s); ctx.stroke();
  }

  // 竖向雨痕：从缝往下淌，宽窄不一
  for (let i = 0; i < 5; i += 1) {
    const x = rnd() * s;
    const w = s * (0.02 + rnd() * 0.05);
    const top = rnd() * s * 0.35;
    const g = ctx.createLinearGradient(0, top, 0, s);
    g.addColorStop(0, 'rgba(30,38,48,0)');
    g.addColorStop(0.35, `rgba(30,38,48,${0.1 + rnd() * 0.12})`);
    g.addColorStop(1, 'rgba(30,38,48,0.04)');
    ctx.fillStyle = g;
    ctx.fillRect(x, top, w, s - top);
  }

  // 底部潮气：从下往上加深，与地面接触处不再"浮"着
  const grd = ctx.createLinearGradient(0, 0, 0, s);
  grd.addColorStop(0, 'rgba(28,36,46,0)');
  grd.addColorStop(0.7, 'rgba(28,36,46,0.10)');
  grd.addColorStop(1, 'rgba(28,36,46,0.30)');
  ctx.fillStyle = grd; ctx.fillRect(0, 0, s, s);

  speckle(ctx, s, [70, 80, 92], 0.45, 140);
};
const WOOD_TEX = (ctx, s) => {
  ctx.fillStyle = '#8a5a2a'; ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 18; i += 1) {
    const y = (i / 18) * s + Math.random() * 4;
    ctx.strokeStyle = `rgba(${90 + Math.random() * 40},${50 + Math.random() * 30},${20 + Math.random() * 20},0.5)`;
    ctx.lineWidth = 1 + Math.random() * 2;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(s, y + (Math.random() - 0.5) * 6); ctx.stroke();
  }
  speckle(ctx, s, [120, 80, 40], 0.4, 120);
};
const METAL_TEX = (ctx, s) => {
  ctx.fillStyle = '#9aa3ad'; ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 40; i += 1) {
    const y = Math.random() * s;
    ctx.strokeStyle = `rgba(255,255,255,${0.04 + Math.random() * 0.07})`;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(s, y); ctx.stroke();
  }
  speckle(ctx, s, [120, 128, 140], 0.5, 80);
};
const MEDKIT_TEX = (ctx, s) => {
  ctx.fillStyle = '#f4f6f8'; ctx.fillRect(0, 0, s, s);
  const w = s * 0.22;
  ctx.fillStyle = '#e23b3b';
  ctx.fillRect(s / 2 - w / 2, s * 0.18, w, s * 0.64);
  ctx.fillRect(s * 0.18, s / 2 - w / 2, s * 0.64, w);
};
const AMMO_TEX = (ctx, s) => {
  ctx.fillStyle = '#2b2f36'; ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = '#c9a227'; ctx.fillRect(0, s * 0.34, s, s * 0.32);
  ctx.fillStyle = '#1c1f25'; ctx.font = `bold ${Math.floor(s * 0.2)}px monospace`;
  ctx.textAlign = 'center'; ctx.fillText('5.56', s / 2, s * 0.56);
};
const ARMOR_TEX = (ctx, s) => {
  ctx.fillStyle = '#7f8c9b'; ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = 'rgba(20,24,30,0.5)';
  for (const [px, py] of [[0.18, 0.2], [0.82, 0.2], [0.18, 0.8], [0.82, 0.8]]) {
    ctx.beginPath(); ctx.arc(px * s, py * s, s * 0.05, 0, Math.PI * 2); ctx.fill();
  }
  speckle(ctx, s, [120, 132, 148], 0.4, 60);
};

/** 三张大面贴图：优先用 P12 分层烘焙，无 DOM / 关闭开关时回退到 P3 撒点画法。 */
export function getFloorTexture() {
  const m = getSurfaceMaps('floor');
  return m ? m.map : getTex('floor', FLOOR_TEX, 128);
}
export function getConcreteTexture() {
  const m = getSurfaceMaps('concrete');
  return m ? m.map : getTex('concrete', CONCRETE_TEX, 128);
}
export function getWoodTexture() { return getTex('wood', WOOD_TEX, 128); }
export function getMetalTexture() {
  const m = getSurfaceMaps('metal');
  return m ? m.map : getTex('metal', METAL_TEX, 128);
}
export function getMedkitTexture() { return getTex('medkit', MEDKIT_TEX, 64); }
export function getAmmoTexture() { return getTex('ammo', AMMO_TEX, 64); }
export function getArmorTexture() { return getTex('armor', ARMOR_TEX, 64); }

/** P3 室内灯地面光池：径向衰减的暖白贴图，纯程序化生成，零外部素材 */
const LAMP_POOL_TEX = (ctx, s) => {
  const g = ctx.createRadialGradient(s / 2, s / 2, s * 0.04, s / 2, s / 2, s * 0.5);
  g.addColorStop(0, 'rgba(255,233,196,0.95)');
  g.addColorStop(0.42, 'rgba(255,208,148,0.45)');
  g.addColorStop(1, 'rgba(255,190,120,0)');
  ctx.clearRect(0, 0, s, s);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
};
export function getLampPoolTexture() { return getTex('lampPool', LAMP_POOL_TEX, 96); }

/** P3-C2 地面贴花：血迹（径向暗红血池 + 飞溅），纯程序化，零外部素材 */
const BLOOD_TEX = (ctx, s) => {
  ctx.clearRect(0, 0, s, s);
  const g = ctx.createRadialGradient(s / 2, s / 2, s * 0.04, s / 2, s / 2, s * 0.5);
  g.addColorStop(0, 'rgba(92,12,14,0.95)');
  g.addColorStop(0.5, 'rgba(120,20,22,0.62)');
  g.addColorStop(1, 'rgba(60,8,10,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2); ctx.fill();
  for (let i = 0; i < 6; i += 1) {
    const a = Math.random() * Math.PI * 2;
    const rr = s * (0.18 + Math.random() * 0.3);
    const px = s / 2 + Math.cos(a) * rr;
    const py = s / 2 + Math.sin(a) * rr;
    const r = s * (0.03 + Math.random() * 0.05);
    ctx.fillStyle = 'rgba(110,16,18,0.7)';
    ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
  }
};
/** P3-C2 地面贴花：弹着焦痕（径向炭黑 + 零星火星焦斑），纯程序化 */
const SCORCH_TEX = (ctx, s) => {
  ctx.clearRect(0, 0, s, s);
  const g = ctx.createRadialGradient(s / 2, s / 2, s * 0.03, s / 2, s / 2, s * 0.5);
  g.addColorStop(0, 'rgba(22,18,16,0.85)');
  g.addColorStop(0.42, 'rgba(46,38,32,0.5)');
  g.addColorStop(1, 'rgba(40,34,28,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2); ctx.fill();
  for (let i = 0; i < 8; i += 1) {
    const a = Math.random() * Math.PI * 2;
    const rr = s * (0.1 + Math.random() * 0.36);
    const px = s / 2 + Math.cos(a) * rr;
    const py = s / 2 + Math.sin(a) * rr;
    const r = s * (0.012 + Math.random() * 0.03);
    ctx.fillStyle = 'rgba(14,11,9,0.7)';
    ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
  }
};
export function getBloodTexture() { return getTex('blood', BLOOD_TEX, 128); }
export function getScorchTexture() { return getTex('scorch', SCORCH_TEX, 128); }

/**
 * P5 烟幕贴图：不是规整的圆，而是若干个偏移的软斑叠出来的"团块"。
 * 规整圆在 3D 里一眼就能看出是贴片；叠斑能让相邻的几张 Sprite 互相咬合成一片体积。
 */
const SMOKE_TEX = (ctx, s) => {
  ctx.clearRect(0, 0, s, s);
  const blobs = 7;
  for (let i = 0; i < blobs; i += 1) {
    const a = (i / blobs) * Math.PI * 2 + (i % 2) * 0.4;
    const rr = s * (0.10 + (i % 3) * 0.055);
    const px = s / 2 + Math.cos(a) * s * 0.17;
    const py = s / 2 + Math.sin(a) * s * 0.17;
    const g = ctx.createRadialGradient(px, py, 0, px, py, s * 0.32);
    g.addColorStop(0, 'rgba(214,222,232,0.52)');
    g.addColorStop(0.55, 'rgba(186,196,210,0.30)');
    g.addColorStop(1, 'rgba(170,182,198,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(px, py, s * 0.32 + rr, 0, Math.PI * 2); ctx.fill();
  }
  // 中心补一层，避免中间出现"空心环"
  const core = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s * 0.34);
  core.addColorStop(0, 'rgba(222,228,238,0.42)');
  core.addColorStop(1, 'rgba(200,210,224,0)');
  ctx.fillStyle = core;
  ctx.beginPath(); ctx.arc(s / 2, s / 2, s * 0.34, 0, Math.PI * 2); ctx.fill();
};
export function getSmokeTexture() { return getTex('smoke', SMOKE_TEX, 128); }

/**
 * P5 火焰地面贴图：橙红核心 + 向外衰减，用作燃烧区的加色圆盘。
 * 中心不要纯白 —— 纯白在 tone mapping 之后会直接烧成一块死白，看不出火在动。
 */
const FIRE_TEX = (ctx, s) => {
  ctx.clearRect(0, 0, s, s);
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s * 0.5);
  g.addColorStop(0, 'rgba(255,196,96,0.92)');
  g.addColorStop(0.34, 'rgba(255,124,40,0.72)');
  g.addColorStop(0.7, 'rgba(198,54,16,0.34)');
  g.addColorStop(1, 'rgba(90,20,6,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(s / 2, s / 2, s * 0.5, 0, Math.PI * 2); ctx.fill();
  for (let i = 0; i < 10; i += 1) {
    const a = (i / 10) * Math.PI * 2;
    const rr = s * (0.12 + (i % 4) * 0.07);
    const px = s / 2 + Math.cos(a) * rr;
    const py = s / 2 + Math.sin(a) * rr;
    ctx.fillStyle = `rgba(255,${180 + (i % 3) * 20},90,${0.25 + (i % 3) * 0.08})`;
    ctx.beginPath(); ctx.arc(px, py, s * 0.05, 0, Math.PI * 2); ctx.fill();
  }
};
export function getFireTexture() { return getTex('fire', FIRE_TEX, 128); }

/* ============================ 地面 ============================ */

/**
 * 构建地面：按 tile 生成棋盘格顶点色，并提供移动时的参照感；叠加一层混凝土噪点贴图。
 * @param {object} map 地图对象
 * @returns {THREE.Mesh} 地面网格
 */
export function buildGround(map) {
  const { cols, rows, tile } = map;
  const quads = [];
  const colors = [];
  const uvs = [];
  // 地面基色由贴图 + 顶点亮度调制共同决定；PALETTE3D.ground/groundAlt 仍留给 2D 层与图例使用。

  /**
   * 地面斑驳：**按格顶点色**做低频噪声，而不是整片一个色或严格棋盘格。
   *
   * 为什么不用贴图解决：2m 一格的贴图在 20m 外就被 mipmap 平均成纯灰，
   * 大地面立刻变成一块塑料板。顶点色是几何属性，缩多远都不会被抹掉。
   * 噪声用 5 格一个波长的平滑插值，读起来是"沥青补丁/积水痕"，不是棋盘。
   */
  const hash2 = (x, y) => {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const smooth2 = (x, y) => {
    const gx = x / 5; const gy = y / 5;
    const x0 = Math.floor(gx); const y0 = Math.floor(gy);
    const fx = gx - x0; const fy = gy - y0;
    const sm = (t) => t * t * (3 - 2 * t);
    const u = sm(fx); const v = sm(fy);
    const a = hash2(x0, y0); const b = hash2(x0 + 1, y0);
    const c = hash2(x0, y0 + 1); const d = hash2(x0 + 1, y0 + 1);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };
  for (let ty = 0; ty < rows; ty += 1) {
    for (let tx = 0; tx < cols; tx += 1) {
      const x0 = tx * tile;
      const z0 = ty * tile;
      const x1 = x0 + tile;
      const z1 = z0 + tile;
      // 平面躺平：顶点顺序保证法线朝 +Y
      quads.push(x0, 0, z0, x0, 0, z1, x1, 0, z1);
      quads.push(x0, 0, z0, x1, 0, z1, x1, 0, z0);
      // P12：手写几何原本没有 uv，地面贴图一直采样不到 —— 每格铺一张可平铺贴图。
      uvs.push(0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0);
      // 顶点色在这里是**亮度调制**，不是最终反照率：
      // 贴图已经是浅灰混凝土，再乘一个接近 0 的深色会把地面压成死黑。
      // 0.5 附近让地面落到"夜间沥青/旧混凝土"的区间，斑块与逐格抖动负责打散均匀感。
      const patch = smooth2(tx, ty);
      // 0.045 是"夜间旧混凝土"的线性反照率：贴图本身是浅灰（≈0.34 线性），
      // 乘 0.05 后落到 0.017，配月光/路灯刚好读成深灰而不是白板。
      // 顶点色**必须**在 lowPolyMat 里声明才生效（见那里的注释），这组数才成立。
      const k = 0.036 + patch * 0.018 + (hash2(tx * 7 + 1, ty * 13 + 3) - 0.5) * 0.007;
      // 轻微色偏：偏冷（蓝多一点）读起来像潮湿混凝土，而不是纯灰塑料
      for (let j = 0; j < 6; j += 1) colors.push(k * 0.96, k, k * 1.04);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(quads), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geo.computeVertexNormals();
  // 地面是画面里面积最大的表面，升级为 Standard 后能吃到环境光与高光，
  // 观感提升最明显；保留顶点色棋盘格与地面贴图。
  const detail = getSurfaceMaps('floor');
  // 顶点色走构造参数（见 lowPolyMat 注释），不能事后赋值
  const groundMat = lowPolyMat('#FFFFFF', {
    standard: true,
    map: getFloorTexture(),
    roughness: VIEW3D.groundRoughness,
    metalness: VIEW3D.metalness,
    flat: false,
    vertexColors: true,
    bumpMap: detail ? detail.bumpMap : null,
    roughnessMap: detail ? detail.roughnessMap : null,
  });
  const mesh = new THREE.Mesh(geo, groundMat);
  mesh.receiveShadow = true;
  mesh.name = 'ground';
  return mesh;
}

/* ============================ 灌木 ============================ */

/**
 * 灌木：数个低分段二十面体拼成的团块（面朝任意方向，本身无朝向语义）。
 * @param {object} rng 随机源（必须来自 rng.js 子流，保证同 seed 一致）
 * @returns {THREE.BufferGeometry} 合并后的几何体（尺寸以米为单位建模）
 */
export function buildBushGeometry(rng) {
  const parts = [];
  const clusters = VIEW3D.level.bushClusters;
  for (let i = 0; i < clusters; i += 1) {
    const r = rng.float(0.26, 0.42);
    const g = new THREE.IcosahedronGeometry(r, 0);
    g.scale(1, rng.float(0.7, 1.05), 1);
    const a = (Math.PI * 2 * i) / clusters + rng.float(-0.4, 0.4);
    parts.push(at(g, Math.cos(a) * 0.24, r * 0.82, Math.sin(a) * 0.24));
  }
  const merged = mergeGeometries(parts);
  // 以米为单位建模，这里统一换算到场景单位
  merged.scale(U, U, U);
  merged.computeBoundingSphere();
  merged.userData.radiusMeters = 0.24 + 0.42; // 团块外缘半径（米），供 level3d 按逻辑半径缩放
  return merged;
}

/* ============================ 容器 ============================ */

/**
 * 各类型容器的几何体（原点在底部中心，面朝 -Z；尺寸以米为单位，已换算到场景单位）。
 * 带 trim 的类型额外提供一层"高光配件"，level3d 会为它单独开一个 InstancedMesh。
 * @returns {Record<string, {main: THREE.BufferGeometry, trim?: THREE.BufferGeometry, trimColor?: string}>}
 */
export function buildContainerParts() {
  const parts = {};

  // 抽屉：矮柜 + 两道抽屉缝（主体），把手（配件）
  {
    const main = mergeGeometries([
      at(new THREE.BoxGeometry(u(0.78), u(0.62), u(0.52)), 0, u(0.31), 0),
      at(new THREE.BoxGeometry(u(0.70), u(0.05), u(0.02)), 0, u(0.42), u(-0.27)),
      at(new THREE.BoxGeometry(u(0.70), u(0.05), u(0.02)), 0, u(0.20), u(-0.27)),
    ]);
    const trim = mergeGeometries([
      at(new THREE.BoxGeometry(u(0.26), u(0.05), u(0.05)), 0, u(0.42), u(-0.30)),
      at(new THREE.BoxGeometry(u(0.26), u(0.05), u(0.05)), 0, u(0.20), u(-0.30)),
    ]);
    parts.drawer = { main, trim, trimColor: PALETTE3D.safeTrim, mainTex: getConcreteTexture(), trimTex: getMetalTexture() };
  }

  // 补给箱：木箱 + 顶盖（主体），四角包角（配件）
  {
    const main = mergeGeometries([
      at(new THREE.BoxGeometry(u(0.92), u(0.62), u(0.70)), 0, u(0.31), 0),
      at(new THREE.BoxGeometry(u(0.98), u(0.10), u(0.76)), 0, u(0.66), 0),
    ]);
    const trim = mergeGeometries([
      at(new THREE.BoxGeometry(u(0.12), u(0.70), u(0.12)), u(-0.44), u(0.35), u(-0.33)),
      at(new THREE.BoxGeometry(u(0.12), u(0.70), u(0.12)), u(0.44), u(0.35), u(-0.33)),
      at(new THREE.BoxGeometry(u(0.12), u(0.70), u(0.12)), u(-0.44), u(0.35), u(0.33)),
      at(new THREE.BoxGeometry(u(0.12), u(0.70), u(0.12)), u(0.44), u(0.35), u(0.33)),
    ]);
    parts.crate = { main, trim, trimColor: PALETTE3D.crateTrim, mainTex: getWoodTexture(), trimTex: getMetalTexture() };
  }

  // 武器箱：长条军绿箱 + 顶盖（主体），锁扣（配件）
  {
    const main = mergeGeometries([
      at(new THREE.BoxGeometry(u(1.32), u(0.42), u(0.56)), 0, u(0.21), 0),
      at(new THREE.BoxGeometry(u(1.38), u(0.08), u(0.62)), 0, u(0.45), 0),
    ]);
    const trim = mergeGeometries([
      at(new THREE.BoxGeometry(u(0.16), u(0.18), u(0.10)), u(-0.42), u(0.40), u(-0.30)),
      at(new THREE.BoxGeometry(u(0.16), u(0.18), u(0.10)), u(0.42), u(0.40), u(-0.30)),
    ]);
    parts.weaponbox = { main, trim, trimColor: PALETTE3D.safeTrim, mainTex: getMetalTexture(), trimTex: getMetalTexture() };
  }

  // 保险箱：厚重金属箱（主体），门板 + 转盘 + 铰链（高光配件）
  {
    const main = mergeGeometries([
      at(new THREE.BoxGeometry(u(0.80), u(0.86), u(0.66)), 0, u(0.43), 0),
    ]);
    const dial = new THREE.CylinderGeometry(u(0.11), u(0.11), u(0.06), 8);
    dial.rotateX(Math.PI / 2); // 圆柱默认沿 Y 轴，转成"贴在门板上"
    const trim = mergeGeometries([
      at(new THREE.BoxGeometry(u(0.66), u(0.66), u(0.04)), 0, u(0.44), u(-0.35)),
      at(dial, u(0.14), u(0.44), u(-0.40)),
      at(new THREE.BoxGeometry(u(0.06), u(0.22), u(0.06)), u(-0.24), u(0.44), u(-0.40)),
    ]);
    parts.safe = { main, trim, trimColor: PALETTE3D.safeTrim, mainTex: getMetalTexture(), trimTex: getMetalTexture() };
  }

  // 尸体：躯干 + 头 + 四肢（贴地，无配件）
  {
    const main = mergeGeometries([
      at(new THREE.BoxGeometry(u(0.52), u(0.20), u(0.86)), 0, u(0.10), u(0.06)),
      at(new THREE.IcosahedronGeometry(u(0.15), 0), 0, u(0.14), u(-0.46)),
      at(new THREE.BoxGeometry(u(0.16), u(0.12), u(0.44)), u(-0.34), u(0.07), u(0.20)),
      at(new THREE.BoxGeometry(u(0.16), u(0.12), u(0.44)), u(0.34), u(0.07), u(0.20)),
    ]);
    parts.body = { main };
  }

  // 空投箱：主箱体 + 顶盖（主体），橙色信标条（配件，突出"稀有补给"辨识度）
  {
    const main = mergeGeometries([
      at(new THREE.BoxGeometry(u(0.95), u(0.74), u(0.75)), 0, u(0.37), 0),
      at(new THREE.BoxGeometry(u(1.02), u(0.12), u(0.82)), 0, u(0.80), 0),
    ]);
    const trim = mergeGeometries([
      // 四角橙色立柱
      at(new THREE.BoxGeometry(u(0.08), u(0.74), u(0.08)), u(-0.43), u(0.37), u(-0.30)),
      at(new THREE.BoxGeometry(u(0.08), u(0.74), u(0.08)), u(0.43), u(0.37), u(-0.30)),
      at(new THREE.BoxGeometry(u(0.08), u(0.74), u(0.08)), u(-0.43), u(0.37), u(0.30)),
      at(new THREE.BoxGeometry(u(0.08), u(0.74), u(0.08)), u(0.43), u(0.37), u(0.30)),
      // 顶盖中央信标条
      at(new THREE.BoxGeometry(u(0.66), u(0.10), u(0.12)), 0, u(0.88), 0),
    ]);
    parts.airdrop = { main, trim, trimColor: PALETTE3D.airdrop, mainTex: getMetalTexture(), trimTex: null };
  }

  return parts;
}

/** 容器类型 → 主体颜色 */
export const CONTAINER_COLORS = {
  drawer: PALETTE3D.drawer,
  crate: PALETTE3D.crate,
  weaponbox: PALETTE3D.weaponbox,
  safe: PALETTE3D.safe,
  body: PALETTE3D.body,
  airdrop: PALETTE3D.airdrop,
};

/* ============================ 撤离点 ============================ */

/**
 * 撤离点标记：地面光环 + 向上光柱（自发光材质，不参与光照计算）。
 * @param {number} radius 半径（场景单位）
 * @returns {THREE.Group} 标记组（userData 暴露 ring / beam / 材质）
 */
export function buildExtractMarker(radius) {
  const group = new THREE.Group();

  const ringGeo = new THREE.RingGeometry(radius * 0.74, radius, 24);
  ringGeo.rotateX(-Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(PALETTE3D.extract),
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.position.y = u(0.04);
  group.add(ring);

  const beamGeo = new THREE.CylinderGeometry(
    radius * 0.46, radius * 0.86, u(VIEW3D.extractBeamHeight),
    VIEW3D.level.extractBeamSegments, 1, true,
  );
  const beamMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(PALETTE3D.extract),
    transparent: true,
    opacity: 0.16,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const beam = new THREE.Mesh(beamGeo, beamMat);
  beam.position.y = u(VIEW3D.extractBeamHeight) / 2;
  group.add(beam);

  group.userData = { ring, beam, ringMat, beamMat };
  return group;
}

/* ============================ POI 目标点 ============================ */

/**
 * 数据终端：立式机柜 + 斜面发光屏幕（面朝 -Z）。
 * 屏幕用 PALETTE3D.terminal 自发光，破解后由渲染层改成 terminalHacked。
 * 约 0.7m 宽 × 1.4m 高，原点在底部中心。
 * @returns {THREE.Group} 终端模型（userData 暴露 mats / screenMat / _lastColor）
 */
export function buildTerminalModel() {
  const group = new THREE.Group();
  const bodyMat = lowPolyMat(PALETTE3D.metal);
  const baseMat = lowPolyMat(PALETTE3D.safeTrim);
  const screenMat = lowPolyMat(PALETTE3D.terminal, { emissive: PALETTE3D.terminal });

  // 底座
  const base = new THREE.Mesh(new THREE.BoxGeometry(u(0.80), u(0.18), u(0.70)), baseMat);
  base.position.y = u(0.09);
  group.add(base);

  // 机柜主体
  const cabinet = new THREE.Mesh(new THREE.BoxGeometry(u(0.70), u(1.00), u(0.50)), bodyMat);
  cabinet.position.y = u(0.18 + 0.50);
  group.add(cabinet);

  // 顶盖
  const cap = new THREE.Mesh(new THREE.BoxGeometry(u(0.74), u(0.12), u(0.54)), bodyMat);
  cap.position.y = u(0.18 + 1.00 + 0.06);
  group.add(cap);

  // 斜面屏幕（朝 -Z 面，顶部向后倾斜，便于俯视辨识）
  const screenGeo = new THREE.BoxGeometry(u(0.58), u(0.44), u(0.06));
  screenGeo.rotateX(0.32); // 顶部后倾
  const screen = new THREE.Mesh(screenGeo, screenMat);
  screen.position.set(0, u(0.95), -u(0.27));
  group.add(screen);

  const mats = [bodyMat, baseMat, screenMat];
  group.traverse((o) => { if (o.isMesh) o.castShadow = true; });

  group.userData = {
    mats,
    screenMat,
    _lastColor: null, // 渲染层缓存比对用，避免逐帧写材质
  };
  return group;
}

/**
 * M-03 闸刀：底座 + 立柱 + 可扳动拉杆（面朝 -Z）。
 * 未拉时拉杆自发光琥珀（PALETTE3D.airdrop），拉下后渲染层改成 terminalHacked 绿。
 * 约 0.6m 宽 × 1.1m 高，原点在底部中心；结构与终端同构，便于共用交互模型。
 * @returns {THREE.Group} 闸刀模型（userData 暴露 leverMat / _lastColor）
 */
export function buildSwitchModel() {
  const group = new THREE.Group();
  const metal = lowPolyMat(PALETTE3D.metal);
  const trim = lowPolyMat(PALETTE3D.safeTrim);
  const leverMat = lowPolyMat(PALETTE3D.airdrop, { emissive: PALETTE3D.airdrop });

  const base = new THREE.Mesh(new THREE.BoxGeometry(u(0.62), u(0.16), u(0.52)), trim);
  base.position.y = u(0.08);
  group.add(base);
  const post = new THREE.Mesh(new THREE.BoxGeometry(u(0.20), u(0.86), u(0.18)), metal);
  post.position.y = u(0.16 + 0.43);
  group.add(post);
  // 拉杆向上前倾，拉开与终端方盒的轮廓差异（一眼能认出"这是能扳的东西"）
  const leverGeo = new THREE.BoxGeometry(u(0.13), u(0.52), u(0.12));
  leverGeo.rotateX(-0.38);
  const lever = new THREE.Mesh(leverGeo, leverMat);
  lever.position.set(0, u(0.99), -u(0.16));
  group.add(lever);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(u(0.22), u(0.13), u(0.18)), trim);
  grip.position.set(0, u(1.22), -u(0.26));
  group.add(grip);

  group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  group.userData = { leverMat, _lastColor: null };
  return group;
}

/**
 * 空投信标：地面光环 + 向上光柱（比撤离点更亮更高，突出"稀有"）。
 * 半径以场景单位传入（与 buildExtractMarker 一致，直接吃逻辑半径、不额外套 u()）。
 * @param {number} radius 半径（场景单位）
 * @returns {THREE.Group} 信标组（userData 暴露 ring / beam / mats）
 */
export function buildAirdropBeacon(radius) {
  const group = new THREE.Group();
  const color = PALETTE3D.airdrop;

  const ringGeo = new THREE.RingGeometry(radius * 0.6, radius, 28);
  ringGeo.rotateX(-Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity: 0.7,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.position.y = u(0.05);
  group.add(ring);

  // 比撤离点更高（×1.4）的传说金光柱
  const beamH = u(VIEW3D.extractBeamHeight * 1.4);
  const beamGeo = new THREE.CylinderGeometry(
    radius * 0.36, radius * 0.70, beamH,
    VIEW3D.level.extractBeamSegments, 1, true,
  );
  const beamMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity: 0.30, // 比撤离点更亮
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const beam = new THREE.Mesh(beamGeo, beamMat);
  beam.position.y = beamH / 2;
  group.add(beam);

  group.userData = { ring, beam, mats: [ringMat, beamMat] };
  return group;
}

/**
 * 构建一辆越野载具（车头朝 +X，与逻辑角 0 一致）。
 * 低多边形：底盘 + 驾驶舱 + 货斗 + 4 个轮子 + 挡风玻璃，全部程序化，无外部资源。
 *
 * P1-2 性能：载具是纯静态场景道具（轮子不转，全仓无 wheels 引用），原先 13 个独立 Mesh
 * = 13 draw；改为**按材质合并几何**，5 种材质各 1 个 Mesh = 5 draw。视觉逐面一致，
 * 只是少了 8 次 draw call。若将来要轮子滚动，需把 wheel 组拆回独立 Mesh。
 * @returns {THREE.Group} 载具模型（userData 暴露 mats 供统一改色）
 */
export function buildVehicleModel() {
  const group = new THREE.Group();
  const bodyMat = lowPolyMat(PALETTE3D.vehicleBody || PALETTE3D.metal);
  const darkMat = lowPolyMat(PALETTE3D.vehicleDark || '#2A2E33');
  const glassMat = lowPolyMat(PALETTE3D.vehicleGlass || '#7FA8C4');
  const wheelMat = lowPolyMat('#15171A');
  const lampMat = lowPolyMat('#F2E2B0', { emissive: '#F2E2B0' });

  const L = 4.3; // 车长（米）
  const W = 1.95; // 车宽
  const wheelR = 0.42;
  const cabLen = L * 0.42;

  // 按材质收集已就位的几何，最后各合并成 1 个 Mesh（视觉不变，draw 13→5）。
  const byMat = new Map();
  const add = (mat, geo) => { if (!byMat.has(mat)) byMat.set(mat, []); byMat.get(mat).push(geo); };
  const box = (sx, sy, sz, x, y, z) => at(new THREE.BoxGeometry(u(sx), u(sy), u(sz)), x, y, z);

  add(darkMat, box(L, 0.55, W, 0, u(wheelR + 0.12), 0));                 // 底盘
  add(bodyMat, box(L * 0.92, 0.62, W * 0.96, 0, u(wheelR + 0.55), 0));   // 车身
  add(bodyMat, box(cabLen, 0.62, W * 0.86, u(L * 0.16), u(wheelR + 1.15), 0)); // 驾驶舱
  add(glassMat, box(0.08, 0.44, W * 0.74, u(L * 0.16 + cabLen / 2 + 0.02), u(wheelR + 1.15), 0));
  for (const dz of [-1, 1]) {
    add(bodyMat, box(L * 0.30, 0.30, 0.10, -u(L * 0.24), u(wheelR + 0.95), dz * u(W * 0.46))); // 货斗围栏
  }
  add(bodyMat, box(0.10, 0.30, W * 0.92, -u(L * 0.38), u(wheelR + 0.95), 0)); // 尾板

  // 4 个轮子：共享一个已旋转的圆柱原型，每份 clone 后平移到位再合并
  const wheelProto = new THREE.CylinderGeometry(u(wheelR), u(wheelR), u(0.26), 10);
  wheelProto.rotateX(Math.PI / 2);
  for (const dx of [1, -1]) {
    for (const dz of [1, -1]) {
      add(wheelMat, at(wheelProto.clone(), dx * u(L * 0.30), u(wheelR), dz * u(W * 0.50)));
    }
  }
  wheelProto.dispose();

  // 车灯（车头两盏，自发光便于远处识别）
  for (const dz of [-1, 1]) {
    add(lampMat, box(0.08, 0.18, 0.22, u(L * 0.47), u(wheelR + 0.62), dz * u(W * 0.30)));
  }

  for (const [mat, geos] of byMat) {
    const merged = mergeGeometries(geos);
    for (const g of geos) g.dispose();
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = true;
    group.add(mesh);
  }
  group.userData = { mats: [bodyMat, darkMat, glassMat, wheelMat, lampMat] };
  return group;
}

/* ============================ 敌人 ============================ */

/**
 * 构建一个敌人模型（独立 Group，便于各自转向与受击闪红）。
 * @param {string} typeId 敌人类型（patrol / elite / marksman / rusher）
 * @returns {THREE.Group} 敌人模型
 */
export function buildEnemyModel(typeId, opts = {}) {
  // 体型：精英与精确射手用大号，冲锋兵用瘦小号，其余用标准
  const dims = VIEW3D.enemy;
  const dim = (typeId === 'elite' || typeId === 'marksman')
    ? dims.elite
    : (typeId === 'rusher' ? dims.rusher : dims.patrol);
  const tints = {
    patrol: PALETTE3D.enemyPatrol,
    elite: PALETTE3D.enemyElite,
    marksman: PALETTE3D.enemyMarksman,
    rusher: PALETTE3D.enemyRusher,
  };
  // opts.tint 允许复用同一套建模逻辑给友军（改色），不改变敌人默认外观。
  const tint = (opts && opts.tint) || tints[typeId] || PALETTE3D.enemyPatrol;
  const group = new THREE.Group();
  // P0-3：远距离/低画质可隐藏的小部件（脸、眼、眉、鼻、耳罩、帽檐、弹匣袋、肩甲、背包顶）。
  // 它们对轮廓识别贡献很小，但每个都是一次 draw；GLB 接管后整组程序化部件会被隐藏。
  const detailMeshes = [];

  const bodyMat = lowPolyMat(tint); // 军服
  const darkMat = lowPolyMat(PALETTE3D.vmDark); // 背心 / 靴 / 手套 / 耳机
  const gunMat = lowPolyMat(PALETTE3D.vmBody); // 武器
  const skinMat = lowPolyMat(PALETTE3D.hand); // 面部与手（皮肤色）
  const helmetMat = lowPolyMat(PALETTE3D.helmet);
  const packMat = lowPolyMat(PALETTE3D.backpack);
  const eyeMat = lowPolyMat('#12161A'); // 眼部暗色，做出"有脸"
  // mats 用于受击闪红，因此要覆盖所有可见材质
  const mats = [bodyMat, darkMat, gunMat, skinMat, helmetMat, packMat];

  // #P0-2 夜战可见性：给敌人全体可见材质加一层轻微自发光，暗处也能看清轮廓
  // （30m 外仍可见）。baseEmissive 会被 renderer3d 的受击闪红逻辑还原，
  // 空闲帧不会被刷成纯黑而丢失底亮度。友军走独立的绿色自发光，便于战场上和敌人区分。
  const ENEMY_EM = new THREE.Color((opts && opts.emissive) || VIEW3D.enemyEmissive);
  const ENEMY_EMI = (opts && opts.emissiveIntensity != null)
    ? opts.emissiveIntensity
    : VIEW3D.enemyEmissiveIntensity;
  for (const m of mats) {
    m.emissive.copy(ENEMY_EM);
    m.emissiveIntensity = ENEMY_EMI;
    m.userData.baseEmissive = ENEMY_EM.clone();
  }

  const legH = u(dim.legH);
  const torsoH = u(dim.torsoH);
  const torsoW = u(dim.torsoW);
  const torsoD = u(dim.torsoD);

  const headR = u(dim.headR);

  /* ---------- 下半身：髋 → 大腿 → 膝 → 小腿 → 靴 ---------- */
  const thighH = legH * 0.46;
  const shinH = legH * 0.40;
  const bootH = legH * 0.14;
  const legW = u(0.19);
  const legD = u(0.20);
  const legs = [];
  for (const side of [-1, 1]) {
    const hip = new THREE.Group(); // 髋关节：走路时绕它摆动整条腿
    hip.position.set(side * torsoW * 0.24, legH, 0);

    const thigh = new THREE.Mesh(new THREE.BoxGeometry(legW, thighH, legD), bodyMat);
    thigh.position.y = -thighH / 2;
    hip.add(thigh);

    const knee = new THREE.Group(); // 膝关节：抬腿时弯小腿
    knee.position.y = -thighH;
    const shin = new THREE.Mesh(new THREE.BoxGeometry(legW * 0.92, shinH, legD * 0.9), bodyMat);
    shin.position.y = -shinH / 2;
    knee.add(shin);

    const boot = new THREE.Mesh(new THREE.BoxGeometry(legW * 1.04, bootH, legD * 1.40), darkMat);
    boot.position.set(0, -shinH - bootH / 2, -u(0.03));
    knee.add(boot);

    hip.add(knee);
    group.add(hip);
    legs.push({ hip, knee });
  }

  /* ---------- 躯干（整体作为一个 Group，便于做呼吸 / 步行的上下起伏） ---------- */
  const torso = new THREE.Group();
  torso.position.y = legH;
  group.add(torso);

  const pelvis = new THREE.Mesh(new THREE.BoxGeometry(torsoW * 0.92, torsoH * 0.20, torsoD), darkMat);
  pelvis.position.y = torsoH * 0.10;
  torso.add(pelvis);

  const abdomen = new THREE.Mesh(new THREE.BoxGeometry(torsoW * 0.86, torsoH * 0.34, torsoD * 0.92), bodyMat);
  abdomen.position.y = torsoH * 0.36;
  torso.add(abdomen);

  const chest = new THREE.Mesh(new THREE.BoxGeometry(torsoW, torsoH * 0.40, torsoD), bodyMat);
  chest.position.y = torsoH * 0.70;
  torso.add(chest);

  // 战术背心（比躯干大一圈，压在胸腹上）
  const vest = new THREE.Mesh(
    new THREE.BoxGeometry(torsoW * 1.08, torsoH * 0.56, torsoD * 1.12),
    darkMat,
  );
  vest.position.y = torsoH * 0.60;
  torso.add(vest);

  // 胸前弹匣袋
  for (const side of [-1, 1]) {
    const pouch = new THREE.Mesh(new THREE.BoxGeometry(u(0.11), u(0.14), u(0.07)), packMat);
    pouch.position.set(side * torsoW * 0.30, torsoH * 0.42, -torsoD * 0.58);
    torso.add(pouch);
    detailMeshes.push(pouch);
  }

  // 腰带
  const belt = new THREE.Mesh(new THREE.BoxGeometry(torsoW * 1.02, u(0.08), torsoD * 1.04), darkMat);
  belt.position.y = torsoH * 0.20;
  torso.add(belt);

  // 肩甲
  for (const side of [-1, 1]) {
    const pad = new THREE.Mesh(new THREE.BoxGeometry(u(0.20), u(0.13), torsoD * 0.9), darkMat);
    pad.position.set(side * (torsoW * 0.5 + u(0.06)), torsoH * 0.86, 0);
    torso.add(pad);
    detailMeshes.push(pad);
  }

  /* ---------- 颈 + 头 + 五官 ---------- */
  const neckY = torsoH * 0.98;
  const neck = new THREE.Mesh(new THREE.BoxGeometry(u(0.13), u(0.10), u(0.13)), skinMat);
  neck.position.y = neckY;
  torso.add(neck);

  const head = new THREE.Group(); // 头部独立成组，便于做扫视
  head.position.y = neckY + u(0.06) + headR;
  torso.add(head);

  const headW = headR * 1.72;
  const headH2 = headR * 2.0;
  const headD = headR * 1.78;
  const skull = new THREE.Mesh(new THREE.BoxGeometry(headW, headH2, headD), skinMat);
  head.add(skull);

  // 正面：脸板 + 双眼 + 眉骨 + 鼻梁 + 护目镜带 —— low-poly 但五官分明，不再是无脸方块
  const faceZ = -headD / 2 - u(0.004);
  const face = new THREE.Mesh(new THREE.BoxGeometry(headW * 0.92, headH2 * 0.72, u(0.02)), skinMat);
  face.position.set(0, -headH2 * 0.04, faceZ);
  head.add(face);
  detailMeshes.push(face);

  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.BoxGeometry(headW * 0.24, u(0.045), u(0.02)), eyeMat);
    eye.position.set(side * headW * 0.24, headH2 * 0.10, faceZ - u(0.012));
    head.add(eye);
    detailMeshes.push(eye);
    // 眉骨压在眼睛上方，让眼神更有压迫感
    const brow = new THREE.Mesh(new THREE.BoxGeometry(headW * 0.30, u(0.028), u(0.02)), darkMat);
    brow.position.set(side * headW * 0.24, headH2 * 0.19, faceZ - u(0.012));
    head.add(brow);
    detailMeshes.push(brow);
  }

  const nose = new THREE.Mesh(new THREE.BoxGeometry(u(0.05), u(0.06), u(0.05)), skinMat);
  nose.position.set(0, -headH2 * 0.04, faceZ - u(0.03));
  head.add(nose);
  detailMeshes.push(nose);

  // 通讯耳罩
  for (const side of [-1, 1]) {
    const cup = new THREE.Mesh(new THREE.BoxGeometry(u(0.05), u(0.11), u(0.09)), darkMat);
    cup.position.set(side * (headW * 0.5 + u(0.015)), headH2 * 0.04, 0);
    head.add(cup);
    detailMeshes.push(cup);
  }

  // 头盔：盔体 + 帽檐
  const helmet = new THREE.Mesh(new THREE.IcosahedronGeometry(headR * 1.16, 1), helmetMat);
  helmet.position.y = headR * 0.20;
  helmet.scale.set(1, 0.82, 1.04);
  head.add(helmet);
  const brim = new THREE.Mesh(new THREE.BoxGeometry(headW * 1.10, u(0.05), u(0.14)), helmetMat);
  brim.position.set(0, headR * 0.34, faceZ - u(0.02));
  head.add(brim);
  detailMeshes.push(brim);

  /* ---------- 背包（模型面朝 -Z，背包在 +Z 侧） ---------- */
  const pack = new THREE.Mesh(
    new THREE.BoxGeometry(torsoW * 0.58, torsoH * 0.58, u(0.20)),
    packMat,
  );
  pack.position.set(0, torsoH * 0.62, torsoD * 0.62);
  torso.add(pack);
  const packTop = new THREE.Mesh(new THREE.BoxGeometry(torsoW * 0.40, u(0.10), u(0.14)), darkMat);
  packTop.position.set(0, torsoH * 0.92, torsoD * 0.60);
  torso.add(packTop);
  detailMeshes.push(packTop);

  /* ---------- 手臂：肩 → 上臂 → 肘 → 前臂 → 手 ---------- */
  const arms = [];
  const upperH = torsoH * 0.34;
  const foreH = torsoH * 0.30;
  for (const side of [-1, 1]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * (torsoW * 0.5 + u(0.07)), torsoH * 0.82, 0);

    const upper = new THREE.Mesh(new THREE.BoxGeometry(u(0.14), upperH, u(0.15)), bodyMat);
    upper.position.y = -upperH / 2;
    shoulder.add(upper);

    const elbow = new THREE.Group();
    elbow.position.y = -upperH;
    const fore = new THREE.Mesh(new THREE.BoxGeometry(u(0.12), foreH, u(0.13)), bodyMat);
    fore.position.y = -foreH / 2;
    elbow.add(fore);
    const hand = new THREE.Mesh(new THREE.BoxGeometry(u(0.11), u(0.11), u(0.12)), skinMat);
    hand.position.y = -foreH - u(0.04);
    elbow.add(hand);

    shoulder.add(elbow);
    torso.add(shoulder);
    arms.push({ shoulder, elbow });
  }

  /* ---------- 武器与枪口火光 ---------- */
  const gun = new THREE.Mesh(
    new THREE.BoxGeometry(u(0.11), u(0.13), u(VIEW3D.enemy.gunLength)),
    gunMat,
  );
  gun.position.set(u(0.10), torsoH * 0.55, -u(VIEW3D.enemy.gunLength) * 0.42);
  torso.add(gun);
  const gunMag = new THREE.Mesh(new THREE.BoxGeometry(u(0.07), u(0.16), u(0.09)), darkMat);
  gunMag.position.set(u(0.10), torsoH * 0.42, -u(0.10));
  torso.add(gunMag);

  const flash = new THREE.Mesh(
    new THREE.IcosahedronGeometry(u(VIEW3D.fx.muzzleFlashScale) * 0.5, 0),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(VIEW3D.fx.muzzleFlashColor),
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  flash.position.set(u(0.10), torsoH * 0.55, -u(VIEW3D.enemy.gunLength) * 0.95);
  flash.visible = false;
  torso.add(flash);

  group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  // P1-2：关节组内的静态小件按材质合并（?glb=0 路径；GLB 接管后整组隐藏也省内存）。
  // keep 里必须含 detailMeshes（逐帧 visible）与 flash（枪口火光），否则 P0-3 LOD 会失效。
  // noMerge 只给单测 A/B 用，默认路径永远合并。
  const mergedAway = opts && opts.noMerge
    ? 0
    : mergeRigidParts(group, [...detailMeshes, flash, gun]);

  group.userData = {
    mats,
    flash,
    gun,
    head,
    detailMeshes,
    mergedAway,
    baseTint: new THREE.Color(tint),
    // 动画用的可动部件（渲染层按 walkPhase / wantsMove 驱动）
    parts: { torso, head, legs, arms, torsoBaseY: legH },
  };
  return group;
}

/**
 * 构建本地 AI 队友模型（复用敌人建模，改军服为绿色 + 绿色自发光，战场上可被一眼区分）。
 * @param {string} [color] 干员主色（来自 ally.color），缺省回落到 PALETTE3D.green
 * @returns {THREE.Group} 队友模型
 */
export function buildAllyModel(color) {
  return buildEnemyModel('patrol', {
    tint: color || PALETTE3D.green,
    emissive: '#0e3b2c',
    emissiveIntensity: VIEW3D.enemyEmissiveIntensity * 1.15,
  });
}

/* ======================= 局外：干员展示台模型 ======================= */

/**
 * 干员军服基色（按编制分工）。
 *
 * 展示台**不能**直接拿「干员主色」当军服色：主色是 UI 强调色（亮红 / 亮青 / 亮绿 / 亮橙），
 * 铺满全身就是一颗发光糖果（实测截图里那名"薄荷绿士兵"）。军服走统一的战术基色，
 * 干员主色只出现在胸章 / 肩章 / 盔带三个小件上 —— 远看是"一个兵"，近看才认得出是谁。
 */
export const OP_UNIFORM = {
  ASSAULT: '#4E523F', // 突击：橄榄绿
  RECON: '#3F4A47',   // 侦察：冷灰绿
  SUPPORT: '#544B3A', // 支援：沙棕
  CONTROL: '#463F39', // 控场：炭褐
};

/** 展示台通用装备色（比军服更深，负责"战术"质感与轮廓分层） */
const SHOWCASE_GEAR = {
  dark: '#1E2426',   // 板甲 / 靴 / 手套 / 头盔 / 枪身
  mid: '#2B3331',    // 背包 / 护膝 / 弹匣袋
  olive: '#39402F',  // 副色装备（枪套 / 侧袋）
  skin: '#9C7A57',   // 皮肤（比 PALETTE3D.hand 深一档：后者在棚拍灯下会白到发光）
  lens: '#5E7E86',   // 护目镜片
  trouser: '#3D4438', // 裤子（比军服深一档，与上衣拉开一个层次）
};

/**
 * 构建局外「装备配置」屏的干员展示模型。
 *
 * 为什么不复用 `buildEnemyModel`：那套模型是给 **10~40 米外的剪影识别** 设计的 ——
 * 头盔是一个半径 8.8 单位的二十面体球，把整颗头裹在里面，而脸板只有 6.0×5.5，
 * 于是深色球面从脸里穿出来，近看是"脸里长了两块黑疙瘩"；头宽 / 肩宽 = 0.53，
 * 比真人（≈0.34）胖一圈。远看没问题，摆到 226px 的展示台上就成了一颗大头棉花糖。
 * 展示台是**近景正面**，必须另建一套：真实比例（≈7.2 头身）、方块盔（不再是球）、
 * 护目镜 + 面罩（近景"有脸"，远景依然是清晰剪影）、低据枪姿态。
 *
 * 坐标系约定（与全项目一致）：模型面朝 **-Z**，+Z 是背后（背包侧），+Y 向上，1 单位 = 1/20 米。
 * 全部尺寸以**米**书写再走 `u()`，方便与 config 里的 VIEW3D 对照。
 *
 * @param {object} op 干员档案（operators.js）
 * @param {object} [opts]
 * @param {boolean} [opts.rifle=true] 是否持枪（单测/纯人形检查时可关）
 * @returns {THREE.Group} 展示用模型（调用方负责 dispose）
 */
export function buildOperatorShowcase(op, opts = {}) {
  const accent = (op && op.color) || '#E2574C';
  const uniform = OP_UNIFORM[(op && op.role)] || OP_UNIFORM.ASSAULT;

  const group = new THREE.Group();
  const matUniform = lowPolyMat(uniform);
  // 裤子比上衣深一档：全身只有一个亮度层会糊成一块布，分层才看得出"装备穿在人身上"
  const matTrouser = lowPolyMat(SHOWCASE_GEAR.trouser);
  const matDark = lowPolyMat(SHOWCASE_GEAR.dark);
  const matMid = lowPolyMat(SHOWCASE_GEAR.mid);
  const matOlive = lowPolyMat(SHOWCASE_GEAR.olive);
  const matSkin = lowPolyMat(SHOWCASE_GEAR.skin);
  const matLens = lowPolyMat(SHOWCASE_GEAR.lens);
  const matAccent = lowPolyMat(accent);
  const allMats = [matUniform, matTrouser, matDark, matMid, matOlive, matSkin, matLens, matAccent];
  // 展示台不吃自发光：棚拍灯已经够亮，任何 emissive 都会把方块冲成贴纸
  for (const m of allMats) {
    if (m.emissive) m.emissive.setRGB(0, 0, 0);
    m.emissiveIntensity = 0;
  }

  /** 放一个方块（尺寸/位置都以米给，y 是**中心**） */
  const box = (w, h, d, mat, x, y, z, parent) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(u(w), u(h), u(d)), mat);
    mesh.position.set(u(x), u(y), u(z));
    (parent || group).add(mesh);
    mesh.castShadow = true;
    return mesh;
  };
  /** 在两点之间放一根"骨头"（用于手臂：起止点确定，方向由几何自动求） */
  const UP = new THREE.Vector3(0, 1, 0);
  const bone = (a, b, w, d, mat, parent) => {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    if (len < 1e-4) return null;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(u(w), len, u(d)), mat);
    mesh.position.copy(a).addScaledVector(dir, 0.5);
    mesh.quaternion.setFromUnitVectors(UP, dir.clone().normalize());
    (parent || group).add(mesh);
    mesh.castShadow = true;
    return mesh;
  };

  /* ---------------- 腿 / 靴 ---------------- */
  for (const side of [-1, 1]) {
    const x = side * 0.105;
    box(0.18, 0.13, 0.31, matDark, x, 0.065, -0.02);      // 靴
    box(0.185, 0.035, 0.32, matMid, x, 0.018, -0.02);     // 靴底（比靴身亮一档，脚底不会糊成一块）
    box(0.17, 0.34, 0.185, matTrouser, x, 0.30, 0);       // 小腿
    box(0.19, 0.055, 0.205, matTrouser, x, 0.155, 0);     // 裤脚压在靴筒上（不压就是"裤管悬空"）
    box(0.19, 0.115, 0.20, matMid, x, 0.50, -0.01);       // 护膝
    box(0.195, 0.44, 0.215, matTrouser, x, 0.72, 0);      // 大腿
    box(0.10, 0.13, 0.03, matTrouser, x, 0.70, -0.125);   // 大腿侧袋（打破裤腿的大色块）
  }
  // 右腿枪套（"腿上挂件"是这类硬核射击的标志性记忆点，也是左右不对称的识别特征）
  box(0.09, 0.16, 0.105, matOlive, 0.168, 0.70, -0.02);
  box(0.048, 0.08, 0.05, matDark, 0.168, 0.80, -0.03);

  /* ---------------- 髋 / 腰带 ---------------- */
  box(0.35, 0.15, 0.225, matUniform, 0, 0.985, 0);
  box(0.365, 0.062, 0.24, matDark, 0, 1.055, 0);
  box(0.072, 0.09, 0.05, matMid, -0.135, 1.05, -0.118);   // 腰包
  box(0.072, 0.09, 0.05, matMid, 0.135, 1.05, -0.118);

  /* ---------------- 躯干 + 战术背心 ---------------- */
  box(0.35, 0.16, 0.225, matUniform, 0, 1.115, 0);        // 腰腹
  box(0.42, 0.36, 0.245, matUniform, 0, 1.33, 0);         // 胸
  box(0.36, 0.32, 0.066, matDark, 0, 1.335, -0.142);      // 前板
  box(0.36, 0.28, 0.066, matDark, 0, 1.325, 0.142);       // 背板
  box(0.44, 0.16, 0.26, matMid, 0, 1.135, 0);             // 腰封（把胸腹束成一体）
  for (const side of [-1, 1]) {
    box(0.09, 0.06, 0.22, matDark, side * 0.135, 1.505, 0);            // 肩带
    box(0.105, 0.065, 0.235, matMid, side * 0.225, 1.485, 0);          // 肩垫（盖住手臂接缝）
  }
  // 前板上的三个弹匣袋（近景细节担当）
  for (const dx of [-0.095, 0, 0.095]) {
    box(0.08, 0.10, 0.045, matMid, dx, 1.255, -0.195);
    box(0.08, 0.02, 0.048, matDark, dx, 1.312, -0.196);
  }
  // 干员主色 ①：胸章（前板左上角，军衔/呼号牌的位置）
  box(0.07, 0.024, 0.008, matAccent, -0.11, 1.425, -0.178);
  // 干员主色 ②：右肩章
  box(0.055, 0.016, 0.14, matAccent, 0.225, 1.519, 0);

  /* ---------------- 背包（+Z 侧）：等级决定体积 ---------------- */
  // W3：换背包实时反映在模型上。none 只留贴身小包；lv1/lv2/lv3 逐级加大。
  const packLevel = opts.backpack === 'bp_lv3' ? 3 : (opts.backpack === 'bp_lv2' ? 2 : (opts.backpack === 'bp_lv1' ? 1 : 0));
  const packH = 0.16 + packLevel * 0.035;
  const packD = 0.06 + packLevel * 0.022;
  box(0.27, packH, packD, matMid, 0, 1.335, 0.135 + packD / 2);
  box(0.21, 0.045, packD + 0.005, matDark, 0, 1.335 + packH / 2, 0.135 + packD / 2);
  if (packLevel >= 2) {
    box(0.045, 0.10, 0.06, matDark, 0.105, 1.395, 0.145 + packD);   // 侧挂电台（中大型背包才有）
  }
  if (packLevel >= 3) {
    box(0.06, 0.14, 0.05, matOlive, -0.11, 1.39, 0.145 + packD);    // 远征包侧袋
  }

  /* ---------------- 颈 + 头 ---------------- */
  box(0.105, 0.075, 0.105, matSkin, 0, 1.545, 0);
  box(0.13, 0.085, 0.13, matDark, 0, 1.53, 0);            // 护颈（遮住颈根，避免"头浮在肩上"）
  box(0.155, 0.22, 0.19, matSkin, 0, 1.68, 0);            // 颅
  box(0.157, 0.11, 0.192, matDark, 0, 1.598, 0);          // 面罩（下半脸）
  box(0.161, 0.054, 0.028, matDark, 0, 1.706, -0.098);    // 护目镜框
  for (const side of [-1, 1]) {
    box(0.058, 0.038, 0.014, matLens, side * 0.038, 1.706, -0.112); // 镜片
    box(0.032, 0.066, 0.072, matDark, side * 0.088, 1.69, 0);       // 耳罩
  }
  // 头盔：壳 + 顶 + 帽檐 + 夜视支架（四个方块拼一个"现代战术盔"，绝不用球体 —— 球体近看会从脸里穿出来）
  // W3：opts.helmet === 'none' 时不戴盔，露出头发块；有盔时按等级加面罩护板。
  const hasHelmet = opts.helmet !== 'none';
  if (hasHelmet) {
    box(0.187, 0.088, 0.216, matDark, 0, 1.792, 0);
    box(0.134, 0.032, 0.17, matDark, 0, 1.85, 0);
    box(0.192, 0.024, 0.064, matDark, 0, 1.756, -0.127);
    box(0.052, 0.036, 0.042, matMid, 0, 1.806, -0.119);
    if (opts.helmet === 'helmet_lv3') {
      box(0.16, 0.07, 0.03, matMid, 0, 1.60, -0.116);   // 三级盔面罩护板
    }
    // 干员主色 ③：盔带（颈部以上唯一的高饱和色块 = 一眼认人）
    box(0.192, 0.014, 0.22, matAccent, 0, 1.833, 0);
  } else {
    box(0.16, 0.06, 0.19, matDark, 0, 1.79, 0);         // 不戴盔：一顶低矮的软帽/头发
  }

  /* ---------------- 手臂（低据枪：手掌落在枪上，不是垂在身侧） ---------------- */
  // 先摆枪，再由枪上的握点反推手腕位置 —— 顺序反了就会出现"手握空气"。
  const rifle = new THREE.Group();
  const RIFLE_AT = { x: 0.03, y: 1.235, z: -0.235 };
  const RIFLE_ROT = { x: 0.16, y: 0.34, z: 0.04 };
  rifle.position.set(u(RIFLE_AT.x), u(RIFLE_AT.y), u(RIFLE_AT.z));
  rifle.rotation.set(RIFLE_ROT.x, RIFLE_ROT.y, RIFLE_ROT.z);
  if (opts.rifle !== false) {
    group.add(rifle);
    box(0.055, 0.09, 0.40, matDark, 0, 0, 0, rifle);            // 机匣
    box(0.05, 0.062, 0.20, matMid, 0, 0.004, -0.26, rifle);     // 护木
    box(0.028, 0.028, 0.26, matDark, 0, 0.014, -0.33, rifle);   // 枪管
    box(0.042, 0.042, 0.05, matDark, 0, 0.014, -0.47, rifle);   // 制退器
    box(0.045, 0.075, 0.17, matMid, 0, -0.004, 0.275, rifle);   // 枪托
    box(0.04, 0.10, 0.055, matDark, 0, -0.085, 0.075, rifle);   // 握把
    box(0.036, 0.13, 0.072, matDark, 0, -0.10, -0.03, rifle);   // 弹匣
    box(0.04, 0.042, 0.115, matDark, 0, 0.072, -0.03, rifle);   // 瞄具
  }
  group.updateMatrixWorld(true);
  // 握点（枪的局部坐标 → 世界坐标；group 还在原点，所以世界系 = 模型系）
  const toWorld = (x, y, z) => rifle.localToWorld(new THREE.Vector3(u(x), u(y), u(z)));
  const gripP = toWorld(0, -0.085, 0.075);      // 右手：握把
  const guardP = toWorld(0, -0.005, -0.26);     // 左手：护木

  for (const side of [-1, 1]) {
    const shoulder = new THREE.Vector3(u(side * 0.245), u(1.465), 0);
    const wrist = side > 0 ? gripP : guardP;
    const mid = new THREE.Vector3().addVectors(shoulder, wrist).multiplyScalar(0.5);
    // 肘：推到肩腕连线之外、略偏后下方，形成自然弯曲（不是直棍）
    const elbow = mid.clone().add(new THREE.Vector3(u(side * 0.095), u(-0.085), u(0.075)));
    bone(shoulder, elbow, 0.105, 0.115, matUniform);
    bone(elbow, wrist, 0.092, 0.10, matUniform);
    // 手套：套在腕上并略微超过握点，形成"抓着"的体积
    const hand = new THREE.Mesh(new THREE.BoxGeometry(u(0.082), u(0.075), u(0.10)), matDark);
    hand.position.copy(wrist).addScaledVector(new THREE.Vector3().subVectors(wrist, elbow).normalize(), u(0.03));
    hand.quaternion.setFromUnitVectors(UP, new THREE.Vector3().subVectors(wrist, elbow).normalize());
    hand.castShadow = true;
    group.add(hand);
  }

  group.userData = {
    mats: allMats,
    accentColor: accent,
    uniformColor: uniform,
    // 供探针/调试读：这套模型不用 renderer3d 的 parts 动画（静态展示）
    staticShowcase: true,
  };
  return group;
}

/* ============================ 武器视图模型 ============================ */


/**
 * 构建武器视图模型（挂在相机下，故不投影、不参与世界光照阴影）。
 * @param {string} weaponId 武器 id（rifle / smg / pistol）
 * @param {string[]} [mods] 已装配附件 id 列表（P6 改枪台）；只影响外形，数值在 cmd 层结算
 * @returns {THREE.Group} 视图模型
 */
export function buildViewmodel(weaponId, mods = []) {
  const p = VM_PARAMS[weaponId] || VM_PARAMS.pistol;
  const has = (id) => mods.indexOf(id) >= 0;
  const group = new THREE.Group();
  // 枪模改用 Lambert（无镜面高光）：防止细长的准星/枪管/制退器在专属光源下打出纯白过曝竖条。
  const bodyMat = lowPolyMat(PALETTE3D.vmBody, { map: getMetalTexture() });
  const darkMat = lowPolyMat(PALETTE3D.vmDark);

  const add = (dims, pos, mat) => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(u(dims[0]), u(dims[1]), u(dims[2])),
      mat,
    );
    mesh.position.set(u(pos[0]), u(pos[1]), u(pos[2]));
    group.add(mesh);
    return mesh;
  };

  const recvMesh = add(p.receiver, p.receiverAt, bodyMat);
  recvMesh.userData.role = 'body';
  // 弹匣 / 枪托：装了「替换型」附件就不再画基础件，否则会出现三个弹匣叠一起的怪形
  if (!has('drum') && !has('dualmag')) add(p.mag, p.magAt, darkMat).userData.role = 'body';
  if (!has('skeleton')) add(p.stock, p.stockAt, bodyMat).userData.role = 'body';
  add(p.grip, p.gripAt, darkMat).userData.role = 'body';
  add(p.sight, p.sightAt, darkMat).userData.role = 'body';

  // ---- 枪管：长度是配件外形的第一真值 ----
  // 解析逻辑在 vmparams.resolvedBarrel（3D 枪模与 2D 线稿共用同一份），这里只建几何。
  // 长/短/重型枪管改的是枪管实长，枪口位置必须跟着走：枪口焰、曳光弹起点、
  // 玩家枪口世界坐标全部读 muzzleZ，长度变了它不动 → 火焰会从枪管中段冒出来。
  // ⚠ role='base'：这些是"基础枪自带"的几何，换 GLB 外壳后和模型自带的枪管/导轨
  //   完全重复，留着就是两把枪叠在一起（实测高低错位）。装配配件（消音器/瞄具等）
  //   不打这个 role，换壳后仍要显示 —— 玩家花钱装的配件不能凭空消失。
  const bar = resolvedBarrel(p, has);
  const barrelLen = bar.len;
  const barrelW = bar.w;
  const barrelDelta = bar.delta; // 前端净前伸量（>0 为加长）
  const barrelFrontZ = bar.frontZ;
  add([barrelW, barrelW, barrelLen],
    [p.barrelAt[0], p.barrelAt[1], p.barrelAt[2] - barrelDelta / 2], darkMat).userData.role = 'base';
  if (has('heavybarrel')) {
    // 重型枪管：两圈散热环，与普通枪管一眼可分
    for (const dz of [0.09, 0.17]) {
      add([barrelW * 1.4, barrelW * 1.4, 0.02],
        [p.barrelAt[0], p.barrelAt[1], barrelFrontZ + dz], darkMat).userData.role = 'base';
    }
  }

  // 战术细节：顶部导轨（Picatinny）+ 前握把/枪口制退器（仅长枪），贴近现代突击步枪轮廓
  add([p.receiver[0] * 0.95, 0.035, p.receiver[2] * 0.72],
    [p.receiverAt[0], p.receiverAt[1] + p.receiver[1] / 2 + 0.018, p.receiverAt[2]], darkMat).userData.role = 'base';

  // ---- P6 改枪台：装了什么，枪上就要看得见 ----
  // muzzleZ 是"枪口最前端"的唯一真值 —— 枪口焰跟着它走，装消音器后整枪变长、闪光随之前移。
  const muzzleBaseZ = bar.muzzleZ; // 装置安装基座（配件几何挂这里）
  const muzzleZ = bar.tipZ; // 最前端：枪口焰 / 曳光弹起点用它
  const hasGripMod = has('vgrip') || has('agrip') || has('bipod');
  const hasMuzzleMod = has('suppressor') || has('compensator') || has('flash') || has('choke');
  if (weaponId !== 'pistol') {
    // 默认前握把（装了战术握把/脚架就换成下面那根，不重复叠两根）
    if (!hasGripMod) {
      add([0.05, 0.12, 0.05], [0, p.barrelAt[1] - 0.065, p.barrelAt[2] + p.barrel[2] * 0.32], darkMat).userData.role = 'base';
    }
    if (!hasMuzzleMod) {
      add([p.barrel[0] * 1.4, p.barrel[0] * 1.4, 0.09], [p.muzzleAt[0], p.muzzleAt[1], muzzleBaseZ], darkMat).userData.role = 'base';
    }
  }

  if (has('suppressor')) {
    // 消音器：细长圆柱，明显长过制退器 —— "装没装"第一眼就能看出来
    const len = 0.26;
    const can = new THREE.Mesh(
      new THREE.CylinderGeometry(u(barrelW * 0.95), u(barrelW * 0.95), u(len), 10),
      darkMat,
    );
    can.rotation.x = Math.PI / 2;
    can.position.set(u(p.muzzleAt[0]), u(p.muzzleAt[1]), u(muzzleBaseZ - len / 2 + 0.03));
    group.add(can);
  } else if (has('compensator')) {
    // 补偿器：一段略粗的方形气室
    add([barrelW * 1.55, barrelW * 1.55, 0.13],
      [p.muzzleAt[0], p.muzzleAt[1], muzzleBaseZ - 0.03], darkMat);
  } else if (has('flash')) {
    // 消焰器：短粗一圈
    add([barrelW * 1.5, barrelW * 1.5, 0.075],
      [p.muzzleAt[0], p.muzzleAt[1], muzzleBaseZ - 0.01], darkMat);
  } else if (has('choke')) {
    // 收束器：枪口一段收窄的锥形套筒 + 尾部卡箍环（霰弹枪专属，与制退器形状明显不同）
    const len = 0.12;
    const choke = new THREE.Mesh(
      new THREE.CylinderGeometry(u(barrelW * 0.62), u(barrelW * 0.50), u(len), 12),
      darkMat,
    );
    choke.rotation.x = Math.PI / 2;
    choke.position.set(u(p.muzzleAt[0]), u(p.muzzleAt[1]), u(muzzleBaseZ - len / 2 + 0.02));
    group.add(choke);
    add([barrelW * 1.32, barrelW * 1.32, 0.024],
      [p.muzzleAt[0], p.muzzleAt[1], muzzleBaseZ + 0.012], bodyMat);
  }

  if (has('acog')) {
    // 4x 光学镜：长镜筒 + 前后镜片 + 顶部调焦旋钮（体积最大，一眼看出是"大倍镜"）
    const bh = 0.075;
    const oy = p.sightAt[1] + bh / 2 + 0.010;
    const cz = p.sightAt[2] - 0.02;
    add([0.056, bh, 0.20], [0, oy, cz], darkMat);
    // 镜片用深蓝灰（不是高饱和蓝）：这块是场景里唯一的自发光面，太亮会像贴了两颗蓝球
    const lensMat = new THREE.MeshBasicMaterial({ color: 0x1b3a4d, transparent: true, opacity: 0.92 });
    for (const dz of [-0.104, 0.098]) {
      const lens = new THREE.Mesh(
        new THREE.CylinderGeometry(u(0.031), u(0.031), u(0.008), 12), lensMat,
      );
      lens.rotation.x = Math.PI / 2;
      lens.position.set(u(0), u(oy), u(cz + dz));
      group.add(lens);
    }
    add([0.026, 0.020, 0.026], [0, oy + bh / 2 + 0.010, cz], darkMat);
    add([0.040, 0.024, 0.030], [0, oy - bh / 2 - 0.010, cz - 0.055], darkMat); // 前支座
  } else if (has('scope2x')) {
    // 2x 镜：圆形镜筒 + 两道镜环，比 4x 短一截
    const bh = 0.056;
    const oy = p.sightAt[1] + bh / 2 + 0.008;
    const cz = p.sightAt[2] - 0.02;
    const tube = new THREE.Mesh(
      new THREE.CylinderGeometry(u(0.027), u(0.027), u(0.15), 12), darkMat,
    );
    tube.rotation.x = Math.PI / 2;
    tube.position.set(u(0), u(oy), u(cz));
    group.add(tube);
    for (const dz of [-0.075, 0.075]) {
      add([0.036, 0.036, 0.014], [0, oy, cz + dz], darkMat);
    }
    const front = new THREE.Mesh(
      new THREE.CylinderGeometry(u(0.024), u(0.024), u(0.006), 12),
      new THREE.MeshBasicMaterial({ color: 0x1b3a4d, transparent: true, opacity: 0.9 }),
    );
    front.rotation.x = Math.PI / 2;
    front.position.set(u(0), u(oy), u(cz - 0.080));
    group.add(front);
  } else if (has('reddot') || has('holo')) {
    // 光电瞄具：方形镜体 + 一颗自发光红点（开镜时视线正对它）
    const big = has('holo');
    const bw = big ? 0.052 : 0.042;
    const bh = big ? 0.062 : 0.048;
    const bd = big ? 0.075 : 0.085;
    const oy = p.sightAt[1] + bh / 2 + 0.006;
    add([bw, bh, bd], [0, oy, p.sightAt[2] - 0.01], darkMat);
    const dot = new THREE.Mesh(
      new THREE.BoxGeometry(u(0.014), u(0.014), u(0.004)),
      new THREE.MeshBasicMaterial({ color: 0xff3b30 }),
    );
    dot.position.set(u(0), u(oy), u(p.sightAt[2] - 0.052));
    group.add(dot);
  }

  if (has('drum')) {
    // 弹鼓：横置扁圆柱（侧视是圆盘）+ 上方一小段供弹塔，与长条弹匣一眼区分
    const r = Math.max(p.mag[1] * 0.50, 0.095);
    const drum = new THREE.Mesh(
      new THREE.CylinderGeometry(u(r), u(r), u(p.mag[0] * 1.5), 16), darkMat,
    );
    drum.rotation.z = Math.PI / 2; // 轴向 X：圆盘面朝侧面，玩家看得见是"鼓"
    drum.position.set(u(p.magAt[0]), u(p.magAt[1] - p.mag[1] * 0.05), u(p.magAt[2]));
    group.add(drum);
    add([p.mag[0] * 0.9, 0.06, p.mag[2] * 0.9],
      [p.magAt[0], p.magAt[1] + p.mag[1] * 0.42, p.magAt[2]], darkMat);
  } else if (has('dualmag')) {
    // 双联弹匣：两支并排弹匣 + 中间卡箍（基础弹匣已跳过，不会叠成三支）
    for (const dx of [-1, 1]) {
      add([p.mag[0] * 0.62, p.mag[1] * 1.02, p.mag[2] * 0.92],
        [p.magAt[0] + dx * p.mag[0] * 0.56, p.magAt[1], p.magAt[2]], darkMat);
    }
    add([p.mag[0] * 1.86, 0.024, p.mag[2] * 0.62],
      [p.magAt[0], p.magAt[1] - p.mag[1] * 0.16, p.magAt[2]], bodyMat);
  } else if (has('extmag')) {
    // 扩容弹匣：底部延伸段（容量数值在 cmd 层，这里给可读的外形差）
    add([p.mag[0] * 0.96, 0.10, p.mag[2] * 0.96],
      [p.magAt[0], p.magAt[1] - p.mag[1] / 2 - 0.05, p.magAt[2]], darkMat);
  } else if (has('fastmag')) {
    // 快拆弹匣：井口一圈亮色卡扣
    add([p.mag[0] * 1.14, 0.028, p.mag[2] * 1.14],
      [p.magAt[0], p.magAt[1] + p.mag[1] / 2 + 0.014, p.magAt[2]], bodyMat);
  }

  if (has('bipod')) {
    // 折叠脚架：护木下的铰接座 + 两根外撇撑杆，轮廓与任何握把都不同
    const bz = p.barrelAt[2] + p.barrel[2] * 0.20;
    const by = p.barrelAt[1] - 0.050;
    add([0.052, 0.026, 0.05], [0, by, bz], darkMat);
    for (const sx of [-1, 1]) {
      const leg = add([0.016, 0.17, 0.016], [sx * 0.055, by - 0.078, bz + 0.012], darkMat);
      leg.rotation.z = sx * 0.30; // 外撇
      leg.rotation.x = 0.12; // 略前倾
    }
  } else if (has('vgrip')) {
    add([0.048, 0.13, 0.05], [0, p.barrelAt[1] - 0.10, p.barrelAt[2] + p.barrel[2] * 0.34], darkMat);
  } else if (has('agrip')) {
    const ag = add([0.046, 0.115, 0.05],
      [0, p.barrelAt[1] - 0.095, p.barrelAt[2] + p.barrel[2] * 0.26], darkMat);
    ag.rotation.x = -0.38; // 斜握把：前倾，与垂直握把一眼可分
  }

  if (has('skeleton')) {
    // 骨架枪托：上下两根细杆 + 尾部托板 + 前接件，中间镂空（基础实心托已跳过，不叠影）
    const sz = p.stockAt[2];
    const sl = p.stock[2];
    add([p.stock[0] * 0.52, 0.022, sl], [0, p.stockAt[1] + p.stock[1] * 0.38, sz], darkMat);
    add([p.stock[0] * 0.42, 0.020, sl * 0.84],
      [0, p.stockAt[1] - p.stock[1] * 0.40, sz - sl * 0.02], darkMat);
    add([p.stock[0] * 0.94, p.stock[1] * 0.92, 0.028],
      [0, p.stockAt[1], sz + sl / 2 - 0.014], bodyMat);
    add([p.stock[0] * 0.72, p.stock[1] * 0.78, 0.026],
      [0, p.stockAt[1], sz - sl / 2 + 0.013], darkMat);
  } else if (has('tacticalstock')) {
    // 战术枪托：贴腮板
    add([p.stock[0] * 1.02, 0.032, p.stock[2] * 0.8],
      [0, p.stockAt[1] + p.stock[1] / 2 + 0.014, p.stockAt[2]], bodyMat);
  } else if (has('heavystock')) {
    // 重型枪托：尾部配重块
    add([p.stock[0] * 1.25, p.stock[1] * 0.9, 0.10],
      [0, p.stockAt[1], p.stockAt[2] + p.stock[2] / 2 + 0.045], bodyMat);
  }

  // 双手（第一人称代入感：右手握把、左手托护目前方）
  // `role='hands'`：换成 GLB 枪模时要把这两块一并隐藏 —— 外部枪模没有配套手臂，
  // 程序化的手会悬在枪托旁边，看起来像浮在半空的一块肉色方块（实测就是这么翻车的）。
  const handMat = lowPolyMat(PALETTE3D.hand);
  const handR = new THREE.Mesh(new THREE.BoxGeometry(u(0.12), u(0.12), u(0.22)), handMat);
  handR.position.set(u(0.04), u(-0.15), u(-0.12));
  handR.userData.role = 'hands';
  group.add(handR);
  const handL = new THREE.Mesh(new THREE.BoxGeometry(u(0.11), u(0.11), u(0.20)), handMat);
  if (weaponId === 'pistol') {
    // 手枪双手都握在把手上：沿用长枪的"托护木"位置会让左手飘到枪口前方（存量穿模）
    handL.position.set(u(-0.040), u(-0.150), u(0.052));
  } else {
    handL.position.set(u(0.10), u(-0.12), u(-0.42));
  }
  handL.userData.role = 'hands';
  group.add(handL);

  const flash = new THREE.Mesh(
    new THREE.IcosahedronGeometry(u(VIEW3D.fx.muzzleFlashScale) * 0.42, 0),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(VIEW3D.fx.muzzleFlashColor),
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  flash.position.set(u(p.muzzleAt[0]), u(p.muzzleAt[1]), u(muzzleZ));
  flash.visible = false;
  group.add(flash);

  // 视图模型就在相机跟前，投影只会糊住画面；同时关闭视锥裁剪避免出现/消失抖动。
  // 归入 layer 1：世界灯（layer 0）不再直接照亮枪模，避免玩家靠近室内点光时枪面被过曝成白色；
  // renderer3d 会在相机上启用 layer 1 并挂专属光源，保证枪模在任何灯位下都均匀受光。
  group.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = false;
      o.receiveShadow = false;
      o.frustumCulled = false;
      o.renderOrder = 10;
      o.layers.set(1);
    }
  });

  group.userData = { flash, muzzle: flash.position.clone(), mats: [bodyMat, darkMat] };
  return group;
}

/** 视图模型参数表（供 renderer3d 做开火/换弹表现时读取） */
export { VM_PARAMS };

/**
 * 武器 id → GLB 外壳。缺哪个就保持纯程序化，不会出现"半把枪"。
 * `lmg` 没有对应模型，映射到外观最接近的 AK 型（弹匣/护木形态同族），
 * 比"随机套一把冲锋枪"更不容易出戏。
 */
/**
 * 枪模的亮度衰减。枪离相机最近、且有一盏贴着相机的枪口灯，按 0.78 压一点就够，
 * 压太狠会让枪在阴影里变成黑块（第一人称武器辨识度是玩法资产）。
 */
const VM_GLB_GAIN = 0.78;

/**
 * 武器 id → GLB 枪身路径。
 * W1 起局外改枪台的 3D 预览也读这张表 —— 局内外共用同一份"这把枪长什么样"的真值，
 * 避免出现"改枪台看着是 M4、进局内变成另一把"的错位。
 */
export const VM_GLB = {
  rifle: 'models/poly-pizza/weapon-rifle-assault.glb',
  carbine: 'models/poly-pizza/weapon-carbine-assault-b.glb',
  smg: 'models/poly-pizza/weapon-smg.glb',
  pdw: 'models/poly-pizza/weapon-pdw-bullpup.glb',
  pistol: 'models/poly-pizza/weapon-pistol.glb',
  shotgun: 'models/poly-pizza/weapon-shotgun.glb',
  dmr: 'models/poly-pizza/weapon-dmr-sniper.glb',
  battle: 'models/poly-pizza/weapon-battle-ak47.glb',
  lmg: 'models/poly-pizza/weapon-battle-ak47.glb',
};

/**
 * 给第一人称枪模套一层 GLB 外壳（异步、可失败、只换枪身）。
 *
 * 为什么不整枪替换：P14 的契约是「vmparams 是枪模尺寸唯一真值」——
 * `resolvedBarrel().tipZ` 同时驱动枪口焰位置、曳光弹起点、玩家枪口世界坐标。
 * 整枪换成外部模型，这三个点会集体失准（火焰从枪管中段冒出来）。
 * 只换枪身的话，枪管仍然按 vmparams 长出来、配件照旧挂在它上面，
 * 「装了什么看得见」这条玩法反馈不会丢；外部模型只负责把方块枪身换成有轮廓的枪。
 *
 * @param {THREE.Group} group buildViewmodel 的产物
 * @param {string} weaponId 武器 id
 * @returns {void}
 */
export function upgradeViewmodel(group, weaponId) {
  const rel = VM_GLB[weaponId];
  if (!rel || !group || group.userData.glbShell) return;
  loadGLB(rel).then((gltf) => {
    if (!gltf || group.userData.glbShell) return;
    const body = [];
    const toHide = [];
    group.traverse((o) => {
      if (!o.isMesh) return;
      const role = o.userData.role;
      if (role === 'body') body.push(o);
      // body（枪身 5 块）+ base（基础枪管/导轨/前握把/制退器）都要隐藏：
      // GLB 是完整的枪，自带这些东西；留着程序化版本就是两把枪错位叠在一起。
      // ⚠ target 包围盒只能用 body 算：base 里的枪管会把 Z 拉长，按它缩放 GLB 会缩成一条缝。
      if (role === 'body' || role === 'base') toHide.push(o);
    });
    if (!body.length) return;

    // 目标区域 = 现有枪身块的包围盒（receiver / mag / stock / grip / sight）
    // 注意：必须用**组内局部坐标**，不能用 expandByObject —— 那个算的是世界包围盒，
    // 而枪模挂在相机下，相机的 yaw 会把"枪的长轴"从局部 Z 转到世界 X，
    // 于是缩放会按枪的厚度去算，结果整把枪缩成一小块。实测踩过这个坑。
    const target = new THREE.Box3();
    const one = new THREE.Box3();
    for (const m of body) {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      m.updateMatrix();
      one.copy(m.geometry.boundingBox).applyMatrix4(m.matrix);
      target.union(one);
    }
    const tSize = target.getSize(new THREE.Vector3());
    const tCenter = target.getCenter(new THREE.Vector3());

    // ⚠ 必须 clone：loadGLB 缓存的是同一个 gltf.scene 实例，下面是一个会改
    // rotation/scale/position 的原地换壳。不 clone 的话，同一把枪换两次配件
    // （或 lmg/battle 共用 ak47.glb）变换会累加，外壳越放越大、越偏越远 ——
    // 表现就是\"接缝错位\"甚至整把枪飞出画面。角色模型用的是 SkeletonUtils.clone，
    // 枪模没有骨骼，普通 deep clone 足够。
    const root = gltf.scene.clone(true);
    // 与场景统一：GLTF 的 Standard 材质换 Lambert（见 glbLambert 注释）。
    // 这里**必须保留贴图**：Poly Pizza 的枪靠 albedo 贴图分件（机匣/护木/枪托不同色），
    // 只留固有色会把整把枪渲染成一块纯色，枪的层次全丢 —— 上一版就是这么翻车的。
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = false;
      o.receiveShadow = false;
      const srcMat = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!srcMat) return;
      o.material = glbLambert(srcMat, { gain: VM_GLB_GAIN });
    });

    // 主轴修正：Kenney / Poly Pizza 的枪都是 X 轴为长轴，要转到相机前向轴 Z。
    // ⚠ 方向必须是 +90°（不是 -90°）：程序化枪口朝 -Z（相机前向，见 vmparams.js），
    //   转 -90° 会把 GLB 的枪口送到 +Z（朝玩家屏幕右下），看起来就是整把枪反着拿。
    //   实测 9 把枪全中，翻 180° 后枪口才与程序化枪管同向（.screenshots/vmcheck-grid*.png）。
    let bb = new THREE.Box3().setFromObject(root);
    let size = bb.getSize(new THREE.Vector3());
    if (size.x > size.z) {
      root.rotation.y = Math.PI / 2;
      root.updateMatrixWorld(true);
      bb = new THREE.Box3().setFromObject(root);
      size = bb.getSize(new THREE.Vector3());
    }
    // 按「枪身长度」等比缩放，而不是按最长轴：枪身区域的 Z 向长度才是可比量
    const s = (tSize.z || 1) / (size.z || 1);
    root.scale.multiplyScalar(s);
    root.updateMatrixWorld(true);

    // 对齐到枪身区域中心（上下左右前后都用包围盒中心，不手调魔数）
    bb = new THREE.Box3().setFromObject(root);
    const c = bb.getCenter(new THREE.Vector3());
    root.position.add(new THREE.Vector3(tCenter.x - c.x, tCenter.y - c.y, tCenter.z - c.z));

    group.add(root);
    // 枪身的 body + base 块隐藏而非删除：模型加载失败时它们还在（upgradeViewmodel 会提前 return，
    // 一个都不会隐藏），切枪/换配件重建也会重新显示。装配配件（瞄具/消音器/弹鼓等，无 role）
    // 保持可见 —— 玩家花钱装的配件不能因为套了外壳就消失。
    for (const m of toHide) m.visible = false;
    // 手也一起下线：外部枪模没有配套手臂，留着就是一只悬空的手（见 buildViewmodel 注释）
    group.traverse((o) => { if (o.userData.role === 'hands') o.visible = false; });
    group.userData.glbShell = root;
  });
}

/**
 * 武器 id → 展示名（HUD 用）。
 * @param {string} weaponId 武器 id
 * @returns {string} 名称
 */
export function weaponLabel(weaponId) {
  return WEAPONS[weaponId] ? WEAPONS[weaponId].name : '徒手';
}

/* ============================ 世界掉落物品 ============================ */

/**
 * 构建一个"掉落/战利品"实体模型（独立小 Group，放在容器顶部或地面上）。
 * 按物品 id 选择造型与贴图：武器=枪形、医疗=白底红十字、弹药=弹盒、护甲=装甲板、其余=小木箱。
 * 若传入 rarity（非 common），则按稀有度给模型叠加同色自发光辉光 + 悬浮稀有度宝珠，
 * 让高价值战利品在地图远处也能一眼辨识（与 UI 物资分级配色保持一致）。
 * @param {string} itemId 物品定义 id
 * @param {string} [rarity='common'] 稀有度（common/rare/epic/legendary）
 * @returns {THREE.Group} 物品模型（userData.spin 标记是否需要自转）
 */
export function buildItemModel(itemId, rarity = 'common') {
  const g = new THREE.Group();
  const T = THREE;

  // 稀有度辉光配置：普通不发光；稀有/史诗/传说逐级增强。
  const tier = (RARITY[rarity] && rarity !== 'common') ? RARITY[rarity] : null;
  const tint = tier ? tier.color : null;
  const glowStrong = rarity === 'legendary' || rarity === 'epic';
  const emissiveBody = tier ? (glowStrong ? 0.5 : 0.28) : 0;

  // 带稀有度辉光的材质构造器：普通时直接用原色，稀有以上叠加同色自发光。
  const rareMat = (baseColor, opts = {}) => {
    if (!tint) return lowPolyMat(baseColor, opts);
    return lowPolyMat(baseColor, Object.assign({}, opts, {
      emissive: tint,
      emissiveIntensity: emissiveBody,
    }));
  };

  const box = (w, h, d, mat, x = 0, y = 0, z = 0) => {
    const m = new T.Mesh(new T.BoxGeometry(u(w), u(h), u(d)), mat);
    m.position.set(u(x), u(y), u(z));
    m.castShadow = true;
    g.add(m);
    return m;
  };

  if (WEAPONS[itemId]) {
    // 武器：枪身 + 弹匣，缓慢自转以便辨识
    box(0.5, 0.14, 1.5, rareMat(PALETTE3D.vmBody, { phong: true, map: getMetalTexture() }), 0, 0.12, 0);
    box(0.12, 0.22, 0.34, rareMat(PALETTE3D.vmDark), 0, -0.12, -0.42);
    g.userData.spin = true;
  } else if (itemId === 'medkit' || itemId === 'bandage') {
    box(0.52, 0.36, 0.42, rareMat(PALETTE3D.medkit, { map: getMedkitTexture() }));
  } else if (itemId === 'ammo556' || itemId === 'ammo9mm') {
    box(0.52, 0.36, 0.42, rareMat(PALETTE3D.ammoBox, { map: getAmmoTexture() }));
  } else if (ARMORS[itemId]) {
    box(0.54, 0.54, 0.2, rareMat(PALETTE3D.armorPlate, { map: getArmorTexture() }));
  } else {
    box(0.5, 0.38, 0.42, rareMat(PALETTE3D.crate, { map: getWoodTexture() }));
  }

  // 稀有度标识：悬浮发光宝珠（远处可辨），传说级再叠一圈底座光环。
  if (tint) {
    const orbMat = lowPolyMat(tint, { emissive: tint, emissiveIntensity: glowStrong ? 0.95 : 0.6 });
    const orb = new T.Mesh(new T.SphereGeometry(u(0.12), 12, 12), orbMat);
    orb.position.set(0, u(0.62), 0);
    g.add(orb);
    g.userData.spin = true; // 宝珠随组自转，进入视野更醒目
    g.userData.rarityOrb = orb;
    if (rarity === 'legendary') {
      // 传说级：地面光环 + 更亮宝珠，强化"必抢"观感。
      const ringMat = lowPolyMat(tint, {
        emissive: tint, emissiveIntensity: 0.8, transparent: true, opacity: 0.7,
      });
      const ring = new T.Mesh(new T.TorusGeometry(u(0.42), u(0.04), 8, 24), ringMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = u(0.04);
      g.add(ring);
      g.userData.rarityRing = ring;
    }
  }

  g.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return g;
}
