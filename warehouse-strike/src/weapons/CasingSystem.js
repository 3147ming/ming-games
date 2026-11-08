/**
 * 抛壳系统：对象池实现，弹壳受重力影响并在地面弹跳
 */
import * as THREE from 'three';

export class CasingSystem {
  constructor(scene, audio) {
    this.audio = audio;
    this.items = [];
    const geo = new THREE.CylinderGeometry(0.007, 0.008, 0.026, 6);
    const mat = new THREE.MeshStandardMaterial({ color: 0xc8a34a, metalness: 0.75, roughness: 0.35 });

    for (let i = 0; i < 16; i++) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      scene.add(mesh);
      this.items.push({
        mesh,
        life: 0,
        maxLife: 1.6,
        vel: new THREE.Vector3(),
        spin: new THREE.Vector3(),
      });
    }
  }

  /**
   * 抛出一枚弹壳
   * @param {THREE.Vector3} pos 起始位置（枪机附近）
   * @param {THREE.Vector3} rightDir 相机右方向
   */
  spawn(pos, rightDir) {
    const item = this.items.find((i) => i.life <= 0) || this.items[0];
    item.mesh.position.copy(pos);
    item.mesh.visible = true;
    item.mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    item.vel.set(
      rightDir.x * (2.2 + Math.random()) + (Math.random() - 0.5) * 0.4,
      2.0 + Math.random() * 1.2,
      rightDir.z * (2.2 + Math.random()) + (Math.random() - 0.5) * 0.4
    );
    item.spin.set(Math.random() * 12, Math.random() * 12, Math.random() * 12);
    item.life = item.maxLife;
  }

  update(dt) {
    for (const item of this.items) {
      if (item.life <= 0) continue;
      item.life -= dt;

      item.vel.y -= 14 * dt;
      item.mesh.position.x += item.vel.x * dt;
      item.mesh.position.y += item.vel.y * dt;
      item.mesh.position.z += item.vel.z * dt;

      // 地面弹跳
      if (item.mesh.position.y < 0.012) {
        item.mesh.position.y = 0.012;
        item.vel.y = -item.vel.y * 0.35;
        item.vel.x *= 0.6;
        item.vel.z *= 0.6;
      }

      item.mesh.rotation.x += item.spin.x * dt;
      item.mesh.rotation.y += item.spin.y * dt;
      item.mesh.rotation.z += item.spin.z * dt;

      if (item.life <= 0) item.mesh.visible = false;
    }
  }
}
