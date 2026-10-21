/**
 * 入口：游戏状态机（菜单 / 仓库 / 商店 / 战前配置 / 战斗 / 结算）与主循环
 */

import {
  TILE, MATCH, PLAYER, ITEMS, WEAPONS, ARMORS, CONTAINERS, SHOP, SCORING, POI, AMMO_STACK, COLORS,
  ENEMY_TYPES, KILLFEED, COMBAT,
} from './config.js';
import { pickContracts, updateContracts, settleExtractContracts } from './contracts.js';
import { createRng, randomSeed } from './rng.js';
import { generateMap, hasLineOfSight } from './mapgen.js';
import {
  createItem, autoPlace, hasSpace, totalValue, totalWeight, consumeById, removeItemByUid,
} from './inventory.js';
import * as Loot from './loot.js';
import { Player, buildLoadoutItems } from './player.js';
import { spawnEnemies } from './enemy.js';
import { isWebGLAvailable, createScene3D } from './scene3d.js';
import { Renderer3D, NoopRenderer3D } from './renderer3d.js';
import { createInput, setupMouseLook } from './input.js';
import { detectDeviceTier } from './device.js';
import { createTouchControls } from './touch-controls.js';
import { createAudio } from './audio.js';
import { createUI, hudLayout } from './ui.js';
import * as Storage from './storage.js';

const canvas = document.getElementById('game-canvas');
const uiRoot = document.getElementById('ui-root');

const audio = createAudio();
// 设备分级：手机走 low 档（降像素比 / 关阴影与后处理 / 缩短视距），桌面完全维持原画质
const device = detectDeviceTier();
const touchMode = device.isTouch;
const sceneHandle = isWebGLAvailable() ? createScene3D(canvas, device) : null;
const renderer = sceneHandle ? new Renderer3D(sceneHandle, canvas, device) : new NoopRenderer3D();

let save = Storage.loadSave();
let world = null;
let screen = 'menu';
let paused = false;
let lastTs = 0;
let openContainer = null;

const input = createInput();
input.invertMouseX = save.settings.invertMouseX;
input.sensitivityMul = save.settings.mouseSens;
input.touchLookSens = save.settings.touchLookSens || 1.0;
COMBAT.aimAssist.enabled = save.settings.aimAssist; // 辅助瞄准开关随存档恢复
if (renderer && 'baseFov' in renderer) renderer.baseFov = save.settings.fov;
const mouseLook = setupMouseLook(canvas, input, { touchMode });

/* ==================== 手机端：触屏控制 / 横屏 / 全屏 ==================== */

// 竖屏旋转提示（可关闭，关闭后竖屏仍可玩 —— 绝不白屏）
let rotateDismissed = false;
let rotateOverlay = null;
if (touchMode) {
  document.body.classList.add('touch-mode');
  rotateOverlay = document.createElement('div');
  rotateOverlay.className = 'rotate-overlay hidden';
  rotateOverlay.innerHTML = `
    <div class="rotate-card">
      <div class="rotate-icon">&#8635;</div>
      <div class="rotate-title">建议横屏游玩</div>
      <div class="rotate-text">横屏视野更宽、操作更顺手。<br />把设备转到横向，本提示会自动消失。</div>
      <button type="button" class="btn rotate-dismiss" data-role="rotate-dismiss">仍要竖屏继续</button>
    </div>`;
  rotateOverlay.querySelector('[data-role="rotate-dismiss"]')
    .addEventListener('click', () => { rotateDismissed = true; updateTouchState(); });
  document.body.appendChild(rotateOverlay);
}

/** 触屏动作回调：需要世界上下文的动作统一在这里接线 */
function handleTouchAction(action, value) {
  if (action === 'touchLook') {
    save.settings.touchLookSens = value;
    Storage.saveGame(save);
    return;
  }
  if (screen !== 'battle' || !world || world.over) return;
  const p = world.player;
  switch (action) {
    case 'reload': p.reload(world); break;
    case 'interact': if (!p.ropelling) p.interact(world); break;
    case 'switch': p.switchWeapon(p.weaponIndex === 0 ? 1 : 0, world); break;
    case 'heal': p.useMedkit(world); break;
    case 'rope': p.startRope(world); break;
    case 'vehicle': if (p.vehicle) p.exitVehicle(world); else p.enterVehicle(world); break;
    case 'bag': toggleBackpack(); break;
    case 'tasks': ui.toggleTasks(); break;
    case 'pause': setPaused(!paused); break;
    default: break;
  }
}

// 只在手机端创建：桌面端不挂载任何触屏 DOM 与 window 触摸监听，原操作零影响
let touchControls = null;
// 缓存媒体查询对象：updateTouchState 每帧都会问一次横竖屏，
// 逐帧 matchMedia 会反复构造 MediaQueryList（真机上也是白给的开销）。
const mqLandscape = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(orientation: landscape)')
  : { matches: true };
if (touchMode) {
  touchControls = createTouchControls({
    input,
    root: document.body,
    onAction: handleTouchAction,
  });
  // 应用存档里的按钮尺寸与自定义布局（位置/大小可调）
  touchControls.setButtonScale(save.settings.touchButtonScale || 1.0);
  touchControls.applyLayout(save.layout.touch || {});
}

/**
 * 统一维护触屏控制的激活状态：战斗中、无面板、且未被旋转提示遮住时才接管触摸。
 * 面板（背包 / 战利品）打开时必须撤下来，否则会吞掉面板的滚动与点击。
 * @returns {void}
 */
function updateTouchState() {
  if (!touchMode) return;
  const panelOpen = ui.isBackpackOpen() || ui.isLootOpen();
  const portrait = !mqLandscape.matches;
  const showRotate = screen === 'battle' && portrait && !rotateDismissed;
  if (rotateOverlay) rotateOverlay.classList.toggle('hidden', !showRotate);
  const wantActive = screen === 'battle' && !panelOpen && !showRotate;
  if (touchControls) {
    touchControls.setActive(wantActive);
    // 上下文交互键：与 HUD 提示同源（同一优先级链），靠近才弹出、离开即消失。
    // 这样玩家不会在空地上看到一个常驻却永远点不出东西的交互键。
    if (wantActive) refreshTouchContext();
    else touchControls.setContext(null);
  }
}

/**
 * 探测玩家附近是否有可交互目标，把结果交给触屏控件决定是否弹出交互键。
 * 判定优先级与 player.interact / HUD 提示一致：终端 → 撤离 → 地面物品 → 容器 → 绳索 / 载具。
 * @returns {void}
 */
function refreshTouchContext() {
  if (!touchControls) return;
  const p = world && world.player;
  if (screen !== 'battle' || !world || world.over || !p || p.dead) {
    touchControls.setContext(null);
    return;
  }
  // 正在读条 / 驾驶 / 速降：给出"取消/下车"语义，让玩家能主动中断
  if (p.search || p.extract || p.hack) {
    touchControls.setContext({ text: '取消' });
    return;
  }
  if (p.ropelling) { touchControls.setContext({ text: '速降中', enabled: false }); return; }
  if (p.vehicle) { touchControls.setContext({ text: '下车' }); return; }

  if (p.busy) { touchControls.setContext(null); return; }

  if (p.nearestTerminal && p.nearestTerminal(world)) {
    touchControls.setContext({ text: '破解' });
    return;
  }
  if (p.nearestExtract && p.nearestExtract(world)) {
    touchControls.setContext({ text: '撤离' });
    return;
  }
  if (p.nearestItem && p.nearestItem(world)) {
    touchControls.setContext({ text: '拾取' });
    return;
  }
  const container = p.nearestContainer ? p.nearestContainer(world) : null;
  if (container) {
    const remain = (container.loot || []).length;
    if (container.searched && remain === 0) { touchControls.setContext(null); return; }
    touchControls.setContext({ text: container.searched ? '开箱' : '搜索' });
    return;
  }
  if (p.ropeLanding && p.ropeLanding(world)) { touchControls.setContext({ text: '速降' }); return; }
  if (p.nearestVehicle && p.nearestVehicle(world)) { touchControls.setContext({ text: '上车' }); return; }

  touchControls.setContext(null);
}

/**
 * 进入战局时自动全屏 + 锁横屏（必须在用户手势内调用，所以放在 deploy 里）。
 * iOS Safari 不支持 orientation.lock，静默降级为「全屏 + 旋转提示」。
 * @returns {void}
 */
function enterMobileFullscreen() {
  if (!touchMode) return;
  try {
    const el = document.documentElement;
    const p = el.requestFullscreen && el.requestFullscreen();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch { /* 不支持全屏：忽略，玩法不受影响 */ }
  try {
    // 注意：本模块有名为 screen 的状态变量，会遮蔽全局 window.screen，必须显式取 window.screen
    const so = window.screen && window.screen.orientation;
    if (so && typeof so.lock === 'function') {
      const q = so.lock('landscape');
      if (q && typeof q.catch === 'function') q.catch(() => {});
    }
  } catch { /* iOS Safari 会抛不支持异常，交给旋转提示兜底 */ }
}

/** 退出战局回菜单：释放全屏与屏幕方向锁定，避免卡在全屏 */
function exitMobileFullscreen() {
  if (!touchMode) return;
  try {
    if (document.fullscreenElement) {
      const q = document.exitFullscreen();
      if (q && typeof q.catch === 'function') q.catch(() => {});
    }
  } catch { /* 忽略 */ }
  try {
    const so = window.screen && window.screen.orientation;
    if (so && typeof so.unlock === 'function') so.unlock();
  } catch { /* 忽略 */ }
}

audio.setVolume(save.settings.volume);
if (save.settings.muted) audio.toggleMute();

/* ============================ 工具函数 ============================ */

function money(n) {
  return `¥${Math.round(n).toLocaleString('en-US')}`;
}

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/* ====================== 指针锁定（输入模式）管理 ====================== */

/**
 * 是否处于"应该由鼠标直接控制视角"的战斗状态。
 * 暂停、结算、以及打开背包 / 战利品面板时都不是 —— 这些状态下必须把鼠标还给用户，
 * 否则面板按钮点不到（指针锁定期间所有鼠标事件都只发给画布，光标还是隐藏的）。
 * @returns {boolean} 是否需要独占鼠标
 */
function wantsMouseLock() {
  // 手机端从未有可用的指针锁定：真机上 requestPointerLock 会抛
  // "WrongDocumentError: The root document of this element is not valid for pointer lock"，
  // 视角改由右摇杆驱动。桌面端完全走原逻辑。
  if (touchMode) return false;
  if (screen !== 'battle' || paused || !world || world.over) return false;
  // 战利品面板是键盘驱动的侧边抽屉，打开时**不**释放指针锁定 —— 玩家仍能转动视角、保持战斗姿态，
  // 这正是"搜物资时被迫切到自由鼠标、体验很差"的根因。只有背包（需要鼠标精细操作）才释放锁定。
  return !ui.isBackpackOpen();
}

/** 面板打开时清空移动与开火，避免松开鼠标后角色还在走 */
function clearMovementKeys() {
  input.up = false;
  input.down = false;
  input.left = false;
  input.right = false;
  input.sprint = false;
  input.fire = false;
}

/**
 * 开关背包面板（键盘 Tab 与触屏「背包」按钮共用同一条路径，行为完全一致）。
 * @returns {void}
 */
function toggleBackpack() {
  if (!world || world.over) return;
  if (ui.isBackpackOpen()) {
    ui.closeBackpack();
    syncPointerLock();
  } else {
    ui.openBackpack(world.player.inventory, world.player.weightLimit);
    clearMovementKeys();
    syncPointerLock();
  }
  updateTouchState();
}

/**
 * 把实际的指针锁定状态对齐到 wantsMouseLock()。
 * 幂等，可在任何可能改变输入模式的时机调用（进战、暂停、开关面板、点击画布）。
 * @returns {void}
 */
function syncPointerLock() {
  if (!mouseLook) return;
  if (wantsMouseLock()) {
    if (!input.locked) mouseLook.requestLock();
  } else if (input.locked) {
    mouseLook.exitLock();
  }
}

/**
 * 战利品面板打开时的键盘操作。鼠标保持锁定，玩家用键盘完成拾取，不脱离战斗姿态。
 * @param {string} key 已小写化的按键
 * @param {KeyboardEvent} ev 原始事件（用于 preventDefault）
 * @returns {void}
 */
function handleLootKeys(key, ev) {
  switch (key) {
    case 'arrowup':
      ev.preventDefault();
      ui.moveLootSel(-1);
      break;
    case 'arrowdown':
      ev.preventDefault();
      ui.moveLootSel(1);
      break;
    case ' ':
    case 'enter':
      ev.preventDefault();
      takeLootItem(ui.lootSelUid());
      break;
    case 'g':
      ev.preventDefault();
      takeAllLoot();
      break;
    case 'e':
    case 'escape':
    case 'tab':
      ev.preventDefault();
      ui.closeLoot();
      openContainer = null;
      break;
    default:
      break;
  }
}

/** 更新暂停面板里的"鼠标水平反转"按钮文案 */
function updateInvertLabel() {
  const btn = document.querySelector('[data-role="invert-toggle"]');
  if (btn) btn.textContent = save.settings.invertMouseX ? '鼠标水平轴：反转' : '鼠标水平轴：正常';
}
function updateAimAssistLabel() {
  const btn = document.querySelector('[data-role="aim-toggle"]');
  if (btn) btn.textContent = save.settings.aimAssist ? '辅助瞄准：开' : '辅助瞄准：关';
}

/* ============================ 战局世界 ============================ */

/**
 * 合约达成：入账奖励与评分，并给出提示。
 * 进度规则本身在 contracts.js（纯逻辑、可单测），这里只负责发钱发分与提示。
 * @param {object} w 战局
 * @param {object} c 合约
 * @returns {void}
 */
function completeContract(w, c) {
  c.done = true;
  c.progress = c.target;
  w.contractsDone = (w.contractsDone || 0) + 1;
  w.scoreBonus += c.score;
  if (c.reward > 0) {
    save.currency += c.reward;
    Storage.saveGame(save);
  }
  ui.toast(`合约达成 · ${c.name}${c.reward > 0 ? ` · +${money(c.reward)}` : ''}`);
  if (audio && audio.cash) audio.cash();
}

function createWorld(map, seed, rng, player, enemies) {
  const w = {
    seed,
    map,
    rng,
    player,
    enemies,
    time: 0,
    timeLeft: MATCH.duration,
    kills: 0,
    searchedCount: 0,
    particles: [],
    damageNumbers: [],
    killFeed: [],
    tracers: [],
    shells: [],
    decals: [],
    explored: new Uint8Array(map.cols * map.rows),
    hitMarker: 0,
    shake: 0,
    over: false,
    result: null,
    terminalsHacked: 0,
    cratesBroken: 0,
    items: [], // 地面掉落物：{ uid, id, name, def, qty, x, y, taken }
    itemsSpawned: 0, // 仅用于生成稳定的 uid
    scoreBonus: 0,
    extractFeePaid: 0,
    contracts: pickContracts(rng),
    contractsDone: 0,
    audio,
    exploreTimer: 0,
    extractsOpened: false, // 撤离通道是否在最后 2 分钟开启（只触发一次）
    get carriedValue() {
      return player.carriedValue;
    },
    toast(message) {
      ui.toast(message);
    },
    emitNoise(x, y, radius) {
      for (const e of enemies) {
        if (e.dead) continue;
        e.hearNoise(w, x, y, radius);
      }
    },
    alertNearby(source, x, y, radius) {
      for (const e of enemies) {
        if (e === source || e.dead) continue;
        if (Math.hypot(e.x - x, e.y - y) <= radius) e.onAllyAlert(w, x, y);
      }
    },
    addDamageNumber(x, y, text, color, height) {
      w.damageNumbers.push({ x, y, text: String(text), color, t: 0, life: 0.85, size: 15, h: height });
      if (w.damageNumbers.length > 70) w.damageNumbers.shift();
    },
    /**
     * 击杀信息流：由 combat.js applyDamage 在目标死亡时调用（同时持有受害者与击杀者）。
     * 玩家显示为「你」，敌人按 ENEMY_TYPES 取中文名；source 为空时归因为环境。
     */
    addKill(victim, killer) {
      const nameOf = (e) => {
        if (!e) return '环境';
        if (e.isPlayer) return '你';
        const def = ENEMY_TYPES[e.typeId];
        return (def && def.name) || '敌人';
      };
      const wdef = killer && killer.currentWeapon ? killer.currentWeapon.def : null;
      w.killFeed.push({
        killer: nameOf(killer),
        victim: nameOf(victim),
        weapon: wdef ? (wdef.short || wdef.name || '') : '',
        byPlayer: !!(killer && killer.isPlayer),
        ofPlayer: !!(victim && victim.isPlayer),
        t: 0,
      });
      if (w.killFeed.length > KILLFEED.max) w.killFeed.shift();
    },
    spawnBlood(x, y, angle, count, height) {
      for (let i = 0; i < count; i += 1) {
        const a = angle + w.rng.float(-0.9, 0.9);
        const sp = w.rng.float(40, 170);
        w.particles.push({
          x, y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          t: 0, life: w.rng.float(0.25, 0.6), size: w.rng.float(1.4, 3),
          color: 'rgba(178,32,32,ALPHA)',
          h: height,
        });
      }
      if (w.particles.length > 320) w.particles.splice(0, w.particles.length - 320);
    },
    spawnImpact(x, y, angle, height) {
      for (let i = 0; i < 5; i += 1) {
        const a = angle + Math.PI + w.rng.float(-1, 1);
        const sp = w.rng.float(30, 120);
        w.particles.push({
          x, y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          t: 0, life: w.rng.float(0.15, 0.35), size: w.rng.float(1, 2.2),
          color: 'rgba(210,200,170,ALPHA)',
          h: height,
        });
      }
      if (audio) audio.impact();
    },
    /**
     * 跳弹火花：子弹打在硬表面（墙 / 箱）上溅起的明亮火星。
     * 比 spawnImpact 的尘土更"炽热"——白热与橙红交替、初速更快、带向上的竖直弹跳（vh），
     * 渲染层按命中高度 h 放置，于是火星会沿墙面/箱顶真实地向上迸溅再落下。
     * @param {number} x 世界 x
     * @param {number} y 世界 y
     * @param {number} angle 子弹水平入射角（弧度）
     * @param {number} height 命中高度（场景单位）
     * @returns {void}
     */
    spawnSpark(x, y, angle, height) {
      const n = 9 + Math.floor(w.rng.float(0, 6));
      for (let i = 0; i < n; i += 1) {
        // 反弹方向以"朝射手反向"为主、带大角度散射，模拟弹道折返溅射
        const a = angle + Math.PI + w.rng.float(-1.15, 1.15);
        const sp = w.rng.float(70, 230);
        w.particles.push({
          x, y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          // 竖直弹跳（场景单位/秒）：火星向上迸起后受重力回落
          vh: w.rng.float(50, 190) * (0.35 + w.rng.float(0, 1)),
          t: 0, life: w.rng.float(0.12, 0.34), size: w.rng.float(0.5, 1.5),
          color: w.rng.float(0, 1) < 0.5 ? 'rgba(255,242,205,ALPHA)' : 'rgba(255,150,55,ALPHA)',
          h: height,
        });
      }
      if (audio) audio.impact();
    },
    shakeCamera(amount) {
      w.shake = Math.min(16, w.shake + amount);
    },
    containerSearchTime(container) {
      return CONTAINERS[container.type].searchTime;
    },
    onSearchComplete(container) {
      container.searched = true;
      w.searchedCount += 1;
      if (audio) audio.searchDone();
      if (container.loot && container.loot.length) {
        openContainer = container;
        // 打开战利品面板但**不**释放指针锁定：面板是键盘驱动侧边抽屉，
        // 玩家保持锁定状态、可继续转动视角，避免"搜物资被切身切自由鼠标"的割裂感。
        ui.openLoot(container, container.loot);
        clearMovementKeys();
      } else {
        ui.toast('什么都没找到');
      }
    },
    openLootPanel(container) {
      openContainer = container;
      ui.openLoot(container, container.loot || []);
      clearMovementKeys();
    },
    canAffordExtract(point) {
      if (!point || point.kind !== 'paid') return true;
      const cost = point.cost || MATCH.extractFee;
      if (save.currency >= cost) return true;
      ui.toast(`资金不足：该撤离点需支付 ${money(cost)}`);
      if (audio) audio.error();
      return false;
    },
    onTerminalComplete(terminal) {
      if (!terminal || terminal.hacked) return;
      terminal.hacked = true;
      w.terminalsHacked += 1;
      w.scoreBonus += SCORING.terminalBonus;
      save.currency += POI.terminalReward;
      Storage.saveGame(save);
      ui.toast(`终端破解成功 · 情报费 +${money(POI.terminalReward)}`);
      if (audio) audio.searchDone();
    },
    onExtract(point) {
      if (point && point.kind === 'paid') {
        const cost = point.cost || MATCH.extractFee;
        save.currency = Math.max(0, save.currency - cost);
        w.extractFeePaid = cost;
      }
      endRaid('extract');
    },
    onDeath(entity) {
      if (entity.isPlayer) return; // 玩家死亡由主循环统一结算
      w.kills += 1;
      if (audio) audio.death();
      w.decals.push({
        x: entity.x, y: entity.y, r: 15 + w.rng.float(0, 9), life: 1, maxLife: 1,
      });
      w.spawnBlood(entity.x, entity.y, w.rng.float(0, Math.PI * 2), 16);
      const body = {
        id: w.map.containers.length,
        type: 'body',
        x: Math.round(entity.x),
        y: Math.round(entity.y),
        r: CONTAINERS.body.radius,
        searched: false,
        loot: Loot.rollEnemyLoot(entity.typeId, w.rng),
      };
      w.map.containers.push(body);
    },
  };
  return w;
}

/* ============================ 界面切换 ============================ */

function go(name) {
  screen = name;
  ui.show(name);
  canvas.classList.toggle('active', name === 'battle' || name === 'result');
  // 离开战斗（回菜单 / 结算 / 暂停）：释放全屏与方向锁定，避免手机卡在全屏里
  if (name !== 'battle') exitMobileFullscreen();
  if (name !== 'battle' && mouseLook) mouseLook.exitLock();
  if (name === 'menu') ui.renderMenu(save);
  if (name !== 'battle') {
    ui.closeBattlePanels();
    openContainer = null;
  }
  // 进战（来自"部署"点击，属于用户手势）立即抢指针锁定，视角/右键立刻可用；
  // 离开战斗则释放，把鼠标还给菜单。
  syncPointerLock();
}

function setPaused(value) {
  if (screen !== 'battle' || !world || world.over) return;
  paused = value;
  if (paused) {
    ui.show('pause');
    updateInvertLabel();
    if (ui.updateFovLabel) ui.updateFovLabel(save.settings.fov);
    if (ui.updateSensLabel) ui.updateSensLabel(save.settings.mouseSens);
    if (ui.updateTouchSensLabel) ui.updateTouchSensLabel(save.settings.touchLookSens || 1);
    input.fire = false;
    input.firePressed = false;
    input.up = false;
    input.down = false;
    input.left = false;
    input.right = false;
  } else {
    ui.show('battle');
    lastTs = 0;
  }
  // 暂停 → 释放鼠标（让玩家能点面板按钮）；恢复 → 重新抢回锁定。
  // 从暂停恢复尤其关键：浏览器在 Esc 时已经自动解除了锁定，不补一次就会出现
  // "键盘能动、鼠标转不了视角"的半失效状态。
  syncPointerLock();
}

/* ============================ 局外：商店与配置 ============================ */

function refreshLoadout() {
  Storage.ensureMinimumKit(save);
  ui.renderLoadout(save);
}

function deploy() {
  // 手机端：在用户手势内请求全屏 + 锁横屏（iOS 不支持锁定时会静默降级为旋转提示）
  enterMobileFullscreen();
  const problems = ui.validateLoadout(save);
  if (problems.length) {
    ui.toast(problems[0]);
    audio.error();
    return;
  }
  const lo = save.loadout;
  const weapons = [lo.primary, lo.secondary].filter((id) => id && WEAPONS[id]);
  for (const id of weapons) consumeById(save.stash, id, 1);
  if (lo.armor && lo.armor !== 'none' && ARMORS[lo.armor]) consumeById(save.stash, lo.armor, 1);
  consumeById(save.stash, 'ammo556', (lo.ammo556Boxes || 0) * AMMO_STACK);
  consumeById(save.stash, 'ammo9mm', (lo.ammo9mmBoxes || 0) * AMMO_STACK);
  consumeById(save.stash, 'medkit', lo.medkits || 0);
  consumeById(save.stash, 'bandage', lo.bandages || 0);
  Storage.saveGame(save);
  startRaid(ui.getSeed());
}

function buy(id) {
  const def = ITEMS[id];
  if (!def) return;
  if (save.currency < def.value) {
    ui.toast('资金不足');
    audio.error();
    return;
  }
  const item = createItem(def, def.stack || 1);
  if (!hasSpace(save.stash, item)) {
    ui.toast('仓库空间不足');
    audio.error();
    return;
  }
  save.currency -= def.value;
  autoPlace(save.stash, item);
  Storage.saveGame(save);
  ui.renderShop(save);
  audio.cash();
  ui.toast(`已购买 ${def.name}`);
}

function sell(uid) {
  const item = save.stash.items.find((it) => it.uid === uid);
  if (!item) return;
  const price = Math.round(item.value * item.qty * SHOP.sellRatio);
  removeItemByUid(save.stash, uid);
  save.currency += price;
  Storage.saveGame(save);
  ui.renderShop(save);
  ui.renderStash(save);
  audio.cash();
  ui.toast(`出售 ${item.name} ×${item.qty} → ${money(price)}`);
}

function sellAll() {
  const items = save.stash.items.slice();
  if (!items.length) {
    ui.toast('仓库里没有可出售的物资');
    return;
  }
  let gained = 0;
  for (const item of items) gained += Math.round(item.value * item.qty * SHOP.sellRatio);
  save.stash.items.length = 0;
  save.currency += gained;
  Storage.saveGame(save);
  ui.renderStash(save);
  ui.renderShop(save);
  audio.cash();
  ui.toast(`全部出售完毕 → ${money(gained)}`);
}

/* ============================ 战局生命周期 ============================ */

function startRaid(seedInput) {
  const seed = seedInput && seedInput > 0 ? (Number(seedInput) >>> 0) : randomSeed();
  const map = generateMap(seed);
  const rng = createRng((seed ^ 0x9e3779b9) >>> 0);

  for (const container of map.containers) {
    container.searched = false;
    container.loot = Loot.rollContainer(container.type, rng);
  }

  const lo = save.loadout;
  const defs = [lo.primary, lo.secondary]
    .filter((id) => id && WEAPONS[id])
    .map((id) => WEAPONS[id]);
  const armorDef = ARMORS[lo.armor] || ARMORS.none;
  const player = new Player({
    x: map.playerSpawn.x,
    y: map.playerSpawn.y,
    armorDef,
    weaponDefs: defs.length ? defs : [WEAPONS.pistol],
    items: buildLoadoutItems(lo),
  });
  const enemies = spawnEnemies(map, rng);

  world = createWorld(map, seed, rng, player, enemies);
  openContainer = null;
  paused = false;
  input.fire = false;
  input.firePressed = false;
  input.ads = false; // 进战不默认开镜（右键点击切换）
  input.aim.x = player.x + 60;
  input.aim.y = player.y;

  go('battle');
  audio.ensure();
  if (audio.startAmbient) audio.startAmbient();
  ui.toast(`已部署 · 种子 ${seed} · ${map.extracts.length} 个撤离点（最后 2 分钟开放）`);
}

function endRaid(reason) {
  if (!world || world.over) return;
  world.over = true;
  if (audio && audio.stopAmbient) audio.stopAmbient();
  ui.closeBattlePanels();
  input.fire = false;

  const player = world.player;
  const success = reason === 'extract';

  const carried = player.inventory.items.slice();
  const gear = [];
  if (player.armorDef && player.armorDef.id !== 'none' && ITEMS[player.armorDef.id]) {
    gear.push(createItem(ITEMS[player.armorDef.id], 1));
  }
  for (const weapon of player.weapons) {
    if (ITEMS[weapon.def.id]) gear.push(createItem(ITEMS[weapon.def.id], 1));
  }

  const broughtOut = success ? carried.concat(gear) : [];
  const lost = success ? [] : carried.concat(gear);
  const lootValue = Loot.valueOf(broughtOut);
  // 「高价值撤离」类合约：只有真正撤离成功才结算（带出估值达标即达成）
  if (success) settleExtractContracts(world, lootValue, (c) => completeContract(world, c));

  if (success) {
    let overflow = 0;
    for (const item of broughtOut) {
      if (autoPlace(save.stash, item)) continue;
      overflow += Math.round(item.value * item.qty * SHOP.sellRatio);
    }
    if (overflow > 0) {
      save.currency += overflow;
      ui.toast(`仓库已满，溢出物资自动折现 ${money(overflow)}`);
    }
    if (audio) audio.extract();
  } else {
    if (audio) audio.death();
  }

  // 统计
  const survived = Math.min(MATCH.duration, world.time);
  const accuracy = player.shotsFired ? Math.round((player.hits / player.shotsFired) * 100) : 0;
  const score = Math.round(
    lootValue * SCORING.lootPerPoint
    + world.kills * SCORING.killPoints
    + world.searchedCount * SCORING.searchPoints
    + (success ? SCORING.extractBonus : 0)
    + survived * SCORING.survivalPerSecond
    + (world.scoreBonus || 0),
  );
  const rating = SCORING.ratings.find((r) => score >= r.min) || SCORING.ratings[SCORING.ratings.length - 1];

  save.stats.raids += 1;
  if (success) save.stats.extracts += 1;
  else save.stats.deaths += 1;
  save.stats.kills += world.kills;
  save.stats.bestScore = Math.max(save.stats.bestScore, score);
  save.stats.bestValue = Math.max(save.stats.bestValue, lootValue);
  Storage.saveGame(save);
  Storage.ensureMinimumKit(save);

  const titles = {
    extract: { title: '撤离成功', subtitle: '你活着把东西带了出来。', ok: true },
    dead: { title: '阵亡', subtitle: '你倒在了战区里，随身物资全部丢失。', ok: false },
    timeout: { title: '超时未撤离', subtitle: '撤离窗口关闭，你被留在了战区。', ok: false },
    abandon: { title: '放弃战局', subtitle: '你主动放弃了这次突袭。', ok: false },
  };
  const info = titles[reason] || titles.dead;

  const stats = [
    ['存活时长', formatTime(survived)],
    ['击杀', String(world.kills)],
    ['搜索容器', String(world.searchedCount)],
    ['物资总值', money(success ? lootValue : Loot.valueOf(lost))],
    ['命中率', `${accuracy}%`],
    ['总负重', `${totalWeight(player.inventory).toFixed(1)} kg`],
    ['破解终端', String(world.terminalsHacked)],
  ];
  if (world.extractFeePaid > 0) {
    stats.push(['撤离手续费', money(world.extractFeePaid)]);
  }
  stats.push(['评分', String(score)]);

  ui.renderResult({
    success: info.ok,
    title: info.title,
    subtitle: info.subtitle,
    grade: rating.grade,
    lootTitle: success ? '带出物资' : '损失清单',
    emptyText: success ? '这次什么都没带出来。' : '没有可损失的物资。',
    items: success ? broughtOut : lost,
    stats,
  });
  world.result = reason;
  go('result');
}

/* ============================ 战利品拾取 ============================ */

function takeLootItem(uid) {
  if (!world || !openContainer) return;
  const list = openContainer.loot || [];
  const idx = list.findIndex((it) => it.uid === uid);
  if (idx < 0) return;
  const item = list[idx];
  if (!hasSpace(world.player.inventory, item)) {
    ui.toast('背包空间不足');
    audio.error();
    return;
  }
  autoPlace(world.player.inventory, item);
  list.splice(idx, 1);
  audio.pickup();
  if (list.length) ui.refreshLoot();
  else ui.closeLoot();
}

function takeAllLoot() {
  if (!world || !openContainer) return;
  const list = (openContainer.loot || []).slice();
  let taken = 0;
  for (const item of list) {
    if (!hasSpace(world.player.inventory, item)) continue;
    autoPlace(world.player.inventory, item);
    const idx = openContainer.loot.indexOf(item);
    if (idx >= 0) openContainer.loot.splice(idx, 1);
    taken += 1;
  }
  if (taken) audio.pickup();
  if (!openContainer.loot.length) {
    ui.closeLoot();
    ui.toast(`拾取 ${taken} 件`);
  } else {
    ui.toast(`拾取 ${taken} 件，剩余空间不足`);
    ui.refreshLoot();
  }
}

/**
 * 把一件地面掉落物放进战局（丢弃 / 敌人掉落都走这里）。
 * 落点稍微偏开玩家脚下，避免和"按 E 交互"的判定重叠成一团。
 * @param {object} item 物品（来自 inventory）
 * @param {number} x 世界 x
 * @param {number} y 世界 y
 * @returns {object} 地面掉落物
 */
function spawnGroundItem(item, x, y) {
  const a = Math.random() * Math.PI * 2;
  const d = 26;
  const drop = {
    ...item,
    x: Math.max(8, Math.min(world.map.width - 8, x + Math.cos(a) * d)),
    y: Math.max(8, Math.min(world.map.height - 8, y + Math.sin(a) * d)),
    taken: false,
  };
  world.items.push(drop);
  return drop;
}

function dropItem(uid) {
  if (!world) return;
  const item = world.player.dropItem(uid);
  if (!item) return;
  // 丢弃不是销毁：物品落到脚下拾取范围内，原地按 E 即可捡回
  spawnGroundItem(item, world.player.x, world.player.y);
  ui.toast(`已丢弃 ${item.name}（按 E 拾回）`);
  audio.ui(0.4);
  ui.openBackpack(world.player.inventory, world.player.weightLimit);
}

/* ============================ 每帧更新 ============================ */

function updateAim() {
  // 第一人称：瞄准方向由玩家角度（=yaw）决定，aim 点仅作兼容用途
  const p = world.player;
  const dist = 60;
  input.aim.x = p.x + Math.cos(p.angle) * dist;
  input.aim.y = p.y + Math.sin(p.angle) * dist;
}

function updateExplored(dt) {
  const w = world;
  w.exploreTimer -= dt;
  if (w.exploreTimer > 0) return;
  w.exploreTimer = 0.12;
  const player = w.player;
  const tx = Math.floor(player.x / TILE);
  const ty = Math.floor(player.y / TILE);
  const radius = 8;
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (dx * dx + dy * dy > radius * radius) continue;
      const x = tx + dx;
      const y = ty + dy;
      if (x < 0 || y < 0 || x >= w.map.cols || y >= w.map.rows) continue;
      const i = y * w.map.cols + x;
      if (w.explored[i]) continue;
      if (hasLineOfSight(w.map, player.x, player.y, x * TILE + TILE / 2, y * TILE + TILE / 2)) {
        w.explored[i] = 1;
      }
    }
  }
}

function updateEffects(dt) {
  const w = world;
  for (let i = w.particles.length - 1; i >= 0; i -= 1) {
    const p = w.particles[i];
    p.t += dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= 0.9;
    p.vy *= 0.9;
    // 带竖直速度的粒子（火星/火花）做重力积分；地面轻反弹。无 vh 的粒子（血/尘）不受影响。
    if (p.vh != null) {
      let h = (p.h != null) ? p.h : 0;
      h += p.vh * dt;
      p.vh -= 200 * dt; // 重力（场景单位/秒²）
      if (h <= 0) { h = 0; p.vh *= -0.25; }
      p.h = h;
    }
    if (p.t >= p.life) w.particles.splice(i, 1);
  }
  for (let i = w.tracers.length - 1; i >= 0; i -= 1) {
    const t = w.tracers[i];
    t.t += dt;
    if (t.t >= t.life) w.tracers.splice(i, 1);
  }
  for (let i = w.shells.length - 1; i >= 0; i -= 1) {
    const s = w.shells[i];
    s.t += dt;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.vx *= 0.86;
    s.vy *= 0.86;
    s.rot += s.vr * dt;
    if (s.t >= s.life) w.shells.splice(i, 1);
  }
  for (let i = w.damageNumbers.length - 1; i >= 0; i -= 1) {
    const d = w.damageNumbers[i];
    d.t += dt;
    if (d.t >= d.life) w.damageNumbers.splice(i, 1);
  }
}

/** 推进击杀信息流的存活时间，过期的条目直接移除（渲染层只负责画，不负责淘汰）。 */
function updateKillFeed(dt) {
  const w = world;
  if (!w || !w.killFeed || !w.killFeed.length) return;
  for (const k of w.killFeed) k.t += dt;
  w.killFeed = w.killFeed.filter((k) => k.t < KILLFEED.life);
}

/**
 * 环境氛围：按「处于交战状态的敌人数」调节紧张层；
 * 并在玩家自己没卷入交火时，偶发补一声远处枪声，让地图听起来是活的。
 */
function updateAmbient(dt) {
  const w = world;
  if (!w || !audio) return;
  let engaged = 0;
  for (const e of w.enemies) {
    if (!e.dead && e.state === 'COMBAT') engaged += 1;
  }
  if (audio.setCombatIntensity) audio.setCombatIntensity(Math.min(1, engaged / 4));
  // 首次进入给一个随机延迟，避免一部署就立刻来一发远处枪声
  if (w.ambientShotTimer == null) w.ambientShotTimer = w.rng.float(4, 12);
  w.ambientShotTimer -= dt;
  if (w.ambientShotTimer <= 0) {
    w.ambientShotTimer = w.rng.float(7, 18);
    if (engaged === 0 && audio.distantShot) audio.distantShot();
  }
}

function updateAirdrop(w) {
  const a = w.map.airdrop;
  if (!a || a.landed) return;
  if (w.time < a.delay) return;
  a.landed = true;
  w.map.containers.push({
    id: `airdrop-${w.seed}`,
    type: 'airdrop',
    x: Math.round(a.x), y: Math.round(a.y),
    r: CONTAINERS.airdrop.radius,
    searched: false,
    loot: Loot.rollContainer('airdrop', w.rng),
  });
    ui.toast('空投已着陆！前往标记点夺取高级物资');
    if (audio) {
      if (audio.airdrop) audio.airdrop();
      else audio.searchDone();
    }
}

function update(dt) {
  const w = world;
  if (!w || w.over) return;

  w.time += dt;
  w.timeLeft = Math.max(0, MATCH.duration - w.time);
  w.hitMarker = Math.max(0, w.hitMarker - dt);
  updateAirdrop(w);

  w.player.update(dt, input, w);
  for (const enemy of w.enemies) enemy.update(dt, w);
  updateEffects(dt);
  updateKillFeed(dt);
  updateAmbient(dt);
  updateContracts(w, (c) => completeContract(w, c));
  updateExplored(dt);
  input.firePressed = false;

  // 撤离通道仅在「最后 2 分钟」开启：站定 extractChannel 秒即可撤离，窗口压在局末。
  if (!w.extractsOpened && w.timeLeft <= MATCH.extractOpenAt && w.timeLeft > 0) {
    w.extractsOpened = true;
    for (const ex of w.map.extracts) ex.open = true;
    ui.toast(`撤离通道已开启！最后冲刺，站定 ${MATCH.extractChannel} 秒撤离`);
    if (audio && audio.warn) audio.warn();
  }

  if (!w.over) {
    if (w.player.dead) endRaid('dead');
    else if (w.timeLeft <= 0) endRaid('timeout');
  }
}

function frame(ts) {
  window.requestAnimationFrame(frame);
  const dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0.016;
  lastTs = ts;

  // 手机端每帧对齐触屏控制的激活状态（面板开关 / 横竖屏切换都由它统一收敛）
  if (touchMode) updateTouchState();

  if (screen === 'battle' && world && !paused) {
    updateAim();
    update(dt);
  }

  if ((screen === 'battle' || screen === 'result') && world) {
    renderer.render(world, dt, false);
    ui.renderHud(world, dt, paused || screen === 'result');
  }

  // 该锁定却没锁定 → 明确提示玩家点画面恢复，而不是让他们以为输入坏了
  ui.setLockHint(wantsMouseLock() && !input.locked);
}

/* ============================ UI 动作 ============================ */

const ui = createUI(uiRoot, {
  'goto-menu': () => go('menu'),
  'goto-loadout': () => {
    refreshLoadout();
    go('loadout');
  },
  'goto-stash': () => {
    ui.renderStash(save);
    go('stash');
  },
  'goto-shop': () => {
    ui.renderShop(save);
    go('shop');
  },
  'goto-howto': () => go('howto'),
  deploy,
  'set-loadout': (data) => {
    const slot = data.slot;
    save.loadout[slot] = data.value === '' ? null : data.value;
    Storage.saveGame(save);
    ui.renderLoadout(save);
    audio.ui();
  },
  'step-loadout': (data) => {
    const kind = data.kind;
    const delta = Number(data.delta) || 0;
    const next = Math.max(0, Math.min(6, (save.loadout[kind] || 0) + delta));
    save.loadout[kind] = next;
    Storage.saveGame(save);
    ui.renderLoadout(save);
    audio.ui(0.4);
  },
  buy: (data) => buy(data.id),
  sell: (data) => sell(data.uid),
  'sell-all': sellAll,
  'result-stash': () => {
    ui.renderStash(save);
    go('stash');
  },
  'result-again': () => {
    refreshLoadout();
    go('loadout');
  },
  resume: () => setPaused(false),
  abandon: () => {
    if (!world) return;
    paused = false;
    world.player.hp = 0;
    world.player.dead = true;
    endRaid('abandon');
  },
  'loot-take': (data) => takeLootItem(data.uid),
  'loot-take-all': takeAllLoot,
  'loot-close': () => {
    ui.closeLoot();
    openContainer = null;
  },
  'backpack-close': () => {
    ui.closeBackpack();
    syncPointerLock();
  },
  drop: (data) => dropItem(data.uid),
  'use-item': (data) => {
    if (!world || world.over || !world.player) return;
    const item = world.player.inventory.items.find((it) => it.uid === data.uid);
    if (!item || item.category !== 'consumable') return;
    if (world.player.busy) {
      ui.toast('正在读条，无法使用');
      return;
    }
    world.player.heal = {
      uid: item.uid, progress: 0, total: item.useTime || 1.5, def: ITEMS[item.id] || item,
    };
    if (world.audio) world.audio.ui(0.4);
    ui.toast(`开始使用 ${item.name}`);
  },
  'toggle-invert': () => {
    save.settings.invertMouseX = !save.settings.invertMouseX;
    input.invertMouseX = save.settings.invertMouseX;
    Storage.saveGame(save);
    updateInvertLabel();
    ui.toast(save.settings.invertMouseX ? '鼠标水平轴：反转' : '鼠标水平轴：正常');
  },
  'set-fov': (data) => {
    const v = Math.max(60, Math.min(100, Number(data.value) || 75));
    save.settings.fov = v;
    if (renderer && 'baseFov' in renderer) renderer.baseFov = v;
    Storage.saveGame(save);
    if (ui.updateFovLabel) ui.updateFovLabel(v);
  },
  'set-sens': (data) => {
    const v = Math.max(0.3, Math.min(3, Number(data.value) || 1));
    save.settings.mouseSens = v;
    input.sensitivityMul = v;
    Storage.saveGame(save);
    if (ui.updateSensLabel) ui.updateSensLabel(v);
  },
  // 触屏灵敏度（暂停面板里调）。玩家反馈"暂停后没法调灵敏度"，
  // 所以必须能在暂停状态下改，而不是只能靠局内那个一闪而过的循环按钮。
  'set-touch-sens': (data) => {
    const v = Math.max(0.3, Math.min(2, Number(data.value) || 1));
    save.settings.touchLookSens = v;
    input.touchLookSens = v;
    if (touchControls) touchControls.setLookSens(v);
    Storage.saveGame(save);
    if (ui.updateTouchSensLabel) ui.updateTouchSensLabel(v);
  },
  'toggle-mute': () => {
    const muted = audio.toggleMute();
    save.settings.muted = muted;
    Storage.saveGame(save);
    ui.toast(muted ? '已静音' : '已开启音效');
  },
  // 轻度辅助瞄准：把设置写入 COMBAT.aimAssist.enabled（combat.js 开火时读取）
  'toggle-aim-assist': () => {
    save.settings.aimAssist = !save.settings.aimAssist;
    COMBAT.aimAssist.enabled = save.settings.aimAssist;
    Storage.saveGame(save);
    updateAimAssistLabel();
    ui.toast(save.settings.aimAssist ? '辅助瞄准：开' : '辅助瞄准：关');
  },
  // 触控按钮尺寸：0.8~1.3 倍率，实时应用到触屏控件
  'set-button-scale': (data) => {
    const v = Math.max(0.8, Math.min(1.3, Number(data.value) || 1));
    save.settings.touchButtonScale = v;
    if (touchControls) touchControls.setButtonScale(v);
    Storage.saveGame(save);
    if (ui.updateButtonScaleLabel) ui.updateButtonScaleLabel(v);
  },
  // 触屏按钮布局：拖动结束时由触屏控件回调此处持久化偏移
  'set-layout': (data) => {
    save.layout.touch = data || {};
    Storage.saveGame(save);
  },
  'reset-layout': () => {
    save.layout.touch = {};
    if (touchControls) touchControls.resetLayout();
    Storage.saveGame(save);
    ui.toast('按钮布局已重置');
  },
  // 进入/退出按钮布局编辑（触屏）。编辑时退出暂停，否则浮层会盖住按钮无法拖动。
  'edit-layout': () => {
    if (!touchControls) return;
    const editing = touchControls.toggleEditLayout();
    if (editing && paused) setPaused(false);
    const btn = document.querySelector('[data-role="edit-layout-btn"]');
    if (btn) btn.textContent = editing ? '完成编辑（游戏中拖动按钮）' : '编辑按钮布局';
  },
  'reset-save': () => {
    save = Storage.resetSave();
    ui.renderMenu(save);
    ui.toast('存档已清空');
  },
});

/* ============================ 输入 ============================ */

window.addEventListener('pointerdown', () => audio.ensure(), { once: true });

canvas.addEventListener('mousedown', (ev) => {
  if (ev.button !== 0) return;
  // 手机端跳过：开火由虚拟按钮负责，避免触摸合成的 mousedown 造成"一进场就走火"。
  // 注意必须在最前面拦截 —— 真机上点一下屏幕会同时产生 touchstart + mousedown，
  // 若不拦住，每次点开火都会顺带把游戏逻辑炸一次。
  if (touchMode) return;
  audio.ensure();
  if (screen === 'battle') {
    if (!input.locked) {
      // 这次点击只是用来夺回指针锁定（进战首帧 / 从 Alt+Tab 切回）。
      // 不算开火输入，否则"一进场 / 一切回来就走火"，符合"不要在出发就触发鼠标快捷操作"。
      syncPointerLock();
      ev.preventDefault();
      return;
    }
    ev.preventDefault();
  }
  input.fire = true;
  input.firePressed = true;
});

// 浏览器拒绝锁定（多半是 Esc 之后的限流）时给出提示，避免玩家以为"输入坏了"
document.addEventListener('pointerlockerror', () => {
  if (screen === 'battle' && !paused) ui.toast('点击画面以恢复鼠标控制');
});

window.addEventListener('mouseup', (ev) => {
  // 真机上点虚拟开火键会合成一个 mouseup：若在触屏模式仍无条件清 fire，
  // 会把"按住开火键"的持续射击打断成单发。触屏模式的开火状态只由触摸事件管。
  if (touchMode) return;
  if (ev.button === 0) input.fire = false;
});

// 战斗内抑制鼠标按键触发的系统手势：右键菜单、长按右键前进/后退、侧键（X1/X2）导航。
// 仅在 battle 屏幕拦截；菜单 / HUD 的 DOM 交互（左键等）不受影响。
const suppressMouseGesture = (ev) => {
  if (screen !== 'battle') return;
  const btn = ev.button;
  if (ev.type === 'contextmenu') { ev.preventDefault(); return; }
  if ((ev.type === 'auxclick' || ev.type === 'mousedown') && (btn === 2 || btn === 3 || btn === 4)) {
    ev.preventDefault();
  }
};
window.addEventListener('contextmenu', suppressMouseGesture);
window.addEventListener('auxclick', suppressMouseGesture);
window.addEventListener('mousedown', suppressMouseGesture);

window.addEventListener('blur', () => {
  input.up = false;
  input.down = false;
  input.left = false;
  input.right = false;
  input.fire = false;
  input.sprint = false;
  input.crouch = false;
  input.ads = false;
});

window.addEventListener('keydown', (ev) => {
  const key = ev.key.toLowerCase();
  if (screen !== 'battle') {
    if (key === 'escape' && screen !== 'menu') go('menu');
    return;
  }
  // 战利品面板打开时：键盘驱动拾取，且保持指针锁定（不切自由鼠标）。
  // 这一支要最先拦截，避免方向键/空格被当成移动或开火。
  if (ui.isLootOpen()) {
    handleLootKeys(key, ev);
    return;
  }
  switch (key) {
    case 'w': case 'arrowup': input.up = true; break;
    case 's': case 'arrowdown': input.down = true; break;
    case 'a': case 'arrowleft': input.left = true; break;
    case 'd': case 'arrowright': input.right = true; break;
    case 'shift': input.sprint = true; break;
    case 'control': input.crouch = true; break;
    case 'tab':
      ev.preventDefault();
      if (!ev.repeat) toggleBackpack();
      break;
    case 'escape':
      ev.preventDefault();
      if (!ev.repeat) {
        // Esc 优先关掉已打开的面板（浏览器已经顺带解除了指针锁定），
        // 没有面板时才进暂停 —— 否则背包/战利品会卡住关不掉。
        if (ui.isBackpackOpen() || ui.isLootOpen()) {
          ui.closeBattlePanels();
          openContainer = null;
          syncPointerLock();
        } else {
          setPaused(!paused);
        }
      }
      break;
    case 'e':
      if (!ev.repeat && !world.player.ropelling) world.player.interact(world);
      break;
    case 'r':
      if (!ev.repeat) world.player.reload(world);
      break;
    case 'v':
      if (!ev.repeat) world.player.startRope(world);
      break;
    case 'f':
      if (!ev.repeat) {
        const p = world.player;
        if (p.vehicle) p.exitVehicle(world);
        else p.enterVehicle(world);
      }
      break;
    case 'q':
      if (!ev.repeat) world.player.useMedkit(world);
      break;
    case '1':
      if (!ev.repeat) world.player.switchWeapon(0, world);
      break;
    case '2':
      if (!ev.repeat) world.player.switchWeapon(1, world);
      break;
    case 'j':
      // 中层任务面板展开 / 收起（三层信息架构的唯一入口，与触屏「任务」钮同义）
      if (!ev.repeat) ui.toggleTasks();
      break;
    default:
      break;
  }
  if (['w', 'a', 's', 'd', ' ', 'tab', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
    ev.preventDefault();
  }
});

window.addEventListener('keyup', (ev) => {
  const key = ev.key.toLowerCase();
  switch (key) {
    case 'w': case 'arrowup': input.up = false; break;
    case 's': case 'arrowdown': input.down = false; break;
    case 'a': case 'arrowleft': input.left = false; break;
    case 'd': case 'arrowright': input.right = false; break;
    case 'shift': input.sprint = false; break;
    case 'control': input.crouch = false; break;
    default: break;
  }
});

/* ============================ 视口自适应 ============================ */

window.addEventListener('resize', () => {
  if (renderer && typeof renderer.resize === 'function') renderer.resize();
});

/* ============================ 启动 ============================ */

go('menu');
window.requestAnimationFrame(frame);

// 调试：暴露少量上下文
window.SOUDACHE = {
  get world() {
    return world;
  },
  get save() {
    return save;
  },
  get input() {
    return input;
  },
  device,
  touchMode,
  touchControls,
  updateTouchState,
  refreshTouchContext,
  startRaid,
  endRaid,
  COLORS,
  PLAYER,
  // 战斗 HUD 布局的单一真值源：tools/check-touch-layout.mjs 读它取禁区矩形，
  // 避免"实拍量取百分比"那种会漏项、会漂移的硬编码。
  hudLayout,
  // 中层任务面板的展开状态。探针需要**读到真实状态**才能验证 J 键真的切了 ——
  // 之前只能靠"按完没报错"推断，那是弱证据：按键绑错了也照样不报错。
  isTasksOpen: ui.isTasksOpen,
  toggleTasks: ui.toggleTasks,
};
