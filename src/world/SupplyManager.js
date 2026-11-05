/**
 * 补给点系统（v0.3）：资源点 / 弹药补给 / 物资补给
 *
 * - 地图上散布若干补给点（SUPPLY.points），分四类：
 *   ammo 弹药箱 / med 医疗包 / armor 护甲板 / cache 综合物资箱
 * - 玩家走近（SUPPLY.pickupRadius）自动拾取，无需按键；
 * - 拾取后进入冷却（SUPPLY.respawnSec）再重新刷新，循环可用；
 * - 视觉：发光补给箱 + 上下浮动 + 垂直光柱，远处可见，方便规划路线。
 */
import * as THREE from 'three';
import { SUPPLY } from '../config/weapon.js';

export class SupplyManager {
  /**
   * @param opts { scene, player, gun, playerHealth, hud, audio }
   */
  constructor(opts) {
    this.scene = opts.scene;
    this.player = opts.player;
    this.gun = opts.gun;
    this.playerHealth = opts.playerHealth;
    this.hud = opts.hud;
    this.audio = opts.audio;

    this.group = new THREE.Group();
    this.points = [];
    this._time = 0;

    this._buildPoints();
    this.scene.add(this.group);
  }

  _buildPoints() {
    const typeEntries = SUPPLY.types;
    for (const def of SUPPLY.points) {
      const cfg = typeEntries[def.type] || typeEntries.ammo;
      const root = new THREE.Group();
      root.position.set(def.x, 0, def.z);

      // 补给箱本体
      const boxMat = new THREE.MeshStandardMaterial({
        color: cfg.color, roughness: 0.55, metalness: 0.25,
        emissive: cfg.color, emissiveIntensity: 0.22,
      });
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.5, 0.52), boxMat);
      box.position.y = 0.32;
      box.castShadow = true;
      box.receiveShadow = true;
      root.add(box);

      // 箱盖十字绑带（识别色）
      const strapMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75 });
      const strapA = new THREE.Mesh(new THREE.BoxGeometry(0.76, 0.54, 0.08), strapMat);
      strapA.position.y = 0.32;
      const strapB = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.54, 0.56), strapMat);
      strapB.position.y = 0.32;
      root.add(strapA, strapB);

      // 垂直光柱（远处可见）
      const beamMat = new THREE.MeshBasicMaterial({
        color: cfg.color, transparent: true, opacity: 0.16,
        depthWrite: false, side: THREE.DoubleSide,
      });
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.34, 3.2, 10, 1, true), beamMat);
      beam.position.y = 1.7;
      root.add(beam);

      // 顶部浮标
      const orbMat = new THREE.MeshBasicMaterial({ color: cfg.color, transparent: true, opacity: 0.85 });
      const orb = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), orbMat);
      orb.position.y = 0.85;
      root.add(orb);

      // 地面光圈
      const ringMat = new THREE.MeshBasicMaterial({
        color: cfg.color, transparent: true, opacity: 0.3,
        depthWrite: false, side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.75, 24), ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.02;
      root.add(ring);

      this.group.add(root);
      this.points.push({
        type: def.type,
        cfg,
        root, box, beam, orb, ring,
        cooldown: 0,       // >0 = 冷却中（已拾取待刷新）
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  /** 开局 / 重开：全部补给点复位 */
  reset() {
    for (const p of this.points) {
      p.cooldown = 0;
      p.root.visible = true;
    }
  }

  update(dt) {
    this._time += dt;
    const player = this.player;
    if (!player || player.dead) return;

    for (const p of this.points) {
      // 浮动与呼吸动画
      const bob = Math.sin(this._time * 2.1 + p.phase);
      p.orb.position.y = 0.85 + bob * 0.09;
      p.beam.material.opacity = 0.13 + (bob * 0.5 + 0.5) * 0.08;
      p.ring.rotation.z += dt * 0.55;

      if (p.cooldown > 0) {
        p.cooldown -= dt;
        if (p.cooldown <= 0) {
          p.cooldown = 0;
          p.root.visible = true;   // 冷却结束重新刷新
        }
        continue;
      }

      // 靠近自动拾取
      const dx = player.position.x - p.root.position.x;
      const dz = player.position.z - p.root.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist > SUPPLY.pickupRadius) continue;

      const cfg = p.cfg;
      let took = false;
      if (cfg.ammo > 0 && this.gun) {
        this.gun.addSupply(cfg.ammo);
        took = true;
      }
      if (cfg.heal > 0 && this.playerHealth) {
        const before = this.playerHealth.health;
        this.playerHealth.heal(cfg.heal);
        if (this.playerHealth.health > before) took = true;
        else if (cfg.ammo === 0 && cfg.armor === 0) {
          // 满血捡医疗包：不消耗，留给残血时用
          continue;
        }
      }
      if (cfg.armor > 0 && this.playerHealth) {
        const before = this.playerHealth.armor;
        this.playerHealth.addArmor(cfg.armor);
        if (this.playerHealth.armor > before) took = true;
        else if (cfg.ammo === 0 && cfg.heal === 0) {
          continue;   // 满甲捡护甲板：不消耗
        }
      }
      if (!took) continue;

      p.cooldown = SUPPLY.respawnSec;
      p.root.visible = false;
      if (this.audio) this.audio.play('reload', { volume: 0.5, rate: 1.15 });
      if (this.hud) this.hud.showSupplyToast(cfg.label, cfg.hint);
    }
  }
}
