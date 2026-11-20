/**
 * 统一战斗状态机（纯逻辑 · 零 DOM · 零 three · 零随机）
 *
 * 为什么要有它：改造前「冲刺 / 蹲伏 / 开镜 / 换弹 / 切枪 / 开火」各自在 player.update、
 * combat.fireWeapon、UI 三处各判一遍，规则一旦改一处就会出现
 * 「HUD 说能开火、实际开不出」或「冲刺中还能精准点射」这类互相打脸的状态。
 *
 * 设计约束：
 * - **只读**：derive() 不写玩家状态，只把既有字段归纳成一份可断言的快照。
 * - **不消耗 rng**：状态机里没有任何随机，探针与单测可逐位复现。
 * - **判定与执行同源**：Can* 系列就是 player/combat/input 真正调用的判据，
 *   不存在「UI 一套、逻辑一套」。
 */

import { COMBAT } from './config.js';

/** 移动状态。aimMove / reloadMove 是「叠加态」，优先级高于普通走路。 */
export const MOVEMENT_STATE = {
  IDLE: 'idle',
  WALK: 'walk',
  JOG: 'jog',
  SPRINT: 'sprint',
  CROUCH_MOVE: 'crouchMove',
  AIM_MOVE: 'aimMove',
  RELOAD_MOVE: 'reloadMove',
};

/** 姿态。三档阶梯：站立 / 蹲伏 / 卧倒（卧倒＝蹲的更强一档，crouching 恒真）。 */
export const STANCE_STATE = {
  STAND: 'stand',
  CROUCH: 'crouch',
  PRONE: 'prone',
};

/** 开镜状态：用 adsT 的过渡进度切段，而不是布尔跳变。 */
export const AIM_STATE = {
  HIP: 'hip',
  ADS_START: 'adsStart',
  ADS_FULL: 'adsFull',
  ADS_END: 'adsEnd',
};

export const FIRE_STATE = {
  READY: 'ready',
  FIRING: 'firing',
  COOLDOWN: 'cooldown',
  BLOCKED: 'blocked',
};

export const RELOAD_STATE = {
  NONE: 'none',
  START: 'start',
  MAG_OUT: 'magOut',
  MAG_IN: 'magIn',
  BOLT: 'bolt',
  END: 'end',
};

export const WEAPON_SWITCH_STATE = {
  NONE: 'none',
  UNEQUIP: 'unequip',
  EQUIP: 'equip',
  READY: 'ready',
};

export const LEAN_STATE = {
  NONE: 'none',
  LEFT: 'left',
  RIGHT: 'right',
};

/**
 * 武器大类 → 冲刺抬枪延迟（秒）。
 * 数值来自指令书区间中位，按「越重越慢」单调排列；config 可覆盖。
 */
const RAISE_BY_CLASS = {
  pistol: 0.15,
  smg: 0.20,
  ar: 0.27,
  shotgun: 0.30,
  lmg: 0.42,
  sniper: 0.45,
};

/**
 * 取武器大类。优先读配置里显式声明的 wclass，未声明时按弹种/结构推断，
 * 保证改装出的新武器（没有 wclass）也有确定的抬枪延迟，而不是 undefined。
 * @param {object} def 武器定义
 * @returns {string} pistol | smg | ar | shotgun | lmg | sniper
 */
export function weaponClassOf(def) {
  if (!def) return 'ar';
  if (def.wclass && RAISE_BY_CLASS[def.wclass]) return def.wclass;
  if (def.pellets && def.pellets > 1) return 'shotgun';
  if (def.magSize >= 70) return 'lmg';
  if ((def.rpm || 0) <= 90 && (def.magSize || 0) <= 8) return 'sniper';
  if (def.category === 'weapon' && (def.magSize || 0) <= 15 && (def.rpm || 0) <= 450) return 'pistol';
  if ((def.rpm || 0) >= 780 || def.caliber === '9mm') return 'smg';
  return 'ar';
}

/**
 * 冲刺退出后的抬枪延迟（秒）。
 * @param {object} def 武器定义
 * @returns {number}
 */
export function sprintRaiseDelay(def) {
  const table = (COMBAT && COMBAT.sprintRaise) || RAISE_BY_CLASS;
  const cls = weaponClassOf(def);
  const v = table[cls];
  return Number.isFinite(v) ? v : RAISE_BY_CLASS.ar;
}

/**
 * 切枪耗时（秒）。主武器互换最慢、掏手枪最快 —— 让"切手枪救场"有战术价值。
 * @param {object} fromDef 当前武器定义（无则视为空手）
 * @param {object} toDef 目标武器定义
 * @returns {number}
 */
export function switchDuration(fromDef, toDef) {
  const t = (COMBAT && COMBAT.switchTime) || { toPistol: 0.45, fromPistol: 0.55, primary: 0.80 };
  const toClass = weaponClassOf(toDef);
  const fromClass = weaponClassOf(fromDef);
  if (toClass === 'pistol') return t.toPistol;
  if (fromClass === 'pistol') return t.fromPistol;
  return t.primary;
}

/**
 * 归纳当前战斗状态（只读快照）。
 * @param {object} p 玩家（或任何带同名字段的主体）
 * @returns {object} PlayerCombatState
 */
export function deriveCombatState(p) {
  const w = p && p.currentWeapon ? p.currentWeapon : null;
  const adsT = clamp01(p && p.adsT != null ? p.adsT : (p && p.ads ? 1 : 0));
  const stance = p && p.prone
    ? STANCE_STATE.PRONE
    : (p && p.crouching ? STANCE_STATE.CROUCH : STANCE_STATE.STAND);
  const reloading = Boolean(w && w.reloading);
  const switching = Number(p && p.switchTimer) > 0;
  const sprintLock = Math.max(0, Number(p && p.sprintLock) || 0);
  const raiseDone = sprintLock <= 0;

  let movement;
  if (p && p.moving) {
    if (reloading) movement = MOVEMENT_STATE.RELOAD_MOVE;
    else if (p.sprinting) movement = MOVEMENT_STATE.SPRINT;
    else if (p.crouching) movement = MOVEMENT_STATE.CROUCH_MOVE;
    else if (adsT > 0.4) movement = MOVEMENT_STATE.AIM_MOVE;
    else movement = MOVEMENT_STATE.JOG;
  } else {
    movement = MOVEMENT_STATE.IDLE;
  }

  let aim;
  if (adsT <= 0.02) aim = AIM_STATE.HIP;
  else if (adsT >= 0.98) aim = AIM_STATE.ADS_FULL;
  else aim = p && p.ads ? AIM_STATE.ADS_START : AIM_STATE.ADS_END;

  let fire;
  if (p && p.dead) fire = FIRE_STATE.BLOCKED;
  else if (switching || !raiseDone) fire = FIRE_STATE.BLOCKED;
  else if (w && w.cooldown > 0) fire = FIRE_STATE.COOLDOWN;
  else if (p && p.firing) fire = FIRE_STATE.FIRING;
  else fire = FIRE_STATE.READY;

  let reload = RELOAD_STATE.NONE;
  if (reloading && w) {
    const total = Math.max(0.001, Number(w.reloadTotal) || 0.001);
    const prog = clamp01(1 - (Number(w.reloadTimer) || 0) / total);
    if (prog >= 0.999) reload = RELOAD_STATE.END;
    else if (prog <= 0.02) reload = RELOAD_STATE.START;
    // 段边界与 RELOADFX.stages 的比例一致（0.40 弹匣出 / 0.68 弹匣入 / 0.86 拉栓）
    else if (prog < 0.40) reload = RELOAD_STATE.MAG_OUT;
    else if (prog < 0.86) reload = RELOAD_STATE.MAG_IN;
    else reload = RELOAD_STATE.BOLT;
  }

  let switchState = WEAPON_SWITCH_STATE.NONE;
  if (switching) switchState = p.switchPhase === 'equip' ? WEAPON_SWITCH_STATE.EQUIP : WEAPON_SWITCH_STATE.UNEQUIP;

  const leanAmt = Number(p && p.leanT) || 0;
  const lean = leanAmt > 0.02 ? LEAN_STATE.RIGHT : leanAmt < -0.02 ? LEAN_STATE.LEFT : LEAN_STATE.NONE;

  return {
    movementState: movement,
    stanceState: stance,
    aimState: aim,
    fireState: fire,
    reloadState: reload,
    weaponSwitchState: switchState,
    leanState: lean,
    canFire: canFire(p),
    canAim: canAim(p),
    canReload: canReload(p),
    canSprint: canSprint(p),
    canSwitchWeapon: canSwitchWeapon(p),
    canLean: canLean(p),
    canCrouch: canCrouch(p),
    raiseT: sprintLock,
    adsT,
    // 滞空与翻越：HUD 用来压低准星提示，探针用来断言"跳起来打不准"。
    airborne: !!(p && p.airborne),
    vaulting: !!(p && p.vault),
    weaponId: w && w.def ? w.def.id : null,
    weaponClass: w && w.def ? weaponClassOf(w.def) : null,
  };
}

/* ---------------- 判定函数（执行侧唯一真值） ---------------- */

export function canFire(p) {
  if (!p || p.dead) return false;
  const w = p.currentWeapon;
  if (!w) return false;
  if (w.reloading) return false;
  if (Number(p.switchTimer) > 0) return false;
  // 冲刺退出后必须先把枪抬起来：这是「冲刺不能瞬间精准开火」的唯一实现点。
  if (Number(p.sprintLock) > 0) return false;
  if (p.vehicle) return false;
  // 翻越中双手都在撑箱子，打不了枪（也让"跳跃无敌帧+反杀"不成立）。
  if (p.vault) return false;
  return true;
}

export function canAim(p) {
  if (!p || p.dead || p.vehicle) return false;
  if (Number(p.switchTimer) > 0) return false;
  // 换弹中允许保持开镜视角，但不再继续拉近（由 player 侧的 adsT 目标控制）。
  return true;
}

export function canReload(p) {
  if (!p || p.dead || p.vehicle) return false;
  const w = p.currentWeapon;
  if (!w) return false;
  if (w.reloading) return false;
  if (Number(p.switchTimer) > 0) return false;
  return w.ammo < w.def.magSize;
}

export function canSprint(p) {
  if (!p || p.dead || p.busy || p.vehicle) return false;
  if (p.crouching) return false;
  if (p.prone) return false; // 卧倒必须先生起（起身还有 standLock 硬直）
  if (p.exhausted) return false;
  return true;
}

export function canSwitchWeapon(p) {
  if (!p || p.dead || p.vehicle) return false;
  return Number(p.switchTimer) <= 0;
}

export function canCrouch(p) {
  if (!p || p.dead || p.vehicle) return false;
  return true;
}

export function canLean(p) {
  if (!p || p.dead || p.vehicle || p.busy) return false;
  // 冲刺中不允许探头（指令书 MOVE-04），否则会造出贴墙高速平移的怪动作。
  if (p.sprinting) return false;
  // 趴着没有"探头"这个概念：卧倒的收益已经在散布与视距里给过了。
  if (p.prone) return false;
  return true;
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** 供 UI/调试：把状态码翻成中文短标签（不含逻辑判断）。 */
export const STATE_LABEL = {
  idle: '待机',
  walk: '慢走',
  jog: '移动',
  sprint: '冲刺',
  crouchMove: '蹲行',
  aimMove: '开镜移动',
  reloadMove: '换弹移动',
  stand: '站立',
  crouch: '蹲伏',
  prone: '卧倒',
  hip: '腰射',
  adsStart: '开镜中',
  adsFull: '已开镜',
  adsEnd: '收镜中',
  ready: '可开火',
  firing: '射击中',
  cooldown: '射速冷却',
  blocked: '动作锁定',
  none: '无',
  start: '起手',
  magOut: '退弹匣',
  magIn: '上弹匣',
  bolt: '拉栓',
  end: '收尾',
  unequip: '收枪',
  equip: '举枪',
  left: '左探头',
  right: '右探头',
};
