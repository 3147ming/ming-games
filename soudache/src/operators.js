/**
 * 干员档案与技能状态机（P5-C1）。
 *
 * 职责边界：本模块只有**数据与纯函数**，不 import 渲染 / 输入 / DOM。
 * 于是 node 里可以直接单测"打空一个弹匣能充多少能量""两发战术道具之间的冷却"，
 * 而不需要跑浏览器；HUD、主循环、投掷物系统都只读这里算出来的数。
 *
 * 技能模型的取舍：
 * - 战术道具是**充能制**（charges 多格 + 每格独立冷却），不是"用一次等一次"。
 *   三角洲的战术道具同样是多格充能，玩家能在开战前攒满两发，打起来才有节奏。
 * - 终结技是**能量制**：击杀给大头、命中给零头、随时间缓慢自增。
 *   不给"纯冷却"，否则玩家会掐着表等 CD 而不是围绕战斗决策。
 *
 * 计数值一律是「秒」和「点」，不出现帧数 —— 与 RELOADFX / RECOIL 的口径保持一致。
 */

import { ABILITY } from './config.js';

/**
 * 干员档案。四人各自绑定一种战术道具与一个终结技，被动直接改写既有系统的一个乘数。
 *
 * 命名约束：全部为本地原创呼号，不使用任何《三角洲行动》干员的名字 / 代号 / 立绘设定，
 * 只沿用"每人一个战术 + 一个终结 + 一条被动"这套设计语言。
 *
 * 字段说明：
 * - tactical.id 指向 throwable.js 的 THROWABLE_TYPES
 * - tactical.count / cd 是初始充能格数与每格回充秒数
 * - ultimate.id 由 main.js 的 releaseUltimate 分支消费
 * - perk.mods 是**乘数表**，由 startRaid 一次性写进 Player 的同名字段
 */
export const OPERATORS = [
  {
    id: 'vulcan',
    code: 'VULCAN',
    callsign: '火神',
    role: 'ASSAULT',
    roleName: '突击',
    color: '#E2574C',
    tactical: { id: 'frag', count: 2, cd: 18 },
    ultimate: { id: 'overdrive', name: '火力全开', code: 'OVERDRIVE', dur: 7 },
    perk: {
      id: 'fast-reload',
      name: '快速换弹',
      desc: '换弹速度 +14%',
      mods: { reloadMul: 0.86 },
    },
    bio: '正面破点的人。两枚破片先把掩体后的人赶出来，再用七秒的压制窗口把缺口撕开。',
    tacticalLine: '破片手雷 ×2 · 18s 回充',
    ultimateLine: '7 秒内散布 −75%、后坐 −55%、伤害 +15%',
  },
  {
    id: 'veil',
    code: 'VEIL',
    callsign: '帷幕',
    role: 'RECON',
    roleName: '侦察',
    color: '#4FB3C8',
    tactical: { id: 'smoke', count: 2, cd: 20 },
    ultimate: { id: 'eagle', name: '鹰眼', code: 'EAGLE EYE', dur: 9 },
    perk: {
      id: 'low-signature',
      name: '低可探测',
      desc: '敌人对你的发现距离 −18%',
      mods: { stealthMul: 0.82 },
    },
    bio: '不靠枪法靠信息。烟幕切断对方视线，鹰眼把整张图的敌人摊在你眼前。',
    tacticalLine: '烟幕弹 ×2 · 20s 回充',
    ultimateLine: '9 秒内全场敌人被标记（小地图 + 轮廓）',
  },
  {
    id: 'pulse',
    code: 'PULSE',
    callsign: '脉冲',
    role: 'SUPPORT',
    roleName: '支援',
    color: '#5DAF7E',
    tactical: { id: 'flash', count: 2, cd: 16 },
    ultimate: { id: 'aegis', name: '战地急救', code: 'AEGIS', dur: 6 },
    perk: {
      id: 'field-medic',
      name: '战地医术',
      desc: '医疗品效果 +30%',
      mods: { healMul: 1.3 },
    },
    bio: '把队友从"差一枪"拉回来的人。震撼弹开道，急救把血线与护甲一起补上。',
    tacticalLine: '震撼弹 ×2 · 16s 回充',
    ultimateLine: '立即 +35 HP / +25 护甲，随后 6 秒持续回血',
  },
  {
    id: 'cinder',
    code: 'CINDER',
    callsign: '余烬',
    role: 'CONTROL',
    roleName: '控场',
    color: '#D9822B',
    tactical: { id: 'incendiary', count: 2, cd: 22 },
    ultimate: { id: 'pyre', name: '火环', code: 'PYRE', dur: 8 },
    perk: {
      id: 'ordnance',
      name: '爆破专精',
      desc: '投掷物冷却 −20%',
      mods: { tacCdMul: 0.8 },
    },
    bio: '用地形杀人。燃烧弹封住唯一的通道，火环把守点的人从掩体里逼出来。',
    tacticalLine: '燃烧弹 ×2 · 22s 回充',
    ultimateLine: '脚下生成 6 米火环，持续 8 秒',
  },
];

export const DEFAULT_OPERATOR_ID = 'vulcan';

/**
 * 按 id 取干员；未知 id 回落到默认干员（旧存档 / 手改坏值都不会让开局崩掉）。
 * @param {string} id 干员 id
 * @returns {object} 干员档案
 */
export function getOperator(id) {
  return OPERATORS.find((o) => o.id === id) || OPERATORS.find((o) => o.id === DEFAULT_OPERATOR_ID);
}

/**
 * 干员被动写进玩家字段的乘数表。缺字段的旧干员（或测试手搓的对象）一律补成 1，
 * 让读取侧永远可以无条件相乘，不必到处写 `|| 1`。
 * @param {object} op 干员档案
 * @returns {{reloadMul:number, stealthMul:number, healMul:number, tacCdMul:number}} 乘数表
 */
export function perkMods(op) {
  const m = (op && op.perk && op.perk.mods) || {};
  return {
    reloadMul: Number.isFinite(m.reloadMul) ? m.reloadMul : 1,
    stealthMul: Number.isFinite(m.stealthMul) ? m.stealthMul : 1,
    healMul: Number.isFinite(m.healMul) ? m.healMul : 1,
    tacCdMul: Number.isFinite(m.tacCdMul) ? m.tacCdMul : 1,
  };
}

/**
 * 新建一份技能状态。
 *
 * 字段名刻意与 P1 的 HUD 契约对齐：`tactical.cd / cdMax` 与 `ultimate.cd / cdMax`
 * 是绘制层唯一读取的两组数（ratio = 1 - cd/cdMax），所以状态机直接产出这个形状，
 * 不需要再写一层 view model，也就不会出现"两处各算一次进度"的漂移。
 *
 * @param {object} op 干员档案
 * @returns {object} 技能状态
 */
export function createAbilityState(op) {
  const mods = perkMods(op);
  const tacCd = Math.max(1, op.tactical.cd * mods.tacCdMul);
  const max = ABILITY.ultMax;
  return {
    operatorId: op.id,
    tactical: {
      charges: op.tactical.count,
      max: op.tactical.count,
      cd: 0,
      cdMax: tacCd,
      type: op.tactical.id,
      name: op.tactical.name || '',
    },
    ultimate: {
      charge: 0,
      max,
      cd: max,
      cdMax: max,
      ready: false,
      id: op.ultimate.id,
      name: op.ultimate.name,
      dur: op.ultimate.dur,
    },
    // 终结技生效剩余秒（渲染 / HUD 读它决定是否高亮）
    ultT: 0,
  };
}

/**
 * 推进技能状态一帧。
 *
 * 战术道具按"格"回充：只要没满，cd 就一直走；回满一格后如果还缺格，立刻接上下一格。
 * 这样两格之间不会出现"第一格满了一直停着等玩家用"的空转。
 *
 * @param {object} st 技能状态
 * @param {number} dt 步长（秒）
 * @returns {{tacReady:boolean}} 本帧是否有新的一格回充完成（供音效 / HUD 闪一下）
 */
export function tickAbilities(st, dt) {
  if (!st || !st.tactical) return { tacReady: false };
  const t = st.tactical;
  let tacReady = false;
  if (t.charges < t.max) {
    t.cd -= dt;
    if (t.cd <= 0) {
      t.charges = Math.min(t.max, t.charges + 1);
      tacReady = true;
      t.cd = t.charges < t.max ? t.cdMax : 0;
    }
  } else {
    t.cd = 0;
  }
  if (st.ultT > 0) st.ultT = Math.max(0, st.ultT - dt);
  return { tacReady };
}

/**
 * 能否投掷战术道具。
 * @param {object} st 技能状态
 * @returns {boolean} 有充能即可
 */
export function canThrowTactical(st) {
  return !!st && !!st.tactical && st.tactical.charges > 0;
}

/**
 * 消耗一格战术道具；成功时若当前没有在跑的冷却就起一格。
 * @param {object} st 技能状态
 * @returns {boolean} 是否消耗成功
 */
export function consumeTactical(st) {
  if (!canThrowTactical(st)) return false;
  const t = st.tactical;
  t.charges -= 1;
  if (t.cd <= 0) t.cd = t.cdMax;
  return true;
}

/**
 * 增加终结技能量。
 * @param {object} st 技能状态
 * @param {number} amount 增加点数
 * @returns {boolean} 本次是否刚刚充满
 */
export function addUltCharge(st, amount) {
  if (!st || !st.ultimate) return false;
  const u = st.ultimate;
  if (amount <= 0 || u.ready) return false;
  u.charge = Math.min(u.max, u.charge + amount);
  u.cd = u.max - u.charge;
  if (u.charge >= u.max) {
    u.ready = true;
    return true;
  }
  return false;
}

/**
 * 释放终结技：必须是已充满状态。
 * @param {object} st 技能状态
 * @returns {boolean} 是否释放成功
 */
export function consumeUltimate(st) {
  if (!st || !st.ultimate || !st.ultimate.ready) return false;
  const u = st.ultimate;
  u.charge = 0;
  u.cd = u.max;
  u.ready = false;
  st.ultT = Math.max(0.1, u.dur || 0);
  return true;
}

/**
 * 终结技能量来源表。集中在一处，方便调平衡时只改这张表。
 * @param {'kill'|'hit'|'hurt'} kind 来源
 * @returns {number} 点数
 */
export function ultGain(kind) {
  switch (kind) {
    case 'kill': return ABILITY.ultKill;
    case 'hit': return ABILITY.ultHit;
    case 'hurt': return ABILITY.ultHurt;
    default: return 0;
  }
}

/**
 * 被动表里没有的字段（例如 stealth）在玩家身上也要有默认值 1，
 * 否则敌人的视野判定会读到 undefined 而把范围乘成 NaN。
 * @param {object} player 玩家
 * @param {object} op 干员档案
 * @returns {object} 同一个 player（便于链式调用）
 */
export function applyOperator(player, op) {
  const mods = perkMods(op);
  player.operatorId = op.id;
  player.callsign = `${op.callsign} / ${op.code}`;
  player.reloadMul = mods.reloadMul;
  player.stealthMul = mods.stealthMul;
  player.healMul = mods.healMul;
  player.tacCdMul = mods.tacCdMul;
  return player;
}

/**
 * 小队编成（P15）：把存档里的干员 id 列表解析成**两席**真实干员对象。
 *
 * 规则（三条都为了「旧档/坏档也能开局」）：
 * 1. 玩家当前干员不能出现在 AI 席位里 —— 否则局内会出现两个同代号单位。
 * 2. 未知 id 直接丢弃，不抛错（删干员/手改存档都不该让部署失败）。
 * 3. 不足两席时按 `OPERATORS` 顺序补默认 —— 空数组 `[]` 得到的结果与 P14
 *    `OPERATORS.filter(o => o.id !== 玩家).slice(0, 2)` **完全一致**，
 *    所以旧存档的行为逐位不变。
 *
 * @param {Array<string>} squadIds 存档里的干员 id 列表
 * @param {string} operatorId 玩家当前干员 id
 * @returns {Array<object>} 长度恒为 min(2, 可用干员数) 的干员对象数组
 */
export function resolveSquadIds(squadIds, operatorId) {
  const pool = OPERATORS.filter((o) => o.id !== operatorId);
  const picked = [];
  for (const id of (Array.isArray(squadIds) ? squadIds : [])) {
    const op = pool.find((o) => o.id === id);
    if (op && !picked.includes(op)) picked.push(op);
    if (picked.length === 2) break;
  }
  for (const op of pool) {
    if (picked.length === 2) break;
    if (!picked.includes(op)) picked.push(op);
  }
  return picked.slice(0, 2).map((o) => o);
}

/**
 * 换席（P15）：把 `slot` 席换成 `pickId`，若另一席已占该干员则**交换**。
 *
 * 交换而不是覆盖，是因为「两席同人」在局内是肉眼可见的 bug（两个一模一样的
 * 队友代号），而静默拒绝又会让玩家以为按钮坏了。点自己则幂等返回。
 *
 * @param {Array<string>} squadIds 当前存档
 * @param {string} operatorId 玩家干员 id
 * @param {number} slot 0 或 1
 * @param {string} pickId 目标干员 id
 * @returns {Array<string>} 归一化后的两席 id
 */
export function assignSquadSlot(squadIds, operatorId, slot, pickId) {
  const cur = resolveSquadIds(squadIds, operatorId).map((o) => o.id);
  const idx = slot === 1 ? 1 : 0;
  if (!OPERATORS.some((o) => o.id === pickId) || pickId === operatorId) return cur;
  const prev = cur[idx];
  if (prev === pickId) return cur; // 点自己：幂等
  const clash = cur[1 - idx] === pickId;
  cur[idx] = pickId;
  if (clash) cur[1 - idx] = prev; // 交换，绝不出现两席同人
  return cur;
}
