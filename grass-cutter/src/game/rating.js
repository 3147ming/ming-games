/**
 * 局末评级（S / A / B / C）—— **纯函数**，不 import three / 不碰 DOM。
 * ---------------------------------------------------------------------------
 * 为什么单独放一个文件、而不是塞进 main 或 battleHud：
 *   结算数据来自三个地方（stage.elapsed / enemyPool.kills / main 的承伤与无双计数），
 *   如果评分逻辑跟 DOM 混在一起，就只能靠浏览器截图验收。抽成纯函数后，
 *   同输入同输出可以被 node --test 直接钉住，阈值边界也不会"改样式时顺手改坏"。
 *
 * 评分口径：
 *   每个维度先归一化到 0~100，再乘权重得到"该维度贡献分"（满分 = weight × 100）。
 *   总分就是所有贡献分之和 —— 所以 breakdown 里的 score 相加**必然**等于总分，
 *   玩家能看到"为什么是 A 不是 S"，测试也能用这条恒等式防回归。
 *
 * ⚠ 战败局的特殊口径：`elapsed` 不给分。
 *   因为"用时越短越好"只在**通关**时成立；战败时如果照常给时间分，
 *   开局 1 秒送死反而能拿满 25 分时间分（实测：1 秒 0 杀 0 承伤 ≈ 50 分，
 *   差点就是 B）。这不是玩家想要的"综合表现"。战败局去掉时间分后，
 *   理论上限是 75 分（A），S 只可能出现在真正通关的局里。
 *
 * ⚠ 这是**只读结算层**：本文件不修改传入的 stats，也不改任何战斗数值。
 */
import { RATING } from '../core/config.js';

const clamp01 = (n) => (n <= 0 ? 0 : n >= 1 ? 1 : n);

/**
 * 把外部数据收成"非负有限数"。
 * 为什么要这么严：结算发生在游戏结束那一帧，stats 可能来自被改坏的探针、
 * 或者某个维度根本没被赋值。NaN 一旦进入百分比就会让整张结算卡显示 NaN，
 * 而 -1 这种负数如果直接参与归一化，会得到 >100 的分数，把 C 抬成 S。
 * 这里统一按 0 处理（对"越少越好"的维度，0 本来就是最好值，语义仍然安全）。
 */
function safeNumber(value) {
  if (typeof value !== 'number') return 0;
  if (Number.isNaN(value)) return 0;
  if (value === Infinity) return Infinity;
  if (value === -Infinity) return 0;
  return Math.max(0, value);
}

/**
 * 单维度归一化。返回 0~100。
 * better 缺省按 higher 处理：配置里每项都显式写了，缺省只是防御。
 */
function normalize(raw, dim) {
  const full = safeNumber(dim.full);
  const zero = safeNumber(dim.zero);
  // lower：full 是"越快/越少越好"的满分点（可能比 zero 小），span 必须取正
  const span = dim.better === 'lower' ? zero - full : full - zero;
  if (span === 0) return raw === full ? 100 : 0;
  const ratio = dim.better === 'lower' ? (zero - raw) / span : (raw - zero) / span;
  return clamp01(ratio) * 100;
}

/**
 * 按阈值从高到低匹配。最后一项通常是 C/0，所以一定能落到一个档。
 * 用 epsilon 是为了避免 84.99999999999999 这种浮点误差把"刚好 85"判成 A；
 * 这点误差远小于 0.1 分，不会把真正的 84.9 抬成 S。
 */
function resolveGrade(score, thresholds) {
  if (!Array.isArray(thresholds) || thresholds.length === 0) return 'C';
  const ordered = [...thresholds].sort((a, b) => b.min - a.min);
  for (const item of ordered) {
    if (!item || typeof item.grade !== 'string') continue;
    const min = safeNumber(item.min);
    if (score + 1e-9 >= min) return item.grade;
  }
  return ordered[ordered.length - 1]?.grade ?? 'C';
}

/**
 * 计算一局评级。
 * @param {object} stats 结算数据：{ victory, elapsed, kills, damageTaken, maxCombo, musouUses }
 *                       只有显式 `victory: false` 才按战败口径处理；缺省视为通关，
 *                       这样纯函数单测与旧调用方不传 victory 时行为不变。
 * @param {object} cfg   默认读 config.js 的 RATING；单测可传一份小配置
 * @returns {{ grade: string, score: number, breakdown: Array<object> }}
 *
 * breakdown 每项：
 *   { id, label, raw, normalized, weight, score, maxScore, unit, note }
 *   · normalized：0~100 的归一化表现
 *   · score：已乘权重的贡献分（所有 score 相加 = 总分）
 *   · maxScore：该维度满分（weight × 100）
 *   · note：可选说明（例如战败局的用时显示"未通关不计"）
 */
export function computeRating(stats, cfg = RATING) {
  const conf = cfg && Array.isArray(cfg.DIMENSIONS) ? cfg : RATING;
  const data = stats && typeof stats === 'object' ? stats : {};
  const victory = data.victory !== false;

  const breakdown = conf.DIMENSIONS.map((dim) => {
    const raw = safeNumber(data[dim.id]);
    const weight = typeof dim.weight === 'number' && Number.isFinite(dim.weight) && dim.weight > 0
      ? dim.weight
      : 0;
    // 战败局"越快越好"不成立（1 秒送死不能拿时间满分），直接把该维度归零。
    const untimedLoss = dim.id === 'elapsed' && !victory;
    const normalized = untimedLoss ? 0 : normalize(raw, dim);
    return {
      id: dim.id,
      label: dim.label ?? dim.id,
      raw,
      normalized,
      weight,
      // normalized 是 0~100，weight 是 0~1 → 贡献分天然落在 0~weight×100
      score: normalized * weight,
      maxScore: weight * 100,
      unit: dim.unit ?? '',
      note: untimedLoss ? '未通关不计' : '',
    };
  });

  // 不在这里四舍五入：UI 负责显示一位小数，测试则能拿到精确的加权和。
  // 如果这里 round 而 breakdown 不 round，"各项之和 = 总分"这条验收就会假失败。
  const score = breakdown.reduce((sum, item) => sum + item.score, 0);

  return {
    grade: resolveGrade(score, conf.THRESHOLDS),
    score,
    breakdown,
  };
}
