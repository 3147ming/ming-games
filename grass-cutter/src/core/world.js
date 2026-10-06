/**
 * 战场世界：地形 + 光照 + 障碍物 + 土路 + 天穹
 * ---------------------------------------------------------------------------
 * 模块 1 的产物就是这个文件出来的这一坨"舞台"。它对外只暴露三件事：
 *   · buildWorld(scene, renderer) → world
 *   · world.colliders            —— 相机碰撞要打的 mesh 列表（模块 1 的碰撞就靠它）
 *   · world.update(playerPos, dt) —— 让阴影正交盒跟着玩家走（否则走远了阴影全糊）
 *
 * 设计取舍（写下来免得后面被当成 bug）：
 *  ① 地形是**完全平坦**的（spec：平坦战场）。分段留在 geometry 里，方便以后加丘陵。
 *  ② 土路不是"画在地面贴图里"，而是**独立的贴片网格**：这样路的位置是真实世界坐标，
 *     模块 6 的"据点连线/行军路线"可以直接复用同一份数据，不用去解析贴图像素。
 *  ③ 军旗不参与相机碰撞（细杆挡镜头只会让画面莫名其妙猛拉一下）。
 *  ④ 所有障碍物都是从 battlefieldLayout 的**确定性布局**建出来的，没有一处随机摆放 —— 
 *     刷新页面战场长得一模一样，读数才可复现。
 */
import {
  ACESFilmicToneMapping,
  AmbientLight,
  BackSide,
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Fog,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PCFSoftShadowMap,
  PlaneGeometry,
  SphereGeometry,
} from '../../vendor/three/three.module.js';

import { BATTLEFIELD, DEG, LIGHT } from './config.js';
import { buildLayout, KINDS, roadHeight } from './battlefieldLayout.js';
import {
  makeClothTexture,
  makeDirtTexture,
  makeGrassTexture,
  makeRockTexture,
  makeSkyTexture,
  makeStoneTexture,
  makeWoodTexture,
  resolveAnisotropy,
} from './textures.js';

/** 由方位角/高度角算出"太阳在哪"的单位方向（y 向上） */
export function sunDirection(azimuthDeg, elevationDeg) {
  const az = azimuthDeg * DEG;
  const el = elevationDeg * DEG;
  return {
    x: Math.cos(el) * Math.sin(az),
    y: Math.sin(el),
    z: Math.cos(el) * Math.cos(az),
  };
}

/** 天穹渐变的中间色（靠地平线那一档），用来给雾配色，避免地平线出现硬边 */
function horizonColor() {
  return new Color(LIGHT.SKY.HORIZON).getHex();
}

export function buildWorld(scene, renderer) {
  const warnings = [];
  const layout = buildLayout();
  const aniso = resolveAnisotropy(renderer, BATTLEFIELD.ANISOTROPY_MAX);
  const root = new Group();
  root.name = 'world';
  scene.add(root);

  // ─────────────────────────────────────────────── 天穹 + 雾
  const skyTex = makeSkyTexture({ top: LIGHT.SKY.TOP, horizon: LIGHT.SKY.HORIZON });
  const sky = new Mesh(
    new SphereGeometry(LIGHT.SKY.RADIUS, 32, 16),
    new MeshBasicMaterial({ map: skyTex, side: BackSide, fog: false, depthWrite: false, toneMapped: true })
  );
  sky.name = 'sky';
  sky.renderOrder = -1;
  root.add(sky);

  const fogColor = horizonColor();
  scene.fog = new Fog(fogColor, BATTLEFIELD.FOG_NEAR, BATTLEFIELD.FOG_FAR);

  // ─────────────────────────────────────────────── 地形
  const grassRepeat = BATTLEFIELD.SIZE_X / BATTLEFIELD.GRASS_TILE_METERS;
  let grassMap = null;
  try {
    grassMap = makeGrassTexture({ repeat: grassRepeat, aniso });
  } catch (err) {
    warnings.push(`草地贴图生成失败，回退纯色底：${err.message}`);
  }
  const terrainMat = new MeshStandardMaterial({
    map: grassMap,
    color: grassMap ? 0xffffff : BATTLEFIELD.GROUND_ALBEDO, // 贴图在时不要二次染色，只留兜底色
    roughness: 1,
    metalness: 0,
  });
  const terrainGeo = new PlaneGeometry(BATTLEFIELD.SIZE_X, BATTLEFIELD.SIZE_Z, BATTLEFIELD.SEGMENTS, BATTLEFIELD.SEGMENTS);
  terrainGeo.rotateX(-Math.PI / 2);
  const terrain = new Mesh(terrainGeo, terrainMat);
  terrain.name = 'terrain';
  terrain.position.y = BATTLEFIELD.BASE_Y;
  terrain.receiveShadow = true;
  root.add(terrain);

  // ─────────────────────────────────────────────── 土路（独立贴片）
  const dirtBase = makeDirtTexture({ aniso });
  const roadMeshes = [];
  for (const [ri, r] of layout.roads.entries()) {
    const along = Math.abs(r.to - r.from);
    const across = r.width;
    // 贴图的车辙是沿 V（贴图竖直方向）画的，所以要保证 V 与"路的走向"对齐：
    //   axis 'z' → PlaneGeometry(widthAlongX=across, heightAlongY→Z=along)
    //   axis 'x' → 先按 (across, along) 建面，再绕 Y 转 90°，让 V 落到 X 上
    const geo = new PlaneGeometry(across, along, 1, 1);
    geo.rotateX(-Math.PI / 2);
    if (r.axis === 'x') geo.rotateY(Math.PI / 2);
    const tex = dirtBase.clone();
    // UV 约定：u 沿"路的横向"、v 沿"路的走向"（见上面 rotateX/rotateY 的推导）。
    //   · v 按 8m 一个 tile 平铺，让碎石细节有变化又不至于看出规律；
    //   · u **必须只重复 1 次** —— 车辙是画在贴图 30%/70% 处的两条，
    //     横向重复 N 次就会变成 2N 条辙，8m 宽的土路会像一条木板栈道（实测过，很假）。
    tex.repeat.set(1, along / 8);
    tex.needsUpdate = true;
    const mat = new MeshStandardMaterial({
      map: tex,
      roughness: 1,
      metalness: 0,
      // 路面与地面共面，靠 polygonOffset 把它的深度"往前推一点"，杜绝与地面的 z-fighting
      polygonOffset: true,
      polygonOffsetFactor: -2 - ri,
      polygonOffsetUnits: -2 - ri,
    });
    const mesh = new Mesh(geo, mat);
    mesh.name = r.id;
    // 逐条错开高度：路口处两条路必然重叠，同一高度会 z-fighting（见 config 注释）
    const y = roadHeight(ri);
    mesh.position.set(r.axis === 'z' ? r.center : (r.from + r.to) / 2, y, r.axis === 'z' ? (r.from + r.to) / 2 : r.center);
    mesh.receiveShadow = true;
    root.add(mesh);
    roadMeshes.push(mesh);
  }

  // ─────────────────────────────────────────────── 光照
  const ambient = new AmbientLight(LIGHT.AMBIENT_COLOR, LIGHT.AMBIENT_INTENSITY);
  ambient.name = 'ambient';
  root.add(ambient);

  const sun = new DirectionalLight(LIGHT.SUN_COLOR, LIGHT.SUN_INTENSITY);
  sun.name = 'sun';
  sun.castShadow = LIGHT.SHADOW.ENABLED;
  const sc = sun.shadow.camera;
  sc.left = -LIGHT.SHADOW.ORTHO_HALF;
  sc.right = LIGHT.SHADOW.ORTHO_HALF;
  sc.top = LIGHT.SHADOW.ORTHO_HALF;
  sc.bottom = -LIGHT.SHADOW.ORTHO_HALF;
  sc.near = LIGHT.SHADOW.NEAR;
  sc.far = LIGHT.SHADOW.FAR;
  sc.updateProjectionMatrix();
  sun.shadow.mapSize.set(LIGHT.SHADOW.MAP_SIZE, LIGHT.SHADOW.MAP_SIZE);
  sun.shadow.bias = LIGHT.SHADOW.BIAS;
  sun.shadow.normalBias = LIGHT.SHADOW.NORMAL_BIAS;
  root.add(sun);
  root.add(sun.target);

  const sunDir = sunDirection(LIGHT.SUN_AZIMUTH_DEG, LIGHT.SUN_ELEVATION_DEG);

  // ─────────────────────────────────────────────── 障碍物
  const stone = makeStoneTexture();
  const wood = makeWoodTexture();
  const cloth = makeClothTexture();
  const rockTex = makeRockTexture();

  const MAT = {
    wood: new MeshStandardMaterial({ map: wood, roughness: 0.85, metalness: 0 }),
    stone: new MeshStandardMaterial({ map: stone, roughness: 0.95, metalness: 0 }),
    cloth: new MeshStandardMaterial({ map: cloth, roughness: 0.95, metalness: 0, side: DoubleSide }),
    rock: new MeshStandardMaterial({ map: rockTex, roughness: 1, metalness: 0 }),
    banner: new MeshStandardMaterial({ color: 0xa8322f, roughness: 0.9, metalness: 0, side: DoubleSide }),
  };

  /** 把一个 kind 建造成一小撮 mesh（用 Group 装），返回 Group */
  function buildProp(o) {
    const g = new Group();
    g.name = o.id;
    const k = KINDS[o.kind];
    switch (o.kind) {
      case 'bigtent':
      case 'tent': {
        const bodyH = o.kind === 'bigtent' ? 2.4 : 1.5;
        const body = new Mesh(new BoxGeometry(k.w, bodyH, k.d), MAT.cloth);
        body.position.y = bodyH / 2;
        const roof = new Mesh(new ConeGeometry(Math.hypot(k.w, k.d) / 2, k.h - bodyH, 4), MAT.cloth);
        roof.position.y = bodyH + (k.h - bodyH) / 2;
        roof.rotation.y = Math.PI / 4;
        g.add(body, roof);
        break;
      }
      case 'tower': {
        const legR = 0.16;
        for (const sx of [-1, 1]) {
          for (const sz of [-1, 1]) {
            const leg = new Mesh(new CylinderGeometry(legR, legR * 1.15, k.h - 0.5, 6), MAT.wood);
            leg.position.set((sx * (k.w - legR * 2)) / 2, (k.h - 0.5) / 2, (sz * (k.d - legR * 2)) / 2);
            g.add(leg);
          }
        }
        const deck = new Mesh(new BoxGeometry(k.w, 0.28, k.d), MAT.wood);
        deck.position.y = k.h - 0.5;
        const roof = new Mesh(new ConeGeometry(k.w * 0.85, 1.1, 4), MAT.cloth);
        roof.position.y = k.h + 0.85;
        roof.rotation.y = Math.PI / 4;
        g.add(deck, roof);
        break;
      }
      case 'fence': {
        const bar = new Mesh(new BoxGeometry(k.w, 0.16, k.d * 1.4), MAT.wood);
        bar.position.y = k.h * 0.72;
        const bar2 = bar.clone();
        bar2.position.y = k.h * 0.36;
        const post1 = new Mesh(new BoxGeometry(0.16, k.h, 0.16), MAT.wood);
        post1.position.set(-k.w / 2 + 0.08, k.h / 2, 0);
        const post2 = post1.clone();
        post2.position.x = k.w / 2 - 0.08;
        g.add(bar, bar2, post1, post2);
        break;
      }
      case 'crate': {
        const box = new Mesh(new BoxGeometry(k.w, k.h, k.d), MAT.wood);
        box.position.y = k.h / 2;
        const lid = new Mesh(new BoxGeometry(k.w * 0.7, 0.2, k.d * 0.7), MAT.wood);
        lid.position.y = k.h * 0.78;
        g.add(box, lid);
        break;
      }
      case 'rock': {
        const r = new Mesh(new IcosahedronGeometry(0.5, 0), MAT.rock);
        r.scale.set(k.w * 0.55, k.h * 0.62, k.d * 0.55);
        r.position.set(0, k.h * 0.34, 0);
        r.rotation.set(0.3, o.rotY, 0.18);
        g.add(r);
        break;
      }
      case 'banner': {
        const pole = new Mesh(new CylinderGeometry(0.07, 0.09, k.h, 6), MAT.wood);
        pole.position.y = k.h / 2;
        const flag = new Mesh(new PlaneGeometry(1.15, 1.5), MAT.banner);
        flag.position.set(0.62, k.h - 1.05, 0);
        g.add(pole, flag);
        break;
      }
      default:
        throw new Error(`没有为 kind=${o.kind} 写建造函数`);
    }
    g.traverse((n) => {
      if (n.isMesh) {
        n.castShadow = true;
        n.receiveShadow = true;
      }
    });
    g.position.set(o.x, BATTLEFIELD.BASE_Y, o.z);
    if (o.kind !== 'rock') g.rotation.y = o.rotY;
    return g;
  }

  const colliders = [];
  const propGroup = new Group();
  propGroup.name = 'props';
  for (const o of layout.objects) {
    const g = buildProp(o);
    propGroup.add(g);
    if (o.blocks) colliders.push(g);
  }
  root.add(propGroup);

  // ─────────────────────────────────────────────── 相机碰撞代理
  // 为什么必须有这一层：
  //   望楼是**四根柱子 + 一块平台**，营帐的布幔/锥顶也比占地窄 —— 这些几何体是"中空/偏小"的。
  //   只拿它们做射线求交，相机会**从柱子之间的缝隙里直接钻过去**，然后停在建筑内部：
  //   不报错、不碰墙，但画面会突然被一块深色布料糊住（玩家只会说"卡视角了"）。
  // 做法：给每个"会挡相机"的物件补一个**不可见的占地盒**，让
  //   「运行时相机碰撞形状」== 「布局数据里的占地形状」
  // 这样单测里扫过的形状，就是运行时真正用的形状，两边不会各自漂移。
  //
  // ⚠ 这依赖一个 three 的行为：**射线求交不看 visible**（Raycaster 只按 layers 过滤）。
  //   这个依赖不写下来一定会被人"顺手清理"掉，所以：
  //   ① 这里显式注释；② tests/camera-rig.test.mjs 里有一条专门锁它的用例。
  const proxyMat = new MeshBasicMaterial({ visible: false });
  const proxyGroup = new Group();
  proxyGroup.name = 'camProxies';
  for (const o of layout.objects) {
    if (!o.blocks) continue;
    const k = KINDS[o.kind];
    const proxy = new Mesh(new BoxGeometry(k.w, k.h, k.d), proxyMat);
    proxy.name = `${o.id}:camProxy`;
    proxy.position.set(o.x, BATTLEFIELD.BASE_Y + k.h / 2, o.z);
    proxy.rotation.y = o.rotY;
    proxy.visible = false; // 不渲染；但仍参与射线求交
    proxy.userData.cameraProxy = true;
    proxyGroup.add(proxy);
    colliders.push(proxy);
  }
  root.add(proxyGroup);

  // ─────────────────────────────────────────────── 边界石墙（同时是相机碰撞的"最外壳"）
  const wallGroup = new Group();
  wallGroup.name = 'walls';
  for (const w of layout.walls) {
    const mesh = new Mesh(new BoxGeometry(w.len, w.h, w.t), MAT.stone);
    mesh.name = w.id;
    mesh.position.set(w.x, w.h / 2, w.z);
    mesh.rotation.y = w.rotY;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    wallGroup.add(mesh);
    colliders.push(mesh);
  }
  root.add(wallGroup);

  // ─────────────────────────────────────────────── 草丛（InstancedMesh，一次 draw call）
  const bushGeo = new ConeGeometry(0.78, 0.82, 6);
  const bushMat = new MeshStandardMaterial({ color: 0x4a5f36, roughness: 1, metalness: 0 });
  const bushes = new InstancedMesh(bushGeo, bushMat, layout.bushes.length);
  bushes.name = 'bushes';
  bushes.castShadow = true;
  bushes.receiveShadow = true;
  const m4 = new Matrix4();
  layout.bushes.forEach((b, i) => {
    const hScale = 0.78 + (i % 5) * 0.06;
    m4.makeRotationY(b.rotY);
    m4.scale({ x: b.s, y: b.s * hScale, z: b.s });
    m4.setPosition(b.x, (0.82 * b.s * hScale) / 2 - 0.1, b.z);
    bushes.setMatrixAt(i, m4);
  });
  bushes.instanceMatrix.needsUpdate = true;
  root.add(bushes);

  // ─────────────────────────────────────────────── 阴影跟随
  function update(playerPos) {
    const px = playerPos?.x ?? 0;
    const pz = playerPos?.z ?? 0;
    sun.position.set(px + sunDir.x * LIGHT.SUN_DISTANCE, sunDir.y * LIGHT.SUN_DISTANCE, pz + sunDir.z * LIGHT.SUN_DISTANCE);
    sun.target.position.set(px, 0, pz);
    sun.target.updateMatrixWorld();
    sky.position.set(px, 0, pz); // 天穹跟着走，玩家永远走不到"天边"
  }
  update(layout.spawn);

  let meshCount = 0;
  root.traverse((n) => {
    if (n.isMesh) meshCount++;
  });

  const stats = {
    layoutSeed: layout.seed,
    props: layout.objects.length,
    colliders: colliders.length,
    camProxies: layout.objects.filter((o) => o.blocks).length,
    bushes: layout.bushes.length,
    roads: roadMeshes.length,
    meshes: meshCount,
  };

  return {
    root,
    terrain,
    terrainGeo,
    sky,
    sun,
    ambient,
    sunDir,
    colliders,
    camProxies: proxyGroup,
    layout,
    roads: roadMeshes,
    props: propGroup,
    stats,
    warnings,
    update,
  };
}

/** 渲染器设置（和世界内容解耦：世界只关心画什么，这里只关心怎么画） */
export function configureRenderer(renderer, { maxPixelRatio = 2, exposure = 1 } = {}) {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  renderer.toneMapping = ACESFilmicToneMapping;
  // ACES 是"显影曲线"：spec 给的 1.2 + 0.3 光量直接线性输出会过曝，
  // 走 ACES 压回可视区间。**不改 spec 的光强**，只改最终显影。
  renderer.toneMappingExposure = exposure;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxPixelRatio));
  return renderer;
}
