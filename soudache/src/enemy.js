/**
 * 敌人 AI：状态机 PATROL → SUSPICIOUS → COMBAT → SEARCH → PATROL
 *
 * 感知：视野锥（朝向 + 锥角 + 距离）+ 视线遮挡检测 + 听觉（枪声 / 脚步噪音）
 * 行动：BFS 流场寻路 + 掩体走位 + 点射压制 + 同伴增援
 */

import { ENEMY_TYPES, AI, CELL, ROPE, TILE, WORLD_W, WORLD_H } from './config.js';
import {
  hasLineOfSight, moveWithCollision, isSolidAt, getFlowField, flowDirection, randomPointInRoom,
  elevationAt, cellAt, crateRectIndexAt, damageCrateRect,
} from './mapgen.js';
import { createWeaponState, updateWeapon, fireWeapon, startReload } from './combat.js';

/** AI 状态枚举 */
export const EnemyState = {
  PATROL: 'PATROL',
  SUSPICIOUS: 'SUSPICIOUS',
  COMBAT: 'COMBAT',
  SEARCH: 'SEARCH',
  DEAD: 'DEAD',
};

/** 归一化角度差到 [-PI, PI] */
function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** 角度插值 */
function angleLerp(from, to, t) {
  return from + angleDiff(to, from) * Math.min(1, Math.max(0, t));
}

/**
 * 敌人类。
 */
export class Enemy {
  /**
   * @param {string} typeId 敌人类型（patrol / elite）
   * @param {number} x 出生 x
   * @param {number} y 出生 y
   * @param {number} id 唯一编号
   * @param {object} rng 随机数发生器
   */
  constructor(typeId, x, y, id, rng) {
    const def = ENEMY_TYPES[typeId] || ENEMY_TYPES.patrol;
    this.def = def;
    this.typeId = def.id;
    this.id = id;
    this.faction = 'enemy';
    this.isPlayer = false;
    this.name = def.name;

    this.x = x;
    this.y = y;
    this.radius = def.radius;
    this.angle = rng.float(0, Math.PI * 2);
    this.hp = def.hp;
    this.maxHp = def.hp;
    this.armor = def.armor;
    this.maxArmor = def.armor;
    this.dead = false;

    this.weapon = createWeaponState(def.weapon);
    this.state = EnemyState.PATROL;
    this.stateTime = 0;
    this.rng = rng;

    this.lastKnown = null;
    this.lastSeenTime = 99;
    this.lostTimer = 0;
    this.reactionTimer = 0;
    this.searchTimer = 0;
    this.searchHops = 0;
    this.waitTimer = 0;
    this.patrolTarget = null;

    this.fireTimer = rng.float(def.fireDelay[0], def.fireDelay[1]);
    this.burstLeft = 0;
    this.burstDelay = 0;
    this.strafeDir = rng.chance(0.5) ? 1 : -1;
    this.strafeTimer = rng.float(1.0, 2.4);
    this.turnRate = 6;

    this.flowTargetTile = -1;
    this.flowTimer = 0;
    this.field = null;
    this.stuckTimer = 0;
    this.lastPos = { x, y };

    // 巡逻路线：出生房间附近的若干路点，PATROL 状态沿其循环移动（更像战术巡逻）
    this.patrolRoute = null;
    this.patrolIndex = 0;
    // 守点撤离点编号（guardOf != null 时受拴绳限制，不远离该撤离点）
    this.guardOf = null;

    this.muzzleFlash = 0;
    this.hurtFlash = 0;
    this.recoilOffset = 0;
    this.fireLocked = false;
    this.alerted = false;
    this.walkPhase = 0;

    // --- 战术行为：抢占高地 ---
    this.highGroundSpot = null; // 正在前往的平台中心
    this.highGroundCd = 0; // 抢占冷却
    this.highGroundTimer = 0; // 本次抢占的剩余移动时间

    // --- 战术行为：破坏掩体 ---
    this.breachCd = 0; // 拆箱子的射击间隔
    this.breachBlocked = 0; // 被掩体挡住视线的累计时长
  }

  /** 当前武器（combat.js 约定） */
  get currentWeapon() {
    return this.weapon;
  }

  /**
   * 切换状态。
   * @param {string} state 新状态
   * @returns {void}
   */
  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.stateTime = 0;
    if (state !== EnemyState.COMBAT) this.clearTactics();
    if (state === EnemyState.SEARCH) {
      this.searchTimer = 7;
      this.searchHops = 0;
    }
    if (state === EnemyState.COMBAT) {
      this.alerted = true;
      this.lostTimer = 0;
      // 进入交战后留一个开火犹豫窗口，给玩家反应时间
      this.fireTimer = Math.max(this.fireTimer, this.def.reactionTime + 0.3);
    }
    if (state === EnemyState.PATROL) {
      this.lastKnown = null;
      this.alerted = false;
    }
  }

  /**
   * 目标是否处于草丛中。
   * @param {object} world 战局上下文
   * @param {object} target 目标
   * @returns {boolean} 是否在草丛
   */
  isInBush(world, target) {
    for (const bush of world.map.bushes) {
      if (Math.hypot(bush.x - target.x, bush.y - target.y) <= bush.r) return true;
    }
    return false;
  }

  /**
   * 能否看到目标。
   * @param {object} world 战局上下文
   * @param {object} target 目标
   * @returns {boolean} 是否可见
   */
  canSee(world, target) {
    if (!target || target.dead) return false;
    const dx = target.x - this.x;
    const dy = target.y - this.y;
    const dist = Math.hypot(dx, dy);
    let range = this.def.visionRange;
    if (target.crouching) range *= 0.72;
    if (this.isInBush(world, target) && dist > 130) range *= 0.4;
    if (dist > range) return false;
    if (dist > 90) {
      const toTarget = Math.atan2(dy, dx);
      if (Math.abs(angleDiff(toTarget, this.angle)) > this.def.visionAngle / 2) return false;
    }
    return hasLineOfSight(world.map, this.x, this.y, target.x, target.y);
  }

  /**
   * 听到噪音。
   * @param {object} world 战局上下文
   * @param {number} x 声源 x
   * @param {number} y 声源 y
   * @param {number} radius 噪音半径
   * @returns {void}
   */
  hearNoise(world, x, y, radius) {
    if (this.dead) return;
    const dist = Math.hypot(x - this.x, y - this.y);
    if (dist > radius) return;
    const clarity = 1 - dist / Math.max(1, radius);
    const err = 60 * (1 - clarity);
    const point = { x: x + this.rng.float(-err, err), y: y + this.rng.float(-err, err) };
    this.lastKnown = point;
    if (this.state === EnemyState.PATROL) {
      this.setState(EnemyState.SUSPICIOUS);
      this.reactionTimer = this.def.reactionTime * 1.4;
    } else if (this.state === EnemyState.SEARCH) {
      this.searchTimer = Math.max(this.searchTimer, 5);
    }
  }

  /**
   * 同伴呼叫增援。
   * @param {object} world 战局上下文
   * @param {number} x 目标 x
   * @param {number} y 目标 y
   * @returns {void}
   */
  onAllyAlert(world, x, y) {
    if (this.dead || this.state === EnemyState.COMBAT) return;
    this.lastKnown = { x: x + this.rng.float(-40, 40), y: y + this.rng.float(-40, 40) };
    if (this.state === EnemyState.PATROL) {
      this.setState(EnemyState.SUSPICIOUS);
      this.reactionTimer = this.def.reactionTime * 0.7;
    } else if (this.state === EnemyState.SEARCH) {
      this.searchTimer = Math.max(this.searchTimer, 6);
    }
  }

  /**
   * 被命中时的反应。
   * @param {object} source 伤害来源
   * @param {object} world 战局上下文
   * @returns {void}
   */
  onDamaged(source, world) {
    this.hurtFlash = 0.3;
    const from = source || (this.lastKnown ? { x: this.lastKnown.x, y: this.lastKnown.y } : null);
    if (from) this.lastKnown = { x: from.x, y: from.y };
    if (this.state !== EnemyState.COMBAT) {
      this.setState(EnemyState.COMBAT);
      this.reactionTimer = 0;
    }
    if (world && world.alertNearby && this.lastKnown) {
      world.alertNearby(this, this.lastKnown.x, this.lastKnown.y, 300);
    }
  }

  /**
   * 每帧更新。
   * @param {number} dt 帧间隔秒
   * @param {object} world 战局上下文
   * @returns {void}
   */
  update(dt, world) {
    if (this.dead) return;
    this.stateTime += dt;
    this.muzzleFlash = Math.max(0, this.muzzleFlash - dt);
    this.hurtFlash = Math.max(0, this.hurtFlash - dt);
    this.recoilOffset *= Math.max(0, 1 - dt * 6);
    updateWeapon(dt, this, world);

    const player = world.player;
    const visible = this.canSee(world, player);
    if (visible) {
      this.lastKnown = { x: player.x, y: player.y };
      this.lastSeenTime = 0;
      this.lostTimer = 0;
    } else {
      this.lastSeenTime += dt;
      this.lostTimer += dt;
    }

    this.think(dt, world, player, visible);
    this.act(dt, world, player, visible);

    // 卡死检测：位置长时间不变则强制换一个目标点
    const moved = Math.hypot(this.x - this.lastPos.x, this.y - this.lastPos.y);
    if (moved < 0.4 && this.wantsMove) {
      this.stuckTimer += dt;
      if (this.stuckTimer > 0.8) {
        this.stuckTimer = 0;
        this.strafeDir *= -1;
        if (this.state === EnemyState.PATROL) this.patrolTarget = null;
        else if (this.state === EnemyState.SEARCH) {
          this.searchHops += 1;
          this.lastKnown = this.jitterPoint(world, this.lastKnown, 180);
        }
      }
    } else {
      this.stuckTimer = 0;
    }
    this.lastPos = { x: this.x, y: this.y };
  }

  /**
   * 状态转移与决策。
   * @param {number} dt 帧间隔秒
   * @param {object} world 战局上下文
   * @param {object} player 玩家
   * @param {boolean} visible 是否看得见玩家
   * @returns {void}
   */
  think(dt, world, player, visible) {
    switch (this.state) {
      case EnemyState.PATROL:
        if (visible) {
          this.setState(EnemyState.SUSPICIOUS);
          this.reactionTimer = this.def.reactionTime;
          if (world.audio) world.audio.enemyAlert(this.distanceTo(world.player));
        }
        break;
      case EnemyState.SUSPICIOUS: {
        this.reactionTimer -= dt;
        if (visible) {
          this.reactionTimer -= dt * 0.6; // 持续暴露会更快确认
          if (this.reactionTimer <= 0) {
            this.setState(EnemyState.COMBAT);
            if (world.audio) world.audio.enemyAlert(this.distanceTo(world.player));
            if (world.alertNearby) world.alertNearby(this, player.x, player.y, 360);
          }
        } else if (this.lastSeenTime > 2.5) {
          this.setState(EnemyState.SEARCH);
        }
        break;
      }
      case EnemyState.COMBAT:
        if (!visible && this.lostTimer > 1.1) {
          this.setState(EnemyState.SEARCH);
        }
        break;
      case EnemyState.SEARCH: {
        this.searchTimer -= dt;
        if (visible) {
          this.setState(EnemyState.COMBAT);
          if (world.alertNearby) world.alertNearby(this, player.x, player.y, 300);
        } else if (this.searchTimer <= 0) {
          this.setState(EnemyState.PATROL);
        }
        break;
      }
      default:
        break;
    }
  }

  /* ====================== 战术行为：抢占高地 ====================== */

  /**
   * 挑一个值得占领的高地。
   *
   * 高地之所以有价值：hasLineOfSight 里任一端站在平台上就会获得"越过掩体观察"的能力，
   * 所以站上去往往能直接看到蹲在箱子后面的玩家。
   * 评分 = 自己到平台的距离 * holdWeight + |平台到目标距离 - 理想射距|，越小越优先。
   * @param {object} world 战局上下文
   * @param {object} target 目标点（玩家或最后已知位置）
   * @returns {?object} 平台中心 {x, y}，没有合适的则返回 null
   */
  pickHighGround(world, target) {
    const cfg = AI.highGround;
    if (!cfg.enabled) return null;
    const plats = world.map.platforms;
    if (!plats || !plats.length) return null;
    // 已经在某块平台上，不用再抢
    if (elevationAt(world.map, this.x, this.y) > 0.5) return null;

    let best = null;
    let bestScore = Infinity;
    for (const p of plats) {
      const px = p.x + p.w / 2;
      const py = p.y + p.h / 2;
      const dSelf = Math.hypot(px - this.x, py - this.y);
      if (dSelf > cfg.maxDist || dSelf < cfg.arriveDist) continue;
      const dTarget = Math.hypot(target.x - px, target.y - py);
      if (dTarget > this.def.weapon.range) continue;
      // 站上去必须真能看到目标，否则白跑一趟
      if (!hasLineOfSight(world.map, px, py, target.x, target.y)) continue;
      const score = dSelf * cfg.holdWeight + Math.abs(dTarget - this.def.preferredRange);
      if (score < bestScore) {
        bestScore = score;
        best = { x: px, y: py };
      }
    }
    return best;
  }

  /**
   * 抢占高地的每帧推进：返回 true 表示本帧应该朝 highGroundSpot 移动。
   * 到位 / 超时 / 冷却中都会放弃，交回给普通走位逻辑。
   * @param {number} dt 帧间隔秒
   * @param {object} world 战局上下文
   * @param {object} target 目标点
   * @returns {boolean} 是否在抢占高地
   */
  seizeHighGround(dt, world, target) {
    const cfg = AI.highGround;
    if (!cfg.enabled) return false;

    // 已有目标点：走过去，到位或超时就收工
    if (this.highGroundSpot) {
      this.highGroundTimer -= dt;
      const d = Math.hypot(this.highGroundSpot.x - this.x, this.highGroundSpot.y - this.y);
      if (d < cfg.arriveDist || this.highGroundTimer <= 0) {
        this.highGroundSpot = null;
        this.highGroundCd = cfg.cooldown;
        return false;
      }
      return true;
    }

    if (this.highGroundCd > 0) {
      this.highGroundCd -= dt;
      return false;
    }
    const spot = this.pickHighGround(world, target);
    if (!spot) return false;
    this.highGroundSpot = spot;
    this.highGroundTimer = cfg.travelTime;
    return true;
  }

  /** 离开交战状态时清掉高地意图，避免带着旧目标点乱跑 */
  clearTactics() {
    this.highGroundSpot = null;
    this.breachBlocked = 0;
  }

  /* ====================== 战术行为：破坏掩体 ====================== */

  /**
   * 找出"自己 → 目标"之间第一个挡路的掩体箱。
   * 中途若先撞上真正的墙，就没有拆箱子的意义（拆了也打不到），返回 null。
   * @param {object} world 战局上下文
   * @param {object} target 目标点
   * @returns {?object} {ri, x, y} 箱子 rect 下标与命中点，无则 null
   */
  findBlockingCrate(world, target) {
    const dx = target.x - this.x;
    const dy = target.y - this.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) return null;
    const step = world.map.tile * 0.35;
    const steps = Math.ceil(dist / step);
    for (let i = 1; i < steps; i += 1) {
      const t = i / steps;
      const wx = this.x + dx * t;
      const wy = this.y + dy * t;
      const cell = cellAt(world.map, wx, wy);
      if (cell === CELL.WALL) return null;
      if (cell === CELL.CRATE) {
        const ri = crateRectIndexAt(world.map, wx, wy);
        if (ri >= 0 && !world.map.crateRects[ri].destroyed) return { ri, x: wx, y: wy };
        return null;
      }
    }
    return null;
  }

  /**
   * 打不通就打箱子：看不到玩家、且确认是被掩体箱挡住时，主动把箱子拆掉打开射界。
   * 只在 COMBAT 下触发，且要先"憋" lostTime 秒，避免刚一丢目标就无脑扫射。
   * @param {number} dt 帧间隔秒
   * @param {object} world 战局上下文
   * @param {object} player 玩家
   * @param {boolean} visible 是否看得见玩家
   * @returns {void}
   */
  tryBreach(dt, world, player, visible) {
    const cfg = AI.breach;
    if (!cfg.enabled) return;
    if (visible) {
      this.breachBlocked = 0;
      return;
    }
    const aim = player.dead ? this.lastKnown : (this.lastKnown || player);
    if (!aim) {
      this.breachBlocked = 0;
      return;
    }
    if (this.breachCd > 0) {
      this.breachCd -= dt;
      return;
    }
    const dist = Math.hypot(aim.x - this.x, aim.y - this.y);
    if (dist > cfg.maxDist || dist > this.def.weapon.range) {
      this.breachBlocked = 0;
      return;
    }
    const crate = this.findBlockingCrate(world, aim);
    if (!crate) {
      this.breachBlocked = 0;
      return;
    }
    this.breachBlocked += dt;
    if (this.breachBlocked < cfg.lostTime) return;

    // 开火拆箱：真实消耗弹药并进入武器冷却，不能白嫖
    const want = Math.atan2(crate.y - this.y, crate.x - this.x);
    this.angle = angleLerp(this.angle, want, 1 - Math.exp(-8 * dt));
    const res = damageCrateRect(world.map, crate.ri, this.def.weapon.damage * cfg.damageScale);
    this.weapon.ammo = Math.max(0, this.weapon.ammo - cfg.ammoPerShot);
    this.weapon.cooldown = Math.max(this.weapon.cooldown, 60 / this.def.weapon.rpm);
    this.breachCd = cfg.fireDelay;
    this.muzzleFlash = Math.max(this.muzzleFlash, 0.06);
    if (world.audio && world.audio.crateHit) world.audio.crateHit();
    if (res.destroyed) {
      if (world.audio && world.audio.crateBreak) world.audio.crateBreak();
      if (world.spawnImpact) world.spawnImpact(crate.x, crate.y, want);
      this.breachBlocked = 0;
    }
  }

  /**
   * 执行移动、转向与射击。
   * @param {number} dt 帧间隔秒
   * @param {object} world 战局上下文
   * @param {object} player 玩家
   * @param {boolean} visible 是否看得见玩家
   * @returns {void}
   */
  act(dt, world, player, visible) {
    let moveTarget = null;
    let speed = this.def.speed;
    let faceTarget = null;

    if (this.state === EnemyState.PATROL) {
      speed = this.def.speed * 0.72;
      // 守点敌人：以撤离点为中心小幅游走
      let home = null;
      if (this.guardOf != null) {
        const ex = world.map.extracts[this.guardOf];
        if (ex) home = ex;
      }
      if (!this.patrolTarget) {
        if (home) {
          this.patrolTarget = { x: home.x + this.rng.float(-90, 90), y: home.y + this.rng.float(-90, 90) };
        } else if (this.patrolRoute && this.patrolRoute.length) {
          this.patrolTarget = this.patrolRoute[this.patrolIndex % this.patrolRoute.length];
          this.patrolIndex += 1;
        } else {
          this.patrolTarget = randomPointInRoom(world.map, this.rng.pick(world.map.rooms), this.rng);
        }
        this.waitTimer = 0;
      }
      if (this.waitTimer > 0) {
        this.waitTimer -= dt;
        // 原地扫视
        this.angle += Math.sin(this.stateTime * 1.4) * dt * 1.2;
        this.wantsMove = false;
      } else {
        moveTarget = this.patrolTarget;
        if (Math.hypot(moveTarget.x - this.x, moveTarget.y - this.y) < 34) {
          this.patrolTarget = null;
          this.waitTimer = this.rng.float(1.0, 2.6);
        }
      }
    } else if (this.state === EnemyState.SUSPICIOUS) {
      speed = this.def.speed * 0.6;
      const look = visible ? player : this.lastKnown;
      if (look) {
        faceTarget = look;
        const dist = Math.hypot(look.x - this.x, look.y - this.y);
        if (dist > 160) moveTarget = look;
      }
    } else if (this.state === EnemyState.COMBAT) {
      const target = visible ? player : this.lastKnown;
      if (target) {
        faceTarget = target;
        const dist = Math.hypot(target.x - this.x, target.y - this.y);
        const pref = this.def.preferredRange;
        const lowHp = this.hp < this.maxHp * 0.35;
        if (lowHp && visible) {
          // 低血量后撤
          moveTarget = { x: this.x - (target.x - this.x), y: this.y - (target.y - this.y) };
          speed = this.def.speed * 1.05;
        } else if (this.seizeHighGround(dt, world, target)) {
          // 抢占高地：站上平台可越过掩体观察，优先于普通走位
          moveTarget = this.highGroundSpot;
          speed = this.def.speed * 1.05;
        } else if (dist > pref * 1.2) {
          moveTarget = target;
          speed = this.def.speed * 1.02;
        } else if (dist < pref * 0.55) {
          moveTarget = { x: this.x - (target.x - this.x), y: this.y - (target.y - this.y) };
          speed = this.def.speed * 0.9;
        } else if (this.def.holdsPosition) {
          // 精确射手：进入理想射距后原地架枪，不做横向走位（保持射击线稳定）
          this.wantsMove = false;
        } else {
          // 横向走位
          this.strafeTimer -= dt;
          if (this.strafeTimer <= 0) {
            this.strafeTimer = this.rng.float(1.0, 2.4);
            this.strafeDir *= -1;
          }
          const dx = target.x - this.x;
          const dy = target.y - this.y;
          const len = Math.hypot(dx, dy) || 1;
          moveTarget = {
            x: this.x + (-dy / len) * this.strafeDir * 120,
            y: this.y + (dx / len) * this.strafeDir * 120,
          };
          speed = this.def.speed * 0.85;
        }
      }
    } else if (this.state === EnemyState.SEARCH) {
      speed = this.def.speed * 0.95;
      if (this.lastKnown) {
        faceTarget = this.lastKnown;
        const dist = Math.hypot(this.lastKnown.x - this.x, this.lastKnown.y - this.y);
        if (dist > 46) {
          moveTarget = this.lastKnown;
        } else if (this.searchHops < 2) {
          this.searchHops += 1;
          this.lastKnown = this.jitterPoint(world, this.lastKnown, 220);
          this.searchTimer = Math.max(this.searchTimer, 3.5);
        } else {
          this.angle += Math.sin(this.stateTime * 2.0) * dt * 2.0;
          this.wantsMove = false;
        }
      }
    }

    // 守点拴绳：非交战状态下，若离负责的撤离点过远则拉回，避免被引离点位
    if (this.guardOf != null && this.state !== EnemyState.COMBAT) {
      const ex = world.map.extracts[this.guardOf];
      if (ex) {
        const gd = Math.hypot(ex.x - this.x, ex.y - this.y);
        if (gd > 150) {
          moveTarget = { x: ex.x, y: ex.y };
          speed = this.def.speed * 0.95;
        }
      }
    }

    // 转向
    if (faceTarget) {
      const want = Math.atan2(faceTarget.y - this.y, faceTarget.x - this.x);
      const rate = this.state === EnemyState.COMBAT ? 9 : 5;
      this.angle = angleLerp(this.angle, want, 1 - Math.exp(-rate * dt));
    }

    // 移动
    if (moveTarget) {
      this.wantsMove = true;
      this.moveToward(dt, world, moveTarget.x, moveTarget.y, speed);
    } else {
      this.wantsMove = false;
    }

    // 分离，避免叠在一起
    this.separate(dt, world);

    // 射击
    this.updateFiring(dt, world, player, visible);
  }

  /**
   * 点射逻辑。
   * @param {number} dt 帧间隔秒
   * @param {object} world 战局上下文
   * @param {object} player 玩家
   * @param {boolean} visible 是否看得见玩家
   * @returns {void}
   */
  updateFiring(dt, world, player, visible) {
    if (this.state !== EnemyState.COMBAT || player.dead) return;
    // 看不见玩家时转为"拆掩体"：主动打掉挡住射界的箱子，而不是干站着
    if (!visible) {
      this.tryBreach(dt, world, player, false);
      return;
    }
    const dist = Math.hypot(player.x - this.x, player.y - this.y);
    if (dist > this.def.weapon.range) return;
    if (!hasLineOfSight(world.map, this.x, this.y, player.x, player.y)) return;

    // 玩家正在绳索速降时更难打中（高速滑降是有效的脱战手段）
    const acc = player.ropelling ? this.def.accuracy * ROPE.evadeMul : this.def.accuracy;

    if (this.burstLeft > 0) {
      this.burstDelay -= dt;
      if (this.burstDelay <= 0) {
        fireWeapon(world, this, { accuracy: acc });
        this.burstLeft -= 1;
        this.burstDelay = 60 / this.def.weapon.rpm;
      }
      return;
    }
    this.fireTimer -= dt;
    if (this.fireTimer <= 0) {
      if (this.weapon.ammo <= 0) {
        startReload(this, world);
        this.fireTimer = this.def.weapon.reloadTime + 0.2;
        return;
      }
      this.burstLeft = this.rng.int(this.def.burst[0], this.def.burst[1]);
      this.burstDelay = 0;
      this.fireTimer = this.rng.float(this.def.fireDelay[0], this.def.fireDelay[1])
        * (dist > 380 ? 1.3 : 1);
    }
  }

  /**
   * 沿流场或直线移动到目标点。
   * @param {number} dt 帧间隔秒
   * @param {object} world 战局上下文
   * @param {number} tx 目标 x
   * @param {number} ty 目标 y
   * @param {number} speed 速度
   * @returns {void}
   */
  moveToward(dt, world, tx, ty, speed) {
    let dir = null;
    const dist = Math.hypot(tx - this.x, ty - this.y);
    if (dist < 220 && hasLineOfSight(world.map, this.x, this.y, tx, ty)) {
      dir = { x: (tx - this.x) / (dist || 1), y: (ty - this.y) / (dist || 1) };
    } else {
      const ttx = Math.floor(tx / TILE);
      const tty = Math.floor(ty / TILE);
      const tile = ttx + tty * world.map.cols;
      this.flowTimer -= dt;
      if (!this.field || tile !== this.flowTargetTile || this.flowTimer <= 0) {
        this.flowTimer = 0.45;
        this.flowTargetTile = tile;
        this.field = getFlowField(world.map, ttx, tty);
      }
      dir = flowDirection(world.map, this.field, this.x, this.y);
      if (!dir) dir = { x: (tx - this.x) / (dist || 1), y: (ty - this.y) / (dist || 1) };
    }
    const next = moveWithCollision(world.map, this.x, this.y, dir.x * speed * dt, dir.y * speed * dt, this.radius);
    this.x = next.x;
    this.y = next.y;
    this.walkPhase += dt * 8;
    // 移动时身体朝向跟随移动方向（交战/警觉时由 act 的转向逻辑覆盖）
    if (this.state === EnemyState.PATROL || this.state === EnemyState.SEARCH) {
      const want = Math.atan2(dir.y, dir.x);
      this.angle = angleLerp(this.angle, want, 1 - Math.exp(-4 * dt));
    }
  }

  /**
   * 与附近同伴保持间距。
   * @param {number} dt 帧间隔秒
   * @param {object} world 战局上下文
   * @returns {void}
   */
  separate(dt, world) {
    let px = 0;
    let py = 0;
    let n = 0;
    for (const other of world.enemies) {
      if (other === this || other.dead) continue;
      const dx = this.x - other.x;
      const dy = this.y - other.y;
      const d = Math.hypot(dx, dy);
      if (d > 0.01 && d < this.radius + other.radius + 6) {
        px += dx / d;
        py += dy / d;
        n += 1;
      }
    }
    if (!n) return;
    const len = Math.hypot(px, py) || 1;
    const push = 42 * dt;
    const next = moveWithCollision(
      world.map, this.x, this.y, (px / len) * push, (py / len) * push, this.radius,
    );
    this.x = next.x;
    this.y = next.y;
  }

  /**
   * 在给定点附近抖动出一个可站立的新点（用于搜索走位）。
   * @param {object} world 战局上下文
   * @param {object} point 原点
   * @param {number} radius 抖动半径
   * @returns {{x: number, y: number}} 新点
   */
  jitterPoint(world, point, radius) {
    const base = point || { x: this.x, y: this.y };
    for (let i = 0; i < 10; i += 1) {
      const p = {
        x: base.x + this.rng.float(-radius, radius),
        y: base.y + this.rng.float(-radius, radius),
      };
      if (p.x < TILE || p.y < TILE || p.x > WORLD_W - TILE || p.y > WORLD_H - TILE) continue;
      if (isSolidAt(world.map, p.x, p.y)) continue;
      return p;
    }
    return { x: base.x, y: base.y };
  }

  /**
   * 到玩家的距离。
   * @param {object} player 玩家
   * @returns {number} 距离
   */
  distanceTo(player) {
    return Math.hypot(player.x - this.x, player.y - this.y);
  }

  /** 状态显示名（HUD / 调试用） */
  get stateLabel() {
    switch (this.state) {
      case EnemyState.PATROL: return '巡逻';
      case EnemyState.SUSPICIOUS: return '警觉';
      case EnemyState.COMBAT: return '交战';
      case EnemyState.SEARCH: return '搜索';
      default: return '阵亡';
    }
  }
}

/**
 * 创建一批敌人。
 * @param {object} map 地图
 * @param {object} rng 随机数发生器
 * @returns {Array<Enemy>} 敌人数组
 */
export function spawnEnemies(map, rng) {
  return map.enemySpawns.map((spawn, i) => {
    const e = new Enemy(spawn.type, spawn.x, spawn.y, i, rng.fork(i + 1));
    if (spawn.guardOf != null) e.guardOf = spawn.guardOf;
    // 巡逻路线：取若干随机房间地面点，让敌人沿固定路线往返而非纯随机游走
    e.patrolRoute = map.rooms
      .map((room) => randomPointInRoom(map, room, rng.fork(i * 7 + 13)))
      .sort(() => rng.float(-1, 1))
      .slice(0, 3);
    return e;
  });
}
