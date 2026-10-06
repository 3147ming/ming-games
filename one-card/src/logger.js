// 真人试玩埋点（只读观测层，阶段 4 / T2）
//
// ── 铁律（破坏任何一条就等于动了玩法，会立刻被 tests/logger.test.mjs 抓出来）──
//   ① **默认关**：必须显式 ?log=1 或 localStorage flag 才开。
//   ② **不消费 RNG**：不碰 run.rng，不调用任何抽牌/加权/洗牌函数。
//   ③ **不改 Run 状态**：不写 hp / deck / relicIds / map / phase / outcome 任何一个字段。
//   ④ **失败无声**：整层 try/catch 全包，埋点出错绝不能让游戏崩。
//   ⟹ 由此保证：同一 seed 在「开埋点」与「关埋点」下的终态逐字段完全相等。
//
// 为什么 recorder 只放在这里：Run 是「一局游戏」的唯一状态源，任何写操作都可能被后续逻辑读到。
// 把观测代码集中在独立的只读模块里，可以让"这是观测、不是规则"这件事在代码层面成立，而不是靠注释保证。
//
// 唯一一处对 Run 的加法成本：`run.restChoices` —— 一个只被本层读取的记录数组，
// 不参与任何结算分支，不参与 RNG。详见 src/run.js 里的注释。

import { ARCHETYPE_MAP } from '../config/archetypes.js';

export const LOG_FLAG_KEY = 'onecard.log';
export const PLAYER_FLAG_KEY = 'onecard.player';

/**
 * 解析埋点开关。
 * envOverride 存在时优先用它（便于 Node 侧测试）；否则用 globalThis 里的 location / localStorage。
 * Node 环境（tools/balance.mjs、--test）里两者都不存在 ⟹ on = false ⟹ 整层完全不执行。
 */
export function resolveLogEnv(envOverride) {
  const g = envOverride || (typeof globalThis !== 'undefined' ? globalThis : {});
  const out = { on: false, player: '' };
  try {
    const search = g.location && typeof g.location.search === 'string' ? g.location.search : '';
    let urlOn = false;
    let urlPlayer = '';
    if (search && typeof g.URLSearchParams === 'function') {
      const p = new g.URLSearchParams(search);
      urlOn = p.get('log') === '1' || p.get('log') === 'true';
      urlPlayer = p.get('player') || '';
    }
    let storeOn = false;
    let storePlayer = '';
    const ls = g.localStorage;
    if (ls && typeof ls.getItem === 'function') {
      storeOn = ls.getItem(LOG_FLAG_KEY) === '1';
      storePlayer = ls.getItem(PLAYER_FLAG_KEY) || '';
    }
    out.on = urlOn || storeOn;
    out.player = urlPlayer || storePlayer || '';
  } catch (_) {
    // 环境解析失败一律当作「关」，且绝对不向上抛
    out.on = false;
    out.player = '';
  }
  return out;
}

/**
 * 组装一行埋点记录。纯函数：只读 run，不写、不抽 RNG。
 * 字段口径：
 *   player       手填（?player=xxx 或 localStorage onecard.player），未填为 null
 *   runIndex     该次 Run 是第几局（meta.runs，finish 里已自增）
 *   durationSec  开局 → finish 的墙钟秒数（★★这不等于玩法时长，含玩家思考时间）
 *   deathNode    死在第几个节点（1~12）；**通关恒为 0**
 *   cleared      outcome === 'cleared'
 *   keyCardsGot  终局牌组里本流派 keyCards 的张数（可重复）
 *   restChoice   唯一的灯下节点选了什么：'heal' | 'remove' | null（没走到灯下就死了）
 *   selfDifficulty / didPush  结算页手填，默认 null
 */
export function buildRunLog(run, envOverride) {
  const env = resolveLogEnv(envOverride);
  const arch = ARCHETYPE_MAP[run.archetypeId];
  const keySet = new Set((arch && arch.keyCards) || []);
  let keyCardsGot = 0;
  for (const inst of run.deck) if (keySet.has(inst.cid)) keyCardsGot += 1;
  const cleared = run.outcome === 'cleared';
  // 防御：startedAt 缺失时 Date.now() - undefined = NaN，Math.round(NaN) 会落成 null 但**静默不可信**。
  // 显式写 null（并保留原值语义），比让 JSON 里出现一个莫名的 null 更诚实（阶段 4 夜报 G-N4）。
  const durMs = Date.now() - run.startedAt;
  return {
    player: env.player || null,
    arch: run.archetypeId,
    runIndex: run.meta ? run.meta.runs : 0,
    seed: run.seed,
    durationSec: Number.isFinite(durMs) ? Math.round(durMs / 1000) : null,
    deathNode: cleared ? 0 : run.cleared,
    cleared,
    keyCardsGot,
    restChoice: run.restChoices && run.restChoices.length ? run.restChoices[run.restChoices.length - 1] : null,
    selfDifficulty: null,
    didPush: null,
    ts: new Date().toISOString(),
  };
}

/** 结算时输出一行 JSON。关则直接返回 null（零副作用）。 */
export function emitRunLog(run, envOverride) {
  try {
    const env = resolveLogEnv(envOverride);
    if (!env.on) return null;
    const rec = buildRunLog(run, envOverride);
    const g = envOverride || globalThis;
    if (!g.__ONECARD_LOGS) g.__ONECARD_LOGS = [];
    g.__ONECARD_LOGS.push(rec);
    g.__ONECARD_LAST_LOG = rec;
    if (g.console && typeof g.console.info === 'function') g.console.info('[ONECARD] ' + JSON.stringify(rec));
    return rec;
  } catch (_) {
    return null;
  }
}

/** 取最近一条记录（结算页回填用）。 */
export function lastLog(envOverride) {
  try {
    const g = envOverride || globalThis;
    return g.__ONECARD_LAST_LOG || null;
  } catch (_) {
    return null;
  }
}

/**
 * 回填结算页手填字段（selfDifficulty / didPush）。
 * 直接改内存里那一行的对象 —— 一局仍然只有一条记录，不会因为回填而多出一行 JSONL。
 */
export function amendLastLog(patch, envOverride) {
  try {
    const env = resolveLogEnv(envOverride);
    if (!env.on) return null;
    const g = envOverride || globalThis;
    const rec = g.__ONECARD_LAST_LOG;
    if (!rec) return null;
    Object.assign(rec, patch);
    if (g.console && typeof g.console.info === 'function') g.console.info('[ONECARD:amend] ' + JSON.stringify(rec));
    return rec;
  } catch (_) {
    return null;
  }
}

/** 导出 JSONL（一行一条），试玩回收数据用。 */
export function dumpJsonl(envOverride) {
  try {
    const g = envOverride || globalThis;
    return (g.__ONECARD_LOGS || []).map((r) => JSON.stringify(r)).join('\n');
  } catch (_) {
    return '';
  }
}
