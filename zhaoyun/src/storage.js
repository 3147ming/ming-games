/* =============================================================================
 * 赵云与阿斗 · 存档 (storage.js)
 * 全部键以 zhaoyun_ 开头；单局过程不存档
 * ========================================================================== */
(function (ZY) {
  'use strict';

  const P = 'zhaoyun_';
  const KEYS = {
    rank: P + 'rank',           // 军衔（下标）
    level: P + 'level',         // 关卡进度（下标，0 = 巨鹿）
    waveBest: P + 'wave_best',  // 无尽最高波数
    killTotal: P + 'kill_total',// 累计击杀
    muted: P + 'muted',         // 静音
  };

  function readNum(k, def) {
    try {
      const v = localStorage.getItem(k);
      if (v === null) return def;
      const n = parseInt(v, 10);
      return isFinite(n) ? n : def;
    } catch (e) { return def; }
  }
  function writeNum(k, v) {
    try { localStorage.setItem(k, String(v)); } catch (e) { /* 隐私模式忽略 */ }
  }

  const Save = {
    KEYS: KEYS,
    getRank: function () {
      const i = readNum(KEYS.rank, 0);
      return Math.max(0, Math.min(ZY.RANKS.length - 1, i));
    },
    setRank: function (i) { writeNum(KEYS.rank, Math.max(0, Math.min(6, i))); },
    getLevel: function () {
      const i = readNum(KEYS.level, 0);
      return Math.max(0, Math.min(ZY.LEVELS.length - 1, i));
    },
    setLevel: function (i) { writeNum(KEYS.level, Math.max(0, Math.min(ZY.LEVELS.length - 1, i))); },
    getWaveBest: function () { return readNum(KEYS.waveBest, 0); },
    setWaveBest: function (v) { if (v > Save.getWaveBest()) writeNum(KEYS.waveBest, v); },
    getKillTotal: function () { return readNum(KEYS.killTotal, 0); },
    addKills: function (v) { writeNum(KEYS.killTotal, Save.getKillTotal() + (v || 0)); },
    getMuted: function () { try { return localStorage.getItem(KEYS.muted) === '1'; } catch (e) { return false; } },
    setMuted: function (v) { try { localStorage.setItem(KEYS.muted, v ? '1' : '0'); } catch (e) { /* noop */ } },
    rankName: function (i) { return ZY.RANKS[Math.max(0, Math.min(ZY.RANKS.length - 1, i || 0))]; },
  };

  ZY.Save = Save;
})(window.ZY);
