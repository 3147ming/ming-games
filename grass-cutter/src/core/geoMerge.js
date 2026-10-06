/**
 * 几何烘焙：把「好几块基础几何 + 每块一个颜色」压成**一个**带顶点色的 BufferGeometry。
 * ---------------------------------------------------------------------------
 * 为什么需要它（这是模块 4 的性能基石）：
 *
 *   一个杂兵身上有腿 ×2、躯干、肩甲 ×2、头、盔、臂 ×2、刀柄、刀刃 —— 十几块。
 *   如果每块一个 Mesh，160 个杂兵就是 2000+ 次 draw call，JS 侧的绘制开销就能把帧率吃光
 *   （每次 draw call 的固定开销按 ~0.02ms 算，2000 × 0.02 = 40ms，直接掉到 25fps）。
 *
 *   所以：**同一个骨架只烘一次**，得到 1 份几何；160 个杂兵共用它，靠 InstancedMesh 画 1 次。
 *   多部件不能靠多个 Mesh 表达，就把"部件"降级成**顶点色** —— 视觉上一样有盔有甲有刀，
 *   代价是 0 次额外 draw call。
 *
 * 纯 three、不碰 DOM，所以能在 Node 里直接 `node --test`（three 的几何类是纯 JS 的）。
 *
 * ⚠ 顶点色是**乘性**的：最终颜色 = material.color × vertexColor。
 *   于是"按状态染色"（待机灰 / 威慑蓝 / 攻击红）只需要改 material 或 instanceColor，
 *   不用重建几何、不用第二份材质 —— 这正是我们要的性质。
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Matrix4,
  Quaternion,
  Vector3,
} from '../../vendor/three/three.module.js';

const AXIS_Y = new Vector3(0, 1, 0);

/**
 * 给一份几何烘上单一顶点色（原地修改并返回它）。
 * @param geometry 会被原地加一个 color 属性
 * @param colorHex 0xRRGGBB
 * @param shade    亮度系数（各面之间拉开一点明暗，纯色 + 单一光照会显得很"塑料"）
 */
export function bakeColor(geometry, colorHex, shade = 1) {
  const count = geometry.attributes.position?.count ?? 0;
  const c = new Color(colorHex).multiplyScalar(shade);
  const arr = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new BufferAttribute(arr, 3));
  return geometry;
}

/**
 * 合并若干「部件」。这是本文件的主角。
 *
 * @param parts Array<{
 *   geometry: BufferGeometry,
 *   color?: number,          // 缺省白色
 *   shade?: number,          // 亮度系数，默认 1
 *   matrix?: Matrix4|null,   // 部件在自己的局部空间摆在哪（平移/旋转/缩放）
 *   name?: string
 * }>
 * @param opts.uvFill 缺失 uv 时补什么（默认 0）
 *
 * @returns {{ geometry: BufferGeometry, vertexCount: number, parts: number, skipped: number }}
 *
 * ⚠ 三个必须处理的坑（都真的踩过）：
 *   ① **索引**：BoxGeometry/CylinderGeometry 是带索引的，SphereGeometry 也是；
 *      直接拼 position 而不展开索引，三角形会全部错位（表现为"模型炸成碎片"）。
 *      统一 `toNonIndexed()` 之后再拼。
 *   ② **缺 uv**：有些几何没有 uv 属性，装上 StandardMaterial 会因为属性长度不一致而报错，
 *      必须补一段等长的零 uv。
 *   ③ **法线**：变换矩阵里如果有非均匀缩放，法线不能直接乘同一个矩阵（要用逆转置）。
 *      three 的 `applyMatrix4` 已经处理了这一层，所以**必须**用它而不是手写循环。
 */
export function mergeParts(parts, opts = {}) {
  const uvFill = opts.uvFill ?? 0;
  const chunks = [];
  let skipped = 0;
  let total = 0;

  for (const part of parts) {
    const src = part && part.geometry;
    const pos = src?.attributes?.position;
    if (!src || !pos || pos.count === 0) {
      skipped++;
      continue;
    }
    // ① 展开索引（且不要污染调用方传进来的原几何）
    const g = (src.index ? src.toNonIndexed() : src.clone());
    if (part.matrix) g.applyMatrix4(part.matrix); // ③ 法线由 three 自己正确处理
    bakeColor(g, part.color ?? 0xffffff, part.shade ?? 1);

    // ② uv 补齐
    if (!g.attributes.uv) {
      const n = g.attributes.position.count;
      g.setAttribute('uv', new BufferAttribute(new Float32Array(n * 2).fill(uvFill), 2));
    }
    if (!g.attributes.normal) g.computeVertexNormals();

    const n = g.attributes.position.count;
    chunks.push({
      position: g.attributes.position.array,
      normal: g.attributes.normal.array,
      uv: g.attributes.uv.array,
      color: g.attributes.color.array,
    });
    total += n;
  }

  const geometry = new BufferGeometry();
  if (total === 0) return { geometry, vertexCount: 0, parts: 0, skipped };

  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  const color = new Float32Array(total * 3);

  let o3 = 0;
  let o2 = 0;
  for (const c of chunks) {
    position.set(c.position, o3);
    normal.set(c.normal, o3);
    color.set(c.color, o3);
    uv.set(c.uv, o2);
    o3 += c.position.length;
    o2 += c.uv.length;
  }

  geometry.setAttribute('position', new BufferAttribute(position, 3));
  geometry.setAttribute('normal', new BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new BufferAttribute(uv, 2));
  geometry.setAttribute('color', new BufferAttribute(color, 3));
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();

  return { geometry, vertexCount: total, parts: chunks.length, skipped };
}

/** 便捷构造：平移矩阵（部件摆位时 90% 是纯平移）*/
export function at(x = 0, y = 0, z = 0) {
  return new Matrix4().makeTranslation(x, y, z);
}

/** 便捷构造：缩放 */
export function scaled(x, y = x, z = x) {
  return new Matrix4().makeScale(x, y, z);
}

/**
 * 便捷构造：绕 Y 旋转 + 缩放 + 平移（T·R·S）。
 * 杂兵的两条腿、两只肩甲是镜像关系，靠 rotY = ±π/2 摆出来；
 * 武器长短、身材高矮的"个体差异"靠 scale —— 但**几何只烘一次**，
 * 差异通过 InstancedMesh 的每实例矩阵施加（见 enemyMesh.js）。
 *
 * @param pos  {x,y,z} 平移（可省略 → 原点）
 * @param rotY 绕 Y 的弧度
 * @param scale number | {x,y,z}（可省略 → 1）
 */
export function placed(pos = null, rotY = 0, scale = null) {
  const s = scale == null ? { x: 1, y: 1, z: 1 } : typeof scale === 'number' ? { x: scale, y: scale, z: scale } : scale;
  const q = new Quaternion().setFromAxisAngle(AXIS_Y, rotY);
  const v = new Vector3(pos?.x ?? 0, pos?.y ?? 0, pos?.z ?? 0);
  const sv = new Vector3(s.x, s.y, s.z);
  return new Matrix4().compose(v, q, sv);
}
