/**
 * 机甲系统（v0.5）
 *
 * 三种机甲全部支持（大厅解锁 → 局内 TAB 面板召唤）：
 *   - armor 装甲形态：独立护盾 + 伤害 / 移速倍率，燃料倒计时；
 *   - heavy 重装兵装：独立护盾 + 伤害 / 射速倍率，移速略降；
 *   - turret 哨戒炮塔：在身前部署自动索敌炮塔，限时存在。
 *
 * 机甲是"形态增益"，不改玩家碰撞体与视角；护盾由 PlayerController.takeDamage 优先吸收。
 */
import * as THREE from 'three';
import { MECHS } from '../config/growth.js';

export class MechSystem {
  constructor({ scene, player, gun, enemies, effects, audio, hud, save }) {
    this.scene = scene;
    this.player = player;
    this.gun = gun;
    this.enemies = enemies;
    this.effects = effects;
    this.audio = audio;
    this.hud = hud;
    this.save = save;

    this.active = null;      // {def, timer}
    this.turret = null;      // {group, timer, cooldown}
    this._base = null;       // 激活前的倍率快照

    this._buildStatus();
  }

  // ---------------- 状态 HUD ----------------
  _buildStatus() {
    if (document.getElementById('mech-status')) {
      this.statusEl = document.getElementById('mech-status');
    } else {
      const el = document.createElement('div');
      el.id = 'mech-status';
      el.className = 'mech-status hidden';
      el.innerHTML = `
        <div class="mech-name"></div>
        <div class="mech-bar"><i></i></div>
        <div class="mech-info"></div>`;
      document.getElementById('app')?.appendChild(el);
      this.statusEl = el;
    }
    this.$name = this.statusEl.querySelector('.mech-name');
    this.$bar = this.statusEl.querySelector('.mech-bar i');
    this.$info = this.statusEl.querySelector('.mech-info');
  }

  // ---------------- 查询 ----------------
  has(id) {
    return !!this.save?.hasMech(id);
  }

  get activeId() {
    return this.active ? this.active.def.id : null;
  }

  isActive() {
    return !!this.active;
  }

  /** 面板展示用：每种机甲的解锁与是否可召唤 */
  getStates() {
    return Object.values(MECHS).map((def) => ({
      def,
      unlocked: this.has(def.id),
      active: this.activeId === def.id,
    }));
  }

  // ---------------- 召唤 ----------------
  /**
   * 召唤机甲；返回 {ok, message}
   * @param {string} id armor | heavy | turret
   */
  activate(id) {
    const def = MECHS[id];
    if (!def) return { ok: false, message: '未知机甲' };
    if (!this.has(id)) return { ok: false, message: '尚未解锁该机甲' };

    if (def.type === 'deploy') {
      if (this.turret) return { ok: false, message: '炮塔已在场上' };
      this._deployTurret(def);
      return { ok: true, message: `已部署：${def.name}` };
    }

    if (this.active) return { ok: false, message: `已在${this.active.def.name}形态` };
    this._enterForm(def);
    return { ok: true, message: `机甲出击：${def.name}` };
  }

  _enterForm(def) {
    this._base = {
      dmg: this.gun.damageMul,
      rate: this.gun.fireRateMul,
      speed: this.player.speedMul,
    };
    this.gun.damageMul = this._base.dmg * def.dmgMul;
    this.gun.fireRateMul = this._base.rate * (def.fireRateMul || 1);
    this.player.speedMul = this._base.speed * def.speedMul;
    this.player.shieldMax = def.shield;
    this.player.shield = def.shield;
    this.active = { def, timer: def.duration };
    this.statusEl?.classList.remove('hidden');
    this._syncStatus();
    this.hud?.showSupplyToast?.(`机甲形态：${def.name}`, `护盾 ${def.shield} · 持续 ${def.duration} 秒`);
    this.audio?.play?.('pickup', { volume: 0.8, rate: 1.1 });
  }

  /** 退出当前形态（燃料耗尽或主动复位时调用） */
  exitForm() {
    if (!this.active) return;
    const def = this.active.def;
    if (this._base) {
      this.gun.damageMul = this._base.dmg;
      this.gun.fireRateMul = this._base.rate;
      this.player.speedMul = this._base.speed;
    }
    this._base = null;
    this.player.shield = 0;
    this.player.shieldMax = 0;
    this.active = null;
    this.statusEl?.classList.add('hidden');
    this.hud?.showSupplyToast?.('机甲形态结束', `${def.name} 燃料耗尽`);
  }

  _deployTurret(def) {
    const group = new THREE.Group();
    const baseMat = new THREE.MeshStandardMaterial({ color: 0x3b4048, metalness: 0.6, roughness: 0.5 });
    const accentMat = new THREE.MeshStandardMaterial({ color: 0xd08c2a, emissive: 0x5a3200, emissiveIntensity: 0.7 });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.7, 0.35, 12), baseMat);
    base.position.y = 0.175;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 0.55, 10), accentMat);
    post.position.y = 0.62;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.34, 0.5), baseMat);
    head.position.y = 0.95;
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.9, 10), accentMat);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.95, -0.55);
    head.add(barrel);
    group.add(base, post, head);

    const yaw = this.player.camera ? this.player.camera.rotation.y : 0;
    const pos = new THREE.Vector3(
      this.player.position.x - Math.sin(yaw) * 1.8,
      0,
      this.player.position.z - Math.cos(yaw) * 1.8,
    );
    group.position.copy(pos);
    this.scene.add(group);
    this.turret = { def, group, head, barrel, timer: def.duration, cooldown: 0 };
    this.hud?.showSupplyToast?.('部署哨戒炮塔', `${def.duration} 秒自动索敌`);
    this.audio?.play?.('pickup', { volume: 0.7, rate: 0.8 });
  }

  _removeTurret() {
    if (!this.turret) return;
    this.scene.remove(this.turret.group);
    this.turret.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose?.();
    });
    this.turret = null;
  }

  // ---------------- 每帧更新 ----------------
  update(dt) {
    if (this.active) {
      this.active.timer -= dt;
      if (this.active.timer <= 0) {
        this.exitForm();
      } else if (this.player.shield <= 0) {
        this.exitForm();
      } else {
        this._syncStatus();
      }
    }
    if (this.turret) this._updateTurret(dt);
  }

  _syncStatus() {
    if (!this.active || !this.statusEl) return;
    const def = this.active.def;
    const ratio = Math.max(0, Math.min(1, this.active.timer / def.duration));
    this.$name.textContent = def.name;
    this.$bar.style.transform = `scaleX(${ratio})`;
    this.statusEl.classList.toggle('danger', ratio < 0.2);
    this.$info.textContent = `燃料 ${Math.ceil(this.active.timer)}s · 护盾 ${Math.ceil(this.player.shield)}/${def.shield}`;
  }

  _updateTurret(dt) {
    const t = this.turret;
    t.timer -= dt;
    if (t.timer <= 0) {
      this._removeTurret();
      return;
    }
    t.cooldown -= dt;
    const target = this._nearestEnemy(t.def.range);
    if (target) {
      // 炮塔转向目标
      const from = t.group.position;
      const dx = target.position.x - from.x;
      const dz = target.position.z - from.z;
      t.group.rotation.y = Math.atan2(dx, dz);
      if (t.cooldown <= 0) {
        t.cooldown = t.def.cooldown;
        const shotFrom = new THREE.Vector3(from.x, 1.0, from.z);
        const shotTo = target.position.clone().setY(1.1);
        this.effects.spawnTracer(shotFrom, shotTo);
        this.effects.spawnEnemyHit(shotTo);
        target.takeDamage(t.def.damage);
        const dist = this.player.position.distanceTo(target.position);
        this.audio.play('fire2', { volume: this.audio.distanceVolume?.(dist) ?? 0.2, rate: 0.9 });
      }
    }
  }

  _nearestEnemy(range) {
    let best = null;
    let bestD = range;
    for (const e of this.enemies.enemies) {
      if (e.dead || !e.root.visible) continue;
      const d = this.player.position.distanceTo(e.position);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  /** 一局结束 / 切换地图时复位 */
  reset() {
    this.exitForm();
    this._removeTurret();
  }
}
