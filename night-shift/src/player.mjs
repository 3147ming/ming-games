/**
 * 第一人称控制器（SYS-05）
 *
 * 视角主模式 =「鼠标与屏幕绑定」Pointer Lock：
 *   指针隐藏并锁定到屏幕中心，移动鼠标即转视角，鼠标不会移出画面（标准 FPS 手感）。
 *
 * 兜底 = free-look：
 *   仅当指针锁定确实不可用（iframe / 沙箱预览面板拒绝 requestPointerLock）时启用，
 *   鼠标移动即转视角（不需按住任何键），但指针不被限制。
 *   注意：这里刻意不做"按住左键拖动"——手感与绑定模式差别太大。
 *
 * 移动始终不依赖锁定状态（除非暂停），否则锁定一失败玩家就完全动不了。
 */
import * as THREE from 'three';
import {
  WALK_SPEED, SPRINT_SPEED, EYE_HEIGHT, SENSITIVITY, PITCH_CLAMP,
  PLAYER_RADIUS, ROOM, CLERK, STORE,
} from './config.mjs';
import { state } from './state.mjs';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function createPlayer(camera, colliders, canvas, { onLockChange, onFootstep } = {}) {
  let yaw = 0;
  let pitch = 0;
  let locked = false;      // 指针已锁定到屏幕（绑定模式生效中）
  let lockFailed = false;  // 指针锁定不可用（iframe / 沙箱 / 被拒 / 超时无响应）
  let dragging = false;    // 拖动环视兜底模式下是否按住左键
  let probeTimer = null;   // 锁定请求超时探测
  const keys = new Set();
  // 触屏输入（移动端虚拟摇杆 / 按钮注入；桌面键盘路径完全不受影响）
  let touchMoveX = 0, touchMoveZ = 0, touchSprint = false;

  /**
   * 鼠标灵敏度倍率（设置面板 → 灵敏度滑杆）。
   * 为什么是"倍率"而不是直接改 SENSITIVITY：SENSITIVITY 是 config 里的**设计基线**，
   * 改它会把"默认手感"一起改掉、且没法回退到基线；倍率则天然支持 1.0 = 原手感。
   * 下限 0.05（见 setSensitivity）不是为了"最小灵敏度"，而是防止调成 0 后彻底转不了视角。
   */
  let sensMul = 1;

  /**
   * 疲劳系统：玩家疲劳对灵敏度的**独立**衰减倍率（默认 1 = 不衰减）。
   * 刻意与 sensMul 分开叠乘 —— sensMul 来自设置面板（玩家主动调），
   * fatigueMul 来自疲劳系统（通宵困倦被动加），两者语义不同、不能互相覆盖。
   * 同理 fatigueSway 是疲劳引起的准星微飘幅度（rad），与 clerk 疲劳的视角抖动也分开。
   */
  let fatigueMul = 1;
  let fatigueSway = 0;

  // 玩家水平位置（y 固定为眼高）
  const pos = new THREE.Vector2(camera.position.x, camera.position.z);

  /**
   * 场地边界兜底（需求I 第⑦条：扩建后场地会变大，不能再用 ROOM 常量）。
   * 真正的墙已经在 colliders 里，这里是防止"被挤出墙外后再也回不来"的最后一道保险。
   */
  let bounds = {
    minX: -ROOM.width / 2, maxX: ROOM.width / 2,
    minZ: -ROOM.depth / 2, maxZ: ROOM.depth / 2,
  };

  /* ---------- Pointer Lock：鼠标与屏幕绑定 ---------- */
  function requestLock() {
    // 触屏设备（pointer:coarse）不需要也不能 pointer-lock；跳过以免控制台刷红/无谓尝试
    if (typeof window !== 'undefined' && window.matchMedia
      && window.matchMedia('(pointer: coarse)').matches) return;
    if (locked) return;
    try {
      // unadjustedMovement 去掉系统鼠标加速（Chrome 支持；其他内核忽略该参数）
      const p = canvas.requestPointerLock?.({ unadjustedMovement: true });
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          // 不支持 options 的浏览器会 reject，退回无参版本。
          // 注意：无参版本在现代 Chrome 同样返回 Promise，若它在沙箱 iframe 里
          // 也被拒（WrongDocumentError / SecurityError），必须一并兜住，
          // 否则就是一个未捕获的 Promise 拒绝，并在控制台刷红。
          try {
            const p2 = canvas.requestPointerLock();
            if (p2 && typeof p2.catch === 'function') p2.catch(() => markFailed('error'));
          } catch { markFailed('error'); }
        });
      }
    } catch {
      markFailed('error');
      return;
    }
    // 超时探测：部分环境既不成功也不报错（静默失败），1.5s 后判定不可用
    clearTimeout(probeTimer);
    probeTimer = setTimeout(() => {
      if (!locked && !lockFailed) markFailed('timeout');
    }, 1500);
  }

  function markFailed(reason) {
    lockFailed = true;
    locked = false;
    if (typeof onLockChange === 'function') onLockChange(false, reason);
  }

  // 点击画面即尝试锁定（同时也是"继续营业"的恢复入口）
  canvas.addEventListener('mousedown', () => { dragging = true; requestLock(); });
  canvas.addEventListener('click', () => requestLock());
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  // 任何位置松开都算结束拖动（拖动时指针可能已经划出画布）
  window.addEventListener('mouseup', () => { dragging = false; });

  document.addEventListener('pointerlockchange', () => {
    const nowLocked = document.pointerLockElement === canvas;
    if (nowLocked) {
      clearTimeout(probeTimer);
      lockFailed = false; // 环境可能变好（例如用户切到独立窗口）
      locked = true;
    } else {
      locked = false;
    }
    if (typeof onLockChange === 'function') onLockChange(locked, 'change');
  });

  document.addEventListener('pointerlockerror', () => markFailed('error'));

  /* ---------- 鼠标视角 ---------- */
  document.addEventListener('mousemove', (e) => {
    if (locked) {
      // 绑定模式：movementX/Y 始终有效
    } else if (lockFailed) {
      /* 拖动环视兜底（iframe / 预览面板里指针锁定被拒时）。
       * 需求：锁定失败 → 自动切"按住鼠标拖动环视 + WASD 移动"。
       * 原先这里是不按键就转视角（free-look），手感和绑定模式差太远，
       * 移到 HUD 上时还会误转镜头；改成必须按住左键拖动。 */
      if (!dragging) return;
    } else {
      // 锁定可用但当前未锁定：等玩家点击画面重新绑定，此期间不转视角
      return;
    }
    yaw -= (e.movementX ?? 0) * SENSITIVITY * sensMul * fatigueMul;
    pitch -= (e.movementY ?? 0) * SENSITIVITY * sensMul * fatigueMul;
    pitch = clamp(pitch, -PITCH_CLAMP, PITCH_CLAMP); // 防翻转（SYS-05 §8）
  });

  /* ---------- 键盘 ---------- */
  function isTypingTarget(t) {
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
  }
  window.addEventListener('keydown', (e) => {
    if (isTypingTarget(e.target)) return;
    keys.add(e.code);
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());

  /* ---------- 碰撞：圆 vs AABB push-out（ADR-005） ---------- */
  function resolveCollisions(p) {
    for (const b of colliders) {
      const cx = clamp(p.x, b.min.x, b.max.x);
      const cz = clamp(p.y, b.min.z, b.max.z);
      const dx = p.x - cx;
      const dz = p.y - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 < PLAYER_RADIUS * PLAYER_RADIUS) {
        const d = Math.sqrt(d2) || 1e-4;
        const push = PLAYER_RADIUS - d;
        p.x += (dx / d) * push;
        p.y += (dz / d) * push;
        touching = true; // 本帧贴着墙/货架（靠墙恢复用）
      }
    }
    // 房间边界兜底（边界随店铺扩建外扩）
    p.x = clamp(p.x, bounds.minX + PLAYER_RADIUS, bounds.maxX - PLAYER_RADIUS);
    p.y = clamp(p.y, bounds.minZ + PLAYER_RADIUS, bounds.maxZ - PLAYER_RADIUS);
  }

  /* ---------- 每帧更新 ---------- */
  let bobT = 0;
  let frameMove = 0;   // 本帧水平位移（米），供 clerk 体力消耗用
  let touching = false; // 本帧是否贴着墙/货架（靠墙恢复用）
  let stepPhase = 0;    // 累计行走距离，用于触发脚步声
  const vel = new THREE.Vector2(); // 平滑后的水平速度（手感 3）
  const forward = new THREE.Vector2();
  const right = new THREE.Vector2();

  /** 每走这么远记一步脚步声 */
  const STEP_LEN = 1.9;
  /** 是否在店内（决定脚步声用瓷砖还是室外软地） */
  function inStore(x, z) {
    return x >= STORE.minX && x <= STORE.maxX && z >= STORE.minZ && z <= STORE.maxZ;
  }

  function update(dt) {
    frameMove = 0;
    touching = false;

    // 视角始终跟随（即使暂停也能转头看，但不移动）
    camera.rotation.order = 'YXZ';
    camera.rotation.set(pitch, yaw, 0);

    // 只有暂停才阻断移动；指针锁定状态不阻断
    if (state.paused) {
      camera.position.y = EYE_HEIGHT;
      return;
    }
    // 小游戏中：锁住走动（但不暂停夜时钟 → 玩设施有机会成本），视角仍跟随以免退出时跳变
    if (state.minigameId) return;

    // 软惩罚（§1.3）：体力 <25 → 移速 ×0.8 且禁冲刺；疲惫 >70 → 视角抖动
    const lowStamina = state.clerk && state.clerk.stamina < CLERK.thr.stamina;
    const highFatigue = state.clerk && state.clerk.fatigue > CLERK.thr.fatigue;
    const sprinting = (keys.has('ShiftLeft') || keys.has('ShiftRight') || touchSprint) && !lowStamina;
    let speed = sprinting ? SPRINT_SPEED : WALK_SPEED;
    if (lowStamina) speed *= 0.8;

    let ix = 0;
    let iz = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) iz += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) iz -= 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) ix -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) ix += 1;
    // 触屏摇杆注入（与键盘同一坐标系：ix 右正左负 / iz 前正后负），下方按向量归一化
    ix += touchMoveX;
    iz += touchMoveZ;

    // 方向基（yaw=0 时朝 -z）
    forward.set(-Math.sin(yaw), -Math.cos(yaw));
    right.set(Math.cos(yaw), -Math.sin(yaw));

    const moving = ix !== 0 || iz !== 0;
    let tvx = 0;
    let tvy = 0;
    if (moving) {
      const len = Math.hypot(ix, iz) || 1;
      const nx = ix / len;
      const nz = iz / len;
      tvx = (forward.x * nz + right.x * nx) * speed;
      tvy = (forward.y * nz + right.y * nx) * speed;
    }

    /* 平滑加减速（手感 3）：速度按指数逼近目标，不再是"按下即满速 / 松键即定死"。
     * 时间常数 0.05s 左右 —— 松键后 0.1s 内残速 <10%，满足"0.1 秒内停稳"。 */
    const k = 1 - Math.exp(-dt / (moving ? 0.055 : 0.04));
    vel.x += (tvx - vel.x) * k;
    vel.y += (tvy - vel.y) * k;
    if (!moving && Math.hypot(vel.x, vel.y) < 0.05) { vel.x = 0; vel.y = 0; }

    const spd = Math.hypot(vel.x, vel.y);
    if (spd > 1e-4) {
      const bx = pos.x, bz = pos.y;
      pos.x += vel.x * dt;
      pos.y += vel.y * dt;
      resolveCollisions(pos);
      frameMove = Math.hypot(pos.x - bx, pos.y - bz);

      // 走动轻微起伏（幅度随实际速度，reduced-motion 时关闭）
      bobT += dt * spd * 1.9;
      // 脚步声（手感 3）：按行走距离触发，店内瓷砖 / 室外软地两种
      stepPhase += frameMove;
      if (stepPhase >= STEP_LEN) {
        stepPhase -= STEP_LEN;
        if (typeof onFootstep === 'function') onFootstep(inStore(pos.x, pos.y) ? 'tile' : 'carpet');
      }
    } else {
      stepPhase = 0;
    }

    // 软惩罚（§1.3）：疲惫 >70 注入视角噪声（临时偏移，不污染 yaw/pitch 存储）
    let yawN = yaw, pitchN = pitch;
    if (highFatigue) {
      const amp = ((state.clerk.fatigue - CLERK.thr.fatigue) / 30) * 0.012;
      yawN += (Math.random() - 0.5) * 2 * amp;
      pitchN += (Math.random() - 0.5) * 2 * amp;
    }
    // 玩家疲劳（中度起）：准星微飘。与上面 clerk 疲劳的抖动分开叠加 ——
    // 前者是"店员累了"的软惩罚，后者是"玩家自己困了"的反馈，两者可同时存在。
    if (fatigueSway > 0) {
      yawN += (Math.random() - 0.5) * 2 * fatigueSway;
      pitchN += (Math.random() - 0.5) * 2 * fatigueSway;
    }
    pitchN = clamp(pitchN, -PITCH_CLAMP, PITCH_CLAMP);
    camera.rotation.set(pitchN, yawN, 0);

    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const bobAmp = Math.min(1, spd / WALK_SPEED);
    const bob = reduce ? 0 : Math.sin(bobT) * 0.022 * bobAmp;
    camera.position.set(pos.x, EYE_HEIGHT + bob, pos.y);
  }

  /**
   * 传送到指定水平位置（读档还原玩家坐标用）。
   * 走一遍碰撞求解，避免还原坐标正好落在货架里 —— 否则玩家一读档就被挤出去或卡住。
   */
  function setPosition(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    pos.x = x;
    pos.y = z;
    resolveCollisions(pos);
    camera.position.set(pos.x, EYE_HEIGHT, pos.y);
  }

  /** 还原朝向（yaw/pitch），让读档后视角与存档时刻一致 */
  function setLook(y, p) {
    if (Number.isFinite(y)) yaw = y;
    if (Number.isFinite(p)) pitch = clamp(p, -PITCH_CLAMP, PITCH_CLAMP);
    camera.rotation.set(pitch, yaw, 0);
  }

  /* ---------- 触屏输入 API（移动端虚拟摇杆 / 按钮调用，不影响桌面路径） ---------- */
  function addLook(dx, dy) {
    // 与鼠标视角同一公式：movementX/Y 即手指位移量，灵敏度倍率一致
    yaw -= (dx) * SENSITIVITY * sensMul * fatigueMul;
    pitch -= (dy) * SENSITIVITY * sensMul * fatigueMul;
    pitch = clamp(pitch, -PITCH_CLAMP, PITCH_CLAMP);
  }
  function setTouchMove(x, z) {
    touchMoveX = Math.max(-1, Math.min(1, x));
    touchMoveZ = Math.max(-1, Math.min(1, z));
  }
  function setTouchSprint(on) { touchSprint = !!on; }

  return {
    update,
    requestLock,
    addLook,
    setTouchMove,
    setTouchSprint,
    /** 需求I 第⑦条：店铺扩建后同步放宽活动边界 */
    setBounds(b) {
      if (!b) return;
      if (Number.isFinite(b.minX)) bounds.minX = b.minX;
      if (Number.isFinite(b.maxX)) bounds.maxX = b.maxX;
      if (Number.isFinite(b.minZ)) bounds.minZ = b.minZ;
      if (Number.isFinite(b.maxZ)) bounds.maxZ = b.maxZ;
    },
    get bounds() { return { ...bounds }; },
    /** 设置页：鼠标灵敏度倍率（0.3–2.5，由 settings.mjs 保证范围） */
    setSensitivity(mul) {
      if (Number.isFinite(mul)) sensMul = Math.max(0.05, mul);
    },
    get sensitivity() { return sensMul; },
    /** 疲劳系统：设定疲劳对灵敏度/准星的衰减（main 每帧从 fatigue.effects() 推过来） */
    setFatigue(mul, sway) {
      fatigueMul = Number.isFinite(mul) ? Math.max(0.2, mul) : 1;
      fatigueSway = Number.isFinite(sway) ? Math.max(0, sway) : 0;
    },
    /** 读档：还原位置与朝向 */
    setPosition,
    setLook,
    get look() { return { yaw, pitch }; },
    get locked() { return locked; },
    get lockFailed() { return lockFailed; },
    get position() { return pos; },
    get frameMove() { return frameMove; },
    get touching() { return touching; },
  };
}
