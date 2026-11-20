/**
 * 局内目标（纯逻辑 · 零 DOM · 零随机）
 *
 * 设计意图：每局给三条不同风险档的目标 —— 短目标（3~5 分钟可完成）、中目标（要求
 * 穿越中风险区）、高风险目标（把你推向热点）。三者共用同一套「进度 → 达成」判定，
 * 结算页与 HUD 读同一份结果，不存在两套口径。
 *
 * 硬约束：
 * - **不消耗 rng**：目标由地图几何唯一决定（同 seed 同一组目标），否则同种子整局会漂移；
 * - 不改交易/经济：奖励只进「评分加成」，不动货币与掉落；
 * - 不制造软锁：任何目标都不要求"必须先完成前一条"，失败只是少一份评分。
 */

import { TILE } from './config.js';

export const OBJECTIVE_KIND = {
  LOOT_COUNT: 'lootCount',
  LOOT_VALUE: 'lootValue',
  TERMINAL: 'terminal',
  HOTSPOT: 'hotspot',
  KILL: 'kill',
  EXTRACT: 'extract',
};

export const OBJECTIVE_TIER = {
  SHORT: 'short',
  MID: 'mid',
  HIGH: 'high',
};

/**
 * 生成一局的三条目标。纯函数：只看地图（房间数 / 热点 / 终端 / 撤离点）。
 * @param {object} map 地图
 * @returns {Array<object>} 三条目标
 */
export function buildObjectives(map) {
  const hotspots = (map && map.hotspots) || [];
  const terminals = (map && map.terminals) || [];
  const containers = (map && map.containers) || [];
  const list = [
    {
      id: 'obj-short',
      tier: OBJECTIVE_TIER.SHORT,
      kind: OBJECTIVE_KIND.LOOT_COUNT,
      target: 3,
      name: '带回三件物资',
      desc: '拾取并带出任意 3 件物资（撤离时结算）',
      score: 120,
    },
    {
      id: 'obj-mid',
      tier: OBJECTIVE_TIER.MID,
      kind: OBJECTIVE_KIND.LOOT_VALUE,
      // 中目标价值随容器总量缩放：物资越多的图要求越高，但不至于遥不可及。
      // 系数定在 200/容器：36 个容器的图约 7000，12 个的图落到下限 2500，
      // 既随图变化又不会像旧系数(420)那样一头撞上 9000 上限、变成永远同一个数字。
      target: Math.max(2500, Math.min(9000, Math.round(containers.length * 200 / 500) * 500)),
      name: '带出足够价值',
      desc: '撤离时随身物资估值达到目标（阵亡不算）',
      score: 260,
    },
  ];

  // 高风险目标优先选热点（这是"把你推进危险区"的核心），没有热点时退化为终端/击杀。
  if (hotspots.length) {
    const h = hotspots.find((x) => x.main) || hotspots[0];
    list.push({
      id: 'obj-high',
      tier: OBJECTIVE_TIER.HIGH,
      kind: OBJECTIVE_KIND.HOTSPOT,
      target: 1,
      name: `进入${h.name}`,
      desc: '踏入核心热点区域（高风险高回报）',
      hotspot: { x: h.x, y: h.y, r: h.radius },
      score: 420,
    });
  } else if (terminals.length) {
    list.push({
      id: 'obj-high',
      tier: OBJECTIVE_TIER.HIGH,
      kind: OBJECTIVE_KIND.TERMINAL,
      target: Math.min(2, terminals.length),
      name: '破解数据终端',
      desc: '破译终端获取情报（会发出噪音）',
      score: 380,
    });
  } else {
    list.push({
      id: 'obj-high',
      tier: OBJECTIVE_TIER.HIGH,
      kind: OBJECTIVE_KIND.KILL,
      target: 3,
      name: '清除守卫',
      desc: '击败 3 名敌人',
      score: 360,
    });
  }

  return list;
}

/**
 * 计算某条目标当前的进度与达成状态。
 * @param {object} obj 目标
 * @param {object} ctx { world, carriedValue, success }
 * @returns {{progress:number, target:number, done:boolean, text:string}}
 */
export function objectiveState(obj, ctx = {}) {
  const w = ctx.world || {};
  const carriedValue = Number(ctx.carriedValue) || 0;
  const success = Boolean(ctx.success);
  let progress = 0;
  switch (obj.kind) {
    case OBJECTIVE_KIND.LOOT_COUNT:
      // 只有撤离成功才算"带回"；阵亡时保留局内拾取数作展示，但不算达成。
      progress = success ? (Number(ctx.carriedCount) || 0) : Math.min(obj.target, Number(w.lootTaken) || 0);
      break;
    case OBJECTIVE_KIND.LOOT_VALUE:
      progress = success ? carriedValue : Math.min(obj.target, Number(w.carriedPeak) || 0);
      break;
    case OBJECTIVE_KIND.TERMINAL:
      progress = Number(w.terminalsHacked) || 0;
      break;
    case OBJECTIVE_KIND.HOTSPOT:
      progress = Number(w.hotspotVisits) || 0;
      break;
    case OBJECTIVE_KIND.KILL:
      progress = Number(w.kills) || 0;
      break;
    case OBJECTIVE_KIND.EXTRACT:
      progress = success ? 1 : 0;
      break;
    default:
      progress = 0;
  }
  const done = progress >= obj.target && (obj.kind !== OBJECTIVE_KIND.LOOT_VALUE || success);
  return {
    progress: Math.min(progress, obj.target),
    target: obj.target,
    done,
    text: `${Math.min(progress, obj.target)}/${obj.target}`,
  };
}

/**
 * 结算：把三条目标折算成完成数与评分加成。
 * @param {Array<object>} objectives 目标
 * @param {object} ctx 判定上下文
 * @returns {{items: Array<object>, done: number, bonus: number}}
 */
export function settleObjectives(objectives, ctx = {}) {
  // 非数组一律当空处理：结算页是"最后一屏"，任何脏数据都不能让它白屏。
  const list = Array.isArray(objectives) ? objectives : [];
  const items = list.map((o) => ({ ...o, state: objectiveState(o, ctx) }));
  let done = 0;
  let bonus = 0;
  for (const it of items) {
    if (it.state.done) {
      done += 1;
      bonus += it.score || 0;
    }
  }
  return { items, done, bonus };
}

/**
 * 局内进度（HUD 用）：只统计"能实时看到"的部分，价值目标在撤离前按当前携带估值估算。
 * @param {Array<object>} objectives 目标
 * @param {object} world 战局
 * @param {number} carriedValue 当前携带估值
 * @returns {Array<object>} 带 state 的目标列表
 */
export function liveObjectives(objectives, world, carriedValue = 0) {
  const list = Array.isArray(objectives) ? objectives : [];
  // 「现在就撤」的估算口径：件数取**当前随身件数**（不是累计拾取数）——
  // 累计数会把"拿起来又丢掉"的也算进去，HUD 就会显示 3/3 但实际撤出去只有 2 件。
  const carriedCount = world && world.player && world.player.carriedItems
    ? world.player.carriedItems().length
    : (world && world.lootTaken);
  return list.map((o) => {
    const ctx = { world, carriedValue, success: true, carriedCount };
    const st = objectiveState(o, ctx);
    return { ...o, state: { ...st, done: st.progress >= o.target } };
  });
}

/** 供 UI/调试：层级标签。 */
export const OBJECTIVE_TIER_LABEL = {
  short: '短目标',
  mid: '中目标',
  high: '高风险目标',
};

/** 地图上离出生点最远的终端（供"高风险目标"退化时选点）。 */
export function farthestTerminal(map) {
  const spawn = (map && map.playerSpawn) || { x: 0, y: 0 };
  const list = (map && map.terminals) || [];
  if (!list.length) return null;
  let best = list[0];
  let bd = -1;
  for (const t of list) {
    const d = Math.hypot(t.x - spawn.x, t.y - spawn.y);
    if (d > bd) { bd = d; best = t; }
  }
  return best;
}

/** 目标是否位于某坐标（热点目标用；HUD 画方向时复用）。 */
export function objectivePoint(obj) {
  if (!obj) return null;
  if (obj.hotspot) return { x: obj.hotspot.x, y: obj.hotspot.y, r: obj.hotspot.r };
  return null;
}

/** 供地图 UI：把热点半径换算成格数（不参与逻辑）。 */
export function hotspotRadiusTiles(h) {
  return Math.max(1, Math.round((h.radius || 0) / TILE));
}
