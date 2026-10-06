/**
 * 入口：把「世界（舞台）+ 摄像机（镜头）+ 玩家（演员）」接起来，跑主循环。
 * ---------------------------------------------------------------------------
 * 启动顺序是刻意排的，出问题能一眼定位：
 *   WebGL 可用？ → 渲染器 → 世界（地形/光/障碍）→ 摄像机 → 玩家 → 主循环
 * 任何一步抛错，都会把错误**画在页面上**（而不是留一片黑屏让你猜）。
 *
 * 模块 2 的接线只有一条主线，别把它写散：
 *   InputState（窗口事件 → 动作语义）
 *     → PlayerController.update(dt, rig.yaw)（决策 + 运动学，见 player/）
 *     → updateMesh（把快照套到占位几何上）
 *     → CameraRig.setTarget/update（镜头跟随）
 * 鼠标增量单独走一条：InputState 攒增量 → rig.addLook（视角**不能**进平滑管线，见 cameraRig 注释）。
 */
import {
  AxesHelper,
  BoxGeometry,
  Clock,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  REVISION,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from '../vendor/three/three.module.js';

import { ARTS, BATTLEFIELD, BOSS, COMBAT, DEBUG, DEFENSE, ENEMY, ENEMY_AI, HUD, MORALE, MUSOU, PLAYER, POINTS, RENDER, STAGE, POSTFX, INKFX, ENVIRONMENT, GRASS, DECAL, TIME, HERO, INK_UI, AUDIO } from './core/config.js';
import { CameraRig, createCamera } from './core/cameraRig.js';
import { forwardVector, rightVector } from './core/cameraMath.js';
import { blockerShapes } from './core/battlefieldLayout.js';
import { buildWorld, configureRenderer } from './core/world.js';
import { InputState } from './player/input.js';
import { PlayerController } from './player/controller.js';
import { circleHitsOBB, jumpApex, jumpAirTime } from './player/motion.js';
import { PlayerCombat } from './combat/playerCombat.js';
import { TargetPool, trainingDummySpecs } from './combat/targets.js';
import { EnemyPool, enemySpawnSpecs } from './combat/enemies.js';
import { STATE_LABEL } from './combat/enemyAI.js';
import { createDummyMesh, updateDummyMesh } from './combat/dummyMesh.js';
import { EnemyRenderer } from './combat/enemyMesh.js';
import { DebugHud } from './ui/debugHud.js';
import { CombatUi } from './ui/combatUi.js';
import { MoveList } from './ui/moveList.js';
// ── 模块 5–8：无双/武艺(纯逻辑已在 playerCombat)、据点士气、关卡流程、Boss、正式战场 UI ──
import { CaptureSystem } from './game/points.js';
import { Stage } from './game/stage.js';
import { BossController } from './combat/boss.js';
import { BattleHud } from './ui/battleHud.js';
import { DefenseSystem } from './combat/defense.js';
// ── 模块 10/11：水墨后处理 / 环境氛围 / 风草 / 贴花 / 武将模型 / 时间通道 / 水墨战斗特效 / 战斗音效 ──
import { PostFX } from './core/postfx.js';
import { enhanceWorld } from './core/environment.js';
import { GrassField } from './render/grass.js';
import { DecalPool } from './render/decals.js';
import { createHeroMesh, updateHeroMesh } from './render/characters.js';
import { loadHeroAsset, createHeroMeshFromAsset, createSilhouette } from './render/heroAsset.js';
import { createInkOutline } from './render/inkOutline.js';
import { resolveOutlineStyle } from './render/heroMap.js';
import { TimeControl } from './core/timeControl.js';
import { InkFx } from './combat/inkFx.js';
import { AudioManager } from './audio/sfx.js';

const hud = new DebugHud();
const fatal = (msg) => {
  hud.set('warn', msg);
  const box = document.getElementById('fatal') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'fatal', className: 'fatal' }));
  box.textContent = `启动失败：${msg}`;
};
// 未捕获异常也要上屏：无头探针抓得到 console，但真人看页面时一片黑更让人抓狂
window.addEventListener('error', (e) => fatal(e.message));
window.addEventListener('unhandledrejection', (e) => fatal(String(e.reason?.message ?? e.reason)));

const canvas = document.getElementById('stage');
const boot = document.getElementById('boot');

// ─────────────────────────────────────────────── 渲染器
let renderer;
try {
  renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: RENDER.POWER_PREFERENCE });
} catch (err) {
  fatal(`WebGL 不可用：${err.message}`);
  throw err;
}
renderer.outputColorSpace = SRGBColorSpace;
renderer.setSize(window.innerWidth, window.innerHeight, false);
configureRenderer(renderer, { maxPixelRatio: RENDER.MAX_PIXEL_RATIO, exposure: RENDER.TONE_MAPPING_EXPOSURE });

// ─────────────────────────────────────────────── 场景 + 世界
const scene = new Scene();
scene.name = 'battlefield';

let world;
try {
  world = buildWorld(scene, renderer);
} catch (err) {
  fatal(`战场构建失败：${err.message}`);
  throw err;
}

// 坐标轴调试：opacity 用半透明，还是用"是否加入场景"更干净
const axes = new AxesHelper(6);
axes.visible = DEBUG.AXES_HELPER;
scene.add(axes);

// ⚠ 关键一步：射线求交读的是 matrixWorld，而 matrixWorld 是在 render() 里才更新的。
// 主循环是「rig.update() → render()」的顺序，不先算一次矩阵的话，
// 第一帧的碰撞检测会把所有障碍物都当成站在原点 —— 表现为"开局镜头穿进墙里一瞬间"。
scene.updateMatrixWorld(true);

const camera = createCamera(window.innerWidth / window.innerHeight);
// 形状表只有一份：相机看得懂、人也走不过去。"能挡镜头的东西"和"能挡住脚的东西"
// 用同一份数据，才不会出现"镜头撞墙了但人能穿过去"这种两边漂移。
const shapes = blockerShapes(world.layout);
const rig = new CameraRig(camera, {
  colliders: world.colliders,
  // 解析形状只用来判"注视点是否已在实体内部"（射线会被背面剔除骗过，见 cameraRig 注释）
  blockers: shapes,
});

// ─────────────────────────────────────────────── 输入（模块 2）
const input = new InputState(window).attach(canvas);
// 指针锁定的失败是"环境限制"而不是 bug；InputState 内部已经 catch 了 Promise 形式
canvas.addEventListener('click', () => { input.requestPointerLock(); audio.resume(); });

// ─────────────────────────────────────────────── 玩家（模块 2）
const player = new PlayerController({ input, shapes, spawn: world.layout.spawn });
// 默认用内置程序化 PBR 武将；若配置了 HERO.ASSET_PATH，异步加载外部 glTF/VRM 后无缝替换。
let playerMesh = createHeroMesh();
scene.add(playerMesh);

// 模块 12：墨色描边（反向外壳）。宽度是**屏幕像素**，所以要跟着视口高度走（见 resize）。
// 武将可能被外部资产整体替换，替换后要重新挂一次（旧的那批外壳随旧网格一起被移除）。
function attachHeroOutline(mesh) {
  if (!HERO.OUTLINE_ENABLED) return null;
  return createInkOutline(mesh, {
    widthPx: HERO.OUTLINE_WIDTH,
    color: HERO.OUTLINE_COLOR,
    resolution: { w: window.innerWidth, h: window.innerHeight },
  });
}
attachHeroOutline(playerMesh);

// 模块 12：外部角色资产加载（glTF / VRM）。加载期间显示水墨剪影占位；
// 加载失败 / 无资产 / 加载器缺失 → 保留程序化 PBR 武将，绝不黑屏。
if (HERO.ASSET_PATH) {
  const ph = createSilhouette();
  scene.add(ph);
  loadHeroAsset().then((asset) => {
    scene.remove(ph);
    if (!asset) return; // 失败：保留程序化武将
    const mesh = createHeroMeshFromAsset(asset);
    scene.add(mesh);
    scene.remove(playerMesh);
    playerMesh = mesh; // 循环每帧读此变量，替换无缝
    attachHeroOutline(mesh); // 外部资产换皮后重新挂描边
    if (window.MUSOU) {
      window.MUSOU.playerMesh = mesh;
      window.MUSOU.heroAssetLoaded = true; // 外部资产已成功加载
      window.MUSOU.placeholderMeshIsTemporary = false; // 已用外部资产
    }
  }).catch((e) => {
    scene.remove(ph);
    console.warn('[hero] 资产加载异常，保留程序化武将：', e && e.message);
  });
}

// ─────────────────────────────────────────────── 模块 10/11：水墨氛围 + 后处理 + 特效 + 音效
// ⚠ 全部可降级：任一模块初始化失败（如 WebGL2 不支持半浮点 RT）都不会让页面黑屏，
//    只是少一层效果；主循环里有 `?.` / 存在性判断兜底。
let postfx = null;
try { postfx = new PostFX(renderer, scene, camera); } catch (err) { console.warn('[PostFX] 跳过：', err && err.message); }
let env = null;
try { env = enhanceWorld(scene, world, renderer); } catch (err) { console.warn('[environment] 跳过：', err && err.message); }
let grassField = null;
try { grassField = new GrassField(scene); } catch (err) { console.warn('[grass] 跳过：', err && err.message); }
let decalPool = null;
try { decalPool = new DecalPool(scene); } catch (err) { console.warn('[decals] 跳过：', err && err.message); }
// ★SPEC(模块13) 土路墨晕边缘：开局一次性铺好（常驻布景，不进战斗墨渍的轮换池）
if (decalPool?.ok && world.layout?.roads?.length) {
  const roadDecals = decalPool.spawnRoadEdgeInk(world.layout.roads);
  if (roadDecals > 0) console.info(`[decals] 土路墨晕边缘 ${roadDecals} 张`);
}
const timeControl = new TimeControl();
const audio = new AudioManager();

// 开局别让镜头从原点飞过来：直接落到位、朝向也对上
rig.setTarget(player.position);
rig.setLook(world.layout.spawn.yaw, 0);
rig.pivot = { x: player.position.x, y: player.position.y + rig.cfg.PIVOT_HEIGHT, z: player.position.z };

// ─────────────────────────────────────────────── 战斗（模块 3）
// ⚠ 两个"池"同时存在，这是模块 4 之后的结构（理由见 enemies.js 文件头）：
//   · dummyPool —— 出生点正前方的**练武场**：5 个草人，满血、不动、打不死。
//     所有"这一刀打了几下、伤害对不对、硬直多长"的断言都挂在它们身上（可复现）。
//   · enemyPool —— 战场上的 **160 个敌人**：分三层 AI、成群移动、会死、会打你。
//   两者走的是**同一条命中结算**（PlayerCombat 扫全部池），所以"保留已有功能"
//   不是靠复制一份代码，而是靠只有一个实现。
const dummyPool = new TargetPool({
  specs: trainingDummySpecs(world.layout.spawn, shapes, { circleHitsOBB }),
});
const dummyMeshes = dummyPool.items.map((t) => {
  const m = createDummyMesh(t);
  scene.add(m);
  return m;
});

const enemyPool = new EnemyPool({
  specs: enemySpawnSpecs(world.layout.spawn, shapes, { circleHitsOBB }),
  aiEnabled: true, // ★模块 4：这里才真的把分层 AI 打开
});
const enemyRenderer = new EnemyRenderer(scene, { maxCount: ENEMY.COUNT + 64, stateRings: DEBUG.ENEMY_STATE_RINGS });

const combat = new PlayerCombat({ player, input, pools: [dummyPool, enemyPool] });
const inkFx = new InkFx(scene, { camera, timeControl, decals: decalPool, audio });
const combatUi = new CombatUi();
// 模块 7：正式战场 UI（BattleHud）接管了血条/无双槽/击杀/据点，旧的临时面板退役。
// 只隐藏它的文字面板；保留它的"受击红晕"作为玩家挨打反馈（flashHit 走的是独立的 vignette 元素）。
combatUi.root.classList.add('hidden');

// ── 模块 5–8 系统实例化 ─────────────────────────────────────────────
// 据点 + 士气（纯逻辑）；关卡流程（三阶段）；正式战场 UI
const capture = new CaptureSystem();
const stage = new Stage();
const battleHud = new BattleHud();
const defense = new DefenseSystem(); // 防御/卸势（2026-09-25，机制见 combat/defense.js）
// 开局就把同屏并发压到 STAGE.MAX_ACTIVE(45)，并把冗余敌人休眠；给据点指派守卫。
stage.start(enemyPool);
stage.setupGuards(enemyPool);

// Boss 作为 combat 的一个独立靶池存在（复用命中结算），但单独渲染、单独行为（BossController）。
// 开局不激活（alive=false），关卡推进到 boss 阶段触发时再摆位 + 实例化 BossController。
const bossPool = new TargetPool({ specs: [{ id: 'boss', x: 0, z: 0, hp: BOSS.HP, maxHp: BOSS.HP }] });
const bossTarget = bossPool.items[0];
bossTarget.radius = BOSS.RADIUS;
bossTarget.height = BOSS.HEIGHT;
bossTarget.alive = false;
bossTarget.guardOf = null;
bossTarget.dormant = false;
combat.pools.push(bossPool);
let boss = null; // BossController 实例（阶段触发时创建）
let bossMesh = null; // 独立网格
let victoryShown = false;
// 招式表 / 教学提示：按 N1、N2、C3、C4、C5 显示，**不出现 C1/C2**
// （C1/C2 就是 N1/N2 本身，一个动作两个名字只会让文案和数值各说各的）
const moveList = new MoveList();
// 右键是重攻击：不拦掉浏览器菜单的话，一按蓄力就弹出菜单，蓄力直接中断
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ─────────────────────────────────────────────── 键位（F2/F3/F4/F5 走输入层的钩子）
input.onKey = (code, down, e) => {
  if (!down) return;
  if (code === 'F3') {
    e?.preventDefault();
    hud.toggle();
  } else if (code === 'F2') {
    e?.preventDefault();
    moveList.toggle();
  } else if (code === 'F4') {
    e?.preventDefault();
    axes.visible = !axes.visible;
  } else if (code === 'F5') {
    // 分层 AI 的三态**肉眼看不出来**（都在走、都在转身，区别只在"有没有资格打你"）。
    // 这个色环是唯一能一眼验证"35 上限"和"22m 分界"的手段：灰=待机 / 白=威慑 / 红=攻击。
    e?.preventDefault();
    enemyRenderer.setStateRings(!enemyRenderer.rings.visible);
  } else if (code === AUDIO.MUTE_KEY) {
    // 模块 11：M 键静音切换，状态记忆（localStorage）
    e?.preventDefault();
    audio.toggleMute();
    console.log(`[audio] 静音状态：${audio.isMuted ? '已静音' : '开启'}`);
  }
};

// ─────────────────────────────────────────────── Boss 网格 + 出场（模块 8）
function createBossMesh() {
  const g = new Group();
  g.name = 'boss-mesh';
  const mat = new MeshStandardMaterial({ color: 0x6b1f1f, roughness: 0.7, metalness: 0.15 });
  const trim = new MeshStandardMaterial({ color: 0xc9a24a, roughness: 0.5, metalness: 0.4 });
  const body = new Mesh(new CylinderGeometry(BOSS.RADIUS * 0.85, BOSS.RADIUS, BOSS.HEIGHT * 0.62, 12), mat);
  body.position.y = BOSS.HEIGHT * 0.31;
  const head = new Mesh(new BoxGeometry(BOSS.RADIUS * 1.1, BOSS.HEIGHT * 0.32, BOSS.RADIUS * 1.1), mat);
  head.position.y = BOSS.HEIGHT * 0.66;
  const shoulders = new Mesh(new BoxGeometry(BOSS.RADIUS * 2.4, BOSS.HEIGHT * 0.16, BOSS.RADIUS * 1.1), trim);
  shoulders.position.y = BOSS.HEIGHT * 0.5;
  const blade = new Mesh(new BoxGeometry(0.12, BOSS.HEIGHT * 0.9, 0.12), trim);
  blade.position.set(BOSS.RADIUS * 1.3, BOSS.HEIGHT * 0.55, 0);
  for (const m of [body, head, shoulders, blade]) { m.castShadow = true; m.receiveShadow = true; g.add(m); }
  g.userData.body = body;
  return g;
}

// 出场：在玩家正前方 24m 摆位（钳到战场内），激活靶子，实例化 BossController + 网格，弹出 Boss 血条
function spawnBoss() {
  if (boss) return boss;
  const fx = -Math.sin(rig.yaw), fz = -Math.cos(rig.yaw);
  let bx = player.position.x + fx * 24;
  let bz = player.position.z + fz * 24;
  bx = Math.max(-90, Math.min(90, bx));
  bz = Math.max(-90, Math.min(90, bz));
  bossTarget.x = bx; bossTarget.z = bz; bossTarget.home = { x: bx, z: bz };
  bossTarget.hp = bossTarget.maxHp; bossTarget.alive = true;
  bossTarget.knockVX = 0; bossTarget.knockVZ = 0; bossTarget.stunTimer = 0; bossTarget.hitFlash = 0;
  boss = new BossController({ target: bossTarget });
  bossMesh = createBossMesh();
  bossMesh.position.set(bx, 0, bz);
  scene.add(bossMesh);
  battleHud.showBoss('敌军主将', boss.hpRatio);
  return boss;
}

// ─────────────────────────────────────────────── 视口
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  // 描边宽度是屏幕像素，换视口就要重设分辨率（否则窗口变高后描边按比例变粗）
  const ol = playerMesh.userData.inkOutline;
  if (ol) ol.setResolution(w, h);
}
window.addEventListener('resize', resize);
resize();

// ─────────────────────────────────────────────── 主循环
const clock = new Clock();
let frame = 0;
let fpsAccum = 0;
let cinnabarTimer = 0; // 模块 12：朱砂描边剩余时间（武艺/无双触发后倒数）
let fpsFrames = 0;
let fps = 0;
let lastDebug = rig.debug;
let snap = player.snapshot();
let simTime = 0; // 累计**仿真**时间（钳制后的 dt 之和）
let lastDt = 0;
let held = false; // 抓拍冻结位（见下方 MUSOU.hold）
let enemyHitsTaken = 0; // 玩家被敌人打中的累计次数（HUD 读数）
let degradeStep = 0;    // 性能降级档位 0=全开 1=关泛光 2=关草 3=关水墨粒子/残影
let lowFpsAccum = 0;    // 累计低帧时长（秒），用于触发降级

// 性能降级：按档位逐级关模块 10/11 的效果，保护模块 9 的 60fps 目标
function applyDegrade(step) {
  if (step >= 1 && postfx && postfx.ok) postfx.setBloomEnabled(false);
  if (step >= 2 && grassField) grassField.setVisible(false);
  if (step >= 3 && inkFx) inkFx.setDegrade({ ink: false });
}
// 敌人 AI 的 ctx：**复用同一个对象**。每帧新建一个的话，
// 60fps × 每秒 60 个对象不算什么，但里面装着 shapes 与 others 两个引用，
// 一旦哪天有人不小心把 others 写成新数组，就是每帧 160 元素的分配 —— 直接原地复用堵掉这条路。
const ectx = { x: 0, z: 0, invincible: false, shapes, others: dummyPool.alive };

function tick() {
  const raw = clock.getDelta();
  // 切标签页回来时 raw 可能是好几秒 —— 不钳住会让玩家瞬移、镜头猛甩
  let dt = Math.min(0.05, Math.max(0, raw));
  // ★ 抓拍冻结：把 dt 压成 0，仿真（连段 / 特效计时 / 位移）全停住，但**渲染继续跑**。
  //   为什么不干脆"不再排下一帧"：那样画面只能靠合成器残留，preserveDrawingBuffer=false
  //   时不保证还在；持续重绘同一状态才是稳的。刀光只亮 0.2s、火花只活 0.16s，而 CDP 一次
  //   captureScreenshot 往返就跨过整个窗口 —— 不冻结根本拍不到命中帧。
  if (held) dt = 0;
  // 通关后：冻结仿真、只保持渲染（结算面板已弹出），主循环继续存活以便探针/截图。
  if (victoryShown) {
    if (postfx) postfx.render(); else renderer.render(scene, camera);
    frame++;
    window.MUSOU.frame = frame;
    requestAnimationFrame(tick);
    return;
  }
  simTime += dt;
  lastDt = dt;

  input.update(dt);
  // 防御/卸势：必须在 combat.update 之前跑 —— 按住防御要先吃掉攻击键缓冲，
  // combat 才看不到（这样"防御中不出招"一行 combat 代码都不用改）。
  defense.update(dt, input);
  // 鼠标 → 视角。放在 player.update 之前：这一帧的移动方向要用**最新**的镜头朝向，
  // 否则快速转镜时的移动会慢半拍（手感上就是"转向不跟手"）。
  const look = input.consumeMouseDelta();
  if (look.dx || look.dy) rig.addLook(look.dx, look.dy);

  // 顿帧 + 慢动作：玩法时间先吃 combat 自己的顿帧（模块 3），再吃模块 10 的命中顿帧 / 无双慢动作
  // （timeControl 与 combat.playerTimeScale 共用"玩法时间"通道，不叠加到镜头/特效/草/天穹）。
  const ts = timeControl.update(dt);
  const pdt = dt * combat.playerTimeScale * ts;
  snap = player.update(pdt, rig.yaw);
  // 武将网格：根节点只负责"位置 + 朝向"，骨骼姿态交给 updateHeroMesh（模块 10 动画）
  playerMesh.position.set(snap.x, snap.y, snap.z);
  playerMesh.rotation.y = snap.facing;
  if (playerMesh.userData.lod) playerMesh.userData.lod.update(camera); // 模块12：按距离切换 LOD 层级
  updateHeroMesh(playerMesh, snap, combat.chain, dt, snap.speed);

  // ⚠ 战斗必须在 player.update **之后**：命中判定用的是本帧的最终位置，
  //   否则会出现"判定比人慢一帧"，贴身短打时能明显感觉到砍空。
  combat.update(dt, rig.yaw);
  // 模块 12 描边：武艺是**瞬发**的（combat 里没有持续状态位），只能靠事件"闪"一段朱砂红；
  // 无双有 ranbuTimer 天然可持续，直接读状态即可，这里一并刷新只是让闪窗覆盖整个乱舞。
  for (const ev of combat.events) {
    if (ev.type === 'art') cinnabarTimer = Math.max(cinnabarTimer, HERO.OUTLINE_ART_FLASH);
    else if (ev.type === 'musou-release') cinnabarTimer = Math.max(cinnabarTimer, ev.duration || HERO.OUTLINE_ART_FLASH);
  }
  inkFx.handle(combat.events);
  if (cinnabarTimer > 0) cinnabarTimer = Math.max(0, cinnabarTimer - dt);
  {
    const style = resolveOutlineStyle({ musouActive: combat.ranbuTimer > 0, artFlash: cinnabarTimer > 0 });
    const ol = playerMesh.userData.inkOutline;
    if (ol) { ol.setWidth(style.px); ol.setColor(style.color); }
  }

  // 防御慢走：战斗不在出招/蓄力时才接管移动（出招途中按防御不打断已有位移）。
  // 与蓄力慢走同一生命周期：本帧设、下帧 combat._applyMotion 会清/重设，无需手动还原。
  if (defense.blocking && !combat.chain.busy && !combat.chain.charging) {
    const f = forwardVector(rig.yaw);
    const r = rightVector(rig.yaw);
    const fwd = input.axis('back', 'forward');
    const side = input.axis('left', 'right');
    const dx = f.x * fwd + r.x * side;
    const dz = f.z * fwd + r.z * side;
    const len = Math.hypot(dx, dz);
    player.setMotionOverride(
      len > 1e-4 ? { x: dx / len, z: dz / len } : null,
      PLAYER.WALK_SPEED * DEFENSE.BLOCK.MOVE_SCALE,
    );
  }

  // 世界一起走**顿帧缩放后**的时间：打中的那一下，敌我双方都定格 —— 这才是打击感。
  // （combat.update 拿的是原始 dt，因为顿帧计时自己必须继续走，否则永远醒不过来。）
  dummyPool.update(pdt, combat.time);
  for (let i = 0; i < dummyMeshes.length; i++) updateDummyMesh(dummyMeshes[i], dummyPool.items[i], camera, pdt);

  // ─────────────────────────────────────────────── 敌人（模块 4）
  ectx.x = player.position.x;
  ectx.z = player.position.z;
  ectx.invincible = snap.invincible;
  // 模块 6：把士气换算的"攻击减伤 / 重生拉长"缩放写进敌人 ctx（enemyPool.update 不会覆盖这两个字段）
  enemyPool.ctx.damageScale = capture.attackScale;
  enemyPool.ctx.respawnScale = capture.respawnScale;
  // 练武场的草人也参与分离：不让一群敌人直接从草人身上穿过去（看着很假）
  enemyPool.update(pdt, combat.time, ectx);
  for (const ev of enemyPool.events) {
    if (ev.type === 'enemy-hit') {
      // 防御/卸势先结算（无双无敌 / 闪避无敌已在 enemyAI 里被拦掉，走到这的都是实打实的命中）：
      //   卸势成功 → 伤害归零 + 攻击者硬直 + 回无双/斗气 + 无敌余量；防御中 → 减伤 70%。
      const res = defense.resolveHit();
      if (res.type === 'parry') {
        enemyPool.noteHit(ev.enemy, { damage: 0, killed: false }, combat.time, { stun: res.stun });
        combat.musou = Math.min(MUSOU.GAUGE_MAX, combat.musou + res.gainMusou);
        combat.ki = Math.min(MUSOU.KI_MAX, combat.ki + res.gainKi);
        player.grantInvincible(res.invincible);
        // 在玩家与攻击者之间炸一朵火花，作为卸势成功的视觉反馈
        inkFx.handle([{
          type: 'damage',
          move: { id: 'PARRY' },
          result: { killed: false, hitPoint: { x: (player.position.x + ev.enemy.x) / 2, y: 1.2, z: (player.position.z + ev.enemy.z) / 2 } },
        }]);
      } else {
        combatUi.flashHit(res.type === 'block' ? 0.35 : 1); // 防住的攻击只给弱红晕
        enemyHitsTaken++;
        player.damage(ev.damage * res.damageScale);
      }
    }
  }
  enemyRenderer.sync(enemyPool.items, camera, pdt);

  // ─────────────────────────────────────────────── 模块 5–8：据点/士气/关卡/Boss/UI
  // 据点占领 + 士气推进（喂"活着的敌人"，含 guardOf 标记）
  capture.update(pdt, player.position, enemyPool.alive);
  for (const ev of capture.events) {
    if (ev.type === 'capture' || ev.type === 'recapture') battleHud.setPhaseLabel('据点争夺');
  }

  // 关卡三阶段推进：用"真实敌人击杀数"驱动（不含练武场靶子），据点全占 → boss，boss 死 → 通关
  const kills = enemyPool.kills;
  stage.update(pdt, { kills, allCaptured: capture.allCaptured, bossDead: boss ? !boss.alive : false });
  for (const ev of stage.events) {
    if (ev.type === 'phase') {
      if (ev.to === 'contest') battleHud.setPhaseLabel('据点争夺');
      else if (ev.to === 'boss') battleHud.setPhaseLabel('Boss 战');
      if (ev.bossSpawn) spawnBoss();
    } else if (ev.type === 'victory' && !victoryShown) {
      victoryShown = true;
      battleHud.hideBoss();
      battleHud.showVictory({ kills: enemyPool.kills, hp: player.hp, hpMax: player.maxHp, morale: capture.morale });
    }
  }

  // Boss 行为 + 受击扣血（Boss 不走敌人池的 AI，单独更新）
  if (boss) {
    const bev = boss.update(pdt, player.position, { invincible: snap.invincible });
    for (const ev of bev) {
      if (ev.type === 'boss-hit') {
        // Boss 的招也能防御/卸势；但 Boss 没有硬直概念（BossController 不读 stunTimer），
        // 卸势成功只免伤 + 回资源 + 无敌余量，不晕 Boss。
        const res = defense.resolveHit();
        if (res.type === 'parry') {
          combat.musou = Math.min(MUSOU.GAUGE_MAX, combat.musou + res.gainMusou);
          combat.ki = Math.min(MUSOU.KI_MAX, combat.ki + res.gainKi);
          player.grantInvincible(res.invincible);
          inkFx.handle([{
            type: 'damage',
            move: { id: 'PARRY' },
            result: { killed: false, hitPoint: { x: (player.position.x + bossTarget.x) / 2, y: 1.4, z: (player.position.z + bossTarget.z) / 2 } },
          }]);
        } else {
          combatUi.flashHit(res.type === 'block' ? 0.35 : 1);
          player.damage(ev.damage * res.damageScale);
        }
      }
    }
    bossTarget.hitFlash = Math.max(0, bossTarget.hitFlash - dt);
    if (bossMesh) {
      bossMesh.position.set(bossTarget.x, 0, bossTarget.z);
      const flash = bossTarget.hitFlash > 0;
      if (bossMesh.userData.body.material.emissive) bossMesh.userData.body.material.emissive.setRGB(flash ? 0.55 : 0, 0, 0);
      bossMesh.visible = boss.alive;
    }
    battleHud.updateBoss(boss.hpRatio, boss.berserk);
  }

  // 正式战场 UI（模块 7）：血条/无双槽/武艺冷却/击杀/据点/士气
  const cSnap = combat.snapshot();
  battleHud.update({
    hp: player.hp,
    maxHp: player.maxHp,
    musou: cSnap.musou,
    musouRatio: cSnap.musouRatio,
    musouReady: cSnap.musouReady,
    musouMax: MUSOU.GAUGE_MAX,
    art1: cSnap.art1,
    art2: cSnap.art2,
    kills: kills,
    points: capture.snapshot().points,
    morale: capture.morale,
  });

  inkFx.update(dt, combat.fxState(), player);

  rig.setTarget(player.position);
  lastDebug = rig.update(dt);
  // 镜头震动（命中 / 无双 / 武艺触发，由 inkFx 累积，纯视觉不进玩法时间）
  if (inkFx) {
    const sh = inkFx.shakeOffset();
    if (sh.lengthSq() > 0) camera.position.add(sh);
  }
  world.update(player.position);
  axes.position.set(player.position.x, 0.02, player.position.z);

  // 模块 10 氛围层：天穹/太阳/远景随玩家平移（真实 dt，顿帧时仍缓动）；风草摆动；贴花淡出
  if (env) env.update(player.position, camera); // 模块 13：雾带要按相机距离淡入淡出
  if (grassField) grassField.update(dt, player.position);
  if (decalPool) decalPool.update(dt);

  if (postfx) postfx.render(); else renderer.render(scene, camera);
  frame++;

  fpsAccum += raw;
  fpsFrames++;
  if (fpsAccum >= 0.5) {
    fps = fpsFrames / fpsAccum;
    // 性能降级：持续低于 40fps 时逐级关效果（泛光 → 草 → 水墨粒子/残影），保护模块 9 的 60fps 目标
    if (fps < 40) {
      lowFpsAccum += 0.5;
      if (lowFpsAccum >= 1.0 && degradeStep < 3) { degradeStep++; applyDegrade(degradeStep); lowFpsAccum = 0; }
    } else {
      lowFpsAccum = 0;
    }
    fpsAccum = 0;
    fpsFrames = 0;
  }

  const stunned = dummyPool.items.reduce((a, t) => a + (t.alive && t.stunTimer > 0 ? 1 : 0), 0);
  const d = lastDebug;
  const cb = combat.snapshot();
  const es = enemyPool.snapshot();
  combatUi.update(cb);
  moveList.update(cb);
  hud.update({
    cmove: cb.busy ? `${cb.id} · ${cb.name}（${(cb.progress * 100).toFixed(0)}%）` : cb.phase === 'charging' ? `蓄力 ${(cb.chargeRatio * 100).toFixed(0)}%` : '待机',
    ccombo: `${cb.combo}（峰值 ${cb.maxCombo}）· 剩余 ${cb.comboTimer.toFixed(1)}s`,
    cmeters: `无双 ${Math.round(cb.musou)}/${MUSOU.GAUGE_MAX} · 斗气 ${Math.round(cb.ki)}/${MUSOU.KI_MAX}`,
    cstats: `挥击 ${cb.swings} · 命中 ${cb.hits} · 击杀 ${cb.kills} · 伤害 ${cb.damage}`,
    ctargets: `靶子 ${dummyPool.alive.length}/${dummyPool.count} · 硬直中 ${stunned} · 顿帧 ${cb.hitstop.toFixed(3)}s · 池 ${cb.pools}`,
    // ── 模块 4 读数：三态 / 插槽 / 被击
    //    "攻击态 ≤ 35" 这条 spec 只有写在这里才**每帧可验**：盯住这一行，
    //    再冲进人堆转一圈，数字永远顶在 35 上、永远不会跳过去。
    estates: `${STATE_LABEL.idle} ${es.idle} · ${STATE_LABEL.threaten} ${es.threaten} · ${STATE_LABEL.attack} ${es.attack} / ${ENEMY_AI.MAX_ATTACKERS}（峰值 ${es.slots.peak}）`,
    eslots: `占用 ${es.slots.count}/${es.slots.capacity} · 22m 内 ${es.within22} · 4.6m 内 ${es.withinTrigger} · 起手 ${es.winding} · 硬直 ${es.stunned}`,
    ecombat: `出手 ${es.attacks} · 击中玩家 ${enemyHitsTaken} · 被闪避 ${es.dodgedByPlayer} · 空挥 ${es.whiffs} · 作废前摇 ${es.backswings}`,
    eperf: `绘制 ${enemyRenderer.stats.drawn}/${es.alive} · 实例 ${enemyRenderer.stats.bodies} · 分离对/帧 ${(es.pairChecks / Math.max(1, es.steps)).toFixed(0)}`,
    fps: fps.toFixed(0),
    frame: String(frame),
    pos: `${snap.x.toFixed(1)}, ${snap.z.toFixed(1)} (y ${snap.y.toFixed(2)})`,
    pstate: `${snap.state}${snap.grounded ? ' · 着地' : ` · 空中 vy ${snap.vy.toFixed(2)}`}`,
    pspeed: `${snap.speed.toFixed(2)} / ${PLAYER.WALK_SPEED} m/s`,
    pdodge: `${snap.dodgeTimer.toFixed(2)}s · 冷却 ${snap.dodgeCooldown.toFixed(2)}s${snap.invincible ? ' · 无敌' : ''}`,
    pfacing: `${snap.facingDeg.toFixed(0)}°（镜头 ${d.yawDeg.toFixed(0)}°）`,
    camDist: `${d.horizontalDistance.toFixed(2)} m（spec 8）`,
    camHeight: `${d.heightAbovePivot.toFixed(2)} m（spec 4）`,
    boom: `${d.boomUsed.toFixed(2)} / ${d.boomDesired.toFixed(2)} m${Number.isFinite(d.groundCap) ? ` · 地面上限 ${d.groundCap.toFixed(2)}` : ''}`,
    blocked: d.blocked ? `是（命中 ${d.hitDistance.toFixed(2)}m）` : '否（视野通畅）',
    pitch: `${d.pitchDeg.toFixed(1)}° / ${d.yawDeg.toFixed(1)}°`,
    pivotLag: Math.hypot(d.pivot.x - player.position.x, d.pivot.z - player.position.z).toFixed(3) + ' m',
    meshes: `${world.stats.meshes} / ${world.stats.colliders} / ${renderer.info.render.calls}`,
    layout: `${world.stats.layoutSeed} · 物件 ${world.stats.props} · 草丛 ${world.stats.bushes} · 相机代理 ${world.stats.camProxies}`,
    warn: world.warnings.length ? world.warnings.join(' | ') : '无',
  });

  window.MUSOU.frame = frame;
  window.MUSOU.fps = fps;
  window.MUSOU.simTime = simTime;
  window.MUSOU.lastDt = lastDt;
  window.MUSOU.cameraState = d;
  window.MUSOU.debug = d;
  window.MUSOU.playerState = snap;
  window.MUSOU.combatState = cb;
  window.MUSOU.enemyState = es;
  window.MUSOU.enemyRender = enemyRenderer.stats;
  window.MUSOU.drawCalls = renderer.info.render.calls;
  {
    const ol = playerMesh.userData.inkOutline;
    window.MUSOU.heroOutline = ol ? { count: ol.count, px: ol.material.uniforms.uWidthPx.value, color: ol.material.uniforms.uColor.value.getHex() } : null;
  }

  requestAnimationFrame(tick);
}

// ─────────────────────────────────────────────── 对外句柄（探针靠它断言"真的起来了"）
window.MUSOU = {
  ready: true,
  module: 8,
  THREE_REVISION: REVISION,
  scene,
  camera,
  renderer,
  world,
  rig,
  player,
  playerMesh,
  heroAssetLoaded: false, // 模块 12：外部角色资产是否成功加载（探针用它确认加载管线真的跑通）
  input,
  placeholderMeshIsTemporary: true, // 武将网格仍为代码生成（非外部美术资源）
  config: { BATTLEFIELD, PLAYER, COMBAT, MUSOU, ARTS, ENEMY, ENEMY_AI, MORALE, POINTS, HUD, STAGE, BOSS, DEBUG, RENDER, POSTFX, INKFX, ENVIRONMENT, GRASS, DECAL, TIME, HERO, INK_UI, AUDIO },
  postfx, env, grass: grassField, decals: decalPool, timeControl, audio, inkFx, combatFx: inkFx,
  stats: world.stats,
  warnings: world.warnings,
  frame: 0,
  fps: 0,
  // ⚠ simTime 是**仿真**秒数（每帧钳制后的 dt 之和）。无头浏览器可能只有几帧/秒，
  //   这时按墙上时间（performance.now）断言会得到一堆假失败 —— 探针一律用 simTime。
  simTime: 0,
  lastDt: 0,
  cameraState: rig.debug,
  debug: rig.debug,
  playerState: snap,
  combat,
  dummyPool,
  dummyMeshes,
  combatState: combat.snapshot(),
  // 招式表 / 教学面板：探针用它断言"界面上不出现 C1/C2"，抓拍前也用它收起面板
  moveList,
  // ── 模块 4：敌人
  enemyPool,
  enemyRenderer,
  enemyState: enemyPool.snapshot(),
  enemyRender: enemyRenderer.stats,
  drawCalls: 0,
  enemyHitsTaken: () => enemyHitsTaken,
  /** 探针用：开关分层 AI。量"站位/距离"相关读数时先关掉它，读数才可复现。 */
  setEnemyAI(on) {
    const v = enemyPool.setAI(on);
    if (!on) {
      // 关掉时把速度清零，否则"上一帧算出来的速度"会让敌人继续滑一段
      for (const e of enemyPool.items) {
        e.vx = 0;
        e.vz = 0;
        e.pvx = 0;
        e.pvz = 0;
        e.speed = 0;
        e.windup = 0;
        e.recover = 0;
        e.state = 'idle';
      }
      enemyPool.director.slots.clear();
    }
    return v;
  },
  /** 探针用：把某个敌人摆到确定的位置并回满血（AI 开着也会被下一帧 AI 挪走，故先关 AI） */
  placeEnemy(id, x, z, yaw) {
    const t = enemyPool.items.find((it) => it.id === id);
    if (!t) return null;
    t.x = x;
    t.z = z;
    t.home = { x, z };
    t.yaw = Number.isFinite(yaw) ? yaw : t.yaw;
    t.hp = t.maxHp;
    t.alive = true;
    t.stunTimer = 0;
    t.hitFlash = 0;
    t.knockVX = 0;
    t.knockVZ = 0;
    t.respawnTimer = 0;
    enemyPool.director.initEnemy(t, t.index ?? 0);
    return { id: t.id, x: t.x, z: t.z, hp: t.hp };
  },
  /** 探针用：把整支军队复位（位置 / 血量 / 三态 / 插槽 / 统计） */
  resetEnemies() {
    enemyPool.reset();
    enemyHitsTaken = 0;
    return enemyPool.snapshot();
  },
  /**
   * 探针用：**纯逻辑快进**一步敌人 AI（不渲染、不碰相机、不动 DOM）。
   * ---------------------------------------------------------------------------
   * 为什么需要它：攻击间隔 1.2~2.2s、前摇 0.4s、收招 0.55s —— 要拿到十几个样本
   * 得跑 40 秒仿真。无头浏览器只有几帧/秒，跑真帧就是好几分钟；而"出手间隔落在
   * spec 区间内"是一条**纯逻辑性质**，跟无头帧率毫无关系。于是给它一条快进通道。
   *
   * ⚠ 它走的是和主循环**同一条** `enemyPool.update` —— 不是另写一份简化版。
   *   否则探针证明的就是"另一套代码"，而不是页面上真正跑的那套。
   *   唯一的差别是：它不消费事件、不推渲染器、不推进 camera/world。
   */
  stepEnemies(dt = 1 / 60) {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 1 / 60;
    ectx.x = player.position.x;
    ectx.z = player.position.z;
    ectx.invincible = snap.invincible;
    combat.time += step;
    enemyPool.update(step, combat.time, ectx);
    return enemyPool.snapshot();
  },
  /** 探针用：给玩家附近的敌人施加剧本式的硬直（验证"硬直暂停 AI"） */
  stunEnemiesNear(x, z, radius, seconds) {
    let n = 0;
    for (const e of enemyPool.items) {
      if (!e.alive) continue;
      if (Math.hypot(e.x - x, e.z - z) > radius) continue;
      e.stunTimer = Math.max(e.stunTimer, seconds);
      e.lastStun = seconds;
      n++;
    }
    return n;
  },
  /** 探针用：三态与插槽的即时读数（含"守恒"校验） */
  enemySnapshot() {
    return enemyPool.snapshot();
  },
  STATE_LABEL,
  // 探针用：把玩家瞬移到指定位置并立刻归位注视点，用来采样"不同位置的相机行为"
  teleport(x, z, yaw) {
    player.teleport(x, z);
    if (Number.isFinite(yaw)) rig.setLook(yaw, rig.userPitch);
    rig.pivot = { x: player.position.x, y: player.position.y + rig.cfg.PIVOT_HEIGHT, z: player.position.z };
    return { x, z };
  },
  // 探针用：不做平滑，直接把注视点归位（便于拿"静止状态"的确定读数）
  snapPivot() {
    rig.pivot = { x: player.position.x, y: player.position.y + rig.cfg.PIVOT_HEIGHT, z: player.position.z };
    return { ...rig.pivot };
  },
  // 探针用：纯公式，避免在测试里手抄数字
  motion: { jumpApex, jumpAirTime },
  // 探针用：把靶子摆回原位并回满血（每次采样前复位，读数才可比）
  resetDummies() {
    dummyPool.reset();
    return dummyPool.snapshot();
  },
  // 抓拍用：冻结仿真时间但继续渲染（刀光/火花只活 0.16~0.2s，不冻结拍不到）
  hold(on = true) {
    held = !!on;
    return held;
  },
  // 抓拍用：收起调试面板（它固定在左上，会挡住前半个画面）
  hud,
  // 探针用：把玩家和靶子放到一个确定的相对位置上，用来量攻击距离
  placeDummy(id, x, z) {
    const t = dummyPool.items.find((it) => it.id === id);
    if (!t) return null;
    t.x = x;
    t.z = z;
    t.home = { x, z };
    t.hp = t.maxHp;
    t.alive = true;
    t.knockVX = 0;
    t.knockVZ = 0;
    return { x: t.x, z: t.z, hp: t.hp };
  },
  Vector3,
  // ── 模块 5–8：无双/武艺/据点/士气/关卡/Boss 探针句柄
  capture,
  stage,
  captureSnapshot: () => capture.snapshot(),
  defenseSnapshot: () => defense.snapshot(),
  stageSnapshot: () => stage.snapshot(),
  bossSnapshot: () => (boss ? boss.snapshot() : null),
  spawnBoss,
  /** 探针用：直接击杀 Boss 靶子（下一帧 stage 据此判定通关） */
  killBoss: () => { if (bossTarget) { bossTarget.hp = 0; bossTarget.alive = false; } },
  /** 探针用：把三个据点直接标记为已占领并清掉守卫，让关卡推进到 boss 阶段 */
  debugAllCaptured: () => {
    for (const t of enemyPool.items) if (t.guardOf) { t.guardOf = null; t.alive = false; }
    for (const p of capture.points) { p.captured = true; p.progress = 100; p.guardsAlive = 0; p.enemiesInRange = 0; }
  },
  setMusou: (v) => { combat.musou = Math.max(0, Math.min(MUSOU.GAUGE_MAX, v)); },
  setKi: (v) => { combat.ki = Math.max(0, Math.min(MUSOU.KI_MAX, v)); },
};

boot.classList.add('gone');
requestAnimationFrame(tick);
console.log(
  '[传统割草游戏] 模块5-8 已启动（无双/武艺 · 据点/士气 · 战场UI · 关卡/Boss）',
  JSON.stringify(world.stats),
  `敌人 ${enemyPool.count}（同屏上限 ${STAGE.MAX_ACTIVE} · 攻击插槽 ${ENEMY_AI.MAX_ATTACKERS}）`,
  `据点 ${POINTS.LIST.length} · 练武场靶子 ${dummyPool.count}`
);
