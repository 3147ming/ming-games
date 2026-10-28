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
    /* —— 第一批新增 6 键 ——
     * 旧存档里这 6 个键不存在，所有读取都带默认值（''/{} /[] /0），
     * 不迁移、不清档、不报错；写入一律 try/catch（隐私模式静默失败）。 */
    stars: P + 'stars',         // 8 位星串：第 i 位 = 第 i 关星级（0~5），只增不减
    codex: P + 'codex',         // 图鉴：JSON { 'unit:dao':1, 'hero:zhaoyun':1, ... }
    ascension: P + 'ascension', // 修罗八阵：已解锁的最高层（0~3）
    daily: P + 'daily',         // 今日之战：JSON { date:'YYYY-MM-DD', stars, wave, kills, levelIdx }
    achv: P + 'achv',           // 成就：JSON { id: 解锁时间戳 }
    log: P + 'log',             // 战绩：JSON 数组，最多 20 条（新→旧）
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
  function readStr(k, def) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? def : v;
    } catch (e) { return def; }
  }
  function readJSON(k, def) {
    try {
      const v = localStorage.getItem(k);
      if (!v) return def;
      const o = JSON.parse(v);
      if (!o || typeof o !== 'object') return def;
      return o;
    } catch (e) { return def; }
  }
  function writeJSON(k, o) {
    try { localStorage.setItem(k, JSON.stringify(o)); } catch (e) { /* noop */ }
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

    /* ---------------- 星级（8 位数字串，逐位 0~5，只增不减） ----------------
     * 两种调用口径都支持，避免两个批次各写一套：
     *   getStars()      → 整串 '03500000'（内容批：一次取 8 关）
     *   getStars(i)     → 第 i 关的星级数字（机制批 / ui.js showLevelSelect 在用）
     *   setStar(i, n)   → 写入，只增；setStars(i, n) 是同一函数的别名
     */
    getStars: function (i) {
      const s = readStr(KEYS.stars, '');
      if (i === undefined || i === null) return s;
      const n = parseInt(s.charAt(i), 10);
      return isFinite(n) ? n : 0;
    },
    getStar: function (i) { return Save.getStars(i); },
    setStar: function (i, n) {
      const idx = parseInt(i, 10);
      if (!(idx >= 0 && idx < 8)) return 0;
      const cur = Save.getStar(idx);
      const val = Math.max(0, Math.min(5, parseInt(n, 10) || 0));
      if (val <= cur) return cur;
      let s = readStr(KEYS.stars, '');
      while (s.length <= idx) s += '0';
      s = s.substring(0, idx) + String(val) + s.substring(idx + 1);
      try { localStorage.setItem(KEYS.stars, s); } catch (e) { /* noop */ }
      return val;
    },
    setStars: function (i, n) { return Save.setStar(i, n); },
    getStarTotal: function () {
      let sum = 0;
      for (let i = 0; i < 8; i++) sum += Save.getStar(i);
      return sum;
    },
    getStarMax: function () { return 8 * 5; },

    /* ---------------- 图鉴（只记「见过」，不记次数） ---------------- */
    getCodex: function () { return readJSON(KEYS.codex, {}); },
    hasCodex: function (k) { return !!Save.getCodex()[k]; },
    markCodex: function (k) {
      if (!k) return;
      const c = Save.getCodex();
      if (c[k]) return;
      c[k] = 1;
      writeJSON(KEYS.codex, c);
    },
    codexCount: function (prefix) {
      const c = Save.getCodex();
      let n = 0;
      for (const k in c) if (!prefix || k.indexOf(prefix) === 0) n++;
      return n;
    },

    /* ---------------- 修罗八阵（已解锁的最高层 0~3） ---------------- */
    getAscension: function () {
      const i = readNum(KEYS.ascension, 0);
      return Math.max(0, Math.min(3, i));
    },
    setAscension: function (v) {
      const n = Math.max(0, Math.min(3, parseInt(v, 10) || 0));
      if (n > Save.getAscension()) writeNum(KEYS.ascension, n);
    },

    /* ---------------- 今日之战（按本地日期播种，跨日自动作废） ---------------- */
    todayKey: function () {
      const d = new Date();
      const m = d.getMonth() + 1;
      const day = d.getDate();
      return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
    },
    getDaily: function () {
      const o = readJSON(KEYS.daily, {});
      const t = Save.todayKey();
      if (!o || o.date !== t) return { date: t };
      return o;
    },
    setDailyBest: function (rec) {
      const cur = Save.getDaily();
      const next = { date: cur.date };
      next.stars = Math.max(cur.stars || 0, rec.stars || 0);
      next.wave = Math.max(cur.wave || 0, rec.wave || 0);
      next.kills = Math.max(cur.kills || 0, rec.kills || 0);
      next.levelIdx = (rec.stars || 0) >= (cur.stars || 0) && rec.levelIdx != null ? rec.levelIdx : cur.levelIdx;
      writeJSON(KEYS.daily, next);
      return next;
    },

    /* ---------------- 成就（id → 解锁时间戳，永不回退） ---------------- */
    getAchv: function () { return readJSON(KEYS.achv, {}); },
    hasAchv: function (id) { return !!Save.getAchv()[id]; },
    unlockAchv: function (id) {
      if (!id) return false;
      const a = Save.getAchv();
      if (a[id]) return false;
      a[id] = Date.now();
      writeJSON(KEYS.achv, a);
      return true;
    },

    /* ---------------- 战绩（最近 20 局，新→旧） ---------------- */
    getLog: function () {
      const a = readJSON(KEYS.log, []);
      return Array.isArray(a) ? a : [];
    },
    addLog: function (rec) {
      if (!rec) return;
      const a = Save.getLog();
      a.unshift(rec);
      if (a.length > 20) a.length = 20;
      writeJSON(KEYS.log, a);
    },

    rankName: function (i) { return ZY.RANKS[Math.max(0, Math.min(ZY.RANKS.length - 1, i || 0))]; },
  };

  ZY.Save = Save;
})(window.ZY);
