/**
 * 3D 场景基础设施：渲染器 / 场景 / 相机 / 光照 / 雾 / 天空 / resize
 *
 * 模块边界：本文件是全项目少数几个允许 `import THREE` 的模块之一。
 * 坐标契约：逻辑 (x, y) → 场景 (x, height, y)，即 XZ 平面为地面、Y 轴向上。
 */

import * as THREE from '../vendor/three.module.js';
import { VIEW3D, PALETTE3D, WORLD_W, WORLD_H } from './config.js';

/**
 * 检测 WebGL 是否可用。
 * 无 WebGL 时（浏览器禁用 / 老旧设备 / Node 无头环境）返回 false，
 * 调用方据此降级为 no-op 渲染器，保证游戏逻辑循环仍可运行。
 * @returns {boolean} 是否可用
 */
export function isWebGLAvailable() {
  try {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return false;
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2') || probe.getContext('webgl');
    if (!gl) return false;
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return true;
  } catch {
    return false;
  }
}

/**
 * 创建 3D 场景。WebGL 不可用时返回 null（调用方必须处理该分支）。
 * @param {HTMLCanvasElement} canvas 画布
 * @param {object} [device] 设备分级（detectDeviceTier 返回值），low 档走手机降档画质
 * @returns {object|null} 场景句柄
 */
export function createScene3D(canvas, device) {
  const lowQ = !!(device && device.quality === 'low');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
  } catch (err) {
    console.warn('[搜打撤] WebGL 渲染器创建失败，已降级为无渲染模式：', err);
    return null;
  }
  if (!renderer) return null;

  // 像素比上限会随自适应降级下调，统一经 applyViewport 应用，避免各处逻辑不一致
  // 手机降档：像素比直接压到 1（高分屏 devicePixelRatio 常为 2~3，最划算的省电/提帧手段）
  let pixelRatioCap = lowQ ? 1 : VIEW3D.maxPixelRatio;

  /** 按当前像素比上限应用视口尺寸 */
  function applyViewport() {
    renderer.setPixelRatio(Math.min(pixelRatioCap, window.devicePixelRatio || 1));
    renderer.setSize(Math.max(1, window.innerWidth), Math.max(1, window.innerHeight), false);
  }
  applyViewport();

  renderer.shadowMap.enabled = !lowQ;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
  // 色调映射：把 HDR 光照压回显示器能表现的范围内，高光不再糊成死白，
  // 整体对比与色彩层次立刻上一个台阶（这一步的观感收益最大）。
  if ('toneMapping' in renderer) {
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = VIEW3D.toneMappingExposure;
  }

  const scene = new THREE.Scene();

  /* ---------------- 天空与程序化环境贴图 ---------------- */

  /**
   * 生成一张竖直渐变的等距柱状投影（equirect）贴图。
   * 既当天空背景，也用来烘环境反射 —— 零外部资源，纯 Canvas 绘制。
   * @returns {THREE.CanvasTexture} 天空贴图
   */
  function makeSkyTexture() {
    const c = document.createElement('canvas');
    c.width = 16;
    c.height = 256;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, c.height);
    g.addColorStop(0, VIEW3D.skyTop);
    g.addColorStop(0.55, VIEW3D.skyMid);
    g.addColorStop(1, VIEW3D.skyBottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c.width, c.height);
    const tex = new THREE.CanvasTexture(c);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  const skyTex = makeSkyTexture();
  scene.background = skyTex;
  // 手机降档：缩短视距 + 加密雾，既保帧率又避免远处被裁出后露出空洞边界
  // （必须在 scene.fog 之前声明：fog 与 camera 都要用它们）
  const far = lowQ ? 1150 : VIEW3D.far;
  const fogDensity = VIEW3D.fogDensityPerMeter * (lowQ ? 1.9 : 1) / VIEW3D.metersToUnits;
  // 设计文档的雾密度以"米"为单位，这里换算到场景单位
  scene.fog = new THREE.FogExp2(PALETTE3D.fog, fogDensity);

  // 用天空烘一张 PMREM 环境贴图：Standard 材质因此获得天光反射，
  // 金属 / 湿润表面不会是死黑一片，整体质感提升明显。
  // 手机降档：环境贴图分辨率调低（只影响一次性的生成耗时，运行时零成本）
  let envRT = null;
  try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    if (lowQ && 'envMapSize' in VIEW3D) pmrem.envMapSize = Math.min(pmrem.envMapSize || 128, 64);
    envRT = pmrem.fromEquirectangular(skyTex);
    scene.environment = envRT.texture;
    pmrem.dispose();
  } catch (err) {
    console.warn('[搜打撤] 环境贴图生成失败，已跳过（不影响玩法）：', err);
  }

  const camera = new THREE.PerspectiveCamera(
    VIEW3D.fov,
    Math.max(0.1, window.innerWidth / Math.max(1, window.innerHeight)),
    VIEW3D.near,
    far,
  );
  // YXZ：先 yaw 后 pitch，符合 FPS 相机直觉（避免绕 Z 轴 roll）
  camera.rotation.order = 'YXZ';
  camera.position.set(WORLD_W / 2, VIEW3D.eyeStand, WORLD_H / 2);

  /* ---------------- 光照 ---------------- */

  const hemi = new THREE.HemisphereLight(
    new THREE.Color(PALETTE3D.hemiSky),
    new THREE.Color(PALETTE3D.hemiGround),
    VIEW3D.hemiIntensity,
  );
  hemi.position.set(0, 200, 0);
  scene.add(hemi);

  const ambient = new THREE.AmbientLight(
    new THREE.Color(PALETTE3D.ambient),
    VIEW3D.ambientIntensity,
  );
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(
    new THREE.Color(PALETTE3D.dirLight),
    VIEW3D.dirIntensity,
  );
  sun.castShadow = !lowQ;
  sun.shadow.mapSize.set(VIEW3D.shadowMapSize, VIEW3D.shadowMapSize);
  sun.shadow.bias = VIEW3D.shadowBias;
  sun.shadow.normalBias = 0.02;
  const shadowR = VIEW3D.shadowRadius * VIEW3D.metersToUnits;
  const cam = sun.shadow.camera;
  cam.left = -shadowR;
  cam.right = shadowR;
  cam.top = shadowR;
  cam.bottom = -shadowR;
  cam.near = VIEW3D.shadowNear;
  cam.far = VIEW3D.shadowFar;
  cam.updateProjectionMatrix();
  const target = new THREE.Object3D();
  target.position.set(WORLD_W / 2, 0, WORLD_H / 2);
  scene.add(target);
  sun.target = target;
  scene.add(sun);

  function placeSun(fx, fz) {
    const o = VIEW3D.dirLightOffset;
    sun.position.set(fx + o.x, o.y, fz + o.z);
    target.position.set(fx, 0, fz);
  }
  placeSun(WORLD_W / 2, WORLD_H / 2);

  /* ---------------- 空气尘埃（体积感） ---------------- */

  /**
   * 在相机周围铺一层缓慢漂浮的尘埃。
   * 关键是"跟着相机走的局部体积"：粒子始终分布在相机附近的一个盒子里，
   * 并对超出半径的分量做环绕折返，这样任何位置都能看到浮尘，又不需要铺满全图。
   */
  let dust = null;
  // 手机降档：关闭空气尘埃（纯装饰，零收益但每帧要更新一批顶点）
  const dustN = lowQ ? 0 : Math.max(0, VIEW3D.dustCount | 0);
  if (dustN > 0) {
    const R = VIEW3D.dustRadius * VIEW3D.metersToUnits;
    const pos = new Float32Array(dustN * 3);
    for (let i = 0; i < dustN; i += 1) {
      pos[i * 3] = (Math.random() - 0.5) * 2 * R;
      pos[i * 3 + 1] = Math.random() * R * 0.55;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 2 * R;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    dust = new THREE.Points(geo, new THREE.PointsMaterial({
      color: new THREE.Color(PALETTE3D.dust || '#C9D6E4'),
      size: VIEW3D.dustSize * VIEW3D.metersToUnits,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
      fog: true,
    }));
    dust.frustumCulled = false;
    scene.add(dust);
  }

  /* ---------------- 自适应性能 ---------------- */

  // 只降级不升级，避免在阈值附近来回抖动
  let perfLevel = 0; // 0=2048 阴影, 1=1024 阴影, 2=关闭阴影, 3=降低渲染分辨率
  let acc = 0;
  let frames = 0;

  /**
   * 累积帧时间，连续低于 ~45fps 时逐级降级画质以保帧率。
   * 降级顺序遵循"先牺牲画质细节、最后才动分辨率"：
   * 阴影贴图 2048 → 1024 → 关闭实时阴影 → 像素比降到 minPixelRatioFallback。
   * @param {number} dt 帧间隔秒
   * @returns {void}
   */
  function samplePerf(dt) {
    // 手机端已在最低档（像素比 1 + 关阴影），没有进一步降级空间；跳过以免打出误导性的降级日志
    if (lowQ) return;
    if (perfLevel >= 3) return;
    acc += dt;
    frames += 1;
    if (frames < 90) return;
    const avg = acc / frames;
    acc = 0;
    frames = 0;
    if (avg > 0.0222) {
      perfLevel += 1;
      if (perfLevel === 1) {
        sun.shadow.mapSize.set(VIEW3D.shadowMapSizeFallback, VIEW3D.shadowMapSizeFallback);
        sun.shadow.map?.dispose();
        sun.shadow.map = null;
        console.info('[搜打撤] 帧率偏低，阴影贴图降级为 1024');
      } else if (perfLevel === 2) {
        sun.castShadow = false;
        console.info('[搜打撤] 帧率仍偏低，已关闭实时阴影以保帧率');
      } else {
        // 阴影已关仍不达标，分辨率是最后一个杠杆（对低端 GPU 效果最直接）
        pixelRatioCap = VIEW3D.minPixelRatioFallback;
        applyViewport();
        console.info('[搜打撤] 帧率仍偏低，已降低渲染分辨率以保帧率');
      }
    }
  }

  /* ---------------- resize ---------------- */

  /** 让尘埃跟随相机：超出半径的分量折返到另一侧，形成无限延伸的局部体积 */
  function updateDust(cx, cz) {
    if (!dust) return;
    const R = VIEW3D.dustRadius * VIEW3D.metersToUnits;
    const arr = dust.geometry.attributes.position.array;
    for (let i = 0; i < arr.length; i += 3) {
      // 世界坐标 = 相机坐标 + 偏移，这里把偏移限制在 [-R, R] 内并做环绕
      let dx = arr[i] - cx;
      if (dx > R) arr[i] -= 2 * R;
      else if (dx < -R) arr[i] += 2 * R;
      let dz = arr[i + 2] - cz;
      if (dz > R) arr[i + 2] -= 2 * R;
      else if (dz < -R) arr[i + 2] += 2 * R;
    }
    dust.geometry.attributes.position.needsUpdate = true;
  }

  function resize() {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    // 沿用当前降级后的像素比上限，避免 resize 把已生效的降级重置回去
    applyViewport();
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  return {
    THREE,
    renderer,
    scene,
    camera,
    sun,
    hemi,
    ambient,
    resize,
    /** 把阴影视锥（与平行光）聚焦到玩家周围，换取更清晰的近处阴影 */
    focusShadow(x, z) {
      placeSun(x, z);
      updateDust(x, z);
    },
    samplePerf,
    get perfLevel() {
      return perfLevel;
    },
    dispose() {
      if (dust) {
        dust.geometry.dispose();
        dust.material.dispose();
      }
      if (envRT) envRT.dispose();
      skyTex.dispose();
      renderer.dispose();
      scene.clear();
    },
  };
}
