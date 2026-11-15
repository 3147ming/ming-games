/**
 * 地面材质增强（批五 T1/T2/T3，参考件 game.js 5159-5290 的做法移植）
 *
 * ── 参考件是怎么做的 ────────────────────────────────────
 * 它没有"一张地砖贴图"，而是把地面当成一个**世界坐标的程序化材质**：
 *   · 一张 1024 的唯一遮罩（水洼高度 / 潮湿 / 油渍 / 磨损）—— 大尺度、不重复；
 *   · 一张 512 的细节瓦片（RGBA 通道打包：RGB 噪声 + A 颗粒）—— 小尺度、多频平铺；
 *   · 一张 512 法线 + 一张 2048 的路面标记；
 *   · 粗糙度按"干 0.72 → 潮 0.36~0.56 → 浸 0.1~0.2 → 水 0.055"解析过渡；
 *   · 裂缝/伸缩缝用 fwidth 抗锯齿，放大时切 bicubic 采样。
 *
 * ── 这里移植了哪三条（对应 T1/T2/T3）─────────────────────
 *   T1 通道打包：R/G = 法线 XY、B = 粗糙度、A = 颗粒 —— 一张图喂三种用途；
 *   T2 大尺度遮罩：R = 污渍、G = 磨损、B = 低洼（水洼倾向），世界坐标采样，不随 UV 拉伸；
 *   T3 湿地面：水洼遮罩 + 粗糙度渐变 + 涟漪法线扰动（配合 R4 平面反射）。
 *
 * ── 为什么用 onBeforeCompile 而不是换一套自写材质 ─────────
 * 店里的灯光/雾/阴影都挂在 MeshStandardMaterial 的 shader 上。
 * 自己写 ShaderMaterial 等于把这些全部重做一遍（参考件敢这么做是因为它整套引擎都是自己的）。
 * 这里只在标准材质的三个 include 点后面追加几行 —— 保留 PBR、雾、阴影、色调映射。
 *
 * ⚠ 三条铁律（踩过就不想再踩）：
 *   1) 注入的 uniform 必须在 onBeforeCompile 里挂到 shader.uniforms，不能只挂在材质上；
 *   2) 片元里新声明的变量不要包在 `{}` 里 —— 后续 chunk 还要用（GLSL 块作用域）；
 *   3) 材质共享时要么 clone 再用，要么接受"全场一起湿"（本模块默认调用方 clone）。
 */

import * as THREE from 'three';

/* ============================================================
 *  一、程序化纹理（纯数据，不用 canvas —— 可复现、可单测）
 * ========================================================== */

function hash2(x, y, seed = 0) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t) => t * t * (3 - 2 * t);

/** 值噪声（双线性 + smoothstep），tile 模式保证可无缝平铺 */
function valueNoise(x, y, period, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = smooth(x - xi);
  const fy = smooth(y - yi);
  const wrap = (v) => ((v % period) + period) % period;
  const x0 = wrap(xi);
  const y0 = wrap(yi);
  const x1 = wrap(xi + 1);
  const y1 = wrap(yi + 1);
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

function fbm(x, y, basePeriod, octaves, seed) {
  let v = 0;
  let amp = 0.5;
  let f = 1;
  let sum = 0;
  for (let o = 0; o < octaves; o++) {
    v += valueNoise(x * f, y * f, basePeriod * f, seed + o * 131) * amp;
    sum += amp;
    amp *= 0.5;
    f *= 2;
  }
  return v / sum;
}

/**
 * T1：细节瓦片（RGBA 打包）
 *   R/G = 法线 XY（高度梯度，已编码到 0..1）
 *   B   = 粗糙度（0.35..0.95）
 *   A   = 颗粒（高频，用于压暗/提亮 albedo，让 256px 的地砖不"糊成一片"）
 */
export function buildGroundDetail(size = 512) {
  const data = new Uint8Array(size * size * 4);
  // 高度场先算一遍：法线要跨像素求导，不能边写边读
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * 8;
      const v = (y / size) * 8;
      const coarse = fbm(u, v, 8, 4, 11);
      const fine = fbm(u * 4, v * 4, 32, 3, 23);
      // 砖缝：8×8 格，缝宽很窄（世界尺度上约 2cm）
      const gx = Math.abs(((x / size) * 8) % 1 - 0.5);
      const gy = Math.abs(((y / size) * 8) % 1 - 0.5);
      const joint = Math.min(gx, gy);
      const groove = 1 - Math.min(1, Math.max(0, (0.06 - joint) / 0.06));
      h[y * size + x] = coarse * 0.6 + fine * 0.4 - groove * 0.55;
    }
  }
  const at = (x, y) => h[((y + size) % size) * size + ((x + size) % size)];
  const strength = 2.6;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      // 法线 = normalize(-dx, 1, -dy)，取 XY 存 0..1
      const len = Math.hypot(dx, dy, 1);
      const nx = (-dx / len) * 0.5 + 0.5;
      const ny = (-dy / len) * 0.5 + 0.5;
      const hv = at(x, y);
      // 凹处更粗糙（积灰），凸处更光滑（被踩亮）
      const rough = 0.42 + 0.5 * Math.min(1, Math.max(0, 0.5 - hv * 0.9));
      const grain = fbm((x / size) * 40, (y / size) * 40, 40, 2, 71);
      const i = (y * size + x) * 4;
      data[i] = Math.round(nx * 255);
      data[i + 1] = Math.round(ny * 255);
      data[i + 2] = Math.round(Math.min(1, Math.max(0, rough)) * 255);
      data[i + 3] = Math.round(grain * 255);
    }
  }
  return { data, size };
}

/**
 * T2：大尺度遮罩（世界坐标采样，一张图管整片场地）
 *   R = 污渍覆盖（脚印/油点/口香糖印）
 *   G = 磨损/抛光（走道被踩亮）
 *   B = 低洼（积水倾向）
 */
export function buildGroundMask(size = 512) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * 6;
      const v = (y / size) * 6;
      const blotch = fbm(u, v, 6, 5, 101);
      const streak = fbm(u * 3.5, v * 0.7, 21, 3, 37);   // 拉长的走道磨损
      const dip = fbm(u * 0.8, v * 0.8, 6, 4, 59);
      // 稀疏高值 = 明显污渍（大部分地面应该是干净的）
      const stain = Math.min(1, Math.max(0, (blotch - 0.62) / 0.2));
      const i = (y * size + x) * 4;
      data[i] = Math.round(stain * 255);
      data[i + 1] = Math.round(Math.min(1, Math.max(0, (streak - 0.35) / 0.4)) * 255);
      data[i + 2] = Math.round(Math.min(1, Math.max(0, (dip - 0.2) / 0.6)) * 255);
      data[i + 3] = 255;
    }
  }
  return { data, size };
}

/** 建 DataTexture（mipmap + 重复 + 各向异性；不做 sRGB 转换 —— 存的是数据不是颜色） */
export function makeDataTexture(built, anisotropy = 4) {
  const tex = new THREE.DataTexture(built.data, built.size, built.size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

/* ============================================================
 *  二、材质注入
 * ========================================================== */

const VERT_DECL = /* glsl */`
varying vec3 vGWorldG;
`;

const FRAG_DECL = /* glsl */`
uniform sampler2D uGDetail;
uniform sampler2D uGMask;
uniform float uGWet;
uniform float uGTime;
uniform float uGOutdoor;
uniform float uGReflOn;
uniform sampler2D uGRefl;
uniform mat4 uGReflMatrix;
uniform vec3 uGDoor;
varying vec3 vGWorldG;
// 这些是跨 chunk 共用的中间量：必须声明在 main 作用域（不能包在 {} 里）
float gGrain;
float gPuddle;
float gStain;
vec4  gDA;
vec4  gDB;
`;

/** 在 map_fragment 之后：颗粒 / 污渍 / 水洼变暗 */
const FRAG_MAP = /* glsl */`
{
  vec2 gxp = vGWorldG.xz;
  gDA = texture2D(uGDetail, gxp * 0.42);
  gDB = texture2D(uGDetail, gxp * 1.70 + 0.31);
  gGrain = gDA.a * 0.55 + gDB.a * 0.45;
  vec4 gMask = texture2D(uGMask, gxp * 0.055);
  gStain = gMask.r;
  float gLow = gMask.b;
  /* 室外 = 低洼积水；室内 = 只有门口一带被顾客踩进来的雨水（其余地方顶多是"潮"）。
   * 两者共用同一个 uGWet（主题驱动）：0 = 全干，1 = 大雨。 */
  float gPuddleOut = smoothstep(0.52, 0.86, gLow * 0.8 + (gGrain - 0.5) * 0.22 + uGWet * 0.42);
  float gDoorW = 1.0 - smoothstep(0.0, 4.5, distance(vGWorldG.xz, uGDoor.xz));
  float gPuddleIn = gDoorW * smoothstep(0.35, 0.9, uGWet) * smoothstep(0.30, 0.72, gLow * 0.55 + gGrain * 0.55);
  float gWetGate = smoothstep(0.05, 0.35, uGWet);
  gPuddle = mix(gPuddleIn, gPuddleOut * gWetGate, uGOutdoor);

  diffuseColor.rgb *= 0.86 + 0.26 * gGrain;
  diffuseColor.rgb *= 1.0 - 0.28 * gStain;
  // 磨损：走道被踩亮（轻微去饱和 + 提亮）
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.12 + 0.02, gMask.g * 0.35);
  // 水面会吸收一部分漫反射（不是变白，而是变深）
  diffuseColor.rgb *= mix(1.0, 0.62, gPuddle);
}
`;

/** 覆盖 roughnessmap_fragment：细节粗糙度 + 水洼镜面 */
const FRAG_ROUGH = /* glsl */`
float roughnessFactor = mix(gDA.b, gDB.b, 0.35);
roughnessFactor = clamp(roughnessFactor - gStain * 0.06, 0.18, 0.98);
roughnessFactor = mix(roughnessFactor, 0.055, gPuddle);
`;

/** 在 normal_fragment_maps 之后：用打包 R/G 扰动法线（地面朝上，世界法线可直接转视空间） */
const FRAG_NORMAL = /* glsl */`
{
  vec2 gN = (vec2(gDA.r, gDA.g) - 0.5) * 2.0;
  vec3 wn = normalize(vec3(gN.x * 0.55, 1.0, gN.y * 0.55));
  // 水洼表面：高频涟漪（两条反向行进的正弦，足够碎）
  float rip = gPuddle * smoothstep(0.03, 0.16, uGWet);
  wn.x += sin(vGWorldG.x * 23.0 + uGTime * 3.4) * 0.045 * rip;
  wn.z += cos(vGWorldG.z * 19.0 - uGTime * 2.9) * 0.045 * rip;
  wn = normalize(wn);
  normal = normalize(mat3(viewMatrix) * wn);
}
`;

/** 水洼处的环境反射：按 Fresnel 混入平面反射贴图（R4 提供；未开启时 uGReflOn=0）
 *
 * ⚠ 注入点是 `lights_fragment_end`，此处 **`outgoingLight` 还不存在** ——
 *   three r160 里它是 `output_fragment` 才声明的（`reflectedLight.directDiffuse + ...`），
 *   在这里写 `outgoingLight = ...` 会直接 `'outgoingLight' : undeclared identifier`
 *   → 整个 program 无效 → useProgram 报错 → 地面（连同整屏）画不出来。
 *   所以改成调制 `reflectedLight`：水洼把漫反射压下去、把反射加进间接高光，
 *   等 `output_fragment` 把它们加起来时，效果与"直接改 outgoingLight"完全等价。 */
const FRAG_REFL = /* glsl */`
{
  if (uGReflOn > 0.5 && gPuddle > 0.01) {
    vec4 rp = uGReflMatrix * vec4(vGWorldG, 1.0);
    vec2 ruv = rp.xy / max(rp.w, 1e-4);
    ruv += vec2(gDA.r, gDA.g) * 0.004;                  // 涟漪扰动 UV
    vec3 refl = texture2D(uGRefl, ruv).rgb;
    vec3 vdir = normalize(cameraPosition - vGWorldG);
    float fres = pow(1.0 - clamp(vdir.y, 0.0, 1.0), 3.0);
    float k = gPuddle * mix(0.25, 0.9, fres);
    float keep = 1.0 - k * 0.55;
    reflectedLight.directDiffuse *= keep;
    reflectedLight.indirectDiffuse *= keep;
    reflectedLight.directSpecular *= (1.0 - k);
    reflectedLight.indirectSpecular = reflectedLight.indirectSpecular * (1.0 - k) + refl * k * 1.1;
  }
}
`;

/**
 * 把地面细节注入一个 MeshStandardMaterial。
 * ⚠ 调用方应先 clone（共享材质会被全场一起改）。
 * @param material  MeshStandardMaterial
 * @param opts      { detail, mask, outdoor, wet, reflTex }
 * @returns { uniforms, setWet, setReflection, setTime }
 */
export function applyGroundDetail(material, opts = {}) {
  const uniforms = {
    uGDetail: { value: opts.detail ?? null },
    uGMask: { value: opts.mask ?? null },
    uGWet: { value: Number.isFinite(opts.wet) ? opts.wet : 0.25 },
    uGTime: { value: 0 },
    uGOutdoor: { value: opts.outdoor ? 1 : 0 },
    uGReflOn: { value: 0 },
    uGRefl: { value: opts.reflTex ?? null },
    uGReflMatrix: { value: new THREE.Matrix4() },
    uGDoor: { value: new THREE.Vector3(opts.door?.x ?? 0, 0, opts.door?.z ?? 0) },
  };

  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (typeof prev === 'function') prev.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_DECL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n  vGWorldG = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_DECL}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${FRAG_MAP}`)
      .replace('#include <roughnessmap_fragment>', FRAG_ROUGH)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${FRAG_NORMAL}`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${FRAG_REFL}`);
  };
  material.customProgramCacheKey = () => 'ns-ground-v1';
  material.needsUpdate = true;

  return {
    uniforms,
    setWet(v) { uniforms.uGWet.value = Math.max(0, Math.min(1, v)); },
    setTime(t) { uniforms.uGTime.value = t; },
    setReflection(tex, matrix) {
      uniforms.uGRefl.value = tex ?? null;
      uniforms.uGReflOn.value = tex ? 1 : 0;
      if (tex && matrix) uniforms.uGReflMatrix.value.copy(matrix);
    },
    dispose() { uniforms.uGDetail.value = null; uniforms.uGMask.value = null; uniforms.uGRefl.value = null; },
  };
}

/* ============================================================
 *  三、平面反射（R4）
 * ========================================================== */

/**
 * 平面反射：把相机按 y = height 镜像，渲染一次场景到半分辨率 RT。
 *
 * 为什么要"斜近裁剪面"（oblique near plane）：
 *   镜像相机在平面以下的物体会被拍到（比如地板自身的背面），
 *   在反射图里表现为"水面上浮着一层脏东西"。把近裁剪面压到镜面上就能干净剔除。
 *   做法是把投影矩阵第三行替换成镜面平面方程（Lengyel 的经典技巧）。
 *
 * @returns { texture, matrix, render(), setEnabled, stats }
 */
export function createPlanarReflection(renderer, scene, camera, opts = {}) {
  const scale = Math.max(0.25, Math.min(1, opts.scale ?? 0.5));
  const height = Number.isFinite(opts.height) ? opts.height : 0;
  let enabled = !!opts.enabled;
  let rendered = 0;

  const rt = new THREE.WebGLRenderTarget(4, 4, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: true,
    stencilBuffer: false,
  });
  rt.texture.wrapS = THREE.ClampToEdgeWrapping;
  rt.texture.wrapT = THREE.ClampToEdgeWrapping;

  const mirrorCam = new THREE.PerspectiveCamera();
  mirrorCam.matrixAutoUpdate = true;
  const mirrorPos = new THREE.Vector3();
  const target = new THREE.Vector3();
  const look = new THREE.Vector3();
  const bias = new THREE.Matrix4().set(
    0.5, 0, 0, 0.5,
    0, 0.5, 0, 0.5,
    0, 0, 0.5, 0.5,
    0, 0, 0, 1,
  );
  const texMatrix = new THREE.Matrix4();
  let hidden = [];
  let broken = false;

  // 斜近裁剪面用的临时量（避免每次分配）
  const _plane = new THREE.Plane();
  const _clip = new THREE.Vector4();
  const _q = new THREE.Vector4();
  const _normal = new THREE.Vector3(0, 1, 0);

  function syncSize() {
    const dbs = renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(64, Math.round(dbs.x * scale));
    const h = Math.max(64, Math.round(dbs.y * scale));
    if (rt.width !== w || rt.height !== h) rt.setSize(w, h);
  }

  function render() {
    if (!enabled || broken) return false;
    syncSize();
    const camPos = camera.getWorldPosition(new THREE.Vector3());
    // 相机在镜面下方（比如掉进池塘）就别反射了，否则会拍到"地下世界"
    if (camPos.y <= height + 0.02) return false;

    // 镜像相机：位置沿 y 翻转，朝向也把注视点翻转
    mirrorPos.set(camPos.x, 2 * height - camPos.y, camPos.z);
    camera.getWorldDirection(look);
    target.copy(camPos).add(look);
    target.y = 2 * height - target.y;

    mirrorCam.position.copy(mirrorPos);
    mirrorCam.up.set(0, 1, 0);
    mirrorCam.lookAt(target);
    mirrorCam.fov = camera.fov;
    mirrorCam.aspect = camera.aspect;
    mirrorCam.near = camera.near;
    mirrorCam.far = camera.far;
    mirrorCam.updateProjectionMatrix();
    mirrorCam.updateMatrixWorld(true);
    mirrorCam.matrixWorldInverse.copy(mirrorCam.matrixWorld).invert();

    // 斜近裁剪面（Lengyel）：把近平面压到镜面上，剔除镜面以下的内容
    _plane.setFromNormalAndCoplanarPoint(_normal, new THREE.Vector3(0, height, 0));
    _plane.applyMatrix4(mirrorCam.matrixWorldInverse);
    _clip.set(_plane.normal.x, _plane.normal.y, _plane.normal.z, _plane.constant);
    const P = mirrorCam.projectionMatrix.elements;
    _q.x = (Math.sign(_clip.x) + P[8]) / P[0];
    _q.y = (Math.sign(_clip.y) + P[9]) / P[5];
    _q.z = -1;
    _q.w = (1 + P[10]) / P[14];
    const dot = _clip.x * _q.x + _clip.y * _q.y + _clip.z * _q.z + _clip.w * _q.w;
    if (Math.abs(dot) > 1e-6) {
      const k = 2 / dot;
      P[2] = _clip.x * k;
      P[6] = _clip.y * k;
      P[10] = _clip.z * k + 1;
      P[14] = _clip.w * k;
    }
    mirrorCam.projectionMatrixInverse.copy(mirrorCam.projectionMatrix).invert();

    // 屏幕 UV 投影矩阵：裁剪空间 → [0,1]
    texMatrix.copy(bias).multiply(mirrorCam.projectionMatrix).multiply(mirrorCam.matrixWorldInverse);

    // 把透明/特效物体在反射里隐藏（水面自身、粒子、UI 面片）—— 否则会自激/穿帮
    hidden = [];
    scene.traverse((o) => {
      if (o.userData?.noReflect && o.visible) { hidden.push(o); o.visible = false; }
    });
    const prevTarget = renderer.getRenderTarget();
    /* 反射遍不要再更新阴影图：three 每次 render() 都会重跑一遍 shadow pass，
     * 而反射里那点阴影本来就被水面搅碎了，白花一倍开销。
     * 这里只关 autoUpdate（不动 shadowMap.enabled —— 那会改 program 的 define，
     * 每帧开关等于每帧重编着色器）。主 pass 之前会恢复。 */
    const sm = renderer.shadowMap;
    const prevAuto = sm ? sm.autoUpdate : undefined;
    if (sm) sm.autoUpdate = false;
    try {
      renderer.setRenderTarget(rt);
      renderer.clear();
      renderer.render(scene, mirrorCam);
      rendered++;
    } catch (e) {
      broken = true;                       // 反射挂掉就永久关掉，绝不每帧抛异常
      console.warn('[ground] 平面反射失败，已关闭：', e);
    } finally {
      if (sm && prevAuto !== undefined) sm.autoUpdate = prevAuto;
      for (const o of hidden) o.visible = true;
      renderer.setRenderTarget(prevTarget ?? null);
    }
    return !broken;
  }

  function setEnabled(v) { enabled = v === true; }

  return {
    get texture() { return rt.texture; },
    get matrix() { return texMatrix; },
    get enabled() { return enabled && !broken; },
    render,
    setEnabled,
    stats: () => ({ enabled: enabled && !broken, width: rt.width, height: rt.height, rendered }),
    dispose() { rt.dispose(); },
  };
}
