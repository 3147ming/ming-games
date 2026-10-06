/**
 * 时间缩放通道（模块 10）—— 顿帧 / 慢动作演出共用一个缩放通道，不叠加（取最极端的最小值）。
 * ---------------------------------------------------------------------------
 * ⚠ 默认 scale = 1.0，正常游玩时**完全不改变模块 1~9 的任何时序**；只有触发
 *   命中顿帧或释放无双时才临时压低 scale，因此"保留已有功能"不受影响。
 *
 *   主循环用法：
 *     const ts = timeControl.update(dt);
 *     const sdt = dt * ts;            // 玩法时间（玩家/战斗/敌人/世界）
 *     // combatFx / 镜头 / 草 / 天穹仍用真实 dt，保证"特效照常跑、玩法冻住"
 */
export class TimeControl {
  constructor() {
    this.scale = 1;
    this._slowScale = 1;
    this._slowTimer = 0;
    this._hitScale = 1;
    this._hitTimer = 0;
  }

  /** 无双乱舞：时间缩放 0.3 倍持续 0.4s（慢动作起手） */
  requestSlowmo(scale, duration) {
    // 不叠加：取更慢（更小）的那个；时长刷新为较长者
    if (scale <= this._slowScale || this._slowTimer <= 0) {
      this._slowScale = Math.min(this._slowScale === 1 ? scale : this._slowScale, scale);
      this._slowTimer = Math.max(this._slowTimer, duration);
    }
  }

  /** 命中顿帧：scale 0.15 持续 dur（轻 0.05 / 重 0.1 / 特殊 0.15） */
  requestHitstop(scale, duration) {
    if (duration <= 0) return;
    if (scale <= this._hitScale || this._hitTimer <= 0) {
      this._hitScale = Math.min(this._hitScale === 1 ? scale : this._hitScale, scale);
      this._hitTimer = Math.max(this._hitTimer, duration);
    }
  }

  update(dt) {
    if (this._slowTimer > 0) {
      this._slowTimer -= dt;
      if (this._slowTimer <= 0) this._slowScale = 1;
    }
    if (this._hitTimer > 0) {
      this._hitTimer -= dt;
      if (this._hitTimer <= 0) this._hitScale = 1;
    }
    // 不叠加：取两者最小值（最慢）
    this.scale = Math.min(this._slowScale, this._hitScale);
    return this.scale;
  }

  get active() {
    return this.scale < 0.999;
  }
}
