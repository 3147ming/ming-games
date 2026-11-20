/**
 * 位图图标层（HUD + 物品 + 稀有度边框）。
 *
 * 为什么单独成模块而不是改进 icons.js：
 *   - `ICON_SVG` 走 CSS mask，只用 alpha、颜色由 CSS 给；新素材是**已经上色的 PNG**，
 *     套 mask 会退化成单色剪影，反而丢掉细节。两者必须并存，不能互相顶替。
 *   - HUD 画在 canvas 上，物品画在 DOM 上，加载时机也不同（HUD 开局前 decode 预取，
 *     物品进面板才懒加载）。把三种生命周期塞进一个函数只会到处 if。
 *
 * 纪律（沿用 ICON 铁律）：
 *   1. 所有 <img> 必须 pointer-events:none —— 否则物品格里的图会吃掉点击。
 *   2. 每张 img 都要有 onerror 回退到既有矢量图标；断网时界面不塌、不留裂图。
 *   3. ITEM_BITMAP 的 key 一律是 **config.js 里的 def.id**，不是文件名，也不是 icon kind。
 *      同一个图标（如 item-ammobox）会挂到 12 种弹药 def.id 上。
 */

/** 站点根相对路径前缀，与 icons.js 的 ICON_ROOT 分开（换 CDN 只改这里） */
const BITMAP_ROOT = 'assets/art/icons/';

/* ------------------------------- HUD ------------------------------- */

/** 15 张 HUD 位图：key 用完整文件名前缀，避免和物品 kind 撞名 */
export const HUD_BITMAP = Object.freeze({
  'hud-ammo': 'hud/hud-ammo.png',
  'hud-health': 'hud/hud-health.png',
  'hud-armor': 'hud/hud-armor.png',
  'hud-footstep': 'hud/hud-footstep.png',
  'hud-vision': 'hud/hud-vision.png',
  'hud-radio': 'hud/hud-radio.png',
  'hud-backpack': 'hud/hud-backpack.png',
  'hud-helmet': 'hud/hud-helmet.png',
  'hud-plate': 'hud/hud-plate.png',
  'hud-medkit': 'hud/hud-medkit.png',
  'hud-grenade': 'hud/hud-grenade.png',
  'hud-extract': 'hud/hud-extract.png',
  'hud-timer': 'hud/hud-timer.png',
  'hud-crosshair': 'hud/hud-crosshair.png',
  'hud-sneak': 'hud/hud-sneak.png',
});

/** 位图没加载/断网时的矢量回退：映射到 glyphs.js 已有的 kind */
const HUD_GLYPH_FALLBACK = Object.freeze({
  'hud-ammo': 'ammo', 'hud-health': 'medkit', 'hud-armor': 'armor',
  'hud-footstep': 'radio', 'hud-vision': 'optic', 'hud-radio': 'radio',
  'hud-backpack': 'crate', 'hud-helmet': 'helmet', 'hud-plate': 'armor',
  'hud-medkit': 'medkit', 'hud-grenade': 'stun', 'hud-extract': 'exfil',
  'hud-timer': 'timer', 'hud-crosshair': 'crosshair', 'hud-sneak': 'sneak',
});

export function hudFallbackKind(key) {
  return HUD_GLYPH_FALLBACK[key] || '';
}

/* ------------------------------- 物品 ------------------------------- */

/**
 * def.id → 位图。已有 12 项矢量映射（ICON_SVG）保留不动，这里只补位图：
 * 有位图时优先，缺项/裂图时自动落回 ICON_SVG 或程序化 glyph。
 */
export const ITEM_BITMAP = Object.freeze({
  // 弹药箱：12 种弹药 def.id 共用一张
  ammo556: 'items/item-ammobox.png', ammo556ap: 'items/item-ammobox.png',
  ammo556sub: 'items/item-ammobox.png', ammo9mm: 'items/item-ammobox.png',
  ammo9mmap: 'items/item-ammobox.png', ammo9mmhp: 'items/item-ammobox.png',
  ammo762: 'items/item-ammobox.png', ammo762ap: 'items/item-ammobox.png',
  ammo762sub: 'items/item-ammobox.png', ammo12ga: 'items/item-ammobox.png',
  ammo12gabuck: 'items/item-ammobox.png', ammo12gaslug: 'items/item-ammobox.png',
  // 医疗包 / 护甲维修包
  medkit: 'items/item-medbox.png', armorKit: 'items/item-medbox.png',
  // 头盔 / 插板 / 背包
  helmet_lv2: 'items/item-helmet.png', helmet_lv3: 'items/item-helmet.png',
  lv2: 'items/item-plate.png', lv3: 'items/item-plate.png',
  bp_lv1: 'items/item-backpack.png', bp_lv2: 'items/item-backpack.png',
  bp_lv3: 'items/item-backpack.png',
  // 门卡
  keycard: 'items/item-keycard.png',
  // 没有 ITEM def 的几类只作语义登记（HUD/容器/未来物品用），不会被物品格误命中：
  __radio: 'items/item-radio.png', __nvg: 'items/item-nvg.png',
  __c4: 'items/item-c4.png', __safe: 'items/item-safe.png',
});

/** 物品格 def.id 是否有位图（__ 前缀是保留语义键，不算物品） */
export function hasItemBitmap(defId) {
  return !!defId && !defId.startsWith('__') && !!ITEM_BITMAP[defId];
}

/* ----------------------------- 稀有度 ----------------------------- */
/**
 * 代码 RARITY 四档是 common/rare/epic/legendary，素材四档是 common/uncommon/rare/legend。
 * 命名不完全一致，按**档位顺序**对齐（灰→灰、蓝→青绿、紫→蓝紫、金→金棕），
 * 保证四档各有独立边框且视觉递进；不是按字符串硬拼。
 */
export const RARITY_BITMAP = Object.freeze({
  common: 'rarity/rarity-common.png',
  rare: 'rarity/rarity-uncommon.png',
  epic: 'rarity/rarity-rare.png',
  legendary: 'rarity/rarity-legend.png',
});

/** 给格子容器用的 CSS background-image 值（配合 background-size:100% 100%） */
export function rarityBackground(rarity) {
  const rel = RARITY_BITMAP[rarity];
  return rel ? `url("${BITMAP_ROOT}${rel}")` : '';
}

/* --------------------------- 加载与绘制 --------------------------- */

/** 已 decode 的 HUD 位图（key → HTMLImageElement） */
const hudImages = new Map();
/** 物品位图缓存：进面板才加载，不占开局带宽 */
const itemImages = new Map();

/** 站点是否可用（node 单测里没有 Image / document） */
const canLoad = () => typeof Image !== 'undefined' && typeof document !== 'undefined';

/**
 * 进入战局前预取 15 张 HUD 位图。
 * 用 decode() 而不是 onload：decode 承诺像素已可上传 GPU，避免第一帧画空白。
 * 失败只跳过那一张（drawHudIcon 会回退矢量），绝不 reject 阻断开局。
 */
export async function preloadHudIcons() {
  if (!canLoad()) return { loaded: 0, failed: 0 };
  const jobs = Object.entries(HUD_BITMAP).map(async ([key, rel]) => {
    const img = new Image();
    img.src = BITMAP_ROOT + rel;
    try {
      await img.decode();
      hudImages.set(key, img);
      return 1;
    } catch {
      return 0;
    }
  });
  const n = (await Promise.all(jobs)).reduce((a, b) => a + b, 0);
  return { loaded: n, failed: Object.keys(HUD_BITMAP).length - n };
}

export function hudIconReady(key) {
  return hudImages.has(key);
}

/**
 * 在 canvas 上画一个 HUD 图标：位图优先，没加载就回退矢量。
 * @returns {boolean} 是否真的画了东西（false 表示调用方不用再处理）
 */
export function drawHudIcon(ctx, key, x, y, size, color, drawGlyph) {
  if (!ctx) return false;
  const img = hudImages.get(key);
  if (img) {
    ctx.drawImage(img, x, y, size, size);
    return true;
  }
  const kind = HUD_GLYPH_FALLBACK[key];
  if (kind && typeof drawGlyph === 'function') {
    drawGlyph(ctx, kind, x + size / 2, y + size / 2, size * 0.8, color);
    return true;
  }
  return false;
}

/**
 * 进入仓库 / 商店 / 战利品面板时懒加载物品位图。
 * 只加载当前面板真正会用到的 def.id，重复调用无副作用。
 */
export function prefetchItemIcons(ids) {
  if (!canLoad()) return;
  for (const id of ids || []) {
    const rel = ITEM_BITMAP[id];
    if (!rel || itemImages.has(id)) continue;
    const img = new Image();
    img.src = BITMAP_ROOT + rel;
    // 不 await：面板不等图，img.onerror 会回退
    img.decode().then(() => itemImages.set(id, img)).catch(() => {});
  }
}

/**
 * 物品图标 DOM：位图优先，裂图/断网时替换为既有矢量节点。
 * @param {string} defId config.js 里的物品 id（不是文件名）
 * @param {number} size 渲染边长（px）
 * @param {function} fallbackFactory 回退节点工厂，通常由 ui.js 传 () => iconEl(item.icon, color, size)
 */
export function itemIconEl(defId, size, fallbackFactory) {
  const rel = ITEM_BITMAP[defId];
  if (!rel || !canLoad()) return fallbackFactory ? fallbackFactory() : null;
  const img = document.createElement('img');
  img.className = 'icon icon-bitmap';
  img.alt = '';
  img.draggable = false;
  img.width = size; img.height = size;
  img.style.width = `${size}px`;
  img.style.height = `${size}px`;
  // ICON 铁律：图标是纯装饰，绝不能吃掉格子/按钮的点击
  img.style.pointerEvents = 'none';
  const useFallback = () => {
    if (!fallbackFactory) { img.style.display = 'none'; return; }
    const node = fallbackFactory();
    if (node) img.replaceWith(node);
    else img.style.display = 'none';
  };
  img.onerror = useFallback;
  // 已 decode 过的直接显示，避免面板切换时闪一下矢量
  const cached = itemImages.get(defId);
  if (cached && cached.complete && cached.naturalWidth) {
    img.src = cached.src;
  } else {
    img.src = BITMAP_ROOT + rel;
    // decode 失败时 onerror 不一定触发（例如 src 被缓存为 error），兜一层
    img.decode && img.decode().catch(useFallback);
  }
  return img;
}
