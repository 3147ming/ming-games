/**
 * 撤离点状态机（纯逻辑 · 零 DOM · 零随机）
 *
 * 为什么单独一层：撤离是「这一局算不算数」的唯一出口。把「能不能走」的判定集中在这里，
 * 执行侧（player.interact / main.onExtract）、HUD 倒计时、地图卡读数就都读同一份状态，
 * 不会再出现「HUD 说能走、按 E 没反应」这类两套口径的问题。
 *
 * 硬约束：
 * - **不消耗 rng**：撤离点的修饰由坐标与序号唯一决定，同 seed 同一套规则；
 * - **不制造软锁**：永远至少有一个 `standard` 点无任何附加条件（开局即开、无手续费）；
 * - 只在 `map.extracts` 上加字段，不动几何 → 不进入 GOLDEN 快照。
 */

import { MATCH } from './config.js';

/** 撤离点的「通道类型」（决定性语义：是否收费）。由 mapgen 生成，这里只读。 */
export const EXTRACT_KIND = {
  STANDARD: 'standard',
  FREE: 'free',
  PAID: 'paid',
  GUARDED: 'guarded',
};

/**
 * 撤离点的**附加条件**（与 kind 正交）。
 * 分开建模的原因：一个付费点也可能同时是限时窗口，kind 表达"付不付钱"，modifier 表达"还有没有别的要求"。
 */
export const EXTRACT_MOD = {
  NONE: 'none',
  TEMP: 'temp',                 // 限时：开放窗口到点即关，永久关闭
  CONDITIONAL: 'conditional',   // 条件：必须携带足量物资（空手不能走）
  HEAVY: 'heavy',               // 重载：负重超上限不能走
  HIGH_RISK: 'highrisk',        // 高风险：撤离读条时间更长（更容易被打断）
  // E-03：以下三种与上面正交，缺省字段一律不触发 → 旧地图行为逐位不变。
  SWITCH: 'switch',             // 拉闸：需先拉下场上的闸刀才开放
  DROP_BAG: 'dropbag',          // 丢包：需丢弃背包才允许撤离
  RANDOM: 'random',             // 随机点：位置在开局时按 seed 选定（由 mapgen 落实，这里只标记）
};

export const EXTRACT_STATUS = {
  LOCKED: 'locked',     // 还没到开放时间
  OPEN: 'open',         // 可用
  BLOCKED: 'blocked',   // 已开放，但当前条件不满足
  CLOSED: 'closed',     // 窗口已过（或被系统关闭）
};

export const EXTRACT_REASON = {
  OK: 'ok',
  NOT_YET: 'notYet',
  EXPIRED: 'expired',
  NEED_ITEMS: 'needItems',
  OVERWEIGHT: 'overweight',
  POOR: 'poor',
  NEED_SWITCH: 'needSwitch', // E-03：闸刀未拉
  FULL: 'full',              // E-03：人数已满（联机前置；单机恒不触发）
  NEED_DROP: 'needDrop',     // E-03：需先丢背包
};

/** 撤离点修饰的默认参数（配置集中在此，便于一处调平衡）。 */
export const EXTRACT_TUNING = {
  tempWindow: 120,        // 限时窗口长度（秒）
  conditionalItems: 3,    // 条件撤离要求携带的件数
  heavyWeightRatio: 0.6,  // 重载撤离允许的负重要求（占上限比例）
  highRiskChannelMul: 1.6, // 高风险撤离的读条倍率
  // E-03 拉闸：拉闸后 180s 内点可用，超时关闭；广播给 AI 听觉（执行层）。
  switchDelay: 180,       // 拉闸后的可用窗口（秒）
  switchBroadcast: true,
  switchNoiseRadius: 220, // 拉闸声的 AI 听觉广播半径（世界单位）
  capacity: 4,            // 撤离点容量（联机前置；单机恒 1 人，不触发）
  // TRAIN 两段窗口由 window 字段表达（第一段关、第二段开），无需独立常量。
  // E-04 按类型的读条时长（秒）。TODO(Q-10)：蓝图建议默认 常规10/付费6/拉闸8。
  // ⚠ 现有地图与探针都按 MATCH.extractChannel=3 标定，直接套用会让所有点读条突变、探针进度失准。
  // 因此本表是**可选预设**：仅当点显式带 channelTime 字段（由 mapgen/配置给新类型点写入）时才生效；
  // 缺省点仍读 3s，逐位保持既有行为。Q-10 拍板后再决定是否全量切换。
  channelByKind: { standard: 10, free: 10, paid: 6, guarded: 8 },
  channelByMod: { switch: 8, highrisk: 4.8 },
};

/** 32 位整数哈希 → [0,1)：修饰分配必须与几何唯一对应，不能抽战局随机流。 */
function hashExtract(x, y, salt) {
  let h = Math.imul((x | 0) ^ 0x9e3779b9, 0x85ebca77) ^ Math.imul((y | 0) + 0x7f4a7c15, 0xc2b2ae3d);
  h ^= Math.imul((salt | 0) + 1, 0x27d4eb2f);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** 修饰文案（HUD / 地图卡 / toast 用）。 */
export const EXTRACT_MOD_LABEL = {
  none: '常规',
  temp: '限时',
  conditional: '需携带物资',
  heavy: '轻装',
  highrisk: '高危读条',
  switch: '需拉闸',
  dropbag: '需丢包',
  random: '随机出口',
};

/** 状态文案。 */
export const EXTRACT_STATUS_LABEL = {
  locked: '未开放',
  open: '可撤离',
  blocked: '条件未满足',
  closed: '已关闭',
};

/**
 * 给一张地图上的撤离点补齐「附加条件」。**原地**写 map.extracts 的修饰字段，
 * 不动 kind / openAt / 坐标 —— 因此不改变 GOLDEN 快照（快照在 generateMap 内取）。
 * @param {object} map 地图
 * @param {object} [opts] { duration } 覆盖整局时长（测试用）
 * @returns {Array<object>} map.extracts（同一引用）
 */
export function buildExtractPlan(map, opts = {}) {
  const list = (map && map.extracts) || [];
  if (!list.length) return list;
  const duration = Number(opts.duration) > 0 ? Number(opts.duration) : (MATCH.duration || 480);

  // 1) 常规撤离点是"永远可用的兜底"：任何情况下都不许挂附加条件，
  //    否则条件叠加可能把三条出口全堵死，玩家只能等死 —— 那是软锁。
  const anchor = list.find((e) => e.kind === EXTRACT_KIND.STANDARD) || list[0];

  // 2) 其余点按坐标哈希分配修饰。用「候选池按哈希取模」而不是加权随机：
  //    同坐标永远同一个修饰，且不需要随机流。
  const pool = [EXTRACT_MOD.NONE, EXTRACT_MOD.TEMP, EXTRACT_MOD.CONDITIONAL, EXTRACT_MOD.HEAVY];
  for (const ex of list) {
    ex.modifier = EXTRACT_MOD.NONE;
    ex.window = null;
    ex.require = null;
    ex.weightCap = 0;
    ex.highRisk = false;
    // E-03：新条件字段统一初始化为"不触发"，旧地图/旧测试逐位不变。
    ex.requiresSwitch = false;
    ex.switchPulledAt = null;
    ex.requiresDrop = false;
    ex.capacity = 0;
    ex.channelTime = null;
    // M-03：拉闸提前解锁标记。缺省 false → 旧地图逐位不变。
    ex.unlockedEarly = false;
    if (ex === anchor) continue;
    // 守点本身就是"高风险"，不再叠修饰 —— 否则一处出口同时限时+轻装，实际等于不存在。
    if (ex.kind === EXTRACT_KIND.GUARDED) {
      ex.modifier = EXTRACT_MOD.HIGH_RISK;
      ex.highRisk = true;
      continue;
    }
    const pick = pool[Math.floor(hashExtract(ex.x, ex.y, 5) * pool.length) % pool.length];
    ex.modifier = pick;
    if (pick === EXTRACT_MOD.TEMP) {
      const from = Number(ex.openAt) || 0;
      ex.window = { from, to: Math.min(duration, from + EXTRACT_TUNING.tempWindow) };
    } else if (pick === EXTRACT_MOD.CONDITIONAL) {
      ex.require = { items: EXTRACT_TUNING.conditionalItems };
    } else if (pick === EXTRACT_MOD.HEAVY) {
      ex.weightCap = EXTRACT_TUNING.heavyWeightRatio;
    }
  }

  // 3) 兜底：若所有非锚点出口都被挂上 hard 条件，撤销其中一个，保证"总有一条硬路"。
  const others = list.filter((e) => e !== anchor);
  const openable = others.filter((e) => e.modifier === EXTRACT_MOD.NONE || e.modifier === EXTRACT_MOD.TEMP);
  if (others.length && !openable.length) {
    const relax = others.find((e) => e.modifier === EXTRACT_MOD.CONDITIONAL) || others[0];
    relax.modifier = EXTRACT_MOD.NONE;
    relax.require = null;
    relax.weightCap = 0;
  }

  // 4) M-03（opt-in）：把撤离点从"三个差不多的圈"升级成"常规 / 付费 / 拉闸"的出口网络。
  //    默认关闭 —— 既有测试与 GOLDEN 口径逐位不变；main.js 显式 layout:true 才启用。
  if (opts.layout === true) map.extractLayout = applyExtractLayout(map, list, anchor, duration);
  return list;
}

/** M-03 布局参数（集中调平衡；不抽随机流）。 */
export const EXTRACT_LAYOUT = {
  minSeparation: 300,   // 两个出口中心的最小间距（世界单位），低于此视为重叠
  switchOffset: 96,     // 闸刀相对拉闸点中心的偏移半径
  switchRadius: 26,     // 闸刀交互半径（与终端同量级）
  switchAngle: Math.PI / 4, // 闸刀相对出口的固定方向（确定性，不抽 rng）
};

/**
 * M-03：在 generateMap **之后**重排出口角色。不进 GOLDEN 快照，不改几何坐标。
 *
 * 出口角色由「地图事实」决定，而不是随机：
 * - 常规点（anchor）保持开局即开、零条件 —— 任何时刻都有硬路；
 * - 付费点放在**剩余出口里离热点最近**的一处（高价值区旁撤离要花钱）；
 * - 拉闸点放在**离地图中心最近**的候选上（必须深入图心拉闸，并暴露位置）。
 * 两个目标撞同一个点（锚点常常本身就占着最近热点）时以拉闸靠图心为准。
 *
 * @param {object} map 地图（读 width/height/hotspots，写 switches/extractLayout）
 * @param {Array<object>} list buildExtractPlan 已初始化的撤离点
 * @param {object} anchor 常规兜底点
 * @param {number} duration 整局秒数
 * @returns {{ok:boolean, paid:?object, switchPoint:?object, issues:Array<string>}}
 */
export function applyExtractLayout(map, list, anchor, duration) {
  const issues = [];
  const others = list.filter((e) => e !== anchor);
  if (!others.length) return { ok: false, paid: null, switchPoint: null, issues: ['no-candidate'] };

  const cx = (Number(map.width) || 0) / 2;
  const cy = (Number(map.height) || 0) / 2;
  const hotspots = (map.hotspots || []).filter((h) => Number.isFinite(h.x) && Number.isFinite(h.y));
  const distToCenter = (e) => Math.hypot(e.x - cx, e.y - cy);
  // 没有 hotspots 的手搓地图：用"离中心更远"作为高价值区的代理，保证函数不退化成随机。
  const distToHot = (e) => hotspots.length
    ? Math.min(...hotspots.map((h) => Math.hypot(h.x - e.x, h.y - e.y)))
    : -distToCenter(e);

  // 两个目标撞同一个点时无法两全（锚点常常本身就占着最近热点）。
  // 裁决：拉闸靠图心是博弈核心（硬约束）；付费只在**剩余**出口里取最靠热点的。
  let switchPoint = others.reduce(
    (best, e) => (distToCenter(e) < distToCenter(best) ? e : best), others[0],
  );
  const rest = others.filter((e) => e !== switchPoint);
  const paid = rest.length
    ? rest.reduce((best, e) => (distToHot(e) < distToHot(best) ? e : best), rest[0])
    : switchPoint;

  // 出口间距：只报告、不挪点 —— 挪点会让"出生点离出口最远"的既有口径失效。
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      if (Math.hypot(list[i].x - list[j].x, list[i].y - list[j].y) < EXTRACT_LAYOUT.minSeparation) {
        issues.push(`too-close:${list[i].id}-${list[j].id}`);
      }
    }
  }

  // 常规点：彻底清掉附加条件（即使哈希分配误中，也不能堵死硬路）。
  anchor.kind = EXTRACT_KIND.STANDARD;
  anchor.openAt = 0;
  anchor.modifier = EXTRACT_MOD.NONE;
  anchor.window = null;
  anchor.require = null;
  anchor.weightCap = 0;
  anchor.requiresSwitch = false;
  anchor.requiresDrop = false;

  // 付费点：手续费就是它的"门票"，不再叠物资/负重条件，避免双重惩罚。
  paid.kind = EXTRACT_KIND.PAID;
  paid.cost = MATCH.extractFee;
  paid.openAt = Math.max(0, (Number(duration) || MATCH.duration) - MATCH.extractOpenAt);
  paid.modifier = EXTRACT_MOD.NONE;
  paid.window = null;
  paid.require = null;
  paid.weightCap = 0;
  paid.requiresSwitch = false;
  paid.requiresDrop = false;

  // 拉闸点：free 通道（不收钱），但必须拉闸。
  // openAt 保持原「第 2:30 开放」口径（P20 分阶段护栏），拉闸可提前解锁（world.pullExtractSwitch）。
  // 不写 channelTime：Q-10 未拍板前读条口径仍是 3s（见 EXTRACT_TUNING 注释）。
  switchPoint.kind = EXTRACT_KIND.FREE;
  switchPoint.openAt = MATCH.extractFirstOpen;
  switchPoint.cost = 0; // 原 paid 点改型后不能残留手续费（HUD 会读 cost 文案）
  switchPoint.modifier = EXTRACT_MOD.SWITCH;
  switchPoint.window = null;
  switchPoint.require = null;
  switchPoint.weightCap = 0;
  switchPoint.requiresSwitch = true;
  switchPoint.switchPulledAt = null;
  switchPoint.requiresDrop = false;
  configureExtract(switchPoint, { switch: true });

  return { ok: switchPoint !== paid, paid, switchPoint, issues };
}

/**
 * 计算某个撤离点当前的状态。纯函数：只读传入的上下文，不改任何东西。
 * @param {object} ex 撤离点（需 openAt / kind / 可选 window / require / weightCap）
 * @param {object} ctx { time, weight, weightLimit, itemCount, currency }
 * @returns {{status:string, reason:string, label:string, left:number, until:number}}
 */
export function extractState(ex, ctx = {}) {
  const time = Number(ctx.time) || 0;
  if (!ex) return { status: EXTRACT_STATUS.CLOSED, reason: EXTRACT_REASON.EXPIRED, label: '', left: 0, until: 0 };
  const from = Number(ex.openAt) || 0;
  const to = ex.window ? Number(ex.window.to) : Infinity;
  const until = Number.isFinite(to) ? Math.max(0, to - time) : Infinity;

  if (ex.closedBySystem) {
    return { status: EXTRACT_STATUS.CLOSED, reason: EXTRACT_REASON.EXPIRED, label: EXTRACT_STATUS_LABEL.closed, left: 0, until: 0 };
  }
  // 拉闸可提前解锁（world 拉闸成功后写 unlockedEarly），不再受 openAt 门槛限制。
  if (time < from && !ex.unlockedEarly) {
    return { status: EXTRACT_STATUS.LOCKED, reason: EXTRACT_REASON.NOT_YET,
      label: `${EXTRACT_STATUS_LABEL.locked} T-${Math.ceil(from - time)}s`, left: Math.ceil(from - time), until };
  }
  if (Number.isFinite(to) && time > to) {
    return { status: EXTRACT_STATUS.CLOSED, reason: EXTRACT_REASON.EXPIRED, label: EXTRACT_STATUS_LABEL.closed, left: 0, until: 0 };
  }
  if (ex.require && (Number(ctx.itemCount) || 0) < ex.require.items) {
    return { status: EXTRACT_STATUS.BLOCKED, reason: EXTRACT_REASON.NEED_ITEMS,
      label: `需携带 ${ex.require.items} 件物资`, left: 0, until };
  }
  if (ex.weightCap > 0) {
    const cap = Math.max(0, (Number(ctx.weightLimit) || 0) * ex.weightCap);
    if (cap > 0 && (Number(ctx.weight) || 0) > cap) {
      return { status: EXTRACT_STATUS.BLOCKED, reason: EXTRACT_REASON.OVERWEIGHT,
        label: `需轻装（≤ ${cap.toFixed(1)}kg）`, left: 0, until };
    }
  }
  if (ex.kind === EXTRACT_KIND.PAID && Number(ctx.currency) < (Number(ex.cost) || MATCH.extractFee)) {
    return { status: EXTRACT_STATUS.BLOCKED, reason: EXTRACT_REASON.POOR,
      label: `资金不足（需 ${Math.round(Number(ex.cost) || MATCH.extractFee)}）`, left: 0, until };
  }
  // E-03 新增条件（缺省字段一律跳过 → 旧地图逐位不变）。
  // 拉闸：requiresSwitch 且未记录拉闸时间 → 锁定。拉闸超窗 → 关闭。
  // 拉闸后 HUD 需要"闸口 T-xxs"倒计时，因此 until 改用窗口剩余（旧点行文完全不变）。
  const switchRaw = ex.requiresSwitch && ex.switchPulledAt != null
    ? EXTRACT_TUNING.switchDelay - (time - ex.switchPulledAt)
    : null;
  const switchLeft = switchRaw != null ? Math.max(0, switchRaw) : null;
  // time=0 拉闸时 switchPulledAt=0（falsy），必须用 == null 判空，否则开局拉闸永远显示未拉。
  if (ex.requiresSwitch && ex.switchPulledAt == null) {
    return { status: EXTRACT_STATUS.BLOCKED, reason: EXTRACT_REASON.NEED_SWITCH,
      label: '需先拉下闸刀', left: 0, until };
  }
  // 边界与旧实现一致：恰好 180.0s 仍 OPEN，超过才 CLOSED（测试锁死）。
  if (switchRaw != null && switchRaw < 0) {
    return { status: EXTRACT_STATUS.CLOSED, reason: EXTRACT_REASON.EXPIRED,
      label: EXTRACT_STATUS_LABEL.closed, left: 0, until: 0 };
  }
  // 丢包：带背包不能走（单机用 ctx.hasBackpack 表达；联机前置 capacity 用 ctx.occupants）。
  if (ex.requiresDrop && ctx.hasBackpack) {
    return { status: EXTRACT_STATUS.BLOCKED, reason: EXTRACT_REASON.NEED_DROP,
      label: '需丢弃背包', left: 0, until };
  }
  if (ex.capacity > 0 && (Number(ctx.occupants) || 0) >= ex.capacity) {
    return { status: EXTRACT_STATUS.BLOCKED, reason: EXTRACT_REASON.FULL,
      label: '撤离点已满', left: 0, until };
  }
  return { status: EXTRACT_STATUS.OPEN, reason: EXTRACT_REASON.OK,
    label: EXTRACT_STATUS_LABEL.open, left: 0,
    until: switchLeft != null ? Math.round(switchLeft) : until };
}

/**
 * 能否从这里撤离。执行侧唯一判据（player.interact / main.onExtract 都走它）。
 * @param {object} ex 撤离点
 * @param {object} ctx 上下文
 * @returns {{ok:boolean, reason:string, status:string, message:string}}
 */
export function canExtract(ex, ctx = {}) {
  const st = extractState(ex, ctx);
  if (st.status === EXTRACT_STATUS.OPEN) return { ok: true, reason: st.reason, status: st.status, message: '' };
  const name = (ex && ex.name) || '撤离点';
  let message = `${name}：${st.label}`;
  if (st.status === EXTRACT_STATUS.LOCKED) message = `${name} 尚未开放（还剩 ${st.left} 秒）`;
  else if (st.reason === EXTRACT_REASON.EXPIRED) message = `${name} 已关闭`;
  else if (st.reason === EXTRACT_REASON.NEED_ITEMS) message = `${name} 需要携带至少 ${ex.require.items} 件物资`;
  else if (st.reason === EXTRACT_REASON.OVERWEIGHT) message = `${name} 要求轻装撤离 —— ${st.label}`;
  else if (st.reason === EXTRACT_REASON.POOR) message = `${name} 资金不足，无法支付手续费`;
  else if (st.reason === EXTRACT_REASON.NEED_SWITCH) message = `${name} 需要先拉下闸刀`;
  else if (st.reason === EXTRACT_REASON.NEED_DROP) message = `${name} 需要先丢弃背包`;
  else if (st.reason === EXTRACT_REASON.FULL) message = `${name} 已满，等待下一处出口`;
  return { ok: false, reason: st.reason, status: st.status, message };
}

/**
 * 撤离读条时长：高风险点读条更久（更容易被打断），其余按配置默认值。
 * @param {object} ex 撤离点
 * @returns {number} 秒
 */
export function extractChannelTime(ex) {
  const base = MATCH.extractChannel || 3;
  // E-04 opt-in：显式 channelTime 优先（新类型点由 mapgen 写入）；缺省保持既有口径逐位不变。
  if (ex && Number.isFinite(Number(ex.channelTime)) && Number(ex.channelTime) > 0) {
    return Number(ex.channelTime);
  }
  if (ex && (ex.highRisk || ex.modifier === EXTRACT_MOD.HIGH_RISK)) {
    return Math.round(base * EXTRACT_TUNING.highRiskChannelMul * 10) / 10;
  }
  return base;
}

/**
 * E-04：按类型/修饰给出建议读条时长（未写入 ex.channelTime 时用）。
 * 这是"建议值"而非强制值：Q-10 未拍板前只供地图配置主动采用，不改变旧点行为。
 * @param {object} ex 撤离点
 * @returns {number} 建议读条秒数
 */
export function suggestedChannelTime(ex) {
  if (!ex) return MATCH.extractChannel || 3;
  const byMod = EXTRACT_TUNING.channelByMod[ex.modifier];
  if (byMod != null) return byMod;
  const byKind = EXTRACT_TUNING.channelByKind[ex.kind];
  return byKind != null ? byKind : (MATCH.extractChannel || 3);
}

/**
 * HUD 用：把所有撤离点归纳成一行读数。
 * @param {Array<object>} list 撤离点
 * @param {object} ctx 上下文
 * @returns {{open:number, total:number, nextAt:number, nearest:?object, label:string}}
 */
export function extractOverview(list, ctx = {}) {
  const arr = list || [];
  const states = arr.map((e) => ({ e, st: extractState(e, ctx) }));
  const open = states.filter((s) => s.st.status === EXTRACT_STATUS.OPEN).length;
  const pending = states
    .filter((s) => s.st.status === EXTRACT_STATUS.LOCKED)
    .sort((a, b) => a.st.left - b.st.left);
  const blocked = states.filter((s) => s.st.status === EXTRACT_STATUS.BLOCKED).length;
  // M-03：拉闸点的全图倒计时（只在闸刀已拉、窗口仍有效时给出秒数）。
  const switched = states
    .filter((s) => s.e.requiresSwitch && s.e.switchPulledAt != null && Number.isFinite(s.st.until))
    .sort((a, b) => a.st.until - b.st.until);
  let label;
  if (open > 0) label = `可撤离 ${open}/${arr.length}`;
  else if (pending.length) label = `下一处 T-${pending[0].st.left}s`;
  else if (blocked > 0) label = `条件未满足 ${blocked}/${arr.length}`;
  else label = '无可用出口';
  return {
    open,
    total: arr.length,
    blocked,
    nextAt: pending.length ? pending[0].st.left : 0,
    nearest: pending.length ? pending[0].e : null,
    switchLeft: switched.length ? Math.ceil(switched[0].st.until) : 0,
    label,
  };
}

/** 修饰的中文标签。 */
export function modifierLabel(ex) {
  return EXTRACT_MOD_LABEL[(ex && ex.modifier) || EXTRACT_MOD.NONE] || '';
}

/**
 * E-03 拉闸：把闸刀状态写到撤离点上（纯函数，原地写 ex）。
 * 拉闸会开启窗口；广播由执行层（world.pullExtractSwitch）负责，不在这里做副作用。
 * @param {object} ex 撤离点
 * @param {number} time 当前经过秒数
 * @returns {{ok:boolean, reason:string}} 结果
 */
export function pullSwitch(ex, time) {
  if (!ex || !ex.requiresSwitch) return { ok: false, reason: EXTRACT_REASON.NOT_YET };
  if (ex.switchPulledAt != null) return { ok: false, reason: EXTRACT_REASON.EXPIRED }; // 已拉过
  ex.switchPulledAt = Number(time) || 0;
  ex.closedBySystem = false;
  return { ok: true, reason: EXTRACT_REASON.OK };
}

/**
 * E-03：给撤离点配置成特殊类型（拉闸 / 丢包 / 随机 / 容量限制）。
 * 供 mapgen / M-03 布局按地图配置调用；显式字段驱动，不动默认随机分配。
 * @param {object} ex 撤离点
 * @param {object} cfg { switch, dropBag, random, capacity, channelTime }
 * @returns {object} 同一个 ex
 */
export function configureExtract(ex, cfg = {}) {
  if (!ex) return ex;
  if (cfg.switch) {
    ex.requiresSwitch = true;
    ex.switchPulledAt = null;
    ex.modifier = EXTRACT_MOD.SWITCH;
  }
  if (cfg.dropBag) {
    ex.requiresDrop = true;
    ex.modifier = EXTRACT_MOD.DROP_BAG;
  }
  if (cfg.random) ex.random = true; // 位置在 mapgen 选点阶段决定，这里只做标记
  if (Number(cfg.capacity) > 0) ex.capacity = Number(cfg.capacity);
  if (Number(cfg.channelTime) > 0) ex.channelTime = Number(cfg.channelTime);
  return ex;
}
