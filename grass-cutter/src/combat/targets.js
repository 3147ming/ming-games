/**
 * 目标池（模块 3 的临时靶子）—— **纯逻辑**，不 import three / 不碰 DOM。
 * ---------------------------------------------------------------------------
 * ⚠ 模块 4 会把它换成真正的敌人（分层 AI、巡逻、攻击态/威慑态）。
 *   现在它的唯一职责是：**让模块 3 的攻击判定有东西可打**，
 *   否则"命中结算"只能靠单测证明，人眼在浏览器里看不到任何反馈。
 *
 * 所以这里刻意只实现"一个靶子需要的最小集合"：
 *   · 血量 / 死亡 / 重生（重生是为了可以反复试招，不是玩法设定）
 *   · 受击闪白的计时（表现层读它）
 *   · 击退速度的积分与衰减（手感的一半在击退上）
 * 刻意**不做**：寻路、攻击、仇恨、状态机 —— 那些全是模块 4 的事。
 */
import { COMBAT } from '../core/config.js';

export const DUMMY = {
  RADIUS: 0.55,
  HEIGHT: 1.8,
  HP: 120,
  RESPAWN: 3.2, // 打碎之后多久重新立起来（原型里方便反复试招）
  PUSH_BOUND: 96,
};

export class TargetPool {
  constructor({ specs = [], cfg = COMBAT, dummy = DUMMY } = {}) {
    this.cfg = cfg;
    this.dummy = dummy;
    this.items = [];
    for (const s of specs) this.add(s);
    this.kills = 0;
    this.respawns = 0;
    this.lastKilled = null;
  }

  add({ id, x = 0, z = 0, hp = this.dummy.HP, maxHp = this.dummy.HP }) {
    const t = {
      id,
      x,
      z,
      home: { x, z },
      y: 0,
      feetY: 0,
      radius: this.dummy.RADIUS,
      height: this.dummy.HEIGHT,
      hp,
      maxHp,
      alive: true,
      hitFlash: 0,
      stunTimer: 0, // ★受击硬直剩余时间（秒）—— 模块 4 的 AI 读它来决定"这段时间不动作"
      lastStun: 0, // 最近一次被打了多长的硬直（调试/探针用）
      respawnTimer: 0,
      knockVX: 0,
      knockVZ: 0,
      lastHitAt: -Infinity,
      hits: 0,
      damageTaken: 0,
      // ⚠ 反向引用：命中结算那条链（playerCombat）要**把伤害记回正确的池子**。
      //   模块 4 起同时存在两个池（练武场的靶子 / 战场上的敌人），没有它就只能在
      //   每次命中时线性搜"这个目标属于哪个池"，或者干脆把所有逻辑揉成一个巨型池。
      pool: this,
    };
    this.items.push(t);
    return t;
  }

  get alive() {
    return this.items.filter((t) => t.alive);
  }

  get count() {
    return this.items.length;
  }

  reset() {
    for (const t of this.items) {
      t.x = t.home.x;
      t.z = t.home.z;
      t.hp = t.maxHp;
      t.alive = true;
      t.hitFlash = 0;
      t.stunTimer = 0;
      t.lastStun = 0;
      t.respawnTimer = 0;
      t.knockVX = 0;
      t.knockVZ = 0;
      t.hits = 0;
      t.damageTaken = 0;
    }
    this.kills = 0;
    this.respawns = 0;
  }

  /** 施加一次击退冲量（沿单位方向，速度叠加） */
  push(target, dir, speed) {
    target.knockVX += dir.x * speed;
    target.knockVZ += dir.z * speed;
  }

  /**
   * 推进一步。
   * @param dt 帧长
   * @param now 当前时间（写入 lastHitAt / 死亡时间用）
   */
  update(dt, now = 0) {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const events = [];
    for (const t of this.items) {
      if (t.hitFlash > 0) t.hitFlash = Math.max(0, t.hitFlash - step);
      if (t.stunTimer > 0) t.stunTimer = Math.max(0, t.stunTimer - step);

      if (!t.alive) {
        t.respawnTimer += step;
        if (t.respawnTimer >= this.dummy.RESPAWN) {
          t.alive = true;
          t.hp = t.maxHp;
          t.x = t.home.x;
          t.z = t.home.z;
          t.knockVX = 0;
          t.knockVZ = 0;
          t.respawnTimer = 0;
          t.hitFlash = 0.2;
          this.respawns++;
          events.push({ type: 'respawn', target: t });
        }
        continue;
      }

      // 击退：先积分，再按指数衰减；低于阈值直接归零（避免永远在飘）
      const sp = Math.hypot(t.knockVX, t.knockVZ);
      if (sp > 1e-6) {
        t.x += t.knockVX * step;
        t.z += t.knockVZ * step;
        const k = Math.max(0, 1 - this.cfg.KNOCKBACK_DECAY * step);
        t.knockVX *= k;
        t.knockVZ *= k;
        if (Math.hypot(t.knockVX, t.knockVZ) < this.cfg.KNOCKBACK_MIN_SPEED * 0.05) {
          t.knockVX = 0;
          t.knockVZ = 0;
        }
        const b = this.dummy.PUSH_BOUND;
        t.x = Math.max(-b, Math.min(b, t.x));
        t.z = Math.max(-b, Math.min(b, t.z));
      }
    }
    return events;
  }

  /**
   * 命中记账（伤害由 hitbox.applyDamage 写进去，这里只统计 + 施加受击硬直）。
   * @param move 这一次打中的招（用它的 `stun` 决定硬直时长；缺省退回 COMBAT.HITSTUN）
   *
   * ⚠ 硬直取 **max** 而不是覆盖：多段 C 技的每一段都会重新打一次硬直，
   *   若取覆盖，6 段的 C5 最后反而只剩 0.1s 硬直，越强的招硬直越短 —— 完全反了。
   */
  noteHit(target, result, now = 0, move = null) {
    target.hits++;
    target.damageTaken += result.damage;
    target.lastHitAt = now;
    if (!result.killed) {
      const stun = move?.stun ?? this.cfg.HITSTUN ?? 0;
      if (stun > target.stunTimer) {
        target.stunTimer = stun;
        target.lastStun = stun;
      }
    } else {
      target.stunTimer = 0;
    }
    if (result.killed) {
      this.kills++;
      this.lastKilled = target.id;
    }
    return result;
  }

  snapshot() {
    return {
      count: this.count,
      alive: this.alive.length,
      kills: this.kills,
      respawns: this.respawns,
      stunned: this.items.filter((t) => t.alive && t.stunTimer > 0).length,
      totalHits: this.items.reduce((a, t) => a + t.hits, 0),
      totalDamage: this.items.reduce((a, t) => a + t.damageTaken, 0),
      lowestHp: this.items.reduce((a, t) => Math.min(a, t.hp), Infinity),
    };
  }
}

/**
 * 训练靶子的布点：从出生点朝前(-Z)摆成一个扇面。
 * ---------------------------------------------------------------------------
 * 为什么要"找空位"而不是写死坐标：战场布局是**种子生成的**（72 个物件），
 * 写死的坐标迟早会撞进某个帐篷里 —— 那时靶子会卡在墙里，看起来像判定出了问题。
 * 所以这里沿射线往外找第一个不与障碍重叠的位置（最多退 6m），找不到就放弃那一根。
 * 这个函数是纯的（只吃 blockerShapes 的数据 + 一个圆-盒相交函数），所以能被单测覆盖。
 */
export function trainingDummySpecs(spawn = { x: 0, z: 0 }, blockers = [], opts = {}) {
  const count = opts.count ?? 5;
  const baseDist = opts.baseDist ?? 8.5;
  const stepDist = opts.stepDist ?? 2.6;
  const spreadDeg = opts.spreadDeg ?? 34;
  const radius = opts.radius ?? DUMMY.RADIUS;
  const probe = opts.circleHitsOBB || null;
  const out = [];
  for (let i = 0; i < count; i++) {
    // -34° … +34° 均匀分布：中间留出正前方的空档，方便看清"前后摇"
    const a = count > 1 ? (-spreadDeg + (2 * spreadDeg * i) / (count - 1)) * (Math.PI / 180) : 0;
    const dist = baseDist + stepDist * (i % 2);
    const dir = { x: Math.sin(a), z: -Math.cos(a) };
    let placed = null;
    for (let bump = 0; bump <= 6; bump += 0.6) {
      const x = (spawn.x ?? 0) + dir.x * (dist + bump);
      const z = (spawn.z ?? 0) + dir.z * (dist + bump);
      if (Math.abs(x) > 90 || Math.abs(z) > 90) break;
      if (!probe) {
        placed = { x: x, z: z };
        break;
      }
      const clash = blockers.some((b) => probe(x, z, radius + 0.25, b));
      if (!clash) {
        placed = { x: x, z: z };
        break;
      }
    }
    if (placed) out.push({ id: 'dummy-' + (i + 1), x: placed.x, z: placed.z });
  }
  return out;
}
