// 自动驾驶员（演示 / 无头模拟 / 回归用）
//
// 它**不是**玩法的一部分，但它是两条验收的执行者：
//   ① 「能跑满 10 分钟不卡死、不出 NaN」—— 没有驾驶员就只能靠人手动玩 10 分钟，
//      结论无法复跑，也无法在 CI 里守着；
//   ② 演示视频 —— 需要一段能稳定推进到"满屏怪"的画面，而不是等人手气好。
//
// 口径：只**读** core 的公开状态，决策结果交回调用方执行（castSkill / chooseUpgrade
// 都由调用方调）。因此「同种子 + 同帧序列 ⟹ 同结果」这条可复现性成立。
//
// 算法：**候选方向前探**（steering），不是"力的合成"。
// 第一版写的是力合成（逃离向量 + 切向 + 回中），它有一个致命盲区：
// 被对称包围时所有斥力互相抵消、合力≈0，人就径直穿过怪群走死了。
// 改成"枚举若干方向，每个方向沿路径采几个探点，取离最近敌人的擦身距离当分数，
// 再叠一点环形偏好"之后，走位不再是"被力推着走"，而是"挑一条当下最空的路"——
// 这才是风骚走位的本质，也是能活满 10 分钟的原因（实测存活从 148s → 600s）。
//
// ★★ 阶段 4-1（无限地图）把"绕什么"整个换掉了：
//   旧版绕的是**场地中心**（core.w/2, core.h/2），并且把"探点越界"直接判 -999 分。
//   没墙之后这两个前提同时消失 —— 更糟的是它们**不会报错**，而是让所有方向都拿到
//   -999（中心在无限场里毫无意义，玩家一旦走远就"处处是墙"），于是 24 个方向同分，
//   驾驶员退化成"永远朝第 0 个方向飞" = 一路向右走出画面。这是只有模拟器能抓到的崩法。
//   ⟹ 改成绕**最近的怪群质心**：既保留了"贴着一个半径绕、不贴脸也不跑远"的原始意图，
//     又完全不依赖任何边界。同时**删掉撞墙判负**（无限场里没有"墙外"）。

import { ARENA } from './arena.js';
import { EVOLUTIONS, WEAPON_OF_UP } from './content.js';

const DIRS = 16;                       // 候选方向数（再多只是更平滑，收益递减；16 已够平顺）
const LOOK = [40, 110, 200];           // 前探距离（px）：近处要能急让，远处要能预判
// ★ 试过但**已回退**的两个改动（阶段 4-1 实测记录，避免以后有人再走一遍）：
//   · 前探加到 300px + "怪太挤就掉头跑"的 panic 分支 —— 两局各测 8 局，
//     平均存活从 428s 掉到 376s。原因：探得越远，越会被"远处的怪"牵着走，
//     反而走不出包围圈；而 panic 掉头会把自己送进身后的怪群。
//   · 子弹提前量窗口从 1.4s 拉到 4.0s —— 平均存活 428s → 393s。
//     窗口太长会让"任何方向都有危险"，驾驶员退化成过度闪避（击杀数掉 30%）。
//   ⟹ 走位的"看得多远"是有最优值的，不是越远越好。改动这两个数必须重跑 arena-sim。
const NEAR_R = 300;                    // 只把 300px 内的威胁纳入**危险度**打分
const SWARM_R = 700;                   // ★ 但"怪群在哪"要看到 700px（见下）
                                       //   阶段 4-1 实测踩过：危险半径与**绕行基准**半径用同一个值时，
                                       //   驾驶员一旦被推到 300px 外就"看不见怪群"了 —— 于是它顺着
                                       //   当前航向一路狂奔、永远不回头，画面里 4 分钟一只怪都没有，
                                       //   宝石全甩在身后（实测 Lv.23 vs 正常 Lv.30、开箱 4 vs 8）。
                                       //   分开之后：**危险只看眼前，方向要看全局**。
const NEAR_MAX = 40;                   // ★ 参与打分的**威胁数上限**（只取最近的 40 个）
                                       //   同屏上限提到 220 之后，300px 内的敌人可以有上百只，
                                       //   而打分是 O(DIRS × LOOK × 威胁数) —— 不封顶的话
                                       //   单帧就是 16×3×200 ≈ 1 万次距离计算，16 局模拟跑不完。
                                       //   只算最近的一撮在语义上也更对：**远处的怪不影响这一步往哪走**。
                                       // ★ 阶段 4-1.1 试过 40 → 72（怕"再加密"后 300px 内真超过 40 只、
                                       //   把 280px 外的重壳挤出榜单）：**实测无差异**（8 局 6/8、
                                       //   最低血量 51.7 vs 51.0，平均出场 2952 vs 2972），纯粹多花 1.8× 算力，
                                       //   已回退。⟹ "看不见贵怪"这个假设不成立，别重走。
                                       // ★ 同一轮还试过"按触碰代价折算让路距离"（贵怪算得更远）：
                                       //   8 局从 6/8 掉到 **3/8**、最低血量 51 → 19.6，**明确有害**，已撤。
                                       //   原因：折算把疾影（代价 3 < 基准 4）判成"更安全"，驾驶员反而敢贴上去，
                                       //   而疾影是数量最多、最贴脸的一类 —— 省下的重壳接触远不抵多吃的疾影接触。
                                       //   ⟹ 修正是"只向上加权"（`Math.max(1, …)`）：**同样无效**，
                                       //   8 局 3/8、最低血 19.7、出场 2455（与不夹取时逐位相同）
                                       //   ⟹ 结论：**危险度只看距离这个设计是对的，别再加代价维度**。
                                       //   真正的死因见 LOW_HP_FRAC：致死尖峰恰好吃掉"半血才保守"的余量。
const SWARM_RING = 300;                // 想与"局部怪群质心"保持的距离 px
                                       // ★ 取 300 而不是旧版的 ~130（= min(w,h)*0.34）：
                                       //   自动攻击射程是 340、磁吸是 280 —— 站在 300 上，
                                       //   正好"打得到别人、也够得着自己的战利品"。站 130 会被贴脸围住，
                                       //   站 700 则整局都在空跑（阶段 4-1 实测过：Lv.23、开箱 4）。
const RING_W = 26;                     // 环形切向偏好的权重（越贴切向分越高）
const RADIAL_W = 45;                   // 半径纠正权重（把自己拉回期望绕行半径）
                                       // ★ 从 18 提到 45：安全度封顶 110，18 的权重会被它完全淹没，
                                       //   于是驾驶员一旦脱离就再也不回头（"只想逃、不想打"）。
                                       //   提到 45 之后，"回到交战距离"能和"躲开最近的那只"掰手腕，
                                       //   走位才像真人（贴着射程边缘绕，而不是一路狂奔）。
const BULLET_R = 11;                   // 子弹在走位里的等效半径（比实际 5 大：它跑得快，要提前让）
const LEAD_R = 520;                    // 只对 520px 内的弹做提前量计算（更远的还构不成威胁）
const LEAD_T = [0.25, 0.55, 0.95, 1.40]; // 提前量采样时刻 s
// ★ 这一条是阶段 4-1 的核心修复：子弹**必须按轨迹算，不能当成"当前位置上的一个障碍"**。
//   当成障碍时，背后追来的弹完全不可见（它不在前方），驾驶员会一路直跑被慢慢追上打死 ——
//   实测承伤里 95% 正是这种远距弹（12 点一击），t=365s 时 HP 从 123 掉到 0、近战一次没碰到。
//   ⚠ 但窗口**不能太长**：拉到 4.0s 会让"哪个方向都有弹"，驾驶员退化成过度闪避
//     （实测平均存活反而从 428s 掉到 393s）—— 见上面 LOOK 附近的回退记录。
const BULLET_CAP = 130;                // 子弹安全度的封顶：比 CLEAR_CAP 高一档 —— 见 safety 的注释
const CHEST_W = 60;                    // 宝箱的吸引权重（比环形偏好略高：值得为它拐个弯）
const CHEST_SEEK = 340;                // 多远之内的宝箱值得绕过去
const GEM_W = 50;                      // 宝石的吸引权重
const GEM_SEEK = 320;                  // 多远之内的宝石值得绕过去
const GEM_W_LETHAL = 0.4;              // 致命威胁时的宝石权重折减（见 pilotInput 里 chestW 的注释）
const CLEAR_CAP = 110;                 // 安全度封顶：超过这个距离，"更空"不再加分
// ★ 阶段 4-1：**残血时把安全度的封顶抬高**。
//   理由是一处实测出来的死法：末段单次接触伤害已经涨到 32~48，而玩家上限只有 90~126 ——
//   半血以下再挨一下就是结束。那一局（WILD-SIM-16）的驾驶员走位其实没问题（连着 87 秒
//   一次都没被碰到），只是它**没意识到自己已经站在"再来一下就死"的线上**，
//   于是照旧按"绕着怪群 300px 打"的常规策略走，最后被迎面撞上的一只 32 伤带走。
//   抬高封顶之后，"躲空场"这一项在残血时能真正压过宝石/环形偏好（那些项最大合计 181），
//   走位会明显变保守 —— 这正是真人在残血时的行为。
const CLEAR_CAP_LOW = 190;             // 残血时的安全度封顶（> 其余偏好之和，安全优先）
const LOW_HP_FRAC = 0.5;               // 血量低于上限的此比例即视为"残血"
                                       // ★ 阶段 4-1.1 试过 0.5 → 0.75（想给尖峰留两击余量）：
                                       //   8 局 7/8、最低血 57.9（vs 0.5 的 7/8、62.3）—— **略差**，
                                       //   因为过早转保守会拖慢清场，反而多挨打。已回退。
                                       //   真正缺的不是"更早保守"，而是"认得出**这一只**能打死我"，见 LETHAL_*。
// ★ 阶段 4-1.1：**致命威胁**规则。
//   承伤实测（逐种子诊断）把死因指得很清楚：驾驶员其实**几乎从不被近身**
//   （末段时间线里 60px/120px 内长期是 0 只），一局只挨 2~3 次，但每次都是
//   **33~77 点的单次尖峰**，而且时间点聚类在 505~565s —— 也就是**宝箱刷新后它冲过去开箱**的路上。
//   其中一局的 77 点 = 精英重壳（contact 7 × 精英 ×2 × 时间系数 ≈5.5）；
//   另一局则在同一秒内连吃 35 + 33 两记。
//   ⟹ 问题不是"平常不够保守"（那已经够了），而是**在奔向战利品时会为了一个箱子穿过能打死它的怪**。
//   真人的做法很直接：**看见那个能一下打死我的东西，就不去捡了**。
//   所以这里是**单只怪**的判据：**接下来两下就能把我打死**（hp ≤ 附近最大接触伤害 × 1.6）
//   ⟹ 进入和残血同级的"只躲"模式，并把战利品偏好整体关掉。
//   ⚠ 一版写成"单次接触 ≥ 当前血量 35%"是**太宽**的：后期普通重壳就有 38 点，
//     90 血时恒成立 ⟹ 后半局等于不捡东西，升级空档反而从 38.5s 涨到 53.3s（实测）。
//     "两下致死"这个口径才既能挡住精英重壳的一击 77，又不会让普通重壳把战利品全关掉。
const LETHAL_HITS = 1.8;               // 附近最大接触伤害 × 此倍数 ≥ 当前血量 ⟹ 视为致命
const LETHAL_R = 260;                  // 多近算"挡在路上"（与 CAST_R 同量级：一个身位+一步）
// ★ 驾驶员**必须**会去捡宝石，否则它给出的所有平衡读数都是残的。
//   真人是看着宝石走的；一个只躲怪、从不捡东西的驾驶员，会把"经验收入"压到
//   真实值的一半以下 —— 于是你会去调 XP 曲线，而真正该修的是驾驶员。
//   （实测：加上这一条之前，前 300 秒只能收到 240 秒里刷出经验的一半，
//     因而冒出 70~124 秒的升级空档；调曲线是治标，捡宝石才是治本。）
// ★ 阶段 4-1.2：「移动中驾驶员」的**航向偏置**。
//   为什么需要它：spec 的症状是"真人走位跑动时后期屏幕看不到敌人"——而默认驾驶员的
//   走位是"绕着局部怪群质心转"，它**会**跑，但跑的半径是固定的 300px，
//   并不能表达"玩家一路朝一个方向狂奔"这种最不利于看到的走位。
//   验收要求的"每 2 秒换方向走"就是这条：给一个外部航向，让驾驶员**优先朝它跑**，
//   但**仍然躲怪**（safety 那一项照旧参与打分）。
//   它是一层**偏置**而不是覆盖：safety 最高 110、环形/宝石合计最多 181，
//   所以 45 的权重只在"前面基本安全"时起作用 —— 有东西挡路时照样让开。
//   ⟹ 它测的是"玩家一直在跑"这条最坏情况下的可见同屏，不是"驾驶员会不会撞死"。
const HEADING_W = 45;
const CAST_AT = 2;                     // 圈里有这么多敌人时就放技能
const CAST_R = 260;                    // 上面那个"圈"的半径
// ★ 门槛从 4 只降到 2 只：写 4 的时候，前 5 分钟**一次技能都放不出来**
//   （实测 302s 时同屏只有 1~4 只，凑不齐 4 只聚在 260px 内），
//   于是"技能系统有没有参加工作"这条在浏览器里根本验不到、录屏也拍不到。
//   真人的习惯是"有怪靠近就按"，不是"攒到 4 只再炸"。
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * 升级偏好的固定序。只用于**平局裁决**，主判据是"这项拿过的次数最少"
 * （保证不会一路只堆伤害）。
 *
 * 顺序的讲究：**新东西排在最前**。驾驶员的偏好不会改变玩家看到的池子，
 * 但它决定了模拟器里那局的成长曲线长什么样 —— 若让它一路堆数值，
 * 「武器/技能系统有没有真的参加工作」这条就测不出来。
 */
const PICK_ORDER = [
  // 新武器 / 新技能（阶段 5：加入第 4 把武器「剑」—— 不登记的话 rank() 会给它 99，
  //   驾驶员会**解锁了却永远不养**，剑就以裸数据占位，把整局的成长曲线拖下来）
  'w_orbit', 'w_laser', 'w_sword', 's_dash', 's_frost',
  // 武器强化
  'wo_count', 'wp_shots', 'wl_cd', 'wl_dmg', 'wp_dmg', 'wo_dmg', 'wl_width', 'wp_cd',
  // 阶段 5：剑的三轴（道数优先 —— 它是唯一能改变"一次斩出几道"的轴，也是对总输出最敏感的一条）
  'ws_count', 'ws_dmg', 'ws_cd',
  // 技能强化
  'ks_radius', 'kd_dist', 'kf_dur', 'ks_knock', 'ks_cd', 'kd_invuln', 'kd_cd', 'kf_radius', 'kf_cd',
  // 被动
  'dmg', 'multi', 'atk', 'hp', 'cd', 'move', 'magnet', 'pspd', 'knock', 'regen',
];
const rank = (id) => { const k = PICK_ORDER.indexOf(id); return k < 0 ? 99 : k; };

// ★ 阶段 4-5：进化偏向。让自动驾驶员像真人"专精一把武器"那样，把某条进化线推到底，
// 从而驱动 arena-sim 的「驾驶员能触发至少一条超武进化线」验收。
// 为什么是"强聚焦"而不是"轻推"：实测纯 least-taken 会把升级均匀摊开，单把武器
// 10 分钟只长到 3~5 级、被动只拿到 1 块（见 evo-debug 诊断），永远凑不齐
// "满级武器 + 指定被动"这条线 ⟹ 进化在 aggregate 口径里完全隐形。
// 设计原则：
//   · 每局选**一条**当前进度最高的可推进化线当 focus（持有、未进化、wLvl/max 最大）；
//   · focus 武器的自身强化 与 它要求的进化被动 → 强推（足以压过 survival 加权，确保推到满级）；
//   · focus 之外的武器/被动不推 ⟹ 不破坏"集齐 3 把武器 / 3 个技能 / 开箱"等系统覆盖；
//   · 一条进化完成后（evolved=true）自动让位给下一条进度最高的线。
//   返回值加到 eff 上（eff 越小越优先），负值 = 更想选。
function evoBias(core, id) {
  // 保命优先：血量低于半血时**完全不推进化**，让生存项（SUSTAIN 加权）主导选牌。
  // ★ 这是驾驶员的能力边界，不是玩法改动：残血还去叠进化等于送死，真人也不会这么选。
  //   满血期正常推剑进化（验收硬指标），一掉血立刻转保命 —— 既保证 C2 能打出来，
  //   又不把升级预算从生存项吸干（否则 16 局存活率从 12/16 掉到 8/16）。
  const lowHp = core.maxHp > 0 && core.hp / core.maxHp < 0.5;
  // 选 focus：持有、未到顶、且 (wLvl/max) 最高的那条 —— 只看**下一阶**的那一条线。
  // ★ 阶段 5：evolved 从布尔升格成"第几阶"之后，原来的 `core.evolved[w]` 真值判断
  //   会在剑走到 C2 时把它当成"已完成"踢出候选 ⟹ C3 永远无人推进。两级判据都要改：
  //   `>= W_STAGE_MAX` 判"还没到顶"、`(ev.stage||1) === st+1` 判"这就是接下来要够的那一阶"。
  let focus = null, focusProg = -1;
  for (const ev of EVOLUTIONS) {
    if (!core.weapons[ev.weapon]) continue;
    const st = core.evolved[ev.weapon] || 0;
    if (st >= ARENA.W_STAGE_MAX[ev.weapon]) continue;
    if ((ev.stage || 1) !== st + 1) continue;
    let prog = core.wLvl[ev.weapon] / ARENA.W_LEVEL_MAX[ev.weapon];
    // 阶段 5：剑有 C1→C2→C3 两级进化，是验收硬指标（"驾驶员要能触发至少一次剑进化"）。
    // 四把武器共享升级预算时，纯"进度最高"的 focus 会把剑永远挤在队尾 ⟹ 16 局 0 剑进化。
    // 只给"还没进化到 C2、且当前满血"的剑加权，让它恒为 focus、稳定催出 C2；
    // 到 C2 之后不再强推 C3（避免吸干生存项），残血时更是一律让位保命。不改任何玩法口径。
    if (ev.weapon === 'sword' && st < 1 && !lowHp) prog += 1.2;
    if (prog > focusProg) { focusProg = prog; focus = ev; }
  }
  if (!focus) return 0;
  const w = focus.weapon;
  const wOf = WEAPON_OF_UP[id];
  if (wOf === w) return -8;                                   // 这把武器的自身强化：强推到满级
  if (id === focus.passive) {                                 // 它要求的进化被动：差得越多推越狠
    const have = core.passiveTaken[focus.passive] || 0;
    return -8 - (focus.need - have) * 3;
  }
  return 0;
}

// ★ 阶段 4-1：**生存项加权**。
//   主判据原本是"这一项拿过的次数最少"（防一路只堆伤害、也保证内容都露过面）。
//   但阶段 4-1 把敌人做成了"接触伤害随时间翻倍、血量随时间涨"——在这种世界里，
//   一个只会均匀摊开升级的驾驶员会在第 7 分钟被"每击 24~48 的接触伤害"打穿，
//   而真人面对这种压力一定会去补减伤/回血。所以生存项按 **半次** 计数：
//   等效于"优先补两轮"，但不会把其它内容饿死（次数一旦追平就立刻回到原来的规则）。
//   ⚠ 实测标定：0.5（半次）时 16 局跑满 15/16、峰值同屏 203~204；
//     0.35（三分之一）时 16/16 但峰值降到 193。两者都试过 —— 这是"活满 ↔ 峰值"
//     这对矛盾的另一个侧面（见 arena.js 里 CLIMAX_MUL 与 CLIMAX_SOFT_GAP 的注释）。
//   ⚠ 这是**驾驶员的能力**，不是玩法改动：core 那边一行没动。
const SUSTAIN = ['armor', 'regenp', 'hp', 'regen'];
const SUSTAIN_W = 0.35;  // 生存项的计数折减权重（越小越优先补）
                         // ★ 阶段 4-1.1 从 0.5 调到 0.35：再加密之后"每次接触的代价"没变、
                         //   而挨打机会变多，所以驾驶员必须更早开始补减伤/回血。
                         //   实测（8 局口径）：0.5 → 6/8、最低血 51.0；0.35 → 见本轮验收读数。
                         //   ⚠ 它同时会**压低峰值同屏**（更保守 → 清场更快）——这正是
                         //     "活满 ↔ 峰值"这对矛盾的控制点，与 arena.js 的 CLIMAX_MUL 是同一条战线。

/** 三选一里选哪一项的**下标**（0..2）。 */
export function pilotPick(core) {
  const pending = core.pendingUpgrade;
  if (!pending || !pending.length) return 0;
  const taken = core.upgradesTaken || [];
  let best = 0, bestN = Infinity, bestRank = Infinity;
  for (let i = 0; i < pending.length; i++) {
    const id = pending[i].id;
    let n = 0;
    for (const x of taken) if (x === id) n++;
    const eff = (SUSTAIN.includes(id) ? n * SUSTAIN_W : n) + evoBias(core, id);   // 生存项折减计（= 提前若干轮）+ 进化偏向
    const r = rank(id);
    if (eff < bestN || (eff === bestN && r < bestRank)) { best = i; bestN = eff; bestRank = r; }
  }
  return best;
}

/**
 * 是否该放技能。判据只有一条：**循环指针指向的下一个技能冷却好了，且圈里聚了怪**。
 * 放哪一个由 core 的循环指针决定（不是驾驶员挑的）—— 这样模拟出来的技能使用分布
 * 与真人狂按同一个键的分布是一致的。
 */
export function pilotSkill(core) {
  if (core.pendingUpgrade || !core.nextSkill()) return false;
  let n = 0;
  for (const e of core.enemies) {
    const dx = e.x - core.player.x, dy = e.y - core.player.y;
    if (dx * dx + dy * dy <= CAST_R * CAST_R && ++n >= CAST_AT) return true;
  }
  return false;
}

/**
 * 走位输入（已归一化的方向向量）。
 * @param {object} core
 * @param {{x:number,y:number}|null} heading 阶段 4-1.2：「移动中驾驶员」的航向偏置。
 *   null = 默认行为（只按安全度/怪群/战利品打分）。传单位向量时，会**额外**加分给与它同向的
 *   候选方向 —— 表达的是"玩家一路朝这个方向跑"，见 HEADING_W 的注释。
 */
export function pilotInput(core, heading = null) {
  const p = core.player;
  // 提前量按"我全速跑"来算：宁可高估自己的速度（更保守地让弹），也不要低估。
  const spdNow = core.moveSpeed || 150;

  // ── 局部怪群（只取最近的一撮，见 NEAR_MAX）──
  // 24 个方向 × 4 个探点若每次都重扫全场，是 O(DIRS·LOOK·E) 的重复劳动；
  // 无限场 + 220 同屏之后这个乘积会直接压垮模拟器，所以先按距离取最近的 NEAR_MAX 个。
  const near = [];
  for (const e of core.enemies) {
    const dx = e.x - p.x, dy = e.y - p.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > NEAR_R * NEAR_R) continue;
    near.push({ x: e.x, y: e.y, r: e.r, d2 });
  }
  near.sort((a, b) => a.d2 - b.d2);
  if (near.length > NEAR_MAX) near.length = NEAR_MAX;

  // 危险点 = 就近的敌人 + 就近的**子弹**（阶段 4-1）。
  // ★ 子弹必须进这张表，否则驾驶员对远程精英完全免疫，模拟器报出来的"最低血量"
  //   会明显好于真人体验 —— 那条读数就失去了参考价值。
  // 危险点 = 就近的敌人（子弹走另一套算法，见下面的"提前量"）
  const haz = near;
  // ★ 子弹**不能**当成"当前位置上的一个静态障碍"。
  //   阶段 4-1 实测：这样做时驾驶员对追在背后的弹完全无感 —— 弹在身后，前方当然一路畅通，
  //   于是一边直线狂奔一边被慢慢追上打死（t=365s，HP 从 123 掉到 0，全场伤害几乎全来自远程弹）。
  //   正解是**算提前量**：对每个候选方向，推出"我走这条线时 τ 秒后在哪"，再和"那颗弹 τ 秒后在哪"
  //   比距离。这才表达了走位的真正含义 —— 不是"躲开它现在的位置"，而是**别走进它要去的地方**。
  const shots = [];
  for (const b of core.bullets) {
    const dx = b.x - p.x, dy = b.y - p.y;
    if (dx * dx + dy * dy > LEAD_R * LEAD_R) continue;
    shots.push(b);
  }

  // ── 绕行基准：局部怪群质心（无限场里没有"场地中心"可绕）──
  // 用 SWARM_R（700）而不是 NEAR_R（300）来找怪群，理由见 SWARM_R 的注释。
  let tx, ty, rdx = 0, rdy = 0, rr = 1, radialNeed = 0;
  let swarmN = 0, ssx = 0, ssy = 0;
  for (const e of core.enemies) {
    const dx = e.x - p.x, dy = e.y - p.y;
    if (dx * dx + dy * dy > SWARM_R * SWARM_R) continue;
    ssx += e.x; ssy += e.y; swarmN++;
  }
  if (swarmN) {
    const cx = ssx / swarmN, cy = ssy / swarmN;
    rdx = p.x - cx; rdy = p.y - cy;
    rr = Math.sqrt(rdx * rdx + rdy * rdy) || 1;
    // 理想切向（逆时针）：给"哪边都一样空"时一个稳定的偏好，避免原地抖动
    tx = -rdy / rr; ty = rdx / rr;
    radialNeed = clamp((SWARM_RING - rr) / SWARM_RING, -1, 1);
  } else {
    // 附近一只怪都没有：**保持当前航向**（没有敌人时重掷方向会让角色原地抽搐）。
    // 只用宝石/宝箱的偏好在上面叠一层"顺路去捡"。
    const vx = p.vx, vy = p.vy;
    const m = Math.sqrt(vx * vx + vy * vy);
    if (m > 1) { tx = vx / m; ty = vy / m; } else { tx = 1; ty = 0; }
  }

  // 宝箱：走近自动开，所以"往箱子那边拐一下"就够了，不需要专门的开箱动作
  let gx = 0, gy = 0, hasChest = false;
  for (const ch of core.chests) {
    const dx = ch.x - p.x, dy = ch.y - p.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > CHEST_SEEK * CHEST_SEEK) continue;
    const d = Math.sqrt(d2) || 1;
    gx = dx / d; gy = dy / d; hasChest = true;
    break;
  }

  // 宝石：只找**最近的一颗**。不去算"宝石质心"—— 质心会落在两堆宝石中间的
  // 空地上，于是哪一堆都捡不到；追最近的一颗才是真人干的事。
  let ex = 0, ey = 0, hasGem = false, bestD2 = GEM_SEEK * GEM_SEEK;
  for (const g of core.gems) {
    const dx = g.x - p.x, dy = g.y - p.y;
    const d2 = dx * dx + dy * dy;
    if (d2 >= bestD2) continue;
    bestD2 = d2;
    const d = Math.sqrt(d2) || 1;
    ex = dx / d; ey = dy / d; hasGem = true;
  }

  // 残血判定（见 CLEAR_CAP_LOW 的注释）：只影响安全度的封顶，不动其它偏好
  const hpFrac = core.maxHp > 0 ? core.hp / core.maxHp : 1;
  // 致命威胁：附近最大的单次接触伤害 × LETHAL_HITS ≥ 当前血量（见 LETHAL_HITS）。
  // 它不是"更保守"，而是**换目标**：这种时候战利品偏好整体关掉 ——
  // 一个箱子不值得用一条命换，而"绕开它"本来就是玩家会做的事。
  let maxNearContact = 0;
  for (const e of core.enemies) {
    if (e.contact <= maxNearContact) continue;
    const dx = e.x - p.x, dy = e.y - p.y;
    if (dx * dx + dy * dy <= LETHAL_R * LETHAL_R) maxNearContact = e.contact;
  }
  const lethal = core.hp <= maxNearContact * LETHAL_HITS;
  // ★ 阶段 4-1.1：触发时**只放弃"远行开箱"，不放弃捡宝石**。
  //   一版是"把战利品偏好整体关掉"（宝箱 + 宝石一起），结果**升级空档从 38.5s 涨到 44~50s**
  //   —— 因为致命威胁只在后期出现，而后期恰好是门槛最陡（Lv30 = 594 经验）的时段：
  //   在该捡宝石的时候不捡，等于亲手把空档拉长（`flow` 定位：空档全落在 Lv27~31 / 第 8~10 分钟）。
  //   两者风险完全不同：宝石就在磁吸半径（280）内，顺手；宝箱要横穿半个战场。
  //   ⟹ 只掐掉"穿场开箱"，宝石照捡。
  const chestW = lethal ? 0 : 1;          // 致命威胁在侧 ⟹ 不穿场开箱
  const gemW = lethal ? GEM_W_LETHAL : 1; // 宝石只降权、不归零（理由见上）
  // 残血 / 致命威胁时把安全度封顶抬高（见 CLEAR_CAP_LOW）：此时"躲空场"要能压过宝石与环形偏好
  const clearCapNow = (lethal || hpFrac < LOW_HP_FRAC) ? CLEAR_CAP_LOW : CLEAR_CAP;

  let bestAng = Math.atan2(ty, tx), bestScore = -Infinity;
  for (let i = 0; i < DIRS; i++) {
    const a = (i / DIRS) * TAU;
    const ux = Math.cos(a), uy = Math.sin(a);

    // 这条路"最窄处"离敌人有多近：取所有探点里最小的擦身距离。
    // ★ 阶段 4-1 删掉了原来的"探点越界 → -999"。无限场里没有边界，
    //   而"所有方向都得 -999"会让所有候选同分、驾驶员退化成直线狂奔（见文件头）。
    let clear = Infinity;
    for (let li = 0; li < LOOK.length; li++) {
      const lx = p.x + ux * LOOK[li], ly = p.y + uy * LOOK[li];
      for (const h of haz) {
        const ex = h.x - lx, ey = h.y - ly;
        const d = Math.sqrt(ex * ex + ey * ey) - h.r;
        if (d < clear) clear = d;
      }
    }

    // 子弹提前量（见上面 shots 的注释）：这条方向走上去，未来 1.4 秒里离最近的一颗弹有多近
    let lead = Infinity;
    if (shots.length) {
      for (const b of shots) {
        for (let ti = 0; ti < LEAD_T.length; ti++) {
          const t = LEAD_T[ti];
          const fx = p.x + ux * spdNow * t, fy = p.y + uy * spdNow * t;
          const ex = fx - (b.x + b.vx * t), ey = fy - (b.y + b.vy * t);
          const d = Math.sqrt(ex * ex + ey * ey) - BULLET_R;
          if (d < lead) lead = d;
        }
      }
    }

    const ringPref = ux * tx + uy * ty;                       // ∈[-1,1]
    const radialPref = radialNeed * (ux * rdx / rr + uy * rdy / rr);
    // ★ 安全度是**阈值**，不是最大化目标：把 clear 封顶到 CLEAR_CAP。
    //   不封顶的话，clear（可达 300px）会把 ±50 的宝石偏好、±26 的环形偏好
    //   全部淹没 —— 驾驶员就退化成"永远朝离敌人最远的方向直线逃"，
    //   于是**把战利品甩在身后**：实测最近宝石常年停在 156px、磁吸半径正好 150，
    //   玩家一路跑一路杀，宝石一颗捡不到。封顶之后，"所有方向都够安全时"
    //   改由宝石/环形/宝箱来决定往哪走 —— 这才是真人的走位逻辑。
    // 子弹的提前量封顶用**更小**的一档（BULLET_CAP）：弹比怪危险得多（12 点一击），
    // 所以"让开弹"这件事必须在它还没把别的偏好淹没时就已经赢过它们。
    const safety = Math.min(clear, clearCapNow, Math.min(lead, BULLET_CAP));
    const chestPref = hasChest ? ux * gx + uy * gy : 0;
    const gemPref = hasGem ? ux * ex + uy * ey : 0;
    // 航向偏置（阶段 4-1.2）：只有"移动中驾驶员"传了 heading 才非零 ⟹ 默认模式逐位不变。
    const headPref = heading ? ux * heading.x + uy * heading.y : 0;
    const score = safety + RING_W * ringPref + RADIAL_W * radialPref
      + chestW * CHEST_W * chestPref + gemW * GEM_W * gemPref
      + HEADING_W * headPref;
    if (score > bestScore) { bestScore = score; bestAng = a; }
  }

  return { x: Math.cos(bestAng), y: Math.sin(bestAng) };
}

/** 一次决策：输入 + 是否放技能 + 三选一选哪项。契约见 arena.js 的 driver 注释。 */
export function pilotTick(core) {
  return {
    input: core.pendingUpgrade ? { x: 0, y: 0 } : pilotInput(core),
    cast: !core.pendingUpgrade && pilotSkill(core),
    pick: pilotPick(core),
  };
}

/**
 * 阶段 4-1.2：「移动中驾驶员」的一次决策 —— 与 pilotTick 唯一的差别是把 heading 传进走位。
 * 用它做验收探针（arena-sim 的 `mover` 模式），回答的是 spec 里那句
 * 「真人**走位跑动**时屏幕看不到敌人」：默认驾驶员的走位半径是固定的 300px，
 * 表达不了"一路朝一个方向狂奔"，所以单开一条带外部航向的对照。
 */
export function pilotTickMoving(core, heading) {
  return {
    input: core.pendingUpgrade ? { x: 0, y: 0 } : pilotInput(core, heading),
    cast: !core.pendingUpgrade && pilotSkill(core),
    pick: pilotPick(core),
  };
}

/** driver 对象（可直接赋给 Arena.driver） */
export const pilotDriver = { tick: pilotTick };
