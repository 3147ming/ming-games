/**
 * 区域价值分层与热点（纯逻辑 · 零 DOM · 零随机 · 不写 map 的几何字段）
 *
 * 为什么单独一层：地图生成器只负责「房间 / 墙 / 容器 / 撤离点」的几何，
 * 不该同时决定「哪片区域值钱」。把价值分层抽出来后：
 * - 同 seed 的几何完全不变（GOLDEN 快照不含本模块产物）；
 * - 想调经济只需改这里的一张表，不用碰地图生成；
 * - 探针可以只测分层规则，不必生成整张图。
 *
 * 设计约束：
 * - 只读 map（rooms / extracts / playerSpawn），不修改任何字段；
 * - 不消耗 rng：分层必须由几何唯一决定，否则同 seed 两局收益会漂移；
 * - 分层结果里**不含**容器引用，只给坐标与等级，容器归属由 areaTierAt 现算。
 */

import { TILE } from './config.js';

/** 价值层级。低 → 中 → 高 → 热点，风险与收益同向递增。 */
export const TIER = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  HOTSPOT: 'hotspot',
};

/** 各层级的掉落幸运倍率（喂给 Loot.rollContainer 的 luck）。 */
export const TIER_LUCK = {
  low: 0.72,
  medium: 1.0,
  high: 1.32,
  hotspot: 1.55,
};

/** 各层级单容器保底价值（低于该值的容器补一件基础物资，避免"高风险空手"）。 */
export const TIER_FLOOR = {
  low: 260,
  medium: 420,
  high: 900,
  hotspot: 1500,
};

/**
 * 各层级的「掉落预算」倍率：同一容器类型在核心区的期望产出更高。
 * 与 TIER_LUCK 的区别 —— luck 改稀有度分布，budget 改**件数与补货次数**。
 * 只作用于掉落，不改容器几何数量（容器布局由 mapgen 决定，受 GOLDEN 保护）。
 */
export const TIER_BUDGET = {
  low: 0.82,
  medium: 1.0,
  high: 1.24,
  hotspot: 1.55,
};

/**
 * 局内补货波次。同一次战局分三波：开局铺满 → 中段补件 → 末段核心区重刷。
 * 目的是把"什么时候去搜"变成一个决策：早搜安全但产出低，晚搜要顶着撤离倒计时。
 * at 为**整局时长的比例**（0~1），由 main.js 换算成经过秒数。
 */
export const LOOT_WAVE = [
  { id: 'initial', at: 0, label: '开局物资' },
  { id: 'topup', at: 0.42, label: '中段补货' },
  { id: 'restock', at: 0.76, label: '末段重刷' },
];

/** 各层级参与补货的概率（0 = 永不补货）。低价值区不补，避免"到处都有"稀释热点价值。 */
export const TIER_TOPUP_RATE = {
  low: 0,
  medium: 0.28,
  high: 0.62,
  hotspot: 0.9,
};

/** 32 位整数哈希 → [0,1)。补货排期必须与几何唯一对应，不能消耗战局随机流。 */
function hashId(n, salt = 0) {
  let h = Math.imul((n | 0) + 0x9e3779b9, 0x85ebca77) ^ Math.imul((salt | 0) + 1, 0xc2b2ae3d);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** 热点结构模板：不同模板给不同"进圈理由"，危险提示也随之不同。 */
export const HOTSPOT_ARCHETYPE = [
  { id: 'armory', name: '军械库', hint: '高价值武器与配件集中，守卫密度最高', danger: 3 },
  { id: 'relay', name: '通信中枢', hint: '数据终端与情报价值高，容易被包夹', danger: 3 },
  { id: 'command', name: '指挥所', hint: '保险箱与密钥类物资，建议带足弹药再进', danger: 2 },
  { id: 'sample', name: '样本库', hint: '医疗与稀有样本，风险中等但出口远', danger: 2 },
  { id: 'vault', name: '金库', hint: '单件价值最高的区域，撤离路线最长', danger: 3 },
];

/** 出生点类型：不同出生点给不同的开局节奏。 */
export const SPAWN_KIND = {
  SAFE: 'safe',           // 安全出生：离撤离近、资源低但稳定
  PRESSURE: 'pressure',   // 压力出生：快速接近中价值区
  CONTESTED: 'contested', // 争夺出生：贴热点，但撤离更远
  EDGE: 'edge',           // 边缘出生：绕行搜刮，低中价值补偿
};

const TIER_LABEL = {
  low: '外围 · 低价值',
  medium: '中环 · 中价值',
  high: '内环 · 高价值',
  hotspot: '核心 · 热点',
};

/**
 * 计算区域分层计划。纯函数：同一张 map 永远得到同一份计划。
 * @param {object} map 地图（需 rooms / extracts / playerSpawn）
 * @returns {{areas: Array<object>, hotspots: Array<object>, spawnKind: string}}
 */
export function buildAreaPlan(map) {
  const rooms = (map && map.rooms) || [];
  if (!rooms.length) return { areas: [], hotspots: [], spawnKind: SPAWN_KIND.SAFE };
  const spawn = map.playerSpawn || { x: rooms[0].cx, y: rooms[0].cy };
  const extracts = map.extracts || [];

  // 1) 归一化「离出生点的距离」与「房间面积」——分层只用相对量，适配任意地图尺寸。
  const dists = rooms.map((r) => Math.hypot(r.cx - spawn.x, r.cy - spawn.y));
  const areasArr = rooms.map((r) => r.tw * r.th);
  const maxDist = Math.max(1, ...dists);
  const maxArea = Math.max(1, ...areasArr);

  // 2) 初始分层：距离越远越值钱；大房间在同距离段里再升一档。
  const areas = rooms.map((room, i) => {
    const dNorm = dists[i] / maxDist;
    const aNorm = areasArr[i] / maxArea;
    const score = dNorm * 0.72 + aNorm * 0.28;
    let tier = TIER.LOW;
    if (score >= 0.72) tier = TIER.HIGH;
    else if (score >= 0.45) tier = TIER.MEDIUM;
    // 撤离缓冲区：离任一撤离点过近的房间不设高价值，避免"无风险富矿"。
    const nearExtract = extracts.some((e) => Math.hypot(e.x - room.cx, e.y - room.cy) < e.r + TILE * 4);
    if (nearExtract && tier === TIER.HIGH) tier = TIER.MEDIUM;
    return {
      roomIndex: i,
      x: room.cx,
      y: room.cy,
      area: areasArr[i],
      dist: dists[i],
      tier,
      label: TIER_LABEL[tier],
    };
  });

  // 兜底：整张图一个 HIGH 都没有时，把面积最大的分区提为 HIGH。
  // 为什么会没有：距离/面积归一化后被"撤离缓冲区"降级（新图 3 个出口 + 更大半径，
  // 覆盖率显著上升），于是热点直接消失 —— 而热点是物资与交火的核心，不能因为地图变大就没了。
  if (!areas.some((a) => a.tier === TIER.HIGH) && areas.length) {
    const top = areas.slice().sort((a, b) => b.area - a.area)[0];
    top.tier = TIER.HIGH;
    top.label = TIER_LABEL[TIER.HIGH];
  }

  // 3) 热点：内环里面积最大的一间做主热点，其余高分房间取两个次热点。
  //    主热点必须至少有 3 条进入路径（由房间连通性保证，见 mapgen 的 corridorWidth / loopCorridors）。
  const ranked = areas.slice().sort((a, b) => {
    const sa = (a.tier === TIER.HIGH ? 1 : 0) * 100 + a.area;
    const sb = (b.tier === TIER.HIGH ? 1 : 0) * 100 + b.area;
    return sb - sa;
  });
  const hotspots = [];
  for (const a of ranked) {
    if (hotspots.length >= 3) break;
    if (a.tier !== TIER.HIGH && hotspots.length === 0) continue;
    // 结构模板按房间序号确定（不抽 rng）：同一张图同一个热点模板永远一致。
    const arch = HOTSPOT_ARCHETYPE[Math.floor(hashId(a.roomIndex, 17) * HOTSPOT_ARCHETYPE.length) % HOTSPOT_ARCHETYPE.length];
    hotspots.push({
      roomIndex: a.roomIndex,
      x: a.x,
      y: a.y,
      name: hotspots.length === 0 ? '主热点' : `次热点 ${hotspots.length}`,
      main: hotspots.length === 0,
      radius: Math.max(TILE * 4, Math.sqrt(a.area) * TILE * 0.55),
      archetype: arch.id,
      title: arch.name,
      hint: arch.hint,
      danger: arch.danger,
    });
    // 主热点所在区域升级为 hotspot
    a.tier = TIER.HOTSPOT;
    a.label = TIER_LABEL.hotspot;
  }

  // 4) 出生点类型：按出生点到最近撤离点 / 最近热点的关系判定。
  //    这些是"开局节奏"的分类，不改变出生位置本身（位置仍由 mapgen 决定）。
  const nearestExtract = extracts.length
    ? Math.min(...extracts.map((e) => Math.hypot(e.x - spawn.x, e.y - spawn.y)))
    : Infinity;
  const nearestHot = hotspots.length
    ? Math.min(...hotspots.map((h) => Math.hypot(h.x - spawn.x, h.y - spawn.y)))
    : Infinity;
  let spawnKind = SPAWN_KIND.SAFE;
  if (nearestHot < TILE * 10) spawnKind = SPAWN_KIND.CONTESTED;
  else if (nearestExtract > TILE * 18) spawnKind = SPAWN_KIND.EDGE;
  else if (nearestExtract < TILE * 9) spawnKind = SPAWN_KIND.SAFE;
  else spawnKind = SPAWN_KIND.PRESSURE;

  return { areas, hotspots, spawnKind };
}

/**
 * 取某坐标所属区域的层级（最近区域中心）。
 * @param {object} map 地图（读 map.areas）
 * @param {number} x 世界坐标
 * @param {number} y 世界坐标
 * @returns {string} TIER.*
 */
export function areaTierAt(map, x, y) {
  const areas = (map && map.areas) || [];
  if (!areas.length) return TIER.MEDIUM;
  let best = areas[0];
  let bd = Infinity;
  for (const a of areas) {
    const d = Math.hypot(a.x - x, a.y - y);
    if (d < bd) { bd = d; best = a; }
  }
  return best.tier;
}

/**
 * 某坐标是否在热点半径内。
 * @param {object} map 地图
 * @param {number} x 世界坐标
 * @param {number} y 世界坐标
 * @returns {?object} 命中的热点，否则 null
 */
export function hotspotAt(map, x, y) {
  for (const h of (map && map.hotspots) || []) {
    if (Math.hypot(h.x - x, h.y - y) <= h.radius) return h;
  }
  return null;
}

/** 出生点类型的开局提示：把"你这局落在什么位置"翻译成一句可执行的建议。 */
export const SPAWN_HINT = {
  safe: '出生在撤离点附近 —— 物资偏薄，稳一点就早搜早走',
  pressure: '出生在中环 —— 往内推能吃到中价值区，注意别被前后夹住',
  contested: '贴热点出生 —— 一开局就有人抢同一片物资，先确认掩体再动手',
  edge: '边缘出生 —— 绕行搜刮更安全，但要给撤离留足赶路时间',
};

/**
 * 出生点提示文案。
 * @param {string} kind SPAWN_KIND.*
 * @returns {string} 一句人话（未知类型返回空串，调用方据此跳过 toast）
 */
export function spawnHint(kind) {
  return SPAWN_HINT[kind] || '';
}

/** 层级 → 中文标签（UI 用，逻辑不依赖）。 */
export function tierLabel(tier) {
  return TIER_LABEL[tier] || '';
}

/**
 * 某坐标的容器掉落幸运倍率：外部风险倍率 × 区域层级倍率。
 * @param {object} map 地图
 * @param {number} x 世界坐标
 * @param {number} y 世界坐标
 * @param {number} [base=1] 风险分级等外部倍率
 * @returns {number} 合成后的 luck（永远 > 0）
 */
export function lootLuckAt(map, x, y, base = 1) {
  const tier = areaTierAt(map, x, y);
  const mul = TIER_LUCK[tier] || 1;
  const b = Number.isFinite(base) && base > 0 ? base : 1;
  // 保留 4 位：luck 直接进稀有度权重，浮点尾巴没有意义还不好断言
  return Math.round(b * mul * 10000) / 10000;
}

/**
 * 某坐标的掉落预算倍率（件数层面）。与 lootLuckAt 分开取，二者互不替代。
 * @param {object} map 地图
 * @param {number} x 世界坐标
 * @param {number} y 世界坐标
 * @returns {number}
 */
export function lootBudgetAt(map, x, y) {
  return TIER_BUDGET[areaTierAt(map, x, y)] || 1;
}

/**
 * 容器所属区域层级（读容器坐标）。
 * @param {object} map 地图
 * @param {object} container 容器
 * @returns {string} TIER.*
 */
export function containerTierOf(map, container) {
  if (!container) return TIER.MEDIUM;
  return areaTierAt(map, container.x, container.y);
}

/**
 * 补货排期：把「哪些容器在第几波补」算成一张表。
 * 纯函数（不抽 rng）：同 seed 同一张表，便于单测与复现。
 * @param {object} map 地图（需 containers / areas）
 * @param {object} [opts] { duration: 整局秒数 }
 * @returns {Array<{id:string, at:number, wave:string, containerIds:number[]}>} 按 at 升序
 */
export function planLootWaves(map, opts = {}) {
  const containers = (map && map.containers) || [];
  const duration = Number(opts.duration) > 0 ? Number(opts.duration) : 480;
  if (!containers.length) return [];
  const buckets = new Map();
  for (const wave of LOOT_WAVE) {
    if (wave.at <= 0) continue; // 开局那一波就是正常生成，不进补货排期
    buckets.set(wave.id, { id: wave.id, at: Math.round(duration * wave.at), wave: wave.id, containerIds: [] });
  }
  for (const c of containers) {
    const tier = containerTierOf(map, c);
    const rate = TIER_TOPUP_RATE[tier] || 0;
    if (rate <= 0) continue;
    // 两波独立掷：hit1 决定是否进中段补货，hit2 决定是否进末段重刷。
    // 用容器 id 的两种 salt 保证「进中段的不一定进末段」，避免补货集合完全重合。
    const hit1 = hashId(c.id, 3) < rate * 0.62;
    const hit2 = hashId(c.id, 11) < rate;
    if (hit1) buckets.get('topup').containerIds.push(c.id);
    if (hit2) buckets.get('restock').containerIds.push(c.id);
  }
  const out = [];
  for (const b of buckets.values()) {
    b.containerIds.sort((a, z) => a - z);
    if (b.containerIds.length) out.push(b);
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

/**
 * 热点结构模板（供 HUD / 地图卡展示）。没有 archetype 字段时回落主热点文案。
 * @param {object} hotspot 热点
 * @returns {{title:string, hint:string, danger:number}}
 */
export function hotspotInfo(hotspot) {
  if (!hotspot) return { title: '', hint: '', danger: 0 };
  const fallback = HOTSPOT_ARCHETYPE.find((a) => a.id === hotspot.archetype);
  return {
    title: hotspot.title || (fallback ? fallback.name : '核心区'),
    hint: hotspot.hint || (fallback ? fallback.hint : ''),
    danger: Number(hotspot.danger) || (fallback ? fallback.danger : 1),
  };
}

/**
 * 危险等级文字（HUD 用）。
 * @param {number} danger 1~3
 * @returns {string}
 */
export function dangerLabel(danger) {
  const n = Math.max(0, Math.min(3, Math.round(Number(danger) || 0)));
  return ['无', '低危', '中危', '高危'][n];
}
