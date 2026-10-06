/**
 * 玩家战斗系统（模块 3 的胶合层）—— **纯逻辑**，不 import three / 不碰 DOM。
 * ---------------------------------------------------------------------------
 * 它把三件事缝在一起，除此之外什么都不做：
 *   chain.js（这一招该放什么、放到哪一拍了）
 *   + hitbox.js（打到谁、打多少）
 *   + targets.js（被打的人怎么反应）
 *   → 回写 PlayerController（接管移动、前冲位移）
 *
 * 分成"接管的两个口子"是刻意的（见 controller.js）：
 *   攻击 = 锁定 WASD + 每帧硬推一段位移（pushDisplacement，精确到米）
 *   蓄力 = 不锁 WASD，但速度压到 55%（setMotionOverride）
 * 这样"攻击撞墙"和"走路撞墙"走的是同一套碰撞解算，不会出现两套行为。
 *
 * ⚠ 主循环里本类必须在 `player.update()` **之后**调用：
 *   这样命中判定用的是本帧的最终位置，不会有"判定比人慢一帧"的错觉。
 */
import { ARTS, COMBAT, DEG, MUSOU, PLAYER } from '../core/config.js';
import { ComboState, chainNext, moveTotal } from './chain.js';
import { applyDamage, collectHits, facingDir } from './hitbox.js';

export class PlayerCombat {
  /**
   * @param pool  单个目标池（模块 3 的用法，保留）
   * @param pools 多个目标池（模块 4 起：练武场的靶子 + 战场上的敌人）
   *
   * ⚠ 为什么不干脆合成一个池：靶子是"可复现的试招对象"（满血、不动、打不死），
   *   敌人要成群、要移动、要死。两者混在一个池里，每个遍历点都要判"我是哪种" ——
   *   那正是最容易漏判的地方。而"保留已有功能"这件事**不是**靠各写一份代码来保证的：
   *   下面只有一个 `_collectTargets()` / `_poolOf()`，两个池走的是同一条链路。
   */
  constructor({ player, input, pool = null, pools = null, cfg = COMBAT, musouCfg = MUSOU, onEvent = null } = {}) {
    this.player = player;
    this.input = input;
    this.pools = pools ? [...pools] : pool ? [pool] : [];
    this.cfg = cfg;
    this.musouCfg = musouCfg;
    this.playerRadius = PLAYER.RADIUS; // 前冲钳制要用（不许把自己送进敌人身体里）
    this.chain = new ComboState(cfg);
    this.onEvent = onEvent;

    this.time = 0;
    this.hitstop = 0;
    this.swingFacing = 0; // 每次挥击**锁死**的朝向（挥到一半转镜头不该改变判定方向）
    this.lunged = 0; // 本次挥击已经推出去的位移（用来精确凑满 advance）

    this.combo = 0;
    this.comboTimer = 0;
    this.maxCombo = 0;
    this.kills = 0;
    this.hits = 0;
    this.damageDealt = 0;
    this.musou = 0;
    this.ki = musouCfg.KI_START ?? 0;
    this.kiRegen = musouCfg.KI_REGEN ?? 0; // ★SPEC 斗气每秒自动恢复
    this.ranbuTimer = 0; // ★SPEC 无双乱舞剩余时间（>0 = 正在释放，期间无敌）
    this.ranbuTickAcc = 0; // 无双 AOE 的结算累加器
    this.arts = { art1: { cd: 0 }, art2: { cd: 0 } }; // ★SPEC 两套武艺的冷却计时

    this.lastDamage = 0; // 最近一次命中的伤害（HUD 用）
    this.lastHitAt = -Infinity;
    this.events = [];
    // 复用的目标数组：一次挥击最多 6 段判定，每段都新建一个 160+ 元素的数组太浪
    this._targets = [];
  }

  /** 向后兼容：老代码（单池）读 `combat.pool` */
  get pool() {
    return this.pools[0] ?? null;
  }

  /** 向后兼容：老代码（单池）写 `combat.pool = x`。写 null/undefined = 清空全部池。 */
  set pool(v) {
    this.pools = v ? [v] : [];
  }

  // ─────────────────────────────────────────── 只读状态

  get phase() {
    return this.chain.phase;
  }

  get busy() {
    return this.chain.busy;
  }

  get move() {
    return this.chain.move;
  }

  /** 顿帧时玩家的玩法时间被冻结（主循环读它去缩放 player.update 的 dt） */
  get playerTimeScale() {
    return this.hitstop > 0 ? 0 : 1;
  }

  get musouRatio() {
    return this.musou / this.musouCfg.GAUGE_MAX;
  }

  get kiRatio() {
    return this.ki / this.musouCfg.KI_MAX;
  }

  /** 给模块 3 的效果层读的"这一招现在长什么样" */
  fxState() {
    const m = this.chain.move;
    if (!m) return null;
    return { move: m, t: this.chain.t, progress: this.chain.progress, phase: this.chain.phase, facing: this.swingFacing };
  }

  /**
   * 把连段整个清空（调试面板 / 探针复位用）。
   * ⚠ 必须走 `chain.reset()` 而不是 `chain.cancel()`：cancel 会**保留 prevId**，
   *   于是"复位"之后第一下轻攻击会从上一轮的段数接着往下走（探针实测：应该出 N1 却出了 N3）。
   */
  resetChain() {
    this.chain.reset();
    this.events = [];
    return [];
  }

  // ─────────────────────────────────────────── 主循环

  /**
   * @param dt 帧长（秒）
   * @param cameraYaw 当前镜头朝向 —— 只在**起手那一帧**用来瞄准（之后锁死）
   */
  update(dt, cameraYaw = 0) {
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(0.05, dt) : 0;
    this.events = [];

    // ── 0. 顿帧：玩法时间冻结（连段不推进、位移不发），但顿帧计时自己要走
    if (this.hitstop > 0) {
      this.hitstop = Math.max(0, this.hitstop - step);
      this.player.setMotionOverride(null, 0);
      this.player.discardForced(); // 队列里的前冲也要丢掉，否则"冻结"只是名义上的
      return this.events;
    }

    this.time += step;
    this._tickCombo(step);

    // ── 1. 闪避取消攻击。这是动作游戏的通用规则：**闪避永远可以打断攻击**
    //    （否则"砍到一半被围住就必死"，玩家会立刻觉得操作不起来）
    if (this.player.isDodging) {
      const ev = this.chain.cancel('dodge');
      if (ev.length) this.events.push(...ev);
    }

    // ── 2. 输入 → 连段意图
    const heavyPressed = this.input.consumeActionPress('heavyAttack', this.cfg.INPUT_BUFFER);
    const heavyDown = this.input.isActionDown('heavyAttack');
    const lightPressed = this.input.consumeActionPress('lightAttack', this.cfg.INPUT_BUFFER);

    // ⚠ 蓄力松手会**直接起手一招**，这条路径和"连段接续"是两回事：
    //   连段接续的 start 事件来自 chain.update 的返回值，而这里来自 startCharge/releaseCharge。
    //   两边必须走**同一套** _onSwingStart 处理，否则松手那一刀：朝向沿用上一招的（砍空）、
    //   前冲额度不清零（刀不动）、刀光不播（看不见）。这个 bug 在单测里藏了很久 ——
    //   单测全程 yaw=0，陈旧值和正确值恰好一样；直到探针里"先朝 π 砍一刀再蓄力"才暴露。
    const chargeEvents = [];
    if (!this.player.isDodging) {
      if (lightPressed && !this.chain.charging) {
        // 轻攻击：起手前把角色对准镜头（无双里的"面向哪就打哪"）
        this.chain.request('light', this.time);
      }
      if (heavyPressed && !this.chain.charging) {
        // 刚按下重攻击键：进入蓄力（先不决定放哪一招，看松手时蓄了多少）
        this.player.facing = cameraYaw;
        // ⚠ baseId 必须用**显式轻击计数**去算，不能只给 prevId：
        //   轻攻击连段 N5 之后会循环回 N1，只靠 prevId 反推会把"已经打了 6 段"
        //   误判成"只打了 1 段"，于是轻×4 之后按住重键蓄力，蓄满前松手放出的是
        //   独立重击而不是 C5。
        const baseId = chainNext(this.chain.prevId, 'heavy', this.chain.lightCount);
        chargeEvents.push(...this.chain.startCharge(baseId));
      }
      if (this.chain.charging && !heavyDown) {
        const ratio = this.chain.chargeRatio;
        const charged = ratio >= 1;
        chargeEvents.push(...this.chain.releaseCharge(charged));
      }
    }

    // ── 3. 推进连段（它返回本帧的事件：起手 / 判定 / 结束 / 蓄力进度）
    const before = this.chain.charging;
    const chainEvents = this.chain.update(step, this.time);
    // 两条路径的事件合起来按发生顺序处理（蓄力松手在前，连段推进在后）
    const fresh = [...chargeEvents, ...chainEvents];
    this.events.push(...fresh);

    for (const ev of fresh) {
      if (ev.type === 'start') this._onSwingStart(ev, cameraYaw);
      else if (ev.type === 'hit') this._onSwingHit(ev);
    }
    // 蓄力中不算"起手"，朝向也跟着镜头转（蓄力斩可以边走边瞄）
    if (!before && !this.chain.charging && this.chain.move) {
      this.player.facing = this.swingFacing;
    }

    // ── 2.5 模块 5：无双槽 / 武艺（无双乱舞 R、武艺 1/2）。与连段互不冲突，单独走一条。
    this._updateSpecial(step, cameraYaw);

    // ── 4. 移动接管
    // ⚠ 顿帧**可能是这一帧刚触发的**（就在上面的 _onSwingHit 里）。如果这里照常排前冲位移，
    //   冻结就只是名义上的：下一帧 player.update(0) 仍会把队列里的位移一次性发出去，
    //   实测顿帧期间会多滑 7cm —— 玩家会觉得"顿帧糊掉了"。
    if (this.hitstop > 0) {
      this.player.setMotionOverride(null, 0);
      this.player.discardForced();
    } else {
      this._applyMotion(step, cameraYaw);
    }

    return this.events;
  }

  // ─────────────────────────────────────────── 内部

  _tickCombo(step) {
    if (this.comboTimer > 0) {
      this.comboTimer = Math.max(0, this.comboTimer - step);
      if (this.comboTimer === 0) this.combo = 0;
    }
  }

  _onSwingStart(ev, cameraYaw) {
    const move = ev.move;
    this.swingFacing = cameraYaw; // 锁定朝向
    this.player.facing = cameraYaw;
    this.lunged = 0;
    this.events.push({ type: 'swing', move, id: move.id, charged: !!ev.charged });
  }

  /** 判定生效 → 结算命中 */
  _onSwingHit(ev) {
    const move = ev.move;
    // ⚠ 去重集是**每段判定一份**，不是每次挥击一份。
    //   C 技声明 hits:3 的意思就是"对同一个目标打 3 次"（多段打击）。
    //   如果全招共用一份去重集，那 3 段里只有第 1 段会生效 —— 伤害直接少 2/3。
    const seen = new Set();
    const targets = this._collectTargets();
    if (!targets.length && !this.pools.length) {
      this.events.push({ type: 'hit', move, index: ev.index, targets: 0 });
      return;
    }

    const origin = { x: this.player.position.x, z: this.player.position.z };
    const found = collectHits({
      origin,
      facing: this.swingFacing,
      move,
      targets,
      alreadyHit: seen,
      max: this.cfg.MAX_HITS_PER_SWING,
    });

    for (const t of found) {
      const res = applyDamage(t, move, origin);
      seen.add(t.id);
      const p = this._poolOf(t);
      if (p) {
        p.push(t, res.knock, move.knockback);
        p.noteHit(t, res, this.time, move); // 招式的 stun → 目标受击硬直
      }

      this.hits++;
      this.damageDealt += res.damage;
      this.lastDamage = res.damage;
      this.lastHitAt = this.time;
      this.combo++;
      this.comboTimer = this.cfg.COMBO_WINDOW;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      this.musou = Math.min(this.musouCfg.GAUGE_MAX, this.musou + (move.gain || 0));

      if (res.killed) {
        this.kills++;
        this.ki = Math.min(this.musouCfg.KI_MAX, this.ki + this.musouCfg.GAIN_ON_KILL);
      }
      this.events.push({ type: 'damage', move, target: t, result: res, combo: this.combo });
    }

    // 命中顿帧：命中了才冻，没命中不冻（空挥不该有顿感）。顿帧长度由**招式自带**。
    if (found.length) {
      const hs = move.stop ?? (move.id === 'CHARGED' ? this.cfg.HITSTOP_CHARGED : this.cfg.HITSTOP);
      this.hitstop = Math.max(this.hitstop, hs);
    }
    this.events.push({ type: 'hit', move, index: ev.index, of: ev.of, targets: found.length });
  }

  /**
   * 把全部池子里活着的目标填进复用数组。
   * 为什么用复用数组而不是每次 `flatMap`：一次挥击最多 6 段判定，160 个敌人时
   * 每段都会新建一个 160+ 元素的数组 —— 大招一放就是每秒上千次分配，白给 GC 上压力。
   */
  _collectTargets() {
    const out = this._targets;
    out.length = 0;
    for (const p of this.pools) {
      const alive = p.alive;
      for (let i = 0; i < alive.length; i++) out.push(alive[i]);
    }
    return out;
  }

  /** 这个目标属于哪个池（靠实体上的反向引用 O(1) 拿到；手搓的测试目标回落到第一个池） */
  _poolOf(t) {
    return t.pool ?? this.pools[0] ?? null;
  }

  /**
   * 移动接管：
   *   攻击中 → 锁 WASD + 按 advance 曲线硬推位移
   *   蓄力中 → 不锁 WASD，但速度 = 走速 × HEAVY.WALK_SCALE
   *   其它   → 交还控制权
   */
  _applyMotion(step, cameraYaw) {
    const st = this.chain;
    if (st.charging) {
      // 蓄力允许慢走：方向仍然由玩家按（这里复算一遍 WASD 方向），速度压到 55%
      this.player.setMotionOverride(this._inputDir(cameraYaw), PLAYER.WALK_SPEED * this.cfg.HEAVY.WALK_SCALE);
      return;
    }
    if (!st.busy) {
      this.player.clearMotionOverride();
      return;
    }
    // 攻击中：锁定 WASD
    this.player.setMotionOverride(null, 0);

    const move = st.move;
    const total = moveTotal(move);
    const window = Math.max(1e-4, total * this.cfg.LUNGE_END);
    const left = Math.max(0, (move.advance || 0) - this.lunged);
    if (left > 1e-6 && st.t <= window) {
      const perSec = (move.advance || 0) / window;
      const f = facingDir(this.swingFacing);
      let want = Math.min(left, perSec * step);
      want = this._clampLunge(want, f); // ★ 不许冲进敌人身体里
      if (want > 1e-9) {
        this.player.pushDisplacement(f.x * want, f.z * want);
        this.lunged += want;
      }
    }
  }

  /**
   * 把这一帧的前冲位移钳到"贴住正前方最近的敌人为止"。
   * ---------------------------------------------------------------------------
   * 为什么必须有：轻攻击每段前冲 1.0~1.6m，而目标的击退只有 0.9~2.2 m/s。
   * 不加钳制时玩家的前进速度（约 2.75 m/s）远大于目标退开的速度 ——
   * 结果是**一路穿过整个敌群**，后面的连段全部砍在自己背后（实测：连点 5 下只中 1 下）。
   * 钳到间距 LUNGE_MIN_GAP 之后，行为变成"冲上去贴着打"，这也正是无双的手感。
   *
   * ⚠ 它扫的是**全部池子**：只有扫到敌人，这条钳制才有意义（练武场的靶子本来就不会动）。
   *
   * @param want 本帧想走的距离（米，沿 f 方向）
   * @param f    前向单位向量
   */
  _clampLunge(want, f) {
    if (!this.pools.length || want <= 0) return want;
    const gap = this.cfg.LUNGE_MIN_GAP ?? 0;
    const px = this.player.position.x;
    const pz = this.player.position.z;
    let limit = want;
    for (const t of this._collectTargets()) {
      const dx = t.x - px;
      const dz = t.z - pz;
      const along = dx * f.x + dz * f.z; // 沿前冲方向的投影（负数 = 在身后）
      if (along <= 0) continue;
      const lateral = Math.abs(dx * f.z - dz * f.x); // 横向偏离
      const reach = (t.radius ?? 0.55) + (this.playerRadius ?? 0.45) + 0.15;
      if (lateral > reach) continue; // 不在前冲这条线上，不挡路
      limit = Math.min(limit, Math.max(0, along - gap));
    }
    return limit;
  }

  _inputDir(cameraYaw) {
    const fwd = this.input.axis('back', 'forward');
    const side = this.input.axis('left', 'right');
    if (!fwd && !side) return null;
    const f = { x: -Math.sin(cameraYaw), z: -Math.cos(cameraYaw) };
    const r = { x: Math.cos(cameraYaw), z: -Math.sin(cameraYaw) };
    const x = f.x * fwd + r.x * side;
    const z = f.z * fwd + r.z * side;
    const len = Math.hypot(x, z);
    return len > 1e-6 ? { x: x / len, z: z / len } : null;
  }

  // ─────────────────────────────────────────── 模块 5：无双槽 / 武艺
  _playerPos() {
    return { x: this.player.position.x, z: this.player.position.z };
  }

  _updateSpecial(step, cameraYaw) {
    const M = this.musouCfg;
    const R = M.RANBU;
    // 斗气自动恢复（★SPEC 每秒 1.2）
    if (this.kiRegen > 0) this.ki = Math.min(M.KI_MAX, this.ki + this.kiRegen * step);

    // 武艺冷却递减
    for (const id of ['art1', 'art2']) {
      const a = this.arts[id];
      if (a && a.cd > 0) a.cd = Math.max(0, a.cd - step);
    }

    // 无双乱舞进行中：持续 AOE + 维持无敌
    if (this.ranbuTimer > 0) {
      this.ranbuTimer = Math.max(0, this.ranbuTimer - step);
      this.ranbuTickAcc += step;
      if (R.INVINCIBLE) this.player.grantInvincible(0.25); // 覆盖 invincibleTimer 的递减
      if (this.ranbuTickAcc >= R.TICK) {
        this.ranbuTickAcc -= R.TICK;
        const hit = this._aoe(this._playerPos(), 0, 'ring', {
          id: 'musou', radius: R.RADIUS, arcDeg: 360, offset: 0,
          DAMAGE: R.DAMAGE, STUN: R.STUN, KNOCKBACK: R.KNOCKBACK,
        });
        this.events.push({ type: 'musou-tick', hits: hit, radius: R.RADIUS });
      }
    }

    // 触发：R 释放无双乱舞（需满槽、未在释放中）
    if (this.input.consumeActionPress('musou') && this.ranbuTimer <= 0 && this.musou >= M.GAUGE_MAX) {
      this.ranbuTimer = R.DURATION;
      this.ranbuTickAcc = R.TICK; // 立刻结算第一跳
      this.musou = 0;
      if (R.INVINCIBLE) this.player.grantInvincible(R.DURATION);
      const hit = this._aoe(this._playerPos(), 0, 'ring', {
        id: 'musou', radius: R.RADIUS, arcDeg: 360, offset: 0,
        DAMAGE: R.DAMAGE, STUN: R.STUN, KNOCKBACK: R.KNOCKBACK,
      });
      this.events.push({ type: 'musou-release', hits: hit, radius: R.RADIUS, duration: R.DURATION });
    }

    // 触发：1 / 2 武艺
    this._tryArt('art1', 'art1', cameraYaw);
    this._tryArt('art2', 'art2', cameraYaw);
  }

  _tryArt(action, id, cameraYaw) {
    const cfg = ARTS[id];
    const a = this.arts[id];
    if (!cfg || !a) return;
    if (!this.input.consumeActionPress(action)) return;
    if (a.cd > 0) return; // 冷却中
    if (this.ki < cfg.KI_COST) return; // 斗气不足
    this.ki -= cfg.KI_COST;
    a.cd = cfg.COOLDOWN;
    // 扇形技能朝镜头方向，环形技能无需朝向
    const facing = cfg.shape === 'cone' ? cameraYaw : 0;
    const hit = this._aoe(this._playerPos(), facing, cfg.shape, cfg);
    this.events.push({ type: 'art', id, name: cfg.name, hits: hit, cost: cfg.KI_COST });
  }

  /**
   * 范围伤害（无双乱舞 / 武艺共用）。
   * @param shape 'cone'（前方扇形，按 arcDeg 判张角）或 'ring'（周身环形，只看距离）
   * @param cfg 含 radius / arcDeg / offset / DAMAGE / STUN / KNOCKBACK / id
   * @returns 命中数量
   */
  _aoe(origin, facing, shape, cfg, maxHits = 999) {
    const arcDeg = shape === 'ring' ? 360 : cfg.arcDeg ?? 360;
    const seen = new Set();
    let n = 0;
    for (const t of this._collectTargets()) {
      if (n >= maxHits) break;
      if (!t.alive) continue;
      if (seen.has(t.id)) continue;
      const dx = t.x - origin.x;
      const dz = t.z - origin.z;
      const d = Math.hypot(dx, dz);
      if (d > cfg.radius + (t.radius ?? 0.5)) continue;
      // 扇形还要判张角（环形跳过）
      if (arcDeg < 360 - 1e-6 && d > 1e-6) {
        const f = facingDir(facing);
        const cos = (dx * f.x + dz * f.z) / d;
        if (Math.acos(Math.max(-1, Math.min(1, cos))) > (arcDeg * DEG) / 2) continue;
      }
      seen.add(t.id);
      const move = {
        id: cfg.id, damage: cfg.DAMAGE, stun: cfg.STUN,
        knockback: cfg.KNOCKBACK, height: 1.1,
      };
      const res = applyDamage(t, move, origin);
      const p = this._poolOf(t);
      if (p) {
        p.push(t, res.knock, move.knockback);
        p.noteHit(t, res, this.time, move);
      }
      this.hits++;
      this.damageDealt += res.damage;
      this.lastDamage = res.damage;
      this.lastHitAt = this.time;
      // AOE 击杀给斗气（与轻/重击给无双槽不同：避免无双乱舞自我充能）
      if (res.killed) {
        this.kills++;
        this.ki = Math.min(this.musouCfg.KI_MAX, this.ki + this.musouCfg.GAIN_ON_KILL);
      }
      n++;
      this.events.push({ type: 'damage', move, target: t, result: res, aoe: true, source: cfg.id });
    }
    return n;
  }

  snapshot() {
    const c = this.chain.snapshot();
    return {
      phase: c.phase,
      id: c.id,
      name: c.name,
      // 本轮已打出的轻击段数。HUD 用它显示"还差几下能接 C 技"，探针用它验证派生。
      lights: c.lights,
      progress: c.progress,
      chargeRatio: c.chargeRatio,
      canChain: c.canChain,
      swings: c.step,
      combo: this.combo,
      maxCombo: this.maxCombo,
      comboTimer: this.comboTimer,
      hits: this.hits,
      kills: this.kills,
      damage: this.damageDealt,
      lastDamage: this.lastDamage,
      musou: this.musou,
      musouRatio: this.musouRatio,
      ki: this.ki,
      kiRatio: this.kiRatio,
      musouReady: this.musou >= this.musouCfg.GAUGE_MAX,
      ranbuActive: this.ranbuTimer > 0,
      ranbuRatio: this.ranbuTimer > 0 && this.musouCfg.RANBU ? this.ranbuTimer / this.musouCfg.RANBU.DURATION : 0,
      art1: {
        cd: this.arts.art1.cd,
        cdRatio: this.arts.art1.cd / ARTS.art1.COOLDOWN,
        ready: this.arts.art1.cd <= 0 && this.ki >= ARTS.art1.KI_COST,
        kiCost: ARTS.art1.KI_COST,
      },
      art2: {
        cd: this.arts.art2.cd,
        cdRatio: this.arts.art2.cd / ARTS.art2.COOLDOWN,
        ready: this.arts.art2.cd <= 0 && this.ki >= ARTS.art2.KI_COST,
        kiCost: ARTS.art2.KI_COST,
      },
      hitstop: this.hitstop,
      busy: this.busy,
      // 探针用它确认"两个池都挂上了"，而不是只挂了一个导致另一半打不动
      pools: this.pools.length,
      targets: this._targets.length,
    };
  }
}
