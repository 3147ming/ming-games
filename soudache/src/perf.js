/**
 * V-05 性能预算监控（蓝图阶段 0 · A5）。
 *
 * 纯逻辑采样器：零 DOM / 零 three。调用方每帧喂 dt 与渲染统计，本模块算 p50/p95
 * 帧率并对照预算判定。与 scene3d 的自适应降级（帧慢就降画质）**目的不同、可共存**：
 * 那个负责"自动保帧"，本模块负责"让探针/CI 看见有没有超预算"。
 *
 * TODO(Q-27)：建议默认 桌面60/移动30。无头软件光栅化只能做相对比较，
 * 绝对 fps 门槛交给真机探针，本模块的 draws/triangles 是硬指标、可自动门禁。
 */

/**
 * 性能预算。draws/triangles 来自 three renderer.info，是稳定可比的硬指标；
 * fps 门槛仅作参考（软件渲染下不可靠）。
 */
export const PERF_BUDGET = {
  desktop: { fps: 60, draws: 220, tris: 350000 },
  mobile: { fps: 30, draws: 120, tris: 160000 },
  // 门槛：p50 fps 低于此比例算超预算；draws/tris 超预算值即红。
  p50FloorRatio: 0.9,
};

/** 采样窗口大小（帧数）。120 帧约 2 秒（60fps），足够平滑又不滞后。 */
const WINDOW = 120;

const percentile = (sorted, p) => {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[i];
};

/**
 * 创建帧采样器。
 * @param {object} [opts] { budget: 'desktop'|'mobile', overrides: {fps,draws,tris} }
 */
export function createPerfMonitor(opts = {}) {
  const tier = opts.budget === 'mobile' ? 'mobile' : 'desktop';
  const budget = { ...PERF_BUDGET[tier], ...(opts.overrides || {}) };
  const dts = [];
  const draws = [];
  const tris = [];
  let totalSamples = 0;

  return {
    tier,
    budget: { ...budget },
    /**
     * 喂一帧。dtMs 是帧间隔毫秒；draws/tris 来自 renderer.info.render。
     */
    sample(dtMs, drawCalls, triangles) {
      totalSamples += 1;
      dts.push(Math.max(0, Number(dtMs) || 0));
      draws.push(Math.max(0, Number(drawCalls) || 0));
      tris.push(Math.max(0, Number(triangles) || 0));
      for (const arr of [dts, draws, tris]) if (arr.length > WINDOW) arr.shift();
    },
    reset() {
      dts.length = 0;
      draws.length = 0;
      tris.length = 0;
      totalSamples = 0;
    },
    /** 当前窗口统计 + 超预算判定（纯读，不改状态） */
    snapshot() {
      const sortedDt = [...dts].sort((a, b) => a - b);
      const p50dt = percentile(sortedDt, 0.5);
      const p95dt = percentile(sortedDt, 0.95);
      const fps = (dt) => (dt > 0 ? Math.round((1000 / dt) * 10) / 10 : 0);
      const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
      const avgDraws = Math.round(avg(draws));
      const avgTris = Math.round(avg(tris));
      const fps50 = fps(p50dt);
      const over = {
        fps: dts.length >= 30 && fps50 < budget.fps * PERF_BUDGET.p50FloorRatio,
        draws: avgDraws > budget.draws,
        tris: avgTris > budget.tris,
      };
      return {
        tier,
        samples: totalSamples,
        windowSamples: dts.length,
        fps: { p50: fps50, p95: fps(p95dt) },
        draws: avgDraws,
        triangles: avgTris,
        budget: { ...budget },
        over,
        overAny: over.fps || over.draws || over.tris,
      };
    },
  };
}
