/**
 * 贴花池（模块 10）—— 命中/击杀后生成的墨渍 / 焦痕（非写实血腥），对象池容量 30。
 * ---------------------------------------------------------------------------
 * ⚠ spec：单张贴花 2m×2m、存活 30s 淡出、透明度 alpha ≤ 0.2、不采用写实血腥。
 *   复用 30 个 Mesh，循环覆盖最旧的；贴地 y≈0.02，避免与地形 z-fighting。
 */
import {
  CanvasTexture,
  DoubleSide,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  RepeatWrapping,
  Vector3,
} from '../../vendor/three/three.module.js';
import { DECAL } from '../core/config.js';

const KINDS = {
  ink: { base: 'rgba(28,28,30,', edge: 'rgba(28,28,30,0)' },
  cinnabar: { base: 'rgba(150,40,32,', edge: 'rgba(150,40,32,0)' },
  scorch: { base: 'rgba(40,34,30,', edge: 'rgba(40,34,30,0)' },
};

function makeSplatTexture(kind) {
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  const k = KINDS[kind] || KINDS.ink;
  // 透明底
  ctx.clearRect(0, 0, s, s);
  // 中心一团 + 随机飞溅（带飞白）
  const blobs = 5 + ((Math.random() * 4) | 0);
  for (let i = 0; i < blobs; i++) {
    const cx = s / 2 + (Math.random() - 0.5) * s * 0.5;
    const cy = s / 2 + (Math.random() - 0.5) * s * 0.5;
    const r = 10 + Math.random() * 34;
    const a = (0.6 + Math.random() * 0.4).toFixed(2);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, k.base + a + ')');
    g.addColorStop(0.7, k.base + (a * 0.5).toFixed(2) + ')');
    g.addColorStop(1, k.edge + '0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // 飞白斑点
  for (let i = 0; i < 24; i++) {
    const x = Math.random() * s, y = Math.random() * s;
    ctx.fillStyle = k.base + (0.15 + Math.random() * 0.25).toFixed(2) + ')';
    ctx.fillRect(x, y, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
  const tex = new CanvasTexture(cv);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  return tex;
}

// 土路墨晕铺装时复用的临时对象（模块级，避免每次铺一张就 new 一次）
const _roadDummy = new Object3D();
const _roadAxisY = new Vector3(0, 1, 0);

export class DecalPool {
  constructor(scene) {
    this.scene = scene;
    this.ok = false;
    try {
      this.geo = new PlaneGeometry(DECAL.SIZE, DECAL.SIZE);
      this.geo.rotateX(-Math.PI / 2);
      this.textures = {
        ink: makeSplatTexture('ink'),
        cinnabar: makeSplatTexture('cinnabar'),
        scorch: makeSplatTexture('scorch'),
      };
      this.pool = [];
      this.cursor = 0;
      for (let i = 0; i < DECAL.POOL; i++) {
        const mat = new MeshBasicMaterial({
          map: this.textures.ink,
          transparent: true,
          depthWrite: false,
          side: DoubleSide,
          opacity: 0,
          fog: true,
        });
        const m = new Mesh(this.geo, mat);
        m.visible = false;
        m.renderOrder = 1;
        m.frustumCulled = false;
        scene.add(m);
        this.pool.push({ mesh: m, life: 0, max: DECAL.LIFE, kind: 'ink' });
      }
      // ── 模块 13：土路墨晕边缘专用池 ──
      //   ⚠ 为什么**不复用**上面的环形池：那是"最旧的一张被新的覆盖"的战斗墨渍逻辑，
      //     路边墨晕是**常驻布景**，一旦被打光就再也回不来（打几波怪路边就秃了）。
      //   ⚠ 为什么是 InstancedMesh 而不是几百个 Mesh：4 条路总长约 500m，按 2.4m 间距
      //     两侧各铺一张 → 400+ 张贴花。逐个 Mesh 就是 400+ 次 draw call，
      //     光这一项就把模块 9 的 60fps 预算吃光了（和 enemyMesh 当初同一个道理）。
      //     InstancedMesh 合成 1 次 draw call，实例矩阵开局写一次就再也不动。
      this.roadPool = null;
      this.roadCount = 0;
      this.ok = true;
    } catch (err) {
      console.warn('[decals] 初始化失败，跳过贴花：', err && err.message);
      this.ok = false;
    }
  }

  /**
   * 沿土路两侧铺一排墨晕（★SPEC 模块13：土路加墨晕边缘贴花）。
   * ---------------------------------------------------------------------------
   * 作用是把"草地灰绿"和"土路灰褐"之间的硬边洇开 —— 两者都是低饱和色，
   * 直接相接会有一条很假的直边，墨晕一压就成了水墨里的"洇色"。
   *
   * 走 InstancedMesh：数量是"路长 ÷ 间距 × 2"，四五百张是常态，
   * 逐 Mesh 就是四五百次 draw call（见构造函数里的说明）。
   *
   * @param {Array<{from:number,to:number,width:number,axis:string,center:number}>} roads
   * @returns {number} 实际铺设的贴花张数
   */
  spawnRoadEdgeInk(roads) {
    if (!this.ok || !DECAL.ROAD_EDGE_INK || !Array.isArray(roads) || roads.length === 0) return 0;
    if (this.roadPool) return this.roadCount; // 只铺一次（幂等：重复调用直接返回上次结果）

    const step = Math.max(0.5, DECAL.ROAD_EDGE_SPACING);
    const inset = DECAL.ROAD_EDGE_INSET;
    const sc = DECAL.ROAD_EDGE_SCALE || [0.85, 1.3];

    // ── 先把每张贴花的变换算出来，才知道要开多大的实例缓冲 ──
    const xf = [];
    for (const r of roads) {
      const along0 = Math.min(r.from, r.to);
      const along1 = Math.max(r.from, r.to);
      const half = r.width / 2 - inset;
      for (let a = along0; a <= along1; a += step) {
        for (const side of [-1, 1]) {
          // axis 'z'：路沿 Z 走，两侧在 X 方向；axis 'x'：反之
          const x = r.axis === 'x' ? a : r.center + side * half;
          const z = r.axis === 'x' ? r.center + side * half : a;
          xf.push({
            x,
            y: 0.021 + Math.random() * 0.006, // 贴地 + 随机微抬，避免整排完全共面
            z,
            ry: Math.random() * Math.PI * 2, // 随机朝向：贴花本身是不规则墨团，转一下才不像"印章"
            // 缩放与间距的关系：间距必须 ≤ 单张边长 × 最大系数，否则相邻两张之间会露白缝
            s: sc[0] + Math.random() * (sc[1] - sc[0]),
          });
        }
      }
    }
    if (xf.length === 0) return 0;
    // 防御：路网被改长（加新路）时别让实例数悄悄涨到几千 —— 宁可截断并报警
    const cap = DECAL.ROAD_EDGE_MAX_INSTANCES ?? 900;
    if (xf.length > cap) {
      console.warn(`[decals] 土路墨晕需要 ${xf.length} 张，超过上限 ${cap}，已截断（请调大 DECAL.ROAD_EDGE_SPACING）`);
      xf.length = cap;
    }

    const mat = new MeshBasicMaterial({
      map: this.textures.ink,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      opacity: DECAL.MAX_ALPHA * (DECAL.ROAD_EDGE_ALPHA ?? 0.55),
      fog: true,
    });
    const mesh = new InstancedMesh(this.geo, mat, xf.length);
    mesh.renderOrder = 1;
    mesh.frustumCulled = false; // 铺满整张地图，包围盒剔除反而容易在边缘漏掉
    for (let i = 0; i < xf.length; i++) {
      const t = xf[i];
      _roadDummy.position.set(t.x, t.y, t.z);
      _roadDummy.quaternion.setFromAxisAngle(_roadAxisY, t.ry);
      _roadDummy.scale.set(t.s, 1, t.s);
      _roadDummy.updateMatrix();
      mesh.setMatrixAt(i, _roadDummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(mesh);
    this.roadPool = mesh;
    this.roadCount = xf.length;
    return xf.length;
  }

  /** 在 (x,z) 处生成一张贴花。kind: 'ink' | 'cinnabar' | 'scorch' */
  spawn(x, z, kind = 'ink') {
    if (!this.ok) return;
    const slot = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % this.pool.length;
    slot.kind = kind;
    slot.life = slot.max;
    const mat = slot.mesh.material;
    mat.map = this.textures[kind] || this.textures.ink;
    mat.opacity = 0;
    slot.mesh.visible = true;
    slot.mesh.position.set(x, 0.02 + Math.random() * 0.01, z);
    slot.mesh.rotation.y = Math.random() * Math.PI * 2;
  }

  update(dt) {
    if (!this.ok) return;
    for (const s of this.pool) {
      if (s.life <= 0) {
        if (s.mesh.visible) s.mesh.visible = false;
        continue;
      }
      s.life -= dt;
      const k = Math.max(0, s.life / s.max);
      // 前 80% 保持，最后 20% 淡出；总透明度上限 0.2
      const fade = k < 0.2 ? k / 0.2 : 1;
      s.mesh.material.opacity = DECAL.MAX_ALPHA * fade;
      if (s.life <= 0) s.mesh.visible = false;
    }
  }
}
