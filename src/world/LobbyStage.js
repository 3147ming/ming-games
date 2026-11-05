/**
 * 大厅 3D 待机展示
 *
 * 独立的场景 + 相机，里面是一个程序化简模幸存者（暗色军装 + 橙色描边），
 * 站在发光展示台上缓慢转台。只在菜单状态渲染，与战斗世界的关卡地图互不干扰。
 */
import * as THREE from 'three';

const C = {
  cloth: 0x3a444e,
  plate: 0x4d5b68,
  plateDark: 0x2f383f,
  metal: 0x7d8996,
  accent: 0xffb020,
  visor: 0xffc24d,
};

export class LobbyStage {
  constructor() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05070a);
    this.scene.fog = new THREE.Fog(0x05070a, 7, 16);

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 40);

    this.time = 0;
    this._radius = 3.8;
    this._focus = new THREE.Vector3(0, 1.05, 0);
    this._right = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._materials = [];

    this._buildLights();

    this.display = new THREE.Group();
    this.scene.add(this.display);
    this._buildPlatform();
    this._buildCharacter();

    this.resize();
    this._placeCamera(0);
  }

  // ---------------- 构建 ----------------
  _mat(color, extra = {}) {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.3, ...extra });
    this._materials.push(m);
    return m;
  }

  _buildLights() {
    this.scene.add(new THREE.HemisphereLight(0x9ab4cc, 0x101418, 1.35));

    const key = new THREE.DirectionalLight(0xfff0d6, 3.2);
    key.position.set(2.6, 4.2, 3.2);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 12;
    key.shadow.camera.left = -2.4;
    key.shadow.camera.right = 2.4;
    key.shadow.camera.top = 3.2;
    key.shadow.camera.bottom = -2.4;
    key.shadow.bias = -0.0008;
    key.shadow.normalBias = 0.02;
    this.scene.add(key);

    // 背后橙色轮廓光：把角色从深色背景里勾出来
    const rim = new THREE.DirectionalLight(0xff9436, 2.6);
    rim.position.set(-3.0, 2.2, -2.6);
    this.scene.add(rim);

    // 正面冷色补光
    const fill = new THREE.PointLight(0x5a9cd8, 3.6, 10, 2);
    fill.position.set(-1.4, 1.4, 2.6);
    this.scene.add(fill);

    // 正面柔光：把脸和胸甲从暗部提起来
    const front = new THREE.DirectionalLight(0xdfe9f5, 1.3);
    front.position.set(1.2, 1.9, 4.0);
    this.scene.add(front);

    // 台面暖光：从脚边往上染一层橙色
    const glow = new THREE.PointLight(0xffa62b, 2.0, 4.5, 2);
    glow.position.set(0, 0.4, 0.9);
    this.scene.add(glow);
  }

  _buildPlatform() {
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(1.45, 1.62, 0.2, 32),
      this._mat(0x1a2027, { roughness: 0.5, metalness: 0.6 }),
    );
    base.position.y = -0.1;
    base.castShadow = true;
    base.receiveShadow = true;
    this.display.add(base);

    const top = new THREE.Mesh(
      new THREE.CylinderGeometry(1.3, 1.3, 0.04, 32),
      this._mat(0x222a33, { roughness: 0.35, metalness: 0.55 }),
    );
    top.position.y = 0.02;
    top.receiveShadow = true;
    this.display.add(top);

    this.ringMat = this._mat(0x120c04, { emissive: C.accent, emissiveIntensity: 1.0, roughness: 0.5 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.32, 0.028, 8, 64), this.ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.05;
    this.display.add(ring);

    // 地面 + 网格：雾里淡出，给一个"车库待机"的底
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 30),
      this._mat(0x080a0d, { roughness: 0.95, metalness: 0.1 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.22;
    floor.receiveShadow = true;
    this.scene.add(floor);

    const grid = new THREE.GridHelper(24, 24, 0x1b2a33, 0x0f151c);
    grid.position.y = -0.21;
    grid.material.transparent = true;
    grid.material.opacity = 0.6;
    this.scene.add(grid);
  }

  _buildCharacter() {
    const c = new THREE.Group();
    c.position.y = 0.02;
    this.character = c;
    this.display.add(c);

    const cloth = this._mat(C.cloth, { roughness: 0.9, metalness: 0.08 });
    const plate = this._mat(C.plate, { roughness: 0.5, metalness: 0.5 });
    const plateDark = this._mat(C.plateDark, { roughness: 0.6, metalness: 0.45 });
    const metal = this._mat(C.metal, { roughness: 0.35, metalness: 0.8 });
    const accent = this._mat(0x2a1a05, { emissive: C.accent, emissiveIntensity: 1.05, roughness: 0.4, metalness: 0.3 });
    this.visorMat = this._mat(0x1b1206, { emissive: C.visor, emissiveIntensity: 1.2, roughness: 0.2, metalness: 0.4 });

    const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
    const add = (parent, geo, mat, x, y, z) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      m.receiveShadow = true;
      parent.add(m);
      return m;
    };

    // 髋部 + 腰带发光条
    add(c, box(0.4, 0.2, 0.26), plateDark, 0, 0.98, 0);
    add(c, box(0.42, 0.05, 0.27), accent, 0, 0.9, 0);

    // 双腿（略微分开站立）
    for (const sx of [-1, 1]) {
      const x = sx * 0.115;
      add(c, box(0.17, 0.44, 0.2), cloth, x, 0.72, 0);
      add(c, box(0.19, 0.12, 0.22), plate, x, 0.5, 0.01);
      add(c, box(0.16, 0.36, 0.18), cloth, x, 0.28, 0);
      add(c, box(0.2, 0.13, 0.33), plateDark, x, 0.07, 0.04);
    }

    // 躯干 + 胸甲 + 胸口指示灯
    add(c, box(0.44, 0.46, 0.28), cloth, 0, 1.24, 0);
    add(c, box(0.38, 0.26, 0.1), plate, 0, 1.32, 0.15);
    add(c, box(0.07, 0.07, 0.04), accent, 0, 1.34, 0.21);

    // 肩甲 / 上臂 / 前臂 / 手
    for (const sx of [-1, 1]) {
      const x = sx * 0.33;
      add(c, box(0.24, 0.17, 0.28), plate, x, 1.46, 0);
      add(c, box(0.15, 0.34, 0.17), cloth, x, 1.26, 0);
      const fore = add(c, box(0.14, 0.3, 0.15), plateDark, x + sx * 0.02, 1.02, 0.1);
      fore.rotation.x = -0.55;
      const hand = add(c, box(0.1, 0.12, 0.14), cloth, x + sx * 0.02, 0.9, 0.24);
      hand.rotation.x = -0.55;
    }

    // 脖颈 + 头部
    add(c, new THREE.CylinderGeometry(0.07, 0.08, 0.1, 8), plateDark, 0, 1.52, 0);
    const head = new THREE.Group();
    head.position.set(0, 1.66, 0);
    c.add(head);
    this.head = head;
    add(head, box(0.25, 0.27, 0.25), cloth, 0, 0, 0);
    add(head, box(0.29, 0.13, 0.29), plate, 0, 0.13, 0);
    add(head, box(0.26, 0.05, 0.03), this.visorMat, 0, 0.02, 0.13);
    add(head, box(0.12, 0.07, 0.05), plateDark, 0, -0.09, 0.13);

    // 背包 + 背面指示灯
    add(c, box(0.34, 0.36, 0.16), plateDark, 0, 1.32, -0.2);
    add(c, box(0.12, 0.14, 0.04), accent, 0, 1.42, -0.29);

    // 斜挎的步枪
    const rifle = new THREE.Group();
    rifle.position.set(0.06, 1.16, 0.3);
    rifle.rotation.set(0.06, 0.5, -0.16);
    c.add(rifle);
    add(rifle, box(0.42, 0.1, 0.13), metal, 0, 0, 0);
    add(rifle, box(0.2, 0.11, 0.1), plateDark, -0.28, -0.01, 0);
    add(rifle, box(0.22, 0.07, 0.09), plateDark, 0.24, 0.01, 0);
    add(rifle, box(0.08, 0.16, 0.09), metal, -0.04, -0.12, 0);
    add(rifle, box(0.12, 0.06, 0.07), plateDark, 0.02, 0.1, 0);
    add(rifle, box(0.02, 0.02, 0.02), accent, 0.02, 0.135, 0);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.42, 8), metal);
    barrel.rotation.z = Math.PI / 2;
    barrel.position.set(0.42, 0.01, 0);
    barrel.castShadow = true;
    rifle.add(barrel);
  }

  // ---------------- 运行 ----------------
  update(dt) {
    this.time += dt;
    const t = this.time;

    // 缓慢转台
    this.display.rotation.y += dt * 0.16;

    // 待机呼吸 + 头部微微摆动
    this.character.position.y = 0.02 + Math.sin(t * 1.5) * 0.008;
    this.head.rotation.y = Math.sin(t * 0.6) * 0.14;

    // 指示灯呼吸
    this.visorMat.emissiveIntensity = 1.2 + Math.sin(t * 2.4) * 0.25;
    this.ringMat.emissiveIntensity = 1.0 + Math.sin(t * 1.8 + 1) * 0.2;

    this._placeCamera(t);
  }

  /** 相机在角色前方轻微环绕，并把角色偏到画面右侧，给左侧大厅面板让位 */
  _placeCamera(t) {
    const yaw = 0.04 + Math.sin(t * 0.16) * 0.14;
    const dist = this._radius;
    this.camera.position.set(
      Math.sin(yaw) * dist,
      1.5 + Math.sin(t * 0.7) * 0.03,
      Math.cos(yaw) * dist,
    );
    this._right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    this._target.copy(this._focus).addScaledVector(this._right, -1.12);
    this.camera.lookAt(this._target);
  }

  resize() {
    this.camera.aspect = (window.innerWidth || 1) / (window.innerHeight || 1);
    this.camera.updateProjectionMatrix();
  }
}
