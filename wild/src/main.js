// WILD 入口：标题页 → 开局 → 结算 → 再来一局
//
// 开发用 URL 参数（都不影响默认玩法）：
//   ?seed=XXX     指定种子（同种子同结果，用于复现某局）
//   ?dbg=1        画布左下角打印输入/帧率/手感读数
//   ?pilot=1      开启自动驾驶员（演示 / 无人值守跑满一局）
//   ?speed=N      每帧补跑 N 个子步（快进；物理口径不变，见 arena.js 注释）
//   ?t=SECONDS   开局先快进 SECONDS 秒（配合 ?pilot=1 用于"直接看后期满屏怪"）

import { Arena, ARENA } from './arena.js';
import { Rng, makeSeed } from './rng.js';
import { pilotDriver } from './pilot.js';
import { loadMeta, awardSouls, heroCatalog, selectHero, unlockHero,
  growthCatalog, buyGrowth, canRebirth, doRebirth, totalLevels, rebirthMul, titleOf as rebirthTitle,
  skinCatalog, selectSkin, loadoutCatalog, selectLoadout } from './meta.js';
import { heroById, CLASS_PASSIVES } from './content.js';
import { loadBest, bestLines, submitRun, toNextGrade } from './best.js';
import { loadAccount, setName, submitRun as submitAccount, titleOf } from './account.js';
import { settleRun, dailyBoard, achievementBoard, loadDaily, DAILY_COUNT } from './daily.js';
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
const dailyPanel = document.getElementById('daily-panel');
const achPanel = document.getElementById('ach-panel');
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
const btnStart = document.getElementById('btn-start');
const btnRetry = document.getElementById('btn-retry');

const usePilot = params.get('pilot') === '1';
const speedSteps = Math.max(1, Math.min(20, Number(params.get('speed') || 1)));
const jumpSec = Math.max(0, Number(params.get('t') || 0));
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

let arena = null;

function show(id) {
  for (const s of stage.querySelectorAll('.screen')) s.classList.toggle('active', s.id === id);
}

const fmt = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

function newSeed() {
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
  arena.fastForwardSteps = speedSteps;
  arena.start();
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
      <div class="rs-cell"><span class="rs-k">冲击波</span><span class="rs-v sm">${res.casts}</span></div>
      <div class="rs-cell"><span class="rs-k">拾取宝石</span><span class="rs-v sm">${res.gems}</span></div>
      <div class="rs-cell"><span class="rs-k">出场敌人</span><span class="rs-v sm">${res.spawned}</span></div>
    </div>`;
  // ── 阶段 4-3 目标感：评级 + 新纪录 ──
  // ★ submitRun 必须在**写档之前**比对旧纪录，所以先调它、再拿它返回的 best 去渲染。
  const sub = submitRun(res);
  resGradeLt.textContent = sub.grade;
  resGrade.hidden = false;
  resGrade.dataset.g = sub.grade;
  resGradeSc.textContent = `总分 ${sub.score}（存活 ${res.survivalSec}s + 击杀 ${res.kills}）`;
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
      runs: acct0.runs, bestKills: best.bestKills, bestSurvival: best.bestSurvival,
      skinsUsed: acct0.skinsUsed, heroesUsed: acct0.heroesUsed, totalLevels: totalLevels(meta),
    },
    totalLevels: totalLevels(meta),
  });
  const bonusSouls = settlement.souls;
  resSouls.textContent = `本局灵魂 +${gained}${bonusSouls ? `（含每日/成就 +${bonusSouls}）` : ''}（共 ${souls + bonusSouls}）`;
  // 结算页顺手展示"这一局长出了什么"：每日完成情况 + 新解锁的成就
  const extra = [];
  if (settlement.daily.done.length) extra.push(`每日任务完成 ${settlement.daily.done.length}/${DAILY_COUNT}`);
  if (settlement.achievements.fresh.length) extra.push(`解锁成就 ${settlement.achievements.fresh.length} 个`);
  if (extra.length) resSub.textContent += `　·　${extra.join(' · ')}`;
  // 标题页进度面板（每日/成就）在结算后顺手刷新，回到标题页即是最新状态
  renderDailyPanel();
  renderAchPanel();
  // 逐项统计"这局都拿到了什么"，让玩家在结算里看得见自己是怎么长起来的
  const tally = {};
  for (const id of res.upgrades || []) tally[id] = (tally[id] || 0) + 1;
  const line = Object.entries(tally).map(([id, n]) => `${id}×${n}`).join(' · ');
  resSub.textContent += line ? `　（升级：${line}）` : '';
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
    + rbLine;
  metaPanel.querySelectorAll('.g-buy').forEach((b) => {
    b.onclick = () => { buyGrowth(b.dataset.id); renderMetaPanel(); };
  });
  const rb = document.getElementById('g-rebirth');
  if (rb) rb.onclick = () => { doRebirth(); renderMetaPanel(); renderAcctBadge(); };
}

btnStart.onclick = () => startRun();
btnRetry.onclick = () => startRun();

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
  const cards = skinCatalog().map((s) => {
    const cls = ['skin-card'];
    if (s.selected) cls.push('sel');
    const swatch = s.color
      ? `<span class="skin-swatch" style="background:${s.color}"></span>`
      : `<span class="skin-swatch skin-swatch-default"></span>`;
    const action = s.selected
      ? '<span class="skin-state">已选用</span>'
      : `<button class="skin-pick" data-id="${s.id}">选用</button>`;
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
  const rows = loadoutCatalog().map((slot) => {
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
  const board = dailyBoard(localStorage, todayKey());
  const cells = board.map((t) => {
    const tag = t.claimed ? '已领' : t.done ? '完成' : '进行中';
    const cls = t.claimed ? 'done' : t.done ? 'ready' : 'open';
    return `<div class="prog-cell ${cls}"><span class="pc-name">${t.name}</span>`
      + `<span class="pc-desc">${t.desc}</span>`
      + `<span class="pc-rew">+${t.reward} 灵魂 · ${tag}</span></div>`;
  }).join('');
  dailyPanel.innerHTML = `<div class="prog-head">每日任务（${todayKey()}）</div>${cells}`;
}

/** 阶段 7：标题页成就面板（永久里程碑，奖励大额灵魂）。 */
function renderAchPanel() {
  if (!achPanel) return;
  const acc = loadAccount();
  const best = loadBest();
  const meta = loadMeta();
  const board = achievementBoard(localStorage, {
    runs: acc.runs, bestKills: best.bestKills, bestSurvival: best.bestSurvival,
    skinsUsed: acc.skinsUsed, heroesUsed: acc.heroesUsed, totalLevels: totalLevels(meta),
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

// 英雄 id → 中文名（结算页展示用，避免暴露内部 id）
const HERO_LABELS = { wanderer: '流浪者', bulwark: '重壳守卫', gale: '疾风行者' };

Sfx.loadMuted();   // 阶段 3 音效：启动期读一次持久化的静音偏好
renderMetaPanel();
renderBestPanel(); // 阶段 4-3：标题页三条纪录
renderHeroSelect();
renderSkinSelect();   // 阶段 6-2：皮肤选择行
renderLoadoutSelect();  // 阶段 6-3：装备选择区
renderAcctBadge();
renderDailyPanel();     // 阶段 7：每日任务面板
renderAchPanel();       // 阶段 7：成就面板
if (acctName) acctName.oninput = () => setName(acctName.value);
titleMeta.textContent = '点「进入荒野」开始 · 拖动屏幕移动，空格放冲击波';
