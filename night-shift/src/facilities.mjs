/**
 * 可玩娱乐设施 —— 设施层的单一真源
 *
 * config.FACILITIES 只描述"是什么、在哪"，这里补出"怎么与之交互"：
 *   - FACILITY_BY_ID：id → 设施（minigames.mjs / interaction.mjs 查表用）
 *   - standPos()：玩家游玩站位（默认设施正面 1.35m；可在 config 里显式指定）
 *   - hitBox()：交互判定盒（**必须覆盖眼高**，否则平视时射线从顶面掠过 → 走近了却打不中）
 *   - facilityCost()：投币额（取自 config.MINIGAME[kind].cost）
 *
 * 新增同类设施只需：config.FACILITIES 加一条 + config.MINIGAME 加参数（若复用已有 kind 则连参数都不用加）。
 */
import { FACILITIES, POND, MINIGAME } from './config.mjs';

export const FACILITY_BY_ID = Object.fromEntries(FACILITIES.map((f) => [f.id, f]));

/**
 * 需求I 第⑦条：店铺扩建带来的新设施要进这张表，
 * interaction / main 才能按 id 查到它（既有 5 台的逻辑一行都不用改）。
 * @returns 本次新增的设施（已存在的会被跳过，重复解锁不会覆盖）
 */
export function registerFacilities(list) {
  const added = [];
  for (const f of list ?? []) {
    if (!f || !f.id || FACILITY_BY_ID[f.id]) continue;
    FACILITY_BY_ID[f.id] = f;
    added.push(f);
  }
  return added;
}

/** 判定盒高度与 y：与 config.INTERACT_BOX 同一原则 —— 顶面 2.6m > 眼高 1.65m */
export const FACILITY_HIT = { pad: 0.5, h: 2.6, y: 1.3 };

/**
 * 玩家游玩站位：config 显式给了 standX/standZ 就用它（如钓鱼池塘在岸边），
 * 否则取设施正面（rot=0 时朝 +Z）向外 0.95m。
 */
export function standPos(fac) {
  if (Number.isFinite(fac.standX) && Number.isFinite(fac.standZ)) {
    return { x: fac.standX, z: fac.standZ };
  }
  const dist = (fac.d ?? 1) / 2 + 0.95;
  const rot = fac.rot ?? 0;
  return { x: fac.x + Math.sin(rot) * dist, z: fac.z + Math.cos(rot) * dist };
}

/** 交互判定盒尺寸（世界坐标；group 会带 rot，AABB 由 THREE 自动换算） */
export function hitBox(fac) {
  if (fac.kind === 'fishing') {
    // 池塘：整片水面都是"钓鱼点"，站在任意岸边都能触发
    return { w: POND.w, d: POND.d, h: FACILITY_HIT.h, y: FACILITY_HIT.y };
  }
  return {
    w: (fac.w ?? 1) + FACILITY_HIT.pad,
    d: (fac.d ?? 1) + FACILITY_HIT.pad,
    h: FACILITY_HIT.h,
    y: FACILITY_HIT.y,
  };
}

/** 投币额（免费设施返回 0） */
export function facilityCost(fac) {
  return MINIGAME[fac.kind]?.cost ?? 0;
}

/** 设施的小游戏参数 */
export function facilityParams(fac) {
  return MINIGAME[fac.kind] ?? {};
}
