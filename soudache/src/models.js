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
import { VIEW3D, PALETTE3D, WEAPONS, ARMORS, RARITY } from './config.js';

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
  if (opts.transparent) {
    params.transparent = true;
    params.opacity = opts.opacity != null ? opts.opacity : 1;
  }
  if (opts.map) params.map = opts.map;

  if (opts.standard) {
    params.roughness = opts.roughness != null ? opts.roughness : 0.85;
    params.metalness = opts.metalness != null ? opts.metalness : 0.0;
    params.envMapIntensity = opts.envIntensity != null ? opts.envIntensity : VIEW3D.envIntensity;
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
export function surfaceMat(color, map, roughness = VIEW3D.wallRoughness) {
  return lowPolyMat(color, {
    standard: true,
    map: map || undefined,
    roughness,
    metalness: VIEW3D.metalness,
    flat: false, // 大平面不需要 flatShading，否则会露出三角形硬边
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
  for (const g of geos) {
    const ng = g.index ? g.toNonIndexed() : g;
    list.push(ng);
    total += ng.attributes.position.count;
    if (!ng.attributes.color) withColor = false;
  }
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const color = withColor ? new Float32Array(total * 3) : null;
  let offset = 0;
  for (const g of list) {
    position.set(g.attributes.position.array, offset * 3);
    normal.set(g.attributes.normal.array, offset * 3);
    if (color) color.set(g.attributes.color.array, offset * 3);
    offset += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  if (color) out.setAttribute('color', new THREE.BufferAttribute(color, 3));
  out.computeBoundingSphere();
  return out;
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
  ctx.fillStyle = '#aeb6c0'; ctx.fillRect(0, 0, s, s);
  speckle(ctx, s, [150, 160, 175], 0.5, 260);
  ctx.strokeStyle = 'rgba(40,48,60,0.35)'; ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, s, s);
  ctx.beginPath(); ctx.moveTo(s / 2, 0); ctx.lineTo(s / 2, s); ctx.moveTo(0, s / 2); ctx.lineTo(s, s / 2); ctx.stroke();
};
const CONCRETE_TEX = (ctx, s) => {
  ctx.fillStyle = '#7c8794'; ctx.fillRect(0, 0, s, s);
  speckle(ctx, s, [110, 122, 138], 0.7, 320);
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

export function getFloorTexture() { return getTex('floor', FLOOR_TEX, 128); }
export function getConcreteTexture() { return getTex('concrete', CONCRETE_TEX, 128); }
export function getWoodTexture() { return getTex('wood', WOOD_TEX, 128); }
export function getMetalTexture() { return getTex('metal', METAL_TEX, 128); }
export function getMedkitTexture() { return getTex('medkit', MEDKIT_TEX, 64); }
export function getAmmoTexture() { return getTex('ammo', AMMO_TEX, 64); }
export function getArmorTexture() { return getTex('armor', ARMOR_TEX, 64); }

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
  const cA = new THREE.Color(PALETTE3D.ground);
  const cB = new THREE.Color(PALETTE3D.groundAlt);
  for (let ty = 0; ty < rows; ty += 1) {
    for (let tx = 0; tx < cols; tx += 1) {
      const x0 = tx * tile;
      const z0 = ty * tile;
      const x1 = x0 + tile;
      const z1 = z0 + tile;
      // 平面躺平：顶点顺序保证法线朝 +Y
      quads.push(x0, 0, z0, x0, 0, z1, x1, 0, z1);
      quads.push(x0, 0, z0, x1, 0, z1, x1, 0, z0);
      const c = (tx + ty) % 2 === 0 ? cA : cB;
      for (let k = 0; k < 6; k += 1) colors.push(c.r, c.g, c.b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(quads), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
  geo.computeVertexNormals();
  // 地面是画面里面积最大的表面，升级为 Standard 后能吃到环境光与高光，
  // 观感提升最明显；保留顶点色棋盘格与地面贴图。
  const mesh = new THREE.Mesh(geo, surfaceMat('#FFFFFF', getFloorTexture(), VIEW3D.groundRoughness));
  mesh.material.vertexColors = true;
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
 * @returns {THREE.Group} 载具模型（userData 暴露 wheels 便于做转动）
 */
export function buildVehicleModel() {
  const group = new THREE.Group();
  const bodyMat = lowPolyMat(PALETTE3D.vehicleBody || PALETTE3D.metal);
  const darkMat = lowPolyMat(PALETTE3D.vehicleDark || '#2A2E33');
  const glassMat = lowPolyMat(PALETTE3D.vehicleGlass || '#7FA8C4');
  const wheelMat = lowPolyMat('#15171A');

  const L = 4.3; // 车长（米）
  const W = 1.95; // 车宽
  const wheelR = 0.42;

  // 底盘
  const chassis = new THREE.Mesh(new THREE.BoxGeometry(u(L), u(0.55), u(W)), darkMat);
  chassis.position.y = u(wheelR + 0.12);
  group.add(chassis);

  // 车身主体（略窄、叠在底盘上）
  const body = new THREE.Mesh(new THREE.BoxGeometry(u(L * 0.92), u(0.62), u(W * 0.96)), bodyMat);
  body.position.y = u(wheelR + 0.55);
  group.add(body);

  // 驾驶舱（偏车头一侧）
  const cabLen = L * 0.42;
  const cab = new THREE.Mesh(new THREE.BoxGeometry(u(cabLen), u(0.62), u(W * 0.86)), bodyMat);
  cab.position.set(u(L * 0.16), u(wheelR + 1.15), 0);
  group.add(cab);

  // 挡风玻璃（贴在驾驶舱前脸）
  const glass = new THREE.Mesh(new THREE.BoxGeometry(u(0.08), u(0.44), u(W * 0.74)), glassMat);
  glass.position.set(u(L * 0.16 + cabLen / 2 + 0.02), u(wheelR + 1.15), 0);
  group.add(glass);

  // 货斗围栏（车尾）
  for (const dz of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(u(L * 0.30), u(0.30), u(0.10)), bodyMat);
    rail.position.set(-u(L * 0.24), u(wheelR + 0.95), dz * u(W * 0.46));
    group.add(rail);
  }
  const tail = new THREE.Mesh(new THREE.BoxGeometry(u(0.10), u(0.30), u(W * 0.92)), bodyMat);
  tail.position.set(-u(L * 0.38), u(wheelR + 0.95), 0);
  group.add(tail);

  // 4 个轮子（横向圆柱，绕 Z 轴转 90° 使圆面朝 ±Z）
  const wheels = [];
  const wheelGeo = new THREE.CylinderGeometry(u(wheelR), u(wheelR), u(0.26), 10);
  wheelGeo.rotateX(Math.PI / 2);
  for (const dx of [1, -1]) {
    for (const dz of [1, -1]) {
      const w = new THREE.Mesh(wheelGeo, wheelMat);
      w.position.set(dx * u(L * 0.30), u(wheelR), dz * u(W * 0.50));
      group.add(w);
      wheels.push(w);
    }
  }

  // 车灯（车头两盏，自发光便于远处识别）
  const lampMat = lowPolyMat('#F2E2B0', { emissive: '#F2E2B0' });
  for (const dz of [-1, 1]) {
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(u(0.08), u(0.18), u(0.22)), lampMat);
    lamp.position.set(u(L * 0.47), u(wheelR + 0.62), dz * u(W * 0.30));
    group.add(lamp);
  }

  group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  group.userData = { wheels, mats: [bodyMat, darkMat, glassMat, wheelMat, lampMat] };
  return group;
}

/* ============================ 敌人 ============================ */

/**
 * 构建一个敌人模型（独立 Group，便于各自转向与受击闪红）。
 * @param {string} typeId 敌人类型（patrol / elite / marksman / rusher）
 * @returns {THREE.Group} 敌人模型
 */
export function buildEnemyModel(typeId) {
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
  const tint = tints[typeId] || PALETTE3D.enemyPatrol;
  const group = new THREE.Group();

  const bodyMat = lowPolyMat(tint); // 军服
  const darkMat = lowPolyMat(PALETTE3D.vmDark); // 背心 / 靴 / 手套 / 耳机
  const gunMat = lowPolyMat(PALETTE3D.vmBody); // 武器
  const skinMat = lowPolyMat(PALETTE3D.hand); // 面部与手（皮肤色）
  const helmetMat = lowPolyMat(PALETTE3D.helmet);
  const packMat = lowPolyMat(PALETTE3D.backpack);
  const eyeMat = lowPolyMat('#12161A'); // 眼部暗色，做出"有脸"
  // mats 用于受击闪红，因此要覆盖所有可见材质
  const mats = [bodyMat, darkMat, gunMat, skinMat, helmetMat, packMat];

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

  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.BoxGeometry(headW * 0.24, u(0.045), u(0.02)), eyeMat);
    eye.position.set(side * headW * 0.24, headH2 * 0.10, faceZ - u(0.012));
    head.add(eye);
    // 眉骨压在眼睛上方，让眼神更有压迫感
    const brow = new THREE.Mesh(new THREE.BoxGeometry(headW * 0.30, u(0.028), u(0.02)), darkMat);
    brow.position.set(side * headW * 0.24, headH2 * 0.19, faceZ - u(0.012));
    head.add(brow);
  }

  const nose = new THREE.Mesh(new THREE.BoxGeometry(u(0.05), u(0.06), u(0.05)), skinMat);
  nose.position.set(0, -headH2 * 0.04, faceZ - u(0.03));
  head.add(nose);

  // 通讯耳罩
  for (const side of [-1, 1]) {
    const cup = new THREE.Mesh(new THREE.BoxGeometry(u(0.05), u(0.11), u(0.09)), darkMat);
    cup.position.set(side * (headW * 0.5 + u(0.015)), headH2 * 0.04, 0);
    head.add(cup);
  }

  // 头盔：盔体 + 帽檐
  const helmet = new THREE.Mesh(new THREE.IcosahedronGeometry(headR * 1.16, 1), helmetMat);
  helmet.position.y = headR * 0.20;
  helmet.scale.set(1, 0.82, 1.04);
  head.add(helmet);
  const brim = new THREE.Mesh(new THREE.BoxGeometry(headW * 1.10, u(0.05), u(0.14)), helmetMat);
  brim.position.set(0, headR * 0.34, faceZ - u(0.02));
  head.add(brim);

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

  group.userData = {
    mats,
    flash,
    gun,
    head,
    baseTint: new THREE.Color(tint),
    // 动画用的可动部件（渲染层按 walkPhase / wantsMove 驱动）
    parts: { torso, head, legs, arms, torsoBaseY: legH },
  };
  return group;
}

/* ============================ 武器视图模型 ============================ */

/** 三种武器的拼装参数（单位：米，挂在相机局部坐标系，建模时 × metersToUnits） */
const VM_PARAMS = {
  rifle: {
    receiver: [0.085, 0.115, 0.62], receiverAt: [0, 0, -0.14],
    barrel: [0.042, 0.042, 0.42], barrelAt: [0, 0.012, -0.60],
    mag: [0.062, 0.20, 0.11], magAt: [0, -0.14, -0.02],
    stock: [0.070, 0.10, 0.28], stockAt: [0, -0.012, 0.26],
    grip: [0.060, 0.15, 0.075], gripAt: [0, -0.13, 0.12],
    sight: [0.030, 0.055, 0.13], sightAt: [0, 0.085, -0.16],
    muzzleAt: [0, 0.012, -0.84],
  },
  smg: {
    receiver: [0.082, 0.105, 0.44], receiverAt: [0, 0, -0.08],
    barrel: [0.038, 0.038, 0.26], barrelAt: [0, 0.008, -0.40],
    mag: [0.056, 0.24, 0.10], magAt: [0, -0.16, -0.04],
    stock: [0.055, 0.075, 0.20], stockAt: [0, -0.01, 0.22],
    grip: [0.056, 0.14, 0.072], gripAt: [0, -0.12, 0.10],
    sight: [0.026, 0.045, 0.10], sightAt: [0, 0.075, -0.10],
    muzzleAt: [0, 0.008, -0.56],
  },
  pistol: {
    receiver: [0.062, 0.10, 0.30], receiverAt: [0, 0, -0.04],
    barrel: [0.034, 0.034, 0.14], barrelAt: [0, 0.006, -0.24],
    mag: [0.048, 0.16, 0.085], magAt: [0, -0.14, 0.02],
    stock: [0.040, 0.055, 0.06], stockAt: [0, -0.03, 0.17],
    grip: [0.054, 0.17, 0.075], gripAt: [0, -0.13, 0.11],
    sight: [0.020, 0.030, 0.05], sightAt: [0, 0.062, -0.12],
    muzzleAt: [0, 0.006, -0.32],
  },
};

/**
 * 构建武器视图模型（挂在相机下，故不投影、不参与世界光照阴影）。
 * @param {string} weaponId 武器 id（rifle / smg / pistol）
 * @returns {THREE.Group} 视图模型
 */
export function buildViewmodel(weaponId) {
  const p = VM_PARAMS[weaponId] || VM_PARAMS.pistol;
  const group = new THREE.Group();
  const bodyMat = lowPolyMat(PALETTE3D.vmBody, { phong: true, shininess: 30, map: getMetalTexture() });
  const darkMat = lowPolyMat(PALETTE3D.vmDark, { phong: true, shininess: 18 });

  const add = (dims, pos, mat) => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(u(dims[0]), u(dims[1]), u(dims[2])),
      mat,
    );
    mesh.position.set(u(pos[0]), u(pos[1]), u(pos[2]));
    group.add(mesh);
    return mesh;
  };

  add(p.receiver, p.receiverAt, bodyMat);
  add(p.barrel, p.barrelAt, darkMat);
  add(p.mag, p.magAt, darkMat);
  add(p.stock, p.stockAt, bodyMat);
  add(p.grip, p.gripAt, darkMat);
  add(p.sight, p.sightAt, darkMat);

  // 战术细节：顶部导轨（Picatinny）+ 前握把/枪口制退器（仅长枪），贴近现代突击步枪轮廓
  add([p.receiver[0] * 0.95, 0.035, p.receiver[2] * 0.72],
    [p.receiverAt[0], p.receiverAt[1] + p.receiver[1] / 2 + 0.018, p.receiverAt[2]], darkMat);
  if (weaponId !== 'pistol') {
    add([0.05, 0.12, 0.05], [0, p.barrelAt[1] - 0.065, p.barrelAt[2] + p.barrel[2] * 0.32], darkMat);
    add([p.barrel[0] * 1.4, p.barrel[0] * 1.4, 0.09], [p.muzzleAt[0], p.muzzleAt[1], p.muzzleAt[2]], darkMat);
  }

  // 双手（第一人称代入感：右手握把、左手托护目前方）
  const handMat = lowPolyMat(PALETTE3D.hand);
  const handR = new THREE.Mesh(new THREE.BoxGeometry(u(0.12), u(0.12), u(0.22)), handMat);
  handR.position.set(u(0.04), u(-0.15), u(-0.12));
  group.add(handR);
  const handL = new THREE.Mesh(new THREE.BoxGeometry(u(0.11), u(0.11), u(0.20)), handMat);
  handL.position.set(u(0.10), u(-0.12), u(-0.42));
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
  flash.position.set(u(p.muzzleAt[0]), u(p.muzzleAt[1]), u(p.muzzleAt[2]));
  flash.visible = false;
  group.add(flash);

  // 视图模型就在相机跟前，投影只会糊住画面；同时关闭视锥裁剪避免出现/消失抖动
  group.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = false;
      o.receiveShadow = false;
      o.frustumCulled = false;
      o.renderOrder = 10;
    }
  });

  group.userData = { flash, muzzle: flash.position.clone(), mats: [bodyMat, darkMat] };
  return group;
}

/** 视图模型参数表（供 renderer3d 做开火/换弹表现时读取） */
export { VM_PARAMS };

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
