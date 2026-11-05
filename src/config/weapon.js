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
  // ⚠ 关键：weapon_arms.fbx 的枪身长轴沿模型 -Z，**不需要**绕 Y 旋转 180°。
  //    早期配置写死 Math.PI，实测枪口会横在屏幕右侧（枪身侧对镜头）。
  //    模型按「最长边 = view.scale」归一化，再叠加轻微俯仰/偏航/侧倾。
  view: {
    scale: 0.60,            // 归一化后的模型最长边（世界单位）
    position: { x: 0.185, y: -0.125, z: -0.47 },
    rotation: { x: 0.0, y: 0.05, z: 0.015 },
    // 沿模型自身轴微调，让握把落在 pivot 附近（否则枪托会顶出屏幕下沿）
    offset: { x: 0, y: 0, z: 0.13 },
  },
};

// 敌人参数（基础值；波次会在此基础上叠加倍率）
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
  deathBodyTime: 5.0,        // 尸体停留时间
  spawnPoints: [
    { x: -16, z: -11 },
    { x: 16, z: -11 },
    { x: -14, z: 8 },
    { x: 14, z: 8 },
    { x: -18, z: 4 },
    { x: 18, z: -4 },
    { x: 0, z: -13 },
    { x: 6, z: 12 },
  ],
  patrolPoints: [
    { x: -16, z: -11 }, { x: -4, z: -13 }, { x: 10, z: -12 },
    { x: 16, z: -11 }, { x: 17, z: 2 }, { x: 12, z: 9 },
    { x: 0, z: 6 }, { x: -12, z: 9 }, { x: -17, z: 2 }, { x: 0, z: 0 },
  ],
};

// 一局任务：三波敌人，清空即区域肃清
export const MATCH = {
  waves: [
    // total：本波总敌人数；alive：同时存活上限
    { total: 4, alive: 3, healthMul: 1.00, damageMul: 1.00, accuracyMul: 0.82, speedMul: 1.00 },
    { total: 5, alive: 3, healthMul: 1.10, damageMul: 1.10, accuracyMul: 0.95, speedMul: 1.04 },
    { total: 6, alive: 4, healthMul: 1.25, damageMul: 1.20, accuracyMul: 1.08, speedMul: 1.08 },
  ],
  breakTime: 5.0,        // 两波之间的休整时间（秒）
  spawnGap: 0.7,         // 同波内补位刷新的最小间隔
  minSpawnDist: 13,      // 出生点与玩家的最小距离
  fallbackSpawnDist: 8,  // 所有出生点都太近时的兜底距离
  waveClearAmmo: 60,     // 每波肃清补给：备弹
  waveClearArmor: 20,    // 每波肃清补给：护甲
  // 结算评级（分数阈值，从高到低匹配）
  grades: [
    { grade: 'S', min: 2000 },
    { grade: 'A', min: 1600 },
    { grade: 'B', min: 1200 },
    { grade: 'C', min: 0 },
  ],
};

// 地图参数
export const WORLD = {
  halfX: 22,
  halfZ: 16,
  wallHeight: 7.2,
  floorY: 0,
  fogColor: 0x1c242c,
  fogNear: 26,
  fogFar: 115,
};
