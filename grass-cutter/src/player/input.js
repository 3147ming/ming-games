/**
 * 输入系统（模块 2）
 * ---------------------------------------------------------------------------
 * 只做三件事：**按住状态**、**按下沿（带输入缓冲）**、**鼠标增量**。
 * 为什么要把"按下沿 + 时间窗"做进输入层，而不是在控制器里各写一遍：
 *   · 跳跃/闪避必须容忍"早按了几十毫秒" —— 玩家在落地前 0.1s 按了空格，
 *     没有缓冲就是"没反应"，有了就是"丝滑"。这是动作游戏手感的基本盘。
 *   · 每个动作各写一遍时间窗，迟早在某个模块里漏掉一处，表现成"偶尔按键失灵"。
 *
 * 按键 → 动作 的映射集中在一张表里，模块 3/5 加攻击键时只改这张表，
 * 不要在业务代码里散落 `e.code === 'KeyN'`。
 */

export const ACTIONS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  dodge: ['ShiftLeft', 'ShiftRight'],
  // ── 战斗键位（2026-09-25 对齐燕云参考布局，主理人裁决）：
  //   轻攻击=鼠标左键（N 留作键盘备选）  重攻击/蓄力=R（C 留作备选）
  //   无双乱舞=TAB（原 R 让给重攻击）    武艺1=Q / 武艺2=E（数字键留作备选）
  //   防御=F（按住）                     卸势=鼠标右键（见 MOUSE_ACTIONS）
  lightAttack: ['KeyN'],
  heavyAttack: ['KeyR', 'KeyC'],
  musou: ['Tab'],
  // ── 模块 5 武艺：Q/E 释放两套技能（耗 20/35 斗气，见 config.ARTS）
  art1: ['KeyQ', 'Digit1', 'Numpad1'],
  art2: ['KeyE', 'Digit2', 'Numpad2'],
  // ── 防御/卸势：机制见 config.DEFENSE 与 combat/defense.js
  block: ['KeyF'],
};

/**
 * 鼠标键 → 动作（模块 3）。与键盘表**并列**而不是合并，因为键值是数字、键码是字符串，
 * 混在一张表里会让"到底是按键还是点鼠标"变得不可读。
 *   0 = 左键（轻攻击）  2 = 右键（卸势，2026-09-25 起；重攻击改到键盘 R）
 * ⚠ 鼠标攻击只在**指针已锁定**时生效：否则"点击画面锁指针"这一下会顺手砍一刀，
 *   而且右键还会弹出浏览器菜单，玩起来会很烦。
 */
export const MOUSE_ACTIONS = {
  lightAttack: [0],
  parry: [2],
};

/** 这些键按住会导致页面滚动/焦点移动，要拦掉默认行为 */
const SWALLOW = new Set([
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Tab',
]);

export class InputState {
  constructor(target = typeof window !== 'undefined' ? window : null) {
    this.target = target;
    this.held = new Set();
    this.pressedAt = new Map(); // code → 按下时刻（秒）
    this.mouse = { dx: 0, dy: 0, buttons: new Set(), pressedAt: new Map() };
    this.pointerLocked = false;
    this.lookEvents = 0;
    this.bound = false;
    this.canvas = null;
    this._t = 0; // 由 update() 推进的内部时钟（秒），比每次读 performance.now() 稳定
    this.onKey = null; // 供调试面板/后续模块挂钩
  }

  attach(canvas) {
    if (this.bound || !this.target) return this;
    this.canvas = canvas;
    const t = this.target;

    this._onKeyDown = (e) => {
      // 重复触发（长按）不该刷新"按下时刻"，否则按住空格会一直重新起跳
      if (!e.repeat) this.pressedAt.set(e.code, this._t);
      this.held.add(e.code);
      if (SWALLOW.has(e.code)) e.preventDefault();
      this.onKey?.(e.code, true, e);
    };
    this._onKeyUp = (e) => {
      this.held.delete(e.code);
      this.onKey?.(e.code, false, e);
    };
    this._onBlur = () => {
      // 失焦时把按键全松开：否则"切出去再回来还在往前走"会非常迷惑
      this.held.clear();
      this.mouse.buttons.clear();
    };
    this._onMouseMove = (e) => {
      if (!this.pointerLocked) return;
      this.lookEvents++;
      this.mouse.dx += e.movementX || 0;
      this.mouse.dy += e.movementY || 0;
    };
    this._onMouseDown = (e) => {
      // 未锁定指针时点一下只是"去锁指针"，不该被当成攻击
      if (!this.pointerLocked) return;
      this.mouse.buttons.add(e.button);
      this.mouse.pressedAt.set(e.button, this._t);
    };
    this._onMouseUp = (e) => this.mouse.buttons.delete(e.button);
    this._onLockChange = () => {
      this.pointerLocked = !!canvas && this.target.document?.pointerLockElement === canvas;
      this.target.document?.body?.classList.toggle('locked', this.pointerLocked);
    };

    t.addEventListener('keydown', this._onKeyDown);
    t.addEventListener('keyup', this._onKeyUp);
    t.addEventListener('blur', this._onBlur);
    t.addEventListener('mousemove', this._onMouseMove);
    t.addEventListener('mousedown', this._onMouseDown);
    t.addEventListener('mouseup', this._onMouseUp);
    t.document?.addEventListener('pointerlockchange', this._onLockChange);
    this.bound = true;
    return this;
  }

  /** 每帧先调它，推进内部时钟 */
  update(dt) {
    this._t += Number.isFinite(dt) && dt > 0 ? dt : 0;
    return this;
  }

  requestPointerLock() {
    // 无头环境 / iframe 里指针锁定必然失败，且**返回 Promise**，不 catch 就是未捕获拒绝
    try {
      const p = this.canvas?.requestPointerLock?.({ unadjustedMovement: false });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* 环境不支持就算了，不该让游戏崩掉 */
    }
  }

  isDown(code) {
    return this.held.has(code);
  }

  isActionDown(action) {
    const codes = ACTIONS[action];
    if (codes && codes.some((c) => this.held.has(c))) return true;
    const btns = MOUSE_ACTIONS[action];
    return !!btns && btns.some((b) => this.mouse.buttons.has(b));
  }

  /** 轴：按下为正方向，未按为 0；同时按相反键时抵消 */
  axis(negAction, posAction) {
    return Number(this.isActionDown(posAction)) - Number(this.isActionDown(negAction));
  }

  /**
   * 消费一次"按下沿"。windowSec 内按下过就算数（输入缓冲），消费后清掉，
   * 所以同一次按下不会触发两次。
   */
  consumeActionPress(action, windowSec = 0.12) {
    const codes = ACTIONS[action] || [];
    const btns = MOUSE_ACTIONS[action] || [];
    let best = -Infinity;
    let hit = false;
    for (const c of codes) {
      const at = this.pressedAt.get(c);
      if (at === undefined) continue;
      if (this._t - at <= windowSec && at > best) {
        best = at;
        hit = true;
      }
    }
    for (const b of btns) {
      const at = this.mouse.pressedAt.get(b);
      if (at === undefined) continue;
      if (this._t - at <= windowSec && at > best) {
        best = at;
        hit = true;
      }
    }
    if (!hit) return false;
    // 一次按下只算一次：键盘与鼠标两路都要清掉
    for (const c of codes) this.pressedAt.delete(c);
    for (const b of btns) this.mouse.pressedAt.delete(b);
    return true;
  }

  consumeMouseDelta() {
    const d = { dx: this.mouse.dx, dy: this.mouse.dy };
    this.mouse.dx = 0;
    this.mouse.dy = 0;
    return d;
  }

  detach() {
    if (!this.bound || !this.target) return;
    const t = this.target;
    t.removeEventListener('keydown', this._onKeyDown);
    t.removeEventListener('keyup', this._onKeyUp);
    t.removeEventListener('blur', this._onBlur);
    t.removeEventListener('mousemove', this._onMouseMove);
    t.removeEventListener('mousedown', this._onMouseDown);
    t.removeEventListener('mouseup', this._onMouseUp);
    t.document?.removeEventListener('pointerlockchange', this._onLockChange);
    this.bound = false;
  }
}
