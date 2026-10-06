// 荒野遭遇：独立实时割草小关（阶段 6）
//
// 硬约束对照（spec §0）：
//   0.1 全新独立模块，不往回合制（combat/effects/run）里塞任何代码。
//   0.2 竖屏 9:16 + 剪影单色美术口径，复用现有色板（--ink 暗场 / --flux 紫 / --paper）。
//   0.3 自有 rAF 循环，与主循环解耦；进入暂停主游戏、退出恢复（main.js 负责接线）。
//   0.4 不新增货币、不改 HP/伤害经济、不改 12 节点总数（地图接入在 mapgen.js，总数仍 12）。
//   0.5 粒子数封顶，低端机/软件渲染不卡。
//
// 设计要点（关乎确定性，见 docs/07 §RNG 隔离）：
//   ArenaCore 只用「传入的子 rng」（run.rng.sub('wild')）做实时刷怪/掉宝，
//   绝不调用主 run.rng 的 next()，因此离开荒野关后主 rng 状态确定，后续卡牌关 seed 可复现。
//   ArenaCore 是纯逻辑（无 DOM），可被 tools/arena-smoke.mjs 在 Node 里直接驱动。

import { silhouette } from './glyph.js';
import { CARD_MAP } from '../config/cards.js';
import { rollRewardCards } from './cards.js';

// ───────── 数值口径（阶段 6 终版 + 6.2 爽感调整，写死，不进 balance.json 旧数值体系） ─────────
// 导出给 tools/ 用：arena-smoke 要断言这些口径（半径倍数、血量档位、吸附近点等），
// balance.mjs 要拿它算「荒野关真实掉血代价」。工具读同一份常量，才不会出现
// 「测试里是 A 数值、平衡模型里是 B 数值」的隐形口径漂移。
export const ARENA = {
  DURATION_MS: 75000,       // 75 秒倒计时（spec §1.1；阶段 6.2 明确不动）
  BASE_MOVE: 150,           // 玩家移动速度 px/s
  BASE_DMG: 6,              // 投射物基础伤害（升级 +1/次）
  // 阶段 6.2：敌人血量**独立成常量**，不再与 BASE_DMG 共用。
  // 共用时「伤害升级」毫无意义（血量跟着伤害一起涨，永远 1 发打死）；
  // 独立后可做到 spec §6.2-2 的「1~2 发就死」：基础 6 伤 → 2 发；伤害叠到 9+ → 1 发。
  ENEMY_HP: 9,
  BASE_ATTACK_INTERVAL: 0.8, // 自动攻击间隔（spec 指定 0.8s）
  PROJECTILE_SPEED: 540,    // 投射物速度 px/s
  // 攻击射程：**必须有上限**。第一版无上限 → 敌人刚在屏幕外露头就被点掉，
  // 于是 ① 敌人永远走不到玩家身边，接触扣血形同不存在（实测 75 秒满血、共用 HP 的"高风险"是假的）
  // ② 击杀点都在四边，宝石掉在玩家不会去的角落（实测一局 53 杀、0 拾取、0 升级）
  // ③ 荒野牌三柱里"存活"恒满 → bastion 恒定胜出，映射退化。
  // 340px 略小于竖屏短边，保证"敌人能贴近、玩家要动"。
  ATTACK_RANGE: 340,
  GEM_MAGNET: 80,           // 宝石吸附半径（阶段 6.2：70 → 80，spec「~80px 自动飞向玩家」）
  GEM_PULL: 420,            // 吸附速度 px/s（原为硬编码 260；密度上来后要更快才跟得上"哗啦一片"）
  ENEMY_SPEED: 72,          // 敌人移动速度（< 玩家，可风筝）
  ENEMY_RADIUS: 13,
  ENEMY_CONTACT_DMG: 5,     // 碰到玩家的扣血（用 run.hp，同卡牌战）
  PLAYER_RADIUS: 14,
  GEM_XP: 1,
  // 升级节奏口径：**保持「约每 12 秒一次三选一」的原有手感**。
  // 阶段 6 原值 6（捡 6 颗升一级）是在「75 秒 ~40 杀」的低密度下标定的；
  // 阶段 6.2 密度提高后一局拾取 ~130 颗，若仍按 6 颗一级会弹 **22 次**弹窗
  // （每 3.4 秒打断一次，且伤害会叠到 +22）——那不是爽，那是故障。
  // 故按密度等比上调到 24（≈130/24 ≈ 5~6 次升级），只改频率不改机制。
  XP_PER_LEVEL: 24,
  MAX_PARTICLES: 140,       // 粒子硬上限（低端机保护，约束 0.5；阶段 6.2 密度提高后**不放宽**）
  MAX_ENEMIES: 40,          // 同屏敌人硬上限（spec §6.2-1 的"满屏"上限）
  MAX_FLOATERS: 20,         // 飘字硬上限（阶段 6.2 新增；fillText 是 Canvas2D 最贵的调用之一）
  MAX_DEATHS: 24,           // 死亡动画并发上限（阶段 8 新增；每个死亡要 save/rotate/fill 一次，不能无上限）

  // 刷怪节奏（阶段 6.2-1 核心）：线性加密 + 最后 15 秒高潮潮。
  // 原口径 2.2s→0.55s 在 75 秒里只出 ~190 个怪，同屏长期个位数，「割草」无从谈起。
  SPAWN_START: 1.5,         // 起始刷怪间隔（稀）
  SPAWN_END: 0.22,          // 75 秒时的线性基准间隔（密）
  CLIMAX_SEC: 15,           // 「最后 15 秒」高潮窗口
  CLIMAX_MUL: 0.6,          // 高潮窗口内间隔再 ×0.6（叠在线性加密之上）
  CLIMAX_BATCH: 2,          // 高潮窗口内每次刷 2 个（真正的"满屏"来源）
  ENEMY_SHAPE: 4,           // 复用 glyph 的剪影形状（只 1 种敌人，类型已预留扩展位，见 S6-2）

  // 主动技能：环形冲击波（spec §1.2 / §6.2-3）
  SHOCKWAVE_DMG: 30,        // 一次性高伤；必须 ≥ ENEMY_HP 才能做到 spec「一波清同屏小怪」
  SHOCKWAVE_RADIUS: 216,    // 以玩家为中心的环形半径（阶段 6.2：120 × 1.8 ≈ 216）
  SHOCKWAVE_CD: 2.0,        // 冷却 2 秒（空格 / 技能按钮）
  SHOCKWAVE_FX: 0.28,       // 爆发环扩张时长（6.2 为 0.35；阶段 8 收进 300ms 上限内，见 ANIM_MAX）
  SHOCKWAVE_KNOCK: 90,      // 击退距离 px（spec §6.2-3「扫开一片」）
  SHOCKWAVE_FLASH: 0.08,    // 白闪时长 s（约 5 帧 @60fps；用时长而非"真一帧"，否则掉帧时看不见）

  // ───────── 阶段 8 · 动画手感（spec §8） ─────────
  // 玩家反馈原话是「动画不行」——根因不是没有动画，而是**没有缓动**：位置每帧按输入
  // 直接赋值（线性瞬移）、敌人死亡直接 filter 掉（瞬切）、冲击波按下即炸（无过程）。
  // 所以这一节的共同口径是：**先把"过渡"存在为一个可插值的量，再用 ease-out 走完它**。
  //
  // ★ 铁律（可被 arena-smoke 第 9 节一键断言）：下列时长全部 > 0 且 ≤ ANIM_MAX。
  //   慢动作不是手感，是延迟 —— 玩家要的是"有过程"，不是"慢"。
  ANIM_MAX: 0.30,           // 非瞬移动画时长上限（秒）。整条链路唯一红线，新增动画必须并进这张表
  MOVE_ACCEL: 0.12,         // 移动加速：**到达 95% 目标速度**所需时长（不是时间常数，见 approach()）
  MOVE_DECEL: 0.24,         // 松手减速：到达"基本静止"所需时长（刻意比加速长 ⟹ 滑一小段 = 惯性）
  PLAYER_LEAN: 0.22,        // 侧倾最大弧度（≈12.6°，spec「幅度小不夸张」）
  PLAYER_STRETCH: 0.12,     // 沿运动方向的拉伸上限（squash & stretch 的 stretch）
  PLAYER_SQUASH: 0.08,      // 垂直运动方向的压扁上限（squash & stretch 的 squash）
  DEATH_ANIM: 0.15,         // 敌人死亡：爆裂放大→缩小 + 白闪（spec §8-3 写死 0.15s）
  DEATH_POP: 0.35,          // 死亡瞬间的额外放大比例（先"炸开"再缩没，纯缩小会像漏气）
  DEATH_DRIFT: 16,          // 被投射物打死的碎屑外飘距离 px（小，只做"有方向"的暗示）
  SHOCKWAVE_CHARGE: 0.15,   // 蓄力圈时长（spec §8-4「按下先出蓄力圈 ~0.15s，再扩散成爆发环」）
  FLOAT_LIFE: 0.30,         // 飘字寿命（6.2 为 0.45；阶段 8 收进 300ms 上限内）
  FLOAT_RISE: 18,           // 飘字上飘总距离 px（ease-out 走完：起步 180px/s → 收尾 0）
  PARTICLE_LIFE_MIN: 0.18,  // 粒子寿命下限（6.2 为 0.4；同上，收进上限内让特效更"脆"）
  PARTICLE_LIFE_MAX: 0.30,  // 粒子寿命上限（6.2 为 0.7）
  PROJECTILE_TRAIL: 22,     // 投射物拖尾长度 px（spec §8-5；投射物是直线飞行，残影即线段，无需历史缓冲）

  // 荒野牌映射口径（spec §3 三柱 + 阶段 6.1 裁决 2C 补第 4 柱）
  // 算法：四柱各自除以「本档玩家的常态值」→ 取超出常态最多的一柱。
  // 为什么不是「值 / 上限」：上限式归一化在高密度版本里四柱会**全部打满**（实测 24/25 局恒出猎手，
  // 映射退化成常量）。改成相对常态后，判据变成"你这一局在哪根柱上超常" —— 既可解释，又有区分度。
  // 常态值由 `tools/wild-calibrate.mjs` 跑 normal 口径（24 局 FINE_DT）**实测**得出并回填；
  // 改密度 / 敌人血量 / 时长 / 移动手感后必须重跑该脚本，否则映射会静默退化。
  // ★ HP_RATIO_TYPICAL 的口径（阶段 8 重标定时修的**历史 bug**，值得完整留档 —— 它错了两遍）：
  //   存活柱的判据是 `关内生存率 = 出关血量 / 进关血量`，**分子和分母都必须是这个量**。
  //   第一遍错在分子：旧实现写 `run.hp / run.maxHp`（绝对值）—— 于是这一柱实际度量的是
  //   "打到荒野节点前那 4 个卡牌节点掉了多少血"，而不是"关内活下来多少"。
  //   反例：30% 血进关、关内零掉血 → 0.30；满血进关、关内掉 40% → 0.60。
  //   后者关内表现更差，却得分高一倍 —— 而另三柱（击杀/拾宝/释放）都只统计**关内**行为。
  //   修法：ArenaCore 构造时记 `this.hpIn`，判据改成 `hp / hpIn`（真正的关内生存率）。
  //   第二遍错在分母：改成 `hp/hpIn` 后曾填 `1 − 0.107 关内掉血 = 0.89`。**这仍是同一个错误** ——
  //   `1 − 掉血/满血` 隐含"满血进关"，而实测进关只有 63.5% 满血，真实掉血率是 0.107/0.635 = 16.8%，
  //   常态值应为 `1 − 0.168 = 0.832`。教训：常态值必须是「判据那个量的样本均值」，
  //   不是「用手算的另一条式子凑出来的数」。
  //   第三遍错在样本量：先按 N=24 的均值填 0.83，扫描显示"壁垒 54% / 猎手 0%"。
  //   换成 N=200 重标，均值其实是 **0.765**（±0.013），映射健康（寂灭 33% / 壁垒 33% / 疾风 24% / 猎手 11%）。
  //   ★ 结构约束（这才是 0.53 那版的真正死因）：判据里 `WILD_CARD_SCORE_CAP = 1.5`，
  //     而生存率的**上界恰好是 1.0**（关内无治疗）。所以分母只要 ≤ 1.0/1.5 = 0.667，
  //     任何没掉血的玩家都会把这一柱打满到 1.5 —— 与"冲击波放了 999 次"打平，
  //     再按 order 让壁垒胜出（`arena-smoke` §2 就是这么炸的）。⟹ **本值必须 > 0.667**。
  //   重标方法：`node tools/wild-calibrate.mjs 200`，取它输出的「样本均值」那一档。
  KILLS_TYPICAL: 173,       // 击杀常态值（关内）
  GEMS_TYPICAL: 129,        // 拾取宝石常态值（关内）
  CASTS_TYPICAL: 18,        // 冲击波释放常态值（关内）
  HP_RATIO_TYPICAL: 0.77,   // 关内生存率常态值（出关/进关，N=200 实测均值 0.765）；必须 > 0.667
  WILD_CARD_SCORE_CAP: 1.5, // 单柱得分上限（防一柱爆表后完全掩盖其它柱）
};

// 三选一升级（spec 写死这 3 项，不引入升级树/道具/被动）
const ARENA_UPGRADES = [
  { id: 'dmg', label: '伤害 +1', desc: '投射物伤害提高 1' },
  { id: 'move', label: '移速 +15%', desc: '移动速度提高 15%' },
  { id: 'atk', label: '攻速 -0.15s', desc: '自动攻击间隔缩短 0.15 秒' },
];

// 荒野牌模板（spec §3 三柱 + 阶段 6.1 / 裁决 2C 补第 4 张 -> 四流派各 1 张，四柱取最高）
const ARENA_WILD_CARD = {
  hunter: 'wild.hunter',       // 击杀最多     → 刃系输出
  bastion: 'wild.bastion',     // 存活最好     → 蚀系生存（格挡+回血）
  gale: 'wild.gale',           // 拾宝石最多   → 霜系过牌/抽牌
  purgatory: 'wild.purgatory', // 冲击波放最多 → 熵系过载（阶段 6.1 新增，补四流派对称）
};

/**
 * 通关结算的荒野牌奖励（spec §3）：固定 1 张荒野牌（按割草数据映射）+ 2 张常规池牌。
 * 这是「真实游戏」与「种子指纹基线」唯一共享的入口 —— 两者必须走同一段 rng 消费，
 * 否则离开荒野关后主 rng 状态会漂移、seed 指纹会变。
 * 注意：pickWildCardId() 是纯函数（不消耗 rng），唯一的主 rng 消费就是 rollRewardCards(..., 2)。
 */
export function rollWildReward(run, core) {
  const wildId = core.pickWildCardId();
  const others = rollRewardCards(run.rng, run.pool, 2);
  return [CARD_MAP[wildId], ...others];
}

/**
 * wild 节点是否**待处理**（尚未被任何入口消费）。
 *
 * 为什么必须有这个判据（阶段 6.1 用基线跑出来的**真 bug**）：
 *   run.advance() 在**选中**节点时就把 n.done = true 了，而 cursor 会一直停在这个节点上，
 *   直到下一次 advance()。于是"取完奖励回到地图"时 currentNode 仍然指向那个 wild 节点 ——
 *   若判据只写 `type === 'wild'`，选择框会**再弹一次**，玩家可以反复进入荒野、反复掉血。
 *   在基线里的表现是一局进了 1022 次荒野关（见 findings S6-8）。
 * 因此：判据 + 消费标记必须在所有入口间保持一致（真实游戏 / 平衡基线 / 种子指纹 / 端到端探针）。
 */
export function isWildPending(run) {
  const n = run && run.currentNode;
  return !!(n && n.type === 'wild' && !n.wildDone);
}

/** 标记 wild 节点已被消费（在进入实时关或退化为普通战**之前**调用，配合 isWildPending）。 */
export function markWildHandled(run) {
  const n = run && run.currentNode;
  if (n) n.wildDone = true;
}

const COLOR = {
  field: '#0d0c0b',
  player: '#cfc7ba',
  enemy: '#8d8378',
  projectile: '#e8e3da',
  gem: '#a89ae6',       // --flux 紫，与地图 wild 节点同色
  paper: '#e8e3da',
  ink: '#9a938a',
  danger: '#b3402f',
};

// 阶段 8：死亡动画的「闪白 → 本色」色阶，**预生成定长调色板**而不是每帧做 hex 插值。
// 死亡动画最多同时 24 个、每个一次 fillStyle 赋值 —— 每帧拼 24 个颜色字符串是这里
// 唯一可能变成热点的开销，而色阶档数根本不需要连续（6 档在 0.15s 内已经看不出台阶）。
const DEATH_COLORS = (() => {
  const from = [0x8d, 0x83, 0x78], to = [0xff, 0xff, 0xff], n = 6, out = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    out.push(`rgb(${from.map((v, k) => Math.round(v + (to[k] - v) * t)).join(',')})`);
  }
  return out; // [0] = 敌人本色，[n-1] = 纯白
})();

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const TAU = Math.PI * 2;

// ── 缓动（阶段 8 统一口径） ──
// 把"过渡"统一成两个函数，而不是在各处散落魔法系数：
//   easeOut  —— 给**进度型**动画用（死亡爆裂、爆发环、蓄力圈）：起步快、收尾慢。
//   approach —— 给**速度型**收敛用（移动惯性）：帧率无关的指数趋近。
// 为什么 approach 不能写成 `v += (target - v) * 0.3`（定系数 lerp）：那个系数是按
// 某个固定 dt 拍出来的，dt 一变（掉帧 / 后台恢复 / COARSE_DT 模拟）收敛速度就跟着变 ——
// 于是"同一套输入、不同帧率走位不同"，那不只是观感问题，还会让平衡口径无法复现。
/** 三次 ease-out（spec §8：非瞬移动画一律 ease-out，总时长 ≤ ARENA.ANIM_MAX）。 */
const easeOut = (p) => 1 - (1 - clamp(p, 0, 1)) ** 3;
/** 指数趋近。sec = **到达 95% 目标值所需时长**（1 − e^−3 ≈ 0.95 ⟹ 时间常数 tau = sec/3）。 */
const approach = (v, target, sec, dt) => v + (target - v) * (1 - Math.exp((-3 * dt) / sec));

// 注意：这里刻意用 sqrt 而不是 Math.hypot —— hypot 为了防溢出做了额外分支，
// 实测慢 5~10 倍。密度提高后（同屏 40 敌 × 60fps）这一项在热路径上被调用数十万次。
const dist = (a, b) => { const dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); };

// 字体串提出来常量复用：ctx.font 赋值会触发 CSS 字体简写串解析，每帧重复赋同一个值是浪费。
const FONT_BIG = '600 26px -apple-system, system-ui, sans-serif';
const FONT_SMALL = '500 12px -apple-system, system-ui, sans-serif';

// ?dbg=1：把输入/帧率读数画在画布上。价值在于「真机操控失灵时能直接读出数值」——
// 键盘没收到、摇杆焊死在某个方向、失焦卡键，这三种原因的屏幕表现完全一样，靠猜会一直猜错。
// 用 typeof 守卫是因为 Node（arena-smoke.mjs）会 import 本模块，那里没有 location。
const DBG = typeof location !== 'undefined' && /[?&]dbg=1\b/.test(location.search);

/**
 * 纯逻辑模拟核心（无 DOM、无 canvas）。
 * 用 Node 直接驱动即可做无头 smoke 测试（tools/arena-smoke.mjs）。
 */
export class ArenaCore {
  constructor({ run, rng, width = 360, height = 640, reducedMotion = false, durationMs = ARENA.DURATION_MS }) {
    this.run = run;                 // 必须含有 hp / maxHp 字段（真实对局传 Run 实例）
    // 阶段 8：记下**进关时的血量**。荒野牌的「存活」柱必须比的是"关内活下来多少"，
    // 而不是"出关时还剩多少绝对值" —— 后者主要反映前 4 个卡牌节点掉了多少血，
    // 根本不是"本局的割草数据"。另三柱（击杀/拾宝/释放）都只统计**关内**行为，这一柱必须同口径。
    this.hpIn = run.hp;
    this.rng = rng || new (class { next() { return Math.random(); } })();
    this.reduced = reducedMotion;
    this.durationMs = durationMs;
    this.setBounds(width, height);

    this.time = 0;
    // 阶段 8：位置不再由输入直接赋值，而是由**速度**积分而来（vx/vy 才是真状态）。
    // 这是「推摇杆逐渐加速、松摇杆平滑减速」的唯一实现方式 —— 输入只负责给目标速度。
    this.player = { x: width / 2, y: height * 0.62, r: ARENA.PLAYER_RADIUS, vx: 0, vy: 0 };
    this.enemies = [];
    this.projectiles = [];
    this.gems = [];
    this.particles = [];
    this.floaters = [];         // 阶段 6.2：飘伤害数字（快出快隐）
    // 阶段 8：死亡动画是**纯视觉**的，必须与逻辑数组分开存 ——
    // 若把"正在爆裂的怪"留在 this.enemies 里，那它还会被锁定、还会扣血、还会算进
    // MAX_ENEMIES 与密度快照，于是"加个动画"就悄悄改了玩法口径。分开存 = 零逻辑影响。
    this.deaths = [];

    this.spawnTimer = 0.6;
    this.attackTimer = 0;
    this.xp = 0;
    this.level = 0;
    this.xpToLevel = ARENA.XP_PER_LEVEL;

    this.dmg = ARENA.BASE_DMG;
    this.moveSpeed = ARENA.BASE_MOVE;
    this.attackInterval = ARENA.BASE_ATTACK_INTERVAL;

    // 割草数据（用于通关后三选一荒野牌映射，spec §3 + 阶段 6.1 第四柱）
    this.kills = 0;            // 击杀敌人数
    this.gemsCollected = 0;    // 捡到的经验宝石数

    // 主动技能：环形冲击波（spec §1.2 / §6.2-3 / 阶段 8 蓄力）
    // 阶段 8 起释放被拆成两拍：**按下 → 蓄力 0.15s → 爆发**。
    // 蓄力期间不结算任何伤害，所以这是"有过程"，不是"加延迟"——伤害仍在同一个
    // 0.15s 窗口结束时一次性落地，之后 0.28s 的爆发环只是余韵，不占操作节拍。
    this.shockwaveCd = 0;      // 冷却剩余秒
    this.shockChargeT = -1;    // 蓄力圈进度（<0 表示无；0..SHOCKWAVE_CHARGE）
    this.shockwaveCastT = -1;  // 爆发环进度（<0 表示无）
    this.flashT = -1;          // 白闪剩余（<0 表示无）
    this.shockCasts = 0;       // 释放次数（荒野牌第四柱；在**爆发**时计数，与伤害同一时刻）

    this.pendingUpgrade = null;     // 非 null 时游戏暂停，等待选升级
    this.done = false;
    this.won = false;
    this.dead = false;
  }

  setBounds(w, h) {
    this.w = w;
    this.h = h;
    this.bounds = { l: 0, t: 0, r: w, b: h };
  }

  /** 主步进。input = {x, y} 各 ∈ [-1,1]（摇杆/键盘已经归一化方向）。
   *  paused / 升级暂停 / 已结束时为 no-op（满足「升级界面暂停游戏」）。 */
  step(dt, input = { x: 0, y: 0 }) {
    if (this.done || this.pendingUpgrade) return;

    this.time += dt * 1000;

    // 冲击波三拍计时（冷却 / 爆发环 / 白闪）+ 蓄力。全部是「无 rng 的纯视觉」，不影响确定性。
    // ★ 顺序有讲究：**蓄力必须放在最后**。它本帧刚触发爆发时会把 shockwaveCastT/flashT 置 0，
    //   若紧接着（同一帧）就被下面这段 +dt 推进一次，视觉就凭空少一帧 —— 表现是"爆发环第一帧
    //   直接跳过去"，而精确断言（`castT === 0`）也会失败。先推旧计时、再开新计时。
    if (this.shockwaveCd > 0) this.shockwaveCd = Math.max(0, this.shockwaveCd - dt);
    if (this.shockwaveCastT >= 0) {
      this.shockwaveCastT += dt;
      if (this.shockwaveCastT >= ARENA.SHOCKWAVE_FX) this.shockwaveCastT = -1;
    }
    if (this.flashT >= 0) {
      this.flashT -= dt;
      if (this.flashT < 0) this.flashT = -1;
    }
    if (this.shockChargeT >= 0) {
      this.shockChargeT += dt;
      if (this.shockChargeT >= ARENA.SHOCKWAVE_CHARGE) {
        this.shockChargeT = -1;
        this.detonateShockwave(); // 伤害 / 击退 / 白闪 / 爆发环全部发生在这一刻
      }
    }

    // ── 玩家移动（阶段 8：速度插值，不再线性瞬移） ──
    // 输入只负责给**目标速度**，实际速度用指数趋近追上去：
    //   推摇杆 → 逐渐加速（MOVE_ACCEL 内到 95%）；松摇杆 → 平滑减速（MOVE_DECEL 内基本停住）。
    // 位移仍然 clamp 回场地，所以惯性不会把人"滑出墙外"。
    // 注意这里**不能**再写成 `if (mag > 0.001) {...}` —— 松手那一帧 mag 已经是 0，
    // 若整段跳过，速度会永远停在松手前的值上（人物变成永动的"滑冰"）。
    const mag = Math.hypot(input.x, input.y);
    const spd = this.moveSpeed * (mag > 1 ? 1 : mag);
    const tvx = mag > 0.001 ? (input.x / mag) * spd : 0;
    const tvy = mag > 0.001 ? (input.y / mag) * spd : 0;
    const sec = mag > 0.001 ? ARENA.MOVE_ACCEL : ARENA.MOVE_DECEL;
    this.player.vx = approach(this.player.vx, tvx, sec, dt);
    this.player.vy = approach(this.player.vy, tvy, sec, dt);
    if (this.player.vx !== 0 || this.player.vy !== 0) {
      this.player.x = clamp(this.player.x + this.player.vx * dt, this.bounds.l + this.player.r, this.bounds.r - this.player.r);
      this.player.y = clamp(this.player.y + this.player.vy * dt, this.bounds.t + this.player.r, this.bounds.b - this.player.r);
    }

    // ── 刷怪（阶段 6.2-1 核心：线性加密，最后 15 秒高潮潮） ──
    // 原口径 2.2s→0.55s：75 秒总共 ~190 个怪，同屏长期个位数 —— 没有"割草"可言。
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      const climax = (this.durationMs - this.time) / 1000 <= ARENA.CLIMAX_SEC;
      const batch = climax ? ARENA.CLIMAX_BATCH : 1;
      for (let i = 0; i < batch && this.enemies.length < ARENA.MAX_ENEMIES; i++) this.spawnEnemy();
      const t = clamp(this.time / this.durationMs, 0, 1);
      let interval = lerp(ARENA.SPAWN_START, ARENA.SPAWN_END, t);
      if (climax) interval *= ARENA.CLIMAX_MUL;
      // ±20% 抖动：固定节拍会让怪排成一条直线涌来，抖动才有"围上来"的观感
      this.spawnTimer = interval * (0.8 + this.rng.next() * 0.4);
    }

    // ── 自动攻击（每 attackInterval 向射程内最近敌人射一发光） ──
    this.attackTimer -= dt;
    if (this.attackTimer <= 0) {
      const target = this.nearestEnemy(ARENA.ATTACK_RANGE);
      if (target) {
        this.fireProjectile(target);
        this.attackTimer = this.attackInterval;
      } else {
        this.attackTimer = 0.12; // 射程内无目标：很快再查，等敌人走进来
      }
    }

    // ── 投射物 ──
    // 阶段 8：致死时把**弹道方向**交给死亡动画（碎屑顺着弹道飞出去）。
    // 不传方向的话所有死亡都朝同一侧飘，一眼就能看出是"批量动画"而不是打击反馈。
    const invSpd = 1 / ARENA.PROJECTILE_SPEED;
    for (const p of this.projectiles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
      for (const e of this.enemies) {
        const rr = e.r + p.r;
        const ex = p.x - e.x, ey = p.y - e.y;
        if (ex * ex + ey * ey < rr * rr) {
          e.hp -= this.dmg;
          p.dead = true;
          if (e.hp <= 0) this.killEnemy(e, this.dmg, { ux: p.vx * invSpd, uy: p.vy * invSpd, dist: ARENA.DEATH_DRIFT });
          else this.floatText(e.x, e.y - e.r, `-${this.dmg}`); // 未致死也给命中读数
          break;
        }
      }
    }
    this.projectiles = this.projectiles.filter((p) => !p.dead && p.life > 0 && this._inWorld(p, 40));

    // ── 敌人朝玩家直线走，碰到扣血 ──
    for (const e of this.enemies) {
      const dx = this.player.x - e.x, dy = this.player.y - e.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      e.x += (dx / d) * e.speed * dt;
      e.y += (dy / d) * e.speed * dt;
      if (d < this.player.r + e.r) {
        this.damagePlayer(e.contact);
        e.dead = true;
        // 撞上玩家的怪同样给一个死亡动画（阶段 8）。**只给视觉，不给宝石/击杀数** ——
        // 这两条是既有规则（撞怪是"被啃掉"不是"打死"），手感补丁不顺手改经济。
        if (!this.reduced) this.addDeath(e, null);
      }
    }
    this.enemies = this.enemies.filter((e) => !e.dead);

    // ── 经验宝石：吸附 + 走过即捡 ──
    // 为什么要吸附：宝石半径 4px，玩家 150px/s、单帧位移 2.5px，要求"精确踩中"手感很差
    // （尤其触屏，指尖会挡住宝石）。进入 GEM_MAGNET 圈后宝石自己飞向玩家，符合"走过即捡"。
    for (const g of this.gems) {
      let dx = this.player.x - g.x, dy = this.player.y - g.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < ARENA.GEM_MAGNET * ARENA.GEM_MAGNET && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        const pull = Math.min(d, ARENA.GEM_PULL * dt); // dt 驱动（ADR-003），与帧率解耦
        g.x += (dx / d) * pull;
        g.y += (dy / d) * pull;
        dx = this.player.x - g.x; dy = this.player.y - g.y; d2 = dx * dx + dy * dy;
      }
      const rr = this.player.r + g.r + 2;
      if (d2 < rr * rr) {
        this.gainXp(g.xp);
        g.dead = true;
      }
    }
    this.gems = this.gems.filter((g) => !g.dead);

    // ── 粒子衰减 ──
    for (const pa of this.particles) {
      pa.x += pa.vx * dt;
      pa.y += pa.vy * dt;
      pa.vy += 320 * dt;
      pa.vx *= 0.98;
      pa.life -= dt;
    }
    this.particles = this.particles.filter((pa) => pa.life > 0);

    // ── 飘字衰减（阶段 6.2-5 快出快隐 / 阶段 8：上飘改 ease-out） ──
    // 位置由 t 直接算（f.y0 − rise × easeOut(p)），而不是"每帧加一个固定位移" ——
    // 后者是匀速，正是本阶段要消掉的线性感。用 f.max 而不是 f.life 当分母：
    // life 每次都在减，拿它做分母会把曲线压成非单调的（实测末段会往回跳）。
    for (const f of this.floaters) {
      f.t += dt;
      f.y = f.y0 - ARENA.FLOAT_RISE * easeOut(f.t / f.max);
      f.life -= dt;
    }
    this.floaters = this.floaters.filter((f) => f.life > 0);

    // ── 死亡动画衰减（阶段 8：纯视觉，不参与任何判定） ──
    for (const d of this.deaths) d.t += dt;
    this.deaths = this.deaths.filter((d) => d.t < d.life);

    // ── 胜负判定 ──
    if (this.run.hp <= 0) {
      this.run.hp = 0;
      this.dead = true;
      this.done = true;
      this.won = false;
      return;
    }
    if (this.time >= this.durationMs) {
      this.done = true;
      this.won = this.run.hp > 0;
    }
  }

  // ── 内部辅助 ──
  _inWorld(p, m) {
    return p.x > -m && p.x < this.w + m && p.y > -m && p.y < this.h + m;
  }

  spawnEnemy() {
    const edge = this.rng.int(4);
    const m = 34;
    let x, y;
    if (edge === 0) { x = this.rng.next() * this.w; y = -m; }
    else if (edge === 1) { x = this.w + m; y = this.rng.next() * this.h; }
    else if (edge === 2) { x = this.rng.next() * this.w; y = this.h + m; }
    else { x = -m; y = this.rng.next() * this.h; }
    this.enemies.push({
      x, y, r: ARENA.ENEMY_RADIUS, speed: ARENA.ENEMY_SPEED,
      hp: ARENA.ENEMY_HP, contact: ARENA.ENEMY_CONTACT_DMG, dead: false,
    });
  }

  /** 射程内最近的敌人（maxRange 省略则不限射程）。 */
  nearestEnemy(maxRange = Infinity) {
    let best = null, bd = Infinity;
    for (const e of this.enemies) {
      const d = dist(e, this.player);
      if (d <= maxRange && d < bd) { bd = d; best = e; }
    }
    return best;
  }

  fireProjectile(target) {
    const dx = target.x - this.player.x, dy = target.y - this.player.y;
    const d = Math.hypot(dx, dy) || 1;
    this.projectiles.push({
      x: this.player.x, y: this.player.y,
      vx: (dx / d) * ARENA.PROJECTILE_SPEED, vy: (dy / d) * ARENA.PROJECTILE_SPEED,
      r: 3, life: 2.5, dead: false,
    });
  }

  /**
   * 击杀结算。`knock` 是**死亡动画**的外飞方向（`{ux, uy, dist}`，可省略）：
   * 投射物击杀顺着弹道飞、冲击波击杀向外炸开、撞人自爆不给方向。
   * 它只影响视觉 —— 宝石落点、击杀计数、飘字与阶段 6.2 完全一致。
   */
  killEnemy(e, dmg = this.dmg, knock = null) {
    e.dead = true;
    this.kills += 1;
    // 宝石落点必须夹回可走区域内：敌人从四边屏幕外刷出，可能刚露头就被投射物打死，
    // 若按原坐标落宝会落在玩家能到达的边界之外 → 永远捡不到（实测 58 杀 0 拾取，
    // 升级/三选一因此形同不存在）。夹到内缩 6px 处保证「走过即捡」恒成立。
    const gx = clamp(e.x, 6, this.w - 6);
    const gy = clamp(e.y, 6, this.h - 6);
    this.gems.push({ x: gx, y: gy, r: 4, xp: ARENA.GEM_XP, dead: false });
    this.floatText(e.x, e.y - e.r, `-${dmg}`, dmg >= ARENA.SHOCKWAVE_DMG ? COLOR.gem : COLOR.paper);
    if (!this.reduced) {
      this.burst(gx, gy, COLOR.enemy, 4);
      this.addDeath(e, knock); // 阶段 8：不再瞬切（spec §8-3）
    }
  }

  /**
   * 死亡动画（阶段 8-3）：留一个**纯视觉替身**，在 0.15s 内「爆裂放大 → 缩小」+ 白闪。
   *
   * 为什么单独存 `this.deaths` 而不是给敌人打 `dying` 标记：逻辑上的敌人此刻**必须**
   * 已经从 this.enemies 里移除，否则它会继续被自动攻击锁定、撞到玩家还会扣血、
   * 还占着 MAX_ENEMIES 名额与密度快照 —— "加个动画顺手把玩法改了"是这类手感补丁
   * 最典型的翻车方式。位移与缩放都由 t 直接算、全部走 ease-out：不积分、不消耗 rng。
   */
  addDeath(e, knock = null) {
    if (this.deaths.length >= ARENA.MAX_DEATHS) this.deaths.shift(); // 与 burst 同一策略：保最新
    this.deaths.push({
      x: e.x, y: e.y, r: e.r, t: 0, life: ARENA.DEATH_ANIM,
      dx: knock ? knock.ux * knock.dist : 0,
      dy: knock ? knock.uy * knock.dist : 0,
    });
  }

  /** 飘字（阶段 6.2-5）：小字、快出快隐。
   *  硬上限 MAX_FLOATERS：fillText 是 Canvas2D 最贵的调用之一，密度上来后必须封顶（低端机保护）。
   *  阶段 8：额外记 `max`（总寿命）—— 上飘位置要按 `t/max` 走 ease-out，而 `life` 每帧都在减，
   *  拿它当分母曲线会变形。 */
  floatText(x, y, text, color = COLOR.ink, life = ARENA.FLOAT_LIFE) {
    if (this.floaters.length >= ARENA.MAX_FLOATERS) this.floaters.shift();
    this.floaters.push({ x, y, y0: y, text, color, t: 0, life, max: life });
  }

  damagePlayer(amount) {
    this.run.hp = Math.max(0, this.run.hp - amount);
  }

  gainXp(n) {
    this.xp += n;
    this.gemsCollected += n;
    if (this.xp >= this.xpToLevel && !this.pendingUpgrade) this.openUpgrade();
  }

  openUpgrade() {
    this.pendingUpgrade = ARENA_UPGRADES.slice(); // 暂停游戏的开关
  }

  /** 选择第 i 个升级（0/1/2）。选完若仍有富余经验则连开下一级。 */
  chooseUpgrade(i) {
    if (!this.pendingUpgrade) return;
    if (i === 0) this.dmg += 1;
    else if (i === 1) this.moveSpeed *= 1.15;
    else if (i === 2) this.attackInterval = Math.max(0.2, this.attackInterval - 0.15);
    this.level += 1;
    this.xp -= this.xpToLevel;
    this.pendingUpgrade = null;
    if (this.xp >= this.xpToLevel) this.openUpgrade(); // 连升
  }

  /** 主动技能：环形冲击波（spec §1.2 / §6.2-3 / 阶段 8-4 拆成两拍）。
   *  调用即"按下"：先进入 SHOCKWAVE_CHARGE 蓄力（视觉上是向外收拢的蓄力圈），
   *  蓄力结束由 step() 调 detonateShockwave() 结算伤害 + 击退 + 爆发环。
   *  冷却**从按下起算** —— 否则玩家会为动画白等 0.15s，那不是"有过程"而是"加延迟"。
   *  返回是否成功起手（冷却中 / 已在蓄力 / 暂停 / 已结束则失败）。 */
  shockwave() {
    if (this.done || this.pendingUpgrade || this.shockwaveCd > 0 || this.shockChargeT >= 0) return false;
    this.shockChargeT = 0;
    this.shockwaveCd = ARENA.SHOCKWAVE_CD;
    return true;
  }

  /** 冲击波爆发（阶段 8：蓄力结束时结算）。对玩家周围一圈敌人一次性高伤 + **向外击退**，
   *  并触发白闪 / 爆发环 / 粒子爆。 */
  detonateShockwave() {
    const R = ARENA.SHOCKWAVE_RADIUS;
    for (const e of this.enemies) {
      const dx = e.x - this.player.x, dy = e.y - this.player.y;
      const d = Math.hypot(dx, dy);
      if (d > R + e.r) continue;
      const ux = d > 0.001 ? dx / d : 1, uy = d > 0.001 ? dy / d : 0; // 由玩家指向敌人
      e.hp -= ARENA.SHOCKWAVE_DMG;
      if (e.hp <= 0) {
        // 阶段 8：「扫开一片」的位移改由**死亡动画外飞**承担（dist = SHOCKWAVE_KNOCK）。
        // 基础怪必被 30 伤秒杀，所以旧实现里"被推开"这条分支对普通怪是死代码 ——
        // 它的尸体以前直接消失，方向感全靠碎屑暗示；现在怪本身会顺着冲击方向炸飞出去。
        this.killEnemy(e, ARENA.SHOCKWAVE_DMG, { ux, uy, dist: ARENA.SHOCKWAVE_KNOCK });
        if (!this.reduced) this.burst(e.x, e.y, COLOR.gem, 3, { x: ux, y: uy });
      } else {
        // 活着的怪（肉怪 / 后续扩展类型）真的被推开，夹回场地内避免推出可玩区域
        e.x = clamp(e.x + ux * ARENA.SHOCKWAVE_KNOCK, this.bounds.l + e.r, this.bounds.r - e.r);
        e.y = clamp(e.y + uy * ARENA.SHOCKWAVE_KNOCK, this.bounds.t + e.r, this.bounds.b - e.r);
      }
    }
    this.enemies = this.enemies.filter((e) => !e.dead);
    this.shockwaveCastT = 0;
    this.flashT = ARENA.SHOCKWAVE_FLASH;
    this.shockCasts += 1;
  }

  /** 根据本局割草数据，从 4 张荒野牌模板里挑 1 张（spec §3 + 阶段 6.1 裁决 2C）。
   *  纯函数，不消耗 rng。四柱各自除以常态值，取**超出常态最多**的一柱：
   *    击杀(hunter) / 拾宝石(gale) / 存活=**关内生存率**(bastion) / 冲击波释放次数(purgatory)；
   *  平局按 hunter > gale > bastion > purgatory 优先级（严格 > 比较，靠前者胜）。 */
  pickWildCardId() {
    const cap = ARENA.WILD_CARD_SCORE_CAP;
    // ★ 存活柱用「关内生存率」= 出关血量 / 进关血量（阶段 8 修正的口径，见 ARENA.HP_RATIO_TYPICAL）
    const hpRatio = this.run.hp / (this.hpIn || this.run.maxHp || 1);
    const score = {
      hunter: Math.min(cap, this.kills / ARENA.KILLS_TYPICAL),
      gale: Math.min(cap, this.gemsCollected / ARENA.GEMS_TYPICAL),
      bastion: Math.min(cap, hpRatio / ARENA.HP_RATIO_TYPICAL),
      purgatory: Math.min(cap, this.shockCasts / ARENA.CASTS_TYPICAL),
    };
    const order = ['hunter', 'gale', 'bastion', 'purgatory'];
    let best = order[0], bv = -1;
    for (const k of order) {
      if (score[k] > bv) { bv = score[k]; best = k; }
    }
    return ARENA_WILD_CARD[best];
  }

  /** 粒子爆。dir 非空时朝该方向飞散（冲击波"扫开"用），否则全向随机。
   *  容量满时**淘汰最旧的**而不是丢弃新的：密度提高后冲击波的碎屑会瞬间填满上限，
   *  若"满了就丢新的"，那么之后每次击杀的粒子都看不见（而"最新的效果"恰恰是最该被看到的）。 */
  burst(x, y, color, n = 8, dir = null) {
    const base = dir ? Math.atan2(dir.y, dir.x) : 0;
    for (let i = 0; i < n; i++) {
      if (this.particles.length >= ARENA.MAX_PARTICLES) this.particles.shift(); // 硬上限仍在，只是换淘汰策略
      const a = dir ? base + (this.rng.next() - 0.5) * 1.1 : this.rng.next() * Math.PI * 2;
      const sp = (dir ? 120 : 40) + this.rng.next() * 120;
      // 阶段 8：粒子寿命一并收进 ANIM_MAX（6.2 是 0.4~0.7）—— 特效"脆"才跟得上割草节拍，
      // 长尾粒子在满屏时会糊成一层灰雾，反而看不出打击点。
      this.particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 30,
        color, r: 1.5 + this.rng.next() * 2,
        life: ARENA.PARTICLE_LIFE_MIN + this.rng.next() * (ARENA.PARTICLE_LIFE_MAX - ARENA.PARTICLE_LIFE_MIN),
      });
    }
  }

  // ── 给无头测试用的快照（断言不出 NaN / 不卡死） ──
  snapshot() {
    const finite = (v) => typeof v === 'number' && isFinite(v);
    const ok =
      finite(this.player.x) && finite(this.player.y) &&
      finite(this.player.vx) && finite(this.player.vy) &&   // 阶段 8：速度也是状态了
      finite(this.run.hp) && finite(this.time) &&
      this.enemies.every((e) => finite(e.x) && finite(e.y)) &&
      this.projectiles.every((p) => finite(p.x) && finite(p.y)) &&
      this.gems.every((g) => finite(g.x) && finite(g.y)) &&
      this.floaters.every((f) => finite(f.x) && finite(f.y)) &&
      this.deaths.every((d) => finite(d.x) && finite(d.y));
    return {
      time: this.time, hp: this.run.hp, won: this.won, dead: this.dead, done: this.done,
      level: this.level, enemies: this.enemies.length, particles: this.particles.length,
      gems: this.gems.length, floaters: this.floaters.length, kills: this.kills,
      gemsCollected: this.gemsCollected, casts: this.shockCasts,
      // 阶段 8：惯性/动画的可观测面（smoke 第 9 节靠这几项断言"不瞬移、不瞬停"）
      speed: Math.sqrt(this.player.vx * this.player.vx + this.player.vy * this.player.vy),
      deaths: this.deaths.length, charging: this.shockChargeT >= 0,
      finite: ok,
    };
  }
}

/**
 * DOM 包装层：canvas 渲染 + 双端操控（悬浮摇杆 / WASD·方向键）+ rAF 循环 + 升级弹窗。
 * 仅在浏览器中实例化（依赖 document / window / requestAnimationFrame）。
 */
export class Arena {
  constructor({ stage, run, rng, reducedMotion = false, onDone }) {
    this.stage = stage;
    this.run = run;
    this.rng = rng;
    this.reduced = reducedMotion;
    this.onDone = onDone;
    this.core = null;
    this.raf = 0;
    this.ended = false;
    this.last = 0;
    this.input = { x: 0, y: 0 };
    this.joy = { x: 0, y: 0, active: false, ox: 0, oy: 0, vx: 0, vy: 0 };
    this.keys = new Set();
    this._enemyPath = new Path2D(silhouette(ARENA.ENEMY_SHAPE, false));
    // 渲染/输入侧的小状态（避免每帧重复写 DOM / 重复解析字体、以及暂停时白重绘）
    this._needsPaint = true;   // 暂停中仅在置位时重绘一帧
    this._skillTxt = '';       // 技能按钮上次写入的文本（只在变化时写 DOM）
    this._f1 = ''; this._f2 = ''; // 上次设置的 ctx.font
    this._fps = 0;
  }

  start() {
    const w = this.stage.clientWidth || 360;
    const h = this.stage.clientHeight || 640;
    // 用子 rng 隔离实时随机，主 run.rng 不动（RNG 隔离约束）
    this.core = new ArenaCore({ run: this.run, rng: this.rng, width: w, height: h, reducedMotion: this.reduced });

    // ── 构建 DOM ──
    const root = document.createElement('div');
    root.className = 'arena-root';
    root.innerHTML = `
      <canvas class="arena-canvas"></canvas>
      <div class="arena-hint">拖动屏幕移动 · WASD/方向键亦可 · 空格/技能键放冲击波</div>
      <button class="arena-skill" aria-label="环形冲击波">波</button>
      <div class="arena-levelup" hidden>
        <div class="alu-title">升级！三选一</div>
        <div class="alu-choices"></div>
      </div>`;
    this.root = root;
    this.canvas = root.querySelector('.arena-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.levelupEl = root.querySelector('.arena-levelup');
    this.choicesEl = root.querySelector('.alu-choices');
    this.skillBtn = root.querySelector('.arena-skill');
    this.stage.appendChild(root);
    this._resize();

    // ── 输入：悬浮摇杆（指针事件，触屏/鼠标统一） + 键盘 ──
    // 坑：joy.ox/oy 必须是**画布坐标**（_render 直接拿它们画圈），而 clientX/Y 是视口坐标。
    // 第一版把视口坐标直接当画布坐标用 → 画出来的摇杆比手指低一个 HUD 的高度（实测偏移 86px）。
    // 移动方向仍然正确（方向来自位移差，平移量会抵消），但视觉完全对不上，用户会以为摇杆坏了。
    // 因此分开存两套：vx/vy 视口坐标（只用于算位移差）、ox/oy 画布坐标（只用于绘制）。
    this._onPointerDown = (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.joy.active = true;
      this.joy.vx = e.clientX; this.joy.vy = e.clientY;
      this.joy.ox = e.clientX - r.left; this.joy.oy = e.clientY - r.top;
      this.joy.x = 0; this.joy.y = 0;
      this.canvas.setPointerCapture?.(e.pointerId);
    };
    this._onPointerMove = (e) => {
      if (!this.joy.active) return;
      const dx = e.clientX - this.joy.vx, dy = e.clientY - this.joy.vy;
      const max = 48;
      const m = Math.hypot(dx, dy);
      const k = m > max ? max / m : 1;
      this.joy.x = (dx * k) / max;
      this.joy.y = (dy * k) / max;
    };
    this._onPointerUp = () => {
      this.joy.active = false;
      this.joy.x = 0; this.joy.y = 0;
    };
    this.canvas.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('pointercancel', this._onPointerUp);

    // 防「卡键 / 卡摇杆」：失焦或页面切走时 keyup / pointerup 可能收不到，
    // 残留状态会让输入恒偏一个方向。**这正是「某个方向完全走不动」的典型成因** ——
    // 左右两键同时残留时，−1 与 +1 相加恰好抵消成 0（摇杆残留同理）。
    this._resetInput = () => {
      this.keys.clear();
      this.joy.active = false;
      this.joy.x = 0; this.joy.y = 0;
    };
    window.addEventListener('blur', this._resetInput);
    document.addEventListener('visibilitychange', this._resetInput);

    this._onKeyDown = (e) => {
      if (ARENA_KEYS.has(e.key)) { this.keys.add(e.key); e.preventDefault(); }
      else if (e.code === 'Space' || e.key === ' ') { e.preventDefault(); this.core?.shockwave(); }
    };
    this._onKeyUp = (e) => { this.keys.delete(e.key); };
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    this._onResize = () => this._resize();
    window.addEventListener('resize', this._onResize);

    // 主动技能：端游空格（见 _onKeyDown）/ 手游技能按钮（摇杆旁圆形按钮，CD 时变灰）
    this.skillBtn.onclick = () => this.core?.shockwave();

    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this._loop(t));
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.stage.clientWidth || 360;
    const h = this.stage.clientHeight || 640;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.core) this.core.setBounds(w, h);
  }

  _keyVec() {
    let x = 0, y = 0;
    if (this.keys.has('ArrowLeft') || this.keys.has('a') || this.keys.has('A')) x -= 1;
    if (this.keys.has('ArrowRight') || this.keys.has('d') || this.keys.has('D')) x += 1;
    if (this.keys.has('ArrowUp') || this.keys.has('w') || this.keys.has('W')) y -= 1;
    if (this.keys.has('ArrowDown') || this.keys.has('s') || this.keys.has('S')) y += 1;
    return { x, y };
  }

  _loop(now) {
    if (this.ended) return;
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (dt > 0) this._fps = Math.round(1 / dt);

    // 合成输入：**键盘优先于摇杆，而不是两者相加**。
    // 相加时「摇杆残留 + 反向按键」会互相抵消成 0，屏幕表现就是「左右都推不动」，
    // 与「根本没收到按键」完全一样，极难排查。互斥后任何一路输入都不会被另一路吃掉。
    const k = this._keyVec();
    const usingKeys = k.x !== 0 || k.y !== 0;
    let ix = usingKeys ? k.x : this.joy.x;
    let iy = usingKeys ? k.y : this.joy.y;
    const m = Math.hypot(ix, iy);
    if (m > 1) { ix /= m; iy /= m; }
    this.input = { x: ix, y: iy };

    // 升级暂停时不步进（满足「升级界面暂停游戏」）
    const paused = !!this.core.pendingUpgrade;
    if (!this.core.done && !paused) {
      this.core.step(dt, this.input);
      this._needsPaint = true;
    }

    // 暂停时不再每帧重绘：弹窗是全屏半透明遮罩，底下重绘既看不见又白烧 CPU/GPU
    // （实测弹窗开启后掉到 49.9fps、最长单帧间隔 70ms）。只在置位时补一帧。
    if (this._needsPaint) {
      this._render();
      this._needsPaint = false;
    }

    if (paused && this.levelupEl.hidden) this._showUpgrade();
    if (this.core.done) { this._end(); return; }
    this.raf = requestAnimationFrame((t) => this._loop(t));
  }

  _showUpgrade() {
    this.levelupEl.hidden = false;
    this.choicesEl.innerHTML = '';
    for (const up of this.core.pendingUpgrade) {
      const btn = document.createElement('button');
      btn.className = 'alu-choice';
      btn.innerHTML = `<span class="alu-name">${up.label}</span><span class="alu-desc">${up.desc}</span>`;
      btn.onclick = () => {
        this.core.chooseUpgrade(this.core.pendingUpgrade.indexOf(up));
        this.levelupEl.hidden = true;
        this._needsPaint = true; // 恢复后补一帧，避免暂停期间跳过的重绘留下旧画面
      };
      this.choicesEl.appendChild(btn);
    }
  }

  _render() {
    const ctx = this.ctx;
    const c = this.core;
    const w = c.w, h = c.h;
    ctx.fillStyle = COLOR.field;
    ctx.fillRect(0, 0, w, h);

    // 暗场边框（9:16 竖向竞技场感）
    ctx.strokeStyle = 'rgba(232,227,218,0.08)';
    ctx.lineWidth = 2;
    ctx.strokeRect(6, 6, w - 12, h - 12);

    // 经验宝石（合批：一次 fill 画完所有宝石，而不是 N 次 beginPath+arc+fill。
    // 实测宝石是单项最贵的绘制（60 颗 0.597ms/帧），合批后 subpath 共用一次光栅化）
    if (c.gems.length) {
      ctx.fillStyle = COLOR.gem;
      ctx.beginPath();
      for (const g of c.gems) {
        ctx.moveTo(g.x + g.r, g.y); // 先移到弧起点，避免 subpath 之间被连一条直线
        ctx.arc(g.x, g.y, g.r, 0, Math.PI * 2);
      }
      ctx.fill();
    }

    // 敌人剪影（复用 glyph）
    const s = (ARENA.ENEMY_RADIUS * 2) / 100;
    for (const e of c.enemies) {
      ctx.save();
      ctx.translate(e.x - 50 * s, e.y - 46 * s);
      ctx.scale(s, s);
      ctx.fillStyle = COLOR.enemy;
      ctx.fill(this._enemyPath);
      ctx.restore();
    }

    // 敌人死亡动画（阶段 8-3：0.15s 爆裂缩小 + 闪白，不再瞬切）
    for (const d of c.deaths) {
      const p = clamp(d.t / d.life, 0, 1);
      // 两段式：0~30% 放大到 1+DEATH_POP（"炸开"），30%~100% 收到 0（"碎掉"）。
      // 单段纯缩小看起来像漏气，不像被打碎 —— 这就是 squash & stretch 在死亡上的用法。
      const k = p < 0.3
        ? lerp(1, 1 + ARENA.DEATH_POP, easeOut(p / 0.3))
        : lerp(1 + ARENA.DEATH_POP, 0, easeOut((p - 0.3) / 0.7));
      if (k < 0.02) continue; // 缩到看不见就别画了（scale≈0 的 path 只是白烧光栅化）
      const eo = easeOut(p);                       // 外飞位移同样走 ease-out：先窜出去再停住
      const x = d.x + d.dx * eo, y = d.y + d.dy * eo;
      const flash = p < 0.4 ? 1 : 1 - (p - 0.4) / 0.6; // 前 40% 保持全白，之后退回本色
      const sk = s * k;
      ctx.fillStyle = DEATH_COLORS[Math.round(clamp(flash, 0, 1) * (DEATH_COLORS.length - 1))];
      ctx.save();
      ctx.translate(x - 50 * sk, y - 46 * sk); // 与活体同一个锚点，缩放才不会"跳位"
      ctx.scale(sk, sk);
      ctx.fill(this._enemyPath);
      ctx.restore();
    }

    // 投射物（阶段 8-5：加一小段拖尾 —— 一个孤立的点在满屏敌人里几乎读不出弹道）
    if (c.projectiles.length) {
      // 投射物是直线飞行，所以"残影"就是它身后的一小段线段，**不需要历史位置缓冲**：
      // 既省掉每帧每弹的 push/shift，也没有额外分配。
      // 两层描边（宽而淡 + 细而亮）共用同一个 path，多 2 次 draw call 就做出了渐隐感。
      const back = ARENA.PROJECTILE_TRAIL / ARENA.PROJECTILE_SPEED;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (const p of c.projectiles) {
        ctx.moveTo(p.x - p.vx * back, p.y - p.vy * back);
        ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = 'rgba(232,227,218,0.16)';
      ctx.lineWidth = 5;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(232,227,218,0.42)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.lineCap = 'butt'; // 复位：后面还有开弧描边（冲击波环），圆头会多出一个小圆点

      // 头部（合批：一次 fill 画完所有弹头）
      ctx.fillStyle = COLOR.projectile;
      ctx.beginPath();
      for (const p of c.projectiles) {
        ctx.moveTo(p.x + p.r, p.y);
        ctx.arc(p.x, p.y, p.r, 0, TAU);
      }
      ctx.fill();
    }

    // 粒子
    for (const pa of c.particles) {
      ctx.globalAlpha = Math.max(0, pa.life * 2);
      ctx.fillStyle = pa.color;
      ctx.beginPath();
      ctx.arc(pa.x, pa.y, pa.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // 玩家剪影（程序生成单色小人）—— 阶段 8：不再是"一块平移的纸板"
    // ① 惯性：速度由 ArenaCore 插值（vx/vy），这里只读它换算表现量；
    // ② 侧倾：按横向速度倾斜，支点取**脚底** —— 绕脚转才像"人在动"，绕身体中心转像整张图在歪；
    // ③ squash & stretch：沿**运动方向**拉伸、垂直方向压扁。必须先转到运动坐标系再缩放：
    //    直接在屏幕轴上缩放的话，斜向移动会得到"沿屏幕轴拉长"，看起来像被压扁的球。
    // 幅度全部走 ARENA 常量（小、不夸张），位移/旋转都以 p 为唯一真源，不写回状态。
    const p = c.player, pr = p.r;
    const maxSpd = c.moveSpeed || ARENA.BASE_MOVE;
    const spdK = clamp(Math.sqrt(p.vx * p.vx + p.vy * p.vy) / maxSpd, 0, 1);
    ctx.save();
    ctx.translate(p.x, p.y + pr * 1.2); // 支点 = 脚底（原坐标里脚在 p.y + 1.2pr）
    ctx.rotate(clamp(p.vx / maxSpd, -1, 1) * ARENA.PLAYER_LEAN);
    if (spdK > 0.01) {
      const a = Math.atan2(p.vy, p.vx);
      ctx.rotate(a);
      ctx.scale(1 + ARENA.PLAYER_STRETCH * spdK, 1 - ARENA.PLAYER_SQUASH * spdK);
      ctx.rotate(-a);
    }
    ctx.fillStyle = COLOR.player;
    ctx.beginPath();
    ctx.moveTo(0, -pr * 2.35); // 头顶 = 脚底上方 2.35pr（等价于原来的 p.y − 1.15pr）
    ctx.lineTo(-pr * 0.72, 0);
    ctx.lineTo(pr * 0.72, 0);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, -pr * 2.35, pr * 0.55, 0, TAU);
    ctx.fill();
    ctx.restore();

    // 飘伤害数字（阶段 6.2-5）：小字、快出快隐、向上飘
    if (c.floaters.length) {
      if (this._f2 !== FONT_SMALL) { this._f2 = FONT_SMALL; ctx.font = FONT_SMALL; }
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const f of c.floaters) {
        // 阶段 8：用 t/max 算透明度（原来写死 `f.life / 0.45`，寿命一变就整体压暗一档）
        ctx.globalAlpha = clamp(1 - f.t / f.max, 0, 1);
        ctx.fillStyle = f.color;
        ctx.fillText(f.text, f.x, f.y);
      }
      ctx.globalAlpha = 1;
    }

    // 主动技能：环形冲击波视觉（阶段 6.2-3 多层波纹 + 阶段 8-4 蓄力→爆发两拍）
    const px = this.core.player.x, py = this.core.player.y;
    // ── 蓄力圈：由外向内收拢、逐渐变亮、线越来越粗 ──
    // 这一拍的意义不只是好看：0.15s 的蓄力如果画面没变化，玩家读到的只是"卡了一下"。
    // 收拢方向刻意与爆发环**相反**（内收 vs 外扩），一眼就能分清"准备"和"炸了"。
    if (this.core.shockChargeT >= 0) {
      const p = clamp(this.core.shockChargeT / ARENA.SHOCKWAVE_CHARGE, 0, 1);
      const eo = easeOut(p);
      const r = ARENA.SHOCKWAVE_RADIUS * (1 - 0.78 * eo);
      ctx.fillStyle = `rgba(168,154,230,${0.06 + 0.16 * eo})`;
      ctx.beginPath();
      ctx.arc(px, py, r * 0.5, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = `rgba(168,154,230,${0.35 + 0.55 * eo})`;
      ctx.lineWidth = 2 + 4 * eo;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, TAU);
      ctx.stroke();
    }
    // ── 爆发环：三层错相波纹向外扩散 ──
    if (this.core.shockwaveCastT >= 0) {
      const prog = clamp(this.core.shockwaveCastT / ARENA.SHOCKWAVE_FX, 0, 1);
      // 三层错相波纹：单环看起来只是"画了个圈"，多层才有"冲出去"的动感
      for (let i = 0; i < 3; i++) {
        const p = clamp(prog * 1.35 - i * 0.18, 0, 1);
        if (p <= 0) continue;
        ctx.strokeStyle = `rgba(168,154,230,${Math.max(0, (1 - p) * (i === 0 ? 0.95 : 0.45))})`;
        ctx.lineWidth = i === 0 ? 5 : 2.5;
        ctx.beginPath();
        // 半径走 ease-out（先窜出去、再减速）：线性扩张看起来像匀速推开的圈，不像"炸"。
        ctx.arc(px, py, easeOut(p) * ARENA.SHOCKWAVE_RADIUS, 0, TAU);
        ctx.stroke();
      }
    }

    // 白闪：一帧级的全屏提亮。用「时长」而不是真·一帧 —— 掉帧时真一帧会整帧看不见。
    // reducedMotion 下跳过（前庭敏感用户保护，与粒子同一条策略）。
    if (!this.reduced && this.core.flashT >= 0) {
      const k = clamp(this.core.flashT / ARENA.SHOCKWAVE_FLASH, 0, 1);
      ctx.fillStyle = `rgba(232,227,218,${0.38 * k})`;
      ctx.fillRect(0, 0, w, h);
    }

    // HUD：倒计时 + HP 条 + XP 条 + 等级
    const remain = Math.max(0, Math.ceil((c.durationMs - c.time) / 1000));
    ctx.fillStyle = COLOR.paper;
    if (this._f1 !== FONT_BIG) { this._f1 = FONT_BIG; ctx.font = FONT_BIG; }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(remain, w / 2, 14);

    const hpW = w - 48, hpX = 24, hpY = 50;
    ctx.fillStyle = 'rgba(232,227,218,0.15)';
    ctx.fillRect(hpX, hpY, hpW, 8);
    ctx.fillStyle = this.run.hp / this.run.maxHp < 0.3 ? COLOR.danger : COLOR.paper;
    ctx.fillRect(hpX, hpY, hpW * clamp(this.run.hp / this.run.maxHp, 0, 1), 8);

    const xpY = hpY + 16;
    ctx.fillStyle = 'rgba(168,154,230,0.18)';
    ctx.fillRect(hpX, xpY, hpW, 5);
    ctx.fillStyle = COLOR.gem;
    ctx.fillRect(hpX, xpY, hpW * clamp(c.xp / c.xpToLevel, 0, 1), 5);

    ctx.fillStyle = COLOR.ink;
    if (this._f2 !== FONT_SMALL) { this._f2 = FONT_SMALL; ctx.font = FONT_SMALL; }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`Lv.${c.level}  HP ${Math.ceil(this.run.hp)}/${this.run.maxHp}`, hpX, xpY + 10);

    // 角落击杀计数（阶段 6.2-5：数字往上跳本身就是爽点，不需要额外奖励挂钩）
    ctx.textAlign = 'right';
    ctx.fillStyle = COLOR.paper;
    ctx.fillText(`击杀 ${c.kills}`, w - 24, xpY + 10);
    ctx.textAlign = 'left';

    // 技能按钮冷却态（CD 时变灰并显示剩余秒数）
    // 只在显示文本真的变化时写 DOM：CD 数字一秒只变 10 次（0.1s 精度），每帧写 textContent
    // + classList 会持续触发样式重算，纯浪费。
    if (this.skillBtn) {
      const cd = this.core.shockwaveCd;
      const txt = cd > 0 ? cd.toFixed(1) : '波';
      if (txt !== this._skillTxt) {
        this._skillTxt = txt;
        this.skillBtn.textContent = txt;
        this.skillBtn.classList.toggle('cd', cd > 0);
      }
    }

    // 悬浮摇杆（拖动时绘制）
    if (this.joy.active) {
      ctx.strokeStyle = 'rgba(232,227,218,0.25)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(this.joy.ox, this.joy.oy, 48, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(232,227,218,0.5)';
      ctx.beginPath();
      ctx.arc(this.joy.ox + this.joy.x * 48, this.joy.oy + this.joy.y * 48, 20, 0, Math.PI * 2);
      ctx.fill();
    }

    if (DBG) this._renderDbg(ctx, w, h);
  }

  /** ?dbg=1：输入 / 帧率 / 实体数读数（左下角）。真机操控异常时，让用户直接读出数值反馈。 */
  _renderDbg(ctx, w, h) {
    const c = this.core;
    const lines = [
      `in  (${this.input.x.toFixed(2)}, ${this.input.y.toFixed(2)})`,
      `key [${[...this.keys].join(',')}]`,
      `joy (${this.joy.x.toFixed(2)}, ${this.joy.y.toFixed(2)}) ${this.joy.active ? 'ON' : '--'}`,
      `pos (${Math.round(c.player.x)}, ${Math.round(c.player.y)})  ${c.w}x${c.h}`,
      // 阶段 8：速度/死亡动画/蓄力态 —— "人物滑冰停不下来""怪死了不消失"这类观感问题
      // 全靠这三个读数区分"是动画没走完"还是"状态没被清掉"。
      `spd ${Math.round(Math.sqrt(c.player.vx ** 2 + c.player.vy ** 2))} dying ${c.deaths.length} chg ${c.shockChargeT >= 0 ? 'Y' : '-'}`,
      `en ${c.enemies.length} gem ${c.gems.length} lv ${c.level} fps ${this._fps}`,
    ];
    const lh = 13, pad = 6, bw = 186;
    const bh = lines.length * lh + pad * 2;
    const bx = 8, by = h - bh - 8;
    ctx.fillStyle = 'rgba(0,0,0,0.66)';
    ctx.fillRect(bx, by, bw, bh);
    if (this._f2 !== FONT_SMALL) { this._f2 = FONT_SMALL; ctx.font = FONT_SMALL; }
    ctx.fillStyle = '#a89ae6';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    lines.forEach((s, i) => ctx.fillText(s, bx + pad, by + pad + i * lh));
  }

  /** 探针用：立刻以「存活通关」结束（同步回调 onDone，无需等下一帧） */
  forceWin() {
    if (this.ended || !this.core) return;
    this.core.won = true;
    this.core.done = true;
    this._end();
  }

  /** 探针/外部用：释放环形冲击波（透传到 ArenaCore） */
  shock() {
    return this.core ? this.core.shockwave() : false;
  }

  _end() {
    if (this.ended) return;
    this.ended = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this._teardown();
    const won = this.core ? this.core.won : false;
    this.onDone?.(won, this.core);
  }

  _teardown() {
    this._resetInput(); // 退出时清干净输入态，避免残留到主游戏
    this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('pointercancel', this._onPointerUp);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('blur', this._resetInput);
    document.removeEventListener('visibilitychange', this._resetInput);
    this.root?.remove();
  }
}

const ARENA_KEYS = new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'w', 'a', 's', 'd', 'W', 'A', 'S', 'D',
]);
