/**
 * 后处理链（模块 10）—— 纯手写，不依赖 three 的 examples/jsm/postprocessing。
 * ---------------------------------------------------------------------------
 * 为什么手写：本项目的 vendor 只带 `three.module.js` 核心，没有 EffectComposer /
 * RenderPass / UnrealBloomPass / OutputPass。但 spec 明确要求这条链，于是照着它的
 * 语义自己实现一遍：
 *
 *   RenderPass  →  把场景渲染到一张 HDR 颜色缓冲（线性、未做色调映射）
 *   BloomPass   →  亮部提取（阈值 0.9，只让朱砂红/闪帧发光，墨色哑光不泛光）
 *               +  半分辨率分离高斯模糊（半径 0.4）
 *   OutputPass  →  场景 + 泛光×强度(0.6)  →  ACES 色调映射  →  sRGB 输出到屏幕
 *
 * ⚠ 关键：场景渲染时把 renderer.toneMapping 强制切成 NoToneMapping，
 *   让 sceneRT 保留线性 HDR；色调映射只在最后的 OutputPass 做一次（与官方链一致）。
 *   若任意一步创建失败，整体降级为「renderer 直接渲染 + ACES」，保证页面不会黑屏。
 */
import {
  ACESFilmicToneMapping,
  HalfFloatType,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  WebGLRenderTarget,
} from '../../vendor/three/three.module.js';
import { POSTFX, RENDER } from './config.js';

const VERT = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// 亮部提取：只保留超过阈值的亮像素（朱砂红与闪帧会越过 0.9）
const BRIGHT_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform float threshold;
void main(){
  vec3 c = texture2D(tScene, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float k = max(0.0, l - threshold) / max(1e-4, 1.0 - threshold);
  gl_FragColor = vec4(c * k, 1.0);
}
`;

// 分离高斯模糊（9 抽头，方向由 uDir 控制）
const BLUR_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform vec2 uDir;
void main(){
  float w[5];
  w[0]=0.227027; w[1]=0.1945946; w[2]=0.1216216; w[3]=0.054054; w[4]=0.016216;
  vec3 c = texture2D(tDiffuse, vUv).rgb * w[0];
  for(int i=1;i<5;i++){
    vec2 o = uDir * float(i);
    c += texture2D(tDiffuse, vUv + o).rgb * w[i];
    c += texture2D(tDiffuse, vUv - o).rgb * w[i];
  }
  gl_FragColor = vec4(c, 1.0);
}
`;

// 合成：场景 + 泛光，再走 ACES + sRGB
const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform float strength;
uniform float exposure;
uniform float useBloom;
vec3 aces(vec3 x){
  const float a=2.51,b=0.03,c=2.43,d=0.59,e=0.14;
  return clamp((x*(a*x+b))/(x*(c*x+d)+e),0.0,1.0);
}
vec3 toSRGB(vec3 c){
  return mix(c*12.92, 1.055*pow(max(c,0.0),vec3(1.0/2.4))-0.055, step(0.0031308,c));
}
void main(){
  vec3 scene = texture2D(tScene, vUv).rgb;
  vec3 bloom = texture2D(tBloom, vUv).rgb * strength * useBloom;
  vec3 col = scene + bloom;
  col = aces(col * exposure);
  col = toSRGB(col);
  gl_FragColor = vec4(col, 1.0);
}
`;

export class PostFX {
  /**
   * @param renderer WebGLRenderer
   * @param scene    主场景
   * @param camera   主相机
   */
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.ok = false;
    this.bloomEnabled = POSTFX.ENABLED && POSTFX.BLOOM_STRENGTH > 0;
    this._bloomStrength = POSTFX.BLOOM_STRENGTH;
    this._savedToneMapping = renderer.toneMapping;

    // 全屏四边形场景（用裁剪空间坐标，无需相机变换）
    this._quadScene = new Scene();
    this._quadCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._quad = new Mesh(new PlaneGeometry(2, 2), null);
    this._quad.frustumCulled = false;
    this._quadScene.add(this._quad);

    try {
      const size = renderer.getDrawingBufferSize(new Vector2());
      const w = Math.max(2, size.x | 0);
      const h = Math.max(2, size.y | 0);
      const rtType = renderer.capabilities.isWebGL2 ? HalfFloatType : UnsignedByteType;

      const rtOpts = { type: rtType, depthBuffer: true, stencilBuffer: false };
      this.sceneRT = new WebGLRenderTarget(w, h, rtOpts);

      const bw = POSTFX.HALF_RES_BLOOM ? Math.max(2, (w / 2) | 0) : w;
      const bh = POSTFX.HALF_RES_BLOOM ? Math.max(2, (h / 2) | 0) : h;
      const halfOpts = { type: rtType, depthBuffer: false, stencilBuffer: false };
      this.brightRT = new WebGLRenderTarget(bw, bh, halfOpts);
      this.pingRT = new WebGLRenderTarget(bw, bh, halfOpts);
      this.pongRT = new WebGLRenderTarget(bw, bh, halfOpts);

      this.brightMat = new ShaderMaterial({
        vertexShader: VERT, fragmentShader: BRIGHT_FRAG,
        uniforms: { tScene: { value: this.sceneRT.texture }, threshold: { value: POSTFX.BLOOM_THRESHOLD } },
        depthTest: false, depthWrite: false,
      });
      this.blurMat = new ShaderMaterial({
        vertexShader: VERT, fragmentShader: BLUR_FRAG,
        uniforms: { tDiffuse: { value: null }, uDir: { value: new Vector2() } },
        depthTest: false, depthWrite: false,
      });
      this.compositeMat = new ShaderMaterial({
        vertexShader: VERT, fragmentShader: COMPOSITE_FRAG,
        uniforms: {
          tScene: { value: this.sceneRT.texture },
          tBloom: { value: this.pingRT.texture },
          strength: { value: this._bloomStrength },
          exposure: { value: RENDER.TONE_MAPPING_EXPOSURE },
          useBloom: { value: 1 },
        },
        depthTest: false, depthWrite: false,
      });

      // 场景渲染关掉色调映射，留给 OutputPass 统一做
      renderer.toneMapping = ACESFilmicToneMapping === renderer.toneMapping ? ACESFilmicToneMapping : renderer.toneMapping;
      renderer.toneMapping = 0; // NoToneMapping
      this.ok = true;
    } catch (err) {
      console.warn('[PostFX] 初始化失败，降级为直接渲染：', err && err.message);
      this.ok = false;
      this._restore();
    }
  }

  _restore() {
    this.renderer.toneMapping = this._savedToneMapping || ACESFilmicToneMapping;
  }

  setBloomEnabled(on) {
    this.bloomEnabled = on && POSTFX.BLOOM_STRENGTH > 0;
  }

  /** 无双乱舞期间临时把泛光拉高到 1.2 */
  setBloomStrength(v) {
    if (this.ok) this.compositeMat.uniforms.strength.value = v;
    this._bloomStrength = v;
  }

  setSize(w, h) {
    if (!this.ok) return;
    const dw = Math.max(2, w | 0);
    const dh = Math.max(2, h | 0);
    this.sceneRT.setSize(dw, dh);
    const bw = POSTFX.HALF_RES_BLOOM ? Math.max(2, (dw / 2) | 0) : dw;
    const bh = POSTFX.HALF_RES_BLOOM ? Math.max(2, (dh / 2) | 0) : dh;
    this.brightRT.setSize(bw, bh);
    this.pingRT.setSize(bw, bh);
    this.pongRT.setSize(bw, bh);
  }

  render() {
    if (!this.ok) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();

    // 1) 场景 → sceneRT（线性 HDR，未色调映射）
    r.setRenderTarget(this.sceneRT);
    r.clear();
    r.render(this.scene, this.camera);

    if (this.bloomEnabled) {
      // 2) 亮部提取
      this._quad.material = this.brightMat;
      this.brightMat.uniforms.tScene.value = this.sceneRT.texture;
      r.setRenderTarget(this.brightRT);
      r.clear();
      r.render(this._quadScene, this._quadCam);

      // 3) 分离高斯模糊：bright → pong(横) → ping(纵)，迭代 2 次让墨晕更顺
      for (let i = 0; i < 2; i++) {
        this.blurMat.uniforms.tDiffuse.value = this.brightRT.texture;
        this.blurMat.uniforms.uDir.value.set(1 / this.brightRT.width, 0);
        this._quad.material = this.blurMat;
        r.setRenderTarget(this.pongRT);
        r.clear();
        r.render(this._quadScene, this._quadCam);

        this.blurMat.uniforms.tDiffuse.value = this.pongRT.texture;
        this.blurMat.uniforms.uDir.value.set(0, 1 / this.brightRT.height);
        r.setRenderTarget(this.pingRT);
        r.clear();
        r.render(this._quadScene, this._quadCam);
      }
    }

    // 4) 合成 → 屏幕
    this.compositeMat.uniforms.useBloom.value = this.bloomEnabled ? 1 : 0;
    this.compositeMat.uniforms.strength.value = this._bloomStrength;
    this._quad.material = this.compositeMat;
    r.setRenderTarget(null);
    r.clear();
    r.render(this._quadScene, this._quadCam);

    if (prevTarget) r.setRenderTarget(prevTarget);
  }

  dispose() {
    if (!this.ok) return;
    this.sceneRT?.dispose();
    this.brightRT?.dispose();
    this.pingRT?.dispose();
    this.pongRT?.dispose();
    this.brightMat?.dispose();
    this.blurMat?.dispose();
    this.compositeMat?.dispose();
    this._restore();
  }
}
