/**
 * 玩家实体：移动、姿态、体力、负重、交互（搜索 / 撤离 / 治疗）、武器操作
 */

import {
  PLAYER, MATCH, ITEMS, WEAPONS, ARMORS, COMBAT, ROPE, VEHICLE, VIEW3D,
} from './config.js';
import { moveWithCollision, hasLineOfSight, elevationAt, isSolidAt } from './mapgen.js';
import {
  createInventory, createItem, autoPlace, totalWeight, totalValue,
  countById, consumeById, weightSpeedMultiplier, weightStaminaMultiplier,
  isOverweight, weightLimitFor, findItems,
} from './inventory.js';
import { createWeaponState, updateWeapon, startReload, fireWeapon } from './combat.js';

/**
 * 玩家类。
 */
export class Player {
  /**
   * @param {object} opts 配置项 { x, y, armorDef, weaponDefs, items }
   */
  constructor(opts = {}) {
    this.isPlayer = true;
    this.faction = 'player';
    this.id = 'player';
    this.x = opts.x || 0;
    this.y = opts.y || 0;
    this.angle = 0;
    this.yaw = 0; // 第一人称水平朝向（与 angle 同步）
    this.pitch = 0; // 俯仰（正为上）
    this.ads = false; // 是否正在瞄准（由输入层设置）
    this.radius = PLAYER.radius;

    this.maxHp = PLAYER.maxHp;
    this.hp = PLAYER.maxHp;
    this.armorDef = opts.armorDef || ARMORS.none;
    this.armor = this.armorDef.armor;
    this.maxArmor = this.armorDef.armor;
    this.stamina = PLAYER.maxStamina;
    this.maxStamina = PLAYER.maxStamina;
    this.staminaCooldown = 0;
    this.exhausted = false; // 体力耗尽后的疲惫状态（锁冲刺 + 移速下降）

    this.inventory = createInventory(PLAYER.backpack.cols, PLAYER.backpack.rows);
    const defs = Array.isArray(opts.weaponDefs) && opts.weaponDefs.length
      ? opts.weaponDefs
      : [WEAPONS.pistol];
    this.weapons = defs.map((d) => createWeaponState(d));
    this.weaponIndex = 0;

    if (Array.isArray(opts.items)) {
      for (const item of opts.items) {
        if (item) autoPlace(this.inventory, item);
      }
    }

    this.dead = false;
    this.crouching = false;
    this.sprinting = false;
    this.moving = false;
    this.moveSpeed = 0;
    this.walkPhase = 0;
    this.recoilOffset = 0;
    this.muzzleFlash = 0;
    this.hurtFlash = 0;
    this.fireLocked = false;
    this.noiseTimer = 0;
    this.recoilPitch = 0; // 开火抬枪（视角上抬），仅视觉，自动回落

    this.search = null; // { container, progress, total }
    this.extract = null; // { point, progress }
    this.heal = null; // { uid, progress, total, def }
    this.hack = null; // { terminal, progress, total }

    // --- 绳索速降 ---
    this.ropelling = false;
    this.rope = null; // { ax, ay, bx, by, t, dur, fromElev }
    this.ropeCd = 0; // 落地冷却

    // --- 载具 ---
    this.vehicle = null; // 正在驾驶的载具（null = 步行）
    this.vehicleCd = 0; // 上下车冷却

    this.kills = 0;
    this.searchedCount = 0;
    this.shotsFired = 0;
    this.hits = 0;
    this.damageTaken = 0;
  }

  /** 当前武器状态 */
  get currentWeapon() {
    return this.weapons[this.weaponIndex] || null;
  }

  /** 背包 + 护甲 + 武器的总重量（kg） */
  get weight() {
    let w = totalWeight(this.inventory) + (this.armorDef.weight || 0);
    for (const weapon of this.weapons) w += weapon.def.weight || 0;
    return Math.round(w * 10) / 10;
  }

  /** 当前负重上限（kg）= 基础 20 + 护甲加成 */
  get weightLimit() {
    return weightLimitFor(this.armorDef.id);
  }

  /** 是否硬性超重（超重即禁跑，见 update） */
  get overweight() {
    return isOverweight(this.weight, this.weightLimit);
  }

  /** 随身物资估值 */
  get carriedValue() {
    return totalValue(this.inventory);
  }

  /** 是否正在读条（搜索 / 撤离 / 治疗） */
  get busy() {
    return Boolean(this.search || this.extract || this.heal);
  }

  /**
   * 查询备用弹药数量。
   * @param {string} itemId 弹药物品 id
   * @returns {number} 数量
   */
  reserveAmmo(itemId) {
    return countById(this.inventory, itemId);
  }

  /**
   * 消耗备用弹药。
   * @param {string} itemId 弹药物品 id
   * @param {number} amount 数量
   * @returns {number} 实际消耗
   */
  consumeReserve(itemId, amount) {
    return consumeById(this.inventory, itemId, amount);
  }

  /* ============================ 绳索速降 ============================ */

  /**
   * 当前能否抛绳速降：必须站在架高平台上、冷却结束、体力够，
   * 且朝向方向的落点是**可站立的低位地面**（不能穿墙、不能落在箱子里）。
   * @param {object} world 战局上下文
   * @returns {?object} 可用时返回落点 {x, y}，否则 null
   */
  ropeLanding(world) {
    if (!ROPE.enabled || this.dead || this.busy || this.ropelling) return null;
    if (this.ropeCd > 0) return null;
    const fromElev = elevationAt(world.map, this.x, this.y);
    if (fromElev <= 0.5) return null; // 不在高地上
    if (this.stamina < ROPE.staminaCost) return null;

    const reach = ROPE.reach * VIEW3D.metersToUnits; // 米 → 逻辑单位
    const dirX = Math.cos(this.angle);
    const dirY = Math.sin(this.angle);
    // 从最远处往回找第一个可落脚点，尽量滑得远一点
    for (let d = reach; d >= reach * 0.4; d -= 20) {
      const lx = this.x + dirX * d;
      const ly = this.y + dirY * d;
      if (lx < 0 || ly < 0 || lx >= world.map.width || ly >= world.map.height) continue;
      if (isSolidAt(world.map, lx, ly)) continue;
      if (elevationAt(world.map, lx, ly) > fromElev - ROPE.minDrop) continue; // 没降下去
      // 沿途不能被墙挡住（绳子得是直的）
      if (!hasLineOfSight(world.map, this.x, this.y, lx, ly, { seeOverCover: true })) continue;
      return { x: lx, y: ly };
    }
    return null;
  }

  /**
   * 抛绳开始速降。
   * @param {object} world 战局上下文
   * @returns {boolean} 是否成功触发
   */
  startRope(world) {
    const land = this.ropeLanding(world);
    if (!land) return false;
    this.interrupt('rope');
    this.ropelling = true;
    this.rope = {
      ax: this.x,
      ay: this.y,
      bx: land.x,
      by: land.y,
      t: 0,
      dur: ROPE.duration,
      fromElev: elevationAt(world.map, this.x, this.y),
    };
    this.stamina = Math.max(0, this.stamina - ROPE.staminaCost);
    this.staminaCooldown = PLAYER.staminaRegenDelay;
    if (world.audio && world.audio.rope) world.audio.rope();
    return true;
  }

  /**
   * 速降过程的每帧推进：沿绳滑向落点，视点从平台高度平滑降到地面。
   * @param {number} dt 帧间隔秒
   * @param {object} world 战局上下文
   * @returns {void}
   */
  updateRope(dt, world) {
    const r = this.rope;
    if (!r) {
      this.ropelling = false;
      return;
    }
    r.t += dt;
    const k = Math.min(1, r.t / r.dur);
    // 缓动：起步稍慢、落地最快（下落感）
    const e = k * k * (3 - 2 * k);
    this.x = r.ax + (r.bx - r.ax) * e;
    this.y = r.ay + (r.by - r.ay) * e;
    this.elevation = r.fromElev * (1 - e);
    this.walkPhase += dt * 4;

    if (k >= 1) {
      this.ropelling = false;
      this.rope = null;
      this.ropeCd = ROPE.cooldown;
      this.elevation = 0;
      // 落地动静比走路大，是个会被听见的战术动作
      world.emitNoise(this.x, this.y, PLAYER.noiseWalk * ROPE.landNoise, 'player');
      if (world.audio && world.audio.ropeLand) world.audio.ropeLand();
    }
  }

  /* ============================== 载具 ============================== */

  /**
   * 附近可上车的载具（无人驾驶、在交互距离内、自身状态允许）。
   * @param {object} world 战局上下文
   * @returns {?object} 载具，没有则 null
   */
  nearestVehicle(world) {
    if (!VEHICLE.enabled || this.dead || this.busy || this.ropelling || this.vehicle) return null;
    if (this.vehicleCd > 0) return null;
    let best = null;
    let bd = VEHICLE.enterRange;
    for (const v of (world.map.vehicles || [])) {
      if (v.driver) continue;
      const d = Math.hypot(v.x - this.x, v.y - this.y);
      if (d < bd) {
        bd = d;
        best = v;
      }
    }
    return best;
  }

  /**
   * 上车。
   * @param {object} world 战局上下文
   * @returns {boolean} 是否成功
   */
  enterVehicle(world) {
    const v = this.nearestVehicle(world);
    if (!v) return false;
    this.interrupt('vehicle');
    v.driver = 'player';
    v.speed = 0;
    this.vehicle = v;
    if (world.audio && world.audio.vehicleEnter) world.audio.vehicleEnter();
    return true;
  }

  /**
   * 下车（会留在车旁，并进入短暂冷却，防止瞬间上下车刷点）。
   * @param {object} world 战局上下文
   * @returns {boolean} 是否成功
   */
  exitVehicle(world) {
    const v = this.vehicle;
    if (!v) return false;
    v.driver = null;
    v.speed = 0;
    this.vehicle = null;
    this.vehicleCd = VEHICLE.exitCooldown;
    if (world.audio && world.audio.vehicleExit) world.audio.vehicleExit();
    return true;
  }

  /**
   * 驾驶每帧推进：油门 / 刹车 / 转向，玩家位置跟随载具。
   * 视角 yaw 由车头朝向接管（并把 yaw 写回 input，避免下车瞬间视角跳变）。
   * @param {number} dt 帧间隔秒
   * @param {object} input 输入状态
   * @param {object} world 战局上下文
   * @returns {void}
   */
  updateDrive(dt, input, world) {
    const v = this.vehicle;
    if (!v) return;
    const fwd = (input && input.up ? 1 : 0) - (input && input.down ? 1 : 0);
    const steer = (input && input.right ? 1 : 0) - (input && input.left ? 1 : 0);

    // 转向：速度越高越迟钝；倒车时方向反过来（与真实驾驶一致）
    const ratio = Math.min(1, Math.abs(v.speed) / VEHICLE.maxSpeed);
    if (steer !== 0 && Math.abs(v.speed) > 10) {
      const rate = VEHICLE.turnRate * (1 - 0.45 * ratio) * (v.speed < 0 ? -1 : 1);
      v.angle += steer * rate * dt;
    }

    // 油门 / 刹车 / 自然减速
    if (fwd > 0) v.speed += VEHICLE.accel * dt;
    else if (fwd < 0) v.speed -= VEHICLE.brake * dt;
    else {
      const d = VEHICLE.drag * dt;
      if (Math.abs(v.speed) <= d) v.speed = 0;
      else v.speed -= Math.sign(v.speed) * d;
    }
    v.speed = Math.max(-VEHICLE.maxSpeed * VEHICLE.reverseMul, Math.min(VEHICLE.maxSpeed, v.speed));

    // 移动：直接吃地图碰撞；撞墙只掉速不反弹
    const dx = Math.cos(v.angle) * v.speed * dt;
    const dy = Math.sin(v.angle) * v.speed * dt;
    const next = moveWithCollision(world.map, v.x, v.y, dx, dy, VEHICLE.radius);
    const want = Math.hypot(dx, dy);
    const got = Math.hypot(next.x - v.x, next.y - v.y);
    if (want > 0.01 && got < want * 0.6) v.speed *= 0.25;
    v.x = next.x;
    v.y = next.y;

    this.x = v.x;
    this.y = v.y;
    this.angle = v.angle;
    this.yaw = v.angle;
    this.elevation = elevationAt(world.map, v.x, v.y); // 开上平台时视点同步抬高
    if (input && input.yaw !== undefined) input.yaw = v.angle; // 保持与视角一致，下车不跳变
    this.moving = Math.abs(v.speed) > 1;

    // 行驶噪音：远大于脚步，是个"快但招摇"的选择
    this._vehNoiseTimer = (this._vehNoiseTimer || 0) - dt;
    if (this._vehNoiseTimer <= 0 && Math.abs(v.speed) > 30) {
      this._vehNoiseTimer = 0.35;
      const r = VEHICLE.noiseRadius * (0.45 + 0.55 * Math.min(1, Math.abs(v.speed) / VEHICLE.maxSpeed));
      world.emitNoise(v.x, v.y, r, 'vehicle');
      if (world.audio && world.audio.engine) {
        world.audio.engine(Math.min(1, Math.abs(v.speed) / VEHICLE.maxSpeed));
      }
    }
  }

  /**
   * 每帧更新。
   * @param {number} dt 帧间隔秒
   * @param {object} input 输入状态
   * @param {object} world 战局上下文
   * @returns {void}
   */
  update(dt, input, world) {
    if (this.dead) return;
    // 绳索速降期间接管移动：不能开火 / 交互，沿绳滑到落点
    if (this.ropeCd > 0) this.ropeCd = Math.max(0, this.ropeCd - dt);
    if (this.ropelling) {
      this.updateRope(dt, world);
      return;
    }
    if (this.vehicleCd > 0) this.vehicleCd = Math.max(0, this.vehicleCd - dt);
    if (this.vehicle) {
      this.updateDrive(dt, input, world);
      return;
    }
    this.hurtFlash = Math.max(0, this.hurtFlash - dt);
    this.muzzleFlash = Math.max(0, this.muzzleFlash - dt);
    this.recoilOffset *= Math.max(0, 1 - dt * 7);
    // 抬枪回落：开火后视角自动回到原俯仰（不惩罚玩家，避免必须手动压枪）
    this.recoilPitch = Math.max(0, (this.recoilPitch || 0) * Math.max(0, 1 - dt * COMBAT.recoilRecover));
    updateWeapon(dt, this, world);

    // ---- 朝向 ----
    // 第一人称：优先用视角 yaw（由指针锁定累加）；否则回退到鼠标瞄准（兼容单元测试 / 旧逻辑）。
    // 该 angle 同时驱动开火射线（combat.js 用 shooter.angle）与 3D 相机朝向，保证逻辑一致。
    if (input && input.yaw !== undefined) {
      this.yaw = input.yaw;
      this.angle = input.yaw;
      if (input.pitch !== undefined) this.pitch = input.pitch;
    } else {
      const aim = (input && input.aim) || { x: this.x + 1, y: this.y };
      this.angle = Math.atan2(aim.y - this.y, aim.x - this.x);
    }
    this.ads = Boolean(input && input.ads);

    // ---- 姿态 ----
    this.crouching = Boolean(input && input.crouch);

    // ---- 移动向量 ----
    // 存在 yaw（第一人称视角）时相对朝向移动：W=前、S=后、A=左、D=右；
    // 否则沿用世界轴向（与旧 2D 版完全一致，保证既有逻辑与单元测试不变）。
    const iRight = (input && input.right) ? 1 : 0;
    const iLeft = (input && input.left) ? 1 : 0;
    const iUp = (input && input.up) ? 1 : 0;
    const iDown = (input && input.down) ? 1 : 0;
    let mx;
    let my;
    if (input && input.yaw !== undefined) {
      const forward = iUp - iDown;
      const strafe = iRight - iLeft;
      const fx = Math.cos(this.angle);
      const fy = Math.sin(this.angle);
      const rx = -Math.sin(this.angle);
      const ry = Math.cos(this.angle);
      mx = fx * forward + rx * strafe;
      my = fy * forward + ry * strafe;
    } else {
      mx = iRight - iLeft;
      my = iDown - iUp;
    }
    const mag = Math.hypot(mx, my);
    this.moving = mag > 0.01;
    if (this.moving) {
      mx /= mag;
      my /= mag;
    }

    // 读条中被移动打断
    if (this.busy && this.moving) this.interrupt('move');

    // 硬性超重：禁止奔跑（不是"惩罚"，是拿不到奔跑这个选项）。
    // 与超重减速同时生效 —— 负重直接砍掉逃命的手段，而不是让逃命变慢一点。
    const overweight = isOverweight(this.weight, this.weightLimit);
    const wantSprint = Boolean(input.sprint) && !this.crouching && !this.busy
      && !this.exhausted && !overweight;
    // 注意：冲刺可一直消耗到体力为 0（不再用 >1 的门槛提前截断），
    // 体力归零时进入 exhausted 锁定冲刺，直至恢复到 staminaExhaustRecovery 阈值才解除。
    this.sprinting = wantSprint && this.moving;

    // ---- 体力 ----
    if (this.sprinting) {
      this.stamina = Math.max(0, this.stamina - PLAYER.staminaSprintDrain * dt);
      this.staminaCooldown = PLAYER.staminaRegenDelay;
      if (this.stamina <= 0) this.exhausted = true;
    } else {
      this.staminaCooldown = Math.max(0, this.staminaCooldown - dt);
      if (this.staminaCooldown <= 0) {
        const regenMul = weightStaminaMultiplier(
          this.weight, this.weightLimit, PLAYER.weightOverStaminaFloor,
        );
        this.stamina = Math.min(this.maxStamina, this.stamina + PLAYER.staminaRegen * regenMul * dt);
      }
    }
    // 疲惫解除：体力回升到阈值以上才恢复（迟滞，避免在临界点反复抖动）
    if (this.exhausted && this.stamina >= this.maxStamina * PLAYER.staminaExhaustRecovery) {
      this.exhausted = false;
    }

    // ---- 移动 ----
    const weightMul = weightSpeedMultiplier(
      this.weight, this.weightLimit, PLAYER.weightOverSpeedFloor,
    );
    let speed = PLAYER.speed * weightMul;
    if (this.crouching) speed *= PLAYER.crouchMul;
    else if (this.sprinting) speed *= PLAYER.sprintMul;
    if (this.exhausted) speed *= PLAYER.staminaExhaustSpeedMul;
    if (this.busy) speed = 0;
    this.moveSpeed = this.moving ? speed : 0;

    if (this.moving && speed > 0) {
      const next = moveWithCollision(
        world.map, this.x, this.y, mx * speed * dt, my * speed * dt, this.radius,
      );
      this.x = next.x;
      this.y = next.y;
      this.walkPhase += dt * (speed / PLAYER.speed) * 9;
    }
    // 高程：站在架高平台上时抬高视点（供相机高度与「越过掩体」的视线判定使用）。
    // 用指数插值平滑过渡，走上 / 走下平台时不会瞬移。
    const targetElev = elevationAt(world.map, this.x, this.y);
    const curElev = this.elevation || 0;
    this.elevation = curElev + (targetElev - curElev) * (1 - Math.exp(-12 * dt));

    // ---- 噪音 ----
    let noise = 0;
    if (this.moving) {
      noise = this.crouching ? PLAYER.noiseCrouch : (this.sprinting ? PLAYER.noiseSprint : PLAYER.noiseWalk);
    }
    this.noiseTimer -= dt;
    if (noise > 0 && this.noiseTimer <= 0) {
      this.noiseTimer = 0.22;
      world.emitNoise(this.x, this.y, noise, 'player');
      // 脚步声：与噪音同步，蹲行几乎无声、冲刺最响
      if (world.audio && world.audio.step) {
        world.audio.step((noise / PLAYER.noiseSprint) * 0.2);
      }
    }

    // ---- 开火 ----
    const weapon = this.currentWeapon;
    if (weapon && !this.busy) {
      // 自动换弹：弹匣打空且身上有备用弹药时立即起换，不必等玩家再按一次。
      // 桌面端同样生效（纯逻辑层，手机/电脑行为一致）。
      if (weapon.ammo <= 0 && !weapon.reloading) {
        startReload(this, world);
      }
      const wantFire = weapon.def.auto ? Boolean(input.fire) : Boolean(input.firePressed);
      if (wantFire) this.fire(world);
    }

    // ---- 读条推进 ----
    if (this.search) {
      this.search.progress += dt;
      if (this.search.progress >= this.search.total) {
        const container = this.search.container;
        this.search = null;
        world.onSearchComplete(container);
      }
    }
    if (this.extract) {
      this.extract.progress += dt;
      if (this.extract.progress >= MATCH.extractChannel) {
        const point = this.extract.point;
        this.extract = null;
        world.onExtract(point);
      }
    }
    if (this.heal) {
      this.heal.progress += dt;
      if (this.heal.progress >= this.heal.total) {
        const done = this.heal;
        this.heal = null;
        this.hp = Math.min(this.maxHp, this.hp + (done.def.heal || 0));
        if (done.def.stamina) this.stamina = Math.min(this.maxStamina, this.stamina + done.def.stamina);
        consumeById(this.inventory, done.def.id, 1);
        if (world.audio) world.audio.heal();
        if (world.toast) world.toast(`已使用 ${done.def.name}`);
      }
    }
    if (this.hack) {
      this.hack.progress += dt;
      if (this.hack.progress >= this.hack.total) {
        const terminal = this.hack.terminal;
        this.hack = null;
        if (world.onTerminalComplete) world.onTerminalComplete(terminal);
      }
    }
  }

  /**
   * 开火一发。
   * @param {object} world 战局上下文
   * @returns {void}
   */
  fire(world) {
    const result = fireWeapon(world, this, {});
    if (result.fired) {
      this.shotsFired += 1;
      if (result.entity) {
        this.hits += 1;
        world.hitMarker = 0.18;
      }
    }
  }

  /**
   * 切换武器。
   * @param {number} index 武器下标
   * @param {object} world 战局上下文
   * @returns {boolean} 是否切换成功
   */
  switchWeapon(index, world) {
    if (index < 0 || index >= this.weapons.length || index === this.weaponIndex) return false;
    const current = this.currentWeapon;
    if (current) {
      current.reloading = false;
      current.reloadTimer = 0;
      current.reloadAmount = 0;
    }
    this.weaponIndex = index;
    this.recoilOffset = 0;
    if (world && world.audio) world.audio.ui(0.5);
    return true;
  }

  /** 换弹 */
  reload(world) {
    if (this.busy) return false;
    return startReload(this, world);
  }

  /**
   * 使用背包中的第一个可用消耗品。
   * @param {object} world 战局上下文
   * @returns {boolean} 是否开始使用
   */
  useMedkit(world) {
    if (this.busy) {
      this.interrupt('cancel');
      return false;
    }
    if (this.hp >= this.maxHp && this.stamina >= this.maxStamina * 0.95) {
      if (world.toast) world.toast('状态良好，无需治疗');
      return false;
    }
    const items = findItems(this.inventory, (it) => it.category === 'consumable' && it.qty > 0);
    if (!items.length) {
      if (world.toast) world.toast('没有可用的医疗物资');
      return false;
    }
    // 优先选择不会溢出的：血少时优先医疗包，血多时优先止痛药
    items.sort((a, b) => {
      const needA = Math.abs((a.heal || 0) - (this.maxHp - this.hp));
      const needB = Math.abs((b.heal || 0) - (this.maxHp - this.hp));
      return needA - needB;
    });
    const item = items[0];
    this.heal = { uid: item.uid, progress: 0, total: item.useTime || 1.5, def: ITEMS[item.id] || item };
    if (world.audio) world.audio.ui(0.4);
    return true;
  }

  /**
   * E 键交互：搜索容器 / 撤离 / 重新打开已搜容器的剩余物资。
   * @param {object} world 战局上下文
   * @returns {boolean} 是否触发了交互
   */
  interact(world) {
    if (this.dead) return false;
    if (this.busy) {
      this.interrupt('cancel');
      return false;
    }
    const terminal = this.nearestTerminal(world);
    if (terminal) {
      this.hack = { terminal, progress: 0, total: MATCH.terminalHackTime };
      if (world.toast) world.toast(`开始破解数据终端 — ${MATCH.terminalHackTime} 秒`);
      if (world.audio) world.audio.searchStart();
      return true;
    }
    const extract = this.nearestExtract(world);
    if (extract) {
      if (world.canAffordExtract && !world.canAffordExtract(extract)) return false;
      this.extract = { point: extract, progress: 0 };
      if (world.toast) world.toast(`开始撤离：${extract.name} — ${MATCH.extractChannel} 秒`);
      if (world.audio) world.audio.extractStart();
      return true;
    }
    // 地面掉落物：排在终端 / 撤离点之后、容器之前 —— 既能在撤离点正常读条，
    // 又不会被脚下的容器抢走"捡东西"的机会。
    const ground = this.nearestItem(world);
    if (ground) return this.pickUpGroundItem(world, ground);

    const container = this.nearestContainer(world);
    if (!container) {
      if (world.toast) world.toast('附近没有可交互目标');
      return false;
    }
    if (container.searched) {
      const remain = (container.loot || []).length;
      if (remain > 0) {
        world.openLootPanel(container);
        return true;
      }
      if (world.toast) world.toast('这个容器已经空了');
      return false;
    }
    this.search = { container, progress: 0, total: world.containerSearchTime(container) };
    if (world.audio) world.audio.searchStart();
    return true;
  }

  /**
   * 找到范围内可用的撤离点。
   * @param {object} world 战局上下文
   * @returns {object|null} 撤离点
   */
  nearestExtract(world) {
    let best = null;
    let bestDist = Infinity;
    for (const point of world.map.extracts) {
      if (!point.open) continue;
      const d = Math.hypot(point.x - this.x, point.y - this.y);
      if (d <= point.r && d < bestDist) {
        bestDist = d;
        best = point;
      }
    }
    return best;
  }

  /**
   * 找到范围内可见且未破解的数据终端。
   * @param {object} world 战局上下文
   * @returns {object|null} 终端
   */
  nearestTerminal(world) {
    let best = null;
    let bestDist = Infinity;
    for (const terminal of (world.map.terminals || [])) {
      if (terminal.hacked) continue;
      const d = Math.hypot(terminal.x - this.x, terminal.y - this.y);
      if (d <= terminal.r + PLAYER.radius && d < bestDist
        && hasLineOfSight(world.map, this.x, this.y, terminal.x, terminal.y)) {
        bestDist = d;
        best = terminal;
      }
    }
    return best;
  }

  /**
   * 找到范围内最近的可交互容器。
   * @param {object} world 战局上下文
   * @returns {object|null} 容器
   */
  nearestContainer(world) {    let best = null;
    let bestDist = MATCH.interactRange;
    for (const container of world.map.containers) {
      const d = Math.hypot(container.x - this.x, container.y - this.y);
      if (d <= bestDist && hasLineOfSight(world.map, this.x, this.y, container.x, container.y)) {
        bestDist = d;
        best = container;
      }
    }
    return best;
  }

  /**
   * 打断当前读条。
   * @param {string} reason 原因（move / damage / cancel）
   * @returns {void}
   */
  interrupt(reason) {
    if (this.search && reason === 'move') this.search = null;
    else if (this.search && reason === 'cancel') this.search = null;
    if (this.extract && (reason === 'move' || reason === 'cancel')) this.extract = null;
    if (this.heal && (reason === 'damage' || reason === 'cancel')) this.heal = null;
    if (this.hack && (reason === 'move' || reason === 'cancel' || reason === 'damage')) this.hack = null;
  }

  /**
   * 受到伤害时的钩子（由 combat.applyDamage 调用）。
   * @param {object} source 伤害来源
   * @param {object} world 战局上下文
   * @returns {void}
   */
  onDamaged(source, world) {
    this.damageTaken += 1;
    if (this.heal || this.extract) {
      this.interrupt('damage');
      if (world && world.toast) world.toast('读条被打断！');
    }
  }

  /**
   * 拾取一件战利品。
   * @param {object} item 物品实例
   * @returns {boolean} 是否成功
   */
  pickUp(item) {
    return Boolean(autoPlace(this.inventory, item));
  }

  /**
   * 丢弃一件物品（局内）。
   * @param {string} uid 物品 uid
   * @returns {object|null} 被丢弃的物品
   */
  /**
   * 附近可拾取的地面掉落物（取最近的一件）。
   * 范围比容器 / 终端更近（MATCH.itemPickupRange），避免站在撤离点上误拾刚丢的东西。
   * @param {object} world 战局上下文
   * @returns {?object} 掉落物 { uid, def, x, y }，没有则 null
   */
  nearestItem(world) {
    if (this.dead || this.busy) return null;
    const list = world.items;
    if (!list || !list.length) return null;
    let best = null;
    let bd = MATCH.itemPickupRange;
    for (const it of list) {
      if (it.taken) continue;
      const d = Math.hypot(it.x - this.x, it.y - this.y);
      if (d < bd) {
        bd = d;
        best = it;
      }
    }
    return best;
  }

  /**
   * 拾取一件地面掉落物：进背包、从世界移除，并给出提示与音效。
   * @param {object} world 战局上下文
   * @param {object} item 掉落物
   * @returns {boolean} 是否拾取成功（背包满则失败且物品留在地上）
   */
  pickUpGroundItem(world, item) {
    if (!item || item.taken) return false;
    if (!autoPlace(this.inventory, item)) {
      if (world.toast) world.toast(`背包空间不足：${item.name}`);
      if (world.audio) world.audio.error();
      return false;
    }
    item.taken = true;
    const idx = world.items.indexOf(item);
    if (idx >= 0) world.items.splice(idx, 1);
    if (world.toast) world.toast(`拾取 ${item.name}`);
    if (world.audio) world.audio.pickup();
    return true;
  }

  dropItem(uid) {
    const idx = this.inventory.items.findIndex((it) => it.uid === uid);
    if (idx < 0) return null;
    const [item] = this.inventory.items.splice(idx, 1);
    item.col = -1;
    item.row = -1;
    return item;
  }

  /**
   * 结算时导出随身物资。
   * @returns {Array<object>} 物品数组
   */
  exportItems() {
    return this.inventory.items.slice();
  }
}

/**
 * 根据装备配置构建带入战局的物品列表。
 * @param {object} loadout 装备配置
 * @returns {Array<object>} 物品实例数组
 */
export function buildLoadoutItems(loadout) {
  const items = [];
  const ammoBoxes = Math.max(0, loadout.ammo556Boxes || 0);
  for (let i = 0; i < ammoBoxes; i += 1) items.push(createItem(ITEMS.ammo556, ITEMS.ammo556.stack));
  const smgBoxes = Math.max(0, loadout.ammo9mmBoxes || 0);
  for (let i = 0; i < smgBoxes; i += 1) items.push(createItem(ITEMS.ammo9mm, ITEMS.ammo9mm.stack));
  for (let i = 0; i < Math.max(0, loadout.medkits || 0); i += 1) items.push(createItem(ITEMS.medkit, 1));
  for (let i = 0; i < Math.max(0, loadout.bandages || 0); i += 1) items.push(createItem(ITEMS.bandage, 1));
  return items;
}
