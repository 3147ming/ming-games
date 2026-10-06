/**
 * 移动端控制层（双端适配 · 阶段：模拟经营手机可用）
 *
 * 只在「主输入为触屏」的设备上挂载（matchMedia('(pointer: coarse)') / ontouchstart /
 * maxTouchPoints）。桌面端（鼠标 + 键盘）完全不挂载、零侵入。
 *
 * 提供的能力：
 *   · 左下虚拟摇杆  → player.setTouchMove(x, z)        （替代 WASD）
 *   · 画布拖拽      → player.addLook(dx, dy)          （替代鼠标视角）
 *   · 画布轻触      → interaction.tryInteract()        （替代 E 键交互）
 *   · 右下按钮      → 交互 / 冲刺(切换) / 菜单
 *   · 菜单面板      → 进货 / 背包 / 手机 / 监控 / 排行 / 存档 / 读档 / 暂停
 *   · 横屏策略      → enterGame() 内 requestFullscreen + screen.orientation.lock('landscape')；
 *                     不支持锁屏（iOS Safari）则降级为全屏 + 「横屏玩更顺手」遮罩，
 *                     转成横屏自动消失，**且遮罩上有「知道了，直接进入」兜底出口**（不依赖旋转）。
 *   退出游戏 exitGame() 释放全屏与锁屏。
 *
 * 设计要点（见项目 memory 的「双端适配铁律」）：
 *   · 所有触屏监听都 preventDefault，避免浏览器把拖动当成滚动/缩放、把 300ms 后的合成 click 误触。
 *   · 摇杆 / 按钮是覆盖在画布之上的独立 DOM（更高 z-index + stopPropagation），不会触发画布转视角。
 *   · 键盘路径（player.mjs 的 keys Set、E/Tab/... 仍由 main.mjs 的 keydown 处理）原样保留，桌面不退化。
 */
import { state } from './state.mjs';

/** 判断当前是否应以触屏为主输入。多判据，避免单点误判。 */
function isCoarsePointer() {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return true;
  if ('ontouchstart' in window) return true;
  if (typeof navigator !== 'undefined' && (navigator.maxTouchPoints || 0) > 0) return true;
  return false;
}

export function createMobileControls({ player, interaction, panels = {} } = {}) {
  if (!isCoarsePointer()) return null; // 桌面端：不挂载任何东西

  const root = document.createElement('div');
  root.id = 'ns-mc-root';
  root.innerHTML = `
    <div id="ns-joy" aria-hidden="true"><div id="ns-joy-knob"></div></div>
    <div id="ns-actions">
      <button id="ns-act-interact" class="ns-act" type="button">交互</button>
      <button id="ns-act-sprint" class="ns-act" type="button">冲刺</button>
      <button id="ns-act-menu" class="ns-act" type="button">菜单</button>
    </div>
    <div id="ns-menu" class="ns-hidden">
      <button type="button" data-act="purchase">🛒 进货/商店</button>
      <button type="button" data-act="inventory">🎒 背包</button>
      <button type="button" data-act="phone">📱 手机</button>
      <button type="button" data-act="monitor">📹 监控</button>
      <button type="button" data-act="leaderboard">🏆 排行榜</button>
      <button type="button" data-act="save">💾 存档</button>
      <button type="button" data-act="load">📂 读档</button>
      <button type="button" data-act="pause">⏸ 暂停</button>
      <button type="button" data-act="close" class="ns-menu-close">✕ 关闭</button>
    </div>
    <div id="ns-rotate">
      <div class="ns-rotate-icon">📱 ↻</div>
      <div class="ns-rotate-text">横屏玩更顺手</div>
      <div class="ns-rotate-sub">把手机转成横向即可自动关闭本提示</div>
      <button id="ns-rotate-dismiss" type="button">知道了，直接进入</button>
    </div>`;
  document.body.appendChild(root);

  const joy = root.querySelector('#ns-joy');
  const knob = root.querySelector('#ns-joy-knob');
  const actions = root.querySelector('#ns-actions');
  const menu = root.querySelector('#ns-menu');
  const rotate = root.querySelector('#ns-rotate');
  const canvas = document.getElementById('scene-canvas');
  const sprintBtn = root.querySelector('#ns-act-sprint');

  /* ---------------- 触摸分区（2026-10-05 手机手感反馈） ----------------
   * 之前：摇杆固定在左下小圆，画布其余区域（含左半屏）全是"转视角"。
   * 玩家手自然搭在左半屏时一动就转视角，非常别扭。
   * 现在：**左半屏 = 移动区（浮动摇杆：手指按在哪，摇杆中心就在哪）**，
   * **右半屏 = 视角区（拖拽转视角，轻触 = 交互）**。分区以视口中线为界。
   */
  const TOUCH_LOOK_MULT = 1.7;
  let joyId = null, joyCx = 0, joyCy = 0, joyR = 56;
  let lookId = null, lastX = 0, lastY = 0, startX = 0, startY = 0, moved = 0, t0 = 0;
  /** 在触摸点显示浮动摇杆（joy 为 fixed 定位，用 inline left/top 覆盖默认左下角） */
  function showJoyAt(x, y) {
    joy.style.display = 'block';
    joy.style.left = (x - joyR) + 'px';
    joy.style.top = (y - joyR) + 'px';
    joyCx = x; joyCy = y;
    knob.style.transform = 'translate(0,0)';
  }
  function hideJoy() {
    joy.style.display = 'none';
    knob.style.transform = 'translate(0,0)';
  }
  if (canvas) {
    canvas.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      if (t.clientX < window.innerWidth / 2) {
        // 左半屏：进入移动模式（浮动摇杆）
        joyId = t.identifier;
        showJoyAt(t.clientX, t.clientY);
      } else {
        // 右半屏：进入视角模式（拖拽转视角）
        lookId = t.identifier;
        lastX = startX = t.clientX; lastY = startY = t.clientY;
        moved = 0; t0 = Date.now();
      }
      e.preventDefault();
    }, { passive: false });
    canvas.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === joyId) {
          let dx = t.clientX - joyCx, dy = t.clientY - joyCy;
          const d = Math.hypot(dx, dy);
          if (d > joyR) { dx = (dx / d) * joyR; dy = (dy / d) * joyR; }
          knob.style.transform = `translate(${dx}px, ${dy}px)`;
          // 上 = 前进(iz 正)，右 = 右移(ix 正)
          player.setTouchMove(dx / joyR, -dy / joyR);
        } else if (t.identifier === lookId) {
          const dx = t.clientX - lastX, dy = t.clientY - lastY;
          lastX = t.clientX; lastY = t.clientY;
          moved += Math.hypot(dx, dy);
          player.addLook(dx * TOUCH_LOOK_MULT, dy * TOUCH_LOOK_MULT);
        }
      }
      e.preventDefault();
    }, { passive: false });
    canvas.addEventListener('touchend', (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === joyId) {
          joyId = null;
          hideJoy();
          player.setTouchMove(0, 0);
        } else if (t.identifier === lookId) {
          const dt = Date.now() - t0;
          if (moved < 14 && dt < 250 && interaction && typeof interaction.tryInteract === 'function') {
            interaction.tryInteract(); // 右半屏轻触 = 交互（等价 E 键）
          }
          lookId = null;
        }
      }
    });
    canvas.addEventListener('touchcancel', () => {
      joyId = null; lookId = null;
      hideJoy();
      player.setTouchMove(0, 0);
    });
  }

  /* ---------------- 右下按钮 ---------------- */
  root.querySelector('#ns-act-interact').addEventListener('click', () => {
    if (interaction && typeof interaction.tryInteract === 'function') interaction.tryInteract();
  });
  sprintBtn.addEventListener('click', () => {
    const on = sprintBtn.classList.toggle('on');
    player.setTouchSprint(on);
  });
  root.querySelector('#ns-act-menu').addEventListener('click', () => {
    menu.classList.toggle('ns-hidden');
  });

  /* ---------------- 菜单面板 ---------------- */
  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    menu.classList.add('ns-hidden');
    const fn = panels[act];
    if (typeof fn === 'function') fn();
  });

  /* ---------------- 横屏 / 旋转遮罩 ----------------
   * 真机事故（2026-10-03）：部分手机上「请旋转设备」遮罩把玩家永久关在门外——
   * 竖屏提示只有旋转一条出路，而 z-index 9999 的遮罩又吃掉了所有点击。
   * 三条硬约束（改这里前先读）：
   *   ① **必须有兜底出口**：遮罩上有可点的「知道了，直接进入」，不依赖旋转；
   *   ② **判定方向要统一**：宽>=高 即横屏，media query / window.innerWidth 都只是"参考"，
   *      谁先报横屏都算，避免某些浏览器 (orientation:portrait) 撒谎导致判定反了且永不自愈；
   *   ③ **隐藏必须彻底**：display:none + pointer-events:none，绝不留透明层挡住下方 UI。
   */
  const rotateBtn = root.querySelector('#ns-rotate-dismiss');
  let running = false;
  // 玩家明确关过遮罩后就不再自动弹（否则每次 orientationchange 都糊上来一次）
  let rotateDismissed = false;

  const wideEnough = () => {
    const w = (typeof window !== 'undefined' ? window.innerWidth : 0) || 0;
    const h = (typeof window !== 'undefined' ? window.innerHeight : 0) || 0;
    return w > 0 && h > 0 && w >= h;
  };
  /** 是否真横屏。**汇总判据，任一为真即算**（宁可少弹一次，也不能把人关住） */
  function isLandscape() {
    let mqPortrait = null, mqLandscape = null;
    if (window.matchMedia) {
      try { mqPortrait = window.matchMedia('(orientation: portrait)').matches; } catch { /* ignore */ }
      try { mqLandscape = window.matchMedia('(orientation: landscape)').matches; } catch { /* ignore */ }
    }
    if (mqLandscape === true) return true;
    if (mqPortrait === true) return false;
    return wideEnough();
  }
  /** 是否弹遮罩：只有「明确竖屏」才弹。宽高比是最终权威——
   * 部分浏览器在 lock('landscape') 后 media query 不更新/撒谎，
   * 依赖 mq 会把遮罩卡死（2026-10-05 反馈：横屏切竖屏后翻不回来）。 */
  function isPortrait() {
    return !wideEnough();
  }
  function showRotate(on) {
    if (on) {
      rotate.style.display = 'flex';
      rotate.style.pointerEvents = 'auto';   // 可见时才吃点击（按钮要吃得到）
    } else {
      rotate.style.display = 'none';
      rotate.style.pointerEvents = 'none';   // 不可见且绝不吃指针（要求③）
    }
  }
  function updateRotate() {
    if (!running) { showRotate(false); return; }
    if (rotateDismissed) { showRotate(false); return; }
    showRotate(isPortrait());
  }
  // 三路监听：media query change（现代浏览器）+ orientationchange（老设备/部分安卓）+ resize/orientation
  if (window.matchMedia) {
    for (const q of ['(orientation: portrait)', '(orientation: landscape)']) {
      let mq = null;
      try { mq = window.matchMedia(q); } catch { mq = null; }
      if (!mq) continue;
      if (mq.addEventListener) mq.addEventListener('change', updateRotate);
      else if (mq.addListener) mq.addListener(updateRotate);   // 老 Safari
    }
  }
  window.addEventListener('orientationchange', updateRotate);
  window.addEventListener('resize', updateRotate);
  if (window.visualViewport && window.visualViewport.addEventListener) {
    window.visualViewport.addEventListener('resize', updateRotate);
  }
  // screen.orientation 是锁屏/全屏场景下最可靠的方向源（有些浏览器 media query
  // 在 lock('landscape') 后不再触发 change，遮罩就卡死 —— 2026-10-05 手机反馈：
  // "横屏切竖屏后无法再翻回横屏"）。
  try {
    if (screen.orientation && typeof screen.orientation.addEventListener === 'function') {
      screen.orientation.addEventListener('change', updateRotate);
    } else if (screen.orientation && typeof screen.orientation.onchange === 'function') {
      screen.orientation.onchange = updateRotate;
    }
  } catch { /* 忽略 */ }
  // 兜底轮询：任何事件都不触发时，500ms 自查一次宽高比，遮罩状态永不卡死
  setInterval(updateRotate, 500);
  // 要求①：兜底出口。点一下即"我就要进游戏"，不转屏也放行。
  if (rotateBtn) {
    const dismiss = (e) => {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      rotateDismissed = true;
      showRotate(false);
    };
    rotateBtn.addEventListener('click', dismiss);
    rotateBtn.addEventListener('touchend', dismiss, { passive: false });
  }

  function enterGame() {
    running = true;
    rotateDismissed = false;   // 每次进游戏重新给一次横屏提示（读档/重开也算一次新进场）
    root.style.display = 'block';
    // 全屏 + 锁横屏必须在用户手势内调用（来自「开始营业」按钮点击链）
    try { if (document.documentElement && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {}); } catch { /* iOS 不支持，忽略 */ }
    try { if (screen.orientation && typeof screen.orientation.lock === 'function') screen.orientation.lock('landscape').catch(() => {}); } catch { /* iOS 不支持，忽略 */ }
    updateRotate();
    // 转屏瞬间部分浏览器 metrics 还没更新 → 补两次延迟重判，避免出现"转了但遮罩不走"
    setTimeout(updateRotate, 260);
    setTimeout(updateRotate, 900);
  }
  function exitGame() {
    running = false;
    root.style.display = 'none';
    player.setTouchMove(0, 0);
    player.setTouchSprint(false);
    sprintBtn.classList.remove('on');
    try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {}); } catch { /* 忽略 */ }
    try { if (screen.orientation && typeof screen.orientation.unlock === 'function') screen.orientation.unlock(); } catch { /* 忽略 */ }
    showRotate(false);
  }

  root.style.display = 'none'; // 标题界面先隐藏，进入游戏才显示
  showRotate(false);           // 初始态就显式关掉指针拦截，别等第一次 updateRotate
  return { enterGame, exitGame, isTouch: true };
}
