/**
 * 枪械系统（对应仓库 GunSystem.cs）
 * 负责：射速、弹匣/备弹、换弹、散布、后坐力、射线命中判定、
 *       音效、抛壳、枪口特效、与敌人伤害结算。
 */
import * as THREE from 'three';
import { WEAPON } from '../config/weapon.js';

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

    this.mag = WEAPON.magazineSize;
    this.reserve = WEAPON.reserveAmmo;
    this.cooldown = 0;
    this.inputMouseDown = false;
    this.inputFirePressed = false;
    this.reloading = false;
    this.reloadElapsed = 0;
    this.heat = 0;          // 连射热度：影响散布
    this.spread = WEAPON.spreadBase;
    this.shotCount = 0;     // 历史总射数
    this.burstCount = 0;    // 当前连发计数（松开扳机后重置）
    this.recoilYawDir = 0;  // 本次连射的水平偏移方向（随机一次，扫射时保持一致）
    this.reloadInsertPlayed = false;
    this.reloadDuration = WEAPON.reloadTimeTactical; // 空仓 / 战术换弹时长不同
    this.lastHudSpread = -1;

    this._tmpDir = new THREE.Vector3();
    this._tmpRight = new THREE.Vector3();
    this._tmpUp = new THREE.Vector3();
    this._muzzle = new THREE.Vector3();
  }

  /** 当前是否正在换弹 */
  get reloadProgress() {
    return this.reloading ? Math.min(1, this.reloadElapsed / this.reloadDuration) : 0;
  }

  /**
   * 每帧更新
   * @param {number} dt
   * @param {{x:number,y:number}} mouseDelta
   * @param {boolean} canAct 是否允许射击（游戏中且玩家存活）
   */
  update(dt, mouseDelta, canAct) {
    if (this.cooldown > 0) this.cooldown -= dt;

    // 连射热度自然衰减
    this.heat = Math.max(0, this.heat - dt * 5.5);
    // 松开扳机后连发计数缓慢清零
    if (!this.inputMouseDown && !this.inputFirePressed) {
      this.burstCount = Math.max(0, this.burstCount - dt * 7);
      // 短点射结束：后坐力快速回正（更贴近 CF 的点射手感）
      if (this.burstCount <= 0) this.mouseLook.recoilRecover = 16;
    } else {
      this.mouseLook.recoilRecover = 9;
    }

    // 散布：基础 + 移动惩罚 + 跳跃惩罚 + 连射累积
    let targetSpread = WEAPON.spreadBase + this.heat * WEAPON.spreadPerShot;
    if (this.player) {
      const hspeed = Math.hypot(this.player.velocity.x, this.player.velocity.z);
      // 静步 / 蹲伏时散布明显收紧
      const stable = this.player.isSlow || this.player.isCrouching;
      targetSpread += Math.min(WEAPON.spreadMove, hspeed * 0.006) * (stable ? 0.45 : 1);
      if (!this.player.grounded) targetSpread += 0.02; // 空中散布
      if (this.player.isCrouching) targetSpread *= 0.72;
    }
    this.spread += (Math.min(WEAPON.spreadMax, targetSpread) - this.spread) * Math.min(1, dt * 12);

    // 换弹计时（两段节奏：掏弹匣 → 插入弹匣）
    if (this.reloading) {
      this.reloadElapsed += dt;
      const progress = this.reloadProgress;
      if (!this.reloadInsertPlayed && progress >= WEAPON.reloadInsertRatio) {
        this.reloadInsertPlayed = true;
        this.audio.play('reload', { volume: 0.55, rate: 1.18 });
      }
      if (this.reloadElapsed >= this.reloadDuration) this._finishReload();
      this.hud.setReloadProgress(progress);
    }

    // 射击（按住连发 + 单击边沿，兼容极快的点击）
    if (canAct && this.player && !this.player.dead) {
      const wantsFire = this.inputMouseDown || this.inputFirePressed;
      if (wantsFire && this.cooldown <= 0 && !this.reloading) {
        if (this.mag > 0) {
          this._fire();
        } else if (this.inputFirePressed) {
          // 空仓：只在“按下”瞬间播放一次空击音，避免按住时连响
          this.audio.play('fireEmpty', { volume: 0.7, rate: 1 });
          this.cooldown = 0.3;
          this.hud.showReloadTip(true, true);
        }
      }
    }
    this.inputFirePressed = false;

    // 准星散布显示
    this.hud.setCrosshairSpread(this.spread);
    this.hud.showReloadTip(this.mag === 0 && !this.reloading, this.mag === 0);

    // 更新武器视图（摆动/后坐/换弹动画）
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

  /** 由 Input 每帧注入鼠标左键状态 */
  setMouseDown(down) {
    this.inputMouseDown = down;
  }

  /** 本帧是否有一次“按下”边沿（用于单击/快速点击射击） */
  setFirePressed(pressed) {
    this.inputFirePressed = !!pressed;
  }

  /** 调试模式：用键盘触发一次射击（自动化测试用） */
  debugFire() {
    if (this.reloading || this.mag <= 0 || this.cooldown > 0) return;
    this._fire();
  }

  /** 开火 */
  _fire() {
    this.mag -= 1;
    this.cooldown = WEAPON.fireInterval;
    this.shotCount += 1;
    this.burstCount += 1;
    this.heat = Math.min(8, this.heat + 0.9);

    // 后坐力：垂直上跳 + 水平偏移；连射时逐发递增
    const ramp = Math.min(WEAPON.recoilRampMax, 1 + this.burstCount * WEAPON.recoilRamp);
    if (this.burstCount === 1) {
      // 每次新连射随机一个水平偏移方向，扫射时保持同一方向漂移
      this.recoilYawDir = (Math.random() - 0.5) * 2;
    }
    this.mouseLook.addRecoil(
      WEAPON.recoilPitch * ramp,
      this.recoilYawDir * WEAPON.recoilYaw * ramp + (Math.random() - 0.5) * WEAPON.recoilYaw * 0.6
    );
    // 相机震动：扫射越久震动越大
    const shakeAmp = Math.min(WEAPON.shakeMax, this.burstCount * WEAPON.shakePerShot);
    this.mouseLook.addShake(
      (Math.random() - 0.5) * shakeAmp,
      (Math.random() - 0.5) * shakeAmp * 0.8
    );

    // 弹道方向（加入散布）
    const camDir = this.camera.getWorldDirection(this._tmpDir).clone();
    this._tmpRight.crossVectors(camDir, UP).normalize();
    this._tmpUp.crossVectors(this._tmpRight, camDir).normalize();
    const r = this.spread * Math.sqrt(Math.random());
    const theta = Math.random() * Math.PI * 2;
    const dir = camDir.clone()
      .addScaledVector(this._tmpRight, Math.cos(theta) * r)
      .addScaledVector(this._tmpUp, Math.sin(theta) * r)
      .normalize();

    const origin = this.camera.position.clone();
    const muzzle = this.view.getMuzzleWorldPosition();
    this._muzzle.copy(muzzle);

    // 命中判定：先找墙，再找敌人，取最近
    const wallHit = this.collision.raycast(origin, dir, WEAPON.range);
    const enemyHit = this.enemies
      ? this.enemies.raycast(origin, dir, wallHit ? wallHit.distance : WEAPON.range)
      : null;

    let hitPoint;
    if (enemyHit && (!wallHit || enemyHit.distance < wallHit.distance)) {
      hitPoint = enemyHit.point;
      // 伤害分区：头 ×2 / 四肢 ×0.7 / 身体 ×1
      let mult = 1;
      if (enemyHit.part === 'head') mult = WEAPON.headshotMultiplier;
      else if (enemyHit.part === 'limb') mult = WEAPON.limbMultiplier;
      const damage = WEAPON.damage * mult;
      const killed = enemyHit.enemy.takeDamage(damage, enemyHit.head);
      this.effects.spawnEnemyHit(hitPoint);
      this.hud.showHitmarker(killed, enemyHit.part === 'head');
      // 击中反馈音效
      this.audio.play('hit', {
        volume: enemyHit.head ? 0.75 : 0.55,
        rate: enemyHit.head ? 1.15 : 1.0,
      });
      if (killed) {
        this.onKill(enemyHit.enemy);
        const head = enemyHit.part === 'head';
        this.hud.pushKill(head ? '爆头' : '击杀', '击倒');
        this.hud.showKillPopup(head ? '爆头' : '击杀');
        // 击杀计数区分普通击杀 / 爆头击杀；爆头使用更高音调的击杀音效
        if (head) {
          this.hud.addHeadshotKill();
          this.audio.play('kill', { volume: 0.8, rate: 1.5 });
        }
      }
    } else if (wallHit) {
      hitPoint = wallHit.point;
      this.effects.spawnImpact(hitPoint, wallHit.normal);
    } else {
      hitPoint = origin.clone().addScaledVector(dir, WEAPON.range);
    }

    // 曳光弹（从枪口到命中点）
    this.effects.spawnTracer(muzzle, hitPoint);

    // 枪口粒子火焰（沿枪口方向喷射）
    this.effects.spawnMuzzleFlash(muzzle, dir);

    // 枪口特效 + 音效 + 抛壳
    this.view.triggerFire();
    this.audio.play(this.shotCount % 2 === 0 ? 'fire1' : 'fire2', {
      volume: 0.85, rate: 0.94 + Math.random() * 0.12,
    });
    this.audio.play('casing' + (1 + (this.shotCount % 5)), {
      volume: 0.3, rate: 0.9 + Math.random() * 0.2,
    });

    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const casingPos = this.camera.position.clone()
      .addScaledVector(right, 0.2)
      .addScaledVector(camDir, 0.25)
      .add(new THREE.Vector3(0, -0.12, 0));
    this.casings.spawn(casingPos, right);

    this.hud.setAmmo(this.mag, this.reserve);
  }

  /** 开始换弹 */
  startReload() {
    if (this.reloading) return;
    if (this.mag >= WEAPON.magazineSize) return;
    if (this.reserve <= 0) return;

    this.reloading = true;
    this.reloadElapsed = 0;
    this.reloadInsertPlayed = false;
    const empty = this.mag === 0;
    this.reloadDuration = empty ? WEAPON.reloadTimeEmpty : WEAPON.reloadTimeTactical;
    this.audio.play(empty ? 'reloadEmpty' : 'reload', { volume: 0.8, rate: 1 });
    this.hud.showReloadBar(true);
    this.hud.showReloadTip(false, false);
  }

  /** 完成换弹结算 */
  _finishReload() {
    const need = WEAPON.magazineSize - this.mag;
    const take = Math.min(need, this.reserve);
    this.mag += take;
    this.reserve -= take;
    this.reloading = false;
    this.reloadElapsed = 0;
    this.hud.showReloadBar(false);
    this.hud.setAmmo(this.mag, this.reserve);
    this.hud.showReloadTip(false, false);
  }

  /** 复活时重置弹药 */
  resetAmmo() {
    this.mag = WEAPON.magazineSize;
    this.reserve = WEAPON.reserveAmmo;
    this.reloading = false;
    this.reloadElapsed = 0;
    this.heat = 0;
    this.cooldown = 0;
    this.burstCount = 0;
    this.reloadInsertPlayed = false;
    this.hud.showReloadBar(false);
    this.hud.setAmmo(this.mag, this.reserve);
  }
}
