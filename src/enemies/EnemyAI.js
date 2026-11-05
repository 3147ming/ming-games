/**
 * 敌人 AI（对应仓库 EnemyAiTutorial.cs）
 * 状态机：巡逻 → 发现玩家 → 追击 → 射击 → 死亡 → 重新投放
 * 同时负责：骨骼动画、受击红闪、血条、命中检测。
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
    this.onShoot = opts.onShoot || (() => {});
    this.onPlayerHit = opts.onPlayerHit || (() => {});

    this.position = opts.spawn.clone();
    this.velocity = new THREE.Vector3();
    this.heading = Math.random() * Math.PI * 2;
    this.targetHeading = this.heading;   // 第三轮：平滑转头目标角
    this.state = 'patrol';               // 巡逻 / 警戒 / 追击 / 交火
    this.health = ENEMY.maxHealth;
    this.dead = false;
    this.deadTimer = 0;
    this.flashTimer = 0;
    this.flinchTimer = 0;                // 第三轮：受击抖动
    this.fireTimer = 0;
    this.burstLeft = 0;                  // 第三轮：当前连射/点射剩余发数
    this.burstNear = true;               // 当前射击模式是否为近距离连射
    this.coverTimer = 1.0;               // 第三轮：卡位侧移计时
    this.coverStrafe = 0;                // 侧移剩余时间
    this.coverSign = 1;
    this.alertTimer = 0;                 // 第三轮：警戒搜索剩余时间
    this.baseScanHeading = this.heading; // 警戒原地扫视基准角
    this.scanTime = 0;
    this.lastKnown = new THREE.Vector3();// 玩家最后已知位置
    this.avoidTimer = 0;
    this.avoidSign = 1;
    this.stuckTimer = 0;
    this.ammo = ENEMY.magazineSize;   // 敌人弹匣
    this.reloading = false;
    this.reloadTimer = 0;
    this.targetPoint = this._pickPatrolPoint();
    this.lastPos = this.position.clone();

    this._tmpEye = new THREE.Vector3();
    this._tmpTarget = new THREE.Vector3();

    this._buildModel();
    this._buildHealthBar();
  }

  // ---------------- 模型 ----------------
  _buildModel() {
    this.root = new THREE.Group();
    this.root.position.copy(this.position);
    this.scene.add(this.root);

    const src = this.assets && this.assets.zombieModel;
    if (!src) {
      // 兜底：胶囊体
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
    const scale = ENEMY.height / Math.max(size.y, 0.001);
    model.scale.setScalar(scale);
    const box2 = new THREE.Box3().setFromObject(model);
    const center = box2.getCenter(new THREE.Vector3());
    model.position.set(-center.x, -box2.min.y, -center.z);
    this.root.add(model);
    this.model = model;

    // 统一使用仓库僵尸贴图；每个敌人独立材质，便于受击红闪
    const tex = this.assets.textures && this.assets.textures.zombie;
    if (tex) {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
    }
    this.materials = [];
    model.traverse((o) => {
      if (o.isMesh) {
        const mat = new THREE.MeshStandardMaterial({
          map: tex || null,
          color: tex ? 0xffffff : 0x7c3a3a,
          roughness: 0.9,
          metalness: 0.02,
        });
        o.material = mat;
        o.frustumCulled = false;
        o.castShadow = false;
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
    const ratio = Math.max(0, this.health / ENEMY.maxHealth);
    const color = ratio > 0.5 ? '#e23b2e' : ratio > 0.22 ? '#ff8a2b' : '#ff2b2b';
    ctx.fillStyle = color;
    ctx.fillRect(2, 2, (w - 4) * ratio, h - 4);
    this.barTex.needsUpdate = true;
    this.bar.visible = this.health < ENEMY.maxHealth && !this.dead;
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
      // 尸体停留后淡出
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

    this.fireTimer -= dt;
    // 第三轮：受击抖动计时衰减
    if (this.flinchTimer > 0) this.flinchTimer -= dt;

    // 换弹处理
    if (this.reloading) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) {
        this.reloading = false;
        this.ammo = ENEMY.magazineSize;
      }
    } else if (this.ammo <= 0 && this.state === 'attack') {
      // 弹匣打空且仍在交战：进入换弹
      this.reloading = true;
      this.reloadTimer = ENEMY.reloadTime;
    }

    const sees = this._canSeePlayer();
    const distToPlayer = this.player
      ? Math.hypot(this.player.position.x - this.position.x, this.player.position.z - this.position.z)
      : Infinity;

    // 状态切换：巡逻 patrol / 警戒 alert / 追击 chase / 交火 attack
    if (sees) {
      this.lastKnown.copy(this.player.position);
      this.alertTimer = ENEMY.alertTime;
      this.state = distToPlayer <= ENEMY.attackRange ? 'attack' : 'chase';
      this.loseSightTimer = 0;
    } else if (this.state === 'attack' || this.state === 'chase' || this.state === 'alert') {
      // 丢失视野：先进入警戒（前往最后已知位置搜索），超时后回巡逻
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
        this.burstLeft = 0;
      }
    } else {
      this.state = 'patrol';
      this.loseSightTimer = 0;
    }

    if (this.state === 'patrol') this._updatePatrol(dt);
    else if (this.state === 'alert') this._updateAlert(dt);
    else if (this.state === 'chase') this._updateChase(dt, distToPlayer);
    else if (this.state === 'attack') this._updateAttack(dt, distToPlayer);

    // 第三轮：平滑转头（不再瞬移转头），受击时附加抖动
    const turnDelta = shortestAngle(this.targetHeading - this.heading);
    this.heading += turnDelta * Math.min(1, ENEMY.turnSpeed * dt);

    // 物理移动
    this.velocity.y += -16 * dt;
    this.collision.moveCharacter(this.position, this.velocity, dt, ENEMY.radius, ENEMY.height);

    this.root.position.copy(this.position);
    // 受击抖动：叠加到朝向角上，随时间衰减
    const flinchK = this.flinchTimer > 0 ? this.flinchTimer / ENEMY.flinchTime : 0;
    this.root.rotation.y = this.heading + Math.sin(this.flinchTimer * 70) * 0.22 * flinchK;
    this.bar.position.set(0, ENEMY.height + 0.3, 0);
    this._updateAnimation();
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
    this._moveToward(dx, dz, ENEMY.patrolSpeed, dt);
    this._play('walk');
  }

  /**
   * 第三轮：警戒状态——前往玩家最后已知位置并原地扫视，超时回巡逻
   */
  _updateAlert(dt) {
    const dx = this.lastKnown.x - this.position.x;
    const dz = this.lastKnown.z - this.position.z;
    const dist = Math.hypot(dx, dz);
    this.scanTime += dt;
    if (dist > 1.6) {
      // 前往最后已知位置
      this._moveToward(dx, dz, ENEMY.chaseSpeed * 0.7, dt);
      this._play('walk');
    } else {
      // 已到位置：原地左右扫视搜索
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
    if (dist > ENEMY.keepDistance) {
      this._moveToward(dx, dz, ENEMY.chaseSpeed, dt);
    } else {
      // 距离过近，侧向绕行
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

    // 第三轮：卡位侧移——定期横向绕行，避免站桩被集火
    this.coverTimer -= dt;
    if (this.coverStrafe > 0) {
      this.coverStrafe -= dt;
      const px = -dz * this.coverSign;
      const pz = dx * this.coverSign;
      this._moveToward(px, pz, ENEMY.patrolSpeed * 1.1, dt);
    } else if (this.coverTimer <= 0) {
      // 每 1.6~3.2 秒换一次卡位方向
      this.coverTimer = 1.6 + Math.random() * 1.6;
      this.coverStrafe = 0.5 + Math.random() * 0.7;
      this.coverSign = Math.random() < 0.5 ? -1 : 1;
    } else if (dist < ENEMY.keepDistance * 0.6) {
      // 太近后退
      this._moveToward(-dx, -dz, ENEMY.patrolSpeed, dt);
    } else if (dist > ENEMY.attackRange * 0.85) {
      // 太远前进
      this._moveToward(dx, dz, ENEMY.chaseSpeed, dt);
    } else {
      this.velocity.x *= 0.85;
      this.velocity.z *= 0.85;
    }

    // 交火时始终面向玩家（覆盖 _moveToward 设置的移动朝向）
    this.targetHeading = Math.atan2(dx, dz);

    // 第三轮：按距离切换射击节奏（近连发 / 远点射）
    if (this.fireTimer <= 0 && !this.reloading && this.ammo > 0) {
      if (this.burstLeft <= 0) {
        const near = dist < ENEMY.attackRange * 0.5;
        this.burstNear = near;
        this.burstLeft = near ? ENEMY.burstNear : ENEMY.burstFar;
      }
      this._shoot();
      this.burstLeft -= 1;
      if (this.burstLeft <= 0) {
        // 一轮连射/点射结束，进入较长间隔
        this.fireTimer = this.burstNear
          ? ENEMY.fireIntervalNear + Math.random() * 0.5
          : ENEMY.fireIntervalFar + Math.random() * 0.6;
      } else {
        this.fireTimer = this.burstNear
          ? ENEMY.fireIntervalNear
          : ENEMY.fireIntervalFar * 0.6;
      }
    }
    this._play('attack');
  }

  /** 朝目标方向移动（含简单绕障）；朝向交给 targetHeading 平滑处理 */
  _moveToward(dx, dz, speed, dt) {
    const len = Math.hypot(dx, dz);
    if (len < 0.001) return;
    let dirX = dx / len;
    let dirZ = dz / len;

    // 被墙挡住时沿墙侧移
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

  _updateAnimation() {
    if (this.state === 'attack') {
      if (this.currentAnim !== 'attack') this._play('attack');
    }
  }

  // ---------------- 射击 ----------------
  _shoot() {
    if (!this.player || this.player.dead) return;
    if (this.ammo <= 0) return;
    this.ammo -= 1;

    const origin = this.position.clone();
    origin.y += 1.5;
    const target = this.player.camera.position.clone();

    // 命中率随距离衰减：近处接近基础命中率，远处降至最低
    const dist = origin.distanceTo(target);
    const t = Math.min(1, dist / ENEMY.accuracyRange);
    const chance = Math.max(ENEMY.accuracyMin, ENEMY.accuracy * (1 - t));

    let hit = Math.random() < chance;
    const end = target.clone();
    if (!hit) {
      // 打偏：在玩家附近随机偏移，距离越远偏移越大
      const missScale = 0.8 + t * 1.8;
      end.x += (Math.random() - 0.5) * missScale;
      end.y += (Math.random() - 0.5) * missScale * 0.7;
      end.z += (Math.random() - 0.5) * missScale;
    }

    this.onShoot(origin, end, this);
    if (hit) {
      const dealt = this.player.takeDamage(ENEMY.damage);
      if (dealt > 0) this.onPlayerHit(dealt);
    }
  }

  // ---------------- 伤害 ----------------
  takeDamage(amount) {
    if (this.dead) return false;
    this.health -= amount;
    this.flashTimer = 0.15;
    // 第三轮：受击身体抖动 + 小幅后撤躲避（不瞬移）
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

    // 被击中会立刻警觉
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
    this._play('death', true);
    this.onDeath(this);
  }

  /** 重新投放 */
  respawn(spawn) {
    this.spawn.copy(spawn);
    this.position.copy(spawn);
    this.velocity.set(0, 0, 0);
    this.health = ENEMY.maxHealth;
    this.dead = false;
    this.deadTimer = 0;
    this.state = 'patrol';
    this.root.visible = true;
    this.fireTimer = 0;
    this.stuckTimer = 0;
    this.loseSightTimer = 0;
    this.flinchTimer = 0;
    this.burstLeft = 0;
    this.coverTimer = 1.0;
    this.coverStrafe = 0;
    this.alertTimer = 0;
    this.scanTime = 0;
    this.heading = Math.random() * Math.PI * 2;
    this.targetHeading = this.heading;
    this.ammo = ENEMY.magazineSize;
    this.reloading = false;
    this.reloadTimer = 0;
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

  /** 射线与敌人命中球求交（用于玩家射击）；返回 part: head / body / limb */
  raycast(origin, dir, maxDist) {
    if (this.dead || !this.root.visible) return null;

    const bodyCenter = this.position.clone();
    bodyCenter.y += ENEMY.bodyHeight;
    const headCenter = this.position.clone();
    headCenter.y += ENEMY.headHeight;
    // 第三轮：腿部命中球（四肢伤害降低）
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

/** 第三轮：角度差归一化到 [-π, π]，用于平滑转头 */
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
