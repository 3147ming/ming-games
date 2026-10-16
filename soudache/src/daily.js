/**
 * 每日任务与登录补给（纯数据 + 刷新逻辑，可在 Node 下测试）。
 */

export const DAILY_POOL = [
  { id: 'd_extract', name: '完成 1 次成功撤离', type: 'extracts', target: 1, reward: 800 },
  { id: 'd_kills', name: '击杀 3 名敌人', type: 'kills', target: 3, reward: 800 },
  { id: 'd_search', name: '搜刮 5 个容器', type: 'searches', target: 5, reward: 800 },
  { id: 'd_value', name: '带出估值不低于 ¥5000 的物资', type: 'value', target: 5000, reward: 900 },
  { id: 'd_raids', name: '突袭 2 局', type: 'raids', target: 2, reward: 700 },
  { id: 'd_terminal', name: '破解 1 个数据终端', type: 'terminals', target: 1, reward: 900 },
];

/** 本地日期串（YYYY-M-D，用于跨天判定） */
export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** 按日期字符串确定性抽 3 条每日任务（同一天结果一致） */
export function pickDaily(dateStr) {
  const seedStr = String(dateStr || todayStr());
  let h = 0;
  for (let i = 0; i < seedStr.length; i += 1) h = (h * 31 + seedStr.charCodeAt(i)) >>> 0;
  const pool = DAILY_POOL.slice();
  const picked = [];
  while (pool.length && picked.length < 3) {
    h = (h * 1664525 + 1013904223) >>> 0;
    picked.push(pool.splice(h % pool.length, 1)[0]);
  }
  return picked.map((t) => ({ ...t }));
}

/** 新一天的每日数据（任务 + 空进度 + 未领取） */
export function newDaily(dateStr) {
  return {
    date: dateStr,
    tasks: pickDaily(dateStr),
    progress: { extracts: 0, kills: 0, searches: 0, value: 0, raids: 0, terminals: 0 },
    claimed: [],
  };
}

/**
 * 跨天刷新：日期变化（或从未初始化）时重开一组任务与进度。
 * 幂等 —— 同一天多次调用不会重置进度。
 * @param {object} save 存档对象（原地修改）
 * @param {string} [date] 日期串，默认今天
 * @returns {boolean} 是否发生了刷新
 */
export function refreshDaily(save, date) {
  const d = String(date || todayStr());
  const cur = save.daily || {};
  if (cur.date === d && Array.isArray(cur.tasks) && cur.tasks.length) return false;
  save.daily = newDaily(d);
  return true;
}

/**
 * 累加每日任务进度。
 * 数值型（value：单局带出估值）取历史最大值，计数型累加。
 * @param {object} save 存档对象
 * @param {string} type 进度类型
 * @param {number} [amount] 增量
 * @returns {void}
 */
export function bumpDaily(save, type, amount = 1) {
  const daily = save.daily;
  if (!daily || !daily.progress) return;
  const prev = daily.progress[type] || 0;
  daily.progress[type] = (type === 'value') ? Math.max(prev, amount) : prev + amount;
}

/**
 * 任务是否达标。
 * @param {object} task 任务定义
 * @param {object} progress 进度对象
 * @returns {boolean} 是否达标
 */
export function dailyTaskDone(task, progress) {
  if (!task || !progress) return false;
  return (progress[task.type] || 0) >= task.target;
}

/**
 * 领取已达标任务的奖励（每个任务只能领一次）。
 * @param {object} save 存档对象
 * @param {string} taskId 任务 id
 * @returns {number} 发放的资金，0 = 不可领取
 */
export function claimDaily(save, taskId) {
  const daily = save.daily;
  if (!daily) return 0;
  const task = (daily.tasks || []).find((t) => t.id === taskId);
  if (!task) return 0;
  if (daily.claimed.includes(taskId)) return 0;
  if (!dailyTaskDone(task, daily.progress)) return 0;
  daily.claimed.push(taskId);
  save.currency += task.reward;
  return task.reward;
}
