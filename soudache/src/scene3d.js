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
 * @param {string} [theme] 时段主题：'day' | 'night'（夜战低光 + 头灯）
 * @returns {object|null} 场景句柄
 */
export function createScene3D(canvas, device, theme = 'day') {
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

  // 保留 canvas / ctx 引用：切换时段时要就地重绘渐变并置 needsUpdate（不重建纹理对象）
  let skyCanvas = null;
  let skyCtx = null;

  // 几何白云（对照 docs/art-concept/04-scene-day.png）：固定布局画进天空纹理，零额外资源。
  // equirect 横向无缝环绕；夜战重绘渐变时整幅覆盖，云自然消失。
  const CLOUDS = [
    [0.08, 0.34, 0.070], [0.22, 0.40, 0.050], [0.37, 0.33, 0.062],
    [0.54, 0.42, 0.046], [0.68, 0.35, 0.078], [0.87, 0.40, 0.055],
  ];
  function drawClouds(ctx, w, h) {
    ctx.fillStyle = 'rgba(250,252,254,0.95)';
    for (const [cu, cv, r] of CLOUDS) {
      const cx = cu * w;
      const cy = cv * h;
      const rw = r * w;
      const rh = r * w * 0.42;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rw, rh, 0, 0, Math.PI * 2);
      ctx.ellipse(cx - rw * 0.55, cy + rh * 0.35, rw * 0.6, rh * 0.7, 0, 0, Math.PI * 2);
      ctx.ellipse(cx + rw * 0.6, cy + rh * 0.3, rw * 0.55, rh * 0.65, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /**
   * 生成一张竖直渐变的等距柱状投影（equirect）贴图。
   * 既当天空背景，也用来烘环境反射 —— 零外部资源，纯 Canvas 绘制。
   * @param {string[]} [colors] 三段渐变色 [top, mid, bottom]，缺省取 VIEW3D 的白昼色
   * @returns {THREE.CanvasTexture} 天空贴图
   */
  function makeSkyTexture(colors) {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 256;
    const ctx = c.getContext('2d');
    const [top, mid, bottom] = colors || [VIEW3D.skyTop, VIEW3D.skyMid, VIEW3D.skyBottom];
    const g = ctx.createLinearGradient(0, 0, 0, c.height);
    g.addColorStop(0, top);
    g.addColorStop(0.55, mid);
    g.addColorStop(1, bottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c.width, c.height);
    drawClouds(ctx, c.width, c.height); // 初始按白昼带云，随后 applyTheme 按主题重绘
    const tex = new THREE.CanvasTexture(c);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
    skyCanvas = c;
    skyCtx = ctx;
    return tex;
  }

  /** 就地重绘天空渐变（切换时段用），随后由调用方刷新环境贴图 */
  function repaintSky(colors, withClouds) {
    if (!skyCtx || !skyCanvas) return;
    const [top, mid, bottom] = colors;
    const g = skyCtx.createLinearGradient(0, 0, 0, skyCanvas.height);
    g.addColorStop(0, top);
    g.addColorStop(0.55, mid);
    g.addColorStop(1, bottom);
    skyCtx.fillStyle = g;
    skyCtx.fillRect(0, 0, skyCanvas.width, skyCanvas.height);
    if (withClouds) drawClouds(skyCtx, skyCanvas.width, skyCanvas.height);
    skyTex.needsUpdate = true;
  }

  const skyTex = makeSkyTexture();
  scene.background = skyTex;
  // 手机降档：缩短视距 + 加密雾，既保帧率又避免远处被裁出后露出空洞边界
  // （必须在 scene.fog 之前声明：fog 与 camera 都要用它们）
  const far = lowQ ? 1150 : VIEW3D.far;
  const fogBase = VIEW3D.fogDensityPerMeter * (lowQ ? 1.9 : 1) / VIEW3D.metersToUnits;
  // 设计文档的雾密度以"米"为单位，这里换算到场景单位（夜战再乘 fogMul 加浓）
  scene.fog = new THREE.FogExp2(PALETTE3D.fog, fogBase);

  // 用天空烘一张 PMREM 环境贴图：Standard 材质因此获得天光反射，
  // 金属 / 湿润表面不会是死黑一片，整体质感提升明显。
  // 手机降档：环境贴图分辨率调低（只影响一次性的生成耗时，运行时零成本）
  let envRT = null;
  /** 用当前天空重烘环境贴图（切换时段后天空变了，反射也要跟着变） */
  function rebuildEnv() {
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      pmrem.compileEquirectangularShader();
      if (lowQ && 'envMapSize' in VIEW3D) pmrem.envMapSize = Math.min(pmrem.envMapSize || 128, 64);
      const next = pmrem.fromEquirectangular(skyTex);
      pmrem.dispose();
      if (envRT) envRT.dispose();
      envRT = next;
      scene.environment = envRT.texture;
    } catch (err) {
      console.warn('[搜打撤] 环境贴图生成失败，已跳过（不影响玩法）：', err);
    }
  }
  rebuildEnv();

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

  /* ---------------- 玩家头灯（仅夜战） ---------------- */

  // 头灯是一个挂在相机上的聚光灯：位置每帧跟随相机、朝向取相机前向。
  // 只在夜战加入场景（白天加进去会白白给所有材质多编译一份聚光灯分支）。
  const flCfg = VIEW3D.flashlight;
  const flashlight = new THREE.SpotLight(
    new THREE.Color(flCfg.color), 0, flCfg.distance, flCfg.angle, flCfg.penumbra, flCfg.decay,
  );
  flashlight.castShadow = false; // 头灯打阴影在手机上是纯亏，锥内明暗已足够表达
  const flTarget = new THREE.Object3D();
  scene.add(flTarget); // target 必须挂在场景里，方向才会被更新
  flashlight.target = flTarget;
  let flashlightInScene = false;

  /**
   * 每帧跟随相机：把头灯钉在视点、照向相机正前方。
   * @param {{x:number,y:number,z:number}} pos 相机世界坐标
   * @param {{x:number,y:number,z:number}} dir 相机前向（单位向量）
   * @param {boolean} enabled 是否点亮
   * @returns {void}
   */
  function updateFlashlight(pos, dir, enabled) {
    const want = Boolean(enabled);
    if (want !== flashlightInScene) {
      flashlightInScene = want;
      if (want) scene.add(flashlight);
      else scene.remove(flashlight);
    }
    if (!want) return;
    const o = flCfg.offset;
    flashlight.position.set(pos.x + (o.x || 0), pos.y + (o.y || 0), pos.z + (o.z || 0));
    flTarget.position.set(pos.x + dir.x * 200, pos.y + dir.y * 200, pos.z + dir.z * 200);
    flashlight.intensity = flCfg.intensity;
  }

  /* ---------------- 时段主题 ---------------- */

  let curTheme = 'day';

  /**
   * 切换时段主题（白昼 / 夜战）：只改光照强度、天空色、雾浓度与曝光，
   * 地图与几何完全不动 —— 同一张图两种气氛。
   * @param {string} next 'day' | 'night'
   * @returns {void}
   */
  function applyTheme(next) {
    const t = (VIEW3D.theme && VIEW3D.theme[next]) ? VIEW3D.theme[next] : VIEW3D.theme.day;
    curTheme = VIEW3D.theme[next] ? next : 'day';
    scene.userData.theme = curTheme; // level3d 据此决定天花板用白昼天空还是夜战深蓝黑
    hemi.intensity = t.hemiIntensity;
    hemi.color.set(t.hemiSky || PALETTE3D.hemiSky);
    hemi.groundColor.set(t.hemiGround || PALETTE3D.hemiGround);
    ambient.intensity = t.ambientIntensity;
    if (t.ambientColor) ambient.color.set(t.ambientColor);
    sun.intensity = t.dirIntensity;
    if (t.sunColor) sun.color.set(t.sunColor); // 白昼暖阳 / 夜战冷月光
    if ('toneMappingExposure' in renderer) renderer.toneMappingExposure = t.exposure;
    if (scene.fog) {
      scene.fog.density = fogBase * (t.fogMul || 1);
      if (t.fogColor) scene.fog.color.set(t.fogColor);
    }
    repaintSky([t.skyTop, t.skyMid, t.skyBottom], t.clouds);
    rebuildEnv(); // 天空变了，环境反射必须跟着变，否则夜里材质仍按白天的天光反照
  }
  applyTheme(theme);

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
   * 累积帧时间，连续低于 ~55fps 时逐级降级画质以保帧率。
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
    if (avg > 0.0182) {
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
    /** 当前时段主题（'day' | 'night'） */
    get theme() {
      return curTheme;
    },
    applyTheme,
    updateFlashlight,
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
