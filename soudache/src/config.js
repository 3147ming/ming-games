/**
 * 全局数值配置（纯数据模块）
 *
 * 约束：本文件不得引用 DOM / Canvas / localStorage，必须可在 Node 22 下被直接 import 做单元测试。
 * 所有战斗、经济、地图、AI 的可调数值都集中在此处，便于平衡性调整。
 */

/* ============================== 地图 ============================== */

export const TILE = 40;
export const MAP_COLS = 60;
export const MAP_ROWS = 45;
export const WORLD_W = TILE * MAP_COLS; // 2400
export const WORLD_H = TILE * MAP_ROWS; // 1800

/** 网格取值：0=地面, 1=墙体, 2=掩体箱 */
export const CELL = { FLOOR: 0, WALL: 1, CRATE: 2 };

/** 掩体箱（可被射击破坏）：每个合并后的 rect 有独立血量，越大越耐打 */
export const CRATE = {
  maxHp: 48, // 1×1 掩体箱基础血量（步枪约 2 发击碎）
  hpPerTile: 18, // 每多覆盖 1 格额外血量（2×2 箱子明显更扛揍）
};

/* ============================== 战局 ============================== */

export const MATCH = {
  duration: 480, // 单局 8 分钟
  warnTime: 120, // 剩余 2 分钟计时转红（紧迫提示）
  extractChannel: 3, // 撤离读条 3 秒（站定不动即可撤离）
  extractTotal: 2, // 地图上的撤离点总数（固定 2 个）
  extractOpenAt: 120, // 仅最后 2 分钟开放撤离通道（站定撤离的窗口）
  extractRadius: 64,
  interactRange: 56,
  itemPickupRange: 38, // 地面掉落物的拾取距离（比容器/终端更近，避免误触）
  enemyCountMin: 8,
  enemyCountMax: 11,
  eliteChance: 0.26,
  // --- POI 目标点 ---
  terminalCount: 3, // 每局数据终端数量（破解给评分 + 情报费）
  terminalHackTime: 3.5, // 破解读条秒数
  airdropDelay: 95, // 开局多少秒后空投着陆
  // --- 撤离点机制 ---
  extractFee: 800, // 付费撤离点手续费
  guardLeash: 150, // 守点敌人离撤离点超过该距离会被拉回
  contractCount: 3, // 每局随机抽取的局内合约条数
  platformCount: 3, // 每局架高平台数量上限（占高地：抬高视点 + 越过掩体观察）
};

/* ============================== 玩家 ============================== */

export const PLAYER = {
  radius: 12,
  maxHp: 100,
  maxStamina: 100,
  speed: 196,
  sprintMul: 1.5,
  crouchMul: 0.55,
  staminaSprintDrain: 24,
  staminaRegen: 18,
  staminaRegenDelay: 0.8,
  // 负重上限 = 基础 20kg + 护甲加成（二级 +3kg / 三级 +6kg，见 weightLimitFor）。
  // 带上限内的重量不产生任何惩罚；超重后进入"硬性超重"：减速 + 禁奔跑。
  // weightLimit 保留为"无甲基准值"，供不关心护甲的调用点（UI 进度条分母等）直接使用。
  weightLimit: 20,
  weightBaseLimit: 20,
  weightArmorBonus: { none: 0, lv2: 3, lv3: 6 },
  // 硬性超重：移速与体力恢复都按超重比例线性下降，各自触底后不再下降。
  // 超重即禁跑（见 player.js overweight），因此"减速 50% + 无法奔跑"是同一件事的两面。
  weightOverSpeedFloor: 0.5, // 移速下限（两倍超重时触底 = 减速 50%）
  weightOverStaminaFloor: 0.4, // 体力恢复下限（比移速更早触底：体力是逃命的底线）
  staminaExhaustSpeedMul: 0.55, // 疲惫时移速倍率（体力耗尽后）
  staminaExhaustRecovery: 0.3, // 体力恢复到该比例（maxStamina）才解除疲惫
  noiseCrouch: 70,
  noiseWalk: 150,
  noiseSprint: 340,
  backpack: { cols: 5, rows: 6 },
  stash: { cols: 10, rows: 8 },
};

export const BACKPACK = PLAYER.backpack;
export const STASH_SIZE = PLAYER.stash;

/* ============================== 稀有度 ============================== */

export const RARITY = {
  common: { id: 'common', name: '普通', color: '#9aa7b8', weight: 1 },
  rare: { id: 'rare', name: '稀有', color: '#4fa3ff', weight: 1 },
  epic: { id: 'epic', name: '史诗', color: '#b45cff', weight: 1 },
  legendary: { id: 'legendary', name: '传说', color: '#ffb020', weight: 1 },
};

export const RARITY_ORDER = ['common', 'rare', 'epic', 'legendary'];

/* ============================== 武器 ============================== */

/**
 * 武器定义。
 * spread：首发扩散（弧度）；spreadPerShot：每发累积；spreadMax：扩散上限。
 */
export const WEAPONS = {
  rifle: {
    id: 'rifle',
    name: 'M4A1 突击步枪',
    short: 'AR',
    category: 'weapon',
    rarity: 'epic',
    auto: true,
    damage: 27,
    rpm: 640,
    magSize: 30,
    reloadTime: 2.6,
    spread: 0.012,
    spreadPerShot: 0.010,
    spreadMax: 0.055,
    recoil: 0.018,
    range: 820,
    noiseRadius: 520,
    ammoItem: 'ammo556',
    ammoType: '5.56mm',
    value: 5200,
    weight: 3.8,
    size: { w: 4, h: 2 },
    icon: 'wpn_rifle',
    desc: '全自动突击步枪，威力与射速均衡，中近距离压制力极强。',
  },
  smg: {
    id: 'smg',
    name: 'MP5 冲锋枪',
    short: 'SMG',
    category: 'weapon',
    rarity: 'rare',
    auto: true,
    damage: 19,
    rpm: 820,
    magSize: 25,
    reloadTime: 2.0,
    spread: 0.016,
    spreadPerShot: 0.009,
    spreadMax: 0.07,
    recoil: 0.014,
    range: 520,
    noiseRadius: 470,
    ammoItem: 'ammo9mm',
    ammoType: '9mm',
    value: 3800,
    weight: 2.9,
    size: { w: 3, h: 2 },
    icon: 'wpn_smg',
    desc: '高射速低后坐，适合室内近战，远距离衰减明显。',
  },
  pistol: {
    id: 'pistol',
    name: 'G17 手枪',
    short: 'PST',
    category: 'weapon',
    rarity: 'common',
    auto: false,
    damage: 22,
    rpm: 420,
    magSize: 12,
    reloadTime: 1.7,
    spread: 0.010,
    spreadPerShot: 0.012,
    spreadMax: 0.05,
    recoil: 0.02,
    range: 420,
    noiseRadius: 380,
    ammoItem: 'ammo9mm',
    ammoType: '9mm',
    value: 1200,
    weight: 1.2,
    size: { w: 2, h: 1 },
    icon: 'wpn_pistol',
    desc: '半自动手枪，可靠的副武器，弹药便宜、噪音低。',
  },
};

export const WEAPON_IDS = ['rifle', 'smg', 'pistol'];

/* ============================== 护甲 ============================== */

export const ARMORS = {
  none: {
    id: 'none',
    name: '无护甲',
    category: 'armor',
    rarity: 'common',
    armor: 0,
    weight: 0,
    value: 0,
    size: { w: 1, h: 1 },
    icon: 'armor',
    desc: '没有任何防护，移动最快，但一发都可能致命。',
  },
  lv2: {
    id: 'lv2',
    name: '二级防弹衣',
    category: 'armor',
    rarity: 'rare',
    armor: 45,
    weight: 5.0,
    value: 3200,
    size: { w: 2, h: 2 },
    icon: 'armor',
    desc: '陶瓷插板，可抵御手枪与冲锋枪弹，重量适中。',
  },
  lv3: {
    id: 'lv3',
    name: '三级防弹衣',
    category: 'armor',
    rarity: 'epic',
    armor: 75,
    weight: 7.5,
    value: 7800,
    size: { w: 2, h: 2 },
    icon: 'armor',
    desc: '重型复合装甲，能硬抗步枪数发，代价是明显更重。',
  },
};

export const ARMOR_IDS = ['none', 'lv2', 'lv3'];

/* ============================== 物品 ============================== */

export const AMMO_STACK = 60;

/**
 * ITEMS：所有可出现在仓库 / 商店 / 战利品中的物品定义。
 * category: material | consumable | ammo | weapon | armor | valuable
 */
export const ITEMS = {
  /* --- 材料 --- */
  bolt: {
    id: 'bolt', name: '螺栓螺母', category: 'material', rarity: 'common',
    value: 90, weight: 0.4, size: { w: 1, h: 1 }, icon: 'bolt',
    desc: '随处可见的工业零件，胜在稳定。',
  },
  parts: {
    id: 'parts', name: '武器零件', category: 'material', rarity: 'common',
    value: 150, weight: 0.7, size: { w: 1, h: 1 }, icon: 'parts',
    desc: '枪机与导轨散件，军械商愿意收。',
  },
  wire: {
    id: 'wire', name: '铜线束', category: 'material', rarity: 'common',
    value: 110, weight: 0.3, size: { w: 1, h: 1 }, icon: 'wire',
    desc: '一捆剥好的铜线，按重量卖。',
  },
  fuel: {
    id: 'fuel', name: '燃料罐', category: 'material', rarity: 'common',
    value: 230, weight: 1.3, size: { w: 1, h: 1 }, icon: 'fuel',
    desc: '密封良好的军用燃料，占地方但值钱。',
  },
  battery: {
    id: 'battery', name: '军用电池', category: 'material', rarity: 'common',
    value: 270, weight: 0.8, size: { w: 1, h: 1 }, icon: 'battery',
    desc: '夜视仪与通讯设备的心脏。',
  },

  /* --- 消耗品 --- */
  medkit: {
    id: 'medkit', name: '医疗包', category: 'consumable', rarity: 'common',
    value: 420, weight: 0.7, size: { w: 1, h: 1 }, icon: 'medkit',
    heal: 55, useTime: 3.0,
    desc: '按 Q 使用，3 秒读条恢复 55 点生命。',
  },
  bandage: {
    id: 'bandage', name: '绷带', category: 'consumable', rarity: 'common',
    value: 180, weight: 0.3, size: { w: 1, h: 1 }, icon: 'bandage',
    heal: 24, useTime: 1.6,
    desc: '按 Q 使用，1.6 秒快速止血，恢复 24 点生命。',
  },
  pill: {
    id: 'pill', name: '止痛药', category: 'consumable', rarity: 'common',
    value: 260, weight: 0.2, size: { w: 1, h: 1 }, icon: 'pill',
    heal: 10, useTime: 1.2, stamina: 60,
    desc: '按 Q 使用，恢复体力并小幅回血。',
  },

  /* --- 弹药 --- */
  ammo556: {
    id: 'ammo556', name: '5.56mm 弹药', category: 'ammo', rarity: 'common',
    value: 600, weight: 1.0, size: { w: 1, h: 1 }, icon: 'ammo',
    stack: AMMO_STACK, ammoQty: AMMO_STACK,
    desc: `一盒 ${AMMO_STACK} 发步枪弹。手枪与冲锋枪不通用。`,
  },
  ammo9mm: {
    id: 'ammo9mm', name: '9mm 弹药', category: 'ammo', rarity: 'common',
    value: 420, weight: 0.8, size: { w: 1, h: 1 }, icon: 'ammo',
    stack: AMMO_STACK, ammoQty: AMMO_STACK,
    desc: `一盒 ${AMMO_STACK} 发手枪弹，冲锋枪同样适用。`,
  },

  /* --- 高价值物资 --- */
  chip: {
    id: 'chip', name: '加密芯片', category: 'valuable', rarity: 'rare',
    value: 980, weight: 0.2, size: { w: 1, h: 1 }, icon: 'chip',
    desc: '制导模块核心，黑市硬通货。',
  },
  watch: {
    id: 'watch', name: '军用手表', category: 'valuable', rarity: 'rare',
    value: 1350, weight: 0.3, size: { w: 1, h: 1 }, icon: 'watch',
    desc: '军官配发款，转手溢价很高。',
  },
  doc: {
    id: 'doc', name: '情报文件', category: 'valuable', rarity: 'rare',
    value: 1100, weight: 0.2, size: { w: 1, h: 1 }, icon: 'doc',
    desc: '一叠标着密级的文件，买家不问出处。',
  },
  optic: {
    id: 'optic', name: '突击瞄准镜', category: 'valuable', rarity: 'epic',
    value: 2400, weight: 0.9, size: { w: 2, h: 1 }, icon: 'optic',
    desc: '1-6 倍可变倍瞄具，配件中的抢手货。',
  },
  suppressor: {
    id: 'suppressor', name: '消音器', category: 'valuable', rarity: 'epic',
    value: 2800, weight: 1.1, size: { w: 2, h: 1 }, icon: 'suppressor',
    desc: '军规级消音器，收藏价值远高于实用价值。',
  },
  gold: {
    id: 'gold', name: '金条', category: 'valuable', rarity: 'epic',
    value: 3400, weight: 1.6, size: { w: 2, h: 1 }, icon: 'gold',
    desc: '沉甸甸的一根，重，但是真的值钱。',
  },
  keycard: {
    id: 'keycard', name: '实验室门卡', category: 'valuable', rarity: 'legendary',
    value: 7200, weight: 0.1, size: { w: 1, h: 1 }, icon: 'keycard',
    desc: '本局最贵的一件东西，几乎不占重量。',
  },

  /* --- 武器（由 WEAPONS 展开） --- */
  rifle: { ...WEAPONS.rifle },
  smg: { ...WEAPONS.smg },
  pistol: { ...WEAPONS.pistol },

  /* --- 护甲 --- */
  lv2: { ...ARMORS.lv2 },
  lv3: { ...ARMORS.lv3 },
};

export const ITEM_IDS = Object.keys(ITEMS);

/** 按稀有度分组的物品 id（供战利品表使用） */
export const ITEMS_BY_RARITY = RARITY_ORDER.reduce((acc, r) => {
  acc[r] = ITEM_IDS.filter((id) => ITEMS[id].rarity === r);
  return acc;
}, {});

/* ============================== 容器 ============================== */

/**
 * 容器定义：searchTime=搜索读条秒数，rolls=[最少,最多] 产出件数，
 * rarityWeights=稀有度权重，categoryBias=品类加权倍数。
 */
export const CONTAINERS = {
  drawer: {
    id: 'drawer', name: '抽屉', searchTime: 1.6, rolls: [2, 3],
    rarityWeights: { common: 78, rare: 20, epic: 2, legendary: 0 },
    categoryBias: {}, radius: 16, color: '#6b7688',
    desc: '办公桌抽屉，出些零碎。',
  },
  crate: {
    id: 'crate', name: '补给箱', searchTime: 2.3, rolls: [2, 4],
    rarityWeights: { common: 62, rare: 30, epic: 8, legendary: 0 },
    categoryBias: { material: 1.4 }, radius: 20, color: '#7a6a4a',
    desc: '军用补给箱，材料为主。',
  },
  weaponbox: {
    id: 'weaponbox', name: '武器箱', searchTime: 2.9, rolls: [2, 3],
    rarityWeights: { common: 40, rare: 40, epic: 18, legendary: 2 },
    categoryBias: { weapon: 4, ammo: 3, armor: 2 }, radius: 22, color: '#4a6a5a',
    desc: '长条武器箱，大概率出枪械与弹药。',
  },
  safe: {
    id: 'safe', name: '保险箱', searchTime: 4.6, rolls: [3, 4],
    rarityWeights: { common: 15, rare: 38, epic: 34, legendary: 13 },
    categoryBias: { valuable: 2.2 }, radius: 18, color: '#7a5a3a',
    desc: '需要长时间开锁，高风险高回报。',
  },
  body: {
    id: 'body', name: '尸体', searchTime: 1.8, rolls: [1, 3],
    rarityWeights: { common: 70, rare: 25, epic: 5, legendary: 0 },
    categoryBias: { ammo: 2, consumable: 1.6 }, radius: 16, color: '#6a4a4a',
    desc: '倒下的人身上总有点东西。',
  },
  // 空投：局中限时着陆，高稀有度（不走 CONTAINER_SPAWN_WEIGHTS，不在房间内生成）
  airdrop: {
    id: 'airdrop', name: '空投补给', searchTime: 2.4, rolls: [3, 4],
    rarityWeights: { common: 8, rare: 30, epic: 42, legendary: 20 },
    categoryBias: { weapon: 3, armor: 2, valuable: 1.5, ammo: 2 }, radius: 22, color: '#ffb020',
    desc: '从天而降的高级补给，人人都要抢。',
  },
};

/** POI 目标点配置（数据终端 / 空投） */
export const POI = {
  terminalReward: 500, // 破解成功立即入账的情报费
  terminalRadius: 22, // 交互半径
  airdropRadius: 24,
};

/**
 * 局内合约：每局随机抽取若干条，达成即入账奖励与评分。
 * type 决定进度来源：kill=击杀数 / terminal=破解终端数 / search=搜刮容器数 / extractValue=带出估值。
 * target 为 [下限, 上限]，开局时在此区间随机取整数；desc 里的 {n} 会被替换成实际目标值。
 */
export const CONTRACTS = [
  {
    id: 'clear', name: '肃清行动', type: 'kill',
    desc: '击杀 {n} 名敌对人员', target: [3, 6], reward: 900, score: 220,
  },
  {
    id: 'intel', name: '情报收集', type: 'terminal',
    desc: '破解 {n} 个数据终端', target: [1, 2], reward: 700, score: 180,
  },
  {
    id: 'scavenge', name: '物资搜刮', type: 'search',
    desc: '搜刮 {n} 个容器', target: [4, 8], reward: 600, score: 150,
  },
  {
    id: 'haul', name: '高价值撤离', type: 'extractValue',
    desc: '带出估值不低于 ¥{n} 的物资', target: [6000, 12000], reward: 0, score: 260,
  },
  {
    id: 'demolition', name: '爆破作业', type: 'demolish',
    desc: '摧毁 {n} 个掩体箱', target: [2, 5], reward: 650, score: 150,
  },
  {
    id: 'survival', name: '死守待援', type: 'survival',
    desc: '存活满 {n} 秒', target: [180, 300], reward: 500, score: 120,
  },
];

export const CONTAINER_IDS = Object.keys(CONTAINERS);

/** 地图生成时容器的类型权重 */
export const CONTAINER_SPAWN_WEIGHTS = {
  drawer: 34, crate: 26, weaponbox: 17, safe: 11, body: 12,
};

/* ============================== 敌人 ============================== */

export const ENEMY_TYPES = {
  patrol: {
    id: 'patrol',
    name: '巡逻兵',
    hp: 100,
    armor: 15,
    speed: 112,
    radius: 11,
    color: '#d2603f',
    weapon: {
      id: 'enemy_ar', name: 'AK-74N', auto: true,
      damage: 8, rpm: 300, magSize: 20, reloadTime: 2.8,
      spread: 0.022, spreadPerShot: 0.012, spreadMax: 0.12, recoil: 0.024,
      range: 540, noiseRadius: 520, ammoItem: 'ammo556',
    },
    visionRange: 300,
    visionAngle: (72 * Math.PI) / 180, // 全锥角
    hearing: 360,
    reactionTime: 0.7, // 发现目标后开火前的犹豫时间
    accuracy: 0.42,
    fireDelay: [1.0, 2.1], // 两次点射之间的间隔
    burst: [2, 3],
    preferredRange: 260,
    score: 60,
    lootBonus: 1,
  },
  elite: {
    id: 'elite',
    name: '精英守卫',
    hp: 165,
    armor: 50,
    speed: 126,
    radius: 12,
    color: '#c0392b',
    weapon: {
      id: 'enemy_mdr', name: 'MDR 精确射手步枪', auto: true,
      damage: 11, rpm: 420, magSize: 25, reloadTime: 2.4,
      spread: 0.014, spreadPerShot: 0.009, spreadMax: 0.085, recoil: 0.018,
      range: 660, noiseRadius: 560, ammoItem: 'ammo556',
    },
    visionRange: 380,
    visionAngle: (86 * Math.PI) / 180,
    hearing: 430,
    reactionTime: 0.4,
    accuracy: 0.62,
    fireDelay: [0.7, 1.4],
    burst: [3, 4],
    preferredRange: 300,
    score: 150,
    lootBonus: 1.8,
  },
  marksman: {
    id: 'marksman',
    name: '精确射手',
    hp: 85, // 脆
    armor: 10,
    speed: 96, // 慢
    radius: 11,
    color: '#7B68A6',
    weapon: {
      id: 'enemy_dmr', name: 'SVD 精确射手步枪', auto: false,
      damage: 26, rpm: 55, magSize: 5, reloadTime: 3.4,
      spread: 0.004, spreadPerShot: 0.006, spreadMax: 0.02, recoil: 0.05,
      range: 900, noiseRadius: 700, ammoItem: 'ammo556',
    },
    visionRange: 460, // 视野最远，能在你看见他之前先发现你
    visionAngle: (64 * Math.PI) / 180, // 但视野更窄（专注正前方）
    hearing: 300,
    reactionTime: 1.1, // 要瞄准，开火前犹豫更久
    accuracy: 0.85, // 但极准
    fireDelay: [1.8, 3.0],
    burst: [1, 1], // 单发点射
    preferredRange: 520, // 远程吊射：会主动拉开距离
    holdsPosition: true, // 进入理想射距后原地架枪，不做横向走位
    score: 130,
    lootBonus: 1.6,
  },
  rusher: {
    id: 'rusher',
    name: '冲锋兵',
    hp: 80, // 脆
    armor: 5,
    speed: 168, // 最快
    radius: 10,
    color: '#E08A3C',
    weapon: {
      id: 'enemy_smg', name: 'PP-19 冲锋枪', auto: true,
      damage: 7, rpm: 900, magSize: 30, reloadTime: 2.2,
      spread: 0.030, spreadPerShot: 0.016, spreadMax: 0.16, recoil: 0.012,
      range: 340, noiseRadius: 430, ammoItem: 'ammo9mm',
    },
    visionRange: 260,
    visionAngle: (84 * Math.PI) / 180,
    hearing: 400,
    reactionTime: 0.35, // 反应最快
    accuracy: 0.30, // 但打得不准，靠弹量压制
    fireDelay: [0.5, 1.0],
    burst: [4, 6], // 长点射
    preferredRange: 90, // 贴脸：会一路冲到你面前
    score: 70,
    lootBonus: 1.1,
  },
};

/**
 * 机动载具：地图上的越野车，用于快速转移。
 * 设计取舍：速度远高于冲刺，但**噪音极大**（持续暴露位置），是一个明确的"快但招摇"选项。
 * 为避免引入完整载具物理，采用简化模型：油门 / 刹车 + 转向率，直接吃玩家移动碰撞。
 */
export const VEHICLE = {
  enabled: true,
  count: [1, 2], // 每局载具数量区间
  maxSpeed: 620, // 最高速（逻辑单位/秒，约 2.1× 冲刺）
  accel: 520, // 加速度
  brake: 900, // 刹车 / 倒车的减速度
  drag: 260, // 松油门的自然减速
  reverseMul: 0.45, // 倒车最高速系数
  turnRate: 1.9, // 转向角速度（弧度/秒），随速度略降
  radius: 26, // 碰撞半径（比玩家大，过不去窄巷）
  eyeHeight: 2.15, // 驾驶时的眼高（米）
  enterRange: 70, // 上车交互距离
  noiseRadius: 620, // 行驶噪音半径（远大于脚步，会持续招怪）
  exitCooldown: 0.6, // 下车后的冷却，防止瞬间上下车刷点
  fovBoost: 8, // 高速时的额外 FOV（速度感）
};

/**
 * 绳索速降：站在架高平台上朝外抛绳，快速滑降到地面。
 * 设计要点：平台格本身仍是可通行地面（高程只是附加属性），所以"走下去"并没有代价 ——
 * 速降的价值来自 **爆发位移 + 难以命中**，是一个真正的脱战 / 换位工具，而不是换个下楼动画。
 */
export const ROPE = {
  enabled: true,
  reach: 8, // 抛出后的水平位移（米）
  duration: 0.7, // 下滑耗时（秒）
  cooldown: 1.4, // 落地后的冷却
  minDrop: 0.5, // 起终点最小高差（米），平地没意义
  staminaCost: 6, // 体力消耗
  landNoise: 1.15, // 落地噪音系数（比脚步响，是个可被听见的战术动作）
  evadeMul: 0.55, // 下滑中敌人对你的命中率系数（<1 = 更难打中）
};

/**
 * AI 战术行为参数（抢占高地 / 破坏掩体）。
 * 这两个行为都只在 COMBAT 状态下触发，且都有冷却，避免 AI 来回拉扯或无脑扫射。
 */
export const AI = {
  highGround: {
    enabled: true,
    maxDist: 420, // 愿意为抢高地跑的最大距离
    arriveDist: 26, // 判定"已上平台"的半径
    travelTime: 9, // 单次抢占的最长移动时间，超时放弃
    cooldown: 14, // 抢占结束后的冷却，避免反复上下
    holdWeight: 0.5, // 评分里"自己到平台距离"的权重（越低越敢跑远）
  },
  breach: {
    enabled: true,
    lostTime: 1.5, // 确认被箱子挡住后，先忍这么久再开打（给玩家反应时间）
    fireDelay: 0.55, // 打箱子的射击间隔（比正常点射慢，是"拆"不是"扫"）
    maxDist: 520,
    damageScale: 1.0, // 对掩体箱的伤害系数
    ammoPerShot: 1,
  },
};

/** 地图生成时各兵种的权重（相加无须为 100，走 rng.weighted） */
export const ENEMY_SPAWN_WEIGHTS = {
  patrol: 42,
  rusher: 22,
  marksman: 18,
  elite: 18,
};

/* ============================== 战斗数值 ============================== */

export const COMBAT = {
  armorK: 120, // 护甲减伤系数：减伤 = armor / (armor + K)
  armorDurabilityLoss: 0.55, // 每点原始伤害消耗的护甲耐久
  hitMarkerLife: 0.18,
  tracerLife: 0.07,
  shellLife: 1.1,
  bloodPerHit: 7,
  playerShake: 2.2,
  adsSpreadMul: 0.45, // 瞄准（ADS）状态下的散布系数
  // --- 开火手感：视角上抬（aim punch）与准星扩张 ---
  recoilPitchMul: 2.2, // 每发抬枪角度 = def.recoil * 该系数（弧度）
  recoilPitchMax: 0.09, // 抬枪累积上限（约 5°，防止连射时枪口飞上天）
  recoilRecover: 9, // 抬枪回落速率（越大回得越快）
  crosshairBloom: 16, // 准星随扩散外扩的最大增量（腰射）
  crosshairBloomAds: 10, // 瞄准时的最大增量（更小）
  // 轻度辅助瞄准（仅玩家、仅偏航）：准星靠近敌人时把这一发小幅吸过去，不做全自动锁头。
  // enabled 由 save.settings.aimAssist 在启动时写入，可在暂停菜单关闭。
  aimAssist: { enabled: true, coneDeg: 7, strength: 0.45 },
};

/* ============================== 击杀信息流 ============================== */

export const KILLFEED = {
  life: 5.0, // 单条停留秒数
  fade: 0.8, // 末尾多少秒淡出
  max: 5, // 同屏最多条数
  rowH: 22,
  width: 300,
};

/* ============================== 商店与经济 ============================== */

export const SHOP = {
  sellRatio: 0.6, // 出售价 = 价值 * 0.6
  items: ['rifle', 'smg', 'pistol', 'lv2', 'lv3', 'ammo556', 'ammo9mm', 'medkit', 'bandage', 'pill'],
  restock: { pistol: 999, ammo556: 999, ammo9mm: 999, medkit: 999, bandage: 999, pill: 999 },
};

export const START_CURRENCY = 4000;

/** 破产保护：资金低于阈值且仓库无武器时补发 */
export const BAILOUT = { currency: 900, minCurrency: 1500 };

/* ============================== 结算评分 ============================== */

export const SCORING = {
  lootPerPoint: 0.35,
  killPoints: 80,
  searchPoints: 25,
  extractBonus: 500,
  survivalPerSecond: 1.6,
  terminalBonus: 150, // 每破解一个数据终端的额外评分
  ratings: [
    { grade: 'S', min: 1600 },
    { grade: 'A', min: 1100 },
    { grade: 'B', min: 700 },
    { grade: 'C', min: 350 },
    { grade: 'D', min: 0 },
  ],
};

/* ============================== 视觉 ============================== */

export const COLORS = {
  bg: '#0a0e13',
  floor: '#151b24',
  floorAlt: '#121821',
  room: '#1a212c',
  wall: '#232d3b',
  wallTop: '#33405480',
  wallEdge: '#0d1219',
  crate: '#3b3227',
  crateEdge: '#1d1a15',
  bush: '#1f3a2a',
  grid: '#1e2733',
  accent: '#ffb020',
  accent2: '#35e0d0',
  danger: '#ff4d4d',
  ok: '#5ddc7a',
  text: '#d7dee8',
  dim: '#7c8899',
};

export const MINIMAP = { width: 244, height: 184, padding: 12 };

/**
 * 小地图显示哪些信息。
 *
 * showEnemies 的取舍（需求书："战术游戏通常敌人不显示在小地图上"）：
 * 开着 = 免费的全图雷达，等于把"发现"这一层玩法直接删掉 —— 搜刮时根本不需要听声辨位，
 * 照着红点走就行，关卡设计里的掩体与视野博弈全部作废；
 * 关掉 = 小地图回到它该有的职责：**指路**（撤离点 / 任务点 / 未搜刮容器）。
 *
 * 所以关掉敌人不是"少一个功能"，而是把难度还给玩法本身。
 * 想开的话把 showEnemies 改 true 即可（枚举与着色逻辑都还在）。
 */
export const MINIMAP_LAYERS = {
  showEnemies: false,     // 敌人红点（默认关：战术游戏不应给免费雷达）
  showExtracts: true,     // 撤离点
  showTerminals: true,    // 数据终端（任务点）
  showAirdrop: true,      // 空投信标
  showContainers: true,   // 未搜刮容器（按最高稀有度着色）
};

/* ============================== 3D 渲染 ============================== */

/** 3D 调色板（Low-Poly 风格化） */
export const PALETTE3D = {
  ground: '#33403A',
  groundAlt: '#2C352F',
  wall: '#5C5F52',
  wallTop: '#6C7060',
  crate: '#9C7B36',
  crateTrim: '#8A5A16',
  crateRubble: '#6B5640', // 击碎后的瓦砾色
  vehicleBody: '#4F5A4A', // 载具车身（战术军绿）
  vehicleDark: '#2A2E33', // 载具底盘 / 轮胎区
  vehicleGlass: '#7FA8C4', // 挡风玻璃
  platform: '#6B7280', // 架高平台台面
  platformTrim: '#9CA3AF', // 台沿高光（让高度差一眼可辨）
  platformStep: '#4B5563', // 上下平台的台阶
  drawer: '#6B7280',
  safe: '#1F2937',
  safeTrim: '#9CA3AF',
  weaponbox: '#4B5320',
  body: '#4A3B3B',
  bush: '#276749',
  extract: '#10B981',
  // --- POI 目标点 ---
  terminal: '#35E0D0', // 数据终端：青色（未破解）
  terminalHacked: '#10B981', // 已破解：转绿
  airdrop: '#FFB020', // 空投信标：传说金
  highlight: '#FBBF24',
  enemyPatrol: '#9CA3AF',
  enemyElite: '#DC2626',
  enemyMarksman: '#7B68A6', // 精确射手：紫
  enemyRusher: '#E08A3C', // 冲锋兵：橙
  vmBody: '#393E36',
  vmDark: '#22281F',
  sky: '#1A2430',
  fog: '#1A2430',
  dust: '#C9D6E4', // 空气尘埃颜色
  ceiling: '#4A524A', // 天花板基色（略亮于墙，配合自发光避免从下看发黑）
  ceilingBeam: '#33392F', // 结构横梁基色
  hemiSky: '#93C5FD',
  hemiGround: '#475569',
  dirLight: '#FFF7ED',
  ambient: '#1E293B',
  tracer: '#FFD9A0',
  impact: '#D2C8AA',
  blood: '#B22020',
  // --- 程序化贴图用色（CanvasTexture，见 models.js makeCanvasTexture） ---
  wood: '#7A4E22',
  woodDark: '#5A3818',
  metal: '#5B6168',
  metalDark: '#363C44',
  concrete: '#565A4C',
  medkit: '#F4F6F8',
  medkitCross: '#E23B3B',
  ammoBox: '#C9A227',
  armorPlate: '#7F8C9B',
  hand: '#C8A07A',
  helmet: '#33392F',
  backpack: '#3A4A3F',
};

/**
 * 3D 视图参数（FPS）。
 * 坐标契约：逻辑 (x, y) → 场景 (x, height, y)，1 逻辑单位 = 1 场景单位（XZ 原封不动）。
 *
 * ⚠ 单位说明（对设计文档的一处必要校正，见 docs/design-3d-fps.md 3.6）：
 * 设计文档给出的高度（眼高 1.65 / 墙高 3.2 / 容器 0.8~1.2）是**米**，
 * 而 XZ 平面沿用的是逻辑单位（tile=40、玩家碰撞半径 12、敌人半径 11）。
 * 若按字面把 3.2 当作 3.2 个场景单位，墙会比敌人的碰撞直径（22 单位）还矮，场景完全不成立。
 * 因此统一引入换算：1 米 = metersToUnits 个逻辑单位。
 * 该系数由既有逻辑数值反推：玩家碰撞半径 12 单位 ≈ 0.6 m ⇒ 1 m = 20 单位。
 * 换算后：tile=2m、地图=120×90m、墙高=3.2m、眼高=1.65m —— 与 2D 版的手感完全一致。
 * 逻辑坐标与全部纯逻辑模块**不受影响**。
 */
export const VIEW3D = {
  /** 1 米 = 多少个逻辑单位（= 场景单位）。所有以米为单位的尺寸在建模时乘上它。 */
  metersToUnits: 20,

  // --- 高度与尺寸（单位：米，使用时 × metersToUnits） ---
  wallHeight: 3.2, // 墙体高度
  crateHeight: 1.5, // 掩体箱高度
  platformHeight: 1.25, // 架高平台高度（米）：站上去抬高视点，并能越过掩体箱观察
  extractBeamHeight: 22, // 撤离点光柱高度
  groundY: 0,

  // --- 相机 ---
  eyeStand: 1.65, // 站立眼高
  eyeCrouch: 1.0, // 蹲下眼高
  // 玩家受击竖直包围体（单位：米）。敌人 3D 弹道以它判定能否命中玩家；
  // 不随蹲伏收缩（蹲下只改玩家自身视点，不改受击盒），避免蹲伏变成水平火力的「绝对护盾」。
  playerHitboxH: 1.8, // 受击盒总高（地面到头顶）
  playerCenterM: 0.9, // 身体中心高度：敌人俯仰瞄准的竖直基准点
  eyeLerp: 11, // 眼高插值速率（越大越快）
  fov: 75, // 腰射 FOV
  fovAds: 55, // 瞄准 FOV
  fovLerp: 12, // FOV 插值速率
  near: 4, // 近裁剪面（0.2 m，够近又不损失深度精度）
  far: 2200, // 远裁剪面（地图对角线 3000，靠雾收边）
  pitchLimit: (85 * Math.PI) / 180, // pitch 限幅
  sensitivity: 0.0022, // 鼠标灵敏度（弧度 / 像素）
  maxPixelRatio: 1.75, // devicePixelRatio 上限，防止高分屏掉帧
  minPixelRatioFallback: 1, // 自适应降级第 3 级：帧率仍不足时把像素比压到 1

  // --- 光照与氛围 ---
  fogDensityPerMeter: 0.012, // 设计文档的 FogExp2 密度（每米），换算到每单位见 scene3d
  // #24 暗色光照小幅调优：夜战氛围不变，但暗部不再死黑、可读性更稳。
  // hemi 抬天光填充、ambient 抬阴影底色、dir 维持主光不变量；三值均小幅上调。
  hemiIntensity: 0.85,
  dirIntensity: 2.1,
  ambientIntensity: 0.34,
  dirLightOffset: { x: 620, y: 760, z: 420 }, // 平行光相对聚焦点的偏移（单位）
  shadowRadius: 32, // 阴影视锥半径（米）
  shadowNear: 1,
  shadowFar: 2400,
  shadowMapSize: 2048,
  shadowMapSizeFallback: 1024, // 帧率不足时的降级尺寸
  shadowBias: -0.0009,

  // --- 画面质量（色调映射 / 环境反射 / 气氛） ---
  // ACES 色调映射是"从能看变成能看"的关键一步：没有它，Standard 材质在强光下会直接
  // 过曝成一片死白，整体观感发灰发平。
  toneMappingExposure: 1.12, // 色调映射曝光（>1 提亮，配合 ACES 使用）
  envIntensity: 0.85, // 程序化环境贴图强度（给 Standard 材质提供天光反射）
  envMapSize: 128, // 环境贴图（PMREM）分辨率，越大越细腻但生成越慢
  skyTop: '#101823', // 天空渐变顶部
  skyMid: '#26364A', // 天空渐变中部（地平线附近）
  skyBottom: '#3A4A5C', // 天空渐变底部
  dustCount: 420, // 空气尘埃粒子数（营造体积感，0 = 关闭）
  dustRadius: 70, // 尘埃分布半径（米，跟随相机的局部范围）
  dustSize: 0.035, // 尘埃颗粒大小（米）
  groundRoughness: 0.86, // 地面粗糙度
  wallRoughness: 0.76, // 墙面 / 掩体箱粗糙度
  metalness: 0.06, // 非金属表面的基础金属度（略微给一点，增加反射层次）

  // --- 敌人模型 ---
  enemy: {
    patrol: { torsoW: 0.62, torsoH: 0.95, torsoD: 0.38, headR: 0.19, legH: 0.72 },
    elite: { torsoW: 0.70, torsoH: 1.02, torsoD: 0.42, headR: 0.20, legH: 0.76 },
    // 冲锋兵：更瘦小灵活，和"高速贴脸"的定位呼应
    rusher: { torsoW: 0.56, torsoH: 0.88, torsoD: 0.34, headR: 0.18, legH: 0.68 },
    gunLength: 0.62,
    hitFlashColor: '#FFE4E6',
  },

  // --- 武器视图模型（挂在相机下，局部坐标；尺寸/距离单位：米） ---
  viewmodel: {
    base: { x: 0.20, y: -0.20, z: -0.40 }, // 腰射位置
    baseRot: { x: 0.03, y: 0.16, z: 0 }, // 腰射姿态（略向内收）
    ads: { x: 0, y: -0.012, z: -0.30 }, // 瞄准位置：枪管轴线对齐屏幕中心（相机前向=准星=子弹飞行方向）
    adsRot: { x: 0, y: 0, z: 0 },
    lerp: 14, // 位置插值速率
    bobIdleAmp: 0.010, // 待机呼吸幅度
    bobIdleSpeed: 1.7,
    bobMoveAmp: 0.030, // 移动摆动幅度
    bobMoveSpeed: 10.5,
    bobRollAmp: 0.020, // 左右移动时的侧倾
    swayAmp: 0.030, // 视角转动时的滞后摆动
    swayLerp: 8,
    recoilKick: 0.16, // 开火后坐位移（沿枪轴后退）
    recoilRot: 0.10, // 开火上扬弧度
    recoilLerp: 12,
    reloadDrop: 0.22, // 换弹下沉
    reloadRoll: 0.85, // 换弹侧翻弧度
    reloadLerp: 9,
  },

  // --- 特效（长度/速度单位同样为米） ---
  fx: {
    tracerLife: 0.07,
    tracerWidth: 0.05, // 曳光弹半径
    tracerColorPlayer: PALETTE3D.tracer,
    tracerColorEnemy: '#FF9A6A',
    impactLife: 0.35,
    impactCount: 6,
    sparkSize: 0.05,
    sparkSpeed: 4.5, // m/s
    sparkGravity: 9.5, // m/s²
    bloodSize: 0.07,
    bloodSpeed: 5.5,
    bloodGravity: 11,
    maxParticles: 220,
    muzzleFlashLife: 0.06,
    muzzleFlashScale: 0.34,
    muzzleFlashColor: '#FFD08A',
    shakeDecay: 7.5, // 震屏衰减速率
    shakeMax: 0.10, // 震屏位移上限（米）
  },

  // --- 关卡构建 ---
  level: {
    wallColorJitter: 0.09, // 墙面明暗扰动幅度（走 rng 子流，保证同 seed 一致）
    crateColorJitter: 0.10,
    bushClusters: 3, // 每个灌木丛的团块数
    highlightPulseSpeed: 3.2, // 可交互高亮呼吸速度
    extractBeamSegments: 12, // 光柱圆柱分段（Low-Poly）
    searchedDim: 0.45, // 已搜容器的亮度衰减
    // --- 天花板 / 封闭空间（设计文档 P2 增强） ---
    ceilingGap: 0.15, // 天花板高于墙顶的间隙（米），避免与墙顶共面产生 z-fighting
    ceilingBeamSpacing: 6, // 结构横梁间距（米）
    ceilingBeamH: 0.34, // 横梁高度（米）
    ceilingBeamW: 0.22, // 横梁宽度（米）
    ceilingEmissive: 0.14, // 天花板/横梁自发光系数，保证从下观看不发黑
  },
};

/**
 * 后处理管线参数（renderer3d 的全屏 pass）。
 *
 * 全部集中在此以便调色，渲染层不再出现魔数。
 * 注意：这些是在**线性空间**、ACES 色调映射**之后**作用的，
 * 数值偏大时暗部会明显显脏（AO 与颗粒尤其），调整请配合真机截图。
 */
export const POST3D = {
  enabled: true, // 总开关（WebGL2 不可用时自动降级为直渲，与此无关）
  vignette: 0.42, // 暗角强度：收拢视线到画面中心
  chromatic: 0.0016, // 径向色差：金属/高光边缘的彩色镶边
  ao: {
    mix: 0.7, // AO 混入比例
    strength: 0.6, // 遮蔽强度
    radius: 9.0, // 采样半径（像素）
    bias: 0.02, // 深度差阈值，低于此值不算遮蔽（抑制噪声）
    samples: 12, // 螺旋采样数（性能/质量权衡）
  },
  grain: 0.014, // 颗粒强度：抑制色带；过大会在暗场显脏
  contrast: 0.96, // 中间调对比指数（<1 提亮，线性空间）
};


/** 3D 层使用的 rng 子流盐值（保证装饰性随机与逻辑随机互不干扰） */
export const RNG_SALT_3D = { level: 101, decor: 202, particles: 303 };
