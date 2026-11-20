/**
 * localStorage 存档：货币、仓库、装备配置、统计
 */

import {
  ITEMS, START_CURRENCY, PLAYER, BAILOUT, REP, GRADE3D, WEAPONS, CAREER, HUB, AMMO_IDS,
} from './config.js';import { defaultUpgrades, normalizeUpgrades } from './upgrades.js';
import { normalizeLoadoutAmmo, loadoutAmmoBoxes, setAmmoBoxes, ammoBoxSize } from './ammo.js';
import {
  createInventory, createItem, autoPlace, countById, serializeInventory, deserializeInventory,
} from './inventory.js';

const KEY = 'soudache.save.v1';
// 存档顶层版本保持 1：改装树只是**新增字段**，旧档由 normalizeUpgrades 补成全未解锁即可读取，
// 不需要破坏性迁移。改装结构自身的版本记录在 save.upgrades.version，后续可独立演进。
const VERSION = 1;

/**
 * 局外生涯进度的默认结构（P10）。
 * 顶层版本仍为 1：老档没有这个字段时，loadSave 用这里的结构补齐即可读取。
 * 所有发奖标记都在这里预置，避免运行时才临时建对象导致旧档缺字段。
 * @returns {object} 生涯状态
 */
export function defaultCareer() {
  return {
    achievements: {}, // 已达成的成就 id
    claimed: {}, // 已领奖的成就 id（发钱幂等的唯一真值）
    counters: { bossDown: 0 }, // 累计型指标里不在 stats 里的那几项
    quests: { date: '', list: [], done: {}, claimed: {} },
    supply: { date: '', bought: {} }, // 当日已购数量，按本地日期重置
    orders: [], // 玩家个人的委托单（物品已从仓库取出，到期自动结算）
    repClaims: {}, // 已领取的声望补给等级
  };
}

/** 只保留结构合法的委托单，手改坏值不会让结算循环崩掉。 */
function validOrder(o) {
  return o && typeof o.key === 'string' && typeof o.id === 'string' && !!ITEMS[o.id]
    && Number.isFinite(Number(o.price)) && Number.isFinite(Number(o.settleAt));
}

/**
 * 归一化局外生涯进度：坏值、缺字段、超长数组一律收敛成合法结构。
 * 与 upgrades 走同一条纪律 —— 不信任存档原文，而不是直接展开。
 * @param {*} raw 存档里的原始值
 * @returns {object} 合法的生涯状态
 */
export function normalizeCareer(raw) {
  const base = defaultCareer();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const dict = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : {});
  const quests = dict(raw.quests);
  const supply = dict(raw.supply);
  const counters = dict(raw.counters);
  return {
    achievements: dict(raw.achievements),
    claimed: dict(raw.claimed),
    counters: { bossDown: Math.max(0, Number(counters.bossDown) || 0) },
    quests: {
      date: typeof quests.date === 'string' ? quests.date : '',
      list: Array.isArray(quests.list)
        ? quests.list.filter((id) => typeof id === 'string').slice(0, CAREER.quests.count) : [],
      done: dict(quests.done),
      claimed: dict(quests.claimed),
    },
    supply: {
      date: typeof supply.date === 'string' ? supply.date : '',
      bought: dict(supply.bought),
    },
    orders: Array.isArray(raw.orders)
      ? raw.orders.filter(validOrder).slice(0, CAREER.consign.maxOrders) : [],
    repClaims: dict(raw.repClaims),
  };
}

/**
 * 默认装备配置。
 * @returns {object} 装备配置
 */
export function defaultLoadout() {
  return {
    primary: 'rifle',
    // W2：副武器槽不再收手枪（手枪有独立槽位）。旧档的 `secondary:'pistol'`
    // 由 loadSave 迁移到 sidearm，见那里的注释。
    secondary: '',
    sidearm: 'pistol',
    melee: 'knife',
    backpack: 'none',
    rig: 'rig_lv1',
    armor: 'lv2',
    helmet: 'none',
    mods: { primary: {}, secondary: {} },
    // P7：弹药按「弹种」记盒数；旧档的 ammo556Boxes / ammo9mmBoxes 在 loadSave 里迁移。
    ammo: {
      ammo556: 2, ammo556ap: 0, ammo556sub: 0,
      ammo9mm: 1, ammo9mmap: 0, ammo9mmhp: 0,
      ammo762: 1, ammo762ap: 0, ammo762sub: 0,
      ammo12ga: 1, ammo12gabuck: 0, ammo12gaslug: 0,
    },
    ammoPrimary: 'ammo556',
    ammoSecondary: 'ammo9mm',
    medkits: 2,
    bandages: 1,
    surgeries: 0,
    armorKits: 0,
  };
}

/**
 * 初始仓库（新档赠送的基础装备）。
 * @returns {object} 仓库容器
 */
export function createStarterStash() {
  const inv = createInventory(PLAYER.stash.cols, PLAYER.stash.rows);
  autoPlace(inv, createItem(ITEMS.rifle));
  autoPlace(inv, createItem(ITEMS.pistol));
  autoPlace(inv, createItem(ITEMS.lv2));
  // 全部按弹种自己的每盒发数发（5.56/9mm/7.62 都是 60，12ga 是 24）——
  // 写 AMMO_STACK 只对前三种碰巧正确，第四种就是上一条注释里的坑。
  autoPlace(inv, createItem(ITEMS.ammo556, ammoBoxSize('ammo556')));
  autoPlace(inv, createItem(ITEMS.ammo556, ammoBoxSize('ammo556')));
  autoPlace(inv, createItem(ITEMS.ammo9mm, ammoBoxSize('ammo9mm')));
  // P15 修复：`defaultLoadout.ammo` 从 P13 起就预置了 7.62 / 12ga 各 1 盒，
  // 但起始仓库只发 5.56 / 9mm —— 新档第一次点「部署」会被 validateLoadout 拦下
  // （"7.62mm FMJ 数量超过仓库库存"），玩家必须先手动把盒数调成 0 才能进游戏。
  // 口径一旦预置就必须同时给弹，否则默认配置本身是自相矛盾的。
  autoPlace(inv, createItem(ITEMS.ammo762, ammoBoxSize('ammo762')));
  // ⚠ 12ga 一盒是 24 发（不是全局 AMMO_STACK=60），必须走 ammoBoxSize 换算。
  // 给 2 盒：霰弹单盒发数少，1 盒只够打几只怪，凑不出一次像样的首局。
  autoPlace(inv, createItem(ITEMS.ammo12ga, ammoBoxSize('ammo12ga') * 2));
  autoPlace(inv, createItem(ITEMS.medkit, 1));
  autoPlace(inv, createItem(ITEMS.medkit, 1));
  autoPlace(inv, createItem(ITEMS.bandage, 1));
  // W2：匕首 + 战术胸挂是"配发装备"，新档直接给，否则 8 槽位里有两格永远是空的。
  // 背包默认不带（`backpack:'none'`），但**发一个**入门背包 —— 不发的话这格的托盘里
  // 一件可拖的东西都没有，玩家会以为槽位坏了；带不带由他自己决定。
  autoPlace(inv, createItem(ITEMS.knife));
  autoPlace(inv, createItem(ITEMS.rig_lv1));
  autoPlace(inv, createItem(ITEMS.bp_lv1));
  return inv;
}

/**
 * 默认存档。
 * @returns {object} 存档对象
 */
export function defaultSave() {
  return {
    version: VERSION,
    currency: START_CURRENCY,
    stash: createStarterStash(),
    loadout: defaultLoadout(),
    stats: {
      raids: 0,
      extracts: 0,
      deaths: 0,
      kills: 0,
      bestScore: 0,
      bestValue: 0,
    },
    settings: {
      volume: 0.6,
      muted: false,
      invertMouseX: true, // 鼠标水平轴反转（按用户要求默认开启）
      invertY: false, // 视角 Y 轴反转（默认关闭=自然：手指/鼠标上滑→视角上；触屏"Y轴翻转"开关控制）
      fov: 75, // 第一人称视野（腰射 FOV），60~100 可调
      mouseSens: 1.0, // 鼠标灵敏度倍率，0.3~3 可调
      touchLookSens: 1.0, // 触屏右摇杆视角灵敏度倍率，0.6~2.4 可调
      aimAssist: true, // 轻度辅助瞄准（仅触屏/手柄体验增益，桌面也可关）
      touchButtonScale: 1.0, // 触控按钮尺寸倍率，0.8~1.3 可调（位置/大小可调需求）
      // P3 调色：新增字段走「缺字段即默认」的迁移策略 —— 旧档 settings 里没有 grade，
      // loadSave 的 settings 浅合并会用这里的默认值补齐，不需要升 VERSION。
      // 运行时再经 resolveGrade(save) 逐项钳制，手改坏值也不会把画面调成全黑。
      grade: {
        exposure: GRADE3D.exposure,
        contrast: GRADE3D.contrast,
        saturation: GRADE3D.saturation,
      },
    },
    layout: { touch: {} }, // 触控按钮布局偏移：{ [action]: { x, y } }（绝对像素，相对触屏控制容器）
    // 干员（P5）：只存 id，具体档案在 operators.js。未知 id 由 getOperator 回落默认，
    // 所以不需要在这里做白名单校验，也不会因为删掉某个干员就让旧档读不出来。
    operator: 'vulcan',
    // P15：风险分级。只存 id，参数表在 config.HUB.riskLevels。旧档没有该字段时
    // 由 loadSave 回落到 'routine'（不升 VERSION，缺字段即默认）。
    risk: 'routine',
    // P15：小队编成 —— 两名 AI 队友的干员 id。旧档没有该字段时按「除玩家外的前两名」
    // 补默认；未知 id 由 spawnSquad 侧过滤，不会因为删干员就读不出存档。
    squad: [],
    insurance: { enabled: false }, // 装备保险开关（战前付保费，失败时赔带入的武器与护甲）
    daily: { date: '', bestScore: 0, extracted: false }, // 每日突袭：当日种子与成绩
    codex: { seen: {}, brought: {} }, // 图鉴：seen=拾取过，brought=真正带出过
    rep: { xp: 0 }, // 军械商声望经验（等级由 xp 现算，见 repLevel）
    // E-05 安全箱档位：s1=2×2（现状默认），s2/s3 供后续成长解锁。旧档缺字段回落 s1。
    secureTier: 's1',
    // 局外改装树：三支等级（0 = 全未解锁）。迁移策略是"缺字段即全零"，而不是报错或重置整个存档。
    upgrades: defaultUpgrades(),
    // P10：局外生涯进度。旧档没有这个字段时由 normalizeCareer 补齐，VERSION 不升。
    career: defaultCareer(),
  };
}

/**
 * 每日种子：按本地日期拼成 YYYYMMDD，同一天同一张图。
 * 不联网、不取服务器时间，只用设备本地时间。
 * @param {Date} [now] 当前时间（默认 new Date()，测试可注入）
 * @returns {number} 8 位种子
 */
export function dailySeed(now = new Date()) {
  return Number(
    `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`,
  );
}

/**
 * 当前声望等级（纯函数，UI 与结算共用）。等级不落盘，避免两份数据打架。
 * @param {number} xp 声望经验
 * @returns {number} 等级 1~N
 */
export function repLevel(xp) {
  let lv = 1;
  for (const l of REP.levels) if (xp >= l.need) lv = l.level;
  return lv;
}

/**
 * 读取存档（损坏或不存在时返回新档）。
 * @returns {object} 存档对象
 */
export function loadSave() {
  const base = defaultSave();
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return base;
    const data = JSON.parse(raw);
    const rawLo = data.loadout || {};
    const loadout = { ...base.loadout, ...rawLo };
    // 旧档没有 loadout.ammo：把 ammo556Boxes / ammo9mmBoxes 迁移进来。
    // 不能先浅合并再用 base.ammo —— 那会把玩家实际携带的 4 盒悄悄重置成默认 2 盒。
    if (!rawLo.ammo || typeof rawLo.ammo !== 'object') {
      loadout.ammo = {
        ...base.loadout.ammo,
        ammo556: rawLo.ammo556Boxes != null ? rawLo.ammo556Boxes : base.loadout.ammo.ammo556,
        ammo9mm: rawLo.ammo9mmBoxes != null ? rawLo.ammo9mmBoxes : base.loadout.ammo.ammo9mm,
      };
    }
    loadout.helmet = loadout.helmet || 'none';
    // W2：8 槽位迁移。判据是「旧档没有 sidearm 字段」，迁移只跑一次（跑完 sidearm 就存在了）。
    // - 旧语义里 secondary 就是手枪位，所以 secondary==='pistol' 时挪到新的 sidearm 槽；
    // - 匕首 / 胸挂是 W2 才有的配发物品，老玩家仓库里没有，稍后各补一件（只补不扣），
    //   否则这两个槽对老存档永远是空的、也换不回来。
    const w2Migrate = rawLo.sidearm === undefined;
    if (w2Migrate) {
      loadout.sidearm = 'pistol';
      if (loadout.secondary === 'pistol') loadout.secondary = '';
      loadout.melee = 'knife';
      loadout.rig = 'rig_lv1';
      loadout.backpack = 'none';
    }
    normalizeLoadoutAmmo(loadout, WEAPONS);
    const save = {
      ...base,
      ...data,
      stash: deserializeInventory(data.stash, ITEMS),
      loadout,
      stats: { ...base.stats, ...(data.stats || {}) },
      settings: { ...base.settings, ...(data.settings || {}) },
      layout: { touch: { ...(data.layout && data.layout.touch) } },
      // 老存档没有 upgrades 字段：normalizeUpgrades 会返回全零进度。
      // 必须显式归一化而不能直接展开 data.upgrades —— 手改坏值（负数/字符串/超上限）也会让购买逻辑出错。
      upgrades: normalizeUpgrades(data.upgrades),
      // P10 生涯进度同样显式归一化：旧档缺字段补默认，坏值收敛，不覆盖其它存档字段。
      career: normalizeCareer(data.career),
      // P15 风险分级：只接受参数表里真实存在的 id，手改坏值/旧档一律回落常规。
      // 不做「未知 id 当成新难度」的宽容 —— 那会让手改存档白嫖到不存在的高倍率。
      risk: HUB.riskLevels.some((r) => r.id === data.risk) ? data.risk : base.risk,
      // P15 小队编成：只做结构归一化（字符串、去重、最多两席）；干员 id 是否有效
      // 由 spawnSquad 侧用 getOperator 过滤，避免 storage 反向依赖 operators.js。
      squad: Array.isArray(data.squad)
        ? [...new Set(data.squad.filter((id) => typeof id === 'string' && id))].slice(0, 2)
        : base.squad,
      // E-05：安全箱档位只接受已定义的档，坏值/旧档回落 s1，禁止手改存档白嫖更大箱子。
      secureTier: ['s1', 's2', 's3'].includes(data.secureTier) ? data.secureTier : base.secureTier,
    };
    // P15 迁移修复：把「配置里声明了盒数、但仓库实际没有」的弹种收敛到库存。
    // 起因是 P13 给 defaultLoadout 预置了 7.62 / 12ga 各 1 盒，老档仓库里却没有 ——
    // 玩家会卡在「数量超过仓库库存」，且不知道要去战前把盒数调成 0。
    // 只降不升：库存充足时原配置完全不动。
    for (const id of AMMO_IDS) {
      const boxes = loadoutAmmoBoxes(loadout, id);
      if (boxes < 1) continue;
      const have = countById(save.stash, id);
      if (boxes * ammoBoxSize(id) > have) setAmmoBoxes(loadout, id, Math.floor(have / ammoBoxSize(id)));
    }
    save.version = VERSION;
    // W2：老存档补发匕首 / 胸挂（只补不扣）。放在 save 组装完之后，
    // 因为要复用 deserializeInventory 出来的那个容器实例。
    if (w2Migrate) {
      for (const id of ['knife', 'rig_lv1']) {
        if (ITEMS[id] && countById(save.stash, id) < 1) {
          autoPlace(save.stash, createItem(ITEMS[id]));
        }
      }
    }
    return save;
  } catch {
    return base;
  }
}

// 存档写入元信息（供 debug 面板 / 故障浮层展示）。
let _saveErrorHandler = null;
let _lastWriteAt = 0;
let _lastBytes = 0;
let _writeOk = true;
let _reportedFail = false;
let _saveTimer = null;
let _pending = null;
let _listenersAttached = false;

function _attachFlushListeners() {
  if (_listenersAttached) return;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  _listenersAttached = true;
  const force = () => flushSave();
  window.addEventListener('pagehide', force);
  window.addEventListener('beforeunload', force);
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushSave();
    });
  }
}

/**
 * 真正落盘（同步）。失败不再静默：记录最近写入时间与字节数，并在本次失败事件里
 * 至少回调一次错误处理器（如弹一次 toast），而不是悄悄丢档。
 * @param {object} save 存档对象
 */
function _writeNow(save) {
  try {
    const payload = { ...save, stash: serializeInventory(save.stash) };
    const str = JSON.stringify(payload);
    _lastBytes = str.length;
    window.localStorage.setItem(KEY, str);
    _lastWriteAt = Date.now();
    _writeOk = true;
    _reportedFail = false;
  } catch (e) {
    _writeOk = false;
    // 不再静默：留下带标签的日志，并通知上层（如弹 toast）。
    // 每次失败事件只回调一次，直到写入恢复正常，避免配额类错误刷屏。
    console.debug('[搜打撤] 存档写入失败（配额/隐私模式），后续更改可能丢失：', (e && e.message) || e);
    if (!_reportedFail && typeof _saveErrorHandler === 'function') {
      _reportedFail = true;
      try { _saveErrorHandler({ bytes: _lastBytes, error: (e && e.message) || String(e) }); } catch (_) {}
    }
  }
}

/**
 * 写入存档（同步，行为兼容旧调用方与测试）。
 * @param {object} save 存档对象
 * @returns {void}
 */
export function saveGame(save) {
  _attachFlushListeners();
  _writeNow(save);
}

/**
 * 合并写入：250ms 内的多次调用只落盘一次（最后一次为准）。
 * 适合高频/冗余的配置类调用点（如连续改装备等），减轻主线程阻塞。
 * 页面隐藏/卸载时强制 flush，避免最后 250ms 的改动丢失。
 * @param {object} save 存档对象
 * @returns {void}
 */
export function scheduleSave(save) {
  _attachFlushListeners();
  _pending = save;
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    const s = _pending;
    _pending = null;
    if (s) _writeNow(s);
  }, 250);
  // 防止在未退出的测试进程中因待触发定时器挂起事件循环
  if (_saveTimer && typeof _saveTimer.unref === 'function') _saveTimer.unref();
}

/** 立即把待合并的写入落盘（带 flush 语义）。 */
export function flushSave() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  const s = _pending;
  _pending = null;
  if (s) _writeNow(s);
}

/**
 * 存档写入元信息（供 debug 面板 / 故障浮层展示）。
 * @returns {{ lastWriteAt:number, lastBytes:number, writeOk:boolean, pending:boolean }}
 */
export function getStorageMeta() {
  return { lastWriteAt: _lastWriteAt, lastBytes: _lastBytes, writeOk: _writeOk, pending: !!_pending };
}

/** 注册写入失败回调（如弹一次 toast）。每次失败事件只回调一次，直到写入恢复正常。 */
export function setSaveErrorHandler(fn) { _saveErrorHandler = fn; }

/** 导出原始存档 JSON 字符串（故障浮层「导出存档」用）。 */
export function exportSaveString() {
  try { return window.localStorage.getItem(KEY) || ''; }
  catch { return ''; }
}

/**
 * 清空存档。
 * @returns {object} 新的默认存档
 */
export function resetSave() {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // 忽略
  }
  return defaultSave();
}

/**
 * 破产保护：仓库里没有武器且资金不足时补发一把手枪和少量资金。
 * @param {object} save 存档对象
 * @returns {boolean} 是否触发了补助
 */
export function ensureMinimumKit(save) {
  const hasWeapon = save.stash.items.some((it) => it.category === 'weapon');
  if (hasWeapon && save.currency >= BAILOUT.minCurrency) return false;
  if (!hasWeapon) autoPlace(save.stash, createItem(ITEMS.pistol));
  if (save.currency < BAILOUT.minCurrency) save.currency += BAILOUT.currency;
  return true;
}

/**
 * 仓库中某物品的数量。
 * @param {object} save 存档对象
 * @param {string} id 物品 id
 * @returns {number} 数量
 */
export function stashCount(save, id) {
  return countById(save.stash, id);
}
