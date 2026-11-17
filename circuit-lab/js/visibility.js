/**
 * visibility.js — 页面可见性策略（改进文档·性能项：后台暂停动画帧）
 *
 * 纯函数、零依赖，便于在 Node 环境直接单测，不触碰任何 DOM。
 * 项目里两个「持续 rAF 循环」——3D 自动旋转（view3d.js）与暂态流动点
 * （board.js）——在标签页切到后台时跳过本帧的推进与绘制，只保留极轻的
 * rAF 链由浏览器原生节流；切回前台自动续上，不改任何生命周期/状态机，
 * 也不新增 visibilitychange 监听器（避免多实例与销毁时的清理负担）。
 *
 * 兼容两个信号：标准 visibilityState 与旧式 hidden，任一判定为后台即暂停。
 */

/**
 * 后台标签页是否应暂停本帧的动画工作。
 *
 * @param {object|null|undefined} doc document-like 对象；Node 环境传 undefined 时返回 false
 * @returns {boolean} 任一可见性信号表明页面在后台即为 true
 */
export function shouldPauseFrame(doc) {
  if (!doc) return false;
  return doc.hidden === true || doc.visibilityState === 'hidden';
}
