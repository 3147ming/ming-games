/**
 * Boss 战逻辑（模块 8）—— **纯逻辑**，不 import three / 不碰 DOM。
 * ---------------------------------------------------------------------------
 * Boss 复用 TargetPool 里的一个"靶子"作为血容器（这样玩家攻击、受击硬直、击杀判定
 * 走的是**和杂兵完全相同的命中结算**，不用另写一套），本类只负责 Boss 的"行为"：
 *   · 朝玩家移动并保持近身距离
 *   · 两套攻击：skill1 近身扇形 / skill2 范围 AOE（按距离自动选）
 *   · 阶段变化：血量降到 BERSERK_AT 比例 → 狂暴（出手间隔 ×MUL、伤害 ×MUL）
 *   · 击败 → alive=false（stage 据此判定通关）
 *
 * 为什么不直接塞进 EnemyPool：Boss 是**单例 + 规则特殊**（独立血条、狂暴、AOE），
 * 混进 160 杂兵的插槽/分离体系只会互相拖累。它和玩家之间走"事件"对接
 * （emit boss-hit / boss-miss，main 收到后扣玩家血），和模块 4 的敌人攻击同构。
 */
import { BOSS, DEG } from '../core/config.js';

/** 极简 LCG：让 Boss 的出手节奏可复现（单测能跑确定性样本） */
function lcg(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

export class BossController {
  constructor({ target, cfg = BOSS, seed = 0x9e3779b9 } = {}) {
    this.cfg = cfg;
    this.t = target; // 来自 TargetPool 的靶子（hp/maxHp/alive/x/z 都读它）
    this.rng = lcg(seed);
    this.berserk = false;
    this.phase = 'normal';
    this.attackTimer = 1.2; // 出场后先给玩家一点喘息
    this.windup = 0;
    this.windupMax = 0;
    this.recover = 0;
    this.pendingSkill = 0; // 0=无，1=近身，2=AOE
    this.facing = 0;
    this.attackCount = 0;
    this.events = [];
    this.hitFlash = 0;
  }

  get alive() {
    return this.t.alive;
  }

  get hpRatio() {
    return this.t.maxHp > 0 ? this.t.hp / this.t.maxHp : 0;
  }

  /** 攻击间隔（受狂暴压缩） */
  _interval() {
    const [a, b] = [this.cfg.ATTACK_INTERVAL_MIN, this.cfg.ATTACK_INTERVAL_MAX];
    const mul = this.berserk ? this.cfg.BERSERK_INTERVAL_MUL : 1;
    return (a + (b - a) * this.rng()) * mul;
  }

  update(dt, playerPos, ctx = {}) {
    this.events = [];
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    if (this.hitFlash > 0) this.hitFlash = Math.max(0, this.hitFlash - step);
    if (!this.t.alive) return this.events;

    const px = playerPos?.x ?? 0;
    const pz = playerPos?.z ?? 0;
    const dx = px - this.t.x;
    const dz = pz - this.t.z;
    const dist = Math.hypot(dx, dz);
    this.facing = dist > 1e-6 ? Math.atan2(-dx, -dz) : this.facing;

    // ── 阶段变化：血量降到阈值 → 狂暴
    if (!this.berserk && this.hpRatio <= this.cfg.BERSERK_AT) {
      this.berserk = true;
      this.phase = 'berserk';
      this.events.push({ type: 'boss-berserk', hpRatio: this.hpRatio });
    }

    // ── 移动：朝玩家走，但停在近身距离（不贴脸，给玩家走位空间）
    const keep = this.cfg.ATTACK_REACH * 0.85;
    if (this.windup <= 0 && this.recover <= 0 && dist > keep) {
      const sp = this.cfg.MOVE_SPEED * step;
      this.t.x += (dx / dist) * Math.min(sp, dist - keep);
      this.t.z += (dz / dist) * Math.min(sp, dist - keep);
    }

    // ── 出手计时
    if (this.windup > 0) {
      this.windup -= step;
      if (this.windup <= 0) this._strike(playerPos, ctx);
    } else if (this.recover > 0) {
      this.recover -= step;
    } else {
      this.attackTimer -= step;
      if (this.attackTimer <= 0) this._beginAttack(dist);
    }
    return this.events;
  }

  _beginAttack(dist) {
    // 远 → AOE 逼玩家靠近；近 → 近身扇形
    this.pendingSkill = dist > this.cfg.ATTACK_REACH * 1.6 ? 2 : 1;
    if (this.pendingSkill === 2) {
      this.windup = this.cfg.SKILL2_WINDUP;
    } else {
      this.windup = this.cfg.ATTACK_WINDUP;
    }
    this.windupMax = this.windup;
    this.events.push({ type: 'boss-windup', skill: this.pendingSkill });
  }

  _strike(playerPos, ctx = {}) {
    const dmgMul = this.berserk ? this.cfg.BERSERK_DAMAGE_MUL : 1;
    const px = playerPos?.x ?? 0;
    const pz = playerPos?.z ?? 0;
    const dx = px - this.t.x;
    const dz = pz - this.t.z;
    const dist = Math.hypot(dx, dz);

    if (this.pendingSkill === 2) {
      // AOE：范围内必中
      const r = this.cfg.SKILL2_RADIUS;
      if (dist <= r) {
        const dmg = this.cfg.SKILL2_DAMAGE * dmgMul;
        this.events.push({ type: 'boss-hit', skill: 2, damage: dmg, dist });
      } else {
        this.events.push({ type: 'boss-miss', skill: 2, reason: 'range', dist });
      }
      this.recover = this.cfg.SKILL2_RECOVER;
    } else {
      // 近身扇形
      const reach = this.cfg.ATTACK_REACH + (this.t.radius ?? 1);
      if (dist > reach) {
        this.events.push({ type: 'boss-miss', skill: 1, reason: 'range', dist });
      } else {
        const arc = this.cfg.ATTACK_ARC_DEG * DEG;
        const f = { x: -Math.sin(this.facing), z: -Math.cos(this.facing) };
        const cos = dist > 1e-6 ? (dx * f.x + dz * f.z) / dist : 1;
        if (Math.acos(Math.max(-1, Math.min(1, cos))) > arc / 2) {
          this.events.push({ type: 'boss-miss', skill: 1, reason: 'arc', dist });
        } else if (ctx.invincible) {
          this.events.push({ type: 'boss-miss', skill: 1, reason: 'invincible', dist });
        } else {
          const dmg = this.cfg.ATTACK_DAMAGE * dmgMul;
          this.events.push({ type: 'boss-hit', skill: 1, damage: dmg, dist });
        }
      }
      this.recover = this.cfg.ATTACK_RECOVER;
    }
    this.pendingSkill = 0;
    this.attackCount++;
    this.attackTimer = this._interval();
  }

  /** 受击闪白（表现层读它） */
  onDamaged() {
    this.hitFlash = 0.14;
  }

  snapshot() {
    return {
      alive: this.t.alive,
      hp: this.t.hp,
      maxHp: this.t.maxHp,
      hpRatio: this.hpRatio,
      berserk: this.berserk,
      phase: this.phase,
      windup: this.windup,
      windupRatio: this.windupMax > 0 ? this.windup / this.windupMax : 0,
      recover: this.recover,
      skill: this.pendingSkill,
      attackCount: this.attackCount,
      x: this.t.x,
      z: this.t.z,
    };
  }
}
