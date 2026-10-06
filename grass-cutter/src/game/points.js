/**
 * 据点与士气系统（模块 6）—— **纯逻辑**，不 import three / 不碰 DOM。
 * ---------------------------------------------------------------------------
 * 它管两件事，且只管"数值"，不碰渲染与敌人实体本身：
 *   · 3 个据点的占领进度（0~100）：玩家站圈里 +RATE/s，敌方在圈里 -DECAY/s，
 *     守卫未清光则不许占领（进度只掉不涨）。
 *   · 全局士气（0~100）：每占一个 +15，被夺回 -15；士气越高敌人重生越慢、攻击越弱。
 *
 * ⚠ 本模块**不负责生成守卫**，也不负责把敌人挪到据点——那是 stage / 战场布置的事。
 *   它每帧只吃一份"当前活着的敌人列表"（带 x/z/guardOf），据此判断圈内敌情。
 *   这样 points 可以独立单测：喂假敌人数组即可，不需要真的拉起一整个 EnemyPool。
 */
import { MORALE, POINTS } from '../core/config.js';

/** 把当前士气换算成"敌人重生间隔"的倍率。士气 50（基准）→ 1；100 → 1+RESPAWN_BONUS；0 → 压到下限 */
export function respawnScale(morale, cfg = MORALE) {
  const s = 1 + ((morale - 50) / 50) * cfg.RESPAWN_BONUS;
  return Math.max(0.2, s);
}

/** 把当前士气换算成"敌人攻击力"的倍率。士气 50 → 1；100 → 1-ATTACK_REDUCE（攻击更弱）。 */
export function attackScale(morale, cfg = MORALE) {
  const s = 1 - ((morale - 50) / 50) * cfg.ATTACK_REDUCE;
  return Math.max(0.3, s);
}

export class CaptureSystem {
  constructor({ moraleCfg = MORALE, pointsCfg = POINTS } = {}) {
    this.moraleCfg = moraleCfg;
    this.pointsCfg = pointsCfg;
    this.morale = moraleCfg.START;
    this.points = pointsCfg.LIST.map((p) => ({
      id: p.id,
      name: p.name,
      x: p.x,
      z: p.z,
      progress: 0, // 0~100
      captured: false,
      guardsAlive: 0,
      enemiesInRange: 0,
      playerInside: false,
    }));
    this.events = [];
  }

  get allCaptured() {
    return this.points.length > 0 && this.points.every((p) => p.captured);
  }

  get respawnScale() {
    return respawnScale(this.morale, this.moraleCfg);
  }

  get attackScale() {
    return attackScale(this.morale, this.moraleCfg);
  }

  /**
   * @param dt 帧长
   * @param playerPos {x,z}
   * @param enemies 活着的敌人数组（元素需有 x,z,alive,guardOf?）
   */
  update(dt, playerPos, enemies = []) {
    this.events = [];
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const R = this.pointsCfg.RADIUS;

    for (const p of this.points) {
      const inRange = (e) => {
        const dx = e.x - p.x;
        const dz = e.z - p.z;
        return Math.hypot(dx, dz) <= R + (e.radius ?? 0.5);
      };
      let enemiesInRange = 0;
      let guardsAlive = 0;
      for (const e of enemies) {
        if (!e.alive) continue;
        if (!inRange(e)) continue;
        enemiesInRange++;
        if (e.guardOf === p.id) guardsAlive++;
      }
      p.enemiesInRange = enemiesInRange;
      p.guardsAlive = guardsAlive;
      const pdx = (playerPos?.x ?? 0) - p.x;
      const pdz = (playerPos?.z ?? 0) - p.z;
      p.playerInside = Math.hypot(pdx, pdz) <= R;

      if (p.captured) {
        // 已占领：敌人占据据点会触发"夺回"，进度随时间回落，归零则失去据点、扣士气
        if (enemiesInRange > 0) {
          p.progress = Math.max(0, p.progress - this.pointsCfg.DECAY * step);
          if (p.progress <= 0) {
            p.captured = false;
            this.morale = Math.max(this.moraleCfg.MIN, this.morale - this.moraleCfg.PER_CAPTURE);
            this.events.push({ type: 'recapture', point: p.id, morale: this.morale });
          }
        }
      } else {
        // 未占领：
        //   · 玩家在圈内 **且** 守卫已清光 → 占领进度上涨
        //   · 圈内有敌人（含守卫）→ 进度回落（"清掉守卫才能稳定占领"的硬约束）
        //   · 玩家不在且圈内没敌人 → 进度保持（不自动涨也不掉）
        if (p.playerInside && guardsAlive === 0) {
          p.progress = Math.min(100, p.progress + this.pointsCfg.RATE * step);
          if (p.progress >= 100) {
            p.captured = true;
            this.morale = Math.min(this.moraleCfg.MAX, this.morale + this.moraleCfg.PER_CAPTURE);
            this.events.push({ type: 'capture', point: p.id, morale: this.morale });
          }
        } else if (enemiesInRange > 0) {
          p.progress = Math.max(0, p.progress - this.pointsCfg.DECAY * step);
        }
      }
    }

    return this.events;
  }

  snapshot() {
    return {
      morale: this.morale,
      respawnScale: this.respawnScale,
      attackScale: this.attackScale,
      allCaptured: this.allCaptured,
      points: this.points.map((p) => ({
        id: p.id,
        name: p.name,
        progress: p.progress,
        captured: p.captured,
        guardsAlive: p.guardsAlive,
        enemiesInRange: p.enemiesInRange,
        playerInside: p.playerInside,
      })),
    };
  }
}
