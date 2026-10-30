// 阶段10·P1-10：每日挑战（同一天同一个种子 + 本地榜）。
//
// ★ 纯逻辑模块：顶层不碰 DOM、不碰 localStorage（只在函数里 try/catch 读写），
//   与 best.js / daily.js 同一套纪律 ⟹ Node 测试里可无头验证。
//
// 设计要点：
//   · 种子 = 'daily-' + YYYY-MM-DD ⟹ 同一天所有人（以及自己的每次重打）刷怪序列一致；
//   · 只留当天：跨天整份重置（不迁移、不累计），与每日任务同语义；
//   · **不写进 wild.best.v1**：那三条是"随便打"的历史最佳，混进固定种子会失真；
//   · 挑战局仍正常发灵魂、正常结算每日/成就（只是纪录另账）。
// ⚠ 阶段11·P0-4 重标了评级刻度（GRADE_CUTS 3200/2000/950 → 12000/6000/2500）与行为分权重：
//   `wild.challenge.v1` 里存的是**当时的分数** ⟹ 改刻度前的挑战分与之后不可比。
//   本批不迁移旧分（只留当天），跨天自然重置；报告里已写明这一点。

const KEY = 'wild.challenge.v1';

/** 当天挑战种子（同一天恒定）。 */
export function challengeSeed(dateKey) {
  return 'daily-' + dateKey;
}

const EMPTY = (dateKey) => ({
  dateKey,
  runs: 0,
  best: { score: 0, kills: 0, survivalSec: 0 },
});

/** 读当天挑战纪录。跨天 / 损坏 / 隐私模式 ⟹ 返回空纪录，绝不抛。 */
export function loadChallenge(dateKey) {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const o = JSON.parse(raw);
      if (o && o.dateKey === dateKey) {
        const b = o.best && typeof o.best === 'object' ? o.best : {};
        return {
          dateKey,
          runs: Math.max(0, Number(o.runs) || 0),
          best: {
            score: Math.max(0, Number(b.score) || 0),
            kills: Math.max(0, Number(b.kills) || 0),
            survivalSec: Math.max(0, Number(b.survivalSec) || 0),
          },
        };
      }
    }
  } catch { /* 忽略，走空纪录 */ }
  return EMPTY(dateKey);
}

/**
 * 提交一局挑战成绩。
 * @param {object} res 结算读数（只读 kills / survivalSec）
 * @param {string} dateKey YYYY-MM-DD
 * @param {number} score 本局总分（main.js 用 scoreOf 算好传进来）
 * @returns {{record:boolean, gap:number, runs:number, best:{score,kills,survivalSec}}}
 *   record=true ⟹ 本局刷新今日最佳；gap=距今日最佳还差多少分（新纪录时为 0）
 */
export function submitChallenge(res, dateKey, score) {
  const prev = loadChallenge(dateKey);
  const s = Math.max(0, Number(score) || 0);
  const kills = Math.max(0, Number(res && res.kills) || 0);
  const sec = Math.max(0, Number(res && res.survivalSec) || 0);
  const next = {
    dateKey,
    runs: prev.runs + 1,
    best: {
      score: Math.max(prev.best.score, s),
      kills: Math.max(prev.best.kills, kills),
      survivalSec: Math.max(prev.best.survivalSec, sec),
    },
  };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* 忽略 */ }
  const record = s > prev.best.score;
  return {
    record,
    gap: record ? 0 : prev.best.score - s,
    runs: next.runs,
    best: next.best,
  };
}
