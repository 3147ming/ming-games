/**
 * 3D 渲染层（第一人称）：把逻辑世界（map / player / enemies / 特效）投射到 scene3d 句柄。
 *
 * 本模块只负责"画"，不修改任何游戏逻辑（world / player / enemy 都只读）。
 * 坐标契约：逻辑 (x, y) → 场景 (x, height, y)，XZ 为地面、Y 向上。
 *
 * 性能与健壮性：
 * - 复用 scene3d 的光照 / 雾 / 自适应阴影；相机挂到场景里以便渲染武器视图模型。
 * - 曳光弹（面片四边形）/ 碎片（Points）/ 弹壳（InstancedMesh）全部对象池化，避免每帧 new。
 * - 战局切换（world 变化）时重建关卡与敌人模型，并释放旧资源。
 */

import {
  VIEW3D, PALETTE3D, POST3D, MATCH, VEHICLE,
} from './config.js';
import { buildLevel, glbEnabled } from './level3d.js';
import { clampGrade, zoneMixAt, gradeTints } from './grade3d.js';
import {
  buildEnemyModel, buildAllyModel, buildViewmodel, buildItemModel, yawFromAngle, u,
  buildTerminalModel, buildSwitchModel, buildAirdropBeacon, buildVehicleModel, upgradeViewmodel,
  getBloodTexture, getScorchTexture, getSmokeTexture, getFireTexture,
} from './models.js';
import { elevationAt } from './mapgen.js';
import { reloadPose, reloadProgress } from './reload.js';
import { THROWABLE_TYPES } from './throwable.js';
import { loadGLB, glbLambert } from './assets.js';
import { clone as cloneSkinned } from '../vendor/SkeletonUtils.js';

/**
 * 敌人 / 队友的 GLB 角色（Kenney Mini Characters）。
 *
 * 选它而不是 Poly Pizza 的 enemy-soldier：
 * 1) 单一 colormap 材质 —— 能和容器走同一条 Lambert 转换，不会出现"PBR 在同一套灯光下
 *    被打亮成惨白"的偏色（对照见 .screenshots/preview-2.png：poly-pizza 的士兵几乎全黑）；
 * 2) 只有 7 根骨骼、2 个 mesh —— 8 个敌人同屏也不会把 draw call 打爆；
 *    而 enemy-soldier 是 18 个 mesh，8 个敌人就是 144 次 draw call；
 * 3) 自带 idle / walk / sprint 等动作，不需要重做动画系统。
 *
 * `?glb=0` 时整条链路关闭，敌人回到程序化方块人（与容器同一开关）。
 */
const ENEMY_GLB = {
  patrol: 'models/kenney-mini-characters/character-soldier.glb',
  assault: 'models/kenney-mini-characters/character-soldier.glb',
  machinegunner: 'models/kenney-mini-characters/character-soldier.glb',
  rusher: 'models/kenney-mini-characters/character-worker.glb',
  shotgunner: 'models/kenney-mini-characters/character-worker.glb',
  marksman: 'models/kenney-mini-characters/character-raider.glb',
  carbinger: 'models/kenney-mini-characters/character-raider.glb',
  elite: 'models/kenney-mini-characters/character-raider.glb',
  // 医疗兵单独用机器人：全表唯一的机器人剪影，交火中一眼能认出"先打这只"，
  // 比给它换个颜色更有效（颜色会被受击闪红、距离雾、鹰眼标记一起吃掉）。
  medic: 'models/kenney-mini-characters/character-robot.glb',
  // Boss **故意不换**：首领需要与杂兵完全不同的体型/轮廓（血条已在 HUD 上，
  // 但场上还得靠剪影分辨），换成普通角色骨架会把这个辨识度抹平。
};
const ALLY_GLB = 'models/kenney-mini-characters/character-soldier.glb';
/**
 * 角色 GLB 的亮度衰减（0~1）。0.62 是实测值：1.0 时军装被冲成薄荷绿、肤色糊成白，
 * 0.62 时绿色和肤色都能分辨，又不会在暗处看不见人（自发光另有补偿）。
 */
const ENEMY_GLB_GAIN = 0.62;

/**
 * 在伤害飘字画布上绘制一次文本（黑色描边 + 彩色填充，保证在任意背景上都可读）。
 * 纯 Canvas 2D，不依赖 THREE，便于在无头环境下单测。
 * @param {object} ctx 2D 上下文
 * @param {number} w 画布宽
 * @param {number} h 画布高
 * @param {object} dmg 伤害飘字 { text, color }
 * @returns {void}
 */
export function drawDamageLabel(ctx, w, h, dmg) {
  ctx.clearRect(0, 0, w, h);
  const text = String((dmg && dmg.text != null) ? dmg.text : '');
  const color = (dmg && dmg.color) || '#ffffff';
  ctx.font = `700 ${Math.round(h * 0.6)}px "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = Math.max(2, Math.round(h * 0.1));
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(text, w / 2, h / 2);
  ctx.fillStyle = color;
  ctx.fillText(text, w / 2, h / 2);
}

/** 解析 'rgba(r,g,b,a)' 串取基础颜色（世界粒子用占位串，仅取 rgb） */
function baseColorOf(str) {
  const m = /rgba?\(([^)]+)\)/.exec(str || '');
  if (!m) return '#ffffff';
  const n = m[1].split(',').map((s) => parseFloat(s.trim()));
  if (n.length < 3) return '#ffffff';
  return `rgb(${n[0]},${n[1]},${n[2]})`;
}

/**
 * 后处理全屏 pass 的顶点着色器：把覆盖全屏的四边形直接输出到裁剪空间，
 * 并把 uv 传给片元着色器（用于采样场景 RT 与深度纹理）。
 */
/** 后处理顶点着色器源码（导出以便测试做静态校验） */
export const POST_VS = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * 后处理片元着色器（在对数域：ACES 之前是线性光，之后是显示参考值）：
 *
 * ⚠ 这里**必须自己做色调映射**。three 在渲染到 render target 时会把
 * `renderer.toneMapping` 强制成 NoToneMapping（见 WebGLPrograms.getParameters），
 * 所以整条后处理链原本是"线性 → 直接 sRGB 编码"，等于没有 HDR 压缩：
 * 高光一律削平、曝光滑杆调了完全不动（实测曝光 1.0/1.7/2.2 出图均值都是 0.377）。
 * ACES 放在 AO / 暗角之后、对比与调色之前 —— 与"先压回显示区间再分级"的常规顺序一致。
 * - 轻微色差（径向 RGB 分离）：金属 / 高光边缘的彩色镶边，质感立刻"贵"一点。
 * - 深度近似 AO（接触阴影）：用深度纹理做小核采样，周围更近 → 暗化，模拟 SSAO。
 * - 暗角（vignette）：收拢视线到中心。
 * - 极细颗粒：抑制渐变色带。
 * 末尾手动做 sRGB 编码 —— 自定义 ShaderMaterial 不会自动套用输出色彩空间转换。
 *
 * 所有数值通过 uniform 传入（见 config.js 的 POST3D），此处不写魔数。
 *
 * 导出以便测试做真实 GLSL 编译校验（编译失败不会抛 JS 异常、只会静默黑屏）。
 */
export const POST_FS = `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform vec2 uResolution;
uniform float uNear;
uniform float uFar;
uniform float uTime;
uniform float uVignette;
uniform float uCA;
uniform float uAO;
uniform float uAOStrength;
uniform float uAORadius;
uniform float uAOBias;
uniform float uGrain;
uniform float uContrast;
uniform float uSharpen;
uniform float uDither;
uniform float uSaturation;
uniform float uExposure;
uniform vec3 uShadowTint;
uniform vec3 uHighlightTint;
uniform float uSplitTone;
uniform int uAOSamples;

// ACES Filmic（与 three 内置实现同一组矩阵与 RRT/ODT 拟合，避免两条渲染路径色调不一致）
const mat3 ACES_INPUT = mat3(
  vec3(0.59719, 0.07600, 0.02840),
  vec3(0.35458, 0.90834, 0.13383),
  vec3(0.04823, 0.01566, 0.83777)
);
const mat3 ACES_OUTPUT = mat3(
  vec3(1.60475, -0.10208, -0.00327),
  vec3(-0.53108, 1.10813, -0.07276),
  vec3(-0.07367, -0.00605, 1.07602)
);
vec3 rrtOdtFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 acesFilmic(vec3 color) {
  color *= uExposure / 0.6; // 与 three 的 ACESFilmicToneMapping 同一口径
  color = ACES_INPUT * color;
  color = rrtOdtFit(color);
  color = ACES_OUTPUT * color;
  return clamp(color, 0.0, 1.0);
}

float linearizeDepth(float d) {
  float z = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}

void main() {
  vec2 dir = vUv - 0.5;

  // 轻微色差：沿径向分离 RGB
  float ca = uCA * (0.4 + length(dir));
  float r = texture2D(tDiffuse, vUv + dir * ca).r;
  float g = texture2D(tDiffuse, vUv).g;
  float b = texture2D(tDiffuse, vUv - dir * ca).b;
  vec3 col = vec3(r, g, b);

  // P12 邻近锐化：ACES 之后贴图细节会被抹平，取 4 个十字邻居做 unsharp，
  // 只补回边缘对比，不放大颗粒噪声（uSharpen=0 时整段被编译器跳过）。
  if (uSharpen > 0.0) {
    vec2 px = 1.0 / uResolution;
    vec3 blur = (
      texture2D(tDiffuse, vUv + vec2(px.x, 0.0)).rgb +
      texture2D(tDiffuse, vUv - vec2(px.x, 0.0)).rgb +
      texture2D(tDiffuse, vUv + vec2(0.0, px.y)).rgb +
      texture2D(tDiffuse, vUv - vec2(0.0, px.y)).rgb
    ) * 0.25;
    col += (col - blur) * uSharpen;
  }

  // 深度近似 AO（接触阴影）：周围样本更近 → 视为遮挡
  float center = linearizeDepth(texture2D(tDepth, vUv).r);
  float occ = 0.0;
  for (int i = 0; i < 16; i++) {
    if (i >= uAOSamples) break; // 采样数由 uniform 决定（性能/质量权衡）
    float a = float(i) * 2.39996323; // 黄金角螺旋采样
    float rad = (float(i) + 1.0) / float(uAOSamples);
    vec2 off = vec2(cos(a), sin(a)) * rad * uAORadius / uResolution;
    float s = linearizeDepth(texture2D(tDepth, vUv + off).r);
    float diff = (center - s) / max(center, 1.0); // 相对深度差，避免远处过暗
    if (diff > uAOBias) occ += diff;
  }
  occ = clamp(occ / float(uAOSamples), 0.0, 1.0);
  float ao = 1.0 - occ * uAOStrength;
  col *= mix(1.0, ao, uAO);

  // 暗角
  float vig = 1.0 - uVignette * pow(length(dir) * 1.32, 2.3);
  col *= vig;

  // 色调映射：把线性 HDR 压回 0~1。没有这一步，后面的对比/调色/饱和全在"已经削平"的
  // 画面上做，等于给死白上色 —— 这是后处理开启时画面发灰、曝光滑杆失效的根因。
  col = acesFilmic(col);

  // 轻微提中间调对比（显示参考空间，>1 提对比）
  col = pow(max(col, 0.0), vec3(uContrast));

  // P3-C3 色彩分级（split-tone）：按亮度在冷阴影色与暖高光色之间插值，
  // 把 tint 归一化到单位亮度后乘回 —— 保持画面亮度不变，只把色相往两端推（电影感）。
  float gl = dot(col, vec3(0.2126, 0.7152, 0.0722));
  vec3 tint = mix(uShadowTint, uHighlightTint, smoothstep(0.22, 0.72, gl));
  float tintLuma = max(dot(tint, vec3(0.2126, 0.7152, 0.0722)), 0.001);
  col = mix(col, col * (tint / tintLuma), clamp(uSplitTone, 0.0, 1.0));

  // P3 低饱和：在 ACES 之后按亮度混合，1.0 = 原色，<1 = 压掉彩色噪点。
  // 用 luma 混合而不是逐通道乘法，避免暗部被整体染脏。
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(luma), col, uSaturation);

  // 细颗粒，抑制色带
  float n = fract(sin(dot(vUv * (uTime + 1.0), vec2(12.9898, 78.233))) * 43758.5453);
  col += (n - 0.5) * uGrain;

  col = clamp(col, 0.0, 1.0);

  // 手动 sRGB 编码（ShaderMaterial 输出不自动走输出色彩空间转换）
  // 注意：step 的返回类型跟随第二个参数，对 vec3 调用返回 vec3，
  // 因此阈值必须显式写成 vec3，且混合理由分量决定，不能用 float。
  vec3 encodeHi = 1.055 * pow(col, vec3(1.0 / 2.4)) - 0.055;
  vec3 encodeLo = col * 12.92;
  vec3 m = 1.0 - step(vec3(0.0031308), col); // col<=阈值 时用线性段
  vec3 srgb = mix(encodeHi, encodeLo, m);
  // P12 输出前抖动：±0.5/255 的扰动打散 8bit 量化色带，暗场渐变更干净。
  float dith = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233)) + uTime * 0.37) * 43758.5453);
  srgb += (dith - 0.5) * uDither / 255.0;
  gl_FragColor = vec4(clamp(srgb, 0.0, 1.0), 1.0);
}
`;

/**
 * 校验一个 Three.js 材质背后的 GLSL 程序是否真的编译链接成功。
 *
 * 为什么需要它：**着色器编译失败不会抛 JS 异常**。GLSL 编译器只把错误写进
 * `INFO_LOG` 并在 console 打一条 Error，`render()` 照常返回 —— 结果是静默黑屏。
 * 因此把 `render()` 包在 try/catch 里是**不够的**，必须主动查 `LINK_STATUS`。
 *
 * @param {object} renderer Three.js WebGLRenderer
 * @param {object} material 材质（其 program 已至少被渲染过一次）
 * @param {object} THREE THREE 命名空间
 * @returns {boolean} true = 渲染程序可用；false = 编译/链接失败或不支持校验
 */
function isProgramRunnable(renderer, material, THREE) {
  try {
    const props = renderer.properties;
    if (!props || !props.get) return true; // 拿不到内部状态就不阻断
    const p = props.get(material).currentProgram;
    if (!p) return true; // 尚未编译（首帧后才会有）
    const gl = renderer.getContext();
    if (!gl || !p.program) return true;
    const diagnostics = p.diagnostics;
    if (diagnostics && diagnostics.runnable === false) return false;
    // diagnostics 只在 checkShaderErrors 开启时才有，兜底直接查 GL
    if (gl.getProgramParameter(p.program, gl.LINK_STATUS) === false) return false;
    if (gl.getShaderParameter && p.fragmentShader) {
      // 某些实现 LINK_STATUS 为 true 但片元着色器实际未编译，再查一层
      const fs = p.fragmentShader;
      if (fs && gl.getShaderParameter(fs, gl.COMPILE_STATUS) === false) return false;
    }
    return true;
  } catch {
    return true; // 校验本身出错不阻断渲染
  }
}

export class Renderer3D {
  /**
   * @param {object} handle scene3d 句柄（{ THREE, renderer, scene, camera, sun, focusShadow, samplePerf, ... }）
   * @param {HTMLCanvasElement} canvas 游戏画布
   * @param {object} [device] 设备分级（detectDeviceTier 返回值），low 档关闭后处理
   */
  constructor(handle, canvas, device) {
    this.handle = handle;
    // 只有桌面（high）才开全屏后处理：low / mid 触屏档都直接关（最稳、最省）
    this._lowQuality = !!(device && device.quality && device.quality !== 'high');
    // 无障碍（P1-7）：系统要求减少动态效果时，震屏 / 枪模惯性 / 后坐位移幅度归零
    this._reducedMotion = !!(device && device.reducedMotion);
    this._motionScale = this._reducedMotion ? 0 : 1;
    this.THREE = handle.THREE;
    this.canvas = canvas;
    this.world = null;
    this.level = null;
    this.enemyModels = new Map(); // enemy -> THREE.Group
    this.allyModels = new Map(); // ally -> THREE.Group
    this.addedContainers = new Set(); // 已加入关卡的容器 id
    this.viewmodel = null;
    this._vmWeaponId = null;
    this._vmSig = null;
    this._vm = null; // 视图模型基位姿（插值用）
    this._recoil = 0; // 后坐量（0~1）
    // P4-C3 换弹三段姿态：下沉 / 侧翻 / 沿枪轴抖动。
    // 换弹中直接取曲线值（曲线本身连续），不叠加指数平滑 —— 平滑会把"弹匣落"的峰值抹平，
    // 那一下是这段动画唯一的节奏锚点。只有被打断时才用 lerp 回正。
    this._reload = 0;
    this._reloadRoll = 0;
    this._reloadPump = 0;
    this._swayX = 0; // 转身惯性：yaw 角速度的低通结果（rad/s，P0-3）
    this._swayY = 0; // 转身惯性：pitch 角速度的低通结果
    this._lastYaw = null;
    this._lastPitch = null;
    this._itemProps = new Map(); // 世界掉落物品模型（container → { count, models }）
    this._decalPool = null; // 地面贴花对象池（血迹 / 焦痕），懒创建
    this._decalGeo = null; // 贴花共享几何体
    this._terminalModels = new Map(); // 数据终端对象 → 模型
    this._switchModels = new Map(); // M-03 闸刀 POI → 模型
    this._airdropBeacon = null; // 空投信标（着陆后隐藏）
    this._crateState = null; // 掩体箱破坏状态缓存（每帧与 map 比对，只更新变化项）
    this._dmgPool = null; // 伤害飘字精灵池（懒创建，无 document 时为空）
    this._bobT = 0; // 摆动相位
    this.eyeHeight = u(VIEW3D.eyeStand);
    this.baseFov = VIEW3D.fov; // 腰射基准 FOV（可由设置覆盖，ADS 时收窄到 fovAds）
    this.fov = VIEW3D.fov;
    // 后处理管线（RTT + 全屏 pass）状态：默认未启用，首帧渲染时按需惰性初始化；
    // 任何一步失败都回退到直渲，保证不黑屏、不崩溃。
    this._postTried = false;
    this._postEnabled = false;
    this._postBlocked = false; // 被帧率闸门永久关闭（P0-4），不再重试初始化
    this._postVerified = false; // 首帧后是否已校验过着色器编译状态
    this._prewarmed = false; // P0-1：是否已主动编译过世界材质（避免入视野时懒编译卡顿）
    this._rt = null;
    this._postScene = null;
    this._postCamera = null;
    this._postMat = null;
    // P3：当前调色（后处理惰性初始化时按它灌 uniform，避免 setGrade 先于 _ensurePost 丢值）
    this._grade = clampGrade();
    // 相机挂入场景，使武器视图模型（相机子节点）参与渲染
    this.handle.scene.add(this.handle.camera);
    // 视图模型独立光照层：枪模在 layer 1，世界灯只照 layer 0，避免靠近室内点光时枪面过曝成白。
    // 这里给相机挂一盏专属半球光 + 方向光（仅 layer 1），让枪模始终均匀受光、观感稳定。
    // 测试桩可能没有 camera，这里做存在性保护，保证构造不崩。
    if (this.handle.camera && this.handle.camera.layers) {
      this.handle.camera.layers.enable(1);
      const vmHemi = new this.THREE.HemisphereLight(0xffffff, 0x3a3f37, 1.25);
      vmHemi.layers.set(1);
      const vmDir = new this.THREE.DirectionalLight(0xffffff, 0.55);
      vmDir.position.set(0.4, 1, 0.6);
      vmDir.layers.set(1);
      this.handle.camera.add(vmHemi, vmDir);
    }
    this._initFx();
    // 后处理归渲染层所有，scene3d 只负责判断"何时该关"（P0-4）。
    // 注册时若已经降过级，scene3d 会立刻回调一次，避免丢掉这一档。
    if (typeof this.handle.setPerfHook === 'function') {
      this.handle.setPerfHook(() => this.setPostEnabled(false));
    }
  }

  /* ---------------- 特效对象池 ---------------- */

  _initFx() {
    const T = this.THREE;
    const fx = VIEW3D.fx;
    // 曳光弹（P0-5）：每条弹道 = 一块沿弹道拉伸的四边形（2 个三角面 / 6 个顶点）。
    // 为什么不再用 LineSegments：WebGL 的 lineWidth 恒为 1，config 里的 tracerWidth 是死键，
    // 交火时那条 1px 细线几乎看不见。改成面片后宽度真实生效，还能走加色混合。
    this._tracerMax = 96;
    this._tracerVerts = 6; // 每条弹道占用的顶点数
    this._camUp = new T.Vector3(0, 1, 0);
    this._camRight = new T.Vector3(1, 0, 0);
    this._camPos = new T.Vector3();
    this._muzzleWorld = new T.Vector3(); // 复用：玩家曳光弹起点取枪口世界坐标
    this._qYaw = new T.Quaternion();
    this._qPitch = new T.Quaternion();
    // 弹道中心线缓存（x1,y1,z1,x2,y2,z2）：既是几何计算的中间量，也是测试/探针的读取口。
    // 有它就不必为了校验去反解"被加宽偏移过"的顶点坐标。
    this._tracerEnds = new Float32Array(this._tracerMax * 6);
    const tg = new T.BufferGeometry();
    tg.setAttribute('position', new T.BufferAttribute(new Float32Array(this._tracerMax * this._tracerVerts * 3), 3));
    tg.setAttribute('color', new T.BufferAttribute(new Float32Array(this._tracerMax * this._tracerVerts * 3), 3));
    tg.setDrawRange(0, 0);
    this._tracerGeo = tg;
    this._tracerMesh = new T.Mesh(
      tg,
      new T.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
        // 加色混合：夜战里弹道是"发光"的而不是"贴上去的一条灰线"
        blending: T.AdditiveBlending,
        depthWrite: false,
        side: T.DoubleSide,
        fog: false,
      }),
    );
    this._tracerMesh.frustumCulled = false;
    this._tracerMesh.renderOrder = 6;
    this.handle.scene.add(this._tracerMesh);

    // 碎片 / 血点：Points 云。上限统一读 config（P1-8），逻辑侧与渲染缓冲因此永远一致。
    this._particleMax = Math.max(1, fx.maxParticles | 0);
    const pg = new T.BufferGeometry();
    pg.setAttribute('position', new T.BufferAttribute(new Float32Array(this._particleMax * 3), 3));
    pg.setAttribute('color', new T.BufferAttribute(new Float32Array(this._particleMax * 3), 3));
    pg.setDrawRange(0, 0);
    this._particleGeo = pg;
    this._particles = new T.Points(
      pg,
      new T.PointsMaterial({
        size: u(0.14),
        vertexColors: true,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
    this._particles.frustumCulled = false;
    this._particles.renderOrder = 6;
    this.handle.scene.add(this._particles);

    /* --- 弹壳对象池（P0-1）：一个 InstancedMesh 画完全部弹壳，零逐帧分配 --- */
    this._shellPool = Math.max(1, fx.shellMax | 0);
    const shellGeo = new T.CylinderGeometry(0.35, 0.35, 1, 5, 1, false);
    const shellMat = new T.MeshStandardMaterial({
      color: new T.Color(fx.shellColor),
      emissive: new T.Color(fx.shellColor),
      emissiveIntensity: 0.35,
      roughness: 0.38,
      metalness: 0.82,
    });
    this._shellMesh = new T.InstancedMesh(shellGeo, shellMat, this._shellPool);
    this._shellMesh.frustumCulled = false; // 实例会跑到世界各处，默认包围球只会导致误剔除
    this._shellMesh.count = 0;
    this._shellMesh.renderOrder = 5;
    // 主动建好 instanceColor（首次 setColorAt 才分配），避免运行期第一次开火时分配
    this._shellColor = new T.Color(fx.shellColor);
    for (let i = 0; i < this._shellPool; i += 1) this._shellMesh.setColorAt(i, this._shellColor);
    this._shellMesh.instanceColor.needsUpdate = true;
    this.handle.scene.add(this._shellMesh);
    this._shellM = new T.Matrix4();
    this._shellQ = new T.Quaternion();
    this._shellE = new T.Euler();
    this._shellP = new T.Vector3();
    this._shellS = new T.Vector3();
    this._shellTmp = new T.Color();
    this._lastShellN = 0;

    // 每帧复用的临时对象与缓存：避免逐帧分配 Color、重复解析颜色字符串。
    // 颜色缓存直接存 THREE.Color，保证与原先 col.set(字符串) 的
    // sRGB→线性色彩管理结果完全一致（用 setRGB 会跳过换算而改变观感）。
    this._fxColor = new T.Color();
    this._fxFog = new T.Color(PALETTE3D.fog);
    this._flashColor = new T.Color(VIEW3D.enemy.hitFlashColor);
    this._colorCache = new Map();
    // 上一帧的曳光弹 / 粒子 / 弹壳数量，用于跳过空闲时的无谓 GPU 缓冲上传
    this._lastTracerN = 0;
    this._lastParticleM = 0;
  }

  /**
   * 取颜色字符串对应的 THREE.Color（带缓存）。
   * 世界粒子 / 曳光弹的颜色串来自配置，取值有限，缓存可完全消除逐帧的字符串解析。
   * @param {string} str 颜色串（rgba(...) 或 #hex）
   * @returns {THREE.Color} 缓存的颜色实例（只读，不要修改）
   */
  _colorOf(str) {
    let c = this._colorCache.get(str);
    if (c === undefined) {
      c = new this.THREE.Color(baseColorOf(str));
      this._colorCache.set(str, c);
    }
    return c;
  }

  /* ---------------- 关卡 / 实体构建 ---------------- */

  _teardownWorld() {
    this._prewarmed = false;
    if (this.level) {
      this.level.dispose();
      this.level = null;
    }
    // 释放世界掉落物品模型
    for (const rec of this._itemProps.values()) {
      for (const m of rec.models) {
        this.handle.scene.remove(m);
        m.traverse((o) => { if (!o.isMesh) return; o.geometry?.dispose?.(); const mat = o.material; if (Array.isArray(mat)) mat.forEach((x) => x?.dispose?.()); else mat?.dispose?.(); });
      }
    }
    this._itemProps.clear();
    // 释放地面掉落物模型
    if (this._groundProps) {
      for (const rec of this._groundProps.values()) {
        this.handle.scene.remove(rec.model);
        rec.model.traverse((o) => { if (!o.isMesh) return; o.geometry?.dispose?.(); const mat = o.material; if (Array.isArray(mat)) mat.forEach((x) => x?.dispose?.()); else mat?.dispose?.(); });
      }
      this._groundProps.clear();
    }
    // 释放地面贴花池（换局重建，避免跨局贴花残留）
    if (this._decalPool) {
      for (const slot of this._decalPool) {
        this.handle.scene.remove(slot.mesh);
        slot.mat.dispose();
      }
      this._decalPool = null;
    }
    if (this._decalGeo) { this._decalGeo.dispose(); this._decalGeo = null; }
    // 释放投掷物 / 烟幕 / 火焰池：跨局留着会把上一局的火带进新地图
    if (this._throwPool) {
      const dump = (obj) => {
        this.handle.scene.remove(obj);
        obj.traverse?.((o) => {
          if (!o.isMesh && !o.isSprite) return;
          o.geometry?.dispose?.();
          const mat = o.material;
          if (Array.isArray(mat)) mat.forEach((x) => x?.dispose?.()); else mat?.dispose?.();
        });
      };
      for (const s of this._throwPool.grenades) dump(s.mesh);
      for (const s of this._throwPool.enemyGrenades) dump(s.mesh);
      for (const cloud of this._throwPool.smokes) for (const s of cloud) dump(s.sp);
      for (const s of this._throwPool.fires) dump(s.mesh);
      this._throwPool = null;
    }
    if (this._grenadeGeo) { this._grenadeGeo.dispose(); this._grenadeGeo = null; }
    if (this._enemyGrenadeGeo) { this._enemyGrenadeGeo.dispose(); this._enemyGrenadeGeo = null; }
    if (this._fireGeo) { this._fireGeo.dispose(); this._fireGeo = null; }
    // 释放载具模型
    if (this._vehicleModels) {
      for (const m of this._vehicleModels.values()) {
        this.handle.scene.remove(m);
        m.traverse((o) => { if (!o.isMesh) return; o.geometry?.dispose?.(); const mat = o.material; if (Array.isArray(mat)) mat.forEach((x) => x?.dispose?.()); else mat?.dispose?.(); });
      }
      this._vehicleModels.clear();
    }
    // 释放数据终端模型
    for (const m of this._terminalModels.values()) {
      this.handle.scene.remove(m);
      m.traverse((o) => { if (!o.isMesh) return; o.geometry?.dispose?.(); const mat = o.material; if (Array.isArray(mat)) mat.forEach((x) => x?.dispose?.()); else mat?.dispose?.(); });
    }
    this._terminalModels.clear();
    // 释放 M-03 闸刀模型
    for (const m of this._switchModels.values()) {
      this.handle.scene.remove(m);
      m.traverse((o) => { if (!o.isMesh) return; o.geometry?.dispose?.(); const mat = o.material; if (Array.isArray(mat)) mat.forEach((x) => x?.dispose?.()); else mat?.dispose?.(); });
    }
    this._switchModels.clear();
    // 释放空投信标
    if (this._airdropBeacon) {
      this.handle.scene.remove(this._airdropBeacon);
      this._airdropBeacon.traverse((o) => { if (!o.isMesh) return; o.geometry?.dispose?.(); const mat = o.material; if (Array.isArray(mat)) mat.forEach((x) => x?.dispose?.()); else mat?.dispose?.(); });
      this._airdropBeacon = null;
    }
    // 伤害飘字精灵池是跨战局复用的，只隐藏不销毁
    if (this._dmgPool) {
      for (const slot of this._dmgPool) {
        slot.sprite.visible = false;
        slot.key = null;
      }
    }
    for (const model of this.enemyModels.values()) {
      this.handle.scene.remove(model);
      model.traverse((o) => { if (!o.isMesh) return; o.geometry?.dispose?.(); const mat = o.material; if (Array.isArray(mat)) mat.forEach((x) => x?.dispose?.()); else mat?.dispose?.(); });
    }
    this.enemyModels.clear();
    // 释放队友模型（P5-C2）
    for (const model of this.allyModels.values()) {
      this.handle.scene.remove(model);
      model.traverse((o) => { if (!o.isMesh) return; o.geometry?.dispose?.(); const mat = o.material; if (Array.isArray(mat)) mat.forEach((x) => x?.dispose?.()); else mat?.dispose?.(); });
    }
    this.allyModels.clear();
    if (this.viewmodel) {
      this.handle.camera.remove(this.viewmodel);
      this.viewmodel.traverse((o) => { if (!o.isMesh) return; o.geometry?.dispose?.(); const mat = o.material; if (Array.isArray(mat)) mat.forEach((x) => x?.dispose?.()); else mat?.dispose?.(); });
      this.viewmodel = null;
    }
    this._vmWeaponId = null;
    this._vmSig = null;
    this._vm = null;
    this._recoil = 0;
    // 换局/切枪时把枪模附加姿态归零：否则会带着上一局的下沉/甩枪偏移开局
    this._reload = 0;
    this._reloadRoll = 0;
    this._reloadPump = 0;
    this._swayX = 0;
    this._swayY = 0;
    this._lastYaw = null;
    this._lastPitch = null;
    // 弹壳属于上一局的世界数据，换局立刻清空实例
    if (this._shellMesh) {
      this._shellMesh.count = 0;
      this._lastShellN = 0;
    }
  }

  _buildWorld(world) {
    this._teardownWorld();
    this.world = world;
    this._crateState = null;
    if (this._rope) this._rope.visible = false; // 换局时收起上一局的绳子
    this.level = buildLevel(this.handle.scene, world.map, world.rng, this.handle.quality);
    this.addedContainers = new Set(world.map.containers.map((c) => c.id));
    for (const e of world.enemies) {
      const model = buildEnemyModel(e.typeId);
      this.handle.scene.add(model);
      this.enemyModels.set(e, model);
      // 真实角色模型异步接管；失败则这只敌人一直用程序化方块人。
      this._upgradeEnemyModel(model, ENEMY_GLB[e.typeId], null);
    }
    // P5-C2 本地 AI 队友：沿用敌人建模改色，按实体引用缓存，换局在 _teardownWorld 释放。
    for (const a of (world.squad || [])) {
      if (!a || a.isPlayer) continue;
      const model = buildAllyModel(a.color);
      this.handle.scene.add(model);
      this.allyModels.set(a, model);
      // 队友也要升级成 GLB —— 这一步漏了的话，敌人全是真角色、队友还是方块人，
      // 而且 _syncAllies 走的是"模型已存在就不再建"的分支，永远不会补上。
      this._upgradeEnemyModel(model, ALLY_GLB, a.color || null);
    }

    // POI：数据终端与空投信标（局内不变，建一次即可）
    for (const t of (world.map.terminals || [])) {
      const m = buildTerminalModel();
      m.position.set(t.x, 0, t.y);
      this.handle.scene.add(m);
      this._terminalModels.set(t, m);
    }
    // M-03：闸刀 POI（与终端同构，局内不重建，只由 _syncPois 改色）
    for (const sw of (world.map.switches || [])) {
      const m = buildSwitchModel();
      m.position.set(sw.x, 0, sw.y);
      this.handle.scene.add(m);
      this._switchModels.set(sw, m);
    }
    const a = world.map.airdrop;
    if (a) {
      // 半径直接吃逻辑半径（场景单位，与 buildExtractMarker 的 point.r 一致），不额外套 u()
      this._airdropBeacon = buildAirdropBeacon(a.r);
      this._airdropBeacon.position.set(a.x, 0, a.y);
      this.handle.scene.add(this._airdropBeacon);
    }
  }

  /* ---------------- 每帧同步 ---------------- */

  _syncCrates(world) {
    if (!this.level || !this.level.crateInstances) return;
    const rects = world.map.crateRects || [];
    const hp = world.map.crateRectHp;
    if (!this._crateState || this._crateState.length !== rects.length) {
      this._crateState = rects.map(() => ({ destroyed: false, hp: -1, max: 1 }));
    }
    for (let i = 0; i < rects.length; i += 1) {
      const r = rects[i];
      const st = this._crateState[i];
      if (st.hp < 0) {
        st.hp = hp ? hp[i] : (r.hp || 1);
        st.max = st.hp > 0 ? st.hp : 1;
      }
      if (r.destroyed && !st.destroyed) {
        st.destroyed = true;
        this.level.setCrateDestroyed(i);
      } else if (!st.destroyed && hp && hp[i] !== st.hp) {
        st.hp = hp[i];
        this.level.damageCrateVisual(i, st.hp / st.max);
      }
    }
  }

  /**
   * 绳索速降：只在下滑期间显示一根从平台锚点连到玩家身上的绳子。
   * 用一个以底端为原点的细圆柱，按长度缩放 + 四元数定向，避免每帧新建几何体。
   * @param {object} world 战局上下文
   * @returns {void}
   */
  _syncRope(world) {
    const T = this.THREE;
    const p = world.player;
    if (!p || !p.ropelling || !p.rope) {
      if (this._rope) this._rope.visible = false;
      return;
    }
    if (!this._rope) {
      const geo = new T.CylinderGeometry(1, 1, 1, 5, 1, true);
      geo.translate(0, 0.5, 0); // 底面贴原点，scale.y 即绳长
      this._rope = new T.Mesh(geo, new T.MeshBasicMaterial({ color: 0xC8A96A }));
      this._rope.visible = false;
      this.handle.scene.add(this._rope);
    }
    // 锚点固定在出发处的平台上方，末端跟着玩家走
    const ax = p.rope.ax;
    const ay = p.rope.ay;
    const topY = u(VIEW3D.platformHeight + 1.0);
    const bx = p.x;
    const by = p.y;
    const botY = u(p.elevation || 0) + u(1.15);
    const dx = ax - bx;
    const dy = topY - botY;
    const dz = ay - by;
    const len = Math.hypot(dx, dy, dz) || 0.001;
    this._rope.position.set(bx, botY, by);
    this._rope.quaternion.setFromUnitVectors(
      this._ropeUp || (this._ropeUp = new T.Vector3(0, 1, 0)),
      (this._ropeDir || (this._ropeDir = new T.Vector3())).set(dx / len, dy / len, dz / len),
    );
    this._rope.scale.set(u(0.04), len, u(0.04));
    this._rope.visible = true;
  }

  _syncVehicles(world) {
    if (!this.level) return;
    const list = world.map.vehicles || [];
    if (!this._vehicleModels) this._vehicleModels = new Map();
    for (const v of list) {
      let m = this._vehicleModels.get(v);
      if (!m) {
        m = buildVehicleModel();
        this.handle.scene.add(m);
        this._vehicleModels.set(v, m);
      }
      m.position.set(v.x, 0, v.y);
      m.rotation.y = yawFromAngle(v.angle);
    }
  }

  _syncEnemies(world, dt = 0) {
    // 动态新增的容器（如敌人死亡后留下的尸体）补入关卡
    for (const c of world.map.containers) {
      if (!this.addedContainers.has(c.id)) {
        this.addedContainers.add(c.id);
        if (this.level) this.level.addContainer(c);
      }
    }
    const flashColor = this._flashColor;
    for (const e of world.enemies) {
      let model = this.enemyModels.get(e);
      if (!model) {
        model = buildEnemyModel(e.typeId);
        this.handle.scene.add(model);
        this.enemyModels.set(e, model);
      }
      if (e.dead) {
        model.visible = false;
        continue;
      }
      model.visible = true;
      // 高程：站在架高平台上的敌人要跟着台面抬高，否则会陷进平台里
      model.position.set(e.x, u(elevationAt(world.map, e.x, e.y)), e.y);
      model.rotation.y = yawFromAngle(e.angle);
      this._syncEnemyDetail(model, e, world);
      // 枪口火光
      model.userData.flash.visible = e.muzzleFlash > 0;
      // 角色动画：走路时迈腿摆臂，静止时呼吸起伏 + 头部小幅扫视
      this._animateEnemy(model, e, world, dt);
      // 受击闪红（通过自发光）：仅在该值变化时写材质，空闲帧直接跳过。
      // P5 鹰眼标记也走这一层：标记态是稳定的红色自发光，与受击短闪共用同一组材质槽，
      // 但缓存键里带上标记位，两种状态切换时一定重写一次（不会卡在上一态）。
      const hf = e.hurtFlash > 0 ? Math.min(1, e.hurtFlash / 0.25) : 0;
      const marked = (e.marked || 0) > 0 ? 1 : 0;
      const fxKey = Math.round(hf * 10) + marked * 100;
      if (model.userData._lastFx !== fxKey) {
        model.userData._lastFx = fxKey;
        for (const m of model.userData.mats) {
          if (marked) m.emissive.setHex(0x7a0f12).multiplyScalar(1.8);
          else if (hf > 0) m.emissive.copy(flashColor).multiplyScalar(0.6 * hf);
          // #P0-2：空闲帧还原到敌人底亮度自发光（而非纯黑），保证暗处可见
          else if (m.userData.baseEmissive) m.emissive.copy(m.userData.baseEmissive);
          else m.emissive.setRGB(0, 0, 0);
        }
      }
    }
  }

  /**
   * P0-3：按画质/距离隐藏程序化角色的细节小件。
   *
   * 这些部件（脸、眼、眉、鼻、耳罩、帽檐、弹匣袋、肩甲、背包顶）只在近距离可辨；
   * low 常隐、mid 14m 内保留、high 28m 内保留。GLB 角色接管后程序化部件已整体隐藏，
   * 这里直接跳过，避免和 GLB 的可见性打架。
   * @param {THREE.Group} model 角色模型
   * @param {object} actor 敌人/队友实体
   * @param {object} world 战局上下文
   * @returns {void}
   */
  _syncEnemyDetail(model, actor, world) {
    const list = model.userData.detailMeshes;
    if (!list || !list.length || model.userData.glbRoot) return;
    const p = world && world.player;
    if (!p) return;
    const quality = this.handle.quality || 'high';
    let show;
    if (quality === 'low') {
      show = false;
    } else {
      const limit = u(quality === 'mid' ? 14 : 28);
      const d = Math.hypot(actor.x - p.x, actor.y - p.y);
      show = d <= limit;
    }
    const key = show ? 1 : 0;
    if (model.userData._detailShown === key) return;
    model.userData._detailShown = key;
    for (const m of list) m.visible = show;
  }

  /**
   * 同步本地 AI 队友模型（P5-C2）：位置 / 朝向 / 枪口火光 / 受击闪 / 走路动画，
   * 复用与敌人同一套 _animateEnemy。倒地（dead）的队友隐藏，复活后自动出现。
   * @param {object} world 战局上下文
   * @param {number} dt 帧间隔秒
   * @returns {void}
   */
  _syncAllies(world, dt = 0) {
    const flashColor = this._flashColor;
    for (const a of (world.squad || [])) {
      if (!a || a.isPlayer) continue;
      let model = this.allyModels.get(a);
      if (!model) {
        model = buildAllyModel(a.color);
        this.handle.scene.add(model);
        this.allyModels.set(a, model);
        // 队友与敌人用同一套角色模型，靠 a.color 染色区分（绿=友军，与程序化版本同一约定）。
        this._upgradeEnemyModel(model, ALLY_GLB, a.color || null);
      }
      if (a.dead) {
        model.visible = false;
        continue;
      }
      model.visible = true;
      model.position.set(a.x, u(elevationAt(world.map, a.x, a.y)), a.y);
      model.rotation.y = yawFromAngle(a.angle);
      this._syncEnemyDetail(model, a, world);
      model.userData.flash.visible = a.muzzleFlash > 0;
      this._animateEnemy(model, a, world, dt);
      // 受击闪红（友军不进鹰眼标记逻辑，缓存键只含受击强度）
      const hf = a.hurtFlash > 0 ? Math.min(1, a.hurtFlash / 0.25) : 0;
      const fxKey = Math.round(hf * 10);
      if (model.userData._lastFx !== fxKey) {
        model.userData._lastFx = fxKey;
        for (const m of model.userData.mats) {
          if (hf > 0) m.emissive.copy(flashColor).multiplyScalar(0.6 * hf);
          else if (m.userData.baseEmissive) m.emissive.copy(m.userData.baseEmissive);
          else m.emissive.setRGB(0, 0, 0);
        }
      }
    }
  }

  /**
   * 把一个已存在的程序化敌人模型升级成骨骼 GLB 角色（异步、可失败、可降级）。
   *
   * 为什么是"升级"而不是"直接构建"：程序化模型是同步的，首帧一定存在；
   * GLB 是网络资源，可能慢、可能 404。先用方块人顶上，资源到了再原地接管，
   * 这样「弱网 / 资源缺失」永远不会变成空场或白屏。
   *
   * @param {THREE.Group} model buildEnemyModel 产出的模型
   * @param {string} rel 相对 assets/ 的 GLB 路径
   * @param {string|null} tint 友军染色（敌人传 null）
   * @returns {void}
   */
  _upgradeEnemyModel(model, rel, tint) {
    if (!rel || model.userData.glbRoot || !glbEnabled()) return;
    const T = this.THREE;
    loadGLB(rel).then((gltf) => {
      if (!gltf || model.userData.glbRoot) return;
      const root = cloneSkinned(gltf.scene);
      // ⚠ 朝向对齐：程序化模型（models.js 头部约定）一律面朝 -Z，外层每帧写
      // `model.rotation.y = yawFromAngle(actor.angle)` 也是按 -Z 前向算的。
      // 但 Kenney 的 GLB 是面朝 +Z 建的（实测：yaw=0 相机看到正脸，yaw=π 看到后脑勺），
      // 不补这 180° 的话，所有敌人和队友都会**背对玩家**——AI 逻辑朝向明明正确，
      // 画面上却像全体在逃跑。这里在 GLB 根上转半圈，把它的前向掰到 -Z，
      // 与程序化模型、枪口火光挂点（-Z 侧）保持同一套约定。
      // 用 += 而不是 =：保留 glTF 作者可能写在根节点上的初始旋转。
      root.rotation.y += Math.PI;
      const mats = [];
      root.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true;
        o.receiveShadow = true;
        // 骨骼网格做视锥剔除会在动画把四肢撑出静态包围盒时被整块裁掉，直接关掉
        // （每只角色只有 2 个 mesh，代价可以忽略）。
        o.frustumCulled = false;
        const srcMat = Array.isArray(o.material) ? o.material[0] : o.material;
        if (!srcMat || !srcMat.map) return;
        // 与容器同一条理由（见 glbLambert 注释）：Standard 在本作灯光下会过曝偏色。
        // gain 0.62 + 自发光压到 1/8，是为了让军服还是军绿，而不是被自发光染成薄荷绿。
        const m = glbLambert(srcMat, {
          color: tint || 0xffffff,
          gain: ENEMY_GLB_GAIN,
          emissive: VIEW3D.enemyEmissive,
          emissiveIntensity: VIEW3D.enemyEmissiveIntensity * 0.12,
        });
        m.userData.baseEmissive = m.emissive.clone();
        o.material = m;
        mats.push(m);
      });
      if (!mats.length) return;

      // 身高对齐程序化模型：直接量现成模型的包围盒，自动继承精英/冲锋兵的体型差异，
      // 也免得在两处各写一份尺寸表（那正是"改了这边忘了那边"的经典来源）。
      model.updateMatrixWorld(true);
      const target = new T.Box3().setFromObject(model).getSize(new T.Vector3()).y || u(1.7);
      const pre = new T.Box3().setFromObject(root).getSize(new T.Vector3());
      root.scale.setScalar(target / (pre.y || 1));
      root.updateMatrixWorld(true);
      root.position.y -= new T.Box3().setFromObject(root).min.y; // 脚底贴地

      // 程序化部件整体隐藏（保留在树上，不销毁：切回 ?glb=0 时无需重建）
      for (const c of model.children) c.visible = false;

      // 枪口火光：GLB 没有枪口锚点，按人体比例挂一片加色面片
      const flash = new T.Mesh(
        new T.PlaneGeometry(u(0.3), u(0.3)),
        new T.MeshBasicMaterial({
          color: 0xffdca0, transparent: true, opacity: 0.95,
          depthWrite: false, blending: T.AdditiveBlending,
        }),
      );
      flash.position.set(u(0.14), u(1.18), -u(0.62));
      flash.visible = false;
      model.add(root, flash);

      const mixer = new T.AnimationMixer(root);
      const actions = {};
      for (const clip of gltf.animations || []) actions[clip.name] = mixer.clipAction(clip);
      model.userData.glbRoot = root;
      model.userData.mats = mats;
      model.userData.flash = flash;
      model.userData.mixer = mixer;
      model.userData.actions = actions;
      model.userData.clip = '';
      model.userData._lastFx = -1; // 换过材质，强制重写一次自发光，别沿用旧缓存键
    });
  }

  /**
   * 骨骼角色的动画：按 wantsMove 在 idle / walk 之间交叉淡入。
   *
   * GLB 接管后不再执行关节动画（_animateEnemy）—— 两套同时跑会互相覆盖骨骼。
   * @param {THREE.Group} model 角色模型
   * @param {object} e 实体（只读）
   * @param {number} dt 帧间隔秒
   * @returns {void}
   */
  _animateSkinned(model, e, dt) {
    const ud = model.userData;
    const want = e.wantsMove ? 'walk' : 'idle';
    if (ud.clip !== want) {
      const next = ud.actions[want] || ud.actions.idle;
      const prev = ud.actions[ud.clip];
      if (next) {
        next.reset().setEffectiveWeight(1).play();
        if (prev && prev !== next) prev.crossFadeTo(next, 0.2, false);
        ud.clip = want;
      }
    }
    ud.mixer.update(dt);
  }

  /**
   * 敌人角色动画（纯程序化，无骨骼无外部资源）。
   * 行走：walkPhase 驱动双腿反相摆动 + 屈膝 + 双臂反向摆动 + 躯干上下起伏与轻微侧倾。
   * 待机：低频呼吸起伏 + 手臂自然垂放 + 头部缓慢扫视（交战时改为紧盯目标，不晃头）。
   * @param {THREE.Group} model 敌人模型
   * @param {object} e 敌人实体（只读）
   * @param {object} world 战局上下文
   * @param {number} dt 帧间隔秒
   * @returns {void}
   */
  _animateEnemy(model, e, world, dt) {
    // GLB 角色接管后走骨骼动画；两套动画绝不能同时对同一副骨架生效。
    if (model.userData.mixer) {
      this._animateSkinned(model, e, dt);
      return;
    }
    const p = model.userData.parts;
    if (!p) return;
    const t = world.time || 0;
    const seed = (e.id || 0) * 1.7; // 让每个敌人的相位错开，避免整齐划一
    const moving = Boolean(e.wantsMove);

    if (moving) {
      const sw = Math.sin(e.walkPhase || 0) * 0.55;
      p.legs[0].hip.rotation.x = sw;
      p.legs[1].hip.rotation.x = -sw;
      // 后摆的腿屈膝更多，前摆时伸直 —— 这样才像"迈步"而不是"钟摆"
      p.legs[0].knee.rotation.x = Math.max(0, -sw) * 0.95;
      p.legs[1].knee.rotation.x = Math.max(0, sw) * 0.95;
      p.arms[0].shoulder.rotation.x = -1.0 + sw * 0.25;
      p.arms[1].shoulder.rotation.x = -1.0 - sw * 0.25;
      p.arms[0].shoulder.rotation.z = 0.35;
      p.arms[1].shoulder.rotation.z = -0.30;
      p.arms[0].elbow.rotation.x = -0.55;
      p.arms[1].elbow.rotation.x = -0.65;
      p.torso.position.y = p.torsoBaseY + Math.abs(Math.sin(e.walkPhase || 0)) * u(0.035);
      p.torso.rotation.z = Math.sin(e.walkPhase || 0) * 0.03;
      p.torso.rotation.x = 0.06; // 行进时略微前倾
      p.head.rotation.y *= Math.max(0, 1 - dt * 6); // 走路时回正头部
    } else {
      // 呼吸：躯干极缓慢起伏 + 轻微缩放，手臂随呼吸微动
      const breath = Math.sin(t * 1.5 + seed);
      for (const leg of p.legs) {
        leg.hip.rotation.x *= Math.max(0, 1 - dt * 8);
        leg.knee.rotation.x *= Math.max(0, 1 - dt * 8);
      }
      p.arms[0].shoulder.rotation.x = -1.1 + breath * 0.03;
      p.arms[1].shoulder.rotation.x = -1.15 - breath * 0.03;
      p.arms[0].shoulder.rotation.z = 0.35;
      p.arms[1].shoulder.rotation.z = -0.30;
      p.arms[0].elbow.rotation.x = -0.55;
      p.arms[1].elbow.rotation.x = -0.65;
      p.torso.position.y = p.torsoBaseY + breath * u(0.012);
      p.torso.rotation.z *= Math.max(0, 1 - dt * 8);
      p.torso.rotation.x = 0.02;
      // 交战时紧盯目标不晃头，非交战才缓慢扫视（更有"哨戒"的感觉）
      if (e.state === 'COMBAT' || e.state === 'SUSPICIOUS') {
        p.head.rotation.y *= Math.max(0, 1 - dt * 6);
      } else {
        p.head.rotation.y = Math.sin(t * 0.6 + seed) * 0.4;
      }
    }
  }

  _syncCamera(player, dt, world) {
    const cam = this.handle.camera;
    // 眼高插值（蹲下/卧倒降低，跳跃抬高）
    // 眼高 = 姿态眼高 + 所处平台高程 + 离地高度（跳跃/翻越）− 落地瞬间的下沉
    // 驾驶时坐进驾驶室（眼高更高），其余情况一律按姿态算 —— 三档姿态共用同一公式。
    const stanceEye = player.prone
      ? VIEW3D.eyeProne
      : (player.crouching ? VIEW3D.eyeCrouch : VIEW3D.eyeStand);
    const targetEye = player.vehicle
      ? u(VEHICLE.eyeHeight + (player.elevation || 0))
      : u(stanceEye + (player.elevation || 0) + (player.jumpZ || 0) - (player.landDip || 0));
    const eyek = 1 - Math.exp(-VIEW3D.eyeLerp * dt);
    this.eyeHeight += (targetEye - this.eyeHeight) * eyek;

    // 朝向：用 quaternion（yaw 绕 Y × pitch 绕局部 X）而非 Euler 分轴，
    // 避免 yaw≈±90° 时 pitch 被万向锁吞掉（否则某些朝向无法上下看，且曳光弹不随准星俯仰）。
    // 等价水平前向仍为 (cos a, 0, sin a)，与逻辑 hitscan 一致。
    const yaw = yawFromAngle(player.angle);
    const pitch = (player.pitch || 0) + (player.recoilPitch || 0);
    this._qYaw.setFromAxisAngle(this._camUp, yaw);
    this._qPitch.setFromAxisAngle(this._camRight, pitch);
    cam.quaternion.copy(this._qYaw).multiply(this._qPitch);

    // 震屏：消费 world.shake 并衰减（避免在更新循环中转移，渲染层一次性处理）
    // 减少动态效果时完全不震（P1-7）：晕屏/光敏玩家对镜头抖动最敏感，这一条必须归零。
    let sx = 0;
    let sy = 0;
    let sz = 0;
    if (world.shake > 0.01) {
      if (this._reducedMotion) {
        world.shake = 0; // 直接清掉，避免残留值在关闭无障碍时突然补一次抖动
      } else {
        const amt = (Math.min(16, world.shake) / 16) * u(VIEW3D.fx.shakeMax);
        sx = (Math.random() - 0.5) * 2 * amt;
        sy = (Math.random() - 0.5) * 2 * amt;
        sz = (Math.random() - 0.5) * 2 * amt;
        world.shake = Math.max(0, world.shake * Math.exp(-VIEW3D.fx.shakeDecay * dt));
      }
    }
    // P19：探头只改相机横向偏移（命中射线仍从身体中轴发出，判定比视觉更严格）。
    const leanOff = Number(player.leanT) || 0;
    cam.position.set(
      player.x + sx + (-Math.sin(yaw)) * leanOff,
      this.eyeHeight + sy,
      player.y + sz + Math.cos(yaw) * leanOff,
    );

    // FOV（ADS 时收窄到 fovAds，否则用玩家可调的 baseFov）
    // 车速越快 FOV 越开（速度感），步行 / ADS 时用基准值
    const driveFov = player.vehicle
      ? this.baseFov + VEHICLE.fovBoost * Math.min(1, Math.abs(player.vehicle.speed || 0) / VEHICLE.maxSpeed)
      : this.baseFov;
    // P4-C2：按 adsT 插值而不是布尔切换 —— 与枪模/散布/准星共用同一个过渡进度。
    const adsBlend = Math.max(0, Math.min(1,
      player.adsT != null ? player.adsT : (player.ads ? 1 : 0)));
    const targetFov = (player.currentWeapon && !player.vehicle)
      ? driveFov + (VIEW3D.fovAds - driveFov) * adsBlend
      : driveFov;
    const fovk = 1 - Math.exp(-VIEW3D.fovLerp * dt);
    this.fov += (targetFov - this.fov) * fovk;
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
  }

  _syncViewmodel(player, dt) {
    // 武器切换 → 重建视图模型。P6 起附件也改外形，所以签名要带上附件列表：
    // 同一把枪换/卸配件也要重建，否则枪上永远停着上一局的消音器。
    const wpn = player.currentWeapon;
    const wid = wpn ? wpn.def.id : 'pistol';
    const mods = (wpn && wpn.def && wpn.def.installedMods) || [];
    const vmSig = wid + '|' + mods.join(',');
    if (!this.viewmodel || this._vmSig !== vmSig) {
      if (this.viewmodel) this.handle.camera.remove(this.viewmodel);
      this._vmWeaponId = wid;
      this._vmSig = vmSig;
      this.viewmodel = buildViewmodel(wid, mods);
      // 用 GLB 外壳替换枪身块（只换外形，枪管/配件仍由 vmparams 驱动）。
      if (glbEnabled()) upgradeViewmodel(this.viewmodel, wid);
      // 枪模整体缩放（P4）：模型按真实尺寸建，但放到镜头跟前会占满半屏，这里统一缩一档。
      this.viewmodel.scale.setScalar(VIEW3D.viewmodel.scale || 1);
      this._vm = null;
      this._recoil = 0;
      this.handle.camera.add(this.viewmodel);
    }
    const g = this.viewmodel;
    const vm = VIEW3D.viewmodel;
    // P4-C2：枪模姿态同样按 adsT 插值，保证"抬枪"是连续动作而不是瞬移。
    const vmBlend = Math.max(0, Math.min(1,
      player.adsT != null ? player.adsT : (player.ads ? 1 : 0)));
    const tgt = {
      x: vm.base.x + (vm.ads.x - vm.base.x) * vmBlend,
      y: vm.base.y + (vm.ads.y - vm.base.y) * vmBlend,
      z: vm.base.z + (vm.ads.z - vm.base.z) * vmBlend,
    };
    const tgtRot = {
      x: vm.baseRot.x + (vm.adsRot.x - vm.baseRot.x) * vmBlend,
      y: vm.baseRot.y + (vm.adsRot.y - vm.baseRot.y) * vmBlend,
      z: vm.baseRot.z + (vm.adsRot.z - vm.baseRot.z) * vmBlend,
    };
    const k = 1 - Math.exp(-vm.lerp * dt);
    if (!this._vm) {
      this._vm = { x: u(tgt.x), y: u(tgt.y), z: u(tgt.z), rx: tgtRot.x, ry: tgtRot.y, rz: tgtRot.z };
    }
    this._vm.x += (u(tgt.x) - this._vm.x) * k;
    this._vm.y += (u(tgt.y) - this._vm.y) * k;
    this._vm.z += (u(tgt.z) - this._vm.z) * k;
    this._vm.rx += (tgtRot.x - this._vm.rx) * k;
    this._vm.ry += (tgtRot.y - this._vm.ry) * k;
    this._vm.rz += (tgtRot.z - this._vm.rz) * k;

    // 后坐：开火瞬时抬升，随后回弹
    const firing = player.muzzleFlash > 0;
    this._recoil += ((firing ? 1 : 0) - this._recoil) * (1 - Math.exp(-vm.recoilLerp * dt));
    const recoilZ = u(vm.recoilKick) * this._recoil;
    const recoilY = u(vm.recoilKick * 0.5) * this._recoil;
    const recoilRot = vm.recoilRot * this._recoil;

    // 换弹（P4-C3 三段节奏）：姿态由 reload.js 的纯函数曲线给出 ——
    // 退弹匣时枪身沉到最低并侧翻最多，插弹匣回抬一点，拉机柄时沿枪轴抖一记再回正。
    // 曲线首尾都是 0，所以"开始/结束"本身没有跳变；只有被切枪或进车打断时，
    // 才用 reloadLerp 把残留姿态衰减回去（那时玩家注意力已不在枪上，平滑即可）。
    const rw = player.currentWeapon;
    const reloading = !!(rw && rw.reloading);
    if (reloading) {
      const pose = reloadPose(reloadProgress(rw.reloadTimer, rw.reloadTotal));
      this._reload = pose.drop;
      this._reloadRoll = pose.roll;
      this._reloadPump = pose.pump;
    } else {
      const rk = 1 - Math.exp(-vm.reloadLerp * dt);
      this._reload += (0 - this._reload) * rk;
      this._reloadRoll += (0 - this._reloadRoll) * rk;
      this._reloadPump += (0 - this._reloadPump) * rk;
    }
    const reloadDrop = vm.reloadDrop * this._reload;
    const reloadRoll = vm.reloadRoll * this._reloadRoll;
    const reloadPump = u(vm.reloadPump || 0) * this._reloadPump;

    // 转身惯性（P0-3）：把视角的**角速度**低通成"甩枪速度"，再乘 swayAmp 变成枪模滞后位移。
    // 只动枪模、不动相机 —— 相机滞后会直接变成晕屏，这条线不能越。
    // 用 rad/s 而非"每帧增量"，否则同一段转身在 30fps / 60fps 下摆幅会差一倍。
    const yawNow = player.angle || 0;
    const pitchNow = player.pitch || 0;
    let dyaw = yawNow - (this._lastYaw == null ? yawNow : this._lastYaw);
    while (dyaw > Math.PI) dyaw -= Math.PI * 2; // 跨 ±π 时不能算成"猛地转了 6 弧度"
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    const dpitch = pitchNow - (this._lastPitch == null ? pitchNow : this._lastPitch);
    this._lastYaw = yawNow;
    this._lastPitch = pitchNow;
    const invDt = 1 / Math.max(1e-4, dt);
    const swayK = 1 - Math.exp(-vm.swayLerp * dt);
    this._swayX += (dyaw * invDt - this._swayX) * swayK;
    this._swayY += (dpitch * invDt - this._swayY) * swayK;
    // 乘 1/60 把"角速度"折算回单帧角度：与 60fps 下的原始手感一致，同时保持帧率无关
    const swayX = this._swayX * (1 / 60) * vm.swayAmp * u(1);
    const swayY = this._swayY * (1 / 60) * vm.swayAmp * u(1);

    // 摆动（待机呼吸 + 移动起伏 + 侧倾）
    const moving = player.moving ? 1 : 0;
    const bobSpeed = moving ? vm.bobMoveSpeed : vm.bobIdleSpeed;
    const bobAmp = moving ? vm.bobMoveAmp : vm.bobIdleAmp;
    this._bobT += dt * bobSpeed;
    const bobX = Math.cos(this._bobT) * u(bobAmp);
    const bobY = Math.abs(Math.sin(this._bobT)) * u(bobAmp) * (moving ? 1 : 0.5);
    const roll = Math.sin(this._bobT * 0.5) * u(vm.bobRollAmp) * moving;

    const ms = this._motionScale; // 减少动态效果时 = 0（换弹下沉保留：那是信息性动作，不是晕动源）
    g.position.set(
      this._vm.x + bobX * ms + swayX * ms,
      this._vm.y + bobY * ms - recoilY * ms + swayY * ms - u(reloadDrop),
      this._vm.z - recoilZ * ms + reloadPump,
    );
    g.rotation.set(this._vm.rx + recoilRot * ms, this._vm.ry, this._vm.rz + (roll * ms) + reloadRoll);

    // 枪口火光
    const flash = player.muzzleFlash > 0;
    g.userData.flash.visible = flash;
    if (flash) g.userData.flash.scale.setScalar(0.6 + Math.random() * 0.6);
  }

  _syncFx(world, dt) {
    const col = this._fxColor;
    const fog = this._fxFog;

    // 曳光弹（P0-5）：每条弹道展开成一块正对镜头的四边形。
    // 中心线与旧实现逐位一致：敌人弹道抬到胸高；玩家自己的弹道从相机眼高发出、
    // 终点抬到命中高度，所以水平方向恰好沿屏幕中心准星射出。
    const tracers = world.tracers || [];
    const tp = this._tracerGeo.attributes.position.array;
    const tc = this._tracerGeo.attributes.color.array;
    const ends = this._tracerEnds;
    const hT = u(1.15);
    const player = world.player;
    const eyeH = this.eyeHeight;
    const cam = this.handle.camera;
    if (cam && typeof cam.getWorldPosition === 'function') cam.getWorldPosition(this._camPos);
    const camPos = this._camPos;
    // 曳光弹宽度：用**屏幕宽度**（不是世界宽度）。
    // 为什么：世界宽 5cm 的弹道在 30m 外只有 1px，而在 0.7m 处却有 20px ——
    // 同一发子弹近处像根管子、远处像不存在。屏幕宽则任何距离都稳定在 ~3px，
    // 既看得见又不会在枪口糊成一条宽带。tracerWidth 作为像素宽的来源（0.05 → 每侧 1.6px）。
    const Hpx = (this.canvas && this.canvas.clientHeight) || 375;
    const fovRad = (((cam && cam.fov) || VIEW3D.fov) * Math.PI) / 180;
    const pxPerUnit = Math.tan(fovRad * 0.5) / Math.max(1, Hpx / 2); // 每单位宽度 / 距离 → 像素
    const halfWpx = Math.max(1.6, (VIEW3D.fx.tracerWidth || 0.05) * 32);
    let n = 0;
    for (let i = 0; i < tracers.length && n < this._tracerMax; i += 1) {
      const tr = tracers[i];
      const c = this._colorOf(tr.color);
      let ax; let ay; let az; let bx; let by; let bz;
      if (tr.player && player) {
        // 玩家曳光弹：从「相机中心（眼位）」发出、终点精确落在 3D 命中点
        // (tr.x2, tr.h, tr.y2)。弹道逻辑本就取自相机眼高、与准星逐字对齐（同一条射线），
        // 所以曳光弹起点也应回到相机中心，而非 viewmodel 枪口——否则枪口在屏幕右下偏移，
        // 会让玩家误以为「子弹从右边飞出 / 弹着点偏右」。viewmodel 的枪口偏移只做视觉表现
        // （枪口火光仍挂在枪管上），绝不参与弹道与曳光弹起点。
        // 沿相机前向略微前移，避免起点贴脸被近裁剪面吞掉、也更接近真实出膛位置。
        const fwd = this._camFwd || (this._camFwd = new this.THREE.Vector3());
        if (cam && typeof cam.getWorldDirection === 'function') cam.getWorldDirection(fwd);
        else fwd.set(Math.cos(player.angle || 0), 0, Math.sin(player.angle || 0));
        const fwdLen = 14; // ≈ 0.7m，仅用于把起点推出近裁剪面
        ax = player.x + fwd.x * fwdLen;
        ay = eyeH + fwd.y * fwdLen;
        az = player.y + fwd.z * fwdLen;
        bx = tr.x2;
        by = (tr.h != null) ? tr.h : eyeH;
        bz = tr.y2;
      } else {
        // 敌人曳光弹：起点取枪口眼高 h1，终点精确落在 3D 命中高度 h（敌我同源）。
        // 缺字段时回退到固定胸高 hT（向后兼容旧数据）。
        ax = tr.x1; ay = (tr.h1 != null) ? tr.h1 : hT; az = tr.y1;
        bx = tr.x2; by = (tr.h != null) ? tr.h : hT; bz = tr.y2;
      }
      const dx = bx - ax;
      const dy = by - ay;
      const dz = bz - az;
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-4) continue; // 退化弹道（零长度）没有可画的面积
      // 中心线缓存：与旧实现的 position 缓冲布局完全一致，测试/探针可直接读
      const oe = n * 6;
      ends[oe] = ax; ends[oe + 1] = ay; ends[oe + 2] = az;
      ends[oe + 3] = bx; ends[oe + 4] = by; ends[oe + 5] = bz;

      // 侧向 = dir × (相机 → 中点)：四边形因此永远正对镜头，任何角度都不会被看成一条边
      const mx = (ax + bx) * 0.5;
      const my = (ay + by) * 0.5;
      const mz = (az + bz) * 0.5;
      const vx = camPos.x - mx;
      const vy = camPos.y - my;
      const vz = camPos.z - mz;
      let sxv = dy * vz - dz * vy;
      let syv = dz * vx - dx * vz;
      let szv = dx * vy - dy * vx;
      let sl = Math.hypot(sxv, syv, szv);
      if (sl < 1e-6) {
        // 弹道几乎正对镜头（自己开枪的常见情形）：屏幕投影本就退化成点，
        // 任取一个与弹道垂直的方向收边即可 —— 视觉等价，但不能出 NaN。
        sxv = -dy; syv = dx; szv = 0;
        sl = Math.hypot(sxv, syv, szv);
        if (sl < 1e-6) { sxv = 1; syv = 0; szv = 0; sl = 1; }
      }
      const o = n * 18; // 6 顶点 × 3 分量
      // v0 = A+w, v1 = A-w, v2 = B-w, v3 = B+w；两个三角形 (v0,v1,v2) + (v0,v2,v3)
      // 两端各按「自身到相机的距离」换算宽度：否则离眼 0.7m 的近端会糊成一条宽带。
      const halfWA = Math.hypot(camPos.x - ax, camPos.y - ay, camPos.z - az) * pxPerUnit * halfWpx;
      const halfWB = Math.hypot(camPos.x - bx, camPos.y - by, camPos.z - bz) * pxPerUnit * halfWpx;
      const kA = halfWA / sl;
      const kB = halfWB / sl;
      const wax = sxv * kA; const way = syv * kA; const waz = szv * kA;
      const wbx = sxv * kB; const wby = syv * kB; const wbz = szv * kB;
      tp[o] = ax + wax; tp[o + 1] = ay + way; tp[o + 2] = az + waz;
      tp[o + 3] = ax - wax; tp[o + 4] = ay - way; tp[o + 5] = az - waz;
      tp[o + 6] = bx - wbx; tp[o + 7] = by - wby; tp[o + 8] = bz - wbz;
      tp[o + 9] = ax + wax; tp[o + 10] = ay + way; tp[o + 11] = az + waz;
      tp[o + 12] = bx - wbx; tp[o + 13] = by - wby; tp[o + 14] = bz - wbz;
      tp[o + 15] = bx + wbx; tp[o + 16] = by + wby; tp[o + 17] = bz + wbz;
      for (let k = 0; k < 6; k += 1) {
        const q = o + k * 3;
        tc[q] = c.r; tc[q + 1] = c.g; tc[q + 2] = c.b;
      }
      n += 1;
    }
    this._tracerGeo.setDrawRange(0, n * this._tracerVerts);
    // 空闲帧（本帧与上一帧都没有曳光弹）跳过缓冲上传
    if (n > 0 || this._lastTracerN > 0) {
      this._tracerGeo.attributes.position.needsUpdate = true;
      this._tracerGeo.attributes.color.needsUpdate = true;
    }
    this._lastTracerN = n;

    // 碎片 / 血点（沿 XZ，带轻微高度起伏；用颜色向雾色淡出模拟消失）
    const parts = world.particles || [];
    const pp = this._particleGeo.attributes.position.array;
    const pc = this._particleGeo.attributes.color.array;
    const hP = u(1.0);
    let m = 0;
    for (let i = 0; i < parts.length && m < this._particleMax; i += 1) {
      const p = parts[i];
      const lf = 1 - Math.min(1, p.t / p.life);
      col.copy(this._colorOf(p.color)).lerp(fog, 1 - lf);
      const o = m * 3;
      // 粒子若自带高度（h，来自 3D 命中路径的命中高度）则用之，否则回退到固定基准 hP。
      // 注意：必须用 != null 而非 ||，否则 h===0（地面命中）会被误判为假值而走兜底。
      const baseH = (p.h != null) ? p.h : hP;
      pp[o] = p.x;
      pp[o + 1] = baseH + Math.sin(p.t * 6 + p.x) * u(0.12);
      pp[o + 2] = p.y;
      pc[o] = col.r; pc[o + 1] = col.g; pc[o + 2] = col.b;
      m += 1;
    }
    this._particleGeo.setDrawRange(0, m);
    // 空闲帧（本帧与上一帧都没有粒子）跳过缓冲上传
    if (m > 0 || this._lastParticleM > 0) {
      this._particleGeo.attributes.position.needsUpdate = true;
      this._particleGeo.attributes.color.needsUpdate = true;
    }
    this._lastParticleM = m;

    // 弹壳接在末尾：它自己也走"数量比对 + 空闲帧跳过上传"的同一套优化写法
    this._syncShells(world);
  }

  /**
   * 弹壳渲染（P0-1）。
   *
   * 逻辑侧（combat.js）只维护 x / y / 水平速度 / 自旋，弹壳因此在逻辑上"存在"却从没被画出来。
   * 这里把同一份数据翻译成可见的抛壳：从胸口高度抛出、受重力落回地面、落地后静止，
   * 末段收缩并向雾色淡出。
   *
   * 全部走一个 InstancedMesh（一次 draw call），实例数由 config 的 shellMax 钳住，
   * 不开火时 count=0，零绘制开销。
   * @param {object} world 战局上下文
   * @returns {void}
   */
  _syncShells(world) {
    const list = world.shells || [];
    const fx = VIEW3D.fx;
    const baseHalf = u(fx.shellSize);
    const fadeStart = fx.shellFadeStart != null ? fx.shellFadeStart : 0.72;
    const grav = fx.sparkGravity || 9.5; // m/s²
    let n = 0;
    for (let i = 0; i < list.length && n < this._shellPool; i += 1) {
      const s = list[i];
      const life = s.life || 1.1;
      const k = Math.min(1, Math.max(0, s.t / life));
      // 起点在胸口高度：弹壳从枪膛甩出，而不是从地面冒出来
      const baseM = elevationAt(world.map, s.x, s.y);
      const vh = (s.vh != null) ? s.vh : 1.2; // m/s（逻辑侧缺字段时的兜底）
      let hM = baseM + 1.15 + vh * s.t - 0.5 * grav * s.t * s.t;
      if (hM < baseM) hM = baseM; // 落地后贴地（不做弹跳，避免 1.1s 内抖动）
      // 末段收缩淡出：视觉上"消失"，不需要逐实例透明度（那要自定义着色器）
      const fade = k <= fadeStart ? 1 : Math.max(0, 1 - (k - fadeStart) / (1 - fadeStart));
      const sc = baseHalf * (0.25 + 0.75 * fade);
      this._shellE.set(s.rot * 0.7, s.rot, s.rot * 0.45);
      this._shellQ.setFromEuler(this._shellE);
      this._shellP.set(s.x, u(hM), s.y);
      this._shellS.set(sc, sc, sc);
      this._shellM.compose(this._shellP, this._shellQ, this._shellS);
      this._shellMesh.setMatrixAt(n, this._shellM);
      // 颜色向雾色淡出：暗场里不会在墙上留一颗刺眼的亮点
      this._shellTmp.copy(this._shellColor).lerp(this._fxFog, 1 - fade);
      this._shellMesh.setColorAt(n, this._shellTmp);
      n += 1;
    }
    this._shellMesh.count = n;
    if (n > 0 || this._lastShellN > 0) {
      this._shellMesh.instanceMatrix.needsUpdate = true;
      if (this._shellMesh.instanceColor) this._shellMesh.instanceColor.needsUpdate = true;
    }
    this._lastShellN = n;
  }

  _syncHighlight(world) {
    if (!this.level) return;
    const player = world.player;
    const near = (typeof player.nearestExtract === 'function' && player.nearestExtract(world))
      || (typeof player.nearestContainer === 'function' && player.nearestContainer(world));
    if (near && !player.busy) this.level.setHighlight(near.x, near.y, MATCH.interactRange);
    else this.level.setHighlight(null);
  }

  /* ---------------- 世界掉落物品 ---------------- */

  /**
   * 把已搜容器里"还剩下的战利品"渲染成实体 3D 道具，摆在容器顶部。
   * 数量变化时才重建模型，避免每帧 new。
   * @param {object} world 战局上下文
   * @returns {void}
   */
  _syncItems(world) {
    const containers = world.map.containers;
    const seen = new Set();
    for (const c of containers) {
      const loot = c.loot || [];
      seen.add(c);
      const rec = this._itemProps.get(c);
      // P1-0（2026-11-19）：未搜索容器不展示战利品。
      // 之前开局就给所有容器生成悬浮物品模型，实测占 90/161 draws；
      // 同时这也是一种「隔空透视」——玩家不该在开箱前看到容器里有什么。
      if (!c.searched) {
        if (rec) {
          for (const m of rec.models) {
            this.handle.scene.remove(m);
            m.traverse((o) => {
              if (!o.isMesh) return;
              o.geometry?.dispose?.();
              const mat = o.material;
              if (Array.isArray(mat)) mat.forEach((x) => x?.dispose?.());
              else mat?.dispose?.();
            });
          }
          this._itemProps.delete(c);
        }
        continue;
      }
      if (!loot.length) {
        if (rec) {
          for (const m of rec.models) {
            this.handle.scene.remove(m);
            m.traverse((o) => { if (!o.isMesh) return; o.geometry?.dispose?.(); const mat = o.material; if (Array.isArray(mat)) mat.forEach((x) => x?.dispose?.()); else mat?.dispose?.(); });
          }
          this._itemProps.delete(c);
        }
        continue;
      }
      if (rec && rec.count === loot.length) {
        // 道具悬浮自转
        for (const m of rec.models) m.rotation.y += 0.02;
        continue;
      }
      // 数量变化 → 重建（最多显示 6 件，环形摆放）
      if (rec) {
        for (const m of rec.models) {
          this.handle.scene.remove(m);
          m.traverse((o) => { if (!o.isMesh) return; o.geometry?.dispose?.(); const mat = o.material; if (Array.isArray(mat)) mat.forEach((x) => x?.dispose?.()); else mat?.dispose?.(); });
        }
      }
      const models = [];
      const n = loot.length;
      loot.slice(0, 6).forEach((item, i) => {
        const m = buildItemModel(item.id, item.rarity);
        const ang = (i / Math.max(1, n)) * Math.PI * 2;
        const rad = u(0.55);
        // y 对齐地面高程 + 略高于容器顶面（不再固定 0.95 悬空）
        const baseY = u(elevationAt(world.map, c.x, c.y)) + u(0.72);
        m.position.set(c.x + Math.cos(ang) * rad, baseY, c.y + Math.sin(ang) * rad);
        m.rotation.y = ang;
        this.handle.scene.add(m);
        models.push(m);
      });
      this._itemProps.set(c, { count: loot.length, models });
    }
    // 清理已不存在的容器记录
    for (const key of this._itemProps.keys()) {
      if (!seen.has(key)) this._itemProps.delete(key);
    }
    this._syncGroundItems(world);
  }

  /**
   * 地面掉落物：每件一个悬浮自转的小道具 + 一圈地面光晕，靠近就能看见。
   * 用 uid 做键，物品被捡走（从 world.items 移除）时同步销毁模型。
   * @param {object} world 战局上下文
   * @returns {void}
   */
  _syncGroundItems(world) {
    const list = world.items || [];
    if (!this._groundProps) this._groundProps = new Map();
    const seen = new Set();
    for (const it of list) {
      seen.add(it.uid);
      let rec = this._groundProps.get(it.uid);
      if (!rec) {
        const model = buildItemModel(it.id, it.rarity || 'common');
        model.scale.setScalar(0.85);
        this.handle.scene.add(model);
        rec = { model, bob: Math.random() * Math.PI * 2 };
        this._groundProps.set(it.uid, rec);
      }
      rec.bob += 0.05;
      // y 对齐地面高程 + 贴地轻微悬浮（不再固定 0.55 悬空），减少"物品浮空"观感
      rec.model.position.set(it.x, u(elevationAt(world.map, it.x, it.y)) + u(0.18) + Math.sin(rec.bob) * u(0.06), it.y);
      rec.model.rotation.y += 0.03;
    }
    for (const [uid, rec] of this._groundProps) {
      if (seen.has(uid)) continue;
      this.handle.scene.remove(rec.model);
      rec.model.traverse((o) => { if (!o.isMesh) return; o.geometry?.dispose?.(); const mat = o.material; if (Array.isArray(mat)) mat.forEach((x) => x?.dispose?.()); else mat?.dispose?.(); });
      this._groundProps.delete(uid);
    }
  }

  /* ---------------- 地面贴花（P3-C2） ---------------- */

  /**
   * 惰性创建地面贴花对象池：血迹 / 弹着焦痕各一组平铺平面。
   * 共用一个 1×1 共享几何体，按 decal.r 缩放；材质各自独立以便按 kind 切贴图与透明度。
   * 无 document（Node 无头）时贴图为 null，整体降级为不绘制。
   * @returns {Array<{mesh:THREE.Mesh,mat:THREE.Material}>|null}
   */
  _ensureDecals() {
    if (this._decalPool) return this._decalPool;
    const T = this.THREE;
    const blood = getBloodTexture();
    const scorch = getScorchTexture();
    if (!blood && !scorch) { this._decalPool = []; return this._decalPool; }
    const geo = new T.PlaneGeometry(1, 1);
    this._decalGeo = geo;
    const pool = [];
    const N = 64; // 同屏可见贴花上限（老贴花超出后不再绘制，不影响逻辑）
    for (let i = 0; i < N; i += 1) {
      const mat = new T.MeshBasicMaterial({
        map: blood || scorch,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      const mesh = new T.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2; // 平铺地面
      mesh.renderOrder = 1;
      mesh.visible = false;
      this.handle.scene.add(mesh);
      pool.push({ mesh, mat, texBlood: blood, texScorch: scorch });
    }
    this._decalPool = pool;
    return pool;
  }

  /**
   * 把 world.decals（死亡血池 / 弹着焦痕）同步到地面贴花池。
   * 列表只增不减，池容量有限时只画最新的若干张；每帧仅更新可见性/位姿/贴图的变化项。
   * 高程按 elevationAt 对齐，避免贴花浮在架高平台之外或陷进地里。
   * @param {object} world 战局上下文
   * @returns {void}
   */
  _syncDecals(world) {
    const pool = this._ensureDecals();
    if (!pool || !pool.length) return;
    const list = world.decals || [];
    // 只画最新的 pool.length 张，避免老贴花占满池
    const start = Math.max(0, list.length - pool.length);
    for (let i = 0; i < pool.length; i += 1) {
      const slot = pool[i];
      const d = list[start + i];
      if (!d) { if (slot.mesh.visible) slot.mesh.visible = false; continue; }
      const isScorch = d.kind === 'scorch';
      const tex = isScorch ? slot.texScorch : slot.texBlood;
      if (!tex) { slot.mesh.visible = false; continue; }
      slot.mesh.visible = true;
      const y = u(elevationAt(world.map, d.x, d.y)) + 0.05;
      slot.mesh.position.set(d.x, y, d.y);
      // d.r 是逻辑单位（1 米 = metersToUnits = 20），贴花直径即 d.r*2；
      // 绝不能再乘 u()，否则会放大 20 倍变成铺满屏的红幕。
      slot.mesh.scale.set(d.r * 2, d.r * 2, 1);
      if (slot.mat.map !== tex) slot.mat.map = tex;
      const op = isScorch ? 0.6 : 0.85;
      if (slot.mat.opacity !== op) slot.mat.opacity = op;
      slot.mesh.rotation.z = d.rot || 0;
    }
  }


  /* ---------------- 投掷物 / 烟幕 / 燃烧区（P5） ---------------- */

  /**
   * 投掷物相关的三类对象池。全部在换局时重建、在拆卸时释放。
   *
   * 为什么用 Sprite 而不是粒子：烟是**体积感**的东西，用 Points 画会得到一堆"点"，
   * 近看像雪花。几张带软边贴图的 Sprite 互相叠加，才有"一团能挡住视线的东西"的读感。
   * @returns {object} { grenades, smokes, fires }
   */
  _ensureThrowables() {
    if (this._throwPool) return this._throwPool;
    const T = this.THREE;
    const pool = { grenades: [], smokes: [], fires: [], enemyGrenades: [] };

    const gGeo = new T.SphereGeometry(u(0.09), 10, 8);
    this._grenadeGeo = gGeo;
    for (let i = 0; i < 10; i += 1) {
      const mat = new T.MeshStandardMaterial({
        color: 0x2e343c, emissive: 0x000000, roughness: 0.55, metalness: 0.35,
      });
      const mesh = new T.Mesh(gGeo, mat);
      mesh.visible = false;
      mesh.renderOrder = 3;
      this.handle.scene.add(mesh);
      pool.grenades.push({ mesh, mat });
    }

    // P9 敌方爆裂雷：红色快闪，与玩家的深色手雷一眼可分；单独几何体便于换局释放。
    const egGeo = new T.SphereGeometry(u(0.11), 10, 8);
    this._enemyGrenadeGeo = egGeo;
    for (let i = 0; i < 8; i += 1) {
      const mat = new T.MeshStandardMaterial({
        color: 0x8a2b20, emissive: 0xff3b20, emissiveIntensity: 1, roughness: 0.5, metalness: 0.2,
      });
      const mesh = new T.Mesh(egGeo, mat);
      mesh.visible = false;
      mesh.renderOrder = 3;
      this.handle.scene.add(mesh);
      pool.enemyGrenades.push({ mesh, mat });
    }

    const smokeTex = getSmokeTexture();
    if (smokeTex) {
      for (let c = 0; c < 3; c += 1) {
        const cloud = [];
        for (let i = 0; i < 9; i += 1) {
          const mat = new T.SpriteMaterial({
            map: smokeTex, transparent: true, depthWrite: false, opacity: 0,
          });
          const sp = new T.Sprite(mat);
          sp.visible = false;
          sp.renderOrder = 4;
          this.handle.scene.add(sp);
          cloud.push({ sp, mat, phase: (i * 2.399963) % (Math.PI * 2), k: i });
        }
        pool.smokes.push(cloud);
      }
    }

    const fireTex = getFireTexture();
    if (fireTex) {
      const fGeo = new T.PlaneGeometry(1, 1);
      this._fireGeo = fGeo;
      for (let i = 0; i < 4; i += 1) {
        const mat = new T.MeshBasicMaterial({
          map: fireTex,
          transparent: true,
          depthWrite: false,
          blending: T.AdditiveBlending,
          opacity: 0.9,
        });
        const mesh = new T.Mesh(fGeo, mat);
        mesh.rotation.x = -Math.PI / 2;
        mesh.visible = false;
        mesh.renderOrder = 2;
        this.handle.scene.add(mesh);
        pool.fires.push({ mesh, mat });
      }
    }

    this._throwPool = pool;
    return pool;
  }

  /**
   * 同步投掷物表现。
   *
   * 三件事各自有独立的时间来源：手雷读 `g.t`（引信闪烁）、烟读 `s.t/s.life`（膨胀与淡出）、
   * 火读 `world.time`（持续跳动）。不要共用一个累加器 —— 共用会让"烟已散尽但火还在按烟的节奏跳"。
   *
   * @param {object} world 战局上下文
   * @returns {void}
   */
  _syncThrowables(world) {
    const pool = this._ensureThrowables();
    const T = this.THREE;
    const time = world.time || 0;

    const gs = world.grenades || [];
    for (let i = 0; i < pool.grenades.length; i += 1) {
      const slot = pool.grenades[i];
      const g = gs[i];
      if (!g) { if (slot.mesh.visible) slot.mesh.visible = false; continue; }
      slot.mesh.visible = true;
      slot.mesh.position.set(g.x, g.h, g.y);
      slot.mesh.rotation.x = g.spin * 0.8;
      slot.mesh.rotation.z = g.spin;
      // 引信闪烁：破片/震撼是"快闪"，烟与燃烧是"常亮微光"，让玩家一眼分辨手里是什么
      const def = THROWABLE_TYPES[g.kind] || THROWABLE_TYPES.frag;
      const blink = def.trigger === 'fuse'
        ? (Math.sin(g.t * 22) > 0.2 ? 1 : 0.12)
        : 0.5;
      slot.mat.emissive.set(def.color);
      slot.mat.emissiveIntensity = 0.4 + blink * 1.6;
    }

    // P9 敌方爆裂雷：沿抛物线从投掷者飞向落点，红色快闪预警；引信耗尽即炸。
    const egs = world.enemyGrenades || [];
    for (let i = 0; i < pool.enemyGrenades.length; i += 1) {
      const slot = pool.enemyGrenades[i];
      const g = egs[i];
      if (!g) { if (slot.mesh.visible) slot.mesh.visible = false; continue; }
      const prog = Math.min(1, Math.max(0, g.t / Math.max(0.01, g.fuse0 || 1.5)));
      const fx = g.fromX != null ? g.fromX : g.x;
      const fy = g.fromY != null ? g.fromY : g.y;
      slot.mesh.visible = true;
      slot.mesh.position.set(
        fx + (g.x - fx) * prog,
        u(0.15) + Math.sin(prog * Math.PI) * u(2.2),
        fy + (g.y - fy) * prog,
      );
      slot.mat.emissiveIntensity = Math.sin(g.t * 26) > 0 ? 2.2 : 0.5;
    }

    const smokes = world.smokes || [];
    for (let c = 0; c < pool.smokes.length; c += 1) {
      const cloud = pool.smokes[c];
      const s = smokes[c];
      if (!s) {
        for (const slot of cloud) if (slot.sp.visible) slot.sp.visible = false;
        continue;
      }
      const fade = Math.min(1, Math.max(0, (s.life - s.t) / 1.5));
      const grow = Math.min(1, s.t / Math.max(0.01, s.expand));
      for (const slot of cloud) {
        slot.sp.visible = true;
        const ang = slot.phase;
        // 三圈分布：近心 2 张、中环 4 张、外环 3 张，让烟团有内部浓度差
        const ring = slot.k < 2 ? 0.22 : (slot.k < 6 ? 0.5 : 0.78);
        const rr = s.r * ring;
        const lift = (slot.k % 3) * u(0.55);
        slot.sp.position.set(
          s.x + Math.cos(ang) * rr,
          s.h + u(0.7) + lift,
          s.y + Math.sin(ang) * rr,
        );
        const base = u(2.6) * (0.55 + grow * 0.75) * (0.72 + (slot.k % 4) * 0.11);
        slot.sp.scale.set(base, base * 0.92, 1);
        slot.mat.opacity = (slot.k < 2 ? 0.5 : 0.34) * fade;
      }
    }

    const fires = (world.zones || []).filter((z) => z.kind === 'fire');
    for (let i = 0; i < pool.fires.length; i += 1) {
      const slot = pool.fires[i];
      const z = fires[i];
      if (!z) { if (slot.mesh.visible) slot.mesh.visible = false; continue; }
      slot.mesh.visible = true;
      const gy = u(elevationAt(world.map, z.x, z.y)) + 0.06;
      slot.mesh.position.set(z.x, gy, z.y);
      const r = z.r * (0.96 + 0.04 * Math.sin(time * 7 + i));
      slot.mesh.scale.set(r * 2, r * 2, 1);
      const fade = Math.min(1, Math.max(0, (z.life - z.t) / 1.4));
      slot.mat.opacity = (0.62 + 0.18 * Math.sin(time * 11 + i * 1.7)) * fade;
      // 慢速自转：避免贴图上的火舌每次都停在同一个角度显成一张静态贴纸
      slot.mesh.rotation.z = time * 0.35 + i;
    }
    void T;
  }

  /* ---------------- POI 目标点 ---------------- */

  /**
   * 同步 POI：数据终端屏幕自发光（按破解状态变色）+ 空投信标可见性。
   * 终端屏幕颜色仅在状态切换时才写材质（用 userData._lastColor 缓存比对）。
   * @param {object} world 战局上下文
   * @returns {void}
   */
  /**
   * 伤害飘字精灵池（按需创建）。无 document（Node 无头）时返回空池，整体降级为不绘制。
   * @returns {Array<object>} 精灵槽位
   */
  _ensureDamageSprites() {
    if (this._dmgPool) return this._dmgPool;
    this._dmgPool = [];
    if (typeof document === 'undefined') return this._dmgPool;
    const T = this.THREE;
    const CW = 160;
    const CH = 80;
    for (let i = 0; i < 14; i += 1) {
      const canvas = document.createElement('canvas');
      canvas.width = CW;
      canvas.height = CH;
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      const tex = new T.CanvasTexture(canvas);
      tex.colorSpace = T.SRGBColorSpace;
      const mat = new T.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
      const sprite = new T.Sprite(mat);
      sprite.visible = false;
      sprite.renderOrder = 20;
      this.handle.scene.add(sprite);
      this._dmgPool.push({ canvas, ctx, tex, mat, sprite, key: null, w: CW, h: CH });
    }
    return this._dmgPool;
  }

  /**
   * 把 world.damageNumbers 渲染为世界空间的 3D 飘字（上浮 + 淡出）。
   * @param {object} world 战局上下文
   * @returns {void}
   */
  _syncDamageNumbers(world) {
    const pool = this._ensureDamageSprites();
    if (!pool.length) return;
    const list = world.damageNumbers || [];
    for (let i = 0; i < pool.length; i += 1) {
      const slot = pool[i];
      const d = list[i];
      if (!d) {
        if (slot.sprite.visible) {
          slot.sprite.visible = false;
          slot.key = null;
        }
        continue;
      }
      const k = Math.min(1, Math.max(0, d.t / d.life));
      // 文本/颜色变化时才重绘画布，避免逐帧 draw
      const key = `${d.text}|${d.color}`;
      if (slot.key !== key) {
        slot.key = key;
        drawDamageLabel(slot.ctx, slot.w, slot.h, d);
        slot.tex.needsUpdate = true;
      }
      // 飘字若自带高度（h，来自 3D 命中路径的命中高度）则用之，否则回退到固定基准。
      // 兜底用与改动前逐位等价的 u(1.3 + k * 1.0)，保证既有测试不变红。
      const dmgBaseH = (d.h != null) ? d.h : u(1.3 + k * 1.0);
      slot.sprite.position.set(d.x, dmgBaseH, d.y);
      const sc = ((d.size || 15) / 15) * (1 - k * 0.2);
      slot.sprite.scale.set(u(0.9) * sc, u(0.45) * sc, 1);
      slot.mat.opacity = Math.max(0, 1 - k * k);
      slot.sprite.visible = true;
    }
  }

  _syncPois(world) {
    for (const [t, m] of this._terminalModels) {
      const col = t.hacked ? PALETTE3D.terminalHacked : PALETTE3D.terminal;
      if (m.userData._lastColor !== col) {
        m.userData._lastColor = col;
        m.userData.screenMat.emissive.set(col);
      }
    }
    for (const [sw, m] of this._switchModels) {
      const col = sw.pulled ? PALETTE3D.terminalHacked : PALETTE3D.airdrop;
      if (m.userData._lastColor !== col) {
        m.userData._lastColor = col;
        m.userData.leverMat.emissive.set(col);
      }
    }
    if (this._airdropBeacon) {
      this._airdropBeacon.visible = Boolean(world.map.airdrop && !world.map.airdrop.landed);
    }
  }

  /* ---------------- 对外接口 ---------------- */

  /**
   * 渲染一帧。
   * @param {object} world 战局上下文
   * @param {number} dt 帧间隔秒
   * @param {boolean} paused 是否暂停（3D 仍渲染当前画面）
   * @returns {void}
   */
  render(world, dt, paused) {
    if (!world) return;
    if (world !== this.world) this._buildWorld(world);

    const player = world.player;
    this._syncEnemies(world, dt);
    this._syncAllies(world, dt);
    this._syncCrates(world);
    this._syncVehicles(world);
    this._syncRope(world);
    this._syncItems(world);
    this._syncDecals(world);
    this._syncThrowables(world);
    this._syncPois(world);
    if (this.level) {
      this.level.update(world.time);
      this._syncHighlight(world);
    }
    this._syncCamera(player, dt, world);
    this._syncViewmodel(player, dt);
    this._syncFx(world, dt);
    this._syncDamageNumbers(world);

    this.handle.focusShadow(player.x, player.y);
    if (this.handle.setZoneMix) {
      // P3 光照分区：靠近室内灯位时小幅压低冷色填充光，让暖白点光成为主光。
      const sites = (this.level && this.level.lampSites) || [];
      this.handle.setZoneMix(zoneMixAt(player.x, player.y, sites), dt);
    }
    this.handle.samplePerf(dt);

    const r = this.handle.renderer;
    // P0-1：进图后主动编译所有世界材质，避免敌人/容器第一次进入视野时触发
    // shader 编译长任务（审计中 getProgramInfoLog + getParameters 约 10% CPU）。
    // 放在 _syncViewmodel 之后，保证枪模材质也被覆盖；只做一次。
    if (!this._prewarmed) {
      this._prewarmed = true;
      if (r && typeof r.compile === 'function') {
        try {
          r.compile(this.handle.scene, this.handle.camera);
        } catch (err) {
          // 编译预热失败不应阻断游戏；退回首帧懒编译即可。
          console.warn('[搜打撤] 材质预编译失败，将退回按需编译：', err);
        }
      }
    }
    if (!this._postTried) this._ensurePost();
    if (this._postEnabled) {
      try {
        r.setRenderTarget(this._rt);
        r.render(this.handle.scene, this.handle.camera);
        r.setRenderTarget(null);
        this._postMat.uniforms.uTime.value += dt;
        r.render(this._postScene, this._postCamera);

        // 首帧后主动校验 GLSL 编译结果：编译失败不会抛异常，只会静默黑屏。
        if (!this._postVerified) {
          this._postVerified = true;
          if (!isProgramRunnable(r, this._postMat, this.THREE)) {
            console.warn('[搜打撤] 后处理着色器编译失败，已回退为直接渲染（避免黑屏）。');
            this._postEnabled = false;
            this._disposePost();
            r.setRenderTarget(null);
            r.render(this.handle.scene, this.handle.camera);
          }
        }
        return;
      } catch (err) {
        console.warn('[搜打撤] 后处理渲染失败，回退为直接渲染：', err);
        this._postEnabled = false;
        this._disposePost();
      }
    }
    r.render(this.handle.scene, this.handle.camera);
  }

  /** 取当前绘制缓冲尺寸（像素，含像素比），用于后处理 RT 分配；失败回退到窗口尺寸 */
  _postSize() {
    const r = this.handle.renderer;
    try {
      const v = new this.THREE.Vector2();
      r.getDrawingBufferSize(v);
      return { w: Math.max(1, v.x | 0), h: Math.max(1, v.y | 0) };
    } catch {
      return {
        w: Math.max(1, (window.innerWidth | 0) || 1),
        h: Math.max(1, (window.innerHeight | 0) || 1),
      };
    }
  }

  /** 惰性初始化后处理管线：WebGL2 + 深度纹理可用时才启用，否则保持直渲 */
  _ensurePost() {
    if (this._postTried) return;
    this._postTried = true;
    const T = this.THREE;
    const r = this.handle.renderer;
    try {
      if (this._postBlocked) return; // 已被帧率闸门关掉（P0-4），不再重建 RT
      if (this._lowQuality) return; // 手机降档：直接关闭后处理（最稳、最省）
      const cap = r.capabilities;
      if (!POST3D.enabled) return; // 配置层总开关
      if (!cap || !cap.isWebGL2) return; // 深度纹理采样需 WebGL2
      const sz = this._postSize();
      // 缓冲必须是浮点，否则线性光在 1.0 处就被 8bit 削平，ACES 拿到的是一张已经
      // 丢掉全部高光层次的图（"高光糊成一块白"）。半浮点 16F 足够，显存翻倍可控。
      // 老设备 / 无扩展时退回 8bit：色调曲线仍然生效，只是高光回不来。
      // 扩展字符串靠不住（headless / 某些驱动不报 EXT_color_buffer_half_float 但实际可用，
      // 反过来也有）。直接建好再查一次 framebuffer 完整性，不完整就退回 8bit。
      const mkRT = (type) => new T.WebGLRenderTarget(sz.w, sz.h, {
        minFilter: T.LinearFilter,
        magFilter: T.LinearFilter,
        type,
        depthBuffer: true,
      });
      const gl = r.getContext();
      const rtFull = (target) => {
        try {
          r.setRenderTarget(target);
          const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
          r.setRenderTarget(null);
          return ok;
        } catch { return false; }
      };
      let rt = null;
      for (const type of [T.HalfFloatType, T.UnsignedByteType]) {
        const cand = mkRT(type);
        if (rtFull(cand)) { rt = cand; break; }
        cand.dispose();
      }
      if (!rt) rt = mkRT(T.UnsignedByteType);
      rt.depthTexture = new T.DepthTexture(sz.w, sz.h);
      rt.depthTexture.type = T.UnsignedIntType;
      rt.texture.colorSpace = T.NoColorSpace; // 保持线性：后处理阶段手动做 sRGB 编码
      const cam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const tints = gradeTints(); // 色彩分级真值（阴影/高光双色 + 强度），来自 config.GRADE3D
      const mat = new T.ShaderMaterial({
        uniforms: {
          tDiffuse: { value: rt.texture },
          tDepth: { value: rt.depthTexture },
          uResolution: { value: new T.Vector2(sz.w, sz.h) },
          uNear: { value: VIEW3D.near },
          uFar: { value: VIEW3D.far },
          uTime: { value: 0 },
          uVignette: { value: POST3D.vignette },
          uCA: { value: POST3D.chromatic },
          uAO: { value: POST3D.ao.mix },
          uAOStrength: { value: POST3D.ao.strength },
          uAORadius: { value: POST3D.ao.radius },
          uAOBias: { value: POST3D.ao.bias },
          uAOSamples: { value: POST3D.ao.samples },
          uGrain: { value: POST3D.grain },
          uSharpen: { value: POST3D.sharpen },
          uDither: { value: POST3D.dither },
          uContrast: { value: this._grade.contrast },
          uSaturation: { value: this._grade.saturation },
          uExposure: { value: this._grade.exposure },
          uShadowTint: { value: new T.Vector3(tints.shadow[0], tints.shadow[1], tints.shadow[2]) },
          uHighlightTint: { value: new T.Vector3(tints.highlight[0], tints.highlight[1], tints.highlight[2]) },
          uSplitTone: { value: tints.amount },
        },
        vertexShader: POST_VS,
        fragmentShader: POST_FS,
        depthTest: false,
        depthWrite: false,
      });
      const quad = new T.Mesh(new T.PlaneGeometry(2, 2), mat);
      quad.frustumCulled = false;
      const scene = new T.Scene();
      scene.add(quad);
      this._rt = rt;
      this._postMat = mat;
      this._postScene = scene;
      this._postCamera = cam;
      this._postEnabled = true;
      this._postVerified = false; // 等首帧渲染后再校验编译结果
    } catch (err) {
      console.warn('[搜打撤] 后处理初始化失败，已回退直接渲染：', err);
      this._postEnabled = false;
      this._disposePost();
    }
  }

  /** 释放后处理管线占用的 GPU 资源 */
  _disposePost() {
    if (this._rt) {
      this._rt.depthTexture?.dispose?.();
      this._rt.dispose();
      this._rt = null;
    }
    if (this._postScene) {
      const mesh = this._postScene.children[0];
      mesh?.geometry?.dispose?.();
      this._postMat?.dispose?.();
      this._postScene = null;
      this._postMat = null;
      this._postCamera = null;
    }
  }

  /**
   * 运行时开关全屏后处理（P0-4 帧率闸门调用）。
   *
   * 后处理是整条管线里最贵的一项（SSAO 12 采样 + 色差 + 颗粒 + 一张全屏 RT），
   * 弱 GPU 桌面往往"阴影关了还是掉帧"，闸门必须能关掉它并**释放 RT**，否则显存白占。
   * 只降级不升级：关掉后置 _postBlocked，本次会话不再重建（避免阈值附近反复建/销毁）。
   * @param {boolean} on true = 允许开启（仍受 WebGL2 / 配置 / 设备档约束）；false = 立刻关闭并释放
   * @returns {void}
   */
  /**
   * P3：把钳制后的调色值同时灌进 renderer 曝光与后处理 uniform。
   * 后处理被帧率闸门关掉时只留曝光（对比/饱和本来就不生效，不假装生效）。
   * @param {object} grade { exposure, contrast, saturation }
   * @returns {object} 实际生效的钳制值
   */
  setGrade(grade) {
    const g = clampGrade(grade);
    this._grade = g;
    if (this.handle && typeof this.handle.setGrade === 'function') this.handle.setGrade(g);
    if (this._postMat) {
      this._postMat.uniforms.uContrast.value = g.contrast;
      this._postMat.uniforms.uSaturation.value = g.saturation;
      // 曝光同时喂给后处理：开后处理时 three 的 toneMappingExposure 不生效（见 POST_FS 注释）
      this._postMat.uniforms.uExposure.value = g.exposure;
    }
    return g;
  }

  setPostEnabled(on) {
    if (!on) {
      this._postBlocked = true;
      this._postEnabled = false;
      this._disposePost();
      return;
    }
    if (this._postBlocked) return;
    this._postTried = false;
    this._ensurePost();
  }

  /** 视口尺寸变化 */
  resize() {
    if (this.handle && this.handle.resize) this.handle.resize();
    if (this._postEnabled && this._rt) {
      const sz = this._postSize();
      this._rt.setSize(sz.w, sz.h);
      if (this._postMat) this._postMat.uniforms.uResolution.value.set(sz.w, sz.h);
    }
  }

  /** 释放全部 GPU 资源 */
  dispose() {
    this._teardownWorld();
    this.handle.scene.remove(this._tracerMesh);
    this.handle.scene.remove(this._particles);
    this.handle.scene.remove(this._shellMesh);
    this._tracerGeo.dispose();
    this._tracerMesh.material?.dispose?.();
    this._shellMesh.geometry?.dispose?.();
    this._shellMesh.material?.dispose?.();
    this._particles.geometry.dispose();
    this._particles.material?.dispose?.();
    if (this._rope) {
      this.handle.scene.remove(this._rope);
      this._rope.geometry?.dispose?.();
      this._rope.material?.dispose?.();
      this._rope = null;
    }
    if (this._dmgPool) {
      for (const slot of this._dmgPool) {
        slot.sprite.visible = false;
        slot.tex?.dispose?.();
        slot.mat?.dispose?.();
      }
      this._dmgPool = null;
    }
    this._disposePost();
    this.handle.dispose();
  }
}

/**
 * 无渲染降级：当前环境不支持 WebGL 时使用，保证游戏逻辑主循环仍可运行（含集成冒烟测试）。
 */
export class NoopRenderer3D {
  render() {}
  resize() {}
  dispose() {}
}
