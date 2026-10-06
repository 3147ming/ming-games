/**
 * 水墨战斗特效（模块 10 改版）—— 替换原 fx.js，纯表现层，不碰任何战斗判定。
 * ---------------------------------------------------------------------------
 * 设计口径（spec 全部对齐）：
 *   · 墨点飞溅：轻击 20~30 粒、重击/C 技 40~60 粒 + 8~12 粒朱砂红火点；带速度方向、重力下坠、落地成渍（复用贴花池）。
 *   · 刀光笔触拖尾：墨色 ribbon，宽 0.3~0.5m、寿命 0.1~0.18s、同屏上限 12；重击/C 收尾刀光末梢加朱砂红渐隐点睛。
 *   · 冲击环：墨晕扩散环（1m→打击盒半径，0.25s 淡出）；无双/武艺生成大幅墨浪环（→14m，0.6s 淡出）。
 *   · 武艺专属配色：技能 1 朱砂红火、技能 2 淡墨青蓝雷；释放前 0.8s 地面预警范围圈（近似：释放时显示）。
 *   · 无双乱舞：全屏墨色风暴 + 朱砂红点缀 + 残影（24 个墨色半透明）+ 宣纸米白全屏闪帧（0.3s 一次 0.05s）。
 *   · 命中顿帧（与无双慢动作共用时间缩放通道、不叠加）：轻 0.15×0.05s / 重 0.15×0.1s / 特殊 0.15×0.15s；重击附加 0.03s 全身顿住。
 *   · 镜头震动：轻 0.05~0.08 / 重 0.15~0.2 / 特殊 0.25~0.35（持续 0.1s）。
 *   · 伤害飘字：轻墨小字 / 重·C 朱砂红大字(1.5×) / 无双·武艺纯白大字带墨晕描边(2×)，上浮 1.2m 淡出。
 *   · 性能预算（叠加模块 9）：同屏粒子 ≤5000、刀光 ≤12、贴花 ≤30、残影 ≤24；走对象池。
 *   · 降级见 PerfGuard（main 调用 setBloom/setGrass/setFxDegrade）。
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  PlaneGeometry,
  Points,
  RingGeometry,
  ShaderMaterial,
  Vector3,
} from '../../vendor/three/three.module.js';
import { INKFX, ARTS, MUSOU, POSTFX, TIME } from '../core/config.js';
import { moveTotal } from './chain.js';
// ⚠ 刀光几何必须走 fx.js 的**按张角缓存**版本：early 版这里每帧 `new RingGeometry(...)`
//   重建扇面，6 秒连点的探针用例直接被拖挂（无头 SwiftShader 下每帧一次 GPU buffer 申请/释放）。
//   全场只有 6 种张角，缓存命中后 `mesh.geometry !== geo` 判定为假，零分配。
import { slashGeometry } from './fx.js';
import { CapsuleGeometry } from '../../vendor/three/three.module.js';

const INK = new Color(0x1c1c1e);
const CINNABAR = new Color(0xb5322a);
const DAICING = new Color(0x3a6f8a);
const PAPER = new Color(0xefe9d8);

function isHeavy(id = '') {
  return id === 'H' || id.startsWith('C') || id === 'CHARGED' || id === 'musou' || id.startsWith('art');
}

// ── 粒子池（Points，CPU 更新）──
class ParticlePool {
  constructor(scene, max) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.cursor = 0;

    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(this.pos, 3));
    geo.setAttribute('aColor', new BufferAttribute(this.col, 3));
    geo.setAttribute('aSize', new BufferAttribute(this.size, 1));
    geo.setAttribute('aAlpha', new BufferAttribute(this.alpha, 1));
    geo.setDrawRange(0, max);

    const mat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: NormalBlending,
      uniforms: { uScale: { value: 380 } },
      vertexShader: /* glsl */ `
        attribute vec3 aColor; attribute float aSize; attribute float aAlpha;
        varying vec3 vCol; varying float vA;
        uniform float uScale;
        void main(){
          vCol = aColor; vA = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale / max(0.001, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec3 vCol; varying float vA;
        void main(){
          vec2 d = gl_PointCoord - 0.5;
          float r = dot(d,d);
          if(r > 0.25) discard;
          float a = smoothstep(0.25, 0.02, r) * vA;
          gl_FragColor = vec4(vCol, a);
        }`,
    });
    this.geo = geo;
    this.points = new Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.name = 'ink-particles';
    scene.add(this.points);
    // 初始全透明
    this.alpha.fill(0);
  }

  emit(x, y, z, opt) {
    const n = opt.count | 0;
    if (this.owner?.stats) this.owner.stats.sparks += n;
    const spread = opt.spread ?? 1.2;
    const up = opt.up ?? 2.5;
    const speed = opt.speed ?? 3.5;
    const life = opt.life ?? [0.3, 0.4];
    const size = opt.size ?? 0.06;
    const grav = opt.gravity ?? INKFX.SPARK_GRAVITY;
    const c = opt.color || INK;
    const cj = opt.jitter ?? 0.0;
    for (let i = 0; i < n; i++) {
      const k = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
      const ang = Math.random() * Math.PI * 2;
      const sp = speed * (0.5 + Math.random());
      const vx = Math.cos(ang) * sp * spread * 0.5 + (Math.random() - 0.5) * spread;
      const vz = Math.sin(ang) * sp * spread * 0.5 + (Math.random() - 0.5) * spread;
      const vy = up * (0.4 + Math.random()) + (Math.random() - 0.5) * up;
      this.vel[k * 3] = vx;
      this.vel[k * 3 + 1] = vy;
      this.vel[k * 3 + 2] = vz;
      this.pos[k * 3] = x;
      this.pos[k * 3 + 1] = y;
      this.pos[k * 3 + 2] = z;
      const jr = 1 + (Math.random() - 0.5) * cj;
      this.col[k * 3] = c.r * jr;
      this.col[k * 3 + 1] = c.g * jr;
      this.col[k * 3 + 2] = c.b * jr;
      const lf = life[0] + Math.random() * (life[1] - life[0]);
      this.life[k] = lf;
      this.maxLife[k] = lf;
      this.grav[k] = grav;
      this.size[k] = size * (0.7 + Math.random() * 0.7);
      this.alpha[k] = 0.9;
    }
  }

  update(dt) {
    const { pos, vel, life, maxLife, alpha, size, grav } = this;
    for (let k = 0; k < this.max; k++) {
      if (life[k] <= 0) { if (alpha[k] !== 0) alpha[k] = 0; continue; }
      life[k] -= dt;
      vel[k * 3 + 1] -= grav[k] * dt;
      pos[k * 3] += vel[k * 3] * dt;
      pos[k * 3 + 1] += vel[k * 3 + 1] * dt;
      pos[k * 3 + 2] += vel[k * 3 + 2] * dt;
      if (pos[k * 3 + 1] < 0.02 && vel[k * 3 + 1] < 0) {
        pos[k * 3 + 1] = 0.02;
        vel[k * 3 + 1] *= -0.25;
        vel[k * 3] *= 0.6; vel[k * 3 + 2] *= 0.6;
      }
      const k2 = Math.max(0, life[k] / maxLife[k]);
      alpha[k] = Math.min(0.9, k2 * 1.2);
      if (life[k] <= 0) { alpha[k] = 0; size[k] = 0; }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
  }
}

// ── 冲击环池 ──
class RingPool {
  constructor(scene, max) {
    this.geo = new RingGeometry(0.92, 1.0, 40, 1);
    this.geo.rotateX(-Math.PI / 2);
    this.mat = new MeshBasicMaterial({ color: INK, transparent: true, opacity: 0, side: DoubleSide, depthWrite: false });
    this.pool = [];
    for (let i = 0; i < max; i++) {
      const m = new Mesh(this.geo, this.mat.clone());
      m.visible = false; m.frustumCulled = false; m.renderOrder = 2;
      scene.add(m);
      this.pool.push({ mesh: m, life: 0, max: 1, r0: 1, r1: 4 });
    }
    this.cursor = 0;
  }
  spawn(x, z, r1, life, color, opt = {}) {
    const s = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % this.pool.length;
    s.mesh.visible = true;
    s.mesh.position.set(x, 0.05, z);
    // ★SPEC(模块13) 墨浪爆发环：起始半径/不透明度可覆盖（默认仍是 1m 起、0.8）
    s.r0 = opt.r0 ?? 1;
    s.r1 = r1;
    s.life = life; s.max = life;
    s.opacity = opt.opacity ?? 0.8;
    if (color) s.mesh.material.color.copy(color);
    s.mesh.material.opacity = s.opacity;
  }
  update(dt) {
    for (const s of this.pool) {
      if (s.life <= 0) { if (s.mesh.visible) s.mesh.visible = false; continue; }
      s.life -= dt;
      const k = Math.max(0, s.life / s.max);
      const r = s.r0 + (s.r1 - s.r0) * (1 - k);
      s.mesh.scale.set(r, 1, r);
      s.mesh.material.opacity = (s.opacity ?? 0.8) * k;
      if (s.life <= 0) s.mesh.visible = false;
    }
  }
}

// ── 刀光笔触 ribbon 池（沿命中点与玩家连线的弧带）──
class RibbonPool {
  constructor(scene, max) {
    this.pool = [];
    for (let i = 0; i < max; i++) {
      const geo = new PlaneGeometry(1, 1, 6, 1);
      geo.rotateX(-Math.PI / 2);
      const mat = new MeshBasicMaterial({ color: INK, transparent: true, opacity: 0, side: DoubleSide, depthWrite: false, blending: AdditiveBlending });
      const m = new Mesh(geo, mat);
      m.visible = false; m.frustumCulled = false; m.renderOrder = 3;
      scene.add(m);
      this.pool.push({ mesh: m, life: 0, max: 1, color: INK });
    }
    this.cursor = 0;
  }
  spawn(ax, az, bx, bz, width, life, color, tipColor) {
    const s = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % this.pool.length;
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz) || 0.001;
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    s.mesh.visible = true;
    s.mesh.position.set(mx, 1.0, mz);
    s.mesh.scale.set(len, 1, width);
    s.mesh.rotation.y = Math.atan2(-dx, -dz);
    s.mesh.material.color.copy(color || INK);
    s.mesh.material.opacity = 0.8;
    s.life = life; s.max = life; s.color = color || INK;
    if (tipColor) s.mesh.material.color.lerp(tipColor, 0.35);
  }
  update(dt) {
    for (const s of this.pool) {
      if (s.life <= 0) { if (s.mesh.visible) s.mesh.visible = false; continue; }
      s.life -= dt;
      const k = Math.max(0, s.life / s.max);
      s.mesh.material.opacity = 0.8 * k;
      if (s.life <= 0) s.mesh.visible = false;
    }
  }
}

// ── 残影池（墨色半透明剪影，近似武将轮廓）──
class AfterimagePool {
  constructor(scene, max) {
    this.geo = new CapsuleGeometry(0.5, 1.4, 4, 8);
    this.mat = new MeshBasicMaterial({ color: 0x1c1c1e, transparent: true, opacity: 0, depthWrite: false });
    this.pool = [];
    this.cursor = 0;
    for (let i = 0; i < max; i++) {
      const m = new Mesh(this.geo, this.mat.clone());
      m.visible = false; m.frustumCulled = false; m.renderOrder = 4;
      scene.add(m);
      this.pool.push({ mesh: m, life: 0, max: 1 });
    }
  }
  spawn(x, y, z, quat, scale) {
    const s = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % this.pool.length;
    s.mesh.visible = true;
    s.mesh.position.set(x, y, z);
    if (quat) s.mesh.quaternion.copy(quat);
    const sc = scale ?? 1;
    s.mesh.scale.set(sc, sc * 1.1, sc);
    s.mesh.material.opacity = 0.5;
    s.life = INKFX.AFTERIMAGE_LIFE;
    s.max = INKFX.AFTERIMAGE_LIFE;
  }
  update(dt) {
    for (const s of this.pool) {
      if (s.life <= 0) { if (s.mesh.visible) s.mesh.visible = false; continue; }
      s.life -= dt;
      const k = Math.max(0, s.life / s.max);
      s.mesh.material.opacity = 0.5 * k;
      if (s.life <= 0) s.mesh.visible = false;
    }
  }
}

export class InkFx {
  /**
   * @param scene
   * @param opts { camera, timeControl, decals, audio, onAfterimage }
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.camera = opts.camera || null;
    this.timeControl = opts.timeControl || null;
    this.decals = opts.decals || null;
    this.audio = opts.audio || null;
    this.onAfterimage = opts.onAfterimage || null;
    this.root = new Group();
    this.root.name = 'ink-fx';
    scene.add(this.root);

    this.particles = new ParticlePool(this.root, INKFX.PARTICLE_BUDGET);
    this.particles.owner = this;
    // ★SPEC(模块13) 受击特效池 120→160：重击要"普通环 + 墨浪环"两发，池子小了会互相顶掉
    this.rings = new RingPool(this.root, INKFX.HITFX_POOL);
    this.ribbons = new RibbonPool(this.root, INKFX.RIBBON_CAP);
    this.afterimages = new AfterimagePool(this.root, INKFX.AFTERIMAGE_CAP);

    // 刀光弧（沿用 fx.js 的常驻扇形，改墨色）
    this.slash = this._makeSlash();
    this.root.add(this.slash);

    // 武艺预警 / 释放范围圈
    this.artRing = this._makeArtRing();
    this.root.add(this.artRing);

    // 伤害飘字 DOM 容器
    this.floatRoot = document.createElement('div');
    this.floatRoot.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:7;overflow:hidden;';
    document.body.appendChild(this.floatRoot);
    this.floats = [];
    this.floatCursor = 0;
    for (let i = 0; i < INKFX.FLOAT_POOL; i++) {
      const d = document.createElement('div');
      d.style.cssText = 'position:absolute;font-weight:800;opacity:0;transform:translate(-50%,-50%);text-shadow:0 1px 3px rgba(0,0,0,.7);will-change:transform,opacity;';
      this.floatRoot.appendChild(d);
      this.floats.push({ el: d, life: 0, max: 1, vy: 0 });
    }

    // 镜头震动
    this.shake = 0;
    this.shakeAmp = 0;
    this._shakeOff = new Vector3();

    // 兼容探针（tools/probe.mjs 旧 combatFx 口径）：刀光出现帧数 / 累计墨点发射数
    this.stats = { slashes: 0, sparks: 0 };

    // 无双闪帧计时
    this._paperTimer = 0;
    this._musouActive = false;

    // 降级开关
    this.degrade = { bloom: true, grass: true, ink: true };
  }

  setCamera(cam) { this.camera = cam; }

  _makeSlash() {
    const mat = new MeshBasicMaterial({ color: 0x222428, transparent: true, opacity: 0, side: DoubleSide, depthWrite: false, blending: NormalBlending });
    // slashGeometry 内部已 rotateX(-π/2) 放倒到 XZ 平面，并自带张角缓存
    const mesh = new Mesh(slashGeometry(120), mat);
    mesh.visible = false; mesh.frustumCulled = false; mesh.renderOrder = 3;
    return mesh;
  }

  _makeArtRing() {
    const g = new RingGeometry(0.94, 1.0, 48, 1);
    g.rotateX(-Math.PI / 2);
    const m = new MeshBasicMaterial({ color: CINNABAR, transparent: true, opacity: 0, side: DoubleSide, depthWrite: false });
    const mesh = new Mesh(g, m);
    mesh.visible = false; mesh.frustumCulled = false; mesh.renderOrder = 2;
    return mesh;
  }

  // ── 事件处理（combat.events）──
  handle(events) {
    if (!events) return;
    for (const ev of events) {
      if (ev.type === 'damage') this._onDamage(ev);
      else if (ev.type === 'musou-release') this._onMusou(ev);
      else if (ev.type === 'art') this._onArt(ev);
      else if (ev.type === 'swing') this._onSwing(ev);
    }
  }

  _onDamage(ev) {
    const hp = ev.result?.hitPoint;
    if (!hp) return;
    const heavy = isHeavy(ev.move?.id) || ev.aoe;
    const x = hp.x, y = Math.max(0.2, hp.y), z = hp.z;
    const lightN = INKFX.SPARK_LIGHT_MIN + ((Math.random() * (INKFX.SPARK_LIGHT_MAX - INKFX.SPARK_LIGHT_MIN)) | 0);
    const heavyN = INKFX.SPARK_HEAVY_MIN + ((Math.random() * (INKFX.SPARK_HEAVY_MAX - INKFX.SPARK_HEAVY_MIN)) | 0);
    const cinnabarN = INKFX.CINNABAR_MIN + ((Math.random() * (INKFX.CINNABAR_MAX - INKFX.CINNABAR_MIN)) | 0);

    if (heavy) {
      this.particles.emit(x, y, z, { count: heavyN, color: INK, life: INKFX.SPARK_LIFE_HEAVY, size: 0.07, speed: 4.5, up: 3.2, spread: 1.6 });
      this.particles.emit(x, y, z, { count: cinnabarN, color: CINNABAR, life: INKFX.SPARK_LIFE_HEAVY, size: 0.06, speed: 5, up: 4, spread: 1.4, jitter: 0.3 });
      this.rings.spawn(x, z, ev.move?.reach ?? 2.6, INKFX.RING_LIFE, INK);
      // ★SPEC(模块13) 重击/C 技追加「墨浪爆发环」：1m → 打击盒半径 ×1.25，0.3s 淡出，
      //   比普通冲击环更大更久更实（普通环 0.25s / 0.8 不透明度）
      if (INKFX.RING_WAVE_ENABLED) {
        this.rings.spawn(x, z, (ev.move?.reach ?? 2.6) * INKFX.RING_WAVE_MUL, INKFX.RING_WAVE_LIFE, INK, {
          r0: INKFX.RING_WAVE_R0,
          opacity: INKFX.RING_WAVE_OPACITY,
        });
      }
      this._shake(INKFX.SHAKE_HEAVY);
    } else {
      this.particles.emit(x, y, z, { count: lightN, color: INK, life: INKFX.SPARK_LIFE_LIGHT, size: 0.05, speed: 3, up: 2.2, spread: 1.2 });
      this._shake(INKFX.SHAKE_LIGHT);
    }

    // ★SPEC(模块13) 敌人墨烟消散：小墨浪环（0.8m）+ 8~12 粒墨点爆开
    if (ev.result?.killed) this._deathPoof(x, y, z);

    // 刀光笔触 ribbon（玩家→命中点连线为弧带近似）
    if (this.playerPos) {
      const px = this.playerPos.x, pz = this.playerPos.z;
      const w = INKFX.RIBBON_WIDTH[0] + Math.random() * (INKFX.RIBBON_WIDTH[1] - INKFX.RIBBON_WIDTH[0]);
      const lf = INKFX.RIBBON_LIFE[0] + Math.random() * (INKFX.RIBBON_LIFE[1] - INKFX.RIBBON_LIFE[0]);
      this.ribbons.spawn(px, pz, x, z, w, lf, INK, INKFX.RIBBON_CINNABAR_TIP && heavy ? CINNABAR : null);
    }

    // 伤害飘字
    const dmg = ev.result?.damage ?? ev.move?.damage ?? 0;
    if (dmg > 0) this._floatDamage(x, y + 0.4, z, dmg, heavy ? 'heavy' : 'light', ev);

    // 落地墨渍（低概率，复用贴花池，不超过容量）
    if (this.decals && Math.random() < 0.4) this.decals.spawn(x, z, heavy ? 'ink' : 'ink');

    // ── 顿帧 + 音效：两者**同一帧、同一个事件**里先后触发（★SPEC 模块13「与模块 11 音效同步」）。
    //   ⚠ 刻意不分成两条计时器：分成两条就会各走各的累积误差，连打十几下后音画会明显错开。
    if (INKFX.HITSTOP_AUDIO_SYNC !== false && this.audio) {
      this.audio.play(ev.result?.killed ? 'enemyDeath' : (heavy ? 'hitHeavy' : 'hitLight'));
    }
    if (heavy) this._hitstop(INKFX.HITSTOP_HEAVY, INKFX.HITSTOP_HEAVY_FREEZE);
    else this._hitstop(INKFX.HITSTOP_LIGHT, 0);
  }

  /** ★SPEC(模块13) 敌人消散：0.8m 小墨浪环 + 8~12 粒墨点爆开（吃掉的是粒子/环预算，不是新对象） */
  _deathPoof(x, y, z) {
    const n = INKFX.DEATH_POOF_MIN + ((Math.random() * (INKFX.DEATH_POOF_MAX - INKFX.DEATH_POOF_MIN)) | 0);
    this.particles.emit(x, Math.max(0.3, y), z, {
      count: n, color: INK, life: [0.3, 0.5], size: 0.06, speed: 3.2, up: 2.6, spread: 1.5,
    });
    this.rings.spawn(x, z, INKFX.DEATH_POOF_RADIUS, INKFX.DEATH_POOF_LIFE, INK, { r0: 0.3, opacity: 0.7 });
  }

  _onSwing(ev) {
    // 起手时刷一道笔触拖尾，从玩家前方一点扫出
    if (!this.playerPos) return;
    const f = { x: -Math.sin(this.playerFacing || 0), z: -Math.cos(this.playerFacing || 0) };
    const ax = this.playerPos.x + f.x * (ev.move?.offset ?? 0.8);
    const az = this.playerPos.z + f.z * (ev.move?.offset ?? 0.8);
    const bx = this.playerPos.x + f.x * (ev.move?.reach ?? 2);
    const bz = this.playerPos.z + f.z * (ev.move?.reach ?? 2);
    const w = INKFX.RIBBON_WIDTH[0] + Math.random() * (INKFX.RIBBON_WIDTH[1] - INKFX.RIBBON_WIDTH[0]);
    const lf = INKFX.RIBBON_LIFE[0] + Math.random() * (INKFX.RIBBON_LIFE[1] - INKFX.RIBBON_LIFE[0]);
    this.ribbons.spawn(ax, az, bx, bz, w, lf, INK, isHeavy(ev.move?.id) ? CINNABAR : null);
    if (this.audio) this.audio.play('swing');
  }

  _onArt(ev) {
    const color = ev.id === 'art1' ? CINNABAR : DAICING;
    const x = this.playerPos?.x ?? 0, z = this.playerPos?.z ?? 0;
    const radius = ev.id === 'art1' ? ARTS.art1.radius : ARTS.art2.radius;
    // 地面预警/释放范围圈
    this.artRing.visible = true;
    this.artRing.position.set(x, 0.06, z);
    this.artRing.material.color.copy(color);
    this.artRing.material.opacity = 0.9;
    this._artRingLife = INKFX.ART_WARN_LEAD;
    this._artRingR = radius;
    // 爆炸粒子
    this.particles.emit(x, 1.0, z, { count: 70, color, life: [0.4, 0.7], size: 0.1, speed: 7, up: 5, spread: 2.4, jitter: 0.4 });
    this.rings.spawn(x, z, radius, INKFX.RING_MUSOU_LIFE, color);
    this._shake(INKFX.SHAKE_SPECIAL);
    this._hitstop(INKFX.HITSTOP_SPECIAL, 0);
    if (this.audio) this.audio.play(ev.id === 'art1' ? 'art1' : 'art2');
  }

  _onMusou(ev) {
    const x = this.playerPos?.x ?? 0, z = this.playerPos?.z ?? 0;
    // 全屏墨色风暴
    this.particles.emit(x, 1.2, z, { count: 220, color: INK, life: [0.6, 1.0], size: 0.12, speed: 9, up: 6, spread: 4, jitter: 0.3 });
    this.particles.emit(x, 1.2, z, { count: 60, color: CINNABAR, life: [0.5, 0.9], size: 0.1, speed: 10, up: 7, spread: 3.5, jitter: 0.4 });
    this.rings.spawn(x, z, INKFX.RING_MUSOU_RADIUS, INKFX.RING_MUSOU_LIFE, INK);
    this._musouActive = true;
    this._musouTimer = ev.duration ?? MUSOU.RANBU.DURATION;
    // 残影触发（main 负责按 0.05s 记录玩家网格）
    if (this.onAfterimage) this.onAfterimage(true);
    this._shake(INKFX.SHAKE_SPECIAL);
    if (this.timeControl) this.timeControl.requestSlowmo(TIME.MUSOU_SLOW_SCALE, TIME.MUSOU_SLOW_DUR);
    else this._hitstop(INKFX.HITSTOP_SPECIAL, 0);
    if (this.audio) this.audio.play('musou');
  }

  _shake(range) {
    const a = range[0] + Math.random() * (range[1] - range[0]);
    this.shakeAmp = Math.max(this.shakeAmp, a);
    this.shake = INKFX.SHAKE_DUR;
  }

  _hitstop(scaleDur, extraFreeze) {
    if (this.timeControl) this.timeControl.requestHitstop(INKFX.HITSTOP_SCALE, scaleDur);
    if (extraFreeze && this.timeControl) this.timeControl.requestHitstop(0.0, extraFreeze);
  }

  _floatDamage(wx, wy, wz, dmg, kind, ev) {
    const slot = this.floats[this.floatCursor];
    this.floatCursor = (this.floatCursor + 1) % this.floats.length;
    const el = slot.el;
    // ★SPEC(模块13) 字号基准 14px → 16.8px（×1.2）；重击/C 技 1.5×，无双/武艺 2×（沿用）
    const big = kind === 'heavy' ? INKFX.FLOAT_HEAVY_MULT : 1;
    const huge = ev && (ev.move?.id === 'musou' || ev.source === 'art1' || ev.source === 'art2');
    const mult = huge ? INKFX.FLOAT_SPECIAL_MULT : big;
    let color = '#1c1c1e'; // 墨色（轻击）
    if (kind === 'heavy') color = INKFX.FLOAT_HEAVY_COLOR; // ★SPEC 重击/C 技改朱砂红（原金调）
    if (huge) color = '#ffffff'; // 纯白大字带墨晕描边（★SPEC 2 倍不变）
    el.textContent = `${Math.round(dmg)}`;
    el.style.color = color;
    el.style.fontSize = `${INKFX.FLOAT_FONT_BASE * mult}px`;
    if (huge) el.style.textShadow = '0 0 6px #1c1c1e, 0 0 12px #1c1c1e, 0 1px 3px rgba(0,0,0,.8)';
    else if (kind === 'heavy') el.style.textShadow = INKFX.FLOAT_HEAVY_STROKE;
    else el.style.textShadow = '0 1px 3px rgba(255,255,255,.4), 0 1px 3px rgba(0,0,0,.7)';
    // 世界 → 屏幕
    slot.wx = wx; slot.wy = wy; slot.wz = wz;
    slot.life = 0.9; slot.max = 0.9;
    slot.el.style.opacity = '1';
  }

  /** 主循环每帧调用 */
  update(dt, fxState, player, ctx = {}) {
    // 记录玩家位置给事件用
    this.playerPos = player ? { x: player.position.x, z: player.position.z } : this.playerPos;
    this.playerFacing = fxState?.facing ?? this.playerFacing ?? 0;

    // 刀光弧（沿用 fx.js 逻辑，墨色）
    if (this.degrade.ink && fxState && fxState.move && ['startup', 'active', 'recovery'].includes(fxState.phase)) {
      const move = fxState.move;
      const total = moveTotal(move);
      const frac = total > 0 ? fxState.t / total : 0;
      const a = fxState.phase === 'startup' ? (fxState.t / Math.max(1e-4, move.startup)) * 0.5
        : fxState.phase === 'active' ? 1 : Math.max(0, 1 - (frac - (move.startup + move.active) / total) / 0.35) * 0.9;
      const mesh = this.slash;
      mesh.visible = a > 0.01;
      mesh.material.opacity = Math.min(0.95, a) * 0.8;
      if (a > 0.01) this.stats.slashes++;
      const arcDeg = move.arcDeg ?? 120;
      const geo = slashGeometry(arcDeg, arcDeg >= 180 ? 0.52 : 0.18);
      if (mesh.geometry !== geo) mesh.geometry = geo;
      const f = { x: -Math.sin(fxState.facing), z: -Math.cos(fxState.facing) };
      mesh.position.set(player.position.x + f.x * (move.offset ?? 0), (move.height ?? 1) * 0.8, player.position.z + f.z * (move.offset ?? 0));
      mesh.rotation.y = fxState.facing;
      mesh.scale.setScalar(move.reach ?? 2);
    } else {
      this.slash.visible = false;
    }

    this.particles.update(dt);
    this.rings.update(dt);
    this.ribbons.update(dt);

    // 武艺圈淡出
    if (this._artRingLife > 0) {
      this._artRingLife -= dt;
      this.artRing.scale.set(this._artRingR, 1, this._artRingR);
      this.artRing.material.opacity = Math.max(0, this._artRingLife / INKFX.ART_WARN_LEAD) * 0.9;
      if (this._artRingLife <= 0) this.artRing.visible = false;
    }

    // 无双墨浪环持续脉冲 + 纸闪 + 残影
    if (this._musouActive) {
      this._musouTimer -= dt;
      this._paperTimer -= dt;
      if (this._paperTimer <= 0) {
        this._paperTimer = POSTFX.PAPER_FLASH_HZ;
        this._flashPaper();
      }
      // 每 0.05s 记录一次玩家位置 → 墨色残影（共约 24 个，1.2s）
      this._aiTimer = (this._aiTimer || 0) - dt;
      if (this._aiTimer <= 0 && this.playerPos) {
        this._aiTimer = INKFX.AFTERIMAGE_INTERVAL;
        this.afterimages.spawn(this.playerPos.x, 1.0, this.playerPos.z, null, 1);
      }
      if (this._musouTimer <= 0) this._musouActive = false;
    }

    // 残影更新
    this.afterimages.update(dt);

    // 镜头震动
    this._shakeOff.set(0, 0, 0);
    if (this.shake > 0) {
      this.shake -= dt;
      const k = Math.max(0, this.shake / INKFX.SHAKE_DUR);
      const a = this.shakeAmp * k;
      this._shakeOff.set((Math.random() - 0.5) * 2 * a, (Math.random() - 0.5) * 2 * a, (Math.random() - 0.5) * 2 * a);
      if (this.shake <= 0) this.shakeAmp = 0;
    }

    // 伤害飘字：投影 + 上浮淡出
    this._updateFloats(dt);
  }

  _flashPaper() {
    if (!this._paper) {
      this._paper = document.createElement('div');
      this._paper.style.cssText = 'position:fixed;inset:0;background:#efe9d8;pointer-events:none;z-index:9;opacity:0;mix-blend-mode:screen;';
      document.body.appendChild(this._paper);
    }
    this._paper.style.transition = 'none';
    this._paper.style.opacity = '0.12';
    requestAnimationFrame(() => {
      this._paper.style.transition = `opacity ${POSTFX.PAPER_FLASH_DUR}s ease-out`;
      this._paper.style.opacity = '0';
    });
  }

  _updateFloats(dt) {
    if (!this.camera) return;
    const cam = this.camera;
    const v = new Vector3();
    const W = window.innerWidth, H = window.innerHeight;
    for (const s of this.floats) {
      if (s.life <= 0) { if (s.el.style.opacity !== '0') s.el.style.opacity = '0'; continue; }
      s.life -= dt;
      s.wy += (INKFX.FLOAT_RISE * dt) / s.max;
      v.set(s.wx, s.wy, s.wz).project(cam);
      if (v.z > 1) { s.el.style.opacity = '0'; continue; }
      const sx = (v.x * 0.5 + 0.5) * W;
      const sy = (-v.y * 0.5 + 0.5) * H;
      const k = s.life / s.max;
      s.el.style.left = `${sx}px`;
      s.el.style.top = `${sy}px`;
      s.el.style.opacity = `${Math.min(1, k * 1.4)}`;
      if (s.life <= 0) s.el.style.opacity = '0';
    }
  }

  setDegrade(d) {
    if (d.bloom !== undefined) this.degrade.bloom = d.bloom;
    if (d.grass !== undefined) this.degrade.grass = d.grass;
    if (d.ink !== undefined) this.degrade.ink = d.ink;
    if (!this.degrade.ink) {
      this.particles.alpha.fill(0);
      this.particles.geo.attributes.aAlpha.needsUpdate = true;
      for (const s of this.rings.pool) { s.life = 0; s.mesh.visible = false; }
      for (const s of this.ribbons.pool) { s.life = 0; s.mesh.visible = false; }
      for (const s of this.afterimages.pool) { s.life = 0; s.mesh.visible = false; }
    }
  }

  shakeOffset() { return this._shakeOff; }
}
