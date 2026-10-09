/**
 * 全局配置 —— 所有可调数值的唯一来源
 * 数值源自 design/gdd/systems/*.md（SYS-01…SYS-06）与概念文档 v2.2
 * 想调平衡只改这里，不要散落在各系统里。
 */

/* ---------- 商品（SYS-01 §2：MVP 锁定 3 种 SKU） ---------- */
export const SKUS = [
  { id: 'drink',  name: '饮料', emoji: '🥤', cost: 2,  price: 5,  shelfLife: 7, moq: 10, color: 0x4A90D9 },
  { id: 'noodle', name: '泡面', emoji: '🍜', cost: 3,  price: 8,  shelfLife: 2, moq: 6,  color: 0xE8A94E },
  { id: 'bento',  name: '便当', emoji: '🍱', cost: 6,  price: 15, shelfLife: 1, moq: 4,  color: 0x6FCF97 },
  // 第 4 个 SKU：MVP 锁定，需「解锁杂货」升级（SYS-04 §2）
  { id: 'grocery', name: '杂货', emoji: '🛍️', cost: 4, price: 10, shelfLife: 5, moq: 8, color: 0xB08BD8, locked: true },
  /* 2026-10-05 C 方案：节日限定礼盒 —— 仅节日夜（万圣/跨年/店庆）可售可进，
   * festivalOnly 由 economy.availableSkus() 判定（isFestival(state.themeId)），
   * 节日夜 startNight 自动到货 8 件；非节日夜进货页/顾客抽选自动不出现。 */
  { id: 'festival', name: '节日礼盒', emoji: '🎁', cost: 8, price: 25, shelfLife: 1, moq: 4, festivalOnly: true, color: 0xF2C879 },
  /* 2026-10-06 块1：扩充便利店常见 SKU（解决"商品太少、太粗制滥造"）。
   *
   * 解锁口径：**跟随杂货一起解锁**（locked:'grocery' → 同一个 upgrade key）。
   * 为什么不直接白送：这三样是低单价小件（口香糖 3 / 电池 8 / 杂志 12），
   * 开局就放行等于让玩家在头两夜用低价小件占满 8 格、挤掉真正赚钱的便当与泡面，
   * 直接打乱"前三夜靠主力 SKU 立住营收"的节奏。挂到杂货解锁后面，
   * 既满足"进货页可见可买"，又让它们的登场是一个玩家主动争取来的扩张。
   *
   * 成本/售价定在"薄利但走得掉"：口香糖几乎不赚钱（引流品），
   * 电池与杂志单价高一点，供夜间有特殊需求的顾客（见 SEGMENTS 偏好）。
   * moq 沿用"小件低起订、大件高起订"，避免小件占太多仓库容量。 */
  { id: 'gum',      name: '口香糖',   emoji: '🄿', cost: 1.5, price: 3,  shelfLife: 30, moq: 6,  color: 0x3AA0D8, locked: 'grocery' },
  { id: 'battery',  name: '电池',     emoji: '🔋', cost: 4,   price: 9,  shelfLife: 60, moq: 4,  color: 0x4A5A8C, locked: 'grocery' },
  { id: 'magazine', name: '杂志',     emoji: '📖', cost: 6,   price: 14, shelfLife: 20, moq: 3,  color: 0xC0392B, locked: 'grocery' },
  /* ---------- 块7：深夜刚需 ×3（对标「商品太少」的体验缺口） ----------
   * 关东煮 / 热咖啡：开局即售（夜班便利店招牌深夜品类，零门槛立刻丰富货架）；
   * 啤酒：跟杂货一起解锁（locked:'grocery'，与口香糖/电池/杂志同一把钥匙）。
   * 三者都带变体池（见 PRODUCT_VARIANTS），复用既有 shape：
   *   oden→noodlecup（杯装关东煮）/ hotcoffee→cup（纸杯）/ beer→bottle（瓶装），
   *   所以**无需新增任何 3D 几何**，货架模型自然就有区分度。
   * SEGMENTS 偏好的时段时间分布见下方 SEGMENTS 表（已同步归一化到含新 SKU）。 */
  { id: 'oden',      name: '关东煮', emoji: '🍢', cost: 3,  price: 9,  shelfLife: 1, moq: 6,  color: 0xC8672E },
  { id: 'hotcoffee', name: '热咖啡', emoji: '☕', cost: 2,  price: 7,  shelfLife: 1, moq: 8,  color: 0x6F4A2E },
  { id: 'beer',      name: '啤酒',   emoji: '🍺', cost: 5,  price: 12, shelfLife: 30, moq: 4, color: 0xD9A441, locked: 'grocery' },
];
export const SKU_BY_ID = Object.fromEntries(SKUS.map((s) => [s.id, s]));

/* ---------- 货架商品模型（P0-1：可区分的商品外观） ----------
 * 线上问题：货架上只有"蓝圆柱 / 黄圆柱 / 绿方块"三种纯色几何体，一格一种颜色，
 * 整排看过去像三根彩色柱子 —— 不合格。
 *
 * 设计：把"颜色"从 SKU 上**挪到具体商品**上。每个 SKU 给一个变体池，
 * 一个池里的商品形状与配色都不同（易拉罐高瘦 / 塑料瓶带盖 / 袋装 / 盒装 / 杯装…），
 * 于是同一格是"某种 SKU 的多件商品"，相邻格位又按错位取模取到不同变体，
 * 整排货架自然是红/蓝/绿/黄/棕混排的超市感。
 *
 * shape 见 scene.mjs 的 PRODUCT_SHAPE 构造器；color 主色 / accent 辅色（盖子、标签、包装口）。
 * `clear:true` 表示半透明材质（矿泉水）。
 */
export const PRODUCT_VARIANTS = {
  /* 饮料 7 款：易拉罐高瘦（can）/ 塑料瓶带盖（bottle）/ 杯装（cup）三类轮廓 */
  drink: [
    { name: '可乐',    shape: 'can',    color: 0xC62828, accent: 0xE8E8E8 },
    { name: '雪碧',    shape: 'can',    color: 0x2E9E4F, accent: 0xE8F5E9 },
    { name: '罐装咖啡', shape: 'can',    color: 0x1F3D7A, accent: 0xE8D9A0 },
    { name: '橙汁',    shape: 'bottle', color: 0xE8871E, accent: 0xF7C948 },
    { name: '冰红茶',  shape: 'bottle', color: 0x8B5A2B, accent: 0xD9A441 },
    { name: '矿泉水',  shape: 'bottle', color: 0xBFE7F5, accent: 0xFFFFFF, clear: true },
    { name: '奶茶',    shape: 'cup',    color: 0xD8B48C, accent: 0xF3E3D0 },
  ],
  /* 零食 7 款：袋装（bag）/ 盒装（box）/ 棒棒糖（lolli）/ 小方盒（smallbox） */
  grocery: [
    { name: '薯片',    shape: 'bag',      color: 0xF2C230, accent: 0xE8552B },
    { name: '辣条',    shape: 'bag',      color: 0xD62828, accent: 0xFFE082 },
    { name: '糖果',    shape: 'bag',      color: 0xE97BB0, accent: 0xFFF0F6 },
    { name: '饼干',    shape: 'box',      color: 0x2F6FB5, accent: 0xEAF2FA },
    { name: '巧克力',  shape: 'box',      color: 0x4A3020, accent: 0xB98A2E },
    { name: '棒棒糖',  shape: 'lolli',    color: 0xF25C8C, accent: 0xFFFFFF },
    { name: '口香糖',  shape: 'smallbox', color: 0xF5F5F5, accent: 0x3AA0D8 },
  ],
  /* 速食 4 款（泡面杯 / 便当盒 / 热狗 / 烤肠）分布在两个速食 SKU 上，
   * 这样"泡面"与"便当"两个格位各自也能看到不止一种轮廓。 */
  noodle: [
    { name: '泡面杯',  shape: 'noodlecup', color: 0xE8552B, accent: 0xF6E3C5 },
    { name: '热狗',    shape: 'hotdog',    color: 0xD9A441, accent: 0xC0392B },
    { name: '烤肠',    shape: 'sausage',   color: 0xB5522E, accent: 0xF0D8A8 },
  ],
  bento: [
    { name: '便当盒',  shape: 'bentobox',  color: 0x2E7D5B, accent: 0xF0E6D2 },
    { name: '热狗',    shape: 'hotdog',    color: 0xD9A441, accent: 0xC0392B },
    { name: '烤肠',    shape: 'sausage',   color: 0xB5522E, accent: 0xF0D8A8 },
  ],
  /* 2026-10-05 C 方案：节日礼盒变体池（万圣/跨年/店庆三色盒，随格位错位出现） */
  festival: [
    { name: '万圣礼盒', shape: 'box',      color: 0xE8823A, accent: 0x2E2A33 },
    { name: '跨年礼盒', shape: 'box',      color: 0xF2C879, accent: 0xC0392B },
    { name: '店庆礼盒', shape: 'box',      color: 0xE05A8C, accent: 0xFFF0F6 },
  ],
  /* 2026-10-06 块1：三个新 SKU 的变体池。
   * 造型刻意与既有池**完全不重叠**（smallbox / batterycard / magazine 三个新形状），
   * 这样"一眼能分辨"不只靠颜色 —— 就算在灰度截图里，
   * 扁糖盒 / 立式卡装 / 薄本也能靠轮廓区分开。 */
  gum: [
    { name: '薄荷糖',   shape: 'smallbox',     color: 0x3AA0D8, accent: 0xE8F5E9 },
    { name: '柠檬糖',   shape: 'smallbox',     color: 0xF2C230, accent: 0x4A3728 },
    { name: '草莓糖',   shape: 'smallbox',     color: 0xE8739B, accent: 0xFFF0F6 },
  ],
  battery: [
    { name: '碱性电池', shape: 'batterycard',  color: 0x2B3550, accent: 0xB98A2E },
    { name: '纽扣电池', shape: 'batterycard',  color: 0x1F3D7A, accent: 0xC8CDD6 },
    { name: '充电电池', shape: 'batterycard',  color: 0x2E7D5B, accent: 0xD9B45A },
  ],
  magazine: [
    { name: '时尚周刊', shape: 'magazine',     color: 0xC0392B, accent: 0xF2E3D0 },
    { name: '游戏志',   shape: 'magazine',     color: 0x2F6FB5, accent: 0xEAF2FA },
    { name: '夜谈',     shape: 'magazine',     color: 0x4A3020, accent: 0xE8A94E },
  ],
  /* 块7：深夜刚需三样的变体池（复用既有 shape，不新增几何）。
   * oden→noodlecup（杯装关东煮）/ hotcoffee→cup（纸杯热饮）/ beer→bottle（瓶装啤酒）。
   * 错位取模（productVariant 步长 2）保证相邻格位摆到不同款，整排有超市感。 */
  oden: [
    { name: '萝卜',   shape: 'noodlecup', color: 0xE8C36B, accent: 0xF2E3C5 },
    { name: '鸡蛋',   shape: 'noodlecup', color: 0xF0D98C, accent: 0xFFF0D0 },
    { name: '魔芋',   shape: 'noodlecup', color: 0x9BD08A, accent: 0xE8F5E9 },
  ],
  hotcoffee: [
    { name: '美式',   shape: 'cup', color: 0x4A3020, accent: 0xE8D9A0 },
    { name: '拿铁',   shape: 'cup', color: 0x6F4A2E, accent: 0xF3E3D0 },
    { name: '卡布',   shape: 'cup', color: 0x8C6A4A, accent: 0xFFF0F6 },
  ],
  beer: [
    { name: '淡啤',   shape: 'bottle', color: 0xE8B23A, accent: 0xF7C948 },
    { name: '黑啤',   shape: 'bottle', color: 0x3A2A1A, accent: 0xC0392B },
    { name: '无醇',   shape: 'bottle', color: 0xC9A24B, accent: 0xE8F5E9 },
  ],
};

/**
 * 取"第 slotIndex 格 · 第 col 位"该摆哪个变体。
 * 错位步长取 2：对任何一个长度的变体池都保证**相邻格位同一位取到不同变体**
 * （步长 1 会让相邻格位完全一样，步长 3 在 3 件池上会回到原位）。
 */
export function productVariant(skuId, slotIndex, col) {
  const pool = PRODUCT_VARIANTS[skuId];
  if (!pool || pool.length === 0) return null;
  return pool[((slotIndex * 2 + col) % pool.length + pool.length) % pool.length];
}


/* ---------- 进货 / 库存（SYS-01 / SYS-02） ---------- */
/**
 * 开局启动资金。
 * 500 → 600：等价于"开局送 ¥100"。理由是第一夜要同时买维修包、清洁喷雾、首批货，
 * 500 会出现"什么都买不起 → 第一夜躺平"的体验断档。economy.test 的断言同步改成 600。
 */
export const START_CASH = 600;

/**
 * 首夜顾客单次消费加成（只作用于 state.night === 1）。
 * 刻意做成"只乘在第 1 夜"而不是全局乘数：全局乘会影响 every night 的收益曲线，
 * 让后续所有夜的平衡基线一起漂移；只加强首夜则是一条孤立的、可随时删掉的补偿曲线。
 * 作用点在 economy.checkout()，商品定价本身不动。
 */
export const FIRST_NIGHT_SPEND_MUL = 1.2;
export const SLOT_COUNT = 8;      // 起始货架格
export const SLOT_CAP = 24;       // 单格容量上限
export const PICK_BATCH = 6;      // 单次取货批量

/* ---------- 结算 / 经济（SYS-04） ---------- */
export const RENT_PER_NIGHT = 80;
export const NIGHTS_PER_WEEK = 7;
export const STAR_THRESHOLDS = [0.8, 0.6, 0.4]; // 成交率 → 3★/2★/1★
export const UPGRADES = [
  { id: 'slot',    name: '加货架格',   cost: 300, eff: '货架 +4 格' },
  { id: 'fridge',  name: '冰柜（延保）', cost: 500, eff: '便当保质期 1 → 2 夜' },
  { id: 'coffee',  name: '咖啡机',     cost: 400, eff: '每夜额外营收 +¥30' },
  { id: 'grocery', name: '解锁杂货 SKU', cost: 600, eff: 'SKU 3 → 7（杂货/口香糖/电池/杂志）' },
];
export const COFFEE_BONUS = 30;

/* ---------- 顾客需求（SYS-03） ---------- */
export const ARRIVALS_PER_NIGHT = 22;
export const QUEUE_MAX = 5;
export const PATIENCE_SEC = 25;
export const START_REPUTATION = 50;
export const REP_SERVE = 0.5;    // 成交 +0.5
export const REP_LOST = -1;      // 失销 -1
export const SEGMENTS = [
  /* bias 已同步归一化到「含 6 个基础 SKU」：不可售的 oden/hotcoffee/beer 权重在
   * pickSku 里被 availableSkus() 过滤掉（啤酒需解锁杂货），所以实际抽样只看当夜在售的。
   * 时段倾向：深夜/凌晨偏关东煮·啤酒·热咖啡，清晨偏便当·热咖啡（打工族提神）。 */
  { id: 'S1', label: '晚间', from: 0, to: 2, weight: 1.00,
    bias: { drink: 0.22, noodle: 0.20, bento: 0.22, oden: 0.14, hotcoffee: 0.12, beer: 0.10 },
    /* idWeights：各身份的「相对出现权重」，深夜醉汉/夜猫子多、清晨上班族/司机多（块7） */
    idWeights: { nightowl: 0.25, student: 0.20, office: 0.20, drunk: 0.20, driver: 0.15 } },
  { id: 'S2', label: '深夜', from: 2, to: 4, weight: 0.60,
    bias: { drink: 0.22, noodle: 0.16, bento: 0.14, oden: 0.18, hotcoffee: 0.12, beer: 0.18 },
    idWeights: { nightowl: 0.30, student: 0.15, office: 0.10, drunk: 0.30, driver: 0.15 } },
  { id: 'S3', label: '凌晨', from: 4, to: 6, weight: 0.35,
    bias: { drink: 0.24, noodle: 0.16, bento: 0.12, oden: 0.18, hotcoffee: 0.14, beer: 0.16 },
    idWeights: { nightowl: 0.28, student: 0.17, office: 0.12, drunk: 0.28, driver: 0.15 } },
  { id: 'S4', label: '清晨', from: 6, to: 8, weight: 0.80,
    bias: { drink: 0.18, noodle: 0.18, bento: 0.26, oden: 0.10, hotcoffee: 0.18, beer: 0.10 },
    idWeights: { nightowl: 0.10, student: 0.15, office: 0.35, drunk: 0.10, driver: 0.30 } },
];

/* ---------- 块7：顾客身份（5 种，带时段分布 + 独立外观 + 组合率） ----------
 * 设计口径（与既有 SYS-03 解耦）：每个顾客先按所在夜段的 idWeights 抽一个身份，
 * 再从其 prefer 池里抽「主件 +（按 comboRate 概率）搭配件」组成购物篮。
 *
 *  · spendMul：该身份整笔结账的消费倍率（年轻人爱逛、酒鬼肯花、学生抠门）—— 只乘总额，
 *    不动定价（避免与促销/弹性叠加失控）。
 *  · patienceMul：相对基础耐心 PATIENCE_SEC 的系数 —— 高耐心(夜猫子)从容、低耐心(上班族等)
 *    更容易因排队失去耐心离场，给玩家"先服务急客"的策略感。
 *  · comboRate：触发组合购买（搭配件）的概率。
 *  · prefer：偏好 SKU 池（抽主件/搭配件都从这抽；promo 期间权重抬升，见 customers.mjs）。
 *  · look：传给 character.mjs 的外观修饰（醉汉脸红 / 司机帽子 / 夜猫子黑眼圈 / 学生书包 / 上班族公文包）。
 *  · 常客首次入场固化身份：identityId 在 regulars.judge 里写一次，跨夜不变（见 regulars.mjs）。
 */
export const IDENTITIES = {
  nightowl:  { id: 'nightowl',  name: '夜猫子', emoji: '🦉', spendMul: 1.1, patienceMul: 1.6, comboRate: 0.35,
               prefer: ['drink', 'oden', 'beer'],            look: { eyes: 'tired' } },
  student:   { id: 'student',   name: '学生',   emoji: '🎒', spendMul: 0.85, patienceMul: 1.0, comboRate: 0.30,
               prefer: ['noodle', 'drink', 'gum'],          look: { backpack: true } },
  office:    { id: 'office',    name: '上班族', emoji: '💼', spendMul: 1.3, patienceMul: 0.6, comboRate: 0.25,
               prefer: ['bento', 'hotcoffee', 'magazine'],  look: { briefcase: true } },
  drunk:     { id: 'drunk',     name: '醉汉',   emoji: '🍻', spendMul: 1.2, patienceMul: 0.6, comboRate: 0.40,
               prefer: ['beer', 'gum', 'magazine'],         look: { flush: true } },
  driver:    { id: 'driver',    name: '司机',   emoji: '🚕', spendMul: 1.0, patienceMul: 0.6, comboRate: 0.30,
               prefer: ['hotcoffee', 'gum', 'battery'],      look: { hat: true } },
};
export const IDENTITY_IDS = Object.keys(IDENTITIES);

/** 价格弹性：售价每高于建议价 10%，需求 -15%（SYS-03 §2） */
export const ELASTICITY_K = 1.5;
export const DEMAND_MUL_MIN = 0.3;
export const DEMAND_MUL_MAX = 1.8;

/* ---------- 第一人称操控（SYS-05） ---------- */
export const WALK_SPEED = 3.2;
export const SPRINT_SPEED = 4.6;
export const EYE_HEIGHT = 1.65;
export const FOV = 72;                      // 观感 5：70→72，视野略宽，走路不剧烈晃
export const SENSITIVITY = 0.0022;          // rad/px
export const PITCH_CLAMP = (85 * Math.PI) / 180;
export const PLAYER_RADIUS = 0.32;
export const REACH = 2.5;                   // 交互射线距离（SYS-06）
export const NIGHT_WALL_SECONDS = 480;      // 一夜墙钟时长（8 分钟）；演示可改小
export const GAME_HOURS = 8;                // 22:00 → 06:00
export const OPEN_HOUR = 22;                // 起始游戏时钟（22:00）

/* ---------- 交互（SYS-06） ---------- */
export const ACTION_DURATIONS = { take: 0.8, place: 0.8, checkout: 0.6, event: 3.0 };

/**
 * 交互体（不可见、供射线命中的判定盒）尺寸。
 * 高度必须覆盖玩家眼高 EYE_HEIGHT，且向上留出余量 ——
 * 否则平视射线会从盒子顶上掠过，导致"走近了却完全无法交互"。
 * 旧值 h=1.6/y=0.8（顶面 1.6m）低于眼高 1.65m，正是失效原因。
 */
export const INTERACT_BOX = {
  slot:    { w: 1.5, h: 2.6, d: 0.7, y: 1.3 }, // 覆盖 0 ~ 2.6m
  counter: { w: 2.2, h: 2.6, d: 1.2, y: 1.3 },
  crate:   { w: 1.5, h: 2.4, d: 1.5, y: 1.2 }, // 覆盖 0 ~ 2.4m
};

/**
 * 交互选取（不再用单条射线）：取"视野锥内 + 距离内"的最优目标。
 * 单条射线要求像素级对准，玩家稍偏一点就打不中，表现为"明明看着它却提示要靠近"。
 */
export const PICK = {
  maxAngleDeg: 34,   // 视线与目标中心的最大夹角
  distPad: 1.4,      // 盒中心距离容差（补偿大盒体，REACH 判定的是中心距离）
  aimWeight: 1.5,    // 正对程度的加权：越大越偏向"正对着的目标"
};

/* ---------- 场景尺寸（米） ---------- */
/**
 * 整个可活动场地（外墙围合，中心在原点）。
 * player.mjs 的边界兜底直接复用它，所以必须保持"以原点为中心"。
 * 升级前是 12×10 的单间；现在 28×24 —— 便利店 + 室外三区 + 后巷。
 */
export const ROOM = { width: 28, depth: 24, height: 3.2, wallT: 0.25 };

/**
 * 便利店室内矩形。
 * 关键：货架 / 收银台 / 库存箱 / 门的坐标全部沿用升级前的取值，
 * 以便交互锚点与既有玩法（SYS-01…SYS-06）零改动地继续工作。
 */
export const STORE = {
  minX: -7, maxX: 7, minZ: -5, maxZ: 5,
  height: 3.2, wallT: 0.2,
  doorHalfW: 1.2, // 南墙门洞半宽（升级前即为此值）
};

/* ---------- 室外区域（仅布局分区，不设物理墙，保证道路连通） ---------- */
export const ZONES = {
  plaza: { name: '广场', minX: -6.5, maxX: 6.5, minZ: 5.6, maxZ: 11.2 },
  arcade: { name: '电玩区', minX: 7.2, maxX: 13, minZ: 5.6, maxZ: 11.2 },
  rest: { name: '休息区', minX: -13, maxX: -7.2, minZ: 5.6, maxZ: 11.2 },
  back: { name: '后巷', minX: -12, maxX: 12, minZ: -11, maxZ: -5.6 },
};

/**
 * 设施清单 —— 场景建模、碰撞体、连通性测试三者的唯一真源。
 * rot：绕 Y 轴旋转（弧度）。w/d 为占位尺寸（米）。
 */
export const PROPS = {
  // 电玩区：街机沿东墙一字排开
  arcades: [
    { x: 12.4, z: 6.4, rot: -Math.PI / 2 }, { x: 12.4, z: 7.7, rot: -Math.PI / 2 },
    { x: 12.4, z: 9.0, rot: -Math.PI / 2 }, { x: 12.4, z: 10.3, rot: -Math.PI / 2 },
  ],
  // 休息区：两组桌椅（含座椅占位）
  tables: [{ x: -10.2, z: 7.4 }, { x: -10.2, z: 9.8 }],
  // 自动售货机：广场两侧 + 后巷一台
  vendings: [{ x: 6.6, z: 6.4, rot: -Math.PI / 2 }, { x: -6.6, z: 6.4, rot: Math.PI / 2 }, { x: 0, z: 10.9, rot: Math.PI }],
  // 广场长椅（为让位给池塘，从 -3.2/3.2 挪到东侧）
  benches: [{ x: 2.6, z: 10.6 }, { x: 4.6, z: 8.6 }],
  // 绿植（广场四角）
  plants: [{ x: -5.6, z: 6.2 }, { x: 5.6, z: 6.2 }, { x: -5.6, z: 10.6 }, { x: 5.6, z: 10.6 }],
  // 灯柱（广场 + 两区各一）
  // 广场两柱放在 z=6.2（店门两侧）：若留在 8.4 会紧贴钓鱼池塘东岸，把钓位挤到只剩 0.1m 余量
  lamps: [{ x: -1.8, z: 6.2 }, { x: 1.8, z: 6.2 }, { x: 10.2, z: 6.2 }, { x: -10.2, z: 6.2 }],
  // 后巷：货箱堆
  crates: [{ x: -6.5, z: -8.6 }, { x: -5.4, z: -9.4 }, { x: 6.2, z: -8.8 }],
};

/** 设施占位尺寸（米），碰撞与建模共用 */
export const PROP_SIZE = {
  arcade: { w: 0.85, d: 0.95 }, table: { w: 2.0, d: 2.0 }, vending: { w: 1.15, d: 0.8 },
  bench: { w: 1.8, d: 0.5 }, plant: { w: 0.7, d: 0.7 }, lamp: { w: 0.28, d: 0.28 },
  crate: { w: 1.0, d: 1.0 },
};

/* ==================== 可玩娱乐设施 ==================== */

/** 钓鱼池塘本体（水面 + 围栏，玩家不能进入） */
export const POND = { x: -3.8, z: 8.8, w: 3.6, d: 3.0 };

/**
 * 可玩设施清单 —— 配置化，新增同类设施只需在这里加一条。
 * @kind 决定用哪个小游戏（见 MINIGAME 与 src/minigames.mjs）
 * @x/@z 设施本体位置；@rot 朝向（正面 +Z 绕 Y 旋转）
 * @standX/@standZ 玩家游玩时所站位置（交互锚点，默认在设施正面 1.1m 处）
 */
export const FACILITIES = [
  {
    id: 'pachinko1', kind: 'pachinko', name: '弹珠机', emoji: '🎰',
    x: 9.4, z: 7.7, rot: -Math.PI / 2, w: 1.0, d: 0.85,
  },
  {
    id: 'pachinko2', kind: 'pachinko', name: '弹珠机', emoji: '🎰',
    x: 9.4, z: 8.8, rot: -Math.PI / 2, w: 1.0, d: 0.85,
  },
  {
    id: 'hoop', kind: 'basketball', name: '投篮机', emoji: '🏀',
    x: 9.4, z: 9.9, rot: -Math.PI / 2, w: 1.2, d: 1.2,
  },
  {
    id: 'claw', kind: 'claw', name: '抓娃娃机', emoji: '🧸',
    x: 9.4, z: 6.6, rot: -Math.PI / 2, w: 1.0, d: 1.0,
  },
  {
    // 钓鱼：锚点在池塘东岸，池塘本体见 POND
    id: 'pond', kind: 'fishing', name: '钓鱼池塘', emoji: '🎣',
    x: POND.x, z: POND.z, rot: 0,
    // 钓位在东岸木栈道上：池塘东沿 -2.0 再让出 0.9m（> 玩家半径 0.32 的安全余量）
    standX: POND.x + POND.w / 2 + 0.9, standZ: POND.z,
  },
];

/**
 * 小游戏参数（全部外置，便于调平衡 / 加新设施时复用）
 * 平衡原则：期望收益 略低于或持平 于投入（成本 + 时间），
 * 保证"刷小游戏"不会取代便利店经营（有测试断言守着）。
 */
/* ==================== 星级成长线：2–5 星各解锁一台新机器 ====================
 *
 * 设计约束（与需求"复用现有体系"一致）：这些设施**不是**新的特殊对象，
 * 它们就是普通的 FACILITIES 条目 —— 因此自动继承现有的
 *   升级(progression) / 故障(worldState) / 改装(MODULES) / 上货(deviceStock) / 店员(staff)
 * 五套体系，不需要为它们写任何特例分支。
 * 摆放坐标选在**后巷**（ROOM 北半部 z≈-7.4）：那里除了货箱堆是空的，
 * 且"后巷"恰好是送货员 / 外卖员上门的位置，动线上自洽。
 */
export const STAR_UNLOCKS = [
  {
    star: 2,
    name: '霓虹舞池',
    deco: 'neonFloor',
    desc: '跳舞机 + 地面霓虹灯带',
    lamps: [{ x: -8.0, z: -6.2 }, { x: -8.0, z: -8.6 }],
    facilities: [
      {
        id: 'dance1', kind: 'dance', name: '跳舞机', emoji: '🕺',
        x: -8.0, z: -7.4, rot: 0, w: 1.6, d: 1.0,
      },
    ],
  },
  {
    star: 3,
    name: '竞速角',
    deco: 'racingBanner',
    desc: '赛车机 + 冠军横幅',
    lamps: [{ x: -3.5, z: -6.2 }, { x: -3.5, z: -8.6 }],
    facilities: [
      {
        id: 'race1', kind: 'racing', name: '赛车机', emoji: '🏎️',
        x: -3.5, z: -7.4, rot: 0, w: 1.5, d: 1.2,
      },
    ],
  },
  {
    star: 4,
    name: '迷你 KTV',
    deco: 'ktvCurtain',
    desc: 'KTV 唱歌机 + 隔音帘',
    lamps: [{ x: 1.2, z: -6.2 }, { x: 1.2, z: -8.6 }],
    facilities: [
      {
        id: 'ktv1', kind: 'ktv', name: 'KTV 唱歌机', emoji: '🎤',
        x: 1.2, z: -7.4, rot: 0, w: 1.8, d: 1.2,
      },
    ],
  },
  {
    star: 5,
    name: '经典点唱机',
    deco: 'goldPlaque',
    desc: '点唱机（纯氛围）+ 金色铭牌',
    lamps: [{ x: 5.6, z: -6.2 }],
    facilities: [
      {
        id: 'jukebox1', kind: 'jukebox', name: '点唱机', emoji: '📻',
        x: 5.6, z: -7.4, rot: 0, w: 0.9, d: 0.7,
      },
    ],
  },
];

export const MINIGAME = {
  pachinko: {
    cost: 10,          // 每次投币
    balls: 5,          // 每次给几颗弹珠
    gravity: 780,
    pegRows: 6,
    pegCols: 7,
    /* --- R4 玩法扩充：弹珠类型（球种决定物理手感与计分倍率） ---
     * 每颗球发射时按球种权重抽取；不同球种在同一台机器上共存 → 同一局的策略空间。
     * radius 参与碰撞（越大越容易被钉子弹开）；mul 是该球落槽得分的倍率。 */
    ballTypes: [
      { id: 'normal', name: '标准珠', weight: 62, radius: 9, mul: 1, color: '#E8EAF0', edge: '#9AA3B2', desc: '平衡' },
      { id: 'heavy', name: '重铁珠', weight: 18, radius: 11, mul: 1.6, color: '#8E97A8', edge: '#5C6577', desc: '重·高倍率·易被弹开' },
      { id: 'lucky', name: '幸运珠', weight: 14, radius: 8, mul: 2.2, color: '#F2C879', edge: '#B98A2E', desc: '轻·高倍率' },
      { id: 'bomb', name: '爆破珠', weight: 6, radius: 10, mul: 0.4, color: '#EB5757', edge: '#9B2C2C', desc: '落槽时炸开邻近钉子' },
    ],
    /* --- R4 道具（发射前可用，消耗本局道具额度） ---
     * 每个图标对应一次性的策略选择，让"什么时候用"成为决策点。 */
    items: [
      { id: 'guide', name: '导轨石', emoji: '📐', uses: 2, desc: '本次发射初速归零，垂直下落' },
      { id: 'magnet', name: '磁石', emoji: '🧲', uses: 2, desc: '把当前所有弹珠吸向中央' },
      { id: 'double', name: '加倍符', emoji: '✨', uses: 1, desc: '下一颗球落槽得分 ×3' },
    ],
    /* --- R4 连击 / 倍率 ---
     * 连续落进"非空槽"累积 combo；落空槽清零。
     * 注意：连击是**免费放大器**（没有额外成本），所以它必须足够克制，
     * 否则会把基础期望顶过投币额 → 测试第 6 节会直接 FAIL。
     * 这里用「低步长 + 低上限」，且倍率只作用于**基础槽分**（见 minigames 的 gain 计算），
     * 不与球种/关卡倍率连乘，避免乘数链叠加后失控。 */
    combo: { step: 0.08, max: 6, label: '连击' },
    /* --- R4 关卡 / 难度递进 ---
     * 设计教训（踩过两轮）：**物理落槽分布不能当作平衡杠杆**。
     * 钉子数量 / 行距一改，弹珠散射就重新混沌化，落空率在 56%–78% 之间非单调乱跳，
     * 结果反复出现"高关卡反而更穷"的反转 —— 递进形同虚设，且无法靠调参稳定收敛。
     * 现在的原则：
     *   · 钉子几何**四档全同**（保证落槽分布一致、期望可预测）
     *   · 难度只体现在 gravity（球更快、更难看准落点）—— 实测不改变分布形状
     *   · 收益递进完全交给 slotMul（确定性杠杆）
     * 这样"关卡越高 → 收益越高"是稳定成立的，测试第 6.4 节直接断言它。 */
    levels: [
      { lv: 1, minPlays: 0, pegRows: 6, pegCols: 7, gravity: 780, slotMul: 1.0, label: '新手台' },
      { lv: 2, minPlays: 3, pegRows: 6, pegCols: 7, gravity: 900, slotMul: 1.25, label: '进阶台' },
      { lv: 3, minPlays: 8, pegRows: 6, pegCols: 7, gravity: 1030, slotMul: 1.55, label: '达人台' },
      { lv: 4, minPlays: 15, pegRows: 6, pegCols: 7, gravity: 1180, slotMul: 1.90, label: '狂热台' },
    ],
    // 落槽：weight 同时决定槽宽比例 → 物理概率天然等于权重
    // 计分口径（见 minigames）：base = 槽分×球种×加倍符×关卡倍率；连击只额外加成槽分。
    // 权重与分值定得比"纯期望 = 投币额"略低（期望 ¥8.5 左右），
    // 留出连击加成 ~¥1 的余量，保证基础档实测平均仍 ≤ ¥10（gameplay.test 第 6 节守着）。
    slots: [
      { label: '空', score: 0, weight: 58 },
      { label: '小奖', score: 1, weight: 22 },
      { label: '中奖', score: 3, weight: 13 },
      { label: '大奖', score: 8, weight: 6 },
      { label: 'JACKPOT', score: 30, weight: 1 },
    ],
  },
  fishing: {
    cost: 0,           // 免费，代价是时间
    castMinSec: 1.5,   // 抛竿后等待上钩
    castMaxSec: 5.5,
    reelSpeed: 1.15,   // 收杆 QTE 指针速度
    greenRatio: 0.30,  // 绿色判定区占比（越小越难）
    fish: [
      { name: '小鲫鱼', price: 4, weight: 50 },
      { name: '鲤鱼', price: 10, weight: 34 },
      { name: '大鲈鱼', price: 20, weight: 14 },
      { name: '稀有·锦鲤', price: 60, weight: 2 },
    ],
  },
  basketball: {
    cost: 5,
    shots: 5,          // 每次几球
    payPerHit: 2,      // 每命中一球的收益
    timePerShotSec: 6, // 每球限时（超时算不中）
    // 绿色力度区 —— 必须与抛物线实际能进筐的力度区间一致，
    // 否则"看着在绿区却投不进"，QTE 反馈就是在骗玩家（有测试守着）
    green0: 0.53, green1: 0.69,
    catchTol: 42,      // 进筐判定的水平容差（像素）
  },
  claw: {
    cost: 8,
    moveSpeed: 1.5,    // 爪子横移速度
    grabBase: 0.35,    // 基础成功率（对准目标还会加成）
    alignBonus: 0.25,  // 完全对准时的加成上限 → 最高 0.60
    prizes: [
      { name: '小挂饰', price: 6, weight: 50 },
      { name: '毛绒玩偶', price: 14, weight: 35 },
      { name: '限定手办', price: 45, weight: 15 },
    ],
  },
  /**
   * 售货机（需求⑦ exp2 解锁的"独立售货专区"）。
   * 刻意**没有小游戏面板** —— 它是需求⑤老年顾客的"简单售货机"，
   * 按 E 直接收一笔货款就走，代价是 cooldownSec 的冷却（防止站桩刷钱）。
   */
  vending: {
    cost: 0,
    payout: [3, 8],       // 单次收货款区间
    cooldownSec: 25,      // 同一台的收款冷却
  },

  /* ---------- 星级解锁机的玩法参数（平衡口径与既有机器一致：期望 ≤ 投币额） ---------- */
  /**
   * 跳舞机：箭头进入判定圈时按对应方向键的节奏 QTE。
   * 判定圈从外向内收缩，箭头中心与判定圈重合时按键 → Perfect / Good / Miss。
   * 连击只加**表现分与代币**，金币收益刻意压在投币额以下（与弹珠机同一条纪律）。
   */
  dance: {
    cost: 10,
    arrows: 12,          // 一首曲子的箭头数
    bpm: 120,            // 出箭速度
    approachSec: 1.5,    // 箭头从出现到抵达判定圈的时间
    perfectWin: 0.09,    // 判定时间窗（秒）：±0.09 Perfect
    goodWin: 0.20,       // ±0.20 Good，之外 Miss
    scorePer: { perfect: 3, good: 1 },
    comboStep: 0.05,     // 连击加成（只乘在表现分上）
    comboMax: 5,
    tokenPerCombo: 6,    // 每 6 连击给 1 代币（成就"节奏大师"的口径）
  },
  /**
   * 赛车机：30 秒漂移短局。弯道里贴内线并维持速度 → 完美过弯。
   * 中等收益、短局时长 → 设计目标是"高复玩"而不是"高单次收益"。
   */
  racing: {
    cost: 8,
    durationSec: 30,
    baseSpeed: 60,
    maxSpeed: 120,
    accel: 18,           // 每秒加减速
    driftBonusPerSec: 2, // 漂移中每秒积攒的完美度
    perfectThreshold: 26,// 完美过弯所需的漂移积分
    scorePerCorner: 4,
    tokenPerPerfect: 3,  // 每 3 个完美过弯给 1 代币
  },
  /**
   * KTV：选曲 → 按节奏在音准条上按空格 → 打分。
   * 特色是**社交**：评分越高，越有可能连带带友（每台最多 +3 名顾客进店）。
   */
  ktv: {
    cost: 12,
    songs: [
      { id: 'ballad', name: '深夜慢歌', difficulty: 0.8, tempo: 0.9 },
      { id: 'pop', name: '流行热歌', difficulty: 1.0, tempo: 1.15 },
      { id: 'rock', name: '摇滚狂想', difficulty: 1.25, tempo: 1.4 },
    ],
    notes: 10,
    hitWindow: 0.22,
    scorePerHit: 3,
    /** 评分 ≥ 门槛时带来的连带顾客数（上限 3） */
    bringFriends: { threshold: 18, max: 3 },
    tokenPerScore: 25,   // 每 25 分给 1 代币
  },
  /**
   * 点唱机：纯氛围机，**不产出收益**（cost 0 / 无小游戏面板）。
   * 按 E 切换店内 BGM 曲风；全场顾客停留时间 +15%（由 themes/ambient 读取）。
   */
  jukebox: {
    cost: 0,
    /** 可切换的曲风（同时决定 BGM 情绪与顾客停留加成） */
    styles: [
      { id: 'citypop', name: '城市流行', stayMul: 1.15 },
      { id: 'lofi', name: '深夜 Lo-Fi', stayMul: 1.15 },
      { id: 'retro', name: '复古电子', stayMul: 1.15 },
    ],
    /** 氛围机：不参与 deviceStock / 故障判定之外的收益体系 */
    ambient: true,
  },
};

/* ==================== R1 店员状态 / 事件 / R2 小吃摊 / R3 娱乐回血 ==================== */
/* 数值锁定于 design/gdd/playability-plan.md §8.1（已按 480s 夜长重标定，见 §1.2） */

export const CLERK = {
  kM: 0.05, idleRecover: 0.10, wallRecover: 1.5,
  actionCost: { TAKE: 1.5, PLACE: 1.5, CHECKOUT: 1.0, DRUNK: 3.0 },
  segRate: { S1: 0, S2: 0.04, S3: 0.09, S4: 0.14 },
  fatigueBase: 0.07, lowStaminaBonus: 0.05,
  satietyDrain: 0.09,
  thr: { stamina: 25, fatigue: 70, satiety: 30, mental: 30 },
  nightReset: { staminaAdd: 40, mentalGain: 8, mentalLossOnDeficit: 6 },
};

export const EVENTS = {
  RUSH:     { prob: 0.7, seg: ['S2', 'S3', 'S4'], duration: 90, mult: 1.8, bias: { drink: 0.42, noodle: 0.38, bento: 0.20 } },
  DRUNK:    { prob: 0.5, busy: 3.0, success: 0.9, successMentalMul: 0.7, repGood: 2, repBad: -5, stamCost: 3, mentalBad: -5, timeout: 30 },
  BLACKOUT: { prob: 0.4, duration: 25, mentalOnset: -3 },
  REGULAR:  { prob1: 0.8, prob2: 0.4, seg: ['S1', 'S2', 'S3'], tip: 1.1, repGain: 1 },
};

export const SNACK = { price: 15, satietyGain: 40, eatBusy: 2.5 };

/** 小吃摊在世界中的摆放（单一真源；广场左前，靠近店门但不挡动线） */
export const SNACK_STALL = { x: -4.0, z: 8.0, rot: 0 };

export const MENTAL_GAIN = {
  pachinko:   { base: 4, k: 0.15, cap: 14 },
  fishing:    { base: 2, baseHit: 8, k: 0.2, cap: 12 },
  basketball: { base: 3, k: 1.5, cap: 12 },
  claw:       { base: 3, baseHit: 8, cap: 10 },
  /* 星级解锁机：数值与既有机器同档，不额外抬高回血上限 */
  dance:      { base: 4, k: 0.12, cap: 12 },
  racing:     { base: 3, k: 0.2, cap: 10 },
  ktv:        { base: 4, baseHit: 8, cap: 12 },
  nightCap: 40,
};

/* ==================================================================
 * 店员系统（维修员 / 保洁员 / 采购员 / 上货员）
 *
 * 四类店员各可雇 1 人，店员总上限 4 名。所有数值集中此处，其它模块只引用。
 * 店员拥有「体力 / 休息」机制（沿用 R1 的店员四状态口径，但 clerk 是玩家本人、
 * staff 是雇员，两套状态互不干扰）：连续工作会累，累了去休息区歇一会。
 * 每 180 游戏秒统一扣一次薪资；金币不足则全员停工，补足后恢复。
 * ================================================================== */
export const STAFF = {
  /** 每种店员最多雇几人（各 1） */
  maxPerType: 1,
  /** 店员总上限（维修 + 保洁 + 采购 + 上货） */
  maxTotal: 4,
  /** 每多少游戏秒扣一次薪资 */
  salarySec: 180,
  /** 体力低于此值去休息 */
  restStamina: 25,
  /** 休息时体力恢复速率（/s） */
  restRecover: 7,
  /** 工作时体力消耗速率（/s） */
  workDrain: 1.1,
  /** 外出采购（采购员）往返耗时（秒） */
  errandSec: 6,
  /** 单次动作（修一台 / 清一件 / 上一格 / 采购一批）的冷却（秒），避免一帧狂点 */
  actionCd: 1.6,
  /** 四类店员定义 */
  types: {
    repairer: { id: 'repairer', name: '维修员', emoji: '🔧', hireCost: 200, salary: 60, color: 0xE8A94E,
      desc: '自动维修故障设备 · 不清理不补货' },
    cleaner:   { id: 'cleaner',   name: '保洁员', emoji: '🧹', hireCost: 180, salary: 55, color: 0x6FCF97,
      desc: '自动清理店内垃圾 · 不维修不补货' },
    purchaser: { id: 'purchaser', name: '采购员', emoji: '📦', hireCost: 220, salary: 65, color: 0x4FD1E8,
      desc: '库存低于阈值自动外出采购补货' },
    stocker:   { id: 'stocker',   name: '上货员', emoji: '📤', hireCost: 200, salary: 60, color: 0xB15BD8,
      desc: '自动把仓库货品上架到货架与设备' },
  },
  /** 顺序（HUD 展示用） */
  order: ['repairer', 'cleaner', 'purchaser', 'stocker'],
};

/* ==================================================================
 * 仓库系统（需求J）
 *
 * 仓库只存「货品」，不存机器零件/装饰摆件（那些不占容量）。
 * 容量按「总件数」计：零食饮料(snack) 直接复用既有 backroom 库存箱，
 * 玩具(toy)/鱼饵(bait)/维修耗材(parts) 是仓库独立计数的三类货品。
 * 容量超限后采购员与玩家都不能再购入；可在 Tab 商店花金币扩容。
 * ================================================================== */
/* ---------- 抓娃娃机玻璃柜（P0-4：不许空柜子） ----------
 * 线上问题：玻璃柜里一个娃娃都没有，透光看就是个空箱子。
 *
 * 规则：
 *  · 柜内还有货 → 至少摆 minDolls 个（"摆满"的观感底线），最多 maxDolls 个
 *  · 柜内见底（deviceStock.claw = 0 且仓库也没娃娃可补）→ 娃娃全部隐藏 + 挂补货提示
 *  · **任何情况下都不允许出现"空着又什么都不说"的柜子**
 *
 * maxDolls 必须与 WAREHOUSE.deviceStockMax.claw 一致（下面直接引用本常量，避免两处漂移）。
 */
export const CLAW_CABINET = {
  minDolls: 8,
  maxDolls: 10,
  /** 娃娃配色池（4 色，随机分配但每只固定，位置稳定不闪） */
  colors: [0xE8739B, 0xF2C879, 0x6FC3F0, 0x9BE08A],
  /**
   * 见底时柜内悬浮的补货提示文案。
   * 刻意**不带 emoji**：这块牌子是 Canvas 位图贴图，emoji 走系统彩色字体，
   * 在无 GPU 的环境（headless / 部分 Windows 字体缺失）会退化成"豆腐块"方框 ——
   * 提示牌本身是"柜子空了"的唯一说明，不能赌字体。人物/商品模型自带形态，不缺这个图标。
   */
  restockHint: '缺货 · 待补娃娃',
};

export const WAREHOUSE = {
  /** 容量分级（level → 容量 / 扩容花费）。level 0 为初始容量 */
  tiers: [
    { level: 0, cap: 120, cost: 0 },
    { level: 1, cap: 220, cost: 300 },
    { level: 2, cap: 360, cost: 650 },
    { level: 3, cap: 560, cost: 1100 },
  ],
  /** 采购员采购溢价（在基础采购成本上额外加价，少量） */
  purchaserPremium: 0.15,
  /** 四类货品定义（snack 映射到 backroom 库存箱，其余为独立计数） */
  goods: {
    snack: { id: 'snack', name: '零食饮料', emoji: '🥤', cost: 3, unit: '份', threshold: 45,
      desc: '售货机 / 货架消耗 · 直接存入库存箱' },
    toy:   { id: 'toy',   name: '娃娃机娃娃', emoji: '🧸', cost: 5, unit: '个', threshold: 8,
      desc: '抓娃娃机奖品补充' },
    bait:  { id: 'bait',  name: '钓鱼鱼饵', emoji: '🪱', cost: 2, unit: '份', threshold: 12,
      desc: '钓鱼消耗 · 鱼饵不足仍可钓但提示' },
    parts: { id: 'parts', name: '维修耗材', emoji: '🛠️', cost: 4, unit: '件', threshold: 6,
      desc: '机器维修消耗 · 有则省现金' },
  },
  /** 设备库存（售货机 / 娃娃机）上限：上货员补到此值即视为满 */
  deviceStockMax: { vending: 12, claw: CLAW_CABINET.maxDolls },
};

/* ---------- R4 本地排行榜（需求D） ---------- */
/**
 * 只存本地（localStorage），不涉及任何网络 —— 联机排行榜的位置见 account.mjs 的 NetBridge。
 * 每类小游戏各留一条榜；同分按"更早达成"排前（更难的先做到）。
 */
export const LEADERBOARD = {
  storageKey: 'nightshift.leaderboard.v1',
  maxEntries: 10,          // 每类小游戏最多保留几条
  // 各类小游戏的排行指标说明（用于 UI 文案）
  metrics: {
    pachinko: { label: '单局最高分', unit: '分' },
    fishing: { label: '最贵渔获', unit: '¥' },
    basketball: { label: '单局命中', unit: '球' },
    claw: { label: '最贵奖品', unit: '¥' },
    /* 星级解锁机：口径沿用"越高越好"的既有约定 */
    dance: { label: '单局最高连击', unit: '连' },
    racing: { label: '单局完美过弯', unit: '弯' },
    ktv: { label: '单曲最高分', unit: '分' },
  },
};

/* ---------- 演示 / 调试 ---------- */
/** 把一夜压缩到 N 秒便于演示（设为 null 则用 NIGHT_WALL_SECONDS） */
export const DEMO_NIGHT_SECONDS = 480; // 试玩节奏：一夜 8 分钟（v1.1 重标定，见 §1.2）

/* ---------- 场景关键位置（单一真源：scene.mjs 据此构造 Vector3，测试直接引用） ---------- */
export const POS = {
  counter: { x: 3.6, z: 3.4 },
  crate: { x: 4.6, z: -3.4 },
  // 以下由 STORE 推导，保证与升级前取值一致（门 4.6 / 出生点 3.4）
  door: { x: 0, z: STORE.maxZ - 0.4 },
  spawn: { x: 0, z: STORE.maxZ - 1.6 },
  doorIn: { x: 0, z: STORE.maxZ - 1.2 },   // 顾客进店后的第一个路点
  doorOut: { x: 0, z: STORE.maxZ + 2.2 },  // 顾客离场终点（广场上）
};

/** 货架排布：2 排 × 4 格 = 8 格（起始）。
 * 第 3 行是「新货架排」扩张项解锁后落位 slots 8,9 用的 —— 只放 2 个 z，
 * 配合 state.slots 扩容 +2（expandSlots(2)），与既有 4 格/排的语义不冲突。
 * ⚠ 不要把 SLOT_COUNT 改成 12：它仍是起始 8 格，第 3 行由 applyShelfRow 单独建。 */
export const SHELF_ROWS = [
  { x: -4.2, zs: [-3, -1, 1, 3] },
  { x: -1.4, zs: [-3, -1, 1, 3] },
  // 新货架排：收银台(x=3.6)左侧留出行走通道，故 x=1.4、只取中间两格
  { x: 1.4, zs: [-1, 1] },
];

/* ---------- 店铺成长线（B）：现金 + 星级门槛的扩张投资 ----------
 * 与需求I 第⑦条的「区域扩建」(EXPANSIONS / state.expansions) 完全独立：
 * 那边是分区解锁 + 场景外扩，这边是「花钱 + 够星」买 3 个永久投资项。
 * 命名刻意错开（GROWTH_EXPANSIONS / state.expansion 单数）避免读档/渲染混淆。 */
export const GROWTH_EXPANSIONS = [
  { id: 'shelfRow',   name: '新货架排',   cost: 800,  star: 2, desc: '解锁 2 个新商品位（场景新增一排货架）' },
  { id: 'nightStall', name: '店外夜市摊', cost: 1200, star: 3, desc: '每夜被动收入 ¥40+（随口碑浮动，停电不产出）' },
  { id: 'renovation', name: '装修升级',   cost: 2000, star: 4, desc: '地板 / 灯光 / 招牌焕新（纯视觉）' },
];

/* ==================================================================
 * 需求I：玩法叠加（设备升级 / 限时任务 / 道具 / 改装 / 顾客类型 / 突发事件 / 扩建）
 *
 * 全部数值集中于此，与上方 SYS-01…SYS-06 的既有段落保持同一约定：
 * 其它模块只引用，不硬编码。
 * ================================================================== */

/* ---------- ① 设备升级（3 级） ---------- */
/**
 * 下标 = 等级 - 1。
 * 设计意图：升级是"收益与风险同时上台阶"的决策，而不是纯正增益 ——
 *   · attractMul  ↑ 游玩顾客变多（需求①"升级后游玩顾客变多"）
 *   · revenueMul  ↑ 单次收益提升
 *   · breakMul    ↑ 故障率同步小幅上升（否则升级无代价，玩家会无脑点满）
 * 故障率上升必须"小幅"：太高会让高级设备变成负资产，与"升级"的心智相反。
 */
export const DEVICE_UPGRADE = {
  maxLevel: 3,
  /** 升到 lv2 / lv3 的造价 */
  cost: [120, 280],
  /** 各等级对 NPC 的吸引力权重倍率 */
  attractMul: [1.0, 1.3, 1.65],
  /** 各等级单次游玩收益倍率 */
  revenueMul: [1.0, 1.35, 1.7],
  /** 各等级故障率倍率（小幅上升） */
  breakMul: [1.0, 1.15, 1.32],
  /** 各等级维修费倍率（机器更贵，修起来也更贵） */
  repairMul: [1.0, 1.2, 1.45],
  /** 各等级柜体的霓虹描边色（外观随等级小幅变化，见 scene.updateDeviceVisuals） */
  tint: [null, 0x4FD1E8, 0xB15BD8],
};

/* ---------- ④ 机器改装自选模块 ---------- */
/**
 * 一台机器最多装 MODULE_MAX_PER_DEVICE 种；拆除回收半价（MODULE_REFUND）。
 * 三个模块分别对应"降风险 / 拉客流 / 提周转"三条不同的经营思路，
 * 玩家必须根据机器位置（热门机位 vs 边角机位）做取舍。
 */
export const MODULE_MAX_PER_DEVICE = 2;
export const MODULE_REFUND = 0.5;

export const MODULES = [
  {
    id: 'damper', name: '降噪模块', emoji: '🔇', cost: 150,
    eff: '故障概率 −35%',
    breakMul: 0.65,
  },
  {
    id: 'neon', name: '彩灯模组', emoji: '💡', cost: 180,
    eff: '吸引顾客 ×1.35',
    attractMul: 1.35,
  },
  {
    id: 'quick', name: '快充模块', emoji: '⚡', cost: 160,
    eff: '游玩时长 −40% · 客流周转加快',
    playSecMul: 0.6,
  },
];

export const MODULE_BY_ID = Object.fromEntries(MODULES.map((m) => [m.id, m]));

/* ---------- ③ 道具背包与消耗品 ---------- */
/**
 * 三种道具对应三种"花钱换时间"的场景：
 *   repairkit —— 省去跑到故障机前的路程与停摆损失
 *   spray     —— 一键清场，应对垃圾成堆的脏乱局面
 *   poster    —— 主动拉客，配合客流低谷期使用
 * 使用方式统一：B 打开背包 → 选中 → 按 E 使用 → 单次消耗消失。
 */
export const CONSUMABLES = [
  {
    // 数值调整：¥60 → ¥40（用户要求，避免第一夜什么都买不起）
    id: 'repairkit', name: '快速维修包', emoji: '🧰', price: 40,
    desc: '一键修好当前对准的设备',
    /** 用法语义：'target' = 需要准星对准一个目标 */
    use: 'target',
  },
  {
    // 数值调整：¥45 → ¥30（同上）
    id: 'spray', name: '清洁喷雾', emoji: '🧴', price: 30,
    desc: '一键清除附近所有垃圾',
    radius: 9,
    use: 'nearby',
  },
  {
    id: 'poster', name: '人气海报', emoji: '📣', price: 90,
    desc: '60 游戏秒内 NPC 到访数量提升',
    durationSec: 60,
    trafficMul: 1.6,
    use: 'now',
  },
  {
    // 疲劳系统：提神喷雾（消耗品）。use:'now' = 选中后按 E 立即用，不依赖对准目标。
    id: 'energyspray', name: '提神喷雾', emoji: '⚡', price: 25,
    desc: '立刻恢复一截精力（疲劳 −45）',
    use: 'now',
  },
];

export const CONSUMABLE_BY_ID = Object.fromEntries(CONSUMABLES.map((c) => [c.id, c]));

/* ---------- 玩家疲劳系统（新增，与店员疲劳完全独立） ---------- */
/**
 * 疲劳度 0..max；gameHour 定义：0 = 22:00 开店，凌晨 3:00 ≈ gameHour 5，5:00 ≈ gameHour 7。
 * 数值刻意独立成块 —— 店员疲劳在 CLERK 里（§1.3），两者阈值/恢复不同，别混。
 */
export const FATIGUE = {
  max: 100,
  /** 基础累积速率（疲劳点 / 游戏秒）。一整夜 8 游戏小时 = NIGHT_WALL_SECONDS 墙钟秒，
   *  满 100 点约等于"从清醒熬到彻底困死"，baseRate 按这个尺度定，别让玩家第一夜就昏过去。 */
  baseRate: 0.011,
  /** 凌晨 3:00–5:00 加速区间（gameHour）与倍率 */
  accelerateFrom: 5,
  accelerateTo: 7,
  accelerateMul: 2.0,
  /** 三档阈值（疲劳度） */
  lightAt: 30,
  mediumAt: 60,
  heavyAt: 85,
  /** 表现参数 */
  vignetteMax: 0.5,       // 轻度起边缘变暗的最大强度（叠加在设置暗角上）
  sensDrop: 0.10,         // 中度灵敏度下降 10%
  swayAmp: 0.0035,        // 中度准星微飘幅度（rad）
  dozeSec: 5,             // 重度未处理时强制打瞌睡 5 秒
  yawnCooldownSec: 18,    // 打哈欠字幕冷却，避免连刷
  /** 三种恢复手段（一次性恢复的疲劳点数） */
  coffeeRecover: 70,      // 咖啡机喝一杯：清零大半
  sprayRecover: 45,       // 提神喷雾：中等
  washRecover: 15,        // 洗手台洗冷水脸：小幅
};

/* ---------- QTE 小游戏（维修 / 清洁 / 上货） ---------- */
/**
 * 玩家**亲手**做维修/清洁/上货时，弹一个 5 秒内的 QTE 小面板；
 * 店员 AI 与道具（快速维修包 / 清洁喷雾）路径完全不经过这里，天然跳过 QTE。
 *
 * 数值总原则（用户要求）：玩家自己做 = 更快、更便宜。
 *   · 维修：成功按顺序点完螺丝 → 维修费打折；每点错一次 +10%，封顶回到原价（绝不比直接修贵）。
 *   · 清洁 / 上货：本身不花钱，收益体现在"动作耗时更短"（busySec 低于原 ACTION_DURATIONS）。
 * QTE 只加不改：失败/超时/退出 = 动作不执行（机器仍坏 / 垃圾仍在 / 货仍在手上），老逻辑不受影响。
 */
export const QTE = {
  /** 统一超时（墙钟秒，倒计时条按此走；与游戏时钟解耦） */
  timeLimitSec: 5,

  /** 维修 QTE：按顺序点螺丝位 */
  repair: {
    screws: 4,            // 螺丝数量（随机打乱顺序，需按高亮顺序点）
    discountMul: 0.6,     // 成功后的维修费折扣（6 折）
    mistakePenalty: 0.1,  // 每点错一次，维修费 +10%
    maxCostMul: 1.0,      // 封顶：最多回到原价（QTE 做得差也不比直接修贵）
    busySec: 0.6,         // 成功后的动作耗时（原维修 1.2s → 更快）
  },

  /** 清洁 QTE：拖抹布擦 3 下 */
  clean: {
    wipes: 3,             // 需要完整擦过的次数
    busySec: 0.4,         // 原清洁 0.8s → 更快
  },

  /** 上货 QTE：拖拽到正确货架格 */
  restock: {
    busySec: 0.5,         // 原上货 0.8s → 更快
  },
};

/* ---------- 前台手机（按 O 打开） ---------- */
/**
 * 旧屏风格手机：点评 APP（差评触发补救任务）/ 跑腿接单 / 消息箱。
 *
 * 设计总原则（只加不改）：
 *   · 点评由 phone.mjs 用 served / lostSales 的**累计值差分**判定成交/失销，
 *     零埋点，不碰 economy / customers 的任何一行。
 *   · 跑腿是"接了之后倒计时、到点自动到账"的纯计时订单，不引入离开店铺的复杂移动，
 *     代价由每夜接单上限 + 奖励与门店营收解耦（走 state.cash 直接加，不计 revenue/earned）体现。
 *   · 差评累积到阈值触发"补救任务"，完成后回补口碑并清零差评标记 —— 给玩家一个救口碑的出口。
 */
export const PHONE = {
  /** 点评 / 消息箱各自保留的最大条数（历史越滚越长，只留最近 N 条） */
  reviewsMax: 20,
  inboxMax: 30,

  /** 累计未补救差评达到此数 → 触发补救任务（跨夜累积，不随夜清零） */
  badReviewThreshold: 3,
  /** 口碑高于此值（0..100）时，成交更倾向好评 */
  goodRepThreshold: 75,

  /** 好评 / 中评 / 差评 的概率（按口碑分档），三档各自求和为 1 */
  ratingByRep: [
    { good: 0.70, mid: 0.25, bad: 0.05 },  // 高口碑（>= goodRepThreshold）
    { good: 0.40, mid: 0.40, bad: 0.20 },  // 中口碑
    { good: 0.18, mid: 0.32, bad: 0.50 },  // 低口碑
  ],

  /** 跑腿订单：每夜接单上限 / 可选订单种类（reward 入现金，sec 为倒计时游戏秒） */
  errandMaxPerNight: 3,
  errands: [
    { id: 'normal', label: '普通跑腿', emoji: '🛵', reward: 60, sec: 90, desc: '帮街坊带点夜宵，90 秒后到账' },
    { id: 'urgent', label: '加急跑腿', emoji: '🚀', reward: 130, sec: 45, desc: '加急单，45 秒后到账' },
  ],

  /** 补救任务：差评触发后，需再接待 goal 位顾客（served 差分），完成后回补口碑 + 现金 */
  remedy: {
    goal: 3,
    rewardRep: 8,
    rewardCash: 40,
  },
};

/* ---------- ④ 监控室 + 二手市场 + 常客 + 节日（模块 4，只加不改） ----------
 * 四个子功能共用"只加不改"原则：
 *   · 监控室：小偷是每夜临时事件（不进存档），抓住给奖励、漏抓失窃现金。
 *   · 二手市场：二手设备是抽象经营资产（不新增 3D 机器），faulty 30% 概率，
 *     回收退 50%；每夜按"good 状态"产出被动代币。
 *   · 常客：faceId 跨夜计数，满 3 夜变熟客（复用 isRegular 已有的 rep+1 / 10% 小费加成）。
 *   · 节日：在 THEMES 表加三条节日主题，效果全乘在既有入口，预告走 themeNextId 既有机制。 */
export const MONITOR = {
  /** 每夜小偷出现次数范围（按概率 0/1/2） */
  minThieves: 0,
  maxThieves: 2,
  /** 单只小偷存活时长（墙钟秒），玩家须在这段时间内从监控室抓住它 */
  thiefSeconds: 9,
  /** 抓住小偷的奖励现金 */
  catchReward: 45,
  /** 漏抓时被盗走的现金 */
  stealAmount: 70,
  /** 4 路监控分区名称（与 scene 区域对应，纯展示） */
  zones: ['店内货架', '电玩区', '广场', '休息区'],
};

export const SECONDHAND = {
  /** 每夜生成的二手挂牌数 */
  listingsPerNight: 4,
  /** 挂牌中"故障机"概率（需求：30% 故障） */
  faultyChance: 0.30,
  /** 二手设备基础价（按 kind 在 FACILITIES 里取不到时用的兜底） */
  basePrice: 120,
  /** 故障机挂牌价 = 良品 × faultyPriceMul */
  faultyPriceMul: 0.55,
  /** 修复一台故障二手设备的费用 */
  repairCost: 40,
  /** 回收退费比例（需求：50%） */
  recycleMul: 0.5,
  /** 每台"正常运转"的二手设备每夜产出的代币（settle 时结算） */
  incomePerGood: 12,
  /** 可交易的设备类型（emoji/name 取自这里，避免依赖 scene/three） */
  kinds: [
    { kind: 'pachinko', name: '弹珠机', emoji: '🎰' },
    { kind: 'claw', name: '抓娃娃机', emoji: '🧸' },
    { kind: 'basketball', name: '投篮机', emoji: '🏀' },
    { kind: 'dance', name: '跳舞机', emoji: '🕺' },
    { kind: 'racing', name: '赛车机', emoji: '🏎️' },
    { kind: 'ktv', name: 'KTV 机', emoji: '🎤' },
    { kind: 'jukebox', name: '点唱机', emoji: '📻' },
    { kind: 'vending', name: '售货机', emoji: '🥤' },
  ],
};

export const REGULARS = {
  /** 同一张脸（faceId）跨夜访问满几夜变为熟客（需求：3 夜） */
  nightsToRegular: 3,
  /** 固定脸谱池大小：顾客从这张池子里随机取一个稳定 faceId，
   *  池子小 → 同一张脸会跨夜反复出现 → 满 3 夜变熟客；池子大则几乎不重复。
   *  取值让"每夜到店量 / 池大小 ≈ 1"，即平均每张脸每夜约出现 1 次，约 3 夜出熟客。 */
  rosterSize: 18,
  /** 熟客结账加成（复用 economy 的 isRegular 逻辑：rep+REGULAR.repGain / 小费 ×REGULAR.tip） */
  /** 随机生成的常客名字池（带"熟"的昵称） */
  names: ['阿强', '小敏', '老周', '丸子', '阿杰', '丽丽', '大壮', '阿May', '阿Ken', '豆豆'],
  /** 熟客头顶"熟"标 */
  tag: '熟',

  /* ---------- 2026-10-06 块2：忠诚度 1~5 级 + 偏好商品 ----------
   * 在既有"满 3 夜变熟客"之上叠一层成长：熟客每回购一次忠诚度 +1，满 5 级封顶。
   *
   * 折扣口径（需求：95折→85折）：
   *   折扣按**该常客偏好的那一个 SKU** 生效，不是全店打折 ——
   *   全店打折会直接击穿 economy 的平衡（促销 C 方案 60/10/2.2 的回本线），
   *   而"只有他常买的那一样便宜"既有ident感，又只影响该 SKU 的那部分营收。
   *
   * 数值取向：折扣从 1.00 起步（1 级无折扣，纯计数），到 5 级 0.85。
   * 1 级就给折扣会让"培养熟客"变成开局立刻见效的白收益，没有过程；
   * 给到 0.85 而不是更狠，是因为复购率本身已经提高成交频次，
   * 折扣再深就变成"故意不卖高价货"的套利路径了。
   */
  loyalty: {
    maxLevel: 5,
    /** 各等级折扣乘在**偏好 SKU** 的售价上（1 级无折扣） */
    discountByLevel: [1.0, 0.95, 0.92, 0.88, 0.85],
    /** 各等级标签（HUD / 手机面板显示） */
    labelByLevel: ['新客', '熟客', '常客', '老客', '铁杆'],
    /** 偏好商品候选池（从可售 SKU 里挑，保证常客要的货你真的能进） */
    preferPool: ['drink', 'noodle', 'bento', 'grocery', 'gum', 'battery', 'magazine'],
    /** 每回购一次忠诚度 +1（需求：来店次数累计） */
    perVisit: 1,
  },
};

/* ============================================================
 *  口碑分（2026-10-06 块2）
 *
 *  ⚠ 关键决策：**不新造一套并行数值**，直接复用 state.reputation（0..100）。
 *  理由：项目里 reputation 已经在三条既有链路上发挥作用 ——
 *   ① checkout 里成交 +0.5 / 失销 −1；
 *   ② 星级判定（settleNight：reputation >= 50 才有一星）；
 *   ③ state.mjs 的 repMul 直接乘在客流上。
 *  再造一个"口碑分"与之并存，玩家会看到"满意度 72 / 口碑 45"两个意义重叠的数字，
 *  调平衡时也不知道该调哪个 —— 这是典型的双真源陷阱。
 *  所以块2 的"口碑分"= state.reputation，只补两块既有链路上缺的东西：
 *   a) 打烊结算面板上的**可视化**（此前 reputation 完全不显示）；
 *   b) 明确的**次日客流系数档位**（既有 repMul 是连续线性，需求要的是 60/90 两档）。
 * ============================================================ */
export const WORD_OF_MOUTH = {
  /** 档位按 reputation 划分（闭区间下界） */
  tiers: [
    { min: 90, mul: 1.3, label: '口碑爆棚', emoji: '🌟', desc: '街坊都说你这家好 · 客流 +30%' },
    { min: 60, mul: 1.0, label: '口碑平稳', emoji: '🙂', desc: '正常水平 · 客流不变' },
    { min: 0,  mul: 0.8, label: '风评不佳', emoji: '😓', desc: '有人抱怨 · 客流 −20%' },
  ],
  /** 结算面板里"口碑分档位"的取值区间（用于打表显示） */
  bands: [90, 60, 0],
};

/* ============================================================
 *  账号重开（重置）—— 把本账号的进度清回初始状态
 *
 *  三条限制的理由（都不是凑数的）：
 *   · 冷却：重开是不可逆动作，且会立刻重开一夜 —— 没有冷却就能被连点成
 *     "无限重摇开局"，把开局随机性变成可刷的东西。
 *   · 每日上限：留出容错（选错了想重来），但堵住"当刷分/刷开局工具用"。
 *     **按本地自然日**计数，跨日自动归零（见 reset.mjs）。
 *   · 必须验密码：重开等于把账号清空，任何"点一下就行"的入口都太危险；
 *     顺带也挡住了"别人拿你机器点两下把你档清了"。
 *
 *  配额记在 localStorage（不在游戏存档里）—— 它是**账号级**元数据，
 *  清存档时不能把自己也清掉，否则"每日上限"会被一次重开顺手重置。
 * ========================================================== */
export const RESET = {
  /** 两次重开之间的最小间隔（墙钟秒）—— 防连点 / 防刷开局 */
  cooldownSec: 90,
  /** 每账号每个自然日最多重开几次 */
  maxPerDay: 3,
  /** 二次确认必须原样输入的词（不可逆动作的"物理刹车"） */
  confirmPhrase: '重开',
  /** 配额记录的 localStorage 键（与存档键分开，见上方注释） */
  storageKey: 'nightshift.reset.v1',
};

/* ---------- ② 活动限时任务 ---------- */
/**
 * 每隔 refreshSec（游戏秒）刷新一个随机任务；**最多同时存在 1 个**。
 * 进度口径统一为"累计值的增量"（见 quests.mjs 的 baseline 机制），
 * 这样"单日赚取 X 金币"这类任务不需要额外埋点，直接读 state.revenue 差分即可。
 */
export const QUESTS = {
  refreshSec: 300,
  /** 任务面板在左下角（HUD 的 anchor 是 CSS 位置，这里只给"是否显示") */
  panelCorner: 'bl',
  templates: [
    { id: 'serve',  metric: 'served',   label: '接待顾客', unit: '位', goals: [8, 12, 16],   reward: { cash: 120, tokens: 3 } },
    { id: 'repair', metric: 'repaired', label: '维修机器', unit: '台', goals: [2, 3, 4],     reward: { cash: 100, tokens: 2 } },
    { id: 'clean',  metric: 'cleaned',  label: '清理垃圾', unit: '堆', goals: [8, 12, 15],   reward: { cash: 90,  tokens: 2 } },
    { id: 'earn',   metric: 'earned',   label: '赚取金币', unit: '¥',  goals: [200, 320, 450], reward: { cash: 0, tokens: 4 } },
  ],
  /** 超时后自动失效并刷新新任务 */
  expireToast: '任务已过期',
};

/* ============================================================
 *  任务板（2026-10-06 块4）
 *
 *  ⚠ 与上面 QUESTS 的关系：两者**并存**，不是替换。
 *  QUESTS 是需求I 的"活动限时任务"：自动刷新、最多同时 1 个、不可接弃、
 *  超时自动失效 —— 它是"背景目标"，玩家不接也在跑。
 *  任务板是块4 的"正式任务板"：每晚刷 2~3 张卡、玩家**主动接单**、可弃（有冷却）、
 *  收益更高但要付出接单的动作 —— 它是"经营决策"。
 *  两者共存的理由：自动任务保证"玩家不会闲着没事干"，任务板给"要不要为了这单
 *  调整今晚的经营重点"的决策空间。把自动任务改成任务板会破坏需求I 的原意；
 *  把任务板做成自动的就没有"接单"这个动作了，也就谈不上"平衡任务收入占比"。
 *
 *  ── 平衡约束（需求：任务收入占总收入 20~30%）────────────────
 *  口径：单夜任务总奖励 ≈ 单夜主营收的 20~30%。
 *  按 ARRIVALS_PER_NIGHT=22 人、客单价 ¥5~15、成交率 ~80% 估算，
 *  单夜营收量级是 ¥150~260。因此：
 *    · 每晚刷 3 张卡，同时可接 1 张（acceptedMax）
 *    · 单张奖励 ¥12~15 + 代币 2（需求给的示例值就是这个量级）
 *    · 满接 3 张全做完 ≈ ¥40 ≈ 营收的 16~27% —— 落在区间内
 *  留 taskIncomeCapPct 字段做**自检用**（settlement 时算实际占比，
 *  超上限就在结算面板给提示，而不是让玩家自己发现"任务刷屏了"）。
 * ============================================================ */
/* ============================================================
 *  进货运输闭环（2026-10-06 块5）
 *
 *  把"进货"从「点一下秒到仓」改成「下单 → 在途 → 到货 → 搬运」，
 *  给"提前囤货"一个真实的决策窗口。
 *
 *  ── 三条边界（都不是随便定的）────────────────────────────
 *  ① **采购员保持即时到仓**：它是雇来干活的，如果采购也要等 45s，
 *     玩家会看到"我雇了人，结果他下单我还得盯着箱子" —— 那是把便利
 *     换成了监控。所以只有**玩家手动下单**才走运输闭环。
 *  ② **45 秒**是"够你干别的、但不至于忘了"的长度。夜长 480s（8 分钟），
 *     45s ≈ 9.4% 的夜长 —— 一次夜能往返 10 趟以上，同时单趟不占太久。
 *     刻意不加长：新手试两次就懂，加长只会让人忘在途、然后以为坏了。
 *  ③ **箱子里的货按 SKU 自动入 backroom**：玩家到货箱按 E 拾取后，
 *     手里拿的是"一箱"，再对准库存箱按 E 放进去即可 —— 不逐件拆，
 *     因为逐件拆是纯粹的重复劳动（8 格 × N 件），不是玩法。
 * ============================================================ */
export const DELIVERY = {
  /** 到货延迟（真实秒）。45s 的口径见上方② */
  transitSec: 45,
  /** 每单固定运费 */
  feeBase: 4,
  /** 每件运费 */
  feePerItem: 0.5,
  /** 货箱最多堆几个（多个在途单会合并到箱内，堆满了提示先搬走） */
  maxCrates: 2,
  /** 货箱停放位置（店门口，玩家走过去按 E 拾取）
   *  取门内侧靠右 —— 正对门口会被开门动画/顾客进出挡住，靠右不挡动线。 */
  crate: { x: 2.2, z: 4.2 },
  /** 拾取提示（HUD 顶部 toast） */
  arrivedToast: '📦 货物已到，请拾取',
  /** 在途标签文案（进货页） */
  transitLabel: '在途',
};

/* ==================================================================
 * 块6：垃圾与空箱处理系统（2026-10-06）
 *
 * 拆箱（块5 到货箱）+ 临期清仓都会产生「垃圾/空箱」，堆在收银台旁，
 * 最多叠 cap 件。≥tipThreshold 件：顾客心情变差 + 结账小费减半；
 * ≥warnThreshold 件：HUD 顶部常驻「垃圾堆积」警告（橙红，复用促销样式）。
 * 玩家对准垃圾桶按 E 一次清空全部，每件 +recyclePerItem 回收金；
 * 与口碑（块2）联动：清垃圾加分、堆叠扣分。
 * 全部数值集中此处，其它模块只引用。
 * ================================================================== */
export const GARBAGE = {
  /** 垃圾最多叠几件（堆满后不再增加，靠清理恢复） */
  cap: 10,
  /** 达到此件数：顾客心情变差 + 结账小费减半 */
  tipThreshold: 5,
  /** 达到此件数：HUD 顶部常驻「垃圾堆积」警告 */
  warnThreshold: 8,
  /** 每件回收金（对准垃圾桶按 E 一次清空，按件结算） */
  recyclePerItem: 1,
  /** 清一件垃圾加的口碑分（块2：reputation 0~100） */
  repPerClear: 0.3,
  /** 每堆一件垃圾（生成时即时）扣的口碑分，与清理加分对称 */
  repPenaltyPerItem: 0.2,
};

export const TASKBOARD = {
  /** 每晚刷几张卡 */
  offerPerNight: 3,
  /** 同时最多能接几张（做完才能接下一张） */
  acceptedMax: 1,
  /** 弃单冷却（游戏秒）：防止"接了刷完成度、不合适就丢"的无限重摇 */
  abandonCooldownSec: 40,
  /** 一张卡的默认有效期（游戏秒），超时自动作废 */
  offerValidSec: 300,
  /** 任务收入占总收入的目标区间（结算时自检并提示） */
  taskIncomeCapPct: [0.20, 0.30],

  /** 任务模板池（每晚从中不重复抽 offerPerNight 张）
   *  metric 沿用 quests.mjs 的"累计值差分"口径，零埋点（见该文件头注释）。
   *  ⚠ reward.cash 刻意压在 ¥12~15：按上面的平衡推算，满接 3 张 ≈ 营收 16~27%。
   *    这里若调到 ¥30+，三张全做完就等于白送半天营收，"任务喧宾夺主"。 */
  templates: [
    { id: 'deliver_bento', metric: 'servedBento', label: '给街角送便当', unit: '份', goals: [2],    reward: { cash: 15, tokens: 2 }, hint: '卖出便当即计入' },
    { id: 'promo_drink',  metric: 'soldDrinkPromo', label: '促销期卖饮料', unit: '件', goals: [5], reward: { cash: 12, tokens: 2 }, hint: '需在促销期间完成' },
    { id: 'clean_shelf',  metric: 'cleaned',   label: '清洁货架',     unit: '次', goals: [3],    reward: { cash: 8,  tokens: 1 }, hint: '对准货架按 E 清洁' },
    { id: 'serve_night',  metric: 'served',    label: '接待顾客',     unit: '位', goals: [6],    reward: { cash: 14, tokens: 2 }, hint: '结账即计入' },
    { id: 'stock_up',     metric: 'placed',    label: '补满货架',     unit: '件', goals: [8],    reward: { cash: 10, tokens: 1 }, hint: '从库存箱上架即计入' },
    { id: 'clear_exp',    metric: 'cleared',   label: '清掉临期货',   unit: '格', goals: [1],    reward: { cash: 12, tokens: 2 }, hint: '对准临期货格清仓' },
  ],
};

/* ---------- ⑥ 随机突发事件 ---------- */
/**
 * 与既有 EVENTS（RUSH/DRUNK/BLACKOUT/REGULAR）**互不干扰**：
 * 既有那套是"客流/顾客"维度的店内事件（已在 main 的 scheduleEvents 里排程），
 * 这里新增的是"设备与场地"维度的事件，走独立的 RANDOM_EVENTS 计时器。
 * 两者并存 —— 需求要求"原有全部保留"，所以不去改既有事件的表。
 */
export const RANDOM_EVENTS = {
  /** 首次触发的最早游戏秒（给玩家一点喘息） */
  firstDelaySec: 60,
  /** 之后每隔多少游戏秒判定一次 */
  intervalSec: 150,
  /** 每次判定真正触发的概率 */
  chance: 0.55,
  types: [
    {
      id: 'powerout', name: '停电', emoji: '⚡', weight: 30,
      durationSec: 45,
      /** 满意度额外下降（叠加在脏乱/故障之上，事件结束后自动恢复） */
      satisfactionPenalty: 0.18,
      desc: '全部设备暂停工作 · 等待自动恢复',
    },
    {
      id: 'meltdown', name: '机器大故障', emoji: '💥', weight: 35,
      /** 严重损坏：维修成本倍率（叠在等级倍率之上） */
      repairCostMul: 2.2,
      desc: '一台设备严重损坏 · 维修成本更高',
    },
    {
      id: 'surge', name: '客流高峰', emoji: '🎊', weight: 35,
      durationSec: 60,
      trafficMul: 1.8,
      /** 垃圾增速倍率 */
      litterMul: 2.2,
      desc: '大量顾客涌入 · 垃圾快速增多',
    },
  ],
};

/* ---------- ⑦ 店铺扩建 ---------- */
/**
 * bounds 只写"被改动的那条边"，最终边界由 ROOM 起算逐级叠加（见 layout.computeBounds）。
 * 两处 gate 是"打通外墙的门洞"：扩建前该段墙是实心的，扩建后从碰撞体与网格里一并移除。
 *
 * exp1 附赠 2 台游戏机（需求⑦"可额外摆放 2 台游戏机"）；
 * exp2 解锁独立售货专区 —— 新区域里放 3 台**可交互售货机**（kind='vending'），
 * 同时给需求⑤的老年顾客一个"只玩简单售货机"的落点。
 */
export const EXPANSIONS = [
  {
    id: 'exp1', name: '东翼电玩区', emoji: '🎮', cost: 900,
    desc: '打通东墙 · 新增一块区域 · 附赠 2 台游戏机',
    zone: { minX: 13.6, maxX: 21.6, minZ: 5.6, maxZ: 11.2 },
    bounds: { maxX: 22 },
    gate: { side: 'east', min: 6.6, max: 10.2 },
    lamps: [{ x: 15.4, z: 8.4 }, { x: 20.2, z: 8.4 }],
    facilities: [
      { id: 'pachinko3', kind: 'pachinko', name: '弹珠机', emoji: '🎰',
        x: 17.8, z: 7.0, rot: -Math.PI / 2, w: 1.0, d: 0.85 },
      { id: 'hoop2', kind: 'basketball', name: '投篮机', emoji: '🏀',
        x: 17.8, z: 9.6, rot: -Math.PI / 2, w: 1.2, d: 1.2 },
    ],
  },
  {
    id: 'exp2', name: '独立售货专区', emoji: '🥤', cost: 1600,
    desc: '北面新增售货专区 · 3 台可售货机 · 售货收益 +50%',
    zone: { minX: -9, maxX: 9, minZ: -19.6, maxZ: -11.6 },
    bounds: { minZ: -20 },
    gate: { side: 'north', min: -1.8, max: 1.8 },
    lamps: [{ x: -4.5, z: -13.4 }, { x: 4.5, z: -13.4 }],
    /** 售货机收益加成（作用于 vending 设施的一次性收货款） */
    vendingBonus: 0.5,
    facilities: [
      { id: 'vending1', kind: 'vending', name: '售货机', emoji: '🥤',
        x: -5.2, z: -14.4, rot: Math.PI, w: 1.15, d: 0.8 },
      { id: 'vending2', kind: 'vending', name: '售货机', emoji: '🍜',
        x: 5.2, z: -14.4, rot: Math.PI, w: 1.15, d: 0.8 },
      { id: 'vending3', kind: 'vending', name: '售货机', emoji: '🍱',
        x: 0, z: -18.4, rot: Math.PI, w: 1.15, d: 0.8 },
    ],
  },
];

export const EXPANSION_BY_ID = Object.fromEntries(EXPANSIONS.map((e) => [e.id, e]));

/* ---------- ⑤ 顾客细分类型 ---------- */
/**
 * 三类顾客在**偏好设施 / 耐心 / 脏乱敏感度 / 收益**四个维度上分化，
 * 让玩家能从"人群构成"读出经营状态（小孩多 = 抓娃娃机得修好，老人多 = 得打扫）。
 *
 * 外观差异由 character.mjs 消费（scale / 发色 / 驼背），这里只给数值与配色。
 */
export const CUSTOMER_TYPES = [
  {
    id: 'child', name: '儿童', emoji: '🧒', weight: 30,
    /** 偏好设施 kind（pickTarget 会优先从这些里挑） */
    prefer: ['claw', 'pachinko'],
    /** 耐心低：游玩时长短、受阻更快离场 */
    playSecMul: 0.7,
    idleSecMul: 0.7,
    /** 想去玩的基础意愿倍率（乘在 NPC.playChance 上） */
    playChanceMul: 1.15,
    /** 机器故障会快速掉满意度 → 受阻计数增长更快 */
    unhappyMul: 2.0,
    /** 满意度低时的离场阈值更宽松？不 —— 儿童更容易被劝退 */
    leaveSatThreshold: 0.6,
    /** 收益倍率（相对基础 playRevenue） */
    revenueMul: 0.7,
    /** 脏乱敏感度（1 = 标准） */
    dirtSensitive: 0.8,
    /** 外观：体型缩放与发色 */
    look: { scale: 0.72, hair: [0x2B2B33, 0x4A3728, 0xB4553F], cloth: [0xE05A8C, 0x5AA9E6, 0xF2C879] },
  },
  {
    id: 'youth', name: '青年', emoji: '🧑', weight: 45,
    prefer: ['pachinko', 'basketball'],
    playSecMul: 1.0,
    idleSecMul: 0.85,
    /** 愿意多次游玩 */
    playChanceMul: 1.35,
    unhappyMul: 0.6,
    leaveSatThreshold: 0.4,
    /** 消费高：愿意多次游玩 */
    revenueMul: 1.6,
    /** 满意度下降缓慢 */
    dirtSensitive: 0.6,
    look: { scale: 1.0, hair: [0x2B2B33, 0x6E4B8C, 0x2F6E8F], cloth: [0x3F5E8C, 0x8C4A5E, 0x4E7A5E] },
  },
  {
    id: 'elder', name: '老年', emoji: '🧓', weight: 25,
    /** 只玩简单售货机（vending）；没有可玩的售货机时只闲逛 */
    prefer: ['vending'],
    onlyPrefer: true,
    /** 停留久 */
    playSecMul: 1.6,
    idleSecMul: 1.8,
    playChanceMul: 0.9,
    unhappyMul: 1.0,
    /** 对脏乱场景非常敏感 */
    leaveSatThreshold: 0.72,
    dirtSensitive: 2.0,
    revenueMul: 1.0,
    look: { scale: 0.93, hair: [0xB8B8B8, 0xD8D2C4, 0x8C8C8C], cloth: [0x6B6B8C, 0x4A5A6B, 0x7A6A5A], stoop: true },
  },
];

export const CUSTOMER_TYPE_BY_ID = Object.fromEntries(CUSTOMER_TYPES.map((t) => [t.id, t]));
