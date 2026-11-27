/**
 * 入口：游戏状态机（菜单 / 仓库 / 商店 / 战前配置 / 战斗 / 结算）与主循环
 */

import {
  TILE, MATCH, PLAYER, ITEMS, WEAPONS, ARMORS, CONTAINERS, SHOP, SCORING, COLORS,
  ENEMY_TYPES, KILLFEED, COMBAT, INSURANCE, REP, SHOP_TIER, ITEM_IDS, VIEW3D, MAPS, DEFAULT_MAP_ID,
  ABILITY, WEAPON_MOD_SLOTS, WEAPON_MODS, AMMO_IDS, CALIBERS, CAREER,
  BACKPACKS, MELEE, RIGS,
} from './config.js';
import { updateContracts, settleExtractContracts } from './contracts.js';
import {
  getRisk, DEFAULT_RISK_ID, applyRiskToEnemies, riskLootLuck, riskScore, riskPayout, riskSummary,
} from './risk.js';
import { syncBossPhase } from './boss.js';
import { createRng, randomSeed } from './rng.js';
import { generateMap, hasLineOfSight, finalizeExtractLayout } from './mapgen.js';
import {
  containerTierOf, lootLuckAt, hotspotAt, hotspotInfo, dangerLabel, spawnHint,
} from './areas.js';
import { buildObjectives, settleObjectives } from './objectives.js';
import { buildReview } from './review.js';
import {
  buildExtractPlan, modifierLabel, EXTRACT_TUNING, EXTRACT_MOD,
} from './extract.js';
import {
  createItem, createInventory, autoPlace, hasSpace, totalWeight, consumeById,
  removeItemByUid, itemValue, displayUnits, rigSizeFor,
} from './inventory.js';
import { splitCarried, SECURE_TIERS, DEFAULT_SECURE_TIER } from './secure.js';
import { gearValue } from './gear.js';
import * as Loot from './loot.js';
import { makePlayerGear, containerFromType, entityContainers } from './lootable.js';
import { Player, buildLoadoutItems } from './player.js';
import { spawnEnemies, updateEnemyGrenades } from './enemy.js';
import { decayTraces } from './perception.js';
import { spawnSquad, updateSquad } from './ally.js';
import { isWebGLAvailable, createScene3D } from './scene3d.js';
import { Renderer3D, NoopRenderer3D } from './renderer3d.js';
import { createInput, setupMouseLook } from './input.js';
import {
  createStanceState, setCrouchHold, toggleCrouch, toggleProne, releaseStanceHolds, resetStance,
} from './stance.js';
import { detectDeviceTier } from './device.js';
import { resolveGrade, clampGrade } from './grade3d.js';

import { createTouchControls } from './touch-controls.js';
import { createAudio } from './audio.js';
import { createUI, hudLayout } from './ui.js';
import { preloadHudIcons } from './icon-bitmap.js';
import { createPerfMonitor } from './perf.js';
import { createPreview, PREVIEW3D, fitDistance } from './preview3d.js';
import { VM_GLB, buildOperatorShowcase } from './models.js';
import { installPerfHud } from './perf-hud.js';
import * as Storage from './storage.js';
import { autoEquip, applyPreset, QUICK_PRESETS, planRestockLoadout } from './quickloadout.js';
import { installGuard, frameError, resetFrameStreak, clearFatal } from './guard.js';
import { applyMods, buy as purchaseUpgrade, checkBuy, getNode as getUpgradeNode } from './upgrades.js';
import { applyWeaponMods, normalizeWeaponMods, computeEffectiveWeapon, attachmentOptions, loadoutModWeight, effectiveStatsPreview } from './gunbench.js';
import {
  ammoIdsForWeapon, loadoutAmmoBoxes, ammoBoxSize, resolveAmmoGrade, normalizeLoadoutAmmo, setAmmoBoxes,
} from './ammo.js';
import { findListing } from './market.js';
import {
  settleRaidCareer, claimAchievement, claimAllAchievements, claimQuest, claimAllQuests,
  claimRepReward, claimAllRepRewards, createOrder, cancelOrder, settleOrders,
  shopRemaining, consumeShopStock,
} from './economy.js';
import {
  getOperator, createAbilityState, tickAbilities,
  canThrowTactical, consumeTactical, addUltCharge, consumeUltimate, applyOperator,
  resolveSquadIds, assignSquadSlot,
} from './operators.js';
import {
  createGrenade, updateThrowables, throwOrigin, throwableDef,
} from './throwable.js';
import { makeCreateWorld } from './world.js';
import { assetStatus } from './assets.js';

const canvas = document.getElementById('game-canvas');
const uiRoot = document.getElementById('ui-root');

const audio = createAudio();
// 设备分级：手机走 low / mid 档（降像素比 / 关阴影与后处理 / 缩短视距），桌面完全维持原画质
const device = detectDeviceTier();
const touchMode = device.isTouch;
// 粒子上限（P1-8）：逻辑裁剪与渲染缓冲都读 config 的同一项，两边不会再对不齐。
const PARTICLE_CAP = Math.max(1, VIEW3D.fx.maxParticles | 0);
const sceneHandle = isWebGLAvailable() ? createScene3D(canvas, device) : null;
const renderer = sceneHandle ? new Renderer3D(sceneHandle, canvas, device) : new NoopRenderer3D();
// V-05：性能采样器（只读观测，不改画质）。手机走 mobile 预算，桌面走 desktop。
const perfMonitor = createPerfMonitor({ budget: device.quality === 'low' || device.isTouch ? 'mobile' : 'desktop' });

let save = Storage.loadSave();
// P3：旧档没有 settings.grade 时 resolveGrade 会补齐默认值；只灌一次，
// 之后由暂停面板的 set-grade / reset-grade 增量更新，不进主循环。
const initialGrade = resolveGrade(save);
if (typeof renderer.setGrade === 'function') renderer.setGrade(initialGrade);
else if (sceneHandle && typeof sceneHandle.setGrade === 'function') sceneHandle.setGrade(initialGrade);
let world = null;
let screen = 'menu';
let paused = false;
let faulted = false; // P0-1：致命故障熔断标志，置位后主循环跳过更新与渲染，直到玩家选择恢复
let lastTs = 0;
let openContainer = null;

const input = createInput();
input.invertMouseX = save.settings.invertMouseX;
input.invertY = save.settings.invertY;
input.sensitivityMul = save.settings.mouseSens;
input.touchLookSens = save.settings.touchLookSens || 1.0;

/**
 * 蹲伏的两条来源（Ctrl 按住 / C 切换）必须先各自记账，再合成为 input.crouch，
 * 否则「按着 Ctrl 时按一下 C，松 Ctrl 就把蹲伏一起松掉」。
 * 合成规则收在 stance.js（纯逻辑、可单测），main 只负责把键位事件转成三类调用。
 */
const stanceState = createStanceState();
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
    // W2：三把枪之后不能再写死 0↔1 的来回切，改成循环（手枪也能被切到）
    case 'switch': p.switchWeapon((p.weaponIndex + 1) % Math.max(1, p.weapons.length), world); break;
    // W2：近战。独立按钮（不占开火键，避免近身缠斗时误开火暴露位置）
    case 'melee': if (!p.ropelling) p.meleeAttack(world); break;
    case 'heal': p.useMedkit(world); break;
    case 'tactical': throwTactical(); break;
    case 'ultimate': releaseUltimate(); break;
    case 'rope': p.startRope(world); break;
    case 'vehicle': if (p.vehicle) p.exitVehicle(world); else p.enterVehicle(world); break;
    case 'bag': toggleBackpack(); break;
    case 'tasks': ui.toggleTasks(); break;
    case 'pause': setPaused(!paused); break;
    // 姿态：触屏没有 Ctrl/C/Z 三个物理键，全部收敛成"请求切换"再走同一套合成逻辑。
    case 'crouch': toggleCrouch(stanceState, input); break;
    case 'prone': toggleProne(stanceState, input); break;
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
  if (p.nearestSwitch && p.nearestSwitch(world)) {
    touchControls.setContext({ text: '拉闸' });
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
  // 战利品双栏界面需要鼠标拖拽，必须把鼠标还给玩家；旧的键盘侧边抽屉仍保留给其他入口。
  // 这正是"搜物资时被迫切到自由鼠标、体验很差"的根因，双栏界面上是刻意接受的代价。
  return !ui.isBackpackOpen() && !ui.isLootGridOpen();
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

/** 更新暂停面板里的"鼠标水平反转 / 视角 Y 轴反转"按钮文案 */
function updateInvertLabel() {
  const xBtn = document.querySelector('[data-role="invert-toggle"]');
  if (xBtn) xBtn.textContent = save.settings.invertMouseX ? '鼠标水平轴：反转' : '鼠标水平轴：正常';
  const yBtn = document.querySelector('[data-role="invert-y-toggle"]');
  if (yBtn) yBtn.textContent = save.settings.invertY ? '视角Y轴：反转' : '视角Y轴：正常';
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

// P1 拆分：createWorld 已移到 world.js（工厂注入见 startRaid 内组装）。

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
  // W1：改枪台的 3D 预览只在战前屏存在；离开就释放 WebGL 上下文，别让它在后台空转。
  // W2：同一屏还挂着角色 3D（装备配置板左侧），生命周期一起管。
  if (name === 'loadout') {
    syncGunPreviews();
    syncCharPreview();
  } else {
    disposeGunPreviews();
    disposeCharPreview();
  }
}

/* ---------------- W1：改枪台 3D 预览（局外唯一一块 WebGL） ---------------- */

/**
 * 元素 → 预览控制器。
 * 必须按**元素**而不是按武器 id 记账：改枪台每次改配件都会整块重渲染，
 * 旧卡片会被摘掉、新卡片重新插入；只按 id 记账会把已经脱离文档的 canvas 当成"已挂载"，
 * 结果就是玩家改了配件却看不到模型变化。
 */
const gunPreviews = new Map();

function disposeGunPreviews() {
  for (const api of gunPreviews.values()) api.dispose();
  gunPreviews.clear();
  // 回退层要恢复可见：下次若 WebGL 不可用，线稿仍然要在
  for (const box of document.querySelectorAll('.gun-bench-preview.has3d')) {
    box.classList.remove('has3d');
  }
}

function syncGunPreviews() {
  if (typeof document === 'undefined') return;
  if (screen !== 'loadout') {
    disposeGunPreviews();
    return;
  }
  // 先回收已脱离文档的旧实例（重渲染会替换整块 DOM）
  for (const [node, api] of gunPreviews) {
    if (!node.isConnected) {
      api.dispose();
      gunPreviews.delete(node);
    }
  }
  const hosts = document.querySelectorAll('[data-role="gun-preview-3d"]');
  for (const hostEl of hosts) {
    if (gunPreviews.has(hostEl)) continue;
    const rel = VM_GLB[hostEl.dataset.weapon];
    if (!rel) continue; // 未知武器：保留线稿
    const api = createPreview(hostEl, { autoSpin: true, shadow: true });
    if (!api) continue; // 无 WebGL：保留线稿回退，不报错、不白屏
    gunPreviews.set(hostEl, api);
    api.loadModel(rel, { gain: 0.95 }).then((ok) => {
      if (!ok) return;
      // 模型就位才隐藏线稿：否则加载失败会只剩一块空台子
      const box = hostEl.closest && hostEl.closest('.gun-bench-preview');
      if (box) box.classList.add('has3d');
    });
  }
}

// ui.js 只负责渲染 DOM 并广播事件，不 import three；挂载由这里接管。
document.addEventListener('gunbench:rendered', () => syncGunPreviews());

/* ---------------- W2：装备屏角色 3D ---------------- */

/**
 * 角色台的灯光标定（**与枪台不同**，别共用一套）。
 *
 * `studioLights()` 的默认档（ambient12/hemi24/key5.5 + 曝光1.4）是给 GLB 枪模扫参扫出来的：
 * 那些材质走 `glbLambert` 时乘了 gain0.8，本身是压暗过的。程序化士兵用的是**满亮度**
 * Lambert（军服 #6A6A55、皮肤 #C8A07A），直接套同一档会被顶到 ACES 的肩部以上 ——
 * 实测整具模型冲成浅白/薄荷绿，脸和手变成粉白色块，正是"发光棉花糖"的成因。
 *
 * 这里把三件事一起调：主光压到 3.0（仍是最强光源、定明暗关系）、环境/半球砍到 1/3
 * （留暗部但不发灰）、曝光降到 1.0（不再靠曝光兜亮度）。数值是像素亮度实测选的，
 * 不是猜的：目标是人形中间调落在 0.35~0.55 区间、盔/背心暗部 ≥0.12（不糊死）。
 */
const CHAR_LIGHTS = {
  ambient: 3.6, hemi: 8.0, key: 3.8, fill: 1.0, rim: 3.0, exposure: 1.05,
};

let charPreview = null;
let charPreviewHost = null;
let charPreviewRel = '';

function disposeCharPreview() {
  if (charPreview) charPreview.dispose();
  charPreview = null;
  charPreviewHost = null;
  charPreviewRel = '';
  if (typeof document !== 'undefined') {
    for (const box of document.querySelectorAll('[data-role="char-preview"].has3d')) {
      box.classList.remove('has3d');
    }
  }
}

function syncCharPreview() {
  if (typeof document === 'undefined') return;
  if (screen !== 'loadout') { disposeCharPreview(); return; }
  const hostEl = document.querySelector('[data-role="char-preview"]');
  if (!hostEl) { disposeCharPreview(); return; }
  // 重渲染会把整块容器换掉，旧实例必须跟着宿主一起回收（否则白烧一个 WebGL context）
  if (charPreview && charPreviewHost !== hostEl) disposeCharPreview();
  if (!charPreview) {
    // targetMax 1.75：人形站姿是"最高维 = 身高"，归一化到 1.75m 后取景刚好撑满 226×190 的台子
    charPreview = createPreview(hostEl, { autoSpin: true, shadow: true, targetMax: 1.75 });
    if (!charPreview) return; // 无 WebGL：容器留空，不报错也不白屏
    if (charPreview.setLights) charPreview.setLights(CHAR_LIGHTS);
    charPreviewHost = hostEl;
    charPreviewRel = '';
  }
  const op = getOperator((save && save.operator) || 'vulcan');
  // W3：配装变化时实时换模型 —— 头盔/背包等级直接体现在 3D 人形上。
  // sig 带上这三槽，换装后 equip:rendered 事件触发重建；只换弹药不改 sig，避免无谓重建。
  const lo = (save && save.loadout) || {};
  const sig = `op:${op.id}|h:${lo.helmet || 'none'}|b:${lo.backpack || 'none'}|a:${lo.armor || 'none'}`;
  if (charPreviewRel === sig) return;
  charPreviewRel = sig;
  hostEl.classList.remove('has3d');
  // 程序化模型是同步构建的，但 setModel 会重算包围盒/取景，放到下一帧再亮 has3d 更稳
  // ⚠ yaw=π 不是随便定的：buildEnemyModel 造出来的人**面朝 -Z**（背包在 +Z），
  //   而预览相机永远站在 +Z 看原点 —— yaw=0 时展示台上是一个后脑勺对着玩家的人。
  charPreview.setModel(buildOperatorShowcase(op, {
    helmet: lo.helmet || 'none',
    backpack: lo.backpack || 'none',
    armor: lo.armor || 'none',
  }), { rel: sig, yaw: Math.PI });
  hostEl.classList.add('has3d');
  charPreview.frame(1);
}

document.addEventListener('equip:rendered', () => syncCharPreview());

function setPaused(value) {
  if (screen !== 'battle' || !world || world.over) return;
  paused = value;
  if (paused) {
    ui.show('pause');
    updateInvertLabel();
    if (ui.updateFovLabel) ui.updateFovLabel(save.settings.fov);
    if (ui.updateSensLabel) ui.updateSensLabel(save.settings.mouseSens);
    if (ui.updateTouchSensLabel) ui.updateTouchSensLabel(save.settings.touchLookSens || 1);
    if (ui.updateGradeLabels) ui.updateGradeLabels(resolveGrade(save));
    input.fire = false;
    input.firePressed = false;
    input.jumpPressed = false;
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
  // 保费要在扣装备之前算：consumeById 之后仓库里已经没有那把枪了。
  // ⚠ 口径唯一真值在 gear.js 的 gearValue()（8 槽位全覆盖），这里绝不再写第二份 ——
  // 两处各算一遍就是"UI 显示保费 ¥900、实际扣 ¥1200"这类事故的来源。
  const insured = Boolean(save.insurance && save.insurance.enabled && INSURANCE.enabled);
  if (insured) {
    const premium = Math.round(gearValue(lo) * INSURANCE.rate);
    if (premium > save.currency) {
      ui.toast(`资金不足：保费 ${money(premium)}`);
      audio.error();
      return;
    }
    save.currency -= premium;
  }
  // W2：8 个槽位逐个扣仓（含手枪 / 匕首 / 背包 / 胸挂）。
  // 与 endRaid 的 gear 回仓列表严格一一对应 —— 扣了不还 = 玩家白送，还了不扣 = 白嫖。
  for (const id of [lo.primary, lo.secondary, lo.sidearm]) {
    if (id && WEAPONS[id]) consumeById(save.stash, id, 1);
  }
  for (const [slot, table] of [['melee', MELEE], ['backpack', BACKPACKS], ['rig', RIGS]]) {
    const id = lo[slot];
    if (id && id !== 'none' && table[id]) consumeById(save.stash, id, 1);
  }
  if (lo.armor && lo.armor !== 'none' && ARMORS[lo.armor]) consumeById(save.stash, lo.armor, 1);
  if (lo.helmet && lo.helmet !== 'none' && ARMORS[lo.helmet]) consumeById(save.stash, lo.helmet, 1);
  // P7：按弹种逐项扣仓库，标准弹与 AP/亚音速/空尖各自独立
  for (const id of AMMO_IDS) {
    consumeById(save.stash, id, loadoutAmmoBoxes(lo, id) * ammoBoxSize(id));
  }
  consumeById(save.stash, 'medkit', lo.medkits || 0);
  consumeById(save.stash, 'bandage', lo.bandages || 0);
  consumeById(save.stash, 'surgery', lo.surgeries || 0);
  consumeById(save.stash, 'armorKit', lo.armorKits || 0);
  Storage.saveGame(save);
  startRaid(ui.getSeed(), { insured, mapId: ui.getMap(), riskId: save.risk });
}

function buy(id) {
  const def = ITEMS[id];
  if (!def) return;
  // P10 每日额度：旧档没有 supply 字段时由 ensureSupply 就地补默认，不影响老玩家。
  const todayStr = String(Storage.dailySeed());
  if (shopRemaining(save, id, todayStr) < 1) {
    ui.toast('今日该物资已售罄，明日自动刷新');
    audio.error();
    return;
  }
  // 声望门槛：UI 只是展示锁，判定必须在逻辑层。
  const needLv = SHOP_TIER[id] || 1;
  if (Storage.repLevel((save.rep && save.rep.xp) || 0) < needLv) {
    ui.toast(`需声望 Lv.${needLv}`);
    audio.error();
    return;
  }
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
  consumeShopStock(save, id, todayStr);
  autoPlace(save.stash, item);
  Storage.saveGame(save);
  ui.renderShop(save);
  audio.cash();
  ui.toast(`已购买 ${def.name}`);
}

/**
 * 交易行本地报价买入（P2 交互）。
 *
 * 用户明确边界：交易行目前只用于物资购买，不做共享物资总数、跨局库存账本、
 * 全局限购额度，也不往存档里写任何市场字段。报价由 market.js 用种子复算，
 * DOM 上的价格一律不信任；返回 true 时 UI 才把这张报价标成已成交（仅内存）。
 * @param {{seed:string,key:string}} data 报价种子与条目 key
 * @returns {boolean} 是否成交
 */
function buyListing(data) {
  const seed = Number(data && data.seed) >>> 0;
  const listing = findListing(seed, data && data.key);
  if (!listing) {
    ui.toast('报价已失效，请刷新');
    audio.error();
    return false;
  }
  const def = ITEMS[listing.id];
  if (!def) return false;
  const needLv = SHOP_TIER[listing.id] || 1;
  if (Storage.repLevel((save.rep && save.rep.xp) || 0) < needLv) {
    ui.toast(`需声望 Lv.${needLv}`);
    audio.error();
    return false;
  }
  if (save.currency < listing.price) {
    ui.toast('资金不足');
    audio.error();
    return false;
  }
  const item = createItem(def, def.stack || 1);
  if (!hasSpace(save.stash, item)) {
    ui.toast('仓库空间不足');
    audio.error();
    return false;
  }
  save.currency -= listing.price;
  autoPlace(save.stash, item);
  Storage.saveGame(save);
  ui.renderShop(save);
  ui.renderStash(save);
  audio.cash();
  ui.toast(`已按本地报价买入 ${def.name} · ${money(listing.price)}`);
  return true;
}

/**
 * 购买一个局外改装节点。
 *
 * UI 只负责把 canBuy/checkBuy 的结果画成锁，真正扣钱与升级必须在纯逻辑层完成；
 * 失败时 toast 出具体原因（前置未点 / 资金不足），而不是只把按钮变灰让玩家猜。
 * @param {string} nodeId 改装节点 id
 * @returns {void}
 */
function buyUpgrade(nodeId) {
  const node = getUpgradeNode(nodeId);
  if (!node) return;
  const check = checkBuy(save, nodeId);
  if (!check.ok) {
    ui.toast(check.reason);
    audio.error();
    return;
  }
  if (!purchaseUpgrade(save, nodeId)) {
    ui.toast('解锁失败，请重试');
    audio.error();
    return;
  }
  Storage.scheduleSave(save);
  ui.renderUpgrades(save);
  audio.cash();
  ui.toast(`已解锁「${node.name}」· ${node.effectText}`);
}

function sell(uid) {
  const item = save.stash.items.find((it) => it.uid === uid);
  if (!item) return;
  const price = Math.round(itemValue(item) * SHOP.sellRatio);
  removeItemByUid(save.stash, uid);
  save.currency += price;
  Storage.saveGame(save);
  ui.renderShop(save);
  ui.renderStash(save);
  audio.cash();
  const sd = displayUnits(item);
  ui.toast(`出售 ${item.name} ×${sd.count}${sd.unit} → ${money(price)}`);
}

function sellAll() {
  const items = save.stash.items.slice();
  if (!items.length) {
    ui.toast('仓库里没有可出售的物资');
    return;
  }
  let gained = 0;
  for (const item of items) gained += Math.round(itemValue(item) * SHOP.sellRatio);
  save.stash.items.length = 0;
  save.currency += gained;
  Storage.saveGame(save);
  ui.renderStash(save);
  ui.renderShop(save);
  audio.cash();
  ui.toast(`全部出售完毕 → ${money(gained)}`);
}

/* ============================ P10 局外生涯交互 ============================ */

function careerToday() {
  return String(Storage.dailySeed());
}

/** 委托单到期结算：进大厅屏、挂新单、结算前都推一次，重复调用不会二次入账。 */
function advanceOrders() {
  const settled = settleOrders(save, Date.now());
  if (settled.length) {
    Storage.saveGame(save);
    const total = settled.reduce((sum, o) => sum + Math.max(0, Number(o.price) || 0), 0);
    ui.toast(`${settled.length} 笔委托已成交 → ${money(total)}`);
  }
  return settled;
}

function listItem(uid) {
  advanceOrders();
  const res = createOrder(save, uid, Date.now(), careerToday());
  if (!res.ok) {
    ui.toast(res.reason);
    audio.error();
    return;
  }
  Storage.saveGame(save);
  ui.renderShop(save);
  ui.renderStash(save);
  audio.cash();
  ui.toast(`已委托 ${res.order.name} · 预计 ${money(res.order.price)} · ${Math.round(CAREER.consign.settleMs / 1000)}s 后成交`);
}

function cancelOrderHandler(key) {
  const res = cancelOrder(save, key);
  if (!res.ok) {
    ui.toast(res.reason);
    return;
  }
  Storage.saveGame(save);
  ui.renderShop(save);
  ui.renderStash(save);
  ui.toast(res.returned ? '委托已撤销，物资退回仓库' : `委托已撤销，仓库已满折现 ${money(res.refund)}`);
}

function claimCareerReward(kind, id) {
  let got = 0;
  if (kind === 'achievement') got = claimAchievement(save, id);
  else if (kind === 'quest') got = claimQuest(save, id, careerToday());
  else if (kind === 'rep') got = claimRepReward(save, Number(id));
  if (!got) {
    ui.toast('该奖励尚未达成或已领取');
    return;
  }
  Storage.saveGame(save);
  ui.renderCareer(save);
  audio.cash();
  ui.toast(`奖励已入账 ${money(got)}`);
}

function claimAllCareerRewards() {
  const got = claimAllAchievements(save)
    + claimAllQuests(save, careerToday())
    + claimAllRepRewards(save);
  if (!got) {
    ui.toast('暂时没有可领取的奖励');
    return;
  }
  Storage.saveGame(save);
  ui.renderCareer(save);
  audio.cash();
  ui.toast(`已领取全部奖励 ${money(got)}`);
}

/* ============================ 战局生命周期 ============================ */

function startRaid(seedInput, opts) {
  // HUD 位图开局前预取（不 await，失败自动回退矢量，绝不阻断开局）。
  // 放在这里而不是模块启动：大厅可能停留很久，物品图标也走各自的面板懒加载。
  preloadHudIcons();
  const seed = seedInput && seedInput > 0 ? (Number(seedInput) >>> 0) : randomSeed();
  // 地图只在"部署"这一刻定格：暂停/恢复不会重新生成，界面选图也不会中途换图。
  // 缺省回落到旧图，保证控制台 SOUDACHE.startRaid(1) 等既有调试入口行为不变。
  const mapId = (opts && opts.mapId) || DEFAULT_MAP_ID;
  // P15 风险分级：优先用本次部署显式传入的 id，其次读存档（战前选择），最后回落常规。
  // 与保险同一原则 —— 控制台 startRaid(1) 不会白嫖上一局选的高难度。
  const risk = getRisk((opts && opts.riskId) || save.risk || DEFAULT_RISK_ID);
  const map = generateMap(seed, mapId, { enemyCountMul: risk.enemyCountMul });
  const rng = createRng((seed ^ 0x9e3779b9) >>> 0);

  const lootLuck = riskLootLuck(risk);
  for (const container of map.containers) {
    container.searched = false;
    // P20：把区域价值分层乘进 luck —— 核心区的木箱比外围的木箱更容易出好东西。
    // luck 只改稀有度权重，不增减 rng 调用次数，因此同 seed 的抽取序列仍逐位一致。
    container.tier = containerTierOf(map, container);
    container.loot = Loot.rollContainer(container.type, rng, {
      luck: lootLuckAt(map, container.x, container.y, lootLuck),
    });
    // P20 价值预算：核心区的箱子不该开出一根螺栓。保底零随机（静态填充物），
    // 所以不会改变上面那次 rollContainer 已经消耗的随机序列。
    Loot.applyTierFloor(container.loot, container.tier, CONTAINERS[container.type]);
  }
  // P20：局内三目标（短 / 中 / 高风险）。纯函数，只读几何，不动 rng。
  map.objectives = buildObjectives(map);
  // P20：给撤离点补「附加条件」（限时 / 需携带物资 / 轻装 / 高危读条）。
  // 只写修饰字段，不动 kind / openAt / 坐标 → 不进入 GOLDEN 快照。
  // M-03：layout:true 启用出口网络（常规 / 付费 / 拉闸），随后生成闸刀 POI 并校验可达性。
  // 两步都在 generateMap 之后 —— GOLDEN 口径逐位不变。
  buildExtractPlan(map, { duration: MATCH.duration, layout: true });
  finalizeExtractLayout(map);

  // 局外改装在这里一次性结算成**本局专用**配置（applyMods 返回新对象，绝不改 config.js 常量）。
  // 武器 / 护甲 / 医疗 / 玩家数值都从这份 cfg 取，保证四处强化的口径一致。
  const cfg = applyMods({ PLAYER, WEAPONS, ARMORS, ITEMS }, save);
  // P6 改枪台：在局外改装（upgrades）之上，再叠加改枪台附件数值到本局 cfg.WEAPONS。
  // 必须放在 defs 计算之前，否则武器状态会指向未改装的旧 def。
  applyWeaponMods(cfg, save);
  const lo = save.loadout;
  // W2：三个武器槽 —— 主武器 / 副武器 / 手枪。顺序即快捷栏 1/2/3 的顺序（空槽自动跳过）。
  const defs = [lo.primary, lo.secondary, lo.sidearm]
    .filter((id) => id && cfg.WEAPONS[id])
    .map((id) => cfg.WEAPONS[id]);
  const armorDef = cfg.ARMORS[lo.armor] || cfg.ARMORS.none;
  const helmetDef = cfg.ARMORS[lo.helmet] || cfg.ARMORS.none;
  // W2：背包只改负重上限，胸挂只改局内胸挂容器尺寸（两者的定义都在 config.js；
  // 不进 applyMods —— 改装树里没有一项作用于它们，硬塞进去只会多一层空转）。
  const backpackDef = BACKPACKS[lo.backpack] || BACKPACKS.none;
  const meleeDef = MELEE[lo.melee] || null;
  const finalDefs = defs.length ? defs : [cfg.WEAPONS.pistol];
  // P7：弹种与武器口径绑定。主/副槽各选各的；同一把枪重复装备时按槽位取，
  // 口径不符（例如把 SMG 放主武器却选了 5.56）自动回落该武器的标准弹。
  // W2：手枪槽与副武器槽共用 `ammoSecondary`（两槽都是 9mm 家族，分两套配置只会让玩家多绕一步）。
  const slotPicks = [lo.ammoPrimary, lo.ammoSecondary, lo.ammoSecondary];
  const ammoIds = finalDefs.map((d, i) => {
    const list = ammoIdsForWeapon(d.id, cfg.WEAPONS);
    const picked = slotPicks[i];
    return list.includes(picked) ? picked : (d.ammoItem || list[0] || null);
  });
  const player = new Player({
    x: map.playerSpawn.x,
    y: map.playerSpawn.y,
    armorDef,
    helmetDef,
    backpackDef,
    meleeDef,
    weaponDefs: finalDefs,
    ammoIds,
    items: buildLoadoutItems(lo, cfg.ITEMS),
    playerCfg: cfg.PLAYER,
    itemCfg: cfg.ITEMS,
  });
  const enemies = applyRiskToEnemies(spawnEnemies(map, rng), risk);

  // P1：运行时组装依赖，惰性读 save（resetSave 后不陈旧）、ui 此刻已完成初始化。
  const createWorld = makeCreateWorld({
    audio, ui, money, openLootStash, endRaid, PARTICLE_CAP,
    getSave: () => save,
  });
  world = createWorld(map, seed, rng, player, enemies);
  // P9：记录本局 Boss 引用，供 HUD 首领血条读取（每图最多一个）。
  world.boss = enemies.find((e) => e.isBoss) || null;
  // P15：本局风险档 —— 结算/HUD/调试口读这里，不再回查存档（中途改存档不会篡改本局）。
  world.risk = risk;
  // P20：补货用的基准幸运倍率（风险档），区域层级倍率在触发时再乘上去。
  world.lootLuck = lootLuck;

  // P18：随身并行容器（胸挂 / 口袋 / 安全容器）。尺寸只从 config.PLAYER 取，不在这里写死。
  // 负重、估值、换弹备弹、医疗、丢弃、结算带出全部按「全部容器」聚合（见 Player.containers）。
  // E-05：安全箱尺寸按存档档位取（旧档 s1=2×2 与改动前逐位一致），坏值回落 s1。
  const secureTier = SECURE_TIERS[save.secureTier] ? save.secureTier : DEFAULT_SECURE_TIER;
  const secureSize = SECURE_TIERS[secureTier];
  // W2：胸挂尺寸由装备的胸挂决定（默认 rig_lv1 = 4×2，与改动前写死的 PLAYER.rig 逐位一致）。
  const rigDef = RIGS[lo.rig] || RIGS.rig_lv1;
  const rigSize = rigSizeFor(lo.rig);
  player.rigDef = rigDef;
  player.extraContainers = [
    createInventory(rigSize.cols, rigSize.rows, { name: '胸挂', kind: 'rig' }),
    createInventory(PLAYER.pocket.cols, PLAYER.pocket.rows, { name: '口袋', kind: 'pocket' }),
    createInventory(secureSize.cols, secureSize.rows, { name: '安全容器', kind: 'secure' }),
  ];
  // 双栏界面的左侧「我的装备」：槽位只是当前穿戴的展示位，局内不可替换
  // （换枪/换甲不改战斗数值，允许替换会造出"换了却没换"的假象）。
  // ⚠ 只喂 makePlayerGear 支持的四种槽位（SLOT 枚举）。W2 新增的手枪/匕首/背包/胸挂
  //   不在这里展示：它们的价值已经由 player.weight / 结算口径覆盖，再加一份会重复计入。
  player.gear = makePlayerGear(player.inventory, {
    primary: lo.primary, secondary: lo.secondary, armor: lo.armor, helmet: lo.helmet,
  }, {
    rig: player.extraContainers[0],
    pocket: player.extraContainers[1],
    secure: player.extraContainers[2],
  });
  for (const s of player.gear.slots) s.readonly = true;

  // P5-C2 本地 AI 小队：在玩家身后编队位生成两名队友（与敌人同款纯逻辑 AI）。
  // P15：编成改为读存档（战前可选两席），旧档 squad=[] 时由 resolveSquadIds
  // 按干员表补默认 —— 结果与 P14 的「取非玩家前两名」逐位一致。
  // 注意：op 在下方才声明，这里用 save.operator 取玩家当前干员 id 以避免 TDZ。
  const allyOps = resolveSquadIds(save.squad, save.operator);
  const squad = spawnSquad(player, map, rng, allyOps, defs[0] || cfg.WEAPONS.rifle);
  world.squad = squad;

  // 干员（P5）：被动乘数写进玩家，技能状态是**本局专用**对象。
  // 选择只从存档读一次，之后整局不再变 —— 中途改存档不会让技能凭空换人。
  const op = getOperator(save.operator);
  applyOperator(player, op);
  player.abilities = createAbilityState(op);
  world.abilities = player.abilities;
  world.operator = op;
  // 战局内“点击医疗物资直接使用”也要走改装后的定义，否则该路径会绕过医疗效率强化。
  world.itemCfg = cfg.ITEMS;
  // 保险状态只能从本次部署显式传入：若从 save 现读，控制台调 SOUDACHE.startRaid(1) 会白嫖保险。
  world.insured = Boolean(opts && opts.insured);
  openContainer = null;
  paused = false;
  input.fire = false;
  input.firePressed = false;
  input.jumpPressed = false;
  input.ads = false; // 进战不默认开镜（右键点击切换）
  // 姿态归零：上局趴着死的人，这局不该一睁眼就趴在地上
  resetStance(stanceState, input);
  input.aim.x = player.x + 60;
  input.aim.y = player.y;

  go('battle');
  audio.ensure();
  if (audio.startAmbient) audio.startAmbient();
  const anchorPoint = map.extracts.find((e) => e.kind === 'standard');
  ui.toast(`已部署 · ${map.name} · 种子 ${seed} · ${map.extracts.length} 个撤离点`
    + `${anchorPoint ? '（常规点开局即开）' : ''}`);
  // M-03：进图情报 —— 只报出口类型与开放时间，不透露敌人部署。
  if (map.extractLayout && map.extractLayout.ok) {
    const kindText = { standard: '常规', free: '免费', paid: '付费', guarded: '守卫' };
    const openText = (ex) => {
      const t = Math.max(0, Math.round(Number(ex.openAt) || 0));
      if (t === 0) return '开局开放';
      return `T+${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')} 开放`;
    };
    const lines = map.extracts.map((ex) => {
      const k = kindText[ex.kind] || '免费';
      const fee = ex.kind === 'paid' ? ` ${money(ex.cost || MATCH.extractFee)}` : '';
      const mod = modifierLabel(ex);
      const extra = mod && mod !== '常规' ? ` · ${mod}` : '';
      return `${ex.name} ${k}${fee}${extra} ${openText(ex)}`;
    });
    ui.toast(`出口情报：${lines.join(' / ')}`);
  }
  // P20：把「出生点类型」翻译成一句可执行的建议 —— 位置信息不说明白等于没有。
  const hint = spawnHint(map.spawnKind);
  if (hint) ui.toast(hint);
  // 干员操作的发现性：第一次进战直接把两个键告诉玩家，而不是让他们去翻暂停面板
  ui.toast(`干员 ${op.code} · [G] ${op.ultimate ? throwableDef(op.tactical.id).name : ''} · [X] ${op.ultimate.name}`);
}

/**
 * 玩家脚下最近的撤离点（结算兜底用）。
 * endRaid 可能被"放弃 / 超时 / 调试口"直接调用，此时 world.extractKind 还没被 onExtract 写入，
 * 结算页就会显示一个光秃秃的"撤离"。这里按站位回填通道类型，不依赖调用顺序。
 * @param {object} w 战局
 * @returns {?object} 命中的撤离点
 */
function extractUnderPlayer(w) {
  if (!w || !w.map || !w.player) return null;
  let best = null;
  let bd = Infinity;
  for (const ex of w.map.extracts || []) {
    const d = Math.hypot(ex.x - w.player.x, ex.y - w.player.y);
    if (d <= (ex.r || 40) + 10 && d < bd) { bd = d; best = ex; }
  }
  return best;
}

/**
 * 放进仓库；放不下就按出售价折现（与既有溢出逻辑同一口径）。
 * @param {object} item 物品实例
 * @returns {number} 折现金额（0 = 已放进仓库）
 */
function placeOrCash(item) {
  if (autoPlace(save.stash, item)) return 0;
  return Math.round(itemValue(item) * SHOP.sellRatio);
}

function endRaid(reason) {
  if (!world || world.over) return;
  world.over = true;
  if (audio && audio.stopAmbient) audio.stopAmbient();
  ui.closeBattlePanels();
  input.fire = false;

  const player = world.player;
  const success = reason === 'extract';

  // P18：带出/损失清单必须覆盖全部格位容器（胸挂/口袋/安全容器），
  // 只读主背包会让玩家搜到的物资在结算页凭空消失。
  const carried = player.carriedItems();
  // E-05：把随身物品拆成「安全箱」与「普通」两组。阵亡时只有安全箱回仓，
  // 这是玩家的损失下限；成功时两组都带出，口径与改动前逐位一致。
  const { secure: secureItems, loose: looseItems } = splitCarried(player.containers);
  const gear = [];
  // W2：回仓清单 = 「部署时从仓库扣掉的那 8 个槽位」，一一对应（见 deploy）。
  // 漏一项的后果：那件装备每局都被静默吞掉 —— 玩家会以为存档坏了。
  // ⚠ helmet 以前漏在这里（穿了就没收），这次一并补齐，与 deploy 的扣仓列表严格对称。
  if (player.armorDef && player.armorDef.id !== 'none' && ITEMS[player.armorDef.id]) {
    gear.push(createItem(ITEMS[player.armorDef.id], 1));
  }
  if (player.helmetDef && player.helmetDef.id !== 'none' && ITEMS[player.helmetDef.id]) {
    gear.push(createItem(ITEMS[player.helmetDef.id], 1));
  }
  for (const weapon of player.weapons) {
    if (ITEMS[weapon.def.id]) gear.push(createItem(ITEMS[weapon.def.id], 1));
  }
  if (player.meleeDef && ITEMS[player.meleeDef.id]) {
    gear.push(createItem(ITEMS[player.meleeDef.id], 1));
  }
  for (const def of [player.backpackDef, player.rigDef]) {
    if (def && def.id && def.id !== 'none' && ITEMS[def.id]) gear.push(createItem(ITEMS[def.id], 1));
  }

  // E-05：失败时安全箱物品照常带出（回仓），普通物品与装备才计损失。
  // 语序：安全箱 → 保险 → 普通掉落；保险只救装备，不救普通物品。
  let broughtOut = success ? carried.concat(gear) : secureItems.slice();
  let lost = success ? [] : looseItems.concat(gear);
  if (!success && world.insured) {
    // 保险只赔带进去的装备：gear 回仓库（满了折现），安全箱照旧保留，普通物资照旧清空。
    lost = looseItems.slice();
    let cash = 0;
    for (const it of gear) cash += placeOrCash(it);
    if (cash > 0) {
      save.currency += cash; // 折现的钱必须真正到账，否则"理赔"是假的
      ui.toast(`保险理赔：仓库已满，折现 ${money(cash)}`);
    }
  }
  // E-05：失败时安全箱物品虽回仓，但那是"损失下限"而非带出战果 —— 计分/声望/最佳估值
  // 口径必须与撤离成功前的旧行为一致（失败恒 0）。回仓走 broughtOut，计分走 lootValue，两者解耦。
  const lootValue = success ? Loot.valueOf(broughtOut) : 0;
  // 「高价值撤离」类合约：只有真正撤离成功才结算（带出估值达标即达成）
  if (success) settleExtractContracts(world, lootValue, (c) => completeContract(world, c));

  if (success) {
    let overflow = 0;
    for (const item of broughtOut) overflow += placeOrCash(item);
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
  // P20：探索度只看可行走格 —— 把墙体算进分母会让"探索 70%"变成永远达不到的指标。
  let walkableTiles = 0;
  let seenTiles = 0;
  const exploredGrid = world.explored;
  if (exploredGrid && world.map.grid) {
    for (let i = 0; i < exploredGrid.length; i += 1) {
      if (world.map.grid[i] !== 0) continue;
      walkableTiles += 1;
      if (exploredGrid[i]) seenTiles += 1;
    }
  }

  // P20：结算复盘 —— 撤离方式 / 带出价值 / 高价值物 / 击败 / 探索 / 任务 / 目标 / 时长。
  // 必须在算分之前算完：局内目标加成要进 rawScore（只在文案里写"+" 是假账）。
  const review = buildReview({
    reason,
    success,
    carriedValue: success ? lootValue : 0,
    lostValue: success ? 0 : Loot.valueOf(lost),
    items: success ? broughtOut : lost,
    kills: world.kills,
    searched: world.searchedCount,
    exploredRatio: walkableTiles ? seenTiles / walkableTiles : 0,
    time: survived,
    terminals: world.terminalsHacked,
    contractsDone: world.contractsDone,
    contractsTotal: (world.contracts || []).length,
    bossDown: Boolean(world.boss && world.boss.dead),
    extractKind: world.extractKind || (extractUnderPlayer(world) || {}).kind,
    extractModifier: world.extractModifier || (extractUnderPlayer(world) || {}).modifier,
    extractFee: world.extractFeePaid,
    killedBy: world.killedBy,
    killerName: world.killedBy && world.killedBy.type
      ? ((ENEMY_TYPES[world.killedBy.type] && ENEMY_TYPES[world.killedBy.type].name) || '')
      : '',
    objectives: world.objectives,
    hotspotVisits: world.hotspotVisits,
    world,
  });

  const raidRisk = world.risk || getRisk(DEFAULT_RISK_ID);
  const rawScore = Math.round(
    lootValue * SCORING.lootPerPoint
    + world.kills * SCORING.killPoints
    + world.searchedCount * SCORING.searchPoints
    + (success ? SCORING.extractBonus : 0)
    + survived * SCORING.survivalPerSecond
    // P20：局内目标加成与复盘读的是**同一份**结算结果，不另算一套。
    + (review.objectives ? review.objectives.bonus : 0)
    + (world.scoreBonus || 0),
  );
  // P15：风险倍率只作用在最终评分上，不改变击杀/搜索等基础计分口径。
  // 常规档 ×1 → 与 P14 之前逐位相同。
  const score = riskScore(rawScore, raidRisk);
  const rating = SCORING.ratings.find((r) => score >= r.min) || SCORING.ratings[SCORING.ratings.length - 1];

  // 评级奖励：只在撤离成功时发（S 1500 / A 800 / B 400 / C 150 / D 0）
  // P15：奖金同样吃风险倍率，否则「绝密」只有难度没有对应的现金回报。
  const rawRatingBonus = success ? ((SCORING.ratingBonus && SCORING.ratingBonus[rating.grade]) || 0) : 0;
  const ratingBonus = riskPayout(rawRatingBonus, raidRisk);
  if (ratingBonus > 0) save.currency += ratingBonus;

  save.stats.raids += 1;
  if (success) save.stats.extracts += 1;
  else save.stats.deaths += 1;
  save.stats.kills += world.kills;
  save.stats.bestScore = Math.max(save.stats.bestScore, score);
  save.stats.bestValue = Math.max(save.stats.bestValue, lootValue);

  /* ---- 新增持久化：必须全部落在下面那次 saveGame 之前 ----
   * 写反了的表现是"结算页有，退出重进就没了"。 */

  // 每日突袭：日期变了就重置；只有「今日种子」才算成绩
  const today = String(Storage.dailySeed());
  if (!save.daily || save.daily.date !== today) save.daily = { date: today, bestScore: 0, extracted: false };
  if (world.seed === Storage.dailySeed()) {
    save.daily.bestScore = Math.max(save.daily.bestScore, score);
    if (success) save.daily.extracted = true;
  }

  // 图鉴：本局新发现的件数（brought 只在真正带出时记录）
  let newFound = 0;
  for (const it of broughtOut) {
    const rec = save.codex || (save.codex = { seen: {}, brought: {} });
    if (!rec.brought[it.id]) newFound += 1;
    rec.brought[it.id] = true;
  }

  // 军械商声望：带出估值换经验，阵亡留 30%
  const rep = save.rep || (save.rep = { xp: 0 }); // 老档没有 rep 字段：就地补，别让 buy() 崩
  const xpGain = Math.round(lootValue * REP.xpPerValue * (success ? 1 : REP.deathXp));
  const beforeLv = Storage.repLevel(rep.xp);
  rep.xp += xpGain;
  const afterLv = Storage.repLevel(rep.xp);
  const repLine = afterLv > beforeLv
    ? `Lv.${afterLv} · ${REP.levels.find((l) => l.level === afterLv).label}`
    : null;

  // P10 局外生涯：成就 / 今日任务 / 到点委托单，全部落在唯一那次 saveGame 之前。
  // 奖励只标记「可领取」，玩家回生涯屏幂等领取，避免结算重复入账。
  const careerTodayStr = String(Storage.dailySeed());
  const careerResult = settleRaidCareer(save, {
    success,
    kills: world.kills,
    searches: world.searchedCount,
    terminals: world.terminalsHacked,
    lootValue,
    survived,
    bossDown: world.boss && world.boss.dead ? 1 : 0,
  }, careerTodayStr, Date.now());

  Storage.saveGame(save);
  Storage.ensureMinimumKit(save);

  // 死因复盘：只有 dead 的副标题是动态的，其余三条原样
  const killer = world.killedBy;
  // 流血致死没有"枪手"，别把它写成「倒在未知目标枪下 · 0m」
  const killedText = killer && killer.type === 'bleed'
    ? '失血过多 —— 中弹后没有及时止血'
    : (killer
      ? `倒在 ${(ENEMY_TYPES[killer.type] && ENEMY_TYPES[killer.type].name) || '未知目标'} 枪下 · ${killer.dist}m`
      : '你倒在了战区里，随身物资全部丢失。');
  const titles = {
    extract: { title: '撤离成功', subtitle: '你活着把东西带了出来。', ok: true },
    dead: { title: '阵亡', subtitle: killedText, ok: false },
    timeout: { title: '超时未撤离', subtitle: '撤离窗口关闭，你被留在了战区。', ok: false },
    abandon: { title: '放弃战局', subtitle: '你主动放弃了这次突袭。', ok: false },
  };
  const info = titles[reason] || titles.dead;

  const stats = review.rows.map((r) => {
    if (r.key === 'value' || r.key === 'fee') return [r.label, money(Number(r.value) || 0)];
    return [r.label, r.value];
  });
  // 保留复盘之外的操作性指标（命中率 / 负重），它们不属于"这一局发生了什么"。
  stats.push(['命中率', `${accuracy}%`]);
  stats.push(['总负重', `${totalWeight(player.inventory).toFixed(1)} kg`]);
  // P15：非基准档才插这一行（常规局结算行数与 P14 之前完全一致）。
  const riskLine = riskSummary(raidRisk);
  if (riskLine) stats.push(['风险系数', riskLine]);
  // 评级奖励与「距下一档还差多少」：让 S 和 C 的收益差别看得见
  if (ratingBonus > 0) stats.push(['评级奖励', money(ratingBonus)]);
  if (success) {
    const nextGrade = SCORING.ratings.filter((r) => r.min > score).pop();
    if (nextGrade) stats.push([`距 ${nextGrade.grade}`, `${nextGrade.min - score} 分`]);
    // 图鉴进度（分母是 ITEM_IDS.length，现在是 19，含 lv2/lv3）
    // 撤离成功但一件都没带出来时 save.codex 可能还不存在，这里必须兜底。
    const total = Object.keys((save.codex && save.codex.brought) || {}).length;
    stats.push(['图鉴', `${newFound > 0 ? `新发现 ${newFound} 件 · ` : ''}${total}/${ITEM_IDS.length}`]);
  }
  // 声望提升（只在真的跨级时出现）
  if (repLine) stats.push(['声望提升', repLine]);
  // 局外进度只占一行，避免结算页被新系统挤爆（结算行数有屏幕高度约束）。
  const careerNews = [];
  if (careerResult.freshAchievements.length) {
    careerNews.push(`新成就 ${careerResult.freshAchievements.map((a) => a.name).join(' / ')}`);
  }
  if (careerResult.freshQuests.length) {
    careerNews.push(`今日任务 ${careerResult.freshQuests.map((q) => q.name).join(' / ')}`);
  }
  if (careerResult.settled.length) {
    const paid = careerResult.settled.reduce((sum, o) => sum + (Number(o.price) || 0), 0);
    careerNews.push(`委托成交 ${money(paid)}`);
  }
  if (careerNews.length) stats.push(['局外进度', careerNews.join(' · ')]);
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
  // P11：过场层是纯视觉覆盖，结果屏仍在同一帧同步就位（探针读 result DOM 不受影响）。
  if (ui.playTransition) ui.playTransition(success ? 'success' : 'failure', score);
  go('result');
}

/* ============================ 战利品拾取 ============================ */

/**
 * 把地图容器包成「可搜刮实体」（双栏界面用）。
 * 关键约束：实体网格的 items 数组与 container.loot 是**同一个数组引用** ——
 * 关闭面板后旧逻辑（剩余件数、E 键重开）与结算读到的才是同一份账面，绝不出现两套库存。
 * @param {object} container 地图容器
 * @returns {object} LootableEntity
 */
function lootEntityOf(container) {
  if (container._entity) return container._entity;
  const ent = containerFromType(container.type, container.loot || [], { id: container.id });
  container.loot = entityContainers(ent)[0].items;
  container._entity = ent;
  return ent;
}

/**
 * 打开双栏搜刮界面（搜索完成、E 键重开共用）。
 * @param {object} container 地图容器
 * @returns {void}
 */
function openLootStash(container) {
  if (!world || !container) return;
  openContainer = container;
  const def = CONTAINERS[container.type];
  ui.openLootGrid(lootEntityOf(container), world.player.gear, {
    title: `${def ? def.name : '物资'} · ${(container.loot || []).length} 件`,
    weightLimit: world.player.weightLimit,
  });
  clearMovementKeys();
  syncPointerLock();
}

/**
 * 从当前搜刮容器取走一件后，同步「容器外」的那份账面。
 * 普通地图容器只有 container.loot 一份；散落物堆的 loot 是从 world.items 聚合来的，
 * 取走后必须按 uid 把地面本体也删掉，否则地上会留下捡不走的幽灵物品。
 * @param {object} item 被取走的物品
 */
function consumeGroundCopy(item) {
  if (!world || !openContainer || !openContainer._scatter || !item) return;
  const gi = (world.items || []).findIndex((it) => it.uid === item.uid);
  if (gi >= 0) world.items.splice(gi, 1);
}

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
  // 图鉴：拾取过就记 seen（不在这里落盘 —— endRaid 那次 saveGame 会一起写下去，
  // 一次拾取多写一遍 localStorage 是白给的开销）
  save.codex = save.codex || { seen: {}, brought: {} };
  save.codex.seen[item.id] = true;
  list.splice(idx, 1);
  consumeGroundCopy(item);
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
    // 图鉴：只记 seen（循环外不要逐件 saveGame）
    save.codex = save.codex || { seen: {}, brought: {} };
    save.codex.seen[item.id] = true;
    const idx = openContainer.loot.indexOf(item);
    if (idx >= 0) openContainer.loot.splice(idx, 1);
    consumeGroundCopy(item);
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
  // P12 混响空间感：按玩家到最近分区中心的距离做纯读近似，
  // 只驱动室内/室外湿声比例，不新增 world 字段、不抽 rng、不参与光照真值或玩法判定。
  if (audio.setInterior) {
    const pois = w.map && w.map.pois;
    let interior = 0;
    if (pois && pois.length) {
      let best = Infinity;
      for (const p of pois) {
        const d = (p.x - w.player.x) ** 2 + (p.y - w.player.y) ** 2;
        if (d < best) best = d;
      }
      interior = Math.max(0, Math.min(1, 1 - Math.sqrt(best) / 140));
    }
    audio.setInterior(interior);
  }
  // 首次进入给一个随机延迟，避免一部署就立刻来一发远处枪声
  if (w.ambientShotTimer == null) w.ambientShotTimer = w.rng.float(4, 12);
  w.ambientShotTimer -= dt;
  if (w.ambientShotTimer <= 0) {
    w.ambientShotTimer = w.rng.float(7, 18);
    if (engaged === 0 && audio.distantShot) {
      // 确定性方位：从战局时间推导，绝不额外消耗 rng（否则同 seed 整局漂移）。
      audio.distantShot(Math.sin(w.time * 0.83) * 0.85);
    }
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

/**
 * 干员技能与终结技的每帧推进（P5）。
 *
 * 这里的取舍：终结技的"效果"全部写成**读状态的乘数**，而不是一次性改玩家的数值。
 * - 火力全开 → player.combatMods（combat 每发读一次）
 * - 鹰眼 → enemy.marked（渲染层每帧读一次）
 * - 战地急救 → 立即结算一次 + world.aegisAcc 的分帧回血
 * - 火环 → 一个静态 zone（throwable 的燃烧结算统一处理）
 * 好处是技能结束时不需要"撤销"，只要状态归零，所有系统自然回到基线。
 *
 * @param {object} w 世界
 * @param {number} dt 步长
 * @returns {void}
 */
function updateOperatorState(w, dt) {
  const st = w.abilities;
  if (!st) return;
  const p = w.player;
  tickAbilities(st, dt);
  // 自然回能：让"没打起来"的时间也不是纯浪费，8 分钟一局自然回满约 90 秒
  addUltCharge(st, ABILITY.ultPassive * dt);

  w.flashT = Math.max(0, (w.flashT || 0) - dt);
  w.bossFlashT = Math.max(0, (w.bossFlashT || 0) - dt);
  const active = st.ultT > 0;
  const ultId = st.ultimate.id;

  // 火力全开：乘数每帧重设，技能结束自动归 1（不需要在结束点做清理）
  p.combatMods = active && ultId === 'overdrive' ? ABILITY.overdrive : null;

  // 鹰眼：标记在场所有活着的敌人。用每帧刷新短时标记，敌人一死标记自然消失。
  if (active && ultId === 'eagle') {
    for (const e of w.enemies) if (!e.dead) e.marked = 0.25;
  } else {
    for (const e of w.enemies) if (e.marked) e.marked = 0;
  }

  // 战地急救的持续段：按小数累积，避免每帧取整把 4/s 的回复吞成 3/s
  if (active && ultId === 'aegis') {
    w.aegisAcc += ABILITY.aegis.regen * dt;
    const heal = Math.floor(w.aegisAcc);
    if (heal > 0) {
      w.aegisAcc -= heal;
      p.hp = Math.min(p.maxHp, p.hp + heal);
    }
  } else {
    w.aegisAcc = 0;
  }
}

/**
 * 投掷战术道具（G / 触屏「战术」）。
 * @returns {boolean} 是否投出
 */
function throwTactical() {
  const w = world;
  const p = w && w.player;
  const st = w && w.abilities;
  if (!w || w.over || !p || p.dead || !st) return false;
  if (!canThrowTactical(st)) {
    ui.toast(`战术道具冷却中 · ${Math.ceil(st.tactical.cd)}s`);
    if (audio) audio.error();
    return false;
  }
  consumeTactical(st);
  const o = throwOrigin(p);
  const g = createGrenade(st.tactical.type, o.x, o.y, o.h, p.yaw || 0, p.pitch || 0);
  w.grenades.push(g);
  if (audio) audio.throwPin();
  ui.toast(`${throwableDef(st.tactical.type).name} 已投出 · 剩余 ${st.tactical.charges} 发`);
  return true;
}

/**
 * 释放终结技（X / 触屏「大招」）。
 * @returns {boolean} 是否释放
 */
function releaseUltimate() {
  const w = world;
  const p = w && w.player;
  const st = w && w.abilities;
  if (!w || w.over || !p || p.dead || !st) return false;
  if (!st.ultimate.ready) {
    ui.toast(`终结技充能中 · ${Math.round(st.ultimate.charge)}%`);
    if (audio) audio.error();
    return false;
  }
  const ultId = st.ultimate.id;
  consumeUltimate(st);
  if (ultId === 'overdrive') {
    p.combatMods = ABILITY.overdrive;
    ui.toast('火力全开 · 7 秒压制窗口');
  } else if (ultId === 'eagle') {
    for (const e of w.enemies) if (!e.dead) e.marked = 0.25;
    ui.toast('鹰眼 · 敌人位置已标记 9 秒');
  } else if (ultId === 'aegis') {
    p.hp = Math.min(p.maxHp, p.hp + ABILITY.aegis.heal);
    p.armor = Math.min(p.maxArmor, p.armor + ABILITY.aegis.armor);
    w.aegisAcc = 0;
    ui.toast('战地急救 · 生命与护甲已修补');
  } else if (ultId === 'pyre') {
    w.zones.push({
      x: p.x, y: p.y, r: ABILITY.pyre.radius * VIEW3D.metersToUnits,
      dps: ABILITY.pyre.dps, t: 0, life: ABILITY.pyre.dur, kind: 'fire', acc: 0,
      owner: 'player-safe',
    });
    ui.toast('火环 · 区域封锁 8 秒');
  }
  if (audio && audio.ultimate) audio.ultimate();
  if (w.shakeCamera) w.shakeCamera(2.2);
  return true;
}

/**
 * 首领阶段与破甲的两个「一次性播报」（P16）。
 *
 * 为什么放在 main 而不是 applyDamage：伤害结算只该算数值，播报需要 ui/audio/shake
 * 三件套，而且**必须只播一次** —— 每帧检测 `armorBroken` 状态翻转比在伤害函数里
 * 塞回调更简单，也不会因为霰弹枪一枪多弹丸而重复播 9 次。
 * @param {object} w 战局上下文
 * @returns {void}
 */
function updateBossPhases(w) {
  const b = w && w.boss;
  if (!b) return;
  if (!b.dead) {
    const ev = syncBossPhase(b);
    if (ev) {
      ui.toast(`首领 · ${b.name} 进入 ${ev.def.label}「${ev.def.name}」`);
      if (audio && audio.bossPhase) audio.bossPhase(ev.to);
      if (w.shakeCamera) w.shakeCamera(4.5);
      w.bossFlashT = 0.55;   // P17：阶段切换的专属红橙闪光（与震撼弹白屏区分，读作"首领暴怒"）
      w.bossPhaseBanner = { label: ev.def.label, name: ev.def.name, t: 2.6 };
    }
  }
  if (b.armorBroken && !b._armorBreakAnnounced) {
    b._armorBreakAnnounced = true;
    ui.toast(`装甲击穿 · ${b.name} 的护甲已失效，承伤提升`);
    if (audio && audio.armorBreak) audio.armorBreak();
    if (w.shakeCamera) w.shakeCamera(3.4);
    w.armorBreakT = 2.4;
  }
}

/**
 * P20：热点进入提示 + 区域进度。
 * 只在**跨边界的那一刻**发提示（进 / 出各一次），不进每帧刷屏路径。
 * 顺带维护 lootTaken / carriedPeak —— 这两个值只喂 HUD 与结算复盘，不参与掉落或经济。
 * @param {object} w 战局
 * @param {number} dt 帧间隔
 */
function updateHotspotVisit(w, dt) {
  const p = w.player;
  const here = hotspotAt(w.map, p.x, p.y);
  const inId = here ? `${here.roomIndex}` : null;
  if (inId !== w._inHotspot) {
    if (here) {
      w.hotspotVisits = (w.hotspotVisits || 0) + 1;
      const info = hotspotInfo(here);
      ui.toast(`进入 ${here.name} · ${info.title} · ${dangerLabel(info.danger)}`);
      if (audio && audio.warn) audio.warn();
      w.hotspotT = 6;
      w.hotspotName = `${here.name} · ${info.title}`;
      w.hotspotHint = info.hint;
      w.hotspotDanger = info.danger;
    } else {
      w.hotspotT = 0;
    }
    w._inHotspot = inId;
  }
  w.hotspotT = Math.max(0, (w.hotspotT || 0) - dt);

  // 拾取计数：按「携带件数净增」累计，用掉/丢掉会回落，但已拾取过的不会再计一次。
  const list = p.carriedItems ? p.carriedItems() : [];
  const now = list.length;
  const prev = Number.isFinite(w._carriedCount) ? w._carriedCount : now;
  if (now > prev) w.lootTaken = (w.lootTaken || 0) + (now - prev);
  w._carriedCount = now;
  const v = p.carriedValue || 0;
  if (v > (w.carriedPeak || 0)) w.carriedPeak = v;
}

/**
 * P20：补货波次。到点后给排期内的容器补 1~2 件物资，并重置已搜空的容器。
 * 补货用的是独立的确定性 rng（seed 派生），绝不消耗 world.rng —— 否则同 seed 整局会漂移。
 * @param {object} w 战局
 */
function fireLootWaves(w) {
  const q = w.lootWaves;
  if (!q || !q.length) return;
  while (q.length && w.time >= q[0].at) {
    const wave = q.shift();
    const byId = new Map(w.map.containers.map((c) => [c.id, c]));
    let restocked = 0;
    for (const id of wave.containerIds) {
      const c = byId.get(id);
      if (!c) continue;
      const def = CONTAINERS[c.type];
      if (!def) continue;
      const luck = lootLuckAt(w.map, c.x, c.y, w.lootLuck || 1);
      const extra = Loot.rollContainer(c.type, w.lootRng, { luck });
      if (!extra.length) continue;
      // 与实体同源：面板 / 结算读到的必须是同一个数组
      if (c._entity) c.loot = entityContainers(c._entity)[0].items;
      else c.loot = c.loot || [];
      for (const it of extra) c.loot.push(it);
      // 已搜空 / 已搜过的容器重新可交互 —— 否则补了货却打不开，等于白补。
      if (c.searched) {
        c.searched = false;
        restocked += 1;
        // 视觉同源：不点亮回来，箱子在画面上仍是"已搜过"的暗色，玩家不会再去搜。
        if (renderer && renderer.level && renderer.level.setSearched) {
          renderer.level.setSearched(c, false);
        }
      }
    }
    if (wave.containerIds.length) {
      const label = wave.wave === 'topup' ? '中段补货' : '末段重刷';
      ui.toast(`${label}：${wave.containerIds.length} 处容器有新物资${restocked ? `（${restocked} 处已重新上锁）` : ''}`);
      if (audio && audio.pickup) audio.pickup(0.5);
    }
  }
}

/**
 * P21：痕迹系统每帧推进。
 * - 衰减过期痕迹（decayTraces 用真实 dt，零随机）。
 * - 玩家移动时按累计距离落脚印：蹲伏更淡、站立更明显；站定不动不留痕。
 *   脚印留在玩家"刚走过"的位置，AI 循迹只会扑到旧位置 —— 这是给玩家的反侦察窗口。
 * @param {object} w 战局
 * @param {number} dt 帧间隔秒
 */
function updateTraces(w, dt) {
  decayTraces(w.traces, dt);
  const p = w.player;
  if (!p || p.dead) return;
  const px = p.x, py = p.y;
  const lx = w._traceLastX != null ? w._traceLastX : px;
  const ly = w._traceLastY != null ? w._traceLastY : py;
  const moved = Math.hypot(px - lx, py - ly);
  w._traceAccum = (w._traceAccum || 0) + moved;
  // 跨过 ~64 逻辑单位落一枚脚印（约两步）；草丛里走不落痕（视觉/听觉都有隐蔽加成）。
  if (w._traceAccum >= 64) {
    w._traceAccum = 0;
    if (!p.inBush) {
      const strength = p.crouching ? 0.5 : 1;
      w.leaveTrace('footprint', px, py, { strength });
    }
  }
  w._traceLastX = px;
  w._traceLastY = py;
}

function update(dt) {
  const w = world;
  if (!w || w.over) return;

  w.time += dt;
  w.timeLeft = Math.max(0, MATCH.duration - w.time);
  w.hitMarker = Math.max(0, w.hitMarker - dt);
  w.hitKindT = Math.max(0, (w.hitKindT || 0) - dt);
  // P16：首领阶段横幅 / 破甲高亮的存活时间（纯表现，不参与任何判定）。
  if (w.bossPhaseBanner) w.bossPhaseBanner.t = Math.max(0, w.bossPhaseBanner.t - dt);
  w.armorBreakT = Math.max(0, (w.armorBreakT || 0) - dt);
  w.streakT = Math.max(0, (w.streakT || 0) - dt);
  // 受击方向提示（P1-6）：0.6s 内淡出，超时即视为"忘了从哪挨的枪"
  w.hitDirT = Math.max(0, (w.hitDirT || 0) - dt);
  updateAirdrop(w);
  updateOperatorState(w, dt);

  w.player.update(dt, input, w);
  for (const enemy of w.enemies) enemy.update(dt, w);
  updateBossPhases(w);
  updateSquad(dt, w);
  updateThrowables(w, dt);
  updateEnemyGrenades(w, dt); // P9：敌方爆裂雷引信 / 范围伤害
  updateEffects(dt);
  updateKillFeed(dt);
  updateAmbient(dt);
  updateContracts(w, (c) => completeContract(w, c));
  updateExplored(dt);
  updateHotspotVisit(w, dt);
  updateTraces(w, dt);
  fireLootWaves(w);
  input.firePressed = false;
  // 跳跃是边沿事件：player.update 消费后这里再兜一次底（死亡/绳索/驾驶期间没人消费）。
  input.jumpPressed = false;

  // 撤离点按各自的 openAt 依次开启；限时点过了窗口就永久关闭（P20）。
  // 只在状态真的变化时发 toast，不进每帧的刷屏路径。
  // openAt 与 w.time 同为「经过秒数」；缺字段按 0 处理（测试手搓的 map 没有 openAt）。
  for (const ex of w.map.extracts) {
    if (ex.open) {
      // 拉闸窗口超时：与限时点同口径，只播一次并永久关闭（否则 HUD 仍显示 OPEN）。
      if (ex.requiresSwitch && ex.switchPulledAt != null
        && w.time - ex.switchPulledAt > EXTRACT_TUNING.switchDelay) {
        ex.open = false;
        ex.closedBySystem = true;
        ui.toast(`${ex.name} 的闸口窗口已关闭`);
        if (audio && audio.warn) audio.warn();
        continue;
      }
      // 限时窗口关闭：只播一次，并标记为系统关闭（extractState 会读它）
      if (ex.window && !ex.closedBySystem && w.time > ex.window.to) {
        ex.open = false;
        ex.closedBySystem = true;
        ui.toast(`${ex.name} 的撤离窗口已关闭`);
        if (audio && audio.warn) audio.warn();
      }
      continue;
    }
    if (ex.closedBySystem || w.time < (ex.openAt || 0)) continue;
    ex.open = true;
    const fee = ex.kind === 'paid' ? `（手续费 ${money(ex.cost || MATCH.extractFee)}）` : '';
    const mod = modifierLabel(ex);
    const modText = mod && mod !== '常规' ? ` · ${mod}` : '';
    const noMore = w.map.extracts.every((p) => p.open || p.closedBySystem);
    ui.toast(`${ex.name} 已开放${fee}${modText}${noMore ? ' · 最后一处出口' : ''}`);
    if (audio && audio.warn) audio.warn();
  }

  if (!w.over) {
    if (w.player.dead) endRaid('dead');
    else if (w.timeLeft <= 0) endRaid('timeout');
  }
}

function frame(ts) {
  window.requestAnimationFrame(frame);
  if (faulted) return; // P0-1：熔断后空转，等待玩家在故障浮层里选择「继续尝试 / 重新加载」
  const dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0.016;
  lastTs = ts;

  // 手机端每帧对齐触屏控制的激活状态（面板开关 / 横竖屏切换都由它统一收敛）
  if (touchMode) updateTouchState();

  // P0-1：把主循环里会抛错的区段各自包住，错误交给 guard 累计；连续同指纹 3 帧即熔断。
  let threw = false;
  try {
    if (screen === 'battle' && world && !paused) {
      updateAim();
      update(dt);
    }
  } catch (err) {
    threw = true;
    frameError(err);
  }
  try {
    if ((screen === 'battle' || screen === 'result') && world) {
      renderer.render(world, dt, false);
      ui.renderHud(world, dt, paused || screen === 'result');
    }
  } catch (err) {
    threw = true;
    frameError(err);
  }
  // V-05：帧采样（纯观测）。renderer.info 在渲染后是本帧数据；Noop 渲染器没有 handle，记 0。
  {
    const info = sceneHandle && sceneHandle.renderer && sceneHandle.renderer.info
      ? sceneHandle.renderer.info.render : null;
    perfMonitor.sample(dt * 1000, info ? info.calls : 0, info ? info.triangles : 0);
  }
  if (!threw) resetFrameStreak();

  // P1-6 换弹进度环：开火键外圈按换弹进度填充，换弹结束自动消失
  if (touchControls) {
    const wpn = world && world.player ? world.player.currentWeapon : null;
    const reloading = !!(screen === 'battle' && wpn && wpn.reloading && wpn.reloadTotal > 0);
    touchControls.setReload(reloading, reloading ? 1 - wpn.reloadTimer / wpn.reloadTotal : 0);
  }

  // 该锁定却没锁定 → 明确提示玩家点画面恢复，而不是让他们以为输入坏了
  ui.setLockHint(wantsMouseLock() && !input.locked);
}

/**
 * P0-1 致命故障浮层：游戏运行时崩了不再白屏卡死，给玩家可操作的出口。
 * 只依赖 DOM（无第三方），且在没有 document.body 的环境（Node 测试）下安全降级为 console.error。
 * @param {object} report buildReport 产出的现场摘要
 */
function showFaultOverlay(report) {
  faulted = true;
  if (typeof document === 'undefined' || !document.body) {
    console.error('[搜打撤] 致命错误：', report);
    return;
  }
  const box = document.createElement('div');
  box.id = 'guard-fault';
  box.style.cssText = 'position:fixed;inset:0;z-index:9998;display:flex;flex-direction:column;'
    + 'align-items:center;justify-content:center;gap:12px;background:rgba(8,11,16,.94);'
    + 'color:#d7dee8;font-family:system-ui,sans-serif;text-align:center;padding:24px';
  const title = document.createElement('div');
  title.textContent = '运行出错 · 已暂停';
  title.style.cssText = 'font-size:18px;font-weight:700;color:#ff6a4d';
  const msg = document.createElement('div');
  msg.textContent = (report && report.message) || '未知错误';
  msg.style.cssText = 'font-size:13px;max-width:34em;line-height:1.6;color:#aeb9c6;word-break:break-word';
  const fp = document.createElement('div');
  fp.textContent = '指纹：' + ((report && report.fingerprint) || '-');
  fp.style.cssText = 'font-size:11px;color:#6b7888;max-width:34em;word-break:break-all';
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-top:8px';
  const mk = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'min-width:120px;min-height:44px;padding:10px 16px;font-size:14px;'
      + 'border-radius:10px;border:1px solid #2b3a4d;background:#16202c;color:#d7dee8;cursor:pointer';
    b.addEventListener('click', fn);
    row.appendChild(b);
  };
  mk('重新加载', () => location.reload());
  mk('继续尝试', () => {
    faulted = false;
    clearFatal();
    if (box.parentNode) box.parentNode.removeChild(box);
  });
  mk('导出存档', () => {
    const raw = Storage.exportSaveString();
    const blob = new Blob([raw || '{}'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'soudache-save-' + Date.now() + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  mk('复制错误', () => {
    const txt = JSON.stringify(report || {}, null, 2);
    if (navigator.clipboard) navigator.clipboard.writeText(txt).catch(() => {});
  });
  box.append(title, msg, fp, row);
  document.body.appendChild(box);
}

/* ============================ UI 动作 ============================ */

// P6 改枪台：装配/卸下附件的**唯一实现**——UI 动作与调试入口（window.SOUDACHE.gunbench.setMod）
// 都走这里，避免两套逻辑漂移。role ∈ {primary, secondary}，slot ∈ WEAPON_MOD_SLOTS，
// modId 为附件 id 或 ''/null（卸下）。只写存档 + 重绘战前屏，不碰正在进行的战局。
function applySetMod(role, slot, modId) {
  const who = role === 'secondary' ? 'secondary' : 'primary';
  const id = modId || null;
  if (!slot || !WEAPON_MOD_SLOTS.some((s) => s.id === slot)) return;
  if (id) {
    const mod = WEAPON_MODS[id];
    if (!mod || mod.slot !== slot) return; // 槽位不符的附件拒绝装配
  }
  const mods = normalizeWeaponMods(save.loadout.mods);
  mods[who][slot] = id;
  save.loadout.mods = mods;
  Storage.scheduleSave(save);
  ui.renderLoadout(save);
  if (audio && audio.ui) audio.ui(0.4);
}

const ui = createUI(uiRoot, {
  'goto-menu': () => go('menu'),
  // 右键返回（ui.handleBack 在最内层面板都关完后落到这里）：与 Esc 语义一致。
  // battle 无面板 → 暂停/恢复；其它屏 → 回主菜单。面板层已由 ui.handleBack 消费。
  back: () => {
    if (screen === 'battle') setPaused(!paused);
    else if (screen !== 'menu') go('menu');
  },
  'goto-loadout': () => {
    refreshLoadout();
    go('loadout');
  },
  'goto-stash': () => {
    ui.renderStash(save);
    go('stash');
  },
  'goto-shop': () => {
    advanceOrders();
    ui.renderShop(save);
    go('shop');
  },
  // P10 生涯屏：进屏时推进到点委托单，保证「倒计时结束就该到账」。
  'goto-career': () => {
    advanceOrders();
    ui.renderCareer(save);
    go('career');
  },
  'goto-upgrades': () => {
    ui.renderUpgrades(save);
    go('upgrades');
  },
  // P15：干员屏（原 nav 里的 locked / P5 占位已转正）。
  'goto-operators': () => {
    ui.renderOperators(save);
    go('operators');
  },
  'buy-upgrade': (data) => buyUpgrade(data.id),
  'goto-howto': () => go('howto'),
  // 致谢屏是纯静态面板，不读存档；留成独立动作而不是塞进既有屏，避免误惹渲染逻辑。
  'goto-credits': () => go('credits'),
  'goto-codex': () => {
    ui.renderCodex(save);
    go('codex');
  },
  // 每日突袭：复用 setSeed / refreshLoadout / go，不新写部署流程
  'daily-raid': () => {
    const seed = Storage.dailySeed();
    ui.setSeed(seed);
    refreshLoadout();
    go('loadout');
    const done = save.daily && save.daily.date === String(seed) && save.daily.extracted;
    ui.toast(`每日突袭 · 今日种子 ${seed}${done ? ' · 今日已通关' : ''}`);
  },
  'toggle-insurance': () => {
    save.insurance = save.insurance || { enabled: false };
    save.insurance.enabled = !save.insurance.enabled;
    Storage.saveGame(save);
    ui.renderLoadout(save);
    audio.ui(0.4);
  },
  // 选图：UI 负责高亮，main 只校验 id 并把结果写回 UI。
  // 未知 id（旧 DOM / 手改 DOM）不静默吞掉，toast 说明并回落到默认图。
  'select-map': (data) => {
    const id = data && data.map;
    if (!MAPS[id]) {
      ui.toast('未知地图，已切回默认地图');
      ui.setMap(DEFAULT_MAP_ID);
      return;
    }
    ui.setMap(id);
    audio.ui(0.4);
    ui.toast(`已选择地图 · ${MAPS[id].name} · ${MAPS[id].tagline}`);
  },
  // P15 风险分级：写存档 + 重渲染战前屏（选中态由 renderLoadout 统一同步）。
  // 逻辑层必须再校验一次 id：UI 的 data-risk 可以被手改，不能只靠前端过滤。
  'set-risk': (data) => {
    const id = data && data.risk;
    const r = getRisk(id);
    if (r.id !== id) {
      ui.toast('未知风险等级');
      audio.error();
      return;
    }
    save.risk = r.id;
    Storage.saveGame(save);
    ui.renderLoadout(save);
    audio.ui(0.4);
    ui.toast(`风险等级 · ${r.label} · ${r.desc}`);
  },
  deploy,
  'set-loadout': (data) => {
    const slot = data.slot;
    save.loadout[slot] = data.value === '' ? null : data.value;
    // P7：换枪后口径可能变了（步枪→冲锋枪），把弹种选择重新对齐；
    // 这样不会出现"选了 5.56 AP 却拿着 9mm 冲锋枪"的错配。
    if (slot === 'primary' || slot === 'secondary') {
      normalizeLoadoutAmmo(save.loadout, WEAPONS);
    }
    Storage.saveGame(save);
    ui.renderLoadout(save);
    audio.ui();
  },
  // 干员切换（P5）：只写存档 + 重渲染战前屏。技能状态在 startRaid 才创建，
  // 所以这里不需要（也不应该）碰正在进行的战局。
  // W3 一键配装：从仓库现有装备里挑最优，替换 loadout 的 8 槽（弹药不动）。
  // 只写存档 + 重渲染；改装/扣仓都在 deploy/endRaid 时按新 loadout 走，无需额外同步。
  'auto-equip': () => {
    const { loadout, changed, missing } = autoEquip(save.stash, save.loadout);
    save.loadout = loadout;
    normalizeLoadoutAmmo(save.loadout, WEAPONS);
    Storage.saveGame(save);
    ui.renderLoadout(save);
    const msg = missing.length
      ? `一键配装完成（${changed.length} 槽更新，${missing.length} 槽仓库无货）`
      : `一键配装完成（${changed.length} 槽更新）`;
    ui.toast(msg);
    audio.ui();
  },
  // W3 快捷配装：套用三套预设之一。预设里若含仓库没有的装备，仍允许套用，
  // 但 validateLoadout 会在部署时拦下（与手动拖错槽同一条校验），不会白送装备。
  'apply-preset': (data) => {
    const preset = QUICK_PRESETS.find((p) => p.id === data.preset);
    if (!preset) return;
    const { loadout, changed } = applyPreset(save.loadout, preset.gear);
    save.loadout = loadout;
    normalizeLoadoutAmmo(save.loadout, WEAPONS);
    Storage.saveGame(save);
    ui.renderLoadout(save);
    ui.toast(`${preset.name}方案已套用（${changed.length} 槽）`);
    audio.ui();
  },
  // C-2 一键补齐配装：preview 只算清单（ui 用它弹确认框），loadout 才真正扣款。
  // 执行全程走现有 buy(id)（资金/声望/每日额度/库存/限购全在里面判），不另起扣钱逻辑。
  'restock-preview': () => {
    const todayStr = String(Storage.dailySeed());
    const lv = Storage.repLevel((save.rep && save.rep.xp) || 0);
    return planRestockLoadout(save.loadout, {
      currency: save.currency,
      remaining: (id) => shopRemaining(save, id, todayStr),
      unlocked: (id) => lv >= (SHOP_TIER[id] || 1),
    });
  },
  'restock-loadout': (plan) => {
    if (!plan || !Array.isArray(plan.lines) || !plan.lines.length) return;
    const before = save.currency;
    const filled = [];
    const skipped = [];
    for (const line of plan.lines) {
      let bought = 0;
      for (let i = 0; i < line.qty; i += 1) {
        const cur = save.currency;
        buy(line.id); // 唯一交易入口：售罄/声望/资金不足时只 toast，不扣钱
        if (save.currency < cur) bought += 1;
        else { skipped.push(line.label); break; }
      }
      if (!bought) continue;
      // 买进仓库后落槽：deploy 时会按 loadout 从 stash 扣，不会凭空发装备。
      if (line.slot === 'ammo') {
        const map = save.loadout.ammo || (save.loadout.ammo = {});
        map[line.id] = (Number(map[line.id]) || 0) + bought;
      } else {
        save.loadout[line.slot] = line.id;
        filled.push(line.slot);
      }
    }
    normalizeLoadoutAmmo(save.loadout, WEAPONS);
    Storage.saveGame(save);
    ui.renderLoadout(save);
    ui.renderShop(save);
    const spent = before - save.currency;
    const miss = skipped.length ? `，${skipped.length} 项因资金/额度跳过：${[...new Set(skipped)].join('、')}` : '';
    ui.toast(`已补齐 ${filled.length} 槽 · 花费 ¥${spent.toLocaleString('en-US')}${miss}`, skipped.length ? 'warn' : 'info');
    if (spent > 0) audio.cash();
  },
  'set-operator': (data) => {
    const op = getOperator(data.operator);
    if (save.operator === op.id) return;
    save.operator = op.id;
    Storage.saveGame(save);
    ui.renderLoadout(save);
    // P15：干员档案屏也读同一份存档 —— 不刷新的话，从档案屏切人会留着旧的「出战」标记。
    if (ui.renderOperators) ui.renderOperators(save);
    audio.ui(0.5);
  },
  // P15 小队编成：两席各可换人。目标干员已被另一席占用时自动交换，
  // 绝不出现「两个一模一样的队友代号」。未知 id / 点自己 → 无变化，不写存档。
  'set-squad': (data) => {
    const slot = Number(data.slot) === 1 ? 1 : 0;
    const before = resolveSquadIds(save.squad, save.operator).map((o) => o.id);
    const after = assignSquadSlot(save.squad, save.operator, slot, data.operator);
    if (after.join(',') === before.join(',')) return;
    save.squad = after;
    Storage.saveGame(save);
    ui.renderLoadout(save);
    audio.ui(0.4);
    const op = after.map((id) => getOperator(id));
    ui.toast(`小队编成 · ${op.map((o) => o.callsign).join(' / ')}`);
  },
  // P6 改枪台：见 applySetMod（唯一实现）。
  'set-mod': (data) => applySetMod(data.role, data.slot, data.modId || null),
  'step-loadout': (data) => {
    const kind = String(data.kind || '');
    const delta = Number(data.delta) || 0;
    if (kind.startsWith('ammo:')) {
      // P7：弹种盒数走 loadout.ammo；上限 6 盒（与旧 UI 的 0~4 上限相比留出混装空间）
      const id = kind.slice(5);
      setAmmoBoxes(save.loadout, id, loadoutAmmoBoxes(save.loadout, id) + delta, 6);
    } else {
      const next = Math.max(0, Math.min(6, (save.loadout[kind] || 0) + delta));
      save.loadout[kind] = next;
    }
    Storage.saveGame(save);
    ui.renderLoadout(save);
    audio.ui(0.4);
  },
  buy: (data) => buy(data.id),
  'buy-listing': buyListing,
  sell: (data) => sell(data.uid),
  'sell-all': sellAll,
  // P10：委托单与生涯奖励。发钱幂等由 economy.js 的 claimed 标记保证。
  'list-item': (data) => listItem(data.uid),
  'cancel-order': (data) => cancelOrderHandler(data.key),
  'claim-achievement': (data) => claimCareerReward('achievement', data.id),
  'claim-quest': (data) => claimCareerReward('quest', data.id),
  'claim-rep': (data) => claimCareerReward('rep', data.level),
  'claim-all-career': claimAllCareerRewards,
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
    if (ui.isLootGridOpen()) ui.closeLootGrid();
    openContainer = null;
    syncPointerLock();
  },
  // P18 双栏搜刮的副作用钩子：音效 / 图鉴 / 丢弃全部回到 main，
  // UI 层不直接碰存档、音频与玩家数据（单向依赖）。
  'loot-sound': (kind) => {
    if (!audio) return;
    if (kind === 'error') audio.error();
    else if (kind === 'pickup') audio.pickup();
    else audio.ui(0.4);
  },
  'loot-change': () => {
    if (!world) return;
    // 图鉴只记 seen；落盘统一在 endRaid 那次 saveGame，避免每拿一件写一次 localStorage。
    save.codex = save.codex || { seen: {}, brought: {} };
    for (const c of world.player.containers) {
      for (const it of c.items) save.codex.seen[it.id] = true;
    }
    // 搜空自动收面板，避免玩家对着空箱子继续点。
    if (openContainer && !(openContainer.loot || []).length) {
      ui.closeLootGrid();
      openContainer = null;
      syncPointerLock();
    }
  },
  'loot-discard': (data) => dropItem(data.uid),
  'backpack-close': () => {
    ui.closeBackpack();
    syncPointerLock();
  },
  drop: (data) => dropItem(data.uid),
  'use-item': (data) => {
    if (!world || world.over || !world.player) return;
    // P7：点击使用与 Q 键共用 Player.startUseItem —— 可用性判定（有没有骨折/出血/
    // 护甲受损）不会出现"Q 不让用、点物品却能读条"的两套口径。
    world.player.startUseItem(data.uid, world);
  },
  'toggle-invert': () => {
    save.settings.invertMouseX = !save.settings.invertMouseX;
    input.invertMouseX = save.settings.invertMouseX;
    Storage.saveGame(save);
    updateInvertLabel();
    ui.toast(save.settings.invertMouseX ? '鼠标水平轴：反转' : '鼠标水平轴：正常');
  },
  'toggle-invert-y': () => {
    save.settings.invertY = !save.settings.invertY;
    input.invertY = save.settings.invertY;
    Storage.saveGame(save);
    updateInvertLabel();
    ui.toast(save.settings.invertY ? '视角Y轴：反转' : '视角Y轴：正常');
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
  // P3 调色：数值一律经 clampGrade 钳制，UI 传来的字符串 / 越界值都不会把画面调成全黑。
  'set-grade': (data) => {
    const key = data && data.key;
    if (key !== 'exposure' && key !== 'contrast' && key !== 'saturation') return;
    const next = { ...resolveGrade(save), [key]: Number(data.value) };
    const applied = clampGrade(next);
    save.settings.grade = applied;
    Storage.saveGame(save);
    if (typeof renderer.setGrade === 'function') renderer.setGrade(applied);
    else if (sceneHandle && typeof sceneHandle.setGrade === 'function') sceneHandle.setGrade(applied);
    if (ui.updateGradeLabels) ui.updateGradeLabels(applied);
  },
  'reset-grade': () => {
    const applied = clampGrade();
    save.settings.grade = applied;
    Storage.saveGame(save);
    if (typeof renderer.setGrade === 'function') renderer.setGrade(applied);
    else if (sceneHandle && typeof sceneHandle.setGrade === 'function') sceneHandle.setGrade(applied);
    if (ui.updateGradeLabels) ui.updateGradeLabels(applied);
    ui.toast('调色已恢复默认');
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
}, {
  // 无障碍（P1-7）：系统开了「减少动态效果」时，HUD 只保留信息、不保留闪烁/弹动
  reducedMotion: device.reducedMotion,
  // UI 点击音：走音频总线（受音量/静音统一管理），采样没就绪时自动退回合成短音
  audio,
});

// 手机端任务面板入口：命中区是 DOM（canvas 是 pointer-events:none，收不到触摸），
// 矩形由 renderHud 每帧从 L.tasks 同步，这里只负责把点击接到已有的 toggleTasks。
const tasksTap = document.querySelector('[data-role="tasks-tap"]');
if (tasksTap) {
  tasksTap.addEventListener('click', () => {
    if (screen !== 'battle' || paused) return;
    ui.toggleTasks();
    audio.ui(0.4); // 让玩家确知"这一下点到了"
  });
}

/* ============================ 输入 ============================ */

// 首次交互才能建 AudioContext（浏览器自动播放策略）。建完顺手预载采样音：
// 采样是"有就更好"，加载失败只会退回合成音，所以不 await、不报错。
window.addEventListener('pointerdown', () => { audio.ensure(); audio.preloadSamples(); }, { once: true });

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

// 浏览器拒绝锁定（多半是 Esc 之后的限流）时不再另发 toast：
// setLockHint() 每帧按 wantsMouseLock() && !input.locked 兜住同一句提示，
// 再发一条 toast 会在准星下方叠出两行一样的字（P1 截图复核发现）。
document.addEventListener('pointerlockerror', () => {
  if (screen === 'battle' && !paused) ui.setLockHint(true);
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
  input.jumpPressed = false;
  input.lean = 0;
  // 蹲伏：按住态必须清（键松了但事件丢了）；切换态与卧倒是玩家意图，保留。
  releaseStanceHolds(stanceState, input);
  input.ads = false;
});

window.addEventListener('keydown', (ev) => {
  const key = ev.key.toLowerCase();
  if (screen !== 'battle') {
    if (key === 'escape' && screen !== 'menu') go('menu');
    return;
  }
  // 双栏搜刮面板打开时吞掉所有游戏按键（Esc / R / T / G / Delete 由面板自己处理）。
  // 必须先于移动与开火分支，否则按 W 会在拖拽时把角色带走。
  if (ui.isLootGridOpen()) {
    if (ui.lootGridKey(key, ev)) return;
  }
  // 旧键盘抽屉：仅在双栏面板关闭时兜底（保留给未接双栏的入口）。
  if (ui.isLootOpen()) {
    handleLootKeys(key, ev);
    return;
  }
  switch (key) {
    case 'w': case 'arrowup': input.up = true; break;
    case 's': case 'arrowdown': input.down = true; break;
    // 探头（P19 的能力）挪到 Alt 修饰键：Z/C 这两个位置必须让给"卧倒/蹲下"，
    // 否则三角洲肌肉记忆（Z 趴下、C 蹲下）全部落空。
    case 'a':
      if (ev.altKey) {
        ev.preventDefault();
        if (!ev.repeat) input.lean = -1;
      } else input.left = true;
      break;
    case 'arrowleft': input.left = true; break;
    case 'd':
      if (ev.altKey) {
        ev.preventDefault();
        if (!ev.repeat) input.lean = 1;
      } else input.right = true;
      break;
    case 'arrowright': input.right = true; break;
    case 'shift': input.sprint = true; break;
    // 蹲伏：Ctrl 按住（老习惯）/ C 切换（三角洲键位）。两条路都只改原值，由 stance.js 合成。
    case 'control':
      if (!ev.repeat) setCrouchHold(stanceState, input, true);
      break;
    case 'c':
      if (!ev.repeat) toggleCrouch(stanceState, input);
      break;
    // Z：卧倒切换（三角洲 Z = 趴下）
    case 'z':
      if (!ev.repeat) toggleProne(stanceState, input);
      break;
    // 空格：跳跃 / 翻越（正前方有掩体箱时自动变成翻越）
    case ' ':
      ev.preventDefault();
      if (!ev.repeat) input.jumpPressed = true;
      break;
    case 'tab':
      ev.preventDefault();
      if (!ev.repeat) toggleBackpack();
      break;
    case 'escape':
      ev.preventDefault();
      if (!ev.repeat) {
        // Esc 优先关掉已打开的面板（浏览器已经顺带解除了指针锁定），
        // 没有面板时才进暂停 —— 否则背包/战利品会卡住关不掉。
        if (ui.isBackpackOpen() || ui.isLootOpen() || ui.isLootGridOpen()) {
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
    // W2：近战。B 键（Blade）—— 与 V 绳索、F 载具、G 战术、X 终结技都不冲突，
    // 且离左手常用位置近，贴脸缠斗时不用低头发觉按错了键。
    case 'b':
      if (!ev.repeat) world.player.meleeAttack(world);
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
    // P5：G 投掷战术道具、X 终结技。两个键刻意和开火/换弹分开，
    // 避免在高压交火里误触（R 换弹、F 载具、V 绳索都已占用）。
    case 'g':
      if (!ev.repeat) throwTactical();
      break;
    case 'x':
      if (!ev.repeat) releaseUltimate();
      break;
    case '1':
      if (!ev.repeat) world.player.switchWeapon(0, world);
      break;
    case '2':
      if (!ev.repeat) world.player.switchWeapon(1, world);
      break;
    // W2：快捷栏 3 = 手枪（HUD 一直是 4 格布局：三把枪 + 医疗，这里补上第 3 把的入口）
    case '3':
      if (!ev.repeat) world.player.switchWeapon(2, world);
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

// 多目标堆叠：滚轮切换当前高亮的可搜目标（ui.js 的小地图缩放监听先注册并打 __mmHandled，
// 命中小地图时这里跳过）。方向键上下被移动占用，所以用滚轮作为主控方式。
window.addEventListener('wheel', (ev) => {
  if (screen !== 'battle' || !world || ev.__mmHandled) return;
  if (ui.isLootGridOpen() || ui.isLootOpen() || world.player.busy) return;
  const targets = world.player.availableTargets(world);
  if (targets.length < 2) return; // 只有一个目标时没必要切，保持游标不动
  world.player.cycleInteraction(world, ev.deltaY > 0 ? 1 : -1);
  ev.preventDefault();
}, { passive: false });

window.addEventListener('keyup', (ev) => {
  const key = ev.key.toLowerCase();
  switch (key) {
    case 'w': case 'arrowup': input.up = false; break;
    case 's': case 'arrowdown': input.down = false; break;
    case 'a': input.left = false; if (input.lean === -1) input.lean = 0; break;
    case 'arrowleft': input.left = false; break;
    case 'd': input.right = false; if (input.lean === 1) input.lean = 0; break;
    case 'arrowright': input.right = false; break;
    case 'shift': input.sprint = false; break;
    case 'control': setCrouchHold(stanceState, input, false); break;
    // 松 Alt 一律收探头：Alt 是姿态修饰键，松开就回到中立位。
    case 'alt': input.lean = 0; break;
    default: break;
  }
});

/* ============================ 视口自适应 ============================ */

window.addEventListener('resize', () => {
  if (renderer && typeof renderer.resize === 'function') renderer.resize();
});

/* ============================ 启动 ============================ */

go('menu');
// P0-1 全局错误边界：任何未捕获错误 / 主循环连续同指纹报错都会进入可恢复浮层，而不是白屏卡死。
installGuard({ onFatal: showFaultOverlay });
// P0-2 存档写入失败时不再静默：至少弹一次提示，避免玩家一局白打还不知道。
Storage.setSaveErrorHandler((info) => {
  if (ui && ui.toast) ui.toast('存档保存失败：存储空间不足或隐私模式，进度可能未保存', 'error');
});
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
  /**
   * 局内 three 场景实例（只读调试口）。
   * 给 A/B 探针用：做材质/光照对照实验时必须在真实场景里换材质再截图，
   * 否则只能靠"看起来像"，那正是假绿的来源。生产代码不要依赖它。
   */
  get scene3d() {
    return (renderer && renderer.handle && renderer.handle.scene) || null;
  },
  device,
  touchMode,
  touchControls,
  updateTouchState,
  refreshTouchContext,
  startRaid,
  endRaid,
  /**
   * 「如果现在就撤」的局内目标加成。结算页评分里含这一项，探针必须能从同一个口子复算 ——
   * 手写一个分数区间去逼近，正是假绿的温床。
   * @returns {number} 加成分数
   */
  objectiveBonus() {
    if (!world || !world.player) return 0;
    const p = world.player;
    const carried = p.carriedItems ? p.carriedItems().length : 0;
    // 与 endRaid 的 broughtOut 口径对齐：随身物资 + 身上装备（护甲 + 每把枪各算一件）。
    // 少算装备会让「带回 N 件」类目标差 1，探针复算的分数就对不上。
    const gear = (p.weapons || []).length
      + (p.armorDef && p.armorDef.id !== 'none' ? 1 : 0);
    const st = settleObjectives(world.objectives, {
      world,
      carriedValue: p.carriedValue || 0,
      carriedCount: carried + gear,
      success: true,
    });
    return st.bonus;
  },
  // P20 调试口：无头软渲染跑不到 3 分钟，探针只能把战局时间「快进」到补货波次。
  // 只暴露「推一次真实 update」与「把时间设到某秒」，不提供任何跳过判定的后门。
  tick(dt = 1 / 60) { if (world) update(dt); },
  seek(sec) { if (world) world.time = Math.max(0, Number(sec) || 0); },
  // P10 调试口：探针需要主动推进委托单与读取生涯配置常量。
  advanceOrders,
  CAREER,
  COLORS,
  PLAYER,
  // 评分档位表：探针要按同一张表复算「印章等级 / 距下一档」，而不是硬编码一个分数区间。
  SCORING,
  // 战斗 HUD 布局的单一真值源：tools/check-touch-layout.mjs 读它取禁区矩形，
  // 避免"实拍量取百分比"那种会漏项、会漂移的硬编码。
  hudLayout,
  // 中层任务面板的展开状态。探针需要**读到真实状态**才能验证 J 键真的切了 ——
  // 之前只能靠"按完没报错"推断，那是弱证据：按键绑错了也照样不报错。
  isTasksOpen: ui.isTasksOpen,
  toggleTasks: ui.toggleTasks,
  // P5：探针要真的走到战前配置屏读干员卡 DOM、并点一张卡验证委托事件，
  // 所以把 ui 与屏幕切换放出来（与 hudDebug 同属只读/调试用途，游戏逻辑不依赖它们）。
  ui,
  go,
  // P6 改枪台：把纯逻辑层函数放出来，探针可直接驱动（不依赖 DOM 点击路径）。
  // setMod 与 'set-mod' handler 行为一致，便于无头环境下程序化装配并验证本局 cfg 数值。
  gunbench: {
    applyWeaponMods,
    normalizeWeaponMods,
    computeEffectiveWeapon,
    attachmentOptions,
    loadoutModWeight,
    effectiveStatsPreview,
    // 与 'set-mod' handler 共用 applySetMod，保证两条入口行为一致。
    setMod: (role, slot, modId) => applySetMod(role, slot, modId || null),
  },
  // P7：弹药配装读口（探针 / 控制台调试），只读查询 + 与 UI 同一个写入口。
  ammo: {
    ids: AMMO_IDS,
    calibers: CALIBERS,
    boxes: loadoutAmmoBoxes,
    resolve: (role) => resolveAmmoGrade(save.loadout, role || 'primary', WEAPONS),
    setBoxes: (id, n) => {
      setAmmoBoxes(save.loadout, id, n, 6);
      Storage.saveGame(save);
      return loadoutAmmoBoxes(save.loadout, id);
    },
  },
  // P1：HUD 调试读口（缩放档 / 命中区 / 低血量），探针用，只读
  hudDebug: ui.hudDebug,
  // 渲染器句柄（含 .handle.scene / .handle.camera），仅供探针/调试遍历使用。
  renderer,
  // V-05：性能采样读口（只读快照 + reset），探针用它核对预算
  perf: {
    snapshot: () => perfMonitor.snapshot(),
    reset: () => perfMonitor.reset(),
  },
  // P23：外部资源管线的真实状态。探针靠它区分"GLB 真加载了"和"静默降级成程序化模型"——
  // 只看页面没报错是弱证据，两种情况下页面都不报错。
  assets: { status: assetStatus },
  // P3：调色读口与分区混合读口（探针直接读，不必反解 uniform）
  get grade() {
    return resolveGrade(save);
  },
  get zoneMix() {
    return sceneHandle ? sceneHandle.zoneMix : 0;
  },
  get lampSites() {
    return (renderer.level && renderer.level.lampSites) || [];
  },
  // W0：局外 3D 预览容器（改枪台/装备/干员共用）。挂调试口是为了让探针能
  // 在真实浏览器里建容器、读 snapshot 真值（draws/triangles/yaw），不靠截图猜。
  preview3d: { createPreview, PREVIEW3D, fitDistance },
  /**
   * W2：装备屏角色预览的真值快照（只读）。
   * 探针用它证明"模型真的挂上去了、在转、没被裁切"，而不是靠截图猜 ——
   * 与改枪台读 gunbench 卡片里的 canvas 同一套原则。
   * @returns {object|null} 无 WebGL / 不在装备屏时为 null
   */
  charPreviewSnapshot() {
    const snap = charPreview ? charPreview.snapshot() : null;
    if (snap) snap.rel = charPreviewRel; // 探针用它判断"换装后模型是否真的重建"
    return snap;
  },
};

// P1-1 真机矩阵：?perf=1 时挂页内采集浮层，真机玩一局后一键复制性能报告。
// 纯调试功能，默认（无该参数）完全不加载 DOM、不建 observer，正常玩家零影响。
window.SOUDACHE.perfHud = installPerfHud({ perfMonitor, device, getWorld: () => world });
