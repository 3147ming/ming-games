/**
 * 全局数值配置（纯数据模块）
 *
 * 约束：本文件不得引用 DOM / Canvas / localStorage，必须可在 Node 22 下被直接 import 做单元测试。
 * 所有战斗、经济、地图、AI 的可调数值都集中在此处，便于平衡性调整。
 */

/* ============================== 地图 ============================== */

export const TILE = 40;
/**
 * 世界尺寸。TILE=2m，所以 96×72 格 = **192m × 144m**（旧值 60×45 = 120×90m）。
 *
 * 为什么是 1.6 倍边长而不是一步到"三角洲那味"的 500m 见方：
 * - 单局 8 分钟，按 6.2 m/s 的战术移动速度，横穿 192m 要 31 秒，斜穿 45 秒 ——
 *   再大就变成"全程在跑路、遇不到人"，8 分钟的局撑不起 500m 的地图；
 * - 渲染与寻路都是**整图一次性**建好（合并几何 + 全图流场），没有分区流式加载，
 *   面积再翻倍会让显存/首帧/AI 遍历同时越预算。
 * 真要上 500m，前置条件是"分区分块加载 + 地形高度场"，那是 W4 之后的事。
 */
export const MAP_COLS = 96;
export const MAP_ROWS = 72;
export const WORLD_W = TILE * MAP_COLS; // 3840（192m）
export const WORLD_H = TILE * MAP_ROWS; // 2880（144m）

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
  // P20：3 个撤离方向（指令书要求「每张图至少 3 个撤离方向」）。
  // 其中一处是开局即开放的「常规撤离」，保证任何时刻都有可用方案。
  extractTotal: 3,
  extractOpenAt: 120, // 最后 2 分钟：剩余撤离点全部开放
  extractFirstOpen: 150, // 第 2 分 30 秒先开一个出口：把「何时撤」还给玩家
  extractHitPenalty: 0.8, // 撤离读条被打中一次回退的秒数（不是清零）
  extractRadius: 64,
  interactRange: 56,
  itemPickupRange: 38, // 地面掉落物的拾取距离（比容器/终端更近，避免误触）
  // 面积从 120×90m 扩到 192×144m（2.56 倍）后，敌人数量同步上调，
  // 否则"跑一分钟遇不到一个人"就成了空旷散步。密度仍低于旧图（旧图 8/10800m²，新图 13/27648m²），
  // 因为大地图要靠距离制造"要不要开这一枪"的取舍。
  enemyCountMin: 13,
  enemyCountMax: 17,
  eliteChance: 0.26,
  // --- POI 目标点 ---
  terminalCount: 4, // 每局数据终端数量（破解给评分 + 情报费）；地图翻 2.5 倍后多给一个目标
  terminalHackTime: 3.5, // 破解读条秒数
  airdropDelay: 95, // 开局多少秒后空投着陆
  // --- 撤离点机制 ---
  extractFee: 800, // 付费撤离点手续费
  guardLeash: 150, // 守点敌人离撤离点超过该距离会被拉回
  contractCount: 3, // 每局随机抽取的局内合约条数
  platformCount: 4, // 每局架高平台数量上限（占高地：抬高视点 + 越过掩体观察）
};

/* ============================== 地图定义 ============================== */

/**
 * 地图定义表：两张图共用同一套网格尺寸与渲染管线，差异全部落在**生成参数**上。
 *
 * 为什么不做成两张不同尺寸的地图：
 * 渲染（天花板 / 横梁 / 阴影范围）、小地图缩放、雾与光照都按 WORLD_W × WORLD_H 写死，
 * 换尺寸要同时改 scene3d / level3d / ui 三处，收益只是"看起来不一样"，
 * 却会把风险引到已经稳定的渲染链路上。这里选择"同尺寸、不同肠子"：
 * 房间切分深度、房间填充率、走廊宽度、掩体/物资密度、平台与载具、撤离距离。
 *
 * 风险收益如何区分：
 * - depot  ：开阔大房间 + 稀疏掩体 = 长视距、远程压制，暴露就挨枪；但撤离点近、有载具。
 *             高风险（枪线多）换中等收益（物资正常、撤退快）。
 * - conduit：小房间 + 1 格宽回廊 + 无载具 = 视野短、拐角多，交火距离被强行压缩；
 *             物资密度显著更高，但出生点被刻意推到离出口很远的位置，
 *             收益高、风险从"对枪"转成"装满之后怎么活着走回去"。
 *
 * ⚠ 硬约束：depot 的每一项参数都必须保持原 generateMap 的字面量原值，
 * 否则旧地图同种子结果会变；tests/map2.test.mjs 用 golden 哈希锁死这一点。
 */
export const MAPS = {
  depot: {
    id: 'depot',
    name: '灰港库区',
    tagline: '开阔 · 远程压制 · 撤离近',
    desc: '开阔库区：房间大、掩体稀、视距长，露头就要吃远程火力；好在出口不远，还有载具代步。适合枪法硬、敢抢高价值房区的人。',
    cols: MAP_COLS,
    rows: MAP_ROWS,
    // --- 房间切分 ---
    bspDepth: 5, // 96×72 的图深 5 层 ≈ 22~28 个分区，单区仍有 12×9 格
    leafMin: 10, // 叶子最小 10 格：保证房间有 6 格以上的净宽
    roomFillMin: 0.62, // 房间至少占叶子的 62%：大房间、墙少，视野通透
    // 露天广场比例：库区要有"货场/停车场"这种一眼望穿的空地，
    // 否则扩图只是把室内迷宫做大，仍然是室内战。
    roomSkipChance: 0.3,
    // 层数分布：[1 层, 2 层, 3 层] 的概率。仓库区以单层大跨为主，少量办公/宿舍楼挑高。
    heightFloors: [0.52, 0.34, 0.14],
    corridorWidth: 2, // 2 格宽走廊：双向都能绕，交火有回旋余地
    loopCorridors: 0, // 开阔图不额外加环路：绕后靠房间本身的空间
    // --- 掩体 / 植被 ---
    crateCountMin: 1,
    crateCountMax: 3,
    crateAreaDiv: 12,
    crateWideChance: 0.5, // 一半是 2 格宽的箱子：更耐打、能当半身掩体
    crateTallChance: 0.7,
    plazaCrateMax: 12, // 露天货场：集装箱越多，室外转移越有掩护
    bushMax: 2, // 库区角落的杂草：贴边潜行的选择
    // --- 物资 ---
    // 每 20 格面积约 1 个容器。地图翻 2.56 倍后按旧密度会堆到 80+ 个，
    // 单是容器 GLB 就把三角形顶到 226k（预算 160k），而且 8 分钟根本搜不完 —— 密度降回来反而每个箱子更值钱。
    containerAreaDiv: 90, // 房间平均 ~79 格 → 每房 1 个：写实木箱 6576 面/个，密了就是拿三角形换后悔
    containerRoomRate: 1,
    containerMax: 2,
    // --- 撤离 / 出生 ---
    extractSpread: 720, // 新图边长 1.6 倍，出口间距同步拉开，"选哪个口"才有意义
    spawnMinExtractDist: 0, // 旧图不额外推远出生点
    // --- 立体 / 机动 ---
    platformCount: MATCH.platformCount, // 3 处架高平台：高地视野是本图的核心博弈
    vehicles: true,
    // --- 敌人（沿用既有数量区间，避免动战斗平衡）---
    enemyCountMin: MATCH.enemyCountMin,
    enemyCountMax: MATCH.enemyCountMax,
  },
  conduit: {
    id: 'conduit',
    name: '锈脉管廊',
    tagline: '狭窄 · 物资密集 · 撤离远',
    desc: '地下管廊：房间小、回廊窄、拐角多，交火被迫贴脸；物资密度全图最高，但出口远、没有载具，装满之后怎么走回去才是真难点。',
    cols: MAP_COLS,
    rows: MAP_ROWS,
    // --- 房间切分 ---
    bspDepth: 6, // 更深两层 → "蜂窝"式小隔间，密度全图最高
    leafMin: 7, // 叶子最小 7 格：房间 3~8 格，刚好够一场近身遭遇
    roomFillMin: 0.72, // 小房间填得更满：把空间挤给走廊，逼出"门框对枪"
    // 地下管廊刻意几乎不留露天（0.04）：三张图必须有"室内战"的那一张，
    // 否则差异化没了 —— 想打 CQB 的人应该能选到这张。
    roomSkipChance: 0.04,
    // 地下管廊：几乎全是单层（92%）。这张图要的是「钻管道」的压迫感，不是天际线。
    heightFloors: [0.92, 0.08, 0],
    corridorWidth: 1, // 1 格宽：只能单列通过，无法并肩，烟/雷/卡点价值陡增
    loopCorridors: 10, // 额外 10 条环路：窄图最怕死胡同，多出口才敢往里走
    // --- 掩体 / 植被 ---
    crateCountMin: 1,
    crateCountMax: 4, // 小房间里也堆更多箱子：打断长视线，制造近距离绕角
    crateAreaDiv: 8, // 每 8 格就尝试 1 个箱子（旧图是 12）
    crateWideChance: 0.3, // 以 1×1 立柱为主：窄空间里大箱子会把路堵死
    crateTallChance: 0.35,
    plazaCrateMax: 4, // 管廊几乎没有露天区，给个保底值
    bushMax: 0, // 地下管廊没有植被：隐蔽只靠墙角和箱子
    // --- 物资 ---
    containerAreaDiv: 60, // 小隔间面积小，用每间 1 个会变 49 个；靠下面的比例折扣降下来
    containerRoomRate: 0.85, // 85% 的隔间有容器：仍是三张图里最密的 // 每 16 格约 1 个容器：仍是三张图里最密的，但不再撑爆三角形预算
    containerMax: 2,
    // --- 撤离 / 出生 ---
    extractSpread: 940, // 两个出口拉得更开：不要出现"顺手就能撤"的局
    spawnMinExtractDist: 1400, // 出生点优先选离最近出口 ≥1400（约 35 格）的房：收益要背回去
    // --- 立体 / 机动 ---
    platformCount: 1, // 只留一处检修高台：立体优势稀薄，主要博弈在地面拐角
    vehicles: false, // 管廊开不进车：撤离只能靠腿，进一步放大"满载后长距离转移"的风险
    // --- 敌人（与旧图同区间：不靠改数值做难度）---
    enemyCountMin: MATCH.enemyCountMin,
    enemyCountMax: MATCH.enemyCountMax,
  },
  /**
   * 第三张图：雷达观测站（山地高地）。
   * 与「灰港库区（开阔远程）」「锈脉管廊（狭窄物资密集）」形成第三种博弈原型：
   * 房间连通、视野开阔，但平台最多、高低差最大 —— 抢到高地的一方能压着另一侧打，
   * 每一次地面转移都暴露在制高点下。「立体 / 暴露」是本图的核心张力。
   * 参数差异（相对 depot/conduit）：bspDepth 居中、roomFillMin 偏高（视线长）、
   * platformCount 最高（立体重点）、vehicles 开（室外可开车）、spawnMinExtractDist 适中。
   */
  ridge: {
    id: 'ridge',
    name: '雷达观测站',
    tagline: '高地 · 立体视野 · 暴露转移',
    desc: '山地观测站：房间连通、视野开阔，但抬升的地形让每一次转移都暴露在制高点下；平台多、高低差大，抢到高地的一方能压着另一侧打。适合敢抢点、会利用立体的玩家。',
    cols: MAP_COLS,
    rows: MAP_ROWS,
    // --- 房间切分 ---
    bspDepth: 5, // 中等房间数（介于库区与管廊之间）
    leafMin: 9,
    roomFillMin: 0.6, // 较开阔、视线长
    // 观测站是室外为主的一张图：露天比例最高，建筑只是散落的观测点
    roomSkipChance: 0.36,
    // 观测站建在山脊上：楼层差最大，天际线错落
    heightFloors: [0.40, 0.34, 0.26],
    corridorWidth: 2,
    loopCorridors: 5, // 中等环路，保证立体机动有回旋余地
    // --- 掩体 / 植被 ---
    crateCountMin: 1,
    crateCountMax: 3,
    crateAreaDiv: 11,
    crateWideChance: 0.4, // 以立柱为主，但比管廊多点宽箱当半身掩体
    crateTallChance: 0.6,
    plazaCrateMax: 9, // 观测站外场：碎石堆与货箱
    bushMax: 4, // 山地碎石与灌木：贴边潜行的选择
    // --- 物资 ---
    containerAreaDiv: 70,
    containerMax: 2,
    // --- 撤离 / 出生 ---
    extractSpread: 820, // 两个出口适中距离
    spawnMinExtractDist: 640, // 出生点略推离出口，但不像管廊那么极端
    // --- 立体 / 机动 ---
    platformCount: 9, // 立体重点：面积翻 2.5 倍，平台数等比跟上
    vehicles: true, // 室外开阔，可以开车
    // --- 敌人（与既有图同区间：不靠改数值做难度）---
    enemyCountMin: MATCH.enemyCountMin,
    enemyCountMax: MATCH.enemyCountMax,
  },
  /**
   * W8 大地图：荒原哨站（400×400m）。
   *
   * 250×250 tile = 500m 见方，对标三角洲级大地图。管线先在 200×200(400m) 上
   * 验证通（地面分块 P1），再放大到 500m：地面靠 chunk 只渲染玩家附近几块，
   * 不随整图面数线性增长；寻路实测单次 BFS <1ms、缓存 ~4MB，不是瓶颈。
   *
   * ⚠ 独立 def、不动 MAP_COLS/MAP_ROWS 与旧三图：GOLDEN 快照、旧档、旧图测试全绿。
   * bspDepth 7（≈128 间）保持街区密度——固定 depth 时房间数封顶 2^depth，
   * 若沿用 depth 5 会变成少数几个巨无霸房间，不是"更大的城市"而是"空旷荒原"。
   * 容器密度刻意压低（containerAreaDiv 320 + containerMax 2）：写实木箱 6576 面/个，
   * 不压会把移动端 tris 预算打穿。敌人倍率 1.9 补回面积涨带来的稀疏。
   */
  wasteland: {
    id: 'wasteland',
    name: '荒原哨站',
    tagline: '大地图 · 长途转移 · 据点争夺',
    desc: '500 米见方的废弃哨站：据点分散、路途漫长，出发前要规划好撤离路线，装满之后能否活着走回去才是真考验。',
    cols: 250,
    rows: 250,
    bspDepth: 7, // ≈128 间：固定深度时房间数封顶 2^depth，必须加深才不会变成几个巨无霸房间
    leafMin: 12,
    roomFillMin: 0.55,
    roomSkipChance: 0.4, // 大图多露天：荒原本身就是开阔地，建筑是散落据点
    heightFloors: [0.62, 0.28, 0.10], // 以单层为主：大图高层太多渲染与流场都贵
    corridorWidth: 2,
    loopCorridors: 6, // 环路保证大图不出现超长死胡同
    crateCountMin: 1,
    crateCountMax: 3,
    crateAreaDiv: 26,
    crateWideChance: 0.5,
    crateTallChance: 0.6,
    plazaCrateMax: 14,
    bushMax: 8,
    // 密度压低：房间数随 depth 涨，若沿用 depot 的 /90 会堆到几百个容器打穿面数预算
    containerAreaDiv: 320,
    containerRoomRate: 0.7,
    containerMax: 2,
    // 撤离点/出生距离随图放大（旧图 720/820 在 500m 图上太小）
    extractSpread: 3000, // 150m：三个出口真正分散
    spawnMinExtractDist: 2000, // 100m：收益要背长途
    platformCount: 24, // 高地随面积增加
    vehicles: true, // 大图没有载具就是纯跑路
    // 500m 图面积是 400m 的 1.56 倍，但房间数只从 79→90（depth 固定），
    // 敌人按房间撒会掉到 24；倍率 1.9 补回 ~29，与 400m 持平稳住空旷感。
    enemyCountMin: Math.round(MATCH.enemyCountMin * 1.9),
    enemyCountMax: Math.round(MATCH.enemyCountMax * 1.9),
  },
};

/** 默认地图（旧图）。UI 与 startRaid 都以此为缺省，保证旧行为不变。 */
export const DEFAULT_MAP_ID = 'depot';

/* ============================== 玩家 ============================== */

export const PLAYER = {
  radius: 12,
  maxHp: 100,
  maxStamina: 100,
  // 移速按米制标定（1 m = metersToUnits = 20 单位）：124 = 6.2 m/s 战术移动。
  // 旧值 196（9.8 m/s）比博尔特还快，跑起来像"飞"，压枪/停步全靠反应而不是走位。
  speed: 124,
  sprintMul: 1.45, // 冲刺 180 = 9.0 m/s，仍是全场最快（最快的猎犬 168），逃生契约不变
  crouchMul: 0.5, // 蹲行 62 = 3.1 m/s
  staminaSprintDrain: 24,
  staminaRegen: 18,
  staminaRegenDelay: 0.8,
  // 负重上限 = 基础 28kg + 护甲加成（二级 +8kg / 三级 +12kg，见 weightLimitFor）。
  // P0-1（2026-10-30）：原基础 20kg 上调到 28kg（无甲即 28kg 上限），超重仍只减速不禁跑。
  // 带上限内的重量不产生任何惩罚；超重后进入"硬性超重"：移速下降（减速），但**仍允许奔跑**。
  // weightLimit 保留为"无甲基准值"，供不关心护甲的调用点（UI 进度条分母等）直接使用。
  weightLimit: 28,
  weightBaseLimit: 28,
  weightArmorBonus: { none: 0, lv2: 8, lv3: 12 },
  // 硬性超重：移速按超重比例线性下降（减速），但**不再禁止奔跑**——
  // 玩家超重时只是"跑得慢"，逃命手段依旧可用，避免"一超重就完全跑不动"的憋屈。
  weightOverSpeedFloor: 0.5, // 移速下限（两倍超重时触底 = 减速 50%）
  weightOverStaminaFloor: 0.4, // 体力恢复下限（比移速更早触底：体力是逃命的底线）
  staminaExhaustSpeedMul: 0.55, // 疲惫时移速倍率（体力耗尽后）
  staminaExhaustRecovery: 0.3, // 体力恢复到该比例（maxStamina）才解除疲惫
  noiseProne: 42, // 卧倒匍匐：比蹲行还轻，代价是移速几乎砍到 1/4
  noiseCrouch: 70,
  noiseWalk: 150,
  noiseSprint: 340,
  noiseSearch: 220, // 搜刮 / 破解读条期间周期性发出的响动
  proneMul: 0.26, // 卧倒移速倍率（三角洲里趴着挪动就是"爬"）
  proneStandCost: 0.35, // 卧倒→起身的硬直（秒）：趴下不是零风险，起身要花时间
  backpack: { cols: 5, rows: 6 },
  // P18 并行格位容器：胸挂 / 口袋 / 安全容器。三者与主背包一起构成随身容量，
  // 负重与结算都按「全部容器」聚合，不允许只读主背包。
  rig: { cols: 4, rows: 2 },
  pocket: { cols: 2, rows: 2 },
  secure: { cols: 2, rows: 2 },
  stash: { cols: 10, rows: 8 },
};

export const BACKPACK = PLAYER.backpack;
export const STASH_SIZE = PLAYER.stash;

/* ============================== 跳跃 / 翻越 ============================== */

/**
 * 跳跃与翻越（Space）。单位：米 / 秒 —— 与 `player.elevation` 同一套量纲，
 * 渲染层再乘 VIEW3D.metersToUnits。逻辑坐标是场景单位，翻越距离用米写，
 * 在 player 里用 metersToUnits 换算，避免"跳跃高度"和"翻越距离"两套单位混用。
 */
export const JUMP = {
  // 原地起跳：0.45m 的战术小跳（三角洲的跳不是蹦床，是用来跨门槛/躲子弹的）
  speed: 3.8, // 起跳竖直速度 m/s
  gravity: 16, // 重力 m/s²（比真实 9.8 重，落地干脆，不拖手感）
  apex: 0.45, // 峰值参考值（speed²/(2g)），仅用于注释与探针断言容差
  landNoise: 130, // 落地响动（介于蹲行 70 与走路 150 之间：跑跳落地会暴露）

  // 翻越：正前方有掩体箱时，Space 变成"翻过去"而不是原地跳
  vaultRange: 4.6, // 最远翻越距离（米）——一个 2m 掩体箱 + 两侧身位
  vaultDur: 0.46, // 翻越全程时长（秒）
  vaultApex: 1.15, // 翻越最高点（米，要高于 1.5m 掩体箱的中心视觉线）
  vaultSpeedMul: 0.5, // 翻越期间的水平推进曲线用 easeInOut，这个值只用于镜头前冲感
  minClear: 0.55, // 落点周围需要的最小净空（米），防止翻进墙缝

  // 滞空惩罚：空中开枪必须打不准，否则跳跃会变成"躲子弹 + 精准反杀"的最优解
  airSpreadMul: 2.4,
  airMoveMul: 0.82, // 空中水平操控（保留一点空控，不做完全不可控）
};

/** 姿态枚举（与 combatstate.STANCE_STATE 同源，这里是本地短名）。 */
export const STANCE = { STAND: 'stand', CROUCH: 'crouch', PRONE: 'prone' };

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
    wclass: 'ar', // P19 动作状态机：冲刺抬枪延迟/枪种手感分档
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
    spreadRecover: 2.6, // 扩散恢复（每秒）：步枪偏慢，逼玩家用点射
    recoil: 0.018,
    range: 820,
    noiseRadius: 520,
    ammoItem: 'ammo556',
    ammoType: '5.56mm',
    caliber: '556',
    value: 5200,
    weight: 3.8,
    size: { w: 4, h: 2 },
    icon: 'wpn_rifle',
    desc: '全自动突击步枪，威力与射速均衡，中近距离压制力极强。',
  },
  smg: {
    id: 'smg',
    wclass: 'smg', // P19 动作状态机：冲刺抬枪延迟/枪种手感分档
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
    spreadRecover: 3.2, // 冲锋枪恢复更快：靠射速压制而不是精度
    recoil: 0.014,
    range: 520,
    noiseRadius: 470,
    ammoItem: 'ammo9mm',
    ammoType: '9mm',
    caliber: '9mm',
    value: 3800,
    weight: 2.9,
    size: { w: 3, h: 2 },
    icon: 'wpn_smg',
    desc: '高射速低后坐，适合室内近战，远距离衰减明显。',
  },
  pistol: {
    id: 'pistol',
    wclass: 'pistol', // P19 动作状态机：冲刺抬枪延迟/枪种手感分档
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
    spreadRecover: 3.8, // 手枪几乎按发结算：点得越快越准
    recoil: 0.02,
    range: 420,
    noiseRadius: 380,
    ammoItem: 'ammo9mm',
    ammoType: '9mm',
    caliber: '9mm',
    value: 1200,
    weight: 1.2,
    size: { w: 2, h: 1 },
    icon: 'wpn_pistol',
    desc: '半自动手枪，可靠的副武器，弹药便宜、噪音低。',
  },
  carbine: {
    id: 'carbine',
    wclass: 'ar', // P19 动作状态机：冲刺抬枪延迟/枪种手感分档
    name: 'Mk18 卡宾枪',
    short: 'CAR',
    category: 'weapon',
    rarity: 'epic',
    auto: true,
    damage: 25,
    rpm: 720,
    magSize: 30,
    reloadTime: 2.3,
    spread: 0.013,
    spreadPerShot: 0.009,
    spreadMax: 0.05,
    spreadRecover: 3.0, // 卡宾：机动与精度折中，恢复略快于步枪
    recoil: 0.016,
    range: 700,
    noiseRadius: 470,
    ammoItem: 'ammo556',
    ammoType: '5.56mm',
    caliber: '556',
    value: 4500,
    weight: 3.3,
    size: { w: 4, h: 2 },
    icon: 'wpn_rifle',
    desc: '短管卡宾，机动与射程折中，室内外皆宜的全能副主力。',
  },
  pdw: {
    id: 'pdw',
    wclass: 'smg', // P19 动作状态机：冲刺抬枪延迟/枪种手感分档
    name: 'MP7 个人防卫武器',
    short: 'PDW',
    category: 'weapon',
    rarity: 'rare',
    auto: true,
    damage: 16,
    rpm: 1000,
    magSize: 30,
    reloadTime: 1.9,
    spread: 0.018,
    spreadPerShot: 0.008,
    spreadMax: 0.08,
    spreadRecover: 3.4, // PDW：靠射速压制而非精度，恢复快
    recoil: 0.011,
    range: 360,
    noiseRadius: 430,
    ammoItem: 'ammo9mm',
    ammoType: '9mm',
    caliber: '9mm',
    value: 3200,
    weight: 2.4,
    size: { w: 3, h: 2 },
    icon: 'wpn_smg',
    desc: '超高射速、极低后坐的紧凑枪械，贴脸近战压制力极强。',
  },
  lmg: {
    id: 'lmg',
    wclass: 'lmg', // P19 动作状态机：冲刺抬枪延迟/枪种手感分档
    name: 'M249 轻机枪',
    short: 'LMG',
    category: 'weapon',
    rarity: 'legendary',
    auto: true,
    damage: 26,
    rpm: 600,
    magSize: 75,
    reloadTime: 4.2,
    spread: 0.016,
    spreadPerShot: 0.012,
    spreadMax: 0.07,
    spreadRecover: 2.2, // LMG：弹幕压制，散布恢复慢，鼓励点射控制
    recoil: 0.024,
    range: 720,
    noiseRadius: 560,
    ammoItem: 'ammo556',
    ammoType: '5.56mm',
    caliber: '556',
    value: 6800,
    weight: 9.5,
    size: { w: 5, h: 2 },
    icon: 'wpn_rifle',
    desc: '百发弹容的持续火力，压制与清扫利器，代价是笨重与高后坐。',
  },
  dmr: {
    id: 'dmr',
    wclass: 'sniper', // P19 动作状态机：冲刺抬枪延迟/枪种手感分档
    name: 'Mk14 精确射手步枪',
    short: 'DMR',
    category: 'weapon',
    rarity: 'epic',
    auto: false,
    damage: 42,
    rpm: 360,
    magSize: 20,
    reloadTime: 2.6,
    spread: 0.006,
    spreadPerShot: 0.010,
    spreadMax: 0.04,
    spreadRecover: 4.0, // DMR：半自动精确，点放为主，散布恢复快
    recoil: 0.030,
    range: 950,
    noiseRadius: 520,
    ammoItem: 'ammo762',
    ammoType: '7.62mm',
    caliber: '762',
    value: 5200,
    weight: 4.2,
    size: { w: 4, h: 2 },
    icon: 'wpn_rifle',
    desc: '7.62 精确射手步枪：半自动、单发高伤、弹道平直，中远距离点名利器。',
  },
  battle: {
    id: 'battle',
    wclass: 'ar', // P19 动作状态机：冲刺抬枪延迟/枪种手感分档
    name: 'AKM 战斗步枪',
    short: 'BAT',
    category: 'weapon',
    rarity: 'rare',
    auto: true,
    damage: 33,
    rpm: 620,
    magSize: 30,
    reloadTime: 2.8,
    spread: 0.015,
    spreadPerShot: 0.011,
    spreadMax: 0.06,
    spreadRecover: 2.6, // 战斗步枪：全自动泼水，散布恢复中等
    recoil: 0.026,
    range: 680,
    noiseRadius: 540,
    ammoItem: 'ammo762',
    ammoType: '7.62mm',
    caliber: '762',
    value: 4600,
    weight: 4.0,
    size: { w: 4, h: 2 },
    icon: 'wpn_rifle',
    desc: '7.62 战斗步枪：全自动、高伤高后坐，近距离泼水压制、中距离点射。',
  },
  shotgun: {
    id: 'shotgun',
    wclass: 'shotgun', // P19 动作状态机：冲刺抬枪延迟/枪种手感分档
    name: 'M870 霰弹枪',
    short: 'SG',
    category: 'weapon',
    rarity: 'rare',
    auto: false,
    pellets: 9, // 每发喷出 9 枚弹丸，近距离总伤极高，远距迅速衰减
    damage: 8, // 每枚弹丸伤害（独头弹会乘 ammo.damageMul 大幅抬高）
    rpm: 75,
    magSize: 6,
    reloadTime: 3.2,
    spread: 0.09, // 每弹丸散布极大
    spreadPerShot: 0.0,
    spreadMax: 0.20,
    spreadRecover: 2.2,
    recoil: 0.032,
    range: 170, // 有效射程短
    noiseRadius: 520,
    ammoItem: 'ammo12ga',
    ammoType: '12ga',
    caliber: '12ga',
    value: 3800,
    weight: 3.6,
    size: { w: 4, h: 2 },
    icon: 'wpn_rifle',
    desc: '泵动霰弹枪：每发 9 枚弹丸，近距离一枪制敌，远距几乎失效。配独头弹可变身影子步枪。',
  },
};

export const WEAPON_IDS = ['rifle', 'smg', 'pistol', 'carbine', 'pdw', 'lmg', 'dmr', 'battle', 'shotgun'];

/* ============================== 改枪台（P6） ============================== */

/**
 * 六个附件槽，顺序即 UI 从上到下的顺序。
 * 每个武器最多装这六个槽各一件（或留空）。
 */
export const WEAPON_MOD_SLOTS = [
  { id: 'muzzle', name: '枪口', short: 'MZ' },
  { id: 'sight', name: '瞄具', short: 'OPT' },
  { id: 'grip', name: '握把', short: 'GRP' },
  { id: 'mag', name: '弹匣', short: 'MAG' },
  { id: 'stock', name: '枪托', short: 'STK' },
  { id: 'barrel', name: '枪管', short: 'BAR' },
];

/**
 * 附件目录（改枪台可装配件）。
 *
 * 每个附件字段约定：
 *  - slot：所属槽位（必须与 WEAPON_MOD_SLOTS 的 id 一致）
 *  - compatible：适用武器 id 列表；含 '*' 表示全部武器通用
 *  - weight：附件自身重量（kg），计入负重估算（可为负，如短枪管减重）
 *  - desc：一句话说明，UI 展示用
 *  - mods：对武器 def 的数值改动，采用「(base * mul + add)」口径；
 *          只列出被改动的字段，未列出的字段保持基础值不变。
 *          乘区 key 形如 damageMul / recoilMul，加区 key 形如 damageAdd / recoilAdd。
 *
 * 被改动的武器 def 字段：damage / recoil / spread / range / magSize / reloadTime / noiseRadius / rpm。
 * magSize 与 rpm 取整，其余保留两位小数。
 */
export const WEAPON_MODS = {
  /* —— 枪口 —— */
  suppressor: { id: 'suppressor', name: '消音器', slot: 'muzzle', compatible: ['*'], weight: 0.4, desc: '大幅降低枪声暴露，但略增散布、微降伤害。', mods: { noiseMul: 0.4, spreadAdd: 0.002, damageMul: 0.96 } },
  compensator: { id: 'compensator', name: '补偿器', slot: 'muzzle', compatible: ['*'], weight: 0.3, desc: '显著降低后坐，但略微增噪。', mods: { recoilMul: 0.78, noiseMul: 1.12 } },
  flash: { id: 'flash', name: '消焰器', slot: 'muzzle', compatible: ['*'], weight: 0.2, desc: '消除枪口火光，后坐略降。', mods: { recoilMul: 0.9, noiseMul: 0.95 } },
  /* —— 瞄具 —— */
  reddot: { id: 'reddot', name: '红点', slot: 'sight', compatible: ['*'], weight: 0.2, desc: '首发更稳、开镜更快。', mods: { spreadAdd: -0.001 } },
  holo: { id: 'holo', name: '全息', slot: 'sight', compatible: ['*'], weight: 0.3, desc: '视野更清晰，首发更稳。', mods: { spreadAdd: -0.0015 } },
  /* —— 握把 —— */
  vgrip: { id: 'vgrip', name: '垂直握把', slot: 'grip', compatible: ['*'], weight: 0.2, desc: '显著压低垂直后坐。', mods: { recoilMul: 0.85 } },
  agrip: { id: 'agrip', name: '斜握把', slot: 'grip', compatible: ['*'], weight: 0.15, desc: '小幅压后坐并增射速。', mods: { recoilMul: 0.93, rpmAdd: 20 } },
  /* —— 弹匣 —— */
  extmag: { id: 'extmag', name: '扩容弹匣', slot: 'mag', compatible: ['*'], weight: 0.25, desc: '弹匣容量 +40%，换弹略慢。', mods: { magSizeMul: 1.4, reloadAdd: 0.15 } },
  fastmag: { id: 'fastmag', name: '快拆弹匣', slot: 'mag', compatible: ['*'], weight: 0.2, desc: '换弹更快，容量小幅提升。', mods: { reloadMul: 0.8, magSizeAdd: 3 } },
  /* —— 枪托 —— */
  tacticalstock: { id: 'tacticalstock', name: '战术枪托', slot: 'stock', compatible: ['*'], weight: 0.35, desc: '稳定后坐、收紧散布。', mods: { recoilMul: 0.88, spreadAdd: -0.001 } },
  heavystock: { id: 'heavystock', name: '重型枪托', slot: 'stock', compatible: ['*'], weight: 0.5, desc: '极致稳定但明显增重。', mods: { recoilMul: 0.8, spreadAdd: -0.0015 } },
  /* —— 枪管 —— */
  longbarrel: { id: 'longbarrel', name: '长枪管', slot: 'barrel', compatible: ['*'], weight: 0.45, desc: '提升射程与伤害，略增后坐。', mods: { rangeMul: 1.12, damageMul: 1.05, recoilMul: 1.06 } },
  shortbarrel: { id: 'shortbarrel', name: '短枪管', slot: 'barrel', compatible: ['*'], weight: -0.2, desc: '缩短枪管、减轻重量、换弹更快。', mods: { rangeMul: 0.92, reloadAdd: -0.1 } },
  /* —— 枪口（追加） —— */
  choke: { id: 'choke', name: '霰弹收束器', slot: 'muzzle', compatible: ['shotgun'], weight: 0.25, desc: '收紧霰弹散布、延长有效射程，对独头弹收益更高。', mods: { spreadMul: 0.6, rangeMul: 1.18 } },
  /* —— 瞄具（追加） —— */
  acog: { id: 'acog', name: '4x 光学镜', slot: 'sight', compatible: ['*'], weight: 0.35, desc: '中距精准，首发更稳、开镜略慢。', mods: { spreadAdd: -0.002, reloadAdd: 0.05 } },
  scope2x: { id: 'scope2x', name: '2x 红点镜', slot: 'sight', compatible: ['*'], weight: 0.25, desc: '轻量放大镜，兼顾机动与精准。', mods: { spreadAdd: -0.0012 } },
  /* —— 握把（追加） —— */
  bipod: { id: 'bipod', name: '折叠脚架', slot: 'grip', compatible: ['*'], weight: 0.5, desc: '架枪后极度稳定，但增重明显。', mods: { recoilMul: 0.7, spreadAdd: -0.002 } },
  /* —— 弹匣（追加） —— */
  drum: { id: 'drum', name: '弹鼓', slot: 'mag', compatible: ['*'], weight: 0.7, desc: '弹容量大幅提升，换弹更慢。', mods: { magSizeMul: 1.8, reloadAdd: 0.5 } },
  dualmag: { id: 'dualmag', name: '双联弹匣', slot: 'mag', compatible: ['*'], weight: 0.35, desc: '弹容小增、换弹更快。', mods: { magSizeAdd: 5, reloadMul: 0.78 } },
  /* —— 枪托（追加） —— */
  skeleton: { id: 'skeleton', name: '骨架枪托', slot: 'stock', compatible: ['*'], weight: -0.25, desc: '大幅减重，稳定略降。', mods: { recoilMul: 1.05, spreadAdd: 0.001 } },
  /* —— 枪管（追加） —— */
  heavybarrel: { id: 'heavybarrel', name: '重型枪管', slot: 'barrel', compatible: ['*'], weight: 0.6, desc: '提升伤害与射程、抑制后坐，代价是更重。', mods: { damageMul: 1.1, rangeMul: 1.1, recoilMul: 0.95 } },
};

/* ============================== 护甲 ============================== */

export const ARMORS = {
  none: {
    id: 'none',
    name: '无护甲',
    category: 'armor',
    rarity: 'common',
    slot: 'body',
    level: 0,
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
    slot: 'body',
    level: 2,
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
    slot: 'body',
    level: 3,
    armor: 75,
    weight: 7.5,
    value: 7800,
    size: { w: 2, h: 2 },
    icon: 'armor',
    desc: '重型复合装甲，能硬抗步枪数发，代价是明显更重。',
  },
  helmet_lv2: {
    id: 'helmet_lv2',
    name: '二级头盔',
    category: 'armor',
    rarity: 'rare',
    slot: 'helmet',
    level: 2,
    armor: 20,
    weight: 1.4,
    value: 1600,
    size: { w: 2, h: 1 },
    icon: 'helmet',
    desc: '覆盖头顶与后脑，把爆头倍率压回可控范围。',
  },
  helmet_lv3: {
    id: 'helmet_lv3',
    name: '三级头盔',
    category: 'armor',
    rarity: 'epic',
    slot: 'helmet',
    level: 3,
    armor: 32,
    weight: 2.1,
    value: 3900,
    size: { w: 2, h: 1 },
    icon: 'helmet',
    desc: '带面罩的重型头盔，能吃掉一发步枪爆头的大部分伤害。',
  },
};

export const ARMOR_IDS = ['none', 'lv2', 'lv3'];
export const HELMET_IDS = ['none', 'helmet_lv2', 'helmet_lv3'];

/* ============================== 近战 / 背包 / 胸挂（W2） ============================== */

/**
 * 近战武器。
 *
 * 与枪械完全分开的一套定义：不消耗弹药、不产生弹壳与枪声、不受口径约束，
 * 走 combat.meleeAttack 的短距 hitscan3D（见该函数注释）。
 *
 * - `rangeM`：**米**（渲染层 `VIEW3D.metersToUnits` 换算成逻辑单位），刻意写成米，
 *   与"刀有多长"这个直觉一致，避免再出现逻辑单位/米混用的老坑。
 * - `pen`：沿用弹药那套 1~6 的穿透等级，进 applyDamage 的离散减伤表
 *   （刀至少能割开软甲，穿甲弹 5~6 才是"无视护甲"那一档）。
 * - `cooldown`：两次挥击的最小间隔（秒）。比 `swingTime` 略长，留出收刀动作。
 */
export const MELEE = {
  knife: {
    id: 'knife',
    name: '战术匕首',
    category: 'melee',
    rarity: 'common',
    damage: 58,
    rangeM: 2.1,
    pen: 2,
    cooldown: 0.85,
    weight: 0.4,
    value: 900,
    size: { w: 1, h: 1 },
    icon: 'bayonet',
    desc: '静默处决与破窗工具。贴身一刀 58 点，不消耗弹药、不惊动远处的敌人。',
  },
  knife_heavy: {
    id: 'knife_heavy',
    name: '战术砍刀',
    category: 'melee',
    rarity: 'rare',
    damage: 92,
    rangeM: 2.4,
    pen: 3,
    cooldown: 1.15,
    weight: 1.0,
    value: 2600,
    size: { w: 2, h: 1 },
    icon: 'bayonet',
    desc: '厚背单刃刀，砍得动三级甲，代价是挥速慢、占地方。',
  },
};

export const MELEE_IDS = ['knife', 'knife_heavy'];

/**
 * 背包：只影响**负重上限**（`packBonus` 公斤）。
 *
 * 刻意不去改主背包的格位尺寸 —— 那会牵动局内背包/容器/校验一整片（P18），
 * 而玩家能感知的"带了多大的包"就是负重条上那串 kg。装上更重的包换来更高的承载，
 * 净收益是正的但有限，不会变成"必须带最大包"。
 *
 * `none` 的加成必须是 0：旧档没有这个字段，靠默认值补 `none` 才能保证
 * 负重上限与 W2 之前逐位相同（28 + 护甲加成）。
 */
export const BACKPACKS = {
  none: {
    id: 'none', name: '无背包', category: 'gear', slot: 'backpack',
    rarity: 'common', packBonus: 0, weight: 0, value: 0,
    size: { w: 1, h: 1 }, icon: 'crate',
    desc: '不带包。轻装最快，但装载能力只靠护甲。',
  },
  bp_lv1: {
    id: 'bp_lv1', name: '轻型突击背包', category: 'gear', slot: 'backpack',
    rarity: 'common', packBonus: 6, weight: 1.6, value: 1800,
    size: { w: 2, h: 2 }, icon: 'crate',
    desc: '帆布突击包，负重上限 +6kg，自重 1.6kg。',
  },
  bp_lv2: {
    id: 'bp_lv2', name: '战术背囊', category: 'gear', slot: 'backpack',
    rarity: 'rare', packBonus: 11, weight: 2.6, value: 4400,
    size: { w: 2, h: 3 }, icon: 'crate',
    desc: '带铝支架的背囊，负重上限 +11kg，自重 2.6kg。',
  },
  bp_lv3: {
    id: 'bp_lv3', name: '远征背囊', category: 'gear', slot: 'backpack',
    rarity: 'epic', packBonus: 16, weight: 3.8, value: 9200,
    size: { w: 3, h: 3 }, icon: 'crate',
    desc: '远征级承载，负重上限 +16kg。满载时你就是队友的补给点。',
  },
};

export const BACKPACK_IDS = ['none', 'bp_lv1', 'bp_lv2', 'bp_lv3'];

/**
 * 胸挂：决定**局内胸挂容器的格位**（快速取用位）。
 *
 * ⚠ 默认 `rig_lv1` 是 4×2 —— 与 W2 之前写死在 `PLAYER.rig` 的尺寸逐位一致。
 * 旧档没有这个字段时靠 defaultLoadout 补 `rig_lv1`，容器尺寸不变，
 * 所以 P18 的容量/负重/结算聚合全部保持原样。
 */
export const RIGS = {
  none: {
    id: 'none', name: '无胸挂', category: 'gear', slot: 'rig',
    rarity: 'common', cols: 3, rows: 1, weight: 0, value: 0,
    size: { w: 1, h: 1 }, icon: 'armor',
    desc: '只靠口袋。胸挂位缩到 3×1。',
  },
  rig_lv1: {
    id: 'rig_lv1', name: '战术胸挂', category: 'gear', slot: 'rig',
    rarity: 'common', cols: 4, rows: 2, weight: 0.9, value: 1500,
    size: { w: 2, h: 1 }, icon: 'armor',
    desc: '标准弹匣胸挂，4×2 快速取用位。',
  },
  rig_lv2: {
    id: 'rig_lv2', name: '扩容胸挂', category: 'gear', slot: 'rig',
    rarity: 'rare', cols: 5, rows: 2, weight: 1.4, value: 3800,
    size: { w: 2, h: 2 }, icon: 'armor',
    desc: '加宽弹匣袋 + 侧袋，5×2 快速取用位。',
  },
};

export const RIG_IDS = ['none', 'rig_lv1', 'rig_lv2'];

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
    heal: 55, useTime: 3.0, stopBleed: true,
    desc: '按 Q 使用，3 秒读条恢复 55 点生命并止血。',
  },
  bandage: {
    id: 'bandage', name: '绷带', category: 'consumable', rarity: 'common',
    value: 180, weight: 0.3, size: { w: 1, h: 1 }, icon: 'bandage',
    heal: 24, useTime: 1.6, stopBleed: true,
    desc: '按 Q 使用，1.6 秒快速止血，恢复 24 点生命。',
  },
  pill: {
    id: 'pill', name: '止痛药', category: 'consumable', rarity: 'common',
    value: 260, weight: 0.2, size: { w: 1, h: 1 }, icon: 'pill',
    heal: 10, useTime: 1.2, stamina: 60,
    desc: '按 Q 使用，恢复体力并小幅回血。',
  },
  surgery: {
    id: 'surgery', name: '手术包', category: 'consumable', rarity: 'rare',
    value: 900, weight: 1.2, size: { w: 2, h: 1 }, icon: 'surgery',
    heal: 30, useTime: 5.0, cureFracture: true, stopBleed: true,
    desc: '按 Q 使用，5 秒手术修复骨折，恢复上限并少量回血。',
  },
  armorKit: {
    id: 'armorKit', name: '护甲维修包', category: 'consumable', rarity: 'rare',
    value: 700, weight: 1.0, size: { w: 1, h: 1 }, icon: 'armorKit',
    useTime: 4.0, repairArmor: 0.45,
    desc: '按 Q 使用，4 秒恢复 45% 护甲与头盔耐久。',
  },

  /* --- 弹药（P7：同口径多弹种） --- */
  ammo556: {
    id: 'ammo556', name: '5.56mm FMJ', category: 'ammo', rarity: 'common',
    value: 600, weight: 1.0, size: { w: 1, h: 1 }, icon: 'ammo',
    stack: AMMO_STACK, ammoQty: AMMO_STACK,
    caliber: '556', pen: 3, gradeName: '标准',
    damageMul: 1, armorDamageMul: 1, noiseMul: 1,
    desc: `一盒 ${AMMO_STACK} 发标准步枪弹，穿透与伤害均衡。`,
  },
  ammo556ap: {
    id: 'ammo556ap', name: '5.56mm AP', category: 'ammo', rarity: 'rare',
    value: 820, weight: 1.0, size: { w: 1, h: 1 }, icon: 'ammo',
    stack: AMMO_STACK, ammoQty: AMMO_STACK,
    caliber: '556', pen: 5, gradeName: '穿甲',
    damageMul: 0.94, armorDamageMul: 1.55, noiseMul: 1,
    desc: `一盒 ${AMMO_STACK} 发穿甲弹：对高等级护甲减伤更低、拆甲更快。`,
  },
  ammo556sub: {
    id: 'ammo556sub', name: '5.56mm 亚音速', category: 'ammo', rarity: 'rare',
    value: 700, weight: 1.0, size: { w: 1, h: 1 }, icon: 'ammo',
    stack: AMMO_STACK, ammoQty: AMMO_STACK,
    caliber: '556', pen: 2, gradeName: '亚音速',
    damageMul: 0.86, armorDamageMul: 0.8, noiseMul: 0.42,
    desc: `一盒 ${AMMO_STACK} 发亚音速弹：枪声暴露半径大幅缩小，代价是伤害与穿透。`,
  },
  ammo9mm: {
    id: 'ammo9mm', name: '9mm FMJ', category: 'ammo', rarity: 'common',
    value: 420, weight: 0.8, size: { w: 1, h: 1 }, icon: 'ammo',
    stack: AMMO_STACK, ammoQty: AMMO_STACK,
    caliber: '9mm', pen: 2, gradeName: '标准',
    damageMul: 1, armorDamageMul: 1, noiseMul: 1,
    desc: `一盒 ${AMMO_STACK} 发标准手枪弹，冲锋枪同样适用。`,
  },
  ammo9mmap: {
    id: 'ammo9mmap', name: '9mm AP', category: 'ammo', rarity: 'rare',
    value: 560, weight: 0.8, size: { w: 1, h: 1 }, icon: 'ammo',
    stack: AMMO_STACK, ammoQty: AMMO_STACK,
    caliber: '9mm', pen: 4, gradeName: '穿甲',
    damageMul: 0.92, armorDamageMul: 1.5, noiseMul: 1,
    desc: `一盒 ${AMMO_STACK} 发穿甲手枪弹，专治轻甲目标。`,
  },
  ammo9mmhp: {
    id: 'ammo9mmhp', name: '9mm 空尖弹', category: 'ammo', rarity: 'rare',
    value: 500, weight: 0.8, size: { w: 1, h: 1 }, icon: 'ammo',
    stack: AMMO_STACK, ammoQty: AMMO_STACK,
    caliber: '9mm', pen: 1, gradeName: '空尖',
    damageMul: 1.22, armorDamageMul: 0.45, noiseMul: 1.05,
    desc: `一盒 ${AMMO_STACK} 发空尖弹：对无甲目标伤害极高，但几乎打不穿护甲。`,
  },
  ammo762: {
    id: 'ammo762', name: '7.62mm FMJ', category: 'ammo', rarity: 'common',
    value: 720, weight: 1.2, size: { w: 1, h: 1 }, icon: 'ammo',
    stack: AMMO_STACK, ammoQty: AMMO_STACK,
    caliber: '762', pen: 4, gradeName: '标准',
    damageMul: 1, armorDamageMul: 1, noiseMul: 1,
    desc: `一盒 ${AMMO_STACK} 发标准 7.62 弹，穿透与伤害均衡，战斗步枪与射手步枪通用。`,
  },
  ammo762ap: {
    id: 'ammo762ap', name: '7.62mm AP', category: 'ammo', rarity: 'rare',
    value: 960, weight: 1.2, size: { w: 1, h: 1 }, icon: 'ammo',
    stack: AMMO_STACK, ammoQty: AMMO_STACK,
    caliber: '762', pen: 6, gradeName: '穿甲',
    damageMul: 0.93, armorDamageMul: 1.6, noiseMul: 1.05,
    desc: `一盒 ${AMMO_STACK} 发穿甲 7.62：对高等级护甲减伤更低、拆甲更快。`,
  },
  ammo762sub: {
    id: 'ammo762sub', name: '7.62mm 亚音速', category: 'ammo', rarity: 'rare',
    value: 800, weight: 1.2, size: { w: 1, h: 1 }, icon: 'ammo',
    stack: AMMO_STACK, ammoQty: AMMO_STACK,
    caliber: '762', pen: 3, gradeName: '亚音速',
    damageMul: 0.85, armorDamageMul: 0.8, noiseMul: 0.42,
    desc: `一盒 ${AMMO_STACK} 发亚音速 7.62：枪声暴露半径大幅缩小，代价是伤害与穿透。`,
  },

  /* --- 12ga 霰弹（每发=多弹丸，弹匣按「发」计，单发大量 pellets） --- */
  ammo12ga: {
    id: 'ammo12ga', name: '12号鹿弹', category: 'ammo', rarity: 'common',
    value: 160, weight: 0.6, size: { w: 1, h: 1 }, icon: 'ammo',
    stack: 24, ammoQty: 24, // 霰弹单发体积大，一盒 24 发
    caliber: '12ga', pen: 1, gradeName: '鹿弹',
    damageMul: 1.0, armorDamageMul: 0.7, noiseMul: 1.0,
    desc: `一盒 24 发 12 号鹿弹：每发喷出多枚弹丸，近距爆发极高，远距迅速衰减。`,
  },
  ammo12gabuck: {
    id: 'ammo12gabuck', name: '12号重箭弹', category: 'ammo', rarity: 'rare',
    value: 360, weight: 0.6, size: { w: 1, h: 1 }, icon: 'ammo',
    stack: 24, ammoQty: 24,
    caliber: '12ga', pen: 3, gradeName: '重箭弹',
    damageMul: 1.25, armorDamageMul: 1.2, noiseMul: 1.05,
    desc: `一盒 24 发 12 号重箭弹：弹丸更重、穿透更强，对护甲目标更有效。`,
  },
  ammo12gaslug: {
    id: 'ammo12gaslug', name: '12号独头弹', category: 'ammo', rarity: 'rare',
    value: 320, weight: 0.6, size: { w: 1, h: 1 }, icon: 'ammo',
    stack: 24, ammoQty: 24,
    caliber: '12ga', pen: 4, gradeName: '独头弹', singleProjectile: true,
    damageMul: 2.6, armorDamageMul: 1.8, noiseMul: 1.1,
    desc: `一盒 24 发 12 号独头弹：单巨大弹丸、远射程、高穿透，霰弹枪化身影子步枪。`,
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
  serverRack: {
    id: 'serverRack', name: '服务器阵列', category: 'valuable', rarity: 'legendary',
    value: 5200, weight: 3.2, size: { w: 2, h: 2 }, icon: 'chip',
    desc: '整机拆下来的存储阵列，值钱，但重得像块砖。',
  },
  prototypeOptic: {
    id: 'prototypeOptic', name: '原型瞄具', category: 'valuable', rarity: 'legendary',
    value: 4800, weight: 0.8, size: { w: 2, h: 1 }, icon: 'optic',
    desc: '没有编号的样机，军火商不问来路。',
  },
  sealedOrder: {
    id: 'sealedOrder', name: '密封命令书', category: 'valuable', rarity: 'legendary',
    value: 4400, weight: 0.2, size: { w: 1, h: 1 }, icon: 'doc',
    desc: '火漆还在。里面的内容不该被你看见。',
  },

  /* --- 武器（由 WEAPONS 展开） --- */
  rifle: { ...WEAPONS.rifle },
  smg: { ...WEAPONS.smg },
  pistol: { ...WEAPONS.pistol },
  carbine: { ...WEAPONS.carbine },
  pdw: { ...WEAPONS.pdw },
  lmg: { ...WEAPONS.lmg },
  dmr: { ...WEAPONS.dmr },
  battle: { ...WEAPONS.battle },
  shotgun: { ...WEAPONS.shotgun },

  /* --- 护甲 / 头盔 --- */
  lv2: { ...ARMORS.lv2 },
  lv3: { ...ARMORS.lv3 },
  helmet_lv2: { ...ARMORS.helmet_lv2 },
  helmet_lv3: { ...ARMORS.helmet_lv3 },

  /* --- 近战 / 背包 / 胸挂（W2） --- */
  // `*_IDS` 里含 'none' 哨兵值（表示空槽），它不是可拥有的物品，所以不展开进 ITEMS。
  knife: { ...MELEE.knife },
  knife_heavy: { ...MELEE.knife_heavy },
  bp_lv1: { ...BACKPACKS.bp_lv1 },
  bp_lv2: { ...BACKPACKS.bp_lv2 },
  bp_lv3: { ...BACKPACKS.bp_lv3 },
  rig_lv1: { ...RIGS.rig_lv1 },
  rig_lv2: { ...RIGS.rig_lv2 },
};

export const ITEM_IDS = Object.keys(ITEMS);

/** 按稀有度分组的物品 id（供战利品表使用） */
export const ITEMS_BY_RARITY = RARITY_ORDER.reduce((acc, r) => {
  acc[r] = ITEM_IDS.filter((id) => ITEMS[id].rarity === r);
  return acc;
}, {});

/* ============================== 弹药口径（P7） ============================== */

/**
 * 口径目录。武器用 `caliber` 字段指向这里，弹药用同一个字段归组。
 * 换弹时只从「同口径」的弹药里取，绝不跨口径通用 —— 这是"带错弹"惩罚的来源。
 */
export const CALIBERS = {
  '556': { id: '556', name: '5.56×45mm', short: '5.56', ammo: ['ammo556', 'ammo556ap', 'ammo556sub'] },
  '9mm': { id: '9mm', name: '9×19mm', short: '9mm', ammo: ['ammo9mm', 'ammo9mmap', 'ammo9mmhp'] },
  '762': { id: '762', name: '7.62×39mm', short: '7.62', ammo: ['ammo762', 'ammo762ap', 'ammo762sub'] },
  '12ga': { id: '12ga', name: '12号霰弹', short: '12ga', ammo: ['ammo12ga', 'ammo12gabuck', 'ammo12gaslug'], pellet: true },
};

/** 全部弹药物品 id（按口径顺序展开，UI 与校验共用同一顺序）。 */
export const AMMO_IDS = Object.values(CALIBERS).flatMap((c) => c.ammo);

/** 弹药 id → 定义（只含弹药，UI 读 pen / gradeName 不必再判 category）。 */
export const AMMO_BY_ID = AMMO_IDS.reduce((acc, id) => {
  if (ITEMS[id]) acc[id] = ITEMS[id];
  return acc;
}, {});

/** 口径 id → 弹药 id 列表（非法口径返回空数组，不抛错）。 */
export function ammoIdsForCaliber(caliber) {
  const c = CALIBERS[caliber];
  return c ? c.ammo.slice() : [];
}

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
  // 首领专属掉落：击败地图 Boss 后在其倒地处生成，稀有度远高于普通容器。
  boss: {
    id: 'boss', name: '首领物资', searchTime: 3.2, rolls: [4, 5],
    rarityWeights: { common: 5, rare: 25, epic: 45, legendary: 25 },
    categoryBias: { weapon: 3, armor: 2, valuable: 2, ammo: 1.5 }, radius: 24, color: '#ff5c3c',
    desc: '击败首领掉落的专属物资，值钱且稀有。',
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
    armorLevel: 2,
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
    armorLevel: 3,
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
    canThrow: true, // P9：精英会隔空掷雷
    grenadeInterval: 18,
  },
  marksman: {
    id: 'marksman',
    name: '精确射手',
    hp: 85, // 脆
    armor: 10,
    armorLevel: 2,
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
    armorLevel: 1,
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
  shotgunner: {
    id: 'shotgunner',
    name: '霰弹兵',
    hp: 110,
    armor: 25,
    armorLevel: 2,
    speed: 132,
    radius: 11,
    color: '#b5651d',
    weapon: {
      id: 'enemy_shotgun', name: 'M870 霰弹枪', auto: false,
      damage: 9, rpm: 75, magSize: 6, reloadTime: 3.0,
      spread: 0.090, spreadPerShot: 0.0, spreadMax: 0.25, recoil: 0.03,
      range: 150, noiseRadius: 520, ammoItem: 'ammo12ga',
      pellets: 9, // 喷 9 弹丸：复用玩家 fireWeapon 的 pellet 循环，近距爆发极高
    },
    visionRange: 260,
    visionAngle: (88 * Math.PI) / 180,
    hearing: 400,
    reactionTime: 0.5,
    accuracy: 0.45,
    fireDelay: [0.8, 1.4],
    burst: [1, 2],
    preferredRange: 70, // 近距离爆发
    score: 90,
    lootBonus: 1.2,
  },
  machinegunner: {
    id: 'machinegunner',
    name: '机枪手',
    hp: 200,
    armor: 60,
    armorLevel: 3,
    speed: 78,
    radius: 13,
    color: '#7a4a8a',
    weapon: {
      id: 'enemy_mg', name: 'PKM 通用机枪', auto: true,
      damage: 9, rpm: 650, magSize: 100, reloadTime: 5.0,
      spread: 0.030, spreadPerShot: 0.012, spreadMax: 0.18, recoil: 0.02,
      range: 560, noiseRadius: 800, ammoItem: 'ammo556',
    },
    visionRange: 400,
    visionAngle: (80 * Math.PI) / 180,
    hearing: 460,
    reactionTime: 0.55,
    accuracy: 0.4,
    fireDelay: [0.7, 1.2],
    burst: [10, 16], // 长点射压制
    preferredRange: 320,
    score: 160,
    lootBonus: 1.8,
  },
  medic: {
    id: 'medic',
    name: '医疗兵',
    hp: 120,
    armor: 30,
    armorLevel: 2,
    speed: 116,
    radius: 11,
    color: '#3aa564',
    weapon: {
      id: 'enemy_pistol', name: 'M9 手枪', auto: false,
      damage: 12, rpm: 200, magSize: 15, reloadTime: 1.8,
      spread: 0.02, spreadPerShot: 0.01, spreadMax: 0.1, recoil: 0.01,
      range: 300, noiseRadius: 400, ammoItem: 'ammo9mm',
    },
    visionRange: 300,
    visionAngle: (80 * Math.PI) / 180,
    hearing: 420,
    reactionTime: 0.6,
    accuracy: 0.5,
    fireDelay: [0.8, 1.6],
    burst: [1, 2],
    preferredRange: 220,
    score: 110,
    lootBonus: 1.3,
    heals: true, // 支援：治疗附近受伤友军
    healRadius: 170,
    healRate: 16, // 每秒治疗量
  },
  carbinger: {
    id: 'carbinger',
    name: '卡宾兵',
    hp: 95,
    armor: 20,
    armorLevel: 2,
    speed: 138, // 机动：比巡逻兵快，贴脸前会先拉开中距火力
    radius: 11,
    color: '#c77d3a',
    weapon: {
      id: 'enemy_carbine', name: 'Mk18 卡宾枪', auto: true,
      damage: 10, rpm: 700, magSize: 30, reloadTime: 2.4,
      spread: 0.018, spreadPerShot: 0.011, spreadMax: 0.07, recoil: 0.02,
      range: 500, noiseRadius: 520, ammoItem: 'ammo556',
    },
    visionRange: 320,
    visionAngle: (80 * Math.PI) / 180,
    hearing: 400,
    reactionTime: 0.5,
    accuracy: 0.5,
    fireDelay: [0.7, 1.4],
    burst: [3, 5],
    preferredRange: 240, // 中距卡宾：比步枪近、比冲锋枪远
    score: 90,
    lootBonus: 1.2,
  },
  assault: {
    id: 'assault',
    name: '突击兵',
    hp: 120,
    armor: 35,
    armorLevel: 3,
    speed: 120,
    radius: 12,
    color: '#b04a2a',
    weapon: {
      id: 'enemy_akm', name: 'AKM 突击步枪', auto: true,
      damage: 17, rpm: 600, magSize: 30, reloadTime: 2.6,
      spread: 0.020, spreadPerShot: 0.012, spreadMax: 0.08, recoil: 0.024,
      range: 540, noiseRadius: 560, ammoItem: 'ammo762',
    },
    visionRange: 340,
    visionAngle: (84 * Math.PI) / 180,
    hearing: 420,
    reactionTime: 0.45,
    accuracy: 0.55,
    fireDelay: [0.6, 1.2],
    burst: [4, 6],
    preferredRange: 200, // 中近距泼水压制
    score: 120,
    lootBonus: 1.4,
  },
};

/**
 * 首领战阶段（P16）。
 *
 * 血量每跌破一个 `at` 阈值就进入下一阶段；倍率以「基础 def 快照」为基准计算，
 * 不是在上一个阶段上连乘 —— 否则三阶段会得到 1.15×1.3 这种失控数值。
 *
 * `at` 用**剩余血量比**（1 = 满血），从高到低排列；`label` 进 HUD，
 * `name` 进切换横幅（toast）。数值只作用在 Boss 实例的 def 副本上。
 */
export const BOSS_PHASES = [
  { id: 1, at: 1.0, label: '阶段 I', name: '压制', speedMul: 1, accuracyMul: 1, fireDelayMul: 1, damageMul: 1 },
  { id: 2, at: 0.66, label: '阶段 II', name: '狂怒', speedMul: 1.15, accuracyMul: 1.1, fireDelayMul: 0.85, damageMul: 1.1 },
  { id: 3, at: 0.33, label: '阶段 III', name: '绝境', speedMul: 1.3, accuracyMul: 1.18, fireDelayMul: 0.72, damageMul: 1.2 },
];

/**
 * 首领战的伤害规则（P16）。
 *
 * - `weakspotMul`：打在弱点（头部）时的**额外**倍率，叠在既有的部位倍率之上。
 *   Boss 血量 1800~2600，若弱点没有明显回报，玩家会退化成"对着甲泼子弹"。
 * - `brokenArmorMul`：护甲被打空后的承伤倍率。破甲前血条掉得极慢，
 *   必须给一个明确的正反馈，否则「打掉护甲」这件事在体感上不存在。
 */
export const BOSS_RULES = {
  weakspotMul: 1.5,
  brokenArmorMul: 1.15,
};

/**
 * 首领（Boss）：每张图一个，主题各异，是 P9 的核心新增。
 * 三种博弈原型刻意拉开，避免"换皮"：
 *   - depot  「钢铁壁垒」重火力压制：锚定据点、持续长点射、定时呼叫增援。
 *   - conduit「暗影」    高速侧翼伏击：绕到玩家侧后贴脸爆发，近身霰弹。
 *   - ridge  「鹰眼」    高地远程狙击：抢平台居高临下，远距离高伤，近了就撤。
 * 字段与 ENEMY_TYPES 同构（Enemy 直接拿 def 当 this.def），多出 behavior / leash /
 * reinforceInterval / flank / flankCd 等 Boss 专属字段，由 enemy.js 的 actBoss 读取。
 */
export const BOSSES = {
  depot: {
    id: 'boss_depot',
    mapId: 'depot',
    name: '钢铁壁垒',
    behavior: 'bulwark',
    theme: '重火力压制',
    canThrow: true,
    grenadeInterval: 16,
    hp: 2600,
    armor: 120,
    armorLevel: 4,
    speed: 74,
    radius: 18,
    color: '#8a5a2b',
    visionRange: 420,
    visionAngle: (110 * Math.PI) / 180,
    hearing: 520,
    reactionTime: 0.5,
    accuracy: 0.5,
    fireDelay: [0.6, 1.1],
    burst: [6, 9], // 持续压制长点射
    preferredRange: 280,
    holdsPosition: true,
    leash: 240, // 锚定据点，离出生点过远就拉回
    reinforceInterval: 22, // 交战中每 ~22s 呼叫 2 名增援
    score: 800,
    lootBonus: 4,
    weapon: {
      id: 'boss_mg', name: 'M2HB 重机枪', auto: true,
      damage: 9, rpm: 520, magSize: 80, reloadTime: 4.5,
      spread: 0.020, spreadPerShot: 0.010, spreadMax: 0.14, recoil: 0.030,
      range: 620, noiseRadius: 900, ammoItem: 'ammo556',
    },
  },
  conduit: {
    id: 'boss_conduit',
    mapId: 'conduit',
    name: '暗影',
    behavior: 'stalker',
    theme: '高速侧翼伏击',
    canThrow: true,
    grenadeInterval: 15,
    hp: 1800,
    armor: 70,
    armorLevel: 3,
    speed: 152,
    radius: 14,
    color: '#3a4a6a',
    visionRange: 360,
    visionAngle: (96 * Math.PI) / 180,
    hearing: 460,
    reactionTime: 0.4,
    accuracy: 0.55,
    fireDelay: [0.5, 1.0],
    burst: [4, 6],
    preferredRange: 110,
    flank: true,
    flankCd: 4, // 每 ~4s 重新选一个侧后突进点
    score: 800,
    lootBonus: 4,
    weapon: {
      id: 'boss_shotgun', name: 'AA-12 自动霰弹', auto: true,
      damage: 10, rpm: 320, magSize: 18, reloadTime: 2.6,
      spread: 0.060, spreadPerShot: 0.020, spreadMax: 0.22, recoil: 0.020,
      range: 180, noiseRadius: 520, ammoItem: 'ammo9mm',
    },
  },
  ridge: {
    id: 'boss_ridge',
    mapId: 'ridge',
    name: '鹰眼',
    behavior: 'sniper',
    theme: '高地远程狙击',
    canThrow: true,
    grenadeInterval: 17,
    hp: 2000,
    armor: 90,
    armorLevel: 4,
    speed: 96,
    radius: 15,
    color: '#caa23a',
    visionRange: 640,
    visionAngle: (70 * Math.PI) / 180,
    hearing: 380,
    reactionTime: 0.7,
    accuracy: 0.9,
    fireDelay: [1.6, 2.6],
    burst: [1, 1], // 单发高伤吊射
    preferredRange: 480,
    holdsPosition: true,
    leash: 320,
    score: 800,
    lootBonus: 4,
    weapon: {
      id: 'boss_sniper', name: 'AX-50 反器材狙击枪', auto: false,
      damage: 52, rpm: 28, magSize: 5, reloadTime: 3.6,
      spread: 0.002, spreadPerShot: 0.004, spreadMax: 0.01, recoil: 0.08,
      range: 1100, noiseRadius: 1000, ammoItem: 'ammo556',
    },
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
  // P9 感知协同：听声辨位不再所有兵种共用一个固定误差，也不再"各听各的"。
  perception: {
    noiseBaseError: 60, // 定位误差基准（世界单位）
    hearingRef: 420, // 基准听觉半径；兵种 hearing 越大 → 误差越小
    minError: 9, // 贴脸也有误差，避免 AI 全知全能
    shareNoiseRadius: 300, // 听到枪声后广播给友军的半径
    shareSearchInterval: 3.5, // 搜索态互通最后已知位置的间隔
  },
  // ---- P21 三通道感知 ----
  // 视觉：只算「有效视距」与锥角，可见性仍由 LOS 拍板（禁止透视的落点在 perception.js）
  sight: {
    crouchMul: 0.72, // 目标蹲伏 → 视距乘数
    bushMul: 0.4, // 目标在草丛且超过 bushDist → 视距乘数
    bushDist: 130, // 草丛隐蔽生效的最小距离（贴脸蹲草照样被发现）
    nearRadius: 90, // 贴脸不判视野锥（背后也能察觉）
    alertMul: 1.25, // 警戒巡逻态视距倍率
  },
  // 痕迹：脚印/弹壳/血迹/尸体。AI 踩到 → 转调查，调查是「跟着线索走」不是「知道你在哪」。
  traces: {
    enabled: true,
    max: 64, // 世界内痕迹上限（超出丢最旧的）
    mergeCell: 42, // 合并网格边长（世界单位）：同格只刷新，不新增
    footprintEvery: 1.15, // 玩家常速移动的留痕间隔（秒）
    sprintEvery: 0.6, // 冲刺留痕间隔（秒）
    coneHalf: 1.15, // 发现痕迹的半锥角（弧度，约 66°）
    investigateRadius: 260, // 发现痕迹的半径
    minConfidence: 0.22, // 低于此可信度不理会
    life: { footprint: 18, shell: 34, blood: 60, body: 90 }, // 各类痕迹存活秒数
  },
  // 压制：被打中/子弹擦过 → 精度下降、开火变慢、找掩体。压制不提供目标坐标（不透视）。
  suppression: {
    onNearMiss: 0.42, // 子弹擦过时累加
    onHit: 0.55, // 被命中时累加
    nearMissRadius: 110, // 「擦过」的判定半径（弹着点到敌人的距离）
    decay: 0.34, // 每秒自然衰减
    coverAt: 0.55, // 超过此值主动找掩体
    spreadMulAtMax: 0.62, // 满压制时精度乘数
    fireDelayMulAtMax: 1.9, // 满压制时开火间隔乘数
  },
  // 状态时长：待机 / 调查 / 警戒巡逻
  states: {
    idleMin: 2.5, // 待机停留下限（秒）
    idleMax: 5.5, // 待机停留上限（秒）
    investigateTime: 6.5, // 调查态最长时长（超时转搜索）
    investigateArrive: 60, // 判定「到点」的半径
    alertPatrolTime: 26, // 警戒巡逻持续时长，到期回普通巡逻
    suppressReposition: 0.9, // 找掩体的最短间隔（秒），避免每帧重选
  },
  // 阵地归属：敌人有自己的"家"（出生点）。
  // 参考同类型撤离射击的做法：AI 追丢目标后不是全图随机游走，而是先回自己那片区域。
  // 玩家因此能读出"这块地是谁的"，而不是刚清完的房间又冒出从地图另一头溜达过来的人。
  home: {
    enabled: true,
    leash: 460, // 离家超过该距离 → 巡逻目标改为返家点
    arrive: 90, // 距家小于该距离视为"已回防"，恢复本来的巡逻路线
    speedMul: 0.9, // 回防路上略慢（不是溃逃，也不该像冲锋）
  },
  // 躲投掷物：只躲会炸的（破片/震撼/燃烧），烟幕不躲（躲烟等于放弃视野）
  grenadeDodge: {
    radius: 150, // 感知半径（世界单位）
    fleeDist: 190, // 逃逸目标距离
    speedMul: 1.35, // 逃逸速度倍率
    cooldown: 0.6, // 两次逃逸判定的间隔，避免每帧改方向抽风
    minFuse: 0.25, // 引信低于此值就别跑了（跑不掉，站着反而少演）
    skipKinds: ['smoke'], // 不躲的类型
  },
};

/** 地图生成时各兵种的权重（相加无须为 100，走 rng.weighted） */
export const ENEMY_SPAWN_WEIGHTS = {
  patrol: 38,
  rusher: 20,
  marksman: 16,
  elite: 16,
  shotgunner: 12, // P9：近距离爆发
  machinegunner: 8, // P9：持续压制
  medic: 6, // P9：治疗支援（数量少，避免变成不死军团）
  carbinger: 14, // P13：机动卡宾，中距火力
  assault: 14, // P13：突击步枪，中近距泼水
};

/* ============================== 战斗数值 ============================== */

/**
 * G-01 TTK 目标区间（秒）。TODO(Q-05)：蓝图建议默认「中」=0.35~0.70（撤离）。
 * 当前实测是快 TTK（0.19~0.47），本表先作为标定目标与测试口径落地，
 * 不直接改武器/护甲数值 —— 拍板前改数值会让整局手感与既有平衡测试全变。
 */
export const TTK_TARGET = {
  raid: { min: 0.35, max: 0.70 },
  warfare: { min: 0.50, max: 0.95 }, // 大战场跳过（硬约束），仅占位备查
};

export const COMBAT = {
  armorK: 120, // 护甲减伤系数：减伤 = armor / (armor + K)
  armorDurabilityLoss: 0.55, // 每点原始伤害消耗的护甲耐久
  helmetK: 70, // 头盔更高系数：同样耐久能挡下更大比例的爆头伤害
  helmetDurabilityLoss: 0.7, // 头盔吃到的爆头伤害转化耐久损耗（比胸甲快）
  penPerLevel: 0.09, // 弹种穿透每高一级，护甲减伤乘 1-0.09
  penFactorMin: 0.65, // 穿透压制上限（再高也保留 65% 减伤，不至于完全无视护甲）
  penFactorMax: 1.15, // 穿透不足时的惩罚上限
  // P7 部位系统：按命中高度在身体总高里的比例切三段。
  // 0~limbAt=腿，limbAt~headAt=胸腹，headAt~1=头。
  zones: {
    headAt: 0.82,
    limbAt: 0.45,
    headMul: 1.9,
    chestMul: 1.0,
    limbMul: 0.85,
  },
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
  // --- 扩散曲线（P4-C2）---
  spreadRecover: 2.6, // 扩散恢复速率（每秒，武器可用 def.spreadRecover 覆盖）
  firstShotMul: 0.55, // 本轮第一发的扩散系数（点射奖励：首发比泼水准得多）
  moveSpreadK: 0.55, // 走动时扩散放大系数（moveMag 0~1 线性）
  sprintSpreadK: 0.50, // 冲刺时额外放大系数（叠在走动之上）
  adsRate: 9, // 开镜过渡速率（1/s，约 0.22s 达到 87%、0.35s 基本到位）
  // 轻度辅助瞄准（仅玩家、仅偏航）：准星靠近敌人时把这一发小幅吸过去，不做全自动锁头。
  // enabled 由 save.settings.aimAssist 在启动时写入，可在暂停菜单关闭。
  // --- 动作状态机（P19）---
  // 冲刺退出后必须先把枪抬起来才能开火；按武器大类分档，越重越慢。
  // 键与 combatstate.weaponClassOf 一一对应，缺档时回落 ar。
  sprintRaise: { pistol: 0.15, smg: 0.20, ar: 0.27, shotgun: 0.30, lmg: 0.42, sniper: 0.45 },
  // 冲刺中按下开火 → 立即打断冲刺，只留这段「抬枪收尾」（秒）而不是整段 sprintRaise。
  // 0.10s 让玩家手指按下即出弹（<0.15s），同时保留 raiseT 散布惩罚（第一发明显更散）。
  sprintFireRaise: 0.10,
  // 切枪耗时：掏手枪最快（战术救场），主武器互换最慢。
  switchTime: { toPistol: 0.45, fromPistol: 0.55, primary: 0.80 },
  // 抬枪期间按开镜键可加速（举枪同时贴腮），但不会瞬间归零。
  raiseAdsSpeedMul: 1.9,
  raiseSpreadK: 2.2, // 抬枪未完成时的额外扩散倍率（抬枪进度 0→1 线性）
  crouchSpreadMul: 0.85, // 蹲伏腰射扩散系数（0.8~0.9）
  crouchRecoilMul: 0.90, // 蹲伏后坐系数（0.85~0.95）
  // 卧倒：架枪最稳的一档（真枪有脚架/肘撑），但代价是移速 0.26 + 起身硬直 0.35s，
  // 所以不需要再叠额外惩罚，否则卧倒会变成"没人用"的摆设。
  proneSpreadMul: 0.68,
  proneRecoilMul: 0.78,
  adsMoveMul: 0.55, // 开镜完成后的移速系数（0.45~0.65）
  reloadMoveMul: 0.80, // 换弹中移速系数（0.7~0.9）
  // 探头：侧移量（米）、移速系数与探出时的散布惩罚（防止零成本对枪）。
  lean: { offsetM: 0.42, speedMul: 0.72, spreadMul: 1.12, adsSpeedMul: 1.0 },
  aimAssist: { enabled: true, coneDeg: 7, strength: 0.45 },
  // --- P22 玩家压制 ---
  // AI 早就有压制（见 AI.suppression），玩家一直没有：被打了只有掉血反馈，没有"被火力钉住"的紧张感。
  // 这里只给**玩家**用：敌方子弹擦过 / 命中 → 累积压制值 → 扩散放大 + HUD 边缘血色。
  // 全部确定性（sin 呼吸曲线，不抽 rng），压制值 0 时与旧版逐位一致。
  playerSuppression: {
    enabled: true,
    onNearMiss: 0.32, // 子弹擦过时累加
    onHit: 0.46, // 被命中时累加（比擦过更狠）
    nearMissRadius: 96, // 「擦过」判定半径（世界单位，玩家比敌人贴脸）
    decay: 0.52, // 每秒自然衰减
    spreadMulAtMax: 1.45, // 满压制时玩家扩散乘数（约等于腰射多走一步）
    vignetteAtMax: 0.55, // HUD 边缘血色强度上限
    breatheHz: 1.7, // 压制抖动的呼吸频率（供 HUD 准星/边缘使用）
  },
};

/**
 * 战地医疗（P7）。
 *
 * 这里只放**阈值与速率**，判定逻辑在 src/medical.js。设计上全部确定性：
 * 不掷随机数 —— 世界主随机流还要喂 AI / 散布 / 掉落，医疗判定多抽一次会让同 seed 整局漂移。
 * 所以"这一枪会不会打出血"由伤害值与命中部位决定，玩家可以学会预期。
 */
export const MEDICAL = {
  bleed: {
    maxStacks: 3,
    perStackDps: 0.9, // 每层每秒掉血
    minDamage: 12, // 单发达到该伤害才有概率... 这里是确定触发
    limbMinDamage: 8, // 四肢命中门槛更低（更容易打穿血管）
    limbStacks: 2, // 四肢命中直接叠两层
  },
  fracture: {
    heavyHit: 42, // 单发达到该伤害直接骨折（狙击/近距离）
    hpFrac: 0.3, // 或生命掉到上限的 30% 以下
    maxHpMul: 0.75, // 骨折期间生命上限乘数
    moveMul: 0.88, // 骨折期间移速乘数
    sprintMul: 0.75, // 骨折期间冲刺额外乘数
  },
  tickInterval: 0.5, // 流血伤害的结算间隔（秒）—— 不必每帧扣，0.5s 一跳更好读
  bleedSfxEvery: 2.4, // 流血提示音/闪红的节流
};

/* ============================== 后坐模式（P4 枪感） ============================== */

/**
 * 可学习的后坐曲线（纯数据，逻辑在 src/recoil.js）。
 *
 * 每把枪一条固定曲线：pitch 是抬枪倍率（首发最猛，随后递减到平台），
 * yaw 是水平偏移倍率（左右交替、幅度递增）。数组长度即一个周期，超出后循环。
 * 倍率的基数是武器自身的 `def.recoil`，所以改单发后坐会整条曲线等比缩放。
 *
 * ⚠ 只有玩家走这条曲线：敌人仍用随机后坐，避免改变既有 PVE 难度。
 */
export const RECOIL = {
  resetGap: 0.30, // 停火超过该秒数 → 弹道序号归零（点射比泼水准的机制来源）
  noise: 0.15, // 曲线之上的随机扰动（占单发后坐比例），保留"枪味"但不破坏可学性
  patterns: {
    rifle: {
      pitch: [1.30, 1.15, 1.05, 0.98, 0.92, 0.88, 0.84, 0.80, 0.77, 0.74, 0.72, 0.70],
      yaw: [0, 0.18, -0.40, 0.52, -0.66, 0.78, -0.86, 0.80, -0.90, 0.86, -0.92, 0.88],
    },
    smg: {
      pitch: [1.22, 1.08, 1.00, 0.94, 0.90, 0.86, 0.83, 0.80, 0.77, 0.75, 0.73, 0.71],
      yaw: [0, 0.22, -0.46, 0.58, -0.72, 0.84, -0.92, 0.86, -0.96, 0.92, -0.98, 0.94],
    },
    pistol: {
      pitch: [1.35, 1.05, 0.92, 0.86, 0.82, 0.80, 0.78, 0.76, 0.75, 0.74, 0.73, 0.72],
      yaw: [0, 0.10, -0.22, 0.30, -0.40, 0.48, -0.55, 0.52, -0.58, 0.56, -0.60, 0.58],
    },
    // P13-B：7.62 两把独立后坐曲线（DMR 首发猛、战斗步枪水平游移更明显）
    dmr: {
      pitch: [1.45, 1.30, 1.20, 1.12, 1.05, 1.00, 0.96, 0.93, 0.90, 0.88, 0.86, 0.84],
      yaw: [0, 0.20, -0.42, 0.55, -0.68, 0.80, -0.88, 0.84, -0.90, 0.86, -0.92, 0.88],
    },
    battle: {
      pitch: [1.32, 1.18, 1.08, 1.00, 0.94, 0.90, 0.86, 0.83, 0.80, 0.78, 0.76, 0.74],
      yaw: [0, 0.24, -0.50, 0.62, -0.78, 0.90, -0.98, 0.92, -1.02, 0.98, -1.04, 1.00],
    },
    // 未登记的武器（含敌方武器被人捡起改装的极端情况）统一走这条中庸曲线
    default: {
      pitch: [1.25, 1.10, 1.00, 0.94, 0.90, 0.86, 0.83, 0.80, 0.78, 0.76, 0.74, 0.72],
      yaw: [0, 0.16, -0.36, 0.48, -0.60, 0.72, -0.80, 0.76, -0.84, 0.80, -0.86, 0.82],
    },
  },
};

/**
 * 换弹节奏（P4-C3）的**单一真值源**。
 *
 * 改造前换弹是"一个计时器 + 一条指数平滑"：整段 2~3 秒里枪身匀速沉下去再匀速抬回来，
 * 听感只有开头两声咔哒，中间两秒完全没有信息。这里把进度切成三段，各段给不同的
 * 枪身姿态与音效提示，换弹才变成"有节奏的动作"而不是"一段黑屏等待"。
 *
 * 关键点：`at` 是进度比例（0~1），不是秒数 —— 不同枪 reloadTime 从 1.7s 到 3.4s 不等，
 * 用比例分段才能让长枪短枪的节奏感一致；秒数只在音效延迟里由 reloadTime 换算。
 */
export const RELOADFX = {
  // 三段边界（进度比例，必须严格递增）。mag-out 退弹匣 / mag-in 插弹匣 / charge 拉机柄
  stages: [
    { key: 'mag-out', at: 0.0 },
    { key: 'mag-in', at: 0.30 },
    { key: 'charge', at: 0.72 },
  ],
  // 枪身姿态曲线关键帧：p 进度 → drop（下沉，米）/ roll（侧翻，弧度）/ pump（沿枪轴抖动，米）
  // 数值是「倍率」，最终乘 VIEW3D.viewmodel.reloadDrop / reloadRoll。
  // 弹匣落位与机柄拉到位各有一处局部峰值，这两处就是玩家能"听/看到节奏"的锚点。
  pose: [
    { p: 0.00, drop: 0.00, roll: 0.00, pump: 0.00 },
    { p: 0.06, drop: 0.18, roll: 0.06, pump: 0.00 },
    { p: 0.18, drop: 1.00, roll: 0.85, pump: 0.00 }, // 弹匣脱出
    { p: 0.24, drop: 0.90, roll: 0.96, pump: 0.10 },
    { p: 0.30, drop: 0.98, roll: 0.90, pump: 0.00 },
    { p: 0.42, drop: 0.72, roll: 0.55, pump: -0.12 },
    { p: 0.55, drop: 0.78, roll: 0.62, pump: 0.00 },
    { p: 0.72, drop: 0.80, roll: 0.66, pump: 0.00 }, // 新弹匣到位
    { p: 0.80, drop: 0.58, roll: 0.72, pump: 0.26 }, // 拉机柄到底
    { p: 0.88, drop: 0.30, roll: 0.34, pump: -0.08 },
    { p: 0.95, drop: 0.07, roll: 0.08, pump: 0.00 },
    { p: 1.00, drop: 0.00, roll: 0.00, pump: 0.00 },
  ],
  // 音效延迟（相对换弹开始，秒）—— 按段起点比例 × reloadTime 换算，这里只给额外微调
  cueNudge: { 'mag-out': 0.0, 'mag-in': 0.01, charge: 0.0 },
  // 空仓换弹（弹匣打空）比战术换弹慢一点：玩家要为"打光"付代价
  emptyPenalty: 1.18,
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
  items: [
    'rifle', 'smg', 'pistol', 'carbine', 'pdw', 'lmg', 'dmr', 'battle', 'shotgun', 'lv2', 'lv3', 'helmet_lv2', 'helmet_lv3',
    // W2：近战 / 背包 / 胸挂。匕首是最便宜的"保命不花弹"手段，放 Lv.1 就能买。
    'knife', 'knife_heavy', 'bp_lv1', 'bp_lv2', 'bp_lv3', 'rig_lv1', 'rig_lv2',
    'ammo556', 'ammo556ap', 'ammo556sub', 'ammo9mm', 'ammo9mmap', 'ammo9mmhp',
    'ammo762', 'ammo762ap', 'ammo762sub',
    'ammo12ga', 'ammo12gabuck', 'ammo12gaslug',
    'medkit', 'bandage', 'pill', 'surgery', 'armorKit',
  ],
  // P10：限购额度由局外生涯层按本地日期重置，未列出的货品默认不限购。
  // 数值保持温和：一天买空全部额度约需 ¥1.2 万，远高于单局正常收益。
  restock: {
    rifle: 1, smg: 1, pistol: 2, carbine: 1, pdw: 1, lmg: 1, dmr: 1, battle: 1, shotgun: 1,
    lv2: 2, lv3: 1, helmet_lv2: 2, helmet_lv3: 1,
    knife: 2, knife_heavy: 1, bp_lv1: 2, bp_lv2: 1, bp_lv3: 1, rig_lv1: 2, rig_lv2: 1,
    ammo556: 10, ammo556ap: 6, ammo556sub: 6,
    ammo9mm: 10, ammo9mmap: 6, ammo9mmhp: 6,
    ammo762: 10, ammo762ap: 6, ammo762sub: 6,
    ammo12ga: 12, ammo12gabuck: 6, ammo12gaslug: 6,
    medkit: 6, bandage: 8, pill: 6, surgery: 3, armorKit: 3,
  },
};

/** 装备保险：战前付保费，撤离失败时只赔「带进去的武器与护甲」，随身物资照旧丢失。 */
export const INSURANCE = { enabled: true, rate: 0.18 };

/** 军械商声望：撤离带出的估值换经验，等级决定商店能买什么。 */
export const REP = {
  levels: [
    { level: 1, need: 0, label: '新兵' },
    { level: 2, need: 300, label: '熟客' },
    { level: 3, need: 900, label: '军需商' },
    { level: 4, need: 2000, label: '黑市渠道' },
  ],
  xpPerValue: 0.01, // 每带出 ¥100 得 1 点经验
  deathXp: 0.3, // 阵亡也留 30% 经验，避免一次失败清零挫败
};
export const SHOP_TIER = {
  rifle: 2, smg: 2, carbine: 2, pdw: 2, lmg: 3, dmr: 2, battle: 2, shotgun: 2, lv3: 3,
  // W2：匕首入门即得，砍刀与好包/胸挂需要军械商声望到 Lv.2，顶级背囊 Lv.3。
  knife_heavy: 2, bp_lv2: 2, bp_lv3: 3, rig_lv2: 2,
}; // 未写进表里的默认 Lv.1

export const START_CURRENCY = 4000;

/** 破产保护：资金低于阈值且仓库无武器时补发 */
export const BAILOUT = { currency: 900, minCurrency: 1500 };

/* ============================== 局外生涯（P10） ============================== */

/**
 * 局外生涯：成就 / 每日任务 / 商店限购 / 声望补给 / 本地委托单。
 *
 * 数值基调刻意温和：单项奖励 ¥200~1500，与 SCORING.ratingBonus(S=1500) 同量级，
 * 不修改任何既有价格、评级奖励或局内数值；全部由本地存档与种子推导，零联网。
 * metric 分两类：累计型读 save.stats，单局型读 endRaid 传进来的 raidCtx。
 */
export const CAREER = {
  achievements: Object.freeze([
    { id: 'first_extract', name: '平安归来', desc: '成功撤离 1 次', metric: 'extracts', goal: 1, reward: 300 },
    { id: 'extract_10', name: '常客', desc: '累计撤离 10 次', metric: 'extracts', goal: 10, reward: 800 },
    { id: 'raids_20', name: '老兵', desc: '累计完成 20 次行动', metric: 'raids', goal: 20, reward: 1000 },
    { id: 'kills_25', name: '清场', desc: '累计击杀 25 名敌人', metric: 'kills', goal: 25, reward: 600 },
    { id: 'score_1200', name: '高分行动', desc: '单局评分达到 1200', metric: 'bestScore', goal: 1200, reward: 500 },
    { id: 'value_5000', name: '搬运工', desc: '单局带出物资估值达到 ¥5000', metric: 'bestValue', goal: 5000, reward: 700 },
    { id: 'codex_10', name: '收藏家', desc: '图鉴带出 10 种物资', metric: 'codex', goal: 10, reward: 600 },
    { id: 'boss_down', name: '斩首', desc: '击倒 1 名首领', metric: 'bossDown', goal: 1, reward: 1500 },
  ]),
  quests: Object.freeze({
    count: 3,
    pool: Object.freeze([
      { id: 'q_extract', name: '平安归来', desc: '成功撤离 1 次', metric: 'extract', goal: 1, reward: 300 },
      { id: 'q_kills', name: '压制火力', desc: '累计击杀 3 名敌人', metric: 'kills', goal: 3, reward: 250 },
      { id: 'q_search', name: '翻箱倒柜', desc: '累计搜索 4 个容器', metric: 'searches', goal: 4, reward: 200 },
      { id: 'q_value', name: '带点硬货', desc: '累计带出估值 ¥1500', metric: 'value', goal: 1500, reward: 350 },
      { id: 'q_terminal', name: '数据回收', desc: '破解 1 个数据终端', metric: 'terminals', goal: 1, reward: 300 },
      { id: 'q_survive', name: '稳住', desc: '累计存活 240 秒', metric: 'survived', goal: 240, reward: 200 },
    ]),
  }),
  repRewards: Object.freeze([
    { level: 2, name: '熟客补给', reward: 400 },
    { level: 3, name: '军需配额', reward: 800 },
    { level: 4, name: '黑市授信', reward: 1500 },
  ]),
  /** 本地委托单：把仓库物资交给本地模拟的收购商，到期按确定性报价结算。 */
  consign: Object.freeze({
    fee: 0.05,          // 收购商手续费
    settleMs: 120000,   // 2 分钟后成交（本地时间戳，不取服务器）
    maxOrders: 6,       // 同时最多 6 张委托单
    rarityMul: Object.freeze({ common: 1.0, rare: 1.04, epic: 1.08, legendary: 1.12 }),
  }),
};

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
  ratingBonus: { S: 1500, A: 800, B: 400, C: 150, D: 0 },
};

/* ============================== 视觉 ============================== */

/**
 * P0 全局视觉令牌（三角洲式战术视觉语言）—— JS 侧唯一真值源。
 *
 * styles.css 顶部有逐字一致的 --df-* 定义。零构建项目没有变量注入，
 * 所以靠 tests/theme.test.mjs 做静态一致性校验把两边锁住：改色改一处，
 * 忘了改另一边会直接红测试。
 *
 * 边界：shared/tokens.css 管的是「中性尺度」（圆角/间距/字阶/动效/层级），
 * 它自己声明「主色一律不进这里，每个游戏保留自己的气质」——
 * 所以本块只管颜色与战术形状语言，两者不重叠、不互相覆盖。
 *
 * 字体说明：不能引入外部字体文件（单机零联网、零新增素材）。
 * --df-sans / --df-label / --df-mono 是本地字体栈：装了 Noto Sans SC /
 * Barlow Condensed / JetBrains Mono 就用，没装则回退到系统自带字体，
 * 靠大写、0.08em 字距、tabular-nums 维持战术标签的识别度。
 */
export const DF = {
  bg: '#07090B',
  panel: 'rgba(14,17,20,0.92)',
  line: 'rgba(255,255,255,0.10)',
  text: '#F2F4F5',
  dim: '#8C9299',
  accent: '#FF5A1F',
  danger: '#FF3B30',
  ok: '#39D98A',
  info: '#4FA3FF',
  // 六级稀有度：白 / 绿 / 蓝 / 紫 / 金 / 红
  rarity: {
    white: '#F2F4F5',
    green: '#39D98A',
    blue: '#4FA3FF',
    purple: '#B45CFF',
    gold: '#FFB020',
    red: '#FF3B30',
  },
  // 形状 / 动效：CSS 侧同名，P1/P2 逐屏接入
  radius: 2,
  cut: 8,
  tFast: 120,
  tBase: 180,
};

const _dfAlphaCache = new Map();

/**
 * 把 #RRGGBB 变成 rgba() 字符串，带 LRU 上限的缓存。
 * HUD 每帧要取几十次半透明色，纯字符串拼接会撑大 GC；动态 alpha
 * （命中标记淡出这类）会不断产生新 key，所以缓存到 256 条就整表清空，
 * 保证内存有界 —— 别换成无上限 Map。
 *
 * 只接 #RRGGBB；传 rgba()/非 hex 时原样返回，避免 parseInt 出 NaN 颜色。
 */
export function dfAlpha(hex, a) {
  if (typeof hex !== 'string' || hex[0] !== '#' || hex.length !== 7) return hex;
  const key = hex + '|' + a;
  const hit = _dfAlphaCache.get(key);
  if (hit !== undefined) return hit;
  const n = parseInt(hex.slice(1), 16);
  if (!Number.isFinite(n)) return hex;
  const v = `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  if (_dfAlphaCache.size > 256) _dfAlphaCache.clear();
  _dfAlphaCache.set(key, v);
  return v;
}

export const COLORS = {
  bg: DF.bg,
  panel: DF.panel,
  line: DF.line,
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
  accent: DF.accent,
  // 旧青色 accent2 退役：改中性信息蓝，仍沿用字段名以免动到小地图调用点
  accent2: DF.info,
  danger: DF.danger,
  ok: DF.ok,
  text: DF.text,
  dim: DF.dim,
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
  showEnemies: false,     // 敌人红点（调试：显示所有交火/怀疑目标）
  showSpottedEnemies: true, // P1：只显示**已交火且近距离**的敌人（互相暴露才标红）
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
  enemyPatrol: '#4E5747', // 巡逻兵：橄榄灰（原来 #9CA3AF 是浅灰，月光下直接读成白板）
  enemyElite: '#7A3A32', // 精英：暗锈红（保留辨识度，但不再是一身霓虹红）
  enemyMarksman: '#4C4A63', // 精确射手：灰紫（同色相压饱和）
  enemyRusher: '#6E5638', // 冲锋兵：沙褐（原来 #E08A3C 太亮，像穿了荧光背心）
  vmBody: '#393E36',
  vmDark: '#22281F',
  sky: '#1A2430',
  fog: '#33465C', // P0-2 提亮雾色：远处不再被压成死黑（与提亮后的天空协调）
  dust: '#C9D6E4', // 空气尘埃颜色
  ceiling: '#343B35', // 天花板基色：明显暗于墙（#5C5F52）。原来与墙几乎同亮，
  // 抬头看分不出"有顶"还是"天空"——染红做 A/B 才确认顶一直在，只是配色读不出来。
  ceilingBeam: '#5C655A', // 结构横梁：略亮于天花板（原 #33392F 太暗，沿视线那根会投影成深色巨楔）
  hemiSky: '#A7BBD1', // 天光颜色：原来 #93C5FD 饱和度过高，主光一压过填充光，水平面就整片发蓝
  hemiGround: '#475569',
  dirLight: '#FFF7ED',
  ambient: '#3C4C66',
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
  hand: '#8C6E52', // 皮肤：原来 #C8A07A 在月光下会白到发光（近景像戴了白面具）
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
 * 若按字面把 4.2 当作 4.2 个场景单位，墙会比敌人的碰撞直径（22 单位）还矮，场景完全不成立。
 * 因此统一引入换算：1 米 = metersToUnits 个逻辑单位。
 * 该系数由既有逻辑数值反推：玩家碰撞半径 12 单位 ≈ 0.6 m ⇒ 1 m = 20 单位。
 * 换算后：tile=2m、地图=192×144m、墙高=4.2m、眼高=1.65m —— 与 2D 版的手感完全一致。
 * 逻辑坐标与全部纯逻辑模块**不受影响**。
 */
export const VIEW3D = {
  /** 1 米 = 多少个逻辑单位（= 场景单位）。所有以米为单位的尺寸在建模时乘上它。 */
  metersToUnits: 20,

  // --- 高度与尺寸（单位：米，使用时 × metersToUnits） ---
  // 层高：旧值 3.2m 是"住宅层高"，放在仓库/厂房里显得压抑，跳一下头顶就快贴板了。
  // 4.2m 是轻工业厂房/物流仓的实际层高，跳跃（0.45m）+ 站上平台（1.25m）都还有余量。
  wallHeight: 4.2,
  crateHeight: 1.5, // 掩体箱高度
  platformHeight: 1.25, // 架高平台高度（米）：站上去抬高视点，并能越过掩体箱观察
  extractBeamHeight: 22, // 撤离点光柱高度
  groundY: 0,

  // --- 相机 ---
  eyeStand: 1.65, // 站立眼高
  eyeCrouch: 1.0, // 蹲下眼高
  eyeProne: 0.34, // 卧倒眼高（贴地，视角几乎与掩体箱底部齐平）
  // 玩家受击竖直包围体（单位：米）。敌人 3D 弹道以它判定能否命中玩家；
  // 不随蹲伏收缩（蹲下只改玩家自身视点，不改受击盒），避免蹲伏变成水平火力的「绝对护盾」。
  playerHitboxH: 1.8, // 受击盒总高（地面到头顶）
  playerCenterM: 0.9, // 身体中心高度：敌人俯仰瞄准的竖直基准点
  eyeLerp: 11, // 眼高插值速率（越大越快）
  fov: 75, // 腰射 FOV
  fovAds: 55, // 瞄准 FOV
  fovLerp: 12, // FOV 插值速率
  near: 3, // 近裁剪面（0.15 m）：枪模前移后枪托要留在裁剪面外，太远会把枪切掉
  far: 2200, // 远裁剪面（地图对角线 3000，靠雾收边）
  pitchLimit: (85 * Math.PI) / 180, // pitch 限幅
  sensitivity: 0.0022, // 鼠标灵敏度（弧度 / 像素）
  maxPixelRatio: 1.75, // devicePixelRatio 上限，防止高分屏掉帧
  minPixelRatioFallback: 1, // 自适应降级第 3 级：帧率仍不足时把像素比压到 1

  // --- 光照与氛围 ---
  // 0.005/m：0.012 时 60m 外就被雾吃掉（192×144m 的图只剩眼前一团），
  // 缩到 0.005 后 100m 仍能辨认轮廓 —— 大地图的"远"必须看得见才成立。
  fogDensityPerMeter: 0.005,
  // #24 暗色光照小幅调优：夜战氛围不变，但暗部不再死黑、可读性更稳。
  // hemi 抬天光填充、ambient 抬阴影底色、dir 维持主光不变量；三值均小幅上调。
  // #P0-2（2026-10-31）夜战可见性：原暗部过黑导致 30m 外敌人/物资难辨。
  // ambient/hemi 大幅抬升（已接近并超过主光 dir 的 2.1），让天花板遮挡主光后的室内
  // 仍有充分填充光；仍保留夜战氛围（暗调、冷色环境光）。
  // W5 光照重标定：填充光必须让位给主光。
  // 旧值 ambient 17 / hemi 26 是"没有色调映射"那条链路下的夜战可读性补丁：环境光把所有面的
  // 入射光拉平，N·L 失去意义，墙面、箱体、加强筋全变成同一亮度 —— 这才是"塑料玩具感"的根因。
  // 现在 ACES 真正生效（曝光可调），暗部靠曝光而不是靠环境光托，方向性才回得来。
  // 6/4/9 是 A/B 实测定档：广场 mean 0.278、死黑 5%，室内 mean 0.24、死黑 8.8%（夜战该有暗角）。
  hemiIntensity: 3,
  ambientIntensity: 2.2,
  dirIntensity: 5.2, // 主光：唯一产生明暗与投影的光源，必须压过填充光
  dirLightOffset: { x: 620, y: 760, z: 420 }, // 平行光相对聚焦点的偏移（单位）
  shadowRadius: 32, // 阴影视锥半径（米）
  shadowNear: 1,
  shadowFar: 2400,
  shadowMapSize: 2048,
  shadowMapSizeFallback: 1024, // 帧率不足时的降级尺寸
  shadowBias: -0.0009,
  // 玩家头灯（夜战探照）：始终开启，跟随相机向前打出 15m 锥形光。
  // decay=0 让光强在 15m 内保持恒定（便于校准，避免近处过曝、远处全黑），
  // 到 distance 处再平滑收边（penumbra 控制软硬）。
  headlight: {
    color: '#FFE9C2',
    intensity: 5.0,
    distance: 15, // 米，建模时 × metersToUnits
    angle: 0.62, // 弧度（≈35° 半角）
    penumbra: 0.45,
    decay: 0,
  },
  // 敌人/物资的轻微自发光：暗处至少保留一层"底亮度"轮廓，不至于死黑不可见。
  // 敌人用偏冷的自发光，使其在暗背景中也能被一眼辨识（30m 外仍可见）。
  // 自发光只做暗处轮廓保底，绝不能当补光用：emissive 不受光照影响，
  // 给到 1.6 会把整具模型压成一块纯色（塑料感的另一半来源）。
  enemyEmissive: '#2A3A4A',
  enemyEmissiveIntensity: 0.35,
  lootEmissive: '#6A5230',
  lootEmissiveIntensity: 0.55,

  // --- 画面质量（色调映射 / 环境反射 / 气氛） ---
  // ACES 色调映射是"从能看变成能看"的关键一步：没有它，Standard 材质在强光下会直接
  // 过曝成一片死白，整体观感发灰发平。
  toneMappingExposure: 0.78, // ACES 曝光基准（与 GRADE3D.exposure 同口径，两条渲染路径必须一致）
  envIntensity: 0.85, // 程序化环境贴图强度（给 Standard 材质提供天光反射）
  envMapSize: 128, // 环境贴图（PMREM）分辨率，越大越细腻但生成越慢
  skyTop: '#26344A', // 天空渐变顶部（P0-2 提亮：夜空不再是死黑，env 贴图随之变亮）
  skyMid: '#3E5168', // 天空渐变中部（地平线附近）
  skyBottom: '#5A6E82', // 天空渐变底部
  dustCount: 420, // 空气尘埃粒子数（营造体积感，0 = 关闭）
  dustRadius: 70, // 尘埃分布半径（米，跟随相机的局部范围）
  dustSize: 0.035, // 尘埃颗粒大小（米）
  // W7 反光修复：地面法线碎高光的主因是 normalScale 太大 + metalness/env 太高。
  // A/B（tools/ab-ground-reflection.mjs）证明：关 env/roughMap 会变暗（高光也是亮度来源），
  // 正解是压低法线坡度 + 地面专享 metalness=0 / env=0.5 / 粗糙度提高，再补一点顶点色反照率。
  groundRoughness: 0.92, // 地面粗糙度（原 0.86 偏亮，湿滑感）
  groundMetalness: 0, // 地面不反光金属化（全局 metalness 0.06 保留给金属件）
  groundEnvIntensity: 0.5, // 地面环境反射（原 0.85 让月光碎斑太强）
  wallRoughness: 0.76, // 墙面 / 掩体箱粗糙度
  // W8 白板感修复：墙与平台台面的顶点色在夜战灯光区偏亮（A/B 实测 mean 0.368，
  // 压到 0.6 后 0.301、观感明显更夜间军事且不死黑）。统一乘这个系数压反照率，
  // 不碰已验证过的地面专享参数与光区。env/metal 与白板无关（A/B 关掉几乎无变化）。
  wallAlbedoScale: 0.72,
  metalness: 0.06, // 非金属表面的基础金属度（略微给一点，增加反射层次）

  // --- 敌人模型 ---
  // 局内角色比例：**按真人重标定**（总高 ≈1.7~1.85m，腿长占身高 48~50%，头宽/肩宽 ≈0.36）。
  // 旧值是给"10~40m 外的剪影识别"调的：腿只占 35%、头肩比 0.53 —— 远看是个能认的方块人，
  // 但本作是 CQB，敌人经常站在 3m 内，凑近就是大头娃娃（截图一眼"这不是三角洲"）。
  // 现在远看依然是清晰剪影（头盔/背心/背包三层轮廓），近看比例经得起看。
  // ⚠ combat.js 的命中高度直接由 legH + torsoH + headR*2 推导，改这里命中区自动跟随。
  enemy: {
    patrol: { torsoW: 0.50, torsoH: 0.60, torsoD: 0.27, headR: 0.115, legH: 0.86 }, // ≈1.69m
    elite: { torsoW: 0.56, torsoH: 0.64, torsoD: 0.30, headR: 0.118, legH: 0.88 }, // ≈1.76m
    // 冲锋兵：更瘦小灵活，和"高速贴脸"的定位呼应
    rusher: { torsoW: 0.46, torsoH: 0.56, torsoD: 0.25, headR: 0.110, legH: 0.82 }, // ≈1.60m
    gunLength: 0.62,
    hitFlashColor: '#FFE4E6',
  },

  // --- 武器视图模型（挂在相机下，局部坐标；尺寸/距离单位：米） ---
  viewmodel: {
    // ⚠ 枪模长约 1.24 m（VM_PARAMS 里 receiver/barrel/stock 之和）。枪托在局部 +0.40 m，
    // 所以相机位 z 必须比枪托更靠前，否则枪身会穿过相机平面被近裁剪面切掉——
    // 症状就是"屏幕上只有一块贴脸的浅色大板，看不出是枪"。P4 实测修正：前移 + 缩放。
    scale: 0.62, // 整体缩放：1.24 m 的枪在 0.5 m 处会占满半屏，缩到 0.62 更像手持视角
    base: { x: 0.20, y: -0.20, z: -0.56 }, // 腰射位置（z 比枪托 +0.25 m 更远，保证整枪在裁剪面外）
    baseRot: { x: 0.03, y: 0.16, z: 0 }, // 腰射姿态（略向内收）
    // 瞄准位 y：模型里准星（sight）在 +0.085 m，整体缩放 0.62 → 要把它抬到相机轴线上，
    // 枪身就得下移 0.085*0.62 ≈ 0.053 m。否则开镜时挡在准星上的是机匣顶面（实测）。
    ads: { x: 0, y: -0.053, z: -0.50 }, // 瞄准位置：准星对齐屏幕中心（相机前向=准星=子弹飞行方向）
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
    reloadPump: 0.09, // 拉机柄时枪身沿枪轴的前后抖动（米）
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
    // 粒子上限的**唯一来源**：逻辑侧裁剪（main.js spawn*）与渲染缓冲（renderer3d._particleMax）
    // 都读它，避免出现"逻辑 320 / 渲染 240"这种对不齐的隐偏差。
    // 低端机可整体降到 120（与 device.quality 挂钩），改这一处即可。
    maxParticles: 220,
    // 弹壳（P0-1，纯表现层）：逻辑侧只维护 x/y/速度/自旋，渲染层负责抛壳、落地与淡出。
    shellColor: '#C9A227', // 暖金属，与 PALETTE3D.ammoBox 同系
    shellSize: 0.02, // 弹壳最大边长（米）
    shellMax: 48, // 渲染对象池上限（同时最多画 48 个弹壳）
    shellFadeStart: 0.72, // 生命周期进度超过该值后开始收缩淡出（0~1）
    muzzleFlashLife: 0.06,
    muzzleFlashScale: 0.34,
    muzzleFlashColor: '#FFD08A',
    shakeDecay: 7.5, // 震屏衰减速率
    shakeMax: 0.10, // 震屏位移上限（米）
  },

  // --- 关卡构建 ---
  level: {
    wallColorJitter: 0.14, // 墙面明暗扰动幅度（走 rng 子流，保证同 seed 一致）；0.09 时相邻建筑几乎同色
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
 * 受击方向提示（P1-6）：被击中时在 HUD 屏幕边缘按方位闪一段危险色扇形。
 *
 * 口径：`world.hitDir` 存的是「玩家 → 伤害来源」的方位角（弧度，与 player.yaw 同一坐标系），
 * 因此在屏幕上的水平偏移就是 `hitDir - player.yaw`：0 = 正前方（画在顶边），
 * ±π = 正后方（画在底边），>0 偏右侧。
 */
export const HITDIR = {
  life: 0.6, // 总存活时间（秒），线性淡出
  radiusX: 0.27, // 提示椭圆半径（相对屏幕宽）
  radiusY: 0.30, // 提示椭圆半径（相对屏幕高）
  span: 0.34, // 扇形张角（弧度，单侧）
  width: 9, // 扇形线宽（CSS 像素）
};

/**
 * 局内 HUD（P1）的**视觉参数单一来源**。
 *
 * HUD 全部画在 canvas 上，CSS 令牌管不到这里；把切角、分段数、刻度步长、
 * 缩放档位写死在绘制函数里，会让"桌面好看 / 手机挤爆"这类问题无法一处调。
 * 这里只放**表现参数**，不含任何玩法数值（伤害、时间、距离仍在 COMBAT/MATCH）。
 */
export const HUD = {
  cut: 8,          // 面板切角（px）
  bracket: 10,     // 四角括号臂长（px）
  bracketW: 1.4,   // 四角括号线宽
  segCount: 10,    // 生命/护甲/体力分段条格数
  segGap: 2,       // 分段间隙（px）
  compass: {
    stepDeg: 15,   // 小刻度间隔
    majorDeg: 45,  // 大刻度 / 方位字母间隔
    spanDeg: 140,  // 可见角度窗口；pxPerDeg = 罗盘宽 / 该值，宽窄屏自动对齐
  },
  minimap: {
    zoomSteps: [1, 1.6, 2.4], // 缩放档；1 = 全图
    gridLines: 6,              // 战术网格线数（单边）
    poiMax: 6,                 // 同屏 POI 名称上限，防止小屏糊成一片
    sideW: 46,                 // 右侧控制栏宽度（方图之外）
  },
  vitals: {
    lowHp: 0.35,      // 低血量阈值（比例），触发去饱和 + 暗角 + 心跳
    heartbeatHz: 1.3, // 心跳频率（减少动态效果时恒亮，不闪）
  },
  hit: {
    life: 0.24,       // 分级命中标签存活时间
    labels: {
      normal: '命中', armor: '护甲', blocked: '弹开', partial: '半穿',
      penetrated: '击穿', head: '爆头', kill: '击杀',
    },
  },
  // 换弹分段短名（HUD 底部读它，与 RELOADFX.stages 的 key 一一对应）
  reload: { 'mag-out': '退弹匣', 'mag-in': '插弹匣', charge: '拉机柄' },
  ring: { r: 17, w: 3 }, // 环形进度（搜刮 / 撤离 / 技能冷却）半径与线宽
  squadSize: 3,          // 编队席位（玩家 + 2）
};

/**
 * 干员技能（P5）的**数值单一来源**。
 *
 * 战术道具的充能格数与回充秒数跟着干员走（见 operators.js），这里只放
 * 所有干员共用的能量曲线。终结技不设冷却，只靠能量：击杀给大头、命中给零头、
 * 随时间缓慢自增 —— 这样玩家会为了"再拿一个人头就满了"而前压，而不是掐表等 CD。
 */
export const ABILITY = {
  ultMax: 100,     // 能量上限
  ultKill: 18,     // 每次击杀
  ultHit: 2.5,     // 每次命中（含破片 / 燃烧的区域伤害按次折算，不按点）
  ultHurt: 6,      // 每次自己受伤（鼓励在交火中攒大，而不是躲着憋）
  ultPassive: 1.1, // 每秒自然增长（8 分钟一局自然回满约 90 秒）
  // 终结技的通用参数
  overdrive: { spreadMul: 0.25, recoilMul: 0.45, damageMul: 1.15 },
  eagle: { dur: 9 },
  aegis: { heal: 35, armor: 25, regen: 4, dur: 6 },
  pyre: { radius: 6, dps: 18, dur: 8 },
  // 玩家被震撼弹闪到的白屏时长（面向爆点才触发）
  flashScreen: 0.75,
};

/**
 * 投掷物物理（P5）。单位是米 / 秒，进入世界前乘 metersToUnits。
 *
 * 速度取 15 m/s：玩家移动 9.8 m/s，投掷物约 1.5 倍于跑速 —— 扔出去能追上前压的自己，
 * 又不会像榴弹一样瞬移。重力压到 12（低于现实的 9.8 的"感觉"其实更重，
 * 因为这边是手感单位）能让 25 米外的落点在屏幕里可见，不需要抬枪太多。
 */
export const THROWABLE = {
  speed: 15,    // 出手速度（米/秒）
  gravity: 12,  // 重力（米/秒²）
  bounce: 0.42, // 墙面 / 地面反弹保留的速度比例
};

/**
 * 本地 AI 队友（P5-C2）的数值单一来源。
 *
 * 设计取舍：队友是**你这边的人**，所以行为要"像人"而不是"像怪"——编队跟着你走、
 * 看见敌人自动开火、能替你挡枪（敌人会转而打他们）、倒地后你来救。所有数字都是
 * 逻辑单位（与敌人 AI 的 speed/preferredRange 同一口径），不出现帧数。
 *
 * 友军绝不误伤：玩家与队友的子弹 candidates 都只指向 world.enemies；敌人子弹才会
 * 把 player + 存活队友一起算作可命中目标（见 combat.js combatTargets）。
 */
export const ALLY = {
  hp: 100,
  armor: 38,
  radius: 11,
  visionRange: 480,       // 比敌人略短，但足够覆盖交火距离
  preferredRange: 240,    // 理想交火距离（逻辑单位）
  followDist: 96,         // 编队跟随距离（逻辑单位，约 4.8m）
  formationSpread: 70,    // 两名队友相对玩家中轴的左右偏移
  followSpeed: 172,       // 跟随移动速度（玩家基础 196，略慢一档以免"贴脸抢镜"）
  engageSpeed: 150,
  strafeSpeed: 118,
  fireDelay: [0.45, 1.0], // 两波点射之间的间隔（秒）
  burst: [3, 5],          // 每波点射发数（与敌人同口径，走武器 rpm 控制连射节奏）
  accuracy: 0.62,         // 命中精度（越高 scatter 越小，见 combat.js accuracyPenalty）
  // 倒地救援：玩家站到倒地队友身边读条，读满即复活（不会永久阵亡，符合搜打撤"队友可救"）
  reviveRange: 78,
  reviveTime: 4,
  reviveHpFrac: 0.45,
  reviveArmorFrac: 0.4,
  separation: 26,         // 队友间 / 与玩家的最小间距（避免叠在一起）
};

/**
 * 局外战术工作台（P2）的**结构与文案单一来源**。
 *
 * 大厅 / 战前 / 仓库 / 商店 / 结算五屏共用一层外壳（顶栏 + 图标导航 + 底部部署条）。
 * 把导航表放在数据层而不是模板里，是为了让 `tools/probe-p2-hub.mjs` 与
 * `tests/p2-hub.test.mjs` 能逐项核对「每个入口都指向 main.js 里真实存在的 action」，
 * 避免新增一个好看但点不动的假按钮。
 *
 * P15：原先的两处「诚实占位」已经转正 —— `operators` 指向真实干员屏，
 * `riskLevels` 三档全部可玩且参数真实生效（见 `src/risk.js`）。
 * 交易行与商店当前都落到 `shop` 屏，页签在 P2「交互」提交里再分流。
 */
export const HUB = {
  brand: { name: '搜打撤', en: 'SEARCH / STRIKE / EXTRACT' },
  // 行动等级进度只由真实声望经验推导（REP.levels），不新增存档字段、不伪造赛季任务。
  // H-11 命名合规：赛季名必须原创，不得使用对方模式名 / 干员名 / 地图名 / 货币名。
  // 「灰港」取自本项目地图灰港库区，「风暴」为通用词；如需改名先过 tests/naming.test.mjs 黑名单。
  season: { id: 'S1', name: '灰港风暴', mode: '闪击行动', modeEn: 'FLASH RAID', tiers: REP.levels },
  nav: [
    { id: 'operation', label: '行动', en: 'OPERATION', glyph: 'target', action: 'goto-menu', screen: 'menu' },
    { id: 'operators', label: '干员', en: 'OPERATORS', glyph: 'person', action: 'goto-operators', screen: 'operators' },
    { id: 'loadout', label: '装备', en: 'LOADOUT', glyph: 'gear', action: 'goto-loadout', screen: 'loadout' },
    { id: 'stash', label: '仓库', en: 'STASH', glyph: 'crate', action: 'goto-stash', screen: 'stash' },
    { id: 'market', label: '交易行', en: 'MARKET', glyph: 'chart', action: 'goto-shop', screen: 'shop' },
    { id: 'workshop', label: '特勤处', en: 'WORKSHOP', glyph: 'wrench', action: 'goto-upgrades', screen: 'upgrades' },
    { id: 'career', label: '生涯', en: 'CAREER', glyph: 'book', action: 'goto-career', screen: 'career' },
    { id: 'codex', label: '收藏', en: 'CODEX', glyph: 'book', action: 'goto-codex', screen: 'codex' },
    { id: 'supply', label: '商店', en: 'SUPPLY', glyph: 'cart', action: 'goto-shop', screen: 'shop' },
    // CC BY 3.0 图标与模型的署名落点：授权要求「游戏内可见」，所以必须是一级入口。
    { id: 'credits', label: '致谢', en: 'CREDITS', glyph: 'doc', action: 'goto-credits', screen: 'credits' },
  ],
  /**
   * 战前风险分级（P15）：**风险 = 收益**，三档全部可玩。
   *
   * 倍率只作用在「本局」，一律通过副本注入（`risk.js` 的 `applyRiskToEnemies`
   * 给每名敌人换一份 def 副本），**绝不改写 ENEMY_TYPES / WEAPONS 常量**。
   * `tier: 0` 表示基准档，`applyRiskToEnemies` 会直接原样返回列表 ——
   * 这保证同 seed 的常规局与 P14 之前逐位一致（GOLDEN 与旧存档都不受影响）。
   *
   * 字段口径：
   * - `enemyCountMul`：地图生成时的敌人数量倍率（四舍五入，至少 1）。
   * - `enemyHpMul` / `enemyDamageMul` / `enemyAccuracyMul`：敌人属性倍率。
   * - `enemyArmorAdd`：护甲等级加成（影响弹种穿透判定）。
   * - `lootLuck`：容器战利品权重偏移，1 = 原概率。
   * - `scoreMul`：结算评分倍率；`payoutMul`：评级奖金倍率。
   */
  riskLevels: [
    {
      id: 'routine', label: '常规', en: 'ROUTINE', tier: 0, enabled: true,
      enemyCountMul: 1, enemyHpMul: 1, enemyDamageMul: 1, enemyAccuracyMul: 1, enemyArmorAdd: 0,
      lootLuck: 1, scoreMul: 1, payoutMul: 1,
      desc: '基准配置：敌人数量与强度为常值，物资按标准概率产出。',
    },
    {
      id: 'confidential', label: '机密', en: 'CONFIDENTIAL', tier: 1, enabled: true,
      enemyCountMul: 1.25, enemyHpMul: 1.18, enemyDamageMul: 1.1, enemyAccuracyMul: 1.06, enemyArmorAdd: 1,
      lootLuck: 1.6, scoreMul: 1.35, payoutMul: 1.25,
      desc: '敌人更多、护甲更硬；稀有物资概率 ×1.6，评分 ×1.35，奖金 ×1.25。',
    },
    {
      id: 'topsecret', label: '绝密', en: 'TOP SECRET', tier: 2, enabled: true,
      enemyCountMul: 1.5, enemyHpMul: 1.4, enemyDamageMul: 1.25, enemyAccuracyMul: 1.12, enemyArmorAdd: 2,
      lootLuck: 2.4, scoreMul: 1.8, payoutMul: 1.6,
      desc: '精锐封锁区：敌人数量 ×1.5、血量 ×1.4；稀有物资概率 ×2.4，评分 ×1.8，奖金 ×1.6。',
    },
  ],
  /** 这些屏不显示局外外壳：局内 HUD、暂停层、结算演出都自己占满全屏。 */
  hubOffScreens: ['battle', 'pause', 'result'],
  navWidth: 64,
  topbarHeight: 44,
  actionbarHeight: 64,
};

/**
 * 程序化 POI 名称池（P1 小地图标签用）。
 *
 * 地图生成器只产出 room 几何，没有命名 POI；这里按「面积最大的前 N 个房间」
 * 稳定地贴战术代号，纯展示、不参与生成、不改 seed 结果。P8 做正式命名 POI 时
 * 把 map.pois 接上即可，此处留出同名入口。名字是自制代号，不引用任何外部作品。
 */
export const POI_NAMES = {
  depot: ['ADMIN', 'DOCK', 'SUBSTATION', 'WAREHOUSE', 'CHECKPOINT', 'CRANE', 'GARAGE', 'PIER'],
  conduit: ['PUMP', 'TUNNEL', 'RELAY', 'MAINT', 'VENT', 'SILO', 'JUNCTION', 'CONTROL'],
  ridge: ['RADAR', 'CLIFF', 'RELAY', 'WATCH', 'RIDGE', 'TOWER', 'BUNKER', 'SLOPE'],
  wasteland: ['OUTPOST', 'SILO', 'DEPOT', 'CHECK', 'TOWER', 'BRIDGE', 'QUARRY', 'RELAY'],
};

/**
 * 未部署席位的**展示档案**（占位，不是 AI 队友）。
 *
 * P1 只负责把三人小队面板的视觉与数据结构立起来：真实血量来自 world.player，
 * 另外两席明确标 `STANDBY`、血条留空。P5 接入本地 AI 后只需往 world.squad 里
 * 填 { callsign, role, hp, maxHp, armor, maxArmor, state }，绘制层不用再改。
 * 这里不伪造队友、不虚报功能。
 */
export const SQUAD_STANDBY = [
  { slot: '02', callsign: '待命席位', role: 'STANDBY' },
  { slot: '03', callsign: '待命席位', role: 'STANDBY' },
];

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
  sharpen: 0.26, // P12 邻近采样锐化：补偿贴图细节在 ACES 后被抹平，0 = 关闭
  dither: 1.0, // P12 输出前 1/255 抖动：抑制暗场色带，0 = 关闭
};

/**
 * P12 程序化表面材质（src/surfaces.js 的烘焙参数）。
 *
 * albedo / height / roughness 三通道由确定性整数哈希噪声 CPU 烘焙，零外部素材；
 * 与战局随机流完全隔离，同参数跨进程逐字节一致。
 * 低画质档可直接把 enabled 置 false 回退到旧的简易撒点贴图。
 */
export const SURFACE3D = {
  enabled: true, // 总开关；关闭时 models.js 回退到 P3 的简易贴图，且不挂凹凸/粗糙度
  size: 128, // 贴图边长（必须是 2 的幂：保证各档 WebGL 下 RepeatWrapping 可用）
  seed: 0x5d0a, // 烘焙种子；改它会整体换一套纹理，不影响战局确定性
  bumpScale: 0.035, // 凹凸强度：大平面别开太大，否则墙面会出现塑料波纹
  roughnessMix: 1.0, // 粗糙度贴图混入比例（乘在材质 roughness 上）
  normalStrength: 1.8, // W6：高度图→法线图的 Sobel 坡度；大平面保守值，避免橘皮
  normalScale: 0.24, // W6：three 侧 normalScale。W7 从 0.55 降到 0.24：碎高光主因，太大=湿滑金属
};

/**
 * W6 PBR 保真档位（GLB 道具的四通道材质）。
 *
 * 为什么单列：glbLambert 是"亮度安全但丢材质"的旧出口，glbPbr 是"保真但偏亮"的新出口。
 * gain 是把 Standard 的漫反射拉回 Lambert 同一观感区间的**唯一**旋钮 —— 历史 1.7 曝光
 * 时代不带 gain 直接 Standard 会让木箱冲成白板，W5 重标定后仍要留这个旋钮做 A/B。
 * 移动端 low 档始终走 glbLambert（省掉 normal/ARM 的纹理采样），与 surfaceDetail 降级一致。
 */
/**
 * W7 露天缓坡地形（真高程，不是只抬地面的假坡）。
 *
 * ⚠ 为什么幅度这么小（0.9m）：本项目没有分块加载/LOD，地面是整图一次性合并的网格。
 * 先把"高度场贯穿 elevationAt + 所有落位"这条链路打通并验证不穿模，再谈大起伏。
 * 大起伏需要墙脚/掩体/寻路全部按高度重建，那是分块加载之后的事。
 *
 * 只作用于露天广场（room.plaza）；室内地面保持 0，避免房间地板/墙脚穿帮。
 * 广场边缘衰减到 0，保证与围墙/走廊交界处不悬空。
 */
export const TERRAIN3D = {
  enabled: true,
  forkSalt: 0x7a9c31, // 独立 RNG 分叉：地形采样不得动主 rng 序列（golden 铁律）
  amplitudeMin: 0.35, // 单个缓坡幅度下限（米）
  amplitudeMax: 0.95, // 上限：再高就会让掩体箱悬空观感明显
  hillCountMin: 1, // 每个广场至少 1 个丘
  hillCountMax: 3,
  edgeFade: 0.22, // 边缘衰减带占广场短边的比例：靠墙 22% 内高度降到 0
};

/**
 * W8 P1 地面分块（流式可见性）。
 *
 * 整图单 Mesh 时包围球覆盖全图 → 视锥剔除永远不生效 → 400m 图 80k 面全画。
 * 分块后只显示玩家附近 chunk，可见 tris 降到 ~1/9。小图（≤chunkThreshold 格）
 * 保持单 Mesh，旧图 golden / level3d 测试零回归。
 *
 * visibleChunks 是可见半径（块数）：(2r+1)² 块同时可见。r=2 → 25 块；
 * 每块 64×64 面 → 25×8192=204k 面仍超预算，故大图用 r=1（9 块）或小 chunk。
 */
export const GROUND3D = {
  enabled: true,
  chunkThreshold: 12000, // 格数阈值：旧图 6912 不分块，大图 40000 分块
  chunkTiles: 24, // 每块 24×24 tile = 48×48m；大图 200/24≈9×9=81 块
  visibleChunks: 1, // 可见半径 1 → 3×3=9 块，每块 1152 面 → ~10k 面
};

export const PBR3D = {
  enabled: true, // 总开关；?pbr=0 可强制回退做 A/B / 弱机自救
  containerGain: 0.78, // Poly Haven 道具固有色衰减：保住木纹/铆钉，又不冲白
  normalScale: 0.85, // 法线强度：Poly Haven normal 偏强，0.85 避免橘皮
  // 角色只给"金属/玻璃"少数部位升 Standard（枪 + 护目镜），布料保持 Lambert：
  // 全角色换 PBR 会让 16 个敌人 × 7 材质都进 PBR 光循环，移动端帧率吃不消。
  actorMetal: true,
  actorMetalRoughness: 0.34, // 枪械烤蓝钢：低粗糙出高光，但不到镜面
  actorMetalness: 0.62,
  actorLensRoughness: 0.12, // 护目镜玻璃：镜面高光
  actorLensMetalness: 0.10,
};

/**
 * P3 场景观感：全局调色与光照分区的唯一真值源。
 *
 * 设计取向（对照烽火地带的观感基准）：冷灰蓝阴影 + 暖白高光 + 低饱和。
 * 现有 `PALETTE3D` 的 hemiSky(#93C5FD) / ambient(#3C4C66) / dirLight(#FFF7ED)
 * 本来就是这套色温分工，且 26/17/2.1 的光强是夜战可见性标定过的甜区 ——
 * 因此 P3 **不推翻既有标定**，只补两件缺的：
 *   1) 低饱和（ACES 之后的线性空间里做 luma 混合，见 POST_FS 的 uSaturation）；
 *   2) 室内暖白局部灯分区（LIGHT_ZONES.interior，点光数量按设备档钳制）。
 * 曝光 / 对比 / 饱和三值可在暂停面板调，经 `src/grade3d.js` 钳制后写入存档。
 */
export const GRADE3D = {
  exposure: 0.78, // ACES 下的夜战基准（1.0 = 中性；>1 偏白天）
  contrast: POST3D.contrast, // 单一来源：对比的真值仍在 POST3D，这里只是默认读口
  saturation: 0.88, // <1 = 低饱和；1 = 不改色
  splitTone: 0.45, // P3-C3 色彩分级强度：暗部推向冷阴影色、亮部推向暖高光色（保亮度只改色相）
  shadowTint: '#6E93BE', // 冷蓝阴影色（后处理 split-tone 的暗部读口）
  highlightTint: '#FFD9A6', // 暖琥珀高光色（后处理 split-tone 的亮部读口，呼应 C1 暖白灯）
  ranges: {
    // ACES 上线后曝光才真正生效（旧区间是给"没有色调映射"那条链路定的，
    // 1.10 的下限在 ACES 下等于把整帧乘 1.8，怎么调都是过曝）。
    exposure: { min: 0.35, max: 1.60, step: 0.05 },
    contrast: { min: 0.80, max: 1.15, step: 0.01 },
    saturation: { min: 0.60, max: 1.10, step: 0.02 },
  },
};

/**
 * 光照分区。outdoor 直接引用既有 PALETTE3D / VIEW3D 的标定值，
 * 保证「不改动已验证的夜战可见性」；interior 是 P3 新增的暖白局部灯层。
 *
 * ⚠ 级联阴影（CSM）、屏幕空间反射、体积光在本项目零依赖核心 Three.js 上
 * 代价过高且会冲掉既有 5 级帧率闸门，P3 明确不做，也不伪造开关。
 * 接触阴影由后处理的深度近似 AO 提供，环境反射由 PMREM 提供（均已存在）。
 */
export const LIGHT_ZONES = {
  outdoor: {
    key: 'outdoor',
    label: '日光 / 月光',
    hemiSky: PALETTE3D.hemiSky,
    hemiGround: PALETTE3D.hemiGround,
    ambient: PALETTE3D.ambient,
    dir: PALETTE3D.dirLight,
    dirIntensity: VIEW3D.dirIntensity,
  },
  interior: {
    key: 'interior',
    label: '室内灯',
    lamp: '#FFD9A8', // 暖白
    // 全局 hemi/ambient 是 26/17 的夜战填充光，点光给到 3.6 会被完全淹没（真浏览器 A/B 截图验证）。
    // 12 是「能形成暖白光区又不把近处打过曝」的标定值；可见性主要由下面的地面光池保证。
    lampIntensity: 12,
    lampDistance: 12, // 米（建模时 × metersToUnits）
    lampHeight: 2.9, // 米，略低于天花板
    decay: 0, // 与既有头灯一致：距离内恒定，末端平滑收边
    // 地面光池：程序化径向贴图 + 加色混合，不依赖光照数学，
    // 因此在任何设备档 / 任何全局光强下都稳定可见。
    poolRadius: 6, // 米
    poolOpacity: 0.62,
    poolColor: '#FFD9A8',
    fixtureColor: '#FFE7C4',
    // 每盏点光都要进 Standard 材质的光循环，数量必须按设备档钳死。
    counts: { high: 2, mid: 1, low: 0 },
    zoneRadius: 18, // 米：进入这个半径算「室内灯区」
    // 分区混合只做小幅自适应，不动全局照明的可见性标定。
    zoneHemiMul: 0.90,
    zoneAmbientMul: 0.92,
    zoneLerp: 3.2, // 指数平滑速率（帧率无关）
  },
};


/** 3D 层使用的 rng 子流盐值（保证装饰性随机与逻辑随机互不干扰） */
export const RNG_SALT_3D = { level: 101, decor: 202, particles: 303 };
