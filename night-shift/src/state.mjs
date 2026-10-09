/**
 * 全局状态 —— 单一真源（ADR-002）
 * systems 读写它；scene(3D) 与 hud(DOM) 只读它并负责画出来。
 */
import {
  START_CASH, START_REPUTATION, SKUS, SLOT_COUNT,
  ARRIVALS_PER_NIGHT, NIGHT_WALL_SECONDS, DEMO_NIGHT_SECONDS, CLERK, CLAW_CABINET,
  WORD_OF_MOUTH,
} from './config.mjs';

export const NIGHT_SECONDS = DEMO_NIGHT_SECONDS ?? NIGHT_WALL_SECONDS;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function makeSlots(n) {
  return Array.from({ length: n }, () => ({
    skuId: null, qty: 0, placedAtNight: 0, expiryNight: 0,
  }));
}

function baseState() {
  return {
    /* 经济 */
    cash: START_CASH,
    /** 代币：顾客 NPC 游玩电玩设施留下的代币（存档项，见需求「存档内容」） */
    tokens: 0,
    backroom: Object.fromEntries(SKUS.map((s) => [s.id, 0])), // 库存箱：不计保质期（SYS-02 §2）
    slots: makeSlots(SLOT_COUNT),
    held: null,                                               // { skuId, qty } | null
    prices: Object.fromEntries(SKUS.map((s) => [s.id, s.price])),
    upgrades: {},                                             // { slot:true, fridge:true, ... }

    /* 时间 */
    night: 1,
    gameHour: 0,
    wallElapsed: 0,
    paused: true,
    phase: 'start',      // 'start' | 'running' | 'settle' | 'weekEnd'

    /* 顾客 */
    customers: [],
    queue: [],           // customerId 有序数组，[0] 为队首
    spawnedTonight: 0,
    arrivalsTarget: ARRIVALS_PER_NIGHT,

    /* 统计 */
    reputation: START_REPUTATION,
    /** 口碑档位（2026-10-06 块2）：由 startNight 按 reputation 填，HUD/结算面板读它。
     *  这里给个与 START_REPUTATION 匹配的初值（50 → 口碑平稳档），
     *  免得"开局第一帧读档旧档"时它是 undefined。 */
    wordOfMouth: WORD_OF_MOUTH.tiers[1],
    served: 0,
    lostSales: 0,
    revenue: 0,
    /* ---------- 任务板计数器（2026-10-06 块4）----------
     * 任务板的进度指标走"累计值差分"（见 taskboard.mjs 的口径说明），
     * 所以这些计数器只需在**当夜**累加，跨夜清零即可。
     * 为什么不复用 state.served：那是全夜总数没错，但"卖了几份便当"
     * "促销期卖了几件饮料"是它的**子集**，得单独记 ——
     * 用差分算不出子集（在总数上做差分只能得到"总数变化"）。 */
    servedBento: 0,        // 卖出的便当份数
    soldDrinkPromo: 0,     // 促销期间卖出的饮料件数
    placed: 0,             // 从库存箱上架的件数
    cleared: 0,            // 清仓卖出的格数
    /** 块6：当夜垃圾/空箱件数（拆箱 + 临期清仓产生，最多叠 GARBAGE.cap 件）；
     * 堆满后不再增加，靠对准垃圾桶按 E 清空。属于"某一夜里"的维护职责，跨夜清零。 */
    garbage: 0,
    taskboardIncome: 0,    // 本夜任务板现金收入（结算时算占比后清零）
    /* 进货运输（块5）：在途单跨夜保留（读档仍知道有货在路上），
     * 门口货箱与手持箱在 startNight 重置 —— 夜店里没人在门口等货。 */
    delivery: { transit: [], crates: [], held: null },
    /** 当夜小费累计（结算里单列"其中小费"；夜末清零） */
    tips: 0,
    earned: 0,           // 需求I ②：门店累计收入（贯穿小游戏/顾客/NPC/售货机，quests 的"赚金币"靠它做差分）
    purchaseCost: 0,
    loss: 0,

    /* 事件 */
    blackoutUntil: null, // wallElapsed 秒
    rushUntil: null,
    rushActive: false,

    /* R1 店员需求状态层（§1：4 状态 + 夜上限计数器） */
    clerk: { stamina: 100, fatigue: 0, satiety: 100, mental: 100 },
    mentalGainFromGames: 0,                 // 当夜小游戏回血累计（封顶 §3 nightCap）
    events: { drunk: null, regulars: [] },  // §4：醉汉 / 常客当夜状态

    /* 娱乐设施小游戏 */
    minigameId: null,      // 正在游玩的设施 id（非 null 时锁住走动，但**不暂停夜时钟** → 机会成本）
    minigamePlays: 0,      // 当晚游玩次数
    minigameSpend: 0,      // 当晚投币总额
    minigameEarn: 0,       // 当晚小游戏收益
    /* R4：按设施累计的游玩次数 —— **跨夜保留**，是小游戏关卡递进的依据。
     * 与 minigamePlays（当晚重置）不同，这个只在 resetGame() 时清零。 */
    facilityPlays: { pachinko1: 0, pachinko2: 0 },

    /* 需求I：玩法叠加（设备升级 / 改装 / 道具 / 任务 / 扩建 / 突发事件） */
    /** 设备等级：{ [facilityId]: 1..DEVICE_UPGRADE.maxLevel }；缺省视为 1 级 */
    deviceLevels: {},
    /** 设备改装：{ [facilityId]: [modId, ...] }；一台最多 MODULE_MAX_PER_DEVICE 种 */
    deviceMods: {},
    /** 背包：{ [consumableId]: 数量 } */
    inventory: {},
    /** 背包里当前选中的道具 id（选中后按 E 使用） */
    selectedItem: null,
    /** 当前限时任务（最多同时存在 1 个；超时由 quests.mjs 作废） */
    quest: null,
    /** 已解锁的店铺扩建：{ exp1: true, exp2: true } */
    expansions: {},
    /** 停电事件到期（wallElapsed 秒）· 期间全部设备暂停工作 */
    powerOutUntil: null,
    /** 客流高峰到期 */
    surgeUntil: null,
    /** 人气海报到期 */
    posterUntil: null,
    /** 售货机收款冷却：{ [facilityId]: 可再次收款的 wallElapsed } */
    vendingCooldown: {},

    /* 需求J：店员花名册 + 仓库 + 设备库存 */
    /** 雇佣的店员数组（见 staff.mjs）：{ id, type, stamina, resting, working, status, ... } */
    staff: [],
    /** 仓库：{ level: 扩容等级, goods: { snack, toy, bait, parts } }。snack 映射到 backroom 总件数 */
    warehouse: { level: 0, goods: { snack: 0, toy: 0, bait: 0, parts: 0 } },
    /** 设备当前库存（上货员补、游玩消耗）：售货机 / 娃娃机 */
    deviceStock: { vending: 0, claw: 0 },

    /* ---------- 成长线扩展（星级 / 主题 / 成就 / 定价 / 抉择 / 环境） ----------
     * 这些字段**只加不改**：既有系统的字段与语义一个都没动，
     * 新增模块读写自己的字段，关掉它们时游戏回到原来的样子。 */

    /** 店铺星级（1–5）；连续 3 夜双达标 +1（见 stars.mjs） */
    star: 1,
    /** 当前连续达标夜数 */
    starStreak: 0,

    /** 今夜主题 id / 明夜主题 id（提前摇好，情报服务才能预知）/ 情报生效夜 */
    themeId: null,
    themeNextId: null,
    intelNight: null,

    /** 成就：{ [id]: true } */
    achievements: {},
    /** 成就进度容器（跨夜保留，见 achievements.mjs） */
    achProgress: {},

    /** 单品调价系数 { [skuId]: 0.8..1.2 }（写入 prices 的是它 × 建议价） */
    priceMul: {},
    /** 全店限时促销到期（wallElapsed 秒；null = 未开启） */
    promoUntil: null,

    /* ── 代币出口（boons.mjs） ──────────────────────────────
     * boons     永久增益计数 { tipUp, fatigueLess, staffSlot, startCash }，一次性、跨夜、读档保留
     * buffCards 限时券 [{ kind, expireNight }]，同夜同类不叠加，打烊按 expireNight 清理
     * intel     主题情报 { next: 0|1（当晚是否已查看）, lockedId: null|id（锁定明晚主题） }
     * ⚠ 永久与限时必须分字段：打烊清理只动 buffCards，碰 boons 就是不可逆的翻车。 */
    boons: { tipUp: 0, fatigueLess: 0, staffSlot: 0, startCash: 0 },
    buffCards: [],
    intel: { next: 0, lockedId: null },

    /** 抉择事件：今夜排期 [{ id, at, done }] 与历史 [{ id, option, night }] */
    choiceQueue: [],
    choiceLog: [],
    /** 网红 buff：到第几夜（含）为止 / 客流倍率 */
    influenceUntilNight: 0,
    influenceMul: 1,
    /** 满意度延时回退计时（报警驱赶 / 撸猫的"短暂提升"） */
    repRestore: [],
    /** 跨夜后果（如"次日被认出"）：[{ night, rep }] */
    pendingNextNight: [],
    /** 临期货（供应商抉择）：{ skuId, qty, cost }；打烊时未售完报废 */
    expiringTonight: null,

    /** 环境互动（猫 / 跑腿 / 电视），见 ambient.mjs */
    ambient: null,
    /** 环境满意度回退计时 */
    ambientRestore: [],

    /** 点唱机当前曲风 id（纯氛围，切换店内 BGM） */
    jukeboxStyle: null,

    /** 玩家疲劳度 0..100（疲劳系统，见 fatigue.mjs）。
     *  刻意与 state.clerk.fatigue 分开 —— 店员不困、玩家困，两者恢复手段也不同。 */
    playerFatigue: 0,

    /* ---------- 前台手机（按 O 打开，见 phone.mjs） ----------
     * 全部纯数据、无 mesh 引用，可安全 JSON 化（进 save.mjs 白名单）。
     * 点评 / 消息箱 / 差评累积是**跨夜**的口碑历史，刻意不清；
     * 跑腿单 / 当夜接单数 / 补救任务是"某一夜里"的东西，夜末清零。 */
    /** 点评列表（最新在后，最多 PHONE.reviewsMax 条） */
    reviews: [],
    /** 消息箱（最新在后，最多 PHONE.inboxMax 条） */
    inbox: [],
    /** 当前跑腿单：{ id, kindId, label, emoji, desc, reward, total, left, state } | null */
    errand: null,
    /** 当夜已完成的跑腿单数（限制每夜接单量） */
    errandsDoneTonight: 0,
    /** 当前差评补救任务：{ id, metric, goal, baseline, progress, reward } | null */
    remedy: null,
    /** 累计未补救差评数（跨夜累积，触发补救任务的依据） */
    badReviewStreak: 0,

    /* ---------- 监控室 / 二手市场 / 常客（模块 4，见 monitor/secondhand/regulars.mjs） ----------
     * 全部只加不改：既有的顾客/设备/经济字段一个没动。
     * thief 是**每夜临时事件**（不进存档白名单，夜末/读档自动清空）；
     * secondHand / regularFaces 是跨夜资产与口碑历史，进白名单持久化。 */

    /** 当前在场小偷（每夜最多一只，null = 无）：{ zone, left, total, caught } */
    thief: null,
    /** 监控室小偷排程（每夜开局摇定出现时刻的 gameHour 列表）：[hour, ...] */
    thiefQueue: [],

    /** 二手市场：{ listings:[每夜挂牌], owned:[已购资产] }；owned 跨夜保留 */
    secondHand: { listings: [], owned: [] },

    /** 常客脸谱：{ [faceId]: { nights:[夜号数组去重], name, emoji } }，跨夜保留 */
    regularFaces: {},

    /** 结算账本：事件类收支条目（见 ledger.mjs），打烊时列在结算里 */
    ledger: [],

    /* UI / 运行时 */
    pointerLockBlocked: false, // 环境不允许指针锁定（iframe/沙箱）→ 退化自由视角
    hover: null,         // { type, prompt, ok, reason, ref }
    busyUntil: null,     // 动作锁定到期（wallElapsed 秒）
    busyLabel: '',
    lastReport: null,
    weekPassed: null,
  };
}

export const state = baseState();

/* ---------- 极薄订阅（ADR-002） ---------- */
const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function notify() {
  for (const fn of listeners) fn(state);
}

/* ---------- 生命周期 ---------- */
export function resetForNewNight() {
  state.gameHour = 0;
  state.wallElapsed = 0;
  state.customers = [];
  state.queue = [];
  state.spawnedTonight = 0;
  state.served = 0;
  state.lostSales = 0;
  state.revenue = 0;
  state.tips = 0;
  /* 任务板计数器（块4）：当夜口径，跨夜清零。
   * ⚠ taskboardIncome 也在此清零，但它是**结算先算占比再清**的 ——
   *   顺序是 endNight → settleNight（结算面板读它算占比）→ nextNight（清零）。
   *   在这里清零等于把结算要用的数提前抹了，所以 taskboardIncome 改由
   *   taskboard.settleNight() 负责清（main 在结算后调）。 */
  state.servedBento = 0;
  /* 进货运输（块5）：门口的箱子与手上的箱子过夜作废，但**在途单保留** ——
   * 玩家下单后存档退出、再进来时，那单还在路上（arriveAt 已过的话 update 会
   * 立刻把它转成门口箱子）。若连在途也清掉，玩家会白扣一次运费。 */
  if (state.delivery) { state.delivery.crates = []; state.delivery.held = null; }
  state.soldDrinkPromo = 0;
  state.placed = 0;
  state.cleared = 0;
  state.garbage = 0;       // 块6：当夜垃圾件数（跨夜清零，与 cleared 同口径）
  state.purchaseCost = 0;
  state.loss = 0;
  state.blackoutUntil = null;
  state.rushUntil = null;
  state.rushActive = false;
  // R1 店员状态夜末重置（§1.2 / §1.5）：疲惫清零、体力回补 +40、心理按盈亏 ±、饱食不自动回
  const netProfit = state.lastReport?.netProfit ?? 0;
  state.clerk.fatigue = 0;
  state.clerk.stamina = clamp(state.clerk.stamina + CLERK.nightReset.staminaAdd, 0, 100);
  state.clerk.mental = clamp(
    state.clerk.mental + (netProfit >= 0 ? CLERK.nightReset.mentalGain : -CLERK.nightReset.mentalLossOnDeficit),
    0, 100,
  );
  state.mentalGainFromGames = 0;
  state.events = { drunk: null, regulars: [] };
  state.held = null;
  state.hover = null;
  state.busyUntil = null;
  /* 需求I：限时状态跨夜一律清零 —— 它们是"某一夜里"的事件，
   * 留到下一夜会让玩家在新的一夜开局就背着上一夜的停电/高峰。
   * 设备等级 / 配件 / 背包 / 扩建属于**永久投资**，刻意不清（见下方 minigame* 同理）。 */
  state.quest = null;
  state.powerOutUntil = null;
  state.surgeUntil = null;
  state.posterUntil = null;
  state.vendingCooldown = {};
  state.selectedItem = null;
  // 需求J：设备库存每夜重置 —— 售货机从空开始（当夜靠上货员补），
  // 娃娃机则**开局就是满柜**：玻璃柜是店铺门面，空柜子是不可接受的观感
  // （P0-4）。柜内娃娃被玩家抓走后靠上货员从仓库补；抓到 0 时柜子见底并挂补货提示。
  state.deviceStock = { vending: 0, claw: CLAW_CABINET.maxDolls };
  // 店员花名册 / 仓库货品 / 扩容等级跨夜保留：它们是永久投资，不像限时事件那样清零。
  // 仅重置店员每夜的瞬时工作/休息/动作冷却状态（保留雇佣关系与体力）。
  for (const s of state.staff) {
    s.resting = false;
    s.working = false;
    s.cooldownUntil = 0;
    s.errandUntil = 0;
    s.targetId = null;
  }
  state.minigameId = null;
  state.minigamePlays = 0;
  state.minigameSpend = 0;
  state.minigameEarn = 0;
  state.phase = 'running';
  state.paused = false;
  /* 玩家疲劳：白天补觉回一部分（不是清零 —— 通宵累积的困倦会跨夜延续，
   * 否则"疲劳"就成了"每夜独立的小数值"，玩家永远不用做"扛 vs 提神"的取舍）。
   * 回血量见 config.FATIGUE 的 washRecover 同源，这里用固定小幅恢复。 */
  state.playerFatigue = Math.max(0, state.playerFatigue - 25);
  /* 手机系统：跑腿单 / 当夜接单数 / 补救任务是"某一夜里"的东西，夜末清零；
   * reviews / inbox / badReviewStreak 是跨夜口碑历史，刻意保留（见 state.mjs 字段注释）。 */
  state.errand = null;
  state.errandsDoneTonight = 0;
  state.remedy = null;
  /* 监控室：小偷是每夜临时事件，夜末/读档都要清干净，否则残留 thief 会卡住抓捕判定 */
  state.thief = null;
  state.thiefQueue = [];
  /* 二手市场：每夜挂牌重新生成（owned 跨夜保留，这里只清挂牌） */
  if (state.secondHand && Array.isArray(state.secondHand.listings)) state.secondHand.listings = [];
  /* 成长线扩展的**当夜**状态清零。
   * 原则与需求I 的限时事件一致：属于"某一夜里"的东西不留到下一夜。
   * star / starStreak / achievements / achProgress / priceMul / themeNextId /
   * influenceUntilNight 属于永久投资或已定死的未来，刻意保留。 */
  state.ledger = [];
  state.choiceQueue = [];
  state.promoUntil = null;
  state.expiringTonight = null;
  state.repRestore = [];
  state.ambient = null;
  state.ambientRestore = [];
  /* 口碑影响客流（2026-10-06 块2 升级为「线性项 × 档位项」两层）
   *
   * 旧口径只有连续线性项：1 + (rep-50)/100 × 0.3，钳在 [0.85, 1.15]，
   * 跨度只有 ±15% 且**没有可感知的台阶** —— 玩家从 62 掉到 58 客流几乎不变，
   * "口碑"就成了一个看不见摸不着的数字。
   *
   * 现在叠一层**档位乘数**（WORD_OF_MOUTH.tiers：<60 ×0.8 / 60~89 ×1.0 / ≥90 ×1.3），
   * 让"跌破 60 会真的掉客流、冲上 90 会真的涨"变成可感知的因果。
   * 线性项保留（它连续、且已被既有平衡标定过），两层相乘。
   *
   * 为什么不 import regulars.wordOfMouth()：state 是单一真源的**最底层**，
   * 让它依赖扩展层（常客/口碑模块）会把依赖方向搞反。
   * 档位表放在 config（纯数据、state 本来就 import 它），
   * regulars.wordOfMouth() 只是同一张表的另一个读法，两边不会漂。 */
  const repMul = 1 + ((state.reputation - 50) / 100) * 0.3;
  const wom = (WORD_OF_MOUTH.tiers.find((t) => state.reputation >= t.min)) ?? WORD_OF_MOUTH.tiers[WORD_OF_MOUTH.tiers.length - 1];
  state.wordOfMouth = wom;              // 供 HUD / 结算面板显示当前档位
  state.arrivalsTarget = Math.round(ARRIVALS_PER_NIGHT * Math.min(1.15, Math.max(0.85, repMul)) * wom.mul);
}

export function resetGame() {
  Object.assign(state, baseState());
  state.arrivalsTarget = ARRIVALS_PER_NIGHT;
}

/** 打烊收尾：促销拉客时间窗随打烊结束（防跨夜残留拉客）。
 * endNight 与 resetForNewNight 都确保 promoUntil 归零，双保险。 */
export function clearPromoOnClose(state) {
  if (state.promoUntil !== null) state.promoUntil = null;
}

/** 扩容货架（升级「加货架格」） */
export function expandSlots(by = 4) {
  for (let i = 0; i < by; i++) {
    state.slots.push({ skuId: null, qty: 0, placedAtNight: 0, expiryNight: 0 });
  }
}
