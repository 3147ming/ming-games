/**
 * 第一人称视角控制（对应仓库 MouseLook.cs）
 * 支持鼠标灵敏度、俯仰角限制、后坐力叠加与自动回正。
 */
import { PLAYER } from '../config/weapon.js';

export class MouseLook {
  constructor(camera) {
    this.camera = camera;
    this.camera.rotation.order = 'YXZ';
    this.sensitivity = PLAYER.mouseSensitivity;
    this.yaw = PLAYER.startYaw;
    this.pitch = 0;
    // 后坐力偏移（不与鼠标输入混在一起，方便自然回正）
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.recoilRecover = 9;   // 后坐力回正速度（点射结束会临时提高）
    this.bobPitch = 0;
    // 相机震动（第三轮：随扫射发数增强）
    this.shakePitch = 0;
    this.shakeYaw = 0;
  }

  /** 鼠标输入（像素位移） */
  onMouseMove(dx, dy) {
    this.yaw -= dx * this.sensitivity;
    this.pitch -= dy * this.sensitivity;
    this.pitch = clamp(this.pitch, -1.45, 1.45);
  }

  /** 施加后坐力（弧度） */
  addRecoil(pitch, yaw) {
    this.recoilPitch += pitch;
    this.recoilYaw += yaw;
  }

  /** 施加相机震动（幅度随扫射发数增大） */
  addShake(pitch, yaw) {
    this.shakePitch += pitch;
    this.shakeYaw += yaw;
  }

  /** 每帧回正并写入相机旋转 */
  update(dt) {
    // 后坐力回正：松开鼠标后使用更快的回正速度
    const recover = 1 - Math.exp(-this.recoilRecover * dt);
    this.recoilPitch *= 1 - recover;
    this.recoilYaw *= 1 - recover;
    // 震动衰减更快
    const shakeDecay = Math.exp(-22 * dt);
    this.shakePitch *= shakeDecay;
    this.shakeYaw *= shakeDecay;

    this.camera.rotation.x = clamp(
      this.pitch + this.recoilPitch + this.bobPitch + this.shakePitch, -1.55, 1.55
    );
    this.camera.rotation.y = this.yaw + this.recoilYaw + this.shakeYaw;
    this.camera.rotation.z = 0;
  }

  /** 复位 */
  reset() {
    this.yaw = PLAYER.startYaw;
    this.pitch = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.bobPitch = 0;
    this.shakePitch = 0;
    this.shakeYaw = 0;
  }

  /** 当前朝向（世界坐标单位向量） */
  getForward() {
    return {
      x: -Math.sin(this.yaw),
      y: 0,
      z: -Math.cos(this.yaw),
    };
  }
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
