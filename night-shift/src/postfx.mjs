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
varying vec2 vUv;

// 线性 → sRGB 的 OETF（分段函数，标准 sRGB 传递曲线）
// 为什么必须手写：见文件头 ADR-005 第 3 条 —— rtScene 里存的是线性值，
// three 不会给手写 ShaderMaterial 注入颜色空间转换，漏掉这步整个暗场景会被压成黑屏。
vec3 linearToSRGB(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = pow(max(c, vec3(1e-5)), vec3(1.0 / 2.4)) * 1.055 - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

void main() {
  vec3 base = texture2D(tDiffuse, vUv).rgb;
  vec3 bloom = vec3(0.0);
  bloom += texture2D(tBlur0, vUv).rgb * w0;
  if (mipCount > 1) bloom += texture2D(tBlur1, vUv).rgb * w1;
  if (mipCount > 2) bloom += texture2D(tBlur2, vUv).rgb * w2;
  // clamp：HDR 尾部在此收敛到白核（项目未启用 tone mapping，保持电影感的硬截断）
  vec3 col = clamp(base + bloom * strength, 0.0, 1.0);

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

  /* linearToSRGB 必须**留在这一行**：ADR-005 第 ③ 条 —— 手写 shader 上屏漏掉
   * linear→sRGB 会让整屏发黑（与"主循环没起来"的症状一模一样，极难排查）。
   * postfx.test 对这条有正则断言守护，重构时别把它拆成中间变量。 */
  gl_FragColor = vec4(linearToSRGB(col) * vig, 1.0);
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
  const mips = Math.max(0, Math.min(3, opts.mips ?? cfg.mips));
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

  function allocate(w, h) {
    size.set(w, h);
    rtScene?.dispose();
    rtScene = makeRT(w, h, pixelType, true, msaa);
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

    /** 当前分辨率（供测试/调试读取） */
    get size() { return size.clone(); },

    /**
     * 主渲染入口：渲染 scene 并把泛光叠加上屏。
     * 与 renderer.render(scene, camera) 的调用位置完全等价，可直接替换。
     */
    render(scene, camera) {
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
      geo.dispose();
      matBright.dispose();
      matBlur.dispose();
      matComposite.dispose();
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
    }),
  };
}
