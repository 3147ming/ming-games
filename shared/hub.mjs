/* =============================================================================
 * ming-games · 跨游戏复玩性 SDK (shared/hub.mjs)
 * -----------------------------------------------------------------------------
 * 定位：方向 A「补全而非新建」的落地件。零依赖、零后端、纯逻辑。
 *
 * 纪律（对齐 wild/src/best.js、challenge.js 的既有口径）：
 *   · 顶层不碰 DOM、不碰 localStorage；所有读写在函数里 try/catch。
 *   · **不迁移、不改写任何游戏的老存档**：只读聚合 + 独立命名空间写统一榜。
 *   · 日期用本地年月日，不用 toISOString（避免东八区串日）。
 *   · 每日种子沿用 'daily-YYYY-MM-DD'，与荒野 WILD / 一世一牌保持一致。
 *   · 任何键缺失 / JSON 损坏 / 隐私模式 → 返回空值，绝不抛错。
 *
 * 边界：动作 / 射击（荒野 WILD、搜打撤、传统割草）由「明」维护，
 *       本 SDK 对其存档**只读**，不修改其代码；OWNER_TAGS 为我负责的 8 个分类。
 * ========================================================================== */

export const VERSION = 1;
export const NS = 'ming.hub.v1';
export const OWNER_TAGS = Object.freeze(['卡牌', '益智', '模拟', '策略', '解谜', '战棋', '街机', '音游']);
export const OTHER_TAGS = Object.freeze(['动作', '射击']);

/* 13 款游戏元数据（与首页 GAMES 单一真源保持一致） */
export const GAMES = Object.freeze([
  { id: 'wild',         name: '荒野 WILD',       tag: '动作', url: 'wild/' },
  { id: 'raid',         name: '搜打撤',           tag: '射击', url: 'soudache/' },
  { id: 'card',         name: '一世一牌',         tag: '卡牌', url: 'one-card/' },
  { id: 'gym',          name: '脑力训练场',       tag: '益智', url: 'brain-gym/' },
  { id: 'sim',          name: '夜班便利店',       tag: '模拟', url: 'night-shift/' },
  { id: 'zhaoyun',      name: '赵云与阿斗',       tag: '策略', url: 'zhaoyun/' },
  { id: 'quiz',         name: '知识问答',         tag: '益智', url: 'quiz/' },
  { id: 'lab',          name: '电路实验模拟器',   tag: '模拟', url: 'circuit-lab/' },
  { id: 'paper-maze',   name: '纸上迷城',         tag: '解谜', url: 'paper-maze/' },
  { id: 'neon-rhythm',  name: '霓虹律动',         tag: '音游', url: 'neon-rhythm/' },
  { id: 'pixel-runner', name: '像素跑酷',         tag: '街机', url: 'pixel-runner/' },
  { id: 'grass-cutter', name: '传统割草游戏',     tag: '动作', url: 'grass-cutter/' },
  { id: 'shanhai',      name: '山海拾遗',         tag: '战棋', url: 'shanhai/' },
  { id: 'trio',         name: '三张牌',           tag: '卡牌', url: 'trio/' },
  { id: 'sudoku',       name: '数独速递',         tag: '益智', url: 'sudoku/' },
  { id: 'slide',        name: '华容道',           tag: '解谜', url: 'slide/' },
  { id: 'brick',        name: '方块消消',         tag: '街机', url: 'brick/' },
  { id: 'diner',        name: '深夜食堂',         tag: '模拟', url: 'diner/' },
  { id: 'territory',    name: '占位棋',           tag: '策略', url: 'territory/' },
  { id: 'tap',          name: '节奏拍打',         tag: '音游', url: 'tap/' },
  { id: 'metro-runner', name: '地铁跑酷',         tag: '街机', url: 'metro-runner/' },
  { id: 'liar', name: '骗子酒馆', tag: '卡牌', url: 'liar/' },
  { id: 'doudizhu', name: '斗地主', tag: '卡牌', url: 'doudizhu/' },
  { id: 'wuyouk', name: '510K', tag: '卡牌', url: 'wuyouk/' },
  { id: 'tongxin', name: '同心', tag: '卡牌', url: 'tongxin/' },
]);

export function isOwner(tag) { return OWNER_TAGS.indexOf(tag) >= 0; }

/* ------------------------------ 基础工具 ------------------------------ */
function ls(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function setLs(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
function jp(raw, def) {
  try { const o = JSON.parse(raw); return (o && typeof o === 'object') ? o : def; }
  catch (e) { return def; }
}
function num(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function size(o) { return (o && typeof o === 'object' && !Array.isArray(o)) ? Object.keys(o).length : 0; }
function maxOf(o, pick) {
  let m = 0;
  if (!o || typeof o !== 'object') return m;
  Object.keys(o).forEach(function (k) { const v = pick(o[k], k); if (Number.isFinite(v) && v > m) m = v; });
  return m;
}
function fmtSec(ms) { return Math.round(num(ms) / 1000) + 's'; }

/** 本地日期 YYYY-MM-DD（与站点 todayKey 同口径，不用 toISOString）。 */
export function todayKey(d) {
  const x = d || new Date();
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
}
/** 统一每日种子：与 wild/src/challenge.js 的 'daily-' + dateKey 完全一致。 */
export function dailySeed(gameId, dateKey) { return 'daily-' + (dateKey || todayKey()); }

/* ------------------------ 统一榜（可选上报通道） ------------------------ *
 * 独立命名空间 ming.hub.v1.board.<gameId>，每款保留前 10 条。
 * 游戏可在结算处 `import { report } from '../shared/hub.mjs'` 后调用；
 * 不调用也完全不影响 —— overview() 会退回读各游戏自己的老存档。
 * ------------------------------------------------------------------------ */
function boardKey(gameId) { return NS + '.board.' + gameId; }

/**
 * 上报一局成绩。
 * @param {{gameId:string, score:number, label?:string, unit?:string,
 *          detail?:string, date?:number, seed?:string}} rec
 * @returns {{board:Array, rank:number, isBest:boolean}}
 */
export function report(rec) {
  if (!rec || !rec.gameId || !Number.isFinite(Number(rec.score))) return { board: getBoard(rec && rec.gameId), rank: 0, isBest: false };
  const entry = {
    date: Number(rec.date) || Date.now(),
    score: Math.max(0, Math.round(Number(rec.score))),
    label: String(rec.label || '本局得分'),
    unit: String(rec.unit || '分'),
    detail: String(rec.detail || ''),
    seed: String(rec.seed || ''),
  };
  const list = getBoard(rec.gameId).slice();
  // 去重：同一毫秒 + 同一分数的结算重绘不重复入榜
  if (!list.some(function (r) { return r.date === entry.date && r.score === entry.score; })) list.push(entry);
  list.sort(function (a, b) { return b.score - a.score || a.date - b.date; });
  if (list.length > 10) list.length = 10;
  setLs(boardKey(rec.gameId), JSON.stringify(list));
  const rank = list.findIndex(function (r) { return r.date === entry.date && r.score === entry.score; }) + 1;
  return { board: list, rank: rank, isBest: rank === 1 };
}

export function getBoard(gameId) {
  if (!gameId) return [];
  const a = jp(ls(boardKey(gameId)), []);
  if (!Array.isArray(a)) return [];
  return a.filter(function (r) { return r && Number.isFinite(Number(r.score)); })
    .map(function (r) {
      return { date: num(r.date), score: num(r.score), label: String(r.label || '本局得分'),
               unit: String(r.unit || '分'), detail: String(r.detail || ''), seed: String(r.seed || '') };
    });
}
export function getBest(gameId) {
  const b = getBoard(gameId);
  return b.length ? b[0] : null;
}

/* -------------------- 老存档只读适配（零侵入） -------------------- *
 * 每款返回 { score, label, unit, note, rows:[{k,v}] } 或 null。
 * score 只用于本款内部排序展示，**不做跨游戏分数比较**（口径不同）。
 * ------------------------------------------------------------------- */
const LEGACY = {
  wild: function () {
    const b = jp(ls('wild.best.v1'), null); const ch = jp(ls('wild.challenge.v1'), null);
    if (!b && !ch) return null;
    const rows = [
      { k: '最长存活', v: b ? Math.round(num(b.bestSec)) + 's' : '—' },
      { k: '最高击杀', v: b ? num(b.bestKills) : '—' },
      { k: '最高等级', v: b ? 'Lv.' + num(b.bestLevel) : '—' },
      { k: '总局数', v: b ? num(b.runs) : '—' },
      { k: '今日挑战', v: ch && ch.best ? num(ch.best.score) + ' 分 / ' + num(ch.runs) + ' 局' : '—' },
    ];
    return { score: num(b && b.bestKills), label: '最高击杀', unit: '杀', note: 'wild.best.v1（只读）', rows: rows };
  },
  raid: function () {
    const s = jp(ls('soudache.save.v1'), null); const st = s && s.stats;
    if (!st) return null;
    return { score: num(st.bestScore), label: '最高分', unit: '分', note: 'soudache.save.v1（只读）', rows: [
      { k: '突袭次数', v: num(st.raids) }, { k: '成功撤离', v: num(st.extracts) },
      { k: '累计击杀', v: num(st.kills) }, { k: '成就', v: size(s.achievements) + ' 个' },
    ] };
  },
  card: function () {
    const m = jp(ls('one-card:save:v1'), null); const d = jp(ls('one-card:daily:v1'), null);
    if (!m && !d) return null;
    return { score: num(m && m.bestFloor), label: '最深节点', unit: '层', note: 'one-card:save:v1（只读）', rows: [
      { k: '轮回局数', v: num(m && m.runs) }, { k: '通关次数', v: num(m && m.wins) },
      { k: '解锁卡牌', v: m && Array.isArray(m.unlockedCards) ? m.unlockedCards.length + ' 张' : '—' },
      { k: '今日之牌', v: d && d.best ? num(d.best.score || d.best.bestFloor) + ' 分' : '—' },
    ] };
  },
  gym: function () {
    const exp = num(ls('bt_exp')); const cnt = jp(ls('bt_cnt'), null);
    if (!exp && !cnt) return null;
    return { score: exp, label: '段位经验', unit: 'EXP', note: 'bt_exp / bt_cnt（只读）', rows: [
      { k: '累计练习', v: cnt ? Object.keys(cnt).reduce(function (a, k) { return a + num(cnt[k]); }, 0) + ' 局' : '—' },
      { k: '段位', v: '第 ' + (num(ls('bt_rank')) + 1) + ' 档' },
      { k: '连续天数', v: (jp(ls('bt_streak'), null) || {}).n || '—' },
      { k: '每日挑战完成', v: num(ls('bt_daily_n')) + ' 次' },
    ] };
  },
  sim: function () {
    const rec = jp(ls('nightshift.records.v1'), null);
    const lb = jp(ls('nightshift.leaderboard.v1'), null);
    if (!rec && !lb) return null;
    let best = 0;
    if (lb) Object.keys(lb).forEach(function (k) {
      if (Array.isArray(lb[k])) lb[k].forEach(function (r) { const v = num(r && (r.score || r.value)); if (v > best) best = v; });
    });
    return { score: best, label: '小游戏最高分', unit: '分', note: 'nightshift.leaderboard.v1（只读）', rows: [
      { k: '本地纪录', v: size(rec) + ' 项' },
      { k: '榜单分类', v: size(lb) + ' 类' },
      { k: '存档', v: 'nightshift.checkpoint.v1' },
    ] };
  },
  zhaoyun: function () {
    const wave = num(ls('zhaoyun_wave_best')); const board = jp(ls('zhaoyun_endless_board'), []);
    const achv = jp(ls('zhaoyun_achv'), null);
    if (!wave && !(Array.isArray(board) && board.length) && !achv) return null;
    return { score: wave, label: '无尽最高波', unit: '波', note: 'zhaoyun_wave_best（只读）', rows: [
      { k: '逐局榜', v: (Array.isArray(board) ? board.length : 0) + ' 条' },
      { k: '总星数', v: (ls('zhaoyun_stars') || '').replace(/[^0-9]/g, '').split('').reduce(function (a, c) { return a + num(c); }, 0) + ' / 40' },
      { k: '成就', v: size(achv) + ' 个' },
      { k: '累计击杀', v: num(ls('zhaoyun_kill_total')) },
    ] };
  },
  quiz: function () {
    const st = jp(ls('bt_qa_stats'), null); const best = jp(ls('bt_qa_best'), null);
    if (!st && !best) return null;
    let n = 0, c = 0;
    if (st) Object.keys(st).forEach(function (k) { n += num(st[k] && st[k].n); c += num(st[k] && st[k].c); });
    return { score: maxOf(best, function (v) { return num(v); }), label: '单类最高分', unit: '分',
      note: 'bt_qa_best / bt_qa_stats（只读）', rows: [
        { k: '累计答题', v: n + ' 题' }, { k: '正确率', v: n ? Math.round(c / n * 100) + '%' : '—' },
        { k: '练过分类', v: size(st) + ' 个' },
      ] };
  },
  lab: function () {
    const prog = jp(ls('lab-sim-progress'), null);
    let circuits = 0;
    try { for (let i = 0; i < localStorage.length; i += 1) { if (String(localStorage.key(i)).indexOf('lab-sim-circuit-') === 0) circuits += 1; } } catch (e) {}
    if (!prog && !circuits) return null;
    return { score: size(prog), label: '打开过的实验', unit: '个', note: 'lab-sim-progress（只读）', rows: [
      { k: '累计打开', v: prog ? Object.keys(prog).reduce(function (a, k) { return a + num(prog[k] && prog[k].openedCount); }, 0) : '—' },
      { k: '保存的电路', v: circuits + ' 份' },
    ] };
  },
  'paper-maze': function () {
    const s = jp(ls('papermaze.save.v1'), null);
    if (!s) return null;
    const endings = s.endings && typeof s.endings === 'object' ? s.endings : {};
    let fastest = 0;
    Object.keys(endings).forEach(function (k) {
      const v = num(endings[k] && endings[k].bestMs);
      if (v > 0 && (!fastest || v < fastest)) fastest = v;
    });
    return { score: size(endings), label: '达成结局', unit: '个', note: 'papermaze.save.v1（只读）', rows: [
      { k: '局数', v: num(s.runs) },
      { k: '最快结局', v: fastest ? fmtSec(fastest) : '—' },
      { k: '累计时长', v: Math.round(num(s.elapsedMs) / 60000) + ' 分钟' },
      { k: '结局图鉴', v: size(endings) + ' 条' },
    ] };
  },
  'neon-rhythm': function () {
    const s = jp(ls('neonrhythm.scores.v1'), null);
    if (!s) return null;
    const charts = s.charts && typeof s.charts === 'object' ? s.charts : {};
    let best = 0, plays = 0, fc = 0;
    const grades = {};
    Object.keys(charts).forEach(function (k) {
      const e = charts[k] || {}; const v = num(e.score); if (v > best) best = v;
      plays += num(e.plays); if (e.fullCombo) fc += 1;
      if (e.grade) grades[e.grade] = (grades[e.grade] || 0) + 1;
    });
    return { score: best, label: '谱面最高分', unit: '分', note: 'neonrhythm.scores.v1（只读）', rows: [
      { k: '已玩谱面', v: Object.keys(charts).length + ' / 12' },
      { k: '总游玩次数', v: plays },
      { k: 'Full Combo', v: fc + ' 张' },
      { k: 'S 评级', v: (grades.S || 0) + ' 张' },
    ] };
  },
  'pixel-runner': function () {
    const s = jp(ls('pixelrunner.save.v1'), null);
    if (!s) return null;
    const best = s.best || {}; const totals = s.totals || {};
    return { score: num(best.score), label: '最高分', unit: '分', note: 'pixelrunner.save.v1（只读）', rows: [
      { k: '总局数', v: num(totals.runs) },
      { k: '最远距离', v: num(best.distance) + ' m' },
      { k: '成就', v: size(s.achievements) + ' 个' },
      { k: '每日赛道', v: size(s.dailyBest) + ' 天' },
    ] };
  },
  'grass-cutter': function () {
    // 该作不写本地存档（局末 S/A/B/C 评级仅当次有效），如实返回 null
    return null;
  },
  shanhai: function () {
    const s = jp(ls('shanhai.save.v1'), null);
    if (!s) return null;
    const cleared = s.cleared && typeof s.cleared === 'object' ? s.cleared : {};
    let bestRating = '';
    const order = ['C', 'B', 'A', 'S'];
    Object.keys(cleared).forEach(function (k) {
      const r = cleared[k] && cleared[k].bestRating;
      if (r && order.indexOf(r) > order.indexOf(bestRating)) bestRating = r;
    });
    return { score: Object.keys(cleared).length, label: '通关关卡', unit: '关',
      note: 'shanhai.save.v1（只读）', rows: [
        { k: '最佳评级', v: bestRating || '—' },
        { k: '通关数', v: Object.keys(cleared).length },
        { k: '最近更新', v: s.updatedAt ? String(s.updatedAt).slice(0, 10) : '—' },
      ] };
  },
  trio: function () {
    const s = jp(ls('mg_trio.v1'), null);
    if (!s) return null;
    return { score: num(s.best), label: '最高金币', unit: '金', note: 'mg_trio.v1（只读）', rows: [
      { k: '总局数', v: num(s.runs) }, { k: '当前连胜', v: num(s.streak) },
      { k: '每日挑战', v: s.daily || '—' },
    ] };
  },
  sudoku: function () {
    const s = jp(ls('mg_sudoku.v1'), null);
    if (!s) return null;
    const best = s.best && typeof s.best === 'object' ? s.best : {};
    let fastest = 0;
    Object.keys(best).forEach(function (k) { const v = num(best[k]); if (v > 0 && (!fastest || v < fastest)) fastest = v; });
    return { score: Object.keys(best).length, label: '通关难度', unit: '档', note: 'mg_sudoku.v1（只读）', rows: [
      { k: '胜局', v: num(s.wins) }, { k: '总局数', v: num(s.runs) },
      { k: '最快用时', v: fastest ? Math.round(fastest / 1000) + 's' : '—' },
      { k: '每日挑战', v: s.daily || '—' },
    ] };
  },
  slide: function () {
    const s = jp(ls('mg_slide.v1'), null);
    if (!s) return null;
    const best = s.best && typeof s.best === 'object' ? s.best : {};
    let fewest = 0;
    Object.keys(best).forEach(function (k) { const v = num(best[k]); if (v > 0 && (!fewest || v < fewest)) fewest = v; });
    return { score: Object.keys(best).length, label: '通关难度', unit: '档', note: 'mg_slide.v1（只读）', rows: [
      { k: '胜局', v: num(s.wins) }, { k: '总局数', v: num(s.runs) },
      { k: '最少步数', v: fewest || '—' }, { k: '每日挑战', v: s.daily || '—' },
    ] };
  },
  brick: function () {
    const s = jp(ls('mg_brick.v1'), null);
    if (!s) return null;
    return { score: num(s.best), label: '最高分', unit: '分', note: 'mg_brick.v1（只读）', rows: [
      { k: '最高关卡', v: num(s.level) }, { k: '总局数', v: num(s.runs) },
      { k: '每日挑战', v: s.daily || '—' },
    ] };
  },
  diner: function () {
    const s = jp(ls('mg_diner.v1'), null);
    if (!s) return null;
    return { score: num(s.best), label: '最佳营收', unit: '分', note: 'mg_diner.v1（只读）', rows: [
      { k: '累计服务', v: num(s.served) }, { k: '营业次数', v: num(s.runs) },
      { k: '每日营业', v: s.daily || '—' },
    ] };
  },
  territory: function () {
    const s = jp(ls('mg_territory.v1'), null);
    if (!s) return null;
    return { score: num(s.wins), label: '胜局', unit: '局', note: 'mg_territory.v1（只读）', rows: [
      { k: '总局数', v: num(s.runs) }, { k: '最佳占子', v: num(s.best) },
      { k: '每日局', v: s.daily || '—' },
    ] };
  },
  liar: function () {
    var s = jp(ls('mg_liar.v1'), null); if (!s) return null;
    return { score: num(s.wins || s.best || 0), label: '胜局', unit: '局', note: 'mg_liar.v1（只读）', rows: [
      { k: '胜局', v: num(s.wins) }, { k: '金币', v: num(s.coin) },
    ] };
  },
  doudizhu: function () {
    var s = jp(ls('mg_ddz.v1'), null); if (!s) return null;
    return { score: num(s.wins || s.best || 0), label: '胜局', unit: '局', note: 'mg_ddz.v1（只读）', rows: [
      { k: '胜局', v: num(s.wins) }, { k: '金币', v: num(s.coin) },
    ] };
  },
  wuyouk: function () {
    var s = jp(ls('mg_510k.v1'), null); if (!s) return null;
    return { score: num(s.wins || s.best || 0), label: '胜局', unit: '局', note: 'mg_510k.v1（只读）', rows: [
      { k: '胜局', v: num(s.wins) }, { k: '金币', v: num(s.coin) },
    ] };
  },
  tongxin: function () {
    var s = jp(ls('mg_tongxin.v1'), null); if (!s) return null;
    return { score: num(s.wins || s.best || 0), label: '胜局', unit: '局', note: 'mg_tongxin.v1（只读）', rows: [
      { k: '胜局', v: num(s.wins) }, { k: '金币', v: num(s.coin) },
    ] };
  },
  'metro-runner': function () {
    var s = jp(ls('mg_metro.v1'), null); if (!s) return null;
    return { score: num(s.best), label: '最高分', unit: '分', note: 'mg_metro.v1（只读）', rows: [
      { k: '最高金币', v: num(s.coinBest) },
    ] };
  },
  tap: function () {
    const s = jp(ls('mg_tap.v1'), null);
    if (!s) return null;
    return { score: num(s.best), label: '最高分', unit: '分', note: 'mg_tap.v1（只读）', rows: [
      { k: '总局数', v: num(s.runs) }, { k: '每日谱面', v: s.daily || '—' },
    ] };
  },
};

export function legacyBest(gameId) {
  try { return LEGACY[gameId] ? LEGACY[gameId]() : null; }
  catch (e) { return null; }
}

/** 统一榜 + 老存档合并的逐局明细（最多 10 条）。 */
export function mergedBoard(gameId) {
  const out = getBoard(gameId).map(function (r) {
    return { score: r.score, label: r.label, unit: r.unit, date: r.date, detail: r.detail, from: '统一榜' };
  });
  try {
    if (gameId === 'zhaoyun') {
      const a = jp(ls('zhaoyun_endless_board'), []);
      if (Array.isArray(a)) a.forEach(function (r) {
        out.push({ score: num(r.wave), label: '无尽波数', unit: '波', date: num(r.date),
                   detail: num(r.kills) + ' 杀 / ' + num(r.dur) + 's', from: '无尽榜' });
      });
    }
    if (gameId === 'sim') {
      const lb = jp(ls('nightshift.leaderboard.v1'), null);
      if (lb) Object.keys(lb).forEach(function (k) {
        if (Array.isArray(lb[k])) lb[k].forEach(function (r) {
          out.push({ score: num(r && (r.score || r.value)), label: k, unit: '分',
                     date: num(r && r.date), detail: String((r && r.name) || ''), from: '夜班榜' });
        });
      });
    }
    if (gameId === 'wild') {
      const ch = jp(ls('wild.challenge.v1'), null);
      if (ch && ch.best) out.push({ score: num(ch.best.score), label: '今日挑战', unit: '分',
        date: num(ch.date) || Date.now(), detail: num(ch.runs) + ' 局', from: '挑战榜' });
    }
  } catch (e) { /* 老存档坏了就只显示统一榜 */ }
  out.sort(function (a, b) { return b.score - a.score || a.date - b.date; });
  return out.slice(0, 10);
}

/** 全局总览：13 款逐一聚合。 */
export function overview() {
  const dateKey = todayKey();
  return GAMES.map(function (g) {
    const legacy = legacyBest(g.id);
    const board = mergedBoard(g.id);
    const unified = getBest(g.id);
    const best = unified || (legacy ? { score: legacy.score, label: legacy.label, unit: legacy.unit } : null);
    return {
      id: g.id, name: g.name, tag: g.tag, url: g.url,
      owner: isOwner(g.tag), dateKey: dateKey, seed: dailySeed(g.id, dateKey),
      best: best, legacy: legacy, board: board,
      state: legacy || board.length ? '有纪录' : (g.id === 'grass-cutter' ? '不适用' : '未开始'),
    };
  });
}

export default { VERSION, NS, GAMES, OWNER_TAGS, OTHER_TAGS, isOwner, todayKey, dailySeed,
                 report, getBoard, getBest, legacyBest, mergedBoard, overview };
