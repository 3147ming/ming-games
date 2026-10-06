/**
 * 美术规范令牌表（需求E）—— LowPoly 电玩城风格的**单一真源**
 *
 * 为什么单独一个文件：
 *   1) 贴图（textures.mjs）、场景灯光（scene.mjs）、UI（tokens.css / hud.mjs）
 *      三个地方都要用同一套颜色与规格。以前各写各的字面量，
 *      改一次配色要翻三处、还容易漏 —— 现在只改这里。
 *   2) 规范要被测试断言（tests/art.test.mjs），
 *      所以必须是**可导入的纯数据**，不能藏在绘制函数里。
 *   3) 与 config.mjs 的分工：config 管"玩法数值"，art 管"长什么样"。
 *      两者都只放常量，不含逻辑。
 *
 * 规范要点（来自需求E 的原文要求，逐条对应下方常量）：
 *   · LowPoly 低多边形、简约卡通      → STYLE.lowPoly / STYLE.flatShading
 *   · 夜晚室内霓虹                    → STYLE.nightNeon + PALETTE 的霓虹族
 *   · PBR Albedo 贴图 2048×2048       → TEX.spec 与 TEX.assets[].size
 *   · 无白底、无缝平铺                → TEX.noWhiteBase / seamless 检查
 *   · 深色底 + 霓虹紫/冰蓝/暖黄        → PALETTE.base 与 PALETTE.neon
 *   · UI 半透磨砂玻璃圆角弹窗          → UI 段
 */

/* ==================== 风格总纲 ==================== */
export const STYLE = {
  /** LowPoly：几何面数低、表面硬边，靠色块而非贴图细节撑画面 */
  lowPoly: true,
  /** 硬边着色 —— 低多边形风格的关键：不做法线平滑，让每个三角面都可读 */
  flatShading: true,
  /** 夜晚室内霓虹主题 */
  nightNeon: true,
  /** 简约卡通：色块少、对比强、不要写实脏污细节 */
  cartoon: true,
  /** 允许的最大主色数量（约束配色不失控；UI 与场景合计） */
  maxAccentColors: 3,
};

/* ==================== 调色板 ==================== */

/**
 * 深色底（场景大面积表面的基色）。
 * 这三档是"底色阶梯"，越靠后越暗 —— 用来拉开墙面/地面/天花板的层次，
 * 保证无论贴图怎么画，画面整体都压在深色域里（需求E 的"无白底"从源头保证）。
 */
export const BASE_COLORS = {
  /** 最深，用于地面、机柜侧背板 */
  deep: '#10151F',
  /** 中深，用于墙面、货架体 */
  mid: '#1A2230',
  /** 稍亮，用于面板与需要"浮起"的表面；仍属深色域，不是白 */
  raise: '#232C3D',
  /** 天花板：夜晚室内顶面，比墙面更暗，避免抢视觉焦点 */
  ceiling: '#141A26',
};

/**
 * 霓虹三主色（需求E 明确指定）。
 * 这三个是**唯一允许的强调色**，STYLE.maxAccentColors = 3 与之对应。
 */
export const NEON = {
  /** 霓虹紫 —— 电玩区主色，需求E 点名的 #B15BD8 */
  purple: '#B15BD8',
  /** 冰蓝 —— 冷光/水面/屏幕反光 */
  ice: '#4FD1E8',
  /** 暖黄 —— 灯箱/招牌/筒灯，沿用既有品牌色 #E8A94E 保持一致性 */
  warm: '#E8A94E',
};

/** 霓虹的暗态（用于渐变外侧、边框内描边，避免纯色平涂太"贴纸"） */
export const NEON_DIM = {
  purple: '#6B2E8C',
  ice: '#2A7C93',
  warm: '#9A6A1F',
};

/** 语义色（保持与既有 UI 一致，别动，否则排行榜/金额色会漂） */
export const SEMANTIC = {
  money: '#6FCF97',
  danger: '#EB5757',
  info: '#5AA9E6',
  /** 文字：深底上的主/次/弱三档 —— 全部为浅色，符合"深色底"规范 */
  textHi: '#ECF1F8',
  textMid: '#A8B4C6',
  textLo: '#6C7889',
};

/** Three.js 数值形式的霓虹色（scene.mjs 的灯光直接引用，避免各处手写 0x…） */
export const NEON_HEX = {
  purple: 0xB15BD8,
  ice: 0x4FD1E8,
  warm: 0xE8A94E,
};

/* ==================== 贴图规格 ==================== */

/**
 * 需求F 点名的 7 类资产。
 * kind 对应 textures.mjs 的 RECIPES key，两处必须同步（有测试断言）。
 *
 * size 分级说明：
 *   需求E 要 2048×2048。但 11 张贴图全部 2048² 会让启动时的
 *   Canvas 绘制 + Sobel 法线计算开销暴涨（尤其 heightToNormal 是逐像素的 419 万次循环/张）。
 *   因此按**视觉重要性分级**：
 *     hero   = 2048 —— 玩家会凑近细看的正面资产（售货机/弹珠机面板/抓娃娃机）
 *     large  = 2048 —— 大面积平铺表面（墙面/地面），虽然远处但占屏比最高
 *     mid    = 1024 —— 中距离道具（货架、机柜）
 *     small  = 512  —— 远景/低关注度（后巷、天花板、天空）
 *   hero 与 large 满足需求E 的 2048 硬指标，其余降级换取启动速度。
 */
export const TEX = {
  /** 需求E 硬指标 */
  spec: 2048,
  /** 一律从深色底起笔（无白底规范） */
  noWhiteBase: true,
  /** 一律无缝平铺 */
  seamless: true,
  /** 逐像素亮度上限：任何贴图都不该出现纯白（255） */
  maxLuma: 240,
  levels: { hero: 2048, large: 2048, mid: 1024, small: 512 },
};

/**
 * 7 类资产的权威清单（需求F）。
 * @kind   RECIPES 的 key
 * @name   中文名（UI / 报告用）
 * @level  尺寸分级
 * @usage  贴在什么地方（scene.mjs 的对应物）
 */
export const TEX_ASSETS = [
  { kind: 'vending',   name: '饮料售货机表面', level: 'hero',  usage: 'PROPS.vendings 的正面板' },
  { kind: 'claw',      name: '抓娃娃机外壳',   level: 'hero',  usage: 'facility claw 的柜体' },
  { kind: 'pachinko',  name: '弹珠机面板',     level: 'hero',  usage: 'facility pachinko1/2 的立面板' },
  { kind: 'shelf',     name: '货架商品柜',     level: 'mid',   usage: 'STORE 内 2×4 货架' },
  { kind: 'floorTile', name: '地面瓷砖',       level: 'large', usage: '室内地面 + 广场铺装' },
  { kind: 'wallTile',  name: '墙面瓷砖',       level: 'large', usage: '室内外墙 / 收银台背板' },
  { kind: 'uiHint',    name: 'UI 悬浮提示框',  level: 'mid',   usage: '交互提示框的磨砂玻璃底' },
];

/** 补充资产（非需求F 点名，但场景需要，沿用规格） */
export const TEX_EXTRA = [
  { kind: 'arcade',  name: '街机柜体',   level: 'mid',   usage: 'PROPS.arcades' },
  { kind: 'metal',   name: '拉丝金属',   level: 'mid',   usage: '机柜边框 / 货架框' },
  { kind: 'wood',    name: '木纹',       level: 'mid',   usage: '收银台 / 桌椅' },
  { kind: 'asphalt', name: '沥青',       level: 'small', usage: '后巷地面' },
  { kind: 'ceiling', name: '天花板',     level: 'small', usage: '室内顶面' },
  { kind: 'screen',  name: '屏幕画面',   level: 'small', usage: '街机屏幕（发光）' },
  { kind: 'sky',     name: '夜空',       level: 'small', usage: '天空球' },
  { kind: 'water',      name: '水面',     level: 'small', usage: '钓鱼池塘水面（波纹）' },
  { kind: 'goodsCrate', name: '货箱',     level: 'mid',   usage: '库存箱 / 后巷货箱 / 仓库存货堆' },
  { kind: 'exitSign',   name: '安全出口', level: 'small', usage: '店内安全出口指示牌' },
  { kind: 'decal',      name: '地面导视', level: 'small', usage: '广场地面霓虹导视箭头' },
];

/* ==================== 灯光规范 ==================== */

/**
 * 灯光参数（需求G 第②条）。
 * 与 scene.mjs 的现有 8 盏点光对应，这里只列"规范"，具体坐标仍在 scene.mjs（属于布局）。
 * 记录于此是为了让"街机每台一盏紫/蓝微光 + 顶部暖黄筒灯"成为**可断言**的规范，
 * 而不是散落在建模代码里的魔法数字。
 */
export const LIGHTING = {
  /** 环境光：冷蓝灰，压低整体亮度营造夜晚 */
  ambient: { color: 0x2A3446, intensity: 1.0 },
  /** 半球光：天空冷蓝 / 地面灰，给低多边形面提供柔和的方向感 */
  hemi: { sky: 0x9FB6D8, ground: 0x2A2F3A, intensity: 0.55 },
  /** 每台街机的独立霓虹微光 */
  arcadeNeon: { colors: [NEON_HEX.purple, NEON_HEX.ice], intensity: 2.2, distance: 7.5 },
  /** 顶部筒灯（暖黄） */
  downlight: { color: NEON_HEX.warm, intensity: 2.6, distance: 9 },
  /** 雾：让远处霓虹化开，强化夜晚氛围 */
  fog: { color: 0x141A24, near: 16, far: 46 },
  /** 背景色 = 雾色，保证天空球与雾衔接不上时也不穿帮 */
  background: 0x141A24,
  /** Bloom 后处理（需求G 第②条） */
  bloom: {
    enabled: true,
    /** 亮度阈值：只有超过它的像素才被提取做泛光，避免整体糊掉 */
    threshold: 0.72,
    /** 泛光强度 */
    strength: 0.55,
    /** 模糊半径（按 1/2、1/4 降采样层数表达） */
    radius: 1.0,
    /**
     * 降采样层级。vendor 里没有 three 官方 examples/jsm，
     * 所以 Bloom 由 src/postfx.mjs 自行实现（阈值提取 + 多级降采样 + 叠加）。
     */
    mips: 3,
  },
};

/* ==================== UI 规范（半透磨砂玻璃圆角弹窗） ==================== */

/**
 * 需求E 的 UI 规范：半透磨砂玻璃 + 圆角。
 * 与 styles/tokens.css 的 --glass-* 一一对应（CSS 侧的数值由 tokens.css 持有，
 * 这里是"应该取什么值"的规范说明 + 给 JS 侧动态挂载 HUD 用）。
 */
export const UI = {
  /** 玻璃底色（带 alpha 的深色） */
  glassBg: 'rgba(35,42,56,.62)',
  /** 更强一点的玻璃（用于最上层面板，保证文字可读） */
  glassBgStrong: 'rgba(28,34,47,.78)',
  /** 边框：极细的高光描边，玻璃感的关键 */
  glassBorder: '1px solid rgba(180,200,230,.16)',
  /** backdrop-filter —— 磨砂 */
  glassBlur: 'blur(16px) saturate(1.3)',
  /** 圆角 */
  radius: 18,
  radiusSm: 12,
  /** 阴影：深色环境里用大范围低透明度，避免黑边发死 */
  shadow: '0 18px 48px rgba(0,0,0,.45)',
  /** 霓虹描边光晕（弹窗聚焦时的强调） */
  glowPurple: '0 0 0 1px rgba(177,91,216,.35), 0 0 28px rgba(177,91,216,.22)',
  glowWarm: '0 0 0 1px rgba(232,169,78,.35), 0 0 28px rgba(232,169,78,.20)',
};

/* ==================== 昼夜轮换规范（需求G 第⑥条） ==================== */

/**
 * 白天/夜晚两套光照与客流参数。
 * 夜晚 = 客流大、收入高、霓虹全开；白天 = 稀少、收入低、灯光变亮变冷。
 * 由 src/daynight.mjs 插值，scene.mjs 消费。
 */
export const DAYNIGHT = {
  /** 一夜墙钟时长之后的循环：夜晚 → 白天 → 夜晚 */
  cycleSec: 240,
  phases: {
    night: {
      label: '夜晚', emoji: '🌙',
      /* 观感 1：深夜暗部原来接近纯死黑，货架只剩一片剪影。
       * 提高半球环境光（0.55 → 0.92）让暗部能看清轮廓，
       * 霓虹强度（2.2）远高于环境光，主光源仍是霓虹 —— 氛围不变。 */
      ambientIntensity: 1.15,
      hemiIntensity: 0.92,
      neonIntensity: 2.2,
      downlightIntensity: 2.6,
      background: 0x141A24,
      fogNear: 16, fogFar: 46,
      /** 客流权重：夜晚是主力时段 */
      traffic: 1.0,
      /** 收入倍率 */
      income: 1.35,
    },
    day: {
      label: '白天', emoji: '☀️',
      ambientIntensity: 2.6,
      hemiIntensity: 1.5,
      neonIntensity: 0.5,   // 霓虹白天几乎不显
      downlightIntensity: 0.6,
      background: 0x3D4A5C,
      fogNear: 34, fogFar: 90, // 白天视野更通透
      traffic: 0.32,
      income: 0.75,
    },
  },
};

/* ==================== 设备故障 / 清洁 / NPC（需求G 第③④⑤条） ==================== */

/**
 * 设备故障（需求G 第④条）：随机故障 → 屏幕闪烁 → 停止收益 → 花钱维修。
 */
export const BREAKDOWN = {
  /** 每台设备每夜期望故障次数 */
  failurePerNight: 0.8,
  /** 故障后最低持续时长（秒），期间不产出收益 */
  minDownSec: 25,
  maxDownSec: 60,
  /** 维修费 = 设备基础成本 × 该系数（向上取整到元） */
  repairCostMul: 1.8,
  /** 闪烁表现：屏幕 emissive 强度的抖动频率（Hz）与幅度 */
  flickerHz: 7,
  flickerDepth: 0.75,
  /** 过夜未修是否累积（true 则跨夜保留故障状态，制造经营压力） */
  persistAcrossNight: false,
};

/**
 * 环境清洁（需求G 第⑤条）：随时间刷新垃圾 → 地面变脏 → 清理提升满意度。
 */
export const CLEANLINESS = {
  /** 起始洁净度（1 = 全新） */
  start: 1.0,
  /**
   * 每秒自然下降速度（脏乱积累）。
   * 标定依据：一夜 480s，若全程不清理，应当在**夜末**才跌破 lowThreshold（0.55）
   * 并明显削减客流 —— 而不是开局两分钟就脏透。
   *   仅自然衰减：480 × 0.0008 = 0.384 → 夜末剩 0.616（略高于阈值，尚可接受）
   *   叠加客流损耗后才会真正跌破 → 玩家需要在中段打扫一次
   * 这样"打扫"是一个**有节奏的决策**，而不是被逼着一直扫。
   */
  decayPerSec: 0.0008,
  /** 每个顾客离开后额外下降 */
  decayPerCustomer: 0.006,
  /** 垃圾生成：每多少秒尝试刷新一件（1 = 每秒 1 次尝试） */
  litterIntervalSec: 12,
  /** 每次尝试生成的概率（乘上脏乱程度 → 越脏越容易再脏） */
  litterChance: 0.35,
  /** 场上垃圾上限（超出不再刷新，避免无限增长） */
  maxLitter: 12,
  /** 清理一件垃圾恢复的洁净度 */
  cleanPerLitter: 0.06,
  /** 洁净度对满意度的权重（满意度 = 基础 - 脏乱惩罚） */
  satisfactionWeight: 0.55,
  /** 洁净度低于该值时开始明显削减客流 */
  lowThreshold: 0.55,
  /** 客流惩罚上限（洁净度 0 时客流乘以此系数） */
  minTrafficMul: 0.55,
  /** 垃圾散落半径：围绕广场/室内随机（米） */
  scatterRadius: 1.6,
};

/**
 * 顾客 NPC（需求G 第③条）：自动漫游 → 随机游玩 → 游玩产生代币收益 → 避开故障设备。
 */
export const NPC = {
  /** 同时在场上限 */
  maxAlive: 14,
  /** 生成间隔（秒） */
  spawnIntervalSec: 5.5,
  /** 每秒行走速度（米/秒） */
  speed: 1.7,
  /** 一次漫游停留多久后决定下一个行为 */
  idleSec: [2.5, 6.0],
  /** 决定去玩小游戏的概率（其余去货架/闲逛） */
  playChance: 0.42,
  /** 单次游玩时长（秒） */
  playSec: [4, 11],
  /** 游玩每次给店主带来的代币收益（元）—— 是"顾客自己花钱玩"，不是店主支出 */
  playRevenue: [1, 4],
  /** 满意度低时离场概率（每次决策点） */
  leaveChanceLowSat: 0.5,
  /** 绕开故障设备：检测半径（米），进入该范围就改道 */
  avoidRadius: 2.2,
  /** 顾客身高范围（米），供 character.mjs 生成不同体型 */
  height: [1.62, 1.84],
};

/* ==================== 汇总导出（便于测试一次性断言规范完整性） ==================== */

export const ART_SPEC = {
  style: STYLE,
  base: BASE_COLORS,
  neon: NEON,
  semantic: SEMANTIC,
  tex: TEX,
  assets: TEX_ASSETS,
  extras: TEX_EXTRA,
  lighting: LIGHTING,
  ui: UI,
  daynight: DAYNIGHT,
  breakdown: BREAKDOWN,
  cleanliness: CLEANLINESS,
  npc: NPC,
};
