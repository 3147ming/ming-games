/* =============================================================================
 * 赵云与阿斗 · 入口 (main.js)
 * ========================================================================== */
(function (ZY) {
  'use strict';
  function boot() {
    ZY.Audio.setMuted(ZY.Save.getMuted());
    ZY.UI.init();
    // 首次交互解锁 WebAudio（浏览器自动播放策略）
    const unlock = function () { ZY.Audio.unlock(); window.removeEventListener('pointerdown', unlock); };
    window.addEventListener('pointerdown', unlock);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window.ZY);
