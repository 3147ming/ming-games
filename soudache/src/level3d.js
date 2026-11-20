/**
 * 关卡构建：把 mapgen 输出的网格 / 容器 / 灌木 / 撤离点转成 3D 场景
 *
 * 只读 map 结构，绝不修改 mapgen 的任何输出契约。
 * 坐标映射：逻辑 (x, y) → 场景 (x, height, y)。
 *
 * 性能要点：
 * - 墙体与掩体箱合并为**单个**带顶点色的几何体（1 个 draw call）
 * - 灌木 / 容器 / 容器配件用 InstancedMesh（同类物件各 1 个 draw call）
 * - 撤离点数量固定（3），用独立 Group 便于各自发光脉动
 */

import * as THREE from '../vendor/three.module.js';
import {
  VIEW3D, PALETTE3D, LIGHT_ZONES, MATCH, CONTAINERS, RNG_SALT_3D, TILE,
} from './config.js';
import { lampSites } from './grade3d.js';
import {
  u, lowPolyMat, boxWithFaceColors, mergeGeometries, buildGround, buildBushGeometry,
  buildContainerParts, buildExtractMarker, CONTAINER_COLORS, getConcreteTexture, surfaceMat,
  getSurfaceMaps, getLampPoolTexture,
} from './models.js';
// 只为挑台阶朝向而查询格子是否实心（纯查询，不修改 mapgen 的任何输出）
import { isTileSolid, elevationAt } from './mapgen.js';
// P23：外部 GLB 资源。加载失败只会退回程序化模型，绝不阻断关卡构建。
import { loadGLB, mergeStatic, glbLambert } from './assets.js';
// 幽灵痕迹：纯视觉氛围层。渲染逻辑在独立模块里对齐新版地形高度与冻结时机，
// 这里只挂一个接入点，不动本文件已有的归档/装配顺序。
import { attachGhostTraces } from './ghostTracesRender.js';

/**
 * P23：可搜刮容器的真实模型映射（Kenney，CC0）。
 *
 * 只换**视觉**：交互半径、容器类型、搜箱逻辑、拾荒表全部仍由 mapgen / CONTAINERS 决定，
 * 所以这张表里的模型怎么换都不会影响玩法与平衡。
 *
 * 选型理由：
 * - `safe` → `chest` 带开合动画的储物箱，最贴"保险箱"；
 * - `crate` → `box-large` 木箱，与原来的"补给箱"轮廓一致；
 * - `weaponbox` → `crate-medium` 长条军械箱（blaster kit 的开合箱）；
 * - `drawer` → `crate-small` 小箱，抽屉类容器在小场景里最接近"柜子"的体量。
 * `airdrop` / `body` 故意不换：空投箱的橙色信标与时装尸体的可读性是玩法资产，不能动。
 */
/**
 * 容器 GLB 映射（P23 起）。
 * W3 美术升级：crate/weaponbox 换成 Poly Haven CC0 写实道具（albedo+normal+
 * metalrough+AO 四通道；ammo_box 三通道），淘汰只有 124 面的 Kenney 塑料方块。
 * ⚠ 不直接用三角洲素材；这些都是 CC0 公共领域资产，来源见 CREDITS。
 * glbLambert 是唯一材质出口（会丢 normal/AO，但几何倒角/铆钉保留，
 * 且 A/B 实验证明本作观感瓶颈在光照而非材质，见 docs/art/ASSET-UPGRADE.md）。
 */
export const GLB_CONTAINERS = {
  drawer: 'models/kenney-blaster-kit/crate-small.glb',
  crate: 'models/polyhaven/wooden_crate_01.glb',
  weaponbox: 'models/polyhaven/ammo_box.glb',
  safe: 'models/kenney-survival-kit/chest.glb',
};

/** 把颜色按亮度系数缩放（k>1 提亮，k<1 压暗），返回 CSS 十六进制串 */
function shade(hex, k) {
  const c = new THREE.Color(hex);
  c.multiplyScalar(k);
  return `#${c.getHexString()}`;
}

/**
 * 冻结静态子树的矩阵更新（P0-2 性能）。
 *
 * 关卡里的地面 / 墙体 / 天花板 / 容器 / 灌木 / 碎石 / 平台在整局内都不移动，
 * 但 Object3D 默认每帧 compose + multiplyMatrices；861 个 Mesh 时这是可观的 CPU 开销。
 * 这里只冻结 Mesh（InstancedMesh 也是 Mesh），并跳过会改 transform 的子树：
 * 掩体箱（碎裂时 scale.y 变化）、撤离点光柱（ring.rotation.y 脉动）、交互高亮（位置/缩放）。
 *
 * 注意：调用前必须先 `root.updateMatrixWorld(true)`，把当前世界矩阵算好，
 * 否则冻结后 matrixWorld 还是单位矩阵，物体会叠在原点。
 * @param {THREE.Object3D} root 静态根节点
 * @param {THREE.Object3D[]} skipRoots 需要保留动态更新的子树
 * @returns {void}
 */
function freezeStaticTree(root, skipRoots = []) {
  if (!root) return;
  const skip = new Set(skipRoots.filter(Boolean));
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh) return;
    let p = o;
    while (p && p !== root) {
      if (skip.has(p)) return;
      p = p.parent;
    }
    o.matrixAutoUpdate = false;
    o.matrixWorldAutoUpdate = false;
  });
}

/**
 * P23：`?glb=0` 可关闭外部模型，回到纯程序化关卡。
 *
 * 这不是"临时开关"，是**必须留的退路**：线上真出现某个 GLB 不兼容（显卡驱动缺陷、
 * 贴图解码失败、移动端显存不足），改一行 URL 就能确认问题是不是资源引起的，
 * 也能让玩家在弱机上自救。A/B 复现也靠它。
 */
export function glbEnabled() {
  if (typeof location === 'undefined') return true;
  return !/[?&]glb=0(&|$)/.test(location.search);
}

/**
 * 构建整张关卡。
 * @param {THREE.Scene} scene 场景
 * @param {object} map 地图对象（mapgen.generateMap 的输出）
 * @param {object} rng 战局随机源（内部 fork 出装饰用子流，保证同 seed 一致）
 * @param {string} [quality] 设备档 high/mid/low，决定室内点光数量（0~2 盏）
 * @returns {object} 关卡句柄
 */
export function buildLevel(scene, map, rng, quality = 'high') {
  const group = new THREE.Group();
  group.name = 'level';
  scene.add(group);

  const decorRng = rng.fork(RNG_SALT_3D.level);
  const disposables = [];
  // P12 三通道表面细节：低画质档只保留 albedo，不挂 bump/roughness（省 shader 采样）。
  const surfaceDetail = quality === 'low' ? null : getSurfaceMaps('concrete');

  /* ---------------- 地面 ---------------- */

  const ground = buildGround(map);
  group.add(ground);
  disposables.push(ground.geometry, ground.material);

  /* ---------------- 墙体 + 掩体箱（合并为单网格） ---------------- */

  const boxes = [];
  const wallH = u(VIEW3D.wallHeight);
  const crateH = u(VIEW3D.crateHeight);
  const wallTop = PALETTE3D.wallTop;
  const crateTop = shade(PALETTE3D.crate, 1.30);

  for (const rect of map.walls) {
    const k = 1 + decorRng.float(-1, 1) * VIEW3D.level.wallColorJitter;
    const side = shade(PALETTE3D.wall, k);
    const top = shade(wallTop, k);
    boxes.push(boxWithFaceColors(
      rect.w, wallH, rect.h,
      [side, side, top, side, side, side],
    ).translate(rect.x + rect.w / 2, wallH / 2, rect.y + rect.h / 2));
  }

  // 掩体箱：全部矩形合并为 1 个 InstancedMesh（P1-2）。
  // 掩体箱高度固定、只有宽深不同，因此用「单位宽深 + 实际高度」的单位几何，
  // 逐箱宽深走 instanceMatrix 的 X/Z 缩放、世界位置走平移；逐箱色抖动走
  // instanceColor（shade() 是纯乘法，把抖动从顶点色搬到实例色后逐点颜色不变）。
  // 受损/碎裂仍可只改单实例（色 + y 缩放），保留原有逐箱视觉，不并进城墙。
  const cratesGroup = new THREE.Group();
  cratesGroup.name = 'crates';
  group.add(cratesGroup);
  const crateRects = map.crateRects || [];
  const crateCount = crateRects.length;
  const crateLidH = crateH * 0.09;
  // 单位几何：宽深=1（实例矩阵缩放成 rect.w/h），高度=实际 crateH（全图固定）。
  // 顶点色按 k=1 基准编码本色 + 顶面提亮；逐箱 k 抖动交给 instanceColor。
  const crateGeo = mergeGeometries([
    boxWithFaceColors(
      1, crateH - crateLidH, 1,
      [PALETTE3D.crate, PALETTE3D.crate, PALETTE3D.crate,
        PALETTE3D.crate, PALETTE3D.crate, PALETTE3D.crate],
    ).translate(0, (crateH - crateLidH) / 2, 0),
    boxWithFaceColors(
      1.03, crateLidH, 1.03,
      [crateTop, crateTop, crateTop, crateTop, crateTop, crateTop],
    ).translate(0, crateH - crateLidH / 2, 0),
  ]);
  const crateInstances = new THREE.InstancedMesh(
    crateGeo,
    surfaceMat('#FFFFFF', getConcreteTexture(), VIEW3D.wallRoughness, surfaceDetail),
    crateCount,
  );
  crateInstances.material.vertexColors = true;
  crateInstances.castShadow = true;
  crateInstances.receiveShadow = true;
  crateInstances.name = 'crateInstances';
  // 顶点色只编码「本色 + 顶面提亮」，逐箱 k 抖动与受损/碎裂色全部由实例色承载。
  const rubbleColor = new THREE.Color(PALETTE3D.crateRubble);
  const baseColor = new THREE.Color('#ffffff');
  const crateK = new Float32Array(crateCount);
  const crateMatrix = new THREE.Matrix4();
  const crateQuat = new THREE.Quaternion();
  const cratePos = new THREE.Vector3();
  const crateScale = new THREE.Vector3();
  const crateColor = new THREE.Color();
  const crateDestroyed = new Uint8Array(crateCount);
  for (let ci = 0; ci < crateCount; ci += 1) {
    const rect = crateRects[ci];
    const k = 1 + decorRng.float(-1, 1) * VIEW3D.level.crateColorJitter;
    crateK[ci] = k;
    cratePos.set(rect.x + rect.w / 2, 0, rect.y + rect.h / 2);
    crateScale.set(rect.w, 1, rect.h);
    crateMatrix.compose(cratePos, crateQuat, crateScale);
    crateInstances.setMatrixAt(ci, crateMatrix);
    crateInstances.setColorAt(ci, crateColor.setRGB(k, k, k));
  }
  crateInstances.instanceMatrix.needsUpdate = true;
  if (crateInstances.instanceColor) crateInstances.instanceColor.needsUpdate = true;
  cratesGroup.add(crateInstances);
  disposables.push(crateInstances.geometry, crateInstances.material);

  const solidsGeo = mergeGeometries(boxes);
  for (const b of boxes) b.dispose();
  const solidsMat = surfaceMat('#FFFFFF', getConcreteTexture(), VIEW3D.wallRoughness, surfaceDetail);
  solidsMat.vertexColors = true;
  const solids = new THREE.Mesh(solidsGeo, solidsMat);
  solids.castShadow = true;
  solids.receiveShadow = true;
  solids.name = 'solids';
  group.add(solids);
  disposables.push(solidsGeo, solidsMat);

  /* ---------------- 天花板 + 结构横梁（按建筑分栋覆盖） ----------------
   * ★ 不再是一整片盖住全图的顶：那会把"室外大地图"变成"更大的室内迷宫"。
   * 现在按 map.rooms 里 `indoor !== false` 的分区逐栋盖板，露天广场与街巷抬头就是天空，
   * 于是同一张图里有了"建筑内 CQB"和"街巷对枪"两种交火距离。
   *
   * 做法要点：
   * - 每栋用 BoxGeometry（不是 Plane）：薄楼板有厚度，从街上斜看屋顶不是一张纸；
   * - 全部合并成**一个** geometry，仍然 1 个 draw call，扩图不会增加批次；
   * - 板面比房间外扩半格多一点，盖住墙顶缝，避免从室内看到一线天；
   * - castShadow=false：屋顶挡主光会让室内全黑，室内亮度仍由 ambient/hemi 与暖白灯分区负责。
   */

  const ceilGap = u(VIEW3D.level.ceilingGap);
  const ceilY = u(VIEW3D.wallHeight) + ceilGap;
  const slabThick = u(0.18);
  // 板面必须盖住整圈墙顶（房间是从叶子里内缩 1 格挖出来的，墙厚正好 1 格）。
  // 之前只外扩 0.35m，街上一抬头就是"墙顶与楼板之间的一条缝"，能看到天空。
  const slabPad = TILE * 1.02;
  const indoorRooms = (map.rooms || []).filter((r) => r.indoor !== false);

  const ceilColor = new THREE.Color(PALETTE3D.ceiling);
  const ceilMat = new THREE.MeshLambertMaterial({
    color: ceilColor,
    side: THREE.DoubleSide,
    emissive: ceilColor.clone().multiplyScalar(VIEW3D.level.ceilingEmissive),
  });

  const slabBoxes = [];
  for (const room of indoorRooms) {
    const w = room.w + slabPad * 2;
    const h = room.h + slabPad * 2;
    slabBoxes.push(new THREE.BoxGeometry(w, slabThick, h)
      .translate(room.x + room.w / 2, ceilY - slabThick / 2, room.y + room.h / 2));
  }
  const ceilGeo = slabBoxes.length
    ? mergeGeometries(slabBoxes)
    // 极端情况（整张图没有一栋室内建筑）：给一个零面积的退化几何，保持 scene 里
    // 始终有 ceiling 这个对象，探针/测试不需要写"可能不存在"的分支。
    : new THREE.BufferGeometry();
  for (const b of slabBoxes) b.dispose();
  ceilGeo.computeBoundingBox();
  ceilGeo.computeBoundingSphere();
  const ceiling = new THREE.Mesh(ceilGeo, ceilMat);
  ceiling.castShadow = false;
  ceiling.receiveShadow = false;
  ceiling.name = 'ceiling';
  group.add(ceiling);
  disposables.push(ceilGeo, ceilMat);

  const beamH = u(VIEW3D.level.ceilingBeamH);
  const beamW = u(VIEW3D.level.ceilingBeamW);
  const beamY = ceilY - beamH / 2 - u(0.02);
  const beamSpacing = u(VIEW3D.level.ceilingBeamSpacing);
  const beamBoxes = [];
  for (const room of indoorRooms) {
    for (let z = room.y + beamSpacing; z < room.y + room.h; z += beamSpacing) {
      beamBoxes.push(new THREE.BoxGeometry(room.w, beamH, beamW)
        .translate(room.x + room.w / 2, beamY, z));
    }
    for (let x = room.x + beamSpacing; x < room.x + room.w; x += beamSpacing) {
      beamBoxes.push(new THREE.BoxGeometry(beamW, beamH, room.h)
        .translate(x, beamY, room.y + room.h / 2));
    }
  }
  const beamGeo = beamBoxes.length ? mergeGeometries(beamBoxes) : new THREE.BufferGeometry();
  // 合并后的几何体不会自动计算包围盒，显式计算以便正确进行视锥剔除。
  beamGeo.computeBoundingBox();
  beamGeo.computeBoundingSphere();
  for (const b of beamBoxes) b.dispose();
  const beamColor = new THREE.Color(PALETTE3D.ceilingBeam);
  const beamMat = new THREE.MeshLambertMaterial({
    color: beamColor,
    emissive: beamColor.clone().multiplyScalar(VIEW3D.level.ceilingEmissive),
    // 横梁是长条：沿视线方向那一根在近处会投影成一整块深色斜楔，正好压在准星上方。
    // 改成半透明浅色结构线：保留工业感，但不再是一块实心遮挡。
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
  });
  const beams = new THREE.Mesh(beamGeo, beamMat);
  beams.castShadow = false;
  beams.receiveShadow = false;
  beams.name = 'ceilingBeams';
  group.add(beams);
  disposables.push(beamGeo, beamMat);

  /* ---------------- P3 室内暖白灯分区 ----------------
   * 冷灰蓝的全局填充光（既有 hemi/ambient 标定）保持不变；在真实 POI 附近
   * 补少量暖白点光作为「室内灯区」。点光数量按设备档钳死（high 2 / mid 1 / low 0），
   * 因为每盏灯都会进 Standard 材质的光循环，无上限会直接吃掉帧率预算。
   * 布点是纯函数 + 独立 RNG 子流，不改既有 decorRng 的随机序列（旧 seed 的装饰完全一致）。
   */
  const zone = LIGHT_ZONES.interior;
  const lampRng = rng.fork(RNG_SALT_3D.level + 17);
  const lampPoints = lampSites(map, () => lampRng.float(0, 1), zone.counts[quality] || 0);
  const lampLights = [];
  for (const p of lampPoints) {
    const light = new THREE.PointLight(
      new THREE.Color(zone.lamp),
      zone.lampIntensity,
      zone.lampDistance * VIEW3D.metersToUnits,
      zone.decay,
    );
    light.position.set(p.x, u(zone.lampHeight), p.y);
    light.castShadow = false;
    group.add(light);
    lampLights.push(light);
  }

  // 地面光池：整组只用 1 个 InstancedMesh（1 draw call）。加色混合 + fog:false，
  // 让暖白光区在冷灰蓝全局光下稳定可辨，不受设备档 / 点光数量影响。
  const poolR = u(zone.poolRadius);
  const poolGeo = new THREE.PlaneGeometry(poolR * 2, poolR * 2);
  poolGeo.rotateX(-Math.PI / 2);
  const poolMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(zone.poolColor),
    map: getLampPoolTexture(),
    transparent: true,
    opacity: zone.poolOpacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  const lampPools = new THREE.InstancedMesh(poolGeo, poolMat, Math.max(1, lampPoints.length));
  lampPools.count = lampPoints.length;
  lampPools.renderOrder = 1;
  lampPools.frustumCulled = false;

  // 灯具本体：天花板下的一块暖白发光板，同样 1 个 InstancedMesh。
  const fixtureGeo = new THREE.BoxGeometry(u(0.44), u(0.10), u(0.44));
  const fixtureMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(zone.fixtureColor),
    toneMapped: false,
    fog: false,
  });
  const lampFixtures = new THREE.InstancedMesh(fixtureGeo, fixtureMat, Math.max(1, lampPoints.length));
  lampFixtures.count = lampPoints.length;
  lampFixtures.frustumCulled = false;

  const lampMat4 = new THREE.Matrix4();
  const lampQuat = new THREE.Quaternion();
  const lampPos = new THREE.Vector3();
  const lampScale = new THREE.Vector3(1, 1, 1);
  lampPoints.forEach((p, i) => {
    lampPos.set(p.x, u(0.03), p.y);
    lampPools.setMatrixAt(i, lampMat4.compose(lampPos, lampQuat, lampScale));
    lampPos.set(p.x, u(zone.lampHeight) + u(0.10), p.y);
    lampFixtures.setMatrixAt(i, lampMat4.compose(lampPos, lampQuat, lampScale));
  });
  lampPools.instanceMatrix.needsUpdate = true;
  lampFixtures.instanceMatrix.needsUpdate = true;
  group.add(lampPools, lampFixtures);
  disposables.push(poolGeo, poolMat, fixtureGeo, fixtureMat);

  /* ---------------- 灌木（InstancedMesh） ---------------- */

  let bushMesh = null;
  if (map.bushes.length) {
    const bushGeo = buildBushGeometry(decorRng);
    const bushMat = lowPolyMat(PALETTE3D.bush, { transparent: true, opacity: 0.92 });
    bushMesh = new THREE.InstancedMesh(bushGeo, bushMat, map.bushes.length);
    bushMesh.castShadow = true;
    bushMesh.receiveShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const baseR = bushGeo.boundingSphere ? bushGeo.boundingSphere.radius : 1;
    map.bushes.forEach((bush, i) => {
      const s = bush.r / baseR;
      pos.set(bush.x, 0, bush.y);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), decorRng.float(0, Math.PI * 2));
      scl.set(s, s * decorRng.float(0.85, 1.15), s);
      bushMesh.setMatrixAt(i, m.compose(pos, q, scl));
    });
    bushMesh.instanceMatrix.needsUpdate = true;
    group.add(bushMesh);
    disposables.push(bushGeo, bushMat);
  }

  /* ---------------- 环境碎石/杂物（视觉密度，InstancedMesh，不参与碰撞） ---------------- */

  // 独立 RNG 子流：不改动 decorRng 的既有调用序列，旧 seed 的墙/灌木/容器外观完全一致。
  const propRng = rng.fork(RNG_SALT_3D.level + 29);
  const WORLD_W_L = map.cols * map.tile;
  const WORLD_H_L = map.rows * map.tile;
  // 摆位剔除：太靠近墙体 / 掩体箱 / 撤离点 / 容器 / 终端就不放，避免穿模
  const tooClose = (x, y) => {
    for (const r of (map.walls || [])) {
      if (x > r.x - 12 && x < r.x + r.w + 12 && y > r.y - 12 && y < r.y + r.h + 12) return true;
    }
    for (const r of (map.crateRects || [])) {
      if (x > r.x - 10 && x < r.x + r.w + 10 && y > r.y - 10 && y < r.y + r.h + 10) return true;
    }
    for (const e of (map.extracts || [])) {
      if (Math.hypot(x - e.x, y - e.y) < (e.r || 60) * 0.9) return true;
    }
    for (const c of (map.containers || [])) {
      if (Math.hypot(x - c.x, y - c.y) < 44) return true;
    }
    for (const t of (map.terminals || [])) {
      if (Math.hypot(x - t.x, y - t.y) < 64) return true;
    }
    for (const sw of (map.switches || [])) {
      if (Math.hypot(x - sw.x, y - sw.y) < 56) return true;
    }
    return false;
  };
  if (map.cols && map.rows && map.cols * map.rows > 0) {
    const ROCK_N = 56;
    const rockGeo = new THREE.IcosahedronGeometry(u(0.30), 0);
    const rockMat = lowPolyMat(shade(PALETTE3D.wall, 0.70), { flatShading: true });
    const rockMesh = new THREE.InstancedMesh(rockGeo, rockMat, ROCK_N);
    rockMesh.castShadow = false;
    rockMesh.receiveShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    let placed = 0;
    for (let i = 0; i < ROCK_N * 5 && placed < ROCK_N; i += 1) {
      const x = propRng.float(48, WORLD_W_L - 48);
      const y = propRng.float(48, WORLD_H_L - 48);
      if (tooClose(x, y)) continue;
      pos.set(x, 0, y);
      q.setFromEuler(new THREE.Euler(propRng.float(-0.24, 0.24), propRng.float(0, Math.PI * 2), propRng.float(-0.24, 0.24)));
      const s = propRng.float(0.7, 1.7);
      scl.set(s, s * propRng.float(0.48, 0.9), s);
      rockMesh.setMatrixAt(placed, m.compose(pos, q, scl));
      placed += 1;
    }
    rockMesh.count = placed;
    rockMesh.instanceMatrix.needsUpdate = true;
    group.add(rockMesh);
    disposables.push(rockGeo, rockMat);
  }

  /* ---------------- 容器（按类型 InstancedMesh） ---------------- */

  const parts = buildContainerParts();
  const typeSlots = {}; // type → { main, trim, count, capacity }
  const instanceOf = new Map(); // container 对象 → { type, index, scale }

  // #P0-2 夜战可见性：可搜刮容器（不含尸体）加轻微自发光，暗处不致死黑。
  const LOOT_TYPES = new Set(['drawer', 'crate', 'weaponbox', 'safe', 'airdrop']);
  // 可搜刮容器脚下的自发光地光环（地面高亮，一眼能找到物资）。
  const glowGeo = new THREE.RingGeometry(u(0.55), u(0.8), 28);
  glowGeo.rotateX(-Math.PI / 2);
  const glowMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(VIEW3D.lootEmissive).multiplyScalar(3.2),
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide,
    depthWrite: false,
    fog: false,
  });
  // P1-2：地光环原本每个容器一个独立 Mesh（DoubleSide 透明 = 2 draw/个），
  // depot 一局 18 个就是 36 draw。几何/材质全共享且永不改色，改成 InstancedMesh 后固定 1 draw。
  // 容量预留尸体上限：尸体类型不在 LOOT_TYPES，不会真的占实例，但留余量避免未来加类型时越界。
  const glowCapacity = (map.containers || []).length + MATCH.enemyCountMax + 2;
  const glowRings = new THREE.InstancedMesh(glowGeo, glowMat, Math.max(1, glowCapacity));
  glowRings.count = 0;
  glowRings.renderOrder = 2;
  glowRings.frustumCulled = false;
  let glowRingCount = 0;
  const glowMat4 = new THREE.Matrix4();
  group.add(glowRings);
  disposables.push(glowGeo, glowMat);

  // 预留容量：尸体会在局内动态增加（每个被击杀的敌人留一具）
  const extraBodies = MATCH.enemyCountMax + 2;
  for (const [type, part] of Object.entries(parts)) {
    const existing = map.containers.filter((c) => c.type === type).length;
    const capacity = existing + (type === 'body' ? extraBodies : MATCH.enemyCountMax) + 2;
    const isLoot = LOOT_TYPES.has(type);
    const mainMat = lowPolyMat(CONTAINER_COLORS[type], {
      map: part.mainTex || null,
      emissive: isLoot ? VIEW3D.lootEmissive : null,
      emissiveIntensity: isLoot ? VIEW3D.lootEmissiveIntensity : 0,
    });
    const main = new THREE.InstancedMesh(part.main, mainMat, Math.max(1, capacity));
    main.count = 0;
    main.castShadow = true;
    main.receiveShadow = true;
    group.add(main);
    disposables.push(part.main, mainMat);

    let trim = null;
    if (part.trim) {
      const trimMat = lowPolyMat(part.trimColor || PALETTE3D.safeTrim, { map: part.trimTex || null });
      trim = new THREE.InstancedMesh(part.trim, trimMat, Math.max(1, capacity));
      trim.count = 0;
      trim.castShadow = true;
      trim.receiveShadow = true;
      group.add(trim);
      disposables.push(part.trim, trimMat);
    }
    typeSlots[type] = { main, trim, count: 0, capacity, geo: part.main, glb: false };
  }

  const mat4 = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const vpos = new THREE.Vector3();
  const vscl = new THREE.Vector3();
  const tmpColor = new THREE.Color();

  /** 计算某个容器的视觉缩放：让水平最大边对齐其交互直径 */
  function containerScale(type, container) {
    // P23：换成 GLB 后几何不同，缩放基准必须跟着 slot 走，否则模型大小会按旧几何的量纲失真。
    const geo = typeSlots[type].geo;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const maxXZ = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) || 1;
    const radius = container.r || CONTAINERS[type].radius;
    return (radius * 2) / maxXZ;
  }

  /** 写入一个容器实例（含主体与配件） */
  function writeInstance(type, index, container, dimmed) {
    const slot = typeSlots[type];
    const s = containerScale(type, container);
    // y 对齐地面高程：容器若落在架高平台上，必须抬到平台顶面，否则会陷进地里 / 卡墙根。
    vpos.set(container.x, u(elevationAt(map, container.x, container.y)), container.y);
    quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (container.id % 8) * (Math.PI / 4));
    vscl.set(s, s, s);
    mat4.compose(vpos, quat, vscl);
    slot.main.setMatrixAt(index, mat4);
    if (slot.trim) slot.trim.setMatrixAt(index, mat4);

    // 实例色 = 亮度系数（材质基色 × 实例色），用于色差与"已搜过"的压暗
    const k = dimmed ? VIEW3D.level.searchedDim : 1;
    tmpColor.setRGB(k, k, k);
    slot.main.setColorAt(index, tmpColor);
    if (slot.trim) slot.trim.setColorAt(index, tmpColor);
  }

  /**
   * 登记一个容器（局内新增的尸体也走这里）。
   * @param {object} container 容器对象
   * @returns {void}
   */
  function addContainer(container) {
    const slot = typeSlots[container.type];
    if (!slot || slot.count >= slot.capacity) return;
    const index = slot.count;
    slot.count += 1;
    slot.main.count = slot.count;
    if (slot.trim) slot.trim.count = slot.count;
    writeInstance(container.type, index, container, container.searched);
    slot.main.instanceMatrix.needsUpdate = true;
    if (slot.trim) slot.trim.instanceMatrix.needsUpdate = true;
    if (slot.main.instanceColor) slot.main.instanceColor.needsUpdate = true;
    if (slot.trim && slot.trim.instanceColor) slot.trim.instanceColor.needsUpdate = true;
    instanceOf.set(container, { type: container.type, index, container });
    // #P0-2 夜战可见性：可搜刮容器脚下补一圈地光环（尸体不补）
    // P1-2：写进同一个 InstancedMesh 的第 glowRingCount 个实例，不再 new Mesh。
    if (LOOT_TYPES.has(container.type) && glowRingCount < glowRings.instanceMatrix.count) {
      glowMat4.makeTranslation(
        container.x, u(elevationAt(map, container.x, container.y)) + u(0.03), container.y,
      );
      glowRings.setMatrixAt(glowRingCount, glowMat4);
      glowRingCount += 1;
      glowRings.count = glowRingCount;
      glowRings.instanceMatrix.needsUpdate = true;
    }
  }

  /* ---------------- P23：容器视觉升级为 GLB（异步、可降级） ----------------
   * 顺序是刻意的：程序化模型先建好（首帧一定不是空的），GLB 到了再原地接管。
   * 交接时必须按原 index 顺序回放实例，否则 instanceOf 里的 (container → index) 映射会错位，
   * 表现就是"搜过的箱子变亮、没搜的变暗"这种阴间 bug。
   */
  const glbTypes = new Set();
  let disposed = false;

  /**
   * 把某一类容器换成 GLB 模型。
   * @param {string} type 容器类型
   * @returns {void}
   */
  function upgradeContainerModel(type) {
    const rel = GLB_CONTAINERS[type];
    const slot = typeSlots[type];
    if (!rel || !slot || slot.glb) return;
    loadGLB(rel).then((gltf) => {
      if (disposed || !gltf) return;
      const merged = mergeStatic(gltf.scene);
      if (!merged) return; // 多材质 / 蒙皮 / 解析异常 → 保持程序化模型
      if (disposed) {
        merged.geometry.dispose();
        return;
      }

      const isLoot = LOOT_TYPES.has(type);
      // 颜色必须乘上本作的容器基色（CONTAINER_COLORS），**不能**沿用 GLTF 的白色固有色 ——
      // 详见 glbLambert 的注释：Kenney 的 albedo 本身很亮，白固有色 × 本作光照会饱和过曝，
      // 木箱直接变成一块惨白的板子。乘基色后等价于"给 GLB 套一层本作调色"。
      const mat = glbLambert(merged.material, {
        color: CONTAINER_COLORS[type],
        // #P0-2 夜战可见性沿用原规则：可搜刮容器带轻微自发光，暗处不致死黑。
        emissive: isLoot ? VIEW3D.lootEmissive : null,
        emissiveIntensity: isLoot ? VIEW3D.lootEmissiveIntensity : 0,
      });

      const mesh = new THREE.InstancedMesh(merged.geometry, mat, Math.max(1, slot.capacity));
      mesh.name = `containers:${type}`;
      mesh.count = slot.count;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      disposables.push(merged.geometry, mat);

      // 交接：旧实例下线（几何/材质仍由 dispose() 统一释放），新实例接管 slot。
      const oldMain = slot.main;
      const oldTrim = slot.trim;
      group.remove(oldMain);
      if (oldTrim) group.remove(oldTrim);
      slot.main = mesh;
      slot.trim = null;
      slot.geo = merged.geometry;
      slot.glb = true;
      glbTypes.add(type);

      const recs = [];
      for (const [container, rec] of instanceOf) if (rec.type === type) recs.push([container, rec]);
      recs.sort((a, b) => a[1].index - b[1].index);
      for (const [container, rec] of recs) writeInstance(type, rec.index, container, container.searched);
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
  }

  for (const container of map.containers) addContainer(container);
  // 程序化模型已就位，这里只是"有空就换更好的"，失败静默；?glb=0 时整条路径不启动。
  if (glbEnabled()) for (const type of Object.keys(GLB_CONTAINERS)) upgradeContainerModel(type);

  // 幽灵痕迹：独立 fork 子流、纯视觉不改 map。必须在 freezeStaticTree 之前挂上，
  // 让这批静态贴片跟其它静态物件一起冻结（不需要进 skipRoots）。
  attachGhostTraces(group, map, rng, disposables);

  /* --- 架高平台：台面 + 台沿 + 台阶 --------------------------------------
   * 台面顶面高度严格等于 u(VIEW3D.platformHeight)，与 elevationAt() 的返回值一致，
   * 保证"看到的高度"和"逻辑高程"永远对得上，不会出现在台面上却悬空 / 陷进台面的情况。
   *
   * P1-2：平台是纯静态道具（不旋转、不脉动、不换色），旧实现每个平台 4 个独立 Mesh
   * （ridge 最多 6 个平台 = 24 draw）。现在按 3 种材质把全部平台各合并成 1 个 Mesh，
   * draw 固定在 3，几何顶点和世界坐标逐点不变。撤离环 / 高亮 / 掩体箱不在本块内。 */
  const platformMeshes = [];
  {
    // 平台是画面里第二大的连续平面（仅次于地面）。原来用纯色 + flatShading，
    // 在强主光下就是一块均匀发亮的白板 —— 观感上比"没有平台"更廉价。
    // 换成带混凝土贴图的 Standard 材质并整体压暗，才和墙体站在同一个世界尺度上。
    const platMat = surfaceMat(shade(PALETTE3D.platform, 0.26), getConcreteTexture(), VIEW3D.wallRoughness, surfaceDetail);
    const trimMat = surfaceMat(shade(PALETTE3D.platformTrim, 0.34), getConcreteTexture(), VIEW3D.wallRoughness, surfaceDetail);
    const stepMat = surfaceMat(shade(PALETTE3D.platformStep, 0.8), getConcreteTexture(), VIEW3D.wallRoughness, surfaceDetail);
    const ph = u(VIEW3D.platformHeight);
    const platGeos = [];
    const trimGeos = [];
    const stepGeos = [];
    const pushBox = (list, sx, sy, sz, x, y, z) => {
      const g = new THREE.BoxGeometry(sx, sy, sz);
      g.translate(x, y, z);
      list.push(g);
    };
    for (const p of (map.platforms || [])) {
      const cx = p.x + p.w / 2;
      const cz = p.y + p.h / 2;
      // 台面：与旧 slab.position=(cx, ph/2, cz) 完全等价
      pushBox(platGeos, p.w, ph, p.h, cx, ph / 2, cz);
      // 台沿：略大一圈的薄板压在顶面，让高度差一眼可辨（否则容易看成平地）
      const lipH = u(0.07);
      pushBox(trimGeos, p.w + 6, lipH, p.h + 6, cx, ph - lipH / 2, cz);
      // 台阶：放在不靠墙的一侧，做出"可以走上去"的暗示
      const sides = [
        { ox: 0, oz: -1, sx: p.w, sz: 20, px: cx, pz: p.y - 12 },
        { ox: 0, oz: 1, sx: p.w, sz: 20, px: cx, pz: p.y + p.h + 12 },
        { ox: -1, oz: 0, sx: 20, sz: p.h, px: p.x - 12, pz: cz },
        { ox: 1, oz: 0, sx: 20, sz: p.h, px: p.x + p.w + 12, pz: cz },
      ];
      const side = sides.find(
        (s) => !isTileSolid(map, Math.floor(s.px / map.tile), Math.floor(s.pz / map.tile)),
      ) || sides[0];
      for (let i = 0; i < 2; i += 1) {
        const sh = ph * (i === 0 ? 0.66 : 0.33);
        const off = i === 0 ? 0 : 18;
        pushBox(stepGeos, side.sx, sh, side.sz,
          side.px + side.ox * off, sh / 2, side.pz + side.oz * off);
      }
    }
    // 旧三类的阴影标记不同：slab 投影+接收、lip 都不投、step 仅接收。逐类保留。
    const addMerged = (geos, mat, castShadow, receiveShadow) => {
      if (!geos.length) return;
      const merged = mergeGeometries(geos);
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = castShadow;
      mesh.receiveShadow = receiveShadow;
      group.add(mesh);
      platformMeshes.push(mesh);
      disposables.push(merged, mat);
      for (const g of geos) g.dispose();
    };
    addMerged(platGeos, platMat, true, true);
    addMerged(trimGeos, trimMat, false, false);
    addMerged(stepGeos, stepMat, false, true);
  }

  /**
   * 标记容器为已搜索（压暗）。
   * @param {object} container 容器对象
   * @returns {void}
   */
  function setSearched(container, dimmed = true) {
    const rec = instanceOf.get(container);
    if (!rec) return;
    // P20：补货会把容器重新上锁，这时必须能把它"点亮"回来 ——
    // 原来这里写死 true，补了货的箱子在画面上仍是暗的，等于骗玩家"这个搜过了"。
    writeInstance(rec.type, rec.index, container, dimmed !== false);
    const slot = typeSlots[rec.type];
    slot.main.instanceMatrix.needsUpdate = true;
    if (slot.main.instanceColor) slot.main.instanceColor.needsUpdate = true;
    if (slot.trim && slot.trim.instanceColor) slot.trim.instanceColor.needsUpdate = true;
  }

  /* ---------------- 撤离点 ---------------- */

  const extractMarkers = map.extracts.map((point) => {
    const marker = buildExtractMarker(point.r);
    marker.position.set(point.x, 0, point.y);
    marker.visible = Boolean(point.open);
    group.add(marker);
    disposables.push(
      marker.userData.ring.geometry, marker.userData.ringMat,
      marker.userData.beam.geometry, marker.userData.beamMat,
    );
    return marker;
  });

  /* ---------------- 可交互高亮 ---------------- */

  const hlGeo = new THREE.RingGeometry(0.82, 1, 20);
  hlGeo.rotateX(-Math.PI / 2);
  const hlMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(PALETTE3D.highlight),
    transparent: true,
    opacity: 0.75,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const highlight = new THREE.Mesh(hlGeo, hlMat);
  highlight.visible = false;
  highlight.renderOrder = 5;
  group.add(highlight);
  disposables.push(hlGeo, hlMat);

  /**
   * 设置高亮位置（传 null 隐藏）。
   * @param {number|null} x 世界 x
   * @param {number|null} z 世界 z（逻辑 y）
   * @param {number} radius 半径
   * @returns {void}
   */
  function setHighlight(x, z, radius = 40) {
    if (x === null) {
      highlight.visible = false;
      return;
    }
    highlight.visible = true;
    highlight.position.set(x, u(0.06), z);
    highlight.scale.set(radius * 1.25, 1, radius * 1.25);
  }

  /**
   * 每帧更新（撤离点光柱脉动 + 高亮呼吸）。
   * @param {number} time 战局累计时间（秒）
   * @returns {void}
   */
  function update(time) {
    const pulse = 0.5 + 0.5 * Math.sin(time * VIEW3D.level.highlightPulseSpeed);
    for (const marker of extractMarkers) {
      marker.userData.ringMat.opacity = 0.40 + pulse * 0.32;
      marker.userData.beamMat.opacity = 0.10 + pulse * 0.10;
      marker.userData.ring.rotation.y = time * 0.4;
    }
    if (highlight.visible) hlMat.opacity = 0.45 + pulse * 0.4;
  }

  /** 掩体箱受损：按剩余血量比例向瓦砾色压暗（受损越重越暗），只改该实例颜色 */
  function damageCrateVisual(i, hpRatio) {
    if (i < 0 || i >= crateCount || crateDestroyed[i]) return;
    const t = 1 - Math.max(0, Math.min(1, hpRatio));
    crateInstances.setColorAt(
      i, crateColor.copy(baseColor).lerp(rubbleColor, t * 0.6).multiplyScalar(crateK[i]),
    );
    crateInstances.instanceColor.needsUpdate = true;
  }

  /** 掩体箱碎裂：压扁成低矮瓦砾并染废墟色（只改该实例的矩阵和颜色） */
  function setCrateDestroyed(i) {
    if (i < 0 || i >= crateCount || crateDestroyed[i]) return;
    crateDestroyed[i] = 1;
    // 几何底部贴地，把 y 缩放压到 0.16 即把箱子压向瓦砾；矩阵无旋转，elements[5] 即 y 缩放。
    crateInstances.getMatrixAt(i, crateMatrix);
    crateMatrix.elements[5] *= 0.16;
    crateInstances.setMatrixAt(i, crateMatrix);
    crateInstances.instanceMatrix.needsUpdate = true;
    crateInstances.setColorAt(i, crateColor.copy(rubbleColor).multiplyScalar(crateK[i]));
    crateInstances.instanceColor.needsUpdate = true;
  }

  /** 销毁关卡，释放 GPU 资源 */
  function dispose() {
    disposed = true; // 阻断仍在飞行中的 GLB 回调，避免往已拆的场景里塞网格
    scene.remove(group);
    group.clear();
    for (const d of disposables) if (d && typeof d.dispose === 'function') d.dispose();
    instanceOf.clear();
  }

  // P0-2：静态物件冻结矩阵。掩体箱实例矩阵会随受损/碎裂改动、撤离点光柱会旋转、
  // 高亮会移动，这三类子树必须跳过，否则冻结后视觉不再更新。
  freezeStaticTree(group, [cratesGroup, ...extractMarkers, highlight]);

  return {
    group,
    ground,
    solids,
    ceiling,
    ceilingRooms: indoorRooms,
    beams,
    lampSites: lampPoints,
    lampLights,
    lampPools,
    lampFixtures,
    crateInstances,
    // P1-2：平台合并后的 3 个静态 Mesh（几何顶点含全部平台的台面/台沿/台阶）。
    platformMeshes,
    // P1-2：容器地光环合并实例（count = 当前可搜刮容器数）
    glowRings,
    // P23：哪些容器类型已成功换成 GLB 模型（空集合 = 全部走程序化兜底）。探针据此判真假。
    glbTypes,
    extractMarkers,
    addContainer,
    setSearched,
    setHighlight,
    setCrateDestroyed,
    damageCrateVisual,
    update,
    dispose,
  };
}
