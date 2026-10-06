/**
 * 环境氛围（模块 10）—— 叠加在模块 1 的世界之上，不改动地形/光照/障碍逻辑。
 * ---------------------------------------------------------------------------
 * 只做"氛围层"四件事（+ 一个地面细节法线），全部可独立关闭、不碰模块 1~9 的数值：
 *   ① 指数雾 FogExp2（密度 0.004~0.006 淡灰黄）—— 增加战场纵深
 *   ② 渐变天穹（着色器球，墨青天顶 → 宣纸米白地平线）+ 太阳光晕精灵
 *   ③ 远景低模山体/树林剪影（合并单几何体、不投阴影、draw call ≤ 10）
 *   ④ 地面叠加细节法线贴图（程序化），土路与草地接缝由世界已有的 polygonOffset 处理
 *
 * ⚠ 旧的 textured 天穹（world.sky）原地隐藏，避免两层天空叠在一起。
 * ⚠ 所有新物体都跟随玩家移动（天穹/太阳/剪影环），玩家永远走不到"边界"。
 */
import {
  BackSide,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  FogExp2,
  Group,
  Mesh,
  MeshBasicMaterial,
  RepeatWrapping,
  ShaderMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
} from '../../vendor/three/three.module.js';
import { ENVIRONMENT, LIGHT } from './config.js';
import { mergeParts, at, placed } from './geoMerge.js';

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main(){
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const SKY_FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;
uniform vec3 topColor;
uniform vec3 horizonColor;
void main(){
  float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
  // 地平线附近压一点暖白，越往上越墨青
  float t = pow(smoothstep(0.48, 1.0, h), 0.75);
  vec3 col = mix(horizonColor, topColor, t);
  gl_FragColor = vec4(col, 1.0);
}
`;

/** 程序化细节法线贴图（小尺寸 value-noise 法线，tile 平铺） */
function makeDetailNormal() {
  const s = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(s, s);
  // 基础平面法线 (128,128,255)，叠加随机梯度
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      const n = (Math.sin(x * 0.7) + Math.cos(y * 0.9) + Math.sin((x + y) * 0.3)) * 0.5;
      const nx = Math.sin((x + n * 6) * 0.25) * 14;
      const ny = Math.cos((y + n * 6) * 0.25) * 14;
      img.data[i] = 128 + nx;
      img.data[i + 1] = 128 + ny;
      img.data[i + 2] = 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new CanvasTexture(cv);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.repeat.set(48, 48);
  return tex;
}

/** 太阳径向光晕贴图（米白 → 透明） */
function makeSunHalo() {
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,250,0.95)');
  g.addColorStop(0.25, 'rgba(238,232,210,0.55)');
  g.addColorStop(0.6, 'rgba(220,214,190,0.18)');
  g.addColorStop(1, 'rgba(220,214,190,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  return new CanvasTexture(cv);
}

export function enhanceWorld(scene, world, renderer) {
  try {
    const root = new Group();
    root.name = 'ink-environment';
    scene.add(root);

    // ── ① 指数雾（覆盖旧线性雾）──
    scene.fog = new FogExp2(ENVIRONMENT.FOG_COLOR, ENVIRONMENT.FOG_DENSITY);

    // ── ② 渐变天穹 + 太阳 ──
    if (world.sky) world.sky.visible = false; // 旧 textured 天穹让位
    const skyMat = new ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        topColor: { value: new Color(ENVIRONMENT.SKY_TOP) },
        horizonColor: { value: new Color(ENVIRONMENT.SKY_HORIZON) },
      },
    });
    const sky = new Mesh(new SphereGeometry(500, 32, 20), skyMat);
    sky.name = 'ink-sky';
    sky.renderOrder = -1;
    sky.frustumCulled = false;
    root.add(sky);

    const halo = new Sprite(new SpriteMaterial({
      map: makeSunHalo(),
      color: ENVIRONMENT.SUN_HALO_COLOR,
      transparent: true,
      // ★SPEC(模块13) 光晕强度降至 0.5：原来的满强度在宣纸米白天空里是一坨过曝白斑，
      //   会把"留白"压成"曝光过度"，水墨感全失。
      opacity: ENVIRONMENT.SUN_HALO_INTENSITY,
      depthWrite: false,
      depthTest: false,
      fog: false,
    }));
    halo.scale.set(ENVIRONMENT.SUN_HALO_SIZE, ENVIRONMENT.SUN_HALO_SIZE, 1);
    halo.name = 'sun-halo';
    root.add(halo);

    // ── ③ 远景剪影：合并单几何体，draw call ≤ 10 ──
    const silhouettes = new Group();
    silhouettes.name = 'distant-silhouettes';
    root.add(silhouettes);
    // ★SPEC(模块13) 山体由"黛蓝 / 近黑"两色改成**由近及远的淡墨灰阶**：
    //   #9aa3a0（近）→ #c9cdc8（远）。越远越淡、越接近宣纸底 —— 传统山水的"远山淡"。
    const nearInk = new Color(ENVIRONMENT.SILHOUETTE_NEAR_COLOR);
    const farInk = new Color(ENVIRONMENT.SILHOUETTE_FAR_COLOR);
    const rings = Math.max(2, Math.min(3, ENVIRONMENT.SILHOUETTE_RINGS || 3));
    const ringColor = (k) => new Color().lerpColors(nearInk, farInk, rings > 1 ? k / (rings - 1) : 0);

    // 山体：几个锥/棱台合并成一份几何（所有层**共用**这一份，靠材质分色 ——
    //   ⚠ 顶点色是乘性的（final = material.color × vertexColor），所以分层染色只需要换
    //   material.color，不必 clone 几何、也不必改顶点属性，省内存也省构建时间。）
    const mountainParts = [];
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const r = 60 + (i % 3) * 14;
      const hgt = 26 + (i % 4) * 10;
      const w = 34 + (i % 3) * 12;
      mountainParts.push({
        geometry: new ConeGeometry(w, hgt, 5),
        color: 0xffffff, // 白 = 不染色，层次交给 material.color
        shade: 0.9 + (i % 3) * 0.05, // 各峰之间留一点明暗，纯色一片会像纸片
        matrix: placed({ x: Math.cos(a) * r, y: hgt / 2 - 2, z: Math.sin(a) * r }, 0, 1),
      });
    }
    const mountainGeo = mergeParts(mountainParts).geometry;
    // 每层一份材质（颜色不同），共 rings 个 draw call
    const mountainMeshes = [];
    const ringScaleY = ENVIRONMENT.SILHOUETTE_RING_HEIGHT || [];
    for (let ring = 0; ring < rings; ring++) {
      const mat = new MeshBasicMaterial({ vertexColors: true, fog: true, color: ringColor(ring) });
      const m = new Mesh(mountainGeo, mat);
      m.name = `mountains-${ring}`;
      m.castShadow = false;
      m.receiveShadow = false;
      m.userData.ring = ring;
      m.userData.scaleY = ringScaleY[ring] ?? 1;
      m.scale.y = m.userData.scaleY;
      m.frustumCulled = false;
      silhouettes.add(m);
      mountainMeshes.push(m);
    }

    // 树林剪影：细长三角锥合并，4 个簇 = 4 个 draw call（加山体 3 = 7 ≤ 10）
    const treeMat = new MeshBasicMaterial({ vertexColors: true, fog: true });
    const treeMeshRings = [];
    for (let seg = 0; seg < 4; seg++) {
      const parts = [];
      const baseA = (seg / 4) * Math.PI * 2;
      for (let i = 0; i < 10; i++) {
        const a = baseA + (i / 10) * (Math.PI / 2) * 0.9;
        const r = 40 + (i % 4) * 9;
        const hgt = 7 + (i % 3) * 3;
        parts.push({
          geometry: new ConeGeometry(2.2 + (i % 2), hgt, 4),
          color: 0xffffff,
          shade: 0.9 + (i % 3) * 0.06,
          matrix: placed({ x: Math.cos(a) * r, y: hgt / 2 - 1, z: Math.sin(a) * r }, 0, 1),
        });
      }
      const g = mergeParts(parts).geometry;
      // 树林跟着最近两层山走（别比山还深，否则近景比远景还重）
      const m = new Mesh(g, new MeshBasicMaterial({ vertexColors: true, fog: true, color: ringColor(seg === 0 ? 0 : 1) }));
      m.name = `trees-${seg}`;
      m.castShadow = false;
      m.frustumCulled = false;
      silhouettes.add(m);
      treeMeshRings.push(m);
    }

    // ── ③b 山间雾带（模块 13）：3 条半透明水平环，随相机距离淡入淡出 ──
    //   ⚠ 用 PlaneGeometry 贴地飘在空中不如用"环形带"：环带从任何角度看都是一条横带，
    //      而平面转到侧面会变成一条线、直接消失。
    const mistMeshes = [];
    const mistCount = ENVIRONMENT.MIST_BANDS || 0;
    for (let i = 0; i < mistCount; i++) {
      const radius = ENVIRONMENT.MIST_RADIUS[i] ?? 120;
      const height = ENVIRONMENT.MIST_HEIGHT[i] ?? 26;
      const g = new CylinderGeometry(radius, radius, height, 40, 1, true);
      const m = new Mesh(g, new MeshBasicMaterial({
        color: ENVIRONMENT.MIST_COLOR,
        transparent: true,
        opacity: 0,
        side: DoubleSide,
        depthWrite: false,
        fog: false, // 雾带本身就是"雾的表现"，再吃指数雾会双重变淡
      }));
      m.name = `mist-band-${i}`;
      m.frustumCulled = false;
      m.renderOrder = -0.5;
      m.userData.height = height;
      // ⚠ 位置**只在建好时写一次**（世界固定，不跟随玩家）——
      //   跟随玩家会让"相机到雾带的距离"变成常数，spec 的淡入淡出就成了死代码（见 update 里的说明）。
      //   三条带绕战场中心错开摆放，玩家从地图这头走到那头会真的"穿过"它们。
      const a = (i / mistCount) * Math.PI * 2 + 0.6;
      m.position.set(Math.cos(a) * ENVIRONMENT.MIST_SPREAD, height * 0.55, Math.sin(a) * ENVIRONMENT.MIST_SPREAD);
      silhouettes.add(m);
      mistMeshes.push(m);
    }

    // ── ④ 地面细节法线 ──
    if (ENVIRONMENT.GROUND_DETAIL && world.terrain?.material) {
      try {
        const normalTex = makeDetailNormal();
        world.terrain.material.normalMap = normalTex;
        world.terrain.material.normalScale.x = 0.35;
        world.terrain.material.normalScale.y = 0.35;
        world.terrain.material.needsUpdate = true;
      } catch (_) { /* 贴图失败不致命 */ }
    }

    const sunDir = world.sunDir || { x: 0.4, y: 0.8, z: 0.4 };

    const ringScale = ENVIRONMENT.SILHOUETTE_RING_SCALE || [0.62, 1.0, 1.35];

    function update(playerPos, camera) {
      const px = playerPos?.x ?? 0;
      const pz = playerPos?.z ?? 0;
      sky.position.set(px, 0, pz);
      halo.position.set(px + sunDir.x * 300, sunDir.y * 300, pz + sunDir.z * 300);

      // 剪影环跟随玩家保持在远景距离（三层由近及远）
      for (const m of mountainMeshes) {
        const s = ringScale[m.userData.ring] ?? 1;
        // 几何体本身带绝对坐标（相对原点），整体随玩家平移即可
        m.position.set(px, 0, pz);
        m.userData.dist = ENVIRONMENT.SILHOUETTE_DISTANCE * s;
      }
      for (const m of treeMeshRings) m.position.set(px, 0, pz);

      // ── 雾带：固定在**世界坐标**，不跟随玩家（★模块13 修正）──
      //   ⚠ 这里原来让雾带跟着玩家走，于是"相机到雾带的距离"恒等于 radius − 8m，
      //     是一个**常数** —— spec 要的"随相机距离淡入淡出"在代码里根本不会发生（死代码）。
      //     山体剪影跟着玩家是因为它本质是"无限远的天幕替身"；但雾带是**山间**的雾，
      //     它属于地形 belonging to the world，玩家走过去才该穿过它、看见它变淡。
      if (mistMeshes.length) {
        const cx = camera?.position?.x ?? px;
        const cy = camera?.position?.y ?? 5;
        const cz = camera?.position?.z ?? pz;
        for (let i = 0; i < mistMeshes.length; i++) {
          const m = mistMeshes[i];
          const radius = ENVIRONMENT.MIST_RADIUS[i] ?? 120;
          const h = m.userData.height ?? 26;
          // 位置只在建好时写一次（世界固定），这里只算距离
          const dx = cx - m.position.x;
          const dz = cz - m.position.z;
          const flat = Math.sqrt(dx * dx + dz * dz);
          // 相机在带外 → flat − radius；在带内 → radius − flat（都取非负）
          const d = Math.abs(flat - radius);
          // 再叠上高度差：相机贴着带的高度时是"人在雾里"，也该淡
          const dy = Math.abs(cy - m.position.y);
          const k = smoothstep(ENVIRONMENT.MIST_FADE_NEAR, ENVIRONMENT.MIST_FADE_FAR, d + dy * 0.5);
          m.material.opacity = ENVIRONMENT.MIST_OPACITY * k;
          m.visible = m.material.opacity > 0.01;
        }
      }
    }

    function smoothstep(e0, e1, x) {
      const t = Math.max(0, Math.min(1, (x - e0) / Math.max(1e-6, e1 - e0)));
      return t * t * (3 - 2 * t);
    }

    return {
      root,
      update,
      // 模块 13：把建好的网格挂出来。
      //   理由不是"为了调试"——雾带的不透明度是**每帧在 update 里被重算**的，
      //   外部（探针 / 后续调参工具）拿不到引用就只能靠截图猜"淡入淡出到底生效没有"。
      mountains: mountainMeshes,
      trees: treeMeshRings,
      mistBands: mistMeshes,
      setFogDensity(d) { scene.fog.density = d; },
    };
  } catch (err) {
    console.warn('[environment] 初始化失败，跳过氛围层：', err && err.message);
    return { root: null, update() {}, setFogDensity() {}, mountains: [], trees: [], mistBands: [] };
  }
}
