/**
 * localStorage 存档：货币、仓库、装备配置、统计
 */

import { ITEMS, START_CURRENCY, PLAYER, AMMO_STACK, BAILOUT, REP } from './config.js';
import { defaultUpgrades, normalizeUpgrades } from './upgrades.js';
import {
  createInventory, createItem, autoPlace, countById, serializeInventory, deserializeInventory,
} from './inventory.js';

const KEY = 'soudache.save.v1';
// 存档顶层版本保持 1：改装树只是**新增字段**，旧档由 normalizeUpgrades 补成全未解锁即可读取，
// 不需要破坏性迁移。改装结构自身的版本记录在 save.upgrades.version，后续可独立演进。
const VERSION = 1;

/**
 * 默认装备配置。
 * @returns {object} 装备配置
 */
export function defaultLoadout() {
  return {
    primary: 'rifle',
    secondary: 'pistol',
    armor: 'lv2',
    ammo556Boxes: 2,
    ammo9mmBoxes: 1,
    medkits: 2,
    bandages: 1,
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
  autoPlace(inv, createItem(ITEMS.ammo556, AMMO_STACK));
  autoPlace(inv, createItem(ITEMS.ammo556, AMMO_STACK));
  autoPlace(inv, createItem(ITEMS.ammo9mm, AMMO_STACK));
  autoPlace(inv, createItem(ITEMS.medkit, 1));
  autoPlace(inv, createItem(ITEMS.medkit, 1));
  autoPlace(inv, createItem(ITEMS.bandage, 1));
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
    },
    layout: { touch: {} }, // 触控按钮布局偏移：{ [action]: { x, y } }（绝对像素，相对触屏控制容器）
    insurance: { enabled: false }, // 装备保险开关（战前付保费，失败时赔带入的武器与护甲）
    daily: { date: '', bestScore: 0, extracted: false }, // 每日突袭：当日种子与成绩
    codex: { seen: {}, brought: {} }, // 图鉴：seen=拾取过，brought=真正带出过
    rep: { xp: 0 }, // 军械商声望经验（等级由 xp 现算，见 repLevel）
    // 局外改装树：三支等级（0 = 全未解锁）。迁移策略是"缺字段即全零"，而不是报错或重置整个存档。
    upgrades: defaultUpgrades(),
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
    const save = {
      ...base,
      ...data,
      stash: deserializeInventory(data.stash, ITEMS),
      loadout: { ...base.loadout, ...(data.loadout || {}) },
      stats: { ...base.stats, ...(data.stats || {}) },
      settings: { ...base.settings, ...(data.settings || {}) },
      layout: { touch: { ...(data.layout && data.layout.touch) } },
      // 老存档没有 upgrades 字段：normalizeUpgrades 会返回全零进度。
      // 必须显式归一化而不能直接展开 data.upgrades —— 手改坏值（负数/字符串/超上限）也会让购买逻辑出错。
      upgrades: normalizeUpgrades(data.upgrades),
    };
    save.version = VERSION;
    return save;
  } catch {
    return base;
  }
}

/**
 * 写入存档。
 * @param {object} save 存档对象
 * @returns {void}
 */
export function saveGame(save) {
  try {
    const payload = {
      ...save,
      stash: serializeInventory(save.stash),
    };
    window.localStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    // 隐私模式或配额不足时静默失败，不影响游戏进行
  }
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
