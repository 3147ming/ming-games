/**
 * 守城模式运行时：领地核心、场景武器、自动炮塔、路障、人机队友、局内金币。
 *
 * - 核心：丧尸贴近后持续掉血，归零即领地失守；
 * - 场景武器：岸防炮 / 固定机枪只能上机操作，移动喷火器可拆下携带；
 * - 有限弹药 + 过热：连续开火会过热锁定，需要在波间商店补给；
 * - 波间商店：炮塔 / 路障 / 修理核心 / 补给 / 雇佣人机（金币 + 声望）。
 */
import * as THREE from 'three';
import { DEFENSE } from '../config/modes.js';
import { BOT_HIRE } from '../config/economy.js';

const UP = new THREE.Vector3(0, 1, 0);

/** 场景武器数据（按类型） */
const SCENE_WEAPONS = {
  cannon: {
    name: '岸防炮',
    ammoMax: 24, heatMax: 100, heatPerShot: 16, coolRate: 6,
    cooldown: 0.85, damage: 95, splashRadius: 4, splashDamage: 55,
    eyeHeight: 1.55, eyeZ: 0.5, auto: false,
    hint: '高爆重炮 · 有限弹药',
  },
  mg: {
    name: '固定机枪',
    ammoMax: 220, heatMax: 100, heatPerShot: 4.5, coolRate: 9,
    cooldown: 0.085, damage: 22,
    eyeHeight: 1.45, eyeZ: 0.45, auto: true,
    hint: '持续压制 · 注意过热',
  },
  flamer: {
    name: '移动喷火器',
    ammoMax: 100, heatMax: 100, heatPerShot: 0, coolRate: 8,
    cooldown: 0, damage: 34, range: 6.5, cosAngle: 0.55,
    eyeHeight: 1.1, eyeZ: 0, auto: true,
    hint: '便携喷射 · 可拆下携带',
  },
};

export class DefenseManager {
  constructor(opts) {
    this.scene = opts.scene;
    this.collision = opts.collision;
    this.player = opts.player;
    this.camera = opts.camera;
    this.enemies = opts.enemies;
    this.gun = opts.gun;
    this.weaponView = opts.weaponView;
    this.effects = opts.effects;
    this.audio = opts.audio;
    this.hud = opts.hud;
    this.save = opts.save;
    this.onCoreDestroyed = opts.onCoreDestroyed || (() => {});

    const def = opts.map && opts.map.level ? opts.map.level.defense : null;
    this.active = !!def;
    this.group = new THREE.Group();
    this.group.name = 'defense';
    this.scene.add(this.group);

    this.weapons = [];
    this.turrets = [];
    this.barricades = [];
    this.bots = [];
    this.mounted = null;
    this.carrying = null;
    this._prevPos = new THREE.Vector3();
    this._tmpDir = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._flameTimer = 0;
    this._flameSfxTimer = 0;
    this._syncTimer = 0;
    this._addedBoxes = [];

    this.coreMax = DEFENSE.coreHealth;
    this.coreHp = this.coreMax;
    this.coreDestroyed = false;
    this.gold = 0;
    this.ui = null;

    if (!this.active) return;

    this.corePos = new THREE.Vector3(def.core.x, 0, def.core.z);
    this.turretSlots = def.turretSlots || [];
    this.barricadeSlots = def.barricadeSlots || [];
    this._buildCore();
    for (const w of def.weapons || []) this._buildSceneWeapon(w);
    this._buildSlotMarkers();
  }

  setUI(ui) {
    this.ui = ui;
    this._syncUI(true);
  }

  // ---------------- 构建 ----------------
  _buildCore() {
    const g = new THREE.Group();
    g.position.copy(this.corePos);

    const baseMat = new THREE.MeshStandardMaterial({ color: 0x394049, roughness: 0.7, metalness: 0.45 });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.4, 0.7, 16), baseMat);
    base.position.y = 0.35;
    base.castShadow = true;
    base.receiveShadow = true;
    g.add(base);

    const pillarMat = new THREE.MeshStandardMaterial({ color: 0x565f6a, roughness: 0.5, metalness: 0.6 });
    for (let i = 0; i < 4; i++) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.28, 1.4, 0.28), pillarMat);
      const a = (i / 4) * Math.PI * 2;
      p.position.set(Math.cos(a) * 1.5, 1.1, Math.sin(a) * 1.5);
      p.castShadow = true;
      g.add(p);
    }

    this.coreMat = new THREE.MeshStandardMaterial({
      color: 0x7fe0c8, emissive: 0x2fd0b0, emissiveIntensity: 1.2,
      roughness: 0.25, metalness: 0.35,
    });
    const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.78, 1), this.coreMat);
    orb.position.y = 2.05;
    orb.castShadow = true;
    this.coreOrb = orb;
    g.add(orb);

    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x5fe6cc, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.35, 1.6, 28), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.74;
    this.coreRing = ring;
    g.add(ring);

    this.coreLight = new THREE.PointLight(0x54e6c8, 0.9, 14, 2);
    this.coreLight.position.set(0, 2.4, 0);
    g.add(this.coreLight);

    this.group.add(g);
    this.coreRoot = g;
    // 核心基座给一点碰撞，避免玩家站进去穿模
    this._addedBoxes.push(this.collision.addBox(this.corePos.x, 0.45, this.corePos.z, 3.6, 0.9, 3.6, 'core'));
  }

  /** 记录本模块新增的碰撞盒，切模式时精确移除（不影响地图碰撞） */
  _addCollisionBox(cx, cy, cz, sx, sy, sz, tag) {
    const box = this.collision.addBox(cx, cy, cz, sx, sy, sz, tag);
    this._addedBoxes.push(box);
    return box;
  }

  _removeBox(box) {
    const i = this.collision.boxes.indexOf(box);
    if (i >= 0) this.collision.boxes.splice(i, 1);
    const j = this._addedBoxes.indexOf(box);
    if (j >= 0) this._addedBoxes.splice(j, 1);
  }

  _buildSlotMarkers() {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffb020, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false,
    });
    for (const s of this.turretSlots) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1.0, 20), mat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(s.x, 0.03, s.z);
      this.group.add(ring);
    }
  }

  _buildSceneWeapon(def) {
    const cfg = SCENE_WEAPONS[def.type];
    if (!cfg) return;
    const root = new THREE.Group();
    root.position.set(def.x, 0, def.z);
    root.rotation.y = def.yaw || 0;

    const dark = new THREE.MeshStandardMaterial({ color: 0x3a424b, roughness: 0.52, metalness: 0.62 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x6b7684, roughness: 0.4, metalness: 0.75 });
    const accent = new THREE.MeshStandardMaterial({ color: 0xffb020, roughness: 0.5, metalness: 0.3, emissive: 0x6b4400, emissiveIntensity: 0.6 });

    if (def.type === 'cannon') {
      const base = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.6, 1.7), dark);
      base.position.y = 0.3;
      root.add(base);
      const turret = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.72, 0.62, 14), steel);
      turret.position.y = 0.92;
      root.add(turret);
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 2.4, 12), dark);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, 1.0, -1.25);
      root.add(barrel);
      const brake = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.34, 0.4), accent);
      brake.position.set(0, 1.0, -2.35);
      root.add(brake);
    } else if (def.type === 'mg') {
      const legGeo = new THREE.BoxGeometry(0.12, 1.1, 0.12);
      for (let i = 0; i < 3; i++) {
        const leg = new THREE.Mesh(legGeo, dark);
        const a = (i / 3) * Math.PI * 2;
        leg.position.set(Math.cos(a) * 0.42, 0.55, Math.sin(a) * 0.42);
        leg.rotation.z = Math.cos(a) * 0.28;
        root.add(leg);
      }
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.42, 0.9), steel);
      body.position.set(0, 1.05, -0.1);
      root.add(body);
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.1, 1.5, 10), dark);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, 1.08, -1.0);
      root.add(barrel);
      const mag = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.5, 0.3), accent);
      mag.position.set(0, 0.72, 0.1);
      root.add(mag);
    } else {
      // 移动喷火器：燃料罐 + 喷嘴
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 1.0, 14), accent);
      tank.position.set(0, 0.55, 0.18);
      root.add(tank);
      const pack = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.7, 0.5), dark);
      pack.position.set(0, 0.42, -0.2);
      root.add(pack);
      const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 1.15, 10), steel);
      nozzle.rotation.x = Math.PI / 2;
      nozzle.position.set(0, 1.05, -0.85);
      root.add(nozzle);
      const flame = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff8a2a }));
      flame.position.set(0, 1.05, -1.45);
      root.add(flame);
    }

    root.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    this.group.add(root);

    const eyeWorld = root.localToWorld(new THREE.Vector3(0, cfg.eyeHeight, cfg.eyeZ));
    const barrelWorld = root.localToWorld(new THREE.Vector3(0, cfg.eyeHeight, -1.5));
    this.weapons.push({
      type: def.type,
      cfg,
      root,
      def: { ...def },
      pos: new THREE.Vector3(def.x, 0, def.z),
      eyeWorld,
      barrelWorld,
      ammo: cfg.ammoMax,
      heat: 0,
      cooldown: 0,
      overheated: false,
      removable: def.type === 'flamer',
    });
  }

  // ---------------- 交互 ----------------
  get isMounted() { return !!this.mounted; }
  get isCarrying() { return !!this.carrying; }

  /** 最近的可交互场景武器 */
  _nearestWeapon(pos, radius = 2.8) {
    let best = null;
    for (const w of this.weapons) {
      if (this.mounted && w !== this.mounted) continue;
      const d = Math.hypot(w.pos.x - pos.x, w.pos.z - pos.z);
      if (d <= radius && (!best || d < best.d)) best = { w, d };
    }
    return best ? best.w : null;
  }

  /** HUD 交互提示文案（没有可交互目标时返回 null） */
  interactHint() {
    if (!this.active || this.player.dead) return null;
    if (this.mounted) return `按 F 离开${this.mounted.cfg.name}`;
    if (this.carrying) return '按 F 放下喷火器';
    const w = this._nearestWeapon(this.player.position);
    if (!w) return null;
    return w.removable ? `按 F 拾取${w.cfg.name}` : `按 F 操作${w.cfg.name}`;
  }

  /** F 键交互：上机 / 下机 / 拾取 / 放下。返回是否处理了本次按键 */
  tryInteract() {
    if (!this.active || this.player.dead) return false;
    if (this.mounted) { this.dismount(); return true; }
    if (this.carrying) { this._dropCarried(); return true; }

    const w = this._nearestWeapon(this.player.position);
    if (!w) return false;
    if (w.removable) this._pickUp(w);
    else this.mount(w);
    return true;
  }

  mount(w) {
    this.mounted = w;
    this._prevPos.copy(this.player.position);
    this.player.position.copy(w.pos);
    this.player.velocity.set(0, 0, 0);
    this.camera.position.copy(w.eyeWorld);
    this.weaponView.pivot.visible = false;
    this.gun.setMouseDown(false);
    this.gun.setAiming(false);
    this.camera.fov = 75;
    this.camera.updateProjectionMatrix();
    this._toast(`已上机：${w.cfg.name}`, '左键开火 · F 离开');
  }

  dismount() {
    if (!this.mounted) return;
    this.mounted = null;
    this.player.position.copy(this._prevPos);
    this.weaponView.pivot.visible = true;
    this._toast('已离开场景武器', '继续使用枪械作战');
  }

  _pickUp(w) {
    this.carrying = w;
    w.root.visible = false;
    this.weaponView.pivot.visible = false;
    this.gun.setMouseDown(false);
    this.camera.fov = 75;
    this.camera.updateProjectionMatrix();
    this._toast(`已携带：${w.cfg.name}`, '左键喷射 · F 放下');
  }

  _dropCarried() {
    const w = this.carrying;
    this.carrying = null;
    w.root.visible = true;
    w.pos.copy(this.player.position);
    w.root.position.copy(w.pos);
    w.eyeWorld = w.root.localToWorld(new THREE.Vector3(0, w.cfg.eyeHeight, w.cfg.eyeZ));
    w.barrelWorld = w.root.localToWorld(new THREE.Vector3(0, w.cfg.eyeHeight, -1.5));
    this.weaponView.pivot.visible = true;
    this._toast('已放下喷火器', `按 F 再次拾取`);
  }

  // ---------------- 每帧 ----------------
  update(dt) {
    if (!this.active) return;
    this._updateCore(dt);
    this._updateWeapons(dt);
    this._updateTurrets(dt);
    this._updateBots(dt);

    this._syncTimer += dt;
    if (this._syncTimer >= 0.12) {
      this._syncTimer = 0;
      this._syncUI();
    }
  }

  _updateCore(dt) {
    if (this.coreDestroyed) return;
    this.coreOrb.position.y = 2.05 + Math.sin(performance.now() / 620) * 0.06;
    this.coreOrb.rotation.y += dt * 0.5;
    this.coreRing.rotation.z += dt * 0.4;

    let attackers = 0;
    for (const e of this.enemies.enemies) {
      if (!e || e.dead || !e.root.visible) continue;
      const d = Math.hypot(e.position.x - this.corePos.x, e.position.z - this.corePos.z);
      if (d <= DEFENSE.coreRadius) attackers += 1;
    }
    if (attackers > 0) {
      this.coreHp = Math.max(0, this.coreHp - DEFENSE.coreDamageDps * attackers * dt);
      this.coreMat.emissiveIntensity = 1.2 + Math.sin(performance.now() / 90) * 0.5;
      if (this.coreHp <= 0) this._destroyCore();
    } else {
      this.coreMat.emissiveIntensity += (1.2 - this.coreMat.emissiveIntensity) * Math.min(1, dt * 6);
    }
  }

  _destroyCore() {
    if (this.coreDestroyed) return;
    this.coreDestroyed = true;
    this.coreMat.color.setHex(0x30363c);
    this.coreMat.emissive.setHex(0x000000);
    this.coreMat.emissiveIntensity = 0;
    this.coreLight.intensity = 0.15;
    this.coreLight.color.setHex(0xff5a2a);
    if (this.effects) this.effects.spawnExplosion(this.corePos.clone().setY(2), 6);
    if (this.audio) this.audio.play('fire2', { volume: 1, rate: 0.22 });
    if (this.player && this.player.position.distanceTo(this.corePos) < 9) {
      this.player.takeDamage(60);
    }
    this._syncUI(true);
    this.onCoreDestroyed();
  }

  _updateWeapons(dt) {
    for (const w of this.weapons) {
      if (w.cooldown > 0) w.cooldown -= dt;
      if (w !== this.mounted && w !== this.carrying) {
        // 非操作状态自然降温
        w.heat = Math.max(0, w.heat - w.cfg.coolRate * dt);
        if (w.overheated && w.heat <= 45) w.overheated = false;
      }
    }
  }

  /** 上机武器每帧：移动相机到炮位、处理开火 */
  updateMounted(dt, fireHeld, firePressed) {
    const w = this.mounted;
    if (!w) return;
    this.camera.position.copy(w.eyeWorld);

    if (w.cooldown > 0) w.cooldown -= dt;
    w.heat = Math.max(0, w.heat - w.cfg.coolRate * dt);
    if (w.overheated && w.heat <= 45) {
      w.overheated = false;
      this._toast(`${w.cfg.name} 已降温`, '可以继续开火');
    }
    if (this._syncTimer >= 0.12) { /* UI 由 update 统一刷新 */ }

    const wants = w.cfg.auto ? (fireHeld || firePressed) : firePressed;
    if (wants) this._fireSceneWeapon(w);
  }

  _fireSceneWeapon(w) {
    if (w.overheated || w.ammo <= 0 || w.cooldown > 0) {
      if (w.wasTriggered !== true) {
        w.wasTriggered = true;
        if (w.ammo <= 0) this._toast(`${w.cfg.name} 弹药耗尽`, '按 TAB 打开战地军需补给');
        else if (w.overheated) this._toast(`${w.cfg.name} 过热`, '松开扳机等待降温');
      }
      return;
    }
    w.wasTriggered = false;
    w.cooldown = w.cfg.cooldown;
    w.ammo -= 1;
    w.heat = Math.min(w.cfg.heatMax, w.heat + w.cfg.heatPerShot);
    if (w.heat >= w.cfg.heatMax) w.overheated = true;

    const origin = this.camera.position.clone();
    const dir = this.camera.getWorldDirection(this._tmpDir).clone();
    const wall = this.collision.raycast(origin, dir, 70);
    const maxDist = wall ? wall.distance : 70;
    const hit = this.enemies.raycast(origin, dir, maxDist);
    let point = origin.clone().addScaledVector(dir, maxDist);
    if (hit && (!wall || hit.distance < wall.distance)) {
      const killed = hit.enemy.takeDamage(w.cfg.damage, hit.head);
      if (this.effects) this.effects.spawnEnemyHit(hit.point);
      if (this.hud) this.hud.showHitmarker(killed, hit.head);
      if (w.cfg.splashRadius) this._splash(hit.point, w.cfg.splashRadius, w.cfg.splashDamage, hit.enemy);
      point = hit.point;
    } else if (wall) {
      if (this.effects) this.effects.spawnImpact(wall.point, wall.normal);
      if (w.cfg.splashRadius) this._splash(wall.point, w.cfg.splashRadius, w.cfg.splashDamage, null);
    }

    const muzzle = w.barrelWorld;
    if (this.effects) {
      this.effects.spawnTracer(muzzle, point, 1.0, 0xffd889);
      if (w.cfg.splashRadius) this.effects.spawnExplosion(point, w.cfg.splashRadius);
    }
    if (this.audio) {
      this.audio.play('fire2', { volume: 0.9, rate: w.type === 'cannon' ? 0.5 : 0.95 });
    }
  }

  _splash(point, radius, damage, exclude) {
    for (const e of this.enemies.enemies) {
      if (!e || e.dead || !e.root.visible || e === exclude) continue;
      if (e.position.distanceTo(point) > radius) continue;
      e.takeDamage(damage);
      if (this.effects) this.effects.spawnEnemyHit(e.position.clone().setY(1));
    }
  }

  /** 携带喷火器每帧：扇形持续灼烧 */
  updateCarried(dt, fireHeld, firePressed) {
    const w = this.carrying;
    if (!w) return;
    w.heat = Math.max(0, w.heat - w.cfg.coolRate * dt);
    if (w.overheated && w.heat <= 45) w.overheated = false;
    const wants = fireHeld || firePressed;
    if (!wants || w.overheated || w.ammo <= 0) return;

    w.ammo = Math.max(0, w.ammo - 3.2 * dt);
    w.heat = Math.min(w.cfg.heatMax, w.heat + 26 * dt);
    if (w.heat >= w.cfg.heatMax) w.overheated = true;

    const origin = this.camera.position.clone();
    const fwd = this.camera.getWorldDirection(this._tmpDir).clone();
    const flat = new THREE.Vector3(fwd.x, 0, fwd.z);
    if (flat.lengthSq() < 1e-4) flat.set(0, 0, -1);
    flat.normalize();

    let hitAny = false;
    for (const e of this.enemies.enemies) {
      if (!e || e.dead || !e.root.visible) continue;
      const to = new THREE.Vector3(
        e.position.x - origin.x, 1.0 - origin.y, e.position.z - origin.z
      );
      const dist = to.length();
      if (dist > w.cfg.range) continue;
      to.normalize();
      if (to.x * flat.x + to.z * flat.z < w.cfg.cosAngle) continue;
      e.takeDamage(w.cfg.damage * dt);
      e.applyStatus('burn', 1.2, w.cfg.damage * 0.6);
      hitAny = true;
    }

    this._flameTimer += dt;
    this._flameSfxTimer += dt;
    if (this._flameTimer > 0.07 && this.effects) {
      this._flameTimer = 0;
      const end = origin.clone().addScaledVector(fwd, w.cfg.range * 0.9);
      this.effects.spawnTracer(origin, end, 0.55, 0xff8a2a);
      if (hitAny) this.effects.spawnExplosion(origin.clone().addScaledVector(fwd, 2.2), 0.9);
    }
    if (this.audio && this._flameSfxTimer > 0.28) {
      this._flameSfxTimer = 0;
      this.audio.play('fire2', { volume: 0.45, rate: 0.32 });
    }
  }

  // ---------------- 炮塔 / 人机 ----------------
  _updateTurrets(dt) {
    for (const t of this.turrets) {
      if (t.cooldown > 0) t.cooldown -= dt;
      const target = this._nearestEnemy(t.root.position, DEFENSE.turretRange);
      if (!target) continue;
      const dx = target.position.x - t.root.position.x;
      const dz = target.position.z - t.root.position.z;
      t.head.rotation.y = Math.atan2(-dx, -dz);
      if (t.cooldown > 0) continue;
      t.cooldown = DEFENSE.turretCooldown;
      const from = t.barrel.getWorldPosition(new THREE.Vector3());
      const to = target.position.clone().setY(1.0);
      const dir = to.clone().sub(from);
      const dist = dir.length();
      dir.normalize();
      const wall = this.collision.raycast(from, dir, dist);
      if (wall && wall.distance < dist - 0.2) continue;
      const killed = target.takeDamage(DEFENSE.turretDamage);
      if (this.effects) {
        this.effects.spawnTracer(from, to, 0.9, 0xffe0a0);
        this.effects.spawnEnemyHit(to);
      }
      if (this.audio) this.audio.play('fire1', { volume: 0.45, rate: 1.1 });
      if (killed) { /* 死亡回调由 EnemyManager 统一处理 */ }
    }
  }

  _updateBots(dt) {
    for (const b of this.bots) {
      if (b.cooldown > 0) b.cooldown -= dt;
      const target = this._nearestEnemy(b.root.position, DEFENSE.botRange);
      if (!target) continue;
      const bx = target.position.x - b.root.position.x;
      const bz = target.position.z - b.root.position.z;
      b.root.rotation.y = Math.atan2(-bx, -bz);
      if (b.cooldown > 0) continue;
      b.cooldown = DEFENSE.botCooldown;
      const from = b.root.position.clone().setY(1.35);
      const to = target.position.clone().setY(1.0);
      target.takeDamage(DEFENSE.botDamage);
      if (this.effects) {
        this.effects.spawnTracer(from, to, 0.8, 0x9fd8ff);
        this.effects.spawnEnemyHit(to);
      }
      if (this.audio) this.audio.play('fire2', { volume: 0.4, rate: 1.0 });
    }
  }

  _nearestEnemy(pos, range) {
    let best = null;
    let bestD = range;
    for (const e of this.enemies.enemies) {
      if (!e || e.dead || !e.root.visible) continue;
      const d = Math.hypot(e.position.x - pos.x, e.position.z - pos.z);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  _buildTurret(slot) {
    const root = new THREE.Group();
    root.position.set(slot.x, 0, slot.z);
    const mat = new THREE.MeshStandardMaterial({ color: 0x4c5966, roughness: 0.5, metalness: 0.6 });
    const accent = new THREE.MeshStandardMaterial({ color: 0xffb020, roughness: 0.5, metalness: 0.3, emissive: 0x6b4400, emissiveIntensity: 0.8 });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.68, 0.55, 14), mat);
    base.position.y = 0.28;
    root.add(base);
    const head = new THREE.Group();
    head.position.y = 0.72;
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.42, 0.72), mat);
    head.add(body);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.09, 0.95, 10), accent);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.02, -0.66);
    head.add(barrel);
    root.add(head);
    this.group.add(root);
    this.turrets.push({ root, head, barrel, cooldown: 0 });
  }

  _buildBarricade(slot) {
    const root = new THREE.Group();
    root.position.set(slot.x, 0, slot.z);
    root.rotation.y = slot.rot || 0;
    const mat = new THREE.MeshStandardMaterial({ color: 0x7a7458, roughness: 0.95, metalness: 0.05 });
    for (let i = 0; i < 3; i++) {
      const bag = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.34, 0.62), mat);
      bag.position.set(0, 0.2 + i * 0.32, (i % 2 === 0 ? 0.06 : -0.06));
      bag.castShadow = true;
      bag.receiveShadow = true;
      root.add(bag);
    }
    this.group.add(root);
    this._addCollisionBox(slot.x, 0.55, slot.z, 2.8, 1.1, 0.9, 'barricade');
    this.barricades.push({ root, slot, box: this._addedBoxes[this._addedBoxes.length - 1] });
  }

  _buildBot() {
    const root = new THREE.Group();
    const spots = [new THREE.Vector3(-3.4, 0, 14.2), new THREE.Vector3(3.4, 0, 14.2), new THREE.Vector3(0, 0, 20)];
    const spot = spots[this.bots.length % spots.length];
    root.position.copy(spot);
    const uniform = new THREE.MeshStandardMaterial({ color: 0x3f6b8a, roughness: 0.8, metalness: 0.1 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xc9a985, roughness: 0.9, metalness: 0.0 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.72, 6, 10), uniform);
    body.position.y = 1.0;
    body.castShadow = true;
    root.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 10), skin);
    head.position.y = 1.62;
    head.castShadow = true;
    root.add(head);
    const rifle = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.9), new THREE.MeshStandardMaterial({ color: 0x2c3138, metalness: 0.6, roughness: 0.4 }));
    rifle.position.set(0.24, 1.12, -0.32);
    root.add(rifle);
    this.group.add(root);
    this.bots.push({ root, cooldown: 0.6 });
  }

  // ---------------- 局内金币 / 商店 ----------------
  addGold(n) {
    this.gold += Math.max(0, Math.round(n));
    this._syncUI(true);
  }

  _toast(title, hint) {
    if (this.hud) this.hud.showSupplyToast(title, hint);
  }

  /** 商店条目（含是否买得起 / 是否还有空位） */
  getShopItems() {
    const S = DEFENSE.shop;
    const meta = this.save ? this.save.data.meta : { coins: 0, reputation: 0 };
    const turretFree = this.turretSlots.length - this.turrets.length;
    const barricadeFree = this.barricadeSlots.length - this.barricades.length;
    const canHire = this.bots.length < DEFENSE.maxBots
      && meta.coins >= BOT_HIRE.coins && meta.reputation >= BOT_HIRE.reputation;

    const gold = (n) => `局内金币 ${n}`;
    return [
      {
        id: 'turret', name: '自动炮塔',
        desc: '自动索敌，持续扫射进入领地的丧尸',
        costLabel: gold(S.turret), tip: turretFree > 0 ? `剩余 ${turretFree} 个空位` : '槽位已满',
        disabled: turretFree <= 0, affordable: this.gold >= S.turret && turretFree > 0,
      },
      {
        id: 'barricade', name: '沙袋路障',
        desc: '堵住主路，拖慢尸潮推进',
        costLabel: gold(S.barricade), tip: barricadeFree > 0 ? `剩余 ${barricadeFree} 个空位` : '槽位已满',
        disabled: barricadeFree <= 0, affordable: this.gold >= S.barricade && barricadeFree > 0,
      },
      {
        id: 'repair', name: '修理核心',
        desc: '核心生命 +150',
        costLabel: gold(S.repair), tip: `核心 ${Math.round(this.coreHp)} / ${this.coreMax}`,
        disabled: this.coreHp >= this.coreMax || this.coreDestroyed,
        affordable: this.gold >= S.repair && this.coreHp < this.coreMax && !this.coreDestroyed,
      },
      {
        id: 'resupply', name: '场景武器补给',
        desc: '全部炮位补满弹药并降温',
        costLabel: gold(S.resupply), tip: '岸防炮 / 机枪 / 喷火器',
        disabled: false, affordable: this.gold >= S.resupply,
      },
      {
        id: 'refill', name: '弹药护甲补给',
        desc: '备弹 +60 · 护甲 +20 · 生命 +30',
        costLabel: gold(S.refill), tip: '个人补给',
        disabled: false, affordable: this.gold >= S.refill,
      },
      {
        id: 'hire', name: '雇佣人机',
        desc: '人机会守在核心旁自动射击',
        costLabel: `${BOT_HIRE.coins} 金币 + ${BOT_HIRE.reputation} 声望`, tip: `队友 ${this.bots.length}/${DEFENSE.maxBots}`,
        disabled: this.bots.length >= DEFENSE.maxBots,
        affordable: canHire,
      },
    ];
  }

  getShopState() {
    return {
      gold: this.gold,
      coreHp: this.coreHp,
      coreMax: this.coreMax,
      items: this.getShopItems(),
    };
  }

  /** 购买（返回 { ok, message }） */
  buy(id) {
    const S = DEFENSE.shop;
    switch (id) {
      case 'turret': {
        if (this.turrets.length >= this.turretSlots.length) return { ok: false, message: '炮塔槽位已满' };
        if (this.gold < S.turret) return { ok: false, message: '局内金币不足' };
        this.gold -= S.turret;
        this._buildTurret(this.turretSlots[this.turrets.length]);
        this._syncUI(true);
        return { ok: true, message: '炮塔已部署，自动索敌中' };
      }
      case 'barricade': {
        if (this.barricades.length >= this.barricadeSlots.length) return { ok: false, message: '路障槽位已满' };
        if (this.gold < S.barricade) return { ok: false, message: '局内金币不足' };
        this.gold -= S.barricade;
        this._buildBarricade(this.barricadeSlots[this.barricades.length]);
        this._syncUI(true);
        return { ok: true, message: '路障已布设' };
      }
      case 'repair': {
        if (this.coreDestroyed) return { ok: false, message: '核心已被摧毁' };
        if (this.coreHp >= this.coreMax) return { ok: false, message: '核心完好，无需修理' };
        if (this.gold < S.repair) return { ok: false, message: '局内金币不足' };
        this.gold -= S.repair;
        this.coreHp = Math.min(this.coreMax, this.coreHp + 150);
        this._syncUI(true);
        return { ok: true, message: '核心已修复 +150' };
      }
      case 'resupply': {
        if (this.gold < S.resupply) return { ok: false, message: '局内金币不足' };
        this.gold -= S.resupply;
        for (const w of this.weapons) {
          w.ammo = w.cfg.ammoMax;
          w.heat = 0;
          w.overheated = false;
        }
        this._syncUI(true);
        return { ok: true, message: '场景武器已补满弹药并降温' };
      }
      case 'refill': {
        if (this.gold < S.refill) return { ok: false, message: '局内金币不足' };
        this.gold -= S.refill;
        if (this.gun) this.gun.addSupply(60);
        if (this.player && this.player.health) {
          this.player.health.addArmor(20);
          this.player.health.heal(30);
        }
        this._syncUI(true);
        return { ok: true, message: '补给已投放' };
      }
      case 'hire': {
        if (this.bots.length >= DEFENSE.maxBots) return { ok: false, message: `最多雇佣 ${DEFENSE.maxBots} 名人机` };
        if (!this.save || !this.save.spend({ coins: BOT_HIRE.coins, reputation: BOT_HIRE.reputation })) {
          return { ok: false, message: `需要 ${BOT_HIRE.coins} 金币 + ${BOT_HIRE.reputation} 声望` };
        }
        this._buildBot();
        this._syncUI(true);
        return { ok: true, message: '人机队友已就位' };
      }
      default:
        return { ok: false, message: '未知商品' };
    }
  }

  // ---------------- 复位 / 销毁 ----------------
  resetRun() {
    if (!this.active) return;
    this.coreHp = this.coreMax;
    this.coreDestroyed = false;
    this.coreMat.color.setHex(0x7fe0c8);
    this.coreMat.emissive.setHex(0x2fd0b0);
    this.coreMat.emissiveIntensity = 1.2;
    this.coreLight.color.setHex(0x54e6c8);
    this.coreLight.intensity = 0.9;
    this.gold = 0;

    this.dismount();
    if (this.carrying) this.carrying = null;
    this.weaponView.pivot.visible = true;
    this.camera.fov = 75;
    this.camera.updateProjectionMatrix();

    for (const t of this.turrets) this.group.remove(t.root);
    for (const b of this.barricades) {
      this.group.remove(b.root);
      this._removeBox(b.box);
    }
    for (const b of this.bots) this.group.remove(b.root);
    this.turrets.length = 0;
    this.barricades.length = 0;
    this.bots.length = 0;

    for (const w of this.weapons) {
      w.ammo = w.cfg.ammoMax;
      w.heat = 0;
      w.cooldown = 0;
      w.overheated = false;
      w.root.visible = true;
      w.root.position.set(w.def.x, 0, w.def.z);
      w.pos.set(w.def.x, 0, w.def.z);
      w.eyeWorld = w.root.localToWorld(new THREE.Vector3(0, w.cfg.eyeHeight, w.cfg.eyeZ));
      w.barrelWorld = w.root.localToWorld(new THREE.Vector3(0, w.cfg.eyeHeight, -1.5));
    }
    this._syncUI(true);
  }

  _syncUI(force = false) {
    if (!this.ui) return;
    this.ui.setCore(this.coreHp, this.coreMax);
    this.ui.setGold(this.gold);
    const active = this.mounted || this.carrying;
    if (active) {
      const w = this.mounted || this.carrying;
      this.ui.setWeapon({
        name: w.cfg.name,
        ammo: w.ammo,
        ammoMax: w.cfg.ammoMax,
        heat: w.heat,
        heatMax: w.cfg.heatMax,
        overheated: w.overheated,
        hint: this.mounted ? '上机状态 · F 离开' : '携带状态 · F 放下',
      });
    } else if (force || this.ui.weaponVisible) {
      this.ui.setWeapon(null);
    }
  }

  dispose() {
    if (!this.active) return;
    if (this.mounted) this.dismount();
    this.group.traverse((o) => {
      if (o.isMesh) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
          else o.material.dispose();
        }
      }
    });
    this.scene.remove(this.group);
    for (const box of this._addedBoxes.slice()) this._removeBox(box);
    this.active = false;
  }
}
