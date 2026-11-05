/**
 * 结算算术：命中率 / 得分 / 评级
 * 刻意做成不依赖 DOM 与 Three 的纯函数，方便 Node 直接单测。
 */

/** 命中率（0~1）；没开枪时记 0 */
export function computeAccuracy(shots, hits) {
  if (!shots || shots <= 0) return 0;
  const h = Math.max(0, Math.min(shots, hits || 0));
  return h / shots;
}

/**
 * 本局得分
 * 击杀为主，爆头加成，命中率高有奖励；多挨打、拖时间会扣分。
 * @param {{kills:number, headshots:number, shots:number, hits:number, damageTaken:number}} stats
 * @param {number} seconds 本局耗时（秒）
 */
export function computeScore(stats, seconds) {
  const s = stats || {};
  const kills = Math.max(0, s.kills || 0);
  const headshots = Math.max(0, Math.min(kills, s.headshots || 0));
  const accuracy = computeAccuracy(s.shots, s.hits);
  const damage = Math.max(0, s.damageTaken || 0);
  const time = Math.max(0, seconds || 0);

  const raw = kills * 100 + headshots * 60 + accuracy * 500 - damage * 1.5 - time * 2;
  return Math.max(0, Math.round(raw));
}

/**
 * 按阈值挑评级（grades 需从高到低排序）
 * @param {number} score
 * @param {{grade:string, min:number}[]} grades
 */
export function pickGrade(score, grades) {
  if (!Array.isArray(grades) || grades.length === 0) return 'C';
  for (const g of grades) {
    if (score >= g.min) return g.grade;
  }
  return grades[grades.length - 1].grade;
}
