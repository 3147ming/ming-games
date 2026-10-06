/**
 * 战斗表现层（模块 3）—— 唯一碰 three 的战斗文件。
 * ---------------------------------------------------------------------------
 * 只做三件事，而且都只读战斗层给的状态，不参与任何判定：
 *   ① 刀光：**一块常驻的扇形环**，按连段的进度调透明度/缩放。
 *      为什么不用"每次挥击 new 一个再销毁"：一次只有一个动作在进行，
 *      常驻一块 + 每帧同步 = 零 GC、零对象池逻辑，而且不可能出现"上一刀的刀光忘了删"。
 *   ② 命中火花：小球的池子，打中就亮一下。
 *   ③ 击杀冲击环：地面上的扩散圆环，用来强调"这一下把人打碎了"。
 * 模块 4/5 加真正的特效时，把本文件替换掉即可，战斗逻辑一行不用动。
 */
import {
  AdditiveBlending,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  SphereGeometry,
} from '../../vendor/three/three.module.js';
import { DEG } from '../core/config.js';
import { moveTotal } from './chain.js';

const SLASH_COLOR = 0xffe6a8;
const SLASH_COLOR_CHARGED = 0xffb0d0;
const SPARK_COLOR = 0xfff3c4;
const BURST_COLOR = 0xff9a6a;

/**
 * 刀光几何：按**张角**缓存的环形扇面。
 * 只有 6 种张角（70/120/150/160/220/360），所以第一次用到时建一次就够了 ——
 * 既不每帧重建几何（那会一直丢内存），也不用"非等比缩放"去假装不同的张角
 * （那会让刀光在突刺时被拉成一根面条，一眼假）。
 *
 * 局部坐标的约定：RingGeometry 在 XY 平面上，θ=0 在 +X；rotateX(-90°) 把它放倒到 XZ 平面后
 * θ=π/2 落在 **-Z**。而 rotation.y = yaw 时局部 -Z 恰好是世界 forward（见 config 坐标约定），
 * 所以扇面的角平分线取 θ = π/2。
 */
const arcCache = new Map();
/**
 * @param arcDeg 张角（度）
 * @param inner  内径（0~1，相对外径）。窄弧用小内径（扇形更饱满），
 *               宽弧/满圈用大内径 —— 否则 360° 大招会摊成一张"白饼"：
 *               内孔只有 0.18×reach（C5 是 0.67m）根本看不见，整圈看起来是实心圆盘。
 *               加成混合叠在亮草地上一冲，就是一块纯白，既不像刀光也糊掉整个战场。
 */
export function slashGeometry(arcDeg, inner = 0.18) {
  const key = Math.max(1, Math.round(arcDeg));
  const innerR = Math.max(0.06, Math.min(0.85, inner));
  const cacheKey = `${key}|${innerR.toFixed(2)}`;
  let g = arcCache.get(cacheKey);
  if (!g) {
    const arc = key * DEG;
    g = new RingGeometry(innerR, 1, 56, 1, Math.PI / 2 - arc / 2, arc);
    g.rotateX(-Math.PI / 2);
    arcCache.set(cacheKey, g);
  }
  return g;
}

function makeSlashMesh() {
  const mat = new MeshBasicMaterial({
    color: SLASH_COLOR,
    transparent: true,
    opacity: 0,
    side: DoubleSide,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const mesh = new Mesh(slashGeometry(120), mat);
  mesh.name = 'combat-slash';
  mesh.visible = false;
  mesh.frustumCulled = false;
  return mesh;
}

function makeSparkPool(n) {
  const geo = new SphereGeometry(1, 8, 6);
  const out = [];
  for (let i = 0; i < n; i++) {
    const mat = new MeshBasicMaterial({
      color: SPARK_COLOR,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const m = new Mesh(geo, mat);
    m.visible = false;
    m.frustumCulled = false;
    out.push({ mesh: m, life: 0, max: 1, size: 0.2, grow: 2.0 });
  }
  return out;
}

function makeBurstPool(n) {
  const geo = new RingGeometry(0.5, 0.62, 40, 1);
  geo.rotateX(-Math.PI / 2);
  const out = [];
  for (let i = 0; i < n; i++) {
    const mat = new MeshBasicMaterial({
      color: BURST_COLOR,
      transparent: true,
      opacity: 0,
      side: DoubleSide,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const m = new Mesh(geo, mat);
    m.visible = false;
    m.frustumCulled = false;
    out.push({ mesh: m, life: 0, max: 1 });
  }
  return out;
}

export class CombatFx {
  constructor(scene) {
    this.root = new Group();
    this.root.name = 'combat-fx';
    this.slash = makeSlashMesh();
    this.root.add(this.slash);
    this.sparks = makeSparkPool(14);
    this.bursts = makeBurstPool(5);
    for (const s of this.sparks) this.root.add(s.mesh);
    for (const b of this.bursts) this.root.add(b.mesh);
    scene.add(this.root);
    this._sparkAt = 0;
    this._burstAt = 0;
    this.stats = { slashes: 0, sparks: 0, bursts: 0 };
  }

  /** 处理战斗层抛出来的事件（damage / killed） */
  handle(events) {
    for (const ev of events) {
      if (ev.type !== 'damage') continue;
      const p = ev.result.hitPoint;
      this._spawnSpark(p.x, p.y, p.z, ev.move.id === 'CHARGED' ? 2.2 : 1);
      if (ev.result.killed) this._spawnBurst(ev.target.x, ev.target.z);
    }
  }

  /**
   * 每帧同步刀光。
   * @param fx 战斗层的 fxState()（没有进行中的动作时传 null）
   * @param player 玩家控制器
   */
  update(dt, fx, player) {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;

    // ── 刀光
    if (fx && fx.move && (fx.phase === 'startup' || fx.phase === 'active' || fx.phase === 'recovery')) {
      const move = fx.move;
      const total = moveTotal(move);
      const frac = total > 0 ? fx.t / total : 0;
      // 透明度曲线：前摇渐显 → 判定期间最亮 → 后摇快速消失
      const a = fx.phase === 'startup' ? (fx.t / Math.max(1e-4, move.startup)) * 0.5 : fx.phase === 'active' ? 1 : Math.max(0, 1 - (frac - (move.startup + move.active) / total) / 0.35) * 0.9;
      const mesh = this.slash;
      mesh.visible = a > 0.01;
      // 0.68 而不是 0.85：叠在亮草地（加成混合）上再高就整片过曝成白，看不出"刀"的形状
      mesh.material.opacity = Math.min(1, a) * 0.68;
      mesh.material.color.setHex(move.id === 'CHARGED' ? SLASH_COLOR_CHARGED : SLASH_COLOR);
      const arcDeg = move.arcDeg ?? 120;
      const geo = slashGeometry(arcDeg, arcDeg >= 180 ? 0.52 : 0.18);
      if (mesh.geometry !== geo) mesh.geometry = geo;
      const f = { x: -Math.sin(fx.facing), z: -Math.cos(fx.facing) };
      const reach = move.reach ?? 2;
      mesh.position.set(
        player.position.x + f.x * (move.offset ?? 0),
        (move.height ?? 1) * 0.75,
        player.position.z + f.z * (move.offset ?? 0)
      );
      mesh.rotation.y = fx.facing;
      mesh.scale.setScalar(reach);
      this.stats.slashes++;
    } else {
      this.slash.visible = false;
      this.slash.material.opacity = 0;
    }

    // ── 火花
    for (const s of this.sparks) {
      if (s.life <= 0) {
        if (s.mesh.visible) s.mesh.visible = false;
        continue;
      }
      s.life -= step;
      const k = Math.max(0, s.life / s.max);
      s.mesh.material.opacity = k;
      const sc = s.size * (1 + (1 - k) * s.grow);
      s.mesh.scale.setScalar(sc);
      if (s.life <= 0) s.mesh.visible = false;
    }

    // ── 冲击环
    for (const b of this.bursts) {
      if (b.life <= 0) {
        if (b.mesh.visible) b.mesh.visible = false;
        continue;
      }
      b.life -= step;
      const k = Math.max(0, b.life / b.max);
      b.mesh.material.opacity = k * 0.8;
      b.mesh.scale.setScalar(1 + (1 - k) * 5);
      if (b.life <= 0) b.mesh.visible = false;
    }
  }

  _spawnSpark(x, y, z, scale = 1) {
    const s = this.sparks[this._sparkAt++ % this.sparks.length];
    s.mesh.position.set(x, y, z);
    s.mesh.scale.setScalar(0.12 * scale);
    s.size = 0.12 * scale;
    s.life = 0.16;
    s.max = 0.16;
    s.mesh.visible = true;
    s.mesh.material.opacity = 1;
    this.stats.sparks++;
  }

  _spawnBurst(x, z) {
    const b = this.bursts[this._burstAt++ % this.bursts.length];
    b.mesh.position.set(x, 0.06, z);
    b.mesh.scale.setScalar(1);
    b.life = 0.45;
    b.max = 0.45;
    b.mesh.visible = true;
    b.mesh.material.opacity = 0.8;
    this.stats.bursts++;
  }
}
