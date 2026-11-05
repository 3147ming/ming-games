/**
 * 全局数值配置（移植自仓库 Unity 脚本并针对网页手感调优）
 * 参考：MovementScript（重力 -19.8 / 跳跃高度 2.5 / 行走 6）
 *      GunSystem（弹匣 30 / 后坐力 / 换弹 3s）
 *      EnemyAiTutorial（100 HP / 视野 10 / 攻击间隔 2s）
 */

// 玩家参数
export const PLAYER = {
  maxHealth: 100,
  maxArmor: 50,
  eyeHeight: 1.62,        // 相机高度（脚底起算）
  radius: 0.34,           // 水平碰撞半径
  height: 1.75,           // 碰撞体高度
  walkSpeed: 5.4,         // 正常移动
  slowSpeed: 2.4,         // Shift 静步（需求：Shift 静步）
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
  armorReduction: 0.5,    // 护甲吸收伤害比例（CF 风格：有护甲时 50% 伤害由护甲承担）
  respawnDelay: 0.9,      // 死亡到可按 R 的间隔
  startPos: { x: 8, y: 0, z: 13 },  // 出生点：面向仓库内部的开阔区域，避免一出生就贴墙
  startYaw: 0,            // 初始朝向仓库内部（-Z 方向）
};

// M4A1 武器参数
export const WEAPON = {
  name: 'M4A1',
  magazineSize: 30,
  reserveAmmo: 120,
  fireInterval: 0.086,    // ≈ 700 RPM
  reloadTime: 2.15,
  damage: 24,
  headshotMultiplier: 2.0, // 爆头伤害倍率（CF 标准 ×2）
  limbMultiplier: 0.5,     // 四肢伤害倍率（CF 标准 ×0.5）
  // 护甲机制（CF 风格）：护甲优先承受伤害，护甲吸收伤害的固定比例
  armorReduction: 0.5,     // 有护甲时，50% 伤害由护甲吸收，剩余 50% 扣血
  armorCostPerDamage: 1.0, // 1 点护甲值吸收 1 点伤害（吸收量=伤害*armorReduction）
  // 换弹：空仓换弹比战术换弹略慢，且使用不同音效
  reloadTimeTactical: 2.15, // 弹匣内有子弹时的换弹时间
  reloadTimeEmpty: 2.55,    // 空仓换弹时间（需拉枪机）
  range: 90,
  // 散布（弧度）：静止 / 移动 / 连射累积
  spreadBase: 0.008,
  spreadMove: 0.022,
  spreadPerShot: 0.0035,
  spreadMax: 0.052,
  spreadRecover: 0.85,    // 每秒恢复量比例
  // 后坐力（相机角度增量，弧度）
  recoilPitch: 0.0125,
  recoilYaw: 0.0045,
  recoilRecover: 9.0,
  // 后坐力连射增幅：每发递增，第N发后坐力 = 基础值 * (1 + N * 0.06)，扫射时逐步变大
  recoilRamp: 0.06,
  recoilRampMax: 2.2,
  // 开火时的相机震动（随连射发数增强）
  shakePerShot: 0.0022,
  shakeMax: 0.012,
  // 换弹两段节奏：前半段掏弹匣，后半段插入弹匣
  reloadInsertRatio: 0.55,
  // 模型显示位置微调（本地坐标，挂在相机下）
  // 说明：arms@ak.fbx 的枪口朝模型 +Z，绕 Y 旋转 180° 后指向前方；
  //       再叠加轻微俯仰/侧倾，让枪身在屏幕右下角呈自然的斜持姿态。
  view: {
    scale: 1.0,
    position: { x: 0.20, y: -0.20, z: -0.60 },
    rotation: { x: -0.18, y: Math.PI, z: 0.06 },
  },
};

// 敌人参数
export const ENEMY = {
  maxHealth: 100,
  count: 4,
  sightRange: 34,         // 视野距离
  sightAngle: Math.cos(Math.PI / 3.2), // 约 ±56°
  attackRange: 24,        // 开火距离
  keepDistance: 8,        // 追击时保持距离
  patrolSpeed: 1.7,
  chaseSpeed: 3.9,
  turnSpeed: 8,
  radius: 0.4,
  height: 1.8,
  bodyHeight: 0.95,       // 身体命中球中心高度
  bodyRadius: 0.42,
  headHeight: 1.66,
  headRadius: 0.22,
  damage: 9,
  fireInterval: 0.85,
  fireIntervalNear: 0.42,    // 近距离连射间隔
  fireIntervalFar: 1.0,      // 远距离点射间隔
  burstNear: 4,              // 近距离一次连射发数
  burstFar: 2,               // 远距离一次点射发数
  magazineSize: 6,           // 敌人弹匣，打空需要换弹
  reloadTime: 2.4,           // 敌人换弹耗时
  accuracy: 0.72,            // 基础命中率（随距离下降）
  accuracyMin: 0.12,         // 远距离最低命中率
  accuracyRange: 40,         // 命中率为 0 的距离
  alertTime: 4.0,            // 失去视野后的警戒搜索时间
  flinchTime: 0.22,          // 受击抖动时间
  respawnMin: 3.0,           // 死亡后随机刷新最短时间（CF 人机 3~6 秒）
  respawnMax: 6.0,           // 死亡后随机刷新最长时间
  deathBodyTime: 5.0,        // 尸体停留时间
  spawnPoints: [
    { x: -16, z: -11 },
    { x: 16, z: -11 },
    { x: -14, z: 8 },
    { x: 14, z: 8 },
  ],
  patrolPoints: [
    { x: -16, z: -11 }, { x: -4, z: -13 }, { x: 10, z: -12 },
    { x: 16, z: -11 }, { x: 17, z: 2 }, { x: 12, z: 9 },
    { x: 0, z: 6 }, { x: -12, z: 9 }, { x: -17, z: 2 }, { x: 0, z: 0 },
  ],
};

// 地图参数
export const WORLD = {
  halfX: 22,
  halfZ: 16,
  wallHeight: 7.2,
  floorY: 0,
  fogColor: 0x2b333c,
  fogNear: 14,
  fogFar: 90,
};
