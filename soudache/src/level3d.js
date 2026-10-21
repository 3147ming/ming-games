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
import { VIEW3D, PALETTE3D, MATCH, CONTAINERS, RNG_SALT_3D, WORLD_W, WORLD_H } from './config.js';
import {
  u, lowPolyMat, boxWithFaceColors, mergeGeometries, buildGround, buildBushGeometry,
  buildContainerParts, buildExtractMarker, CONTAINER_COLORS, getConcreteTexture, surfaceMat,
} from './models.js';
// 只为挑台阶朝向而查询格子是否实心（纯查询，不修改 mapgen 的任何输出）
import { isTileSolid } from './mapgen.js';

/** 把颜色按亮度系数缩放（k>1 提亮，k<1 压暗），返回 CSS 十六进制串 */
function shade(hex, k) {
  const c = new THREE.Color(hex);
  c.multiplyScalar(k);
  return `#${c.getHexString()}`;
}

/**
 * 构建整张关卡。
 * @param {THREE.Scene} scene 场景
 * @param {object} map 地图对象（mapgen.generateMap 的输出）
 * @param {object} rng 战局随机源（内部 fork 出装饰用子流，保证同 seed 一致）
 * @returns {object} 关卡句柄
 */
export function buildLevel(scene, map, rng) {
  const group = new THREE.Group();
  group.name = 'level';
  scene.add(group);

  const decorRng = rng.fork(RNG_SALT_3D.level);
  const disposables = [];

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

  // 掩体箱：每个合并矩形单独成 Mesh（不并进城墙），便于被击碎时单独替换视觉。
  const cratesGroup = new THREE.Group();
  cratesGroup.name = 'crates';
  group.add(cratesGroup);
  const crateMeshes = [];
  const rubbleColor = new THREE.Color(PALETTE3D.crateRubble);
  const baseColor = new THREE.Color('#ffffff'); // 材质基色（白，点乘顶点色还原本色）
  for (let ci = 0; ci < map.crateRects.length; ci += 1) {
    const rect = map.crateRects[ci];
    const k = 1 + decorRng.float(-1, 1) * VIEW3D.level.crateColorJitter;
    const side = shade(PALETTE3D.crate, k);
    const top = shade(crateTop, k);
    const lidH = crateH * 0.09;
    const geo = mergeGeometries([
      boxWithFaceColors(
        rect.w, crateH - lidH, rect.h,
        [side, side, side, side, side, side],
      ).translate(rect.x + rect.w / 2, (crateH - lidH) / 2, rect.y + rect.h / 2),
      boxWithFaceColors(
        rect.w * 1.03, lidH, rect.h * 1.03,
        [top, top, top, top, top, top],
      ).translate(rect.x + rect.w / 2, crateH - lidH / 2, rect.y + rect.h / 2),
    ]);
    // 掩体箱改 Standard 材质：混凝土贴图 + 环境反射，不再是一块死板的纯色
    const mat = surfaceMat('#FFFFFF', getConcreteTexture(), VIEW3D.wallRoughness);
    mat.vertexColors = true;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.destroyed = false;
    cratesGroup.add(mesh);
    crateMeshes.push(mesh);
    disposables.push(geo, mat);
  }

  const solidsGeo = mergeGeometries(boxes);
  for (const b of boxes) b.dispose();
  const solidsMat = surfaceMat('#FFFFFF', getConcreteTexture(), VIEW3D.wallRoughness);
  solidsMat.vertexColors = true;
  const solids = new THREE.Mesh(solidsGeo, solidsMat);
  solids.castShadow = true;
  solids.receiveShadow = true;
  solids.name = 'solids';
  group.add(solids);
  disposables.push(solidsGeo, solidsMat);

  /* ---------------- 天花板 + 结构横梁（封闭空间 P2 增强） ----------------
   * 设计文档原定"本轮不做整体天花板"，列为 P2。本次补做：
   * - 单个水平面覆盖整张地图（1 个 draw call），DoubleSide 使玩家从下可见，
   *   castShadow=false 以免平行光被挡、地面整体变暗；
   * - 略高于墙顶（ceilingGap）避免与墙顶共面 z-fighting；
   * - 结构横梁沿 X / Z 按间距排布，合并为单网格（1 个 draw call），不投影阴影；
   * - 天花板与横梁均带轻微自发光，保证从下方观看不会发黑。
   */

  const ceilGap = u(VIEW3D.level.ceilingGap);
  const ceilY = u(VIEW3D.wallHeight) + ceilGap;

  const ceilGeo = new THREE.PlaneGeometry(WORLD_W, WORLD_H);
  ceilGeo.rotateX(-Math.PI / 2);
  ceilGeo.translate(WORLD_W / 2, ceilY, WORLD_H / 2);
  ceilGeo.computeBoundingBox();
  ceilGeo.computeBoundingSphere();
  const ceilColor = new THREE.Color(PALETTE3D.ceiling);
  const ceilMat = new THREE.MeshLambertMaterial({
    color: ceilColor,
    side: THREE.DoubleSide,
    emissive: ceilColor.clone().multiplyScalar(VIEW3D.level.ceilingEmissive),
  });
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
  for (let z = beamSpacing; z < WORLD_H; z += beamSpacing) {
    beamBoxes.push(new THREE.BoxGeometry(WORLD_W, beamH, beamW).translate(WORLD_W / 2, beamY, z));
  }
  for (let x = beamSpacing; x < WORLD_W; x += beamSpacing) {
    beamBoxes.push(new THREE.BoxGeometry(beamW, beamH, WORLD_H).translate(x, beamY, WORLD_H / 2));
  }
  const beamGeo = mergeGeometries(beamBoxes);
  // 合并后的几何体不会自动计算包围盒，显式计算以便正确进行视锥剔除，
  // 也供需要 boundingBox 的校验逻辑使用。
  beamGeo.computeBoundingBox();
  beamGeo.computeBoundingSphere();
  for (const b of beamBoxes) b.dispose();
  const beamColor = new THREE.Color(PALETTE3D.ceilingBeam);
  const beamMat = new THREE.MeshLambertMaterial({
    color: beamColor,
    emissive: beamColor.clone().multiplyScalar(VIEW3D.level.ceilingEmissive),
  });
  const beams = new THREE.Mesh(beamGeo, beamMat);
  beams.castShadow = false;
  beams.receiveShadow = false;
  beams.name = 'ceilingBeams';
  group.add(beams);
  disposables.push(beamGeo, beamMat);

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

  /* ---------------- 容器（按类型 InstancedMesh） ---------------- */

  const parts = buildContainerParts();
  const typeSlots = {}; // type → { main, trim, count, capacity }
  const instanceOf = new Map(); // container 对象 → { type, index, scale }

  // 预留容量：尸体会在局内动态增加（每个被击杀的敌人留一具）
  const extraBodies = MATCH.enemyCountMax + 2;
  for (const [type, part] of Object.entries(parts)) {
    const existing = map.containers.filter((c) => c.type === type).length;
    const capacity = existing + (type === 'body' ? extraBodies : MATCH.enemyCountMax) + 2;
    const mainMat = lowPolyMat(CONTAINER_COLORS[type], { map: part.mainTex || null });
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
    typeSlots[type] = { main, trim, count: 0, capacity };
  }

  const mat4 = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const vpos = new THREE.Vector3();
  const vscl = new THREE.Vector3();
  const tmpColor = new THREE.Color();

  /** 计算某个容器的视觉缩放：让水平最大边对齐其交互直径 */
  function containerScale(type, container) {
    const geo = parts[type].main;
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
    vpos.set(container.x, 0, container.y);
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
  }

  for (const container of map.containers) addContainer(container);

  /* --- 架高平台：台面 + 台沿 + 台阶 --------------------------------------
   * 数量很少（上限 MATCH.platformCount），直接用独立 Mesh，不必走实例化。
   * 台面顶面高度严格等于 u(VIEW3D.platformHeight)，与 elevationAt() 的返回值一致，
   * 保证"看到的高度"和"逻辑高程"永远对得上，不会出现在台面上却悬空 / 陷进台面的情况。 */
  {
    const platMat = lowPolyMat(PALETTE3D.platform);
    const trimMat = lowPolyMat(PALETTE3D.platformTrim);
    const stepMat = lowPolyMat(PALETTE3D.platformStep);
    const ph = u(VIEW3D.platformHeight);
    for (const p of (map.platforms || [])) {
      const cx = p.x + p.w / 2;
      const cz = p.y + p.h / 2;
      const slab = new THREE.Mesh(new THREE.BoxGeometry(p.w, ph, p.h), platMat);
      slab.position.set(cx, ph / 2, cz);
      slab.castShadow = true;
      slab.receiveShadow = true;
      group.add(slab);
      // 台沿：略大一圈的薄板压在顶面，让高度差一眼可辨（否则容易看成平地）
      const lipH = u(0.07);
      const lip = new THREE.Mesh(new THREE.BoxGeometry(p.w + 6, lipH, p.h + 6), trimMat);
      lip.position.set(cx, ph - lipH / 2, cz);
      group.add(lip);
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
        const step = new THREE.Mesh(new THREE.BoxGeometry(side.sx, sh, side.sz), stepMat);
        step.position.set(side.px + side.ox * off, sh / 2, side.pz + side.oz * off);
        step.receiveShadow = true;
        group.add(step);
      }
    }
  }

  /**
   * 标记容器为已搜索（压暗）。
   * @param {object} container 容器对象
   * @returns {void}
   */
  function setSearched(container) {
    const rec = instanceOf.get(container);
    if (!rec) return;
    writeInstance(rec.type, rec.index, container, true);
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

  /** 掩体箱受损：按剩余血量比例向瓦砾色压暗（受损越重越暗） */
  function damageCrateVisual(i, hpRatio) {
    const mesh = crateMeshes[i];
    if (!mesh || mesh.userData.destroyed) return;
    const t = 1 - Math.max(0, Math.min(1, hpRatio));
    mesh.material.color.copy(baseColor).lerp(rubbleColor, t * 0.6);
  }

  /** 掩体箱碎裂：压扁成低矮瓦砾并染废墟色（逻辑上该格已变地面，此处只负责视觉） */
  function setCrateDestroyed(i) {
    const mesh = crateMeshes[i];
    if (!mesh || mesh.userData.destroyed) return;
    mesh.userData.destroyed = true;
    // 几何中心位于台面高度处，关于 mesh 原点（地面）缩放即把箱子压向地面
    mesh.scale.y = 0.16;
    mesh.material.color.copy(rubbleColor);
    mesh.castShadow = false;
  }

  /** 销毁关卡，释放 GPU 资源 */
  function dispose() {
    scene.remove(group);
    group.clear();
    for (const d of disposables) if (d && typeof d.dispose === 'function') d.dispose();
    instanceOf.clear();
  }

  return {
    group,
    ground,
    solids,
    ceiling,
    beams,
    crateMeshes,
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
