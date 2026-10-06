/**
 * 局内合约：抽取、进度推进与撤离结算
 *
 * 纯逻辑模块 —— 不碰 DOM / localStorage / 音频，可在 Node 下直接单测。
 * 达成时的奖励发放由调用方通过 onComplete 回调自行处理，
 * 这样"进度规则"与"发钱发分的表现"解耦，两边都能独立测试。
 */

import { CONTRACTS, MATCH } from './config.js';

/**
 * 开局抽取本局合约：从 CONTRACTS 里不重复抽 contractCount 条，
 * 并在 target 区间内随机出实际目标值（desc 里的 {n} 一并替换成该值）。
 * @param {object} rng 随机数发生器
 * @returns {Array<object>} 本局合约
 */
export function pickContracts(rng) {
  const pool = CONTRACTS.slice();
  const out = [];
  const count = Math.max(0, Math.min(MATCH.contractCount || 0, pool.length));
  for (let i = 0; i < count; i += 1) {
    // float 上界可能是闭区间，夹一下避免 splice 越界拿到 undefined
    const idx = Math.max(0, Math.min(pool.length - 1, Math.floor(rng.float(0, pool.length))));
    const tpl = pool.splice(idx, 1)[0];
    const target = Math.round(rng.float(tpl.target[0], tpl.target[1]));
    out.push({
      id: tpl.id,
      name: tpl.name,
      type: tpl.type,
      desc: tpl.desc.replace('{n}', target.toLocaleString('en-US')),
      target,
      progress: 0,
      done: false,
      reward: tpl.reward,
      score: tpl.score,
    });
  }
  return out;
}

/**
 * 任务优先级排序（纯函数，UI 与单测共用）。
 *
 * 需求书要求把「周四合约 / 肃清行动 / 死守待援」合并成一个任务面板并按优先级排序。
 * 折叠时只显示 2 条，所以**排在前面的必须是玩家现在最该关心的**：
 *
 *   1. 快完成了的排最前 —— 「再搜 1 个箱子就到 4/4」，这种一眼就能看到头的任务
 *      优先级最高，因为它的边际收益最大（几乎白送的钱与分）。
 *   2. 已完成的沉底 —— 已经没有决策价值了，不该占用宝贵的两行视野。
 *   3. 同档内按 id 字典序，保证**同 seed 同局渲染顺序稳定**。
 *
 * ## 为什么分档而不是直接按 progress 排序
 *
 * progress 每帧都在涨。若排序键直接用 progress，两条进度相近的任务会**每帧交换位置**，
 * 视觉上就是列表在闪 —— 玩家根本没法把视线停在某一条上。
 * 因此把完成度**量化成档位**（≥90% / ≥75% / 其余），档内用 id 定序：
 * 既拿到了"快完成的优先"，又拿到了帧间稳定。
 * 档位阈值 0.9 / 0.75 是有意选的：它们把"再一步就到手"和"还差不少"区分开，
 * 而这个区分对玩家是**有意义**的（决定下一步先搜箱子还是先杀人）。
 *
 * @param {Array<object>} contracts 本局合约
 * @returns {Array<object>} 排序后的新数组（不修改入参）
 */
export function sortTasksByPriority(contracts) {
  if (!Array.isArray(contracts)) return [];
  // 档位：0=临门一脚 1=进展顺利 2=刚起步 3=已完成（沉底）
  const band = (c) => {
    if (c.done) return 3;
    if (!c.target || c.target <= 0) return 2;
    const ratio = c.progress / c.target;
    if (ratio >= 0.9) return 0;
    if (ratio >= 0.75) return 1;
    return 2;
  };
  return contracts
    .map((c, i) => ({ c, i, b: band(c) }))
    .sort((a, b) => (a.b - b.b) || String(a.c.id).localeCompare(String(b.c.id)) || (a.i - b.i))
    .map((w) => w.c);
}

/**
 * 某条合约的当前进度值（只读，不写回）。
 * @param {object} c 合约
 * @param {object} w 战局
 * @returns {number} 进度值
 */
export function contractProgress(c, w) {
  if (c.type === 'kill') return w.kills || 0;
  if (c.type === 'terminal') return w.terminalsHacked || 0;
  if (c.type === 'search') return w.searchedCount || 0;
  if (c.type === 'extractValue') return w.carriedValue || 0;
  if (c.type === 'demolish') return w.cratesBroken || 0;
  if (c.type === 'survival') return w.time || 0;
  return 0;
}

/**
 * 推进合约进度。
 * extractValue（带出估值）只刷新进度、不判达成 —— 必须等真正撤离成功，
 * 由 settleExtractContracts 结算；否则"身上钱够了"会被误判成合约达成。
 * @param {object} w 战局
 * @param {function} onComplete 达成回调 (c) => void
 * @returns {void}
 */
export function updateContracts(w, onComplete) {
  if (!w.contracts || !w.contracts.length) return;
  for (const c of w.contracts) {
    if (c.done) continue;
    const p = contractProgress(c, w);
    c.progress = Math.min(c.target, p);
    if (c.type === 'extractValue') continue;
    if (p >= c.target && typeof onComplete === 'function') onComplete(c);
  }
}

/**
 * 撤离成功时结算「带出估值」类合约。
 * @param {object} w 战局
 * @param {number} lootValue 带出物资估值
 * @param {function} onComplete 达成回调 (c) => void
 * @returns {void}
 */
export function settleExtractContracts(w, lootValue, onComplete) {
  if (!w.contracts) return;
  for (const c of w.contracts) {
    if (c.done || c.type !== 'extractValue') continue;
    c.progress = Math.min(c.target, lootValue);
    if (lootValue >= c.target && typeof onComplete === 'function') onComplete(c);
  }
}
