/**
 * HUD（DOM 叠加层，美术圣经 §8）
 * 只读 state 并渲染；不持有业务状态（ADR-002）
 */
import {
  SKU_BY_ID, OPEN_HOUR, NIGHTS_PER_WEEK, CLERK, MODULE_MAX_PER_DEVICE, MODULE_REFUND,
  STAFF, WAREHOUSE, SECONDHAND, MONITOR, DELIVERY, GARBAGE,
} from './config.mjs';
import { state, NIGHT_SECONDS } from './state.mjs';
import { RESET_SCOPE } from './reset.mjs';
import { availableSkus, sellable } from './economy.mjs';
import {
  settings, RANGES, DEFAULTS, setSettings, resetSettings,
} from './settings.mjs';
import { fmtYuan, fmtYuanSigned } from './fmt.mjs';

let els = {};
let modalOpen = false;
/** #hud-root 引用：弹窗期间要给它挂 has-modal 类（见 syncModalLayer） */
let hudRoot = null;

/** 任务完成时"绿色打勾一闪"的截止时间戳（performance.now 坐标系；0 = 不在闪） */
let questDoneUntil = 0;

function fmtClock(gameHour) {
  const mins = Math.round(OPEN_HOUR * 60 + gameHour * 60);
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * HUD 金额格式化 —— 委托给 fmt.mjs 的单一入口（Bug⑤）。
 *
 * 原来是本地 `Math.round(v)`：既把 `14.85` 显示成 `¥15`（**吞掉角分**，玩家看到的
 * 营收和账本对不上），又和 main/interaction 等九处各自拼 `¥${x}` 的做法各行其是。
 * 现在统一走 fmtYuan：按分四舍五入、最多两位小数、去尾零、空值兜 ¥0。
 * 签名与旧版一致（带 ¥ 符号、负数为 `-¥x`），所以下面 20 多处调用点无需改动。
 */
function fmtMoney(v) {
  return fmtYuan(v);
}

/* 数字"跳字"缓动（手感 5）：金币 / 满意度变化不要瞬间跳变，而是快速滚到目标值。
 * 用每帧比例逼近而不是 setTimeout 补间 —— renderHud 本来就每帧跑，
 * 省掉一套计时器生命周期，也不会在暂停/切面板时残留动画。 */
const numTween = {};
function easeNum(key, target) {
  let s = numTween[key];
  if (!s) { s = numTween[key] = { shown: target }; }
  s.shown += (target - s.shown) * 0.22;
  if (Math.abs(target - s.shown) < 0.6) s.shown = target;
  return s.shown;
}

export function mountHud(root) {
  hudRoot = root;
  root.innerHTML = `
    <div class="crosshair" data-el="crosshair"></div>

    <div class="topbar">
      <div class="clock"><span data-el="clock">22:00</span><span class="segment" data-el="segment"></span></div>
      <div class="track"><i data-el="track"></i></div>
    </div>

    <div class="corner tl">
      <div><span class="label">第</span> <span class="value" data-el="night">1</span> <span class="label">夜 / ${NIGHTS_PER_WEEK}</span></div>
      <div><span class="label">满意度</span> <span class="value brand" data-el="rep">50</span></div>
      <!-- 疲劳系统：玩家疲劳读数（独立于店员的 barFatigue，不混用） -->
      <div class="pfatigue" data-el="pfatigue" style="display:none">
        <span class="label">疲劳</span> <span class="value" data-el="pfval">0</span>
      </div>
    </div>

    <div class="corner tr">
      <div><span class="label">现金</span></div>
      <div class="value money" data-el="cash">¥500</div>
      <div><span class="label">代币</span> <span class="value brand" data-el="tokens">0</span></div>
      <div><span class="label">今夜营收</span> <span class="value" data-el="rev">¥0</span></div>
      <div class="envline" data-el="envline" style="display:none"></div>
    </div>

    <div class="prompt" data-el="prompt" style="display:none"></div>
    <div class="held" data-el="held" style="display:none"></div>
    <div class="hintbar" data-el="hint">WASD 移动 · 鼠标视角 · <b>E</b> 交互 · <b>Tab</b> 商店 · <b>B</b> 背包 · <b>L</b> 排行 · <b>F5</b> 存档 · <b>F9</b> 读档 · Esc 暂停</div>

    <!-- 需求I ②：限时任务面板（左下角，QUESTS.panelCorner='bl'） -->
    <div class="questpanel" data-el="quest" style="display:none"></div>
    <!-- 需求I ⑥：随机突发事件横幅 -->
    <div class="incident" data-el="incident" style="display:none"></div>

    <!-- 首夜三步引导字幕（顶部居中细条，pointer-events:none 不挡操作） -->
    <div class="tutorial" data-el="tutorial" style="display:none"></div>

    <div class="queue" data-el="queuebox">
      <div class="head">结账队列（<span data-el="qlen">0</span>/<span data-el="qmax">5</span>）</div>
      <div data-el="qbody" class="empty">暂无顾客</div>
    </div>

    <div class="toasts" data-el="toasts"></div>
    <div class="regulars" data-el="regulars" style="display:none"></div>
    <!-- 疲劳系统：打瞌睡遮罩（重度未处理时短暂失去控制的可视化） -->
    <div class="doze" data-el="doze" style="display:none"></div>
    <div data-el="modal"></div>
    <div data-el="start"></div>
  `;
  const q = (name) => root.querySelector(`[data-el="${name}"]`);
  els = {
    crosshair: q('crosshair'), clock: q('clock'), segment: q('segment'), track: q('track'),
    night: q('night'), rep: q('rep'), cash: q('cash'), rev: q('rev'),
    tokens: q('tokens'), envline: q('envline'),
    prompt: q('prompt'), held: q('held'), hint: q('hint'),
    quest: q('quest'), incident: q('incident'), tutorial: q('tutorial'),
    qlen: q('qlen'), qmax: q('qmax'), qbody: q('qbody'), queuebox: q('queuebox'),
    toasts: q('toasts'), modal: q('modal'), start: q('start'),
    pfatigue: q('pfatigue'), pfval: q('pfval'), doze: q('doze'),
    regulars: q('regulars'),
    barStamina: q('barStamina'), valStamina: q('valStamina'),
    barFatigue: q('barFatigue'), valFatigue: q('valFatigue'),
    barSatiety: q('barSatiety'), valSatiety: q('valSatiety'),
    barMental: q('barMental'), valMental: q('valMental'),
  };
}

export function isModalOpen() {
  return modalOpen;
}

/** 状态条：按数值 + 阈值上色（绿=安全 / 琥珀=临界 / 红=越阈）。thr 取自 config.CLERK.thr */
function setBar(barEl, valEl, v, color) {
  if (!barEl) return;
  barEl.style.width = `${Math.max(0, Math.min(100, v))}%`;
  barEl.style.background = color;
  if (valEl) valEl.textContent = String(Math.round(v));
}
function statColor(v, lowBad, thr) {
  // lowBad=true：数值越低越糟（体力/饱食/心理）；false：数值越高越糟（疲惫）
  if (lowBad) {
    if (v < thr) return 'var(--warning)';
    if (v < 55) return 'var(--brand)';
    return 'var(--money)';
  }
  if (v > thr) return 'var(--warning)';
  if (v > 45) return 'var(--brand)';
  return 'var(--money)';
}

/* ---------- 每帧刷新 ---------- */

/**
 * 弹窗层级契约（P0「弹窗按钮真实鼠标点不动」）——
 *
 * ① 任何弹窗打开期间给 #hud-root 挂上 has-modal：tokens.css 据此把**底层 HUD 一律
 *    置为 pointer-events:none**，只有弹窗自身那一层保持 auto。这样即便将来有人给某个
 *    HUD 块（如快捷键提示条）加了 pointer-events:auto，也不可能再出现"某块 HUD 盖住弹窗、
 *    真实鼠标点不进去，而 elementFromPoint 返回的是那块 HUD"。
 * ② 顺手交出指针锁定：锁定状态下浏览器把鼠标事件当 movement 吃掉，真实点击根本落不到
 *    弹窗按钮上，而 JS 的 element.click() 完全不受影响 —— 症状正是"只有 .click() 能触发"。
 *
 * 为什么收敛在每帧的 renderHud 里：modalOpen 有十几处赋值点，
 * 逐个改造漏一处就是一处新 bug；在一处做"最终一致"更可靠（代价只是每帧一次 class 比对）。
 */
function syncModalLayer() {
  if (!hudRoot) return;
  if (hudRoot.classList.contains('has-modal') !== modalOpen) {
    hudRoot.classList.toggle('has-modal', modalOpen);
  }
  if (modalOpen && document.pointerLockElement) {
    try { document.exitPointerLock(); } catch { /* 老内核 / 沙箱下可能抛，忽略即可 */ }
  }
}

/**
 * @param env 环境快照（worldstate.snapshot() 的派生值），由 main 传入。
 *            HUD 本身不持有 worldstate —— 保持"hud 只画、不计算"的边界（ADR-002）。
 */
export function renderHud(env) {
  syncModalLayer();
  if (!els.clock) return;
  els.clock.textContent = fmtClock(state.gameHour);
  const seg = state.segmentLabel ?? '';
  els.segment.textContent = seg;
  els.track.style.width = `${Math.min(100, (state.wallElapsed / NIGHT_SECONDS) * 100)}%`;

  els.night.textContent = String(state.night);
  const cashShown = easeNum('cash', state.cash);
  els.rep.textContent = String(Math.round(easeNum('rep', state.reputation)));
  els.cash.textContent = fmtMoney(cashShown);
  const jumping = Math.abs(state.cash - cashShown) > 1.5;
  els.cash.className = `value ${state.cash < 0 ? 'warn' : 'money'}${jumping ? ' jump' : ''}`;
  els.rev.textContent = fmtMoney(state.revenue);
  if (els.tokens) els.tokens.textContent = String(Math.round(easeNum('tokens', state.tokens ?? 0)));

  /* 经营环境：拆成两行（P2-9）。
   * 原来顾客/满意/洁净/垃圾/故障/倒计时全挤成一行，字小又长，右上角还要被统计栏裁。
   * 第一行放"经营读数"，第二行单独放**事件倒计时**并用高饱和色高亮，
   * 让"还有多久恢复"一眼可见，不必在长串里找。 */
  if (els.envline) {
    if (env) {
      const sat = Math.round((env.satisfaction ?? 1) * 100);
      const clean = Math.round((env.cleanliness ?? 1) * 100);
      let events = '';
      const st = env.incident;
      if (st?.powerOut) events += `<span class="ev ev-bad">⚡ 停电 ${Math.ceil(st.powerLeft)}s</span>`;
      if (st?.surge) events += `<span class="ev ev-brand">🎊 高峰 ${Math.ceil(st.surgeLeft)}s</span>`;
      if (env.posterLeft > 0) events += `<span class="ev ev-ice">📣 海报 ${Math.ceil(env.posterLeft)}s</span>`;
      /* 2026-10-05 促销可视化：促销进行中顶部常驻倒计时（醒目红色） */
      if (env.promoLeft > 0) events += `<span class="ev ev-hot">🔥 促销 9折 ${Math.ceil(env.promoLeft)}s</span>`;
      /* 块6：垃圾堆积警告（≥warnThreshold 件，橙红，复用促销倒计时样式） */
      if (env.garbageCount >= GARBAGE.warnThreshold) events += `<span class="ev ev-hot">🗑 垃圾堆积 ${env.garbageCount}/${GARBAGE.cap}</span>`;

      els.envline.style.display = '';
      els.envline.innerHTML =
        `<div class="env-row">`
        + `<span class="label">顾客</span> <span class="value">${env.npcCount ?? 0}</span>`
        + `<span class="label">满意</span> <span class="value">${sat}%</span>`
        + `<span class="label">洁净</span> <span class="value">${clean}%</span>`
        + `<span class="label">垃圾</span> <span class="value">${env.litterCount ?? 0}</span>`
        + (env.brokenCount > 0 ? `<span class="value warn">故障 ${env.brokenCount}</span>` : '')
        + `</div>`
        + (events ? `<div class="env-events">${events}</div>` : '');
    } else {
      els.envline.style.display = 'none';
    }
  }

  /* 常客在场提示（模块 4 子功能③）：列出今夜在店的熟客，带"熟"标 */
  if (els.regulars) {
    const regs = (state.customers || []).filter((c) => c.regularTag);
    if (regs.length) {
      els.regulars.style.display = '';
      els.regulars.innerHTML = `<span class="reg-label">常客在场</span>`
        + regs.map((c) => `<span class="reg-chip">${c.regularName}<i class="reg-tag">熟</i></span>`).join('');
    } else {
      els.regulars.style.display = 'none';
    }
  }

  /* ---------- 左下角任务追踪（常驻） ----------
   * 需求：没有任务时也要显示一行"空闲 · 去 Tab 商店看看"。
   * 为什么不能"没任务就整块消失"：那样玩家会以为追踪器坏了 / 不知道下一步该干嘛；
   * 常驻的目标是"永远有一句可执行的下一步"。 */
  if (els.quest) {
    if (state.phase !== 'running') {
      els.quest.style.display = 'none';
    } else {
      const q = env?.quest ?? null;
      const flashing = performance.now() < questDoneUntil;
      els.quest.style.display = '';
      els.quest.className = `questpanel${flashing ? ' done' : ''}`;
      if (!q) {
        els.quest.innerHTML = '<div class="q-idle">空闲 · 去 <b>Tab</b> 商店看看</div>';
      } else {
        els.quest.innerHTML =
          `<div class="q-head">
             <span class="q-tag">限时任务</span>
             <span class="q-left${q.left <= 60 ? ' urgent' : ''}">⏱ ${q.left}s</span>
           </div>
           <div class="q-body">${q.label} <b>${q.progress}/${q.goal}</b> ${q.unit}</div>
           <div class="q-bar"><i style="width:${Math.round(q.ratio * 100)}%"></i></div>
           <div class="q-reward">${flashing ? '<span class="q-check">✅ 已完成</span> · ' : ''}奖励 ${q.reward.cash > 0 ? `${fmtYuan(q.reward.cash)} · ` : ''}🎮 ${q.reward.tokens}</div>`;
      }
    }
  }

  // 准星 / 提示
  const h = state.hover;
  if (h && state.phase === 'running' && !state.paused) {
    els.prompt.style.display = '';
    els.prompt.className = `prompt${h.ok ? '' : ' denied'}`;
    els.prompt.innerHTML = `<kbd>E</kbd>${h.prompt}`;
    els.crosshair.className = `crosshair${h.ok ? ' is-hover' : ''}`;
  } else {
    els.prompt.style.display = 'none';
    els.crosshair.className = 'crosshair';
  }

  // 手持
  if (state.held) {
    const sku = SKU_BY_ID[state.held.skuId];
    els.held.style.display = '';
    els.held.textContent = `手中：${sku?.emoji ?? ''} ${sku?.name ?? ''} ×${state.held.qty}`;
  } else {
    els.held.style.display = 'none';
  }

  // 队列（P2-11）：只有真有顾客在等结账时才显示整个面板。
  // 原来恒显示"结账队列(0/5) 暂无顾客"，与右上角"顾客 4~5 人"并列，
  // 玩家会以为排队逻辑坏了 —— 现在是"没人排队就整块消失"。
  if (state.queue.length === 0) {
    if (els.queuebox) els.queuebox.style.display = 'none';
  } else {
    if (els.queuebox) els.queuebox.style.display = '';
    els.qlen.textContent = String(state.queue.length);
    els.qmax.textContent = String(5);
    const head = state.customers.find((c) => c.id === state.queue[0]);
    const blackout = state.blackoutUntil !== null && state.wallElapsed < state.blackoutUntil;
    els.qbody.className = blackout ? 'alert' : '';
    if (blackout) {
      els.qbody.textContent = '⚡ 停电中，无法结账';
    } else if (head && Array.isArray(head.items) && head.items.length) {
      /* 块7：队首显示组合购物篮（主件 + 搭配件） */
      const label = head.items.map((it) => `${SKU_BY_ID[it.skuId]?.name ?? it.skuId} ×${it.qty}`).join(' + ');
      els.qbody.textContent = `队首：${label}（耐心 ${Math.ceil(head.patience ?? 0)}s）`;
    } else {
      const sku = head ? SKU_BY_ID[head.skuId] : null;
      els.qbody.textContent = `队首：${sku?.emoji ?? ''}${sku?.name ?? ''} ×${head?.qty ?? 0}（耐心 ${Math.ceil(head?.patience ?? 0)}s）`;
    }
  }

  // 店员四状态条（R1）：体力/疲惫/饱食/心理，按阈值上色
  const c = state.clerk;
  if (c) {
    setBar(els.barStamina, els.valStamina, c.stamina, statColor(c.stamina, true, CLERK.thr.stamina));
    setBar(els.barFatigue, els.valFatigue, c.fatigue, statColor(c.fatigue, false, CLERK.thr.fatigue));
    setBar(els.barSatiety, els.valSatiety, c.satiety, statColor(c.satiety, true, CLERK.thr.satiety));
    setBar(els.barMental, els.valMental, c.mental, statColor(c.mental, true, CLERK.thr.mental));
  }

  /* 疲劳系统：玩家疲劳读数（独立于店员，只在有疲劳时显示；打瞌睡时画遮罩） */
  const pf = env?.fatigue ?? 0;
  const pfLevel = env?.fatigueLevel ?? 0;
  if (els.pfatigue) {
    if (pf > 0) {
      els.pfatigue.style.display = 'flex';
      els.pfval.textContent = String(Math.round(pf));
      els.pfval.style.color = pfLevel >= 3 ? 'var(--warning)' : pfLevel >= 2 ? 'var(--brand)' : 'var(--money)';
    } else {
      els.pfatigue.style.display = 'none';
    }
  }
  if (els.doze) {
    els.doze.style.display = env?.dozing ? 'block' : 'none';
  }
}

/* ---------- Toast（提示队列） ----------
 * 线上问题：多件事同时发生（"该格已有其他商品""没对准""已上架""手上的货没放干净"）
 * 时，原来的实现直接把 div 往容器里塞并只裁到 4 条，结果几条提示**同屏堆叠**，
 * 玩家一条都读不清。
 * 现在改成**队列**：同屏最多 2 条，超出的排队等待；每条约 3 秒自动消失后
 * 下一条才补位；新提示从下方淡入 —— 永不同屏重叠。
 */
const MAX_TOASTS = 2;
const toastQueue = [];
const toastLive = [];
let toastTimers = [];

function pumpToasts() {
  while (toastLive.length < MAX_TOASTS && toastQueue.length) {
    const it = toastQueue.shift();
    const div = document.createElement('div');
    div.className = `toast ${it.kind}`;
    div.textContent = it.msg;
    els.toasts.appendChild(div);
    toastLive.push(div);
    const t = setTimeout(() => {
      div.classList.add('out');
      const rm = setTimeout(() => div.remove(), 200);
      toastTimers.push(rm);
      const i = toastLive.indexOf(div);
      if (i >= 0) toastLive.splice(i, 1);
      pumpToasts();
    }, it.duration);
    toastTimers.push(t);
  }
}

export function toast(msg, kind = 'ok', duration = 3000) {
  if (!els.toasts) return;
  toastQueue.push({ msg, kind, duration });
  pumpToasts();
}

/* ---------- 存档提示（右上角磨砂 · 2s 自动消失） ----------
   独立容器而不用 .toasts：存档反馈要固定在右上角且不挤走普通提示，
   同时它是 fixed 定位（挂在 body 上），不受 hud-root 的层级/裁剪影响。 */
let saveToastEl = null;
let saveToastTimer = null;

export function saveToast(msg, kind = 'ok', duration = 2000) {
  if (!saveToastEl) {
    saveToastEl = document.createElement('div');
    document.body.appendChild(saveToastEl);
  }
  saveToastEl.textContent = msg;
  // 先移除 show 再强制重排，让连续两次存档也能重新播放进场动画
  saveToastEl.className = `save-toast ${kind}`;
  void saveToastEl.offsetWidth;
  saveToastEl.classList.add('show');

  clearTimeout(saveToastTimer);
  saveToastTimer = setTimeout(() => {
    if (saveToastEl) saveToastEl.classList.remove('show');
  }, duration);
}

/* ---------- 模态 ---------- */
export function closeModal() {
  const mask = els.modal.querySelector('.modal-mask');
  if (mask) {
    // 手感 4：关闭也走 0.15s 淡出，不硬切。
    // 用 parentNode 守卫：若淡出期间又打开了新面板，就别把它清掉。
    mask.classList.add('closing');
    setTimeout(() => { if (mask.parentNode === els.modal) els.modal.innerHTML = ''; }, 150);
  } else {
    els.modal.innerHTML = '';
  }
  modalOpen = false;
  // 立即摘掉 has-modal（不等下一帧的 syncModalLayer），关窗瞬间底层 HUD 就恢复可交互
  if (hudRoot) hudRoot.classList.remove('has-modal');
}

export function openStart(onStart) {
  els.start.innerHTML = `
    <div class="start-mask">
      <h1>夜班便利店</h1>
      <div class="tag">NIGHT SHIFT · 垂直切片</div>
      <div class="keys">
        <b>WASD</b> 移动 · <b>Shift</b> 小跑 · <b>点击画面</b> 锁定鼠标转视角<br>
        <b>E</b> 取货 / 上货 / 结账 / 维修 / 清扫 · <b>Tab</b> 打开进货面板 · <b>L</b> 本地排行榜 · <b>Esc</b> 暂停<br>
        <b>F5</b> 手动存档 · <b>F9</b> 读取最近一次存档（营业中每 120 游戏秒自动存档一次）<br>
        先按 <b>Tab</b> 采购，再从库存箱取货摆上货架，顾客来了记得收银
      </div>
      <button class="btn primary" data-act="start" style="margin-top:14px">点击开始营业</button>
    </div>`;
  modalOpen = true;
  els.start.querySelector('[data-act="start"]').addEventListener('click', () => {
    els.start.innerHTML = '';
    modalOpen = false;
    onStart?.();
  });
}

/**
 * 经营面板（需求J 重构为四分页：进货 / 商店 / 店员 / 仓库）
 *
 * ── 为什么用 onclick 赋值而不是 addEventListener ──────────
 * 分页里的操作（升级 / 装拆模块 / 扩建 / 雇佣 / 采购 / 入库）执行后要**就地重绘**
 * 刷新现金与状态，重绘会替换 innerHTML 但容器 els.modal 本身不变 ——
 * 用 addEventListener 会逐次累加监听器，表现为"点一次弹出两条 toast"。赋值 onclick 天然覆盖。
 *
 * @param purchaseFn   可选 · 进货采购函数 (skuId, qty) => {ok,...}（决定"进货"分页是否出现）
 * @param shop         可选 · 门店投资分区 API（决定"商店"分页）
 * @param staffApi     可选 · 店员管理 API（决定"店员"分页）
 * @param warehouseApi 可选 · 仓库管理 API（决定"仓库"分页）
 * 四个 API 都有时 Tab 键会展开全部四页；只传 warehouseApi 时（R 键）只显示"仓库"一页。
 */
export function openPurchase(onClose, purchaseFn = null, shop = null, staffApi = null, warehouseApi = null, growthApi = null, secondhandApi = null, boonsApi = null, deliveryApi = null) {
  /** 改装分区当前选中的设备（纯 HUD 本地状态，面板一关就没意义，不进 state） */
  let modTarget = null;
  /** 仓库低库存提示每开一次面板只弹一次（切回仓库分页不重复弹） */
  let lowNotified = false;

  /* 出现的分页（按固定顺序） */
  const tabs = [];
  if (purchaseFn) tabs.push({ id: 'buy', label: '🛒 进货' });
  if (shop) tabs.push({ id: 'shop', label: '⬆ 商店' });
  if (staffApi) tabs.push({ id: 'staff', label: '👷 店员' });
  if (warehouseApi) tabs.push({ id: 'wh', label: '📦 仓库' });
  if (growthApi) tabs.push({ id: 'price', label: '🏷 定价' });
  if (secondhandApi) tabs.push({ id: 'second', label: '♻ 二手' });
  /* 代币出口：兑换（确定性）/ 扭蛋（抽奖）。两页分开是因为交互节奏完全不同：
   * 兑换是"看清楚再决定"，扭蛋是"点一下就有反馈"，混在一页会互相干扰。 */
  if (boonsApi) tabs.push({ id: 'boons', label: '🪙 代币兑换' });
  if (boonsApi) tabs.push({ id: 'gacha', label: '🎰 代币扭蛋' });
  if (tabs.length === 0) tabs.push({ id: 'buy', label: '🛒 进货' });
  let current = tabs[0].id;

  const TITLE = {
    buy: '进货面板', shop: '门店投资', staff: '店员管理', wh: '仓库管理',
    price: '定价与情报', second: '♻ 二手市场',
    boons: '🪙 代币兑换', gacha: '🎰 代币扭蛋',
  };

  /* ---------- 需求I ①③④⑦ 三个新分区（商店页） ---------- */
  function shopSections() {
    if (!shop) return '';
    const snap = shop.snapshot();

    /* ① 设备升级 */
    const devRows = snap.devices.map((d) => {
      const c = d.canUpgrade;
      const act = d.upgradeCost == null
        ? '<span class="mod-slots">已满级</span>'
        : `<button class="mini-btn" data-act="upgrade" data-id="${d.id}" ${c.ok ? '' : 'disabled'}>升 Lv${d.level + 1} · ${fmtYuan(d.upgradeCost)}</button>`;
      const why = c.ok || d.upgradeCost == null ? '' : ` · <span class="warn">${c.reason}</span>`;
      return `<div class="dev-row">
        <div>
          <div class="d-name">${d.emoji} ${d.name}</div>
          <div class="d-meta">吸引 ×${d.attractMul.toFixed(2)} · 收益 ×${d.revenueMul.toFixed(2)} · 故障 ×${d.breakMul.toFixed(2)}${why}</div>
        </div>
        <span class="lv-badge lv${d.level}">Lv${d.level}</span>
        ${act}
      </div>`;
    }).join('');

    /* ④ 机器改装：先选设备，再对这台设备装/拆 */
    if (!modTarget || !snap.devices.some((d) => d.id === modTarget)) {
      modTarget = snap.devices[0]?.id ?? null;
    }
    const cur = snap.devices.find((d) => d.id === modTarget) ?? null;
    const chips = snap.devices.map((d) =>
      `<span class="chip ${d.id === modTarget ? 'active' : ''}" data-act="pick" data-id="${d.id}">${d.emoji}${d.name}</span>`).join('');
    const modRows = snap.modules.map((m) => {
      const on = cur?.mods.includes(m.id);
      const full = !on && (cur?.mods.length ?? 0) >= MODULE_MAX_PER_DEVICE;
      const btn = on
        ? `<button class="mini-btn danger" data-act="unmod" data-mod="${m.id}">拆除 · ${fmtYuan(m.cost * MODULE_REFUND)}</button>`
        : `<button class="mini-btn" data-act="mod" data-mod="${m.id}" ${full ? 'disabled' : ''}>安装 ${fmtYuan(m.cost)}</button>`;
      return `<div class="mod-row">
        <div>
          <div class="m-name">${m.emoji} ${m.name}</div>
          <div class="m-eff">${m.eff}${on ? ' · <span class="on">已装</span>' : ''}</div>
        </div>
        ${btn}
      </div>`;
    }).join('');

    /* ⑦ 店铺扩建 */
    const expRows = snap.expansions.map((e) => {
      const btn = e.owned
        ? '<span class="e-owned">✓ 已解锁</span>'
        : `<button class="mini-btn" data-act="exp" data-id="${e.id}" ${e.canBuy.ok ? '' : 'disabled'}>${fmtYuan(e.cost)}</button>`;
      const why = e.owned || e.canBuy.ok ? '' : ` · <span class="warn">${e.canBuy.reason}</span>`;
      return `<div class="exp-row">
        <div>
          <div class="e-name">${e.emoji} ${e.name}</div>
          <div class="e-desc">${e.desc}${why}</div>
        </div>
        ${btn}
      </div>`;
    }).join('');

    return `
      <div class="shop-sec">
        <div class="sec-head">⬆ 设备升级 <span class="sec-sub">故障中需先维修</span></div>
        ${devRows}
      </div>
      <div class="shop-sec">
        <div class="sec-head">🔧 机器改装 <span class="sec-sub">每台最多 ${MODULE_MAX_PER_DEVICE} 种 · 拆除回收半价</span></div>
        <div class="mod-devs">${chips}</div>
        ${modRows}
      </div>
      <div class="shop-sec">
        <div class="sec-head">🏗 店铺扩建 <span class="sec-sub">按顺序解锁 · 场景同步扩大</span></div>
        ${expRows}
      </div>`;
  }

  /* ---------- 进货页（2026-10-06 块5：下单制 + 运费） ---------- */
  /* 需求给的样式是「商品列表 → 运费 → 总数 → 余额 → 剩余」，
   * 所以底部结算区要分行显示：货值 / 运费 / 总计 / 余额 / 仓库剩余。 */
  function buyContent() {
    const list = availableSkus();
    const rows = list.map((s) => `
      <div class="row" data-sku="${s.id}">
        <div>
          <div class="name">${s.emoji} ${s.name}</div>
          <div class="meta">进 ${fmtYuan(s.cost)} / 售 ${fmtYuan(state.prices[s.id] ?? s.price)} · 保质 ${s.shelfLife} 夜 · 起订 ${s.moq}
            · 库存箱 ${state.backroom[s.id] ?? 0} · 货架 ${sellable(s.id)}</div>
        </div>
        <div class="qty">
          <button data-act="minus">−</button>
          <input type="number" value="${s.moq}" min="${s.moq}" step="1" data-act="qty">
          <button data-act="plus">+</button>
        </div>
      </div>`).join('');
    const dlv = typeof deliveryApi?.panel === 'function' ? deliveryApi.panel() : null;
    /* 在途区：需求要求"进货页能看到订单"。为空时不占位。 */
    const transitRows = (dlv?.transit ?? []).map((o) => `
      <div class="row" data-transit="${o.uid}">
        <div>
          <div class="name">${SKU_BY_ID[o.skuId]?.emoji ?? ''} ${SKU_BY_ID[o.skuId]?.name ?? o.skuId}
            <span class="tag-transit">${DELIVERY.transitLabel}</span></div>
          <div class="meta">${o.qty} 件 · 约 ${o.left}s 后到货</div>
        </div>
      </div>`).join('');
    const crateRows = (dlv?.crates ?? []).map((c) => `
      <div class="row">
        <div>
          <div class="name">📦 待拾取货箱 <span class="tag-transit">已到货</span></div>
          <div class="meta">${c.items.map((it) => `${SKU_BY_ID[it.skuId]?.name ?? it.skuId}×${it.qty}`).join(' + ')} · 共 ${c.total} 件</div>
        </div>
      </div>`).join('');
    const dlvBlock = (transitRows || crateRows) ? `
      <div class="shop-sec">
        <div class="sec-head">🚚 运输状态 <span class="sec-sub">下单后 ${DELIVERY.transitSec}s 到货 · 到店口按 E 拾取</span></div>
        ${crateRows}${transitRows}
      </div>` : '';
    return `<div class="sub">现金 ${fmtMoney(state.cash)} · 下单后 ${DELIVERY.transitSec}s 到货（到店口按 E 拾取，再按 E 入库存箱）</div>
      ${dlvBlock}
      <div class="rows">${rows}</div>
      <div class="report">
        <div class="line"><span>货值</span><span data-el="goods">¥0</span></div>
        <div class="line"><span>运费（${fmtYuan(DELIVERY.feeBase)} + ${fmtYuan(DELIVERY.feePerItem)}/件）</span><span data-el="fee">¥0</span></div>
        <div class="line"><span>总计</span><span data-el="total">¥0</span></div>
        <div class="line"><span>余额</span><span data-el="bal">${fmtMoney(state.cash)}</span></div>
        <div class="line"><span>仓库剩余</span><span data-el="free">—</span></div>
      </div>`;
  }
  function recalcBuy() {
    const totalEl = els.modal.querySelector('[data-el="total"]');
    if (!totalEl) return;
    let goods = 0, items = 0;
    /* 只处理带 data-sku 的商品行；块5 在进货页插入的「在途/货箱」行也用 .row 类，
     * 但不带 data-sku 也没有 [data-act="qty"] 输入框 —— 若一起遍历会读到 null.value 崩。 */
    for (const row of els.modal.querySelectorAll('.row[data-sku]')) {
      const sku = SKU_BY_ID[row.dataset.sku];
      const q = Number(row.querySelector('[data-act="qty"]').value) || 0;
      goods += q * sku.cost;
      items += q;
    }
    const fee = items > 0 ? Math.round((DELIVERY.feeBase + DELIVERY.feePerItem * items) * 100) / 100 : 0;
    const total = Math.round((goods + fee) * 100) / 100;
    const set = (el, v) => { const e = els.modal.querySelector(`[data-el="${el}"]`); if (e) e.textContent = v; };
    set('goods', fmtMoney(goods));
    set('fee', fmtMoney(fee));
    set('total', fmtMoney(total));
    set('bal', fmtMoney(state.cash - total));
    const freeEl = els.modal.querySelector('[data-el="free"]');
    if (freeEl) {
      const free = typeof warehouseApi?.free === 'function' ? warehouseApi.free() : null;
      freeEl.textContent = free === null ? '—' : `${free} 件`;
    }
    totalEl.textContent = fmtMoney(total);
    totalEl.style.color = total > state.cash ? 'var(--danger-text)' : 'var(--money)';
  }
  function doBuy() {
    let ok = 0, fail = '';
    for (const r of els.modal.querySelectorAll('.row[data-sku]')) {
      const q = Number(r.querySelector('[data-act="qty"]').value) || 0;
      if (q > 0) {
        /* 2026-10-06 块5：走 delivery 下单（不再即时到仓）。
         * ⚠ purchaseFn 保留为 fallback：deliveryApi 没注入时（老调用方/单测）
         *   仍按原语义即时采购 —— 与"缺 loyal 就返回空态"同一个降级原则：
         *   新功能缺失不该把旧功能一起弄坏。 */
        const res = deliveryApi?.order
          ? deliveryApi.order(r.dataset.sku, q)
          : purchaseFn?.(r.dataset.sku, q);
        if (res?.ok) ok += 1; else fail = res?.reason ?? '失败';
      }
    }
    if (ok) toast(`已下单 ${ok} 项 · ${DELIVERY.transitSec}s 后到货`, 'ok');
    if (fail) toast(fail, 'bad');
    closeModal();
    onClose?.();
  }

  /* ---------- 店员页（需求J） ---------- */
  const STAFF_STATUS = {
    idle: '待命', working: '工作中', resting: '休息中', errand: '外出采购', stopped: '停工',
    repair: '维修中', clean: '清理中', 'stock-shelf': '补货架', 'stock-vending': '补售货机', 'stock-claw': '补娃娃机',
  };
  function staffContent() {
    const snap = staffApi.snapshot();
    const rows = snap.roster.map((r) => {
      const def = STAFF.types[r.type];
      const can = staffApi.canHire(r.type);
      const statusLabel = STAFF_STATUS[r.status] ?? r.status;
      const barColor = r.stamina < STAFF.restStamina ? 'var(--warning)' : 'var(--brand)';
      const btn = r.hired
        ? `<button class="mini-btn danger" data-act="fire" data-type="${r.type}">解雇</button>`
        : `<button class="mini-btn" data-act="hire" data-type="${r.type}" ${can.ok ? '' : 'disabled'}>雇用 · ${fmtYuan(r.hireCost)}</button>`;
      const why = (!r.hired && !can.ok) ? `<span class="warn"> · ${can.reason}</span>` : '';
      const bar = r.hired ? `<div class="s-bar"><i style="width:${r.stamina}%;background:${barColor}"></i></div>` : '';
      const badge = r.hired
        ? `<span class="s-status ${r.status}">${statusLabel}</span>`
        : `<span class="s-status idle">未雇佣</span>`;
      const meta = r.hired
        ? `薪资 ${fmtYuan(r.salary)}/次 · 体力 ${r.stamina} · 下次发薪 ${Math.ceil(snap.salaryDueIn)}s${snap.stopped ? ' · <span class="warn">已停工</span>' : ''}`
        : `薪资 ${fmtYuan(r.salary)}/次`;
      return `<div class="staff-row ${r.hired ? 'hired' : ''}">
        <div class="s-emoji">${r.emoji}</div>
        <div>
          <div class="s-name">${def.name}</div>
          <div class="s-desc">${def.desc}</div>
          <div class="s-meta">${meta}${why}</div>
          ${badge}${bar}
        </div>
        <div>${btn}</div>
      </div>`;
    }).join('');
    /* 上限来自快照而不是 config：星级每升 1 级，店员总上限 +1 */
    const cap = snap.cap ?? STAFF.maxTotal;
    const per = cap > STAFF.order.length ? '（升星后可增聘同岗位）' : '（各 1 人）';
    return `<div class="sub">店员 ${snap.headcount ?? 0}/${cap} 名${per} · 每 ${STAFF.salarySec}s 扣一次薪资 · 现金不足全员停工</div>${rows}`;
  }

  /* ---------- 仓库页（需求J） ---------- */
  function whBatch(id) { return id === 'snack' ? 30 : (WAREHOUSE.goods[id]?.threshold ?? 5); }
  function whStep(id) { return id === 'snack' ? 10 : 1; }
  function warehouseContent() {
    const snap = warehouseApi.snapshot();
    const capPct = snap.cap ? Math.min(100, Math.round((snap.used / snap.cap) * 100)) : 0;
    const capColor = snap.free <= 0 ? 'var(--warning)' : 'linear-gradient(90deg,var(--neon-ice),var(--neon-purple))';
    const goods = snap.goods.map((g) => {
      const low = g.qty < g.threshold;
      const dflt = whBatch(g.id);
      return `<div class="wh-row ${low ? 'low' : ''}">
        <div class="w-emoji">${g.emoji}</div>
        <div>
          <div class="w-name">${g.name}${low ? ' ⚠' : ''}</div>
          <div class="w-meta">库存 ${g.qty}${g.unit} · 阈值 ${g.threshold} · 单价 ${fmtYuan(g.cost)}</div>
        </div>
        <div class="w-buy">
          <button class="mini-btn" data-act="wh-minus" data-good="${g.id}">−</button>
          <input type="number" value="${dflt}" min="1" data-act="wh-qty" data-good="${g.id}">
          <button class="mini-btn" data-act="wh-plus" data-good="${g.id}">+</button>
          <button class="mini-btn" data-act="wh-buy" data-good="${g.id}">采购</button>
        </div>
      </div>`;
    }).join('');
    const upgrade = snap.nextTier
      ? `<button class="mini-btn" data-act="wh-upgrade">扩容至 Lv${snap.nextTier.level} · 容量 ${snap.nextTier.cap} · ${fmtYuan(snap.nextTier.cost)}</button>`
      : '<span class="mod-slots">已达最大容量</span>';
    return `
      <div class="sub">仓库只存货品 · 机器零件与装饰不占容量</div>
      <div class="wh-cap">
        <div class="wh-cap-text">容量 ${snap.used} / ${snap.cap}（剩余 ${snap.free}）· Lv${snap.level}</div>
        <div class="wh-cap-bar"><i style="width:${capPct}%;background:${capColor}"></i></div>
      </div>
      ${goods}
      <div class="shop-sec">
        <div class="sec-head">📦 仓库扩容</div>
        ${upgrade}
      </div>
      <div class="wh-tip">采购员会在库存低于阈值时自动外出补货（少量溢价）。手动采购即时扣款入库存箱 / 仓库。</div>`;
  }
  function notifyLowStock() {
    const snap = warehouseApi.snapshot();
    const low = snap.goods.filter((g) => g.qty < g.threshold).map((g) => g.name);
    if (low.length) toast(`⚠ 仓库库存偏低：${low.join('、')}`, 'bad', 2600);
  }

  /* ---------- 定价页（单品调价 ±20% / 限时促销 / 情报服务 / 临期提醒） ---------- */
  function priceContent() {
    const snap = growthApi.snapshot();
    const rows = snap.sheet.map((r) => {
      const pct = Math.round((r.mul - 1) * 100);
      const cls = pct > 0 ? 'up' : pct < 0 ? 'down' : '';
      return `<div class="price-row ${cls}">
        <div>
          <div class="p-name">${r.emoji} ${r.name}</div>
          <div class="p-meta">建议 ${fmtYuan(r.base)} → 现价 <b>${fmtYuan(r.price)}</b>（${pct >= 0 ? '+' : ''}${pct}%）
            · 需求 ×${r.demand.toFixed(2)}</div>
        </div>
        <div class="p-btns">
          <button class="mini-btn" data-act="price-minus" data-sku="${r.skuId}">−</button>
          <button class="mini-btn" data-act="price-reset" data-sku="${r.skuId}">复位</button>
          <button class="mini-btn" data-act="price-plus" data-sku="${r.skuId}">+</button>
        </div>
      </div>`;
    }).join('');

    const promoBtn = snap.promo
      ? `<span class="mod-slots">⏱ 促销进行中 · 剩余 ${Math.ceil(snap.promo.remaining)}s · 全店 ${Math.round(snap.promo.mul * 100) / 10} 折</span>`
      : `<button class="mini-btn" data-act="promo">开启促销 · ${fmtYuan(snap.cost)}</button>`;

    const intel = snap.intelKnown
      ? `<span class="mod-slots">🔮 明晚主题已预知：${snap.intelTheme}</span>`
      : `<button class="mini-btn" data-act="intel">🔮 情报服务 · ${fmtYuan(snap.intelCost)}</button>`;

    return `
      <div class="sub">单品可在 ±20% 内调价：价高走量慢、满意度略降；价低走量快</div>
      ${rows}
      <div class="shop-sec">
        <div class="sec-head">⏱ 全店限时促销 <span class="sec-sub">开启后立刻引来一波客流</span></div>
        ${promoBtn}
      </div>
      <div class="shop-sec">
        <div class="sec-head">🔮 情报服务 <span class="sec-sub">预知明晚的夜间主题</span></div>
        ${intel}
      </div>
      <div class="shop-sec">
        <div class="sec-head">⚠ 临期提醒</div>
        <div class="sec-sub">${snap.expiring > 0 ? `有 ${snap.expiring} 个货架格的商品今夜结束即过期，建议降价清仓` : '暂无临期商品'}</div>
      </div>`;
  }

  /* ---------- 二手市场页（模块 4 子功能②） ---------- */
  function secondContent() {
    if (!secondhandApi) return '';
    const snap = secondhandApi.snapshot();
    const listings = snap.listings.map((l) => `
      <div class="sh-row">
        <div>
          <div class="sh-name">${l.emoji} ${l.name} ${l.faulty ? '<span class="warn">⚠ 故障机</span>' : '<span class="on">✓ 良品</span>'}</div>
          <div class="sh-meta">二手挂牌 · ${l.faulty ? '买到手需先维修' : '买到即用'}</div>
        </div>
        <button class="mini-btn" data-act="sh-buy" data-id="${l.id}" ${state.cash >= l.price ? '' : 'disabled'}>买 · ${fmtYuan(l.price)}</button>
      </div>`).join('') || '<div class="sec-sub">今夜暂无二手挂牌，明晚再来逛逛</div>';

    const owned = snap.owned.map((o) => `
      <div class="sh-row">
        <div>
          <div class="sh-name">${o.emoji} ${o.name} ${o.broken ? '<span class="warn">🔧 故障中</span>' : '<span class="on">✓ 运转中</span>'}</div>
          <div class="sh-meta">每夜产出代币 · ${o.broken ? '故障停机无收益' : '正常运转'}</div>
        </div>
        <div class="sh-btns">
          ${o.broken ? `<button class="mini-btn" data-act="sh-repair" data-id="${o.id}" ${state.cash >= SECONDHAND.repairCost ? '' : 'disabled'}>修 · ${fmtYuan(SECONDHAND.repairCost)}</button>` : ''}
          <button class="mini-btn danger" data-act="sh-recycle" data-id="${o.id}">回收 · ${fmtYuan(o.price * SECONDHAND.recycleMul)}</button>
        </div>
      </div>`).join('') || '<div class="sec-sub">还没有二手设备，去挂牌里淘一台吧</div>';

    return `
      <div class="sub">现金 ${fmtMoney(state.cash)} · 二手设备是经营资产：良品每夜产代币，故障机先修再用，不想要了可回收退 50%</div>
      <div class="shop-sec">
        <div class="sec-head">♻ 今夜二手挂牌 <span class="sec-sub">约 30% 是故障机，价格更低</span></div>
        ${listings}
      </div>
      <div class="shop-sec">
        <div class="sec-head">🛠 我的二手设备 <span class="sec-sub">${snap.owned.length} 台</span></div>
        ${owned}
      </div>`;
  }

  /* ---------- 🪙 代币兑换页（永久增益，一次性、跨夜、读档保留） ---------- */
  function boonsContent() {
    if (!boonsApi) return '';
    const snap = boonsApi.snapshot();
    const rows = snap.rows.map((b) => {
      // 三态按钮：可买 / 代币不足（置灰）/ 已拥有（不可重复购买）
      // 「员工位 +1」是可重复购买的，所以它永远不会进 "已拥有" 态，而是显示已买次数。
      const btn = b.owned
        ? '<span class="mod-slots">✅ 已拥有</span>'
        : `<button class="mini-btn" data-act="boon-buy" data-key="${b.key}" ${b.affordable ? '' : 'disabled'}>
             ${b.affordable ? `兑换 · 🪙 ${b.cost}` : `🪙 ${b.cost}（代币不足）`}
           </button>`;
      const lv = b.once ? '' : (b.level > 0 ? `<span class="on">已兑换 ${b.level} 次</span>` : '');
      return `<div class="sh-row">
        <div>
          <div class="sh-name">${b.emoji} ${b.name} ${lv}</div>
          <div class="sh-meta">${b.desc}</div>
        </div>
        ${btn}
      </div>`;
    }).join('');

    const cards = snap.cards.length
      ? snap.cards.map((c) => `<div class="sh-row">
          <div>
            <div class="sh-name">${c.meta?.emoji ?? '🎟️'} ${c.meta?.name ?? c.kind}</div>
            <div class="sh-meta">第 ${c.expireNight} 夜生效 · 剩余 ${c.left} 夜${c.left <= 0 ? ' · <span class="warn">已过期</span>' : ''}</div>
          </div>
          <span class="mod-slots">限时券</span>
        </div>`).join('')
      : '<div class="shop-sec"><div class="sec-sub">暂无限时券 — 去「🎰 代币扭蛋」抽一张</div></div>';

    return `
      <div class="sub">持有代币 <b>🪙 ${snap.tokens}</b> · 永久增益一次性买断，跨夜与读档都保留</div>
      <div class="shop-list">
        <div class="shop-sec">
          <div class="sec-head">🪙 永久增益</div>
          ${rows}
        </div>
        <div class="shop-sec">
          <div class="sec-head">🎟️ 我的限时券</div>
          <div class="sec-sub">同夜同类不叠加（取最高）；打烊结算后按夜失效</div>
          ${cards}
        </div>
      </div>`;
  }

  /* ---------- 🎰 代币扭蛋页（抽奖，概率必须公示且与实际一致） ---------- */
  function gachaContent() {
    if (!boonsApi) return '';
    const snap = boonsApi.snapshot();
    const g = snap.gacha;
    const can = snap.tokens >= g.cost;
    // 概率表直接来自 boons.mjs 的 gachaTable() —— 与 rollPrize 同源，
    // 所以"公示 = 实际"是结构保证，不靠人工同步两份数字。
    const table = g.tiers.map((t) => `
      <div class="sh-row">
        <div>
          <div class="sh-name">${t.emoji} ${t.name} <span class="on">${t.pct}%</span></div>
          <div class="sh-meta">${t.items.map((i) => i.label).join(' / ')}</div>
        </div>
        <span class="mod-slots">${t.pct}%</span>
      </div>`).join('');

    return `
      <div class="sub">持有代币 <b>🪙 ${snap.tokens}</b> · 抽奖 🪙 ${g.cost} / 次 · 不限次数</div>
      <div class="shop-list">
        <div class="shop-sec">
          <div class="sec-head">🎰 扭蛋机</div>
          <div class="sh-row">
            <div><div class="sh-name">🎰 扭一次</div>
            <div class="sh-meta">现金与永久增益即时入账；限时券进背包，下夜生效</div></div>
            <button class="btn primary" data-act="gacha-pull" ${can ? '' : 'disabled'}>
              ${can ? `抽 · 🪙 ${g.cost}` : `🪙 代币不足`}
            </button>
          </div>
        </div>
        <div class="shop-sec">
          <div class="sec-head">📊 奖品概率表（公示 = 实际）</div>
          ${table}
        </div>
      </div>`;
  }

  function render() {
    const tabbar = `<div class="tabbar">${tabs.map((t) =>
      `<div class="tab ${t.id === current ? 'active' : ''}" data-act="tab" data-id="${t.id}">${t.label}</div>`).join('')}</div>`;
    const content = current === 'buy' ? buyContent()
      : current === 'shop' ? `<div class="shop-list">${shopSections()}</div>`
      : current === 'staff' ? staffContent()
      : current === 'price' ? priceContent()
      : current === 'second' ? secondContent()
      : current === 'boons' ? boonsContent()
      : current === 'gacha' ? gachaContent()
      : warehouseContent();
    const buyBtn = current === 'buy' ? '<button class="btn primary" data-act="buy">确认采购</button>' : '';
    els.modal.innerHTML = `
      <div class="modal-mask">
        <div class="modal">
          <h2>${TITLE[current]}</h2>
          ${tabbar}
          <div data-el="content">${content}</div>
          <div class="actions">
            <button class="btn" data-act="close">关闭</button>
            ${buyBtn}
          </div>
        </div>
      </div>`;
    modalOpen = true;
    bind();
    // 进入仓库页时（仅一次）提示低库存
    if (current === 'wh' && !lowNotified) { lowNotified = true; notifyLowStock(); }
  }

  function bind() {
    els.modal.oninput = () => {
      if (current === 'buy') recalcBuy();
    };
    els.modal.onclick = (e) => {
      const el = e.target.closest('button, .tab, .chip');
      if (!el) return;
      const act = el.dataset.act;
      if (!act) return;

      if (act === 'tab') { current = el.dataset.id; render(); return; }
      if (act === 'close') { closeModal(); onClose?.(); return; }

      if (current === 'buy') {
        if (act === 'buy') { doBuy(); return; }
        if (act === 'plus' || act === 'minus') {
          const row = el.closest('.row');
          const sku = SKU_BY_ID[row.dataset.sku];
          const input = row.querySelector('[data-act="qty"]');
          if (act === 'plus') input.value = String(Number(input.value) + 1);
          if (act === 'minus') input.value = String(Math.max(sku.moq, Number(input.value) - 1));
          recalcBuy();
        }
        return;
      }

      if (current === 'shop') {
        if (act === 'pick') { modTarget = el.dataset.id; render(); return; }
        if (act === 'upgrade') {
          const r = shop.onUpgrade(el.dataset.id);
          toast(r?.ok ? `⬆ 升级成功 · Lv${r.level} · ${fmtYuan(-r.cost)}` : (r?.reason ?? '升级失败'), r?.ok ? 'ok' : 'bad');
          render(); return;
        }
        if (act === 'mod') {
          const r = shop.onInstall(modTarget, el.dataset.mod);
          toast(r?.ok ? `🔧 已安装 · ${fmtYuan(-r.cost)}` : (r?.reason ?? '安装失败'), r?.ok ? 'ok' : 'bad');
          render(); return;
        }
        if (act === 'unmod') {
          const r = shop.onRemove(modTarget, el.dataset.mod);
          toast(r?.ok ? `🔧 已拆除 · 回收 ${fmtYuan(r.refund)}` : (r?.reason ?? '拆除失败'), r?.ok ? 'ok' : 'bad');
          render(); return;
        }
        if (act === 'exp') {
          const r = shop.onExpansion(el.dataset.id);
          toast(r?.ok ? `🏗 ${r.def?.name ?? '扩建'} 已解锁 · 场景已扩大` : (r?.reason ?? '扩建失败'), r?.ok ? 'ok' : 'bad', 3600);
          render(); return;
        }
        return;
      }

      if (current === 'staff') {
        if (act === 'hire') {
          const r = staffApi.hire(el.dataset.type);
          const def = STAFF.types[el.dataset.type];
          toast(r?.ok ? `已雇佣 ${def.emoji} ${def.name} · 解雇前持续扣薪` : (r?.reason ?? '雇佣失败'), r?.ok ? 'ok' : 'bad');
          render(); return;
        }
        if (act === 'fire') {
          const r = staffApi.fire(el.dataset.type);
          const def = STAFF.types[el.dataset.type];
          toast(r?.ok ? `已解雇 ${def.name}` : (r?.reason ?? '解雇失败'), r?.ok ? 'info' : 'bad');
          render(); return;
        }
        return;
      }

      if (current === 'price') {
        if (act === 'price-plus' || act === 'price-minus') {
          const r = growthApi.adjust(el.dataset.sku, act === 'price-plus' ? 1 : -1);
          toast(`${r.name} 调至 ${fmtYuan(r.price)}（${r.pct >= 0 ? '+' : ''}${r.pct}%）`, 'ok', 1600);
          render(); return;
        }
        if (act === 'price-reset') {
          const r = growthApi.resetPrice(el.dataset.sku);
          toast(`${r.name} 恢复建议价 ${fmtYuan(r.price)}`, 'info', 1600);
          render(); return;
        }
        if (act === 'promo') {
          const r = growthApi.startPromo();
          toast(r?.ok ? '⏱ 限时促销开始 · 一波客人正在赶来' : (r?.reason ?? '开启失败'), r?.ok ? 'ok' : 'bad', 3200);
          render(); return;
        }
        if (act === 'intel') {
          const r = growthApi.buyIntel();
          toast(r?.ok ? `🔮 明晚主题：${r.theme?.name ?? '未知'}` : (r?.reason ?? '购买失败'), r?.ok ? 'ok' : 'bad', 3600);
          render(); return;
        }
        return;
      }

      /* 代币兑换：toast 由 boonsApi 统一播报（成功/失败都在那里给反馈，
       * 这里只负责重绘面板 —— 否则会出现"点了没反应"）。 */
      if (current === 'boons') {
        if (act === 'boon-buy') {
          boonsApi.buy(el.dataset.key);
          render(); return;
        }
        return;
      }

      if (current === 'gacha') {
        if (act === 'gacha-pull') {
          boonsApi.pull();
          render(); return;
        }
        return;
      }

      if (current === 'second') {
        if (act === 'sh-buy') {
          const r = secondhandApi.buy(el.dataset.id);
          toast(r?.ok ? `♻ 已购入 ${r.owned.emoji} ${r.owned.name}${r.owned.faulty ? '（故障机，需维修）' : ''} · ${fmtYuan(-r.owned.price)}` : (r?.reason ?? '购买失败'), r?.ok ? 'ok' : 'bad');
          render(); return;
        }
        if (act === 'sh-repair') {
          const r = secondhandApi.repairOwned(el.dataset.id);
          toast(r?.ok ? `🔧 已修复 · ${fmtYuan(-r.cost)}` : (r?.reason ?? '修复失败'), r?.ok ? 'ok' : 'bad');
          render(); return;
        }
        if (act === 'sh-recycle') {
          const r = secondhandApi.recycle(el.dataset.id);
          toast(r?.ok ? `♻ 已回收 · 退回 ${fmtYuan(r.refund)}` : (r?.reason ?? '回收失败'), r?.ok ? 'ok' : 'bad');
          render(); return;
        }
        return;
      }

      if (current === 'wh') {
        if (act === 'wh-upgrade') {
          const r = warehouseApi.upgrade();
          toast(r?.ok ? `📦 仓库已扩容至 Lv${r.level} · 容量 ${r.cap}` : (r?.reason ?? '扩容失败'), r?.ok ? 'ok' : 'bad');
          render(); return;
        }
        if (act === 'wh-buy') {
          const id = el.dataset.good;
          const row = el.closest('.wh-row');
          const q = Math.max(1, Number(row.querySelector('[data-act="wh-qty"]').value) || 1);
          const r = warehouseApi.buyGood(id, q);
          if (r.ok) toast(`📦 ${WAREHOUSE.goods[id]?.name ?? '货品'} 入库 ×${r.qty} · ${fmtYuan(-r.cost)}`, 'ok');
          else toast(r.reason === '仓库容量已满' ? '仓库容量已满 · 扩容后可继续' : (r.reason ?? '入库失败'), 'bad');
          render(); return;
        }
        if (act === 'wh-plus' || act === 'wh-minus') {
          const row = el.closest('.wh-row');
          const input = row.querySelector('[data-act="wh-qty"]');
          const cur = Number(input.value) || whBatch(el.dataset.good);
          const step = whStep(el.dataset.good);
          input.value = String(Math.max(1, act === 'wh-plus' ? cur + step : cur - step));
          return;
        }
        return;
      }
    };
    if (current === 'buy') recalcBuy();
  }

  render();
}

/**
 * 需求I ③：道具背包（B 键）。
 * 点击卡片 = 选中（再点取消）；右侧按钮 = 购买；选中后在场景按 E 使用。
 * @param items inventory 实例（只有存取，不做效果）
 */
export function openInventory(items, onClose) {
  function render() {
    const list = items.list();
    const rows = list.map((c) => `
      <div class="inv-row ${c.selected ? 'selected' : ''}" data-item="${c.id}">
        <div class="i-emoji">${c.emoji}</div>
        <div>
          <div class="i-name">${c.name}${c.selected ? ' · 已选中' : ''}</div>
          <div class="i-desc">${c.desc}</div>
        </div>
        <div class="i-count">×${c.count}</div>
        <button class="mini-btn" data-act="buy" data-item="${c.id}" ${c.affordable ? '' : 'disabled'}>${fmtYuan(c.price)}</button>
      </div>`).join('');

    els.modal.innerHTML = `
      <div class="modal-mask">
        <div class="modal">
          <h2>🎒 道具背包</h2>
          <div class="sub">现金 ${fmtMoney(state.cash)} · 点击卡片选中（再点取消）· 选中后回到场景按 <b>E</b> 使用</div>
          <div class="inv-list">${rows}</div>
          <div class="actions">
            <button class="btn primary" data-act="close">关闭</button>
          </div>
        </div>
      </div>`;
    modalOpen = true;

    els.modal.onclick = (e) => {
      const btn = e.target.closest('button');
      if (btn?.dataset.act === 'close') { closeModal(); onClose?.(); return; }
      if (btn?.dataset.act === 'buy') {
        const r = items.buy(btn.dataset.item, 1);
        toast(r.ok ? `已购买 ${r.id} ×${r.qty} · ${fmtYuan(-r.cost)}` : (r.reason ?? '购买失败'), r.ok ? 'ok' : 'bad');
        render();
        return;
      }
      const row = e.target.closest('.inv-row');
      if (row) {
        const r = items.select(row.dataset.item);
        if (!r.ok) toast(r.reason, 'bad');
        render();
      }
    };
  }
  render();
}

/* ---------- 前台手机（按 O 打开）· 旧屏风格 ----------
 * 点评 / 跑腿 / 消息 / 情报 / 常客 / 任务 六个分页。数据全部来自传入的 api 对象
 * （phone.mjs 提供前四项，常客忠诚度由 main 从 regulars 注入，
 *   任务板由 main 从 taskboard 注入），
 * HUD 只负责画（ADR-002），不持有任何手机业务状态。
 * 旧屏风格：深色机身 + 绿色荧光 LCD 屏 + 等宽字体，样式在 tokens.css 的 .phone-* 系列。 */
export function openPhone(onClose, api) {
  let tab = 'reviews'; // 'reviews' | 'errand' | 'inbox' | 'intel' | 'loyal' | 'task'
  const REMOJI = { good: '😊', mid: '😐', bad: '😡' };

  /** 差评补救任务横幅：三个分页顶部常驻，玩家一开手机就知道有救口碑的事要做 */
  function remedyBanner() {
    const rm = api.remedy();
    if (!rm) return '';
    const pct = Math.round(rm.ratio * 100);
    return `<div class="phone-remedy">
      <div class="pr-head">🚨 差评补救任务</div>
      <div class="pr-body">再接待 <b>${rm.progress}/${rm.goal}</b> 位顾客 · 完成 +口碑${rm.reward.rep} · ${fmtYuanSigned(rm.reward.cash)}</div>
      <div class="pr-bar"><i style="width:${pct}%"></i></div>
    </div>`;
  }

  function reviewsBody() {
    const list = api.reviews();
    if (!list.length) return '<div class="phone-empty">暂无点评 · 服务好每一位顾客吧</div>';
    return list.map((r) => `
      <div class="phone-item ${r.rating === 'bad' ? 'bad' : ''}">
        <div class="pi-emoji">${REMOJI[r.rating] ?? '😐'}</div>
        <div class="pi-main">
          <div class="pi-text">${r.text}</div>
          <div class="pi-meta">第 ${r.night} 夜 ${fmtClock(r.time)} · ${r.kind === 'lost' ? '失销' : '成交'}</div>
        </div>
      </div>`).join('');
  }

  function errandBody() {
    const e = api.errand();
    const done = api.errandsDone();
    const max = api.errandMax;
    let inner = '';
    if (e) {
      const pct = Math.round((e.left / e.total) * 100);
      inner = `<div class="phone-item active">
        <div class="pi-emoji">${e.emoji ?? '🛵'}</div>
        <div class="pi-main">
          <div class="pi-text">${e.label} · 配送中</div>
          <div class="pi-meta">还剩 ${Math.ceil(e.left)}s · 到账 ${fmtYuan(e.reward)}</div>
          <div class="pr-bar"><i style="width:${pct}%"></i></div>
        </div>
      </div>`;
    }
    inner += `<div class="phone-empty">今晚已接 ${done}/${max} 单</div>`;
    if (!e) {
      inner += `<button class="phone-btn" data-act="errand" ${done >= max ? 'disabled' : ''}>🛵 接一单跑腿</button>`;
      if (done >= max) inner += `<div class="phone-empty">今晚的跑腿单接满了</div>`;
    }
    return inner;
  }

  function inboxBody() {
    const list = api.inbox();
    if (!list.length) return '<div class="phone-empty">消息箱空空如也</div>';
    return list.map((m) => `
      <div class="phone-item ${m.read ? '' : 'unread'}">
        <div class="pi-main">
          <div class="pi-text">${m.text}</div>
          <div class="pi-meta">第 ${m.night} 夜 ${fmtClock(m.time)}</div>
        </div>
        ${m.read ? '' : '<div class="pi-dot"></div>'}
      </div>`).join('');
  }

  /* ---------- 📡 主题情报（代币）：查看明晚 / 锁定明晚 ----------
   * 放手机而不是商店，因为它是"情报"而不是"商品" —— 和已有的现金情报服务同属一类信息。 */
  function intelBody() {
    if (!api.intel) return '<div class="phone-empty">情报服务不可用</div>';
    const it = api.intel();
    const tokens = it.tokens ?? 0;
    const viewed = it.viewed;
    const locked = it.lockedId;
    const cands = it.candidates ?? [];

    // 已查看 → 显示主题名 + 效果；未查看 → 只给"去查看"的按钮（不知道就是不知道）
    const forecast = viewed && it.next
      ? `<div class="phone-item active">
           <div class="pi-emoji">${it.next.emoji}</div>
           <div class="pi-main">
             <div class="pi-text">明晚主题：${it.next.name}</div>
             <div class="pi-meta">${it.next.desc}</div>
           </div>
         </div>`
      : '<div class="phone-empty">尚未查看明晚主题</div>';

    const lockRow = locked
      ? `<div class="phone-item"><div class="pi-emoji">🔒</div>
           <div class="pi-main"><div class="pi-text">已锁定明晚：${it.lockedName ?? locked}</div>
           <div class="pi-meta">开新一夜时强制生效，之后自动解锁</div></div></div>`
      : '';

    // 锁定候选按钮：代币不足时全部置灰
    const lockBtns = cands.map((c) => `
      <button class="phone-btn" data-act="intel-lock" data-id="${c.id}" ${tokens >= it.lockCost ? '' : 'disabled'}>
        ${c.emoji} ${c.name}
      </button>`).join('');

    return `
      <div class="phone-empty">持有代币 🪙 ${tokens} · 查看 🪙 ${it.viewCost} · 锁定 🪙 ${it.lockCost}</div>
      ${forecast}
      ${lockRow}
      ${viewed ? '' : `<button class="phone-btn" data-act="intel-view" ${tokens >= it.viewCost ? '' : 'disabled'}>📡 查看明晚主题（🪙 ${it.viewCost}）</button>`}
      ${viewed ? `<div class="phone-empty">今晚已查看 · 重复查看不再扣费</div>` : ''}
      <div class="phone-empty">锁定明晚（从非节日限定中选，🪙 ${it.lockCost}）：</div>
      ${lockBtns}`;
  }

  function render() {
    const unread = api.unread();
    /** 常客忠诚度分页（2026-10-06 块2）：api.loyal() 由 main 从 regulars 注入。
   *  api 没提供时（老调用方/单测）返回空态而不是崩 —— 面板是附加功能，不该拖垮整页。 */
  function loyalBody() {
    if (typeof api.loyal !== 'function') return '<div class="phone-empty">常客数据暂不可用</div>';
    const list = api.loyal() ?? [];
    if (!list.length) return '<div class="phone-empty">还没有常客 · 多来几晚，熟客会记住你</div>';
    const wom = typeof api.wordOfMouth === 'function' ? api.wordOfMouth() : null;
    const head = wom ? `<div class="phone-remedy">
      <div class="pr-head">${wom.emoji} 口碑：${wom.label}（${wom.value} 分）</div>
      <div class="pr-body">${wom.desc}</div>
    </div>` : '';
    return head + list.map((x) => {
      const sku = SKU_BY_ID[x.prefer];
      const maxIdx = x.maxIndex ?? 4;
      const pct = Math.round((x.level / maxIdx) * 100);
      const disc = x.discount >= 1 ? '' : ` · 偏好商品${Math.round(x.discount * 100)}折`;
      return `<div class="phone-item">
        <div class="pi-emoji">${x.emoji}</div>
        <div class="pi-main">
          <div class="pi-text">${x.name} · ${x.label}</div>
          <div class="pi-meta">偏好 ${sku ? `${sku.emoji} ${sku.name}` : '—'} · 到店 ${x.nights} 夜${disc}</div>
          <div class="pr-bar"><i style="width:${pct}%"></i></div>
        </div>
      </div>`;
    }).join('');
  }

  /** 任务板分页（2026-10-06 块4）：接单/弃单都在这里点。
   *  api.task() 返回 taskboard.panel() 的快照；接/弃走 api.taskAccept / taskAbandon，
   *  完成后由 main 重绘（面板每次 render 都重新读快照，所以不用手动刷）。 */
  function taskBody() {
    if (typeof api.task !== 'function') return '<div class="phone-empty">任务板暂不可用</div>';
    const tb = api.task();
    const offerRow = (c) => `
      <div class="phone-item">
        <div class="pi-emoji">📌</div>
        <div class="pi-main">
          <div class="pi-text">${c.label} <span class="pi-meta-inline">${c.goal}${c.unit}</span></div>
          <div class="pi-meta">${c.hint} · 奖励 ${fmtYuanSigned(c.reward.cash)} + ${c.reward.tokens}代币 · ${c.left}s</div>
        </div>
        <button class="phone-btn" data-task-accept="${c.uid}" ${tb.canAccept ? '' : 'disabled'}>接单</button>
      </div>`;
    const accepted = tb.accepted ? `
      <div class="phone-item" style="border-color:var(--neon-ice)">
        <div class="pi-emoji">🎯</div>
        <div class="pi-main">
          <div class="pi-text">${tb.accepted.label} · ${tb.accepted.progress}/${tb.accepted.goal}${tb.accepted.unit}</div>
          <div class="pr-bar"><i style="width:${Math.round(tb.accepted.ratio * 100)}%"></i></div>
          <div class="pi-meta">奖励 ${fmtYuanSigned(tb.accepted.reward.cash)} + ${tb.accepted.reward.tokens}代币 · 剩 ${tb.accepted.left}s</div>
        </div>
        <button class="phone-btn ghost" data-task-abandon="1">弃单</button>
      </div>` : '';
    const cd = tb.abandonCooldown > 0
      ? `<div class="pi-meta">弃单冷却 ${tb.abandonCooldown}s</div>` : '';
    const list = (tb.offers ?? []).map(offerRow).join('');
    return `
      <div class="phone-remedy">
        <div class="pr-head">📌 任务板</div>
        <div class="pr-body">同时最多接 ${tb.acceptedMax} 单 · 完成后才能接下一单${cd}</div>
      </div>
      ${accepted}
      ${list || '<div class="phone-empty">今晚没有新任务</div>'}
    `;
  }

  const labels = { reviews: '点评', errand: '跑腿', inbox: '消息', intel: '📡 情报', loyal: '常客' };
    const bodies = {
      reviews: reviewsBody(), errand: errandBody(), inbox: inboxBody(), intel: intelBody(),
      loyal: loyalBody(), task: taskBody(),
    };
    const tabsHtml = ['reviews', 'errand', 'inbox', 'intel', 'loyal', 'task'].map((t) => `
      <button class="phone-tab ${tab === t ? 'active' : ''}" data-tab="${t}">
        ${t === 'inbox' && unread > 0 ? `<span class="phone-badge">${unread}</span>` : ''}${labels[t]}
      </button>`).join('');

    els.modal.innerHTML = `
      <div class="modal-mask">
        <div class="phone">
          <div class="phone-status">
            <span class="ps-left">📶 ▮▮▮</span>
            <span class="ps-mid">${fmtClock(state.gameHour)}</span>
            <span class="ps-right">🔋 85%</span>
          </div>
          <div class="phone-screen">
            ${remedyBanner()}
            <div class="phone-tabs">${tabsHtml}</div>
            <div class="phone-body">${bodies[tab]}</div>
          </div>
          <div class="phone-actions">
            ${tab === 'inbox' ? '<button class="phone-btn ghost" data-act="readall">全部已读</button>' : ''}
            <button class="phone-btn" data-act="close">关闭 (O)</button>
          </div>
        </div>
      </div>`;
    modalOpen = true;

    els.modal.onclick = (e) => {
      /* 点遮罩空白处关闭（触屏兜底：某些横屏尺寸下关闭按钮可能被挤出屏幕，
       * 玩家点面板外区域即可退出手机 —— 2026-10-05）。只认 .modal-mask 本体，
       * 面板内部任何点击都走下面的业务分支，不会误关。 */
      if (e.target === e.currentTarget || (e.target && e.target.classList && e.target.classList.contains('modal-mask'))) {
        closeModal(); onClose?.(); return;
      }
      const tabBtn = e.target.closest('[data-tab]');
      if (tabBtn) {
        tab = tabBtn.dataset.tab;
        // 切到"消息"分页才算真正查看 → 那时才消未读红点
        if (tab === 'inbox') api.markAllRead();
        render();
        return;
      }
      /* 任务板（块4）的接/弃按钮走 data-task-*（不用 data-act ——
       * data-act 那一支是 phone.mjs 的既有动作命名空间，混进去会让
       * "这个按钮归谁"变得不清楚）。放最前面：它是两个 if 就够的独立分支。 */
      const taskAccept = e.target.closest('[data-task-accept]');
      if (taskAccept) {
        const r = api.taskAccept(taskAccept.dataset.taskAccept);
        if (!r?.ok) toast(r?.reason ?? '接单失败', 'bad');
        render();
        return;
      }
      if (e.target.closest('[data-task-abandon]')) {
        const r = api.taskAbandon();
        if (!r?.ok) toast(r?.reason ?? '弃单失败', 'bad');
        render();
        return;
      }
      const act = e.target.closest('[data-act]');
      if (!act) return;
      const a = act.dataset.act;
      if (a === 'close') { closeModal(); onClose?.(); return; }
      if (a === 'readall') { api.markAllRead(); render(); return; }
      if (a === 'errand') {
        const r = api.acceptErrand();
        toast(r.ok ? `已接「${r.errand.label}」· ${r.errand.total}s 后到账` : (r.reason ?? '接单失败'), r.ok ? 'ok' : 'bad');
        render();
        return;
      }
      /* 主题情报：toast 由 boonsApi 播报，这里只重绘（否则点了像没反应） */
      if (a === 'intel-view') { api.intelView(); render(); return; }
      if (a === 'intel-lock') { api.intelLock(act.dataset.id); render(); return; }
    };
  }
  render();
}

/* ---------- 监控室（按 M 打开）· 4 路监控小窗蹲小偷 ----------
 * 数据全部来自 monitorApi（monitor.mjs），HUD 只负责把 4 个分区画成监控小窗，
 * 玩家点对应分区的「抓！」即可当场拿下小偷。游戏在面板打开时暂停（与所有 modal 一致），
 * 因此小偷倒计时冻结 —— 给玩家从容辨认红点分区的时间。 */
export function openMonitor(onClose, api) {
  function render() {
    const snap = api.snapshot();
    const tiles = snap.zones.map((z, i) => {
      const isThief = snap.active && snap.thief && snap.thief.zone === i;
      const left = isThief ? Math.max(0, Math.ceil(snap.thief.left)) : 0;
      return `<div class="cam-tile ${isThief ? 'alert' : ''}" data-zone="${i}">
        <div class="cam-head">📷 ${z}</div>
        <div class="cam-view">
          ${isThief
            ? `<div class="cam-thief">⚠️ 小偷！<span class="cam-count">${left}s</span></div>`
            : `<div class="cam-ok">● 正常</div>`}
        </div>
        ${isThief ? `<button class="mini-btn danger" data-act="catch" data-zone="${i}">抓！</button>` : ''}
      </div>`;
    }).join('');

    const status = snap.active
      ? `<div class="mon-status alert">⚠ 监控发现小偷！点击对应分区「抓！」</div>`
      : (snap.pending > 0
        ? `<div class="mon-status">🛰 今夜还有 ${snap.pending} 起可疑动向待观察</div>`
        : `<div class="mon-status ok">🛡 监控中 · 暂无异常</div>`);

    els.modal.innerHTML = `
      <div class="modal-mask">
        <div class="modal mon-modal">
          <h2>📹 监控室</h2>
          <div class="sub">4 路监控小窗蹲守小偷：发现红点分区就点「抓！」当场拿下；漏抓会被盗 ${fmtYuan(MONITOR.stealAmount)}。</div>
          ${status}
          <div class="cam-grid">${tiles}</div>
          <div class="actions"><button class="btn" data-act="close">关闭 (M)</button></div>
        </div>
      </div>`;
    modalOpen = true;
    bind();
  }

  function bind() {
    els.modal.onclick = (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'close') { closeModal(); onClose?.(); return; }
      if (act === 'catch') {
        const r = api.catchThief(Number(btn.dataset.zone));
        if (r.ok) toast(`✅ 抓到小偷！见义勇为奖励 ${fmtYuan(r.reward)}`, 'ok', 3000);
        else toast(
          r.reason === 'wrong-zone' ? '抓错分区了，小偷溜了！'
            : r.reason === 'no-thief' ? '那里没有小偷' : '已经抓过了',
          'bad',
        );
        render();
      }
    };
  }

  render();
}

/* ---------- 需求I ⑥：突发事件横幅 ---------- */
let incidentTimer = null;

/**
 * @param info { emoji, name, desc }
 */
export function showIncident(info, duration = 4200) {
  if (!els.incident) return;
  els.incident.innerHTML =
    `<span class="ic-emoji">${info.emoji ?? '⚠'}</span>`
    + `<span class="ic-name">${info.name ?? '突发事件'}</span>`
    + `<span class="ic-desc">${info.desc ?? ''}</span>`;
  els.incident.style.display = 'flex';
  clearTimeout(incidentTimer);
  incidentTimer = setTimeout(() => {
    if (els.incident) els.incident.style.display = 'none';
  }, duration);
}

/**
 * 打烊结算。
 *
 * 事件类条目（主题加成扣减 / 抉择后果 / 促销费用 / 临期损耗 / 环境外快）**单列一行**：
 * 它们已经真实地改过现金，这里只是把它们从"营业收入"里拆出来单独展示，
 * 绝不二次加减（见 ledger.mjs 文件头）。
 */
export function openSettle(report, onNext, upgradesList, buyUpgradeFn) {
  const line = (label, v, cls = '') =>
    `<div class="line"><span>${label}</span><span class="${cls}">${v}</span></div>`;

  /* ---------- 主题段 ---------- */
  const th = report.theme;
  const themeBlock = th ? `
    <div class="set-sec">
      <div class="sec-head">${th.emoji} 今夜主题：${th.name}</div>
      <div class="sec-sub">${th.desc}</div>
    </div>` : '';

  /* ---------- 事件类账本：每条一行 ---------- */
  const led = Array.isArray(report.ledger) ? report.ledger : [];
  const ledgerBlock = led.length ? `
    <div class="set-sec">
      <div class="sec-head">📋 事件与特殊收支</div>
      ${led.map((e) => line(
        `${e.count > 1 ? `${e.label} ×${e.count}` : e.label}`,
        `${e.value >= 0 ? '+' : ''}${fmtMoney(e.value)}`.replace('+-', '-'),
        e.value >= 0 ? 'pos' : 'neg',
      )).join('')}
    </div>` : '';

  /* ---------- 升星提示 ---------- */
  const st = report.star;
  const starBlock = st ? `
    <div class="set-sec">
      <div class="sec-head">⭐ 店铺星级 ${'★'.repeat(st.level)}${'☆'.repeat(Math.max(0, 5 - st.level))}</div>
      <div class="sec-sub">${
        st.leveled
          ? `🎉 升到 ${st.level} 星！已解锁：${(st.unlocked ?? []).join('、') || '—'}`
          : `连续达标 ${st.streak}/${st.need} 夜（营业额 ≥${fmtYuan(st.targets.revenue)} 且满意度 ≥${st.targets.satisfaction}）`
      }</div>
    </div>` : '';

  /* ---------- 口碑档位 + 忠诚度榜单（2026-10-06 块2） ---------- */
  /* 口碑：原来只有一行"顾客满意度 68"，玩家看不出这个数字会怎么影响客流。
   * 这里补一句档位与"明天客流 ±x%"的因果，让口碑从隐藏数值变成可经营指标。 */
  /* 任务板收入行（块4）：带占比与"是否在 20~30% 区间"的自检提示。
   * 超出区间时明确标出来 —— 平衡问题要能被看见，而不是等玩家自己发现。 */
  const tbRep = report.taskboard;
  const tbBlock = tbRep && tbRep.income > 0 ? `
    <div class="set-sec">
      <div class="sec-head">📌 任务板收入</div>
      ${line('任务现金收入', fmtMoney(tbRep.income), 'pos')}
      ${line('占营收比', `${Math.round(tbRep.ratio * 100)}%${tbRep.inRange ? '' : ` ⚠ 目标 ${Math.round(tbRep.lo * 100)}~${Math.round(tbRep.hi * 100)}%`}`,
        tbRep.inRange ? '' : 'neg')}
    </div>` : '';

  const wom = report.wom;
  const womBlock = wom ? `
    <div class="set-sec">
      <div class="sec-head">${wom.emoji} 口碑：${wom.label}</div>
      <div class="sec-sub">${wom.desc}</div>
    </div>` : '';
  /* 忠诚度榜单：只列出有忠诚度的（level ≥ 1），最多 5 人 —— 全列出来是噪音。 */
  const loy = Array.isArray(report.loyalty) ? report.loyalty.filter((x) => x && x.level >= 1) : [];
  const loyalBlock = loy.length ? `
    <div class="set-sec">
      <div class="sec-head">\u{1F49B} 常客忠诚度</div>
      ${loy.slice(0, 5).map((x) => {
        const sku = SKU_BY_ID[x.prefer];
        const disc = x.discount >= 1 ? '无折扣' : `${Math.round(x.discount * 100)}折`;
        return `<div class="line">
          <span>${x.emoji} ${x.name} \u00b7 偏好 ${sku ? sku.emoji + sku.name : '\u2014'}</span>
          <span>${x.label} ${'\u2764\ufe0f'.repeat(x.level)}${disc === '无折扣' ? '' : ` \u00b7 ${disc}`}</span>
        </div>`;
      }).join('')}
      ${loy.length > 5 ? `<div class="sec-sub">\u2026另有 ${loy.length - 5} 位常客</div>` : ''}
    </div>` : '';

  const ups = `
    <div class="upgrades">
      ${upgradesList.map((u) => {
        const owned = !!state.upgrades[u.id];
        const afford = state.cash >= u.cost;
        return `<div class="upgrade">
          <div><div class="u-name">${u.name}</div><div class="u-eff">${u.eff}</div></div>
          <button data-up="${u.id}" ${owned || !afford ? 'disabled' : ''}>
            ${owned ? '已拥有' : fmtYuan(u.cost)}
          </button>
        </div>`;
      }).join('')}
    </div>`;

  els.modal.innerHTML = `
    <div class="modal-mask">
      <div class="modal">
        <h2>第 ${report.night} 夜 · 结算</h2>
        <div class="sub">营业时间 22:00 → 06:00 结束</div>
        ${themeBlock}
        <div class="report">
          ${line('营业收入', fmtMoney(report.revenue), 'pos')}
          ${line('　其中小费', fmtMoney(report.tips ?? 0), 'pos')}
          ${line('采购成本', `-${fmtMoney(report.purchaseCost)}`, 'neg')}
          ${line('过期损耗', `-${fmtMoney(report.loss)}`, 'neg')}
          ${report.expiring?.loss ? line('　临期货报废', `-${fmtMoney(report.expiring.loss)}`, 'neg') : ''}
          ${line('租金', `-${fmtMoney(report.rent)}`, 'neg')}
          ${report.coffee ? line('咖啡机增益', fmtMoney(report.coffee), 'pos') : ''}
          ${line('本夜净利', fmtMoney(report.netProfit), report.netProfit >= 0 ? 'pos' : 'neg')}
          ${line('服务 / 失销', `${report.served} 人 / ${report.lostSales} 人`)}
          ${line('成交率', `${Math.round(report.rate * 100)}%`)}
          ${line('顾客满意度', String(report.reputation))}
          ${report.wom ? line('口碑影响', `${report.wom.emoji} ${report.wom.label} · 明日客流 \u00d7${report.wom.mul}`) : ''}
          ${line('垃圾遗留', `${report.litter ?? 0} 件`)}
          ${line('突发事件', `${report.incidents ?? 0} 次`)}
          <div class="line"><span>评级</span><span class="stars">${'★'.repeat(report.stars)}${'☆'.repeat(3 - report.stars)}</span></div>
          ${line('期末现金', fmtMoney(report.cashEnd), report.cashEnd >= 0 ? 'pos' : 'neg')}
        </div>
        ${ledgerBlock}
        ${tbBlock}
        ${womBlock}
        ${loyalBlock}
        ${starBlock}
        ${ups}
        <div class="actions">
          <button class="btn primary" data-act="next">开始第 ${report.night + 1} 夜</button>
        </div>
      </div>
    </div>`;
  modalOpen = true;

  els.modal.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.up) {
      const res = buyUpgradeFn?.(btn.dataset.up);
      if (res?.ok) { toast(`已购买：${res.up.name}`, 'ok'); openSettle(report, onNext, upgradesList, buyUpgradeFn); }
      else toast(res?.reason ?? '购买失败', 'bad');
      return;
    }
    if (btn.dataset.act === 'next') {
      closeModal();
      onNext?.();
    }
  });
}

export function openWeekEnd(passed, onRestart) {
  els.modal.innerHTML = `
    <div class="modal-mask">
      <div class="modal">
        <h2>${passed ? '🎉 撑过一周！' : '本周结束'}</h2>
        <div class="sub">${passed
          ? '你成功经营了 7 个夜班，没有破产。'
          : '现金见底，这一周没能撑住（软失败，可重开）。'}</div>
        <div class="report">
          <div class="line"><span>最终现金</span><span class="${state.cash >= 0 ? 'pos' : 'neg'}">${fmtMoney(state.cash)}</span></div>
          <div class="line"><span>顾客满意度</span><span>${Math.round(state.reputation)}</span></div>
        </div>
        <div class="actions">
          <button class="btn primary" data-act="restart">${passed ? '再开一周' : '重开本周'}</button>
        </div>
      </div>
    </div>`;
  modalOpen = true;
  els.modal.querySelector('[data-act="restart"]').addEventListener('click', () => {
    closeModal();
    onRestart?.();
  });
}

/**
 * 账号登录面板（需求B）
 *
 * 交互契约：
 *   - 三个内置账号（1/2/3）以卡位呈现；已设过密码的显示"已激活"
 *   - 选中账号后：未激活 → 标题"设置密码"（含确认密码）；已激活 → "输入密码登录"
 *   - 密码错误就地提示并允许重试，不清空账号选择
 *   - onOk(identity) 仅在鉴权成功时调用
 *
 * @param {object} auth  account.mjs 的 AuthService
 * @param {(identity:object)=>void} onOk
 */
export function openLogin(auth, onOk) {
  els.start.innerHTML = `
    <div class="login-mask">
      <div class="login-card">
        <h2>夜班便利店</h2>
        <div class="lead">选择内测账号 · 首次进入需自行设置密码</div>
        <div class="acc-list" data-el="accList"></div>
        <div class="login-field">
          <label data-el="pwLabel">密码</label>
          <input type="password" data-el="pw" autocomplete="off" maxlength="20" placeholder="请输入密码">
          <div class="hint" data-el="pwHint"></div>
        </div>
        <div class="login-field" data-el="cfmWrap" style="display:none">
          <label>确认密码</label>
          <input type="password" data-el="cfm" autocomplete="off" maxlength="20" placeholder="再输入一次">
        </div>
        <div class="login-err" data-el="err"></div>
        <div class="login-actions">
          <button class="btn primary" data-el="submit">进入</button>
        </div>
        <div class="login-foot">
          <span class="net-off">● 离线单机模式（联机接口已预留）</span>
        </div>
      </div>
    </div>`;

  const q = (n) => els.start.querySelector(`[data-el="${n}"]`);
  const accList = q('accList');
  const pwInput = q('pw');
  const cfmWrap = q('cfmWrap');
  const cfmInput = q('cfm');
  const pwLabel = q('pwLabel');
  const pwHint = q('pwHint');
  const errEl = q('err');
  const submit = q('submit');

  /** 当前选中的账号 id（默认第一个） */
  let selected = auth.listAccounts()[0]?.id ?? '1';

  function isReg(id) {
    return !!auth.listAccounts().find((a) => a.id === id)?.registered;
  }

  function showErr(msg) {
    errEl.textContent = msg ?? '';
    errEl.classList.toggle('show', !!msg);
  }

  function renderAccounts() {
    const list = auth.listAccounts();
    accList.innerHTML = list.map((a) => `
      <div class="acc-item ${a.id === selected ? 'active' : ''}" data-acc="${a.id}">
        <div class="acc-emoji">${a.emoji}</div>
        <div class="acc-id">${a.id}</div>
        <div class="acc-name">${a.name}</div>
        <div class="acc-state ${a.registered ? 'on' : 'off'}">${a.registered ? '已激活' : '待设置'}</div>
      </div>`).join('');
    for (const el of accList.querySelectorAll('[data-acc]')) {
      el.addEventListener('click', () => {
        selected = el.dataset.acc;
        showErr('');
        pwInput.value = '';
        cfmInput.value = '';
        renderAccounts();
        syncMode();
      });
    }
  }

  /** 根据"是否已注册"切换 设置密码 / 登录 两种形态 */
  function syncMode() {
    const reg = isReg(selected);
    pwLabel.textContent = reg ? '密码' : '设置密码（首次进入）';
    pwHint.textContent = PASSWORD_HINT;
    cfmWrap.style.display = reg ? 'none' : 'block';
    submit.textContent = reg ? '登录' : '设置并进入';
    submit.dataset.mode = reg ? 'login' : 'register';
    pwInput.focus();
  }

  function doSubmit() {
    const mode = submit.dataset.mode;
    const pw = pwInput.value;
    const res = mode === 'register'
      ? auth.register(selected, pw)
      : auth.login(selected, pw);

    if (!res.ok) {
      showErr(res.reason ?? '操作失败');
      return;
    }
    if (mode === 'register') {
      if (cfmInput.value !== pw) {
        // 两次不一致：抹掉已写入的凭据，退回设置态
        auth.resetAccount(selected);
        showErr('两次输入的密码不一致，请重新设置');
        renderAccounts();
        syncMode();
        return;
      }
    }
    showErr('');
    els.start.innerHTML = '';
    modalOpen = false;
    onOk?.(res.identity);
  }

  submit.addEventListener('click', doSubmit);
  for (const input of [pwInput, cfmInput]) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doSubmit(); }
    });
    input.addEventListener('input', () => showErr(''));
  }

  renderAccounts();
  syncMode();
  modalOpen = true;
}

/** 与 account.mjs 的规则保持一致（此处只做展示文案） */
const PASSWORD_HINT = '4–20 位，不能包含空格';

/**
 * 本地排行榜面板（需求D）
 * @param {Array<{kind:string,label:string,unit:string,entries:Array}>} boards
 */
export function openLeaderboard(boards, onClose) {
  const sections = boards.map((b) => {
    const rows = b.entries.length
      ? b.entries.map((e, i) => `
        <div class="lb-row">
          <span class="lb-rank ${i === 0 ? 'top' : ''}">${i + 1}</span>
          <span class="lb-name">${e.name}</span>
          <span class="lb-meta">第 ${e.night} 夜</span>
          <span class="lb-val">${e.value}${b.unit}</span>
        </div>`).join('')
      : `<div class="lb-empty">暂无记录 —— 去玩玩看</div>`;
    return `
      <div class="lb-sec">
        <div class="lb-head">${b.emoji} ${b.label} <span class="lb-sub">· ${b.metric}</span></div>
        ${rows}
      </div>`;
  }).join('');

  els.modal.innerHTML = `
    <div class="modal-mask">
      <div class="modal">
        <h2>🏆 本地排行榜</h2>
        <div class="sub">仅记录在本机 · 联机排行榜接口已预留</div>
        <div class="lb-list">${sections}</div>
        <div class="actions">
          <button class="btn primary" data-act="close">关闭</button>
        </div>
      </div>
    </div>`;
  modalOpen = true;
  els.modal.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn?.dataset.act === 'close') { closeModal(); onClose?.(); }
  });
}

/* ============================================================
 *  设置页（Esc 暂停菜单 → ⚙ 设置）
 *
 *  滑杆**完全由 settings.mjs 的 RANGES 生成** —— 面板不认识任何一项的含义，
 *  加一项设置只需要在 settings.mjs 里写一行，UI 自动出现。
 *  拖动即时生效：setSettings 会通知订阅方（后处理 / 音频 / 玩家手感各自 apply），
 *  不需要"确定"按钮，也不需要在关闭时才批量提交。
 * ========================================================== */

/** 把数值渲染成人看的文本（音量显示百分比、角度带单位） */
function fmtSetting(key, v) {
  if (key === 'bgm' || key === 'sfx' || key === 'vignette') return `${Math.round(v * 100)}%`;
  if (key === 'fov') return `${Math.round(v)}°`;
  return v.toFixed(2);
}

/** 数值演示短语：让玩家不靠猜就知道"拖到哪边会怎样" */
function hintFor(key, v) {
  const r = RANGES[key];
  if (!r?.hint) return '';
  const pos = (v - r.min) / (r.max - r.min);
  const tail = pos < 0.34 ? '（偏低）' : pos > 0.66 ? '（偏高）' : '（适中）';
  return `${r.hint}${tail}`;
}

export function openSettings(onClose, resetApi = null, onResetDone = null) {
  if (modalOpen) return;
  const GROUPS = [
    { title: '🔊 音频', keys: ['bgm', 'sfx'] },
    { title: '🖼 画面', keys: ['brightness', 'gamma', 'vignette', 'fov'] },
    { title: '🖱 操作', keys: ['sensitivity'] },
  ];

  function row(key) {
    const r = RANGES[key];
    const v = settings[key];
    return `<div class="set-row">
      <div class="set-head">
        <span class="set-label">${r.label}</span>
        <span class="set-val" data-val="${key}">${fmtSetting(key, v)}</span>
      </div>
      <input type="range" data-set="${key}"
             min="${r.min}" max="${r.max}" step="${r.step}" value="${v}">
      <div class="set-hint" data-hint="${key}">${hintFor(key, v)}</div>
    </div>`;
  }

  const body = GROUPS.map((g) => `
    <div class="set-group">
      <div class="set-group-title">${g.title}</div>
      ${g.keys.map(row).join('')}
    </div>`).join('');

  /* 账号区：重开放在设置里而不是绑热键 ——
   * 不可逆动作不该有一次误触就能触发的入口（点进来还要再过一道密码确认，见 openResetConfirm）。 */
  let accountBlock = '';
  if (resetApi) {
    const st = resetApi.status();
    accountBlock = `
    <div class="set-group danger">
      <div class="set-group-title">⚠ 账号</div>
      <div class="set-row">
        <div class="set-head">
          <span class="set-label">重开（重置进度）</span>
          <span class="set-val">今日剩余 ${st.remainingToday}/${st.maxPerDay}</span>
        </div>
        <div class="set-hint" data-hint="reset">${st.message}</div>
        <button class="btn danger" data-act="open-reset" ${st.allowed ? '' : 'disabled'}>重开本账号…</button>
      </div>
    </div>`;
  }

  els.modal.innerHTML = `
    <div class="modal-mask">
      <div class="modal">
        <h2>⚙ 设置</h2>
        <div class="sub">改动立刻生效并自动保存 · 读档 / 重开都沿用</div>
        <div class="set-list">${body}${accountBlock}</div>
        <div class="actions">
          <button class="btn" data-act="reset">恢复默认</button>
          <button class="btn primary" data-act="close">关闭</button>
        </div>
      </div>
    </div>`;
  modalOpen = true;

  /** 就地更新一项的显示（不重绘整个面板 —— 重绘会把正在拖的滑杆打断） */
  function refresh(key) {
    const val = els.modal.querySelector(`[data-val="${key}"]`);
    if (val) val.textContent = fmtSetting(key, settings[key]);
    const hint = els.modal.querySelector(`[data-hint="${key}"]`);
    if (hint) hint.textContent = hintFor(key, settings[key]);
  }

  els.modal.oninput = (e) => {
    const key = e.target?.dataset?.set;
    if (!key) return;
    setSettings({ [key]: Number(e.target.value) });
    refresh(key);
  };
  els.modal.onclick = (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.act === 'reset') {
      resetSettings();
      for (const key of Object.keys(DEFAULTS)) {
        const input = els.modal.querySelector(`[data-set="${key}"]`);
        if (input) input.value = String(settings[key]);
        refresh(key);
      }
      toast('已恢复默认设置', 'info', 1600);
      return;
    }
    if (btn.dataset.act === 'open-reset') {
      // 直接换成确认弹窗（不调 onClose —— 重开流程走完前不该解除暂停）
      closeModal();
      openResetConfirm(resetApi, onResetDone, onClose);
      return;
    }
    if (btn.dataset.act === 'close') { closeModal(); onClose?.(); }
  };
}

/* ============================================================
 *  重开（重置）二次确认弹窗
 *
 *  不可逆动作的三重刹车：入口在设置里（不是热键）→ 列出会被清掉什么 →
 *  再输一遍确认词 + 当前账号密码。少任何一道，误触的代价都是"玩家一局白玩"。
 *
 *  @param resetApi reset.mjs 的 createResetService 实例
 *  @param onDone   (result) => void  重开成功后（由 main 解除暂停并开新的一夜）
 *  @param onCancel () => void        取消（回到原本的暂停态）
 * ========================================================== */
export function openResetConfirm(resetApi, onDone = null, onCancel = null) {
  if (!resetApi) return;
  const rule = resetApi.rule;

  function render(err = '') {
    const st = resetApi.status();
    const li = (arr, cls) => arr.map((t) => `<li class="${cls}">${t}</li>`).join('');
    els.modal.innerHTML = `
      <div class="modal-mask">
        <div class="modal reset-modal">
          <h2>⚠ 重开本账号</h2>
          <div class="sub">
            进度将清回初始状态，<b>不可撤销</b>。
            账号与密码、玩家设置、其他账号的进度都会保留。
          </div>
          <div class="reset-scope">
            <div class="reset-col">
              <div class="reset-col-title">将被清除</div>
              <ul>${li(RESET_SCOPE.clears, 'del')}</ul>
            </div>
            <div class="reset-col">
              <div class="reset-col-title">会保留</div>
              <ul>${li(RESET_SCOPE.keeps, 'keep')}</ul>
            </div>
          </div>
          <div class="set-row">
            <div class="set-head">
              <span class="set-label">今日剩余次数</span>
              <span class="set-val">${st.remainingToday}/${st.maxPerDay}</span>
            </div>
            <div class="set-hint">每次重开后冷却 ${rule.cooldownSec} 秒</div>
          </div>
          <div class="login-field">
            <label>输入确认词「${rule.confirmPhrase}」</label>
            <input data-el="phrase" type="text" autocomplete="off" placeholder="${rule.confirmPhrase}">
          </div>
          <div class="login-field">
            <label>当前账号密码</label>
            <input data-el="pw" type="password" autocomplete="off" placeholder="验证身份">
          </div>
          <div class="login-err${err ? ' show' : ''}" data-el="err">${err}</div>
          <div class="actions">
            <button class="btn" data-act="cancel">取消</button>
            <button class="btn danger" data-act="confirm" ${st.allowed ? '' : 'disabled'}>确认重开</button>
          </div>
        </div>
      </div>`;
    modalOpen = true;

    els.modal.onclick = (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.act === 'cancel') { closeModal(); onCancel?.(); return; }
      if (btn.dataset.act !== 'confirm') return;

      const phrase = els.modal.querySelector('[data-el="phrase"]')?.value ?? '';
      const password = els.modal.querySelector('[data-el="pw"]')?.value ?? '';
      const res = resetApi.requestReset({ password, phrase });
      if (!res.ok) { render(res.message); return; }
      closeModal();
      onDone?.(res);
    };
  }

  render();
}

/* ============================================================
 *  新手引导字幕条（第 1 夜前 3 分钟的三步引导）
 *
 *  样式上刻意做成"顶部一条字幕"而不是弹窗：引导期间玩家要能继续操作，
 *  任何挡住视野或抢走鼠标的东西都会让教程变成负担。
 * ========================================================== */
let tutKey = '';
export function showTutorial(step, total, text, hint = '') {
  if (!els.tutorial) return;
  // 每帧调用但内容通常不变 —— 脏检查避免每帧重排 DOM（字幕条是全屏居中的，重排代价不低）
  const key = `${step}|${total}|${text}|${hint}`;
  if (key !== tutKey) {
    tutKey = key;
    els.tutorial.innerHTML =
      `<span class="tut-step">引导 ${step}/${total}</span>`
      + `<span class="tut-text">${text}</span>`
      + (hint ? `<span class="tut-hint">${hint}</span>` : '');
  }
  /* 顶部横幅（主题 / 促销）与引导字幕都"顶部居中"，原本一个 64px 一个 54px，
   * 而首夜开夜时两者必定同时在场 —— 横幅 z-index 更高，会把引导字幕整条盖住。
   * 给横幅容器挂 has-tutorial 让它临时下移，两条互不遮挡。 */
  els.tutorial.style.display = '';
  if (bannerEl) bannerEl.classList.add('has-tutorial');
}

export function hideTutorial() {
  if (!els.tutorial) return;
  if (els.tutorial.style.display !== 'none') {
    els.tutorial.style.display = 'none';
    tutKey = '';
  }
  if (bannerEl) bannerEl.classList.remove('has-tutorial');
}

/** 任务完成时让追踪器绿闪一下（需求："完成时绿色打勾一闪"） */
export function flashQuestDone() {
  questDoneUntil = performance.now() + 1100;
}

/* ==================================================================
 * 成长线扩展的三块 UI：成就面板 / 抉择弹窗 / 顶部横幅
 * ================================================================== */

/**
 * 成就面板（Esc 菜单的新页签）。
 * @param api { list: () => [{id,name,emoji,desc,tokens,done,progress}], count: () => {done,total} }
 */
export function openAchievements(api, onClose) {
  function render() {
    const c = api.count();
    const rows = api.list().map((a) => {
      const prog = a.progress
        ? `<div class="a-prog">进度 ${a.progress.cur}/${a.progress.max}</div>`
        : '';
      const badge = a.done
        ? `<span class="a-done">✓ 已达成 · +${a.tokens} 代币</span>`
        : `<span class="a-tok">奖励 ${a.tokens} 代币</span>`;
      return `<div class="ach-row ${a.done ? 'done' : ''}">
        <div class="a-emoji">${a.emoji}</div>
        <div>
          <div class="a-name">${a.name}</div>
          <div class="a-desc">${a.desc}</div>
          ${prog}
        </div>
        <div>${badge}</div>
      </div>`;
    }).join('');
    els.modal.innerHTML = `
      <div class="modal-mask">
        <div class="modal">
          <h2>🏆 成就 <span class="a-count">${c.done}/${c.total}</span></h2>
          <div class="sub">完成后奖励代币（代币不影响经济平衡，只用于排行与兑换）</div>
          <div class="ach-list">${rows}</div>
          <div class="actions">
            <button class="btn primary" data-act="close">关闭</button>
          </div>
        </div>
      </div>`;
    modalOpen = true;
    els.modal.onclick = (e) => {
      if (e.target.closest('[data-act="close"]')) { closeModal(); onClose?.(); }
    };
  }
  render();
}

/**
 * 抉择事件弹窗（暂停级：弹出期间夜时钟停住，选完恢复）。
 * @param choice CHOICES 的一项
 * @param onPick (optionId) => void
 */
export function openChoice(choice, onPick) {
  els.modal.innerHTML = `
    <div class="modal-mask">
      <div class="modal choice">
        <h2>${choice.emoji} ${choice.title}</h2>
        <div class="choice-body">${choice.body}</div>
        <div class="choice-opts">
          ${choice.options.map((o) => `
            <button class="choice-opt" data-opt="${o.id}">
              <div class="c-label">${o.label}</div>
              <div class="c-hint">${o.hint}</div>
            </button>`).join('')}
        </div>
        <div class="sub">选择后立刻生效 · 今夜不会再遇到它</div>
      </div>
    </div>`;
  modalOpen = true;
  els.modal.onclick = (e) => {
    const b = e.target.closest('[data-opt]');
    if (!b) return;
    closeModal();
    onPick?.(b.dataset.opt);
  };
}

/* ---------- 顶部横幅（主题 / 促销） ----------
 * 两个横幅共用一个容器，主题在上、促销在下。
 * 用独立的 fixed 层而不是 els.incident：那一条是"短暂事件提示"，
 * 会几秒后自动消失；主题与促销需要**常驻**，语义不同不该复用。 */
let bannerEl = null;
function ensureBanner() {
  if (bannerEl) return bannerEl;
  bannerEl = document.createElement('div');
  bannerEl.style.cssText = `position:fixed;left:50%;top:64px;transform:translateX(-50%);z-index:36;
    display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;`;
  document.body.appendChild(bannerEl);
  return bannerEl;
}
function setBanner(key, html) {
  const el = ensureBanner();
  let n = el.querySelector(`[data-banner="${key}"]`);
  if (!html) { n?.remove(); return; }
  if (!n) {
    n = document.createElement('div');
    n.dataset.banner = key;
    el.appendChild(n);
  }
  n.innerHTML = html;
}

/** 今夜主题横幅（每晚首次开店宣布） */
export function showThemeBanner(theme) {
  if (!theme) { setBanner('theme', ''); return; }
  setBanner('theme', `<div class="theme-banner">${theme.emoji} 今夜主题 · <b>${theme.name}</b>
    <span class="tb-desc">${theme.desc}</span></div>`);
}

/** 限时促销横幅（醒目） */
export function showPromoBanner(active, remaining = 0) {
  if (!active) { setBanner('promo', ''); return; }
  setBanner('promo', `<div class="promo-banner">🏷 全店 9 折 · 限时促销中
    <b>${Math.ceil(remaining)}s</b></div>`);
}

/** 满意度临时加成角标（撸猫 / 报警之后） */
export function setSatBonus(n) {
  const el = els.rep;
  if (!el) return;
  let chip = el.parentElement?.querySelector('.sat-bonus');
  if (!n) { chip?.remove(); return; }
  if (!chip) {
    chip = document.createElement('span');
    chip.className = 'sat-bonus';
    el.parentElement?.appendChild(chip);
  }
  chip.textContent = `+${n}`;
}

export function closeAll() {
  closeModal();
  setBanner('theme', '');
  setBanner('promo', '');
  els.start.innerHTML = '';
  hideTutorial();
  if (els.incident) els.incident.style.display = 'none';
  for (const t of toastTimers) clearTimeout(t);
  toastTimers = [];
  toastQueue.length = 0;
  toastLive.length = 0;
  if (els.toasts) els.toasts.innerHTML = '';
}
