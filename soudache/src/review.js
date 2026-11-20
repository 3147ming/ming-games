/**
 * 结算复盘（纯逻辑 · 零 DOM · 零随机）
 *
 * 目的：把「这一局到底发生了什么」压成几条能读的结论，而不是一屏数字。
 * 为什么独立成模块：结算页是玩家唯一会认真读的界面，文案与判定必须能被单测锁住，
 * 不能散在 ui.js 的模板字符串里靠肉眼维护。
 *
 * 硬约束：
 * - **不写存档**：只返回结构化结果，发钱/发经验仍在 main.endRaid 的唯一入口；
 * - **不改评分公式**：复盘只描述，不参与 score；
 * - 缺字段一律容错（旧探针/手搓 world 也要能出页）。
 */

import { MATCH } from './config.js';
import { TIER_FLOOR } from './areas.js';
import { settleObjectives } from './objectives.js';
import { EXTRACT_KIND, EXTRACT_MOD } from './extract.js';

/** 高价值物的判定门槛：取"高价值区单容器保底"，与掉落分层同一把尺子。 */
export const HIGH_VALUE_THRESHOLD = TIER_FLOOR.high;

/** 撤离方式的中文描述（kind × modifier 组合）。 */
export function extractStyleText(kind, modifier) {
  const base = {
    [EXTRACT_KIND.STANDARD]: '常规撤离',
    [EXTRACT_KIND.FREE]: '免费撤离',
    [EXTRACT_KIND.PAID]: '付费撤离',
    [EXTRACT_KIND.GUARDED]: '守点撤离',
  }[kind] || '撤离';
  const mod = {
    [EXTRACT_MOD.TEMP]: ' · 限时窗口',
    [EXTRACT_MOD.CONDITIONAL]: ' · 条件放行',
    [EXTRACT_MOD.HEAVY]: ' · 轻装',
    [EXTRACT_MOD.HIGH_RISK]: ' · 高危读条',
  }[modifier] || '';
  return base + mod;
}

/**
 * 失败复盘：一句"为什么" + 一句"下一把怎么改"。
 * @param {object} ctx 复盘上下文
 * @returns {{reason:string, advice:string}}
 */
export function failureAdvice(ctx = {}) {
  const reason = String(ctx.reason || 'dead');
  if (reason === 'timeout') {
    return {
      reason: '撤离窗口全部关闭时你还在战区里',
      advice: '常规撤离点开局就开放 —— 提前记住它的方位，别把最后两分钟花在搜刮上',
    };
  }
  if (reason === 'abandon') {
    return { reason: '你主动结束了这次突袭', advice: '放弃不扣评分，但局内物资不会带出' };
  }
  const k = ctx.killedBy;
  if (k && k.type === 'bleed') {
    return {
      reason: '中弹后没有及时止血，失血过多',
      advice: '带够止血带；流血会持续掉血，交火后先处理伤口再继续推进',
    };
  }
  if (k && Number(k.dist) >= 60) {
    return {
      reason: `在 ${Math.round(k.dist)}m 外被远程火力击中`,
      advice: '远距离交火先找掩体再对枪；沿开阔地带移动时保持冲刺断点',
    };
  }
  if (k && Number(k.dist) <= 15) {
    return {
      reason: `在 ${Math.round(k.dist)}m 的近距交火中倒下`,
      advice: '近距离优先腰射而不是开镜；进门前先听脚步，别贴脸转角落',
    };
  }
  if (k) {
    return {
      reason: `被 ${ctx.killerName || '敌方单位'} 击杀（${Math.round(k.dist || 0)}m）`,
      advice: '交火前先确认掩体与退路，血量低于一半就考虑脱离',
    };
  }
  return { reason: '你倒在了战区里', advice: '沿墙推进、减少开阔地停留，能显著降低被集火的概率' };
}

/**
 * 组装复盘条目。
 * @param {object} ctx {
 *   reason, success, carriedValue, lostValue, items, kills, searched, exploredRatio,
 *   duration, time, terminals, contractsDone, contractsTotal, bossDown,
 *   extractKind, extractModifier, extractFee, killedBy, killerName, objectives
 * }
 * @returns {{rows: Array<{key:string,label:string,value:string,tone:string}>,
 *            objectives: object, highlights: Array<string>, advice: ?object}}
 */
export function buildReview(ctx = {}) {
  const success = Boolean(ctx.success);
  const items = Array.isArray(ctx.items) ? ctx.items : [];
  const valueOf = (it) => Number(it && (it.value || (it.def && it.def.value))) || 0;

  // 高价值物：按单价排序，只报件数与最贵那件 —— 一长串清单没人读。
  const highValue = items.filter((it) => valueOf(it) >= HIGH_VALUE_THRESHOLD);
  const priciest = items.slice().sort((a, b) => valueOf(b) - valueOf(a))[0] || null;

  const rows = [];
  const push = (key, label, value, tone = '') => {
    if (value == null || value === '') return;
    rows.push({ key, label, value: String(value), tone });
  };

  // 1) 撤离方式 / 结束方式
  if (success) {
    push('extract', '撤离方式', extractStyleText(ctx.extractKind, ctx.extractModifier), 'ok');
    if (Number(ctx.extractFee) > 0) push('fee', '手续费', `${Math.round(Number(ctx.extractFee))}`, 'dim');
  } else {
    // 只写"怎么结束的"，不写击杀者 / 伤害来源 —— 那是用户明确排除的死亡复盘演出。
    const endText = { dead: '阵亡', timeout: '超时未撤离', abandon: '放弃战局' }[String(ctx.reason)] || '行动失败';
    push('extract', '结束方式', endText, 'danger');
  }

  // 2) 收益
  push('value', success ? '带出价值' : '损失价值',
    `${Math.round(Number(success ? ctx.carriedValue : ctx.lostValue) || 0)}`, success ? 'ok' : 'danger');
  if (items.length) {
    push('highValue', '高价值物',
      highValue.length
        ? `${highValue.length} 件${priciest ? ` · 最贵 ${priciest.name || priciest.id}` : ''}`
        : `0 件（最高 ${priciest ? (priciest.name || priciest.id) : '—'}）`,
      highValue.length ? 'accent' : 'dim');
  }

  // 3) 战斗与搜索
  const kills = Number(ctx.kills) || 0;
  push('kills', '击败', ctx.bossDown ? `${kills}（含首领）` : `${kills}`);
  push('searched', '搜索容器', `${Number(ctx.searched) || 0}`);
  if (ctx.terminals) push('terminals', '破解终端', `${ctx.terminals}`);

  // 4) 探索
  const ratio = Number(ctx.exploredRatio);
  if (Number.isFinite(ratio)) {
    push('explored', '地图探索', `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`);
  }

  // 5) 任务
  const total = Number(ctx.contractsTotal) || 0;
  if (total > 0) push('contracts', '任务', `${Number(ctx.contractsDone) || 0}/${total}`);

  // 6) 目标
  const objectives = settleObjectives(ctx.objectives || [], {
    world: ctx.world || { kills, terminalsHacked: ctx.terminals, hotspotVisits: ctx.hotspotVisits },
    carriedValue: Number(ctx.carriedValue) || 0,
    carriedCount: items.length,
    success,
  });
  if (objectives.items.length) {
    push('objectives', '局内目标', `${objectives.done}/${objectives.items.length}`
      + (objectives.bonus > 0 ? ` · +${objectives.bonus} 分` : ''),
    objectives.done === objectives.items.length ? 'ok' : '');
  }

  // 7) 时长
  const survived = Number(ctx.time);
  if (Number.isFinite(survived)) {
    const mm = Math.floor(survived / 60);
    const ss = Math.floor(survived % 60);
    push('time', '存活时长', `${mm}:${String(ss).padStart(2, '0')} / ${Math.round((MATCH.duration || 480) / 60)}:00`);
  }

  // 8) 失败时给一条可执行的建议（只有一条，不铺开）
  const advice = success ? null : failureAdvice(ctx);
  if (advice) push('advice', '下一把', advice.advice, 'dim');

  const highlights = [];
  if (highValue.length >= 3) highlights.push(`带出 ${highValue.length} 件高价值物资`);
  if (ctx.bossDown) highlights.push('击破本图首领');
  if (objectives.items.length && objectives.done === objectives.items.length) highlights.push('局内目标全达成');
  if (success && Number(ctx.carriedValue) >= 20000) highlights.push('单局带出价值破 2 万');

  return {
    rows,
    objectives,
    highlights,
    advice,
    highValueCount: highValue.length,
    priciest: priciest ? { id: priciest.id, name: priciest.name || priciest.id, value: valueOf(priciest) } : null,
  };
}

/** 把复盘里的目标列表压成 HUD 一行的简短文案。 */
export function objectiveLine(list) {
  return (list || []).map((o) => {
    const st = o.state || { text: `0/${o.target}`, done: false };
    return `${st.done ? '✓' : '·'} ${o.name} ${st.text}`;
  }).join('   ');
}
