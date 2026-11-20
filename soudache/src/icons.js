/**
 * 图标与致谢数据（纯数据模块，不依赖 THREE / DOM）。
 *
 * 为什么单独一个文件：
 * 1. `ui-kit.js` 的 `iconEl()` 是全 UI 唯一的图标入口（背包 / 商店 / 仓库 / 图鉴 /
 *    战前配置都在调它），所以"用不用真图标"只需要在这里查一张表，不必改动 11 处调用点。
 * 2. game-icons.net 的图标是 **CC BY 3.0**，要求署名。署名文案必须和图标清单放在
 *    一起，改一个漏一个就会变成违约 —— 同源同文件最不容易漏。
 *
 * 用法约定：
 * - 表里有的 kind → 用 SVG（CSS mask 上色，仍然跟随稀有度颜色）；
 * - 表里没有的 kind → 原样退回 `glyphs.js` 的程序化矢量绘制，**不留下空白图标**。
 *
 * 注意：路径一律相对站点根（`./assets/icons/...`），deploy 后目录结构与源码一致。
 */

/** 站点根相对路径前缀。集中一处，换 CDN 只改这里。 */
const ICON_ROOT = 'assets/icons/';

/**
 * kind → SVG 文件。左边是 `config.js` 里 `icon:` 字段的取值（也包含 HUD 的容器类 kind）。
 * 只收"语义确实对得上"的：宁可少映射，也不要拿近似的图标骗人。
 */
export const ICON_SVG = {
  // --- 医疗 ---
  medkit: 'game-icons/delapouite__first-aid-kit.svg',
  bandage: 'game-icons/delapouite__arm-bandage.svg',
  pill: 'game-icons/delapouite__health-capsule.svg',
  surgery: 'game-icons/lorc__syringe.svg',
  // --- 防护 ---
  armor: 'game-icons/lorc__armor-vest.svg',
  armorKit: 'game-icons/delapouite__healing-shield.svg',
  helmet: 'game-icons/sbed__helmet.svg',
  // --- 弹药与武器 ---
  ammo: 'game-icons/sbed__ammo-box.svg',
  wpn_rifle: 'game-icons/sbed__rifle.svg',
  wpn_smg: 'game-icons/skoll__machine-gun.svg',
  wpn_pistol: 'game-icons/john-colburn__pistol-gun.svg',
  // --- 战术物资 ---
  optic: 'game-icons/lorc__arrow-scope.svg',
  keycard: 'game-icons/delapouite__lockpicks.svg',
  doc: 'game-icons/lorc__treasure-map.svg',
  // --- 物品类（W0 补齐）：这 9 个 kind 之前一直退回程序化图形，
  //     补齐后仓库/商店/搜刮的每一件物资都有语义准确的图标 ---
  chip: 'game-icons/lorc__microchip.svg',
  wire: 'game-icons/delapouite__wire-coil.svg',
  watch: 'game-icons/delapouite__watch.svg',
  suppressor: 'game-icons/delapouite__silenced.svg',
  parts: 'game-icons/lorc__cog.svg',
  gold: 'game-icons/delapouite__gold-stack.svg',
  fuel: 'game-icons/delapouite__fuel-tank.svg',
  bolt: 'game-icons/delapouite__hexagonal-nut.svg',
  battery: 'game-icons/delapouite__car-battery.svg',
  // --- 军事 UI（W1/W2 预留）：改枪台 / 装备 8 槽 / 战前地图 / 结算要用的
  //     战术语汇。先入库并登记，落地时直接 iconEl(kind) 即可，不再临时找图。---
  radar: 'game-icons/lorc__radar-sweep.svg',
  compass: 'game-icons/lorc__compass.svg',
  exfil: 'game-icons/delapouite__exit-door.svg',
  objective: 'game-icons/delapouite__flag-objective.svg',
  timer: 'game-icons/lorc__stopwatch.svg',
  radio: 'game-icons/delapouite__walkie-talkie.svg',
  satellite: 'game-icons/lorc__satellite.svg',
  stun: 'game-icons/delapouite__stun-grenade.svg',
  smoke: 'game-icons/darkzaitzev__smoke-bomb.svg',
  molotov: 'game-icons/lorc__molotov.svg',
  kevlar: 'game-icons/skoll__kevlar-vest.svg',
  bayonet: 'game-icons/skoll__bayonet.svg',
  reload: 'game-icons/delapouite__reload-gun-barrel.svg',
  bulletImpact: 'game-icons/delapouite__bullet-impacts.svg',
  vehicle: 'game-icons/delapouite__jeep.svg',
  helicopter: 'game-icons/delapouite__helicopter.svg',
  ladder: 'game-icons/delapouite__ladder.svg',
  grapple: 'game-icons/lorc__grapple.svg',
  cash: 'game-icons/lorc__cash.svg',
  coins: 'game-icons/delapouite__coins.svg',
  medal: 'game-icons/delapouite__ribbon-medal.svg',
  checklist: 'game-icons/delapouite__checklist.svg',
  weight: 'game-icons/delapouite__weight.svg',
  nightVision: 'game-icons/delapouite__night-vision.svg',
  crate: 'game-icons/delapouite__cargo-crate.svg',
  wrench: 'game-icons/sbed__wrench.svg',
  skull: 'game-icons/badges__skull.svg',
  crosshair: 'game-icons/lorc__crosshair-arrow.svg',
};

/** kind 是否有对应 SVG。 */
export function hasSvgIcon(kind) {
  return Object.prototype.hasOwnProperty.call(ICON_SVG, kind);
}

/**
 * 取图标 URL（相对站点根）。
 * @param {string} kind 图标 kind
 * @returns {string} 有映射返回 'assets/icons/...'，否则返回空串（调用方据此回退程序化绘制）
 */
export function iconUrl(kind) {
  const rel = ICON_SVG[kind];
  return rel ? ICON_ROOT + rel : '';
}

/**
 * 致谢清单（游戏内「致谢」屏直接遍历渲染）。
 *
 * 每条 `items` 是一行：`name` 是素材/作者，`license` 是授权，`note` 是可选的补充说明。
 * **CC BY 的条目必须出现**：用了不署名就是违约，比画面好不好看严重得多。
 */
export const CREDITS = [
  {
    title: '3D 模型 / MODELS',
    items: [
      { name: 'Kenney · Survival Kit / Blaster Kit / City Kit Industrial / Mini Characters', license: 'CC0 1.0', note: '搜刮容器与场景道具' },
      { name: 'Quaternius（经 Poly Pizza 分发）· 武器与士兵模型', license: 'CC0 1.0', note: 'poly-pizza/*.glb' },
      { name: 'Thardoc nolastname（经 Poly Pizza）· Gun Turret Minigun', license: 'CC BY 3.0', note: '机枪炮塔；已随包预置' },
    ],
  },
  {
    title: '图标 / ICONS',
    items: [
      {
        name: 'Sbed、Lorc、Delapouite、Skoll、John Colburn · game-icons.net',
        license: 'CC BY 3.0',
        note: '物品与武器图标；按 CC BY 要求在此署名',
      },
      { name: 'Kenney · Game Icons', license: 'CC0 1.0', note: '状态与界面图标' },
    ],
  },
  {
    title: '字体 / FONTS',
    items: [
      { name: 'Barlow Condensed · The Barlow Project Authors', license: 'SIL OFL 1.1', note: '战术标签与数值窄体' },
      { name: 'JetBrains Mono · The JetBrains Mono Project Authors', license: 'SIL OFL 1.1', note: '等宽读数与代码块' },
    ],
  },
  {
    title: '音效 / AUDIO',
    items: [
      { name: 'Kenney · RPG Audio / Interface Sounds / UI Audio / Impact Sounds', license: 'CC0 1.0' },
      { name: 'kurt、hingydunyas（OpenGameArt）· 枪声采样', license: 'CC0 1.0' },
    ],
  },
  {
    title: '引擎 / ENGINE',
    items: [
      { name: 'three.js r160（含 GLTFLoader、BufferGeometryUtils）', license: 'MIT' },
    ],
  },
];

/**
 * 项目声明：把"没用原作素材"这件事写进游戏里，而不是只写在仓库文档里。
 */
export const CREDITS_NOTE = '本作为独立作品：未使用《三角洲行动》的任何模型、贴图、音频、字体或地图数据。'
  + '所有外部资源均来自上表所列的 CC0 / CC BY / MIT 授权包，可在本仓库 assets/CREDITS.md 查到逐项来源。';
