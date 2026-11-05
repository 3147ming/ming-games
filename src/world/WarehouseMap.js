/**
 * 仓库地图（CF 经典仓库风格）
 * - 复用仓库中的纸箱 FBX 作为掩体外观，贴图使用程序化生成的纸板纹理
 * - 所有墙体/箱子同步注册 AABB 碰撞盒
 * - 同时提供敌人巡逻点
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

/** 混凝土墙面 */
function concreteTexture() {
  return canvasTexture(512, (ctx, s) => {
    ctx.fillStyle = '#5d6165';
    ctx.fillRect(0, 0, s, s);
    // 噪点
    for (let i = 0; i < 9000; i++) {
      const v = 70 + Math.random() * 60;
      ctx.fillStyle = `rgba(${v},${v + 4},${v + 8},${Math.random() * 0.25})`;
      const r = Math.random() * 3 + 0.6;
      ctx.fillRect(Math.random() * s, Math.random() * s, r, r);
    }
    // 接缝
    ctx.strokeStyle = 'rgba(30,33,36,0.55)';
    ctx.lineWidth = 2;
    for (let x = 0; x <= s; x += 128) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, s); ctx.stroke();
    }
    for (let y = 0; y <= s; y += 128) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(s, y); ctx.stroke();
    }
    // 污渍
    for (let i = 0; i < 14; i++) {
      const x = Math.random() * s, y = Math.random() * s, r = 20 + Math.random() * 60;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(20,22,24,0.22)');
      g.addColorStop(1, 'rgba(20,22,24,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
  }, 4, 2);
}

/** 地面：深灰水泥 + 黄色安全线 */
function floorTexture() {
  return canvasTexture(512, (ctx, s) => {
    ctx.fillStyle = '#3c4045';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 12000; i++) {
      const v = 48 + Math.random() * 40;
      ctx.fillStyle = `rgba(${v},${v},${v},${Math.random() * 0.2})`;
      ctx.fillRect(Math.random() * s, Math.random() * s, Math.random() * 4, Math.random() * 4);
    }
    // 地砖分格
    ctx.strokeStyle = 'rgba(18,20,22,0.65)';
    ctx.lineWidth = 3;
    for (let i = 0; i <= s; i += 85) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, s); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(s, i); ctx.stroke();
    }
    // 磨损
    for (let i = 0; i < 8; i++) {
      ctx.strokeStyle = 'rgba(20,20,20,0.3)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.random() * s, Math.random() * s);
      ctx.lineTo(Math.random() * s, Math.random() * s);
      ctx.stroke();
    }
  }, 10, 8);
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
    // 胶带
    ctx.fillStyle = 'rgba(214,199,160,0.55)';
    ctx.fillRect(s * 0.42, 0, s * 0.16, s);
    // 标签
    ctx.fillStyle = 'rgba(235,232,220,0.75)';
    ctx.fillRect(s * 0.1, s * 0.68, s * 0.24, s * 0.16);
    ctx.strokeStyle = 'rgba(80,60,40,0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(s * 0.1, s * 0.68, s * 0.24, s * 0.16);
    ctx.fillStyle = 'rgba(60,45,30,0.65)';
    for (let i = 0; i < 3; i++) ctx.fillRect(s * 0.12, s * 0.71 + i * 8, s * 0.16, 2);
  });
}

export class WarehouseMap {
  constructor(scene, collision, assets) {
    this.scene = scene;
    this.collision = collision;
    this.assets = assets;
    this.group = new THREE.Group();
    this.playerSpawn = new THREE.Vector3(PLAYER.startPos.x, PLAYER.startPos.y, PLAYER.startPos.z);
    this.waypoints = ENEMY.patrolPoints.map((p) => new THREE.Vector3(p.x, 0, p.z));

    // 共享材质
    this.matConcrete = new THREE.MeshStandardMaterial({
      map: concreteTexture(), roughness: 0.92, metalness: 0.04,
    });
    this.matFloor = new THREE.MeshStandardMaterial({
      map: floorTexture(), roughness: 0.95, metalness: 0.02,
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
  }

  build() {
    this._buildFloor();
    this._buildWalls();
    this._buildCeiling();
    this._buildCrates();
    this._buildShelves();
    this._buildStains();
    this._buildContainer();
    this._buildProps();      // 第三轮：油桶 / 地面标线 / 墙面污渍 / 堆叠货箱
    this._buildLights();
    // 第三轮：静态物体关闭矩阵自动更新，减少每帧计算开销
    this.group.traverse((o) => {
      o.matrixAutoUpdate = false;
      o.updateMatrix();
    });
    this.scene.add(this.group);
    return this;
  }

  // ---------------- 地面 ----------------
  _buildFloor() {
    const w = WORLD.halfX * 2;
    const d = WORLD.halfZ * 2;
    const geo = new THREE.PlaneGeometry(w, d, 1, 1);
    const floor = new THREE.Mesh(geo, this.matFloor);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, 0);
    // 第三轮：地面接收阴影
    floor.receiveShadow = true;
    this.group.add(floor);
    // 地面碰撞（薄板，防止射线穿透地面）
    this.collision.addBox(0, -0.5, 0, w, 1, d, 'floor');
  }

  // ---------------- 墙体 ----------------
  _buildWalls() {
    const h = WORLD.wallHeight;
    const t = 0.6;
    const x = WORLD.halfX;
    const z = WORLD.halfZ;

    // 外墙
    this._wall(0, h / 2, -z + t / 2, x * 2, h, t);       // 北墙
    this._wall(0, h / 2, z - t / 2, x * 2, h, t);        // 南墙
    this._wall(-x + t / 2, h / 2, 0, t, h, z * 2);       // 西墙
    this._wall(x - t / 2, h / 2, 0, t, h, z * 2);        // 东墙

    // 内部隔断（制造转角与掩体）
    this._wall(-10, h / 2, -6, t, h, 9);
    this._wall(10, h / 2, 6, t, h, 9);
    this._wall(4, h / 2, -10, 12, h, t);
    this._wall(-4, h / 2, 10, 12, h, t);
  }

  /** 添加一段墙体（同时注册碰撞） */
  _wall(cx, cy, cz, sx, sy, sz) {
    const geo = new THREE.BoxGeometry(sx, sy, sz);
    const mesh = new THREE.Mesh(geo, this.matConcrete);
    mesh.position.set(cx, cy, cz);
    // 第三轮：墙体投射/接收阴影
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.collision.addBox(cx, cy, cz, sx, sy, sz, 'wall');
  }

  // ---------------- 顶部结构 ----------------
  _buildCeiling() {
    const h = WORLD.wallHeight;
    const roofGeo = new THREE.PlaneGeometry(WORLD.halfX * 2, WORLD.halfZ * 2);
    // 天花板用暖灰色避免死黑
    const roofMat = new THREE.MeshStandardMaterial({
      color: 0x3a4048, roughness: 0.92, metalness: 0.05, side: THREE.DoubleSide,
      emissive: 0x232830, emissiveIntensity: 1.25,   // 第三轮：自发光托底，杜绝纯黑天花板
    });
    const roof = new THREE.Mesh(roofGeo, roofMat);
    roof.rotation.x = Math.PI / 2;
    roof.position.y = h;
    roof.receiveShadow = true;   // 第三轮：接收阴影
    this.group.add(roof);

    // 屋顶横梁
    const beamGeo = new THREE.BoxGeometry(WORLD.halfX * 2 - 1, 0.28, 0.28);
    for (let z = -12; z <= 12; z += 6) {
      const beam = new THREE.Mesh(beamGeo, this.matBeam);
      beam.position.set(0, h - 0.35, z);
      beam.castShadow = true;
      this.group.add(beam);
    }

    // 金属管道沿墙顶布置（装饰）
    const pipeMat = new THREE.MeshStandardMaterial({ color: 0x6a7078, roughness: 0.4, metalness: 0.7 });
    const pipeGeo = new THREE.CylinderGeometry(0.09, 0.09, WORLD.halfX * 2 - 2, 10);
    for (const z of [-14.5, 14.5]) {
      const pipe = new THREE.Mesh(pipeGeo, pipeMat);
      pipe.rotation.z = Math.PI / 2;
      pipe.position.set(0, h - 0.8, z);
      this.group.add(pipe);
    }
    // 纵向连接管
    const pipeGeo2 = new THREE.CylinderGeometry(0.07, 0.07, WORLD.halfZ * 2 - 4, 8);
    for (const x of [-10, 0, 10]) {
      const pipe = new THREE.Mesh(pipeGeo2, pipeMat);
      pipe.rotation.x = Math.PI / 2;
      pipe.position.set(x, h - 0.8, 0);
      this.group.add(pipe);
    }
  }

  // ---------------- 纸箱掩体 ----------------
  _buildCrates() {
    // [x, z, 宽, 高, 深]
    const crates = [
      { x: -8, z: -3, w: 1.4, h: 1.4, d: 1.4 },
      { x: -6.5, z: -3, w: 1.4, h: 1.4, d: 1.4, onTop: true },
      { x: 8, z: -3, w: 1.5, h: 1.1, d: 1.3 },
      { x: 9.5, z: -3.8, w: 1.2, h: 1.2, d: 1.2 },
      { x: -7, z: 4, w: 1.6, h: 1.6, d: 1.6 },
      { x: 7.5, z: 4, w: 1.3, h: 1.3, d: 1.3 },
      { x: 0, z: -7.5, w: 2.2, h: 2.0, d: 1.6 },
      { x: 2.4, z: -7.5, w: 1.2, h: 1.2, d: 1.4 },
      { x: -3, z: 6.5, w: 1.4, h: 1.4, d: 1.4 },
      { x: -1.5, z: 6.6, w: 1.3, h: 1.0, d: 1.3 },
      { x: 14, z: 11, w: 1.5, h: 1.5, d: 1.5 },
      { x: -16, z: -13, w: 1.8, h: 1.4, d: 1.2 },
      { x: 18, z: -2, w: 1.4, h: 1.4, d: 1.4 },
      { x: -18, z: 1, w: 1.2, h: 1.8, d: 1.2 },
      { x: 5, z: 9, w: 1.6, h: 1.2, d: 1.6 },
      { x: -12, z: 8, w: 1.2, h: 1.0, d: 1.6 },
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
      // 复用仓库纸箱 FBX
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
          // 第三轮：纸箱投射/接收软阴影
          o.castShadow = true;
          o.receiveShadow = true;
          o.frustumCulled = true;
        }
      });
      // 轻微随机朝向，增加真实感（碰撞用 AABB 略放大）
      mesh.rotation.y = (Math.random() - 0.5) * 0.35;
    } else {
      // 兜底：纯几何纸箱
      mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.matCardboard);
      mesh.position.set(x, baseY + h / 2, z);
    }

    this.group.add(mesh);
    this.collision.addBox(x, baseY + h / 2, z, w + 0.06, h, d + 0.06, 'crate');
  }

  // ---------------- 货架 ----------------
  _buildShelves() {
    const racks = [
      { x: -19, z: -4, w: 1.0, h: 3.6, d: 10 },
      { x: 19, z: 4, w: 1.0, h: 3.6, d: 10 },
      { x: 0, z: 14.2, w: 10, h: 3.0, d: 0.9 },
    ];
    for (const r of racks) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(r.w, r.h, r.d), this.matMetal);
      mesh.position.set(r.x, r.h / 2, r.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.collision.addBox(r.x, r.h / 2, r.z, r.w, r.h, r.d, 'rack');

      // 货架横档（装饰）
      const shelfGeo = new THREE.BoxGeometry(r.w + 0.06, 0.08, r.d);
      for (let y = 0.8; y < r.h; y += 0.9) {
        const shelf = new THREE.Mesh(shelfGeo, this.matBeam);
        shelf.position.set(r.x, y, r.z);
        shelf.castShadow = true;
        this.group.add(shelf);
      }
    }
  }

  // ---------------- 地面污渍（视觉装饰，不碰撞） ----------------
  _buildStains() {
    const stains = [
      { x: -5, z: 0, r: 2.5, o: 0.18 },
      { x: 6, z: -5, r: 1.8, o: 0.22 },
      { x: -12, z: 5, r: 3.0, o: 0.15 },
      { x: 10, z: 8, r: 1.5, o: 0.2 },
      { x: 0, z: -12, r: 2.2, o: 0.16 },
    ];
    const geo = new THREE.CircleGeometry(1, 20);
    for (const s of stains) {
      const m = new THREE.MeshBasicMaterial({
        color: 0x14161a, transparent: true, opacity: s.o, depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, m);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(s.x, 0.005, s.z);
      mesh.scale.setScalar(s.r);
      this.group.add(mesh);
    }
  }

  // ---------------- 集装箱（大掩体 + 碰撞） ----------------
  _buildContainer() {
    // 集装箱金属材质（带波纹条纹）
    const mat = new THREE.MeshStandardMaterial({ color: 0x7a4a2a, roughness: 0.7, metalness: 0.35 });
    const matDark = new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.75, metalness: 0.3 });
    const containers = [
      { x: -16, z: -2, rot: 0 },
      { x: 15, z: 10, rot: 0.12 },
    ];
    for (const c of containers) {
      const g = new THREE.Group();
      // 箱体 6×2.6×2.4
      const box = new THREE.Mesh(new THREE.BoxGeometry(6, 2.6, 2.4), mat);
      box.position.y = 1.3;
      box.castShadow = true;
      box.receiveShadow = true;
      g.add(box);
      // 波纹条
      for (let i = -2.5; i <= 2.5; i += 0.5) {
        const rib = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.4, 2.42), matDark);
        rib.position.set(i, 1.3, 0);
        rib.castShadow = true;
        g.add(rib);
      }
      g.position.set(c.x, 0, c.z);
      g.rotation.y = c.rot;
      this.group.add(g);
      // 碰撞（AABB 近似，考虑旋转后用包围盒稍大些）
      const w = Math.abs(Math.cos(c.rot)) * 6 + Math.abs(Math.sin(c.rot)) * 2.4;
      const d = Math.abs(Math.sin(c.rot)) * 6 + Math.abs(Math.cos(c.rot)) * 2.4;
      this.collision.addBox(c.x, 1.3, c.z, w, 2.6, d, 'crate');
    }
  }

  // ---------------- 第三轮新增道具：油桶 / 标线 / 墙面污渍 / 堆叠货箱 ----------------
  _buildProps() {
    // 1) 油桶：InstancedMesh 批量渲染，减少 draw call
    const barrelGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.95, 12);
    const barrelMat = new THREE.MeshStandardMaterial({ color: 0x9a5a22, roughness: 0.5, metalness: 0.65 });
    const barrels = [
      [-17.6, -8.2], [-16.9, -7.3], [13.8, -5.8], [17.2, 6.2], [-9.4, 12.3], [8.4, -12.2],
    ];
    const barrelMesh = new THREE.InstancedMesh(barrelGeo, barrelMat, barrels.length);
    const dummy = new THREE.Object3D();
    barrels.forEach(([x, z], i) => {
      dummy.position.set(x, 0.475, z);
      dummy.rotation.set(0, Math.random() * Math.PI, 0);
      dummy.updateMatrix();
      barrelMesh.setMatrixAt(i, dummy.matrix);
      // 油桶碰撞盒（防止穿模）
      this.collision.addBox(x, 0.475, z, 0.7, 0.95, 0.7, 'barrel');
    });
    barrelMesh.instanceMatrix.needsUpdate = true;
    barrelMesh.castShadow = true;
    barrelMesh.receiveShadow = true;
    this.group.add(barrelMesh);

    // 2) 地面黄色安全标线（装饰，无碰撞）
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xd0a72c, transparent: true, opacity: 0.42 });
    const lineGeo = new THREE.PlaneGeometry(1, 1);
    const lines = [
      [0, -6.2, 18, 0.16], [0, 6.2, 18, 0.16],
      [-11.2, 0, 0.16, 12], [11.2, 0, 0.16, 12],
    ];
    for (const [x, z, w, d] of lines) {
      const m = new THREE.Mesh(lineGeo, lineMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.008, z);
      m.scale.set(w, d, 1);
      this.group.add(m);
    }

    // 3) 墙面污渍 / 旧弹痕（贴墙薄片，轻量装饰）
    const stainMat = new THREE.MeshBasicMaterial({
      color: 0x14161a, transparent: true, opacity: 0.4, depthWrite: false,
    });
    const stainGeo = new THREE.CircleGeometry(0.55, 10);
    const wallSpots = [
      [-18.5, 3.0, -15.66, 0],
      [-4.0, 4.2, -15.66, 0],
      [12.5, 2.4, -15.66, 0],
      [-6.0, 3.3, 15.66, Math.PI],
      [16.0, 4.0, 15.66, Math.PI],
      [-21.66, 3.6, -3.0, Math.PI / 2],
      [21.66, 2.8, 5.0, -Math.PI / 2],
    ];
    for (const [x, y, z, ry] of wallSpots) {
      const m = new THREE.Mesh(stainGeo, stainMat);
      m.position.set(x, y, z);
      m.rotation.y = ry;
      m.scale.setScalar(0.8 + Math.random() * 0.8);
      this.group.add(m);
    }

    // 4) 堆叠货箱（InstancedMesh）：集装箱顶 / 货架顶的重复纸箱
    const stacks = [];
    for (const c of [{ x: -16, z: -2, rot: 0 }, { x: 15, z: 10, rot: 0.12 }]) {
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
    // 南侧货架顶部一排小箱（玩家够不到，纯装饰）
    for (let x = -3; x <= 3; x += 1.2) {
      stacks.push({ x, y: 3.35, z: 14.2, ry: (Math.random() - 0.5) * 0.4 });
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
  }

  // ---------------- 灯光 ----------------
  _buildLights() {
    // 第三轮：提高环境光占比，营造柔和的仓库灰调，避免天花板/角落纯黑
    const hemi = new THREE.HemisphereLight(0xa9c4e6, 0x3a332a, 1.25);
    this.scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xffe6c0, 1.45);
    dir.position.set(-14, 20, 10);
    // 第三轮：主方向光投射柔和软阴影
    dir.castShadow = true;
    dir.shadow.mapSize.set(1024, 1024);
    dir.shadow.camera.left = -28;
    dir.shadow.camera.right = 28;
    dir.shadow.camera.top = 28;
    dir.shadow.camera.bottom = -28;
    dir.shadow.camera.near = 1;
    dir.shadow.camera.far = 60;
    dir.shadow.bias = -0.0009;
    dir.shadow.normalBias = 0.02;
    this.scene.add(dir);

    const ambient = new THREE.AmbientLight(0x4a5460, 0.8);
    this.scene.add(ambient);

    // 仓库吊灯（点光源；不投射阴影，控制性能开销）
    for (const [x, z] of [[-12, -8], [12, -8], [-12, 8], [12, 8], [0, 0]]) {
      const lamp = new THREE.PointLight(0xffd9a0, 1.35, 26, 1.8);
      lamp.position.set(x, 5.6, z);
      this.scene.add(lamp);

      const bulb = new THREE.Mesh(
        new THREE.SphereGeometry(0.16, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0xffe2b0 })
      );
      bulb.position.set(x, 5.6, z);
      this.scene.add(bulb);
    }
  }
}
