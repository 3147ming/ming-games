/**
 * 关卡流程（模块 8）—— **纯逻辑**，不 import three / 不碰 DOM。
 * ---------------------------------------------------------------------------
 * 线性三阶段：frontline（杂兵割草）→ contest（据点争夺）→ boss（Boss 战）→ victory。
 *   · frontline：累计击杀达到 KILLS_TO_CONTEST（60）→ 进入 contest
 *   · contest：3 个据点全部占领（CaptureSystem.allCaptured）→ 触发 boss（emit bossSpawn 事件）
 *   · boss：Boss 被击败（ctx.bossDead）→ victory
 *
 * 另外负责两件"布置"：
 *   · start()：把同屏并发压到 STAGE.MAX_ACTIVE（45），多余的敌人标 dormant 休眠
 *     （模块 4 的 160 仍是池容量，这里只是"同时活着的只有 45"，两者并存，不冲突）。
 *   · setupGuards()：给每个据点指派 GUARDS_PER_POINT 个守卫（复用敌人池里的实体，标 guardOf）。
 *
 * 本类**不创建 Boss 实体**（那需要 TargetPool + 渲染，归 main 管），只发 'bossSpawn' 事件，
 * 由 main 真正实例化 BossController 并把引用喂回来（通过 ctx 的 bossDead 标志驱动后续状态）。
 */
import { POINTS, STAGE } from '../core/config.js';

export class Stage {
  constructor({ cfg = STAGE } = {}) {
    this.cfg = cfg;
    this.phase = 'frontline';
    this.bossSpawned = false;
    this.victory = false;
    this.elapsed = 0;
    this.events = [];
  }

  get phaseIndex() {
    return this.cfg.PHASES.indexOf(this.phase);
  }

  /** 模块 8：同屏上限。把超出 MAX_ACTIVE 的敌人休眠，只留前 MAX_ACTIVE 个参战。 */
  start(enemyPool) {
    const cap = this.cfg.MAX_ACTIVE;
    enemyPool.aliveCap = cap;
    let alive = 0;
    for (const t of enemyPool.items) {
      if (alive < cap) {
        t.dormant = false;
        if (!t.alive) t.alive = true;
        alive++;
      } else {
        t.dormant = true;
        t.alive = false;
      }
    }
  }

  /** 模块 6：给每个据点指派守卫（取池中"存活且未被休眠"的敌人，标 guardOf 并挪到据点圈内） */
  setupGuards(enemyPool) {
    let used = 0;
    for (const p of POINTS.LIST) {
      for (let k = 0; k < POINTS.GUARDS_PER_POINT; k++) {
        const e = enemyPool.items.find((t) => !t.guardOf && !t.dormant && t.alive);
        if (!e) break;
        e.guardOf = p.id;
        const a = (k / Math.max(1, POINTS.GUARDS_PER_POINT)) * Math.PI * 2;
        e.x = p.x + Math.cos(a) * 3.5;
        e.z = p.z + Math.sin(a) * 3.5;
        e.home = { x: e.x, z: e.z };
        used++;
      }
    }
    return used;
  }

  /**
   * @param ctx { kills, allCaptured, bossDead, stats }
   */
  update(dt, ctx = {}) {
    this.events = [];
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    this.elapsed += step;
    if (this.victory) return this.events;

    if (this.phase === 'frontline') {
      if ((ctx.kills ?? 0) >= this.cfg.KILLS_TO_CONTEST) {
        this.phase = 'contest';
        this.events.push({ type: 'phase', from: 'frontline', to: 'contest' });
      }
    } else if (this.phase === 'contest') {
      if (ctx.allCaptured) {
        this.phase = 'boss';
        this.bossSpawned = true;
        this.events.push({ type: 'phase', from: 'contest', to: 'boss', bossSpawn: true });
      }
    } else if (this.phase === 'boss') {
      if (ctx.bossDead) {
        this.phase = 'victory';
        this.victory = true;
        this.events.push({ type: 'victory', stats: ctx.stats ?? {} });
      }
    }
    return this.events;
  }

  snapshot() {
    return {
      phase: this.phase,
      phaseIndex: this.phaseIndex,
      bossSpawned: this.bossSpawned,
      victory: this.victory,
      elapsed: this.elapsed,
      killsToContest: this.cfg.KILLS_TO_CONTEST,
    };
  }
}
