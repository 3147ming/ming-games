/**
 * 玩家控制器（模块 2 的交付物）
 * ---------------------------------------------------------------------------
 * 职责：状态机 + 输入意图 → 交给 motion.js 算出下一刻的位置 → 回填给网格与摄像机。
 * 所有"数值与几何"都在 config/motion 里，这里**不做数学**，只做决策。
 *
 * spec 逐条对应：
 *   · WASD 前后左右移动，基础速度 4.2 m/s        → cfg.WALK_SPEED
 *   · 鼠标控制镜头，横向 0.0022 / 纵向 0.0018     → 由 CameraRig.addLook 消费（见 main.js）
 *   · 视角俯仰限制上下 60°                        → CameraRig 的 clampPitch + groundLimitedBoom
 *   · Shift 闪避 0.35s / 8.5 m/s / 冷却 0.8s / 无敌 → 下面的 dodgeTimer / dodgeCooldown / invincible
 *   · 空格跳跃 初速 6.2 / 重力 -9.8 / 落地判定     → cfg.JUMP + motion.integrateVertical
 *   · 静止时朝向相机、移动时转向移动方向           → facing 那一节
 *
 * 帧率无关的硬要求：闪避总位移必须是 **精确的 8.5×0.35 = 2.975m**，
 * 不能"30fps 跑 3.12m、144fps 跑 3.01m"。做法是把闪避那一段的时间切成
 * `min(帧长, 剩余闪避时间)` 单独积分（见 dodgeUsed），多余的帧时间不计入位移。
 */
import { DEG, PLAYER } from '../core/config.js';
import { forwardVector, rightVector } from '../core/cameraMath.js';
import {
  facingFromDir,
  integrateVertical,
  moveToward,
  normalizeDir,
  resolveHorizontal,
  supportHeight,
  turnToward,
} from './motion.js';

export class PlayerController {
  constructor({ input, shapes = [], spawn = { x: 0, z: 0, yaw: 0 }, cfg = PLAYER } = {}) {
    this.cfg = cfg;
    this.input = input;
    this.shapes = shapes;

    this.position = { x: spawn.x ?? 0, y: 0, z: spawn.z ?? 0 };
    this.velocity = { x: 0, z: 0 };
    this.vy = 0;
    this.grounded = true;
    this.facing = spawn.yaw ?? 0;
    this.state = 'idle';

    // ── 模块 5/7/8：玩家生命值与无敌（无双乱舞/通关奖励注入）──
    this.hp = this.cfg.HP ?? 100;
    this.maxHp = this.cfg.HP ?? 100;
    this.invincibleTimer = 0; // 非闪避来源的无敌剩余秒数（无双乱舞期间 > 0）
    this.lastDamageAt = -Infinity;
    this.deaths = 0;

    this.dodgeTimer = 0;
    this.dodgeCooldown = 0;
    this.dodgeDir = { x: 0, z: -1 };
    this.dodges = 0; // 统计（探针/回归用）
    this.jumps = 0;

    this.coyoteTimer = 0;
    this.landedAt = -Infinity;
    this.time = 0;
    this.hitWall = false;
    this.clamped = false; // 越界保险是否生效（贴到 BOUND 上）
    this.lastDt = 0; // 本帧实际用的仿真步长（钳制之后）
    this.support = 0;
    this.lastMoveDir = null;
    this.onLand = null;
    this.onJump = null;
    this.onDodge = null;

    // ── 模块 3+ 的动作接管 ──────────────────────────────────────────────
    // 攻击/蓄力期间，玩家不该再听 WASD；但两个模块都不该去改对方的输入层，
    // 所以控制器对外开两个明确的口子：
    //   setMotionOverride(dir, speed)：本帧水平速度由 (dir,speed) 决定（蓄力慢走用）
    //   pushDisplacement(dx, dz)：本帧额外硬推一段位移（攻击前冲用，走同一套碰撞）
    this.overrideActive = false;
    this.overrideDir = null;
    this.overrideSpeed = 0;
    this.forcedDx = 0;
    this.forcedDz = 0;
    this.forcedTotal = 0; // 统计：被接管的累计位移（探针/调试用）
  }

  get motionOverridden() {
    return this.overrideActive;
  }

  /** 模块 3+：接管水平移动。dir 传 null 表示"只锁定 WASD，不让玩家自己走"。 */
  setMotionOverride(dir, speed = 0) {
    this.overrideActive = true;
    const len = dir ? Math.hypot(dir.x, dir.z) : 0;
    this.overrideDir = len > 1e-6 ? { x: dir.x / len, z: dir.z / len } : null;
    this.overrideSpeed = Number.isFinite(speed) ? Math.max(0, speed) : 0;
    return this;
  }

  clearMotionOverride() {
    this.overrideActive = false;
    this.overrideDir = null;
    this.overrideSpeed = 0;
    return this;
  }

  /**
   * 本帧额外硬推 (dx,dz) 米。
   * ⚠ 用位移而不是速度来表达前冲：速度要经过 ACCEL 曲线，30m/s² 意味着
   *   "1.1m 的前冲"实际只能走出 0.77m，而且随帧率漂 —— 那是不可接受的。
   *   直接给位移，`advance: 1.1` 就是 1.1m（被墙挡住则更短）。
   */
  pushDisplacement(dx, dz) {
    if (Number.isFinite(dx)) this.forcedDx += dx;
    if (Number.isFinite(dz)) this.forcedDz += dz;
    return this;
  }

  /** 丢掉还没发出去的前冲位移（顿帧期间用：真的冻住，而不是"冻一帧再补上"） */
  discardForced() {
    this.forcedDx = 0;
    this.forcedDz = 0;
    return this;
  }

  /** ★SPEC 闪避期间无敌；无双乱舞等技能注入的 invincibleTimer 也算无敌（模块 5/8 共用） */
  get invincible() {
    return (this.cfg.DODGE.INVINCIBLE && this.dodgeTimer > 0) || this.invincibleTimer > 0;
  }

  /** 模块 5/8：注入一段无敌（无双乱舞 / 关卡保护）。传秒数，叠加不覆盖 */
  grantInvincible(seconds) {
    this.invincibleTimer = Math.max(this.invincibleTimer, Number.isFinite(seconds) ? seconds : 0);
    return this.invincibleTimer;
  }

  /** 模块 8：对玩家造成伤害。无敌时直接吞掉；返回实际扣血量（0 = 被无敌挡下） */
  damage(amount) {
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    if (this.invincible) return 0;
    const before = this.hp;
    this.hp = Math.max(0, this.hp - amount);
    this.lastDamageAt = this.time;
    if (this.hp <= 0 && before > 0) this.deaths++;
    return before - this.hp;
  }

  /** 模块 8：治疗（通关/补给用） */
  heal(amount) {
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    const before = this.hp;
    this.hp = Math.min(this.maxHp, this.hp + amount);
    return this.hp - before;
  }

  get alive() {
    return this.hp > 0;
  }

  get isDodging() {
    return this.dodgeTimer > 0;
  }

  get airborne() {
    return !this.grounded;
  }

  get horizontalSpeed() {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  /** 供模块 3（攻击判定）/ 模块 4（敌人打人）使用的受击盒 */
  hurtbox() {
    return {
      x: this.position.x,
      y: this.position.y + this.cfg.HEIGHT / 2,
      z: this.position.z,
      radius: this.cfg.RADIUS,
      height: this.cfg.HEIGHT,
      feetY: this.position.y,
      invincible: this.invincible,
    };
  }

  teleport(x, z, y = 0) {
    this.position.x = x;
    this.position.z = z;
    this.position.y = y;
    this.velocity.x = 0;
    this.velocity.z = 0;
    this.vy = 0;
    this.grounded = y <= 0;
    this.support = y;
    return this.position;
  }

  /**
   * @param dt 帧长（秒）
   * @param cameraYaw 摄像机朝向（弧度）—— 移动方向是**相机相对**的，这是第三人称动作游戏的基本约定
   */
  update(dt, cameraYaw = 0) {
    const cfg = this.cfg;
    const D = cfg.DODGE;
    const J = cfg.JUMP;
    // 帧长上限：切标签页回来时 dt 可能是好几秒，不钳住会让玩家瞬移穿墙
    const step = Number.isFinite(dt) ? Math.max(0, Math.min(0.05, dt)) : 0;
    this.time += step;
    this.lastDt = step;

    // ── 1. 输入意图 → 世界方向
    //     被动作接管时 WASD 完全不参与（但**仍然读一次**，这样闪避方向还能用玩家真实意图）
    const fwd = this.input.axis('back', 'forward');
    const side = this.input.axis('left', 'right');
    const f = forwardVector(cameraYaw);
    const r = rightVector(cameraYaw);
    const inputDir = normalizeDir(f.x * fwd + r.x * side, f.z * fwd + r.z * side);
    const dir = this.overrideActive ? this.overrideDir : inputDir;

    this.dodgeCooldown = Math.max(0, this.dodgeCooldown - step);
    this.invincibleTimer = Math.max(0, this.invincibleTimer - step); // 无双无敌余量递减
    const wasGrounded = this.grounded;

    // ── 2. 起跳（地面或土狼时间内）
    if ((this.grounded || this.coyoteTimer > 0) && this.input.consumeActionPress('jump', J.PRESS_BUFFER)) {
      this.vy = J.VELOCITY;
      this.grounded = false;
      this.coyoteTimer = 0;
      this.jumps++;
      this.onJump?.();
    }

    // ── 3. 闪避触发
    if (this.dodgeCooldown <= 0 && (this.grounded || D.ALLOW_AIR) && this.input.consumeActionPress('dodge', D.PRESS_BUFFER)) {
      // 有方向输入就朝那个方向闪；没有就**向后闪**（背对相机），这是动作游戏的默认语义。
      // ⚠ 用 inputDir 而不是 dir：攻击途中按闪避取消时，玩家按的方向才是他想要的闪避方向。
      this.dodgeDir = inputDir ? { x: inputDir.x, z: inputDir.z } : { x: -f.x, z: -f.z };
      this.dodgeTimer = D.DURATION;
      this.dodgeCooldown = D.COOLDOWN;
      this.dodges++;
      this.onDodge?.(this.dodgeDir);
    }

    // ── 4. 水平速度
    let horizDt = step;
    let dodgeExited = false;
    if (this.dodgeTimer > 0) {
      // 闪避期间速度被**直接设定**（不能被加减速曲线拖慢，否则 8.5 m/s 就不是 8.5 了）
      const used = Math.min(step, this.dodgeTimer);
      this.dodgeTimer = Math.max(0, this.dodgeTimer - used);
      this.velocity.x = this.dodgeDir.x * D.SPEED;
      this.velocity.z = this.dodgeDir.z * D.SPEED;
      horizDt = used; // ⚠ 关键：只积分闪避还剩下的那段时间 → 总位移精确等于 D.SPEED×DURATION
      dodgeExited = this.dodgeTimer === 0;
    } else {
      const speed = this.overrideActive ? this.overrideSpeed : cfg.WALK_SPEED;
      const targetX = dir ? dir.x * speed : 0;
      const targetZ = dir ? dir.z * speed : 0;
      const rate = (dir ? cfg.ACCEL : cfg.DECEL) * (this.grounded ? 1 : cfg.AIR_CONTROL);
      this.velocity.x = moveToward(this.velocity.x, targetX, rate * step);
      this.velocity.z = moveToward(this.velocity.z, targetZ, rate * step);
    }
    if (dir) this.lastMoveDir = { x: dir.x, z: dir.z };

    // ── 5. 水平位移 + 碰撞（分轴推进 → 贴墙自然滑行）
    //     模块 3 的前冲走同一条路（forcedDx/Dz 只是"额外的位移"），
    //     所以"攻击撞墙"和"走路撞墙"的行为天然一致，不会出现两套碰撞。
    const stepDx = this.velocity.x * horizDt + this.forcedDx;
    const stepDz = this.velocity.z * horizDt + this.forcedDz;
    this.forcedTotal += Math.hypot(this.forcedDx, this.forcedDz);
    this.forcedDx = 0;
    this.forcedDz = 0;
    const moved = resolveHorizontal(
      this.position,
      { x: stepDx, z: stepDz },
      cfg.RADIUS,
      this.position.y,
      this.shapes,
      { stepHeight: cfg.STEP_HEIGHT, bound: cfg.BOUND }
    );
    this.position.x = moved.x;
    this.position.z = moved.z;
    this.hitWall = moved.hitX || moved.hitZ;
    this.clamped = moved.clamped;
    // 撞墙就把那个方向的速度清掉，否则会"贴着墙一直蓄力"，松手后弹出去
    if (moved.hitX) this.velocity.x = 0;
    if (moved.hitZ) this.velocity.z = 0;

    // 闪避结束的那一帧：把速度从 8.5 **收回到跑步速度**（方向不变）。
    // ⚠ 必须放在位移积分**之后**：本帧的位移要用 8.5 才算得准 2.975m；
    //   如果先收速度，闪避最后一帧就只按 4.2 走，位移会短一截。
    // ⚠ 不做这一步的后果很直观：闪避后残留的 8.5 m/s 要靠 DECEL(36) 衰减，
    //   松手状态下人还会自己**滑出去约 1m**——冰面手感，而且让 spec 的 2.975m 变成空话。
    if (dodgeExited) {
      const sp = this.horizontalSpeed;
      if (sp > cfg.WALK_SPEED) {
        const k = cfg.WALK_SPEED / sp;
        this.velocity.x *= k;
        this.velocity.z *= k;
      }
    }

    // ── 6. 竖直：先求脚下的支撑面，再积分
    //     必须先算支撑面再积分：走出箱子边缘时支撑面会掉到 0，人于是自然掉下去。
    this.support = supportHeight(this.position.x, this.position.z, this.shapes, 0, this.position.y);
    const vert = integrateVertical(
      { y: this.position.y, vy: this.vy, grounded: this.grounded },
      step,
      { gravity: J.GRAVITY, maxFall: J.MAX_FALL, support: this.support, epsilon: cfg.GROUND_EPSILON }
    );
    this.position.y = vert.y;
    this.vy = vert.vy;
    this.grounded = vert.grounded;
    if (vert.landed) {
      this.landedAt = this.time;
      this.onLand?.({ y: vert.y, support: vert.support });
    }
    // 土狼时间：**只有"走出边缘自然离地"才给**。起跳（vy>0）不该给，否则能跳第二次
    if (wasGrounded && !this.grounded && this.vy <= 0) this.coyoteTimer = J.COYOTE;
    else if (this.coyoteTimer > 0) this.coyoteTimer = Math.max(0, this.coyoteTimer - step);

    // ── 7. 朝向：有速度 → 转向速度方向；静止 → 跟随相机朝向
    const speedNow = this.horizontalSpeed;
    const faceTarget =
      speedNow > 0.2 ? facingFromDir(this.velocity.x, this.velocity.z) : facingFromDir(-Math.sin(cameraYaw), -Math.cos(cameraYaw));
    const turnRate = (speedNow > 0.2 ? cfg.MOVE_TURN_RATE_DEG : cfg.IDLE_TURN_RATE_DEG) * DEG * step;
    if (faceTarget !== null && Number.isFinite(faceTarget)) this.facing = turnToward(this.facing, faceTarget, turnRate);

    // ── 8. 状态标签（模块 7 的 UI / 模块 3 的动画分支都会读它）
    this.state = this.dodgeTimer > 0 ? 'dodge' : !this.grounded ? 'air' : speedNow > 0.2 ? 'move' : 'idle';

    return this.snapshot();
  }

  snapshot() {
    return {
      x: this.position.x,
      y: this.position.y,
      z: this.position.z,
      vy: this.vy,
      speed: this.horizontalSpeed,
      facing: this.facing,
      facingDeg: (this.facing / DEG) % 360,
      state: this.state,
      grounded: this.grounded,
      support: this.support,
      dodgeTimer: this.dodgeTimer,
      dodgeCooldown: this.dodgeCooldown,
      invincible: this.invincible,
      hp: this.hp,
      maxHp: this.maxHp,
      hpRatio: this.maxHp > 0 ? this.hp / this.maxHp : 0,
      invincibleTimer: this.invincibleTimer,
      alive: this.alive,
      dodges: this.dodges,
      jumps: this.jumps,
      hitWall: this.hitWall,
      clamped: this.clamped,
      overridden: this.overrideActive,
      forcedTotal: this.forcedTotal,
    };
  }
}
