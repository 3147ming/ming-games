/**
 * 后处理：自实现的 Bloom 泛光（需求G 第②条）
 *
 * 为什么不用 UnrealBloomPass：
 *   项目的 vendor/ 只放了一个 three.module.js（ADR-004：零外部资源、无构建步骤）。
 *   three 的官方后处理住在 examples/jsm/ 下，引入它就要么加 CDN 依赖、
 *   要么把整个 addons 目录搬进 vendor —— 前者破坏离线可跑，后者破坏"单文件 vendor"。
 *   所以这里用最朴素的思路自己实现：**阈值提亮 → 多次降采样高斯模糊 → 加法叠加**。
 *
 * 算法（四步，全部在 GPU 上跑）：
 *   1) brightnessPass：把场景渲染到 RT，同时提取亮度 > threshold 的部分（保留颜色）
 *   2) blurPass ×N：逐级 1/2 降采样 + 横向/纵向分离高斯（9 tap），得到 N 张越来越糊的图
 *   3) compositePass：原图 + Σ(模糊层 × 权重) × strength
 *   4) 输出到屏幕
 *
 * 性能取舍：
 *   · 降采样到 1/2、1/4、1/8 三级，总像素量只比原图多 ~33%，比"全分辨率模糊"省 4 倍以上
 *   · 每级用 9 tap 分离卷积代替 81 tap 二维卷积（O(n) 而非 O(n²)）
 *   · 关闭 mips（mips=0）时不分配 RT，直接透传 —— 低配可以一键退化为无泛光
 *
 * 为什么用 HalfFloatType：
 *   霓虹亮度会超过 1.0（emissiveIntensity 叠乘后常见 1.5~3），
 *   用 8bit RT 会在提取阈值前就被截断到白色，泛光只剩一片死白、丢失颜色。
 *   注意 HalfFloat 不是所有环境都可写，构造时会探测，不支持自动退 8bit（见 detectPixelType）。
 *
 * ⚠ 三个曾经导致「整屏全黑」的坑，改这个文件前务必知道（ADR-005）：
 *   1) RT 尺寸：RT 必须跟 drawingBuffer 同尺寸。只靠外部调 setSize 是不够的 ——
 *      本世纪初版本就是没人调它，RT 停在 1×1，整屏等于显示"全场景平均色"（夜景下≈黑）。
 *      所以 render() 里加了 syncSize() 自检，即使调用方忘了也不会黑屏。
 *   2) 深度缓冲：场景 RT 必须带 depthBuffer。three 的不透明物体是**由近到远**排序绘制的，
 *      没有深度测试时，最后画的"最远的墙"会盖住整个屏幕 —— 表现同样是黑屏。
 *   3) 颜色空间：three 只在渲染到**画布**时自动做 sRGB 编码，渲染到 RT 时输出的是线性值
 *      （vendor/three.module.js: `outputColorSpace = currentRenderTarget===null ? … : LinearSRGBColorSpace`）。
 *      而这三个 pass 都是手写 ShaderMaterial，three 不会给它注入任何颜色空间转换。
 *      于是合成要把线性值直接写进画布 —— 暗部被二次压暗，夜景直接变黑。
 *      所以 composite 里必须自己做 linear→sRGB 的 OETF（见 FRAG_COMPOSITE 末尾）。
 */

import * as THREE from 'three';
import { LIGHTING } from './art.mjs';

/* ---------- 着色器 ---------- */

/** 全屏三角/四边形的顶点着色器（固定不变） */
const VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * 亮度提取：只留下超过阈值的像素，并做软膝盖（knee）过渡。
 * 为什么不做硬截断：硬阈值会让霓虹边缘出现一圈"突然出现"的生硬亮边，
 * 软膝盖让亮度在阈值附近平滑淡入，泛光看起来是"晕开"而不是"贴上去"。
 */
const FRAG_BRIGHT = /* glsl */`
uniform sampler2D tDiffuse;
uniform float threshold;
uniform float knee;
varying vec2 vUv;

void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // 软膝盖：luma 在 [threshold-knee, threshold+knee] 之间线性过渡
  float soft = clamp(luma - threshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-5);
  float w = max(soft, luma - threshold) / max(luma, 1e-5);
  gl_FragColor = vec4(c * clamp(w, 0.0, 1.0), 1.0);
}
`;

/**
 * 分离高斯模糊（横向 / 纵向共用一份代码，靠 direction 切换）。
 * 9 tap，权重用标准高斯核 σ≈2.2 的离散采样。
 */
const FRAG_BLUR = /* glsl */`
uniform sampler2D tDiffuse;
uniform vec2 direction;   // (1/w, 0) 横向； (0, 1/h) 纵向
varying vec2 vUv;

void main() {
  // 9 点高斯核（归一化后）
  float w0 = 0.2270270270;
  float w1 = 0.1945945946;
  float w2 = 0.1216216216;
  float w3 = 0.0540540541;
  float w4 = 0.0162162162;

  vec3 sum = texture2D(tDiffuse, vUv).rgb * w0;
  sum += texture2D(tDiffuse, vUv + direction * 1.0).rgb * w1;
  sum += texture2D(tDiffuse, vUv - direction * 1.0).rgb * w1;
  sum += texture2D(tDiffuse, vUv + direction * 2.0).rgb * w2;
  sum += texture2D(tDiffuse, vUv - direction * 2.0).rgb * w2;
  sum += texture2D(tDiffuse, vUv + direction * 3.0).rgb * w3;
  sum += texture2D(tDiffuse, vUv - direction * 3.0).rgb * w3;
  sum += texture2D(tDiffuse, vUv + direction * 4.0).rgb * w4;
  sum += texture2D(tDiffuse, vUv - direction * 4.0).rgb * w4;

  gl_FragColor = vec4(sum, 1.0);
}
`;

/**
 * 合成：原图 + 各级模糊图按权重叠加，最后做**调色**（亮度 / 伽马 / 暗角）。
 * 权重随 mip 层级递减（模糊得越厉害、贡献越小），
 * 这样近处是紧致的亮边、远处是大范围的光雾，符合真实泛光的观感。
 *
 * 调色为什么做在这一步（而不是加一个新 pass）：
 *   它是纯 2D 的全屏运算，且输入已经是"最终颜色"，正好复用这张已经在上屏的全屏四边形 ——
 *   再加一个 pass 只会多一次 RT 往返，收益为零。
 * 顺序也重要：亮度/伽马必须在 linear→sRGB **之前**（在屏幕空间做调色会压坏暗部），
 *   暗角在最后乘（它是纯亮度衰减，对已编码的颜色同样成立，且能压住 UI 边缘的刺眼感）。
 */
const FRAG_COMPOSITE = /* glsl */`
uniform sampler2D tDiffuse;
uniform sampler2D tBlur0;
uniform sampler2D tBlur1;
uniform sampler2D tBlur2;
uniform float strength;
uniform float w0;
uniform float w1;
uniform float w2;
uniform int mipCount;
/* --- 设置页的调色（需求：亮度/伽马 + 轻微暗角） --- */
uniform float brightness;
uniform float gammaInv;    // 1/gamma，预先在 CPU 端算好，省掉片元里的除法
uniform float vignette;    // 0 = 关闭
/* --- 批五 R1/R2：电影级调色链 + 眼适应 --- */
uniform sampler2D tAdapt;  // 1×1，时间性平均亮度（0..1 感知域）
uniform float uAdaptOn;    // 0 = 不做眼适应（低端/关闭）
uniform float uExposure;   // 手动曝光（设置页以外基本恒 1）
uniform float uLook;       // 0..1 调色链强度（0 = 退回旧观感）
uniform float uSaturation;
uniform float uGrain;
uniform float uSharpen;
uniform float uToneMix;    // 0 = 纯 ACES，1 = 纯 AgX（参考件的做法：两者混合）
uniform float uTime;
uniform vec2 uTexel;
varying vec2 vUv;

// 线性 → sRGB 的 OETF（分段函数，标准 sRGB 传递曲线）
// 为什么必须手写：见文件头 ADR-005 第 3 条 —— rtScene 里存的是线性值，
// three 不会给手写 ShaderMaterial 注入颜色空间转换，漏掉这步整个暗场景会被压成黑屏。
vec3 linearToSRGB(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = pow(max(c, vec3(1e-5)), vec3(1.0 / 2.4)) * 1.055 - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

/* ACES（Hill 拟合）：高光滚到白而不是硬切。
 * 旧链路是在 1.0 处直接 clamp —— 霓虹一亮就变成"纯白方块"，这是手机夜景最假的地方。 */
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

/* AgX（Björn Ottosson 的紧凑近似）：高光掉到白的时候**色相不漂移**。
 * ACES 会把亮青色霓虹一路推成白色（六边形色相翻转），而夜景的主角就是霓虹；
 * AgX 只降饱和、守住色相，代价是整体略"灰"。所以这里不换、而是**混**：
 *   tone = mix(aces, agx, uToneMix)，默认 0.28 —— 高光色相被拉回来，
 *   同时保留 ACES 的对比度，不至于把整场压成一张灰片。 */
vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 agx(vec3 v) {
  const mat3 toAgx = mat3(
    0.842479062253094, 0.0423282422610123, 0.0423756549057051,
    0.0784335999999992, 0.878468636469772, 0.0784336,
    0.0792237451477643, 0.0791661274605434, 0.879142973793104
  );
  const mat3 fromAgx = mat3(
    1.19687900512017, -0.0528968517574562, -0.0529716355144438,
    -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
    -0.0990297440797205, -0.0989611768448433, 1.15107367264116
  );
  v = toAgx * max(v, vec3(0.0));
  v = agxContrast(v);
  return clamp(fromAgx * v, 0.0, 1.0);
}

/* 分裂色：暗部偏青、高光偏暖。夜景里这一步比"提高饱和度"有效得多 ——
 * 它给的是"颜色关系"，不是"颜色多少"。 */
vec3 splitTone(vec3 c) {
  float l = luma(c);
  vec3 sh = vec3(0.92, 1.01, 1.08);
  vec3 hi = vec3(1.06, 1.0, 0.93);
  return c * mix(sh, hi, smoothstep(0.05, 0.6, l));
}

/* 颗粒：用屏幕坐标 + 时间的哈希（不用噪声贴图，零资源） */
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  /* 锐化：4 邻域 unsharp。放在最前面（在原始 HDR 上做），
   * 放到 sRGB 之后会把噪点一起放大成"颗粒感过头的假清晰"。 */
  vec3 base = texture2D(tDiffuse, vUv).rgb;
  if (uSharpen > 0.001) {
    vec3 nb = texture2D(tDiffuse, vUv + vec2(uTexel.x, 0.0)).rgb
            + texture2D(tDiffuse, vUv - vec2(uTexel.x, 0.0)).rgb
            + texture2D(tDiffuse, vUv + vec2(0.0, uTexel.y)).rgb
            + texture2D(tDiffuse, vUv - vec2(0.0, uTexel.y)).rgb;
    base += (base - nb * 0.25) * uSharpen;
  }

  vec3 bloom = vec3(0.0);
  bloom += texture2D(tBlur0, vUv).rgb * w0;
  if (mipCount > 1) bloom += texture2D(tBlur1, vUv).rgb * w1;
  if (mipCount > 2) bloom += texture2D(tBlur2, vUv).rgb * w2;
  vec3 hdr = base + bloom * strength;

  /* R2 眼适应：亮度低 → 提曝光；亮度高 → 压曝光。
   * 上下限收得很紧（0.72..1.5）：这是"深夜进店/出街"的呼吸感，
   * 不是真的相机自动曝光 —— 放太开会让画面一直忽明忽暗地"喘气"。 */
  float adapt = texture2D(tAdapt, vec2(0.5)).r;
  float autoExp = clamp(0.30 / max(adapt, 0.04), 0.72, 1.5);
  float expo = uExposure * mix(1.0, autoExp, uAdaptOn);
  hdr *= expo;

  /* R1 调色链（线性域）：ACES/AgX 混合 → 分裂色 → S 曲线 → 提黑 → 饱和度 */
  vec3 graded = mix(aces(hdr), agx(hdr), clamp(uToneMix, 0.0, 1.0));
  graded = splitTone(graded);
  graded = mix(graded, graded * graded * (3.0 - 2.0 * graded), 0.16);
  graded += vec3(0.004, 0.006, 0.009);          // 抬一点黑位，避免"死黑一片"
  graded = mix(vec3(luma(graded)), graded, uSaturation);

  vec3 col = mix(clamp(hdr, 0.0, 1.0), graded, uLook);

  /* 亮度 + 伽马：直接解决"深夜太黑"（需求原话）。
   * 上限放到 4.0 再收敛，避免亮度拉满时中间调被 1.0 硬截断成一片死白。 */
  col = clamp(col * brightness, 0.0, 4.0);
  col = pow(max(col, vec3(0.0)), vec3(gammaInv));

  /* 暗角：以画面中心为原点做径向衰减，聚焦店铺中央。
   * inner/outer 取 0.35/1.0：四角（半径 0.707）只压到约 0.43 的系数，
   * 属于"轻微"级别 —— 再深就会让人误以为屏幕坏了。
   * 强度 0 时 mix 直接退回 1.0，等价于整条暗角被关掉。 */
  float d = distance(vUv, vec2(0.5));
  float vig = mix(1.0, 1.0 - smoothstep(0.35, 1.0, d), clamp(vignette, 0.0, 1.0));

  /* R1 颗粒：在 sRGB 编码前加（模拟胶片颗粒，同时掩盖 8bit 色带） */
  if (uGrain > 0.0001) {
    float g = hash21(vUv * vec2(1920.0, 1080.0) + fract(uTime) * 37.0) - 0.5;
    col += g * uGrain;
  }

  /* linearToSRGB 必须**留在这一行**：ADR-005 第 ③ 条 —— 手写 shader 上屏漏掉
   * linear→sRGB 会让整屏发黑（与"主循环没起来"的症状一模一样，极难排查）。
   * postfx.test 对这条有正则断言守护，重构时别把它拆成中间变量。 */
  gl_FragColor = vec4(linearToSRGB(col) * vig, 1.0);
}
`;

/**
 * 眼适应用的降采样亮度 pass：从最小的模糊层里取 3×3 个点求平均，
 * 再用 tPrev 做时间性平滑（τ≈1.2s）。输出 1×1 的 R 通道。
 */
const FRAG_ADAPT = /* glsl */`
uniform sampler2D tSrc;
uniform sampler2D tPrev;
uniform float uRate;
varying vec2 vUv;

void main() {
  vec3 sum = vec3(0.0);
  for (int j = 0; j < 3; j++) {
    for (int i = 0; i < 3; i++) {
      vec2 uv = (vec2(float(i), float(j)) + 0.5) / 3.0;
      sum += texture2D(tSrc, uv).rgb;
    }
  }
  vec3 c = sum / 9.0;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  /* 感知化：线性亮度直接做曝光会"暗部一动就过曝"，
   * 先压到 0..4 再开 1/2.2 次方，接近人眼对亮度的响应。 */
  l = pow(clamp(l / 4.0, 0.0, 1.0), 0.4545);
  float prev = texture2D(tPrev, vec2(0.5)).r;
  float outL = mix(prev, l, clamp(uRate, 0.0, 1.0));
  gl_FragColor = vec4(outL, 0.0, 0.0, 1.0);
}
`;

/* ---------- 实现 ---------- */

/**
 * 创建一个 Bloom 后处理器。
 *
 * @param renderer THREE.WebGLRenderer
 * @param opts     { threshold, strength, knee, mips }  —— 默认取 art.LIGHTING.bloom
 * @returns { enabled, render, setSize, dispose, uniforms, stats }
 *
 * 用法（main.mjs）：
 *   const bloom = createBloom(renderer);
 *   // 每帧：
 *   bloom.render(scene, camera);
 *   // 尺寸变化：
 *   bloom.setSize(w, h);
 */
export function createBloom(renderer, opts = {}) {
  const cfg = LIGHTING.bloom;
  const threshold = opts.threshold ?? cfg.threshold;
  const strength = opts.strength ?? cfg.strength;
  let mips = Math.max(0, Math.min(3, opts.mips ?? cfg.mips));
  // 膝盖宽度取阈值的 40%，是"刚好不硬"的经验值
  const knee = opts.knee ?? threshold * 0.4;

  // 全屏四边形：用一个覆盖 NDC 的三角形，比两个三角形少一次光栅化边界
  const geo = new THREE.PlaneGeometry(2, 2);
  const quadScene = new THREE.Scene();
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(geo, null);
  quad.frustumCulled = false;
  quadScene.add(quad);

  const uniforms = {
    bright: {
      tDiffuse: { value: null },
      threshold: { value: threshold },
      knee: { value: knee },
    },
    blur: { tDiffuse: { value: null }, direction: { value: new THREE.Vector2() } },
    composite: {
      tDiffuse: { value: null },
      tBlur0: { value: null },
      tBlur1: { value: null },
      tBlur2: { value: null },
      strength: { value: strength },
      w0: { value: 0.55 },
      w1: { value: 0.30 },
      w2: { value: 0.18 },
      mipCount: { value: mips },
      /* 调色（设置页可调）：默认中性 —— 不改任何观感，直到 main 按设置写入 */
      brightness: { value: 1.0 },
      gammaInv: { value: 1.0 },
      vignette: { value: 0 },
      /* 批五 R1/R2 */
      tAdapt: { value: null },
      uAdaptOn: { value: 1 },
      uExposure: { value: 1 },
      uLook: { value: 1 },
      uSaturation: { value: 1.06 },
      uGrain: { value: 0.012 },
      uSharpen: { value: 0.12 },
      uToneMix: { value: 0.28 },
      uTime: { value: 0 },
      uTexel: { value: new THREE.Vector2(1, 1) },
    },
    adapt: {
      tSrc: { value: null },
      tPrev: { value: null },
      uRate: { value: 0.05 },
    },
  };

  const matBright = new THREE.ShaderMaterial({
    uniforms: uniforms.bright,
    vertexShader: VERT,
    fragmentShader: FRAG_BRIGHT,
    depthTest: false,
    depthWrite: false,
  });
  const matBlur = new THREE.ShaderMaterial({
    uniforms: uniforms.blur,
    vertexShader: VERT,
    fragmentShader: FRAG_BLUR,
    depthTest: false,
    depthWrite: false,
  });
  const matComposite = new THREE.ShaderMaterial({
    uniforms: uniforms.composite,
    vertexShader: VERT,
    fragmentShader: FRAG_COMPOSITE,
    depthTest: false,
    depthWrite: false,
  });
  const matAdapt = new THREE.ShaderMaterial({
    uniforms: uniforms.adapt,
    vertexShader: VERT,
    fragmentShader: FRAG_ADAPT,
    depthTest: false,
    depthWrite: false,
  });

  /**
   * 探测当前环境能不能"渲染到 HalfFloat RT"。
   *
   * 为什么不能只看扩展名：SwiftShader / 部分移动 GPU 虽然报告支持，
   * 实际 framebuffer 会 INCOMPLETE，画进去静默全黑。
   * 所以这里真的绑一张 4×4 的 RT 用 checkFramebufferStatus 验一次。
   * 探测失败就退 UnsignedByteType：>1.0 的霓虹会被截断，但至少不会黑屏。
   */
  function detectPixelType() {
    const fallback = THREE.UnsignedByteType;
    if (typeof THREE.HalfFloatType !== 'number') return fallback;
    let rt = null;
    try {
      rt = makeRT(4, 4, THREE.HalfFloatType, true);
      const prev = renderer.getRenderTarget ? renderer.getRenderTarget() : null;
      renderer.setRenderTarget(rt);
      const gl = renderer.getContext ? renderer.getContext() : null;
      if (!gl) return fallback; // 没有 GL 句柄（Node 桩环境）时按支持处理，不影响逻辑
      const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      renderer.setRenderTarget(prev ?? null);
      return complete ? THREE.HalfFloatType : fallback;
    } catch {
      return fallback;
    } finally {
      try { rt?.dispose(); } catch { /* 探测用 RT 释放失败不影响主流程 */ }
    }
  }

  const pixelType = detectPixelType();

  /**
   * 场景 RT 的多重采样数。
   * 为什么必须要：一旦走离屏渲染，renderer 自己的 MSAA（antialias:true）就失效了，
   * 画面会明显变"毛边"。这里让场景 RT 自带 4×MSAA，由 three 在首尾自动做 resolve。
   * WebGL1 没有原生 MSAA RT，给 0（tree 也会忽略）。
   */
  const msaa = (opts.samples ?? 4) > 0 && renderer.capabilities?.isWebGL2 !== false
    ? Math.min(4, opts.samples ?? 4)
    : 0;

  /** 建一张 RT。像素类型统一用探测结果；场景 RT 需要深度和 MSAA，模糊链不需要。 */
  function makeRT(w, h, type = pixelType, depth = false, samples = 0) {
    const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type,
      depthBuffer: depth,
      stencilBuffer: false,
      samples,
    });
    rt.texture.wrapS = THREE.ClampToEdgeWrapping;
    rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    return rt;
  }

  let size = new THREE.Vector2(1, 1);
  /** 场景 RT（保存"原图"）—— 必须带深度缓冲，否则远处物体会盖住整个画面（ADR-005 第 2 条） */
  let rtScene = null;
  /** 各级模糊 RT：ha/hb 两张乒乓交替，避免读写同一张 */
  const rtBlurA = [];
  const rtBlurB = [];
  /** 批五 R2：眼适应 1×1 乒乓（A→B→A）。尺寸与窗口无关，只在初始化时建一次 */
  const rtAdapt = [];
  let adaptFlip = 0;
  let adaptRate = 0.05;
  let adaptFrames = 0;
  /** 批五 R1/R2：累计时间（颗粒抖动 + 眼适应共用）。漏声明过一版 —— 严格模式下
   *  每帧 render 都会抛 ReferenceError，表现成画面卡在最后一帧。 */
  let adaptTime = 0;

  function allocate(w, h) {
    size.set(w, h);
    rtScene?.dispose();
    rtScene = makeRT(w, h, pixelType, true, msaa);
    if (!rtAdapt[0]) {
      rtAdapt[0] = makeRT(1, 1);
      rtAdapt[1] = makeRT(1, 1);
    }
    // 模糊层逐级减半
    for (let i = 0; i < 3; i++) {
      rtBlurA[i]?.dispose();
      rtBlurB[i]?.dispose();
      rtBlurA[i] = null;
      rtBlurB[i] = null;
    }
    let mw = w;
    let mh = h;
    for (let i = 0; i < mips; i++) {
      mw = Math.max(1, Math.floor(mw / 2));
      mh = Math.max(1, Math.floor(mh / 2));
      rtBlurA[i] = makeRT(mw, mh);
      rtBlurB[i] = makeRT(mw, mh);
    }
  }

  /** 运行时调整泛光层级（P0-3 低端机自动降级用）：0 = 直出（无泛光，绝不黑屏）。 */
  function setMips(n) {
    n = Math.max(0, Math.min(3, Math.round(n)));
    if (n === mips) return;
    mips = n;
    uniforms.composite.mipCount.value = mips;
    allocate(size.x, size.y); // 重建模糊链（与尺寸变化同一条路，天然不黑屏）
  }

  /** 用给定材质把 src 画到 dst 上 */
  function blit(mat, target) {
    quad.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(quadScene, quadCam);
  }

  allocate(1, 1);

  /** 一旦后处理链路抛异常就永久退化为直出（宁可没泛光，也不能黑屏） */
  let broken = false;
  const _dbs = new THREE.Vector2();

  /**
   * 把 RT 尺寸对齐到当前 drawingBuffer。
   * 为什么不依赖调用方主动调用：历史上就漏过一次 setSize，RT 停在 1×1，
   * 整屏等于在放大"全场景平均色"，夜景下就是纯黑（ADR-005 第 1 条）。
   * 每次 render 前自检一次，成本可以忽略。
   */
  function syncSize() {
    if (typeof renderer.getDrawingBufferSize !== 'function') return; // Node 桩环境没有这个方法
    const dbs = renderer.getDrawingBufferSize(_dbs);
    // 尺寸为 0 说明 drawingBuffer 还没就绪，别拿它重建 RT
    if (dbs.x <= 0 || dbs.y <= 0) return;
    if (dbs.x === size.x && dbs.y === size.y) return;
    allocate(dbs.x, dbs.y);
  }

  return {
    get enabled() { return mips > 0 && !broken; },

    /** P0-3：当前 bloom 层级（0 = 直出），供自动降级读取 */
    get mips() { return mips; },
    setMips,

    /** 参数可运行时调（昼夜轮换会动态改强度） */
    uniforms,

    /**
     * 窗口尺寸变化。参数是**像素（drawing buffer）**尺寸而非 CSS 尺寸
     * （要乘 devicePixelRatio，语义同 renderer.setSize 的内部行为）。
     * 忘了调也没关系 —— render() 里的 syncSize() 会兜住。
     */
    setSize(w, h) {
      if (w === size.x && h === size.y) return;
      allocate(w, h);
    },

    /**
     * 设置调色参数（设置页：亮度 / 伽马 / 暗角）。
     * 只写 uniforms，不做范围校验 —— 越界由 settings.mjs 的 normalize 保证。
     * @param g { brightness?, gamma?, vignette? }
     */
    setGrade(g = {}) {
      const u = uniforms.composite;
      if (!u) return;
      if (Number.isFinite(g.brightness)) u.brightness.value = Math.max(0.01, g.brightness);
      // gamma 存倒数，片元里就能省掉一次除法（每像素都跑）
      if (Number.isFinite(g.gamma)) u.gammaInv.value = 1 / Math.max(0.01, g.gamma);
      if (Number.isFinite(g.vignette)) u.vignette.value = Math.min(1, Math.max(0, g.vignette));
    },

    /**
     * 批五 R1/R2：电影级调色链参数。
     * 全部可选；传 0 就是关掉对应层（look=0 等价于旧观感，便于 A/B 与降级）。
     * @param o { look, saturation, grain, sharpen, exposure, adapt }
     */
    setLook(o = {}) {
      const u = uniforms.composite;
      if (!u || !o || typeof o !== 'object') return;
      if (Number.isFinite(o.look)) u.uLook.value = Math.max(0, Math.min(1, o.look));
      if (Number.isFinite(o.saturation)) u.uSaturation.value = Math.max(0, Math.min(2, o.saturation));
      if (Number.isFinite(o.grain)) u.uGrain.value = Math.max(0, Math.min(0.1, o.grain));
      if (Number.isFinite(o.sharpen)) u.uSharpen.value = Math.max(0, Math.min(1, o.sharpen));
      if (Number.isFinite(o.exposure)) u.uExposure.value = Math.max(0.1, Math.min(4, o.exposure));
      if (Number.isFinite(o.toneMix)) u.uToneMix.value = Math.max(0, Math.min(1, o.toneMix));
      if (typeof o.adapt === 'boolean') u.uAdaptOn.value = o.adapt ? 1 : 0;
    },

    /** 当前分辨率（供测试/调试读取） */
    get size() { return size.clone(); },

    /**
     * 主渲染入口：渲染 scene 并把泛光叠加上屏。
     * 与 renderer.render(scene, camera) 的调用位置完全等价，可直接替换。
     */
    render(scene, camera, dt = 1 / 60) {
      /* dt 可能是 undefined / NaN / 0（暂停帧、首帧、探针手动 pump）。
       * 直接拿它算 adaptRate 会把 NaN 写进 uniform —— 画面全白，而且不会自愈
       * （下一帧 tPrev 读到的还是 NaN）。所以先归一。 */
      if (!Number.isFinite(dt) || dt <= 0) dt = 1 / 60;
      if (mips === 0 || broken) {
        renderer.setRenderTarget(null);
        renderer.render(scene, camera);
        return;
      }
      // RT 尺寸永远跟随 drawingBuffer（ADR-005 第 1 条）
      syncSize();
      try {
        // 1) 场景 → rtScene（rtScene 带深度缓冲，见 ADR-005 第 2 条）
        renderer.setRenderTarget(rtScene);
        renderer.clear();
        renderer.render(scene, camera);

        // 2) 亮度提取：rtScene → rtBlurA[0]（顺便完成第一次 1/2 降采样）
        uniforms.bright.tDiffuse.value = rtScene.texture;
        blit(matBright, rtBlurA[0]);

        // 3) 逐级：横向模糊 → 纵向模糊；下一级从上一级继续降采样
        for (let i = 0; i < mips; i++) {
          if (rtBlurA[i] == null || rtBlurB[i] == null) break;
          const w = rtBlurA[i].width;
          const h = rtBlurA[i].height;
          // 横向：A → B
          uniforms.blur.tDiffuse.value = rtBlurA[i].texture;
          uniforms.blur.direction.value.set(1 / w, 0);
          blit(matBlur, rtBlurB[i]);
          // 纵向：B → A
          uniforms.blur.tDiffuse.value = rtBlurB[i].texture;
          uniforms.blur.direction.value.set(0, 1 / h);
          blit(matBlur, rtBlurA[i]);

          // 为下一级准备：把本级结果降采样进下一级的 A
          if (i + 1 < mips && rtBlurA[i + 1]) {
            uniforms.blur.tDiffuse.value = rtBlurA[i].texture;
            uniforms.blur.direction.value.set(0, 0); // direction=0 → 等价于双线性降采样
            blit(matBlur, rtBlurA[i + 1]);
          }
        }

        // 4) 合成上屏（composite 内部自己做 linear→sRGB，见 ADR-005 第 3 条）
        uniforms.composite.tDiffuse.value = rtScene.texture;
        uniforms.composite.tBlur0.value = rtBlurA[0]?.texture ?? null;
        uniforms.composite.tBlur1.value = rtBlurA[1]?.texture ?? rtBlurA[0]?.texture ?? null;
        uniforms.composite.tBlur2.value = rtBlurA[2]?.texture ?? rtBlurA[0]?.texture ?? null;
        uniforms.composite.mipCount.value = mips;
        uniforms.composite.uTexel.value.set(1 / Math.max(1, size.x), 1 / Math.max(1, size.y));

        /* 批五 R2：眼适应。从**最小**的模糊层取 3×3 个点求平均，
         * 再用 1×1 乒乓做时间性平滑。两个额外 draw，成本可忽略。
         * 为什么取模糊层而不是原图：原图上采样 9 个点会被高光/噪点带偏，
         * 模糊层天然就是"整幅画面的平均亮度"。 */
        /* 批五 R1/R2：时间推进放在 adapt 分支**外面** —— 颗粒抖动也要它，
         * 否则关掉眼适应后噪点会僵成一张固定的雪花图。 */
        adaptTime += dt;
        uniforms.composite.uTime.value = adaptTime;

        if (uniforms.composite.uAdaptOn.value > 0.5 && rtAdapt[0] && rtAdapt[1]) {
          adaptRate = 1 - Math.exp(-Math.max(1 / 240, Math.min(0.12, dt)) / 1.1);
          uniforms.adapt.uRate.value = adaptRate;
          const src = rtBlurA[Math.max(0, Math.min(mips, 3) - 1)] ?? rtBlurA[0];
          uniforms.adapt.tSrc.value = src?.texture ?? null;
          if (src) {
            adaptFlip = 1 - adaptFlip;
            uniforms.adapt.tPrev.value = rtAdapt[1 - adaptFlip].texture;
            blit(matAdapt, rtAdapt[adaptFlip]);
            uniforms.composite.tAdapt.value = rtAdapt[adaptFlip].texture;
            adaptFrames++;
          }
        } else {
          uniforms.composite.uAdaptOn.value = 0;
          uniforms.composite.tAdapt.value = rtBlurA[0]?.texture ?? null;  // 不会真的采样（uAdaptOn=0）
        }

        renderer.setRenderTarget(null);
        blit(matComposite, null);
      } catch (e) {
        // 保底：后处理链路任何异常都退化成直出，避免整屏黑（用户已经踩过一次）
        if (!broken) {
          broken = true;
          console.warn('[postfx] Bloom 链路异常，已退化为直出渲染：', e);
        }
        renderer.setRenderTarget(null);
        renderer.render(scene, camera);
      }
    },

    /** 释放 GPU 资源（页面卸载 / 热重载时调用） */
    dispose() {
      rtScene?.dispose();
      for (let i = 0; i < 3; i++) { rtBlurA[i]?.dispose(); rtBlurB[i]?.dispose(); }
      rtAdapt[0]?.dispose(); rtAdapt[1]?.dispose();
      geo.dispose();
      matBright.dispose();
      matBlur.dispose();
      matComposite.dispose();
      matAdapt.dispose();
    },

    /** 调试信息 */
    stats() {
      return {
        threshold,
        strength,
        mips,
        knee,
        width: size.x,
        height: size.y,
        // 实际选用的 RT 像素格式：探测不支持时会从 half-float 退到 unsigned-byte
        pixelType: pixelType === THREE.HalfFloatType ? 'half-float' : 'unsigned-byte',
        degraded: broken,
        /* 批五 R1/R2：调色链与眼适应的运行时状态（探针/报告用） */
        look: uniforms.composite.uLook.value,
        saturation: uniforms.composite.uSaturation.value,
        exposure: uniforms.composite.uExposure.value,
        toneMix: uniforms.composite.uToneMix.value,
        adaptOn: uniforms.composite.uAdaptOn.value > 0.5,
        adaptFrames,
        adaptRate,
        grain: uniforms.composite.uGrain.value,
        sharpen: uniforms.composite.uSharpen.value,
      };
    },
  };
}

/**
 * 无后处理时的退化渲染器（同样的接口）。
 * 用途：测试环境 / 低配设备 / WebGL 扩展缺失时，main.mjs 不需要写 if 分支。
 */
export function createPassThrough(renderer) {
  const noop = () => {};
  return {
    enabled: false,
    setSize: noop,
    setGrade: noop,   // 直出时调色无处可去（没有 composite pass），保持接口一致即可
    setLook: noop,    // 同上：直出没有调色链，但要能被 main 无条件调用
    render(scene, camera) {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    },
    dispose: noop,
    uniforms: {},
    stats: () => ({
      threshold: 0,
      strength: 0,
      mips: 0,
      knee: 0,
      width: 0,
      height: 0,
      pixelType: 'none',
      degraded: true,
      look: 0,
      adaptOn: false,
      adaptFrames: 0,
      adaptRate: 0,
      grain: 0,
      sharpen: 0,
    }),
  };
}
