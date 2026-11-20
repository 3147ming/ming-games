/**
 * 首领战阶段 / 弱点 / 破甲（P16）。
 *
 * 纯逻辑：零 DOM / 零 three / 零随机。所有倍率都写进 Boss 实例的 **def 副本**，
 * 绝不改 `BOSSES` 常量（那会让下一局的 Boss 继承上一局的阶段）。
 *
 * 为什么阶段要以「基础快照」为基准：如果每次切换都在当前 def 上连乘，
 * 三阶段会得到 1.15 × 1.3 = 1.5 之类的失控数值，而且玩家读到的 HUD 数字
 * 与实际不一致。这里把满血时的 def 存进 `e._phaseBase`，每阶段从它重算。
 */

import { BOSS_PHASES, BOSS_RULES } from './config.js';

// UI 需要读同一份阶段表（血条书名与刻度），这里 re-export 避免第二处 import 路径分叉。
export { BOSS_PHASES, BOSS_RULES };

/** 阶段阈值（血量比），从高到低。 */
export const PHASE_RATIOS = BOSS_PHASES.map((p) => p.at);

/**
 * 按血量比取阶段下标。
 * @param {number} ratio 剩余血量比（0~1）
 * @returns {number} 0 / 1 / 2
 */
export function phaseIndexFor(ratio) {
  const r = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 1;
  for (let i = BOSS_PHASES.length - 1; i >= 0; i -= 1) {
    if (r <= BOSS_PHASES[i].at) return i;
  }
  return 0;
}

/**
 * 取阶段定义；越界收敛到首/末阶段。
 * @param {number} index 阶段下标
 * @returns {object} 阶段定义
 */
export function phaseDef(index) {
  return BOSS_PHASES[Math.max(0, Math.min(BOSS_PHASES.length - 1, index | 0))];
}

/**
 * 是否命中弱点（当前口径：Boss 的头部）。
 *
 * 不做「背部核心」之类需要额外朝向计算的部位：`hitscan3D` 只返回高度分段，
 * 凭空造一个不可命中的弱点比没有更糟。头部是玩家已经在瞄的地方，
 * 给它一个明显更高的回报，Boss 战才会从"泼子弹"变成"抓抬手"。
 *
 * @param {object} e 敌人实例
 * @param {string} zone 命中部位
 * @returns {boolean} 是否弱点
 */
export function isWeakspot(e, zone) {
  return Boolean(e && e.isBoss && zone === 'head');
}

/**
 * Boss 的承伤倍率（弱点 + 破甲）。
 * @param {object} e 敌人实例
 * @param {string} zone 命中部位
 * @returns {number} 1 = 无修正
 */
export function bossDamageMul(e, zone) {
  if (!e || !e.isBoss) return 1;
  let mul = 1;
  if (isWeakspot(e, zone)) mul *= BOSS_RULES.weakspotMul;
  if (e.armorBroken) mul *= BOSS_RULES.brokenArmorMul;
  return mul;
}

/**
 * 把阶段倍率写进 Boss 的 def 副本（**以满血快照为基准**）。
 * @param {object} e 敌人实例
 * @param {object} phase 阶段定义
 * @returns {void}
 */
function applyPhase(e, phase) {
  if (!e._phaseBase) {
    // 首次调用时把「进入战斗时的 def」存成基准。注意此时 e.def 可能已经是
    // 风险分级写过的副本（机密/绝密），所以快照要连风险倍率一起带上 ——
    // 这正是"难度与阶段叠加"的期望行为，而不是互相覆盖。
    e._phaseBase = e.def;
  }
  const base = e._phaseBase;
  const w = base.weapon || {};
  e.def = {
    ...base,
    speed: (Number(base.speed) || 0) * phase.speedMul,
    accuracy: Math.min(0.95, (Number(base.accuracy) || 0.4) * phase.accuracyMul),
    fireDelay: [
      (base.fireDelay ? base.fireDelay[0] : 1) * phase.fireDelayMul,
      (base.fireDelay ? base.fireDelay[1] : 2) * phase.fireDelayMul,
    ],
    weapon: { ...w, damage: (Number(w.damage) || 8) * phase.damageMul },
  };
  if (e.weapon) e.weapon = { ...e.weapon, def: e.def.weapon };
}

/**
 * 推进 Boss 阶段。每帧调用；只有真的跨过阈值时才返回事件。
 *
 * @param {object} e 敌人实例（非 Boss 直接返回 null）
 * @returns {{from:number,to:number,def:object}|null} 阶段变化事件
 */
export function syncBossPhase(e) {
  if (!e || !e.isBoss || e.dead) return null;
  const idx = phaseIndexFor((e.hp || 0) / Math.max(1, e.maxHp || 1));
  if (e.bossPhaseIndex == null) {
    // 初始化：进入战局时就是阶段 I，不触发演出。
    e.bossPhaseIndex = idx;
    e.bossPhase = phaseDef(idx).id;
    applyPhase(e, phaseDef(idx));
    return null;
  }
  if (idx === e.bossPhaseIndex) return null;
  const from = e.bossPhaseIndex;
  e.bossPhaseIndex = idx;
  const def = phaseDef(idx);
  e.bossPhase = def.id;
  applyPhase(e, def);
  return { from: phaseDef(from).id, to: def.id, def };
}

/**
 * 结算一次 Boss 受击后的护甲状态：本击是否刚好打空护甲。
 *
 * 只对 Boss 生效 —— 普通敌人 P7 的护甲耐久逻辑保持不变，
 * 这一条是为了让破甲有一个可播报的瞬间，而不是通用伤害公式改造。
 *
 * @param {object} e 敌人实例
 * @param {number} armorBefore 本次命中前的护甲值
 * @returns {boolean} 本击是否首次破甲
 */
export function checkArmorBreak(e, armorBefore) {
  if (!e || !e.isBoss) return false;
  if (e.armorBroken) return false;
  if (!(Number(armorBefore) > 0)) return false;
  if ((Number(e.armor) || 0) > 0) return false;
  e.armorBroken = true;
  return true;
}
