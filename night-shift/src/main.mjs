/**
 * 装配 + 主循环（ADR-003：dt 驱动、可暂停、与帧率解耦）
 */
import {
  GAME_HOURS, UPGRADES, CLERK, EVENTS, LEADERBOARD, MINIGAME, RANDOM_EVENTS,
  CONSUMABLE_BY_ID, WAREHOUSE, SKU_BY_ID, STAFF, FATIGUE, QTE, PHONE, SLOT_CAP,
} from './config.mjs';
import { state, NIGHT_SECONDS, notify, resetForNewNight, resetGame } from './state.mjs';
import { createWorld } from './scene.mjs';
import { createPlayer } from './player.mjs';
import { createCustomers, currentSegment } from './customers.mjs';
import { createInteraction } from './interaction.mjs';
import { createMobileControls } from './mobile-controls.mjs';
import { openMinigame, closeMinigame, isMinigameOpen } from './minigames.mjs';
/* QTE：玩家亲手做维修/清洁/上货时的 5 秒迷你挑战（成功更快更便宜），见 qte.mjs */
import { openQte, isQteOpen } from './qte.mjs';
import { updateClerk, mentalFromResult, applyGameMental, resolveDrunkOutcome, applyActionCost } from './clerk.mjs';
import { FACILITY_BY_ID, registerFacilities } from './facilities.mjs';
import {
  mountHud, renderHud, toast, saveToast, openStart, openLogin, openPurchase, openSettle, openWeekEnd,
  openLeaderboard, openInventory, showIncident, isModalOpen,
  openSettings, showTutorial, hideTutorial, flashQuestDone,
  openAchievements, openChoice, showThemeBanner, showPromoBanner, setSatBonus, openPhone, openMonitor,
  closeModal,
} from './hud.mjs';
import { createAuthService, createNetBridge } from './account.mjs';
import { submitLocal, readBoard, scoreOf, clearForAccount } from './leaderboard.mjs';
/* 账号重开（重置）：本账号进度清回初始状态，见 reset.mjs 的四个"为什么" */
import { createResetService } from './reset.mjs';
/* 需求I 玩法叠加：七个新模块的纯逻辑层（规则都在各自模块里，main 只做装配与回调接线） */
import { createProgression } from './progression.mjs';
import { createQuests } from './quests.mjs';
/* 任务板（2026-10-06 块4）：与 quests 并存，见 taskboard.mjs 的定位说明 */
import { createTaskboard } from './taskboard.mjs';
/* 进货运输闭环（2026-10-06 块5）：下单→在途→到货→搬运 */
import { createDelivery } from './delivery.mjs';
import { createIncidents } from './incidents.mjs';
import { createInventory } from './items.mjs';
import { computeBounds, applyLayout } from './layout.mjs';
import {
  settleNight, purchase, buyUpgrade, nextNight, canAfford, payCash, earnCash,
  buyWarehouseGood, upgradeWarehouse, warehouseCap, warehouseUsed, warehouseFree,
  restockShelfIfPossible, backroomTotal, place, sellable,
  setCheckoutHook, setCheckoutDoneHook, setSettleExtras,
} from './economy.mjs';
/* 成长线扩展：六个纯逻辑模块（各自只读写自己的 state 字段） */
import { createLedger } from './ledger.mjs';
import { createThemes, INTEL_COST } from './themes.mjs';
import { createStars, unlocksAt, unlocksUpTo } from './stars.mjs';
import { createAchievements } from './achievements.mjs';
import { createChoices } from './choices.mjs';
import { createPricing } from './pricing.mjs';
import { createAmbient } from './ambient.mjs';
/* 需求G 环境系统 + 需求H 存档（本文件只做装配，规则都在各自模块里） */
import { createWorldState } from './worldstate.mjs';
import { createNpcs } from './npcs.mjs';
import { createDayNight } from './daynight.mjs';
import { createBloom, createPassThrough } from './postfx.mjs';
import { createSaveManager, AUTOSAVE_SEC, saveKeyFor } from './save.mjs';
import { createCharacter } from './character.mjs';
import { ZONES, STORE, POND, POS, TASKBOARD, DELIVERY, GARBAGE } from './config.mjs';
import { NPC, DAYNIGHT } from './art.mjs';
/* 需求J：店员系统（采购员 / 上货员 + 维修员 / 保洁员）+ 仓库面板 API */
import { createStaff } from './staff.mjs';
/* 手感优化：程序化合成音效（零外部资源，见 sfx.mjs） */
import sfx from './sfx.mjs';
/* 玩家设置（Esc → ⚙ 设置）：音量 / 亮度伽马暗角 / 灵敏度 / FOV，落 localStorage */
import { settings, loadSettings, onSettingsChange, setSettings, SETTINGS_KEY } from './settings.mjs';
/* 疲劳系统：玩家通宵困倦（独立于店员 clerk.fatigue），见 fatigue.mjs */
import { createFatigue } from './fatigue.mjs';
/* 前台手机：点评 APP / 跑腿接单 / 消息箱（按 O 打开），见 phone.mjs */
import { createPhone } from './phone.mjs';
/* 模块 4：监控室 + 二手市场 + 常客 + 节日限定夜（纯逻辑层，见对应 .mjs） */
import { createMonitor } from './monitor.mjs';
import { createSecondHand } from './secondhand.mjs';
import { createRegulars } from './regulars.mjs';
import { isFestival, THEME_BY_ID } from './themes.mjs';
import { fmtYuan, fmtYuanSigned, safeText } from './fmt.mjs';
import {
  BOON_SHOP, GACHA_COST, ensureBoons, buyBoon, shopSnapshot, pullGacha, gachaTable,
  buffMul, tipMul, pruneBuffCards, startCashBonus, staffSlotBonus, BUFF_KINDS, INTEL_VIEW_COST, INTEL_LOCK_COST,
} from './boons.mjs';

const canvas = document.getElementById('scene-canvas');
const hudRoot = document.getElementById('hud-root');

/* ---------- 鼠标锁定不可用时的一次性操作提示（P1-4） ----------
 * 原先是常驻顶部的黄色警告条 + 反复弹出的提示 —— 那是开发者调试信息
 * （"预览面板为嵌入式框架"），正式版不该让玩家看到。
 * 现在改为：锁定失败时在**左下角**只提示一次操作方式，数秒后自动淡出，
 * 不再重复打扰；独立窗口（能锁定）时不会有任何提示。 */
const lockHintOnce = document.createElement('div');
lockHintOnce.style.cssText = `position:fixed;left:16px;bottom:16px;z-index:40;display:none;
  padding:9px 14px;border-radius:12px;max-width:min(360px,72vw);
  background:var(--glass-bg-strong,rgba(28,34,47,.78));border:var(--glass-border,1px solid #3A4457);
  backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
  color:#E6E2D6;font:500 13px/1.55 system-ui,"Segoe UI",sans-serif;pointer-events:none;
  opacity:0;transition:opacity .3s ease;`;
lockHintOnce.innerHTML = '🖱 <b>按住鼠标左键拖动</b>环视 · <b>WASD</b> 移动 · <b>E</b> 交互';
document.body.appendChild(lockHintOnce);
let lockHintShown = false;
function showLockHintOnce() {
  if (lockHintShown) return;
  lockHintShown = true;
  lockHintOnce.style.display = 'block';
  requestAnimationFrame(() => { lockHintOnce.style.opacity = '1'; });
  setTimeout(() => { lockHintOnce.style.opacity = '0'; }, 9000);
  setTimeout(() => { lockHintOnce.style.display = 'none'; }, 9600);
}

const world = createWorld(canvas);

/* 需求M4（模块 4）：监控室 / 二手市场 / 常客 —— 纯逻辑，只接 state，
 * 表现副作用（字幕/音效）统一收口在下面的 onEvent，逻辑层保持可单测、且关掉即退回原样。 */
const monitor = createMonitor({
  state,
  onEvent: (type, p) => {
    if (type === 'thief-appear') toast(`🚨 监控发现小偷！分区：${p.zoneName}`, 'bad', 3200);
    else if (type === 'thief-caught') toast(`🚓 当场抓获小偷！见义勇为 ${fmtYuanSigned(p.reward)}`, 'ok', 2600);
    // 这里是 Bug⑤ 的现场之一：`p.amount` 是浮点，未格式化时显示 ¥52.40799999999866。
    // 注意用 fmtYuan(+amount) 而不是 -amount ——「损失」二字已经表达方向，
    // 再带负号会变成"损失 -¥70"这种双重否定的别扭文案。
    else if (type === 'thief-stole') toast(`💸 小偷得手，损失 ${fmtYuan(p.amount)}`, 'bad', 3000);
  },
});
const secondhand = createSecondHand({
  state,
  onEvent: (type, p) => {
    if (type === 'secondhand-buy') toast(`♻ 购入二手 ${p.name}${p.faulty ? '（故障机，需维修）' : ''}`, 'info', 2400);
    else if (type === 'secondhand-repair') toast(`🔧 二手 ${p.name} 已修复`, 'ok', 2200);
    else if (type === 'secondhand-recycle') toast(`💰 回收二手 ${safeText(p.name, '设备')} · 退款 ${fmtYuan(p.refund)}`, 'ok', 2200);
    else if (type === 'secondhand-income') toast(`🪙 二手设备过夜收益 +${p.total} 代币`, 'ok', 2600);
  },
});
const regulars = createRegulars({
  state,
  onEvent: (type, p) => {
    if (type === 'regular-promote') toast(`⭐ 熟客达成：${p.emoji} ${p.name} 成为常客！`, 'ok', 3200);
  },
});

const customers = createCustomers(world.scene, {
  regularJudge: (faceId) => regulars.judge(faceId),
});

/* ==================================================================
 * 需求G 环境系统装配（NPC / 故障维修 / 清洁 / 昼夜 / Bloom）
 *
 * 这些模块此前只完成了逻辑层，没有接进主循环 —— 于是"故障/垃圾/昼夜"
 * 在游戏里是不可见的，存档也就无内容可存。这里统一接线，
 * step() 里只保留一行调用，主循环不被子系统细节淹没。
 * ================================================================== */

const facName = (id) => FACILITY_BY_ID[id]?.name ?? id;

const worldState = createWorldState({
  seed: 20260919,
  onEvent: (type, p) => {
    if (type === 'breakdown') {
      sfx.alarm();   // 需求：机器故障 = 警报"嘀嘀"两声
      toast(`⚠ ${facName(p.id)} 故障了！停摆 ${Math.ceil(p.downFor)}s`, 'bad', 3200);
    } else if (type === 'repair') {
      // 维修成功的"短促确认音"与"火花一闪"（需求：修好机器时对应位置爆一小撮粒子）。
      // 统一收口在这里：玩家亲手修、用快速维修包、店员代修三条路径都会触发它。
      sfx.done('repair');
      const f = FACILITY_BY_ID[p.id];
      if (f) world.burst(f.x, f.z, 'spark');
      toast(`🔧 ${facName(p.id)} 已修复 · ${fmtYuan(-p.cost)}`, 'ok', 2600);
    } else if (type === 'clean') {
      sfx.done('clean');
      // 批量清理（清洁喷雾 / 打扫一次）没有单件坐标 → 在玩家脚下爆一把纸屑
      const x = p.all ? playerX() : (p.x ?? playerX());
      const z = p.all ? playerZ() : (p.z ?? playerZ());
      world.burst(x, z, 'paper');
      toast('🧹 清理完成 · 洁净度回升', 'ok', 1800);
    }
  },
});
worldState.setNightSeconds(NIGHT_SECONDS);

/** 垃圾散落点：只在顾客会走到的三个区域随机（后巷不该有客人垃圾） */
const LITTER_ZONES = [ZONES.plaza, ZONES.arcade, ZONES.rest];
function scatterLitter(r) {
  const z = LITTER_ZONES[Math.floor(r() * LITTER_ZONES.length)];
  return {
    x: z.minX + r() * (z.maxX - z.minX),
    z: z.minZ + r() * (z.maxZ - z.minZ),
  };
}

/* ==================================================================
 * 成长线扩展：主题 / 星级 / 成就 / 抉择 / 定价 / 环境互动
 *
 * 装配原则与需求I 那批模块完全一致（ADR-002）：
 * 模块只读写 state、不碰 DOM/THREE；所有表现副作用（横幅 / 场景解锁 / 提示 / 音效）
 * 都在下面的回调里收口。因此关掉任何一个模块，游戏都会退回扩展前的样子。
 *
 * 放在 npcs 之前创建的原因：npcs 需要读"顾客类型权重"与"强制偏好"，
 * 这两个都来自当前夜间主题。
 * ================================================================== */

/** 结算账本：事件类收支（主题加成扣减 / 抉择后果 / 促销 / 临期 / 外快） */
const ledger = createLedger(state);

const themes = createThemes({
  state,
  onChange: (t) => {
    showThemeBanner(t);
    toast(`${t.emoji} 今夜主题：${t.name}`, 'info', 3600);
    achievements.note('theme', { themeId: t.id });
    // 主题把垃圾/故障率交给 worldState（与 incidents 的调制值分开存，互不覆盖）
    const e = themes.effects();
    worldState.setThemeModifiers({ litterMul: e.litterMul, breakMul: e.breakMul });
  },
});

const stars = createStars({
  state,
  onUnlock: (u) => {
    // 升星落地：建机器 + 点亮后巷 + 摆装修 + 纳入故障/升级体系
    const facs = world.applyStarUnlock(u) ?? [];
    registerFacilities(facs);
    const ids = facs.map((f) => f.id);
    if (ids.length) worldState.registerDevices(ids);
    toast(`⭐ ${u.star} 星解锁：${u.name}（${u.desc}）`, 'ok', 4200);
    syncDevices();
  },
});

const achievements = createAchievements({
  state,
  onUnlock: (a) => {
    sfx.record();
    toast(`🏆 成就达成：${a.emoji} ${a.name} · +${a.tokens} 代币`, 'ok', 3800);
  },
});

const choices = createChoices({
  state,
  api: {
    /* 注意：这里**不**记账 —— 每个抉择选项自己会用 api.ledger 记它那一行，
     * 再记一笔通用"抉择收入"会让结算里出现两条重复的钱。 */
    earnCash: (n) => { earnCash(n); notify(); },
    payCash: (n) => {
      if (!canAfford(n)) return { ok: false, reason: '现金不足' };
      payCash(n);
      return { ok: true };
    },
    addRep: (n) => { state.reputation = Math.max(0, Math.min(100, state.reputation + n)); notify(); },
    addLitter: (n) => { for (let i = 0; i < n; i++) worldState.spawnLitter?.(); },
    toast: (msg) => toast(msg, 'info', 4200),
    ledger: (key, label, value, kind) => ledger.add(key, label, value, kind),
    skuCost: (id) => SKU_BY_ID[id]?.cost ?? 0,
    addBackroom: (id, qty) => { state.backroom[id] = (state.backroom[id] ?? 0) + qty; notify(); },
    removeBackroom: (id, qty) => {
      state.backroom[id] = Math.max(0, (state.backroom[id] ?? 0) - qty);
      notify();
    },
    markExpiringTonight: (skuId, qty, cost) => { state.expiringTonight = { skuId, qty, cost }; },
    scheduleRepRestore: (amount, at) => {
      if (!Array.isArray(state.repRestore)) state.repRestore = [];
      state.repRestore.push({ amount, at });
    },
    scheduleNextNight: (p) => {
      if (!Array.isArray(state.pendingNextNight)) state.pendingNextNight = [];
      state.pendingNextNight.push({ night: state.night + 1, ...p });
    },
    setInfluence: (nights, mul) => {
      state.influenceUntilNight = state.night + nights;
      state.influenceMul = mul;
    },
  },
});

const pricing = createPricing({
  state,
  api: {
    payCash: (n, why) => {
      if (!canAfford(n)) return { ok: false, reason: '现金不足' };
      payCash(n);
      return { ok: true, why };
    },
    ledger: (key, label, value, kind) => ledger.add(key, label, value, kind),
    spawnWave: (n) => { for (let i = 0; i < n; i++) customers.spawn(); },
    toast: (msg) => toast(msg, 'info'),
  },
});

const ambient = createAmbient({
  state,
  api: {
    addRep: (n) => { state.reputation = Math.max(0, Math.min(100, state.reputation + n)); notify(); },
    earnCash: (n) => { earnCash(n); },
    ledger: (key, label, value, kind) => ledger.add(key, label, value, kind),
    toast: (msg) => toast(msg, 'info'),
    setActor: (kind, opts) => world.setActor?.(kind, opts),
  },
});

/* 疲劳系统：玩家通宵困倦。表现事件（跨档/打哈欠/打瞌睡）在这里翻译成字幕与音效，
 * 疲劳本身只由 fatigue.mjs 驱动 —— 玩家灵敏度/准星/暗角是**表现层**，走 effects() 派生值。 */
const fatigue = createFatigue({ state });

/* 前台手机：点评 / 跑腿 / 消息箱。差评、跑腿到账、补救任务触发/完成在此翻译成字幕；
 * 'review'（好/中评）与 'errand-accept' 不弹字幕 —— 太频繁会刷屏，只在手机里看。 */
const phone = createPhone({
  state,
  onEvent: (type, p) => {
    if (type === 'review-bad') toast('😡 收到一条差评 · 按 O 看手机', 'bad', 2400);
    else if (type === 'errand-done') toast(`🛵 跑腿到账 ${fmtYuanSigned(p.reward)}`, 'ok', 2600);
    else if (type === 'remedy-new') toast('📱 差评累积，触发补救任务（按 O 查看）', 'bad', 3400);
    else if (type === 'remedy-done') toast(`💚 补救完成 · 口碑 +${p.rep} · ${fmtYuanSigned(p.cash)}`, 'ok', 3200);
  },
});

/** 进货页（块5）需要的运输接口。抽成具名函数是为了让 openPurchase 的调用保持单行。 */
const deliveryUiApi = {
  order: (skuId, qty) => delivery.order(skuId, qty, state.wallElapsed),
  panel: () => delivery.panel(),
};

/** openPhone 的只读/操作接口（HUD 不 import phone/config，只消费这个对象） */
const phoneApi = {
  reviews: () => phone.reviews(),
  inbox: () => phone.inbox(),
  errand: () => phone.errand(),
  remedy: () => phone.remedy(),
  acceptErrand: () => phone.acceptErrand(),
  markAllRead: () => phone.markAllRead(),
  unread: () => phone.unread(),
  errandsDone: () => phone.errandsDone(),
  errandMax: PHONE.errandMaxPerNight,

  /* 💛 常客忠诚度（2026-10-06 块2）—— 手机第 5 个分页的数据源。
   * 从 regulars 取（HUD 不 import regulars，只消费这个对象，沿用既有约定）。 */
  loyal: () => regulars.snapshot().loyal,
  wordOfMouth: () => regulars.wordOfMouthOf(),

  /* 📌 任务板（2026-10-06 块4）—— 手机第 6 个分页。
   * 接/弃都走 taskboard 自己的方法（HUD 不碰 state.taskboard）。 */
  task: () => taskboard.panel(),
  taskAccept: (uid) => taskboard.accept(uid, {
    served: state.served,
    servedBento: state.servedBento,
    soldDrinkPromo: state.soldDrinkPromo,
    promoActive: pricing.promoActive(),
    cleaned: worldState.stats.cleaned,
    placed: state.placed,
    cleared: state.cleared,
  }),
  taskAbandon: () => taskboard.abandon(),

  /* 📡 主题情报（代币）—— 与上面"现金情报服务"是两条独立出口：
   * 现金那条只告知；代币这条花代币、可锁定明晚。两者互不影响。 */
  intel: () => {
    ensureBoons(state);
    const s = themes.snapshot();
    const lockedId = state.intel.lockedId ?? null;
    return {
      tokens: state.tokens,
      viewed: !!state.intel.next,
      next: state.intel.next ? nextThemeInfo() : null,
      lockedId,
      lockedName: lockedId ? (themes.lockCandidates().find((t) => t.id === lockedId)?.name ?? lockedId) : null,
      candidates: themes.lockCandidates().map((t) => ({ id: t.id, name: t.name, emoji: t.emoji, desc: t.desc })),
      viewCost: INTEL_VIEW_COST,
      lockCost: INTEL_LOCK_COST,
      // 既有现金情报的花费，一并显示方便玩家对比
      cashIntelCost: s.intelCost,
    };
  },
  intelView: () => boonsApi().viewNext(),
  intelLock: (id) => boonsApi().lockNext(id),
};

/** 二手市场 Tab 的只读/操作接口（HUD 只消费这个对象，不直接 import 模块） */
const secondhandApi = {
  snapshot: () => secondhand.snapshot(),
  buy: (id) => secondhand.buy(id),
  repairOwned: (id) => secondhand.repairOwned(id),
  recycle: (id) => secondhand.recycle(id),
};

/**
 * 明晚主题的可读信息（名称 + 效果描述）。
 * 主题 id 存在 state.themeNextId（开新一夜时已定死）—— 付费情报只是把 id 翻译成人话。
 */
function nextThemeInfo() {
  const t = THEME_BY_ID[state.themeNextId];
  if (!t) return null;
  return { id: t.id, name: t.name, emoji: t.emoji, desc: t.desc };
}

/** 主题 × 网红 buff × 限时券：合成后的客流倍率（customers 用它定 arrivalsTarget） */
function themeArrivalMul() {
  return (themes.effects().arrivalMul ?? 1)
    * (choices.arrivalMul?.() ?? 1)
    * buffMul(state, 'arrivals');   // 限时券「一晚客流 +15%」（同夜同类不叠加，取最高）
}

/* --- 注入到核心循环的两个扩展点（economy 不认识这些模块，见 economy 注释） --- */
setCheckoutHook((skuId, customer) => {
  const adj = pricing.checkoutAdjust(skuId);
  const e = themes.effects();
  /* 2026-10-06 块2：常客忠诚度折扣 —— **只对他偏好的那一个 SKU** 生效。
   * 刻意不做全店折扣：促销 C 方案（60/10/2.2）的回本线是标定过的，
   * 叠一个全店 0.85 系数会直接把促销拉成亏本买卖。
   * 折扣取 max(既有倍率, 忠诚度折扣) 而不是相乘 —— 两者都属"打折"，
   * 相乘等于打骨折（0.9 促销 × 0.85 忠诚 = 0.765，促销就白做了）。 */
  let loyalMul = 1;
  const faceId = customer?.faceId;
  if (faceId) {
    const lv = regulars.loyaltyOf(faceId);
    // 只有"当前买的正好是他偏好的东西"才给折 —— 否则忠诚度就成了全店通用券
    if (lv && lv.prefer === skuId) loyalMul = lv.discount;
  }
  const priceMul = adj.mul * (e.priceMul ?? 1) * buffMul(state, 'price');
  return {
    // 限时券「一晚全店售价 +10%」乘在这里（永久增益不作用于售价，售价由 pricing 管）
    mul: Math.max(priceMul, loyalMul),
    repDelta: adj.repDelta,
    // 小费倍率 = 主题小费 × 永久「小费 +5%/级」× 限时券「一晚小费 +10%」
    tipMul: (e.tipMul ?? 1) * tipMul(state),
  };
});

/* 结账成功旁路：常客复购记忠诚度（2026-10-06 块2）。
 * 挂在 economy 的注入点上而不是 interaction 层 —— 那里才有完整的 faceId + 最终收款，
 * 且 staff/自动流程未来若也走结账，能一并拿到（不必在每个调用点各写一遍）。 */
setCheckoutDoneHook((info) => {
  if (!info) return;
  /* 2026-10-06 块3：收银飞钱/入账音。
   * 放在 faceId 判断**之前** —— 音效跟常客没关系，每一笔成交都该有；
   * 之前那个 `if (!info.faceId) return` 会把绝大多数随机顾客的成交音一起吞掉。 */
  sfx.coin();
  /* 收银飞钱（块3）：从顾客站位抛到收银台。钱数越多枚数越多（1~3 封顶，
   * 免得大额结算时一堆金币在手机端掉帧）。顾客站位用 mesh 的世界坐标 ——
   * 拿不到就退化为"从收银台前方飞"（坐标仍合理，不会有动画穿墙）。 */
  {
    const c = info.customer;
    const fx = c?.mesh?.position?.x;
    const fz = c?.mesh?.position?.z;
    const n = Math.max(1, Math.min(3, Math.ceil((info.amount || 0) / 20)));
    world.flyCoins?.(
      Number.isFinite(fx) ? fx : POS.counter.x - 0.8,
      Number.isFinite(fz) ? fz : POS.counter.z - 0.6,
      POS.counter.x, POS.counter.z, n,
    );
  }
  /* 块6：店内垃圾堆积 → 顾客皱眉离店（复用 upset 音效 + 表情）。
   * 只影响"本次结账的顾客"的离店情绪，不动全局满意度；与 economy.checkout 里的小费减半配套。 */
  if (state.garbage >= GARBAGE.tipThreshold) {
    sfx.upset();
    if (info.customer) info.customer.mood = 'upset';
  }

  /* 任务板指标（块4）：卖出的便当份数 / 促销期卖出的饮料件数。
   * 放在 checkoutDoneHook 是因为这里已经有完整的 skuId + qty，
   * 而"卖出便当"这种子集计数没法从总数做差分得到（见 state 字段注释）。 */
  if (info.skuId === 'bento') state.servedBento += info.qty || 0;
  if (info.skuId === 'drink' && pricing.promoActive()) state.soldDrinkPromo += info.qty || 0;

  /* 售罄音：顾客买走的是该 SKU 在货架上的最后一件。
   * 判定用 sellable()（只算未过期的在架货），不是单格 qty —— 同一个 SKU 可能在两格都有货，
   * 只清了一格不算售罄，要让玩家听到"这个品彻底卖空了"才有意义。 */
  if (sellable(info.skuId) === 0) {
    sfx.soldOut();
    const sku = SKU_BY_ID[info.skuId];
    toast(`${sku?.emoji ?? ''}${sku?.name ?? '该商品'} 售罄 · 记得补货`, 'info', 2000);
  }
  if (!info.faceId) return;
  const r = regulars.recordPurchase(info.faceId, info.skuId);
  if (r.leveled) {
    const lv = regulars.loyaltyOf(info.faceId);
    // 1 级是 1.00（无折扣），别显示成"100折"这种怪话
    const disc = r.discount >= 1 ? '无折扣' : `${Math.round(r.discount * 100)}折`;
    toast(`${lv?.name ?? '常客'} 忠诚度提升 → ${r.label}（偏好商品${disc}）`, 'ok', 2200);
  }
});

/* 结算扩展段：economy 只负责把它们并进 report，内容全在这里算。
 * 注：星级那段由 endNight 在 settleNight 之后单独写（它要读 report 才能判定）。 */
setSettleExtras(() => {
  const th = themes.current();
  return {
    theme: { id: th.id, name: th.name, emoji: th.emoji, desc: th.desc },
    tips: Math.round(state.tips ?? 0),
    litter: worldState.litter?.length ?? 0,
    incidents: incidentCount,
    ledger: ledger.entries(),
    /* 2026-10-06 块2：口碑档位 + 忠诚度榜单（打烊结算面板可视化）。
     * 口碑值本身 report.reputation 早就有（economy 写的），这里补的是
     * "这个分对应什么档、明天客流会怎么变"—— 玩家需要看到因果而不只是数字。 */
    wom: regulars.wordOfMouthOf(),
    loyalty: regulars.snapshot().loyal,
  };
});

/** Tab 商店的"定价与情报"分页 API */
function growthApi() {
  /* HUD 的 priceContent() 走 growthApi.snapshot() 拿面板数据。
   * 早期这里是 `return { ...pricing.snapshot(), sheet, … }` —— pricing.snapshot() 本身
   * 只是个普通对象字面量，展开后**不存在 snapshot 这个键**，于是点开「🏷 定价」分页
   * 立刻 TypeError: growthApi.snapshot is not a function，页面停在上一页内容上（tab 看起来"点了没反应"）。
   * 现在把快照抽成 build()，既作为返回值展开，也挂成 snapshot() 供 HUD 调用。 */
  const build = () => {
    const snap = pricing.snapshot();
    const fc = themes.forecast();
    return {
      ...snap,
      sheet: pricing.sheet(),
      intelCost: INTEL_COST,
      intelKnown: !!fc,
      intelTheme: fc ? `${fc.emoji} ${fc.name}` : null,
    };
  };
  return {
    ...build(),
    snapshot: build,
    adjust: (skuId, dir) => {
      const r = pricing.adjust(skuId, dir);
      return { ...r, name: SKU_BY_ID[skuId]?.name ?? skuId, pct: Math.round((r.mul - 1) * 100) };
    },
    resetPrice: (skuId) => {
      const r = pricing.reset(skuId);
      return { ...r, name: SKU_BY_ID[skuId]?.name ?? skuId, pct: 0 };
    },
    startPromo: () => {
      const r = pricing.startPromo();
      if (r?.ok) {
        toast('🏷 全店 9 折 · 限时促销开始', 'ok', 3000);
        showPromoBanner(true, r.durationSec);
        sfx.promoStart();          // 2026-10-06 块3：促销开启提示音
      }
      return r;
    },
    buyIntel: () => {
      const r = themes.buyIntel((cost) => {
        if (!canAfford(cost)) return { ok: false, reason: '现金不足' };
        payCash(cost);
        ledger.set('theme.intel', '情报服务', -cost, 'theme');
        return { ok: true };
      });
      return r;
    },
  };
}

const npcs = createNpcs(world.scene, worldState, {
  createCharacter: (opt) => createCharacter(opt),
  seed: 7331,
  /* 夜间主题对人群构成的影响（缺省 = 不变） */
  typeWeightOf: (id) => themes.typeWeightMul(id),
  preferKindsOf: () => themes.preferKinds(),
  // 顾客自己花钱玩设施 → 店主进账（需求③"游玩产生代币收益"）
  onRevenue: (amount) => {
    earnCash(amount);
    state.tokens += 1;
    notify();
  },
  /* 需求I ⑤：可玩设施 = 全部基础设施（售货机不算"可玩"的小游戏，它走 E 直接收款）。
   * 扩建解锁的新游戏机要并入；倍率由 progression 注入（等级/改装），缺省 1 行为不变。 */
  playable: () => progression.activeFacilities().filter((f) => f.kind !== 'vending'),
  attractMul: (id) => progression.attractMul(id),
  revenueMul: (id) => progression.revenueMul(id),
  playSecMul: (id) => progression.playSecMul(id),
});

/* ==================================================================
 * 需求I 玩法叠加：四个纯逻辑实例的创建与回调接线
 *
 * 分层原则（ADR-002）：这些模块只读写 state / worldState，不碰 DOM 与 THREE。
 * 表现副作用（场景扩建 / 设备灯带 / 提示）由 onEvent 在这里统一收口，
 * 这样逻辑层保持可单测，且"原有玩法不退化"的保证不被打破。
 * ================================================================== */
const progression = createProgression({
  state,
  // 升级硬约束：故障中不可升级（需求①）。progression 只查、不修。
  isBroken: (id) => worldState.isBroken(id),
  /* 星级解锁的机器并入设备表 → 自动继承升级 / 改装 / 故障 / 上货 / 店员五套体系 */
  extraFacilities: () => stars
    ? stars.unlockedFacilityIds().map((id) => FACILITY_BY_ID[id]).filter(Boolean)
    : [],
  onEvent: (type, p) => {
    if (type === 'expansion') {
      // 解锁→场景显隐 + 新设施注册 + 故障系统纳入 + 碰撞体/活动范围扩大（都在同一帧完成）
      const facs = world.applyExpansion(p.id) ?? [];
      registerFacilities(facs);
      const ids = facs.map((f) => f.id);
      if (ids.length) worldState.registerDevices(ids);
      const owned = Object.keys(state.expansions).filter((k) => state.expansions[k]);
      applyLayout(world.colliders, { owned });
      player.setBounds(computeBounds(owned));
      toast(`🏗 ${p.def?.name ?? '扩建'} 已解锁 · 场景已扩大`, 'ok', 3600);
    } else if (type === 'upgrade' || type === 'mod-install' || type === 'mod-remove') {
      // 升级/改装改的是柜体灯带等外观，即时刷新
      syncDevices();
    }
  },
});

const quests = createQuests({
  state,
  onEvent: (type) => {
    if (type === 'quest-new') toast('📋 新限时任务已发布', 'info', 2200);
    else if (type === 'quest-done') {
      flashQuestDone();    // 需求：完成时追踪器绿闪一下 + 打勾
      sfx.done('clean');
      toast('✅ 限时任务完成 · 奖励已发放', 'ok', 2800);
    }
  },
});

/* 任务板（块4）：每晚刷 3 张卡 → 玩家主动接单 → 完成入账 */
const taskboard = createTaskboard({
  state,
  onEvent: (type, p) => {
    if (type === 'tb-new') toast(`📌 任务板已更新 · ${p.offers.length} 张新单`, 'info', 2400);
    else if (type === 'tb-accept') toast(`已接单：${p.task.label}`, 'ok', 2000);
    else if (type === 'tb-done') {
      flashQuestDone();          // 复用既有"任务完成"绿闪反馈
      sfx.done('clean');
      toast(`✅ 任务完成「${p.task.label}」+${fmtYuan(p.cash)} +${p.tokens}代币`, 'ok', 3000);
    } else if (type === 'tb-abandon') toast(`已弃单 · ${TASKBOARD.abandonCooldownSec}s 内不能再接/弃`, 'info', 2000);
    else if (type === 'tb-expire') toast('任务已过期', 'info', 1800);
  },
});

/* 进货运输闭环（块5）：玩家手动下单走这里；采购员仍走 economy.purchase（即时到仓）。 */
const delivery = createDelivery({
  state,
  warehouseCap: () => warehouseCap(),
  onEvent: (type, p) => {
    if (type === 'order') {
      // 金额一律走 fmtYuan（Bug⑤ 守卫：模板串里直接插金额会漏出浮点尾数，如 4.500000000000001）
      toast(`📦 已下单 ${SKU_BY_ID[p.skuId]?.name ?? ''}×${p.qty} · 运费 ${fmtYuan(p.quote.fee)} · ${DELIVERY.transitSec}s 后到货`, 'ok', 2600);
    } else if (type === 'arrived') {
      toast(`${DELIVERY.arrivedToast}（${SKU_BY_ID[p.skuId]?.name ?? ''}×${p.qty}）`, 'ok', 3000);
      sfx.giftArrived();      // 与节日礼盒同一个"到货"音，语义一致
    } else if (type === 'rejected') {
      toast(`⚠ ${p.reason}`, 'bad', 2600);
    } else if (type === 'pickup') {
      toast(`已拾取货箱 · 共 ${Object.values(p.items).reduce((s, n) => s + n, 0)} 件`, 'ok', 2000);
    } else if (type === 'putaway') {
      if (p.totalLeft > 0) toast(`入仓 ${p.totalPut} 件 · 仓库满，剩 ${p.totalLeft} 件仍在手上`, 'bad', 3000);
      else toast(`入仓完成 · ${p.totalPut} 件`, 'ok', 2000);
    }
  },
});

const incidents = createIncidents({
  state,
  worldState,
  onEvent: (type, p) => {
    if (type === 'incident') {
      incidentCount += 1;   // 打烊结算里"突发事件 ×N 次"这一行
      showIncident({ emoji: p.emoji, name: p.name, desc: p.desc }, 4200);
      if (p.id === 'powerout') toast('⚡ 停电！设备暂停工作 · 满意度下降', 'bad', 3400);
      else if (p.id === 'surge') toast('🎊 客流高峰！垃圾快速堆积', 'info', 3400);
      else if (p.id === 'meltdown') toast(`💥 设备大故障 · ${FACILITY_BY_ID[p.deviceId]?.name ?? '设备'} 严重损坏`, 'bad', 3800);
    }
  },
});

const inventory = createInventory({ state });

/* ==================================================================
 * 需求J：店员系统（采购员 / 上货员 + 维修员 / 保洁员）
 *
 * 店员是独立于「玩家本人」(state.clerk) 的雇佣制 NPC：花 hireCost 雇、每 salarySec 扣薪资、
 * 现金不足全员停工、可随时解雇。所有 AI 规则在 staff.mjs 里，main 只做装配 + 收口 toast。
 * ================================================================== */
const staffEconomy = {
  purchase, buyWarehouseGood, restockShelfIfPossible,
  backroomTotal, warehouseFree, warehouseCap, warehouseUsed,
};

const staff = createStaff({
  state,
  economy: staffEconomy,
  worldState,
  /* 成长线：每升 1 星，店员总上限 +1（"星级解锁店员上限"这条需求）
   * 代币永久增益「员工位 +1」可重复购买，与星级加成**相加**（不是替代）。 */
  capOf: () => STAFF.maxTotal + stars.staffCapBonus() + staffSlotBonus(state),
  maxPerType: () => STAFF.maxPerType + Math.floor(stars.staffCapBonus() / 2),
  onEvent: (type, p) => {
    // Bug⑥：所有拼给玩家的文案都过 safeText，缺字段时退到通用说法，
    // 绝不让 `undefined` 这种字符串漏到 toast 上。
    // 变量来源约定：p.name = **店员**名（谁做的）；p.label = 补货对象（货架/售货机/娃娃机）。
    switch (type) {
      case 'hire':
        toast(`已雇佣 ${p.emoji ?? ''} ${safeText(p.name, '店员')} · 解雇前持续扣薪`, 'ok');
        break;
      case 'fire':
        toast(`已解雇 ${safeText(p.name, '店员')}`, 'info');
        break;
      case 'salary':
        toast(`💰 已发放薪资 ${fmtYuan(-p.total)} · 店员继续工作`, 'info');
        break;
      case 'salary-fail':
        toast('⚠ 现金不足 · 全员停工（补足后自动恢复）', 'bad', 3000);
        break;
      case 'repair-done':
        toast(`🔧 ${safeText(p.name, '店员')} 修复了设备`, 'ok');
        break;
      case 'clean-done':
        toast(`🧹 ${safeText(p.name, '保洁员')} 清理了垃圾`, 'ok');
        break;
      case 'errand':
        // p.name 是**货品**名（"零食饮料"），店员名走 staffName —— 原来两处都拼 p.name，
        // 结果读成"零食饮料 外出采购 零食饮料…"，店员名字根本没出现。
        toast(`📦 ${safeText(p.staffName, '采购员')} 外出采购 ${safeText(p.name, '物资')}…`, 'info');
        break;
      case 'purchase-done':
        toast(`📦 ${safeText(p.staffName, '采购员')} 采购完成：${safeText(p.name, '物资')} 已入库`, 'ok');
        break;
      case 'stock-done':
        sfx.done('stock');   // 需求：上货完成 = 短促确认音
        toast(`📤 ${safeText(p.name, '上货员')} 完成补货${p.label ? `（${safeText(p.label, '货架')}）` : ''}`, 'ok');
        break;
      /* repair-nocash：维修员因现金不足没修成，避免刷屏，不弹 */
      default:
        break;
    }
  },
});

/** 店员管理分页 API（HUD 只读快照，执行动作后面板就地重绘） */
function staffApi() {
  return {
    snapshot: () => staff.snapshot(),
    hire: (type) => staff.hire(type),
    fire: (type) => staff.fire(type),
    canHire: (type) => staff.canHire(type),
  };
}

/** 仓库分页 API */
function warehouseApi() {
  return {
    snapshot: () => {
      const g = state.warehouse.goods;
      return {
        level: state.warehouse.level,
        cap: warehouseCap(),
        used: warehouseUsed(),
        free: warehouseFree(),
        goods: Object.entries(WAREHOUSE.goods).map(([id, def]) => ({
          id, name: def.name, emoji: def.emoji, unit: def.unit,
          cost: def.cost, qty: g[id] | 0, threshold: def.threshold,
        })),
        nextTier: WAREHOUSE.tiers[state.warehouse.level + 1] ?? null,
      };
    },
    // snack 映射到库存箱（饮料 SKU），其余三类走独立计数
    buyGood: (goodId, qty) => {
      if (goodId === 'snack') {
        const moq = SKU_BY_ID.drink.moq;
        return purchase('drink', Math.max(moq, qty));
      }
      return buyWarehouseGood(goodId, qty);
    },
    upgrade: () => upgradeWarehouse(),
  };
}

const dayNight = createDayNight({ cycleSec: DAYNIGHT.cycleSec, startPhase: 'night' });

/* Bloom：vendor 里没有 three 的 examples/jsm，postfx.mjs 是自实现的最简泛光。
   创建失败（浮点纹理不支持 / 老设备）必须降级为直出 —— 宁可没有光晕，也不能黑屏。 */
let post = null;
try {
  post = createBloom(world.renderer);
} catch (e) {
  console.warn('[NIGHT SHIFT] Bloom 不可用，降级为直出：', e);
  post = createPassThrough(world.renderer);
}

/* ---------- 娱乐设施小游戏：进入 / 结算 / 退出 ---------- */
/** 点唱机（纯氛围机）：按 E 循环切换店内 BGM 曲风 */
function cycleJukebox() {
  const styles = MINIGAME.jukebox?.styles ?? [];
  if (!styles.length) return;
  const i = styles.findIndex((s) => s.id === state.jukeboxStyle);
  const next = styles[(i + 1) % styles.length];
  state.jukeboxStyle = next.id;
  sfx.key();
  toast(`📻 曲风切换：${next.name} · 全场顾客停留 +15%`, 'ok', 2800);
  notify();
}

function openFacility(id) {
  const fac = FACILITY_BY_ID[id];
  if (!fac || isMinigameOpen() || state.minigameId) return;
  /* 点唱机没有小游戏面板（它是"切曲风"的开关，不产出收益） */
  if (fac.kind === 'jukebox') { cycleJukebox(); return; }

  state.minigameId = id;
  state.hover = null;
  // R4：本次游玩的关卡档由"该设施累计游玩次数"决定（跨夜保留）
  const plays = state.facilityPlays[id] ?? 0;
  state.facilityPlays[id] = plays + 1;
  // 交出鼠标：小游戏面板要能点击；退出时再重新锁定
  if (document.exitPointerLock) document.exitPointerLock();

  openMinigame(id, {
    plays,
    canPay: (c) => canAfford(c),
    pay: (c) => {
      if (payCash(c)) {
        state.minigameSpend += c;
        notify();
      }
    },
    reward: (r) => {
      const payout = r?.payout ?? 0;
      state.minigamePlays += 1;
      if (payout > 0) {
        earnCash(payout);
        state.minigameEarn += payout;
        sfx.coin();
      }
      /* 成就事件汇：在"事情发生的那一行"喊一声，判定逻辑全在 achievements.mjs */
      const kind = fac.kind;
      if (kind === 'claw') {
        achievements.note('claw', { prizeName: r?.item ?? null, totalPrizes: (MINIGAME.claw?.prizes ?? []).length });
        /* 抓到的娃娃是从玻璃柜里**拿走**的 —— 这正是 state.deviceStock 注释里写的"游玩消耗"。
         * 有了它，"柜子被玩空 → 见底挂补货提示 → 上货员从仓库补满"这条线才成立（P0-4）。 */
        const grabbed = r?.item ? 1 : 0;
        if (grabbed && (state.deviceStock?.claw | 0) > 0) state.deviceStock.claw -= 1;
      }
      else if (kind === 'fishing') achievements.note('fish', { rare: (r?.payout ?? 0) >= 60, name: r?.item ?? null });
      else if (kind === 'pachinko') achievements.note('pachinko', { combo: r?.combo ?? 0 });
      else if (kind === 'basketball') achievements.note('basket', { streak: r?.hits ?? 0 });
      else if (kind === 'dance') achievements.note('dance', { combo: r?.combo ?? 0 });
      else if (kind === 'racing') achievements.note('racing', { perfect: r?.perfect ?? 0 });
      else if (kind === 'ktv') {
        achievements.note('ktv', { score: r?.score ?? 0 });
        /* KTV 的社交属性：评分够高就带几位朋友进场（每台最多 3 名） */
        const friends = r?.friends ?? 0;
        if (friends > 0) {
          const made = npcs.spawnGuests?.(friends, 'youth') ?? 0;
          if (made) toast(`🎤 你的歌声引来了 ${made} 位客人`, 'ok', 3000);
        }
      }
      notify();
      /* 结算文案：金额只说一次。
       * 钓鱼 / 投篮 / 抓娃娃的 label 自带价格（"小挂饰 ¥6"），后面再拼一句
       * "· 入账 +¥6" 就变成「小挂饰 ¥6 · 入账 +¥6」——半句话叠半句话，读起来像乱码拼接。
       * 规则：label 里已经有 ¥ 就不再补金额；没有才补，并统一加设施 emoji 让每条提示自成一句。 */
      const facEmoji = FACILITY_INFO[kind]?.emoji ?? '🎮';
      const rl = r?.label ?? '';
      const line = payout > 0
        ? (/¥/.test(rl) ? `${facEmoji} ${rl}` : `${facEmoji} ${rl || '收获'} · 入账 ${fmtYuanSigned(payout)}`)
        : `${facEmoji} ${rl || '颗粒无收'}`;
      toast(line, payout > 0 ? 'ok' : 'info', 2600);
    },
    // R4：本地排行榜。写盘与名次计算都放在这里（minigames 只管玩法，不碰持久化）
    // 结算面板要显示"本局得分 / 历史最高"，所以这里把口径与单位一并回传。
    onLeaderboard: (kind, r) => {
      const value = scoreOf(kind, r);
      // 零收益/零命中不占榜位，避免榜被灌满没意义的记录
      if (!(value > 0)) return null;
      const info = submitLocal(kind, {
        value,
        name: identity?.displayName ?? '店员',
        night: state.night,
        meta: r?.label ?? '',
      });
      const best = info.entries.length ? Math.max(...info.entries.map((e) => e.value)) : value;
      return {
        rank: info.rank,
        isBest: info.isBest,
        value,
        best,
        unit: LEADERBOARD.metrics[kind]?.unit ?? '',
      };
    },
    // R3：小游戏结算后把回血增益计入店员心理（受夜上限约束，见 §3 / §8.1 nightCap）
    onMental: (kind, result) => {
      const g = mentalFromResult(kind, result);
      const applied = applyGameMental(state, g);
      if (applied > 0) toast(`🧠 回血 +${Math.round(applied)} 心理`, 'info', 2200);
    },
    onClose: () => {
      state.minigameId = null;
      state.paused = false;
      if (state.phase === 'running') player.requestLock();
      if (!player.locked) toast('回到店铺 · 点击画面锁定鼠标', 'info', 1800);
    },
  });
}

/* ==================================================================
 * QTE（维修 / 清洁 / 上货）—— 玩家亲手做时的 5 秒迷你挑战
 *
 * interaction 在 repair/clean/place 三个分支里，若注入这些回调就先走 QTE、
 * 不再走"立即完成 + BUSY"的旧路径；未注入时行为与扩展前完全一致。
 * QTE 期间暂停游戏时钟（见 qte.mjs 文件头），倒计时走墙钟 —— 玩家不因专注操作而丢顾客。
 * 成功动作落地后由 worldState 的 onEvent 自动补音效与提示（维修/清洁），上货则手动补。
 * ================================================================== */

/** QTE 结束后的统一收尾：恢复营业 + 重新锁定鼠标 */
function finishQte() {
  state.paused = false;
  if (state.phase === 'running') player.requestLock();
}

/** 动作收尾的短暂 BUSY（QTE 成功后的动作耗时，比原路径更短 —— 体现"更快"） */
function setQteBusy(sec) {
  if (sec > 0) {
    state.busyUntil = state.wallElapsed + sec;
    if (!state.busyLabel) state.busyLabel = 'qte';
  }
}

/** 维修 QTE：按顺序点螺丝，维修费打折；点错 +10%，封顶原价 */
function openRepairQte(id) {
  const fac = FACILITY_BY_ID[id];
  const dev = worldState.device(id);
  if (!dev?.broken) return;                    // 保险：设备已不坏就不同时弹
  const base = worldState.repairCost(id);
  if (document.exitPointerLock) document.exitPointerLock();
  state.paused = true;
  openQte({
    kind: 'repair',
    title: `🔧 维修 ${fac?.emoji ?? ''}${fac?.name ?? '设备'}`,
    baseCost: base,
    onDone: (out) => {
      if (out.ok) {
        const final = Math.max(1, Math.ceil(base * out.result.costMul));
        const r = worldState.repair(id, state.cash, final);   // 折扣价覆盖：costOverride
        if (r.ok) {
          payCash(r.cost);
          syncDevices();
          notify();
          // 修好的音效与"−¥cost"提示由 worldState 的 onEvent('repair') 统一弹（r.cost 已是折扣价）
        }
      }
      finishQte();
    },
  });
}

/** 清洁 QTE：拖抹布擦污渍 */
function openCleanQte(litterId) {
  if (document.exitPointerLock) document.exitPointerLock();
  state.paused = true;
  openQte({
    kind: 'clean',
    title: '🧹 清理垃圾',
    onDone: (out) => {
      if (out.ok) {
        const r = worldState.clean(litterId);
        if (r.ok) {
          world.setLitter(worldState.litter);
          setQteBusy(QTE.clean.busySec);
          notify();
          // 清理音效与提示由 worldState 的 onEvent('clean') 统一弹
        }
      }
      finishQte();
    },
  });
}

/** 上货 QTE：拖拽货物到正确的货架格 */
function openRestockQte(slotIndex) {
  if (!state.held) return;
  const sku = SKU_BY_ID[state.held.skuId];
  if (document.exitPointerLock) document.exitPointerLock();
  state.paused = true;
  openQte({
    kind: 'restock',
    title: `📤 上货 ${sku?.emoji ?? ''}×${state.held.qty}`,
    item: { skuId: state.held.skuId, emoji: sku?.emoji, qty: state.held.qty },
    slots: state.slots.map((s) => ({ skuId: s.skuId, qty: s.qty })),
    onDone: (out) => {
      if (out.ok) {
        const r = place(out.result.slotIndex);
        if (r.ok) {
          applyActionCost(state, 'PLACE');   // 与旧路径一致：上货消耗体力
          setQteBusy(QTE.restock.busySec);
          sfx.done('stock');
          toast(`已上架 ${r.sku?.emoji ?? ''}×${r.put}`, 'ok');
          notify();
        } else {
          toast(r.reason ?? '上货失败', 'bad');
        }
      }
      finishQte();
    },
  });
}

/* 块6：对准垃圾桶按 E → 一次清空所有垃圾。
 * 每件 +recyclePerItem 回收金（入 cash/revenue），清一堆加 repPerClear×n 口碑；
 * 同步隐藏垃圾堆网格（world.setGarbage(0)），并给一个正向反馈音 + 提示。
 * reputation 钳在 0~100（与堆积扣分对称）。 */
function clearGarbage() {
  const n = state.garbage | 0;
  if (n <= 0) return { ok: false, reason: '垃圾桶是空的' };
  const gain = n * GARBAGE.recyclePerItem;
  state.cash += gain;
  state.revenue += gain;
  const repGain = n * GARBAGE.repPerClear;
  state.reputation = Math.max(0, Math.min(100, state.reputation + repGain));
  state.garbage = 0;
  world.setGarbage(0);
  notify();
  sfx.coin();
  toast(`🗑 清空垃圾 ${n} 件 · 回收金 ${fmtYuan(gain)} · 口碑 +${repGain.toFixed(1)}`, 'ok');
  return { ok: true, cleared: n, gain };
}

const interaction = createInteraction({
  camera: world.camera,
  anchors: world.anchors,
  onFacility: openFacility,
  // 醉汉：暴露当前活动醉汉（含 mesh 供锥选），劝离结果在此结算并清场
  getDrunk: () => state.events.drunk,
  onDrunk: (success) => {
    resolveDrunkOutcome(state, success); // 成功 rep+2/S−3 · 失败 rep−5/M−5
    const dk = state.events.drunk;
    if (dk) customers.removeDrunk(dk); // 离店清场（与超时路径一致）
  },
  /* --- 需求④ 维修 / 需求⑤ 清洁 --- */
  getDeviceState: (id) => {
    const d = worldState.device(id);
    if (!d) return null;
    return {
      broken: d.broken,
      downFor: d.downFor,
      awaitingRepair: d.awaitingRepair,
      repairCost: worldState.repairCost(id),
    };
  },
  /* QTE：玩家亲手做维修/清洁/上货 → 弹 5 秒迷你挑战（成功更快更便宜） */
  onQteRepair: openRepairQte,
  onQteClean: openCleanQte,
  onQteRestock: openRestockQte,
  onRepair: (id) => {
    const r = worldState.repair(id, state.cash);
    if (!r.ok) {
      toast(r.reason === 'insufficient' ? `现金不足 · 需 ${fmtYuan(r.cost)}` : '这台设备没坏', 'bad');
      return r;
    }
    payCash(r.cost);
    notify();
    return r;
  },
  /* 需求I ③：选中道具后按 E 使用。selectedItem 是函数（interaction 每帧取当前选中项）；
   * onUseItem 真正生效后由 main 调用 inventory.consume（失败不吃道具，见 items.mjs 约定）。 */
  selectedItem: () => inventory.selected(),
  onUseItem: useItem,
  nearbyLitterCount: () => countNearbyLitter(),
  /* 需求I ⑦：售货机 E 直接收款（不走小游戏面板） */
  onVending: doVending,
  onClean: (litterId) => {
    const r = worldState.clean(litterId);
    if (!r.ok) return r;
    // 垃圾网格同步（清掉后池子里的对应网格要隐藏）
    world.setLitter(worldState.litter);
    notify();
    return r;
  },
  /* --- 环境互动：深夜猫 / 外卖员 / 墙上老电视 --- */
  /* 块5：进货运输 —— 提示只读状态，执行落到 delivery 模块 */
  deliveryHint: () => delivery.panel(),
  onDelivery: (action, arg) => (action === 'pickup' ? delivery.pickup(arg) : delivery.putaway()),
  /* 块6：垃圾桶清空（结算回收金 + 口碑，逻辑全在 main 的 clearGarbage） */
  onTrashcan: clearGarbage,

  ambientHint: (id) => {
    if (id === 'cat') {
      return ambient.catHere() ? { ok: true, prompt: '🐱 抚摸夜猫 · 全场满意度短暂 +8' } : null;
    }
    if (id === 'courier') {
      const pay = state.ambient?.courier?.pay ?? 0;
      return ambient.courierHere() ? { ok: true, prompt: `🛵 接下跑腿单 · ${fmtYuanSigned(pay)}` } : null;
    }
    if (id === 'tv') {
      return { ok: true, prompt: `📺 收看《${ambient.tvProgram().name}》 · 满意度 +2` };
    }
    /* 疲劳系统：咖啡机（买了 upgrade 才能喝） / 洗手台（恒可用） */
    if (id === 'coffee') {
      if (!state.upgrades.coffee) return { ok: false, prompt: '☕ 咖啡机（需先在商店购买）' };
      const f = state.playerFatigue;
      if (f <= 0) return { ok: false, prompt: '☕ 你现在不困，不需要咖啡' };
      return { ok: true, prompt: `☕ 喝杯咖啡 · 疲劳 -${FATIGUE.coffeeRecover}` };
    }
    if (id === 'sink') {
      const f = state.playerFatigue;
      if (f <= 0) return { ok: false, prompt: '🚰 你现在不困，不需要洗脸' };
      return { ok: true, prompt: `🚰 洗把冷水脸 · 疲劳 -${FATIGUE.washRecover}` };
    }
    return null;
  },
  onAmbient: (id) => {
    if (id === 'cat') {
      const r = ambient.petCat(state.wallElapsed);
      toast(r.ok ? '🐱 猫蹭了蹭你的手 · 全场满意度 +8' : (r.reason ?? ''), r.ok ? 'ok' : 'info', 2600);
      if (r.ok) sfx.satisfied();
    } else if (id === 'courier') {
      const r = ambient.acceptErrand(state.wallElapsed);
      toast(r.ok ? `🛵 接下单子 · ${r.sec}s 后到账 ${fmtYuan(r.pay)}` : (r.reason ?? ''), r.ok ? 'ok' : 'info', 2600);
    } else if (id === 'tv') {
      const r = ambient.watchTv(state.wallElapsed);
      if (r.ok) {
        toast(`📺 《${r.program.name}》正在播出 · 满意度 +${r.rep}`, 'info', 2200);
        world.setTvProgram?.(ambient.tvProgram());
      } else if (r.reason) toast(r.reason, 'info', 1600);
    } else if (id === 'coffee') {
      if (!state.upgrades.coffee) { toast('☕ 还没买咖啡机 · 去 Tab 商店看看', 'info', 2200); }
      else {
        fatigue.drinkCoffee();
        toast(`☕ 喝下咖啡 · 疲劳 -${FATIGUE.coffeeRecover}`, 'ok', 2000);
        sfx.satisfied();
      }
    } else if (id === 'sink') {
      fatigue.washFace();
      toast(`🚰 冷水扑脸 · 疲劳 -${FATIGUE.washRecover}`, 'ok', 2000);
      sfx.key();
    }
    notify();
  },
});

/* ==================================================================
 * 需求I ③④⑦：道具使用 / 售货机收款 / 商店与扩建辅助
 * 这些函数被 interaction / keydown 调用，且被 progression.onEvent 间接用到。
 * ================================================================== */

/** 玩家附近半径内的垃圾数（清洁喷雾的提示文案用） */
function countNearbyLitter() {
  const r = CONSUMABLE_BY_ID.spray?.radius ?? 9;
  let n = 0;
  for (const l of worldState.litter) {
    const dx = l.x - playerX();
    const dz = l.z - playerZ();
    if (dx * dx + dz * dz <= r * r) n += 1;
  }
  return n;
}

/**
 * 使用选中道具（interaction 的 onUseItem）。
 * 规则：效果真正生效后 main 才扣道具；失败返回 {ok:false} 且不吃道具（见 items.mjs）。
 * @param itemId 'repairkit' | 'spray' | 'poster'
 * @param hover   interaction 传来的对准信息（repairkit 需要 facilityId）
 */
function useItem(itemId, hover) {
  if (itemId === 'repairkit') {
    const fid = hover?.facilityId;
    const dev = fid ? worldState.device(fid) : null;
    if (!dev || !dev.broken) return { ok: false, reason: '这台设备没坏' };
    const r = worldState.repair(fid, state.cash);
    if (!r.ok) return { ok: false, reason: r.reason === 'insufficient' ? `现金不足 · 需 ${fmtYuan(r.cost)}` : '维修失败' };
    payCash(r.cost);
    syncDevices();
    inventory.consume('repairkit');
    notify();
    return { ok: true };
  }
  if (itemId === 'spray') {
    const r = CONSUMABLE_BY_ID.spray?.radius ?? 9;
    let n = 0;
    for (const l of [...worldState.litter]) {
      const dx = l.x - playerX();
      const dz = l.z - playerZ();
      if (dx * dx + dz * dz <= r * r && worldState.clean(l.id).ok) n += 1;
    }
    world.setLitter(worldState.litter);
    notify();
    if (n > 0) toast(`🧴 清洁喷雾清掉 ${n} 件垃圾`, 'ok', 1800);
    inventory.consume('spray');
    return { ok: true };
  }
  if (itemId === 'poster') {
    const dur = CONSUMABLE_BY_ID.poster?.durationSec ?? 60;
    state.posterUntil = state.wallElapsed + dur;
    toast(`📣 人气海报已张贴 · ${dur}s 内客流提升`, 'ok', 1800);
    notify();
    inventory.consume('poster');
    return { ok: true };
  }
  if (itemId === 'energyspray') {
    // 疲劳系统：提神喷雾。use:'now' = 选中后按 E 立即用，不看对准目标。
    fatigue.useSpray();
    toast(`⚡ 提神喷雾生效 · 精神恢复`, 'ok', 1800);
    notify();
    inventory.consume('energyspray');
    return { ok: true };
  }
  return { ok: false, reason: '未知道具' };
}

/**
 * 售货机收款（需求I ⑦）。无小游戏面板，按 E 直接结算一笔货款并进入冷却。
 * 收益计入门店累计收入（state.earned）→ 同样驱动"赚金币"限时任务。
 */
function doVending(facilityId) {
  const fac = FACILITY_BY_ID[facilityId];
  if (!fac || fac.kind !== 'vending') return { ok: false, reason: '不是售货机' };
  const def = MINIGAME.vending;
  if (!def) return { ok: false, reason: '售货机未配置' };
  const lo = def.payout[0];
  const hi = def.payout[1];
  const base = lo + Math.random() * (hi - lo);
  const amount = Math.round(base * (1 + progression.vendingBonus()));
  earnCash(amount);
  state.tokens += 1;
  state.vendingCooldown[facilityId] = state.wallElapsed + (def.cooldownSec ?? 25);
  notify();
  toast(`🥤 售货机收款 ${fmtYuanSigned(amount)}`, 'ok', 1800);
  return { ok: true, amount };
}

/** Tab 商店的"门店投资"分区（设备升级 / 机器改装 / 店铺扩建），HUD 只画、这里执行 */
/**
 * 代币出口 API（兑换 / 扭蛋 / 限时券 / 主题情报）。
 * 表现副作用（toast / 面板重绘）在这里收口，boons.mjs 只管数据 —— 保持纯逻辑可单测。
 */
function boonsApi() {
  return {
    /** 商店面板数据（兑换项 + 已拥有 / 可买状态 + 扭蛋概率表） */
    snapshot: () => {
      ensureBoons(state);
      return {
        ...shopSnapshot(state),
        gacha: { ...gachaTable(), tokens: state.tokens },
        cards: state.buffCards.map((c) => ({
          ...c,
          meta: BUFF_KINDS[c.kind] ?? null,
          /** 剩余几夜（含今夜）；已过期为 0 */
          left: Math.max(0, (c.expireNight ?? 0) - state.night),
        })),
      };
    },

    /** 兑换永久增益 */
    buy: (key) => {
      const r = buyBoon(state, key);
      if (r.ok) {
        const b = BOON_SHOP.find((x) => x.key === key);
        toast(`${b?.emoji ?? '🎁'} 已兑换「${b?.name ?? key}」`, 'ok', 2600);
        syncDevices();          // 员工位变了 → 面板上限要重画
        notify();
      } else if (!r.owned) {
        toast(`🪙 ${r.reason}`, 'bad', 2200);
      }
      return r;
    },

    /** 扭蛋抽一次 */
    pull: () => {
      const r = pullGacha(state);
      if (!r.ok) { toast(`🪙 ${r.reason}`, 'bad', 2200); return r; }
      if (r.kind === 'cash') {
        toast(`🎉 中奖：现金 ${fmtYuan(r.cash)}`, 'ok', 3000);
      } else if (r.kind === 'boon') {
        const b = BOON_SHOP.find((x) => x.key === r.boonKey);
        toast(`🎉 中奖：${r.text}（已永久生效 Lv${r.boonLevel}）`, 'ok', 3400);
        syncDevices();
      } else {
        const meta = BUFF_KINDS[r.card];
        toast(`🎉 中奖：${r.text} · 第 ${r.expireNight} 夜生效`, 'ok', 3200);
      }
      notify();
      return r;
    },

    /** 主题情报：查看明晚（当晚免费再看） */
    viewNext: () => {
      const r = themes.viewNext();
      if (!r.ok) { toast(`🪙 ${r.reason}`, 'bad', 2200); return r; }
      if (r.cached) {
        toast(`📡 明晚是「${r.theme?.emoji ?? ''} ${r.theme?.name ?? '未知'}」（今晚已看过，不再扣费）`, 'info', 3200);
      } else {
        toast(`📡 花 ${INTEL_VIEW_COST} 代币买到情报：明晚是「${r.theme?.emoji ?? ''} ${r.theme?.name ?? '未知'}」`, 'ok', 3400);
      }
      notify();
      return r;
    },

    /** 主题情报：锁定明晚 */
    lockNext: (themeId) => {
      const r = themes.lockNext(themeId);
      if (!r.ok) { toast(`🪙 ${r.reason}`, 'bad', 2200); return r; }
      toast(`🔒 已锁定明晚为「${r.theme?.emoji ?? ''} ${r.theme?.name ?? themeId}」`, 'ok', 3200);
      notify();
      return r;
    },

    /** 锁定候选池（排除节日限定） */
    lockCandidates: () => themes.lockCandidates().map((t) => ({ id: t.id, name: t.name, emoji: t.emoji, desc: t.desc })),

    /** 只读快照（探针 / 存档核对用） */
    debug: () => ({
      boons: { ...ensureBoons(state).boons },
      buffCards: state.buffCards.map((c) => ({ ...c })),
      intel: { ...state.intel },
      tokens: state.tokens,
      night: state.night,
      themeId: state.themeId,
    }),
  };
}

function shopApi() {
  return {
    snapshot: () => progression.snapshot(),
    onUpgrade: (id) => {
      const r = progression.upgrade(id);
      if (r.ok) { syncDevices(); notify(); }
      return r;
    },
    onInstall: (devId, modId) => {
      const r = progression.installModule(devId, modId);
      if (r.ok) { syncDevices(); notify(); }
      return r;
    },
    onRemove: (devId, modId) => {
      const r = progression.removeModule(devId, modId);
      if (r.ok) { syncDevices(); notify(); }
      return r;
    },
    // 扩建的副作用（场景/设施/碰撞体）由 progression.onEvent 统一收口，这里只下单
    onExpansion: (id) => progression.buyExpansion(id),
  };
}

/** 读档/开局后按 state.expansions 把场景补回来（扩建区预建隐藏，这里只点亮） */
function syncExpansions() {
  const owned = Object.keys(state.expansions ?? {}).filter((k) => state.expansions[k]);
  for (const id of owned) {
    const facs = world.applyExpansion(id) ?? [];
    registerFacilities(facs);
    const ids = facs.map((f) => f.id);
    if (ids.length) worldState.registerDevices(ids);
  }
  applyLayout(world.colliders, { owned });
  player.setBounds(computeBounds(owned));
}

const player = createPlayer(world.camera, world.colliders, canvas, {
  // 手感 3：脚步（瓷砖 / 室外软地）—— 用程序化音效，不引任何音频资源
  onFootstep: (surface) => sfx.footstep(surface),
  onLockChange(locked, reason) {
    // 小游戏中会主动交出指针锁定，此时不能把它当成"玩家按了 Esc 想暂停"
    const inGame = isMinigameOpen() || isQteOpen() || state.minigameId !== null;
    if (locked) {
      state.pointerLockBlocked = false;
      if (!isModalOpen() && !inGame && state.phase === 'running') state.paused = false;
      return;
    }
    if (inGame) return;
    if (reason === 'error' || reason === 'timeout') {
      // 沙箱 iframe / 权限拒绝 → 游戏继续可玩（拖动环视兜底），只在角落提示一次
      state.pointerLockBlocked = true;
      if (state.phase === 'running') showLockHintOnce();
      if (state.phase === 'running' && !isModalOpen()) state.paused = false;
      return;
    }
    // 用户主动 Esc 退出锁定 → 暂停（SYS-05 §2）
    if (!isModalOpen() && state.phase === 'running') state.paused = true;
  },
});

/* player.position 是 **THREE.Vector2**（x = 世界 x，y = 世界 z），Vector2 根本没有 .z。
 * 早期几处按 Vector3 的习惯写了 .z，读出来是 undefined，一进算术就变 NaN ——
 * 而 NaN 参与的比较**永远为 false**，于是表现为"这段逻辑安安静静什么都没做"：
 *   · 新手引导位移累计 = NaN → 走多久都停在"引导 1/3"（用户报的卡死）
 *   · 清洁喷雾的半径判定 = NaN → 喷了但一件垃圾都没清掉
 * 两者都不抛异常、控制台一片干净，所以统一收口到这两个取值器，别再手写 .z。 */
const playerX = () => player.position.x;
const playerZ = () => player.position.y;

mountHud(hudRoot);

/* 双端适配：触屏设备挂载移动控制层（摇杆/转视角/交互/菜单/横屏）；桌面端返回 null 不挂载 */
function relock() {
  if (state.phase === 'running') { state.paused = false; player.requestLock(); }
}
function togglePause() {
  state.paused = !state.paused;
  if (state.paused) { if (document.exitPointerLock) document.exitPointerLock(); }
  else player.requestLock();
}
const mobileControls = createMobileControls({
  player,
  interaction,
  panels: {
    // ⚠ secondhandApi 是**对象**（见 line 317 定义），不是函数。
    //   2026-10-03：这里早先写成了 `secondhandApi()`，于是手机上点「进货/商店」
    //   一路抛 TypeError: secondhandApi is not a function，面板永远打不开。
    //   桌面走 Tab 分支（line 1385）传的是对象，所以一直没暴露 ——
    //   说明**同一条面板路径有桌面/触屏两份接线时，必须两边都真机走一遍**。
    // 块5：末位 deliveryApi 让玩家手动下单走运输闭环；采购员仍用 purchase（即时到仓）。
    // ⚠ 这一行**必须保持单行**：tests/boons.test.mjs 用 /openPurchase\(…\)\s*=>\s*relock\(\),\s*([^\n]*)/ 抽参数尾部做断言，
    // 跨行会被正则截断（实测抽出来不完整 → 误报"没传 boonsApi"）。
    purchase: () => openPurchase(() => relock(), purchase, shopApi(), staffApi(), warehouseApi(), growthApi(), secondhandApi, boonsApi(), deliveryUiApi),
    inventory: () => openInventory(inventory, () => relock()),
    phone: () => openPhone(() => relock(), phoneApi),
    monitor: () => openMonitor(() => relock(), monitor),
    leaderboard: () => openLeaderboard(leaderboardBoards(), () => relock()),
    save: () => { const r = save.save(); if (!r.ok) sfx.bad(); },
    load: () => loadGame(),
    pause: () => togglePause(),
    // 移动端直达「设置」：与桌面 Esc→暂停→设置 同口径（含账号重开入口）。
    // 关掉后停在游戏内（relock），重开成功后回到第一夜。
    settings: () => openSettings(() => relock(), reset, () => {
      if (document.exitPointerLock) document.exitPointerLock();
      toast('重开完成 · 从第一夜重新开始', 'ok', 3200);
      player.requestLock();
    }),
  },
});

/* ==================================================================
 * 玩家设置（Esc → ⚙ 设置）
 *
 * 一处订阅、四处落地：后处理调色（亮度/伽马/暗角）/ 音频总线 / 玩家灵敏度 / 相机 FOV。
 * 设置直接读写 localStorage、**不进存档** —— 所以"读档后沿用"是天然成立的：
 * 读档流程根本不会碰它，玩家偏好自然保留。
 * ================================================================== */
function applySettings(s = settings) {
  if (typeof post.setGrade === 'function') {
    post.setGrade({ brightness: s.brightness, gamma: s.gamma, vignette: s.vignette });
  }
  player.setSensitivity(s.sensitivity);
  world.setFov(s.fov);
  sfx.applyVolumes();
}
/* 触屏设备首次启动：手机横屏视野窄 + 手指滑动天生比鼠标费劲，
 * 默认把 FOV 拉到 85°、灵敏度倍率 1.4（进设置可随时调回）。
 * 只在「从未保存过设置」时生效一次：玩家调过任何一项后，以玩家保存的值为准，
 * 不会在每次启动时覆盖玩家的自定义。 */
function isTouchDevice() {
  if (typeof window === 'undefined') return false;
  try {
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return true;
  } catch { /* ignore */ }
  return 'ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0;
}
if (isTouchDevice() && !localStorage.getItem(SETTINGS_KEY)) {
  setSettings({ fov: 85, sensitivity: 1.4 });
}
loadSettings();
onSettingsChange((s) => applySettings(s));
applySettings();

/* ---------- R4：本地排行榜面板的数据装配（hud 只负责画，不碰存储） ---------- */
const FACILITY_INFO = {
  pachinko: { emoji: '🎰', label: '弹珠机' },
  fishing: { emoji: '🎣', label: '钓鱼池塘' },
  basketball: { emoji: '🏀', label: '投篮机' },
  claw: { emoji: '🧸', label: '抓娃娃机' },
};

function leaderboardBoards() {
  return Object.entries(LEADERBOARD.metrics).map(([kind, m]) => ({
    kind,
    emoji: FACILITY_INFO[kind]?.emoji ?? '🎮',
    label: FACILITY_INFO[kind]?.label ?? kind,
    metric: m.label,
    unit: m.unit,
    entries: readBoard(kind),
  }));
}

/* ==================================================================
 * 需求H 存档系统
 *
 * 三个入口：
 *   · save.save()      —— F5 手动存档
 *   · save.load()      —— F9 读取最近一次存档
 *   · save.tick(dt)    —— 每 120 游戏秒自动存档（暂停/小游戏中不计时）
 *
 * 提示统一走 hud.saveToast（右上角磨砂 · 2s 自动消失）。
 *
 * ── 存档按账号隔离（重开机制的前提）────────────────────────
 * 键名从"一个全局键"改成 `nightshift.save.v1.<accountId>`（save.mjs 的 saveKeyFor）。
 * 传入的是**函数**而不是字符串：save 在登录之前就创建了，只有真正读写的那一刻
 * 才知道当前是谁 —— 提前 bind 成常量会导致"三个账号共用一份档"，
 * 于是"重开本账号"会连带抹掉别人的进度（那正是要修掉的问题）。
 * ================================================================== */

/** 当前登录身份。**必须声明在 save 之前**：存档键解析器要闭包引用它。 */
let identity = null;

const save = createSaveManager({
  ctx: { state, worldState, npcs, dayNight, player },
  storageKey: () => saveKeyFor(identity?.accountId),
  autosaveSec: AUTOSAVE_SEC,
  // 只有"真的在营业"才累计存档计时：暂停时挂机不该刷存档
  shouldTick: () => state.phase === 'running' && !state.paused && !isMinigameOpen() && !isQteOpen(),
  onResult: (kind, res) => {
    if (kind === 'load') {
      // 读档结果由调用方（F9 / 开局）统一提示，这里不重复弹
      return;
    }
    if (!res.ok) {
      saveToast(res.reason === 'quota' ? '存档失败 · 存储空间不足' : '存档失败', 'bad', 2600);
      return;
    }
    // 需求 5：成功时统一显示「已存档」（自动存档与手动存档文案一致，
    // 玩家不需要区分 —— 只有"存上了 / 没存上"才是他要的信息）
    saveToast('已存档', 'ok');
  },
});

/** 把还原后的环境状态刷到 3D 场景（读档后立刻调用一次） */
function syncWorldVisuals() {
  world.setLitter(worldState.litter);
  syncDevices();
  world.applyDayNight(dayNight.state());
  syncExpansions();
  syncStars();   // 读档后按星级把已解锁的机器与装修补回场景
  // 需求J：店员 marker 同步（scene 没实现时静默跳过，不阻断）
  if (typeof world.syncStaff === 'function') world.syncStaff(staff.snapshot().roster);
}

/** HUD 要展示的环境派生值（与存档内容一一对应，方便玩家核对读档结果） */
function envSnapshot() {
  return {
    npcCount: npcs.count,
    satisfaction: worldState.satisfaction(),
    cleanliness: worldState.cleanliness,
    litterCount: worldState.litter.length,
    brokenCount: worldState.brokenCount(),
    /* 需求I ②⑥：左下角任务面板 + 突发事件/海报倒计时 */
    quest: quests.panel(),
    incident: incidents.status(),
    posterLeft: (state.posterUntil != null && state.wallElapsed < state.posterUntil)
      ? (state.posterUntil - state.wallElapsed) : 0,
    /* 2026-10-05 促销可视化：促销剩余秒数（HUD 顶部倒计时横幅） */
    promoLeft: pricing.promoRemaining(),
    /* 疲劳系统：疲劳度 + 档位（HUD 读它画疲劳条；打瞌睡时画遮罩） */
    fatigue: state.playerFatigue,
    fatigueLevel: fatigue.level(),
    dozing: fatigue.isDozing(),
    /** 块6：当夜垃圾件数（HUD 顶部「垃圾堆积」警告用它判断 ≥warnThreshold） */
    garbageCount: state.garbage | 0,
  };
}

/** F9：读档。读完必须刷新场景表现，否则会出现"数据回来了但画面没变" */
function loadGame() {
  /* 读档边界收口：先收掉任何开着的"脏 UI"（模态 / 小游戏 / 暂停态），
   * 避免"读进一个还开着的面板"导致两层 UI 叠加、或读档后卡在暂停。
   * 桌面 F9 已在 keydown 里对 isModalOpen/isMinigameOpen/isQteOpen 早退拦截，
   * 这里主要兜住移动端菜单触发读档、以及任何漏网路径。 */
  try { if (isModalOpen()) closeModal(); } catch { /* ignore */ }
  try { if (isMinigameOpen()) closeMinigame(); } catch { /* ignore */ }
  if (state.paused) { state.paused = false; try { if (document.exitPointerLock) document.exitPointerLock(); } catch { /* ignore */ } }

  const res = save.load();
  if (!res.ok) {
    saveToast(res.reason === 'no-save' ? '没有可读取的存档' : '存档已损坏 · 无法读取', 'bad', 2600);
    return res;
  }
  syncWorldVisuals();
  notify();
  saveToast('已读取存档', 'ok');
  return res;
}

/* ---------- 点击画面恢复（指针锁定可用与不可用两种模式都靠它） ---------- */
canvas.addEventListener('mousedown', () => {
  if (isMinigameOpen() || state.minigameId || isQteOpen()) return;
  if (state.paused && !isModalOpen() && state.phase === 'running') {
    state.paused = false;
    toast('继续营业', 'info');
  }
});

/* ---------- 新手引导（第 1 夜前 3 分钟的三步引导，做完即不再出现） ----------
 * 为什么要"每步做完才进下一步"：三步里第 3 步（Tab 采购上货）会打开一个全屏面板，
 * 如果一进游戏就把三步糊完，玩家读到第 2 步时已经点开商店，三步全部作废。
 * 判定条件刻意用"真实行为"（走过路 / 真的交互成功 / 真的打开过商店）而不是时间 ——
 * 用时间推的话，站着不动的玩家会被"教"完还没学会。 */
const TUTORIAL_SECONDS = 180;
/**
 * 第 1 步"走两步"的判定距离（米）。
 * 位移用 player.frameMove（player.mjs 每帧算好的水平位移）**累计**，
 * 而不是自己拿坐标做差 —— player.position 是 THREE.Vector2，只有 x/y，
 * 老代码读 .z 得到 undefined，累加出来是 NaN，NaN > 阈值恒为 false，
 * 于是引导无论走多久都停在"引导 1/3"（用户报的卡死，控制台一片干净）。
 */
const TUTORIAL_WALK_M = 3.0;
const TUTORIAL_STEPS = [
  { text: '用 W A S D 在店里走两步', hint: '鼠标转视角 · Shift 小跑' },
  { text: '走近货架或库存箱，按 E 取货 / 上货', hint: '结账、维修、清扫也都是 E' },
  { text: '按 Tab 打开商店采购，再把货摆上货架', hint: '顾客来了回收银台按 E 收银' },
];
const tutorial = {
  step: 1,
  moved: 0,
  shown: false,
  acted: false,     // 第 2 步的完成条件：至少一次交互成功
  shopped: false,   // 第 3 步的完成条件：至少打开过一次商店
  done: false,      // 一旦结束（走完 / 超时 / 非第 1 夜）就永不再出现
};

function updateTutorial() {
  const inWindow = !tutorial.done
    && state.night === 1
    && state.phase === 'running'
    && !state.paused
    && !isModalOpen()          // 打开商店/背包时字幕要收起来，别叠在面板上
    && state.wallElapsed < TUTORIAL_SECONDS;
  if (!inWindow) {
    if (tutorial.shown) { tutorial.shown = false; hideTutorial(); }
    // 超时同样记为"结束"：第 1 夜前 3 分钟一过就不该再冒出来
    if (state.night !== 1 || state.wallElapsed >= TUTORIAL_SECONDS) tutorial.done = true;
    return;
  }

  // 位移每帧累计（只统计引导生效期间；player 暂停时 frameMove 已被清零，不会灌进脏值）
  tutorial.moved += player.frameMove;

  /* 三步的完成条件都是**真实动作**：走够距离 / 成功交互过一次 / 打开过一次商店。
   * 全部达成即 done=true 永久消失（本局内不会再回来）。 */
  if (tutorial.step === 1) {
    if (tutorial.moved > TUTORIAL_WALK_M) tutorial.step = 2;
  } else if (tutorial.step === 2 && tutorial.acted) {
    tutorial.step = 3;
  } else if (tutorial.step === 3 && tutorial.shopped) {
    tutorial.done = true;
    tutorial.shown = false;
    hideTutorial();
    toast('👍 引导完成 · 剩下的交给你了', 'ok', 2400);
    return;
  }

  tutorial.shown = true;
  const s = TUTORIAL_STEPS[tutorial.step - 1];
  showTutorial(tutorial.step, TUTORIAL_STEPS.length, s.text, s.hint);
}

/* ---------- 输入 ---------- */
function isTyping(t) {
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
}

window.addEventListener('keydown', (e) => {
  if (isTyping(e.target) || isModalOpen()) return;
  // 小游戏面板自己接管键盘（空格 / 方向键 / Esc），这里必须让路
  if (isMinigameOpen() || state.minigameId || isQteOpen()) return;

  if (e.code === 'F3') {
    e.preventDefault();
    debugOn = !debugOn;
    dbgEl.style.display = debugOn ? 'block' : 'none';
    return;
  }

  /* --- 需求H：F5 手动存档 / F9 读档 ---
   * F5 默认是浏览器刷新，必须 preventDefault，否则一存档页面就重载了。
   * 两个键都要在**未开局**时也能用（读档本身就是开局的入口之一）。 */
  if (e.code === 'F5') {
    e.preventDefault();
    const res = save.save();
    // 失败提示由 save.onResult 统一弹，这里只在成功时补一句正文说明
    if (res.ok) { sfx.save(); toast(`已存档 · 金币 ${fmtYuan(state.cash)} · 代币 ${state.tokens}`, 'ok', 1800); }
    else sfx.bad();
    return;
  }

  if (e.code === 'F9') {
    e.preventDefault();
    const res = loadGame();
    if (res.ok) {
      sfx.load();
      toast(
        `读档成功 · 第 ${state.night} 夜 ${Math.floor(state.gameHour)}:00 · `
        + `金币 ${fmtYuan(state.cash)} · 代币 ${state.tokens} · 顾客 ${npcs.count}`,
        'ok', 2600,
      );
    } else {
      sfx.bad();
    }
    return;
  }

  if (e.code === 'Escape') {
    togglePause();
    toast(state.paused ? '已暂停 · 点击画面或按 Esc 继续' : '继续营业', 'info');
    return;
  }

  if (e.code === 'KeyE') {
    // 手感 2：按下瞬间给一次"按键手感"音；结果出来再报成功/失败音
    sfx.key();
    const res = interaction.tryInteract();
    if (res && res.ok) {
      sfx.ok();
      tutorial.acted = true;   // 第 2 步引导的完成条件
      if (res.amount !== undefined) {
        // Bug⑤ 现场之一：`res.amount` 未格式化时是 ¥14.850000000000001
        toast(`成交 ${fmtYuanSigned(res.amount)} ${res.sku?.emoji ?? ''}`, 'ok');
      } else if (res.put !== undefined) {
        // 2026-10-06 上货动画升级：逐件放入 + 逐件音效（每件轻 tick，完成确认音）
        state.placed += res.put || 0;   // 任务板指标（块4）：上架件数
        world.pulseSlot?.(res.slotIndex ?? 0, res.put);
        const steps = Math.max(1, Math.min(8, Math.round(8 * res.put / 24)));
        for (let i = 1; i <= steps; i++) setTimeout(() => sfx.tick(), i * 110);
        setTimeout(() => sfx.done('stock'), steps * 110 + 80);
        toast(`已上架 ${res.sku?.emoji ?? ''}×${res.put}`, 'ok');
      } else if (res.clearance) {
        /* 2026-10-05 临期货清仓：半价清掉今夜到期的货
         * 2026-10-06 块3：加撕标签音（清仓的动作语义是"撕下来贴价签"，不是"收钱"）。
         * tearTag 与 coin 叠在一起：撕 → 收钱，两个动作各有各的声音。 */
        sfx.tearTag();
        sfx.coin();
        /* 格子变暗再清空（块3）：0.28s 压暗+下沉，之后真清空。
         * 注意这是**表现层补一段**，逻辑上货在 clearanceSell 返回时就已经没了 ——
         * 动画期间 slotCache 被强制清空，动画结束会由 updateSlotVisual 重绘空架态。 */
        state.cleared += 1;              // 任务板指标（块4）：清仓格数
        world.fadeOutSlot?.(res.slotIndex ?? -1);
        toast(`清仓 ${res.sku?.emoji ?? ''}×${res.qty} · 得 ${fmtYuan(res.amount)}`, 'ok');
      } else if (res.returned) {
        toast(`已放回库存箱 ${res.sku?.emoji ?? ''}×${res.qty}`, 'ok');
      } else if (res.qty !== undefined) {
        toast(`取货 ${res.sku?.emoji ?? ''}×${res.qty}`, 'ok');
      } else if (res.satiety !== undefined) {
        toast(`🥟 宵夜下肚 · 饱食 +${res.satiety}`, 'ok');
      } else if (res.drunk !== undefined) {
        toast(res.drunk ? '🍺 劝离成功 · 口碑 +2' : '😵 劝离失败 · 口碑 −5', res.drunk ? 'ok' : 'bad');
      }
    } else if (res && !res.ok) {
      sfx.bad();
      toast(res.reason ?? '无法执行', 'bad');
    }
  }

  if (e.code === 'Tab') {
    e.preventDefault();
    if (state.phase !== 'running') return;
    tutorial.shopped = true;   // 第 3 步引导的完成条件：打开过一次商店
    state.paused = true;
    if (document.exitPointerLock) document.exitPointerLock();
    // 需求I ①③④⑦ + 需求J：经营面板（进货 / 商店 / 店员 / 仓库 / 定价 / 二手 / 代币兑换 / 代币扭蛋）
    // ⚠ 这里是 Tab 键的**真实入口**，与 hud 面板里的 panels.purchase 是两条独立调用路径 ——
    //   曾经只改了后者，结果 Tab 打开的商店看不到「代币兑换」分页（探针抓到的真 bug）。
    openPurchase(() => {
      if (state.phase === 'running') {
        state.paused = false;
        player.requestLock();
      }
    }, purchase, shopApi(), staffApi(), warehouseApi(), growthApi(), secondhandApi, boonsApi(), deliveryUiApi);   // 块5
  }

  /* --- 需求J：R 打开仓库面板（与 Tab 的「仓库」分页同源） --- */
  if (e.code === 'KeyR') {
    e.preventDefault();
    if (state.phase !== 'running') return;
    state.paused = true;
    if (document.exitPointerLock) document.exitPointerLock();
    /* 2026-10-06 块5 修复：R 必须传完整的 openPurchase 参数（含 purchase=buy tab 前置、
     * deliveryUiApi=运输接口）。旧签名只传了 warehouseApi() → 面板只有「📦 仓库」tab，
     * 块5 的下单 UI（🛒 进货 tab）在桌面 R 键路径下根本进不去，运输闭环形同虚设。
     * 与下方 mobileControls 的 purchase: 动作、Tab 键的进货面板保持同一组参数。 */
    openPurchase(() => {
      if (state.phase === 'running') {
        state.paused = false;
        player.requestLock();
      }
    }, purchase, shopApi(), staffApi(), warehouseApi(), growthApi(), secondhandApi, boonsApi(), deliveryUiApi);
    return;
  }

  /* --- 需求I ③：背包（买道具 / 选中，选中后回场景按 E 使用） --- */
  if (e.code === 'KeyB') {
    e.preventDefault();
    if (state.phase !== 'running') return;
    state.paused = true;
    if (document.exitPointerLock) document.exitPointerLock();
    openInventory(inventory, () => {
      if (state.phase === 'running') {
        state.paused = false;
        player.requestLock();
      }
    });
    return;
  }

  /* --- 前台手机（按 O 打开）：点评 APP / 跑腿接单 / 消息箱（旧屏风格） --- */
  if (e.code === 'KeyO') {
    e.preventDefault();
    if (state.phase !== 'running') return;
    state.paused = true;
    if (document.exitPointerLock) document.exitPointerLock();
    openPhone(() => {
      if (state.phase === 'running') {
        state.paused = false;
        player.requestLock();
      }
    }, phoneApi);
    return;
  }

  /* --- 监控室（按 M 打开）：4 路监控小窗蹲小偷（打开时暂停，与所有 modal 一致；倒计时冻结） --- */
  if (e.code === 'KeyM') {
    e.preventDefault();
    if (state.phase !== 'running') return;
    state.paused = true;
    if (document.exitPointerLock) document.exitPointerLock();
    openMonitor(() => {
      if (state.phase === 'running') {
        state.paused = false;
        player.requestLock();
      }
    }, monitor);
    return;
  }

  // R4：本地排行榜（L）
  if (e.code === 'KeyL') {
    e.preventDefault();
    if (state.phase !== 'running') return;
    state.paused = true;
    if (document.exitPointerLock) document.exitPointerLock();
    openLeaderboard(leaderboardBoards(), () => {
      if (state.phase === 'running') {
        state.paused = false;
        player.requestLock();
      }
    });
  }
});

/* ---------- 事件调度（SYS-03 §2 / §4：RUSH / DRUNK / BLACKOUT / REGULAR） ----------
 * 每夜按各自概率在指定夜段排 0–2 个事件；到时由 step() 触发 triggerEvent。
 * 各事件参数 / 时段严格取自 config.EVENTS（§8.1），不在此硬编码平衡数。 */
let scheduledEvents = [];

function scheduleEvents() {
  scheduledEvents = [];
  const push = (type, atGameHour) => scheduledEvents.push({ type, at: atGameHour, done: false });

  // RUSH：晚高峰 S2–S4（gameHour 2..8），1 次
  if (Math.random() < EVENTS.RUSH.prob) {
    push('RUSH', 2 + Math.random() * 6);
  }
  // DRUNK：任意时段，0–1 次
  if (Math.random() < EVENTS.DRUNK.prob) {
    push('DRUNK', 0.5 + Math.random() * 7.0);
  }
  // BLACKOUT：任意时段，0–1 次
  if (Math.random() < EVENTS.BLACKOUT.prob) {
    push('BLACKOUT', 0.5 + Math.random() * 7.0);
  }
  // REGULAR：常客 S1–S3（0..6）；prob1 至少 1 次，prob2 再追加 1 次
  if (Math.random() < EVENTS.REGULAR.prob1) {
    push('REGULAR', Math.random() * 6);
    if (Math.random() < EVENTS.REGULAR.prob2) push('REGULAR', Math.random() * 6);
  }
  scheduledEvents.sort((a, b) => a.at - b.at);
}

function triggerEvent(type) {
  if (type === 'RUSH') {
    state.rushUntil = state.wallElapsed + EVENTS.RUSH.duration; // 90s
    state.rushActive = true;
    toast('🌙 晚高峰！客流激增 ×1.8', 'info');
  } else if (type === 'DRUNK') {
    const d = customers.spawnDrunk();
    if (d) toast('🍺 醉汉闹事！[E] 劝离', 'bad');
  } else if (type === 'BLACKOUT') {
    state.blackoutUntil = state.wallElapsed + EVENTS.BLACKOUT.duration; // 25s
    // §4.5：停电 onset 心理 −3（一次性，避免长夜累积过猛）
    if (state.clerk) {
      state.clerk.mental = Math.max(0, Math.min(100, state.clerk.mental + EVENTS.BLACKOUT.mentalOnset));
    }
    toast('⚡ 停电！约 25 秒内无法结账', 'bad');
  } else if (type === 'REGULAR') {
    const c = customers.spawnRegular();
    if (c) toast(`⭐ 常客来了（要 ${c.skuId} ×${c.qty}）`, 'ok');
  }
  notify();
}

/* ---------- 夜流程 ---------- */

/**
 * 情绪音效的差分基准（需求 2：顾客满意"叮咚" / 不满"嘟"）。
 * 为什么用累计计数做差分而不是在结算处直接放音：
 *   1) 结算逻辑（customers / economy）是纯逻辑模块，不该反向依赖音频（ADR-002）；
 *   2) 同一帧可能成交/失销多笔，直接放音会连响多声，这里只在"计数较上一帧有增长"时响一次。
 * 每夜 startNight() 时对齐到当前值，避免把上一夜的累计量当成"这一夜新增"多响一声。
 */
let lastServedCount = 0;
let lastLostCount = 0;

/** 本夜触发过的突发事件次数（结算里单列一行） */
let incidentCount = 0;
/** 周末狂欢夜的"超大客流高峰"只播报一次 */
let surgeAnnounced = false;

/** 点唱机带来的全场停留加成（没买 / 没切换 = 1） */
function jukeboxStayMul() {
  const s = (MINIGAME.jukebox?.styles ?? []).find((x) => x.id === state.jukeboxStyle);
  return s?.stayMul ?? 1;
}

/**
 * 弹出抉择事件（暂停级：夜时钟停住，选完恢复）。
 * 为什么必须暂停：不暂停的话玩家读题的十几秒里顾客会照常流失，
 * 那就不是"抉择"而是"惩罚读字慢"。
 */
function openChoiceNow(choice) {
  if (isModalOpen() || isMinigameOpen()) return;
  state.paused = true;
  if (document.exitPointerLock) document.exitPointerLock();
  openChoice(choice, (optId) => {
    const r = choices.resolve(choice.id, optId);
    if (r?.text) toast(r.text, 'info', 4800);
    state.paused = false;
    if (state.phase === 'running') player.requestLock();
    notify();
  });
}

/** 读档 / 开局后按当前星级把已解锁的机器与装修补回场景 */
function syncStars() {
  for (const u of unlocksUpTo(stars.level())) {
    const facs = world.applyStarUnlock(u) ?? [];
    registerFacilities(facs);
    const ids = facs.map((f) => f.id);
    if (ids.length) worldState.registerDevices(ids);
  }
}

function startNight() {
  resetForNewNight();
  /* --- 代币出口：过期限时券清理 + 永久「每夜启动资金 +¥100」 --- */
  // 清理必须在 themes.rollForNight 之前：本夜生效的券 expireNight === night，
  // 而 state.night 已由 resetForNewNight 翻到新的一夜，此时 prune 掉的正是"昨夜到期"的。
  const pruned = pruneBuffCards(state);
  const cashBonus = startCashBonus(state);
  if (cashBonus > 0) {
    state.cash += cashBonus;
    toast(`💵 每夜启动资金 +${fmtYuan(cashBonus)}`, 'ok', 2600);
  }
  /* --- 成长线扩展：翻主题页 → 应用客流/垃圾/故障 → 排抉择与环境 --- */
  themes.rollForNight();     // 把"明夜（已定死）"翻成"今晚"，再摇出新的明晚
  // 模块 4 ①：本夜小偷排程；②：本夜二手挂牌（都在 running 段由 step 推进 / 结算产收益）
  monitor.rollForNight();
  secondhand.rollListings();
  // 模块 4 ④：提前一夜预告节日限定夜（rollForNight 后 themeNextId 已是"明晚"）
  if (isFestival(state.themeNextId)) {
    const t = THEME_BY_ID[state.themeNextId];
    if (t) toast(`📅 预告：明晚是「${t.emoji} ${t.name}」！`, 'info', 4200);
  }
  /* 2026-10-05 C 方案：节日限定礼盒 —— 节日夜自动到货 8 件，仅今夜可售可进
   * （非节日夜 availableSkus 过滤掉，卖剩的次夜按保质期 1 夜自动报废） */
  /* 任务板（块4）：每晚发牌。放在 startNight 而不是第一帧 update ——
   * 开局就有单可接，玩家才知道"任务板"这个系统在等他。 */
  taskboard.dealNight({
    served: state.served,
    servedBento: state.servedBento,
    cleaned: worldState.stats.cleaned,
  });

  if (isFestival(state.themeId)) {
    state.backroom.festival = (state.backroom.festival | 0) + 8;
    toast('🎁 节日礼盒到货 ×8 · 仅今夜可售', 'info', 3600);
    sfx.giftArrived();          // 2026-10-06 块3：开箱到货音
  }
  const e = themes.effects();
  worldState.setThemeModifiers({ litterMul: e.litterMul, breakMul: e.breakMul });
  choices.applyPendingNight();   // 上一夜延后的后果（如"次日被认出"）
  choices.planForNight();
  ambient.planForNight();
  world.setTvProgram?.(ambient.tvProgram());
  // 客流：主题倍率 × 网红 buff（雨夜减半、促销夜翻倍、周末中段还有超大高峰）
  state.arrivalsTarget = Math.max(4, Math.round(state.arrivalsTarget * themeArrivalMul()));
  incidentCount = 0;
  customers.resetForNight();
  // 雨夜：老主顾必到（放在 resetForNight 之后 —— 那一步会清场）
  if (e.regularsGuaranteed) customers.spawnRegular();
  // 需求G：环境也按夜重置（清垃圾、恢复洁净度、按规范修好设备）
  worldState.resetForNight();
  npcs.resetForNight();
  syncWorldVisuals();
  scheduleEvents();
  state.segmentLabel = '';
  // 情绪差分基准要跟着新一夜清零，否则上一夜的成交数会被当成"这一夜新增"多响一声
  lastServedCount = state.served;
  lastLostCount = state.lostSales;
  // 手机点评差分基线同样对齐到新一夜的 0，否则上一夜累计会被当成"这一夜新增"
  phone.reset();
  notify();
  // P1-4：这里原来会在未锁定时弹一条 6 秒的操作说明 toast。
  // 那是开发期的"指针锁定警告"，玩家每开一夜就被糊一脸；已移除。
  // 现在只在**真正拖拽环视**时的首次给一次右下角一次性提示（见 showLockHintOnce）。
  player.requestLock();
}

function endNight() {
  /* 1) 临期货：打烊时未售完的部分报废（必须在 settleNight 之前 —— 它会改库存与账本） */
  const expiring = choices.settleExpiring((id) => state.backroom[id] ?? 0);
  if (expiring && expiring.left > 0) {
    ledger.set('choice.supplier.loss', `临期货报废 · 剩 ${expiring.left} 件`, -expiring.loss, 'choice');
  }

  /* 2) 核心结算（economy 不认识成长线模块，扩展段由 setSettleExtras 注入） */
  const report = settleNight();
  // 模块 4 ②：二手设备过夜被动收益（叠加在既有 tokens 上；onEvent 弹字幕）
  secondhand.nightlyIncome();
  const th = themes.current();
  report.theme = { id: th.id, name: th.name, emoji: th.emoji, desc: th.desc };
  report.tips = Math.round(state.tips ?? 0);
  report.litter = worldState.litter?.length ?? 0;
  report.incidents = incidentCount;
  report.expiring = expiring && expiring.left > 0 ? expiring : null;
  report.ledger = ledger.entries();
  /* 2026-10-06 块2：口碑档位 + 忠诚度榜单。
   * ⚠ 必须在这里也赋一遍 —— 上面 endNight 是**手工**把 settleExtras 的字段
   * 重新写进 report 的（theme/tips/litter/incidents/ledger 都在这儿再赋一次），
   * 也就是说 settleExtras 注入的那份在 endNight 路径上会被覆盖掉。
   * 两处都写是既有结构决定的（startNight/其他路径走 settleExtras），
   * 漏了这里结算面板就没有口碑可视化。 */
  /* 任务板（块4）：任务收入占比自检。需求要 20~30%，超了就在结算面板
   * 明确写出来 —— 而不是让玩家自己某天发现"光做任务就顶大半天营收"。
   * 占比只在有任务收入时才算（分母为 0 时无意义）。 */
  {
    const tbIncome = state.taskboardIncome | 0;
    const base = Number.isFinite(report.revenue) ? report.revenue : 0;
    const ratio = base > 0 ? tbIncome / base : 0;
    const [lo, hi] = TASKBOARD.taskIncomeCapPct;
    report.taskboard = {
      income: tbIncome,
      ratio,
      inRange: tbIncome > 0 ? (ratio >= lo && ratio <= hi) : true,
      lo, hi,
    };
  }
  /* 占比算完立刻清零本夜任务收入。⚠ 顺序很要紧：必须在上面 report.taskboard
   * 读 state.taskboardIncome **之后**清 —— 早一步清就恒为 0（占比永远算 0）。 */
  taskboard.settleNight();
  report.wom = regulars.wordOfMouthOf();
  report.loyalty = regulars.snapshot().loyal;

  /* 3) 星级判定（需要在 report 出来之后 —— 它读营业额与满意度） */
  const starRes = stars.evaluate(report);
  const lv = stars.level();
  report.star = {
    level: lv,
    streak: stars.streak,
    need: 3,
    leveled: starRes.leveled,
    targets: stars.targets,
    unlocked: starRes.leveled ? unlocksAt(lv).map((u) => u.name) : [],
  };

  /* 4) 成就（以结算数据为准的几个） */
  achievements.note('settle', {
    revenue: report.revenue,
    netProfit: report.netProfit,
    reputation: report.reputation,
    served: report.served,
    lostSales: report.lostSales,
  });
  if (starRes.leveled) achievements.note('star', { level: lv });

  state.paused = true;
  if (document.exitPointerLock) document.exitPointerLock();
  /* 2026-10-06 块3：结算入账的累积音。
   * 步数按**本夜净利**分档（不是总资产 —— 总资产是累计值，第一夜和第七夜都很大，
   * 那样"这夜赚得多"就听不出来了）。分档而非线性：
   * 亏本（<=0）给 1 声闷响之外的短音，盈利越高步数越多（sfx.cashIn 内部封顶 8）。 */
  {
    const profit = Number.isFinite(report.netProfit) ? report.netProfit : 0;
    const steps = profit <= 0 ? 1 : Math.max(1, Math.min(8, Math.ceil(profit / 60)));
    sfx.cashIn(steps);
  }
  if (state.phase === 'weekEnd') {
    openWeekEnd(state.weekPassed === true, () => {
      resetGame();
      startNight();
    });
  } else {
    openSettle(report, () => {
      nextNight();
      startNight();
    }, UPGRADES, buyUpgrade);
  }
  toast(`第 ${report.night} 夜结束 · 净利 ${fmtYuan(report.netProfit)}`, report.netProfit >= 0 ? 'ok' : 'bad');
}

/* ---------- 暂停菜单（含退出键，手感 4：0.15s 淡入淡出，不再硬切） ----------
 * ⚠ 隐形拦截器（2026-10-03 真机事故根因之一）：
 *   暂停层隐藏靠 `opacity:0` + `pointer-events:none`，但**子元素上的 inline
 *   pointer-events:auto 会把祖先的 none 顶掉**，于是面板区域变成一块看不见的挡板——
 *   手机上点「知道了，直接进入」、点摇杆全被它吃掉，`visible` / `opacity` 都看不出问题，
 *   只有 `document.elementsFromPoint()` 才能抓到。
 *   铁律：**半透明/透明的覆盖层，隐藏必须用 `visibility:hidden`（或 display:none），
 *   光靠 opacity + pointer-events 挡不住。** */
const pauseEl = document.createElement('div');
pauseEl.style.cssText = `position:fixed;inset:0;z-index:50;display:flex;
  align-items:center;justify-content:center;background:rgba(12,15,22,.55);
  color:#E6E2D6;font:600 18px/1.6 system-ui,"Segoe UI",sans-serif;
  opacity:0;visibility:hidden;pointer-events:none;transition:opacity .15s ease,visibility 0s linear .15s;`;
pauseEl.innerHTML = `<div style="text-align:center;padding:24px 28px;border-radius:14px;
    background:rgba(35,42,56,.92);border:1px solid #3A4457;pointer-events:auto;
    backdrop-filter:blur(16px) saturate(1.3);-webkit-backdrop-filter:blur(16px) saturate(1.3)">
    <div style="font-size:22px;margin-bottom:8px">⏸ 已暂停</div>
    <div style="font-weight:400;opacity:.85">点击画面锁定鼠标继续 · 或按 Esc</div>
    <div style="font-weight:400;opacity:.62;margin-top:12px;font-size:14px">
      WASD 移动 · 鼠标转视角 · E 交互 · Tab 采购 · B 背包 · R 仓库 · L 排行 · Shift 小跑 · F5 存档 · F9 读档
    </div>
    <div style="margin-top:16px;display:flex;gap:10px;justify-content:center">
      <button data-act="resume" style="padding:9px 18px;border-radius:10px;cursor:pointer;
        border:1px solid #E8A94E;background:#E8A94E;color:#232A38;font-weight:700;font-size:14px">继续营业</button>
      <button data-act="ach" style="padding:9px 18px;border-radius:10px;cursor:pointer;
        border:1px solid #465468;background:rgba(28,34,47,.85);color:#E6E2D6;font-weight:600;font-size:14px">🏆 成就</button>
      <button data-act="settings" style="padding:9px 18px;border-radius:10px;cursor:pointer;
        border:1px solid #465468;background:rgba(28,34,47,.85);color:#E6E2D6;font-weight:600;font-size:14px">⚙ 设置</button>
      <button data-act="quit" style="padding:9px 18px;border-radius:10px;cursor:pointer;
        border:1px solid #465468;background:rgba(28,34,47,.85);color:#E6E2D6;font-weight:600;font-size:14px">退出到标题</button>
    </div>
  </div>`;
document.body.appendChild(pauseEl);
pauseEl.querySelector('[data-act="resume"]').addEventListener('click', () => {
  state.paused = false;
  player.requestLock();
});
/* 设置页是普通模态（isModalOpen() 会让暂停层自动隐藏），关掉后自然回到暂停菜单。
 * 游戏保持暂停 —— 调完设置接着玩，不该被迫重新开始这一夜。 */
pauseEl.querySelector('[data-act="settings"]').addEventListener('click', () => {
  // 第 2/3 参：把重开入口挂进设置面板。onDone 在重开成功后跑 ——
  // 此时 applyAccountReset 已经清完并开好新的一夜，这里只负责把控制权还给玩家。
  openSettings(
    () => { /* 关闭后停在暂停菜单即可 */ },
    reset,
    () => {
      if (document.exitPointerLock) document.exitPointerLock();
      toast('重开完成 · 从第一夜重新开始', 'ok', 3200);
      player.requestLock();
    },
  );
});
/* 成就页同理：Esc 菜单的新页签，关掉回到暂停菜单 */
pauseEl.querySelector('[data-act="ach"]').addEventListener('click', () => {
  openAchievements(achievements, () => { /* 关闭后停在暂停菜单即可 */ });
});
pauseEl.querySelector('[data-act="quit"]').addEventListener('click', () => quitToTitle());

/**
 * 退出到标题（"游戏的退出键"）。
 * 先自动存一次档，玩家回到标题后仍可用 F9 / 自动读档把这一夜接回来，
 * 不至于因为"想退一下"就丢掉整夜进度。
 */
function quitToTitle() {
  mobileControls?.exitGame?.();   // 触屏：释放全屏 / 锁屏，隐藏控件
  if (isMinigameOpen()) closeMinigame();
  try { save.save(); } catch { /* 存不上也不该拦住退出 */ }
  state.paused = true;
  state.minigameId = null;
  if (document.exitPointerLock) document.exitPointerLock();
  sfx.load();
  toast('已退出到标题 · 进度已自动存档（F9 可读回）', 'info', 3200);
  openStart(() => { state.paused = false; startNight(); });
}

function syncPauseLayer() {
  const paused = state.paused && state.phase === 'running' && !isModalOpen();
  // 手感 4：用 opacity 过渡实现 0.15s 淡入淡出（display 硬切没有过渡）。
  // visibility 与 opacity 同步：隐藏时必须 visibility:hidden，否则子元素的
  // pointer-events:auto 会让这块看不见的面板继续吃掉点击（见 pauseEl 注释）。
  pauseEl.style.opacity = paused ? '1' : '0';
  pauseEl.style.visibility = paused ? 'visible' : 'hidden';
  pauseEl.style.pointerEvents = paused ? 'auto' : 'none';
  // P1-4：原来这里常驻一个"点击画面锁定鼠标"胶囊（未锁定就挂在屏幕中央下方）。
  // 它属于指针锁定警告，已整体移除；未锁定时改为**按住左键拖拽环视**（手感 1），
  // 并且只在第一次拖拽时给一次右下角一次性提示。
}

/* ---------- F3 诊断面板：交互打不中时用它定位 ---------- */
let debugOn = false;
const dbgEl = document.createElement('pre');
dbgEl.style.cssText = `position:fixed;left:12px;top:12px;z-index:70;display:none;margin:0;
  padding:10px 12px;border-radius:10px;background:rgba(12,15,22,.92);border:1px solid #3A4457;
  color:#9FE8C4;font:12px/1.6 ui-monospace,Consolas,monospace;white-space:pre;`;
document.body.appendChild(dbgEl);

function syncDebug() {
  if (!debugOn) return;
  const d = interaction.debugInfo();
  dbgEl.textContent =
    `phase=${d.phase}  paused=${d.paused}\n` +
    `最近目标: ${d.nearest ? `${d.nearest.name} · ${d.nearest.dist.toFixed(2)}m` : '无'}\n` +
    `hover: ${d.hover ? `${d.hover.type} / ${d.hover.ok ? '可执行' : '不可执行'} · ${d.hover.prompt}` : '无'}\n` +
    `位置: (${player.position.x.toFixed(2)}, ${player.position.y.toFixed(2)})  手持: ${state.held ? `${state.held.skuId}×${state.held.qty}` : '空'}\n` +
    `（F3 关闭）`;
}

/* ---------- 崩溃兜底：任何一处抛异常都不该让整页静止 ---------- */
let fatalShown = false;
function showFatal(err) {
  if (fatalShown) return;
  fatalShown = true;
  const box = document.createElement('div');
  box.style.cssText = `position:fixed;left:16px;bottom:16px;z-index:9999;max-width:60ch;
    padding:12px 14px;border-radius:10px;background:#3A1F22;color:#F08A8A;
    border:1px solid #EB5757;font:13px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;`;
  box.textContent = `运行异常（主循环已保活）：\n${err?.stack ?? err}`;
  document.body.appendChild(box);
}

/* ==================================================================
 * 可感知的反馈表现：状态灯 / 情绪图标 / 粒子 / 远处指引点
 *
 * 全部是**只读 state 派生出来**的表现数据（ADR-002）：不新增任何玩法字段、
 * 不改任何数值，只是把已经在跑的逻辑翻译成"看得见"的样子。
 * ================================================================== */

/** 停电中？（两个停电来源：需求I 的 powerOutUntil 与 SYS-03 的 blackoutUntil） */
function isBlackout() {
  const t = state.wallElapsed;
  return (state.powerOutUntil != null && t < state.powerOutUntil)
    || (state.blackoutUntil != null && t < state.blackoutUntil);
}

/**
 * 库存将尽的设备（售货机 / 娃娃机）—— 用于"黄灯慢闪"。
 * 判定口径刻意用**仓库货品阈值**而不是当夜补货量：后者每夜清零，
 * 会让所有售货机/娃娃机一开局就集体黄闪，把"异常提示"变成"常态噪声"。
 */
function lowStockFacilities() {
  const out = new Set();
  const snackLow = (state.warehouse.goods.snack | 0) < WAREHOUSE.goods.snack.threshold;
  const toyLow = (state.warehouse.goods.toy | 0) < WAREHOUSE.goods.toy.threshold;
  if (!snackLow && !toyLow) return out;
  for (const id of Object.keys(FACILITY_BY_ID)) {
    const f = FACILITY_BY_ID[id];
    if (f?.kind === 'vending' && snackLow) out.add(id);
    if (f?.kind === 'claw' && toyLow) out.add(id);
  }
  return out;
}

/** 设备表现同步的唯一入口（状态灯颜色 / 屏幕闪烁 / 等级灯带）。 */
function syncDevices() {
  if (typeof world.updateDeviceVisuals !== 'function') return;
  world.updateDeviceVisuals(worldState.deviceList(), state.deviceLevels, {
    now: state.wallElapsed,
    blackout: isBlackout(),
    lowStock: lowStockFacilities(),
  });
}

/** 头顶情绪图标：故障受阻 → 红"!"；干等 10s+ → 灰"…"；结账满意/不满 → 爱心/生气脸 */
function emotionList() {
  const out = [];
  for (const npc of npcs.items) {
    if (npc.machine === 'leaving' || npc.wantLeave) continue;
    const p = npc.mesh.position;
    const head = 1.72 * (npc.type?.look?.scale ?? 1) + 0.32;
    if ((npc.unhappyCount ?? 0) >= 1) out.push({ x: p.x, y: head, z: p.z, kind: 'alert' });
    else if ((npc.waitT ?? 0) >= 10) out.push({ x: p.x, y: head, z: p.z, kind: 'wait' });
  }
  for (const c of state.customers) {
    if (!c.mood || !(c.moodT > 0) || !c.mesh) continue;
    const p = c.mesh.position;
    out.push({ x: p.x, y: 2.04, z: p.z, kind: c.mood === 'happy' ? 'happy' : 'angry' });
  }
  return out;
}

/** 远处指引小圆点：坏机器（红）与缺货机器（黄）—— 避免在黑店里找不到它们 */
function beaconList() {
  const out = [];
  const low = lowStockFacilities();
  for (const d of worldState.deviceList()) {
    const f = FACILITY_BY_ID[d.id];
    if (!f) continue;
    if (d.broken) out.push({ x: f.x, y: 2.75, z: f.z, kind: 'broken' });
    else if (low.has(d.id)) out.push({ x: f.x, y: 2.6, z: f.z, kind: 'stock' });
  }
  return out;
}

/* ---------- 主循环 ---------- */
let last = performance.now();

/** Bloom 的基准强度：昼夜会在它之上做倍率（白天泛光减弱），别直接改 uniforms 的初值 */
const BLOOM_BASE = post.uniforms?.composite?.strength?.value ?? 0;

/** 娃娃机柜内娃娃数的脏检查缓存（-1 = 还没推过，首帧必然同步一次） */
let lastClawDolls = -1;

/** 促销是否在售（2026-10-06 块3：用于"促销结束音"的边沿检测，需跨帧持久故在模块级） */
let promoWasOn = false;

function step(now) {
  const dt = Math.min((now - last) / 1000, 0.05); // dt 上限钳制（ADR-003）
  last = now;

  // 昼夜状态每帧都要取：即使暂停，光照也要保持在上一次的值（暂停时画面不能变黑）
  const dn = dayNight.state();

  if (!state.paused && state.phase === 'running') {
    state.wallElapsed += dt;
    state.gameHour = (state.wallElapsed / NIGHT_SECONDS) * GAME_HOURS;

    /* --- 需求G 环境推进：昼夜 → 经营环境（故障/垃圾）→ 顾客 NPC --- */
    dayNight.update(dt);
    // 需求I ⑥：停电期间设备暂停产出（已有故障继续走停摆倒计时，但不再累积新故障）
    const devicesPaused = state.powerOutUntil != null && state.wallElapsed < state.powerOutUntil;
    worldState.update(dt, {
      scatterLitter,
      // 玩家正在玩的那台不让它在手里坏掉（体验上非常糟）
      deviceActive: (id) => state.minigameId === id,
      devicesPaused,
    });
    // 需求I ③：人气海报在生效期内加成客流
    let traffic = worldState.trafficMul() * dn.traffic;
    if (state.posterUntil != null && state.wallElapsed < state.posterUntil) {
      traffic *= (CONSUMABLE_BY_ID.poster?.trafficMul ?? 1);
    }
    /* 周末狂欢夜：中段 2 小时的"超大客流高峰"（主题效果在结算里单列） */
    const sw = themes.surgeWindow();
    if (sw && state.gameHour >= sw.from && state.gameHour < sw.to) {
      traffic *= sw.mul;
      if (!surgeAnnounced) {
        surgeAnnounced = true;
        toast('🎉 超大客流高峰！店内忽然挤满了人', 'info', 3600);
      }
    }
    npcs.update(dt, {
      trafficMul: traffic,
      incomeMul: dn.income,
      // 点唱机：全场顾客停留时间 +15%（纯氛围机的价值所在）
      stayMul: jukeboxStayMul(),
      // 需求I ⑥：停电时 NPC 不开始新游玩（走到机器前也玩不了）
      canPlay: !devicesPaused,
    });

    /* --- 需求I ②：限时任务推进（进度 = 当前累计 − 生成时 baseline，零埋点） --- */
    quests.update(dt, {
      served: state.served,
      repaired: worldState.stats.repaired,
      cleaned: worldState.stats.cleaned,
      earned: state.earned,
      now: state.wallElapsed,
    });

    /* --- 进货运输（块5）：在途单到点转成门口货箱。
     * 时间源用 state.wallElapsed（玩家实际经历的游戏秒）而不是墙钟：
     * 需求说"45 秒"指的是**玩家能感觉到的那 45 秒**，
     * 暂停时不走 —— 所以它必须跟着 state.paused 一起停。 */
    delivery.update(state.wallElapsed);
    /* 货箱模型显隐跟着逻辑状态走：门口有几个箱子就显示几个。
     * 放这里（而不是在 onEvent 里）是因为 update 可能因"箱子满"把货退回在途，
     * 那时 crates 数量会变 —— 事件驱动会漏掉这种"没有事件但数量变了"的情况。 */
    world.setDeliveryCrates?.(delivery.panel().crates.length);

    /* --- 任务板（块4）：进度/冷却/到期。与 quests 并行推进，互不干扰 --- */
    taskboard.update(dt, {
      served: state.served,
      servedBento: state.servedBento,
      soldDrinkPromo: state.soldDrinkPromo,
      promoActive: pricing.promoActive(),
      cleaned: worldState.stats.cleaned,
      placed: state.placed,
      cleared: state.cleared,
    });

    /* --- 需求I ⑥：随机突发事件推进（停电/大故障/客流高峰） --- */
    incidents.update(dt, { now: state.wallElapsed, activeDevice: () => state.minigameId });

    // 需求H：自动存档（按**游戏秒**计时，暂停/小游戏中不累计）
    save.tick(dt);

    // 到时触发本夜排定的事件（RUSH / DRUNK / BLACKOUT / REGULAR）
    for (const ev of scheduledEvents) {
      if (!ev.done && state.gameHour >= ev.at) {
        ev.done = true;
        triggerEvent(ev.type);
      }
    }
    if (state.rushUntil !== null && state.wallElapsed > state.rushUntil) {
      state.rushActive = false;
      state.rushUntil = null;
    }
    const seg = currentSegment();
    state.segmentLabel = `${seg.id} ${seg.label}${state.rushActive ? ' · 晚高峰' : ''}`;

    /* --- 成长线推进：抉择 / 环境互动 / 促销计时 --- */
    const cd = choices.due(state.gameHour);
    if (cd) openChoiceNow(cd);
    ambient.update(state.gameHour, state.wallElapsed);
    ambient.tick(state.wallElapsed);
    choices.tick(state.wallElapsed);
    if (pricing.tick(state.wallElapsed)) toast('🏷 限时促销结束', 'info', 2200);

    /* --- 疲劳系统：随游戏时间累积，凌晨 3–5 点加速；表现事件在此翻译 --- */
    const fev = fatigue.update(dt, state.gameHour);
    for (const ev of fev) {
      if (ev.type === 'yawn') toast('🥱 你打了个哈欠…', 'info', 2200);
      else if (ev.type === 'level') {
        if (ev.level === 2) toast('😮‍💨 眼皮有点沉，操作开始飘了', 'bad', 2600);
        else if (ev.level === 3) toast('😴 快撑不住了…找个地方提提神', 'bad', 3000);
      } else if (ev.type === 'wake') toast('你猛地醒了过来', 'info', 1600);
    }
    /* 重度且持续未处理 → 强制打瞌睡（期间玩家不能操作，但夜时钟照走） */
    if (fatigue.level() >= 3 && !fatigue.isDozing() && fatigue.effects().fatigue >= FATIGUE.heavyAt + 2) {
      fatigue.doze();
      toast('😴 你扛不住，打起了瞌睡…（5 秒）', 'bad', 3200);
    }

    customers.update(dt);

    /* --- 模块 4 ①：监控蹲小偷推进（仅 running 段；面板打开暂停时倒计时自然冻结） --- */
    monitor.update(dt, { gameHour: state.gameHour });

    /* --- 前台手机：点评生成（served/lostSales 差分）+ 跑腿倒计时 + 补救任务推进 --- */
    phone.update(dt, { served: state.served, lostSales: state.lostSales });
  }

  /* 横幅与角标是表现层，暂停时也要保持/收起（否则暂停期间横幅会僵在屏幕上） */
  /* 2026-10-06 块3：促销结束音。这里用"上一帧是否在促销"做边沿检测 ——
   * 促销结束不是某个函数调用触发的（它只是时间走完），所以不能在 startPromo
   * 里成对处理；每帧比对 active 的跃迁是唯一可靠的捕获点。
   * 只在 true→false 的那一帧响一次，否则会每秒播一遍（每帧都算"结束"）。 */
  const promoOn = pricing.promoActive();
  if (promoWasOn && !promoOn) sfx.promoEnd();
  promoWasOn = promoOn;
  showPromoBanner(promoOn, pricing.promoRemaining());
  setSatBonus(ambient.satisfactionBonus());

  /* --- 表现同步：垃圾 / 设备状态灯 / 光照 --- */
  world.setLitter(worldState.litter);
  world.setGarbage(state.garbage);   // 块6：垃圾堆随 state.garbage 增减（含清理后归零）
  syncDevices();
  world.applyDayNight(dn);
  if (post.uniforms?.composite) {
    post.uniforms.composite.strength.value = BLOOM_BASE * dn.bloomStrength;
  }

  /* --- 疲劳表现：灵敏度衰减 / 准星飘 / 屏幕边缘变暗 ---
   * 暗角走 postfx 的 vignette，但**不覆盖设置里的暗角**：这里先算疲劳暗角，
   * 与设置暗角叠加（两者语义不同、独立取值），在 applySettings 之后一起生效。 */
  const fe = fatigue.effects();
  player.setFatigue(fe.sensMul, fe.sway);
  if (typeof post.setGrade === 'function') {
    post.setGrade({ vignette: Math.max(settings.vignette, fe.vignette) });
  }
  /* 打瞌睡期间锁操作：暂停玩家输入（但夜时钟照走）—— 表现是"短暂失去控制" */
  if (fatigue.isDozing()) {
    player.setFatigue(0.2, 0); // 彻底脱手：灵敏度压到极低，不注入飘（人已经睡着了）
  }

  /* --- 音频：BGM 随昼夜/停电/高峰自动切换（需求 1） ---
   * 只在真正营业时推进；暂停 / 小游戏中压到半音量（soft），免得盖住游戏音效。 */
  sfx.updateBgm(dt, {
    night: (dn.nightAmount ?? 0) >= 0.5,
    blackout: isBlackout(),
    rush: state.rushActive === true || incidents.status()?.surge === true,
    soft: state.paused || isMinigameOpen(),
  });

  /* --- 顾客情绪的听觉反馈（需求 2：满意"叮咚"/不满"嘟"） ---
   * 用累计计数做差分：成交与失销都只 +1，不会因为同帧多笔而重复播放。 */
  if (state.served > lastServedCount) { sfx.satisfied(); lastServedCount = state.served; }
  if (state.lostSales > lastLostCount) { sfx.upset(); lastLostCount = state.lostSales; }

  player.update(dt);
  // R1：每帧按 dt 更新店员四状态（移动/动作/时间驱动），取 player 本帧位移与贴墙状态
  if (!state.paused && state.phase === 'running') updateClerk(state, dt, player);
  // 需求J：店员 AI（维修/清洁/采购/上货 + 薪资计时），与店员四状态互不干扰
  if (!state.paused && state.phase === 'running') staff.update(dt, { now: state.wallElapsed });
  interaction.update();
  world.updateSlotVisual(state);
  world.updateHands(state);
  /* P1-7：地面霓虹导视箭头只在新手期（第 1 夜前 3 分钟）显示，之后永久隐藏 */
  if (typeof world.setGuideVisible === 'function') {
    world.setGuideVisible(state.night === 1 && state.wallElapsed < 180);
  }
  /* P1-5 / P2-10：机器与货架的悬浮标签按"对准 + 距离"过滤，
     只显示准星当前指向或 1m 内最近的那一个，按距离淡入淡出，超距隐藏。 */
  if (typeof world.updateLabels === 'function') world.updateLabels(state);
  /* P0-4：娃娃机玻璃柜的娃娃数（有货摆满 / 见底挂补货提示）。脏检查 —— 每帧都刷会白跑遍历。 */
  if (typeof world.setClawCabinet === 'function') {
    const dolls = state.deviceStock?.claw | 0;
    if (dolls !== lastClawDolls) { lastClawDolls = dolls; world.setClawCabinet(dolls); }
  }
  if (typeof world.updateSnack === 'function') world.updateSnack(dt); // R2 摊主烹饪动画
  if (typeof world.updatePond === 'function') world.updatePond(dt); // 池塘涟漪 + 鱼浮动
  /* --- 可感知反馈：粒子推进 / 头顶情绪 / 远处指引点 --- */
  world.updateFeedback(dt);
  world.setEmotions(emotionList());
  world.setBeacons(beaconList());
  /* --- 新手引导（第 1 夜前 3 分钟，三步走完即消失） --- */
  updateTutorial();
  renderHud(envSnapshot());
  syncPauseLayer();
  syncDebug();
  // 后处理渲染（Bloom 不可用时 post 是直出替身，接口一致，无需分支）
  post.render(world.scene, world.camera);

  if (!state.paused && state.phase === 'running' && state.gameHour >= GAME_HOURS) {
    // 天亮时若还在玩设施：先收掉小游戏，否则结算面板会被盖在下面
    if (isMinigameOpen()) closeMinigame();
    endNight();
  }
}

function frame(now) {
  try {
    step(now);
  } catch (err) {
    // 不让异常断掉 rAF 链，否则整页静止表现为"卡死"
    console.error('[NIGHT SHIFT] frame error:', err);
    showFatal(err);
  }
  requestAnimationFrame(frame);
}

/* ---------- 启动（需求B：登录门 → 开始营业） ---------- */
const auth = createAuthService();
const net = createNetBridge(); // 需求C：联机预留，本阶段恒离线

/** 已登录的玩家身份（需求C 的"玩家身份"扩展点；联机后由服务端下发）。
 *  变量本身声明在 save 之前（存档键解析器要闭包引用它），这里只做赋值。 */
identity = auth.currentSession();

/* 旧版"全局存档"迁移：账号隔离后存档键变成 `…v1.<账号id>`，已经在旧键下存过档的
 * 玩家不能静默丢进度 —— 第一个登录的账号把旧档接过来（其它账号从零开始）。 */
if (identity) save.migrateLegacy();

/* ==================================================================
 * 账号重开（重置）
 *
 * 触发方式：Esc 暂停菜单 → ⚙ 设置 → ⚠ 账号 → 重开本账号 → 输确认词 + 密码
 *          （不设热键：不可逆动作不该有一次误触就能触发的入口）
 * 限制：同一账号 90 秒冷却 + 每日 3 次，按**本地自然日**计数；配额记在
 *      localStorage 的独立键里（不在游戏存档里，否则清档会顺手把上限也清了）
 * 范围：只清"这一局的进度"；账号密码 / 登录会话 / 玩家设置 / 别的账号的档都不动
 *      —— 清单是 reset.mjs 的 RESET_SCOPE，弹窗与这里读同一份，防止两边漂移
 * ================================================================== */
const reset = createResetService({
  getAccountId: () => identity?.accountId ?? null,
  isRegistered: (id) => auth.isRegistered(id),
  // 用"只验不建会话"的 verify：重开只是确认操作者身份，不该改变谁在登录
  verifyPassword: (id, pw) => auth.verify(id, pw),
  applyReset: ({ accountId }) => applyAccountReset(accountId),
  onEvent: (type, p) => {
    if (type === 'reset-done') toast(`⚠ 已重开 · 进度回到第一夜（今天第 ${p.resetsToday} 次）`, 'info', 3600);
    else if (type === 'reset-failed') toast(`重开失败：${p.message}`, 'bad', 3600);
  },
});

/**
 * 重开本账号：把进度清回初始状态。
 *
 * 清理顺序是刻意的，不能调换：
 *   1) **先清 3D 实体**（顾客 / NPC）—— 它们的 mesh 不在 state 里，而 resetGame()
 *      会把 state.customers 直接清空，之后再也拿不到那些 mesh 引用 → 场景里留下
 *      永远不会消失的"孤儿模型"。必须在 resetGame 之前把它们从场景摘掉。
 *   2) 再清盘上存档 —— 否则随后的自动存档会把"上一世的进度"又写回来
 *   3) 再清本账号的排行榜成绩（只清自己的条目，别人的成绩不动）
 *   4) 复位内存真源（state → baseState）与不在 state 里的子系统（3D 环境 / 昼夜 / 玩家坐标）
 *   5) 最后 startNight() —— 复用**正常开夜流程**，而不是自己拼一个"初始状态"
 *
 * 第 5 步是关键：重开后的第一夜必须和"新玩家第一次点开始营业"完全一致。
 * 手写一份初始化迟早会和 startNight 漂移（少排一次主题、少清一次垃圾）。
 */
function applyAccountReset(accountId) {
  customers.resetForNight();          // 1) 摘掉 3D 顾客（含 mesh）
  npcs.resetForNight();               //    NPC 自带内部列表，同样要摘 mesh
  save.clear();                       // 2)
  clearForAccount(accountId);         // 3)
  resetGame();                        // 4)
  worldState.resetAll();
  monitor.reset();
  dayNight.hydrate({ phase: 0, elapsed: 0 });   // 昼夜回到"夜里"起点
  player.setPosition(POS.spawn.x, POS.spawn.z);
  player.setLook(0, 0);
  syncWorldVisuals();                 // 垃圾 / 设备 / 装修 / 店员 marker 全部按初始重建
  startNight();                       // 5)
  mobileControls?.enterGame?.();      // 触屏：重开后进全屏 + 锁横屏
}

function beginGame() {
  sfx.startBgm();   // "开始营业"点击是用户手势，BGM 从这里起步（浏览器自动播放策略）
  openStart(() => {
    mobileControls?.enterGame?.();   // 触屏：进入全屏 + 锁横屏（在点击手势内调用）
    sfx.startBgm();
    startNight();
  });
}

/**
 * 需求H 第 6 条：开局第一次进入自动读取上次存档，没有存档则开新游戏。
 *
 * 判定"存档是否可用"不只看有没有，还要看它**能不能接着玩**：
 *   · phase 不是 running（存档停在结算界面）→ 没法续，走新游戏
 *   · 夜已走满（gameHour ≥ GAME_HOURS）→ 续上去立刻结算，体验很怪，同样走新游戏
 * 宁可让玩家开一局新的，也不要把他丢进一个"打开就弹结算"的状态里。
 */
function tryResumeFromSave() {
  const got = save.peek();
  if (!got.ok) return false;
  if (got.data?.state?.phase !== 'running') return false;
  if ((got.data?.state?.gameHour ?? 0) >= GAME_HOURS) return false;

  const res = save.load();
  if (!res.ok || res.applied.length === 0) return false;

  syncWorldVisuals();
  mobileControls?.enterGame?.();   // 触屏：进入全屏 + 锁横屏（此处无手势，best-effort，失败忽略）
  // 存档里可能是暂停态；读档后统一给一个"可以继续"的状态，
  // 指针锁定需要用户手势，这里不强锁，靠画面上的提示引导点击。
  state.paused = false;
  notify();
  saveToast('已读取存档', 'ok', 2600);
  toast(
    `读档成功 · 第 ${state.night} 夜 ${Math.floor(state.gameHour)}:00 · `
    + `金币 ${fmtYuan(state.cash)} · 代币 ${state.tokens} · 顾客 ${npcs.count} · 点击画面继续`,
    'ok', 4200,
  );
  return true;
}

/** 已登录后的统一入口：先尝试读档，失败才走"开始界面 → 新的一夜" */
function enterGame() {
  if (!tryResumeFromSave()) beginGame();
}

// 已登录（刷新页面）→ 直接进游戏；否则先过登录门
if (identity) {
  enterGame();
} else {
  openLogin(auth, (id) => {
    identity = id;
    const who = id?.displayName ?? '店员';
    toast(`欢迎回来 · ${who}`, 'ok', 2400);
    enterGame();
  });
}

/* 诊断出口：黑屏 / 画面异常时在控制台敲 `__NS.post.stats()` 就能看 后处理 是否退化、
   RT 尺寸和像素格式，不必改代码重跑一遍（postfx.mjs 文件头 ADR-005 的三个坑都记在这里）。
   音频同理：`__NS.sfx.stats()` 区分"没建起来 / suspended / 总线增益为 0"三种聋法。 */
window.__NS = {
  world, state, player, npcs, worldState, dayNight, save, post, staff, staffApi, warehouseApi,
  sfx, settings,
  /* 成长线扩展：探针要能直接驱动它们做端到端验收
   * （升级星级 → 场景补建机器；结算 → 看扩展段；抉择 → 弹窗）。 */
  themes, stars, achievements, choices, pricing, ambient, ledger, growthApi,
  /* 代币出口：兑换 / 扭蛋 / 限时券 / 主题情报（探针要能驱动做端到端验收） */
  boonsApi,
  /* 疲劳系统：探针驱动它做端到端验收 */
  fatigue,
  /* 前台手机：探针驱动点评/跑腿/补救做端到端验收 */
  phone,
  /* 模块 4：监控室 / 二手市场 / 常客 —— 探针走真实入口做端到端验收
   * customers 也一并暴露：常客"熟"标必须走 customers.spawn() 的真实到店路径，
   * 直接往 state.customers 塞假对象会被 customers.update 的 c.mesh.position 打爆。 */
  monitor, secondhand, regulars, customers,
  /* 账号重开（重置）：探针要能验"冷却 / 每日上限 / 密码校验 / 清档范围"整条链路 */
  reset, auth,
  // HUD 的几个"瞬间反馈"入口：验收探针要能真的触发一次绿勾/字幕，而不是只看节点在不在
  hud: {
    openSettings, showTutorial, hideTutorial, flashQuestDone, isModalOpen,
    openAchievements, openChoice, showThemeBanner, showPromoBanner,
  },
  /* 探针要走**真实入口**开机器，而不是自己 new 一个小游戏实例：
   * 那样会绕过投币、成就上报、排行榜这一整条链路，验收就没有意义了。 */
  openFacility, cycleJukebox,
  /* QTE：探针走真实入口触发维修/清洁/上货迷你挑战，再模拟交互完成并验证动作落地 */
  qte: { isOpen: isQteOpen, repair: openRepairQte, clean: openCleanQte, restock: openRestockQte },
};

requestAnimationFrame(frame);
