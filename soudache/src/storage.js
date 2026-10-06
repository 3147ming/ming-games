/**
 * localStorage 存档：货币、仓库、装备配置、统计
 */

import { ITEMS, START_CURRENCY, PLAYER, AMMO_STACK, BAILOUT } from './config.js';
import {
  createInventory, createItem, autoPlace, countById, serializeInventory, deserializeInventory,
} from './inventory.js';

const KEY = 'soudache.save.v1';
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
      fov: 75, // 第一人称视野（腰射 FOV），60~100 可调
      mouseSens: 1.0, // 鼠标灵敏度倍率，0.3~3 可调
      touchLookSens: 1.0, // 触屏右摇杆视角灵敏度倍率，0.6~2.4 可调
      aimAssist: true, // 轻度辅助瞄准（仅触屏/手柄体验增益，桌面也可关）
      touchButtonScale: 1.0, // 触控按钮尺寸倍率，0.8~1.3 可调（位置/大小可调需求）
    },
    layout: { touch: {} }, // 触控按钮布局偏移：{ [action]: { x, y } }（绝对像素，相对触屏控制容器）
  };
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
