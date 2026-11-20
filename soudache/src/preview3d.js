/**
 * W0：可复用的轻量 3D 预览容器（局外展示用）。
 *
 * 为什么需要它：局外（大厅/改枪台/装备配置/干员）目前一块 WebGL 都没有，改枪台只有
 * 320×112 的 2D 侧视线稿。要做到"写实 3D 枪模慢速旋转"，就必须在**不启动战局渲染器**
 * 的前提下，单独起一个极小的 three 场景。这个模块把这件事收敛成一份实现，供改枪台、
 * 角色装备预览、干员形象三处共用，避免各写一套导致灯光/缩放/销毁行为不一致。
 *
 * 硬约束：
 * 1) **节点环境必须可 import**：模块顶层不得触碰 document / window / WebGL（单测会直接 import）。
 * 2) **创建与销毁必须成对**：一个容器一份 renderer；dispose() 要释放几何/材质/贴图/上下文，
 *    WebGL 上下文有数量上限（常见 16 个），泄漏几次就会让整个页面拿不到 context。
 * 3) **不可见就停**：大厅有 12 个屏，只有一个是可见的。用 IntersectionObserver +
 *    visibilitychange 双保险暂停 rAF，别让 6 个隐藏预览一起烧 GPU。
 * 4) **材质走 glbLambert()**：与局内保持一致的低多边形 Lambert 观感；预览场景自带一套
 *    摄影棚灯光，不照搬局内 hemi26/ambient17（那是为夜战可见性标定的，会把模型冲白）。
 * 5) **模型朝向/缩放按包围盒算**：不同来源的 GLB 轴心与单位都不统一（Kenney 米制、
 *    Poly Pizza 各种比例），一律按包围盒归一化，调用方不必手调。
 */
import * as THREE from '../vendor/three.module.js';
import { clone as cloneSkinned } from '../vendor/SkeletonUtils.js';
import { loadGLB, glbLambert } from './assets.js';

/** 预览容器参数（纯数据，单测可直接断言）。 */
export const PREVIEW3D = {
  /** 相机垂直视场角（度）：比局内 75 小得多，长焦压缩更像产品展示 */
  fov: 30,
  near: 0.05,
  far: 60,
  /** 相机距离上下限（米，归一化后模型半径≈1） */
  minDistance: 1.35,
  maxDistance: 5.2,
  /** 自动旋转角速度（弧度/秒）——"缓慢旋转"的观感，约 20 秒一圈 */
  autoSpin: 0.32,
  /** 用户拖拽后暂停自动旋转的时长（毫秒） */
  spinResumeMs: 2600,
  /** 拖拽灵敏度（弧度/像素） */
  dragRad: 0.0075,
  /** 俯仰限位（弧度），避免翻到底盘或顶视图 */
  pitchMin: -0.55,
  pitchMax: 0.85,
  /** 设备像素比上限：预览不需要 3x，省一半填充率 */
  maxDpr: 2,
  /** 包围盒留白系数（1 = 刚好贴边，越大越松） */
  fitPadding: 1.16,
  /** 模型归一化后允许的额外缩放范围 */
  minScale: 0.5,
  maxScale: 2.2,
};

/**
 * 由包围盒推出相机距离（纯函数，无 DOM/WebGL，单测覆盖）。
 *
 * 为什么不用"包围球 / sin(半视角)"：那是保证球体在任意角度都完整可见的最保守公式，
 * 对细长的枪械会算大一倍以上（实测把 1.8 长的枪推到距离 5.2、画面里只剩一小截）。
 * 这里改为按**轴向半宽/半高**分别求距离再取大：
 * - 模型绕 Y 轴旋转，所以水平方向要按 max(sizeX, sizeZ) 扫掠；
 * - 竖直方向按 sizeY（俯仰还会加一点，用 padding 吃掉）；
 * - 最后加半个深度，保证最近的那个角也在近平面之内。
 * 竖屏（aspect < 1）水平视场更窄，同一把枪需要更远，公式会自动体现。
 *
 * @param {{min:{x:number,y:number,z:number}, max:{x:number,y:number,z:number}}} box 归一化后的包围盒
 * @param {{fov?:number, aspect?:number, padding?:number, pitch?:number}} [opts] `pitch` 是当前俯仰角
 *   （弧度）；不给则按最大俯仰角算，等于"任何角度都不裁切"的保守值
 * @returns {{distance:number, target:{x:number,y:number,z:number}, radius:number}}
 */
export function fitDistance(box, opts = {}) {
  const fov = (opts.fov != null ? opts.fov : PREVIEW3D.fov) * Math.PI / 180;
  const aspect = opts.aspect && opts.aspect > 0 ? opts.aspect : 1;
  const padding = opts.padding != null ? opts.padding : PREVIEW3D.fitPadding;

  const sizeX = Math.max(1e-6, box.max.x - box.min.x);
  const sizeY = Math.max(1e-6, box.max.y - box.min.y);
  const sizeZ = Math.max(1e-6, box.max.z - box.min.z);

  // 绕 Y 旋转时的水平扫掠半径 + 竖直半径 + 朝向相机的深度半宽
  const halfSweep = Math.max(sizeX, sizeZ) / 2;
  const halfH = sizeY / 2;
  const halfDepth = Math.min(sizeX, sizeZ) / 2;

  const vHalf = fov / 2;
  const hHalf = Math.atan(Math.tan(vHalf) * aspect);
  const byHeight = (halfH * padding) / Math.tan(vHalf);
  const byWidth = (halfSweep * padding) / Math.tan(hHalf);
  // 俯仰会让竖直投影变大：按俯仰角的余弦补偿（不会超过 1/cos）。
  // W2：以前一律按 pitchMax 算，等于永远按"最歪的机位"取景 —— 对人形模型会把距离
  // 放大 1.5 倍直接顶到 maxDistance，玩家看到的是一个缩在中间的小人。
  // 现在允许传入**当前**俯仰角，初始机位（0.12）就能取到正常距离。
  const pitch = opts.pitch != null
    ? Math.min(Math.abs(opts.pitch), 1.2)
    : Math.min(Math.abs(PREVIEW3D.pitchMax), 1.2);
  const tiltK = 1 / Math.cos(pitch);

  const dist = Math.max(byHeight * tiltK, byWidth) + halfDepth;

  const radius = 0.5 * Math.sqrt(sizeX * sizeX + sizeY * sizeY + sizeZ * sizeZ);
  return {
    distance: Math.min(PREVIEW3D.maxDistance, Math.max(PREVIEW3D.minDistance, dist)),
    target: {
      x: (box.min.x + box.max.x) / 2,
      y: (box.min.y + box.max.y) / 2,
      z: (box.min.z + box.max.z) / 2,
    },
    radius,
  };
}

/* ------------------------------------------------------------------ *
 * 内部：摄影棚灯光
 * ------------------------------------------------------------------ */

/**
 * 建一套产品展示用灯光。Lambert 只吃方向光/半球光/环境光，所以不用折腾 PBR。
 * 比例参考：主光最强定基调，冷补光提暗部细节，背光勾轮廓，环境光兜底不死黑。
 */
function studioLights(scene) {
  // 亮度标定：本作 GLB 材质统一走 glbLambert（Lambert），three r155+ 又是物理光照单位，
  // 局内那套 hemi26/ambient17 是配 ACES+曝光1.7 的标定，直接搬过来会把模型冲成浅白。
  // 下图这一档是**扫参 + 像素亮度实测**选出来的（ambient12/hemi24/key5.5/fill2.2/rim2.8
  // + 曝光1.4 + 材质 gain0.8）：枪身分件可辨、暗部不糊、高光不过曝。
  const ambient = new THREE.AmbientLight(0x9db4d2, 12);
  const hemi = new THREE.HemisphereLight(0xe8f1ff, 0x39424e, 24);
  const key = new THREE.DirectionalLight(0xfff6e8, 5.5);
  key.position.set(3.2, 5.0, 3.6);
  const fill = new THREE.DirectionalLight(0xa8c6ea, 2.2);
  fill.position.set(-4.2, 1.8, -2.6);
  const rim = new THREE.DirectionalLight(0xffd9b0, 2.8);
  rim.position.set(-0.6, 2.4, -5.4);
  scene.add(ambient, hemi, key, fill, rim);
  return [ambient, hemi, key, fill, rim];
}

/**
 * 生成一张软阴影贴图（径向渐变），铺在模型脚下当"接触阴影"。
 * 纯 canvas 生成，零外部素材；拿不到 canvas 时返回 null，调用方跳过即可。
 */
function makeShadowTexture() {
  if (typeof document === 'undefined' || !document.createElement) return null;
  const size = 128;
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const ctx = cv.getContext && cv.getContext('2d');
  if (!ctx) return null;
  const g = ctx.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.55)');
  g.addColorStop(0.45, 'rgba(0,0,0,0.24)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * 测量一个对象树的包围盒。
 *
 * **不能用 `new THREE.Box3().setFromObject()`**：某些 GLB（Poly Pizza 的枪是典型）
 * 带有空 position 属性或退化网格，`computeBoundingBox()` 会给出 ±Infinity，
 * union 之后整个包围盒变成 Infinity/NaN。后果非常隐蔽——归一化算不出 scale 直接放弃，
 * 模型按原始尺寸显示（实测一把枪 5.17 单位长），取景被顶到距离上限、枪被裁掉一半。
 * 所以逐 mesh 测量并**跳过任何非有限的包围盒**，只统计真正有几何的部分。
 *
 * @param {THREE.Object3D} root
 * @returns {THREE.Box3} 有效包围盒；一个有效 mesh 都没有时返回单位盒
 */
export function measureBox(root) {
  const box = new THREE.Box3();
  if (!root || typeof root.traverse !== 'function') {
    return box.set(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5));
  }
  root.updateMatrixWorld(true);
  const tmp = new THREE.Box3();
  root.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    const g = o.geometry;
    if (!g || !g.attributes || !g.attributes.position) return;
    if (!g.boundingBox) g.computeBoundingBox();
    const bb = g.boundingBox;
    if (!bb) return;
    if (!isFinite(bb.min.x) || !isFinite(bb.min.y) || !isFinite(bb.min.z)) return;
    if (!isFinite(bb.max.x) || !isFinite(bb.max.y) || !isFinite(bb.max.z)) return;
    tmp.copy(bb).applyMatrix4(o.matrixWorld);
    box.union(tmp);
  });
  if (box.isEmpty() || !isFinite(box.min.x)) {
    return box.set(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5));
  }
  return box;
}

/**
 * 把 model 规整到"最大边 ≈ targetMax、底面贴 0、水平居中"的标准姿态，便于统一取景。
 * @returns {{box:THREE.Box3, radius:number, scale:number}}
 */
function normalizeModel(model, opts = {}) {
  const targetMax = opts.targetMax != null ? opts.targetMax : 1.8;

  const box = measureBox(model);
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z, 1e-6);
  const scale = targetMax / maxDim;
  model.scale.multiplyScalar(scale);
  model.updateMatrixWorld(true);

  // 缩放后重新量（含新 scale），再居中/落地
  const box2 = measureBox(model);
  const center = new THREE.Vector3();
  box2.getCenter(center);
  model.position.x -= center.x;
  model.position.z -= center.z;
  model.position.y -= box2.min.y;
  model.updateMatrixWorld(true);

  const box3 = measureBox(model);
  const s = new THREE.Vector3();
  box3.getSize(s);
  const radius = 0.5 * Math.sqrt(s.x * s.x + s.y * s.y + s.z * s.z);
  return { box: box3, radius, scale };
}

/**
 * 释放一个对象树上的几何与材质（GLB 的贴图也要释放，否则切屏几次就吃满显存）。
 * @param {THREE.Object3D} root
 */
export function disposeObject3D(root) {
  if (!root || typeof root.traverse !== 'function') return;
  root.traverse((o) => {
    if (o.geometry && typeof o.geometry.dispose === 'function') o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) {
      if (!m) continue;
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'alphaMap']) {
        if (m[key] && typeof m[key].dispose === 'function') m[key].dispose();
      }
      if (typeof m.dispose === 'function') m.dispose();
    }
  });
}

/**
 * 创建一个预览容器。
 *
 * @param {HTMLElement} host 宿主元素（会往里塞一个 canvas，并接管其尺寸）
 * @param {{autoSpin?:boolean, shadow?:boolean, targetMax?:number, onReady?:(api:object)=>void}} [opts]
 * @returns {object|null} 控制器；无法创建 WebGL 时返回 null（调用方回退 2D 线稿）
 */
export function createPreview(host, opts = {}) {
  if (!host || typeof document === 'undefined') return null;

  // 重复挂载保护：同一个宿主被再次 create 时，先把上一次的画布/提示摘掉，
  // 否则会叠出两层 canvas（上层的 context 还活着，白烧 GPU）。
  if (host.querySelectorAll) {
    for (const old of host.querySelectorAll('.preview3d-canvas, .preview3d-hint')) {
      if (old.parentNode) old.parentNode.removeChild(old);
    }
  }

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true, // 背景交给 CSS 渐变，画布只画模型
      powerPreference: 'low-power',
    });
  } catch {
    return null;
  }
  if (!renderer || !renderer.getContext || !renderer.getContext()) {
    if (renderer && renderer.dispose) renderer.dispose();
    return null;
  }

  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.4;
  renderer.setPixelRatio(Math.min(PREVIEW3D.maxDpr, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));

  const canvas = renderer.domElement;
  canvas.className = 'preview3d-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  host.appendChild(canvas);

  // 操作提示：不写的话多数玩家不会想到"这里能拖"
  const hint = document.createElement('div');
  hint.className = 'preview3d-hint';
  hint.textContent = opts.hint || '拖拽旋转 · 滚轮缩放';
  host.appendChild(hint);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(PREVIEW3D.fov, 1, PREVIEW3D.near, PREVIEW3D.far);
  const lights = studioLights(scene);

  const rig = new THREE.Group(); // 模型挂在这个组上，旋转只动 rig
  scene.add(rig);

  // 接触阴影（可选）
  let shadowMesh = null;
  const shadowTex = opts.shadow === false ? null : makeShadowTexture();
  if (shadowTex) {
    shadowMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(3.4, 3.4),
      new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: 0.85 }),
    );
    shadowMesh.rotation.x = -Math.PI / 2;
    shadowMesh.position.y = 0.002;
    shadowMesh.renderOrder = -1;
    scene.add(shadowMesh);
  }

  const state = {
    mounted: true,
    ready: false,
    autoSpin: opts.autoSpin !== false,
    spinning: opts.autoSpin !== false,
    yaw: 0,
    pitch: 0.12,
    distance: 3.0,
    aspect: 1,
    triangles: 0,
    draws: 0,
    modelRel: '',
    frameCount: 0,
    disposed: false,
  };

  let model = null;
  let alive = false;       // 可见且在页面上
  let rafId = 0;
  let lastT = 0;
  let resumeAt = 0;
  let dirty = true;

  const targetMax = opts.targetMax != null ? opts.targetMax : 1.8;

  /** 按包围盒重算取景 */
  function refit() {
    if (!model) {
      state.distance = 3.0;
      return;
    }
    const box = measureBox(model);
    const fit = fitDistance(
      { min: { x: box.min.x, y: box.min.y, z: box.min.z }, max: { x: box.max.x, y: box.max.y, z: box.max.z } },
      {
        fov: PREVIEW3D.fov,
        aspect: state.aspect,
        padding: PREVIEW3D.fitPadding,
        // 用当前俯仰角，而不是"最歪的机位"——否则初始机位就被推到距离上限
        pitch: state.pitch,
      },
    );
    state.distance = fit.distance;
    camera.position.set(0, fit.target.y + 0.12, fit.distance);
    camera.lookAt(0, fit.target.y, 0);
    dirty = true;
  }

  /** 尺寸自适应（宿主可能随时变宽变窄，尤其是触屏横竖屏切换） */
  function resize() {
    const w = Math.max(1, Math.round(host.clientWidth || host.offsetWidth || 1));
    const h = Math.max(1, Math.round(host.clientHeight || host.offsetHeight || 1));
    state.aspect = w / h;
    camera.aspect = state.aspect;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    refit();
  }

  /** 渲染一帧 */
  function draw() {
    if (state.disposed) return;
    camera.position.set(0, camera.position.y, state.distance);
    // 先绕 Y 再绕 X：yaw 转模型，pitch 轻微俯视
    rig.rotation.y = state.yaw;
    rig.rotation.x = state.pitch;
    renderer.render(scene, camera);
    state.frameCount += 1;
    state.draws = renderer.info.render.calls;
    state.triangles = renderer.info.render.triangles;
    dirty = false;
  }

  function tick(t) {
    if (state.disposed) return;
    const dt = lastT ? Math.min(0.05, (t - lastT) / 1000) : 0;
    lastT = t;

    const canSpin = state.autoSpin && state.spinning && t >= resumeAt;
    if (canSpin && dt > 0) {
      state.yaw += PREVIEW3D.autoSpin * dt;
      dirty = true;
    }
    if (dirty) draw();
    rafId = requestAnimationFrame(tick);
  }

  function start() {
    if (state.disposed || alive) return;
    alive = true;
    lastT = 0;
    rafId = requestAnimationFrame(tick);
    dirty = true;
  }

  function stop() {
    alive = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  /* ---------------- 交互：拖拽旋转 + 滚轮缩放 ---------------- */

  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  function onPointerDown(e) {
    if (!model) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    state.spinning = false;
    if (canvas.setPointerCapture && e.pointerId != null) {
      try { canvas.setPointerCapture(e.pointerId); } catch { /* 忽略：某些浏览器不支持 */ }
    }
  }

  function onPointerMove(e) {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    state.yaw += dx * PREVIEW3D.dragRad;
    state.pitch = Math.max(PREVIEW3D.pitchMin, Math.min(PREVIEW3D.pitchMax, state.pitch + dy * PREVIEW3D.dragRad * 0.6));
    dirty = true;
  }

  function onPointerUp() {
    if (!dragging) return;
    dragging = false;
    resumeAt = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + PREVIEW3D.spinResumeMs;
    state.spinning = state.autoSpin;
  }

  function onWheel(e) {
    if (!model) return;
    e.preventDefault();
    const k = Math.exp((e.deltaY > 0 ? 1 : -1) * 0.12);
    state.distance = Math.max(PREVIEW3D.minDistance, Math.min(PREVIEW3D.maxDistance, state.distance * k));
    dirty = true;
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  /* ---------------- 可见性 / 尺寸监听 ---------------- */

  let io = null;
  if (typeof IntersectionObserver !== 'undefined') {
    io = new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1];
      if (!e) return;
      if (e.isIntersecting && !document.hidden) start();
      else stop();
    }, { threshold: 0.01 });
    io.observe(host);
  } else {
    start();
  }

  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => resize());
    ro.observe(host);
  }

  function onVisibility() {
    if (typeof document === 'undefined') return;
    if (document.hidden) stop();
    else if (host.isConnected) start();
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);

  resize();
  // 先起循环：IntersectionObserver 的首个回调是异步的，若等它来启动，
  // 模型加载完到首帧之间会出现一段"空画布"；启动后 IO 会在真正不可见时立刻 stop。
  start();

  /* ---------------- 对外 API ---------------- */

  const api = {
    canvas,
    scene,
    camera,
    renderer,

    /** 直接塞一个已建好的 Object3D（调用方负责不要再复用它） */
    setModel(root, meta = {}) {
      if (state.disposed) return;
      if (model) {
        rig.remove(model);
        disposeObject3D(model);
        model = null;
      }
      if (!root) {
        state.ready = false;
        state.modelRel = '';
        dirty = true;
        return;
      }
      model = root;
      normalizeModel(model, { targetMax });
      rig.add(model);
      state.ready = true;
      state.modelRel = meta.rel || '';
      state.yaw = meta.yaw != null ? meta.yaw : 0;
      state.pitch = 0.12;
      refit();
      dirty = true;
    },

    /**
     * 按 assets/ 相对路径加载 GLB 并显示。
     * @param {string} rel 例如 `models/poly-pizza/weapon-rifle-assault.glb`
     * @param {{gain?:number, skinned?:boolean, yaw?:number}} [loadOpts]
     * @returns {Promise<boolean>} 是否成功显示
     */
    async loadModel(rel, loadOpts = {}) {
      if (state.disposed) return false;
      const gltf = await loadGLB(rel);
      if (!gltf || !gltf.scene || state.disposed) return false;
      // 蒙皮模型（角色）必须用 SkeletonUtils.clone，否则骨骼/动画会断
      const root = loadOpts.skinned ? cloneSkinned(gltf.scene) : gltf.scene.clone(true);
      const gain = loadOpts.gain != null ? loadOpts.gain : 0.8;
      root.traverse((o) => {
        if (!o.isMesh && !o.isSkinnedMesh) return;
        if (!o.material) return;
        if (Array.isArray(o.material)) o.material = o.material.map((m) => glbLambert(m, { gain }));
        else o.material = glbLambert(o.material, { gain });
      });
      this.setModel(root, { rel, yaw: loadOpts.yaw });
      return true;
    },

    /** 切换自动旋转 */
    setAutoSpin(on) {
      state.autoSpin = !!on;
      state.spinning = !!on;
      dirty = true;
    },

    /** 手动设角度（探针用：可复现同一机位截图） */
    setView({ yaw, pitch, distance } = {}) {
      if (yaw != null) state.yaw = yaw;
      if (pitch != null) state.pitch = pitch;
      if (distance != null) {
        state.distance = Math.max(PREVIEW3D.minDistance, Math.min(PREVIEW3D.maxDistance, distance));
      }
      dirty = true;
      draw();
    },

    /** 强制重绘一帧（探针：改完视觉再截图） */
    frame(n = 1) {
      for (let i = 0; i < n; i += 1) draw();
    },

    /**
     * 调整打光（标定/调试用）。
     * three r155+ 用物理光照单位，Lambert 模型要吃到能看出层次的亮度，
     * 强度量级远大于"直觉值"；预览的最终档位就是用本方法扫出来的（见 W0 标定记录）。
     * @param {{ambient?:number, hemi?:number, key?:number, fill?:number, rim?:number, exposure?:number}} v
     */
    setLights(v = {}) {
      for (const l of lights) {
        const k = l.isAmbientLight ? 'ambient' : l.isHemisphereLight ? 'hemi' : null;
        if (k && v[k] != null) l.intensity = v[k];
      }
      // 方向光按添加顺序：key / fill / rim
      const dirs = lights.filter((l) => l.isDirectionalLight);
      if (v.key != null && dirs[0]) dirs[0].intensity = v.key;
      if (v.fill != null && dirs[1]) dirs[1].intensity = v.fill;
      if (v.rim != null && dirs[2]) dirs[2].intensity = v.rim;
      if (v.exposure != null) renderer.toneMappingExposure = v.exposure;
      dirty = true;
      draw();
    },

    resize,

    /** 状态快照（探针读真值，不靠截图猜） */
    snapshot() {
      let size = null;
      if (model) {
        const b = measureBox(model);
        const s = new THREE.Vector3();
        b.getSize(s);
        size = { x: Number(s.x.toFixed(3)), y: Number(s.y.toFixed(3)), z: Number(s.z.toFixed(3)) };
      }
      return {
        mounted: state.mounted,
        ready: state.ready,
        autoSpin: state.autoSpin,
        spinning: state.spinning,
        yaw: Number(state.yaw.toFixed(4)),
        pitch: Number(state.pitch.toFixed(4)),
        distance: Number(state.distance.toFixed(3)),
        aspect: Number(state.aspect.toFixed(3)),
        triangles: state.triangles,
        draws: state.draws,
        frames: state.frameCount,
        model: state.modelRel,
        size,
        lights: lights.length,
      };
    },

    /** 彻底销毁：停循环、断监听、释放模型与渲染器（含 WebGL context） */
    dispose() {
      if (state.disposed) return;
      state.disposed = true;
      stop();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
      if (io) io.disconnect();
      if (ro) ro.disconnect();
      if (model) {
        rig.remove(model);
        disposeObject3D(model);
        model = null;
      }
      if (shadowMesh) {
        shadowMesh.geometry.dispose();
        if (shadowMesh.material.map) shadowMesh.material.map.dispose();
        shadowMesh.material.dispose();
        scene.remove(shadowMesh);
        shadowMesh = null;
      }
      scene.remove(rig);
      for (const l of lights) scene.remove(l);
      renderer.dispose();
      if (renderer.forceContextLoss) {
        try { renderer.forceContextLoss(); } catch { /* 忽略 */ }
      }
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      if (hint.parentNode) hint.parentNode.removeChild(hint);
      state.mounted = false;
    },
  };

  if (typeof opts.onReady === 'function') opts.onReady(api);
  return api;
}
