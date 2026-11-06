/**
 * 设备检测与画质分级。
 *
 * 目标：把"手机 / 平板 / 触摸本"与"桌面"区分开，让手机端走虚拟摇杆 + 降档画质，
 * 桌面端原键鼠操作完全不受影响。
 *
 * 判定口径（对真机保守、对误判保守，两头都要防）：
 *   - 优先尊重 URL 覆盖参数：?touch=1 强制手机、?desktop=1 强制桌面（便于本地/无头调试）。
 *   - **移动端 UA 一票判定为触屏**：真机上 pointer 媒体查询会因全屏、外接鼠标、
 *     浏览器实现差异而翻成 fine，曾导致进局后设备被判成桌面、触屏控件根本不创建。
 *   - 其余情况：仅有「coarse 且非 fine 且真有触摸点」→ 触屏；
 *     或「有触摸点 且 UA 含移动关键字」→ 触屏。带触摸屏的笔记本（fine 指针、桌面 UA）保持桌面。
 *
 * 画质三档（P1-9）：
 *   - `low`  ：触屏默认档。像素比 1、关阴影、关尘埃、关后处理 —— 最省电的底限。
 *   - `mid`  ：**仅触屏**且「高 DPR + 多核」时启用（如 dpr>=2 且 >=6 核）。允许 1.25 像素比
 *              与空气尘埃，仍关阴影与后处理。运行时掉帧会逐级降回 low 的表现（见 scene3d.samplePerf）。
 *   - `high` ：桌面。全效果。
 *
 * 无障碍：同时读一次 `prefers-reduced-motion`，命中后全局关闭震屏 / 枪模摆动 / 尘埃 / HUD 闪烁。
 */

/** 读取运行环境的探针（浏览器内取真实对象，Node / 无头测试可用自定义 env 注入）。 */
export function readDeviceEnv() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return {
      matchMedia: () => ({ matches: false }),
      maxTouchPoints: 0,
      userAgent: '',
      search: '',
      devicePixelRatio: 1,
      hardwareConcurrency: 0,
    };
  }
  const nav = typeof navigator === 'undefined' ? null : navigator;
  return {
    matchMedia: (q) => {
      try { return window.matchMedia(q); } catch { return { matches: false }; }
    },
    maxTouchPoints: (nav && nav.maxTouchPoints) || 0,
    userAgent: (nav && nav.userAgent) || '',
    search: (window.location && window.location.search) || '',
    devicePixelRatio: (window.devicePixelRatio || 1),
    hardwareConcurrency: (nav && nav.hardwareConcurrency) || 0,
  };
}

/**
 * 系统是否要求「减少动态效果」（无障碍）。
 * @param {object} [env] 自定义探针（测试用），缺省取浏览器真实环境
 * @returns {boolean} true = 需要关闭震屏 / 摆动 / 闪烁等动态
 */
export function prefersReducedMotion(env) {
  const e = env || readDeviceEnv();
  try {
    return !!(e.matchMedia && e.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

/**
 * 依据环境解析设备分级。
 * @param {object} [env] 自定义探针（测试用），缺省取浏览器真实环境
 * @returns {{ isTouch: boolean, quality: 'low'|'mid'|'high', forced: boolean|null, reducedMotion: boolean }}
 */
export function resolveDeviceTier(env) {
  const e = env || readDeviceEnv();
  const params = new URLSearchParams(e.search || '');
  let forced = null;
  if (params.get('touch') === '1') forced = true;
  else if (params.get('desktop') === '1') forced = false;

  let isTouch;
  if (forced !== null) {
    isTouch = forced;
  } else {
    const coarse = !!(e.matchMedia && e.matchMedia('(pointer: coarse)').matches);
    const fine = !!(e.matchMedia && e.matchMedia('(pointer: fine)').matches);
    const uaMobile = /Mobi|Android|iPhone|iPad|iPod|Mobile/i.test(e.userAgent || '');
    const hasTouch = (e.maxTouchPoints || 0) > 0;
    // 真机 UA 白名单：任何一台手机 / 平板都必须是触屏模式，哪怕媒体查询因为
    // 全屏 / 外接鼠标 / 浏览器实现差异翻成了 fine。这是「手机端动不了」的根因，
    // 所以移动 UA 一旦命中就直接判触屏，不再依赖 pointer 查询。
    const mobileUA = /Android|iPhone|iPad|iPod|Windows Phone|webOS|BlackBerry|Opera Mini|IEMobile/i.test(e.userAgent || '');
    isTouch = mobileUA || (coarse && hasTouch && !fine) || (hasTouch && uaMobile);
  }

  // 中端档判定：只有触屏才可能进 mid。口径刻意保守（高 DPR + 多核才算），
  // 宁可少给一次尘埃，也不要让 4 核老机被塞上装饰性开销。
  const dpr = Number(e.devicePixelRatio) || 1;
  const cores = Number(e.hardwareConcurrency) || 0;
  let quality;
  if (!isTouch) quality = 'high';
  else if (dpr >= 2 && cores >= 6) quality = 'mid';
  else quality = 'low';

  return {
    isTouch,
    quality,
    forced,
    reducedMotion: prefersReducedMotion(e),
  };
}

/** 便捷单例：浏览器启动时调用一次。 */
export function detectDeviceTier() {
  return resolveDeviceTier();
}
