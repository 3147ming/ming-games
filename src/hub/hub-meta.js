/* hub-meta.js — 新大厅元系统 UI：成就 / 排行榜 / 每日挑战
 * 依赖：globalThis.HubSDK（由 src/hub/hub-sdk.js 注入，与 shared/hub.mjs 同源）
 *       globalThis.__HUB_GAMES__（16 款清单，构建期注入）
 * 原则：只读聚合本机存档，不写任何游戏存档；统一榜另写 ming.hub.v1 独立命名空间。
 *       旧版根目录 index.html 的对应实现在此复用 SDK 重写，不重复维护 5 个 reader。
 */
(function () {
  'use strict';
  var SDK = globalThis.HubSDK;
  var games = globalThis.__HUB_GAMES__ || [];
  var modal = document.getElementById('hub-modal');
  var titleEl = document.getElementById('hub-sheet-title');
  var noteEl = document.getElementById('hub-sheet-note');
  var bodyEl = document.getElementById('hub-sheet-body');
  var closeBtn = document.getElementById('hub-sheet-close');
  if (!modal || !SDK) return;

  var OWNER_TAGS = ['卡牌', '益智', '模拟', '策略', '解谜', '战棋', '街机', '音游'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function openSheet(title, noteHTML, bodyHTML) {
    if (titleEl) titleEl.textContent = title;
    if (noteEl) noteEl.innerHTML = noteHTML || '';
    if (bodyEl) bodyEl.innerHTML = bodyHTML || '';
    modal.hidden = false;
    document.body.classList.add('sheet-open');
  }
  function closeSheet() {
    modal.hidden = true;
    document.body.classList.remove('sheet-open');
  }
  if (closeBtn) closeBtn.addEventListener('click', closeSheet);
  if (modal) modal.addEventListener('click', function (e) { if (e.target === modal) closeSheet(); });
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !modal.hidden) closeSheet(); });

  /* ---------------- 成就总览：逐款只读解析本机存档 ---------------- */
  function openAchievements() {
    var parts = games.map(function (g) {
      var legacy = null;
      try { legacy = SDK.legacyBest(g.id); } catch (e) { legacy = null; }
      var na = (g.id === 'grass-cutter' || g.id === 'enlisten' || g.status !== 'ready');
      var rows = legacy && legacy.rows ? legacy.rows.map(function (r) {
        return '<span class="hub-kv"><i>' + esc(r.k) + '</i>' + esc(r.v) + '</span>';
      }).join('') : '';
      var state = na ? '不适用' : (legacy ? '已有存档' : '未开始');
      var stateCls = legacy ? ' on' : '';
      var content = state === '不适用'
        ? '<p class="hub-none">' + (g.id === 'grass-cutter'
            ? '该作不写本地存档，局末 S/A/B/C 评级仅当次有效。'
            : '接入中或无需本机存档，暂无可展示进度。') + '</p>'
        : (legacy && rows
            ? '<div class="hub-kvs">' + rows + '</div>'
            : '<p class="hub-none">未开始 —— 玩过一局后这里会出现进度摘要。</p>');
      return '<div class="hub-game" data-game="' + esc(g.id) + '">' +
        '<div class="hub-game-head"><span class="hub-game-name">' + esc(g.name) +
          (g.tag ? '<span class="hub-game-tag">' + esc(g.tag) + '</span>' : '') + '</span>' +
          '<span class="hub-game-state' + stateCls + '">' + state + '</span></div>' + content +
        '</div>';
    }).join('');
    openSheet('成就总览',
      games.length + ' 款游戏的<b>本地存档读取摘要</b>（最高分 / 最深层 / 已通关数 / 图鉴 / 成就）。本页<b>只读不写</b>，不改动任何游戏存档；键缺失或存档损坏一律显示「未开始」或「—」。',
      parts);
  }

  /* ---------------- 全局排行榜：统一榜 + 老存档只读聚合 ---------------- */
  function openLeaderboard() {
    var all = SDK.overview();
    // 新框架比旧版多 3 款（warehouse-strike/lab-sandbox/enlisten），逐款补聚合
    var extraIds = games.map(function (g) { return g.id; }).filter(function (id) {
      return !all.some(function (x) { return x.id === id; });
    });
    extraIds.forEach(function (id) {
      var g = games.filter(function (x) { return x.id === id; })[0];
      var legacy = null;
      try { legacy = SDK.legacyBest(id); } catch (e) { legacy = null; }
      var board = SDK.mergedBoard(id);
      all.push({ id: id, name: g.name, tag: g.tag || '', url: g.playUrl || '',
        owner: OWNER_TAGS.indexOf(g.tag) >= 0,
        best: legacy ? { label: legacy.label, score: legacy.score, unit: legacy.unit } : null,
        legacy: legacy, board: board,
        state: legacy || board.length ? '有纪录' : '不适用' });
    });
    var list = all.slice().sort(function (a, b) {
      return (a.state === '有纪录' ? 0 : 1) - (b.state === '有纪录' ? 0 : 1);
    });
    var cards = list.map(function (g) {
      var rows = g.legacy && g.legacy.rows ? g.legacy.rows.map(function (r) {
        return '<span class="hub-kv"><i>' + esc(r.k) + '</i>' + esc(r.v) + '</span>';
      }).join('') : '';
      var board = (g.board || []).slice(0, 5).map(function (r, j) {
        return '<div class="hub-board-row"><span>#' + (j + 1) + ' ' + esc(r.label) +
          (r.detail ? ' · ' + esc(r.detail) : '') + ' <i style="opacity:.7">(' + esc(r.from || '') + ')</i></span>' +
          '<b>' + esc(r.score) + ' ' + esc(r.unit || '') + '</b></div>';
      }).join('');
      var best = g.best
        ? '<div class="hub-game-best">' + esc(g.best.label) + '<b>' + esc(g.best.score) + '</b>' + esc(g.best.unit || '') + '</div>'
        : '<p class="hub-none">' + (g.state === '不适用'
            ? '该作暂无可展示的本机纪录。' : '还没有纪录 —— 玩过一局后这里会出现本机最佳。') + '</p>';
      return '<div class="hub-game lb-game" data-owner="' + (g.owner ? '1' : '0') +
        '" data-state="' + esc(g.state) + '">' +
        '<div class="hub-game-head"><span class="hub-game-name">' + esc(g.name) +
          '<span class="hub-game-tag' + (g.owner ? ' owner' : '') + '">' + esc(g.tag) + '</span></span>' +
          '<span class="hub-game-state' + (g.state === '有纪录' ? ' on' : '') + '">' + esc(g.state) + '</span></div>' +
        best + (rows ? '<div class="hub-kvs">' + rows + '</div>' : '') +
        (board ? '<div class="hub-board">' + board + '</div>' : '') + '</div>';
    }).join('');
    var filters = '<div class="hub-filter-row" id="hub-filters">' +
      '<button class="hub-chip hub-filter" type="button" data-f="all" aria-pressed="true">全部 ' + games.length + ' 款</button>' +
      '<button class="hub-chip hub-filter" type="button" data-f="owner" aria-pressed="false">我负责的 8 分类</button>' +
      '<button class="hub-chip hub-filter" type="button" data-f="other" aria-pressed="false">其他分组（只读）</button>' +
      '<button class="hub-chip hub-filter" type="button" data-f="record" aria-pressed="false">仅有纪录</button>' +
      '</div>';
    var note = games.length + ' 款游戏的<b>本机纪录聚合</b>（跨游戏总览，非跨玩家榜）。数据<b>只读</b>，不改动任何游戏存档；' +
      '统一榜另写在独立命名空间 <code>' + esc(SDK.NS) + '</code>。今日种子 <b>' + esc(SDK.dailySeed()) + '</b>，' +
      '与荒野 WILD / 一世一牌的每日局同口径。动作 / 射击由「明」维护，此处仅读取其存档。';
    openSheet('全局排行榜', note, filters + '<div id="lb-list">' + cards + '</div>');
    var host = document.getElementById('hub-filters');
    if (!host) return;
    Array.prototype.forEach.call(host.querySelectorAll('.hub-filter'), function (btn) {
      btn.addEventListener('click', function () {
        var f = btn.getAttribute('data-f');
        Array.prototype.forEach.call(host.querySelectorAll('.hub-filter'), function (b) {
          b.setAttribute('aria-pressed', String(b === btn));
        });
        Array.prototype.forEach.call(document.querySelectorAll('#lb-list .lb-game'), function (card) {
          var owner = card.getAttribute('data-owner') === '1';
          var rec = card.getAttribute('data-state') === '有纪录';
          card.hidden = !(f === 'all' || (f === 'owner' && owner) ||
            (f === 'other' && !owner) || (f === 'record' && rec));
        });
      });
    });
  }

  /* ---------------- 每日挑战入口（对齐旧版 DAILY_INFO） ---------------- */
  var DAILY = {
    wild: ['有每日', '每日挑战 + 每日任务', '固定日种子 daily-YYYY-MM-DD，本地榜只留当天；另有每日 3 条任务、按日重置。'],
    raid: ['有每日', '每日突袭', '种子由本地日期散列得出（soudache-daily-YYYYMMDD），全服同一张图，当天只记最好的一局。'],
    card: ['有每日', '今日之牌', '日期决定流派与种子，同日重开完全一致；成绩单独记在 one-card:daily:v1。'],
    gym: ['有每日', '每日挑战', '按日种子从题库固定抽 3 款，3 项都正向即完成 +15 EXP，另有连续天数打卡。'],
    zhaoyun: ['有每日', '今日之战', '每日按日期固定阵图与关卡，当天记录最高星级，跨日自动作废。'],
    quiz: ['仅统计', '每日做题统计', '没有每日挑战玩法，只有每日做题数 / 正确数趋势（保留最近 30 天）。'],
    'paper-maze': ['暂无', '暂无每日玩法', '存档只有局数 / 结局 / 图鉴，暂无每日挑战或每日任务机制。'],
    'neon-rhythm': ['暂无', '暂无每日玩法', '谱面成绩存本地，暂无每日固定曲 / 每日挑战机制。'],
    'pixel-runner': ['有每日', '每日赛道', '存档已有 dailyBest（每日赛道天数），按日固定 seed 供异步比拼。'],
    lab: ['暂无', '暂无每日玩法', '存档只有实验打开记录与电路草稿，暂无每日机制。'],
    sim: ['暂无', '暂无每日玩法', '唯一的「每日」是账号重开配额（防刷限额），不是每日玩法。'],
    shanhai: ['暂无', '暂无每日玩法', '存档只有通关记录与评级，暂无每日机制。'],
    trio: ['有每日', '每日局', '按 trio-YYYY-MM-DD 固定牌堆，同一天所有人手牌与对手牌一致；成绩写入 mg_trio.v1。'],
    sudoku: ['有每日', '每日题', '按 sudoku-YYYY-MM-DD-难度 固定盘面，同日同难度题目一致；计时与最佳写入 mg_sudoku.v1。'],
    slide: ['有每日', '每日局', '按 slide-YYYY-MM-DD-难度 固定初始盘面，同日同难度可异步比最少步数；写入 mg_slide.v1。'],
    brick: ['有每日', '每日关卡', '按 brick-YYYY-MM-DD-关卡 固定砖块布局，同日关卡一致；最高分与到达关卡写入 mg_brick.v1。'],
    diner: ['有每日', '每日营业', '按 diner-YYYY-MM-DD 固定客单序列，同日客人点单一致；完整模拟经营（点餐/备料/烹饪/摆盘/星级评分），口碑与最佳营收写入 mg_diner.v1。'],
    territory: ['有每日', '每日局', '按 territory-YYYY-MM-DD 固定先手布局，同日阵型一致；胜局与最高子数写入 mg_territory.v1。'],
    tap: ['有每日', '每日谱面', '按 tap-YYYY-MM-DD 固定下落谱面，同日判定序列一致；最高分写入 mg_tap.v1。'],
    'grass-cutter': ['暂无', '暂无每日玩法', '该作不写本地存档，局末 S/A/B/C 评级仅当次有效，无每日机制。'],
    'warehouse-strike': ['暂无', '暂无每日玩法', '源码未发现每日挑战或每日任务机制，如实标注「暂无」。'],
    'lab-sandbox': ['暂无', '暂无每日玩法', '源码未发现每日挑战或每日任务机制，如实标注「暂无」。'],
    enlisten: ['暂无', '暂无每日玩法', '尚未接入（pending），暂无每日机制。'],
    dragonchess: ['暂无', '暂无每日玩法', '对局本地即时结算，暂无每日固定局或跨日存档。'],
    mahjong: ['暂无', '暂无每日玩法', '牌局存本地 mg_mahjong.v1 可续局，但没有每日固定牌局。'],
    rulecraft: ['暂无', '暂无每日玩法', '自定义规则与版本存本地 mg_rulecraft.v1，没有每日固定挑战。']
  };
  function openDaily() {
    var parts = games.map(function (g) {
      var d = DAILY[g.id];
      if (!d) return '';
      var cls = d[0] === '有每日' ? ' on' : '';
      return '<div class="hub-game" data-game="' + esc(g.id) + '">' +
        '<div class="hub-game-head"><span class="hub-game-name">' + esc(g.name) +
          (g.tag ? '<span class="hub-game-tag">' + esc(g.tag) + '</span>' : '') + '</span>' +
          '<span class="hub-game-state' + cls + '">' + esc(d[0]) + '</span></div>' +
        '<div class="hub-game-best">' + esc(d[1]) + '</div>' +
        '<p class="hub-none">' + esc(d[2]) + '</p></div>';
    }).filter(Boolean).join('');
    openSheet('每日挑战',
      '逐款核对源码后的<b>每日玩法清单</b>：真有每日机制才标注「有每日」，只有统计维度的标「仅统计」，没有的如实写「暂无」。今日种子 <b>' +
      esc(SDK.dailySeed()) + '</b>（daily-YYYY-MM-DD，与荒野 WILD / 一世一牌同口径）。', parts);
  }

  /* ---------------- 绑定按钮 ---------------- */
  var bach = document.getElementById('btn-ach');
  var bboard = document.getElementById('btn-board');
  var bdaily = document.getElementById('btn-daily');
  if (bach) bach.addEventListener('click', openAchievements);
  if (bboard) bboard.addEventListener('click', openLeaderboard);
  if (bdaily) bdaily.addEventListener('click', openDaily);

  // 暴露给自动化验收
  globalThis.HubMeta = { openAchievements: openAchievements, openLeaderboard: openLeaderboard, openDaily: openDaily, close: closeSheet };
})();
