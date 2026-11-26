/**
 * P23：外部 3D 资源管线（GLB）。
 *
 * 设计约束（都是硬约束，改之前先读这里）：
 * 1) 无构建、无 importmap：three 只能从 `../vendor/three.module.js` 引，
 *    GLTFLoader 也因此被改写成本地相对路径（见 vendor/GLTFLoader.js 头部说明）。
 * 2) **加载失败绝不能影响可玩性**：本模块的 loadGLB 永不 reject，失败只记在 status 里，
 *    调用方必须保留程序化模型作为兜底。线上少一张模型不可怕，白屏才可怕。
 * 3) deploy 是白名单副本，`assets/` 与 `vendor/` 已加入 tools/sync-deploy.mjs，
 *    资源文件与 JS 一样要过 md5 parity，避免"本地有、线上 404"。
 * 4) Kenney 模型使用外部调色板贴图 `Textures/colormap.png`，四套 kit 的调色板内容不同，
 *    因此目录结构必须保持 `<kit>/<model>.glb` + `<kit>/Textures/colormap.png` 的原始相对关系。
 */
import * as THREE from '../vendor/three.module.js';
import { GLTFLoader } from '../vendor/GLTFLoader.js';
import { VIEW3D } from './config.js';

/** 资源根目录（相对本模块，src/ 的上一级）。用 URL 而不是字符串拼接，避免部署路径差异。 */
const ASSET_ROOT = new URL('../assets/', import.meta.url);

/** 已加载 / 失败计数，供调试口与探针读（只读快照）。 */
const state = {
  requested: 0,
  loaded: 0,
  failed: 0,
  /** @type {string[]} 失败的相对路径（最多保留 16 条，避免无限增长） */
  errors: [],
  /** @type {string[]} 成功加载的相对路径 */
  ok: [],
};

/** @type {Map<string, Promise<object|null>>} 同一条路径只请求一次 */
const cache = new Map();

let loader = null;

/**
 * 资源相对路径 → 可直接 fetch 的绝对 URL。
 * @param {string} rel 例如 `models/kenney-survival-kit/chest.glb`
 * @returns {string} 绝对 URL
 */
export function assetUrl(rel) {
  const clean = String(rel || '').replace(/^\/+/, '');
  return new URL(clean, ASSET_ROOT).href;
}

/**
 * 资源管线状态快照（只读）。探针用它证明"GLB 真的加载了"，而不是靠肉眼看截图。
 * @returns {{requested:number, loaded:number, failed:number, errors:string[], ok:string[]}}
 */
export function assetStatus() {
  return {
    requested: state.requested,
    loaded: state.loaded,
    failed: state.failed,
    errors: state.errors.slice(),
    ok: state.ok.slice(),
  };
}

/** 重置状态与缓存（只给测试/调试用，运行时不需要） */
export function resetAssetCache() {
  cache.clear();
  state.requested = 0;
  state.loaded = 0;
  state.failed = 0;
  state.errors.length = 0;
  state.ok.length = 0;
}

/**
 * 加载一个 GLB。**永不 reject**：失败返回 null 并记入 status。
 * @param {string} rel 相对 assets/ 的路径
 * @returns {Promise<object|null>} gltf（含 scene / animations），失败为 null
 */
export function loadGLB(rel) {
  const key = String(rel || '');
  if (!key) return Promise.resolve(null);
  if (cache.has(key)) return cache.get(key);
  // Node（单测 / 冒烟）没有 DOM，直接判定不可用，避免把 three 的加载器打崩。
  if (typeof document === 'undefined' || typeof window === 'undefined') return Promise.resolve(null);

  if (!loader) loader = new GLTFLoader();
  state.requested += 1;

  const p = new Promise((resolve) => {
    loader.load(
      assetUrl(key),
      (gltf) => {
        state.loaded += 1;
        state.ok.push(key);
        resolve(gltf);
      },
      undefined,
      (err) => {
        state.failed += 1;
        if (state.errors.length < 16) state.errors.push(`${key}: ${err && err.message ? err.message : 'load error'}`);
        resolve(null);
      },
    );
  });
  cache.set(key, p);
  return p;
}

/**
 * P24：外部 GLB 的统一材质换算 —— 容器 / 角色 / 枪模三条线共用这一个出口。
 *
 * 为什么需要它：本作整套场景是 Lambert 低多边形（`lowPolyMat`），而 GLTF 自带的是
 * `MeshStandardMaterial`。同一套灯光（ACES 色调映射 + 曝光 1.7 + 半球天光）下 PBR 的
 * 漫反射明显更亮，**浅色 albedo 会直接饱和过曝**：木箱被冲成一块白板、士兵的军绿变成
 * 薄荷绿。实测同一机位把容器材质换成 `MeshBasicMaterial({ map })` 时颜色正常，证明
 * 贴图与 UV 都没问题，问题只在"亮多少"。
 *
 * 所以统一处理：换成 Lambert、保留 albedo 贴图、再乘一个 `gain` 把被照亮的观感拉回
 * 本作程序化道具那一档。不乘的话每种模型都得单独调曝光，永远调不完。
 *
 * @param {THREE.Material|null} srcMat GLTF 上的原材质
 * @param {{color?:number|string, gain?:number, emissive?:number|string, emissiveIntensity?:number, keepMap?:boolean}} [opts]
 *   color：固有色（默认白，等于只用贴图）；gain：额外亮度衰减（默认 1，不衰减）
 * @returns {THREE.MeshLambertMaterial}
 */
export function glbLambert(srcMat, opts = {}) {
  // 固有色默认**继承原材质**：Poly Pizza 的枪是一堆独立小 mesh，每个 mesh 靠
  // material.color 分件（机匣 #22272a / 护木 #191f27 …），默认白色会把整把枪洗白。
  const base = opts.color != null ? opts.color : (srcMat && srcMat.color ? srcMat.color : 0xffffff);
  const color = new THREE.Color(base);
  const gain = opts.gain != null ? opts.gain : 1;
  if (gain !== 1) color.multiplyScalar(Math.max(0, gain));
  const keepMap = opts.keepMap !== false;
  const mat = new THREE.MeshLambertMaterial({
    map: keepMap && srcMat && srcMat.map ? srcMat.map : null,
    color,
    side: THREE.FrontSide,
  });
  if (opts.emissive != null) {
    mat.emissive = new THREE.Color(opts.emissive);
    mat.emissiveIntensity = opts.emissiveIntensity != null ? opts.emissiveIntensity : 0;
  }
  return mat;
}

/**
 * W6：GLB 的**保真 PBR** 出口 —— 与 glbLambert 并列，由调用方按画质档选择。
 *
 * 为什么需要它：glbLambert 为了压住过曝把 GLTF 的 Standard 降级成 Lambert，
 * 代价是 normal / roughness / metalness / AO 四通道全丢 —— Poly Haven 的木箱/
 * 弹药箱明明带四通道（glb-audit 已验证），渲染出来却是一块没高光的塑料板。
 * W5 已经把 ACES 与曝光（0.78）重标定过，本作灯光不再是 1.7 时代的过曝口径，
 * 现在有条件安全地用回 PBR。但**必须留可调 gain**，因为 Standard 漫反射在
 * 同样照度下仍比 Lambert 亮一档，浅色 albedo 不压会重新冲成白板。
 *
 * 保真项（GLTFLoader r160 已把 metalrough 拆成两张图、AO 映射到 uv0）：
 * - map / normalMap / roughnessMap / metalnessMap / aoMap 原样保留
 * - 固有色继承 srcMat.color（Poly Pizza 枪靠它分件），再乘 gain
 * - normalScale 可压：法线太强会出现"橘皮"，默认 0.85 偏保守
 *
 * 降级路径：srcMat 没有 normalMap（Kenney 单色贴图）时，Standard 只会更慢不会更好看，
 * 调用方应继续走 glbLambert。这里不自动降级，是为了让 A/B 能强制对比。
 *
 * @param {THREE.Material|null} srcMat GLTF 原材质
 * @param {{color?:number|string, gain?:number, envIntensity?:number, normalScale?:number,
 *          emissive?:number|string, emissiveIntensity?:number}} [opts]
 * @returns {THREE.MeshStandardMaterial}
 */
export function glbPbr(srcMat, opts = {}) {
  const base = opts.color != null ? opts.color : (srcMat && srcMat.color ? srcMat.color : 0xffffff);
  const color = new THREE.Color(base);
  const gain = opts.gain != null ? opts.gain : 1;
  if (gain !== 1) color.multiplyScalar(Math.max(0, gain));
  const mat = new THREE.MeshStandardMaterial({
    map: srcMat && srcMat.map ? srcMat.map : null,
    normalMap: srcMat && srcMat.normalMap ? srcMat.normalMap : null,
    roughnessMap: srcMat && srcMat.roughnessMap ? srcMat.roughnessMap : null,
    metalnessMap: srcMat && srcMat.metalnessMap ? srcMat.metalnessMap : null,
    aoMap: srcMat && srcMat.aoMap ? srcMat.aoMap : null,
    color,
    roughness: 1, // 交给 roughnessMap；无贴图时 1 = 全粗糙，不会假亮
    metalness: 1, // 交给 metalnessMap；无贴图时会被 srcMat 是否有图决定，见下
    envMapIntensity: opts.envIntensity != null ? opts.envIntensity : VIEW3D.envIntensity,
    side: THREE.FrontSide,
  });
  if (!srcMat || !srcMat.metalnessMap) mat.metalness = 0;
  const ns = opts.normalScale != null ? opts.normalScale : 0.85;
  if (mat.normalMap) mat.normalScale.set(ns, ns);
  if (opts.emissive != null) {
    mat.emissive = new THREE.Color(opts.emissive);
    mat.emissiveIntensity = opts.emissiveIntensity != null ? opts.emissiveIntensity : 0;
  }
  return mat;
}

/**
 * 把一个静态 GLB 场景合并成**单几何 + 单材质**，以便走 InstancedMesh（保持原设计的 draw call 数）。
 *
 * 只接受单一材质的模型（Kenney 全系都是 1 个 `colormap` 材质 + 调色板贴图）。
 * 多材质模型返回 null —— 宁可退回程序化模型，也不要把材质错配的模型塞进场景。
 *
 * 归一化：XZ 居中、Y 底面对齐 0。地图里的容器/道具都是"站在地面上"的，
 * 各建模工具的轴心约定不统一，统一在这里抹平，调用方不必逐个手调。
 *
 * @param {object} root GLTF 的 scene
 * @param {{yaw?:number}} [opts] yaw：绕 Y 轴预旋转（弧度），用于对齐模型朝向
 * @returns {{geometry:THREE.BufferGeometry, material:THREE.Material|null, triangles:number}|null}
 */
export function mergeStatic(root, opts = {}) {
  if (!root || typeof root.updateMatrixWorld !== 'function') return null;
  root.updateMatrixWorld(true);

  const meshes = [];
  const materials = new Set();
  root.traverse((o) => {
    if (!o || !o.isMesh || o.isSkinnedMesh || !o.geometry) return;
    meshes.push(o);
    const m = o.material;
    if (Array.isArray(m)) for (const mm of m) materials.add(mm);
    else if (m) materials.add(m);
  });
  if (!meshes.length) return null;
  if (materials.size !== 1) return null; // 多材质：不支持，交由调用方兜底

  const pos = [];
  const nor = [];
  const uvs = [];
  let hasUv = true;
  const v = new THREE.Vector3();
  const nm = new THREE.Matrix3();

  for (const mesh of meshes) {
    // 非索引化：合并逻辑最简单，且这些小模型顶点量极小（几十~几百），不值得为索引做偏移管理。
    const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
    if (!g.attributes.position) continue;
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) hasUv = false;

    nm.getNormalMatrix(mesh.matrixWorld);
    const pAttr = g.attributes.position;
    const nAttr = g.attributes.normal;
    const uAttr = g.attributes.uv;
    for (let i = 0; i < pAttr.count; i += 1) {
      v.fromBufferAttribute(pAttr, i).applyMatrix4(mesh.matrixWorld);
      pos.push(v.x, v.y, v.z);
      v.fromBufferAttribute(nAttr, i).applyMatrix3(nm).normalize();
      nor.push(v.x, v.y, v.z);
      if (uAttr) uvs.push(uAttr.getX(i), uAttr.getY(i));
    }
    g.dispose();
  }
  if (!pos.length) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  if (hasUv && uvs.length === (pos.length / 3) * 2) {
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  }

  const yaw = Number(opts.yaw) || 0;
  if (yaw) geometry.rotateY(yaw);

  // 归一化：XZ 居中（模型轴心差异），Y 落到 0（贴地）。
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  if (bb) {
    const cx = (bb.min.x + bb.max.x) / 2;
    const cz = (bb.min.z + bb.max.z) / 2;
    geometry.translate(-cx, -bb.min.y, -cz);
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const material = materials.values().next().value || null;
  const triangles = Math.round(pos.length / 9);
  return { geometry, material, triangles };
}

/**
 * 取模型在世界空间里的主轴朝向修正。
 *
 * Kenney 约定模型朝 -Z；本项目容器是随机 45° 摆放、对朝向不敏感，故默认 0。
 * 单独留成函数，是为了将来接武器/角色时不必再改 mergeStatic 的签名。
 * @param {string} _kit kit 名（保留参数，便于将来分来源配置）
 * @returns {number} 绕 Y 的预旋转弧度
 */
export function modelYaw(_kit) {
  return 0;
}
