/**
 * 敌人 AI：状态机 PATROL → SUSPICIOUS → COMBAT → SEARCH → PATROL
 *
 * 感知：视野锥（朝向 + 锥角 + 距离）+ 视线遮挡检测 + 听觉（枪声 / 脚步噪音）
 * 行动：BFS 流场寻路 + 掩体走位 + 点射压制 + 同伴增援
 */

import { ENEMY_TYPES, BOSSES, AI, CELL, ROPE, TILE, WORLD_W, WORLD_H, VIEW3D } from './config.js';
import {
  hasLineOfSight, moveWithCollision, isSolidAt, getFlowField, flowDirection, randomPointInRoom,
  elevationAt, cellAt, crateRectIndexAt, damageCrateRect,
} from './mapgen.js';
import { createWeaponState, updateWeapon, fireWeapon, startReload, applyDamage } from './combat.js';
import { smokeBlocks, blastAttenuation } from './throwable.js';
import {
  sightRange, inCone, hearingError, nearestTrace,
  addSuppression, decaySuppression, suppressionAccuracyMul, suppressionFireDelayMul, shouldTakeCover,
} from './perception.js';

/** 1 米 = 20 逻辑单位；与 throwable.js / models.js 的换算口径一致 */
const U = VIEW3D.metersToUnits;

/**
 * AI 状态枚举（P21 补齐指令书要求的六态）
 *
 * IDLE          待机：站定环视，玩家能从他"在看哪边"规划绕行
 * PATROL        巡逻：沿路点循环
 * ALERT_PATROL  警戒巡逻：搜索超时后的高压巡逻，视距更远、走更快，到期回 PATROL
 * SUSPICIOUS    警觉：听到/瞥见，原地确认
 * INVESTIGATING 调查：循痕迹或声源走过去看（**不是**知道你在哪）
 * COMBAT        交战
 * SEARCH        搜索：在最后已知点附近扫荡
 * DEAD          阵亡
 */
export const EnemyState = {
  IDLE: 'IDLE',
  PATROL: 'PATROL',
  ALERT_PATROL: 'ALERT_PATROL',
  SUSPICIOUS: 'SUSPICIOUS',
  INVESTIGATING: 'INVESTIGATING',
  COMBAT: 'COMBAT',
  SEARCH: 'SEARCH',
  DEAD: 'DEAD',
};

/** 非战斗态：都能被"看到 / 听到 / 踩到痕迹"打断 */
export const CALM_STATES = [
  EnemyState.IDLE,
  EnemyState.PATROL,
  EnemyState.ALERT_PATROL,
  EnemyState.INVESTIGATING,
];

/**
 * 是否处于非战斗态。
 * @param {string} state 状态
 * @returns {boolean} 是否平静
 */
export function isCalmState(state) {
  return CALM_STATES.indexOf(state) >= 0;
}

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
  constructor(typeId, x, y, id, rng, overrideDef) {
    const def = overrideDef || ENEMY_TYPES[typeId] || ENEMY_TYPES.patrol;
    this.def = def;
    this.typeId = def.id;
    this.id = id;
    this.faction = 'enemy';
    this.isPlayer = false;
    this.isBoss = !!overrideDef;
    this.name = def.name;

    this.x = x;
    this.y = y;
    // P22：自己的"家"= 出生点。追丢目标后不在地图另一头继续溜达，而是先回这片区域。
    this.homePoint = { x, y };
    this.returningHome = false;
    this.radius = def.radius;
    this.angle = rng.float(0, Math.PI * 2);
    this.hp = def.hp;
    this.maxHp = def.hp;
    this.armor = def.armor;
    this.maxArmor = def.armor;
    // P7：护甲等级用于弹种穿透判定；缺省 0 表示"无甲"，旧兵种配置也能读。
    this.armorLevel = def.armorLevel || 0;
    this.dead = false;
    // P16 首领战状态：普通敌人也预置，避免 HUD / 结算读到 undefined 时走不同分支。
    // `bossPhaseIndex = null` 是「尚未初始化」的标记：syncBossPhase 首次调用只记录
    // 当前阶段，不触发播报（否则一进图就喊"进入阶段 I"）。
    this.armorBroken = false;
    this.bossPhaseIndex = null;
    this.bossPhase = 1;

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
    // 震撼弹眩晕（P5）：>0 时完全冻结 —— 不移动、不思考、不开火。
    // 与"受伤硬直"分开：硬直只影响动作，眩晕连决策一起停，被闪的人不会一边站桩一边转点。
    this.stun = 0;
    this.alerted = false;
    this.walkPhase = 0;

    // --- 战术行为：抢占高地 ---
    this.highGroundSpot = null; // 正在前往的平台中心
    this.highGroundCd = 0; // 抢占冷却
    this.highGroundTimer = 0; // 本次抢占的剩余移动时间

    // --- 战术行为：破坏掩体 ---
    this.breachCd = 0; // 拆箱子的射击间隔
    this.breachBlocked = 0; // 被掩体挡住视线的累计时长

    // --- 首领专属字段（普通敌人这些为 undefined，actBoss 不会被执行）---
    this.behavior = def.behavior || null;
    this.leash = def.leash || 0; // 锚定据点的最大活动半径
    this.reinforceTimer = def.reinforceInterval || 0; // 距下次呼叫增援的秒数
    this.flankCd = 0; // 距下次重选侧翼突进点的秒数
    this.flankPoint = null; // 当前侧翼突进目标
    this.home = null; // 出生点（bulwark 锚定用）

    // --- 通用 AI 协作 / 投掷字段（P9：感知协同 + 敌投掷物）---
    this.shareCd = 0; // 协同索敌广播冷却
    this.grenadeCd = def.grenadeInterval || 0; // 投掷物冷却（仅 def.canThrow 生效）
    this.flanker = false; // 是否承担侧翼包抄（与正面推进的敌人形成交叉火力）
    this.flankSide = 1; // 包抄方向（左/右）

    // --- P21 感知 / 压制 / 新状态字段 ---
    this.suppression = 0; // 0~1 被火力压制程度：降精度、延迟开火、逼他找掩体
    this.idleTimer = 0; // IDLE 剩余停留（复用 waitTimer 的随机值，不额外抽 rng）
    this.investigateTimer = 0; // INVESTIGATING 剩余时长
    this.investigateTarget = null; // 调查目标（痕迹 / 声源点）
    this.alertTimer = 0; // ALERT_PATROL 剩余时长
    this.coverPoint = null; // 掩体点
    this.coverTimer = 0; // 掩体点重选冷却
    this.dodgeCd = 0; // 躲投掷物冷却
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
    // P21 新状态：各自初始化计时，避免所有状态共用一套计时器互相踩。
    if (state === EnemyState.IDLE) {
      const st = AI.states || {};
      this.idleTimer = this.waitTimer > 0
        ? this.waitTimer
        : ((st.idleMin || 2.5) + (st.idleMax || 5.5)) / 2;
      this.wantsMove = false;
    }
    if (state === EnemyState.INVESTIGATING) {
      const st = AI.states || {};
      this.investigateTimer = st.investigateTime || 6.5;
      this.investigateTarget = this.lastKnown
        ? { x: this.lastKnown.x, y: this.lastKnown.y }
        : null;
      this.alerted = true;
    }
    if (state === EnemyState.ALERT_PATROL) {
      const st = AI.states || {};
      this.alertTimer = st.alertPatrolTime || 26;
      this.alerted = true;
      this.lastKnown = null;
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
    // P21：视距修正收进 perception.sightRange（系数与旧实现逐位一致，只是多了警戒态倍率）。
    // 关键：这里只算"能看多远"，看不看得见仍由下面的 LOS 与烟幕拍板 —— 没有透视后门。
    const range = sightRange(this.def.visionRange, {
      dist,
      // 干员被动「低可探测」：只缩短敌人对**玩家**的发现距离，不影响队友与敌人互看。
      stealthMul: target.isPlayer ? target.stealthMul : 0,
      crouching: !!target.crouching,
      inBush: this.isInBush(world, target),
      alertMul: this.state === EnemyState.ALERT_PATROL ? (AI.sight && AI.sight.alertMul) : 0,
    });
    if (dist > range) return false;
    if (!inCone(dx, dy, this.angle, this.def.visionAngle / 2, dist, AI.sight && AI.sight.nearRadius)) {
      return false;
    }
    if (!hasLineOfSight(world.map, this.x, this.y, target.x, target.y)) return false;
    // 烟幕（P5）：视线段穿过烟球就看不见。放在 LOS 之后，先用便宜的墙体判定短路。
    if (world.smokes && smokeBlocks(world.smokes, this.x, this.y, target.x, target.y)) return false;
    return true;
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
    const cfg = AI.perception;
    const clarity = 1 - dist / Math.max(1, radius);
    // P9 听声辨位精度：误差随距离平方增长，并按兵种听觉半径缩放（耳朵越灵定位越准）。
    // P21 公式搬进 perception.hearingError，本文件只负责"听到之后做什么"。
    const err = hearingError({ dist, radius, hearing: this.def.hearing });
    const point = { x: x + this.rng.float(-err, err), y: y + this.rng.float(-err, err) };
    this.lastKnown = point;
    if (this.state === EnemyState.PATROL) {
      this.setState(EnemyState.SUSPICIOUS);
      this.reactionTimer = this.def.reactionTime * 1.4;
    } else if (this.state === EnemyState.SEARCH) {
      this.searchTimer = Math.max(this.searchTimer, 5);
    }
    // P9 协作索敌：不再"各听各的"，把听到的方位广播给附近友军一起向同一区域搜索。
    if (world && world.alertNearby && clarity > 0.25 && this.state !== EnemyState.COMBAT) {
      world.alertNearby(this, point.x, point.y, cfg.shareNoiseRadius);
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
    // P21：中弹不只掉血，还会被压住 —— 精度下降 + 开火变慢（见 updateFiring）。
    this.suppression = addSuppression(this.suppression, 'hit');
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
   * 子弹擦过（P21）：只累加压制，**不回填射手坐标**。
   *
   * 这是"不透视"的硬边界：知道"有人在打我"和知道"打的人在哪个坐标"是两件事，
   * 前者带来紧张感，后者就是作弊。想找他得靠视线或声音。
   * @returns {void}
   */
  onNearMiss() {
    if (this.dead) return;
    this.suppression = addSuppression(this.suppression, 'nearMiss');
  }

  /**
   * 看看脚下附近有没有值得过去查的痕迹。
   *
   * 痕迹只是"有人来过"的线索，调查点就是痕迹本身的位置 ——
   * 玩家早就走了，AI 扑过去只会扑空，这是这套系统的意义。
   * @param {object} world 战局上下文
   * @returns {boolean} 是否转入了调查
   */
  spotTrace(world) {
    if (!world || !world.traces || !world.traces.length) return false;
    const cfg = AI.traces || {};
    if (cfg.enabled === false) return false;
    const hit = nearestTrace(world.traces, { x: this.x, y: this.y, angle: this.angle, id: this.id }, {
      radius: cfg.investigateRadius || 260,
      halfAngle: cfg.coneHalf,
    });
    if (!hit) return false;
    hit.trace.takenBy = this.id;
    this.lastKnown = { x: hit.trace.x, y: hit.trace.y };
    this.setState(EnemyState.INVESTIGATING);
    if (world.audio && world.audio.enemyAlert) {
      world.audio.enemyAlert(this.distanceTo(world.player));
    }
    return true;
  }

  /**
   * 找一处能挡住威胁射界的掩体。
   *
   * 纯几何 + 12 个候选方向，零随机：环形取样，要求"自己站过去看不见威胁"。
   * 站得过去但没挡住的不算 —— 那种位置只是换个方向挨打。
   * @param {object} world 战局上下文
   * @param {object} threat 威胁（玩家 / 最后已知点）
   * @returns {?{x:number,y:number}} 掩体点
   */
  pickCover(world, threat) {
    const map = world && world.map;
    if (!map || !map.grid || !threat) return null;
    let best = null;
    let bestScore = Infinity;
    for (let i = 0; i < 12; i += 1) {
      const a = (i / 12) * Math.PI * 2;
      const r = 60 + (i % 3) * 45;
      const cx = this.x + Math.cos(a) * r;
      const cy = this.y + Math.sin(a) * r;
      if (isSolidAt(map, cx, cy)) continue;
      // 站在这里还能被看到 = 不是掩体
      if (hasLineOfSight(map, cx, cy, threat.x, threat.y)) continue;
      const away = Math.hypot(cx - threat.x, cy - threat.y);
      const near = Math.hypot(cx - this.x, cy - this.y);
      // 越远离威胁、越贴近自己越好（不为了躲一发子弹跑半个房间）
      const score = near - away * 0.25;
      if (score < bestScore) { bestScore = score; best = { x: cx, y: cy }; }
    }
    return best;
  }

  /**
   * 压制到阈值就换掩体（带冷却，避免每帧重选导致原地抽搐）。
   * @param {object} world 战局上下文
   * @param {object} threat 威胁
   * @returns {boolean} 是否有可用掩体
   */
  tryTakeCover(world, threat) {
    if (this.coverTimer > 0) return !!this.coverPoint;
    const st = AI.states || {};
    this.coverTimer = st.suppressReposition || 0.9;
    this.coverPoint = this.pickCover(world, threat);
    return !!this.coverPoint;
  }

  /**
   * 躲会炸的投掷物（P21）：破片 / 震撼 / 燃烧都躲，烟幕不躲。
   * @param {number} dt 帧间隔秒
   * @param {object} world 战局上下文
   * @returns {boolean} 本帧是否在逃逸（true 时调用方应跳过其它走位决策）
   */
  dodgeGrenade(dt, world) {
    if (this.dodgeCd > 0) return false;
    const list = world && world.grenades;
    if (!list || !list.length) return false;
    const cfg = AI.grenadeDodge || {};
    const skip = cfg.skipKinds || ['smoke'];
    const radius = cfg.radius || 150;
    for (const g of list) {
      if (!g || g.dead) continue;
      if (skip.indexOf(g.kind) >= 0) continue;
      if (!(g.fuse > (cfg.minFuse != null ? cfg.minFuse : 0.25))) continue;
      const dx = this.x - g.x;
      const dy = this.y - g.y;
      const d = Math.hypot(dx, dy);
      if (d > radius) continue;
      const len = d || 1;
      const flee = cfg.fleeDist || 190;
      this.moveToward(dt, world, this.x + (dx / len) * flee, this.y + (dy / len) * flee,
        this.def.speed * (cfg.speedMul || 1.35));
      this.angle = angleLerp(this.angle, Math.atan2(dy, dx), 1 - Math.exp(-8 * dt));
      this.dodgeCd = cfg.cooldown || 0.6;
      this.wantsMove = true;
      return true;
    }
    return false;
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
    // P21：压制与冷却按真实 dt 衰减（眩晕期间也衰减，否则被闪完还带着满压制投入战斗）
    this.suppression = decaySuppression(this.suppression, dt);
    this.coverTimer = Math.max(0, this.coverTimer - dt);
    this.dodgeCd = Math.max(0, this.dodgeCd - dt);
    updateWeapon(dt, this, world);

    // 眩晕（P5）：整段冻结。视觉上的抖动/闪烁仍在走，否则玩家看不出"他被闪了"，
    // 只会以为 AI 卡住。眩晕结束时必须解除 fireLocked，否则这个敌人从此不会开枪。
    if (this.stun > 0) {
      this.stun = Math.max(0, this.stun - dt);
      this.fireLocked = this.stun > 0;
      return;
    }

    // 敌方目标集 = 「玩家 + 存活队友」。挑最近的可见目标作为当前威胁；
    // 玩家优先被锁定，但队友进入视野锥也会被攻击（符合搜打撤"队友可被击倒"）。
    const foes = [world.player, ...(world.squad || []).filter((a) => a && !a.isPlayer && !a.dead)];
    let primary = null;
    let primaryDist = Infinity;
    for (const f of foes) {
      if (!f || f.dead) continue;
      if (this.canSee(world, f)) {
        const d = Math.hypot(f.x - this.x, f.y - this.y);
        if (d < primaryDist) { primaryDist = d; primary = f; }
      }
    }
    // player 形参沿用"当前威胁"语义：未看到任何目标时回落到 world.player（始终非 null），
    // 避免下游 updateFiring 读到 null 而崩溃。
    const player = primary || world.player;
    const visible = !!primary;
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

    // P9：医疗兵治疗附近受伤友军；可投掷敌人择机掷雷
    if (this.def.heals) this.healAllies(dt, world);
    if (this.def.canThrow) this.tryGrenade(dt, world, player);

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
      case EnemyState.IDLE:
        // 待机：站着环视，计时到点回去巡逻。看到人照样转警觉。
        this.idleTimer -= dt;
        if (visible) {
          this.setState(EnemyState.SUSPICIOUS);
          this.reactionTimer = this.def.reactionTime;
          if (world.audio) world.audio.enemyAlert(this.distanceTo(world.player));
        } else if (this.spotTrace(world)) {
          // 痕迹优先级高于回去巡逻：看到脚印/血就先跟过去
        } else if (this.idleTimer <= 0) {
          this.setState(EnemyState.PATROL);
        }
        break;
      case EnemyState.ALERT_PATROL:
        // 警戒巡逻：搜索超时后的高压状态，视距更远（见 canSee 的 alertMul），到期降级。
        this.alertTimer -= dt;
        if (visible) {
          this.setState(EnemyState.SUSPICIOUS);
          this.reactionTimer = this.def.reactionTime * 0.6;
          if (world.audio) world.audio.enemyAlert(this.distanceTo(world.player));
        } else if (this.spotTrace(world)) {
          // 转调查
        } else if (this.alertTimer <= 0) {
          this.setState(EnemyState.PATROL);
        }
        break;
      case EnemyState.PATROL:
        if (visible) {
          this.setState(EnemyState.SUSPICIOUS);
          this.reactionTimer = this.def.reactionTime;
          if (world.audio) world.audio.enemyAlert(this.distanceTo(world.player));
        } else {
          this.spotTrace(world);
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
        } else if (this.reactionTimer <= 0 || this.stateTime > 2.5) {
          // P21：确认"附近没人"之后不再原地干等，而是循着线索走过去看。
          // 调查点 = 最后已知位置（声源 / 瞥见点），走过去大概率扑空 —— 这正是要的效果。
          this.setState(EnemyState.INVESTIGATING);
        }
        break;
      }
      case EnemyState.INVESTIGATING: {
        this.investigateTimer -= dt;
        if (visible) {
          this.setState(EnemyState.COMBAT);
          if (world.alertNearby) world.alertNearby(this, player.x, player.y, 300);
          break;
        }
        const tgt = this.investigateTarget || this.lastKnown;
        const arrive = (AI.states && AI.states.investigateArrive) || 60;
        const reached = !tgt || Math.hypot(tgt.x - this.x, tgt.y - this.y) <= arrive;
        if (reached || this.investigateTimer <= 0) {
          // 到点了还没人 → 转搜索，在附近扩大范围翻一遍
          this.setState(EnemyState.SEARCH);
        }
        break;
      }
      case EnemyState.COMBAT:
        // P9 感知协同：周期性把最后已知位置广播给半径内友军，保持小队对同一目标的追踪，
        // 避免各自独立丢失玩家后整队原地发呆（交叉火力的前提是"大家打的是同一个点"）。
        this.shareCd -= dt;
        if (this.shareCd <= 0) {
          this.shareCd = 2.5;
          if (world.alertNearby && this.lastKnown) {
            world.alertNearby(this, this.lastKnown.x, this.lastKnown.y, 320);
          }
        }
        if (!visible && this.lostTimer > 1.1) {
          this.setState(EnemyState.SEARCH);
        }
        break;
      case EnemyState.SEARCH: {
        this.searchTimer -= dt;
        // P9 协作索敌：搜索态也周期性互通最后已知位置，让整队收敛到同一片区域，
        // 而不是各自在原地随机游走（COMBAT 态的广播频率更高，见上面分支）。
        this.shareCd -= dt;
        if (this.shareCd <= 0) {
          this.shareCd = AI.perception.shareSearchInterval;
          if (world.alertNearby && this.lastKnown) {
            world.alertNearby(this, this.lastKnown.x, this.lastKnown.y, 260);
          }
        }
        if (visible) {
          this.setState(EnemyState.COMBAT);
          if (world.alertNearby) world.alertNearby(this, player.x, player.y, 300);
        } else if (this.searchTimer <= 0) {
          // P21：搜索没结果不回普通巡逻，先进入警戒巡逻一段时间 —— 玩家听到"他们还在找"
          // 的压力就来自这里，而不是原地消失。
          this.setState(EnemyState.ALERT_PATROL);
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
    // A-06 公平性：拆掩体只能朝"最后一次感知到的位置"打，绝不回落到玩家真实坐标。
    // 旧写法 `lastKnown || player` 在 AI 从未感知到玩家时会朝真实坐标开火 = 透视作弊。
    const aim = this.lastKnown;
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
    // 首领走自己的行为树（P16），不吃普通敌人的躲雷/掩体分支
    if (this.isBoss) return this.actBoss(dt, world, player, visible);
    // P21：脚边有会炸的东西就先跑，优先级高于一切走位 / 开火决策。
    if (this.dodgeGrenade(dt, world)) return;
    let moveTarget = null;
    let speed = this.def.speed;
    let faceTarget = null;

    if (this.state === EnemyState.IDLE) {
      // 待机：站定环视。左右缓慢扫视，玩家能据此判断"他现在看哪边"。
      this.angle += Math.sin(this.stateTime * 1.1) * dt * 1.6;
      this.wantsMove = false;
    } else if (this.state === EnemyState.INVESTIGATING) {
      speed = this.def.speed * 0.85;
      const tgt = this.investigateTarget || this.lastKnown;
      if (tgt) {
        faceTarget = tgt;
        if (Math.hypot(tgt.x - this.x, tgt.y - this.y) > 30) moveTarget = tgt;
      }
    } else if (this.state === EnemyState.PATROL || this.state === EnemyState.ALERT_PATROL) {
      speed = this.def.speed * (this.state === EnemyState.ALERT_PATROL ? 0.95 : 0.72);
      // 守点敌人：以撤离点为中心小幅游走
      let home = null;
      if (this.guardOf != null) {
        const ex = world.map.extracts[this.guardOf];
        if (ex) home = ex;
      }
      // P22 阵地归属：离家太远就先回防，回到附近再继续本来的巡逻路线。
      // 目的是让玩家能读出"这块地是谁的"——刚清完的房间里不该冒出从地图另一头溜达过来的人。
      const hcfg = AI.home || {};
      if (!home && hcfg.enabled !== false && this.homePoint) {
        const hd = Math.hypot(this.homePoint.x - this.x, this.homePoint.y - this.y);
        const leash = hcfg.leash != null ? hcfg.leash : 460;
        const arrive = hcfg.arrive != null ? hcfg.arrive : 90;
        if (hd > leash) {
          this.patrolTarget = this.homePoint;
          this.waitTimer = 0;
          this.returningHome = true;
          speed *= hcfg.speedMul != null ? hcfg.speedMul : 0.9;
        } else if (this.returningHome && hd <= arrive) {
          // 已回防：清掉返家目标，下一帧照常从 patrolRoute 里挑点
          this.returningHome = false;
          this.patrolTarget = null;
        }
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
          // 到点站一会（IDLE），比"原地画圈"更像在守点；警戒巡逻不停留，继续压过去。
          if (this.state === EnemyState.PATROL) this.setState(EnemyState.IDLE);
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
        } else if (shouldTakeCover(this.suppression) && this.tryTakeCover(world, target)) {
          // P21：被打狠了先保命 —— 贴到能挡住射界的位置，压制退了再出来
          moveTarget = this.coverPoint;
          speed = this.def.speed * 1.12;
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

    // P9 侧翼包抄：被标记为 flanker 的敌人绕到玩家侧后，与正面推进者形成交叉火力
    if (this.flanker && visible && this.state === EnemyState.COMBAT) {
      const fdx = player.x - this.x;
      const fdy = player.y - this.y;
      const fdist = Math.hypot(fdx, fdy) || 1;
      const perp = { x: -fdy / fdist, y: fdx / fdist };
      const side = this.flankSide || 1;
      moveTarget = { x: player.x + perp.x * 110 * side, y: player.y + perp.y * 110 * side };
      speed = this.def.speed * 1.02;
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
   * 首领行为：三种主题原型（bulwark / stalker / sniper），由 this.behavior 分发。
   * 只负责"移动决策 + 转向 + 移动 + 分离 + 开火"，复用普通敌人的底层方法，
   * 不重写感知/状态机（think 仍走 PATROL→…→COMBAT 通用流程）。
   * @param {number} dt 帧间隔秒
   * @param {object} world 战局上下文
   * @param {object} player 玩家（当前威胁）
   * @param {boolean} visible 是否看得见玩家
   * @returns {void}
   */
  actBoss(dt, world, player, visible) {
    const dx = player.x - this.x;
    const dy = player.y - this.y;
    const dist = Math.hypot(dx, dy) || 1;
    let moveTarget = null;
    let speed = this.def.speed;
    const pref = this.def.preferredRange || 200;

    if (this.behavior === 'bulwark') {
      // 重火力：锚定据点、持续压制、定时呼叫增援
      if (this.home) {
        const hd = Math.hypot(this.home.x - this.x, this.home.y - this.y);
        if (hd > (this.leash || 240)) {
          moveTarget = { x: this.home.x, y: this.home.y };
          speed = this.def.speed * 0.9;
        }
      }
      if (!moveTarget) {
        if (dist < 150) {
          // 太近就后撤保持压制距离
          moveTarget = { x: this.x - (dx / dist) * 130, y: this.y - (dy / dist) * 130 };
        } else if (visible && dist > pref * 1.25) {
          moveTarget = player;
        }
      }
      if (this.state === EnemyState.COMBAT) {
        this.reinforceTimer -= dt;
        if (this.reinforceTimer <= 0) {
          this.reinforceTimer = this.def.reinforceInterval || 22;
          if (world.spawnReinforcement) {
            for (let k = 0; k < 2; k += 1) {
              const a = this.rng.float(0, Math.PI * 2);
              world.spawnReinforcement(
                this.x + Math.cos(a) * 120, this.y + Math.sin(a) * 120, 'patrol',
              );
            }
          }
        }
      }
    } else if (this.behavior === 'stalker') {
      // 伏击：高速绕到玩家侧后贴脸爆发
      this.flankCd -= dt;
      if (this.flankCd <= 0 || !this.flankPoint) {
        this.flankCd = this.def.flankCd || 4;
        const perp = { x: -dy / dist, y: dx / dist };
        const side = this.rng.chance(0.5) ? 1 : -1;
        this.flankPoint = { x: player.x + perp.x * 90 * side, y: player.y + perp.y * 90 * side };
      }
      if (dist > 90) moveTarget = this.flankPoint;
      else this.flankPoint = null; // 已贴脸，直接开火
    } else if (this.behavior === 'sniper') {
      // 狙击：抢高地、远距离吊射，近了就撤
      const plats = world.map.platforms || [];
      const onHigh = plats.find((p) => {
        const cx = p.x + p.w / 2;
        const cy = p.y + p.h / 2;
        return Math.hypot(cx - this.x, cy - this.y) < p.w / 2 + 60;
      });
      if (dist < pref * 0.7) {
        moveTarget = { x: this.x - (dx / dist) * 170, y: this.y - (dy / dist) * 170 };
      } else if (!onHigh && plats.length) {
        const p = plats[(this.id + Math.floor(world.time / 6)) % plats.length];
        moveTarget = { x: p.x + p.w / 2, y: p.y + p.h / 2 };
      } else if (dist < pref * 0.9) {
        moveTarget = { x: this.x - (dx / dist) * 90, y: this.y - (dy / dist) * 90 };
      }
    }

    const faceTarget = visible ? player : (this.lastKnown || null);
    if (faceTarget) {
      const want = Math.atan2(faceTarget.y - this.y, faceTarget.x - this.x);
      this.angle = angleLerp(this.angle, want, 1 - Math.exp(-9 * dt));
    }
    if (moveTarget) {
      this.wantsMove = true;
      this.moveToward(dt, world, moveTarget.x, moveTarget.y, speed);
    } else {
      this.wantsMove = false;
    }
    this.separate(dt, world);
    this.updateFiring(dt, world, player, visible);
  }

  /**
   * 医疗兵：治疗半径内受伤友军（确定性，无随机）。
   * @param {number} dt 帧间隔秒
   * @param {object} world 战局上下文
   * @returns {void}
   */
  healAllies(dt, world) {
    const r = this.def.healRadius || 160;
    for (const other of world.enemies) {
      if (other === this || other.dead) continue;
      const d = Math.hypot(other.x - this.x, other.y - this.y);
      if (d > r) continue;
      if (other.hp < other.maxHp) {
        other.hp = Math.min(other.maxHp, other.hp + (this.def.healRate || 12) * dt);
      }
    }
  }

  /**
   * 投掷物：看不到玩家但知道最后位置、且距离适中时掷出爆裂雷（对玩家造成伤害）。
   * @param {number} dt 帧间隔秒
   * @param {object} world 战局上下文
   * @param {object} player 玩家
   * @returns {void}
   */
  tryGrenade(dt, world, player) {
    if (!this.def.canThrow) return;
    this.grenadeCd -= dt;
    if (this.grenadeCd > 0) return;
    if (this.lastKnown && !player.dead) {
      const d = Math.hypot(this.lastKnown.x - this.x, this.lastKnown.y - this.y);
      if (d > 180 && d < 640) {
        this.grenadeCd = this.def.grenadeInterval || 16;
        // 落点必须在玩家最后已知位置附近（而不是投掷者脚下，否则永远炸不到人）。
        // 偏移由 id + 时间的确定性函数给出，绝不抽 world.rng（那条流同时喂 AI/散布/掉落）。
        const j = ((this.id * 13 + Math.floor((world.time || 0) * 3)) % 7 - 3) * 5;
        let tx = this.lastKnown.x + j;
        let ty = this.lastKnown.y - j * 0.5;
        if (isSolidAt(world.map, tx, ty)) { tx = this.lastKnown.x; ty = this.lastKnown.y; }
        const list = world.enemyGrenades || (world.enemyGrenades = []);
        list.push({
          x: tx, y: ty, fromX: this.x, fromY: this.y,
          h: 1.2, t: 0, fuse: 1.5, fuse0: 1.5,
          radius: 72, damage: 46, dead: false,
        });
      }
    }
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
    // P21：被压制时精度下降（满压制 ×0.62），压制退了自动恢复
    const acc = (player.ropelling ? this.def.accuracy * ROPE.evadeMul : this.def.accuracy)
      * suppressionAccuracyMul(this.suppression);

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
        * (dist > 380 ? 1.3 : 1)
        * suppressionFireDelayMul(this.suppression);
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
    if (this.state === EnemyState.PATROL || this.state === EnemyState.SEARCH
      || this.state === EnemyState.ALERT_PATROL || this.state === EnemyState.INVESTIGATING) {
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
 * 推进所有敌方投掷物（爆裂雷）：引信耗尽即对玩家结算范围伤害 + 视觉冲击波。
 * 由主循环每帧调用；与玩家投掷物（throwable.js）互不干扰。
 * @param {object} world 战局上下文
 * @param {number} dt 帧间隔秒
 * @returns {void}
 */
export function updateEnemyGrenades(world, dt) {
  const list = world.enemyGrenades;
  if (!list || !list.length) return;
  for (const g of list) {
    if (g.dead) continue;
    g.t += dt;
    g.fuse -= dt;
    if (g.fuse > 0) continue;
    g.dead = true;
    const p = world.player;
    if (p && !p.dead) {
      const d = Math.hypot(p.x - g.x, p.y - g.y);
      const atten = blastAttenuation(d, g.radius);
      if (atten > 0) {
        const src = { x: g.x, y: g.y, isPlayer: false, faction: 'enemy', typeId: 'enemy_grenade' };
        applyDamage(world, p, g.damage * atten, src, p.x, p.y, U * 1.0);
      }
    }
    // 复用玩家手雷的同一套爆炸演出：粒子 + 震屏 + 按距离衰减的音效，不另造一套 decal kind
    const distM = p ? Math.hypot(p.x - g.x, p.y - g.y) / U : 99;
    if (world.spawnExplosion) world.spawnExplosion(g.x, g.y, g.h, g.radius / U, '#ff6a3d');
    if (world.shakeCamera) world.shakeCamera(1.2 + 1.6 * blastAttenuation(distM * U, g.radius * 2));
    if (world.audio && world.audio.explosion) world.audio.explosion(distM);
  }
  world.enemyGrenades = list.filter((g) => !g.dead);
}

/**
 * 创建一批敌人。
 * @param {object} map 地图
 * @param {object} rng 随机数发生器
 * @returns {Array<Enemy>} 敌人数组
 */
export function spawnEnemies(map, rng) {
  const list = map.enemySpawns.map((spawn, i) => {
    if (spawn.type === 'boss') return createBoss(spawn, i, rng.fork(i + 1));
    const e = new Enemy(spawn.type, spawn.x, spawn.y, i, rng.fork(i + 1));
    if (spawn.guardOf != null) e.guardOf = spawn.guardOf;
    // 巡逻路线：取若干随机房间地面点，让敌人沿固定路线往返而非纯随机游走。
    // ⚠ 旧写法 `.sort(() => rng.float(-1, 1))` 在比较器里反复抽 rng：比较次数随引擎
    // 实现变化 → 同一 seed 的巡逻路线跨进程漂移。改为一次性 Fisher-Yates，并用独立 fork。
    const points = map.rooms.map((room) => randomPointInRoom(map, room, rng.fork(i * 7 + 13)));
    e.patrolRoute = rng.fork(i * 7 + 29).shuffle(points).slice(0, 3);
    return e;
  });
  // P9 交叉火力：约一半普通敌人承担侧翼包抄，绕到玩家侧后形成合围（Boss 不参与）
  let n = 0;
  for (const e of list) {
    if (e.isBoss) continue;
    e.flanker = (n % 2 === 1);
    e.flankSide = (n % 4 < 2) ? 1 : -1;
    n += 1;
  }
  return list;
}

/**
 * 创建一张图的 Boss 实体。
 * @param {object} spawn 地图里的 boss 出生描述（含 bossId）
 * @param {number} id 唯一编号
 * @param {object} rng 随机数发生器
 * @returns {Enemy} Boss 实体（isBoss = true，def 直接取自 BOSSES）
 */
export function createBoss(spawn, id, rng) {
  const def = BOSSES[spawn.bossId] || BOSSES.depot;
  const e = new Enemy(def.id, spawn.x, spawn.y, id, rng, def);
  e.home = { x: spawn.x, y: spawn.y };
  return e;
}
