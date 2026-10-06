/**
 * 全项目数值的单一来源（Single Source of Truth）
 * ---------------------------------------------------------------------------
 * 规矩：
 *  1. 任何模块的可调数值都写在这里，业务代码里**禁止**出现裸数字（除 0/1 之类的结构性常量）。
 *  2. 带 ★SPEC 的数值来自产品/策划指令，改动前必须同步改 tests/config.test.mjs 的断言，
 *     并重跑 `npm test` —— 那几条断言就是防止后续模块把 spec 偷偷改掉的护栏。
 *  3. 坐标系约定（全项目统一，后续模块不许另立）：
 *     · 右手系，Y 轴向上，地面 y = 0
 *     · yaw = 0 时玩家面向 -Z；forward = (-sin yaw, 0, -cos yaw)
 *     · 角度在配置里用「度」，代码里一律换成弧度（DEG）
 */

export const DEG = Math.PI / 180;

// ─────────────────────────────────────────────────────────────── 模块 1：战场地形
export const BATTLEFIELD = {
  SIZE_X: 200, // ★SPEC 战场尺寸 200m × 200m
  SIZE_Z: 200,
  // 网格分段：当前地形**完全平坦**（y 恒为 0），分段先留着，
  // 后续若要做丘陵/河谷，直接把高度写进顶点即可，不用重建 geometry。
  SEGMENTS: 64,
  BASE_Y: 0,
  GROUND_ALBEDO: 0x6f7f52, // 地表兜底色：**只在贴图生成失败时生效**，正常情况贴图会盖住它
  WALL_HEIGHT: 3.2, // 边界石墙高度：同时挡住地形边缘的接缝
  WALL_THICKNESS: 1.6,
  FOG_NEAR: 105, // 雾把远处石墙与天空的交界糊掉
  FOG_FAR: 340,
  GRASS_TILE_METERS: 4.5, // 草地贴图一个 tile 覆盖多少米 → 决定 repeat
  ANISOTROPY_MAX: 16, // 草地/土路都是大面积斜视平面，清晰度基本全靠各向异性过滤
  // 土路贴片的抬升与"逐条错开"：
  //   主路与横路在路口会**共面重叠**，两个 y 完全相同的面必然 z-fighting
  //   （表现为路口闪烁的彩色噪点，且随镜头移动而变，一眼就是 bug）。
  //   所以每条路按序号再抬高 ROAD_Y_STEP —— 4cm 的落差肉眼不可见，但能彻底消除共面。
  ROAD_LIFT: 0.02,
  ROAD_Y_STEP: 0.014,
};

// ─────────────────────────────────────────────────────────────── 模块 1：光照
export const LIGHT = {
  SUN_INTENSITY: 1.2, // ★SPEC 主方向光（日光）强度
  AMBIENT_INTENSITY: 0.3, // ★SPEC 环境光强度
  SUN_COLOR: 0xfff4e0,
  AMBIENT_COLOR: 0x9fb6d1,
  SUN_AZIMUTH_DEG: 42, // 太阳方位角：0 = +Z，顺时针（绕 Y）
  SUN_ELEVATION_DEG: 52, // 太阳高度角
  SUN_DISTANCE: 90, // 方向光离玩家多远（只影响阴影正交盒的摆放）
  SKY: {
    // 天穹渐变（程序化，无素材）
    TOP: '#39659e',
    HORIZON: '#c8d7e3',
    RADIUS: 460,
  },
  SHADOW: {
    ENABLED: true, // ★SPEC 阴影开启
    MAP_SIZE: 2048,
    ORTHO_HALF: 52, // 阴影正交盒半边长：跟随玩家移动，保证近景阴影不糊
    NEAR: 1,
    FAR: 260,
    BIAS: -0.0006,
    NORMAL_BIAS: 0.022,
  },
};

// ─────────────────────────────────────────────────────── 模块 1：第三人称摄像机
export const CAMERA = {
  FOV: 58,
  NEAR: 0.3, // near 不要太小：0.3/900 的深度精度足以让土路贴片不 z-fighting
  FAR: 900,

  PIVOT_HEIGHT: 1.6, // 环绕注视点高度（玩家胸口），不是"相机离地高度"

  DISTANCE: 8, // ★SPEC 摄像机**水平**距离玩家 8m
  HEIGHT: 4, // ★SPEC 摄像机在 pivot **之上** 4m
  //   注：spec 写的是「距离 8m、高度 4m」，本实现按「水平 8m + 抬升 4m」解释，
  //   实际直线距离 = hypot(8,4) ≈ 8.94m，基准俯角 = atan2(4,8) ≈ 26.57°。
  //   若后续要改成"直线距离 8m"，只改这两个常量即可，所有数学从它们派生。

  FOLLOW_K: 0.08, // ★SPEC 平滑跟随插值系数（在 60fps 下的每帧插值比例）

  // ——— 碰撞 ———
  COLLIDE_ENABLED: true, // ★SPEC 摄像机碰撞检测
  COLLIDE_MARGIN: 0.35, // 命中点再往里退这么多，避免近平面切进墙里
  MIN_DISTANCE: 1.6, // 平滑路径上的贴脸下限（正常情况不许比这更近）
  // 硬守卫用的下限：比 MIN_DISTANCE 小得多。
  // 理由：玩家贴着墙站时，"pivot → 墙"可能只有 0.5m，这时如果守卫还坚持 1.6m，
  // 就会把相机**推进墙里** —— 守卫存在的意义是"绝不穿模"，所以它必须允许贴到脸上。
  GUARD_MIN_DISTANCE: 0.25,
  NUDGE_RAYS: [0.42, -0.42], // 侧向偏移射线（米）：中心 1 条 + 左右各 1，防止擦着柱子边缘穿模
  PULL_IN_K: 0.55, // 被遮挡时：拉近用快系数（穿透是一眼可见的 bug）
  PUSH_OUT_K: 0.08, // 遮挡解除后：推远用慢系数（这是"不剧烈抖动"的关键）
  GROUND_MIN_Y: 0.6, // 相机离地的硬下限

  // ——— 视角（模块 2 spec：俯仰限制上下 60° / 鼠标灵敏度 0.0022 与 0.0018）———
  // 横纵两个系数是**分开的**：纵向视野窄，同样的像素位移"感觉更快"，所以纵向通常更小。
  // ⚠ 只保留这两个字段，不要再加一个笼统的 MOUSE_SENSITIVITY 兜底 ——
  //   两套灵敏度并存时，改了一个忘了另一个，表现成"某个轴上还是旧手感"，极难查。
  MOUSE_SENS_YAW: 0.0022, // ★SPEC 鼠标横向灵敏度
  MOUSE_SENS_PITCH: 0.0018, // ★SPEC 鼠标纵向灵敏度
  // PITCH_MIN/MAX 是**总俯角**（含基准俯角 26.565°），0 = 水平，正 = 相机在上方俯视。
  // ⚠ 与模块 1 的关系：模块 1 为了"地面钳制永不介入"把下限卡在 -6°；
  //   模块 2 的 spec 要求 ±60°，两者并不冲突 —— 靠 cameraMath.groundLimitedBoom
  //   在**几何上**限制摇臂长度（俯角越往下，摇臂越短），于是相机永远不会低于地面。
  //   实测：俯角 -60° 时摇臂被压到 1.155m、相机 y 恰好 = 0.6m（地面下限）。
  PITCH_INIT_DEG: 0, // 相对基准俯角的额外俯仰（0 = 就是"8m 后 / 4m 上"的标准机位）
  PITCH_MIN_DEG: -60,
  PITCH_MAX_DEG: 60,
  YAW_INIT_DEG: 0,
};

// ─────────────────────────────────────────────────── 模块 2：玩家控制器
export const PLAYER = {
  RADIUS: 0.45, // 碰撞半径
  HEIGHT: 1.8, // 站立高度（模块 3/4 的受击盒要用同一个数）
  HP: 100, // ★SPEC 玩家最大生命值（模块 5/7/8 的血条与胜负判定都读它）
  WALK_SPEED: 4.2, // ★SPEC 基础移动速度 m/s
  ACCEL: 30, // 未 spec：达到全速约 0.14s（下面是手感补的，不是 spec）
  DECEL: 36, // 未 spec：松手停下约 0.12s
  AIR_CONTROL: 0.55, // 未 spec：空中操控系数（0 = 完全不可变向，1 = 和地面一样）
  MOVE_TURN_RATE_DEG: 1200, // ★SPEC 的「移动时自动转向目标方向」
  IDLE_TURN_RATE_DEG: 480, // ★SPEC 的「静止时角色旋转跟随相机朝向」
  STEP_HEIGHT: 0.42, // 未 spec：可自动跨过的台阶；栅栏/木箱都比它高，所以都会挡住人
  BOUND: 96, // 越界保险（石墙内沿 98.4，正常撞不到）
  GROUND_EPSILON: 0.02, // 贴地容差

  DODGE: {
    KEY_HINT: 'Shift',
    DURATION: 0.35, // ★SPEC 持续 0.35s
    SPEED: 8.5, // ★SPEC 期间速度 8.5 m/s（位移 = 8.5 × 0.35 = 2.975m）
    COOLDOWN: 0.8, // ★SPEC 冷却 0.8s（从**触发瞬间**算，不是从结束算）
    INVINCIBLE: true, // ★SPEC 期间无敌
    ALLOW_AIR: true, // 未 spec：允许空中闪避（空中冲刺）
    PRESS_BUFFER: 0.14, // 未 spec：输入缓冲，落地前 0.14s 内按下也算数
  },

  JUMP: {
    VELOCITY: 6.2, // ★SPEC 起跳初速度 m/s（最大跳高 = 6.2²/(2×9.8) ≈ 1.96m）
    GRAVITY: -9.8, // ★SPEC 重力 m/s²（滞空 ≈ 1.27s）
    MAX_FALL: 34, // 终端下落速度，防止高空掉落时穿过薄地面
    PRESS_BUFFER: 0.12, // 未 spec：输入缓冲
    COYOTE: 0.1, // 未 spec：离地宽容（走出悬崖边缘后 0.1s 内还能起跳）
  },
};

// ─────────────────────────────────────────────── 模块 3：C 技连段战斗系统
export const COMBAT = {
  INPUT_BUFFER: 0.2, // ★SPEC 输入缓冲：按下后 0.2s 内该输入都算数
  CHAIN_GRACE: 0.08, // ★SPEC 连段衔接宽限：取消窗口开启前就吸收"早按"的时长

  /**
   * ★SPEC 连段窗口 0.4s：每次轻攻击**结束**后 0.4s 内按下下一次攻击才能接续，
   * 超时就把连段计数清零（下一击从 N1 重新开始）。
   * ---------------------------------------------------------------------------
   * ⚠ 它和下面两个"窗口"是三件不同的事，别混：
   *   · CHAIN_GRACE  —— 动作**内部**的宽限：取消窗口开启前 0.08s 按下的也算数（吸收早按）
   *   · CHAIN_WINDOW —— 动作**之间**的窗口：一招打完到下一击之间能歇多久（本项，0.4s）
   *   · COMBO_WINDOW —— HUD 上"连击数"的显示计时（2.2s），跟连段派生无关
   * 实战里玩家几乎用不到 CHAIN_WINDOW：取消窗口在动作还没结束时就开了（cancelFrom），
   * 输入会被缓冲并兑现。它管的是"打完一招站着发呆"的情况。
   */
  CHAIN_WINDOW: 0.4,

  LUNGE_END: 0.62, // ★SPEC 前冲位移在整个动作前 62% 内走完（观感是"冲进去砍"）
  MAX_HITS_PER_SWING: 10, // 单次挥击最多命中几个目标（防止 360° 大招把整个战场都算进来）

  /**
   * 贴身必中半径（米）。目标圆心离攻击者小于这个距离时，**无视张角与扇形圆心直接判定命中**。
   * 为什么需要它：前冲会把玩家推进敌人身体里，那一刻敌人相对玩家可能在"正后方"
   * （玩家已经越过它了），按张角算就是 180° 落空 —— 割草游戏里最难受的"贴脸砍空"。
   * 1.0 ≈ 玩家半径 0.45 + 靶子半径 0.55，也就是"两个人已经重叠"的量级。
   */
  CONTACT_HIT_RADIUS: 1.0,

  /**
   * 前冲最小间距（米）。前冲不允许把自己送进敌人身体内 —— 距离目标中心到这个值就刹住。
   * 没有它的话：轻攻击每段前冲 1.0~1.6m，而敌人被击退只有 0.9~2.2m/s，
   * 玩家会**一路穿过整个敌群**，后面的连段全部砍在背后。加上它之后是"冲上去贴着打"。
   */
  LUNGE_MIN_GAP: 1.0,

  /**
   * 轻攻击连段表 N1~N5（★SPEC：打击盒半径 1.8m、持续 0.22s）。
   * ---------------------------------------------------------------------------
   * `reach` 全表统一 1.8、`active` 全表统一 0.22 —— 这两个数**直接照搬 spec**，
   * 招式之间的差异交给张角（70° 突刺 ~ 360° 回旋）、伤害、前冲与硬直去体现。
   * 这样做的好处很实在：玩家不用记"哪一刀够得远"，距离手感在所有轻攻击上是一致的。
   *
   * 时间轴：startup(前摇，纯准备) → active(**判定生效**) → recovery(后摇)
   *   · cancelFrom：从动作开始算起，到这个时刻进入**取消窗口**，可以接下一击。
   *     它一定落在 recovery 中段之后 —— 太早接会变成"无后摇连点"，太重就没有连段的节奏感。
   *   · reach/arcDeg：扇形判定（米 / 度）。offset 是扇形圆心沿前向的偏移。
   *   · hits：判定生效期间分几次结算（C 技的多段打击靠它，不是靠每帧都判定）。
   *   · advance：动作期间自动前冲的距离（走完整的碰撞解算，撞墙就停）。
   *   · stun：命中后目标的**受击硬直**（秒）—— 硬直期间不动作、不位移，只能站着挨打。
   *   · stop：命中瞬间的**顿帧**（秒）—— 冻结玩法时间，打击感的主要来源。
   *     stun 与 stop 是两个不同的东西：stop 冻的是"玩家和整个世界"，stun 冻的是"被打的那个"。
   */
  LIGHT: [
    { id: 'N1', name: '横扫', startup: 0.1, active: 0.22, recovery: 0.2, cancelFrom: 0.34, damage: 10, hits: 1, reach: 1.8, arcDeg: 150, offset: 1.0, height: 1.05, advance: 1.1, knockback: 0.9, gain: 3, stun: 0.16, stop: 0.045 },
    { id: 'N2', name: '反手斩', startup: 0.09, active: 0.22, recovery: 0.2, cancelFrom: 0.33, damage: 12, hits: 1, reach: 1.8, arcDeg: 150, offset: 1.0, height: 1.05, advance: 1.0, knockback: 1.0, gain: 3, stun: 0.17, stop: 0.045 },
    { id: 'N3', name: '突刺', startup: 0.1, active: 0.22, recovery: 0.22, cancelFrom: 0.35, damage: 14, hits: 1, reach: 1.8, arcDeg: 70, offset: 1.4, height: 1.05, advance: 1.4, knockback: 1.2, gain: 3, stun: 0.18, stop: 0.045 },
    { id: 'N4', name: '回旋斩', startup: 0.12, active: 0.22, recovery: 0.26, cancelFrom: 0.38, damage: 16, hits: 1, reach: 1.8, arcDeg: 360, offset: 0, height: 1.05, advance: 0.9, knockback: 1.4, gain: 3, stun: 0.2, stop: 0.05 },
    { id: 'N5', name: '大斩', startup: 0.16, active: 0.22, recovery: 0.32, cancelFrom: 0.42, damage: 22, hits: 1, reach: 1.8, arcDeg: 160, offset: 1.2, height: 1.1, advance: 1.6, knockback: 2.2, gain: 3, stun: 0.24, stop: 0.055 },
  ],

  /**
   * 重攻击 / 蓄力 → 收尾技（★SPEC：打击盒半径 2.6m、持续 0.35s）。
   * ---------------------------------------------------------------------------
   * ★SPEC 命名口径（这一版**完全照字面**，不再有"C1/C2"这两个名字）：
   *
   *   轻攻击连段按 N 序列命名 —— N1 = 轻、N2 = 轻 + 轻。
   *   **C1/C2 与 N1/N2 是同一动作**，不设独立 C 名（一个动作两个名字是本类项目最常见的
   *   维护陷阱：改了一处忘了另一处，表现成"这条派生怎么调都不对"）。
   *
   *   C 技只有三条，全部是"带重击收尾"的连段，逐字实现：
   *
   *     C3 = 轻×2 + 重   （内部计数：0 段轻 + 重）
   *     C4 = 轻×3 + 重   （内部计数：1 段轻 + 重）
   *     C5 = 轻×4 + 重   （内部计数：2 段轻 + 重）
   *
   *   "内部计数"里的段数 = 总轻击数 − 2：前两下轻攻击已经被 N1/N2 用掉了，
   *   从第 3 下轻攻击起才计进 C 技的段数，于是 C3 的计数从 0 开始。
   *
   *   轻击次数**未达 2 次**时直接按重键 = **独立重攻击起手**（id `H`，招式名"重击"）：
   *   它不是 C 技，也不参与连段计数 —— 放完仍然从 N1 重新起手。
   *
   *   任何重击（H / C3 / C4 / C5 / 蓄力斩）收尾后，连段计数归零。
   *
   * ⚠ 硬直用的是 spec 的**建议值**（重击 0.4 / C3 0.3 / C4 0.5 / C5 0.8），可调。
   *   注意 C3 的 0.3s **低于**独立重击的 0.4s：这是刻意的 —— C3 是 4 段旋风，
   *   靠"反复刷新硬直"压制，而不是靠单段长时间定身。改数值时别把它当成 bug 抹平。
   */
  HEAVY: {
    CHARGE_TIME: 0.45, // ★SPEC 蓄力 0.45s 为满（按住重攻击键）
    MIN_RATIO: 0.35, // 低于这个比例视为"轻点"，直接出普通收尾技
    WALK_SCALE: 0.55, // 蓄力期间允许走路，但只有 55% 速度
    MOVES: {
      // 独立重攻击起手：轻击不足 2 次时按重键。**非 C 技**，不参与连段计数。
      // 出招最快（前摇 0.18s），代价是伤害最低 —— "直接按重键"不该比"连两段再收尾"划算。
      H: { id: 'H', name: '重击', startup: 0.18, active: 0.35, recovery: 0.34, cancelFrom: 0.56, damage: 30, hits: 2, reach: 2.6, arcDeg: 120, offset: 1.2, height: 1.05, advance: 1.3, knockback: 2.6, gain: 8, stun: 0.4, stop: 0.06 },
      // C3 旋风斩：轻×2 + 重（内部 0 段轻 + 重）。前方大张角多段。
      C3: { id: 'C3', name: '旋风斩', startup: 0.28, active: 0.35, recovery: 0.48, cancelFrom: 0.66, damage: 44, hits: 4, reach: 2.6, arcDeg: 200, offset: 0.8, height: 1.05, advance: 1.3, knockback: 3.6, gain: 8, stun: 0.3, stop: 0.075 },
      // C4 破军斩：轻×3 + 重（内部 1 段轻 + 重）。收束到一条线上的重击，打单体最疼。
      C4: { id: 'C4', name: '破军斩', startup: 0.3, active: 0.35, recovery: 0.52, cancelFrom: 0.68, damage: 52, hits: 5, reach: 2.6, arcDeg: 130, offset: 1.5, height: 1.05, advance: 1.5, knockback: 4.0, gain: 8, stun: 0.5, stop: 0.085 },
      // C5 无双斩：轻×4 + 重（内部 2 段轻 + 重）。全套连段的收尾，环身 + 最高伤害 + 最长硬直。
      C5: { id: 'C5', name: '无双斩', startup: 0.34, active: 0.35, recovery: 0.6, cancelFrom: 0.72, damage: 62, hits: 6, reach: 2.6, arcDeg: 360, offset: 0, height: 0.8, advance: 1.6, knockback: 5.0, gain: 8, stun: 0.8, stop: 0.1 },
      // 蓄满释放。**damage 与"总伤害"都必须是全表最高** —— 它是付出 0.45s 站桩 +
      // 被打断风险换来的，如果连 C5（轻×4+重，总伤 372）都打不过，蓄力就没有意义了。
      // 84×5 = 420 > C5 的 372，且单发 84 > C5 的单发 62，两条都不越级。
      CHARGED: { id: 'CHARGED', name: '蓄力斩', startup: 0.3, active: 0.35, recovery: 0.55, cancelFrom: 0.68, damage: 84, hits: 5, reach: 2.6, arcDeg: 220, offset: 1.4, height: 1.1, advance: 1.8, knockback: 4.5, gain: 8, stun: 0.9, stop: 0.12 },
    },
  },

  HITSTOP: 0.045, // 兜底顿帧（招式自带 stop 时以招式为准）
  HITSTOP_CHARGED: 0.09, // 蓄力斩的兜底顿帧
  HITSTUN: 0.2, // 兜底受击硬直（招式自带 stun 时以招式为准）
  COMBO_WINDOW: 2.2, // HUD 上"连击数"的显示计时窗（超时清零）。⚠ 与派生无关，别和 CHAIN_WINDOW 混
  KNOCKBACK_DECAY: 7.5, // 击退速度的衰减率（1/s）
  KNOCKBACK_MIN_SPEED: 1.5, // 走出这个速度就保留为"推着走"，击退感更实在
};

// ─────────────────────────────────── 模块 5：无双槽与武艺系统
export const MUSOU = {
  GAUGE_MAX: 100, // ★SPEC 无双槽上限
  KI_MAX: 60, // ★SPEC 斗气上限（注意：不是 100，是 60）
  KI_START: 0,
  GAIN_ON_KILL: 12, // ★SPEC 击杀获得斗气（无双槽的"击杀补量"保持 12）

  // ★SPEC 命中获得无双槽：轻攻击 +3、重攻击 +8。具体数值落在 `COMBAT.LIGHT/HEAVY` 的 `gain` 上
  // （攻击判定结算时 `this.musou += move.gain`），这里只放"语义常量"供注释与护栏引用。
  GAIN_LIGHT: 3, // ★SPEC 轻攻击命中 +3
  GAIN_HEAVY: 8, // ★SPEC 重攻击命中 +8

  // ★SPEC 斗气每秒自动恢复 1.2 点
  KI_REGEN: 1.2,

  /**
   * ★SPEC 无双乱舞（R 键，无双槽满时释放）：
   *   全屏 AOE 伤害，半径 14m，持续 1.8s，释放期间玩家无敌。
   * 实现口径：1.8s 内每 TICK 秒对半径内所有敌人结算一次伤害（持续 AOE），
   * 期间 `musouActive > 0` 且玩家无敌。释放瞬间清空无双槽。
   */
  RANBU: {
    KEY: 'Tab', // 与 input.ACTIONS.musou 对应（2026-09-25 键位对齐参考布局：R 让给重攻击，无双挪 TAB）
    RADIUS: 14, // ★SPEC 全屏 AOE 半径 14m
    DURATION: 1.8, // ★SPEC 持续 1.8s
    TICK: 0.3, // AOE 每 0.3s 结算一次（1.8s 共 6 跳）
    DAMAGE: 16, // 每跳伤害（6 跳 × 16 = 96，约清掉 2~3 个杂兵）
    STUN: 0.2, // 命中附带短硬直
    KNOCKBACK: 2.5, // 击退
    INVINCIBLE: true, // ★SPEC 释放期间无敌
  },
};

/**
 * ★SPEC 武艺系统（数字 1/2 键释放不同技能）：
 *   斗气消耗 20 / 35，各自独立冷却，技能命中附带范围打击 + 敌人硬直。
 * 两套技能的差异由数值体现（扇形突进 vs 周身环爆），名字与冷却都写死便于 HUD 显示。
 * ⚠ `key` 同时登记在 input.ACTIONS（art1/art2），两边不能对不上。
 */
export const ARTS = {
  art1: {
    id: 'art1',
    name: '裂空斩',
    key: 'KeyQ',
    KI_COST: 20, // ★SPEC 武艺 1 消耗 20 斗气
    COOLDOWN: 6,
    shape: 'cone', // 前方扇形
    radius: 6.5,
    arcDeg: 120,
    offset: 1.2,
    DAMAGE: 34,
    STUN: 0.6, // ★SPEC 命中附带硬直
    KNOCKBACK: 3.0,
    hits: 999,
  },
  art2: {
    id: 'art2',
    name: '震地击',
    key: 'KeyE',
    KI_COST: 35, // ★SPEC 武艺 2 消耗 35 斗气
    COOLDOWN: 10,
    shape: 'ring', // 周身环形
    radius: 7.5,
    arcDeg: 360,
    offset: 0,
    DAMAGE: 52,
    STUN: 1.0, // ★SPEC 命中附带硬直（更强）
    KNOCKBACK: 5.0,
    hits: 999,
  },
};

// ─────────────────────────────────────────────── 防御 / 卸势（2026-09-25 主理人裁决）
/**
 * 键位对齐燕云参考布局时一并加入的两个防御向机制（主理人裁决：改键 + 加机制）。
 * ⚠ 数值为 PROVISIONAL（无 spec，是我按手感拍的，都集中在这里便于调）：
 *
 * · 防御（F 按住）：受伤 ×0.30，移速 ×0.35；按住期间不出招（输入层吃掉攻击键）。
 * · 卸势（鼠标右键点按）：按下后 WINDOW 秒内有敌方命中打过来 →
 *   该次伤害归零、攻击者硬直 STUN 秒、回无双/斗气、玩家得 INVINCIBLE 秒无敌余量；
 *   空按（没卸到）进入 COOLDOWN，防止连刷。
 * · Boss 没有硬直概念（BossController 不读 stunTimer）→ 卸 Boss 的招只免伤 + 回资源，不晕 Boss。
 */
export const DEFENSE = {
  BLOCK: {
    KEY: 'KeyF', // 与 input.ACTIONS.block 对应（按住）
    DAMAGE_TAKEN: 0.30, // 防御中受伤比例（减伤 70%）
    MOVE_SCALE: 0.35, // 防御中移动速度比例
  },
  PARRY: {
    // 键位：鼠标右键（input.MOUSE_ACTIONS.parry = [2]）
    WINDOW: 0.22, // 按下后的卸势判定窗口（秒）——太宽变"按住就无敌"，太窄按不出来
    COOLDOWN: 0.55, // 两次卸势的最小间隔（空按也进冷却）
    STUN: 1.2, // 卸势成功：攻击者硬直（秒）
    INVINCIBLE: 0.35, // 卸势成功：玩家无敌余量（秒）
    GAIN_MUSOU: 5, // 卸势成功回无双槽
    GAIN_KI: 4, // 卸势成功回斗气
  },
};

// ─────────────────────────────────────────────── 模块 4：敌人（杂兵实体）
/**
 * 敌人实体的**体型与耐久**。AI 行为在 ENEMY_AI 里，两者刻意分开：
 * 这一个文件回答"这个兵多硬"，ENEMY_AI 回答"这个兵想干什么"。
 */
export const ENEMY = {
  RADIUS: 0.5, // 受击/推挤半径（比玩家的 0.45 略大，几百个挤在一起才不会有"薄片互穿"）
  HEIGHT: 1.78,
  // 血量 36 是照着**连段节奏**反推的，不是拍脑袋：
  //   N1(10) → N2(12) → N3(14) 三下一套刚好 36 —— 杂兵三下死，是"割草"的基准手感。
  //   重击 H(30×2) 一击必杀，C3 及以上单段就能带走一片。
  HP: 36,
  // ⚠ 重生**不让基类管**（基类 TargetPool 到点就复活在老家）：
  //   那会在玩家眼前凭空刷兵。改成由 EnemyDirector 接管，多一条"离玩家至少 26m 才敢露面"的守卫。
  RESPAWN: Infinity,
  PUSH_BOUND: 96,

  // ——— 布点（种子生成，和模块 1 的战场一样：刷新页面敌情完全一致）———
  COUNT: 160, // 同屏杂兵总数。选它的理由是 draw call：整支军队走 InstancedMesh，只占 5 次
  SPAWN_SEED: 20260925,
  SPAWN_MIN_GAP: 13, // 出生点周围这个半径内不刷敌 —— 留出练武场（模块 3 的训练靶在这）
  SPAWN_MAX_R: 92,
  SQUADS: 14, // 远端小队
  SQUAD_SIZE: 9, // 14 × 9 = 126
  SQUAD_SPREAD: 5.5, // 小队内部的松散半径
  VANGUARD: 34, // 近场"先锋"：14~21m，一开局就够得着，不会站着等
  VANGUARD_R_MIN: 14,
  VANGUARD_R_MAX: 21,
};

// ─────────────────────────────────────────────── 模块 4：敌人分层 AI
/**
 * ★SPEC 原文：
 *   「敌人分为 3 种状态：待机态、威慑态、攻击态；同一时间最多 35 个敌人进入攻击态，
 *     其余敌人处于威慑态（缓慢向玩家靠近，不发起攻击），远距离敌人保持待机态；
 *     采用攻击插槽系统，攻击态敌人占用插槽，敌人被击倒 / 脱离范围后释放插槽；
 *     威慑态追击距离 22m，超出 22m 切回待机；攻击态敌人攻击间隔 1.2~2.2s 随机，
 *     敌人受击后进入硬直暂停 AI 逻辑；敌人群体不全部同时围殴玩家，保证割草流畅性。」
 *
 * ⚠ 两处需要写下来的口径判断：
 *
 * ① spec 写的是「攻击间隔 1.22.2s 随机」，这个数在字面上不自洽（1.22 与 2.2 之间缺分隔）。
 *    本实现按 **1.2 ~ 2.2s** 取值 —— 理由：1.2s 是"割草游戏里杂兵不显得呆滞"的下限，
 *    2.2s 与"一次前摇 0.4s + 收招 0.55s"叠加后，单个敌人平均每 2s 内只有约 0.95s 有威胁，
 *    35 个槽位同时压上来也留得出反应窗口。若原意是别的（例如 1.2~2.2 之外），
 *    只改 ATTACK_INTERVAL_MIN / MAX 两个常量，其余全部从它们派生。
 *
 * ② 三态之间**全部带迟滞**，否则敌人在阈值上会疯狂抖动（表现为原地抽搐）：
 *    22m 是"离开威慑"的硬门槛（照 spec 逐字），21m 是"重新进入威慑"的入界值。
 *    攻击环同理：4.6m 申请插槽、6.0m 才交还。迟滞宽度取实测抖动带的 2 倍以上。
 */
export const ENEMY_AI = {
  // ——— 攻击插槽（★SPEC 35）———
  MAX_ATTACKERS: 35,

  // ——— 分层距离（米）———
  LEASH: 22, // ★SPEC 威慑态追击距离：超过它就切回待机
  RE_ENGAGE: 21, // 迟滞的入界值（见上文 ②）
  ATTACK_TRIGGER: 4.6, // 进到这个距离才有资格申请攻击插槽
  ATTACK_LEASH: 6.0, // 攻击态被拉开到这里就交还插槽（迟滞出口）
  // 攻击态停在 1.9m 处出手 —— 这个数必须**小于** ATTACK_REACH，
  // 否则敌人会站在"够不着"的位置规律性空挥（帧长 0.05s × 速度 2.9 = 单帧最多冲过 0.145m，
  // 留出这段余量才不会被一次大步跨过判定圈）。
  ATTACK_RANGE: 1.9,
  THREATEN_RING: 3.9, // 威慑态在玩家外围保持的环距 —— "围而不攻"的那一圈
  STANDOFF: 1.30, // 与玩家的最小间距 = 玩家半径 0.45 + 敌人半径 0.5 + 0.35 余量

  // ——— 移动 ———
  THREATEN_SPEED: 1.05, // ★SPEC「缓慢向玩家靠近」：约等于玩家走速的 1/4
  ATTACK_SPEED: 2.9, // 攻击态扑近（仍慢于玩家 4.2，所以"跑得掉"）
  HOME_RETURN_SPEED: 1.2, // 待机态回老家
  WANDER_SPEED: 0.42, // 待机态在原地晃荡
  WANDER_RADIUS: 6.5,
  TURN_RATE_DEG: 380, // 转向角速度（比玩家慢：杂兵不该像陀螺）

  // ——— 攻击（★SPEC 1.2~2.2s 随机）———
  ATTACK_INTERVAL_MIN: 1.2,
  ATTACK_INTERVAL_MAX: 2.2,
  ATTACK_WINDUP: 0.4, // 起手前摇。**它存在的唯一理由是给玩家反应窗口**（闪避/走开）
  ATTACK_RECOVER: 0.55, // 收招（这段时间不动作，是"打完一轮的空档"）
  ATTACK_DAMAGE: 8, // 命中玩家扣多少（⚠ 玩家血条归模块 5/8，本轮只统计命中次数与无敌判定）
  ATTACK_ARC_DEG: 100, // 打击张角（判定用）
  ATTACK_REACH: 2.5, // 打击距离（敌人**圆心到玩家圆心**；已含玩家半径 0.45 的余量）

  // 敌人的"可跨台阶高度"。给一个很小的值 = **什么障碍都翻不过去**：
  // 杂兵不是玩家，不该会跳上木箱（那会让"跳上箱子躲一会儿"这个模块 2 的玩法失效）。
  STEP_HEIGHT: 0.05,

  // ——— 硬直 ———
  // ★SPEC「敌人受击后进入硬直暂停 AI 逻辑」= 暂停。但**前摇中被打断要作废这次攻击**，
  //   否则玩家"抢先砍中"这个操作没有任何收益，手感会很差（举刀被砍→僵一下→刀照落）。
  //   这是对 spec 的**补充**而不是改写：spec 没说前摇被击中会怎样。
  STUN_CANCELS_WINDUP: true,

  // ——— 群体 ———
  SEPARATION: 1.3, // 敌人之间的最小间距（半径和 1.0 + 余量）
  SEPARATION_PUSH: 3.4, // 分离推力（m/s），越大越像"挤开"而不是"穿过去"
  SEPARATION_MAX_NEIGHBORS: 8, // 每个敌人最多被几个邻居推动（防止人堆中心的推力爆表把人弹飞）
  BRACE_SCALE: 0.25, // 起手 / 收招时的分离推力折扣（"站桩"）—— 见 enemyAI 里的理由
  PLAYER_PUSH: 6.0, // 被玩家身体挤开的推力

  // ——— 重生（原型行为，模块 8 的关卡流程会接管）———
  RESPAWN_DELAY: 6.0,
  RESPAWN_MIN_PLAYER_GAP: 26, // 离玩家至少这么远才允许重生，避免在眼前凭空刷兵
};

// ─────────────────────────────────────────── 模块 6：据点与士气系统
export const MORALE = {
  START: 50, // ★SPEC 士气初始值
  MAX: 100, // ★SPEC 士气上限
  MIN: 0,
  PER_CAPTURE: 15, // ★SPEC 每占领一个据点 +15 士气
  // 士气双向挂钩敌人强度（仅影响"生成侧"难度，不改单个敌人的基础数值）：
  //   士气 100 → 敌人重生间隔 ×(1 + RESPAWN_BONUS)、基础攻击力 ×(1 - ATTACK_REDUCE)
  //   士气 50（基准）→ 都是 ×1（上面的减项是"相对 50 的偏移"，所以 50 时正好 0）
  RESPAWN_BONUS: 1.5, // 士气 100 时敌人重生间隔相对基准 +150%（即 ×2.5）
  ATTACK_REDUCE: 0.3, // 士气 100 时敌人攻击力相对基准 -30%
};

/**
 * ★SPEC 据点（3 个可占领）。
 *   占领进度 0~100；玩家站在 RADIUS 内每秒 +RATE，敌方士兵在 RADIUS 内每秒 -DECAY；
 *   据点内有 GUARDS_PER_POINT 个守卫（由敌人池里标 `guardOf` 的敌人充当），
 *   守卫未清光前进度会被持续抵消、且占领不结算（见 points.js）。
 * 坐标放在战场四角附近、互相拉开，避免开局就叠在一起；半径 8m 的圈足以容纳占领动作。
 */
export const POINTS = {
  RADIUS: 8, // ★SPEC 占领范围半径
  RATE: 2.2, // ★SPEC 玩家每秒占领进度
  DECAY: 1.6, // 敌方在范围内每秒抵消的进度
  GUARDS_PER_POINT: 4, // 每据点守卫数（清光才能稳定占领）
  LIST: [
    { id: 'p1', name: '东门哨塔', x: 48, z: 14 },
    { id: 'p2', name: '西市集', x: -50, z: -10 },
    { id: 'p3', name: '中军大帐', x: 6, z: -54 },
  ],
};

// ─────────────────────────────────────────── 模块 7：战场 UI（纯展示，数值在别处）
export const HUD = {
  KILL_POPUP_MS: 2200, // 百人斩/千人斩弹字停留时间
  HUNDRED_LABEL: '百人斩', // ★SPEC 100 击杀
  THOUSAND_LABEL: '千人斩', // ★SPEC 1000 击杀
  FONT_MIN: 12, // 文字最小 px（随窗口缩放但不低于此值）
  FONT_MAX: 22, // 文字最大 px
};

// ─────────────────────────────────────────── 模块 8：关卡流程与 Boss 战
export const STAGE = {
  MAX_ACTIVE: 45, // ★SPEC 最大同屏杂兵总数上限（动态刷新；模块 4 的 160 是池容量，二者并存）
  HUNDRED_KILL: 100, // ★SPEC 百人斩触发
  THOUSAND_KILL: 1000, // ★SPEC 千人斩触发
  KILLS_TO_CONTEST: 60, // 杂兵阶段累计击杀到这个数 → 进入"据点争夺"阶段
  PHASES: ['frontline', 'contest', 'boss'], // 线性三阶段
  RESPAWN_DELAY_BASE: 6.0, // 杂兵重生基础间隔（受士气拉伸）
};

/**
 * ★SPEC Boss 战：独立血条、2 套基础攻击技能、阶段变化、受一定伤害后进入狂暴。
 *   · 血量降到 BERSERK_AT 比例 → 进入狂暴：出手间隔 ×BERSERK_INTERVAL_MUL、伤害 ×BERSERK_DAMAGE_MUL
 *   · 两套攻击：skill1 近身扇形（ATTACK_*）、skill2 范围 AOE（SKILL_2_*）
 *   · 击败 Boss → 关卡通关（结算面板由 main 弹）
 */
export const BOSS = {
  HP: 2600,
  RADIUS: 1.1,
  HEIGHT: 2.6,
  MOVE_SPEED: 3.2, // 比玩家慢，但比杂兵快，逼迫玩家绕背
  ATTACK_DAMAGE: 18,
  ATTACK_REACH: 4.0,
  ATTACK_ARC_DEG: 140,
  ATTACK_WINDUP: 0.55, // 起手前摇（给玩家反应窗口）
  ATTACK_RECOVER: 0.7,
  ATTACK_INTERVAL_MIN: 2.4, // 非狂暴出手间隔
  ATTACK_INTERVAL_MAX: 3.6,
  SKILL2_DAMAGE: 26, // 第二套：范围 AOE
  SKILL2_RADIUS: 9,
  SKILL2_WINDUP: 0.8,
  SKILL2_RECOVER: 0.9,
  BERSERK_AT: 0.5, // 血量降到 50% → 狂暴
  BERSERK_INTERVAL_MUL: 0.6, // 狂暴后出手间隔 ×0.6（攻击频率提升）
  BERSERK_DAMAGE_MUL: 1.3, // 狂暴后伤害 ×1.3
  RESPAWN: false, // Boss 不重生
};


// ─────────────────────────────────────────────────────────────── 渲染
export const RENDER = {
  MAX_PIXEL_RATIO: 2,
  TONE_MAPPING_EXPOSURE: 1.0, // ACES 显影曝光：用来压住 1.2+0.3 的光量，不动 spec 光强
  SHADOW_TYPE_PCF: true,
  POWER_PREFERENCE: 'high-performance',
};

// ─────────────────────────────────────────────────────────────── 调试
export const DEBUG = {
  HUD: true, // F3 开关（模块 7 会换成正式战场 UI）
  AXES_HELPER: false, // F4
  ENEMY_STATE_RINGS: false, // F5：给每个敌人脚下画一个状态色环（待机灰 / 威慑蓝 / 攻击红）
  //   分层 AI 的三态**肉眼看不出来** —— 都在走、都在转身，区别只在"有没有资格打你"。
  //   这个色环是唯一能一眼验证"35 上限"和"22m 分界"的手段，也是模块 4 探针目视图的素材。
  WORLD_GLOBAL: 'MUSOU', // window.MUSOU —— 探针断言"应用真的起来了"用的锚点
};

// ═══════════════════════════════════════════════════════════════════════════
// 模块 10：画面 / 模型 / 动画 / 特效质量提升（水墨风改版）
// ---------------------------------------------------------------------------
// ⚠ 全部为**新增**常量，模块 1~9 的数值与逻辑一字未改（护栏见 tests/config.test.mjs）。
//   渲染原案（ACES / 后处理泛光 / PCF 软阴影 / 指数雾 / 15m 草簇 / PBR 模型 / LOD / 贴花池 30）
//   维持不变；本块只在原案之上追加"水墨配色 + 强化打击粒子反馈"的开关与数值。
// ⚠ 颜色采用"墨色基调 + 朱砂红唯一强调色 + 淡青黛蓝远景"的水墨三色体系（模块 11 UI 同款）。
export const POSTFX = {
  ENABLED: true, // ★SPEC 开启后处理链
  HALF_RES_BLOOM: true, // 后处理按半分辨率渲染
  BLOOM_STRENGTH: 0.6, // ★SPEC 泛光强度
  BLOOM_RADIUS: 0.4, // ★SPEC 泛光半径
  BLOOM_THRESHOLD: 0.9, // ★SPEC(改版) 阈值由 0.85 上调至 0.9 —— 只让朱砂红与闪帧发光，墨色保持哑光不泛光
  MUSOU_BLOOM_STRENGTH: 1.2, // ★SPEC 无双乱舞时泛光增强至 1.2
  PAPER_FLASH_HZ: 0.3, // 无双期间每 0.3s 叠加一次宣纸米白全屏闪帧
  PAPER_FLASH_DUR: 0.05, // 单次闪帧持续（留白爆点）
};

// ── 环境：天穹 / 雾 / 远景剪影 ──
// ⚠ 模块 13 改版：整体从"墨青近黑天顶 + 灰黄雾"改成"宣纸米白"基调 —— 天更亮、雾更白，
//   是为了让墨灰阶的主角在**亮底**上成为画面里唯一的深色块（可读性 = 对比度，不是亮度）。
export const ENVIRONMENT = {
  FOG_DENSITY: 0.007, // ★SPEC(模块13) 指数雾密度 0.004 → 0.006~0.008（取 0.007）
  FOG_COLOR: 0xf5f0e6, // ★SPEC(模块13) 雾色改宣纸米白
  SKY_TOP: '#f5f0e6', // ★SPEC(模块13) 宣纸米白天顶（原墨青近黑 #3a3f4a）
  SKY_HORIZON: '#d8d2c4', // ★SPEC(模块13) 地平线略压一档，保留渐变层次
  SUN_HALO_COLOR: 0xe8e2cf, // 太阳光晕（米白）
  SUN_HALO_SIZE: 9, // 光晕精灵直径（米）
  SUN_HALO_INTENSITY: 0.5, // ★SPEC(模块13) 光晕强度降至 0.5（原来是满强度 1.0）
  SILHOUETTE_DRAW_CALLS: 10, // ★SPEC 远景剪影 draw call ≤ 10
  SILHOUETTE_DISTANCE: 180, // 远景山体/树林距玩家距离
  GROUND_DETAIL: true, // 地面叠加细节法线（程序化）
  // ── 模块 13：山体改 2~3 层淡墨剪影（由近及远 #9aa3a0 → #c9cdc8）
  SILHOUETTE_RINGS: 3,
  SILHOUETTE_NEAR_COLOR: 0x9aa3a0, // 最近一层：淡墨灰绿
  SILHOUETTE_FAR_COLOR: 0xc9cdc8, // 最远一层：接近宣纸底，几乎只剩轮廓
  SILHOUETTE_RING_SCALE: [0.62, 1.0, 1.35], // 三层由近及远的距离倍率
  SILHOUETTE_RING_HEIGHT: [1.0, 1.18, 1.4], // 越远的山整体越高（透视上才不会"缩"）
  // ── 模块 13：3 条山间雾带（半透明平面，随相机距离淡入淡出）
  //   ⚠ 雾带是**世界固定**的，不跟随玩家 —— 跟随的话"相机到它的距离"恒为 radius−8m，
  //     是个常数，spec 的"随相机距离淡入淡出"在代码里永远不会触发（详见 environment.js update）。
  MIST_BANDS: 3,
  MIST_COLOR: 0xf5f0e6,
  MIST_OPACITY: 0.38,
  MIST_HEIGHT: [14, 22, 30], // 三条带各自的空中高度
  // ⚠ 半径必须**相对战场尺度**来定：200×200 的战场里半径 86~158m 的环，
  //   玩家从地图这头走到那头也碰不到边，d = |flat − radius| 只在极窄区间浮动，
  //   淡入淡出等于没有（实测读数 0.0018~0.0305，等于没动）。
  //   现在的取值让三条带都落在"玩家走得到、视角里能横穿过去"的尺度上。
  MIST_RADIUS: [40, 62, 86],
  MIST_SPREAD: 20, // 三条带绕战场中心的分布半径（错开摆放，走过去才会"穿过"）
  MIST_FADE_NEAR: 6, // 相机贴到带边（<6m）几乎透明（避免糊脸）
  MIST_FADE_FAR: 90, // 远离 90m 完全显现
};

// ── 草簇：玩家周围 15m 半径内实例化 ──
export const GRASS = {
  RADIUS: 15, // ★SPEC 15m 半径内渲染，之外不渲染
  COUNT: 3200, // ★SPEC 2000~5000 实例（取中值）
  BLADE_W: 0.16,
  BLADE_H: 0.62,
  WIND_FREQ: 1.6, // sin(时间) 风摆频率
  WIND_AMP: 0.12, // 风摆幅度（弧度）
  FADE_START: 11, // 11m 起淡出
  // ── 模块 13：15m 草簇配色同步降饱和（与地形贴图同一套口径）
  INK_SAT_MUL: 0.7, // 饱和度 −30%
  INK_LIGHT_MUL: 0.9, // 明度 −10%
};

// ── 模块 13：场景水墨调色目标（地形贴图 / 土路 / 远景小兵共用）──
// ⚠ 为什么是"目标色"而不是直接改贴图常量：贴图里有几十种随机色斑，逐个 hand-tune 不现实，
//   统一走 inkTone.js 的"逐像素 HSL 变换 → 整图均值平移到 target"，层次和落点解耦。
export const SCENE_INK = {
  GRASS_SAT_MUL: 0.7, // ★SPEC 草地饱和度 −30%
  GRASS_LIGHT_MUL: 0.9, // ★SPEC 草地明度 −10%
  GRASS_TARGET: 0x7a8a72, // ★SPEC 目标灰绿
  ROAD_SAT_MUL: 0.7,
  ROAD_LIGHT_MUL: 0.95,
  ROAD_TARGET: 0x8a7a68, // ★SPEC 目标灰褐
  // 远处小兵（LOD2）：转淡墨剪影 + 减对比
  ENEMY_FAR_START: 45, // 超过此距离开始揉进淡墨（与模块 9 的 LOD_FAR 对齐）
  ENEMY_FAR_INK: 0x9aa3a0, // 淡墨灰绿（与最近一层山同色系）
  ENEMY_FAR_MIX: 0.8, // 最远时靠向淡墨的比例
  ENEMY_FAR_CONTRAST: 0.45, // 对比保留 45%（= 减对比）
};

// ── 贴花（墨渍 / 焦痕）：对象池容量 30 ──
export const DECAL = {
  POOL: 60, // ★SPEC(模块13) 对象池 30 → 60（土路墨晕边缘要常驻一大批，30 会被战斗墨渍挤没）
  SIZE: 2, // ★SPEC 单张贴花 2m×2m
  LIFE: 30, // ★SPEC 存活 30s 淡出
  MAX_ALPHA: 0.2, // ★SPEC 透明度 alpha ≤ 0.2（非写实）
  NON_GORY: true, // 墨渍/焦痕，不采用写实血腥
  // ── 模块 13：土路边缘墨晕（沿路两侧铺一排半透墨渍，把路和草地的接缝"洇"开）
  ROAD_EDGE_INK: true,
  ROAD_EDGE_SPACING: 2.2, // 每 2.2m 一张（见 ROAD_EDGE_SCALE 区间：必有实例重叠，连得成一条）
  ROAD_EDGE_SCALE: [0.85, 1.3], // 每张的随机缩放系数（×DECAL.SIZE 得实际边长）
  ROAD_EDGE_INSET: 0.35, // 从路边往内缩多少米（贴在线上会一半悬空在草地上，反而脏）
  ROAD_EDGE_ALPHA: 0.55, // 相对 MAX_ALPHA 的系数（墨晕比战斗墨渍淡）
  ROAD_EDGE_PERMANENT: true, // 常驻：不进 30s 淡出队列
  ROAD_EDGE_MAX_INSTANCES: 900, // 实例上限（4 条路约 460 张，留一倍余量；超了会截断并 warn）
};

// ── 水墨战斗特效 ──
export const INKFX = {
  PARTICLE_BUDGET: 6000, // ★SPEC(模块13) 同屏粒子总预算 5000 → 6000
  RIBBON_CAP: 12, // ★SPEC 刀光拖尾同屏上限 12
  DECAL_CAP: 60, // ★SPEC(模块13) 贴花上限跟随 DECAL.POOL 30 → 60
  AFTERIMAGE_CAP: 24, // ★SPEC 残影 ≤ 24
  FLOAT_POOL: 120, // ★SPEC(改版) 飘字池 100→120
  HITFX_POOL: 160, // ★SPEC(模块13) 模块 9 受击特效池 120 → 160

  // 粒子数量（★SPEC 模块13：整体放大约 1.5×）
  SPARK_LIGHT_MIN: 30, SPARK_LIGHT_MAX: 45, // 轻击 20~30 → 30~45 墨点
  SPARK_HEAVY_MIN: 60, SPARK_HEAVY_MAX: 90, // 重击/C 技 40~60 → 60~90 墨点
  CINNABAR_MIN: 12, CINNABAR_MAX: 18, // 重击混入 8~12 → 12~18 粒朱砂红火点
  SPARK_LIFE_LIGHT: [0.25, 0.35], // 轻击墨点寿命 0.25~0.35s
  SPARK_LIFE_HEAVY: [0.3, 0.45],
  SPARK_GRAVITY: 9.0, // 墨点重力下坠

  // 刀光笔触拖尾（★SPEC 模块13：宽度 0.3→0.5m、寿命 0.12→0.18s）
  RIBBON_WIDTH: [0.5, 0.6], // 米（原 0.3~0.5；保留随机笔触粗细，但最细也有 0.5m）
  RIBBON_LIFE: [0.18, 0.24], // 秒（原 0.1~0.18；整体抬到最短 0.18s）
  RIBBON_TIP_FLASH: 0.05, // 命中瞬间刀光末端闪白 0.05s
  RIBBON_CINNABAR_TIP: true, // 重击/C 技收尾刀光末梢加一笔朱砂红渐隐点睛

  // 冲击环（★SPEC 改版：墨晕扩散环）
  RING_LIFE: 0.25, // 普通冲击环 0.25s 淡出
  RING_MUSOU_LIFE: 0.6, // 无双/武艺墨浪环 0.6s 淡出
  RING_MUSOU_RADIUS: 14, // 墨浪环扩散至 14m

  // ── 模块 13：重击/C 技追加的「墨浪爆发环」──
  //   比普通冲击环更大更久：半径 1m 扩散到打击盒半径 ×MUL，0.3s 淡出。
  RING_WAVE_ENABLED: true,
  RING_WAVE_LIFE: 0.3, // ★SPEC 0.3s 淡出（普通环 0.25s）
  RING_WAVE_MUL: 1.25, // ★SPEC「大于普通冲击环」：终点半径 = 打击盒半径 × 1.25
  RING_WAVE_OPACITY: 0.95, // 起始不透明度（普通环 0.8）
  RING_WAVE_R0: 1, // ★SPEC 起始半径 1m

  // ── 模块 13：敌人墨烟消散（击杀时的小墨浪 + 墨点爆开）──
  DEATH_POOF_RADIUS: 0.8, // ★SPEC 小墨浪环半径 0.8m
  DEATH_POOF_LIFE: 0.3,
  DEATH_POOF_MIN: 8, DEATH_POOF_MAX: 12, // ★SPEC 8~12 粒墨点爆开

  // 武艺配色（★SPEC 改版）
  ART1_COLOR: 0xb5322a, // 技能 1 朱砂红火
  ART2_COLOR: 0x3a6f8a, // 技能 2 淡墨青蓝雷
  ART_WARN_LEAD: 0.8, // 释放前 0.8s 地面预警范围圈

  // 命中顿帧（★SPEC 改版，与无双慢动作共用时间缩放通道、不叠加）
  HITSTOP_SCALE: 0.15,
  HITSTOP_LIGHT: 0.05,
  HITSTOP_HEAVY: 0.1,
  HITSTOP_SPECIAL: 0.15,
  HITSTOP_HEAVY_FREEZE: 0.03, // 重击/C 技命中附加 1 帧全身顿住 0.03s
  // ★SPEC(模块13) 顿帧与模块 11 音效**同帧**触发（音效在 _onDamage 里先播、顿帧紧随其后，
  //   两者共用同一个事件，不存在两条独立计时器 → 天然同步，不会越打越漂）。
  HITSTOP_AUDIO_SYNC: true,

  // 镜头震动（★SPEC 改版，持续 0.1s）
  SHAKE_LIGHT: [0.05, 0.08],
  SHAKE_HEAVY: [0.15, 0.2],
  SHAKE_SPECIAL: [0.25, 0.35],
  SHAKE_DUR: 0.1,

  // 伤害飘字（★SPEC 模块13 改版）
  FLOAT_RISE: 1.2, // 上浮 1.2m 淡出
  FLOAT_FONT_BASE: 16.8, // ★SPEC 字号 ×1.2（原 14px → 16.8px）
  FLOAT_HEAVY_MULT: 1.5, // 重击/C 技大字倍率（沿用）
  FLOAT_SPECIAL_MULT: 2, // 无双/武艺纯白大字（沿用）
  FLOAT_HEAVY_COLOR: '#b5322a', // ★SPEC 重击/C 技改朱砂红（描边与字同为朱砂，原金色调）
  FLOAT_HEAVY_STROKE: '0 0 5px rgba(181,50,42,.9), 0 1px 3px rgba(0,0,0,.75)',

  // 无双残影（★SPEC 改版：墨色半透明）
  AFTERIMAGE_INTERVAL: 0.05, // 每 0.05s 记录位置
  AFTERIMAGE_LIFE: 1.2, // 保留 1.2s 共 ~24 个
};

// ── 时间缩放（顿帧 / 慢动作演出，模块 10 新增，默认 1.0 不影响模块 1~9）──
export const TIME = {
  MUSOU_SLOW_SCALE: 0.3, // ★SPEC 无双释放时间缩放 0.3 倍
  MUSOU_SLOW_DUR: 0.4, // 持续 0.4s 后恢复（慢动作起手）
};

// ── 武将主角模型（模块 10 改版：PBR 四通道 + 蒙皮骨骼近似）──
export const HERO = {
  TRI_MIN: 15000, TRI_MAX: 20000, // ★SPEC 15000~20000 三角面
  CROSSFADE: 0.12, // ★SPEC 状态切换 crossfade 0.12s
  HIT_REACTION_DIRS: 4, // ★SPEC 受击硬直 4 方向（前/后/左/右）
  DEATH_DURATION: 1.2, // ★SPEC 死亡倒地 1.2s
  CORPSE_FADE: 5.0, // ★SPEC 尸体停留 5s 后淡出回收
  CAPE_DRIVEN: true, // 披风蒙皮骨骼驱动（近似）
  WEAPON_EMISSIVE: true, // 武器金属 + 刀刃自发光

  // ── 模块 13：主角可读性 ──
  //   验收口径是"8m / 4m 相机距离下，玩家在绿地背景上一眼定位"——
  //   纯黑角色压在绿色草地上，明度差够但**色相全丢**，远景就是一个黑洞；
  //   提到墨灰阶 + 加金属高光 + 朱砂盔缨自发光，靠"冷灰主体 + 一点朱砂"把它从背景里拎出来。
  BODY_ALBEDO: 0x4a4a4a, // ★SPEC 主色 #2e2a26 → #4a4a4a（墨灰阶）
  BODY_ROUGHNESS: 0.4, // ★SPEC 0.55 → 0.4（高光更利）
  BODY_METALNESS: 0.3, // ★SPEC 金属度 0.3
  TONE_APPLY_TO_ASSET: true, // 外部模型（模块 12）的材质也按这套口径染一遍，否则换模型可读性就没了
  TONE_MIX: 0.85, // 外部模型染色时"保留原贴图"的比例（1 = 完全用墨灰覆盖，0 = 不动）
  PLUME_SCALE: 1.3, // ★SPEC 朱砂盔缨尺寸 ×1.3
  PLUME_EMISSIVE: 0xc23b22, // ★SPEC 盔缨自发光朱砂
  PLUME_EMISSIVE_INTENSITY: 1.2, // ★SPEC 常态强度 1.2
  PLUME_FLASH_INTENSITY: 3.0, // ★SPEC 命中瞬间突增至 3.0
  PLUME_FLASH_DUR: 0.1, // ★SPEC 0.1s 后回落 1.2
  PLUME_FOR_ASSET: true, // 外部模型没有盔缨时，给它的头部骨骼补一支（可读性锚点，也便于探针计数）
  // 背光 rim light：不是加一盏全场灯，而是**挂在角色身上、distance 只有 6m** 的点光，
  //   只照亮角色轮廓与脚下一小圈地面，把角色从背景里"描"出来，不影响模块 1 的整体光照。
  RIM_LIGHT: {
    ENABLED: true,
    INTENSITY: 0.6, // ★SPEC 强度 0.6
    COLOR: 0xf5f0e6, // 宣纸米白（与雾/天同色系，避免第二个人造色相）
    DISTANCE: 6, // 影响半径 6m（超出即衰减到 0）
    HEIGHT: 1.7, // 挂点高度（角色胸口偏上）
    BACK: 1.1, // 往角色**背后**偏移多少米（背光才有 rim 效果）
    DECAY: 1.6,
  },

  // ── 模块 12：外部角色资产（glTF / VRM）加载 ──
  // path 为 null → 使用内置程序化 PBR 武将（零资产可读、单测可跑、探针可绿）。
  // 当前指向 tools/make-hero-glb.mjs 合成的占位 .glb（用户未提供模型文件时由我自行生成，
  //   用于端到端验证「GLTFLoader 加载 → 骨骼映射 → 动画驱动」管线）。真美术模型到位后直接替换
  //   assets/hero/model.glb 即可，契约不变。
  //   · .glb/.gltf 用 GLTFLoader（已 vendored 到 vendor/three/jsm/loaders/，不引入 npm 依赖）
  //   · .vrm 用 @pixiv/three-vrm（⚠ 该包需 npm 安装，会破"零依赖零构建"铁律，需主理人授权）
  // 加载期间显示「水墨剪影占位」；加载失败/无资产 → 优雅退回程序化 PBR 武将，绝不黑屏。
  ASSET_PATH: 'assets/hero/model.glb',
  // 动画状态 → 资产内 clip 名称（按名称映射；找不到则退回程序化姿态驱动）
  ANIM: {
    idle: 'idle', run: 'run', dash: 'dash', jump: 'jump',
    N1: 'N1', N2: 'N2', C3: 'C3', C4: 'C4', C5: 'C5',
    heavy: 'heavy', charge: 'charge', musou: 'musou',
    art1: 'art1', art2: 'art2',
    hitFront: 'hitFront', hitBack: 'hitBack', hitLeft: 'hitLeft', hitRight: 'hitRight',
    death: 'death',
  },
  // 表情 blendshape 映射（VRM / 通用）：joy→常态 / angry→攻击凛然 / sorrow→受击咬牙
  EXPRESSION: { normal: 'joy', fierce: 'angry', clench: 'sorrow' },
  EXPRESSION_TRANSITION: 0.1, // ★SPEC 表情过渡 0.1s
  OUTLINE_ENABLED: true, // 墨色描边总开关（关掉就完全不加外壳网格，零开销）
  OUTLINE_WIDTH: 2, // ★SPEC 墨色描边 2px（inverted hull 或后处理轮廓）
  OUTLINE_WIDTH_BOSS: 3, // ★SPEC 无双/武艺期间描边转朱砂红并加粗至 3px
  OUTLINE_COLOR: 0x1c1c1e, // 墨色
  OUTLINE_COLOR_CINNABAR: 0xb5322a, // 朱砂红
  // 武艺是**瞬发**的（没有持续状态位），描边只能"闪"一小段；无双有 ranbuTimer 天然可持续。
  OUTLINE_ART_FLASH: 0.9, // 武艺触发后朱砂描边保持 0.9s
  LOD_NEAR: 25, // 模块 9 分级（沿用）：0~25m 完整
  LOD_FAR: 45, // 25~45m 简化；45m+ 不渲染
  LOD_SHADOW_MAX: 30, // 阴影 30m 内开启
  // ── LOD 减面（模块 12 增强）：距离分级接入 THREE.LOD + 离线顶点聚类减面 ──
  //   · 运行时只在「存在 LOD 副资产」时构建 THREE.LOD 层级（LOD0 完整 / LOD1 @NEAR / LOD2 @FAR），
  //     否则退化成单 LOD0，行为与旧版一致（不影响模块 1~11）。
  //   · 减面由 tools/make-hero-lod.mjs 离线生成 model.lod1.glb / model.lod2.glb（零外部依赖，
  //     顶点聚类），只在模型三角面 > DECIMATE_THRESHOLD 时才需要。
  LOD: {
    ENABLED: true,
    NEAR: 25, // 0~25m 显示 LOD0（完整）
    FAR: 45, // 25~45m 显示 LOD1；>45m 显示 LOD2（再远则保持 LOD2，模块 9 距离剔除另算）
    SHADOW_MAX: 30, // 阴影 30m 内开启
    DECIMATE_THRESHOLD: 30000, // 三角面 > 此值才建议跑离线减面生成 LOD1/LOD2
    LOD1_RATIO: 0.5, // LOD1 保留约 50% 顶点密度
    LOD2_RATIO: 0.25, // LOD2 保留约 25% 顶点密度
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// 模块 11：水墨风战场 UI 与战斗音效
// ---------------------------------------------------------------------------
// ⚠ 视觉与模块 10 特效配色保持一致：宣纸米白底 / 墨色描边 / 朱砂红强调 / 淡墨青蓝。
//   逻辑布局（模块 7）与对象池/降级（模块 9）数值一律沿用，本块只放"外观与音效"开关。
export const INK_UI = {
  PAPER_ALPHA: 0.85, // 宣纸米白半透明底
  INK_EDGE: 0.9, // 墨色描边强度
  ACCENT: 0xff3b2f, // 朱砂红强调
  CINNABAR: '#b5322a',
  PAPER: '#efe9d8',
  INK: '#1c1c1e',
  INK_SOFT: '#3a3a3e',
  DAICING: '#3a6f8a', // 淡墨青蓝（技能 2 / 远景）
  SEAL: '無', // 满槽印章式字
  FONT: '"Ma Shan Zheng","ZCOOL XiaoWei","STKaiti","KaiTi","Kaiti SC",serif', // 毛笔书法字体栈
  LOW_HP: 0.25, // 血量≤25% 血条闪烁
  SCROLL_BANNER: { open: 0.6, hold: 2.5, close: 0.5 }, // 卷轴横幅（0.6s 展开 / 停留 2.5s / 0.5s 收卷）
};

export const AUDIO = {
  ENABLED: true,
  MASTER: 0.8, // ★SPEC 主音量 0.8
  HIT_VOL: [0.6, 0.7], // ★SPEC 打击音量 0.6~0.7
  AMBIENT_VOL: [0.2, 0.3], // ★SPEC 环境音量 0.2~0.3
  MAX_CONCURRENT: 16, // ★SPEC 音效并发上限 16（对象池复用）
  MUTE_KEY: 'KeyM', // M 键一键静音/恢复
  STORE_KEY: 'musou-audio-muted', // 静音状态记忆（localStorage）
  // 各音效时长（秒，供对象池回收估算）
  DURATIONS: {
    swing: 0.13, hitLight: 0.08, hitHeavy: 0.2, musou: 1.1, art1: 0.6, art2: 0.3,
    enemyHit: 0.1, enemyDeath: 0.3, point: 0.8, moraleUp: 0.5, moraleDown: 0.4,
    bossEnter: 2.0, bossBerserk: 1.0, victory: 1.5, paper: 0.1,
  },
};
