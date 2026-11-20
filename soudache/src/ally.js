/**
 * 本地 AI 队友（P5-C2）。
 *
 * 职责边界：本模块只依赖纯逻辑模块（config / mapgen / combat / throwable / operators / rng），
 * 不碰渲染 / 输入 / DOM，于是 node 里可以直接单测"队友会不会跟上、会不会开火、倒地能不能救"。
 *
 * 行为模型（对照敌人 AI 的"巡逻→交战"）：
 * - FOLLOW：玩家附近编队跟随，离得太远就追上，到了就待命。
 * - ENGAGE：发现可见敌人就转向、保持理想射距（太远压上 / 太近后撤 / 适中横向走位）、自动点射。
 * - DOWNED：hp 归零进入倒地（dead 置真以便敌人不再锁它），玩家靠近读条可救回。
 *
 * 阵营与命中：队友 faction='ally'。combat.js 的 combatTargets 据此让"队友的子弹只打敌人"、
 * "敌人的子弹会打玩家+队友"，所以不存在友军误伤。
 */

import { ALLY, WEAPONS, TILE } from './config.js';
import {
  moveWithCollision, hasLineOfSight, isSolidAt, getFlowField, flowDirection,
} from './mapgen.js';
import { createWeaponState, updateWeapon, fireWeapon, startReload } from './combat.js';
import { smokeBlocks } from './throwable.js';
import { OPERATORS } from './operators.js';
import { createRng } from './rng.js';

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

/** AI 状态常量（队友自己的，不混用敌人那套） */
export const AllyState = {
  FOLLOW: 'FOLLOW',
  ENGAGE: 'ENGAGE',
  DOWNED: 'DOWNED',
};

export class Ally {
  /**
   * @param {object} opts { id, operator, x, y, angle, weaponDef, rng, slotIndex }
   */
  constructor(opts = {}) {
    const op = opts.operator;
    this.id = opts.id;
    this.faction = 'ally';
    this.isPlayer = false;
    this.operatorId = op ? op.id : 'unknown';
    this.callsign = op ? op.callsign : '队友';
    this.role = op ? op.roleName : 'ALLY';
    this.color = op ? op.color : '#5DAF7E';
    this.x = opts.x || 0;
    this.y = opts.y || 0;
    this.angle = opts.angle || 0;
    this.radius = ALLY.radius;
    this.maxHp = ALLY.hp;
    this.hp = ALLY.hp;
    this.maxArmor = ALLY.armor;
    this.armor = ALLY.armor;
    this.dead = false;
    this.downed = false;
    this.rng = opts.rng || createRng(1);
    const wdef = opts.weaponDef || WEAPONS.rifle;
    this.weapon = createWeaponState(wdef);
    this.reloadMul = 1; // 队友换弹沿用默认（后续可接干员被动）
    this.state = AllyState.FOLLOW;
    this.currentTarget = null;
    this.fireTimer = this.rng.float(0.2, 0.8);
    this.burstLeft = 0;
    this.burstDelay = 0;
    this.strafeDir = this.rng.chance(0.5) ? 1 : -1;
    this.strafeTimer = this.rng.float(1.0, 2.4);
    this.reviveT = 0;
    this.reviving = false;
    this.hurtFlash = 0;
    this.muzzleFlash = 0;
    this.recoilOffset = 0;
    this.wantsMove = false;
    this.walkPhase = 0;
    this.stun = 0;
    this.fireLocked = false;
    this.slotIndex = opts.slotIndex || 0;
    this.field = null;
    this.flowTile = -1;
  }

  /** 当前武器（combat.js 约定） */
  get currentWeapon() {
    return this.weapon;
  }

  /**
   * 能否看到某敌人（队友感知：范围内 + 视线无墙 + 没被烟挡，不做视野锥，全向感知更像"友军报点"）。
   * @param {object} world 战局上下文
   * @param {object} e 敌人
   * @returns {boolean}
   */
  canSee(world, e) {
    if (!e || e.dead) return false;
    const d = Math.hypot(e.x - this.x, e.y - this.y);
    if (d > ALLY.visionRange) return false;
    if (!hasLineOfSight(world.map, this.x, this.y, e.x, e.y)) return false;
    if (world.smokes && smokeBlocks(world.smokes, this.x, this.y, e.x, e.y)) return false;
    return true;
  }

  /**
   * 挑最近的可见敌人。
   * @param {object} world 战局上下文
   * @returns {object|null} 敌人或 null
   */
  acquireTarget(world) {
    let best = null;
    let bestD = Infinity;
    for (const e of (world.enemies || [])) {
      if (e.dead) continue;
      const d = Math.hypot(e.x - this.x, e.y - this.y);
      if (d > ALLY.visionRange) continue;
      if (!hasLineOfSight(world.map, this.x, this.y, e.x, e.y)) continue;
      if (world.smokes && smokeBlocks(world.smokes, this.x, this.y, e.x, e.y)) continue;
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  /**
   * 沿流场或直线移动到目标点（与敌人 AI 同源的寻路）。
   * @param {number} dt 帧间隔秒
   * @param {object} world 战局上下文
   * @param {number} tx 目标 x
   * @param {number} ty 目标 y
   * @param {number} speed 速度
   * @param {boolean} [faceMovement] 是否把朝向转向移动方向（交战时务必 false，
   *   否则会盖掉"瞄准敌人"的朝向导致横着走横着打、全部打偏）。
   */
  moveToward(dt, world, tx, ty, speed, faceMovement = true) {
    const map = world.map;
    const dist = Math.hypot(tx - this.x, ty - this.y) || 1;
    let dir;
    if (dist < 220 && hasLineOfSight(map, this.x, this.y, tx, ty)) {
      dir = { x: (tx - this.x) / dist, y: (ty - this.y) / dist };
    } else {
      const ttx = Math.floor(tx / TILE);
      const tty = Math.floor(ty / TILE);
      const tile = ttx + tty * map.cols;
      if (!this.field || tile !== this.flowTile) {
        this.field = getFlowField(map, ttx, tty);
        this.flowTile = tile;
      }
      dir = flowDirection(map, this.field, this.x, this.y) || { x: (tx - this.x) / dist, y: (ty - this.y) / dist };
    }
    const next = moveWithCollision(map, this.x, this.y, dir.x * speed * dt, dir.y * speed * dt, this.radius);
    this.x = next.x;
    this.y = next.y;
    this.walkPhase += dt * 8;
    // 仅跟随状态才把朝向转向移动方向；交战时朝向由 update 锁定到敌人，避免打偏。
    if (faceMovement) {
      const want = Math.atan2(dir.y, dir.x);
      this.angle = angleLerp(this.angle, want, 1 - Math.exp(-4 * dt));
    }
  }

  /** 与玩家 / 其他队友保持间距，避免叠在一起 */
  separate(dt, world) {
    let px = 0;
    let py = 0;
    let n = 0;
    const others = [];
    if (world.player && !world.player.dead) others.push(world.player);
    for (const a of (world.squad || [])) if (a && a !== this && !a.dead) others.push(a);
    for (const o of others) {
      const dx = this.x - o.x;
      const dy = this.y - o.y;
      const d = Math.hypot(dx, dy);
      if (d > 0.01 && d < this.radius + o.radius + 4) {
        px += dx / d;
        py += dy / d;
        n += 1;
      }
    }
    if (!n) return;
    const len = Math.hypot(px, py) || 1;
    const next = moveWithCollision(
      world.map, this.x, this.y, (px / len) * 30 * dt, (py / len) * 30 * dt, this.radius,
    );
    this.x = next.x;
    this.y = next.y;
  }

  /**
   * 点射逻辑（复用 fireWeapon，靠武器 rpm 控制连射节奏）。
   * @param {number} dt 帧间隔秒
   * @param {object} world 战局上下文
   * @param {object} target 目标敌人
   * @param {boolean} visible 是否可见
   */
  updateFiring(dt, world, target, visible) {
    if (!target || target.dead) return;
    const dist = Math.hypot(target.x - this.x, target.y - this.y);
    if (dist > this.weapon.def.range) return;
    if (!hasLineOfSight(world.map, this.x, this.y, target.x, target.y)) return;
    if (world.smokes && smokeBlocks(world.smokes, this.x, this.y, target.x, target.y)) return;
    this.fireTimer -= dt;
    if (this.fireTimer <= 0) {
      if (this.weapon.ammo <= 0) {
        startReload(this, world);
        this.fireTimer = this.weapon.def.reloadTime + 0.2;
        return;
      }
      this.burstLeft = this.rng.int(ALLY.burst[0], ALLY.burst[1]);
      this.burstDelay = 0;
      this.fireTimer = this.rng.float(ALLY.fireDelay[0], ALLY.fireDelay[1]) * (dist > 380 ? 1.3 : 1);
    }
    if (this.burstLeft > 0) {
      this.burstDelay -= dt;
      if (this.burstDelay <= 0) {
        fireWeapon(world, this, { accuracy: ALLY.accuracy });
        this.burstLeft -= 1;
        this.burstDelay = 60 / this.weapon.def.rpm;
      }
    }
  }

  /**
   * 每帧更新。
   * @param {number} dt 帧间隔秒
   * @param {object} world 战局上下文
   */
  update(dt, world) {
    if (this.dead) return;
    this.hurtFlash = Math.max(0, this.hurtFlash - dt);
    this.muzzleFlash = Math.max(0, this.muzzleFlash - dt);
    this.recoilOffset *= Math.max(0, 1 - dt * 6);
    updateWeapon(dt, this, world);

    const target = this.acquireTarget(world);
    if (target) {
      this.state = AllyState.ENGAGE;
      this.currentTarget = target;
      const dx = target.x - this.x;
      const dy = target.y - this.y;
      const dist = Math.hypot(dx, dy);
      this.angle = angleLerp(this.angle, Math.atan2(dy, dx), 1 - Math.exp(-9 * dt));
      const pref = ALLY.preferredRange;
      let moveTarget = null;
      let speed = ALLY.engageSpeed;
      if (dist > pref * 1.25) {
        moveTarget = { x: target.x, y: target.y };
      } else if (dist < pref * 0.55) {
        moveTarget = { x: this.x - dx, y: this.y - dy };
      } else {
        this.strafeTimer -= dt;
        if (this.strafeTimer <= 0) {
          this.strafeTimer = this.rng.float(1.0, 2.4);
          this.strafeDir *= -1;
        }
        const len = dist || 1;
        moveTarget = {
          x: this.x + (-dy / len) * this.strafeDir * 110,
          y: this.y + (dx / len) * this.strafeDir * 110,
        };
        speed = ALLY.strafeSpeed;
      }
      if (moveTarget) {
        this.wantsMove = true;
        // 交战时朝向已锁定到敌人（上方 angleLerp），传 false 避免 moveToward 把朝向拉回移动方向。
        this.moveToward(dt, world, moveTarget.x, moveTarget.y, speed, false);
      } else {
        this.wantsMove = false;
      }
      this.updateFiring(dt, world, target, true);
    } else {
      this.currentTarget = null;
      this.state = AllyState.FOLLOW;
      const p = world.player;
      if (p) {
        const bx = Math.cos(p.angle + Math.PI);
        const by = Math.sin(p.angle + Math.PI);
        const rx = -Math.sin(p.angle);
        const ry = Math.cos(p.angle);
        const side = (this.slotIndex === 0 ? -1 : 1) * ALLY.formationSpread;
        const gx = p.x + bx * ALLY.followDist + rx * side;
        const gy = p.y + by * ALLY.followDist + ry * side;
        const d = Math.hypot(gx - this.x, gy - this.y);
        if (d > 18) {
          this.wantsMove = true;
          this.moveToward(dt, world, gx, gy, ALLY.followSpeed);
        } else {
          this.wantsMove = false;
        }
      } else {
        this.wantsMove = false;
      }
    }
    this.separate(dt, world);
  }

  /**
   * 受伤钩子（由 combat.applyDamage 调用）。倒地置 downed，并惊动附近敌人。
   * @param {object} source 伤害来源
   * @param {object} world 战局上下文
   */
  onDamaged(source, world) {
    this.hurtFlash = 0.3;
    if (this.state === AllyState.FOLLOW && source) this.state = AllyState.ENGAGE;
    if (world && world.alertNearby) world.alertNearby(this, this.x, this.y, 300);
    if (this.hp <= 0) this.downed = true;
  }
}

/**
 * 生成两名 AI 队友，出生在玩家身后的编队位。
 * @param {object} player 玩家
 * @param {object} map 地图
 * @param {object} rng 随机数发生器
 * @param {Array<object>} allyOps 两名干员档案（通常取非玩家干员）
 * @param {object} [weaponDef] 队友武器定义（默认用玩家主武器）
 * @returns {Array<Ally>} 队友数组
 */
export function spawnSquad(player, map, rng, allyOps, weaponDef) {
  const ops = (allyOps && allyOps.length)
    ? allyOps
    : OPERATORS.filter((o) => o.id !== player.operatorId).slice(0, 2);
  const list = [];
  for (let i = 0; i < 2; i += 1) {
    const op = ops[i % ops.length] || OPERATORS[1];
    const ang = player.angle + Math.PI + (i === 0 ? -0.5 : 0.5);
    const fx = Math.cos(ang);
    const fy = Math.sin(ang);
    const rx = -Math.sin(player.angle);
    const ry = Math.cos(player.angle);
    const side = (i === 0 ? -1 : 1) * ALLY.formationSpread;
    let x = player.x + fx * ALLY.followDist + rx * side;
    let y = player.y + fy * ALLY.followDist + ry * side;
    if (isSolidAt(map, x, y)) { x = player.x - fx * ALLY.followDist; y = player.y - fy * ALLY.followDist; }
    if (isSolidAt(map, x, y)) { x = player.x; y = player.y; }
    const a = new Ally({
      id: i, operator: op, x, y, angle: player.angle, weaponDef, rng: rng.fork(900 + i),
    });
    a.slotIndex = i;
    list.push(a);
  }
  return list;
}

/**
 * 每帧推进整个小队：更新存活队友 + 处理倒地队友的救援读条。
 * 倒地队友 dead=true（敌人不再锁它），但这里仍遍历它们做救援判定。
 * @param {number} dt 帧间隔秒
 * @param {object} world 战局上下文
 */
export function updateSquad(dt, world) {
  const sq = world.squad;
  if (!sq) return;
  const p = world.player;
  for (const a of sq) {
    if (!a) continue;
    if (a.dead) {
      // 倒地：玩家靠近且存活则读条救援
      if (p && !p.dead) {
        const d = Math.hypot(a.x - p.x, a.y - p.y);
        if (d <= ALLY.reviveRange) {
          a.reviveT = (a.reviveT || 0) + dt;
          a.reviving = true;
          a.state = `REVIVE ${Math.min(99, Math.round((a.reviveT / ALLY.reviveTime) * 100))}%`;
          if (a.reviveT >= ALLY.reviveTime) {
            a.dead = false;
            a.downed = false;
            a.reviving = false;
            a.reviveT = 0;
            a.hp = Math.round(a.maxHp * ALLY.reviveHpFrac);
            a.armor = Math.round(a.maxArmor * ALLY.reviveArmorFrac);
            a.state = AllyState.FOLLOW;
            if (world.audio && world.audio.ui) world.audio.ui(0.6);
          }
        } else {
          a.reviving = false;
          a.reviveT = 0;
          a.state = AllyState.DOWNED;
        }
      } else {
        a.state = AllyState.DOWNED;
      }
      continue;
    }
    a.update(dt, world);
  }
}
