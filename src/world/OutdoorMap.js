/**
 * 露天货场地图（v0.3 非封闭式改造）
 *
 * 与封闭仓库版的差异：
 *  - **无天花板**：天空渐变背景 + 薄雾，视野通透，抬头可见天空；
 *  - 围栏/矮墙只做视觉边界（fenceHeight ≈ 1.55m），真实边界是四面隐形高墙
 *    （防止玩家与丧尸走出地图），因此"看得见外面但出不去"；
 *  - 掩体布局拉散到 56×44 的开阔货场：纸箱堆、集装箱、货架、油桶、报废车头；
 *  - 远景剪影楼群制造纵深，配合雾效淡出。
 */
import * as THREE from 'three';
import { WORLD, ENEMY, PLAYER } from '../config/weapon.js';

/** 用 Canvas 生成纹理，避免额外网络请求 */
function canvasTexture(size, draw, repeatX = 1, repeatY = 1) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  draw(ctx, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.anisotropy = 4;
  return t;
}

/** 天空渐变（用作 scene.background） */
function skyGradientTexture(top, bottom) {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, '#' + top.toString(16).padStart(6, '0'));
  g.addColorStop(1, '#' + bottom.toString(16).padStart(6, '0'));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 沥青地面 */
function asphaltTexture() {
  return canvasTexture(512, (ctx, s) => {
    ctx.fillStyle = '#43474c';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 14000; i++) {
      const v = 52 + Math.random() * 42;
      ctx.fillStyle = `rgba(${v},${v},${v + 3},${Math.random() * 0.22})`;
      ctx.fillRect(Math.random() * s, Math.random() * s, Math.random() * 4, Math.random() * 4);
    }
    // 裂纹
    for (let i = 0; i < 10; i++) {
      ctx.strokeStyle = 'rgba(22,24,26,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      let x = Math.random() * s, y = Math.random() * s;
      ctx.moveTo(x, y);
      for (let k = 0; k < 5; k++) {
        x += (Math.random() - 0.5) * 60;
        y += (Math.random() - 0.5) * 60;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }, 12, 10);
}

/** 混凝土（矮墙 / 基座） */
function concreteTexture() {
  return canvasTexture(512, (ctx, s) => {
    ctx.fillStyle = '#6a6e72';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 8000; i++) {
      const v = 82 + Math.random() * 55;
      ctx.fillStyle = `rgba(${v},${v + 3},${v + 6},${Math.random() * 0.22})`;
      ctx.fillRect(Math.random() * s, Math.random() * s, 1 + Math.random() * 3, 1 + Math.random() * 3);
    }
    ctx.strokeStyle = 'rgba(40,43,46,0.4)';
    ctx.lineWidth = 2;
    for (let y = 0; y <= s; y += 128) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(s, y); ctx.stroke();
    }
  }, 4, 1);
}

/** 纸箱纸板纹理 */
function cardboardTexture() {
  return canvasTexture(256, (ctx, s) => {
    ctx.fillStyle = '#9c7648';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 1600; i++) {
      const a = Math.random() * 0.18;
      ctx.fillStyle = `rgba(${Math.random() < 0.5 ? 60 : 190},${120 + Math.random() * 60},70,${a})`;
      ctx.fillRect(Math.random() * s, Math.random() * s, 1 + Math.random() * 3, 1 + Math.random() * 2);
    }
    ctx.fillStyle = 'rgba(214,199,160,0.55)';
    ctx.fillRect(s * 0.42, 0, s * 0.16, s);
    ctx.fillStyle = 'rgba(235,232,220,0.75)';
    ctx.fillRect(s * 0.1, s * 0.68, s * 0.24, s * 0.16);
    ctx.strokeStyle = 'rgba(80,60,40,0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(s * 0.1, s * 0.68, s * 0.24, s * 0.16);
    ctx.fillStyle = 'rgba(60,45,30,0.65)';
    for (let i = 0; i < 3; i++) ctx.fillRect(s * 0.12, s * 0.71 + i * 8, s * 0.16, 2);
  });
}

export class OutdoorMap {
  constructor(scene, collision, assets) {
    this.scene = scene;
    this.collision = collision;
    this.assets = assets;
    this.group = new THREE.Group();
    this.playerSpawn = new THREE.Vector3(PLAYER.startPos.x, PLAYER.startPos.y, PLAYER.startPos.z);
    this.waypoints = ENEMY.patrolPoints.map((p) => new THREE.Vector3(p.x, 0, p.z));

    this.matConcrete = new THREE.MeshStandardMaterial({
      map: concreteTexture(), roughness: 0.92, metalness: 0.04,
    });
    this.matFloor = new THREE.MeshStandardMaterial({
      map: asphaltTexture(), roughness: 0.95, metalness: 0.02,
    });
    this.matCardboard = new THREE.MeshStandardMaterial({
      map: cardboardTexture(), roughness: 0.85, metalness: 0.0,
    });
    this.matMetal = new THREE.MeshStandardMaterial({
      color: 0x5a6068, roughness: 0.55, metalness: 0.55,
    });
    this.matBeam = new THREE.MeshStandardMaterial({
      color: 0x3c424a, roughness: 0.7, metalness: 0.35,
    });
    this.matFence = new THREE.MeshStandardMaterial({
      color: 0x707a82, roughness: 0.6, metalness: 0.5,
    });
    this.matSilhouette = new THREE.MeshStandardMaterial({
      color: 0x8fa2b4, roughness: 1.0, metalness: 0.0,
    });
  }

  build() {
    this._buildSky();
    this._buildFloor();
    this._buildPerimeter();
    this._buildCrates();
    this._buildShelves();
    this._buildContainer();
    this._buildProps();
    this._buildSilhouettes();
    this._buildLights();
    this.group.traverse((o) => {
      o.matrixAutoUpdate = false;
      o.updateMatrix();
    });
    this.scene.add(this.group);
    return this;
  }

  // ---------------- 天空（非封闭的关键） ----------------
  _buildSky() {
    this.scene.background = skyGradientTexture(WORLD.skyTop, WORLD.skyBottom);
    this.scene.fog = new THREE.Fog(WORLD.fogColor, WORLD.fogNear, WORLD.fogFar);
  }

  // ---------------- 地面 ----------------
  _buildFloor() {
    const w = WORLD.halfX * 2;
    const d = WORLD.halfZ * 2;
    const geo = new THREE.PlaneGeometry(w, d, 1, 1);
    const floor = new THREE.Mesh(geo, this.matFloor);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, 0);
    floor.receiveShadow = true;
    this.group.add(floor);
    this.collision.addBox(0, -0.5, 0, w, 1, d, 'floor');
  }

  // ---------------- 边界：视觉围栏 + 隐形高墙 ----------------
  _buildPerimeter() {
    const x = WORLD.halfX;
    const z = WORLD.halfZ;
    const fh = WORLD.fenceHeight;

    // 隐形边界高墙（碰撞用，不可见）——保证玩家/丧尸不出地图
    const inv = (cx, cy, cz, sx, sy, sz) => this.collision.addBox(cx, cy, cz, sx, sy, sz, 'wall');
    inv(0, WORLD.wallHeight / 2, -z, x * 2 + 2, WORLD.wallHeight, 1);
    inv(0, WORLD.wallHeight / 2, z, x * 2 + 2, WORLD.wallHeight, 1);
    inv(-x, WORLD.wallHeight / 2, 0, 1, WORLD.wallHeight, z * 2 + 2);
    inv(x, WORLD.wallHeight / 2, 0, 1, WORLD.wallHeight, z * 2 + 2);

    // 视觉围栏：柱 + 两道横杆（低矮，抬头可见天空）
    const postGeo = new THREE.BoxGeometry(0.12, fh, 0.12);
    const railGeo = new THREE.BoxGeometry(1, 0.06, 0.06);
    const addPost = (px, pz) => {
      const m = new THREE.Mesh(postGeo, this.matFence);
      m.position.set(px, fh / 2, pz);
      m.castShadow = true;
      this.group.add(m);
    };
    const addRail = (x0, z0, x1, z1, y) => {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const m = new THREE.Mesh(railGeo, this.matFence);
      m.scale.x = len;
      m.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
      m.rotation.y = Math.atan2(z1 - z0, x1 - x0);
      m.castShadow = true;
      this.group.add(m);
    };
    // 南北边
    for (let px = -x; px <= x; px += 4) {
      addPost(px, -z); addPost(px, z);
    }
    // 东西边
    for (let pz = -z; pz <= z; pz += 4) {
      addPost(-x, pz); addPost(x, pz);
    }
    for (const y of [fh * 0.45, fh * 0.85]) {
      addRail(-x, -z, x, -z, y);
      addRail(-x, z, x, z, y);
      addRail(-x, -z, -x, z, y);
      addRail(x, -z, x, z, y);
    }

    // 混凝土矮墙段（带缺口，做掩体也做视觉边界）
    const segs = [
      [-14, -z + 0.4, 10, 1.15], [12, -z + 0.4, 8, 1.15],
      [-10, z - 0.4, 12, 1.15], [14, z - 0.4, 9, 1.15],
      [-x + 0.4, -6, 1.15, 10], [-x + 0.4, 10, 1.15, 8],
      [x - 0.4, -8, 1.15, 9], [x - 0.4, 8, 1.15, 11],
    ];
    for (const [cx, cz, sx, sz] of segs) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(sx, 1.15, sz), this.matConcrete);
      m.position.set(cx, 0.575, cz);
      m.castShadow = true;
      m.receiveShadow = true;
      this.group.add(m);
      this.collision.addBox(cx, 0.575, cz, sx, 1.15, sz, 'wall');
    }
  }

  // ---------------- 纸箱掩体 ----------------
  _buildCrates() {
    const crates = [
      { x: -12, z: -5, w: 1.4, h: 1.4, d: 1.4 },
      { x: -10.5, z: -5, w: 1.4, h: 1.4, d: 1.4, onTop: true },
      { x: 12, z: -5, w: 1.5, h: 1.1, d: 1.3 },
      { x: 13.5, z: -5.8, w: 1.2, h: 1.2, d: 1.2 },
      { x: -11, z: 6, w: 1.6, h: 1.6, d: 1.6 },
      { x: 11, z: 6, w: 1.3, h: 1.3, d: 1.3 },
      { x: 0, z: -11, w: 2.2, h: 2.0, d: 1.6 },
      { x: 2.4, z: -11, w: 1.2, h: 1.2, d: 1.4 },
      { x: -4, z: 9.5, w: 1.4, h: 1.4, d: 1.4 },
      { x: -2.5, z: 9.6, w: 1.3, h: 1.0, d: 1.3 },
      { x: 19, z: 15, w: 1.5, h: 1.5, d: 1.5 },
      { x: -21, z: -17, w: 1.8, h: 1.4, d: 1.2 },
      { x: 23, z: -3, w: 1.4, h: 1.4, d: 1.4 },
      { x: -23, z: 2, w: 1.2, h: 1.8, d: 1.2 },
      { x: 7, z: 13, w: 1.6, h: 1.2, d: 1.6 },
      { x: -17, z: 12, w: 1.2, h: 1.0, d: 1.6 },
      { x: 5, z: -16, w: 1.5, h: 1.3, d: 1.5 },
      { x: -6, z: -16, w: 1.7, h: 1.5, d: 1.3 },
    ];

    let idx = 0;
    for (const c of crates) {
      const baseY = c.onTop ? 1.4 : 0;
      this._addCrate(c.x, c.z, c.w, c.h, c.d, baseY, idx++);
    }
  }

  _addCrate(x, z, w, h, d, baseY = 0, seed = 0) {
    let mesh;
    const models = this.assets && this.assets.boxes;
    if (models && models.length > 0) {
      const src = models[seed % models.length];
      mesh = src.clone(true);
      const box0 = new THREE.Box3().setFromObject(mesh);
      const size = box0.getSize(new THREE.Vector3());
      const s = Math.min(w / Math.max(size.x, 0.001), h / Math.max(size.y, 0.001), d / Math.max(size.z, 0.001));
      mesh.scale.setScalar(s);
      const box1 = new THREE.Box3().setFromObject(mesh);
      mesh.position.set(
        x - (box1.min.x + box1.max.x) / 2,
        baseY - box1.min.y,
        z - (box1.min.z + box1.max.z) / 2
      );
      mesh.traverse((o) => {
        if (o.isMesh) {
          o.material = this.matCardboard;
          o.castShadow = true;
          o.receiveShadow = true;
          o.frustumCulled = true;
        }
      });
      mesh.rotation.y = (Math.random() - 0.5) * 0.35;
    } else {
      mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.matCardboard);
      mesh.position.set(x, baseY + h / 2, z);
    }

    this.group.add(mesh);
    this.collision.addBox(x, baseY + h / 2, z, w + 0.06, h, d + 0.06, 'crate');
  }

  // ---------------- 货架（露天横排） ----------------
  _buildShelves() {
    const racks = [
      { x: -25, z: -6, w: 1.0, h: 3.4, d: 12 },
      { x: 25, z: 6, w: 1.0, h: 3.4, d: 12 },
      { x: 0, z: 19, w: 14, h: 3.0, d: 0.9 },
    ];
    for (const r of racks) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(r.w, r.h, r.d), this.matMetal);
      mesh.position.set(r.x, r.h / 2, r.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.collision.addBox(r.x, r.h / 2, r.z, r.w, r.h, r.d, 'rack');

      const shelfGeo = new THREE.BoxGeometry(r.w + 0.06, 0.08, r.d);
      for (let y = 0.8; y < r.h; y += 0.9) {
        const shelf = new THREE.Mesh(shelfGeo, this.matBeam);
        shelf.position.set(r.x, y, r.z);
        shelf.castShadow = true;
        this.group.add(shelf);
      }
    }
  }

  // ---------------- 集装箱（大掩体） ----------------
  _buildContainer() {
    const mat = new THREE.MeshStandardMaterial({ color: 0x7a4a2a, roughness: 0.7, metalness: 0.35 });
    const matDark = new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.75, metalness: 0.3 });
    const matBlue = new THREE.MeshStandardMaterial({ color: 0x2e5a7a, roughness: 0.7, metalness: 0.35 });
    const containers = [
      { x: -20, z: -2, rot: 0, mat },
      { x: 18, z: 14, rot: 0.12, mat: matBlue },
      { x: -18, z: 16, rot: -0.2, mat },
    ];
    for (const c of containers) {
      const g = new THREE.Group();
      const box = new THREE.Mesh(new THREE.BoxGeometry(6, 2.6, 2.4), c.mat);
      box.position.y = 1.3;
      box.castShadow = true;
      box.receiveShadow = true;
      g.add(box);
      for (let i = -2.5; i <= 2.5; i += 0.5) {
        const rib = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.4, 2.42), matDark);
        rib.position.set(i, 1.3, 0);
        rib.castShadow = true;
        g.add(rib);
      }
      g.position.set(c.x, 0, c.z);
      g.rotation.y = c.rot;
      this.group.add(g);
      const w = Math.abs(Math.cos(c.rot)) * 6 + Math.abs(Math.sin(c.rot)) * 2.4;
      const d = Math.abs(Math.sin(c.rot)) * 6 + Math.abs(Math.cos(c.rot)) * 2.4;
      this.collision.addBox(c.x, 1.3, c.z, w, 2.6, d, 'crate');
    }
  }

  // ---------------- 道具：油桶 / 标线 / 堆叠货箱 / 报废车头 ----------------
  _buildProps() {
    // 油桶
    const barrelGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.95, 12);
    const barrelMat = new THREE.MeshStandardMaterial({ color: 0x9a5a22, roughness: 0.5, metalness: 0.65 });
    const barrels = [
      [-24, -12], [-23.3, -11.1], [19, -9], [24, 9], [-13, 18], [12, -18], [-2, -19],
      [-18, -8], [-17, -7], [21, 1], [22, 0], [-6, 17], [-4.5, 16],
    ];
    const barrelMesh = new THREE.InstancedMesh(barrelGeo, barrelMat, barrels.length);
    const dummy = new THREE.Object3D();
    barrels.forEach(([x, z], i) => {
      dummy.position.set(x, 0.475, z);
      dummy.rotation.set(0, Math.random() * Math.PI, 0);
      dummy.updateMatrix();
      barrelMesh.setMatrixAt(i, dummy.matrix);
      this.collision.addBox(x, 0.475, z, 0.7, 0.95, 0.7, 'barrel');
    });
    barrelMesh.instanceMatrix.needsUpdate = true;
    barrelMesh.castShadow = true;
    barrelMesh.receiveShadow = true;
    this.group.add(barrelMesh);

    // 沙袋堆（低矮掩体，可蹲伏在后面）
    const sandbagGeo = new THREE.BoxGeometry(1.0, 0.45, 0.55);
    const sandbagMat = new THREE.MeshStandardMaterial({ color: 0x8a7a52, roughness: 0.95, metalness: 0.0 });
    const sandbagGroups = [
      { x: -14, z: -8, count: 3, ry: 0.3 },
      { x: 14, z: -8, count: 3, ry: -0.25 },
      { x: -8, z: 2, count: 2, ry: 0.8 },
      { x: 8, z: 2, count: 2, ry: -0.7 },
      { x: 0, z: -4, count: 3, ry: 0 },
      { x: -19, z: 12, count: 2, ry: 0.5 },
      { x: 19, z: 12, count: 2, ry: -0.4 },
    ];
    for (const sg of sandbagGroups) {
      for (let i = 0; i < sg.count; i++) {
        const ox = (i - (sg.count - 1) / 2) * 1.05;
        const x = sg.x + ox * Math.cos(sg.ry);
        const z = sg.z + ox * Math.sin(sg.ry);
        const m = new THREE.Mesh(sandbagGeo, sandbagMat);
        m.position.set(x, 0.225, z);
        m.rotation.y = sg.ry;
        m.castShadow = true;
        m.receiveShadow = true;
        this.group.add(m);
        // 碰撞用 AABB 近似（忽略旋转）
        this.collision.addBox(x, 0.225, z, 1.0, 0.45, 0.55, 'crate');
      }
    }

    // 轮胎堆（中等高度掩体）
    const tireGeo = new THREE.TorusGeometry(0.42, 0.16, 8, 16);
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x222426, roughness: 0.85, metalness: 0.1 });
    const tireStacks = [
      { x: -11, z: -12, n: 3 },
      { x: 11, z: -12, n: 2 },
      { x: -22, z: -5, n: 3 },
      { x: 22, z: 5, n: 3 },
      { x: -5, z: 14, n: 2 },
      { x: 15, z: -3, n: 2 },
    ];
    for (const ts of tireStacks) {
      for (let i = 0; i < ts.n; i++) {
        const t = new THREE.Mesh(tireGeo, tireMat);
        t.position.set(ts.x, 0.42 + i * 0.34, ts.z);
        t.rotation.x = Math.PI / 2 + (i % 2) * 0.15;
        t.rotation.z = i * 0.3;
        t.castShadow = true;
        t.receiveShadow = true;
        this.group.add(t);
      }
      // 碰撞：近似为一个圆柱盒
      this.collision.addBox(ts.x, ts.n * 0.17, ts.z, 0.8, ts.n * 0.34 + 0.2, 0.8, 'crate');
    }

    // 地面黄色安全标线
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xd0a72c, transparent: true, opacity: 0.38 });
    const lineGeo = new THREE.PlaneGeometry(1, 1);
    const lines = [
      [0, -9, 26, 0.16], [0, 9, 26, 0.16],
      [-16, 0, 0.16, 17], [16, 0, 0.16, 17],
    ];
    for (const [x, z, w, d] of lines) {
      const m = new THREE.Mesh(lineGeo, lineMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.008, z);
      m.scale.set(w, d, 1);
      this.group.add(m);
    }

    // 堆叠货箱（集装箱顶）
    const stacks = [];
    for (const c of [{ x: -20, z: -2, rot: 0 }, { x: 18, z: 14, rot: 0.12 }]) {
      for (let i = -1; i <= 1; i++) {
        for (let j = 0; j < 2; j++) {
          const ox = i * 1.7;
          const oz = (j - 0.5) * 1.1;
          stacks.push({
            x: c.x + ox * Math.cos(c.rot) - oz * Math.sin(c.rot),
            y: 2.85,
            z: c.z + ox * Math.sin(c.rot) + oz * Math.cos(c.rot),
            ry: (Math.random() - 0.5) * 0.4,
          });
        }
      }
    }
    const stackGeo = new THREE.BoxGeometry(0.62, 0.5, 0.62);
    const stackMesh = new THREE.InstancedMesh(stackGeo, this.matCardboard, stacks.length);
    stacks.forEach((s, i) => {
      dummy.position.set(s.x, s.y, s.z);
      dummy.rotation.set(0, s.ry, 0);
      dummy.updateMatrix();
      stackMesh.setMatrixAt(i, dummy.matrix);
    });
    stackMesh.instanceMatrix.needsUpdate = true;
    stackMesh.castShadow = true;
    stackMesh.receiveShadow = true;
    this.group.add(stackMesh);

    // 报废车头（两台，当大掩体）
    const carMat = new THREE.MeshStandardMaterial({ color: 0x6e3b2e, roughness: 0.72, metalness: 0.4 });
    const carGlass = new THREE.MeshStandardMaterial({ color: 0x223038, roughness: 0.3, metalness: 0.6 });
    for (const [cx, cz, ry] of [[-7, -18, 0.35], [9, 17, -0.5]]) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(4.4, 1.15, 2.0), carMat);
      body.position.y = 0.85;
      const cab = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.95, 1.85), carMat);
      cab.position.set(-0.4, 1.85, 0);
      const win = new THREE.Mesh(new THREE.BoxGeometry(2.12, 0.62, 1.9), carGlass);
      win.position.set(-0.4, 1.9, 0);
      const hood = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.5, 1.9), carMat);
      hood.position.set(1.7, 1.25, 0);
      for (const part of [body, cab, win, hood]) {
        part.castShadow = true;
        part.receiveShadow = true;
        g.add(part);
      }
      g.position.set(cx, 0, cz);
      g.rotation.y = ry;
      this.group.add(g);
      this.collision.addBox(cx, 1.2, cz, 4.6, 2.4, 2.2, 'crate');
    }
  }

  // ---------------- 远景剪影（地图外，只看不碰） ----------------
  _buildSilhouettes() {
    // 远处楼群剪影，配合雾效制造纵深（无碰撞）
    const blocks = [
      [-70, -60, 26, 34, 20], [-40, -75, 20, 26, 18], [0, -85, 30, 40, 22],
      [38, -72, 22, 30, 18], [72, -58, 28, 36, 20],
      [-80, 30, 24, 28, 20], [80, 26, 26, 32, 22], [-65, 70, 22, 24, 18], [65, 72, 24, 30, 20],
    ];
    for (const [x, z, w, h, d] of blocks) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.matSilhouette);
      m.position.set(x, h / 2 - 2, z);
      this.group.add(m);
    }
  }

  // ---------------- 灯光（晴天日光） ----------------
  _buildLights() {
    // 天光：偏冷的天空色对暖棕地面，模拟阴天/傍晚货场
    const hemi = new THREE.HemisphereLight(0xbcd4ea, 0x4a4234, 0.85);
    this.scene.add(hemi);

    // 主太阳光（投影方向光）
    const dir = new THREE.DirectionalLight(0xffeed2, 2.4);
    dir.position.set(-30, 42, 22);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.camera.left = -36;
    dir.shadow.camera.right = 36;
    dir.shadow.camera.top = 32;
    dir.shadow.camera.bottom = -32;
    dir.shadow.camera.near = 1;
    dir.shadow.camera.far = 110;
    dir.shadow.bias = -0.0006;
    dir.shadow.normalBias = 0.025;
    this.scene.add(dir);

    // 冷色补光，勾背面轮廓
    const fill = new THREE.DirectionalLight(0x7fa4cc, 0.5);
    fill.position.set(22, 16, -28);
    this.scene.add(fill);

    const ambient = new THREE.AmbientLight(0x46505c, 0.5);
    this.scene.add(ambient);

    // 场地灯柱（2 盏，点光源不投影）
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x3a4046, roughness: 0.6, metalness: 0.5 });
    for (const [x, z] of [[-14, -12], [14, 12]]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.13, 6.4, 8), poleMat);
      pole.position.set(x, 3.2, z);
      pole.castShadow = true;
      this.group.add(pole);
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.16, 0.4), poleMat);
      head.position.set(x, 6.35, z);
      this.group.add(head);
      const lamp = new THREE.PointLight(0xffe0a8, 2.2, 22, 1.8);
      lamp.position.set(x, 6.1, z);
      this.scene.add(lamp);
    }
  }
}
