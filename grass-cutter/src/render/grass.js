/**
 * 草簇（模块 10）—— 玩家周围 15m 半径内的实例化草（交叉双面片），顶点着色器风摆 + 边缘淡出。
 * ---------------------------------------------------------------------------
 * ⚠ 设计口径（spec）：
 *   · 2000~5000 实例，玩家周围 15m 半径内渲染，15m 外不渲染（用"随玩家移动的草泡"实现）。
 *   · 顶点着色器随 sin(时间) 风摆，随距离（离草泡中心）淡入淡出（边缘缩小到 0，避免 alpha 排序问题）。
 *   · 复用 MeshStandardMaterial + onBeforeCompile 注入风摆，保留 PBR 光照与雾。
 *   · 不投阴影（草泡始终在脚边，投影收益低、开销高）。
 */
import {
  DoubleSide,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from '../../vendor/three/three.module.js';
import { GRASS } from '../core/config.js';
import { mergeParts } from '../core/geoMerge.js';
import { hexToRgb, inkTone, rgbToHex } from '../core/inkTone.js';

// ★SPEC(模块13) 15m 草簇配色与地形贴图同步降饱和（−30% 饱和 / −10% 明度）。
//   走的是同一套纯函数，保证"贴图里的草"和"长出来的草"是同一个灰绿调。
function inkGrass(hex) {
  return rgbToHex(inkTone(hexToRgb(hex), { satMul: GRASS.INK_SAT_MUL, lightMul: GRASS.INK_LIGHT_MUL }));
}

function bladeGeometry() {
  const w = GRASS.BLADE_W;
  const h = GRASS.BLADE_H;
  const a = new PlaneGeometry(w, h, 1, 3);
  a.translate(0, h / 2, 0);
  const b = a.clone();
  b.rotateY(Math.PI / 2);
  return mergeParts([
    { geometry: a, color: inkGrass(0x3a4a30), shade: 1 },
    { geometry: b, color: inkGrass(0x33402a), shade: 0.92 },
  ]).geometry;
}

export class GrassField {
  constructor(scene) {
    this.scene = scene;
    this.ok = false;
    try {
      const geo = bladeGeometry();
      const mat = new MeshStandardMaterial({
        vertexColors: true,
        side: DoubleSide,
        roughness: 0.95,
        metalness: 0,
      });

      // 每实例风摆相位
      const phases = new Float32Array(GRASS.COUNT);
      for (let i = 0; i < GRASS.COUNT; i++) phases[i] = Math.random() * Math.PI * 2;
      geo.setAttribute('aPhase', new InstancedBufferAttribute(phases, 1));

      this.uTime = { value: 0 };
      this.uCenter = { value: new Vector2Lite() };
      this.uFreq = { value: GRASS.WIND_FREQ };
      this.uAmp = { value: GRASS.WIND_AMP };
      this.uRadius = { value: GRASS.RADIUS };
      this.uFadeStart = { value: GRASS.FADE_START };

      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = this.uTime;
        shader.uniforms.uCenter = this.uCenter;
        shader.uniforms.uFreq = this.uFreq;
        shader.uniforms.uAmp = this.uAmp;
        shader.uniforms.uRadius = this.uRadius;
        shader.uniforms.uFadeStart = this.uFadeStart;
        shader.vertexShader =
          'attribute float aPhase;\nuniform float uTime; uniform vec2 uCenter; uniform float uFreq; uniform float uAmp; uniform float uRadius; uniform float uFadeStart;\nvarying float vFade;\n' +
          shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace(
          '#include <begin_vertex>',
          /* glsl */ `
          #include <begin_vertex>
          vec3 iPos = (instanceMatrix * vec4(0.0,0.0,0.0,1.0)).xyz;
          float distC = length(iPos.xz - uCenter);
          float fade = 1.0 - smoothstep(uFadeStart, uRadius, distC);
          vFade = fade;
          float yf = clamp(position.y / ${GRASS.BLADE_H.toFixed(3)}, 0.0, 1.0);
          transformed.x += sin(uTime * uFreq + aPhase) * uAmp * yf;
          transformed.z += cos(uTime * uFreq * 0.8 + aPhase) * uAmp * 0.6 * yf;
          transformed.xz *= fade;
          transformed.y *= mix(0.35, 1.0, fade);
          `
        );
      };

      const mesh = new InstancedMesh(geo, mat, GRASS.COUNT);
      mesh.name = 'grass-field';
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;

      // 预生成固定相对偏移（草泡随玩家平移），偏移是相对草泡中心的位置
      const m = new Matrix4();
      const q = new Quaternion();
      const v = new Vector3();
      const s = new Vector3();
      for (let i = 0; i < GRASS.COUNT; i++) {
        const ang = Math.random() * Math.PI * 2;
        const rr = Math.sqrt(Math.random()) * GRASS.RADIUS;
        const x = Math.cos(ang) * rr;
        const z = Math.sin(ang) * rr;
        q.setFromAxisAngle(new Vector3(0, 1, 0), Math.random() * Math.PI);
        const sc = 0.7 + Math.random() * 0.8;
        s.set(sc, sc, sc);
        v.set(x, 0, z);
        m.compose(v, q, s);
        mesh.setMatrixAt(i, m);
      }
      mesh.instanceMatrix.needsUpdate = true;
      scene.add(mesh);
      this.mesh = mesh;
      this.ok = true;
    } catch (err) {
      console.warn('[grass] 初始化失败，跳过草簇：', err && err.message);
      this.ok = false;
    }
  }

  update(dt, playerPos) {
    if (!this.ok) return;
    this.uTime.value += dt;
    if (playerPos) {
      this.uCenter.value.x = playerPos.x;
      this.uCenter.value.y = playerPos.z;
      this.mesh.position.set(playerPos.x, 0, playerPos.z);
    }
  }

  /** 降级用：直接隐藏整片草（不销毁，恢复时再 show） */
  setVisible(v) {
    if (this.ok && this.mesh) this.mesh.visible = !!v;
  }
}

// 极简 vec2，避免额外 import（three 的 Vector2 亦可用，这里自包含）
class Vector2Lite {
  constructor(x = 0, y = 0) { this.x = x; this.y = y; }
}
