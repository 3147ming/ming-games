/**
 * 美术资产映射表（任务：美术资产接入，现代卡通厚涂风）。
 *
 * 纯逻辑、零 THREE / 零 DOM，可在 Node 下单测（见 tests/artassets.test.mjs）。
 * scene.mjs（商品正面贴图）/ hud.mjs（顾客与店员头像）共用本表，
 * 决定「某个 SKU / 某个身份 用哪张美术图」。
 *
 * 设计原则：
 * - 按下**游戏内真实 id** 建映射（config.mjs 的 SKU id 与 IDENTITIES id），
 *   这样 scene/hud 直接用已有的 skuId / identityId 查表，零改游戏逻辑。
 * - 美术源图文件名可能与游戏 id 不同（如热咖啡游戏 id 是 `hotcoffee`，
 *   源图按指令命名为 `coffee.png`）→ 用 value（文件 stem）做别名桥接。
 * - 未知 id → artUrl 返回 null，上层回退「纯色块 / 不显示头像」，绝不抛错。
 */

// 商品正面贴图：key = 游戏 SKU id，value = assets/art/items/{value}.png 文件 stem
export const ITEM_ART = {
  drink: 'drink',
  noodle: 'noodle',
  bento: 'bento',
  oden: 'oden',
  beer: 'beer',
  // 热咖啡游戏 id 是 hotcoffee（config.mjs:40），美术源图按指令命名为 coffee.png，
  // 这里用 value 别名桥接，不改变任何游戏逻辑。
  hotcoffee: 'coffee',
};

// 人物肖像：key = 身份/角色 id，value = assets/art/chars/{value}.png 文件 stem。
// clerk 不在 IDENTITIES（它是店员/玩家角色），其肖像用于店员自检面板 / 序章。
export const CHAR_ART = {
  clerk: 'clerk',
  nightowl: 'nightowl',
  student: 'student',
  office: 'office',
  drunk: 'drunk',
  driver: 'driver',
};

const BASE = 'assets/art';

/**
 * 取得某 id 对应的美术图 URL（相对站点根）。
 * @param {'item'|'char'} kind  资产种类
 * @param {string} id           游戏内 id（SKU id 或 身份 id）
 * @returns {string|null} 命中返回 'assets/art/{kind}s/{stem}.png'，未命中返回 null
 */
export function artUrl(kind, id) {
  if (!kind || !id) return null;
  const table = kind === 'item' ? ITEM_ART : kind === 'char' ? CHAR_ART : null;
  if (!table) return null;
  const stem = table[id];
  if (!stem) return null;
  return `${BASE}/${kind}s/${stem}.png`;
}

/** 商品贴图 URL（未知 SKU 返回 null → 上层回退纯色块） */
export function itemArtFor(skuId) {
  return artUrl('item', skuId);
}

/** 人物肖像 URL（未知身份返回 null → 上层不显示头像） */
export function charArtFor(identityId) {
  return artUrl('char', identityId);
}
