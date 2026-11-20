/**
 * 换弹节奏：分段姿态曲线（纯函数 · 零 DOM · 零随机）
 *
 * 为什么抽出来：换弹的枪身姿态同时被 3D 枪模（renderer3d）与音效提示（combat→audio）消费，
 * 如果各写一份，改一个数就会出现"声音到了、枪还没沉下去"。这里保证两边读同一个进度、
 * 同一条曲线。renderer3d 只读 pose，combat 只读 stage，互不推断。
 *
 * 设计约束：
 * - 只依赖进度 p（0~1），不依赖秒数：长短枪的节奏比例一致。
 * - 曲线首尾必须落在 0，且相邻关键帧之间线性插值 —— 保证换弹开始/结束都没有跳变，
 *   即使被打断（切枪、进车）也只是从当前 pose 平滑回正。
 * - 不消耗 rng、不写任何状态。
 */

import { RELOADFX } from './config.js';

const clamp01 = (v) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

/** 分段边界（升序），非法配置时回落一条保底三段线，保证永不返回空。 */
const STAGES = (() => {
  const src = RELOADFX && Array.isArray(RELOADFX.stages) && RELOADFX.stages.length
    ? RELOADFX.stages
    : [];
  if (!src.length) {
    return [
      { key: 'mag-out', at: 0 },
      { key: 'mag-in', at: 0.3 },
      { key: 'charge', at: 0.72 },
    ];
  }
  return src
    .map((s) => ({ key: String(s.key || 'mag-out'), at: clamp01(s.at) }))
    .sort((a, b) => a.at - b.at);
})();

/** 姿态关键帧（按 p 升序，首帧强制为 0、末帧强制为 1）。 */
const POSES = (() => {
  const src = RELOADFX && Array.isArray(RELOADFX.pose) ? RELOADFX.pose : [];
  const list = src.length
    ? src.map((k) => ({
      p: clamp01(k.p),
      drop: Number.isFinite(k.drop) ? k.drop : 0,
      roll: Number.isFinite(k.roll) ? k.roll : 0,
      pump: Number.isFinite(k.pump) ? k.pump : 0,
    }))
    : [{ p: 0, drop: 0, roll: 0, pump: 0 }, { p: 1, drop: 0, roll: 0, pump: 0 }];
  list.sort((a, b) => a.p - b.p);
  return list;
})();

/**
 * 换弹总时长：弹匣打空时额外加罚时（战术换弹更快，这是"别打光"的代价）。
 * @param {object} def 武器定义
 * @param {number} ammo 换弹前的余弹
 * @returns {number} 秒
 */
export function reloadDuration(def, ammo) {
  const base = Math.max(0.1, Number(def && def.reloadTime) || 1);
  const penalty = ammo <= 0 ? (RELOADFX && RELOADFX.emptyPenalty) || 1 : 1;
  return base * penalty;
}

/**
 * 当前进度落在哪一段。
 * @param {number} p 进度 0~1
 * @returns {{key: string, index: number, p: number, local: number}} 段名 / 段序号 / 归一化进度 / 段内进度
 */
export function reloadStage(p) {
  const t = clamp01(p);
  let index = 0;
  for (let i = 0; i < STAGES.length; i += 1) {
    if (t >= STAGES[i].at) index = i;
  }
  const start = STAGES[index].at;
  const end = index + 1 < STAGES.length ? STAGES[index + 1].at : 1;
  const span = Math.max(1e-6, end - start);
  return {
    key: STAGES[index].key,
    index,
    p: t,
    local: clamp01((t - start) / span),
  };
}

/**
 * 由换弹计时器换算进度。总时长非法（缺字段/为 0）时返回 0 —— 宁可显示"刚开始"
 * 也不要跳到"已完成"：跳到尾部会让枪模瞬间回正，看起来像掉帧。
 * @param {number} timer 剩余秒
 * @param {number} total 总秒
 * @returns {number} 进度 0~1
 */
export function reloadProgress(timer, total) {
  const t = Number(total);
  if (!Number.isFinite(t) || t <= 0) return 0;
  return clamp01(1 - (Number(timer) || 0) / t);
}

/**
 * 枪身姿态（倍率）。相邻关键帧线性插值，首尾恒为 0。
 * @param {number} p 进度 0~1
 * @returns {{drop: number, roll: number, pump: number}} 下沉 / 侧翻 / 沿枪轴抖动倍率
 */
export function reloadPose(p) {
  const t = clamp01(p);
  let i = 0;
  while (i < POSES.length - 1 && t > POSES[i + 1].p) i += 1;
  const a = POSES[i];
  const b = POSES[Math.min(POSES.length - 1, i + 1)];
  const span = b.p - a.p;
  const k = span <= 1e-6 ? 0 : (t - a.p) / span;
  const mix = (x, y) => x + (y - x) * k;
  return {
    drop: mix(a.drop, b.drop),
    roll: mix(a.roll, b.roll),
    pump: mix(a.pump, b.pump),
  };
}

/**
 * 全部段的键名（供探针/测试断言顺序，避免各处硬编码字符串）。
 * @returns {string[]} 段名数组
 */
export function stageKeys() {
  return STAGES.map((s) => s.key);
}
