// WILD 入口：标题页 → 开局 → 结算 → 再来一局
//
// 开发用 URL 参数（都不影响默认玩法）：
//   ?seed=XXX     指定种子（同种子同结果，用于复现某局）
//   ?dbg=1        画布左下角打印输入/帧率/手感读数
//   ?pilot=1      开启自动驾驶员（演示 / 无人值守跑满一局）
//   ?speed=N      开局局内倍速初值（N ∈ 0.5/1/2/3；非法值回落 1x；游戏内可用按钮/V 键切换）
//   ?t=SECONDS   开局先快进 SECONDS 秒（配合 ?pilot=1 用于"直接看后期满屏怪"）

import { Arena, ARENA, GAME_SPEEDS, ENEMY_TYPES, BOSS_TYPES, BOSS_ORDER } from './arena.js';
import { Rng, makeSeed } from './rng.js';
import { pilotDriver } from './pilot.js';
import { loadMeta, awardSouls, heroCatalog, selectHero, unlockHero,
  growthCatalog, buyGrowth, canRebirth, doRebirth, totalLevels, rebirthMul, titleOf as rebirthTitle,
  skinCatalog, selectSkin, loadoutCatalog, selectLoadout } from './meta.js';
import { heroById, CLASS_PASSIVES, WEAPONS, offerById, evoById, EVOLUTIONS } from './content.js';
import { loadBest, bestLines, submitRun, toNextGrade, scoreParts, gradeOf, scoreOf } from './best.js';
import { loadChallenge, submitChallenge, challengeSeed } from './challenge.js';
import { loadCodex, mergeCodex } from './codex.js';
import { loadAccount, setName, submitRun as submitAccount, titleOf } from './account.js';
import { settleRun, dailyBoard, achievementBoard, loadDaily, DAILY_COUNT, streakOf } from './daily.js';
import { Sfx } from './sfx.js';

const params = new URLSearchParams(location.search);
const stage = document.getElementById('stage');
const titleMeta = document.getElementById('title-meta');
const metaPanel = document.getElementById('meta-panel');
const resTitle = document.getElementById('res-title');
const resSub = document.getElementById('res-sub');
const resStats = document.getElementById('res-stats');
const resSouls = document.getElementById('res-souls');
const bestPanel = document.getElementById('best-panel');
const challengePanel = document.getElementById('challenge-panel');
const dailyPanel = document.getElementById('daily-panel');
const achPanel = document.getElementById('ach-panel');
const codexPanel = document.getElementById('codex-panel');
const resGrade = document.getElementById('res-grade');
const resGradeLt = document.getElementById('res-grade-lt');
const resGradeSc = document.getElementById('res-grade-sc');
const resRecord = document.getElementById('res-record');
const resNext = document.getElementById('res-next');
const heroSelect = document.getElementById('hero-select');
const skinSelect = document.getElementById('skin-select');  // 阶段 6-2：皮肤选择行
const loadoutSelect = document.getElementById('loadout-select');  // 阶段 6-3：装备选择区
const acctName = document.getElementById('acct-name');
const acctTitle = document.getElementById('acct-title');
const resAccount = document.getElementById('res-account');
const resBuild = document.getElementById('res-build');      // 阶段10 · P0-4：结算复盘
const btnStart = document.getElementById('btn-start');
const btnRetry = document.getElementById('btn-retry');
const btnHome = document.getElementById('btn-home');        // 阶段10 · P0-1：结算 → 标题
const skinSum = document.getElementById('skin-sum');        // 阶段10 · P0-7：折叠摘要
const loadoutSum = document.getElementById('loadout-sum');

const usePilot = params.get('pilot') === '1';
// 阶段 9：?speed=N 现在设「开局局内倍速」初值（合法档见 GAME_SPEEDS；非法值回落 1x）。
//   旧语义（每帧补步快进）已改为游戏内倍速按钮 + V 键；tools 不读 ?speed，故改动无副作用。
const initSpeed = (() => {
  const v = Number(params.get('speed') || 1);
  return GAME_SPEEDS.includes(v) ? v : 1;
})();
const jumpSec = Math.max(0, Number(params.get('t') || 0));
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

let arena = null;
// 阶段10·P1-10：每日挑战。challengeMode 是"下一次 startRun 用挑战种子"的一次性开关；
// challengeRun 是本局是否挑战局（进局后固化，结算时用来决定"纪录另账"）。
let challengeMode = false;
let challengeRun = false;

function show(id) {
  for (const s of stage.querySelectorAll('.screen')) s.classList.toggle('active', s.id === id);
}

const fmt = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

function newSeed() {
  // 阶段10·P1-10：挑战局走固定种子（同一天所有人同一套刷怪序列）。
  if (challengeMode) return challengeSeed(todayKey());
  const given = params.get('seed');
  if (given) return given;
  return makeSeed(new Rng(String(Date.now())));
}

/** 本地日期键（YYYY-MM-DD），注入 settleRun 以便每日任务按天重置、且可测。 */
function todayKey() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function startRun() {
  const seed = newSeed();
  titleMeta.textContent = `种子 ${seed}${reducedMotion ? ' · 已按系统偏好减弱动效' : ''}`;
  show('arena');
  // 阶段 3 音效：点「进入荒野」是首个用户手势，借此解锁 AudioContext
  Sfx.resume();
  // 阶段 3 元进度：把"已解锁且已启用"的解锁套进开局（默认空 → 行为不变）。
  // 阶段 5：把标题页选中的英雄 + 长期成长（属性等级 / 转生次数）经 meta 传进开局。
  const m0 = loadMeta();
  const meta = { levels: m0.levels, hero: m0.hero, rebirth: m0.rebirth, skin: m0.skin, loadout: m0.loadout };
  arena = new Arena({
    stage,
    rng: new Rng(seed),
    reducedMotion,
    onDone: showResult,
    meta,
  });
  if (usePilot) arena.driver = pilotDriver;
  arena.gameSpeed = initSpeed;
  arena.start();
  // 阶段10·P1-10：挑战标记一次性固化 —— 回标题后再点「进入荒野」就是普通局。
  challengeRun = !!challengeMode;
  challengeMode = false;
  // 快进必须在 start() 之后：core 是 start() 里建的。此刻 rAF 还没跑到第一帧，
  // 所以"跳过去"的画面会直接是第一帧 —— 不会先闪一下开局。
  if (jumpSec > 0) arena.fastForward(jumpSec);
  // 暴露给探针 / 录制脚本的**唯一**入口（tools/probe-wild.mjs、tools/record-demo.mjs 都从这里拿）。
  // pilot 也放进来，是因为录制时需要在"前半段真人键盘操作"和"后半段自动驾驶员快进"之间切换，
  // 而切换点只能从页面外触发。
  window.WILD = { arena, ARENA, pilot: pilotDriver, seed };
}

function showResult(res) {
  arena = null;
  const survived = res && res.survived;
  resTitle.textContent = survived ? '你活到了天亮' : '荒野把你留下了';
  resSub.textContent = survived ? '整整十分钟。' : '再来一次，这次走位再稳一点。';
  resStats.innerHTML = `
    <div class="rs-row rs-main">
      <div class="rs-cell"><span class="rs-k">存活时间</span><span class="rs-v">${fmt(res.survivalSec)}</span></div>
      <div class="rs-cell"><span class="rs-k">总击杀</span><span class="rs-v">${res.kills}</span></div>
    </div>
    <div class="rs-row">
      <div class="rs-cell"><span class="rs-k">等级</span><span class="rs-v sm">${res.level}</span></div>
      <!-- 阶段 8-2：结算页的「冲击波」格已删除（res.casts 这个读数也一并取消）。 -->
      <div class="rs-cell"><span class="rs-k">拾取宝石</span><span class="rs-v sm">${res.gems}</span></div>
      <div class="rs-cell"><span class="rs-k">出场敌人</span><span class="rs-v sm">${res.spawned}</span></div>
    </div>`;
  // ── 阶段 4-3 目标感：评级 + 新纪录 ──
  // ★ submitRun 必须在**写档之前**比对旧纪录，所以先调它、再拿它返回的 best 去渲染。
  // ★ 阶段10·P1-10：挑战局**不写** wild.best.v1（固定种子的成绩混进"随便打"的历史最佳会失真）——
  //   只算评级与分数，纪录一律按"未破"处理；挑战成绩走 wild.challenge.v1 另账。
  const isChallenge = challengeRun;
  challengeRun = false;
  const sub = isChallenge
    ? { grade: gradeOf(res), score: scoreOf(res), records: { sec: false, kills: false, level: false }, best: loadBest() }
    : submitRun(res);
  resGradeLt.textContent = sub.grade;
  resGrade.hidden = false;
  resGrade.dataset.g = sub.grade;
  // 阶段10·P1-13：总分 = 存活 + 击杀 + 行为分（Boss/进化/宝箱），把构成写清楚，
  //   否则玩家只看到"多杀 60 只涨 60 分"，不知道打得深也计分。
  {
    const p = scoreParts(res);
    resGradeSc.textContent = `总分 ${sub.score}（存活 ${p.sec}s + 击杀 ${p.kills} + 行为 ${p.behavior}`
      + (p.behavior ? `：Boss ${p.boss} · 进化 ${p.evo} · 宝箱 ${p.chests}` : '') + '）';
  }
  const broken = [
    sub.records.sec ? '最长存活' : null,
    sub.records.kills ? '最高击杀' : null,
    sub.records.level ? '最高等级' : null,
  ].filter(Boolean);
  if (broken.length) {
    resRecord.hidden = false;
    resRecord.textContent = `★ 新纪录 ★　${broken.join(' · ')}`;
  } else {
    resRecord.hidden = true;
  }
  // "再来一把"的具体目标：距下一档还差多少分（已是 S 就报本局分数）
  const gap = toNextGrade(res);
  resNext.textContent = gap > 0 ? `距下一档还差 ${gap} 分` : '已达最高评级 S';
  renderBestPanel();
  // 阶段10 · P0-4：本局构筑复盘（武器 / 进化 / 伤害构成 / 战果 / 升级）
  renderBuild(res);

  // 阶段 7 · 局外进度闭环：基础灵魂（击杀×0.5 + 存活×0.2）+ 每日任务奖励 + 成就解锁奖励。
  // awardSouls 记基础灵魂并 saveMeta；settleRun 记每日/成就奖励并 saveMeta —— 各改各的字段，加性不重算。
  const { gained, souls } = awardSouls(res.level, res.kills, res.survivalSec || 0);
  const dateKey = todayKey();
  const acct0 = loadAccount();
  const best = loadBest();
  const meta = loadMeta();
  const settlement = settleRun(localStorage, res, {
    dateKey,
    stats: {
      // ★ 修阶段7 遗留 bug：best.js 的字段叫 bestSec，原先写 bestSurvival ⟹ undefined ⟹
      //   「固守者/活到终局」两条存活类成就永远解不开。这里按真实字段名对齐。
      runs: acct0.runs, bestKills: best.bestKills, bestSurvival: best.bestSec,
      skinsUsed: acct0.skinsUsed, heroesUsed: acct0.heroesUsed, totalLevels: totalLevels(meta),
      // 阶段10·内容批P0-2：新 6 条成就的判据量
      totalKills: acct0.kills, bestLevel: best.bestLevel, bestBossKills: best.bestBossKills, rebirth: meta.rebirth,
    },
    totalLevels: totalLevels(meta),
  });
  const bonusSouls = settlement.souls;
  resSouls.textContent = `本局灵魂 +${gained}${bonusSouls ? `（含每日/成就 +${bonusSouls}）` : ''}（共 ${souls + bonusSouls}）`;
  // 结算页顺手展示"这一局长出了什么"：每日完成情况 + 新解锁的成就
  const extra = [];
  if (settlement.daily.done.length) extra.push(`每日任务完成 ${settlement.daily.done.length}/${DAILY_COUNT}`);
  if (settlement.achievements.fresh.length) extra.push(`解锁成就 ${settlement.achievements.fresh.length} 个`);
  // 阶段10·P1-11：图鉴增量（只读 res，不改 res）。
  const freshCodex = mergeCodex(res, BOSS_ORDER);
  if (freshCodex > 0) extra.push(`★ 图鉴 +${freshCodex} ★`);
  // 阶段10·P1-10：挑战成绩另账（同日同种子，本地榜）。
  if (isChallenge) {
    const ch = submitChallenge(res, dateKey, sub.score);
    extra.push(ch.record
      ? `今日挑战：新纪录 ${ch.best.score} 分`
      : `今日挑战：差 ${ch.gap} 分（最佳 ${ch.best.score}）`);
  }
  if (extra.length) resSub.textContent += `　·　${extra.join(' · ')}`;
  // 标题页进度面板（每日/成就/挑战/图鉴）在结算后顺手刷新，回到标题页即是最新状态
  renderDailyPanel();
  renderAchPanel();
  renderChallengePanel();
  renderCodexPanel();
  // 阶段10 · P0-4：原来这里把内部 id 直接拼给玩家看（「升级：wp_shots×3 · wo_count×2」），
  //   已删除 —— 中文名的完整复盘统一由上面的 renderBuild(res) 渲染进 #res-build。
  // ── 阶段 4-5：本地账号累计（总局数/总击杀/总存活 + 称号 + 距下个称号差额）──
  // ★ submitRun 必须在写档前比对旧纪录（与 best.js 同口径），返回 account/title/next/record。
  const acc = submitAccount(res);
  renderAccount(acc, res);
  show('screen-result');
  window.WILD = { result: res };
}

/**
 * 阶段 4-3 目标感：标题页三条本地纪录（大字）。
 * ★ 为什么要有它：玩家反馈「死了就死了不想再来」——缺的不是奖励，是**一个可再够一次的数字**。
 *   三条纪录把"上一局"变成一个具体目标；`—` 表示还没打过（第一局之前不显示 0）。
 */
function renderBestPanel() {
  if (!bestPanel) return;
  const b = loadBest();
  const cells = bestLines(b).map((x) => `<div class="best-cell"><span class="best-k">${x.k}</span><span class="best-v">${x.v}</span></div>`).join('');
  bestPanel.innerHTML = `${cells}<div class="best-foot">已打 ${b.runs} 局 · 本地存档</div>`;
}

// ───────── 阶段10 · 机制批 P0-4：结算复盘 ─────────
/** 武器 → 各阶进化线 id（下标 = 阶数 − 1）。剑是两级链，所以要两条。 */
const EVO_NAME = {
  projectile: ['ev_spiral'],
  orbit: ['ev_storm'],
  laser: ['ev_cleave'],
  sword: ['ev_sword_fan', 'ev_sword_ring'],
};
/** 伤害来源的中文名。★ 内部 id 一个都不许出现在玩家面前。 */
const SRC_NAME = {
  projectile: '投射物', orbit: '环绕刃', laser: '直斩', sword: '剑',
  thorn: '反伤', bossRain: '弹雨', mist: '毒雾',
};
/** 致死来源的中文名（P0-3 的 lastHit.src 只有这三种 + unknown）。 */
const HIT_SRC = { contact: '接触', ranged: '远程', rain: '弹雨', unknown: '未知' };

/** 结算复盘：这局拿了哪些武器、进化到哪一阶、伤害是谁打的、干了哪些大事。
 *  ★ 全部用中文名 —— 内部 id（wp_shots / ev_spiral）绝不能出现在玩家面前。
 *  ★ 进化是"每把武器一个阶数"，剑有两阶，所以按 stage 取对应那条进化线的名字。
 *  ★ 所有字段都带 `|| 0 / || []` 兜底：老版本录的 res 里没有 evolutions。
 */
function renderBuild(res) {
  if (!resBuild) return;
  if (!res) { resBuild.innerHTML = ''; return; }
  const w = (res.weapons || []).map((id) => (WEAPONS.find((x) => x.id === id) || {}).label || id);
  const evo = Object.entries(res.evolutions || {})
    .filter(([, st]) => st > 0)
    .map(([wid, st]) => (EVO_NAME[wid] || [])[st - 1])
    .filter(Boolean)
    .map((id) => (evoById(id) || {}).label || id);
  const up = {};
  for (const id of res.upgrades || []) up[id] = (up[id] || 0) + 1;
  const ups = Object.entries(up).map(([id, n]) => `${(offerById(id) || {}).label || id}×${n}`);
  const src = res.killSrc || {};
  const total = Object.values(src).reduce((s, n) => s + n, 0) || 1;
  const pct = Object.entries(src)
    .filter(([k, n]) => n > 0 && k !== 'other')
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${SRC_NAME[k] || k} ${Math.round((n / total) * 100)}%`);
  const bosses = (res.bossKills || []).reduce((s, n) => s + (Number(n) || 0), 0);
  // 阶段10 · P0-3：最后一击 —— 死了要知道为什么死。
  const hit = res.lastHit;
  const hitTxt = hit
    ? `${HIT_SRC[hit.src] || hit.src}${hit.kind ? ` · ${(ENEMY_TYPES[hit.kind] || {}).label || hit.kind}` : ''}（${fmt(Number(hit.at) || 0)}）`
    : '—';
  resBuild.innerHTML = `
    <div class="rb-row"><span class="rb-k">武器</span><span class="rb-v">${w.join(' · ') || '—'}</span></div>
    <div class="rb-row"><span class="rb-k">进化</span><span class="rb-v">${evo.join(' · ') || '未进化'}</span></div>
    <div class="rb-row"><span class="rb-k">伤害构成</span><span class="rb-v">${pct.join(' · ') || '—'}</span></div>
    <div class="rb-row"><span class="rb-k">战果</span><span class="rb-v">BOSS ${bosses} · 精英 ${res.elites || 0} · 宝箱 ${res.chests || 0} · 最高连杀 ${res.comboBest || 0}</span></div>
    <div class="rb-row"><span class="rb-k">最后一击</span><span class="rb-v">${res.survived ? '活到了天亮' : hitTxt}</span></div>
    <div class="rb-row"><span class="rb-k">升级</span><span class="rb-v">${ups.join(' · ') || '—'}</span></div>`;
}

// 标题页长期成长面板：属性树 / 职业线 / 特殊线，花灵魂买等级；满足门槛可转生。
// 纯渲染 + 事件绑定，不包括任何玩法逻辑（逻辑全在 meta.js）。
function renderMetaPanel() {
  if (!metaPanel) return;
  const m = loadMeta();
  const souls = m.souls;
  const cat = growthCatalog();
  // 距转生总进度：属性树取等级最高的 3 条（各按 25 级折算）+ 两条特殊线（各按已解锁折算）。
  const gen = cat.filter((L) => L.kind === 'generic').map((L) => Math.min(L.level, 25) / 25).sort((a, b) => b - a).slice(0, 3);
  const genProg = gen.length ? gen.reduce((s, x) => s + x, 0) / 3 : 0;
  const spec = cat.filter((L) => L.kind === 'special').map((L) => Math.min(L.level, 1));
  const specProg = spec.length ? spec.reduce((s, x) => s + x, 0) / spec.length : 0;
  const prog = Math.min(1, genProg * 0.7 + specProg * 0.3);
  const heroLabel = (id) => (heroById(id) && heroById(id).label) || id;
  const group = (kind, title) => {
    const rows = cat.filter((L) => L.kind === kind).map((L) => {
      const lvTxt = L.kind === 'special'
        ? (L.level >= 1 ? '已解锁' : '未解锁')
        : `Lv.${L.level}`;
      const heroTag = L.hero ? `<span class="g-tag">${heroLabel(L.hero)}</span>` : '';
      const btn = L.affordable
        ? `<button class="g-buy" data-id="${L.id}">升级 · ${L.cost}魂</button>`
        : `<button class="g-buy" data-id="${L.id}" disabled>还差 ${L.cost - souls}魂</button>`;
      return `<div class="g-row"><div class="g-info"><b>${L.label}</b>${heroTag}<span>${L.desc}　${lvTxt}</span></div>${btn}</div>`;
    }).join('');
    return `<div class="g-group"><div class="g-group-h">${title}</div>${rows}</div>`;
  };
  const rbReady = canRebirth(m);
  const rbLine = rbReady
    ? `<button class="g-rebirth" id="g-rebirth">转生 · 全局强度 ×${rebirthMul(m).toFixed(2)} → ×${(rebirthMul(m) + 0.10).toFixed(2)}</button>`
    : `<div class="g-rebirth-lock">转生需：任意 3 条属性线 ≥25 级，且两条特殊线已解锁（当前称号：${m.title}）</div>`;
  metaPanel.innerHTML =
    `<div class="meta-head">灵魂 <b>${souls}</b> · 总等级 <b>${totalLevels(m)}</b> · ${m.title}</div>`
    + `<div class="g-bar" title="距转生进度"><div class="g-bar-fill" style="width:${(prog * 100).toFixed(1)}%"></div></div>`
    + group('generic', '属性树（无限）')
    + group('class', '职业专属线')
    + group('special', '特殊线')
    + rbLine
    // 阶段10 · P0-6：把"转生到底保留什么"写清楚 —— 以前玩家不敢按，
    //   因为按下去四件装备会静默消失（已修：解锁改看历史峰值）。
    + `<div class="g-rebirth-note">转生保留：装备解锁 / 英雄 / 皮肤 / 灵魂；重置：全部属性等级</div>`;
  metaPanel.querySelectorAll('.g-buy').forEach((b) => {
    b.onclick = () => { buyGrowth(b.dataset.id); renderMetaPanel(); };
  });
  const rb = document.getElementById('g-rebirth');
  if (rb) rb.onclick = () => { doRebirth(); renderMetaPanel(); renderAcctBadge(); };
}

/**
 * 阶段10 · 机制批 P0-1：结算 → 标题。
 * 以前结算页只有一个「再来一局」，想换英雄/换装备只能刷新页面 —— 而这一局刚发的灵魂、
 * 刚破的纪录、刚完成的每日都只在内存里画过一次，刷新反而看不到。
 * 这里把六块面板按**最新存档**重画一遍（灵魂/纪录/每日/成就都刚变过）。
 */
function goTitle() {
  arena = null;
  if (titleMeta) titleMeta.textContent = '点「进入荒野」开始 · 拖动屏幕移动，拾取绿色碎片升级';
  show('screen-title');
  renderMetaPanel(); renderBestPanel(); renderHeroSelect(); renderSkinSelect();
  renderLoadoutSelect(); renderDailyPanel(); renderAchPanel(); renderAcctBadge();
  renderChallengePanel(); renderCodexPanel();   // 阶段10·P1-10 / P1-11
  // 标题页没有局可查：置 null 而不是留一份过期的 result。
  // ★ 读 window.WILD 的探针必须自己判空（tools/probe-wild.mjs 已做）。
  window.WILD = null;
}

btnStart.onclick = () => startRun();
btnRetry.onclick = () => startRun();
if (btnHome) btnHome.onclick = () => goTitle();

// ── 阶段 4-5：标题页英雄选择 + 玩家名 ──
// 纯渲染 + 事件绑定；解锁花灵魂（meta.js），选择写 meta.hero，开局经 core 生效。

/** 渲染英雄卡：已解锁可"选择"，未解锁显示「解锁 · N魂」（买不起置灰）。 */
function renderHeroSelect() {
  if (!heroSelect) return;
  const cards = heroCatalog().map((h) => {
    const cls = ['hero-card', `tag-${h.tag}`];
    if (!h.unlocked) cls.push('locked');
    if (h.selected) cls.push('sel');
    const stat = `血×${h.hpMul}　攻×${h.dmgMul}　速×${h.moveMul}` + (h.atkMul !== 1 ? `　攻速×${h.atkMul}` : '');
    const action = h.unlocked
      ? (h.selected ? '<span class="hero-state">已选择</span>' : `<button class="hero-pick" data-id="${h.id}">选择</button>`)
      : `<button class="hero-buy" data-id="${h.id}" ${h.affordable ? '' : 'disabled'}>解锁 · ${h.cost}魂</button>`;
    const mech = (CLASS_PASSIVES[h.id] && CLASS_PASSIVES[h.id].label) || '';
    return `<div class="${cls.join(' ')}">
      <b class="hero-label">${h.label}</b><span class="hero-tag">${h.tag}</span>
      <span class="hero-mech">机制 · ${mech}</span>
      <p class="hero-desc">${h.desc}</p>
      <p class="hero-stat">${stat}</p>
      ${action}
    </div>`;
  }).join('');
  heroSelect.innerHTML = cards;
  heroSelect.querySelectorAll('.hero-pick').forEach((b) => {
    b.onclick = () => { selectHero(b.dataset.id); renderHeroSelect(); renderAcctBadge(); };
  });
  heroSelect.querySelectorAll('.hero-buy').forEach((b) => {
    b.onclick = () => { unlockHero(b.dataset.id); if (loadMeta().heroes.includes(b.dataset.id)) selectHero(b.dataset.id); renderMetaPanel(); renderHeroSelect(); };
  });
}

/** 渲染皮肤卡（阶段 6-2）：纯外观，全部恒可选，无解锁花费。点击即写 meta.skin。 */
function renderSkinSelect() {
  if (!skinSelect) return;
  const cat = skinCatalog();
  // 阶段10 · P0-7：摘要行常驻（选择区默认折叠），把"当前穿的哪套"写在外面
  if (skinSum) {
    const cur = cat.find((s) => s.selected);
    skinSum.textContent = `皮肤 · ${cur ? cur.name : '默认'}`;
  }
  const cards = cat.map((s) => {
    const cls = ['skin-card'];
    if (s.selected) cls.push('sel');
    if (!s.unlocked) cls.push('locked');   // 复用 .hero-card.locked 的灰化样式
    const swatch = s.color
      ? `<span class="skin-swatch" style="background:${s.color}"></span>`
      : `<span class="skin-swatch skin-swatch-default"></span>`;
    // 阶段10·P1-9：未解锁显示「N 阶解锁」（tier 是 0..3 的序号，界面按一阶..四阶称呼）。
    const action = !s.unlocked
      ? `<span class="skin-state">${(Number(s.tier) || 0) + 1} 阶解锁</span>`
      : (s.selected
        ? '<span class="skin-state">已选用</span>'
        : `<button class="skin-pick" data-id="${s.id}">选用</button>`);
    return `<div class="${cls.join(' ')}">
      ${swatch}
      <b class="skin-label">${s.name}</b>
      <p class="skin-desc">${s.desc}</p>
      ${action}
    </div>`;
  }).join('');
  skinSelect.innerHTML = cards;
  skinSelect.querySelectorAll('.skin-pick').forEach((b) => {
    b.onclick = () => { selectSkin(b.dataset.id); renderSkinSelect(); };
  });
}

/** 渲染装备选择区（阶段 6-3）：3 槽各一行，每件一个按钮（含「空」）。点击即写 meta.loadout。 */
function renderLoadoutSelect() {
  if (!loadoutSelect) return;
  const cat = loadoutCatalog();
  // 阶段10 · P0-7：摘要行显示三槽已选（折叠状态下也能看出自己带了什么）
  if (loadoutSum) {
    const picks = cat.flatMap((s) => s.items).filter((it) => it.selected && it.id).map((it) => it.name);
    loadoutSum.textContent = picks.length ? `装备 · ${picks.join(' / ')}` : '装备 · 未配置';
  }
  const rows = cat.map((slot) => {
    const items = slot.items.map((it) => {
      const cls = ['lo-pick'];
      if (it.selected) cls.push('sel');
      const label = it.id ? `${it.name}（${it.desc}）` : '空';
      return `<button class="${cls.join(' ')}" data-slot="${slot.slot}" data-id="${it.id || ''}">${label}</button>`;
    }).join('');
    return `<div class="lo-row"><span class="lo-slot-name">${slot.name}</span>${items}</div>`;
  }).join('');
  loadoutSelect.innerHTML = rows;
  loadoutSelect.querySelectorAll('.lo-pick').forEach((b) => {
    b.onclick = () => { selectLoadout(b.dataset.slot, b.dataset.id || null); renderLoadoutSelect(); };
  });
}

/** 左上角玩家名（可编辑，存 localStorage）+ 当前称号。 */
function renderAcctBadge() {
  const a = loadAccount();
  if (acctName && document.activeElement !== acctName) acctName.value = a.name || '';
  if (acctTitle) acctTitle.textContent = titleOf(a.kills);
}

/** 结算页账号档案：累计 + 称号 + 距下个称号差额。 */
function renderAccount(acc, res) {
  if (!resAccount) return;
  const nt = acc.next;
  const heroLabel = (HERO_LABELS[res.hero] || res.hero);
  resAccount.innerHTML = `
    <div class="ra-head">${acc.account.name || '荒野旅人'}（${heroLabel}）· <b>${acc.title}</b>${acc.record ? ' <span class="ra-rec">本角色新纪录</span>' : ''}</div>
    <div class="ra-row">
      <span>总局数 ${acc.account.runs}</span>
      <span>总击杀 ${acc.account.kills}</span>
      <span>总存活 ${fmt(acc.account.survival)}</span>
    </div>
    ${nt ? `<div class="ra-next">距「${nt.name}」还差 <b>${nt.gap}</b> 杀</div>` : `<div class="ra-next">已达最高称号「${acc.title}」</div>`}
    <div class="ra-local">本地存档 · 无云端同步</div>`;
}

/** 阶段 7：标题页每日任务面板（按日重置，完成奖励灵魂）。 */
function renderDailyPanel() {
  if (!dailyPanel) return;
  const dateKey = todayKey();
  const board = dailyBoard(localStorage, dateKey);
  const streak = streakOf(localStorage, dateKey);
  const cells = board.map((t) => {
    const tag = t.claimed ? '已领' : t.done ? '完成' : '进行中';
    const cls = t.claimed ? 'done' : t.done ? 'ready' : 'open';
    // 阶段10·P1-12：进度行（「900 / 1200」）。skin/hero 类的 target 是字符串，
    //   按 1 分制显示（progress 恒 0/1），不把 'gale' 这种内部值印到界面上。
    const target = typeof t.target === 'number' ? t.target : 1;
    const prog = Math.min(Number(t.progress) || 0, target);
    // ★ .prog-cell 是「name/desc + rew」两行网格，第二个 .pc-rew 会与第一个重叠 ⟹
    //   进度并入描述行；右侧仍留给奖励与状态。
    return `<div class="prog-cell ${cls}"><span class="pc-name">${t.name}</span>`
      + `<span class="pc-desc">${t.desc} · ${prog} / ${target}</span>`
      + `<span class="pc-rew">+${t.reward} 灵魂 · ${tag}</span></div>`;
  }).join('');
  dailyPanel.innerHTML =
    `<div class="prog-head">每日任务（${dateKey}）${streak > 0 ? ` · 连续 ${streak} 天` : ''}</div>${cells}`;
}

/** 阶段 7：标题页成就面板（永久里程碑，奖励大额灵魂）。 */
function renderAchPanel() {
  if (!achPanel) return;
  const acc = loadAccount();
  const best = loadBest();
  const meta = loadMeta();
  const board = achievementBoard(localStorage, {
    // ★ 同 showResult 那处：bestSurvival 要取 bestSec（字段名对齐），否则存活类成就永远不开。
    runs: acc.runs, bestKills: best.bestKills, bestSurvival: best.bestSec,
    skinsUsed: acc.skinsUsed, heroesUsed: acc.heroesUsed, totalLevels: totalLevels(meta),
    // 阶段10·内容批P0-2：新 6 条成就的判据量
    totalKills: acc.kills, bestLevel: best.bestLevel, bestBossKills: best.bestBossKills, rebirth: meta.rebirth,
  });
  const got = board.filter((a) => a.unlocked).length;
  const cells = board.map((a) => {
    const cls = a.unlocked ? 'done' : 'open';
    return `<div class="prog-cell ${cls}"><span class="pc-name">${a.name}</span>`
      + `<span class="pc-desc">${a.hint}</span>`
      + `<span class="pc-rew">+${a.reward} 灵魂 · ${a.unlocked ? '已解锁' : '未解锁'}</span></div>`;
  }).join('');
  achPanel.innerHTML = `<div class="prog-head">成就 ${got}/${board.length}</div>${cells}`;
}

/** 阶段10·P1-10：标题页「今日挑战」块（同一天同种子 + 本地榜）。 */
function renderChallengePanel() {
  if (!challengePanel) return;
  const dk = todayKey();
  const ch = loadChallenge(dk);
  challengePanel.innerHTML =
    `<div class="prog-head">今日挑战</div>`
    + `<div class="prog-cell open"><span class="pc-name">同一颗种子，比分数</span>`
    + `<span class="pc-desc">种子 daily-${dk} · 今日已打 ${ch.runs} 次 · 最佳 ${ch.best.score} 分</span>`
    + `<button class="g-buy" id="btn-challenge" type="button">开始今日挑战</button></div>`;
  const b = document.getElementById('btn-challenge');
  if (b) b.onclick = () => { challengeMode = true; startRun(); };
}

/** 阶段10·P1-11：标题页图鉴（敌人 / Boss / 进化；未见过的显示 ???）。 */
function renderCodexPanel() {
  if (!codexPanel) return;
  const c = loadCodex();
  const enemyKeys = Object.keys(ENEMY_TYPES);
  const bossKeys = Object.keys(BOSS_TYPES);
  const seenEnemies = enemyKeys.filter((k) => (c.kinds[k] || 0) > 0).length;
  const seenBosses = bossKeys.filter((k) => (c.kinds[k] || 0) > 0).length;
  const seenEvos = EVOLUTIONS.filter((e) => c.evolutions.includes(e.id)).length;
  const cell = (label, n, unit = '次') => (n > 0
    ? `<div class="prog-cell done"><span class="pc-name">${label}</span><span class="pc-desc">×${n} ${unit}</span></div>`
    : `<div class="prog-cell open"><span class="pc-name">???</span><span class="pc-desc">未遇见</span></div>`);
  const enemies = enemyKeys.map((k) => cell(ENEMY_TYPES[k].label || k, c.kinds[k] || 0)).join('');
  const bosses = bossKeys.map((k) => cell(BOSS_TYPES[k].label || k, c.kinds[k] || 0)).join('');
  const evos = EVOLUTIONS.map((e) => (c.evolutions.includes(e.id)
    ? `<div class="prog-cell done"><span class="pc-name">${e.label}</span><span class="pc-desc">已达成</span></div>`
    : `<div class="prog-cell open"><span class="pc-name">???</span><span class="pc-desc">未达成</span></div>`)).join('');
  codexPanel.innerHTML =
    `<div class="prog-head">图鉴 · 敌人 ${seenEnemies}/${enemyKeys.length} · Boss ${seenBosses}/${bossKeys.length} · 进化 ${seenEvos}/${EVOLUTIONS.length}</div>`
    + `<div class="prog-sub">敌人</div>${enemies}`
    + `<div class="prog-sub">Boss</div>${bosses}`
    + `<div class="prog-sub">进化</div>${evos}`;
}

// 英雄 id → 中文名（结算页展示用，避免暴露内部 id）
const HERO_LABELS = { wanderer: '流浪者', bulwark: '重壳守卫', gale: '疾风行者' };

// 阶段10 · P0-7：皮肤/装备的折叠摘要 —— 点整行展开或收起。
//   ★ 用 hidden 切换而不是改 class：选择区内部的 .hero-card/.skin-pick/.lo-pick
//     是事件绑定依赖的类名，一个都不能碰（回归要求）。
for (const btn of document.querySelectorAll('.pick-h')) {
  btn.onclick = () => {
    const el = document.getElementById(btn.dataset.target);
    if (!el) return;
    el.hidden = !el.hidden;
    btn.classList.toggle('open', !el.hidden);
  };
}

Sfx.loadMuted();   // 阶段 3 音效：启动期读一次持久化的静音偏好
renderMetaPanel();
renderBestPanel(); // 阶段 4-3：标题页三条纪录
renderHeroSelect();
renderSkinSelect();   // 阶段 6-2：皮肤选择行
renderLoadoutSelect();  // 阶段 6-3：装备选择区
renderAcctBadge();
renderDailyPanel();     // 阶段 7：每日任务面板
renderAchPanel();       // 阶段 7：成就面板
renderChallengePanel(); // 阶段10·P1-10：今日挑战
renderCodexPanel();     // 阶段10·P1-11：图鉴
if (acctName) acctName.oninput = () => setName(acctName.value);
// 阶段 8-2：原「空格放冲击波」这句操作提示已随技能删除 —— 现在只剩"拖动屏幕移动"一条，
//   而移动**不需要**再教（摇杆/拖动是玩家自己会做的），所以整句收成一句开局引导。
titleMeta.textContent = '点「进入荒野」开始 · 拖动屏幕移动，拾取绿色碎片升级';
