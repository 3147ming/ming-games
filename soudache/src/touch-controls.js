/**
 * 触屏控制：左半屏虚拟摇杆移动 + 右半屏「直接滑动」转视角 + 分级动作按钮。
 *
 * 设计目标：
 * - 仅手机端启用，写入与桌面键鼠**完全相同**的 input 状态（up/down/left/right/fire/ads/yaw/pitch…），
 *   不改动任何游戏逻辑 —— 桌面端原操作完全不受影响。
 * - 支持多点触控：左手移动、右手转视角、拇指按开火可同时发生。
 * - 仅在「战斗中且无面板打开」时激活（setActive），避免吞掉面板滚动/点击。
 *
 * 布局（玩家两次反馈后改版）：
 * - **右侧不画任何摇杆/轮盘**（玩家原话："不要用轮盘滑动，就是滑动屏幕"）：
 *   手指落在右半屏哪里就在哪里开始转视角，屏幕上不出现底盘和摇杆头。
 * - 左侧保留可见摇杆（手游惯例，且需要方向反馈），左半屏任意处按下也能拖动。
 * - 按钮全部贴边、收敛到屏幕边缘小区域，中心视野不留控件。
 * - 三级尺寸：core（摇杆 / 开火）> combat（换弹 / 治疗）> minor（其余）。
 * - 用 CSS 变量 + flex 排布保证**永不自相重叠**；开火键脱离簇文档流，
 *   由 CSS 变量统一预留位置，避免再出现「切枪按钮被开火键完全盖住」。
 * - 交互键（搜刮 / 撤离 / 拾取…）为**上下文感知**：平时隐藏，
 *   只在玩家靠近可交互目标时弹出，离开或完成后自动消失。
 *
 * 右半屏为「相对拖拽」式（像触摸板）：手指位移直接换算成 yaw/pitch 增量，
 * 每一帧的增量只按当帧位移计算（不累计到落指点），所以快速滑动不会瞬移。
 * 左摇杆固定在左下角（手游惯例），同时左半屏任意处按下也能拖动。
 */

import { VIEW3D } from './config.js';

/**
 * 右半屏基础灵敏度（弧度 / 像素），再乘 save.settings.touchLookSens。
 * 玩家反馈"太快了"后从 0.0092 降到 0.0042（约 1/2.2），
 * 配合新增的 0.5 档，最慢档约等于原来的 1/4.4。
 */
const LOOK_BASE = 0.0042;
const LOOK_PRESETS = [0.5, 0.75, 1.0, 1.4];
const DEADZONE = 0.18; // 移动摇杆死区（归一化半径比例）

/**
 * 动作按钮表。size 决定 CSS 尺寸档（core / combat / minor）；
 * hold=true 表示按住持续生效（开火）；toggle 表示点击切换状态类输入。
 */
const BUTTONS = [
  // 右下火力区（按重要性由大到小，从拇指最近的右下角向外排）
  { a: 'fire', t: '开火', size: 'core', hold: true, fire: true },
  { a: 'reload', t: '换弹', size: 'combat' },
  { a: 'heal', t: '治疗', size: 'combat' },
  { a: 'ads', t: '瞄准', size: 'minor', toggle: 'ads' },
  { a: 'switch', t: '切枪', size: 'minor' },
  // 蹲伏：桌面上有 Ctrl，手机上以前**完全没有入口** —— 于是"蹲行更安静、更难被发现"
  // 这条核心潜行机制对手机玩家是不存在的。放在火力区（右拇指），和瞄准同一档，
  // 因为它和瞄准是同一类动作：临场姿态切换。
  { a: 'crouch', t: '蹲伏', size: 'minor', toggle: 'crouch' },
  // 贴顶部边缘的系统钮：背包 / 任务 / 暂停（远离两个拇指作业区）
  // 灵敏度**不放这里**：玩家反馈"暂停后调不了灵敏度"，所以改到暂停面板里用滑块调。
  { a: 'bag', t: '背包', size: 'minor', slot: 'top' },
  // 任务面板：桌面上是 J 键，手机以前没有入口 —— 合约进度只能靠"折叠标题里的 3/2"猜。
  { a: 'tasks', t: '任务', size: 'minor', slot: 'top' },
  { a: 'pause', t: '暂停', size: 'minor', slot: 'top' },
];

/** 上下文交互键：只有靠近可交互目标时由 main.js 调 setContext() 弹出。 */
const CONTEXT_DEF = { a: 'interact', t: '搜索', size: 'combat' };

/**
 * 创建一个触屏控制实例。
 * @param {object} opts
 * @param {object} opts.input  与桌面共用的输入状态对象
 * @param {HTMLElement} [opts.root] 挂载根（默认 document.body）
 * @param {function} [opts.onAction] 需要世界上下文的动作回调 (action, value?) => void
 * @returns {object} 控制句柄
 */
export function createTouchControls(opts) {
  const input = opts.input;
  const root = opts.root || (typeof document !== 'undefined' ? document.body : null);
  const onAction = opts.onAction || (() => {});

  const el = document.createElement('div');
  el.className = 'touch-controls hidden';
  el.setAttribute('aria-hidden', 'true');

  // ---- 摇杆 ----
  // 左：可见摇杆（固定左下，玩家需要方向反馈）
  // 右：**不创建任何可见摇杆**（玩家要求"不要轮盘，直接滑屏幕"），仅在逻辑上跟踪手指
  function makeStick(side, visible) {
    const wrap = document.createElement('div');
    wrap.className = `tc-stick tc-stick-${side}`;
    const base = document.createElement('div');
    base.className = 'tc-stick-base';
    const knob = document.createElement('div');
    knob.className = 'tc-stick-knob';
    base.appendChild(knob);
    wrap.appendChild(base);
    el.appendChild(wrap);
    if (!visible) {
      // 视觉层彻底移除：既不占位也不参与命中
      wrap.classList.add('tc-invisible');
    }
    return { wrap, base, knob, cx: 0, cy: 0, visible: !!visible };
  }
  const left = makeStick('left', true);
  const right = makeStick('right', false);

  // ---- 按钮 ----
  const btnEls = new Map();
  const zoneR = document.createElement('div');
  zoneR.className = 'tc-zone tc-zone-fire';
  const zoneL = document.createElement('div');
  zoneL.className = 'tc-zone tc-zone-move';
  const zoneTop = document.createElement('div');
  zoneTop.className = 'tc-zone tc-zone-top';

  for (const def of BUTTONS) {
    const b = document.createElement('button');
    b.className = `tc-btn tc-btn-${def.size} tc-slot-${def.slot || 'z'}`;
    if (def.fire) b.classList.add('tc-fire');
    b.type = 'button';
    b.dataset.action = def.a;
    b.setAttribute('aria-label', def.t);
    const label = document.createElement('span');
    label.className = 'tc-label';
    label.textContent = def.t;
    b.appendChild(label);
    btnEls.set(def.a, b);
    b.addEventListener('pointerdown', onBtnPointerDown);
    (def.slot === 'top' ? zoneTop : def.fire ? zoneL : (['reload', 'heal', 'ads', 'crouch'].includes(def.a) ? zoneR : zoneL)).appendChild(b);
  }
  // 开火键必须是「右下火力区」的主键，而不是左下机动区
  zoneR.appendChild(btnEls.get('fire'));

  // 上下文交互键（默认隐藏）
  const ctxBtn = document.createElement('button');
  ctxBtn.className = `tc-btn tc-btn-${CONTEXT_DEF.size} tc-ctx hidden`;
  ctxBtn.type = 'button';
  ctxBtn.dataset.action = CONTEXT_DEF.a;
  ctxBtn.setAttribute('aria-label', CONTEXT_DEF.t);
  const ctxLabel = document.createElement('span');
  ctxLabel.className = 'tc-label';
  ctxLabel.textContent = CONTEXT_DEF.t;
  ctxBtn.appendChild(ctxLabel);
  btnEls.set(CONTEXT_DEF.a, ctxBtn);
  zoneR.appendChild(ctxBtn);

  el.appendChild(zoneR);
  el.appendChild(zoneL);
  el.appendChild(zoneTop);

  // 右半屏滑动提示：玩家要求"没有轮盘"，那就明确告诉他这里能滑。
  // 只在首次按下右半屏之前显示，用完即隐藏（不长期占屏）。
  const hint = document.createElement('div');
  hint.className = 'tc-look-hint';
  hint.innerHTML = '<span>此侧滑动<br>转动视角</span>';
  el.appendChild(hint);

  if (root) root.appendChild(el);

  const lookBtn = btnEls.get('look');
  const lookLabel = lookBtn ? lookBtn.querySelector('.tc-label') : null;

  // ---- 状态 ----
  let active = false;
  let leftId = null;
  let rightId = null;
  const buttonIds = new Map(); // touch identifier -> action
  // 面板触摸映射：identifier -> 面板根节点。落在面板内的触摸不接管为摇杆、
  // 也不 preventDefault，交给浏览器原生滚动（列表 / 滑块）。
  const panelTouch = new Map();
  // 面板容器选择器：覆盖战前配置/暂停/商店/仓库/背包/战利品/结算等所有面板。
  // 注意：战利品与背包是战斗内浮层，用 .battle-panel；其余 UI 屏用 .panel。
  const PANEL_SEL = '.panel, .modal, .battle-panel, [data-scroll]';
  // 是否有「面板式 UI」当前可见（非 3D 战斗界面）：
  // 任一 .screen（非 battle）/ 任意 .battle-panel（战利品/背包）处于显示态。
  function panelUIActive() {
    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc || !doc.querySelector) return false; // 非浏览器环境（测试桩）直接视为无面板
    const scr = doc.querySelector('.screen:not(.hidden)[data-screen]');
    if (scr && scr.dataset.screen && scr.dataset.screen !== 'battle') return true;
    if (doc.querySelector('.battle-panel:not(.hidden)')) return true;
    return false;
  }
  const lookSens = () => LOOK_BASE * (input.touchLookSens || 1);
  let lookPresetIdx = Math.max(0, LOOK_PRESETS.indexOf(input.touchLookSens || 1));
  let ctxShown = false;

  // ---- 左摇杆推满自动冲刺（B：移除独立冲刺键后替代）----
  // 归一化幅值（与 handleMoveAxis 同口径，1 = 推到底）：>SPRINT_ON 持续 SPRINT_HOLD 触发，
  // 回落 <SPRINT_OFF 停止（滞回阈值，避免临界抖动反复触发/取消）。
  const SPRINT_ON = 0.92;
  const SPRINT_OFF = 0.80;
  const SPRINT_HOLD = 250; // ms
  let leftMag = 0;          // 当前左摇杆归一化幅值 [0,1]
  let sprintPushStart = 0;  // 首次超过阈值的时刻（now()），0 = 未推满
  let sprintRaf = 0;
  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  function clearSprintTimer() {
    if (sprintRaf) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(sprintRaf);
      sprintRaf = 0;
    }
  }
  // 用 rAF 按真实时间推进：即使手指"按死不动"（不再产生 touchmove）也能累计满 0.25s 触发冲刺。
  function sprintTick() {
    sprintRaf = 0;
    if (!active || leftId === null) { sprintPushStart = 0; return; }
    if (sprintPushStart > 0 && now() - sprintPushStart >= SPRINT_HOLD) input.sprint = true;
    if (active && leftId !== null && typeof requestAnimationFrame === 'function') {
      sprintRaf = requestAnimationFrame(sprintTick);
    }
  }
  function evaluateSprint() {
    if (leftMag > SPRINT_ON) {
      if (!sprintPushStart) sprintPushStart = now();
      if (typeof requestAnimationFrame === 'function' && !sprintRaf) sprintRaf = requestAnimationFrame(sprintTick);
    } else if (leftMag < SPRINT_OFF) {
      if (input.sprint) input.sprint = false;
      sprintPushStart = 0;
      clearSprintTimer();
    }
  }
  function stopSprint() {
    if (input.sprint) input.sprint = false;
    sprintPushStart = 0;
    leftMag = 0;
    clearSprintTimer();
  }

  function updateLookLabel() {
    if (lookLabel) lookLabel.textContent = `灵敏${LOOK_PRESETS[lookPresetIdx].toFixed(1)}`;
  }
  updateLookLabel();

  /** 右半屏滑动提示：首次用掉右半屏后永久隐藏（本次会话不再打扰） */
  function hideLookHint() {
    if (hint.classList.contains('tc-hint-off')) return;
    hint.classList.add('tc-hint-off');
  }

  function resetMove() {
    input.up = input.down = input.left = input.right = false;
    left.knob.style.transform = 'translate(-50%, -50%)';
  }

  // ---- 触摸处理 ----
  function onTouchStart(ev) {
    if (!active || editing) return; // 编辑布局时屏蔽游戏输入，只走拖拽
    // 面板式 UI 激活时（暂停/商店/仓库/战前配置/结算/战利品/背包），
    // 触摸只响应面板本身（点按 + 原生滚动），整体禁用局内摇杆与视角。
    const panelMode = panelUIActive();
    let panelInvolved = false;
    for (const touch of ev.changedTouches) {
      const tgt = touch.target;
      const panelRoot = tgt && tgt.closest ? tgt.closest(PANEL_SEL) : null;
      // 面板内（或面板激活态下的任意触摸）：不接管摇杆、不拦截默认行为，
      // 交还浏览器原生处理（列表滚动 / 滑块拖动 / 按钮点击）。
      if (panelRoot || panelMode) {
        if (panelRoot) panelTouch.set(touch.identifier, panelRoot);
        panelInvolved = true;
        continue;
      }
      const targetBtn = tgt && tgt.closest ? tgt.closest('.tc-btn') : null;
      if (targetBtn) {
        // 隐藏的上下文键不接收触摸
        if (targetBtn.classList.contains('hidden')) continue;
        const action = targetBtn.dataset.action;
        buttonIds.set(touch.identifier, action);
        onPress(action, targetBtn);
        continue;
      }
      // 非按钮区域：按左右半屏分配摇杆（浮动起点，落在哪就以哪为圆心）
      const x = touch.clientX;
      const half = (window.innerWidth || 0) / 2;
      if (x < half) {
        if (leftId === null) {
          leftId = touch.identifier;
          left.cx = x; left.cy = touch.clientY;
          if (left.visible) {
            left.base.style.left = `${x}px`;
            left.base.style.top = `${touch.clientY}px`;
            left.base.classList.add('tc-live');
          }
          handleMoveAxis(left, x, touch.clientY, x, touch.clientY);
        }
      } else if (rightId === null) {
        // 右侧：只记落指点，不画任何摇杆。prevX/prevY 记录上一帧位置，
        // 每帧只用「本帧位移」算增量 → 快速滑动不会因为累计位移而瞬移。
        rightId = touch.identifier;
        right.cx = touch.clientX; right.cy = touch.clientY;
        right.px = touch.clientX; right.py = touch.clientY;
        hideLookHint();
      }
    }
    // 仅当本次触摸完全没有落在面板上时才 preventDefault（阻止页面滚动 / 双击缩放），
    // 否则单指滚面板、另一指按摇杆时会被连带拦截，导致面板无法原生滚动。
    // 面板内的原生滚动 / 滑块仍由浏览器处理，不阻断其他监听器。
    if (!panelInvolved && ev.cancelable) ev.preventDefault();
  }

  function onTouchMove(ev) {
    if (!active) return;
    // 面板激活态下整体禁用摇杆 / 视角（触摸只响应面板）。
    const panelMode = panelUIActive();
    let panelInvolved = false;
    for (const touch of ev.changedTouches) {
      // 面板内触摸：交还浏览器原生滚动，不驱动摇杆、不拦截默认行为。
      if (panelTouch.has(touch.identifier) || panelMode) {
        panelInvolved = true;
        continue;
      }
      if (buttonIds.has(touch.identifier)) continue; // 按钮不驱动摇杆
      if (touch.identifier === leftId) {
        // 用落指瞬间的中心（已存进 left.cx/cy），不读 getBoundingClientRect，
        // 避免「base 相对定位容器」带来的偏移 —— 真机上摇杆会「飘」。
        handleMoveAxis(left, left.cx, left.cy, touch.clientX, touch.clientY);
      } else if (touch.identifier === rightId) {
        // 只用「上一帧 → 本帧」的位移算增量。
        // 这样无论滑多快、一次 touchmove 跨多远，视角变化都跟手指实际位移 1:1 对应，
        // 不会因为拿「落指点」当基准而累积出更大的转角（那是"滑动太快像瞬移"的根因）。
        const dx = touch.clientX - right.px;
        const dy = touch.clientY - right.py;
        right.px = touch.clientX;
        right.py = touch.clientY;
        const s = lookSens();
        input.yaw -= dx * s;
        input.pitch = clampPitch(input.pitch - dy * s);
      }
    }
    // 仅当本次触摸完全归摇杆管辖时才 preventDefault，面板内触摸放行原生滚动。
    if (!panelInvolved && ev.cancelable) ev.preventDefault();
  }

  function onTouchEnd(ev) {
    for (const touch of ev.changedTouches) {
      // 始终清理面板触摸映射，避免面板关闭后残留的 identifier
      // 与后续新触摸复用同一编号，误把摇杆触摸当成面板触摸而放行。
      panelTouch.delete(touch.identifier);
      if (!active) continue;
      const action = buttonIds.get(touch.identifier);
      if (action) {
        buttonIds.delete(touch.identifier);
        onRelease(action);
        continue;
      }
      if (touch.identifier === leftId) {
        leftId = null;
        left.base.classList.remove('tc-live');
        stopSprint();
        resetMove();
      } else if (touch.identifier === rightId) {
        rightId = null;
      }
    }
  }

  function handleMoveAxis(stick, cx, cy, tx, ty) {
    const R = (stick.base.getBoundingClientRect().width || 118) / 2;
    let dx = tx - cx;
    let dy = ty - cy;
    const len = Math.hypot(dx, dy);
    const k = len > R ? R / len : 1;
    dx *= k; dy *= k;
    stick.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    const nx = dx / R;
    const ny = dy / R;
    // 归一化方向：斜向 45° 也能得到 1 的速度（按分量判定会比"八向"更跟手，也更接近摇杆手感）
    input.up = ny < -DEADZONE;
    input.down = ny > DEADZONE;
    input.left = nx < -DEADZONE;
    input.right = nx > DEADZONE;
    // 左摇杆：记录归一化幅值并据此评估自动冲刺（推满持续 0.25s → 冲刺）
    if (stick === left) {
      leftMag = Math.min(1, Math.hypot(nx, ny));
      evaluateSprint();
    }
  }

  function clampPitch(p) {
    const lim = VIEW3D.pitchLimit;
    if (p > lim) return lim;
    if (p < -lim) return -lim;
    return p;
  }

  function onPress(action, btnEl) {
    switch (action) {
      case 'fire':
        input.fire = true;
        input.firePressed = true;
        if (btnEl) btnEl.classList.add('tc-pressed');
        break;
      case 'ads':
        input.ads = !input.ads;
        if (btnEl) btnEl.classList.toggle('tc-on', input.ads);
        break;
      case 'crouch':
        input.crouch = !input.crouch;
        if (btnEl) btnEl.classList.toggle('tc-on', input.crouch);
        break;
      case 'sprint':
        input.sprint = !input.sprint;
        if (btnEl) btnEl.classList.toggle('tc-on', input.sprint);
        break;
      case 'reload':
      case 'interact':
      case 'heal':
      case 'rope':
      case 'vehicle':
      case 'tasks':
      case 'bag':
      case 'pause':
      case 'switch':
        onAction(action);
        if (btnEl) pulse(btnEl);
        break;
      case 'look':
        cycleLookSens();
        break;
      default:
        break;
    }
  }

  /** 瞬时反馈：非切换类按钮给一个短促的高亮，让玩家确知"这一下点到了" */
  function pulse(btnEl) {
    btnEl.classList.add('tc-tapped');
    setTimeout(() => btnEl.classList.remove('tc-tapped'), 140);
  }

  function onRelease(action) {
    if (action === 'fire') {
      input.fire = false;
      const b = btnEls.get('fire');
      if (b) b.classList.remove('tc-pressed');
    }
  }

  function cycleLookSens() {
    lookPresetIdx = (lookPresetIdx + 1) % LOOK_PRESETS.length;
    const v = LOOK_PRESETS[lookPresetIdx];
    input.touchLookSens = v;
    updateLookLabel();
    onAction('touchLook', v);
  }

  window.addEventListener('touchstart', onTouchStart, { passive: false });
  window.addEventListener('touchmove', onTouchMove, { passive: false });
  window.addEventListener('touchend', onTouchEnd);
  window.addEventListener('touchcancel', onTouchEnd);

  function setActive(v) {
    if (active === v) return;
    active = v;
    el.classList.toggle('hidden', !v);
    el.setAttribute('aria-hidden', v ? 'false' : 'true');
    if (!v) {
      // 退出时清空所有输入，避免松手后角色仍在走 / 仍在开火
      resetMove();
      input.fire = false;
      input.ads = false;
      input.crouch = false;
      input.sprint = false;
      stopSprint();
      buttonIds.clear();
      panelTouch.clear();
      leftId = null; rightId = null;
      left.base.classList.remove('tc-live');
      setContext(null);
    }
  }

  /**
   * 上下文交互键：靠近可交互目标时传入文案与可用性，否则传 null 隐藏。
   * @param {?{text: string, enabled?: boolean}} ctx
   */
  function setContext(ctx) {
    if (!ctx) {
      if (ctxShown) {
        ctxBtn.classList.add('hidden');
        ctxShown = false;
        // 正在按住交互键时目标消失：补一次松手，避免 input 卡住
        for (const [id, a] of [...buttonIds]) if (a === 'interact') buttonIds.delete(id);
      }
      return;
    }
    ctxLabel.textContent = ctx.text || CONTEXT_DEF.t;
    ctxBtn.classList.toggle('tc-disabled', ctx.enabled === false);
    if (!ctxShown) {
      ctxBtn.classList.remove('hidden');
      ctxShown = true;
    }
  }

  /* ---------------- 按钮尺寸 / 布局自定义（位置 / 大小可调）---------------- */

  // 按钮尺寸倍率：写入容器级 CSS 变量，所有按钮 width/height 都用 calc 乘它
  function setButtonScale(v) {
    const s = Math.max(0.8, Math.min(1.3, Number(v) || 1));
    el.style.setProperty('--tc-scale', String(s));
    input.touchButtonScale = s;
  }

  // 应用存档布局：把每个有偏移的按钮钉到绝对坐标（位置可调）
  function applyLayout(layout) {
    for (const [action, pos] of Object.entries(layout || {})) {
      const b = btnEls.get(action);
      if (!b || !pos) continue;
      b.style.position = 'absolute';
      b.style.left = `${pos.x}px`;
      b.style.top = `${pos.y}px`;
      b.dataset.custom = '1';
    }
  }

  // 拖拽编辑：编辑态下 pointerdown 在按钮上开始拖动
  let editing = false;
  let dragEl = null;
  let dragOX = 0;
  let dragOY = 0;
  let editBar = null;

  function onBtnPointerDown(ev) {
    if (!editing) return;
    const b = ev.currentTarget;
    dragEl = b;
    const r = b.getBoundingClientRect();
    dragOX = ev.clientX - r.left;
    dragOY = ev.clientY - r.top;
    if (b.setPointerCapture) { try { b.setPointerCapture(ev.pointerId); } catch { /* 部分浏览器不支持 */ } }
    ev.preventDefault();
  }
  function onDocPointerMove(ev) {
    if (!dragEl) return;
    const er = el.getBoundingClientRect();
    let x = ev.clientX - er.left - dragOX;
    let y = ev.clientY - er.top - dragOY;
    x = Math.max(0, Math.min(er.width - dragEl.offsetWidth, x));
    y = Math.max(0, Math.min(er.height - dragEl.offsetHeight, y));
    dragEl.style.left = `${x}px`;
    dragEl.style.top = `${y}px`;
  }
  function onDocPointerUp() { dragEl = null; }

  function makeEditBar() {
    const bar = document.createElement('div');
    bar.className = 'tc-edit-bar hidden';
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'btn small primary';
    done.textContent = '完成编辑';
    done.addEventListener('click', () => endEditLayout());
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'btn small';
    reset.textContent = '重置布局';
    reset.addEventListener('click', () => {
      resetLayout();
      if (onAction) onAction('reset-layout');
    });
    bar.appendChild(done);
    bar.appendChild(reset);
    el.appendChild(bar);
    return bar;
  }

  function beginEditLayout() {
    if (editing) return true;
    editing = true;
    el.classList.add('tc-editing');
    // 把每个按钮钉到当前屏幕坐标（绝对定位），随后可拖动
    for (const [, b] of btnEls) {
      const r = b.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      b.style.position = 'absolute';
      b.style.left = `${r.left - er.left}px`;
      b.style.top = `${r.top - er.top}px`;
      b.classList.add('tc-dragging');
    }
    if (!editBar) editBar = makeEditBar();
    editBar.classList.remove('hidden');
    return true;
  }

  function endEditLayout() {
    if (!editing) return false;
    editing = false;
    el.classList.remove('tc-editing');
    // 收尾：把当前绝对坐标写回布局并持久化
    const layout = {};
    for (const [action, b] of btnEls) {
      b.classList.remove('tc-dragging');
      if (b.style.position === 'absolute') {
        layout[action] = { x: parseFloat(b.style.left) || 0, y: parseFloat(b.style.top) || 0 };
      }
    }
    if (onAction) onAction('set-layout', layout);
    if (editBar) editBar.classList.add('hidden');
    return false;
  }

  function toggleEditLayout() {
    return editing ? endEditLayout() : beginEditLayout();
  }

  function resetLayout() {
    for (const [, b] of btnEls) {
      b.style.position = '';
      b.style.left = '';
      b.style.top = '';
      b.classList.remove('tc-dragging');
      delete b.dataset.custom;
    }
    if (onAction) onAction('set-layout', {});
  }

  window.addEventListener('pointermove', onDocPointerMove);
  window.addEventListener('pointerup', onDocPointerUp);
  window.addEventListener('pointercancel', onDocPointerUp);

  function destroy() {
    window.removeEventListener('touchstart', onTouchStart);
    window.removeEventListener('touchmove', onTouchMove);
    window.removeEventListener('touchend', onTouchEnd);
    window.removeEventListener('touchcancel', onTouchEnd);
    if (el.parentNode) el.parentNode.removeChild(el);
  }

  return {
    setActive,
    show: () => setActive(true),
    hide: () => setActive(false),
    isActive: () => active,
    setContext,
    setLookSens: (v) => {
      // 先夹到合法区间（暂停面板滑块已夹过，但外部调用不能假设）
      const lo = Math.min(...LOOK_PRESETS);
      const hi = Math.max(...LOOK_PRESETS);
      const n = Math.max(lo, Math.min(hi, Number(v) || 1));
      input.touchLookSens = n;
      // 落到最近的预设档（用于顶部按钮标签回显）；非预设值也接受，只是不对齐档位
      let idx = LOOK_PRESETS.indexOf(n);
      if (idx < 0) {
        let best = 0;
        let bestD = Infinity;
        LOOK_PRESETS.forEach((p, i) => {
          const d = Math.abs(p - n);
          if (d < bestD) { bestD = d; best = i; }
        });
        idx = best;
      }
      lookPresetIdx = idx;
      updateLookLabel();
    },
    getLookSens: () => input.touchLookSens || 1,
    getLookSensPresets: () => LOOK_PRESETS.slice(),
    cycleLookSens,
    // 按钮尺寸 / 布局自定义（位置 / 大小可调）
    setButtonScale,
    applyLayout,
    toggleEditLayout,
    resetLayout,
    destroy,
  };
}
