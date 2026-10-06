/**
 * 墨色描边（反向外壳 / inverted hull）—— 模块 12
 * ---------------------------------------------------------------------------
 * ★SPEC：常态墨色描边 2px；无双乱舞与武艺期间转朱砂红并加粗到 3px。
 *
 * 做法：给每个网格**配一个共几何体的背面外壳**，在裁剪空间里沿屏幕法线方向外推
 * N 个像素，用 `side: BackSide` 只画背面 —— 正面被本体挡住，只剩一圈轮廓。
 *
 * 为什么在裁剪空间外推而不是"沿法线放大模型"：
 *   后者是**世界空间**常量，离镜头越远描边越细，10m 外基本看不见了；
 *   而 spec 要的是 **px**（屏幕空间常量）。裁剪空间里 NDC 偏移
 *   `2 * px / 屏幕高`，再乘 `w` 还原，就能得到随距离不变的像素宽度。
 *
 * 为什么自己写 ShaderMaterial 而不是给 MeshBasicMaterial 打 onBeforeCompile 补丁：
 *   r160 的 `meshbasic_vert` 里 `objectNormal` **只在 `USE_ENVMAP || USE_SKINNING` 下声明**，
 *   普通网格注入 `objectNormal` 会直接编译失败；而直接用 `normal` 属性又不吃蒙皮。
 *   所以这里显式按需 include `skinbase/skinnormal/skinning` 三个 chunk，
 *   蒙皮与非蒙皮两种网格都能用同一份材质（three 会按 USE_SKINNING 各编译一份程序）。
 *
 * ⚠ 已知取舍：不处理 morph target（表情）。表情形变的幅度很小，2px 外壳不跟
 *   形变在视觉上无感；真要跟需要再 include morphtarget chunk，收益不大。
 */
import { BackSide, Color, Mesh, ShaderMaterial, SkinnedMesh, Vector2 } from '../../vendor/three/three.module.js';
import { HERO } from '../core/config.js';

const VERT = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
uniform float uWidthPx;
uniform vec2 uResolution;
void main() {
  // 法线：非蒙皮时就是顶点法线；蒙皮时要先过一遍骨骼矩阵，否则外壳跟不上动作
  vec3 objectNormal = vec3( normal );
  #ifdef USE_SKINNING
    #include <skinbase_vertex>
    #include <skinnormal_vertex>
  #endif

  vec3 transformed = vec3( position );
  #ifdef USE_SKINNING
    #include <skinning_vertex>
  #endif

  vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );
  gl_Position = projectionMatrix * mvPosition;

  // 沿"屏幕空间法线方向"外推固定像素数
  vec3 vn = normalize( normalMatrix * objectNormal );
  vec2 nc = ( projectionMatrix * vec4( vn, 0.0 ) ).xy;
  float nl = length( nc );
  // 法线正对镜头时 nc≈0（此时这一片本来也不在轮廓上），不推，避免 normalize(0) 出 NaN
  vec2 dir = nl > 1e-5 ? nc / nl : vec2( 0.0 );
  gl_Position.xy += dir * ( uWidthPx * 2.0 / max( 1.0, uResolution.y ) ) * gl_Position.w;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
#include <common>
void main() {
  gl_FragColor = vec4( uColor, 1.0 );
  #include <colorspace_fragment>
}
`;

/**
 * 给角色根节点挂上墨色描边。
 * @param {object} root Object3D（武将根节点，或 THREE.LOD 的根）
 * @param {{widthPx?:number, color?:number, resolution?:{w:number,h:number}}} [opts]
 * @returns {{material:object, meshes:Array, count:number, setWidth:Function, setColor:Function, setResolution:Function, dispose:Function}|null}
 */
export function createInkOutline(root, opts = {}) {
  if (!root || typeof root.traverse !== 'function') return null;
  const widthPx = opts.widthPx ?? HERO.OUTLINE_WIDTH;
  const color = opts.color ?? HERO.OUTLINE_COLOR;
  const res = opts.resolution || { w: 1280, h: 720 };

  // 先收集再添加：traverse 期间改动子节点会漏遍历
  const sources = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (o.userData && o.userData.noOutline) return;
    if (!o.geometry) return;
    if (!o.geometry.attributes || !o.geometry.attributes.normal) return; // 没法线 → 无从外推
    sources.push(o);
  });
  if (sources.length === 0) return null;

  // 一份材质共享给全部外壳：改粗细/颜色只写一次 uniform
  const material = new ShaderMaterial({
    uniforms: {
      uWidthPx: { value: widthPx },
      uColor: { value: new Color(color) },
      uResolution: { value: new Vector2(res.w, res.h) },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: BackSide,
    transparent: false,
    depthWrite: true,
  });

  const meshes = [];
  for (const src of sources) {
    // 蒙皮网格必须用 SkinnedMesh 并 bind 到同一套骨架，否则外壳不跟着骨骼动
    const shell = src.isSkinnedMesh ? new SkinnedMesh(src.geometry, material) : new Mesh(src.geometry, material);
    if (src.isSkinnedMesh && src.skeleton) shell.bind(src.skeleton, src.bindMatrix);
    shell.name = 'inkOutline';
    shell.castShadow = false;
    shell.receiveShadow = false;
    shell.frustumCulled = src.frustumCulled;
    // ⚠ 挂到**同一个父节点**并复制变换：这样父节点（骨骼/动画节点）一动，外壳自动跟着动，
    //   不需要每帧同步矩阵。挂成 src 的子节点对 SkinnedMesh 会造成二次变换，所以必须是兄弟。
    shell.position.copy(src.position);
    shell.quaternion.copy(src.quaternion);
    shell.scale.copy(src.scale);
    (src.parent || root).add(shell);
    meshes.push(shell);
  }

  const handle = {
    material,
    meshes,
    count: meshes.length,
    setWidth(px) { material.uniforms.uWidthPx.value = px; },
    setColor(hex) { material.uniforms.uColor.value.set(hex); },
    setResolution(w, h) { material.uniforms.uResolution.value.set(w, h); },
    dispose() {
      for (const m of meshes) m.parent?.remove(m);
      meshes.length = 0;
      material.dispose();
    },
  };
  root.userData.inkOutline = handle;
  return handle;
}

/**
 * 取角色身上的描边句柄（没有则 null）。
 * @param {object} mesh
 */
export function getInkOutline(mesh) {
  return (mesh && mesh.userData && mesh.userData.inkOutline) || null;
}
