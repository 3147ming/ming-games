/**
 * 玩家实体：移动、姿态、体力、负重、交互（搜索 / 撤离 / 治疗）、武器操作
 */

import {
  PLAYER, MATCH, ITEMS, WEAPONS, ARMORS, BACKPACKS, COMBAT, ROPE, VEHICLE, VIEW3D, HUD, AMMO_IDS,
  JUMP, STANCE, CELL,
} from './config.js';
import { loadoutAmmoBoxes } from './ammo.js';
import {
  moveWithCollision, hasLineOfSight, elevationAt, isSolidAt, circleHitsSolid, cellAt, ceilingHeightAt,
} from './mapgen.js';
import {
  createInventory, createItem, autoPlace, totalWeight, totalValue,
  itemValue, countById, consumeById, weightSpeedMultiplier, weightStaminaMultiplier,
  isOverweight, weightLimitFor, findItems,
} from './inventory.js';
import { createWeaponState, updateWeapon, startReload, fireWeapon, meleeAttack } from './combat.js';
// P18/W3：战利品交互唯一真值（秒开判定 / 散落物聚合 / 多目标游标），零 three / 零 DOM
import {
  collectInteractables, cycleTarget, searchTimeFor, TARGET_KIND,
} from './loot-interact.js';
// P19：动作状态机与手感参数（冲刺抬枪 / 蹲伏收益 / 探头 / 切枪计时）
import {
  canReload, canSprint, canSwitchWeapon, canLean, deriveCombatState, sprintRaiseDelay,
  switchDuration,
} from './combatstate.js';
import {
  defaultConditions, applyInjury, bleedDps, fractureMaxHp,
  conditionSpeedMul, conditionSprintMul, itemUsable, pickMedical, medicalProfile,
} from './medical.js';
// P22：玩家压制衰减（纯逻辑，数值来自 COMBAT.playerSuppression）
import { decayPlayerSuppression } from './suppression.js';

/**
 * V-02：把 `world.lastDamage` 压成一个 HUD/音频共用的命中档位。
 *
 * 优先级：击杀 > 爆头 > 弹开 > 完全击穿 > 半穿 > 普通。
 * 只有「护甲/头盔真的吸收了伤害」才可能报击穿/半穿/弹开，
 * 打无甲目标或打腿一律回到 normal，避免把肉体命中误报成护甲反馈。
 * @param {object|null} info world.lastDamage
 * @param {boolean} dead 目标是否被这一发打死
 * @returns {'normal'|'armor'|'blocked'|'partial'|'penetrated'|'head'|'kill'}
 */
export function hitKindFor(info, dead) {
  if (dead) return 'kill';
  if (!info) return 'normal';
  if (info.zone === 'head') return 'head';
  const hitArmor = Boolean(info.armorAbsorbed || info.helmetAbsorbed);
  if (info.blocked && hitArmor) return 'blocked';
  // 「击穿」只认离散表给出的完全穿透；旧连续路径没有穿透比，不能凭减伤高低猜，
  // 否则低耐久护甲（mitigation < 0.5）会被误报成击穿。
  if (info.penetrationRatio != null && info.penetrated && hitArmor) return 'penetrated';
  if (info.partial && hitArmor) return 'partial';
  if (hitArmor) return 'armor';
  return 'normal';
}

/**
 * 玩家类。
 */
export class Player {
  /**
   * @param {object} opts 配置项 { x, y, armorDef, weaponDefs, items }
   */
  constructor(opts = {}) {
    // 局外改装后的玩家配置。默认直接用全局 PLAYER，保证既有无改装路径与旧测试零变化。
    // 不要在构造函数里改 PLAYER 本身：那是全局单例，会把本局强化泄漏到下一局。
    const cfg = opts.playerCfg || PLAYER;
    this.playerCfg = cfg;
    // 医疗物资定义也允许注入改装后的版本（恢复量 +25% 等）。
    this.itemCfg = opts.itemCfg || ITEMS;
    this.isPlayer = true;
    this.faction = 'player';
    this.id = 'player';
    this.x = opts.x || 0;
    this.y = opts.y || 0;
    this.angle = 0;
    this.yaw = 0; // 第一人称水平朝向（与 angle 同步）
    this.pitch = 0; // 俯仰（正为上）
    this.ads = false; // 是否正在瞄准（由输入层设置）
    this.adsT = 0; // 开镜过渡进度 0→1（P4：FOV/枪模/散布/准星共用这一个进度）
    // P22 玩家压制 0~1：敌方子弹擦过 / 命中时累加，逐帧衰减。
    // 只放大扩散 + 驱动 HUD 边缘血色，不改伤害也不给敌方坐标（见 suppression.js）。
    this.suppression = 0;
    // P19 动作状态机：冲刺后抬枪锁、探头偏移、切枪计时。三者都只影响手感，不改数值表。
    this.sprintLock = 0;
    this.wasSprinting = false;
    this.leanT = 0;
    this.leanInput = 0;
    this.switchTimer = 0;
    this.switchTotal = 0;
    this.switchPhase = 'equip';
    this.combatState = null;
    this.radius = PLAYER.radius;

    this.maxHpBase = typeof cfg.maxHp === 'number' ? cfg.maxHp : PLAYER.maxHp;
    this.maxHp = this.maxHpBase;
    this.hp = this.maxHp;
    this.armorDef = opts.armorDef || ARMORS.none;
    this.armor = this.armorDef.armor;
    this.maxArmor = this.armorDef.armor;
    this.armorLevel = this.armorDef.level || 0;
    // W2：背包只影响负重上限；缺省 'none' → 加成 0，旧路径逐位不变。
    this.backpackDef = opts.backpackDef || BACKPACKS.none;
    // W2：胸挂只决定局内胸挂容器尺寸（容器本身由 main 在 startRaid 里建）。
    // 这里存一份定义是为了结算时能把它回仓（见 main.endRaid 的 gear 清单）。
    this.rigDef = opts.rigDef || null;
    // W2 近战：匕首槽。没有装备时为 null，meleeAttack 直接返回 false（不报错、不占用按键反馈）。
    this.meleeDef = opts.meleeDef || null;
    this.meleeCd = 0; // 近战冷却（秒）
    this.meleeSwing = 0; // 挥击动作进度 1→0（渲染层读它做枪模前甩）
    // P7：头盔是独立耐久池，只覆盖爆头；无头盔时爆头倍率全额生效。
    this.helmetDef = opts.helmetDef || ARMORS.none;
    this.helmet = this.helmetDef.armor || 0;
    this.maxHelmet = this.helmetDef.armor || 0;
    this.helmetLevel = this.helmetDef.level || 0;
    // 医疗状态：流血 / 骨折。每局重置，不写存档。
    this.conditions = defaultConditions();
    this.bleedSfxCd = 0;
    this.maxStamina = typeof cfg.maxStamina === 'number' ? cfg.maxStamina : PLAYER.maxStamina;
    this.stamina = this.maxStamina;
    this.staminaCooldown = 0;
    this.exhausted = false; // 体力耗尽后的疲惫状态（锁冲刺 + 移速下降）

    this.inventory = createInventory(PLAYER.backpack.cols, PLAYER.backpack.rows);
    // P18：胸挂 / 口袋 / 安全容器是主背包之外的并行格位容器。
    // 关键铁律：所有聚合读取（负重/估值/换弹/医疗/丢弃/结算带出）都必须经 containers，
    // 否则放进额外容器的物品会"凭空消失"或"白嫖重量"。默认空数组时行为与旧版逐位一致。
    this.extraContainers = [];
    // 装备槽（备用武器 / 备用护甲 / 备用头盔）：局内搜刮拾取的备用装备，撤离后入库。
    // 不即时改变战斗数值（8 分钟模式不鼓励中途换甲），但结算必须一并带出。
    this.equipmentSlots = [];
    const defs = Array.isArray(opts.weaponDefs) && opts.weaponDefs.length
      ? opts.weaponDefs
      : [WEAPONS.pistol];
    this.weapons = defs.map((d) => createWeaponState(d));
    // P7：战前选定的弹种写进武器状态（初始弹匣也按该弹种结算伤害）。
    if (Array.isArray(opts.ammoIds)) {
      this.weapons.forEach((w, i) => {
        if (opts.ammoIds[i]) w.ammoId = opts.ammoIds[i];
      });
    }
    this.weaponIndex = 0;

    if (Array.isArray(opts.items)) {
      for (const item of opts.items) {
        if (item) autoPlace(this.inventory, item);
      }
    }

    this.dead = false;
    this.crouching = false;
    // ★ 姿态阶梯（stand / crouch / prone）与跳跃。
    // crouching 保留原语义（受击散布、噪音、视距全部读它），prone 是它的更强一档：
    // 卧倒时 crouching 恒为 true，这样所有"低姿态收益"自动继承，不需要逐处改判定。
    this.prone = false;
    this.stance = STANCE.STAND;
    this.standLock = 0; // 起身硬直（秒），卧倒→站立要花时间
    this.jumpZ = 0; // 离地高度（米，与 elevation 同量纲）
    this.jumpVy = 0; // 竖直速度（米/秒）
    this.airborne = false;
    this.landDip = 0; // 落地镜头下沉（米，纯视觉，指数回落）
    this.vault = null; // { t, dur, x0, y0, x1, y1, apex }
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

    // 干员（P5）：被动乘数 + 技能状态 + 终结技增益。
    // 全部给默认值，测试手搓的 Player 与旧存档路径都不会读到 undefined。
    this.operatorId = null;
    this.callsign = '你 / PLAYER';
    this.reloadMul = 1;   // 换弹时长乘数（火神 0.86）
    this.stealthMul = 1;  // 敌人发现距离乘数（帷幕 0.82）
    this.healMul = 1;     // 医疗品恢复乘数（脉冲 1.3）
    this.tacCdMul = 1;    // 战术道具冷却乘数（余烬 0.8）
    this.abilities = null; // 由 main.startRaid 填入 createAbilityState()
    this.combatMods = null; // 终结技激活期间的 散布/后坐/伤害 乘数

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
    this.headshots = 0;
    this.searchedCount = 0;
    this.shotsFired = 0;
    this.hits = 0;
    this.damageTaken = 0;
  }

  /** 当前武器状态 */
  get currentWeapon() {
    return this.weapons[this.weaponIndex] || null;
  }

  /** 全部格位容器（主背包 + 胸挂 / 口袋 / 安全容器）。唯一聚合真值。 */
  get containers() {
    return [this.inventory, ...(this.extraContainers || [])];
  }

  /** 结算带出清单：所有格位容器内的物品（不含装备槽展示件，避免与护甲/武器重复计数）。 */
  carriedItems() {
    const out = [];
    for (const c of this.containers) out.push(...c.items);
    return out;
  }

  /** 全部随身物品（含装备槽内的备用装备），用于结算带出与查找。 */
  allItems() {
    const out = [];
    for (const c of this.containers) out.push(...c.items);
    for (const s of this.equipmentSlots || []) if (s.item) out.push(s.item);
    return out;
  }

  /**
   * 在全部容器中按 id 计数（备用弹药 / 医疗物资的唯一真值）。
   * 只读主背包会让"放进胸挂的弹匣打不出来"，这是 P18 的硬约束。
   * @param {string} itemId 物品 id
   * @returns {number} 数量
   */
  countAll(itemId) {
    let n = 0;
    for (const c of this.containers) n += countById(c, itemId);
    return n;
  }

  /**
   * 在全部容器里消耗指定物品；跨容器时按顺序扣减。
   * @param {string} itemId 物品 id
   * @param {number} amount 需要消耗的数量
   * @returns {number} 实际消耗数量
   */
  consumeAll(itemId, amount) {
    let need = Math.max(0, amount);
    let used = 0;
    for (const c of this.containers) {
      if (need <= 0) break;
      const got = consumeById(c, itemId, need);
      used += got;
      need -= got;
    }
    return used;
  }

  /** 在当前所有容器中按 uid 查找物品（含所在容器）。 */
  findAnywhere(uid) {
    for (const c of this.containers) {
      const it = c.items.find((x) => x.uid === uid);
      if (it) return { item: it, container: c };
    }
    for (const s of this.equipmentSlots || []) {
      if (s.item && s.item.uid === uid) return { item: s.item, container: null, slot: s };
    }
    return null;
  }

  /**
   * 背包 + 护甲 + 武器 + 近战 + 胸挂的总重量（kg）。W2 起背包/近战/胸挂自重也计入。
   *
   * ⚠ 头盔自重**刻意不加**：局内一直没算过，现在补进来会直接把戴头盔的玩家推进超重档
   * （移速/体力惩罚），属于隐性削弱数值。战前 estimateWeight 里头盔是算的，
   * 这处「战前偏高、局内偏低」的不一致作为已知项留到 W6 数值对齐一起处理。
   */
  get weight() {
    let w = 0;
    for (const c of this.containers) w += totalWeight(c);
    w += (this.armorDef.weight || 0);
    w += (this.backpackDef && this.backpackDef.weight) || 0;
    w += (this.rigDef && this.rigDef.weight) || 0;
    w += (this.meleeDef && this.meleeDef.weight) || 0;
    for (const weapon of this.weapons) w += weapon.def.weight || 0;
    return Math.round(w * 10) / 10;
  }

  /** 当前负重上限（kg）= 基础 28 + 护甲加成 + 背包加成 + 局外改装加成 */
  get weightLimit() {
    const cfg = this.playerCfg || PLAYER;
    const base = typeof cfg.weightBaseLimit === 'number' ? cfg.weightBaseLimit : PLAYER.weightBaseLimit;
    // weightLimitFor 内部读的是基础配置；这里只补上改装带来的额外基础值，护甲/背包加成仍走同一函数。
    return weightLimitFor(this.armorDef.id, this.backpackDef && this.backpackDef.id)
      + Math.max(0, base - PLAYER.weightBaseLimit);
  }

  /** 是否硬性超重（超重即禁跑，见 update） */
  get overweight() {
    return isOverweight(this.weight, this.weightLimit);
  }

  /** 随身物资估值（含所有格位容器与装备槽） */
  get carriedValue() {
    let sum = 0;
    for (const c of this.containers) sum += totalValue(c);
    for (const s of this.equipmentSlots || []) if (s.item) sum += itemValue(s.item);
    return Math.round(sum);
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
    return this.countAll(itemId);
  }

  /**
   * 消耗备用弹药。
   * @param {string} itemId 弹药物品 id
   * @param {number} amount 数量
   * @returns {number} 实际消耗
   */
  consumeReserve(itemId, amount) {
    return this.consumeAll(itemId, amount);
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
    // P7：流血在绳索/载具期间也照样掉血 —— 伤口不会因为你上车就愈合。
    // 放在所有 early-return 之前，保证任何移动状态都吃同一份持续伤害。
    this.updateInjuries(dt, world);
    if (this.dead) return;
    // 绳索速降期间接管移动：不能开火 / 交互，沿绳滑到落点
    if (this.ropeCd > 0) this.ropeCd = Math.max(0, this.ropeCd - dt);
    // 切枪计时：到点后进入 ready（期间 canFire 为 false，杜绝"切枪顺发"）。
    if (this.switchTimer > 0) {
      this.switchTimer = Math.max(0, this.switchTimer - dt);
      if (this.switchTimer <= 0) this.switchPhase = 'ready';
    }
    if (this.ropelling) {
      this.updateRope(dt, world);
      return;
    }
    if (this.vehicleCd > 0) this.vehicleCd = Math.max(0, this.vehicleCd - dt);
    if (this.vehicle) {
      this.updateDrive(dt, input, world);
      return;
    }
    // 翻越全程 0.46s 由脚本接管：这段时间不接受摇杆、不开火、不改姿态。
    // 和绳索同一套 early-return 语义 —— 半自动动作要么全程接管，要么根本不做。
    if (this.vault) {
      if (input) input.jumpPressed = false; // 吞掉这期间的空格，避免落地瞬间二段跳
      this.updateVault(dt, world);
      this.combatState = deriveCombatState(this);
      return;
    }
    this.hurtFlash = Math.max(0, this.hurtFlash - dt);
    this.muzzleFlash = Math.max(0, this.muzzleFlash - dt);
    // W2 近战：冷却与挥击动作进度。放在 early-return 之后 —— 绳索/驾驶期间不该偷偷转冷却。
    if (this.meleeCd > 0) this.meleeCd = Math.max(0, this.meleeCd - dt);
    if (this.meleeSwing > 0) this.meleeSwing = Math.max(0, this.meleeSwing - dt * 3.4);
    // P22：压制衰减放在 early-return 之后，绳索/驾驶期间不额外刷新（那时也没人在打你）。
    this.suppression = decayPlayerSuppression(this.suppression, dt);
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
    // 开镜过渡（P4-C2）：指数逼近而非布尔跳变，抬枪/散布/准星/视场才能同步渐变。
    // 开镜期间受伤打断由 hurtFlash 之外的状态负责，这里只做纯插值，不引入惩罚。
    const adsRate = COMBAT.adsRate || 9;
    this.adsT = (this.adsT || 0) + ((this.ads ? 1 : 0) - (this.adsT || 0)) * (1 - Math.exp(-adsRate * dt));
    if (this.adsT < 1e-4) this.adsT = 0;
    if (this.adsT > 1 - 1e-4) this.adsT = 1;

    // ---- 姿态（stand / crouch / prone）----
    // 三档阶梯收敛在一处：卧倒是蹲的更强一档（crouching 恒真），
    // 这样散布/噪音/视距/后坐所有"低姿态收益"自动继承，不需要逐处加分支。
    this.updateStance(dt, input);

    // ---- 跳跃 / 翻越（Space）----
    // 输入是边沿触发（jumpPressed），在 player 侧消费掉：长按空格不会连跳。
    if (input && input.jumpPressed) {
      input.jumpPressed = false;
      this.tryJump(world);
    }

    // ---- 探头（P19）----
    // 只影响相机/枪模的横向偏移：命中射线仍从身体中轴发出，
    // 因此「贴墙探头」绝不会变成穿墙射击（判定比视觉更严格）。
    this.leanInput = canLean(this) ? (Number(input && input.lean) || 0) : 0;
    const leanOff = ((COMBAT.lean && COMBAT.lean.offsetM) || 0.42) * VIEW3D.metersToUnits;
    let leanTarget = Math.sign(this.leanInput) * leanOff;
    if (leanTarget !== 0) {
      const rx = -Math.sin(this.angle);
      const ry = Math.cos(this.angle);
      if (isSolidAt(world.map, this.x + rx * leanTarget, this.y + ry * leanTarget)) leanTarget = 0;
    }
    this.leanT += (leanTarget - this.leanT) * (1 - Math.exp(-11 * dt));
    if (Math.abs(this.leanT) < 1e-3) this.leanT = 0;

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
    // 触屏摇杆推了多少，只有触屏层知道（up/down/... 是布尔量，光看 mag 永远是 0/1/1.41）。
    // 桌面键盘没有这个字段，回落成布尔模长，行为完全不变。
    this.moveMag = typeof input.touchMoveMag === 'number' ? input.touchMoveMag : mag;
    this.moving = mag > 0.01;
    if (this.moving) {
      mx /= mag;
      my /= mag;
    }

    // 读条中被移动打断。撤离读条对摇杆漂移更宽容：明显推动（>0.45）才算走开；
    // 其余读条（search / heal / hack）阈值 0.05，等价于原来的布尔 moving。
    const breakAt = this.extract ? 0.45 : 0.05;
    if (this.busy && this.moving && this.moveMag >= breakAt) {
      const wasExtract = Boolean(this.extract);
      this.interrupt('move');
      if (wasExtract && world.toast) world.toast('移动打断了撤离');
    }

    // 硬性超重：**不再禁止奔跑**，只是移速会按超重比例下降（减速，见下方 weightMul）。
    // 与超重减速同时生效 —— 玩家超重时"跑得慢但还能跑"，逃命手段依旧可用。
    // P19：冲刺判据收敛到 canSprint（含载具/疲惫/蹲伏/读条），不再各处手写取反。
    const wantSprint = Boolean(input.sprint) && canSprint(this);
    // 注意：冲刺可一直消耗到体力为 0（不再用 >1 的门槛提前截断），
    // 体力归零时进入 exhausted 锁定冲刺，直至恢复到 staminaExhaustRecovery 阈值才解除。
    this.sprinting = wantSprint && this.moving;
    // 冲刺结束后必须先「抬枪」才能开火：冲刺期间锁一直重置，松手后按枪种衰减。
    if (this.sprinting) {
      this.sprintLock = sprintRaiseDelay(this.currentWeapon && this.currentWeapon.def);
    } else if (this.sprintLock > 0) {
      // 开镜会同时举枪贴腮，抬枪更快（但不会瞬间归零）。
      const speedUp = this.ads && COMBAT.raiseAdsSpeedMul ? COMBAT.raiseAdsSpeedMul : 1;
      this.sprintLock = Math.max(0, this.sprintLock - dt * speedUp);
    }
    this.wasSprinting = this.sprinting;

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
        const cfg = this.playerCfg || PLAYER;
        const regen = typeof cfg.staminaRegen === 'number' ? cfg.staminaRegen : PLAYER.staminaRegen;
        this.stamina = Math.min(this.maxStamina, this.stamina + regen * regenMul * dt);
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
    const cfg = this.playerCfg || PLAYER;
    const baseSpeed = typeof cfg.speed === 'number' ? cfg.speed : PLAYER.speed;
    let speed = baseSpeed * weightMul;
    // 姿态优先级：卧倒 > 蹲 > 冲刺。卧倒恒为低姿态，不再吃 crouchMul，
    // 否则两档叠乘会变成 0.14 倍速（等于原地不动），手感上是"卡住"而不是"爬"。
    if (this.prone) speed *= PLAYER.proneMul;
    else if (this.crouching) speed *= PLAYER.crouchMul;
    else if (this.sprinting) speed *= PLAYER.sprintMul;
    // 起身硬直：刚从卧倒爬起来的那 0.35s 腿是软的（冲刺另有 canSprint 拦截）。
    if (this.standLock > 0) speed *= 0.5;
    // 滞空：保留一点空控（0.82），不做完全不可控 —— 否则跳起来就是任人宰割。
    if (this.airborne) speed *= JUMP.airMoveMul;
    // 开镜 / 换弹 / 探头三档移速惩罚（按 adsT 插值，收镜过程不会突然变快）。
    if (this.adsT > 0.02) {
      const adsMul = COMBAT.adsMoveMul != null ? COMBAT.adsMoveMul : 1;
      speed *= 1 - (1 - adsMul) * this.adsT;
    }
    const cw = this.currentWeapon;
    if (cw && cw.reloading) speed *= COMBAT.reloadMoveMul != null ? COMBAT.reloadMoveMul : 1;
    if (Math.abs(this.leanT) > 0.02) {
      speed *= (COMBAT.lean && COMBAT.lean.speedMul) || 1;
    }
    if (this.exhausted) speed *= PLAYER.staminaExhaustSpeedMul;
    // 骨折：移速下降，冲刺再额外打折（不硬禁奔跑，避免残血时完全失去逃生手段）
    if (this.conditions.fracture) {
      speed *= conditionSpeedMul(this.conditions);
      if (this.sprinting) speed *= conditionSprintMul(this.conditions);
    }
    if (this.busy) speed = 0;
    this.moveSpeed = this.moving ? speed : 0;

    if (this.moving && speed > 0) {
      const next = moveWithCollision(
        world.map, this.x, this.y, mx * speed * dt, my * speed * dt, this.radius,
      );
      this.x = next.x;
      this.y = next.y;
      this.walkPhase += dt * (speed / baseSpeed) * 9;
    }
    // ---- 竖直运动（跳跃）----
    // jumpZ / elevation 同为"米"，相机层直接相加再乘 metersToUnits。
    // 落地统一在这里发一次响动：跳一下不是免费的，落点会暴露位置。
    if (this.airborne) {
      this.jumpVy -= JUMP.gravity * dt;
      this.jumpZ += this.jumpVy * dt;
      // 撞头：室内把视线夹在楼板下方（留 15cm 给头顶），顶到就立刻开始下落。
      // 这条不是为了"手感"，而是为了让 4.2m 层高下的跳跃不会穿出屋顶 ——
      // 尤其是站在 1.25m 架高平台上跳的时候。
      const ceil = ceilingHeightAt(world.map, this.x, this.y);
      if (Number.isFinite(ceil)) {
        // 减去平台高程：站在 1.25m 架高平台上时，可用跳跃空间本来就更少。
        const cap = Math.max(0, ceil - (this.elevation || 0) - VIEW3D.eyeStand - 0.15);
        if (this.jumpZ > cap) {
          this.jumpZ = cap;
          if (this.jumpVy > 0) {
            this.jumpVy = 0;
            world.emitNoise(this.x, this.y, JUMP.landNoise * 0.4, 'player');
          }
        }
      }
      if (this.jumpZ <= 0) {
        this.jumpZ = 0;
        this.jumpVy = 0;
        this.airborne = false;
        this.landDip = 0.07;
        world.emitNoise(this.x, this.y, JUMP.landNoise, 'player');
        if (world.audio && world.audio.step) world.audio.step(0.5);
      }
    }
    // 落地镜头下沉：纯视觉，指数回落，不影响任何判定。
    if (this.landDip > 0) this.landDip = Math.max(0, this.landDip * Math.max(0, 1 - dt * 9));

    // 高程：站在架高平台上时抬高视点（供相机高度与「越过掩体」的视线判定使用）。
    // 用指数插值平滑过渡，走上 / 走下平台时不会瞬移。
    const targetElev = elevationAt(world.map, this.x, this.y);
    const curElev = this.elevation || 0;
    this.elevation = curElev + (targetElev - curElev) * (1 - Math.exp(-12 * dt));

    // ---- 噪音 ----
    let noise = 0;
    if (this.moving) {
      noise = this.prone
        ? PLAYER.noiseProne
        : (this.crouching ? PLAYER.noiseCrouch : (this.sprinting ? PLAYER.noiseSprint : PLAYER.noiseWalk));
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
      // 搜刮会发出周期性响动（节流 1.2 秒）：贴脸开箱不再是零风险。
      // 不能每帧发 —— world.emitNoise 会遍历全部敌人。
      this.search.noiseCd = (this.search.noiseCd || 0) - dt;
      if (this.search.noiseCd <= 0) {
        this.search.noiseCd = 1.2;
        world.emitNoise(this.x, this.y, PLAYER.noiseSearch, 'player');
      }
      if (this.search.progress >= this.search.total) {
        const container = this.search.container;
        this.search = null;
        world.onSearchComplete(container);
      }
    }
    if (this.extract) {
      this.extract.progress += dt;
      // P20：读条总长由撤离点决定（高危点更久）；缺省回落到配置值，兼容旧状态对象。
      const need = this.extract.total || MATCH.extractChannel;
      if (this.extract.progress >= need) {
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
        this.finishHeal(done, world);
      }
    }
    if (this.hack) {
      this.hack.progress += dt;
      // 破解同样出声（节流 1.5 秒，比搜刮更慢节奏）：终端不是免费的情报费。
      this.hack.noiseCd = (this.hack.noiseCd || 0) - dt;
      if (this.hack.noiseCd <= 0) {
        this.hack.noiseCd = 1.5;
        world.emitNoise(this.x, this.y, PLAYER.noiseSearch, 'player');
      }
      if (this.hack.progress >= this.hack.total) {
        const terminal = this.hack.terminal;
        this.hack = null;
        if (world.onTerminalComplete) world.onTerminalComplete(terminal);
      }
    }
    // P19：动作状态快照（HUD/探针读这里，纯归纳不改任何状态）。
    this.combatState = deriveCombatState(this);
  }

  /**
   * 姿态阶梯：把 input 的两个布尔量收敛成 stance / prone / crouching。
   *
   * 设计（三角洲对齐）：
   * - `C` 切换蹲、`Z` 切换卧倒、`Ctrl` 按住蹲 —— 三条路径都写进这里，
   *   UI/触屏/键盘不各判一套，HUD 读数与判定永远同源。
   * - 卧倒时 `crouching` 恒为 true：散布/噪音/视距/后坐全部自动继承低姿态收益。
   * - 起身有 0.35s 硬直（`standLock`）：趴着不是零成本，否则人人都躺着打。
   * @param {number} dt 帧间隔秒
   * @param {object} input 输入状态
   * @returns {void}
   */
  updateStance(dt, input) {
    const wantProne = Boolean(input && input.prone);
    const wantCrouch = Boolean(input && input.crouch);
    if (this.prone && !wantProne) this.standLock = PLAYER.proneStandCost;
    this.prone = wantProne;
    this.crouching = wantProne || wantCrouch;
    this.stance = wantProne
      ? STANCE.PRONE
      : (wantCrouch ? STANCE.CROUCH : STANCE.STAND);
    if (this.standLock > 0) this.standLock = Math.max(0, this.standLock - dt);
  }

  /**
   * 起跳 / 翻越。正前方有掩体箱时优先翻越（三角洲的 Space 就是"跳+翻越"一个键）。
   * @param {object} world 战局上下文
   * @returns {boolean} 是否真的起跳 / 开始翻越
   */
  tryJump(world) {
    if (this.dead || this.busy || this.vehicle || this.ropelling || this.vault) return false;
    if (this.airborne) return false;
    // 刚起身那一下腿软，跳不起来（和 standLock 的移速惩罚同一套语义）
    if (this.standLock > 0.12) return false;
    const plan = this.planVault(world);
    if (plan) {
      this.vault = {
        t: 0,
        dur: JUMP.vaultDur,
        x0: this.x,
        y0: this.y,
        x1: plan.x,
        y1: plan.y,
        apex: JUMP.vaultApex,
      };
      this.prone = false;
      this.crouching = false;
      this.stance = STANCE.STAND;
      this.jumpZ = 0;
      this.airborne = true;
      if (world && world.audio && world.audio.step) world.audio.step(0.35);
      return true;
    }
    this.jumpVy = JUMP.speed;
    this.jumpZ = 0;
    this.airborne = true;
    this.prone = false;
    this.crouching = false;
    this.stance = STANCE.STAND;
    return true;
  }

  /**
   * 正前方能否翻越：必须真的有一道掩体箱挡路，且它后面有能站住的空地。
   * 墙（CELL.WALL）永远翻不过去 —— 3.2m 的墙不是 Space 能解决的。
   * @param {object} world 战局上下文
   * @returns {{x:number,y:number}|null} 落点
   */
  planVault(world) {
    const map = world && world.map;
    if (!map || !map.tile) return null;
    const dx = Math.cos(this.angle);
    const dy = Math.sin(this.angle);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
    const step = map.tile * 0.25;
    const range = JUMP.vaultRange * VIEW3D.metersToUnits;
    const r = this.radius;
    let hit = false;
    for (let d = r; d <= range; d += step) {
      const x = this.x + dx * d;
      const y = this.y + dy * d;
      const cell = cellAt(map, x, y);
      if (cell === CELL.WALL) return null; // 墙后面的事不归跳跃管
      if (cell === CELL.CRATE) { hit = true; continue; }
      if (!hit) continue;
      // 已经越过掩体：落在第一个"圆心净空"的位置（半径 12 + 余量由 circleHitsSolid 保证）
      if (!circleHitsSolid(map, x, y, r + JUMP.minClear * VIEW3D.metersToUnits * 0.25)) {
        return { x, y };
      }
    }
    return null;
  }

  /**
   * 翻越推进：位置沿起点→落点做 easeInOut 插值，高度走 sin 弧线。
   * 期间完全接管移动（不接受摇杆/键盘），也不允许开火（canFire 读 this.vault）。
   * @param {number} dt 帧间隔秒
   * @param {object} world 战局上下文
   * @returns {void}
   */
  updateVault(dt, world) {
    const v = this.vault;
    v.t = Math.min(v.dur, v.t + dt);
    const k = v.dur > 0 ? v.t / v.dur : 1;
    // easeInOut：起跳前段慢、过箱瞬间快、落地前收住，读起来才像"跨"而不是"滑"
    const e = k < 0.5 ? 2 * k * k : 1 - ((-2 * k + 2) ** 2) / 2;
    const prevX = this.x;
    const prevY = this.y;
    this.x = v.x0 + (v.x1 - v.x0) * e;
    this.y = v.y0 + (v.y1 - v.y0) * e;
    this.jumpZ = Math.sin(Math.PI * k) * v.apex;
    this.moving = Math.hypot(this.x - prevX, this.y - prevY) > 1e-4;
    this.moveMag = 0;
    this.moveSpeed = this.moving ? (Math.hypot(v.x1 - v.x0, v.y1 - v.y0) / v.dur) * (1 - Math.abs(0.5 - k)) : 0;
    this.walkPhase += dt * 6;
    if (k >= 1) {
      this.x = v.x1;
      this.y = v.y1;
      this.jumpZ = 0;
      this.airborne = false;
      this.vault = null;
      this.landDip = 0.07;
      this.elevation = elevationAt(world.map, this.x, this.y);
      world.emitNoise(this.x, this.y, JUMP.landNoise, 'player');
      if (world.audio && world.audio.step) world.audio.step(0.55);
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
        world.hitMarker = COMBAT.hitMarkerLife;
        // 命中反馈分级：P7 起由 applyDamage 写下的 world.lastDamage 决定；
        // V-02 起再按穿透比细分出 弹开 / 半穿 / 击穿 三档。
        const e = result.entity;
        const info = world.lastDamage;
        const kind = hitKindFor(info, e.dead);
        if (info && info.zone === 'head') this.headshots = (this.headshots || 0) + 1;
        world.hitKind = kind;
        world.hitKindT = HUD.hit.life;
        // P4-C3：命中音按分级播（准星标记、短码、音色三者同一档），
        // 玩家不盯准星也能靠耳朵分辨"打穿护甲"和"打死"。
        if (world.audio && typeof world.audio.hitConfirm === 'function') world.audio.hitConfirm(kind);
        // 终结技能量（P5）：命中给零头、击杀给大头。放在这里而不是 applyDamage，
        // 是因为只有"玩家打出去的这一发"才该充能，敌人互射不应该给玩家攒大。
        if (world.addPlayerUlt) {
          world.addPlayerUlt('hit');
          if (kind === 'kill') world.addPlayerUlt('kill');
        }
      }
    }
  }

  /**
   * 近战挥击（W2）。
   *
   * 与开火互斥：读条/绳索/驾驶/换弹期间不能挥刀（`busy` 与 `ropelling` 挡在最前面）。
   * 命中反馈走和枪击同一套（world.lastDamage / hitKind），所以准星标记、
   * 命中分级短码、命中音在这条路径上自动生效，不需要第二套表现。
   *
   * @param {object} world 战局上下文
   * @returns {boolean} 是否真的挥出这一下
   */
  meleeAttack(world) {
    if (this.dead || !world) return false;
    if (!this.meleeDef) return false;
    if (this.busy || this.ropelling || this.vehicle) return false;
    if (this.meleeCd > 0) return false;
    const res = meleeAttack(world, this);
    this.meleeSwings = (this.meleeSwings || 0) + 1;
    if (res.hit && res.entity) {
      this.meleeHits = (this.meleeHits || 0) + 1;
      world.hitMarker = COMBAT.hitMarkerLife;
      const info = world.lastDamage;
      const kind = hitKindFor(info, res.entity.dead);
      if (info && info.zone === 'head') this.headshots = (this.headshots || 0) + 1;
      world.hitKind = kind;
      world.hitKindT = HUD.hit.life;
      if (world.audio && typeof world.audio.hitConfirm === 'function') world.audio.hitConfirm(kind);
      // 近战击杀同样给终结技能量（与枪击口径一致，玩家不会因为换刀就攒不到大）
      if (world.addPlayerUlt) {
        world.addPlayerUlt('hit');
        if (kind === 'kill') world.addPlayerUlt('kill');
      }
    }
    return true;
  }

  /**
   * 切换武器。
   * @param {number} index 武器下标
   * @param {object} world 战局上下文
   * @returns {boolean} 是否切换成功
   */
  switchWeapon(index, world) {
    if (index < 0 || index >= this.weapons.length || index === this.weaponIndex) return false;
    if (!canSwitchWeapon(this)) return false;
    const current = this.currentWeapon;
    const fromDef = current ? current.def : null;
    if (current) {
      current.reloading = false;
      current.reloadTimer = 0;
      current.reloadAmount = 0;
    }
    this.weaponIndex = index;
    this.recoilOffset = 0;
    // P19：切枪不是瞬移 —— 副武器更快、主武器互换最慢（数值见 COMBAT.switchTime）。
    const nextDef = this.currentWeapon ? this.currentWeapon.def : null;
    this.switchTotal = switchDuration(fromDef, nextDef);
    this.switchTimer = this.switchTotal;
    this.switchPhase = 'equip';
    // 同步刷新快照：动作是同步发生的，HUD/探针不该等到下一帧才看到新状态。
    this.combatState = deriveCombatState(this);
    if (world && world.audio) world.audio.ui(0.5);
    return true;
  }

  /** 换弹 */
  reload(world) {
    if (this.busy) return false;
    if (!canReload(this)) return false;
    const started = startReload(this, world);
    if (started) this.combatState = deriveCombatState(this);
    return started;
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
    const items = [];
    for (const c of this.containers) {
      items.push(...findItems(c, (it) => it.category === 'consumable' && it.qty > 0));
    }
    if (!items.length) {
      if (world.toast) world.toast('没有可用的医疗物资');
      return false;
    }
    // P7：择优逻辑收敛在 medical.pickMedical —— 出血先止血、骨折先手术、
    // 血少用医疗包、血多避免过量治疗。点击物品与 Q 键共用同一份可用性判定。
    const defs = items.map((it) => (this.itemCfg && this.itemCfg[it.id]) || ITEMS[it.id] || it);
    const best = pickMedical(defs, this.medicalState());
    if (!best) {
      if (world.toast) world.toast('状态良好，无需治疗');
      return false;
    }
    const item = items.find((it) => it.id === best.id) || items[0];
    return this.startUseItem(item, world);
  }

  /** 当前医疗判定所需的只读快照（不传引用，避免 UI 误改状态）。 */
  medicalState() {
    return medicalProfile(this);
  }

  /**
   * 开始使用一件医疗物品（Q 键择优与背包点击共用）。
   * @param {object|string} itemOrUid 物品实例或其 uid
   * @param {object} world 战局
   * @returns {boolean} 是否开始读条
   */
  startUseItem(itemOrUid, world) {
    const item = typeof itemOrUid === 'string'
      ? (this.findAnywhere(itemOrUid) || {}).item
      : itemOrUid;
    if (!item || item.category !== 'consumable' || (item.qty || 0) <= 0) return false;
    if (this.busy) {
      this.interrupt('cancel');
      return false;
    }
    // 改装后的医疗定义：heal / useTime 都从注入的 itemCfg 取，避免只买改装却仍按基础值回血。
    const def = (this.itemCfg && this.itemCfg[item.id]) || ITEMS[item.id] || item;
    const use = itemUsable(def, this.medicalState());
    if (!use.ok) {
      if (world && world.toast) world.toast(use.reason);
      return false;
    }
    this.heal = { uid: item.uid, progress: 0, total: def.useTime || 1.5, def };
    if (world && world.audio) world.audio.ui(0.4);
    if (world && world.toast) world.toast(`开始使用 ${def.name}`);
    return true;
  }

  /**
   * 读条完成：按物品字段结算。字段驱动，新增医疗品不需要改这里的分支。
   * @param {{def: object}} done 完成的读条
   * @param {object} world 战局
   */
  finishHeal(done, world) {
    const def = (done && done.def) || {};
    const parts = [];
    // 先修复上限再回血，否则手术包的 30 点会被骨折后的低上限截掉
    if (def.cureFracture && this.conditions.fracture) {
      this.conditions.fracture = 0;
      this.maxHp = fractureMaxHp(this.maxHpBase, this.conditions);
      parts.push('骨折已复位');
    }
    if (def.stopBleed && this.conditions.bleed > 0) {
      parts.push(`止血 ×${this.conditions.bleed}`);
      this.conditions.bleed = 0;
    }
    if (def.repairArmor) {
      const frac = Number(def.repairArmor) || 0;
      const vestGain = this.maxArmor > 0
        ? Math.min(this.maxArmor, this.armor + this.maxArmor * frac) - this.armor : 0;
      const helmetGain = this.maxHelmet > 0
        ? Math.min(this.maxHelmet, this.helmet + this.maxHelmet * frac) - this.helmet : 0;
      this.armor += vestGain;
      this.helmet += helmetGain;
      if (vestGain + helmetGain > 0) parts.push(`护甲 +${Math.round(vestGain + helmetGain)}`);
    }
    if (def.heal) {
      const before = this.hp;
      this.hp = Math.min(this.maxHp, this.hp + def.heal * (this.healMul || 1));
      if (this.hp > before) parts.push(`生命 +${Math.round(this.hp - before)}`);
    }
    if (def.stamina) {
      const before = this.stamina;
      this.stamina = Math.min(this.maxStamina, this.stamina + def.stamina);
      if (this.stamina > before) parts.push(`体力 +${Math.round(this.stamina - before)}`);
    }
    this.consumeAll(def.id, 1);
    if (world && world.audio) world.audio.heal();
    if (world && world.toast) {
      world.toast(parts.length ? `已使用 ${def.name} · ${parts.join(' · ')}` : `已使用 ${def.name}`);
    }
  }

  /**
   * 被命中回调（由 combat.applyDamage 调用）。
   * 只做"伤害之后"的状态判定：流血 / 骨折，不参与伤害数字本身。
   */
  onHit(info = {}) {
    if (this.dead || this.hp <= 0) return;
    const world = info.world;
    const beforeBleed = this.conditions.bleed;
    const res = applyInjury(this.conditions, {
      raw: info.raw,
      zone: info.zone,
      hpAfter: this.hp,
      maxHpBase: this.maxHpBase,
    });
    if (res.fractureAdded) {
      this.maxHp = fractureMaxHp(this.maxHpBase, this.conditions);
      this.hp = Math.min(this.hp, this.maxHp);
      if (world && world.toast) world.toast('骨折 — 生命上限下降，需要手术包');
      if (world && world.audio && world.audio.warn) world.audio.warn();
      return;
    }
    if (res.bleedAdded > 0 && beforeBleed === 0) {
      // 只在"从无到有"时提示一次；叠加层数交给 HUD 状态图标，避免每发刷屏
      if (world && world.toast) world.toast('流血 — 用绷带或医疗包止血');
    }
  }

  /** 流血每帧结算：持续掉血，掉到 0 由主循环统一判死。 */
  updateInjuries(dt, world) {
    const dps = bleedDps(this.conditions);
    if (dps <= 0) return;
    this.hp = Math.max(0, this.hp - dps * dt);
    if (this.hp <= 0) {
      this.dead = true;
      if (world) {
        if (world.onDeath) world.onDeath(this, null);
        // onDeath 对 null 来源会把 killedBy 清空，这里补上"流血致死"的复盘信息
        world.killedBy = { type: 'bleed', dist: 0 };
      }
    }
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
    // M-03 / E-03：闸刀是独立 POI，优先级高于撤离点 —— 站在圈里也能先拉闸。
    // 广播与窗口开启由 world.pullExtractSwitch 统一处理（音效 + AI 听觉 + toast）。
    const sw = this.nearestSwitch(world);
    if (sw) {
      const ex = (world.map.extracts || []).find((e) => e.id === sw.extractId);
      const r = world.pullExtractSwitch ? world.pullExtractSwitch(ex) : { ok: false };
      if (!r.ok && world.toast) world.toast('闸刀已拉下，或撤离窗口已结束');
      return r.ok;
    }
    const extract = this.nearestExtract(world);
    if (extract) {
      // P20：能不能撤由状态机统一裁决（未开放 / 条件不足 / 资金不足 / 窗口已过）。
      // 兼容旧入口：没有 canExtract 的测试桩退回原来的付费判断。
      const gate = world.canExtract || world.canAffordExtract;
      if (gate && !gate.call(world, extract)) return false;
      const channel = world.extractChannelTime ? world.extractChannelTime(extract) : MATCH.extractChannel;
      this.extract = { point: extract, progress: 0, total: channel, warned: false };
      if (world.toast) world.toast(`开始撤离：${extract.name} — ${channel} 秒`);
      if (world.audio) world.audio.extractStart();
      return true;
    }
    // 多目标堆叠：容器与散落物堆合成一张目标表，E 搜当前高亮项，滚轮/方向键切。
    // 终端/闸刀/撤离的优先级仍在上面（它们是"能不能活"的决策，不该被顺手捡东西抢走）。
    const targets = this.availableTargets(world);
    if (!targets.length) {
      if (world.toast) world.toast('附近没有可交互目标');
      return false;
    }
    const target = targets[Math.min(this.targetIndex || 0, targets.length - 1)];
    return this.interactTarget(world, target);
  }

  /**
   * 附近可交互的容器 / 散落物堆列表（唯一真值在 loot-interact.js）。
   * HUD 用它画多目标提示，interact 用它决定 E 搜谁 —— 两边读同一份，不会高亮 A 搜了 B。
   * @param {object} world
   * @returns {Array<object>}
   */
  availableTargets(world) {
    return collectInteractables(world, this, {
      range: MATCH.interactRange,
      scatterRange: MATCH.itemPickupRange,
      los: (x1, y1, x2, y2) => hasLineOfSight(world.map, x1, y1, x2, y2),
    });
  }

  /**
   * 切换当前高亮目标（滚轮上/下一、方向键）。有界循环，目标变化时游标自动夹回。
   * @param {object} world
   * @param {number} delta +1 下一个 / -1 上一个
   * @returns {number} 新游标
   */
  cycleInteraction(world, delta) {
    const n = this.availableTargets(world).length;
    this.targetIndex = cycleTarget(this.targetIndex || 0, delta, n);
    return this.targetIndex;
  }

  /**
   * 对一个具体目标执行交互。
   * 普通物资（drawer/crate/weaponbox/body/airdrop/boss）+ 散落物堆：直接开双栏搜刮；
   * 保险箱：走读条 + 特殊解锁界面（searchTimeFor 返回配置秒数）。
   */
  interactTarget(world, target) {
    if (!target) return false;
    if (target.kind === TARGET_KIND.scatter) {
      // 散落物堆 = 一个临时容器：loot 直接引用 world.items 里的本体，
      // 取走时用 world.removeGroundItem 同步移除，绝不复制出第二份账面。
      const pile = target.ref;
      const container = {
        id: `scatter:${pile.items.map((i) => i.uid).join(',')}`,
        type: 'scatter', name: '散落物堆', x: pile.x, y: pile.y,
        loot: pile.items, searched: false, _scatter: true,
      };
      if (world.openLootPanel) world.openLootPanel(container);
      return true;
    }
    const container = target.ref;
    if (!container) return false;
    if (container.searched) {
      const remain = (container.loot || []).length;
      if (remain > 0) {
        if (world.openLootPanel) world.openLootPanel(container);
        return true;
      }
      if (world.toast) world.toast('这个容器已经空了');
      return false;
    }
    const total = searchTimeFor(container);
    if (total <= 0) {
      // 秒开：与读条完成走**同一个回调**（唯一真值），它负责 searched / 计分 / 开面板。
      // 不在这里重复设 searched，否则两条路径各写一份，早晚会漂移。
      if (world.onSearchComplete) world.onSearchComplete(container);
      else if (world.openLootPanel) world.openLootPanel(container);
      return true;
    }
    this.search = { container, progress: 0, total };
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
   * M-03：找到范围内可见、尚未拉下的闸刀。与终端同模型（含视线检查，不能隔墙拉）。
   * @param {object} world 战局上下文
   * @returns {object|null} 闸刀 POI
   */
  nearestSwitch(world) {
    let best = null;
    let bestDist = Infinity;
    for (const sw of ((world && world.map && world.map.switches) || [])) {
      if (sw.pulled) continue;
      const d = Math.hypot(sw.x - this.x, sw.y - this.y);
      if (d <= sw.r + PLAYER.radius && d < bestDist
        && hasLineOfSight(world.map, this.x, this.y, sw.x, sw.y)) {
        bestDist = d;
        best = sw;
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
    // 终结技能量：只有"被别人打到"才给，自己扔的燃烧弹（source.isPlayer）不算，
    // 否则玩家能靠站在自己火里刷能量。
    if (world && world.addPlayerUlt && !(source && source.isPlayer)) world.addPlayerUlt('hurt');
    if (this.heal) {
      this.interrupt('damage');
      if (world && world.toast) world.toast('治疗被打断！');
    }
    // 撤离读条不直接清零：只回退一段进度，让「在火力下强撤」变成一次赌博。
    if (this.extract) {
      this.extract.progress = Math.max(0, this.extract.progress - MATCH.extractHitPenalty);
      if (!this.extract.warned && world && world.toast) {
        this.extract.warned = true;
        world.toast('撤离被打断！先清掉守卫');
      }
    }
  }

  /**
   * 拾取一件战利品。
   * @param {object} item 物品实例
   * @returns {boolean} 是否成功
   */
  pickUp(item) {
    for (const c of this.containers) {
      if (autoPlace(c, item)) return true;
    }
    return false;
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
    if (!this.pickUp(item)) {
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
    const found = this.findAnywhere(uid);
    if (!found) return null;
    if (!found.container) {
      // 装备槽里的备用装备：直接摘下
      found.slot.item = null;
      return found.item;
    }
    const idx = found.container.items.findIndex((it) => it.uid === uid);
    if (idx < 0) return null;
    const [item] = found.container.items.splice(idx, 1);
    item.col = -1;
    item.row = -1;
    return item;
  }

  /**
   * 结算时导出随身物资。
   * @returns {Array<object>} 物品数组
   */
  exportItems() {
    return this.allItems();
  }
}

/**
 * 根据装备配置构建带入战局的物品列表。
 * @param {object} loadout 装备配置
 * @param {object} [itemDefs] 物品定义表（默认 ITEMS；传入改装后的表即可让医疗恢复量生效）
 * @returns {Array<object>} 物品实例数组
 */
export function buildLoadoutItems(loadout, itemDefs = ITEMS) {
  const defs = itemDefs || ITEMS;
  const defOf = (id) => defs[id] || ITEMS[id];
  const items = [];
  // P7：六型弹药都按「盒」带入；旧档字段由 loadoutAmmoBoxes 统一回落读取。
  for (const id of AMMO_IDS) {
    const def = defOf(id);
    if (!def) continue;
    const boxes = loadoutAmmoBoxes(loadout, id);
    for (let i = 0; i < boxes; i += 1) {
      items.push(createItem(def, def.ammoQty || def.stack || 1));
    }
  }
  for (let i = 0; i < Math.max(0, loadout.medkits || 0); i += 1) items.push(createItem(defOf('medkit'), 1));
  for (let i = 0; i < Math.max(0, loadout.bandages || 0); i += 1) items.push(createItem(defOf('bandage'), 1));
  for (let i = 0; i < Math.max(0, loadout.surgeries || 0); i += 1) items.push(createItem(defOf('surgery'), 1));
  for (let i = 0; i < Math.max(0, loadout.armorKits || 0); i += 1) items.push(createItem(defOf('armorKit'), 1));
  return items;
}
