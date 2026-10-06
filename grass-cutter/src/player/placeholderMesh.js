/**
 * ⚠ 角色**外观**占位（TEMPORARY MESH）—— 只是几何体堆出来的小人，不是模块 2 的交付物。
 * ---------------------------------------------------------------------------
 * 控制器（controller.js）是真的；这里只有"长什么样"是假的。
 * 换成真正的武将模型 + 骨骼动画时，**只替换本文件**，控制器一行不用动 ——
 * 所以这里刻意只暴露两个东西：createPlaceholderMesh() 与 updateMesh(mesh, snapshot)。
 *
 * 已经写进来的：朝向、跟着脚底高度升降、闪避时的压低姿态。
 * 还没写（属于后续模块）：走跑动画、挥砍动作、受击反馈、残影。
 */
import {
  BoxGeometry,
  CapsuleGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
} from '../../vendor/three/three.module.js';
import { PLAYER } from '../core/config.js';

export const TEMPORARY = true;

export function createPlaceholderMesh() {
  const g = new Group();
  g.name = 'player-placeholder';
  const skin = new MeshStandardMaterial({ color: 0xcf9a6a, roughness: 0.85, metalness: 0 });
  const armor = new MeshStandardMaterial({ color: 0x5a6d8c, roughness: 0.6, metalness: 0.25 });
  const gear = new MeshStandardMaterial({ color: 0x8a6a3a, roughness: 0.8, metalness: 0.1 });
  const r = PLAYER.RADIUS;

  const legs = new Mesh(new BoxGeometry(r * 1.5, 0.85, r * 1.1), gear);
  legs.position.y = 0.425;
  const torso = new Mesh(new CapsuleGeometry(r * 0.85, 0.55, 4, 10), armor);
  torso.position.y = 1.16;
  const head = new Mesh(new CapsuleGeometry(r * 0.42, 0.16, 4, 10), skin);
  head.position.y = 1.68;
  // 长枪：给个明确的"前方"，方便一眼看出人物朝向
  const pole = new Mesh(new CylinderGeometry(0.035, 0.035, 2.6, 6), gear);
  pole.position.set(r * 1.15, 1.15, 0);
  pole.rotation.z = 0.22;
  const tip = new Mesh(new ConeGeometry(0.075, 0.34, 6), armor);
  tip.position.set(r * 1.4, 2.4, 0);

  for (const m of [legs, torso, head, pole, tip]) {
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  }
  g.userData.body = { legs, torso, head, pole, tip };
  return g;
}

/**
 * 把控制器的快照套到网格上（只做"位置/朝向/姿态"，不做动画）。
 * @param combat 模块 3 的连段快照（可选）。用它在**不开骨骼动画**的前提下
 *   把"正在挥第几击"表现出来：扭腰 + 挥枪。真正的手感靠模块 3 的刀光与顿帧。
 */
export function updateMesh(mesh, snap, combat = null) {
  mesh.position.set(snap.x, snap.y, snap.z);
  mesh.rotation.y = snap.facing;
  const body = mesh.userData.body;
  if (!body) return;

  // 闪避时压低身体；滞空时略微前倾 —— 都是"能看出状态"的最低成本做法
  const crouch = snap.state === 'dodge' ? 0.22 : snap.grounded ? 0 : 0.06;
  body.torso.position.y = 1.16 - crouch * 0.6;
  body.head.position.y = 1.68 - crouch * 0.8;
  body.pole.rotation.x = snap.state === 'air' ? -0.25 : 0;

  // 攻击姿态：前摇抬枪 → 判定帧甩出去 → 后摇收回；蓄力则持续压低
  const busy = combat && combat.busy;
  if (busy) {
    const p = combat.progress;
    const swing = p < 0.45 ? -p / 0.45 : 1 - (p - 0.45) / 0.55;
    body.torso.rotation.y = swing * -0.85;
    body.pole.rotation.x = -0.35 - swing * 1.5;
    body.pole.rotation.z = 0.22 + swing * 0.5;
    body.legs.rotation.y = swing * -0.3;
  } else if (combat && combat.phase === 'charging') {
    body.torso.rotation.y = 0.25;
    body.pole.rotation.x = -0.5;
    body.pole.rotation.z = 0.9;
    body.legs.rotation.y = 0;
  } else {
    body.torso.rotation.y = 0;
    body.pole.rotation.x = 0;
    body.pole.rotation.z = 0.22;
    body.legs.rotation.y = 0;
  }
}
