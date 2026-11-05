/**
 * 射击特效对象池：曳光弹、命中火花、血液飞溅、枪口粒子、墙面弹痕
 * 使用对象池避免频繁创建/销毁导致 GC 卡顿；所有池均有固定上限，防止粒子爆炸掉帧。
 */
import * as THREE from 'three';

function glowTexture(colorStops) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 31);
  for (const [stop, color] of colorStops) g.addColorStop(stop, color);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(32, 32, 31, 0, Math.PI * 2); ctx.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 弹痕贴图：深色弹孔 + 边缘溅射（偏血迹） */
function decalTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, 64, 64);
  // 外圈溅射
  for (let i = 0; i < 10; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 8 + Math.random() * 14;
    ctx.fillStyle = `rgba(${60 + Math.random() * 30},${8 + Math.random() * 10},${6},0.55)`;
    ctx.beginPath();
    ctx.arc(32 + Math.cos(a) * r, 32 + Math.sin(a) * r, 1.5 + Math.random() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  // 中心弹孔
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 12);
  g.addColorStop(0, 'rgba(8,6,5,0.98)');
  g.addColorStop(0.55, 'rgba(28,16,12,0.9)');
  g.addColorStop(1, 'rgba(40,20,14,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(32, 32, 12, 0, Math.PI * 2); ctx.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Effects {
  constructor(scene) {
    this.scene = scene;

    // 曳光弹池
    this.tracerPool = [];
    for (let i = 0; i < 12; i++) {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(), new THREE.Vector3(),
      ]);
      const mat = new THREE.LineBasicMaterial({
        color: 0xffd889, transparent: true, opacity: 0, depthWrite: false,
      });
      const line = new THREE.Line(geo, mat);
      line.visible = false;
      line.frustumCulled = false;
      scene.add(line);
      this.tracerPool.push({ line, life: 0, maxLife: 0.06 });
    }

    // 火花贴图
    const sparkTex = glowTexture([
      [0, 'rgba(255,255,230,1)'],
      [0.35, 'rgba(255,200,90,0.8)'],
      [1, 'rgba(255,120,0,0)'],
    ]);
    this.sparkPool = [];
    for (let i = 0; i < 20; i++) {
      const mat = new THREE.SpriteMaterial({
        map: sparkTex, transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, opacity: 0,
      });
      const s = new THREE.Sprite(mat);
      s.visible = false;
      scene.add(s);
      this.sparkPool.push({ sprite: s, life: 0, maxLife: 0.22, baseScale: 0.12 });
    }

    // 血液贴图
    const bloodTex = glowTexture([
      [0, 'rgba(210,20,20,0.95)'],
      [0.5, 'rgba(140,0,0,0.6)'],
      [1, 'rgba(90,0,0,0)'],
    ]);
    this.bloodPool = [];
    for (let i = 0; i < 24; i++) {
      const mat = new THREE.SpriteMaterial({
        map: bloodTex, transparent: true, depthWrite: false, opacity: 0,
      });
      const s = new THREE.Sprite(mat);
      s.visible = false;
      scene.add(s);
      this.bloodPool.push({ sprite: s, life: 0, maxLife: 0.4, vx: 0, vy: 0, vz: 0 });
    }

    // 枪口粒子池（短寿命、加法混合）
    this.muzzlePool = [];
    const muzzleTex = glowTexture([
      [0, 'rgba(255,255,240,1)'],
      [0.4, 'rgba(255,190,80,0.85)'],
      [1, 'rgba(255,90,0,0)'],
    ]);
    for (let i = 0; i < 16; i++) {
      const mat = new THREE.SpriteMaterial({
        map: muzzleTex, transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, opacity: 0,
      });
      const s = new THREE.Sprite(mat);
      s.visible = false;
      s.frustumCulled = false;
      scene.add(s);
      this.muzzlePool.push({ sprite: s, life: 0, maxLife: 0.12, vx: 0, vy: 0, vz: 0, baseScale: 0.2 });
    }

    // 墙面弹痕池（临时血迹，自动淡出）
    this.decalPool = [];
    const decalTex = decalTexture();
    const decalGeo = new THREE.PlaneGeometry(0.17, 0.17);
    for (let i = 0; i < 16; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: decalTex, transparent: true, opacity: 0,
        depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
      });
      const mesh = new THREE.Mesh(decalGeo, mat);
      mesh.visible = false;
      mesh.frustumCulled = true;
      scene.add(mesh);
      this.decalPool.push({ mesh, life: 0, maxLife: 8.0 });
    }
  }

  _getTracer() {
    return this.tracerPool.find((t) => t.life <= 0) || this.tracerPool[0];
  }

  _getSpark() {
    return this.sparkPool.find((t) => t.life <= 0) || this.sparkPool[0];
  }

  _getBlood() {
    return this.bloodPool.find((t) => t.life <= 0) || this.bloodPool[0];
  }

  _getMuzzle() {
    return this.muzzlePool.find((t) => t.life <= 0) || this.muzzlePool[0];
  }

  _getDecal() {
    return this.decalPool.find((d) => d.life <= 0) || this.decalPool[0];
  }

  /** 子弹曳光（起点 -> 终点） */
  spawnTracer(from, to) {
    const item = this._getTracer();
    const attr = item.line.geometry.attributes.position;
    attr.setXYZ(0, from.x, from.y, from.z);
    attr.setXYZ(1, to.x, to.y, to.z);
    attr.needsUpdate = true;
    item.line.material.opacity = 0.85;
    item.line.visible = true;
    item.life = item.maxLife;
  }

  /** 命中墙面：火花 + 临时弹痕 */
  spawnImpact(point, normal) {
    const item = this._getSpark();
    const offset = normal ? normal.clone().multiplyScalar(0.03) : new THREE.Vector3();
    item.sprite.position.copy(point).add(offset);
    item.sprite.scale.setScalar(item.baseScale);
    item.sprite.material.opacity = 1;
    item.sprite.visible = true;
    item.life = item.maxLife;

    // 弹痕贴在墙面，朝向法线并随机旋转，8 秒后淡出
    const decal = this._getDecal();
    const n = normal ? normal.clone().normalize() : new THREE.Vector3(0, 1, 0);
    decal.mesh.position.copy(point).addScaledVector(n, 0.012);
    decal.mesh.lookAt(point.clone().add(n));
    decal.mesh.rotateZ(Math.random() * Math.PI * 2);
    decal.mesh.scale.setScalar(0.8 + Math.random() * 0.5);
    decal.mesh.material.opacity = 0.95;
    decal.mesh.visible = true;
    decal.life = decal.maxLife;
  }

  /** 命中敌人的血液飞溅（红色粒子） */
  spawnBlood(point) {
    for (let i = 0; i < 4; i++) {
      const item = this._getBlood();
      item.sprite.position.copy(point);
      item.sprite.scale.setScalar(0.08 + Math.random() * 0.1);
      item.sprite.material.opacity = 0.9;
      item.sprite.visible = true;
      item.life = item.maxLife;
      item.vx = (Math.random() - 0.5) * 0.9;
      item.vy = Math.random() * 0.7 + 0.2;
      item.vz = (Math.random() - 0.5) * 0.9;
    }
  }

  /** 命中敌人：更密集的红色受击粒子 */
  spawnEnemyHit(point) {
    this.spawnBlood(point);
    for (let i = 0; i < 4; i++) {
      const item = this._getBlood();
      item.sprite.position.copy(point);
      item.sprite.scale.setScalar(0.05 + Math.random() * 0.08);
      item.sprite.material.opacity = 0.85;
      item.sprite.visible = true;
      item.life = item.maxLife;
      item.vx = (Math.random() - 0.5) * 1.6;
      item.vy = Math.random() * 1.1 + 0.2;
      item.vz = (Math.random() - 0.5) * 1.6;
    }
  }

  /** 枪口粒子火焰：沿枪口方向喷出 3 个粒子 */
  spawnMuzzleFlash(position, dir) {
    for (let i = 0; i < 3; i++) {
      const item = this._getMuzzle();
      item.sprite.position.copy(position);
      item.sprite.scale.setScalar(item.baseScale * (0.7 + Math.random() * 0.6));
      item.sprite.material.opacity = 1;
      item.sprite.visible = true;
      item.life = item.maxLife;
      const spread = 0.35;
      item.vx = dir.x * 2.2 + (Math.random() - 0.5) * spread;
      item.vy = dir.y * 2.2 + (Math.random() - 0.5) * spread;
      item.vz = dir.z * 2.2 + (Math.random() - 0.5) * spread;
    }
  }

  /** 每帧更新 */
  update(dt) {
    for (const t of this.tracerPool) {
      if (t.life > 0) {
        t.life -= dt;
        t.line.material.opacity = Math.max(0, t.life / t.maxLife) * 0.85;
        if (t.life <= 0) t.line.visible = false;
      }
    }
    for (const s of this.sparkPool) {
      if (s.life > 0) {
        s.life -= dt;
        const k = s.life / s.maxLife;
        s.sprite.material.opacity = k;
        s.sprite.scale.setScalar(s.baseScale * (1.6 - k * 0.6));
        if (s.life <= 0) s.sprite.visible = false;
      }
    }
    for (const b of this.bloodPool) {
      if (b.life > 0) {
        b.life -= dt;
        const k = b.life / b.maxLife;
        b.sprite.material.opacity = k * 0.9;
        b.sprite.position.x += b.vx * dt;
        b.sprite.position.y += (b.vy -= 2.2 * dt) * dt;
        b.sprite.position.z += b.vz * dt;
        if (b.life <= 0) b.sprite.visible = false;
      }
    }
    for (const m of this.muzzlePool) {
      if (m.life > 0) {
        m.life -= dt;
        const k = m.life / m.maxLife;
        m.sprite.material.opacity = k;
        m.sprite.position.x += m.vx * dt;
        m.sprite.position.y += m.vy * dt;
        m.sprite.position.z += m.vz * dt;
        m.sprite.scale.setScalar(0.2 * (0.5 + k));
        if (m.life <= 0) m.sprite.visible = false;
      }
    }
    for (const d of this.decalPool) {
      if (d.life > 0) {
        d.life -= dt;
        // 最后 2 秒淡出
        d.mesh.material.opacity = Math.min(0.95, d.life / 2) ;
        if (d.life <= 0) d.mesh.visible = false;
      }
    }
  }
}
