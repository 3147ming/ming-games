/**
 * 敌人池（模块 4）—— **纯逻辑**，不 import three / 不碰 DOM。
 * ---------------------------------------------------------------------------
 * 它做的事只有三件：
 *   ① 继承 TargetPool —— 血量 / 受击闪白 / 受击硬直 / 击退 / 命中记账**一行没重写**。
 *      这是"保留已有功能"最硬的证据：模块 3 的战斗链路对敌人和靶子**完全无感**。
 *   ② 在基类前面挂一层 AI（enemyAI.js 的 EnemyDirector）。
 *   ③ 出一份"敌人从哪来"的确定性布点（先锋环 + 远端小队）。
 *
 * ───────────────────────── 关于"池"这个设计选择 ─────────────────────────
 * 模块 3 已经有一个 TargetPool（练武场的 5 个草人）。模块 4 又需要一个敌人池，
 * 而不是把草人换掉、或者把两者塞进同一个池子。理由：
 *
 *   · **草人是"可复现的试招对象"**：满血、不动、打不死（HP 十万），
 *     所有关于"这一刀打了几下、伤害对不对、硬直多长"的断言都挂在它们身上。
 *     让它们动起来、几十个一起上，那些断言就会变成偶发失败。
 *   · **敌人要成群、要移动、要死**。把它们和草人混在一个池里，就得给每个实体挂一个
 *     "我是哪种"的开关，然后每个遍历点都要判 —— 那正是最容易漏判的地方。
 *   · 两者**共用同一套命中结算**（playerCombat 现在扫多个池），所以"保留已有功能"
 *     不是靠把代码复制一份来保证的。
 *
 * 于是场上同时有：练武场（出生点正前方，5 个草人，学招用）+ 战场（160 个敌人）。
 */
import { ENEMY, ENEMY_AI } from '../core/config.js';
import { mulberry32 } from '../core/battlefieldLayout.js';
import { TargetPool } from './targets.js';
import { ENEMY_STATE, EnemyDirector, statesSumTo } from './enemyAI.js';

export { ENEMY, ENEMY_STATE, statesSumTo };

/** 敌人外观的三种"兵种剪影"（纯外观，不影响任何数值 —— 数值只有 ENEMY 一份） */
export const ENEMY_VARIANTS = [
  { id: 'sword', label: '刀兵' },
  { id: 'spear', label: '枪兵' },
  { id: 'axe', label: '斧兵' },
];

export class EnemyPool extends TargetPool {
  /**
   * @param specs     布点（见下方 enemySpawnSpecs）
   * @param aiEnabled 默认 **false** —— 单测/探针要可复现，AI 必须显式打开。
   *                  main.js 传 true；探针在量"站位相关"的读数时会临时关掉它。
   */
  constructor({ specs = [], cfg, aiCfg = ENEMY_AI, enemy = ENEMY, aiEnabled = false } = {}) {
    super({ specs: [], cfg, dummy: enemy });
    this.enemy = enemy;
    this.aiCfg = aiCfg;
    this.director = new EnemyDirector(aiCfg);
    this.aiEnabled = !!aiEnabled;
    this.spawnCount = 0;
    // 模块 8：同屏并发上限。默认 Infinity = 模块 4 原行为（全部 160 一起活）。
    // 关卡启动后由 Stage 设为 STAGE.MAX_ACTIVE（45），并把多余的标 dormant 休眠。
    this.aliveCap = Infinity;
    // 复用同一个 ctx 对象：每帧新建一个的话，60fps × 160 个敌人 = 每秒上千次分配
    this.ctx = { x: 0, z: 0, invincible: false, shapes: [], others: [] };
    this.hitsOnPlayer = 0; // 玩家被敌人打中的次数
    this.dodgedByPlayer = 0; // 被玩家闪避无敌吃掉的次数
    this.whiffs = 0; // 敌人空挥（距离/张角没够着）
    this.events = []; // 上一帧的 AI 事件（透传给表现层）
    for (const s of specs) this.add(s);
  }

  /** 覆盖：把布点补全成"有身份的敌人"（外观变体 / 朝向 / AI 字段） */
  add(spec) {
    const t = super.add({ id: spec.id, x: spec.x, z: spec.z, hp: spec.hp ?? this.enemy.HP });
    t.bound = this.enemy.PUSH_BOUND;
    // ⚠ `spawn` 与 `home` 是两件事，必须分开存：
    //   · `spawn` = **开局布点**，从生到死不变，是 reset() 的唯一依据；
    //   · `home`  = "我现在的老家"，AI 的待机游荡与重生守卫都读它，会被搬动。
    //   曾经只存 home，结果探针为了量站位把整支军队挪走一次之后，
    //   `resetEnemies()` 便把那张"被挪过的地图"当成了开局 —— 布局被永久改写。
    t.spawn = { x: t.x, z: t.z };
    t.dormant = false; // ★模块 8：被关卡"休眠"的冗余敌人（不参战、不渲染、不计击杀）
    t.guardOf = null; // ★模块 6：据点守卫归属（属于哪个据点 id）
    t.noRespawn = false; // ★模块 6：守卫被清空后不应再刷回来，否则据点永远占不下
    t.yaw = spec.yaw ?? 0;
    t.index = this.items.length - 1;
    // 外观变体：几何只烘一次，差异全靠"每实例的缩放 + 色调"表达（见 enemyMesh.js）
    t.variant = spec.variant ?? this.spawnCount % ENEMY_VARIANTS.length;
    t.scale = spec.scale ?? 1;
    t.tone = spec.tone ?? 1;
    t.toneSeed = spec.toneSeed ?? 0;
    t.seed = spec.seed ?? (0x9e3779b9 * (this.spawnCount + 1)) >>> 0;
    this.director.initEnemy(t, this.spawnCount);
    this.spawnCount++;
    return t;
  }

  /** AI 开关。探针用它把战场"冻住"再量站位相关的读数。 */
  setAI(on) {
    this.aiEnabled = !!on;
    return this.aiEnabled;
  }

  /** 覆盖：复位 = **回到开局布点**（而不是"回到上次待的地方"） */
  reset() {
    for (const t of this.items) t.home = { x: t.spawn.x, z: t.spawn.z };
    super.reset();
    this.director.reset(this.items);
    this.hitsOnPlayer = 0;
    this.dodgedByPlayer = 0;
    this.whiffs = 0;
    this.events = [];
    return this.snapshot();
  }

  /**
   * 推进一步。
   * @param dt  帧长（⚠ 主循环传的是**顿帧缩放后**的 pdt —— 命中顿帧要让整个世界一起停）
   * @param now 战斗时间（写 lastHitAt 用）
   * @param ctx { x, z, invincible, shapes, others }：玩家位置/无敌 + 碰撞形状表 + 额外分离圆
   *
   * 顺序是刻意的：**基类先、AI 后**。
   *   基类这一步会把 hardTimer 递减、把击退位移结算掉；
   *   于是 AI 看到的是"这一帧真实的位置与硬直剩余"，而不是上一帧的。
   *   反过来（先 AI 后基类）会让"硬直刚结束的那一刻"多冻结一帧，
   *   并且在被击退的敌人身上读到过期坐标 —— 表现为"AI 在追一个已经不存在的距离"。
   */
  update(dt, now = 0, ctx = null) {
    const events = super.update(dt, now);
    if (ctx) {
      const c = this.ctx;
      c.x = Number.isFinite(ctx.x) ? ctx.x : 0;
      c.z = Number.isFinite(ctx.z) ? ctx.z : 0;
      c.invincible = !!ctx.invincible;
      c.shapes = ctx.shapes || c.shapes || [];
      c.others = ctx.others || c.others || [];
    }
    if (!this.aiEnabled) {
      this.events = events;
      return events;
    }

    const aiEvents = this.director.step(this.items, this.ctx, dt);
    for (const ev of aiEvents) {
      if (ev.type === 'enemy-hit') this.hitsOnPlayer++;
      else if (ev.type === 'enemy-miss') {
        if (ev.reason === 'invincible') this.dodgedByPlayer++;
        else this.whiffs++;
      }
      events.push(ev);
    }

    this._respawnGuard(dt);
    this.events = events;
    return events;
  }

  /**
   * 重生守卫（原型行为，模块 8 的关卡流程会接管）。
   *
   * 基类 TargetPool 的重生是"到点就在老家站起来" —— 但敌人不能这样：
   * 玩家正站在某个杂兵的老家砍杀时，脚下会凭空冒出一个人。所以这里多两条：
   *   ① `ENEMY.RESPAWN = Infinity` 把基类的自动重生关掉（只留计时）；
   *   ② 由本函数在"离玩家至少 RESPAWN_MIN_PLAYER_GAP 米"时才让它站起来。
   */
  _respawnGuard(dt) {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    if (step === 0) return;
    const cfg = this.aiCfg;
    // 模块 8：同屏上限。先算一次活着的个数（别在循环里 O(n²) 重算），满了就不再复活。
    let aliveCount = 0;
    for (const t of this.items) if (t.alive) aliveCount++;
    // 模块 6：士气越高，敌人重生间隔拉得越长（ctx.respawnScale 由 main 按士气算好传入）。
    const respawnScale = Number.isFinite(this.ctx.respawnScale) ? this.ctx.respawnScale : 1;
    const px = this.ctx.x;
    const pz = this.ctx.z;
    for (const t of this.items) {
      if (t.alive) continue;
      if (t.dormant) continue; // ★模块 8：被休眠的冗余敌人在关卡里不参与循环
      if (this.aliveCap !== Infinity && aliveCount >= this.aliveCap) break; // 已达上限
      if (t.respawnTimer < cfg.RESPAWN_DELAY * respawnScale) continue;
      const dx = t.home.x - px;
      const dz = t.home.z - pz;
      if (Math.hypot(dx, dz) < cfg.RESPAWN_MIN_PLAYER_GAP) continue; // 等玩家走开
      t.alive = true;
      t.hp = t.maxHp;
      t.x = t.home.x;
      t.z = t.home.z;
      t.knockVX = 0;
      t.knockVZ = 0;
      t.hitFlash = 0.25;
      t.respawnTimer = 0;
      aliveCount++;
      this.director.initEnemy(t, t.index ?? 0);
    }
  }

  /** 三态 / 插槽 / 命中读数（HUD 与探针共用同一份口径） */
  snapshot() {
    const base = super.snapshot();
    const ai = this.director.snapshot(this.items);
    return {
      ...base,
      ...ai,
      aiEnabled: this.aiEnabled,
      // ⚠ 这三个是**池子从事件流里数出来的**（AI 关掉时恒为 0）。
      //   它们和 director.stats 里的同名项是同一个量，两条独立路径都数一遍是故意的：
      //   单测会断言两者相等 —— 一旦某条路径漏统计（例如 `_strike` 里少 push 了一个事件），
      //   数字就会分叉，而不是静默地都少一点。
      hitsOnPlayer: this.hitsOnPlayer,
      dodgedByPlayer: this.dodgedByPlayer,
      whiffs: this.whiffs,
      consistent: statesSumTo(ai),
    };
  }
}

/**
 * 布点：**先锋环**（14~21m，一开局就够得着）+ **远端小队**（播种在战场各处，等玩家推进）。
 * ---------------------------------------------------------------------------
 * 为什么不是"围着玩家均匀撒一圈"：
 *   ① 全部撒在近处 → 一开局就有 160 个人挤在脸上，玩家没有"推进"这件事可做；
 *   ② 全部撒在远处 → 玩家站在出生点什么都看不见，还以为 AI 没跑起来。
 *   于是分成两层：先锋在新手视野内就开始压上来（验证"威慑态会缓慢靠近"），
 *   小队铺满整张图（验证"超出 22m 保持待机"，也构成关卡推进的目标）。
 *
 * 纯函数（只吃 blockers 的数据 + 一个圆-盒相交函数），所以能被单测覆盖。
 * 用 mulberry32(SPAWN_SEED) —— 和战场布局同一个随机源，刷新页面敌情完全一致。
 */
export function enemySpawnSpecs(spawn = { x: 0, z: 0 }, blockers = [], opts = {}) {
  const cfg = { ...ENEMY, ...opts };
  const probe = opts.circleHitsOBB || null;
  const rng = mulberry32(cfg.SPAWN_SEED >>> 0);
  const out = [];
  const sx = spawn.x ?? 0;
  const sz = spawn.z ?? 0;

  const clash = (x, z) =>
    probe ? blockers.some((b) => probe(x, z, cfg.RADIUS + 0.3, b)) : false;

  /**
   * 沿 dir 往外找第一个不与障碍重叠的点。
   * 先试正前方，再试左右各 35°/70° 的绕行方向 —— 只沿一条直线退的话，
   * 一个宽帐篷正好挡在门口就会让整个方向作废（实测 160 个点里有 17 个是这么丢的）。
   */
  const place = (x, z, dirX, dirZ) => {
    const base = Math.atan2(dirZ, dirX);
    for (const off of [0, 0.61, -0.61, 1.22, -1.22]) {
      const cx = Math.cos(base + off);
      const cz = Math.sin(base + off);
      for (let bump = 0; bump <= 8; bump += 0.7) {
        const px = x + cx * bump;
        const pz = z + cz * bump;
        if (Math.abs(px) > 88 || Math.abs(pz) > 88) break;
        if (!clash(px, pz)) return { x: px, z: pz };
      }
    }
    return null;
  };

  const push = (x, z, dirX, dirZ) => {
    const p = place(x, z, dirX, dirZ);
    if (!p) return;
    const i = out.length;
    out.push({
      id: `enemy-${i + 1}`,
      x: p.x,
      z: p.z,
      // 外观变体与身材差异都从**同一个种子流**里取，所以"第 7 个敌人长什么样"是固定的
      variant: i % ENEMY_VARIANTS.length,
      scale: 0.92 + rng() * 0.16,
      tone: 0.82 + rng() * 0.34,
      toneSeed: rng(),
      yaw: 0,
      seed: ((rng() * 0xffffffff) >>> 0) || 1,
    });
  };

  // ── 先锋环：均匀角度 + 抖动（均匀是刻意的：一开局四面八方都会有人上来，
  //    玩家朝任意方向走都立刻遇到敌人，而不是"只有正面有戏"）
  const n = Math.max(0, cfg.VANGUARD | 0);
  for (let i = 0; i < n; i++) {
    const a = (i / Math.max(1, n)) * Math.PI * 2 + (rng() - 0.5) * 0.3;
    const r = cfg.VANGUARD_R_MIN + rng() * (cfg.VANGUARD_R_MAX - cfg.VANGUARD_R_MIN);
    const dx = Math.sin(a);
    const dz = -Math.cos(a);
    push(sx + dx * r, sz + dz * r, dx, dz);
  }

  // ── 远端小队：每次先找一个合法的小队中心（够远 / 不压障碍 / 不越界），再撒 K 个
  const squads = Math.max(0, cfg.SQUADS | 0);
  const size = Math.max(1, cfg.SQUAD_SIZE | 0);
  for (let s = 0; s < squads; s++) {
    let center = null;
    for (let tries = 0; tries < 48 && !center; tries++) {
      const a = rng() * Math.PI * 2;
      // sqrt 让落点在圆面上**均匀**（不取 sqrt 的话小队会全糊在圆心附近）
      const r = cfg.SPAWN_MIN_GAP + (cfg.SPAWN_MAX_R - cfg.SPAWN_MIN_GAP) * Math.sqrt(rng());
      const x = sx + Math.sin(a) * r;
      const z = sz - Math.cos(a) * r;
      if (Math.abs(x) > 88 || Math.abs(z) > 88) continue;
      if (clash(x, z)) continue;
      center = { x, z };
    }
    if (!center) continue;
    for (let k = 0; k < size; k++) {
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * cfg.SQUAD_SPREAD;
      push(center.x + Math.sin(a) * r, center.z - Math.cos(a) * r, Math.sin(a), -Math.cos(a));
    }
  }

  // ── 回填：前两轮被障碍/边界拒掉的（实测约 10%）在这里补回来，保证总数**恰好** COUNT。
  //    不补的话 COUNT 就只是"上限"而不是"总数" —— 而"同屏 160 个敌人"这个数字
  //    是要写进验收和 HUD 的，不能是个约数。
  const want = Math.max(0, cfg.COUNT | 0);
  for (let tries = 0; out.length < want && tries < want * 16; tries++) {
    const a = rng() * Math.PI * 2;
    const r =
      cfg.VANGUARD_R_MIN + (cfg.SPAWN_MAX_R - cfg.VANGUARD_R_MIN) * Math.sqrt(rng());
    push(sx + Math.sin(a) * r, sz - Math.cos(a) * r, Math.sin(a), -Math.cos(a));
  }

  return out;
}
