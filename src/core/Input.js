/**
 * 输入管理：键盘、鼠标、指针锁定
 * 只负责采集原始输入，不处理游戏逻辑
 */
export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();          // 当前按下的按键
    this.pressed = new Set();       // 本帧刚按下的按键（边沿触发）
    this.mouseDown = false;         // 左键是否按住
    this.dx = 0;                    // 本帧鼠标水平位移
    this.dy = 0;                    // 本帧鼠标垂直位移
    this.wheelDelta = 0;            // 本帧滚轮累计
    this.locked = false;
    this.enabled = true;            // 暂停/死亡时禁用视角移动
    this.onLockChange = null;

    this._bind();
  }

  _bind() {
    // 键盘
    window.addEventListener('keydown', (e) => {
      // 防止空格滚动页面 / Tab 切换焦点
      if (['Space', 'Tab', 'KeyR'].includes(e.code)) e.preventDefault();
      if (!e.repeat) this.pressed.add(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
    });

    // 鼠标按键
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        this.mouseDown = true;
        this.pressed.add('Mouse0');
      }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseDown = false;
    });
    // 禁止右键菜单，保持沉浸感
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // 滚轮（切枪用）
    this.canvas.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      this.wheelDelta += e.deltaY;
    }, { passive: true });

    // 鼠标移动（指针锁定后使用 movementX/Y；未锁定时同样累计，作为降级方案）
    document.addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      this.dx += e.movementX || 0;
      this.dy += e.movementY || 0;
    });

    // 指针锁定状态
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) {
        // 失去焦点时清空按键，避免“卡键”
        this.keys.clear();
        this.mouseDown = false;
        this.dx = this.dy = 0;
      }
      if (this.onLockChange) this.onLockChange(this.locked);
    });
    document.addEventListener('pointerlockerror', () => {
      console.warn('[Input] 指针锁定失败，请点击画布重试');
    });

    // 第三轮：浏览器失去焦点时自动解锁鼠标，避免"卡视角"
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseDown = false;
      this.dx = this.dy = 0;
      if (this.locked) this.releaseLock();
    });
  }

  /** 请求锁定鼠标 */
  requestLock() {
    if (!this.locked) {
      const p = this.canvas.requestPointerLock();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  }

  /** 释放鼠标 */
  releaseLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /** 是否按住某键 */
  isDown(code) {
    return this.keys.has(code);
  }

  /** 本帧是否刚按下（消费型） */
  consume(code) {
    if (this.pressed.has(code)) {
      this.pressed.delete(code);
      return true;
    }
    return false;
  }

  /** 取出并清空鼠标位移 */
  consumeMouseDelta() {
    const d = { x: this.dx, y: this.dy };
    this.dx = this.dy = 0;
    return d;
  }

  /** 取出并清空滚轮累计（有正负） */
  consumeWheel() {
    const d = this.wheelDelta;
    this.wheelDelta = 0;
    return d;
  }

  /** 每帧结束清理 */
  endFrame() {
    this.pressed.clear();
  }
}
