/**
 * 输入：第一人称视角的指针锁定（Pointer Lock）与键位映射。
 *
 * 职责边界：本模块只把"原始输入"收敛成主循环需要的 input 状态
 * （yaw / pitch / ads / 移动键），不做任何游戏业务判定。
 * 开火、暂停、交互、换弹等业务动作仍由 main.js 统一处理。
 *
 * 坐标约定：yaw 为绕 Y 轴的水平朝向（弧度，与逻辑 2D 角一致），
 * pitch 为俯仰（弧度，正为上）。鼠标位移在锁定状态下累加到 yaw/pitch。
 */

import { VIEW3D } from './config.js';

/**
 * 创建一份空的输入状态。
 * @returns {object} input 状态对象
 */
export function createInput() {
  return {
    up: false,
    down: false,
    left: false,
    right: false,
    sprint: false,
    crouch: false,
    fire: false,
    firePressed: false,
    ads: false, // 瞄准（右键）
    yaw: 0, // 水平朝向（弧度）
    pitch: 0, // 俯仰（弧度，正为上）
    aim: { x: 0, y: 0 }, // 兼容旧逻辑的瞄准点（无指针锁定时回退用）
    locked: false, // 指针锁定是否激活
    invertMouseX: false, // 鼠标水平轴反转（由存档设置注入）
    sensitivityMul: 1, // 鼠标灵敏度倍率（由存档设置注入，1=默认）
  };
}

/**
 * 挂载 FPS 视角输入监听。
 * @param {HTMLCanvasElement} canvas 游戏画布（指针锁定目标）
 * @param {object} input createInput() 返回的状态对象
 * @returns {object} 控制器 { requestLock, exitLock }
 */
export function setupMouseLook(canvas, input, opts = {}) {
  // 触屏模式下，点击屏幕会合成 mousedown/mouseup：若 mouseup 仍清 fire，
  // 会把"按住虚拟开火键连射"打断成单发。触屏模式的开火只由触摸事件驱动。
  const isTouchMode = !!(opts && opts.touchMode);
  const clampPitch = () => {
    const lim = VIEW3D.pitchLimit;
    if (input.pitch > lim) input.pitch = lim;
    else if (input.pitch < -lim) input.pitch = -lim;
  };

  // 右键 = 瞄准（ADS），点击切换开镜/关镜（非按住）。仅在指针已锁定时生效，
  // 避免未锁定时的误触（例如进场首帧）。preventDefault 阻止右键长按触发浏览器前进/后退等系统手势。
  canvas.addEventListener('mousedown', (ev) => {
    if (ev.button === 2 && input.locked) {
      input.ads = !input.ads;
      ev.preventDefault?.();
    }
  });
  window.addEventListener('mouseup', (ev) => {
    if (isTouchMode) return;
    if (ev.button === 0) input.fire = false;
    // 右键 mouseup 不再清 ads：ADS 为点击切换，松手应保持当前状态
  });

  // 指针锁定状态变化
  document.addEventListener('pointerlockchange', () => {
    input.locked = document.pointerLockElement === canvas;
  });

  // 锁定状态下累加视角（视角灵敏度在 VIEW3D.sensitivity）
  // invertMouseX=true 时水平方向取反，满足"鼠标 X 轴反转"的需求
  document.addEventListener('mousemove', (ev) => {
    if (!input.locked) return;
    const s = VIEW3D.sensitivity * (input.sensitivityMul || 1);
    const xSign = input.invertMouseX ? 1 : -1;
    input.yaw -= (ev.movementX || 0) * s * xSign;
    input.pitch -= (ev.movementY || 0) * s;
    clampPitch();
  });

  return {
    /** 请求指针锁定（须在用户手势内调用） */
    requestLock() {
      if (!canvas.requestPointerLock) return;
      try {
        // 现代浏览器返回 Promise：锁定被拒（无头环境、移动端、用户刚按过 Esc 的限流）
        // 会走 reject，不接住就是一个 uncaught 异常，污染 console。
        const p = canvas.requestPointerLock();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch {
        /* 部分环境不支持，忽略 */
      }
    },
    /** 退出指针锁定 */
    exitLock() {
      if (document.exitPointerLock) {
        try {
          document.exitPointerLock();
        } catch {
          /* 忽略 */
        }
      }
    },
  };
}
