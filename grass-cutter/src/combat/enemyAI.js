/**
 * 敌人分层 AI（模块 4）—— **纯逻辑**，不 import three / 不碰 DOM，所以能直接 `node --test`。
 * ---------------------------------------------------------------------------
 * 这一层只回答一个问题：**"这一帧，每个杂兵想干什么？"**
 * 它不知道敌人长什么样（那是 enemyMesh.js），也不知道自己属于哪个池子（那是 enemies.js）。
 *
 * ─────────────────────────── 三态与两条阈值线 ───────────────────────────
 *
 *                        22m（★SPEC 威慑态追击距离）
 *   ┌───────────────────────┼──────────────────────────────────────┐
 *   │  待机 IDLE            │  威慑 THREATEN                        │
 *   │  在原位晃荡 / 回老家   │  以 1.05m/s 缓慢逼近，停在 3.9m 环上   │
 *   │  **不发起攻击**        │  **不发起攻击**（★SPEC）               │
 *   └───────────────────────┴──────────────────────────────────────┘
 *                                     │  4.6m 申请插槽（全局仅 35 个）
 *                                     ▼
 *                           攻击 ATTACK（最多 35 个）
 *                           逼近到 1.9m → 前摇 0.4s → 打击 → 收招 0.55s → 间隔 1.2~2.2s
 *                           被拉开到 6.0m → 交还插槽，退回威慑
 *
 * 为什么必须有"名额"（插槽）而不是"谁近谁打"：
 *   如果按距离放行，160 个杂兵会**同时**挤到玩家身上，每一帧都有十几把刀落在同一个点上。
 *   玩家看到的是"我一下都动不了"，而不是"我在一百人里杀出一条路"。
 *   35 个名额把"压力"变成一个**可调的旋钮**：调大更凶，调小更割草。
 *
 * ⚠ 三条不被 spec 明说、但必须写下来的判据（都在测试里有断言钉住）：
 *   ① **迟滞**：三态之间的阈值全部成对出现（22/21、4.6/6.0、3.9±0.5）。
 *      只写一条阈值的话，敌人会在边界上每帧来回切换 —— 表现为原地抽搐。
 *   ② **前摇锁定朝向**：出手前 0.4s 是给玩家的反应窗口（走开或闪避）。
 *      所以打击判定用的是**出手瞬间的朝向与距离**，不是"追踪弹"。
 *   ③ **前摇被打断要作废**：否则玩家"抢先砍中"没有任何收益（举刀被砍 → 僵一下 → 刀照落）。
 */
import { DEG, ENEMY_AI, PLAYER } from '../core/config.js';
import { facingDir } from './hitbox.js';
import { facingFromDir, resolveHorizontal, turnToward } from '../player/motion.js';

export const ENEMY_STATE = {
  IDLE: 'idle', // 待机态：远距离，不动作
  THREATEN: 'threaten', // 威慑态：缓步逼近，围而不攻
  ATTACK: 'attack', // 攻击态：占插槽，真的会打
};

/** 状态显示用的中文名（HUD / 探针读数共用一份，避免两边各写一份） */
export const STATE_LABEL = { idle: '待机', threaten: '威慑', attack: '攻击' };

// ─────────────────────────────────────────────────────────────────────────────
// 攻击插槽
// ─────────────────────────────────────────────────────────────────────────────
/**
 * 攻击插槽系统（★SPEC「采用攻击插槽系统，攻击态敌人占用插槽，敌人被击倒 / 脱离范围后释放插槽」）。
 *
 * 就是一个带容量的集合。刻意写成这么小：它**不该有队列**。
 * 排队会让"谁先打"取决于到达顺序，于是远处的敌人排到号时玩家已经走了 —— 表现成
 * "一堆人排着队冲过来送死"。现在的语义是"这一帧谁在范围内谁抢"，没抢到就退回威慑环，
 * 下一帧再抢 —— 于是压力自然在 35 个名额上滚动，而不是排队。
 */
export class AttackSlots {
  constructor(capacity = ENEMY_AI.MAX_ATTACKERS) {
    this.capacity = Math.max(0, capacity | 0);
    this.holders = new Set();
    this.peak = 0; // 历史峰值（探针断言"从未超过 35"用它）
    this.denied = 0; // 被拒绝的次数（衡量"名额是不是瓶颈"）
  }

  get count() {
    return this.holders.size;
  }

  get free() {
    return Math.max(0, this.capacity - this.holders.size);
  }

  has(id) {
    return this.holders.has(id);
  }

  /** 申请。已经有就返回 true（幂等）；满了返回 false 并记一次 denied。 */
  acquire(id) {
    if (this.holders.has(id)) return true;
    if (this.holders.size >= this.capacity) {
      this.denied++;
      return false;
    }
    this.holders.add(id);
    if (this.holders.size > this.peak) this.peak = this.holders.size;
    return true;
  }

  release(id) {
    return this.holders.delete(id);
  }

  clear() {
    this.holders.clear();
  }

  snapshot() {
    return { capacity: this.capacity, count: this.holders.size, free: this.free, peak: this.peak, denied: this.denied };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 确定性随机
// ─────────────────────────────────────────────────────────────────────────────
/**
 * 逐敌人推进的线性同余发生器。
 * 为什么要"每个敌人自己一个种子"而不是全局一个 rng：
 *   全局 rng 的取值顺序取决于**遍历顺序**，而遍历顺序又取决于谁死谁活 ——
 *   于是"同一份种子两次跑出不同结果"，所有关于攻击间隔的断言都会变成偶发失败。
 *   每个敌人自带种子之后，第 7 号杂兵的第 3 次出手间隔永远是同一个数。
 */
export function nextRand(e) {
  e.aiSeed = (Math.imul(1664525, e.aiSeed >>> 0) + 1013904223) >>> 0;
  return e.aiSeed / 4294967296;
}

/** 区间随机 */
export function randRange(e, lo, hi) {
  return lo + (hi - lo) * nextRand(e);
}

// ─────────────────────────────────────────────────────────────────────────────
// 导演
// ─────────────────────────────────────────────────────────────────────────────
/**
 * 每个敌人的 AI 字段（由 EnemyPool 在 add() 时初始化，语义归这里管）：
 *   state            当前状态
 *   slot             是否持有攻击插槽
 *   attackTimer      距下一次出手还有多久（秒）
 *   windup           前摇剩余（>0 = 正在起手，这一帧会"亮刀"）
 *   recover          收招剩余
 *   yaw              朝向（弧度，yaw=0 → 面向 -Z，与全项目一致）
 *   vx / vz          **自主**速度（收招/硬直时恒为 0；分离推力不计入 —— 测试靠它区分
 *                    "AI 在动"和"被挤动"）
 *   wanderAngle/Timer/Walking   待机游荡的三个量
 *   driftSign        威慑环上的绕行方向（±1）
 *   aiSeed           本敌人的随机种子
 */
export class EnemyDirector {
  constructor(cfg = ENEMY_AI, playerCfg = PLAYER) {
    this.cfg = cfg;
    this.playerCfg = playerCfg;
    this.slots = new AttackSlots(cfg.MAX_ATTACKERS);
    this.time = 0;
    this.resetStats();
  }

  resetStats() {
    this.stats = {
      steps: 0,
      attacks: 0, // 出手次数（含落空）
      backswings: 0, // 前摇被打断而作废的次数
      strikes: 0, // 真正落到打击判定上的次数
      hitsOnPlayer: 0, // 打中玩家
      dodgedByPlayer: 0, // 被闪避无敌吃掉
      missedOutOfRange: 0, // 距离/张角没够着
      outOfArc: 0,
      stunnedSteps: 0, // 因硬直被暂停的"敌人·帧"数
      pairChecks: 0, // 分离运算的配对数（性能读数）
      topUps: 0, // 进入威慑态的累计次数（用来验证迟滞真的生效了）
      drops: 0, // 掉回待机态的累计次数
    };
    this.slots.peak = 0;
    this.slots.denied = 0;
  }

  reset(items = []) {
    this.time = 0;
    this.slots.clear();
    this.resetStats();
    for (const e of items) this.initEnemy(e);
  }

  /** 给一个敌人装上 AI 字段（幂等：重复调用只是复位，不会丢身份） */
  initEnemy(e, index = 0) {
    e.state = ENEMY_STATE.IDLE;
    e.slot = false;
    e.aiSeed = ((e.seed ?? index * 2654435761) >>> 0) || 1;
    e.attackTimer = randRange(e, this.cfg.ATTACK_INTERVAL_MIN, this.cfg.ATTACK_INTERVAL_MAX);
    e.windup = 0;
    e.recover = 0;
    e.yaw = e.yaw ?? 0;
    e.vx = 0;
    e.vz = 0;
    e.speed = 0;
    e.wanderAngle = randRange(e, 0, Math.PI * 2);
    e.wanderTimer = randRange(e, 0, 2);
    e.wanderWalking = false;
    e.driftSign = nextRand(e) < 0.5 ? -1 : 1;
    e.distToPlayer = Infinity;
    e.blockedBySlot = 0;
    e.attacks = 0;
    e.hitsOnPlayer = 0;
    e.aiPaused = 0;
    e.neighbors = 0;
    return e;
  }

  /** 待机时"投掷"一次新的攻击间隔 */
  _rollInterval(e) {
    return randRange(e, this.cfg.ATTACK_INTERVAL_MIN, this.cfg.ATTACK_INTERVAL_MAX);
  }

  /**
   * 推进一帧。
   * @param items 敌人数组（原地修改）
   * @param ctx   { x, z, invincible, shapes, others }
   *              · shapes —— 模块 1 的碰撞形状表（复用玩家那一份，墙和帐篷对敌我都成立）
   *              · others —— 额外参与分离的圆（不含在 items 里的，例如练武场的靶子）
   * @returns 事件数组 [{type:'enemy-attack'|'enemy-hit'|'enemy-miss', enemy, ...}]
   */
  step(items, ctx = {}, dt = 0) {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const events = [];
    if (step === 0 || !items || items.length === 0) return events;
    this.time += step;
    this.stats.steps++;

    const px = Number.isFinite(ctx.x) ? ctx.x : 0;
    const pz = Number.isFinite(ctx.z) ? ctx.z : 0;

    // ── 1) 距离：一次算好，迁移与行动共用（避免两遍 hypot）
    for (const e of items) {
      if (!e.alive) {
        e.distToPlayer = Infinity;
        e.vx = 0;
        e.vz = 0;
        e.speed = 0;
        continue;
      }
      e.distToPlayer = Math.hypot(e.x - px, e.z - pz);
    }

    // ── 2) 状态迁移 + 插槽申请
    for (const e of items) {
      if (!e.alive) {
        // 死亡即刻交还插槽（★SPEC「敌人被击倒…后释放插槽」）
        if (e.slot) {
          this.slots.release(e.id);
          e.slot = false;
        }
        e.state = ENEMY_STATE.IDLE;
        e.windup = 0;
        e.recover = 0;
        continue;
      }
      if (e.stunTimer > 0) {
        // ★SPEC「敌人受击后进入硬直暂停 AI 逻辑」：暂停，不迁移状态、不申请插槽。
        // 但"前摇中被打断"要作废这次攻击（见文件头的判据 ③）。
        if (this.cfg.STUN_CANCELS_WINDUP && e.windup > 0) {
          e.windup = 0;
          e.attackTimer = this._rollInterval(e);
          this.stats.backswings++;
        }
        continue;
      }
      this._transition(e);
    }

    // ── 3) 行为：算出每个敌人的**自主**速度（不动位置，位置统一在 5) 里落）
    for (const e of items) {
      e.vx = 0;
      e.vz = 0;
      e.mvx = 0;
      e.mvz = 0;
      e.speed = 0;
      e.neighbors = 0;
      if (!e.alive) continue;
      if (e.stunTimer > 0) {
        this.stats.stunnedSteps++;
        e.aiPaused += step;
        continue;
      }
      this._act(e, px, pz, step, ctx, events);
    }

    // ── 4) 分离（先算位置、后统一施加，保证结果与遍历顺序无关）
    this._separate(items, ctx);

    // ── 5) 落地：把"自主速度 + 分离速度"合成一次位移，走完整的碰撞解算
    for (const e of items) {
      if (!e.alive) continue;
      let dx = (e.vx + e.pvx) * step;
      let dz = (e.vz + e.pvz) * step;

      // 硬性间距：把"站进玩家身体里"这件事从**软推力**升级成**硬约束**。
      // 为什么软推力不够（实测过）：34 个杂兵同时往里挤时，PLAYER_PUSH 6m/s 也顶不住，
      // 最近的一个会站到 0.74m —— 玩家被"包"在中间，视觉上是穿模，手感上是走不掉。
      // 放在这里（同一次 resolveHorizontal 里）而不是移动之后单独推：这样"被墙挡住"
      // 和"被玩家挡住"会被同一次解算处理，不会出现"推开玩家的那一下把人推进帐篷里"。
      const px = Number.isFinite(ctx.x) ? ctx.x : 0;
      const pz = Number.isFinite(ctx.z) ? ctx.z : 0;
      const ddx = e.x - px;
      const ddz = e.z - pz;
      const dd = Math.hypot(ddx, ddz);
      if (dd < this.cfg.STANDOFF && dd > 1e-6) {
        const need = this.cfg.STANDOFF - dd;
        dx += (ddx / dd) * need;
        dz += (ddz / dd) * need;
      }

      if (dx === 0 && dz === 0) continue;
      const r = resolveHorizontal(
        { x: e.x, z: e.z },
        { x: dx, z: dz },
        e.radius,
        0, // 敌人不做竖直运动，恒在地面
        ctx.shapes || [],
        { stepHeight: this.cfg.STEP_HEIGHT, bound: e.bound ?? 96 }
      );
      e.x = r.x;
      e.z = r.z;
      e.hitWall = r.hitX || r.hitZ;
    }

    // ── 6) 收尾：把状态与朝向同步给表现层，并回收不该再持有的插槽
    for (const e of items) {
      if (e.alive && e.speed > 0) {
        const want = facingFromDir(e.mvx, e.mvz);
        if (want !== null) e.yaw = turnToward(e.yaw, want, this.cfg.TURN_RATE_DEG * DEG * step);
      }
      if (e.slot && (!e.alive || e.state !== ENEMY_STATE.ATTACK)) {
        this.slots.release(e.id);
        e.slot = false;
      }
    }

    return events;
  }

  // ────────────────────────────────────────────────────────── 状态迁移
  _transition(e) {
    const cfg = this.cfg;
    const d = e.distToPlayer;
    const S = ENEMY_STATE;

    if (e.state === S.IDLE) {
      // 迟滞的入界：21m（出界是 spec 的 22m）
      if (d < cfg.RE_ENGAGE) {
        e.state = S.THREATEN;
        this.stats.topUps++;
      }
    } else if (d > cfg.LEASH) {
      // ★SPEC「超出 22m 切回待机」+ 交还插槽（脱离范围释放）
      if (e.slot) {
        this.slots.release(e.id);
        e.slot = false;
      }
      e.state = S.IDLE;
      e.windup = 0;
      this.stats.drops++;
    }

    if (e.state === S.THREATEN) {
      if (d <= cfg.ATTACK_TRIGGER) {
        if (this.slots.acquire(e.id)) {
          e.state = S.ATTACK;
          e.slot = true;
          if (!(e.attackTimer > 0)) e.attackTimer = this._rollInterval(e);
        } else {
          e.blockedBySlot++; // 名额满了：留在威慑环上等，这就是"不同时围殴"的机制
        }
      }
    } else if (e.state === S.ATTACK && d > cfg.ATTACK_LEASH) {
      this.slots.release(e.id);
      e.slot = false;
      e.state = S.THREATEN;
      e.windup = 0;
    }
    return e.state;
  }

  // ────────────────────────────────────────────────────────── 行为
  _act(e, px, pz, step, ctx, events) {
    const cfg = this.cfg;
    const d = e.distToPlayer;
    const S = ENEMY_STATE;
    // 指向玩家的单位向量（重合时给一个稳定的兜底方向，避免 NaN）
    const toX = d > 1e-6 ? (px - e.x) / d : 0;
    const toZ = d > 1e-6 ? (pz - e.z) / d : -1;

    if (e.state === S.ATTACK) {
      // 收招：不动（这是"打完一轮的空档"，玩家的反击窗口）
      if (e.recover > 0) {
        e.recover = Math.max(0, e.recover - step);
        return;
      }
      // 前摇：站定、亮刀、到点打击
      if (e.windup > 0) {
        e.windup = Math.max(0, e.windup - step);
        if (e.windup === 0) this._strike(e, ctx, events);
        return;
      }
      if (d > cfg.ATTACK_RANGE) {
        e.vx = toX * cfg.ATTACK_SPEED;
        e.vz = toZ * cfg.ATTACK_SPEED;
        e.mvx = e.vx;
        e.mvz = e.vz;
        e.speed = cfg.ATTACK_SPEED;
        return;
      }
      // 到位了：等间隔，到点起手
      e.attackTimer -= step;
      if (e.attackTimer <= 0) {
        e.attackTimer = this._rollInterval(e); // 先掷下一次间隔，避免前摇期间重复触发
        e.windup = cfg.ATTACK_WINDUP;
        this.stats.attacks++;
        events.push({ type: 'enemy-attack', enemy: e });
      }
      return;
    }

    if (e.state === S.THREATEN) {
      // 围而不攻：保持在 THREATEN_RING 这一圈上，并沿切线慢慢绕行（看起来"活着"）
      const ring = cfg.THREATEN_RING;
      if (d > ring + 0.45) {
        e.vx = toX * cfg.THREATEN_SPEED;
        e.vz = toZ * cfg.THREATEN_SPEED;
      } else if (d < ring - 0.7 && d > 1e-6) {
        e.vx = -toX * cfg.THREATEN_SPEED * 0.8;
        e.vz = -toZ * cfg.THREATEN_SPEED * 0.8;
      } else {
        // 环上绕行：切向 = 前向转 90°
        const t = cfg.THREATEN_SPEED * 0.35 * e.driftSign;
        e.vx = -toZ * t;
        e.vz = toX * t;
      }
      e.mvx = e.vx;
      e.mvz = e.vz;
      e.speed = Math.hypot(e.vx, e.vz);
      return;
    }

    // ── 待机态
    const hx = (e.home?.x ?? e.x) - e.x;
    const hz = (e.home?.z ?? e.z) - e.z;
    const hd = Math.hypot(hx, hz);
    const wanderR = cfg.WANDER_RADIUS;
    if (hd > wanderR) {
      e.vx = (hx / hd) * cfg.HOME_RETURN_SPEED;
      e.vz = (hz / hd) * cfg.HOME_RETURN_SPEED;
      e.wanderWalking = true;
    } else {
      e.wanderTimer -= step;
      if (e.wanderTimer <= 0) {
        e.wanderWalking = !e.wanderWalking;
        e.wanderTimer = e.wanderWalking ? randRange(e, 1.2, 2.6) : randRange(e, 0.8, 2.2);
        if (e.wanderWalking) e.wanderAngle = randRange(e, 0, Math.PI * 2);
      }
      if (e.wanderWalking) {
        e.vx = Math.sin(e.wanderAngle) * cfg.WANDER_SPEED;
        e.vz = -Math.cos(e.wanderAngle) * cfg.WANDER_SPEED;
      }
    }
    e.mvx = e.vx;
    e.mvz = e.vz;
    e.speed = Math.hypot(e.vx, e.vz);
  }

  /**
   * 打击判定。★SPEC 的核心手感条款都落在这里：
   *   · 距离与张角都要够（**不是**追踪弹 —— 玩家跑开就能躲）
   *   · 玩家闪避无敌 → 落空（模块 2 的无敌在这里第一次有了对手戏）
   */
  _strike(e, ctx, events) {
    const cfg = this.cfg;
    e.attacks++;
    this.stats.strikes++;
    e.recover = cfg.ATTACK_RECOVER;
    e.vx = 0;
    e.vz = 0;
    e.speed = 0;

    const px = Number.isFinite(ctx.x) ? ctx.x : 0;
    const pz = Number.isFinite(ctx.z) ? ctx.z : 0;
    const dx = px - e.x;
    const dz = pz - e.z;
    const d = Math.hypot(dx, dz);
    e.lastStrikeDist = d;
    const reach = cfg.ATTACK_REACH + (this.playerCfg.RADIUS ?? 0);

    if (d > reach) {
      this.stats.missedOutOfRange++;
      events.push({ type: 'enemy-miss', enemy: e, reason: 'range', dist: d });
      return;
    }
    const arc = cfg.ATTACK_ARC_DEG * DEG;
    if (arc < Math.PI * 2 - 1e-9 && d > 1e-6) {
      const f = facingDir(e.yaw);
      const cos = (dx * f.x + dz * f.z) / d;
      if (Math.acos(Math.max(-1, Math.min(1, cos))) > arc / 2) {
        this.stats.outOfArc++;
        events.push({ type: 'enemy-miss', enemy: e, reason: 'arc', dist: d });
        return;
      }
    }
    if (ctx.invincible) {
      // 闪避的无敌帧 / 无双乱舞的无敌：刀从身上穿过去
      this.stats.dodgedByPlayer++;
      events.push({ type: 'enemy-miss', enemy: e, reason: 'invincible', dist: d });
      return;
    }
    e.hitsOnPlayer++;
    this.stats.hitsOnPlayer++;
    // ★模块 6：士气越高敌人攻击力越低。ctx.damageScale 由 main 按当前士气算好传进来
    //   （基准士气 50 → 1.0；100 → 1 - ATTACK_REDUCE）。不在这里算，是因为士气状态归 points/morale 系统管。
    const dmg = cfg.ATTACK_DAMAGE * (Number.isFinite(ctx.damageScale) ? ctx.damageScale : 1);
    events.push({ type: 'enemy-hit', enemy: e, damage: dmg, dist: d });
  }

  // ────────────────────────────────────────────────────────── 分离 / 推挤
  /**
   * 杂兵之间的分离力 + 与玩家的推挤。
   *
   * 复杂度是 O(n²)：160 个杂兵 = 12720 对/帧。看着吓人，实测约 0.2ms
   * （纯数值运算，没有分配、没有 sqrt —— 只有真正重叠的那几对才算 sqrt）。
   * 为什么不上空间哈希：`COUNT` 涨到 600 才会到 3ms 量级，而代价是引入一层
   * "格子边界处的分离盲区"，那是**肉眼可见的穿模**。先要正确，再谈规模。
   * 真到需要的时候换哈希，`stats.pairChecks` 就是那时候的判据。
   */
  _separate(items, ctx) {
    const cfg = this.cfg;
    const n = items.length;
    const sep = cfg.SEPARATION;
    const sep2 = sep * sep;
    let checks = 0;

    // 清空上一帧的分离速度。⚠ 这一步不能省：留着的话"曾经被挤过"的敌人会永远保持
    // 那一下的推力一直漂（表现为战场上一部分人缓慢地集体平移）。
    for (let i = 0; i < n; i++) {
      const e = items[i];
      e.pvx = 0;
      e.pvz = 0;
    }

    for (let i = 0; i < n; i++) {
      const a = items[i];
      if (!a.alive) continue;
      let ax = 0;
      let az = 0;
      for (let j = i + 1; j < n; j++) {
        const b = items[j];
        if (!b.alive) continue;
        checks++;
        let dx = b.x - a.x;
        let dz = b.z - a.z;
        let d2 = dx * dx + dz * dz;
        if (d2 >= sep2) continue;
        let d;
        if (d2 < 1e-8) {
          // 完全重合：用一对确定性的方向把它们掰开（否则会永远叠在一起）
          const ang = ((i * 31 + j * 17) % 628) / 100;
          dx = Math.cos(ang);
          dz = Math.sin(ang);
          d = 1e-4;
          d2 = d * d;
        } else {
          d = Math.sqrt(d2);
        }
        const overlap = (sep - d) / sep; // 0..1
        const nx = dx / d;
        const nz = dz / d;
        ax -= nx * overlap;
        az -= nz * overlap;
        b.pvx += nx * overlap;
        b.pvz += nz * overlap;
        a.neighbors++;
        b.neighbors++;
      }
      a.pvx += ax;
      a.pvz += az;
    }

    // 归一化 + 限幅：推力只反映"朝哪个方向挤"，不反映"被几个人同时挤"
    // （不加这一步，人堆正中心的那个会被叠成几十倍推力，一帧弹出几十米）
    const push = cfg.SEPARATION_PUSH;
    const maxN = cfg.SEPARATION_MAX_NEIGHBORS;
    for (const e of items) {
      if (!e.alive) continue;
      let vx = e.pvx;
      let vz = e.pvz;
      const m = Math.hypot(vx, vz);
      if (m > 1e-6) {
        const scale = Math.min(1, m) * push;
        // 被很多邻居同时挤 → 按"邻居数"让步（见 maxN 的注释）
        const crowd = Math.min(1, maxN / Math.max(1, e.neighbors));
        // 起手/收招时"站稳桩"：分离推力打折。
        // ⚠ 这一条不是手感修饰，是**必要性**：密集人堆里，正在起手的那个会被后面的
        //   人推出攻击距离（实测被推到 3~6m），于是它照样挥刀 → 打出一片"空挥白烟"。
        //   扎住马步之后，"看得见的刀"和"够得着的距离"才对得上。
        const brace = e.windup > 0 || e.recover > 0 ? cfg.BRACE_SCALE : 1;
        vx = (vx / m) * scale * crowd * brace;
        vz = (vz / m) * scale * crowd * brace;
      }
      // 与玩家的硬推挤：不允许站在玩家身体里（这是"能走掉"的前提）
      const px = Number.isFinite(ctx.x) ? ctx.x : 0;
      const pz = Number.isFinite(ctx.z) ? ctx.z : 0;
      // 练武场的靶子等"额外圆"：只把它们当障碍，不给它们速度
      const others = ctx.others;
      if (others && others.length) {
        for (const o of others) {
          if (!o || o.alive === false) continue;
          const ox = e.x - o.x;
          const oz = e.z - o.z;
          const od = Math.hypot(ox, oz);
          const gap = sep + (o.radius ?? 0.5);
          if (od < gap && od > 1e-6) {
            const w = (gap - od) / gap;
            vx += (ox / od) * cfg.SEPARATION_PUSH * w;
            vz += (oz / od) * cfg.SEPARATION_PUSH * w;
          }
        }
      }
      e.pvx = vx;
      e.pvz = vz;
    }
    this.stats.pairChecks += checks;
  }

  // ────────────────────────────────────────────────────────── 读数
  /** 三态计数 + 插槽读数（HUD 与探针共用同一份口径，避免两边各算一次算法不同） */
  snapshot(items) {
    let idle = 0;
    let threaten = 0;
    let attack = 0;
    let dead = 0;
    let holding = 0;
    let winding = 0;
    let recovering = 0;
    let stunned = 0;
    let moving = 0;
    let within22 = 0;
    let withinTrigger = 0;
    for (const e of items) {
      if (!e.alive) {
        dead++;
        continue;
      }
      if (e.stunTimer > 0) stunned++;
      if (e.slot) holding++;
      if (e.windup > 0) winding++;
      else if (e.recover > 0) recovering++;
      if (e.speed > 0) moving++;
      if (e.distToPlayer <= this.cfg.LEASH) within22++;
      if (e.distToPlayer <= this.cfg.ATTACK_TRIGGER) withinTrigger++;
      if (e.state === ENEMY_STATE.IDLE) idle++;
      else if (e.state === ENEMY_STATE.THREATEN) threaten++;
      else if (e.state === ENEMY_STATE.ATTACK) attack++;
    }
    return {
      total: items.length,
      alive: items.length - dead,
      dead,
      idle,
      threaten,
      attack,
      within22,
      withinTrigger,
      holding,
      winding,
      recovering,
      stunned,
      moving,
      slots: this.slots.snapshot(),
      ...this.stats,
    };
  }
}

/** 三态是否守恒（HUD/探针都要靠它兜住"某个状态漏算"的 bug） */
export function statesSumTo(snap) {
  return snap.idle + snap.threaten + snap.attack + snap.dead === snap.total;
}
