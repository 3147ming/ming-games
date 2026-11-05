/**
 * 枪械系统（v0.4 多武器版）
 * 支持 rifle / pistol / shotgun 三把武器，按 1/2/3 切换。
 * 每把武器独立弹匣、备弹、热度；霰弹枪一次发射多颗弹丸。
 */
import * as THREE from 'three';
import { WEAPONS, WEAPON_ORDER, WEAPON_UNLOCKED } from '../config/weapon.js';

const UP = new THREE.Vector3(0, 1, 0);

export class GunSystem {
  constructor(deps) {
    this.camera = deps.camera;
    this.player = deps.player;
    this.mouseLook = deps.mouseLook;
    this.view = deps.weaponView;
    this.effects = deps.effects;
    this.casings = deps.casings;
    this.audio = deps.audio;
    this.collision = deps.collision;
    this.enemies = deps.enemies;
    this.hud = deps.hud;
    this.onKill = deps.onKill || (() => {});
    this.onShot = deps.onShot || (() => {});

    // 每把武器的独立运行时状态
    this._states = {};
    for (const id of WEAPON_UNLOCKED) {
      const w = WEAPONS[id];
      this._states[id] = {
        mag: w.magazineSize,
        reserve: w.reserveAmmo,
        heat: 0,
        burstCount: 0,
      };
    }
    this.currentId = WEAPON_UNLOCKED[0];

    this.cooldown = 0;
    this.inputMouseDown = false;
    this.inputFirePressed = false;
    this.reloading = false;
    this.reloadElapsed = 0;
    this.spread = this._current.spreadBase;
    this.shotCount = 0;
    this.recoilYawDir = 0;
    this.reloadInsertPlayed = false;
    this.reloadDuration = this._current.reloadTime;
    this.switchCooldown = 0; // 切枪冷却，防止滚轮连切

    this._tmpDir = new THREE.Vector3();
    this._tmpRight = new THREE.Vector3();
    this._tmpUp = new THREE.Vector3();
    this._muzzle = new THREE.Vector3();

    // 通知视图当前武器
    this.view.setWeapon(this._current);
    this._syncHud();
  }

  /** 当前武器配置 */
  get _current() { return WEAPONS[this.currentId]; }
  get _state() { return this._states[this.currentId]; }

  // 向后兼容：探针 / 旧代码直接读 gun.mag / gun.reserve
  get mag() { return this._state.mag; }
  set mag(v) { this._state.mag = v; }
  get reserve() { return this._state.reserve; }
  set reserve(v) { this._state.reserve = v; }

  get reloadProgress() {
    return this.reloading ? Math.min(1, this.reloadElapsed / this.reloadDuration) : 0;
  }

  /**
   * 每帧更新
   * @param {number} dt
   * @param {{x:number,y:number}} mouseDelta
   * @param {boolean} canAct
   */
  update(dt, mouseDelta, canAct) {
    if (this.cooldown > 0) this.cooldown -= dt;
    if (this.switchCooldown > 0) this.switchCooldown -= dt;

    const W = this._current;
    const st = this._state;

    // 连射热度自然衰减
    st.heat = Math.max(0, st.heat - dt * 5.5);
    if (!this.inputMouseDown && !this.inputFirePressed) {
      st.burstCount = Math.max(0, st.burstCount - dt * 7);
      if (st.burstCount <= 0) this.mouseLook.recoilRecover = W.recoilRecover * 1.8;
    } else {
      this.mouseLook.recoilRecover = W.recoilRecover;
    }

    // 散布
    let targetSpread = W.spreadBase + st.heat * W.spreadPerShot;
    if (this.player) {
      const hspeed = Math.hypot(this.player.velocity.x, this.player.velocity.z);
      const stable = this.player.isSlow || this.player.isCrouching;
      targetSpread += Math.min(W.spreadMove, hspeed * 0.006) * (stable ? 0.45 : 1);
      if (!this.player.grounded) targetSpread += 0.02;
      if (this.player.isCrouching) targetSpread *= 0.72;
      if (this.player.isSprinting) targetSpread *= 1.35;
    }
    this.spread += (Math.min(W.spreadMax, targetSpread) - this.spread) * Math.min(1, dt * 12);

    // 换弹计时
    if (this.reloading) {
      this.reloadElapsed += dt;
      const progress = this.reloadProgress;
      if (!this.reloadInsertPlayed && progress >= W.reloadInsertRatio) {
        this.reloadInsertPlayed = true;
        this.audio.play('reload', { volume: 0.55, rate: 1.18 });
      }
      if (this.reloadElapsed >= this.reloadDuration) this._finishReload();
      this.hud.setReloadProgress(progress);
    }

    // 射击
    if (canAct && this.player && !this.player.dead) {
      // 半自动武器：仅按下边沿触发；全自动：按住连发
      let wantsFire;
      if (W.auto) {
        wantsFire = this.inputMouseDown || this.inputFirePressed;
      } else {
        wantsFire = this.inputFirePressed; // 必须松开再按
      }
      if (wantsFire && this.cooldown <= 0 && !this.reloading) {
        if (st.mag > 0) {
          this._fire();
        } else if (this.inputFirePressed) {
          this.audio.play('fireEmpty', { volume: 0.7, rate: 1 });
          this.cooldown = 0.3;
          this.hud.showReloadTip(true, true);
        }
      }
    }
    this.inputFirePressed = false;

    this.hud.setCrosshairSpread(this.spread);
    this.hud.showReloadTip(st.mag === 0 && !this.reloading, st.mag === 0);

    const speed = this.player ? Math.hypot(this.player.velocity.x, this.player.velocity.z) : 0;
    this.view.update(
      dt,
      {
        moving: speed > 1.2 && this.player && this.player.grounded,
        airborne: !!(this.player && !this.player.grounded),
        reloading: this.reloading,
        reloadProgress: this.reloadProgress,
      },
      mouseDelta
    );
  }

  setMouseDown(down) { this.inputMouseDown = down; }
  setFirePressed(pressed) { this.inputFirePressed = !!pressed; }

  debugFire() {
    if (this.reloading || this._state.mag <= 0 || this.cooldown > 0) return;
    this._fire();
  }

  /** 切换到指定武器 */
  switchWeapon(id) {
    if (!WEAPON_UNLOCKED.includes(id)) return;
    if (id === this.currentId) return;
    if (this.switchCooldown > 0) return;
    if (this.reloading) this._cancelReload();

    this.currentId = id;
    const W = this._current;
    const st = this._state;
    this.cooldown = 0.25;           // 切枪后小延迟
    this.switchCooldown = 0.3;
    this.heat = 0;
    this.spread = W.spreadBase;
    this.audio.play('casing1', { volume: 0.18, rate: 1.4 }); // 切枪音效（用抛壳声代替）
    this.view.setWeapon(W);
    this._syncHud();
  }

  /** 滚轮切换 */
  switchWeaponByDelta(delta) {
    const idx = WEAPON_UNLOCKED.indexOf(this.currentId);
    let next = idx + (delta > 0 ? 1 : -1);
    if (next < 0) next = WEAPON_UNLOCKED.length - 1;
    if (next >= WEAPON_UNLOCKED.length) next = 0;
    this.switchWeapon(WEAPON_UNLOCKED[next]);
  }

  _cancelReload() {
    this.reloading = false;
    this.reloadElapsed = 0;
    this.reloadInsertPlayed = false;
    this.hud.showReloadBar(false);
  }

  /** 开火 */
  _fire() {
    const W = this._current;
    const st = this._state;

    st.mag -= 1;
    this.cooldown = W.fireInterval;
    this.shotCount += 1;
    st.burstCount += 1;
    st.heat = Math.min(8, st.heat + 0.9);

    // 后坐力
    const ramp = Math.min(W.recoilRampMax, 1 + st.burstCount * W.recoilRamp);
    if (st.burstCount === 1) {
      this.recoilYawDir = (Math.random() - 0.5) * 2;
    }
    this.mouseLook.addRecoil(
      W.recoilPitch * ramp,
      this.recoilYawDir * W.recoilYaw * ramp + (Math.random() - 0.5) * W.recoilYaw * 0.6
    );
    const shakeAmp = Math.min(W.shakeMax, st.burstCount * W.shakePerShot);
    this.mouseLook.addShake(
      (Math.random() - 0.5) * shakeAmp,
      (Math.random() - 0.5) * shakeAmp * 0.8
    );

    // 弹道基准方向
    const camDir = this.camera.getWorldDirection(this._tmpDir).clone();
    this._tmpRight.crossVectors(camDir, UP).normalize();
    this._tmpUp.crossVectors(this._tmpRight, camDir).normalize();

    const origin = this.camera.position.clone();
    const muzzle = this.view.getMuzzleWorldPosition();
    this._muzzle.copy(muzzle);

    // 多弹丸（霰弹枪）或穿透（重狙）—— 每颗弹丸独立射线
    const pellets = W.pellets || 1;
    const pierce = W.pierce || 0;
    let anyHit = false;
    let anyKill = false;
    let anyHeadshot = false;

    for (let p = 0; p < pellets; p++) {
      const spread = this.spread + (W.spread || 0);
      const r = spread * Math.sqrt(Math.random());
      const theta = Math.random() * Math.PI * 2;
      const dir = camDir.clone()
        .addScaledVector(this._tmpRight, Math.cos(theta) * r)
        .addScaledVector(this._tmpUp, Math.sin(theta) * r)
        .normalize();

      const wallHit = this.collision.raycast(origin, dir, W.range);
      const effectiveRange = wallHit ? wallHit.distance : W.range;

      // 穿透模式：一枪穿过多个敌人
      let hitList;
      if (pierce > 0 && this.enemies && this.enemies.raycastAll) {
        hitList = this.enemies.raycastAll(origin, dir, effectiveRange).slice(0, pierce + 1);
      } else {
        const single = this.enemies ? this.enemies.raycast(origin, dir, effectiveRange) : null;
        hitList = single ? [single] : [];
      }

      let furthestHit = null;
      let hitEnemy = false;

      for (const enemyHit of hitList) {
        if (wallHit && enemyHit.distance >= wallHit.distance) break; // 墙挡住了
        hitEnemy = true;
        let mult = 1;
        if (enemyHit.part === 'head') mult = W.headshotMultiplier;
        else if (enemyHit.part === 'limb') mult = W.limbMultiplier;
        const damage = W.damage * mult;
        const killed = enemyHit.enemy.takeDamage(damage, enemyHit.head);
        const headshot = enemyHit.part === 'head';
        this.effects.spawnEnemyHit(enemyHit.point);
        if (killed) {
          this.onKill(enemyHit.enemy);
          this.hud.pushKill(headshot ? '爆头' : '击杀', '击倒');
          this.hud.showKillPopup(headshot ? '爆头' : '击杀');
          if (headshot) {
            this.hud.addHeadshotKill();
            this.audio.play('kill', { volume: 0.8, rate: 1.5 });
          }
        }
        if (!furthestHit || enemyHit.distance > furthestHit.distance) {
          furthestHit = enemyHit;
        }
      }

      let hitPoint;
      if (hitEnemy && furthestHit) {
        hitPoint = furthestHit.point;
      } else if (wallHit) {
        hitPoint = wallHit.point;
        this.effects.spawnImpact(hitPoint, wallHit.normal);
      } else {
        hitPoint = origin.clone().addScaledVector(dir, W.range);
      }

      this.effects.spawnTracer(muzzle, hitPoint, pellets > 1 ? 0.5 : 1.0);

      if (hitEnemy) anyHit = true;
      if (hitList.some(h => h.enemy.health <= 0)) anyKill = true;
    }

    // 命中反馈（只反馈一次，避免多弹丸重复播放）
    if (anyHit) {
      this.hud.showHitmarker(anyKill, anyHeadshot);
      this.audio.play('hit', {
        volume: anyHeadshot ? 0.75 : 0.55,
        rate: anyHeadshot ? 1.15 : 1.0,
      });
    }

    // 枪口火焰 + 音效 + 抛壳
    this.effects.spawnMuzzleFlash(muzzle, camDir);
    this.view.triggerFire();
    const sfxName = pellets > 1 ? 'fire2' : (this.shotCount % 2 === 0 ? 'fire1' : 'fire2');
    this.audio.play(sfxName, { volume: 0.85, rate: 0.94 + Math.random() * 0.12 });
    this.audio.play('casing' + (1 + (this.shotCount % 5)), { volume: 0.3, rate: 0.9 + Math.random() * 0.2 });

    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const casingPos = this.camera.position.clone()
      .addScaledVector(right, 0.2)
      .addScaledVector(camDir, 0.25)
      .add(new THREE.Vector3(0, -0.12, 0));
    this.casings.spawn(casingPos, right);

    this._syncHud();
    this.onShot({ hit: anyHit, kill: anyKill, headshot: anyHeadshot });
  }

  startReload() {
    const W = this._current;
    const st = this._state;
    if (this.reloading) return;
    if (st.mag >= W.magazineSize) return;
    if (st.reserve <= 0) return;

    this.reloading = true;
    this.reloadElapsed = 0;
    this.reloadInsertPlayed = false;
    const empty = st.mag === 0;
    this.reloadDuration = W.reloadTime;
    this.audio.play(empty ? 'reloadEmpty' : 'reload', { volume: 0.8, rate: 1 });
    this.hud.showReloadBar(true);
    this.hud.showReloadTip(false, false);
  }

  _finishReload() {
    const W = this._current;
    const st = this._state;
    const need = W.magazineSize - st.mag;
    const take = Math.min(need, st.reserve);
    st.mag += take;
    st.reserve -= take;
    this.reloading = false;
    this.reloadElapsed = 0;
    this.hud.showReloadBar(false);
    this._syncHud();
    this.hud.showReloadTip(false, false);
  }

  addSupply(rounds) {
    // 补给加到所有武器的备弹
    for (const id of WEAPON_UNLOCKED) {
      this._states[id].reserve += Math.max(0, rounds);
    }
    this._syncHud();
  }

  resetAmmo() {
    for (const id of WEAPON_UNLOCKED) {
      const w = WEAPONS[id];
      this._states[id].mag = w.magazineSize;
      this._states[id].reserve = w.reserveAmmo;
      this._states[id].heat = 0;
      this._states[id].burstCount = 0;
    }
    this.reloading = false;
    this.reloadElapsed = 0;
    this.cooldown = 0;
    this.reloadInsertPlayed = false;
    this.hud.showReloadBar(false);
    this._syncHud();
  }

  /** 同步 HUD 弹药 + 武器名 */
  _syncHud() {
    const W = this._current;
    const st = this._state;
    this.hud.setAmmo(st.mag, st.reserve);
    this.hud.setWeaponName(W.name, W.tag);
  }
}
