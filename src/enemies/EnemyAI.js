/**
 * 丧尸 AI（v0.3 改造：武装人员 → 丧尸）
 *
 * 状态机：巡逻 → 发现玩家 → 追击 → 攻击 → 死亡
 *   普通丧尸 / 重锤丧尸：近战扑咬（前摇 windup → 范围判定 → 伤害），**没有任何枪械**。
 *   吐酸丧尸：中距离喷吐酸液（非枪械弹道，只做视觉抛物线 + 命中判定）。
 *
 * 同时负责：骨骼动画、受击红闪、血条、命中检测（供玩家射击）。
 */
import * as THREE from 'three';
import { clone as cloneSkeleton } from '../../vendor/three/utils/SkeletonUtils.js';
import { ENEMY } from '../config/weapon.js';

const SPHERE = { body: 0.42, head: 0.22, limb: 0.28 };

export class EnemyAI {
  constructor(opts) {
    this.scene = opts.scene;
    this.assets = opts.assets;
    this.collision = opts.collision;
    this.audio = opts.audio;
    this.player = opts.player;
    this.spawn = opts.spawn.clone();
    this.index = opts.index;
    this.onDeath = opts.onDeath || (() => {});
    this.onSpit = opts.onSpit || (() => {});       // 吐酸弹道视觉
    this.onMelee = opts.onMelee || (() => {});     // 近战挥击视觉/音效
    this.onPlayerHit = opts.onPlayerHit || (() => {});

    this.position = opts.spawn.clone();
    this.velocity = new THREE.Vector3();
    this.heading = Math.random() * Math.PI * 2;
    this.targetHeading = this.heading;
    this.state = 'patrol';               // patrol / alert / chase / attack
    this.dead = false;
    this.deadTimer = 0;
    this.flashTimer = 0;
    this.flinchTimer = 0;
    this.attackTimer = 0;                // 攻击冷却
    this.windupTimer = 0;                // 近战前摇剩余（>0 表示正在抬手）
    this.windupDone = false;
    this.coverTimer = 1.0;
    this.coverStrafe = 0;
    this.coverSign = 1;
    this.alertTimer = 0;
    this.baseScanHeading = this.heading;
    this.scanTime = 0;
    this.lastKnown = new THREE.Vector3();
    this.avoidTimer = 0;
    this.avoidSign = 1;
    this.stuckTimer = 0;
    this.targetPoint = this._pickPatrolPoint();
    this.lastPos = this.position.clone();

    // 波次倍率（EnemyManager.configure 注入）
    this.healthMul = 1;
    this.damageMul = 1;
    this.accuracyMul = 1;
    this.speedMul = 1;

    // 丧尸变体（默认普通丧尸；configure 会按波次 mix 指定）
    this.setVariant('walker');

    this._tmpEye = new THREE.Vector3();
    this._tmpTarget = new THREE.Vector3();

    this._buildModel();
    this._buildHealthBar();
  }

  /** 设定丧尸变体（walker / spitter / brute），重建数值基准 */
  setVariant(id) {
    const v = ENEMY.types[id] || ENEMY.types.walker;
    this.variant = v;
    this.variantId = v.id;
    this.melee = v.melee !== false;      // 只有 spitter 是远程喷吐
    this.maxHealth = v.maxHealth * this.healthMul;
    this.health = this.maxHealth;
    if (this.materials) {
      for (const m of this.materials) m.color.setHex(v.tint || 0xffffff);
    }
  }

  /** 波次开始前注入难度倍率（血量 / 伤害 / 精度 / 移速） */
  configure(cfg = {}) {
    this.healthMul = cfg.healthMul ?? 1;
    this.damageMul = cfg.damageMul ?? 1;
    this.accuracyMul = cfg.accuracyMul ?? 1;
    this.speedMul = cfg.speedMul ?? 1;
    if (cfg.variant) this.setVariant(cfg.variant);
    else {
      this.maxHealth = this.variant.maxHealth * this.healthMul;
      this.health = this.maxHealth;
    }
  }

  // ---------------- 模型 ----------------
  _buildModel() {
    this.root = new THREE.Group();
    this.root.position.copy(this.position);
    this.scene.add(this.root);

    const src = this.assets && this.assets.zombieModel;
    if (!src) {
      const mesh = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.35, 1.1, 4, 8),
        new THREE.MeshStandardMaterial({ color: 0x8a2b2b })
      );
      mesh.position.y = 0.9;
      this.root.add(mesh);
      this.materials = [mesh.material];
      this.animations = {};
      return;
    }

    const model = cloneSkeleton(src);
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const scale = (ENEMY.height / Math.max(size.y, 0.001)) * (this.variant.scaleMul || 1);
    model.scale.setScalar(scale);
    const box2 = new THREE.Box3().setFromObject(model);
    const center = box2.getCenter(new THREE.Vector3());
    model.position.set(-center.x, -box2.min.y, -center.z);
    this.root.add(model);
    this.model = model;

    // 丧尸贴图 + 变体染色；每个敌人独立材质，便于受击红闪
    const tex = this.assets.textures && this.assets.textures.zombie;
    if (tex) {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
    }
    this.materials = [];
    const tint = this.variant.tint || 0xffffff;
    model.traverse((o) => {
      if (o.isMesh) {
        const mat = new THREE.MeshStandardMaterial({
          map: tex || null,
          color: tex ? tint : 0x7c3a3a,
          roughness: 0.92,
          metalness: 0.02,
        });
        o.material = mat;
        o.frustumCulled = false;
        o.castShadow = true;
        o.receiveShadow = false;
        this.materials.push(mat);
      }
    });

    // 动画
    this.mixer = new THREE.AnimationMixer(model);
    this.actions = {};
    const clips = this.assets.anims || {};
    const map = { idle: 'idle', walk: 'walk', run: 'run', attack: 'attack', death: 'death' };
    for (const [key, clip] of Object.entries(map)) {
      const c = clips[clip];
      if (!c) continue;
      const action = this.mixer.clipAction(c);
      action.enabled = true;
      this.actions[key] = action;
    }
    this._play('idle');
  }

  _play(name, once = false) {
    const action = this.actions && this.actions[name];
    if (!action || this.currentAnim === name) return;
    if (this.currentAction) this.currentAction.fadeOut(0.18);
    action.reset();
    action.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
    action.clampWhenFinished = once;
    action.fadeIn(0.18).play();
    this.currentAction = action;
    this.currentAnim = name;
  }

  // ---------------- 血条 ----------------
  _buildHealthBar() {
    this.barCanvas = document.createElement('canvas');
    this.barCanvas.width = 128;
    this.barCanvas.height = 20;
    this.barTex = new THREE.CanvasTexture(this.barCanvas);
    this.barTex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: this.barTex, transparent: true, depthTest: false });
    this.bar = new THREE.Sprite(mat);
    this.bar.scale.set(0.92, 0.14, 1);
    this.bar.position.set(0, ENEMY.height + 0.3, 0);
    this.bar.renderOrder = 5;
    this.root.add(this.bar);
    this._updateBar();
  }

  _updateBar() {
    const ctx = this.barCanvas.getContext('2d');
    const w = 128, h = 20;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
    const ratio = Math.max(0, this.health / Math.max(1, this.maxHealth));
    const color = ratio > 0.5 ? '#e23b2e' : ratio > 0.22 ? '#ff8a2b' : '#ff2b2b';
    ctx.fillStyle = color;
    ctx.fillRect(2, 2, (w - 4) * ratio, h - 4);
    this.barTex.needsUpdate = true;
    this.bar.visible = this.health < this.maxHealth && !this.dead;
  }

  // ---------------- 感知 ----------------
  _canSeePlayer() {
    if (!this.player || this.player.dead) return false;
    const eye = this.position.clone();
    eye.y += 1.55;
    const target = this.player.camera.position.clone();
    const dist = eye.distanceTo(target);
    if (dist > ENEMY.sightRange) return false;

    const dir = target.clone().sub(eye).normalize();
    const forward = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    if (dir.dot(forward) < ENEMY.sightAngle) return false;

    return this.collision.lineOfSight(eye, target);
  }

  _pickPatrolPoint() {
    const pts = ENEMY.patrolPoints;
    let p;
    do {
      p = pts[Math.floor(Math.random() * pts.length)];
    } while (Math.hypot(p.x - this.position.x, p.z - this.position.z) < 2);
    return new THREE.Vector3(p.x, 0, p.z);
  }

  // ---------------- 主更新 ----------------
  update(dt) {
    if (this.mixer) this.mixer.update(dt);

    // 受击红闪
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      const k = Math.max(0, this.flashTimer / 0.15);
      for (const m of this.materials) {
        m.emissive.setRGB(k * 0.9, 0, 0);
      }
      if (this.flashTimer <= 0) {
        for (const m of this.materials) m.emissive.setRGB(0, 0, 0);
      }
    }

    if (this.dead) {
      this.deadTimer -= dt;
      if (this.deadTimer <= 1) {
        const k = Math.max(0, this.deadTimer);
        for (const m of this.materials) {
          m.transparent = true;
          m.opacity = k;
        }
      }
      if (this.deadTimer <= 0) this.root.visible = false;
      return;
    }

    if (this.attackTimer > 0) this.attackTimer -= dt;
    if (this.flinchTimer > 0) this.flinchTimer -= dt;

    const sees = this._canSeePlayer();
    const distToPlayer = this.player
      ? Math.hypot(this.player.position.x - this.position.x, this.player.position.z - this.position.z)
      : Infinity;

    // 状态切换
    if (sees) {
      this.lastKnown.copy(this.player.position);
      this.alertTimer = ENEMY.alertTime;
      this.state = distToPlayer <= this.variant.attackRange ? 'attack' : 'chase';
      this.loseSightTimer = 0;
    } else if (this.state === 'attack' || this.state === 'chase' || this.state === 'alert') {
      if (this.state !== 'alert') {
        this.state = 'alert';
        this.alertTimer = ENEMY.alertTime;
        this.baseScanHeading = this.heading;
        this.scanTime = 0;
      }
      this.alertTimer -= dt;
      if (this.alertTimer <= 0) {
        this.state = 'patrol';
        this.targetPoint = this._pickPatrolPoint();
      }
    } else {
      this.state = 'patrol';
      this.loseSightTimer = 0;
    }

    if (this.state === 'patrol') this._updatePatrol(dt);
    else if (this.state === 'alert') this._updateAlert(dt);
    else if (this.state === 'chase') this._updateChase(dt, distToPlayer);
    else if (this.state === 'attack') this._updateAttack(dt, distToPlayer);

    // 平滑转头，受击时附加抖动
    const turnDelta = shortestAngle(this.targetHeading - this.heading);
    this.heading += turnDelta * Math.min(1, ENEMY.turnSpeed * dt);

    // 物理移动
    this.velocity.y += -16 * dt;
    this.collision.moveCharacter(this.position, this.velocity, dt, ENEMY.radius, ENEMY.height);

    this.root.position.copy(this.position);
    const flinchK = this.flinchTimer > 0 ? this.flinchTimer / ENEMY.flinchTime : 0;
    this.root.rotation.y = this.heading + Math.sin(this.flinchTimer * 70) * 0.22 * flinchK;
    this.bar.position.set(0, ENEMY.height + 0.3, 0);
    this._checkStuck(dt);
  }

  _updatePatrol(dt) {
    const target = this.targetPoint;
    const dx = target.x - this.position.x;
    const dz = target.z - this.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1.2) {
      this.targetPoint = this._pickPatrolPoint();
      return;
    }
    this._moveToward(dx, dz, this.variant.patrolSpeed, dt);
    this._play('walk');
  }

  _updateAlert(dt) {
    const dx = this.lastKnown.x - this.position.x;
    const dz = this.lastKnown.z - this.position.z;
    const dist = Math.hypot(dx, dz);
    this.scanTime += dt;
    if (dist > 1.6) {
      this._moveToward(dx, dz, this.variant.chaseSpeed * 0.7, dt);
      this._play('walk');
    } else {
      this.velocity.x *= 0.85;
      this.velocity.z *= 0.85;
      this.targetHeading = this.baseScanHeading + Math.sin(this.scanTime * 2.2) * 0.9;
      this._play('walk');
    }
  }

  _updateChase(dt, dist) {
    if (!this.player) return;
    const dx = this.player.position.x - this.position.x;
    const dz = this.player.position.z - this.position.z;
    // 丧尸永远朝玩家逼近（近战）；吐酸丧尸逼近到舒适距离即停
    const keep = this.melee ? this.variant.keepDistance : this.variant.keepDistance;
    if (dist > keep) {
      this._moveToward(dx, dz, this.variant.chaseSpeed, dt);
    } else {
      this.velocity.x *= 0.8;
      this.velocity.z *= 0.8;
      this.targetHeading = Math.atan2(dx, dz);
    }
    this._play('run');
  }

  _updateAttack(dt, dist) {
    if (!this.player) return;
    const dx = this.player.position.x - this.position.x;
    const dz = this.player.position.z - this.position.z;
    const v = this.variant;

    // 近战丧尸：贴近玩家后挥击
    if (this.melee) {
      if (dist > v.attackRange * 0.85) {
        this._moveToward(dx, dz, v.chaseSpeed, dt);
      } else {
        this.velocity.x *= 0.75;
        this.velocity.z *= 0.75;
        // 绕着玩家缓慢侧移，避免完全站桩
        this.coverTimer -= dt;
        if (this.coverTimer <= 0) {
          this.coverTimer = 1.8 + Math.random() * 1.4;
          this.coverSign = Math.random() < 0.5 ? -1 : 1;
        }
        const px = -dz * this.coverSign * 0.35;
        const pz = dx * this.coverSign * 0.35;
        this._moveToward(px, pz, v.patrolSpeed * 0.6, dt);
      }
      this.targetHeading = Math.atan2(dx, dz);

      // 前摇 → 判定 两段式攻击
      if (this.windupTimer > 0) {
        this.windupTimer -= dt;
        if (this.windupTimer <= 0 && !this.windupDone) {
          this.windupDone = true;
          this._meleeStrike(dist);
        }
      } else if (this.attackTimer <= 0 && dist <= v.attackRange) {
        this.windupTimer = v.windup;
        this.windupDone = false;
        this.attackTimer = v.attackInterval;
        this.onMelee(this);
        this.currentAnim = null;          // 允许 attack 动画重新播放
        this._play('attack', true);
      } else {
        this._play('run');
      }
      return;
    }

    // 吐酸丧尸：保持距离 + 定期喷吐
    if (dist < v.keepDistance * 0.8) {
      this._moveToward(-dx, -dz, v.chaseSpeed * 0.85, dt);
    } else if (dist > v.attackRange * 0.9) {
      this._moveToward(dx, dz, v.chaseSpeed, dt);
    } else {
      this.velocity.x *= 0.85;
      this.velocity.z *= 0.85;
    }
    this.targetHeading = Math.atan2(dx, dz);

    if (this.attackTimer <= 0 && dist <= v.attackRange) {
      this.attackTimer = v.attackInterval * (0.85 + Math.random() * 0.4);
      this._spit(dist);
      this.currentAnim = null;
      this._play('attack', true);
    } else {
      this._play('run');
    }
  }

  /** 近战判定：前摇结束时玩家仍在触及范围（允许一点容错）则造成伤害 */
  _meleeStrike(dist) {
    if (!this.player || this.player.dead) return;
    const reach = this.variant.attackRange * 1.25;
    if (dist > reach) return;   // 玩家已逃出挥击范围
    const dealt = this.player.takeDamage(this.variant.damage * this.damageMul);
    if (dealt > 0) this.onPlayerHit(dealt);
  }

  /**
   * 吐酸（非枪械）：酸液抛物线视觉 + 命中率随距离衰减。
   * 与枪械完全分离：不消耗弹药、不产生弹壳、不走 GunSystem 通道。
   */
  _spit(dist) {
    if (!this.player || this.player.dead) return;
    const origin = this.position.clone();
    origin.y += 1.5;
    const target = this.player.camera.position.clone();

    const v = this.variant;
    const t = Math.min(1, dist / (v.accuracyRange || 30));
    const chance = Math.min(0.9,
      Math.max(v.accuracyMin, v.accuracy * (1 - t)) * this.accuracyMul);

    const hit = Math.random() < chance;
    const end = target.clone();
    if (!hit) {
      const missScale = 0.8 + t * 1.8;
      end.x += (Math.random() - 0.5) * missScale;
      end.y += (Math.random() - 0.5) * missScale * 0.7;
      end.z += (Math.random() - 0.5) * missScale;
    }

    this.onSpit(origin, end, this);
    if (hit) {
      const dealt = this.player.takeDamage(v.damage * this.damageMul);
      if (dealt > 0) this.onPlayerHit(dealt);
    }
  }

  /** 朝目标方向移动（含简单绕障） */
  _moveToward(dx, dz, speed, dt) {
    speed *= this.speedMul;
    const len = Math.hypot(dx, dz);
    if (len < 0.001) return;
    let dirX = dx / len;
    let dirZ = dz / len;

    if (this.avoidTimer > 0) {
      this.avoidTimer -= dt;
      const px = -dirZ * this.avoidSign;
      const pz = dirX * this.avoidSign;
      dirX = px;
      dirZ = pz;
    }

    const desiredX = dirX * speed;
    const desiredZ = dirZ * speed;
    const k = Math.min(1, dt * 8);
    this.velocity.x += (desiredX - this.velocity.x) * k;
    this.velocity.z += (desiredZ - this.velocity.z) * k;
    this.targetHeading = Math.atan2(this.velocity.x, this.velocity.z);
  }

  _checkStuck(dt) {
    const moved = this.position.distanceTo(this.lastPos);
    if (this.state !== 'dead' && moved < 0.01) {
      this.stuckTimer += dt;
      if (this.stuckTimer > 0.5) {
        this.avoidTimer = 0.9;
        this.avoidSign = Math.random() < 0.5 ? -1 : 1;
        this.stuckTimer = 0;
      }
    } else {
      this.stuckTimer = 0;
    }
    this.lastPos.copy(this.position);
  }

  // ---------------- 伤害 ----------------
  takeDamage(amount) {
    if (this.dead) return false;
    this.health -= amount;
    this.flashTimer = 0.15;
    this.flinchTimer = ENEMY.flinchTime;
    if (this.player && !this.player.dead) {
      const dx = this.position.x - this.player.position.x;
      const dz = this.position.z - this.player.position.z;
      const len = Math.hypot(dx, dz) || 1;
      this.velocity.x += (dx / len) * 1.2;
      this.velocity.z += (dz / len) * 1.2;
      this.avoidTimer = 0.5;
      this.avoidSign = Math.random() < 0.5 ? -1 : 1;
      this.lastKnown.copy(this.player.position);
    }
    this._updateBar();

    if (this.state === 'patrol' || this.state === 'alert') {
      if (this.player && !this.player.dead) {
        this.state = 'chase';
        this.alertTimer = ENEMY.alertTime;
      }
      this.loseSightTimer = 0;
    }

    if (this.health <= 0) {
      this.health = 0;
      this._die();
      return true;
    }
    return false;
  }

  _die() {
    this.dead = true;
    this.state = 'dead';
    this.deadTimer = ENEMY.deathBodyTime;
    this.velocity.set(0, 0, 0);
    this.bar.visible = false;
    this.windupTimer = 0;
    this._play('death', true);
    this.onDeath(this);
  }

  /** 重新投放 */
  respawn(spawn) {
    this.spawn.copy(spawn);
    this.position.copy(spawn);
    this.velocity.set(0, 0, 0);
    this.health = this.maxHealth;
    this.dead = false;
    this.deadTimer = 0;
    this.state = 'patrol';
    this.root.visible = true;
    this.attackTimer = 0;
    this.windupTimer = 0;
    this.windupDone = false;
    this.stuckTimer = 0;
    this.loseSightTimer = 0;
    this.flinchTimer = 0;
    this.coverTimer = 1.0;
    this.coverStrafe = 0;
    this.alertTimer = 0;
    this.scanTime = 0;
    this.heading = Math.random() * Math.PI * 2;
    this.targetHeading = this.heading;
    this.targetPoint = this._pickPatrolPoint();
    this.lastPos.copy(this.position);
    for (const m of this.materials) {
      m.opacity = 1;
      m.transparent = false;
    }
    this.bar.visible = false;
    this._updateBar();
    this.currentAnim = null;
    this._play('idle');
  }

  /** 射线与丧尸命中球求交（用于玩家射击）；返回 part: head / body / limb */
  raycast(origin, dir, maxDist) {
    if (this.dead || !this.root.visible) return null;

    const bodyCenter = this.position.clone();
    bodyCenter.y += ENEMY.bodyHeight;
    const headCenter = this.position.clone();
    headCenter.y += ENEMY.headHeight;
    const limbCenter = this.position.clone();
    limbCenter.y += 0.30;

    let best = null;
    const consider = (t, part) => {
      if (t !== null && t <= maxDist && (!best || t < best.t)) best = { t, part };
    };
    consider(raySphere(origin, dir, headCenter, SPHERE.head), 'head');
    consider(raySphere(origin, dir, bodyCenter, SPHERE.body), 'body');
    consider(raySphere(origin, dir, limbCenter, SPHERE.limb), 'limb');
    if (!best) return null;

    return {
      enemy: this,
      distance: best.t,
      part: best.part,
      head: best.part === 'head',
      point: origin.clone().addScaledVector(dir, best.t),
    };
  }
}

/** 角度差归一化到 [-π, π] */
function shortestAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** 射线与球求交，返回最近的正向距离 */
function raySphere(origin, dir, center, radius) {
  const oc = center.clone().sub(origin);
  const t = oc.dot(dir);
  if (t < 0) return null;
  const d2 = oc.lengthSq() - t * t;
  if (d2 > radius * radius) return null;
  const thc = Math.sqrt(radius * radius - d2);
  const t0 = t - thc;
  const t1 = t + thc;
  if (t0 >= 0) return t0;
  if (t1 >= 0) return t1;
  return null;
}
