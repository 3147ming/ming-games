/**
 * 全局数值配置（v0.3 丧尸生存改造）
 *
 * 与 v0.2 的差异：
 *  - 敌人改为丧尸：普通丧尸只会近战扑咬，**不使用任何枪械**；
 *    另有「吐酸丧尸」进行远程喷吐（非枪械弹道），构成远程威胁。
 *  - 地图改为非封闭式露天货场：无天花板、可见天空，围栏/断墙只做视觉边界，
 *    碰撞边界仍由隐形墙保证玩家与丧尸不出界。
 *  - 新增 SUPPLY 补给点：弹药箱 / 医疗包 / 护甲板 / 综合物资箱，靠近自动拾取，
 *    拾取后进入冷却轮换刷新。
 */

// 玩家参数
export const PLAYER = {
  maxHealth: 100,
  maxArmor: 50,
  eyeHeight: 1.62,        // 相机高度（脚底起算）
  radius: 0.34,           // 水平碰撞半径
  height: 1.75,           // 碰撞体高度
  walkSpeed: 5.4,         // 正常移动
  slowSpeed: 2.4,         // Shift 静步
  crouchSpeed: 2.6,       // Ctrl 蹲伏移动速度
  crouchEyeHeight: 1.05,  // 蹲伏时相机高度
  crouchHeight: 1.15,     // 蹲伏时碰撞体高度
  jumpSpeed: 5.8,
  gravity: -19.0,
  accel: 14.0,            // 地面加速度（越大越跟手）
  airAccel: 3.0,
  friction: 11.0,
  mouseSensitivity: 0.0022,
  hitSlowTime: 0.45,      // 受击僵直持续时间
  hitSlowFactor: 0.45,    // 受击时移动速度倍率
  armorReduction: 0.5,    // 护甲吸收伤害比例
  respawnDelay: 0.9,
  startPos: { x: 8, y: 0, z: 15 },  // 出生点：货场南侧空地
  startYaw: 0,
};

// 玩家武器参数（对抗丧尸仍用枪械）
export const WEAPON = {
  name: 'M4A1',
  magazineSize: 30,
  reserveAmmo: 120,
  fireInterval: 0.086,    // ≈ 700 RPM
  reloadTime: 2.15,
  damage: 24,
  headshotMultiplier: 2.0,
  limbMultiplier: 0.5,
  armorReduction: 0.5,
  armorCostPerDamage: 1.0,
  reloadTimeTactical: 2.15,
  reloadTimeEmpty: 2.55,
  range: 90,
  spreadBase: 0.008,
  spreadMove: 0.022,
  spreadPerShot: 0.0035,
  spreadMax: 0.052,
  spreadRecover: 0.85,
  recoilPitch: 0.0125,
  recoilYaw: 0.0045,
  recoilRecover: 9.0,
  recoilRamp: 0.06,
  recoilRampMax: 2.2,
  shakePerShot: 0.0022,
  shakeMax: 0.012,
  reloadInsertRatio: 0.55,
  view: {
    scale: 0.60,
    position: { x: 0.185, y: -0.125, z: -0.47 },
    rotation: { x: 0.0, y: 0.05, z: 0.015 },
    offset: { x: 0, y: 0, z: 0.13 },
  },
};

// ---------------- 丧尸（敌人） ----------------
// 铁律：普通丧尸（walker / brute）只有近战，**没有任何枪械参数**。
//      远程威胁只来自「吐酸丧尸」的喷吐（非枪械），单独走 spit 通道。
export const ENEMY = {
  sightRange: 34,         // 视野距离
  sightAngle: Math.cos(Math.PI / 3.2), // 约 ±56°
  alertTime: 5.0,         // 失去视野后的警戒搜索时间
  flinchTime: 0.22,       // 受击抖动时间
  deathBodyTime: 5.0,     // 尸体停留时间
  turnSpeed: 8,
  radius: 0.4,
  height: 1.8,
  bodyHeight: 0.95,       // 身体命中球中心高度
  bodyRadius: 0.42,
  headHeight: 1.66,
  headRadius: 0.22,

  // 丧尸变体
  types: {
    // 普通丧尸：缓慢逼近，近战扑咬
    walker: {
      id: 'walker',
      name: '普通丧尸',
      maxHealth: 90,
      patrolSpeed: 1.5,
      chaseSpeed: 3.5,
      damage: 11,           // 爪击/撕咬
      attackRange: 2.35,    // 近战触及距离
      attackInterval: 1.15, // 两次攻击间隔
      windup: 0.38,         // 抬手到判定的前摇
      keepDistance: 1.35,
      melee: true,
      scaleMul: 1.0,
      tint: 0x9aa878,
    },
    // 吐酸丧尸：中距离喷吐酸液（非枪械）
    spitter: {
      id: 'spitter',
      name: '吐酸丧尸',
      maxHealth: 70,
      patrolSpeed: 1.3,
      chaseSpeed: 2.8,
      damage: 8,
      attackRange: 17,
      attackInterval: 2.1,
      keepDistance: 8.5,
      accuracy: 0.55,
      accuracyMin: 0.15,
      accuracyRange: 30,
      melee: false,
      scaleMul: 0.94,
      tint: 0xaec24e,
    },
    // 重锤丧尸：慢但耐打，近战重击
    brute: {
      id: 'brute',
      name: '重锤丧尸',
      maxHealth: 220,
      patrolSpeed: 1.15,
      chaseSpeed: 2.45,
      damage: 22,
      attackRange: 2.6,
      attackInterval: 1.75,
      windup: 0.55,
      keepDistance: 1.6,
      melee: true,
      scaleMul: 1.18,
      tint: 0x8a6a52,
    },
  },

  spawnPoints: [
    { x: -20, z: -14 },
    { x: 20, z: -14 },
    { x: -22, z: 10 },
    { x: 22, z: 10 },
    { x: -16, z: -20 },
    { x: 16, z: -20 },
    { x: 0, z: -18 },
    { x: -24, z: -2 },
    { x: 24, z: -2 },
    { x: 8, z: 18 },
  ],
  patrolPoints: [
    { x: -20, z: -14 }, { x: -8, z: -17 }, { x: 8, z: -16 },
    { x: 20, z: -14 }, { x: 21, z: 2 }, { x: 14, z: 12 },
    { x: 0, z: 8 }, { x: -14, z: 12 }, { x: -21, z: 2 }, { x: 0, z: -6 },
    { x: -10, z: 16 }, { x: 10, z: 16 },
  ],
};

// 一局任务：三波尸潮，清空即区域肃清
export const MATCH = {
  waves: [
    // total：本波总数；alive：同时存活上限；mix：变体配额
    {
      total: 6, alive: 4, mix: { walker: 6 },
      healthMul: 1.00, damageMul: 1.00, accuracyMul: 0.85, speedMul: 1.00,
    },
    {
      total: 8, alive: 5, mix: { walker: 6, spitter: 2 },
      healthMul: 1.10, damageMul: 1.05, accuracyMul: 1.00, speedMul: 1.05,
    },
    {
      total: 10, alive: 6, mix: { walker: 7, spitter: 2, brute: 1 },
      healthMul: 1.22, damageMul: 1.15, accuracyMul: 1.10, speedMul: 1.08,
    },
  ],
  breakTime: 5.0,        // 两波之间的休整时间（秒）
  spawnGap: 0.7,         // 同波内补位刷新的最小间隔
  minSpawnDist: 13,      // 出生点与玩家的最小距离
  fallbackSpawnDist: 8,  // 所有出生点都太近时的兜底距离
  waveClearAmmo: 60,     // 每波肃清补给：备弹
  waveClearArmor: 20,    // 每波肃清补给：护甲
  grades: [
    { grade: 'S', min: 2400 },
    { grade: 'A', min: 1900 },
    { grade: 'B', min: 1400 },
    { grade: 'C', min: 0 },
  ],
};

// ---------------- 补给点（资源点 / 弹药 / 物资） ----------------
export const SUPPLY = {
  pickupRadius: 1.7,     // 靠近自动拾取的半径
  respawnSec: 24,        // 被拾取后重新刷新的时间
  types: {
    ammo:  { label: '弹药箱', hint: '+90 发备弹',   ammo: 90,  heal: 0,  armor: 0,  color: 0x4f7a3a },
    med:   { label: '医疗包', hint: '+45 生命',     ammo: 0,   heal: 45, armor: 0,  color: 0xb43a34 },
    armor: { label: '护甲板', hint: '+35 护甲',     ammo: 0,   heal: 0,  armor: 35, color: 0x3a5fb4 },
    cache: { label: '物资箱', hint: '+60 弹药 +30 生命 +25 护甲', ammo: 60, heal: 30, armor: 25, color: 0xb8862e },
  },
  // 地图上的补给点位（露天货场坐标）
  points: [
    { type: 'ammo',  x: -16, z: -10 },
    { type: 'ammo',  x: 14,  z: -12 },
    { type: 'ammo',  x: -2,  z: 12 },
    { type: 'med',   x: -20, z: 6 },
    { type: 'med',   x: 18,  z: 4 },
    { type: 'armor', x: -8,  z: -2 },
    { type: 'armor', x: 10,  z: 14 },
    { type: 'cache', x: 0,   z: -8 },
    { type: 'cache', x: -22, z: -18 },
    { type: 'cache', x: 22,  z: -18 },
  ],
};

// 地图参数（非封闭式露天货场）
export const WORLD = {
  halfX: 28,
  halfZ: 22,
  wallHeight: 7.2,        // 隐形边界高度（防止跳出地图）
  fenceHeight: 1.55,      // 视觉围栏高度（远低于墙，天空可见 = 非封闭）
  floorY: 0,
  skyTop: 0x5f92cf,
  skyBottom: 0xd7e4ee,
  fogColor: 0xb9c9d6,
  fogNear: 46,
  fogFar: 175,
};
