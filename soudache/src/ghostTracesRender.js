/**
 * 幽灵痕迹的**渲染层**：把 ghostTraces.js 输出的逻辑坐标贴到新版的三维地面上。
 *
 * 为什么不并进 ghostTraces.js：那个模块是纯数据层（零 three / 零 DOM、可序列化单测），
 * 这条纪律是旧版就定下的，移植时不能破坏。渲染单独成模块，也让 level3d.js 的
 * 接入点保持"一行 import + 一行调用"，不去动它已经重排过的归档/装配逻辑。
 *
 * ⚠ 与旧版 level3d 接入的实质差异（必须重新对齐，不能照搬）：
 *   1. **地形高度**：新版有 elevationAt() 架高平台，旧版固定 u(0.03) 会把痕迹
 *      埋进平台或浮在坑里。这里逐点算 u(elevationAt(map,x,y)) + u(0.03)。
 *   2. **冻结时机**：buildLevel 末尾 freezeStaticTree() 会把所有 Mesh 的矩阵冻住。
 *      痕迹是静态的，必须在冻结之前挂上；挂上后就跟着一起冻，不要进 skipRoots。
 *   3. **资源回收**：geo/mat 必须注册进 disposables，否则重开一局泄漏 GPU 资源。
 */

import * as THREE from '../vendor/three.module.js';
import { RNG_SALT_3D } from './config.js';
import { u } from './models.js';
import { elevationAt } from './mapgen.js';
import { generateGhostTraces } from './ghostTraces.js';

/** 独立子流盐值：绝不能复用 RNG_SALT_3D.level，否则会扰动既有装饰序列 */
const GHOST_SALT = RNG_SALT_3D.level ^ 0x9E3779B9;

/**
 * 在关卡根节点上挂幽灵痕迹。
 * @param {THREE.Group} parent 关卡 group（level3d 的 group）
 * @param {object} map mapgen.generateMap 输出（只读）
 * @param {object} rng 战局随机源（fork 出独立子流）
 * @param {THREE.Object3D[]} disposables 关卡资源回收数组
 * @returns {{footprints:number, scuffs:number, group:THREE.Group|null}}
 */
export function attachGhostTraces(parent, map, rng, disposables = []) {
  const traces = generateGhostTraces(map, rng.fork(GHOST_SALT), {
    groups: 4,
    stepsPerGroup: 5,
    stepLen: (map && map.tile ? map.tile : 40) * 0.55,
  });
  if (!traces.length || !parent) return { footprints: 0, scuffs: 0, group: null };

  const root = new THREE.Group();
  root.name = 'ghost-traces';
  parent.add(root);

  const lift = u(0.03); // 贴地高度，略高于地面避免 z-fighting
  const layFlat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  const spinAxis = new THREE.Vector3(0, 0, 1);
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();

  const mkTraces = (list, radius, color, opacity, name) => {
    if (!list.length) return 0;
    const geo = new THREE.CircleGeometry(radius, 10);
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    mesh.name = name;
    mesh.frustumCulled = false;
    for (let i = 0; i < list.length; i += 1) {
      const t = list[i];
      // 新版地形有架高平台：逐点取高度，不能用一个全局 Y
      p.set(t.x, u(elevationAt(map, t.x, t.y)) + lift, t.y);
      const sc = t.scale || 1;
      s.set(sc, sc, 1);
      const spin = new THREE.Quaternion().setFromAxisAngle(spinAxis, t.angle || 0);
      m.compose(p, layFlat.clone().multiply(spin), s);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    root.add(mesh);
    disposables.push(geo, mat);
    return list.length;
  };

  // 脚印：冷青微光；撬痕/血迹：暗红微光
  const footprints = traces.filter((t) => t.type === 'footprint');
  const scuffs = traces.filter((t) => t.type === 'scuff');
  mkTraces(footprints, u(0.16), new THREE.Color('#4fd1c5'), 0.22, 'ghost-traces-footprints');
  mkTraces(scuffs, u(0.42), new THREE.Color('#b83a32'), 0.28, 'ghost-traces-scuffs');

  return { footprints: footprints.length, scuffs: scuffs.length, group: root };
}
