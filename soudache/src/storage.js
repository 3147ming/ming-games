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
      streak: 0, // 连续成功撤离次数（撤离 +1，失败清零）
      dailyCount: 0, // 累计完成的每日突袭次数
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
    // ---- 长期进度（以下字段都是"追加"，靠 loadSave 的浅/深合并天然兼容老档）----
    insurance: { enabled: false }, // 装备保险：是否在部署时购买
    daily: { date: '', bestScore: 0, extracted: false }, // 每日突袭当日成绩
    rep: { xp: 0 }, // 军械商声望经验
    codex: { seen: {}, brought: {} }, // 图鉴：见过 / 带出过
    shop: { date: '', deals: [], sold: {} }, // 商店每日特价与限购计数
    achievements: {}, // 成就达成时间戳 { id: ms }
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
      // 新增的嵌套对象必须逐个深合并：浅合并会把老档缺失的整个子键覆盖成 undefined，
      // 之后任何 `save.codex.seen[id]` 都会抛 "cannot read properties of undefined"。
      insurance: { ...base.insurance, ...(data.insurance || {}) },
      daily: { ...base.daily, ...(data.daily || {}) },
      rep: { ...base.rep, ...(data.rep || {}) },
      codex: {
        seen: { ...(data.codex && data.codex.seen) },
        brought: { ...(data.codex && data.codex.brought) },
      },
      shop: {
        date: (data.shop && data.shop.date) || base.shop.date,
        deals: Array.isArray(data.shop && data.shop.deals) ? data.shop.deals.slice() : [],
        sold: { ...(data.shop && data.shop.sold) },
      },
      achievements: { ...(data.achievements) },
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
